/**
 * Judge stage (DESIGN.md §5.5 judge): Nouls succeeded / error_present / new_information,
 * tests_pass_unparsed when the test command ran without a parsable summary, one done_<j>
 * per newly claimed plan item; batched with the completion Noul (complete.ts) in one request.
 */
import { noul, ref } from '../../jev/questions.js';
import type { Answer, Decision, DoneClaimResult, JsonObject, JudgeResult, Proposal, Question } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { buildJudgeState, type ExecutedInfo } from '../state.js';
import { PLAN_ACCEPT_THRESHOLD } from '../plan.js';
import { TASK_COMPLETE_ID, buildCompleteQuestion } from './complete.js';

export function doneClaimId(j: number): string {
  return `done_${j}`;
}

export function buildJudgeQuestions(opts: { testsUnparsed: boolean; claims: readonly string[]; read?: boolean }): Record<string, Question> {
  const qs: Record<string, Question> = {
    succeeded: noul(`Do ${ref('executed.output')} and ${ref('executed.changedFiles')} show that ${ref('proposal.goal')} happened?`, {
      true: {
        definition: 'the output or changed files show the goal occurred: an edit applied once, a command exited 0 with the expected effect, a read returned the requested content',
        examples: ['edit applied to src/a.py (1 match)', 'exit 0, 12 passed'],
      },
      false: {
        definition: 'no match / N matches, non-zero exit, timeout, truncated before the result, or the goal is only asserted in the engineer\'s text',
        examples: ['EditError: 2 matches', 'exit 1', 'timed out after 120s'],
      },
    }),
  };
  // §6 read row: a read shows file contents, so `error_present` (a command failure) is not asked.
  if (!opts.read) {
    qs['error_present'] = noul(`Does ${ref('executed.output')} contain a failure the engineer must act on?`, {
      true: {
        definition: 'a traceback ending in an exception, a non-zero exit with a diagnostic, a failed assertion, a missing module/command/file',
        examples: ['ModuleNotFoundError: No module named x', 'AssertionError', 'sh: cmd: not found'],
      },
      false: {
        definition: 'warnings, deprecation notices, the words error/ERROR inside passing output or as log-level names, expected failures (xfail), `0 errors`, tests that deliberately exercise error paths',
        examples: ['DeprecationWarning: …', 'ERROR root:app.py:12 handled (test passed)', '0 errors, 14 passed', 'XFAIL'],
      },
    });
  }
  qs['new_information'] = noul(`Does ${ref('executed.output')} contain a fact not in ${ref('plan')} or ${ref('recent')} that changes what to do next?`, {
    true: {
      definition: 'a new failing test, a missing dependency, a different root cause, an unexpected file layout',
      examples: ['a second test fails after the fix', 'package requires Python ≥3.10'],
    },
    false: {
      definition: 'confirmation of what the plan already says or a repeat of a known failure',
      examples: ['same traceback as step 5', 'tests pass as expected'],
    },
  });
  if (opts.testsUnparsed) {
    qs['tests_pass_unparsed'] = noul(`Does ${ref('executed.output')} show the test command finishing with every test passing?`, {
      true: { definition: 'a final summary reporting only passes/skips, exit code 0', examples: ['12 passed in 3.1s', 'ok  pkg/foo  0.412s', 'PASS'] },
      false: {
        definition: 'any failed/error count, a traceback after the summary, non-zero exit, or no summary because the run was cut off',
        examples: ['1 failed, 11 passed', 'FAIL  pkg/foo', 'ERRORS', 'Killed / timed out'],
      },
    });
  }
  opts.claims.forEach((_claim, j) => {
    qs[doneClaimId(j)] = noul(`Do ${ref('executed')} and ${ref('recent')} show that \`claims[${j}]\` is finished?`, {
      true: {
        definition:
          'the item\'s outcome is visible in `executed.output`, `executed.changedFiles`, or `executed.tests.parsed`, or in an earlier `recent` entry\'s output (a passing test run, an applied edit whose effect is then verified, a command that produced the required artefact)',
        examples: ['12 passed after the edit to src/a.py', 'artefact build/report.html listed by ls'],
      },
      false: {
        definition: 'claimed but not shown; shown only by the engineer\'s own text or summary; attempted but failed or blocked; or its verification has not run yet',
        examples: ['plan says fixed, no test run since the edit', 'exit 1 on the command that was to produce it'],
      },
    });
  });
  return qs;
}

export interface JudgeStageResult {
  /** null on a noop (done) step */
  judge: JudgeResult | null;
  completion: number;
  claimProbabilities: Map<string, number>;
}

function noulOf(answers: Record<string, Answer>, id: string, fallback: number): number {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : fallback;
}

/**
 * One request: judge Nouls (+ done_<j>) and task_complete, or task_complete alone for a
 * `noop` step (§6 done path). The task_complete row is labelled stage 'complete' for the pane.
 */
export async function runJudgeStage(ctx: StageContext, common: JsonObject, proposal: Proposal, executed: ExecutedInfo, claims: readonly string[]): Promise<JudgeStageResult> {
  const reduced = executed.outcome.status === 'noop';
  const read = proposal.action.kind === 'read';
  const testsUnparsed = executed.tests !== null && executed.tests.parsed === null;
  const questions: Record<string, Question> = reduced ? {} : buildJudgeQuestions({ testsUnparsed, claims, read });
  questions[TASK_COMPLETE_ID] = buildCompleteQuestion();
  const state = buildJudgeState(common, proposal, executed, reduced ? [] : claims, ctx.redact);
  let judge: JudgeResult | null = null;
  let completion = 0;
  const claimProbabilities = new Map<string, number>();
  await ctx.ask('judge', state, questions, (answers, rows: Decision[]) => {
    for (const r of rows) if (r.id === TASK_COMPLETE_ID) r.stage = 'complete';
    completion = noulOf(answers, TASK_COMPLETE_ID, 0);
    if (reduced) return;
    const doneClaims: DoneClaimResult[] = claims.map((text, j) => {
      const p = noulOf(answers, doneClaimId(j), 0);
      claimProbabilities.set(text, p);
      return { text, judged: p, accepted: p >= PLAN_ACCEPT_THRESHOLD };
    });
    let tests: JudgeResult['tests'] = null;
    if (executed.tests) {
      const parsed = executed.tests.parsed;
      tests = parsed
        ? { source: 'parsed', allPassed: executed.tests.allPassed === true, passed: parsed.passed, failed: parsed.failed, errors: parsed.errors }
        : { source: 'judged', allPassed: noulOf(answers, 'tests_pass_unparsed', 0) };
    }
    // errorPresent is 0 (not asked) on a read: file contents are not a command failure.
    judge = { succeeded: noulOf(answers, 'succeeded', 0), errorPresent: read ? 0 : noulOf(answers, 'error_present', 0), newInfo: noulOf(answers, 'new_information', 0), tests, doneClaims };
  });
  ctx.emit({ type: 'judge', step: ctx.step, judge, completion });
  return { judge, completion, claimProbabilities };
}
