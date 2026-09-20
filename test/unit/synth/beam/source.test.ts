import { describe, expect, it } from 'vitest';
import type { Json } from '../../../../src/core/types.js';
import { isJsonArray, isJsonObject } from '../../../../src/core/json.js';
import { AbortError } from '../../../../src/errors.js';
import { DEFAULT_MAX_REQUESTS, createTokenBeamSource, siteKey } from '../../../../src/synth/beam/index.js';
import { HYPOTHESES_KEY } from '../../../../src/synth/beam/state.js';
import { toks } from '../../../../src/synth/beam/tokens.js';
import { END_KEY } from '../../../../src/synth/beam/vocab.js';
import { GCD_FAILURES, enumerateOptions, gcdSite, keyForToken, massOn, scriptedAsk, siteAt, sourceFile, stateString } from './helpers.js';
import type { ChoiceQuestion } from './helpers.js';

const TARGET = toks('return gcd(b, a % b)').map((t) => t.text);
const SLOT_FILLS = ['gcd', 'b', 'a', 'b'];

function partialTokens(id: string, state: Json): string[] | undefined {
  if (!isJsonObject(state)) return undefined;
  const holder = id === 'next_token' ? state : isJsonObject(state[HYPOTHESES_KEY]) ? (state[HYPOTHESES_KEY] as Record<string, Json>)[id.slice('next_token_'.length)] : undefined;
  const pt = isJsonObject(holder) ? holder['partial_tokens'] : undefined;
  return isJsonArray(pt) ? pt.map(String) : undefined;
}

/** A script that solves gcd on both routes: swapped shape + slots, and the teacher-forced beam. */
function gcdScript(id: string, q: ChoiceQuestion, state: Json): Record<string, number> | undefined {
  if (id === 'line_shape') {
    const k = Object.entries(q.criteria).find(([, d]) => isJsonObject(d) && d['shape'] === 'return _(_, _ % _)')?.[0];
    return k === undefined ? undefined : massOn(q, k, 0.8);
  }
  if (id === 'slot' || id.startsWith('slot_')) {
    const path = id === 'slot' ? '' : `${HYPOTHESES_KEY}.${id.slice('slot_'.length)}.`;
    if (stateString(state, `${path}line_shape`) !== 'return _(_, _ % _)') return undefined;
    const n = Number(/\d+/.exec(stateString(state, `${path}slot_to_fill`) ?? '')?.[0]) - 1;
    const k = keyForToken(q, SLOT_FILLS[n]!);
    return k === undefined ? undefined : massOn(q, k, 0.9);
  }
  const so = partialTokens(id, state);
  if (so === undefined || !so.every((t, i) => TARGET[i] === t)) return undefined;
  const k = so.length === TARGET.length ? END_KEY : keyForToken(q, TARGET[so.length]!);
  return k === undefined ? undefined : massOn(q, k, 0.95);
}

const ctx = (signal = new AbortController().signal, over: { maxRequests?: number; routes?: ('template' | 'beam')[] } = {}) => ({
  task: 'gcd recurses forever',
  failures: GCD_FAILURES,
  signal,
  enumerate: enumerateOptions({ testLiterals: ['17', '13'] }),
  ...over,
});

describe('token beam source: enumerate is pure and synchronous', () => {
  it('returns permutation candidates without asking Jev, deterministically', () => {
    const ask = scriptedAsk(() => undefined);
    const src = createTokenBeamSource(ask, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9 });
    const { site } = gcdSite();
    const a = src.enumerate(site, enumerateOptions());
    const b = src.enumerate(site, enumerateOptions());
    expect(ask.calls).toHaveLength(0);
    expect(a).toEqual(b);
    expect(a.map((c) => c.text.trim())).toContain('return gcd(b, a % b)');
    expect(a.every((c) => c.source === 'token_beam')).toBe(true);
    expect(src.name).toBe('token_beam');
    expect(src.cached(site)).toBeUndefined();
  });
  it('respects the cap', () => {
    const src = createTokenBeamSource(scriptedAsk(() => undefined), { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9 });
    const { site } = gcdSite();
    expect(src.enumerate(site, enumerateOptions({ cap: 1 }))).toHaveLength(1);
    expect(src.enumerate(site, enumerateOptions({ cap: 0 }))).toEqual([]);
  });
});

