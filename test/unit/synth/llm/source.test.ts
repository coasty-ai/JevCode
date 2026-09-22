import { describe, expect, it } from 'vitest';

import type { CompileCheck } from '../../../../src/synth/llm/candidates.js';
import type { SynthesizerGeneration } from '../../../../src/core/types.js';
import type { CancelledGeneration, GenerateResult } from '../../../../src/core/types.js';
import { LLM_CACHE_PERSIST_BYTES, LLM_DEFAULT_GENERATION, LLM_MAX_TOKENS, LLM_MAX_TOKENS_REASONING, UNFINISHED_REASONING_ALLOWANCE_TOKENS, affordableSamples, coversSample, createLlmSource, estimatedSampleUsage, sampleDeadlineMs, samplesFor, unfinishedSampleUsage, type LlmBudget, type LlmFireInput, type LlmSource, type SampleArrival } from '../../../../src/synth/llm/source.js';
import type { GenerateFn } from '../../../../src/synth/llm/types.js';
import { listingSet } from '../../../../src/synth/llm/prompt.js';
import { calcFiles, proposeFixCall, scriptedGenerate, type HunkIn } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };

/** the fake prompt ('sys' + 'user k') is 9 chars: 3 prompt tokens before a sibling lands */
const PROMPT_TOKENS = Math.ceil(('sys'.length + 'user 0'.length) / 4);
/** what one sample reserves at fire before any sibling landed: prompt chars / 4 in, max_tokens out */
const RESERVATION = (PROMPT_TOKENS * PRICING.inputPerM + LLM_DEFAULT_GENERATION.maxTokens * PRICING.outputPerM) / 1e6;
/** what a sample that never returned is booked at with nothing streamed: the reasoning allowance */
const LOST = (inputTokens: number): number => (inputTokens * PRICING.inputPerM + UNFINISHED_REASONING_ALLOWANCE_TOKENS * PRICING.outputPerM) / 1e6;

const FIX_A: HunkIn[] = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];
const FIX_B: HunkIn[] = [{ old: '    return a + b', new: '    return b if a is None else a + b', near_line: 4 }];

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 2, samplesLeft: 8, usdLeft: 0.02, ...over };
}

function fireInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: 'sys', userFor: (k) => `user ${k}`, files, listings, signal: new AbortController().signal, budget: b, deadlineMs: 5000, ...over };
}

async function drain(src: LlmSource): Promise<SampleArrival[]> {
  return src.collectAll();
}

