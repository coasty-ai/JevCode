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
import { routeSpeculative, type StepToken } from '../../jev/router.js';
import { RL6_REPLAN_DEADLINE_MS, noteStepRoute, routersOn, stepTokenFor } from '../routers.js';
import type { ChoiceVerdict, EngineMode, JsonObject, Question, ReplanDirective, ReplanMove } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { REFUSED_RESULT, describeSignatureKind, directiveMove, signatureKind, type LoopDetector } from '../loopdetect.js';
import { buildReplanState } from '../state.js';
import { annotateChoiceRows, resolveChoice, type ChoiceResolution } from './choose.js';

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

/** what one replan request produced: the resolution and the two numbers the directive carries */
interface ReplanAsked {
  resolved: ChoiceResolution<ReplanOption>;
  taskImpossible: number;
  confidence: number;
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

/**
 * Change 9 (OOS iteration 2, from the iteration-1 records): the run does not END on a completion
 * claim the harness itself refused, before the search's own rung has been climbed.
 *
 * Evidence. All four fresh SWE runs of `bench/results/iter1-fresh-llm-jev-swebench` stop
 * `replan_stop` at step 5 of a 25-step budget. On `runs/20260922-120654-pwk7v3bn` steps 3, 4 and
 * 5 are one and the same `done` proposal — signature `done:a38c40c21f99`, `outcome: "noop"`,
 * `notes: ["done rejected: no passing, current run verifies it"]`, `timing.synthMs` 0.28 ms — so
 * three steps ran nothing, proposed nothing and changed nothing; the trip then answers
 * `stop_and_report` (p 0.44–0.61) and the run ends with 20 steps unspent, 1,735 of the step's
 * 1,740 priced candidates never run and 0 of 7 generator samples served. `django__django-15128`
 * (`20260922-124457-mo7wd5un`, the only in-sample regression against the frozen `066816f`) is the
 * same shape through engine.ts `repeatedGatherContextExit`: steps 2–7 are one refused `done`
 * (`done:b8ee1f6c9667`) and `gather_context` twice.
 *
 * The rule, on facts the detector already holds and with no constant, no threshold and no task
 * name: a `done:` signature IS a completion claim the harness refused — an accepted one ends the
 * run — so its repetition is evidence about the proposer/completion handshake, not about the
 * search being spent. The search has exactly one rung above where it stands (`PHASE_ESCALATION`,
 * search/directive.ts `change_approach`), so the first trip that would otherwise END the run on
 * such a signature — the `stop_and_report` move, or a move this stage has already directed once
 * for this very signature, which is the engine's exit — climbs that rung instead. Once the rung
 * has been directed for this signature the stop is the honest end, which keeps the ladder finite
 * (escalate, then stop) exactly as change 7's does for a `run:` signature.
 */
export function doneClaimEscalation(i: Pick<GatherContextRepeatInput, 'signature' | 'move' | 'priorDirectives'>): GatherContextEscalation | null {
  if (signatureKind(i.signature) !== 'done') return null;
  // the two ways this stage ends a run on a refused completion claim: the stop move itself, and a
  // directive already given for this signature (engine.ts `repeatedGatherContextExit`)
  const repeated = i.priorDirectives.some((d) => directiveMove(d.directive) === i.move);
  if (i.move !== 'stop_and_report' && !repeated) return null;
  const escalated = i.priorDirectives.filter((d) => d.directive.includes(PHASE_ESCALATION));
  if (escalated.length === 0) return { kind: 'escalate' };
  return {
    kind: 'stop',
    reason: `the completion claim ${i.signature} repeated after escalating ${PHASE_ESCALATION} at step ${escalated.map((d) => d.step).join(', ')}; the search has no phase left to escalate and the harness will not accept the claim`,
  };
}

/**
 * The `change_approach` directive that escalates the phase: parsed as `change_approach` by both
 * search/directive.ts and loopdetect.ts `directiveMove`. Change 9's ladder reaches it with an
 * empty `gatheredAt` (a refused completion claim that was never directed to gather), so the
 * wording names what actually repeated rather than a gather that did not happen — and
 * `change_approach` is the only move that reopens a goal the best-guess search parked
 * (search/directive.ts: `gather_context` leaves that park in place), which is why it is the rung.
 */
export function escalationDirectiveText(probability: number, signature: string, gatheredAt: readonly number[]): string {
  const kind = describeSignatureKind(signatureKind(signature));
  const after = gatheredAt.length > 0 ? `with gather_context already directed at step ${gatheredAt.join(', ')} and the output unchanged` : 'with nothing proposed in between';
  return `After repeating the same ${kind} 3 times ${after}, Jev directs \`change_approach\` (p=${probability.toFixed(2)}, escalation=${PHASE_ESCALATION}): escalate the search phase ${PHASE_ESCALATION} — rotate the goal's source order, reopen every parked goal, widen the site beam and allow the WIDENED phase, instead of repeating a step that has not moved.`;
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
  const codeAnswer: ReplanAsked = { resolved, taskImpossible: 0, confidence: 0 };
  // I4 at the WRITE site: the step's own token, held from before the ask so a late answer can see that its step
  // has committed. Null on the routers-off path, where this callback is the pre-1.9 one, byte for byte.
  let routed: StepToken | null = null;
  const asked = async (signal?: AbortSignal): Promise<ReplanAsked> => {
    let out: ReplanAsked = codeAnswer;
    // jev-contract: RL6 next_move (docs/LLM-LOOP-DESIGN.md §2.2, §2.5)
    //   escape:   the Choice carries `none_of_these`; resolveChoice returns the escape as a non-answer.
    //   guard:    with routers on the ask is issued through routeSpeculative under the step signal with a 500 ms
    //             deadline and a step-scoped token, the answer supplies the DIRECTIVE only, and the two Jev-decided
    //             run-enders (`stop_and_report`, `task_impossible`) are recorded-only — the escalation ladder of
    //             changes 7 and 9, which is code over the detector's own history, still ends a spent run.
    //   fallback: REPLAN_FALLBACK = 'change_approach', the move the stage already resolves to when the Choice is escaped or absent — test: test/unit/loop/router.test.ts
    //   no-gating: with routers on a dropped answer continues the run on the code directive; it can never end one.
    await ctx.ask('replan', state, buildReplanQuestions({ taskImpossible: askImpossible }), (answers, rows) => {
    // review 2026-09-22 defect 2: the router's signal, threaded. A dropped ask (deadline, committed token, settled
    // work) is CANCELLED by routeSpeculative, and a cancelled answer is not this step's answer: it annotates
    // nothing and applies nothing. `ctx.ask` still takes no per-call signal — that is the `askRecorded` seam of
    // §7.5, slot B's post-C commit — so the request itself runs on; what it may no longer do is write a verdict.
      if (signal?.aborted === true || routed?.valid === false) return;
      const r = resolveChoice<ReplanOption>({ choiceId: 'next_move', answers, options: REPLAN_LIST, escape: 'none_of_these', fallback: REPLAN_FALLBACK });
      annotateChoiceRows(rows, 'next_move', r);
      const ti = answers['task_impossible'];
      out = { resolved: r, taskImpossible: ti && ti.type === 'noul' ? ti.noul : 0, confidence: rows.find((q) => q.id === 'next_move')?.confidence ?? 0 };
    });
    return out;
  };
  const routers = routersOn(ctx.mode);
  if (!routers) {
    const a = await asked();
    resolved = a.resolved;
    taskImpossible = a.taskImpossible;
    confidence = a.confidence;
  } else {
    routed = stepTokenFor(ctx.runId, ctx.step);
    const route = await routeSpeculative<ReplanAsked>({
      id: 'RL6',
      token: routed,
      codeOrder: [codeAnswer],
      deadlineMs: RL6_REPLAN_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => [await asked(signal)],
    });
    noteStepRoute(ctx.runId, ctx.step, route);
    const a = route.order[0] ?? codeAnswer;
    resolved = a.resolved;
    taskImpossible = a.taskImpossible;
    confidence = a.confidence;
  }
  const move: ReplanMove = resolved.option;
  const directive: ReplanDirective = { move, probability: resolved.probability, confidence, taskImpossible, text: directiveText(resolved.verdict === 'fallback' ? 'none_of_these' : move, resolved.verdict, resolved.probability, taskImpossible, signature) };
  // §2.5 RL6: with routers on, `task_impossible` is recorded and no longer ends the run — the step cap, the wall
  // cap and the code loop detector are the run's stops.
  if (!routers && askImpossible && taskImpossible >= ctx.limits.impossibleThreshold) return { kind: 'stop', reason: 'impossible', directive };
  // changes 7 and 9: the escalation ladder, off the detector's own signature and directive history
  // (never a constant, never a task name). It runs BEFORE the `stop_and_report` exit below because
  // change 9's whole subject is a stop move on a refused completion claim; a `run:` signature and
  // every non-synth mode reach that exit unchanged (`doneClaimEscalation` answers null for both).
  const escalation = synthProposes(ctx.mode) ? (gatherContextEscalation({ signature, move, priorDirectives, lastOutcomes }) ?? doneClaimEscalation({ signature, move, priorDirectives })) : null;
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
  if (move === 'stop_and_report') {
    // §2.5 RL6: recorded-only with routers on. The move stays in the record and in the directive text; what it no
    // longer does is end a run with 20 of 25 steps unspent (the iteration-1 shape: every llm-jev SWE run stopped
    // at step 5). The escalation ladder above still stops a run whose search has no rung left to climb.
    if (!routers) return { kind: 'stop', reason: 'replan_stop', directive };
    const continued: ReplanDirective = { ...directive, move: REPLAN_FALLBACK, text: `${directive.text} (recorded only: contract 1.9 §2.5 — Jev does not end the run; continuing with \`${REPLAN_FALLBACK}\`)` };
    ctx.emit({ type: 'replan', step: ctx.step, directive: continued });
    return { kind: 'directive', directive: continued };
  }
  ctx.emit({ type: 'replan', step: ctx.step, directive });
  return { kind: 'directive', directive };
}
