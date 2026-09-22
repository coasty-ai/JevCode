/**
 * Speculative routers (docs/LLM-LOOP-DESIGN.md §2, contract 1.9 "Fastlane" S4).
 *
 * The one primitive every routed Jev ask in the loop goes through. Its whole subject is invariant **I1**:
 * *Jev routes, it never gates* — after this wave no Jev answer on the loop can end a run, block an action or
 * withhold a candidate, so a full Jev outage costs ordering quality and nothing else.
 *
 * Semantics, in the order §2.1 states them:
 *
 *  1. `dispatch(codeOrder[0])` runs **before anything is awaited**. The code order is not a fallback reached after
 *     a failure; it is the order the step is already executing.
 *  2. `ask` is issued in the same tick, under a controller linked to the step signal (`linkedAbort`).
 *  3. An answer landing inside `deadlineMs`, before the dispatched work settles, and **while `token.valid`**, is
 *     applied — it re-orders the pending tail only.
 *  4. A deadline, a `JevError`, a 503/529, an invalidated token and a malformed answer are **one branch**:
 *     `dropped: true`, the code order stands, nothing is thrown. That single failure branch is what makes "a Jev
 *     outage is slower, never wrong" a structural property rather than a per-site promise. **It is Jev's failures
 *     only** (review 2026-09-22, defect 5): the step signal aborting (a human pause, `/stop`), a wall-time
 *     `BudgetError`, a `JevModelDriftError` and a `QuestionBuildError` are the harness's own stop conditions and a
 *     programming error, not an outage — `isRouterFatal` sends them back up unchanged, exactly as they travel with
 *     routers off. Swallowing them is how an aborted run keeps running stages.
 *  5. The thunk is injected: `ask` is the stage's own `ctx.ask`, which already routes through the engine's one
 *     metered, recorded path (`askRecorded`). No router reaches the decider by any other road.
 *  6. A dropped ask is **cancelled**: the router aborts the linked controller whose signal it handed the thunk, so
 *     an ask nobody is waiting on stops rather than running on to write against a committed step.
 *
 * **I3, `waitMs`, and what it means here.** The ask is still made, still metered, still written to `jev.jsonl`;
 * `jevMs` may grow. `routerWaitMs` is the wall the router holds the step for *beyond* that ask, and it is
 * **measured, not asserted**: `heldMs` is the clock from entry to the settled race and `waitMs` is what is left of
 * it after the ask's own elapsed time. It reads 0 because the router never waits past the earliest of {the answer,
 * the deadline, the dispatched work, the step signal} — but a router that did wait longer would report it, which a
 * hard-coded `0` never could (review 2026-09-22, defect 7). The deadline can only make a step wait **less** than
 * today's inline await, never more. (The remaining half of I3 — overlapping the ask with the next stage's work so
 * that even the sub-deadline wall disappears — is the engine's `askRecorded` seam, §7.5, and lands with it.)
 *
 * **I4, no late APPLICATION.** Application is guarded by a step-scoped `StepToken` invalidated at step commit: a
 * late answer is recorded `dropped` and applied to nothing, and its ask is aborted (clause 6). What the router
 * alone cannot yet promise is that the *engine* writes nothing late: `ctx.ask` takes no per-call signal until the
 * `askRecorded` seam of §7.5 lands (slot B's post-C commit, §7.1 — no two slots hold `engine.ts` at once), so
 * until then a decider that ignores its signal can still finish inside `askRecorded` and charge its own step.
 */
import { linkedAbort } from '../core/abort.js';
import { AbortError, JevModelDriftError, isAbortError, isBudgetError } from '../errors.js';
import { QuestionBuildError } from './questions.js';

/**
 * §2.1 clause 4 is about **Jev's** failures. These four are not Jev's: an aborted step signal (a human pause,
 * `/stop`, an operator signal), an exhausted budget, a served model that is not the pinned one, and a malformed
 * question batch. With routers off each of them rejects the stage; with routers on each must still reject it,
 * or a paused, over-budget or mis-served run keeps executing stages (review 2026-09-22, defect 5).
 */
