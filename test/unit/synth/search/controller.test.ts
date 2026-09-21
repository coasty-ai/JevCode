/**
 * The §2.2 control flow of the Ledger + Sieve controller with faked collaborators: run after
 * patch, baseline → pickGoal → searchSubGoal, the proposal per decision kind, the bounded
 * recursion on a park, budget exits, green → done, all parked → partial done, directive
 * dispatch, the persisted state and the ledger event.
 */
import { describe, expect, it } from 'vitest';

import type { Proposal, SynthesisContext, WindowEntry } from '../../../../src/core/types.js';
import { toJson } from '../../../../src/core/json.js';
import { DEFAULT_TEST_COMMAND, ESTABLISH_GOAL, ESTABLISH_GOAL_REPOSITORY, LedgerSieveSynthesizer, SUITE_TOO_SLOW, allPass, detectLayout, framesOfTraceback, lastExecutedActionKind, lastWorkspaceChangeStep, loadPythonFiles, mentionedInTask, moduleFilesOf, networkOracleNote, normaliseTestCommand, patchNotExecutedLastStep, repositoryNotes, repositoryPatchNotes, runMemory, workspaceChangedSince } from '../../../../src/synth/search/index.js';
import { emptyIntrospection, runFacts } from '../../../../src/synth/introspect/index.js';
import type { IntrospectedNames } from '../../../../src/synth/introspect/index.js';
import type { HistoryFacts } from '../../../../src/synth/history/index.js';
import { fakeWorkspace } from './proposal-helpers.js';
import { BEST_GUESS_PARK_REASON, BEST_GUESS_REJECTED_REASON, NETWORK_ORACLE_OPEN_PROBLEM, bestGuessTestId, mergeSummaries } from '../../../../src/synth/oracle/index.js';
import type { OracleSearch, ReproGoal, ReproSpec, VerifyReproResult } from '../../../../src/synth/oracle/index.js';
import { dropMemory } from '../../../../src/synth/search/memory.js';
import type { PersistedMemoryState as PersistedWithRepository } from '../../../../src/synth/search/memory.js';
import { BEST_GUESS_NOTE, runActionLabel } from '../../../../src/synth/search/proposal.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { applyCandidate as applyForOutcome, progress as progressOf } from '../../../../src/synth/verify/index.js';
import type { BaselineRun, RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import { GOAL_ITEM_RE, VERIFY_ITEM } from '../../../../src/synth/search/proposal.js';
import type { SubGoalResult } from '../../../../src/synth/search/subgoal.js';
import type { PersistedMemoryState } from '../../../../src/synth/search/memory.js';
import type { Goal, PersistedSearchState } from '../../../../src/synth/search/types.js';
import { isPersistedSearchState } from '../../../../src/synth/search/types.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { sha12 } from '../../../../src/core/hash.js';
import { freshPairsOfPartials, guardState, holdBestPartial, improvedBase, pairsOfPartials, partialsFromPersisted, partialsOf, siteKeyOf } from '../../../../src/synth/search/bases.js';
import { handleDirective } from '../../../../src/synth/search/directive.js';
import { LONE_PASSER_HOLD_MAX_NOUL } from '../../../../src/synth/search/guard.js';
import { noulAnswer } from './helpers.js';
import { directiveText } from '../../../../src/loop/stages/replan.js';
import { siteKey } from '../../../../src/synth/search/sites.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedPatch, executedRun, fakeCtx, jobOf, outcomeOf, siteAt, sourceFile, summary, unusedRepositoryDeps } from './controller-fakes.js';
import type { AskScript } from './controller-fakes.js';
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
  /** repository mode: the oracle search, the localiser, the regression scope, the reproduction re-run and the best-guess search, scripted */
  findOracle?: SearchDeps['findOracle'];
  locate?: SearchDeps['locate'];
  regressionScope?: SearchDeps['regressionScope'];
  verifyRepro?: SearchDeps['verifyRepro'];
  /** the introspection pass and the history harvest, scripted (recorded in `calls` only when given) */
  introspect?: SearchDeps['introspect'];
  harvestHistory?: SearchDeps['harvestHistory'];
  bestGuess?: ((goal: Goal, mem: RunMemory) => SubGoalResult)[];
  /** workspace files handed to loadFiles (default: gcd.py) */
  files?: SourceFile[];
  /** the regression run of a progress commit the controller makes itself (default: the partial's subset run stands for the suite) */
  regressionRun?: SearchDeps['regressionRun'];
}

