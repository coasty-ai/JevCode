/**
 * Progress deltas and the next-move policy, both in code. The probe
 * (experiments/results/probe-progress-judgment.md, design points 1, 3, 4) measured that Jev
 * reads code-computed numbers perfectly but hedges when asked to compare lists or pick a policy
 * option from numbers, so nothing here asks Jev anything: the numbers are computed, the route
 * is an if-chain, and Jev's progress questions (questions.ts) are consistency checks only.
 */
import type { Move, Progress, TestRunSummary } from '../types.js';
import type { SearchState } from './types.js';

/**
 * The written-down rule for edits that fix some tests and break others (design point 4):
 * a regression is always reverted, even when the newly failing test is the one being attacked.
 * Why: the attacked test was failing before the edit, so it can only appear in `newlyFailing`
 * when the two runs disagree about which tests exist or the test flapped; neither is evidence
 * for the edit, and keeping a partial-but-broke edit would let the search walk away from a
 * baseline that passed strictly more tests. The candidate ranker sees the other tests too, so a
 * complete fix stays reachable from the reverted state.
 */
export const REGRESSION_RULE = 'revert on any regression, including when the newly failing test is the attacked one';

/** A summary knows its passing ids when it lists some, or when nothing passed (nothing to list). */
function knowsPassingIds(s: TestRunSummary): boolean {
  return s.passing.length > 0 || s.passed === 0;
}

/** Deltas between two runs; ids where available, counts as the fallback (run_tests.py has no passing ids). */
export function progress(before: TestRunSummary, after: TestRunSummary): Progress {
  const beforeFailing = new Set(before.failing);
  const afterFailing = new Set(after.failing);
  const afterPassing = new Set(after.passing);
  const beforePassing = new Set(before.passing);

  // newly passing: failed before, passes now. With passing ids (pytest -rA) require the id to
  // be listed as passing so a test that vanished (collection error, renamed) does not count;
  // without them (pytest -q, run_tests.py) "not failing any more" is the best available, but
  // only when the after run produced results at all.
  const newlyPassing = before.failing.filter((id) => (knowsPassingIds(after) ? afterPassing.has(id) : after.total > 0 && !afterFailing.has(id)));

  // newly failing: passed before, fails now. Same asymmetry: prefer the before run's passing
  // ids; otherwise any failing id that was not failing before.
  const newlyFailing = after.failing.filter((id) => (knowsPassingIds(before) ? beforePassing.has(id) : !beforeFailing.has(id)));

  const allPass = after.passed > 0 && after.failed === 0 && after.errors === 0 && !after.timedOut;
  const improved = after.passed > before.passed;
  // Contract says regressed = newlyFailing.length > 0; the count fallback is added because a run
  // without failing ids (killed pytest, capped run_tests.py list) can drop passing tests silently.
  const regressed = newlyFailing.length > 0 || after.passed < before.passed;
  return { before, after, newlyPassing, newlyFailing, allPass, improved, regressed };
}

/**
 * Code-owned policy (probe design points 3–4), every branch total:
 *   allPass                       → accept_and_stop
 *   improved and not regressed    → accept_and_continue (progress is kept even on an empty budget;
 *                                    the outer loop checks the budget before its next step)
 *   regressed                     → revert (REGRESSION_RULE), then the revert branch below
 *   no change                     → revert branch
 * revert branch:
 *   budgetExhausted               → give_up
 *   candidatesRemainingAtSite > 0 → revert_try_next
 *   sourcesRemainingAtSite > 0    → widen_sources (next candidate source at the same site)
 *   otherwise                     → revert_relocalise (next site, or re-localise when sitesRemaining is 0;
 *                                    the search module owns that distinction)
 */
export function route(p: Progress, search: SearchState): Move {
  if (p.allPass) return 'accept_and_stop';
  if (p.improved && !p.regressed) return 'accept_and_continue';
  // regressed (including partial-but-broke, see REGRESSION_RULE) or unchanged: revert
  if (search.budgetExhausted) return 'give_up';
  if (search.candidatesRemainingAtSite > 0) return 'revert_try_next';
  if (search.sourcesRemainingAtSite > 0) return 'widen_sources';
  return 'revert_relocalise';
}

/** True for the moves that keep the candidate applied. */
export function keepsCandidate(move: Move): boolean {
  return move === 'accept_and_stop' || move === 'accept_and_continue';
}
