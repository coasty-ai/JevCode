import { describe, expect, it } from 'vitest';

import type { CompileCheck } from '../../../../src/synth/llm/candidates.js';
import type { SynthesizerGeneration } from '../../../../src/core/types.js';
import type { CancelledGeneration, GenerateResult } from '../../../../src/core/types.js';
import { ProviderHttpError } from '../../../../src/errors.js';
import { LLM_CACHE_PERSIST_BYTES, LLM_DEADLINE_ADAPT, LLM_DEFAULT_GENERATION, LLM_MAX_TOKENS, LLM_MAX_TOKENS_REASONING, LLM_REASONING_CAP_TOKENS, UNFINISHED_REASONING_ALLOWANCE_TOKENS, affordableSamples, classDeadlineMs, coversSample, createLlmSource, deadlineCeilingMs, endedRateLimited, estimatedSampleUsage, maxTokensBase, providerSlow, rateLimitedUsage, sampleDeadlineMs, samplesFor, unfinishedSampleUsage, unservedRateLimited, type LlmBudget, type LlmFireInput, type LlmSource, type SampleArrival } from '../../../../src/synth/llm/source.js';
import { reasoningEnabled, type GenerateFn } from '../../../../src/synth/llm/types.js';
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

  it('holds every sample\'s full estimate from fire to settle, fires only what the dollar counter covers beyond the holds, and charges the counter at settle for the price alone', async () => {
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
    // in flight the counter itself is untouched — the hold is the source's own ledger — and, read against the hold, it has no headroom
    // for another sample (what an L1′ or another goal asking the source would be told)
    expect(b.usdLeft).toBeCloseTo(2 * RESERVATION + 0.001, 12);
    expect(b.samplesLeft).toBe(6);
    expect(src.round()!.reservedUsd).toBeCloseTo(2 * RESERVATION, 9);
    expect(coversSample(b.usdLeft - src.round()!.reservedUsd!, RESERVATION)).toBe(false);
    expect(events.some((e) => e.startsWith('llm:fire') && e.includes('2/4 samples fired') && e.includes('reserved'))).toBe(true);
    await drain(src);
    // settled: each sample cost its price and nothing else moved on the counter; the holds are gone
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

  it('the hold is never a debit: a step budget re-installed mid-round (a live view, the repository step-1 overlap) is charged the prices alone at settle, the holds stand against whichever counter is live, and a draining round\'s holds refuse a new round the counter cannot cover beyond them', async () => {
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), latencyMs: 30, usage: { inputTokens: 4000, outputTokens: 300 } }));
    let settled = 0;
    let bothSettled!: () => void;
    const settledTwice = new Promise<void>((resolve) => {
      bothSettled = resolve;
    });
    const src = createLlmSource({
      generate: gen.generate,
      pricing: PRICING,
      onSample: () => {
        settled += 1;
        if (settled === 2) bothSettled();
      },
    });
    const first = budget({ usdLeft: 2 * RESERVATION + 0.001 });
    let installed = first;
    // the adapter's budget view: every read and write goes to the step budget installed now
    const view: LlmBudget = {
      get roundsLeft() {
        return installed.roundsLeft;
      },
      set roundsLeft(v: number) {
        installed.roundsLeft = v;
      },
      get samplesLeft() {
        return installed.samplesLeft;
      },
      set samplesLeft(v: number) {
        installed.samplesLeft = v;
      },
      get usdLeft() {
        return installed.usdLeft;
      },
      set usdLeft(v: number) {
        installed.usdLeft = v;
      },
    };
    expect(src.fire(fireInput(view, { n: 4, stagger: false }))).toMatchObject({ fired: true, samples: 2 });
    // in flight: the round and sample counters were taken on the first budget, the dollar counter was not touched
    expect(first.roundsLeft).toBe(1);
    expect(first.samplesLeft).toBe(6);
    expect(first.usdLeft).toBeCloseTo(2 * RESERVATION + 0.001, 12);
    // a re-baseline installs a fresh step budget while the samples are in flight: the two holds now stand against it, so a round for
    // another goal is refused (it cannot cover a sample beyond them) and the refusal touches neither counter
    const fresh = budget({ usdLeft: 2 * RESERVATION + 0.001 });
    installed = fresh;
    expect(src.fire(fireInput(view, { goalId: 'g2', n: 1, stagger: false }))).toMatchObject({ fired: false, reason: 'no_usd' });
    expect(gen.calls()).toBe(2);
    expect(fresh.roundsLeft).toBe(2);
    expect(fresh.usdLeft).toBeCloseTo(2 * RESERVATION + 0.001, 12);
    await settledTwice;
    // settled: the prices landed on the fresh counter (live at settle), the first budget is whole — no reservation was ever debited
    // from one budget and credited to another
    const priced = (4000 * 0.5 + 300 * 2) / 1e6;
    expect(first.usdLeft).toBeCloseTo(2 * RESERVATION + 0.001, 12);
    expect(fresh.usdLeft).toBeCloseTo(2 * RESERVATION + 0.001 - 2 * priced, 9);
    // the holds are released with the round: the fresh counter now covers one sample of the next round
    expect(affordableSamples(fresh.usdLeft, RESERVATION)).toBe(1);
    expect(src.fire(fireInput(view, { goalId: 'g3', n: 4, stagger: false }))).toMatchObject({ fired: true, samples: 1 });
    await drain(src);
    expect(gen.calls()).toBe(3);
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
    // §4.8 rev 3: the class default is the FLOOR, the served p90 only lifts it (× factor), the ceiling is 45 s / 90 s
    expect([
      sampleDeadlineMs('quixbugs', { p90ServedMs: null }),
      sampleDeadlineMs('quixbugs', { p90ServedMs: 3000 }),
      sampleDeadlineMs('quixbugs', { p90ServedMs: 14_400 }),
      sampleDeadlineMs('quixbugs', { p90ServedMs: 40_000 }),
      sampleDeadlineMs('ladder', { p90ServedMs: null, probeP90Ms: 12_000 }),
      sampleDeadlineMs('ladder', { p90ServedMs: null, probeP90Ms: 32_000 }),
      sampleDeadlineMs('repository', { p90ServedMs: 1000 }),
      sampleDeadlineMs('repository', { p90ServedMs: 29_300 }),
      sampleDeadlineMs('repository', { p90ServedMs: 80_000 }),
    ]).toEqual([20_000, 20_000, 28_800, 45_000, 20_000, 32_000, 30_000, 58_600, 90_000]);
    expect([classDeadlineMs('quixbugs'), classDeadlineMs('ladder'), classDeadlineMs('repository'), deadlineCeilingMs('quixbugs'), deadlineCeilingMs('repository')]).toEqual([20_000, 20_000, 30_000, 45_000, 90_000]);
    // "the serving provider is slow" = its served p90 is past the class default the deadline started from
    expect([providerSlow('quixbugs', null), providerSlow('quixbugs', 14_400), providerSlow('quixbugs', 22_000), providerSlow('repository', 22_000), providerSlow('repository', 31_000)]).toEqual([false, false, true, false, true]);
  });
});