describe('token beam source: synthesizeLine', () => {
  it('runs templates then the beam under one budget, dedupes across routes and caches for enumerate', async () => {
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? gcdScript(id, q, state) : 0.05));
    const src = createTokenBeamSource(ask, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9 });
    const { site } = gcdSite();
    const res = await src.synthesizeLine(site, ctx());
    expect(res.lines[0]?.text).toBe('        return gcd(b, a % b)');
    expect(new Set(res.lines.map((l) => l.text)).size).toBe(res.lines.length);
    expect(res.byRoute.template?.lines[0]?.text).toBe('        return gcd(b, a % b)');
    expect(res.byRoute.beam?.lines[0]?.text).toBe('        return gcd(b, a % b)');
    expect(res.requests).toBe(res.byRoute.template!.requests + res.byRoute.beam!.requests);
    expect(res.requests).toBe(ask.calls.length);
    expect(res.requests).toBeLessThanOrEqual(DEFAULT_MAX_REQUESTS);
    // the synthesis is now visible to the pure path, ahead of the permutations
    const cands = src.enumerate(site, enumerateOptions());
    expect(cands[0]).toMatchObject({ text: '        return gcd(b, a % b)', op: 'synthesized_line', source: 'token_beam', prior: 1 });
    // the argument permutation has the same text as the synthesized line and is deduped; the operand swap remains
    expect(cands.some((c) => c.op === 'operand_swap')).toBe(true);
    expect(cands.filter((c) => c.text === '        return gcd(b, a % b)')).toHaveLength(1);
    expect(new Set(cands.map((c) => c.text)).size).toBe(cands.length);
    expect(src.cached(site)).toBe(res);
    src.clearCache();
    expect(src.cached(site)).toBeUndefined();
  });
  it('a per-call request budget bounds the total across routes', async () => {
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? gcdScript(id, q, state) : 0.05));
    const src = createTokenBeamSource(ask, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9, maxRequests: 100 });
    const { site } = gcdSite();
    const res = await src.synthesizeLine(site, ctx(undefined, { maxRequests: 7 }));
    expect(res.requests).toBe(7);
    expect(ask.calls).toHaveLength(7);
    expect(res.byRoute.template?.requests).toBe(5);
    expect(res.byRoute.beam?.requests).toBe(2);
    expect(res.byRoute.beam?.lines).toEqual([]);
  });
  it('routes can be restricted to the beam only', async () => {
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? gcdScript(id, q, state) : 0.05));
    const src = createTokenBeamSource(ask, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9, routes: ['beam'] });
    const { site } = gcdSite();
    const res = await src.synthesizeLine(site, ctx());
    expect(res.byRoute.template).toBeUndefined();
    expect(res.byRoute.beam?.requests).toBe(TARGET.length + 1);
    expect(ask.calls.every((c) => 'next_token' in c.questions)).toBe(true);
  });
  it('propagates abort before the first request and mid-way', async () => {
    const pre = new AbortController();
    pre.abort();
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? gcdScript(id, q, state) : 0.05));
    const src = createTokenBeamSource(ask, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9 });
    const { site } = gcdSite();
    await expect(src.synthesizeLine(site, ctx(pre.signal))).rejects.toBeInstanceOf(AbortError);
    expect(ask.calls).toHaveLength(0);
    expect(src.cached(site)).toBeUndefined();

    const mid = new AbortController();
    const ask2 = scriptedAsk(
      (id, q, state) => (q.type === 'choice' ? gcdScript(id, q, state) : 0.05),
      { onCall: () => { if (ask2.calls.length === 6) mid.abort(); } },
    );
    const src2 = createTokenBeamSource(ask2, { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9 });
    await expect(src2.synthesizeLine(site, ctx(mid.signal))).rejects.toBeInstanceOf(AbortError);
    expect(ask2.calls).toHaveLength(6); // templates finished (5), the beam asked once, then saw the abort
    expect(src2.cached(site)).toBeUndefined();
  });
  it('siteKey distinguishes lines, kinds, text and file content', () => {
    const { file, site } = gcdSite();
    expect(siteKey(site)).not.toBe(siteKey(siteAt(file, 3)));
    expect(siteKey(site)).not.toBe(siteKey(siteAt(file, 5, 'insert')));
    expect(siteKey(site)).toBe(siteKey(siteAt(file, 5)));
    // the same line of an edited file is a different site: an older synthesis must not be surfaced for it
    const edited = sourceFile('gcd.py', file.src.replace('if b == 0:', 'if b <= 0:'));
    expect(siteKey(site)).not.toBe(siteKey(siteAt(edited, 5)));
  });
  it('enumerate priors of synthesized lines are relative to the best line across routes and never exceed 1', async () => {
    // template route: `return _` filled with `a` at low confidence; beam route: `return b` at high confidence.
    // Lines are grouped by route (template first), so the beam line scores higher than the first line.
    const file = sourceFile('f.py', 'def f(a, b):\n    if a:\n        return b\n    return g(a, b)\n');
    const site = siteAt(file, 4);
    const ask = scriptedAsk((id, q, state) => {
      if (q.type === 'noul') return 0.1;
      if (q.type !== 'choice') return undefined;
      if (id === 'line_shape') {
        const k = Object.entries(q.criteria).find(([, d]) => isJsonObject(d) && d['shape'] === 'return _')?.[0];
        return k === undefined ? undefined : massOn(q, k, 0.6);
      }
      if (id === 'slot' || id.startsWith('slot_')) {
        const k = keyForToken(q, 'a');
        return k === undefined ? undefined : massOn(q, k, 0.5);
      }
      const so = partialTokens(id, state) ?? [];
      const k = so.length === 0 ? keyForToken(q, 'return') : so.length === 1 ? keyForToken(q, 'b') : END_KEY;
      return k === undefined ? undefined : massOn(q, k, 0.95);
    });
    const src = createTokenBeamSource(ask, { width: 1, maxTokens: 10, confidentExpandThreshold: 0.9 });
    const res = await src.synthesizeLine(site, { task: '', failures: [], signal: new AbortController().signal, enumerate: enumerateOptions() });
    expect(res.lines.map((l) => l.text.trim())).toEqual(['return a', 'return b']);
    expect(res.lines[1]!.logProb).toBeGreaterThan(res.lines[0]!.logProb);
    const cands = src.enumerate(site, enumerateOptions());
    const synthesized = cands.filter((c) => c.op === 'synthesized_line');
    expect(synthesized.map((c) => c.text.trim())).toEqual(['return a', 'return b']);
    for (const c of cands) expect(c.prior, c.text).toBeLessThanOrEqual(1);
    expect(synthesized[1]!.prior).toBe(1);
    expect(synthesized[0]!.prior).toBeCloseTo(Math.exp(res.lines[0]!.logProb - res.lines[1]!.logProb), 9);
  });
});
