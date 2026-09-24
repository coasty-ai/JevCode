/**
 * Intent stage (DESIGN.md §5.5 intent, §6): one request with the `intent` Choice, its five
 * paired Nouls and `plan_still_valid`; Choice resolution gives the effective intent.
 *
 * jev-only mode (docs/JEV-ONLY-DESIGN.md §5.2): when the accepted plan carries the synthesizer's
 * ledger (fixed-form `fix <test> in <path>` items in `plan.remaining`) the state shows it as
 * `ledger`, the `edit` and `verify` options are described as what the synthesizer will do with
 * them, and the ledger breaks the Choice-resolution tie: a fallback to `investigate` that would
 * happen only because every paired Noul is under 0.5 is replaced by Jev's own `edit`/`verify`
 * answer when that answer has p >= LEDGER_CHOICE_FLOOR, and an `edit` while a change is still
 * unverified (code-computed `workspace.testsCurrent` false) becomes `verify`: the plan's next
 * step is the suite run the synthesizer proposes after every patch. Likewise a fallback whose
 * answer is `finish` (p >= LEDGER_CHOICE_FLOOR) is rescued when the engine's own last test run is
 * green and current (code-computed `commonRunGreen`; with every test passing no ledger item is open
 * in fact, whatever the plan text still lists — experiments/results/jev-only-ladder-4-analysis.md
 * §4 Fix 1: units step 13, `finish` 0.63 / `can_finish` 0.31 fell back to `investigate` and the
 * risk stage then judged every later `done` against the wrong intent). Nothing here runs outside
 * jev-only, so jev-on and jev-off resolve exactly as §6 says.
 */
import { choice, noul, pairedNouls, ref } from '../../jev/questions.js';
import { routeSpeculative, type StepToken } from '../../jev/router.js';
import { RL1_INTENT_DEADLINE_MS, noteStepRoute, routersOn, stepTokenFor } from '../../loop/routers.js';
import type { Answer, EngineMode, Intent, IntentAnswer, JsonObject, Question } from '../../core/types.js';
import type { StageContext } from '../../loop/engine.js';
import { buildIntentState, commonChangeUnverified, commonRemaining, commonRunGreen, ledgerItems } from '../../loop/state.js';
import { annotateChoiceRows, pairedId, resolveChoice, type ChoiceResolution, type ChoiceVerdict } from './choose.js';

export const INTENT_OPTIONS: Record<Intent, string> = {
  investigate: 'read or search code before changing it',
  edit: 'change source files',
  verify: 'run tests, a build, or a script to check the current state',
  fix_environment: 'install a dependency or repair tooling so work can continue',
  finish: 'nothing remains; the work is verified',
};
/** jev-only with a ledger: `edit` and `verify` are the two steps of the synthesizer's patch → run alternation. */
export const INTENT_OPTIONS_LEDGER: Record<Intent, string> = {
  ...INTENT_OPTIONS,
  edit: 'apply a verified fix for an item in `plan.remaining`',
  verify: 'run the suite after a fix',
};
export const INTENT_LIST: readonly Intent[] = ['investigate', 'edit', 'verify', 'fix_environment', 'finish'];
export const INTENT_FALLBACK: Intent = 'investigate';
export const PLAN_STALE_THRESHOLD = 0.3;
/** Choice probability Jev's `edit`/`verify` answer needs for the ledger rule to take it over a fallback. */
export const LEDGER_CHOICE_FLOOR = 0.3;

export interface IntentQuestionOptions {
  /** the state carries `ledger` (jev-only with fixed-form plan items) */
  ledger?: boolean;
}

