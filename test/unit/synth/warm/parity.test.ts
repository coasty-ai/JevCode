/**
 * Warm/cold parity (docs/HARNESS-NEXT-DESIGN.md §3 M6, risk R-1). The warm plane may only ever
 * be *faster*: the summary a warm run produces must be the summary the cold run produces, on the
 * buggy program, on the fixed program, and on the shapes the sieve actually meets — the JSON
 * runner, the module-test runner, a candidate that does not import, and a pytest suite.
 *
 * The comparison is on the whole verdict-bearing summary, not on a pass/fail bit, because the
 * sieve classifies from the ids and the counts, not from the exit status alone.
 *
 * Deliberately lean on real interpreter work: every cold run here is a real `run_tests.py` or
 * `pytest` process, and this file runs in parallel with the suite's latency-gated TUI probes.
 * One fixture and one warm worker serve the whole describe, and the hanging shapes — which cost
 * a per-case cap each — live in worker.test.ts at a 0.3 s cap instead of the runner's 2 s.
 */
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Lane } from '../../../../src/synth/search/types.js';
import type { TestRunSummary } from '../../../../src/synth/types.js';
import { summarize } from '../../../../src/synth/verify/index.js';
import { quixbugsTestCommand } from '../../../../src/synth/verify/quixbugs.js';
import { WarmPlane, WARM_OUTPUT_BYTES } from '../../../../src/synth/warm/index.js';
import { havePython, havePytest, haveRunner, LADDER_DIR, PY_ENV, QUIXBUGS_DIR, warmFixture, type WarmFixture } from './helpers.js';

/**
 * Everything a verdict rests on. `durationMs`, `command` and the output tail are allowed to
 * differ — and so are object addresses inside a `repr` (`<generator object flatten at 0x10a…>`,
 * which `flatten`'s buggy program returns): those differ between two runs of ANY kind, cold
 * included, so treating them as a parity break would be measuring the allocator.
 */
const noAddresses = (t: string): string => t.replace(/0x[0-9a-f]{6,}/g, '0xADDR');

function verdict(s: TestRunSummary): unknown {
  return {
    passed: s.passed,
    failed: s.failed,
    errors: s.errors,
    skipped: s.skipped,
    total: s.total,
    failing: s.failing,
    passing: s.passing,
    exitCode: s.exitCode,
    timedOut: s.timedOut,
    failures: s.failures.map((f) => [f.testId, noAddresses(f.expected), noAddresses(f.actual)]),
  };
}

async function coldSummary(f: WarmFixture, command: string, cwd: string): Promise<TestRunSummary> {
  const res = await f.sandbox.run(command, { timeoutMs: 120_000, maxOutputBytes: WARM_OUTPUT_BYTES, signal: f.signal, cwd, env: { ...PY_ENV } });
  return summarize(command, res, res.durationMs);
}

async function hotSummary(plane: WarmPlane, lane: Lane, command: string): Promise<TestRunSummary> {
  const hot = await plane.serve(lane, command, 120_000, {});
  expect(hot, `the plane refused to serve ${command}`).not.toBeNull();
  return summarize(command, hot!, hot!.durationMs);
}

describe.skipIf(!havePython || !haveRunner)('QuixBugs: warm and cold reach the same verdict', () => {
  let fx: WarmFixture;
  let plane: WarmPlane;
  beforeAll(() => {
    fx = warmFixture();
    plane = new WarmPlane({ sandbox: fx.sandbox, signal: fx.signal, runDir: fx.runDir, workspaceRoot: fx.ws, mode: 'quixbugs', interpreter: 'python3', bootEnv: PY_ENV });
  });
  afterAll(() => {
    plane.dispose();
    fx.cleanup();
  });

  /**
   * One program per shape the two runners can differ on, not a sample: JSON cases (`gcd`,
   * `kth`), a module-test program whose tests share module state (`depth_first_search`), a
   * generator return value — whose `repr` carries an object address, the one thing two runs of
   * ANY kind disagree about (`flatten`). `gcd`'s buggy program already covers a candidate that
   * raises rather than failing.
   *
   * The list is short on purpose. Every entry is four real interpreter runs (warm and cold,
   * buggy and fixed) competing with the suite's latency-gated TUI probes for the same cores, so
   * breadth belongs in the sweep below and only the distinct SHAPES belong here.
   *
   * All 41 programs x {buggy, correct} are swept by
   * `npx tsx experiments/fastlane/warm-parity-sweep.mts`, which is where the exhaustive run
   * belongs: 82 cold `run_tests.py` processes is a minute of real interpreter work, and the
   * programs that hang cost a per-case cap each. Latest run on this machine: 82/82 identical at
   * `--timeout 2`, 0 real parity breaks.
   */
  const PROGRAMS = ['gcd', 'kth', 'depth_first_search', 'flatten'];

  it('agrees on every fixture program, buggy and fixed', async () => {
    for (const name of PROGRAMS) {
      const candidate = join(fx.lane.dir, `${name}.py`);
      for (const source of [`programs/${name}.py`, `correct/${name}.py`]) {
        copyFileSync(join(QUIXBUGS_DIR, source), candidate);
        const command = quixbugsTestCommand(QUIXBUGS_DIR, name, candidate, { timeoutSec: 2 });
        const [hot, cold] = [await hotSummary(plane, fx.lane, command), await coldSummary(fx, command, fx.lane.dir)];
        expect(verdict(hot), `${name} / ${source}`).toEqual(verdict(cold));
      }
    }
    expect(plane.stats().screened).toBe(PROGRAMS.length * 2);
    expect(plane.stats().fallbacks).toBe(0);
  }, 180_000);

  it('agrees on a candidate that cannot be imported and on one with no such function', async () => {
    const candidate = join(fx.lane.dir, 'gcd.py');
    const cases: [string, string][] = [
      ['a syntax error', 'def gcd(a, b)\n    return a\n'],
      ['a candidate with no such function', 'def not_gcd(a, b):\n    return a\n'],
      ['a candidate that raises at import', 'raise RuntimeError("boom")\n'],
    ];
    for (const [what, source] of cases) {
      writeFileSync(candidate, source);
      const command = quixbugsTestCommand(QUIXBUGS_DIR, 'gcd', candidate, { timeoutSec: 2 });
      const [hot, cold] = [await hotSummary(plane, fx.lane, command), await coldSummary(fx, command, fx.lane.dir)];
      expect(verdict(hot), what).toEqual(verdict(cold));
    }
  }, 180_000);
});

