import { describe, expect, it } from 'vitest';

import type { Proposal } from '../../../../../src/core/types.js';
import { unifiedDiff } from '../../../../../src/jev-modes/synth/py/index.js';
import {
  MAX_PATCH_FILES,
  ProposalError,
  TEST_PATH_RE,
  deferredClaimNotes,
  doneReadiness,
  isClaimNote,
  isGoalItem,
  lastExecutedTestRun,
  ledgerLine,
  openProblemNotes,
  proposeDone,
  proposePatch,
  proposeRevert,
  proposeRun,
  remainingItems,
  reverseDiff,
  runActionLabel,
  splitClaims,
  testFilesChanged,
  testsLabel,
  traceRecord, VERIFY_ITEM } from '../../../../../src/jev-modes/synth/search/proposal.js';
import type { AppliedCandidate } from '../../../../../src/jev-modes/synth/types.js';
import { summary } from '../verify/helpers.js';
import { GCD_SRC, TEST_COMMAND, gcdApplied, makeCtx, makeGoal, makeMemory, makeTrace, patchEntry, runEntry, twoFileApplied } from './proposal-helpers.js';

// never `read`: the synthesizer holds every source file (jev-only-rungs-1-2.md §19.7)
const ALLOWED_KINDS = new Set(['patch', 'run', 'done']);

function parsesAsJson(p: Proposal): Record<string, unknown> {
  const v: unknown = JSON.parse(p.rawText);
  expect(typeof v).toBe('object');
  return v as Record<string, unknown>;
}

describe('proposePatch (§5.1 row 1)', () => {
  const g1 = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_gcd_big'], suspectedFiles: ['src/gcd.py'], status: 'fixed' });
  const g2 = makeGoal({ id: 'g2', tests: ['tests/test_lcm.py::test_lcm'], suspectedFiles: ['src/lcm.py'] });
  const g3 = makeGoal({ id: 'g3', tests: ['tests/test_x.py::test_x'], suspectedFiles: ['src/x.py'], status: 'parked', parkedReason: 'every source exhausted at 6 sites' });
  const g0 = makeGoal({ id: 'g0', tests: ['tests/test_done.py::test_done'], suspectedFiles: ['src/done.py'], status: 'fixed' });

  it('goal text, patch action with the candidate diff, nothing claimed, fixed-form remaining, notes only', () => {
    const applied = gcdApplied();
    const ctx = makeCtx({ plan: { done: [{ text: g0.planItem, evidence: { step: 2, judged: 0.95 } }], remaining: [g1.planItem, g2.planItem, g3.planItem] } });
    const mem = makeMemory({ goals: [g0, g1, g2, g3], committed: [applied] });
    const p = proposePatch(ctx, applied, g1, mem, undefined, makeTrace({ goalId: 'g1', winner: applied }));

    expect(p.goal).toBe('fix tests/test_gcd.py::test_gcd, +1 more in src/gcd.py:5 (mutation/arg_swap)');
    expect(p.action).toEqual({ kind: 'patch', diff: applied.diff });
    expect(p.plan.done).toEqual([]);
    // g0 is fixed and accepted → gone; g1 fixed but unclaimed → stays until the run step claims it; g2 open; g3 parked
    expect(p.plan.remaining).toEqual([g1.planItem, g2.planItem, g3.planItem, VERIFY_ITEM]);
    for (const item of p.plan.remaining.slice(0, -1)) expect(isGoalItem(item)).toBe(true);
    expect(p.plan.openProblems).toEqual([`${g3.planItem}: parked (every source exhausted at 6 sites)`]);
  });

  it('rawText is the GoalSearchTrace as JSON with the winner compacted (no file contents)', () => {
    const applied = gcdApplied();
    const ctx = makeCtx();
    const p = proposePatch(ctx, applied, g1, makeMemory({ goals: [g1] }), undefined, makeTrace({ goalId: 'g1', winner: applied }));
    const rec = parsesAsJson(p);
    expect(rec['kind']).toBe('search');
    expect(rec['goalId']).toBe('g1');
    expect(rec['runMode']).toBe('SIEVE');
    expect(rec['winner']).toEqual({ path: 'src/gcd.py', line: 5, kind: 'replace', source: 'mutation', op: 'arg_swap', text: 'return gcd(b, a % b)', files: ['src/gcd.py'] });
    expect(p.rawText).not.toContain(GCD_SRC);
    expect(p.rawText.length).toBeLessThan(2_000);
  });

  it('without a trace rawText is still JSON naming the goal and the edit', () => {
    const applied = gcdApplied();
    const p = proposePatch(makeCtx(), applied, g1, makeMemory({ goals: [g1] }));
    const rec = parsesAsJson(p);
    expect(rec['kind']).toBe('patch');
    expect(rec['goalId']).toBe('g1');
    expect(rec['ledger']).toBe('fixed 1, open 0, parked 0');
  });

  it('commit notes become human-readable openProblems entries', () => {
    const applied = gcdApplied();
    const overfit = proposePatch(makeCtx(), applied, g1, makeMemory({ goals: [g1] }), 'possible overfit');
    expect(overfit.plan.openProblems).toHaveLength(1);
    expect(overfit.plan.openProblems[0]).toMatch(/^possible overfit: arg_swap at src\/gcd\.py:5/);
    expect(parsesAsJson(overfit)['note']).toBe('possible overfit');
    const partial = proposePatch(makeCtx(), applied, g1, makeMemory({ goals: [g1] }), 'partial');
    expect(partial.plan.openProblems[0]).toMatch(/^partial fix: arg_swap at src\/gcd\.py:5 fixes some of tests\/test_gcd\.py::test_gcd, \+1 more/);
    // with the evidence the note says exactly what was measured (the progress-commit summary)
    const e = { kind: 'shadow_test_run' as const, command: TEST_COMMAND, before: { passed: 1, failed: 2, errors: 0, total: 3 }, after: { passed: 2, failed: 1, errors: 0, total: 3 }, newlyPassing: [g1.tests[0]!], newlyFailing: [], goalTests: g1.tests, selection: 'sieve' as const, candidatesTested: 5, arbitrated: false };
    const measured = proposePatch(makeCtx(), applied, g1, makeMemory({ goals: [g1] }), 'partial', undefined, e);
    expect(measured.plan.openProblems[0]).toBe('partial fix: 1 of 2 goal tests pass, no regressions; the remaining 1 stay open (arg_swap at src/gcd.py:5)');
    expect(measured.goal).toMatch(/^apply partial fix: 1 of 2 goal tests pass \(.*\) \(1→2 of 3\), no regressions; the remaining 1 stay open; mutation\/arg_swap at src\/gcd\.py:5$/);
    expect(measured.evidence).toEqual(e);
  });

  it('a two-file diff (composite unit) is allowed; three files or an empty diff are contract violations', () => {
    const two = twoFileApplied();
    expect(proposePatch(makeCtx(), two, g2, makeMemory({ goals: [g2] })).action.kind).toBe('patch');
    const three: AppliedCandidate = {
      ...two,
      files: [...two.files, { path: 'src/c.py', before: 'c = 1\n', after: 'c = 2\n' }],
      diff: two.diff + unifiedDiff('src/c.py', 'c = 1\n', 'c = 2\n'),
    };
    expect(() => proposePatch(makeCtx(), three, g2, makeMemory({ goals: [g2] }))).toThrow(ProposalError);
    expect(() => proposePatch(makeCtx(), three, g2, makeMemory({ goals: [g2] }))).toThrow(`at most ${MAX_PATCH_FILES}`);
    expect(() => proposePatch(makeCtx(), { ...two, diff: '' }, g2, makeMemory({ goals: [g2] }))).toThrow(/empty diff/);
  });
});

