import { describe, expect, it } from 'vitest';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import {
  CALIBRATION_BINS,
  CALIBRATION_MAX_BYTES,
  CALIBRATION_MAX_RUNS,
  LABEL_SOURCE_TEXT,
  calibrationBlock,
  calibrationStats,
  extractDecision,
  extractStepFields,
  labelRun,
  nearThresholdCounts,
  type CalibrationRunInput,
  type StepLabelFields,
} from '../../../src/tui/calibration.js';

const step = (over: Partial<StepLabelFields> & { step: number }): StepLabelFields => ({ outcomeStatus: 'executed', execOk: true, judgeSucceeded: null, tests: null, riskVerdict: 'ok', riskDims: {}, completion: null, decisions: [], ...over });

describe('extraction of the ≤ 20 label fields', () => {
  it('reads a steps.jsonl row shape and tolerates missing branches', () => {
    const s = extractStepFields({
      step: 3,
      outcome: { status: 'executed', exec: { ok: false } },
      judge: { succeeded: 0.2, tests: { source: 'parsed', allPassed: false, passed: 3, failed: 1, errors: 0 } },
      risk: { verdict: 'review', dims: { destructive: { risk: 0.31 }, plan_mismatch: { risk: 'x' } } },
      completion: 0.4,
      decisions: [{ step: 3, stage: 'judge', id: 'succeeded', probability: 0.2 }, { bad: true }],
    });
    expect(s).toEqual({ step: 3, outcomeStatus: 'executed', execOk: false, judgeSucceeded: 0.2, tests: { source: 'parsed', allPassed: false, passed: 3, failed: 1, errors: 0 }, riskVerdict: 'review', riskDims: { destructive: 0.31 }, completion: 0.4, decisions: [{ step: 3, stage: 'judge', id: 'succeeded', probability: 0.2 }] });
    expect(extractStepFields({ step: 1 })).toMatchObject({ step: 1, outcomeStatus: null, execOk: null, tests: null, riskVerdict: null, decisions: [] });
    expect(extractStepFields({ step: 1, judge: { tests: { source: 'judged', allPassed: 0.7 } } })?.tests).toEqual({ source: 'judged', allPassed: 0.7 });
  });
  it('rejects garbage', () => {
    for (const v of [null, 1, 'x', [], {}, { step: 'a' }, { step: 1.5 }, { step: Number.NaN }]) expect(extractStepFields(v)).toBeNull();
    for (const v of [null, {}, { step: 1 }, { step: 1, id: 'x' }, { step: 1, id: 'x', probability: 'p' }]) expect(extractDecision(v)).toBeNull();
    expect(extractDecision({ step: 1, id: 'x', probability: 0.5 })).toEqual({ step: 1, stage: '', id: 'x', probability: 0.5 });
  });
});

describe('label sources (TUI-DESIGN §7.6)', () => {
  const run: CalibrationRunInput = {
    runId: 'r1',
    decisions: [
      { step: 1, stage: 'risk', id: 'plan_mismatch', probability: 0.6 },
      { step: 1, stage: 'risk', id: 'destructive', probability: 0.9 },
      { step: 2, stage: 'judge', id: 'done_0', probability: 0.8 },
      { step: 2, stage: 'judge', id: 'succeeded', probability: 0.7 },
      { step: 3, stage: 'judge', id: 'succeeded', probability: 0.3 },
      { step: 3, stage: 'complete', id: 'task_complete', probability: 0.9 },
      { step: 3, stage: 'judge', id: 'done_1', probability: 0.5 },
      { step: 1, stage: 'risk', id: 'matches_intent', probability: 0.9 },
    ],
    steps: [
      step({ step: 1, outcomeStatus: 'declined', riskVerdict: 'review', riskDims: { plan_mismatch: 0.44, destructive: 0.1 } }),
      step({ step: 2, execOk: true }),
      step({ step: 3, execOk: false, tests: { source: 'parsed', allPassed: true, passed: 5, failed: 0, errors: 0 } }),
    ],
    benchPass: true,
  };
  it('labels each source as the design names it', () => {
    const samples = labelRun(run);
    expect(samples).toEqual([
      { runId: 'r1', step: 1, id: 'plan_mismatch', p: 0.44, label: true, source: 'review' },
      { runId: 'r1', step: 1, id: 'destructive', p: 0.1, label: true, source: 'review' },
      { runId: 'r1', step: 2, id: 'done_0', p: 0.8, label: true, source: 'done' },
      { runId: 'r1', step: 2, id: 'succeeded', p: 0.7, label: true, source: 'succeeded' },
      { runId: 'r1', step: 3, id: 'succeeded', p: 0.3, label: true, source: 'succeeded' },
      { runId: 'r1', step: 3, id: 'task_complete', p: 0.9, label: true, source: 'complete' },
    ]);
  });
  it('skips what cannot be labelled: no later test run, no bench verdict, an ok verdict, a blocked step', () => {
    const noBench = labelRun({ ...run, benchPass: null });
    expect(noBench.some((s) => s.source === 'complete')).toBe(false);
    const okOnly = labelRun({ ...run, steps: [step({ step: 1, riskVerdict: 'ok', riskDims: { plan_mismatch: 0.1 } })] });
    expect(okOnly.some((s) => s.source === 'review')).toBe(false);
    const blocked = labelRun({ ...run, steps: [step({ step: 1, outcomeStatus: 'blocked', riskVerdict: 'review', riskDims: { plan_mismatch: 0.9 } })] });
    expect(blocked.some((s) => s.source === 'review')).toBe(false);
  });
  it('falls back to the steps’ decisions when decisions.jsonl is empty', () => {
    const r: CalibrationRunInput = { runId: 'r2', decisions: [], steps: [step({ step: 1, execOk: true, decisions: [{ step: 1, stage: 'judge', id: 'succeeded', probability: 0.9 }] })] };
    expect(labelRun(r)).toHaveLength(1);
    expect(calibrationStats([r]).decisions).toBe(1);
  });
});

