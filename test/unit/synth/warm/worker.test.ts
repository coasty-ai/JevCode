/**
 * The warm lane worker against a real interpreter (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1).
 *
 * What must hold, in order of how much damage getting it wrong would do:
 *   1. warm and cold agree on the verdict, byte for byte on the runner's own report;
 *   2. the per-case SIGKILL timeout still fires inside the forked child;
 *   3. a candidate that edits a module the warm parent imported invalidates the parent;
 *   4. any exception in the warm parent, and any transport anomaly, is a fallback — never a pass;
 *   5. the worker exits with the harness (no interpreter is left behind).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { summarize } from '../../../../src/synth/verify/index.js';
import { quixbugsTestCommand } from '../../../../src/synth/verify/quixbugs.js';
import { WarmError, WarmWorker, writeWarmServer } from '../../../../src/synth/warm/index.js';
import { havePython, haveRunner, haveSeatbelt, QUIXBUGS_DIR, warmFixture, type WarmFixture } from './helpers.js';

let fx: WarmFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

/** The worker for the lane of `fx`, in quixbugs mode over `dir` (default the bench's own). */
async function quixbugsWorker(f: WarmFixture, dir = QUIXBUGS_DIR, roots: string[] = []): Promise<WarmWorker> {
  const serverPath = await writeWarmServer(join(f.runDir, 'tmp/synth/warm'));
  return WarmWorker.start({
    sandbox: f.sandbox,
    signal: f.signal,
    dir: join(f.runDir, 'tmp/synth/warm/lane0'),
    serverPath,
    cwd: f.lane.dir,
    mode: 'quixbugs',
    interpreter: 'python3',
    roots: roots.length > 0 ? roots : [f.ws, f.lane.dir],
    quixbugsDir: dir,
  });
}

/** The cold run of the same command, through the same sandbox. */
async function cold(f: WarmFixture, command: string): Promise<ReturnType<typeof summarize>> {
  const res = await f.sandbox.run(command, { timeoutMs: 60_000, maxOutputBytes: 256 * 1024, signal: f.signal, cwd: f.lane.dir, env: { PYTHONDONTWRITEBYTECODE: '1' } });
  return summarize(command, res, res.durationMs);
}

/** Only the fields a verdict rests on; `durationMs` and the output tail differ by construction. */
function verdict(s: ReturnType<typeof summarize>): unknown {
  return { passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total, failing: s.failing, exitCode: s.exitCode, timedOut: s.timedOut, failures: s.failures.map((x) => [x.testId, x.expected, x.actual]) };
}

