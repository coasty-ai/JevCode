/**
 * The LLM source in the sub-goal loop (docs/LLM-JEV-DESIGN.md §4.2, §6.1, §6.2, §9.2 stage 4) with a
 * scripted `SubGoalLlm`: the fire point after `locate`, the seeds-vs-LLM race (seeds win → the round is
 * cancelled; sample 0 within the grace → one decision over the union; grace 0 never waits; the grace at a
 * later site once the top site released the samples; the grace's own queue beside a seed leftover), the
 * stagger release when the seeds miss and the streamed LLM phase (arrivals past the cap booked, not
 * queued), the feedback round with both rounds on the trace, an empty round on its deadline releasing
 * SKETCH, Q17's order on a RANK oracle after N−1 samples, the repository fire point in the best-guess
 * search overlapping Q9 and the mutation skip at repository sites. The round ends on evidence (§4.2, §6.2): a
 * streamed passer is decided the moment it is classified and the straggler is cancelled on the commit; a held
 * passer re-enters the stream; on repository class the LLM phase precedes the seeds. jev-only (no `deps.llm`)
 * is untouched: the existing subgoal tests cover it.
 */
import { describe, expect, it } from 'vitest';

import type { RepositoryMode } from '../../../../src/synth/search/memory.js';
import { LLM_FEEDBACK_WIDEN } from '../../../../src/synth/search/llm.js';
import { EDIT_CLASS_QUESTION_ID, LLM_ROUND_MAX_CANDIDATES, SEED_SOURCES, llmJobPrior, phaseLadder, searchBestGuess, searchSubGoal, sourcePriorAt } from '../../../../src/synth/search/subgoal.js';
import type { GuardVerdict } from '../../../../src/synth/search/subgoal.js';
import { PHASES } from '../../../../src/synth/search/types.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { GCD_OTHER_TEST, GCD_TEST, cand, choiceOn, fakeBudget, fakeCtx, fakeGoal, fakeLlm, fakeMemory, fakeQueue, fakeSubGoalDeps, fastOracle, gcdFixture, slowOracle, summary } from './controller-fakes.js';

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
  it('the class-dependent queue place of §6.1 (what `llmJobs` keys the LLM jobs by)', () => {
    // QuixBugs/ladder: after the three seed sources; repository: before every seed
    expect(llmJobPrior('quixbugs')).toBe(sourcePriorAt(SEED_SOURCES.length));
    expect(llmJobPrior('ladder')).toBe(sourcePriorAt(SEED_SOURCES.length));
    expect(llmJobPrior('repository')).toBe(1);
    expect(LLM_ROUND_MAX_CANDIDATES).toBe(18);
  });

  it('the phase ladder (§4.2): PHASES as is, except that llm-jev on repository class consumes the LLM round before the seeds', () => {
    expect(phaseLadder({ llm: false, repository: false })).toEqual(PHASES);
    expect(phaseLadder({ llm: false, repository: true })).toEqual(PHASES);
    expect(phaseLadder({ llm: true, repository: false })).toEqual(PHASES);
    expect(phaseLadder({ llm: true, repository: true })).toEqual(['LLM', 'SEEDS', 'SKETCH', 'BEAM', 'WIDENED']);
  });
});

