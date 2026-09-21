import { describe, expect, it } from 'vitest';

import type { Answer, ToolCall } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { Q18, isLlmOracle, issueQuoteAnchored, scriptProblems, writeReproduction, type ReproWriterInput } from '../../../../src/synth/llm/repro.js';
import { WRITE_REPRODUCTION_TOOL_NAME } from '../../../../src/synth/llm/schema.js';
import { extractBlocks } from '../../../../src/synth/oracle/extract.js';
import { REPRO_SENTINEL } from '../../../../src/synth/oracle/runner.js';
import type { VerifyRunFn } from '../../../../src/synth/verify/types.js';
import { choiceAnswer, noulAnswer } from '../search/helpers.js';
import { scriptedGenerate } from './fixtures.js';

const ISSUE = ['`simplify(cos(x)**I)` raises TypeError: Invalid comparison of complex I.', '', 'It should simplify without raising an error for complex exponents.', '', '```python', 'from sympy import *', 'x = Symbol("x")', 'print(simplify(cos(x)**I))', '```'].join('\n');

const SCRIPTS = [
  'from sympy import Symbol, cos, I, simplify\nx = Symbol("x")\nsimplify(cos(x)**I)  # marker-a',
  'from sympy import Symbol\nassert Symbol("x") == 1  # marker-b',
  'from sympy import Symbol\nx = Symbol("x")\nassert x == x  # marker-c',
];

function call(script: string, quote: string): ToolCall {
  const input = { script, expected_behaviour: 'simplify completes for a complex exponent', issue_quote: quote, failure_kind: 'exception_raised' };
  return { name: WRITE_REPRODUCTION_TOOL_NAME, input, rawJson: JSON.stringify(input) };
}

interface RunSpec {
  raise?: string;
  pass?: boolean;
}

/** A sentinel-harness stdout: one statement that raised `raise`, or completed. */
function output(spec: RunSpec): string {
  const results = [{ chunk: 0, stmt: 2, source: 'simplify(cos(x)**I)', kind: 'expr', value: spec.pass ? "'cos(x)**I'" : null, type_name: spec.pass ? 'str' : null, stdout: '', exception: spec.raise ? { type: spec.raise, message: 'Invalid comparison of complex I', frames: [] } : null, fixup: null, environment: false, ms: 3 }];
  return `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.12.0', results })}\n`;
}

