/**
 * The §2.3 inner loop with faked collaborators: phase order (SEEDS → SKETCH → BEAM → WIDENED),
 * the Q7 soft prior (source and site order, permutation-first candidates, standalone question
 * only on slow oracles), SIEVE vs RANK dispatch through the real decideRunPlan, the
 * fixProbablyAbsent skip rule, exhausted bookkeeping across steps, budget exits, pairs of
 * partials, and the step-end commits (suspect, held partial).
 */
import { describe, expect, it } from 'vitest';

import type { Answer, Question } from '../../../../src/core/types.js';
import { sha12 } from '../../../../src/core/hash.js';
import { guardState, heldPartialOutcome, holdBestPartial, improvedBaseFor, pairsOfPartials, partialsOf, siteKeyOf } from '../../../../src/synth/search/bases.js';
import { createDecide } from '../../../../src/synth/search/guard.js';
import { EDIT_CLASSES, EDIT_CLASS_QUESTION_ID, INSERT_FIRST_MIN_P, PAIRS_RESERVE_RUNS, PAIRS_RESERVE_WALL_MS, PERMUTATION_OPERATORS, alreadyTried, describeExhaustion, editClassQuestion, enumerateOptions, everySiteSeedsExhausted, exhaustedKey, isSingleFileWorkspace, orderCandidates, orderSites, orderSources, priorFromAnswer, runsBeforeReserve, searchSubGoal, seedsExhaustedAt, siteOnBase, taskIdentifiers, testLiterals } from '../../../../src/synth/search/subgoal.js';
import { statementSiteAt } from '../../../../src/synth/localize/sites.js';
import type { EditClassPrior } from '../../../../src/synth/search/subgoal.js';
import { siteKey } from '../../../../src/synth/search/sites.js';
import type { Base, VerifyJob } from '../../../../src/synth/search/types.js';
import type { Candidate, CandidateSourceName, Site } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { GCD_OTHER_TEST, GCD_TEST, cand, choiceOn, fakeBudget, fakeCtx, fakeGoal, fakeMemory, fakeSubGoalDeps, fastOracle, gcdFixture, jobOf, outcomeOf, siteAt, slowOracle, sourceFile, summary } from './controller-fakes.js';
import { choiceAnswer, noulAnswer } from './helpers.js';

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
      // examples are invented snippets, never a benchmark's gold line (see no-benchmark-leakage.test.ts)
      expect(q.criteria['reorder_tokens']).toContain('`divide(denominator, numerator)` -> `divide(numerator, denominator)`');
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
    // WIDENED: the other code lines of gcd (2, 3, 4) and its gap slots (before L2 after the def, before L3 after `if b == 0:`,
    // before L5 after `else:`; nothing after the two `return`s); never the def line, never the SEEDS sites. Ordered by line
    // evidence (none on this fixture) then by distance from the top-1 line L5, the gap before a line ahead of the line.
    const widened = deps.rec.enumerations.filter((e) => e.source === 'mutation').map((e) => e.line);
    expect(widened).toEqual([5, 6, 5, 4, 3, 3, 2, 2]);
    expect(deps.rec.enumerations.filter((e) => e.source === 'mutation').slice(2).map((e) => e.kind)).toEqual(['insert', 'replace', 'insert', 'replace', 'insert', 'replace']);
    expect(goal.phase).toBe('WIDENED');
    expect(mem.widenCursor.get(goal.id)).toBe(6);
    // every batch ran everything queued: 2 mutants, 1 template, 2 sketch lines, 2 beam lines, then per widened site one template statement at a gap or one mutant on a line (the `//` variant of a line without `%` is the unchanged line and is dropped)
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(r.trace.candidatesTested).toBe(13);
    expect(r.trace.candidatesEnumerated).toBe(13);
    expect(r.trace.jevRequests).toBe(2 + 3 + 3 + 10 + 10);
    expect(r.trace.bySource.mutation).toEqual({ enumerated: 5, tested: 5, passed: 0 });
    expect(r.trace.bySource.template).toEqual({ enumerated: 6, tested: 6, passed: 0 });
    expect(r.trace.sitesConsidered).toBe(2 + 6);
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
    // the site's three seed sources were enumerated together (one SIEVE batch, one decision); the search stopped at the commit
    expect(deps.rec.enumerations).toEqual([
      { source: 'mutation', line: 5, kind: 'replace' },
      { source: 'template', line: 5, kind: 'replace' },
      { source: 'donor', line: 5, kind: 'replace' },
    ]);
    expect(deps.rec.decideCalls).toHaveLength(1);
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
    // OOS 2026-09-22 ranked change 1: RANK is the pool-outgrows-the-budget case, so each set is 20 against 16 runs
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'composite' ? [] : many(site, 20, source)) });
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
    // only the candidates a run could still reach are priced (`rankPoolCap`): 16, then 11, 6, 1 as the
    // cap is spent — never the whole set of 20 (OOS 2026-09-22 Q4: sympy-16792 ranked 27,754 to test 1,191).
    // K = 5 at the gap (§2.4), then the one run the cap had left at the replace site
    expect(deps.rec.rankCalls.map((c) => c.n)).toEqual([16, 11, 6, 1]);
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([5, 5, 5, 1]);
    expect(r.trace.runMode).toBe('RANK');
    expect(r.trace.candidatesRanked).toBe(34);
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
      // 20 mutants against 16 runs left: RANK, since a set that fits the run budget is simply run (ranked change 1)
      seed: (source, site) => (source === 'mutation' ? Array.from({ length: 20 }, (_, i) => cand(site, `return ${i}`, { source })) : []),
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

  it('the held partial is committed with `partial` once every source is exhausted, after its full-suite regression run (the evidence\'s `after`)', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal({ tests: [GCD_TEST, 'tests/test_gcd.py::test_more'] });
    const committed = mem.bases[0]!;
    const partialCand = cand(replace, 'return gcd(a % b, a)', { op: 'identifier_substitution' });
    const job: VerifyJob = jobOf(partialCand, committed);
    const outcome = outcomeOf(job, 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: ['tests/test_gcd.py::test_more'] }) });
    expect(holdBestPartial(mem, [outcome], goal).replaced).toBe(true);
    const full = summary({ command: baseline().command, passing: [GCD_OTHER_TEST, GCD_TEST, 'tests/test_gcd.py::test_far'], failing: ['tests/test_gcd.py::test_more'] });
    const deps = fakeSubGoalDeps({ sites: [replace], regressionRun: () => full });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.note).toBe('partial');
      expect(r.allGoalTestsPass).toBe(false);
      expect(r.applied.candidate.text).toBe('return gcd(a % b, a)');
      // the regression run, not the subset, is what the commit rests on
      expect(r.after).toBe(full);
      expect(r.outcome?.full).toBe(full);
    }
    expect(r.trace.outcome).toBe('partial');
    // the improved base left the beam
    expect(mem.bases.map((b) => b.id)).toEqual(['committed']);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /progress commit — partial fix .* 1 of 2 goal tests pass .* the remaining 1 stay open/.test(e.detail))).toBe(true);
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

