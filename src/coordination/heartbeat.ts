/**
 * Heartbeats (§3.3, W1 item 9): the record builder with every cap of the schema applied and the 4 KiB bound refused, and
 * the writer the engine drives at the six write points — (1) `run:ready` start, (2) the `.then` of the checkpoint IIFE,
 * (3) the 15 s timer armed from `run:ready` to `ended` regardless of stage, (4) coalesced phase transitions (≤ 1 write per
 * 250 ms), (5) `finish()` with `phase:'ended'`, (6) the synchronous ended marker of the `'exit'` handler. The timer also
 * renews every tracked lease (§4.3 step 7) and records `lastBeatMono` for the §4.2 suspension check. Every write rides the
 * ledger chain; nothing here is awaited by a step. The bench process writes ONE `kind:'bench'` presence record (§4.7).
 */
import type { EngineMode, RunSource } from '../core/types.js';
import { asHandle, type LedgerHandle } from './ledger.js';
import { collapsePaths } from './leases.js';
import { LEASE_PATHS_MAX, TOUCHED_RECENT_MAX } from './ids.js';
import { HEARTBEAT_MS, HEARTBEAT_TTL_MS, LEASES_IN_BEAT_MAX, NEXT3_MAX_CHARS, SUBWORK_MAX, finalizeRecord, fitsRecordSize } from './records.js';
import type { Claim, Heartbeat, LeaseHandle, Ledger, Stamp, SubworkEntry } from './types.js';

/** §3.3 point 4: phase transitions coalesce to ≤ 1 write per 250 ms */
export const HEARTBEAT_COALESCE_MS = 250;

/** The identity half of a heartbeat: fixed for the life of the run (`repo.repoKey` may arrive later, §3.2). */
export interface HeartbeatBase {
  kind?: 'heartbeat' | 'bench';
  deviceId: string;
  label: string;
  host: string;
  user: string;
  pid: number;
  /** §3.2: this machine's `hostKey`, so a peer sharing our `deviceId` under one `~/.jevcode` is not read as us */
  hostKey?: string;
  bootAt: string;
  jevcode: string;
  runId: string;
  sessionId: string;
  parentSessionId: string | null;
  parentRunId: string | null;
  source: RunSource;
  title60: string | null;
  task60: string;
  /** + review blocker 3: the immutable per-process claim; minted once by `mintClaim` and never touched again */
  claim: Claim;
  repo: Heartbeat['repo'];
  mode: EngineMode;
  maxSteps: number;
  maxWallMs: number;
  startedAt: string;
  ttlMs?: number;
}

/** The moving half: what `emitStatus` / the checkpoint `.then` know. */
export type HeartbeatDynamic = Pick<Heartbeat, 'phase' | 'step' | 'stage' | 'action80' | 'pausing' | 'pauseNow' | 'blocked' | 'retrying' | 'stopReason' | 'plan' | 'declared' | 'touched' | 'touchedRecent' | 'leases' | 'subwork' | 'spend' | 'tokens' | 'wallMs' | 'context'> &
  Partial<Pick<Heartbeat, 'pausePoint' | 'lockHeld' | 'bench'>>;

export function initialDynamic(): HeartbeatDynamic {
  return {
    phase: 'starting',
    step: 0,
    stage: 'idle',
    action80: null,
    pausing: false,
    pauseNow: false,
    blocked: null,
    retrying: null,
    stopReason: null,
    plan: { done: 0, remaining: 0, unverified: 0, next3: [] },
    declared: null,
    touched: null,
    touchedRecent: [],
    leases: [],
    subwork: [],
    spend: { generatorUsd: 0, jevUsd: 0, sessionUsd: null, capUsd: 0 },
    tokens: { used: 0, cap: null },
    wallMs: 0,
    context: { pct: 0, files: 0, historyEntries: 0, summaryAt: null, tokensInWindow: 0, windowBudget: 0, compactions: 0 },
  };
}

export type BuildHeartbeatResult = { ok: true; record: Heartbeat; degraded: boolean } | { ok: false; reason: 'size' };

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/**
 * + review blocker 2: the §3.3 caps DO NOT FIT 4 KiB. An empty beat is already ~1.4 KiB of fixed identity, and the
 * documented `touchedRecent` cap of 96 paths overflows on its own at any realistic path length (64 × 40 chars is
 * enough). The old builder answered `{ ok: false, reason: 'size' }` and the writer then wrote NOTHING — so the run
 * simply stopped beating, every peer read it stale after ttl + slack, and its leases were dropped and its files
 * clobbered. Refusing to beat is the worst available failure.
 *
 * The record now DEGRADES, in the order the design says matters least first, and marks itself `truncated`:
 *   touchedRecent → subwork → plan.next3 → the declared / touched path sets (collapsed, then emptied).
 * A beat that still cannot fit — only possible when the fixed identity itself overflows — is refused as before.
 */
