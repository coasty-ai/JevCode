/**
 * Test doubles for the guard and bases modules: real Sites from the QuixBugs sources through the
 * shared analyser, real applyCandidate, VerifyOutcome builders with code-computed progress, and a
 * scripted JevAsk that returns valid Answer objects (probabilities summing to 1, argmax choice).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Answer, Json, Question, StageName } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { analyse, blockAt, scopeAt } from '../../../../src/synth/py/index.js';
import type { Base, Goal, OracleModel, VerifyOutcome, VerifyStatus } from '../../../../src/synth/search/types.js';
import type { Candidate, FailureView, JevAsk, LineEdit, Site, SourceFile, TestRunSummary } from '../../../../src/synth/types.js';
import { applyCandidate, progress } from '../../../../src/synth/verify/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../../..');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');

export function quixbugsProgram(name: string, which: 'programs' | 'correct' = 'programs'): string {
  return readFileSync(join(QUIXBUGS_DIR, which, `${name}.py`), 'utf8');
}

// ---------------------------------------------------------------------------------------
// Scripted Jev
// ---------------------------------------------------------------------------------------

/** Two-decimal wire probabilities that sum to exactly 1 (the last key absorbs the rounding). */
function normalise(raw: Record<string, number>): Record<string, number> {
  const keys = Object.keys(raw);
  const total = keys.reduce((s, k) => s + (raw[k] ?? 0), 0);
  const out: Record<string, number> = {};
  let acc = 0;
  keys.forEach((k, i) => {
    const p = i === keys.length - 1 ? Math.round((1 - acc) * 100) / 100 : Math.round(((raw[k] ?? 0) / (total || 1)) * 100) / 100;
    acc += p;
    out[k] = p;
  });
  return out;
}

export function noulAnswer(p: number): Answer {
  return { type: 'noul', noul: p };
}

/** A valid Choice answer from weights; options not in `weights` get 0. */
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

/** A JevAsk whose answers come from `script(questions, state, callNo)`; records every call. */
export function scriptedAsk(script: (questions: Record<string, Question>, state: Json, call: number) => Record<string, Answer>): JevAsk & { calls: AskCall[] } {
  const calls: AskCall[] = [];
  const ask: JevAsk = async (stage, state, questions) => {
    calls.push({ stage, state, questions });
    const answers = script(questions, state, calls.length);
    for (const id of Object.keys(questions)) if (!(id in answers)) throw new Error(`script did not answer ${id}`);
    return { answers, rows: [], latencyMs: 1 };
  };
  return Object.assign(ask, { calls });
}

/** A JevAsk that must never be reached (branches the design says are Jev-free). */
export const throwingAsk: JevAsk = async () => {
  throw new Error('Jev must not be asked on this branch');
};

/**
 * Answer an arbitration request: Choice weights and Noul p's keyed by the candidate TEXT (trimmed),
 * so scripts read like the measured tables rather than depending on cand_xx numbering.
 */
export function arbitrationScript(o: { choice: Record<string, number>; escape: number; noul: Record<string, number> }): (questions: Record<string, Question>, state: Json) => Record<string, Answer> {
  return (questions, state) => {
    const cands = (state as { candidates: Record<string, { with: string }> }).candidates;
    const textOf = (key: string): string => cands[key]?.with ?? '';
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const weights: Record<string, number> = { [ESCAPE_KEY]: o.escape };
        for (const k of Object.keys(q.criteria)) if (k !== ESCAPE_KEY) weights[k] = o.choice[textOf(k)] ?? 0;
        answers[id] = choiceAnswer(q, weights);
      } else if (q.type === 'noul') {
        answers[id] = noulAnswer(o.noul[textOf(id.replace(/^general_/, ''))] ?? 0);
      } else {
        answers[id] = scoreAnswer(q, [1]);
      }
    }
    return answers;
  };
}

// ---------------------------------------------------------------------------------------
// Sources, sites, candidates
// ---------------------------------------------------------------------------------------

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A replace or insert site at `line` of `file`, block and scope from the analyser. */
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

let nextId = 0;
export function candidate(site: Site, text: string, extra: Partial<Pick<Candidate, 'id' | 'source' | 'op' | 'prior'>> & { extraEdits?: LineEdit[] } = {}): Candidate {
  const c: Candidate = { id: extra.id ?? `c${nextId++}`, site, text, source: extra.source ?? 'mutation', op: extra.op ?? 'test_op' };
  if (extra.extraEdits !== undefined) c.extraEdits = extra.extraEdits;
  if (extra.prior !== undefined) c.prior = extra.prior;
  return c;
}

// ---------------------------------------------------------------------------------------
// Summaries, goals, bases, outcomes
// ---------------------------------------------------------------------------------------

export function summary(over: Partial<TestRunSummary> & { failing?: string[]; passing?: string[] }): TestRunSummary {
  const failing = over.failing ?? [];
  const passing = over.passing ?? [];
  const failed = over.failed ?? failing.length;
  const passed = over.passed ?? passing.length;
  const errors = over.errors ?? 0;
  return {
    command: over.command ?? 'python3 run_tests.py prog cand.py',
    passed,
    failed,
    errors,
    skipped: 0,
    total: over.total ?? passed + failed + errors,
    failing,
    passing,
    failures: over.failures ?? failing.map((id) => ({ testId: id, call: id, expected: '1', actual: '0' })),
    exitCode: over.exitCode ?? (failed + errors > 0 ? 1 : 0),
    timedOut: over.timedOut ?? false,
    durationMs: over.durationMs ?? 5,
    outputTail: '',
  };
}

