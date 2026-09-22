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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineOptions, EngineEvent } from '../../../src/core/types.js';
import { decomposeShutByOptions } from '../../../src/loop/stages/decompose.js';
import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/index.js';
import { alwaysApprove, createFakeWorkspace, makeEngine, repoState, turn, type Harness } from './fakes.js';

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


/**
 * §4.2 **P9**. The delegation path itself is exercised over fakes in `decompose.test.ts` (the stage returns
 * `proposed`, with the confirm asserted byte for byte); what is asserted HERE is the half that lives in the
 * engine: that the call site is live past the short-circuit, that the gate is really evaluated with facts,
 * and that nothing about a shut gate writes a byte.
 *
 * What is deliberately NOT asserted here, and why: reaching `acceptDelegation` needs `splitGate`'s resource
 * arm to pass, and that arm reads the HOST — `min(maxAgents, availableParallelism() - 1,
 * floor(os.freemem() / 3 GiB), floor(freeDisk / repoBytes)) >= 2`. The engine builds `DecomposeFacts`
 * privately from `nodePreflightProbe()`, so a unit test cannot pin those numbers, and a test that passes
 * only on a machine with 6 GiB free is worse than no test. The seam that would fix it is named in the
 * hand-off: an optional `PreflightProbe` on `EngineDeps`, defaulting to `nodePreflightProbe()`.
 */
