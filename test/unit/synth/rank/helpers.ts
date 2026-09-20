/**
 * Test doubles for the ranker: a Site built from a real Python fixture through the shared
 * analyser, candidate factories, and a scripted JevAsk that answers from a weight function
 * and validates every answer against the questions with the production validator (so a
 * malformed script fails the test, not the ranker).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Answer, Json, Question, StageName } from '../../../../src/core/types.js';
import { choiceConfidence } from '../../../../src/jev/confidence.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { validateJevResponse } from '../../../../src/jev/validate.js';
import { analyse, blockAt, scopeAt } from '../../../../src/synth/py/structure.js';
import type { Candidate, FailureView, JevAsk, RankContext, Site, SourceFile } from '../../../../src/synth/types.js';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/synth/rank/', import.meta.url));

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A replace or insert site at `line` of `file`, with the block and scope from the analyser. */
export function siteAt(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const b = blockAt(file.mod, kind === 'insert' ? Math.max(1, line - 1) : line);
  const current = kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '';
  return {
    file,
    line,
    kind,
    currentLine: current,
    indent: /^\s*/.exec(current)?.[0] ?? '',
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['test fixture'] },
  };
}

export const GCD_SRC = readFileSync(`${FIXTURES}gcd.py`, 'utf8');
export const GCD_FILE = sourceFile('gcd.py', GCD_SRC);
/** `        return gcd(a % b, b)` */
export const GCD_BUGGY_LINE = 5;
export const GCD_FIX = '        return gcd(b, a % b)';

export const GCD_FAILURES: FailureView[] = [
  { testId: 'gcd[1]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[2]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[3]', call: 'gcd(20, 100)', expected: '20', actual: 'RecursionError: maximum recursion depth exceeded' },
];

let nextId = 0;
export function candidate(site: Site, text: string, extra: Partial<Pick<Candidate, 'id' | 'source' | 'op' | 'extraEdits' | 'prior'>> = {}): Candidate {
  const c: Candidate = { id: extra.id ?? `c${nextId++}`, site, text, source: extra.source ?? 'mutation', op: extra.op ?? 'test_op' };
  if (extra.extraEdits !== undefined) c.extraEdits = extra.extraEdits;
  if (extra.prior !== undefined) c.prior = extra.prior;
  return c;
}

/** `n` distinct wrong candidates at the gcd site (`return gcd(a % b, b) + k`-style mutants). */
export function distractors(site: Site, n: number, start = 0): Candidate[] {
  return Array.from({ length: n }, (_, i) => candidate(site, `        return gcd(a % b, b) + ${start + i + 1}`, { id: `d${start + i}` }));
}

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

export interface ScriptOptions {
  /** weight of a candidate option given its description text (default: 1) */
  weight?: (text: string) => number;
  /** weight of `none_of_these` (default: 0.2) */
  escapeWeight?: number;
  /** P(yes) of a per-candidate Noul given the candidate text (default: weight-based 0.1 / 0.9) */
  noul?: (text: string) => number;
  /** resolve answers only after this promise (for abort tests) */
  gate?: Promise<void>;
  /** throw from the ask itself */
  fail?: Error;
}

export interface ScriptedAsk {
  ask: JevAsk;
  calls: AskCall[];
}

function descriptionText(d: Json | null): string {
  if (typeof d === 'string') return d;
  if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
    const line = d['line'];
    if (typeof line === 'string') return line;
  }
  return JSON.stringify(d);
}

/** Candidate text behind a Noul question id (`candidates.<id>` in the state). */
function candidateTextFromState(state: Json, id: string): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return '';
  const cands = state['candidates'];
  if (cands === null || cands === undefined || typeof cands !== 'object' || Array.isArray(cands)) return '';
  const d = cands[id];
  return d === undefined ? '' : descriptionText(d);
}

/**
 * Build a valid Answer for every question: Choice probabilities from weights, normalised to
 * sum 1, `choice` = argmax, confidence per REPORT §8; Nouls from the noul function.
 */
export function scriptedAnswers(state: Json, questions: Record<string, Question>, o: ScriptOptions = {}): Record<string, Answer> {
  const weight = o.weight ?? ((): number => 1);
  const escapeWeight = o.escapeWeight ?? 0.2;
  const noul = o.noul ?? ((t: string): number => (weight(t) > 1 ? 0.9 : 0.1));
  const answers: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: noul(candidateTextFromState(state, id)) };
    } else if (q.type === 'choice') {
      const weights: [string, number][] = Object.entries(q.criteria).map(([k, d]) => [k, k === ESCAPE_KEY ? escapeWeight : weight(descriptionText(d))]);
      const total = weights.reduce((s, [, w]) => s + w, 0);
      const probabilities: Record<string, number> = {};
      let best = '';
      let bestP = -1;
      for (const [k, w] of weights) {
        const p = total > 0 ? w / total : 1 / weights.length;
        probabilities[k] = p;
        if (p > bestP) {
          bestP = p;
          best = k;
        }
      }
      answers[id] = { type: 'choice', choice: best, probabilities, confidence: choiceConfidence(bestP, weights.length) };
    } else {
      const n = q.criteria.length;
      const probabilities: Record<string, number> = {};
      for (let k = 0; k < n; k++) probabilities[String(k)] = k === n - 1 ? 1 : 0;
      answers[id] = { type: 'score', score: n - 1, legend: {}, probabilities, confidence: 1 };
    }
  }
  // The production validator is the arbiter of "valid Answer objects".
  const body = { model: 'typesafe/jev-1.13-20260917', answers, usage: { input_tokens: 1, output_tokens: 0, cost: 0 } };
  return validateJevResponse(body, questions).answers;
}

export function scriptedAsk(o: ScriptOptions = {}): ScriptedAsk {
  const calls: AskCall[] = [];
  const ask: JevAsk = async (stage, state, questions) => {
    calls.push({ stage, state, questions });
    if (o.fail !== undefined) throw o.fail;
    if (o.gate !== undefined) await o.gate;
    return { answers: scriptedAnswers(state, questions, o), rows: [], latencyMs: 1 };
  };
  return { ask, calls };
}

export function context(ask: JevAsk, overrides: Partial<Omit<RankContext, 'ask'>> = {}): RankContext {
  return {
    ask,
    task: overrides.task ?? 'Fix gcd so that the tests pass.',
    failures: overrides.failures ?? GCD_FAILURES,
    functionListing: overrides.functionListing ?? '',
    signal: overrides.signal ?? new AbortController().signal,
  };
}

/** Choice options of a call (without the escape), key → description text. */
export function choiceOptions(call: AskCall, id = 'fix'): Map<string, string> {
  const q = call.questions[id];
  if (q === undefined || q.type !== 'choice') throw new Error(`no choice "${id}" in call`);
  return new Map(Object.entries(q.criteria).filter(([k]) => k !== ESCAPE_KEY).map(([k, d]) => [k, descriptionText(d)]));
}

export function noulIds(call: AskCall): string[] {
  return Object.entries(call.questions).filter(([, q]) => q.type === 'noul').map(([id]) => id);
}
