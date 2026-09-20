import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../src/core/types.js';
import { emptyPlan } from '../../../src/loop/plan.js';
import { buildCommonState, buildContextState, buildJudgeState, buildRiskState, testsCurrent } from '../../../src/loop/state.js';
import { buildContextQuestions, prefilterCandidates, selectCandidates } from '../../../src/loop/stages/context.js';
import { buildIntentQuestions } from '../../../src/loop/stages/intent.js';
import { buildJudgeQuestions } from '../../../src/loop/stages/judge.js';
import { buildReplanQuestions } from '../../../src/loop/stages/replan.js';
import { assertQuestionBatch } from '../../../src/jev/questions.js';
import { execResult } from './fakes.js';

const redact = (s: string): string => s.replaceAll('sk-or-v1-SECRETSECRETSECRETSECRET', '[REDACTED]');

function common(): JsonObject {
  return buildCommonState({
    task: 'Fix f (key sk-or-v1-SECRETSECRETSECRETSECRET)',
    plan: { ...emptyPlan(), remaining: ['x'.repeat(500)] },
    recent: [{ step: 1, intent: 'edit', action: 'edit a', outcome: 'executed', shownFiles: [], notes: [], output: 'sk-or-v1-SECRETSECRETSECRETSECRET out' }],
    workspace: { root: '/ws', git: true, hasTests: true, testCommand: 'pytest -q', changedFiles: ['a'], createdThisRun: [], lastChangeStep: 2, lastTestRun: { step: 1, command: 'pytest -q', passed: 1, failed: 0, errors: 0, allPassed: true }, sandbox: 'none' },
    budget: { stepsUsed: 2, stepsMax: 40, spentUsd: 0.123456, capUsd: 2 },
    redact,
  });
}

