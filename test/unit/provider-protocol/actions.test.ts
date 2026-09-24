import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GenerateResult, ToolCall } from '../../../src/core/types.js';
import { GeneratorResponseError } from '../../../src/errors.js';
import { PROPOSE_ACTION_TOOL, extractLastFencedJson, parseProposal, patchTouchedPaths, summariseAction, validateAction } from '../../../src/provider/actions.js';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/loop/proposals.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 };

function result(partial: { text?: string; toolCalls?: ToolCall[] }): GenerateResult {
  return { text: partial.text ?? '', toolCalls: partial.toolCalls ?? [], usage, model: 'm', stopReason: 'end_turn', latencyMs: 0 };
}
function fromInput(input: unknown): GenerateResult {
  return result({ toolCalls: [{ name: 'propose_action', input: input as never, rawJson: JSON.stringify(input) }] });
}
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GeneratorResponseError);
    return (e as GeneratorResponseError).reason;
  }
  throw new Error('expected a GeneratorResponseError');
}

describe('parseProposal', () => {
  it('takes toolCalls[0].input first and keeps text + raw json as rawText', () => {
    const p = parseProposal(result(fixtures['toolCall'] as { text: string; toolCalls: ToolCall[] }));
    expect(p.goal).toBe('fix f');
    expect(p.action).toEqual({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' });
    expect(p.plan.remaining).toEqual(['run tests']);
    expect(p.rawText.startsWith('I will fix the function.\n{"goal"')).toBe(true);
  });
  it('falls back to the LAST fenced json block, with or without a language tag', () => {
    const p = parseProposal(result(fixtures['fencedJson'] as { text: string }));
    expect(p.action).toEqual({ kind: 'run', command: 'pytest -q' });
    expect(p.plan.done).toEqual(['fix f']);
    const q = parseProposal(result(fixtures['fencedNoLanguage'] as { text: string }));
    expect(q.action.kind).toBe('read');
  });
  it('rejects a bad kind with a precise reason and the raw text', () => {
    let err: GeneratorResponseError | null = null;
    try {
      parseProposal(fromInput(fixtures['badKind']));
    } catch (e) {
      err = e as GeneratorResponseError;
    }
    expect(err?.reason).toMatch(/action\.kind: expected one of read, edit, write, patch, run, done, got "delete"/);
    expect(err?.rawText).toContain('"delete"');
    expect(err?.code).toBe('generator_response');
  });
  it('rejects missing keys, extra keys, non-string old/new, missing plan, extra top-level keys', () => {
    expect(reasonOf(() => parseProposal(fromInput(fixtures['missingKeys'])))).toMatch(/action: missing key "new"/);
    expect(reasonOf(() => parseProposal(fromInput(fixtures['extraKeys'])))).toMatch(/action: unexpected key "cwd"/);
    expect(reasonOf(() => parseProposal(fromInput(fixtures['nonStringOldNew'])))).toMatch(/action\.old: expected a string, got number/);
    expect(reasonOf(() => parseProposal(fromInput(fixtures['missingPlan'])))).toMatch(/proposal: missing key "plan"/);
    expect(reasonOf(() => parseProposal(fromInput(fixtures['extraTopKey'])))).toMatch(/proposal: unexpected key "confidence"/);
    expect(reasonOf(() => parseProposal(fromInput(fixtures['planNotStrings'])))).toMatch(/plan\.done: expected an array of strings/);
  });
  it('rejects no block, unparsable json and a foreign tool name', () => {
    expect(reasonOf(() => parseProposal(result({ text: 'just prose' })))).toMatch(/no tool call and no fenced json block/);
    expect(reasonOf(() => parseProposal(result({ text: '```json\n{ nope\n```' })))).toMatch(/does not parse/);
    expect(reasonOf(() => parseProposal(result({ toolCalls: [{ name: 'other', input: {}, rawJson: '{}' }] })))).toMatch(/tool call "other"/);
  });
  it('validates run.timeoutMs and empty fields', () => {
    expect(validateAction({ kind: 'run', command: 'ls', timeoutMs: 2500.4 })).toEqual({ kind: 'run', command: 'ls', timeoutMs: 2500 });
    expect(reasonOf(() => validateAction({ kind: 'run', command: 'ls', timeoutMs: -1 }))).toMatch(/timeoutMs/);
    expect(reasonOf(() => validateAction({ kind: 'run', command: '   ' }))).toMatch(/must not be empty/);
    expect(reasonOf(() => validateAction({ kind: 'read', paths: [] }))).toMatch(/non-empty array/);
    expect(reasonOf(() => validateAction({ kind: 'edit', path: 'a', old: 'same', new: 'same' }))).toMatch(/identical/);
    expect(validateAction({ kind: 'write', path: 'a', content: '' })).toEqual({ kind: 'write', path: 'a', content: '' });
  });
});

describe('tool schema and helpers', () => {
  it('PROPOSE_ACTION_TOOL is strict: oneOf per kind, additionalProperties false, required listed', () => {
    const schema = PROPOSE_ACTION_TOOL.inputSchema as { required: string[]; additionalProperties: boolean; properties: { action: { oneOf: { properties: { kind: { const: string } }; additionalProperties: boolean; required: string[] }[] } } };
    expect(PROPOSE_ACTION_TOOL.name).toBe('propose_action');
    expect(schema.required).toEqual(['goal', 'action', 'plan']);
    expect(schema.additionalProperties).toBe(false);
    const kinds = schema.properties.action.oneOf.map((v) => v.properties.kind.const);
    expect(kinds).toEqual(['read', 'edit', 'write', 'patch', 'run', 'done']);
    for (const v of schema.properties.action.oneOf) {
      expect(v.additionalProperties).toBe(false);
      expect(v.required[0]).toBe('kind');
    }
  });
  it('summariseAction and patchTouchedPaths', () => {
    expect(summariseAction({ kind: 'edit', path: 'src/a.py', old: 'a', new: 'b' })).toBe('edit src/a.py');
    expect(summariseAction({ kind: 'run', command: 'pytest   -q\n' })).toBe('run pytest -q');
    expect(summariseAction({ kind: 'done', summary: 'x' })).toBe('done');
    expect(summariseAction({ kind: 'read', paths: ['a', 'b'] })).toBe('read a b');
    const diff = '--- a/src/x.py\n+++ b/src/x.py\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x\n';
    expect(patchTouchedPaths(diff)).toEqual(['src/x.py', 'new.py']);
    expect(summariseAction({ kind: 'patch', diff })).toBe('patch src/x.py new.py');
    expect(extractLastFencedJson('none')).toBeNull();
  });
});
