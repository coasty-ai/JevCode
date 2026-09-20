import { describe, expect, it } from 'vitest';
import type { JsonObject, ProposalEvidence } from '../../../src/core/types.js';
import { emptyPlan } from '../../../src/loop/plan.js';
import { buildCommonState, buildContextState, buildIntentState, buildJudgeState, buildRiskState, commonChangeUnverified, commonLastRun, commonRemaining, evidenceVerified, ledgerItems, recentOutputAt, testsCurrent } from '../../../src/loop/state.js';
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
    // a `done` executes nothing (exitCode null, output ''), and since ladder round 6 carries the engine's last run: common() has a run at step 1 and a change at step 2, so it is stale
    const noop = buildJudgeState(common(), { ...proposal, action: { kind: 'done', summary: 'all done' } }, { outcome: { status: 'noop', summary: 'all done' }, output: '', changedFiles: [], tests: null }, [], redact);
    expect(noop['executed']).toMatchObject({ action: 'done', summary: 'all done', exitCode: null, output: '', testsCurrent: false, tests: { command: 'pytest -q', allPassed: true }, lastRun: { step: 1, workspaceUnchangedSince: false } });
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

describe('the judge state of a `done` after a test run (§5.5; rungs report §14.3, ladder round 6)', () => {
  const doneProposal = { goal: 'all 10 tests pass; 2 fixes committed', action: { kind: 'done' as const, summary: 'all 10 tests pass; 2 fixes committed' }, plan: { done: ['verify the full test suite passes'], remaining: [], openProblems: [] }, rawText: '' };
  const noop = { outcome: { status: 'noop' as const, summary: 'all 10 tests pass; 2 fixes committed' }, output: '', changedFiles: [], tests: null };
  const runOutput = '..........                                                               [100%]\n';
  /** grades step 11 of ladder round 5: patch at 7, green run at 10, done at 11; recent = steps 8–11 (the step-11 entry is the provisional done) */
  function greenCommon(overrides: Partial<Parameters<typeof buildCommonState>[0]['workspace']> = {}, recentOffset = 0): JsonObject {
    return buildCommonState({
      task: 'Fix grades',
      plan: { ...emptyPlan(), remaining: ['verify the full test suite passes'] },
      recent: [
        { step: 8 + recentOffset, intent: 'investigate', action: 'read src/grades.py', outcome: 'executed', shownFiles: [], notes: [], output: '### src/grades.py' },
        { step: 9 + recentOffset, intent: 'investigate', action: 'read tests/test_grades.py', outcome: 'executed', shownFiles: [], notes: [], output: '### tests/test_grades.py' },
        { step: 10 + recentOffset, intent: 'verify', action: 'run python3 -m pytest -q', outcome: 'executed', shownFiles: [], notes: [], output: runOutput, judge: { succeeded: 0.95, errorPresent: 0.02, newInfo: 0.05, tests: { source: 'parsed', allPassed: true, passed: 10, failed: 0, errors: 0 }, doneClaims: [] } },
        { step: 11 + recentOffset, intent: 'finish', action: 'done', outcome: 'noop', shownFiles: [], notes: [] },
      ],
      workspace: { root: '/ws', git: true, hasTests: true, testCommand: 'python3 -m pytest -q', changedFiles: ['src/grades.py'], createdThisRun: [], lastChangeStep: 7, lastTestRun: { step: 10, command: 'python3 -m pytest -q', passed: 10, failed: 0, errors: 0, allPassed: true }, sandbox: 'none', ...overrides },
      budget: { stepsUsed: 11, stepsMax: 20, spentUsd: 0.005, capUsd: 0.15 },
      redact,
    });
  }
  it('a `done` after a green, current run carries the run: the `run` step\'s `tests` fields, `testsCurrent: true`, and a `lastRun` block with allPassed/total/command/step/workspaceUnchangedSince and the bounded tail from `recent`', () => {
    const c = greenCommon();
    expect(commonLastRun(c)).toEqual({ step: 10, command: 'python3 -m pytest -q', passed: 10, failed: 0, errors: 0, allPassed: true, testsCurrent: true });
    const js = buildJudgeState(c, doneProposal, noop, [], redact);
    expect(js['executed']).toEqual({
      action: 'done',
      summary: 'all 10 tests pass; 2 fixes committed',
      exitCode: null,
      output: '',
      tests: { command: 'python3 -m pytest -q', parsed: { passed: 10, failed: 0, errors: 0 }, allPassed: true },
      testsCurrent: true,
      lastRun: { step: 10, command: 'python3 -m pytest -q', allPassed: true, total: 10, passed: 10, failed: 0, errors: 0, workspaceUnchangedSince: true, output: runOutput },
    });
    // the same `tests` shape a `run` step's state gets
    const runState = buildJudgeState(c, { ...doneProposal, action: { kind: 'run', command: 'python3 -m pytest -q' } }, { outcome: { status: 'executed', exec: execResult({ stdout: runOutput }), summary: 'exit 0', changedFiles: [] }, output: runOutput, changedFiles: [], tests: { command: 'python3 -m pytest -q', parsed: { passed: 10, failed: 0, errors: 0, skipped: 0 }, allPassed: true } }, [], redact);
    expect((runState['executed'] as JsonObject)['tests']).toEqual((js['executed'] as JsonObject)['tests']);
    expect(js['proposal']).toMatchObject({ claimsDone: true });
  });
  it('a `done` after a stale run (a change since) is marked `testsCurrent: false` / `workspaceUnchangedSince: false`; a failing run keeps its counts', () => {
    const stale = buildJudgeState(greenCommon({ lastChangeStep: 11 }), doneProposal, noop, [], redact);
    expect(stale['executed']).toMatchObject({ testsCurrent: false, tests: { allPassed: true }, lastRun: { allPassed: true, workspaceUnchangedSince: false } });
    const red = buildJudgeState(greenCommon({ lastTestRun: { step: 10, command: 'python3 -m pytest -q', passed: 9, failed: 1, errors: 0, allPassed: false } }), doneProposal, noop, [], redact);
    expect(red['executed']).toMatchObject({ testsCurrent: true, tests: { allPassed: false, parsed: { failed: 1 } }, lastRun: { allPassed: false, total: 10, workspaceUnchangedSince: true } });
  });
  it('the tail: from `recent` while the run is in the window, null once it left, the engine-supplied `lastRunOutput` (bounded) when given; no run at all → `tests`/`lastRun` null', () => {
    // grades step 14: recent = 11–14, the step-10 run left the window
    const late = greenCommon({}, 3);
    expect(recentOutputAt(late, 10)).toBeNull();
    expect((buildJudgeState(late, doneProposal, noop, [], redact)['executed'] as JsonObject)['lastRun']).toMatchObject({ step: 10, allPassed: true, workspaceUnchangedSince: true, output: null });
    const long = 'H'.repeat(5000) + 'T'.repeat(5000);
    const supplied = buildJudgeState(late, doneProposal, { ...noop, lastRunOutput: long }, [], redact);
    const tail = ((supplied['executed'] as JsonObject)['lastRun'] as JsonObject)['output'] as string;
    expect(tail.length).toBeLessThan(4_200);
    expect(tail.endsWith('T'.repeat(1000))).toBe(true);
    const none = buildJudgeState(greenCommon({ lastTestRun: null }), doneProposal, noop, [], redact);
    expect(none['executed']).toEqual({ action: 'done', summary: 'all 10 tests pass; 2 fixes committed', exitCode: null, output: '', tests: null, lastRun: null });
    expect(commonLastRun(greenCommon({ lastTestRun: null }))).toBeNull();
  });
});

