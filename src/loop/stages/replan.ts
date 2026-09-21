/**
 * Replan stage (DESIGN.md §5.5 replan, §6): after a loop trip, one request with the
 * `next_move` Choice, its paired Nouls and `task_impossible`; Choice resolution with
 * fallback `change_approach`; `stop_and_report` -> replan_stop; task_impossible above the
 * threshold -> impossible regardless of the move.
 */
import { choice, noul, pairedNouls, ref } from '../../jev/questions.js';
import type { ChoiceVerdict, JsonObject, Question, ReplanDirective, ReplanMove } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { describeSignatureKind, signatureKind, type LoopDetector } from '../loopdetect.js';
import { buildReplanState } from '../state.js';
import { annotateChoiceRows, resolveChoice } from './choose.js';

export type ReplanOption = Exclude<ReplanMove, 'none_of_these'>;

export const REPLAN_OPTIONS: Record<ReplanOption, string> = {
  change_approach: 'keep the goal but reach it a different way: a different fix, file, or technique than the repeated one',
  gather_context: 'read or search the code and its tests before acting again, because the repeated step was based on a wrong assumption',
  fix_environment: 'repair the tooling or install what is missing, because the repetition is caused by the environment and not by the code',
  revert_changes: 'undo the changes made so far with git and restart from a clean state',
  stop_and_report: 'stop the run and report; further steps would waste budget',
};
export const REPLAN_LIST: readonly ReplanOption[] = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report'];
export const REPLAN_FALLBACK: ReplanOption = 'change_approach';

export function buildReplanQuestions(): Record<string, Question> {
  return {
    next_move: choice(
      `The engineer repeated the same step (${ref('loop')}) ${ref('loop.occurrences')} times. Given ${ref('task')}, ${ref('plan')}, ${ref('recent')} and ${ref('loop.priorDirectives')}, which recovery should be directed next?`,
      REPLAN_OPTIONS,
    ),
    ...pairedNouls(REPLAN_OPTIONS, (option, desc) => ({
      instructions: `Is \`${option}\` (${desc}) the right kind of next step given ${ref('plan')}, ${ref('recent')} and ${ref('loop')}?`,
      criteria: {
        true: { definition: `the repetition in ${ref('loop')} and the evidence in ${ref('recent')} make "${desc}" the recovery that would break the loop now`, examples: trueExamples(option) },
        false: { definition: `"${desc}" was already tried per ${ref('loop.priorDirectives')} without effect, or does not address why the step repeats`, examples: falseExamples(option) },
      },
    })),
    task_impossible: noul(`Is ${ref('task')} impossible in this workspace as stated?`, {
      true: {
        definition: 'the task requires something the workspace, sandbox or task statement rules out: a missing service or credential, a contradiction in the task, a dependency that cannot be installed here, or code that does not exist',
        examples: ['the task asks to fix a module that is not in the repository and cannot be created from the description', 'every attempt fails because a network service the tests need is denied by the sandbox', 'the task asks for behaviour that contradicts its own constraint'],
      },
      false: {
        definition: 'the task is feasible and the loop is a wrong approach, missing context or an environment fix the engineer can make',
        examples: ['the edit keeps failing on `old` not matching but the file exists and can be read', 'the tests fail on an assertion the engineer has not yet addressed', 'a dependency is missing but pip can install it'],
      },
    }),
  };
}

function trueExamples(option: string): string[] {
  switch (option) {
    case 'change_approach':
      return ['the same edit failed to match three times', 'the same test fails identically after three similar fixes'];
    case 'gather_context':
      return ['the engineer edits a file it has never read', 'the failing test\'s source was never shown'];
    case 'fix_environment':
      return ['every run fails with command not found', 'ModuleNotFoundError repeats on each test run'];
    case 'revert_changes':
      return ['the changed files now fail tests that passed before the run', 'the workspace is in an inconsistent half-applied state'];
    default:
      return ['two earlier directives for this signature had no effect', 'the budget is almost spent and the loop persists'];
  }
}
function falseExamples(option: string): string[] {
  switch (option) {
    case 'change_approach':
      return ['the loop is caused by a missing dependency', 'the engineer has never seen the failing file'];
    case 'gather_context':
      return ['the file has been shown twice already', 'recent shows the problem is the environment'];
    case 'fix_environment':
      return ['tests run fine; the failure is in the code', 'the environment is already repaired in recent'];
    case 'revert_changes':
      return ['no files have changed this run', 'the changes so far are correct and verified'];
    default:
      return ['this is the first trip and a plain change of approach is untried', 'recent shows steady progress despite the repetition'];
  }
}

export type ReplanOutcome = { kind: 'directive'; directive: ReplanDirective } | { kind: 'stop'; reason: 'replan_stop' | 'impossible'; directive: ReplanDirective };

export function directiveText(move: ReplanMove, verdict: ChoiceVerdict, probability: number, taskImpossible: number, signature: string): string {
  const kind = describeSignatureKind(signatureKind(signature));
  if (move === 'none_of_these' || verdict === 'fallback') {
    return `Jev found no listed recovery applicable after repeating the same ${kind} 3 times (p=${probability.toFixed(2)}, task_impossible=${taskImpossible.toFixed(2)}); propose a different action from anything shown in recent steps.`;
  }
  const desc = REPLAN_OPTIONS[move as ReplanOption];
  return `After repeating the same ${kind} 3 times, Jev directs \`${move}\` (p=${probability.toFixed(2)}, task_impossible=${taskImpossible.toFixed(2)}): ${desc}.`;
}

export async function runReplanStage(ctx: StageContext, common: JsonObject, detector: LoopDetector, lastOutcomes: readonly (string | null)[]): Promise<ReplanOutcome> {
  const signature = detector.trippedSignature() ?? 'unknown';
  const state = buildReplanState(common, {
    signature,
    kind: signatureKind(signature),
    occurrences: 3,
    lastOutcomes,
    trips: detector.trips(signature),
    priorDirectives: detector.priorDirectives(signature),
  });
  let resolved = resolveChoice<ReplanOption>({ choiceId: 'next_move', answers: {}, options: REPLAN_LIST, escape: 'none_of_these', fallback: REPLAN_FALLBACK });
  let taskImpossible = 0;
  let confidence = 0;
  await ctx.ask('replan', state, buildReplanQuestions(), (answers, rows) => {
    resolved = resolveChoice<ReplanOption>({ choiceId: 'next_move', answers, options: REPLAN_LIST, escape: 'none_of_these', fallback: REPLAN_FALLBACK });
    annotateChoiceRows(rows, 'next_move', resolved);
    const ti = answers['task_impossible'];
    taskImpossible = ti && ti.type === 'noul' ? ti.noul : 0;
    confidence = rows.find((r) => r.id === 'next_move')?.confidence ?? 0;
  });
  const move: ReplanMove = resolved.option;
  const directive: ReplanDirective = { move, probability: resolved.probability, confidence, taskImpossible, text: directiveText(resolved.verdict === 'fallback' ? 'none_of_these' : move, resolved.verdict, resolved.probability, taskImpossible, signature) };
  if (taskImpossible >= ctx.limits.impossibleThreshold) return { kind: 'stop', reason: 'impossible', directive };
  if (move === 'stop_and_report') return { kind: 'stop', reason: 'replan_stop', directive };
  ctx.emit({ type: 'replan', step: ctx.step, directive });
  return { kind: 'directive', directive };
}