describe('bins, ECE, near-threshold, sharpness', () => {
  it('computes ECE over 10 equal-width bins by hand-checkable arithmetic', () => {
    const r: CalibrationRunInput = {
      runId: 'r',
      decisions: [
        { step: 1, stage: 'judge', id: 'done_0', probability: 0.9 },
        { step: 1, stage: 'judge', id: 'succeeded', probability: 0.2 },
        { step: 1, stage: 'context', id: 'a.py', probability: 0.51 },
        { step: 1, stage: 'complete', id: 'task_complete', probability: 0.86 },
        { step: 1, stage: 'judge', id: 'done_1', probability: 0.71 },
      ],
      steps: [step({ step: 1, execOk: false, riskDims: {} }), step({ step: 2, tests: { source: 'parsed', allPassed: true, passed: 1, failed: 0, errors: 0 } })],
    };
    const s = calibrationStats([r]);
    expect(s.runs).toBe(1);
    expect(s.decisions).toBe(5);
    expect(s.labelled).toBe(3); // done_0 (later parsed pass), done_1, succeeded (exec.ok false)
    expect(s.bins.length).toBe(CALIBRATION_BINS);
    expect(s.bins[9]).toEqual({ lo: 0.9, hi: 1, n: 1, meanP: 0.9, observed: 1 });
    expect(s.bins[2]).toEqual({ lo: 0.2, hi: expect.closeTo(0.3, 9) as number, n: 1, meanP: 0.2, observed: 0 });
    expect(s.bins[7]).toEqual({ lo: 0.7, hi: 0.8, n: 1, meanP: 0.71, observed: 1 });
    // ECE = 1/3·|0.9−1| + 1/3·|0.2−0| + 1/3·|0.71−1|
    expect(s.ece).toBeCloseTo((0.1 + 0.2 + 0.29) / 3, 9);
    expect(s.near.byThreshold.map((t) => `${t.name}@${t.threshold}=${t.count}`)).toEqual(['risk@0.3=0', 'risk@0.7=0', 'complete@0.85=1', 'plan@0.7=1', 'context@0.5=1']);
    expect(s.near.total).toBe(3);
    expect(s.sharpness).toBeCloseTo(2 / 5, 9); // 0.9 and 0.86 are outside 0.2–0.8; 0.2 is inside (inclusive)
  });
  it('counts risk dimensions on their risk value from the step record', () => {
    const r: CalibrationRunInput = { runId: 'r', decisions: [{ step: 1, stage: 'risk', id: 'plan_mismatch', probability: 0.9 }, { step: 1, stage: 'risk', id: 'destructive', probability: 0.9 }], steps: [step({ step: 1, riskDims: { plan_mismatch: 0.31, destructive: 0.69 } })] };
    expect(nearThresholdCounts([r]).map((t) => t.count)).toEqual([1, 1, 0, 0, 0]);
    expect(nearThresholdCounts([r], 0.9)[2]!.threshold).toBe(0.9);
  });
  it('empty input yields nulls and a block that still renders', () => {
    const s = calibrationStats([]);
    expect(s).toMatchObject({ runs: 0, decisions: 0, labelled: 0, ece: null, sharpness: null });
    const block = calibrationBlock(s);
    expect(block[0]).toBe('calibration  0 runs  0 decisions  0 with a label');
    expect(block.find((l) => l.includes('ECE'))).toBe('  ECE — (no labels)   near-threshold (|p−t| ≤ 0.03): 0 (0%)');
    expect(block.at(-1)).toBe('  sharpness: — outside 0.2–0.8');
    expect(block.at(-1)!.codePointAt(block.at(-1)!.indexOf('0.2') + 3)).toBe(0x2013);
    expect(CALIBRATION_MAX_RUNS).toBe(50);
    expect(CALIBRATION_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('calibrationBlock (§7.6, §24 `[ui] calibration  N runs  N decisions  N with a label`)', () => {
  const r: CalibrationRunInput = {
    runId: 'r',
    decisions: [{ step: 1, stage: 'judge', id: 'done_0', probability: 0.9 }, { step: 1, stage: 'judge', id: 'succeeded', probability: 0.2 }],
    steps: [step({ step: 1, execOk: false }), step({ step: 2, tests: { source: 'parsed', allPassed: true, passed: 3, failed: 0, errors: 0 } })],
  };
  it('renders the head, the label sources, the bin table, ECE / near-threshold, the per-threshold counts and sharpness', () => {
    const block = calibrationBlock(calibrationStats([r]));
    expect(block[0]).toBe('calibration  1 runs  2 decisions  2 with a label');
    expect(block[1]).toBe(`  labels: ${LABEL_SOURCE_TEXT.review} 0 · ${LABEL_SOURCE_TEXT.done} 1`);
    expect(block[2]).toBe(`          ${LABEL_SOURCE_TEXT.complete} 0 · ${LABEL_SOURCE_TEXT.succeeded} 1`);
    expect(block[3]).toBe('  bin           n  mean p  observed  bar');
    expect(block[4]).toBe('  0.0–0.1       0       —         —');
    expect(block[6]).toBe('  0.2–0.3       1    0.20      0.00  ··········');
    expect(block[13]).toBe('  0.9–1.0       1    0.90      1.00  ██████████');
    expect(block[14]).toBe('  ECE 0.150 (10 equal-width bins)   near-threshold (|p−t| ≤ 0.03): 0 (0%)');
    expect(block[15]).toBe('  risk@.30 0  risk@.70 0  complete@.85 0  plan@.70 0  context@.50 0');
    expect(block[16]).toBe('  sharpness: 50% outside 0.2–0.8');
    expect(block.length).toBe(17);
  });
  it('prints the near-threshold share with one decimal below 10 % (§7.6 `57 (1.2%)`) and whole above', () => {
    const near = { step: 1, stage: 'context', id: 'a.py', probability: 0.51 };
    const far = (i: number): { step: number; stage: string; id: string; probability: number } => ({ step: 1, stage: 'judge', id: `succeeded_${i}`, probability: 0.9 });
    const decisions = [near, ...Array.from({ length: 82 }, (_, i) => far(i))];
    const block = calibrationBlock(calibrationStats([{ runId: 'r', decisions, steps: [] }]));
    expect(block.find((l) => l.includes('near-threshold'))).toMatch(/: 1 \(1\.2%\)$/);
    const half = calibrationBlock(calibrationStats([{ runId: 'r', decisions: [near, far(0)], steps: [] }]));
    expect(half.find((l) => l.includes('near-threshold'))).toMatch(/: 1 \(50%\)$/);
    const all = calibrationBlock(calibrationStats([{ runId: 'r', decisions: [near], steps: [] }]));
    expect(all.find((l) => l.includes('near-threshold'))).toMatch(/: 1 \(100%\)$/);
  });
  it('has ascii and screen-reader twins', () => {
    const ascii = calibrationBlock(calibrationStats([r]), GLYPHS.ascii);
    for (const l of ascii) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(ascii[14]).toBe('  ECE 0.150 (10 equal-width bins)   near-threshold (|p-t| <= 0.03): 0 (0%)');
    expect(ascii[16]).toBe('  sharpness: 50% outside 0.2-0.8');
    expect(ascii[4]).toBe('  0.0-0.1       0       -         -');
    const sr = calibrationBlock(calibrationStats([r]), GLYPHS.sr);
    expect(sr[13]).toBe('  0.9–1.0       1    0.90      1.00');
  });
});
