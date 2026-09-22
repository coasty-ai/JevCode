/**
 * F13 — the run's timing block is the SUM of the step rows, for every bucket a step can write.
 *
 * Four `StepTiming` members were written per step and summed nowhere: `coordinateMs` and `coordWaitMs`
 * (contract 1.4 W2b, COORDINATION-DESIGN §4.2) and `fastPathMs` / `fastPathJevMs` (contract 1.9 Fastlane §4.4,
 * §5.2). `RunResult.timing` — which is what `state.json` persists and what an archived run is read through —
 * therefore disagreed silently with `steps.jsonl`: a reader could not get the run's coordinate or fast-path wall
 * without re-reading every step row, and no gate said the two disagreed.
 *
 * The property asserted here is the invariant, not the four names: for every optional bucket, the run's value is
 * the sum of the rows that carry it, and a bucket no row carried stays ABSENT on the run (which is what keeps a
 * coordination-off / fast-path-off run's `state.json` byte-identical — `engine-coordination-off.test.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StepTiming } from '../../../src/core/types.js';
import { RUN_TIMING_BUCKETS, addStepTimingToRun } from '../../../src/loop/engine.js';
import { coordinationRoot, openLedger, type LedgerHandle } from '../../../src/coordination/index.js';
import { tempHome } from '../coordination/helpers.js';
import { makeEngine, repoState, turn, type Harness } from './fakes.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function zero(): StepTiming {
  return { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 };
}

function row(over: Partial<StepTiming>): StepTiming {
  return { generatorMs: 1, jevMs: 2, execMs: 3, harnessMs: 4, totalMs: 10, ...over };
}

describe('F13 — every StepTiming bucket a step writes is summed onto the run', () => {
  it('the four unsummed buckets reach RunResult.timing as the sum of the two step rows', () => {
    const run = zero();
    addStepTimingToRun(run, row({ coordinateMs: 3, coordWaitMs: 40, fastPathMs: 1_200, fastPathJevMs: 150 }));
    addStepTimingToRun(run, row({ coordinateMs: 5, coordWaitMs: 60, fastPathMs: 800, fastPathJevMs: 50 }));
    expect(run.coordinateMs).toBe(8);
    expect(run.coordWaitMs).toBe(100);
    expect(run.fastPathMs).toBe(2_000);
    expect(run.fastPathJevMs).toBe(200);
    // and the buckets that already worked did not move
    expect(run).toMatchObject({ generatorMs: 2, jevMs: 4, execMs: 6, harnessMs: 8, totalMs: 20 });
  });

  it('a bucket no step wrote stays absent on the run (contract 1.9 I2: a fast-path-off run writes HEAD\'s state.json)', () => {
    const run = zero();
    addStepTimingToRun(run, row({}));
    addStepTimingToRun(run, row({}));
    for (const k of RUN_TIMING_BUCKETS) expect(run[k]).toBeUndefined();
    expect(Object.keys(run).sort()).toEqual(['execMs', 'generatorMs', 'harnessMs', 'jevMs', 'totalMs']);
  });

  it('one step of two carrying a bucket sums to that one step (absent is 0, not a hole)', () => {
    const run = zero();
    addStepTimingToRun(run, row({ fastPathMs: 700 }));
    addStepTimingToRun(run, row({ coordinateMs: 2 }));
    expect(run.fastPathMs).toBe(700);
    expect(run.coordinateMs).toBe(2);
  });

  it('the bucket list covers every optional member StepTiming declares (a new bucket cannot be added and forgotten)', () => {
    // every optional member of `StepTiming` must be summed, or `state.json` disagrees with `steps.jsonl` again.
    // `routerWaitMs` is deliberately NOT on the list: contract 1.9 §0.4 I3 asserts it per ROUTED SITE and the
    // bench-wide row is still open (docs/LLM-LOOP-DESIGN.md §7.5, recorded gaps) — summing it here would invent a
    // run-level figure no design names.
    const all = row({ imagesMs: 1, synthMs: 1, decomposeMs: 1, coordinateMs: 1, coordWaitMs: 1, fastPathMs: 1, fastPathJevMs: 1, routerWaitMs: 1, jevWallMs: 1 });
    const optional = Object.keys(all).filter((k) => !['generatorMs', 'jevMs', 'execMs', 'harnessMs', 'totalMs'].includes(k));
    expect([...RUN_TIMING_BUCKETS, 'routerWaitMs'].sort()).toEqual(optional.sort());
  });
});

// ---------------------------------------------------------------------------------------
// End to end: a real ledger, so `coordinateMs` is a measured wall and not a constructed one
// ---------------------------------------------------------------------------------------

const WS = 'ws:3f9a2c1d8bc0d11e';
const REPO = '9c3a7ac066816f2b';

async function ledgerOn(): Promise<{ home: string; ledger: LedgerHandle }> {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const ledger = openLedger({
    home: t.home,
    self: { deviceId: 'k3q7m2ab', label: 'mbp', host: 'mbp.local', user: 'p', bootAt: '2026-09-21T06:00:00.000Z', bootId: 'boot-1', sessionId: null, runId: null, wsKey: WS, repoKey: REPO, remoteKey: null, branch: 'main' },
    isPidAlive: () => true,
    watch: (() => {
      throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
    }) as never,
  });
  cleanups.push(() => ledger.close());
  await ledger.open();
  expect(coordinationRoot(t.home)).toContain(t.home);
  return { home: t.home, ledger };
}

describe('F13 end to end — a coordinated two-step run', () => {
  it('RunResult.timing.coordinateMs equals the sum of the two steps.jsonl rows', async () => {
    const { ledger } = await ledgerOn();
    // a clock that advances one ms per reading: the coordinate gate's wall is then a positive integer on every
    // machine, so the assertion is about the SUM and never about how fast this laptop happens to be
    let t = 0;
    const h: Harness = await makeEngine({
      // two WRITES: the coordinate gate runs on an action that touches paths, and skips a `read` / `done`
      turns: [turn({ kind: 'write', path: 'src/a.py', content: 'x = 1\n' }, { remaining: ['keep going'] }), turn({ kind: 'write', path: 'src/b.py', content: 'y = 2\n' }, { remaining: ['keep going'] })],
      limits: { maxSteps: 2 },
      probeGitState: repoState(),
      now: () => (t += 1),
      engine: { coordination: { ledger } },
    });
    cleanups.push(() => h.cleanup());
    const r = await h.engine.run();
    expect(r.steps).toBe(2);
    const rows = h.store.steps.map((s) => s.timing.coordinateMs);
    expect(rows.every((v) => typeof v === 'number' && v > 0)).toBe(true);
    expect(r.timing.coordinateMs).toBe(rows.reduce<number>((a, b) => a + (b ?? 0), 0));
  });
});
