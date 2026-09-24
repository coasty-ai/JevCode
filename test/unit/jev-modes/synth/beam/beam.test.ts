import { describe, expect, it } from 'vitest';
import type { Json } from '../../../../../src/core/types.js';
import { isJsonArray, isJsonObject } from '../../../../../src/core/json.js';
import { AbortError } from '../../../../../src/errors.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { BEAM_STAGE, dedupeHypotheses, expansionCount, rankedOptions, runTokenBeam } from '../../../../../src/jev-modes/synth/beam/beam.js';
import { HYPOTHESES_KEY, MARK } from '../../../../../src/jev-modes/synth/beam/state.js';
import { toks } from '../../../../../src/jev-modes/synth/beam/tokens.js';
import { END_KEY, buildVocabulary } from '../../../../../src/jev-modes/synth/beam/vocab.js';
import { GCD_FAILURES, asChoice, enumerateOptions, gcdSite, keyForToken, massOn, massOver, scriptedAsk, siteAt, sourceFile, stateString } from './helpers.js';
import type { ChoiceQuestion } from './helpers.js';

const TARGET = 'return gcd(b, a % b)';
const targetToks = toks(TARGET).map((t) => t.text);

/** Tokens so far for a next-token question, from the flat state or its hypothesis. */
function partialTokens(id: string, state: Json): string[] {
  if (!isJsonObject(state)) throw new Error('state is not an object');
  const holder = id === 'next_token' ? state : isJsonObject(state[HYPOTHESES_KEY]) ? (state[HYPOTHESES_KEY] as Record<string, Json>)[id.slice('next_token_'.length)] : undefined;
  const pt = isJsonObject(holder) ? holder['partial_tokens'] : undefined;
  if (!isJsonArray(pt)) throw new Error(`no partial_tokens for ${id}`);
  return pt.map((x) => String(x));
}

/** Oracle script: the true next token gets `p`; divergent prefixes get a flat answer. */
function teacher(p: number): (id: string, q: ChoiceQuestion, state: Json) => Record<string, number> | undefined {
  return (id, q, state) => {
    const so = partialTokens(id, state);
    const onPath = so.every((t, i) => targetToks[i] === t);
    if (!onPath) return undefined;
    const key = so.length === targetToks.length ? END_KEY : keyForToken(q, targetToks[so.length]!);
    if (key === undefined) throw new Error(`target token ${targetToks[so.length]} not offered after ${so.join(' ')}`);
    return massOn(q, key, p);
  };
}

function run(ask: ReturnType<typeof scriptedAsk>, over: Partial<{ width: number; maxTokens: number; threshold: number; maxRequests: number; signal: AbortSignal }> = {}) {
  const { site } = gcdSite();
  const vocab = buildVocabulary(site, enumerateOptions({ testLiterals: ['17', '13'] }));
  return runTokenBeam(ask, site, vocab, { task: 'fix gcd', failures: GCD_FAILURES }, {
    width: over.width ?? 3,
    maxTokens: over.maxTokens ?? 25,
    confidentExpandThreshold: over.threshold ?? 0.9,
    maxRequests: over.maxRequests ?? 60,
    signal: over.signal ?? new AbortController().signal,
  });
}

