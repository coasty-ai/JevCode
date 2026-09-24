/**
 * OOS iteration 2, defect 1 (experiments/results/llm-jev-iter2.md §7.3, §10): the sieve's t_run
 * calibration sample under the warm verification plane, replayed from the recorded batch.
 *
 * What was measured, same task, same build, same step-1 batch of 185 candidates of QuixBugs
 * `topological_ordering`, three of which diverge:
 *
 *   warm OFF  185 tested (182 unchanged, 3 timeout); test wall left 65 s; run median   510 ms, t_run   510 ms
 *   warm ON   185 tested (182 unchanged, 3 timeout); test wall left 57 s; run median 11655 ms, t_run 11655 ms;
 *                                                    warm 185/185, screen 84973 ms, 3 deadline rechecks cold
 *
 * and four batches later, the step's test wall spent: `0 tested on 8 lanes (nothing ran)`, twelve
 * times over. `topological_ordering` was lost twice independently and `shortest_path_length` once,
 * and that pass loss is the only reason `JEVCODE_WARM` is still off by default.
 *
 * The cause is not the transport: `runQueue` taught the oracle from cold runs only, and with the
 * plane on the ONLY candidates that reach the cold path are the ones whose hot screen hit a
 * deadline and was therefore discarded (`newDeadlineHit` → `deadlineRecheck()`). The sample became
 * a sample of nothing but timeouts. So:
 *
 *   1. a deadline re-run teaches nothing at all — a timeout is a bound, not a measurement;
 *   2. a hot screen teaches, as a COLD-EQUIVALENT duration (it is a real run of the same case set
 *      at the same per-case cap; the one thing it does not pay is process start, and
 *      `PROCESS_OVERHEAD_MS` is the harness's own measurement of that);
 *   3. the wall a screen is given is not the lane RUN cap but the cold path's own case-derived
 *      bound, because a screen that hits a deadline is thrown away and paid for twice.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASE_TIMEOUT_MS, laneRunTimeout, PROCESS_OVERHEAD_MS, RUN_TIMEOUT_FACTOR } from '../../../../../src/jev-modes/synth/search/budget.js';
import type { Lane, VerifyJob } from '../../../../../src/jev-modes/synth/search/types.js';
import { runQueue, type RunnerContext, type RunnerMemory } from '../../../../../src/jev-modes/synth/sieve/runner.js';
import { emptyWarmStats, type WarmRunResult, type WarmScreen, type WarmStats } from '../../../../../src/jev-modes/synth/warm/index.js';
import { base, budget, candidate, fakeSandbox, fifoQueue, GCD_BASELINE, GCD_BUGGY, GCD_TESTS, goal, job, oracle, runTestsJson, site, sourceFile } from './helpers.js';

// the warm plane is OFF by default; this file drives the warm path, so it opts in for its own duration
const PREV_JEVCODE_WARM = process.env['JEVCODE_WARM'];
beforeAll(() => {
  process.env['JEVCODE_WARM'] = 'on';
});
afterAll(() => {
  if (PREV_JEVCODE_WARM === undefined) delete process.env['JEVCODE_WARM'];
  else process.env['JEVCODE_WARM'] = PREV_JEVCODE_WARM;
});

let tmp: string;
let ws: string;
let runDir: string;
const emitted: string[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-trun-'));
  ws = join(tmp, 'ws');
  runDir = join(tmp, 'run');
  mkdirSync(ws);
  mkdirSync(runDir);
  writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
  emitted.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gcd = sourceFile('gcd.py', GCD_BUGGY);
const GOAL = goal(GCD_TESTS);
const b0 = base([gcd], GCD_BASELINE);
/** the whole 6-case suite still failing the same way: `unchanged`, which is what 182 of the 185 were */
const UNCHANGED = runTestsJson([[13, 13], [37, 600], [20, 100], [624129, 2061517], [3, 12]]);

/** The recorded batch's numbers. */
const HOT_MS = 275; // 84,973 ms of screen over the 182 that answered
const COLD_RECHECK_MS = 11_655; // the run median the warm arm taught; the lane cap, not a measurement
const COLD_MS = 510; // what the identical batch measured cold, and what t_run must stay near

/** A warm screen whose answers the test fixes, recording the deadline every offer was given. */
function scriptedScreen(answer: (command: string, n: number) => WarmRunResult | null): WarmScreen & { deadlines: number[]; counts: WarmStats } {
  const counts: WarmStats = emptyWarmStats();
  let off = false;
  const s = {
    deadlines: [] as number[],
    counts,
    get disabled(): boolean {
      return off;
    },
    async serve(_lane: Lane, command: string, deadlineMs: number): Promise<WarmRunResult | null> {
      if (off) return null;
      s.deadlines.push(deadlineMs);
      const r = answer(command, s.deadlines.length);
      counts.offered += 1;
      if (r !== null) {
        counts.screened += 1;
        counts.screenMs += r.durationMs;
      }
      return r;
    },
    confirmed(ms: number): void {
      counts.confirmed += 1;
      counts.confirmMs += ms;
    },
    mismatch(): void {
      counts.mismatches += 1;
      off = true;
    },
    scopeUnusable(): void {
      counts.scopeUnusable += 1;
    },
    deadlineRecheck(): void {
      counts.deadlineRechecks += 1;
    },
    stats: (): WarmStats => ({ ...counts }),
    dispose(): void {
      off = true;
    },
  };
  return s;
}

