/**
 * The synth fast path — route R9 of docs/LLM-LOOP-DESIGN.md §4 — from the synthesizer side.
 *
 * The round here is REAL: `FastPathRunner` builds the same `LedgerSieveSynthesizer` the shipped `jev-only` factory
 * builds (§4.2), with the collaborators faked exactly as `controller.test.ts` fakes them. What is asserted is the
 * facade's contract: the one-round clamp reaches `mem.stepBudget`, a passer that is not cold-confirmed never becomes a
 * proposal, a pause point aborts the round, a repository / slow oracle is refused at stage 2, and the round's
 * telemetry is what the record is built from.
 */
import { describe, expect, it } from 'vitest';

import type { Proposal, SynthesisContext } from '../../../../src/core/types.js';
import { AbortError } from '../../../../src/errors.js';
import { LedgerSieveSynthesizer } from '../../../../src/synth/search/index.js';
import type { BaselineRun, FastPathClamp, RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import { runMemory } from '../../../../src/synth/search/index.js';
import {
  FASTPATH_JEV_MAX,
  FASTPATH_MAX_SITES,
  FastPathRunner,
  acceptFastPathProposal,
  coldConfirmed,
  fastPathCeilingMs,
  fastPathFingerprint,
  fastPathStage2,
  fastPathSuspects,
} from '../../../../src/synth/search/fastpath.js';
import type { FastPathBudget } from '../../../../src/synth/search/fastpath.js';
import type { Goal } from '../../../../src/synth/search/types.js';
import type { SubGoalResult } from '../../../../src/synth/search/subgoal.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedPatch, executedRun, fakeCtx, jobOf, outcomeOf, siteAt, sourceFile, summary, unusedRepositoryDeps } from './controller-fakes.js';
import { committedBase, oracle } from './helpers.js';
import { makeTrace } from './proposal-helpers.js';

const DETECTED_COMMAND = 'pytest -q';
const TEST_COMMAND = 'python3 -m pytest -q';
const FIX_TEXT = 'return gcd(b, a % b)';

function budget(over: Partial<FastPathBudget> = {}): FastPathBudget {
  return { wallMs: 20_000, testRuns: 64, jevRequests: FASTPATH_JEV_MAX, reserveMs: 1_000, graceMs: 500, ...over };
}

interface RoundOptions {
  /** the goal-subset / full-suite run of the commit the scripted search returns; `full: null` = no regression run */
  full?: 'same' | null;
  /** the scripted sub-goal result (default: a cold-confirmed commit) */
  result?: (goal: Goal, file: SourceFile) => SubGoalResult;
  /** the baseline run the round makes (default: one failing test) */
  baseline?: BaselineRun;
  /** slow the oracle down so stage 2 refuses the round */
  slowBaseline?: boolean;
  candidatesTested?: number;
}

/** The commit a real SIEVE round produces: a patch whose goal-subset AND full-suite runs are green. */
function commitFor(goal: Goal, file: SourceFile, o: RoundOptions): SubGoalResult {
  const c = cand(siteAt(file, 5), FIX_TEXT);
  const before = summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] });
  const green = summary({ command: TEST_COMMAND, failing: [], passing: [GCD_TEST, GCD_OTHER_TEST] });
  // `regressed`: the full-suite confirm run turns a test that passed before red — the passer is not cold-confirmed
  const full = o.full === null ? summary({ command: TEST_COMMAND, failing: [GCD_OTHER_TEST], passing: [GCD_TEST] }) : green;
  const out = outcomeOf(jobOf(c, committedBase(file, before)), 'plausible', { subset: green, full });
  return { kind: 'commit', applied: out.applied, allGoalTestsPass: true, outcome: out, trace: makeTrace({ goalId: goal.id, outcome: 'fixed', candidatesTested: o.candidatesTested ?? 9, sitesConsidered: 2, candidatesEnumerated: 9, testRuns: 10, jevRequests: 1 }) };
}

