import { describe, expect, it } from 'vitest';
import { computeConditionMetrics, computeSuiteComparison, pairedTaskIds, solveCurve, tokensPerStepCurve, withPairComplete } from '../../../src/bench/metrics.js';
import { buildRecord, notRunRecord } from '../../../src/bench/runner.js';
import type { BenchTaskRecord, EngineMode } from '../../../src/core/types.js';
import { fakeRunResult, syntheticSource } from './helpers.js';

function rec(task: string, condition: EngineMode, over: Partial<BenchTaskRecord> = {}): BenchTaskRecord {
  const base = buildRecord({
    source: syntheticSource({ id: task }),
    condition,
    result: fakeRunResult({ runId: `r-${task}-${condition}`, mode: condition, steps: 4, tokensPerStep: [10, 20, 30, 40], jevLatencyMs: condition === 'jev-on' ? [100, 200, 300, 400] : [], counters: { blocked: 1, reviews: 2, declined: 2, failed: 0, loops: 1, replans: 0, reads: 3 }, jevQuestions: 7 }),
    evaluation: { pass: true, evaluator: 'mock' },
    patch: { modelPatch: 'd', patchBytes: 1, patchEmpty: false },
    capFired: null,
  });
  return { ...base, ...over };
}

describe('per-record formulas', () => {
  it('copies RunResult fields; blocked = block + declined; p50/p95 nearest-rank; null percentiles when empty', () => {
    const on = rec('a', 'jev-on');
    expect(on.blocked).toBe(3);
    expect(on.reviews).toBe(2);
    expect(on.declined).toBe(2);
    expect(on.jevLatencyMs).toEqual({ raw: [100, 200, 300, 400], p50: 200, p95: 400 });
    expect(on.jevRequests).toBe(0);
    expect(on.jevQuestions).toBe(7);
    expect(on.tokensPerStep).toEqual([10, 20, 30, 40]);
    const off = rec('a', 'jev-off');
    expect(off.jevLatencyMs).toEqual({ raw: [], p50: null, p95: null });
    expect(off.cost.jev).toBe(0);
  });
});

describe('aggregation', () => {
  const records: BenchTaskRecord[] = [
    rec('a', 'jev-on', { steps: 2, tokensPerStep: [10, 20] }),
    rec('b', 'jev-on', { steps: 5, tokensPerStep: [10, 20, 30, 40, 50] }),
    rec('c', 'jev-on', { pass: false, steps: 6, tokensPerStep: [1, 1, 1, 1, 1, 1], stopReason: 'max_steps' }),
    rec('d', 'jev-on', { pass: null, evaluator: 'invalid', reason: 'tests timed out', steps: 3 }),
    rec('e', 'jev-on', { pass: null, evaluator: 'none', reason: 'unsupported-locally', steps: 1 }),
    notRunRecord(syntheticSource({ id: 'f' }), 'jev-on', 'bench_spend_cap'),
    rec('a', 'jev-off', { steps: 3, tokensPerStep: [5, 5, 5] }),
    rec('b', 'jev-off', { pass: false, steps: 4, stopReason: 'generator_done' }),
    rec('c', 'jev-off', { steps: 2, modelDrift: false }),
  ];

  it('evaluated set, pass rate passed/evaluated (n), not_run and unsupported excluded from denominators', () => {
    const m = computeConditionMetrics(records, 'jev-on', 6);
    expect(m.tasks).toBe(6);
    expect(m.evaluated).toBe(3);
    expect(m.passed).toBe(2);
    expect(m.passRate).toBeCloseTo(2 / 3);
    expect(m.passRateText).toBe('2/3 (n=3)');
    expect(m.unevaluated).toEqual(['d']);
    expect(m.unsupported).toEqual(['e']);
    expect(m.notRun).toEqual(['f']);
  });

  it('steps-to-solve over passed only; steps used over all runs; stop-reason histogram', () => {
    const m = computeConditionMetrics(records, 'jev-on', 6);
    expect(m.stepsToSolve).toEqual({ n: 2, mean: 3.5, median: 2, values: [2, 5] });
    expect(m.stepsUsed.n).toBe(5);
    expect(m.stepsUsed.mean).toBeCloseTo((2 + 5 + 6 + 3 + 1) / 5);
    expect(m.stopReasons).toEqual({ complete: 4, max_steps: 1, not_run: 1 });
  });

  it('censored solve curve: failed and budget-stopped runs never solve', () => {
    const curve = solveCurve(records.filter((r) => r.condition === 'jev-on'), 6);
    expect(curve.map((p) => p.solved)).toEqual([0, 1, 1, 1, 2, 2]);
    expect(curve[5]!.fraction).toBeCloseTo(2 / 3);
    expect(solveCurve([], 3).every((p) => p.fraction === null)).toBe(true);
  });

  it('tokens-per-step curve reports mean (n) per index, runs only contribute to steps they reached', () => {
    const curve = tokensPerStepCurve(records.filter((r) => r.condition === 'jev-on' && r.stopReason !== 'not_run'));
    expect(curve[0]).toEqual({ step: 1, mean: (10 + 10 + 1 + 10 + 10) / 5, n: 5 });
    expect(curve[5]).toEqual({ step: 6, mean: 1, n: 1 });
    const m = computeConditionMetrics(records, 'jev-on', 6);
    expect(m.meanTokensPerStep.steps).toBe(2 + 5 + 6 + 4 + 4);
  });

  it('null percentiles and zero jev cost for jev-off; sums of blocked/reviews/declined/reads', () => {
    const m = computeConditionMetrics(records, 'jev-off', 6);
    expect(m.jevLatencyMs).toEqual({ p50: null, p95: null, n: 0 });
    expect(m.cost.jev).toBe(0);
    expect(m.blocked).toBe(9);
    expect(m.reviews).toBe(6);
    expect(m.declined).toBe(6);
    expect(m.reads).toEqual({ total: 9, meanPerRun: 3 });
    const on = computeConditionMetrics(records, 'jev-on', 6);
    expect(on.jevLatencyMs.n).toBe(4 * 5);
    expect(on.jevLatencyMs.p50).toBe(200);
  });

  it('paired set = evaluated in every condition, modelDrift excluded, incomplete listed', () => {
    const withDrift = records.map((r) => (r.task === 'c' && r.condition === 'jev-on' ? { ...r, modelDrift: true } : r));
    const p = pairedTaskIds(withDrift, ['jev-on', 'jev-off']);
    expect(p.paired).toEqual(['a', 'b']);
    expect(p.drift).toEqual(['c']);
    expect(p.incomplete).toEqual(['d', 'e', 'f']);
    const cmp = computeSuiteComparison(withDrift, 'swebench', ['jev-on', 'jev-off'], 6);
    expect(cmp.pairedTasks).toEqual(['a', 'b']);
    expect(cmp.perCondition['jev-on']!.passRateText).toBe('2/2 (n=2)');
    expect(cmp.perCondition['jev-off']!.passRateText).toBe('1/2 (n=2)');
    expect(cmp.rows.map((r) => r.task)).toEqual(['a', 'b']);
  });

  it('pairComplete is true only when every condition ran', () => {
    const out = withPairComplete(records, ['jev-on', 'jev-off']);
    const by = (t: string, c: EngineMode) => out.find((r) => r.task === t && r.condition === c)!.pairComplete;
    expect(by('a', 'jev-on')).toBe(true);
    expect(by('d', 'jev-on')).toBe(false);
    expect(by('f', 'jev-on')).toBe(false);
  });
});
