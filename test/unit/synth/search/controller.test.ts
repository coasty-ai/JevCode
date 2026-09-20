/**
 * The §2.2 control flow of the Ledger + Sieve controller with faked collaborators: run after
 * patch, baseline → pickGoal → searchSubGoal, the proposal per decision kind, the bounded
 * recursion on a park, budget exits, green → done, all parked → partial done, directive
 * dispatch, the persisted state and the ledger event.
 */
import { describe, expect, it } from 'vitest';

import type { Proposal, SynthesisContext, WindowEntry } from '../../../../src/core/types.js';
import { toJson } from '../../../../src/core/json.js';
import { DEFAULT_TEST_COMMAND, ESTABLISH_GOAL, LedgerSieveSynthesizer, SUITE_TOO_SLOW, allPass, detectLayout, lastExecutedActionKind, lastWorkspaceChangeStep, normaliseTestCommand, patchNotExecutedLastStep, runMemory, workspaceChangedSince } from '../../../../src/synth/search/index.js';
import type { BaselineRun, RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import { GOAL_ITEM_RE, VERIFY_ITEM } from '../../../../src/synth/search/proposal.js';
import type { SubGoalResult } from '../../../../src/synth/search/subgoal.js';
import type { PersistedMemoryState } from '../../../../src/synth/search/memory.js';
import type { Goal, PersistedSearchState } from '../../../../src/synth/search/types.js';
import { isPersistedSearchState } from '../../../../src/synth/search/types.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { sha12 } from '../../../../src/core/hash.js';
import { freshPairsOfPartials, guardState, improvedBase, pairsOfPartials, partialsFromPersisted, partialsOf, siteKeyOf } from '../../../../src/synth/search/bases.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedPatch, executedRun, fakeCtx, jobOf, outcomeOf, siteAt, sourceFile, summary } from './controller-fakes.js';
import { makeTrace, patchEntry, runEntry } from './proposal-helpers.js';

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

const FIX_TEXT = 'return gcd(b, a % b)';
/** what the workspace detector reports */
const DETECTED_COMMAND = 'pytest -q';
/** what the synthesizer runs and proposes (search/index.ts normaliseTestCommand: `pytest` is not guaranteed on PATH) */
const TEST_COMMAND = 'python3 -m pytest -q';

function failingBaseline(failing = [GCD_TEST], passing = [GCD_OTHER_TEST]): BaselineRun {
  return { summary: summary({ command: TEST_COMMAND, failing, passing }), output: '' };
}

function greenBaseline(): BaselineRun {
  return { summary: summary({ command: TEST_COMMAND, failing: [], passing: [GCD_TEST, GCD_OTHER_TEST] }), output: '' };
}

function fixFor(goal: Goal, file: SourceFile): SubGoalResult {
  const applied = applyCandidate(cand(siteAt(file, 5), FIX_TEXT));
  return { kind: 'commit', applied, allGoalTestsPass: true, trace: makeTrace({ goalId: goal.id, outcome: 'fixed' }) };
}

interface HarnessOptions {
  baselines?: BaselineRun[];
  results?: ((goal: Goal, mem: RunMemory) => SubGoalResult)[];
  handleDirective?: SearchDeps['handleDirective'];
  pickFirstOpen?: boolean;
}

interface Harness {
  synth: LedgerSieveSynthesizer;
  file: SourceFile;
  calls: string[];
  goalsSearched: string[];
  runTestCommands: string[];
}

/** A synthesizer whose baseline runs, sub-goal searches and directive handler are scripted; the goal picker is real (one goal) or first-open (several). */
function harness(o: HarnessOptions = {}): Harness {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const calls: string[] = [];
  const goalsSearched: string[] = [];
  const runTestCommands: string[] = [];
  const baselines = [...(o.baselines ?? [failingBaseline()])];
  const results = [...(o.results ?? [])];
  const deps: SearchDeps = {
    loadFiles: async () => {
      calls.push('loadFiles');
      return new Map([[file.path, file]]);
    },
    runTests: async (_ctx, command) => {
      calls.push('runTests');
      runTestCommands.push(command);
      const next = baselines.length > 1 ? baselines.shift() : baselines[0];
      if (next === undefined) throw new Error('no baseline scripted');
      return next;
    },
    pickGoal: async (ctx, mem) => {
      calls.push('pickGoal');
      if (o.pickFirstOpen === true) {
        const g = mem.goals.find((x) => x.status === 'active') ?? mem.goals.find((x) => x.status === 'open') ?? null;
        if (g !== null) {
          g.status = 'active';
          g.attempts += 1;
        }
        return { goal: g, method: g === null ? 'none' : 'single', probability: 1, requests: 0 };
      }
      const { pickGoalDetailed } = await import('../../../../src/synth/search/goals.js');
      return pickGoalDetailed(ctx, mem, ctx.ask, { stage: 'propose' });
    },
    handleDirective:
      o.handleDirective ??
      (async () => {
        calls.push('handleDirective');
        return { kind: 'continue', move: 'change_approach', changes: [] };
      }),
    searchSubGoal: async (_ctx, mem, goal) => {
      calls.push(`searchSubGoal:${goal.id}`);
      goalsSearched.push(goal.id);
      const next = results.length > 1 ? results.shift() : results[0];
      if (next === undefined) return fixFor(goal, file);
      return next(goal, mem);
    },
    now: () => 1_000,
  };
  return { synth: new LedgerSieveSynthesizer(deps), file, calls, goalsSearched, runTestCommands };
}

let runCounter = 0;
/**
 * A step context. Unless `engineRun: false`, the window opens with an engine-executed full-suite
 * run at step 0: the controller proposes the establishing `run` before anything else when the
 * engine has never executed the suite, and these tests are about what follows it.
 */
function ctxFor(o: Parameters<typeof fakeCtx>[0] & { engineRun?: boolean } = {}): ReturnType<typeof fakeCtx> {
  const { engineRun, ...rest } = o;
  const window = engineRun === false ? rest.window : [executedRun(0, TEST_COMMAND, { passed: 1, failed: 1 }), ...(rest.window ?? [])];
  return fakeCtx({ runId: rest.runId ?? `ctl-${runCounter++}`, testCommand: { command: DETECTED_COMMAND, runner: 'pytest' }, files: ['gcd.py', 'tests/test_gcd.py'], ...rest, ...(window === undefined ? {} : { window }) });
}

/** An engine-executed run whose judge carried `done_<j>` verdicts for the items the run claimed (loop/engine.ts commit). */
function judgedRun(step: number, counts: { passed: number; failed: number }, doneClaims: { text: string; judged: number; accepted: boolean }[]): WindowEntry {
  const e = executedRun(step, TEST_COMMAND, counts);
  return { ...e, judge: { ...e.judge!, doneClaims } };
}

const readEntryAt = (step: number): WindowEntry => ({ step, intent: 'investigate', action: 'read gcd.py', outcome: 'executed', shownFiles: ['gcd.py'], notes: [] });

function parked(reason = 'exhausted mutation, template, donor at 1 site'): (goal: Goal) => SubGoalResult {
  return (goal) => ({ kind: 'parked', reason, trace: makeTrace({ goalId: goal.id, outcome: 'exhausted' }) });
}

function budget(): (goal: Goal) => SubGoalResult {
  return (goal) => ({ kind: 'budget', trace: makeTrace({ goalId: goal.id, outcome: 'budget' }) });
}

function persistedOf(ctx: ReturnType<typeof fakeCtx>): PersistedMemoryState {
  const last = ctx.synthStates.at(-1);
  if (last === undefined || !isPersistedSearchState(last)) throw new Error('no persisted state');
  return last as PersistedMemoryState;
}

function ledgerOf(ctx: ReturnType<typeof fakeCtx>): string[] {
  return ctx.events.filter((e) => e.type === 'synth' && e.phase === 'ledger').map((e) => (e.type === 'synth' ? e.detail : ''));
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

describe('window helpers', () => {
  it('read the previous step and the last workspace change from the engine window labels', () => {
    const w = [executedRun(1, TEST_COMMAND, { passed: 1, failed: 1 }), executedPatch(2), executedRun(3, TEST_COMMAND, { passed: 2, failed: 0 })];
    expect(lastExecutedActionKind(w)).toBe('run');
    expect(lastExecutedActionKind(w.slice(0, 2))).toBe('patch');
    expect(lastExecutedActionKind([{ ...executedPatch(4), outcome: 'failed' }])).toBeNull();
    expect(lastWorkspaceChangeStep(w)).toBe(2);
    expect(workspaceChangedSince(1, w)).toBe(true);
    expect(workspaceChangedSince(2, w)).toBe(true);
    expect(workspaceChangedSince(3, w)).toBe(false);
  });
  it('detects the QuixBugs layout and the all-pass condition', () => {
    expect(detectLayout(['gcd.py', 'tests/test_gcd.py', 'tests/gcd.json'])).toBe('quixbugs');
    expect(detectLayout(['depth_first_search.py', 'node.py', 'tests/depth_first_search_test.py'])).toBe('quixbugs');
    expect(detectLayout(['src/a.py', 'src/b.py', 'tests/test_a.py'])).toBe('pytest');
    expect(detectLayout(['a.py'])).toBe('other');
    expect(allPass(summary({ passing: ['t'] }))).toBe(true);
    expect(allPass(summary({ passing: ['t'], timedOut: true }))).toBe(false);
    expect(allPass(summary({ passing: [], failing: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// One outer step
// ---------------------------------------------------------------------------------------

describe('LedgerSieveSynthesizer.synthesize: the §2.2 step', () => {
  it('baseline, then pickGoal, then searchSubGoal; a commit is a `patch` with the plan grammar, the state persisted and the ledger emitted', async () => {
    const h = harness();
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(h.calls).toEqual(['loadFiles', 'runTests', 'pickGoal', 'searchSubGoal:g1']);
    expect(h.runTestCommands).toEqual([TEST_COMMAND]);
    expect(p.action.kind).toBe('patch');
    if (p.action.kind === 'patch') expect(p.action.diff).toContain(`+        ${FIX_TEXT}`);
    expect(p.goal).toMatch(/^fix tests\/test_gcd\.py::test_gcd in gcd\.py:5/);
    // nothing claimed yet (the run after the patch claims it); every unfinished goal an item in the fixed grammar
    expect(p.plan.done).toEqual([]);
    for (const item of p.plan.remaining) if (item !== VERIFY_ITEM) expect(item).toMatch(GOAL_ITEM_RE);
    expect(p.plan.remaining.at(-1)).toBe(VERIFY_ITEM); // the standing verification item closes every plan
    // the fixed goal is still listed until the engine accepts the claim
    expect(p.plan.remaining).toEqual([`fix ${GCD_TEST} in gcd.py`, VERIFY_ITEM]);
    expect(p.plan.openProblems).toEqual([]);
    // rawText is the GoalSearchTrace record
    const raw = JSON.parse(p.rawText) as { goalId?: string; outcome?: string };
    expect(raw.goalId).toBe('g1');
    // setSynthState called with the persisted ledger; the ledger line emitted
    const persisted = persistedOf(ctx);
    expect(persisted.goals['g1']).toMatchObject({ status: 'fixed', tests: [GCD_TEST] });
    expect(persisted.committedDiffHashes).toHaveLength(1);
    expect(ledgerOf(ctx)).toEqual(['fixed 1, open 0, parked 0']);
    const phases = ctx.events.filter((e) => e.type === 'synth').map((e) => (e.type === 'synth' ? e.phase : ''));
    expect(phases).toEqual(['baseline', 'goal', 'search', 'ledger']);
    // the memory holds the commit and the goal
    const mem = runMemory(ctx.runId);
    expect(mem.committed).toHaveLength(1);
    expect(mem.goals.map((g) => g.status)).toEqual(['fixed']);
  });

  it('the step after an executed `patch` is the full-suite `run`; it claims the goals the fresh baseline shows fixed, and under `investigate` the unseen patched file is read first', async () => {
    const h = harness();
    const runId = 'ctl-run-after-patch';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    // investigate intent, patched file not shown: a `read` of it comes before the run
    const r = await h.synth.synthesize(ctxFor({ runId, step: 2, intent: 'investigate', window: [executedPatch(1)] }));
    expect(r.action).toEqual({ kind: 'read', paths: ['gcd.py'] });
    const ctx = ctxFor({ runId, step: 2, window: [executedPatch(1)], plan: { remaining: [`fix ${GCD_TEST} in gcd.py`] } });
    const p = await h.synth.synthesize(ctx);
    expect(p.action).toEqual({ kind: 'run', command: TEST_COMMAND, timeoutMs: expect.any(Number) });
    // the goal text says why the same command runs again and what the synthesizer's own baseline expects
    expect(p.goal).toMatch(new RegExp(`^verify the suite after fixing ${GCD_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(gcd\\.py changed since the last test run; expect \\d+ of \\d+ tests to pass`));
    // §5.1 row 2: the run claims the goal the fresh baseline shows fixed; the scripted baseline still fails it, so nothing is claimed here
    expect(p.plan.done).toEqual([]);
    expect(p.plan.remaining).toEqual([`fix ${GCD_TEST} in gcd.py`, VERIFY_ITEM]);
    // with a green re-baseline the claim is made on the run
    const g = harness({ baselines: [failingBaseline(), greenBaseline()] });
    const gid = 'ctl-run-after-patch-green';
    await g.synth.synthesize(ctxFor({ runId: gid, step: 1 }));
    const pg = await g.synth.synthesize(ctxFor({ runId: gid, step: 2, window: [executedPatch(1)] }));
    expect(pg.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(pg.plan.done).toEqual([`fix ${GCD_TEST} in gcd.py`]);
    expect(pg.plan.remaining).toEqual([VERIFY_ITEM]); // never empty on a run: an empty remaining reads as a completion claim
    // the patch changed the workspace: the synthesizer re-baselines (so the run's plan carries the ledger) but does not search
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(2);
    expect(h.calls.filter((c) => c.startsWith('searchSubGoal'))).toHaveLength(1);
    // the ledger follows the tests: the scripted re-baseline still fails the goal's test, so the goal is open again
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 1, parked 0']);
  });

  it('re-baselines after the workspace changed and proposes `run` until the engine has seen the green suite, then `done`', async () => {
    const h = harness({ baselines: [failingBaseline(), greenBaseline()] });
    const runId = 'ctl-green';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    // step 3: the workspace changed at step 1 (after the step-1 baseline) → new baseline (green); the engine's run at step 2 shows green
    const green = ctxFor({ runId, step: 3, window: [executedPatch(1), executedRun(2, TEST_COMMAND, { passed: 2, failed: 0 })] });
    const done = await h.synth.synthesize(green);
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(2);
    expect(done.action.kind).toBe('done');
    if (done.action.kind === 'done') expect(done.action.summary).toBe('all 2 tests pass; 1 fix committed');
    expect(done.plan.remaining).toEqual([]);
    // without an engine-executed run on the current workspace, green proposes the full run instead
    const h2 = harness({ baselines: [greenBaseline()] });
    const p = await h2.synth.synthesize(ctxFor({ step: 1 }));
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
  });

  it('parked → one bounded recursion onto the next goal; a second park is a goal-subset `run`', async () => {
    const h = harness({ baselines: [failingBaseline([GCD_TEST, 'tests/test_gcd.py::test_two'], [GCD_OTHER_TEST])], results: [parked('nothing at g1'), parked('nothing at g2')], pickFirstOpen: true });
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(h.goalsSearched).toHaveLength(2);
    expect(new Set(h.goalsSearched).size).toBe(2);
    expect(p.action).toMatchObject({ kind: 'run', command: `${TEST_COMMAND} 'tests/test_gcd.py'` });
    expect(p.goal).toMatch(/^record the failing behaviour of /);
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 0, parked 2']);
    const persisted = persistedOf(ctx);
    expect(Object.values(persisted.goals).map((g) => g.status)).toEqual(['parked', 'parked']);
    expect(Object.values(persisted.goals).map((g) => g.parkedReason)).toEqual(['nothing at g1', 'nothing at g2']);
    // the search only recursed once: no third search even though the budget flag says so
    expect(runMemory(ctx.runId).stepBudget.recursed).toBe(true);
  });

  it('every goal parked → an honest partial `done` (after the engine has run the tests)', async () => {
    const h = harness({ results: [parked('exhausted every source at 2 sites')] });
    const runId = 'ctl-partial';
    const ctx = ctxFor({ runId, step: 2, window: [executedRun(1, TEST_COMMAND, { passed: 1, failed: 1 })] });
    const p = await h.synth.synthesize(ctx);
    // one goal: park → recursion → no open goal → partial done
    expect(h.calls).toEqual(['loadFiles', 'runTests', 'pickGoal', 'searchSubGoal:g1', 'pickGoal']);
    expect(p.action.kind).toBe('done');
    if (p.action.kind === 'done') expect(p.action.summary).toMatch(/^partial: fixed 0 of 1 failing tests; .*exhausted every source/);
    expect(p.plan.remaining).toEqual([`fix ${GCD_TEST} in gcd.py`, VERIFY_ITEM]);
    expect(p.plan.openProblems.join('\n')).toContain('parked (exhausted every source at 2 sites)');
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 0, parked 1']);
  });

  it('budget → goal-subset `run`; two consecutive budget hits park the goal (§5.3)', async () => {
    const h = harness({ results: [budget()] });
    const runId = 'ctl-budget';
    const first = ctxFor({ runId, step: 1 });
    const p1 = await h.synth.synthesize(first);
    expect(p1.action).toMatchObject({ kind: 'run', command: `${TEST_COMMAND} 'tests/test_gcd.py'` });
    const mem = runMemory(runId);
    expect(mem.goals[0]).toMatchObject({ status: 'open', budgetHits: 1 });
    expect(ledgerOf(first)).toEqual(['fixed 0, open 1, parked 0']);
    // the subset run executed by the engine changes nothing: no re-baseline, the same goal resumes
    const second = ctxFor({ runId, step: 2, window: [executedRun(1, `${TEST_COMMAND} tests/test_gcd.py`, { passed: 1, failed: 1 })] });
    const p2 = await h.synth.synthesize(second);
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(1);
    expect(p2.action.kind).toBe('run');
    // goals.park() resets the hit counter; the reason records the rule that fired
    expect(mem.goals[0]).toMatchObject({ status: 'parked', budgetHits: 0 });
    expect(mem.goals[0]?.parkedReason).toMatch(/2 consecutive budget-hit steps/);
    expect(ledgerOf(second)).toEqual(['fixed 0, open 0, parked 1']);
  });

  it('a directive is dispatched first; a directive proposal short-circuits the step, `continue` falls through to the search', async () => {
    const readProposal: Proposal = { goal: 'read gcd.py', action: { kind: 'read', paths: ['gcd.py'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '{}' };
    const seen: string[] = [];
    const h = harness({
      handleDirective: async (ctx) => {
        seen.push(ctx.directive ?? '');
        return ctx.directive?.includes('gather_context') ? { kind: 'proposal', move: 'gather_context', proposal: readProposal, changes: ['read'] } : { kind: 'continue', move: 'change_approach', changes: [] };
      },
    });
    const p = await h.synth.synthesize(ctxFor({ step: 2, directive: 'the loop tripped: `gather_context`' }));
    expect(p).toBe(readProposal);
    expect(h.calls).toEqual([]);
    const q = await h.synth.synthesize(ctxFor({ step: 2, directive: 'the loop tripped: `change_approach`' }));
    expect(seen).toEqual(['the loop tripped: `gather_context`', 'the loop tripped: `change_approach`']);
    expect(q.action.kind).toBe('patch');
    expect(h.calls).toEqual(['loadFiles', 'runTests', 'pickGoal', 'searchSubGoal:g1']);
  });

  it('a failed `patch` rolls the commit back, re-reads the workspace and re-opens the goal before the next search (§5.3)', async () => {
    const h = harness();
    const runId = 'ctl-failed-patch';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const mem = runMemory(runId);
    expect(mem.committed).toHaveLength(1);
    expect(mem.committedDiffHashes).toHaveLength(1);
    const failed = { ...executedPatch(1), outcome: 'failed' as const, reason: 'patch does not apply' };
    const ctx = ctxFor({ runId, step: 2, window: [failed] });
    const p = await h.synth.synthesize(ctx);
    // the files the synthesizer held were not the workspace's: files are re-read and the baseline re-run, then the goal is searched again
    expect(h.calls.filter((c) => c === 'loadFiles')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(2);
    expect(h.goalsSearched).toEqual(['g1', 'g1']);
    expect(p.action.kind).toBe('patch');
    // the undone commit left both the in-memory list and the durable hash list; the new commit is the only one
    expect(mem.committed).toHaveLength(1);
    expect(mem.committedDiffHashes).toHaveLength(1);
    expect(ctx.events.filter((e) => e.type === 'synth').map((e) => (e.type === 'synth' ? e.phase : ''))).toEqual(['stale_sites', 'rollback', 'baseline', 'goal', 'search', 'ledger']);
  });

  it('a timed-out baseline parks every goal with `suite too slow` and proposes the full command (§4.1)', async () => {
    const slow: BaselineRun = { summary: summary({ command: TEST_COMMAND, failing: ['<test run>'], passing: [], timedOut: true, exitCode: null }), output: '' };
    const h = harness({ baselines: [slow] });
    const runId = 'ctl-slow';
    // a persisted goal from an earlier step is what gets parked (the timed-out summary names no test, so the ledger is not re-derived from it)
    const persisted: PersistedSearchState = { version: 1, tried: ['abc123abc123'], widenCursor: {}, goals: { g1: { status: 'open', attempts: 1, budgetHits: 0, phase: 'SEEDS', tests: [GCD_TEST], planItem: `fix ${GCD_TEST} in gcd.py` } }, committedDiffHashes: [] };
    const first = await h.synth.synthesize(ctxFor({ runId, step: 1, synthState: toJson(persisted) }));
    expect(first.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(h.calls).toEqual(['loadFiles', 'runTests']);
    const mem = runMemory(runId);
    expect(mem.goals.map((g) => [g.id, g.status, g.parkedReason, g.attempts])).toEqual([['g1', 'parked', SUITE_TOO_SLOW, 1]]);
    expect(mem.tried.has('abc123abc123')).toBe(true);
    expect(mem.goals[0]?.planItem).toBe(`fix ${GCD_TEST} in gcd.py`);
    // the next step (the engine ran the full command) is the honest partial `done` naming the reason; no second baseline
    const second = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedRun(1, TEST_COMMAND, { passed: 0, failed: 1 })] }));
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(1);
    expect(second.action.kind).toBe('done');
    if (second.action.kind === 'done') expect(second.action.summary).toBe(`partial: fixed 0 of 1 failing tests; ${GCD_TEST}: ${SUITE_TOO_SLOW}`);
    expect(second.plan.openProblems.join('\n')).toContain(SUITE_TOO_SLOW);
  });

  it('a timed-out baseline on a run that knows no goal yet parks one goal for the run itself, so the partial `done` names the reason', async () => {
    const slow: BaselineRun = { summary: summary({ command: TEST_COMMAND, failing: ['<test run>'], passing: [], timedOut: true, exitCode: null }), output: '' };
    const h = harness({ baselines: [slow] });
    const ctx = ctxFor({ step: 1 });
    const first = await h.synth.synthesize(ctx);
    expect(first.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    const mem = runMemory(ctx.runId);
    expect(mem.goals.map((g) => [g.status, g.parkedReason, g.tests, g.suspectedFiles])).toEqual([['parked', SUITE_TOO_SLOW, ['<test run>'], ['gcd.py']]]);
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 0, parked 1']);
    expect(persistedOf(ctx).goals['g1']).toMatchObject({ status: 'parked', parkedReason: SUITE_TOO_SLOW });
  });

  it('a budget or parked exit carries the step\'s GoalSearchTrace in the `run` proposal\'s rawText (§5.6 totals per record)', async () => {
    const h = harness({ results: [(goal) => ({ kind: 'budget', trace: makeTrace({ goalId: goal.id, outcome: 'budget', jevRequests: 7, testRuns: 12, candidatesTested: 11 }) })] });
    const p = await h.synth.synthesize(ctxFor({ step: 1 }));
    expect(p.action.kind).toBe('run');
    const raw = JSON.parse(p.rawText) as { kind: string; scope: string; trace?: { goalId: string; outcome: string; jevRequests: number; testRuns: number; candidatesTested: number } };
    expect(raw).toMatchObject({ kind: 'run', scope: 'subset', trace: { goalId: 'g1', outcome: 'budget', jevRequests: 7, testRuns: 12, candidatesTested: 11 } });
    // the same for a goal parked twice in one step (the bounded recursion), and for the partial `done` after a park
    const h2 = harness({ baselines: [failingBaseline([GCD_TEST, 'tests/test_gcd.py::test_two'], [GCD_OTHER_TEST])], results: [parked('nothing at g1'), parked('nothing at g2')], pickFirstOpen: true });
    const q = await h2.synth.synthesize(ctxFor({ step: 1 }));
    expect(q.action.kind).toBe('run');
    expect((JSON.parse(q.rawText) as { trace?: { outcome: string } }).trace).toMatchObject({ outcome: 'exhausted' });
    const h3 = harness({ results: [parked('nothing left')] });
    const d = await h3.synth.synthesize(ctxFor({ step: 2, window: [executedRun(1, TEST_COMMAND, { passed: 1, failed: 1 })] }));
    expect(d.action.kind).toBe('done');
    expect((JSON.parse(d.rawText) as { trace?: { goalId: string; outcome: string } }).trace).toMatchObject({ goalId: 'g1', outcome: 'exhausted' });
  });

  it('on resume the checkpoint state re-attaches goal status by test id and the plan item is kept', async () => {
    const h = harness();
    const persisted: PersistedSearchState = {
      version: 1,
      tried: ['abc123abc123'],
      widenCursor: {},
      goals: { g7: { status: 'parked', attempts: 3, budgetHits: 0, phase: 'WIDENED', parkedReason: 'earlier park', tests: [GCD_TEST], planItem: `fix ${GCD_TEST} in gcd.py` } },
      committedDiffHashes: [],
    };
    const ctx = ctxFor({ step: 5, synthState: toJson(persisted), plan: { remaining: [`fix ${GCD_TEST} in gcd.py`] }, window: [executedRun(4, TEST_COMMAND, { passed: 1, failed: 1 })] });
    const p = await h.synth.synthesize(ctx);
    const mem = runMemory(ctx.runId);
    expect(mem.tried.has('abc123abc123')).toBe(true);
    expect(mem.goals.map((g) => [g.status, g.attempts, g.parkedReason])).toEqual([['parked', 3, 'earlier park']]);
    // the parked goal is not searched: partial done straight away
    expect(h.goalsSearched).toEqual([]);
    expect(p.action.kind).toBe('done');
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 0, parked 1']);
  });

  it('a synthesizer built with a throwing raw decider still works: every question goes through ctx.ask', async () => {
    const h = harness({ baselines: [failingBaseline([GCD_TEST, 'tests/test_gcd.py::test_two'], [GCD_OTHER_TEST])] });
    const ctx = ctxFor({
      step: 1,
      ask: (questions) => {
        const q = questions['attack_first'];
        if (q === undefined || q.type !== 'choice') throw new Error('expected the attack_first Choice');
        const first = Object.keys(q.criteria)[0] ?? '';
        const weights: Record<string, number> = {};
        for (const k of Object.keys(q.criteria)) weights[k] = k === first ? 0.9 : 0.05;
        return { attack_first: { type: 'choice', choice: first, probabilities: weights, confidence: 0.9 } };
      },
    });
    const throwingDecider: SynthesisContext['decider'] = {
      model: 'raw',
      ask: () => {
        throw new Error('the raw decider must not be called');
      },
    };
    const p = await h.synth.synthesize({ ...ctx, decider: throwingDecider });
    expect(p.action.kind).toBe('patch');
    expect(ctx.askCalls).toHaveLength(1);
    expect(Object.keys(ctx.askCalls[0]?.questions ?? {})).toEqual(['attack_first']);
  });

  it('falls back to the pytest default command when the workspace detector found none', () => {
    const ctx = ctxFor({ testCommand: null });
    expect(ctx.workspaceInfo.testCommand).toBeNull();
    expect(DEFAULT_TEST_COMMAND).toBe('python3 -m pytest -q');
  });
});

describe('the ledger follows the workspace: patches the engine did not execute', () => {
  it('normaliseTestCommand: a bare pytest becomes the module form (pytest is not guaranteed on PATH); everything else is untouched', () => {
    expect(normaliseTestCommand('pytest -q')).toBe('python3 -m pytest -q');
    expect(normaliseTestCommand('pytest')).toBe('python3 -m pytest');
    expect(normaliseTestCommand('py.test tests/')).toBe('python3 -m pytest tests/');
    expect(normaliseTestCommand('python3 -m pytest -q')).toBe('python3 -m pytest -q');
    expect(normaliseTestCommand('pytest-watch')).toBe('pytest-watch');
    expect(normaliseTestCommand('npm test')).toBe('npm test');
  });
  it('patchNotExecutedLastStep: blocked, declined, failed and interrupted patches are reported; an executed patch or a run is not', () => {
    expect(patchNotExecutedLastStep([patchEntry({ step: 2, outcome: 'blocked', reason: 'risk 0.77' })])).toEqual({ step: 2, outcome: 'blocked', reason: 'risk 0.77' });
    expect(patchNotExecutedLastStep([patchEntry({ step: 2, outcome: 'declined' })])).toMatchObject({ outcome: 'declined' });
    expect(patchNotExecutedLastStep([patchEntry({ step: 2, outcome: 'failed' })])).toMatchObject({ outcome: 'failed' });
    expect(patchNotExecutedLastStep([patchEntry({ step: 2, outcome: 'executed' })])).toBeNull();
    expect(patchNotExecutedLastStep([executedRun(2, TEST_COMMAND, { passed: 1, failed: 1 })])).toBeNull();
    expect(patchNotExecutedLastStep([])).toBeNull();
  });
  it('a blocked patch undoes the commit: the goal is open again, nothing is committed, the candidate is searchable again, and the next step searches once more without a new baseline', async () => {
    const runId = 'ctl-blocked';
    const h = harness();
    const first = await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    expect(first.action.kind).toBe('patch');
    const mem = runMemory(runId);
    expect(mem.goals[0]?.status).toBe('fixed');
    expect(mem.committed).toHaveLength(1);
    const hash = mem.committedDiffHashes[0]!;
    expect(mem.tried.has(hash)).toBe(true);
    // the risk stage blocked it: the workspace never changed; the same passer is proposed once more without a search
    const second = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [patchEntry({ step: 1, paths: ['gcd.py'], outcome: 'blocked', reason: 'risk 0.77 (block) from plan_mismatch' })] }));
    expect(second.action).toEqual(first.action);
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(1); // no second baseline: the workspace is unchanged
    expect(h.goalsSearched).toHaveLength(1); // re-proposed from the stash, not searched again
    expect(mem.committed).toHaveLength(1);
    expect(mem.committedDiffHashes).toEqual([hash]);
    expect(mem.tried.has(hash)).toBe(true);
    // rejected a second time: abandoned, the search runs again for another candidate
    const third = await h.synth.synthesize(ctxFor({ runId, step: 3, window: [patchEntry({ step: 2, paths: ['gcd.py'], outcome: 'blocked', reason: 'risk 0.8' })] }));
    expect(third.action.kind).toBe('patch');
    expect(h.goalsSearched).toHaveLength(2);
  });
  it('a declined patch: same rollback, and the rollback event names the outcome; a failed (did not apply) patch re-runs the baseline', async () => {
    const runId = 'ctl-declined';
    // first search commits, the second (after the rollback) parks, so the undone state is observable
    const h = harness({ results: [(goal, mem) => fixFor(goal, mem.bases[0]!.files.get('gcd.py')!), parked()] });
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const mem = runMemory(runId);
    const hash = mem.committedDiffHashes[0]!;
    const c2 = ctxFor({ runId, step: 2, window: [patchEntry({ step: 1, paths: ['gcd.py'], outcome: 'declined', reason: 'not approved' })] });
    const p2 = await h.synth.synthesize(c2);
    // re-opened; the rejected passer is re-proposed once (no search), so the ledger shows the commit again
    expect(h.goalsSearched).toEqual(['g1']);
    expect(p2.action.kind).toBe('patch');
    expect(mem.committed).toHaveLength(1);
    expect(mem.tried.has(hash)).toBe(true);
    // declined again: abandoned; the scripted second search parks the goal
    const c3 = ctxFor({ runId, step: 3, window: [patchEntry({ step: 2, paths: ['gcd.py'], outcome: 'declined', reason: 'not approved' })] });
    const p3 = await h.synth.synthesize(c3);
    expect(h.goalsSearched).toEqual(['g1', 'g1']);
    expect(mem.committed).toEqual([]);
    expect(mem.committedDiffHashes).toEqual([]);
    expect(mem.goals[0]?.status).toBe('parked');
    // every goal parked and the engine has executed a run (step 0): the honest partial `done`
    expect(p3.action.kind).toBe('done');
    if (p3.action.kind === 'done') expect(p3.action.summary).toMatch(/^partial: fixed 0 of 1 failing tests/);
    expect(c2.events.some((e) => e.type === 'synth' && e.phase === 'rollback' && e.detail.includes('patch declined') && e.detail.includes('g1 open again'))).toBe(true);
    // failed to apply: the files the synthesizer holds are stale → the baseline runs again, the hash stays tried
    const runId2 = 'ctl-failed';
    const h2 = harness();
    await h2.synth.synthesize(ctxFor({ runId: runId2, step: 1 }));
    const mem2 = runMemory(runId2);
    const hash2 = mem2.committedDiffHashes[0]!;
    await h2.synth.synthesize(ctxFor({ runId: runId2, step: 2, window: [patchEntry({ step: 1, paths: ['gcd.py'], outcome: 'failed', reason: 'git apply --check failed' })] }));
    expect(h2.calls.filter((c) => c === 'runTests')).toHaveLength(2);
    expect(mem2.tried.has(hash2)).toBe(true);
  });
  it('a `run` proposal carries the ledger as `remaining` (one item per open goal), so the risk state never reads it as a completion claim', async () => {
    const runId = 'ctl-run-ledger';
    const h = harness({ baselines: [failingBaseline([GCD_TEST, 'tests/test_gcd.py::test_more'], [GCD_OTHER_TEST])], pickFirstOpen: true });
    await h.synth.synthesize(ctxFor({ runId, step: 1, window: [executedRun(0, TEST_COMMAND, { passed: 1, failed: 2 })] })); // forms the ledger (2 goals) and patches
    const p1 = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedRun(0, TEST_COMMAND, { passed: 1, failed: 2 }), executedPatch(1)] }));
    expect(p1.action.kind).toBe('run');
    expect(runMemory(runId).goals.length).toBeGreaterThan(1);
    expect(p1.plan.remaining.length).toBe(runMemory(runId).goals.length + 1); // + the standing verification item
    expect(p1.plan.remaining.slice(0, -1).every((r) => GOAL_ITEM_RE.test(r))).toBe(true);
    expect(p1.plan.remaining.at(-1)).toBe(VERIFY_ITEM);
    expect(p1.plan.done).toEqual([]);
  });
  it('intent investigate: one `read` of the source files the ledger points at (unseen first, else the relevant ones); after an executed read the search proceeds', async () => {
    const runId = 'ctl-investigate';
    const h = harness({ baselines: [{ summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), output: '' }] });
    const p1 = await h.synth.synthesize(ctxFor({ runId, step: 1, intent: 'investigate' }));
    expect(p1.action.kind).toBe('read');
    if (p1.action.kind === 'read') expect(p1.action.paths.every((x) => !/test/.test(x))).toBe(true);
    expect(h.goalsSearched).toEqual([]);
    // one executed read: a second is allowed (INVESTIGATE_READS_MAX = 2); after two the search runs
    const readEntry = { step: 1, intent: 'investigate' as const, action: 'read gcd.py', outcome: 'executed' as const, shownFiles: ['gcd.py'], notes: [] };
    const again = await h.synth.synthesize(ctxFor({ runId, step: 2, intent: 'investigate', window: [readEntry] }));
    expect(again.action.kind).toBe('read');
    const p2 = await h.synth.synthesize(ctxFor({ runId, step: 3, intent: 'investigate', window: [readEntry, { ...readEntry, step: 2 }] }));
    expect(p2.action.kind).toBe('patch');
    // a declined read counts too: two trailing read proposals, whatever their outcome, end the allowance
    const h2 = harness({ baselines: [{ summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), output: '' }] });
    const p3 = await h2.synth.synthesize(ctxFor({ runId: 'ctl-investigate-declined', step: 3, intent: 'investigate', window: [readEntry, { ...readEntry, step: 2, outcome: 'declined' as const }] }));
    expect(p3.action.kind).toBe('patch');
    expect(h.goalsSearched).toHaveLength(1);
  });
  it('the post-patch run is a standing obligation: after the engine declined it, the next step proposes it again instead of searching', async () => {
    const runId = 'ctl-run-insist';
    const h = harness();
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const declined = runEntry({ step: 2, command: TEST_COMMAND, outcome: 'declined', parsed: false });
    const p = await h.synth.synthesize(ctxFor({ runId, step: 3, window: [executedPatch(1), declined] }));
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p.goal).toMatch(/changed since the last test run; expect \d+ of \d+ tests to pass(, \d+ passed in the last run)?\)$/);
    expect(h.goalsSearched).toHaveLength(1); // no second search
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(2); // one re-baseline for the changed workspace, none for the declined run
  });
});

describe('step policy: the establishing run, one claim per verdict, done after the green run', () => {
  it('the engine has never executed the suite: the first proposal is the establishing full-suite `run`, whatever the intent; once a run executed, the search proceeds', async () => {
    for (const intent of ['investigate', 'edit', 'verify'] as const) {
      const runId = `ctl-establish-${intent}`;
      const h = harness();
      const p1 = await h.synth.synthesize(ctxFor({ runId, step: 1, intent, engineRun: false }));
      expect(p1.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
      expect(p1.goal).toBe(`${ESTABLISH_GOAL} (1 of 2 fails in the synthesizer's own run)`);
      // nothing claimed, the ledger as `remaining`, nothing searched: the synthesizer's own baseline ran first so the plan carries the ledger
      expect(p1.plan.done).toEqual([]);
      expect(p1.plan.remaining).toEqual([`fix ${GCD_TEST} in gcd.py`, VERIFY_ITEM]);
      expect(h.calls).toEqual(['loadFiles', 'runTests']);
      expect(h.goalsSearched).toEqual([]);
      expect(runMemory(runId).claims.size).toBe(0);
      // a declined establishing run is proposed again: the engine still has no run
      const again = await h.synth.synthesize(ctxFor({ runId, step: 2, intent, engineRun: false, window: [runEntry({ step: 1, command: TEST_COMMAND, outcome: 'declined', parsed: false })] }));
      expect(again.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
      expect(h.goalsSearched).toEqual([]);
      // the engine executed it: the search proceeds (under `investigate` through its one compliance read)
      const p2 = await h.synth.synthesize(ctxFor({ runId, step: 3, intent, engineRun: false, window: [executedRun(2, TEST_COMMAND, { passed: 1, failed: 1 })] }));
      expect(p2.action.kind).toBe(intent === 'investigate' ? 'read' : 'patch');
      expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(1); // one synthesizer baseline for the unchanged workspace
    }
  });

  it('a fixed item is claimed on the post-patch run once per verdict: an unaccepted claim is deferred with a note on a run that will still show failures, claimed again on the run the fresh baseline measured all-green, and `done` follows the green run at once', async () => {
    const TWO = 'tests/test_gcd.py::test_two';
    const THREE = 'tests/test_gcd.py::test_three';
    const g1Item = `fix ${GCD_TEST} in gcd.py`;
    const g2Item = `fix ${TWO} in gcd.py`;
    const g3Item = `fix ${THREE} in gcd.py`;
    const b1 = failingBaseline([GCD_TEST, TWO, THREE], [GCD_OTHER_TEST]);
    const b2 = failingBaseline([TWO, THREE], [GCD_TEST, GCD_OTHER_TEST]);
    const b3 = failingBaseline([THREE], [GCD_TEST, TWO, GCD_OTHER_TEST]);
    const b4: BaselineRun = { summary: summary({ command: TEST_COMMAND, failing: [], passing: [GCD_TEST, TWO, THREE, GCD_OTHER_TEST] }), output: '' };
    const h = harness({ baselines: [b1, b2, b3, b4], pickFirstOpen: true });
    const runId = 'ctl-claims';
    const p1 = await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    expect(p1.action.kind).toBe('patch');
    const mem = runMemory(runId);
    expect(new Set(mem.goals.map((g) => g.planItem))).toEqual(new Set([g1Item, g2Item, g3Item]));
    // the ledger's order is the clustering's; plan drafts list items in that order
    const ledger = (items: string[]): string[] => [...mem.goals.map((g) => g.planItem).filter((i) => items.includes(i)), VERIFY_ITEM];
    // step 2: the post-patch run claims the item the fresh baseline shows fixed
    const p2 = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)], plan: { remaining: [g1Item, g2Item, g3Item, VERIFY_ITEM] } }));
    expect(p2.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p2.plan.done).toEqual([g1Item]);
    expect(p2.plan.remaining).toEqual(ledger([g2Item, g3Item]));
    expect(mem.claims.get(g1Item)).toEqual({ step: 2, judged: null });
    // step 3: the engine ran it (2 of 4 pass) and the judge said 0.50 → the item stays in the plan; the search moves to the second goal
    const unsure = judgedRun(2, { passed: 2, failed: 2 }, [{ text: g1Item, judged: 0.5, accepted: false }]);
    const plan3 = { remaining: [g1Item, g2Item, g3Item, VERIFY_ITEM], unverified: [{ text: g1Item, step: 2, judged: 0.5 }] };
    const p3 = await h.synth.synthesize(ctxFor({ runId, step: 3, window: [executedPatch(1), unsure], plan: plan3 }));
    expect(mem.claims.get(g1Item)).toEqual({ step: 2, judged: 0.5 });
    expect(p3.action.kind).toBe('patch');
    expect(h.goalsSearched).toHaveLength(2);
    // step 4: the second post-patch run will still show a failure (3 of 4): it claims the second item alone; the first is deferred with its note, in `remaining`
    const ctx4 = ctxFor({ runId, step: 4, window: [executedPatch(1), unsure, executedPatch(3)], plan: plan3 });
    const p4 = await h.synth.synthesize(ctx4);
    expect(p4.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p4.plan.done).toEqual([g2Item]);
    expect(p4.plan.remaining).toEqual(ledger([g1Item, g3Item]));
    expect(p4.plan.openProblems).toEqual([`'${g1Item}' claimed at step 2, judge said p=0.50; this test run re-verifies it before it is claimed again`]);
    expect(JSON.parse(p4.rawText)).toMatchObject({ kind: 'run', claimed: [g2Item], deferred: [g1Item] });
    expect(mem.claims.get(g2Item)).toEqual({ step: 4, judged: null });
    // the claim records survive a checkpoint (§5.2)
    expect(persistedOf(ctx4).claims).toEqual({ [g1Item]: { step: 2, judged: 0.5 }, [g2Item]: { step: 4, judged: null } });
    // step 5: the engine ran it (3 of 4) and accepted the second claim; the third goal is searched
    const accepted2 = judgedRun(4, { passed: 3, failed: 1 }, [{ text: g2Item, judged: 0.9, accepted: true }]);
    const plan5 = { done: [{ text: g2Item, evidence: { step: 4, judged: 0.9 } }], remaining: [g1Item, g3Item, VERIFY_ITEM], unverified: [{ text: g1Item, step: 2, judged: 0.5 }] };
    const p5 = await h.synth.synthesize(ctxFor({ runId, step: 5, window: [unsure, executedPatch(3), accepted2], plan: plan5 }));
    expect(p5.action.kind).toBe('patch');
    expect(mem.claims.has(g2Item)).toBe(false); // accepted
    // step 6: the fresh baseline is all-green, so the run claims the third item AND the deferred first one (every claim is verifiable on an all-green run); no note
    const p6 = await h.synth.synthesize(ctxFor({ runId, step: 6, window: [executedPatch(3), accepted2, executedPatch(5)], plan: plan5 }));
    expect(p6.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p6.plan.done).toEqual(ledger([g1Item, g3Item]).slice(0, -1));
    expect(p6.plan.remaining).toEqual([VERIFY_ITEM]);
    expect(p6.plan.openProblems).toEqual([]);
    expect(JSON.parse(p6.rawText)).not.toHaveProperty('deferred');
    expect(mem.claims.get(g1Item)).toEqual({ step: 6, judged: null }); // a new claim replaces the old record
    // step 7: the engine ran the green suite and accepted both → `done` at once (no further run), claiming only the standing verification item
    const greenRun = judgedRun(6, { passed: 4, failed: 0 }, [{ text: g1Item, judged: 0.8, accepted: true }, { text: g3Item, judged: 0.9, accepted: true }]);
    const plan7 = { done: [{ text: g2Item, evidence: { step: 4, judged: 0.9 } }, { text: g1Item, evidence: { step: 6, judged: 0.8 } }, { text: g3Item, evidence: { step: 6, judged: 0.9 } }], remaining: [VERIFY_ITEM] };
    const p7 = await h.synth.synthesize(ctxFor({ runId, step: 7, window: [accepted2, executedPatch(5), greenRun], plan: plan7 }));
    expect(p7.action.kind).toBe('done');
    if (p7.action.kind === 'done') expect(p7.action.summary).toBe('all 4 tests pass; 3 fixes committed');
    expect(p7.plan).toEqual({ done: [VERIFY_ITEM], remaining: [], openProblems: [] });
    expect(mem.claims.size).toBe(0);
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(4);
    // the green run scrolled out of the window (reads since): the controller's record still says the engine saw it green → `done`, not another run
    const late = await h.synth.synthesize(ctxFor({ runId, step: 11, engineRun: false, window: [readEntryAt(7), readEntryAt(8), readEntryAt(9), readEntryAt(10)], plan: plan7 }));
    expect(late.action.kind).toBe('done');
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(4);
    // had the judge stayed unsure on the green run, the `done` still claims the item (its claims are not graded; the completion Noul reads the green run)
    const stillUnsure = judgedRun(6, { passed: 4, failed: 0 }, [{ text: g1Item, judged: 0.6, accepted: false }, { text: g3Item, judged: 0.9, accepted: true }]);
    mem.claims.set(g1Item, { step: 6, judged: 0.6 });
    const d2 = await h.synth.synthesize(ctxFor({ runId, step: 7, window: [accepted2, executedPatch(5), stillUnsure], plan: { ...plan7, done: plan7.done.filter((d) => d.text !== g1Item), remaining: [g1Item, VERIFY_ITEM] } }));
    expect(d2.action.kind).toBe('done');
    expect(d2.plan.done).toEqual([g1Item, VERIFY_ITEM]);
  });

  it('a claim on a run the engine declined was never judged: the next run claims the item again; a re-fixed item claimed after a passing suite run is claimable once more', async () => {
    const runId = 'ctl-claims-declined';
    const h = harness({ baselines: [failingBaseline(), greenBaseline()] });
    const item = `fix ${GCD_TEST} in gcd.py`;
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const p2 = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    expect(p2.plan.done).toEqual([item]);
    const mem = runMemory(runId);
    expect(mem.claims.get(item)).toEqual({ step: 2, judged: null });
    const declined = runEntry({ step: 2, command: TEST_COMMAND, outcome: 'declined', parsed: false });
    const p3 = await h.synth.synthesize(ctxFor({ runId, step: 3, window: [executedPatch(1), declined] }));
    expect(p3.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p3.plan.done).toEqual([item]); // claimed again: nothing judged the first claim
    expect(p3.plan.openProblems).toEqual([]);
    expect(mem.claims.get(item)).toEqual({ step: 3, judged: null });
    // the judge rejected it on the executed run (p = 0.10), but a later passing suite run executed by the engine re-measured it: the next run may claim it again
    const rejected = judgedRun(3, { passed: 2, failed: 0 }, [{ text: item, judged: 0.1, accepted: false }]);
    mem.goals[0]!.status = 'fixed';
    await h.synth.synthesize(ctxFor({ runId, step: 4, engineRun: false, window: [executedPatch(1), declined, rejected], plan: { remaining: [item, VERIFY_ITEM], harnessProblems: [{ kind: 'rejected_claim', text: `'${item}' was not accepted as done: done_0 = 0.10`, step: 3 }] } }));
    expect(mem.claims.get(item)).toEqual({ step: 3, judged: 0.1 });
    const { splitClaims } = await import('../../../../src/synth/search/proposal.js');
    // (with a baseline that still fails another test: on an all-green baseline the run claims everything, see the test above)
    const notGreen = { ...mem, baseline: failingBaseline([GCD_OTHER_TEST], [GCD_TEST]).summary };
    const noNewRun = splitClaims(ctxFor({ runId, step: 5, engineRun: false, window: [rejected], plan: { remaining: [item, VERIFY_ITEM] } }), notGreen);
    expect(noNewRun).toEqual({ claims: [], deferred: [{ item, claim: { step: 3, judged: 0.1 } }] });
    mem.lastEngineRun = { step: 6, action: `run ${TEST_COMMAND}`, passed: 2, failed: 0, errors: 0 };
    expect(splitClaims(ctxFor({ runId, step: 7, engineRun: false, plan: { remaining: [item, VERIFY_ITEM] } }), { ...notGreen, lastEngineRun: mem.lastEngineRun })).toEqual({ claims: [item], deferred: [] });
  });
});

