/**
 * TUI-DESIGN §19.0 (`gitstate` row) / §12.1: `probeGitState` across the repository shapes — top level clean and
 * dirty, subdirectory, linked worktree, detached, unborn, bare, not a repo, `PATH` without git, timeout — plus the
 * A140 invariant: exactly two `execFile` calls, both carrying the neutralising flags and a key-free env.
 */
import { execFile, execFileSync } from 'node:child_process';
import type { ChildProcess, ExecFileException, ExecFileOptions } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitState } from '../../../src/core/types.js';
import { GIT_BASE_FLAGS, GIT_ENV } from '../../../src/workspace/git.js';
import { DEFAULT_PROBE_TIMEOUT_MS, GIT_PROBE_ARGS, PROBE_MAX_BUFFER, bannerInput, gitBannerLine, probeArgv, probeEnv, probeGitState, toRunGitMeta } from '../../../src/workspace/gitstate.js';
import { git, write } from './helpers.js';

type Cb = (err: ExecFileException | null, stdout: string, stderr: string) => void;
interface Call {
  args: string[];
  opts: ExecFileOptions;
}

let temps: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'jev-probe-')));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});

function initMain(ws: string, files: Record<string, string>): void {
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main', '.');
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
}

/** The real execFile behind a counter that records every call. */
function counting(): { impl: typeof execFile; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((file: string, args: readonly string[], opts: ExecFileOptions, cb: Cb): ChildProcess => {
    calls.push({ args: [...args], opts });
    return execFile(file, args, { ...opts, encoding: 'utf8' }, cb);
  }) as unknown as typeof execFile;
  return { impl, calls };
}

/** A scripted execFile: `handler` decides the callback per spawn. */
function scripted(handler: (args: readonly string[], cb: Cb) => void): { impl: typeof execFile; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((_file: string, args: readonly string[], opts: ExecFileOptions, cb: Cb): ChildProcess => {
    calls.push({ args: [...args], opts });
    setImmediate(() => handler(args, cb));
    return {} as unknown as ChildProcess;
  }) as unknown as typeof execFile;
  return { impl, calls };
}

function errno(code: string): ExecFileException {
  const e = new Error(`spawn git ${code}`) as ExecFileException;
  e.code = code;
  return e;
}

function repo(g: GitState): asserts g is GitState & { repo: true; gitDir: string; commonDir: string; topLevel: string } {
  expect(g.repo).toBe(true);
  expect(g.reason).toBeUndefined();
  expect(typeof g.gitDir).toBe('string');
}

