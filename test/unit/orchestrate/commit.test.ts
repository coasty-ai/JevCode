/**
 * `src/orchestrate/commit.ts` — [G1] the harness commits, [D2] the `addSet` is computed
 * (ORCHESTRATION-DESIGN §2.6, M12 invariants (i) and (ii), corner rows 17, 36, 37, 54, 55).
 *
 * The two named cases of the design are here: "a working agent is never empty" and
 * "synced-dirty exclusion", the latter as a property over generated dirty sets with a seeded
 * PRNG written inline (no new dependency, and the same 20 cases on every machine).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ADD_SET_CHUNK } from '../../../src/core/limits.js';
import { commitMessage, commitStep, computeAddSet, syncedDirtyEntry, uncommitLast } from '../../../src/orchestrate/commit.js';
import { applyDirtySnapshot, cleanProbe } from '../../../src/orchestrate/worktree.js';
import type { CommitIdentity, SyncedDirtyEntry } from '../../../src/orchestrate/types.js';
import { git, headSha, tempRepo, write } from './helpers.js';
import type { TempRepo } from './helpers.js';

const IDENTITY: CommitIdentity = { name: 'jevcode', email: 'jevcode@local' };

const repos: TempRepo[] = [];

function repo(files?: Record<string, string>): TempRepo {
  const r = tempRepo(files);
  repos.push(r);
  return r;
}

afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

/** The parent's uncommitted work, replayed into the worktree exactly as §2.3's sync would. */
async function sync(ws: string, files: Record<string, string>): Promise<SyncedDirtyEntry[]> {
  return applyDirtySnapshot(
    Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.from(content), mode: 0o644 })),
    ws,
  );
}

function diffNames(ws: string, from: string, to: string): string[] {
  return git(ws, 'diff', '--name-only', `${from}..${to}`).split('\n').filter((l) => l !== '');
}

function commitCount(ws: string, from: string, to: string): number {
  return Number.parseInt(git(ws, 'rev-list', '--count', `${from}..${to}`).trim(), 10);
}

describe('commitMessage', () => {
  it('clips the summary to 60 characters and strips newlines', () => {
    expect(commitMessage('fix-store', 4, 'edit src/checkpoint/store.ts')).toBe('jevcode fix-store step 4: edit src/checkpoint/store.ts');
    const long = commitMessage('a', 1, `${'x'.repeat(90)}\nsecond line`);
    expect(long).toBe(`jevcode a step 1: ${'x'.repeat(60)}`);
    expect(commitMessage('a', 1, 'one\ntwo\tthree')).toBe('jevcode a step 1: one two three');
  });
});

describe('a working agent is never empty (M12 (i), corner row 37)', () => {
  it.each([
    ['a new file', (ws: string): string[] => { write(ws, 'src/new.ts', 'export const a = 1;\n'); return ['src/new.ts']; }],
    ['a modified tracked file', (ws: string): string[] => { write(ws, 'src/t0.ts', 'changed\n'); return ['src/t0.ts']; }],
    ['a deletion', (ws: string): string[] => { rmSync(join(ws, 'src/t0.ts')); return ['src/t0.ts']; }],
  ])('%s ends the run with at least one commit', async (_label, act) => {
    const r = repo({ 'README.md': 'x\n', 'src/t0.ts': 'zero\n' });
    const base = headSha(r.ws);
    const touched = act(r.ws);

    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched, syncedDirty: [] });
    expect(addSet).toEqual(touched);
    const res = await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'fix-store', step: 1, summary: 'work' });

    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(commitCount(r.ws, base, 'HEAD')).toBeGreaterThanOrEqual(1);
    expect(git(r.ws, 'log', '-1', '--format=%an <%ae>').trim()).toBe('jevcode <jevcode@local>');
    expect(git(r.ws, 'log', '-1', '--format=%s').trim()).toBe('jevcode fix-store step 1: work');
  });

  it('an empty addSet is no commit and no error (corner row 37: the agent that had nothing to do)', async () => {
    const r = repo();
    const base = headSha(r.ws);
    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: [], syncedDirty: [] });
    expect(addSet).toEqual([]);
    expect(await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'idle', step: 2, summary: 'nothing to change' })).toEqual({ ok: true, commit: null });
    expect(commitCount(r.ws, base, 'HEAD')).toBe(0);
  });
});

