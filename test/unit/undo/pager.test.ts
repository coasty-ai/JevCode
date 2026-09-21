/**
 * TUI-DESIGN §12.6 / §19.0: pager selection (`GIT_PAGER=cat`, `LESS` untouched when set), `pagerArgv`, and
 * `openFullDiff`: the patch file under `<run>/tmp/diff-<seq>.patch` (0600), the pager under `suspendTerminal` with
 * the injected spawn and env, the inline block for `cat` / no TTY capped at 400 lines with colour stripped, and
 * spawn failures reported rather than thrown.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIFF_INLINE_MAX_LINES } from '../../../src/undo/diff.js';
import {
  DEFAULT_PAGER,
  DIFF_PATCH_KEEP,
  INLINE_DIFF_MAX_LINES,
  SH_NOT_EXECUTABLE,
  SH_NOT_FOUND,
  defaultPagerSpawn,
  diffPatchPath,
  inlineDiffLines,
  openFullDiff,
  pagerArgv,
  pagerUnavailable,
  pagerUnavailableNotice,
  prunePatchFiles,
  selectPager,
  suspendFailedNotice,
  type PagerSpawn,
} from '../../../src/undo/pager.js';

describe('selectPager (§12.6)', () => {
  it('$GIT_PAGER → $PAGER → less; core.pager is never consulted', () => {
    expect(selectPager({}, true)).toEqual({ command: 'less', env: { LESS: 'FRX', LESSCHARSET: 'utf-8' }, inline: false, source: 'default' });
    expect(selectPager({ PAGER: 'more' }, true)).toMatchObject({ command: 'more', source: 'PAGER', inline: false });
    expect(selectPager({ PAGER: 'more', GIT_PAGER: 'delta --dark' }, true)).toMatchObject({ command: 'delta --dark', source: 'GIT_PAGER', inline: false });
    // empty / blank values fall through
    expect(selectPager({ GIT_PAGER: '   ', PAGER: '' }, true)).toMatchObject({ command: DEFAULT_PAGER, source: 'default' });
  });

  it('GIT_PAGER=cat (or any cat) and a non-TTY stdout mean the inline block', () => {
    expect(selectPager({ GIT_PAGER: 'cat' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: '/bin/cat' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: 'cat -v' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: 'concat' }, true).inline).toBe(false);
    expect(selectPager({}, false)).toMatchObject({ command: 'less', inline: true });
    expect(INLINE_DIFF_MAX_LINES).toBe(400);
  });

  it('LESS=FRX only when unset; LESSCHARSET=utf-8 only when unset', () => {
    expect(selectPager({ LESS: '-R' }, true).env).toEqual({ LESSCHARSET: 'utf-8' });
    expect(selectPager({ LESS: '' }, true).env).toEqual({ LESSCHARSET: 'utf-8' }); // set-but-empty is the user's choice
    expect(selectPager({ LESSCHARSET: 'latin1' }, true).env).toEqual({ LESS: 'FRX' });
    expect(selectPager({ LESS: 'X', LESSCHARSET: 'utf-8' }, true).env).toEqual({});
  });

  it('pagerArgv runs the command through /bin/sh -c with the file as $0 (never split)', () => {
    expect(pagerArgv(selectPager({ GIT_PAGER: 'delta --dark' }, true), '/tmp/run/tmp/diff-1.patch')).toEqual(['/bin/sh', '-c', 'delta --dark "$0"', '/tmp/run/tmp/diff-1.patch']);
    expect(pagerArgv(selectPager({}, true), '/a b/c.patch')[3]).toBe('/a b/c.patch');
  });
});

describe('inlineDiffLines and diffPatchPath (§12.6)', () => {
  it('strips SGR colour, drops the trailing empty line, caps at 400 with a trailer naming the file', () => {
    expect(inlineDiffLines('', '/r/tmp/diff-1.patch')).toEqual({ lines: [], truncated: false, total: 0 });
    expect(inlineDiffLines('\x1b[1mdiff --git a/x b/x\x1b[m\n\x1b[32m+a\x1b[m\n', null)).toEqual({ lines: ['diff --git a/x b/x', '+a'], truncated: false, total: 2 });
    const big = Array.from({ length: 450 }, (_, i) => `+${i}`).join('\n') + '\n';
    const r = inlineDiffLines(big, '/r/tmp/diff-3.patch');
    expect(r.total).toBe(450);
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(DIFF_INLINE_MAX_LINES + 1);
    expect(r.lines.at(-1)).toBe('… 50 more lines (full diff in /r/tmp/diff-3.patch)');
    expect(inlineDiffLines('a\nb\nc\n', null, 2).lines).toEqual(['a', 'b', '… 1 more lines']);
    expect(inlineDiffLines('a\nb', null, Number.NaN).lines).toEqual(['a', 'b']);
  });

  it('diffPatchPath is <run>/tmp/diff-<seq>.patch; a bad seq reads as 0', () => {
    expect(diffPatchPath('/r', 7)).toBe(join('/r', 'tmp', 'diff-7.patch'));
    expect(diffPatchPath('/r', -1)).toBe(join('/r', 'tmp', 'diff-0.patch'));
    expect(diffPatchPath('/r', 1.5)).toBe(join('/r', 'tmp', 'diff-0.patch'));
  });
});

describe('openFullDiff (§12.6)', () => {
  let dirs: string[] = [];
  const runDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'jev-pager-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });
  const isWin = process.platform === 'win32';

  it('writes the patch file (0600) under <run>/tmp and opens the pager inside suspendTerminal with the selected argv and env', async () => {
    const dir = await runDir();
    const calls: string[] = [];
    const spawned: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const spawn: PagerSpawn = (argv, env) => {
      calls.push('spawn');
      spawned.push({ argv, env });
      return Promise.resolve({ exitCode: 0, error: null });
    };
    const text = 'diff --git a/x b/x\n+a\n';
    const r = await openFullDiff({
      suspendTerminal: async (run) => {
        calls.push('suspend');
        await run();
        calls.push('resume');
      },
      env: { GIT_PAGER: 'delta --dark', PATH: '/usr/bin', LESSCHARSET: 'latin1', SECRET_KEY: 'sk-ant-x' },
      isTTY: true,
      text,
      runDir: dir,
      seq: 4,
      spawn,
    });
    const file = join(dir, 'tmp', 'diff-4.patch');
    expect(r).toEqual({ mode: 'pager', file, command: 'delta --dark', source: 'GIT_PAGER', exitCode: 0, error: null });
    expect(calls).toEqual(['suspend', 'spawn', 'resume']);
    expect(await readFile(file, 'utf8')).toBe(text);
    if (!isWin) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(spawned[0]?.argv).toEqual(['/bin/sh', '-c', 'delta --dark "$0"', file]);
    // the child inherits the process env plus LESS=FRX (unset before) but keeps the user's LESSCHARSET
    expect(spawned[0]?.env).toEqual({ GIT_PAGER: 'delta --dark', PATH: '/usr/bin', LESSCHARSET: 'latin1', SECRET_KEY: 'sk-ant-x', LESS: 'FRX' });
  });

  it('cat or a non-TTY stdout returns the inline block (capped, colour stripped) without suspending or spawning; the file is still written', async () => {
    const dir = await runDir();
    let suspended = 0;
    let spawnedN = 0;
    const spawn: PagerSpawn = () => (spawnedN++, Promise.resolve({ exitCode: 0, error: null }));
    const text = Array.from({ length: 402 }, (_, i) => `\x1b[32m+${i}\x1b[m`).join('\n') + '\n';
    const r = await openFullDiff({ suspendTerminal: async (run) => (suspended++, run()), env: { GIT_PAGER: 'cat' }, isTTY: true, text, runDir: dir, seq: 1, spawn });
    expect(suspended).toBe(0);
    expect(spawnedN).toBe(0);
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.total).toBe(402);
      expect(r.truncated).toBe(true);
      expect(r.lines).toHaveLength(401);
      expect(r.lines[0]).toBe('+0');
      expect(r.lines.at(-1)).toBe(`… 2 more lines (full diff in ${join(dir, 'tmp', 'diff-1.patch')})`);
      expect(r.lines.join('\n')).not.toContain('\x1b');
    }
    expect(await readFile(join(dir, 'tmp', 'diff-1.patch'), 'utf8')).toBe(text);
    const piped = await openFullDiff({ suspendTerminal: async (run) => (suspended++, run()), env: {}, isTTY: false, text: 'x\n', runDir: dir, seq: 2, spawn, maxInlineLines: 10 });
    expect(piped).toMatchObject({ mode: 'inline', lines: ['x'], truncated: false, total: 1 });
    expect(suspended).toBe(0);
  });

  it('a pager that exits non-zero or is killed by a signal is reported as a pager outcome; a spawn error or a throwing spawn fall back to the inline block with a notice; an explicit patchFile wins', async () => {
    const dir = await runDir();
    const base = { suspendTerminal: (run: () => Promise<void>) => run(), env: {}, isTTY: true, text: 'x\n', runDir: dir, seq: 9 };
    const nonZero = await openFullDiff({ ...base, spawn: () => Promise.resolve({ exitCode: 2, error: null }) });
    expect(nonZero).toEqual({ mode: 'pager', file: join(dir, 'tmp', 'diff-9.patch'), command: 'less', source: 'default', exitCode: 2, error: null });
    const killed = await openFullDiff({ ...base, spawn: () => Promise.resolve({ exitCode: null, signal: 'SIGTERM', error: 'killed by SIGTERM' }) });
    expect(killed).toMatchObject({ mode: 'pager', exitCode: null, error: 'killed by SIGTERM' });
    const errored = await openFullDiff({ ...base, spawn: () => Promise.resolve({ exitCode: null, error: 'spawn less ENOENT' }) });
    expect(errored).toMatchObject({ mode: 'inline', lines: [pagerUnavailableNotice('less', 'spawn less ENOENT'), 'x'], truncated: false, total: 1, fallback: { command: 'less', source: 'default', exitCode: null, error: 'spawn less ENOENT' } });
    const throwing = await openFullDiff({ ...base, spawn: () => Promise.reject(new Error('boom')) });
    expect(throwing).toMatchObject({ mode: 'inline', lines: ['pager "less" unavailable (boom); showing the diff inline', 'x'], fallback: { exitCode: null, error: 'boom' } });
    const explicit = join(dir, 'elsewhere', 'my.patch');
    const r = await openFullDiff({ ...base, patchFile: explicit, spawn: (argv) => Promise.resolve({ exitCode: argv[3] === explicit ? 0 : 1, error: null }) });
    expect(r).toMatchObject({ mode: 'pager', file: explicit, exitCode: 0 });
    expect(await readFile(explicit, 'utf8')).toBe('x\n');
  });

  it('a suspendTerminal that throws (Ink not mounted, App gone) resolves with the inline block and a notice — never a rejection', async () => {
    const dir = await runDir();
    let spawned = 0;
    const r = await openFullDiff({
      suspendTerminal: () => Promise.reject(new Error('ink not mounted')),
      env: { PAGER: 'more' },
      isTTY: true,
      text: 'diff --git a/x b/x\n+a\n',
      runDir: dir,
      seq: 2,
      spawn: () => (spawned++, Promise.resolve({ exitCode: 0, error: null })),
    });
    expect(spawned).toBe(0);
    expect(r).toEqual({
      mode: 'inline',
      file: join(dir, 'tmp', 'diff-2.patch'),
      lines: [suspendFailedNotice('ink not mounted'), 'diff --git a/x b/x', '+a'],
      truncated: false,
      total: 2,
      fallback: { command: 'more', source: 'PAGER', exitCode: null, error: 'ink not mounted' },
    });
    expect(r.mode === 'inline' ? r.lines[0] : null).toBe('could not suspend the terminal (ink not mounted); showing the diff inline');
    // a synchronously throwing suspend as well
    const sync = await openFullDiff({
      suspendTerminal: () => {
        throw new Error('sync');
      },
      env: {},
      isTTY: true,
      text: 'x\n',
      runDir: dir,
      seq: 3,
    });
    expect(sync.mode).toBe('inline');
    expect(await readFile(join(dir, 'tmp', 'diff-3.patch'), 'utf8')).toBe('x\n');
  });

  it('pagerUnavailable: 126 / 127 and a spawn-level failure are unavailable; a normal exit or a signal-killed pager is not', () => {
    expect(pagerUnavailable({ exitCode: SH_NOT_FOUND, error: null })).toBe(true);
    expect(pagerUnavailable({ exitCode: SH_NOT_EXECUTABLE, error: null })).toBe(true);
    expect(pagerUnavailable({ exitCode: null, error: 'spawn ENOENT' })).toBe(true);
    expect(pagerUnavailable({ exitCode: null, signal: null, error: 'x' })).toBe(true);
    expect(pagerUnavailable({ exitCode: 0, error: null })).toBe(false);
    expect(pagerUnavailable({ exitCode: 2, error: null })).toBe(false);
    expect(pagerUnavailable({ exitCode: null, signal: 'SIGINT', error: 'killed by SIGINT' })).toBe(false);
    expect([SH_NOT_EXECUTABLE, SH_NOT_FOUND]).toEqual([126, 127]);
  });

  it.skipIf(isWin)('the real defaultPagerSpawn: PAGER=true exits 0 through the pager path; a missing pager (127) falls back inline with the notice; a signal-killed child reports `killed by <signal>`', async () => {
    const dir = await runDir();
    const base = { suspendTerminal: (run: () => Promise<void>) => run(), isTTY: true, text: 'diff --git a/x b/x\n+a\n', runDir: dir };
    const ok = await openFullDiff({ ...base, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PAGER: 'true' }, seq: 1 });
    expect(ok).toEqual({ mode: 'pager', file: join(dir, 'tmp', 'diff-1.patch'), command: 'true', source: 'PAGER', exitCode: 0, error: null });
    // `2>/dev/null` keeps sh's "command not found" line out of the test output; sh still exits 127
    const missing = 'definitely-not-a-pager-xyz 2>/dev/null';
    const gone = await openFullDiff({ ...base, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_PAGER: missing }, seq: 2 });
    expect(gone).toEqual({
      mode: 'inline',
      file: join(dir, 'tmp', 'diff-2.patch'),
      lines: [pagerUnavailableNotice(missing, 'exit 127'), 'diff --git a/x b/x', '+a'],
      truncated: false,
      total: 2,
      fallback: { command: missing, source: 'GIT_PAGER', exitCode: 127, error: null },
    });
    expect(gone.mode === 'inline' ? gone.lines[0] : null).toBe(`pager "${missing}" unavailable (exit 127); showing the diff inline`);
    const killed = await defaultPagerSpawn(['/bin/sh', '-c', 'kill -TERM $$'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    expect(killed).toEqual({ exitCode: null, signal: 'SIGTERM', error: 'killed by SIGTERM' });
    expect(await defaultPagerSpawn([], {})).toEqual({ exitCode: null, signal: null, error: 'empty argv' });
    const noExec = await defaultPagerSpawn(['/definitely/not/here'], {});
    expect(noExec.exitCode).toBeNull();
    expect(noExec.error).toMatch(/ENOENT/);
  });

  it('the caller\'s notice (a truncated patch) is the inline block\'s first line, after a pager-fallback notice when both apply', async () => {
    const dir = await runDir();
    const plain = await openFullDiff({ suspendTerminal: (run) => run(), env: {}, isTTY: false, text: 'a\nb\n', runDir: dir, seq: 1, notice: '… output truncated at 16 MiB — the patch ends at the last complete file diff' });
    expect(plain).toMatchObject({ mode: 'inline', lines: ['… output truncated at 16 MiB — the patch ends at the last complete file diff', 'a', 'b'], total: 2, fallback: null });
    const both = await openFullDiff({ suspendTerminal: (run) => run(), env: {}, isTTY: true, text: 'a\n', runDir: dir, seq: 2, notice: 'cut', spawn: () => Promise.resolve({ exitCode: 127, error: null }) });
    expect(both).toMatchObject({ mode: 'inline', lines: [pagerUnavailableNotice('less', 'exit 127'), 'cut', 'a'] });
    // an empty or null notice adds nothing; the 400-line cap applies to the diff body only
    const none = await openFullDiff({ suspendTerminal: (run) => run(), env: {}, isTTY: false, text: 'a\n', runDir: dir, seq: 3, notice: null });
    expect(none).toMatchObject({ mode: 'inline', lines: ['a'] });
    const big = Array.from({ length: 5 }, (_, i) => `+${i}`).join('\n') + '\n';
    const capped = await openFullDiff({ suspendTerminal: (run) => run(), env: {}, isTTY: false, text: big, runDir: dir, seq: 4, notice: 'n', maxInlineLines: 2 });
    expect(capped).toMatchObject({ mode: 'inline', lines: ['n', '+0', '+1', `… 3 more lines (full diff in ${join(dir, 'tmp', 'diff-4.patch')})`], truncated: true, total: 5 });
  });

  it('keeps only the newest DIFF_PATCH_KEEP diff-<seq>.patch files under <run>/tmp; foreign names and the file just written are never removed', async () => {
    const dir = await runDir();
    const spawn: PagerSpawn = () => Promise.resolve({ exitCode: 0, error: null });
    for (let seq = 1; seq <= 7; seq++) await openFullDiff({ suspendTerminal: (run) => run(), env: { GIT_PAGER: 'cat' }, isTTY: true, text: `${seq}\n`, runDir: dir, seq, spawn });
    expect((await readdir(join(dir, 'tmp'))).sort()).toEqual(['diff-5.patch', 'diff-6.patch', 'diff-7.patch']);
    expect(DIFF_PATCH_KEEP).toBe(3);
    // a lower seq written later (a resumed session restarting its counter) is pruned as the oldest; keepPatches overrides the cap
    await writeFile(join(dir, 'tmp', 'notes.txt'), 'keep me');
    await openFullDiff({ suspendTerminal: (run) => run(), env: { GIT_PAGER: 'cat' }, isTTY: true, text: 'x\n', runDir: dir, seq: 8, spawn, keepPatches: 1 });
    expect((await readdir(join(dir, 'tmp'))).sort()).toEqual(['diff-8.patch', 'notes.txt']);
    // prunePatchFiles alone: protect wins even when it is the oldest; a missing directory is not an error
    await writeFile(join(dir, 'tmp', 'diff-1.patch'), 'old');
    await writeFile(join(dir, 'tmp', 'diff-2.patch'), 'old');
    const removed = await prunePatchFiles(join(dir, 'tmp'), 1, join(dir, 'tmp', 'diff-1.patch'));
    expect(removed).toEqual([join(dir, 'tmp', 'diff-2.patch')]);
    expect((await readdir(join(dir, 'tmp'))).sort()).toEqual(['diff-1.patch', 'diff-8.patch', 'notes.txt']);
    expect(await prunePatchFiles(join(dir, 'nowhere'))).toEqual([]);
    expect(await prunePatchFiles(join(dir, 'tmp'), Number.NaN)).toEqual([]);
  });
});
