/** Fixtures, scripted Jev answers and Site/Candidate builders for the synth/verify unit tests. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Answer, Json, Question, StageName } from '../../../../src/core/types.js';
import { analyse, scopeAt } from '../../../../src/synth/py/index.js';
import type { Candidate, FailureView, JevAsk, LineEdit, Site, SourceFile, TestRunSummary } from '../../../../src/synth/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '../../../fixtures/synth/verify');
export const REPO_ROOT = join(here, '../../../..');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------------------
// Scripted Jev
// ---------------------------------------------------------------------------------------

/** Two-decimal wire probabilities that sum to exactly 1 (the last option absorbs the rounding). */
function normalise(raw: Record<string, number>): Record<string, number> {
  const keys = Object.keys(raw);
  const total = keys.reduce((s, k) => s + (raw[k] ?? 0), 0);
  const out: Record<string, number> = {};
  let acc = 0;
  keys.forEach((k, i) => {
    const p = i === keys.length - 1 ? Math.round((1 - acc) * 100) / 100 : Math.round(((raw[k] ?? 0) / total) * 100) / 100;
    acc += p;
    out[k] = p;
  });
  return out;
}

export function noulAnswer(p: number): Answer {
  return { type: 'noul', noul: p };
}

/** A valid Choice answer: probabilities sum to 1, choice = argmax, confidence = (p_max − 1/n)/(1 − 1/n). */
export function choiceAnswer(question: Question, weights: Record<string, number>): Answer {
  if (question.type !== 'choice') throw new Error('choiceAnswer needs a choice question');
  const keys = Object.keys(question.criteria);
  const raw: Record<string, number> = {};
  for (const k of keys) raw[k] = weights[k] ?? 0;
  const probabilities = normalise(raw);
  let choice = keys[0] ?? '';
  let best = -1;
  for (const k of keys) {
    const p = probabilities[k] ?? 0;
    if (p > best) {
      best = p;
      choice = k;
    }
  }
  const n = keys.length;
  return { type: 'choice', choice, probabilities, confidence: n <= 1 ? 1 : Math.max(0, (best - 1 / n) / (1 - 1 / n)) };
}

/** A valid Score answer: score = Σ k·p_k over "0".."n-1". */
export function scoreAnswer(question: Question, weights: number[]): Answer {
  if (question.type !== 'score') throw new Error('scoreAnswer needs a score question');
  const n = question.criteria.length;
  const raw: Record<string, number> = {};
  for (let k = 0; k < n; k++) raw[String(k)] = weights[k] ?? 0;
  const probabilities = normalise(raw);
  let score = 0;
  for (let k = 0; k < n; k++) score += k * (probabilities[String(k)] ?? 0);
  const legend: Record<string, Json> = {};
  question.criteria.forEach((c, k) => {
    legend[String(k)] = c;
  });
  return { type: 'score', score, legend, probabilities, confidence: 1 };
}

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

/** A JevAsk whose answers come from `script(questions, state)`; records every call. */
export function scriptedAsk(script: (questions: Record<string, Question>, state: Json, call: number) => Record<string, Answer>): JevAsk & { calls: AskCall[] } {
  const calls: AskCall[] = [];
  const ask: JevAsk = async (stage: StageName, state: Json, questions: Record<string, Question>) => {
    calls.push({ stage, state, questions });
    const answers = script(questions, state, calls.length);
    for (const id of Object.keys(questions)) if (!(id in answers)) throw new Error(`script did not answer ${id}`);
    return { answers, rows: [], latencyMs: 1 };
  };
  return Object.assign(ask, { calls });
}

// ---------------------------------------------------------------------------------------
// Summaries, sites, candidates
// ---------------------------------------------------------------------------------------

export function summary(over: Partial<TestRunSummary> & { failing?: string[]; passing?: string[] }): TestRunSummary {
  const failing = over.failing ?? [];
  const passing = over.passing ?? [];
  const failed = over.failed ?? failing.length;
  const passed = over.passed ?? passing.length;
  const errors = over.errors ?? 0;
  const skipped = over.skipped ?? 0;
  return {
    command: over.command ?? 'pytest -q',
    passed,
    failed,
    errors,
    skipped,
    total: over.total ?? passed + failed + errors + skipped,
    failing,
    passing,
    failures: over.failures ?? failing.map((id) => ({ testId: id, call: id, expected: '1', actual: '0' })),
    exitCode: over.exitCode ?? (failed + errors > 0 ? 1 : 0),
    timedOut: over.timedOut ?? false,
    durationMs: over.durationMs ?? 5,
    outputTail: over.outputTail ?? '',
  };
}

export function failure(testId: string, call: string, expected = '1', actual = '0'): FailureView {
  return { testId, call, expected, actual };
}

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

export function site(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const lines = file.src.split('\n');
  const currentLine = kind === 'replace' ? (lines[line - 1] ?? '') : '';
  const indent = /^[ \t]*/.exec(kind === 'replace' ? currentLine : (lines[line - 1] ?? lines[line - 2] ?? ''))?.[0] ?? '';
  return { file, line, kind, currentLine, indent, block: null, scope: scopeAt(file.mod, line), evidence: { notes: [] } };
}

export function candidate(s: Site, text: string, extraEdits?: LineEdit[]): Candidate {
  const c: Candidate = { id: `c-${s.line}`, site: s, text, source: 'mutation', op: 'test' };
  return extraEdits === undefined ? c : { ...c, extraEdits };
}

export const GCD_BUGGY = 'def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(a % b, b)\n';