// ---------------------------------------------------------------------------------------
// Controller bookkeeping (jev-only-ladder-4 round): whole-site batches, pairs before the reserve, the held passer on a budget exit
// ---------------------------------------------------------------------------------------

describe('whole-site batches, the pairs reserve and the held passer on a budget exit', () => {
  const TWO = 'tests/test_gcd.py::test_two';

  it("SIEVE: a site's seed sources run as ONE batch decided ONCE; the real guard commits a clean lone passer at once (no pending hold); an exhausted site consumes no decision", async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget() });
    const goal = fakeGoal();
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) =>
        source === 'mutation'
          ? [cand(site, 'return gcd(a, b)', { op: 'identifier_substitution' }), cand(site, FIX, { op: 'argument_swap' })]
          : source === 'template'
            ? [cand(site, 'return a % b', { source: 'template', op: 'return_expr' })]
            : source === 'donor'
              ? [cand(site, 'return b', { source: 'donor', op: 'statement_donor' })]
              : [],
      statusOf: (job) => (job.candidate.text === FIX ? 'plausible' : 'unchanged'),
    });
    const guard = createDecide();
    let decisions = 0;
    deps.decide = (c, m, g, results) => {
      decisions += 1;
      return guard(c, m, g, results);
    };
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.applied.candidate.text).toBe(FIX);
      expect(r.note).toBeUndefined();
    }
    // one batch of the four candidates of the three sources, one decision, no Jev question
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.text))).toEqual([['return gcd(a, b)', FIX, 'return a % b', 'return b']]);
    expect(decisions).toBe(1);
    expect(ctx.askCalls).toEqual([]);
    // the site's sources were exhausted BEFORE the decision, so the guard's rule (a) saw the site batch as done and held nothing
    expect([...(goal.exhausted.get(siteKey(replace)) ?? [])].sort()).toEqual(['donor', 'mutation', 'template']);
    expect(guardState(mem).pending).toBeNull();
    expect(r.trace).toMatchObject({ plausible: 1, candidatesTested: 4, runMode: 'SIEVE', outcome: 'fixed' });
    // a later search finds nothing fresh at the site: no batch, no decision
    goal.status = 'open';
    mem.stepBudget = fakeBudget({ jev: 10 });
    const again = await searchSubGoal(ctx, mem, goal, deps);
    expect(again.kind).toBe('parked');
    expect(decisions).toBe(1);
    expect(deps.rec.runBatches).toHaveLength(1);
  });

  it('complementary partials: their untested pair runs before the batch that would spend the pairs reserve, and a passing pair is committed as one composite candidate', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx();
    const base = summary({ command: 'pytest -q', failing: [GCD_TEST, TWO], passing: [GCD_OTHER_TEST] });
    // 40 runs on a 300 ms / 8-lane oracle: the 15 s pairs reserve is 400 runs, so any batch would spend it once a pair exists
    const mem = fakeMemory([file], base, { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 40 }) });
    expect(runsBeforeReserve(mem)).toBe(0);
    expect(runsBeforeReserve({ oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1500, wallMs: 90_000 }) })).toBe(1500 - Math.max(PAIRS_RESERVE_RUNS, Math.ceil((PAIRS_RESERVE_WALL_MS * 8) / 300)));
    const goal = fakeGoal({ tests: [GCD_TEST, TWO] });
    const filler = siteAt(file, 2);
    const deps = fakeSubGoalDeps({
      sites: [replace, insert, filler],
      seed: (source, site) =>
        source === 'mutation' && site === replace
          ? [cand(site, 'return gcd(b, a % b)  # half 1', { op: 'argument_swap' })]
          : source === 'template' && site === insert
            ? [cand(site, 'return a  # half 2', { source: 'template', op: 'insert_return' })]
            : source === 'mutation' && site === filler
              ? [cand(site, 'if b == 1:'), cand(site, 'if b != 0:'), cand(site, 'if b >= 0:')]
              : [],
    });
    // the guard's bookkeeping, minimal: partials are remembered (bases.ts), a passer commits; the real pairing
    deps.decide = async (_c, m, g, results) => {
      for (const o of results) if (o.status === 'partial') guardState(m).partials.push({ goalId: g.id, outcome: o });
      const w = results.find((o) => o.status === 'plausible');
      return w === undefined ? { kind: 'continue' } : { kind: 'commit', applied: w.applied, allGoalTestsPass: true };
    };
    deps.pairsOfPartials = pairsOfPartials;
    // the runner: half 1 passes GCD_TEST, half 2 passes TWO, their pair passes both, the filler changes nothing
    deps.runQueue = async (_c, m, queue, _g, runsAllowed) => {
      const jobs = queue.pop(runsAllowed);
      deps.rec.runBatches.push(jobs);
      m.stepBudget.testRunsLeft -= jobs.length;
      const outcomes = jobs.map((j) => {
        const t = j.candidate.text;
        if (j.candidate.op === 'pair_of_partials') return outcomeOf(j, 'plausible');
        if (t.includes('half 1')) return outcomeOf(j, 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: [TWO] }) });
        if (t.includes('half 2')) return outcomeOf(j, 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, TWO], failing: [GCD_TEST] }) });
        return outcomeOf(j, 'unchanged');
      });
      for (const o of outcomes) m.tried.add(sha12(o.applied.diff));
      return outcomes;
    };
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.applied.candidate.op).toBe('pair_of_partials');
      expect(r.applied.candidate.extraEdits).toHaveLength(1);
      expect(r.applied.files[0]?.after).toContain('half 1');
      expect(r.applied.files[0]?.after).toContain('half 2');
    }
    // batches: half 1 at L5, half 2 at the gap, then the pair — the filler site was enumerated but its batch never ran
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(deps.rec.runBatches[2]?.[0]?.candidate.op).toBe('pair_of_partials');
    expect(deps.rec.enumerations.some((e) => e.line === 2 && e.source === 'mutation')).toBe(true);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'pairs' && /testing 1 pair of complementary partials/.test(e.detail))).toBe(true);
    expect(r.trace.bySource.composite).toEqual({ enumerated: 1, tested: 1, passed: 1 });
    expect(r.trace.outcome).toBe('fixed');
  });

  it('a step that ends on its budget commits the passer the guard holds (pending or suspect) instead of returning `budget` with the hold dropped', async () => {
    for (const hold of ['pending', 'suspect'] as const) {
      const { file, replace } = gcdFixture();
      const ctx = fakeCtx();
      const mem = fakeMemory([file], baseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
      const goal = fakeGoal();
      const deps = fakeSubGoalDeps({
        sites: [replace],
        seed: (source, site) => (source === 'mutation' ? [cand(site, 'return 13', { op: 'constant_substitution' })] : []),
        statusOf: () => 'plausible',
        decide: (results, _batch, m) => {
          const first = results[0];
          if (first === undefined) throw new Error('expected the one candidate');
          if (hold === 'suspect') guardState(m).suspect = { goalId: 'g1', outcome: first, phase: 'SEEDS', signals: ['deletes_statement', 'duplicates_block'], noul: 0.5 };
          else guardState(m).pending = { goalId: 'g1', outcome: first, siteKey: siteKeyOf(first.applied.candidate), phase: 'SEEDS' };
          return { kind: 'continue', plausible: 1 };
        },
      });
      const r = await searchSubGoal(ctx, mem, goal, deps);
      // the one run was spent: the budget ended the step, and the held passer left with it as the commit
      expect(deps.rec.runBatches).toHaveLength(1);
      expect(mem.stepBudget.exhausted()).toBe(true);
      expect(r.kind).toBe('commit');
      if (r.kind === 'commit') {
        expect(r.applied.candidate.text).toBe('return 13');
        expect(r.note).toBe(hold === 'suspect' ? 'possible overfit' : undefined);
      }
      expect(r.trace.outcome).toBe('fixed');
      expect(guardState(mem).suspect).toBeNull();
      expect(guardState(mem).pending).toBeNull();
      expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'guard' && /ends on its budget; committing the held passer/.test(e.detail))).toBe(true);
    }
  });
});

