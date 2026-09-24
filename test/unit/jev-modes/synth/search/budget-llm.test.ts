/**
 * The LLM counters of the StepBudget (docs/LLM-JEV-DESIGN.md §4.6, §4.11): `freshBudget` fills them from the class and the
 * spend, `decideLlmN` sizes a round, `llmClassOf` names the class; they never end a step. The hold of a round in flight
 * (`llmHoldOf`, `llmRoundAffordable`): the source reserves each fired sample's estimate and charges the counter at settle
 * alone, so the next round is gated on the counter less the hold, never on the counter as it reads.
 */
import { describe, expect, it } from 'vitest';

import type { LlmRoundSummary } from '../../../../../src/jev-modes/synth/llm/source.js';
import { LLM_ROUNDS_PER_STEP, LLM_STEP_USD_MAX, decideLlmN, freshBudget, llmClassOf, llmHoldOf, llmRoundAffordable, llmStepUsd, llmUsdHeadroom } from '../../../../../src/jev-modes/synth/search/budget.js';
import { fastOracle, slowOracle } from './controller-fakes.js';

const limits = { maxWallMs: 3_600_000 };

describe('freshBudget LLM counters', () => {
  it('without an LLM source every counter is 0 (jev-only)', () => {
    const b = freshBudget(limits, fastOracle(), 600_000);
    expect(b).toMatchObject({ llmRoundsLeft: 0, llmSamplesLeft: 0, llmUsdLeft: 0 });
    expect(b.exhausted()).toBe(false);
  });
  it('QuixBugs class: 2 rounds, N × 2 = 8 samples, min($0.02, (cap − spent) / stepsLeft) dollars', () => {
    const b = freshBudget(limits, fastOracle(), 600_000, { llm: { spendCapUsd: 1, spentUsd: 0, stepsLeft: 10, goals: 1, repository: false } });
    expect(b).toMatchObject({ llmRoundsLeft: LLM_ROUNDS_PER_STEP, llmSamplesLeft: 8, llmUsdLeft: LLM_STEP_USD_MAX });
    // the spend cap binds: $0.05 left over 5 steps is $0.01 a step
    expect(freshBudget(limits, fastOracle(), 600_000, { llm: { spendCapUsd: 0.09, spentUsd: 0.04, stepsLeft: 5, goals: 1, repository: false } }).llmUsdLeft).toBeCloseTo(0.01, 9);
    // the LLM counters never end a step
    expect(b.exhausted()).toBe(false);
  });
  it('ladder class (≥ 2 goals on a QuixBugs oracle): N = 3 → 6 samples; repository: N = 6 → 12, or 4 → 8 when the reproduction is slower than 2 s', () => {
    expect(freshBudget(limits, fastOracle(), 600_000, { llm: { spendCapUsd: 1, spentUsd: 0, stepsLeft: 10, goals: 3, repository: false } }).llmSamplesLeft).toBe(6);
    expect(freshBudget(limits, slowOracle(), 600_000, { llm: { spendCapUsd: 1, spentUsd: 0, stepsLeft: 10, goals: 1, repository: true, tReproMs: 1500 } }).llmSamplesLeft).toBe(12);
    expect(freshBudget(limits, slowOracle(), 600_000, { llm: { spendCapUsd: 1, spentUsd: 0, stepsLeft: 10, goals: 1, repository: true, tReproMs: 3000 } }).llmSamplesLeft).toBe(8);
  });
});

describe('llmClassOf, llmStepUsd, decideLlmN', () => {
  it('names the §4.6 class', () => {
    expect(llmClassOf(fastOracle(), 1, false)).toBe('quixbugs');
    expect(llmClassOf(fastOracle(), 2, false)).toBe('ladder');
    expect(llmClassOf(fastOracle(), 1, true)).toBe('repository');
    expect(llmClassOf(slowOracle(), 1, false)).toBe('repository');
  });
  it('the step dollar cap is never negative and never above $0.02', () => {
    expect(llmStepUsd({ spendCapUsd: 1, spentUsd: 0, stepsLeft: 1 })).toBe(LLM_STEP_USD_MAX);
    expect(llmStepUsd({ spendCapUsd: 0.01, spentUsd: 0.02, stepsLeft: 1 })).toBe(0);
    expect(llmStepUsd({ spendCapUsd: 0.05, spentUsd: 0.04, stepsLeft: 2 })).toBeCloseTo(0.005, 9);
  });
  it('N is the class\'s N bounded by the samples left, 0 once rounds or dollars are spent (§4.2 skip)', () => {
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 8, llmUsdLeft: 0.02 }, 'quixbugs')).toBe(4);
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 1, llmSamplesLeft: 3, llmUsdLeft: 0.02 }, 'quixbugs')).toBe(3);
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 8, llmUsdLeft: 0.02 }, 'ladder')).toBe(3);
    expect(decideLlmN(slowOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 12, llmUsdLeft: 0.02 }, 'repository', 1000)).toBe(6);
    expect(decideLlmN(slowOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 12, llmUsdLeft: 0.02 }, 'repository', 5000)).toBe(4);
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 0, llmSamplesLeft: 8, llmUsdLeft: 0.02 }, 'quixbugs')).toBe(0);
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 8, llmUsdLeft: 0 }, 'quixbugs')).toBe(0);
    expect(decideLlmN(fastOracle(), { llmRoundsLeft: 2, llmSamplesLeft: 0, llmUsdLeft: 0.02 }, 'quixbugs')).toBe(0);
  });
});

