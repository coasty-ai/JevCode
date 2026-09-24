/**
 * §4.3 lifecycle, §4.5 fencing, §4.1 facts. §11 rows covered: 8 (worktree / subdirectory → `soft`), 9 (two processes on one
 * checkout), 10 (renewal), 22 (rename), 34 (prefix collapse), 43 (`request-release` under advisory), 45 (a peer parked on a
 * pane for a day → the inline wait is skipped), 47 (the git command class), 49 (two devices within a second). The strict
 * fence is tested SYMMETRICALLY per review blocker 4: write A → readdir A → write B (lower stamp) → readdir B, exactly one
 * re-judge and never zero.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import {
  TREE_PATH,
  buildFacts,
  check,
  collapsePaths,
  coordRecordOf,
  FENCE_WAIT_CAP_MS,
  STRICT_WAIT_MS,
  declare,
  fenceWake,
  fenceYield,
  isExclusiveTreeCommand,
  leaseRels,
  leaseSnapshot,
  release,
  renew,
  requestedFor,
  shouldSkipInlineWait,
} from '../../../src/coordination/leases.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs, type CoordFs } from '../../../src/coordination/fs.js';
import { LEASE_PATHS_MAX } from '../../../src/coordination/ids.js';
import { commonsPaths, keyDir } from '../../../src/coordination/paths.js';
import { LEASE_TTL_MS } from '../../../src/coordination/records.js';
import type { LeaseIntent } from '../../../src/coordination/types.js';
import { DEV_A, DEV_B, KEY_B, REPO, SELF, T0, TRUSTED, WS, claim, entry, fakeClock, foldOf, iso, makeHeartbeat, makeLease, makeMessage, makeSelf, putHeartbeat, putLease, runId, signed, stamp, tempHome } from './helpers.js';

const self = makeSelf();
const intent = (patch: Partial<LeaseIntent> = {}): LeaseIntent => ({ paths: ['src/x.ts'], type: 'intent', reason60: 'edit x', step: 8, stage: 'coordinate', branch: 'main', head: null, ...patch });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** a live peer run on DEV_B holding `paths` */
function peerHolding(paths: string[], patch: Parameters<typeof makeHeartbeat>[0] = {}, leasePatch: Parameters<typeof makeLease>[0] = {}) {
  const rid = runId(9);
  const hb = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, label: 'studio', task60: 'fix store rotation', stamp: stamp(9, DEV_B, rid), claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 }), ...patch });
  const lease = makeLease({ runId: rid, sessionId: rid, deviceId: DEV_B, label: 'studio', leaseId: `${rid}-9`, type: 'exclusive', paths, stamp: stamp(9, DEV_B, rid), ...leasePatch });
  return [entry(hb, TRUSTED), entry(lease, TRUSTED)] as const;
}