describe('[D2] synced-dirty exclusion', () => {
  /** A seeded LCG, so the 20 generated cases are the same 20 on every machine. */
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  const TRACKED = ['src/t0.ts', 'src/t1.ts', 'src/t2.ts', 'src/t3.ts', 'pkg/t4.json', 'docs/t5.md'];
  const UNTRACKED = ['gen/u0.txt', 'gen/u1.txt', 'src/u2.ts', 'lock/u3.lock', 'docs/u4.md', 'bin/u5.sh'];

  it('property: a syncedDirty path is in baseSha..branch IFF this agent changed it (20 generated sets)', async () => {
    const r = repo(Object.fromEntries([...TRACKED.map((p) => [p, `base ${p}\n`]), ['README.md', 'x\n']]));
    const base = headSha(r.ws);
    const rand = prng(0xc0ffee);
    const pool = [...TRACKED, ...UNTRACKED];

    for (let c = 0; c < 20; c++) {
      git(r.ws, 'reset', '-q', '--hard', base);
      git(r.ws, 'clean', '-fdq');
      git(r.ws, 'checkout', '-q', '-B', `case${c}`, base);

      const n = 3 + Math.floor(rand() * (pool.length - 3));
      const paths = pool.filter(() => rand() < 0.75).slice(0, n);
      if (paths.length === 0) paths.push(pool[c % pool.length] ?? 'src/t0.ts');
      const synced = await sync(r.ws, Object.fromEntries(paths.map((p) => [p, `parent hunk for ${p}\n`])));

      const edited = paths.filter(() => rand() < 0.3);
      for (const p of edited) write(r.ws, p, `parent hunk for ${p}\nagent hunk\n`);
      const fresh = rand() < 0.5 ? [`agent/own${c}.ts`] : [];
      for (const p of fresh) write(r.ws, p, 'agent only\n');
      const touched = [...edited, ...fresh];

      const { addSet, carried } = await computeAddSet(r.runGit, r.ws, { touched, syncedDirty: synced });
      expect([...carried].sort()).toEqual(paths.filter((p) => !edited.includes(p)).sort());
      const res = await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'agent-a', step: c, summary: `case ${c}` });
      expect(res.ok).toBe(true);

      const diff = new Set(diffNames(r.ws, base, `case${c}`));
      for (const p of paths) expect([p, diff.has(p)]).toEqual([p, edited.includes(p)]);
      for (const p of fresh) expect(diff.has(p)).toBe(true);
    }
  }, 60_000); // 20 cases × ~8 real git invocations; generous, because the default 20 s is close on a loaded machine

  it('corner row 55: 200 synced-dirty entries and zero touches produce an empty diff', async () => {
    const r = repo();
    const base = headSha(r.ws);
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`parent/f${i}.txt`] = `parent ${i}\n`;
    const synced = await sync(r.ws, files);
    expect(synced).toHaveLength(200);

    const { addSet, carried, dirtyNow } = await computeAddSet(r.runGit, r.ws, { touched: [], syncedDirty: synced });
    expect(dirtyNow).toHaveLength(200);
    expect(carried).toHaveLength(200);
    expect(addSet).toEqual([]);
    expect(await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'quiet', step: 1, summary: 'no writes' })).toEqual({ ok: true, commit: null });
    expect(diffNames(r.ws, base, 'HEAD')).toEqual([]);
  });

  it('corner row 54: a carried path the agent edits leaves `carried` and is committed with BOTH sets of hunks', async () => {
    const r = repo({ 'README.md': 'x\n', 'src/store.ts': 'base\n' });
    const base = headSha(r.ws);
    const synced = await sync(r.ws, { 'src/store.ts': 'base\nparent hunk\n' });
    write(r.ws, 'src/store.ts', 'base\nparent hunk\nagent hunk\n');

    const { addSet, carried } = await computeAddSet(r.runGit, r.ws, { touched: ['src/store.ts'], syncedDirty: synced });
    expect(carried).toEqual([]);
    expect(addSet).toEqual(['src/store.ts']);
    await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'fix-store', step: 3, summary: 'edit the store' });

    expect(git(r.ws, 'show', 'HEAD:src/store.ts')).toBe('base\nparent hunk\nagent hunk\n');
    expect(diffNames(r.ws, base, 'HEAD')).toEqual(['src/store.ts']);
  });

  it('[D2] the sha recheck sees a `run` command that rewrote an already-dirty file', async () => {
    const r = repo({ 'README.md': 'x\n', 'package-lock.json': '{}\n' });
    const synced = await sync(r.ws, { 'package-lock.json': '{"parent":1}\n' });
    // a formatter / lockfile regeneration: `changedFiles()` cannot see it, so `touched` is empty
    write(r.ws, 'package-lock.json', '{"regenerated":true}\n');

    const { addSet, carried } = await computeAddSet(r.runGit, r.ws, { touched: [], syncedDirty: synced });
    expect(carried).toEqual([]);
    expect(addSet).toEqual(['package-lock.json']);
  });
});