/** A VerifyRunFn that recognises each script by its marker and answers per run index. */
function fakeRun(plan: Record<string, RunSpec[]>): { run: VerifyRunFn; calls: () => number } {
  const seen: Record<string, number> = {};
  let calls = 0;
  const run: VerifyRunFn = async (command) => {
    calls += 1;
    const b64 = /b64decode\(\W*([A-Za-z0-9+/=]{20,})/.exec(command)?.[1] ?? '';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const marker = /marker-([a-z])/.exec(decoded)?.[1] ?? '?';
    const k = seen[marker] ?? 0;
    seen[marker] = k + 1;
    const spec = plan[marker]?.[k] ?? plan[marker]?.at(-1) ?? { pass: true };
    return { stdout: output(spec), stderr: '', exitCode: spec.raise ? 1 : 0 };
  };
  return { run, calls: () => calls };
}

function writerInput(over: Partial<ReproWriterInput>): ReproWriterInput {
  return {
    task: ISSUE,
    repository: 'sympy',
    packageName: 'sympy',
    framework: null,
    extraction: extractBlocks(ISSUE),
    workspace: '/work',
    run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    generate: scriptedGenerate(() => ({ text: 'x' })).generate,
    ask: async () => ({ answers: {} }),
    signal: new AbortController().signal,
    deadlineMs: 2000,
    ...over,
  };
}

describe('L2 reproduction writer', () => {
  it('anchors issue quotes in the issue text and refuses scripts the harness cannot judge', () => {
    expect(issueQuoteAnchored(ISSUE, 'raises TypeError: Invalid comparison of complex I')).toBe(true);
    expect(issueQuoteAnchored(ISSUE, 'It should simplify   without raising an error')).toBe(true);
    expect(issueQuoteAnchored(ISSUE, 'the function should return a simplified expression')).toBe(false);
    expect(issueQuoteAnchored(ISSUE, 'complex I')).toBe(false);
    expect(scriptProblems('import sys\nsys.exit(1)')).toMatch(/sys\.exit/);
    expect(scriptProblems(Array.from({ length: 61 }, () => 'x = 1').join('\n'))).toMatch(/61 lines/);
    expect(scriptProblems('assert 1 == 1')).toBeNull();
  });

  it('rejects an unanchored quote and a script that passes at base, runs the survivor twice, and lets Q18 grade the pick', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[k]!, k === 1 ? 'a sentence the reporter never wrote at all' : 'raises TypeError: Invalid comparison of complex I') }));
    const runner = fakeRun({ a: [{ raise: 'TypeError' }, { raise: 'TypeError' }], c: [{ pass: true }] });
    const asks: Record<string, unknown>[] = [];
    const res = await writeReproduction(
      writerInput({
        generate: gen.generate,
        run: runner.run,
        ask: async (_stage, state, questions) => {
          asks.push(state as Record<string, unknown>);
          const out: Record<string, Answer> = {};
          for (const [id, q] of Object.entries(questions)) {
            if (id === Q18.choiceId) out[id] = choiceAnswer(q, { script_0: 0.8, [ESCAPE_KEY]: 0.2 });
            else if (id === Q18.failureKindId) out[id] = choiceAnswer(q, { exception_raised: 0.9 });
            else out[id] = noulAnswer(0.85);
          }
          return { answers: out };
        },
      }),
    );
    expect(gen.calls()).toBe(3);
    expect(gen.requests().map((r) => r.temperature)).toEqual([0, 0.7, 0.7]);
    expect(res.trials.map((t) => [t.sample, t.status])).toEqual([
      [0, 'accepted'],
      [1, 'rejected'],
      [2, 'rejected'],
    ]);
    expect(res.trials[1]!.reason).toMatch(/issue_quote is not a verbatim/);
    expect(res.trials[2]!.reason).toMatch(/completes at the base commit/);
    // script a ran twice (unstable rule), script c once (it passed), script b never
    expect(runner.calls()).toBe(3);
    expect(asks).toHaveLength(1);
    const scripts = asks[0]!['scripts'] as Record<string, { base_run: { exception_type: string } }>;
    expect(Object.keys(scripts)).toEqual(['script_0']);
    expect(scripts['script_0']!.base_run.exception_type).toBe('TypeError');
    expect(res.outcome).toBe('llm_valid');
    expect(isLlmOracle(res.outcome)).toBe(true);
    expect(res.pick).toMatchObject({ key: 'script_0', failureKind: 'exception_raised' });
    expect(res.goal?.summary).toMatchObject({ failed: 1, passed: 0, total: 1 });
    expect(res.goal?.spec.criterion).toEqual({ form: 'no_exception' });
    expect(res.goal?.failure.expected).toBe('simplify completes for a complex exponent');
    expect(res.note).toMatch(/never completes a run/);
  });

  it('refuses an unstable script (fails then passes at base) and a low Noul without asking twice', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[0]!.replace('marker-a', k === 0 ? 'marker-a' : 'marker-d'), 'raises TypeError: Invalid comparison of complex I') }));
    const unstable = fakeRun({ a: [{ raise: 'TypeError' }, { pass: true }], d: [{ raise: 'TypeError' }, { raise: 'TypeError' }] });
    let askCalls = 0;
    const res = await writeReproduction(
      writerInput({
        generate: gen.generate,
        run: unstable.run,
        n: 2,
        ask: async (_stage, _state, questions) => {
          askCalls += 1;
          const out: Record<string, Answer> = {};
          for (const [id, q] of Object.entries(questions)) out[id] = q.type === 'choice' ? choiceAnswer(q, id === Q18.choiceId ? { script_1: 0.9 } : { exception_raised: 1 }) : noulAnswer(0.2);
          return { answers: out };
        },
      }),
    );
    expect(res.trials[0]).toMatchObject({ status: 'rejected' });
    expect(res.trials[0]!.reason).toMatch(/unstable/);
    expect(res.trials[1]!.status).toBe('accepted');
    expect(askCalls).toBe(1);
    expect(res.outcome).toBe('llm_none');
    expect(res.goal).toBeNull();
    expect(res.pick?.reason).toMatch(/reproduces_issue 0\.20 < 0\.3/);
  });
});
