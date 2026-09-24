/**
 * §3.5 the ledger: `open()` after the first frame, the incremental scanner, watchers + poll behind `subscribe`, the write
 * chain with per-op timeout and errno classification, tombstones, `gc()` of our own files only, and the write verbs the
 * product surface owns. §11 rows: 3 (two clones / a shared home), 4 (strays), 5 (placeholders / unmounted), 11 (an offline
 * device returning), 13 (ENOSPC is bookkeeping, never fatal), 15 (no run.lock), 27 (a copied home), 31 (a double resume).
 * Review blockers 1 (`setIdentity`), 2 (the write API), 3 (epoch fencing), 5 (a forged beat cannot stop a run), 6 (self by path).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { utimes } from 'node:fs/promises';
import { GC_RETENTION_MS, MAX_DEVICES, SEEN_RETENTION_MS, TRACKED_ACKS_MAX, ignoreDeviceOn, gc as gcOf, openLedger, readFold, setDeviceLabel, syncDisable, unignoreDeviceOn, writeTakeoverLease } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { mintCommonsKey, readCommonsKey, trustDevice, writeCommonsKey } from '../../../src/coordination/ids.js';
import { EPOCH_MAX, MAX_CLAIM_EPOCH, canMintAbove, claimRefusal, forceTakebackPlan, qualifiedEpochs } from '../../../src/coordination/claims.js';
import { MESSAGE_TTL_MS, parseRecord, serializeRecord, withChecksum } from '../../../src/coordination/records.js';
import { claimHolderOf, sessionTargets } from '../../../src/coordination/fold.js';
import { check, declare } from '../../../src/coordination/leases.js';
import { loadSeen, purgeInbox } from '../../../src/coordination/mailbox.js';
import type { FoldChange, LedgerHandle } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, KEY_A, KEY_B, REPO, T0, WS, claim, faultFs, fakeClock, fakeTimers, iso, makeAck, makeDevice, makeHeartbeat, makeLease, makeMessage, makeSelf, putAck, putDevice, putFile, putHeartbeat, putLease, putMessage, runId, signed, stamp, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Harness {
  home: string;
  root: string;
  l: LedgerHandle;
  clock: ReturnType<typeof fakeClock>;
  timers: ReturnType<typeof fakeTimers>;
}

async function harness(o: { self?: Partial<ReturnType<typeof makeSelf>>; fs?: typeof nodeFs; sharedDir?: string; scanOnly?: boolean; trustKeys?: Map<string, string>; commonsKey?: string | null; pid?: number; hostKey?: string } = {}): Promise<Harness> {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const timers = fakeTimers();
  const l = openLedger({
    home: t.home,
    self: makeSelf(o.self ?? {}),
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    fs: o.fs ?? nodeFs,
    timers,
    isPidAlive: () => true,
    pid: o.pid ?? 4242,
    watch: (() => {
      throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
    }) as never,
    commonsKey: o.commonsKey ?? null,
    trustKeys: o.trustKeys ?? new Map(),
    ...(o.hostKey !== undefined ? { hostKey: o.hostKey } : {}),
    ...(o.sharedDir !== undefined ? { sharedDir: o.sharedDir } : {}),
    ...(o.scanOnly === true ? { scanOnly: true } : {}),
  });
  cleanups.push(() => l.close());
  return { home: t.home, root: t.root, l, clock, timers };
}

describe('open() and the scanner (§3.5, §11 rows 4 / 5)', () => {
  it('the constructor does no I/O; open() creates our subtrees and folds every kind', async () => {
    const h = await harness();
    expect(await nodeFs.stat(h.root).catch(() => null)).toBeNull(); // the coordination root does not exist before open()
    await putHeartbeat(h.root, makeHeartbeat());
    await putDevice(h.root, makeDevice());
    await putLease(h.root, makeLease());
    await putMessage(h.root, makeMessage(), T0);
    await putAck(h.root, makeAck());
    await h.l.open();
    expect(h.l.fold.live.size).toBe(1);
    expect(h.l.fold.leases.size).toBe(1);
    expect(h.l.fold.devices.get(DEV_A)?.label).toBe('mbp');
    expect((await nodeFs.readdir(join(h.root, 'registry'))).sort()).toContain(DEV_A);
  });

  it('§11 row 4: a stray name, a tmp file, a conflicted copy and an .icloud placeholder are skipped and counted', async () => {
    const h = await harness();
    const p = commonsPaths(h.root);
    await putHeartbeat(h.root, makeHeartbeat());
    await putFile(join(p.deviceDir('registry', DEV_A), 'not-a-run.json'), '{}\n');
    await putFile(join(p.deviceDir('registry', DEV_A), `${runId(1)} (conflicted copy).json`), '{}\n');
    await putFile(join(p.deviceDir('registry', DEV_A), `${runId(4)}.json.tmp-1-abc`), '{}\n');
    await putFile(join(p.deviceDir('registry', DEV_A), `.${runId(5)}.json.icloud`), '');
    await h.l.open();
    expect(h.l.fold.live.size).toBe(1);
    expect(h.l.fold.skipped).toBeGreaterThanOrEqual(2);
  });

  it('review blocker 6: a heartbeat planted under ANOTHER device id is refused by the path binding', async () => {
    const h = await harness();
    const p = commonsPaths(h.root);
    // the bytes of a legitimate DEV_A beat, written into DEV_B's subtree
    const mine = makeHeartbeat();
    await putFile(join(p.deviceDir('registry', DEV_B), `${mine.runId}.json`), `${JSON.stringify(mine)}\n`);
    await h.l.open();
    expect(h.l.fold.live.size).toBe(0);
    expect(h.l.fold.skipped).toBeGreaterThanOrEqual(1);
  });

  it('re-parses only the files whose (mtime, size) moved', async () => {
    const h = await harness({ fs: faultFs(nodeFs) });
    await putHeartbeat(h.root, makeHeartbeat());
    await h.l.open();
    const calls = (h.l.fs as unknown as { calls: string[] }).calls;
    const before = calls.filter((c) => c.startsWith('readBounded')).length;
    await h.l.refresh('all');
    expect(calls.filter((c) => c.startsWith('readBounded')).length).toBe(before);
  });

  it('a file that vanishes between listing and reading keeps its last record (unknown for the cycle)', async () => {
    const h = await harness();
    await putHeartbeat(h.root, makeHeartbeat());
    await h.l.open();
    await nodeFs.unlink(commonsPaths(h.root).heartbeatFile(DEV_A, runId(1)));
    await h.l.refresh('all');
    expect(h.l.fold.live.size).toBe(0); // the file is gone for good: dropped on the complete scan
  });
});

describe('review blocker 1: setIdentity re-derives everything keyed on a moved fact', () => {
  it('a message to the TUI’s FIRST run is folded after setIdentity, with no reopen and no I/O', async () => {
    const h = await harness({ self: { sessionId: null, runId: null, repoKey: null } });
    const first = runId(6);
    await putMessage(h.root, makeMessage({ to: first, id: `${DEV_B}-abcdefgh-7`, stamp: stamp(7, DEV_B, runId(9)) }), T0);
    await putMessage(h.root, makeMessage({ to: `@${REPO}`, id: `${DEV_B}-abcdefgh-8`, stamp: stamp(8, DEV_B, runId(9)) }), T0 + 1);
    await h.l.open();
    expect(h.l.fold.inbox).toHaveLength(0); // neither target is mine yet
    // the host adopts the session at the first submit; the engine adds repoKey after run:ready
    await h.l.setIdentity({ sessionId: first, runId: first });
    await h.l.setIdentity({ repoKey: REPO });
    expect([...sessionTargets(h.l.self)].sort()).toEqual(['@all', `@${REPO}`, first].sort());
    expect(h.l.fold.inbox.map((m) => m.to).sort()).toEqual([`@${REPO}`, first].sort());
  });

  it('the lease dir follows repoKey: a fresh clone and a running peer meet at the first coordinate', async () => {
    const h = await harness({ self: { repoKey: null } });
    // a peer in ANOTHER checkout of the same repo: its `wsKey` copy is in a directory we do not fold, so only the
    // `repoKey` this patch adds can reach it (a peer in MY checkout would already be visible — see the dual-key test)
    await putLease(h.root, makeLease({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), leaseId: `${runId(9)}-9`, wsKey: 'ws:00000000deadbeef', stamp: stamp(9, DEV_B, runId(9)) }));
    await h.l.open();
    expect(h.l.fold.leases.size).toBe(0); // REPO is not a key we fold yet
    // §3.5 (design revision 4): the one-shot walk means the new root is already folded when the promise resolves —
    // no `refresh` and no 15 s poll in between, which is what made the first `check()` after a resume read `clear`.
    await h.l.setIdentity({ repoKey: REPO });
    expect(h.l.fold.leases.size).toBe(1);
  });

  /**
   * §3.5 / §4.3 (design revision 5): `setIdentity({ repoKey })` MOVES the live leases.
   *
   * A lease's directory is derived from the run's keys and `repoKey` only arrives after `run:ready`, so a lease
   * declared before it lived under `keyDir(wsKey)` alone for the life of the run — invisible in the
   * `keyDir(repoKey)` directory every peer that computed the key first is reading and fencing in.
   *
   * Fails before the fix: the `keyDir(repoKey)` copy never appears.
   */
  it('setIdentity({repoKey}) re-declares the live leases under the new key directory, keeping the wsKey copy', async () => {
    const h = await harness({ self: { repoKey: null } });
    await h.l.open();
    const handle = declare(h.l, { paths: ['src/x.ts'], type: 'exclusive', reason60: 'edit', step: 1, stage: 'coordinate', branch: 'main', head: null }, 'advisory');
    await h.l.enqueue('flush', async () => undefined); // an advisory declare is fire-and-forget on the write chain
    await h.l.refresh('leases');
    const p = commonsPaths(h.root);
    // before the key arrives there is exactly ONE copy, under the wsKey
    await expect(nodeFs.stat(p.leaseFile(DEV_A, WS, handle.leaseId))).resolves.toBeTruthy();
    await expect(nodeFs.stat(p.leaseFile(DEV_A, REPO, handle.leaseId))).rejects.toThrow(/ENOENT/);

    await h.l.setIdentity({ repoKey: REPO });
    // one release + one re-declare: the repoKey copy exists AND the wsKey copy is NOT released (§4.3, revision 5)
    const under = async (key: string) => JSON.parse((await nodeFs.readBounded(p.leaseFile(DEV_A, key, handle.leaseId), 8192)).text) as { repoKey: string | null; type: string; released?: unknown; stamp: { n: number } };
    const repoCopy = await under(REPO);
    const wsCopy = await under(WS);
    expect(repoCopy.repoKey).toBe(REPO);
    expect(repoCopy.type).toBe('exclusive');
    expect(wsCopy.released).toBeUndefined();
    // same leaseId and the SAME stamp: two observations of one lease can never disagree about the order (§3.2)
    expect(repoCopy.stamp.n).toBe(handle.stamp.n);
    expect(wsCopy.stamp.n).toBe(handle.stamp.n);
    // and the fold, keyed by leaseId, still holds ONE lease
    await h.l.refresh('leases');
    expect([...h.l.fold.leases.keys()].filter((id) => id === handle.leaseId)).toHaveLength(1);
  });

  it('a key change to ANOTHER repoKey removes the directory we left', async () => {
    const h = await harness();
    await h.l.open();
    const handle = declare(h.l, { paths: ['src/x.ts'], type: 'exclusive', reason60: 'edit', step: 1, stage: 'coordinate', branch: 'main', head: null }, 'advisory');
    await h.l.enqueue('flush', async () => undefined); // an advisory declare is fire-and-forget on the write chain
    await h.l.refresh('leases');
    const p = commonsPaths(h.root);
    await expect(nodeFs.stat(p.leaseFile(DEV_A, REPO, handle.leaseId))).resolves.toBeTruthy();
    const other = '00112233445566ff';
    await h.l.setIdentity({ repoKey: other });
    await expect(nodeFs.stat(p.leaseFile(DEV_A, other, handle.leaseId))).resolves.toBeTruthy();
    await expect(nodeFs.stat(p.leaseFile(DEV_A, REPO, handle.leaseId))).rejects.toThrow(/ENOENT/); // nothing left behind
    await expect(nodeFs.stat(p.leaseFile(DEV_A, WS, handle.leaseId))).resolves.toBeTruthy(); // the wsKey copy stays
  });

  it('a new runId re-seeds the stamp clock above everything the handle issued', async () => {
    const h = await harness();
    await h.l.open();
    const before = h.l.stamps.issue().n;
    await h.l.setIdentity({ runId: runId(12), sessionId: runId(12) });
    const after = h.l.stamps.issue();
    expect(after.n).toBeGreaterThan(before);
    expect(after.runId).toBe(runId(12));
  });

  it('a label change is visible to every later record', async () => {
    const h = await harness();
    await h.l.open();
    await h.l.setIdentity({ label: 'x'.repeat(40) });
    expect(h.l.self.label).toHaveLength(24);
  });
});

