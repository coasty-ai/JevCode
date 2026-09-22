/**
 * Replan stage (DESIGN.md §5.5 replan, §6): after a loop trip, one request with the
 * `next_move` Choice, its paired Nouls and `task_impossible`; Choice resolution with
 * fallback `change_approach`; `stop_and_report` -> replan_stop; task_impossible above the
 * threshold -> impossible regardless of the move.
 *
 * Out-of-sample iteration 1 (docs/research/llm-jev/oos-analysis-2026-09-22.md Q2(d), changes 6
 * and 7), both on the synth path only:
 *
 * - `task_impossible` is not asked when the Synthesizer proposes (`synthProposes`). Over the
 *   whole 44-run slice it was asked 39 times and returned ONE distinct answer: there is no state
 *   in which it discriminates, because the synthesizer answers "impossible" structurally — it
 *   parks the goal and the controller proposes the honest partial `done`. Not asking it makes
 *   `taskImpossible` 0, and the `impossible` stop cannot fire from this stage (the threshold is
 *   only compared when the question was asked). The jev-on wiring is untouched.
 * - `gather_context` is not directed twice for one `run:` signature (`gatherContextEscalation`).
 *   33 of 39 `next_move` answers were `gather_context` and the next step re-ran the same pytest
 *   with unchanged output every time: crossfile `20260922-054652-dcxbrltg` steps 1-10 and 14-17,
 *   six_hunks `20260922-061926-da3ho35c` steps 1-7 and 11-12 — 20 and 12 steps in which no patch
 *   was ever proposed. A `run:` signature IS "the same command with the same output"
 *   (loopdetect.ts computeSignatures hashes the command and the exit code + normalised output
 *   separately), so a second trip of one such signature after a `gather_context` directive is
 *   that loop by construction, with no constant and no task name in the rule.
 */
import { choice, noul, pairedNouls, ref } from '../../jev/questions.js';
import type { ChoiceVerdict, EngineMode, JsonObject, Question, ReplanDirective, ReplanMove } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { REFUSED_RESULT, describeSignatureKind, directiveMove, signatureKind, type LoopDetector } from '../loopdetect.js';
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

/**
 * Change 6(a): the modes in which the Synthesizer proposes (engine.ts refuses to start either
 * without one), i.e. the synth path. `task_impossible` is Jev's judgement of a *task statement*;
 * on this path the statement is a ledger of failing tests the search either fixes or parks, so
 * the question has nothing left to discriminate — 39 askings, one distinct answer.
 */
export function synthProposes(mode: EngineMode): boolean {
  return mode === 'jev-only' || mode === 'llm-jev';
}

export interface ReplanQuestionOptions {
  /** ask `task_impossible` (default true: the jev-on wiring is byte-identical) */
  taskImpossible?: boolean;
}