describe('proposal.evidence in the Jev state (jev-only, docs/JEV-ONLY-DESIGN.md §5.1)', () => {
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
  const patch = { goal: 'apply verified fix', action: { kind: 'patch' as const, diff: 'd' }, plan: { done: [], remaining: ['fix tests/test_g.py::test_weighted in src/g.py'], openProblems: [] }, rawText: '' };

  it('risk state: the contract fields, bounded, plus the code-computed `verified`; absent without evidence', () => {
    const rs = buildRiskState(common(), { ...patch, evidence }, { choice: 'edit', probability: 0.8 }, [], redact);
    expect((rs['proposal'] as JsonObject)['evidence']).toEqual({ ...evidence, verified: true });
    const regressed = { ...evidence, newlyFailing: ['tests/test_g.py::test_other'] };
    expect(((buildRiskState(common(), { ...patch, evidence: regressed }, { choice: 'edit', probability: 0.8 }, [], redact)['proposal'] as JsonObject)['evidence'] as JsonObject)['verified']).toBe(false);
    const noProgress = { ...evidence, after: { ...evidence.after, passed: 7 } };
    expect(evidenceVerified(noProgress)).toBe(false);
    expect('evidence' in (buildRiskState(common(), patch, { choice: 'edit', probability: 0.8 }, [], redact)['proposal'] as JsonObject)).toBe(false);
    // bounded and redacted like every other state string
    const many = { ...evidence, newlyPassing: Array.from({ length: 30 }, (_, i) => `t${i} sk-or-v1-SECRETSECRETSECRETSECRET`) };
    const bounded = (buildRiskState(common(), { ...patch, evidence: many }, { choice: 'edit', probability: 0.8 }, [], redact)['proposal'] as JsonObject)['evidence'] as { newlyPassing: string[] };
    expect(bounded.newlyPassing).toHaveLength(20);
    expect(JSON.stringify(bounded)).not.toContain('SECRETSECRET');
  });

  it('judge state carries the same evidence next to the executed run\'s counts', () => {
    const run = { ...patch, action: { kind: 'run' as const, command: 'python3 -m pytest -q' }, evidence };
    const js = buildJudgeState(common(), run, { outcome: { status: 'executed', exec: execResult({ stdout: '8 passed, 2 failed', exitCode: 1 }), summary: '', changedFiles: [] }, output: '8 passed, 2 failed', changedFiles: [], tests: { command: 'python3 -m pytest -q', parsed: { passed: 8, failed: 2, errors: 0, skipped: 0 }, allPassed: false } }, [], redact);
    expect((js['proposal'] as JsonObject)['evidence']).toMatchObject({ verified: true, after: { passed: 8 } });
    expect((js['executed'] as JsonObject)['tests']).toMatchObject({ parsed: { passed: 8, failed: 2 } });
  });

  it('intent state: `mode` and `ledger.items` only in jev-only with fixed-form plan items; ledgerItems and commonChangeUnverified are code-computed', () => {
    const items = ledgerItems(['fix tests/test_a.py::test_x in src/a.py', 'verify the full test suite passes', 'fix gcd(13, 13), +2 more in gcd.py', 'install deps', 'fix it']);
    expect(items).toEqual(['fix tests/test_a.py::test_x in src/a.py', 'fix gcd(13, 13), +2 more in gcd.py']);
    const st = buildIntentState(common(), { mode: 'jev-only', ledger: items });
    expect(st['mode']).toBe('jev-only');
    expect(st['ledger']).toEqual({ items });
    expect(buildIntentState(common(), { mode: 'jev-on', ledger: items })).toEqual(common());
    expect(buildIntentState(common(), { mode: 'jev-only', ledger: [] })).toEqual(common());
    expect(buildIntentState(common())).toEqual(common());
    // common(): lastChangeStep 2 after a test run at step 1 → a change is unverified
    expect(commonChangeUnverified(common())).toBe(true);
    const current = { ...common(), workspace: { ...(common()['workspace'] as JsonObject), lastChangeStep: null, testsCurrent: true } };
    expect(commonChangeUnverified(current)).toBe(false);
    expect(commonRemaining(common())).toEqual([(common()['plan'] as { remaining: string[] }).remaining[0]]);
  });
});