describe.skipIf(!havePytest)('ladder (pytest): warm and cold reach the same verdict', () => {
  let fx: WarmFixture;
  let plane: WarmPlane;
  beforeAll(() => {
    fx = warmFixture();
    // the lane is a copy of the task, as a `copy`-mode lane would be
    cpSync(join(LADDER_DIR, 'account'), fx.lane.dir, { recursive: true });
    plane = new WarmPlane({ sandbox: fx.sandbox, signal: fx.signal, runDir: fx.runDir, workspaceRoot: fx.ws, mode: 'pytest', interpreter: 'python3', bootEnv: PY_ENV });
  });
  afterAll(() => {
    plane.dispose();
    fx.cleanup();
  });

  it('agrees on the buggy task, on a scoped run, on a run that collects nothing, and on the gold', async () => {
    for (const command of [
      'python3 -m pytest -q',
      'python3 -m pytest -q tests/test_account.py',
      // the scope-usability signal: a filter that matches nothing must read as 0 collected on both paths
      'python3 -m pytest -q -k no_such_test_name_at_all',
    ]) {
      const [hot, cold] = [await hotSummary(plane, fx.lane, command), await coldSummary(fx, command, fx.lane.dir)];
      expect(verdict(hot), command).toEqual(verdict(cold));
      if (command.includes('-k')) expect(hot.total).toBe(0);
    }
    // the warm parent holds no workspace module, so an edit under the lane is seen at once
    copyFileSync(join(LADDER_DIR, 'account/gold/account.py'), join(fx.lane.dir, 'src/account.py'));
    const command = 'python3 -m pytest -q';
    const [hot, cold] = [await hotSummary(plane, fx.lane, command), await coldSummary(fx, command, fx.lane.dir)];
    expect(verdict(hot), 'gold').toEqual(verdict(cold));
    expect(hot.passed).toBeGreaterThan(0);
    expect(hot.failed).toBe(0);
    expect(plane.stats().invalidations).toBe(0);
    expect(plane.stats().fallbacks).toBe(0);
  }, 180_000);
});

describe.skipIf(!havePytest)('a runaway candidate is bounded the same way on both paths', () => {
  /**
   * The one place the warm path could out-grow the cold one: the cold run is capped at
   * `RUN_OUTPUT_BYTES` by `src/sandbox/run.ts`, and an uncapped warm run would serialise the
   * whole thing onto the fifo and into the harness process (measured before the cap: 25 MB of
   * stdout and +61 MB RSS for a single lane). It is also a verdict difference, not only a memory
   * one: a truncated cold run loses pytest's summary line, so `summarize` takes its "exit != 0
   * with no failing test" branch while the warm run parses cleanly.
   */
  let fx: WarmFixture;
  let plane: WarmPlane;
  beforeAll(() => {
    fx = warmFixture('jev-warm-loud-');
    mkdirSync(join(fx.lane.dir, 'tests'), { recursive: true });
    // ~2 MB on stdout, 8x the cap, with `-s` so pytest does not capture it
    writeFileSync(join(fx.lane.dir, 'tests/test_loud.py'), ['def test_loud():', '    line = "x" * 4095', '    for _ in range(500):', '        print(line)', '    assert True', ''].join('\n'));
    plane = new WarmPlane({ sandbox: fx.sandbox, signal: fx.signal, runDir: fx.runDir, workspaceRoot: fx.ws, mode: 'pytest', interpreter: 'python3', bootEnv: PY_ENV });
  });
  afterAll(() => {
    plane.dispose();
    fx.cleanup();
  });

  it('truncates at the same budget, with the same marker, and reaches the same verdict', async () => {
    const command = 'python3 -m pytest -q -s tests/test_loud.py';
    const hot = await plane.serve(fx.lane, command, 120_000, {});
    expect(hot, 'the plane refused to serve the loud command').not.toBeNull();
    const res = await fx.sandbox.run(command, { timeoutMs: 120_000, maxOutputBytes: WARM_OUTPUT_BYTES, signal: fx.signal, cwd: fx.lane.dir, env: { ...PY_ENV } });
    // both paths know they truncated, and neither carries more than the budget plus its tail
    expect(hot!.truncated).toBe(true);
    expect(res.truncated).toBe(true);
    expect(hot!.stdout.length).toBeLessThan(WARM_OUTPUT_BYTES + 64 * 1024);
    expect(hot!.stdout).toContain('[output truncated:');
    expect(res.stdout).toContain('[output truncated:');
    // and the truncation lands in the same place, so the two summarise identically
    expect(verdict(summarize(command, hot!, 1))).toEqual(verdict(summarize(command, res, 1)));
    expect(summarize(command, hot!, 1).passed).toBe(1);
  }, 180_000);
});
