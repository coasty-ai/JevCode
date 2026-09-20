import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AbortError, BudgetError, SandboxError } from '../../../src/errors.js';
import { parseTestOutput } from '../../../src/workspace/tests.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { FAST_KILL, makeSandbox, never, pidAlive } from './helpers.js';
import type { TempSandbox } from './helpers.js';

function makeSandboxWithRedact(t: TempSandbox, redact: (s: string) => string): ReturnType<typeof createSandbox> {
  return createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact }, FAST_KILL);
}

const CAP = 50_000;
let temps: TempSandbox[] = [];
function sb(): TempSandbox {
  const t = makeSandbox();
  temps.push(t);
  return t;
}
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

describe('sandbox.run basics', () => {
  it('runs a command in the workspace and reports ok', async () => {
    const t = sb();
    const r = await t.sandbox.run('pwd; echo err >&2; exit 0', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(t.ws);
    expect(r.stderr.trim()).toBe('err');
    expect(r.killedBy).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.orphans).toEqual([]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.sandbox.level).toBe('none');
  });

  it('non-zero exit is ok=false but resolved', async () => {
    const t = sb();
    const r = await t.sandbox.run('exit 3', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.killedBy).toBeNull();
  });

  it('scrubs the environment: only the allowlist plus TMPDIR/HOME reach the child', async () => {
    const t = sb();
    const key = 'sk-or-v1-' + 'a'.repeat(40);
    process.env['OPENROUTER_API_KEY'] = key;
    process.env['JEV_TEST_LEAK'] = 'leak';
    try {
      const r = await t.sandbox.run('env', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
      expect(r.stdout).not.toContain('OPENROUTER_API_KEY');
      expect(r.stdout).not.toContain(key);
      expect(r.stdout).not.toContain('JEV_TEST_LEAK');
      expect(r.stdout).toMatch(new RegExp(`^TMPDIR=${t.runDir}/tmp$`, 'm'));
      expect(r.stdout).toMatch(new RegExp(`^HOME=${t.runDir}/home$`, 'm'));
      expect(r.stdout).toMatch(/^PATH=/m);
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
      delete process.env['JEV_TEST_LEAK'];
    }
  });

  it('merges opts.env over the allowlist and rejects a cwd outside the workspace', async () => {
    const t = sb();
    const r = await t.sandbox.run('echo "$FOO"', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never(), env: { FOO: 'bar' } });
    expect(r.stdout.trim()).toBe('bar');
    await expect(t.sandbox.run('pwd', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never(), cwd: '/' })).rejects.toBeInstanceOf(SandboxError);
    const inRun = await t.sandbox.run('pwd', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never(), cwd: `${t.runDir}/tmp` });
    expect(inRun.stdout.trim()).toBe(`${t.runDir}/tmp`);
  });

  it('puts <ws>/.venv/bin first on PATH and sets VIRTUAL_ENV once the workspace has a venv', async () => {
    const t = sb();
    const opts = { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() };
    const before = await t.sandbox.run('echo "$PATH"; echo "venv=${VIRTUAL_ENV-unset}"', opts);
    expect(before.stdout).toContain('venv=unset');
    expect(before.stdout).not.toContain('.venv/bin');
    // created mid-run (the agent's own `python -m venv .venv`): picked up on the next command, no restart
    mkdirSync(join(t.ws, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(t.ws, '.venv', 'bin', 'python'), '#!/bin/sh\necho venv-python\n', { mode: 0o755 });
    const r = await t.sandbox.run('echo "$PATH"; echo "venv=$VIRTUAL_ENV"; python', opts);
    expect(r.stdout.split('\n')[0]!.startsWith(`${t.ws}/.venv/bin:`)).toBe(true);
    expect(r.stdout).toContain(`venv=${t.ws}/.venv`);
    expect(r.stdout).toContain('venv-python');
    // an explicit env override still wins (bench evaluators pin their own interpreter)
    const o = await t.sandbox.run('echo "$VIRTUAL_ENV"', { ...opts, env: { VIRTUAL_ENV: '/elsewhere' } });
    expect(o.stdout.trim()).toBe('/elsewhere');
    // a .venv file (or one without bin/) is not a venv
    rmSync(join(t.ws, '.venv'), { recursive: true, force: true });
    writeFileSync(join(t.ws, '.venv'), 'not a dir');
    const none = await t.sandbox.run('echo "venv=${VIRTUAL_ENV-unset}"', opts);
    expect(none.stdout.trim()).toBe('venv=unset');
  });

  it('extraWritable roots are accepted as cwd; anything else outside the workspace and run dir is not', async () => {
    const t = sb();
    const aux = join(dirname(t.ws), 'aux');
    mkdirSync(join(aux, 'output'), { recursive: true });
    const opts = { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() };
    const withExtra = createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s, extraWritable: [aux] }, FAST_KILL);
    expect((await withExtra.run('pwd', { ...opts, cwd: aux })).stdout.trim()).toBe(aux);
    expect((await withExtra.run('pwd', { ...opts, cwd: join(aux, 'output') })).stdout.trim()).toBe(join(aux, 'output'));
    await expect(withExtra.run('pwd', { ...opts, cwd: dirname(t.ws) })).rejects.toBeInstanceOf(SandboxError);
    // the same dir is refused by a sandbox created without the option
    await expect(t.sandbox.run('pwd', { ...opts, cwd: aux })).rejects.toBeInstanceOf(SandboxError);
  });

  it('validates its inputs with SandboxError', async () => {
    const t = sb();
    await expect(t.sandbox.run('', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() })).rejects.toBeInstanceOf(SandboxError);
    await expect(t.sandbox.run('true', { timeoutMs: 0, maxOutputBytes: CAP, signal: never() })).rejects.toBeInstanceOf(SandboxError);
  });

  it('a timeout above the setTimeout range is clamped, not turned into an instant kill', async () => {
    const t = sb();
    const r = await t.sandbox.run('sleep 0.2; echo done', { timeoutMs: 2 ** 31 + 5_000, maxOutputBytes: CAP, signal: never() });
    expect(r.killedBy).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('done');
  });

  it('a throwing redact() rejects with SandboxError instead of an unhandled rejection', async () => {
    const t = makeSandbox({ internals: FAST_KILL });
    temps.push(t);
    const base = t.sandbox;
    const bad = makeSandboxWithRedact(t, () => {
      throw new Error('redact exploded');
    });
    await expect(bad.run('echo hi', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() })).rejects.toBeInstanceOf(SandboxError);
    expect((await base.run('echo hi', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() })).stdout).toBe('hi\n');
  });

  it('rejects with SandboxError when the cwd is gone (spawn failure)', async () => {
    const t = sb();
    rmSync(t.ws, { recursive: true, force: true });
    await expect(t.sandbox.run('true', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() })).rejects.toBeInstanceOf(SandboxError);
  });

  it('flags sandboxExecDenied on exit 71 with the execvp message', async () => {
    const t = sb();
    const r = await t.sandbox.run('echo "sandbox-exec: execvp() of \'/bin/ps\' failed: Operation not permitted" >&2; exit 71', {
      timeoutMs: 5_000,
      maxOutputBytes: CAP,
      signal: never(),
    });
    expect(r.exitCode).toBe(71);
    expect(r.sandboxExecDenied).toBe(true);
    const plain = await t.sandbox.run('exit 71', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
    expect(plain.sandboxExecDenied).toBe(false);
  });
});