describe('searchSubGoal: the RANK take follows the run budget on a cheap repository oracle, and tested sites are remembered across steps (§2.4 / §5.3, 2026-09-20)', () => {
  // a repository-mode oracle: the reproduction 2.5 s (repository class), the scoped suite 20 s
  const repoOracle = (): ReturnType<typeof slowOracle> => ({ runner: 'other', lanes: 4, tRunMs: { goalSubset: 2500, fullSuite: 20_000 }, perTestTimeoutMs: null, runTimeoutMs: 100_000, baselineDurationMs: 20_000 });
  const askQ7 = (questions: Record<string, Question>): Record<string, Answer> => ({ [EDIT_CLASS_QUESTION_ID]: choiceOn(questions[EDIT_CLASS_QUESTION_ID]!, 'substitute_one_token', 0.6) });
  const many = (site: Site, n: number, source: CandidateSourceName): Candidate[] => Array.from({ length: n }, (_, i) => cand(site, `return ${source}_${site.line}_${i}`, { source }));

  it('K per site is its share of the runs left (≤ 16): two sites, 60 runs → 16, 16, 14 at the first, 14 at the second; both sites count as newly tested', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx({ ask: askQ7 });
    const mem = fakeMemory([file], baseline(), { oracle: repoOracle(), stepBudget: fakeBudget({ jev: 60, runs: 60, wallMs: 600_000 }) });
    const goal = fakeGoal();
    // 70 per source against 60 runs: the pool outgrows the budget, which is what RANK is for (ranked change 1)
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'composite' ? [] : many(site, 70, source)) });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(r.trace.runMode).toBe('RANK');
    // site 1 (2 sites left): floor(60/2) = 30 → 16; floor(44/2) = 22 → 16; floor(28/2) = 14; site 2 (last): 14 of the 30
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([16, 16, 14, 14]);
    expect(deps.rec.runBatches.map((b) => b[0]?.candidate.site.line)).toEqual([5, 5, 5, 6]);
    expect(r.trace.sitesTested).toBe(2);
    expect(r.trace.newSitesTested).toBe(2);
    expect([...(goal.testedSites ?? [])].sort()).toEqual([siteKey(replace), siteKey(insert)].sort());
    // the RANK cut leaves every source open for the next step
    expect(goal.exhausted.get(siteKey(replace))?.has('mutation')).toBe(false);

    // the next step, same goal and memory: the leftovers run, no site is new
    mem.stepBudget = fakeBudget({ jev: 60, runs: 60, wallMs: 600_000 });
    const r2 = await searchSubGoal(fakeCtx({ ask: askQ7 }), mem, goal, deps);
    expect(r2.kind).toBe('budget');
    // OOS 2026-09-22 ranked change 1: step 1's RANK cut left 70 − 16 = 54 untested at the first source,
    // and 54 now fits the 60 runs this step has — so it is run whole, with no ranking request spent on it
    expect(deps.rec.runBatches.slice(4).map((b) => b.length)).toEqual([54, 3, 3]);
    // the 60 runs are spent at the first site, so the second is not reached again this step
    expect(r2.trace.sitesTested).toBe(1);
    expect(r2.trace.newSitesTested).toBe(0);
    expect(everySiteSeedsExhausted(goal, [replace, insert])).toBe(false);
  });

  it('with the two scopes at the same cost (a best-guess-like oracle) the take stays at the fixed 3/5', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx({ ask: askQ7 });
    // 30 per source against 25 runs left: the pool outgrows the budget (so RANK), and stays under
    // COMPACT_NOUL_MIN_CANDIDATES (so the fixed 3/5 take, not the compact 5)
    const mem = fakeMemory([file], baseline(), { oracle: slowOracle(), stepBudget: fakeBudget({ jev: 60, runs: 25, wallMs: 600_000 }) });
    const deps = fakeSubGoalDeps({ sites: [replace, insert], seed: (source, site) => (source === 'composite' ? [] : many(site, 30, source)) });
    await searchSubGoal(ctx, mem, fakeGoal(), deps);
    expect(deps.rec.runBatches.map((b) => b.length)).toEqual([3, 3, 3, 5, 5, 5]);
  });
});

