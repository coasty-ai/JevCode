/** Shared fixtures of the LLM source tests: a small module with duplicate lines and a dedenting block, and a GenerateFn over the scripted MockProvider keyed by sample. */
import type { GenerateRequest, GenerateResult, MockTurn, ToolCall } from '../../../../src/core/types.js';
import { createMockProvider } from '../../../../src/provider/mock.js';
import { PROPOSE_FIX_TOOL_NAME } from '../../../../src/synth/llm/schema.js';
import type { GenerateFn } from '../../../../src/synth/llm/types.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { sourceFile } from '../search/helpers.js';

export const CALC_SRC = [
  'def add(a, b):',
  '    if a is None:',
  '        return b',
  '    return a + b',
  '',
  '',
  'def sub(a, b):',
  '    if a is None:',
  '        return b',
  '    return a - b',
  '',
  '',
  'def scale(xs, k):',
  '    out = []',
  '    for x in xs:',
  '        if x is None:',
  '            continue',
  '        out.append(x * k)',
  '    return out',
  '',
].join('\n');

export const UTIL_SRC = ['def clamp(x, lo, hi):', '    return max(lo, min(x, hi))', ''].join('\n');

export function calcFiles(): Map<string, SourceFile> {
  return new Map([
    ['src/calc.py', sourceFile('src/calc.py', CALC_SRC)],
    ['src/util.py', sourceFile('src/util.py', UTIL_SRC)],
  ]);
}

export interface HunkIn {
  path?: string;
  old: string;
  new: string;
  near_line?: number;
}

/** A `propose_fix` tool call with the given patches (each a list of hunks). */
export function proposeFixCall(patches: readonly (readonly HunkIn[])[], extra: { analysis?: string; need?: { paths: string[]; symbols: string[] } } = {}): ToolCall {
  const input = {
    analysis: extra.analysis ?? 'the guard is wrong',
    patches: patches.map((edits, i) => ({ rationale: `patch ${i}`, edits: edits.map((h) => ({ path: h.path ?? 'src/calc.py', old: h.old, new: h.new, near_line: h.near_line ?? 0 })) })),
    need: extra.need ?? { paths: [], symbols: [] },
  };
  return { name: PROPOSE_FIX_TOOL_NAME, input, rawJson: JSON.stringify(input) };
}

/** Sample index of a request as source.ts builds it: sample 0 has no seed, sample k has `seed = step × 100 + k`. */
export function sampleOf(req: GenerateRequest): number {
  return req.seed === undefined ? 0 : req.seed % 100;
}

export interface ScriptedGenerate {
  generate: GenerateFn;
  calls: () => number;
  requests: () => GenerateRequest[];
}

/**
 * A GenerateFn over the MockProvider's function-form turns: `turnFor(sample)` scripts each sample;
 * `stopReasonFor(sample)` overrides the mock's stop reason (the mock only knows tool_use / end_turn).
 */
export function scriptedGenerate(turnFor: (sample: number, req: GenerateRequest) => MockTurn, stopReasonFor: (sample: number) => string | null = () => null): ScriptedGenerate {
  const requests: GenerateRequest[] = [];
  const provider = createMockProvider({ turns: (req) => turnFor(sampleOf(req), req) });
  const generate: GenerateFn = async (req, o) => {
    requests.push(req);
    const result = await provider.generate(req, { signal: o.signal });
    const stop = stopReasonFor(o.sample);
    const out: GenerateResult = stop === null ? result : { ...result, stopReason: stop };
    return out;
  };
  return { generate, calls: () => requests.length, requests: () => requests };
}