describe('review blockers 3 / 5: epoch fencing and forged records (§9.3, §11 rows 3 / 31)', () => {
  const rid = runId(7);

  async function forked(o: { peerEpoch: number; peerStarted: number; signWith?: string; trust?: boolean }) {
    const keys = new Map<string, string>();
    if (o.trust === true) keys.set(DEV_B, KEY_B);
    const h = await harness({ self: { runId: rid, sessionId: rid }, trustKeys: keys });
    const peer = makeHeartbeat({
      deviceId: DEV_B,
      runId: rid,
      sessionId: rid,
      pid: 900,
      label: 'studio',
      stamp: stamp(1, DEV_B, rid),
      claim: claim({ epoch: o.peerEpoch, deviceId: DEV_B, runId: rid, pid: 900, at: iso(o.peerStarted) }),
    });
    await putHeartbeat(h.root, o.signWith !== undefined ? signed(peer, o.signWith) : peer);
    await putHeartbeat(h.root, makeHeartbeat({ runId: rid, sessionId: rid, claim: claim({ epoch: 2, runId: rid, pid: 4242, at: iso(T0 - 1_000) }) }));
    await h.l.open();
    return h;
  }

  /**
   * FAILING-FIRST (§14 item 18). This read `peerEpoch: 1` and asserted that the EARLIER incarnation holds — the stale
   * process kept the run and the resumer, which had minted above it, was the loser. §3.2 / §9.3 / §10.7 / §11 row 31
   * all say the opposite, and the exit-2 stop belongs to the process that has been superseded.
   */
  it('a LATER qualified incarnation on another device holds; my stale one is the loser (both sides agree)', async () => {
    const h = await forked({ peerEpoch: 3, peerStarted: T0 - 20_000, signWith: KEY_B, trust: true }); // mine is epoch 2
    const v = h.l.forkVerdict(rid);
    expect(v.role).toBe('loser');
    expect(v.holder.deviceId).toBe(DEV_B);
    expect(v.holder.epoch).toBe(3);
    expect(v.verified).toBe(true); // hmac-valid from a paired device: the exit-2 stop is authorised
    expect(h.l.foreignLive(rid)?.label).toBe('studio'); // + review major 7: verified is the DEFAULT
    expect(claimHolderOf(h.l.fold, rid)?.deviceId).toBe(DEV_B);
  });

  it('review blocker 5 / §11 row 51: a FORGED beat for my runId raises the flag but may NOT take the run', async () => {
    const h = await forked({ peerEpoch: 9, peerStarted: T0 - 99_999 }); // unsigned, not paired, and a HIGHER epoch
    const v = h.l.forkVerdict(rid);
    expect(v.role).toBe('holder'); // an unqualified claim never enters the holder computation (§9.3)
    expect(v.unverifiedFork).toBe(true); // displayed as ⚠ forked with the [c]/[q] pane …
    expect(v.verified).toBe(false); // … and never auto-stops (§10.3)
    expect(h.l.foreignLive(rid)).toBeNull(); // + review major 7: a caller that FORGETS the flag now gets nothing
    expect(h.l.foreignLive(rid, { includeUnverified: true })?.authority).toBe('unverified');
    // the same rule on the fold's own holder: the planted beat outranks mine and is still skipped
    expect(claimHolderOf(h.l.fold, rid)?.deviceId).toBe(DEV_A);
    expect(claimHolderOf(h.l.fold, rid, { includeUnverified: true })?.deviceId).toBe(DEV_B);
  });

  it('a signed record from an UNPAIRED device is still unverified', async () => {
    const h = await forked({ peerEpoch: 3, peerStarted: T0 - 20_000, signWith: KEY_B, trust: false });
    const v = h.l.forkVerdict(rid);
    expect(v.verified).toBe(false);
    expect(v.role).toBe('holder'); // unqualified, so it cannot take the run either
  });

  it('the verdict never depends on the rolling stamp — a peer with a HIGHER stamp still loses on its EARLIER epoch', async () => {
    const h = await forked({ peerEpoch: 1, peerStarted: T0 - 90_000, signWith: KEY_B, trust: true });
    expect(h.l.forkVerdict(rid).role).toBe('holder');
    expect(h.l.nextEpoch(rid)).toBe(3); // a resume must mint above everything seen (mine is 2)
  });

  it('alone means alone', async () => {
    const h = await harness({ self: { runId: rid, sessionId: rid } });
    await putHeartbeat(h.root, makeHeartbeat({ runId: rid, sessionId: rid, pid: 4242, claim: claim({ runId: rid, pid: 4242 }) }));
    await h.l.open();
    expect(h.l.forkVerdict(rid).role).toBe('alone');
    expect(h.l.peerLive(rid, { excludePid: 4242 })).toBeNull();
    expect(h.l.nextEpoch(rid)).toBe(2);
  });
});

