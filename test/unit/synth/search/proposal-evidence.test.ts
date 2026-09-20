/**
 * Proposal.evidence on the synthesizer side (docs/JEV-ONLY-DESIGN.md §5.1): the builders in
 * search/proposal.ts (shadowEvidence, commitEvidence, runEvidence, the verified goal text) and
 * the controller attaching it to every `patch`, to a re-proposed passer and to the standing
 * post-patch `run`.
 */
import { describe, expect, it } from 'vitest';

import type { ProposalEvidence } from '../../../../src/core/types.js';
import { LedgerSieveSynthesizer, committedBase } from '../../../../src/synth/search/index.js';
import type { BaselineRun, RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import { EVIDENCE_TESTS_MAX, commitEvidence, patchGoalText, proposePatch, runEvidence, selectionFrom, selectionOf, shadowEvidence, withEvidence } from '../../../../src/synth/search/proposal.js';
import type { SubGoalResult } from '../../../../src/synth/search/subgoal.js';
import type { Base, Goal, VerifyOutcome } from '../../../../src/synth/search/types.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedPatch, fakeCtx, jobOf, outcomeOf, siteAt, sourceFile, summary } from './controller-fakes.js';
import { gcdApplied, makeCtx, makeGoal, makeMemory, makeTrace, patchEntry } from './proposal-helpers.js';

const TEST_COMMAND = 'python3 -m pytest -q';
const FIX_TEXT = 'return gcd(b, a % b)';
const SEL = { selection: 'sieve' as const, candidatesTested: 120, arbitrated: false };

function failing(): ReturnType<typeof summary> {
  return summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] });
}
function green(): ReturnType<typeof summary> {
  return summary({ command: TEST_COMMAND, failing: [], passing: [GCD_OTHER_TEST, GCD_TEST] });
}

