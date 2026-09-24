/**
 * Offline doubles for the sites / composite tests: the two-function fixture, ladder task
 * loading, Site construction through the shared analyser, a scripted JevAsk that answers
 * every question with a valid Answer (Choice probabilities sum to 1, argmax choice), and a
 * Goal factory for the frozen search types.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answer, Json, Question, StageName } from '../../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { analyse, blockAt, scopeAt } from '../../../../../src/jev-modes/synth/py/structure.js';
import type { Goal } from '../../../../../src/jev-modes/synth/search/types.js';
import type { EnumerateOptions, FailureView, JevAsk, Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../../../..');
export const FIXTURES = join(REPO_ROOT, 'test/fixtures/synth/search');
export const LADDER = join(REPO_ROOT, 'bench/data/ladder/tasks');

export function sf(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

export function fixtureFile(name: string, path = name): SourceFile {
  return sf(path, readFileSync(join(FIXTURES, name), 'utf8'));
}

/** Buggy sources (`src/<mod>.py`) and gold texts of one ladder task. */
export function ladderTask(name: string, files: readonly string[]): { files: Map<string, SourceFile>; gold: Map<string, string> } {
  const out = new Map<string, SourceFile>();
  const gold = new Map<string, string>();
  for (const rel of files) {
    out.set(rel, sf(rel, readFileSync(join(LADDER, name, rel), 'utf8')));
    gold.set(rel, readFileSync(join(LADDER, name, 'gold', rel.replace(/^src\//, '')), 'utf8'));
  }
  return { files: out, gold };
}

/** A replace or insert site at `line` from the analyser (block and scope as the localizer builds them). */
export function siteAt(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const b = blockAt(file.mod, kind === 'insert' ? Math.max(1, line - 1) : line);
  const current = kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '';
  return {
    file,
    line,
    kind,
    currentLine: current,
    indent: /^[ \t]*/.exec(current)?.[0] ?? '',
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['test fixture'] },
  };
}

export function enumerateOptions(corpus: ReadonlyMap<string, SourceFile>, over: Partial<EnumerateOptions> = {}): EnumerateOptions {
  return { cap: over.cap ?? 200, testLiterals: over.testLiterals ?? [], taskIdentifiers: over.taskIdentifiers ?? [], corpus };
}

export function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: over.id ?? 'g1',
    tests: over.tests ?? ['wrap[1]'],
    failures: over.failures ?? [WRAP_FAILURE],
    suspectedFiles: over.suspectedFiles ?? ['twofn.py'],
    status: 'open',
    attempts: 0,
    budgetHits: 0,
    exhausted: new Map(),
    phase: 'SEEDS',
    planItem: 'fix wrap[1] in twofn.py',
    ...over,
  };
}

export const WRAP_FAILURE: FailureView = { testId: 'wrap[1]', call: 'wrap("The leaves did not stir", 10)', expected: '["The leaves", " did not", " stir"]', actual: '["The leaves", " did not"]' };

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

export function noulAnswer(p: number): Answer {
  return { type: 'noul', noul: p };
}

/** A Choice answer over the question's option keys: `favoured` keys take their mass, the rest share the remainder evenly. */
export function choiceAnswer(q: Question, favoured: Record<string, number>): Answer {
  if (q.type !== 'choice') throw new Error('not a choice');
  const keys = Object.keys(q.criteria);
  for (const k of Object.keys(favoured)) if (!keys.includes(k)) throw new Error(`favoured key ${k} is not an option (${keys.join(', ')})`);
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

/** A JevAsk answering from `script`; every call is recorded; unanswered questions fail the test. */
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

/** Answer every Noul from `p(id)` and every Choice from `pick(id, q)` (favoured masses). */
export function answerAll(call: AskCall, p: (id: string) => number, pick: (id: string, q: Question) => Record<string, number>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(call.questions)) {
    if (q.type === 'noul') out[id] = noulAnswer(p(id));
    else if (q.type === 'choice') out[id] = choiceAnswer(q, pick(id, q));
    else throw new Error('no Score is asked here');
  }
  return out;
}

export function stateObject(call: AskCall): Record<string, Json> {
  if (typeof call.state !== 'object' || call.state === null || Array.isArray(call.state)) throw new Error('state is not an object');
  return call.state;
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export { ESCAPE_KEY };
