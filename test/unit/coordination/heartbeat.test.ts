/**
 * §3.3 heartbeats: the record builder with every cap applied and 4 KiB refused, and the six write points of the writer.
 * §11 rows: 10 (renewal on the 15 s timer — a beating owner's lease never expires), 15 (`lockHeld:false`), 17 (a bench of
 * 30 runs registers ONE presence record), 29 / 36 (coalesced phase transitions), 39 (the suspension check). Review
 * blocker 3: every beat carries the process's immutable claim, and the claim never moves while the stamp does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { benchBase, benchDynamic, buildHeartbeat, createHeartbeatWriter, initialDynamic, HEARTBEAT_COALESCE_MS } from '../../../src/coordination/heartbeat.js';
import { declare } from '../../../src/coordination/leases.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { HEARTBEAT_MS, HEARTBEAT_TTL_MS, LEASE_TTL_MS, LEASES_IN_BEAT_MAX, RECORD_MAX_BYTES, SUBWORK_MAX, parseRecord, recordBytes } from '../../../src/coordination/records.js';
import { mergeSubwork, removeSubwork, subworkEntry } from '../../../src/coordination/subwork.js';
import { TOUCHED_RECENT_MAX, LEASE_PATHS_MAX } from '../../../src/coordination/ids.js';
import type { HeartbeatBase, LedgerHandle } from '../../../src/coordination/index.js';
import { DEV_A, KEY_A, REPO, T0, WS, claim, fakeClock, fakeTimers, iso, makeSelf, runId, stamp, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

function base(patch: Partial<HeartbeatBase> = {}): HeartbeatBase {
  const rid = patch.runId ?? runId(1);
  return {
    deviceId: DEV_A,
    label: 'mbp',
    host: 'mbp.local',
    user: 'p',
    pid: 4242,
    bootAt: iso(T0 - 6 * 3_600_000),
    jevcode: '0.3.0',
    runId: rid,
    sessionId: rid,
    parentSessionId: null,
    parentRunId: null,
    source: 'cli',
    title60: null,
    task60: 'fix store rotation',
    claim: claim({ runId: rid, pid: 4242 }),
    repo: { wsKey: WS, repoKey: REPO, remoteKey: null, basename: 'JevCode', branch: 'main', head: null, dirtyAtStart: false, linkedWorktree: false, worktreeSlug: null },
    mode: 'jev-on',
    maxSteps: 40,
    maxWallMs: 1_800_000,
    startedAt: iso(T0 - 60_000),
    ...patch,
  };
}

const buildOpts = { beatSeq: 1, beatAt: iso(T0), stamp: stamp(1), redact: (s: string) => s };

describe('buildHeartbeat (§3.3): every cap applied, 4 KiB refused', () => {
  it('produces a record that parses under the path binding and carries the claim', () => {
    const r = buildHeartbeat(base(), initialDynamic(), buildOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.claim).toEqual(claim({ runId: runId(1), pid: 4242 }));
    const parsed = parseRecord(JSON.stringify(r.record), 'heartbeat', { deviceId: DEV_A });
    expect(parsed.ok).toBe(true);
  });

  it('clips label 24 / title 60 / task 60 / action 80 / next3 80', () => {
    const dyn = { ...initialDynamic(), action80: 'a'.repeat(200), plan: { done: 1, remaining: 2, unverified: 0, next3: ['n'.repeat(200), 'b', 'c', 'd'] } };
    const r = buildHeartbeat(base({ label: 'x'.repeat(40), title60: 't'.repeat(200), task60: 'k'.repeat(200) }), dyn, buildOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.label).toHaveLength(24);
    expect(r.record.title60).toHaveLength(60);
    expect(r.record.task60).toHaveLength(60);
    expect(r.record.action80).toHaveLength(80);
    expect(r.record.plan.next3).toHaveLength(3);
    expect(r.record.plan.next3[0]).toHaveLength(80);
  });

  it('bounds every array to its documented length (the caps of §3.3)', () => {
    const dyn = {
      ...initialDynamic(),
      touchedRecent: Array.from({ length: 200 }, (_, i) => `f${i}`),
      leases: Array.from({ length: 20 }, (_, i) => `${runId(1)}-${i}`),
      subwork: Array.from({ length: 40 }, (_, i) => subworkEntry({ kind: 'sample', id: `s${i}`, since: iso(T0), stage: 'p', detail: 'd' })),
    };
    const r = buildHeartbeat(base(), dyn, buildOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.touchedRecent).toHaveLength(TOUCHED_RECENT_MAX);
    expect(r.record.leases).toHaveLength(LEASES_IN_BEAT_MAX);
    expect(r.record.subwork).toHaveLength(SUBWORK_MAX);
  });

  it('a subwork detail is clipped to 60 chars', () => {
    const r = buildHeartbeat(base(), { ...initialDynamic(), subwork: [subworkEntry({ kind: 'lane', id: 'lane1', since: iso(T0), stage: 'verify', detail: 'd'.repeat(200) })] }, buildOpts);
    expect(r.ok && r.record.subwork[0]?.detail60).toHaveLength(60);
  });

  it('declared / touched paths collapse to prefixes rather than overflow', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `src/tui/part${i}/file.ts`);
    const r = buildHeartbeat(base(), { ...initialDynamic(), declared: { step: 8, paths, type: 'intent', truncated: false }, touched: { step: 7, files: paths } }, buildOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.declared?.truncated).toBe(true);
    expect(r.record.declared?.paths.length).toBeLessThanOrEqual(LEASE_PATHS_MAX);
    expect(r.record.touched?.files.length).toBeLessThanOrEqual(LEASE_PATHS_MAX);
  });

  it('a record that cannot fit 4 KiB is REFUSED, never truncated (every clipped field stays inside its cap)', () => {
    // task60 and friends are clipped by the builder, so overflow can only come from the bounded-but-wide arrays
    const wide = Array.from({ length: 96 }, (_, i) => `src/${'p'.repeat(400)}${i}.ts`);
    const r = buildHeartbeat(base(), { ...initialDynamic(), touchedRecent: wide }, buildOpts);
    expect(r).toEqual({ ok: false, reason: 'size' });
    expect(buildHeartbeat(base({ task60: 'x'.repeat(RECORD_MAX_BYTES.heartbeat) }), initialDynamic(), buildOpts).ok).toBe(true);
  });

  it('a realistic beat stays well inside 4 KiB', () => {
    const r = buildHeartbeat(base(), { ...initialDynamic(), phase: 'running', step: 7, stage: 'propose', action80: 'edit src/checkpoint/store.ts', declared: { step: 8, paths: ['src/checkpoint/store.ts'], type: 'intent', truncated: false } }, buildOpts);
    expect(r.ok && recordBytes(r.record)).toBeLessThan(RECORD_MAX_BYTES.heartbeat);
  });

  it('the redactor runs on every leaf before the checksum', () => {
    const r = buildHeartbeat(base({ task60: 'token sk-abc' }), initialDynamic(), { ...buildOpts, redact: (s) => s.replace('sk-abc', '[REDACTED:key]') });
    expect(r.ok && r.record.task60).toBe('token [REDACTED:key]');
  });

  it('a signer (§10.3) is applied last, and the hmac survives the round trip', () => {
    const r = buildHeartbeat(base(), initialDynamic(), { ...buildOpts, sign: (rec) => ({ ...rec, hmac: 'f'.repeat(64) }) });
    expect(r.ok && r.record.hmac).toBe('f'.repeat(64));
    expect(r.ok && parseRecord(JSON.stringify(r.record), 'heartbeat', { deviceId: DEV_A }).ok).toBe(true);
  });
});

describe('the writer: the six write points (§3.3)', () => {
  async function writerAt(patch: Partial<Parameters<typeof createHeartbeatWriter>[0]> = {}) {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const rid = runId(1);
    const l: LedgerHandle = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, timers, isPidAlive: () => true, pid: 4242, scanOnly: true, commonsKey: KEY_A });
    cleanups.push(() => l.close());
    await l.open();
    const w = createHeartbeatWriter({ ledger: l, base: base(), ...patch });
    return { t, clock, timers, l, w };
  }

  const readBeat = async (root: string) => JSON.parse((await nodeFs.readBounded(commonsPaths(root).heartbeatFile(DEV_A, runId(1)), 4096)).text) as { phase: string; beatSeq: number; stage: string; claim: { epoch: number }; hmac?: string };
  /** the beat rides the ledger chain and is never awaited by a caller; tests drain it */
  const drain = (l: LedgerHandle): Promise<void> => l.enqueue('drain', () => Promise.resolve());

  it('(1) start writes immediately and arms the 15 s timer; (3) every tick writes again', async () => {
    const { t, timers, l, w } = await writerAt();
    w.start();
    await l.close();
    expect((await readBeat(t.root)).phase).toBe('running');
    expect(w.beatSeq).toBe(1);
    timers.tick(HEARTBEAT_MS * 3);
    expect(w.beatSeq).toBe(4);
    w.stop();
  });

  it('(4) a phase transition coalesces to one write per 250 ms; a non-phase field does not write at all', async () => {
    const { timers, w } = await writerAt();
    w.start();
    const after = w.beatSeq;
    w.set({ step: 8 });
    w.set({ wallMs: 1 });
    timers.tick(HEARTBEAT_COALESCE_MS * 2);
    expect(w.beatSeq).toBe(after); // nothing phase-ish changed
    w.set({ phase: 'blocked', blocked: 'spend-limit' });
    w.set({ stage: 'execute' });
    timers.tick(HEARTBEAT_COALESCE_MS);
    expect(w.beatSeq).toBe(after + 1); // both changes rode ONE write
  });

  it('(5) finish writes phase:ended, releases every tracked lease and stops the timer', async () => {
    const { t, timers, l, w } = await writerAt();
    w.start();
    const handle = declare(l, { paths: ['src/x.ts'], type: 'intent', reason60: 'edit', step: 8, stage: 'coordinate', branch: 'main', head: null }, 'advisory');
    w.track(handle);
    await w.finish({ stopReason: 'human_pause' });
    expect((await readBeat(t.root)).phase).toBe('ended');
    const seq = w.beatSeq;
    timers.tick(HEARTBEAT_MS * 2);
    expect(w.beatSeq).toBe(seq); // the timer is gone
    await l.close();
    expect([...l.fold.leases.values()][0]?.released?.outcome).toBe('ended');
  });

  it('(6) finishSync writes the ended marker with no await and no mirror', async () => {
    const { t, w, l } = await writerAt();
    w.start();
    w.finishSync();
    expect((await readBeat(t.root)).phase).toBe('ended');
    expect(w.ended).toBe(true);
    await l.close();
  });

  it('§11 row 10: the tick renews every tracked lease, so a beating owner’s lease never expires', async () => {
    const { clock, timers, l, w } = await writerAt();
    w.start();
    const handle = declare(l, { paths: ['src/x.ts'], type: 'intent', reason60: 'edit', step: 8, stage: 'coordinate', branch: 'main', head: null }, 'advisory');
    w.track(handle);
    timers.tick(HEARTBEAT_MS * 4);
    await l.close();
    const lease = [...l.fold.leases.values()][0];
    expect(Date.parse(lease?.expiresAt ?? '')).toBe(clock.wall + LEASE_TTL_MS);
    expect(Date.parse(lease?.expiresAt ?? '')).toBeGreaterThan(T0 + LEASE_TTL_MS);
  });

  it('§11 row 39: the suspension check fires once the monotonic gap passes the ttl', async () => {
    const { clock, l, w } = await writerAt();
    w.start();
    expect(w.suspended()).toBe(false);
    clock.mono += HEARTBEAT_TTL_MS + 1;
    expect(w.suspended()).toBe(true);
    await l.close();
  });

  it('§11 row 15: lockHeld:false rides the beat as the second liveness signal', async () => {
    const { t, w, l } = await writerAt();
    w.start({ lockHeld: false });
    await l.close();
    const rec = JSON.parse((await nodeFs.readBounded(commonsPaths(t.root).heartbeatFile(DEV_A, runId(1)), 4096)).text) as { lockHeld?: boolean };
    expect(rec.lockHeld).toBe(false);
  });

  it('a refused (too large) record notifies once and never writes', async () => {
    const reasons: string[] = [];
    const wide = Array.from({ length: 96 }, (_, i) => `src/${'p'.repeat(400)}${i}.ts`);
    const { t, w, l } = await writerAt({ initial: { touchedRecent: wide }, onRefused: (r) => reasons.push(r) });
    w.start();
    w.beat();
    await l.close();
    expect(reasons).toEqual(['size']);
    await expect(nodeFs.stat(commonsPaths(t.root).heartbeatFile(DEV_A, runId(1)))).rejects.toThrow();
  });

  it('review blocker 3: the claim is identical on every beat while the stamp advances', async () => {
    const { t, timers, l, w } = await writerAt();
    w.start();
    await drain(l);
    const first = await readBeat(t.root);
    timers.tick(HEARTBEAT_MS);
    await l.close();
    const later = await readBeat(t.root);
    expect(later.claim).toEqual(first.claim);
    expect(later.beatSeq).toBeGreaterThan(first.beatSeq);
    expect(later.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the writer is idle after stop() and ignores a late set()', async () => {
    const { timers, w, l } = await writerAt();
    w.start();
    w.stop();
    const seq = w.beatSeq;
    timers.tick(HEARTBEAT_MS * 3);
    expect(w.beatSeq).toBe(seq);
    await w.finish();
    await l.close();
  });
});

