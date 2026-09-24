/**
 * Offline helpers for the sketch and fill tests: sites built from fixtures with the real Python
 * analysis, the QuixBugs probe corpus (40 buggy/fix pairs, skipped when not checked out) and a
 * scripted JevAsk that returns wire-valid answers without touching the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answer, Json, Question, StageName } from '../../../../../src/core/types.js';
import { isJsonObject } from '../../../../../src/core/json.js';
import { choiceAnswer, noulAnswer } from '../../../../../src/jev/mock.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { MARK } from '../../../../../src/jev-modes/synth/beam/state.js';
import { analyse, blockAt, scopeAt } from '../../../../../src/jev-modes/synth/py/index.js';
import type { EnumerateOptions, FailureView, JevAsk, Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '../../../../fixtures/synth/sketch');
export const CORPUS_PATH = join(HERE, '../../../../fixtures/synth/corpus.json');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A site at `line` of a source file (replace by default; insert sites have no current line). */
export function siteAt(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const text = kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '';
  const indent = /^[ \t]*/.exec(file.mod.lines[line - 1] ?? '')?.[0] ?? '';
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind,
    currentLine: text,
    indent,
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['fixture site'] },
  };
}

export function enumerateOptions(over: Partial<EnumerateOptions> = {}): EnumerateOptions {
  return { cap: 200, testLiterals: [], taskIdentifiers: [], corpus: new Map(), ...over };
}

/** gcd fixture: buggy `return gcd(a % b, b)` on line 5. */
export function gcdSite(): { file: SourceFile; site: Site } {
  const file = sourceFile('gcd.py', fixture('gcd.py'));
  return { file, site: siteAt(file, 5) };
}

export const GCD_FAILURES: FailureView[] = [
  { testId: 'gcd[13,13]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[37,600]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
];

// ---------------------------------------------------------------------------------------
// The measured corpus (test/fixtures/synth/corpus.json)
// ---------------------------------------------------------------------------------------

export interface CorpusItem {
  name: string;
  kind: 'replace' | 'insert';
  indent: string;
  buggy_line: string | null;
  fix_line: string;
  marked_program: string;
  buggy_program: string;
  tests: Json[];
  tests_kind: 'json' | 'pytest_source';
}

export const HAS_CORPUS = existsSync(CORPUS_PATH);

export function loadCorpus(): CorpusItem[] {
  return HAS_CORPUS ? (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusItem[]) : [];
}

/** The measured site of a corpus item (the marker line of `marked_program`) and its enumerate options. */
export function corpusSite(item: CorpusItem): { site: Site; opts: EnumerateOptions } {
  const src = item.buggy_program.endsWith('\n') ? item.buggy_program : `${item.buggy_program}\n`;
  const file = sourceFile(`${item.name}.py`, src);
  const line = item.marked_program.split('\n').findIndex((l) => l.includes(MARK)) + 1;
  const b = blockAt(file.mod, line);
  const site: Site = {
    file,
    line,
    kind: item.kind,
    currentLine: item.kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '',
    indent: item.indent,
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: [] },
  };
  const testLiterals = item.tests_kind === 'json' ? item.tests.map((t) => JSON.stringify(t)) : item.tests.map((t) => String(t));
  return { site, opts: enumerateOptions({ testLiterals }) };
}

// ---------------------------------------------------------------------------------------
// Scripted Jev
// ---------------------------------------------------------------------------------------

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}
export type ChoiceQuestion = Extract<Question, { type: 'choice' }>;

export function asChoice(q: Question | undefined): ChoiceQuestion {
  if (q === undefined || q.type !== 'choice') throw new Error('expected a choice question');
  return q;
}

/** Read a string at a dotted path of the state (`hypotheses.first`). */
export function stateString(state: Json, path: string): string | undefined {
  let cur: Json | undefined = state;
  for (const p of path.split('.')) {
    if (!isJsonObject(cur)) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function isAnswer(r: Answer | Record<string, number> | number | undefined): r is Answer {
  return typeof r === 'object' && r !== null && typeof (r as { type?: unknown }).type === 'string';
}

/**
 * Scripted ask: `answerFor` returns an Answer, a partial mass map over option keys (choice) or a
 * probability (noul); undefined means a uniform choice / 0.5 noul. Every call is recorded.
 */
export function scriptedAsk(answerFor: (id: string, q: Question, state: Json, call: number) => Answer | Record<string, number> | number | undefined): JevAsk & { calls: AskCall[] } {
  const calls: AskCall[] = [];
  const fn = async (stage: StageName, state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; rows: never[]; latencyMs: number }> => {
    calls.push({ stage, state, questions });
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const r = answerFor(id, q, state, calls.length - 1);
      if (isAnswer(r)) {
        answers[id] = r;
        continue;
      }
      if (q.type === 'choice') {
        answers[id] = choiceAnswer(q, r !== undefined && typeof r === 'object' ? r : Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === ESCAPE_KEY ? 0 : 1])));
      } else if (q.type === 'noul') {
        answers[id] = noulAnswer(typeof r === 'number' ? r : 0.5);
      } else {
        throw new Error(`unexpected score question ${id}`);
      }
    }
    return { answers, rows: [], latencyMs: 1 };
  };
  return Object.assign(fn, { calls });
}

/** Mass map putting `p` on `key` and the rest spread evenly over the other non-escape options. */
export function massOn(q: ChoiceQuestion, key: string, p: number): Record<string, number> {
  if (!(key in q.criteria)) throw new Error(`option ${key} is not offered; offered: ${Object.keys(q.criteria).join(', ')}`);
  const others = Object.keys(q.criteria).filter((k) => k !== key && k !== ESCAPE_KEY);
  const rest = others.length > 0 ? (1 - p) / others.length : 0;
  const m: Record<string, number> = {};
  for (const k of others) m[k] = rest;
  m[key] = p;
  return m;
}

/** Mass map with the given masses and the remainder spread over the other non-escape options. */
export function massOver(q: ChoiceQuestion, masses: Record<string, number>): Record<string, number> {
  for (const k of Object.keys(masses)) if (!(k in q.criteria)) throw new Error(`option ${k} is not offered; offered: ${Object.keys(q.criteria).join(', ')}`);
  const named = Object.keys(masses);
  const others = Object.keys(q.criteria).filter((k) => !named.includes(k) && k !== ESCAPE_KEY);
  const used = Object.values(masses).reduce((a, b) => a + b, 0);
  const rest = others.length > 0 ? Math.max(0, 1 - used) / others.length : 0;
  const m: Record<string, number> = {};
  for (const k of others) m[k] = rest;
  Object.assign(m, masses);
  return m;
}

/** Option key of a sketch by its rendered shape, in a Q12 question. */
export function keyForShape(q: ChoiceQuestion, shape: string): string | undefined {
  for (const [k, d] of Object.entries(q.criteria)) if (isJsonObject(d) && d['shape'] === shape) return k;
  return undefined;
}
