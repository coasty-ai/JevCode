import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { SbflRunFn } from '../../../../src/synth/sbfl/run.js';

export const PYTHON = process.env['SBFL_TEST_PYTHON'] ?? 'python3';
export const FIXTURES = fileURLToPath(new URL('../../../fixtures/synth/sbfl/', import.meta.url));
export const TRACER = fileURLToPath(new URL('../../../../src/synth/sbfl/trace_lines.py', import.meta.url));

function probe(code: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const r = spawnSync(PYTHON, ['-c', code], { env, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}

/** python3 >= 3.9 on PATH (the tracer's floor). */
export const havePython = probe('import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)');
/** pytest importable by that interpreter (the real-pytest path of the tracer). */
export const havePytest = havePython && probe('import pytest');

export interface Spawned {
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
}

function collect(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const spawnOpts: { cwd?: string; env: NodeJS.ProcessEnv } = { env: opts.env ?? process.env };
    if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
    const child = spawn(command, args, spawnOpts);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, durationMs: Date.now() - started });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Run trace_lines.py directly with a spec on stdin. */
export function runTracer(spec: unknown, env: Record<string, string> = {}): Promise<Spawned> {
  return collect(PYTHON, [TRACER], { stdin: JSON.stringify(spec), env: { ...process.env, ...env }, timeoutMs: 60_000 });
}

/** A runSbfl runner backed by node:child_process (production uses the engine's Sandbox). */
export function childProcessRunner(env: Record<string, string> = {}): SbflRunFn {
  return async (command, o) => {
    const r = await collect('/bin/sh', ['-c', command], {
      ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
      env: { ...process.env, ...env },
      timeoutMs: o.timeoutMs,
    });
    return { stdout: r.stdout.slice(0, o.maxOutputBytes), stderr: r.stderr, exitCode: r.code };
  };
}

/** Parse the tracer's stdout lines as unknown JSON values (validation is the code under test). */
export function jsonLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l): unknown => JSON.parse(l));
}
