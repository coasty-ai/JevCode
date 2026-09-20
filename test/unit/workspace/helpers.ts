import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Sandbox, Workspace } from '../../../src/core/types.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { createWorkspace } from '../../../src/workspace/files.js';
import type { WorkspaceDeps } from '../../../src/workspace/files.js';

export const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'workspace');

export interface TempWs {
  base: string;
  ws: string;
  runDir: string;
  sandbox: Sandbox;
  cleanup: () => void;
}

export function tempWs(prefix = 'jev-ws-'): TempWs {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const ws = join(base, 'ws');
  const runDir = join(base, 'run');
  mkdirSync(ws, { recursive: true });
  const sandbox = createSandbox(
    { workspaceRoot: ws, runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s },
    { killTreeOptions: { graceMs: 300, pollMs: 25 }, ttyPath: null },
  );
  return { base, ws, runDir, sandbox, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Test-only fixture setup; production git goes through workspace/git.ts. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function initRepo(ws: string, files: Record<string, string>): void {
  git(ws, 'init', '-q', '.');
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
}

export async function makeWorkspace(t: TempWs, deps: Partial<WorkspaceDeps> = {}): Promise<Workspace> {
  return createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (s) => s, ...deps });
}
