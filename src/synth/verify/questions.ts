/**
 * The Jev side of verification: which failing test to attack first. The wording is the neutral
 * attack-first Choice measured in experiments/results/probe-progress-judgment.md (16/34 vs 8/34
 * chance), reused verbatim. It gates nothing: `progress()` and `route()` decide in code; the pick
 * is a heuristic over failing tests the code cannot order. The Q17 progress questions (three Nouls
 * and a `closeness` Score) that used to live here were deleted on 2026-09-20 (docs/DECISIONS.md
 * "Q17 deleted"): every answer was a function of the pass counts the harness already computes.
 */
import type { Answer, Json, Question, StageName } from '../../core/types.js';
import { choice } from '../../jev/questions.js';
import type { FailureView, JevAsk } from '../types.js';
import type { PickedTest, PickOptions } from './types.js';
import { VerifyError } from './types.js';

/** Failures listed per goal in a Jev state (search/goals.ts GOAL_FAILURES_BOUND; the measured programs had up to 14). */
export const STATE_FAILURES_BOUND = 25;
/** The measured attack-first Choice offered the first 10 failing tests. */
export const DEFAULT_PICK_MAX = 10;
/** Jev's noise band on hedged answers is ±0.02 (REPORT §6), so probabilities this close are a tie. */
export const DEFAULT_TIE_MARGIN = 0.02;

/** Status label for a failure text, for the `status` field of the measured state shape. */
export function failureStatus(f: FailureView): 'fail' | 'error' | 'timeout' {
  if (/\btimeout\b|\btimed out\b/i.test(f.actual)) return 'timeout';
  if (/^[A-Z]\w*(?:Error|Exception|Exit|Interrupt)\b/.test(f.actual)) return 'error';
  return 'fail';
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
