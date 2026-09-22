/**
 * The warm plane END TO END, over a real interpreter and a real fixture project — the test the
 * S1 wave did not have.
 *
 * Everything else under test/unit/synth/warm either drives the protocol with a scripted screen
 * or exercises ONE worker. Both passed throughout the regression this file exists for: an
 * `llm-jev` run with the plane on never completed a synthesis step, the sieve reported
 * "0 tested on 8 lanes (nothing ran)", and some runs sat at 0 % CPU with no child processes for
 * an hour. The cause was invisible to a fake and invisible to one lane:
 *
 *   * the transport used `fs.createReadStream` / `fs.createWriteStream` over the lane FIFOs, so
 *     every idle lane parked one of libuv's FOUR filesystem threads in a blocking `read(2)` and
 *     every lane still attaching parked another in `open(2)`. At eight lanes the pool was gone
 *     and every `fs` call in the harness — including the candidate writes the sieve was about
 *     to make — queued behind threads that would never return;
 *   * `note()` gave each lane three attempts, so the step's test wall drained into 20-second
 *     boot deadlines instead of into candidates.
 *
 * So the cases here are: one screen end to end against the real worker, the truncation path,
 * the cold confirmation, MORE LANES THAN THE THREADPOOL HAS THREADS (the shape that wedged),
 * and the watchdog, driven by a worker script that really does sleep for ever.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Lane } from '../../../../src/synth/search/types.js';
import { summarize } from '../../../../src/synth/verify/index.js';
import { WARM_OUTPUT_BYTES, WarmPlane } from '../../../../src/synth/warm/index.js';
import { havePython, havePytest, PY_ENV, warmFixture, type WarmFixture } from './helpers.js';

/** Larger than libuv's default filesystem threadpool (4): the width that exposed the wedge. */
const LANES = 6;
/** The whole point of the plane is that a screen is cheap; a real one is tens of milliseconds. */
const SERVE_DEADLINE_MS = 30_000;

let fx: WarmFixture | null = null;
let plane: WarmPlane | null = null;
afterEach(() => {
  plane?.dispose();
  plane = null;
  fx?.cleanup();
  fx = null;
});

/** A lane directory holding the two-test fixture project, plus a candidate to screen. */
function fixtureLane(f: WarmFixture, index: number, loud = false): Lane {
  const dir = index === 0 ? f.lane.dir : join(f.runDir, `tmp/synth/lane${index}`);
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'gcd.py'), 'def gcd(a, b):\n    return a if b == 0 else gcd(b, a % b)\n');
  writeFileSync(
    join(dir, 'tests/test_gcd.py'),
    ['import gcd as m', '', 'def test_same():', '    assert m.gcd(13, 13) == 13', '', 'def test_coprime():', '    assert m.gcd(37, 600) == 1', ''].join('\n'),
  );
  // ~2 MB on stdout, eight times the output budget, with `-s` so pytest does not capture it
  if (loud) writeFileSync(join(dir, 'tests/test_loud.py'), ['def test_loud():', '    line = "x" * 4095', '    for _ in range(500):', '        print(line)', '    assert True', ''].join('\n'));
  return { index, dir, mode: 'candidate_file', busy: false };
}

function planeFor(f: WarmFixture, opts: { bootTimeoutMs?: number; bootEnv?: Readonly<Record<string, string>> } = {}): WarmPlane {
  return new WarmPlane({
    sandbox: f.sandbox,
    signal: f.signal,
    runDir: f.runDir,
    workspaceRoot: f.ws,
    mode: 'pytest',
    interpreter: 'python3',
    bootEnv: opts.bootEnv ?? PY_ENV,
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
  });
}

/** Only the fields a verdict rests on; durations and the output tail differ by construction. */
function verdict(s: ReturnType<typeof summarize>): unknown {
  return { passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total, failing: s.failing, passing: s.passing, exitCode: s.exitCode, timedOut: s.timedOut };
}

