/**
 * Offline helpers for the beam tests: sites built from the fixtures with the real Python
 * analysis, and a scripted JevAsk that returns wire-valid answers (probabilities sum to 1,
 * choice = argmax) without touching the network.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answer, Json, Question, StageName } from '../../../../../src/core/types.js';
import { isJsonObject } from '../../../../../src/core/json.js';
import { choiceAnswer, noulAnswer } from '../../../../../src/jev/mock.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { analyse, blockAt, scopeAt } from '../../../../../src/jev-modes/synth/py/index.js';
import type { EnumerateOptions, JevAsk, Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '../../../../fixtures/synth/beam');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A site at `line` of a source file (replace by default; insert sites have no current line). */
export function siteAt(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const text = kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '';
  const indent = kind === 'replace' ? (/^[ \t]*/.exec(text)?.[0] ?? '') : (/^[ \t]*/.exec(file.mod.lines[line - 1] ?? '')?.[0] ?? '');
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

/** knapsack fixture: buggy `if weight < j:` on line 12. */
export function knapsackSite(): { file: SourceFile; site: Site } {
  const file = sourceFile('knapsack.py', fixture('knapsack.py'));
  return { file, site: siteAt(file, 12) };
}

export const GCD_FAILURES = [
  { testId: 'gcd[13,13]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[37,600]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
];

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

export type ChoiceQuestion = Extract<Question, { type: 'choice' }>;

/** Option key whose description names `token`, or undefined when the option is not offered. */
export function keyForToken(q: ChoiceQuestion, token: string): string | undefined {
  for (const [k, d] of Object.entries(q.criteria)) {
    if (isJsonObject(d) && d['token'] === token) return k;
  }
  return undefined;
}

export function optionKeys(q: ChoiceQuestion): string[] {
  return Object.keys(q.criteria);
}

export function asChoice(q: Question | undefined): ChoiceQuestion {
  if (q === undefined || q.type !== 'choice') throw new Error('expected a choice question');
  return q;
}

/** Read a string field at a dotted path of the state (`hypotheses.prefix_x.partial_line`). */
export function stateString(state: Json, path: string): string | undefined {
  let cur: Json | undefined = state;
  for (const p of path.split('.')) {
    if (!isJsonObject(cur)) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** The hypothesis path prefix a question refers to ('' for a flat state). */
export function hypothesisOf(questionId: string, prefix: string): string | null {
  return questionId === prefix ? null : questionId.slice(prefix.length + 1);
}

function isAnswer(r: Answer | Record<string, number> | number | undefined): r is Answer {
  return typeof r === 'object' && r !== null && typeof (r as { type?: unknown }).type === 'string';
}

/**
 * Scripted ask: `answerFor` builds the answer per question (default: uniform choice / 0.5 noul).
 * Records every call. `answers` for a choice is a partial mass map over option keys.
 */
export function scriptedAsk(
  answerFor: (id: string, q: Question, state: Json, call: number) => Answer | Record<string, number> | number | undefined,
  hooks: { onCall?: (call: AskCall) => void } = {},
): JevAsk & { calls: AskCall[] } {
  const calls: AskCall[] = [];
  const fn = async (stage: StageName, state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; rows: never[]; latencyMs: number }> => {
    const call = { stage, state, questions };
    calls.push(call);
    hooks.onCall?.(call);
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
  const others = Object.keys(q.criteria).filter((k) => k !== key && k !== ESCAPE_KEY);
  const rest = others.length > 0 ? (1 - p) / others.length : 0;
  const m: Record<string, number> = {};
  for (const k of others) m[k] = rest;
  m[key] = p;
  return m;
}

/** Mass map with the given probabilities on `masses` and the remainder spread over the other non-escape options. */
export function massOver(q: ChoiceQuestion, masses: Record<string, number>): Record<string, number> {
  const named = Object.keys(masses);
  const others = Object.keys(q.criteria).filter((k) => !named.includes(k) && k !== ESCAPE_KEY);
  const used = Object.values(masses).reduce((a, b) => a + b, 0);
  const rest = others.length > 0 ? Math.max(0, 1 - used) / others.length : 0;
  const m: Record<string, number> = {};
  for (const k of others) m[k] = rest;
  Object.assign(m, masses);
  return m;
}
