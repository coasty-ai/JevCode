import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, EditError, FileNotFoundError, PathEscapeError, SecretPathError } from '../../../src/errors.js';
import { createWorkspace } from '../../../src/workspace/files.js';
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

describe('createWorkspace', () => {
  it('realpaths the root and reports info', async () => {
    const t = ws();
    initRepo(t.ws, { 'pytest.ini': '[pytest]\n', 'tests/test_a.py': 'def test_a(): pass\n' });
    symlinkSync(t.ws, join(t.base, 'ws-link'));
    const w = await createWorkspace(join(t.base, 'ws-link'), t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (s) => s });
    expect(w.root).toBe(t.ws);
    const info = await w.info();
    expect(info).toMatchObject({ root: t.ws, git: true, hasTests: true, testCommand: { command: 'python3 -m pytest -q', runner: 'pytest' } });
    expect(typeof info.testCommand?.scope).toBe('function');
    expect(await w.info()).toBe(info);
  });

  it('rejects a missing workspace with ConfigError', async () => {
    const t = ws();
    await expect(createWorkspace(join(t.base, 'nope'), t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (s) => s })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('read', () => {
  it('bounded reads with truncatedBytes, redaction, and path/secret checks', async () => {
    const t = ws();
    write(t.ws, 'src/a.py', 'hello wörld\n'.repeat(10));
    write(t.ws, '.env', 'KEY=abc\n');
    write(t.ws, 'conf/settings.json', '{}');
    const w = await makeWorkspace(t, { redact: (s) => s.replaceAll('hello', '[R]'), secretPaths: [join(t.ws, 'conf', 'settings.json')] });
    const full = await w.read('src/a.py', 100_000);
    expect(full.path).toBe('src/a.py');
    expect(full.bytes).toBe(Buffer.byteLength('hello wörld\n') * 10);
    expect(full.truncatedBytes).toBe(0);
    expect(full.content.startsWith('[R] wörld\n')).toBe(true);
    const clipped = await w.read('./src/a.py', 20);
    expect(Buffer.byteLength(clipped.content.replaceAll('[R]', 'hello'))).toBeLessThanOrEqual(20);
    expect(clipped.truncatedBytes).toBe(full.bytes - Buffer.byteLength(clipped.content.replaceAll('[R]', 'hello')));
    await expect(w.read('.env', 1000)).rejects.toBeInstanceOf(SecretPathError);
    await expect(w.read('conf/settings.json', 1000)).rejects.toBeInstanceOf(SecretPathError);
    await expect(w.read('../outside.txt', 1000)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(w.read('/etc/passwd', 1000)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(w.read('src', 1000)).rejects.toMatchObject({ code: 'internal' });
    // a missing path is a typed, per-action error (the engine records `outcome: failed` with a fail: signature)
    await expect(w.read('missing.txt', 1000)).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(w.read('missing.txt', 1000)).rejects.toMatchObject({ code: 'not_found', exitCode: 6, path: 'missing.txt' });
    await expect(w.read('no/such/dir/x.py', 1000)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('a symlinked file pointing outside is refused for read, edit and patch', async () => {
    const t = ws();
    writeFileSync(join(t.base, 'outside.txt'), 'secret\n');
    symlinkSync(join(t.base, 'outside.txt'), join(t.ws, 'link.txt'));
    const w = await makeWorkspace(t);
    await expect(w.read('link.txt', 1000)).rejects.toMatchObject({ kind: 'symlink' });
    await expect(w.applyEdit({ kind: 'edit', path: 'link.txt', old: 'secret', new: 'x' })).rejects.toMatchObject({ kind: 'symlink' });
    await expect(w.writeFile({ kind: 'write', path: 'link.txt', content: 'x' })).rejects.toMatchObject({ kind: 'symlink' });
    await expect(w.applyPatch('--- a/link.txt\n+++ b/link.txt\n@@ -1 +1 @@\n-secret\n+x\n')).rejects.toMatchObject({ kind: 'symlink' });
    expect(readFileSync(join(t.base, 'outside.txt'), 'utf8')).toBe('secret\n');
    expect((await w.listCandidates()).map((c) => c.path)).toEqual([]);
  });
});

describe('edit / write / changedFiles / target', () => {
  it('edits and writes atomically, tracks changedFiles against the snapshot', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'one\n', 'dirty.txt': 'clean\n' });
    write(t.ws, 'dirty.txt', 'already dirty before the run\n');
    write(t.ws, 'untracked-before.txt', 'x\n');
    const w = await makeWorkspace(t);
    expect(await w.changedFiles()).toEqual([]);

    const e = await w.applyEdit({ kind: 'edit', path: 'a.txt', old: 'one', new: 'two' });
    expect(e.changedFiles).toEqual(['a.txt']);
    expect(readFileSync(join(t.ws, 'a.txt'), 'utf8')).toBe('two\n');
    await expect(w.applyEdit({ kind: 'edit', path: 'a.txt', old: 'zzz', new: 'x' })).rejects.toBeInstanceOf(EditError);

    const wr = await w.writeFile({ kind: 'write', path: 'new/dir/n.txt', content: 'n\n' });
    expect(wr).toEqual({ changedFiles: ['new/dir/n.txt'], created: true });
    const wr2 = await w.writeFile({ kind: 'write', path: 'new/dir/n.txt', content: 'n2\n' });
    expect(wr2.created).toBe(false);
    expect(readdirSync(join(t.ws, 'new/dir'))).toEqual(['n.txt']);

    await t.sandbox.run('echo cmd > by-cmd.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates(); // the engine refreshes status after every command (§8, §12)
    expect(await w.changedFiles()).toEqual(['a.txt', 'by-cmd.txt', 'new/dir/n.txt']);

    // editing a pre-existing dirty file attributes it (the run wrote it)
    await w.applyEdit({ kind: 'edit', path: 'dirty.txt', old: 'already', new: 'still' });
    expect(await w.changedFiles()).toContain('dirty.txt');
    expect(await w.changedFiles()).not.toContain('untracked-before.txt');

    await expect(w.writeFile({ kind: 'write', path: '.git/config', content: 'x' })).rejects.toMatchObject({ kind: 'git' });
    await expect(w.writeFile({ kind: 'write', path: '.env.local', content: 'x' })).rejects.toBeInstanceOf(SecretPathError);
    await expect(w.writeFile({ kind: 'write', path: 'keys/server.key', content: 'x' })).rejects.toBeInstanceOf(SecretPathError);
    expect(existsSync(join(t.ws, 'keys'))).toBe(false);
  });

  it('a workspace that is a subdirectory of its repository reports workspace-relative changes only', async () => {
    const t = ws();
    initRepo(t.ws, { 'sub/a.txt': 'a\n', 'sub/dir/b.txt': 'b\n', 'top.txt': 'top\n' });
    const sub = join(t.ws, 'sub');
    write(t.ws, 'sub/dirty.txt', 'dirty before\n');
    const { createSandbox } = await import('../../../src/sandbox/run.js');
    const sandbox = createSandbox({ workspaceRoot: sub, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ttyPath: null });
    const w = await createWorkspace(sub, t.runDir, { sandbox, secretPaths: [], redact: (s) => s });
    expect(w.root).toBe(sub);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt', 'dir/b.txt', 'dirty.txt']);
    expect(await w.changedFiles()).toEqual([]);
    // changes outside the workspace (another engineer, the user) are never the run's
    write(t.ws, 'top.txt', 'modified outside\n');
    write(t.ws, 'other.txt', 'new outside\n');
    expect(await w.changedFiles()).toEqual([]);
    await w.applyEdit({ kind: 'edit', path: 'dir/b.txt', old: 'b', new: 'B' });
    await sandbox.run('echo cmd > by-cmd.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates(); // the engine refreshes status after every command (§8, §12)
    expect(await w.changedFiles()).toEqual(['by-cmd.txt', 'dir/b.txt']);
    expect((await w.target('a.txt', new Set())).tracked).toBe(true);
  });

  it('changedFiles in a non-git workspace lists the file actions', async () => {
    const t = ws();
    write(t.ws, 'a.txt', 'a\n');
    const w = await makeWorkspace(t);
    expect(await w.changedFiles()).toEqual([]);
    await w.writeFile({ kind: 'write', path: 'b.txt', content: 'b' });
    await w.applyEdit({ kind: 'edit', path: 'a.txt', old: 'a', new: 'A' });
    expect(await w.changedFiles()).toEqual(['a.txt', 'b.txt']);
  });

  it('target() reports existence, tracking and recoverability', async () => {
    const t = ws();
    initRepo(t.ws, { 'tracked.txt': 't\n' });
    write(t.ws, 'untracked.txt', 'u\n');
    const w = await makeWorkspace(t);
    const created = new Set(['made.txt']);
    expect(await w.target('tracked.txt', created)).toEqual({ path: 'tracked.txt', existsBefore: true, tracked: true, createdThisRun: false, recoverable: true });
    expect(await w.target('untracked.txt', created)).toEqual({ path: 'untracked.txt', existsBefore: true, tracked: false, createdThisRun: false, recoverable: false });
    expect(await w.target('made.txt', created)).toEqual({ path: 'made.txt', existsBefore: false, tracked: false, createdThisRun: true, recoverable: true });
    expect(await w.target('./brand-new.txt', created)).toEqual({ path: 'brand-new.txt', existsBefore: false, tracked: false, createdThisRun: false, recoverable: false });
    await expect(w.target('../x', created)).rejects.toBeInstanceOf(PathEscapeError);
    git(t.ws, 'add', 'untracked.txt');
    expect((await w.target('untracked.txt', created)).tracked).toBe(true);
  });

  it('parseTestOutput is exposed on the workspace', async () => {
    const t = ws();
    const w = await makeWorkspace(t);
    expect(w.parseTestOutput('pytest', '3 passed in 0.1s\n')).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
  });
});
