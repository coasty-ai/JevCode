/**
 * The §2.3 inner loop with faked collaborators: phase order (SEEDS → SKETCH → BEAM → WIDENED),
 * the Q7 soft prior (source and site order, permutation-first candidates, standalone question
 * only on slow oracles), SIEVE vs RANK dispatch through the real decideRunPlan, the
 * fixProbablyAbsent skip rule, exhausted bookkeeping across steps, budget exits, pairs of
 * partials, and the step-end commits (suspect, held partial).
 */
import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../src/core/hash.js';
import { guardState } from '../../../../src/synth/search/bases.js';
import { EDIT_CLASSES, EDIT_CLASS_QUESTION_ID, INSERT_FIRST_MIN_P, PERMUTATION_OPERATORS, alreadyTried, describeExhaustion, editClassQuestion, exhaustedKey, isSingleFileWorkspace, orderCandidates, orderSites, orderSources, priorFromAnswer, searchSubGoal, seedsExhaustedAt, siteOnBase, taskIdentifiers, testLiterals } from '../../../../src/synth/search/subgoal.js';
import type { EditClassPrior } from '../../../../src/synth/search/subgoal.js';
import { siteKey } from '../../../../src/synth/search/sites.js';
import type { Base, VerifyJob } from '../../../../src/synth/search/types.js';
import type { Candidate, CandidateSourceName, Site } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { GCD_OTHER_TEST, GCD_TEST, cand, choiceOn, fakeBudget, fakeCtx, fakeGoal, fakeMemory, fakeSubGoalDeps, fastOracle, gcdFixture, jobOf, outcomeOf, slowOracle, sourceFile, summary } from './controller-fakes.js';
import { choiceAnswer } from './helpers.js';

const NONE = new Set<CandidateSourceName>();
const FIX = 'return gcd(b, a % b)';

function prior(top: keyof typeof EDIT_CLASSES, p = 0.8): EditClassPrior {
  const probabilities = { substitute_one_token: 0, insert_fragment: 0, delete_fragment: 0, reorder_tokens: 0, reshape_line: 0, insert_new_line: 0 };
  for (const k of Object.keys(probabilities) as (keyof typeof probabilities)[]) probabilities[k] = k === top ? p : (1 - p) / 6;
  return { probabilities, escape: (1 - p) / 6, top };
}

function baseline(): ReturnType<typeof summary> {
  return summary({ command: 'pytest -q', failing: [GCD_TEST], passing: [GCD_OTHER_TEST] });
}

// ---------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------

