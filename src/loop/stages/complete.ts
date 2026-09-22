/**
 * Completion Noul (DESIGN.md §5.5 complete): `task_complete`, batched into the judge request
 * (judge.ts). Its criteria reference the code-computed `workspace.lastTestRun` /
 * `workspace.testsCurrent` and `proposal.planClaim`, never `executed.tests` or a bare
 * `plan.remaining`, so it can fire on the step that produced the final evidence. On a `done`
 * step (2026-09-20, ladder round 6) `executed.lastRun` carries the engine's last test run
 * (state.ts doneExecutedJson) and the criteria name it: a `done` after the engine's own green,
 * current run is the engineer stopping on verified work, and a `plan.remaining` item that asks
 * only for that verification is satisfied by the run. Jev still decides; the threshold is unchanged.
 */
import { noul, ref } from '../../jev/questions.js';
import { COMPLETING_ORACLE_OUTCOMES, type ActionKind, type CompletionEvidence, type OutcomeStatus, type Question, type TestCounts } from '../../core/types.js';

export const TASK_COMPLETE_ID = 'task_complete';

export function buildCompleteQuestion(): Question {
  return noul(
    `Is ${ref('task')} complete, judged from ${ref('executed')}, ${ref('recent')}, ${ref('workspace.lastTestRun')}, ${ref('workspace.testsCurrent')} and the accepted ${ref('plan')}? Treat ${ref('proposal.planClaim')} as the engineer's own unverified claim of what remains. On a \`done\` step nothing ran: ${ref('executed.lastRun')} is the harness's record of the engine's last test run (\`allPassed\`, \`total\`, \`workspaceUnchangedSince\` are code-computed facts, not the engineer's claim).`,
    {
      true: {
        definition:
          'the requested behaviour is implemented AND verified in this run: when `workspace.hasTests` is true, `workspace.lastTestRun` is present, `workspace.lastTestRun.allPassed` is true and `workspace.testsCurrent` is true; when `workspace.hasTests` is false, `recent` shows equivalent direct evidence (a build, a script run, or output demonstrating the behaviour); and nothing in the accepted `plan.remaining` is still genuinely outstanding once the work `executed` just did is counted as done. A `done` whose `executed.lastRun.allPassed` and `executed.lastRun.workspaceUnchangedSince` are both true follows the engine\'s own verifying run; a `plan.remaining` item that asks only for that verification (running the suite, checking the tests pass) is satisfied by `executed.lastRun`',
        examples: [
          'the fix was edited at step 4, `workspace.lastTestRun` at step 5 shows 41 passed 0 failed, `workspace.testsCurrent` is true, and the plan\'s remaining item was that test run',
          'a `done` at step 11: `executed.lastRun` is the step-10 run of the test command with `allPassed` true, `total` 10 and `workspaceUnchangedSince` true, and `plan.remaining` lists only "verify the full test suite passes"',
          'no test suite exists; `recent` shows the script producing the requested output after the change and nothing else is planned',
          'the task asked for one new function; it was written, imported by the tests, and the last test run after the edit passed',
        ],
      },
      false: {
        definition:
          'untested; `workspace.lastTestRun` absent or with failures; `workspace.testsCurrent` false (files changed after the last test run); `proposal.planClaim.remaining` is empty but `plan.remaining` or `recent` shows unfinished or unverified work; or `plan.openProblems` names something unresolved',
        examples: [
          'an edit applied at step 6 but `workspace.lastTestRun` is from step 5, so `workspace.testsCurrent` is false',
          '`workspace.lastTestRun` shows 2 failed',
          'the engineer\'s planClaim says nothing remains, but `plan.remaining` still lists "update the docstring" and no step touched it',
          '`plan.openProblems` says the second test still fails intermittently',
        ],
      },
    },
  );
}

/** `task_complete >= completeThreshold` (§5.5 stop rule). */
export function isComplete(completion: number | null, threshold: number): boolean {
  return completion !== null && completion >= threshold;
}

/** docs/LLM-JEV-DESIGN.md §6.6: `tests_pass_unparsed` stands in for the parsed counts only when the runner's output could not be parsed. */
export const TESTS_PASS_UNPARSED_THRESHOLD = 0.85;

/**
 * The known-failure count the synthesizer declares beside the completion evidence
 * (`synth/search/index.ts`, from `RepositoryMode.knownFailures`: the scoped tests that already failed
 * at the base commit). `core/types.ts` owns the shape of `CompletionEvidence`, so the count travels as
 * an optional structural extension — absent off the repository class, where it is 0.
 *
 * Why it exists (experiments/results/llm-jev-headtohead-v2.md §9 class E′): `sympy-11618`'s scoped
 * suite has **43 pre-existing collection errors** in its environment. The fix landed at step 3, but the
 * claiming run read `644 passed / 0 failed / 43 errors`, so the fact below — which compared against
 * zero — never held; the synthesizer then re-claimed `done partial` at steps 5, 6 and 7, the loop
 * tripped, and the run ended `replan_stop` at step 10 with the correct patch on disk (the evaluator
 * passed it). Comparing against the baseline's own count ends that run `complete` on the claiming run.
 */
