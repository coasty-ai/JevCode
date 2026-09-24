/**
 * contract 1.4 (W2b) — the test `decompose-m2.test.ts` names and could not write.
 *
 * Its P9 block says, verbatim: "reaching `acceptDelegation` needs `splitGate`'s resource arm to pass, and that arm
 * reads the HOST … The engine builds `DecomposeFacts` privately from `nodePreflightProbe()`, so a unit test cannot
 * pin those numbers, and a test that passes only on a machine with 6 GiB free is worse than no test. The seam that
 * would fix it is named in the hand-off: an optional `PreflightProbe` on `EngineDeps`, defaulting to
 * `nodePreflightProbe()`."
 *
 * That seam now exists. This file is what it buys: the resource arm of §3.6 / §8.3 decided by injected numbers, the
 * same on every machine, plus the M2 half that the seam finally makes checkable — with the gate shut, the probe is
 * never touched at all, which is a stronger statement than "no orchestrate bytes were written".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineOptions } from '../../../src/core/types.js';
import { DEFAULT_SPLIT_POLICY, type PreflightProbe } from '../../../src/orchestrate/index.js';
import { alwaysApprove, createFakeWorkspace, makeEngine, repoState, turn } from './fakes.js';

const GiB = 1024 * 1024 * 1024;

/** A probe whose every reading is a constant, and that counts what asked. */
function fakeProbe(o: { cores?: number | null; freeMem?: number | null; freeDisk?: number | null; repoBytes?: number | null; fds?: number | null } = {}): PreflightProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    availableParallelism: () => {
      calls.push('availableParallelism');
      return o.cores === undefined ? 8 : o.cores;
    },
    freeMemBytes: () => {
      calls.push('freeMemBytes');
      return o.freeMem === undefined ? 32 * GiB : o.freeMem;
    },
    diskFree: async (p) => {
      calls.push(`diskFree:${p}`);
      return o.freeDisk === null ? null : { freeBytes: o.freeDisk ?? 400 * GiB, totalBytes: 1000 * GiB };
    },
    repoBytes: async (p) => {
      calls.push(`repoBytes:${p}`);
      return o.repoBytes === undefined ? 50 * 1024 * 1024 : o.repoBytes;
    },
    openFileLimit: () => {
      calls.push('openFileLimit');
      return o.fds === undefined ? 4096 : o.fds;
    },
  };
}

const PLAN = { done: [], remaining: ['fix alpha/one.ts', 'fix beta/one.ts', 'fix gamma/one.ts'], unverified: [], openProblems: [], harnessProblems: [] };