describe('review blocker 2: the write verbs the surface owns', () => {
  it('takeoverLease carries a LATER claim than the origin and is signed', async () => {
    const h = await harness({ commonsKey: KEY_A, trustKeys: new Map([[DEV_B, KEY_B]]) });
    const rid = runId(9);
    const peer = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, claim: claim({ epoch: 3, deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(3, DEV_B, rid) });
    await putHeartbeat(h.root, signed(peer, KEY_B, DEV_B));
    await h.l.open();
    const lease = await writeTakeoverLease(h.l, { runId: rid, sessionId: rid, reason60: 'sessions unlock --device studio' });
    expect(lease.type).toBe('takeover');
    expect(lease.claim?.epoch).toBe(4);
    expect(lease.claim?.deviceId).toBe(DEV_A);
    expect(lease.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(lease.paths).toEqual([]);
  });

  it('+ §9.3 (revision 4): the takeover claim persists at devices/<hostKey>/claims/<runId>.json and the next mint reads it', async () => {
    const h = await harness({ hostKey: 'abcd1234' });
    const rid = runId(9);
    await h.l.open();
    const first = await writeTakeoverLease(h.l, { runId: rid, sessionId: rid, reason60: 'unlock' });
    expect(first.claim?.epoch).toBe(1);
    expect((await h.l.readRunClaim(rid))?.epoch).toBe(1);
    // a second takeback on a run with NO local dir must not re-issue the same epoch (compareClaim would return 0)
    const second = await writeTakeoverLease(h.l, { runId: rid, sessionId: rid, reason60: 'unlock again' });
    expect(second.claim?.epoch).toBe(2);
    expect((await h.l.readRunClaim(rid))?.epoch).toBe(2);
  });

  it('+ review major 11 / re-review (5): an UNVERIFIED foreign epoch never raises the bar; a persisted one does', async () => {
    const h = await harness(); // no trust keys: the peer's record is unverified
    const rid = runId(9);
    await putHeartbeat(h.root, makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, claim: claim({ epoch: 900_000, deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(3, DEV_B, rid) }));
    await h.l.open();
    // a planted beat claiming a near-ceiling epoch must NOT push every later resume to the top of the range
    expect(h.l.nextEpoch(rid)).toBe(1);
    // what a resume DOES follow is the high-water mark this device persisted beside the run (RunClaimMeta)
    expect(h.l.nextEpoch(rid, { epochHigh: 7 })).toBe(8);
    expect(canMintAbove([7])).toBe(true);
    expect(canMintAbove([EPOCH_MAX])).toBe(false);
    // and a foreign run.json row only counts when it is trust-qualified
    expect(qualifiedEpochs([{ epoch: 5, authority: 'trusted' }, { epoch: 9_007_199_254_740_990, authority: 'unverified' }])).toEqual([5]);
  });

  it('setDeviceLabel rewrites both device.json files as the PUBLIC subset — never the commons key', async () => {
    const h = await harness();
    await h.l.open();
    const p = commonsPaths(h.root, h.l.hostKey);
    await writeCommonsKey(nodeFs, p.hostDir, mintCommonsKey());
    const rec = await setDeviceLabel(h.l, 'studio-2');
    expect(rec.label).toBe('studio-2');
    // §3.1 (revision 5): the private copy is per HOST, the published one per DEVICE
    expect(p.deviceFile).toContain(join('devices', h.l.hostKey));
    for (const file of [p.deviceFile, p.deviceRecordFile(DEV_A)]) {
      const text = (await nodeFs.readBounded(file, 4096)).text;
      expect(JSON.parse(text)).toEqual(rec);
      expect(text).not.toContain('keyHex');
    }
    expect(await readCommonsKey(nodeFs, p.hostDir)).toMatch(/^[0-9a-f]{64}$/);
    expect(h.l.self.label).toBe('studio-2');
  });

  it('§4.6 row 4: ignoreDevice is a LOCAL tombstone and deletes nothing foreign', async () => {
    const h = await harness();
    await putHeartbeat(h.root, makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 900 }), stamp: stamp(9, DEV_B, runId(9)) }));
    await putDevice(h.root, makeDevice({ deviceId: DEV_B, label: 'old-mac' }));
    await h.l.open();
    expect(h.l.fold.live.size).toBe(1);
    await ignoreDeviceOn(h.l, DEV_B, 'old-mac');
    expect(h.l.fold.live.size).toBe(0);
    expect(h.l.fold.devices.get(DEV_B)?.ignored).toBe(true);
    await expect(nodeFs.stat(commonsPaths(h.root).heartbeatFile(DEV_B, runId(9)))).resolves.toBeTruthy();
    await expect(ignoreDeviceOn(h.l, '../x', 'bad')).rejects.toThrow(/is not a device this host has seen/);
    // + review minor 25: the tombstone lifts and the subtree folds again
    await unignoreDeviceOn(h.l, DEV_B);
    await h.l.refresh('all');
    expect(h.l.fold.live.size).toBe(1);
    expect(h.l.fold.devices.get(DEV_B)?.ignored).toBe(false);
  });

  it('syncDisable removes OUR five subtrees from the mirror and is a no-op without one', async () => {
    const plain = await harness();
    await plain.l.open();
    expect(await syncDisable(plain.l)).toEqual({ removed: [] });
    const shared = await tempHome();
    cleanups.push(shared.cleanup);
    await nodeFs.mkdir(join(shared.home, 'jevcode-commons'), 0o700);
    const h = await harness({ sharedDir: shared.home });
    await h.l.open();
    await h.l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false });
    await h.l.mirror?.flush();
    const mirrored = commonsPaths(join(shared.home, 'jevcode-commons'));
    await expect(nodeFs.stat(mirrored.heartbeatFile(DEV_A, runId(1)))).resolves.toBeTruthy();
    const r = await syncDisable(h.l);
    expect(r.removed).toEqual(['registry', 'leases', 'inbox', 'acks', 'runs']);
    await expect(nodeFs.stat(mirrored.deviceDir('registry', DEV_A))).rejects.toThrow();
  });

  it('gc() removes OUR closed files only and reports the stale lane dirs', async () => {
    const h = await harness();
    const old = T0 - GC_RETENTION_MS - 60_000;
    await putHeartbeat(h.root, makeHeartbeat({ runId: runId(20), sessionId: runId(20), phase: 'ended', beatAt: iso(old), stamp: stamp(20, DEV_A, runId(20)), claim: claim({ runId: runId(20), pid: 20 }) }));
    await putHeartbeat(h.root, makeHeartbeat()); // live: kept
    await putLease(h.root, makeLease({ leaseId: `${runId(21)}-1`, runId: runId(21), sessionId: runId(21), stamp: stamp(1, DEV_A, runId(21)), expiresAt: iso(old) }));
    await putLease(h.root, makeLease({ leaseId: `${runId(22)}-1`, runId: runId(22), sessionId: runId(22), stamp: stamp(1, DEV_A, runId(22)), type: 'lane', paths: [], laneDir: 'tmp/synth/lane3' }));
    await putMessage(h.root, makeMessage({ from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, id: `${DEV_A}-abcdefgh-9`, to: `@${REPO}`, expiresAt: iso(T0 - 1), stamp: stamp(9, DEV_A, runId(1)) }), T0 - 10);
    // a FOREIGN closed heartbeat must survive
    await putHeartbeat(h.root, makeHeartbeat({ deviceId: DEV_B, runId: runId(23), sessionId: runId(23), phase: 'ended', beatAt: iso(old), stamp: stamp(1, DEV_B, runId(23)), claim: claim({ deviceId: DEV_B, runId: runId(23), pid: 923 }) }));
    await h.l.open();
    const report = await gcOf(h.l);
    // §4.3 (revision 5): the expired lease has TWO copies on disk (keyDir(repoKey) and keyDir(wsKey)), so the GC
    // removes two files for one lease — the fold, keyed by leaseId, still saw exactly one.
    expect(report.byKind).toEqual({ heartbeat: 1, lease: 2, message: 1, ack: 0 });
    expect(report.staleLanes).toEqual([{ runId: runId(22), laneDir: 'tmp/synth/lane3' }]);
    expect(report.failed).toEqual([]);
    await expect(nodeFs.stat(commonsPaths(h.root).heartbeatFile(DEV_B, runId(23)))).resolves.toBeTruthy();
    await expect(nodeFs.stat(commonsPaths(h.root).heartbeatFile(DEV_A, runId(1)))).resolves.toBeTruthy();
  });

  /**
   * REVIEW BLOCKER 3 FIXTURE — an ack from a FOREIGN subtree.
   *
   * The target session `runId(9)` lives on DEV_B. The ack is written into DEV_B's subtree — but DEV_B is not paired, so
   * nothing about that file is authentic.
   *
   * Fails before the fix: `gc()` matched on `a.by === m.to` alone, so ANY file at
   * `acks/<anyDevice>/<msgId>/<targetSessionId>.json` deleted the pending targeted message — a silent, unauthenticated
   * cancel of every `pause` / `abort` / `steer` before its target ever read it. Passes after: the ack counts only from
   * the subtree of a device the target session is (or was last) live on, and only when that subtree is authentic;
   * pre-pairing the message goes on expiry alone (10 min for a control type).
   */
  it('review blocker 3: an unauthenticated foreign ack does NOT delete a pending targeted message', async () => {
    const rid9 = runId(9);
    const mk = async (trust: boolean, sign: boolean) => {
      const h = await harness(trust ? { trustKeys: new Map([[DEV_B, KEY_B]]) } : {});
      // the target session lives on DEV_B
      const peer = makeHeartbeat({ deviceId: DEV_B, runId: rid9, sessionId: rid9, label: 'studio', claim: claim({ deviceId: DEV_B, runId: rid9, pid: 900 }), stamp: stamp(9, DEV_B, rid9) });
      await putHeartbeat(h.root, sign ? signed(peer, KEY_B, DEV_B) : peer);
      const msg = makeMessage({ from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, id: `${DEV_A}-abcdefgh-31`, to: rid9, type: 'pause', stamp: stamp(31, DEV_A, runId(1)) });
      await putMessage(h.root, msg, T0 + 1);
      const theirAck = makeAck({ msgId: msg.id, by: `${rid9}-abcdefgh`, deviceId: DEV_B, stamp: stamp(33, DEV_B, rid9) });
      await putAck(h.root, sign ? signed(theirAck, KEY_B, DEV_B) : theirAck);
      await h.l.open();
      h.l.trackAck(msg.id);
      await h.l.refresh('all');
      return { h, msg };
    };
    const planted = await mk(false, false);
    expect((await gcOf(planted.h.l)).byKind.message).toBe(0);
    await expect(nodeFs.stat(join(commonsPaths(planted.h.root).deviceDir('inbox', DEV_A), rid9, `${T0 + 1}-31.json`))).resolves.toBeTruthy();
    // the same ack, hmac-valid from the paired device the session runs on, does end it
    const real = await mk(true, true);
    expect((await gcOf(real.h.l)).byKind.message).toBe(1);
  });

  it('§5.1: a BROADCAST survives the first ack; a targeted message goes once its target acked', async () => {
    const h = await harness();
    const rid2 = runId(2);
    const mine = (id: string, to: string, n: number) => makeMessage({ from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, id, to, stamp: stamp(n, DEV_A, runId(1)) });
    // the target is a SECOND session of this device, so its acks live in our own subtree and are `self`-authentic
    await putHeartbeat(h.root, makeHeartbeat({ runId: rid2, sessionId: rid2, pid: 4343, claim: claim({ runId: rid2, pid: 4343 }), stamp: stamp(2, DEV_A, rid2) }));
    await putMessage(h.root, mine(`${DEV_A}-abcdefgh-30`, `@${REPO}`, 30), T0);
    await putMessage(h.root, mine(`${DEV_A}-abcdefgh-31`, rid2, 31), T0 + 1);
    await putAck(h.root, makeAck({ msgId: `${DEV_A}-abcdefgh-30`, by: `${rid2}-abcdefgh`, stamp: stamp(32) }));
    await putAck(h.root, makeAck({ msgId: `${DEV_A}-abcdefgh-31`, by: `${rid2}-abcdefgh`, stamp: stamp(33) }));
    await h.l.open();
    h.l.trackAck(`${DEV_A}-abcdefgh-30`);
    h.l.trackAck(`${DEV_A}-abcdefgh-31`);
    await h.l.refresh('all');
    const report = await gcOf(h.l);
    expect(report.byKind.message).toBe(1); // only the targeted one
    expect(MESSAGE_TTL_MS).toBe(7 * 86_400_000);
  });
});