export function isRouterFatal(e: unknown): boolean {
  return isAbortError(e) || isBudgetError(e) || e instanceof JevModelDriftError || e instanceof QuestionBuildError;
}

/** §2.1: the default router deadline. Measured Jev latency is p50 237 ms / p95 547 ms, so 400 ms keeps the median answer and drops the tail. */
export const ROUTER_DEADLINE_MS = 400;

/**
 * The scheduling hop between the ask's promise settling and the race result being observed — one microtask under
 * whatever else the event loop is running, made visible at all by `Date.now()`'s 1 ms granularity. It is the
 * scheduler's wall, not the router's, so `waitMs` (I3) does not count it; anything above it is the router
 * genuinely holding the step past its own ask, and is reported. Kept small enough that a real extra await (the
 * bug I3 exists to catch: 250 ms and up at these deadlines) can never hide inside it.
 */
export const ROUTER_SETTLE_SLACK_MS = 5;

/** §2.2, the router table. `RL3` and `RS5` are deliberately absent: they are gates, not routers. */
export type RouterId = 'RL1' | 'RL2' | 'RL4' | 'RL5' | 'RL6' | 'RS1' | 'RS2' | 'RS3' | 'RS4' | 'R9';

/** §2.6: minted per step by the engine, invalidated at step commit in the same `finally` that writes the `StepRecord`. */
export interface StepToken {
  readonly step: number;
  valid: boolean;
}

export function createStepToken(step: number): StepToken {
  return { step, valid: true };
}

/** Step commit. After this call no router answer may be applied; late answers are recorded `dropped`. */
export function invalidateStepToken(token: StepToken): void {
  token.valid = false;
}

/** Why a route did not take Jev's answer. Recorded, never thrown. */
export type RouteDrop = 'deadline' | 'error' | 'aborted' | 'committed' | 'empty' | 'work_settled' | 'off';

export interface RouteResult<T> {
  /** the order the caller must execute: Jev's when applied, the code order otherwise */
  readonly order: readonly T[];
  readonly source: 'jev' | 'code';
  /** the clock reading at which Jev's answer was applied, or null */
  readonly appliedAt: number | null;
  readonly dropped: boolean;
  readonly id: RouterId;
  /** I3, MEASURED: the wall the router held the step BEYOND the ask it was making anyway (`heldMs` minus the ask's own elapsed time). 0 on every path that is not a bug. */
  readonly waitMs: number;
  /** the raw wall from entry to the settled race — the ceiling the deadline puts on a slow ask, and what makes `waitMs` falsifiable */
  readonly heldMs: number;
  /** null when the answer was applied */
  readonly drop: RouteDrop | null;
}

export interface RouteInput<T> {
  readonly id: RouterId;
  /** I4: invalidated at step commit */
  readonly token: StepToken;
  /** non-empty, and sufficient alone — the step runs on this whatever Jev does */
  readonly codeOrder: readonly T[];
  /** called in THIS tick, before any await; a returned promise ends the race when it settles */
  readonly dispatch?: (item: T) => Promise<unknown> | void;
  /** the stage's own `ctx.ask`, wrapped to return the order Jev proposes (or null for "no opinion") */
  readonly ask: (signal: AbortSignal) => Promise<readonly T[] | null>;
  readonly deadlineMs?: number;
  /** the step signal; the ask is issued under a controller linked to it */
  readonly signal?: AbortSignal;
  /** injected clock (tests); defaults to Date.now */
  readonly now?: () => number;
}

function isPromise(v: unknown): v is Promise<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

type Settled<T> = { kind: 'answer'; order: readonly T[] | null } | { kind: 'error'; error: unknown } | { kind: 'deadline' } | { kind: 'work' } | { kind: 'aborted' };

/** The reason a step signal carries, as something throwable: an `AbortError` travels unchanged, anything else becomes one. */
function abortReasonOf(signal: AbortSignal): unknown {
  const r: unknown = signal.reason;
  return isAbortError(r) || r instanceof Error ? r : new AbortError('signal');
}

