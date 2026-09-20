import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GIT_BASE_FLAGS, isRepo, lsFiles, lsFilesTracked, runGit, shellJoin, shellQuote, statusPorcelain, topLevel } from '../../../src/workspace/git.js';
import { git, initRepo, makeWorkspace, tempWs, write } from './helpers.js';
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

function plant(gitDir: string, sentinel: string): void {
  // git appends protocol args (fsmonitor: version + token; diff.external: 7 paths); the
  // wrapper swallows them so the sentinel path stays exact.
  const cmd = `sh -c 'touch ${sentinel}' fsm`;
  writeFileSync(join(gitDir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tfsmonitor = ${cmd}\n\thooksPath = ${gitDir}/hooks\n[diff]\n\texternal = ${cmd}\n`);
}

describe('shell quoting', () => {
  it('quotes only what needs it', () => {
    expect(shellQuote('simple-arg_1.txt')).toBe('simple-arg_1.txt');
    expect(shellQuote('has space')).toBe("'has space'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellJoin(['git', 'a b'])).toBe("git 'a b'");
  });
});

describe('harness git defence 2', () => {
  it('planted core.fsmonitor / diff.external never run and no key reaches the env (direct .git)', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const sentinel = join(t.base, 'sentinel');
    plant(join(t.ws, '.git'), sentinel);
    // sanity: an unprotected harness git *would* run the planted command
    spawnSync('git', ['status', '--porcelain'], { cwd: t.ws, env: process.env });
    const unprotectedRan = existsSync(sentinel);
    rmSync(sentinel, { force: true });

    write(t.ws, 'b.txt', 'b\n');
    process.env['OPENROUTER_API_KEY'] = 'sk-or-v1-' + 'b'.repeat(40);
    try {
      expect(await isRepo(t.sandbox, t.ws)).toBe(true);
      const status = await statusPorcelain(t.sandbox, t.ws);
      expect(status.ok).toBe(true);
      expect(status.entries).toEqual([{ code: '??', path: 'b.txt' }]);
      const ls = await lsFiles(t.sandbox, t.ws);
      expect(ls.paths.sort()).toEqual(['a.txt', 'b.txt']);
      const diff = await runGit(t.sandbox, t.ws, ['diff', 'HEAD', '--stat']);
      expect(diff.ok).toBe(true);
      const env = await runGit(t.sandbox, t.ws, ['-c', 'alias.dumpenv=!env', 'dumpenv']);
      expect(env.ok).toBe(true);
      expect(env.stdout).not.toContain('OPENROUTER_API_KEY');
      expect(env.stdout).toMatch(/^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
      expect(env.stdout).toMatch(/^GIT_CONFIG_NOSYSTEM=1$/m);
      expect(env.stdout).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
      expect(env.stdout).toMatch(new RegExp(`^HOME=${t.runDir}/home$`, 'm'));
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
    expect(existsSync(sentinel)).toBe(false);
    // report, not assert: newer git may already refuse a planted fsmonitor
    if (!unprotectedRan) console.warn('note: unprotected git did not execute the planted fsmonitor on this machine');
  });

  it('the same through a gitdir: pointer file', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    renameSync(join(t.ws, '.git'), join(t.ws, '.g'));
    writeFileSync(join(t.ws, '.git'), 'gitdir: .g\n');
    const sentinel = join(t.base, 'sentinel2');
    plant(join(t.ws, '.g'), sentinel);
    write(t.ws, 'c.txt', 'c\n');
    const w = await makeWorkspace(t);
    expect((await w.info()).git).toBe(true);
    const status = await statusPorcelain(t.sandbox, t.ws);
    expect(status.entries.map((e) => e.path)).toContain('c.txt');
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt', 'c.txt']);
    expect(await w.changedFiles()).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('every harness git call carries the neutralising -c flags', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const seen: string[] = [];
    const spy = {
      level: t.sandbox.level,
      run: (cmd: string, o: Parameters<typeof t.sandbox.run>[1]) => {
        seen.push(cmd);
        return t.sandbox.run(cmd, o);
      },
      killAll: () => t.sandbox.killAll(),
    };
    await statusPorcelain(spy, t.ws);
    await runGit(spy, t.ws, ['diff', '--stat']);
    expect(seen).toHaveLength(2);
    for (const cmd of seen) {
      for (let i = 1; i < GIT_BASE_FLAGS.length; i += 2) expect(cmd).toContain(GIT_BASE_FLAGS[i]!);
      expect(cmd.startsWith('git -c ')).toBe(true);
    }
    expect(seen[0]).toContain('--no-optional-locks status');
    expect(seen[1]).toContain('diff --no-ext-diff --no-textconv --stat');
  });

  it('helpers: topLevel, lsFilesTracked, renames in status, non-repo', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
    expect(await topLevel(t.sandbox, t.ws)).toBe(t.ws);
    expect(await lsFilesTracked(t.sandbox, t.ws, 'a.txt')).toBe(true);
    expect(await lsFilesTracked(t.sandbox, t.ws, 'nope.txt')).toBe(false);
    git(t.ws, 'mv', 'a.txt', 'renamed.txt');
    const s = await statusPorcelain(t.sandbox, t.ws);
    expect(s.entries).toContainEqual({ code: 'R ', path: 'renamed.txt', from: 'a.txt' });
    const plain = ws();
    expect(await isRepo(plain.sandbox, plain.ws)).toBe(false);
    expect(await topLevel(plain.sandbox, plain.ws)).toBeNull();
    expect((await lsFiles(plain.sandbox, plain.ws)).paths).toEqual([]);
  });
});
