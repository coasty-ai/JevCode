/**
 * The slot beam (src/jev-modes/synth/fill/beam.ts) with scripted Jev answers: reconstruction of the gcd fix
 * from its sketch, expansion counts (1 at p ≥ 0.9, else B = 3), K × B items in one request, the
 * compile gate, family permutations, the two-line guard, budget and abort.
 */
import { describe, expect, it } from 'vitest';
import type { Json, Question } from '../../../../../src/core/types.js';
import { isJsonObject } from '../../../../../src/core/json.js';
import { AbortError } from '../../../../../src/errors.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { DEFAULT_FILL_WIDTH, FillError, MAX_ITEMS_PER_REQUEST, familyPermutations, fillSketches } from '../../../../../src/jev-modes/synth/fill/beam.js';
import type { FillContext } from '../../../../../src/jev-modes/synth/fill/beam.js';
import { HYPOTHESES_KEY, hypothesisKeyAt, slotQuestion } from '../../../../../src/jev-modes/synth/fill/state.js';
import type { SketchHypothesis } from '../../../../../src/jev-modes/synth/search/types.js';
import { sketchPool } from '../../../../../src/jev-modes/synth/sketch/pool.js';
import { guardTemplates, holeIndices } from '../../../../../src/jev-modes/synth/sketch/productions.js';
import { toks } from '../../../../../src/jev-modes/synth/beam/tokens.js';
import { applyCandidate } from '../../../../../src/jev-modes/synth/verify/apply.js';
import type { Site } from '../../../../../src/jev-modes/synth/types.js';
import { GCD_FAILURES, asChoice, enumerateOptions, gcdSite, massOn, scriptedAsk, siteAt, sourceFile, stateString } from '../sketch/helpers.js';

function hyp(site: Site, texts: string[], production = 'P10', pSketch = 0.5): SketchHypothesis {
  return { site, toks: texts, holes: holeIndices(texts), production, pSketch, logP: 0 };
}

function context(site: Site, over: Partial<FillContext> = {}): FillContext {
  return { site, task: 'Fix gcd', failures: GCD_FAILURES, enumerate: enumerateOptions(), signal: new AbortController().signal, ...over };
}

/** The partial line the question with `id` refers to. */
function partialOf(id: string, state: Json): string {
  return stateString(state, `${HYPOTHESES_KEY}.${id.slice('slot_'.length)}`) ?? '';
}

function hypothesesCount(state: Json): number {
  const h = isJsonObject(state) ? state[HYPOTHESES_KEY] : undefined;
  return isJsonObject(h) ? Object.keys(h).length : 0;
}

/** Scripted answers by partial line: `{ 'return gcd(<HOLE>, ? % ?)': ['name_b', 0.95], ... }`; anything else uniform. */
function byPartial(script: Record<string, [key: string, p: number]>): (id: string, q: Question, state: Json) => Record<string, number> | undefined {
  return (id, q, state) => {
    const entry = script[partialOf(id, state)];
    return entry === undefined ? undefined : massOn(asChoice(q), entry[0], entry[1]);
  };
}

const GCD_SKETCH = ['return', 'gcd', '(', '_', ',', '_', '%', '_', ')'];