/** An open round's summary: `fired` samples, `landed` of them settled valid, each in flight holding `holdUsd`. */
function openRound(fired: number, landed: number, holdUsd: number, over: Partial<LlmRoundSummary> = {}): LlmRoundSummary {
  return { goalId: 'g1', round: 1, klass: 'quixbugs', n: fired, fired, valid: landed, empty: 0, malformed: 0, length: 0, timeouts: 0, cancelled: 0, errors: 0, misanchored: 0, syntaxErrors: 0, compileFailed: 0, duplicates: 0, tried: 0, distinct: landed, needs: 0, wallMs: 100, usd: landed * 0.004, estimatedUsd: 0, reservedUsd: (fired - landed) * holdUsd, deadlineMs: 20_000, closed: false, ...over };
}

describe('the hold of a round in flight (§4.11): llmHoldOf, llmUsdHeadroom, llmRoundAffordable, decideLlmN', () => {
  it('reads the hold and the per-sample estimate off an open round; nothing without a round or once it closed', () => {
    // 4 fired, 1 landed: 3 in flight holding $0.005 each
    expect(llmHoldOf(openRound(4, 1, 0.005))).toEqual({ reservedUsd: 0.015, perSampleUsd: 0.005 });
    // every settled status releases its hold: 4 fired, 1 valid + 1 timeout + 1 cancelled settled → 1 in flight
    expect(llmHoldOf(openRound(4, 1, 0.005, { timeouts: 1, cancelled: 1, reservedUsd: 0.005 }))).toEqual({ reservedUsd: 0.005, perSampleUsd: 0.005 });
    expect(llmHoldOf(null)).toEqual({ reservedUsd: 0, perSampleUsd: 0 });
    expect(llmHoldOf(undefined)).toEqual({ reservedUsd: 0, perSampleUsd: 0 });
    expect(llmHoldOf(openRound(4, 4, 0.005, { closed: true }))).toEqual({ reservedUsd: 0, perSampleUsd: 0 });
    // a hand-built summary without `reservedUsd` (test fakes) holds nothing
    const bare: LlmRoundSummary = openRound(4, 1, 0.005);
    delete bare.reservedUsd;
    expect(llmHoldOf(bare)).toEqual({ reservedUsd: 0, perSampleUsd: 0 });
  });
  it('the headroom is the counter less the hold; a round is affordable only when that covers one sample', () => {
    const budget = { llmRoundsLeft: 1, llmSamplesLeft: 4, llmUsdLeft: 0.02 };
    expect(llmUsdHeadroom(budget)).toBeCloseTo(0.02, 9);
    expect(llmUsdHeadroom(budget, { reservedUsd: 0.015 })).toBeCloseTo(0.005, 9);
    // no hold: the §4.2 rule as before — a positive counter, rounds and samples left
    expect(llmRoundAffordable(budget)).toBe(true);
    expect(llmRoundAffordable({ ...budget, llmUsdLeft: 0 })).toBe(false);
    expect(llmRoundAffordable({ ...budget, llmRoundsLeft: 0 })).toBe(false);
    expect(llmRoundAffordable({ ...budget, llmSamplesLeft: 0 })).toBe(false);
    // the whole counter held by the round in flight: the counter alone reads as $0.02 of headroom, less the hold it covers nothing
    expect(llmRoundAffordable(budget, { reservedUsd: 0.02, perSampleUsd: 0.005 })).toBe(false);
    expect(llmRoundAffordable(budget, llmHoldOf(openRound(4, 0, 0.005)))).toBe(false);
    // three quarters held: $0.005 left covers exactly one $0.005 sample (the 1e-9 tolerance of coversSample)
    expect(llmRoundAffordable(budget, llmHoldOf(openRound(4, 1, 0.005)))).toBe(true);
    // held beyond the counter (the step budget shrank under the round): never affordable
    expect(llmRoundAffordable({ ...budget, llmUsdLeft: 0.01 }, { reservedUsd: 0.015, perSampleUsd: 0.005 })).toBe(false);
    // a hold with no per-sample estimate: a positive headroom suffices, none does not
    expect(llmRoundAffordable(budget, { reservedUsd: 0.019 })).toBe(true);
    expect(llmRoundAffordable(budget, { reservedUsd: 0.02 })).toBe(false);
  });
  it('decideLlmN is 0 while the round in flight holds what the counter reads, and the class N once the hold leaves a sample', () => {
    const budget = { llmRoundsLeft: 1, llmSamplesLeft: 4, llmUsdLeft: 0.02 };
    expect(decideLlmN(fastOracle(), budget, 'quixbugs', null, llmHoldOf(openRound(4, 0, 0.005)))).toBe(0);
    expect(decideLlmN(fastOracle(), budget, 'quixbugs', null, llmHoldOf(openRound(4, 1, 0.005)))).toBe(4);
    // the default (no hold) is the counter as it reads
    expect(decideLlmN(fastOracle(), budget, 'quixbugs')).toBe(4);
  });
});