const DEGRADE_STEPS = 6;

export function buildHeartbeat(base: HeartbeatBase, dyn: HeartbeatDynamic, o: { beatSeq: number; beatAt: string; stamp: Stamp; redact: (s: string) => string; sign?: <T extends object>(r: T) => T }): BuildHeartbeatResult {
  for (let step = 0; step <= DEGRADE_STEPS; step++) {
    const r = buildAt(base, dyn, o, step);
    if (r !== null) return { ok: true, record: r, degraded: step > 0 };
  }
  return { ok: false, reason: 'size' };
}

/** One rung of the ladder: `null` when the result does not fit its 4 KiB cap. */
function buildAt(base: HeartbeatBase, dyn0: HeartbeatDynamic, o: { beatSeq: number; beatAt: string; stamp: Stamp; redact: (s: string) => string; sign?: <T extends object>(r: T) => T }, step: number): Heartbeat | null {
  const pathCap = step >= 6 ? 0 : step >= 5 ? 1 : step >= 4 ? 8 : LEASE_PATHS_MAX;
  const dyn: HeartbeatDynamic = {
    ...dyn0,
    ...(step >= 1 ? { touchedRecent: [] } : {}),
    ...(step >= 2 ? { subwork: [] } : {}),
    ...(step >= 3 ? { plan: { ...dyn0.plan, next3: [] } } : {}),
  };
  const declared = dyn.declared === null ? null : { ...dyn.declared, ...collapsePaths(dyn.declared.paths, Math.max(1, pathCap)), ...(pathCap === 0 ? { paths: [] } : {}) };
  if (declared !== null && dyn.declared !== null) declared.truncated = declared.truncated || dyn.declared.truncated || step >= 4;
  const touched = dyn.touched === null ? null : { step: dyn.touched.step, files: pathCap === 0 ? [] : collapsePaths(dyn.touched.files, Math.max(1, pathCap)).paths };
  const record: Heartbeat = {
    v: 1,
    kind: base.kind ?? 'heartbeat',
    deviceId: base.deviceId,
    label: clip(base.label, 24),
    host: base.host,
    user: base.user,
    pid: base.pid,
    ...(base.hostKey !== undefined ? { hostKey: base.hostKey } : {}),
    bootAt: base.bootAt,
    jevcode: base.jevcode,
    runId: base.runId,
    sessionId: base.sessionId,
    parentSessionId: base.parentSessionId,
    parentRunId: base.parentRunId,
    source: base.source,
    title60: base.title60 === null ? null : clip(base.title60, 60),
    task60: clip(base.task60, 60),
    claim: base.claim,
    repo: base.repo,
    mode: base.mode,
    phase: dyn.phase,
    step: dyn.step,
    maxSteps: base.maxSteps,
    stage: dyn.stage,
    action80: dyn.action80 === null ? null : clip(dyn.action80, 80),
    pausing: dyn.pausing,
    pauseNow: dyn.pauseNow,
    blocked: dyn.blocked,
    retrying: dyn.retrying,
    stopReason: dyn.stopReason,
    plan: { ...dyn.plan, next3: dyn.plan.next3.slice(0, 3).map((s) => clip(s, NEXT3_MAX_CHARS)) },
    declared,
    touched,
    touchedRecent: dyn.touchedRecent.slice(-TOUCHED_RECENT_MAX),
    leases: dyn.leases.slice(-LEASES_IN_BEAT_MAX),
    subwork: dyn.subwork.slice(-SUBWORK_MAX).map((s) => ({ ...s, detail60: clip(s.detail60, 60) })),
    ...(dyn.bench !== undefined ? { bench: dyn.bench } : {}),
    spend: dyn.spend,
    tokens: dyn.tokens,
    wallMs: dyn.wallMs,
    maxWallMs: base.maxWallMs,
    context: dyn.context,
    ...(dyn.pausePoint !== undefined ? { pausePoint: dyn.pausePoint } : {}),
    ...(dyn.lockHeld !== undefined ? { lockHeld: dyn.lockHeld } : {}),
    ...(step > 0 ? { truncated: true } : {}),
    startedAt: base.startedAt,
    beatAt: o.beatAt,
    beatSeq: o.beatSeq,
    ttlMs: base.ttlMs ?? HEARTBEAT_TTL_MS,
    stamp: o.stamp,
    checksum: '',
  };
  const final = (o.sign ?? ((r: Heartbeat) => r))(finalizeRecord(record, o.redact));
  return fitsRecordSize('heartbeat', final) ? final : null;
}

