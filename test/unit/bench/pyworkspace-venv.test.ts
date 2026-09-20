/**
 * linkVenv (ladder/pyworkspace.ts): the shared pytest venv is exposed to the agent as
 * <workspace>/.venv, the one place the sandbox puts on PATH; the bare `python3` fallback links
 * nothing; the link is idempotent and excluded from git (both `.venv/` and the symlink form `.venv`).
 */
import { lstat, mkdir, mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_EXCLUDES, gitInitCommand, linkVenv } from '../../../src/bench/ladder/pyworkspace.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('linkVenv', () => {
  it('links <workspace>/.venv to the venv of the resolved interpreter, once', async () => {
    const t = await mkdtemp(join(tmpdir(), 'jev-venv-'));
    dirs.push(t);
    const ws = join(t, 'ws');
    const venv = join(t, 'ladder-venv');
    await mkdir(join(ws), { recursive: true });
    await mkdir(join(venv, 'bin'), { recursive: true });
    await linkVenv(ws, join(venv, 'bin', 'python'));
    expect((await lstat(join(ws, '.venv'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(ws, '.venv'))).toBe(venv);
    await linkVenv(ws, join(venv, 'bin', 'python')); // a re-used workspace: no EEXIST
    expect(await readlink(join(ws, '.venv'))).toBe(venv);
  });
  it('the system python3 fallback links nothing', async () => {
    const t = await mkdtemp(join(tmpdir(), 'jev-venv-'));
    dirs.push(t);
    await linkVenv(t, 'python3');
    await expect(lstat(join(t, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('git excludes cover the symlink form too (a `.venv/` pattern matches only a real directory)', () => {
    expect(GIT_EXCLUDES).toContain('.venv/');
    expect(GIT_EXCLUDES).toContain('.venv');
    expect(gitInitCommand('m')).toContain('.venv/\\n.venv\\n');
  });
});