export function buildReplanQuestions(opts: ReplanQuestionOptions = {}): Record<string, Question> {
  const qs: Record<string, Question> = {
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
  };
  if (opts.taskImpossible === false) return qs;
  qs['task_impossible'] = noul(`Is ${ref('task')} impossible in this workspace as stated?`, {
    true: {
      definition: 'the task requires something the workspace, sandbox or task statement rules out: a missing service or credential, a contradiction in the task, a dependency that cannot be installed here, or code that does not exist',
      examples: ['the task asks to fix a module that is not in the repository and cannot be created from the description', 'every attempt fails because a network service the tests need is denied by the sandbox', 'the task asks for behaviour that contradicts its own constraint'],
    },
    false: {
      definition: 'the task is feasible and the loop is a wrong approach, missing context or an environment fix the engineer can make',
      examples: ['the edit keeps failing on `old` not matching but the file exists and can be read', 'the tests fail on an assertion the engineer has not yet addressed', 'a dependency is missing but pip can install it'],
    },
  });
  return qs;
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

// ---------------------------------------------------------------------------------------
// Change 7: the gather_context loop on one `run:` signature
// ---------------------------------------------------------------------------------------

/**
 * The marker the escalation directive carries, and the test `gatherContextEscalation` applies to
 * the stored history: the search has exactly two rungs above a re-localisation (search/directive.ts
 * `change_approach`: rotate the source order, widen the site beam DEFAULT_SITE_BEAM → WIDENED_SITE_BEAM
 * and allow the WIDENED phase over the beam functions), so once both `gather_context` and this
 * escalation have been directed for one signature there is no third rung to climb.
 */
export const PHASE_ESCALATION = 'SEEDS → SKETCH/WIDENED';

export interface GatherContextRepeatInput {
  /** the tripped signature (loopdetect.ts) */
  signature: string;
  /** the move Jev resolved this trip */
  move: ReplanMove;
  /** `detector.priorDirectives(signature)`: what was directed for THIS signature before */
  priorDirectives: readonly { step: number; directive: string }[];
  /** `window.map((w) => w.outcome)`: the statuses of the recent steps */
  lastOutcomes: readonly (string | null)[];
}

export type GatherContextEscalation = { kind: 'escalate' } | { kind: 'stop'; reason: string };

/**
 * Change 7 (oos-analysis-2026-09-22.md Q3): `gather_context` directed a second time for the same
 * `run:` signature is the crossfile / six_hunks loop, and the rule is structural on three facts
 * already in the detector, with no constant and no task name:
 *
 *  1. the trip is a `run:` signature whose result part is a real execution, not `refused` — that
 *     signature is `run:<hash of the command>:<hash of exitCode + normalised output>`
 *     (loopdetect.ts computeSignatures), so its recurrence IS the same command producing the same
 *     output; a patch proposed in between that changed anything would have changed the output hash
 *     and with it the signature, so "no patch was proposed in between" is implied, not assumed;
 *  2. the window shows that repetition executing (`lastOutcomes` contains `executed`), so this is a
 *     command that ran, not a proposal the reviewer kept refusing (which context can still fix);
 *  3. `priorDirectives` for this very signature already names `gather_context`.
 *
 * Then: escalate the search phase once (`change_approach`, which is the SEEDS → SKETCH/WIDENED
 * rung in search/directive.ts), and if that rung was already directed for this signature, stop
 * with a named reason. The consequence asserted by the tests: one `run:` signature is never
 * directed to gather context twice, so the same command is never re-run a third time under a
 * replan with nothing proposed in between.
 */
export function gatherContextEscalation(i: GatherContextRepeatInput): GatherContextEscalation | null {
  if (i.move !== 'gather_context') return null;
  if (signatureKind(i.signature) !== 'run' || i.signature.endsWith(`:${REFUSED_RESULT}`)) return null;
  if (!i.lastOutcomes.includes('executed')) return null;
  const gathered = i.priorDirectives.filter((d) => directiveMove(d.directive) === 'gather_context');
  if (gathered.length === 0) return null;
  const escalated = i.priorDirectives.filter((d) => d.directive.includes(PHASE_ESCALATION));
  if (escalated.length === 0) return { kind: 'escalate' };
  return {
    kind: 'stop',
    reason: `gather_context directed again for ${i.signature} after gathering at step ${gathered.map((d) => d.step).join(', ')} and escalating ${PHASE_ESCALATION} at step ${escalated.map((d) => d.step).join(', ')}; the same command still runs with unchanged output and no phase is left to escalate`,
  };
}

/** The `change_approach` directive that escalates the phase: parsed as `change_approach` by both search/directive.ts and loopdetect.ts `directiveMove`. */
export function escalationDirectiveText(probability: number, signature: string, gatheredAt: readonly number[]): string {
  const kind = describeSignatureKind(signatureKind(signature));
  return `After repeating the same ${kind} 3 times with gather_context already directed at step ${gatheredAt.join(', ')} and the output unchanged, Jev directs \`change_approach\` (p=${probability.toFixed(2)}, escalation=${PHASE_ESCALATION}): escalate the search phase ${PHASE_ESCALATION} — rotate the goal's source order, widen the site beam and allow the WIDENED phase, instead of reading again for a command whose output has not moved.`;
}

/** The `stop_and_report` directive of the exhausted escalation ladder (change 7). */
export function escalationStopText(probability: number, reason: string): string {
  return `Jev directs \`stop_and_report\` (p=${probability.toFixed(2)}): ${reason}.`;
}

export async function runReplanStage(ctx: StageContext, common: JsonObject, detector: LoopDetector, lastOutcomes: readonly (string | null)[]): Promise<ReplanOutcome> {
  const signature = detector.trippedSignature() ?? 'unknown';
  const priorDirectives = detector.priorDirectives(signature);
  const state = buildReplanState(common, {
    signature,
    kind: signatureKind(signature),
    occurrences: 3,
    lastOutcomes,
    trips: detector.trips(signature),
    priorDirectives,
  });
  let resolved = resolveChoice<ReplanOption>({ choiceId: 'next_move', answers: {}, options: REPLAN_LIST, escape: 'none_of_these', fallback: REPLAN_FALLBACK });
  let taskImpossible = 0;
  let confidence = 0;
  // change 6(a): on the synth path the Noul is not asked, so `taskImpossible` stays 0 and the
  // `impossible` stop below cannot fire from this stage whatever the configured threshold is
  const askImpossible = !synthProposes(ctx.mode);
  await ctx.ask('replan', state, buildReplanQuestions({ taskImpossible: askImpossible }), (answers, rows) => {
    resolved = resolveChoice<ReplanOption>({ choiceId: 'next_move', answers, options: REPLAN_LIST, escape: 'none_of_these', fallback: REPLAN_FALLBACK });
    annotateChoiceRows(rows, 'next_move', resolved);
    const ti = answers['task_impossible'];
    taskImpossible = ti && ti.type === 'noul' ? ti.noul : 0;
    confidence = rows.find((r) => r.id === 'next_move')?.confidence ?? 0;
  });
  const move: ReplanMove = resolved.option;
  const directive: ReplanDirective = { move, probability: resolved.probability, confidence, taskImpossible, text: directiveText(resolved.verdict === 'fallback' ? 'none_of_these' : move, resolved.verdict, resolved.probability, taskImpossible, signature) };
  if (askImpossible && taskImpossible >= ctx.limits.impossibleThreshold) return { kind: 'stop', reason: 'impossible', directive };
  if (move === 'stop_and_report') return { kind: 'stop', reason: 'replan_stop', directive };
  // change 7: the repeat is off the detector's own signature and directive history (never a constant, never a task name)
  if (synthProposes(ctx.mode)) {
    const escalation = gatherContextEscalation({ signature, move, priorDirectives, lastOutcomes });
    if (escalation !== null && escalation.kind === 'stop') {
      const stop: ReplanDirective = { ...directive, move: 'stop_and_report', text: escalationStopText(resolved.probability, escalation.reason) };
      return { kind: 'stop', reason: 'replan_stop', directive: stop };
    }
    if (escalation !== null) {
      const gatheredAt = priorDirectives.filter((d) => directiveMove(d.directive) === 'gather_context').map((d) => d.step);
      const escalated: ReplanDirective = { ...directive, move: 'change_approach', text: escalationDirectiveText(resolved.probability, signature, gatheredAt) };
      ctx.emit({ type: 'replan', step: ctx.step, directive: escalated });
      return { kind: 'directive', directive: escalated };
    }
  }
  ctx.emit({ type: 'replan', step: ctx.step, directive });
  return { kind: 'directive', directive };
}