describe('token beam: scripted reconstruction of `return gcd(b, a % b)`', () => {
  it('rebuilds the line from confident answers in one request per token plus END', async () => {
    const script = teacher(0.95);
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? script(id, q, state) : undefined));
    const res = await run(ask);
    expect(res.lines[0]?.text).toBe(`        ${TARGET}`);
    expect(res.lines[0]!.logProb).toBeCloseTo(Math.log(0.95) * (targetToks.length + 1), 6);
    // every position was confident, so each depth carried exactly one hypothesis
    expect(res.requests).toBe(targetToks.length + 1);
    for (const c of ask.calls) expect(Object.keys(c.questions)).toEqual(['next_token']);
    expect(ask.calls.every((c) => c.stage === BEAM_STAGE)).toBe(true);
    expect(res.truncated).toBe(0);
  });
  it('uses the measured state shape and question wording', async () => {
    const script = teacher(0.95);
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? script(id, q, state) : undefined));
    await run(ask);
    const first = ask.calls[0]!;
    expect(isJsonObject(first.state)).toBe(true);
    const st = first.state as Record<string, Json>;
    expect(st['task']).toContain('The Python function `gcd` has a one-line bug');
    expect(st['program']).toContain(`        ${MARK}`);
    expect(st['program']).not.toContain('return gcd(a % b, b)');
    expect(st['buggy_line']).toBe('return gcd(a % b, b)');
    expect(st['goal']).toBe('fix gcd');
    expect(st['tests']).toEqual(GCD_FAILURES.map((f) => ({ test: f.testId, call: f.call, expected: f.expected, actual: f.actual })));
    expect(st['partial_line']).toBe('');
    expect(st['partial_tokens']).toEqual([]);
    const q = asChoice(first.questions['next_token']);
    expect(q.instructions).toContain('Which single Python token comes immediately next in the correct line?');
    expect(q.instructions).toContain('`partial_line`');
    expect(q.criteria[ESCAPE_KEY]).toBeNull();
    // a fresh line: statement starts only, no END, no closers
    expect(q.criteria[END_KEY]).toBeUndefined();
    expect(q.criteria['punct_close_paren']).toBeUndefined();
    expect(q.criteria['keyword_return']).toBeDefined();
    const third = ask.calls[2]!.state as Record<string, Json>;
    expect(third['partial_line']).toBe('return gcd');
    expect(third['partial_tokens']).toEqual(['return', 'gcd']);
  });
  it('never returns the unchanged current line even when Jev ends on it', async () => {
    const buggy = toks('return gcd(a % b, b)').map((t) => t.text);
    const ask = scriptedAsk((id, q, state) => {
      if (q.type !== 'choice') return undefined;
      const so = partialTokens(id, state);
      const key = so.length === buggy.length ? END_KEY : keyForToken(q, buggy[so.length]!);
      return key === undefined ? undefined : massOn(q, key, 0.95);
    });
    const res = await run(ask);
    expect(res.lines.some((l) => l.text.trim() === 'return gcd(a % b, b)')).toBe(false);
  });
  it('a completion equal to the buggy line does not count towards W, so the beam keeps searching for real lines', async () => {
    // buggy `return a` completes at depth 2 with a high score; two longer alternatives complete at depths 5 and 7.
    // If the buggy line counted as completed, W=2 would be reached at depth 5 and the depth-7 line pruned away.
    const file = sourceFile('f.py', 'def f(a, b):\n    return a\n');
    const site = siteAt(file, 2);
    const vocab = buildVocabulary(site, enumerateOptions({ taskIdentifiers: ['x'], testLiterals: ['1'] }));
    const script: Record<string, Record<string, number>> = {
      '': { return: 0.5, x: 0.4 },
      return: { a: 0.95 },
      'return a': { [END_KEY]: 0.95 },
      x: { '=': 0.95 },
      'x =': { a: 0.95 },
      'x = a': { '+': 0.5, '-': 0.4 },
      'x = a +': { '1': 0.95 },
      'x = a + 1': { [END_KEY]: 0.95 },
      'x = a -': { b: 0.95 },
      'x = a - b': { '+': 0.95 },
      'x = a - b +': { '1': 0.95 },
      'x = a - b + 1': { [END_KEY]: 0.95 },
    };
    const ask = scriptedAsk((id, q, state) => {
      if (q.type !== 'choice') return undefined;
      const so = partialTokens(id, state).join(' ');
      const want = script[so];
      if (want === undefined) return undefined;
      const masses: Record<string, number> = {};
      for (const [tok, p] of Object.entries(want)) {
        const key = tok === END_KEY ? END_KEY : keyForToken(q, tok);
        if (key === undefined) throw new Error(`${tok} not offered after ${JSON.stringify(so)}`);
        masses[key] = p;
      }
      return massOver(q, masses);
    });
    const res = await runTokenBeam(ask, site, vocab, { task: '', failures: [] }, { width: 2, maxTokens: 12, confidentExpandThreshold: 0.9, maxRequests: 60, signal: new AbortController().signal });
    expect(res.lines.map((l) => l.text.trim())).toEqual(['x = a + 1', 'x = a - b + 1']);
    expect(res.lines.some((l) => l.text.trim() === 'return a')).toBe(false);
  });
});

describe('token beam: confidence-adaptive expansion', () => {
  it('expansionCount is 1 at or above the threshold and W below it', () => {
    expect(expansionCount(0.9, 0.9, 3)).toBe(1);
    expect(expansionCount(0.95, 0.9, 3)).toBe(1);
    expect(expansionCount(0.89, 0.9, 3)).toBe(3);
    expect(expansionCount(0.2, 0.9, 5)).toBe(5);
  });
  it('an unsure first position fans out to W hypotheses batched in one request; confident ones stay single', async () => {
    const sure = teacher(0.95);
    const ask = scriptedAsk((id, q, state, call) => {
      if (q.type !== 'choice') return undefined;
      if (call === 0) return massOn(q, keyForToken(q, 'return')!, 0.5);
      return sure(id, q, state);
    });
    const res = await run(ask);
    expect(Object.keys(ask.calls[0]!.questions)).toEqual(['next_token']);
    // depth 1: three live prefixes, one request, one question each, each naming its own path
    const second = ask.calls[1]!;
    const ids = Object.keys(second.questions);
    expect(ids).toHaveLength(3);
    const hyps = (second.state as Record<string, Json>)[HYPOTHESES_KEY];
    expect(isJsonObject(hyps)).toBe(true);
    expect(Object.keys(hyps as Record<string, Json>)).toHaveLength(3);
    for (const id of ids) {
      expect(id.startsWith('next_token_prefix_')).toBe(true);
      const key = id.slice('next_token_'.length);
      expect(stateString(second.state, `${HYPOTHESES_KEY}.${key}.partial_line`)).toBeDefined();
      expect(asChoice(second.questions[id]).instructions).toContain(`\`${HYPOTHESES_KEY}.${key}.partial_line\``);
    }
    expect(ids.some((id) => id === 'next_token_prefix_return')).toBe(true);
    expect(res.lines[0]?.text.trim()).toBe(TARGET);
  });
  it('the request count halves when every position is confident versus none', async () => {
    const sure = teacher(0.95);
    const askSure = scriptedAsk((id, q, state) => (q.type === 'choice' ? sure(id, q, state) : undefined));
    const resSure = await run(askSure);
    const unsure = teacher(0.6);
    const askUnsure = scriptedAsk((id, q, state) => (q.type === 'choice' ? unsure(id, q, state) : undefined));
    const resUnsure = await run(askUnsure, { maxRequests: 200 });
    expect(resSure.requests).toBe(targetToks.length + 1);
    // unsure: still one request per depth (hypotheses batched), but each carries up to W questions
    const questionsUnsure = askUnsure.calls.reduce((n, c) => n + Object.keys(c.questions).length, 0);
    expect(questionsUnsure).toBeGreaterThan(resSure.requests);
    expect(askUnsure.calls.slice(1).every((c) => Object.keys(c.questions).length <= 3)).toBe(true);
    expect(resUnsure.lines.map((l) => l.text.trim())).toContain(TARGET);
    expect(resUnsure.lines.length).toBeLessThanOrEqual(3);
    expect(new Set(resUnsure.lines.map((l) => l.text)).size).toBe(resUnsure.lines.length);
  });
});

