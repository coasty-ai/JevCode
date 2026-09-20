import { describe, expect, it } from 'vitest';
import type { Plan } from '../../../src/core/types.js';
import { PLAN_ACCEPT_THRESHOLD, PLAN_MAX_CLAIMS, PLAN_REJECT_THRESHOLD, applyPlanDraft, emptyPlan, newClaims } from '../../../src/loop/plan.js';

function plan(over: Partial<Plan> = {}): Plan {
  return { ...emptyPlan(), remaining: ['fix f', 'run tests'], ...over };
}
function judged(p: number, text = 'fix f') {
  const base = plan();
  const draft = { done: [text], remaining: ['run tests'], openProblems: [] };
  const { claims, dropped } = newClaims(base, draft);
  return applyPlanDraft({ plan: base, draft, step: 3, claims, claimsDropped: dropped, evidence: { kind: 'judged', probabilities: new Map([[text, p]]) }, newInformation: 0.1, replan: null, stale: null });
}

describe('Plan rules (§6)', () => {
  it('constants', () => {
    expect(PLAN_ACCEPT_THRESHOLD).toBe(0.7);
    expect(PLAN_REJECT_THRESHOLD).toBe(0.3);
    expect(PLAN_MAX_CLAIMS).toBe(8);
  });
  it('0.70 accepted with evidence; 0.69 and 0.31 unverified; 0.29 rejected', () => {
    const a = judged(0.7);
    expect(a.plan.done).toEqual([{ text: 'fix f', evidence: { step: 3, judged: 0.7 } }]);
    expect(a.plan.remaining).toEqual(['run tests']);
    expect(a.accepted).toEqual(['fix f']);
    for (const p of [0.69, 0.31]) {
      const u = judged(p);
      expect(u.plan.done).toEqual([]);
      expect(u.plan.remaining).toContain('fix f');
      expect(u.plan.unverified).toEqual([{ text: 'fix f', step: 3, judged: p }]);
      expect(u.notes[0]).toMatch(/Jev was unsure \(p=0\.\d\d\) that 'fix f' is finished; verify it/);
      expect(u.plan.harnessProblems).toEqual([]);
    }
    const r = judged(0.29);
    expect(r.plan.done).toEqual([]);
    expect(r.plan.remaining).toContain('fix f');
    expect(r.plan.harnessProblems).toEqual([{ kind: 'rejected_claim', text: "'fix f' was not accepted as done: done_0 = 0.29", step: 3 }]);
    expect(r.notes[0]).toBe("'fix f' was not accepted as done: done_0 = 0.29");
    expect(r.doneClaims).toEqual([{ text: 'fix f', judged: 0.29, accepted: false }]);
  });
  it('more than 8 claims are truncated without a crash and noted', () => {
    const draft = { done: Array.from({ length: 11 }, (_, i) => `item ${i}`), remaining: [], openProblems: [] };
    const { claims, dropped } = newClaims(emptyPlan(), draft);
    expect(claims).toHaveLength(8);
    expect(dropped).toBe(3);
    const probs = new Map(claims.map((c) => [c, 0.9]));
    const r = applyPlanDraft({ plan: emptyPlan(), draft, step: 1, claims, claimsDropped: dropped, evidence: { kind: 'judged', probabilities: probs }, newInformation: 0, replan: null, stale: null });
    expect(r.plan.done).toHaveLength(8);
    expect(r.notes).toContain('3 done claim(s) beyond 8 per step were dropped; restate them next step');
  });
  it('dropped remaining items are retained unless new_information >= 0.7 or a replan fired', () => {
    const base = plan({ remaining: ['fix f', 'run tests', 'update docs'] });
    const draft = { done: [], remaining: ['fix f', 'run tests'], openProblems: [] };
    const kept = applyPlanDraft({ plan: base, draft, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: 0.69, replan: null, stale: null });
    expect(kept.plan.remaining).toEqual(['fix f', 'run tests', 'update docs']);
    expect(kept.retained).toEqual(['update docs']);
    expect(kept.notes[0]).toMatch(/'update docs' was dropped from remaining without a done claim and was retained/);
    const newInfo = applyPlanDraft({ plan: base, draft, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: 0.7, replan: null, stale: null });
    expect(newInfo.plan.remaining).toEqual(['fix f', 'run tests']);
    const replanned = applyPlanDraft({ plan: base, draft, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: { text: 'change approach' }, stale: null });
    expect(replanned.plan.remaining).toEqual(['fix f', 'run tests']);
    expect(replanned.plan.harnessProblems).toEqual([{ kind: 'replan', text: 'change approach', step: 2 }]);
  });
  it('no-evidence steps reject every claim; verbatim (jev-off) accepts with judged -1; additions accepted and capped', () => {
    const draft = { done: ['fix f'], remaining: Array.from({ length: 25 }, (_, i) => `r${i}`), openProblems: Array.from({ length: 20 }, (_, i) => `p${i}`) };
    const none = applyPlanDraft({ plan: plan(), draft, step: 2, claims: ['fix f'], claimsDropped: 0, evidence: { kind: 'none', because: 'outcome blocked' }, newInformation: null, replan: null, stale: null });
    expect(none.plan.done).toEqual([]);
    expect(none.plan.harnessProblems[0]?.text).toBe("'fix f' was not accepted as done: no judge evidence (outcome blocked)");
    expect(none.plan.remaining).toHaveLength(20);
    expect(none.plan.openProblems).toHaveLength(16);
    const verbatim = applyPlanDraft({ plan: plan(), draft, step: 2, claims: ['fix f'], claimsDropped: 0, evidence: { kind: 'verbatim' }, newInformation: null, replan: null, stale: null });
    expect(verbatim.plan.done).toEqual([{ text: 'fix f', evidence: { step: 2, judged: -1 } }]);
  });
  it('a claim accepted later clears its rejected_claim problem; stale notes expire after one step; replan survives openProblems replacement', () => {
    const r1 = judged(0.2);
    const withStale = applyPlanDraft({ plan: r1.plan, draft: { done: [], remaining: r1.plan.remaining, openProblems: ['new problem'] }, step: 4, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: { text: 'directive' }, stale: { probability: 0.1 } });
    expect(withStale.plan.harnessProblems.map((h) => h.kind).sort()).toEqual(['rejected_claim', 'replan', 'stale_plan']);
    expect(withStale.plan.openProblems).toEqual(['new problem']);
    const { claims } = newClaims(withStale.plan, { done: ['fix f'], remaining: [], openProblems: [] });
    const r2 = applyPlanDraft({ plan: withStale.plan, draft: { done: ['fix f'], remaining: ['run tests'], openProblems: [] }, step: 5, claims, claimsDropped: 0, evidence: { kind: 'judged', probabilities: new Map([['fix f', 0.95]]) }, newInformation: null, replan: null, stale: null });
    expect(r2.plan.harnessProblems.map((h) => h.kind)).toEqual(['replan']);
    expect(r2.plan.done.map((d) => d.text)).toEqual(['fix f']);
    expect(r2.plan.unverified).toEqual([]);
  });
  it('a null draft keeps the plan and applies only replan / stale bookkeeping', () => {
    const r = applyPlanDraft({ plan: plan(), draft: null, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'no proposal' }, newInformation: null, replan: null, stale: null });
    expect(r.plan.remaining).toEqual(['fix f', 'run tests']);
    expect(r.notes).toEqual([]);
  });
});
