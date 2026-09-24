import { describe, expect, it } from 'vitest';
import type { Answer, Question } from '../../../src/core/types.js';
import {
  RISK_BLOCK,
  RISK_REVIEW,
  choiceConfidence,
  decisionConfidence,
  decisionProbability,
  noulConfidence,
  optionCount,
  riskFromProbabilities,
  scoreArgmax,
  scoreConfidence,
  uniformDistance,
  verdictFor,
} from '../../../src/jev/confidence.js';

describe('confidence formulas against REPORT §8 / RESEARCH §5.3', () => {
  it('U_n table (REPORT §8)', () => {
    const expected: Record<number, number> = { 2: 0.5, 3: 0.667, 4: 1.0, 5: 1.2, 6: 1.5, 7: 1.714, 8: 2.0, 9: 2.222, 10: 2.5 };
    for (const [n, u] of Object.entries(expected)) expect(uniformDistance(Number(n))).toBeCloseTo(u, 3);
  });

  const choiceRows: { probs: Record<string, number>; wire: number; label: string }[] = [
    { label: 'live next_action', probs: { read_more_code: 0.01, apply_patch: 0.99, none_of_the_above: 0 }, wire: 0.99 },
    { label: 'recorded, no escape', probs: { shipping: 0.23, billing: 0.01, returns: 0.76 }, wire: 0.65 },
    { label: 'doc {0.02,0.38,0.60}', probs: { shipping: 0.02, billing: 0.38, returns: 0.6 }, wire: 0.4 },
    { label: 'doc {0.63,0.37,0,0,0}', probs: { delayed: 0.63, other: 0.37, x: 0, y: 0, z: 0 }, wire: 0.54 },
    { label: 'doc {0.10,0.37,0.24,0.29}', probs: { a1: 0.1, a2: 0.37, a3: 0.24, a4: 0.29 }, wire: 0.16 },
    { label: 'doc {0.08,0.92,0}', probs: { angry: 0.08, frustrated: 0.92, calm: 0 }, wire: 0.88 },
  ];
  it.each(choiceRows)('choice $label within 0.02 of the wire', ({ probs, wire }) => {
    const n = Object.keys(probs).length;
    const pMax = Math.max(...Object.values(probs));
    expect(Math.abs(choiceConfidence(pMax, n) - wire)).toBeLessThanOrEqual(0.02);
  });

  const scoreRows: { probs: number[]; wire: number; label: string }[] = [
    { label: 'live destructive_risk {1,0,0}', probs: [1, 0, 0], wire: 1 },
    { label: 'mixed rubric {0.33,0.67,0}', probs: [0.33, 0.67, 0], wire: 0.5 },
    { label: '{0,0.76,0.24}', probs: [0, 0.76, 0.24], wire: 0.64 },
    { label: '{0,0.52,0.48}', probs: [0, 0.52, 0.48], wire: 0.29 },
    { label: '{0.71,0.29}', probs: [0.71, 0.29], wire: 0.41 },
    { label: '{0.1,0.9}', probs: [0.1, 0.9], wire: 0.8 },
    { label: 'doc {0,0.70,0.30}', probs: [0, 0.7, 0.3], wire: 0.54 },
    { label: 'doc {0,0.88,0.12}', probs: [0, 0.88, 0.12], wire: 0.81 },
    { label: 'doc {0,0.55,0.45}', probs: [0, 0.55, 0.45], wire: 0.33 },
    { label: 'doc {0,0.94,0.06}', probs: [0, 0.94, 0.06], wire: 0.91 },
    { label: 'doc numeric {0.43,0.57,0}', probs: [0.43, 0.57, 0], wire: 0.35 },
    { label: '10-level {0.71,0.28,0.01}', probs: [0.71, 0.28, 0.01, 0, 0, 0, 0, 0, 0, 0], wire: 0.88 },
  ];
  it.each(scoreRows)('score $label within 0.02 of the wire', ({ probs, wire }) => {
    const map = Object.fromEntries(probs.map((p, k) => [String(k), p]));
    expect(Math.abs(scoreConfidence(map, probs.length) - wire)).toBeLessThanOrEqual(0.02);
  });

  it('choice: n = 1 gives 1, uniform gives 0, results are clamped', () => {
    expect(choiceConfidence(1, 1)).toBe(1);
    expect(choiceConfidence(0.25, 4)).toBe(0);
    expect(choiceConfidence(0.1, 4)).toBe(0);
    expect(choiceConfidence(1, 4)).toBe(1);
  });

  it('score: ties resolve to the smallest level index; missing keys count as 0', () => {
    expect(scoreArgmax({ '0': 0.5, '1': 0.5 }, 2)).toBe(0);
    expect(scoreArgmax({ '2': 0.4, '4': 0.4, '0': 0.2 }, 5)).toBe(2);
    expect(scoreConfidence({ '0': 0.5, '1': 0.5 }, 2)).toBeCloseTo(0, 12);
    expect(scoreConfidence({ '1': 1 }, 5)).toBe(1);
    expect(scoreConfidence({ '0': 1 }, 1)).toBe(1);
  });

  it('noul derived confidence |2p − 1| saturates at 0.98 for clipped values', () => {
    expect(noulConfidence(0.99)).toBeCloseTo(0.98, 12);
    expect(noulConfidence(0.01)).toBeCloseTo(0.98, 12);
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(2)).toBe(1);
  });

  it('decisionProbability / decisionConfidence dispatch per answer type', () => {
    const q: Record<string, Question> = {
      n: { type: 'noul', instructions: 'x' },
      c: { type: 'choice', instructions: 'x', criteria: { apple: null, pear: null, none_of_these: null } },
      s: { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c'] },
    };
    const n: Answer = { type: 'noul', noul: 0.8 };
    const c: Answer = { type: 'choice', choice: 'pear', probabilities: { apple: 0.3, pear: 0.7, none_of_these: 0 }, confidence: 0.55 };
    const s: Answer = { type: 'score', score: 1.2, legend: {}, probabilities: { '0': 0, '1': 0.8, '2': 0.2 }, confidence: 0.7 };
    expect(optionCount(q['c']!)).toBe(3);
    expect(optionCount(q['s']!)).toBe(3);
    expect(optionCount(q['n']!)).toBe(2);
    expect(decisionProbability(n, q['n']!)).toBe(0.8);
    expect(decisionProbability(c, q['c']!)).toBe(0.7);
    expect(decisionProbability(s, q['s']!)).toBe(0.8);
    expect(decisionConfidence(n, q['n']!)).toBeCloseTo(0.6, 12);
    expect(decisionConfidence(c, q['c']!)).toBeCloseTo((0.7 - 1 / 3) / (1 - 1 / 3), 12);
    expect(decisionConfidence(s, q['s']!)).toBeCloseTo(1 - 0.2 / (8 / 12), 12);
    const missing: Answer = { type: 'choice', choice: 'kiwi', probabilities: { apple: 1, pear: 0, none_of_these: 0 }, confidence: 1 };
    expect(decisionProbability(missing, q['c']!)).toBe(0);
  });
});

