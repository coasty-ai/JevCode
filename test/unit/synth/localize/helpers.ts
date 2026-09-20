/** Offline helpers for the localizer tests: fixtures, SourceFile construction, a scripted JevAsk. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answer, Json, Question, StageName } from '../../../../src/core/types.js';
import { analyse } from '../../../../src/synth/py/index.js';
import type { FailureView, JevAsk, SourceFile } from '../../../../src/synth/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '../../../fixtures/synth/localize');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function sf(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

export function workspace(files: readonly SourceFile[]): ReadonlyMap<string, SourceFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** The two-file fixture: the bug is `dx * dx - dy * dy` in Point.distance (pkg/geometry.py line 17). */
export function twoFileWorkspace(): ReadonlyMap<string, SourceFile> {
  return workspace([sf('pkg/geometry.py', fixture('pkg/geometry.py')), sf('pkg/utils.py', fixture('pkg/utils.py'))]);
}

export const GEOMETRY_FAILURE: FailureView = {
  testId: 'tests/test_geometry.py::test_distance',
  call: 'Point(0, 0).distance(Point(3, 4))',
  expected: '5.0',
  actual: 'ValueError: math domain error',
};

export const GEOMETRY_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/work/tests/test_geometry.py", line 7, in test_distance',
  '    assert Point(0, 0).distance(Point(3, 4)) == 5.0',
  '  File "/work/pkg/geometry.py", line 17, in distance',
  '    return math.sqrt(dx * dx - dy * dy)',
  'ValueError: math domain error',
].join('\n');

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

/** Noul answer with probability p. */
export function noulAnswer(p: number): Answer {
  return { type: 'noul', noul: p };
}

/**
 * Choice answer over the question's option keys: `favoured` keys take the given mass, the
 * remainder is spread evenly over the other options, so probabilities sum to 1 and `choice`
 * is the argmax (the client would reject anything else).
 */
export function choiceAnswer(q: Question, favoured: Record<string, number>): Answer {
  if (q.type !== 'choice') throw new Error('not a choice');
  const keys = Object.keys(q.criteria);
  for (const k of Object.keys(favoured)) if (!keys.includes(k)) throw new Error(`favoured key ${k} is not an option`);
  const given = Object.values(favoured).reduce((s, v) => s + v, 0);
  if (given > 1 + 1e-9) throw new Error('favoured mass exceeds 1');
  const rest = keys.filter((k) => !(k in favoured));
  const each = rest.length > 0 ? (1 - given) / rest.length : 0;
  const probabilities: Record<string, number> = {};
  for (const k of keys) probabilities[k] = k in favoured ? favoured[k]! : each;
  let choice = keys[0]!;
  for (const k of keys) if (probabilities[k]! > probabilities[choice]!) choice = k;
  const n = keys.length;
  const pMax = probabilities[choice]!;
  return { type: 'choice', choice, probabilities, confidence: n <= 1 ? 1 : (pMax - 1 / n) / (1 - 1 / n) };
}

export type Script = (call: AskCall, index: number) => Record<string, Answer>;

/** A JevAsk whose answers come from `script`; every call is recorded on `calls`. */
export function scriptedAsk(script: Script): { ask: JevAsk; calls: AskCall[] } {
  const calls: AskCall[] = [];
  const ask: JevAsk = async (stage, state, questions) => {
    const call = { stage, state, questions };
    const answers = script(call, calls.length);
    calls.push(call);
    for (const id of Object.keys(questions)) if (!(id in answers)) throw new Error(`script left question ${id} unanswered`);
    return { answers, rows: [], latencyMs: 1 };
  };
  return { ask, calls };
}

/** Answer every Noul in a call from `p(id)` (default 0.05) and every Choice from `pick(id, q)`. */
export function answerAll(call: AskCall, p: (id: string) => number, pick: (id: string, q: Question) => Record<string, number>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(call.questions)) {
    if (q.type === 'noul') out[id] = noulAnswer(p(id));
    else if (q.type === 'choice') out[id] = choiceAnswer(q, pick(id, q));
    else throw new Error('the localizer never asks a Score');
  }
  return out;
}

/** State keys of a call as a plain object (the localizer always sends an object state). */
export function stateObject(call: AskCall): Record<string, Json> {
  if (typeof call.state !== 'object' || call.state === null || Array.isArray(call.state)) throw new Error('state is not an object');
  return call.state;
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}
