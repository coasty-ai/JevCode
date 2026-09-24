/**
 * contract 1.9 (Fastlane) §3.4 — the reasoning cap and the cache accounting
 * (docs/LLM-LOOP-DESIGN.md §3.4: "`reasoning: {maxTokens: 256}` on the cheap classes only.
 * `cached_tokens` (already parsed) surfaces as `cacheRead` / `cacheWrite` / `cacheHitRate`").
 *
 * The two halves are the same measurement seen from both ends. §3.3 pins the prompt prefix so the
 * provider's cache can hit; without `cacheRead` on the round summary nothing in the harness could say
 * whether it did — `TokenUsage.inputTokens` is the full context and hides the split (`toTokenUsage`
 * folds cache reads into it), which is why the two counters are surfaced separately rather than derived.
 *
 * And the cap: on QuixBugs and ladder the fix is a few lines inside a function the prompt already names,
 * so the thinking budget buys nothing, while GLM bills it and — the recorded harm — WAITS for it
 * (§4.13, and the 135 zero-token timeouts of §4.8 rev 4). The existing cap is reactive: it only arrives
 * after the served p90 has already passed the class deadline. §3.4 makes it a standing judgement about
 * the cheap classes, and leaves the repository class, where the shape is not that, alone.
 */
import { describe, expect, it } from 'vitest';

import type { GenerateRequest, GenerateResult, TokenUsage } from '../../../../../src/core/types.js';
import {
  LLM_REASONING_CAP_CHEAP_TOKENS,
  LLM_REASONING_CAP_TOKENS,
  createLlmSource,
  type LlmBudget,
  type LlmFireInput,
  type LlmSource,
} from '../../../../../src/jev-modes/synth/llm/source.js';
import { listingSet } from '../../../../../src/jev-modes/synth/llm/prompt.js';
import type { GenerateFn } from '../../../../../src/jev-modes/synth/llm/types.js';
import { calcFiles, proposeFixCall } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 6, samplesLeft: 12, usdLeft: 1, ...over };
}

function fireInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: 'sys', userFor: (k) => `user ${k}`, files, listings, signal: new AbortController().signal, budget: b, deadlineMs: 30_000, stagger: false, n: 1, ...over };
}

/** A generate that answers at once with a `propose_fix` and the usage the test pins (the provider's own cache figures). */
function answering(usageFor: (sample: number) => TokenUsage): { generate: GenerateFn; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  const generate: GenerateFn = (req, o) => {
    requests.push(req);
    const result: GenerateResult = { text: '', toolCalls: [proposeFixCall([FIX])], usage: usageFor(o.sample), model: 'z-ai/glm-5.3-flash', stopReason: 'tool_calls', latencyMs: 12 };
    return Promise.resolve(result);
  };
  return { generate, requests };
}

const plainUsage = (): TokenUsage => ({ inputTokens: 1_000, outputTokens: 100, costUsd: 0.001, calls: 1 });

async function drain(src: LlmSource): Promise<void> {
  await src.collectAll();
}

describe('§3.4 the cheap-class reasoning cap', () => {
  it('is off by default: a quixbugs round still asks for the pinned `{effort: low}`', async () => {
    const a = answering(plainUsage);
    const src = createLlmSource({ generate: a.generate, pricing: PRICING, env: {} });
    src.fire(fireInput(budget()));
    await drain(src);
    expect(a.requests[0]!.reasoning).toEqual({ effort: 'low' });
    expect(src.reasoningCapTokens()).toBeNull();
  });

  it('caps the CHEAP classes at 256 from the first round when armed, and leaves the repository class alone', async () => {
    expect(LLM_REASONING_CAP_CHEAP_TOKENS).toBe(256);
    for (const klass of ['quixbugs', 'ladder'] as const) {
      const a = answering(plainUsage);
      const src = createLlmSource({ generate: a.generate, pricing: PRICING, env: {}, reasoningCapCheap: true });
      src.fire(fireInput(budget(), { klass }));
      await drain(src);
      expect(a.requests[0]!.reasoning).toEqual({ maxTokens: LLM_REASONING_CAP_CHEAP_TOKENS });
    }
    const repo = answering(plainUsage);
    const src = createLlmSource({ generate: repo.generate, pricing: PRICING, env: {}, reasoningCapCheap: true });
    src.fire(fireInput(budget(), { klass: 'repository' }));
    await drain(src);
    // a repository fix is not "a few lines in a named function": its thinking budget is left where it was
    expect(repo.requests[0]!.reasoning).toEqual({ effort: 'low' });
  });

  it('never RAISES what the reactive cap already lowered: the two compose by taking the smaller', () => {
    expect(Math.min(LLM_REASONING_CAP_TOKENS, LLM_REASONING_CAP_CHEAP_TOKENS)).toBe(LLM_REASONING_CAP_CHEAP_TOKENS);
    expect(LLM_REASONING_CAP_CHEAP_TOKENS).toBeLessThan(LLM_REASONING_CAP_TOKENS);
  });

  it('does not send `{maxTokens}` when the caller turned reasoning off — that would turn it back on', async () => {
    const a = answering(plainUsage);
    const src = createLlmSource({
      generate: a.generate,
      pricing: PRICING,
      env: {},
      reasoningCapCheap: true,
      generation: { reasoning: { enabled: false }, maxTokens: 1500, sampleDeadline: { minMs: 10_000, maxMs: 20_000, repositoryMs: 30_000 }, sampleTemperature: { first: 0, rest: 0.8, feedbackFirst: 0.6, feedbackRest: 1 } },
    });
    src.fire(fireInput(budget()));
    await drain(src);
    expect(a.requests[0]!.reasoning).toEqual({ enabled: false });
  });
});

describe('§3.4 the cache accounting on the round summary', () => {
  it('sums the provider’s own cache reads and writes and reports the hit rate over the round’s input tokens', async () => {
    const a = answering((k) => ({ inputTokens: 1_000, outputTokens: 100, costUsd: 0.001, calls: 1, ...(k === 0 ? { cacheWriteTokens: 800 } : { cacheReadTokens: 800 }) }));
    const src = createLlmSource({ generate: a.generate, pricing: PRICING, env: {} });
    src.fire(fireInput(budget(), { n: 3, stagger: false }));
    await drain(src);
    const round = src.round()!;
    // sample 0 wrote the prefix into the cache; samples 1 and 2 read it back — the §3.3 pinning, measured
    expect(round.cacheWrite).toBe(800);
    expect(round.cacheRead).toBe(1_600);
    expect(round.cacheHitRate).toBeCloseTo(1_600 / 3_000, 10);
  });

  it('reports NOTHING rather than a zero when the provider caches nothing, so a miss and an absence never read alike', async () => {
    const a = answering(plainUsage);
    const src = createLlmSource({ generate: a.generate, pricing: PRICING, env: {} });
    src.fire(fireInput(budget()));
    await drain(src);
    const round = src.round()!;
    expect(round.cacheRead).toBeUndefined();
    expect(round.cacheWrite).toBeUndefined();
    expect(round.cacheHitRate).toBeUndefined();
  });
});