interface TracebackFrameLike {
  file: string;
  line: number;
  fn: string | null;
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
  const guesses = [...(o.bestGuess ?? [])];
  const stubs = unusedRepositoryDeps();
  const deps: SearchDeps = {
    loadFiles: async () => {
      calls.push('loadFiles');
      return new Map((o.files ?? [file]).map((f) => [f.path, f]));
    },
    findOracle: async (ctx, input) => {
      calls.push('findOracle');
      return (o.findOracle ?? stubs.findOracle)(ctx, input);
    },
    locate: async (ctx, mem, goal) => {
      calls.push(`locate:${goal.id}`);
      return (o.locate ?? stubs.locate)(ctx, mem, goal);
    },
    regressionScope: async (ctx, moduleFiles, paths, max) => {
      calls.push('regressionScope');
      return (o.regressionScope ?? stubs.regressionScope)(ctx, moduleFiles, paths, max);
    },
    verifyRepro: async (ctx, spec) => {
      calls.push('verifyRepro');
      return (o.verifyRepro ?? stubs.verifyRepro)(ctx, spec);
    },
    introspect: async (ctx, spec, anchors) => {
      if (o.introspect === undefined) return stubs.introspect(ctx, spec, anchors);
      calls.push('introspect');
      return o.introspect(ctx, spec, anchors);
    },
    harvestHistory: async (ctx, moduleFiles, sources) => {
      if (o.harvestHistory === undefined) return stubs.harvestHistory(ctx, moduleFiles, sources);
      calls.push('harvestHistory');
      return o.harvestHistory(ctx, moduleFiles, sources);
    },
    searchBestGuess: async (_ctx, mem, goal) => {
      calls.push(`searchBestGuess:${goal.id}`);
      goalsSearched.push(goal.id);
      const next = guesses.length > 1 ? guesses.shift() : guesses[0];
      if (next === undefined) throw new Error('searchBestGuess is not scripted');
      return next(goal, mem);
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
    regressionRun:
      o.regressionRun ??
      (async (_ctx, _mem, _goal, outcome) => {
        calls.push('regressionRun');
        return outcome.subset;
      }),
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

  it('the step after an executed `patch` is the full-suite `run`; it claims the goals the fresh baseline shows fixed, whatever the intent (never a `read`)', async () => {
    const h = harness();
    const runId = 'ctl-run-after-patch';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    // investigate intent, patched file not shown: still the run — the synthesizer never proposes a read (§19.7)
    const r = await h.synth.synthesize(ctxFor({ runId, step: 2, intent: 'investigate', window: [executedPatch(1)] }));
    expect(r.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
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
    // (two re-baselines: the `investigate` step above and this one both saw the workspace changed since their baseline)
    expect(h.calls.filter((c) => c === 'runTests').length).toBeGreaterThanOrEqual(2);
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
      provider: 'openrouter',
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
  it('intent investigate: never a `read` (§19.7: 7–12 declined reads per miss tripped the loop detector); the search proceeds at once and every proposal of the run is a patch, run or done', async () => {
    const runId = 'ctl-investigate';
    const h = harness({ baselines: [{ summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), output: '' }] });
    const p1 = await h.synth.synthesize(ctxFor({ runId, step: 1, intent: 'investigate' }));
    expect(p1.action.kind).toBe('patch');
    expect(h.goalsSearched).toEqual(['g1']);
    // a window full of earlier reads (an engine that read on its own) changes nothing: still no read, and no `read` event
    const readEntry = { step: 1, intent: 'investigate' as const, action: 'read gcd.py', outcome: 'declined' as const, shownFiles: [], notes: [] };
    const h2 = harness({ baselines: [{ summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), output: '' }] });
    const ctx2 = ctxFor({ runId: 'ctl-investigate-window', step: 3, intent: 'investigate', window: [readEntry, { ...readEntry, step: 2 }] });
    const p2 = await h2.synth.synthesize(ctx2);
    expect(['patch', 'run', 'done']).toContain(p2.action.kind);
    expect(ctx2.events.some((e) => e.type === 'synth' && e.phase === 'read')).toBe(false);
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
      // the engine executed it: the search proceeds under every intent (never a compliance read, §19.7)
      const p2 = await h.synth.synthesize(ctxFor({ runId, step: 3, intent, engineRun: false, window: [executedRun(2, TEST_COMMAND, { passed: 1, failed: 1 })] }));
      expect(p2.action.kind).toBe('patch');
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

// ---------------------------------------------------------------------------------------
// Repository mode: the oracle from the issue, the best guess, the scoped regression run
// ---------------------------------------------------------------------------------------

describe('repository mode (Django/sympy-shaped workspace): oracle goal, best guess, scoped baseline, persistence', () => {
  const MODULE = 'django/db/models/fields/__init__.py';
  const DETECTED = { command: 'python tests/runtests.py --parallel 1', runner: 'django' as const };
  const SCOPED = 'python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite model_fields.tests';
  const SCOPED2 = 'python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite model_fields.tests field_defaults.tests';
  const REPRO_ID = 'repro::abcd1234';
  const TASK = 'Model Field.__hash__() should be immutable.\n\n```python\nfrom django.db import models\nf = models.CharField(max_length=200)\nd = {f: 1}\nassert f in d\n```\n';
  const SCOPED_PASSING = ['test_a (model_fields.tests.BasicFieldTests)', 'test_b (model_fields.tests.BasicFieldTests)'];
  const spec: ReproSpec = { testId: REPRO_ID, chunks: ['from django.db import models', 'f = models.CharField(max_length=200)', 'd = {f: 1}', 'assert f in d'], criterion: { form: 'no_exception' }, expectedText: 'completes without raising AssertionError', blockIndex: 0, options: { packageName: 'django', framework: 'django', timeoutMs: 30_000 } };
  const failure = { testId: REPRO_ID, call: 'assert f in d', expected: 'completes without raising AssertionError', actual: 'AssertionError: ' };
  const runResult = (): ReproGoal['result'] => ({ status: 'ran', python: '3.9.6', statements: [], exitCode: 0, durationMs: 900, outputTail: '' });
  const reproFailing = (): VerifyReproResult => ({ result: runResult(), verdict: { pass: false, actual: 'AssertionError: ', expected: 'completes without raising', reason: 'AssertionError raised at "assert f in d"', statement: null }, summary: summary({ command: `python <${REPRO_ID}>`, failing: [REPRO_ID], failures: [failure], durationMs: 900 }), failure });
  const reproPassing = (): VerifyReproResult => ({ result: runResult(), verdict: { pass: true, actual: 'completed', expected: 'completes without raising', reason: 'no statement raised', statement: null }, summary: summary({ command: `python <${REPRO_ID}>`, passing: [REPRO_ID], durationMs: 900 }), failure: { ...failure, actual: 'completed' } });
  const oracleFound = (): OracleSearch => {
    const r = reproFailing();
    const goal: ReproGoal = { spec, failure, summary: r.summary, verdict: r.verdict, result: r.result };
    return { outcome: 'valid', strength: 'strong', goal, extraction: { blocks: [], tracebacks: [], expectations: [] }, judgement: null, choice: null, anchors: [], traceback: null, requests: 1, note: `strong oracle ${REPRO_ID} from block 0`, durationMs: 1200 };
  };
  const scopedGreen = (command = SCOPED): BaselineRun => ({ summary: summary({ command, passing: SCOPED_PASSING, failing: [], durationMs: 4000 }), output: '' });
  const moduleFile = (): SourceFile => sourceFile(MODULE, 'class Field:\n    def __hash__(self):\n        return hash((self.creation_counter, self.model._meta.app_label))\n');
  const locateModule = (file: SourceFile): SearchDeps['locate'] => async () => ({ files: [{ path: MODULE, probability: 0.9 }], functions: [], sites: [siteAt(file, 3)], requests: 4 });
  const scopeFor = (): SearchDeps['regressionScope'] => async (_ctx, _files, _paths, max) => (max === 2 ? { testFiles: ['tests/model_fields/tests.py', 'tests/field_defaults/tests.py'], command: SCOPED2, tier: 'stem', note: 'named after the module' } : { testFiles: ['tests/model_fields/tests.py'], command: SCOPED, tier: 'stem', note: 'named after the module' });
  const repoCtx = (o: Parameters<typeof ctxFor>[0] = {}): ReturnType<typeof fakeCtx> => ctxFor({ testCommand: DETECTED, files: [MODULE, 'django/__init__.py', 'tests/model_fields/tests.py', 'tests/field_defaults/tests.py', 'tests/runtests.py'], task: TASK, engineRun: false, ...o });
  /** an engine-executed run of a scoped command as the window labels it (provider/actions.ts clips the command to 80 chars) */
  const scopedRun = (step: number, command: string, counts: { passed: number; failed: number }): WindowEntry => ({ ...executedRun(step, command, counts), action: runActionLabel(command) });
  /** a scripted commit whose outcome carries the merged scoped + reproduction run, as the repository queue produces it */
  const reproCommit = (file: SourceFile, reproPasses: boolean, text = '        return hash(self.creation_counter)'): ((goal: Goal, mem: RunMemory) => SubGoalResult) => (goal, mem) => {
    const base = mem.bases[0]!;
    const applied = applyForOutcome(cand(siteAt(file, 3), text), base.files);
    const scoped = summary({ command: SCOPED, passing: SCOPED_PASSING, failing: [], durationMs: 4000 });
    const full = mergeSummaries(scoped, (reproPasses ? reproPassing() : reproFailing()).summary);
    const outcome: VerifyOutcome = { job: { candidate: applied.candidate, base, p: 0.9, sourcePrior: 1, key: [base.summary.passed, 0.9, 1] }, applied, subset: full, full, progress: progressOf(base.summary, full), status: 'plausible' };
    return { kind: 'commit', applied, allGoalTestsPass: reproPasses, outcome, trace: makeTrace({ goalId: goal.id, outcome: reproPasses ? 'fixed' : 'partial', runMode: 'RANK', candidatesTested: 3 }) };
  };

  it('oracle path: the establishing step finds the oracle, localises once, scopes the regression run and runs it; the ledger holds the reproduction goal; the state persists', async () => {
    const file = moduleFile();
    const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: scopeFor() });
    const ctx = repoCtx({ runId: 'repo-oracle', step: 1 });
    const p = await h.synth.synthesize(ctx);
    // the order: oracle (1 request + the base run) → the goal → one localisation → the scope → the scoped baseline; the reproduction is not re-run (the oracle's own run is the baseline's)
    expect(h.calls).toEqual(['loadFiles', 'findOracle', 'locate:g1', 'regressionScope', 'runTests']);
    expect(h.runTestCommands).toEqual([SCOPED]);
    // the establishing run is the scoped command, and its goal text says what the base commit shows
    expect(p.action).toMatchObject({ kind: 'run', command: SCOPED });
    expect(p.goal).toBe(`${ESTABLISH_GOAL_REPOSITORY} (0 of 2 scoped tests fail at the base commit; the issue's reproduction ${REPRO_ID} fails)`);
    expect(p.plan.remaining).toEqual([`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM]);
    const mem = runMemory(ctx.runId);
    expect(mem.repository).toMatchObject({ goalId: 'g1', moduleFiles: [MODULE], scope: { testFiles: ['tests/model_fields/tests.py'], command: SCOPED, tier: 'stem' }, repro: { strength: 'strong' }, oracleOutcome: 'valid', bestGuessCommitted: false, knownFailures: 0 });
    expect(mem.repository?.repro?.spec.testId).toBe(REPRO_ID);
    // the ledger: one goal, the reproduction as its test; the baseline merges the scoped run and the reproduction
    expect(mem.goals.map((g) => [g.id, g.tests, g.status, g.suspectedFiles])).toEqual([['g1', [REPRO_ID], 'open', [MODULE]]]);
    expect(mem.goals[0]?.failures).toEqual([failure]);
    expect(mem.baseline).toMatchObject({ command: SCOPED, passed: 2, failed: 1, total: 3, failing: [REPRO_ID], durationMs: 4000 });
    // the oracle model: the reproduction is the goal-subset run, the scoped run the full one; no per-case timeout
    expect(mem.oracle).toMatchObject({ runner: 'other', tRunMs: { goalSubset: 900, fullSuite: 4000 }, perTestTimeoutMs: null, baselineDurationMs: 4000, lanes: 8 });
    expect(mem.localizeCache.get('g1')?.sites).toHaveLength(1);
    // the persisted state carries the mode (the spec's chunks and criterion included)
    const persisted = persistedOf(ctx) as PersistedWithRepository;
    expect(persisted.repository).toMatchObject({ goalId: 'g1', moduleFiles: [MODULE], repro: { strength: 'strong', spec: { testId: REPRO_ID, chunks: spec.chunks, criterion: { form: 'no_exception' } } }, scope: { command: SCOPED } });
    expect(persisted.goals['g1']).toMatchObject({ status: 'open', tests: [REPRO_ID], planItem: `fix ${REPRO_ID} in ${MODULE}` });
    const phases = ctx.events.filter((e) => e.type === 'synth').map((e) => (e.type === 'synth' ? e.phase : ''));
    expect(phases).toEqual(['oracle', 'localize', 'scope', 'baseline', 'verify', 'ledger']);
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 1, parked 0']);
  });

  it('oracle path: the search verifies in lanes by the reproduction (evidence names it), the post-patch re-baseline re-runs it on the workspace, and green is the reproduction passing', async () => {
    const file = moduleFile();
    let reproNow: () => VerifyReproResult = reproPassing;
    const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: scopeFor(), verifyRepro: async () => reproNow(), results: [reproCommit(file, true)] });
    const runId = 'repo-oracle-fix';
    await h.synth.synthesize(repoCtx({ runId, step: 1 }));
    // step 2: the engine ran the scoped command; the search (scripted) commits a candidate whose lane run passed the reproduction and the scope
    const p2 = await h.synth.synthesize(repoCtx({ runId, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
    expect(p2.action.kind).toBe('patch');
    expect(h.calls.filter((c) => c.startsWith('searchSubGoal'))).toEqual(['searchSubGoal:g1']);
    expect(h.calls.filter((c) => c === 'searchBestGuess:g1')).toEqual([]);
    expect(h.calls.filter((c) => c === 'verifyRepro')).toEqual([]); // the oracle's own base run served the baseline
    expect(p2.goal).toBe(`apply verified fix: ${REPRO_ID} now passes (2→3 of 3), no regressions; mutation/relational_swap at ${MODULE}:3`);
    expect(p2.evidence).toMatchObject({ kind: 'shadow_test_run', command: SCOPED, before: { passed: 2, failed: 1, total: 3 }, after: { passed: 3, failed: 0, total: 3 }, newlyPassing: [REPRO_ID], newlyFailing: [], goalTests: [REPRO_ID], selection: 'rank' });
    expect(p2.plan.openProblems).toEqual([]);
    const mem = runMemory(runId);
    expect(mem.goals[0]?.status).toBe('fixed');
    // step 3: the patch executed → re-baseline: the scoped run again and the reproduction on the workspace (it passes) → the post-patch run claims the item
    const p3 = await h.synth.synthesize(repoCtx({ runId, step: 3, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 }), executedPatch(2, [MODULE])], plan: { remaining: [`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM] } }));
    expect(h.calls.filter((c) => c === 'runTests')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'verifyRepro')).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'findOracle')).toHaveLength(1); // never re-asked
    expect(h.calls.filter((c) => c.startsWith('locate'))).toHaveLength(1); // never re-localised
    expect(p3.action).toMatchObject({ kind: 'run', command: SCOPED });
    expect(p3.plan.done).toEqual([`fix ${REPRO_ID} in ${MODULE}`]);
    expect(p3.goal).toContain('expect 2 of 2 tests to pass and the reproduction to pass');
    expect(mem.baseline).toMatchObject({ passed: 3, failed: 0, total: 3, passing: [...SCOPED_PASSING, REPRO_ID] });
    expect(mem.goals[0]?.status).toBe('fixed');
    // step 4: the engine ran the scoped command green → done (all three "tests": the two scoped and the reproduction)
    const p4 = await h.synth.synthesize(repoCtx({ runId, step: 4, window: [executedPatch(2, [MODULE]), scopedRun(3, SCOPED, { passed: 2, failed: 0 })], plan: { done: [{ text: `fix ${REPRO_ID} in ${MODULE}`, evidence: { step: 3, judged: 0.9 } }], remaining: [VERIFY_ITEM] } }));
    expect(p4.action.kind).toBe('done');
    if (p4.action.kind === 'done') expect(p4.action.summary).toBe(`all 2 tests pass; the reproduction ${REPRO_ID} passes; 1 fix committed`);
    // had the reproduction still failed on the workspace after the patch, the goal would be open again and green withheld
    dropMemory(runId);
    reproNow = reproFailing;
    const h2 = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: scopeFor(), verifyRepro: async () => reproNow(), results: [reproCommit(file, true)] });
    const runId2 = 'repo-oracle-nofix';
    await h2.synth.synthesize(repoCtx({ runId: runId2, step: 1 }));
    await h2.synth.synthesize(repoCtx({ runId: runId2, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
    const q3 = await h2.synth.synthesize(repoCtx({ runId: runId2, step: 3, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 }), executedPatch(2, [MODULE])] }));
    expect(q3.action).toMatchObject({ kind: 'run', command: SCOPED });
    expect(q3.plan.done).toEqual([]);
    expect(runMemory(runId2).goals[0]?.status).toBe('open');
    expect(q3.goal).toContain('expect 2 of 2 tests to pass and the reproduction to still fail');
  });

  it('a green scoped run at the base commit is not a finished task: without an oracle the best-guess goal is searched, committed once with the unverified note, then parked and the run ends partial', async () => {
    const file = moduleFile();
    const bestGuessCommit = (goal: Goal, mem: RunMemory): SubGoalResult => {
      const base = mem.bases[0]!;
      const applied = applyForOutcome(cand(siteAt(file, 3), '        return hash(self.creation_counter)'), base.files);
      const scoped = summary({ command: SCOPED, passing: SCOPED_PASSING, failing: [], durationMs: 4000 });
      const outcome: VerifyOutcome = { job: { candidate: applied.candidate, base, p: 0.7, sourcePrior: 1, key: [2, 0.7, 1] }, applied, subset: scoped, full: scoped, progress: progressOf(base.summary, scoped), status: 'plausible' };
      return { kind: 'commit', applied, allGoalTestsPass: false, outcome, trace: makeTrace({ goalId: goal.id, outcome: 'partial', runMode: 'RANK', candidatesTested: 3, plausible: 2 }) };
    };
    const h = harness({ files: [file], baselines: [scopedGreen()], locate: locateModule(file), regressionScope: scopeFor(), bestGuess: [bestGuessCommit] });
    const runId = 'repo-best-guess';
    const issueId = bestGuessTestId(TASK);
    const item = `fix ${issueId} in ${MODULE}`;
    const p1 = await h.synth.synthesize(repoCtx({ runId, step: 1 }));
    // the scoped baseline is all green, yet the step is the establishing run, never `done`
    expect(p1.action).toMatchObject({ kind: 'run', command: SCOPED });
    expect(p1.goal).toBe(`${ESTABLISH_GOAL_REPOSITORY} (0 of 2 scoped tests fail at the base commit; no reproduction oracle from the issue text)`);
    expect(p1.plan.remaining).toEqual([item, VERIFY_ITEM]);
    const mem = runMemory(runId);
    expect(mem.repository).toMatchObject({ repro: null, oracleOutcome: 'no_blocks', bestGuessCommitted: false });
    expect(mem.goals.map((g) => [g.tests, g.status])).toEqual([[[issueId], 'open']]);
    expect(mem.baseline).toMatchObject({ passed: 2, failed: 0, total: 2 });
    // step 2: the best-guess search, not the sub-goal search; the patch says what it is
    const p2 = await h.synth.synthesize(repoCtx({ runId, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
    expect(h.calls.filter((c) => c.startsWith('search'))).toEqual(['searchBestGuess:g1']);
    expect(p2.action.kind).toBe('patch');
    expect(p2.goal).toBe(`apply best-guess fix (no reproduction oracle; unverified): mutation/relational_swap at ${MODULE}:3; the 2 scoped tests still pass as before (2→2 of 2), no regressions`);
    expect(p2.plan.openProblems).toEqual([`${item}: parked (${BEST_GUESS_PARK_REASON})`, BEST_GUESS_NOTE]);
    expect(p2.plan.remaining).toEqual([item, VERIFY_ITEM]);
    expect(p2.evidence).toMatchObject({ selection: 'rank', goalTests: [], newlyPassing: [], newlyFailing: [], candidatesTested: 3, before: { passed: 2 }, after: { passed: 2 } });
    expect(mem.goals[0]).toMatchObject({ status: 'parked', parkedReason: BEST_GUESS_PARK_REASON });
    expect(mem.repository?.bestGuessCommitted).toBe(true);
    // step 3: the patch executed → the scoped run again (no reproduction to re-run), nothing claimed
    const p3 = await h.synth.synthesize(repoCtx({ runId, step: 3, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 }), executedPatch(2, [MODULE])] }));
    expect(p3.action).toMatchObject({ kind: 'run', command: SCOPED });
    expect(p3.plan.done).toEqual([]);
    expect(h.calls.filter((c) => c === 'verifyRepro')).toEqual([]);
    // step 4: the engine ran it → every goal parked → an honest partial done with the oracle's outcome, the scope and the note
    const p4 = await h.synth.synthesize(repoCtx({ runId, step: 4, window: [executedPatch(2, [MODULE]), scopedRun(3, SCOPED, { passed: 2, failed: 0 })] }));
    expect(p4.action.kind).toBe('done');
    if (p4.action.kind === 'done') expect(p4.action.summary).toMatch(new RegExp(`^partial: fixed 0 of 1 failing tests; ${issueId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ${BEST_GUESS_PARK_REASON.replace(/[()]/g, '\\$&')}; oracle from the issue: no_blocks`));
    expect(p4.plan.openProblems.some((n) => n.startsWith('regression scope: 1 test file (stem)'))).toBe(true);
    expect(h.calls.filter((c) => c.startsWith('search'))).toEqual(['searchBestGuess:g1']); // one guess per run
  });

  it('a blocked best-guess patch is re-proposed once from the stash, then the goal parks as rejected: no second guess, partial done', async () => {
    const file = moduleFile();
    const commit = (goal: Goal, mem: RunMemory): SubGoalResult => {
      const base = mem.bases[0]!;
      const applied = applyForOutcome(cand(siteAt(file, 3), '        return hash(self.creation_counter)'), base.files);
      return { kind: 'commit', applied, allGoalTestsPass: false, trace: makeTrace({ goalId: goal.id, outcome: 'partial', runMode: 'RANK' }) };
    };
    const h = harness({ files: [file], baselines: [scopedGreen()], locate: locateModule(file), regressionScope: scopeFor(), bestGuess: [commit] });
    const runId = 'repo-best-guess-blocked';
    await h.synth.synthesize(repoCtx({ runId, step: 1 }));
    const engineRan = scopedRun(1, SCOPED, { passed: 2, failed: 0 });
    const p2 = await h.synth.synthesize(repoCtx({ runId, step: 2, window: [engineRan] }));
    expect(p2.action.kind).toBe('patch');
    const blocked = { ...executedPatch(2, [MODULE]), outcome: 'blocked' as const, reason: 'risk 0.8' };
    const p3 = await h.synth.synthesize(repoCtx({ runId, step: 3, window: [engineRan, blocked] }));
    expect(p3.action).toEqual(p2.action); // the stash, no search
    expect(h.calls.filter((c) => c.startsWith('search'))).toEqual(['searchBestGuess:g1']);
    const p4 = await h.synth.synthesize(repoCtx({ runId, step: 4, window: [engineRan, blocked, { ...blocked, step: 3 }] }));
    expect(h.calls.filter((c) => c.startsWith('search'))).toEqual(['searchBestGuess:g1']); // still one guess
    expect(runMemory(runId).goals[0]).toMatchObject({ status: 'parked', parkedReason: BEST_GUESS_REJECTED_REASON });
    expect(runMemory(runId).committed).toEqual([]);
    expect(p4.action.kind).toBe('done');
    if (p4.action.kind === 'done') expect(p4.action.summary).toContain(BEST_GUESS_REJECTED_REASON);
  });

  it('the establishing step harvests the introspected names before the localisation and the module files\' history after the scope, once per run; a post-patch re-baseline harvests nothing again; the facts are registered per run and named in the transcript', async () => {
    const file = moduleFile();
    const introspected: IntrospectedNames = { ...emptyIntrospection('ran', '1 operand, 2 classes, 1 predicates, 0 attributes, 0 module names'), classes: ['CharField', 'Field'], predicates: ['is_relation'], operands: [{ expr: 'f', typeName: 'CharField', classes: ['CharField', 'Field'], predicates: ['is_relation'], falsyPredicates: ['is_relation'], attributes: [], frame: null, raisingReceiver: true }], durationMs: 640 };
    const history: HistoryFacts = { commits: [{ sha: 'a'.repeat(40), subject: 'Fixed #31750 -- equality', time: 2, reason: 'ticket:#31750', hunks: [] }], files: [MODULE], commands: 3, durationMs: 1700, note: '1 commit, 0 change runs in 1 file (3 git commands; ticket #31750: 1 commit)' };
    const seen: { specIds: string[]; anchors: number[]; historyFiles: string[][]; sourcePaths: string[][] } = { specIds: [], anchors: [], historyFiles: [], sourcePaths: [] };
    let reproNow: () => VerifyReproResult = reproPassing;
    const h = harness({
      files: [file],
      baselines: [scopedGreen()],
      findOracle: async () => oracleFound(),
      locate: locateModule(file),
      regressionScope: scopeFor(),
      verifyRepro: async () => reproNow(),
      introspect: async (_ctx, s, anchors) => {
        seen.specIds.push(s.testId);
        seen.anchors.push(anchors.length);
        return introspected;
      },
      harvestHistory: async (_ctx, moduleFiles, sources) => {
        seen.historyFiles.push([...moduleFiles]);
        seen.sourcePaths.push(sources.map((f) => f.path));
        return history;
      },
      results: [reproCommit(file, true)],
    });
    const runId = 'repo-facts';
    const ctx1 = repoCtx({ runId, step: 1 });
    await h.synth.synthesize(ctx1);
    // introspection right after the oracle (its anchors), the history once the localisation named the module files
    expect(h.calls).toEqual(['loadFiles', 'findOracle', 'introspect', 'locate:g1', 'regressionScope', 'harvestHistory', 'runTests']);
    expect(seen).toEqual({ specIds: [REPRO_ID], anchors: [0], historyFiles: [[MODULE]], sourcePaths: [[MODULE]] });
    expect(runFacts(runId)).toEqual({ introspected, history });
    const phases = ctx1.events.filter((e) => e.type === 'synth').map((e) => (e.type === 'synth' ? `${e.phase}: ${e.detail}` : ''));
    expect(phases.map((p) => p.split(':')[0])).toEqual(['oracle', 'introspect', 'localize', 'scope', 'history', 'baseline', 'verify', 'ledger']);
    expect(phases[1]).toBe('introspect: ran in 640 ms: 1 operand, 2 classes, 1 predicates, 0 attributes, 0 module names; f: CharField (1 predicate, receiver)');
    expect(phases[4]).toBe('history: 1 commit, 0 change runs in 1 file (3 git commands; ticket #31750: 1 commit) (1700 ms)');
    // the search commits; the post-patch re-baseline re-runs the scope and the reproduction, never the harvests
    await h.synth.synthesize(repoCtx({ runId, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
    await h.synth.synthesize(repoCtx({ runId, step: 3, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 }), executedPatch(2, [MODULE])], plan: { remaining: [`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM] } }));
    expect(h.calls.filter((c) => c === 'introspect' || c === 'harvestHistory')).toEqual(['introspect', 'harvestHistory']);
    expect(h.calls.filter((c) => c === 'loadFiles')).toHaveLength(2);
    expect(runFacts(runId)).toEqual({ introspected, history });
  });

  it('a resumed run harvests the facts again from the checkpoint\'s traceback and module files (they are not persisted); a failing harvest is a transcript line, never fatal', async () => {
    const file = moduleFile();
    const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => ({ ...oracleFound(), traceback: '  File "django/db/models/fields/__init__.py", line 3, in __hash__\n' }), locate: locateModule(file), regressionScope: scopeFor() });
    const runId = 'repo-facts-resume';
    const ctx1 = repoCtx({ runId, step: 1 });
    await h.synth.synthesize(ctx1);
    expect(runFacts(runId)).toEqual({ introspected: null, history: null });
    const persisted = persistedOf(ctx1);
    dropMemory(runId);
    const anchors: TracebackFrameLike[][] = [];
    const h2 = harness({
      files: [file],
      baselines: [scopedGreen()],
      verifyRepro: async () => reproFailing(),
      introspect: async (_ctx, _spec, frames) => {
        anchors.push(frames.map((f) => ({ file: f.file, line: f.line, fn: f.fn })));
        return emptyIntrospection('timeout', 'the introspection run did not finish in 60000 ms', 60_000);
      },
      harvestHistory: async () => {
        throw new Error('git is not available');
      },
      results: [parked('nothing found')],
    });
    const ctx2 = repoCtx({ runId, step: 5, synthState: toJson(persisted), plan: { remaining: [`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM] }, window: [scopedRun(4, SCOPED, { passed: 2, failed: 0 })] });
    const p = await h2.synth.synthesize(ctx2);
    expect(h2.calls.slice(0, 4)).toEqual(['loadFiles', 'introspect', 'harvestHistory', 'runTests']);
    expect(anchors).toEqual([[{ file: 'django/db/models/fields/__init__.py', line: 3, fn: '__hash__' }]]);
    expect(runFacts(runId)).toEqual({ introspected: expect.objectContaining({ status: 'timeout' }), history: null });
    const events = ctx2.events.filter((e) => e.type === 'synth').map((e) => (e.type === 'synth' ? `${e.phase}: ${e.detail}` : ''));
    expect(events).toContain('introspect: timeout in 60000 ms: the introspection run did not finish in 60000 ms');
    expect(events).toContain('history: history harvest failed: git is not available');
    expect(p.action.kind).toBe('done');
    expect(framesOfTraceback(null)).toEqual([]);
  });

  it('a resumed run restores the oracle goal and the scope from synthState: no second Jev request, no re-localisation, the reproduction re-measured on the workspace', async () => {
    const file = moduleFile();
    const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: scopeFor() });
    const runId = 'repo-resume';
    const ctx1 = repoCtx({ runId, step: 1 });
    await h.synth.synthesize(ctx1);
    const persisted = persistedOf(ctx1);
    // a new process: fresh memory, the checkpoint's synthState and plan, an engine run in the window
    dropMemory(runId);
    const h2 = harness({
      files: [file],
      baselines: [scopedGreen()],
      findOracle: async () => {
        throw new Error('the oracle must not be searched again on resume');
      },
      locate: async () => {
        throw new Error('no re-localisation on resume');
      },
      regressionScope: async () => {
        throw new Error('the scope is restored, not chosen again');
      },
      verifyRepro: async () => reproFailing(),
      results: [parked('nothing found')],
    });
    const ctx2 = repoCtx({ runId, step: 5, synthState: toJson(persisted), plan: { remaining: [`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM] }, window: [scopedRun(4, SCOPED, { passed: 2, failed: 0 })] });
    const p = await h2.synth.synthesize(ctx2);
    expect(h2.calls).toEqual(['loadFiles', 'runTests', 'verifyRepro', 'pickGoal', 'searchSubGoal:g1', 'pickGoal']);
    expect(h2.runTestCommands).toEqual([SCOPED]);
    const mem = runMemory(runId);
    expect(mem.repository).toMatchObject({ goalId: 'g1', moduleFiles: [MODULE], scope: { command: SCOPED }, repro: { strength: 'strong' }, oracleOutcome: 'valid' });
    expect(mem.repository?.repro?.spec).toEqual(spec);
    expect(mem.goals.map((g) => [g.id, g.tests, g.planItem])).toEqual([['g1', [REPRO_ID], `fix ${REPRO_ID} in ${MODULE}`]]);
    expect(mem.baseline).toMatchObject({ passed: 2, failed: 1, total: 3, failing: [REPRO_ID] });
    // the scripted search parked the goal: partial done, with the mode's notes
    expect(p.action.kind).toBe('done');
    expect(p.plan.openProblems.some((n) => n.startsWith('oracle from the issue: valid'))).toBe(true);
  });

  it('a scoped baseline that times out is retried once on the scope\'s top two files before the §4.1 park', async () => {
    const file = moduleFile();
    const SCOPED3 = `${SCOPED2} model_fields.test_charfield`;
    // three files at first, two on the retry
    const wide: SearchDeps['regressionScope'] = async (_ctx, _files, _paths, max) => (max === 2 ? { testFiles: ['tests/model_fields/tests.py', 'tests/field_defaults/tests.py'], command: SCOPED2, tier: 'stem', note: 'named after the module' } : { testFiles: ['tests/model_fields/tests.py', 'tests/field_defaults/tests.py', 'tests/model_fields/test_charfield.py'], command: SCOPED3, tier: 'stem', note: 'named after the module' });
    const slow: BaselineRun = { summary: summary({ command: SCOPED3, failing: ['<test run>'], passing: [], timedOut: true, exitCode: null, durationMs: 300_000 }), output: '' };
    const h = harness({ files: [file], baselines: [slow, scopedGreen(SCOPED2)], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: wide });
    const ctx = repoCtx({ runId: 'repo-slow', step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(h.runTestCommands).toEqual([SCOPED3, SCOPED2]);
    expect(h.calls.filter((c) => c === 'regressionScope')).toHaveLength(2);
    expect(runMemory(ctx.runId).repository?.scope.command).toBe(SCOPED2);
    expect(p.action).toMatchObject({ kind: 'run', command: SCOPED2 });
    expect(runMemory(ctx.runId).goals[0]?.status).toBe('open'); // the retry passed: nothing parked
    // both runs timing out parks the goal with the reason and proposes the (smaller) command
    const h2 = harness({ files: [file], baselines: [slow, { ...slow, summary: { ...slow.summary, command: SCOPED2 } }], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: wide });
    const ctx2 = repoCtx({ runId: 'repo-slow-2', step: 1 });
    const q = await h2.synth.synthesize(ctx2);
    expect(q.action).toMatchObject({ kind: 'run', command: SCOPED2 });
    expect(runMemory(ctx2.runId).goals[0]).toMatchObject({ status: 'parked', parkedReason: SUITE_TOO_SLOW });
  });

  it('the goal-subset `run` of a budget-hit step on a repository is the scoped command, with the run\'s maximum timeout', async () => {
    const file = moduleFile();
    const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => oracleFound(), locate: locateModule(file), regressionScope: scopeFor(), results: [budget()] });
    const runId = 'repo-budget';
    await h.synth.synthesize(repoCtx({ runId, step: 1 }));
    const p = await h.synth.synthesize(repoCtx({ runId, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
    expect(p.action).toMatchObject({ kind: 'run', command: SCOPED, timeoutMs: 22_000 }); // 3 × 4 s + 10 s, under the 300 s bound
    expect(p.goal).toBe(`record the failing behaviour of ${REPRO_ID}`);
  });

  it('file loading orders task-named files first; moduleFilesOf falls back from the file beam to the sites, then the traceback', () => {
    expect(mentionedInTask('sympy/printing/mathematica.py', 'mathematica_code(Max(x,2)) prints wrong')).toBe(1);
    expect(mentionedInTask('django/db/models/fields/__init__.py', 'the fields hash changes')).toBe(1);
    expect(mentionedInTask('sympy/core/add.py', 'nothing about it')).toBe(0);
    const file = moduleFile();
    const files = new Map([[MODULE, file], ['django/utils/html.py', sourceFile('django/utils/html.py', 'x = 1\n')]]);
    expect(moduleFilesOf({ files: [{ path: 'django/utils/html.py', probability: 0.8 }, { path: MODULE, probability: 0.5 }, { path: 'tests/x/tests.py', probability: 0.4 }], functions: [], sites: [], requests: 0 }, null, files)).toEqual(['django/utils/html.py', MODULE]);
    expect(moduleFilesOf({ files: [], functions: [], sites: [siteAt(file, 3)], requests: 0 }, null, files)).toEqual([MODULE]);
    expect(moduleFilesOf(null, 'Traceback (most recent call last):\n  File "/ws/django/utils/html.py", line 3, in f', files)).toEqual(['django/utils/html.py']);
    expect(moduleFilesOf(null, null, files)).toEqual([]);
  });

  describe('a network-dependent oracle (`weak_network`, jev-only-rungs-1-2.md §23.3): the goal exists with strength weak, every patch and done carries the open problem, a lone passer is arbitrated', () => {
    const EVIDENCE = 'requests against httpbin.org';
    const networkOracle = (): OracleSearch => ({ ...oracleFound(), outcome: 'weak_network', strength: 'weak', network: { kind: 'static', evidence: EVIDENCE }, note: `network-weak oracle ${REPRO_ID} from block 0: requests.put(...) -> ConnectionError (expected completes; no_exception; confirmed by a second run in 900 ms; ${NETWORK_ORACLE_OPEN_PROBLEM} (${EVIDENCE}): passers need the regression run and Jev's arbitration)` });
    const vouch: AskScript = (qs) => Object.fromEntries(Object.keys(qs).map((id) => [id, noulAnswer(0.8)]));
    const doubt: AskScript = (qs) => Object.fromEntries(Object.keys(qs).map((id) => [id, noulAnswer(0.12)]));
    const guardEvents = (ctx: ReturnType<typeof fakeCtx>): string[] => ctx.events.filter((e) => e.type === 'synth' && e.phase === 'guard').map((e) => (e.type === 'synth' ? e.detail : ''));
    const PASSER = `mutation/relational_swap at ${MODULE}:3`;

    it('the note helpers: the open problem starts with NETWORK_ORACLE_OPEN_PROBLEM verbatim and names the reproduction; a weak_network oracle gets it instead of the weak-criterion note; other outcomes get none', () => {
      const scope = { testFiles: ['tests/model_fields/tests.py'], command: SCOPED, tier: 'stem' as const, note: 'named after the module' };
      const repro = { spec, strength: 'weak' as const };
      const network = networkOracleNote({ oracleOutcome: 'weak_network', repro, scope });
      expect(network).toBe(`${NETWORK_ORACLE_OPEN_PROBLEM} ${REPRO_ID}: its verdict is the network's as much as the code's; a passer is committed only after the regression scope (1 file) and Jev's arbitration`);
      expect(networkOracleNote({ oracleOutcome: 'valid_weak', repro, scope })).toBeNull();
      expect(networkOracleNote({ oracleOutcome: 'valid', repro: { spec, strength: 'strong' }, scope })).toBeNull();
      expect(repositoryPatchNotes({ oracleOutcome: 'weak_network', repro, scope })).toEqual([network]);
      expect(repositoryPatchNotes({ oracleOutcome: 'valid_weak', repro, scope })).toEqual([`weak reproduction oracle ${REPRO_ID}: the criterion only says the observed wrong value changed; the regression scope (1 files) is the other check`]);
      expect(repositoryPatchNotes({ oracleOutcome: 'valid', repro: { spec, strength: 'strong' }, scope })).toEqual([]);
      const repo = { goalId: 'g1', moduleFiles: [MODULE], scope, repro, oracleOutcome: 'weak_network', oracleNote: 'n', traceback: null, bestGuessCommitted: false, knownFailures: 0, lastRepro: null };
      expect(repositoryNotes(repo).at(-1)).toBe(network);
      expect(repositoryNotes({ ...repo, oracleOutcome: 'valid_weak' }).some((n) => n.startsWith(NETWORK_ORACLE_OPEN_PROBLEM))).toBe(false);
    });

    it('establishing step: the goal exists (strength weak, outcome weak_network); a lone passer is put to Q16 alone and, vouched, committed as a plain verified fix with the open problem; the green done carries it too', async () => {
      const file = moduleFile();
      const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => networkOracle(), locate: locateModule(file), regressionScope: scopeFor(), verifyRepro: async () => reproPassing(), results: [reproCommit(file, true)] });
      const runId = 'repo-network-vouched';
      const p1 = await h.synth.synthesize(repoCtx({ runId, step: 1, ask: vouch }));
      expect(p1.action).toMatchObject({ kind: 'run', command: SCOPED });
      expect(p1.goal).toBe(`${ESTABLISH_GOAL_REPOSITORY} (0 of 2 scoped tests fail at the base commit; the issue's reproduction ${REPRO_ID} fails)`);
      const mem = runMemory(runId);
      expect(mem.repository).toMatchObject({ goalId: 'g1', oracleOutcome: 'weak_network', repro: { strength: 'weak', spec: { testId: REPRO_ID } } });
      expect(mem.goals.map((g) => [g.id, g.tests, g.status])).toEqual([['g1', [REPRO_ID], 'open']]);
      const note = networkOracleNote(mem.repository!);
      expect(note).toMatch(new RegExp(`^${NETWORK_ORACLE_OPEN_PROBLEM} repro::`));
      // step 2: the scripted search commits a lone passer (trace not arbitrated) → ONE Q16 `general_cand_01` over it, nothing else asked
      const ctx2 = repoCtx({ runId, step: 2, ask: vouch, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] });
      const p2 = await h.synth.synthesize(ctx2);
      expect(p2.action.kind).toBe('patch');
      expect(ctx2.askCalls.map((c) => Object.keys(c.questions))).toEqual([['general_cand_01']]);
      expect(ctx2.askCalls[0]?.state).toMatchObject({ candidates: { cand_01: { line: 'L3' } }, tests: [{ input: 'assert f in d' }] });
      expect(p2.goal).toBe(`apply verified fix: ${REPRO_ID} now passes (2→3 of 3), no regressions; ${PASSER}`);
      expect(p2.plan.openProblems).toEqual([note]);
      // the evidence says Jev judged the pick, and the request is charged to the step's trace (makeTrace's 2 + 1)
      expect(p2.evidence).toMatchObject({ arbitrated: true, goalTests: [REPRO_ID], newlyPassing: [REPRO_ID], newlyFailing: [] });
      expect(JSON.parse(p2.rawText) as { arbitrated: boolean; jevRequests: number }).toMatchObject({ arbitrated: true, jevRequests: 3 });
      expect(guardEvents(ctx2)).toEqual([`g1: ${NETWORK_ORACLE_OPEN_PROBLEM}; Q16 on the lone passer ${PASSER}: general 0.80 ≥ ${LONE_PASSER_HOLD_MAX_NOUL}, committing it`]);
      // steps 3–4: the post-patch run, then the green done: the open problem stays on the plan
      const plan = { remaining: [`fix ${REPRO_ID} in ${MODULE}`, VERIFY_ITEM], openProblems: [note!] };
      const p3 = await h.synth.synthesize(repoCtx({ runId, step: 3, ask: vouch, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 }), executedPatch(2, [MODULE])], plan }));
      expect(p3.action).toMatchObject({ kind: 'run', command: SCOPED });
      expect(p3.plan.openProblems).toEqual([note]);
      const p4 = await h.synth.synthesize(repoCtx({ runId, step: 4, ask: vouch, window: [executedPatch(2, [MODULE]), scopedRun(3, SCOPED, { passed: 2, failed: 0 })], plan: { done: [{ text: `fix ${REPRO_ID} in ${MODULE}`, evidence: { step: 3, judged: 0.9 } }], remaining: [VERIFY_ITEM], openProblems: [note!] } }));
      expect(p4.action.kind).toBe('done');
      if (p4.action.kind === 'done') expect(p4.action.summary).toBe(`all 2 tests pass; the reproduction ${REPRO_ID} passes; 1 fix committed`);
      expect(p4.plan.openProblems).toEqual([note]);
      expect(JSON.parse(p4.rawText) as { notes?: string[] }).toMatchObject({ kind: 'done', mode: 'green', notes: [note] });
    });

    it('a doubted lone passer (general < LONE_PASSER_HOLD_MAX_NOUL) is committed as possible overfit beside the open problem; a Q15/Q16-arbitrated pick and a step with no request left are not asked again', async () => {
      const file = moduleFile();
      const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => networkOracle(), locate: locateModule(file), regressionScope: scopeFor(), results: [reproCommit(file, true)] });
      const runId = 'repo-network-doubted';
      await h.synth.synthesize(repoCtx({ runId, step: 1, ask: doubt }));
      const note = networkOracleNote(runMemory(runId).repository!)!;
      const ctx2 = repoCtx({ runId, step: 2, ask: doubt, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] });
      const p2 = await h.synth.synthesize(ctx2);
      expect(p2.action.kind).toBe('patch');
      expect(ctx2.askCalls.map((c) => Object.keys(c.questions))).toEqual([['general_cand_01']]);
      expect(p2.plan.openProblems).toEqual([`possible overfit: relational_swap at ${MODULE}:3 passes every test, but Jev rated no test-passing candidate a general fix; review the change`, note]);
      expect(JSON.parse(p2.rawText) as { note?: string }).toMatchObject({ note: 'possible overfit', arbitrated: true });
      expect(guardEvents(ctx2)).toEqual([`g1: ${NETWORK_ORACLE_OPEN_PROBLEM}; Q16 on the lone passer ${PASSER}: general 0.12 < ${LONE_PASSER_HOLD_MAX_NOUL}, committing it as possible overfit`]);
      dropMemory(runId);
      // the guard already arbitrated ≥ 2 passers (Q15/Q16): the pick stands, no second request
      const arbitrated = (goal: Goal, mem: RunMemory): SubGoalResult => {
        const r = reproCommit(file, true)(goal, mem);
        return { ...r, trace: { ...r.trace, arbitrated: true, plausible: 2, clusters: 2 } };
      };
      const h2 = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => networkOracle(), locate: locateModule(file), regressionScope: scopeFor(), results: [arbitrated] });
      const runId2 = 'repo-network-arbitrated';
      await h2.synth.synthesize(repoCtx({ runId: runId2, step: 1 }));
      const ctx2b = repoCtx({ runId: runId2, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] });
      const q2 = await h2.synth.synthesize(ctx2b);
      expect(q2.action.kind).toBe('patch');
      expect(ctx2b.askCalls).toEqual([]);
      expect(q2.plan.openProblems).toEqual([note]);
      expect(guardEvents(ctx2b)).toEqual([]);
      dropMemory(runId2);
      // no Jev request left this step: the commit stands with the open problem and the transcript says it was not arbitrated
      const spent = (goal: Goal, mem: RunMemory): SubGoalResult => {
        mem.stepBudget.jevRequestsLeft = 0;
        return reproCommit(file, true)(goal, mem);
      };
      const h3 = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => networkOracle(), locate: locateModule(file), regressionScope: scopeFor(), results: [spent] });
      const runId3 = 'repo-network-spent';
      await h3.synth.synthesize(repoCtx({ runId: runId3, step: 1 }));
      const ctx2c = repoCtx({ runId: runId3, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] });
      const r2 = await h3.synth.synthesize(ctx2c);
      expect(r2.action.kind).toBe('patch');
      expect(ctx2c.askCalls).toEqual([]);
      expect(r2.plan.openProblems).toEqual([note]);
      expect(JSON.parse(r2.rawText) as { arbitrated: boolean }).toMatchObject({ arbitrated: false });
      expect(guardEvents(ctx2c)).toEqual([`g1: ${NETWORK_ORACLE_OPEN_PROBLEM}; the lone passer ${PASSER} was not arbitrated (no Jev request left this step); committing it with the open problem`]);
    });

    it('every goal parked: the partial done carries the oracle outcome and the open problem', async () => {
      const file = moduleFile();
      const h = harness({ files: [file], baselines: [scopedGreen()], findOracle: async () => networkOracle(), locate: locateModule(file), regressionScope: scopeFor(), results: [parked('nothing found')] });
      const runId = 'repo-network-parked';
      await h.synth.synthesize(repoCtx({ runId, step: 1 }));
      const note = networkOracleNote(runMemory(runId).repository!)!;
      const p2 = await h.synth.synthesize(repoCtx({ runId, step: 2, window: [scopedRun(1, SCOPED, { passed: 2, failed: 0 })] }));
      expect(p2.action.kind).toBe('done');
      if (p2.action.kind === 'done') expect(p2.action.summary).toContain('oracle from the issue: weak_network');
      expect(p2.plan.openProblems.some((n) => n.startsWith('oracle from the issue: weak_network'))).toBe(true);
      expect(p2.plan.openProblems).toContain(note);
    });
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