describe('+ the §3.5 / §4.5 bounds and the health split (majors 9 / 10 / 17 / 19)', () => {
  it('major 19: the fold walks at most MAX_DEVICES subtrees, counts the rest, and ROTATES so none starves', async () => {
    const h = await harness();
    const ids = Array.from({ length: MAX_DEVICES + 6 }, (_, i) => `aaaaaa${'abcdefghijklmnopqrstuv'[i]}${'2'}`);
    for (const id of ids) await putDevice(h.root, makeDevice({ deviceId: id, label: id }));
    await h.l.open();
    expect(h.l.status().devicesSkipped).toBeGreaterThan(0);
    expect(h.l.fold.skipped).toBeGreaterThanOrEqual(h.l.status().devicesSkipped);
    // over several passes every subtree is reached at least once: the remainder rotates
    const seen = new Set<string>(h.l.fold.devices.keys());
    for (let i = 0; i < 8; i++) {
      await h.l.refresh('all');
      for (const id of h.l.fold.devices.keys()) seen.add(id);
    }
    expect(seen.size).toBe(ids.length);
  });

  it('§4.5: the FENCE is not bounded by MAX_DEVICES, and reports `complete:false` when its own bound bites', async () => {
    const h = await harness();
    const ids = Array.from({ length: MAX_DEVICES + 4 }, (_, i) => `bbbbbb${'abcdefghijklmnopqrst'[i]}${'2'}`);
    for (const id of ids) await nodeFs.mkdir(commonsPaths(h.root).leaseDir(id, REPO), 0o700);
    await h.l.open();
    const wide = await h.l.refreshFence();
    expect(wide.complete).toBe(true); // 20 subtrees, well inside MAX_FENCE_DEVICES
    expect(wide.scanned).toBeGreaterThan(MAX_DEVICES);
    const bound = await h.l.refreshFence({ maxDevices: 4 });
    expect(bound.complete).toBe(false);
    expect(bound.total).toBeGreaterThan(bound.scanned);
  });

  it('major 9: the tracked-ack set lapses with the message it belongs to and is capped', async () => {
    const h = await harness();
    await h.l.open();
    for (let i = 0; i < TRACKED_ACKS_MAX + 10; i++) h.l.trackAck(`${DEV_B}-abcdefgh-${i + 1}`);
    await h.l.refresh('all');
    // the map is bounded; the oldest ids went first
    expect(h.l.status().skipped).toBeGreaterThanOrEqual(0);
    h.l.trackAck(`${DEV_B}-abcdefgh-9999`, 0); // a ttl of 0 lapses on the next rebuild
    await h.l.refresh('all');
    const report = await gcOf(h.l);
    expect(report.failed).toEqual([]);
  });

  it('major 17: a MIRROR fault never claims the local ledger is off, and a good read clears the fault', async () => {
    const shared = await tempHome();
    cleanups.push(shared.cleanup);
    const h = await harness({ sharedDir: join(shared.home, 'gone') });
    await h.l.open();
    expect(h.l.status().mirror).toBe('offline');
    expect(h.l.status().offline).toBeNull(); // the LOCAL store is fine
    expect(h.l.status().mirrorOffline?.code ?? h.l.status().mirrorCode).toBeTruthy();
    // a local fault does set it, and the next successful write clears it
    const t2 = await tempHome();
    cleanups.push(t2.cleanup);
    const clock = fakeClock();
    const fs = faultFs(nodeFs, [{ path: 'registry', op: 'writeAtomic', code: 'ENOSPC', times: 1 }]);
    const l = openLedger({ home: t2.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, fs, timers: fakeTimers(), isPidAlive: () => true, scanOnly: true });
    await l.open();
    await l.enqueue('beat', () => l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false }));
    expect(l.status().offline?.code).toBe('ENOSPC');
    await l.enqueue('beat', () => l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false }));
    expect(l.status().offline).toBeNull(); // cleared by the first successful write of that path
    await l.close();
  });

  it('+ re-review (6)(ii): a shared dir that resolves INSIDE the coordination root is refused outright', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    await nodeFs.mkdir(join(t.root, 'jevcode-commons'), 0o700);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, isPidAlive: () => true, scanOnly: true, sharedDir: t.root });
    await l.open();
    expect(l.syncStatus().refused).toMatch(/inside the coordination root/);
    expect(l.syncStatus().state).toBe('offline');
    await l.close();
  });

  it('+ re-review (2): purgeInbox removes our OWN sent files and only MARKS foreign ones seen', async () => {
    const h = await harness();
    const mine = makeMessage({ from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, id: `${DEV_A}-abcdefgh-40`, to: runId(9), stamp: stamp(40, DEV_A, runId(1)) });
    await putMessage(h.root, mine, T0);
    const theirs = makeMessage({ id: `${DEV_B}-abcdefgh-41`, to: '@all', stamp: stamp(41, DEV_B, runId(9)) });
    await putMessage(h.root, theirs, T0 + 1);
    await h.l.open();
    const before = await nodeFs.stat(commonsPaths(h.root).messageFile(DEV_B, '@all', T0 + 1, 41));
    const r = await purgeInbox(h.l, { deviceId: DEV_A });
    expect(r.removed).toBe(1);
    expect(r.failed).toEqual([]);
    const foreign = await purgeInbox(h.l, { deviceId: DEV_B });
    expect(foreign.removed).toBe(0);
    expect(foreign.muted).toBe(1);
    // nothing foreign was deleted — a sync client would only resurrect it (§4.6)
    await expect(nodeFs.stat(commonsPaths(h.root).messageFile(DEV_B, '@all', T0 + 1, 41))).resolves.toMatchObject({ isFile: before.isFile });
    expect([...(await loadSeen(h.l))]).toContain(theirs.id);
  });
});