function ctxFor(sandbox: ReturnType<typeof fakeSandbox>): RunnerContext {
  return { runDir, sandbox, signal: new AbortController().signal, workspaceInfo: { root: ws, git: false }, step: 1, emit: (e) => emitted.push(e.detail) };
}

const hot = (stdout: string, exitCode: number, durationMs: number, timedOut = false): WarmRunResult => ({ stdout, stderr: '', exitCode, timedOut, truncated: false, durationMs });

/** `n` distinct no-op candidates, of which the last `diverging` are the slow ones. */
function jobsFor(n: number): VerifyJob[] {
  return Array.from({ length: n }, (_, i) => job(candidate(site(gcd, 2), `return a % b  # ${i}`), b0));
}

describe('the t_run calibration sample under the warm plane (iteration-2 defect 1)', () => {
  /**
   * The recorded shape: most of the batch answers warm and is `unchanged`; the diverging few time
   * out hot, are discarded, and cost a lane cap cold. Before the fix `subsetDurations` held those
   * three cold re-runs and nothing else.
   */
  function replayBatch(total: number, diverging: number): { mem: RunnerMemory; ctx: RunnerContext; queue: ReturnType<typeof fifoQueue>; screen: ReturnType<typeof scriptedScreen> } {
    const isSlow = (n: number): boolean => n > total - diverging;
    const screen = scriptedScreen((_c, n) => (isSlow(n) ? hot(UNCHANGED, 1, COLD_RECHECK_MS, true) : hot(UNCHANGED, 1, HOT_MS)));
    let cold = 0;
    const sandbox = fakeSandbox((command) => {
      if (!/run_tests\.py/.test(command)) return {};
      cold += 1;
      // every cold run of this batch is a deadline re-run of a diverging candidate: it costs the
      // lane cap, exactly as the three recorded ones did
      return { stdout: UNCHANGED, exitCode: 1, durationMs: COLD_RECHECK_MS };
    });
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1, tRunMs: { goalSubset: COLD_MS, fullSuite: COLD_MS }, perTestTimeoutMs: 500 }), stepBudget: budget(), tried: new Set(), warm: screen };
    return { mem, ctx: ctxFor(sandbox), queue: fifoQueue(jobsFor(total)), screen };
  }

  it('never teaches t_run from the deadline re-runs the discarded screens fell through to', async () => {
    const { mem, ctx, queue, screen } = replayBatch(20, 3);
    const out = await runQueue(ctx, mem, queue, GOAL, 20);
    expect(out).toHaveLength(20);
    expect(screen.counts.deadlineRechecks).toBe(3);
    // THE recorded regression: before the fix the 3 re-runs were the whole sample and t_run became
    // 11,655 ms on a batch the cold arm measured at 510 ms
    expect(mem.oracle.tRunMs.goalSubset).not.toBe(COLD_RECHECK_MS);
    expect(mem.oracle.tRunMs.goalSubset).toBe(COLD_MS);
    // the 17 hot screens are kept, as lower bounds, and the event says the bound is a bound
    expect(emitted.join('\n')).toContain(`run median \u2265 ${HOT_MS + PROCESS_OVERHEAD_MS} ms hot`);
    expect(emitted.join('\n')).toContain(`t_run ${COLD_MS} ms`);
  });

  it('a batch in which EVERY screen hits the deadline leaves t_run where the oracle fitted it', async () => {
    // the pathological end of the same defect: nothing measured anything, so nothing may move an
    // estimate that sizes lane timeouts, `minRunWallMs` and the run plan
    const { mem, ctx, queue, screen } = replayBatch(6, 6);
    await runQueue(ctx, mem, queue, GOAL, 6);
    expect(screen.counts.deadlineRechecks).toBe(6);
    expect(mem.oracle.tRunMs.goalSubset).toBe(COLD_MS);
    expect(emitted.join('\n')).not.toContain('run median');
  });

  it('a hot sample may RAISE t_run — loaded lanes are still loaded when the runs are warm', async () => {
    // the other half of "the sample must be representative": a hot batch that really is slow must
    // grow the lane timeouts, or a loaded step classifies live candidates as hangs
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, 3_000));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1, tRunMs: { goalSubset: COLD_MS, fullSuite: COLD_MS }, perTestTimeoutMs: 500 }), stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(5)), GOAL, 5);
    expect(mem.oracle.tRunMs.goalSubset).toBe(3_000 + PROCESS_OVERHEAD_MS);
  });

  it('a cheap hot sample may never LOWER a cold estimate: the run budget is still priced on cold runs', async () => {
    // the invariant test/unit/jev-modes/synth/sieve/screen-confirm-budget.test.ts pins from the other side.
    // A screen skips more than process start (in pytest mode the warm parent has already imported
    // the suite), so pricing `runsLeft` on it would sieve pools only the SCREEN can afford.
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, 4));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1, tRunMs: { goalSubset: 1_574, fullSuite: 1_574 }, perTestTimeoutMs: 500 }), stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(5)), GOAL, 5);
    expect(mem.oracle.tRunMs.goalSubset).toBe(1_574);
  });

  it('a real cold batch is unchanged: the plane off, every duration still teaches', async () => {
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 700 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1, tRunMs: { goalSubset: COLD_MS, fullSuite: COLD_MS }, perTestTimeoutMs: 500 }), stepBudget: budget(), tried: new Set() };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(5)), GOAL, 5);
    expect(mem.oracle.tRunMs.goalSubset).toBe(700);
  });
});

