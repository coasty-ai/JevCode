/**
 * Risk in llm-jev (docs/LLM-JEV-DESIGN.md §3 row 5, §5 Q20, §6.3): the code facts decide before any Jev request —
 * a verified patch, a verification run, a verified `done`, a `read`, a recoverable revert — and everything else is
 * gated by the two harm Scores alone, with the alignment dimensions recorded at level 0 and never gating.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, JsonObject, Proposal, ProposalEvidence, Question, StageName, TargetInfo } from '../../../../src/core/types.js';
import { assertQuestionBatch } from '../../../../src/jev/questions.js';
import type { StageContext } from '../../../../src/loop/engine.js';
import { emptyPlan } from '../../../../src/loop/plan.js';
import { buildCommonState } from '../../../../src/loop/state.js';
import { RISK_LEVEL_TEXTS, assessRisk, codeOkAssessment, codeRiskReason, harmOnlyQuestions, harmScoresDue, isTestPath, recoverableRevertOk, runRiskStage, verifiedPatchOk } from '../../../../src/jev-modes/stages/risk.js';
import { DEFAULT_LIMITS, createFakeSandbox, createFakeWorkspace, scoreA } from '../../loop/fakes.js';

/** The jev-on `run rm -rf build/` reason, captured on main before change 6 — the pin that the full risk stage did not move. */
const JEV_ON_REASON =
  'risk 0.25 (ok) from destructive: expected level 1.00 of 4; dominant level 1 "changes files whose previous content is recoverable (`proposal.target.recoverable` true: git-tracked, or first written earlier in this run), or changes dependency manifests, configuration or CI files inside the workspace, or installs into a project-local environment (venv, node_modules)"; Jev confidence 1.00 | irreversible: expected level 1.00 of 4; dominant level 1 "restorable by regenerating or reinstalling inside the workspace"; Jev confidence 1.00';
const GOAL_TEST = 'tests/test_a.py::test_f';
const DIFF = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2\n';

function evidence(over: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    kind: 'shadow_test_run',
    command: 'pytest -q',
    before: { passed: 1, failed: 1, errors: 0, total: 2 },
    after: { passed: 2, failed: 0, errors: 0, total: 2 },
    newlyPassing: [GOAL_TEST],
    newlyFailing: [],
    goalTests: [GOAL_TEST],
    selection: 'llm',
    candidatesTested: 3,
    arbitrated: false,
    ...over,
  };
}

function target(path: string, over: Partial<TargetInfo> = {}): TargetInfo {
  return { path, existsBefore: true, tracked: true, createdThisRun: false, recoverable: true, ...over };
}

