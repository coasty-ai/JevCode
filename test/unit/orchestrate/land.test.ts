/**
 * `src/orchestrate/land.ts` — the pure `LandQueue` reducer (§5.2) and the git effects
 * (§5.2 [G3] [D14], §5.4 [D8]).
 *
 * The gate list of §8.2 D3: conflict, verify failure, lock, the ref-moved property, the empty
 * agent, the dirty agent — plus the [D14] dock-clean invariant (corner row 39), the kick with a
 * pre-existing `dock` branch (corner row 58), the 200-entry zero-escape-prompt case (corner
 * row 19) and total failure (corner row 42). The reducer cases run without git at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LAND_LOG_LINE_BYTES } from '../../../src/core/limits.js';
import { buildIncludeDropQuestion, outsideOwn } from '../../../src/orchestrate/critic.js';
import {
  acquireLandLock,
  appendLandLog,
  applyLandResult,
  applyLandStep,
  diffNames,
  landLogLine,
  landLogPath,
  mergePinned,
  nextLandStep,
  pinBranch,
  queueOrder,
  rebaseOnDock,
  recheckPin,
  releaseLandLock,
  restoreDock,
  revListCount,
  DOCK_CLEAN_FLOOR,
  LAND_LOCK_MAX_AGE_MS,
} from '../../../src/orchestrate/land.js';
import type { LandLock, LandQueueState, QueueAgent } from '../../../src/orchestrate/land.js';
import { applyDirtySnapshot, cleanProbe } from '../../../src/orchestrate/worktree.js';
import type { LandAttempt, SyncedDirtyEntry, VerifyResult } from '../../../src/orchestrate/types.js';
import { git, headSha, tempRepo, write } from './helpers.js';
import type { TempRepo } from './helpers.js';

const repos: TempRepo[] = [];

afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

// ---------------------------------------------------------------------------------------
// (a) the pure reducer
// ---------------------------------------------------------------------------------------

function agent(slug: string, over: Partial<QueueAgent> = {}): QueueAgent {
  return { slug, state: 'done', dependsOn: [], branch: `jevcode/${slug}`, score: null, kicks: 0, ...over };
}

function queue(agents: readonly QueueAgent[], over: Partial<LandQueueState> = {}): LandQueueState {
  return { agents, landed: [], head: 'dock0', attempts: [], holding: null, ...over };
}

function attempt(slug: string, over: Partial<LandAttempt> = {}): LandAttempt {
  return { at: '2026-09-21T00:00:00.000Z', slug, pinned: 'a'.repeat(40), dockHead: 'dock0', outcome: 'landed', kick: 0, ...over };
}

describe('the LandQueue reducer (§5.2), without git', () => {
  it('orders topologically first, then by score descending, then by slug', () => {
    const agents = [
      agent('zeta', { score: 0.9 }),
      agent('alpha', { score: 0.9 }),
      agent('beta', { score: 0.95 }),
      agent('prelude'),
      agent('late', { dependsOn: ['beta'], score: 1 }),
      agent('latest', { dependsOn: ['late'], score: 1 }),
    ];
    expect(queueOrder(agents).map((a) => a.slug)).toEqual(['beta', 'alpha', 'zeta', 'prelude', 'late', 'latest']);
  });

  it('a cyclic dependsOn does not hang the sort', () => {
    const agents = [agent('a', { dependsOn: ['b'] }), agent('b', { dependsOn: ['a'] })];
    expect(queueOrder(agents).map((x) => x.slug)).toEqual(['a', 'b']);
  });

  it('an agent whose dependsOn has not landed is not attemptable yet', () => {
    const state = queue([agent('child', { dependsOn: ['prelude'] }), agent('prelude', { state: 'running' })]);
    expect(nextLandStep(state, { maxKicks: 1 })).toBeNull();

    const ready = queue([agent('child', { dependsOn: ['prelude'] }), agent('prelude')]);
    expect(nextLandStep(ready, { maxKicks: 1 })).toEqual({ kind: 'attempt', slug: 'prelude' });

    const landed = applyLandResult(applyLandStep(ready, { kind: 'attempt', slug: 'prelude' }), attempt('prelude', { commit: 'dock1' }));
    expect(landed.landed).toEqual(['prelude']);
    expect(landed.head).toBe('dock1');
    expect(nextLandStep(landed, { maxKicks: 1 })).toEqual({ kind: 'attempt', slug: 'child' });
  });

  it('returns null while an attempt is in flight', () => {
    const state = queue([agent('a'), agent('b')], { holding: 'a' });
    expect(nextLandStep(state, { maxKicks: 1 })).toBeNull();
    expect(nextLandStep(queue([agent('a', { state: 'landing' }), agent('b')]), { maxKicks: 1 })).toBeNull();
  });

  it('kicks a conflicted agent at most maxKicks times, then parks it (§5.4)', () => {
    const conflicted = queue([agent('fix-store', { state: 'conflicted' })], { attempts: [attempt('fix-store', { outcome: 'conflicted', conflicts: ['src/checkpoint/store.ts'] })] });
    const kick = nextLandStep(conflicted, { maxKicks: 1 });
    expect(kick).toEqual({ kind: 'kick', slug: 'fix-store', reason: 'conflicts with the dock in src/checkpoint/store.ts' });

    const kicked = applyLandStep(conflicted, kick ?? { kind: 'settle', landed: [], parked: [], dropped: [] });
    expect(kicked.agents[0]).toMatchObject({ state: 'kicked', kicks: 1 });

    // it comes back `done`, fails again, and now has no kicks left
    const again: LandQueueState = { ...kicked, agents: [{ ...(kicked.agents[0] ?? agent('fix-store')), state: 'failed-verify' }] };
    const park = nextLandStep(again, { maxKicks: 1 });
    expect(park?.kind).toBe('park');
    expect(park?.kind === 'park' && park.reason).toContain('no kicks left (1 of 1)');
    expect(applyLandStep(again, park ?? { kind: 'settle', landed: [], parked: [], dropped: [] }).agents[0]).toMatchObject({ state: 'parked' });
  });

  it('a hard-rule refusal names the rule in the kick reason', () => {
    const state = queue([agent('a', { state: 'failed-verify' })], { attempts: [attempt('a', { outcome: 'refused', rule: 'removed 4 assertions in test/unit/store.test.ts' })] });
    expect(nextLandStep(state, { maxKicks: 1 })).toEqual({ kind: 'kick', slug: 'a', reason: 'removed 4 assertions in test/unit/store.test.ts' });
  });

  it('parks a dependant whose dependency can never land', () => {
    const state = queue([agent('child', { dependsOn: ['prelude'] }), agent('prelude', { state: 'parked' })]);
    expect(nextLandStep(state, { maxKicks: 1 })).toEqual({ kind: 'park', slug: 'child', reason: 'its dependency prelude did not land' });
  });

  it('corner row 42: all agents fail to land — three parks, then a settle with nothing landed', () => {
    let state = queue([
      agent('a', { state: 'conflicted' }),
      agent('b', { state: 'conflicted' }),
      agent('c', { state: 'failed-verify' }),
    ]);
    const steps: string[] = [];
    for (let i = 0; i < 8; i++) {
      const step = nextLandStep(state, { maxKicks: 0 });
      if (step === null) break;
      steps.push(`${step.kind}:${step.kind === 'settle' ? '' : step.slug}`);
      if (step.kind === 'settle') {
        expect(step.landed).toEqual([]);
        expect(step.parked).toEqual(['a', 'b', 'c']);
        break;
      }
      state = applyLandStep(state, step);
    }
    expect(steps).toEqual(['park:a', 'park:b', 'park:c', 'settle:']);
  });

  it('settles with the landed, parked and dropped partition', () => {
    const state = queue([agent('a', { state: 'landed' }), agent('b', { state: 'parked' }), agent('c', { state: 'crashed' })], { landed: ['a'] });
    expect(nextLandStep(state, { maxKicks: 1 })).toEqual({ kind: 'settle', landed: ['a'], parked: ['b'], dropped: ['c'] });
  });

  it('applyLandResult appends the attempt, clears the slot and moves the head only on a landed merge', () => {
    const start = applyLandStep(queue([agent('a')]), { kind: 'attempt', slug: 'a' });
    expect(start.holding).toBe('a');
    const failed = applyLandResult(start, attempt('a', { outcome: 'failed-verify' }));
    expect(failed.holding).toBeNull();
    expect(failed.head).toBe('dock0');
    expect(failed.landed).toEqual([]);
    expect(failed.agents[0]?.state).toBe('failed-verify');
    expect(failed.attempts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// (b) the effects, against a real repository with real linked worktrees
// ---------------------------------------------------------------------------------------

const DOCK_BRANCH = 'jevcode/dock-a2fee9c1';

interface Fixture {
  r: TempRepo;
  base: string;
  dockDir: string;
  agentDir: string;
}

function fixture(files?: Record<string, string>): Fixture {
  const r = tempRepo(files);
  repos.push(r);
  const base = headSha(r.ws);
  const dockDir = join(r.base, 'dock');
  const agentDir = join(r.base, 'agent');
  git(r.ws, 'worktree', 'add', '-q', '-b', DOCK_BRANCH, dockDir, base);
  git(r.ws, 'worktree', 'add', '-q', '-b', 'jevcode/fix-store', agentDir, base);
  return { r, base, dockDir, agentDir };
}

/** Commit exactly `rel` — the scoped commit set §2.6 computes, never `add -A`. */
function commitIn(dir: string, rel: string, content: string, message: string): string {
  write(dir, rel, content);
  git(dir, '--literal-pathspecs', 'add', '-A', '--', rel);
  git(dir, 'commit', '-q', '-m', message);
  return headSha(dir);
}

