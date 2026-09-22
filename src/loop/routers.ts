/**
 * The loop's side of the router table (docs/LLM-LOOP-DESIGN.md §2, contract 1.9 "Fastlane" S4).
 *
 * `src/jev/router.ts` owns the primitive; this module owns the three things the loop stages need and the engine
 * will read: whether routers are on at all, the per-step token of I4, and the per-step ledger that becomes
 * `StepRecord.router`.
 *
 * **Default off.** `routersOn()` is false unless `EngineOptions.routers === 'on'` or `JEVCODE_ROUTERS=on`, so
 * every stage below takes exactly the path it took before contract 1.9 and invariant I2 (byte identity when off)
 * holds by construction rather than by inspection: the new code is entered from one `if` per stage, all false.
 *
 * **The token and the ledger are per (runId, step).** A stage asks for them by name, so the six stages of one
 * step share one token and one ledger without the engine having to thread anything through `StageContext`.
 * `commitStepRouters(runId, step)` is the engine seam of §2.6 and §5.2: called in the same `finally` that writes
 * the `StepRecord`, it invalidates the token (no router answer may be applied to a committed step) and returns
 * the step's rows. Until that call lands in `src/loop/engine.ts` (slot B's post-C commit, §7.1: no two slots hold
 * `engine.ts` at once) the token is invalidated by the next step's mint, which bounds a late write to one step.
 */
import { createStepToken, emptyRouterLedger, invalidateStepToken, noteRoute, routersEnabled, type RouteResult, type RouterLedger, type StepToken } from '../jev/router.js';

/** §2.2 per-site deadlines. Each is the wall a site may wait for Jev before the code order stands. */
export const RL1_INTENT_DEADLINE_MS = 250;
export const RL2_CONTEXT_DEADLINE_MS = 400;
export const RL4_JUDGE_DEADLINE_MS = 400;
export const RL6_REPLAN_DEADLINE_MS = 500;

/** §0.3: `EngineOptions.routers`, with the `JEVCODE_ROUTERS` override read here, inside `src/loop`. */
export function routersOn(opt?: 'on' | 'off'): boolean {
  return routersEnabled(opt);
}

interface StepRouterState {
  token: StepToken;
  ledger: RouterLedger;
}

/** Two steps of live state is all any stage needs; a third mint retires the oldest (and invalidates its token). */
const MAX_LIVE_STEPS = 2;
const live = new Map<string, StepRouterState>();

function keyOf(runId: string, step: number): string {
  return `${runId}:${step}`;
}

function stateFor(runId: string, step: number): StepRouterState {
  const key = keyOf(runId, step);
  const found = live.get(key);
  if (found !== undefined) return found;
  const made: StepRouterState = { token: createStepToken(step), ledger: emptyRouterLedger() };
  live.set(key, made);
  while (live.size > MAX_LIVE_STEPS) {
    const oldest = live.keys().next();
    if (oldest.done === true) break;
    const dropped = live.get(oldest.value);
    if (dropped !== undefined) invalidateStepToken(dropped.token);
    live.delete(oldest.value);
  }
  return made;
}

/** §2.6: the step-scoped token an in-flight answer is checked against before it may be applied. */
export function stepTokenFor(runId: string, step: number): StepToken {
  return stateFor(runId, step).token;
}

/** Fold one route's outcome into this step's `StepRecord.router` rows. */
export function noteStepRoute<T>(runId: string, step: number, r: RouteResult<T>): void {
  noteRoute(stateFor(runId, step).ledger, r);
}

/**
 * The engine seam (§2.6, §5.2): invalidate the step's token and take its rows. Returns null when no router ran,
 * which is every step of every run with `routers: 'off'` — so the member stays absent and the record is
 * byte-identical.
 */
export function commitStepRouters(runId: string, step: number): RouterLedger | null {
  const key = keyOf(runId, step);
  const state = live.get(key);
  if (state === undefined) return null;
  invalidateStepToken(state.token);
  live.delete(key);
  return state.ledger.issued === 0 ? null : state.ledger;
}

/** Tests only: forget every live step. */
export function resetStepRouters(): void {
  live.clear();
}
