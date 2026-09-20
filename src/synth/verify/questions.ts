/**
 * The Jev side of verification. Wordings are the ones measured in
 * experiments/results/probe-progress-judgment.md (three Nouls 240/240 on the `both` state, the
 * 5-level `closeness` Score 230/240, the neutral attack-first Choice 16/34 vs 8/34 chance) and
 * are reused verbatim. None of them gates anything: `progress()` and `route()` decide; these are
 * consistency checks on the summariser and beam heuristics (design points 2, 5, 6).
 */
import type { Answer, Json, Question, StageName } from '../../core/types.js';
import { choice, noul, score } from '../../jev/questions.js';
import type { FailureView, JevAsk, Progress, TestRunSummary } from '../types.js';
import type { PickedTest, PickOptions, ProgressJudgment } from './types.js';
import { VerifyError } from './types.js';

/** Failures listed per run in the state (the measured programs had up to 14). */
export const STATE_FAILURES_BOUND = 25;
/** The measured attack-first Choice offered the first 10 failing tests. */
export const DEFAULT_PICK_MAX = 10;
/** Jev's noise band on hedged answers is ±0.02 (REPORT §6), so probabilities this close are a tie. */
export const DEFAULT_TIE_MARGIN = 0.02;
/** Noul answers outside this band count as confident for the consistency check. */
export const UNSURE_LOW = 0.3;
export const UNSURE_HIGH = 0.7;

export type ProgressQuestionId = 'program_correct' | 'made_progress' | 'broke_something' | 'closeness';

/** Status label for a failure text, for the `status` field of the measured state shape. */
export function failureStatus(f: FailureView): 'fail' | 'error' | 'timeout' {
  if (/\btimeout\b|\btimed out\b/i.test(f.actual)) return 'timeout';
  if (/^[A-Z]\w*(?:Error|Exception|Exit|Interrupt)\b/.test(f.actual)) return 'error';
  return 'fail';
}

function failuresJson(s: TestRunSummary): Json[] {
  return s.failures.slice(0, STATE_FAILURES_BOUND).map((f) => ({ test: f.testId, input: f.call, expected: f.expected, actual: f.actual, status: failureStatus(f) }));
}

/** Measured variant `both`: counts plus failure texts. `failed` here is fail + error + timeout. */
function runView(s: TestRunSummary): { [k: string]: Json } {
  return { passed: s.passed, failed: s.failed + s.errors, total: s.total, failing_tests: failuresJson(s) };
}

export interface ProgressStateOptions {
  /** e.g. "the Python function `gcd`"; default names the program */
  subject?: string;
}

/**
 * The state for the progress questions: measured `both` shape for `before` and `after`, plus the
 * variant-B code-computed `newly_passing_tests` / `newly_failing_tests` numbers on `after`.
 */
export function progressState(p: Progress, opts: ProgressStateOptions = {}): Json {
  const subject = opts.subject ?? 'the program under repair';
  return {
    task: `A candidate edit was applied to ${subject}. \`before\` is the test result of the program before the edit; \`after\` is the test result after the edit. Judge from the test results only. A test counts as failing if its status is fail, error or timeout. \`after.newly_passing_tests\` and \`after.newly_failing_tests\` were computed by code from the two runs.`,
    before: runView(p.before),
    after: { ...runView(p.after), newly_passing_tests: p.newlyPassing.length, newly_failing_tests: p.newlyFailing.length },
  };
}

/**
 * The three Nouls and the Score, measured wording. `made_progress` and `broke_something` need a
 * baseline and are omitted when `before` ran nothing; `closeness` collapses without a fraction
 * (measured on the `raw` variant) and is omitted when `after` ran nothing.
 */