describe('output cap', () => {
  it('drains to a tail without killing: summary line survives and parses', async () => {
    const t = sb();
    const chunks: string[] = [];
    const r = await t.sandbox.run('yes | head -c 600000; echo "3 passed in 0.1s"', {
      timeoutMs: 10_000,
      maxOutputBytes: CAP,
      signal: never(),
      onOutput: (_s, c) => chunks.push(c),
    });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.killedBy).toBeNull();
    expect(r.truncated).toBe(true);
    expect(r.bytesSeen).toBeGreaterThan(CAP);
    expect(r.bytesSeen).toBe(600_000 + '3 passed in 0.1s\n'.length);
    expect(r.stdout.endsWith('3 passed in 0.1s\n')).toBe(true);
    expect(r.stdout).toContain('output truncated');
    // head + marker + tail stays bounded
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(CAP + 16 * 1024 + 200);
    expect(parseTestOutput('pytest', r.stdout)).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
    // live chunks are bounded by the head cap
    const live = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
    expect(live).toBeLessThanOrEqual(CAP);
  });

  it('cap and timeout together are consistent', async () => {
    const t = sb();
    const r = await t.sandbox.run('yes | head -c 300000; sleep 30', { timeoutMs: 400, maxOutputBytes: CAP, signal: never() });
    expect(r.killedBy).toBe('timeout');
    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.bytesSeen).toBeGreaterThanOrEqual(300_000);
  });
});