describe('the wall one hot screen is given (iteration-2 defect 1, the compounding half)', () => {
  it('is the cold path’s own case-derived bound, not the lane RUN cap the screen used to get', async () => {
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, HOT_MS));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const o = oracle({ lanes: 1, tRunMs: { goalSubset: 510, fullSuite: 510 }, perTestTimeoutMs: 500, runTimeoutMs: 120_000 });
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: o, stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(1)), GOAL, 1);
    expect(screen.deadlines).toHaveLength(1);
    // the same per-case cap the cold path runs under, on the lane run timeout's own shape, with
    // the cold path's 10 s process-start slack dropped: a warm run pays no process start
    expect(screen.deadlines[0]).toBe(RUN_TIMEOUT_FACTOR * 510 + 500);
    // the recorded defect: the screen used to be handed `capMs()`, the lane run cap — ~14 s where
    // the cold run of the same candidate costs ~0.5 s, and the step paid the 14 s *and* the re-run
    expect(screen.deadlines[0]).toBeLessThan(laneRunTimeout(o, GCD_BASELINE));
  });

  it('follows the per-case cap in force, so the screen is bounded exactly as the cold run is', async () => {
    // the sieve's adapted cap (`RunSettings.caseTimeoutMs`), not the oracle's idle one
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, HOT_MS));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const o = oracle({ lanes: 1, tRunMs: { goalSubset: 510, fullSuite: 510 }, perTestTimeoutMs: 1426, runTimeoutMs: 120_000 });
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: o, stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(1)), GOAL, 1);
    expect(screen.deadlines[0]).toBe(RUN_TIMEOUT_FACTOR * 510 + 1426);
  });

  it('never exceeds the cold cap the caller would have used, and never falls below a second', async () => {
    // a wall short enough to bound the cold run bounds the screen too
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, HOT_MS));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const o = oracle({ lanes: 1, tRunMs: { goalSubset: 510, fullSuite: 510 }, perTestTimeoutMs: 500, runTimeoutMs: 120_000 });
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: o, stepBudget: budget({ testWallLeftMs: 900 }), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(1)), GOAL, 1);
    expect(screen.deadlines[0]).toBeLessThanOrEqual(900);

    // and an under-fitted t_run must not deadline every screen: the floor is the cold path's own
    const screen2 = scriptedScreen(() => hot(UNCHANGED, 1, HOT_MS));
    const sandbox2 = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const o2 = oracle({ lanes: 1, tRunMs: { goalSubset: 5, fullSuite: 5 }, perTestTimeoutMs: null, runner: 'quixbugs', runTimeoutMs: 120_000 });
    const mem2: RunnerMemory = { baseline: GCD_BASELINE, oracle: o2, stepBudget: budget(), tried: new Set(), warm: screen2 };
    await runQueue(ctxFor(sandbox2), mem2, fifoQueue(jobsFor(1)), GOAL, 1);
    expect(screen2.deadlines[0]).toBe(Math.max(1000, RUN_TIMEOUT_FACTOR * 5 + DEFAULT_CASE_TIMEOUT_MS));
  });

  it('a hot run killed on that wall is never a verdict, even when the baseline times out too', async () => {
    // the screen bound is tighter than the cold cap, so a whole-run kill says nothing about the
    // candidate: `newDeadlineHit` alone would have accepted it as `timeout` against a timed-out
    // baseline, marking it `tried` on a wall the cold path never applied
    const timedOutBaseline = { ...GCD_BASELINE, timedOut: true };
    const screen = scriptedScreen(() => hot(UNCHANGED, 1, HOT_MS, true));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const o = oracle({ lanes: 1, tRunMs: { goalSubset: 510, fullSuite: 510 }, perTestTimeoutMs: 500, runTimeoutMs: 120_000 });
    const mem: RunnerMemory = { baseline: timedOutBaseline, oracle: o, stepBudget: budget(), tried: new Set(), warm: screen };
    const out = await runQueue(ctxFor(sandbox), mem, fifoQueue([job(candidate(site(gcd, 2), 'return a % b'), base([gcd], timedOutBaseline))]), GOAL, 1);
    expect(screen.counts.deadlineRechecks).toBe(1);
    expect(out[0]?.screened).toBeUndefined();
    expect(out[0]?.subset.durationMs).toBe(400);
  });
});
