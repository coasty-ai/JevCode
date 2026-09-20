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
import type { Question } from '../../core/types.js';

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
