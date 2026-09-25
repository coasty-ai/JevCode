import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AbortError, BudgetError, SandboxError } from '../../../src/errors.js';
import { parseTestOutput } from '../../../src/workspace/tests.js';
import { createSandbox, existingToolchainHomes, inheritsEnvName, resolveGitIdentity } from '../../../src/sandbox/run.js';
import { FAST_KILL, makeSandbox, makeTemp, never, pidAlive } from './helpers.js';
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

  it("scrubs the environment: the user's own variables pass, secrets and JevCode/npm/git context do not, HOME and TMPDIR are remapped", async () => {
    const t = sb();
    const key = 'sk-or-v1-' + 'a'.repeat(40);
    const set: Record<string, string> = {
      OPENROUTER_API_KEY: key,
      GITHUB_TOKEN: 'ghs_notreallyatoken',
      MY_SERVICE_PASSWORD: 'hunter2',
      NODE_AUTH_TOKEN: 'npm-token',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      JEV_TEST_LEAK: 'leak',
      JEVCODE_SOMETHING: 'x',
      GIT_DIR: '/elsewhere/.git',
      GIT_INDEX_FILE: '/elsewhere/index',
      npm_config_x: 'y',
      INIT_CWD: '/launched/from',
      VIRTUAL_ENV: '/some/outer/venv',
      XDG_CONFIG_HOME: '/real/config',
      // a key under a name that marks nothing: the redactor recognises its value
      MY_LLM: 'sk-ant-api03-' + 'b'.repeat(40),
      // the user's ordinary configuration reaches the command as in their shell
      SANDBOX_BENIGN_PROBE: 'ok',
      JAVA_HOME: '/opt/jdk',
      HTTPS_PROXY: 'http://proxy.local:3128',
      DATABASE_URL: 'postgres://app@db.local/app',
    };
    const redact = (s: string): string => s.replace(/sk-or-v1-[a-z0-9]+|sk-ant-api03-[a-z0-9]+/g, '[REDACTED]');
    const sandbox = createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact }, { ...FAST_KILL, gitIdentity: () => null });
    for (const [k, v] of Object.entries(set)) process.env[k] = v;
    try {
      const r = await sandbox.run('env', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
      const names = new Set(r.stdout.split('\n').map((l) => l.slice(0, l.indexOf('='))));
      for (const gone of ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'MY_SERVICE_PASSWORD', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'JEV_TEST_LEAK', 'JEVCODE_SOMETHING', 'GIT_DIR', 'GIT_INDEX_FILE', 'npm_config_x', 'INIT_CWD', 'VIRTUAL_ENV', 'XDG_CONFIG_HOME', 'MY_LLM']) expect(names.has(gone), gone).toBe(false);
      expect(r.stdout).not.toContain(key);
      expect(r.stdout).toMatch(/^SANDBOX_BENIGN_PROBE=ok$/m);
      expect(r.stdout).toMatch(/^JAVA_HOME=\/opt\/jdk$/m);
      expect(r.stdout).toMatch(/^HTTPS_PROXY=http:\/\/proxy\.local:3128$/m);
      expect(r.stdout).toMatch(/^DATABASE_URL=postgres:\/\/app@db\.local\/app$/m);
      expect(r.stdout).toMatch(new RegExp(`^TMPDIR=${t.runDir}/tmp$`, 'm'));
      expect(r.stdout).toMatch(new RegExp(`^HOME=${t.runDir}/home$`, 'm'));
      expect(r.stdout).toMatch(/^PATH=/m);
      // `extra` still wins, and is the only way a GIT_* reaches a command (the harness's own git)
      const own = await sandbox.run('echo "$GIT_CONFIG_GLOBAL"', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never(), env: { GIT_CONFIG_GLOBAL: '/dev/null' } });
      expect(own.stdout.trim()).toBe('/dev/null');
    } finally {
      for (const k of Object.keys(set)) delete process.env[k];
    }
    expect(inheritsEnvName('GIT_AUTHOR_NAME')).toBe(false); // every GIT_* is dropped, though AUTHOR is no AUTH segment
    expect(inheritsEnvName('AUTHOR')).toBe(true);
    expect(inheritsEnvName('LANG')).toBe(true);
    expect(inheritsEnvName('AWS_SESSION_TOKEN')).toBe(false);
    expect(inheritsEnvName('PGPASSWORD')).toBe(false);
  });

  it("copies the user's git identity (and only it) into the run's HOME, so a command's commit has an author", async () => {
    const t = sb();
    let probes = 0;
    const sandbox = createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ...FAST_KILL, gitIdentity: () => { probes++; return { name: 'Ada "The" Lovelace; #1', email: 'ada@example.com' }; } });
    // nothing is probed or written until a command runs
    expect(existsSync(join(t.runDir, 'home', '.gitconfig'))).toBe(false);
    const opts = { timeoutMs: 10_000, maxOutputBytes: CAP, signal: never() };
    const r = await sandbox.run('git config --global --get user.name; git config --global --get user.email; git config --global --list | wc -l', opts);
    expect(r.stdout.trim().split('\n').map((l) => l.trim())).toEqual(['Ada "The" Lovelace; #1', 'ada@example.com', '2']);
    await sandbox.run('true', opts);
    expect(probes).toBe(1);
    // a file the run already has (its own `git config --global`) is kept
    writeFileSync(join(t.runDir, 'home', '.gitconfig'), '[user]\n\tname = Changed\n');
    createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ...FAST_KILL, gitIdentity: () => ({ name: 'Other', email: null }) });
    expect(readFileSync(join(t.runDir, 'home', '.gitconfig'), 'utf8')).toBe('[user]\n\tname = Changed\n');
    // no identity: no file
    const bare = makeTemp('jev-noid-');
    try {
      const s2 = createSandbox({ workspaceRoot: bare.dir, runDir: join(bare.dir, 'run'), profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ...FAST_KILL, gitIdentity: () => null });
      await s2.run('true', opts);
      expect(existsSync(join(bare.dir, 'run', 'home', '.gitconfig'))).toBe(false);
    } finally {
      bare.cleanup();
    }
    expect(resolveGitIdentity({ probe: () => ({ name: null, email: null }) })).toBeNull();
    expect(resolveGitIdentity({ probe: () => ({ name: 'A', email: null }) })).toEqual({ name: 'A', email: null });
  });

  it('points the toolchain homes the user has not set at the real ones under their home, never a cache a build writes', async () => {
    const t = sb();
    const home = makeTemp('jev-home-');
    try {
      mkdirSync(join(home.dir, '.pyenv'));
      mkdirSync(join(home.dir, '.rustup'));
      mkdirSync(join(home.dir, '.cargo'));
      const sandbox = createSandbox({ workspaceRoot: t.ws, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ...FAST_KILL, gitIdentity: () => null, homeDir: home.dir });
      process.env['RUSTUP_HOME'] = '/users/own/rustup';
      try {
        const r = await sandbox.run('echo "pyenv=$PYENV_ROOT rustup=$RUSTUP_HOME cargo=${CARGO_HOME-unset} rbenv=${RBENV_ROOT-unset}"', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never() });
        expect(r.stdout.trim()).toBe(`pyenv=${home.dir}/.pyenv rustup=/users/own/rustup cargo=unset rbenv=unset`);
      } finally {
        delete process.env['RUSTUP_HOME'];
      }
      expect(existingToolchainHomes(home.dir)).toEqual([['RUSTUP_HOME', join(home.dir, '.rustup')], ['PYENV_ROOT', join(home.dir, '.pyenv')]]);
    } finally {
      home.cleanup();
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

  it('names a cwd that does not exist, where spawn() would report the shell binary as missing (S6 live)', async () => {
    const t = sb();
    await expect(t.sandbox.run('pwd', { timeoutMs: 5_000, maxOutputBytes: CAP, signal: never(), cwd: 'no-such-dir' })).rejects.toThrow('cwd "no-such-dir" is not a directory (it does not exist)');
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

  it('the kept tail starts on a line boundary, never inside an escape sequence whose ESC was cut off', async () => {
    const t = sb();
    // a coloured test reporter's flood: the old tail began `m\u001b[39m test 19600 passes`
    const r = await t.sandbox.run(`awk 'BEGIN { for (i = 0; i < 20000; i++) printf "\\033[33m\\033[2m✓\\033[22m\\033[39m test %d passes\\n", i }'`, { timeoutMs: 10_000, maxOutputBytes: CAP, signal: never() });
    expect(r.truncated).toBe(true);
    const marker = /\n…\[output truncated: (\d+) bytes omitted\]…\n/.exec(r.stdout)!;
    expect(marker).not.toBeNull();
    const tail = r.stdout.slice(marker.index + marker[0].length);
    expect(tail.startsWith('\u001b[33m\u001b[2m✓\u001b[22m\u001b[39m test ')).toBe(true);
    for (const line of tail.trimEnd().split('\n')) expect(line).toMatch(/^\u001b\[33m\u001b\[2m✓\u001b\[22m\u001b\[39m test \d+ passes$/);
    expect(tail.endsWith(' test 19999 passes\n')).toBe(true);
    // the omitted count covers the partial line the seam dropped: head + omitted + tail is every byte the stream carried
    expect(CAP + Number(marker[1]) + Buffer.byteLength(tail)).toBe(r.bytesSeen);
  });

  it('a tail with no newline to cut at (one long line) is kept whole, minus a leading partial UTF-8 sequence', async () => {
    const t = sb();
    const r = await t.sandbox.run(`awk 'BEGIN { for (i = 0; i < 40000; i++) printf "é"; printf "END" }'`, { timeoutMs: 10_000, maxOutputBytes: CAP, signal: never() });
    const tail = r.stdout.slice(r.stdout.indexOf(']…\n') + 3);
    expect(tail.endsWith('END')).toBe(true);
    expect(tail).not.toContain('�');
    expect(Buffer.byteLength(tail)).toBeGreaterThan(16 * 1024 - 4);
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
    // A duration unique to this test run: other worktrees run this same suite on a shared machine, and `ps` sees
    // every process on the host, so a bare `sleep 300` match would fail on THEIR still-running children.
    const tag = `300.${String(process.pid % 10_000).padStart(4, '0')}${String(process.hrtime()[1] % 1000).padStart(3, '0')}`;
    const p = t.sandbox.run(`echo $$; sleep ${tag}`, { timeoutMs: 30_000, maxOutputBytes: CAP, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 150));
    const err = new AbortError('human_abort');
    ac.abort(err);
    await expect(p).rejects.toBe(err);
    // the child is gone once the rejection lands
    await new Promise((r) => setTimeout(r, 50));
    const ps = spawnSync('/bin/ps', ['-axo', 'pid,command']).stdout.toString();
    expect(ps).not.toContain(`sleep ${tag}`);
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
