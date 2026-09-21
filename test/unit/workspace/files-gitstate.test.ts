/**
 * TUI-DESIGN §19.0 (`files.test.ts` row) / §12.1 / §15 item 8: `createWorkspace` given a `gitState` performs zero
 * spawns and behaves exactly like the probing path; `gitState()`, `dirtySet()` and `readSecretForMention()`.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Sandbox } from '../../../src/core/types.js';
import { FileNotFoundError, PathEscapeError, SecretPathError } from '../../../src/errors.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { MENTION_MAX_BYTES, createWorkspace } from '../../../src/workspace/files.js';
import { notRepoState, probeGitState } from '../../../src/workspace/gitstate.js';
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
const never = (): AbortSignal => new AbortController().signal;

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

describe('createWorkspace with gitState (§12.1): zero spawns at run start', () => {
  it('constructs, lists info and the snapshot without a single sandbox.run; the probe rides on info() and gitState()', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'one\n', 'dirty.txt': 'clean\n', 'pytest.ini': '[pytest]\n' });
    write(t.ws, 'dirty.txt', 'already dirty before the run\n');
    write(t.ws, 'untracked-before.txt', 'x\n');
    const state = await probeGitState(t.ws);
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect(s.commands).toEqual([]);
    const info = await w.info();
    expect(info.git).toBe(true);
    expect(info.gitState).toBe(state);
    expect(w.gitState?.()).toBe(state);
    expect(await w.changedFiles()).toEqual([]);
    expect(s.commands).toEqual([]);
    // the snapshot came from the probe: pre-existing dirt is never attributed to the run
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['dirty.txt', 'untracked-before.txt']);
    await w.applyEdit({ kind: 'edit', path: 'a.txt', old: 'one', new: 'two' });
    expect(await w.changedFiles()).toEqual(['a.txt']);
    // the only spawns so far are the lazily built candidate listing (`git ls-files`, the in-run list §8 keeps);
    // no rev-parse and no status ran — the probe replaced them
    expect(s.commands.filter((c) => !c.includes(' ls-files '))).toEqual([]);
    expect(s.commands.some((c) => c.includes(' ls-files '))).toBe(true);
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['a.txt', 'dirty.txt', 'untracked-before.txt']);
  });

  it('after a command, one status refresh updates changedFiles, dirtySet and gitState().dirty (head unchanged)', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'one\n' });
    const state = await probeGitState(t.ws);
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    await t.sandbox.run('echo cmd > by-cmd.txt && echo more >> a.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    const statusSpawns = s.commands.filter((c) => c.includes(' status '));
    expect(statusSpawns.length).toBe(1);
    expect(await w.changedFiles()).toEqual(['a.txt', 'by-cmd.txt']);
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['a.txt', 'by-cmd.txt']);
    const now = w.gitState?.();
    expect(now).not.toBeNull();
    expect(now?.head).toEqual(state.head);
    expect(now?.dirty.untracked).toBe(1);
    expect(now?.dirty.modified).toBe(1);
    expect(now?.dirty.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'by-cmd.txt']);
    // the probe object itself is never mutated
    expect(state.dirty.entries).toEqual([]);
    expect((await w.info()).gitState).toBe(state);
  });

  it('parity: the probing path and the gitState path agree on candidates, changedFiles and target()', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'dir/c.txt': 'c\n' });
    write(t.ws, 'b.txt', 'B\n');
    write(t.ws, 'u.txt', 'u\n');
    const state = await probeGitState(t.ws);
    const legacy = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (x) => x });
    const probed = await createWorkspace(t.ws, join(t.base, 'run2'), { sandbox: t.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect((await probed.listCandidates()).map((c) => c.path)).toEqual((await legacy.listCandidates()).map((c) => c.path));
    expect(await probed.changedFiles()).toEqual(await legacy.changedFiles());
    await legacy.applyEdit({ kind: 'edit', path: 'a.txt', old: 'a', new: 'A' });
    await probed.noteChanged(['a.txt']);
    expect(await probed.changedFiles()).toEqual(await legacy.changedFiles());
    expect(await probed.target('a.txt', new Set())).toEqual(await legacy.target('a.txt', new Set()));
    expect(await probed.target('u.txt', new Set())).toEqual(await legacy.target('u.txt', new Set()));
  });

  it('subdirectory workspace: the probe prefix re-roots status paths and drops outside changes', async () => {
    const t = ws();
    initRepo(t.ws, { 'sub/a.txt': 'a\n', 'sub/dir/b.txt': 'b\n', 'top.txt': 'top\n' });
    const sub = join(t.ws, 'sub');
    write(t.ws, 'sub/dirty.txt', 'dirty before\n');
    write(t.ws, 'top.txt', 'modified outside\n');
    const state = await probeGitState(sub);
    expect(state.prefix).toBe('sub/');
    const sandbox = createSandbox({ workspaceRoot: sub, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (x) => x }, { ttyPath: null });
    const s = spy(sandbox);
    const w = await createWorkspace(sub, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect(s.commands).toEqual([]);
    expect(w.root).toBe(sub);
    expect([...(w.dirtySet?.() ?? [])]).toEqual(['dirty.txt']);
    expect(await w.changedFiles()).toEqual([]);
    await w.applyEdit({ kind: 'edit', path: 'dir/b.txt', old: 'b', new: 'B' });
    await sandbox.run('echo cmd > by-cmd.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    expect(await w.changedFiles()).toEqual(['by-cmd.txt', 'dir/b.txt']);
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['by-cmd.txt', 'dir/b.txt', 'dirty.txt']);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt', 'by-cmd.txt', 'dir/b.txt', 'dirty.txt']);
  });

  it('linked worktree: the probe gitDir lies outside the workspace and is not treated as a candidate prefix', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const wt = join(t.base, 'wt');
    git(t.ws, 'worktree', 'add', '-q', wt, '-b', 'wtb');
    const state = await probeGitState(wt);
    expect(state.linkedWorktree).toBe(true);
    const sandbox = createSandbox({ workspaceRoot: wt, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (x) => x }, { ttyPath: null });
    const s = spy(sandbox);
    const w = await createWorkspace(wt, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect(s.commands).toEqual([]);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt']);
    expect((await w.info()).gitState?.commonDir).toBe(join(t.ws, '.git'));
  });

  it('a `gitdir:` pointer file: the probe gitDir inside the workspace is excluded from candidates and changes', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const { renameSync, writeFileSync } = await import('node:fs');
    renameSync(join(t.ws, '.git'), join(t.ws, '.g'));
    writeFileSync(join(t.ws, '.git'), 'gitdir: .g\n');
    write(t.ws, 'c.txt', 'c\n');
    const state = await probeGitState(t.ws);
    expect(state.gitDir).toBe(join(t.ws, '.g'));
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect(s.commands).toEqual([]);
    expect((await w.listCandidates()).map((c) => c.path)).toEqual(['a.txt', 'c.txt']);
    expect(await w.changedFiles()).toEqual([]);
    expect([...(w.dirtySet?.() ?? [])]).toEqual(['c.txt']);
  });

  it('a non-repo GitState makes a non-git workspace: file actions only, still zero spawns', async () => {
    const t = ws();
    write(t.ws, 'a.txt', 'a\n');
    const state = notRepoState('not-a-repo', { probedAt: '2026-09-20T10:00:00.000Z', probeMs: 1 });
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect((await w.info()).git).toBe(false);
    expect((await w.info()).gitState).toBe(state);
    await w.writeFile({ kind: 'write', path: 'b.txt', content: 'b' });
    await w.invalidateCandidates();
    expect(await w.changedFiles()).toEqual(['b.txt']);
    expect([...(w.dirtySet?.() ?? [])]).toEqual(['b.txt']);
    expect(w.gitState?.()).toBe(state);
    expect(s.commands).toEqual([]);
  });

  it('without a gitState the probing path is unchanged and gitState() is null', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'a\n' });
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x });
    expect(s.commands.length).toBeGreaterThan(0);
    expect(w.gitState?.()).toBeNull();
    expect((await w.info()).gitState).toBeUndefined();
    expect('gitState' in (await w.info())).toBe(false);
  });
});

describe('readSecretForMention (§10.4, §15 item 8)', () => {
  it('reads a denylisted file raw (the caller registers its values), bounded, while read() keeps refusing it', async () => {
    const t = ws();
    write(t.ws, '.env', 'API_KEY=abcdefghijkl\nDATABASE_URL=postgres://user:pass@host/db\n');
    write(t.ws, 'conf/settings.json', '{"token":"abcdefghijkl"}');
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [join(t.ws, 'conf', 'settings.json')], redact: (x) => x.replaceAll('abcdefghijkl', '[R]') });
    await expect(w.read('.env', 1000)).rejects.toBeInstanceOf(SecretPathError);
    const v = await w.readSecretForMention!('.env', 16_384);
    expect(v.path).toBe('.env');
    expect(v.content).toContain('API_KEY=abcdefghijkl');
    expect(v.content).toContain('user:pass@host');
    expect(v.bytes).toBe(Buffer.byteLength('API_KEY=abcdefghijkl\nDATABASE_URL=postgres://user:pass@host/db\n'));
    expect(v.truncatedBytes).toBe(0);
    // a configured secret store as well
    const c = await w.readSecretForMention!('./conf/settings.json', 16_384);
    expect(c.content).toBe('{"token":"abcdefghijkl"}');
    // an ordinary (not denylisted) file reads exactly like read(): redacted — the method is never a general raw read
    write(t.ws, 'a.txt', 'plain abcdefghijkl\n');
    expect((await w.readSecretForMention!('a.txt', 100)).content).toBe('plain [R]\n');
    expect((await w.read('a.txt', 100)).content).toBe('plain [R]\n');
    // the mention-only basenames (`.npmrc`, `/credential/i`) are denylisted for the mention path and read raw
    write(t.ws, '.npmrc', '//registry/:_authToken=abcdefghijkl\n');
    write(t.ws, 'ops/credentials.json', '{"k":"abcdefghijkl"}');
    expect((await w.readSecretForMention!('.npmrc', 100)).content).toContain('abcdefghijkl');
    expect((await w.readSecretForMention!('ops/credentials.json', 100)).content).toBe('{"k":"abcdefghijkl"}');
  });

  it('caps at 16 KiB, keeps UTF-8 boundaries, and applies containment but not the secret rule', async () => {
    const t = ws();
    write(t.ws, '.env.local', 'KEY=' + 'é'.repeat(20_000) + '\n');
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (x) => x });
    const v = await w.readSecretForMention!('.env.local', 1_000_000);
    expect(Buffer.byteLength(v.content)).toBeLessThanOrEqual(MENTION_MAX_BYTES);
    expect(v.content.includes('�')).toBe(false);
    expect(v.truncatedBytes).toBe(v.bytes - Buffer.byteLength(v.content));
    const small = await w.readSecretForMention!('.env.local', 10);
    expect(Buffer.byteLength(small.content)).toBeLessThanOrEqual(10);
    const dflt = await w.readSecretForMention!('.env.local', Number.NaN);
    expect(Buffer.byteLength(dflt.content)).toBeLessThanOrEqual(MENTION_MAX_BYTES);
    await expect(w.readSecretForMention!('../outside.env', 100)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(w.readSecretForMention!('/etc/passwd', 100)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(w.readSecretForMention!('missing.env', 100)).rejects.toBeInstanceOf(FileNotFoundError);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(t.ws, 'adir'));
    await expect(w.readSecretForMention!('adir', 100)).rejects.toMatchObject({ code: 'internal' });
  });

  it('a symlink to a file outside the workspace is refused for mentions too', async () => {
    const t = ws();
    const { symlinkSync, writeFileSync } = await import('node:fs');
    writeFileSync(join(t.base, 'outside.env'), 'X=abcdefghijkl\n');
    symlinkSync(join(t.base, 'outside.env'), join(t.ws, '.env'));
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (x) => x });
    await expect(w.readSecretForMention!('.env', 100)).rejects.toMatchObject({ kind: 'symlink' });
  });
});

describe('per-command status refresh: failure, renames, exact tracked check, head follows a commit (fix pass)', () => {
  /** A sandbox that turns the `git status` command into a failing one while `failing` is set. */
  function flaky(inner: Sandbox): { sandbox: Sandbox; commands: string[]; state: { failing: boolean } } {
    const commands: string[] = [];
    const state = { failing: false };
    return {
      commands,
      state,
      sandbox: {
        level: inner.level,
        run: (cmd, o) => {
          commands.push(cmd);
          if (state.failing && cmd.includes(' status ')) return inner.run('echo "fatal: index file corrupt" >&2; exit 128', o);
          return inner.run(cmd, o);
        },
        killAll: () => inner.killAll(),
      },
    };
  }

  it('a FAILED status refresh leaves changedFiles, dirtySet and gitState().dirty as they were (never empty) and retries later', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'one\n' });
    const state = await probeGitState(t.ws);
    const f = flaky(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: f.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    await t.sandbox.run('echo cmd > by-cmd.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    expect(await w.changedFiles()).toEqual(['by-cmd.txt']);
    expect(w.gitState?.()?.dirty).toMatchObject({ untracked: 1 });
    const before = w.gitState?.();
    // now git status fails: the next command's changes are unknown, but nothing already known is dropped
    f.state.failing = true;
    await t.sandbox.run('echo two > second.txt', { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    expect(await w.changedFiles()).toEqual(['by-cmd.txt']);
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['by-cmd.txt']);
    expect(w.gitState?.()).toBe(before);
    expect(w.gitState?.()?.dirty.entries.map((e) => e.path)).toEqual(['by-cmd.txt']);
    const failedSpawns = f.commands.filter((c) => c.includes(' status ')).length;
    expect(failedSpawns).toBeGreaterThanOrEqual(2);
    // git recovers: the pending refresh picks up both files with the next reader
    f.state.failing = false;
    expect(await w.changedFiles()).toEqual(['by-cmd.txt', 'second.txt']);
    expect(w.gitState?.()?.dirty.untracked).toBe(2);
  });

  it('a rename reported by the v1 refresh contributes both paths, re-rooted under a subdirectory prefix', async () => {
    const t = ws();
    initRepo(t.ws, { 'sub/a.txt': 'a\n', 'sub/dir/b.txt': 'b\n', 'top.txt': 'top\n' });
    const sub = join(t.ws, 'sub');
    const state = await probeGitState(sub);
    expect(state.prefix).toBe('sub/');
    const sandbox = createSandbox({ workspaceRoot: sub, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (x) => x }, { ttyPath: null });
    const w = await createWorkspace(sub, t.runDir, { sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    // a command renames inside the workspace and another file outside it (the outside change must not leak in)
    await sandbox.run('git mv a.txt renamed.txt && git mv dir/b.txt dir/moved.txt && git mv ../top.txt ../top2.txt', { timeoutMs: 10_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    expect(await w.changedFiles()).toEqual(['a.txt', 'dir/b.txt', 'dir/moved.txt', 'renamed.txt']);
    expect([...(w.dirtySet?.() ?? [])].sort()).toEqual(['a.txt', 'dir/b.txt', 'dir/moved.txt', 'renamed.txt']);
    const now = w.gitState?.();
    expect(now?.dirty.renamed).toBe(3);
    expect(now?.dirty.staged).toBe(3);
    // entries stay top-level relative like the probe's (the caller strips `prefix`)
    expect(now?.dirty.entries.find((e) => e.path === 'sub/renamed.txt')).toMatchObject({ xy: 'R.', from: 'sub/a.txt' });
    expect(now?.dirty.entries.map((e) => e.path).sort()).toEqual(['sub/dir/moved.txt', 'sub/renamed.txt', 'top2.txt']);
  });

  it('target() is exact for glob-looking names: `pages/[slug].tsx` is not tracked because `pages/s.tsx` is', async () => {
    const t = ws();
    initRepo(t.ws, { 'pages/s.tsx': 's\n', 'lib/[id].ts': 'id\n' });
    write(t.ws, 'pages/[slug].tsx', 'untracked\n');
    const state = await probeGitState(t.ws);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    expect(await w.target('pages/[slug].tsx', new Set())).toEqual({ path: 'pages/[slug].tsx', existsBefore: true, tracked: false, createdThisRun: false, recoverable: false });
    expect(await w.target('lib/[id].ts', new Set())).toEqual({ path: 'lib/[id].ts', existsBefore: true, tracked: true, createdThisRun: false, recoverable: true });
    expect(await w.target('pages/s.tsx', new Set())).toMatchObject({ tracked: true, recoverable: true });
  });

  it('gitState().head follows a committing command in-process (no extra spawn); upstream stays from run start', async () => {
    const t = ws();
    initRepo(t.ws, { 'a.txt': 'one\n' });
    const state = await probeGitState(t.ws);
    const startOid = state.head?.kind === 'branch' ? state.head.oid : null;
    expect(startOid).toMatch(/^[0-9a-f]{40}$/);
    const s = spy(t.sandbox);
    const w = await createWorkspace(t.ws, t.runDir, { sandbox: s.sandbox, secretPaths: [], redact: (x) => x, gitState: state });
    await t.sandbox.run('echo two > a.txt && git add a.txt && git -c user.email=a@b -c user.name=n -c commit.gpgsign=false commit -q -m c', { timeoutMs: 10_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    const newOid = git(t.ws, 'rev-parse', 'HEAD').trim();
    expect(newOid).not.toBe(startOid);
    const now = w.gitState?.();
    expect(now?.head).toEqual({ kind: 'branch', name: state.head?.kind === 'branch' ? state.head.name : '', oid: newOid });
    expect(now?.upstream).toBe(state.upstream);
    expect(now?.dirty.entries).toEqual([]);
    // the only harness spawn was the one status refresh — HEAD was read from the file system
    expect(s.commands.filter((c) => c.includes('rev-parse') || c.includes('symbolic-ref') || c.includes(' log '))).toEqual([]);
    expect(s.commands.filter((c) => c.includes(' status ')).length).toBe(1);
    // the probe object is untouched and the workspace event still carries the run-start head
    expect(state.head?.kind === 'branch' ? state.head.oid : null).toBe(startOid);
    expect((await w.info()).gitState).toBe(state);
    // a detached checkout by a command is followed too
    await t.sandbox.run('git checkout -q --detach', { timeoutMs: 10_000, maxOutputBytes: 10_000, signal: never() });
    await w.invalidateCandidates();
    expect(w.gitState?.()?.head).toEqual({ kind: 'detached', oid: newOid });
  });
});
