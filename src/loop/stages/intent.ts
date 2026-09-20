/**
 * Intent stage (DESIGN.md §5.5 intent, §6): one request with the `intent` Choice, its five
 * paired Nouls and `plan_still_valid`; Choice resolution gives the effective intent.
 */
import { choice, noul, pairedNouls, ref } from '../../jev/questions.js';
import type { Intent, IntentAnswer, JsonObject, Question } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { buildIntentState } from '../state.js';
import { annotateChoiceRows, resolveChoice, type ChoiceVerdict } from './choose.js';

export const INTENT_OPTIONS: Record<Intent, string> = {
  investigate: 'read or search code before changing it',
  edit: 'change source files',
  verify: 'run tests, a build, or a script to check the current state',
  fix_environment: 'install a dependency or repair tooling so work can continue',
  finish: 'nothing remains; the work is verified',
};
export const INTENT_LIST: readonly Intent[] = ['investigate', 'edit', 'verify', 'fix_environment', 'finish'];
export const INTENT_FALLBACK: Intent = 'investigate';
export const PLAN_STALE_THRESHOLD = 0.3;

export function buildIntentQuestions(): Record<string, Question> {
  const qs: Record<string, Question> = {
    intent: choice(
      `What kind of step should the engineer take next, given ${ref('task')}, ${ref('plan')} (especially ${ref('plan.remaining')}) and ${ref('recent')}?`,
      INTENT_OPTIONS,
    ),
    ...pairedNouls(INTENT_OPTIONS, (option, desc) => ({
      instructions: `Is \`${option}\` (${desc}) the right kind of next step given ${ref('plan')} and ${ref('recent')}?`,
      criteria: {
        true: {
          definition: `the state of ${ref('plan.remaining')}, ${ref('recent')} and ${ref('workspace')} makes "${desc}" the step that moves the task forward now`,
          examples: pairedTrueExamples(option),
        },
        false: {
          definition: `"${desc}" would repeat work already shown in ${ref('recent')}, skip a prerequisite, or is not what ${ref('plan.remaining')} calls for now`,
          examples: pairedFalseExamples(option),
        },
      },
    })),
    plan_still_valid: noul(`Does ${ref('plan.remaining')} still describe what has to happen next given ${ref('recent')}?`, {
      true: {
        definition: 'the remaining items are still the right work in the right order; recent results confirm or do not contradict them',
        examples: ['tests still fail on the item listed first in remaining', 'the last edit applied and the next remaining item is to run the tests'],
      },
      false: {
        definition: 'recent output shows the remaining items are wrong, already done, impossible, or missing a newly discovered prerequisite',
        examples: ['remaining says "fix parser" but the traceback is now in the serializer', 'remaining lists an item recent shows already verified', 'a missing dependency blocks every remaining item and is not listed'],
      },
    }),
  };
  return qs;
}

function pairedTrueExamples(option: string): string[] {
  switch (option) {
    case 'investigate':
      return ['the failing function has not been shown yet', 'the plan names a file no recent step has read'];
    case 'edit':
      return ['the cause is known from a traceback and the file has been shown', 'a test in recent fails on one identifiable line'];
    case 'verify':
      return ['the last step edited a file and no test has run since', 'the plan\'s next item is to run the test suite'];
    case 'fix_environment':
      return ['recent shows ModuleNotFoundError for a required package', 'the test command is not found in the sandbox'];
    default:
      return ['every remaining item is done and the last test run passed with no changes since', 'the task asked for one change, it is applied and verified in recent'];
  }
}
function pairedFalseExamples(option: string): string[] {
  switch (option) {
    case 'investigate':
      return ['the relevant file was shown two steps ago and nothing changed', 'the cause is already identified in the plan'];
    case 'edit':
      return ['no recent step shows the file to change', 'tests have not been run after the previous edit'];
    case 'verify':
      return ['tests already passed after the last change', 'nothing has changed since the last verification'];
    case 'fix_environment':
      return ['tests ran fine in recent', 'the failure is an assertion in the code, not a missing tool'];
    default:
      return ['remaining is non-empty', 'files changed after the last test run'];
  }
}

export interface IntentStageResult {
  intent: Intent;
  answer: IntentAnswer;
  verdict: ChoiceVerdict;
  probability: number;
  confidence: number;
  pairedNoul: number;
  planStillValid: number;
}

export async function runIntentStage(ctx: StageContext, common: JsonObject): Promise<IntentStageResult> {
  const questions = buildIntentQuestions();
  const state = buildIntentState(common);
  let resolved = resolveChoice<Intent>({ choiceId: 'intent', answers: {}, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
  let planStillValid = 1;
  let confidence = 0;
  await ctx.ask('intent', state, questions, (answers, rows) => {
    resolved = resolveChoice<Intent>({ choiceId: 'intent', answers, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    annotateChoiceRows(rows, 'intent', resolved);
    const psv = answers['plan_still_valid'];
    planStillValid = psv && psv.type === 'noul' ? psv.noul : 1;
    const row = rows.find((r) => r.id === 'intent');
    confidence = row ? row.confidence : 0;
  });
  const answer: IntentAnswer = resolved.answer === 'none_of_these' || (INTENT_LIST as readonly string[]).includes(resolved.answer) ? (resolved.answer as IntentAnswer) : 'none_of_these';
  ctx.emit({ type: 'intent', step: ctx.step, intent: resolved.option, answer, probability: resolved.probability, confidence });
  return { intent: resolved.option, answer, verdict: resolved.verdict, probability: resolved.probability, confidence, pairedNoul: resolved.pairedNoul, planStillValid };
}