describe('§5.3 budget-hit steps: progress at a new site is not stagnation (2026-09-20)', () => {
  const progressStep = (newSites: number) => (goal: Goal): SubGoalResult => ({ kind: 'budget', trace: makeTrace({ goalId: goal.id, outcome: 'budget', candidatesTested: 40, sitesTested: 4, newSitesTested: newSites }) });
  const windowAfterRun = [executedRun(1, `${TEST_COMMAND} tests/test_gcd.py`, { passed: 1, failed: 1 })];

  it('budget-hit steps that reach new sites keep the goal open past two hits and past three attempts; the hard cap parks at the fourth', async () => {
    const h = harness({ results: [progressStep(2)] });
    const runId = 'ctl-budget-progress';
    const first = ctxFor({ runId, step: 1 });
    await h.synth.synthesize(first);
    const mem = runMemory(runId);
    const g = mem.goals[0];
    if (g === undefined) throw new Error('no goal');
    expect(g).toMatchObject({ status: 'open', budgetHits: 0, budgetSteps: 1, attempts: 1 });
    expect(first.events.some((e) => e.type === 'synth' && e.phase === 'budget' && /budget-hit step 1 of 4 \(progress: 2 new sites of 4 tested\); the goal stays open/.test(e.detail))).toBe(true);
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: windowAfterRun }));
    expect(g).toMatchObject({ status: 'open', budgetHits: 0, budgetSteps: 2 });
    // the third search would have parked under "3 searches without a commit": a progressing budget step is the same search, continued
    await h.synth.synthesize(ctxFor({ runId, step: 3, window: windowAfterRun }));
    expect(g).toMatchObject({ status: 'open', budgetHits: 0, budgetSteps: 3, attempts: 3 });
    const fourth = ctxFor({ runId, step: 4, window: windowAfterRun });
    const p4 = await h.synth.synthesize(fourth);
    expect(p4.action.kind).toBe('run');
    expect(g.status).toBe('parked');
    expect(g.parkedReason).toBe('4 consecutive budget-hit steps (hard cap)');
    expect(h.calls.filter((c) => c.startsWith('searchSubGoal'))).toHaveLength(4);
  });

  it('a stagnant step after progress counts: with three searches behind it the goal parks on the attempts rule', async () => {
    const results = [progressStep(1), progressStep(1), progressStep(0)];
    const h = harness({ results: [(goal) => (results.shift() ?? progressStep(0))(goal)] });
    const runId = 'ctl-budget-then-stagnant';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: windowAfterRun }));
    const g = runMemory(runId).goals[0];
    if (g === undefined) throw new Error('no goal');
    expect(g).toMatchObject({ status: 'open', budgetHits: 0, budgetSteps: 2 });
    await h.synth.synthesize(ctxFor({ runId, step: 3, window: windowAfterRun }));
    expect(g.status).toBe('parked');
    expect(g.parkedReason).toBe('3 searches without a commit');
  });

  it('two stagnant steps park as before; a "progress" step whose top sites are all seeds-exhausted is stagnation', async () => {
    const h = harness({
      results: [
        (goal, mem) => {
          const file = mem.bases[0]?.files.get('gcd.py');
          if (file === undefined) throw new Error('no gcd.py');
          const sites = [siteAt(file, 5), siteAt(file, 6, 'insert')];
          mem.localizeCache.set(goal.id, { files: [], functions: [], sites, requests: 0 });
          for (const s of sites) goal.exhausted.set(siteKey(s), new Set(['mutation', 'template', 'donor']));
          return progressStep(2)(goal);
        },
      ],
    });
    const runId = 'ctl-budget-exhausted-top';
    const first = ctxFor({ runId, step: 1 });
    await h.synth.synthesize(first);
    const g = runMemory(runId).goals[0];
    if (g === undefined) throw new Error('no goal');
    expect(g).toMatchObject({ status: 'open', budgetHits: 1, budgetSteps: 1 });
    expect(first.events.some((e) => e.type === 'synth' && e.phase === 'budget' && /nothing new: 1 of 2 stagnant/.test(e.detail))).toBe(true);
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: windowAfterRun }));
    expect(g.status).toBe('parked');
    expect(g.parkedReason).toBe('2 consecutive budget-hit steps that tested nothing new');
  });
});