describe('evidence builders', () => {
  const goal = makeGoal({ id: 'g1', tests: [GCD_TEST], suspectedFiles: ['src/gcd.py'], status: 'fixed' });

  it('shadowEvidence: code-computed counts and test ids from two runs, bounded to the contract', () => {
    const e = shadowEvidence(failing(), green(), goal, SEL);
    expect(e).toEqual({
      kind: 'shadow_test_run',
      command: TEST_COMMAND,
      before: { passed: 1, failed: 1, errors: 0, total: 2 },
      after: { passed: 2, failed: 0, errors: 0, total: 2 },
      newlyPassing: [GCD_TEST],
      newlyFailing: [],
      goalTests: [GCD_TEST],
      ...SEL,
    });
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const wide = shadowEvidence(summary({ failing: many }), summary({ passing: many }), { tests: many }, SEL, 'cmd');
    expect(wide.newlyPassing).toHaveLength(EVIDENCE_TESTS_MAX);
    expect(wide.goalTests).toHaveLength(EVIDENCE_TESTS_MAX);
    expect(wide.command).toBe('cmd');
    // a regression shows up as newlyFailing
    const regressed = shadowEvidence(failing(), summary({ command: TEST_COMMAND, failing: [GCD_OTHER_TEST], passing: [GCD_TEST] }), goal, SEL);
    expect(regressed.newlyFailing).toEqual([GCD_OTHER_TEST]);
    expect(selectionOf(makeTrace({ goalId: 'g1', runMode: 'RANK', candidatesTested: 16, arbitrated: true }))).toEqual({ selection: 'rank', candidatesTested: 16, arbitrated: true });
    expect(selectionFrom(e)).toEqual(SEL);
  });

  it('commitEvidence: the outcome\'s full-suite run against the committed baseline; a subset run only when its baseline was the suite; a held partial base otherwise; null without a baseline', () => {
    const file = sourceFile('gcd.py', GCD_BUGGY);
    const base: Base = committedBase(new Map([[file.path, file]]), failing());
    const c = cand(siteAt(file, 5), FIX_TEXT, { source: 'mutation', op: 'arg_swap' });
    const full = outcomeOf(jobOf(c, base), 'plausible', { subset: summary({ command: `${TEST_COMMAND} tests/test_gcd.py`, passing: [GCD_TEST] }), full: green() });
    const trace = makeTrace({ goalId: 'g1' });
    const e = commitEvidence({ baseline: failing() }, { applied: full.applied, outcome: full, trace }, goal);
    expect(e).toMatchObject({ before: { passed: 1, total: 2 }, after: { passed: 2, total: 2 }, newlyPassing: [GCD_TEST], newlyFailing: [], goalTests: [GCD_TEST], selection: 'sieve', candidatesTested: 120, command: TEST_COMMAND });
    // subset was the whole suite (QuixBugs: the JSON suite is the subset): its run is the evidence, under its own command
    const o = outcomeOf(jobOf(c, base), 'plausible', { subset: green() });
    const whole: VerifyOutcome = { job: o.job, applied: o.applied, subset: o.subset, progress: o.progress, status: o.status };
    expect(commitEvidence({ baseline: failing() }, { applied: whole.applied, outcome: whole, trace }, goal)).toMatchObject({ after: { passed: 2 }, command: TEST_COMMAND });
    // a goal-subset run compared with a subset baseline says nothing about the suite
    const subsetOnly: VerifyOutcome = { ...whole, progress: { ...whole.progress, before: summary({ failing: [GCD_TEST] }) } };
    expect(commitEvidence({ baseline: failing() }, { applied: subsetOnly.applied, outcome: subsetOnly, trace }, goal)).toBeNull();
    // partial commit (bases.ts commitPartial): no outcome; the committed base's summary travels as `after` (the base has left the beam)
    const applied = applyCandidate(c);
    expect(commitEvidence({ baseline: failing(), bases: [base] }, { applied, after: green(), trace }, goal)).toMatchObject({ after: { passed: 2 }, newlyPassing: [GCD_TEST], command: TEST_COMMAND });
    // a base still held is found as a fallback; nothing held and no `after` → null
    const held: Base = { id: 'improved-1', origin: 'improved', fromGoal: 'g1', files: base.files, summary: green(), candidate: applied, depth: 1 };
    expect(commitEvidence({ baseline: failing(), bases: [base, held] }, { applied, trace }, goal)).toMatchObject({ after: { passed: 2 }, newlyPassing: [GCD_TEST] });
    expect(commitEvidence({ baseline: failing(), bases: [base] }, { applied, trace }, goal)).toBeNull();
    expect(commitEvidence({ baseline: null }, { applied: full.applied, outcome: full, trace }, goal)).toBeNull();
  });

  it('runEvidence: previous baseline → fresh baseline under the engine\'s command, the last commit\'s goal and selection', () => {
    const e = runEvidence(failing(), green(), goal, { selection: 'rank', candidatesTested: 16, arbitrated: true }, TEST_COMMAND);
    expect(e).toMatchObject({ command: TEST_COMMAND, before: { passed: 1 }, after: { passed: 2 }, goalTests: [GCD_TEST], selection: 'rank', candidatesTested: 16, arbitrated: true });
    expect(runEvidence(failing(), green(), undefined, SEL, TEST_COMMAND).goalTests).toEqual([]);
  });

  it('patchGoalText with evidence states the measurement; proposePatch attaches the evidence and keeps the plain text without it', () => {
    const applied = gcdApplied();
    const e = shadowEvidence(failing(), green(), goal, SEL);
    expect(patchGoalText(applied, goal, e)).toBe('apply verified fix: tests/test_gcd.py::test_gcd now passes (1→2 of 2), no regressions; mutation/arg_swap at src/gcd.py:5');
    expect(patchGoalText(applied, goal)).toBe('fix tests/test_gcd.py::test_gcd in src/gcd.py:5 (mutation/arg_swap)');
    const two = makeGoal({ id: 'g2', tests: [GCD_TEST, 'tests/test_gcd.py::test_big'], suspectedFiles: ['src/gcd.py'] });
    const partial: ProposalEvidence = { ...e, goalTests: two.tests, after: { passed: 2, failed: 1, errors: 0, total: 3 }, before: { passed: 1, failed: 2, errors: 0, total: 3 } };
    expect(patchGoalText(applied, two, partial)).toBe('apply partial fix: 1 of 2 goal tests now pass (tests/test_gcd.py::test_gcd, +1 more) (1→2 of 3), no regressions; mutation/arg_swap at src/gcd.py:5');
    const regressed: ProposalEvidence = { ...e, newlyFailing: [GCD_OTHER_TEST] };
    expect(patchGoalText(applied, goal, regressed)).toContain('1 regression;');

    const ctx = makeCtx();
    const mem = makeMemory({ goals: [goal] });
    const p = proposePatch(ctx, applied, goal, mem, undefined, makeTrace({ goalId: 'g1', winner: applied }), e);
    expect(p.evidence).toEqual(e);
    expect(p.goal).toMatch(/^apply verified fix: /);
    expect(JSON.parse(p.rawText)).toMatchObject({ evidence: { before: 1, after: 2, total: 2, newlyPassing: 1, newlyFailing: 0 } });
    const plain = proposePatch(ctx, applied, goal, mem);
    expect('evidence' in plain).toBe(false);
    expect(plain.goal).toMatch(/^fix /);
    expect(proposePatch(ctx, applied, goal, mem, undefined, undefined, null)).not.toHaveProperty('evidence');
    expect(withEvidence(plain, null)).toBe(plain);
    expect(withEvidence(plain, e).evidence).toEqual(e);
  });
});

// ---------------------------------------------------------------------------------------
// The controller attaches it
// ---------------------------------------------------------------------------------------

interface Harness {
  synth: LedgerSieveSynthesizer;
  file: SourceFile;
  runTests: number;
}