describe('rate-limited samples and rounds (core/types.ts CancelledGeneration.rateLimited, §4.13)', () => {
  const rateLimit = (): ProviderHttpError => new ProviderHttpError('HTTP 429: rate limited', { status: 429, retryable: true });
  const refused: GenerateFn = () => Promise.reject(rateLimit());

  it('classifies an end: a 429 ProviderHttpError (the chain gave up) or the provider\'s onCancelled fact (aborted in a 429 backoff); a 5xx or a plain abort is not rate-limited', () => {
    const fact = { text: '', toolChars: 0, reasoningChars: 0, rateLimited: true as const };
    expect(endedRateLimited(rateLimit(), null)).toBe(true);
    expect(endedRateLimited(new Error('aborted during the backoff'), fact)).toBe(true);
    expect(endedRateLimited(new ProviderHttpError('HTTP 503', { status: 503, retryable: true }), null)).toBe(false);
    expect(endedRateLimited(new Error('cancelled'), { text: 'partial', toolChars: 12, reasoningChars: 0 })).toBe(false);
    expect(rateLimitedUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 });
    // unserved = a fired sample that settled without a result AND was rate-limited; a served result behind a retry and the cache replay are not
    expect(unservedRateLimited({ sample: 0, status: 'error', rateLimited: true })).toBe(true);
    expect(unservedRateLimited({ sample: 1, status: 'cancelled', rateLimited: true })).toBe(true);
    expect(unservedRateLimited({ sample: 0, status: 'valid', rateLimited: true })).toBe(false);
    expect(unservedRateLimited({ sample: 0, status: 'error', rateLimited: false })).toBe(false);
    expect(unservedRateLimited({ sample: -1, status: 'cached', rateLimited: false })).toBe(false);
  });

  it('a sample the rate limiter refused is booked at $0 with its hold released and flagged; a round of nothing but those is a rate-limited round — not an exhausted one', async () => {
    const events: string[] = [];
    const src = createLlmSource({ generate: refused, pricing: PRICING, emit: (phase, detail) => events.push(`${phase}: ${detail}`) });
    const b = budget();
    expect(src.fire(fireInput(b, { n: 2, stagger: false }))).toMatchObject({ fired: true, samples: 2 });
    // in flight: two holds stand, nothing is classified yet
    expect(src.round()).toMatchObject({ fired: 2, closed: false, rateLimited: 0, rateLimitedRound: false });
    expect(src.round()!.reservedUsd).toBeCloseTo(2 * RESERVATION, 12);
    const arrivals = await drain(src);
    expect(arrivals.map((a) => [a.sample, a.status, a.rateLimited, a.usd, a.estimated])).toEqual([
      [0, 'error', true, 0, false],
      [1, 'error', true, 0, false],
    ]);
    expect(arrivals[0]!.detail).toMatch(/^rate-limited \(HTTP 429\), nothing served: HTTP 429: rate limited$/);
    expect(arrivals[0]!.usage).toEqual(rateLimitedUsage());
    expect(src.round()).toMatchObject({ fired: 2, errors: 2, rateLimited: 2, rateLimitedRound: true, closed: true, usd: 0, estimatedUsd: 0, reservedUsd: 0, distinct: 0 });
    // the round and its samples were taken at fire (the controller refunds them off `rateLimitedRound`); the dollars never moved
    expect(b.roundsLeft).toBe(1);
    expect(b.samplesLeft).toBe(6);
    expect(b.usdLeft).toBe(0.02);
    expect(events.find((e) => e.startsWith('llm:round'))).toMatch(/2 rate-limited \(HTTP 429, nothing served\).*every fired sample was rate-limited — the round is not exhausted$/);
    // nothing was seen, so nothing is cached: the next fire under the same key generates again
    expect(src.exportCache()).toEqual({});
    expect(src.fire(fireInput(budget(), { n: 1, stagger: false }))).toMatchObject({ fired: true, samples: 1 });
    await drain(src);
  });

  it('the onCancelled fact marks a sample aborted in a 429 backoff; a result reached through a 429 retry carries the flag but counts as served, so the round is not rate-limited', async () => {
    const served = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    const gen: GenerateFn = async (req, o) => {
      if (o.sample === 0) {
        o.onCancelled?.({ text: '', toolChars: 0, reasoningChars: 0, rateLimited: true });
        throw new Error('the abort landed in the backoff');
      }
      return { ...(await served.generate(req, o)), rateLimited: true };
    };
    const src = createLlmSource({ generate: gen, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b, { n: 2, stagger: false }));
    const arrivals = await drain(src);
    expect(arrivals.map((a) => [a.sample, a.status, a.rateLimited])).toEqual([
      [0, 'error', true],
      [1, 'valid', true],
    ]);
    expect(arrivals[0]!.usd).toBe(0);
    expect(arrivals[1]!.usd).toBeCloseTo((4000 * 0.5 + 300 * 2) / 1e6, 12);
    expect(arrivals[1]!.candidates).toHaveLength(1);
    expect(src.round()).toMatchObject({ fired: 2, valid: 1, errors: 1, rateLimited: 1, rateLimitedRound: false, closed: true });
    expect(0.02 - b.usdLeft).toBeCloseTo((4000 * 0.5 + 300 * 2) / 1e6, 12);
  });

  it('a staggered round is classified only once it closed: sample 0 refused alone is not a rate-limited round until the released samples were refused too', async () => {
    const src = createLlmSource({ generate: refused, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b, { n: 2 }));
    expect(await src.collect()).toMatchObject({ sample: 0, status: 'error', rateLimited: true });
    expect(src.round()).toMatchObject({ fired: 1, rateLimited: 1, rateLimitedRound: false, closed: false });
    src.release();
    await drain(src);
    expect(src.round()).toMatchObject({ fired: 2, rateLimited: 2, rateLimitedRound: true, closed: true });
  });

  it('a 5xx the chain gave up on stays a plain error, booked from what its stream left (the reasoning allowance), never $0', async () => {
    const gen: GenerateFn = () => Promise.reject(new ProviderHttpError('HTTP 503', { status: 503, retryable: true }));
    const src = createLlmSource({ generate: gen, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b, { n: 1, stagger: false }));
    const [a] = await drain(src);
    expect(a).toMatchObject({ status: 'error', rateLimited: false, estimated: true });
    expect(a!.usd).toBeCloseTo(LOST(PROMPT_TOKENS), 12);
    expect(src.round()).toMatchObject({ errors: 1, rateLimited: 0, rateLimitedRound: false });
  });
});