describe('orderSources: the default order, the Q7 soft prior, the composite gate and the directive rotation', () => {
  it('SEEDS is mutation, template, donor; composite joins once all three are exhausted at the site', () => {
    expect(orderSources('SEEDS', null, NONE)).toEqual(['mutation', 'template', 'donor']);
    expect(orderSources('SEEDS', null, new Set(['mutation']))).toEqual(['template', 'donor']);
    expect(orderSources('SEEDS', null, new Set(['mutation', 'template', 'donor']))).toEqual(['composite']);
    expect(orderSources('SEEDS', null, new Set(['mutation', 'template', 'donor', 'composite']))).toEqual([]);
  });
  it('Q7 insert_new_line ≥ 0.5 → templates, donors, mutation (nothing dropped)', () => {
    expect(orderSources('SEEDS', prior('insert_new_line', INSERT_FIRST_MIN_P), NONE)).toEqual(['template', 'donor', 'mutation']);
    expect(orderSources('WIDENED', prior('insert_new_line'), NONE)).toEqual(['template', 'donor', 'mutation']);
    // below the threshold the default order stands
    expect(orderSources('SEEDS', prior('insert_new_line', 0.4), NONE)).toEqual(['mutation', 'template', 'donor']);
  });
  it('Q7 reorder_tokens / reshape_line → mutation first, composite as soon as mutation is exhausted, then templates and donors', () => {
    expect(orderSources('SEEDS', prior('reorder_tokens'), NONE)).toEqual(['mutation', 'template', 'donor']);
    expect(orderSources('SEEDS', prior('reshape_line'), new Set(['mutation']))).toEqual(['composite', 'template', 'donor']);
  });
  it('an escape-winning Q7 answer is no prior', () => {
    const q = editClassQuestion();
    const p = priorFromAnswer(choiceAnswer(q, { none_of_these: 0.7, reorder_tokens: 0.3 }));
    expect(p?.top).toBeNull();
    expect(orderSources('SEEDS', p, NONE)).toEqual(['mutation', 'template', 'donor']);
    expect(priorFromAnswer(undefined)).toBeNull();
    expect(priorFromAnswer({ type: 'noul' })).toBeNull();
  });
  it('the change_approach rotation turns the seed order left, exhausted sets untouched', () => {
    expect(orderSources('SEEDS', null, NONE, 1)).toEqual(['template', 'donor', 'mutation']);
    expect(orderSources('SEEDS', null, NONE, 2)).toEqual(['donor', 'mutation', 'template']);
    expect(orderSources('SEEDS', null, new Set(['donor']), 2)).toEqual(['mutation', 'template']);
    expect(orderSources('WIDENED', null, NONE, 1)).toEqual(['template', 'donor', 'mutation']);
  });
  it('SKETCH and BEAM have the single token_beam source; WIDENED never composes', () => {
    expect(orderSources('SKETCH', null, NONE)).toEqual(['token_beam']);
    expect(orderSources('BEAM', null, new Set(['token_beam']))).toEqual([]);
    expect(orderSources('WIDENED', null, new Set(['mutation', 'template', 'donor']))).toEqual([]);
  });
  it('the Q7 question is the measured Choice: six classes with definition + examples, and the escape', () => {
    const q = editClassQuestion();
    expect(q.type).toBe('choice');
    if (q.type === 'choice') {
      expect(Object.keys(q.criteria)).toEqual([...Object.keys(EDIT_CLASSES), 'none_of_these']);
      expect(q.criteria['reorder_tokens']).toContain('`gcd(a % b, b)` -> `gcd(b, a % b)`');
      expect(q.instructions).toContain('Which kind of edit turns `buggy_line` into the correct line');
    }
    expect(EDIT_CLASS_QUESTION_ID).toBe('edit_class');
  });
});

describe('site and candidate ordering under the prior', () => {
  const { replace, insert } = gcdFixture();
  it('insert sites first only at insert_new_line ≥ 0.5', () => {
    expect(orderSites([replace, insert], null).map((s) => s.kind)).toEqual(['replace', 'insert']);
    expect(orderSites([replace, insert], prior('insert_new_line')).map((s) => s.kind)).toEqual(['insert', 'replace']);
    expect(orderSites([replace, insert], prior('substitute_one_token')).map((s) => s.kind)).toEqual(['replace', 'insert']);
  });
  it('permutation-operator mutants first under reorder_tokens, stable otherwise', () => {
    const a = cand(replace, 'return gcd(a % b, a)', { op: 'identifier_substitution' });
    const b = cand(replace, FIX, { op: 'argument_swap' });
    const c = cand(replace, 'return gcd(a // b, b)', { op: 'arithmetic_swap' });
    expect(orderCandidates([a, b, c], null)).toEqual([a, b, c]);
    expect(orderCandidates([a, b, c], prior('reorder_tokens'))).toEqual([b, a, c]);
    expect(PERMUTATION_OPERATORS).toContain('argument_swap');
  });
});

