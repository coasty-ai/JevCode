/**
 * The controller's llm-jev switches (docs/LLM-JEV-DESIGN.md §3 row 4a, §6.5, §6.6, §9.4): no establishing
 * run before the first patch, the completion facts on the claiming run, the lane run adopted as the
 * baseline when the workspace reads as the lane, the revert route when the engine's run disagrees with the
 * lane (executed → the commit leaves the ledger; blocked → re-proposed once, then abandoned), and
 * `synthesizerHandles`. The scripted deps mirror controller.test.ts; the LLM source is the fake (the
 * controller only meters, persists and cleans it up here).
 */
import { describe, expect, it } from 'vitest';

import type { Proposal, WindowEntry } from '../../../../src/core/types.js';
import { synthesizerHandles } from '../../../../src/synth/index.js';
import { ESTABLISH_GOAL, LedgerSieveSynthesizer, runMemory } from '../../../../src/synth/search/index.js';
import { dropMemory } from '../../../../src/synth/search/memory.js';
import type { BaselineRun, RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import type { SubGoalResult } from '../../../../src/synth/search/subgoal.js';
import type { Goal } from '../../../../src/synth/search/types.js';
import type { SourceFile } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedPatch, executedRun, fakeCtx, fakeLlm, jobOf, outcomeOf, siteAt, sourceFile, summary, unusedRepositoryDeps } from './controller-fakes.js';
import { makeTrace } from './proposal-helpers.js';

const FIX_TEXT = 'return gcd(b, a % b)';
const DETECTED_COMMAND = 'pytest -q';
const TEST_COMMAND = 'python3 -m pytest -q';

function failingBaseline(): BaselineRun {
  return { summary: summary({ command: TEST_COMMAND, failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }), output: '' };
}
function greenBaseline(): BaselineRun {
  return { summary: summary({ command: TEST_COMMAND, failing: [], passing: [GCD_OTHER_TEST, GCD_TEST] }), output: '' };
}

const buggy = sourceFile('gcd.py', GCD_BUGGY);
const fixApplied = applyCandidate(cand(siteAt(buggy, 5), FIX_TEXT, { source: 'llm', op: 'sample_0_0' }));
const patched = sourceFile('gcd.py', fixApplied.files[0]!.after);

/** The search's commit of the LLM fix, with its shadow outcome (a green lane run) when `withOutcome`. */
function fixFor(withOutcome: boolean): (goal: Goal, mem: RunMemory) => SubGoalResult {
  return (goal, mem) => {
    const base = mem.bases.find((b) => b.origin === 'committed')!;
    const r: SubGoalResult = { kind: 'commit', applied: fixApplied, allGoalTestsPass: true, trace: makeTrace({ goalId: goal.id, outcome: 'fixed', winner: fixApplied }) };
    if (withOutcome) {
      const green = summary({ command: TEST_COMMAND, failing: [], passing: [GCD_OTHER_TEST, GCD_TEST] });
      r.outcome = outcomeOf(jobOf(fixApplied.candidate, base), 'plausible', { subset: green, full: green });
    }
    return r;
  };
}

function parked(goal: Goal): SubGoalResult {
  return { kind: 'parked', reason: 'exhausted mutation, template, donor at 1 site', trace: makeTrace({ goalId: goal.id, outcome: 'exhausted' }) };
}

interface HarnessOptions {
  llmJev?: boolean;
  baselines?: BaselineRun[];
  results?: ((goal: Goal, mem: RunMemory) => SubGoalResult)[];
  /** the workspace files per loadFiles call (the last entry repeats) */
  files?: SourceFile[][];
}

