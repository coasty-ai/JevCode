/**
 * Candidate verification on a repository workspace (oracle/verify.ts runRepositoryQueue) with a
 * fake lane pool and a fake sandbox: the reproduction gates the regression run, a pass is
 * confirmed by a second run in the same lane (pass/pass → plausible, pass/fail → unstable, never
 * regression-tested), statuses follow the code rules (plausible / unchanged / regressed), the
 * budget is charged per run, classified diffs are `tried`, carried and fresh jobs are dispatched
 * in rank order with the top-ranked job never deferred, the lanes' run times feed the load-aware
 * t_run, the regression-only mode (no oracle) treats every no-regression run as plausible, and
 * the lane environment points the module path at the lane.
 */
import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../../src/core/hash.js';
import type { ExecResult, SandboxRunOptions } from '../../../../../src/core/types.js';
import type { ReproSpec } from '../../../../../src/jev-modes/synth/oracle/goal.js';
import { REPRO_SENTINEL } from '../../../../../src/jev-modes/synth/oracle/runner.js';
import { mergeSummaries } from '../../../../../src/jev-modes/synth/oracle/search.js';
import { compareRank, isUnstableOutcome, laneEnv, runRepositoryQueue, runSamplesOf, UNSTABLE_ACTUAL_PREFIX } from '../../../../../src/jev-modes/synth/oracle/verify.js';
import { committedBase } from '../../../../../src/jev-modes/synth/search/index.js';
import type { Base, Lane, VerifyJob } from '../../../../../src/jev-modes/synth/search/types.js';
import type { LanePool } from '../../../../../src/jev-modes/synth/sieve/lanes.js';
import { VerifyQueue } from '../../../../../src/jev-modes/synth/sieve/queue.js';
import { MAX_FULL_SUITE_RUNS_PER_STEP } from '../../../../../src/jev-modes/synth/sieve/runner.js';
import type { RunnerContext, RunnerMemory } from '../../../../../src/jev-modes/synth/sieve/runner.js';
import type { AppliedCandidate, SourceFile } from '../../../../../src/jev-modes/synth/types.js';
import { GCD_BUGGY, cand, fakeBudget, fakeGoal, siteAt, sourceFile, summary } from '../search/controller-fakes.js';

const REPRO_ID = 'repro::abcd1234';
const SCOPED = 'python -m pytest -q -rA tests/test_gcd.py';
const spec: ReproSpec = { testId: REPRO_ID, chunks: ['from gcd import gcd', 'gcd(13, 13)'], criterion: { form: 'values', expected: [{ chunk: 'last', text: '13' }] }, expectedText: '13', blockIndex: 0, options: { packageName: 'gcd', framework: null, timeoutMs: 30_000 } };
const REPRO_MS = 610;
const REGRESSION_MS = 2000;

function exec(stdout: string, exitCode: number, durationMs = 50): ExecResult {
  return { ok: exitCode === 0, exitCode, signal: null, stdout, stderr: '', truncated: false, bytesSeen: stdout.length, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs };
}