// ---------------------------------------------------------------------------------------
// Statement-level sites on an improved base, and the phase hint the sources read
// ---------------------------------------------------------------------------------------

describe('statement-level sites (Site.endLine) in the loop helpers', () => {
  const SRC = ['def f(self):', '    return hash((', '        self.a,', '        self.b,', '    ))', '    x = 1', ''].join('\n');
  const file = sourceFile('m.py', SRC);
  const span = statementSiteAt(file, 2, { notes: ['n'] })!;
  const committed: Base = { id: 'committed', origin: 'committed', fromGoal: null, files: new Map([[file.path, file]]), summary: baseline(), depth: 0 };

  it('siteOnBase keeps a statement site on an improved base while the span still joins to the same text, and drops it when a continuation line or the line numbering changed', () => {
    expect(span).toMatchObject({ line: 2, endLine: 5, currentLine: '    return hash((self.a, self.b))' });
    expect(siteOnBase(span, committed)).toBe(span);
    const elsewhere = sourceFile('m.py', SRC.replace('    x = 1', '    x = 2'));
    const improved: Base = { ...committed, id: 'improved', origin: 'improved', fromGoal: 'g1', files: new Map([[elsewhere.path, elsewhere]]), depth: 1 };
    const kept = siteOnBase(span, improved);
    expect(kept?.file).toBe(elsewhere);
    expect(kept).toMatchObject({ line: 2, endLine: 5, currentLine: '    return hash((self.a, self.b))' });
    // the first physical line reads the same, a continuation line does not: stale as a span
    const inner = sourceFile('m.py', SRC.replace('        self.b,', '        self.c,'));
    expect(inner.mod.lines[1]).toBe(file.mod.lines[1]);
    expect(siteOnBase(span, { ...improved, files: new Map([[inner.path, inner]]) })).toBeNull();
    const shifted = sourceFile('m.py', `import math\n${SRC}`);
    expect(siteOnBase(span, { ...improved, files: new Map([[shifted.path, shifted]]) })).toBeNull();
  });

  it('enumerateOptions carries the goal\'s phase so the WIDENED-only sources (depth-2 wraps, collapse_collection_to_element) read it', () => {
    expect(enumerateOptions(committed, fakeGoal(), 'task').phase).toBe('SEEDS');
    expect(enumerateOptions(committed, fakeGoal({ phase: 'WIDENED' }), 'task').phase).toBe('WIDENED');
    expect(enumerateOptions(committed, fakeGoal(), 'task')).toMatchObject({ cap: 254, corpus: committed.files });
  });
});