describe('helpers', () => {
  const { file, replace, insert } = gcdFixture();
  it('siteOnBase keeps the site on the committed base and re-maps it onto an improved base only while the line still reads the same', () => {
    const committed: Base = { id: 'committed', origin: 'committed', fromGoal: null, files: new Map([[file.path, file]]), summary: baseline(), depth: 0 };
    expect(siteOnBase(replace, committed)).toBe(replace);
    const same = sourceFile('gcd.py', file.src.replace('if b == 0', 'if b <= 0'));
    const improved: Base = { ...committed, id: 'improved', origin: 'improved', fromGoal: 'g1', files: new Map([[same.path, same]]), depth: 1 };
    expect(siteOnBase(replace, improved)?.file).toBe(same);
    const shifted = sourceFile('gcd.py', `import math\n${file.src}`);
    expect(siteOnBase(replace, { ...improved, files: new Map([[shifted.path, shifted]]) })).toBeNull();
    expect(siteOnBase(insert, { ...improved, files: new Map() })).toBeNull();
  });
  it('alreadyTried keys on the sha12 of the diff on the base; a stale site counts as tried', () => {
    const committed: Base = { id: 'committed', origin: 'committed', fromGoal: null, files: new Map([[file.path, file]]), summary: baseline(), depth: 0 };
    const c = cand(replace, FIX);
    const mem = fakeMemory([file], baseline());
    expect(alreadyTried(c, committed, mem)).toBe(false);
    mem.tried.add(sha12(applyCandidate(c).diff));
    expect(alreadyTried(c, committed, mem)).toBe(true);
    const stale = { ...replace, currentLine: 'something else' };
    expect(alreadyTried(cand(stale, FIX), committed, mem)).toBe(true);
  });
  it('single-file rule, test-derived literals, task identifiers, exhausted keys and the park reason', () => {
    expect(isSingleFileWorkspace(new Map([['gcd.py', file]]))).toBe(true);
    expect(isSingleFileWorkspace(new Map([['gcd.py', file], ['node.py', file]]))).toBe(true);
    expect(isSingleFileWorkspace(new Map([['a.py', file], ['b.py', file], ['c.py', file]]))).toBe(false);
    expect(testLiterals([{ testId: 't', call: "wrap('abc', 2)", expected: "['ab', 'c']", actual: 'None' }])).toEqual(["'abc'", '2', "'ab'", "'c'", 'None']);
    expect(taskIdentifiers('The function `gcd` in `gcd.py` fails; see max_sublist_sum and camelCase')).toEqual(['gcd', 'py', 'max_sublist_sum', 'camelCase']);
    expect(exhaustedKey(replace, 'SEEDS')).toBe(siteKey(replace));
    expect(exhaustedKey(replace, 'SKETCH')).toBe(`${siteKey(replace)}#SKETCH`);
    const goal = fakeGoal({ exhausted: new Map([[siteKey(replace), new Set<CandidateSourceName>(['mutation', 'template', 'donor'])]]) });
    expect(seedsExhaustedAt(goal, replace)).toBe(true);
    expect(seedsExhaustedAt(goal, insert)).toBe(false);
    expect(describeExhaustion(goal, [replace, insert])).toBe(`exhausted donor, mutation, template at 2 sites (gcd.py:5, gcd.py:6 (gap)) for ${GCD_TEST}`);
  });
});

// ---------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------