function harness(o: HarnessOptions = {}): { synth: LedgerSieveSynthesizer; calls: string[]; llm: ReturnType<typeof fakeLlm> } {
  const calls: string[] = [];
  const baselines = [...(o.baselines ?? [failingBaseline()])];
  const results = [...(o.results ?? [fixFor(false)])];
  const loads = [...(o.files ?? [[buggy]])];
  const llm = fakeLlm({ rounds: () => null });
  const deps: SearchDeps = {
    ...unusedRepositoryDeps(),
    loadFiles: async () => {
      calls.push('loadFiles');
      const next = loads.length > 1 ? loads.shift()! : loads[0]!;
      return new Map(next.map((f) => [f.path, f]));
    },
    runTests: async (_ctx, command) => {
      calls.push(`runTests:${command}`);
      const next = baselines.length > 1 ? baselines.shift() : baselines[0];
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
    searchSubGoal: async (_ctx, mem, goal) => {
      calls.push(`searchSubGoal:${goal.id}`);
      const next = results.length > 1 ? results.shift() : results[0];
      if (next === undefined) throw new Error('searchSubGoal is not scripted');
      return next(goal, mem);
    },
    regressionRun: async (_ctx, _mem, _goal, outcome) => outcome.subset,
    llm,
    now: () => 1_000,
  };
  return { synth: new LedgerSieveSynthesizer(deps, { llmJev: o.llmJev ?? true }), calls, llm };
}

let runCounter = 0;
function ctxFor(o: Parameters<typeof fakeCtx>[0] = {}): ReturnType<typeof fakeCtx> {
  return fakeCtx({ runId: o.runId ?? `llm-ctl-${runCounter++}`, testCommand: { command: DETECTED_COMMAND, runner: 'pytest' }, files: ['gcd.py', 'tests/test_gcd.py'], ...o });
}

function blocked(e: WindowEntry): WindowEntry {
  return { ...e, outcome: 'blocked', reason: 'reviewer declined' };
}

function isRevert(p: Proposal): boolean {
  return p.action.kind === 'patch' && /^revert\b/.test(p.goal);
}

describe('llm-jev: no establishing run, the claiming run\'s completion facts, lane adoption', () => {
  it('the first proposal is the verified patch, not the establishing run (jev-only still proposes the run)', async () => {
    const h = harness();
    const p = await h.synth.synthesize(ctxFor({ step: 1 }));
    expect(p.action.kind).toBe('patch');
    expect(p.goal).not.toContain(ESTABLISH_GOAL);
    expect(h.calls).toEqual(['loadFiles', `runTests:${TEST_COMMAND}`, 'searchSubGoal:g1']);
    // the LLM round cache and the step-end cleanup ran through the controller
    const j = harness({ llmJev: false });
    const run = await j.synth.synthesize(ctxFor({ step: 1 }));
    expect(run.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(run.goal).toContain(ESTABLISH_GOAL);
  });

  it('the step after an executed patch is the claiming run carrying `evidence.completion`, and its evidence selection is `llm`', async () => {
    const h = harness({ baselines: [failingBaseline(), greenBaseline()] });
    const runId = 'llm-ctl-claiming';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const p = await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p.plan.done).toEqual([`fix ${GCD_TEST} in gcd.py`]);
    expect(p.evidence).toMatchObject({ kind: 'shadow_test_run', selection: 'llm', newlyPassing: [GCD_TEST], newlyFailing: [] });
    expect(p.evidence?.completion).toEqual({ ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: TEST_COMMAND });
    // jev-only carries no completion block
    const j = harness({ llmJev: false, baselines: [failingBaseline(), greenBaseline()] });
    const jid = 'llm-ctl-claiming-jev-only';
    await j.synth.synthesize(ctxFor({ runId: jid, step: 1, window: [executedRun(0, TEST_COMMAND, { passed: 1, failed: 1 })] }));
    const pj = await j.synth.synthesize(ctxFor({ runId: jid, step: 2, window: [executedPatch(1)] }));
    expect(pj.action.kind).toBe('run');
    expect(pj.evidence?.completion).toBeUndefined();
  });

  it('after a commit whose lane run was green, a workspace that reads as the lane\'s post-image adopts that run as the baseline without a re-run', async () => {
    const h = harness({ baselines: [failingBaseline(), greenBaseline()], results: [fixFor(true)], files: [[buggy], [patched]] });
    const runId = 'llm-ctl-adopt';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const ctx = ctxFor({ runId, step: 2, window: [executedPatch(1)] });
    const p = await h.synth.synthesize(ctx);
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(h.calls.filter((c) => c.startsWith('runTests'))).toHaveLength(1);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'baseline' && e.detail.includes('adopted'))).toBe(true);
    expect(runMemory(runId).baseline?.passed).toBe(2);
    // a workspace that does not read as the lane (the buggy file again) re-runs the suite
    const g = harness({ baselines: [failingBaseline(), greenBaseline()], results: [fixFor(true)] });
    const gid = 'llm-ctl-no-adopt';
    await g.synth.synthesize(ctxFor({ runId: gid, step: 1 }));
    await g.synth.synthesize(ctxFor({ runId: gid, step: 2, window: [executedPatch(1)] }));
    expect(g.calls.filter((c) => c.startsWith('runTests'))).toHaveLength(2);
  });

  it('lane adoption compares the whole loaded tree (§6.4): an untouched file that changed between the patch and the claiming run re-runs the suite; the same tree adopts', async () => {
    const other = sourceFile('util.py', 'def helper():\n    return 1\n');
    const edited = sourceFile('util.py', 'def helper():\n    return 2\n');
    const h = harness({ baselines: [failingBaseline(), greenBaseline()], results: [fixFor(true)], files: [[buggy, other], [patched, edited]] });
    const runId = 'llm-ctl-tree';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    const ctx = ctxFor({ runId, step: 2, window: [executedPatch(1)] });
    await h.synth.synthesize(ctx);
    expect(h.calls.filter((c) => c.startsWith('runTests'))).toHaveLength(2);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'baseline' && e.detail.includes('adopted'))).toBe(false);
    const g = harness({ baselines: [failingBaseline(), greenBaseline()], results: [fixFor(true)], files: [[buggy, other], [patched, other]] });
    const gid = 'llm-ctl-tree-same';
    await g.synth.synthesize(ctxFor({ runId: gid, step: 1 }));
    await g.synth.synthesize(ctxFor({ runId: gid, step: 2, window: [executedPatch(1)] }));
    expect(g.calls.filter((c) => c.startsWith('runTests'))).toHaveLength(1);
  });

  it('after a resume (a fresh process: no commit record, no previous baseline) the claiming run still carries the completion facts (§6.6)', async () => {
    const runId = 'llm-ctl-resume';
    const h = harness({ baselines: [failingBaseline()] });
    const first = ctxFor({ runId, step: 1 });
    await h.synth.synthesize(first);
    const persisted = first.synthStates.at(-1) ?? null;
    // the process restarts: the run memory is gone and a new synthesizer holds no scratch for the run
    expect(dropMemory(runId)).toBe(true);
    const resumed = harness({ baselines: [greenBaseline()] });
    const ctx = ctxFor({ runId, step: 2, window: [executedPatch(1)], synthState: persisted });
    const p = await resumed.synth.synthesize(ctx);
    expect(p.action).toMatchObject({ kind: 'run', command: TEST_COMMAND });
    expect(p.evidence?.completion).toMatchObject({ testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: TEST_COMMAND });
    // no earlier baseline in this process: the evidence compares the fresh baseline with itself
    expect(p.evidence?.before).toEqual(p.evidence?.after);
    expect(p.evidence).toMatchObject({ newlyPassing: [], newlyFailing: [] });
  });
});

