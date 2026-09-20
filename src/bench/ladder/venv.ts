/**
 * The interpreter that runs a Ladder task's pytest suite. pytest is not guaranteed on the
 * machine, so a shared venv `<runsDir>/ladder-venv` is created once per bench through the
 * sandbox (same pattern as the Terminal-Bench verifier venv in ../terminalbench/shim.ts) and
 * reused while its marker matches. When the venv cannot be built (no network) but the system
 * python3 already imports pytest, that interpreter is used instead, with a log line, so an
 * offline mocked bench still evaluates for real.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxError } from '../../errors.js';
import { shellQuote } from '../swebench/evaluator.js';
import type { CommandRunner } from '../types.js';

export const LADDER_VENV_DIR = 'ladder-venv';
/** pytest 8 is the last line that supports Python 3.9 (the interpreter on the reference machine). */
export const LADDER_PACKAGES: readonly string[] = ['pytest==8.4.2'];
const VENV_MARKER = '.jevcode-packages.json';
const VENV_TIMEOUT_MS = 10 * 60_000;

type MakeRunner = (root: string) => CommandRunner;

let venvLock: Promise<void> = Promise.resolve();
const resolved = new Map<string, Promise<string>>();

export function venvPython(runsDir: string): string {
  return join(runsDir, LADDER_VENV_DIR, 'bin', 'python');
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** `<runsDir>/ladder-venv` with the pinned packages; created once (in-process lock), reused when the marker matches. */
export async function ensureLadderVenv(runsDir: string, makeRunner: MakeRunner, log: (line: string) => void, timeoutMs = VENV_TIMEOUT_MS): Promise<string> {
  const dir = join(runsDir, LADDER_VENV_DIR);
  const prev = venvLock;
  const next = prev.then(async () => {
    const want = JSON.stringify([...LADDER_PACKAGES].sort());
    const have = await readFile(join(dir, VENV_MARKER), 'utf8').catch(() => null);
    if (have === want && (await isFile(join(dir, 'bin', 'python')))) return;
    await mkdir(dir, { recursive: true });
    const run = makeRunner(dir);
    log(`[ladder] creating pytest venv at ${dir}`);
    const q = shellQuote(dir);
    const res = await run(`python3 -m venv ${q} && ${q}/bin/python -m pip install -q ${LADDER_PACKAGES.map(shellQuote).join(' ')}`, { timeoutMs, maxOutputBytes: 64 * 1024 });
    if (!res.ok) throw new SandboxError(`ladder venv creation failed: ${(res.stderr || res.stdout).slice(-600)}`);
    await writeFile(join(dir, VENV_MARKER), want, 'utf8');
  });
  venvLock = next.catch(() => undefined);
  await next;
  return join(dir, 'bin', 'python');
}

/** `python3` when it imports pytest, else null. `run` may be any sandbox runner. */
export async function systemPytestPython(run: CommandRunner): Promise<string | null> {
  const res = await run('python3 -c "import pytest, sys; sys.stdout.write(pytest.__version__)"', { timeoutMs: 60_000, maxOutputBytes: 4096 });
  return res.ok ? 'python3' : null;
}

/**
 * The interpreter to run pytest with: the shared venv, or the system python3 when the venv
 * cannot be created and pytest is importable there. Resolved once per runsDir per process.
 * Call it before any other command of the same pair (the loader does so in setup): the venv
 * sandbox shares the pair's run dir, whose single sandbox.sb it overwrites on creation.
 */
export function resolveLadderPython(runsDir: string, makeRunner: MakeRunner, probe: CommandRunner, log: (line: string) => void): Promise<string> {
  let p = resolved.get(runsDir);
  if (!p) {
    p = (async () => {
      try {
        return await ensureLadderVenv(runsDir, makeRunner, log);
      } catch (e) {
        const fallback = await systemPytestPython(probe);
        if (fallback === null) throw e;
        log(`[ladder] venv unavailable (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); using the system python3 with its pytest`);
        return fallback;
      }
    })();
    resolved.set(runsDir, p);
    p.catch(() => resolved.delete(runsDir));
  }
  return p;
}

/** tests only */
export function resetLadderPythonCache(): void {
  resolved.clear();
}