export function progressQuestions(p: Progress): Record<string, Question> {
  const qs: Record<string, Question> = {
    program_correct: noul('After the edit, does `after` show the program passing every test, so that the program is now correct?', {
      true: { definition: 'every test passes in `after`; no failing, erroring or timed-out test remains', examples: ['`after.failed` is 0 and `after.passed` equals `after.total`', '`after.failing_tests` is an empty list'] },
      false: { definition: 'at least one test still fails, errors or times out in `after`', examples: ['`after` lists two failing tests', '`after.passed` is 8 of 9', 'one test times out after the edit'] },
    }),
  };
  if (p.before.total > 0) {
    qs['made_progress'] = noul('Compared with `before`, did this edit make progress: does the program pass strictly more tests in `after` than in `before`?', {
      true: { definition: 'the number of passing tests in `after` is larger than in `before` (fewer tests fail after the edit than before it)', examples: ['before passed 1 of 9, after passes 4 of 9', 'a test listed under `before.failing_tests` is missing from `after.failing_tests` and no new failure appeared'] },
      false: { definition: 'the same number or fewer tests pass after the edit; the results are unchanged or worse', examples: ['before and after list the same failing tests', 'after passes fewer tests than before', 'the failing tests changed but their number did not shrink'] },
    });
    qs['broke_something'] = noul('Did the edit break something that worked: is there a test that passed in `before` but fails, errors or times out in `after`?', {
      true: { definition: 'at least one test that was passing before the edit is failing after it', examples: ['a test appears in `after.failing_tests` that is not in `before.failing_tests`', 'before passed 5 of 6, after passes 0 of 6'] },
      false: { definition: 'every test that passed before the edit still passes after it', examples: ['the set of failing tests shrank or stayed exactly the same', 'before passed 1 of 9, after passes 9 of 9'] },
    });
  }
  if (p.after.total > 0) {
    qs['closeness'] = score('Judging from `after` only, how close is the program to correct?', [
      'nothing works: every test fails, errors or times out',
      'mostly broken: a small minority of the tests pass, most fail',
      'half way: roughly as many tests pass as fail',
      'nearly correct: most tests pass, a few still fail',
      'correct: every test passes, no failures remain',
    ]);
  }
  return qs;
}

/** The code verdict each Noul is checked against. */
export function codeVerdicts(p: Progress): Record<string, boolean> {
  return { program_correct: p.allPass, made_progress: p.improved, broke_something: p.regressed };
}

/** Σ k·p_k over the wire probabilities keyed "0".."n-1". */
export function expectedLevel(probabilities: Record<string, number>): number {
  let e = 0;
  for (const [k, p] of Object.entries(probabilities)) {
    const level = Number(k);
    if (Number.isFinite(level) && Number.isFinite(p)) e += level * p;
  }
  return e;
}

/**
 * One request with the progress questions; returns the probabilities and where Jev confidently
 * disagrees with the code verdicts. A disagreement is a signal about the summariser or the
 * test set (different tests between runs, flaky tests), never a reason to change the route.
 */
export async function judgeProgress(p: Progress, ask: JevAsk, opts: ProgressStateOptions & { stage?: StageName } = {}): Promise<ProgressJudgment> {
  const questions = progressQuestions(p);
  const stateOpts: ProgressStateOptions = opts.subject === undefined ? {} : { subject: opts.subject };
  const res = await ask(opts.stage ?? 'judge', progressState(p, stateOpts), questions);
  const verdicts = codeVerdicts(p);
  const nouls: Record<string, number> = {};
  const disagreements: string[] = [];
  const unsure: string[] = [];
  let closenessExpected: number | null = null;
  for (const [id, answer] of Object.entries(res.answers)) {
    if (answer.type === 'noul') {
      nouls[id] = answer.noul;
      const truth = verdicts[id];
      if (truth === undefined) continue;
      if (answer.noul > UNSURE_LOW && answer.noul < UNSURE_HIGH) unsure.push(id);
      else if ((answer.noul >= UNSURE_HIGH) !== truth) disagreements.push(id);
    } else if (answer.type === 'score' && id === 'closeness') {
      closenessExpected = expectedLevel(answer.probabilities);
    }
  }
  return { nouls, closenessExpected, disagreements, unsure, requests: 1, latencyMs: res.latencyMs };
}

// ---------------------------------------------------------------------------------------
// Which failing test to attack first
// ---------------------------------------------------------------------------------------

const KEY_MAX = 64;