/** Scripted collaborators: baselines in order (the last repeats), a commit with a full-suite outcome for the goal. */
function harness(baselines: BaselineRun[], commit: (goal: Goal, mem: RunMemory, file: SourceFile) => SubGoalResult): Harness {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const queue = [...baselines];
  const h: Harness = { synth: undefined as unknown as LedgerSieveSynthesizer, file, runTests: 0 };
  const deps: SearchDeps = {
    loadFiles: async () => new Map([[file.path, file]]),
    runTests: async () => {
      h.runTests += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error('no baseline scripted');
      return next;
    },
    pickGoal: async (_ctx, mem) => {
      const g = mem.goals.find((x) => x.status === 'active') ?? mem.goals.find((x) => x.status === 'open') ?? null;
      if (g !== null) {
        g.status = 'active';
        g.attempts += 1;
      }
      return { goal: g, method: g === null ? 'none' : 'single', probability: 1, requests: 0 };
    },
    handleDirective: async () => ({ kind: 'continue', move: 'change_approach', changes: [] }),
    searchSubGoal: async (_ctx, mem, goal) => commit(goal, mem, file),
    now: () => 1_000,
  };
  h.synth = new LedgerSieveSynthesizer(deps);
  return h;
}

function fullOutcomeCommit(goal: Goal, mem: RunMemory, file: SourceFile): SubGoalResult {
  const base = mem.bases.find((b) => b.origin === 'committed') ?? committedBase(new Map([[file.path, file]]), failing());
  const c = cand(siteAt(file, 5), FIX_TEXT, { source: 'mutation', op: 'arg_swap' });
  const outcome = outcomeOf(jobOf(c, base), 'plausible', { subset: summary({ command: `${TEST_COMMAND} tests/test_gcd.py`, passing: [GCD_TEST] }), full: green() });
  return { kind: 'commit', applied: outcome.applied, allGoalTestsPass: true, outcome, trace: makeTrace({ goalId: goal.id, outcome: 'fixed', candidatesTested: 77, runMode: 'SIEVE' }) };
}

let runCounter = 0;
function ctxFor(o: Parameters<typeof fakeCtx>[0] = {}): ReturnType<typeof fakeCtx> {
  return fakeCtx({ runId: o.runId ?? `evid-${runCounter++}`, testCommand: { command: 'pytest -q', runner: 'pytest' }, files: ['gcd.py', 'tests/test_gcd.py'], ...o });
}

describe('LedgerSieveSynthesizer attaches evidence', () => {
  it('a commit is a `patch` with the shadow run\'s evidence and the verified goal text', async () => {
    const h = harness([{ summary: failing(), output: '' }], fullOutcomeCommit);
    const p = await h.synth.synthesize(ctxFor({ step: 1 }));
    expect(p.action.kind).toBe('patch');
    expect(p.evidence).toEqual({
      kind: 'shadow_test_run',
      command: TEST_COMMAND,
      before: { passed: 1, failed: 1, errors: 0, total: 2 },
      after: { passed: 2, failed: 0, errors: 0, total: 2 },
      newlyPassing: [GCD_TEST],
      newlyFailing: [],
      goalTests: [GCD_TEST],
      selection: 'sieve',
      candidatesTested: 77,
      arbitrated: false,
    });
    expect(p.goal).toBe('apply verified fix: tests/test_gcd.py::test_gcd now passes (1→2 of 2), no regressions; mutation/arg_swap at gcd.py:5');
  });

  it('the standing post-patch `run` carries the measurement it re-executes: the run before the patch against the fresh baseline', async () => {
    const h = harness([{ summary: failing(), output: '' }, { summary: green(), output: '' }], fullOutcomeCommit);
    const runId = 'evid-run';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const p = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(h.runTests).toBe(2);
    expect(p.evidence).toEqual({
      kind: 'shadow_test_run',
      command: TEST_COMMAND,
      before: { passed: 1, failed: 1, errors: 0, total: 2 },
      after: { passed: 2, failed: 0, errors: 0, total: 2 },
      newlyPassing: [GCD_TEST],
      newlyFailing: [],
      goalTests: [GCD_TEST],
      selection: 'sieve',
      candidatesTested: 77,
      arbitrated: false,
    });
    expect(p.goal).toContain('expect 2 of 2 tests to pass');
    // the very first run of a workspace (no change before it) has nothing to compare: no evidence
    const first = harness([{ summary: failing(), output: '' }], fullOutcomeCommit);
    const r = await first.synth.synthesize(ctxFor({ step: 1, intent: 'verify' }));
    expect(r.action.kind).toBe('run');
    expect(r.evidence).toBeUndefined();
  });

  it('a declined passer is re-proposed with its own evidence (the stash keeps it through the rollback)', async () => {
    const h = harness([{ summary: failing(), output: '' }], fullOutcomeCommit);
    const runId = 'evid-repropose';
    const first = await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const again = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [patchEntry({ step: 1, paths: ['gcd.py'], outcome: 'declined', reason: 'not approved' })] }));
    expect(again.action).toEqual(first.action);
    expect(again.evidence).toEqual(first.evidence);
    expect(again.goal).toBe(first.goal);
    expect(h.runTests).toBe(1);
  });
});
