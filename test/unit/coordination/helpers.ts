/** Fixtures for the coordination tests: shape-valid, checksummed records; fake clocks, timers and a fault-injecting fs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordFs } from '../../../src/coordination/fs.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { buildFold, emptyFoldState, sessionTargets, type FoldEnv, type FoldState, type RecordEntry } from '../../../src/coordination/fold.js';
import { withHmac } from '../../../src/coordination/claims.js';
import { withChecksum } from '../../../src/coordination/records.js';
import type { Ack, AnyRecord, Claim, DeviceRecord, Fold, Heartbeat, Lease, Message, RecordKind, RecordOrigin, SelfIdentity, Stamp } from '../../../src/coordination/types.js';
import type { Timers } from '../../../src/coordination/watch.js';
import { commonsPaths } from '../../../src/coordination/paths.js';

export const DEV_A = 'k3q7m2ab';
export const DEV_B = 'zz5wq7cd';
export const WS = 'ws:3f9a2c1d8bc0d11e';
export const REPO = '9c3a7ac066816f2b';
export const T0 = Date.parse('2026-09-21T12:00:00.000Z');
export const BOOT = '2026-09-21T06:00:00.000Z';

/** A syntactically valid run id (`\d{8}-\d{6}-[a-z2-7]{8}`) for run n, with a tail that is UNIQUE per n. */
export function runId(n: number): string {
  const sec = String(n % 60).padStart(2, '0');
  const min = String(Math.floor(n / 60) % 60).padStart(2, '0');
  let tail = '';
  let v = Math.max(0, Math.floor(n));
  for (let i = 0; i < 8; i++) {
    tail = String.fromCharCode(97 + (v % 26)) + tail;
    v = Math.floor(v / 26);
  }
  return `20260921-11${min}${sec}-${tail}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function stamp(n: number, deviceId = DEV_A, rid = runId(1)): Stamp {
  return { n, deviceId, runId: rid };
}

/** The immutable per-process claim the fork rule compares (review blocker 3). */
export function claim(patch: Partial<Claim> = {}): Claim {
  return { epoch: 1, deviceId: DEV_A, runId: runId(1), pid: 4242, startedAt: iso(T0 - 60_000), ...patch };
}

export const SELF: RecordOrigin = { self: true, source: null, authenticated: true };
export const TRUSTED: RecordOrigin = { self: false, source: null, authenticated: true };
export const UNVERIFIED: RecordOrigin = { self: false, source: null, authenticated: false };

export function makeSelf(patch: Partial<SelfIdentity> = {}): SelfIdentity {
  return { deviceId: DEV_A, label: 'mbp', host: 'mbp.local', user: 'p', bootAt: BOOT, sessionId: runId(1), runId: runId(1), wsKey: WS, repoKey: REPO, remoteKey: null, branch: 'main', ...patch };
}

type Deep<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]> | T[K]) : T[K] };

export function makeHeartbeat(patch: Deep<Heartbeat> & { repo?: Partial<Heartbeat['repo']> } = {}): Heartbeat {
  const rid = (patch.runId as string | undefined) ?? runId(1);
  const base: Heartbeat = {
    v: 1,
    kind: 'heartbeat',
    deviceId: DEV_A,
    label: 'mbp',
    host: 'mbp.local',
    user: 'p',
    pid: 4242,
    bootAt: BOOT,
    jevcode: '0.3.0',
    runId: rid,
    sessionId: rid,
    parentSessionId: null,
    parentRunId: null,
    source: 'cli',
    title60: null,
    task60: 'fix store rotation',
    claim: claim({ deviceId: (patch.deviceId as string | undefined) ?? DEV_A, runId: rid, pid: (patch.pid as number | undefined) ?? 4242 }),
    repo: { wsKey: WS, repoKey: REPO, remoteKey: null, basename: 'JevCode', branch: 'main', head: 'a'.repeat(40), dirtyAtStart: false, linkedWorktree: false, worktreeSlug: null },
    mode: 'jev-on',
    phase: 'running',
    step: 7,
    maxSteps: 40,
    stage: 'propose',
    action80: 'edit src/checkpoint/store.ts',
    pausing: false,
    pauseNow: false,
    blocked: null,
    retrying: null,
    stopReason: null,
    plan: { done: 3, remaining: 4, unverified: 1, next3: ['a'] },
    declared: null,
    touched: null,
    touchedRecent: [],
    leases: [],
    subwork: [],
    spend: { generatorUsd: 0.12, jevUsd: 0.03, sessionUsd: null, capUsd: 2 },
    tokens: { used: 100, cap: null },
    wallMs: 1000,
    maxWallMs: 1_800_000,
    context: { pct: 41, files: 6, historyEntries: 12, summaryAt: null, tokensInWindow: 29_000, windowBudget: 70_400, compactions: 0 },
    startedAt: iso(T0 - 60_000),
    beatAt: iso(T0),
    beatSeq: 1,
    ttlMs: 45_000,
    stamp: stamp(1, DEV_A, rid),
    checksum: '',
  };
  const merged = { ...base, ...(patch as Partial<Heartbeat>), repo: { ...base.repo, ...(patch.repo ?? {}) } } as Heartbeat;
  return withChecksum(merged);
}

export function makeLease(patch: Partial<Lease> = {}): Lease {
  const rid = patch.runId ?? runId(2);
  const n = patch.stamp?.n ?? 5;
  const base: Lease = {
    v: 1,
    kind: 'lease',
    leaseId: `${rid}-${n}`,
    runId: rid,
    sessionId: rid,
    deviceId: DEV_A,
    label: 'mbp',
    repoKey: REPO,
    remoteKey: null,
    wsKey: WS,
    branch: 'main',
    head: null,
    type: 'intent',
    paths: ['src/x.ts'],
    truncated: false,
    reason60: 'fix x',
    step: 3,
    stage: 'coordinate',
    stamp: stamp(n, patch.deviceId ?? DEV_A, rid),
    issuedAt: iso(T0),
    expiresAt: iso(T0 + 600_000),
    renewedAt: iso(T0),
    checksum: '',
  };
  return withChecksum({ ...base, ...patch });
}

export function makeMessage(patch: Partial<Message> = {}): Message {
  const n = patch.stamp?.n ?? 3;
  const base: Message = {
    v: 1,
    kind: 'message',
    id: `${DEV_B}-abcdefgh-${n}`,
    from: { deviceId: DEV_B, label: 'studio', sessionId: runId(9), runId: runId(9), user: 'p' },
    to: runId(1),
    type: 'note',
    text: 'hello',
    refs: {},
    t: iso(T0),
    stamp: stamp(n, DEV_B, runId(9)),
    expiresAt: iso(T0 + 7 * 86_400_000),
    checksum: '',
  };
  return withChecksum({ ...base, ...patch });
}

export function makeAck(patch: Partial<Ack> = {}): Ack {
  const base: Ack = { v: 1, kind: 'ack', msgId: `${DEV_B}-abcdefgh-3`, by: runId(1), deviceId: DEV_A, at: iso(T0), outcome: 'delivered', stamp: stamp(4), checksum: '' };
  return withChecksum({ ...base, ...patch });
}

export function makeDevice(patch: Partial<DeviceRecord> = {}): DeviceRecord {
  const base: DeviceRecord = { v: 1, deviceId: DEV_A, label: 'mbp', host: 'mbp.local', user: 'p', jevcode: '0.3.0', createdAt: iso(T0 - 86_400_000), syncMode: 'off', checksum: '' };
  return withChecksum({ ...base, ...patch });
}

// ── clocks and timers ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeClock {
  wall: number;
  mono: number;
  now(): number;
  monotonicNow(): number;
  advance(ms: number): void;
}
export function fakeClock(wall = T0, mono = 1_000_000): FakeClock {
  const c: FakeClock = {
    wall,
    mono,
    now: () => c.wall,
    monotonicNow: () => c.mono,
    advance(ms) {
      c.wall += ms;
      c.mono += ms;
    },
  };
  return c;
}

interface Scheduled {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}
export interface FakeTimers extends Timers {
  tick(ms: number): void;
  pending(): number;
}
/** Deterministic timers driven by `tick(ms)`; intervals re-arm; callbacks run in due order. */
export function fakeTimers(clock?: FakeClock): FakeTimers {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, Scheduled>();
  const add = (fn: () => void, ms: number, every: number | null): number => {
    const id = ++seq;
    queue.set(id, { id, at: now + Math.max(0, ms), fn, every });
    return id;
  };
  return {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (h) => void queue.delete(h as number),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)),
    clearInterval: (h) => void queue.delete(h as number),
    pending: () => queue.size,
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...queue.values()].filter((s) => s.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        const delta = due.at - now;
        now = due.at;
        clock?.advance(Math.max(0, delta));
        if (due.every !== null) due.at = now + due.every;
        else queue.delete(due.id);
        due.fn();
      }
      const rest = end - now;
      now = end;
      if (rest > 0) clock?.advance(rest);
    },
  };
}

// ── temp stores and fault injection ───────────────────────────────────────────────────────────────────────────────────

export async function tempHome(): Promise<{ home: string; root: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'jevcode-coord-'));
  return { home, root: join(home, 'coordination'), cleanup: () => rm(home, { recursive: true, force: true }) };
}

export const errno = (code: string): Error => Object.assign(new Error(code), { code });

export interface FaultRule {
  /** substring of the path */
  path: string;
  op?: keyof CoordFs;
  code: string;
  /** fail only this many times (default: forever) */
  times?: number;
}

/** Wrap a fs so ops on matching paths throw the errno (fault injection, §11 row 13) and/or are held until released (a lagging mirror, §11 row 48). */
export function faultFs(base: CoordFs, rules: FaultRule[] = []): CoordFs & { rules: FaultRule[]; hold: (pathPart: string) => () => void; calls: string[] } {
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
  const calls: string[] = [];
  const check = (op: keyof CoordFs, path: string): void => {
    for (const r of rules) {
      if ((r.op === undefined || r.op === op) && path.includes(r.path)) {
        if (r.times !== undefined) {
          if (r.times <= 0) continue;
          r.times -= 1;
        }
        throw errno(r.code);
      }
    }
  };
  const gate = async (path: string): Promise<void> => {
    for (const [part, h] of holds) if (path.includes(part)) await h.promise;
  };
  const wrap = <K extends keyof CoordFs>(op: K): CoordFs[K] =>
    ((...args: unknown[]) => {
      const path = String(args[0]);
      calls.push(`${op} ${path}`);
      const fn = base[op] as (...a: unknown[]) => unknown;
      const isSync = op.endsWith('Sync');
      if (isSync) {
        check(op, path);
        return fn.apply(base, args);
      }
      return gate(path).then(() => {
        check(op, path);
        return fn.apply(base, args);
      });
    }) as CoordFs[K];
  const out = {
    rules,
    calls,
    hold(pathPart: string) {
      let release = (): void => undefined;
      const promise = new Promise<void>((res) => {
        release = res;
      });
      holds.set(pathPart, { promise, release });
      return () => {
        holds.get(pathPart)?.release();
        holds.delete(pathPart);
      };
    },
  } as CoordFs & { rules: FaultRule[]; hold: (pathPart: string) => () => void; calls: string[] };
  for (const op of Object.keys(nodeFs) as (keyof CoordFs)[]) (out as unknown as Record<string, unknown>)[op] = wrap(op);
  return out;
}

/** Write a record file verbatim under a store root (`raw` for torn / hostile fixtures). */
export async function putFile(path: string, text: string, fs: CoordFs = nodeFs): Promise<void> {
  await fs.mkdir(join(path, '..'), 0o700);
  await fs.writeAtomic(path, text, { fsync: false, mode: 0o600 });
}

export function storePaths(root: string): ReturnType<typeof commonsPaths> {
  return commonsPaths(root);
}

export async function putHeartbeat(root: string, hb: Heartbeat, fs: CoordFs = nodeFs): Promise<string> {
  const p = commonsPaths(root).heartbeatFile(hb.deviceId, hb.runId);
  await putFile(p, `${JSON.stringify(hb)}\n`, fs);
  return p;
}
export async function putLease(root: string, l: Lease, fs: CoordFs = nodeFs): Promise<string> {
  const p = commonsPaths(root).leaseFile(l.deviceId, l.repoKey, l.leaseId);
  await putFile(p, `${JSON.stringify(l)}\n`, fs);
  return p;
}
export async function putMessage(root: string, m: Message, tMs: number, fs: CoordFs = nodeFs): Promise<string> {
  const p = commonsPaths(root).messageFile(m.from.deviceId, m.to, tMs, m.stamp.n);
  await putFile(p, `${JSON.stringify(m)}\n`, fs);
  return p;
}
export async function putAck(root: string, a: Ack, fs: CoordFs = nodeFs): Promise<string> {
  const p = commonsPaths(root).ackFile(a.deviceId, a.msgId, a.by);
  await putFile(p, `${JSON.stringify(a)}\n`, fs);
  return p;
}
export async function putDevice(root: string, d: DeviceRecord, fs: CoordFs = nodeFs): Promise<string> {
  const p = commonsPaths(root).deviceRecordFile(d.deviceId);
  await putFile(p, `${JSON.stringify(d)}\n`, fs);
  return p;
}

/** Deterministic Fisher–Yates over a seed (the fold's arrival-order property test). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── fold fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const KEY_A = 'a'.repeat(64);
export const KEY_B = 'b'.repeat(64);

/** Sign a record with a device key (what a paired peer's writer would have done). */
export function signed<T extends object>(record: T, keyHex: string): T {
  return withHmac(record, keyHex);
}

const KIND_OF: Record<string, RecordKind> = { heartbeat: 'heartbeat', bench: 'heartbeat', lease: 'lease', message: 'message', ack: 'ack' };

/** One fold entry; `origin` defaults to `self` for records whose device is `DEV_A` and foreign otherwise. */
export function entry(record: AnyRecord, origin?: RecordOrigin): RecordEntry {
  const kind: RecordKind = 'kind' in record ? (KIND_OF[record.kind] ?? 'heartbeat') : 'device';
  const deviceId = 'from' in record ? record.from.deviceId : record.deviceId;
  const o = origin ?? (deviceId === DEV_A ? SELF : UNVERIFIED);
  return { kind, record, deviceId, path: `/fixture/${kind}/${deviceId}`, source: o.source, origin: o };
}

export function foldEnv(patch: Partial<FoldEnv> = {}): FoldEnv {
  const self = makeSelf();
  return {
    deviceId: DEV_A,
    bootAt: BOOT,
    isPidAlive: () => true,
    now: { wallMs: T0, monoMs: 1_000_000 },
    targets: sessionTargets(self),
    ignoredDevices: new Set<string>(),
    ...patch,
  };
}

/** Build a fold over records with per-record origins; fresh side state unless one is given. */
export function foldOf(entries: readonly RecordEntry[], patch: Partial<FoldEnv> = {}, state: FoldState = emptyFoldState()): Fold {
  return buildFold(entries, state, foldEnv(patch));
}
