/**
 * TUI-DESIGN §12.6 / §19.0: the sandboxed `git diff --numstat -z HEAD -- <files>` runner behind `diffStatBlock`
 * over a temp repository — letters M/A/D/?/B, `--no-index` exit 1 as success (A151), the untracked numstat budget
 * (sizes past 20), the unborn empty-tree base, escaping / missing paths, a failing git (fake sandbox), and the
 * `/diff --full` text (colour, quotePath, the 1 MiB exclusion, untracked blocks).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeSandbox, execResult } from '../loop/fakes.js';
import {
  DEV_NULL,
  DIFF_FULL_UNTRACKED_MAX,
  DIFF_NO_INDEX_CONCURRENCY,
  DIFF_PATHSPEC_CHUNK_BYTES,
  DIFF_UNTRACKED_NUMSTAT_MAX,
  EMPTY_TREE_OID,
  LITERAL_PATHSPECS_ENV,
  SECRET_PATH_SKIP,
  chunkPathspecs,
  collectDiffStat,
  collectFullDiff,
  cutTruncatedDiff,
  diffStatBlockFromGit,
  diffStatRows,
  mapLimit,
  noIndexOk,
  truncatedNotice,
  truncatedTrailer,
} from '../../../src/undo/diff.js';
import { shellQuote } from '../../../src/workspace/git.js';
import { git, initRepo, recordingSandbox, tempRepo, write, type TempRepo } from './helpers.js';
import type { Sandbox } from '../../../src/core/types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let temps: TempRepo[] = [];
function repo(files: Record<string, string> = { 'src/a.py': 'a1\na2\na3\n', 'src/b.py': 'b1\n', 'gone.txt': 'g1\ng2\n' }): TempRepo {
  const t = tempRepo('jev-diff-');
  temps.push(t);
  initRepo(t.ws, files);
  return t;
}
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

describe('collectDiffStat (§12.6)', () => {
  it('one numstat spawn for the tracked files plus one --no-index spawn per untracked file; letters M / D / ? / A / B; exit 1 is success', async () => {
    const t = repo();
    const sb = recordingSandbox(t.sandbox);
    write(t.ws, 'src/a.py', 'a1\nchanged\na3\nadded\n'); // M +2 −1
    await rm(join(t.ws, 'gone.txt')); // D +0 −2
    write(t.ws, 'new.txt', 'n1\nn2\nn3\n'); // ? untracked, +3
    write(t.ws, 'staged.txt', 's1\n'); // A: added to the index
    git(t.ws, 'add', 'staged.txt');
    write(t.ws, 'blob.bin', Buffer.from([0, 1, 2, 3, 255])); // untracked binary
    const changed = ['src/a.py', 'gone.txt', 'new.txt', 'staged.txt', 'blob.bin', 'src/b.py'];
    const c = await collectDiffStat({ sandbox: sb, root: t.ws, runId: 'r1', changedFiles: changed, created: new Set(['staged.txt', 'new.txt']), dirtyAtStart: new Set(['src/a.py']) });
    expect(c.errors).toEqual([]);
    // derive-untracked (1) + numstat (1) + two --no-index
    expect(c.spawns).toBe(4);
    expect(sb.commands.filter((x) => x.includes('ls-files -z --others --exclude-standard'))).toHaveLength(1);
    const numstat = sb.commands.find((x) => x.includes('diff --no-ext-diff --no-textconv --numstat -z --ignore-submodules=dirty HEAD --'));
    expect(numstat).toBeDefined();
    expect(numstat).toContain('src/a.py');
    expect(numstat).toContain('gone.txt');
    expect(numstat).not.toContain('new.txt');
    const noIndex = sb.commands.filter((x) => x.includes(`--no-index --numstat -z -- ${DEV_NULL} `));
    expect(noIndex).toHaveLength(2);
    expect(c.input.deleted).toEqual(new Set(['gone.txt']));
    const { rows, summary } = diffStatRows(c.input);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('src/a.py')).toMatchObject({ letter: 'M', added: 2, deleted: 1, dirtyBefore: true });
    expect(byPath.get('gone.txt')).toMatchObject({ letter: 'D', added: 0, deleted: 2 });
    expect(byPath.get('staged.txt')).toMatchObject({ letter: 'A', added: 1, deleted: 0 });
    expect(byPath.get('new.txt')).toMatchObject({ letter: '?', added: 3, deleted: 0, bytes: null });
    expect(byPath.get('blob.bin')).toMatchObject({ letter: '?', binary: true });
    expect(byPath.has('src/b.py')).toBe(false); // unchanged: no row
    expect(summary).toEqual({ files: 5, added: 6, deleted: 3, untracked: 2, binary: 1, skipped: 0 });
    const block = await diffStatBlockFromGit({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: changed, untracked: ['new.txt', 'blob.bin'], created: new Set(['staged.txt']), dirtyAtStart: new Set(['src/a.py']) }, 80);
    expect(block.lines[0]).toBe('diff · run r1 · 5 files · +6 −3');
    expect(block.lines).toContain('2 untracked');
    expect(block.lines).toContain('1 binary');
    expect(block.lines.some((l) => l.startsWith(' M src/a.py†'))).toBe(true);
    expect(block.lines.some((l) => l.startsWith(' ? new.txt'))).toBe(true);
    expect(block.lines.at(-1)).toBe('† also modified before this run');
    // the caller's untracked list saves the ls-files spawn
    expect(block.spawns).toBe(3);
  });

  it('noIndexOk: exit 0 and 1 are success, anything else or a kill is not (A151)', () => {
    expect(noIndexOk(execResult({ exitCode: 0 }))).toBe(true);
    expect(noIndexOk(execResult({ exitCode: 1 }))).toBe(true);
    expect(noIndexOk(execResult({ exitCode: 128 }))).toBe(false);
    expect(noIndexOk(execResult({ exitCode: null, killedBy: 'timeout' }))).toBe(false);
    expect(noIndexOk(execResult({ exitCode: 1, killedBy: 'abort' }))).toBe(false);
  });

  it('untracked files past the numstat budget carry sizes; the budget is 20 by default', async () => {
    const t = repo();
    const names: string[] = [];
    for (let i = 0; i < 23; i++) {
      const n = `u/${String(i).padStart(2, '0')}.txt`;
      names.push(n);
      write(t.ws, n, `${'line\n'.repeat(i + 1)}`);
    }
    const c = await collectDiffStat({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: names, untracked: names, untrackedNumstatMax: 3 });
    expect(c.spawns).toBe(3);
    const rows = c.input.untracked ?? [];
    expect(rows.filter((r) => r.numstat !== undefined)).toHaveLength(3);
    expect(rows.filter((r) => typeof r.bytes === 'number')).toHaveLength(20);
    expect(rows.find((r) => r.path === 'u/22.txt')?.bytes).toBe(23 * 5);
    expect(DIFF_UNTRACKED_NUMSTAT_MAX).toBe(20);
    const wide = await collectDiffStat({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: names, untracked: names });
    expect(wide.spawns).toBe(20);
  });

  it('an unborn repository diffs against the empty tree; escaping and unreadable paths are skipped, missing tracked paths are D', async () => {
    const t = tempRepo('jev-diff-');
    temps.push(t);
    git(t.ws, 'init', '-q', '-b', 'main', '.');
    write(t.ws, 'first.txt', 'one\ntwo\n');
    git(t.ws, 'add', 'first.txt');
    const sb = recordingSandbox(t.sandbox);
    const c = await collectDiffStat({ sandbox: sb, root: t.ws, runId: 'r1', changedFiles: ['first.txt', '../outside.txt', '/etc/hosts', 'never-existed.txt'], untracked: [], unborn: true, created: new Set(['first.txt']) });
    expect(sb.commands[0]).toContain(`--ignore-submodules=dirty ${EMPTY_TREE_OID} -- first.txt never-existed.txt`);
    expect(c.errors).toEqual([]);
    const { rows, summary } = diffStatRows(c.input);
    expect(rows).toEqual([expect.objectContaining({ letter: 'A', path: 'first.txt', added: 2, deleted: 0 })]);
    expect(c.input.skipped).toEqual([
      { path: '../outside.txt', reason: 'outside the workspace' },
      { path: '/etc/hosts', reason: 'outside the workspace' },
    ]);
    expect(c.input.deleted).toEqual(new Set(['never-existed.txt']));
    expect(summary.skipped).toBe(2);
  });

  it('a failing git (exit 128) is recorded in errors, never thrown; the block still renders its header', async () => {
    const t = repo();
    write(t.ws, 'src/a.py', 'changed\n');
    write(t.ws, 'u.txt', 'u\n');
    const fake = createFakeSandbox((cmd) => (cmd.includes('--no-index') ? { exitCode: 1, stdout: `1\t0\t\0${DEV_NULL}\0u.txt\0` } : { exitCode: 128, stderr: 'fatal: bad revision HEAD\n' }));
    const r = await diffStatBlockFromGit({ sandbox: fake, root: t.ws, runId: 'r1', changedFiles: ['src/a.py', 'u.txt'], untracked: ['u.txt'] }, 80);
    expect(r.errors).toEqual(['diff: fatal: bad revision HEAD']);
    expect(r.lines[0]).toBe('diff · run r1 · 1 file · +1 −0');
    expect(r.lines).toContain('1 untracked');
    expect(r.lines[1]).toMatch(/^ \? u\.txt/);
    // a sandbox that rejects (abort) is recorded too
    const ac = new AbortController();
    ac.abort();
    const aborted = await collectDiffStat({ sandbox: createFakeSandbox(() => ({ rejectOnAbort: true })), root: t.ws, runId: 'r1', changedFiles: ['src/a.py'], untracked: [], signal: ac.signal });
    expect(aborted.errors).toHaveLength(1);
    expect(aborted.errors[0]).toMatch(/^diff: /);
    expect(aborted.input.numstat).toBe('');
  });
});

describe('collectFullDiff (§12.6 `/diff --full`)', () => {
  it('unified text for tracked files plus a --no-index block per untracked file; --color=always only when asked; quotePath off; files over the size cap skipped', async () => {
    const t = repo();
    const sb = recordingSandbox(t.sandbox);
    write(t.ws, 'src/a.py', 'a1\nchanged\na3\n');
    write(t.ws, 'nëw.txt', 'n1\n');
    write(t.ws, 'huge.txt', 'x'.repeat(2000));
    const changed = ['src/a.py', 'nëw.txt', 'huge.txt', 'gone.txt'];
    await rm(join(t.ws, 'gone.txt'));
    const plain = await collectFullDiff({ sandbox: sb, root: t.ws, runId: 'r1', changedFiles: changed, untracked: ['nëw.txt'], color: false, maxFileBytes: 1000 });
    expect(plain.errors).toEqual([]);
    expect(plain.spawns).toBe(2);
    expect(plain.skipped).toEqual([{ path: 'huge.txt', reason: '> 1000 B' }]);
    expect(plain.truncated).toBe(false);
    expect(plain.text).toContain('--- a/src/a.py');
    expect(plain.text).toContain('+changed');
    expect(plain.text).toContain('deleted file mode');
    expect(plain.text).toContain('+++ b/nëw.txt'); // quotePath=false keeps the UTF-8 name unescaped
    expect(plain.text).not.toContain('\\303\\253');
    expect(plain.text).not.toContain('\x1b[');
    expect(sb.commands[0]).toContain('diff --no-ext-diff --no-textconv --no-color --submodule=short --ignore-submodules=dirty HEAD -- src/a.py gone.txt');
    expect(sb.commands[1]).toContain(`diff --no-ext-diff --no-textconv --no-index --no-color -- ${DEV_NULL} `);
    const colour = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['src/a.py'], untracked: [], color: true });
    expect(colour.text).toContain('\x1b[');
    expect(DIFF_FULL_UNTRACKED_MAX).toBe(200);
  });

  it('an output cap marks the text truncated and appends a trailer; a failing git is an error, not a throw', async () => {
    const t = repo();
    write(t.ws, 'src/a.py', `${'changed line\n'.repeat(400)}`);
    const capped = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['src/a.py'], untracked: [], color: false, maxOutputBytes: 512 });
    expect(capped.truncated).toBe(true);
    expect(capped.text.trimEnd().endsWith('… output truncated at 512 B')).toBe(true);
    const fake = createFakeSandbox(() => ({ exitCode: 129, stderr: 'usage: git diff\n' }));
    const failed = await collectFullDiff({ sandbox: fake, root: t.ws, runId: 'r1', changedFiles: ['src/a.py'], untracked: [], color: false });
    expect(failed.text).toBe('');
    expect(failed.errors).toEqual(['diff: usage: git diff']);
  });
});

describe('literal pathspecs (§12.4 / §12.6, C40)', () => {
  it('`pages/[id].tsx` is a file name, not a glob: the numstat, the --full text and the derived untracked list never carry `pages/i.tsx`', async () => {
    const t = repo({ 'pages/[id].tsx': 'orig-id\n', 'pages/i.tsx': 'orig-i\n' });
    write(t.ws, 'pages/[id].tsx', 'changed by a command\n');
    write(t.ws, 'pages/i.tsx', 'PRECIOUS USER EDIT\n'); // dirty too, but not part of the run
    const c = await collectDiffStat({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['pages/[id].tsx'], untracked: [] });
    expect(c.errors).toEqual([]);
    const { rows } = diffStatRows(c.input);
    expect(rows.map((r) => r.path)).toEqual(['pages/[id].tsx']);
    const full = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['pages/[id].tsx'], untracked: [], color: false });
    expect(full.text).toContain('+++ b/pages/[id].tsx');
    expect(full.text).not.toContain('i.tsx');
    // untracked derivation through ls-files: `pages/[x].tsx` must not also list `pages/x.tsx`
    write(t.ws, 'pages/[x].tsx', 'new\n');
    write(t.ws, 'pages/x.tsx', 'new too\n');
    const derived = await collectDiffStat({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['pages/[x].tsx'] });
    expect(derived.input.untracked?.map((u) => u.path)).toEqual(['pages/[x].tsx']);
    expect(LITERAL_PATHSPECS_ENV).toEqual({ GIT_LITERAL_PATHSPECS: '1' });
  });
});

describe('pathspec batching (§12.6; arg-length limits)', () => {
  it('chunkPathspecs: batches bounded by the summed quoted length, order kept, an oversized single path in its own batch', () => {
    expect(chunkPathspecs([])).toEqual([]);
    expect(chunkPathspecs(['a', 'b'])).toEqual([['a', 'b']]);
    // 'aaaa' costs 5 with the separator: two per 10-byte batch
    expect(chunkPathspecs(['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'], 10)).toEqual([['aaaa', 'bbbb'], ['cccc', 'dddd'], ['eeee']]);
    // a quoted name counts its quotes
    expect(shellQuote('a b').length).toBe(5);
    expect(chunkPathspecs(['a b', 'c'], 6)).toEqual([['a b'], ['c']]);
    expect(chunkPathspecs(['x'.repeat(100), 'y'], 10)).toEqual([['x'.repeat(100)], ['y']]);
    expect(chunkPathspecs(['a', 'b'], Number.NaN)).toEqual([['a', 'b']]);
    expect(DIFF_PATHSPEC_CHUNK_BYTES).toBe(64 * 1024);
  });

  it('3,000 long names: several numstat spawns, each command under the 64 KiB pathspec bound, one row per file', async () => {
    const t = tempRepo('jev-diff-');
    temps.push(t);
    const names: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const n = `pkg-${i % 7}/module-${i}/${'component'.repeat(3)}-${i}.ts`;
      names.push(n);
      mkdirSync(dirname(join(t.ws, n)), { recursive: true });
      writeFileSync(join(t.ws, n), `${i}\n`);
    }
    // the fake answers `1 0 <path>` for every pathspec after ` -- `
    const fake = createFakeSandbox((cmd) => {
      const after = cmd.split(' -- ')[1] ?? '';
      const paths = after.split(' ').filter((p) => p.length > 0);
      return { exitCode: 0, stdout: paths.map((p) => `1\t0\t${p}\0`).join('') };
    });
    const c = await collectDiffStat({ sandbox: fake, root: t.ws, runId: 'r1', changedFiles: names, untracked: [] });
    expect(c.errors).toEqual([]);
    expect(c.spawns).toBeGreaterThanOrEqual(2);
    for (const cmd of fake.commands) {
      const after = cmd.split(' -- ')[1] ?? '';
      expect(Buffer.byteLength(after)).toBeLessThanOrEqual(DIFF_PATHSPEC_CHUNK_BYTES);
    }
    const { rows, summary } = diffStatRows(c.input);
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map((r) => r.path)).size).toBe(3000);
    expect(summary).toMatchObject({ files: 3000, added: 3000, deleted: 0 });
  });

  it('real git: a small chunk bound splits the numstat, the ls-files and the --full spawns; the concatenated outputs are complete', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`dir/file-${String(i).padStart(2, '0')}.txt`] = `line ${i}\n`;
    const t = repo(files);
    const sb = recordingSandbox(t.sandbox);
    const changed = Object.keys(files);
    for (const f of changed) write(t.ws, f, `changed ${f}\nsecond\n`);
    for (let i = 0; i < 4; i++) write(t.ws, `dir/new-${i}.txt`, 'n\n');
    const all = [...changed, ...Array.from({ length: 4 }, (_, i) => `dir/new-${i}.txt`)];
    const c = await collectDiffStat({ sandbox: sb, root: t.ws, runId: 'r1', changedFiles: all, pathspecChunkBytes: 80 });
    expect(c.errors).toEqual([]);
    const numstats = sb.commands.filter((x) => x.includes('--numstat -z --ignore-submodules=dirty HEAD --'));
    const lsFiles = sb.commands.filter((x) => x.includes('ls-files -z --others'));
    expect(numstats.length).toBeGreaterThanOrEqual(3);
    expect(lsFiles.length).toBeGreaterThanOrEqual(3);
    const { rows, summary } = diffStatRows(c.input);
    expect(rows.filter((r) => r.letter === 'M')).toHaveLength(12);
    expect(rows.filter((r) => r.letter === '?')).toHaveLength(4);
    expect(summary).toMatchObject({ files: 16, added: 12 * 2 + 4, deleted: 12 });
    const sb2 = recordingSandbox(t.sandbox);
    const full = await collectFullDiff({ sandbox: sb2, root: t.ws, runId: 'r1', changedFiles: changed, untracked: [], color: false, pathspecChunkBytes: 80 });
    expect(full.errors).toEqual([]);
    expect(full.spawns).toBeGreaterThanOrEqual(3);
    expect(full.text.match(/^diff --git /gm)).toHaveLength(12);
    for (const f of changed) expect(full.text).toContain(`+++ b/${f}`);
  });
});

describe('bounded concurrency for the untracked --no-index spawns (§12.6, live-run friendliness)', () => {
  it('mapLimit keeps order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, n * 3));
      inFlight -= 1;
      return n * 10;
    });
    expect(r).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async (x: number) => x)).toEqual([]);
    expect(await mapLimit([1, 2], Number.NaN, async (x) => x + 1)).toEqual([2, 3]);
  });

  it('the --no-index numstats run at most DIFF_NO_INDEX_CONCURRENCY at a time', async () => {
    const t = repo();
    const names = Array.from({ length: 10 }, (_, i) => `u/${i}.txt`);
    for (const n of names) write(t.ws, n, 'u\n');
    let inFlight = 0;
    let peak = 0;
    const slow = createFakeSandbox(() => ({ delayMs: 15, result: { exitCode: 1, stdout: `1\t0\t\0${DEV_NULL}\0u/x.txt\0` } }));
    const counting: Sandbox = {
      level: 'none',
      async run(cmd, o) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await slow.run(cmd, o);
        } finally {
          inFlight -= 1;
        }
      },
      killAll: () => slow.killAll(),
    };
    const c = await collectDiffStat({ sandbox: counting, root: t.ws, runId: 'r1', changedFiles: names, untracked: names });
    expect(c.spawns).toBe(10);
    expect(peak).toBe(DIFF_NO_INDEX_CONCURRENCY);
    expect(DIFF_NO_INDEX_CONCURRENCY).toBe(2);
  });
});

describe('capped --full output (§12.6): never a torn hunk with the sandbox marker in it', () => {
  it('cutTruncatedDiff: head only, cut back to the last file-diff boundary (colour-aware) or the last complete line', () => {
    const marker = '\n…[output truncated: 1234 bytes omitted]…\n';
    expect(cutTruncatedDiff('diff --git a/x b/x\n+a\n')).toBe('diff --git a/x b/x\n+a\n');
    const two = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n+b';
    expect(cutTruncatedDiff(`${two}${marker}+tail\n`)).toBe('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\n');
    const one = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n+a\n+b\n+partial';
    expect(cutTruncatedDiff(`${one}${marker}rest\n`)).toBe('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n+a\n+b\n');
    expect(cutTruncatedDiff(`no newline at all${marker}tail`)).toBe('');
    const coloured = '\x1b[1mdiff --git a/x b/x\x1b[m\n+a\n\x1b[1mdiff --git a/y b/y\x1b[m\n+torn';
    expect(cutTruncatedDiff(`${coloured}${marker}t`)).toBe('\x1b[1mdiff --git a/x b/x\x1b[m\n+a\n');
  });

  it('a real sandbox run past maxOutputBytes: the patch has no marker, ends with the trailer, keeps only complete file diffs, and the notice names the cut', async () => {
    const t = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) write(t.ws, f, `${`changed line in ${f}\n`.repeat(150)}`);
    const capped = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['a.txt', 'b.txt', 'c.txt'], untracked: [], color: false, maxOutputBytes: 5000 });
    expect(capped.truncated).toBe(true);
    expect(capped.text).not.toContain('…[output truncated:');
    expect(capped.text.trimEnd().endsWith(truncatedTrailer(5000))).toBe(true);
    expect(capped.notice).toBe(truncatedNotice(5000));
    expect(capped.notice).toBe('… output truncated at 4.9 KiB — the patch ends at the last complete file diff');
    const body = capped.text.slice(0, capped.text.lastIndexOf(truncatedTrailer(5000)));
    // one complete file diff survived (≈ 3.5 KB each): its 150 added lines are all there, the torn second diff is gone
    expect(body.match(/^diff --git /gm)).toHaveLength(1);
    expect(body.match(/^\+changed line in a\.txt$/gm)).toHaveLength(150);
    expect(body).not.toContain('b.txt');
    expect(body.endsWith('\n')).toBe(true);
    // an untruncated run has no notice
    const whole = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['a.txt'], untracked: [], color: false });
    expect(whole.notice).toBeNull();
    expect(whole.truncated).toBe(false);
  });
});

describe('secret paths in /diff --full (§10, §12.6)', () => {
  const CANARY = 'sk-ant-CANARY0123456789abcdefghijklmnop';
  const TOKEN = 'ghp_TOKENabcdefghijklmnopqrstuvwxyz0123';

  it('a changed .env, a deleted .env, an untracked key file and a configured secret store are listed as `secret path`, never diffed; the text passes redact', async () => {
    const t = repo({ '.env': 'KEY=old\n', 'del/.env': 'GONE=1\n', 'config/creds/x.json': '{}\n', 'src/a.py': 'x = 1\n' });
    write(t.ws, '.env', `KEY=${CANARY}\n`);
    await rm(join(t.ws, 'del/.env'));
    write(t.ws, 'config/creds/x.json', `{"k":"${CANARY}"}\n`);
    write(t.ws, 'server.pem', `-----BEGIN ${CANARY}-----\n`);
    write(t.ws, 'src/a.py', `x = "${TOKEN}"\n`);
    const changed = ['.env', 'del/.env', 'config/creds/x.json', 'server.pem', 'src/a.py'];
    const r = await collectFullDiff({
      sandbox: t.sandbox,
      root: t.ws,
      runId: 'r1',
      changedFiles: changed,
      color: false,
      secretPaths: [join(t.ws, 'config/creds')],
      redact: (s) => s.split(TOKEN).join('[REDACTED:test]'),
    });
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { path: '.env', reason: SECRET_PATH_SKIP },
        { path: 'del/.env', reason: SECRET_PATH_SKIP },
        { path: 'config/creds/x.json', reason: SECRET_PATH_SKIP },
        { path: 'server.pem', reason: SECRET_PATH_SKIP },
      ]),
    );
    expect(r.skipped).toHaveLength(4);
    expect(r.text).not.toContain(CANARY);
    expect(r.text).not.toContain('.env');
    expect(r.text).not.toContain('server.pem');
    expect(r.text).toContain('+++ b/src/a.py');
    expect(r.text).toContain('[REDACTED:test]');
    expect(r.text).not.toContain(TOKEN);
    expect(SECRET_PATH_SKIP).toBe('secret path');
    // an injected denylist replaces the default rule
    const custom = await collectFullDiff({ sandbox: t.sandbox, root: t.ws, runId: 'r1', changedFiles: ['src/a.py', '.env'], untracked: [], color: false, isDenied: (rel) => rel === 'src/a.py' });
    expect(custom.skipped).toEqual([{ path: 'src/a.py', reason: SECRET_PATH_SKIP }]);
    expect(custom.text).toContain(CANARY); // the caller took the responsibility
  });
});