describe('reasoningEnabled / maxTokensBase (§4.5): every reasoning variant but {enabled: false} asks for reasoning tokens', () => {
  it.each([
    ['unsent', undefined, false, LLM_MAX_TOKENS],
    ['{enabled: false}', { enabled: false as const }, false, LLM_MAX_TOKENS],
    ["{effort: 'low'}", { effort: 'low' as const }, true, LLM_MAX_TOKENS_REASONING],
    ['{maxTokens: 800}', { maxTokens: 800 }, true, LLM_MAX_TOKENS_REASONING],
  ])('%s → reasoningEnabled %s, base %d', (_label, reasoning, enabled, base) => {
    expect(reasoningEnabled(reasoning)).toBe(enabled);
    expect(maxTokensBase(reasoning)).toBe(base);
  });

  it('maxTokensBase(null) is the plain base; a fire input pinning {maxTokens} sends it verbatim with the reasoning-on base and books its unfinished samples with the allowance', async () => {
    expect(maxTokensBase(null)).toBe(LLM_MAX_TOKENS);
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    const src = createLlmSource({ generate: gen.generate, pricing: PRICING });
    expect(src.fire(fireInput(budget(), { n: 1, stagger: false, reasoning: { maxTokens: 800 } })).fired).toBe(true);
    expect(gen.requests().at(-1)).toMatchObject({ maxTokens: LLM_MAX_TOKENS_REASONING, reasoning: { maxTokens: 800 } });
    await drain(src);
    // the estimator agrees: a thinking budget is reasoning on, so a lost sample carries the allowance
    expect(unfinishedSampleUsage({ siblingInputTokens: 10, promptChars: 0, partial: null, reasoning: reasoningEnabled({ maxTokens: 800 }), pricing: PRICING }).outputTokens).toBe(UNFINISHED_REASONING_ALLOWANCE_TOKENS);
    expect(unfinishedSampleUsage({ siblingInputTokens: 10, promptChars: 0, partial: null, reasoning: reasoningEnabled({ enabled: false }), pricing: PRICING }).outputTokens).toBe(0);
  });
});