describe('token beam: budgets, escape, abort', () => {
  it('stops at maxRequests and keeps what completed', async () => {
    const sure = teacher(0.95);
    const ask = scriptedAsk((id, q, state) => (q.type === 'choice' ? sure(id, q, state) : undefined));
    const res = await run(ask, { maxRequests: 4 });
    expect(res.requests).toBe(4);
    expect(ask.calls).toHaveLength(4);
    expect(res.lines).toEqual([]);
  });
  it('honours maxTokens and reports truncation', async () => {
    // always continue with `x` never END: the beam must give up at maxTokens
    const ask = scriptedAsk((_id, q) => {
      if (q.type !== 'choice') return undefined;
      const k = keyForToken(q, 'a') ?? keyForToken(q, '+');
      return k === undefined ? undefined : massOn(q, k, 0.95);
    });
    const res = await run(ask, { maxTokens: 6 });
    expect(res.requests).toBe(6);
    expect(res.truncated).toBe(1);
    expect(res.lines).toEqual([]);
  });
  it('records the escape probability and never expands none_of_these', async () => {
    const sure = teacher(0.99);
    const ask = scriptedAsk((id, q, state) => {
      if (q.type !== 'choice') return undefined;
      const m = sure(id, q, state);
      if (m === undefined) return undefined;
      m[ESCAPE_KEY] = 0.7; // escape takes ~0.41 of the mass at every position (below the target's ~0.59)
      return m;
    });
    const res = await run(ask);
    expect(res.maxEscapeProbability).toBeGreaterThan(0.3);
    expect(res.lines.map((l) => l.text.trim())).toContain(TARGET);
    // the escape's mass lowered p(top) under the threshold, so positions fanned out to W hypotheses
    expect(ask.calls.some((c) => Object.keys(c.questions).length > 1)).toBe(true);
  });
  it('rejects with AbortError before asking when the signal is already aborted', async () => {
    const ask = scriptedAsk(() => undefined);
    const c = new AbortController();
    c.abort();
    await expect(run(ask, { signal: c.signal })).rejects.toBeInstanceOf(AbortError);
    expect(ask.calls).toHaveLength(0);
  });
  it('stops at the next depth when aborted mid-run', async () => {
    const c = new AbortController();
    const sure = teacher(0.95);
    const ask = scriptedAsk(
      (id, q, state) => (q.type === 'choice' ? sure(id, q, state) : undefined),
      { onCall: (call) => { if (Object.keys(call.questions).length > 0 && ask.calls.length === 2) c.abort(new Error('user stop')); } },
    );
    const err = await run(ask, { signal: c.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect((err as AbortError).cause).toEqual(new Error('user stop'));
    expect(ask.calls).toHaveLength(2);
  });
  it('propagates a rejection from the ask function', async () => {
    const ask = scriptedAsk(() => { throw new Error('network down'); });
    await expect(run(ask)).rejects.toThrow('network down');
  });
});

describe('token beam: helpers', () => {
  it('rankedOptions sorts by probability then key; dedupeHypotheses keeps the best per sequence', () => {
    expect(rankedOptions({ type: 'choice', choice: 'b_opt', probabilities: { a_opt: 0.3, b_opt: 0.4, c_opt: 0.3 }, confidence: 0 }).map(([k]) => k)).toEqual(['b_opt', 'a_opt', 'c_opt']);
    const d = dedupeHypotheses([
      { toks: toks('a b'), logProb: -2 },
      { toks: toks('a b'), logProb: -1 },
      { toks: toks('a'), logProb: -3 },
    ]);
    expect(d.map((h) => h.logProb)).toEqual([-1, -3]);
  });
});