/** The deps of one scripted round, and the clamp the facade installed on them. */
function roundDeps(o: RoundOptions, seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] }): { deps: SearchDeps; file: SourceFile } {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const stubs = unusedRepositoryDeps();
  const slow = o.slowBaseline === true;
  const deps: SearchDeps = {
    ...stubs,
    loadFiles: async () => new Map([[file.path, file]]),
    runTests: async () => o.baseline ?? { summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST], durationMs: slow ? 400_000 : 20 }), output: '' },
    pickGoal: async (_ctx, mem) => {
      const g = mem.goals.find((x) => x.status === 'active') ?? mem.goals.find((x) => x.status === 'open') ?? null;
      if (g !== null) {
        g.status = 'active';
        g.attempts += 1;
      }
      return { goal: g, method: g === null ? 'none' : 'single', probability: 1, requests: 0 };
    },
    handleDirective: async () => ({ kind: 'continue', move: 'change_approach', changes: [] }),
    searchSubGoal: async (c, mem, goal) => {
      // the real `searchSubGoal` opens with exactly this check (subgoal.ts), which is how an abort stops a round
      if (c.signal.aborted) throw new AbortError('signal');
      seen.budgets.push(mem.stepBudget);
      return (o.result ?? ((g, f) => commitFor(g, f, o)))(goal, file);
    },
    searchBestGuess: async (_ctx, _mem, goal) => ({ kind: 'parked', reason: 'not used', trace: makeTrace({ goalId: goal.id, outcome: 'exhausted' }) }),
    regressionRun: async (_ctx, _mem, _goal, outcome) => outcome.subset,
    now: () => Date.now(),
  };
  return { deps, file };
}

function runnerFor(o: RoundOptions = {}): { runner: FastPathRunner; seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] } } {
  const seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] } = { clamp: null, budgets: [] };
  const { deps } = roundDeps(o, seen);
  const runner = new FastPathRunner({
    deps: () => deps,
    create: (d, clamp) => {
      seen.clamp = clamp;
      return new LedgerSieveSynthesizer(d, { fastPath: clamp });
    },
  });
  return { runner, seen };
}

let ids = 0;
function ctxFor(over: Parameters<typeof fakeCtx>[0] = {}): SynthesisContext & { events: ReturnType<typeof fakeCtx>['events'] } {
  return fakeCtx({
    runId: `fastpath-${ids++}`,
    testCommand: { command: DETECTED_COMMAND, runner: 'pytest' },
    files: ['gcd.py', 'tests/test_gcd.py'],
    window: [executedRun(0, TEST_COMMAND, { passed: 1, failed: 1 })],
    ...over,
  });
}

// ---------------------------------------------------------------------------------------
// Stage 2 — the pure predicate (§4.3)
// ---------------------------------------------------------------------------------------