describe('the race and the grace (§4.2, §6.2)', () => {
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

  it('the grace runs at any site: the top-site seeds miss (release), a seed passer at the second site waits for sample 0 and the batch is decided once over the union', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({ graceMs: 1000, rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 60 }] } : null) });
    const INSERT_FIX = 'a, b = b, a % b';
    const deps = fakeSubGoalDeps({
      sites: [replace, insert],
      seed: (source, site) => (source !== 'mutation' ? [] : site.kind === 'replace' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : [cand(site, INSERT_FIX, { op: 'insert_statement' })]),
      statusOf: (job) => (job.candidate.text === INSERT_FIX || job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    // site 1: no passer → the staggered samples were released; site 2: a seed passer → the grace waited for sample 0, then one decision over seeds ∪ LLM
    expect(llm.rec.released).toBe(1);
    expect(deps.rec.decideCalls).toHaveLength(2);
    expect(deps.rec.decideCalls[0]!.map((o) => o.applied.candidate.text)).toEqual([WRONG]);
    expect(deps.rec.decideCalls[1]!.map((o) => o.applied.candidate.text).sort()).toEqual([INSERT_FIX, LLM_FIX].sort());
    expect(r.trace.llm!.graceMs).toBeGreaterThanOrEqual(30);
    const grace = ctx.events.find((e) => e.type === 'synth' && e.phase === 'grace');
    expect(grace?.type === 'synth' ? grace.detail : '').toMatch(/1 LLM candidate arrived, running them before the decision/);
  });

  it("the grace runs the arrived LLM candidates on a queue of their own: a seed leftover in the goal's queue (sorting before LLM jobs on QuixBugs class) takes none of their dispatches", async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({ graceMs: 1000, rounds: () => ({ arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }] }) });
    const LEFTOVER = 'return gcd(a, b % a)  # leftover';
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, FIX, { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.text === FIX || job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    // the goal's queue as a cut left it: a seed job keyed between the seeds' place (1.0) and the LLM place (0.7), ordered like the real queue
    const committed = mem.bases[0]!;
    let queues = 0;
    deps.createQueue = () => {
      const q = fakeQueue({ ordered: true });
      if (queues++ === 0) q.addAll([{ candidate: cand(replace, LEFTOVER, { op: 'leftover' }), base: committed, p: 0.8, sourcePrior: 0.8, key: [committed.summary.passed, 0.8, 0.8] }]);
      return q;
    };
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    expect(queues).toBe(2);
    // batch 1: the seed (the leftover sorts behind it; the plan allowed one run); batch 2: the grace's LLM candidate alone — the leftover never ran
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.text))).toEqual([[FIX], [LLM_FIX]]);
    expect(deps.rec.decideCalls).toHaveLength(1);
    expect(deps.rec.decideCalls[0]!.map((o) => o.applied.candidate.text).sort()).toEqual([FIX, LLM_FIX].sort());
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

  it('the feedback round L1′ (§4.9): round 1 ran without a passer, round 2 fires with the widened listing, and both rounds are booked on the trace', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const llm = fakeLlm({
      graceMs: 1000,
      rounds: (o) =>
        o.round === 1
          ? { arrivals: [{ candidates: [cand(replace, 'return gcd(a % b, a)', { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }] }
          : { arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }], staggered: false },
    });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    expect(llm.rec.fires).toEqual([
      { round: 1, editClass: null },
      { round: 2, widen: LLM_FEEDBACK_WIDEN, needPaths: [], editClass: null },
    ]);
    expect(mem.llm?.feedbackRounds.get(goal.id)).toBe(1);
    // round 1's summary is booked before round 2 replaces it: the trace counts both rounds (the §10.4 rows read this)
    expect(r.trace.llm).toMatchObject({ rounds: 2, samples: 2, valid: 2, cancelled: 0 });
    expect(r.trace.bySource.llm).toEqual({ enumerated: 2, tested: 2, passed: 1 });
  });

  it("arrivals past the run cap are booked, not queued: their dropped hunks reach the attempt ledger and the candidates stay for the source's cache", async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    // 3 runs this step: 1 for the seed, 2 for the LLM phase → a cap of 2 over the round's 3 samples
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ jev: 30, runs: 3, llmRounds: 2, llmSamples: 8, llmUsd: 0.02 }) });
    const goal = fakeGoal();
    const llm = fakeLlm({
      rounds: (o) =>
        o.round === 1
          ? {
              arrivals: [
                { candidates: [cand(replace, 'return gcd(a % b, a)', { source: 'llm', op: 'sample_0_0' })], delayMs: 1 },
                { candidates: [cand(replace, 'return gcd(a, a % b)', { source: 'llm', op: 'sample_1_0' })], delayMs: 2 },
                { candidates: [cand(replace, 'return gcd(b, a // b)', { source: 'llm', op: 'sample_2_0' })], delayMs: 8, dropped: [{ sample: 2, patch: 1, reason: 'syntax_error', detail: 'invalid syntax', sha: 'deadbeef0000' }] },
              ],
            }
          : null,
    });
    const deps = fakeSubGoalDeps({ sites: [replace], seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []) });
    // the lanes take a moment (a real run does): the third sample lands while the second batch runs
    const inner = deps.runQueue;
    deps.runQueue = async (...args) => {
      const out = await inner(...args);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return out;
    };
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    // two LLM candidates streamed into the lanes; the third arrival was booked but not queued
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.op))).toEqual([['identifier_substitution'], ['sample_0_0', 'sample_1_0']]);
    expect(r.trace.bySource.llm).toEqual({ enumerated: 2, tested: 2, passed: 0 });
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 3, valid: 3, cancelled: 0 });
    expect(mem.llm?.attempts.get(goal.id)?.find((a) => a.op === 'sample_2_1')?.verdict).toMatch(/syntax error: invalid syntax/);
    // nothing but the three classified runs is `tried`: the third sample's candidate can be replayed from the cache next step
    expect(mem.tried.size).toBe(3);
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

  it('builds the Q17 request when N−1 samples have arrived (§4.8): the last sample is not waited for and is cancelled when the search ends', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx({ ask: (qs) => ({ [EDIT_CLASS_QUESTION_ID]: choiceOn(qs[EDIT_CLASS_QUESTION_ID]!, 'substitute_one_token') }) });
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const c1 = cand(replace, 'return gcd(a % b, a)', { source: 'llm', op: 'sample_0_0' });
    const c2 = cand(replace, LLM_FIX, { source: 'llm', op: 'sample_1_0' });
    const c3 = cand(replace, 'return gcd(b, a // b)', { source: 'llm', op: 'sample_2_0' });
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [c1], delayMs: 1 }, { candidates: [c2], delayMs: 2 }, { candidates: [c3], delayMs: 5_000 }], staggered: false } : null) });
    const deps = fakeSubGoalDeps({ sites: [replace], statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'), decide: commitFirstPlausible });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    expect(llm.rec.orders).toEqual([[c1.id, c2.id]]);
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(deps.rec.runBatches[0]!.map((j) => j.candidate.id)).toEqual([c1.id, c2.id]);
    // sample 2 was still in flight when the commit ended the search
    expect(llm.rec.cancelled).toEqual(['commit']);
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 3, valid: 2, cancelled: 1 });
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
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [llmCand], delayMs: 40 }], klass: 'repository' } : null) });
    let roundOpenAtRank: boolean | null = null;
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      rank: (cands) => {
        roundOpenAtRank = !llm.rec.rounds[0]!.closed();
        return { ranked: cands.map((c, i) => ({ candidate: c, probability: 0.9 - i * 0.05, rank: i + 1 })), escapeProbability: 0.05, fixProbablyAbsent: false, method: 'choice' as const, requests: 1 };
      },
    });
    deps.llm = llm;
    const r = await searchBestGuess(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.source).toBe('llm');
    expect(llm.rec.fires).toEqual([{ round: 1, editClass: null }]);
    // §7.1 (2): Jev ranked the seeds while the round was still in flight (its sample lands 40 ms after the fire)
    expect(roundOpenAtRank).toBe(true);
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

  it('the LLM round is consumed before the seed phase (§4.2 "immediately on repository class"): its passer commits before a single seed is enumerated', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }], klass: 'repository' } : null) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'template' ? [cand(site, WRONG, { source: 'template', op: 'guard' })] : source === 'donor' ? [cand(site, 'return gcd(a, b % a)', { source: 'donor', op: 'donor_line' })] : []),
      statusOf: (job) => (job.candidate.text === LLM_FIX ? 'plausible' : 'unchanged'),
      decide: commitFirstPlausible,
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.source).toBe('llm');
    // the one batch is the round's, in the repository queue place; no seed source was enumerated, no site batch ran
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.source))).toEqual([['llm']]);
    expect(deps.rec.runBatches[0]![0]!.p).toBe(llmJobPrior('repository'));
    expect(deps.rec.enumerations).toEqual([]);
    expect(deps.rec.decideCalls).toHaveLength(1);
    const phases = ctx.events.flatMap((e) => (e.type === 'synth' ? [e.phase] : []));
    expect(phases).toContain('llm:phase');
    expect(phases).not.toContain('site');
    expect(r.trace.phase).toBe('LLM');
  });

  it('the LLM round finds nothing on repository class: the seeds follow in the same step, template and donor as one SIEVE batch behind the round', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    mem.repository = repositoryOf(goal.id);
    const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [cand(replace, 'return gcd(b, a // b)', { source: 'llm', op: 'sample_0_0' })], delayMs: 5 }], klass: 'repository' } : null) });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'template' ? [cand(site, WRONG, { source: 'template', op: 'guard' })] : source === 'donor' ? [cand(site, 'return gcd(a, b % a)', { source: 'donor', op: 'donor_line' })] : []),
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('parked');
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.source))).toEqual([['llm'], ['template', 'donor']]);
    // round 1 ran whole without a passer, so the feedback round was offered (and skipped by the adapter) before the seeds ran
    expect(llm.rec.fires.map((f) => f.round)).toEqual([1, 2]);
    const phases = ctx.events.flatMap((e) => (e.type === 'synth' ? [e.phase] : []));
    expect(phases.indexOf('llm:phase')).toBeLessThan(phases.indexOf('site'));
    expect(r.trace.bySource.llm).toEqual({ enumerated: 1, tested: 1, passed: 0 });
  });
});