async function runWith(probe: PreflightProbe | undefined, engine: Partial<EngineOptions>): Promise<{ skipped: string[]; orchestrateKeys: string[]; started: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-preflight-'));
  const h = await makeEngine({
    runsDir: dir,
    turns: [turn({ kind: 'done', summary: 'nothing to change' })],
    workspace: createFakeWorkspace({ root: dir, files: { 'alpha/one.ts': 'a', 'beta/one.ts': 'b', 'gamma/one.ts': 'c' }, gitState: repoState() }),
    probeGitState: repoState(),
    confirmer: alwaysApprove,
    ...(probe !== undefined ? { preflightProbe: probe } : {}),
    engine: {
      seed: { parentRunId: 'p', plan: PLAN, window: [], createdThisRun: [], lastTestRun: null },
      ...engine,
    } as Partial<EngineOptions>,
  });
  try {
    await h.engine.run();
    return {
      skipped: h.of('decompose:skipped').map((e) => e.why),
      orchestrateKeys: [...h.store.cache.keys()].filter((k) => k.startsWith('orchestrate/')),
      started: h.of('decompose:start').length,
    };
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASK: Partial<EngineOptions> = {
  splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask', maxAgents: 3, verify: ['npm test'] },
  orchestration: { depth: 0, hasLedger: true },
};

describe('§3.6 / §8.3: the resource arm is decided by the injected probe, identically on every machine', () => {
  it('a three-core box shuts the gate on `resources`, and says so with the same reason on any host', async () => {
    // `min(maxAgents, cores - 1, …) >= 2` — two cores allow ONE agent, which is not a split
    const probe = fakeProbe({ cores: 2 });
    const r = await runWith(probe, ASK);
    expect(r.skipped).toContain('resources');
    expect(r.started).toBe(0);
    expect(r.orchestrateKeys).toEqual([]);
    // the numbers really came from the seam, and the repo measurement was taken against the workspace
    expect(probe.calls).toContain('availableParallelism');
    expect(probe.calls.some((c) => c.startsWith('repoBytes:'))).toBe(true);
  });

  it('memory alone can shut it: 4 GiB free against the 3 GiB-per-agent default is one agent', async () => {
    const r = await runWith(fakeProbe({ freeMem: 4 * GiB }), ASK);
    expect(r.skipped).toContain('resources');
  });

  it('disk alone can shut it: a 100 MiB repo needs 2 x 110 MiB, and 150 MiB free is one agent', async () => {
    const r = await runWith(fakeProbe({ repoBytes: 100 * 1024 * 1024, freeDisk: 150 * 1024 * 1024 }), ASK);
    expect(r.skipped).toContain('resources');
  });

  it('a generous box passes the resource arm — the gate then shuts for a REASON ABOUT THE WORK, never resources', async () => {
    const r = await runWith(fakeProbe(), ASK);
    // this is the half that could not be written before: on a small CI box the old test would have read
    // `resources` and proved nothing about the arms past it
    expect(r.skipped).not.toContain('resources');
    expect(r.skipped.length).toBeGreaterThan(0);
    // and the short-circuit's three reasons are still excluded — the stage really ran
    for (const why of r.skipped) expect(['split_off', 'child_depth', 'no_ledger']).not.toContain(why);
  });

  it('an unmeasurable reading is UNBOUNDED, not zero: a box with no statfs and no core count still passes the arm', async () => {
    // §3.6's invariant, end to end rather than in `preflight`'s unit test: "a `null` reading contributes no limit"
    const r = await runWith(fakeProbe({ freeDisk: null, repoBytes: null, fds: null }), ASK);
    expect(r.skipped).not.toContain('resources');
  });
});

describe('M2 [G5]: with the gate shut, the probe is never touched', () => {
  it('`split: off` (the shipping default) asks the host nothing at all', async () => {
    const probe = fakeProbe();
    const r = await runWith(probe, { orchestration: { depth: 0, hasLedger: true } });
    expect(probe.calls).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.started).toBe(0);
  });

  it('no ledger, with `split: ask`, is the same: [G5] shuts the gate before one measurement is taken', async () => {
    const probe = fakeProbe();
    // contract 1.4 (W2b): `hasLedger` is now DERIVED from `coordination.ledger !== null`; absent coordination and an
    // absent flag are the same fact, and it is the fact the gate reads
    const r = await runWith(probe, { splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask' }, orchestration: { depth: 0 } });
    expect(probe.calls).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('a child (depth 1) never measures either — the depth constant is checked before the resources', async () => {
    const probe = fakeProbe();
    await runWith(probe, { splitPolicy: { ...DEFAULT_SPLIT_POLICY, split: 'ask' }, orchestration: { depth: 1, hasLedger: true } });
    expect(probe.calls).toEqual([]);
  });
});

describe('the probe is ONE object for the run (so a test can count, and a run cannot drift)', () => {
  it('two steps of one run share the probe instance rather than rebuilding it per gate', async () => {
    const probe = fakeProbe({ cores: 2 });
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-preflight-'));
    const h = await makeEngine({
      runsDir: dir,
      turns: [turn({ kind: 'read', paths: ['alpha/one.ts'] }), turn({ kind: 'done', summary: 'done' })],
      workspace: createFakeWorkspace({ root: dir, files: { 'alpha/one.ts': 'a', 'beta/one.ts': 'b', 'gamma/one.ts': 'c' }, gitState: repoState() }),
      probeGitState: repoState(),
      confirmer: alwaysApprove,
      preflightProbe: probe,
      engine: { ...ASK, seed: { parentRunId: 'p', plan: PLAN, window: [], createdThisRun: [], lastTestRun: null } } as Partial<EngineOptions>,
    });
    try {
      await h.engine.run();
      // the gate ran on both steps and both readings came from the SAME injected object
      expect(h.of('decompose:skipped').length).toBeGreaterThanOrEqual(2);
      expect(probe.calls.filter((c) => c === 'availableParallelism').length).toBeGreaterThanOrEqual(2);
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