function timedOut(durationMs: number): ExecResult {
  return { ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', truncated: false, bytesSeen: 0, killedBy: 'timeout', timedOut: true, orphans: [], sandboxExecDenied: false, durationMs };
}

function sentinel(value: string | null, exception: { type: string; message: string } | null): string {
  const results = [
    { chunk: 0, stmt: 0, source: 'from gcd import gcd', kind: 'stmt', value: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1 },
    { chunk: 1, stmt: 0, source: 'gcd(13, 13)', kind: 'expr', value, type_name: value === null ? null : 'int', stdout: '', exception: exception === null ? null : { ...exception, frames: [] }, fixup: null, environment: false, ms: 2 },
  ];
  return `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.9.6', results })}\n`;
}

const PASS = sentinel('13', null);
const FAIL = sentinel(null, { type: 'RecursionError', message: 'maximum recursion depth exceeded' });
const GREEN = '..                                                                       [100%]\n=========================== short test summary info ============================\nPASSED tests/test_gcd.py::test_gcd\nPASSED tests/test_gcd.py::test_other\n============================== 2 passed in 0.10s ===============================\n';
const REGRESSED = '.F                                                                       [100%]\n=========================== short test summary info ============================\nPASSED tests/test_gcd.py::test_gcd\nFAILED tests/test_gcd.py::test_other - assert 1 == 2\n========================= 1 failed, 1 passed in 0.10s ==========================\n';

interface Harness {
  ctx: RunnerContext;
  mem: RunnerMemory;
  jobs: VerifyJob[];
  base: Base;
  file: SourceFile;
  commands: { command: string; cwd: string | undefined; env: Record<string, string> | undefined; timeoutMs: number; text: string }[];
  applied: AppliedCandidate[];
  events: string[];
  /** the fake clock (ms), advanced by every fake run's duration */
  clock: () => number;
  job: (text: string, p: number) => VerifyJob;
}

interface HarnessOptions {
  runs?: number;
  wallMs?: number;
  lanes?: number;
  /** ms of real delay before a run whose candidate text carries `SLOW` answers (lets other lanes finish first) */
  slowMs?: number;
  /** durations of successive regression runs (the last one repeats) */
  regressionMs?: number[];
}

/**
 * Fake lanes at /lanes/laneN; the fake sandbox answers the reproduction from the candidate text
 * (FIX passes; FLAKY passes on its first run and fails on its second; else the buggy value) and the
 * regression run (BREAK regresses), honours the timeout it is given (a run longer than it is a
 * `timeout` kill), and advances the fake clock by the run's duration.
 */
function harness(texts: string[], o: HarnessOptions = {}): Harness {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const scoped = summary({ command: SCOPED, passing: ['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other'], failing: [], durationMs: 100 });
  const baseline = mergeSummaries(scoped, summary({ command: `python <${REPRO_ID}>`, failing: [REPRO_ID], failures: [{ testId: REPRO_ID, call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: x' }] }));
  const base = committedBase(new Map([[file.path, file]]), baseline);
  const job = (text: string, p: number): VerifyJob => ({ candidate: cand(siteAt(file, 5), text), base, p, sourcePrior: 1, key: [base.summary.passed, p, 1] });
  const jobs: VerifyJob[] = texts.map((t, i) => job(t, 0.9 - i * 0.1));
  const laneCount = o.lanes ?? 1;
  const lanes: Lane[] = Array.from({ length: laneCount }, (_, i) => ({ index: i, dir: `/lanes/lane${i}`, mode: 'worktree', busy: false }));
  const applied: AppliedCandidate[] = [];
  const onLane = new Map<string, string>();
  const pool: LanePool = {
    mode: 'worktree',
    lanes,
    workspaceRoot: '/work',
    pathInLane: (l, p) => `${l.dir}/${p}`,
    withLane: async (fn) => {
      const lane = lanes.find((l) => !l.busy);
      if (lane === undefined) throw new Error('no free lane');
      lane.busy = true;
      try {
        return await fn(lane);
      } finally {
        lane.busy = false;
      }
    },
    applyToLane: async (l, a) => {
      applied.push(a);
      onLane.set(l.dir, a.candidate.text);
    },
    resetLane: async () => undefined,
    disposeLanes: async () => undefined,
  };
  let clock = 0;
  const flakyRuns = new Map<string, number>();
  let regressions = 0;
  const commands: Harness['commands'] = [];
  const events: string[] = [];
  const ctx: RunnerContext = {
    runDir: '/runs/r',
    sandbox: {
      run: async (command: string, opts: SandboxRunOptions): Promise<ExecResult> => {
        const text = onLane.get(opts.cwd ?? '') ?? '';
        commands.push({ command, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, text });
        if (text.includes('SLOW') && o.slowMs !== undefined) await new Promise((r) => setTimeout(r, o.slowMs));
        let res: ExecResult;
        if (command.includes('<jevcode-repro>')) {
          let passes = text.includes('FIX');
          if (text.includes('FLAKY')) {
            const n = (flakyRuns.get(text) ?? 0) + 1;
            flakyRuns.set(text, n);
            passes = n % 2 === 1;
          }
          res = exec(passes ? PASS : FAIL, 0, REPRO_MS);
        } else {
          const ms = o.regressionMs === undefined ? REGRESSION_MS : (o.regressionMs[Math.min(regressions, o.regressionMs.length - 1)] ?? REGRESSION_MS);
          regressions += 1;
          res = exec(text.includes('BREAK') ? REGRESSED : GREEN, text.includes('BREAK') ? 1 : 0, ms);
        }
        if (res.durationMs > opts.timeoutMs) res = timedOut(opts.timeoutMs);
        clock += res.durationMs;
        return res;
      },
    },
    signal: new AbortController().signal,
    workspaceInfo: { root: '/work', git: true },
    step: 3,
    emit: (e) => {
      events.push(`${e.phase}: ${e.detail}`);
    },
  };
  const mem: RunnerMemory = { baseline, oracle: { runner: 'pytest', lanes: laneCount, tRunMs: { goalSubset: 600, fullSuite: 2000 }, perTestTimeoutMs: null, runTimeoutMs: 60_000, baselineDurationMs: 2000 }, stepBudget: fakeBudget({ runs: o.runs ?? 16, wallMs: o.wallMs ?? 600_000 }), tried: new Set(), lanes: pool };
  return { ctx, mem, jobs, base, file, commands, applied, events, clock: () => clock, job };
}

const queueOf = (h: Harness): { pop: (n: number) => VerifyJob[] } => ({ pop: (n) => h.jobs.splice(0, n) });
const run = (h: Harness, runsAllowed: number, over: { spec?: ReproSpec | null; regression?: { command: string | null; timeoutMs: number }; python?: string } = {}) =>
  runRepositoryQueue(h.ctx, h.mem, queueOf(h), fakeGoal({ id: 'g1', tests: [REPRO_ID] }), runsAllowed, { spec: over.spec === undefined ? spec : over.spec, regression: over.regression ?? { command: SCOPED, timeoutMs: 120_000 }, now: h.clock, ...(over.python === undefined ? {} : { python: over.python }) });

describe('runRepositoryQueue with a reproduction', () => {
  it('a candidate that passes the reproduction twice gets the scoped regression run: plausible, full = scoped + reproduction, three runs charged', async () => {
    const h = harness(['return gcd(b, a % b)  # FIX']);
    const out = await run(h, 1, { python: '/work/.venv/bin/python' });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.status).toBe('plausible');
    expect(isUnstableOutcome(o)).toBe(false);
    expect(o.subset).toMatchObject({ passed: 1, failed: 0, passing: [REPRO_ID] });
    expect(o.full).toMatchObject({ passed: 3, failed: 0, total: 3 });
    expect(o.full?.passing).toEqual(['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other', REPRO_ID]);
    expect(o.progress.newlyPassing).toEqual([REPRO_ID]);
    expect(o.progress.regressed).toBe(false);
    // the reproduction, its confirmation run and the regression run: 3 of 16
    expect(h.mem.stepBudget.testRunsLeft).toBe(13);
    expect(h.mem.tried.has(sha12(o.applied.diff))).toBe(true);
    // the reproduction ran twice first, with the venv python and cwd = lane; the regression command third, with the lane on the module path
    expect(h.commands.map((c) => c.cwd)).toEqual(['/lanes/lane0', '/lanes/lane0', '/lanes/lane0']);
    expect(h.commands[0]?.command).toContain("'/work/.venv/bin/python' -c");
    expect(h.commands[1]?.command).toBe(h.commands[0]?.command);
    expect(h.commands[2]?.command).toBe(SCOPED);
    expect(h.commands[2]?.env).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/lanes/lane0' });
    // the oracle learnt the measured reproduction and regression times (this batch's medians: too few samples for the live windows)
    expect(h.mem.oracle.tRunMs).toEqual({ goalSubset: REPRO_MS, fullSuite: REGRESSION_MS });
    expect(runSamplesOf(h.mem)).toEqual({ repro: [REPRO_MS, REPRO_MS], scoped: [REGRESSION_MS] });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatch(/^verify: g1: 1 tested on 1 lane \(1 plausible\); reproduction repro::abcd1234 \(a pass confirmed by a second run\) then regression/);
    expect(h.events[0]).toContain('t_run reproduction 610 ms, scoped 2000 ms');
  });
  it('a candidate that fails the reproduction is unchanged, costs one run and no regression run; a passer that breaks a scoped test is regressed', async () => {
    const h = harness(['return gcd(a % b, a)', 'return gcd(b, a % b)  # FIX BREAK']);
    const out = await run(h, 2);
    expect(out.map((o) => o.status)).toEqual(['unchanged', 'regressed']);
    expect(out[0]?.full).toBeUndefined();
    expect(out[0]?.progress.newlyPassing).toEqual([]);
    expect(isUnstableOutcome(out[0]!)).toBe(false);
    expect(out[1]?.progress.newlyFailing).toEqual(['tests/test_gcd.py::test_other']);
    expect(out[1]?.progress.regressed).toBe(true);
    expect(h.mem.stepBudget.testRunsLeft).toBe(12); // 1 + (1 + 1 + 1)
    expect(h.commands).toHaveLength(4);
    expect(h.mem.tried.size).toBe(2);
    // without a python the runner's own pick is in the command
    expect(h.commands[0]?.command).toContain('.venv/bin/python; else JEV_PY=python3');
  });
  it('pass then fail in the same lane is unstable: classified unchanged, marked in the failure text and the event, tried, never regression-tested', async () => {
    const h = harness(['return gcd(b, a % b)  # FLAKY', 'return gcd(a % b, a)']);
    const out = await run(h, 2);
    expect(out.map((o) => o.status)).toEqual(['unchanged', 'unchanged']);
    const flaky = out[0]!;
    expect(isUnstableOutcome(flaky)).toBe(true);
    expect(flaky.full).toBeUndefined();
    expect(flaky.subset.failures[0]?.actual.startsWith(UNSTABLE_ACTUAL_PREFIX)).toBe(true);
    expect(flaky.subset.failures[0]?.actual).toContain('passed once (13)');
    expect(flaky.subset.failures[0]?.actual).toContain('RecursionError');
    expect(flaky.progress.newlyPassing).toEqual([]);
    expect(isUnstableOutcome(out[1]!)).toBe(false);
    // two reproduction runs for the flaky one, one for the other; no scoped command at all
    expect(h.commands.filter((c) => c.command === SCOPED)).toHaveLength(0);
    expect(h.commands).toHaveLength(3);
    expect(h.mem.stepBudget.testRunsLeft).toBe(13);
    expect(h.mem.tried.has(sha12(flaky.applied.diff))).toBe(true);
    expect(h.events[0]).toContain('(1 unstable, 1 unchanged)');
    expect(h.events[0]).toContain('1 passed once and failed the confirmation run (unstable, not regression-tested)');
  });
  it('honours runsAllowed and the run budget: the rest is deferred under the goal', async () => {
    const h = harness(['a', 'b', 'c'], { runs: 1 });
    const out = await run(h, 3);
    expect(out).toHaveLength(1);
    expect(h.mem.stepBudget.testRunsLeft).toBe(0);
    // the remaining jobs were never popped (dispatch stopped on the budget), nothing deferred from a started run
    expect(h.jobs).toHaveLength(2);
    expect(h.mem.deferred?.get('g1')).toEqual([]);
  });
});

describe('rank order and the top-ranked job (sympy-19954, rung 3 §21.6 item 2)', () => {
  it('compareRank orders by key descending: the base\'s passing count, then p, then the source prior', () => {
    const k = (key: [number, number, number]): { key: [number, number, number] } => ({ key });
    expect(compareRank(k([2, 0.5, 1]), k([2, 0.9, 1]))).toBeGreaterThan(0);
    expect(compareRank(k([2, 0.9, 1]), k([2, 0.5, 1]))).toBeLessThan(0);
    expect(compareRank(k([3, 0.1, 1]), k([2, 0.9, 1]))).toBeLessThan(0);
    expect(compareRank(k([2, 0.5, 2]), k([2, 0.5, 1]))).toBeLessThan(0);
    expect(compareRank(k([2, 0.5, 1]), k([2, 0.5, 1]))).toBe(0);
  });
  it('carried (deferred) jobs and fresh jobs are dispatched in rank order, not carried-first; ties keep the carried job first', async () => {
    const h = harness([]);
    const carriedLow = h.job('carried p=0.3', 0.3);
    const carriedMid = h.job('carried p=0.6', 0.6);
    const carriedTie = h.job('carried p=0.5 (tie)', 0.5);
    h.mem.deferred = new Map([['g1', [carriedLow, carriedMid, carriedTie]]]);
    h.jobs.push(h.job('fresh p=0.9', 0.9), h.job('fresh p=0.5 (tie)', 0.5), h.job('fresh p=0.4', 0.4));
    const out = await run(h, 6);
    expect(out.map((o) => o.applied.candidate.text)).toEqual(['fresh p=0.9', 'carried p=0.6', 'carried p=0.5 (tie)', 'fresh p=0.5 (tie)', 'fresh p=0.4', 'carried p=0.3']);
    expect(h.mem.deferred.get('g1')).toEqual([]);
  });
  it('a fresh job popped ahead of a higher-ranked carried one is not lost when dispatch stops: it waits under the goal, in rank order', async () => {
    const h = harness([], { runs: 1 });
    h.mem.deferred = new Map([['g1', [h.job('carried p=0.8', 0.8)]]]);
    h.jobs.push(h.job('fresh p=0.7', 0.7), h.job('fresh p=0.2', 0.2));
    const out = await run(h, 3);
    expect(out.map((o) => o.applied.candidate.text)).toEqual(['carried p=0.8']);
    expect(h.mem.deferred.get('g1')?.map((j) => j.candidate.text)).toEqual(['fresh p=0.7']);
    expect(h.jobs.map((j) => j.candidate.text)).toEqual(['fresh p=0.2']);
  });
  it('the #1 is dispatched before any deferral: the regression slots go to passers in rank order, whatever order the lanes finish in', async () => {
    // 8 lanes; the top-ranked passer answers slowly, six faster passers race it for the five regression slots
    const h = harness(['return gcd(b, a % b)  # FIX SLOW', 'p8 FIX', 'p7 FIX', 'p6 FIX', 'p5 FIX', 'p4 FIX', 'p3 FIX'], { lanes: 8, slowMs: 15, runs: 100 });
    const out = await run(h, 7);
    const top = out.find((o) => o.applied.candidate.text.includes('SLOW'));
    expect(top?.status).toBe('plausible');
    expect(out.filter((o) => o.status === 'plausible')).toHaveLength(MAX_FULL_SUITE_RUNS_PER_STEP);
    // the two lowest-ranked passers are the deferred ones: the slots were admitted by rank, not by who finished first
    const deferred = h.mem.deferred?.get('g1') ?? [];
    expect(deferred.map((j) => j.candidate.text)).toEqual(['p4 FIX', 'p3 FIX']);
    expect(h.events[0]).toContain('5 plausible');
    expect(h.events[0]).toContain('2 deferred');
    // the same race with the slow job ranked second and the top failing the reproduction: the top settles, the slots go p-first
    const h2 = harness(['return gcd(a % b, a)', 'second FIX SLOW', 'p7 FIX', 'p6 FIX', 'p5 FIX', 'p4 FIX', 'p3 FIX'], { lanes: 8, slowMs: 15, runs: 100 });
    const out2 = await run(h2, 7);
    expect(out2.find((o) => o.applied.candidate.text.includes('SLOW'))?.status).toBe('plausible');
    expect(out2.filter((o) => o.status === 'plausible')).toHaveLength(MAX_FULL_SUITE_RUNS_PER_STEP);
    expect(h2.mem.deferred?.get('g1')?.map((j) => j.candidate.text)).toEqual(['p3 FIX']);
  });
  it('the top job\'s runs are not cut by the step\'s wall (a step may overrun by one in-flight run); every other job\'s are', async () => {
    // 3 s of wall: the reproduction twice (1.22 s) plus a 2 s regression run overrun it
    const top = harness(['return gcd(b, a % b)  # FIX', 'second FIX'], { wallMs: 3000 });
    const out = await run(top, 2);
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    expect(top.commands[2]?.timeoutMs).toBe(120_000);
    expect(top.mem.deferred?.get('g1')).toEqual([]);
    // the wall was gone after the top: the second job was never popped
    expect(top.jobs).toHaveLength(1);
    expect(top.mem.stepBudget.testWallLeftMs).toBe(0);
    // the same wall, the passer ranked second: its regression run is cut to the wall left, aborted and deferred
    const second = harness(['return gcd(a % b, a)', 'return gcd(b, a % b)  # FIX'], { wallMs: 3000 });
    const out2 = await run(second, 2);
    expect(out2.map((o) => o.status)).toEqual(['unchanged']);
    expect(second.commands[3]?.command).toBe(SCOPED);
    expect(second.commands[3]?.timeoutMs).toBe(3000 - 3 * REPRO_MS);
    expect(second.mem.deferred?.get('g1')?.map((j) => j.candidate.text)).toEqual(['return gcd(b, a % b)  # FIX']);
    expect(second.events[0]).toContain('1 deferred');
  });
});

describe('load-aware t_run from the lanes\' running measurements', () => {
  it('after three scoped runs the oracle\'s fullSuite is the window median, and one later slow run cannot set it; the reproduction window likewise', async () => {
    const h = harness(['a FIX', 'b FIX', 'c FIX'], { runs: 100, regressionMs: [2000, 2200, 2100, 9000] });
    await run(h, 3);
    expect(runSamplesOf(h.mem)).toEqual({ repro: [610, 610, 610, 610, 610, 610], scoped: [2000, 2200, 2100] });
    expect(h.mem.oracle.tRunMs).toEqual({ goalSubset: 610, fullSuite: 2100 });
    expect(h.events[0]).toContain('t_run reproduction 610 ms (live), scoped 2100 ms (live)');
    // the next call for the goal: a 9 s regression run enters the window of 4 → the median 2150, not 9000
    h.jobs.push(h.job('d FIX', 0.5));
    h.mem.stepBudget = fakeBudget({ runs: 100, wallMs: 600_000 });
    await run(h, 1);
    expect(runSamplesOf(h.mem).scoped).toEqual([2000, 2200, 2100, 9000]);
    expect(h.mem.oracle.tRunMs.fullSuite).toBe(2150);
    expect(h.events[1]).toContain('regression run median 9000 ms');
    expect(h.events[1]).toContain('scoped 2150 ms (live)');
  });
});

describe('runRepositoryQueue without a reproduction (best guess)', () => {
  it('every candidate gets the scoped run alone; nothing newly failing is plausible, a newly failing test is regressed', async () => {
    const h = harness(['return gcd(b, a % b)', 'return gcd(b, a % b)  # BREAK']);
    // a best-guess base has no reproduction test in its baseline
    const scoped = summary({ command: SCOPED, passing: ['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other'], failing: [], durationMs: 100 });
    h.mem.baseline = scoped;
    for (const j of h.jobs) j.base = { ...j.base, summary: scoped };
    const out = await runRepositoryQueue(h.ctx, h.mem, queueOf(h), fakeGoal({ id: 'g1', tests: ['issue::00000000'] }), 2, { spec: null, regression: { command: SCOPED, timeoutMs: 120_000 }, now: h.clock });
    expect(out.map((o) => o.status)).toEqual(['plausible', 'regressed']);
    expect(out[0]?.full).toMatchObject({ passed: 2, failed: 0 });
    expect(out[0]?.subset).toBe(out[0]?.full);
    expect(out[0]?.progress.newlyPassing).toEqual([]);
    expect(out[1]?.progress.newlyFailing).toEqual(['tests/test_gcd.py::test_other']);
    expect(h.commands.every((c) => c.command === SCOPED)).toBe(true);
    expect(h.mem.stepBudget.testRunsLeft).toBe(14);
    expect(h.events[0]).toContain('regression only');
  });
});

describe('the awaitable queue (docs/LLM-JEV-DESIGN.md §4.8)', () => {
  it('a worker with nothing to pop awaits `next()` and runs the job that lands later', async () => {
    const h = harness([]);
    const gate: { resolve: ((j: VerifyJob | null) => void) | null } = { resolve: null };
    const queue = {
      pop: (n: number) => h.jobs.splice(0, n),
      next: () =>
        new Promise<VerifyJob | null>((resolve) => {
          gate.resolve = resolve;
        }),
    };
    const running = runRepositoryQueue(h.ctx, h.mem, queue, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 1, { spec, regression: { command: SCOPED, timeoutMs: 120_000 }, now: h.clock });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.resolve).not.toBeNull();
    expect(h.commands).toHaveLength(0);
    gate.resolve?.(h.job('late FIX', 0.9));
    const out = await running;
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    // the one job cost the reproduction, its confirmation re-run and the scoped regression
    expect(h.mem.stepBudget.testRunsLeft).toBe(16 - 3);
  });

  const HUNG = 'hung';
  const bounded = <T>(p: Promise<T>, ms = 3000): Promise<T | typeof HUNG> => Promise.race([p, new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms))]);
  const opts = (h: Harness) => ({ spec, regression: { command: SCOPED, timeoutMs: 120_000 }, now: h.clock });

  it('a batch begun while the queue streams ends on its first plausible (§4.2, §6.2): the parked worker is released without closing the stream, the passer is returned at once and a later arrival waits for the next call', async () => {
    const h = harness([], { lanes: 2 });
    const q = new VerifyQueue();
    q.open();
    q.add(h.job('return gcd(b, a % b)  # FIX', 0.9));
    // worker 1 runs the passer (reproduction, confirmation, regression); worker 2 parks on `next()` and would wait for the close
    const out = await bounded(runRepositoryQueue(h.ctx, h.mem, q, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 4, opts(h)));
    expect(out).not.toBe(HUNG);
    if (out === HUNG) return;
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    expect(q.streaming).toBe(true);
    expect(h.events[0]).toMatch(/streamed batch ended on its first passer/);
    expect(h.mem.passersThisStep).toBe(1);
    // a sample landing after the stop stays queued for the next call (the guard may hold and re-enter the stream)
    q.add(h.job('return gcd(a, b)  # other', 0.8));
    expect(q.size).toBe(1);
    q.close();
    const again = await runRepositoryQueue(h.ctx, h.mem, q, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 4, opts(h));
    expect(again.map((o) => o.status)).toEqual(['unchanged']);
  });

  it('the wall rule releases a worker parked in next(): when the wall left no longer fits one reproduction run the batch returns without waiting for the close', async () => {
    // t_repro 600 ms against a 700 ms wall: the park ends after ≈ 100 ms, nothing ran, the stream is untouched
    const h = harness([], { wallMs: 700 });
    const q = new VerifyQueue();
    q.open();
    const t0 = Date.now();
    const out = await bounded(runRepositoryQueue(h.ctx, h.mem, q, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 4, opts(h)));
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(q.streaming).toBe(true);
    expect(h.commands).toHaveLength(0);
  });
});

describe('laneEnv', () => {
  it('puts the lane (and its src/ when the checkout has one) first on the module path, no bytecode', () => {
    const lane: Lane = { index: 2, dir: '/runs/r/tmp/synth/lane2', mode: 'worktree', busy: false };
    expect(laneEnv(lane, false)).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/runs/r/tmp/synth/lane2' });
    expect(laneEnv(lane, true)).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/runs/r/tmp/synth/lane2/src:/runs/r/tmp/synth/lane2' });
  });
});