describe('searchSubGoal: SIEVE dispatch and the phase order on a fast oracle', () => {
  it('runs every candidate without ranking, walks SEEDS → SKETCH → BEAM → WIDENED, records exhaustion and parks', async () => {
    const { file, replace, insert, fn } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ jev: 60 }) });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({
      sites: [replace, insert],
      functions: [fn],
      seed: (source, site) => (source === 'mutation' && site.kind === 'replace' ? [cand(site, `${site.currentLine.trim()} + 0`, { op: 'off_by_one_literal' }), cand(site, site.currentLine.trim().replace('%', '//'), { op: 'arithmetic_swap' })] : source === 'template' && site.kind === 'insert' ? [cand(site, 'return a', { source: 'template', op: 'insert_return_scope' })] : []),
      sketch: (site) => ({ candidates: [cand(site, 'return gcd(a, b % a)', { source: 'template', op: 'sketch_P4' })], requests: 3 }),
      beam: (site) => ({ candidates: [cand(site, 'return gcd(b, b)', { source: 'token_beam', op: 'beam' })], requests: 10 }),
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('parked');
    if (r.kind === 'parked') expect(r.reason).toMatch(/^exhausted composite, donor, mutation, template, token_beam at 2 sites/);
    // no Jev ranking and no standalone Q7 on a fast oracle (SIEVE: tests rank)
    expect(deps.rec.rankCalls).toEqual([]);
    expect(ctx.askCalls).toEqual([]);
    expect(r.trace.runMode).toBe('SIEVE');
    // SEEDS: all three seeds at the replace site, then at the gap; composite after them at each site
    const seeds = deps.rec.enumerations.slice(0, 8);
    expect(seeds).toEqual([
      { source: 'mutation', line: 5, kind: 'replace' },
      { source: 'template', line: 5, kind: 'replace' },
      { source: 'donor', line: 5, kind: 'replace' },
      { source: 'composite', line: 5, kind: 'replace' },
      { source: 'mutation', line: 6, kind: 'insert' },
      { source: 'template', line: 6, kind: 'insert' },
      { source: 'donor', line: 6, kind: 'insert' },
      { source: 'composite', line: 6, kind: 'insert' },
    ]);
    // SKETCH at both (top-3) sites, then BEAM at both (top-2) sites once SKETCH ran there and ≥ 35 requests remain
    expect(deps.rec.sketchCalls).toEqual([5, 6]);
    expect(deps.rec.beamCalls).toEqual([5, 6]);
    // WIDENED: the other code lines of gcd (2, 3, 4), never the def line, never the SEEDS site
    const widened = deps.rec.enumerations.filter((e) => e.source === 'mutation').map((e) => e.line);
    expect(widened).toEqual([5, 6, 2, 3, 4]);
    expect(goal.phase).toBe('WIDENED');
    expect(mem.widenCursor.get(goal.id)).toBe(3);
    // every batch ran everything queued: 2 mutants, 1 template, 2 sketch lines, 2 beam lines, one widened mutant per new line (the `//` variant of a line without `%` is the unchanged line and is dropped)
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(r.trace.candidatesTested).toBe(10);
    expect(r.trace.candidatesEnumerated).toBe(10);
    expect(r.trace.jevRequests).toBe(2 + 3 + 3 + 10 + 10);
    expect(r.trace.bySource.mutation).toEqual({ enumerated: 5, tested: 5, passed: 0 });
    expect(r.trace.bySource.template).toEqual({ enumerated: 3, tested: 3, passed: 0 });
    expect(r.trace.sitesConsidered).toBe(2 + 3);
    // exhausted bookkeeping: the seed sources and composite at both sites, token_beam under the SKETCH key and the BEAM key
    expect([...(goal.exhausted.get(siteKey(replace)) ?? [])].sort()).toEqual(['composite', 'donor', 'mutation', 'template', 'token_beam']);
    expect(goal.exhausted.get(exhaustedKey(replace, 'SKETCH'))?.has('token_beam')).toBe(true);
    expect(r.trace.outcome).toBe('exhausted');
    expect(mem.localizeCache.has(goal.id)).toBe(true);
    expect(deps.rec.locateCalls).toBe(1);
  });

  it('a second step re-uses the cached sites and skips every exhausted source', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ jev: 10 }) });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({ sites: [replace], seed: (source, site) => (source === 'mutation' ? [cand(site, FIX, { op: 'argument_swap' })] : []) });
    await searchSubGoal(ctx, mem, goal, deps);
    const enumerated = deps.rec.enumerations.length;
    mem.stepBudget = fakeBudget({ jev: 10 });
    const again = await searchSubGoal(ctx, mem, goal, deps);
    expect(deps.rec.locateCalls).toBe(1);
    // nothing re-enumerated at the exhausted site (sketch/beam did not run: BEAM needs ≥ 35 requests, SKETCH is exhausted too)
    expect(deps.rec.enumerations.length).toBe(enumerated);
    expect(again.kind).toBe('parked');
  });

  it('a lone passer is committed as soon as its batch is decided; the source is exhausted when everything ran', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'return gcd(a, b)', { op: 'identifier_substitution' }), cand(site, FIX, { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.text === FIX ? 'plausible' : 'unchanged'),
      decide: (results) => {
        const winner = results.find((o) => o.status === 'plausible');
        return winner === undefined ? { kind: 'continue' } : { kind: 'commit', applied: winner.applied, allGoalTestsPass: true };
      },
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.applied.candidate.text).toBe(FIX);
    expect(r.trace).toMatchObject({ outcome: 'fixed', plausible: 1, candidatesTested: 2, testRuns: 3 });
    expect(r.trace.winner?.candidate.text).toBe(FIX);
    expect(r.trace.bySource.mutation).toEqual({ enumerated: 2, tested: 2, passed: 1 });
    expect(deps.rec.enumerations).toEqual([{ source: 'mutation', line: 5, kind: 'replace' }]);
    expect(goal.exhausted.get(siteKey(replace))?.has('mutation')).toBe(true);
    expect(goal.status).toBe('active');
  });

  it('the budget stops the step: `budget` after the batch that spent the last run, phase kept for the next step', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 2 }) });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'mutation' && site.kind === 'replace' ? [cand(site, FIX), cand(site, 'return a')] : [cand(site, 'return b', { source })]) });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(r.trace.outcome).toBe('budget');
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(goal.phase).toBe('SEEDS');
    // the exhausted set records what ran; the rest of the site's sources wait for the next step
    expect([...(goal.exhausted.get(siteKey(replace)) ?? [])]).toEqual(['mutation']);
  });
});