describe('fastPathStage2', () => {
  const fast = oracle({ tRunMs: { goalSubset: 200, fullSuite: 400 }, lanes: 4 });
  const slow = oracle({ tRunMs: { goalSubset: 40_000, fullSuite: 120_000 }, lanes: 1 });
  const budgetOf = (over: Partial<RunMemory['stepBudget']> = {}): RunMemory['stepBudget'] => {
    const b: RunMemory['stepBudget'] = { jevRequestsLeft: 6, testRunsLeft: 64, testWallLeftMs: 20_000, startedMs: 0, recursed: false, llmRoundsLeft: 0, llmSamplesLeft: 0, llmUsdLeft: 0, exhausted: () => false, ...over };
    return b;
  };

  it('fires on a QuixBugs-class cluster whose whole pool fits the run budget', () => {
    const v = fastPathStage2({ oracle: fast, budget: budgetOf(), sites: 4, poolSize: 40 });
    expect(v).toEqual({ ok: true, reason: null, runMode: 'SIEVE' });
  });

  it('refuses a repository-class oracle before any candidate runs — the sympy-16792 shape (§6 row 5)', () => {
    expect(fastPathStage2({ oracle: slow, budget: budgetOf(), sites: 1, poolSize: 1 })).toEqual({ ok: false, reason: 'oracle_class', runMode: 'RANK' });
  });

  it('refuses a pool the run budget cannot decide — RANK is ineligible by construction', () => {
    const v = fastPathStage2({ oracle: fast, budget: budgetOf({ testRunsLeft: 20 }), sites: 1, poolSize: 6_960 });
    expect(v).toEqual({ ok: false, reason: 'pool_exceeds_run_budget', runMode: 'RANK' });
  });

  it('refuses more sites than one round can visit, and a localiser that found none', () => {
    expect(fastPathStage2({ oracle: fast, budget: budgetOf(), sites: FASTPATH_MAX_SITES + 1, poolSize: 1 }).reason).toBe('too_many_sites');
    expect(fastPathStage2({ oracle: fast, budget: budgetOf(), sites: 0, poolSize: 1 }).reason).toBe('no_sites');
  });

  it('refuses a budget with no run left in it', () => {
    expect(fastPathStage2({ oracle: fast, budget: budgetOf({ testRunsLeft: 0 }), sites: 1, poolSize: 0 }).reason).toBe('no_wall');
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance (§4.5)
// ---------------------------------------------------------------------------------------

describe('acceptFastPathProposal', () => {
  const patch = (evidence?: Proposal['evidence']): Proposal => ({
    goal: 'fix gcd',
    action: { kind: 'patch', diff: '--- a/gcd.py\n' },
    plan: { done: [], remaining: [], openProblems: [] },
    rawText: '',
    ...(evidence === undefined ? {} : { evidence }),
  });
  const confirmed: Proposal['evidence'] = {
    kind: 'shadow_test_run',
    command: TEST_COMMAND,
    before: { passed: 1, failed: 1, errors: 0, total: 2 },
    after: { passed: 2, failed: 0, errors: 0, total: 2 },
    newlyPassing: [GCD_TEST],
    newlyFailing: [],
    goalTests: [GCD_TEST],
    selection: 'sieve',
    candidatesTested: 9,
    arbitrated: false,
  };

  it('accepts a cold-confirmed sieve passer', () => {
    expect(acceptFastPathProposal(patch(confirmed))).toEqual({ accept: true });
    expect(coldConfirmed(patch(confirmed))).toBe(true);
  });

  it('refuses a passer whose regression run never happened — `refused`, never `no_passer` (§4.5)', () => {
    const noFullRun = { ...confirmed, after: { passed: 0, failed: 0, errors: 0, total: 0 } };
    expect(acceptFastPathProposal(patch(noFullRun))).toEqual({ accept: false, reason: 'confirm_timeout', outcome: 'refused', confirmedCold: false });
  });

  it('refuses a patch that regressed something', () => {
    const regressed = { ...confirmed, newlyFailing: [GCD_OTHER_TEST] };
    expect(acceptFastPathProposal(patch(regressed)).accept).toBe(false);
    expect(coldConfirmed(patch(regressed))).toBe(false);
  });

  it('refuses a patch with no evidence at all, and reports a non-patch proposal as no_passer', () => {
    expect(acceptFastPathProposal(patch())).toMatchObject({ accept: false, outcome: 'refused' });
    const run: Proposal = { goal: 'verify', action: { kind: 'run', command: TEST_COMMAND }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
    expect(acceptFastPathProposal(run)).toMatchObject({ accept: false, outcome: 'no_passer', reason: 'no_passer' });
  });
});

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

describe('fast-path helpers', () => {
  it('derives the suspect set from the traceback frames and the task text, never from a test file', () => {
    const tb = 'Traceback (most recent call last):\n  File "gcd.py", line 5, in gcd\n    return gcd(a % b, b)\n';
    expect(fastPathSuspects(tb, ['gcd.py', 'tests/test_gcd.py'], 'unrelated')).toEqual(['gcd.py']);
    expect(fastPathSuspects(null, ['gcd.py', 'tests/test_gcd.py'], 'fix gcd.py please')).toEqual(['gcd.py']);
    expect(fastPathSuspects(null, ['gcd.py', 'tests/test_gcd.py'], 'nothing named here')).toEqual([]);
  });

  it('fingerprints a cluster independently of test-id order', () => {
    expect(fastPathFingerprint('gcd.py', ['b', 'a'])).toBe(fastPathFingerprint('gcd.py', ['a', 'b', 'a']));
    expect(fastPathFingerprint('gcd.py', ['a'])).not.toBe(fastPathFingerprint('other.py', ['a']));
  });

  it('puts the confirm reserve and the grace OUTSIDE the wall share (§4.4)', () => {
    expect(fastPathCeilingMs(budget({ wallMs: 10_000, reserveMs: 2_000, graceMs: 500 }))).toBe(12_500);
  });
});

// ---------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------

describe('FastPathRunner.run', () => {
  it('installs the one-round clamp on the step budget and proposes the cold-confirmed passer', async () => {
    const { runner, seen } = runnerFor();
    const ctx = ctxFor();
    const r = await runner.run(ctx, budget({ wallMs: 9_000, testRuns: 11, jevRequests: 3 }));
    expect(r.kind).toBe('proposed');
    if (r.kind !== 'proposed') throw new Error('unreachable');
    expect(r.proposal.action.kind).toBe('patch');
    // §6 row 13: the `emptyStepBudget` trap is indistinguishable from an honest decline without this assertion
    expect(r.telemetry.candidatesTested).toBeGreaterThan(0);
    expect(r.telemetry.confirmedCold).toBe(true);
    expect(r.telemetry.runMode).toBe('SIEVE');
    // the clamp is the smaller of the honest budget and the round's share, on all three counters, and zero generator
    const installed = seen.budgets.at(-1);
    expect(installed).toBeDefined();
    expect(installed!.testRunsLeft).toBeLessThanOrEqual(11);
    // §4.4: the counter carries the candidate share PLUS the cold-confirm reserve, and the reserve is published so the
    // sieve stops dispatching candidates into it — the reserve is installed, not merely computed
    expect(installed!.testWallLeftMs).toBeLessThanOrEqual(9_000 + 1_000);
    expect(installed!.testWallLeftMs).toBeGreaterThan(9_000);
    expect(installed!.reserveWallMs).toBe(1_000);
    // and never more than half the counter, so a round always has wall to dispatch a candidate with
    expect(installed!.reserveWallMs).toBeLessThanOrEqual(Math.floor(installed!.testWallLeftMs / 2));
    expect(installed!.jevRequestsLeft).toBeLessThanOrEqual(3);
    expect([installed!.llmRoundsLeft, installed!.llmSamplesLeft, installed!.llmUsdLeft]).toEqual([0, 0, 0]);
    runner.dispose(ctx.runId);
  });

  it('never proposes a passer that failed the cold confirm, and disarms the run (§4.5)', async () => {
    const { runner } = runnerFor({ full: null });
    const ctx = ctxFor();
    const r = await runner.run(ctx, budget());
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') throw new Error('unreachable');
    expect(r.outcome).toBe('refused');
    expect(r.telemetry.confirmedCold).toBe(false);
    expect(runner.state(ctx.runId).disarmed).toBe(true);
    runner.dispose(ctx.runId);
  });

  it('declines a repository-class cluster at stage 2, before any candidate runs (§6 row 5)', async () => {
    const { runner, seen } = runnerFor({ slowBaseline: true });
    const ctx = ctxFor();
    const r = await runner.run(ctx, budget());
    expect(r.kind).toBe('declined');
    if (r.kind !== 'declined') throw new Error('unreachable');
    expect(r.reason).toBe('oracle_class');
    // the round was aborted at the clamp, before a candidate was priced, and nothing was proposed
    expect(r.telemetry.candidatesTested).toBe(0);
    expect(seen.clamp).not.toBeNull();
    // a counted decline, not a one-strike failure: the shape was wrong, nothing went wrong
    expect(runner.state(ctx.runId).disarmed).toBe(false);
    runner.dispose(ctx.runId);
  });

  it('honours a pause point that lands inside the round: the partial round is discarded, never proposed (§6 row 7)', async () => {
    const paused = new AbortController();
    const seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] } = { clamp: null, budgets: [] };
    const { deps, file } = roundDeps({}, seen);
    let entered = false;
    const pausing: SearchDeps = {
      ...deps,
      searchSubGoal: async (c, _mem, goal) => {
        entered = true;
        paused.abort(new AbortError('human_pause'));
        if (c.signal.aborted) throw new AbortError('human_pause');
        return commitFor(goal, file, {});
      },
    };
    const runner = new FastPathRunner({ deps: () => pausing, create: (d, clamp) => new LedgerSieveSynthesizer(d, { fastPath: clamp }) });
    const ctx: SynthesisContext = { ...ctxFor(), signal: paused.signal };
    await expect(runner.run(ctx, budget())).rejects.toThrow(AbortError);
    expect(entered).toBe(true);
    runner.dispose(ctx.runId);
  });

  it('never overruns its own ceiling, and the ledger the run keeps is debited by every round (§4.4)', async () => {
    // a round whose baseline run and whose search each cost real wall: the wall SHARE bounds only the sieve's own
    // counter, so the measured round is over it — the ceiling (share + reserve + grace) is the bound that holds
    const seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] } = { clamp: null, budgets: [] };
    const { deps, file } = roundDeps({}, seen);
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const slow: SearchDeps = {
      ...deps,
      runTests: async (c, cmd, t) => {
        await sleep(120);
        return deps.runTests(c, cmd, t);
      },
      searchSubGoal: async (_c, _mem, goal) => {
        await sleep(120);
        return commitFor(goal, file, {});
      },
    };
    const runner = new FastPathRunner({ deps: () => slow, create: (d, clamp) => new LedgerSieveSynthesizer(d, { fastPath: clamp }) });
    const ctx = ctxFor();
    const b = budget({ wallMs: 60, testRuns: 8, reserveMs: 400, graceMs: 4_000 });
    const r = await runner.run(ctx, b);
    expect(r.kind).toBe('proposed');
    // the share alone is NOT the bound — this is exactly what the record must not claim
    expect(r.telemetry.wallMs).toBeGreaterThan(b.wallMs);
    expect(r.telemetry.wallMs).toBeLessThanOrEqual(fastPathCeilingMs(b));
    // and the round's wall is on the run's own ledger, so the aggregate over rounds is bounded
    expect(runner.state(ctx.runId).wallSpentMs).toBeGreaterThanOrEqual(r.telemetry.wallMs);
    runner.dispose(ctx.runId);
  });

  it("reaches its OWN stage-2 verdict on round 2: the previous round's oracle never decides this one (§4.3)", async () => {
    // round 1 measures a repository-class oracle and is declined. Round 2 runs on a CHANGED workspace whose baseline
    // is fast — the memory is shared (one synthesizer per runId), so the round must re-measure before it judges.
    let calls = 0;
    const seen: { clamp: FastPathClamp | null; budgets: RunMemory['stepBudget'][] } = { clamp: null, budgets: [] };
    const { deps } = roundDeps({}, seen);
    const staged: SearchDeps = {
      ...deps,
      runTests: async () => {
        calls += 1;
        return { summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST], durationMs: calls === 1 ? 400_000 : 20 }), output: '' };
      },
    };
    const runner = new FastPathRunner({ deps: () => staged, create: (d, clamp) => new LedgerSieveSynthesizer(d, { fastPath: clamp }) });
    const ctx = ctxFor();
    const first = await runner.run(ctx, budget());
    expect(first).toMatchObject({ kind: 'declined', reason: 'oracle_class' });
    // a counted decline, not a disarm — the fast path may try the next cluster
    expect(runner.state(ctx.runId).disarmed).toBe(false);
    // round 2: the workspace changed since that baseline, so the round re-measures and judges what IT measured
    const second = await runner.run({ ...ctx, step: ctx.step + 1, window: [...ctx.window, executedPatch(ctx.step, ['gcd.py'])] }, budget());
    // it re-measured, and the verdict it acted on is its own: a stale `oracle_class` would have aborted it before
    // `runTests` ran a second time
    expect(calls).toBe(2);
    expect(second).not.toMatchObject({ kind: 'declined', reason: 'oracle_class' });
    runner.dispose(ctx.runId);
  });

  it('drops the run memory with the synthesizer at run end (§4.6)', async () => {
    const { runner } = runnerFor();
    const ctx = ctxFor();
    await runner.run(ctx, budget());
    expect(runMemory(ctx.runId).goals.length).toBeGreaterThan(0);
    runner.dispose(ctx.runId);
    // a fresh memory: nothing of the round survived it
    expect(runMemory(ctx.runId).goals).toEqual([]);
  });
});
