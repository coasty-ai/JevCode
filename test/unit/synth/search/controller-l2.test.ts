/**
 * The controller's wiring of the L2 reproduction writer and of the step budget it re-installs at the repository
 * re-baseline (docs/LLM-JEV-DESIGN.md §4.10, §4.11, §7.1): the writer runs the scripts in scratch copies under the run's
 * own directory — told whether the workspace is a git checkout instead of probing `.git` in the sandbox — and the budget
 * carried across the re-baseline keeps the early round's hold visible to the loop without debiting it (the source charges
 * the price at settle; a debit here would charge the samples twice). `writeReproduction` itself is scripted: repro.ts has
 * its own tests.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReproWriterInput, ReproWriterResult } from '../../../../src/synth/llm/repro.js';
import { llmHoldOf, llmRoundAffordable } from '../../../../src/synth/search/budget.js';
import { LLM_REPRO_SCRATCH_DIR, LedgerSieveSynthesizer, runMemory } from '../../../../src/synth/search/index.js';
import type { BaselineRun, SearchDeps } from '../../../../src/synth/search/index.js';
import { fakeCtx, fakeLlm, siteAt, sourceFile, summary, unusedRepositoryDeps } from './controller-fakes.js';
import { makeTrace } from './proposal-helpers.js';

const l2 = vi.hoisted(() => ({ inputs: [] as ReproWriterInput[] }));

vi.mock('../../../../src/synth/llm/repro.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/synth/llm/repro.js')>();
  const writeReproduction = async (input: ReproWriterInput): Promise<ReproWriterResult> => {
    l2.inputs.push(input);
    return { outcome: 'llm_none', goal: null, pick: null, trials: [], requests: 0, note: 'scripted: no script survived', durationMs: 0, usd: 0, estimatedUsd: 0 };
  };
  return { ...actual, writeReproduction };
});

const MODULE = 'django/db/models/fields/__init__.py';
const DETECTED = { command: 'python tests/runtests.py --parallel 1', runner: 'django' as const };
const SCOPED = 'python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite model_fields.tests';
const TASK = 'Model Field.__hash__() should be immutable. It changes when the field is assigned to a model class.';

function scopedGreen(): BaselineRun {
  return { summary: summary({ command: SCOPED, passing: ['test_a (model_fields.tests.BasicFieldTests)', 'test_b (model_fields.tests.BasicFieldTests)'], failing: [], durationMs: 4000 }), output: '' };
}

/**
 * A Django-shaped establishing step with no valid code oracle (the issue has no code block): L2 runs and finds nothing, the
 * early round fires before the scoped baseline, and the best-guess goal follows — its search is scripted to park (llm-jev
 * proposes no establishing run, so the step reaches it at once).
 */
function harness(holdUsd: number): { synth: LedgerSieveSynthesizer; llm: ReturnType<typeof fakeLlm>; calls: string[] } {
  const file = sourceFile(MODULE, 'class Field:\n    def __hash__(self):\n        return hash((self.creation_counter, self.model._meta.app_label))\n');
  const calls: string[] = [];
  // the early repository round (fireEarlyRound, §7.1): one sample that never lands within the test, holding `holdUsd`
  const llm = fakeLlm({ rounds: (o) => (o.round === 1 ? { arrivals: [{ candidates: [], delayMs: 60_000 }], klass: 'repository', hang: true, deadlineMs: 60_000, holdUsd } : null) });
  const deps: SearchDeps = {
    ...unusedRepositoryDeps(),
    loadFiles: async () => new Map([[file.path, file]]),
    locate: async () => ({ files: [{ path: MODULE, probability: 0.9 }], functions: [], sites: [siteAt(file, 3)], requests: 4 }),
    regressionScope: async () => ({ testFiles: ['tests/model_fields/tests.py'], command: SCOPED, tier: 'stem', note: 'named after the module' }),
    runTests: async (_ctx, command) => {
      calls.push(`runTests:${command}`);
      return scopedGreen();
    },
    pickGoal: async (_ctx, mem) => {
      const g = mem.goals.find((x) => x.status === 'active') ?? mem.goals.find((x) => x.status === 'open') ?? null;
      if (g !== null) g.status = 'active';
      return { goal: g, method: g === null ? 'none' : 'single', probability: 1, requests: 0 };
    },
    handleDirective: async () => ({ kind: 'continue', move: 'change_approach', changes: [] }),
    searchSubGoal: async () => {
      throw new Error('the best-guess goal is searched by searchBestGuess, never searchSubGoal');
    },
    searchBestGuess: async (_ctx, _mem, goal) => {
      calls.push(`searchBestGuess:${goal.id}`);
      return { kind: 'parked', reason: 'scripted: no best guess', trace: makeTrace({ goalId: goal.id, outcome: 'exhausted' }) };
    },
    regressionRun: async (_ctx, _mem, _goal, outcome) => outcome.subset,
    llm,
    now: () => 1_000,
  };
  return { synth: new LedgerSieveSynthesizer(deps, { llmJev: true }), llm, calls };
}