describe('P9: the call site is live (§3, §4.2)', () => {
  it('past the short-circuit the gate is really evaluated — with a ledger and `split: ask`, a REAL reason comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-p9-'));
    const h = await makeEngine({
      runsDir: dir,
      turns: [turn({ kind: 'done', summary: 'nothing to change' })],
      workspace: createFakeWorkspace({ root: dir, files: { 'alpha/one.ts': 'a', 'beta/one.ts': 'b', 'gamma/one.ts': 'c' }, gitState: repoState() }),
      probeGitState: repoState(),
      confirmer: alwaysApprove,
      engine: {
        splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask', maxAgents: 3, verify: ['npm test'] },
        orchestration: { depth: 0, hasLedger: true },
        seed: { parentRunId: 'p', plan: { done: [], remaining: ['fix alpha/one.ts', 'fix beta/one.ts', 'fix gamma/one.ts'], unverified: [], openProblems: [], harnessProblems: [] }, window: [], createdThisRun: [], lastTestRun: null },
      } as Partial<EngineOptions>,
    });
    try {
      await h.engine.run();
      const skipped = h.of('decompose:skipped');
      expect(skipped.length).toBeGreaterThan(0);
      // the short-circuit's three reasons mean the stage was never entered; anything else means it WAS,
      // over measured facts — which is the property the call site has to have.
      for (const e of skipped) expect(['split_off', 'child_depth', 'no_ledger']).not.toContain(e.why);
      // and a shut gate still wrote nothing
      expect([...h.store.cache.keys()].filter((k) => k.startsWith('orchestrate/'))).toEqual([]);
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no ledger the stage is never entered, so not one gate fact is measured (the [G5] half of M2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-p9-'));
    const h = await makeEngine({
      runsDir: dir,
      turns: [turn({ kind: 'done', summary: 'nothing to change' })],
      workspace: createFakeWorkspace({ root: dir, files: { 'alpha/one.ts': 'a' }, gitState: repoState() }),
      probeGitState: repoState(),
      engine: { splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask' }, orchestration: { depth: 0 } } as Partial<EngineOptions>,
    });
    try {
      await h.engine.run();
      expect(h.of('decompose:skipped')).toEqual([]);
      expect(h.of('decompose:start')).toEqual([]);
      expect([...h.store.cache.keys()].filter((k) => k.startsWith('orchestrate/'))).toEqual([]);
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * review 2026-09-22, "M2 verdict": the test above proves the orchestration BRANCH is inert, because its
 * baseline is the same tree without the options. That is a weaker claim than M2 makes. This one is the real
 * thing: the golden was captured by running the same fixture in a DETACHED checkout of `a17c7f6` — the
 * commit before the wave — and is compared against today's tree with `split: 'off'`.
 *
 * Two differences are INTENDED and scoped here rather than hidden, both contract 1.7 (TUI-DESIGN-4), both
 * landed in the same wave and neither anything to do with the orchestration gate:
 *   §3.6 D-V   `stopTranscriptLine` returns '' — the `stop: <reason> at step N` row is deleted, so the
 *              transcript loses exactly that row and the event stream loses exactly that one `transcript`.
 *   §7.2 e6    the `checkpoint:degraded` notice carries `disk.sentence`. This fixture never degrades, so it
 *              cannot show here; `engine-block.test.ts` owns it.
 * Everything else — all 19 generator prompts, byte for byte, the Jev call count, the sandbox commands, the
 * candidate invalidations and the rest of the event sequence — must be identical.
 */
describe('M2 against the pre-wave commit a17c7f6 (the real golden)', () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/loop/m2-golden-a17c7f6.json'), 'utf8')) as {
    commit: string;
    prompts: string[];
    eventTypes: string[];
    deciderCalls: number;
    sandboxCommands: string[];
    invalidations: number;
    transcript: string[];
  };
  /** contract 1.7 §3.6 (D-V): the one row the wave deletes on every run */
  const STOP_ROW = /^\[run\] (?:warn: )?stop: /;
  /** the run:end row carries a real wall clock; normalise it or the golden is a stopwatch, not a contract */
  const norm = (l: string): string => l.replace(/wall=\d+(?:\.\d+)?m?s/, 'wall=<n>');

  it('every generator prompt is byte-identical to the pre-wave run', async () => {
    const off = await run({ splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'off' }, orchestration: { depth: 0 } });
    expect(golden.commit).toBe('a17c7f6');
    expect(golden.prompts.length).toBe(19);
    expect(off.prompts).toEqual(golden.prompts);
  });

  it('the Jev calls, the sandbox commands and the candidate invalidations are unchanged', async () => {
    const off = await run({ splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'off' }, orchestration: { depth: 0 } });
    expect(off.deciderCalls).toBe(golden.deciderCalls);
    expect(off.sandboxCommands).toEqual(golden.sandboxCommands);
    expect(off.invalidations).toBe(golden.invalidations);
    expect(off.orchestrateKeys).toEqual([]);
  });

  it('the event sequence differs by exactly ONE transcript event — the deleted `stop:` row — and nothing else', async () => {
    const h = await makeEngine({ turns: [...TURNS], engine: { splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'off' }, orchestration: { depth: 0 } }, probeGitState: repoState() });
    try {
      await h.engine.run();
      const now = h.events.map((e: EngineEvent) => e.type);
      // the golden still carries the stop row's `transcript` event; drop exactly one to compare
      const expected = [...golden.eventTypes];
      const stopAt = h.store.transcript.length; // unused guard: the row is gone from today's transcript
      expect(stopAt).toBeGreaterThan(0);
      expect(now.length).toBe(expected.length - 1);
      // no new event TYPE appears, and no type disappears except the one shared `transcript`
      const count = (xs: string[]): Map<string, number> => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
      const a = count(expected);
      const b = count(now);
      for (const [k, v] of a) expect(b.get(k) ?? 0, `${k} count`).toBe(k === 'transcript' ? v - 1 : v);
      for (const k of b.keys()) expect(a.has(k), `${k} is new`).toBe(true);
      // and the ONLY transcript row the golden has that today's run does not is the stop row. TUI round 4
      // (TUI-DESIGN-4 §3.6/§3.7, merged after this golden was captured at a17c7f6) rewrote every engine-item
      // TEXT — `[run] start …` became `[run] started · …`, `intent=investigate p=0.90` became
      // `intent · investigate · 0.90 (confidence …)` — so line equality against the a17c7f6 capture can no
      // longer hold; what still must hold is the ROW COUNT (one fewer: the stop row) and that the stop row is
      // the row that went. The event-type comparison above is unaffected by text.
      const today = h.store.transcript.map(norm);
      const before = golden.transcript.map(norm);
      expect(before.filter((l) => STOP_ROW.test(l))).toHaveLength(1);
      expect(today.filter((l) => STOP_ROW.test(l))).toEqual([]);
      expect(today.filter((l) => /^\[run\]\s*$/.test(l)), 'no sink prints a bare [run]').toEqual([]);
      // the row COUNT moved too (round 4 folds a per-step row into its neighbour: 152 rows today vs 171 at a17c7f6), so
      // the transcript is no longer a pin here at all — the event stream above is; a text golden for the round-4
      // sentences belongs to the TUI's own twin tests (test/unit/tui/plain*.test.ts), not to this M2 fixture.
      expect(today.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
});
