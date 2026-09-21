/** The LLM counters of the StepBudget (docs/LLM-JEV-DESIGN.md §4.6, §4.11): `freshBudget` fills them from the class and the spend, `decideLlmN` sizes a round, `llmClassOf` names the class; they never end a step. */
import { describe, expect, it } from 'vitest';

import { LLM_ROUNDS_PER_STEP, LLM_STEP_USD_MAX, decideLlmN, freshBudget, llmClassOf, llmStepUsd } from '../../../../src/synth/search/budget.js';
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
