/**
 * §9.1 / §9.2 the shared-dir mirror. §11 rows: 5 (an `.icloud` placeholder / an unmounted root at startup — `unknown`,
 * never stale, and startup never blocks), 14 (a torn copy fails its checksum and is skipped), 48 (a dir that lags by
 * minutes or vanishes mid-run). Review blocker 6: our OWN subtree in the mirror is a lag self-check only and is never
 * folded as a record — a file planted there must not read as same-device.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createMirror, ICLOUD_PLACEHOLDER_RE, MIRROR_OP_TIMEOUT_MS } from '../../../src/coordination/sync-shared-dir.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths, mirrorRoot } from '../../../src/coordination/paths.js';
import { serializeRecord } from '../../../src/coordination/records.js';
import type { FoldChange } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, T0, claim, faultFs, fakeClock, fakeTimers, iso, makeHeartbeat, makeSelf, putFile, runId, stamp, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function shared() {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const root = mirrorRoot(t.home);
  await nodeFs.mkdir(root, 0o700);
  return { sharedDir: t.home, root, paths: commonsPaths(root) };
}

describe('the mirror itself (§9.1)', () => {
  it('a copy lands as tmp+rename, reads back byte-identical, and sets the §9.2 lag', async () => {
    const s = await shared();
    const clock = fakeClock();
    const m = createMirror({ fs: nodeFs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow });
    expect(await m.probe()).toBe(true);
    const data = serializeRecord(makeHeartbeat());
    m.copy('registry', `${runId(1)}.json`, data);
    clock.mono += 40;
    await m.flush();
    expect((await nodeFs.readBounded(s.paths.heartbeatFile(DEV_A, runId(1)), 8192)).text).toBe(data);
    expect(m.lagMs).toBeGreaterThanOrEqual(0);
    expect(m.state).toBe('online');
    expect(m.pending).toBe(0);
  });

  it('§11 row 48: a vanished root is `offline`, local truth is untouched, and copies are retried on the tick', async () => {
    const s = await shared();
    const clock = fakeClock();
    const states: string[] = [];
    const fs = faultFs(nodeFs, [{ path: 'jevcode-commons', op: 'writeAtomic', code: 'ETIMEDOUT' }, { path: 'jevcode-commons', op: 'stat', code: 'ENOENT' }]);
    const m = createMirror({ fs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow, onState: (st, code) => states.push(`${st}:${code ?? ''}`) });
    expect(await m.probe()).toBe(false);
    expect(m.state).toBe('offline');
    m.copy('registry', `${runId(1)}.json`, 'x');
    expect(m.pending).toBe(1); // held, never dropped
    await m.flush();
    // the volume comes back
    fs.rules.length = 0;
    await m.retry();
    expect(m.state).toBe('online');
    expect(m.pending).toBe(0);
    expect((await nodeFs.readBounded(s.paths.heartbeatFile(DEV_A, runId(1)), 64)).text).toBe('x');
    expect(states.some((x) => x.startsWith('offline'))).toBe(true);
    expect(states.some((x) => x.startsWith('online'))).toBe(true);
  });

  it('§9.2: a read-back that does not match is EIO, not a silent success (a lagging / caching client)', async () => {
    const s = await shared();
    const clock = fakeClock();
    let n = 0;
    const fs = { ...nodeFs, readBounded: async (p: string, max: number) => (n++ === 0 ? { text: 'half', bytes: 4, overflow: false } : nodeFs.readBounded(p, max)) };
    const m = createMirror({ fs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow });
    await m.probe();
    m.copy('registry', `${runId(1)}.json`, 'the real bytes');
    await m.flush().catch(() => undefined);
    expect(m.state).toBe('offline');
    expect(m.offlineCode).toBe('EIO');
  });

  it('listDevices excludes OUR OWN subtree and every name that is not a device id (blocker 6)', async () => {
    const s = await shared();
    const clock = fakeClock();
    await nodeFs.mkdir(s.paths.deviceDir('registry', DEV_A), 0o700);
    await nodeFs.mkdir(s.paths.deviceDir('registry', DEV_B), 0o700);
    await nodeFs.mkdir(join(s.paths.kindRoot('registry'), 'NOT-A-DEVICE'), 0o700);
    const m = createMirror({ fs: nodeFs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow });
    expect(await m.listDevices('registry')).toEqual([DEV_B]);
  });

  it('a kind dir that does not exist yet is not offline; a vanished ROOT is', async () => {
    const s = await shared();
    const clock = fakeClock();
    const m = createMirror({ fs: nodeFs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow });
    expect(await m.listDevices('leases')).toEqual([]);
    expect(m.state).not.toBe('offline');
    await nodeFs.rmTree(s.root);
    expect(await m.listDevices('leases')).toEqual([]);
    expect(m.state).toBe('offline');
    expect(m.offlineSinceMono).not.toBeNull();
  });

  it('`sessions sync disable` removes our five subtrees and nothing else', async () => {
    const s = await shared();
    const clock = fakeClock();
    const m = createMirror({ fs: nodeFs, sharedDir: s.sharedDir, deviceId: DEV_A, monotonicNow: clock.monotonicNow });
    await m.probe();
    m.copy('registry', `${runId(1)}.json`, 'a');
    await m.flush();
    await nodeFs.mkdir(s.paths.deviceDir('registry', DEV_B), 0o700);
    await m.disable();
    await expect(nodeFs.stat(s.paths.deviceDir('registry', DEV_A))).rejects.toThrow();
    await expect(nodeFs.stat(s.paths.deviceDir('registry', DEV_B))).resolves.toBeTruthy();
  });

  it('the per-op timeout is 5 s and an `.icloud` placeholder is recognised by name', () => {
    expect(MIRROR_OP_TIMEOUT_MS).toBe(5_000);
    expect(ICLOUD_PLACEHOLDER_RE.test('.20260921-110001-aaaaaaab.json.icloud')).toBe(true);
    expect(ICLOUD_PLACEHOLDER_RE.test('20260921-110001-aaaaaaab.json')).toBe(false);
  });
});

describe('the ledger over a mirror (§9.1, §11 rows 5 / 14 / 48)', () => {
  async function ledgerWithMirror(o: { faults?: Parameters<typeof faultFs>[1] } = {}) {
    const s = await shared();
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const timers = fakeTimers();
    const fs = faultFs(nodeFs, o.faults ?? []);
    const l = openLedger({ home: t.home, self: makeSelf(), sharedDir: s.sharedDir, now: clock.now, monotonicNow: clock.monotonicNow, fs, timers, isPidAlive: () => true, pid: 4242, scanOnly: true });
    cleanups.push(() => l.close());
    return { s, t, l, clock, timers, fs };
  }

  it('a peer’s record in the mirror is folded as FOREIGN and judged by arrival time', async () => {
    const { s, l } = await ledgerWithMirror();
    const rid = runId(9);
    const hb = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, pid: 900, claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(9, DEV_B, rid) });
    await putFile(s.paths.heartbeatFile(DEV_B, rid), serializeRecord(hb));
    await l.open();
    expect(l.fold.live.has(rid)).toBe(true);
    expect(l.fold.origins.get(`${DEV_B}/${rid}`)).toMatchObject({ self: false, source: s.root });
    expect(l.foreignLive(rid, { includeUnverified: true })?.authority).toBe('unverified');
    expect(l.foreignLive(rid)).toBeNull(); // + review major 7: verified-only is the default, so a mirror plant cannot stop us
  });

  it('review blocker 6: a record planted under MY device id in the mirror is never folded as mine', async () => {
    const { s, l } = await ledgerWithMirror();
    // exactly the bytes my own writer would produce — but in the shared folder
    await putFile(s.paths.heartbeatFile(DEV_A, runId(1)), serializeRecord(makeHeartbeat({ pid: 1 })));
    await l.open();
    // the mirror never lists our own subtree, so nothing of it reaches the fold at all
    expect(l.fold.live.size).toBe(0);
    expect(l.fold.origins.size).toBe(0);
  });

  it('§11 row 14: a torn copy fails its checksum, is skipped and counted; the next complete sync fixes it', async () => {
    const { s, l } = await ledgerWithMirror();
    const rid = runId(9);
    const hb = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, pid: 900, claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(9, DEV_B, rid) });
    const whole = serializeRecord(hb);
    await putFile(s.paths.heartbeatFile(DEV_B, rid), `${whole.slice(0, whole.length - 40)}}\n`);
    await l.open();
    expect(l.fold.live.size).toBe(0);
    expect(l.fold.skipped).toBeGreaterThanOrEqual(1);
    await putFile(s.paths.heartbeatFile(DEV_B, rid), whole);
    await l.refresh('all');
    expect(l.fold.live.has(rid)).toBe(true);
  });

  it('§11 row 5: an unmounted shared dir at startup never blocks open(); local truth is unaffected', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const changes: FoldChange[] = [];
    const l = openLedger({
      home: t.home,
      self: makeSelf(),
      sharedDir: join(t.home, 'not-mounted'),
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      timers: fakeTimers(),
      isPidAlive: () => true,
      pid: 4242,
      scanOnly: true,
    });
    cleanups.push(() => l.close());
    await putFile(commonsPaths(t.root).heartbeatFile(DEV_A, runId(1)), serializeRecord(makeHeartbeat()));
    await l.open();
    l.subscribe((_f, c) => changes.push(c));
    expect(l.fold.live.size).toBe(1); // local truth
    expect(l.status().mirror).toBe('offline');
    expect(l.status().syncLagMs).toBeNull();
  });

  it('§11 row 48: an offline mirror keeps the peer records it last read until it returns', async () => {
    const { s, l } = await ledgerWithMirror();
    const rid = runId(9);
    const hb = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, pid: 900, claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(9, DEV_B, rid) });
    await putFile(s.paths.heartbeatFile(DEV_B, rid), serializeRecord(hb));
    await l.open();
    expect(l.fold.live.has(rid)).toBe(true);
    await nodeFs.rmTree(s.root); // the volume goes away mid-run
    await l.refresh('all');
    expect(l.fold.live.has(rid) || l.fold.gone.has(rid)).toBe(true); // the facts survive
    expect(l.status().mirror).toBe('offline');
  });

  it('our own write is local-first and mirrored on a separate chain (never awaited by the step path)', async () => {
    const { s, l } = await ledgerWithMirror();
    await l.open();
    await l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false });
    // the local file exists at once; the mirror copy drains on its own chain
    expect((await nodeFs.stat(commonsPaths(l.root).heartbeatFile(DEV_A, runId(1)))).isFile).toBe(true);
    await l.mirror?.flush();
    expect((await nodeFs.stat(s.paths.heartbeatFile(DEV_A, runId(1)))).isFile).toBe(true);
    expect(iso(T0)).toContain('2026');
  });
});
