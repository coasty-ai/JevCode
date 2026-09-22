/** Shared setup for the warm-plane tests: a real sandbox over a temp run dir, and a lane in it. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox, SandboxProfile } from '../../../../src/core/types.js';
import type { Lane } from '../../../../src/synth/search/types.js';
import { createSandbox } from '../../../../src/sandbox/run.js';
import { detectSandboxLevel } from '../../../../src/sandbox/seatbelt.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../../..');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');
export const LADDER_DIR = join(REPO_ROOT, 'bench/data/ladder/tasks');

export const havePython = spawnSync('python3', ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
export const havePytest = havePython && spawnSync('python3', ['-c', 'import pytest'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

/**
 * The sandbox scrubs the environment down to PATH/LANG/LC_ALL/TERM and remaps HOME, so a
 * `pip install --user` pytest is not importable inside it. A real workspace carries a `.venv`
 * (which `src/sandbox/run.ts` puts on PATH) or a system pytest; here the site directory is handed
 * to both paths through PYTHONPATH so warm and cold are compared under the same environment.
 */
const userSite = havePytest ? (spawnSync('python3', ['-c', 'import os, pytest; print(os.path.dirname(os.path.dirname(pytest.__file__)))'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '').trim() : '';
export const PY_ENV: Readonly<Record<string, string>> = userSite === '' ? { PYTHONDONTWRITEBYTECODE: '1' } : { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: userSite };
export const haveRunner = existsSync(join(QUIXBUGS_DIR, 'run_tests.py'));
/** Is the real seatbelt available here? The warm worker's extra demands over a cold run — mkfifo,
 * fork, setsid, a long-lived process — are all profile-visible, so at least one case runs under it. */
export const haveSeatbelt = detectSandboxLevel('seatbelt') === 'seatbelt';

export interface WarmFixture {
  ws: string;
  runDir: string;
  lane: Lane;
  sandbox: Sandbox;
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * A real sandbox with one lane directory under `<runDir>/tmp/synth/`. Profile `none` by default,
 * because most cases here are about the protocol and the verdicts rather than about confinement
 * — but the warm worker asks the profile for things a cold run never does (mkfifo, fork, setsid,
 * a process that outlives one command), so `worker.test.ts` runs one case under the real
 * seatbelt.
 */
export function warmFixture(prefix = 'jev-warm-', profile: SandboxProfile = 'none'): WarmFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const ws = join(base, 'ws');
  const runDir = join(base, 'run');
  const laneDir = join(runDir, 'tmp/synth/lane0');
  mkdirSync(ws, { recursive: true });
  mkdirSync(laneDir, { recursive: true });
  const sandbox = createSandbox({ workspaceRoot: ws, runDir, profile, noNetwork: false, secretReadDenies: [], redact: (s) => s }, { killTreeOptions: { graceMs: 300, pollMs: 25 }, ttyPath: null });
  return {
    ws,
    runDir,
    lane: { index: 0, dir: laneDir, mode: 'candidate_file', busy: false },
    sandbox,
    signal: new AbortController().signal,
    cleanup: () => {
      void sandbox.killAll();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