describe('searchSubGoal: RANK dispatch on a slow oracle', () => {
  it('asks Q7 up front, re-orders sites and sources by it, ranks each set and queues only the top K', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx({
      ask: (questions) => {
        const q = questions[EDIT_CLASS_QUESTION_ID];
        if (q === undefined) throw new Error('expected the edit_class question');
        return { [EDIT_CLASS_QUESTION_ID]: choiceOn(q, 'insert_new_line', 0.7) };
      },
    });
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: fakeBudget({ jev: 60, runs: 16, wallMs: 600_000 }) });
    const goal = fakeGoal();
    const many = (site: Site, n: number, source: CandidateSourceName): Candidate[] => Array.from({ length: n }, (_, i) => cand(site, `return ${source}_${i}`, { source }));
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'composite' ? [] : many(site, 7, source)) });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    // Q7 was one recorded request over the measured state shape
    expect(ctx.askCalls).toHaveLength(1);
    expect(ctx.askCalls[0]?.state).toMatchObject({ buggy_line: expect.any(String), tests: expect.any(Array) });
    expect((ctx.askCalls[0]?.state as { program: string }).program).toContain('<<<FIX THIS LINE>>>');
    // insert site first, templates → donors → mutation there; then templates at the replace site, where the 16-run cap ends the step
    expect(deps.rec.enumerations).toEqual([
      { source: 'template', line: 6, kind: 'insert' },
      { source: 'donor', line: 6, kind: 'insert' },
      { source: 'mutation', line: 6, kind: 'insert' },
      { source: 'template', line: 5, kind: 'replace' },
    ]);
    // every set of 7 ranked; K = 5 at the gap (§2.4), then the one run the cap had left at the replace site
    expect(deps.rec.rankCalls.map((c) => c.n)).toEqual([7, 7, 7, 7]);
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([5, 5, 5, 1]);
    expect(r.trace.runMode).toBe('RANK');
    expect(r.trace.candidatesRanked).toBe(28);
    // a RANK cut leaves the rest enumerable: the sources are not exhausted at the sites
    expect(goal.exhausted.get(siteKey(insert))?.has('template')).toBe(false);
    // the 16-run cap ended the step
    expect(r.kind).toBe('budget');
    expect(r.trace.jevRequests).toBe(2 + 1 + 4);
  });

  it('spends no ranking request when the step cannot afford a single run (§2.4 runsLeft = 0): `budget` at once', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx({ ask: (questions) => ({ [EDIT_CLASS_QUESTION_ID]: choiceOn(questions[EDIT_CLASS_QUESTION_ID]!, 'substitute_one_token', 0.6) }) });
    // 1 s of test wall over 4 lanes cannot fit one 30 s run, while the run count and the request count are not spent
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: fakeBudget({ jev: 60, runs: 16, wallMs: 1_000 }) });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'composite' ? [] : [cand(site, `return ${source}_1`, { source }), cand(site, `return ${source}_2`, { source })]) });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(deps.rec.rankCalls).toEqual([]);
    expect(deps.rec.runBatches).toEqual([]);
    // localisation and the up-front Q7 are the only requests; nothing is marked exhausted
    expect(r.trace.jevRequests).toBe(2 + 1);
    expect(mem.stepBudget.jevRequestsLeft).toBe(60 - 3);
    expect(goal.exhausted.get(siteKey(replace))?.size ?? 0).toBe(0);
  });

  it('fixProbablyAbsent switches sources before a run is spent, except at the last site and at gaps', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx({ ask: (questions) => ({ [EDIT_CLASS_QUESTION_ID]: choiceOn(questions[EDIT_CLASS_QUESTION_ID]!, 'substitute_one_token', 0.6) }) });
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: fakeBudget({ jev: 60, runs: 16, wallMs: 600_000 }) });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({
      sites: [replace, insert],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'return 1', { source }), cand(site, 'return 2', { source })] : []),
      rank: (cands) => ({ ranked: cands.map((c, i) => ({ candidate: c, probability: 0.1, rank: i + 1 })), escapeProbability: 0.8, fixProbablyAbsent: true, method: 'choice', requests: 1 }),
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    // replace site (not last): skipped, marked exhausted, no run; insert site (a gap, and last): ranked and run anyway
    expect(deps.rec.rankCalls.map((c) => c.line)).toEqual([5, 6]);
    expect(deps.rec.runBatches.map((b) => b[0]?.candidate.site.line)).toEqual([6]);
    expect(goal.exhausted.get(siteKey(replace))?.has('mutation')).toBe(true);
    expect(r.kind).toBe('parked');
  });
});

