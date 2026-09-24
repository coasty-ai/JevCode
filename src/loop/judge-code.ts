/**
 * The code judge (docs/LLM-JEV-DESIGN.md §3 row 7): a step's JudgeResult from harness data alone — the parsed
 * test counts against the baseline's known failures, the exit code of a non-test command, and plan claims
 * accepted by arithmetic. It asks Jev nothing, so it sits beside the engine rather than inside the Jev-driven
 * judge stage (src/jev-modes/stages/judge.ts, which calls it on every jev-on and llm-jev step); the agent path judges each
 * test run it observes with the same function (engine.ts).
 */
import type { DoneClaimResult, JudgeResult, ProposalEvidence, TestCounts } from '../core/types.js';
import { PLAN_ACCEPT_THRESHOLD } from './plan.js';
import type { ExecutedTests } from './state.js';

/** docs/LLM-JEV-DESIGN.md §6.6: `tests_pass_unparsed` stands in for the parsed counts only when the runner's output could not be parsed. */
export const TESTS_PASS_UNPARSED_THRESHOLD = 0.85;

/** A declared known-failure count, sanitised: a finite count above 0, else 0 (a missing declaration means "none"). */
export function knownFailureCount(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Failures a run shows **beyond** the baseline's known ones: `failed + errors − knownFailures`, floored
 * at 0. Pre-existing failures are not the engineer's to fix and not evidence against a verified patch;
 * anything above them is. With `knownFailures = 0` (every QuixBugs / ladder run and every repository
 * workspace whose scoped suite is green at the base) this is the old `failed = errors = 0` test.
 */
export function unexpectedFailures(counts: Pick<TestCounts, 'failed' | 'errors'>, knownFailures: number): number {
  return Math.max(0, counts.failed + counts.errors - Math.max(0, knownFailures));
}

/** The executed run as the code judge reads it (llm-jev). */
export interface CodeJudgeRun {
  /** the executed run when it was the workspace test command (command, parsed counts, allPassed); null for another command */
  tests: ExecutedTests | null;
  /** exit code of the executed command when known (non-test runs are judged on it) */
  exitCode: number | null;
  /** the proposal's shadow-run evidence: its `newlyPassing` ids are the executed run's when the parsed counts agree */
  evidence: Pick<ProposalEvidence, 'after' | 'newlyPassing'> | null;
  /** the recorded `tests_pass_unparsed` answer; consumed only when the parser read nothing */
  testsPassUnparsed: number | null;
  /**
   * `evidence.completion.knownFailures` (complete.ts): the scoped tests that already failed at the base
   * commit. The suite counts as passing when nothing fails beyond them — `sympy-11618`'s claiming run
   * reads `644 passed / 0 failed / 43 errors` on an environment that had those 43 errors before the
   * patch, and judging it against zero cost that run 7 steps and its `complete` (§9 class E′). Default 0.
   */
  knownFailures?: number;
}

// the ledger grammar of synth/search/memory.ts planItemFor: `fix <test>[, +N more] in <path>`; test ids may contain " in ", paths never contain spaces
const LEDGER_CLAIM_RE = /^fix (.+) in (?:\S+|the workspace)$/;
const LEDGER_MORE_RE = /^(.*), \+\d+ more$/;

/**
 * The test ids each claim names: the ledger item's first test, widened to the goal's full test set when the
 * proposal's `evidence.goalTests` contains it (the item names one test and `+N more`); a claim outside the
 * grammar (e.g. the standing verification item) names none and is accepted only by a passing suite.
 */
export function ledgerGoalsOf(claims: readonly string[], goalTests: readonly string[] = []): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const claim of claims) {
    const m = LEDGER_CLAIM_RE.exec(claim.trim());
    if (m === null || m[1] === undefined) {
      out.set(claim, []);
      continue;
    }
    const first = (LEDGER_MORE_RE.exec(m[1])?.[1] ?? m[1]).trim();
    out.set(claim, goalTests.includes(first) ? [...goalTests] : [first]);
  }
  return out;
}

/**
 * docs/LLM-JEV-DESIGN.md §3 row 7: the JudgeResult of a `run` from harness data alone. `succeeded` = every test passed
 * (`failed = errors = 0`, `passed > 0`; `tests_pass_unparsed >= 0.85` stands in when the parser read nothing), `errorPresent`
 * = the parser counted errors, `newInfo` = 0 (nothing is inferred), a claim is accepted iff the test suite passed or its
 * goal tests are all in the `newlyPassing` the executed counts confirm; a non-test command's `succeeded` is its exit code,
 * which accepts no claim (exit 0 of `echo ok` says nothing about the ledger).
 */
export function codeJudge(run: CodeJudgeRun, claims: readonly string[], ledgerGoals: ReadonlyMap<string, readonly string[]>): JudgeResult {
  const parsed = run.tests?.parsed ?? null;
  // §6.6 as amended: "every test passed" means nothing failed beyond the baseline's known failures; with
  // none declared this is the original `failed = errors = 0` and the runner's own `allPassed` is required
  const known = knownFailureCount(run.knownFailures);
  const unexpected = parsed === null ? 0 : unexpectedFailures(parsed, known);
  let allPassed: boolean;
  if (parsed !== null) allPassed = (known > 0 || run.tests?.allPassed === true) && unexpected === 0 && parsed.passed > 0;
  else if (run.tests !== null) allPassed = run.testsPassUnparsed !== null && run.testsPassUnparsed >= TESTS_PASS_UNPARSED_THRESHOLD;
  else allPassed = run.exitCode === 0;
  const e = run.evidence;
  const countsAgree = parsed !== null && e !== null && e.after.passed === parsed.passed && e.after.failed === parsed.failed && e.after.errors === parsed.errors;
  const newlyPassing: readonly string[] = countsAgree && e !== null ? e.newlyPassing : [];
  // §3 row 7: only the passing test suite accepts every claim; a non-test command's exit 0 says nothing about the ledger
  const suitePassed = run.tests !== null && allPassed;
  const doneClaims: DoneClaimResult[] = claims.map((text) => {
    const goals = ledgerGoals.get(text) ?? [];
    const judged = suitePassed || (goals.length > 0 && goals.every((t) => newlyPassing.includes(t))) ? 1 : 0;
    return { text, judged, accepted: judged >= PLAN_ACCEPT_THRESHOLD };
  });
  let tests: JudgeResult['tests'] = null;
  if (run.tests !== null) {
    tests = parsed !== null
      ? { source: 'parsed', allPassed: run.tests.allPassed === true, passed: parsed.passed, failed: parsed.failed, errors: parsed.errors }
      : { source: 'judged', allPassed: run.testsPassUnparsed ?? 0 };
  }
  // an error the engineer must act on is one the baseline did not already have (the judge's `error_present 1.00`
  // on 43 pre-existing collection errors is what tripped sympy-11618's replan)
  const errorPresent = parsed !== null ? (parsed.errors > 0 && unexpected > 0 ? 1 : 0) : run.tests === null && run.exitCode !== null && run.exitCode !== 0 ? 1 : 0;
  return { succeeded: allPassed ? 1 : 0, errorPresent, newInfo: 0, tests, doneClaims, source: 'code' };
}
