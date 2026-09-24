/**
 * contract 1.9 (Fastlane) §3.4 — `TokenUsage.cacheReadTokens` / `cacheWriteTokens`
 * (docs/LLM-LOOP-DESIGN.md §3.4), and the records question they raise (review defect 9).
 *
 * The widening is DELIBERATE and ungated: every `generator.jsonl` `usage` object of a cache-serving provider
 * gains two members, in every mode (`view: 'legacy'`, `jev-on`, `jev-off`, `llm-jev`). §3.4 asks for the cache
 * figures on `StepVerifySummary`, and the only place the harness can learn them is the per-call usage the
 * provider reported — `LlmSource` sums them off the arrivals' `TokenUsage`, so a member carried no further
 * than the round summary would have no writer at all. What a flag COULD gate here is the record, not the
 * measurement, and a per-provider record shape that changes with a flag is worse than one that grows once.
 *
 * So the rule this file pins instead: the members appear only where the API itself reported cache (an
 * uncached call's usage object is byte for byte what it was), and no reader of the records rejects them — the
 * bench summariser and the checkpoint replay both read the rows duck-typed and must keep accepting the wider
 * shape, which is what makes the widening safe to ship without a flag.
 */
import { describe, expect, it } from 'vitest';

import type { Json } from '../../../src/core/types.js';
import { isGeneratorCallRecord, summariseGeneratorRecords } from '../../../src/bench/generator-records.js';
import { parseStepCache } from '../../../src/checkpoint/replay.js';
import { toTokenUsage } from '../../../src/provider/sse.js';

const uncached = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 200 };
const cached = { input: 100, cacheRead: 880, cacheWrite: 20, output: 200 };

function row(usage: Json): Json {
  return { step: 1, attempt: 1, promptHash: 'h1', model: 'z-ai/glm-5.3-flash', temperature: 0.7, maxTokens: 1_500, usage, latencyMs: 900, stopReason: 'tool_use', malformed: false };
}

describe('§3.4 the cache shares are set only where the API reported them', () => {
  it('an uncached call produces exactly the usage object it produced before 1.9', () => {
    expect(toTokenUsage(uncached, 0.004, null)).toEqual({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.004, calls: 1 });
  });

  it('a cache-serving call reports both shares, and `inputTokens` still contains them (the rate is well-formed)', () => {
    const usage = toTokenUsage(cached, 0.004, null);
    expect(usage).toEqual({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.004, calls: 1, cacheReadTokens: 880, cacheWriteTokens: 20 });
    expect((usage.cacheReadTokens ?? 0) / usage.inputTokens).toBeCloseTo(0.88, 12);
    expect((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)).toBeLessThanOrEqual(usage.inputTokens);
  });
});

describe('§3.4 no records reader rejects the widened rows (review defect 9)', () => {
  it('the bench reader accepts them and its sums are the sums it always made', () => {
    const wide = row(toTokenUsage(cached, 0.004, null) as unknown as Json);
    const narrow = row(toTokenUsage(uncached, 0.004, null) as unknown as Json);
    expect(isGeneratorCallRecord(wide)).toBe(true);
    expect(isGeneratorCallRecord(narrow)).toBe(true);
    const summary = summariseGeneratorRecords([wide, narrow].map((r) => r as never));
    expect(summary.calls).toBe(2);
    expect(summary.inputTokens).toBe(2_000);
    expect(summary.outputTokens).toBe(400);
    expect(summary.costUsd).toBeCloseTo(0.008, 12);
  });

  it('the checkpoint replay accepts a cached sample whose usage carries them', () => {
    const cache = {
      v: 1,
      step: 3,
      stage: 'propose',
      targets: [],
      patchTargets: [],
      risk: null,
      matchesIntent: null,
      proposer: null,
      contextFiles: [],
      directive: null,
      at: '2026-09-22T12:00:00.000Z',
      proposal: null,
      partial: null,
      intent: null,
      resumes: 0,
      llmRound: {
        goalId: 'g1',
        round: 0,
        arrived: [{ sample: 0, purpose: 'propose_fix', promptHash: 'h1', result: { text: '', toolCalls: [], usage: toTokenUsage(cached, 0.004, null) as unknown as Json, model: 'm', stopReason: 'tool_use', latencyMs: 900 } }],
      },
    };
    expect(parseStepCache(cache as unknown as Json)?.llmRound).toMatchObject({ goalId: 'g1', round: 0 });
  });
});