// ---------------------------------------------------------------------------------------
// The re-baseline file cache (memory.ts SearchMemory.fileCache; §17's heap finding)
// ---------------------------------------------------------------------------------------

describe('loadPythonFiles: a re-baseline re-analyses only the files whose text changed and hands back the same SourceFile objects for the rest', () => {
  function workspaceCtx(runId: string, contents: Map<string, string>): ReturnType<typeof fakeCtx> {
    const base = fakeCtx({ runId, files: [...contents.keys()] });
    const ws = fakeWorkspace([...contents.keys()]);
    return {
      ...base,
      workspace: {
        ...ws,
        listCandidates: async () => [...contents.keys()].map((path) => ({ path, bytes: contents.get(path)?.length ?? 0 })),
        read: async (path) => {
          const content = contents.get(path);
          if (content === undefined) throw new Error(`no such file ${path}`);
          return { path, content, bytes: content.length, truncatedBytes: 0 };
        },
      },
    };
  }

  it('reuses unchanged files by identity, re-analyses a changed one, drops a vanished one, and says so in the transcript', async () => {
    const contents = new Map([
      ['pkg/a.py', 'def a():\n    return 1\n'],
      ['pkg/b.py', 'def b():\n    return 2\n'],
      ['pkg/c.py', 'def c():\n    return 3\n'],
      ['tests/test_a.py', 'def test_a():\n    assert a() == 1\n'],
    ]);
    const cache = new Map<string, SourceFile>();
    const ctx1 = workspaceCtx('cache-run', contents);
    const first = await loadPythonFiles(ctx1, cache);
    expect([...first.keys()]).toEqual(['pkg/a.py', 'pkg/b.py', 'pkg/c.py']);
    expect(cache.size).toBe(3);
    expect(ctx1.events.filter((e) => e.type === 'synth')).toEqual([]); // the first load reuses nothing: no line
    // a commit changed b.py; c.py is gone
    contents.set('pkg/b.py', 'def b():\n    return 20\n');
    contents.delete('pkg/c.py');
    const ctx2 = workspaceCtx('cache-run', contents);
    const second = await loadPythonFiles(ctx2, cache);
    expect([...second.keys()]).toEqual(['pkg/a.py', 'pkg/b.py']);
    expect(second.get('pkg/a.py')).toBe(first.get('pkg/a.py'));
    expect(second.get('pkg/b.py')).not.toBe(first.get('pkg/b.py'));
    expect(second.get('pkg/b.py')?.src).toBe('def b():\n    return 20\n');
    expect(second.get('pkg/b.py')?.mod.lines[1]).toBe('    return 20');
    expect(cache.has('pkg/c.py')).toBe(false);
    expect(cache.get('pkg/b.py')).toBe(second.get('pkg/b.py'));
    const line = ctx2.events.find((e) => e.type === 'synth' && e.phase === 'files');
    expect(line !== undefined && line.type === 'synth' ? line.detail : '').toMatch(/^2 Python files: 1 unchanged since the last load \(reused\), 1 analysed \(\d+ ms\)$/);
    // by default the cache is the run memory's, so the controller's re-baselines share it
    const third = await loadPythonFiles(workspaceCtx('cache-run', contents));
    const fourth = await loadPythonFiles(workspaceCtx('cache-run', contents));
    expect(fourth.get('pkg/a.py')).toBe(third.get('pkg/a.py'));
    expect(runMemory('cache-run').fileCache.size).toBe(2);
    dropMemory('cache-run');
  });
});

