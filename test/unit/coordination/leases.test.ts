/**
 * §4.3 lifecycle, §4.5 fencing, §4.1 facts. §11 rows covered: 8 (worktree / subdirectory → `soft`), 9 (two processes on one
 * checkout), 10 (renewal), 22 (rename), 34 (prefix collapse), 43 (`request-release` under advisory), 45 (a peer parked on a
 * pane for a day → the inline wait is skipped), 47 (the git command class), 49 (two devices within a second). The strict
 * fence is tested SYMMETRICALLY per review blocker 4: write A → readdir A → write B (lower stamp) → readdir B, exactly one
 * re-judge and never zero.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  TREE_PATH,
  buildFacts,
  check,
  collapsePaths,
  coordRecordOf,
  declare,
  isExclusiveTreeCommand,
  leaseSnapshot,
  release,
  renew,
  requestedFor,
  shouldSkipInlineWait,
} from '../../../src/coordination/leases.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { LEASE_PATHS_MAX } from '../../../src/coordination/ids.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { LEASE_TTL_MS } from '../../../src/coordination/records.js';
import type { LeaseIntent } from '../../../src/coordination/types.js';
import { DEV_A, DEV_B, KEY_B, REPO, SELF, T0, TRUSTED, claim, entry, fakeClock, foldOf, iso, makeHeartbeat, makeLease, makeMessage, makeSelf, putHeartbeat, putLease, runId, signed, stamp, tempHome } from './helpers.js';

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

  it('§11 row 8: a different branch is a SOFT fact — two checkouts cannot clobber each other', () => {
    const fold = foldOf([...peerHolding(['src/x.ts'], { repo: { branch: 'feature' } }, { branch: 'feature' })]);
    const r = check(fold, self, intent());
    expect(r.kind === 'conflict' && r.conflicts[0]?.severity).toBe('soft');
    expect(r.kind === 'conflict' && r.conflicts[0]?.sameBranch).toBe(false);
  });

  it('a released lease, a dead holder and my own run are all clear', () => {
    const released = foldOf([...peerHolding(['src/x.ts'], {}, { released: { at: iso(T0), outcome: 'committed', changed: {} } })]);
    expect(check(released, self, intent()).kind).toBe('clear');
    const deadHolder = foldOf([...peerHolding(['src/x.ts'], { phase: 'ended' })]);
    expect(check(deadHolder, self, intent()).kind).toBe('clear');
    const mine = foldOf([entry(makeHeartbeat(), SELF), entry(makeLease({ runId: runId(1), leaseId: `${runId(1)}-3`, paths: ['src/x.ts'] }), SELF)]);
    expect(check(mine, self, intent()).kind).toBe('clear');
  });

  it('an expired lease is ignored regardless (§4.6 row 1)', () => {
    const fold = foldOf([...peerHolding(['src/x.ts'], {}, { expiresAt: iso(T0 - 1000) })]);
    expect(check(fold, self, intent()).kind).toBe('clear');
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

describe('§4.5 the strict write-then-read fence — SYMMETRIC (review blocker 4)', () => {
  it('write A · readdir A · write B (LOWER stamp) · readdir B → exactly one side re-judges, never zero', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const ridA = runId(1);
    const ridB = runId(2);
    const open = async (rid: string, seedStamp: number) => {
      const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
      await l.open();
      // advance A's counter so its next issue is ABOVE B's — the interleaving the review names
      for (let i = 0; i < seedStamp; i++) l.stamps.issue();
      return l;
    };
    // both engines must look live to each other
    const a = await open(ridA, 62);
    const b = await open(ridB, 0);
    // both published beats carry a LOW stamp, so B's own counter stays low while A's in-memory counter has run ahead —
    // exactly the review's interleaving: the second writer is the LOWER stamp and the old rule let it proceed
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridA, sessionId: ridA, claim: claim({ runId: ridA, pid: 111 }), stamp: stamp(1, DEV_A, ridA) }));
    await putHeartbeat(t.root, makeHeartbeat({ runId: ridB, sessionId: ridB, pid: 222, claim: claim({ runId: ridB, pid: 222 }), stamp: stamp(1, DEV_A, ridB) }));
    await a.refresh('all');
    await b.refresh('all');

    const mine = intent({ paths: ['src/engine.ts'], type: 'exclusive' });
    const snapA = leaseSnapshot(a.fold);
    const snapB = leaseSnapshot(b.fold);
    // A writes and fences FIRST: it sees nothing, so it proceeds
    const decA = await declare(a, mine, 'strict', { snapshot: snapA });
    // B writes and fences SECOND with a LOWER stamp — the old rule made B the holder and let it proceed
    const decB = await declare(b, mine, 'strict', { snapshot: snapB });

    expect(decB.refold.kind).toBe('conflict');
    expect(decB.appeared.map((c) => c.leaseId)).toEqual([decA.leaseId]);
    expect(decB.reJudge).toBe(true);
    expect(decB.refold.kind === 'conflict' && decB.refold.contested).toBe(true);
    expect(decA.reJudge).toBe(false);
    expect([decA.reJudge, decB.reJudge].filter(Boolean)).toHaveLength(1);
    // and B's stamp really is the lower one, so the stamp order alone would have picked the wrong side
    expect(decB.stamp.n).toBeLessThan(decA.stamp.n);
    await a.close();
    await b.close();
  });

  it('a lease that was already in the judged snapshot is not "appeared" — no spurious re-judge', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(3);
    const peerLease = makeLease({ runId: runId(9), sessionId: runId(9), deviceId: DEV_B, leaseId: `${runId(9)}-9`, type: 'exclusive', paths: ['src/other.ts'], stamp: stamp(9, DEV_B, runId(9)) });
    await putLease(t.root, peerLease);
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 900 }), stamp: stamp(9, DEV_B, runId(9)) }));
    const l = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true });
    await l.open();
    const mine = intent({ paths: ['src/mine.ts'], type: 'exclusive' });
    const dec = await declare(l, mine, 'strict', { snapshot: leaseSnapshot(l.fold) });
    expect(dec.appeared).toEqual([]);
    expect(dec.reJudge).toBe(false);
    expect(dec.refold.kind).toBe('clear');
    await l.close();
    expect(join(t.root, 'leases')).toContain('leases');
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
    const facts = buildFacts({ step: 1, check: { kind: 'clear', snapshot: [] }, others: 0 });
    expect(facts).toEqual({ step: 1, conflicts: [], requested: [], messages: [], others: 0 });
    expect(signed(makeLease({ deviceId: DEV_B }), KEY_B).hmac).toMatch(/^[0-9a-f]{64}$/);
  });
});