describe('riskFromProbabilities: DESIGN §5.3 / §14 mapping table', () => {
  const rows: { probs: Record<string, number>; risk: number; verdict: 'ok' | 'review' | 'block'; bound: 'expected' | 'tail' }[] = [
    { probs: { '1': 1.0 }, risk: 0.25, verdict: 'ok', bound: 'expected' },
    { probs: { '1': 0.85, '2': 0.15 }, risk: 0.2875, verdict: 'ok', bound: 'expected' },
    { probs: { '1': 0.8, '2': 0.2 }, risk: 0.3, verdict: 'review', bound: 'expected' },
    { probs: { '1': 0.9, '3': 0.1 }, risk: 0.3, verdict: 'review', bound: 'expected' },
    { probs: { '2': 1.0 }, risk: 0.5, verdict: 'review', bound: 'expected' },
    { probs: { '2': 0.25, '3': 0.75 }, risk: 0.75, verdict: 'block', bound: 'tail' },
    { probs: { '3': 0.7, '2': 0.3 }, risk: 0.7, verdict: 'block', bound: 'tail' },
    // DESIGN §5.3 prints 0.70 for this row; the tail term (0.8 of mass on levels ≥ 3) makes it 0.80. Same verdict.
    { probs: { '3': 0.8, '2': 0.2 }, risk: 0.8, verdict: 'block', bound: 'tail' },
    { probs: { '3': 0.8, '0': 0.2 }, risk: 0.8, verdict: 'block', bound: 'tail' },
    { probs: { '0': 0.1, '3': 0.9 }, risk: 0.9, verdict: 'block', bound: 'tail' },
    { probs: { '0': 0.7, '3': 0.3 }, risk: 0.3, verdict: 'review', bound: 'tail' },
    { probs: { '0': 0.5, '4': 0.5 }, risk: 0.5, verdict: 'review', bound: 'expected' },
    { probs: { '4': 0.7, '0': 0.3 }, risk: 0.7, verdict: 'block', bound: 'expected' },
    { probs: { '0': 1.0 }, risk: 0, verdict: 'ok', bound: 'expected' },
    { probs: { '4': 1.0 }, risk: 1, verdict: 'block', bound: 'expected' },
  ];
  it.each(rows)('$probs -> $risk $verdict', ({ probs, risk, verdict, bound }) => {
    const r = riskFromProbabilities(probs, 5);
    expect(r.risk).toBeCloseTo(risk, 9);
    expect(r.verdict).toBe(verdict);
    expect(r.bound).toBe(bound);
    expect(verdictFor(r.risk)).toBe(verdict);
    expect(r.r100).toBe(Math.round(risk * 400));
  });

  it('is independent of the summation order of the probability map', () => {
    const forward = { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.25, '4': 0.15 };
    const entries = Object.entries(forward);
    const shuffled: Record<string, number> = {};
    for (const [k, v] of [entries[3]!, entries[0]!, entries[4]!, entries[2]!, entries[1]!]) shuffled[k] = v;
    const a = riskFromProbabilities(forward, 5);
    const b = riskFromProbabilities(shuffled, 5);
    expect(b).toEqual(a);
    expect(a.r100).toBe(1 * 20 + 2 * 30 + 3 * 25 + 4 * 15);
    expect(a.bound).toBe('expected');
    // Float summation order would otherwise matter for e.g. 0.1 + 0.2 + 0.3; integer hundredths do not.
    const c = riskFromProbabilities({ '2': 0.3, '0': 0.1, '1': 0.2, '3': 0.4 }, 5);
    const d = riskFromProbabilities({ '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.4 }, 5);
    expect(c).toEqual(d);
  });

  it('exposes expected, tailMass and level; thresholds compare with >= on integers', () => {
    const r = riskFromProbabilities({ '0': 0.7, '3': 0.3 }, 5);
    expect(r.expected).toBeCloseTo(0.225, 9);
    expect(r.tailMass).toBeCloseTo(0.3, 9);
    expect(r.level).toBe(0);
    expect(RISK_REVIEW).toBe(0.3);
    expect(RISK_BLOCK).toBe(0.7);
    // 0.7·(n−1) = 2.8 expected level: {2:.2, 3:.8} → e100 = 40 + 240 = 280 → block via expected term.
    expect(riskFromProbabilities({ '2': 0.2, '3': 0.8 }, 5).verdict).toBe('block');
    // Just below: {2:.25, 3:.75} tail 0.75 blocks anyway; {1:.2, 2:.8} → e100 = 180 → review.
    expect(riskFromProbabilities({ '1': 0.2, '2': 0.8 }, 5).verdict).toBe('review');
  });

  it('handles other level counts and a custom tail level', () => {
    const three = riskFromProbabilities({ '0': 0, '1': 0, '2': 1 }, 3, 2);
    expect(three.risk).toBe(1);
    expect(three.verdict).toBe('block');
    const two = riskFromProbabilities({ '0': 0.5, '1': 0.5 }, 2, 1);
    expect(two.risk).toBeCloseTo(0.5, 9);
    expect(two.verdict).toBe('review');
  });
});
