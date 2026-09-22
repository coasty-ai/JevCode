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
 *  4. A deadline, a `JevError`, a 503/529, an abort, an invalidated token and a malformed answer are **one branch**:
 *     `dropped: true`, the code order stands, nothing is thrown. That single failure branch is what makes "a Jev
 *     outage is slower, never wrong" a structural property rather than a per-site promise.
 *  5. The thunk is injected: `ask` is the stage's own `ctx.ask`, which already routes through the engine's one
 *     metered, recorded path (`askRecorded`). No router reaches the decider by any other road.
 *
 * **I3, `waitMs === 0`, and what it means here.** The ask is still made, still metered, still written to
 * `jev.jsonl`; `jevMs` may grow. `routerWaitMs` is the wall the router holds the step for *beyond* that ask —
 * and it is 0 by construction, because the router never waits past the earliest of {the answer, the deadline, the
 * dispatched work, the step signal}. The deadline can only make a step wait **less** than today's inline await,
 * never more. (The remaining half of I3 — overlapping the ask with the next stage's work so that even the sub-
 * deadline wall disappears — is the engine's `askRecorded` seam, §7.5, and lands with it.)
 *
 * **I4, no late write.** Application is guarded by a step-scoped `StepToken` invalidated at step commit: an
 * in-flight ask that outlives its step can never write to a committed `StepRecord` or a superseded draft. A late
 * answer is recorded `dropped`, never applied.
 */
import { linkedAbort } from '../core/abort.js';

/** §2.1: the default router deadline. Measured Jev latency is p50 237 ms / p95 547 ms, so 400 ms keeps the median answer and drops the tail. */
export const ROUTER_DEADLINE_MS = 400;

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
  /** I3, in the type: a router contributes zero blocked wall */
  readonly waitMs: 0;
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

type Settled<T> = { kind: 'answer'; order: readonly T[] | null } | { kind: 'error' } | { kind: 'deadline' } | { kind: 'work' } | { kind: 'aborted' };

/**
 * Route one ask. Never throws, never rejects: every failure is the one drop branch of clause 4.
 *
 * The returned `order` is what the caller executes. `order[0]` is `codeOrder[0]` unless Jev answered in time and
 * the token was still valid, in which case it is Jev's — and even then the caller is free to ignore it, because
 * nothing here decides anything: it orders.
 */
export async function routeSpeculative<T>(input: RouteInput<T>): Promise<RouteResult<T>> {
  const { id, token, codeOrder } = input;
  if (codeOrder.length === 0) throw new RangeError(`routeSpeculative(${id}): codeOrder must be non-empty — the code order is the step, not a fallback`);
  const now = input.now ?? Date.now;
  const deadlineMs = Math.max(0, input.deadlineMs ?? ROUTER_DEADLINE_MS);
  const code = (drop: RouteDrop): RouteResult<T> => ({ order: codeOrder, source: 'code', appliedAt: null, dropped: true, id, waitMs: 0, drop });

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
        return { kind: 'answer', order };
      } catch {
        // clause 4: a JevError, a 503/529, an abort and a timeout are ONE branch
        return { kind: 'error' };
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
  if (input.signal !== undefined) {
    const s = input.signal;
    if (s.aborted) races.push(Promise.resolve<Settled<T>>({ kind: 'aborted' }));
    else races.push(new Promise<Settled<T>>((resolve) => s.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })));
  }

  let settled: Settled<T>;
  try {
    settled = await Promise.race(races);
  } finally {
    if (timer !== null) clearTimeout(timer);
    link.unlink();
  }

  if (settled.kind === 'deadline') return code('deadline');
  if (settled.kind === 'work') return code('work_settled');
  if (settled.kind === 'aborted') return code('aborted');
  if (settled.kind === 'error') return code('error');
  // I4: the answer may not be applied to a committed step
  if (!token.valid) return code('committed');
  const order = settled.order;
  if (order === null || order.length === 0) return code('empty');
  return { order, source: 'jev', appliedAt: now(), dropped: false, id, waitMs: 0, drop: null };
}

/**
 * §0.3: `routers` is an `EngineOptions` member with an env override read inside the loop, exactly as
 * `JEVCODE_WARM` is read in `src/synth/warm/plane.ts`. The default is **off** in every mode on `main`; only the
 * bench arm turns it on. An unset or unrecognised value is off, so nothing about a user run changes by accident.
 */
export function routersEnabled(opt?: 'on' | 'off', env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const e = env['JEVCODE_ROUTERS']?.trim().toLowerCase();
  if (e === 'on') return true;
  if (e === 'off') return false;
  return opt === 'on';
}

/** One step's router rows, folded into `StepRecord.router` by the engine seam (§5.2). */
export interface RouterLedger {
  issued: number;
  applied: number;
  dropped: number;
  waitMs: number;
  rows: { id: string; source: 'jev' | 'code'; appliedAt: number | null; dropped: boolean }[];
}

export function emptyRouterLedger(): RouterLedger {
  return { issued: 0, applied: 0, dropped: 0, waitMs: 0, rows: [] };
}

/** Bounded at 12 rows (§5.2); the counters keep counting past the bound. */
export const ROUTER_ROWS_MAX = 12;

export function noteRoute<T>(ledger: RouterLedger, r: RouteResult<T>): RouterLedger {
  ledger.issued += 1;
  if (r.dropped) ledger.dropped += 1;
  else ledger.applied += 1;
  ledger.waitMs += r.waitMs;
  if (ledger.rows.length < ROUTER_ROWS_MAX) ledger.rows.push({ id: r.id, source: r.source, appliedAt: r.appliedAt, dropped: r.dropped });
  return ledger;
}
