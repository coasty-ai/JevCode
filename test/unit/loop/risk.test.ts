import { describe, expect, it } from 'vitest';
import type { Answer, ProposalEvidence } from '../../../src/core/types.js';
import { assertQuestionBatch } from '../../../src/jev/questions.js';
import { EVIDENCE_CONSISTENT_ID, RISK_BLOCK, RISK_REVIEW, RISK_LEVEL_TEXTS, assessRisk, buildRiskQuestions, evidenceSummary, riskLevelTexts } from '../../../src/loop/stages/risk.js';
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

describe('risk with proposal.evidence (jev-only shadow test run)', () => {
  const evidence: ProposalEvidence = {
    kind: 'shadow_test_run',
    command: 'python3 -m pytest -q',
    before: { passed: 7, failed: 3, errors: 0, total: 10 },
    after: { passed: 8, failed: 2, errors: 0, total: 10 },
    newlyPassing: ['tests/test_g.py::test_weighted'],
    newlyFailing: [],
    goalTests: ['tests/test_g.py::test_weighted'],
    selection: 'sieve',
    candidatesTested: 360,
    arbitrated: false,
  };
  it('questions: the same four one-quantity Scores plus `evidence_consistent`; only out_of_scope[0], plan_mismatch[2], [3] and [4] mention the evidence or the claiming-run rule; the default set is untouched', () => {
    const qs = buildRiskQuestions({ evidence: true });
    expect(Object.keys(qs)).toEqual(['destructive', 'out_of_scope', 'plan_mismatch', 'irreversible', 'matches_intent', EVIDENCE_CONSISTENT_ID]);
    assertQuestionBatch(qs);
    const texts = riskLevelTexts(true);
    expect(texts.destructive).toBe(RISK_LEVEL_TEXTS.destructive);
    expect(texts.irreversible).toBe(RISK_LEVEL_TEXTS.irreversible);
    expect(texts.out_of_scope[0]).toContain('`proposal.evidence.goalTests`');
    expect(texts.out_of_scope.slice(1)).toEqual(RISK_LEVEL_TEXTS.out_of_scope.slice(1));
    expect(texts.plan_mismatch[2]).toMatch(/^skips a planned verification step; an action whose `proposal\.evidence\.verified` is true/);
    expect(texts.plan_mismatch[4]).toContain('a blocked or declined proposal in `recent` never ran');
    expect(texts.plan_mismatch[4]).toContain('a test `run` after a change');
    expect([texts.plan_mismatch[0], texts.plan_mismatch[1]]).toEqual([RISK_LEVEL_TEXTS.plan_mismatch[0], RISK_LEVEL_TEXTS.plan_mismatch[1]]);
    expect(texts.plan_mismatch[3]).toMatch(/^ignores the plan's open problems/);
    expect(texts.plan_mismatch[3]).toContain('a test `run` is never a completion claim');
    for (const dim of ['out_of_scope', 'plan_mismatch'] as const) expect(String(qs[dim]!.instructions)).toContain('`proposal.evidence`');
    for (const dim of ['destructive', 'irreversible'] as const) expect(qs[dim]).toEqual(buildRiskQuestions()[dim]);
    expect(Object.keys(buildRiskQuestions())).toEqual(['destructive', 'out_of_scope', 'plan_mismatch', 'irreversible', 'matches_intent']);
    expect(riskLevelTexts(false)).toBe(RISK_LEVEL_TEXTS);
    const ec = qs[EVIDENCE_CONSISTENT_ID]!;
    expect(String(ec.instructions)).toBe('Do `proposal.evidence` and `recent` agree, i.e. is the claimed test progress plausible given the previous runs?');
  });
  it('a verified patch with level-0/1 Scores is ok whatever evidence_consistent says; the reason names the evidence and the proposal', () => {
    const answers = { destructive: scoreA({ 1: 1 }), out_of_scope: scoreA({ 0: 1 }), plan_mismatch: scoreA({ 0: 0.9, 1: 0.1 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9), [EVIDENCE_CONSISTENT_ID]: noulA(0.1) };
    const r = assessRisk(answers, 0.9, 'edit', { evidenceConsistent: 0.1, evidence, goal: 'apply verified fix: tests/test_g.py::test_weighted now passes (7→8 of 10), no regressions; donor/replace at src/g.py:28', texts: riskLevelTexts(true) });
    expect(r.verdict).toBe('ok');
    expect(r.risk).toBeCloseTo(0.25, 6);
    expect(r.reason).toContain('; evidence verified: 7→8 of 10 pass, no regressions (sieve, 360 tested); proposal: apply verified fix: tests/test_g.py::test_weighted now passes (7→8 of 10), no regressions; donor/replace at src/g.py:28');
    expect(r.reason).not.toContain(EVIDENCE_CONSISTENT_ID);
    expect(evidenceSummary({ ...evidence, newlyFailing: ['t'], arbitrated: true, selection: 'rank' })).toBe('evidence unverified: 7→8 of 10 pass, 1 regression (rank, 360 tested, arbitrated)');
  });
  it('on review/block the reason adds evidence_consistent < 0.3 (reason text only) and clips the long evidence level text so the evidence line fits the window', () => {
    const answers = { destructive: scoreA({ 0: 1 }), out_of_scope: scoreA({ 0: 1 }), plan_mismatch: scoreA({ 4: 1 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9), [EVIDENCE_CONSISTENT_ID]: noulA(0.12) };
    const r = assessRisk(answers, 0.9, 'edit', { evidenceConsistent: 0.12, evidence, goal: 'g', texts: riskLevelTexts(true) });
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain(`Jev judged the evidence inconsistent with recent (${EVIDENCE_CONSISTENT_ID}=0.12)`);
    expect(r.reason).toMatch(/dominant level 4 "contradicts the plan, repeats a step[^"]*…"/);
    expect(r.reason.length).toBeLessThan(600);
    // the same Scores without evidence: the §5.5 text quoted whole, nothing appended
    const plain = assessRisk(answers, 0.9, 'edit');
    expect(plain.reason).toContain(`dominant level 4 "${RISK_LEVEL_TEXTS.plan_mismatch[4]}"`);
    expect(plain.reason).not.toContain('evidence');
  });
});