describe('proposeRun (§5.1 rows 2 and 3)', () => {
  const g1 = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd'], suspectedFiles: ['src/gcd.py'], status: 'fixed' });
  const g2 = makeGoal({ id: 'g2', tests: ['tests/test_lcm.py::test_lcm'], suspectedFiles: ['src/lcm.py'] });

  it('full run after a patch claims the goal item NOW and drops it from remaining', () => {
    const ctx = makeCtx({ plan: { remaining: [g1.planItem, g2.planItem], openProblems: ['note kept'] } });
    const p = proposeRun(ctx, TEST_COMMAND, 'full', g1, true, 90_000);
    expect(p.goal).toBe('verify the suite after fixing tests/test_gcd.py::test_gcd');
    expect(p.action).toEqual({ kind: 'run', command: TEST_COMMAND, timeoutMs: 90_000 });
    expect(p.plan).toEqual({ done: [g1.planItem], remaining: [g2.planItem], openProblems: ['note kept'] });
    expect(parsesAsJson(p)).toMatchObject({ kind: 'run', scope: 'full', claimed: [g1.planItem], goalId: 'g1' });
  });

  it('subset run on a budget hit leaves the plan unchanged and claims nothing', () => {
    const ctx = makeCtx({ plan: { remaining: [g1.planItem, g2.planItem] } });
    const p = proposeRun(ctx, 'pytest -q tests/test_lcm.py::test_lcm', 'subset', g2);
    expect(p.goal).toBe('record the failing behaviour of tests/test_lcm.py::test_lcm');
    expect(p.action).toEqual({ kind: 'run', command: 'pytest -q tests/test_lcm.py::test_lcm' });
    expect('timeoutMs' in p.action).toBe(false);
    expect(p.plan).toEqual({ done: [], remaining: [g1.planItem, g2.planItem], openProblems: [] });
  });

  it('claimDone on a goal that is not fixed (a partial commit) claims nothing: plan.done is one item per FIXED goal (§2.1)', () => {
    const open = makeGoal({ id: 'g2', tests: ['tests/test_lcm.py::test_lcm'], suspectedFiles: ['src/lcm.py'], status: 'open' });
    const ctx = makeCtx({ plan: { remaining: [open.planItem] } });
    const p = proposeRun(ctx, TEST_COMMAND, 'full', open, true);
    expect(p.goal).toBe('verify the suite after fixing tests/test_lcm.py::test_lcm');
    expect(p.plan).toEqual({ done: [], remaining: [open.planItem], openProblems: [] });
    expect(parsesAsJson(p)).toMatchObject({ claimed: [], unclaimed: 'g2 is open, not fixed' });
  });

  it('a trace (the budget-hit search) is recorded in rawText, compacted', () => {
    const applied = gcdApplied();
    const p = proposeRun(makeCtx(), 'pytest -q tests/test_gcd.py::test_gcd', 'subset', g1, false, undefined, makeTrace({ goalId: 'g1', outcome: 'budget', winner: applied }));
    const rec = parsesAsJson(p);
    expect(rec['trace']).toMatchObject({ kind: 'search', goalId: 'g1', outcome: 'budget', candidatesTested: 120 });
    expect(p.rawText).not.toContain(GCD_SRC);
  });

  it('without a goal the texts name the suite; claimDone without a goal and an empty command throw', () => {
    expect(proposeRun(makeCtx(), TEST_COMMAND, 'full').goal).toBe('run the full test suite');
    expect(proposeRun(makeCtx(), TEST_COMMAND, 'subset').goal).toBe('record the failing behaviour of the test suite');
    expect(() => proposeRun(makeCtx(), TEST_COMMAND, 'full', undefined, true)).toThrow(ProposalError);
    expect(() => proposeRun(makeCtx(), '   ', 'full')).toThrow(ProposalError);
  });
});