describe('fillSketches: reconstructing the gcd fix', () => {
  it('fills `return gcd(_, _ % _)` to `return gcd(b, a % b)` in three prefix-mode requests, best Σ log p first', async () => {
    const { site } = gcdSite();
    const ask = scriptedAsk(byPartial({ 'return gcd(<HOLE>, ? % ?)': ['name_b', 0.95], 'return gcd(b, <HOLE> % ?)': ['name_a', 0.6], 'return gcd(b, a % <HOLE>)': ['name_b', 0.9] }));
    const out = await fillSketches([hyp(site, GCD_SKETCH)], context(site), ask);
    expect(out.requests).toBe(3);
    expect(out.candidates[0]).toMatchObject({ text: '        return gcd(b, a % b)', source: 'template', op: 'sketch_P10', prior: 0.5 });
    expect(out.candidates[0]!.id).toMatch(/^sketch:P10:[0-9a-f]{8}$/);
    expect(out.lines[0]!.hypothesis).toMatchObject({ toks: ['return', 'gcd', '(', 'b', ',', 'a', '%', 'b', ')'], holes: [], production: 'P10' });
    expect(out.lines[0]!.hypothesis.logP).toBeCloseTo(Math.log(0.95) + Math.log(0.6) + Math.log(0.9), 6);
    // the unchanged line is never a candidate even when a fill reproduces it
    expect(out.candidates.map((c) => c.text)).not.toContain('        return gcd(a % b, b)');
    // the filled `a`/`b` pair is permuted in code, ranked below the line Jev filled
    const perm = out.lines.find((l) => l.candidate.text === '        return gcd(a, b % a)');
    expect(perm).toMatchObject({ permuted: true, candidate: { op: 'sketch_P10_perm' } });
    expect(perm!.hypothesis.logP).toBeCloseTo(out.lines[0]!.hypothesis.logP - Math.LN2, 6);
    expect(new Set(out.candidates.map((c) => c.text)).size).toBe(out.candidates.length);
    expect(out.truncated).toBe(0);
    for (const call of ask.calls) expect(call.stage).toBe('propose');
  });

  it('a hole-free hypothesis passes straight through with no request', async () => {
    const { site } = gcdSite();
    const ask = scriptedAsk(() => undefined);
    const out = await fillSketches([hyp(site, ['return', 'gcd', '(', 'b', ',', 'a', '%', 'b', ')'], 'P7', 0.86)], context(site), ask);
    expect(out.requests).toBe(0);
    // no slot was filled by Jev, so nothing is permuted: pool-built swaps are the mutation source's job
    expect(out.candidates.map((c) => c.text)).toEqual(['        return gcd(b, a % b)']);
    expect(out.candidates[0]).toMatchObject({ op: 'sketch_P7', prior: 0.86 });
    expect(out.lines[0]).toMatchObject({ permuted: false, hypothesis: { pSketch: 0.86, logP: 0 } });
  });

  it('expands one option at p(top) ≥ 0.9 and B = 3 otherwise; every depth is one request', async () => {
    const { site } = gcdSite();
    const ask = scriptedAsk(byPartial({ 'return gcd(<HOLE>, ? % ?)': ['name_b', 0.95], 'return gcd(b, <HOLE> % ?)': ['name_a', 0.6] }));
    await fillSketches([hyp(site, GCD_SKETCH)], context(site), ask);
    expect(ask.calls.map((c) => hypothesesCount(c.state))).toEqual([1, 1, DEFAULT_FILL_WIDTH]);
    expect(Object.keys(ask.calls[2]!.questions)).toEqual(['slot_first', 'slot_second', 'slot_third']);
  });

  it('asks K × B items as independent questions in one request with the measured wording and option keys', async () => {
    const { site } = gcdSite();
    const ask = scriptedAsk(() => undefined);
    await fillSketches([hyp(site, GCD_SKETCH), hyp(site, ['return', '_', '(', 'a', '%', 'b', ',', 'b', ')'], 'P1')], context(site, { maxRequests: 1 }), ask);
    const call = ask.calls[0]!;
    expect(Object.keys(call.questions)).toEqual(['slot_first', 'slot_second']);
    const q = asChoice(call.questions['slot_first']);
    expect(q.instructions).toBe(slotQuestion('first', 'replace'));
    expect(stateString(call.state, 'hypotheses.first')).toBe('return gcd(<HOLE>, ? % ?)');
    expect(stateString(call.state, 'hypotheses.second')).toBe('return <HOLE>(a % b, b)');
    expect(stateString(call.state, 'buggy_line')).toBe('return gcd(a % b, b)');
    const keys = Object.keys(q.criteria);
    expect(keys).toContain('name_a');
    expect(keys).toContain('num_2');
    expect(keys[keys.length - 1]).toBe(ESCAPE_KEY);
    // a callable hole offers names only
    const second = asChoice(call.questions['slot_second']);
    expect(Object.keys(second.criteria).some((k) => k.startsWith('num_'))).toBe(false);
    expect(Object.keys(second.criteria)).toContain('name_gcd');
  });

  it('the compile gate drops a fill the tokenizer rejects (`if b not 0:`) and counts it', async () => {
    const { file } = gcdSite();
    const site = siteAt(file, 2);
    const sketch = ['if', 'b', '<op>', '0', ':'];
    const bad = scriptedAsk((_id, q) => massOn(asChoice(q), 'op_not', 0.95));
    const dropped = await fillSketches([hyp(site, sketch, 'P1')], context(site), bad);
    expect(dropped.requests).toBe(1);
    expect(dropped.gated).toBe(1);
    expect(dropped.candidates).toEqual([]);
    const good = scriptedAsk((_id, q) => massOn(asChoice(q), 'op_ne', 0.95));
    const kept = await fillSketches([hyp(site, sketch, 'P1')], context(site), good);
    expect(kept.candidates.map((c) => c.text)).toEqual(['    if b != 0:']);
    expect(kept.gated).toBe(0);
  });

  it('the assignment-operator slot offers `&=` (bitcount) while a comparison slot offers the measured 24 only', async () => {
    const file = sourceFile('bitcount.py', 'def bitcount(n):\n    count = 0\n    while n:\n        n ^= n - 1\n        count += 1\n    return count\n');
    const site = siteAt(file, 4);
    const ask = scriptedAsk((_id, q) => massOn(asChoice(q), 'op_bitand_assign', 0.95));
    const out = await fillSketches([hyp(site, ['n', '<op>', 'n', '-', '1'], 'P1')], context(site), ask);
    expect(out.candidates.map((c) => c.text)).toEqual(['        n &= n - 1']);
    expect(Object.keys(asChoice(ask.calls[0]!.questions['slot_first']).criteria)).toContain('op_bitand_assign');
    const header = siteAt(file, 3);
    const cmp = scriptedAsk(() => undefined);
    await fillSketches([hyp(header, ['while', 'n', '<op>', '0', ':'], 'P3')], context(header, { maxRequests: 1 }), cmp);
    expect(Object.keys(asChoice(cmp.calls[0]!.questions['slot_first']).criteria)).toHaveLength(24 + 1);
  });

  it('fills a P12 guard header and its body, returning the body as a filled extra edit', async () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const guard = guardTemplates(site)[0]!;
    const h: SketchHypothesis = { site, toks: guard.toks.map((t) => t.text), holes: holeIndices(guard.toks), production: 'P12', pSketch: 0.4, logP: 0, extraEdits: guard.extraEdits! };
    const script: Record<string, [string, number]> = {
      'if <HOLE> ? ?:\n    return ?': ['name_b', 0.95],
      'if b <HOLE> ?:\n    return ?': ['op_eq', 0.95],
      'if b == <HOLE>:\n    return ?': ['num_0', 0.95],
      'if b == 0:\n    return <HOLE>': ['name_a', 0.95],
    };
    const ask = scriptedAsk((id, q, state) => {
      const partial = partialOf(id, state);
      const entry = script[partial];
      if (entry === undefined) throw new Error(`unscripted partial ${JSON.stringify(partial)}`);
      return massOn(asChoice(q), entry[0], entry[1]);
    });
    const out = await fillSketches([h], context(site), ask);
    expect(out.requests).toBe(4);
    expect(asChoice(ask.calls[0]!.questions['slot_first']).instructions).toBe(slotQuestion('first', 'insert'));
    expect(out.candidates[0]).toMatchObject({ text: '        if b == 0:', op: 'sketch_P12', extraEdits: [{ path: 'gcd.py', line: 5, kind: 'insert', text: '            return a' }] });
  });

  it('applying a filled P12 guard lands header then body above the original line (verify/apply.ts pre-edit numbering)', async () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const guard = guardTemplates(site)[0]!;
    const h: SketchHypothesis = { site, toks: guard.toks.map((t) => t.text), holes: holeIndices(guard.toks), production: 'P12', pSketch: 0.4, logP: 0, extraEdits: guard.extraEdits! };
    const picks = ['name_b', 'op_eq', 'num_0', 'name_a'];
    const ask = scriptedAsk((_id, q, _state, call) => massOn(asChoice(q), picks[call]!, 0.95));
    const out = await fillSketches([h], context(site), ask);
    const applied = applyCandidate(out.candidates[0]!);
    expect(applied.files).toHaveLength(1);
    expect(applied.files[0]!.after).toContain('    else:\n        if b == 0:\n            return a\n        return gcd(a % b, b)\n');
    expect(applied.diff).toContain('+        if b == 0:\n+            return a\n');
    // the original line is untouched: an insert site never rewrites anything
    expect(applied.files[0]!.after.split('\n').filter((l) => l.includes('return gcd(a % b, b)'))).toHaveLength(1);
  });

  it('fills the P11 `_._(_)` template at a gap: value, attribute (attr_ keys) and value slots, insert-site wording', async () => {
    const file = sourceFile('f.py', 'def f(xs, x):\n    if x in xs:\n        return\n    return xs\n');
    const site = siteAt(file, 4, 'insert');
    const picks = ['name_xs', 'attr_append', 'name_x'];
    const ask = scriptedAsk((_id, q, _state, call) => massOn(asChoice(q), picks[call]!, 0.95));
    const out = await fillSketches([hyp(site, ['_', '.', '_', '(', '_', ')'], 'P11', 0.9)], context(site), ask);
    expect(out.requests).toBe(3);
    // the filled line first; `xs`/`x` are both parameters, so the code-side family permutation follows it
    expect(out.candidates.map((c) => c.text)).toEqual(['    xs.append(x)', '    x.append(xs)']);
    expect(out.candidates[0]).toMatchObject({ op: 'sketch_P11', prior: 0.9 });
    expect(out.candidates[1]).toMatchObject({ op: 'sketch_P11_perm' });
    expect(out.candidates[0]!.extraEdits).toBeUndefined();
    expect(asChoice(ask.calls[0]!.questions['slot_first']).instructions).toBe(slotQuestion('first', 'insert'));
    expect(stateString(ask.calls[0]!.state, 'hypotheses.first')).toContain('<HOLE>');
    const attrKeys = Object.keys(asChoice(ask.calls[1]!.questions['slot_first']).criteria);
    expect(attrKeys.every((k) => k.startsWith('attr_') || k === ESCAPE_KEY)).toBe(true);
    expect(attrKeys).toContain('attr_append');
  });

  it('never asks more than 15 items (K × B) in one request and counts every dropped item once', async () => {
    const { site } = gcdSite();
    // 16 distinct three-hole hypotheses: one more than a request may carry
    const sixteen = Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, (_, i) => hyp(site, [...GCD_SKETCH, '+', String(i)]));
    const confident = scriptedAsk((_id, q) => massOn(asChoice(q), 'name_b', 0.95));
    const out = await fillSketches(sixteen, context(site, { maxRequests: 1 }), confident);
    const ids = Object.keys(confident.calls[0]!.questions);
    expect(ids).toHaveLength(MAX_ITEMS_PER_REQUEST);
    expect(ids[0]).toBe(`slot_${hypothesisKeyAt(0)}`);
    expect(ids[14]).toBe(`slot_${hypothesisKeyAt(14)}`);
    // one item over the per-request cap, then the 15 live items (each expanded once at p ≥ 0.9) the budget stopped
    expect(out.truncated).toBe(1 + MAX_ITEMS_PER_REQUEST);
    expect(out.requests).toBe(1);
    expect(out.candidates).toEqual([]);
  });

  it('stops at the request budget, reporting the live items it dropped', async () => {
    const { site } = gcdSite();
    const ask = scriptedAsk(() => undefined);
    const out = await fillSketches([hyp(site, GCD_SKETCH)], context(site, { maxRequests: 1 }), ask);
    expect(out.requests).toBe(1);
    expect(out.candidates).toEqual([]);
    expect(out.truncated).toBe(DEFAULT_FILL_WIDTH);
  });

  it('rejects with AbortError when the signal has fired, and throws FillError on an unknown option key', async () => {
    const { site } = gcdSite();
    const ac = new AbortController();
    ac.abort();
    await expect(fillSketches([hyp(site, GCD_SKETCH)], context(site, { signal: ac.signal }), scriptedAsk(() => undefined))).rejects.toBeInstanceOf(AbortError);
    const rogue = scriptedAsk(() => ({ type: 'choice', choice: 'name_zzz', probabilities: { name_zzz: 1 }, confidence: 1 }));
    await expect(fillSketches([hyp(site, GCD_SKETCH)], context(site), rogue)).rejects.toBeInstanceOf(FillError);
  });

  it('works on a real pool: the kept gcd sketches fill without an unscripted crash and never return the current line', async () => {
    const { site } = gcdSite();
    const pool = sketchPool(site, enumerateOptions()).slice(0, 5).map((h) => ({ ...h, pSketch: 0.2 }));
    const ask = scriptedAsk(() => undefined);
    const out = await fillSketches(pool, context(site), ask);
    expect(out.requests).toBeLessThanOrEqual(12);
    expect(out.candidates.every((c) => c.text !== site.currentLine)).toBe(true);
    expect(out.candidates.every((c) => c.source === 'template' && c.op.startsWith('sketch_P'))).toBe(true);
  });
});

describe('familyPermutations', () => {
  it('swaps same-family identifier pairs when one of them was filled, bounded and marked', () => {
    const { site } = gcdSite();
    const line = toks('return gcd(b, a % b)');
    expect(familyPermutations(line, [3], site).map((l) => l.map((t) => t.text).join(' '))).toEqual(['return gcd ( a , b % a )']);
    // nothing filled → nothing permuted
    expect(familyPermutations(line, [], site)).toEqual([]);
    // attribute names are not identifiers to permute, and `xs`/`b` are no family
    expect(familyPermutations(toks('xs.a = b'), [0], site)).toEqual([]);
    expect(familyPermutations(toks('xs.a = b'), [2], site)).toEqual([]);
  });
});