describe('§11 row 17: a bench of 30 runs registers ONE presence record (§4.7)', () => {
  it('the runner writes a single kind:"bench" heartbeat with the bench counters, and its engines coordinate not at all', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const benchId = runId(500);
    const l: LedgerHandle = openLedger({ home: t.home, self: makeSelf({ runId: benchId, sessionId: benchId }), now: clock.now, monotonicNow: clock.monotonicNow, timers, isPidAlive: () => true, pid: 4242, scanOnly: true });
    cleanups.push(() => l.close());
    await l.open();
    const b = benchBase(base({ runId: benchId, task60: 'glm-vs-jev' }));
    const w = createHeartbeatWriter({ ledger: l, base: { ...b, runId: benchId, sessionId: benchId, claim: claim({ runId: benchId, pid: 4242 }) }, initial: benchDynamic({ benchId, tasks: { live: 4, done: 12, total: 30 }, lanes: 8, spendUsd: 1.5 }) });
    w.start();
    // 30 task runs come and go; the presence record is rewritten, never multiplied
    for (let i = 0; i < 30; i++) {
      w.beat({ ...benchDynamic({ benchId, tasks: { live: 4, done: i, total: 30 }, lanes: 8, spendUsd: i * 0.05 }) });
    }
    await l.close();
    const files = await nodeFs.readdir(commonsPaths(t.root).deviceDir('registry', DEV_A));
    expect(files.filter((f) => f.endsWith('.json'))).toEqual([`${benchId}.json`]);
    const rec = JSON.parse((await nodeFs.readBounded(commonsPaths(t.root).heartbeatFile(DEV_A, benchId), 4096)).text) as { kind: string; source: string; bench: { tasks: { done: number }; lanes: number }; step: number };
    expect(rec.kind).toBe('bench');
    expect(rec.source).toBe('bench');
    expect(rec.bench.tasks.done).toBe(29);
    expect(rec.bench.lanes).toBe(8);
    expect(rec.step).toBe(0); // a bench presence record has no step
    expect(parseRecord(JSON.stringify(rec), 'heartbeat', { deviceId: DEV_A }).ok).toBe(true);
  });
});

