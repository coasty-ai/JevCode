/**
 * Shared fixtures for the orchestrate unit tests.
 *
 * `realRunGit` is the production `RunGit` seam bound to a plain spawn instead of a sandbox: the
 * modules under test are exercised against a REAL temp repository (that is the point of the seam),
 * with the same neutralising flags `workspace/git.ts` passes, so a hook or a global config on the
 * developer's machine can never reach these tests. No network, no keys, no sandbox profile.
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

/** A `RunGit` over a real git binary, recording every call it made. */
export function makeRunGit(calls: { cwd: string; args: readonly string[] }[] = []): RunGit {
  return async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    const r = spawnSync('git', [...GIT_BASE_FLAGS, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd, ...GIT_ENV },
      maxBuffer: 32 * 1024 * 1024,
    });
    return execResult(r.status, r.stdout ?? '', r.stderr ?? '', r.signal ?? null);
  };
}

/** Test-only fixture git (writes commits with a fixed identity); production git goes through the seam. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
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
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
  const calls: { cwd: string; args: readonly string[] }[] = [];
  return { base, ws, runDir, runGit: makeRunGit(calls), calls, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function headSha(ws: string): string {
  return git(ws, 'rev-parse', 'HEAD').trim();
}