// Progress commits (jev-only-rungs-1-2.md §19.7): the held partial at a budget exit
// ---------------------------------------------------------------------------------------

describe('progress commits: a step that ends with a partial in hand commits it as a partial fix', () => {
  const MORE = 'tests/test_gcd.py::test_more';
  function twoTestBaseline(): ReturnType<typeof summary> {
    return summary({ command: 'pytest -q', failing: [GCD_TEST, MORE], passing: [GCD_OTHER_TEST] });
  }
  /** the goal-subset run of a partial: GCD_TEST now passes, MORE still fails */
  const partialSubset = (): ReturnType<typeof summary> => summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: [MORE] });
  const HALF = 'return gcd(a % b, a)';

  it('a lone partial is committed at the budget exit as a partial fix: no untested pair, its full-suite regression run clean, no signal → `partial`, allGoalTestsPass false, `after` the regression run', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    const full = summary({ command: 'pytest -q', passing: [GCD_OTHER_TEST, GCD_TEST], failing: [MORE] });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, HALF, { op: 'identifier_substitution' })] : []),
      statusOf: () => 'partial',
      subsetOf: () => partialSubset(),
      // the guard's own rule with 0 plausible (bases.ts): the partial becomes the improved base
      decide: (results, _batch, m) => {
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
      regressionRun: () => full,
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    // the one run was spent (budget), and the step left with the partial as its commit instead of `budget`
    expect(deps.rec.runBatches).toHaveLength(1);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.note).toBe('partial');
      expect(r.allGoalTestsPass).toBe(false);
      expect(r.applied.candidate.text).toBe(HALF);
      expect(r.after).toBe(full);
      expect(r.outcome?.progress.newlyPassing).toEqual([GCD_TEST]);
    }
    expect(r.trace.outcome).toBe('partial');
    expect(r.trace.testRuns).toBe(2); // the subset run and the regression run
    expect(r.trace.jevRequests).toBe(2); // localisation only: no signal, no Q16
    // the base left the beam with the commit
    expect(mem.bases.map((b) => b.id)).toEqual(['committed']);
    expect(heldPartialOutcome(mem, goal)).toBeNull();
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /progress commit — partial fix mutation\/identifier_substitution at gcd\.py:5: 1 of 2 goal tests pass \(1→2 of 3\), no regressions; the remaining 1 stay open/.test(e.detail))).toBe(true);
  });

  it('a suspicious lone partial is held, not committed: the signals fire (an emptied statement), Q16 rates it doubtful, the step returns `budget` with the base still in the beam; the next step asks nothing again and parks', async () => {
    const { file, replace } = gcdFixture();
    let asked = 0;
    const ctx = fakeCtx({
      ask: (questions) => {
        asked += 1;
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulAnswer(0.1);
        return out;
      },
    });
    const mem = fakeMemory([file], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'pass', { op: 'statement_deletion' })] : []),
      statusOf: () => 'partial',
      subsetOf: () => partialSubset(),
      decide: (results, _batch, m) => {
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(asked).toBe(1);
    expect(r.trace.jevRequests).toBe(2 + 1); // localisation + the one Q16 advisory
    // held: the base stays (a better partial may replace it), the advice is remembered
    expect(improvedBaseFor(mem, goal)?.candidate?.candidate.text).toBe('pass');
    expect(guardState(mem).partialAdvice.size).toBe(1);
    expect([...guardState(mem).partialAdvice.values()][0]).toMatchObject({ goalId: 'g1', signals: ['deletes_statement'], noul: 0.1 });
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'guard' && /holds the partial mutation\/statement_deletion at gcd\.py:5:replace \(deletes_statement; general 0\.10 < 0\.3\); not committed/.test(e.detail))).toBe(true);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /progress commit/.test(e.detail))).toBe(false);
    // the next step: every source exhausted, the same incumbent, no second request — the goal parks with nothing committed
    mem.stepBudget = fakeBudget({ runs: 1 });
    const again = await searchSubGoal(ctx, mem, goal, deps);
    expect(again.kind).toBe('parked');
    expect(asked).toBe(1);
  });

  it('a passing pair beats a lone partial: at the budget exit the untested pair of complementary partials runs first and is committed as one composite; the lone partial is not', async () => {
    const { file, replace, insert } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    const committed = mem.bases[0]!;
    // half 2 is remembered from an earlier step (it passes MORE at the gap); half 1 arrives in this step's one batch
    const h2 = outcomeOf(jobOf(cand(insert, 'return a  # half 2', { source: 'template', op: 'insert_return' }), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, MORE], failing: [GCD_TEST] }) });
    guardState(mem).partials.push({ goalId: goal.id, outcome: h2 });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, 'return gcd(b, a % b)  # half 1', { op: 'argument_swap' })] : []),
      statusOf: (job) => (job.candidate.op === 'pair_of_partials' ? 'plausible' : 'partial'),
      subsetOf: (job) => (job.candidate.op === 'pair_of_partials' ? undefined : partialSubset()),
      decide: (results, _batch, m) => {
        const w = results.find((o) => o.status === 'plausible');
        if (w !== undefined) return { kind: 'commit', applied: w.applied, allGoalTestsPass: true };
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
      pairs: pairsOfPartials,
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.allGoalTestsPass).toBe(true);
      expect(r.applied.candidate.op).toBe('pair_of_partials');
      expect(r.applied.files[0]?.after).toContain('half 1');
      expect(r.applied.files[0]?.after).toContain('half 2');
    }
    expect(r.trace.outcome).toBe('fixed');
    // batches: half 1 (held as the partial), then the pair at the budget exit; no progress commit was made
    expect(deps.rec.runBatches.map((b) => b.map((j) => j.candidate.op))).toEqual([['argument_swap'], ['pair_of_partials']]);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress')).toBe(false);
  });

  it('a held partial whose full-suite regression run breaks another test is dropped, not committed: the step returns `budget`, the base leaves the beam and the remembered partial goes with it', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, HALF, { op: 'identifier_substitution' })] : []),
      statusOf: () => 'partial',
      subsetOf: () => partialSubset(),
      decide: (results, _batch, m) => {
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
      // on the whole suite the "partial" breaks the other test file's test
      regressionRun: () => summary({ command: 'pytest -q', passing: [GCD_TEST], failing: [MORE, GCD_OTHER_TEST] }),
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(improvedBaseFor(mem, goal)).toBeUndefined();
    expect(partialsOf(mem, goal)).toHaveLength(0);
    expect(r.trace.testRuns).toBe(2);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /is no partial on the full suite \(1 newly failing, 1 of 2 goal tests newly passing\); dropped/.test(e.detail))).toBe(true);
  });

  it('a held partial whose cumulative patch edits more than MAX_PATCH_FILES files cannot be proposed as one patch: dropped before any run or record, the step returns `budget`', async () => {
    const { file, replace } = gcdFixture();
    const other = sourceFile('other.py', 'y = 1\n');
    const third = sourceFile('third.py', 'z = 1\n');
    const ctx = fakeCtx();
    const mem = fakeMemory([file, other, third], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    let regressionRuns = 0;
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => {
        if (source !== 'mutation') return [];
        const c = cand(site, HALF, { source: 'composite', op: 'pair_of_partials' });
        c.extraEdits = [
          { path: 'other.py', line: 1, kind: 'replace', text: 'y = 2' },
          { path: 'third.py', line: 1, kind: 'replace', text: 'z = 2' },
        ];
        return [c];
      },
      statusOf: () => 'partial',
      subsetOf: () => partialSubset(),
      decide: (results, _batch, m) => {
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
      regressionRun: () => {
        regressionRuns += 1;
        return null;
      },
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(regressionRuns).toBe(0);
    expect(improvedBaseFor(mem, goal)).toBeUndefined();
    expect(partialsOf(mem, goal)).toHaveLength(0);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /edits 3 files and cannot be proposed as one patch \(at most 2\); dropped/.test(e.detail))).toBe(true);
  });

  it('a held partial that cannot be verified this step (no regression run possible) stays held and the step returns `budget`', async () => {
    const { file, replace } = gcdFixture();
    const ctx = fakeCtx();
    const mem = fakeMemory([file], twoTestBaseline(), { oracle: fastOracle(), stepBudget: fakeBudget({ runs: 1 }) });
    const goal = fakeGoal({ tests: [GCD_TEST, MORE] });
    const deps = fakeSubGoalDeps({
      sites: [replace],
      seed: (source, site) => (source === 'mutation' ? [cand(site, HALF, { op: 'identifier_substitution' })] : []),
      statusOf: () => 'partial',
      subsetOf: () => partialSubset(),
      decide: (results, _batch, m) => {
        holdBestPartial(m, results, goal);
        return { kind: 'continue' };
      },
      regressionRun: () => null,
    });
    const r = await searchSubGoal(ctx, mem, goal, deps);
    expect(r.kind).toBe('budget');
    expect(improvedBaseFor(mem, goal)).toBeDefined();
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /could not be verified on the full suite this step/.test(e.detail))).toBe(true);
  });
});