export interface KnownFailuresEvidence {
  /** `failed + errors` of the scoped baseline at the base commit; absent = 0 */
  knownFailures?: number;
}

/** What the synthesizer writes on the claiming `run`: the §6.6 facts plus the base commit's known failures. */
export type ClaimingCompletionEvidence = CompletionEvidence & KnownFailuresEvidence;

/** A declared known-failure count, sanitised: a finite count above 0, else 0 (a missing declaration means "none"). */
export function knownFailureCount(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The failures a claiming run may show without contradicting the fact: the ones its evidence declares. */
export function knownFailuresOf(completion: ClaimingCompletionEvidence | undefined): number {
  return knownFailureCount(completion?.knownFailures);
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

export interface CompletionFactInput {
  /** the executed proposal's action kind (null: no proposal) */
  action: ActionKind | null;
  outcome: OutcomeStatus | null;
  /** the engine's parse of the executed run when it was the workspace test command; null for any other action or command */
  tests: { command: string; parsed: TestCounts | null; allPassed: boolean | null } | null;
  /** `workspace.testsCurrent`: no workspace change was executed at or after the run (a code fact of `lastChangeStep`) */
  testsCurrent: boolean;
  /** the synthesizer's declaration that this `run` is the claiming run (`ProposalEvidence.completion`), with the base commit's `knownFailures` when it declared them */
  completion: ClaimingCompletionEvidence | undefined;
  /** the recorded `tests_pass_unparsed` answer; null when not asked (parsed run) */
  testsPassUnparsed: number | null;
  /** engine-computed (risk.ts VerifiedCompletion): a `done` claiming nothing remains after the engine's own passing, current run */
  verifiedDone: boolean;
}

/**
 * docs/LLM-JEV-DESIGN.md §6.6: the synthesizer's side of the fact — every ledger goal fixed, no committed candidate touched a
 * test file, every multi-passer batch arbitrated, and on the repository class (an oracle was sought or a reproduction ran)
 * the reproduction passes under a code oracle: an `llm_valid` / `llm_weak` oracle never completes, nor does a run whose
 * oracle search found nothing. When the evidence names the suite command, the executed run must be that command.
 */
export function completionEvidenceHolds(c: CompletionEvidence, executedCommand: string): boolean {
  if (!c.ledgerFixed || c.testsChanged.length > 0 || c.guardPending) return false;
  if (c.command !== undefined && c.command.trim() !== executedCommand.trim()) return false;
  const repository = c.oracle !== null || c.repro !== 'none';
  return !repository || (c.repro === 'pass' && c.oracle !== null && COMPLETING_ORACLE_OUTCOMES.includes(c.oracle));
}

/**
 * docs/LLM-JEV-DESIGN.md §6.6 (llm-jev): completion is a code fact declared on the evidence. On the claiming `run` step: the
 * run executed the workspace test command, the parser read `passed > 0` and **no failure beyond the baseline's known ones**
 * (`unexpectedFailures`; with none declared that is the original `failed = errors = 0`, and the runner's own `allPassed` is
 * required too — with known failures the runner exits non-zero by construction), the run is current, and the synthesizer's
 * `evidence.completion` holds in full (`completionEvidenceHolds`; on the repository class that includes the reproduction
 * passing under a code oracle, so a run whose goal is among the pre-existing failures cannot complete on them). When the
 * parser read nothing, `tests_pass_unparsed` stands in as before. A `done` completes only when the engine's own passing,
 * current run verifies it (a partial `done` never does). `task_complete` is recorded, never consulted.
 */
export function isCompleteByFact(i: CompletionFactInput): boolean {
  if (i.action === 'done') return i.outcome === 'noop' && i.verifiedDone;
  if (i.action !== 'run' || i.outcome !== 'executed' || i.completion === undefined || i.tests === null || !i.testsCurrent) return false;
  if (!completionEvidenceHolds(i.completion, i.tests.command)) return false;
  const parsed = i.tests.parsed;
  if (parsed === null) return i.testsPassUnparsed !== null && i.testsPassUnparsed >= TESTS_PASS_UNPARSED_THRESHOLD;
  const known = knownFailuresOf(i.completion);
  if (parsed.passed === 0 || unexpectedFailures(parsed, known) > 0) return false;
  return known > 0 || i.tests.allPassed === true;
}