describe('searchSubGoal: exhausted bookkeeping when the runner stops short', () => {
  it('a SIEVE batch the runner cut short leaves the source open; the next step re-enumerates only what did not run', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ jev: 10 }) });
    const goal = fakeGoal();
    const texts = ['return gcd(a, b)', FIX, 'return gcd(b, a)', 'return gcd(a % b, a)'];
    const deps = fakeSubGoalDeps({ sites: [replace], seed: (source, site) => (source === 'mutation' ? texts.map((t) => cand(site, t, { op: 'identifier_substitution' })) : []) });
    // the runner classifies only the first two of every batch (the step's wall ran out; the rest were not popped or were deferred)
    const inner = deps.runQueue;
    let cut = true;
    deps.runQueue = async (c, m, queue, g, runsAllowed) => {
      const outcomes = await inner(c, m, queue, g, cut ? Math.min(2, runsAllowed) : runsAllowed);
      return outcomes;
    };
    const first = await searchSubGoal(ctx, mem, goal, deps);
    expect(first.kind).toBe('parked');
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.text))).toEqual([[texts[0], texts[1]]]);
    // mutation is NOT exhausted at the site: two candidates never ran and are not in `tried`
    expect(goal.exhausted.get(siteKey(replace))?.has('mutation')).toBe(false);
    expect(mem.tried.size).toBe(2);
    // next step: the two that ran are filtered by `tried`, the other two run, and now the source is exhausted
    cut = false;
    mem.stepBudget = fakeBudget({ jev: 10 });
    const second = await searchSubGoal(ctx, mem, goal, deps);
    expect(second.kind).toBe('parked');
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.text))).toEqual([[texts[0], texts[1]], [texts[2], texts[3]]]);
    expect(goal.exhausted.get(siteKey(replace))?.has('mutation')).toBe(true);
  });
});

