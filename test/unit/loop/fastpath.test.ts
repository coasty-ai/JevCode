/**
 * The synth fast path — route R9 of docs/LLM-LOOP-DESIGN.md §4 — from the loop side.
 *
 * The engine-side half is pure, and that is what most of this file drives: the stage-1 trigger predicate (T1–T12,
 * structural — engine state and code over it, never a task name), the one-round budget arithmetic of §4.4, and the
 * record builder. The last block is the I2 golden: a `jev-on` run with `fastPath: 'off'` writes exactly the
 * `steps.jsonl` it wrote before this wave — no new member anywhere, and nothing else about the step changed.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Harness } from './fakes.js';
import { createFakeSandbox, failingTests, makeEngine, turn } from './fakes.js';
import type { EngineMode, LastTestRun, StepRecord } from '../../../src/core/types.js';
import { resolveFastPathOption } from '../../../src/loop/engine.js';
import {
  FASTPATH_ATTEMPTS_MAX,
  FASTPATH_MAX_FAILING,
  FASTPATH_MAX_T_RUN_MS,
  FASTPATH_WALL_MAX_MS,
  FASTPATH_WALL_MIN_T_RUN_MULTIPLE,
  declinedRecord,
  fastPathBudget,
  fastPathStage1,
  firedRecord,
} from '../../../src/loop/stages/fastpath.js';
import type { FastPathStage1Input } from '../../../src/loop/stages/fastpath.js';
import { FASTPATH_JEV_MAX, fastPathFingerprint } from '../../../src/synth/search/fastpath.js';
import type { FastPathRoundResult } from '../../../src/synth/search/fastpath.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

// ---------------------------------------------------------------------------------------
// §4.3 stage 1 — the trigger predicate
// ---------------------------------------------------------------------------------------

const FINGERPRINT = fastPathFingerprint('gcd.py', ['tests/test_gcd.py::test_gcd']);

function lastRun(over: Partial<LastTestRun> = {}): LastTestRun {
  return { step: 4, command: 'python3 -m pytest -q', passed: 3, failed: 1, errors: 0, allPassed: false, durationMs: 240, ...over };
}

function input(over: Partial<FastPathStage1Input> = {}): FastPathStage1Input {
  return {
    mode: 'jev-on',
    option: 'auto',
    handles: true,
    lastTestRun: lastRun(),
    lastRunWasTestCommand: true,
    scopeUsable: true,
    lastChangeStep: 2,
    suspects: ['gcd.py'],
    repository: false,
    layoutDetected: true,
    spendLeftUsd: 4,
    wallLeftMs: 600_000,
    budget: fastPathBudget({ tRunMs: 240, stepWallRemainingMs: 300_000 }),
    fingerprint: FINGERPRINT,
    disarmed: false,
    state: { seen: new Set<string>(), attempts: new Map<string, number>() },
    loopTripped: false,
    pausePending: false,
    leaseConflict: false,
    ...over,
  };
}

const reasonOf = (over: Partial<FastPathStage1Input>): string => {
  const g = fastPathStage1(input(over));
  return g.fire ? 'FIRE' : g.reason;
};

describe('fastPathStage1', () => {
  it('fires on the one shape the search provably wins: a single-file cluster at a fast t_run', () => {
    expect(fastPathStage1(input())).toEqual({ fire: true, file: 'gcd.py' });
  });

  it('T1: only in jev-on, and only with the option on', () => {
    expect(reasonOf({ option: 'off' })).toBe('off');
    for (const mode of ['llm-jev', 'jev-only', 'jev-off'] satisfies EngineMode[]) expect(reasonOf({ mode })).toBe('not_jev_on');
  });

  it('T3: needs a parsed run OF THE TEST COMMAND whose scope was usable and which failed', () => {
    expect(reasonOf({ lastTestRun: null })).toBe('no_parsed_run');
    expect(reasonOf({ lastRunWasTestCommand: false })).toBe('no_parsed_run');
    // §6 row 14: a narrow test command that ran nothing reads as green; the fast path refuses to trust it
    expect(reasonOf({ scopeUsable: false })).toBe('scope_unusable');
    expect(reasonOf({ lastTestRun: lastRun({ failed: 0, errors: 0, allPassed: true }) })).toBe('all_passing');
  });

  it('T7: one cluster, not a broken build', () => {
    expect(reasonOf({ lastTestRun: lastRun({ failed: FASTPATH_MAX_FAILING }) })).toBe('FIRE');
    expect(reasonOf({ lastTestRun: lastRun({ failed: FASTPATH_MAX_FAILING + 1 }) })).toBe('too_many_failures');
  });

  it('T4: no workspace write since the run the predicate reads', () => {
    expect(reasonOf({ lastChangeStep: 4 })).toBe('workspace_changed');
    expect(reasonOf({ lastChangeStep: 5 })).toBe('workspace_changed');
    expect(reasonOf({ lastChangeStep: null })).toBe('FIRE');
  });

  it('T5: t_run bounds the round, and an unknown duration (a resumed run) cannot arm', () => {
    expect(reasonOf({ lastTestRun: lastRun({ durationMs: FASTPATH_MAX_T_RUN_MS }) })).toBe('FIRE');
    expect(reasonOf({ lastTestRun: lastRun({ durationMs: FASTPATH_MAX_T_RUN_MS + 1 }) })).toBe('t_run_too_slow');
    // §6 row 8: recorded, never silent — `lastTestRunOutput` is in-memory only, so a restart cannot arm blind
    const { durationMs: _drop, ...noDuration } = lastRun();
    expect(reasonOf({ lastTestRun: noDuration })).toBe('no_parsed_run');
  });

  it('T6: exactly one non-test source file, from the traceback and the task alone', () => {
    expect(reasonOf({ suspects: [] })).toBe('multi_file');
    expect(reasonOf({ suspects: ['gcd.py', 'other.py'] })).toBe('multi_file');
  });

  it('T8: a repository cluster never triggers — the sympy-16792 shape refused at the first of three gates (§6 row 5)', () => {
    expect(reasonOf({ repository: true })).toBe('repository_class');
    expect(reasonOf({ layoutDetected: false })).toBe('repository_class');
  });

  it('T9: never enter a round the run cannot pay for or cannot finish', () => {
    expect(reasonOf({ spendLeftUsd: 0 })).toBe('no_wall');
    expect(reasonOf({ budget: null })).toBe('no_wall');
    const b = fastPathBudget({ tRunMs: 240, stepWallRemainingMs: 300_000 })!;
    expect(reasonOf({ wallLeftMs: 2 * (b.wallMs + b.reserveMs) })).toBe('FIRE');
    expect(reasonOf({ wallLeftMs: 2 * (b.wallMs + b.reserveMs) - 1 })).toBe('no_wall');
  });

  it('T10 / T11: a fingerprint already declined, an exhausted cluster and a disarmed run are all out', () => {
    expect(reasonOf({ state: { seen: new Set([FINGERPRINT]), attempts: new Map() } })).toBe('fingerprint_seen');
    expect(reasonOf({ state: { seen: new Set<string>(), attempts: new Map([[FINGERPRINT, FASTPATH_ATTEMPTS_MAX]]) } })).toBe('attempts_exhausted');
    expect(reasonOf({ disarmed: true })).toBe('disarmed');
  });

  it('T12: a tripped loop detector, a pending pause and a known lease conflict each decline (§6 rows 6, 7, 9)', () => {
    expect(reasonOf({ loopTripped: true })).toBe('loop_tripped');
    expect(reasonOf({ pausePending: true })).toBe('pause_pending');
    expect(reasonOf({ leaseConflict: true })).toBe('lease_conflict');
  });

  it('T2 is evaluated last of all: a workspace the synthesizer does not cover declines after every free clause', () => {
    expect(reasonOf({ handles: false })).toBe('no_synthesizer');
    // and a free clause still wins over it, so the listing is never the reason a cheap decline is missed
    expect(reasonOf({ handles: false, lastTestRun: null })).toBe('no_parsed_run');
  });
});

// ---------------------------------------------------------------------------------------
// §4.4 — the budget
// ---------------------------------------------------------------------------------------

describe('fastPathBudget', () => {
  it('takes a share of the step wall, capped, with the confirm reserve held outside it', () => {
    const b = fastPathBudget({ tRunMs: 300, fullSuiteMs: 900, stepWallRemainingMs: 60_000 });
    expect(b).not.toBeNull();
    expect(b!.wallMs).toBe(21_000);
    expect(b!.reserveMs).toBe(1_800);
    expect(b!.jevRequests).toBe(FASTPATH_JEV_MAX);
  });

  it('never exceeds the hard ceiling however long the step has left', () => {
    const b = fastPathBudget({ tRunMs: 300, stepWallRemainingMs: 60 * 60_000 });
    expect(b!.wallMs).toBe(FASTPATH_WALL_MAX_MS);
  });

  it('DECLINES below the floor rather than entering a round that can test almost nothing', () => {
    // the floor is 8 x t_run; a share under it buys at most seven candidates
    const tRunMs = 700;
    const justUnder = Math.ceil((FASTPATH_WALL_MIN_T_RUN_MULTIPLE * tRunMs - 1) / 0.35);
    expect(fastPathBudget({ tRunMs, stepWallRemainingMs: justUnder - 100 })).toBeNull();
    expect(fastPathBudget({ tRunMs, stepWallRemainingMs: justUnder + 1_000 })).not.toBeNull();
  });

  it('caps the run count at what the oracle can afford when the caller knows it', () => {
    expect(fastPathBudget({ tRunMs: 100, stepWallRemainingMs: 120_000, runsAffordable: 12 })!.testRuns).toBe(12);
  });
});

// ---------------------------------------------------------------------------------------
// §5.2 — the record
// ---------------------------------------------------------------------------------------

describe('the fast-path record', () => {
  it('a stage-1 decline costs nothing and names the clause', () => {
    expect(declinedRecord('t_run_too_slow', 1_200, false)).toMatchObject({ decision: 'declined', stage: 1, reason: 't_run_too_slow', outcome: 'skipped', wallMs: 0, budgetMs: 0, tRunMs: 1_200 });
  });

  it('a fired round records what it saw and never overruns its own share', () => {
    const result: FastPathRoundResult = {
      kind: 'proposed',
      proposal: { goal: 'fix', action: { kind: 'patch', diff: 'd' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
      telemetry: { wallMs: 8_000, jevMs: 900, jevRequests: 4, testRuns: 22, sites: 3, poolSize: 41, runMode: 'SIEVE', candidatesTested: 41, passer: true, confirmedCold: true, structuralDrops: 0, held: 0, dropped: 0 },
    };
    const rec = firedRecord(result, { tRunMs: 240, budgetMs: 21_000, disarmed: false });
    expect(rec).toMatchObject({ decision: 'fired', stage: 2, outcome: 'proposed', reason: 'none', candidatesTested: 41, confirmedCold: true });
    expect(rec.wallMs).toBeLessThanOrEqual(rec.budgetMs);
  });

  it('`refused` is not `no_passer`: a round that found and refused passers says so (§4.5)', () => {
    const result: FastPathRoundResult = {
      kind: 'failed',
      reason: 'confirm_timeout',
      outcome: 'refused',
      telemetry: { wallMs: 9_000, jevMs: 0, jevRequests: 0, testRuns: 30, sites: 2, poolSize: 30, runMode: 'SIEVE', candidatesTested: 30, passer: true, confirmedCold: false, structuralDrops: 2, held: 1, dropped: 0 },
    };
    expect(firedRecord(result, { tRunMs: 240, budgetMs: 21_000, disarmed: true })).toMatchObject({ decision: 'failed', outcome: 'refused', reason: 'confirm_timeout', structuralDrops: 2, held: 1, disarmed: true });
  });
});

// ---------------------------------------------------------------------------------------
// §0.3 — the switch
// ---------------------------------------------------------------------------------------

describe('resolveFastPathOption', () => {
  const withEnv = <T>(value: string | undefined, f: () => T): T => {
    const had = Object.hasOwn(process.env, 'JEVCODE_FASTPATH');
    const before = process.env['JEVCODE_FASTPATH'];
    if (value === undefined) delete process.env['JEVCODE_FASTPATH'];
    else process.env['JEVCODE_FASTPATH'] = value;
    try {
      return f();
    } finally {
      if (had && before !== undefined) process.env['JEVCODE_FASTPATH'] = before;
      else delete process.env['JEVCODE_FASTPATH'];
    }
  };

  it("defaults to 'auto' in jev-on and 'off' in every other mode", () => {
    withEnv(undefined, () => {
      expect(resolveFastPathOption('jev-on', undefined)).toBe('auto');
      for (const mode of ['llm-jev', 'jev-only', 'jev-off'] satisfies EngineMode[]) expect(resolveFastPathOption(mode, undefined)).toBe('off');
      // an explicit 'auto' outside jev-on is still off: the route exists only in the jev-on propose branch
      expect(resolveFastPathOption('llm-jev', 'auto')).toBe('off');
      expect(resolveFastPathOption('jev-on', 'off')).toBe('off');
    });
  });

  it('is overridden by JEVCODE_FASTPATH, and an env typo is ignored rather than fatal', () => {
    withEnv('off', () => expect(resolveFastPathOption('jev-on', 'auto')).toBe('off'));
    withEnv('auto', () => expect(resolveFastPathOption('jev-on', 'off')).toBe('auto'));
    withEnv('auto', () => expect(resolveFastPathOption('llm-jev', 'auto')).toBe('off'));
    withEnv('yes please', () => expect(resolveFastPathOption('jev-on', undefined)).toBe('auto'));
  });
});

// ---------------------------------------------------------------------------------------
// I2 — `fastPath: 'off'` is byte-identical to today's jev-on
// ---------------------------------------------------------------------------------------

/** Everything that legitimately varies between two runs of the same script: wall clocks and the run's own timestamps. */
function normalise(records: readonly StepRecord[]): string {
  const zero = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(zero);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = /Ms$|^startedAt$|^latencyMs$/.test(k) ? 0 : zero(x);
      return out;
    }
    return v;
  };
  return JSON.stringify(zero(records));
}