describe('llm-jev: the revert route (§6.5)', () => {
  it('the engine\'s claiming run passing fewer tests than before the patch reverts the last commit: reverse diff, goal open, the candidate stays tried; once executed the commit leaves the ledger', async () => {
    const h = harness({ baselines: [failingBaseline(), greenBaseline(), failingBaseline()], results: [fixFor(false), parked] });
    const runId = 'llm-ctl-revert';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    const mem = runMemory(runId);
    expect(mem.committed).toHaveLength(1);
    const hash = mem.committedDiffHashes[0]!;
    // the engine ran the suite on the patched workspace: 0 passed against 1 before the patch
    const ctx = ctxFor({ runId, step: 3, window: [executedPatch(1), executedRun(2, TEST_COMMAND, { passed: 0, failed: 2 })] });
    const p = await h.synth.synthesize(ctx);
    expect(isRevert(p)).toBe(true);
    if (p.action.kind === 'patch') {
      expect(p.action.diff).toContain('-        return gcd(b, a % b)');
      expect(p.action.diff).toContain('+        return gcd(a % b, b)');
    }
    expect(p.plan.openProblems.some((n) => n.includes('workspace_disagreed'))).toBe(true);
    expect(mem.goals[0]?.status).toBe('open');
    expect(mem.tried.has(hash)).toBe(true);
    expect(mem.committed).toHaveLength(1);
    expect(ctx.events.some((e) => e.type === 'synth' && e.phase === 'revert')).toBe(true);
    // no search ran on the revert step
    expect(h.calls.filter((c) => c.startsWith('searchSubGoal'))).toHaveLength(1);
    // the revert executed: the commit leaves the ledger, the workspace is re-baselined and searched again at once (no claiming run after a revert)
    const after = ctxFor({ runId, step: 4, window: [executedRun(2, TEST_COMMAND, { passed: 0, failed: 2 }), executedPatch(3)] });
    const next = await h.synth.synthesize(after);
    expect(mem.committed).toHaveLength(0);
    expect(mem.committedDiffHashes).toEqual([]);
    expect(isRevert(next)).toBe(false);
    expect(next.action.kind).not.toBe('patch');
    expect(h.calls.filter((c) => c.startsWith('runTests'))).toHaveLength(3);
    expect(h.calls.filter((c) => c.startsWith('searchSubGoal'))).toHaveLength(2);
    // never a second revert of the same commit
    expect(ctx.events.filter((e) => e.type === 'synth' && e.phase === 'revert')).toHaveLength(1);
  });

  it('a blocked revert is re-proposed once, then abandoned with the commit in place', async () => {
    const h = harness({ baselines: [failingBaseline(), greenBaseline()], results: [fixFor(false), parked] });
    const runId = 'llm-ctl-revert-blocked';
    await h.synth.synthesize(ctxFor({ runId, step: 1 }));
    await h.synth.synthesize(ctxFor({ runId, step: 2, window: [executedPatch(1)] }));
    const first = await h.synth.synthesize(ctxFor({ runId, step: 3, window: [executedPatch(1), executedRun(2, TEST_COMMAND, { passed: 0, failed: 2 })] }));
    expect(isRevert(first)).toBe(true);
    const mem = runMemory(runId);
    const again = await h.synth.synthesize(ctxFor({ runId, step: 4, window: [executedRun(2, TEST_COMMAND, { passed: 0, failed: 2 }), blocked(executedPatch(3))] }));
    expect(isRevert(again)).toBe(true);
    expect(mem.committed).toHaveLength(1);
    const abandoned = await h.synth.synthesize(ctxFor({ runId, step: 5, window: [blocked(executedPatch(3)), blocked(executedPatch(4))] }));
    expect(isRevert(abandoned)).toBe(false);
    expect(mem.committed).toHaveLength(1);
  });
});

describe('synthesizerHandles (§9.4)', () => {
  it('true for Python workspaces with a QuixBugs/pytest layout or a repository, false otherwise', () => {
    const pytest = { testCommand: { command: 'pytest -q', runner: 'pytest' as const } };
    expect(synthesizerHandles(pytest, ['gcd.py', 'tests/test_gcd.py'])).toBe(true);
    expect(synthesizerHandles(pytest, ['src/a.py', 'src/b.py', 'tests/test_a.py'])).toBe(true);
    expect(synthesizerHandles({ testCommand: null }, ['a.py'])).toBe(false);
    // a QuixBugs layout whose runner the workspace did not detect is the generic fallback's (§9.4: "detected runner")
    expect(synthesizerHandles({ testCommand: null }, ['gcd.py', 'tests/test_gcd.py'])).toBe(false);
    expect(synthesizerHandles(pytest, ['index.ts', 'test/index.test.ts'])).toBe(false);
    expect(synthesizerHandles({ testCommand: { command: 'python runtests.py', runner: 'django' } }, ['django/db/models.py'])).toBe(true);
  });
});