describe('§4.8 rev 3: the sample deadline adapts from the running p90 of served samples, and a slow serving provider caps the reasoning tokens', () => {
  /** the fire input without a pinned deadline, so the source computes it */
  function adaptiveInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
    const input = fireInput(b, over);
    delete input.deadlineMs;
    return input;
  }

  /** A generate whose samples take a scripted latency on a fake clock (`deps.now`). */
  function timedGenerate(latencies: readonly number[]): { gen: ReturnType<typeof scriptedGenerate>; generate: GenerateFn; now: () => number } {
    const gen = scriptedGenerate((k) => ({ toolCall: proposeFixCall([k === 0 ? FIX_A : FIX_B]), usage: { inputTokens: 4000, outputTokens: 300 } }));
    let clock = 0;
    let served = 0;
    const generate: GenerateFn = async (req, o) => {
      const start = clock;
      const res = await gen.generate(req, o);
      clock = start + (latencies[served++] ?? 10_000);
      return res;
    };
    return { gen, generate, now: () => clock };
  }

  it('the first round takes the class default, later rounds `factor × p90` of what the provider served, clamped at the 45 s ceiling', async () => {
    // the QuixBugs numbers of the head-to-head: served p50 8 s / p90 14.4 s under a 20 s deadline that cut 61 % of the samples
    const { gen, generate, now } = timedGenerate([8000, 14_400, 26_000, 28_000]);
    const events: string[] = [];
    const src = createLlmSource({ generate, pricing: PRICING, now, emit: (phase, detail) => events.push(`${phase}: ${detail}`) });
    const b = budget({ roundsLeft: 3, samplesLeft: 9, usdLeft: 0.06 });

    const first = src.fire(adaptiveInput(b, { n: 2, stagger: false }));
    expect(first).toMatchObject({ fired: true, deadlineMs: classDeadlineMs('quixbugs') });
    expect(src.p90ServedMs()).toBeNull();
    await drain(src);
    // two served samples: the p90 is the 14.4 s one (nearest rank) and the next round's deadline is 2 × it
    expect(src.p90ServedMs()).toBe(14_400);
    expect(src.reasoningCapTokens()).toBeNull();

    const second = src.fire(adaptiveInput(b, { n: 2, stagger: false, round: 2 }));
    expect(second).toMatchObject({ fired: true, deadlineMs: LLM_DEADLINE_ADAPT.factor * 14_400 });
    expect(events.some((e) => e.startsWith('llm:fire') && e.includes('adapted from the served p90 14400 ms') && e.includes('the quixbugs default is 20000 ms'))).toBe(true);
    await drain(src);
    expect(src.p90ServedMs()).toBe(28_000);

    // 2 × 28 s is past the ceiling: the deadline stops at 45 s, and the provider is now slow by the class default
    const third = src.fire(adaptiveInput(b, { n: 1, stagger: false, round: 2, goalId: 'g2' }));
    expect(third).toMatchObject({ fired: true, deadlineMs: deadlineCeilingMs('quixbugs') });
    expect(providerSlow('quixbugs', src.p90ServedMs())).toBe(true);
    expect(src.reasoningCapTokens()).toBe(LLM_REASONING_CAP_TOKENS);
    // every sample from here asks for a bounded thinking budget instead of the pinned effort, with the reasoning-on max_tokens base
    expect(gen.requests().at(-1)).toMatchObject({ reasoning: { maxTokens: LLM_REASONING_CAP_TOKENS }, maxTokens: LLM_MAX_TOKENS_REASONING });
    expect(gen.requests().slice(0, 4).every((r) => r.reasoning !== undefined && 'effort' in r.reasoning)).toBe(true);
    expect(events.some((e) => e.startsWith('llm:deadline') && e.includes('the serving provider is slow (served p90 28000 ms > the quixbugs default deadline 20000 ms)') && e.includes(`caps reasoning at ${LLM_REASONING_CAP_TOKENS} tokens`))).toBe(true);
    await drain(src);
  });

  it('a timed-out, cancelled or rate-limited sample was never served: it does not move the p90, and the probe\'s p90 stands in until two samples are', async () => {
    // one sample that never returns (aborted by cancel) and one served at 30 s: only the served one counts
    let release: (() => void) | null = null;
    const hang: GenerateFn = (_req, o) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new Error('cancelled'));
        o.signal.addEventListener('abort', () => reject(new Error('cancelled')));
      });
    const src = createLlmSource({ generate: hang, pricing: PRICING, probeP90Ms: 26_000 });
    const b = budget({ roundsLeft: 3, samplesLeft: 9, usdLeft: 0.06 });
    // before any served sample the probe's p90 is the deadline (clamped into [class default, ceiling])
    expect(src.fire(adaptiveInput(b, { n: 1, stagger: false }))).toMatchObject({ deadlineMs: 26_000 });
    await src.cancel('commit');
    expect(release).not.toBeNull();
    expect(src.round()).toMatchObject({ cancelled: 1, valid: 0, closed: true });
    expect(src.p90ServedMs()).toBeNull();
    expect(src.fire(adaptiveInput(b, { n: 1, stagger: false, round: 2 }))).toMatchObject({ deadlineMs: 26_000 });
    await src.cancel('commit');
    // still nothing served: the deadline never moved off the probe's p90 and no cap was earned
    expect(src.p90ServedMs()).toBeNull();
    expect(src.reasoningCapTokens()).toBeNull();
  });

  it('a pin that turns reasoning off (or does not send it) is never capped: `{maxTokens}` would turn reasoning on and change the max_tokens base with it', async () => {
    const { gen, generate, now } = timedGenerate([26_000, 28_000]);
    const generation: SynthesizerGeneration = { ...LLM_DEFAULT_GENERATION, reasoning: { enabled: false }, maxTokens: LLM_MAX_TOKENS };
    const src = createLlmSource({ generate, pricing: PRICING, now, generation });
    const b = budget({ roundsLeft: 3, samplesLeft: 9, usdLeft: 0.06 });
    src.fire(adaptiveInput(b, { n: 2, stagger: false }));
    await drain(src);
    expect(src.p90ServedMs()).toBe(28_000);
    src.fire(adaptiveInput(b, { n: 1, stagger: false, round: 2 }));
    expect(src.reasoningCapTokens()).toBeNull();
    expect(gen.requests().at(-1)).toMatchObject({ reasoning: { enabled: false }, maxTokens: LLM_MAX_TOKENS });
    await drain(src);
  });
});
