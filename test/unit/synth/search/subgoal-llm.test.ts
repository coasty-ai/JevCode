/**
 * The LLM source in the sub-goal loop (docs/LLM-JEV-DESIGN.md §4.2, §6.1, §6.2, §9.2 stage 4) with a
 * scripted `SubGoalLlm`: the fire point after `locate`, the seeds-vs-LLM race at the top site (seeds
 * win → the round is cancelled; sample 0 within the grace → one decision over the union; grace 0 never
 * waits), the stagger release when the seeds miss and the streamed LLM phase, an empty round on its
 * deadline releasing SKETCH, Q17's order on a RANK oracle, the repository fire point in the best-guess
 * search and the mutation skip at repository sites. jev-only (no `deps.llm`) is untouched: the existing
 * subgoal tests cover it.
 */
import { describe, expect, it } from 'vitest';

import type { RepositoryMode } from '../../../../src/synth/search/memory.js';
import { EDIT_CLASS_QUESTION_ID, LLM_ROUND_MAX_CANDIDATES, SEED_SOURCES, exhaustedKey, llmJobPrior, orderSources, searchBestGuess, searchSubGoal, sourcePriorAt } from '../../../../src/synth/search/subgoal.js';
import type { GuardVerdict } from '../../../../src/synth/search/subgoal.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { GCD_OTHER_TEST, GCD_TEST, cand, choiceOn, fakeBudget, fakeCtx, fakeGoal, fakeLlm, fakeMemory, fakeSubGoalDeps, fastOracle, gcdFixture, slowOracle, summary } from './controller-fakes.js';

const FIX = 'return gcd(b, a % b)';
const LLM_FIX = 'return gcd(b, a % b)  # llm';
const WRONG = 'return gcd(a, b)';

function baseline(): ReturnType<typeof summary> {
  return summary({ command: 'pytest -q', failing: [GCD_TEST], passing: [GCD_OTHER_TEST] });
}

/** The guard stand-in of these tests: the first plausible commits, an `llm` passer first (the §6.2 same-cluster rule). */
function commitFirstPlausible(results: readonly VerifyOutcome[]): GuardVerdict {
  const passers = results.filter((o) => o.status === 'plausible');
  const pick = passers.find((o) => o.applied.candidate.source === 'llm') ?? passers[0];
  return pick === undefined ? { kind: 'continue' } : { kind: 'commit', applied: pick.applied, allGoalTestsPass: true, outcome: pick };
}

function llmBudget(over: { llmRounds?: number; jev?: number } = {}): ReturnType<typeof fakeBudget> {
  return fakeBudget({ jev: over.jev ?? 30, llmRounds: over.llmRounds ?? 2, llmSamples: 8, llmUsd: 0.02 });
}

function repositoryOf(goalId: string): RepositoryMode {
  return { goalId, moduleFiles: ['gcd.py'], scope: { testFiles: [], command: null, tier: 'none', note: 'no scope' }, repro: null, oracleOutcome: 'no_blocks', oracleNote: 'no code block', traceback: null, bestGuessCommitted: false, knownFailures: 0, lastRepro: null };
}

describe('pure rules', () => {
  it('the LLM phase has the one `llm` source, its own exhausted key, and the class-dependent queue place of §6.1', () => {
    expect(orderSources('LLM', null, new Set())).toEqual(['llm']);
    expect(orderSources('LLM', null, new Set(['llm']))).toEqual([]);
    const { replace } = gcdFixture();
    expect(exhaustedKey(replace, 'LLM')).toBe('gcd.py:5:replace#LLM');
    // QuixBugs/ladder: after the three seed sources; repository: before every seed
    expect(llmJobPrior('quixbugs')).toBe(sourcePriorAt(SEED_SOURCES.length));
    expect(llmJobPrior('ladder')).toBe(sourcePriorAt(SEED_SOURCES.length));
    expect(llmJobPrior('repository')).toBe(1);
    expect(LLM_ROUND_MAX_CANDIDATES).toBe(18);
  });
});