describe('check (§4.3 step 2, pure)', () => {
  it('§11 row 9: an overlapping live lease on my branch is a HARD conflict naming the holder', () => {
    const fold = foldOf([...peerHolding(['src/x.ts'])]);
    const r = check(fold, self, intent());
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.severity).toBe('hard');
    expect(c.holder.label).toBe('studio');
    expect(c.holder.sameDevice).toBe(false);
    expect(c.holderStep).toBe(7);
    expect(c.sameBranch).toBe(true);
    expect(c.expiresInMs).toBeGreaterThan(0);
  });

  it('§4.3 step 2 (revision 5): severity is about the WORKING TREE, not the branch', () => {
    // a different BRANCH in the SAME checkout is still `hard`: one working tree is the only way two sessions can
    // clobber each other's bytes, and switching branches does not give them two.
    const otherBranch = foldOf([...peerHolding(['src/x.ts'], { repo: { branch: 'feature' } }, { branch: 'feature' })]);
    const r1 = check(otherBranch, self, intent());
    expect(r1.kind === 'conflict' && r1.conflicts[0]?.severity).toBe('hard');
    expect(r1.kind === 'conflict' && r1.conflicts[0]?.sameBranch).toBe(false);
    // a different `wsKey` — a second clone of one repo — is `soft` WHATEVER the branch. Two clones on one branch
    // cannot overwrite each other's files any more than two branches can, which is the doc's own reason for `soft`;
    // revision 2's "same branch → hard" bought a 60 s wait plus a pane between clones for a merge-time concern.
    const otherTree = foldOf([...peerHolding(['src/x.ts'], {}, { wsKey: 'ws:00000000deadbeef' })]);
    const r2 = check(otherTree, self, intent());
    expect(r2.kind === 'conflict' && r2.conflicts[0]?.severity).toBe('soft');
    expect(r2.kind === 'conflict' && r2.conflicts[0]?.sameBranch).toBe(true);
  });

  it('§4.3 step 2 (revision 5): an `intent` is a DECLARED FACT, never a conflict; only holding types conflict', () => {
    // every writer writes `intent` at step 1, and an F1 yield downgrades to it — so revision 4's "every live,
    // unexpired lease is a conflict" made the F2 re-declarer conflict with the peer that had just yielded to it,
    // and made every strict step conflict with every peer's step-1 declaration.
    const declaredOnly = foldOf([...peerHolding(['src/x.ts'], {}, { type: 'intent' })]);
    const r = check(declaredOnly, self, intent());
    expect(r.kind).toBe('clear');
    expect(r.declared.map((d) => d.path)).toEqual(['src/x.ts']);
    expect(r.declared[0]).toMatchObject({ by: 'studio', step: 3 });
    // … and it is NOT in the fence snapshot either, so the peer's intent → exclusive rewrite counts as `appeared`
    expect([...r.snapshot]).toEqual([]);
    for (const type of ['exclusive', 'command', 'lane', 'worktree', 'takeover'] as const) {
      const held = foldOf([...peerHolding(['src/x.ts'], {}, { type, ...(type === 'takeover' ? { claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 900 }) } : {}) })]);
      expect(check(held, self, intent()).kind, type).toBe('conflict');
    }
    // the snapshot holds the overlapping EXCLUSIVE leases, and nothing else
    const exclusive = foldOf([...peerHolding(['src/x.ts'], {}, { type: 'exclusive' })]);
    expect([...check(exclusive, self, intent()).snapshot]).toEqual([`${runId(9)}-9`]);
    const command = foldOf([...peerHolding(['src/x.ts'], {}, { type: 'command' })]);
    expect([...check(command, self, intent()).snapshot]).toEqual([]);
  });

  it('a released lease, a dead holder and my own run are all clear', () => {
    const released = foldOf([...peerHolding(['src/x.ts'], {}, { released: { at: iso(T0), outcome: 'committed', changed: {} } })]);
    expect(check(released, self, intent()).kind).toBe('clear');
    const deadHolder = foldOf([...peerHolding(['src/x.ts'], { phase: 'ended' })]);
    expect(check(deadHolder, self, intent()).kind).toBe('clear');
    const mine = foldOf([entry(makeHeartbeat(), SELF), entry(makeLease({ runId: runId(1), leaseId: `${runId(1)}-3`, paths: ['src/x.ts'] }), SELF)]);
    expect(check(mine, self, intent()).kind).toBe('clear');
  });

  /**
   * REVIEW BLOCKER 4 FIXTURE — the reader's wall clock is ±15 minutes off the writer's.
   *
   * Fails before the fix: `check()` compared the peer's `expiresAt` (a WRITER wall-clock stamp) against the READER's
   * clock, so a reader 15 min ahead judged every live peer lease expired and cleared straight through the fence — the
   * exact case the fence exists for, and one a laptop that woke or a VM that resumed produces routinely. Passes after:
   * liveness of the OWNER is the only gate, exactly as §4.3 says a beating owner's lease never expires.
   */
  it('review blocker 4: a ±15 min reader clock never drops a LIVE peer lease', () => {
    const skew = 15 * 60_000;
    const entries = [...peerHolding(['src/x.ts'])]; // the peer's lease expires at T0 + 10 min, renewed at T0
    for (const [label, wallMs] of [
      ['ahead', T0 + skew],
      ['behind', T0 - skew],
      ['in step', T0],
    ] as const) {
      const fold = foldOf(entries, { now: { wallMs, monoMs: 1_000_000 } });
      const r = check(fold, self, intent(), { now: { wallMs, monoMs: 1_000_000 } });
      expect(r.kind, label).toBe('conflict');
      expect(r.kind === 'conflict' && r.conflicts[0]?.expiresInMs, label).toBeGreaterThanOrEqual(0);
    }
    // the OWNER's liveness is the gate: an ended holder clears, however fresh the lease's own expiry looks
    const ended = foldOf([...peerHolding(['src/x.ts'], { phase: 'ended' }, { expiresAt: iso(T0 + 86_400_000) })]);
    expect(check(ended, self, intent()).kind).toBe('clear');
    // and an ancient expiry on a LIVE owner is still a conflict (the lease it renews every 15 s simply has not landed)
    const oldStamp = foldOf([...peerHolding(['src/x.ts'], {}, { expiresAt: iso(T0 - 1000), renewedAt: iso(T0 - 601_000) })]);
    expect(check(oldStamp, self, intent()).kind).toBe('conflict');
  });

  it('§4.2 / §11 row 47: an exclusiveTree command conflicts with EVERYTHING in the tree', () => {
    const fold = foldOf([...peerHolding(['src/other.ts'], { stage: 'execute' }, { type: 'command', exclusiveTree: true, command60: 'npm run build' })]);
    const r = check(fold, self, intent({ paths: ['docs/x.md'] }));
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.conflicts[0]?.exclusiveCommand).toBe('npm run build');
    // my own tree command conflicts with their file lease too
    const mineTree = check(foldOf([...peerHolding(['src/other.ts'])]), self, intent({ paths: [], exclusiveTree: true, type: 'command' }));
    expect(mineTree.kind === 'conflict' && mineTree.conflicts[0]?.path).toBe(TREE_PATH);
  });

  it('§8.4 / §11 row 49: `theyTouched` needs a real sha difference, not just an intersection', () => {
    const post = { at: iso(T0), outcome: 'committed' as const, changed: { 'src/x.ts': 'sha-new' } };
    const fold = foldOf([
      ...peerHolding(['src/x.ts']),
      entry(makeLease({ runId: runId(9), sessionId: runId(9), deviceId: DEV_B, leaseId: `${runId(9)}-8`, type: 'exclusive', paths: ['src/x.ts'], stamp: stamp(8, DEV_B, runId(9)), released: post }), TRUSTED),
    ]);
    const unknown = check(fold, self, intent());
    expect(unknown.kind === 'conflict' && unknown.conflicts[0]?.theyTouched).toBe(true);
    const same = check(fold, self, intent(), { fileMemory: { 'src/x.ts': 'sha-new' } });
    expect(same.kind === 'conflict' && same.conflicts[0]?.theyTouched).toBe(false);
    const moved = check(fold, self, intent(), { fileMemory: { 'src/x.ts': 'sha-old' } });
    expect(moved.kind === 'conflict' && moved.conflicts[0]?.theyTouched).toBe(true);
  });

  it('§11 row 22: a rename shows up through the post-image set (both names overlap)', () => {
    const fold = foldOf([...peerHolding(['src/b.ts'], { touchedRecent: ['src/a.ts', 'src/b.ts'] })]);
    const r = check(fold, self, intent({ paths: ['src/b.ts'] }));
    expect(r.kind === 'conflict' && r.conflicts[0]?.theyTouched).toBe(true);
  });

  it('§11 row 45: the inline wait is SKIPPED for a peer parked on a pane for a day, never because of expiresAt', () => {
    const day = 24 * 3_600_000;
    const parked = foldOf([...peerHolding(['src/x.ts'], { phase: 'blocked', blocked: 'spend-limit', beatAt: iso(T0 - 5_000) }, { renewedAt: iso(T0 - 5_000), expiresAt: iso(T0 + LEASE_TTL_MS) })], {
      now: { wallMs: T0, monoMs: 1_000_000 },
    });
    const r = check(parked, self, intent());
    expect(r.kind === 'conflict' && shouldSkipInlineWait(r.conflicts)).toBe(true);
    // a plainly running peer is worth waiting for
    const running = check(foldOf([...peerHolding(['src/x.ts'])]), self, intent());
    expect(running.kind === 'conflict' && shouldSkipInlineWait(running.conflicts)).toBe(false);
    // a build mid-execute: straight to the judgment
    const building = check(foldOf([...peerHolding(['src/x.ts'], { stage: 'execute' }, { type: 'command', exclusiveTree: true, command60: 'npm run build' })]), self, intent());
    expect(building.kind === 'conflict' && shouldSkipInlineWait(building.conflicts)).toBe(true);
    expect(day).toBeGreaterThan(0);
  });

  it('§11 row 43: a peer `request-release` is a fact under advisory; my own request is not', () => {
    const req = makeMessage({ type: 'request-release', to: `@${REPO}`, refs: { files: ['src/x.ts'] }, stamp: stamp(4, DEV_B, runId(9)) });
    const fold = foldOf([entry(req, TRUSTED)]);
    expect(requestedFor(fold, self, ['src/x.ts'])).toEqual([{ path: 'src/x.ts', by: 'studio', agoMs: 0 }]);
    const r = check(fold, self, intent());
    expect(r.kind === 'conflict' && r.requested).toHaveLength(1);
    const expired = foldOf([entry(makeMessage({ type: 'request-release', to: `@${REPO}`, refs: { files: ['src/x.ts'] }, expiresAt: iso(T0 - 1), stamp: stamp(5, DEV_B, runId(9)) }), TRUSTED)]);
    expect(requestedFor(expired, self, ['src/x.ts'])).toEqual([]);
  });
});

