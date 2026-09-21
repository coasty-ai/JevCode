/**
 * The llm-sieve stub decider (docs/LLM-JEV-DESIGN.md §10.1): deterministic inert answers, zero usage, counted requests,
 * a model id the drift check reads as its own.
 */
import { describe, expect, it } from 'vitest';
import { STUB_DECIDER_MODEL, STUB_NOUL, createStubDecider, stubAnswer } from '../../../src/bench/stub-decider.js';
import type { Question } from '../../../src/core/types.js';
import { normaliseModelId } from '../../../src/jev/client.js';
import { NOUL_ABSENT_THRESHOLD, noulsFlagAbsent } from '../../../src/synth/rank/index.js';
import { OVERRIDE_HIGH, OVERRIDE_LOW, SUSPECT_NOUL_MAX } from '../../../src/synth/search/guard.js';

const questions: Record<string, Question> = {
  fix: { type: 'choice', instructions: 'which candidate', criteria: { none_of_these: null, cand_01: 'a', cand_02: 'b' } },
  is_fix_a: { type: 'noul', instructions: 'is it a fix', criteria: { true: 'yes', false: 'no' } },
  destructive: { type: 'score', instructions: 'harm', criteria: ['none', 'low', 'high'] },
};

describe('stub decider (llm-sieve)', () => {
  it('answers first non-escape option / Noul 0.5 / level 0, costs nothing, counts, and never drifts', async () => {
    const d = createStubDecider();
    const signal = new AbortController().signal;
    const res = await d.ask({ state: 1 }, questions, { signal, stage: 'risk', step: 3 });
    expect(res.answers['fix']).toMatchObject({ type: 'choice', choice: 'cand_01', probabilities: { none_of_these: 0, cand_01: 1, cand_02: 0 } });
    expect(res.answers['is_fix_a']).toEqual({ type: 'noul', noul: STUB_NOUL });
    expect(res.answers['destructive']).toMatchObject({ type: 'score', score: 0 });
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
    expect(res.latencyMs).toBe(0);
    expect(res.model).toBe(STUB_DECIDER_MODEL);
    expect(normaliseModelId(res.model)).toBe(normaliseModelId(STUB_DECIDER_MODEL));
    expect(d.stubbed()).toEqual({ requests: 1, questions: 3, byStage: { risk: 1 }, byType: { noul: 1, choice: 1, score: 1 } });

    const again = await d.ask({ state: 1 }, questions, { signal, stage: 'propose', step: 4 });
    expect(again.answers).toEqual(res.answers);
    expect(again.requestHash).toBe(res.requestHash);
    expect(d.stubbed().byStage).toEqual({ risk: 1, propose: 1 });

    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(d.ask({}, questions, { signal: ac.signal, stage: 'risk', step: 1 })).rejects.toThrow('stop');
    expect(d.stubbed().requests).toBe(2);
  });

  it('a choice with only an escape option still answers it; the inert Noul sits between every cut the synthesizer uses', () => {
    expect(stubAnswer({ type: 'choice', instructions: 'x', criteria: { none_of_these: null } })).toMatchObject({ type: 'choice', choice: 'none_of_these' });
    expect(noulsFlagAbsent(STUB_NOUL)).toBe(false);
    expect(STUB_NOUL).toBe(NOUL_ABSENT_THRESHOLD);
    expect(STUB_NOUL).toBeGreaterThan(OVERRIDE_LOW);
    expect(STUB_NOUL).toBeLessThan(OVERRIDE_HIGH);
    expect(STUB_NOUL).toBeGreaterThan(SUSPECT_NOUL_MAX);
  });
});