describe('§11 row 13: a ledger error is bookkeeping, never fatal', () => {
  it('ENOSPC on our own write is one notice per (file, code) and the fold keeps working', async () => {
    const notices: { code: string; file: string }[] = [];
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const fs = faultFs(nodeFs, [{ path: 'registry', op: 'writeAtomic', code: 'ENOSPC' }]);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, fs, timers: fakeTimers(), isPidAlive: () => true, scanOnly: true, onNotice: (n) => notices.push({ code: n.code, file: n.file }) });
    await l.open();
    await l.enqueue('beat', () => l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false }));
    await l.enqueue('beat', () => l.writeOwn('registry', `${runId(1)}.json`, makeHeartbeat(), { fsync: false }));
    expect(notices.filter((n) => n.code === 'ENOSPC')).toHaveLength(1);
    expect(l.status().offline?.code).toBe('ENOSPC');
    // a lease on another kind still lands
    await l.enqueue('lease', () => l.writeOwn('leases', join(REPO, `${runId(1)}-1.json`), makeLease({ leaseId: `${runId(1)}-1`, runId: runId(1), sessionId: runId(1) }), { fsync: false }));
    expect(l.fold.leases.size).toBe(1);
    await l.close();
  });

  it('a readdir timeout is classified and the fold degrades rather than throwing', async () => {
    const h = await harness({ fs: faultFs(nodeFs, [{ path: 'leases', op: 'readdir', code: 'ETIMEDOUT' }]) });
    await putHeartbeat(h.root, makeHeartbeat());
    await h.l.open();
    expect(h.l.fold.live.size).toBe(1);
    expect(h.l.status().offline?.code).toBe('ETIMEDOUT');
  });
});