// ── the writer ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PHASE_KEYS: readonly (keyof HeartbeatDynamic)[] = ['phase', 'blocked', 'pausing', 'pauseNow', 'stage'];

export interface HeartbeatWriterOptions {
  ledger: Ledger;
  base: HeartbeatBase;
  initial?: Partial<HeartbeatDynamic>;
  /** 15_000 */
  intervalMs?: number;
  /** 250 */
  coalesceMs?: number;
  /** runs on every timer tick after the beat (the engine's own per-tick work, e.g. `syncLag` display) */
  onTick?: () => void;
  /** the record did not fit 4 KiB EVEN DEGRADED and was not written (one notice) — see `buildHeartbeat` */
  onRefused?: (reason: 'size') => void;
  /** + review blocker 2: the beat was written, but detail was dropped to make it fit (one notice) */
  onDegraded?: () => void;
}

export interface HeartbeatWriter {
  readonly beatSeq: number;
  /** the writer's monotonic clock at the last beat (§4.2 suspension check); null before `start()` */
  readonly lastBeatMono: number | null;
  readonly ended: boolean;
  snapshot(): HeartbeatDynamic;
  /** (1) `run:ready`: `phase:'running'`, an immediate beat, the 15 s timer armed */
  start(patch?: Partial<HeartbeatDynamic>): void;
  /** (4) store a status change; a change of phase / blocked / pausing / pauseNow / stage schedules a coalesced write */
  set(patch: Partial<HeartbeatDynamic>): void;
  /** (2) / (3): one write on the ledger chain now; never awaited by the caller */
  beat(patch?: Partial<HeartbeatDynamic>): void;
  /** §4.3 step 7: renewed on every tick until `finish` */
  track(handle: LeaseHandle): void;
  untrack(leaseId: string): void;
  /** (5) `finish()`: `phase:'ended'`, tracked leases released `ended`, timer cleared, the chain awaited */
  finish(patch?: Partial<HeartbeatDynamic>): Promise<void>;
  /** (6) the `'exit'` handler: one bounded synchronous write, no mirror, nothing async */
  finishSync(patch?: Partial<HeartbeatDynamic>): void;
  /** clear timers without writing */
  stop(): void;
  /** §4.2: `monotonicNow − lastBeatMono > ttlMs` — peers have long treated this run's leases as expired */
  suspended(): boolean;
}