describe('probeGitState: repository shapes (§12.1, real git)', () => {
  it('top level, clean, one commit on main: head with oid, no upstream, empty dirty set', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const g = await probeGitState(ws);
    repo(g);
    expect(g.gitDir).toBe(join(ws, '.git'));
    expect(g.commonDir).toBe(join(ws, '.git'));
    expect(g.topLevel).toBe(ws);
    expect(g.prefix).toBe('');
    expect(g.linkedWorktree).toBe(false);
    expect(g.head).toMatchObject({ kind: 'branch', name: 'main' });
    expect(g.head?.kind === 'branch' ? g.head.oid : null).toMatch(/^[0-9a-f]{40}$/);
    expect(g.upstream).toBeNull();
    expect(g.ahead).toBeNull();
    expect(g.behind).toBeNull();
    expect(g.dirty).toEqual({ modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] });
    expect(g.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(g.probeMs).toBeGreaterThanOrEqual(0);
    expect(g.probeMs).toBeLessThan(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('dirty tree: modified, staged, renamed and untracked entries with top-level-relative paths', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'old name.txt': 'o\n', 'dir/c.txt': 'c\n' });
    write(ws, 'a.txt', 'A\n');
    write(ws, 'b.txt', 'B\n');
    git(ws, 'add', 'b.txt');
    git(ws, 'mv', 'old name.txt', 'renamed.txt');
    write(ws, 'dir/new.txt', 'n\n');
    const g = await probeGitState(ws);
    repo(g);
    expect(g.dirty.modified).toBe(1);
    expect(g.dirty.staged).toBe(2); // b.txt (M.) and the rename (R.)
    expect(g.dirty.renamed).toBe(1);
    expect(g.dirty.untracked).toBe(1);
    expect(g.dirty.unmerged).toBe(0);
    const byPath = new Map(g.dirty.entries.map((e) => [e.path, e]));
    expect(byPath.get('a.txt')?.xy).toBe('.M');
    expect(byPath.get('b.txt')?.xy).toBe('M.');
    expect(byPath.get('renamed.txt')).toMatchObject({ xy: 'R.', from: 'old name.txt' });
    expect(byPath.get('dir/new.txt')?.xy).toBe('??');
  });

  it('subdirectory workspace: prefix `sub/`, gitDir above the workspace, entries still top-level relative', async () => {
    const base = tmp();
    const root = join(base, 'repo');
    initMain(root, { 'sub/a.txt': 'a\n', 'top.txt': 't\n' });
    write(root, 'sub/a.txt', 'A\n');
    write(root, 'top.txt', 'T\n');
    const g = await probeGitState(join(root, 'sub'));
    repo(g);
    expect(g.prefix).toBe('sub/');
    expect(g.gitDir).toBe(join(root, '.git'));
    expect(g.topLevel).toBe(root);
    expect(g.linkedWorktree).toBe(false);
    expect(g.dirty.entries.map((e) => e.path).sort()).toEqual(['sub/a.txt', 'top.txt']);
  });

  it('linked worktree: gitDir under the main checkout, commonDir = the main .git, its own branch', async () => {
    const base = tmp();
    const main = join(base, 'main');
    initMain(main, { 'a.txt': 'a\n' });
    git(main, 'worktree', 'add', '-q', join(base, 'wt'), '-b', 'wtbranch');
    const g = await probeGitState(join(base, 'wt'));
    repo(g);
    expect(g.linkedWorktree).toBe(true);
    expect(g.gitDir).toBe(join(main, '.git', 'worktrees', 'wt'));
    expect(g.commonDir).toBe(join(main, '.git'));
    expect(g.topLevel).toBe(join(base, 'wt'));
    expect(g.head).toMatchObject({ kind: 'branch', name: 'wtbranch' });
  });

  it('detached HEAD', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const oid = git(ws, 'rev-parse', 'HEAD').trim();
    git(ws, 'checkout', '-q', '--detach');
    const g = await probeGitState(ws);
    repo(g);
    expect(g.head).toEqual({ kind: 'detached', oid });
  });

  it('unborn branch after `git init`: head unborn, the untracked file counted', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    mkdirSync(ws);
    git(ws, 'init', '-q', '-b', 'main', '.');
    write(ws, 'new.txt', 'n\n');
    const g = await probeGitState(ws);
    repo(g);
    expect(g.head).toEqual({ kind: 'unborn', name: 'main' });
    expect(g.dirty.untracked).toBe(1);
  });

  it('bare repository → repo: false, reason bare', async () => {
    const base = tmp();
    const main = join(base, 'main');
    initMain(main, { 'a.txt': 'a\n' });
    git(base, 'clone', '-q', '--bare', main, join(base, 'bare.git'));
    const g = await probeGitState(join(base, 'bare.git'));
    expect(g.repo).toBe(false);
    expect(g.reason).toBe('bare');
    expect(g.gitDir).toBeNull();
    expect(g.head).toBeNull();
  });

  it('a plain directory → not-a-repo; a missing root → not-a-repo with zero spawns', async () => {
    const base = tmp();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'x.txt'), 'x');
    const g = await probeGitState(plain);
    expect(g).toMatchObject({ repo: false, reason: 'not-a-repo', gitDir: null, commonDir: null, topLevel: null, prefix: '', head: null });
    const c = counting();
    const missing = await probeGitState(join(base, 'nope'), { execFile: c.impl });
    expect(missing.reason).toBe('not-a-repo');
    expect(c.calls.length).toBe(0);
    const file = await probeGitState(join(plain, 'x.txt'), { execFile: c.impl });
    expect(file.reason).toBe('not-a-repo');
    expect(c.calls.length).toBe(0);
  });

  it('PATH without git → git-missing (real spawn failure through an empty PATH)', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const emptyBin = join(base, 'emptybin');
    mkdirSync(emptyBin);
    const savedPath = process.env['PATH'];
    process.env['PATH'] = emptyBin;
    try {
      const g = await probeGitState(ws);
      expect(g.repo).toBe(false);
      expect(g.reason).toBe('git-missing');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  });
});

