import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyCandidate } from '../../../../src/synth/verify/apply.js';
import { chooseLaneMode, createLanes, DIRTY_ENTRIES_MAX, LaneError, type LaneContext, parsePorcelainZ, safeRelativePath } from '../../../../src/synth/sieve/lanes.js';
import { candidate, fakeSandbox, GCD_BUGGY, oracle, site, sourceFile } from './helpers.js';

let tmp: string;
let ws: string;
let runDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-lanes-'));
  ws = join(tmp, 'ws');
  runDir = join(tmp, 'run');
  mkdirSync(ws);
  mkdirSync(runDir);
  writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gcd = sourceFile('gcd.py', GCD_BUGGY);
const FIX = applyCandidate(candidate(site(gcd, 5), 'return gcd(b, a % b)'));
const FIXED_SRC = 'def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(b, a % b)\n';

function ctxFor(sandbox: LaneContext['sandbox'], git: boolean): LaneContext {
  return { runDir, sandbox, signal: new AbortController().signal, workspaceInfo: { root: ws, git } };
}

describe('mode selection and path safety', () => {
  it('chooseLaneMode follows §4.2', () => {
    expect(chooseLaneMode({ runner: 'quixbugs' }, { git: true }, null)).toBe('candidate_file');
    expect(chooseLaneMode({ runner: 'pytest' }, { git: true }, null)).toBe('worktree');
    expect(chooseLaneMode({ runner: 'pytest' }, { git: false }, 10 * 1024 * 1024)).toBe('copy');
    expect(chooseLaneMode({ runner: 'pytest' }, { git: false }, 51 * 1024 * 1024)).toBe('inplace');
    expect(chooseLaneMode({ runner: 'other' }, { git: false }, null)).toBe('inplace');
  });
  it('safeRelativePath refuses absolute paths and .. segments', () => {
    expect(safeRelativePath('pkg/mod.py')).toBe('pkg/mod.py');
    expect(() => safeRelativePath('/etc/passwd')).toThrow(LaneError);
    expect(() => safeRelativePath('../x.py')).toThrow(LaneError);
    expect(() => safeRelativePath('a/../../x.py')).toThrow(LaneError);
    expect(() => safeRelativePath('')).toThrow(LaneError);
  });
  it('parsePorcelainZ reads modified, untracked, deleted and renamed entries', () => {
    // a rename is `R  <new>NUL<original>` in -z output
    expect(parsePorcelainZ(' M a.py\0?? new.txt\0 D gone.py\0R  new.py\0old.py\0')).toEqual([
      { path: 'a.py', deleted: false, untracked: false },
      { path: 'new.txt', deleted: false, untracked: true },
      { path: 'gone.py', deleted: true, untracked: false },
      { path: 'new.py', deleted: false, untracked: false },
    ]);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('candidate_file lanes (QuixBugs runner)', () => {
  it('creates lane dirs through the sandbox, writes the candidate file, no copy, rm -rf on dispose', async () => {
    const sb = fakeSandbox();
    const pool = await createLanes(ctxFor(sb, true), oracle({ runner: 'quixbugs', lanes: 8 }), { count: 2 });
    expect(pool.mode).toBe('candidate_file');
    expect(pool.lanes.map((l) => l.dir)).toEqual([join(runDir, 'tmp', 'synth', 'lane0'), join(runDir, 'tmp', 'synth', 'lane1')]);
    expect(sb.calls.map((c) => c.command)).toEqual([`mkdir -p '${join(runDir, 'tmp', 'synth')}'`, `mkdir -p '${join(runDir, 'tmp', 'synth', 'lane0')}'`, `mkdir -p '${join(runDir, 'tmp', 'synth', 'lane1')}'`]);
    expect(sb.calls.every((c) => c.cwd === ws)).toBe(true);

    const lane0 = pool.lanes[0];
    if (lane0 === undefined) throw new Error('no lane');
    await pool.applyToLane(lane0, FIX, new Map([[gcd.path, gcd]]));
    expect(readFileSync(join(lane0.dir, 'gcd.py'), 'utf8')).toBe(FIXED_SRC);
    expect(readFileSync(join(ws, 'gcd.py'), 'utf8')).toBe(GCD_BUGGY); // the workspace is never touched
    expect(pool.pathInLane(lane0, 'gcd.py')).toBe(join(lane0.dir, 'gcd.py'));
    expect(() => pool.pathInLane(lane0, '../escape.py')).toThrow(LaneError);

    const before = sb.calls.length;
    await pool.resetLane(lane0);
    expect(sb.calls.length).toBe(before); // nothing to reset
    await pool.disposeLanes();
    expect(sb.calls.slice(before).map((c) => c.command)).toEqual([`rm -rf '${lane0.dir}'`, `rm -rf '${join(runDir, 'tmp', 'synth', 'lane1')}'`]);
    await pool.disposeLanes(); // idempotent
    await expect(pool.withLane(async () => 1)).rejects.toThrow(LaneError);
  });
  it('withLane hands out each lane once and queues callers when all lanes are busy', async () => {
    const pool = await createLanes(ctxFor(fakeSandbox(), true), oracle({ runner: 'quixbugs' }), { count: 2 });
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const work = pool.withLane.bind(pool);
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        work(async (lane) => {
          active += 1;
          peak = Math.max(peak, active);
          seen.push(lane.index);
          await new Promise((r) => setTimeout(r, 5 * i));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(seen).toHaveLength(5);
    expect(pool.lanes.every((l) => !l.busy)).toBe(true);
  });
});

describe('worktree lanes (git workspaces)', () => {
  it('git worktree add --detach per lane, dirty files replayed, reset = checkout + clean, dispose = worktree remove', async () => {
    writeFileSync(join(ws, 'mod.py'), 'X = 2\n'); // modified vs HEAD in the workspace (an earlier patch of this run)
    writeFileSync(join(ws, 'new.txt'), 'untracked\n');
    const sb = fakeSandbox((cmd) => (cmd.startsWith('git status') ? { stdout: ' M mod.py\0?? new.txt\0 D gone.py\0' } : {}));
    const pool = await createLanes(ctxFor(sb, true), oracle({ runner: 'pytest', lanes: 4 }), { count: 1 });
    expect(pool.mode).toBe('worktree');
    const lane = pool.lanes[0];
    if (lane === undefined) throw new Error('no lane');
    expect(sb.calls.map((c) => [c.command, c.cwd])).toEqual([
      [`mkdir -p '${join(runDir, 'tmp', 'synth')}'`, ws],
      ['git status --porcelain -z --untracked-files=all', ws],
      // a stale registration (same runDir on --resume, or a crash before dispose) would make `add` refuse the path
      [`rm -rf '${lane.dir}' && git worktree prune`, ws],
      [`git worktree add --detach '${lane.dir}' HEAD`, ws],
    ]);
    // the dirty snapshot was replayed into the fresh worktree
    expect(readFileSync(join(lane.dir, 'mod.py'), 'utf8')).toBe('X = 2\n');
    expect(readFileSync(join(lane.dir, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(existsSync(join(lane.dir, 'gone.py'))).toBe(false);

    // a candidate that also edits mod.py: withLane resets in finally and replays the dirty files again
    const mod = sourceFile('mod.py', 'X = 2\n');
    const edit = applyCandidate(candidate(site(mod, 1), 'X = 3'));
    const before = sb.calls.length;
    await pool.withLane(async (l) => {
      await pool.applyToLane(l, edit);
      expect(readFileSync(join(l.dir, 'mod.py'), 'utf8')).toBe('X = 3\n');
    });
    expect(sb.calls.slice(before).map((c) => [c.command, c.cwd])).toEqual([['git checkout -- . && git clean -fdq', lane.dir]]);
    expect(readFileSync(join(lane.dir, 'mod.py'), 'utf8')).toBe('X = 2\n');
    expect(readFileSync(join(ws, 'mod.py'), 'utf8')).toBe('X = 2\n');

    await pool.disposeLanes();
    expect(sb.calls.at(-1)).toMatchObject({ command: `git worktree remove --force '${lane.dir}'`, cwd: ws });
  });
  it('a failing git command is a LaneError; a failed worktree remove falls back to rm -rf + prune', async () => {
    const sb = fakeSandbox((cmd) => (cmd.startsWith('git worktree add') ? { exitCode: 128, stderr: 'fatal: not a git repository' } : {}));
    await expect(createLanes(ctxFor(sb, true), oracle({ runner: 'pytest' }), { count: 1 })).rejects.toThrow(/LaneError: `git worktree add .*fatal: not a git repository/);

    const sb2 = fakeSandbox((cmd) => (cmd.startsWith('git worktree remove') ? { exitCode: 1, stderr: 'locked' } : {}));
    const pool = await createLanes(ctxFor(sb2, true), oracle({ runner: 'pytest' }), { count: 1 });
    await pool.disposeLanes();
    expect(sb2.calls.at(-1)?.command).toMatch(/^rm -rf '.*lane0' && git worktree prune$/);
  });
  it('over DIRTY_ENTRIES_MAX entries only the tracked modifications are replayed', async () => {
    writeFileSync(join(ws, 'mod.py'), 'X = 2\n');
    const many = Array.from({ length: DIRTY_ENTRIES_MAX + 1 }, (_, i) => `?? junk${i}.txt\0`).join('');
    const sb = fakeSandbox((cmd) => (cmd.startsWith('git status') ? { stdout: ` M mod.py\0${many}` } : {}));
    const pool = await createLanes(ctxFor(sb, true), oracle({ runner: 'pytest' }), { count: 1 });
    const lane = pool.lanes[0];
    if (lane === undefined) throw new Error('no lane');
    expect(readFileSync(join(lane.dir, 'mod.py'), 'utf8')).toBe('X = 2\n');
    expect(existsSync(join(lane.dir, 'junk0.txt'))).toBe(false);
  });
});

describe('copy and inplace lanes (non-git)', () => {
  it('copy: du -sk decides, cp -R of the workspace, touched files restored on reset (including files that did not exist)', async () => {
    const sb = fakeSandbox((cmd) => (cmd === 'du -sk .' ? { stdout: '1024\t.\n' } : {}));
    const pool = await createLanes(ctxFor(sb, false), oracle({ runner: 'other', lanes: 4 }), { count: 1 });
    expect(pool.mode).toBe('copy');
    const lane = pool.lanes[0];
    if (lane === undefined) throw new Error('no lane');
    // the copy purges the workspace's __pycache__ (a stale .pyc would run the wrong candidate; runner.ts LANE_RUN_ENV)
    expect(sb.calls.map((c) => c.command)).toEqual(['du -sk .', `mkdir -p '${join(runDir, 'tmp', 'synth')}'`, `mkdir -p '${lane.dir}'`, `cp -R '${ws}/.' '${lane.dir}' && find '${lane.dir}' -name __pycache__ -type d -prune -exec rm -rf {} +`]);
    // the fake cp copied nothing; seed one file so both "existed" and "did not exist" restores are exercised
    writeFileSync(join(lane.dir, 'gcd.py'), GCD_BUGGY);
    const other = sourceFile('pkg/util.py', 'A = 1\n');
    const twoFiles = applyCandidate(candidate(site(gcd, 5), 'return gcd(b, a % b)', [{ path: 'pkg/util.py', line: 1, kind: 'replace', text: 'A = 2' }]), new Map([[gcd.path, gcd], [other.path, other]]));
    await pool.withLane(async (l) => {
      await pool.applyToLane(l, twoFiles);
      expect(readFileSync(join(l.dir, 'gcd.py'), 'utf8')).toBe(FIXED_SRC);
      expect(readFileSync(join(l.dir, 'pkg/util.py'), 'utf8')).toBe('A = 2\n');
    });
    expect(readFileSync(join(lane.dir, 'gcd.py'), 'utf8')).toBe(GCD_BUGGY);
    expect(existsSync(join(lane.dir, 'pkg/util.py'))).toBe(false);
    await pool.disposeLanes();
    expect(sb.calls.at(-1)?.command).toBe(`rm -rf '${lane.dir}'`);
  });
  it('inplace: one lane on the workspace itself; the revert runs in finally even when the work throws', async () => {
    const sb = fakeSandbox((cmd) => (cmd === 'du -sk .' ? { stdout: `${200 * 1024}\t.\n` } : {}));
    const pool = await createLanes(ctxFor(sb, false), oracle({ runner: 'other', lanes: 4 }), { count: 4 });
    expect(pool.mode).toBe('inplace');
    expect(pool.lanes).toHaveLength(1);
    expect(pool.lanes[0]?.dir).toBe(ws);
    expect(sb.calls.map((c) => c.command)).toEqual(['du -sk .']); // no mkdir, no copy
    await expect(
      pool.withLane(async (l) => {
        await pool.applyToLane(l, FIX);
        expect(readFileSync(join(ws, 'gcd.py'), 'utf8')).toBe(FIXED_SRC);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(readFileSync(join(ws, 'gcd.py'), 'utf8')).toBe(GCD_BUGGY);
    expect(pool.lanes[0]?.busy).toBe(false);
    await pool.disposeLanes();
    expect(readFileSync(join(ws, 'gcd.py'), 'utf8')).toBe(GCD_BUGGY);
  });
  it('an unreadable du falls back to inplace (the safest mode); a known size skips du', async () => {
    const sb = fakeSandbox((cmd) => (cmd === 'du -sk .' ? { exitCode: 1, stderr: 'du: denied' } : {}));
    expect((await createLanes(ctxFor(sb, false), oracle({ runner: 'other' }))).mode).toBe('inplace');
    const sb2 = fakeSandbox();
    expect((await createLanes(ctxFor(sb2, false), oracle({ runner: 'other' }), { workspaceBytes: 1000, count: 1 })).mode).toBe('copy');
    expect(sb2.calls.some((c) => c.command === 'du -sk .')).toBe(false);
  });
});