describe('§11 row 49: two devices edit the same file within one second', () => {
  it('no fence exists across a synced folder: both proceed, both learn `theyTouched` later, and the stamp is display only', () => {
    // each side writes its exclusive lease locally; neither sees the other for minutes of sync lag
    const theirs = makeLease({ runId: runId(9), sessionId: runId(9), deviceId: DEV_B, label: 'studio', leaseId: `${runId(9)}-50`, type: 'exclusive', paths: ['src/x.ts'], stamp: stamp(50, DEV_B, runId(9)) });
    const mineNow = foldOf([entry(makeHeartbeat(), SELF)]); // my fold, before their file arrives
    expect(check(mineNow, self, intent({ paths: ['src/x.ts'], type: 'exclusive' })).kind).toBe('clear');
    // minutes later their lease and its post-image shas arrive together
    const later = foldOf([
      ...peerHolding(['src/x.ts']),
      entry({ ...theirs, released: { at: iso(T0 + 1000), outcome: 'committed', changed: { 'src/x.ts': 'sha-theirs' } } }, TRUSTED),
    ]);
    const r = check(later, self, intent({ paths: ['src/x.ts'] }), { fileMemory: { 'src/x.ts': 'sha-mine' } });
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.conflicts[0]?.theyTouched).toBe(true); // the post-hoc hash compare, never a rollback
    // the lower stamp is `holder`, the higher `contested` — display only; my step already ran
    const lowStamp = check(later, self, intent({ paths: ['src/x.ts'] }), { stamp: stamp(99) });
    expect(lowStamp.kind === 'conflict' && lowStamp.contested).toBe(true);
  });
});

describe('§11 row 34: prefix collapse', () => {
  it('> 64 paths collapse to directory prefixes with truncated:true; ≤ 64 are untouched', () => {
    const many = Array.from({ length: 300 }, (_, i) => `src/tui/part${i}/file.ts`);
    const r = collapsePaths(many, LEASE_PATHS_MAX);
    expect(r.truncated).toBe(true);
    expect(r.paths.length).toBeLessThanOrEqual(LEASE_PATHS_MAX);
    expect(r.paths.every((p) => p.endsWith('/'))).toBe(true);
    const few = collapsePaths(['src/b.ts', 'src/a.ts'], LEASE_PATHS_MAX);
    expect(few).toEqual({ paths: ['src/a.ts', 'src/b.ts'], truncated: false });
  });

  it('collapsed prefixes are conservative — more conflicts, never fewer', () => {
    const collapsed = collapsePaths(Array.from({ length: 100 }, (_, i) => `src/loop/f${i}.ts`), 4);
    const fold = foldOf([...peerHolding(collapsed.paths)]);
    expect(check(fold, self, intent({ paths: ['src/loop/f7.ts'] })).kind).toBe('conflict');
  });
});

describe('§11 row 47: the exclusiveTree command class', () => {
  it('builds, whole-suite tests and every git write verb are exclusive; a narrowed pytest is not', () => {
    for (const c of ['npm run build', 'pnpm build', 'yarn perf', 'npm run test:pty', 'cargo build', 'make', 'make -j4', 'pytest', 'git commit -m x', 'git rebase main', 'git worktree add x', 'npm i && git commit -m x'])
      expect(isExclusiveTreeCommand(c), c).toBe(true);
    for (const c of ['npm test', 'pytest test/unit/x_test.py', 'git status', 'git log --oneline', 'ls', 'node scripts/no-any.mjs']) expect(isExclusiveTreeCommand(c), c).toBe(false);
  });
});