/** `failing_<slug of the test id>`: semantic snake_case, never index-like, unique within the batch. */
export function optionKeyFor(testId: string, taken: ReadonlySet<string>): string {
  let slug = testId
    .toLowerCase()
    .replace(/\.py\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug === '' || !/^[a-z]/.test(slug)) slug = `test_${slug}`;
  let key = `failing_${slug}`.slice(0, KEY_MAX).replace(/_+$/, '');
  if (!taken.has(key)) return key;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const cut = `failing_${slug}`.slice(0, KEY_MAX - suffix.length).replace(/_+$/, '');
    const k = `${cut}${suffix}`;
    if (!taken.has(k)) return k;
  }
}

/** The code tiebreak's notion of input size: the call text (arguments, or the node id with its params). */
export function inputSize(f: FailureView): number {
  return f.call.length;
}

export interface PickBatch {
  offered: { key: string; failure: FailureView }[];
  state: Json;
  question: Question;
}

/** The measured neutral Choice: null option descriptions, content under `failing_tests.<key>`. */
export function pickQuestion(failures: readonly FailureView[], opts: PickOptions = {}): PickBatch {
  const max = opts.max ?? DEFAULT_PICK_MAX;
  const taken = new Set<string>();
  const offered: { key: string; failure: FailureView }[] = [];
  for (const f of failures.slice(0, max)) {
    const key = optionKeyFor(f.testId, taken);
    taken.add(key);
    offered.push({ key, failure: f });
  }
  const entries: { [k: string]: Json } = {};
  for (const { key, failure } of offered) entries[key] = { input: failure.call, expected: failure.expected, actual: failure.actual, status: failureStatus(failure) };
  const options: Record<string, Json | null> = {};
  for (const { key } of offered) options[key] = null;
  // Measured task text names the subject first ("The Python function `gcd` fails several tests.")
  const subject = opts.subject ?? 'the program under repair';
  const task = `${subject.charAt(0).toUpperCase()}${subject.slice(1)} fails several tests. \`failing_tests\` lists them with input, expected output and actual result.`;
  return {
    offered,
    state: { task, failing_tests: entries },
    question: choice('Which entry of `failing_tests` should the repair attack first?', options),
  };
}

function smallestInput(items: readonly { key: string; failure: FailureView }[]): { key: string; failure: FailureView } {
  let best = items[0];
  if (best === undefined) throw new VerifyError('no failing tests to pick from');
  for (const it of items) if (inputSize(it.failure) < inputSize(best.failure)) best = it;
  return best;
}

/**
 * Neutral Choice over the failing tests with a code tiebreak on input size: when several
 * options sit within `tieMargin` of the top probability, or the escape option wins, the
 * smallest input among them (list order breaks exact ties) is attacked first. One failing test
 * is returned without a request.
 */
export async function pickNextFailingTest(failures: readonly FailureView[], ask: JevAsk, opts: PickOptions & { stage?: StageName } = {}): Promise<PickedTest> {
  if (failures.length === 0) throw new VerifyError('pickNextFailingTest needs at least one failing test');
  const batch = pickQuestion(failures, opts);
  const first = batch.offered[0];
  if (first === undefined) throw new VerifyError('pickNextFailingTest needs at least one failing test');
  if (batch.offered.length === 1) return { testId: first.failure.testId, failure: first.failure, probability: 1, method: 'single', requests: 0 };

  const res = await ask(opts.stage ?? 'propose', batch.state, { attack_first: batch.question });
  const answer: Answer | undefined = res.answers['attack_first'];
  if (answer === undefined || answer.type !== 'choice') throw new VerifyError('attack_first answer missing or not a choice');
  const margin = opts.tieMargin ?? DEFAULT_TIE_MARGIN;
  const p = (key: string): number => answer.probabilities[key] ?? 0;
  const top = batch.offered.reduce((m, it) => Math.max(m, p(it.key)), 0);
  const escape = answer.probabilities['none_of_these'] ?? 0;
  // Escape winning means "attack first" has no good answer (measured only on 950-char inputs): code decides.
  if (escape > top) {
    const pick = smallestInput(batch.offered);
    return { testId: pick.failure.testId, failure: pick.failure, probability: p(pick.key), method: 'tiebreak', requests: 1 };
  }
  const tied = batch.offered.filter((it) => top - p(it.key) <= margin + 1e-9);
  const pick = smallestInput(tied);
  return { testId: pick.failure.testId, failure: pick.failure, probability: p(pick.key), method: tied.length > 1 ? 'tiebreak' : 'jev', requests: 1 };
}
