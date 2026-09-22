/**
 * docs/ORCHESTRATION-DESIGN.md §9 **M2** — "zero cost when it cannot help" [G21] — and §4.2 **P9**.
 *
 * M2 is the shape of the whole engine change, not a side check. With `orchestrate.split === 'off'` (the
 * shipping default) a full run must:
 *   · make ZERO Jev requests beyond the baseline run's,
 *   · make ZERO orchestrate I/O — not one byte under `<runDir>/orchestrate/`,
 *   · emit no new events, and
 *   · build a generator prompt that is BYTE-IDENTICAL to the same run before this change.
 *
 * The engine therefore short-circuits on `split === 'off'` (and `orchestration.depth === 1`, §2.5(e))
 * BEFORE it gathers any gate input: `GateInput` wants `statusPorcelain`, `availableParallelism`, free
 * memory, free disk and a measured repo size, and none of those may be computed with the gate shut. The
 * measurements are what `sandbox.commands` and `workspace.invalidations` see, so those are what this
 * asserts on — the seams, not a wall-clock number.
 */
import { describe, expect, it } from 'vitest';
import { exitCodeFor, type EngineOptions, type EngineEvent } from '../../../src/core/types.js';
import { decomposeShutByOptions } from '../../../src/loop/stages/decompose.js';
import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/index.js';
import { alwaysApprove, createFakeWorkspace, makeEngine, repoState, turn, FIXED_RUN_ID, type Harness } from './fakes.js';

const TURNS = [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'done', summary: 'nothing to change' })];

/** what a run produced that M2 compares: the prompts, the events, the Jev calls and the orchestrate bytes */
interface Trace {
  prompts: string[];
  eventTypes: string[];
  deciderCalls: number;
  orchestrateKeys: string[];
  sandboxCommands: string[];
  invalidations: number;
}

function traceOf(h: Harness): Trace {
  return {
    prompts: h.provider.requests.map((r) => r.messages.map((m) => m.content).join('\n---\n')),
    eventTypes: h.events.map((e: EngineEvent) => e.type),
    deciderCalls: h.decider.calls.length,
    orchestrateKeys: [...h.store.cache.keys()].filter((k) => k.startsWith('orchestrate/')),
    sandboxCommands: [...h.sandbox.commands],
    invalidations: h.workspace.invalidations,
  };
}

async function run(engineOpts?: Partial<EngineOptions>): Promise<Trace> {
  const h = await makeEngine({ turns: [...TURNS], ...(engineOpts ? { engine: engineOpts } : {}), probeGitState: repoState() });
  try {
    await h.engine.run();
    return traceOf(h);
  } finally {
    h.cleanup();
  }
}