describe('I2: fastPath off', () => {
  const script = [turn({ kind: 'run', command: 'python3 -m pytest -q' }), turn({ kind: 'done', summary: 'green' })];

  it("writes no contract-1.9 member anywhere in steps.jsonl and keeps today's jev-on record byte-for-byte", async () => {
    const off = await build({ mode: 'jev-on', turns: script, sandbox: createFakeSandbox(() => failingTests), engine: { fastPath: 'off' } });
    await off.engine.run();
    expect(off.store.steps.length).toBeGreaterThan(0);
    const text = JSON.stringify(off.store.steps);
    for (const key of ['fastPath', 'scopeUsable', 'fastPathMs', 'fastPathJevMs']) expect(text).not.toContain(key);
    expect(off.store.steps.some((s) => s.proposer === 'fastpath')).toBe(false);
    // the same run armed: the predicate cannot fire on this workspace (no Python source, no cluster), and apart from
    // the fast path's own decline row NOTHING about the step differs — same proposals, same order, same everything
    const on = await build({ mode: 'jev-on', turns: script, sandbox: createFakeSandbox(() => failingTests), engine: { fastPath: 'auto' } });
    await on.engine.run();
    // the armed run really did evaluate the predicate on every step (otherwise the comparison below proves nothing)
    expect(on.store.steps.every((s) => s.fastPath !== undefined)).toBe(true);
    expect(on.store.steps.every((s) => s.fastPath?.decision === 'declined')).toBe(true);
    // at least one step got past the free clauses into the listing-backed half, so T2/T6/T8 really ran here
    expect(on.store.steps.some((s) => s.fastPath?.reason === 'multi_file')).toBe(true);
    const stripped = on.store.steps.map((s) => {
      const { fastPath: _f, scopeUsable: _s, ...rest } = s;
      return rest as StepRecord;
    });
    expect(normalise(stripped)).toBe(normalise(off.store.steps));
    // and the armed run never proposed through the fast path on a workspace it does not cover
    expect(on.store.steps.some((s) => s.proposer === 'fastpath')).toBe(false);
  });

  it("keeps JEV'S OWN STATE byte-identical: `durationMs` is the engine's private fact, never a state member", async () => {
    const off = await build({ mode: 'jev-on', turns: script, sandbox: createFakeSandbox(() => failingTests), engine: { fastPath: 'off' } });
    await off.engine.run();
    // the run really did ask Jev about a workspace whose last test run is known (otherwise this proves nothing)
    const runs = off.decider.calls.map((c) => (c.state as { workspace?: { lastTestRun?: Record<string, unknown> | null } }).workspace?.lastTestRun ?? null).filter((r): r is Record<string, unknown> => r !== null);
    expect(runs.length).toBeGreaterThan(0);
    // I2: Jev's own state bytes are what they were before contract 1.9 — `durationMs` is the engine's, not Jev's
    for (const r of runs) expect(Object.keys(r).sort()).toEqual(['allPassed', 'command', 'errors', 'failed', 'passed', 'step']);
  });

  it('rounds the run wall it persists: a checkpoint carries whole milliseconds, not a 14-decimal float', async () => {
    const on = await build({ mode: 'jev-on', turns: script, sandbox: createFakeSandbox(() => failingTests), engine: { fastPath: 'auto' } });
    await on.engine.run();
    const durations = on.store.states.map((c) => c.lastTestRun?.durationMs).filter((d): d is number => typeof d === 'number');
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) expect(Number.isInteger(d)).toBe(true);
  });
});
