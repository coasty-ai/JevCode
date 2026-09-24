/**
 * The two rank/index.ts additions: stage-one Noul chunks of 150 when the function listing is
 * repository-sized (> ~4k tokens), and `shuffleRerank` (Q10r): a shuffled re-ask of the shortlist
 * averaged with the first p's, gated by `shouldShuffleRerank` (t_run > 20 s and top-2 margin < 0.10).
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Json } from '../../../../../src/core/types.js';
import {
  CHUNK_MAX_CANDIDATES,
  REPO_CHUNK_MAX_CANDIDATES,
  REPO_LISTING_TOKEN_THRESHOLD,
  SHUFFLE_RERANK_MARGIN,
  SHUFFLE_RERANK_MAX,
  SHUFFLE_RERANK_MIN_T_RUN_MS,
  createRanker,
  effectiveChunkMax,
  listingTokens,
  shouldShuffleRerank,
  shuffleRerank,
  shuffledOrder,
} from '../../../../../src/jev-modes/synth/rank/index.js';
import type { RankedCandidateDetail } from '../../../../../src/jev-modes/synth/rank/index.js';
import type { Candidate, RankContext, Site } from '../../../../../src/jev-modes/synth/types.js';
import { answerAll, scriptedAsk, sf, signal, siteAt } from './sites-composite.helpers.js';
import type { AskCall } from './sites-composite.helpers.js';

/** A def with `n` body lines of ~70 characters: a repository-sized listing when n is large. */
function longFunction(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `    value_${i} = compute_something_rather_long(value_${Math.max(0, i - 1)}, weights[${i}], offset, scale=SCALE_FACTOR_${i})  # step ${i} of the pipeline`);
  return ['def repo_sized(values, weights, offset):', ...body, '    return value_0', ''].join('\n');
}

const small = sf('small.py', 'def gcd(a, b):\n    if b == 0:\n        return a\n    return gcd(a % b, b)\n');
const smallSite = siteAt(small, 4);
const big = sf('big.py', longFunction(200));
const bigSite = siteAt(big, 100);

function cands(site: Site, n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, site, text: `${site.indent}value_${i} = fixed(${i})`, source: 'mutation', op: 'test' }));
}

function context(ask: RankContext['ask']): RankContext {
  return { ask, task: 'fix', failures: [{ testId: 't', call: 'repo_sized([1], [2], 3)', expected: '4', actual: '5' }], functionListing: '', signal: signal() };
}

/** Scripted answers: Nouls from `p(text)` read off `state.candidates`, Choices uniform. */
function script(p: (text: string) => number): (call: AskCall) => Record<string, Answer> {
  return (call) => {
    const state = call.state as Record<string, Json>;
    const candidates = (state['candidates'] ?? {}) as Record<string, Json>;
    return answerAll(
      call,
      (id) => {
        const d = candidates[id];
        return p(typeof d === 'string' ? d : JSON.stringify(d));
      },
      () => ({}),
    );
  };
}

describe('150-candidate chunks on repository-sized listings', () => {
  it('estimates the listing and picks the chunk size', () => {
    expect(listingTokens(smallSite)).toBeLessThan(REPO_LISTING_TOKEN_THRESHOLD);
    expect(listingTokens(bigSite)).toBeGreaterThan(REPO_LISTING_TOKEN_THRESHOLD);
    expect(effectiveChunkMax(smallSite, CHUNK_MAX_CANDIDATES)).toBe(CHUNK_MAX_CANDIDATES);
    expect(effectiveChunkMax(bigSite, CHUNK_MAX_CANDIDATES)).toBe(REPO_CHUNK_MAX_CANDIDATES);
    // a caller's smaller chunkMax is never raised
    expect(effectiveChunkMax(bigSite, 100)).toBe(100);
    expect(REPO_CHUNK_MAX_CANDIDATES).toBe(150);
  });

  it('two-stage ranking splits 200 candidates into two Noul requests on the long listing, one on the short', async () => {
    const isFix = (t: string): number => (t.includes('fixed(7)') ? 0.9 : 0.1);
    const long = scriptedAsk(script(isFix));
    const r = await createRanker().rank(cands(bigSite, 200), context(long.ask));
    expect(r.method).toBe('two_stage');
    expect(r.requests).toBe(3); // 2 chunks + the shortlist Choice
    const noulCalls = long.calls.filter((c) => !('fix' in c.questions));
    expect(noulCalls.map((c) => Object.keys(c.questions).length).sort((a, b) => a - b)).toEqual([100, 100]);
    expect(r.ranked[0]!.candidate.id).toBe('c7');

    const short = scriptedAsk(script(isFix));
    const r2 = await createRanker().rank(cands(smallSite, 200), context(short.ask));
    expect(r2.requests).toBe(2);
    expect(short.calls.filter((c) => !('fix' in c.questions))).toHaveLength(1);
  });
});