describe('the race at the top site (§4.2, §6.2)', () => {
  it('seeds win: the round fires after locate, sample 0 does not land within the grace, the seeds decide alone and the round is cancelled on the commit', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({ graceMs: 30, rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 2000 }] } : null) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, FIX, { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.text === FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(FIX);
    // fired once, right after locate, for round 1 with no Q7 prior on a fast oracle
    expect(llm.rec.fires).toEqual([{ round: 1, editClass: null }]);
    // a seed passer: the staggered samples were never released, the grace waited, nothing arrived, the seeds decided
    expect(llm.rec.released).toBe(0);
    expect(deps.rec.decideCalls).toHaveLength(1);
    expect(deps.rec.decideCalls[0]!.map((o) => o.applied.candidate.source)).toEqual(['mutation']);
    expect(llm.rec.cancelled).toEqual(['commit']);
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 1, valid: 0, cancelled: 1, fixAbsent: null });
    expect(r.trace.llm!.graceMs).toBeGreaterThanOrEqual(25);
    const grace = ctx.events.find((e) => e.type === 'synth' && e.phase === 'grace');
    expect(grace).toBeDefined();
    if (grace?.type === 'synth') expect(grace.detail).toMatch(/nothing arrived; the seeds decide/);
  });

  it('sample 0 lands within the grace: the arrived LLM candidate runs and the batch is decided once over seeds ∪ LLM (the LLM member wins the cluster)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({ graceMs: 1000, rounds: () => ({ arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }] }) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, FIX, { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.text === FIX || job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    // one decision over the union
    expect(deps.rec.decideCalls).toHaveLength(1);
    expect(deps.rec.decideCalls[0]!.map((o) => o.applied.candidate.source).sort()).toEqual(['llm', 'mutation']);
    // the LLM candidate ran as its own batch after the seeds, in the QuixBugs queue place (after the three seed sources)
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.text))).toEqual([[FIX], [LLM_FIX]]);
    expect(deps.rec.runBatches[1]![0]!.p).toBeCloseTo(llmJobPrior('quixbugs'), 6);
    // the round closed by itself (every sample landed): nothing to cancel
    expect(llm.rec.cancelled).toEqual([]);
    expect(r.trace.bySource.llm).toEqual({ enumerated: 1, tested: 1, passed: 1 });
    // the attempt ledger holds both runs (the LLM must not repeat a seed's failure either)
    expect(mem.llm?.attempts.get(goal.id)?.map((a) => a.op).sort()).toEqual(['mutation:argument_swap', 'sample_0_0']);
  });

  it('grace 0 never waits: the seed passer commits at once even though sample 0 lands 5 ms later', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({ graceMs: 0, rounds: () => ({ arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }] }) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, FIX, { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.text === FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(FIX);
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(llm.rec.cancelled).toEqual(['commit']);
    expect(r.trace.llm?.graceMs).toBeLessThan(5);
  });

  it('the seeds miss: samples 1..N−1 are released at the top-site batch and the LLM phase streams the arrivals into the lanes; the LLM passer commits and SKETCH/BEAM never run while a round is available', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({
      graceMs: 1000,
      rounds: (o) =>
        o.round === 1
          ? {
              arrivals: [
                { candidates: [cand(replace, 'return gcd(a % b, a)', { source: 'llm', op: 'sample_0_0' })], delayMs: 5 },
                { candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_1_0' })], delayMs: 5 },
              ],
            }
          : null,
    });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      sketch: (site) => ({ candidates: [cand(site, 'return gcd(a, b % a)', { source: 'template', op: 'sketch_P4' })], requests: 3 }),
      statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.source).toBe('llm');
    // the top-site seed batch returned without a passer → release; then the LLM phase
    expect(llm.rec.released).toBe(1);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'llm:release')).toBe(true);
    expect(r.trace.phase).toBe('LLM');
    expect(goal.phase).toBe('LLM');
    // batches: the seed mutant, then the streamed LLM round (sample 0 first, then sample 1)
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.op))).toEqual([['identifier_substitution'], ['sample_0_0', 'sample_1_0']]);
    expect(deps.rec.decideCalls).toHaveLength(2);
    expect(r.trace.bySource.llm).toEqual({ enumerated: 2, tested: 2, passed: 1 });
    expect(r.trace.runMode).toBe('SIEVE');
    // SKETCH is gated while the step still has LLM rounds (the fake never spends the counters)
    expect(deps.rec.sketchCalls).toEqual([]);
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 2, valid: 2 });
  });

  it('a round that ends on its deadline with nothing: the LLM phase moves on and SKETCH runs once no round can fire this step', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget({ llmRounds: 0, jev: 60 }) });
    const goal = fakeGoal();
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [], hang: true, deadlineMs: 30 } : null) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      sketch: (site) => ({ candidates: [cand(site, 'return gcd(a, b % a)', { source: 'template', op: 'sketch_P4' })], requests: 3 }),
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('parked');
    // the round timed out empty; the phase ladder went on to SKETCH (no rounds left this step)
    expect(deps.rec.sketchCalls).toEqual([5]);
    expect(r.trace.llm).toMatchObject({ rounds: 1, valid: 0 });
    expect(llm.rec.fires.map((f) => f.round)).toEqual([1]);
  });
});

