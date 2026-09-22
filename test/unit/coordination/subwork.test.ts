/**
 * §6 sub-work: lanes and session worktrees as leases, the §6.6 sweep guards, and the §4.7 bench lock. §11 rows: 17 (two
 * bench processes resuming one benchId; an O_EXCL lock; the boot-time rule), 18 (stale lane worktrees of a dead run),
 * 21 (a dirty or unmerged worktree is never removed), plus review #37 (a `laneDir` the sweep would `rm -rf` is bounded).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { acquireBenchLock, benchLockInUseMessage, declareLane, declareWorktree, laneLeases, parseBenchLock, readBenchLock, releaseBenchLock, staleLaneLeases, BENCH_LOCK_FILE } from '../../../src/coordination/subwork.js';
import { buildWorktreeRecord, createWorktree, listWorktrees, lockReasonFor, parseLockReason, parseWorktreeList, parseWorktreeRecord, removeWorktree, sweepWorktrees, LOCK_REASON_PREFIX } from '../../../src/coordination/worktree.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths, sessionWorktreeDir } from '../../../src/coordination/paths.js';
import type { LedgerHandle, RunGit } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, REPO, SELF, T0, TRUSTED, claim, entry, fakeClock, fakeTimers, foldOf, iso, makeHeartbeat, makeLease, makeSelf, runId, stamp, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function ledger(patch: Partial<ReturnType<typeof makeSelf>> = {}) {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const l: LedgerHandle = openLedger({ home: t.home, self: makeSelf(patch), now: clock.now, monotonicNow: clock.monotonicNow, timers: fakeTimers(), isPidAlive: () => true, pid: 4242, scanOnly: true });
  cleanups.push(() => l.close());
  await l.open();
  return { t, l, clock };
}

describe('§6.2 lanes as leases', () => {
  it('a lane lease claims NO workspace path and carries a run-relative laneDir', async () => {
    const { l } = await ledger();
    const h = declareLane(l, { laneDir: 'tmp/synth/lane2', step: 4, stage: 'execute', branch: 'main', head: null });
    await l.close();
    const lease = [...l.fold.leases.values()].find((x) => x.leaseId === h.leaseId);
    expect(lease?.type).toBe('lane');
    expect(lease?.paths).toEqual([]);
    expect(lease?.laneDir).toBe('tmp/synth/lane2');
  });

  it('review #37: anything but `tmp/synth/lane<k>` is refused before a record exists', async () => {
    const { l } = await ledger();
    for (const bad of ['.', 'post', 'tmp/../..', '/abs/lane', 'tmp/synth/lane2/', 'src'])
      expect(() => declareLane(l, { laneDir: bad, step: 1, stage: 'execute', branch: null, head: null }), bad).toThrow(/tmp\/synth\/lane/);
  });

  it('§11 row 18: the sweep sees only OUR OWN local lane leases whose run is no longer live', () => {
    const rid = runId(9);
    const mineDead = makeLease({ runId: rid, sessionId: rid, leaseId: `${rid}-1`, type: 'lane', paths: [], laneDir: 'tmp/synth/lane1', stamp: stamp(1, DEV_A, rid) });
    const mineLive = makeLease({ runId: runId(1), sessionId: runId(1), leaseId: `${runId(1)}-2`, type: 'lane', paths: [], laneDir: 'tmp/synth/lane2', stamp: stamp(2, DEV_A, runId(1)) });
    const foreign = makeLease({ runId: runId(8), sessionId: runId(8), deviceId: DEV_B, leaseId: `${runId(8)}-3`, type: 'lane', paths: [], laneDir: 'tmp/synth/lane3', stamp: stamp(3, DEV_B, runId(8)) });
    const fold = foldOf([entry(makeHeartbeat(), SELF), entry(mineDead, SELF), entry(mineLive, SELF), entry(foreign, TRUSTED)]);
    expect(laneLeases(fold)).toHaveLength(3);
    // the live run's lane is untouched; a foreign lease never names a directory on THIS device
    expect(staleLaneLeases(fold, makeSelf()).map((x) => x.laneDir)).toEqual(['tmp/synth/lane1']);
  });
});

describe('§6.5 session worktrees', () => {
  const fakeGit = (script: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): { git: RunGit; calls: string[][] } => {
    const calls: string[][] = [];
    const git: RunGit = (args) => {
      calls.push([...args]);
      const key = args.slice(0, 2).join(' ');
      const r = script[key] ?? { code: 0 };
      return Promise.resolve({ code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
    };
    return { git, calls };
  };

  it('a worktree lease is `type:"worktree"` with the slug and no paths', async () => {
    const { l } = await ledger();
    const h = declareWorktree(l, { slug: 'fix-tests', step: 2, stage: 'coordinate', branch: 'main', head: null });
    await l.close();
    const lease = [...l.fold.leases.values()].find((x) => x.leaseId === h.leaseId);
    expect(lease?.type).toBe('worktree');
    expect(lease?.slug).toBe('fix-tests');
    expect(() => declareWorktree(l, { slug: 'Bad Slug', step: 1, stage: 'coordinate', branch: null, head: null })).toThrow(/is not a slug/);
  });

  it('createWorktree runs the §6.5 recipe and writes the metadata OUTSIDE the checkout', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const { git, calls } = fakeGit();
    const r = await createWorktree({ fs: nodeFs, root: t.root, home: t.home, git, nowIso: iso(T0) }, { repoKey: REPO, slug: 'fix-tests', base: 'HEAD', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, workspace: '/ws', syncedIgnored: ['.env.local'] });
    expect(calls[0]).toEqual(['worktree', 'add', '--lock', '--reason', lockReasonFor(runId(1), runId(1)), '-b', 'jevcode/fix-tests', sessionWorktreeDir(t.home, REPO, 'fix-tests'), 'HEAD']);
    expect(r.dir).toBe(sessionWorktreeDir(t.home, REPO, 'fix-tests'));
    expect(r.branch).toBe('jevcode/fix-tests');
    expect(r.record.syncedIgnored).toEqual(['.env.local']);
    // the metadata file is under coordination/worktrees/, never inside the worktree
    const file = commonsPaths(t.root).worktreeFile(REPO, 'fix-tests');
    expect(file.startsWith(t.root)).toBe(true);
    expect(parseWorktreeRecord((await nodeFs.readBounded(file, 8192)).text)).toEqual(r.record);
    expect(await listWorktrees({ fs: nodeFs, root: t.root, home: t.home }, REPO)).toHaveLength(1);
  });

  it('a duplicate slug, a bad slug and a failing git are all refused before anything is written', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const io = { fs: nodeFs, root: t.root, home: t.home, git: fakeGit().git, nowIso: iso(T0) };
    const input = { repoKey: REPO, slug: 'fix-tests', base: 'HEAD', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, workspace: '/ws' };
    await createWorktree(io, input);
    await expect(createWorktree(io, input)).rejects.toThrow(/already exists/);
    await expect(createWorktree(io, { ...input, slug: 'Bad Slug' })).rejects.toThrow(/is not a slug/);
    const failing = { ...io, git: fakeGit({ 'worktree add': { code: 128, stderr: 'fatal: already exists' } }).git };
    await expect(createWorktree(failing, { ...input, slug: 'other' })).rejects.toThrow(/git worktree add failed \(128\)/);
    expect(await listWorktrees(io, REPO)).toHaveLength(1);
  });

  it('§6.6 (a): a lock reason that is not ours is NEVER removed', async () => {
    expect(parseLockReason(lockReasonFor(runId(1), runId(2)))).toEqual({ runId: runId(1), sessionId: runId(2) });
    expect(parseLockReason('my own worktree')).toBeNull();
    expect(parseLockReason(`${LOCK_REASON_PREFIX}nope`)).toBeNull();
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = sessionWorktreeDir(t.home, REPO, 'fix-tests');
    const io = { fs: nodeFs, root: t.root, home: t.home, git: fakeGit({ 'worktree list': { code: 0, stdout: `worktree ${dir}\nHEAD abc\nbranch refs/heads/jevcode/fix-tests\nlocked a user's own reason\n` } }).git, nowIso: iso(T0) };
    await createWorktree(io, { repoKey: REPO, slug: 'fix-tests', base: 'HEAD', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, workspace: '/ws' });
    const r = await removeWorktree(io, { repoKey: REPO, slug: 'fix-tests', workspace: '/ws', force: true });
    expect(r).toMatchObject({ removed: false, refused: 'not-ours' });
    expect(await listWorktrees(io, REPO)).toHaveLength(1);
  });

  it('§6.6 (b) / §11 row 21: a live run, a dirty tree and an unmerged branch all keep the worktree', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = sessionWorktreeDir(t.home, REPO, 'fix-tests');
    const listed = { code: 0, stdout: `worktree ${dir}\nHEAD abc\nbranch refs/heads/jevcode/fix-tests\nlocked ${lockReasonFor(runId(1), runId(1))}\n` };
    const mk = (script: Parameters<typeof fakeGit>[0]) => ({ fs: nodeFs, root: t.root, home: t.home, git: fakeGit({ 'worktree list': listed, ...script }).git, nowIso: iso(T0) });
    const io = mk({});
    await createWorktree(io, { repoKey: REPO, slug: 'fix-tests', base: 'HEAD', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, workspace: '/ws' });
    expect(await removeWorktree(io, { repoKey: REPO, slug: 'fix-tests', workspace: '/ws', liveIds: new Set([runId(1)]) })).toMatchObject({ removed: false, refused: 'live' });
    expect(await removeWorktree(mk({ 'status --porcelain': { code: 0, stdout: ' M src/x.ts\n' } }), { repoKey: REPO, slug: 'fix-tests', workspace: '/ws' })).toMatchObject({ removed: false, refused: 'dirty' });
    expect(await removeWorktree(mk({ 'merge-base --is-ancestor': { code: 1 } }), { repoKey: REPO, slug: 'fix-tests', workspace: '/ws' })).toMatchObject({ removed: false, refused: 'unmerged' });
    // clean + merged, but younger than the retention
    expect(await removeWorktree(io, { repoKey: REPO, slug: 'fix-tests', workspace: '/ws', nowMs: T0 + 1000 })).toMatchObject({ removed: false, refused: 'too-young' });
    expect(await listWorktrees(io, REPO)).toHaveLength(1);
  });

  it('§6.6: clean, merged, unreferenced and past the retention → removed, lock released first', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = sessionWorktreeDir(t.home, REPO, 'fix-tests');
    const { git, calls } = fakeGit({ 'worktree list': { code: 0, stdout: `worktree ${dir}\nHEAD abc\nbranch refs/heads/jevcode/fix-tests\nlocked ${lockReasonFor(runId(1), runId(1))}\n` } });
    const io = { fs: nodeFs, root: t.root, home: t.home, git, nowIso: iso(T0) };
    await createWorktree(io, { repoKey: REPO, slug: 'fix-tests', base: 'HEAD', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, workspace: '/ws' });
    const report = await sweepWorktrees(io, { repoKey: REPO, workspace: '/ws', liveIds: new Set(), nowMs: T0 + 31 * 86_400_000 });
    expect(report.removed).toEqual(['fix-tests']);
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'unlock')).toBe(true);
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'prune')).toBe(true);
    expect(await listWorktrees(io, REPO)).toHaveLength(0);
  });

  it('a malformed or checksum-broken metadata file is skipped, never joined into a path', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = join(commonsPaths(t.root).worktreesDir, REPO);
    await nodeFs.mkdir(dir, 0o700);
    await nodeFs.writeAtomic(join(dir, 'ok.json'), `${JSON.stringify(buildWorktreeRecord({ repoKey: REPO, slug: 'ok', runId: runId(1), sessionId: runId(1), deviceId: DEV_A, dir60: '/x', branch: 'b', base: 'HEAD', createdAt: iso(T0), syncedIgnored: [] }))}\n`, { fsync: false, mode: 0o600 });
    await nodeFs.writeAtomic(join(dir, 'broken.json'), '{"v":1}\n', { fsync: false, mode: 0o600 });
    await nodeFs.writeAtomic(join(dir, '..evil.json'), '{}\n', { fsync: false, mode: 0o600 });
    expect((await listWorktrees({ fs: nodeFs, root: t.root, home: t.home }, REPO)).map((w) => w.slug)).toEqual(['ok']);
    expect(await listWorktrees({ fs: nodeFs, root: t.root, home: t.home }, 'not-a-key')).toEqual([]);
  });

  it('parseWorktreeList reads git’s porcelain form', () => {
    const out = parseWorktreeList('worktree /a\nHEAD aaa\nbranch refs/heads/main\n\nworktree /b\nHEAD bbb\ndetached\nlocked jevcode:x:y\n');
    expect(out).toEqual([
      { dir: '/a', head: 'aaa', branch: 'main', locked: false, lockReason: null },
      { dir: '/b', head: 'bbb', branch: null, locked: true, lockReason: 'jevcode:x:y' },
    ]);
  });
});

describe('§4.7 / §11 row 17: the bench lock', () => {
  it('O_EXCL: the second `bench --resume` gets a ConfigError naming the holder', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = join(t.home, 'bench', 'glm-vs-jev');
    const o = { benchId: 'glm-vs-jev', host: 'mbp.local', nowIso: iso(T0), isAlive: () => true };
    expect(acquireBenchLock(dir, { ...o, pid: 111 })).toEqual({ replaced: null });
    expect(readBenchLock(dir)?.pid).toBe(111);
    expect(() => acquireBenchLock(dir, { ...o, pid: 222 })).toThrow(/is in use by pid 111/);
    expect(benchLockInUseMessage('glm-vs-jev', { pid: 111, startedAt: iso(T0), host: 'mbp.local', benchId: 'glm-vs-jev' })).toContain(BENCH_LOCK_FILE);
    // our own lock is re-takeable
    expect(acquireBenchLock(dir, { ...o, pid: 111 }).replaced).toBeNull();
  });

  it('a dead holder, another host, or a lock that predates boot is replaced with one warning', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = join(t.home, 'bench', 'b1');
    const warns: string[] = [];
    acquireBenchLock(dir, { benchId: 'b1', pid: 111, host: 'mbp.local', nowIso: iso(T0), isAlive: () => true });
    const r = acquireBenchLock(dir, { benchId: 'b1', pid: 222, host: 'mbp.local', nowIso: iso(T0), isAlive: () => false, warn: (m) => warns.push(m) });
    expect(r.replaced?.pid).toBe(111);
    expect(warns[0]).toMatch(/replaced a stale bench\.lock/);
    expect(readBenchLock(dir)?.pid).toBe(222);
    // §11 row 2: a live pid that predates boot is still stale
    const boot = iso(T0 + 60_000);
    const r2 = acquireBenchLock(dir, { benchId: 'b1', pid: 333, host: 'mbp.local', nowIso: iso(T0 + 120_000), bootAt: boot, isAlive: () => true, warn: (m) => warns.push(m) });
    expect(r2.replaced?.pid).toBe(222);
    expect(warns[1]).toMatch(/predates boot/);
  });

  it('release removes only a lock this process wrote; a malformed lock reads as absent', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = join(t.home, 'bench', 'b2');
    acquireBenchLock(dir, { benchId: 'b2', pid: 111, host: 'mbp.local', nowIso: iso(T0), isAlive: () => true });
    expect(releaseBenchLock(dir, { pid: 222 })).toBe(false);
    expect(releaseBenchLock(dir, { pid: 111 })).toBe(true);
    expect(readBenchLock(dir)).toBeNull();
    expect(releaseBenchLock(dir)).toBe(false);
    expect(parseBenchLock('not json')).toBeNull();
    expect(parseBenchLock('{"pid":0}')).toBeNull();
  });

  it('30 bench runs in one process take the lock once and the runner keeps it', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const dir = join(t.home, 'bench', 'glm-vs-jev');
    const o = { benchId: 'glm-vs-jev', pid: 4242, host: 'mbp.local', nowIso: iso(T0), isAlive: () => true };
    acquireBenchLock(dir, o);
    for (let i = 0; i < 30; i++) expect(() => acquireBenchLock(dir, { ...o, pid: 9000 + i })).toThrow(/is in use by pid 4242/);
    expect(readBenchLock(dir)?.pid).toBe(4242);
    expect(releaseBenchLock(dir, { pid: 4242 })).toBe(true);
    expect(claim().epoch).toBe(1);
  });
});