describe('shuffleRerank (Q10r)', () => {
  function rows(site: Site, ps: readonly number[]): RankedCandidateDetail[] {
    return ps.map((p, i) => ({ candidate: { id: `s${i}`, site, text: `${site.indent}return gcd(b, a % b) + ${i}`, source: 'mutation', op: 'test' }, probability: p, rank: i + 1, optionKey: `k${i}`, noulProbability: p }));
  }

  it('gates on the oracle cost and the top-2 margin', () => {
    const list = rows(smallSite, [0.52, 0.48, 0.1]);
    expect(shouldShuffleRerank(list, SHUFFLE_RERANK_MIN_T_RUN_MS)).toBe(false); // 20 s is not > 20 s
    expect(shouldShuffleRerank(list, 25_000)).toBe(true);
    expect(shouldShuffleRerank(rows(smallSite, [0.7, 0.4]), 25_000)).toBe(false); // margin 0.30 ≥ 0.10
    expect(shouldShuffleRerank(rows(smallSite, [0.7]), 25_000)).toBe(false);
    expect(SHUFFLE_RERANK_MARGIN).toBe(0.1);
  });

  it('shuffledOrder is a permutation that differs from the identity and is deterministic per seed', () => {
    for (const n of [2, 3, 5, 10]) {
      const o = shuffledOrder(n, 42);
      expect([...o].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(o.some((v, i) => v !== i)).toBe(true);
      expect(shuffledOrder(n, 42)).toEqual(o);
    }
    expect(shuffledOrder(1, 7)).toEqual([0]);
    expect(shuffledOrder(0, 7)).toEqual([]);
  });

  it('re-asks the shortlist shuffled and re-keyed, averages the p’s and re-orders', async () => {
    const list = rows(smallSite, [0.52, 0.48, 0.3]);
    // the re-ask rates the runner-up high and the leader low
    const jev = scriptedAsk(script((t) => (t.endsWith('+ 1') ? 0.9 : t.endsWith('+ 0') ? 0.2 : 0.3)));
    const r = await shuffleRerank(list, context(jev.ask));
    expect(r.requests).toBe(1);
    expect(jev.calls).toHaveLength(1);
    const call = jev.calls[0]!;
    // compact Nouls only, one per candidate, over a `candidates` map whose order is not the input order
    expect(Object.values(call.questions).every((q) => q.type === 'noul')).toBe(true);
    const state = call.state as Record<string, Json>;
    const shown = Object.values(state['candidates'] as Record<string, string>);
    expect(shown).toHaveLength(3);
    expect(shown).not.toEqual(list.map((x) => x.candidate.text));
    expect(new Set(shown)).toEqual(new Set(list.map((x) => x.candidate.text)));
    expect(state).toHaveProperty('correct_fix_criteria');
    // averaged: s0 (0.52 + 0.2) / 2 = 0.36, s1 (0.48 + 0.9) / 2 = 0.69, s2 (0.3 + 0.3) / 2 = 0.30
    expect(r.reaskedProbability).toEqual({ s0: 0.2, s1: 0.9, s2: 0.3 });
    expect(r.ranked.map((x) => [x.candidate.id, x.rank])).toEqual([['s1', 1], ['s0', 2], ['s2', 3]]);
    expect(r.ranked[0]!.probability).toBeCloseTo(0.69, 6);
    expect(r.ranked[0]!.noulProbability).toBeCloseTo(0.69, 6);
    expect(r.ranked[1]!.probability).toBeCloseTo(0.36, 6);
    // the incoming rows are not mutated
    expect(list[0]!.probability).toBe(0.52);
  });

  it('a fixed seed reproduces the order; fewer than two rows need no request; more than ten is refused', async () => {
    const list = rows(smallSite, [0.5, 0.4, 0.3, 0.2]);
    const a = scriptedAsk(script(() => 0.5));
    const b = scriptedAsk(script(() => 0.5));
    await shuffleRerank(list, context(a.ask), { seed: 3 });
    await shuffleRerank(list, context(b.ask), { seed: 3 });
    expect(a.calls[0]!.state).toEqual(b.calls[0]!.state);
    const one = scriptedAsk(script(() => 0.5));
    expect(await shuffleRerank(rows(smallSite, [0.5]), context(one.ask))).toEqual({ ranked: rows(smallSite, [0.5]), reaskedProbability: {}, requests: 0 });
    expect(one.calls).toHaveLength(0);
    await expect(shuffleRerank(rows(smallSite, Array.from({ length: SHUFFLE_RERANK_MAX + 1 }, () => 0.5)), context(one.ask))).rejects.toThrow(RangeError);
  });
});
