import { describe, expect, it } from 'vitest';
import type { Plan } from '../../../src/core/types.js';
import type { HarnessProblem } from '../../../src/core/types.js';
import { HUMAN_SEED_TTL_STEPS, HUMAN_STEER_TTL_STEPS, PLAN_ACCEPT_THRESHOLD, PLAN_MAX_CLAIMS, PLAN_MAX_HARNESS_PROBLEMS, PLAN_REJECT_THRESHOLD, applyPlanDraft, boundHarnessProblems, emptyPlan, humanExpired, isSeedProblem, newClaims } from '../../../src/loop/plan.js';

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
  it('TUI-DESIGN §8.6: `human: true` unlocks rule (b) drops without a replan problem; false/absent keeps retaining', () => {
    const base = plan({ remaining: ['fix f', 'run tests', 'update docs'] });
    const draft = { done: [], remaining: ['fix f'], openProblems: [] };
    const steered = applyPlanDraft({ plan: base, draft, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: null, stale: null, human: true });
    expect(steered.plan.remaining).toEqual(['fix f']);
    expect(steered.retained).toEqual([]);
    expect(steered.notes).toEqual([]);
    expect(steered.plan.harnessProblems).toEqual([]);
    const kept = applyPlanDraft({ plan: base, draft, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: null, stale: null, human: false });
    expect(kept.plan.remaining).toEqual(['fix f', 'run tests', 'update docs']);
    // unverified / rejected items are kept even under a human directive (mustKeep wins)
    const withUnverified = applyPlanDraft({ plan: plan({ remaining: ['fix f', 'run tests'] }), draft: { done: ['run tests'], remaining: [], openProblems: [] }, step: 2, claims: ['run tests'], claimsDropped: 0, evidence: { kind: 'judged', probabilities: new Map([['run tests', 0.5]]) }, newInformation: null, replan: null, stale: null, human: true });
    expect(withUnverified.plan.remaining).toEqual(['run tests']);
  });
  it('TUI-DESIGN §8.6: human problems expire — steers 4 steps after their step, seed/undo notes (step 0) after step 8; other kinds never through this rule', () => {
    expect(HUMAN_STEER_TTL_STEPS).toBe(4);
    expect(HUMAN_SEED_TTL_STEPS).toBe(8);
    const steer = { kind: 'human' as const, text: 's', step: 3 };
    const seed = { kind: 'human' as const, text: 'f', step: 0 };
    expect(humanExpired(steer, 7)).toBe(false);
    expect(humanExpired(steer, 8)).toBe(true);
    expect(humanExpired(seed, 8)).toBe(false);
    expect(humanExpired(seed, 9)).toBe(true);
    expect(humanExpired({ kind: 'replan', text: 'r', step: 0 }, 99)).toBe(false);
    const base = plan({ harnessProblems: [steer, seed, { kind: 'rejected_claim', text: 'c', step: 1 }] });
    const at7 = applyPlanDraft({ plan: base, draft: null, step: 7, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: null, stale: null });
    expect(at7.plan.harnessProblems.map((h) => `${h.kind}@${h.step}`)).toEqual(['human@3', 'human@0', 'rejected_claim@1']);
    const at8 = applyPlanDraft({ plan: base, draft: { done: [], remaining: base.remaining, openProblems: [] }, step: 8, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: null, stale: null });
    expect(at8.plan.harnessProblems.map((h) => `${h.kind}@${h.step}`)).toEqual(['human@0', 'rejected_claim@1']);
    const at9 = applyPlanDraft({ plan: base, draft: null, step: 9, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: null, stale: null });
    expect(at9.plan.harnessProblems.map((h) => `${h.kind}@${h.step}`)).toEqual(['rejected_claim@1']);
  });
  it('a null draft keeps the plan and applies only replan / stale bookkeeping', () => {
    const r = applyPlanDraft({ plan: plan(), draft: null, step: 2, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'no proposal' }, newInformation: null, replan: null, stale: null });
    expect(r.plan.remaining).toEqual(['fix f', 'run tests']);
    expect(r.notes).toEqual([]);
  });
});

describe('boundHarnessProblems (TUI-DESIGN §8.6: the step-0 framing is never evicted ahead of a younger problem)', () => {
  const seed: HarnessProblem = { kind: 'human', step: 0, text: 'Follow-up to run x' };
  const other = (i: number): HarnessProblem => ({ kind: 'rejected_claim', step: i, text: `claim ${i}` });
  const steer = (i: number): HarnessProblem => ({ kind: 'human', step: i, text: `steer ${i}` });

  it('under the cap the list is copied unchanged; at the cap the oldest non-seed problems go first and order is kept', () => {
    const small = [seed, other(1), steer(2)];
    expect(boundHarnessProblems(small)).toEqual(small);
    expect(boundHarnessProblems(small)).not.toBe(small);
    const many = [seed, ...Array.from({ length: 9 }, (_, i) => other(i + 1)), ...Array.from({ length: 8 }, (_, i) => steer(10 + i))];
    expect(many).toHaveLength(18);
    const bounded = boundHarnessProblems(many);
    expect(bounded).toHaveLength(PLAN_MAX_HARNESS_PROBLEMS);
    expect(bounded[0]).toEqual(seed);
    expect(bounded.slice(1, 8)).toEqual(many.slice(3, 10));
    expect(bounded.slice(8)).toEqual(many.slice(10));
    // a plain slice would have dropped the seed
    expect(many.slice(-PLAN_MAX_HARNESS_PROBLEMS)).not.toContainEqual(seed);
  });

  it('a seed problem in the middle survives too; only seed problems left → the oldest seeds go; custom max', () => {
    const list = [other(1), other(2), seed, other(3)];
    expect(boundHarnessProblems(list, 2)).toEqual([seed, other(3)]);
    const seeds = Array.from({ length: 5 }, (_, i) => ({ ...seed, text: `seed ${i}` }));
    expect(boundHarnessProblems(seeds, 3)).toEqual(seeds.slice(2));
    expect(isSeedProblem(seed)).toBe(true);
    expect(isSeedProblem(steer(1))).toBe(false);
    expect(isSeedProblem(other(0))).toBe(false);
  });

  it('applyPlanDraft bounds harnessProblems through the same rule at commit', () => {
    const base = { ...emptyPlan(), remaining: ['fix f'], harnessProblems: [seed, ...Array.from({ length: 15 }, (_, i) => other(i + 1))] };
    const draft = { done: [], remaining: ['fix f'], openProblems: [] };
    const r = applyPlanDraft({ plan: base, draft, step: 20, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: { text: 'try again' }, stale: null });
    // 16 + a replan problem = 17 → 16: the seed (step 0, not yet expired at step 20? it is: > 8) — use step 5 for the live case
    expect(r.plan.harnessProblems).toHaveLength(PLAN_MAX_HARNESS_PROBLEMS);
    const live = applyPlanDraft({ plan: base, draft, step: 5, claims: [], claimsDropped: 0, evidence: { kind: 'none', because: 'x' }, newInformation: null, replan: { text: 'try again' }, stale: null });
    expect(live.plan.harnessProblems).toHaveLength(PLAN_MAX_HARNESS_PROBLEMS);
    expect(live.plan.harnessProblems[0]).toEqual(seed);
    expect(live.plan.harnessProblems.at(-1)).toMatchObject({ kind: 'replan', text: 'try again', step: 5 });
    expect(live.plan.harnessProblems.some((h) => h.text === 'claim 1')).toBe(false);
  });
});

