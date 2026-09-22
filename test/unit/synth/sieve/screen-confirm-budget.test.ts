/**
 * Where the S1 warm plane (HARNESS-NEXT §3 M6, screen hot / confirm cold) meets the OOS
 * iteration-1 run-budget gate (docs/research/llm-jev/oos-analysis-2026-09-22.md ranked change 1).
 *
 * Change 1 made ONE budget comparison the whole SIEVE/RANK cut and the whole `q17Needed` test:
 * `poolFitsRunBudget(n, runsLeft)` — "can the goal test decide every candidate inside the runs
 * this step still has?" If it can, the pool is run and no ranking request is spent, because the
 * first passer arrives before any order is consulted. That makes the gate depend on exactly two
 * things, and the warm plane could corrupt either:
 *
 *  1. WHAT COUNTS AS A PASSER. A warm screen is not one. S1 re-verifies every `plausible` whose
 *     runs touched a warm worker with a cold, fresh-spawn full-suite run before it leaves
 *     `runQueue`, and defers it outright when no run is left for the confirmation — so the passer
 *     that ends a SIEVE sweep early is always cold-confirmed. Asserted here at the seam the gate
 *     reads, `VerifyOutcome.status`, not just inside the runner.
 *
 *  2. WHAT `runsLeft` IS PRICED ON. `runsLeft` divides the wall left by `oracle.tRunMs.goalSubset`
 *     at the current lane count, so if a warm screen's ~4 ms ever reached that median the gate
 *     would send pools to SIEVE that only the SCREEN can afford, while every confirmation is
 *     still a cold run. `runner.ts` excludes warm durations from both medians
 *     (`if (mode === 'first' && !sub.warm)` for the subset, `!f.warm` for the full suite); this
 *     pins that, because it is the one S1 detail the gate silently depends on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Lane } from '../../../../src/synth/search/types.js';
import { runQueue, type RunnerContext, type RunnerMemory } from '../../../../src/synth/sieve/runner.js';
import { poolFitsRunBudget, runsLeft } from '../../../../src/synth/search/budget.js';
import { emptyWarmStats, type WarmRunResult, type WarmScreen, type WarmStats } from '../../../../src/synth/warm/index.js';
import { base, budget, candidate, fakeSandbox, fifoQueue, GCD_BASELINE, GCD_BUGGY, GCD_TESTS, goal, job, oracle, runTestsJson, site, sourceFile } from './helpers.js';

// 2026-09-22: the warm plane is OFF by default (it wedged llm-jev runs on the merged tree); these cases exercise the
// warm path, so the file opts in for its own duration and restores the caller's environment afterwards.
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
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-screen-budget-'));
  ws = join(tmp, 'ws');
  runDir = join(tmp, 'run');
  mkdirSync(ws);
  mkdirSync(runDir);
  writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gcd = sourceFile('gcd.py', GCD_BUGGY);
const GOAL = goal(GCD_TESTS);
const b0 = base([gcd], GCD_BASELINE);
const PASSING = runTestsJson([]);
const FAILING = runTestsJson([[13, 13]]);

/** A warm screen that answers `hot` to everything and records what it served. */
function alwaysHot(result: WarmRunResult): WarmScreen & { counts: WarmStats; off: boolean } {
  const counts: WarmStats = emptyWarmStats();
  const s = {
    counts,
    off: false,
    get disabled(): boolean {
      return s.off;
    },
    async serve(_lane: Lane, _command: string): Promise<WarmRunResult | null> {
      if (s.off) return null;
      counts.offered += 1;
      counts.screened += 1;
      return result;
    },
    confirmed(ms: number): void {
      counts.confirmed += 1;
      counts.confirmMs += ms;
    },
    mismatch(): void {
      counts.mismatches += 1;
      s.off = true;
    },
    scopeUnusable(): void {
      counts.scopeUnusable += 1;
    },
    deadlineRecheck(): void {
      counts.deadlineRechecks += 1;
    },
    stats: (): WarmStats => ({ ...counts }),
    dispose(): void {
      s.off = true;
    },
  };
  return s;
}

function ctxFor(sandbox: ReturnType<typeof fakeSandbox>): RunnerContext {
  return { runDir, sandbox, signal: new AbortController().signal, workspaceInfo: { root: ws, git: false }, step: 1, emit: () => undefined };
}

/** The warm worker says "passes" in 4 ms; the cold sandbox says whatever `coldStdout` says, in its own time. */
function setUp(coldStdout: string, screen: WarmScreen): { mem: RunnerMemory; ctx: RunnerContext; queue: ReturnType<typeof fifoQueue> } {
  const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: coldStdout, exitCode: coldStdout === PASSING ? 0 : 1 } : {}));
  const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set(), warm: screen };
  return { mem, ctx: ctxFor(sandbox), queue: fifoQueue([job(candidate(site(gcd, 2), 'return a % b'), b0)]) };
}

describe('the warm plane and the OOS run-budget gate (S1 §3 M6 x ranked change 1)', () => {
  it('a warm screen is never the passer that ends a SIEVE sweep: the plausible that reaches the gate is cold-confirmed', async () => {
    const screen = alwaysHot({ stdout: PASSING, stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 4 });
    const { mem, ctx, queue } = setUp(PASSING, screen);
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    const plausible = out.filter((o) => o.status === 'plausible');
    expect(plausible).toHaveLength(1);
    // the gate's passer carries the cold confirmation, not the screen
    expect(plausible[0]?.screened).toBe(true);
    expect(plausible[0]?.confirmedCold).toBe(true);
    expect(screen.counts.confirmed).toBe(1);
  });

  it('a screen the cold run contradicts is no passer at all, so the sweep keeps going', async () => {
    const screen = alwaysHot({ stdout: PASSING, stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 4 });
    const { mem, ctx, queue } = setUp(FAILING, screen);
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    expect(out.filter((o) => o.status === 'plausible')).toHaveLength(0);
    expect(screen.counts.mismatches).toBe(1);
  });

  it('the 4 ms screen never reaches `tRunMs.goalSubset`, so `runsLeft` and `poolFitsRunBudget` still price COLD runs', async () => {
    const screen = alwaysHot({ stdout: PASSING, stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 4 });
    const { mem, ctx, queue } = setUp(PASSING, screen);
    const before = mem.oracle.tRunMs.goalSubset;
    await runQueue(ctx, mem, queue, GOAL, 5);
    // a warm 4 ms run must not pull the measured cold median down towards it
    expect(mem.oracle.tRunMs.goalSubset).toBeGreaterThan(4);
    expect(mem.oracle.tRunMs.goalSubset).toBe(before);
    // and the gate the OOS change added reads exactly that number
    const cold = { ...mem.oracle, lanes: 4, tRunMs: { goalSubset: 1574, fullSuite: 1574 } };
    const b = budget();
    b.testRunsLeft = 1191;
    b.testWallLeftMs = 600_000;
    expect(runsLeft(cold, b)).toBe(1191);
    expect(poolFitsRunBudget(28_878, runsLeft(cold, b))).toBe(false); // sympy-16792: still RANK
    // the same wall priced at a warm 4 ms would have claimed 600,000 runs and sieved the whole pool
    const asIfWarm = { ...cold, tRunMs: { goalSubset: 4, fullSuite: 4 } };
    b.testRunsLeft = Number.MAX_SAFE_INTEGER;
    expect(poolFitsRunBudget(28_878, runsLeft(asIfWarm, b))).toBe(true);
  });
});
