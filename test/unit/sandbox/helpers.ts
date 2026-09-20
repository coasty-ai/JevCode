import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Sandbox, SandboxProfile } from '../../../src/core/types.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import type { SandboxInternals } from '../../../src/sandbox/run.js';

export interface TempSandbox {
  ws: string;
  runDir: string;
  sandbox: Sandbox;
  cleanup: () => void;
}

/** Short kill grace keeps the suite fast; real processes die on SIGTERM anyway. */
export const FAST_KILL: SandboxInternals = { killTreeOptions: { graceMs: 300, pollMs: 25 }, ttyPath: null };

export function makeTemp(prefix = 'jev-'): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeSandbox(opts: { profile?: SandboxProfile; noNetwork?: boolean; secretReadDenies?: string[]; internals?: SandboxInternals } = {}): TempSandbox {
  const base = makeTemp();
  const ws = join(base.dir, 'ws');
  const runDir = join(base.dir, 'run');
  mkdirSync(ws, { recursive: true });
  const sandbox = createSandbox(
    {
      workspaceRoot: ws,
      runDir,
      profile: opts.profile ?? 'none',
      noNetwork: opts.noNetwork ?? false,
      secretReadDenies: opts.secretReadDenies ?? [],
      redact: (s) => s,
    },
    opts.internals ?? FAST_KILL,
  );
  return { ws, runDir, sandbox, cleanup: base.cleanup };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const never = (): AbortSignal => new AbortController().signal;
