/**
 * Shared fixtures for the orchestrate unit tests.
 *
 * `realRunGit` is the production `RunGit` seam bound to a plain spawn instead of a sandbox: the
 * modules under test are exercised against a REAL temp repository (that is the point of the seam),
 * with the same neutralising flags `workspace/git.ts` passes, so a hook or a global config on the
 * developer's machine can never reach these tests. No network, no keys, no sandbox profile.
 *
 * Hermetic against the machine that runs them, because CI is not this laptop: a GitHub runner has no
 * git identity (and a hostname git cannot derive an email from), a case-sensitive volume on which
 * `git init` never writes `core.ignorecase`, and possibly `init.defaultBranch=master`. So every git
 * this file spawns gets an empty HOME of its own, no system or global config, a fixed identity, the
 * `main` branch, and a repository whose `core.ignorecase` is always written down.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GIT_BASE_FLAGS, GIT_ENV } from '../../../src/workspace/git.js';
import type { ExecResult } from '../../../src/core/types.js';
import type { RunGit } from '../../../src/orchestrate/types.js';

export interface TempRepo {
  base: string;
  ws: string;
  runDir: string;
  runGit: RunGit;
  calls: { cwd: string; args: readonly string[] }[];
  cleanup: () => void;
}

function execResult(status: number | null, stdout: string, stderr: string, signal: string | null): ExecResult {
  return {
    ok: status === 0,
    exitCode: status,
    signal,
    stdout,
    stderr,
    truncated: false,
    bytesSeen: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
    killedBy: null,
    timedOut: false,
    orphans: [],
    sandboxExecDenied: false,
    durationMs: 0,
  };
}

/** The fixed identity every commit made here is written under (the runner has none, and must not need one). */
const FIXTURE_IDENTITY: readonly string[] = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

let hermeticHome: string | null = null;
/** One empty HOME per test worker, removed when the worker exits: no `~/.gitconfig`, no XDG config, nothing. */
function emptyHome(): string {
  if (hermeticHome === null) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'jev-orch-home-')));
    process.once('exit', () => rmSync(home, { recursive: true, force: true }));
    hermeticHome = home;
  }
  return hermeticHome;
}

/** The environment of every git spawned here: the production `GIT_ENV` over PATH and an empty HOME, and nothing else. */
function hermeticEnv(): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: emptyHome(), ...GIT_ENV };
}

/**
 * A `RunGit` over a real git binary, recording every call it made. The fixture identity goes on the command
 * line BEFORE the caller's arguments, so a caller that names its own (`commitStep`'s `-c user.name=…`) still
 * wins — last `-c` wins — and a merge or rebase that commits without one does not depend on the runner.
 */
export function makeRunGit(calls: { cwd: string; args: readonly string[] }[] = []): RunGit {
  return async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    const r = spawnSync('git', [...GIT_BASE_FLAGS, ...FIXTURE_IDENTITY, ...args], {
      cwd,
      encoding: 'utf8',
      env: hermeticEnv(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return execResult(r.status, r.stdout ?? '', r.stderr ?? '', r.signal ?? null);
  };
}

/** Test-only fixture git (writes commits with a fixed identity); production git goes through the seam. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...FIXTURE_IDENTITY, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: hermeticEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * `git init` writes `core.ignorecase = true` after probing a case-folding volume (APFS, NTFS) and writes NOTHING on
 * a case-sensitive one (ext4, the CI runner), where `git config core.ignorecase` then exits 1. Write the unset
 * case down as git's own default, `false`, so the key always exists and still says what git decided at init.
 */
function pinIgnoreCase(ws: string): void {
  const r = spawnSync('git', ['config', '--local', '--get', 'core.ignorecase'], { cwd: ws, encoding: 'utf8', env: hermeticEnv() });
  if (r.status === 0) return;
  if (r.status !== 1) throw new Error(`git config --get core.ignorecase failed: ${r.stderr}`);
  git(ws, 'config', '--local', 'core.ignorecase', 'false');
}

export function write(root: string, rel: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A temp directory holding `ws/` (an initialised repo with `files`) and `run/`. */
export function tempRepo(files: Record<string, string> = { 'README.md': 'x\n' }): TempRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jev-orch-')));
  const ws = join(base, 'ws');
  const runDir = join(base, 'run');
  mkdirSync(ws, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main', '.');
  pinIgnoreCase(ws);
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
  const calls: { cwd: string; args: readonly string[] }[] = [];
  return { base, ws, runDir, runGit: makeRunGit(calls), calls, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function headSha(ws: string): string {
  return git(ws, 'rev-parse', 'HEAD').trim();
}