export function buildIntentQuestions(opts: IntentQuestionOptions = {}): Record<string, Question> {
  const ledger = opts.ledger === true;
  const options = ledger ? INTENT_OPTIONS_LEDGER : INTENT_OPTIONS;
  const planRef = ledger ? `${ref('plan')} (especially ${ref('plan.remaining')}, whose \`fix … in …\` items are listed in ${ref('ledger.items')})` : `${ref('plan')} (especially ${ref('plan.remaining')})`;
  const qs: Record<string, Question> = {
    intent: choice(`What kind of step should the engineer take next, given ${ref('task')}, ${planRef} and ${ref('recent')}?`, options),
    ...pairedNouls(options, (option, desc) => ({
      instructions: `Is \`${option}\` (${desc}) the right kind of next step given ${ref('plan')} and ${ref('recent')}?`,
      criteria: {
        true: {
          definition: `the state of ${ref('plan.remaining')}, ${ref('recent')} and ${ref('workspace')} makes "${desc}" the step that moves the task forward now`,
          examples: pairedTrueExamples(option, ledger),
        },
        false: {
          definition: `"${desc}" would repeat work already shown in ${ref('recent')}, skip a prerequisite, or is not what ${ref('plan.remaining')} calls for now`,
          examples: pairedFalseExamples(option, ledger),
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

function pairedTrueExamples(option: string, ledger: boolean): string[] {
  switch (option) {
    case 'investigate':
      return ['the failing function has not been shown yet', 'the plan names a file no recent step has read'];
    case 'edit':
      return ledger
        ? ['`ledger.items` lists an open `fix … in …` item and `workspace.testsCurrent` is true (the last change, if any, has been verified)', 'a test in recent fails on one identifiable line and the plan lists its fix item']
        : ['the cause is known from a traceback and the file has been shown', 'a test in recent fails on one identifiable line'];
    case 'verify':
      return ledger
        ? ['the last step applied a patch and `workspace.testsCurrent` is false (no test run since)', 'the plan\'s remaining item is to verify the full test suite passes']
        : ['the last step edited a file and no test has run since', 'the plan\'s next item is to run the test suite'];
    case 'fix_environment':
      return ['recent shows ModuleNotFoundError for a required package', 'the test command is not found in the sandbox'];
    default:
      return ['every remaining item is done and the last test run passed with no changes since', 'the task asked for one change, it is applied and verified in recent'];
  }
}
function pairedFalseExamples(option: string, ledger: boolean): string[] {
  switch (option) {
    case 'investigate':
      return ledger
        ? ['the relevant file was shown two steps ago and nothing changed', '`ledger.items` names the failing tests and their files, so the cause is already localised']
        : ['the relevant file was shown two steps ago and nothing changed', 'the cause is already identified in the plan'];
    case 'edit':
      return ledger ? ['a patch was applied in the last step and the suite has not run since (verify first)', '`ledger.items` is empty: every fix item is done'] : ['no recent step shows the file to change', 'tests have not been run after the previous edit'];
    case 'verify':
      return ['tests already passed after the last change', 'nothing has changed since the last verification'];
    case 'fix_environment':
      return ['tests ran fine in recent', 'the failure is an assertion in the code, not a missing tool'];
    default:
      return ['remaining is non-empty', 'files changed after the last test run'];
  }
}

export interface LedgerResolutionInput {
  /** the plan carries fixed-form ledger items (jev-only) */
  ledgerOpen: boolean;
  /** code-computed: a change executed after the last parsed test run (state.ts commonChangeUnverified) */
  changeUnverified: boolean;
  /** jev-only mode: the plan is the synthesizer's ledger even once every item is fixed (default false) */
  jevOnly?: boolean;
  /** code-computed: the engine's last parsed test run passed everything and no file changed since (state.ts commonRunGreen) */
  runGreen?: boolean;
}

function choiceProbability(answers: Record<string, Answer>, choiceId: string, option: string): number {
  const a = answers[choiceId];
  if (!a || a.type !== 'choice') return 0;
  const p = a.probabilities[option];
  return typeof p === 'number' && Number.isFinite(p) ? p : 0;
}

function pairedNoul(answers: Record<string, Answer>, option: string): number {
  const a = answers[pairedId(option)];
  return a && a.type === 'noul' ? a.noul : 0;
}

/**
 * The jev-only ledger rule over a §6 Choice resolution. (0) In jev-only, a `fallback` whose raw
 * answer is `finish` with p >= LEDGER_CHOICE_FLOOR takes that answer when the engine's last test
 * run is green and current (`runGreen`): Jev's own argmax, tie broken by a harness fact. Otherwise
 * the resolution is returned unchanged unless `ledgerOpen`; then (1) a `fallback` whose raw answer
 * is `edit` or `verify` with p >= LEDGER_CHOICE_FLOOR takes that answer, and (2) an effective
 * `edit` while a change is unverified becomes `verify`. The verdict is `chosen` when the effective
 * option is Jev's own answer and `overridden` otherwise (the paired Noul row of the option is then
 * marked chosen by annotateChoiceRows, as for a §6 override).
 */
export function resolveIntentWithLedger(res: ChoiceResolution<Intent>, answers: Record<string, Answer>, input: LedgerResolutionInput): ChoiceResolution<Intent> {
  let option: Intent = res.option;
  let rescued = false;
  if (res.verdict === 'fallback' && res.answer === 'finish' && input.jevOnly === true && input.runGreen === true && choiceProbability(answers, 'intent', 'finish') >= LEDGER_CHOICE_FLOOR) {
    option = 'finish';
    rescued = true;
  } else if (!input.ledgerOpen) {
    return res;
  } else if (res.verdict === 'fallback' && (res.answer === 'edit' || res.answer === 'verify') && choiceProbability(answers, 'intent', res.answer) >= LEDGER_CHOICE_FLOOR) {
    option = res.answer;
    rescued = true;
  }
  if (input.ledgerOpen && option === 'edit' && input.changeUnverified) option = 'verify';
  if (!rescued && option === res.option) return res;
  const verdict: ChoiceVerdict = option === res.answer ? 'chosen' : 'overridden';
  return { option, verdict, answer: res.answer, probability: choiceProbability(answers, 'intent', option), pairedNoul: pairedNoul(answers, option) };
}

/**
 * contract 1.9 (Fastlane) §2.2 RL1: the intent the CODE picks, with no Jev answer at all — the order the step is
 * already executing when the router issues its ask. `INTENT_FALLBACK` (`investigate`) leads, except that a change
 * this run executed and never verified makes `verify` the step the harness itself would take next (the same fact
 * `resolveIntentWithLedger` uses, `state.ts commonChangeUnverified`).
 *
 * **One fact, and only one** (review 2026-09-22, defect 8). This took a `runGreen` and promised in prose that "a
 * green, current run demotes both"; the body never read it, so the caller computed and passed it for nothing and
 * the unimplemented half of the rule was untestable. The parameter and the sentence are gone rather than guessed
 * at: what a green run should lead with (`edit`? `finish`?) is a measurement for the §8 arms, not an invention
 * here, and `resolveIntentWithLedger` already reads `runGreen` where it has a rule for it.
 *
 * Pure, total, and sufficient alone: the stage runs on `codeIntentOrder()[0]` whenever Jev does not answer in time.
 */
export function codeIntentOrder(input: { changeUnverified: boolean }): readonly Intent[] {
  const rest = INTENT_LIST.filter((i) => i !== INTENT_FALLBACK && i !== 'verify');
  if (input.changeUnverified) return ['verify', INTENT_FALLBACK, ...rest];
  return [INTENT_FALLBACK, 'verify', ...rest];
}

/** what one intent ask produced: the resolution and the two Nouls the stage reads off the same request */
interface IntentAsked {
  resolved: ChoiceResolution<Intent>;
  planStillValid: number;
  confidence: number;
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

/** The ledger the stage reads: the fixed-form items of the accepted plan, only in jev-only mode. */
export function intentLedger(mode: EngineMode, common: JsonObject): string[] {
  return mode === 'jev-only' ? ledgerItems(commonRemaining(common)) : [];
}

export async function runIntentStage(ctx: StageContext, common: JsonObject): Promise<IntentStageResult> {
  const ledger = intentLedger(ctx.mode, common);
  const ledgerOpen = ledger.length > 0;
  const questions = buildIntentQuestions({ ledger: ledgerOpen });
  const state = buildIntentState(common, { mode: ctx.mode, ledger });
  const ledgerInput: LedgerResolutionInput = { ledgerOpen, changeUnverified: commonChangeUnverified(common), jevOnly: ctx.mode === 'jev-only', runGreen: commonRunGreen(common) };
  const resolve = (answers: Record<string, Answer>): ChoiceResolution<Intent> =>
    resolveIntentWithLedger(resolveChoice<Intent>({ choiceId: 'intent', answers, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK }), answers, ledgerInput);
  let resolved = resolve({});
  let planStillValid = 1;
  let confidence = 0;
  // the code answer, complete before any request is made: the stage can finish on this alone
  const codeAnswer: IntentAsked = { resolved, planStillValid, confidence };
  // I4 at the WRITE site: the step's own token, held from before the ask so a late answer can see that its step
  // has committed. Null on the routers-off path, where this callback is the pre-1.9 one, byte for byte.
  let routed: StepToken | null = null;
  const asked = async (signal?: AbortSignal): Promise<IntentAsked> => {
    let out: IntentAsked = codeAnswer;
    // jev-contract: RL1 intent (docs/LLM-LOOP-DESIGN.md §2.2)
    //   escape:   the Choice carries `none_of_these`; resolveChoice returns the escape as a non-answer and
    //             INTENT_FALLBACK stands.
    //   guard:    with routers on, routeSpeculative issues under the step signal with a 250 ms deadline and a
    //             step-scoped token (§2.6); the answer may only re-order the intent list, never add an option,
    //             and resolveIntentWithLedger still applies the code facts on top of it.
    //   fallback: codeIntentOrder()[0] (INTENT_FALLBACK = 'investigate', or `verify` when a change this run made is unverified) — test: test/unit/loop/router.test.ts
    //   no-gating: the answer reaches one sentence of the prompt's intent section and nothing else. It cannot
    //             stop the run, block an action, or withhold a candidate.
    await ctx.ask(
      'intent',
      state,
      questions,
      (answers, rows) => {
        // review 2026-09-22 defect 2: the router's signal, threaded. A dropped ask (deadline, committed token,
        // settled work) is CANCELLED by routeSpeculative, and a cancelled answer is not this step's answer: it
        // annotates nothing and applies nothing. The belt stays even though §7.5 seam (a) has landed and
        // `askRecorded` now abandons the call before this callback can run: the token check is the ONE drop the
        // signal cannot see (an answer arriving after commit under a signal nobody aborted).
        if (signal?.aborted === true || routed?.valid === false) return;
        const r = resolve(answers);
        annotateChoiceRows(rows, 'intent', r);
        const psv = answers['plan_still_valid'];
        const row = rows.find((q) => q.id === 'intent');
        out = { resolved: r, planStillValid: psv && psv.type === 'noul' ? psv.noul : 1, confidence: row ? row.confidence : 0 };
      },
      // §7.5 seam (a): the PER-CALL signal. A router that drops this ask aborts it, and `askRecorded` then
      // charges nothing, writes no `jev.jsonl` row and emits no `decision` — absent on the routers-off path,
      // where this argument is `undefined` and the call is the pre-1.9 one.
      signal,
    );
    return out;
  };
  if (!routersOn(ctx.mode, ctx.routers)) {
    const answered = await asked();
    resolved = answered.resolved;
    planStillValid = answered.planStillValid;
    confidence = answered.confidence;
  } else {
    // RL1: the code order is what the step runs; Jev's answer re-orders it when it lands inside the deadline
    const codeOrder = codeIntentOrder({ changeUnverified: ledgerInput.changeUnverified });
    const codeRoute: IntentAsked = { ...codeAnswer, resolved: { ...codeAnswer.resolved, option: codeOrder[0] ?? INTENT_FALLBACK } };
    routed = stepTokenFor(ctx.runId, ctx.step);
    const route = await routeSpeculative<IntentAsked>({
      id: 'RL1',
      token: routed,
      codeOrder: [codeRoute],
      deadlineMs: RL1_INTENT_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => [await asked(signal)],
    });
    noteStepRoute(ctx.runId, ctx.step, route);
    const chosen = route.order[0] ?? codeRoute;
    resolved = chosen.resolved;
    planStillValid = chosen.planStillValid;
    confidence = chosen.confidence;
  }
  const answer: IntentAnswer = resolved.answer === 'none_of_these' || (INTENT_LIST as readonly string[]).includes(resolved.answer) ? (resolved.answer as IntentAnswer) : 'none_of_these';
  ctx.emit({ type: 'intent', step: ctx.step, intent: resolved.option, answer, probability: resolved.probability, confidence, verdict: resolved.verdict });
  return { intent: resolved.option, answer, verdict: resolved.verdict, probability: resolved.probability, confidence, pairedNoul: resolved.pairedNoul, planStillValid };
}