describe('probeGitState: spawn accounting and classification (§12.1, A140)', () => {
  it('exactly two execFile calls with the fixed vectors, the neutralising -c flags first, cwd = root', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const c = counting();
    const g = await probeGitState(ws, { execFile: c.impl });
    repo(g);
    expect(c.calls.length).toBe(2);
    const vectors = c.calls.map((k) => k.args);
    expect(vectors).toContainEqual([...GIT_BASE_FLAGS, ...GIT_PROBE_ARGS.revParse]);
    expect(vectors).toContainEqual([...GIT_BASE_FLAGS, ...GIT_PROBE_ARGS.status]);
    expect(probeArgv('revParse')).toEqual([...GIT_BASE_FLAGS, ...GIT_PROBE_ARGS.revParse]);
    for (const k of c.calls) {
      expect(k.args.slice(0, GIT_BASE_FLAGS.length)).toEqual([...GIT_BASE_FLAGS]);
      expect(k.opts.cwd).toBe(ws);
      expect(k.opts.timeout).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    }
  });

  it('the child env is GIT_ENV plus PATH — no key of the harness environment reaches git', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    // a dedicated marker variable (fix-pass finding 11): never a real key name, and the previous value is restored
    const saved = process.env['JEV_PROBE_LEAK'];
    process.env['JEV_PROBE_LEAK'] = 'jev-probe-leak-marker-' + 'c'.repeat(40);
    try {
      const c = counting();
      await probeGitState(ws, { execFile: c.impl });
      expect(c.calls.length).toBe(2);
      for (const k of c.calls) {
        const env = k.opts.env ?? {};
        expect(Object.keys(env).sort()).toEqual(['PATH', ...Object.keys(GIT_ENV)].sort());
        for (const [key, v] of Object.entries(GIT_ENV)) expect(env[key]).toBe(v);
        expect(JSON.stringify(env)).not.toContain('jev-probe-leak-marker');
        expect(env['JEV_PROBE_LEAK']).toBeUndefined();
      }
      // the pure builder: only PATH survives, whatever else the environment holds
      expect(Object.keys(probeEnv({ PATH: '/bin', OPENROUTER_API_KEY: 'x', JEV_PROBE_LEAK: 'y' })).sort()).toEqual(['PATH', ...Object.keys(GIT_ENV)].sort());
      expect(JSON.stringify(probeEnv({ PATH: '/bin', OPENROUTER_API_KEY: 'sk-or-v1-secret' }))).not.toContain('secret');
      expect(Object.keys(probeEnv({}))).toEqual(Object.keys(GIT_ENV));
    } finally {
      if (saved === undefined) delete process.env['JEV_PROBE_LEAK'];
      else process.env['JEV_PROBE_LEAK'] = saved;
    }
  });

  it('ENOENT from spawn → git-missing; the status spawn still happened (two calls, concurrent)', async () => {
    const base = tmp();
    const s = scripted((_args, cb) => cb(errno('ENOENT'), '', ''));
    const g = await probeGitState(base, { execFile: s.impl });
    expect(g).toMatchObject({ repo: false, reason: 'git-missing' });
    expect(s.calls.length).toBe(2);
  });

  it('a killed spawn (timeout) → reason timeout, whichever of the two it was; a killed status keeps the rev-parse facts', async () => {
    const base = tmp();
    const killed = (): ExecFileException => {
      const e = new Error('killed') as ExecFileException;
      e.killed = true;
      e.signal = 'SIGKILL';
      e.code = null;
      return e;
    };
    const revOk = `true\n\n${base}/.git\n${base}/.git\n${base}\n`;
    const slowStatus = scripted((args, cb) => (args.includes('status') ? cb(killed(), '', '') : cb(null, revOk, '')));
    const g1 = await probeGitState(base, { execFile: slowStatus.impl, timeoutMs: 50 });
    // fix-pass finding 3: the dirty snapshot is unknown (repo: false) but the seatbelt still learns the git dirs
    expect(g1).toMatchObject({ repo: false, reason: 'timeout', gitDir: `${base}/.git`, commonDir: `${base}/.git`, topLevel: base, prefix: '', linkedWorktree: false, head: null });
    expect(g1.dirty.entries).toEqual([]);
    expect(slowStatus.calls[0]?.opts.timeout).toBe(50);
    // a killed rev-parse has no facts to keep
    const slowRev = scripted((args, cb) => (args.includes('status') ? cb(null, '# branch.oid (initial)\u0000# branch.head main\u0000', '') : cb(killed(), '', '')));
    const g2 = await probeGitState(base, { execFile: slowRev.impl });
    expect(g2).toMatchObject({ repo: false, reason: 'timeout', gitDir: null, commonDir: null });
    // a non-positive or non-finite timeout falls back to the default
    const d = scripted((_args, cb) => cb(errno('ENOENT'), '', ''));
    await probeGitState(base, { execFile: d.impl, timeoutMs: -1 });
    expect(d.calls[0]?.opts.timeout).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('exit 128 with `not a git repository` → not-a-repo; garbage stdout → not-a-repo', async () => {
    const base = tmp();
    const exit128 = (): ExecFileException => {
      const e = new Error('exit 128') as ExecFileException;
      e.code = 128;
      return e;
    };
    const s = scripted((_args, cb) => cb(exit128(), '', 'fatal: not a git repository (or any of the parent directories): .git\n'));
    expect((await probeGitState(base, { execFile: s.impl })).reason).toBe('not-a-repo');
    const garbage = scripted((_args, cb) => cb(null, 'lorem ipsum\n', ''));
    expect((await probeGitState(base, { execFile: garbage.impl })).reason).toBe('not-a-repo');
  });

  it('a bare repository exits 128 after four lines and is still recognised as bare from stdout', async () => {
    const base = tmp();
    const exit128 = (): ExecFileException => {
      const e = new Error('exit 128') as ExecFileException;
      e.code = 128;
      return e;
    };
    const s = scripted((args, cb) => (args.includes('status') ? cb(exit128(), '', 'fatal: this operation must be run in a work tree\n') : cb(exit128(), `false\n\n${base}\n.\n`, 'fatal: this operation must be run in a work tree\n')));
    expect((await probeGitState(base, { execFile: s.impl })).reason).toBe('bare');
  });

  // fix-pass finding 2: the mixed case fails CLOSED — never `repo: true` with an empty dirty set
  it('rev-parse ok but status exit 128 / MAXBUFFER / torn → dirty snapshot unknown: repo false, facts kept, no head', async () => {
    const base = tmp();
    const revOk = `true\n\n${base}/.git\n${base}/.git\n${base}\n`;
    const exit128 = (): ExecFileException => {
      const e = new Error('exit 128') as ExecFileException;
      e.code = 128;
      return e;
    };
    const s = scripted((args, cb) => (args.includes('status') ? cb(exit128(), '', 'fatal: index corrupt\n') : cb(null, revOk, '')));
    const g = await probeGitState(base, { execFile: s.impl });
    expect(g.repo).toBe(false);
    expect(g.reason).toBe('timeout');
    expect(g).toMatchObject({ gitDir: `${base}/.git`, commonDir: `${base}/.git`, topLevel: base, head: null, upstream: null, ahead: null, behind: null });
    expect(g.dirty).toEqual({ modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] });
    expect(toRunGitMeta(g)).toMatchObject({ repo: false, reason: 'timeout', head: null });
    // §3.7 G6: one clause, and `git none` becomes `git`
    expect(gitBannerLine(bannerInput(g)).text).toBe('git · git status failed or timed out — /diff <step> compares pre-images');

    // Node reports the stdout cap with a string code and `killed` undefined; the partial listing must not read as the whole
    const overflow = (): ExecFileException => {
      const e = new Error('stdout maxBuffer length exceeded') as ExecFileException;
      e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      return e;
    };
    const partial = '# branch.oid (initial)\u0000# branch.head main\u0000? a.txt\u0000? b.txt\u0000';
    const big = scripted((args, cb) => (args.includes('status') ? cb(overflow(), partial, '') : cb(null, revOk, '')));
    const g2 = await probeGitState(base, { execFile: big.impl });
    expect(g2).toMatchObject({ repo: false, reason: 'timeout', gitDir: `${base}/.git` });
    expect(g2.dirty.entries).toEqual([]);
    expect(g2.dirty.untracked).toBe(0);
    // git-missing classification is untouched by the new class: ENOENT on rev-parse still reads as git-missing
    const missing = scripted((args, cb) => (args.includes('status') ? cb(overflow(), partial, '') : cb(errno('ENOENT'), '', '')));
    expect((await probeGitState(base, { execFile: missing.impl })).reason).toBe('git-missing');

    // a torn listing (no NUL terminator: the tail entry is incomplete) is an unknown snapshot too
    const torn = scripted((args, cb) => (args.includes('status') ? cb(null, '# branch.oid (initial)\u0000# branch.head main\u0000? a.txt\u0000? b.t', '') : cb(null, revOk, '')));
    const g3 = await probeGitState(base, { execFile: torn.impl });
    expect(g3).toMatchObject({ repo: false, reason: 'timeout', gitDir: `${base}/.git` });
    expect(g3.dirty.entries).toEqual([]);
  });

  it('a real listing beyond maxBuffer (shrunk for the test) is an unknown snapshot through execFile\'s own cap', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    // ≈ 60 × 40 bytes of `? <name>\0` entries: far beyond a 1 KiB cap; the five rev-parse lines (< 1 KiB) still fit
    for (let i = 0; i < 60; i++) write(ws, `untracked-file-with-a-long-name-${String(i).padStart(3, '0')}.txt`, 'x\n');
    const c = counting();
    const g = await probeGitState(ws, { execFile: c.impl, maxBuffer: 1024 });
    expect(c.calls.length).toBe(2);
    expect(c.calls[0]?.opts.maxBuffer).toBe(1024);
    expect(g.repo).toBe(false);
    expect(g.reason).toBe('timeout');
    expect(g.gitDir).toBe(join(ws, '.git'));
    expect(g.dirty.untracked).toBe(0);
    expect(g.dirty.entries).toEqual([]);
    // the default cap is generous and the same tree probes fine under it
    const full = await probeGitState(ws);
    repo(full);
    expect(full.dirty.untracked).toBe(60);
    expect(PROBE_MAX_BUFFER).toBe(16 * 1024 * 1024);
    // a non-positive cap falls back to the default
    const d = scripted((_args, cb) => cb(errno('ENOENT'), '', ''));
    await probeGitState(base, { execFile: d.impl, maxBuffer: 0 });
    expect(d.calls[0]?.opts.maxBuffer).toBe(PROBE_MAX_BUFFER);
  });

  it('a synchronously throwing execFile is classified as git-missing, never rejects', async () => {
    const base = tmp();
    const impl = ((): ChildProcess => {
      throw new Error('boom');
    }) as unknown as typeof execFile;
    const g = await probeGitState(base, { execFile: impl });
    expect(g.reason).toBe('git-missing');
  });
});