/**
 * Route one ask. **No failure of Jev's throws or rejects**: a deadline, a `JevError`, a 503/529, an invalidated
 * token and a malformed answer are the one drop branch of clause 4. The four failures that are not Jev's —
 * an aborted step signal, a budget, a model drift, a malformed question batch — are rethrown unchanged
 * (`isRouterFatal`), because with routers off they reject the stage and a router may not quietly change that.
 *
 * The returned `order` is what the caller executes. `order[0]` is `codeOrder[0]` unless Jev answered in time and
 * the token was still valid, in which case it is Jev's — and even then the caller is free to ignore it, because
 * nothing here decides anything: it orders.
 */
export async function routeSpeculative<T>(input: RouteInput<T>): Promise<RouteResult<T>> {
  const { id, token, codeOrder } = input;
  if (codeOrder.length === 0) throw new RangeError(`routeSpeculative(${id}): codeOrder must be non-empty — the code order is the step, not a fallback`);
  // a step that is already over runs no code order and issues no ask — exactly what ctx.ask does with routers off
  if (input.signal?.aborted === true) throw abortReasonOf(input.signal);
  const now = input.now ?? Date.now;
  const deadlineMs = Math.max(0, input.deadlineMs ?? ROUTER_DEADLINE_MS);
  const t0 = now();
  // I3, measured: the ask's own elapsed time, so `waitMs` is the wall the ROUTER added and not the wall the step
  // was spending anyway. Null while the ask is still in flight — then the router held the step for less than the
  // ask, and the difference is 0.
  let askDoneAt: number | null = null;
  const held = (): { heldMs: number; waitMs: number } => {
    const heldMs = Math.max(0, now() - t0);
    const askMs = askDoneAt === null ? heldMs : Math.max(0, askDoneAt - t0);
    return { heldMs, waitMs: Math.max(0, heldMs - askMs - ROUTER_SETTLE_SLACK_MS) };
  };
  const code = (drop: RouteDrop): RouteResult<T> => ({ order: codeOrder, source: 'code', appliedAt: null, dropped: true, id, ...held(), drop });

  // clause 1: the code order is dispatched in THIS tick, before anything is awaited
  let work: Promise<unknown> | null = null;
  if (input.dispatch !== undefined) {
    try {
      const d = input.dispatch(codeOrder[0]!);
      work = isPromise(d) ? d.catch(() => undefined) : null;
    } catch {
      work = null;
    }
  }

  // clause 2: issued in the same tick under a controller linked to the step signal
  const link = input.signal !== undefined ? linkedAbort(input.signal) : { controller: new AbortController(), unlink: (): void => undefined };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const races: Promise<Settled<T>>[] = [];
  races.push(
    (async (): Promise<Settled<T>> => {
      try {
        const order = await input.ask(link.controller.signal);
        askDoneAt = now();
        return { kind: 'answer', order };
      } catch (e) {
        askDoneAt = now();
        // clause 4: a JevError, a 503/529 and a malformed answer are ONE branch. The error is CARRIED, not
        // swallowed here, so the settle below can send the four non-Jev failures back up (clause 4, defect 5) —
        // and carrying it instead of rethrowing keeps this promise settled even when the race is already over.
        return { kind: 'error', error: e };
      }
    })(),
  );
  races.push(
    new Promise<Settled<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'deadline' }), deadlineMs);
      // never hold the process open for a router
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  );
  if (work !== null) races.push(work.then((): Settled<T> => ({ kind: 'work' })));
  // review 2026-09-22 defect 1: the listener is HELD and removed in the same finally as the timer and the link.
  // One per routed ask, never removed, is ~120 live listeners on a run-scoped signal by step 40 — past Node's
  // max-listeners warning, each retaining a race promise that never settles.
  const stepSignal = input.signal;
  let onStepAbort: (() => void) | null = null;
  if (stepSignal !== undefined) {
    if (stepSignal.aborted) races.push(Promise.resolve<Settled<T>>({ kind: 'aborted' }));
    else {
      races.push(
        new Promise<Settled<T>>((resolve) => {
          onStepAbort = (): void => resolve({ kind: 'aborted' });
          stepSignal.addEventListener('abort', onStepAbort, { once: true });
        }),
      );
    }
  }

  let settled: Settled<T>;
  try {
    settled = await Promise.race(races);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onStepAbort !== null && stepSignal !== undefined) stepSignal.removeEventListener('abort', onStepAbort);
    link.unlink();
  }

  // clause 4, the harness's own stops: not Jev's failures, so they travel up exactly as they do with routers off
  if (settled.kind === 'aborted' && stepSignal !== undefined) throw abortReasonOf(stepSignal);
  if (settled.kind === 'error' && isRouterFatal(settled.error)) throw settled.error;

  // clause 6: whatever the router does not use, it cancels — an ask nobody awaits must not run on
  const drop = (reason: RouteDrop): RouteResult<T> => {
    const out = code(reason);
    link.controller.abort(new Error(`routeSpeculative(${id}): dropped (${reason}) — the router no longer needs this answer`));
    return out;
  };

  if (settled.kind === 'deadline') return drop('deadline');
  if (settled.kind === 'work') return drop('work_settled');
  if (settled.kind === 'aborted') return drop('aborted');
  if (settled.kind === 'error') return drop('error');
  // I4: the answer may not be applied to a committed step
  if (!token.valid) return drop('committed');
  const order = settled.order;
  if (order === null || order.length === 0) return drop('empty');
  return { order, source: 'jev', appliedAt: now(), dropped: false, id, ...held(), drop: null };
}