// Progress commits and no `read` churn (jev-only-rungs-1-2.md §19.7)
// ---------------------------------------------------------------------------------------

describe('progress commits: a lone partial at the budget exit is committed as a partial fix, the goal stays open and its remaining tests re-cluster', () => {
  const TWO = 'tests/test_gcd.py::test_two';
  const FILE = sourceFile('gcd.py', GCD_BUGGY);
  /** One pytest FAILURES section: the test's own frame, then `frame` (a source frame) and the error line. */
  const section = (name: string, frame: string): string => `___________________________________ ${name} ___________________________________\ntests/test_gcd.py:10: in ${name}\n    assert run() == 1\n${frame}\nE   RecursionError: maximum recursion depth exceeded\n`;
  const gcdFrame = 'gcd.py:5: in gcd\n    return gcd(a % b, b)';
  /** A baseline whose failing tests all raise at gcd.py:gcd, so frame clustering makes them ONE goal (the long tier's merged-goal shape). */
  function framedBaseline(failing: string[], passing: string[]): BaselineRun {
    const output = `============================= FAILURES =============================\n${failing.map((t) => section(t.split('::')[1] ?? t, gcdFrame)).join('')}${failing.length} failed, ${passing.length} passed in 0.10s\n`;
    return { summary: summary({ command: TEST_COMMAND, failing, passing }), output };
  }

  it('a `budget` result with a held partial and no untested pair: the controller commits it as a partial fix with the partial-fix evidence; the goal stays open with one progress commit', async () => {
    const h = harness({
      baselines: [framedBaseline([GCD_TEST, TWO], [GCD_OTHER_TEST])],
      results: [
        (goal, mem) => {
          const committed = mem.bases.find((b) => b.origin === 'committed');
          if (committed === undefined) throw new Error('no committed base');
          const o = outcomeOf(jobOf(cand(siteAt(FILE, 5), 'return gcd(b, a % b)  # half'), committed), 'partial', { subset: summary({ command: TEST_COMMAND, passing: [GCD_OTHER_TEST, GCD_TEST], failing: [TWO] }) });
          holdBestPartial(mem, [o], goal);
          // verdicts the runner recorded for this goal: one `unchanged` (judged under the failure the commit removes), one regression
          mem.tried.add('aaaaaaaaaaa1').add('bbbbbbbbbbb2');
          mem.unchangedTried = new Map([[goal.id, new Set(['aaaaaaaaaaa1'])]]);
          return budget()(goal);
        },
      ],
    });
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(p.action.kind).toBe('patch');
    if (p.action.kind === 'patch') expect(p.action.diff).toContain('# half');
    // the goal's `unchanged` verdicts left `tried` (re-enumerable on the new workspace); the regression stays tried
    const memAfter = runMemory(ctx.runId);
    expect(memAfter.tried.has('aaaaaaaaaaa1')).toBe(false);
    expect(memAfter.tried.has('bbbbbbbbbbb2')).toBe(true);
    expect(memAfter.unchangedTried?.has('g1')).toBe(false);
    // the proposal text and the evidence both say partial: newlyPassing = its tests, goalTests = the goal's
    expect(p.goal).toBe(`apply partial fix: 1 of 2 goal tests pass (${GCD_TEST}, +1 more) (1→2 of 3), no regressions; the remaining 1 stay open; mutation/relational_swap at gcd.py:5`);
    expect(p.evidence).toMatchObject({ kind: 'shadow_test_run', newlyPassing: [GCD_TEST], newlyFailing: [], goalTests: [GCD_TEST, TWO], before: { passed: 1, total: 3 }, after: { passed: 2, total: 3 } });
    expect(p.plan.openProblems).toContain('partial fix: 1 of 2 goal tests pass, no regressions; the remaining 1 stay open (relational_swap at gcd.py:5)');
    expect(p.plan.remaining).toEqual([`fix ${GCD_TEST}, +1 more in gcd.py`, VERIFY_ITEM]);
    expect(JSON.parse(p.rawText)).toMatchObject({ outcome: 'partial', note: 'partial' });
    // the regression run was made through the controller's dep; the goal is open, one link of the chain
    expect(h.calls).toContain('regressionRun');
    const mem = runMemory(ctx.runId);
    const g = mem.goals[0];
    if (g === undefined) throw new Error('no goal');
    expect(g).toMatchObject({ status: 'open', progressCommits: 1, attempts: 0, tests: [GCD_TEST, TWO], phase: 'SEEDS' });
    expect(improvedBase(mem)).toBeUndefined();
    expect(ledgerOf(ctx)).toEqual(['fixed 0, open 1, parked 0']);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /g1: partial fix committed \(progress commit 1 of 3; 1 of 2 goal tests pass, the remaining 1 stay open\); the goal stays open and is re-clustered from the next baseline; 1 unchanged verdict taken under the old failure forgotten \(re-enumerable\)/.test(e.detail))).toBe(true);
  });

  it('a `budget` result with a held partial AND an untested pair: the pair comes first — the goal stays open, nothing is committed this step', async () => {
    const h = harness({
      baselines: [framedBaseline([GCD_TEST, TWO], [GCD_OTHER_TEST])],
      results: [
        (goal, mem) => {
          const committed = mem.bases.find((b) => b.origin === 'committed');
          if (committed === undefined) throw new Error('no committed base');
          const h1 = outcomeOf(jobOf(cand(siteAt(FILE, 5), 'return gcd(b, a % b)  # half 1'), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, GCD_TEST], failing: [TWO] }) });
          const h2 = outcomeOf(jobOf(cand(siteAt(FILE, 6, 'insert'), 'return a  # half 2', { source: 'template' }), committed), 'partial', { subset: summary({ passing: [GCD_OTHER_TEST, TWO], failing: [GCD_TEST] }) });
          holdBestPartial(mem, [h1, h2], goal);
          return budget()(goal);
        },
      ],
    });
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(p.action.kind).toBe('run');
    expect(h.calls).not.toContain('regressionRun');
    const mem = runMemory(ctx.runId);
    expect(mem.goals[0]).toMatchObject({ status: 'open', budgetHits: 0 });
    expect(mem.goals[0]?.progressCommits ?? 0).toBe(0);
    expect(freshPairsOfPartials(mem, mem.goals[0]!)).toHaveLength(1);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'progress' && /waits: untested pairs of complementary partials run first/.test(e.detail))).toBe(true);
  });

  it('after a partial commit the goal keeps its remaining tests OPEN and the next baseline re-clusters them by their new frame (ladder `masked`: report → parse/aggregate); nothing is marked fixed', async () => {
    const A = 'tests/test_gcd.py::test_a';
    const B = 'tests/test_gcd.py::test_b';
    const C = 'tests/test_gcd.py::test_c';
    const other = sourceFile('other.py', 'def f(x):\n    return x + 1\n');
    const before = framedBaseline([A, B, C], [GCD_OTHER_TEST]).output;
    // the same tests now fail for a new reason at two new frames
    const after = `============================= FAILURES =============================\n${section('test_b', 'gcd.py:2: in helper\n    return a')}${section('test_c', 'other.py:2: in f\n    return x + 1')}2 failed, 2 passed in 0.10s\n`;
    const afterSummary = summary({ command: TEST_COMMAND, failing: [B, C], passing: [GCD_OTHER_TEST, A] });
    const h = harness({
      files: [FILE, other],
      baselines: [
        { summary: summary({ command: TEST_COMMAND, failing: [A, B, C], passing: [GCD_OTHER_TEST] }), output: before },
        { summary: afterSummary, output: after },
      ],
      results: [(goal) => ({ kind: 'commit', applied: applyCandidate(cand(siteAt(FILE, 5), FIX_TEXT)), allGoalTestsPass: false, note: 'partial', after: afterSummary, trace: makeTrace({ goalId: goal.id, outcome: 'partial' }) })],
    });
    const runId = 'ctl-recluster';
    const first = ctxFor({ runId, step: 1 });
    const p1 = await h.synth.synthesize(first);
    expect(p1.action.kind).toBe('patch');
    expect(p1.goal).toMatch(/^apply partial fix: 1 of 3 goal tests pass .* the remaining 2 stay open; /);
    const mem = runMemory(runId);
    expect(mem.goals.map((g) => [g.id, g.status, g.tests])).toEqual([['g1', 'open', [A, B, C]]]);
    expect(mem.goals[0]?.progressCommits).toBe(1);

    // the patch executed: the next step re-baselines; B and C fail at two new frames → two OPEN goals, g1 keeps its id for one, none is fixed
    const second = ctxFor({ runId, step: 2, window: [executedPatch(1)] });
    const p2 = await h.synth.synthesize(second);
    expect(p2.action.kind).toBe('run'); // the post-patch verification run, claiming nothing (no goal is fixed)
    expect(p2.plan.done).toEqual([]);
    const shape = mem.goals.map((g) => `${g.id}:${g.status}:${g.tests.join('+')}:${g.suspectedFiles.join('+')}`).sort();
    expect(shape).toEqual([`g1:open:${B}:gcd.py`, `g2:open:${C}:other.py`]);
    expect(mem.goals.find((g) => g.id === 'g1')?.progressCommits).toBe(1);
    expect(mem.goals.find((g) => g.id === 'g2')?.progressCommits ?? 0).toBe(0);
    expect(ledgerOf(second)).toEqual(['fixed 0, open 2, parked 0']);
    expect(p2.plan.remaining).toEqual([`fix ${B} in gcd.py`, `fix ${C} in other.py`, VERIFY_ITEM]);
  });

  it('a `gather_context` directive never yields a `read`: the open goal is re-localised (sites dropped, source order rotated) and the step proceeds to the search', async () => {
    const h = harness({ handleDirective: (ctx, mem) => handleDirective(ctx, mem), results: [budget(), (goal) => fixFor(goal, FILE)] });
    const runId = 'ctl-gather';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const mem = runMemory(runId);
    expect(mem.goals[0]?.status).toBe('open');
    mem.localizeCache.set('g1', { files: [], functions: [], sites: [], requests: 0 });
    const ctx = ctxFor({ runId, step: 2, intent: 'investigate', directive: directiveText('gather_context', 'chosen', 0.71, 0.08, 'run:abc123def456:0123456789ab') });
    const p = await h.synth.synthesize(ctx);
    expect(p.action.kind).toBe('patch');
    expect(mem.overrides.sourceRotation).toEqual({ g1: 1 });
    expect(mem.localizeCache.has('g1')).toBe(false);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'directive' && /^gather_context: rotated source order of g1 \(1\); sites of g1 dropped; file beam 5 → 10; re-localise g1 with the latest failure text$/.test(e.detail))).toBe(true);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'read')).toBe(false);
  });
});