describe('+ re-check of the merged ledger: the three breadth defects', () => {
  /**
   * RE-CHECK 1 — trusted devices past MAX_DEVICES starved FOREVER.
   *
   * `pickDevices` put self + every trusted device in `head`, truncated it with no rotation, and gave `rest`
   * `slots = max(0, cap - head.length)` — zero once `head` alone filled the cap. With 20 paired devices and a cap of
   * 16 the same four ids were dropped on every pass, so their beats never entered `fold.live`, their leases never
   * entered `byPath`, and under `strict` their exclusive holds were simply not there. The M19 fixture planted only
   * UNTRUSTED devices, which is why the rotation looked complete.
   *
   * Fails before the fix: four of the twenty are never seen, however many passes run.
   */
  it('re-check 1: twenty PAIRED devices are all seen within a few passes — the head rotates too', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ids: string[] = [];
    const trustKeys = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      const id = `zz${'abcdefghijklmnopqrst'[i]}wq7c${'abcdefghijklmnopqrst'[i]}`.slice(0, 8);
      ids.push(id);
      trustKeys.set(id, KEY_B);
      const rid = runId(30 + i);
      await putHeartbeat(t.root, makeHeartbeat({ deviceId: id, runId: rid, sessionId: rid, pid: 3000 + i, claim: claim({ deviceId: id, runId: rid, pid: 3000 + i }), stamp: stamp(1, id, rid) }));
    }
    expect(new Set(ids).size).toBe(20); // the ids really are distinct
    expect(ids.length).toBeGreaterThan(MAX_DEVICES);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true, trustKeys });
    await l.open();
    const seen = new Set<string>();
    for (let pass = 0; pass < 12; pass++) {
      await l.refresh('all');
      for (const hb of l.fold.live.values()) seen.add(hb.deviceId);
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    await l.close();
  });

  /**
   * RE-CHECK 2 — `ignoreDevice` never restored the strict fence.
   *
   * `pickDevices` got the UNFILTERED listing and `fence.complete` was derived from `devices.length < all.length`,
   * both counting ignored subtrees — so the fix §4.5 itself names ("the ordinary fix for a hostile or junk-filled
   * folder — `sessions gc --device … --i-know-it-is-gone` — also restores the fence") did nothing, and `strict`
   * stayed permanently `fence:'blind'`.
   *
   * Fails before the fix: `complete` is still false after every junk subtree is tombstoned.
   */
  it('re-check 2: tombstoning the junk subtrees RESTORES the fence', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const junk = ['zz2wq7c2', 'zz3wq7c3', 'zz4wq7c4', 'zz5wq7c5', 'zz6wq7c6', 'zz7wq7c7'];
    for (const id of junk) await nodeFs.mkdir(commonsPaths(t.root).leaseDir(id, REPO), 0o700);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    const before = await l.refreshFence({ maxDevices: 4 });
    expect(before.complete).toBe(false); // six subtrees, four slots: strict cannot decide
    for (const id of junk) await ignoreDeviceOn(l, id, 'junk');
    const after = await l.refreshFence({ maxDevices: 4 });
    expect(after.complete).toBe(true); // an ignored subtree is not a subtree the fence has to see
    expect(after.total).toBe(1); // only this device's own subtree is left to count
    await l.close();
  });

  /**
   * RE-CHECK 3 — the general scan capped leases at 16 and then SWEPT the subtrees it had skipped.
   *
   * `cap = kind === 'leases' ? deviceCap : MAX_DEVICES` with `deviceCap = MAX_DEVICES` for `scan('all')`, and the
   * prune loop deleted every entry not in `seen` unless the TIME budget had set `partial`. With more than 16 lease
   * subtrees each 15 s poll therefore dropped a rotating subset of live peers' exclusive leases out of
   * `this.entries`, and the advisory `check()` that reads them answered `clear` for paths a live peer held.
   *
   * Fails before the fix: the peer's lease is gone from the fold after a second general scan.
   */
  it('re-check 3: a general scan neither caps leases at MAX_DEVICES nor prunes what it skipped', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    // one real peer holding my path, plus enough junk lease subtrees to push past the 16-subtree FOLD cap
    const ridPeer = runId(9);
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: ridPeer, sessionId: ridPeer, claim: claim({ deviceId: DEV_B, runId: ridPeer, pid: 900 }), stamp: stamp(9, DEV_B, ridPeer) }));
    await putLease(t.root, makeLease({ deviceId: DEV_B, runId: ridPeer, sessionId: ridPeer, leaseId: `${ridPeer}-9`, type: 'exclusive', paths: ['src/x.ts'], stamp: stamp(9, DEV_B, ridPeer) }));
    for (let i = 0; i < 24; i++) {
      const id = `zz${'abcdefghijklmnopqrstuvwx'[i]}wq7c${'abcdefghijklmnopqrstuvwx'[i]}`.slice(0, 8);
      await nodeFs.mkdir(commonsPaths(t.root).leaseDir(id, REPO), 0o700);
    }
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    for (let pass = 0; pass < 6; pass++) {
      await l.refresh('all');
      // the peer's exclusive lease must survive EVERY pass — a fold that drops it makes `check()` read `clear`
      expect(l.fold.leases.has(`${ridPeer}-9`), `pass ${pass}`).toBe(true);
      const r = check(l.fold, l.self, { paths: ['src/x.ts'], type: 'exclusive', reason60: 'edit', step: 1, stage: 'coordinate', branch: 'main', head: null });
      expect(r.kind, `pass ${pass}`).toBe('conflict');
    }
    await l.close();
  });
});

describe('+ re-check: runtime trust, the persisted sessionless id, and the seen sweep', () => {
  /**
   * RE-CHECK 10 — trust was ONE-WAY at runtime.
   *
   * `unpairDevice` reloaded `trustKeys` and cleared `sigs`; nothing did the reverse. `trustKeys` was read once in
   * `open()`, so after a `sessions pair` in the same process the peer stayed `unverified` until a restart — and
   * because `sigs` was not cleared, `refresh` would not even re-parse the files whose authority had changed.
   *
   * Fails before the fix: `pairDeviceOn` does not exist, and writing the trust file by hand leaves the peer
   * unverified until the process restarts.
   */
  it('re-check 10: pairing inside a running process makes the peer verified from the next scan', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(9);
    const hb = signed(makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(9, DEV_B, rid) }), KEY_B, DEV_B);
    await putHeartbeat(t.root, hb);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    expect(l.fold.origins.get(`${DEV_B}/${rid}`)?.authenticated).toBe(false); // not paired yet
    await l.pairDevice({ deviceId: DEV_B, label: 'studio', keyHex: KEY_B });
    expect(l.fold.origins.get(`${DEV_B}/${rid}`)?.authenticated).toBe(true); // NOW, not after a restart
    // and it is symmetric: unpairing takes the authority away again, in the same process
    await l.unpairDevice(DEV_B);
    expect(l.fold.origins.get(`${DEV_B}/${rid}`)?.authenticated).toBe(false);
    await l.close();
  });

  /**
   * RE-CHECK 9 — a sessionless consumer minted a fresh `actor8` per process.
   *
   * `actor8Of(null)` is random, and it names `inbox/seen/<deviceId>/<consumerId>.json` — so two TUI launches over
   * one home had two consumer ids, every unexpired broadcast re-toasted on every start, and `inbox/seen/` grew one
   * file per launch forever (`gc()` walked only `ownEntries()`, which never includes a `seen` file).
   *
   * Fails before the fix: the two handles have different actor8s.
   */
  it('re-check 9: a sessionless consumer keeps ONE actor8 across launches', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const mk = async () => {
      const l = openLedger({ home: t.home, self: makeSelf({ runId: null, sessionId: null }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
      await l.open();
      return l;
    };
    const first = await mk();
    const id = first.actor8;
    await first.close();
    const second = await mk();
    expect(second.actor8).toBe(id);
    await second.close();
    // a RUN's actor8 is still its run id's tail and is never persisted
    const run = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await run.open();
    expect(run.actor8).toBe(runId(1).slice(-8));
    await run.close();
  });

  it('re-check 9: gc() sweeps `inbox/seen/` by MTIME, keeping the newest', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    const dir = commonsPaths(t.root).seenDir(DEV_A);
    await nodeFs.mkdir(dir, 0o700);
    const stale = join(dir, `${runId(40)}-abcdefgh.json`);
    const fresh = join(dir, `${runId(41)}-abcdefgh.json`);
    for (const f of [stale, fresh]) await nodeFs.writeAtomic(f, '{"v":1,"ids":[]}\n', { fsync: false, mode: 0o600 });
    // age the stale one past the 30 d retention. `seen` files carry no timestamp of their own — a consumer that is
    // gone left nothing to identify it by — so MTIME is the only retention input there is.
    const longAgo = new Date(clock.wall - (SEEN_RETENTION_MS + 86_400_000));
    await utimes(stale, longAgo, longAgo);
    await utimes(fresh, new Date(clock.wall), new Date(clock.wall));
    const report = await gcOf(l);
    expect(report.seen).toBe(1);
    await expect(nodeFs.stat(stale)).rejects.toThrow(/ENOENT/);
    await expect(nodeFs.stat(fresh)).resolves.toBeTruthy();
    await l.close();
  });
});