describe.skipIf(!havePytest)('the warm plane over a real lane (skipped: python3 with pytest is not importable here)', () => {
  it('serves one screen end to end and the cold confirmation agrees with it', async () => {
    fx = warmFixture('jev-warm-real-');
    const f = fx;
    const lane = fixtureLane(f, 0);
    const p = planeFor(f);
    plane = p;
    const command = 'python3 -m pytest -q tests/test_gcd.py';

    const hot = await p.serve(lane, command, SERVE_DEADLINE_MS, {});
    expect(hot, 'the real worker did not serve the screen').not.toBeNull();
    // the reply itself: the fixture's two tests, pytest's own report, no truncation, no deadline
    expect(hot!.exitCode).toBe(0);
    expect(hot!.timedOut).toBe(false);
    expect(hot!.truncated).toBe(false);
    expect(hot!.stdout).toContain('2 passed');
    expect(hot!.durationMs).toBeGreaterThan(0);
    expect(p.stats().screened).toBe(1);
    expect(p.stats().fallbacks).toBe(0);
    expect(p.stats().disabledReason).toBeNull();

    // screen hot, CONFIRM COLD: the same command through the sandbox, summarised by the same
    // parser, must reach the same verdict — that is the whole warrant for screening at all
    const started = Date.now();
    const res = await f.sandbox.run(command, { timeoutMs: SERVE_DEADLINE_MS, maxOutputBytes: WARM_OUTPUT_BYTES, signal: f.signal, cwd: lane.dir, env: { ...PY_ENV } });
    p.confirmed(Date.now() - started);
    expect(verdict(summarize(command, hot!, hot!.durationMs))).toEqual(verdict(summarize(command, res, res.durationMs)));
    expect(summarize(command, hot!, 1).passed).toBe(2);
    expect(p.stats().confirmed).toBe(1);
    expect(p.stats().mismatches).toBe(0);
    // the warm duration is the worker's own and is NOT a cold run time: the two are accounted
    // separately so the run-time medians never learn a fork's wall for a process's
    expect(p.stats().screenMs).toBeGreaterThan(0);
    expect(p.stats().confirmMs).toBeGreaterThan(0);
  }, 120_000);

  it('bounds a runaway candidate exactly where the cold path does, marker and verdict', async () => {
    fx = warmFixture('jev-warm-real-loud-');
    const f = fx;
    const lane = fixtureLane(f, 0, true);
    const p = planeFor(f);
    plane = p;
    const command = 'python3 -m pytest -q -s tests/test_loud.py';

    const hot = await p.serve(lane, command, SERVE_DEADLINE_MS, {});
    expect(hot, 'the real worker did not serve the loud screen').not.toBeNull();
    const res = await f.sandbox.run(command, { timeoutMs: SERVE_DEADLINE_MS, maxOutputBytes: WARM_OUTPUT_BYTES, signal: f.signal, cwd: lane.dir, env: { ...PY_ENV } });
    expect(hot!.truncated).toBe(true);
    expect(res.truncated).toBe(true);
    expect(hot!.stdout).toContain('[output truncated:');
    expect(res.stdout).toContain('[output truncated:');
    // the reply crosses the fifo in pieces and the pipe fills while it does; it must still be
    // one complete line, bounded by the same budget as its cold twin
    expect(hot!.stdout.length).toBeLessThan(WARM_OUTPUT_BYTES + 64 * 1024);
    expect(verdict(summarize(command, hot!, 1))).toEqual(verdict(summarize(command, res, 1)));
  }, 120_000);

  it(`serves ${LANES} lanes at once — more than libuv has filesystem threads — and leaves the threadpool free`, async () => {
    fx = warmFixture('jev-warm-real-wide-');
    const f = fx;
    const lanes = Array.from({ length: LANES }, (_, i) => fixtureLane(f, i));
    const p = planeFor(f);
    plane = p;
    const command = 'python3 -m pytest -q tests/test_gcd.py';

    // an ordinary fs read, issued while every lane is mid-request: under the old transport the
    // threadpool was already gone by lane five and this never resolved
    const probe = Promise.all(lanes.map((l) => p.serve(l, command, SERVE_DEADLINE_MS, {})));
    const threadpoolAlive = readFile(join(lanes[0]!.dir, 'gcd.py'), 'utf8');
    const replies = await probe;
    await expect(threadpoolAlive).resolves.toContain('def gcd');

    expect(replies.filter((r) => r === null), 'every lane must have been screened warm').toEqual([]);
    for (const r of replies) expect(r!.stdout).toContain('2 passed');
    expect(p.stats().screened).toBe(LANES);
    expect(p.stats().fallbacks).toBe(0);
    expect(p.stats().restarts).toBe(0);
    expect(p.stats().disabledReason).toBeNull();

    // and a second round on the same workers, which is what a batch actually does
    const second = await Promise.all(lanes.map((l) => p.serve(l, command, SERVE_DEADLINE_MS, {})));
    expect(second.filter((r) => r === null)).toEqual([]);
    expect(p.stats().screened).toBe(LANES * 2);
  }, 180_000);
});

