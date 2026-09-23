import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_LIST_ENTRIES, createCandidateCache, sniffBinary, underSkippedDir, walkTree } from '../../../src/workspace/candidates.js';
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

const never = (): AbortSignal => new AbortController().signal;

describe('candidates in a git repo', () => {
  it('drops the 120000 symlink entry, .env, binaries and > 1 MB files; keeps untracked files', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': 'a\n', '.env': 'KEY=1\n', '.env.example': 'KEY=\n', 'server.pem': 'x\n' });
    symlinkSync('/etc/hosts', join(t.ws, 'hosts-link'));
    git(t.ws, 'add', 'hosts-link');
    git(t.ws, 'commit', '-q', '-m', 'link');
    write(t.ws, 'untracked.txt', 'u\n');
    // an untracked symlink to an in-workspace file: git lists it as a bare path with no mode
    symlinkSync(join(t.ws, 'src', 'a.py'), join(t.ws, 'alias-link'));
    writeFileSync(join(t.ws, 'blob.bin'), Buffer.from([1, 2, 0, 4]));
    writeFileSync(join(t.ws, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    write(t.ws, 'ignored.log', 'x\n');
    write(t.ws, '.gitignore', '*.log\n');
    const w = await makeWorkspace(t);
    const paths = (await w.listCandidates()).map((c) => c.path);
    expect(paths).toEqual(['.env.example', '.gitignore', 'src/a.py', 'untracked.txt']);
    expect(paths).not.toContain('hosts-link');
    expect(paths).not.toContain('alias-link');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('server.pem');
    expect(paths).not.toContain('blob.bin');
    expect(paths).not.toContain('big.txt');
    expect(paths).not.toContain('ignored.log');
    expect((await w.listCandidates()).find((c) => c.path === 'src/a.py')?.bytes).toBe(2);
  });

  it('an untracked, un-ignored virtualenv, node_modules or __pycache__ never becomes candidates; tracked files under those names stay', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': 'a\n', 'build/keep.txt': 'kept\n' });
    // the demo workspace of 20260923-065340-jk2tqc7w: a `.venv` nobody gitignored — 1,092 untracked files, enough `.py` to read as a repository-class checkout
    write(t.ws, '.venv/lib/python3.9/site-packages/pip/_internal/utils/wheel.py', 'x = 1\n');
    write(t.ws, '.venv/bin/activate', 'export VIRTUAL_ENV=1\n');
    write(t.ws, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    write(t.ws, 'src/__pycache__/a.cpython-39.pyc', 'text, so the binary sniff is not what drops it\n');
    write(t.ws, 'untracked.py', 'u\n');
    const w = await makeWorkspace(t);
    const paths = (await w.listCandidates()).map((c) => c.path);
    expect(paths).toEqual(['build/keep.txt', 'src/a.py', 'untracked.py']);
    expect(underSkippedDir('.venv/lib/python3.9/site-packages/x.py')).toBe(true);
    expect(underSkippedDir('src/__pycache__/a.pyc')).toBe(true);
    expect(underSkippedDir('build')).toBe(false); // a file named like a skipped directory is a file
    expect(underSkippedDir('src/build.py')).toBe(false);
  });

  it('invalidation picks up a file created by a command; noteChanged updates bytes and removes deleted files', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const w = await makeWorkspace(t);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt']);
    await t.sandbox.run('echo created > by-command.txt; rm a.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    // cached until invalidated
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt']);
    await w.invalidateCandidates();
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['by-command.txt']);
    await w.writeFile({ kind: 'write', path: 'new.txt', content: 'hello world\n' });
    const after = await w.listCandidates();
    expect(after.find((c) => c.path === 'new.txt')?.bytes).toBe(12);
    await t.sandbox.run('rm new.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.noteChanged(['new.txt']);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['by-command.txt']);
  });
});

describe('candidates without git (readdir walk)', () => {
  it('skips node_modules and friends, symlinks, secrets', async () => {
    const t = ws();
    write(t.ws, 'src/index.ts', 'x\n');
    write(t.ws, 'node_modules/pkg/index.js', 'x\n');
    write(t.ws, 'dist/out.js', 'x\n');
    write(t.ws, '__pycache__/a.pyc', 'x\n');
    write(t.ws, 'deploy/.env.prod', 'x\n');
    write(t.ws, 'keys/id_rsa', 'x\n');
    mkdirSync(join(t.base, 'outside'));
    writeFileSync(join(t.base, 'outside', 'o.txt'), 'o\n');
    symlinkSync(join(t.base, 'outside'), join(t.ws, 'link-dir'));
    symlinkSync(join(t.base, 'outside', 'o.txt'), join(t.ws, 'link-file'));
    const w = await makeWorkspace(t);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['src/index.ts']);
  });

  it('walkTree stops at the entry cap with a warning naming the cap', async () => {
    const t = ws();
    for (let i = 0; i < 40; i++) write(t.ws, `f${String(i).padStart(3, '0')}.txt`, 'x');
    const warnings: string[] = [];
    const all = await walkTree(t.ws, (m) => warnings.push(m));
    expect(all).toHaveLength(40);
    expect(warnings).toEqual([]);
    expect(MAX_LIST_ENTRIES).toBe(20_000);
    const capped = await walkTree(t.ws, (m) => warnings.push(m), 10);
    expect(capped).toHaveLength(10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('10 entries');
    expect(warnings[0]).toContain('MAX_LIST_ENTRIES');
    // the workspace-level warn sink receives it too when the walk is used by the cache
    const sink: string[] = [];
    const w = await makeWorkspace(t, { warn: (m) => sink.push(m) });
    expect((await w.listCandidates()).length).toBe(40);
    expect(sink).toEqual([]);
  });

  it('sniffBinary and the cache internals', async () => {
    const t = ws();
    writeFileSync(join(t.ws, 'text.txt'), 'plain');
    writeFileSync(join(t.ws, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00]));
    expect(await sniffBinary(join(t.ws, 'text.txt'))).toBe(false);
    expect(await sniffBinary(join(t.ws, 'bin.dat'))).toBe(true);
    let lists = 0;
    const cache = createCandidateCache({
      root: t.ws,
      gitList: async () => {
        lists++;
        return ['text.txt', 'bin.dat', 'missing.txt'];
      },
      resolveRead: async (rel) => join(t.ws, rel),
      isSecret: () => false,
    });
    expect(await cache.list()).toEqual([{ path: 'text.txt', bytes: 5 }]);
    expect(await cache.list()).toHaveLength(1);
    expect(lists).toBe(1);
    await cache.invalidate();
    expect(lists).toBe(2);
    expect(cache.entries().get('bin.dat')?.excluded).toBe(true);
  });
});