describe('declare / renew / release over a real store', () => {
  async function ledgerAt(patch: Partial<ReturnType<typeof makeSelf>> = {}) {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const l = openLedger({ home: t.home, self: makeSelf(patch), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    return { t, clock, l };
  }

  it('advisory writes `intent` fire-and-forget under leases/<dev>/<repoKey>/ and the fold sees it at once', async () => {
    const { t, l } = await ledgerAt();
    const h = declare(l, intent(), 'advisory');
    expect(h.leaseId.startsWith(`${runId(1)}-`)).toBe(true);
    await l.close();
    const file = commonsPaths(t.root).leaseFile(DEV_A, REPO, h.leaseId);
    const text = (await nodeFs.readBounded(file, 8192)).text;
    const rec = JSON.parse(text) as { type: string; paths: string[]; reason60: string };
    expect(rec.type).toBe('intent');
    expect(rec.paths).toEqual(['src/x.ts']);
    expect(rec.reason60).toBe('edit x');
  });

  it('§11 row 10: renew bumps renewedAt / expiresAt; release records the post-image shas', async () => {
    const { clock, l } = await ledgerAt();
    const h = declare(l, intent(), 'advisory');
    clock.advance(30_000);
    renew(h);
    release(h, 'committed', { 'src/x.ts': 'sha-1', '../evil': 'sha-2' }, 'a'.repeat(40));
    await l.close();
    const lease = [...l.fold.leases.values()].find((x) => x.leaseId === h.leaseId);
    expect(lease?.released?.outcome).toBe('committed');
    expect(Object.keys(lease?.released?.changed ?? {})).toEqual(['src/x.ts']); // the traversal key was dropped
    expect(Date.parse(lease?.renewedAt ?? '')).toBe(T0 + 30_000);
    expect(Date.parse(lease?.expiresAt ?? '')).toBe(T0 + 30_000 + LEASE_TTL_MS);
  });

  it('a lease is refused, never truncated, past 8 KiB — the paths collapse instead', async () => {
    const { l } = await ledgerAt();
    const h = declare(l, intent({ paths: Array.from({ length: 400 }, (_, i) => `src/very/deeply/nested/directory/tree/number${i}/file-with-a-long-name.ts`) }), 'advisory');
    await l.close();
    const lease = [...l.fold.leases.values()].find((x) => x.leaseId === h.leaseId);
    expect(lease?.truncated).toBe(true);
    expect(lease?.paths.length).toBeLessThanOrEqual(LEASE_PATHS_MAX);
  });

  it('a lane lease claims no workspace path (§6.2 rule 3)', async () => {
    const { l } = await ledgerAt();
    const h = declare(l, intent({ paths: [], type: 'lane', laneDir: 'tmp/synth/lane2', reason60: 'lane 2' }), 'advisory');
    await l.close();
    const lease = [...l.fold.leases.values()].find((x) => x.leaseId === h.leaseId);
    expect(lease?.paths).toEqual([]);
    expect(lease?.laneDir).toBe('tmp/synth/lane2');
  });
});

describe('§4.5 the strict fence — F1 yield on sight, F2 the lowest stamp re-declares (design revision 4)', () => {
  /**
   * Two engines over ONE store, each with its own ledger and its own published beat.
   * `barrier` makes the BOTH-SEE interleaving deterministic: every fence `readdir` of `leases/` waits until two lease
   * files have been renamed, so neither side can list before the other has written. Without it the two declares race
   * and the test flaps between the one-sees and both-see cases.
   */
  async function twoEngines(seedA: number, seedB: number, o: { barrier?: boolean } = {}) {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ridA = runId(1);
    const ridB = runId(2);
    let armed = false;
    let writes = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: CoordFs = {
      ...nodeFs,
      async writeAtomic(path: string, data: string, opt: { fsync: boolean; mode: number }) {
        await nodeFs.writeAtomic(path, data, opt);
        if (armed && path.includes(`${sep}leases${sep}`)) {
          writes += 1;
          if (writes >= 2) release();
        }
      },
      async readdir(path: string) {
        if (armed && path.includes(`${sep}leases${sep}`)) await gate;
        return nodeFs.readdir(path);
      },
    };
    const open = async (rid: string, seed: number) => {
      const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: o.barrier === true ? gated : nodeFs, isPidAlive: () => true });
      await l.open();
      for (let i = 0; i < seed; i++) l.stamps.issue();
      cleanups.push(() => l.close());
      return l;
    };
    const a = await open(ridA, seedA);
    const b = await open(ridB, seedB);
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridA, sessionId: ridA, claim: claim({ runId: ridA, pid: 111 }), stamp: stamp(1, DEV_A, ridA) }));
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridB, sessionId: ridB, pid: 222, claim: claim({ runId: ridB, pid: 222 }), stamp: stamp(1, DEV_A, ridB) }));
    await a.refresh('all');
    await b.refresh('all');
    armed = o.barrier === true;
    return { t, a, b, disarm: () => { armed = false; release(); } };
  }

  const mine = (): LeaseIntent => intent({ paths: ['src/engine.ts'], type: 'exclusive' });

  it('(i) one-sees: the SECOND writer yields even though its stamp is LOWER — sight, not order, stops you', async () => {
    // A's in-memory counter has run ahead, so the second writer holds the lower stamp: revision 2's "lower stamp wins"
    // read as a local test made BOTH proceed here, which is the failure G1(c) forbids.
    const { a, b } = await twoEngines(62, 0);
    const snapA = leaseSnapshot(check(a.fold, a.self, mine()));
    const snapB = leaseSnapshot(check(b.fold, b.self, mine()));
    const decA = await declare(a, mine(), 'strict', { snapshot: snapA });
    const decB = await declare(b, mine(), 'strict', { snapshot: snapB });
    expect(decA.fence).toBe('decided');
    expect(decB.fence).toBe('decided');
    if (decA.fence !== 'decided' || decB.fence !== 'decided') return;
    expect(decB.stamp.n).toBeLessThan(decA.stamp.n); // B really is the lower stamp
    expect(decA.proceed).toBe(true); // A's readdir preceded B's rename
    expect(decB.proceed).toBe(false); // …and B SAW A, so B yields regardless of the stamps
    expect(decB.appeared.map((c) => c.leaseId)).toEqual([decA.leaseId]);
    expect([decA.proceed, decB.proceed].filter(Boolean)).toHaveLength(1); // never zero, never two

    // F2 never fires for B while A still holds `exclusive`: B waits for a real release, which is correct
    const wait = await fenceYield(b, mine(), decB);
    await b.refresh('leases');
    expect(wait.wake(b.fold, b.fold.at.monoMs)).toBe('keep-waiting');
    // the capture holds what F2 decides from: the leaseId, the stamp, the device and MY deadline (§4.5, revision 5)
    expect(wait.captured.yieldedTo.map((y) => y.leaseId)).toEqual([decA.leaseId]);
    expect(wait.captured.mine).toEqual(decB.stamp);
    expect(wait.captured.yieldedTo[0]?.sameDevice).toBe(true); // same store, same device: pid death is the event
    expect(wait.captured.yieldedTo[0]?.staleAtMono).toBeNull();
    // same-device, so the cap never binds and the deadline is the plain strict wait
    expect(wait.captured.deadlineMono).toBe(b.fold.at.monoMs + STRICT_WAIT_MS);
  });

  it('(ii) both-see: F1 yields on both sides, then F2 lets only the LOWEST stamp re-declare and proceed', async () => {
    const { a, b, disarm } = await twoEngines(62, 0, { barrier: true });
    const snapA = leaseSnapshot(check(a.fold, a.self, mine()));
    const snapB = leaseSnapshot(check(b.fold, b.self, mine()));
    // both renames land before either readdir — the symmetric case arrival cannot separate
    const [decA, decB] = await Promise.all([declare(a, mine(), 'strict', { snapshot: snapA }), declare(b, mine(), 'strict', { snapshot: snapB })]);
    disarm();
    if (decA.fence !== 'decided' || decB.fence !== 'decided') throw new Error('expected two decided fences');
    expect(decA.proceed || decB.proceed).toBe(false); // F1: nobody proceeds on sight
    const waitA = await fenceYield(a, mine(), decA);
    const waitB = await fenceYield(b, mine(), decB);
    await a.refresh('leases');
    await b.refresh('leases');
    // F2: exactly one wake says `redeclare`, and it is the lower stamp (B)
    expect(decB.stamp.n).toBeLessThan(decA.stamp.n);
    expect(waitB.wake(b.fold, b.fold.at.monoMs)).toBe('redeclare');
    expect(waitA.wake(a.fold, a.fold.at.monoMs)).toBe('keep-waiting');
    // and its re-declare proceeds: everyone else is `intent`, so `appeared` is empty
    const again = await waitB.redeclare();
    expect(again.fence === 'decided' && again.proceed).toBe(true);
  });

  it('(ii) the minimum is taken over the CAPTURED stamps, not the fold — a GC\u2019d peer lease still counts', async () => {
    const { a, b, disarm } = await twoEngines(62, 0, { barrier: true });
    const [decA, decB] = await Promise.all([declare(a, mine(), 'strict', { snapshot: leaseSnapshot(check(a.fold, a.self, mine())) }), declare(b, mine(), 'strict', { snapshot: leaseSnapshot(check(b.fold, b.self, mine())) })]);
    disarm();
    if (decA.fence !== 'decided' || decB.fence !== 'decided') throw new Error('expected two decided fences');
    const waitA = await fenceYield(a, mine(), decA);
    await fenceYield(b, mine(), decB);
    // B's lease disappears entirely (its owner GC'd it). A captured B's stamp, so A still knows B goes first.
    for (const rel of leaseRels({ repoKey: REPO, wsKey: WS, leaseId: decB.leaseId })) await nodeFs.unlink(join(commonsPaths(a.root).deviceDir('leases', DEV_A), rel));
    await a.refresh('leases');
    expect(a.fold.leases.has(decB.leaseId)).toBe(false);
    expect(waitA.captured.yieldedTo.map((y) => y.leaseId)).toEqual([decB.leaseId]);
    expect(waitA.wake(a.fold, a.fold.at.monoMs)).toBe('keep-waiting'); // B is the minimum and A never learns otherwise
  });

  it('(ii) a THIRD writer that arrived after the capture keeps everyone waiting', async () => {
    const { a, b, disarm } = await twoEngines(62, 0, { barrier: true });
    const [decA, decB] = await Promise.all([declare(a, mine(), 'strict', { snapshot: leaseSnapshot(check(a.fold, a.self, mine())) }), declare(b, mine(), 'strict', { snapshot: leaseSnapshot(check(b.fold, b.self, mine())) })]);
    disarm();
    if (decA.fence !== 'decided' || decB.fence !== 'decided') throw new Error('expected two decided fences');
    await fenceYield(a, mine(), decA);
    const waitB = await fenceYield(b, mine(), decB);
    await b.refresh('leases');
    expect(waitB.wake(b.fold, b.fold.at.monoMs)).toBe('redeclare'); // B is the minimum of the capture
    // … until a third, uncaptured writer turns up holding the same path: re-declaring would only yield again
    const ridC = runId(7);
    await putHeartbeat(b.root, makeHeartbeat({ deviceId: DEV_B, runId: ridC, sessionId: ridC, claim: claim({ deviceId: DEV_B, runId: ridC, pid: 700 }), stamp: stamp(7, DEV_B, ridC) }));
    await putLease(b.root, makeLease({ deviceId: DEV_B, runId: ridC, sessionId: ridC, leaseId: `${ridC}-7`, type: 'exclusive', paths: ['src/engine.ts'], stamp: stamp(7, DEV_B, ridC) }));
    await b.refresh('all');
    expect(waitB.wake(b.fold, b.fold.at.monoMs)).toBe('keep-waiting');
  });

  it('(ii) cross-device: the post-yield deadline runs to the PEER\u2019s staleness, capped, and then says `deadline`', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(3);
    const ridPeer = runId(9);
    // a FOREIGN peer holding the same path: its death is only visible at ttl + slack, which is past strictWaitMs
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: ridPeer, sessionId: ridPeer, claim: claim({ deviceId: DEV_B, runId: ridPeer, pid: 900 }), stamp: stamp(90, DEV_B, ridPeer) }));
    await putLease(t.root, makeLease({ deviceId: DEV_B, runId: ridPeer, sessionId: ridPeer, leaseId: `${ridPeer}-90`, type: 'exclusive', paths: ['src/engine.ts'], stamp: stamp(90, DEV_B, ridPeer) }));
    const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    const dec = await declare(l, mine(), 'strict', { snapshot: new Set<string>() });
    if (dec.fence !== 'decided') throw new Error('expected a decided fence');
    expect(dec.proceed).toBe(false); // F1: I saw it
    const wait = await fenceYield(l, mine(), dec);
    const y = wait.captured.yieldedTo[0];
    expect(y?.sameDevice).toBe(false);
    expect(y?.staleAtMono).not.toBeNull();
    // the wait runs to the peer's staleness instant, not to strictWaitMs — and never past the derived cap
    const waited = wait.captured.deadlineMono - l.fold.at.monoMs;
    expect(waited).toBeGreaterThan(STRICT_WAIT_MS);
    expect(waited).toBeLessThanOrEqual(FENCE_WAIT_CAP_MS);
    // the peer crashes after the yield: nothing more is written, and staleness is the only event left
    expect(wait.wake(l.fold, l.fold.at.monoMs)).toBe('keep-waiting');
    clock.advance(waited + 1);
    await l.refresh('all');
    // past its staleness the captured lease stops fencing; I am the only stamp left, so it is my turn
    expect(wait.wake(l.fold, l.fold.at.monoMs)).toBe('redeclare');
    await l.close();
  });

  it('(ii) the same script decides identically with NO Jev and NO prompter — it is pure code', async () => {
    // there is nothing to stub: `declare` / `fenceWake` take a fold and a capture and return a word. Running the
    // decision twice over the same facts must produce the same answer, which is what `jev-off` / `--no-input` get.
    const { a, b, disarm } = await twoEngines(62, 0, { barrier: true });
    const [decA, decB] = await Promise.all([declare(a, mine(), 'strict', { snapshot: leaseSnapshot(check(a.fold, a.self, mine())) }), declare(b, mine(), 'strict', { snapshot: leaseSnapshot(check(b.fold, b.self, mine())) })]);
    disarm();
    if (decA.fence !== 'decided' || decB.fence !== 'decided') throw new Error('expected two decided fences');
    await fenceYield(a, mine(), decA);
    const waitB = await fenceYield(b, mine(), decB);
    await b.refresh('leases');
    const first = fenceWake(b.fold, b.self, mine(), waitB.captured, b.fold.at.monoMs);
    const second = fenceWake(b.fold, b.self, mine(), waitB.captured, b.fold.at.monoMs);
    expect(first).toBe(second);
    expect(first).toBe('redeclare');
  });

  it('(iv) TWO DIRECTORIES, ONE LEASE: two runs in ONE checkout whose keyDir diverges still see each other', async () => {
    // §4.3 / §4.5 (design revision 5). A workspace with an unborn HEAD and no origin has `repoKey: null` at run 1
    // and a real `repoKey` at run 2 because the first commit landed in between; a `rev-list --max-parents=0` that
    // fails on one side (a corrupt pack, a flaky mount, the 2 s timeout) produces the same split. Under revision 4's
    // single `keyDir(repoKey ?? wsKey)` the two runs leased in DIFFERENT directories, each readdir was honest and
    // empty, and BOTH proceeded under `strict` — the exact G1(c) failure. The fix is on the write side: a declare
    // writes the same record under `keyDir(repoKey)` AND `keyDir(wsKey)`, and the safety proof then runs in the
    // `wsKey` directory, which two runs in one checkout share by construction.
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ridA = runId(1);
    const ridB = runId(2);
    const open2 = async (rid: string, repoKey: string | null, pid: number) => {
      const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid, repoKey }), pid, now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
      await l.open();
      return l;
    };
    // run A: the rev-list failed, so it has only its wsKey. run B: same checkout, but it computed the repoKey.
    const a = await open2(ridA, null, 111);
    const b = await open2(ridB, REPO, 222);
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridA, sessionId: ridA, pid: 111, claim: claim({ runId: ridA, pid: 111 }), stamp: stamp(1, DEV_A, ridA), repo: { repoKey: null } }));
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridB, sessionId: ridB, pid: 222, claim: claim({ runId: ridB, pid: 222 }), stamp: stamp(1, DEV_A, ridB) }));
    await a.refresh('all');
    await b.refresh('all');
    expect(keyDir(REPO)).not.toBe(keyDir(WS)); // the premise: the two runs' key directories really do differ

    // B declares first and its readdir is empty, so it proceeds — and it wrote BOTH copies
    const decB = await declare(b, mine(), 'strict', { snapshot: leaseSnapshot(check(b.fold, b.self, mine())) });
    expect(decB.fence === 'decided' && decB.proceed).toBe(true);
    await expect(nodeFs.stat(commonsPaths(t.root).leaseFile(DEV_A, REPO, decB.leaseId))).resolves.toBeTruthy();
    await expect(nodeFs.stat(commonsPaths(t.root).leaseFile(DEV_A, WS, decB.leaseId))).resolves.toBeTruthy();

    // A leases under its wsKey only — and SEES B there. F1 fires: at most one writer proceeds, in every interleaving.
    const decA = await declare(a, mine(), 'strict', { snapshot: leaseSnapshot(check(a.fold, a.self, mine())) });
    expect(decA.fence).toBe('decided');
    if (decA.fence !== 'decided') return;
    expect(decA.proceed).toBe(false);
    expect(decA.appeared.map((c) => c.leaseId)).toEqual([decB.leaseId]);
    // and the two copies fold to ONE lease, because the fold is keyed by leaseId
    expect([...a.fold.leases.keys()].filter((id) => id === decB.leaseId)).toHaveLength(1);

    // A has no repoKey, so its own lease has ONE copy — under the wsKey, which is the directory the proof runs in
    const wait = await fenceYield(a, mine(), decA);
    expect(wait.captured.yieldedTo).toHaveLength(1);
    expect(leaseRels({ repoKey: null, wsKey: WS, leaseId: decA.leaseId })).toHaveLength(1);
    await expect(nodeFs.stat(commonsPaths(t.root).leaseFile(DEV_A, REPO, decA.leaseId))).rejects.toThrow(/ENOENT/);

    // EVERY rewrite of a two-copy lease rewrites BOTH, in the same order: B's release lands in both directories
    release(decB, 'committed');
    await b.close();
    for (const key of [REPO, WS]) {
      const text = (await nodeFs.readBounded(commonsPaths(t.root).leaseFile(DEV_A, key, decB.leaseId), 8192)).text;
      expect(JSON.parse(text).released?.outcome, key).toBe('committed');
    }
    // … and so does a downgrade: A's yield is visible in its one directory
    const yielded = (await nodeFs.readBounded(commonsPaths(t.root).leaseFile(DEV_A, WS, decA.leaseId), 8192)).text;
    expect(JSON.parse(yielded).type).toBe('intent');
    release(decA, 'discarded');
    await a.close();
  });

  it('(iii) fence-blind: past MAX_FENCE_DEVICES the fence REFUSES rather than proceeding', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    // more lease subtrees than the fence may walk
    const ids = Array.from({ length: 20 }, (_, i) => `${'abcdefgh'.slice(0, 7)}${String.fromCharCode(97 + (i % 20))}`);
    for (const id of new Set(ids)) await nodeFs.mkdir(commonsPaths(t.root).leaseDir(id, REPO), 0o700);
    const dec = await declare(l, intent({ paths: ['src/engine.ts'], type: 'exclusive' }), 'strict', { snapshot: new Set<string>() });
    expect(dec.fence).toBe('decided'); // 20 subtrees is well inside the 256 bound
    const blind = await l.refreshFence({ maxDevices: 3 });
    expect(blind.complete).toBe(false);
    expect(blind.total).toBeGreaterThan(blind.scanned);
    await l.close();
  });

  it('(iv) the NULL key: a run with no repoKey fences under keyDir(wsKey), and a peer in the same checkout sees it', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const open = async (rid: string) => {
      const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid, repoKey: null }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
      await l.open();
      cleanups.push(() => l.close());
      return l;
    };
    const a = await open(runId(1));
    const b = await open(runId(2));
    await putHeartbeat(t.root, makeHeartbeat({ runId: runId(1), sessionId: runId(1), claim: claim({ runId: runId(1), pid: 111 }), stamp: stamp(1, DEV_A, runId(1)), repo: { repoKey: null } }));
    await putHeartbeat(t.root, makeHeartbeat({ runId: runId(2), sessionId: runId(2), pid: 222, claim: claim({ runId: runId(2), pid: 222 }), stamp: stamp(1, DEV_A, runId(2)), repo: { repoKey: null } }));
    await a.refresh('all');
    await b.refresh('all');
    const decA = await declare(a, mine(), 'strict', { snapshot: leaseSnapshot(check(a.fold, a.self, mine())) });
    expect(decA.fence === 'decided' && decA.proceed).toBe(true);
    // the file really is under `keyDir(wsKey)` — 'ws:' is never a path component (review major 13)
    expect(commonsPaths(t.root).leaseDir(DEV_A, WS)).toContain(`ws-${WS.slice(3)}`);
    await expect(nodeFs.stat(commonsPaths(t.root).leaseFile(DEV_A, WS, decA.leaseId))).resolves.toBeTruthy();
    const decB = await declare(b, mine(), 'strict', { snapshot: leaseSnapshot(check(b.fold, b.self, mine())) });
    expect(decB.fence === 'decided' && decB.proceed).toBe(false); // B sees A across the wsKey directory
  });

  it('a lease that was already in the judged snapshot is not "appeared" — no spurious yield', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(3);
    const peerLease = makeLease({ runId: runId(9), sessionId: runId(9), deviceId: DEV_B, leaseId: `${runId(9)}-9`, type: 'exclusive', paths: ['src/other.ts'], stamp: stamp(9, DEV_B, runId(9)) });
    await putLease(t.root, peerLease);
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 900 }), stamp: stamp(9, DEV_B, runId(9)) }));
    const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    const dec = await declare(l, intent({ paths: ['src/mine.ts'], type: 'exclusive' }), 'strict', { snapshot: leaseSnapshot(check(l.fold, l.self, intent({ paths: ['src/mine.ts'], type: 'exclusive' }))) });
    expect(dec.fence).toBe('decided');
    if (dec.fence !== 'decided') return;
    expect(dec.appeared).toEqual([]);
    expect(dec.proceed).toBe(true);
    expect(dec.refold.kind).toBe('clear');
    await l.close();
    expect(join(t.root, 'leases')).toContain('leases');
  });
});

