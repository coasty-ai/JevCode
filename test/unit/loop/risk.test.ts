import { describe, expect, it } from 'vitest';
import type { Answer } from '../../../src/core/types.js';
import { RISK_BLOCK, RISK_REVIEW, RISK_LEVEL_TEXTS, assessRisk, buildRiskQuestions } from '../../../src/loop/stages/risk.js';
import { noulA, scoreA } from './fakes.js';

function all(levels: Record<number, number>): Record<string, Answer> {
  return { destructive: scoreA(levels), out_of_scope: scoreA({ 0: 1 }), plan_mismatch: scoreA({ 0: 1 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9) };
}

describe('risk mapping table (§5.3, §14)', () => {
  const table: [Record<number, number>, number, 'ok' | 'review' | 'block'][] = [
    [{ 1: 0.8, 2: 0.2 }, 0.3, 'review'],
    [{ 1: 0.85, 2: 0.15 }, 0.2875, 'ok'],
    [{ 1: 0.9, 3: 0.1 }, 0.3, 'review'],
    [{ 1: 1.0 }, 0.25, 'ok'],
    [{ 2: 1.0 }, 0.5, 'review'],
    [{ 3: 0.7, 2: 0.3 }, 0.7, 'block'],
    // DESIGN.md §5.3 lists this row as 0.70; the tail term P(k>=3)=0.80 dominates: max(0.70, 0.80).
    [{ 3: 0.8, 2: 0.2 }, 0.8, 'block'],
    [{ 3: 0.8, 0: 0.2 }, 0.8, 'block'],
    [{ 4: 0.7, 0: 0.3 }, 0.7, 'block'],
    [{ 0: 0.5, 4: 0.5 }, 0.5, 'review'],
    [{ 0: 0.1, 3: 0.9 }, 0.9, 'block'],
    [{ 0: 0.7, 3: 0.3 }, 0.3, 'review'],
    [{ 2: 0.25, 3: 0.75 }, 0.75, 'block'],
  ];
  for (const [levels, risk, verdict] of table) {
    it(`${JSON.stringify(levels)} -> ${risk} ${verdict}`, () => {
      const r = assessRisk(all(levels), 0.9, 'edit');
      expect(r.risk).toBeCloseTo(risk, 6);
      expect(r.verdict).toBe(verdict);
      expect(r.dims.destructive.risk).toBeCloseTo(risk, 6);
    });
  }
  it('the verdict is independent of the summation order of the probability map', () => {
    const a = scoreA({ 3: 0.7, 2: 0.3 });
    if (a.type !== 'score') throw new Error();
    const reversed: Record<string, number> = {};
    for (const k of Object.keys(a.probabilities).reverse()) reversed[k] = a.probabilities[k]!;
    const b: Answer = { ...a, probabilities: reversed };
    expect(assessRisk({ ...all({}), destructive: b }, 0.9, 'edit').verdict).toBe('block');
    expect(assessRisk({ ...all({}), destructive: a }, 0.9, 'edit').risk).toBe(assessRisk({ ...all({}), destructive: b }, 0.9, 'edit').risk);
  });
  it('the reason names the dimension(s) at the max, the bound, the dominant level text and the confidence; matches_intent < 0.3 is appended only for review/block', () => {
    const r = assessRisk({ destructive: scoreA({ 0: 0.1, 3: 0.9 }), out_of_scope: scoreA({ 0: 1 }), plan_mismatch: scoreA({ 0: 0.1, 3: 0.9 }), irreversible: scoreA({ 1: 1 }), matches_intent: noulA(0.2) }, 0.2, 'edit');
    expect(r.verdict).toBe('block');
    expect(r.reason).toMatch(/^risk 0\.90 \(block\) from destructive: 0\.90 probability of level 3 or above; dominant level 3 ".*mass deletion.*"; Jev confidence 0\.\d\d \| plan_mismatch: 0\.90 probability of level 3 or above/);
    expect(r.reason).toContain('does not carry out intent `edit` (matches_intent=0.20)');
    expect(r.dims.irreversible).toMatchObject({ level: 1, risk: 0.25, bound: 'expected' });
    const ok = assessRisk(all({ 0: 1 }), 0.1, 'edit');
    expect(ok.reason).not.toContain('matches_intent');
    expect(ok.reason).toMatch(/expected level 0\.00 of 4/);
  });
  it('questions: four one-quantity 5-level Scores with the exact level texts and a matches_intent Noul with both-sided criteria; thresholds exported', () => {
    const qs = buildRiskQuestions();
    expect(Object.keys(qs)).toEqual(['destructive', 'out_of_scope', 'plan_mismatch', 'irreversible', 'matches_intent']);
    for (const dim of ['destructive', 'out_of_scope', 'plan_mismatch', 'irreversible'] as const) {
      const q = qs[dim]!;
      expect(q.type).toBe('score');
      if (q.type === 'score') expect(q.criteria).toEqual([...RISK_LEVEL_TEXTS[dim]]);
      expect(String(q.instructions)).toContain('`proposal.action`');
    }
    expect(RISK_LEVEL_TEXTS.destructive[0]).toMatch(/^nothing existing is lost/);
    expect(RISK_LEVEL_TEXTS.irreversible[4]).toBe('cannot be reversed');
    const mi = qs['matches_intent']!;
    expect(mi.type).toBe('noul');
    if (mi.type === 'noul') expect((mi.criteria!.true as { examples: string[] }).examples.length).toBeGreaterThanOrEqual(2);
    expect(RISK_REVIEW).toBe(0.3);
    expect(RISK_BLOCK).toBe(0.7);
  });
});