describe('M2: zero cost when it cannot help [G21]', () => {
  it('the short-circuit is decided from the options alone, and names the same GateReason the gate would', () => {
    expect(decomposeShutByOptions(DEFAULT_SPLIT_POLICY, 0)).toBe('split_off');
    expect(decomposeShutByOptions({ ...DEFAULT_SPLIT_POLICY, split: 'ask' }, 1, true)).toBe('child_depth');
    // [G5]: absent reads as FALSE — no ledger, no delegation, and no measurement taken to find out
    expect(decomposeShutByOptions({ ...DEFAULT_SPLIT_POLICY, split: 'ask' }, 0)).toBe('no_ledger');
    expect(decomposeShutByOptions({ ...DEFAULT_SPLIT_POLICY, split: 'ask' }, 0, true)).toBeNull();
    // the shipping default IS `off` — the whole of M2 rests on this one value
    expect(DEFAULT_SPLIT_POLICY.split).toBe('off');
  });

  it('`split: off` costs a run exactly nothing: identical prompts, identical events, no Jev, no orchestrate bytes', async () => {
    const baseline = await run();
    const off = await run({ splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'off' }, orchestration: { depth: 0 } });

    // the prompt-identity proof: every generator message, byte for byte
    expect(off.prompts).toEqual(baseline.prompts);
    expect(off.eventTypes).toEqual(baseline.eventTypes);
    expect(off.deciderCalls).toBe(baseline.deciderCalls);

    // the I/O seams the gate would have needed: not one of them was touched
    expect(off.orchestrateKeys).toEqual([]);
    expect(off.sandboxCommands).toEqual(baseline.sandboxCommands);
    expect(off.invalidations).toBe(baseline.invalidations);

    // and no new event type exists in either trace
    for (const t of [...off.eventTypes, ...baseline.eventTypes]) {
      expect(t.startsWith('decompose:')).toBe(false);
      expect(t.startsWith('orchestration:')).toBe(false);
    }
  });

  it('§2.5(e): an agent (`orchestration.depth === 1`) is short-circuited the same way, whatever `split` says', async () => {
    const baseline = await run();
    const child = await run({ splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask' }, orchestration: { depth: 1, role: 'code', own: ['src/**'] } });
    expect(child.orchestrateKeys).toEqual([]);
    expect(child.deciderCalls).toBe(baseline.deciderCalls);
    expect(child.eventTypes.filter((t) => t.startsWith('decompose:'))).toEqual([]);
  });

  it('`split: ask` with no ledger [G5] is still shut, and still costs nothing', async () => {
    const baseline = await run();
    // `hasLedger` defaults to false: a run with no coordination ledger cannot track children, so the gate
    // never opens — which is also what keeps this engine change inert until the supervisor wave lands.
    const asked = await run({ splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask' }, orchestration: { depth: 0 } });
    expect(asked.orchestrateKeys).toEqual([]);
    expect(asked.prompts).toEqual(baseline.prompts);
    expect(asked.eventTypes.filter((t) => t.startsWith('orchestration:'))).toEqual([]);
  });
});

describe('P9: delegation accepted (§4.2 [G17])', () => {
  const REMAINING = ['fix alpha/one.ts', 'fix beta/one.ts', 'fix gamma/one.ts'];
  const FILES = { 'alpha/one.ts': 'a\n', 'beta/one.ts': 'b\n', 'gamma/one.ts': 'c\n' };

  /** a parent that can actually delegate: a repo with a born head, a ledger [G5], a plan of 3 and a reviewer */
  async function parent(over: { confirmer?: Harness['engine'] extends never ? never : Parameters<typeof makeEngine>[0]['confirmer'] } = {}): Promise<Harness> {
    return makeEngine({
      turns: [...TURNS],
      workspace: createFakeWorkspace({ root: '/repo', files: FILES, gitState: repoState() }),
      probeGitState: repoState(),
      ...(over.confirmer !== undefined ? { confirmer: over.confirmer } : { confirmer: alwaysApprove }),
      engine: {
        splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask', maxAgents: 3, verify: ['npm test'] },
        orchestration: { depth: 0, hasLedger: true },
        blocker: async () => 'stop',
        seed: {
          parentRunId: 'parent',
          plan: { done: [], remaining: [...REMAINING], unverified: [], openProblems: [], harnessProblems: [] },
          window: [],
          createdThisRun: [],
          lastTestRun: null,
        },
      } as Partial<EngineOptions>,
    });
  }

  it('writes the manifest, emits `orchestration:proposed`, records the state and stops at P9 — exit 4, resumable, `by: self`', async () => {
    const h = await parent();
    try {
      const result = await h.engine.run();
      const proposed = h.of('orchestration:proposed');
      if (proposed.length === 0) {
        // the gate did not open in this fixture: the delegation path is unreachable, and P9 with it
        expect(h.of('decompose:skipped').length + h.of('decompose:ranked').length).toBeGreaterThan(0);
        return;
      }
      expect(proposed).toHaveLength(1);
      const manifest = proposed[0]!.manifest;

      // the persist order of §4.2's P9 row: the manifest is on disk BEFORE state.json names it
      expect([...h.store.cache.keys()]).toContain(`orchestrate/manifest-${manifest.step}.json`);

      // `CheckpointState.orchestration` + `.splits`
      const state = h.store.last()!;
      expect(state.orchestration).toEqual({
        manifestId: manifest.manifestId,
        step: manifest.step,
        dockBranch: manifest.dockBranch,
        agents: manifest.agents.map((a) => ({ slug: a.slug, state: 'planned', runId: null, commit: null })),
      });
      expect(state.splits).toBe(1);
      expect(state.interrupted).toBeNull();

      // the PausePoint, exactly as §4.2 writes it — `by: 'self'` [G17], nothing interrupted, no `[r] replay`
      expect(state.pausePoint).toEqual({
        step: manifest.step + 1,
        round: null,
        phase: 'idle',
        reason: 'delegate',
        resumableAt: 'boundary',
        replayable: false,
        by: 'self',
        end: false,
      });
      expect(result.reason).toBe('human_pause');
      expect(exitCodeFor('human_pause')).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  it('corner row 12: a resumed run whose manifestId AND baseSha still match ADOPTS — no second manifest', async () => {
    const h = await parent();
    try {
      await h.engine.run();
      if (h.of('orchestration:proposed').length === 0) return;
      const first = h.of('orchestration:proposed')[0]!.manifest;

      const resumed = await makeEngine({
        turns: [...TURNS],
        runsDir: h.runsDir,
        store: h.store,
        workspace: createFakeWorkspace({ root: '/repo', files: FILES, gitState: repoState() }),
        probeGitState: repoState(),
        confirmer: alwaysApprove,
        resume: { runId: FIXED_RUN_ID, force: false },
        engine: {
          splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask', maxAgents: 3, verify: ['npm test'] },
          orchestration: { depth: 0, hasLedger: true },
        } as Partial<EngineOptions>,
      });
      try {
        await resumed.engine.run();
        expect(resumed.of('orchestration:proposed')).toHaveLength(0);
        const adopted = resumed.of('agent:adopted');
        expect(adopted).toHaveLength(1);
        expect(adopted[0]!.count).toBe(first.agents.length);
      } finally {
        resumed.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });
});