describe('kills', () => {
  it('timeout -> killedBy timeout, resolved not rejected', async () => {
    const t = sb();
    const r = await t.sandbox.run('sleep 30', { timeoutMs: 200, maxOutputBytes: CAP, signal: never() });
    expect(r.killedBy).toBe('timeout');
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toMatch(/SIG(TERM|KILL)/);
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it('tree kill of "sleep 300 & sleep 300 & wait" leaves no pid alive', async () => {
    const t = sb();
    const r = await t.sandbox.run('echo $$; sleep 300 & echo $!; sleep 300 & echo $!; wait', { timeoutMs: 300, maxOutputBytes: CAP, signal: never() });
    expect(r.killedBy).toBe('timeout');
    const pids = r.stdout.trim().split('\n').map(Number);
    expect(pids.length).toBe(3);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
    expect(r.orphans).toEqual([]);
  });

  it('a python3 child with start_new_session=True is killed or reported in orphans', async () => {
    const has = spawnSync('python3', ['-c', 'print(1)']).status === 0;
    if (!has) return;
    const t = sb();
    const py = 'import subprocess,sys,time; p=subprocess.Popen(["sleep","300"], start_new_session=True); print(p.pid, flush=True); time.sleep(300)';
    const r = await t.sandbox.run(`python3 -c '${py}'`, { timeoutMs: 800, maxOutputBytes: CAP, signal: never() });
    expect(r.killedBy).toBe('timeout');
    const grandchild = Number(r.stdout.trim().split('\n')[0]);
    expect(Number.isInteger(grandchild)).toBe(true);
    if (pidAlive(grandchild)) {
      expect(r.orphans).toContain(grandchild);
      process.kill(grandchild, 'SIGKILL');
    } else {
      expect(r.orphans).not.toContain(grandchild);
    }
  });

  it('abort with an AbortError reason rejects after the kill', async () => {
    const t = sb();
    const ac = new AbortController();
    const p = t.sandbox.run('echo $$; sleep 300', { timeoutMs: 30_000, maxOutputBytes: CAP, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 150));
    const err = new AbortError('human_abort');
    ac.abort(err);
    await expect(p).rejects.toBe(err);
    // the child is gone once the rejection lands
    await new Promise((r) => setTimeout(r, 50));
    const ps = spawnSync('/bin/ps', ['-axo', 'pid,command']).stdout.toString();
    expect(ps).not.toMatch(/sleep 300\n/);
  });

  it('abort with BudgetError(wall_time) resolves with killedBy wall_time', async () => {
    const t = sb();
    const ac = new AbortController();
    const p = t.sandbox.run('sleep 300', { timeoutMs: 30_000, maxOutputBytes: CAP, signal: ac.signal });
    setTimeout(() => ac.abort(new BudgetError('wall_time')), 100);
    const r = await p;
    expect(r.killedBy).toBe('wall_time');
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('abortKilledBy overrides the recorded reason and a pre-aborted signal never spawns', async () => {
    const t = sb();
    const ac = new AbortController();
    ac.abort(new BudgetError('wall_time'));
    const r = await t.sandbox.run('echo spawned > marker', { timeoutMs: 1_000, maxOutputBytes: CAP, signal: ac.signal, abortKilledBy: 'abort' });
    expect(r.killedBy).toBe('abort');
    expect(r.exitCode).toBeNull();
    const ac2 = new AbortController();
    ac2.abort(new AbortError('signal'));
    await expect(t.sandbox.run('true', { timeoutMs: 1_000, maxOutputBytes: CAP, signal: ac2.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('killAll kills every live child tree and their runs resolve with killedBy abort', async () => {
    const t = sb();
    const a = t.sandbox.run('sleep 300', { timeoutMs: 30_000, maxOutputBytes: CAP, signal: never() });
    const b = t.sandbox.run('sleep 300', { timeoutMs: 30_000, maxOutputBytes: CAP, signal: never() });
    await new Promise((r) => setTimeout(r, 100));
    await t.sandbox.killAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.killedBy).toBe('abort');
    expect(rb.killedBy).toBe('abort');
  });

  it('a background holder of the pipes does not hang the run after the shell exits', async () => {
    const t = sb();
    const started = Date.now();
    const r = await t.sandbox.run('sleep 3 & echo $!; echo started', { timeoutMs: 10_000, maxOutputBytes: CAP, signal: never() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().endsWith('started')).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_500);
    // the stray group is reaped by killAll()
    const holder = Number(r.stdout.trim().split('\n')[0]);
    expect(pidAlive(holder)).toBe(true);
    await t.sandbox.killAll();
    expect(pidAlive(holder)).toBe(false);
  });
});