/**
 * REVIEW BLOCKER 1 FIXTURE — the gated readdir.
 *
 * A scan is in flight and has already LISTED every peer's `leases/<repoKey>/`; it is parked reading one of the files it
 * listed. The peer writes its exclusive lease into that same directory. Our strict `declare` then writes its own lease
 * and refreshes.
 *
 * Fails before the fix: `scan()` saw `this.scanning !== null`, joined the parked pass and returned `[]`, so the refold
 * was answered by a readdir that ran BEFORE our own write — `appeared` empty, `reJudge` false, and both writers hold
 * the paths. Passes after: `refresh()` chains a pass that STARTS after the call.
 */
describe('§4.5 review blocker 1: the strict fence is never answered by a readdir that predates its own write', () => {
  it('a peer lease written between the list and the resolve of an in-flight scan is seen by the fence', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ridPeer = runId(9);
    // a peer lease already on disk, so the scan has a FILE to park on after it has listed the directory
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: ridPeer, sessionId: ridPeer, label: 'studio', claim: claim({ deviceId: DEV_B, runId: ridPeer, pid: 900 }), stamp: stamp(9, DEV_B, ridPeer) }));
    const seed = makeLease({ runId: ridPeer, sessionId: ridPeer, deviceId: DEV_B, leaseId: `${ridPeer}-1`, type: 'exclusive', paths: ['docs/unrelated.md'], stamp: stamp(1, DEV_B, ridPeer) });
    await putLease(t.root, seed);

    let park = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      park = resolve;
    });
    let armed = false;
    const fs: CoordFs = {
      ...nodeFs,
      async readBounded(path: string, max: number) {
        if (armed && path.endsWith(`${seed.leaseId}.json`)) {
          armed = false;
          await parked;
        }
        return nodeFs.readBounded(path, max);
      },
    };
    const l = openLedger({ home: t.home, self: makeSelf({ runId: runId(1), sessionId: runId(1) }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs, isPidAlive: () => true });
    await l.open();
    const snapshot = leaseSnapshot(check(l.fold, l.self, intent({ paths: ['src/engine.ts'], type: 'exclusive' })));
    armed = true;
    // the seed's (mtime, size) must move, or the incremental scanner never re-reads it and never parks
    await putLease(t.root, { ...seed, reason60: 'renewed' });

    const inFlight = l.refresh('leases'); // lists the directory, then parks on the seed file
    // the peer's CONFLICTING lease lands after that listing — the writer cannot have seen ours either
    const conflicting = makeLease({ runId: ridPeer, sessionId: ridPeer, deviceId: DEV_B, leaseId: `${ridPeer}-2`, type: 'exclusive', paths: ['src/engine.ts'], stamp: stamp(2, DEV_B, ridPeer) });
    await putLease(t.root, conflicting);
    const second = l.refresh('leases'); // registered while the first pass is still parked
    park();
    await Promise.all([inFlight, second]);
    // the joined-scan bug returned [] here and left the fold exactly as the pre-write listing found it
    expect(l.fold.leases.has(conflicting.leaseId)).toBe(true);

    // and the fence itself now sees it: a strict declare over the same path YIELDS instead of proceeding (§4.5 F1)
    const dec = await declare(l, intent({ paths: ['src/engine.ts'], type: 'exclusive' }), 'strict', { snapshot });
    expect(dec.fence).toBe('decided');
    if (dec.fence !== 'decided') return;
    expect(dec.appeared.map((c) => c.leaseId)).toContain(conflicting.leaseId);
    expect(dec.proceed).toBe(false); // F1: I SAW it, so I yield — whatever the stamps say
    await l.close();
  });
});