export function createHeartbeatWriter(o: HeartbeatWriterOptions): HeartbeatWriter {
  const h: LedgerHandle = asHandle(o.ledger);
  const rel = `${o.base.runId}.json`;
  const ttlMs = o.base.ttlMs ?? HEARTBEAT_TTL_MS;
  const intervalMs = o.intervalMs ?? HEARTBEAT_MS;
  const coalesceMs = o.coalesceMs ?? HEARTBEAT_COALESCE_MS;
  let dyn: HeartbeatDynamic = { ...initialDynamic(), ...(o.initial ?? {}) };
  let beatSeq = 0;
  let lastBeatMono: number | null = null;
  let ended = false;
  let refusedOnce = false;
  let degradedOnce = false;
  let timer: unknown = null;
  let coalesce: unknown = null;
  const tracked = new Map<string, LeaseHandle>();

  const build = (): Heartbeat | null => {
    beatSeq += 1;
    const r = buildHeartbeat(o.base, dyn, { beatSeq, beatAt: new Date(h.now()).toISOString(), stamp: h.stamps.issue(), redact: h.redact, sign: h.sign });
    if (r.ok) {
      if (r.degraded && !degradedOnce) {
        degradedOnce = true;
        o.onDegraded?.();
      }
      return r.record;
    }
    if (!refusedOnce) {
      refusedOnce = true;
      o.onRefused?.(r.reason);
    }
    return null;
  };
  const write = (fsync: boolean): Promise<void> => {
    const record = build();
    lastBeatMono = h.monotonicNow();
    if (record === null) return Promise.resolve();
    return h.enqueue(`heartbeat ${o.base.runId}`, () => h.writeOwn('registry', rel, record, { fsync }));
  };
  const clearCoalesce = (): void => {
    if (coalesce !== null) h.timers.clearTimeout(coalesce);
    coalesce = null;
  };
  const tick = (): void => {
    if (ended) return;
    for (const l of tracked.values()) l.renew();
    void write(false);
    o.onTick?.();
  };

  return {
    get beatSeq() {
      return beatSeq;
    },
    get lastBeatMono() {
      return lastBeatMono;
    },
    get ended() {
      return ended;
    },
    snapshot: () => ({ ...dyn }),
    start(patch) {
      if (ended || timer !== null) return;
      dyn = { ...dyn, phase: 'running', ...(patch ?? {}) };
      void write(false);
      timer = h.timers.setInterval(tick, intervalMs);
    },
    set(patch) {
      if (ended) return;
      const changed = PHASE_KEYS.some((k) => k in patch && patch[k] !== dyn[k]);
      dyn = { ...dyn, ...patch };
      if (changed && coalesce === null) {
        coalesce = h.timers.setTimeout(() => {
          coalesce = null;
          if (!ended) void write(false);
        }, coalesceMs);
      }
    },
    beat(patch) {
      if (ended) return;
      if (patch !== undefined) dyn = { ...dyn, ...patch };
      clearCoalesce();
      void write(false);
    },
    track(handle) {
      tracked.set(handle.leaseId, handle);
    },
    untrack(leaseId) {
      tracked.delete(leaseId);
    },
    async finish(patch) {
      if (ended) return;
      ended = true;
      if (timer !== null) h.timers.clearInterval(timer);
      timer = null;
      clearCoalesce();
      for (const l of tracked.values()) l.release('ended');
      tracked.clear();
      dyn = { ...dyn, ...(patch ?? {}), phase: 'ended' };
      beatSeq += 1;
      const r = buildHeartbeat(o.base, dyn, { beatSeq, beatAt: new Date(h.now()).toISOString(), stamp: h.stamps.issue(), redact: h.redact, sign: h.sign });
      lastBeatMono = h.monotonicNow();
      if (r.ok) await h.enqueue(`heartbeat ${o.base.runId} ended`, () => h.writeOwn('registry', rel, r.record, { fsync: true }));
      else if (!refusedOnce) o.onRefused?.(r.reason);
    },
    finishSync(patch) {
      if (timer !== null) h.timers.clearInterval(timer);
      timer = null;
      clearCoalesce();
      ended = true;
      dyn = { ...dyn, ...(patch ?? {}), phase: 'ended' };
      beatSeq += 1;
      const r = buildHeartbeat(o.base, dyn, { beatSeq, beatAt: new Date(h.now()).toISOString(), stamp: h.stamps.issue(), redact: h.redact, sign: h.sign });
      if (!r.ok) return;
      try {
        h.writeOwnSync('registry', rel, r.record);
      } catch {
        /* the exit handler cannot recover; expiry is the truth (§3.3) */
      }
    },
    stop() {
      if (timer !== null) h.timers.clearInterval(timer);
      timer = null;
      clearCoalesce();
    },
    suspended: () => lastBeatMono !== null && h.monotonicNow() - lastBeatMono > ttlMs,
  };
}

// ── bench presence (§4.7) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BenchPresenceInput {
  benchId: string;
  tasks: { live: number; done: number; total: number };
  lanes: number;
  spendUsd: number;
}

/** The dynamic half of the bench runner's ONE `kind:'bench'` heartbeat: `claims: off`, the bench counters, no step. */
export function benchDynamic(b: BenchPresenceInput, phase: HeartbeatDynamic['phase'] = 'running'): HeartbeatDynamic {
  return { ...initialDynamic(), phase, bench: { benchId: b.benchId, tasks: { ...b.tasks }, lanes: b.lanes, spendUsd: b.spendUsd }, spend: { generatorUsd: b.spendUsd, jevUsd: 0, sessionUsd: null, capUsd: 0 } };
}

/** The identity half for a bench process: `kind:'bench'`, `source:'bench'`, the bench's own run-id-shaped id as run and session. */
export function benchBase(o: Omit<HeartbeatBase, 'kind' | 'source' | 'parentSessionId' | 'parentRunId' | 'title60' | 'mode' | 'maxSteps' | 'maxWallMs'> & { mode?: EngineMode }): HeartbeatBase {
  return { ...o, kind: 'bench', source: 'bench', parentSessionId: null, parentRunId: null, title60: null, mode: o.mode ?? 'jev-on', maxSteps: 0, maxWallMs: 0 };
}

export type { SubworkEntry };