describe('createLlmSource: stagger, drops, deadlines, cancellation, cache', () => {
  it('fires sample 0 alone on QuixBugs class and the rest on release(); every sample is charged', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: proposeFixCall([k === 0 ? FIX_A : FIX_B]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    const events: string[] = [];
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING, emit: (phase, detail) => events.push(`${phase}: ${detail}`) });
    const b = budget();
    const fired = src.fire(fireInput(b, { n: 3 }));
    expect(fired).toMatchObject({ fired: true, samples: 1, cached: 0, deadlineMs: 5000 });
    expect(gen.calls()).toBe(1);
    // the default generation: reasoning effort low ({enabled: false} is HTTP 400 on the GLM endpoint) with the reasoning-on base
    expect(LLM_DEFAULT_GENERATION).toMatchObject({ reasoning: { effort: 'low' }, maxTokens: LLM_MAX_TOKENS_REASONING });
    expect(gen.requests()[0]).toMatchObject({ temperature: 0, maxTokens: LLM_MAX_TOKENS_REASONING, toolChoice: { name: 'propose_fix' }, reasoning: { effort: 'low' }, providerPrefs: { requireParameters: true } });
    expect(gen.requests()[0]!.seed).toBeUndefined();
    const first = await src.collect();
    expect(first).toMatchObject({ sample: 0, status: 'valid', estimated: false });
    expect(first!.candidates).toHaveLength(1);
    expect(first!.usd).toBeCloseTo((4000 * 0.5 + 300 * 2) / 1e6, 9);
    expect(src.round()).toMatchObject({ fired: 1, valid: 1, closed: false });
    src.release();
    expect(gen.calls()).toBe(3);
    expect(gen.requests().slice(1).map((r) => [r.temperature, r.seed])).toEqual([
      [0.8, 301],
      [0.8, 302],
    ]);
    const rest = await drain(src);
    expect(rest.map((a) => a.sample).sort()).toEqual([1, 2]);
    // sample 2 repeats sample 1's diff: folded, agreement counted
    const dup = rest.find((a) => a.dropped.some((d) => d.reason === 'duplicate'));
    expect(dup).toBeDefined();
    const summary = src.round()!;
    expect(summary).toMatchObject({ fired: 3, valid: 3, distinct: 2, duplicates: 1, closed: true });
    expect(b.roundsLeft).toBe(1);
    expect(b.samplesLeft).toBe(5);
    expect(0.02 - b.usdLeft).toBeCloseTo(3 * ((4000 * 0.5 + 300 * 2) / 1e6), 9);
    expect(events.some((e) => e.startsWith('llm:fire') && e.includes('staggered'))).toBe(true);
    expect(events.some((e) => e.startsWith('llm:round'))).toBe(true);
    expect(await src.collect()).toBeNull();
  });

  it('drops a finish_reason=length sample and doubles max_tokens for the goal once; a malformed reply is dropped, not retried', async () => {
    const gen = scriptedGenerate(
      (k) => (k === 0 ? { toolCall: proposeFixCall([FIX_A]) } : { text: 'I would change the guard.' }),
      (k) => (k === 0 ? 'length' : null),
    );
    const src = createLlmSource({ generate: gen.generate });
    const b = budget();
    src.fire(fireInput(b, { n: 2, stagger: false }));
    const arrivals = await drain(src);
    expect(arrivals.map((a) => [a.sample, a.status])).toEqual([
      [0, 'length'],
      [1, 'malformed'],
    ]);
    expect(arrivals.every((a) => a.candidates.length === 0)).toBe(true);
    expect(arrivals[1]!.detail).toMatch(/no tool call and no fenced json/);
    expect(src.maxTokensFor('g1')).toBe(2 * LLM_MAX_TOKENS_REASONING);
    expect(src.maxTokensFor('g2')).toBe(LLM_MAX_TOKENS_REASONING);
    expect(gen.calls()).toBe(2);
    // the next round of the same goal asks with the doubled cap
    const again = src.fire(fireInput(b, { n: 1, stagger: false, round: 2 }));
    expect(again.fired).toBe(true);
    expect(gen.requests().at(-1)!.maxTokens).toBe(2 * LLM_MAX_TOKENS_REASONING);
    await drain(src);
    // an overriding `reasoning` is sent verbatim and sets the base it implies before the doubling: off → 1,500, effort low → 3,000
    expect(src.fire(fireInput(budget(), { n: 1, stagger: false, round: 2, reasoning: { enabled: false } })).fired).toBe(true);
    expect(gen.requests().at(-1)).toMatchObject({ maxTokens: 2 * LLM_MAX_TOKENS, reasoning: { enabled: false } });
    await drain(src);
    expect(src.fire(fireInput(budget(), { n: 1, stagger: false, round: 2, reasoning: { effort: 'low' } })).fired).toBe(true);
    expect(gen.requests().at(-1)).toMatchObject({ maxTokens: 2 * LLM_MAX_TOKENS_REASONING, reasoning: { effort: 'low' } });
    await drain(src);
  });

  it('a pinned generation is what every sample sends: reasoning verbatim (null = not sent), its max_tokens base, its temperatures and its deadline clamp', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    const pinned: SynthesizerGeneration = { reasoning: null, maxTokens: 2222, sampleDeadline: { minMs: 100, maxMs: 7000, repositoryMs: 9000 }, sampleTemperature: { first: 0.1, rest: 0.9, feedbackFirst: 0.5, feedbackRest: 1 } };
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING, generation: pinned });
    const { deadlineMs: _cheap, ...cheap } = fireInput(budget(), { n: 2, stagger: false });
    expect(src.fire(cheap)).toMatchObject({ fired: true, deadlineMs: 7000 });
    await drain(src);
    expect(gen.requests().map((r) => [r.maxTokens, r.temperature, 'reasoning' in r])).toEqual([
      [2222, 0.1, false],
      [2222, 0.9, false],
    ]);
    expect(src.maxTokensFor('g1')).toBe(2222);
    const { deadlineMs: _repo, ...repo } = fireInput(budget(), { goalId: 'g2', klass: 'repository', n: 1 });
    expect(src.fire(repo)).toMatchObject({ fired: true, deadlineMs: 9000 });
    await drain(src);
  });

  it('books a provider error from its stream (the allowance, never max_tokens), and release() fires nothing once the dollar counter cannot cover another sample or the step ended', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    // the failure lands after sample 0, so the estimate takes the sibling's prompt tokens
    const failing: typeof gen.generate = (req, o) => (o.sample === 1 ? new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP 502 after retries')), 30)) : gen.generate(req, o));
    const src = createLlmSource({ generate: failing, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b, { n: 2, stagger: false }));
    const arrivals = await drain(src);
    const err = arrivals.find((a) => a.sample === 1)!;
    // the sibling landed first: its 4,000 prompt tokens, and on the output side only the reasoning allowance (nothing streamed)
    const estimate = LOST(4000);
    expect(err).toMatchObject({ status: 'error', estimated: true, detail: 'HTTP 502 after retries', candidates: [] });
    expect(err.usage).toMatchObject({ inputTokens: 4000, outputTokens: UNFINISHED_REASONING_ALLOWANCE_TOKENS, estimated: true });
    expect(err.usd).toBeCloseTo(estimate, 9);
    expect(0.02 - b.usdLeft).toBeCloseTo(estimate + (4000 * 0.5 + 300 * 2) / 1e6, 9);
    expect(src.round()).toMatchObject({ errors: 1, valid: 1, closed: true });
    // the counter covers exactly one reservation: sample 0 fires; once it settled the sibling-priced reservation of sample 1 no longer fits,
    // so release() starts none of samples 1..N−1 and the round closes
    const spent = budget({ usdLeft: RESERVATION + 0.0001 });
    src.fire(fireInput(spent, { goalId: 'g2', n: 3 }));
    expect((await src.collect())!.status).toBe('valid');
    expect(spent.usdLeft).toBeGreaterThan(0);
    expect(coversSample(spent.usdLeft, estimatedSampleUsage({ siblingInputTokens: 4000, promptChars: 9, maxTokens: LLM_DEFAULT_GENERATION.maxTokens, pricing: PRICING }).costUsd)).toBe(false);
    src.release();
    expect(gen.calls()).toBe(2);
    expect(await src.collect()).toBeNull();
    expect(spent.samplesLeft).toBe(7);
    // an aborted step signal stops release() the same way
    const parent = new AbortController();
    src.fire(fireInput(budget(), { goalId: 'g3', n: 3, signal: parent.signal }));
    await src.collect();
    parent.abort(new Error('step over'));
    src.release();
    expect(gen.calls()).toBe(3);
    expect(src.round()).toMatchObject({ fired: 1, closed: true });
  });

  it('fire() right after cancel() supersedes the draining round, cancel() resolves once its estimates are booked; a staggered round awaiting release() stays open', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: proposeFixCall([FIX_A]), latencyMs: k === 9 ? 0 : 2000 }));
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING });
    const b1 = budget();
    src.fire(fireInput(b1, { n: 2, stagger: false }));
    const done = src.cancel('commit');
    // the design's main path: seeds win → cancel → the next goal fires without awaiting the losers
    const next = src.fire(fireInput(budget(), { goalId: 'g2', n: 1, stagger: false, userFor: () => 'user 9', step: 0 }));
    expect(next).toMatchObject({ fired: true, samples: 1 });
    await done;
    // the losers never streamed: booked at prompt chars / 4 in and the reasoning allowance out; their reservations came back
    expect(0.02 - b1.usdLeft).toBeCloseTo(2 * LOST(PROMPT_TOKENS), 9);
    const arrivals = await drain(src);
    expect(arrivals.map((a) => [a.sample, a.status])).toEqual([[0, 'valid']]);
    expect(src.round()).toMatchObject({ goalId: 'g2', closed: true });
    // staggered and not yet released: sample 0 is racing the seeds, a second fire() is refused; after release() the round only drains and can be superseded
    src.fire(fireInput(budget(), { goalId: 'g3', n: 2 }));
    expect(src.fire(fireInput(budget(), { goalId: 'g4', n: 1 }))).toMatchObject({ fired: false, reason: 'round_open' });
    src.release();
    expect(src.fire(fireInput(budget(), { goalId: 'g4', n: 1, stagger: false }))).toMatchObject({ fired: true });
    await src.cancel('abort');
  });

  it('compile-checks cache replays against the current base, and a checker that rejects drops the patch without hanging the round', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]) }));
    let verdict: 'ok' | 'syntax' | 'reject' = 'ok';
    const compile: CompileCheck = async (_path, _source) => {
      if (verdict === 'reject') throw new Error('sandbox aborted');
      return verdict === 'ok' ? { ok: true } : { ok: false, message: 'SyntaxError: invalid syntax (line 4)' };
    };
    const src = createLlmSource({ generate: gen.generate, compile });
    src.fire(fireInput(budget(), { n: 1, stagger: false }));
    expect((await drain(src)).flatMap((a) => a.candidates)).toHaveLength(1);
    // the replay re-anchors the cached patch against the current base, so its post-image goes through the checker again
    verdict = 'syntax';
    expect(src.fire(fireInput(budget(), { n: 1, stagger: false }))).toMatchObject({ fired: false, reason: 'cached' });
    const [replay] = await drain(src);
    expect(replay).toMatchObject({ status: 'cached', candidates: [] });
    expect(replay!.dropped.map((d) => d.reason)).toEqual(['syntax_error']);
    // a rejecting checker (the sandbox rejects on an engine abort) is a compile_failed drop; the sample settles and the round closes
    verdict = 'reject';
    src.fire(fireInput(budget(), { goalId: 'g2', n: 1, stagger: false }));
    const [a] = await drain(src);
    expect(a).toMatchObject({ status: 'valid', candidates: [] });
    expect(a!.dropped[0]).toMatchObject({ reason: 'compile_failed', detail: 'compile check failed for src/calc.py: sandbox aborted' });
    expect(src.round()).toMatchObject({ compileFailed: 1, closed: true });
    expect(await src.collect()).toBeNull();
  });

  it('exportCache keeps this run’s rounds over the persisted ones under the 4 KB bound', async () => {
    const stale: Record<string, { round: number; sha12: string[] }> = {};
    for (let i = 0; i < 80; i++) stale[`old${i}`] = { round: 1, sha12: Array.from({ length: 4 }, (_, j) => `${i}`.padStart(6, 'a') + `${j}`.padStart(6, 'b')) };
    expect(JSON.stringify(stale).length).toBeGreaterThan(LLM_CACHE_PERSIST_BYTES);
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]) }));
    const src = createLlmSource({ generate: gen.generate, cache: stale });
    src.fire(fireInput(budget(), { n: 1, stagger: false }));
    await drain(src);
    const exported = src.exportCache() as Record<string, { round: number; sha12: string[] }>;
    expect(Object.keys(exported)[0]).toBe('g1');
    expect(exported['g1']!.sha12).toHaveLength(1);
    expect(JSON.stringify(exported).length).toBeLessThanOrEqual(LLM_CACHE_PERSIST_BYTES);
    expect(Object.keys(exported).length).toBeLessThan(81);
  });

  it('aborts a sample past its deadline and meters it as an estimate the budget sees', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: proposeFixCall([FIX_A]), latencyMs: k === 0 ? 400 : 0, usage: { inputTokens: 5000, outputTokens: 100 } }));
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b, { n: 2, stagger: false, deadlineMs: 40 }));
    const arrivals = await drain(src);
    const timedOut = arrivals.find((a) => a.sample === 0)!;
    expect(timedOut).toMatchObject({ status: 'timeout', estimated: true, candidates: [] });
    expect(timedOut.ms).toBeLessThan(400);
    // estimate: the sibling's prompt tokens (sample 1 landed first) and, nothing having streamed, the reasoning allowance — not max_tokens
    const estimate = LOST(5000);
    expect(timedOut.usd).toBeCloseTo(estimate, 9);
    expect(timedOut.usage).toMatchObject({ inputTokens: 5000, outputTokens: UNFINISHED_REASONING_ALLOWANCE_TOKENS, estimated: true });
    expect(src.round()).toMatchObject({ timeouts: 1, valid: 1, closed: true });
    expect(src.round()!.estimatedUsd).toBeCloseTo(estimate, 9);
    expect(0.02 - b.usdLeft).toBeCloseTo(estimate + (5000 * 0.5 + 100 * 2) / 1e6, 9);
  });

  it('cancel() aborts every in-flight sample through its own controller, meters the estimates and ends the round', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), latencyMs: 2000 }));
    const events: string[] = [];
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING, emit: (phase) => events.push(phase) });
    const b = budget();
    src.fire(fireInput(b, { n: 2, stagger: false }));
    expect(src.inFlight()).toBe(2);
    src.cancel('commit');
    const arrivals = await drain(src);
    expect(arrivals.map((a) => a.status)).toEqual(['cancelled', 'cancelled']);
    expect(arrivals.every((a) => a.estimated && a.usd > 0 && a.detail === 'llm sample cancelled: commit')).toBe(true);
    // no sibling landed: the prompt estimate is chars / 4
    expect(arrivals[0]!.usage!.inputTokens).toBe(Math.ceil(('sys'.length + 'user 0'.length) / 4));
    expect(b.usdLeft).toBeLessThan(0.02);
    expect(events).toContain('llm:cancel');
    expect(src.round()).toMatchObject({ cancelled: 2, closed: true });
    // the parent signal cancels the same way
    const parent = new AbortController();
    src.fire(fireInput(budget(), { n: 1, stagger: false, signal: parent.signal }));
    parent.abort(new Error('step over'));
    const [a] = await drain(src);
    expect(a!.status).toBe('cancelled');
  });

  it('reserves every sample\'s full estimate at fire, fires only what the dollar counter covers, and refunds the reservation at settle', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), latencyMs: 30, usage: { inputTokens: 4000, outputTokens: 300 } }));
    const events: string[] = [];
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING, emit: (phase, detail) => events.push(`${phase}: ${detail}`) });
    // headroom for two reservations of four requested samples
    const b = budget({ usdLeft: 2 * RESERVATION + 0.001 });
    expect(affordableSamples(b.usdLeft, RESERVATION)).toBe(2);
    const fired = src.fire(fireInput(b, { n: 4, stagger: false }));
    expect(fired).toMatchObject({ fired: true, samples: 2 });
    if (fired.fired) expect(fired.reservedUsd).toBeCloseTo(2 * RESERVATION, 9);
    expect(gen.calls()).toBe(2);
    // in flight the counter holds the reservations (an L1′ or another goal sees no headroom), not zero
    expect(b.usdLeft).toBeCloseTo(0.001, 9);
    expect(b.samplesLeft).toBe(6);
    // the summary reports what is still held, so a caller re-installing the step budget mid-round can carry it over
    expect(src.round()!.reservedUsd).toBeCloseTo(2 * RESERVATION, 9);
    expect(events.some((e) => e.startsWith('llm:fire') && e.includes('2/4 samples fired') && e.includes('reserved'))).toBe(true);
    await drain(src);
    // settled: each sample holds its price, the reservation came back
    const priced = (4000 * 0.5 + 300 * 2) / 1e6;
    expect(2 * RESERVATION + 0.001 - b.usdLeft).toBeCloseTo(2 * priced, 9);
    expect(src.round()).toMatchObject({ fired: 2, valid: 2, closed: true, reservedUsd: 0 });
    // cents of headroom fire nothing at all (the §4.2 skip is "cannot cover one sample", not "≤ 0")
    const cents = budget({ usdLeft: RESERVATION / 2 });
    expect(src.fire(fireInput(cents, { goalId: 'g2', n: 4, stagger: false }))).toMatchObject({ fired: false, reason: 'no_usd' });
    expect(gen.calls()).toBe(2);
    expect(cents.usdLeft).toBeCloseTo(RESERVATION / 2, 12);
    expect(cents.roundsLeft).toBe(2);
    // no pricing: estimates are 0 and any positive counter covers a sample; a spent counter covers none
    expect(coversSample(0.0001, 0)).toBe(true);
    expect(coversSample(0, 0)).toBe(false);
    expect(affordableSamples(0.01, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(affordableSamples(0, 0.001)).toBe(0);
  });

  it('books a cancelled sample from the facts its stream left — streamed chars / 4 plus the reasoning allowance, or the usage frame when it arrived', async () => {
    const facts = new Map<number, CancelledGeneration>([
      [0, { text: '', toolChars: 800, reasoningChars: 0 }],
      // the stream carried 6,000 reasoning chars: more than the allowance, so it counts instead
      [1, { text: 'x'.repeat(40), toolChars: 0, reasoningChars: 6000 }],
      // the accounting frame had arrived before the abort: priced like a completed call
      [2, { text: '', toolChars: 300, reasoningChars: 0, usage: { inputTokens: 4000, outputTokens: 350, costUsd: 0.0011, calls: 1 } }],
    ]);
    const generate: GenerateFn = (_req, o) =>
      new Promise<GenerateResult>((_resolve, reject) => {
        o.signal.addEventListener('abort', () => {
          const f = facts.get(o.sample);
          if (f !== undefined) o.onCancelled?.(f);
          reject(o.signal.reason);
        });
      });
    const src = createLlmSource({ generate, pricing: PRICING });
    const b = budget({ usdLeft: 0.05 });
    src.fire(fireInput(b, { n: 4, stagger: false }));
    expect(src.inFlight()).toBe(4);
    await src.cancel('commit');
    const arrivals = (await drain(src)).sort((x, y) => x.sample - y.sample);
    expect(arrivals.map((a) => a.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(arrivals[0]!.usage).toMatchObject({ inputTokens: PROMPT_TOKENS, outputTokens: 200 + UNFINISHED_REASONING_ALLOWANCE_TOKENS, estimated: true });
    expect(arrivals[1]!.usage).toMatchObject({ inputTokens: PROMPT_TOKENS, outputTokens: 10 + 1500, estimated: true });
    expect(arrivals[2]).toMatchObject({ estimated: false, usd: 0.0011 });
    expect(arrivals[2]!.usage).toMatchObject({ inputTokens: 4000, outputTokens: 350, costUsd: 0.0011 });
    // sample 3 left no facts (the abort landed before its headers): the allowance alone
    expect(arrivals[3]!.usage).toMatchObject({ inputTokens: PROMPT_TOKENS, outputTokens: UNFINISHED_REASONING_ALLOWANCE_TOKENS, estimated: true });
    const booked = arrivals.reduce((s, a) => s + a.usd, 0);
    expect(0.05 - b.usdLeft).toBeCloseTo(booked, 9);
    expect(src.round()).toMatchObject({ cancelled: 4, closed: true });
    expect(src.round()!.estimatedUsd).toBeCloseTo(booked - 0.0011, 9);
    // the same estimator, standalone: reasoning off drops the allowance
    expect(unfinishedSampleUsage({ siblingInputTokens: 4000, promptChars: 0, partial: { text: '', toolChars: 800, reasoningChars: 0 }, reasoning: false, pricing: PRICING })).toMatchObject({ inputTokens: 4000, outputTokens: 200, estimated: true });
    expect(unfinishedSampleUsage({ siblingInputTokens: null, promptChars: 4000, partial: null, reasoning: true, pricing: null })).toMatchObject({ inputTokens: 1000, outputTokens: UNFINISHED_REASONING_ALLOWANCE_TOKENS, costUsd: 0 });
  });

  it('replays a cached round for the same (goal, listings, attempts, round) key and skips generation when ≥ N untried candidates are known', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: proposeFixCall([k === 0 ? FIX_A : FIX_B]) }));
    const src = createLlmSource({ generate: gen.generate });
    src.fire(fireInput(budget(), { n: 2, stagger: false }));
    const first = await drain(src);
    expect(first.flatMap((a) => a.candidates)).toHaveLength(2);
    expect(gen.calls()).toBe(2);
    const b2 = budget();
    const again = src.fire(fireInput(b2, { n: 2, stagger: false }));
    expect(again).toMatchObject({ fired: false, reason: 'cached', cached: 2 });
    const replay = await drain(src);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ sample: -1, status: 'cached', usd: 0 });
    expect(replay[0]!.candidates.map((c) => c.text)).toEqual(['    return (a or 0) + b', '    return b if a is None else a + b']);
    expect(gen.calls()).toBe(2);
    expect(b2).toEqual(budget());
    // one of them already tried → the cache falls short of N: replay what is left and generate again
    const tried = new Set([first[0]!.candidates[0]!.id.slice('llm:'.length)]);
    const third = src.fire(fireInput(budget(), { n: 2, stagger: false, tried }));
    expect(third).toMatchObject({ fired: true, samples: 2, cached: 1 });
    const arrivals = await drain(src);
    expect(arrivals.find((a) => a.status === 'cached')!.dropped.map((d) => d.reason)).toEqual(['tried']);
    expect(gen.calls()).toBe(4);
    const exported = src.exportCache() as Record<string, { round: number; sha12: string[] }>;
    expect(exported['g1']!.sha12).toHaveLength(2);
  });

  it('refuses a round without budget and honours the schedule constants', () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]) }));
    const src = createLlmSource({ generate: gen.generate });
    expect(src.fire(fireInput(budget({ roundsLeft: 0 })))).toMatchObject({ fired: false, reason: 'no_rounds' });
    expect(src.fire(fireInput(budget({ usdLeft: 0 })))).toMatchObject({ fired: false, reason: 'no_usd' });
    expect(gen.calls()).toBe(0);
    expect([samplesFor('quixbugs'), samplesFor('ladder'), samplesFor('repository', 500), samplesFor('repository', 5000)]).toEqual([4, 3, 6, 4]);
    expect([sampleDeadlineMs('quixbugs', null), sampleDeadlineMs('quixbugs', 3000), sampleDeadlineMs('quixbugs', 9000), sampleDeadlineMs('ladder', null, 12_000), sampleDeadlineMs('repository', 1000)]).toEqual([20_000, 10_000, 18_000, 12_000, 30_000]);
  });
});