let runCounter = 0;
function repoCtx(): ReturnType<typeof fakeCtx> {
  const base = fakeCtx({ runId: `l2-ctl-${runCounter++}`, step: 1, testCommand: DETECTED, files: [MODULE, 'django/__init__.py', 'tests/model_fields/tests.py', 'tests/runtests.py'], task: TASK });
  // a generator channel is what admits L2 (the scripted writer never calls it)
  return {
    ...base,
    generate: async () => {
      throw new Error('the L2 writer is scripted: generate is never called');
    },
  };
}

describe('llm-jev: the L2 reproduction writer runs in the run\'s scratch, told the workspace\'s git state (§4.10)', () => {
  it('writeReproduction is handed `workspaceGit` from the run-start probe and a `scratchDir` under the run directory, never the workspace', async () => {
    const h = harness(0);
    const ctx = repoCtx();
    l2.inputs.length = 0;
    await h.synth.synthesize(ctx);
    // L2 ran at the establishing step (before the scoped baseline and the best-guess search)
    expect(h.calls).toEqual([`runTests:${SCOPED}`, 'searchBestGuess:g1']);
    expect(l2.inputs).toHaveLength(1);
    const input = l2.inputs[0]!;
    expect(input.workspace).toBe(ctx.workspaceInfo.root);
    expect(input.workspaceGit).toBe(ctx.workspaceInfo.git);
    expect(input.workspaceGit).toBe(true);
    expect(input.scratchDir).toBe(`${ctx.runDir}/${LLM_REPRO_SCRATCH_DIR}`);
    expect(input.scratchDir?.startsWith(ctx.workspaceInfo.root)).toBe(false);
    // the writer is the one that charges the step's dollar counter: it is handed the live counter, and the run's ledger sees its spend
    expect(input.budget?.usdLeft).toBeCloseTo(0.02, 9);
    expect(h.llm.spent).toBe(0);
    await h.llm.rec.rounds[0]?.cancel('budget');
  });
});

describe('llm-jev: the budget re-installed at the repository re-baseline and the early round\'s hold (§4.11, §7.1)', () => {
  it('the carried counter is min(fresh, previous) — the hold is not debited from it (the source charges the price at settle) — and the loop reads the hold when it sizes the next round', async () => {
    const h = harness(0.02);
    const ctx = repoCtx();
    await h.synth.synthesize(ctx);
    const mem = runMemory(ctx.runId);
    const round = h.llm.rec.rounds[0];
    expect(round).toBeDefined();
    // the early round fired before the scoped baseline and is still in flight after the carry
    expect(h.llm.rec.fires.map((f) => f.round)).toEqual([1]);
    expect(round!.closed()).toBe(false);
    expect(round!.summary()?.reservedUsd).toBeCloseTo(0.02, 9);
    // fresh = min($0.02, $1 / 40 steps) = $0.02; previous = $0.02 untouched: the carried counter is $0.02, not $0.02 − the hold
    expect(mem.stepBudget.llmUsdLeft).toBeCloseTo(0.02, 9);
    expect(mem.stepBudget.llmRoundsLeft).toBe(2);
    // read on its own the counter would admit another round; less the hold it covers no sample
    expect(llmRoundAffordable(mem.stepBudget)).toBe(true);
    expect(llmRoundAffordable(mem.stepBudget, llmHoldOf(round!.summary()))).toBe(false);
    await round!.cancel('budget');
    // the hold is released with the round; the counter itself never moved (a debit at the carry would have left it at $0)
    expect(llmHoldOf(round!.summary())).toEqual({ reservedUsd: 0, perSampleUsd: 0 });
    expect(mem.stepBudget.llmUsdLeft).toBeCloseTo(0.02, 9);
  });
});