describe('unstable outcomes (jev-only-rungs-1-2.md §23.1): the trace count reaches the `search` transcript line and the step record', () => {
  it('a budget-hit step whose trace counted unstable passers says `unstable N` in the search event and in the run\'s rawText trace; without the count nothing is printed', async () => {
    const h = harness({ results: [(goal) => ({ kind: 'budget', trace: makeTrace({ goalId: goal.id, outcome: 'budget', plausible: 0, unstable: 2 }) })] });
    const ctx = ctxFor({ step: 1 });
    const p = await h.synth.synthesize(ctx);
    expect(p.action.kind).toBe('run');
    const search = ctx.events.filter((e) => e.type === 'synth' && e.phase === 'search').map((e) => (e.type === 'synth' ? e.detail : ''));
    expect(search).toEqual([expect.stringContaining('plausible 0, unstable 2)')]);
    expect(JSON.parse(p.rawText) as { trace?: { unstable?: number } }).toMatchObject({ kind: 'run', trace: { unstable: 2 } });
    const h2 = harness({ results: [budget()] });
    const ctx2 = ctxFor({ step: 1 });
    const q = await h2.synth.synthesize(ctx2);
    const search2 = ctx2.events.filter((e) => e.type === 'synth' && e.phase === 'search').map((e) => (e.type === 'synth' ? e.detail : ''));
    expect(search2[0]).toMatch(/plausible 1\)$/); // makeTrace's default count, no unstable tail
    expect(search2[0]).not.toContain('unstable');
    expect('unstable' in ((JSON.parse(q.rawText) as { trace: Record<string, unknown> }).trace)).toBe(false);
  });
});
