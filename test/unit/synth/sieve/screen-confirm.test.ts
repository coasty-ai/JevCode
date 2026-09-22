/**
 * The screen-hot / confirm-cold rule inside `runQueue` (docs/HARNESS-NEXT-DESIGN.md §3 M6,
 * §6 S1, risk R-1) and the scope-usability guard (risks R-11, R-14).
 *
 * These are the two places where the warm plane could change a verdict rather than only the
 * wall, so they are driven by a scripted screen rather than by an interpreter: every case here
 * fixes exactly what the warm worker returned and asserts what the sieve then did.
 *
 * The rules under test:
 *   1. a passer any of whose runs was warm is ALWAYS re-verified by a cold, fresh-spawn
 *      full-suite run before it is returned, and the cold run's summary is the one recorded;
 *   2. with no run left in the budget for that confirmation the candidate is deferred, never
 *      accepted — the confirmation is never skipped;
 *   3. one screen/confirm disagreement disables the plane, emits `screen:mismatch`, records the
 *      COLD verdict, and re-queues everything else the batch classified warm;
 *   4. a scoped run that collected nothing is widened to the full suite and recorded as
 *      `scope_unusable`, and is compared with the base's full summary, not the scoped one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Lane, VerifyOutcome } from '../../../../src/synth/search/types.js';
import { runQueue, type RunnerContext, type RunnerMemory } from '../../../../src/synth/sieve/runner.js';
import { emptyWarmStats, type WarmRunResult, type WarmScreen, type WarmStats } from '../../../../src/synth/warm/index.js';
import { base, budget, candidate, fakeSandbox, fifoQueue, GCD_BASELINE, GCD_BUGGY, GCD_TESTS, goal, job, oracle, runTestsJson, site, sourceFile, summary } from './helpers.js';

let tmp: string;
let ws: string;
let runDir: string;
const emitted: string[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-screen-'));
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
const PASSING = runTestsJson([]);
const FAILING = runTestsJson([[13, 13]]);

/** A warm screen whose answers the test fixes, recording every command it was offered. */
function scriptedScreen(answer: (command: string, n: number) => WarmRunResult | null): WarmScreen & { offered: string[]; counts: WarmStats; off: boolean } {
  const counts: WarmStats = emptyWarmStats();
  const s = {
    offered: [] as string[],
    counts,
    off: false,
    get disabled(): boolean {
      return s.off;
    },
    async serve(_lane: Lane, command: string): Promise<WarmRunResult | null> {
      if (s.off) return null;
      s.offered.push(command);
      const r = answer(command, s.offered.length);
      if (r !== null) counts.screened += 1;
      counts.offered += 1;
      return r;
    },
    confirmed(ms: number): void {
      counts.confirmed += 1;
      counts.confirmMs += ms;
    },
    mismatch(): void {
      counts.mismatches += 1;
      s.off = true;
      counts.disabledReason = 'screen/confirm mismatch';
    },
    scopeUnusable(): void {
      counts.scopeUnusable += 1;
    },
    stats: (): WarmStats => ({ ...counts }),
    dispose(): void {
      s.off = true;
    },
  };
  return s;
}

function ctxFor(sandbox: ReturnType<typeof fakeSandbox>): RunnerContext {
  return {
    runDir,
    sandbox,
    signal: new AbortController().signal,
    workspaceInfo: { root: ws, git: false },
    step: 1,
    emit: (e) => emitted.push(e.detail),
  };
}

function warm(result: WarmRunResult | null): WarmRunResult | null {
  return result;
}
const hot = (stdout: string, exitCode: number): WarmRunResult => ({ stdout, stderr: '', exitCode, timedOut: false, durationMs: 4 });

/** One candidate whose warm run says "passes" and whose cold run says whatever `coldStdout` says. */
function setUp(coldStdout: string, screen: WarmScreen): { mem: RunnerMemory; ctx: RunnerContext; queue: ReturnType<typeof fifoQueue> } {
  const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: coldStdout, exitCode: coldStdout === PASSING ? 0 : 1 } : {}));
  const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set(), warm: screen };
  const c = candidate(site(gcd, 2), 'return a % b');
  return { mem, ctx: ctxFor(sandbox), queue: fifoQueue([job(c, b0)]) };
}