describe('lastExecutedTestRun: the engine has seen the oracle on the current workspace', () => {
  it('finds the last executed run with parsed counts', () => {
    const r = lastExecutedTestRun([patchEntry({ step: 1 }), runEntry({ step: 2, passed: 4, failed: 1 }), runEntry({ step: 3, passed: 5 })]);
    expect(r).toEqual({ step: 3, action: `run ${TEST_COMMAND}`, passed: 5, failed: 0, errors: 0, allPassed: true });
  });
  it('null when a patch/edit/write executed after the run, when the run failed to execute, or when counts were not parsed', () => {
    expect(lastExecutedTestRun([runEntry({ step: 2, passed: 5 }), patchEntry({ step: 3 })])).toBeNull();
    expect(lastExecutedTestRun([runEntry({ step: 2, passed: 5, outcome: 'blocked' })])).toBeNull();
    expect(lastExecutedTestRun([runEntry({ step: 2, passed: 5, parsed: false })])).toBeNull();
    expect(lastExecutedTestRun([])).toBeNull();
  });
  it('a patch that did not apply does not hide the earlier run (the workspace did not change)', () => {
    expect(lastExecutedTestRun([runEntry({ step: 2, passed: 5 }), patchEntry({ step: 3, outcome: 'failed', reason: 'PatchError' })])?.step).toBe(2);
  });
});