describe('controller bookkeeping: partials survive a park, untested pairs keep the goal open, a held passer is committed before any park', () => {
  const TWO = 'tests/test_gcd.py::test_two';
  const FILE = sourceFile('gcd.py', GCD_BUGGY);

  /** Two complementary partials of `goal` on the committed base: half 1 passes GCD_TEST at L5, half 2 passes TWO at the gap after it. */
  function rememberHalves(mem: RunMemory, goal: Goal): void {
    const committed = mem.bases.find((b) => b.origin === 'committed');
    if (committed === undefined) throw new Error('no committed base');
    const h1 = outcomeOf(jobOf(cand(siteAt(FILE, 5), 'return gcd(b, a % b)  # half 1'), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: [TWO] }) });
    const h2 = outcomeOf(jobOf(cand(siteAt(FILE, 6, 'insert'), 'return a  # half 2', { source: 'template' }), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, TWO], failing: [GCD_TEST] }) });
    guardState(mem).partials.push({ goalId: goal.id, outcome: h1 }, { goalId: goal.id, outcome: h2 });
  }

  it('a budget exit with an untested pair of complementary partials keeps the goal open; once the pair ran the §5.3 park applies, the partials are kept and persisted (≤ 4 per goal), and a resumed run restores them', async () => {
    const h = harness({
      baselines: [failingBaseline([GCD_TEST, TWO], [GCD_OTHER_TEST])],
      results: [
        (goal, mem) => {
          if (guardState(mem).partials.length === 0) rememberHalves(mem, goal);
          return budget()(goal);
        },
      ],
      pickFirstOpen: true,
    });
    const runId = 'ctl-pairs';
    const first = ctxFor({ runId, step: 1 });
    const p1 = await h.synth.synthesize(first);
    const mem = runMemory(runId);
    const g1 = mem.goals.find((g) => g.tests.includes(GCD_TEST));
    if (g1 === undefined) throw new Error('no goal for the gcd test');
    // the search ended on the budget, but the pair of the two halves is untested: the goal stays open, no budget hit is counted
    expect(p1.action.kind).toBe('run');
    expect(g1).toMatchObject({ status: 'open', budgetHits: 0 });
    expect(first.events.some((e) => e.type === 'synth' && e.phase === 'pairs' && /1 untested pair of complementary partials; the goal stays open/.test(e.detail))).toBe(true);
    expect(freshPairsOfPartials(mem, g1)).toHaveLength(1);
    // persisted beside the ledger (same coverage, so the smaller edit first)
    const records = partialsFromPersisted(toJson(persistedOf(first)));
    expect(records.map((r) => `${r.goalId}:${r.line}:${r.kind}`)).toEqual([`${g1.id}:6:insert`, `${g1.id}:5:replace`]);
    expect(records[1]).toMatchObject({ path: 'gcd.py', text: 'return gcd(b, a % b)  # half 1', newlyPassing: [GCD_TEST], source: 'mutation' });

    // the pair ran (tried) and found nothing: the usual rule counts budget hits and parks at the second, the partials survive the park
    const committed = mem.bases.find((b) => b.origin === 'committed');
    if (committed === undefined) throw new Error('no committed base');
    for (const c of freshPairsOfPartials(mem, g1)) mem.tried.add(sha12(applyCandidate(c, committed.files).diff));
    const window = [executedRun(1, `${TEST_COMMAND} tests/test_gcd.py`, { passed: 1, failed: 2 })];
    await h.synth.synthesize(ctxFor({ runId, step: 2, window }));
    expect(g1).toMatchObject({ status: 'open', budgetHits: 1 });
    const third = ctxFor({ runId, step: 3, window });
    await h.synth.synthesize(third);
    expect(g1.status).toBe('parked');
    expect(g1.parkedReason).toMatch(/2 consecutive budget-hit steps/);
    expect(partialsOf(mem, g1)).toHaveLength(2);
    expect(improvedBase(mem)).toBeUndefined();
    const checkpoint = toJson(persistedOf(third));
    expect(partialsFromPersisted(checkpoint)).toHaveLength(2);
    // the checkpoint keeps at most four per goal, the most covering first
    for (let i = 0; i < 5; i++) guardState(mem).partials.push({ goalId: g1.id, outcome: outcomeOf(jobOf(cand(siteAt(FILE, 5), `return gcd(b, a % b)  # dup ${i}`), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: [TWO] }) }) });
    const fourth = ctxFor({ runId, step: 4, window });
    await h.synth.synthesize(fourth);
    expect(partialsFromPersisted(toJson(persistedOf(fourth))).filter((r) => r.goalId === g1.id)).toHaveLength(4);

    // a new process resumes from the checkpoint: the two halves are restored on the fresh baseline and their pair is enumerable again
    const resumed = ctxFor({ runId: 'ctl-pairs-resume', step: 6, synthState: checkpoint });
    await h.synth.synthesize(resumed);
    const mem2 = runMemory('ctl-pairs-resume');
    const g1b = mem2.goals.find((g) => g.tests.includes(GCD_TEST));
    if (g1b === undefined) throw new Error('no restored goal for the gcd test');
    expect(resumed.events.some((e) => e.type === 'synth' && e.phase === 'pairs' && /2 remembered partials restored from the checkpoint/.test(e.detail))).toBe(true);
    expect(partialsOf(mem2, g1b)).toHaveLength(2);
    expect(pairsOfPartials(mem2, g1b)).toHaveLength(1);
  });

  it('a `budget` result while the guard holds a passer: the controller commits it as the patch — a hold is decided, never parked away', async () => {
    const h = harness({
      results: [
        (goal, mem) => {
          const committed = mem.bases.find((b) => b.origin === 'committed');
          if (committed === undefined) throw new Error('no committed base');
          const o = outcomeOf(jobOf(cand(siteAt(FILE, 5), FIX_TEXT), committed), 'plausible');
          guardState(mem).pending = { goalId: goal.id, outcome: o, siteKey: siteKeyOf(o.applied.candidate), phase: 'SEEDS' };
          return budget()(goal);
        },
      ],
    });
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(p.action.kind).toBe('patch');
    if (p.action.kind === 'patch') expect(p.action.diff).toContain(FIX_TEXT);
    const mem = runMemory(ctx.runId);
    expect(mem.goals[0]?.status).toBe('fixed');
    expect(guardState(mem).pending).toBeNull();
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'guard' && /search ended budget with a held passer; committing it/.test(e.detail))).toBe(true);
    expect(ledgerOf(ctx)).toEqual(['fixed 1, open 0, parked 0']);
  });
});
