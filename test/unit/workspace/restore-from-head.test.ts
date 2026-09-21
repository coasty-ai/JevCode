/**
 * TUI-DESIGN §19.0 (`restore` row) / §12.4 (C40): `restoreFromHead` restores the working-tree copy only, through
 * `runGit` with the neutralising flags, and never runs `checkout --`, `--staged`, `stash`, `reset` or `clean`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Sandbox } from '../../../src/core/types.js';
import { GIT_BASE_FLAGS, LITERAL_PATHSPECS_FLAG, RESTORE_ARGS, lsFilesTracked, restoreFromHead } from '../../../src/workspace/git.js';
import { git, initRepo, tempWs, write } from './helpers.js';
import type { TempWs } from './helpers.js';

let temps: TempWs[] = [];
function ws(): TempWs {
  const t = tempWs();
  temps.push(t);
  return t;
}
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

function spy(inner: Sandbox): { sandbox: Sandbox; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    sandbox: {
      level: inner.level,
      run: (cmd, o) => {
        commands.push(cmd);
        return inner.run(cmd, o);
      },
      killAll: () => inner.killAll(),
    },
  };
}

const FORBIDDEN = ['checkout', 'stash', 'reset', '--staged', 'clean', '--source=HEAD~', 'switch'];

describe('restoreFromHead (§12.4)', () => {
  it('restores the worktree copy of a tracked file and leaves the index alone', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'dir/c d.txt': 'c\n' });
    write(t.ws, 'a.txt', 'changed by a command\n');
    write(t.ws, 'b.txt', 'staged\n');
    git(t.ws, 'add', 'b.txt');
    write(t.ws, 'b.txt', 'then changed again\n');
    write(t.ws, 'dir/c d.txt', 'C\n');
    const s = spy(t.sandbox);
    const r = await restoreFromHead(s.sandbox, t.ws, ['a.txt', 'dir/c d.txt']);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(t.ws, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(t.ws, 'dir/c d.txt'), 'utf8')).toBe('c\n');
    expect(readFileSync(join(t.ws, 'b.txt'), 'utf8')).toBe('then changed again\n');
    // the one command: neutralising flags, `--literal-pathspecs` before the verb, the fixed verb, `--` before the paths, spaces quoted
    expect(s.commands).toHaveLength(1);
    const cmd = s.commands[0]!;
    expect(cmd.startsWith('git -c ')).toBe(true);
    for (let i = 1; i < GIT_BASE_FLAGS.length; i += 2) expect(cmd).toContain(GIT_BASE_FLAGS[i]!);
    expect(cmd).toContain(`${LITERAL_PATHSPECS_FLAG} ${RESTORE_ARGS.join(' ')} -- a.txt 'dir/c d.txt'`);
    expect(cmd.indexOf(LITERAL_PATHSPECS_FLAG)).toBeLessThan(cmd.indexOf(' restore '));
    for (const word of FORBIDDEN) expect(cmd).not.toContain(word);

    // restoring the staged-then-modified file touches the worktree only: the index keeps the staged content
    const r2 = await restoreFromHead(s.sandbox, t.ws, ['b.txt']);
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(t.ws, 'b.txt'), 'utf8')).toBe('b\n');
    expect(git(t.ws, 'diff', '--cached', '--name-only').trim()).toBe('b.txt');
    expect(git(t.ws, 'show', ':b.txt')).toBe('staged\n');
  });

  it('an untracked or unknown path is a failed result, not a throw; nothing else is touched', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    write(t.ws, 'u.txt', 'u\n');
    write(t.ws, 'a.txt', 'A\n');
    const r = await restoreFromHead(t.sandbox, t.ws, ['u.txt']);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(t.ws, 'u.txt'), 'utf8')).toBe('u\n');
    expect(readFileSync(join(t.ws, 'a.txt'), 'utf8')).toBe('A\n');
  });

  it('a workspace that is a subdirectory of its repository restores cwd-relative paths', async () => {
    const t = ws();
    initRepo(t.ws, { 'sub/x.txt': 'x\n', 'top.txt': 't\n' });
    write(t.ws, 'sub/x.txt', 'X\n');
    write(t.ws, 'top.txt', 'T\n');
    const sub = join(t.ws, 'sub');
    const r = await restoreFromHead(t.sandbox, sub, ['x.txt']);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(sub, 'x.txt'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(t.ws, 'top.txt'), 'utf8')).toBe('T\n');
  });

  it('refuses an empty list, NUL, absolute paths and `..` before spawning anything', async () => {
    const t = ws();
    const s = spy(t.sandbox);
    expect(() => restoreFromHead(s.sandbox, t.ws, [])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, ['a\u0000b'])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, [''])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, ['/etc/passwd'])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, ['../outside.txt'])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, ['a/../../b'])).toThrow(TypeError);
    expect(() => restoreFromHead(s.sandbox, t.ws, [42 as unknown as string])).toThrow(TypeError);
    expect(s.commands).toEqual([]);
  });

  it('the verb is fixed: worktree only, source HEAD', () => {
    expect(RESTORE_ARGS).toEqual(['restore', '--source=HEAD', '--worktree']);
    expect(LITERAL_PATHSPECS_FLAG).toBe('--literal-pathspecs');
  });

  // fix-pass blocker 1 (C40): recorded relpaths are file names, never glob pathspecs or `:` magic
  it('glob characters and pathspec magic in a recorded name touch ONLY that file: `pages/[slug].tsx`, `a*.txt`, `:!keep.txt`', async () => {
    const t = ws();
    initRepo(t.ws, {
      'pages/[slug].tsx': 'slug\n',
      'pages/s.tsx': 's\n',
      'a*.txt': 'star\n',
      'a1.txt': 'a1\n',
      ':!keep.txt': 'keep\n',
      'sibling.txt': 'sib\n',
      'dir/other.txt': 'other\n',
    });
    // every file dirty: the user's edits in the siblings must survive the restore of the named ones
    for (const rel of ['pages/[slug].tsx', 'pages/s.tsx', 'a*.txt', 'a1.txt', ':!keep.txt', 'sibling.txt', 'dir/other.txt']) write(t.ws, rel, `dirty ${rel}\n`);
    const s = spy(t.sandbox);

    const r1 = await restoreFromHead(s.sandbox, t.ws, ['pages/[slug].tsx']);
    expect(r1.ok).toBe(true);
    expect(readFileSync(join(t.ws, 'pages/[slug].tsx'), 'utf8')).toBe('slug\n');
    expect(readFileSync(join(t.ws, 'pages/s.tsx'), 'utf8')).toBe('dirty pages/s.tsx\n');

    const r2 = await restoreFromHead(s.sandbox, t.ws, ['a*.txt']);
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(t.ws, 'a*.txt'), 'utf8')).toBe('star\n');
    expect(readFileSync(join(t.ws, 'a1.txt'), 'utf8')).toBe('dirty a1.txt\n');

    // `:!keep.txt` as a pathspec means "everything except keep.txt" and would restore the whole tree
    const r3 = await restoreFromHead(s.sandbox, t.ws, [':!keep.txt']);
    expect(r3.ok).toBe(true);
    expect(readFileSync(join(t.ws, ':!keep.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(t.ws, 'sibling.txt'), 'utf8')).toBe('dirty sibling.txt\n');
    expect(readFileSync(join(t.ws, 'dir/other.txt'), 'utf8')).toBe('dirty dir/other.txt\n');
    expect(readFileSync(join(t.ws, 'a1.txt'), 'utf8')).toBe('dirty a1.txt\n');
    expect(readFileSync(join(t.ws, 'pages/s.tsx'), 'utf8')).toBe('dirty pages/s.tsx\n');
    for (const cmd of s.commands) expect(cmd).toContain(LITERAL_PATHSPECS_FLAG);

    // a name that exists only as a glob match is unmatched → failed result, nothing restored (§12.4: the planner reports it)
    write(t.ws, 'pages/s.tsx', 'still dirty\n');
    const r4 = await restoreFromHead(s.sandbox, t.ws, ['pages/[x].tsx']);
    expect(r4.ok).toBe(false);
    expect(readFileSync(join(t.ws, 'pages/s.tsx'), 'utf8')).toBe('still dirty\n');
  });

  // fix-pass finding 8: the same hazard in the tracked check that feeds `recoverable`
  it('lsFilesTracked is exact: an untracked `pages/[slug].tsx` is not tracked because `pages/s.tsx` is', async () => {
    const t = ws();
    initRepo(t.ws, { 'pages/s.tsx': 's\n', 'a1.txt': 'a1\n', 'b*.txt': 'b\n' });
    write(t.ws, 'pages/[slug].tsx', 'untracked\n');
    write(t.ws, 'a*.txt', 'untracked\n');
    const s = spy(t.sandbox);
    expect(await lsFilesTracked(s.sandbox, t.ws, 'pages/[slug].tsx')).toBe(false);
    expect(await lsFilesTracked(s.sandbox, t.ws, 'a*.txt')).toBe(false);
    expect(await lsFilesTracked(s.sandbox, t.ws, 'b*.txt')).toBe(true);
    expect(await lsFilesTracked(s.sandbox, t.ws, 'pages/s.tsx')).toBe(true);
    expect(await lsFilesTracked(s.sandbox, t.ws, ':!a1.txt')).toBe(false);
    for (const cmd of s.commands) expect(cmd).toContain(`${LITERAL_PATHSPECS_FLAG} ls-files`);
  });
});