describe('searchSubGoal: pairs of partials, the flagged suspect and the held partial at step end', () => {
  it('tests ≤ 10 pairs after SEEDS and commits a plausible pair', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal();
    const pairs = Array.from({ length: 12 }, (_, i) => cand(replace, `return gcd(b, a % b) # pair ${i}`, { source: 'composite', op: 'pair_of_partials' }));
    const deps = fakeSubGoalDeps({
      sites: [replace],
      pairs,
      statusOf: (job) => (job.candidate.text.endsWith('# pair 3') ? 'plausible' : 'unchanged'),
      decide: (results) => {
        const w = results.find((o) => o.status === 'plausible');
        return w === undefined ? { kind: 'continue' } : { kind: 'commit', applied: w.applied, allGoalTestsPass: true };
      },
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(deps.rec.runBatches[0]).toHaveLength(10);
    expect(r.trace.bySource.composite).toEqual({ enumerated: 10, tested: 10, passed: 1 });
  });

  it('a passer the guard flagged is committed at step end with `possible overfit` (never withheld)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'return 13', { op: 'constant_substitution' })] : []),
      statusOf: () => 'plausible',
      decide: (results, _batch, m) => {
        // the all-overfit signature: keep searching, remember the smallest edit
        const first = results[0];
        guardState(m).suspect = first === undefined ? null : { goalId: 'g1', outcome: first };
        return { kind: 'continue', plausible: results.length, clusters: 1, arbitrated: true, requests: 1 };
      },
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.note).toBe('possible overfit');
      expect(r.applied.candidate.text).toBe('return 13');
    }
    expect(r.trace).toMatchObject({ outcome: 'fixed', arbitrated: true, clusters: 1, plausible: 1 });
    // the guard's own request was charged to the step budget and the trace (2 localisation, 1 guard, 1 sketch round once SEEDS was exhausted)
    expect(r.trace.jevRequests).toBe(2 + 1 + 1);
    expect(guardState(mem).suspect).toBeNull();
  });

  it('the held partial is committed with `partial` once every source is exhausted', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal();
    const committed = mem.bases[0]!;
    const partialCand = cand(replace, 'return gcd(a % b, a)', { op: 'identifier_substitution' });
    const job: VerifyJob = jobOf(partialCand, committed);
    const outcome = outcomeOf(job, 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: ['tests/test_gcd.py::test_more'] }) });
    mem.bases.push({ id: 'improved-g1', origin: 'improved', fromGoal: goal.id, files: committed.files, summary: outcome.subset, candidate: outcome.applied, depth: 1 });
    const deps = fakeSubGoalDeps({ sites: [replace] });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.note).toBe('partial');
      expect(r.allGoalTestsPass).toBe(false);
      expect(r.applied.candidate.text).toBe('return gcd(a % b, a)');
    }
    expect(r.trace.outcome).toBe('partial');
    // the improved base left the beam
    expect(mem.bases.map((b) => b.id)).toEqual(['committed']);
  });

  it('no located site parks the goal without spending anything', async () => {
    const { file } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const deps = fakeSubGoalDeps({ sites: [] });
    const r = await searchSubGoal(ctx, mem, fakeGoal(), deps);
    expect(r).toMatchObject({ kind: 'parked', reason: `no site located for ${GCD_TEST}` });
    expect(deps.rec.enumerations).toEqual([]);
  });
});