describe('RANK on an expensive oracle (§4g): Q17 orders the arrived candidates, never withholds one', () => {
  it('collects the round, asks the adapter for Q17\'s order, runs the top-k in that order and records the request', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx({ ask: (qs) => ({ [EDIT_CLASS_QUESTION_ID]: choiceOn(qs[EDIT_CLASS_QUESTION_ID]!, 'substitute_one_token') }) });
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const c1 = cand(replace, 'return gcd(a % b, a)', { source: 'llm', op: 'sample_0_0' });
    const c2 = cand(replace, LLM_FIX, { source: 'llm', op: 'sample_1_0' });
    const c3 = cand(replace, 'return gcd(b, a // b)', { source: 'llm', op: 'sample_2_0' });
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [c1, c2, c3], delayMs: 1 }], staggered: false } : null), order: (ids) => [...ids].reverse() });
    const deps = fakeSubGoalDeps({ sites: [replace], statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'), decide: commitFirstPlausible });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    // the Q7 prior asked up front on the slow oracle reaches the round as hint h4
    expect(llm.rec.fires[0]).toEqual({ round: 1, editClass: 'substitute_one_token' });
    // Q17 saw the three distinct candidates and its order became the job order
    expect(llm.rec.orders).toEqual([[c1.id, c2.id, c3.id]]);
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(deps.rec.runBatches[0]!.map((j) => j.candidate.id)).toEqual([c3.id, c2.id, c1.id]);
    expect(deps.rec.runBatches[0]!.map((j) => j.p)).toEqual([...deps.rec.runBatches[0]!.map((j) => j.p)].sort((a, b) => b - a));
    expect(r.trace.runMode).toBe('RANK');
    expect(r.trace.candidatesRanked).toBe(3);
    // the fake localisation's 2 requests + Q7 + Q17
    expect(r.trace.jevRequests).toBe(4);
    expect(deps.rec.rankCalls).toEqual([]);
  });
});

describe('repository class (§4.2, §4e)', () => {
  it('the best-guess search fires the round after locate and runs the LLM candidates before every ranked seed (p = 1.0)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const llmCand = cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' });
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [llmCand], delayMs: 5 }], klass: 'repository' } : null) });
    const deps = fakeSubGoalDeps({ sites: [replace], seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []), statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged') });
    deps.llm = llm;
    const r = await searchBestGuess(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.source).toBe('llm');
    expect(llm.rec.fires).toEqual([{ round: 1, editClass: null }]);
    const batch = deps.rec.runBatches[0]!;
    expect(batch.map((j) => j.candidate.source)).toEqual(['llm', 'mutation']);
    expect(batch[0]!.p).toBe(1);
    expect(r.trace.bySource.llm).toEqual({ enumerated: 1, tested: 1, passed: 1 });
    // the seeds were still ranked (one Jev request) but queued behind the sample
    expect(deps.rec.rankCalls).toEqual([{ line: 5, n: 1 }]);
  });

  it('at repository sites the mutation source is skipped and marked exhausted (no chunked ranking of mutation sets)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget({ llmRounds: 0 }) });
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const llm = fakeLlm({ rounds: () => null });
    const deps = fakeSubGoalDeps({ sites: [replace], seed: (source, site) => (source === 'template' ? [cand(site, WRONG, { source: 'template', op: 'guard' })] : [cand(site, FIX, { op: 'argument_swap' })]) });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('parked');
    expect(deps.rec.enumerations.map((e) => e.source)).not.toContain('mutation');
    expect(goal.exhausted.get('gcd.py:5:replace')?.has('mutation')).toBe(true);
    // the round was skipped by the adapter (null): no LLM phase, no trace rounds
    expect(r.trace.llm).toMatchObject({ rounds: 0, samples: 0 });
  });
});