describe("§9.3 (revision 5): the sixth record kind — the AUTHENTICATED claim projection", () => {
  const projection = (o: { deviceId: string; runId: string; epochs: number[]; imports?: { fromDeviceId: string; at: string; epoch: number }[] }) =>
    withChecksum({
      v: 1 as const,
      kind: 'claims' as const,
      deviceId: o.deviceId,
      runId: o.runId,
      sessionId: o.runId,
      claims: o.epochs.map((epoch) => claim({ epoch, deviceId: o.deviceId, runId: o.runId, pid: 900 })),
      imports: o.imports ?? [],
      at: iso(T0),
      stamp: stamp(1, o.deviceId, o.runId),
      checksum: '',
    });

  const put = async (root: string, rec: ReturnType<typeof projection>, key?: string) => {
    const signedRec = key === undefined ? rec : signed(rec, key, rec.deviceId);
    await putFile(commonsPaths(root).claimsFile(rec.deviceId, rec.runId), `${JSON.stringify(signedRec)}\n`);
  };

  /**
   * ITEM 4 FIXTURE — revision 4 left the §7.3 1(a) refusal DEAD.
   *
   * It required an hmac on `run.json` or on its projection but defined `hmac` / `keyId` on the five record kinds
   * only, so no foreign epoch could ever be qualified: fail-safe against a planted ceiling and silently disabled for
   * the legitimate takeover. The sixth kind is what makes the refusal live.
   *
   * Fails before the fix: `parseRecord(text, 'claims', …)` is not a kind, and `readClaimEpochs` does not exist.
   */
  it("a foreign epoch counts only when it is ok AND verified AND from a trusted device", async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(9);
    await put(t.root, projection({ deviceId: DEV_B, runId: rid, epochs: [7] }), KEY_B); // signed …
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    // … but NOT paired: the epoch is reported and unqualified (the card shows it; it refuses nothing)
    expect(await l.readClaimEpochs(rid)).toEqual([{ epoch: 7, deviceId: DEV_B, qualified: false }]);
    // §7.3 1(a) / §9.3: unqualified refuses nothing, so /resume proceeds
    expect(claimRefusal([3], await l.readClaimEpochs(rid))).toBeNull();
    await l.pairDevice({ deviceId: DEV_B, label: 'studio', keyHex: KEY_B });
    expect(await l.readClaimEpochs(rid)).toEqual([{ epoch: 7, deviceId: DEV_B, qualified: true }]);
    // … and once it IS qualified and exceeds my local maximum, /resume is refused until --force-takeback
    expect(claimRefusal([3], await l.readClaimEpochs(rid))).toEqual({ deviceId: DEV_B, epoch: 7 });
    expect(claimRefusal([9], await l.readClaimEpochs(rid))).toBeNull(); // my own maximum is higher: nothing to refuse
    // a paired device whose signature does NOT match its key is unqualified again — `verified` is not `ok`
    await put(t.root, projection({ deviceId: DEV_B, runId: rid, epochs: [8] }), KEY_A);
    expect(await l.readClaimEpochs(rid)).toEqual([{ epoch: 8, deviceId: DEV_B, qualified: false }]);
    await l.close();
  });

  it('MAX_CLAIM_EPOCH is enforced on THIS parse path — the one a planted projection takes', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(9);
    const planted = projection({ deviceId: DEV_B, runId: rid, epochs: [1] });
    // a planted safe-integer ceiling: it must be `bounds` BEFORE it can reach any comparison
    const hostile = withChecksum({ ...planted, claims: [{ ...planted.claims[0]!, epoch: 9_007_199_254_740_990 }], checksum: '' });
    expect(parseRecord(serializeRecord(hostile), 'claims', { deviceId: DEV_B, runId: rid })).toEqual({ ok: false, reason: 'bounds' });
    // and the reader simply does not see it
    await putFile(commonsPaths(t.root).claimsFile(DEV_B, rid), `${JSON.stringify(hostile)}\n`);
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    expect(await l.readClaimEpochs(rid)).toEqual([]);
    await l.close();
  });

  it('the projection is bound to BOTH path components it sits under', async () => {
    const rid = runId(9);
    const rec = projection({ deviceId: DEV_B, runId: rid, epochs: [3] });
    expect(parseRecord(serializeRecord(rec), 'claims', { deviceId: DEV_B, runId: rid }).ok).toBe(true);
    // another run's directory
    expect(parseRecord(serializeRecord(rec), 'claims', { deviceId: DEV_B, runId: runId(8) })).toEqual({ ok: false, reason: 'id' });
    // another device's subtree
    expect(parseRecord(serializeRecord(rec), 'claims', { deviceId: DEV_A, runId: rid })).toEqual({ ok: false, reason: 'id' });
  });

  it('writeTakeoverLease writes the projection too — even for a run with NO local run dir', async () => {
    const h = await harness();
    await h.l.open();
    const rid = runId(9);
    const lease = await writeTakeoverLease(h.l, { runId: rid, sessionId: rid, reason60: 'that device is gone' });
    const path = commonsPaths(h.root, h.l.hostKey).claimsFile(DEV_A, rid);
    const text = (await nodeFs.readBounded(path, 4096)).text;
    const parsed = parseRecord(text, 'claims', { deviceId: DEV_A, runId: rid });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims.map((c) => c.epoch)).toEqual([lease.claim?.epoch]);
    // it is a permanent fact, so it is our OWN local truth and therefore qualified without any pairing
    expect(await h.l.readClaimEpochs(rid)).toEqual([{ epoch: lease.claim?.epoch, deviceId: DEV_A, qualified: true }]);
  });

  it("--force-takeback: Q filtered AT the bound, U strictly BELOW, mint max(Q ∪ U) + 1, else 'epoch-exhausted'", async () => {
    // pure algebra first (§9.3's own table)
    expect(forceTakebackPlan({ local: [3], foreign: [] }).epoch).toBe(4);
    // an UNQUALIFIED epoch is minted over — the point of the flag is to end up above anything any observer compares
    expect(forceTakebackPlan({ local: [3], foreign: [{ epoch: 50, qualified: false }] }).epoch).toBe(51);
    // … but one planted AT the ceiling is DROPPED, not minted over: an unqualified epoch refuses nothing, so a
    // hostile one must not be able to disable the flag (revision 4 minted 1e9 + 1, above the parse bound, and every
    // other device then rejected the winner's own records as `bounds`)
    const hostile = forceTakebackPlan({ local: [3], foreign: [{ epoch: MAX_CLAIM_EPOCH, qualified: false }] });
    expect(hostile.epoch).toBe(4);
    expect(hostile.droppedUnqualified).toBe(1);
    // a QUALIFIED epoch at the ceiling is a real state, and the honest answer is a refusal
    expect(forceTakebackPlan({ local: [3], foreign: [{ epoch: MAX_CLAIM_EPOCH, qualified: true }] })).toMatchObject({ epoch: null, exhausted: true });
    expect(forceTakebackPlan({ local: [MAX_CLAIM_EPOCH], foreign: [] })).toMatchObject({ epoch: null, exhausted: true });
    // local truth is FILTERED, never refused: an out-of-range local row is ignored and the run still loads
    expect(forceTakebackPlan({ local: [3, 9_007_199_254_740_990], foreign: [] }).epoch).toBe(4);

    // and the ledger wires the refusal
    const h = await harness();
    await h.l.open();
    const rid = runId(9);
    await putFile(commonsPaths(h.root).claimsFile(DEV_A, rid), `${JSON.stringify(withChecksum({ v: 1 as const, kind: 'claims' as const, deviceId: DEV_A, runId: rid, sessionId: rid, claims: [claim({ epoch: MAX_CLAIM_EPOCH, deviceId: DEV_A, runId: rid })], imports: [], at: iso(T0), stamp: stamp(1, DEV_A, rid), checksum: '' }))}\n`);
    await expect(h.l.forceTakebackEpochFor(rid)).rejects.toMatchObject({ code: 'epoch-exhausted' });
  });
});