describe('corner row 36: end-commit + carried-is-not-dirty', () => {
  it('after the run:end commit the worktree measures clean, though the carried set is still dirty vs HEAD', async () => {
    const r = repo({ 'README.md': 'x\n', 'src/a.ts': 'a\n' });
    const synced = await sync(r.ws, { 'src/a.ts': 'parent work\n' });
    write(r.ws, 'src/own.ts', 'agent work\n');

    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: ['src/own.ts'], syncedDirty: synced });
    expect(addSet).toEqual(['src/own.ts']);
    expect(await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'a', step: 9, summary: 'run:end' })).toMatchObject({ ok: true });

    // the parent's hunks are STILL uncommitted here — that is what `carried` is for
    expect(git(r.ws, 'status', '--porcelain')).toBe(' M src/a.ts\n');
    expect(await cleanProbe(r.runGit, r.ws, { syncedDirty: synced, syncedIgnored: [] })).toEqual({ clean: true, dirty: [] });

    // ... and an uncommitted file OUTSIDE carried ∪ syncedIgnored is the crash case
    write(r.ws, 'src/died.ts', 'half a step\n');
    expect(await cleanProbe(r.runGit, r.ws, { syncedDirty: synced, syncedIgnored: [] })).toEqual({ clean: false, dirty: ['src/died.ts'] });
  });
});

describe('the add invocation', () => {
  it('--literal-pathspecs: `pages/[slug].tsx` stages that file and never `pages/s.tsx`', async () => {
    const r = repo({ 'README.md': 'x\n' });
    const base = headSha(r.ws);
    // `pages/s.tsx` is the parent's uncommitted work (carried); the agent wrote the bracket file
    const synced = await sync(r.ws, { 'pages/s.tsx': 'parent page\n' });
    write(r.ws, 'pages/[slug].tsx', 'export default function Slug() {}\n');

    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: ['pages/[slug].tsx'], syncedDirty: synced });
    expect(addSet).toEqual(['pages/[slug].tsx']);
    await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'pages', step: 1, summary: 'add the slug page' });

    // as a GLOB, `pages/[slug].tsx` is a character class that matches `pages/s.tsx` and not itself
    expect(diffNames(r.ws, base, 'HEAD')).toEqual(['pages/[slug].tsx']);
    expect(r.calls.some((c) => c.args[0] === '--literal-pathspecs' && c.args[1] === 'add')).toBe(true);
  });

  it(`chunks the addSet at ${String(ADD_SET_CHUNK)} paths per invocation`, async () => {
    const r = repo();
    const n = ADD_SET_CHUNK + 4;
    for (let i = 0; i < n; i++) write(r.ws, `many/f${i}.txt`, `${i}\n`);

    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: [], syncedDirty: [] });
    expect(addSet).toHaveLength(n);
    await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'bulk', step: 1, summary: 'many files' });

    const adds = r.calls.filter((c) => c.args.includes('add'));
    expect(adds).toHaveLength(2);
    expect(adds[0]?.args.filter((a) => a.startsWith('many/'))).toHaveLength(ADD_SET_CHUNK);
    expect(adds[1]?.args.filter((a) => a.startsWith('many/'))).toHaveLength(4);
    expect(Number.parseInt(git(r.ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((l) => l !== '').length.toString(), 10)).toBe(n);
  });

  it('no --no-verify is ever passed: GIT_BASE_FLAGS already makes every hook unreachable', async () => {
    const r = repo();
    write(r.ws, 'a.txt', 'a\n');
    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: ['a.txt'], syncedDirty: [] });
    await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'a', step: 1, summary: 's' });
    expect(r.calls.some((c) => c.args.includes('--no-verify'))).toBe(false);
    expect(r.calls.some((c) => c.args.includes('commit.gpgsign=false'))).toBe(true);
  });

  it('reports a git failure instead of throwing', async () => {
    const r = repo();
    const res = await commitStep(r.runGit, r.ws, { addSet: ['never/written.ts'], identity: IDENTITY, slug: 'a', step: 1, summary: 's' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/git add failed/);
  });
});

describe('uncommitLast (only `[x] drop --uncommit`)', () => {
  it('resets the last commit soft, keeping the files staged', async () => {
    const r = repo();
    const base = headSha(r.ws);
    write(r.ws, 'a.txt', 'a\n');
    const { addSet } = await computeAddSet(r.runGit, r.ws, { touched: ['a.txt'], syncedDirty: [] });
    await commitStep(r.runGit, r.ws, { addSet, identity: IDENTITY, slug: 'a', step: 1, summary: 's' });
    expect(commitCount(r.ws, base, 'HEAD')).toBe(1);

    expect(await uncommitLast(r.runGit, r.ws)).toEqual({ ok: true });
    expect(headSha(r.ws)).toBe(base);
    expect(git(r.ws, 'status', '--porcelain').trim()).toBe('A  a.txt');
    expect(existsSync(join(r.ws, 'a.txt'))).toBe(true);
  });

  it('refuses when there is nothing to reset onto', async () => {
    const r = repo();
    const res = await uncommitLast(r.runGit, r.ws);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/one commit/);
  });
});

describe('syncedDirtyEntry', () => {
  it('records the sha of the bytes and the mode, masked', () => {
    const e = syncedDirtyEntry('a.bin', Buffer.from([0, 1, 2]), 0o100_755);
    expect(e.mode).toBe(0o755);
    expect(e.sha256).toHaveLength(64);
  });
});