describe('probeGitState: canonical root (§12.1, fix-pass finding 6)', () => {
  it('a symlinked root: gitDir and commonDir agree, linkedWorktree false, topLevel and cwd are the realpath', async () => {
    const base = tmp();
    const real = join(base, 'real');
    initMain(real, { 'a.txt': 'a\n' });
    write(real, 'a.txt', 'A\n');
    const link = join(base, 'link');
    symlinkSync(real, link);
    const c = counting();
    const g = await probeGitState(link, { execFile: c.impl });
    repo(g);
    expect(g.gitDir).toBe(join(real, '.git'));
    expect(g.commonDir).toBe(g.gitDir);
    expect(g.linkedWorktree).toBe(false);
    expect(g.topLevel).toBe(real);
    expect(g.prefix).toBe('');
    expect(g.dirty.entries.map((e) => e.path)).toEqual(['a.txt']);
    for (const k of c.calls) expect(k.opts.cwd).toBe(real);
    // a symlinked subdirectory root keeps its prefix
    const subLink = join(base, 'sub-link');
    mkdirSync(join(real, 'sub'));
    write(real, 'sub/s.txt', 's\n');
    symlinkSync(join(real, 'sub'), subLink);
    const sub = await probeGitState(subLink);
    repo(sub);
    expect(sub.prefix).toBe('sub/');
    expect(sub.linkedWorktree).toBe(false);
    expect(sub.commonDir).toBe(join(real, '.git'));
  });

  it('a root under a symlinked temp dir (macOS /tmp → /private/tmp) is a main tree, not a linked worktree', async () => {
    const raw = mkdtempSync(join('/tmp', 'jev-symroot-'));
    temps.push(realpathSync(raw));
    const ws = join(raw, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const g = await probeGitState(ws);
    repo(g);
    expect(g.commonDir).toBe(g.gitDir);
    expect(g.linkedWorktree).toBe(false);
    expect(g.gitDir).toBe(join(realpathSync(raw), 'ws', '.git'));
    expect(g.topLevel).toBe(join(realpathSync(raw), 'ws'));
    // a real linked worktree under the same symlinked prefix is still recognised as one
    git(ws, 'worktree', 'add', '-q', join(raw, 'wt'), '-b', 'wtb');
    const wt = await probeGitState(join(raw, 'wt'));
    repo(wt);
    expect(wt.linkedWorktree).toBe(true);
    expect(wt.commonDir).toBe(g.gitDir);
    expect(wt.gitDir).toBe(join(g.gitDir, 'worktrees', 'wt'));
  });
});

describe('probeGitState: a real slow git (§19.0 "timeout" shape, execFile timeout + killSignal end to end)', () => {
  /** A `git` shim on PATH that sleeps on `status` (or on everything) and otherwise defers to the real git. */
  function shim(dir: string, slowOn: 'status' | 'all'): string {
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const pattern = slowOn === 'all' ? '*' : '*" status "*';
    // `sleep` gets /dev/null so the killed shell is the only holder of the pipe and execFile settles at the kill
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  ${pattern}) /bin/sleep 5 >/dev/null 2>&1 ;;\nesac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    return bin;
  }
  async function withPath(bin: string, run: () => Promise<GitState>): Promise<GitState> {
    const savedPath = process.env['PATH'];
    process.env['PATH'] = bin;
    try {
      return await run();
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  }

  it('status slower than timeoutMs is killed: reason timeout, facts kept, the probe returns near the timeout', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    write(ws, 'a.txt', 'A\n');
    const c = counting();
    const t0 = performance.now();
    const g = await withPath(shim(base, 'status'), () => probeGitState(ws, { execFile: c.impl, timeoutMs: 300 }));
    const elapsed = performance.now() - t0;
    expect(c.calls.length).toBe(2);
    expect(c.calls[0]?.opts.killSignal).toBe('SIGKILL');
    expect(g.repo).toBe(false);
    expect(g.reason).toBe('timeout');
    expect(g.gitDir).toBe(join(ws, '.git'));
    expect(g.commonDir).toBe(join(ws, '.git'));
    expect(g.topLevel).toBe(ws);
    expect(g.head).toBeNull();
    expect(g.dirty.entries).toEqual([]);
    expect(elapsed).toBeLessThan(4_000);
    expect(g.probeMs).toBeGreaterThanOrEqual(250);
  });

  it('everything slow: reason timeout without facts; the same tree probes fine with the real git', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const g = await withPath(shim(base, 'all'), () => probeGitState(ws, { timeoutMs: 300 }));
    expect(g).toMatchObject({ repo: false, reason: 'timeout', gitDir: null, commonDir: null, head: null });
    const ok = await probeGitState(ws);
    repo(ok);
    expect(ok.head).toMatchObject({ kind: 'branch', name: 'main' });
  });
});