describe('screen hot, confirm cold (§3 M6)', () => {
  it('a warm passer is re-run cold before it is returned, and the cold summary is the recorded one', async () => {
    const screen = scriptedScreen(() => warm(hot(PASSING, 0)));
    const { mem, ctx, queue } = setUp(PASSING, screen);
    const runsBefore = mem.stepBudget.testRunsLeft;
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    const o = out[0] as VerifyOutcome;
    expect(o.screened).toBe(true);
    expect(o.confirmedCold).toBe(true);
    // the confirmation is a real, charged, fresh-spawn run: the warm screen never saw it
    expect(screen.counts.confirmed).toBe(1);
    expect(runsBefore - mem.stepBudget.testRunsLeft).toBe(2);
    expect(o.full?.passed).toBe(6);
    expect(emitted.join('\n')).toContain('cold confirm');
  });

  it('with no run left for the cold confirmation the candidate is deferred, never accepted', async () => {
    const screen = scriptedScreen(() => warm(hot(PASSING, 0)));
    const { mem, ctx, queue } = setUp(PASSING, screen);
    mem.stepBudget = budget({ testRunsLeft: 1 });
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    expect(out).toEqual([]);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(screen.counts.confirmed).toBe(0);
    expect(mem.tried.size).toBe(0);
  });

  it('a disagreement records the cold verdict, disables the plane and emits screen:mismatch', async () => {
    const screen = scriptedScreen(() => warm(hot(PASSING, 0)));
    // the cold run disagrees: the candidate does not actually fix the suite
    const { mem, ctx, queue } = setUp(FAILING, screen);
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    expect(out.map((o) => o.status)).not.toContain('plausible');
    expect(screen.counts.mismatches).toBe(1);
    expect(screen.disabled).toBe(true);
    expect(emitted.join('\n')).toContain('screen:mismatch');
    // the cold run is what the outcome carries
    expect(out[0]?.full?.passed).toBe(5);
    expect(out[0]?.confirmedCold).toBe(true);
  });

  it('a mismatch re-queues everything else the batch had classified on a warm worker', async () => {
    // two candidates: the first is classified `unchanged` warm, the second screens as a passer
    // and fails its cold confirmation. The first must leave `tried` and be re-queued.
    const UNCHANGED = runTestsJson([[13, 13], [37, 600], [20, 100], [624129, 2061517], [3, 12]]);
    const screen = scriptedScreen((_c, n) => warm(n === 1 ? hot(UNCHANGED, 1) : hot(PASSING, 0)));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: FAILING, exitCode: 1 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set(), warm: screen };
    const first = candidate(site(gcd, 2), 'return a % b');
    const second = candidate(site(gcd, 2), 'return b % a');
    const out = await runQueue(ctxFor(sandbox), mem, fifoQueue([job(first, b0), job(second, b0)]), GOAL, 5);
    expect(screen.counts.mismatches).toBe(1);
    expect(out.map((o) => o.status)).toContain('unchanged');
    // the warm `unchanged` verdict is withdrawn: not tried, queued again for the next call.
    // Only the candidate whose own cold confirmation decided it stays `tried`.
    expect(mem.tried.size).toBe(1);
    expect(mem.deferred?.get(GOAL.id)?.map((j) => j.candidate.text)).toEqual(['return a % b']);
  });

  it('a cold-only batch confirms nothing and marks nothing screened (byte-identical to today)', async () => {
    const screen = scriptedScreen(() => null);
    const { mem, ctx, queue } = setUp(PASSING, screen);
    const runsBefore = mem.stepBudget.testRunsLeft;
    const out = await runQueue(ctx, mem, queue, GOAL, 5);
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    expect(out[0]?.screened).toBeUndefined();
    expect(out[0]?.confirmedCold).toBeUndefined();
    expect(screen.counts.confirmed).toBe(0);
    expect(runsBefore - mem.stepBudget.testRunsLeft).toBe(1);
  });
});

describe('the scope-usability guard (§6 S1, risks R-11 / R-14)', () => {
  const FILE = 'tests/test_acct.py';
  const PY_GOAL = goal([`${FILE}::test_a`], { suspectedFiles: ['src/acct.py'] });
  const PY_BASELINE = summary({ command: 'python3 -m pytest -q', passed: 2, failed: 1, total: 3, failing: [`${FILE}::test_a`], passing: [`${FILE}::test_b`, 'tests/test_other.py::test_c'], exitCode: 1 });
  const src = sourceFile('src/acct.py', 'def f():\n    return 1\n');
  const pyBase = base([src], PY_BASELINE);

  /** pytest `-q` output with the given counts. */
  const pytestOut = (passed: number, failed: number): string => (passed + failed === 0 ? 'no tests ran in 0.01s\n' : `${'.'.repeat(passed)}${'F'.repeat(failed)}\n${failed === 0 ? `${passed} passed` : `${failed} failed, ${passed} passed`} in 0.01s\n`);

  it('a scoped run that collected nothing is widened, recorded, and compared with the full baseline', async () => {
    const seen: string[] = [];
    const sandbox = fakeSandbox((command) => {
      seen.push(command);
      // the scoped command collects nothing (pytest exit 5); the full suite is real
      if (command.includes(FILE)) return { stdout: pytestOut(0, 0), exitCode: 5 };
      if (command === 'python3 -m pytest -q') return { stdout: pytestOut(3, 0), exitCode: 0 };
      return {};
    });
    const mem: RunnerMemory = { baseline: PY_BASELINE, oracle: oracle({ runner: 'pytest', lanes: 1, perTestTimeoutMs: null }), stepBudget: budget(), tried: new Set() };
    const c = candidate(site(src, 2), '    return 2');
    const out = await runQueue(ctxFor(sandbox), mem, fifoQueue([job(c, pyBase)]), PY_GOAL, 5);
    expect(emitted.join('\n')).toContain('scope_unusable');
    expect(seen.filter((s) => s === 'python3 -m pytest -q').length).toBeGreaterThan(0);
    // the widened run is the whole suite, so it decides on its own and is compared with the base
    expect(out.map((o) => o.status)).toEqual(['plausible']);
    expect(out[0]?.full?.passed).toBe(3);
  });

  it('a scoped run that collected something is left alone', async () => {
    const sandbox = fakeSandbox((command) => (command.includes(FILE) ? { stdout: pytestOut(2, 0), exitCode: 0 } : { stdout: pytestOut(3, 0), exitCode: 0 }));
    const mem: RunnerMemory = { baseline: PY_BASELINE, oracle: oracle({ runner: 'pytest', lanes: 1, perTestTimeoutMs: null }), stepBudget: budget(), tried: new Set() };
    const c = candidate(site(src, 2), '    return 2');
    await runQueue(ctxFor(sandbox), mem, fifoQueue([job(c, pyBase)]), PY_GOAL, 5);
    expect(emitted.join('\n')).not.toContain('scope_unusable');
  });
});