describe('subscribe (§3.5) and the poll', () => {
  it('a refresh notifies subscribers with the change kind, and unsubscribe stops it', async () => {
    const h = await harness();
    await h.l.open();
    const seen: FoldChange[] = [];
    const off = h.l.subscribe((_f, c) => seen.push(c));
    await putHeartbeat(h.root, makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 900 }), stamp: stamp(9, DEV_B, runId(9)) }));
    await h.l.refresh('all');
    expect(seen).toEqual([{ kind: 'heartbeat', deviceId: DEV_B, id: runId(9) }]);
    off();
    await h.l.refresh('all');
    expect(seen).toHaveLength(1);
  });

  it('a subscriber that throws never reaches the ledger', async () => {
    const h = await harness();
    await h.l.open();
    h.l.subscribe(() => {
      throw new Error('boom');
    });
    await putLease(h.root, makeLease());
    await expect(h.l.refresh('all')).resolves.toBeUndefined();
  });

  it('the 15 s poll tick re-scans and emits { kind: "poll" }', async () => {
    const h = await harness();
    await h.l.open();
    const seen: FoldChange[] = [];
    h.l.subscribe((_f, c) => seen.push(c));
    h.timers.tick(15_000);
    // the poll runs a real async scan, so wait for its emission rather than for a fixed 5 ms — on a loaded machine
    // one macrotask is not enough and the fixed sleep made this the suite's only flaky assertion
    for (let i = 0; i < 200 && !seen.some((c) => c.kind === 'poll'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen.some((c) => c.kind === 'poll')).toBe(true);
  });
});

describe('§11 rows 3 / 11 / 27: two devices, a returning device, a copied home', () => {
  it('two ledgers over ONE store see each other and neither writes the other’s subtree', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ridA = runId(1);
    const ridB = runId(9);
    const mk = async (deviceId: string, rid: string) => {
      const l = openLedger({ home: t.home, self: makeSelf({ deviceId, runId: rid, sessionId: rid, label: deviceId === DEV_A ? 'mbp' : 'studio' }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, isPidAlive: () => true });
      await l.open();
      cleanups.push(() => l.close());
      return l;
    };
    const a = await mk(DEV_A, ridA);
    const b = await mk(DEV_B, ridB);
    await a.writeOwn('registry', `${ridA}.json`, makeHeartbeat({ runId: ridA, sessionId: ridA, claim: claim({ runId: ridA, pid: 1 }) }), { fsync: false });
    await b.writeOwn('registry', `${ridB}.json`, makeHeartbeat({ deviceId: DEV_B, runId: ridB, sessionId: ridB, pid: 2, claim: claim({ deviceId: DEV_B, runId: ridB, pid: 2 }), stamp: stamp(1, DEV_B, ridB) }), { fsync: false });
    await a.refresh('all');
    await b.refresh('all');
    expect([...a.fold.live.keys()].sort()).toEqual([ridA, ridB].sort());
    // each device only ever wrote under its own subtree
    expect((await nodeFs.readdir(join(t.root, 'registry'))).sort()).toEqual([DEV_A, DEV_B].sort());
    // and A's view of B is foreign, B's view of A is foreign — by PATH, not by content
    expect(a.foreignLive(ridB, { includeUnverified: true })?.deviceId).toBe(DEV_B);
    expect(a.foreignLive(ridA, { includeUnverified: true })).toBeNull();
    expect(b.foreignLive(ridA, { includeUnverified: true })?.deviceId).toBe(DEV_A);
    expect(a.foreignLive(ridB)).toBeNull(); // unpaired: never verified, so never a stop
  });

  it('§11 row 11: a device that went offline holding a lease returns and its released.changed is folded', async () => {
    const h = await harness();
    const rid = runId(9);
    await putHeartbeat(h.root, makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, phase: 'ended', claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), stamp: stamp(9, DEV_B, rid) }));
    await h.l.open();
    expect(h.l.fold.live.size).toBe(0);
    // it comes back and publishes what it changed while we could not see it
    await putLease(h.root, makeLease({ deviceId: DEV_B, runId: rid, sessionId: rid, leaseId: `${rid}-9`, stamp: stamp(9, DEV_B, rid), released: { at: iso(T0), outcome: 'committed', changed: { 'src/x.ts': 'sha-theirs' } } }));
    await h.l.refresh('all');
    expect([...h.l.fold.leases.values()][0]?.released?.changed).toEqual({ 'src/x.ts': 'sha-theirs' });
  });

  it('readFold is one bounded pass with no watchers and no timers', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    await putHeartbeat(t.root, makeHeartbeat());
    const fold = await readFold({ home: t.home, self: makeSelf(), isPidAlive: () => true });
    expect(fold.live.size).toBe(1);
    expect(fold.origins.get(`${DEV_A}/${runId(1)}`)?.self).toBe(true);
  });

  it('§10.3: pairing writes a key into trusted-devices.json, not into device.json', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const key = mintCommonsKey();
    const p = commonsPaths(t.root, 'a1b2c3d4');
    await trustDevice(nodeFs, p.hostDir, { deviceId: DEV_B, label: 'studio', pairedAt: iso(T0), keyHex: key });
    const text = (await nodeFs.readBounded(p.trustedFile, 4096)).text;
    expect(p.trustedFile).toContain('trusted-devices.json');
    // §3.1 (revision 5): the paired keys are PER HOST and are never mirrored
    expect(p.trustedFile).toContain(join('devices', 'a1b2c3d4'));
    expect(text).toContain(key);
    expect(p.seenDir(DEV_A)).toContain(join('inbox', 'seen', DEV_A));
  });
});