describe.skipIf(!havePython || !haveRunner)('the warm worker on the QuixBugs runner', () => {
  it('boots, answers, and produces byte-identical reports for the buggy and the fixed program', async () => {
    fx = warmFixture();
    const f = fx;
    const w = await quixbugsWorker(f);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      for (const source of ['programs/gcd.py', 'correct/gcd.py']) {
        copyFileSync(join(QUIXBUGS_DIR, source), candidate);
        const command = quixbugsTestCommand(QUIXBUGS_DIR, 'gcd', candidate);
        const hot = await w.run({ kind: 'quixbugs', dir: QUIXBUGS_DIR, name: 'gcd', path: candidate, maxFailures: 1000 }, 60_000);
        expect(verdict(summarize(command, hot, hot.durationMs))).toEqual(verdict(await cold(f, command)));
        // the parity is on the runner's own JSON line, not merely on the parsed counts
        expect(hot.stdout.trim().startsWith('{"name": "gcd"')).toBe(true);
      }
    } finally {
      w.dispose();
    }
  }, 60_000);

  it('both kill layers still fire inside the fork — the per-case alarm and the whole-run deadline — and the worker survives both', async () => {
    fx = warmFixture();
    const f = fx;
    const w = await quixbugsWorker(f);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      writeFileSync(candidate, 'def gcd(a, b):\n    while True:\n        pass\n');
      const req = { kind: 'quixbugs' as const, dir: QUIXBUGS_DIR, name: 'gcd', path: candidate, maxFailures: 1000, timeout: 0.2 };

      // 1. the per-case SIGKILL: every case is killed at its own cap, and the run still reports
      const hot = await w.run(req, 30_000);
      const s = summarize('warm', hot, hot.durationMs);
      expect(s.passed).toBe(0);
      expect(s.total).toBe(6);
      expect(s.timedOut).toBe(false);
      expect(s.failures.every((x) => /TIMEOUT after 0\.2s/.test(x.actual))).toBe(true);

      // 2. the whole-run deadline: a per-case cap far above it, so only killpg can end the run
      const killed = await w.run({ ...req, timeout: 30 }, 300);
      expect(killed.timedOut).toBe(true);
      expect(summarize('warm', killed, killed.durationMs).timedOut).toBe(true);

      // 3. neither kill left the worker unusable
      expect(w.alive).toBe(true);
      copyFileSync(join(QUIXBUGS_DIR, 'correct/gcd.py'), candidate);
      const after = await w.run({ ...req, timeout: 2 }, 30_000);
      expect(summarize('warm', after, after.durationMs).passed).toBe(6);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it('the per-run environment reaches the candidate on the quixbugs path too, and does not leak to the next run', async () => {
    // `laneRunEnv` sets per-run keys that a cold run gets as process env; the warm child must
    // get exactly the same ones. Applying them per handler is how they silently stop arriving
    // on one of the two paths, so they are applied once, in the fork, for both.
    fx = warmFixture();
    const f = fx;
    const w = await quixbugsWorker(f);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      writeFileSync(candidate, ['import os', '', 'def gcd(a, b):', "    if os.environ.get('JEV_WARM_ENV_PROBE') != 'yes':", "        raise RuntimeError('env not applied')", '    return a if b == 0 else gcd(b, a % b)', ''].join('\n'));
      const req = { kind: 'quixbugs' as const, dir: QUIXBUGS_DIR, name: 'gcd', path: candidate, maxFailures: 1000, timeout: 2 };
      const withEnv = await w.run(req, 30_000, { JEV_WARM_ENV_PROBE: 'yes' });
      expect(summarize('warm', withEnv, 1).passed).toBe(6);
      // the next request gets its own fork, so the key is gone again
      const without = await w.run(req, 30_000);
      const s = summarize('warm', without, 1);
      expect(s.passed).toBe(0);
      expect(s.failures.every((x) => /env not applied/.test(x.actual))).toBe(true);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it('an exception in the warm parent is a fatal error answer and kills the worker (the caller then runs cold)', async () => {
    fx = warmFixture();
    const f = fx;
    const w = await quixbugsWorker(f);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      copyFileSync(join(QUIXBUGS_DIR, 'correct/gcd.py'), candidate);
      // NaN serialises as null; `float(None)` raises inside the warm parent's own request handling
      await expect(w.run({ kind: 'quixbugs', dir: QUIXBUGS_DIR, name: 'gcd', path: candidate }, Number.NaN)).rejects.toThrow(WarmError);
      expect(w.alive).toBe(false);
      await expect(w.run({ kind: 'quixbugs', dir: QUIXBUGS_DIR, name: 'gcd', path: candidate }, 10_000)).rejects.toThrow(WarmError);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it('a candidate that changes a module the warm parent imported invalidates it, by content hash', async () => {
    fx = warmFixture();
    const f = fx;
    // the parent imports run_tests.py from here; declaring it a root makes it part of the tracked
    // import set, so editing it is exactly "a candidate touched a module the interpreter imported"
    const qb = join(f.ws, 'quixbugs');
    cpSync(QUIXBUGS_DIR, qb, { recursive: true });
    const w = await quixbugsWorker(f, qb, [f.ws]);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      copyFileSync(join(qb, 'correct/gcd.py'), candidate);
      const req = { kind: 'quixbugs' as const, dir: qb, name: 'gcd', path: candidate, maxFailures: 1000 };
      expect(summarize('warm', await w.run(req, 30_000), 1).passed).toBe(6);
      appendFileSync(join(qb, 'run_tests.py'), '\n# a candidate touched this\n');
      const err = await w.run(req, 30_000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WarmError);
      expect((err as WarmError).invalidated).toBe(true);
      expect(w.alive).toBe(false);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it('the interpreter exits when the harness closes its end of the request fifo', async () => {
    fx = warmFixture();
    const f = fx;
    const laneWarmDir = join(f.runDir, 'tmp/synth/warm/lane0');
    const w = await quixbugsWorker(f);
    const alive = (): number => (spawnSync('/bin/sh', ['-c', `pgrep -f '[w]arm_server.py --dir ${laneWarmDir} ' | wc -l`], { encoding: 'utf8' }).stdout ?? '0').trim().split('\n').map(Number)[0] ?? 0;
    expect(alive()).toBeGreaterThan(0);
    w.dispose();
    const started = Date.now();
    while (alive() > 0 && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(0);
  }, 40_000);
});

describe.skipIf(!havePython || !haveRunner || !haveSeatbelt)('under the real seatbelt', () => {
  /**
   * The design's whole reason for starting the worker through `ctx.sandbox.run` instead of a
   * second `spawn` is that it then inherits the profile. Everything the warm path asks of that
   * profile is something a cold run never asks: `os.mkfifo` under the run dir, a `fork()` per
   * candidate, `setsid()`, and a process that outlives the command that started it. So one case
   * pays the real `sandbox-exec` and checks that the verdict is still the cold one.
   */
  it('boots, forks, and agrees with the cold run of the same command', async () => {
    fx = warmFixture('jev-warm-sb-', 'seatbelt');
    const f = fx;
    expect(f.sandbox.level).toBe('seatbelt');
    const w = await quixbugsWorker(f);
    try {
      const candidate = join(f.lane.dir, 'gcd.py');
      copyFileSync(join(QUIXBUGS_DIR, 'correct/gcd.py'), candidate);
      const command = quixbugsTestCommand(QUIXBUGS_DIR, 'gcd', candidate, { timeoutSec: 2 });
      const hot = await w.run({ kind: 'quixbugs', dir: QUIXBUGS_DIR, name: 'gcd', path: candidate, maxFailures: 1000, timeout: 2 }, 60_000);
      const summary = summarize(command, hot, hot.durationMs);
      expect(summary.passed).toBe(6);
      expect(verdict(summary)).toEqual(verdict(await cold(f, command)));
      // the per-case SIGKILL still fires inside the confined fork
      writeFileSync(candidate, 'def gcd(a, b):\n    while True:\n        pass\n');
      const hung = await w.run({ kind: 'quixbugs', dir: QUIXBUGS_DIR, name: 'gcd', path: candidate, maxFailures: 1000, timeout: 0.2 }, 30_000);
      const hungSummary = summarize(command, hung, hung.durationMs);
      expect(hungSummary.passed).toBe(0);
      expect(hungSummary.failures.every((x) => /TIMEOUT after 0\.2s/.test(x.actual))).toBe(true);
      expect(w.alive).toBe(true);
    } finally {
      w.dispose();
    }
  }, 90_000);
});

describe.skipIf(!havePython)('a misbehaving worker never becomes a verdict', () => {
  /** A stub server speaking the same FIFO protocol, so the transport's failure modes are testable. */
  async function stub(f: WarmFixture, body: string): Promise<WarmWorker> {
    const dir = join(f.runDir, 'tmp/synth/warm');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'warm_server.py');
    writeFileSync(
      path,
      [
        'import json, os, sys',
        'd = sys.argv[sys.argv.index("--dir") + 1]',
        'req, resp = os.path.join(d, "req"), os.path.join(d, "resp")',
        'os.mkfifo(req, 0o600); os.mkfifo(resp, 0o600)',
        'sys.stdout.write("JEVCODE_WARM_READY %d\\n" % os.getpid()); sys.stdout.flush()',
        'r = open(req, "r"); w = open(resp, "w")',
        'n = 0',
        'while True:',
        '    line = r.readline()',
        '    if line == "": break',
        '    msg = json.loads(line)',
        '    n += 1',
        `    ${body}`,
        '    w.flush()',
        '',
      ].join('\n'),
      'utf8',
    );
    return WarmWorker.start({ sandbox: f.sandbox, signal: f.signal, dir: join(dir, 'lane0'), serverPath: path, cwd: f.lane.dir, mode: 'quixbugs', interpreter: 'python3', roots: [f.ws] });
  }

  const REQ = { kind: 'quixbugs' as const, dir: '/b', name: 'gcd', path: '/l/gcd.py' };

  it('a response for the wrong id is a sentinel desync: the request fails and the worker dies', async () => {
    fx = warmFixture();
    const w = await stub(fx, 'w.write(json.dumps({"id": msg["id"] if n == 1 else 999, "ok": True, "pid": 1}) + "\\n")');
    await expect(w.run(REQ, 5_000)).rejects.toThrow(/response id 999/);
    expect(w.alive).toBe(false);
    w.dispose();
  }, 30_000);

  it('a malformed response line is an error, never an empty pass', async () => {
    fx = warmFixture();
    const w = await stub(fx, 'w.write((json.dumps({"id": msg["id"], "ok": True, "pid": 1}) if n == 1 else "}{ not json") + "\\n")');
    await expect(w.run(REQ, 5_000)).rejects.toThrow(/malformed response/);
    expect(w.alive).toBe(false);
    w.dispose();
  }, 30_000);

  it('a run answered with no output is an anomaly, never an empty "nothing ran" pass', async () => {
    fx = warmFixture();
    const w = await stub(fx, 'w.write(json.dumps({"id": msg["id"], "ok": True, "pid": 1}) + "\\n")');
    await expect(w.run(REQ, 5_000)).rejects.toThrow(/answered a run with no output/);
    expect(w.alive).toBe(false);
    w.dispose();
  }, 30_000);

  it('an interpreter that dies mid-request fails the request rather than hanging it', async () => {
    fx = warmFixture();
    const w = await stub(fx, 'w.write(json.dumps({"id": msg["id"], "ok": True, "pid": 1}) + "\\n") if n == 1 else os._exit(1)');
    await expect(w.run(REQ, 5_000)).rejects.toThrow(WarmError);
    expect(w.alive).toBe(false);
    w.dispose();
  }, 30_000);

  it('a worker that never announces itself fails the boot instead of costing the boot timeout', async () => {
    fx = warmFixture();
    const f = fx;
    const dir = join(f.runDir, 'tmp/synth/warm');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'warm_server.py');
    writeFileSync(path, 'import sys\nsys.stderr.write("no interpreter here\\n")\nraise SystemExit(3)\n', 'utf8');
    const started = Date.now();
    await expect(WarmWorker.start({ sandbox: f.sandbox, signal: f.signal, dir: join(dir, 'lane0'), serverPath: path, cwd: f.lane.dir, mode: 'quixbugs', interpreter: 'python3', roots: [f.ws] })).rejects.toThrow(WarmError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