describe('subwork rows (§6.1): lanes, llm-jev samples, probes and child runs', () => {
  it('a row exists for each kind and a run-relative laneDir survives; anything else is dropped (review #37)', () => {
    const rows = [
      subworkEntry({ kind: 'lane', id: 'lane2', since: iso(T0), stage: 'execute', detail: 'npm test', laneDir: 'tmp/synth/lane2' }),
      subworkEntry({ kind: 'sample', id: 'g1/r2/s3', since: iso(T0), stage: 'propose', detail: 'llm round 2 sample 3' }),
      subworkEntry({ kind: 'probe', id: 'p1', since: iso(T0), stage: 'risk', detail: 'risk probe' }),
      subworkEntry({ kind: 'child', id: runId(5), since: iso(T0), stage: 'propose', detail: 'child fix-tests' }),
      subworkEntry({ kind: 'lane', id: 'bad', since: iso(T0), stage: 'execute', detail: 'x', laneDir: '../escape' }),
    ];
    expect(rows.map((r) => r.kind)).toEqual(['lane', 'sample', 'probe', 'child', 'lane']);
    expect(rows[0]?.laneDir).toBe('tmp/synth/lane2');
    expect(rows[4]?.laneDir).toBeUndefined();
    const built = buildHeartbeat(base(), { ...initialDynamic(), subwork: rows }, buildOpts);
    expect(built.ok && parseRecord(JSON.stringify(built.record), 'heartbeat', { deviceId: DEV_A }).ok).toBe(true);
  });

  it('a finished lane or child is removed by (kind, id)', () => {
    let rows = mergeSubwork([], subworkEntry({ kind: 'lane', id: 'lane1', since: iso(T0), stage: 'execute', detail: 'x' }));
    rows = mergeSubwork(rows, subworkEntry({ kind: 'child', id: runId(5), since: iso(T0 + 1), stage: 'propose', detail: 'y' }));
    rows = removeSubwork(rows, 'lane', 'lane1');
    expect(rows.map((r) => r.id)).toEqual([runId(5)]);
    expect(removeSubwork(rows, 'lane', 'nope')).toEqual(rows);
  });

  it('upsert by (kind, id), ≤ 16 rows, oldest `since` dropped first', () => {
    let rows = mergeSubwork([], subworkEntry({ kind: 'lane', id: 'lane1', since: iso(T0), stage: 'verify', detail: 'running tests' }));
    rows = mergeSubwork(rows, subworkEntry({ kind: 'lane', id: 'lane1', since: iso(T0 + 1), stage: 'verify', detail: 'still running' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail60).toBe('still running');
    for (let i = 0; i < 20; i++) rows = mergeSubwork(rows, subworkEntry({ kind: 'sample', id: `s${i}`, since: iso(T0 + 10 + i), stage: 'propose', detail: 'x' }));
    expect(rows).toHaveLength(SUBWORK_MAX);
    expect(rows.some((r) => r.id === 'lane1')).toBe(false);
  });
});