describe('the round ends on evidence, not on closure (§4.2, §6.2)', () => {
  it('a sample-0 passer decides the streamed round the moment it is classified: the straggler is cancelled on the commit and billed as cancelled, never awaited to its deadline', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    // sample 0 lands 5 ms after the fire with the fix; sample 1 (released with the top-site miss) would land 1500 ms later
    const llm = fakeLlm({
      graceMs: 1000,
      rounds: (o) =>
        o.round === 1
          ? {
              arrivals: [
                { candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 },
                { candidates: [cand(replace, 'return gcd(b, a // b)', { source: 'llm', op: 'sample_1_0' })], delayMs: 1500 },
              ],
            }
          : null,
    });
    const at: { passer: number | null; decided: number | null } = { passer: null, decided: null };
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      statusOf: (job) => {
        if (job.candidate.text !== LLM_FIX) return 'unchanged';
        at.passer = Date.now();
        return 'plausible';
      },
      decide: (results) => {
        if (results.some((o) => o.applied.candidate.source === 'llm')) at.decided = Date.now();
        return commitFirstPlausible(results);
      },
    });
    deps.llm = llm;
    const t0 = Date.now();
    const r = await searchSubGoal(ctx, mem, goal, deps);
    const wall = Date.now() - t0;
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(LLM_FIX);
    // the decision followed the passer's classification, not the straggler's arrival or its deadline
    expect(at.passer).not.toBeNull();
    expect(at.decided).not.toBeNull();
    expect((at.decided ?? 0) - (at.passer ?? 0)).toBeLessThan(50);
    expect(wall).toBeLessThan(1000);
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.op))).toEqual([['identifier_substitution'], ['sample_0_0']]);
    expect(deps.rec.decideCalls).toHaveLength(2);
    // the straggler: cancelled the moment the guard committed, booked as cancelled on the trace (§4.2, §8.1)
    expect(llm.rec.cancelled).toEqual(['commit']);
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 2, valid: 1, cancelled: 1 });
    expect(r.trace.bySource.llm).toEqual({ enumerated: 1, tested: 1, passed: 1 });
    const phase = ctx.events.find((e) => e.type === 'synth' && e.phase === 'llm:phase');
    expect(phase?.type === 'synth' ? phase.detail : '').toMatch(/a passer landed — deciding now with the round still in flight/);
  });

  it('the guard holds the first passer: the stream is re-entered and the rest of the round is not lost — the next arrival forms the next batch and is decided again', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: llmBudget() });
    const goal = fakeGoal();
    const SECOND = 'return gcd(b, a % b)  # llm 2';
    const llm = fakeLlm({
      graceMs: 1000,
      rounds: (o) =>
        o.round === 1
          ? {
              arrivals: [
                { candidates: [cand(replace, LLM_FIX, { source: 'llm', op: 'sample_0_0' })], delayMs: 5 },
                { candidates: [cand(replace, SECOND, { source: 'llm', op: 'sample_1_0' })], delayMs: 60 },
              ],
            }
          : null,
    });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, WRONG, { op: 'identifier_substitution' })] : []),
      statusOf: (job) => (job.candidate.text === LLM_FIX || job.candidate.text === SECOND ? 'plausible' : 'unchanged'),
      // batch 2 is the first LLM batch: the guard keeps its passer as the step's suspect (rule b) and continues
      decide: (results, batch) => (batch === 2 ? { kind: 'continue' } : commitFirstPlausible(results)),
    });
    deps.llm = llm;
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(SECOND);
    // three batches, three decisions: the seeds, the held passer, then the re-entered stream's arrival
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.op))).toEqual([['identifier_substitution'], ['sample_0_0'], ['sample_1_0']]);
    expect(deps.rec.decideCalls).toHaveLength(3);
    // the round closed by itself once sample 1 landed: nothing to cancel
    expect(llm.rec.cancelled).toEqual([]);
    expect(r.trace.llm).toMatchObject({ rounds: 1, samples: 2, valid: 2, cancelled: 0 });
    expect(r.trace.bySource.llm).toEqual({ enumerated: 2, tested: 2, passed: 2 });
  });
});