describe('[G3] pinning', () => {
  it('resolves the branch to an object name once, and refuses an unknown slug', async () => {
    const f = fixture();
    const sha = commitIn(f.agentDir, 'src/a.ts', 'agent\n', 'agent work');
    expect(await pinBranch(f.r.runGit, f.dockDir, 'fix-store')).toBe(sha);
    expect(await pinBranch(f.r.runGit, f.dockDir, 'never-existed')).toBeNull();
    expect(await pinBranch(f.r.runGit, f.dockDir, '../etc/passwd')).toBeNull();
  });

  it('property (corner row 51): a branch that moves between the pin and the merge is refused every time, and the dock is untouched', async () => {
    const f = fixture({ 'README.md': 'x\n', 'src/a.ts': 'base\n' });
    const dockHead = headSha(f.dockDir);

    for (let c = 0; c < 10; c++) {
      commitIn(f.agentDir, 'src/a.ts', `agent ${c}\n`, `step ${c}`);
      const pinned = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
      expect(pinned).not.toBeNull();

      // a sibling's sandboxed command moves the ref between the verify and the merge
      if (c % 2 === 0) commitIn(f.agentDir, 'src/a.ts', `moved ${c}\n`, `sneaky ${c}`);
      else git(f.agentDir, 'reset', '-q', '--hard', 'HEAD~1');

      const recheck = await recheckPin(f.r.runGit, f.dockDir, 'fix-store', pinned ?? '');
      expect(recheck.ok).toBe(false);
      expect(!recheck.ok && recheck.reason).toBe('the branch moved during verification');
      expect(headSha(f.dockDir)).toBe(dockHead);
      expect(git(f.dockDir, 'status', '--porcelain')).toBe('');
    }

    const stable = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
    expect(await recheckPin(f.r.runGit, f.dockDir, 'fix-store', stable ?? '')).toEqual({ ok: true });
  }, 60_000);

  it('mergePinned refuses anything that is not an object name, so a ref can never be merged', async () => {
    const f = fixture();
    commitIn(f.agentDir, 'src/a.ts', 'agent\n', 'agent work');
    const before = headSha(f.dockDir);
    expect(await mergePinned(f.r.runGit, f.dockDir, 'jevcode/fix-store')).toEqual({ ok: false, conflicts: [] });
    expect(headSha(f.dockDir)).toBe(before);
    expect(f.r.calls.some((c) => c.args.includes('merge'))).toBe(false);
  });
});

