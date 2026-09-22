/**
 * OOS iteration 2, question 1(b): the repository RANK site that bypasses `rankPoolCap`.
 *
 * The records. `experiments/results/llm-jev-iter1.md` §4.2: the fresh SWE arm priced
 * **6,960 candidates against 20 tested** — 1,740 ranked and 5 run per instance
 * (`bench/results/iter1-fresh-llm-jev-swebench/runs/20260922-120654-pwk7v3bn`:
 * `steps.jsonl` step 1 `verify.candidatesTested: 5`, `decisions.jsonl` 1,641 `candidate_*`
 * Noul rows over ten `propose` requests of 180–250 questions each, one per best-guess site).
 * Ranked change 1 put `rankPoolCap` on the two sub-goal sites (`visitSource`, `runLlmRound`)
 * and left the third — `bestGuessPhases`, the repository best-guess search, which ranks each
 * site's WHOLE enumerated set before merging them and then runs
 * `k = min(plan.k, plan.runsAllowed, ranked.length)` of the merge. On QuixBugs and the ladder
 * that path never runs (they have a reproduction oracle), which is exactly why change 1 held
 * there and failed on repositories.
 *
 * The invariant under test is `rankPoolCap`'s own: a step never prices more candidates than it
 * could run, on ANY path. The pool that is not priced is not queued, stays out of `tried` and
 * comes back enumerable next step (§2.3).
 */
import { describe, expect, it } from 'vitest';

import type { RepositoryMode } from '../../../../src/synth/search/memory.js';
import { rankPoolCap, runsLeft } from '../../../../src/synth/search/budget.js';
import { searchBestGuess } from '../../../../src/synth/search/subgoal.js';
import { GCD_OTHER_TEST, GCD_TEST, cand, fakeBudget, fakeCtx, fakeGoal, fakeMemory, fakeSubGoalDeps, gcdFixture, slowOracle, summary } from './controller-fakes.js';

function repositoryOf(goalId: string): RepositoryMode {
  return { goalId, moduleFiles: ['gcd.py'], scope: { testFiles: [], command: null, tier: 'none', note: 'no scope' }, repro: null, oracleOutcome: 'no_blocks', oracleNote: 'no code block', traceback: null, bestGuessCommitted: false, knownFailures: 0, lastRepro: null };
}

describe('question 1(b): the best-guess repository search prices only what the step can run', () => {
  it('20260922-120654-pwk7v3bn: two sites × 60 seeds is not 120 priced against 5 run', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx();
    // slowOracle (30 s per goal-subset run, 4 lanes) against the default 90 s of step wall: 12 runs left
    const stepBudget = fakeBudget({ jev: 30 });
    const mem = fakeMemory([file], summary({ command: 'pytest -q', failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), { oracle: slowOracle(), stepBudget });
    const left = runsLeft(mem.oracle, stepBudget);
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const sites = [replace, insert];
    const deps = fakeSubGoalDeps({
      sites,
      // one big mutation set per site, the shape a repository file's identifier substitutions have
      seed: (source, site) => (source === 'mutation' ? Array.from({ length: 60 }, (_, i) => cand(site, `return gcd(b, a % b)  # v${site.line}_${i}`, { op: 'identifier_substitution' })) : []),
      rank: (cands) => ({ ranked: cands.map((c, i) => ({ candidate: c, probability: 0.9 - i * 0.01, rank: i + 1 })), escapeProbability: 0.05, fixProbablyAbsent: false, method: 'choice' as const, requests: 1 }),
    });
    const r = await searchBestGuess(ctx, mem, goal, deps);

    const priced = deps.rec.rankCalls.reduce((n, c) => n + c.n, 0);
    expect(r.trace.candidatesEnumerated).toBe(120);
    // the invariant: never more priced than the step could run, and never more than `rankPoolCap` allows
    expect(priced).toBeLessThanOrEqual(left);
    expect(priced).toBeLessThanOrEqual(rankPoolCap(left, left));
    expect(r.trace.candidatesRanked).toBe(priced);
    expect(r.trace.candidatesRanked).toBeLessThanOrEqual(left);
    // and the price is spread over the sites, not eaten by the first one (§2.4)
    expect(deps.rec.rankCalls.length).toBeGreaterThan(1);
    expect(deps.rec.rankCalls.every((c) => c.n >= 1)).toBe(true);
    // the ranked set still reaches the runner: the cut is on the price, not on the search
    expect(r.trace.candidatesTested).toBeGreaterThan(0);
  });

  it('a pool the step can run whole is priced whole (the cap never withholds a reachable candidate)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const stepBudget = fakeBudget({ jev: 30 });
    const mem = fakeMemory([file], summary({ command: 'pytest -q', failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), { oracle: slowOracle(), stepBudget });
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'return gcd(b, a % b)', { op: 'argument_swap' })] : []),
      rank: (cands) => ({ ranked: cands.map((c, i) => ({ candidate: c, probability: 0.9 - i * 0.01, rank: i + 1 })), escapeProbability: 0.05, fixProbablyAbsent: false, method: 'choice' as const, requests: 1 }),
    });
    await searchBestGuess(ctx, mem, goal, deps);
    expect(deps.rec.rankCalls).toEqual([{ line: replace.line, n: 1 }]);
  });
});