describe.skipIf(!havePython)('the plane watchdog (skipped: python3 is not on PATH here)', () => {
  /**
   * A `python3` earlier on PATH than the real one that does exactly what the wedged workers
   * did. `dir` names the lane's fifo directory, so the second variant can announce itself and
   * then hold the request end open without ever answering.
   */
  function fakePython(f: WarmFixture, body: string): Readonly<Record<string, string>> {
    const bin = join(f.runDir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const path = join(bin, 'python3');
    writeFileSync(path, `#!/bin/sh\ndir=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in --dir) dir="$2"; shift 2;; *) shift;; esac\ndone\n${body}\n`);
    chmodSync(path, 0o755);
    return { ...PY_ENV, PATH: `${bin}:/usr/bin:/bin` };
  }

  it('gives up on a worker that never announces itself, and says so', async () => {
    fx = warmFixture('jev-warm-watchdog-quiet-');
    const f = fx;
    const lane = fixtureLane(f, 0);
    const p = planeFor(f, { bootTimeoutMs: 400, bootEnv: fakePython(f, 'exec sleep 3600') });
    plane = p;

    const started = Date.now();
    const hot = await p.serve(lane, 'python3 -m pytest -q tests/test_gcd.py', 1_000, {});
    const took = Date.now() - started;
    expect(hot, 'a worker that never announces itself must not produce a screen').toBeNull();
    // bounded by the BOOT deadline, not by the watchdog behind it and certainly not by the wall
    expect(took).toBeLessThan(10_000);
    expect(p.disabled).toBe(true);
    expect(p.stats().disabledReason).toMatch(/stopped answering|did not come back/);
    expect(p.stats().screened).toBe(0);
    expect(p.stats().fallbacks).toBeGreaterThan(0);

    // and the sieve falls back cold from here on: the next offer is refused at once
    const again = Date.now();
    expect(await p.serve(lane, 'python3 -m pytest -q tests/test_gcd.py', 1_000, {})).toBeNull();
    expect(Date.now() - again).toBeLessThan(1_000);
  }, 60_000);

  it('gives up on a worker that announces itself and then never replies', async () => {
    fx = warmFixture('jev-warm-watchdog-mute-');
    const f = fx;
    const lane = fixtureLane(f, 0);
    // announces, creates both fifos, holds the request end open, answers nothing, sleeps for ever
    const body = ['mkfifo "$dir/req" "$dir/resp" 2>/dev/null', 'echo "JEVCODE_WARM_READY $$"', 'cat "$dir/req" > /dev/null &', 'exec sleep 3600'].join('\n');
    const p = planeFor(f, { bootTimeoutMs: 700, bootEnv: fakePython(f, body) });
    plane = p;

    const started = Date.now();
    const hot = await p.serve(lane, 'python3 -m pytest -q tests/test_gcd.py', 1_000, {});
    expect(hot, 'a worker that never replies must not produce a screen').toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(p.disabled).toBe(true);
    expect(p.stats().disabledReason).toMatch(/stopped answering|did not come back/);
  }, 60_000);
});