describe('proposeDone (§5.5): the conditions table', () => {
  const gFixed = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd'], suspectedFiles: ['src/gcd.py'], status: 'fixed' });
  const gFixed2 = makeGoal({ id: 'g2', tests: ['tests/test_lcm.py::test_lcm', 'tests/test_lcm.py::test_lcm2'], suspectedFiles: ['src/lcm.py'], status: 'fixed' });
  const gParked = makeGoal({ id: 'g3', tests: ['tests/test_x.py::test_x'], suspectedFiles: ['src/x.py'], status: 'parked', parkedReason: 'fix needs a name outside the vocabulary' });
  const green = summary({ command: TEST_COMMAND, passing: ['a', 'b', 'c', 'd', 'e'], failing: [] });
  const applied = gcdApplied();

  it('green: executed full-suite run, all pass, tests/ untouched → done with the measured summary and every fixed item claimed if unaccepted', () => {
    const ctx = makeCtx({
      window: [patchEntry({ step: 4 }), runEntry({ step: 5, passed: 5 })],
      plan: { done: [{ text: gFixed.planItem, evidence: { step: 3, judged: 0.9 } }], remaining: [gFixed2.planItem] },
    });
    const mem = makeMemory({ baseline: green, goals: [gFixed, gFixed2], committed: [applied, applied] });
    const p = proposeDone(ctx, mem, 'green');
    expect(p.action).toEqual({ kind: 'done', summary: 'all 5 tests pass; 2 fixes committed' });
    // the green done claims the unaccepted fixed item and the standing verification item (the green run in recent is its evidence)
    expect(p.plan).toEqual({ done: [gFixed2.planItem, VERIFY_ITEM], remaining: [], openProblems: [] });
    expect(parsesAsJson(p)).toMatchObject({ kind: 'done', mode: 'green', passed: 5, committed: 2 });
  });

  it('green but the engine has not executed a run since the last patch → the full-suite run, with the reason as a note', () => {
    for (const window of [[], [patchEntry({ step: 4 })], [runEntry({ step: 3, passed: 5 }), patchEntry({ step: 4 })]]) {
      const ctx = makeCtx({ window, plan: { remaining: [gFixed.planItem] } });
      const p = proposeDone(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [applied] }), 'green');
      expect(p.action).toEqual({ kind: 'run', command: TEST_COMMAND });
      expect(p.goal).toBe('run the full test suite');
      // §5.1 row 2: the run claims the fixed goal so the engine's done_<j> Noul judges it on this run's parsed output
      expect(p.plan.done).toEqual([gFixed.planItem]);
      expect(p.plan.remaining).toEqual([VERIFY_ITEM]);
      expect(p.plan.openProblems).toEqual(['the engine has not run the test suite on the current workspace']);
    }
  });

  it('green but the executed run shows failures → run again, naming the counts', () => {
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 4, failed: 1 })] });
    const p = proposeDone(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [applied] }), 'green');
    expect(p.action.kind).toBe('run');
    expect(p.plan.openProblems[0]).toBe('the last executed run shows 4 passed, 1 failed, 0 errors');
  });

  it('a goal-subset run is not the full suite: label differs and the count is below the baseline → run; equal count → accepted', () => {
    const subset = makeCtx({ window: [runEntry({ step: 5, command: 'pytest -q tests/test_gcd.py::test_gcd', passed: 1 })] });
    const p1 = proposeDone(subset, makeMemory({ baseline: green, goals: [gFixed], committed: [applied] }), 'green');
    expect(p1.action.kind).toBe('run');
    expect(p1.plan.openProblems[0]).toMatch(/is not the full suite/);
    const sameCount = makeCtx({ window: [runEntry({ step: 5, command: 'python3 -m pytest -q', passed: 5 })] });
    expect(proposeDone(sameCount, makeMemory({ baseline: green, goals: [gFixed], committed: [applied] }), 'green').action.kind).toBe('done');
  });

  it('a committed edit under tests/ blocks done even when everything passes', () => {
    const testEdit: AppliedCandidate = { ...applied, files: [{ path: 'tests/test_gcd.py', before: 'a\n', after: 'b\n' }], diff: unifiedDiff('tests/test_gcd.py', 'a\n', 'b\n') };
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 5 })] });
    const p = proposeDone(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [applied, testEdit] }), 'green');
    expect(p.action.kind).toBe('run');
    expect(p.plan.openProblems[0]).toBe('a committed edit touched test file tests/test_gcd.py; it must be reverted');
  });

  it('an unarbitrated batch (guard pending) blocks done', () => {
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 5 })] });
    const p = proposeDone(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [applied], guardPending: true }), 'green');
    expect(p.action.kind).toBe('run');
    expect(p.plan.openProblems[0]).toMatch(/not been arbitrated/);
  });

  it('partial: every goal parked → honest done with the parked items still remaining and reasons as notes', () => {
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 4, failed: 1 })], plan: { remaining: [gFixed.planItem, gParked.planItem] } });
    const p = proposeDone(ctx, makeMemory({ goals: [gFixed, gParked], committed: [applied] }), 'partial');
    expect(p.action).toEqual({ kind: 'done', summary: 'partial: fixed 1 of 2 failing tests; tests/test_x.py::test_x: fix needs a name outside the vocabulary' });
    expect(p.plan.done).toEqual([gFixed.planItem]);
    expect(p.plan.remaining).toEqual([gParked.planItem, VERIFY_ITEM]);
    expect(p.plan.openProblems).toEqual([`${gParked.planItem}: parked (fix needs a name outside the vocabulary)`]);
    expect(parsesAsJson(p)).toMatchObject({ kind: 'done', mode: 'partial', fixedTests: 1, totalTests: 2 });
  });

  it('partial without an executed run first makes the engine see the current tests', () => {
    const ctx = makeCtx({ window: [patchEntry({ step: 4 })] });
    const p = proposeDone(ctx, makeMemory({ goals: [gParked], committed: [] }), 'partial');
    expect(p.action).toEqual({ kind: 'run', command: TEST_COMMAND });
    expect(p.plan.openProblems).toEqual([`${gParked.planItem}: parked (fix needs a name outside the vocabulary)`, 'the engine has not run the test suite on the current workspace']);
  });

  it('partial is also withheld while a committed edit touches a test file (§5.5 condition 2 applies to every done)', () => {
    const testEdit: AppliedCandidate = { ...applied, files: [{ path: 'tests/test_gcd.py', before: 'a\n', after: 'b\n' }], diff: unifiedDiff('tests/test_gcd.py', 'a\n', 'b\n') };
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 4, failed: 1 })], plan: { remaining: [gParked.planItem] } });
    const p = proposeDone(ctx, makeMemory({ goals: [gFixed, gParked], committed: [applied, testEdit] }), 'partial');
    expect(p.action).toEqual({ kind: 'run', command: TEST_COMMAND });
    // the run claims the fixed goal (its parsed output is the evidence); the parked one stays remaining
    expect(p.plan.done).toEqual([gFixed.planItem]);
    expect(p.plan.remaining).toEqual([gParked.planItem, VERIFY_ITEM]);
    expect(p.plan.openProblems).toContain('a committed edit touched test file tests/test_gcd.py; it must be reverted');
    // the green-only blockers (full suite, guard) do not hold a partial back
    const failing = makeCtx({ window: [runEntry({ step: 5, command: 'pytest -q tests/test_x.py::test_x', passed: 0, failed: 1 })] });
    expect(proposeDone(failing, makeMemory({ goals: [gFixed, gParked], committed: [applied], guardPending: true }), 'partial').action.kind).toBe('done');
  });

  it('after a resume the commit count comes from the durable hash list, and the trace goes into rawText', () => {
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 5 })] });
    const p = proposeDone(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [], committedDiffHashes: ['a'.repeat(12), 'b'.repeat(12)] }), 'green', makeTrace({ goalId: '', outcome: 'fixed' }));
    expect(p.action).toEqual({ kind: 'done', summary: 'all 5 tests pass; 2 fixes committed' });
    expect(parsesAsJson(p)).toMatchObject({ committed: 2, trace: { kind: 'search', outcome: 'fixed' } });
  });

  it('no test command anywhere → ProposalError rather than an unverifiable done', () => {
    const ctx = makeCtx({ testCommand: null });
    expect(() => proposeDone(ctx, makeMemory({ baseline: null, goals: [gFixed] }), 'green')).toThrow(ProposalError);
  });

  it('doneReadiness exposes each condition', () => {
    const ctx = makeCtx({ window: [runEntry({ step: 5, passed: 5 })] });
    const r = doneReadiness(ctx, makeMemory({ baseline: green, goals: [gFixed], committed: [applied] }));
    expect(r).toMatchObject({ green: true, testsCurrent: true, testsChanged: [], guardPending: false, blockers: [] });
    expect(r.executedRun?.passed).toBe(5);
  });
});