describe('Jev state (§5.5)', () => {
  it('common state: code-computed testsCurrent, redacted strings, bounded plan items', () => {
    const s = common();
    expect(JSON.stringify(s)).not.toContain('SECRETSECRET');
    const ws = s['workspace'] as { testsCurrent: boolean; lastTestRun: { step: number } };
    expect(ws.testsCurrent).toBe(false); // lastChangeStep 2 > lastTestRun.step 1
    expect(testsCurrent({ step: 3, command: '', passed: 1, failed: 0, errors: 0, allPassed: true }, 2)).toBe(true);
    expect(testsCurrent(null, null)).toBe(false);
    expect(((s['plan'] as { remaining: string[] }).remaining[0] ?? '').length).toBeLessThanOrEqual(200);
    expect((s['budget'] as { spentUsd: number }).spentUsd).toBe(0.1235);
  });
  it('context state is path-keyed with shared criteria; questions name the file literally; selection caps hold', () => {
    const views = prefilterCandidates('Fix src/a.py and tests', [{ path: 'src/a.py', bytes: 10 }, { path: 'big.py', bytes: 100_000 }, { path: 'z.py', bytes: 5 }], new Set(['z.py']));
    expect(views.map((v) => v.path)).toEqual(['src/a.py', 'z.py', 'big.py']);
    expect(views[0]).toMatchObject({ mentionsInTask: 1, touchedThisRun: false });
    expect(views[1]).toMatchObject({ touchedThisRun: true });
    const st = buildContextState(common(), { choice: 'edit', probability: 0.8 }, views);
    expect(Object.keys(st['candidates'] as object)).toEqual(['src/a.py', 'z.py', 'big.py']);
    expect(Array.isArray(st['candidates'])).toBe(false);
    expect((st['criteria'] as { context: { definition: string } }).context.definition.length).toBeGreaterThan(20);
    const qs = buildContextQuestions(views, 'edit');
    expect(String(qs['show:src/a.py']!.instructions)).toContain('`src/a.py`');
    expect(String(qs['show:src/a.py']!.instructions)).toContain('candidates["src/a.py"]');
    expect(qs['show:src/a.py']).not.toHaveProperty('criteria');
    const many = Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.py`, bytes: 10_000 }));
    expect(prefilterCandidates('t', many, new Set())).toHaveLength(300);
    const probs = new Map(many.map((c) => [c.path, 0.9]));
    const sel = selectCandidates(prefilterCandidates('t', many, new Set()), probs);
    expect(sel).toHaveLength(6); // 60 KB / 10 KB
    const smallSel = selectCandidates(prefilterCandidates('t', many.map((c) => ({ ...c, bytes: 10 })), new Set()), probs);
    expect(smallSel).toHaveLength(12);
    expect(selectCandidates(views, new Map([['src/a.py', 0.49]]))).toEqual([]);
  });
  it('risk state carries proposal.planClaim, claimsDone and target(s); judge state carries executed with head+tail output and claims', () => {
    const proposal = { goal: 'g', action: { kind: 'edit' as const, path: 'a', old: 'x', new: 'y' }, plan: { done: ['d'], remaining: [], openProblems: [] }, rawText: '' };
    const rs = buildRiskState(common(), proposal, { choice: 'edit', probability: 0.8 }, [{ path: 'a', existsBefore: true, tracked: true, createdThisRun: false, recoverable: true }], redact);
    expect(rs['proposal']).toMatchObject({ goal: 'g', claimsDone: true, planClaim: { done: ['d'] }, target: { path: 'a', recoverable: true } });
    const patch = { ...proposal, action: { kind: 'patch' as const, diff: 'd' } };
    const ps = buildRiskState(common(), patch, { choice: 'edit', probability: 0.8 }, [{ path: 'a', existsBefore: false, tracked: false, createdThisRun: false, recoverable: false }], redact);
    expect((ps['proposal'] as { targets: unknown[] }).targets).toHaveLength(1);
    const out = 'H'.repeat(5000) + 'T'.repeat(5000);
    const js = buildJudgeState(common(), { ...proposal, action: { kind: 'run', command: 'pytest -q' } }, { outcome: { status: 'executed', exec: execResult({ stdout: out, exitCode: 1 }), summary: '', changedFiles: [] }, output: out, changedFiles: [], tests: { command: 'pytest -q', parsed: { passed: 1, failed: 1, errors: 0, skipped: 0 }, allPassed: false } }, ['claim one'], redact);
    const ex = js['executed'] as { output: string; exitCode: number; tests: { allPassed: boolean; parsed: { failed: number } } };
    expect(ex.output.length).toBeLessThan(4_200);
    expect(ex.output.endsWith('T'.repeat(1000))).toBe(true);
    expect(ex.exitCode).toBe(1);
    expect(ex.tests).toMatchObject({ allPassed: false, parsed: { failed: 1 } });
    expect(js['claims']).toEqual(['claim one']);
    const noop = buildJudgeState(common(), { ...proposal, action: { kind: 'done', summary: 'all done' } }, { outcome: { status: 'noop', summary: 'all done' }, output: '', changedFiles: [], tests: null }, [], redact);
    expect(noop['executed']).toEqual({ action: 'done', summary: 'all done', exitCode: null, output: '' });
  });
  it('question sets validate: intent (Choice + 5 paired Nouls + plan_still_valid), judge with done_<j>, replan', () => {
    const intent = buildIntentQuestions();
    expect(Object.keys(intent)).toEqual(['intent', 'can_investigate', 'can_edit', 'can_verify', 'can_fix_environment', 'can_finish', 'plan_still_valid']);
    const ic = intent['intent']!;
    if (ic.type === 'choice') expect(Object.keys(ic.criteria)).toContain('none_of_these');
    assertQuestionBatch(intent);
    const judge = buildJudgeQuestions({ testsUnparsed: true, claims: ['a', 'b'] });
    expect(Object.keys(judge)).toEqual(['succeeded', 'error_present', 'new_information', 'tests_pass_unparsed', 'done_0', 'done_1']);
    expect(String(judge['done_1']!.instructions)).toContain('`claims[1]`');
    for (const q of Object.values(judge)) if (q.type === 'noul') expect((q.criteria!.false as { examples: string[] }).examples.length).toBeGreaterThanOrEqual(2);
    const replan = buildReplanQuestions();
    expect(Object.keys(replan)).toEqual(['next_move', 'can_change_approach', 'can_gather_context', 'can_fix_environment', 'can_revert_changes', 'can_stop_and_report', 'task_impossible']);
  });
});