/**
 * §0.3: `routers` is an `EngineOptions` member with an env **default** read inside the loop, exactly as
 * `JEVCODE_WARM` is read in `src/synth/warm/plane.ts`. The default is **off** in every mode on `main`; only the
 * bench arm turns it on. An unset or unrecognised value is off, so nothing about a user run changes by accident.
 *
 * **The explicit option wins; the env only fills an ABSENT option** (§7.5 seam (b), slot D's finding). This used
 * to OR the env in, so an exported `JEVCODE_ROUTERS=on` armed an arm whose own row said `routers: 'off'` and
 * `jev-on-next-nofast`'s one-mechanism contrast was destroyed without a single observable difference in the
 * output. A caller that says what it wants gets what it said; a caller that says nothing gets the environment's
 * answer, which is how a bisect and a worker process still express the switch.
 */
export function routersEnabled(opt?: 'on' | 'off', env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (opt !== undefined) return opt === 'on';
  const e = env['JEVCODE_ROUTERS']?.trim().toLowerCase();
  return e === 'on';
}

/** One step's router rows, folded into `StepRecord.router` by the engine seam (§5.2). */
export interface RouterLedger {
  issued: number;
  applied: number;
  dropped: number;
  /** I3: the sum of the measured per-route `waitMs`; this is what becomes `StepTiming.routerWaitMs` and it MUST be 0 */
  waitMs: number;
  /** the sum of the measured per-route `heldMs` — not a contract member; the step's router wall, for the bench row and for a test that can fail */
  heldMs: number;
  /** `drop` is why this route did not take Jev's answer (§5.2 / review defect A7); absent on an applied row. */
  rows: { id: string; source: 'jev' | 'code'; appliedAt: number | null; dropped: boolean; drop?: RouteDrop }[];
}

export function emptyRouterLedger(): RouterLedger {
  return { issued: 0, applied: 0, dropped: 0, waitMs: 0, heldMs: 0, rows: [] };
}

/** Bounded at 12 rows (§5.2); the counters keep counting past the bound. */
export const ROUTER_ROWS_MAX = 12;

export function noteRoute<T>(ledger: RouterLedger, r: RouteResult<T>): RouterLedger {
  ledger.issued += 1;
  if (r.dropped) ledger.dropped += 1;
  else ledger.applied += 1;
  ledger.waitMs += r.waitMs;
  ledger.heldMs += r.heldMs;
  // review defect A7: the REASON rides the row. `dropped: true` alone cannot distinguish "the deadline is too
  // short for this site's batch" from "Jev was down", and those call for opposite actions.
  if (ledger.rows.length < ROUTER_ROWS_MAX) ledger.rows.push({ id: r.id, source: r.source, appliedAt: r.appliedAt, dropped: r.dropped, ...(r.drop === null ? {} : { drop: r.drop }) });
  return ledger;
}
