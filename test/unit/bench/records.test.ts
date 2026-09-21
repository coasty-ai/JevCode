/**
 * The per-run facts the runner reads from the run directory after the engine stopped (docs/LLM-JEV-DESIGN.md §10.4):
 * generator.jsonl → calls, the §1.2 "valid" definition, dropped samples and their estimated $, latency quantiles and the
 * a + b × output_tokens fit; steps.jsonl → synthMs, the verify counts, generic steps. Both tolerate torn lines and rows
 * written by older engines.
 */
import { describe, expect, it } from 'vitest';
import { isValidCall, latencyFit, mergeGeneratorSummaries, parseGeneratorRecords, summariseGeneratorRecords } from '../../../src/bench/generator-records.js';
import { mergeStepsSummaries, summariseStepRows } from '../../../src/bench/step-records.js';

const row = (over: Record<string, unknown>): string =>
  JSON.stringify({ step: 1, attempt: 1, promptHash: 'p', model: 'glm', temperature: null, maxTokens: 3000, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0002, calls: 1 }, latencyMs: 2000, stopReason: 'tool_calls', malformed: false, ...over });

describe('generator.jsonl summary', () => {
  it('counts calls, samples, valid / malformed / length / dropped, tokens, $ and estimated $, with exact quantiles', () => {
    const text = [
      row({ latencyMs: 1000, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0002, calls: 1 } }),
      row({ sample: 0, latencyMs: 2000, usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0003, calls: 1, reasoningTokens: 50 } }),
      row({ sample: 1, latencyMs: 3000, malformed: true }),
      row({ sample: 2, latencyMs: 4000, stopReason: 'length' }),
      row({ sample: 3, latencyMs: 5000, stopReason: 'timeout', cancelled: true, usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0.0001, calls: 1, estimated: true } }),
      '{"torn": ',
    ].join('\n');
    const rows = parseGeneratorRecords(text);
    expect(rows).toHaveLength(5);
    expect(rows.map(isValidCall)).toEqual([true, true, false, false, false]);
    const s = summariseGeneratorRecords(rows);
    expect(s).toMatchObject({ calls: 5, samples: 4, valid: 2, malformed: 1, lengthStops: 1, cancelled: 1, timeouts: 1, inputTokens: 5000, outputTokens: 550, reasoningTokens: 50 });
    expect(s.costUsd).toBeCloseTo(0.001, 9);
    expect(s.estimatedUsd).toBeCloseTo(0.0001, 9);
    expect(s.latencyMs).toEqual({ n: 5, p50: 3000, p90: 5000, max: 5000 });
    expect(s.validLatencyMs).toEqual({ n: 2, p50: 1000, p90: 2000, max: 2000 });
    const merged = mergeGeneratorSummaries([s, s]);
    expect(merged.calls).toBe(10);
    expect(merged.latencyMs.p50).toBe(3000);
    expect(merged.validLatencyRawMs).toEqual([1000, 2000, 1000, 2000]);
    // a dropped call is booked once, as dropped: a `malformed` mark on a timeout row (written before the propose stage stopped retrying drops) is not a malformed reply
    const dropped = parseGeneratorRecords([row({ stopReason: 'timeout', malformed: true, usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0.0001, calls: 1, estimated: true } }), row({ malformed: true })].join('\n'));
    expect(summariseGeneratorRecords(dropped)).toMatchObject({ calls: 2, valid: 0, malformed: 1, cancelled: 1, timeouts: 1 });
  });

  it('fits latency = a + b × output tokens over valid calls (reasoning tokens included in the length)', () => {
    const rows = parseGeneratorRecords([row({ latencyMs: 1000, usage: { inputTokens: 1, outputTokens: 100, costUsd: 0, calls: 1 } }), row({ latencyMs: 2000, usage: { inputTokens: 1, outputTokens: 200, costUsd: 0, calls: 1 } }), row({ latencyMs: 3000, usage: { inputTokens: 1, outputTokens: 200, costUsd: 0, calls: 1, reasoningTokens: 100 } }), row({ latencyMs: 99_999, malformed: true })].join('\n'));
    const fit = latencyFit(rows)!;
    expect(fit.n).toBe(3);
    expect(fit.a).toBeCloseTo(0, 6);
    expect(fit.b).toBeCloseTo(10, 6);
    expect(latencyFit(rows.slice(0, 1))).toBeNull();
  });
});

describe('steps.jsonl summary', () => {
  it('sums synthMs, the verify counts and the generic steps; older rows contribute a step and nothing else', () => {
    const text = [
      JSON.stringify({ step: 1, timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1 } }),
      JSON.stringify({ step: 2, proposer: 'synth', timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1, synthMs: 4000 }, verify: { samples: 4, distinct: 3, malformed: 1, timeouts: 0, cancelled: 2, misanchored: 1, candidatesTested: 9, passers: 1, partials: 0, graceMs: 500, localisationMissed: true } }),
      JSON.stringify({ step: 3, proposer: 'generic', timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1 } }),
      'not json',
    ].join('\n');
    const s = summariseStepRows(text);
    expect(s).toEqual({ steps: 3, synthSteps: 1, synthMs: 4000, genericSteps: 1, verify: { samples: 4, distinct: 3, malformed: 1, timeouts: 0, cancelled: 2, misanchored: 1, candidatesTested: 9, passers: 1, partials: 0, graceMs: 500, localisationMissed: 1 } });
    expect(mergeStepsSummaries([s, s]).verify.candidatesTested).toBe(18);
    expect(mergeStepsSummaries([]).steps).toBe(0);
  });
});