export function failure(call: string, expected = '1', actual = '0'): FailureView {
  return { testId: call, call, expected, actual };
}

export function goal(failures: FailureView[], over: Partial<Goal> = {}): Goal {
  return {
    id: over.id ?? 'g1',
    tests: failures.map((f) => f.testId),
    failures,
    suspectedFiles: over.suspectedFiles ?? [],
    status: over.status ?? 'active',
    attempts: 0,
    budgetHits: 0,
    exhausted: new Map(),
    phase: 'SEEDS',
    planItem: over.planItem ?? `fix ${failures[0]?.testId ?? '?'} in prog.py`,
  };
}

export function oracle(over: Partial<OracleModel> = {}): OracleModel {
  return { runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 1000, runTimeoutMs: 30_000, baselineDurationMs: 300, ...over };
}

/** The committed base: `file` at the baseline `summary` (failing = the goal's tests). */
export function committedBase(file: SourceFile, baseline: TestRunSummary): Base {
  return { id: 'committed', origin: 'committed', fromGoal: null, files: new Map([[file.path, file]]), summary: baseline, depth: 0 };
}

export interface OutcomeSpec {
  /** goal-subset run after the candidate (default: everything passes) */
  subset?: TestRunSummary;
  /** full-suite run after the candidate; omitted for non-passers unless given */
  full?: TestRunSummary;
  status?: VerifyStatus;
  p?: number;
}

/** A VerifyOutcome over `cand` on `base`, progress computed by the real progress() against the base. */
export function outcome(cand: Candidate, base: Base, spec: OutcomeSpec = {}): VerifyOutcome {
  const applied = applyCandidate(cand, base.files);
  const allTests = base.summary.total;
  const subset = spec.subset ?? summary({ passed: allTests, failing: [] });
  const after = spec.full ?? subset;
  const p = progress(base.summary, after);
  const status: VerifyStatus = spec.status ?? (p.allPass ? 'plausible' : p.regressed ? 'regressed' : p.improved ? 'partial' : 'unchanged');
  const o: VerifyOutcome = {
    job: { candidate: cand, base, p: spec.p ?? 0.5, sourcePrior: 0.5, key: [base.summary.passed, spec.p ?? 0.5, 0.5] },
    applied,
    subset,
    progress: p,
    status,
  };
  if (spec.full !== undefined) o.full = spec.full;
  return o;
}

/** Every test passes on the subset and the full suite. */
export function plausibleOutcome(cand: Candidate, base: Base): VerifyOutcome {
  const all = summary({ passed: base.summary.total, failing: [] });
  return outcome(cand, base, { subset: all, full: all });
}

/** Some of the base's failing tests now pass, nothing broke. */
export function partialOutcome(cand: Candidate, base: Base, nowPassing: readonly string[]): VerifyOutcome {
  const stillFailing = base.summary.failing.filter((id) => !nowPassing.includes(id));
  const s = summary({ passed: base.summary.passed + nowPassing.length, failing: stillFailing, total: base.summary.total });
  return outcome(cand, base, { subset: s });
}

// ---------------------------------------------------------------------------------------
// The two measured programs
// ---------------------------------------------------------------------------------------

export const NEXT_PERMUTATION = sourceFile('next_permutation.py', quixbugsProgram('next_permutation'));
/** `                if perm[j] < perm[i]:` */
export const NEXT_PERMUTATION_LINE = 6;
/** contrarian-arbitrate.truth.jsonl, in the measured cand_01..05 order (cand_04 is the gold). */
export const NEXT_PERMUTATION_PLAUSIBLE = ['if perm[j] > perm[i]:', 'if perm[j] >= perm[i]:', 'if not perm[j] < perm[i]:', 'if perm[i] < perm[j]:', 'if not (perm[j] < perm[i]):'].map((t) => `                ${t}`);
export const NEXT_PERMUTATION_FAILURES: FailureView[] = [
  { testId: 'next_permutation([3, 2, 4, 1])', call: 'next_permutation([3, 2, 4, 1])', expected: '[3, 4, 1, 2]', actual: '[3, 4, 2, 1]' },
  { testId: 'next_permutation([3, 5, 6, 2, 1])', call: 'next_permutation([3, 5, 6, 2, 1])', expected: '[3, 6, 1, 2, 5]', actual: 'None' },
];

export const DEPTH_FIRST_SEARCH = sourceFile('depth_first_search.py', quixbugsProgram('depth_first_search'));
/** `                search_from(nextnode) for nextnode in node.successors` */
export const DEPTH_FIRST_SEARCH_LINE = 11;
/** contrarian-arbitrate.all.jsonl: the 7 all-overfit passers, measured order. */
export const DEPTH_FIRST_SEARCH_OVERFITS = [
  'nextnode for nextnode in node.successors',
  'search_from(goalnode) for nextnode in node.successors',
  'node for nextnode in node.successors',
  'any for nextnode in node.successors',
  'goalnode for nextnode in node.successors',
  'depth_first_search for nextnode in node.successors',
  'startnode for nextnode in node.successors',
].map((t) => `                ${t}`);
export const DEPTH_FIRST_SEARCH_FAILURES: FailureView[] = [{ testId: 'test5: Case 5: Graph with cycles', call: 'test5: Case 5: Graph with cycles', expected: 'pass', actual: 'RecursionError: maximum recursion depth exceeded' }];