describe('the land attempt', () => {
  it('corner row 37: an empty agent branch lands trivially as a no-op', async () => {
    const f = fixture();
    const pinned = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
    expect(pinned).toBe(f.base);
    expect(await revListCount(f.r.runGit, f.dockDir, f.base, pinned ?? '')).toBe(0);
    expect(await cleanProbe(f.r.runGit, f.agentDir, { syncedDirty: [], syncedIgnored: [] })).toEqual({ clean: true, dirty: [] });

    const before = headSha(f.dockDir);
    expect(await mergePinned(f.r.runGit, f.dockDir, pinned ?? '')).toEqual({ ok: true });
    expect(headSha(f.dockDir)).toBe(before);
  });

  it('a clean merge moves the dock and records the merge commit', async () => {
    const f = fixture();
    commitIn(f.agentDir, 'src/agent.ts', 'agent\n', 'agent work');
    const before = headSha(f.dockDir);
    const pinned = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
    expect(await mergePinned(f.r.runGit, f.dockDir, pinned ?? '')).toEqual({ ok: true });
    expect(headSha(f.dockDir)).not.toBe(before);
    expect(await revListCount(f.r.runGit, f.dockDir, before, 'HEAD')).toBeGreaterThanOrEqual(2); // --no-ff: the merge commit plus the agent's
    expect(await diffNames(f.r.runGit, f.dockDir, before, 'HEAD')).toEqual(['src/agent.ts']);
  });

  it('corner row 38: a conflicting merge is aborted, the paths are recorded and the dock is left as it was', async () => {
    const f = fixture({ 'README.md': 'x\n', 'src/x.ts': 'base\n' });
    commitIn(f.agentDir, 'src/x.ts', 'agent line\n', 'agent work');
    commitIn(f.dockDir, 'src/x.ts', 'dock line\n', 'another agent landed first');
    const dockHead = headSha(f.dockDir);

    const pinned = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
    const merged = await mergePinned(f.r.runGit, f.dockDir, pinned ?? '');
    expect(merged).toEqual({ ok: false, conflicts: ['src/x.ts'] });
    expect(headSha(f.dockDir)).toBe(dockHead);
    expect(git(f.dockDir, 'status', '--porcelain')).toBe('');
  });

  it('corner row 39 [D14]: after a failed verify the dock keeps nothing outside syncedIgnored ∪ dockCleanExclude', async () => {
    const f = fixture({ 'README.md': 'x\n', '.gitignore': 'dist/\n.env\nnode_modules/\n' });
    commitIn(f.agentDir, 'src/agent.ts', 'agent\n', 'agent work');
    const previousHead = headSha(f.dockDir);
    writeFileSync(join(f.dockDir, '.env'), 'KEY=from-the-parent\n'); // syncedIgnored, must SURVIVE
    mkdirSync(join(f.dockDir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(f.dockDir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');

    const pinned = await pinBranch(f.r.runGit, f.dockDir, 'fix-store');
    expect(await mergePinned(f.r.runGit, f.dockDir, pinned ?? '')).toEqual({ ok: true });

    // the verify command runs and fails, leaving its debris behind
    write(f.dockDir, 'dist/x.js', 'console.log(1)\n'); // gitignored: only `clean -x` removes it
    write(f.dockDir, 'coverage/report.html', '<html></html>\n');
    write(f.dockDir, 'src/agent.ts', 'a test wrote over it\n');

    expect(await restoreDock(f.r.runGit, f.dockDir, previousHead, ['.env', 'node_modules/', '.venv/'])).toEqual({ ok: true, reset: true, cleaned: true, reason: null });

    expect(headSha(f.dockDir)).toBe(previousHead);
    expect(git(f.dockDir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(existsSync(join(f.dockDir, '.env'))).toBe(true);
    expect(existsSync(join(f.dockDir, 'node_modules/pkg/index.js'))).toBe(true);
    expect(existsSync(join(f.dockDir, 'dist/x.js'))).toBe(false);
    expect(existsSync(join(f.dockDir, 'coverage/report.html'))).toBe(false);
    expect(existsSync(join(f.dockDir, 'src/agent.ts'))).toBe(false);
  });

  /**
   * Review finding 8. `reset --hard` was guarded by the object-name check and `clean -fdx` was
   * not, so the destructive half ran precisely when the safe half declined — on a tree that may
   * still hold a failed merge. The two halves now stand or fall together.
   */
  it('[D14] a previousHead that is not an object name restores NOTHING — no reset, and no clean', async () => {
    const f = fixture({ 'README.md': 'x\n', '.gitignore': 'dist/\n.env\nnode_modules/\n' });
    const dockHead = headSha(f.dockDir);
    write(f.dockDir, 'dist/x.js', 'console.log(1)\n');
    write(f.dockDir, 'precious.txt', 'the human has not committed this yet\n');

    for (const bad of [DOCK_BRANCH, 'HEAD', 'HEAD~1', '', 'refs/heads/jevcode/fix-store']) {
      const res = await restoreDock(f.r.runGit, f.dockDir, bad, []);
      expect(res.ok).toBe(false);
      expect(res.reset).toBe(false);
      expect(res.cleaned).toBe(false);
      expect(res.reason).toContain('not an object name');
      expect(res.reason).not.toContain(bad === '' ? '\u0000' : bad); // the caller's string is never echoed back
    }
    expect(existsSync(join(f.dockDir, 'dist/x.js'))).toBe(true);
    expect(existsSync(join(f.dockDir, 'precious.txt'))).toBe(true);
    expect(headSha(f.dockDir)).toBe(dockHead);
    expect(f.r.calls.some((c) => c.args.includes('clean'))).toBe(false);
  });

  it('[D14] the exclude floor is not the caller\'s to remove: `exclude: []` still spares .env and node_modules/', async () => {
    const f = fixture({ 'README.md': 'x\n', '.gitignore': 'dist/\n.env\nnode_modules/\n' });
    const previousHead = headSha(f.dockDir);
    writeFileSync(join(f.dockDir, '.env'), 'KEY=from-the-parent\n');
    writeFileSync(join(f.dockDir, '.env.local'), 'KEY=also-from-the-parent\n');
    mkdirSync(join(f.dockDir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(f.dockDir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
    write(f.dockDir, 'dist/x.js', 'console.log(1)\n');

    expect(await restoreDock(f.r.runGit, f.dockDir, previousHead, [])).toEqual({ ok: true, reset: true, cleaned: true, reason: null });
    expect(existsSync(join(f.dockDir, '.env'))).toBe(true);
    expect(existsSync(join(f.dockDir, '.env.local'))).toBe(true);
    expect(existsSync(join(f.dockDir, 'node_modules/pkg/index.js'))).toBe(true);
    expect(existsSync(join(f.dockDir, 'dist/x.js'))).toBe(false);
    expect(DOCK_CLEAN_FLOOR).toEqual(['.env*', 'node_modules/']);
  });

  it('corner row 36: an agent worktree dirty outside carried ∪ syncedIgnored is the crash case', async () => {
    const f = fixture({ 'README.md': 'x\n', 'src/a.ts': 'a\n' });
    const syncedDirty: SyncedDirtyEntry[] = await applyDirtySnapshot([{ path: 'src/a.ts', bytes: Buffer.from('parent work\n'), mode: 0o644 }], f.agentDir);
    writeFileSync(join(f.agentDir, '.env'), 'KEY=x\n');
    expect(await cleanProbe(f.r.runGit, f.agentDir, { syncedDirty, syncedIgnored: ['.env'] })).toEqual({ clean: true, dirty: [] });

    write(f.agentDir, 'src/half-a-step.ts', 'died here\n');
    expect(await cleanProbe(f.r.runGit, f.agentDir, { syncedDirty, syncedIgnored: ['.env'] })).toEqual({ clean: false, dirty: ['src/half-a-step.ts'] });
  });
});

describe('[D8] the kick', () => {
  it('corner row 58: a repo that already has a `dock` branch is untouched, and no fetch is made', async () => {
    const f = fixture({ 'README.md': 'x\n', 'src/x.ts': 'base\n' });
    git(f.r.ws, 'branch', 'dock', f.base);
    const before = git(f.r.ws, 'show-ref', 'refs/heads/dock');

    commitIn(f.dockDir, 'src/dock.ts', 'landed earlier\n', 'a sibling landed');
    commitIn(f.agentDir, 'src/agent.ts', 'agent\n', 'agent work');

    const rebase = await rebaseOnDock(f.r.runGit, f.agentDir, DOCK_BRANCH);
    expect(rebase).toEqual({ ok: true, conflicts: [] });
    // the clean rebase turns the kick into a plain re-land: the agent now sits on the dock head
    expect(git(f.agentDir, 'log', '--format=%s').split('\n').filter((l) => l !== '')).toEqual(['agent work', 'a sibling landed', 'init']);

    expect(git(f.r.ws, 'show-ref', 'refs/heads/dock')).toBe(before);
    expect(f.r.calls.some((c) => c.args.includes('fetch'))).toBe(false);
  });

  it('refuses any branch outside the `jevcode/` namespace rather than rebasing onto it', async () => {
    const f = fixture();
    git(f.r.ws, 'branch', 'dock', f.base);
    commitIn(f.agentDir, 'src/agent.ts', 'agent\n', 'agent work');
    expect(await rebaseOnDock(f.r.runGit, f.agentDir, 'dock')).toEqual({ ok: false, conflicts: [] });
    expect(f.r.calls.some((c) => c.args.includes('rebase'))).toBe(false);
  });

  it('a conflicting rebase is aborted and the conflicting paths are handed back', async () => {
    const f = fixture({ 'README.md': 'x\n', 'src/x.ts': 'base\n' });
    commitIn(f.dockDir, 'src/x.ts', 'dock line\n', 'a sibling landed');
    const agentHead = commitIn(f.agentDir, 'src/x.ts', 'agent line\n', 'agent work');

    const rebase = await rebaseOnDock(f.r.runGit, f.agentDir, DOCK_BRANCH);
    expect(rebase).toEqual({ ok: false, conflicts: ['src/x.ts'] });
    expect(headSha(f.agentDir)).toBe(agentHead);
    expect(git(f.agentDir, 'status', '--porcelain')).toBe('');
  });
});

describe('corner row 19: the escape prompt against a real branch', () => {
  it('[D2] a 200-entry synced-dirty set produces ZERO escape prompts', async () => {
    const f = fixture();
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `parent/f${i}.txt`, bytes: Buffer.from(`parent ${i}\n`), mode: 0o644 }));
    const syncedDirty = await applyDirtySnapshot(files, f.agentDir);
    commitIn(f.agentDir, 'src/tui/Pane.tsx', 'the agent\'s own work\n', 'own work');

    const changed = await diffNames(f.r.runGit, f.agentDir, f.base, 'jevcode/fix-store');
    expect(changed).toEqual(['src/tui/Pane.tsx']);
    const outside = await outsideOwn(f.agentDir, { changed, own: ['src/tui/**'], syncedDirty, incidentalGlobs: [], fold: false });
    expect(outside).toEqual([]);
    expect(buildIncludeDropQuestion('fix-store', outside)).toBeNull();
  });

  /**
   * Review finding 1, the same fixture told the truth. This test used to pass either way: the
   * only committed path was inside `own`, so `changed` never held a synced-dirty path and the
   * subtraction was never exercised at all. Here the agent REWRITES one of the parent's 200
   * dirty files — the [D2] hole `changedFiles()` cannot see, closed by the sha256 — and §2.6's
   * add set commits it, so it reaches `baseSha..<pinned>` and it is outside the slice. The old
   * `∖ syncedDirty.map(path)` swallowed it; `∖ carriedPaths` does not, while the other 199 stay
   * silent.
   */
  it('[D2] a parent-dirty file the agent REWROTE outside its slice is the one that prompts', async () => {
    const f = fixture();
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `parent/f${i}.txt`, bytes: Buffer.from(`parent ${i}\n`), mode: 0o644 }));
    const syncedDirty = await applyDirtySnapshot(files, f.agentDir);

    // a `run` command (a formatter, a codegen) rewrites one carried file, and the add set commits it
    write(f.agentDir, 'parent/f7.txt', 'the agent rewrote this\n');
    write(f.agentDir, 'src/tui/Pane.tsx', 'the agent\'s own work\n');
    git(f.agentDir, '--literal-pathspecs', 'add', '-A', '--', 'parent/f7.txt', 'src/tui/Pane.tsx');
    git(f.agentDir, 'commit', '-q', '-m', 'own work, and a formatter that did not stay in its lane');

    const changed = await diffNames(f.r.runGit, f.agentDir, f.base, 'jevcode/fix-store');
    expect(changed).toEqual(['parent/f7.txt', 'src/tui/Pane.tsx']);

    const outside = await outsideOwn(f.agentDir, { changed, own: ['src/tui/**'], syncedDirty, incidentalGlobs: [], fold: false });
    expect(outside).toEqual(['parent/f7.txt']);
    expect(buildIncludeDropQuestion('fix-store', outside)?.prompt).toBe(
      'fix-store touched 1 file outside its slice (parent/f7.txt) — [a] include them · [d] drop them from the merge · [x] refuse',
    );
  });
});

// ---------------------------------------------------------------------------------------
// the lock and the append-only log
// ---------------------------------------------------------------------------------------

describe('corner row 43: the land lock', () => {
  it('a second acquirer refuses, naming the holder', async () => {
    const r = tempRepo();
    repos.push(r);
    const first = await acquireLandLock(r.runDir, { pid: process.pid });
    expect(first.ok).toBe(true);

    const second = await acquireLandLock(r.runDir, { pid: process.pid + 1, isAlive: () => true });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toContain(`pid ${process.pid}`);
    expect(!second.ok && second.holder?.pid).toBe(process.pid);

    expect(first.ok && (await releaseLandLock(first.handle))).toBe(true);
    const third = await acquireLandLock(r.runDir, { pid: process.pid + 1, isAlive: () => true });
    expect(third.ok).toBe(true);
  });

  it('replaces a lock whose pid is gone, and refuses to release a newer holder\'s lock', async () => {
    const r = tempRepo();
    repos.push(r);
    const mine = await acquireLandLock(r.runDir, { pid: 4242, isAlive: () => false });
    expect(mine.ok).toBe(true);

    const next = await acquireLandLock(r.runDir, { pid: 4343, isAlive: () => false });
    expect(next.ok && next.replaced?.pid).toBe(4242);

    expect(mine.ok && (await releaseLandLock(mine.handle))).toBe(false);
    expect(next.ok && (await releaseLandLock(next.handle))).toBe(true);
    expect(existsSync(join(r.runDir, 'orchestrate/land.lock'))).toBe(false);
  });

  /**
   * Review finding 13. The old condition required `existing.host === host` for the REFUSAL, so
   * the default `host: ''` caller declared every named device's lock dead — the one host whose
   * liveness it cannot check. A different host is never ours to judge.
   */
  it('refuses a lock held by a DIFFERENT host, whatever this side believes about the pid', async () => {
    const r = tempRepo();
    repos.push(r);
    expect((await acquireLandLock(r.runDir, { pid: 4242, host: 'laptop', isAlive: () => false })).ok).toBe(true);

    for (const host of ['', 'desktop']) {
      const other = await acquireLandLock(r.runDir, { pid: 4343, host, isAlive: () => false });
      expect(other.ok).toBe(false);
      expect(!other.ok && other.holder?.pid).toBe(4242);
    }
    // ...and the holder can still take its own lock back
    expect((await acquireLandLock(r.runDir, { pid: 4242, host: 'laptop', isAlive: () => false })).ok).toBe(true);
  });

  it('honours LAND_LOCK_MAX_AGE_MS: a live pid protects a fresh lock, not a recycled one', async () => {
    const r = tempRepo();
    repos.push(r);
    const now = Date.UTC(2026, 8, 21);
    expect((await acquireLandLock(r.runDir, { pid: 4242, clock: () => now, isAlive: () => true })).ok).toBe(true);

    const fresh = await acquireLandLock(r.runDir, { pid: 4343, clock: () => now + LAND_LOCK_MAX_AGE_MS, isAlive: () => true });
    expect(fresh.ok).toBe(false);

    const expired = await acquireLandLock(r.runDir, { pid: 4343, clock: () => now + LAND_LOCK_MAX_AGE_MS + 1, isAlive: () => true });
    expect(expired.ok).toBe(true);
    expect(expired.ok && expired.replaced?.pid).toBe(4242);
  });

  it('an unparsable or missing startedAt is age-unknown, so liveness alone decides', async () => {
    const r = tempRepo();
    repos.push(r);
    mkdirSync(join(r.runDir, 'orchestrate'), { recursive: true });
    writeFileSync(join(r.runDir, 'orchestrate/land.lock'), `${JSON.stringify({ pid: 4242, host: '' })}\n`);
    expect((await acquireLandLock(r.runDir, { pid: 4343, isAlive: () => true })).ok).toBe(false);
    expect((await acquireLandLock(r.runDir, { pid: 4343, isAlive: () => false })).ok).toBe(true);
  });

  it('aborts the steal when the lock changed under it, and when another stealer won the rename', async () => {
    const r = tempRepo();
    repos.push(r);
    const dead: LandLock = { pid: 4242, startedAt: new Date().toISOString(), host: '' };
    const rival: LandLock = { pid: 5555, startedAt: new Date().toISOString(), host: '' };
    expect((await acquireLandLock(r.runDir, { pid: 4242, isAlive: () => false })).ok).toBe(true);

    // (1) the CAS read finds a different lock than the one that was judged stale
    const reads: (LandLock | null)[] = [dead, rival];
    const cas = await acquireLandLock(r.runDir, { pid: 4343, isAlive: (p) => p === 5555, readLock: async () => reads.shift() ?? null });
    expect(cas.ok).toBe(false);
    expect(!cas.ok && cas.holder?.pid).toBe(5555);

    // (2) the CAS agrees, the rename happens, and the post-read shows a rival's pid in the file
    const after: (LandLock | null)[] = [dead, dead, rival];
    const lost = await acquireLandLock(r.runDir, { pid: 4343, isAlive: (p) => p === 5555, readLock: async () => after.shift() ?? null });
    expect(lost.ok).toBe(false);
    expect(!lost.ok && lost.holder?.pid).toBe(5555);
    expect(existsSync(join(r.runDir, `orchestrate/land.lock.4343.tmp`))).toBe(false);
  });

  it('never throws: an unwritable run dir is a refusal, not an exception', async () => {
    const r = tempRepo();
    repos.push(r);
    const res = await acquireLandLock(join(r.runDir, 'nested\0bad'), { pid: 4242 });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.holder).toBeNull();
  });
});

describe('land.jsonl', () => {
  const verify = (tail: readonly string[]): VerifyResult => ({ command: 'npm test', ok: false, exitCode: 1, durationMs: 12, tail, counts: null, killed: false });

  it('is append-only, one line per attempt', async () => {
    const r = tempRepo();
    repos.push(r);
    await appendLandLog(r.runDir, attempt('a', { commit: 'deadbeef' }));
    await appendLandLog(r.runDir, attempt('b', { outcome: 'conflicted', conflicts: ['src/x.ts'], kick: 1 }));
    const lines = readFileSync(landLogPath(r.runDir), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ slug: 'b', outcome: 'conflicted', kick: 1 });
  });

  it('bounds each line to LAND_LOG_LINE_BYTES and keeps it parseable JSON', () => {
    const small = landLogLine(attempt('a'));
    expect(JSON.parse(small)).toMatchObject({ slug: 'a' });

    const huge = attempt('fix-store', {
      outcome: 'failed-verify',
      verify: [verify(Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(120)}`))],
      conflicts: Array.from({ length: 50 }, (_, i) => `src/conflict-${i}.ts`),
    });
    const line = landLogLine(huge);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(LAND_LOG_LINE_BYTES);
    expect(line).not.toContain('\n');
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({ slug: 'fix-store', outcome: 'failed-verify', pinned: 'a'.repeat(40) });
  });
});