describe('proposeRevert', () => {

  it('revert: the reverse diff puts the old line back; the reopened goal is in remaining; the reason is a note', () => {
    const applied = gcdApplied();
    const goal = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd'], suspectedFiles: ['src/gcd.py'], status: 'open' });
    const p = proposeRevert(makeCtx(), applied, makeMemory({ goals: [goal] }), { goal, reason: 'replan directive revert_changes' });
    expect(p.goal).toBe('revert arg_swap at src/gcd.py:5');
    expect(p.action.kind).toBe('patch');
    if (p.action.kind === 'patch') {
      expect(p.action.diff).toContain('-        return gcd(b, a % b)');
      expect(p.action.diff).toContain('+        return gcd(a % b, b)');
    }
    expect(reverseDiff(applied)).toBe(p.action.kind === 'patch' ? p.action.diff : '');
    expect(p.plan.done).toEqual([]);
    expect(p.plan.remaining).toEqual([goal.planItem, VERIFY_ITEM]);
    expect(p.plan.openProblems[0]).toBe(`reverted arg_swap at src/gcd.py:5: replan directive revert_changes; '${goal.planItem}' is open again`);
    expect(parsesAsJson(p)).toMatchObject({ kind: 'revert', goalId: 'g1' });
  });
});

describe('invariants over every builder', () => {
  it('never proposes edit or write; rawText always parses; plan items keep the grammar', () => {
    const applied = gcdApplied();
    const goal = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd'], suspectedFiles: ['src/gcd.py'], status: 'fixed' });
    const parked = makeGoal({ id: 'g2', status: 'parked', parkedReason: 'r' });
    const mem = makeMemory({ goals: [goal, parked], committed: [applied], baseline: summary({ command: TEST_COMMAND, passing: ['a'] }) });
    const greenCtx = makeCtx({ window: [runEntry({ step: 5, passed: 1 })] });
    const all: Proposal[] = [
      proposePatch(makeCtx(), applied, goal, mem),
      proposeRun(makeCtx({ plan: { remaining: [goal.planItem] } }), TEST_COMMAND, 'full', goal, true),
      proposeRun(makeCtx(), TEST_COMMAND, 'subset', goal),
      proposeDone(greenCtx, mem, 'green'),
      proposeDone(greenCtx, mem, 'partial'),
      proposeDone(makeCtx(), mem, 'green'),
      proposeRevert(makeCtx(), applied, mem, { goal, reason: 'r' }),
    ];
    for (const p of all) {
      expect(ALLOWED_KINDS.has(p.action.kind)).toBe(true);
      parsesAsJson(p);
      expect(p.goal.length).toBeGreaterThan(0);
      for (const item of [...p.plan.done, ...p.plan.remaining]) if (item !== VERIFY_ITEM) expect(isGoalItem(item)).toBe(true);
      for (const note of p.plan.openProblems) expect(note.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('plan pieces and text helpers', () => {
  it('remainingItems: fixed+accepted dropped, fixed+unaccepted kept, claimed removed, foreign items preserved, stale goal items dropped', () => {
    const a = makeGoal({ id: 'a', status: 'fixed' });
    const b = makeGoal({ id: 'b', status: 'fixed' });
    const c = makeGoal({ id: 'c', status: 'active' });
    const ctx = makeCtx({ plan: { done: [{ text: a.planItem, evidence: { step: 1, judged: 0.9 } }], remaining: [b.planItem, c.planItem, 'fix stale in src/old.py', 'install the dev dependencies'] } });
    expect(remainingItems(ctx, makeMemory({ goals: [a, b, c] }))).toEqual([b.planItem, c.planItem, 'install the dev dependencies', VERIFY_ITEM]);
    expect(remainingItems(ctx, makeMemory({ goals: [a, b, c] }), new Set([b.planItem]))).toEqual([c.planItem, 'install the dev dependencies', VERIFY_ITEM]);
    // once the engine accepted the verification item it is not re-listed
    const accepted = makeCtx({ plan: { done: [{ text: VERIFY_ITEM, evidence: { step: 3, judged: 0.9 } }], remaining: [] } });
    expect(remainingItems(accepted, makeMemory({ goals: [c] }))).toEqual([c.planItem]);
  });
  it('openProblemNotes: parked first, then extras, deduplicated and capped', () => {
    const parked = makeGoal({ id: 'p', status: 'parked', parkedReason: 'suite too slow' });
    const notes = openProblemNotes(makeMemory({ goals: [parked] }), ['x', 'x', ...Array.from({ length: 20 }, (_, i) => `n${i}`)]);
    expect(notes[0]).toBe(`${parked.planItem}: parked (suite too slow)`);
    expect(notes[1]).toBe('x');
    expect(notes).toHaveLength(16);
  });
  it('testsLabel, ledgerLine, runActionLabel, isGoalItem', () => {
    expect(testsLabel(makeGoal({ id: 'g', tests: ['t1', 't2', 't3'] }))).toBe('t1, +2 more');
    expect(testsLabel(makeGoal({ id: 'g', tests: ['only'] }))).toBe('only');
    expect(ledgerLine([makeGoal({ id: 'a', status: 'fixed' }), makeGoal({ id: 'b', status: 'active' }), makeGoal({ id: 'c', status: 'parked' }), makeGoal({ id: 'd' })])).toBe('fixed 1, open 2, parked 1');
    expect(runActionLabel('  pytest   -q  ')).toBe('run pytest -q');
    expect(runActionLabel(`pytest ${'x'.repeat(100)}`)).toHaveLength(4 + 80);
    expect(isGoalItem('fix gcd(13, 13) in gcd.py')).toBe(true);
    expect(isGoalItem('fix tests/test_a.py::test_x, +2 more in the workspace')).toBe(true);
    expect(isGoalItem('install deps')).toBe(false);
  });
  it('TEST_PATH_RE and testFilesChanged', () => {
    for (const p of ['tests/test_a.py', 'pkg/tests/x.py', 'test/helpers.py', 'src/test_a.py', 'src/a_test.py', 'conftest.py', 'pkg/conftest.py']) expect(TEST_PATH_RE.test(p)).toBe(true);
    for (const p of ['src/a.py', 'pkg/testing_utils.py', 'src/contest.py', 'src/latest.py']) expect(TEST_PATH_RE.test(p)).toBe(false);
    const applied = gcdApplied();
    const touched: AppliedCandidate = { ...applied, files: [{ path: 'tests/test_gcd.py', before: 'a\n', after: 'b\n' }], diff: unifiedDiff('tests/test_gcd.py', 'a\n', 'b\n') };
    expect(testFilesChanged([applied])).toEqual([]);
    expect(testFilesChanged([applied, touched])).toEqual(['tests/test_gcd.py']);
  });
  it('traceRecord keeps every counter and the bySource table; the unstable count only when the trace carries one', () => {
    const rec = traceRecord(makeTrace({ goalId: 'g9', outcome: 'budget' }));
    expect(rec).toMatchObject({ goalId: 'g9', outcome: 'budget', candidatesTested: 120, bySource: { mutation: { enumerated: 120, tested: 120, passed: 1 } } });
    expect('winner' in rec).toBe(false);
    expect('unstable' in rec).toBe(false);
    expect(traceRecord(makeTrace({ goalId: 'g9', outcome: 'budget', unstable: 3 }))['unstable']).toBe(3);
  });
});

describe('claims once per verdict (splitClaims) and `done` on the controller\'s record of the green run', () => {
  const gA = makeGoal({ id: 'g1', tests: ['tests/test_gcd.py::test_gcd'], suspectedFiles: ['src/gcd.py'], status: 'fixed' });
  const gB = makeGoal({ id: 'g2', tests: ['tests/test_lcm.py::test_lcm'], suspectedFiles: ['src/lcm.py'], status: 'fixed' });
  const gOpen = makeGoal({ id: 'g3', tests: ['tests/test_x.py::test_x'], suspectedFiles: ['src/x.py'], status: 'open' });
  const notGreen = summary({ command: TEST_COMMAND, passing: ['a', 'b', 'c'], failing: ['d'] });
  const green = summary({ command: TEST_COMMAND, passing: ['a', 'b', 'c', 'd', 'e'], failing: [] });
  const label = runActionLabel(TEST_COMMAND);
  const noteA = `'${gA.planItem}' claimed at step 3, judge said p=0.42; this test run re-verifies it before it is claimed again`;

  it('an item never claimed is claimable, one the judge did not accept is deferred with its note, an accepted one is neither; a pending record does not defer', () => {
    const ctx = makeCtx({ plan: { done: [{ text: gB.planItem, evidence: { step: 3, judged: 0.9 } }], remaining: [gA.planItem, gOpen.planItem] } });
    const mem = { ...makeMemory({ baseline: notGreen, goals: [gA, gB, gOpen] }), claims: new Map([[gA.planItem, { step: 3, judged: 0.42 }]]) };
    expect(splitClaims(ctx, mem)).toEqual({ claims: [], deferred: [{ item: gA.planItem, claim: { step: 3, judged: 0.42 } }] });
    expect(deferredClaimNotes(ctx, mem)).toEqual([noteA]);
    expect(isClaimNote(noteA)).toBe(true);
    expect(isClaimNote(`${gOpen.planItem}: parked (nothing left)`)).toBe(false);
    expect(splitClaims(ctx, { ...mem, claims: new Map() })).toEqual({ claims: [gA.planItem], deferred: [] });
    expect(splitClaims(ctx, { ...mem, claims: new Map([[gA.planItem, { step: 3, judged: null }]]) }).claims).toEqual([gA.planItem]);
    expect(splitClaims(ctx, makeMemory({ baseline: notGreen, goals: [gA, gB, gOpen] })).claims).toEqual([gA.planItem]); // no claim record at all
  });

  it('a later passing full-suite run executed by the engine, or a fresh baseline measured all-green, makes the item claimable again; a subset run, a failing run, the claiming run itself or a run before a change does not', () => {
    const ctx = makeCtx({ plan: { remaining: [gA.planItem] } });
    const claims = new Map([[gA.planItem, { step: 3, judged: 0.42 }]]);
    const notGreen6 = summary({ command: TEST_COMMAND, passing: ['a', 'b', 'c', 'd', 'e'], failing: ['f'] });
    const base = { ...makeMemory({ baseline: notGreen6, goals: [gA] }), claims };
    const passing = { step: 5, action: label, passed: 6, failed: 0, errors: 0 };
    expect(splitClaims(ctx, { ...base, lastEngineRun: passing }).claims).toEqual([gA.planItem]);
    // the run about to be proposed was measured all-green by the synthesizer: every claim on it is verifiable, nothing is deferred
    expect(splitClaims(ctx, { ...base, baseline: green })).toEqual({ claims: [gA.planItem], deferred: [] });
    expect(deferredClaimNotes(ctx, { ...base, baseline: green })).toEqual([]);
    for (const run of [
      { ...passing, step: 3 }, // the claiming run itself
      { ...passing, action: 'run pytest -q tests/test_gcd.py::test_gcd', passed: 1 }, // a goal subset
      { ...passing, passed: 5, failed: 1 }, // not passing
    ]) {
      expect(splitClaims(ctx, { ...base, lastEngineRun: run }).deferred).toHaveLength(1);
    }
    expect(splitClaims(ctx, { ...base, lastEngineRun: passing, lastChangeStep: 6 }).deferred).toHaveLength(1); // a change after the run
    expect(splitClaims(ctx, { ...base, lastEngineRun: passing, lastChangeStep: 4 }).claims).toEqual([gA.planItem]);
  });

  it('proposeRun with the ledger claims the claimable items only and notes the deferred ones; last step\'s claim notes are recomputed, other notes kept', () => {
    const stale = `'${gB.planItem}' claimed at step 1, judge said p=0.20; this test run re-verifies it before it is claimed again`;
    const ctx = makeCtx({ plan: { remaining: [gA.planItem, gB.planItem], openProblems: ['keep me', stale] } });
    const mem = { ...makeMemory({ baseline: notGreen, goals: [gA, gB, gOpen] }), claims: new Map([[gA.planItem, { step: 3, judged: 0.42 }]]) };
    const p = proposeRun(ctx, TEST_COMMAND, 'full', undefined, true, undefined, undefined, mem);
    expect(p.plan.done).toEqual([gB.planItem]);
    expect(p.plan.remaining).toEqual([gA.planItem, gOpen.planItem, VERIFY_ITEM]);
    expect(p.plan.openProblems).toEqual(['keep me', noteA]);
    expect(parsesAsJson(p)).toMatchObject({ claimed: [gB.planItem], deferred: [gA.planItem] });
    // nothing deferred: the plan's notes pass through untouched
    const q = proposeRun(ctx, TEST_COMMAND, 'full', undefined, true, undefined, undefined, { ...mem, claims: new Map() });
    expect(q.plan.done).toEqual([gA.planItem, gB.planItem]);
    expect(q.plan.openProblems).toEqual(['keep me', stale]);
    expect(parsesAsJson(q)).not.toHaveProperty('deferred');
  });

  it('doneReadiness reads the engine\'s green run from the controller\'s record when the window scrolled past it: `done`, never another run; a change after it voids the record', () => {
    const reads = [1, 2, 3, 4].map((step) => ({ step: step + 5, intent: 'investigate' as const, action: 'read src/gcd.py', outcome: 'executed' as const, shownFiles: ['src/gcd.py'], notes: [] }));
    const ctx = makeCtx({ window: reads, plan: { remaining: [gA.planItem] } });
    const mem = { ...makeMemory({ baseline: green, goals: [gA], committed: [gcdApplied()] }), lastEngineRun: { step: 5, action: label, passed: 5, failed: 0, errors: 0 }, lastChangeStep: 4 };
    expect(lastExecutedTestRun(ctx.window)).toBeNull();
    expect(doneReadiness(ctx, mem)).toMatchObject({ green: true, testsCurrent: true, executedRun: { step: 5, allPassed: true } });
    const done = proposeDone(ctx, mem, 'green');
    expect(done.action).toEqual({ kind: 'done', summary: 'all 5 tests pass; 1 fix committed' });
    expect(done.plan).toEqual({ done: [gA.planItem, VERIFY_ITEM], remaining: [], openProblems: [] });
    // a change executed after that run: the engine has no run of this workspace → the full-suite run; the baseline is green so the earlier unsure claim is made again on it
    const changed = { ...mem, lastChangeStep: 6, claims: new Map([[gA.planItem, { step: 3, judged: 0.42 }]]) };
    const run = proposeDone(ctx, changed, 'green');
    expect(run.action).toEqual({ kind: 'run', command: TEST_COMMAND });
    expect(run.plan.done).toEqual([gA.planItem]);
    expect(run.plan.remaining).toEqual([VERIFY_ITEM]);
    expect(run.plan.openProblems).toEqual(['the engine has not run the test suite on the current workspace']);
    // with a baseline that still fails a test the fallback run defers the claim, its note next to the blocker
    const partial = proposeDone(ctx, { ...changed, baseline: notGreen }, 'green');
    expect(partial.action).toEqual({ kind: 'run', command: TEST_COMMAND });
    expect(partial.plan.done).toEqual([]);
    expect(partial.plan.remaining).toEqual([gA.planItem, VERIFY_ITEM]);
    expect(partial.plan.openProblems).toEqual(['the engine has not run the test suite on the current workspace', noteA]);
    // the record never overrides a window that shows a change after the run
    const withPatch = makeCtx({ window: [runEntry({ step: 5, command: TEST_COMMAND, passed: 5 }), patchEntry({ step: 6 })], plan: { remaining: [gA.planItem] } });
    expect(proposeDone(withPatch, { ...mem, lastChangeStep: 6 }, 'green').action.kind).toBe('run');
  });
});