describe('§4.1 facts and the StepRecord row', () => {
  it('≤ 8 conflicts / requests / messages and ≤ 300 chars of peer text', () => {
    const fold = foldOf([...peerHolding(Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`))]);
    const r = check(fold, self, intent({ paths: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`) }));
    const messages = Array.from({ length: 12 }, (_, i) => makeMessage({ id: `${DEV_B}-abcdefgh-${i + 10}`, text: 'x'.repeat(500), stamp: stamp(i + 10, DEV_B, runId(9)) }));
    const facts = buildFacts({ step: 8, check: r, messages, others: 1 });
    expect(facts.conflicts).toHaveLength(8);
    expect(facts.messages).toHaveLength(8);
    expect(facts.messages[0]?.text.length).toBe(300);
    const row = coordRecordOf(facts);
    expect(row.conflicts[0]).toMatchObject({ holder: 'studio', holderStep: 7 });
    expect(Object.keys(row.conflicts[0] ?? {}).sort()).toEqual(['agoMs', 'holder', 'holderStep', 'path', 'sameBranch', 'theyTouched']);
  });

  it('a clear check produces no facts and the signed-peer fixture still parses', () => {
    const facts = buildFacts({ step: 1, check: { kind: 'clear', snapshot: new Set<string>(), declared: [] }, others: 0 });
    expect(facts).toEqual({ step: 1, conflicts: [], requested: [], messages: [], others: 0 });
    expect(signed(makeLease({ deviceId: DEV_B }), KEY_B).hmac).toMatch(/^[0-9a-f]{64}$/);
  });
});