function patch(e: ProposalEvidence | undefined, goal = 'fix f'): Proposal {
  const p: Proposal = { goal, action: { kind: 'patch', diff: DIFF }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
  if (e !== undefined) p.evidence = e;
  return p;
}

describe('code facts before any Jev request (llm-jev)', () => {
  it('verifiedPatchOk: verified evidence on ≤ 4 non-test workspace files; null for test paths, regressions, unverified or too many files', () => {
    expect(verifiedPatchOk(patch(evidence()), [target('src/a.py')])).toMatch(/^verified patch — evidence verified: 1→2 of 2 pass, no regressions \(llm, 3 tested\); proposal: fix f; 1 non-test workspace file \(src\/a\.py\)$/);
    expect(verifiedPatchOk(patch(evidence()), [target('src/a.py'), target('tests/test_a.py')])).toBeNull();
    expect(verifiedPatchOk(patch(evidence({ newlyFailing: ['tests/test_b.py::test_g'] })), [target('src/a.py')])).toBeNull();
    expect(verifiedPatchOk(patch(evidence({ after: { passed: 1, failed: 1, errors: 0, total: 2 }, newlyPassing: [] })), [target('src/a.py')])).toBeNull();
    expect(verifiedPatchOk(patch(undefined), [target('src/a.py')])).toBeNull();
    expect(verifiedPatchOk(patch(evidence()), ['a', 'b', 'c', 'd', 'e'].map((n) => target(`src/${n}.py`)))).toBeNull();
    expect(verifiedPatchOk(patch(evidence()), [])).toBeNull();
    expect(isTestPath('tests/test_a.py')).toBe(true);
    expect(isTestPath('src/conftest.py')).toBe(true);
    expect(isTestPath('src/a.py')).toBe(false);
  });

  it('codeRiskReason: read, verification run, verified done and a recoverable revert are ok; a non-test run, a partial done and a best guess are not', () => {
    const test = { command: 'pytest -q', runner: 'pytest' as const };
    const run = (command: string): Proposal => ({ goal: 'run', action: { kind: 'run', command }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' });
    const done: Proposal = { goal: 'done', action: { kind: 'done', summary: 'all green' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
    expect(codeRiskReason({ ...done, action: { kind: 'read', paths: ['src/a.py'] } }, [], test, null)).toBe('read: changes nothing');
    expect(codeRiskReason(run('pytest -q tests/test_a.py::test_f'), [], test, null)).toBe('verification run of the workspace test command `pytest -q tests/test_a.py::test_f`');
    expect(codeRiskReason(run('pytest -q; rm -rf build'), [], test, null)).toBeNull();
    expect(codeRiskReason(run('pip install requests'), [], test, null)).toBeNull();
    expect(codeRiskReason(done, [], test, { command: 'pytest -q', step: 3 })).toBe("completion verified by the engine's own passing run `pytest -q` at step 3");
    expect(codeRiskReason(done, [], test, null)).toBeNull();
    expect(codeRiskReason(patch(evidence(), 'revert the last change to src/a.py'), [target('src/a.py')], test, null)).toMatch(/^verified patch/);
    expect(recoverableRevertOk(patch(undefined, 'revert the last change to src/a.py'), [target('src/a.py')])).toBe('revert of recoverable targets (src/a.py): restorable with one git command');
    expect(recoverableRevertOk(patch(undefined, 'revert the last change'), [target('notes.txt', { tracked: false, recoverable: false })])).toBeNull();
    expect(recoverableRevertOk(patch(undefined, 'best guess'), [target('src/a.py')])).toBeNull();
    expect(codeRiskReason(patch(evidence({ after: { passed: 1, failed: 1, errors: 0, total: 2 }, newlyPassing: [] })), [target('src/a.py')], test, null)).toBeNull();
  });

  it('harm-only: two Scores with the §5.5 texts; alignment answers are recorded, never gating; the code-ok record carries synthetic level-0 dims', () => {
    const qs = harmOnlyQuestions();
    expect(Object.keys(qs)).toEqual(['destructive', 'irreversible']);
    assertQuestionBatch(qs);
    for (const dim of ['destructive', 'irreversible'] as const) {
      const q = qs[dim]!;
      expect(q.type).toBe('score');
      if (q.type === 'score') expect(q.criteria).toEqual([...RISK_LEVEL_TEXTS[dim]]);
    }
    const block = assessRisk({ destructive: scoreA({ 3: 0.8, 2: 0.2 }), irreversible: scoreA({ 0: 1 }) }, 1, 'edit', { harmOnly: true });
    expect(block.verdict).toBe('block');
    expect(block.reason).toMatch(/^risk 0\.80 \(block\) from destructive/);
    expect(block.reason).toContain('harm-only (llm-jev): out_of_scope and plan_mismatch not asked, recorded at level 0, not gating');
    expect(block.dims.out_of_scope).toMatchObject({ level: 0, risk: 0, confidence: 1 });
    // an alignment Score at the worst level does not gate under harmOnly (it would block in the §5.5 path)
    const answers: Record<string, Answer> = { destructive: scoreA({ 0: 1 }), irreversible: scoreA({ 1: 1 }), out_of_scope: scoreA({ 4: 1 }), plan_mismatch: scoreA({ 0: 1 }) };
    expect(assessRisk(answers, 1, 'edit', { harmOnly: true }).verdict).toBe('ok');
    expect(assessRisk(answers, 1, 'edit').verdict).toBe('block');
    const ok = codeOkAssessment('verify', 'verification run of the workspace test command `pytest -q`');
    expect(ok).toMatchObject({ verdict: 'ok', risk: 0, reason: 'risk 0.00 (ok) by code: verification run of the workspace test command `pytest -q`' });
    for (const d of Object.values(ok.dims)) expect(d).toMatchObject({ level: 0, risk: 0, confidence: 1, expected: 0 });
  });
});

describe('runRiskStage in llm-jev', () => {
  function stageCtx(asked: { stage: StageName; ids: string[] }[]): StageContext {
    const workspace = createFakeWorkspace();
    const sandbox = createFakeSandbox();
    const info = { root: '/ws', git: true, hasTests: true, testCommand: { command: 'pytest -q', runner: 'pytest' as const } };
    return {
      runId: 'r-llm-jev',
      step: 1,
      mode: 'llm-jev',
      task: 'fix f',
      limits: DEFAULT_LIMITS,
      signal: new AbortController().signal,
      redact: (s) => s,
      generation: { temperature: null, maxTokens: 1500 },
      workspace,
      sandbox,
      workspaceInfo: info,
      changedFiles: [],
      createdThisRun: new Set<string>(),
      patchTargets: [],
      now: () => 0,
      wallRemainingMs: () => 1_000_000,
      emit: () => undefined,
      async ask(stage, _state, questions: Record<string, Question>, annotate) {
        asked.push({ stage, ids: Object.keys(questions) });
        const answers: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) answers[id] = scoreA({ 1: 1 });
        const rows = Object.keys(questions).map((id) => ({ step: 1, stage, id, question: questions[id]!, answer: answers[id]!, probability: 1, confidence: 1, latencyMs: 1, requestHash: 'h' }));
        annotate?.(answers, rows);
        return { answers, rows, latencyMs: 1 };
      },
      generate: () => Promise.reject(new Error('not used')),
      noteMalformed: () => undefined,
      startCandidateRefresh: () => undefined,
    };
  }
  const common = (): JsonObject =>
    buildCommonState({
      task: 'fix f',
      plan: emptyPlan(),
      recent: [],
      workspace: { root: '/ws', git: true, hasTests: true, testCommand: 'pytest -q', changedFiles: [], createdThisRun: [], lastChangeStep: null, lastTestRun: null, sandbox: 'none' },
      budget: { stepsUsed: 0, stepsMax: 40, spentUsd: 0, capUsd: 2 },
      redact: (x) => x,
    });
  const intent = { intent: 'edit' as const, answer: 'edit' as const, probability: 1 };

  it('a verified patch is ok before ctx.ask; a non-test `run` asks the two harm Scores and is gated by them alone', async () => {
    const asked: { stage: StageName; ids: string[] }[] = [];
    const ctx = stageCtx(asked);
    const verified = await runRiskStage(ctx, common(), patch(evidence()), intent);
    expect(asked).toEqual([]);
    expect(verified.risk.verdict).toBe('ok');
    expect(verified.risk.reason).toMatch(/^risk 0\.00 \(ok\) by code: verified patch/);
    expect(verified.matchesIntent).toBe(1);
    expect(verified.evidenceConsistent).toBeNull();
    expect(verified.targets.map((t) => t.path)).toEqual(['src/a.py']);
    // change 6: an unverified patch no longer asks — only a `run` that is not the workspace test command does
    const nonTestRun: Proposal = { goal: 'install', action: { kind: 'run', command: 'pip install requests' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
    const gated = await runRiskStage({ ...ctx, step: 2 }, common(), nonTestRun, intent);
    expect(asked).toEqual([{ stage: 'risk', ids: ['destructive', 'irreversible'] }]);
    // level 1 on both harm dims: risk 0.25, ok; the alignment dims were not asked and read as level 0
    expect(gated.risk).toMatchObject({ verdict: 'ok', risk: 0.25 });
    expect(gated.risk.dims.destructive.level).toBe(1);
    expect(gated.risk.dims.plan_mismatch.level).toBe(0);
    expect(gated.risk.reason).toContain('harm-only (llm-jev)');
  });
  /**
   * docs/research/llm-jev/oos-analysis-2026-09-22.md change 6 (the half left for `src/jev-modes/stages/risk.ts`):
   * `risk|destructive` and `risk|irreversible` were asked 51 times each for ONE distinct answer, because on the synth
   * path a proposal is only `patch` / `run <the workspace test command>` / `done`. `harmScoresDue` keeps the family
   * for exactly the case the analysis names — "destructive `run` actions outside the synth path" — and drops it
   * everywhere else; the unasked dimensions keep the level-0 / confidence-1 record `runHarmOnlyRiskStage` writes.
   */
  describe('change 6: the harm Scores are due for a `run` that is not the workspace test command', () => {
    const test = { command: 'pytest -q', runner: 'pytest' as const };
    const run = (command: string): Proposal => ({ goal: 'run', action: { kind: 'run', command }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' });

    it('harmScoresDue: only a `run`, and only one that is not the workspace test command; a `run` outside the synth path always asks', () => {
      expect(harmScoresDue('run', 'rm -rf build/', test)).toBe(true);
      expect(harmScoresDue('run', 'pytest -q', test)).toBe(false);
      expect(harmScoresDue('run', 'pytest -q tests/test_a.py::test_f', test)).toBe(false);
      // shell composition around the runner is not the verification run — it asks
      expect(harmScoresDue('run', 'pytest -q; rm -rf build', test)).toBe(true);
      // outside the synth path there is no detected workspace test command: every `run` asks
      expect(harmScoresDue('run', 'pytest -q', null)).toBe(true);
      expect(harmScoresDue('run', 'rm -rf build/', null)).toBe(true);
      for (const kind of ['patch', 'edit', 'write', 'done', 'read'] as const) expect(harmScoresDue(kind, null, test)).toBe(false);
    });

    it('a synth-path `run pytest -q`, an unverified patch and a partial `done` ask zero harm questions; `run rm -rf build/` asks both', async () => {
      const asked: { stage: StageName; ids: string[] }[] = [];
      const ctx = stageCtx(asked);
      const done: Proposal = { goal: 'done', action: { kind: 'done', summary: 'as far as it goes' }, plan: { done: [], remaining: ['more'], openProblems: [] }, rawText: '' };

      const verification = await runRiskStage(ctx, common(), run('pytest -q'), intent);
      expect(asked).toEqual([]);
      expect(verification.risk.verdict).toBe('ok');

      const unverified = await runRiskStage({ ...ctx, step: 2 }, common(), patch(evidence({ after: { passed: 1, failed: 1, errors: 0, total: 2 }, newlyPassing: [], selection: 'sieve' })), intent);
      expect(asked).toEqual([]);
      expect(unverified.risk.verdict).toBe('ok');
      expect(unverified.risk.reason).toMatch(/^risk 0\.00 \(ok\) by code: patch: the harm Scores gate a `run`/);
      for (const d of Object.values(unverified.risk.dims)) expect(d).toMatchObject({ level: 0, risk: 0, confidence: 1, expected: 0 });

      const partial = await runRiskStage({ ...ctx, step: 3 }, common(), done, intent);
      expect(asked).toEqual([]);
      expect(partial.risk.verdict).toBe('ok');

      const harmful = await runRiskStage({ ...ctx, step: 4 }, common(), run('rm -rf build/'), intent);
      expect(asked).toEqual([{ stage: 'risk', ids: ['destructive', 'irreversible'] }]);
      expect(harmful.risk.dims.destructive.level).toBe(1);
      expect(harmful.risk.reason).toContain('harm-only (llm-jev)');
    });

    it('a jev-on step is byte-identical to before: the four Scores plus matches_intent, and the same reason', async () => {
      const asked: { stage: StageName; ids: string[] }[] = [];
      const ctx: StageContext = { ...stageCtx(asked), mode: 'jev-on' };
      const r = await runRiskStage(ctx, common(), run('rm -rf build/'), intent);
      expect(asked).toEqual([{ stage: 'risk', ids: ['destructive', 'out_of_scope', 'plan_mismatch', 'irreversible', 'matches_intent'] }]);
      expect(r.risk.reason).toBe(JEV_ON_REASON);
    });
  });
});
