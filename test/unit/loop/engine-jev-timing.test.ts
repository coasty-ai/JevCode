/**
 * What `harnessMs` is allowed to be charged for (HARNESS-NEXT-DESIGN §4.4, §5, §8 R-4).
 *
 * `StepTiming.harnessMs` is `total − generatorMs − jev − execMs − confirmMs`, and it is the 50 ms gate
 * `perf/step-overhead.ts` measures. The `jev` term used to be `AskResult.latencyMs`, which the decider reports
 * about itself — and every decider the harness measures itself against is a double that reports `latencyMs: 0`
 * and does its work on this thread (`src/jev/mock.ts`, `src/bench/stub-decider.ts`, `src/jev/off.ts`). So the
 * gated number silently included the double's own wall, and the gate could be "fixed" by making the double
 * faster. The engine now measures the ask itself and charges the larger of the two.
 *
 * The recorded quantities do not move: `jev.jsonl`'s `latencyMs`, `StepTiming.jevMs` and the run's `jevMs` are
 * still what the decider reported, because they are the client's cost basis, not a harness measurement.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Harness } from './fakes.js';
import { createFakeSandbox, execResult, makeEngine, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** ms of wall each ask spends inside `decider.ask` while reporting `latencyMs: 0` — a mock's shape exactly. */
const ASK_WALL_MS = 25;

describe('harnessMs and the decider double', () => {
  it('does not charge the harness for a decider that spends real wall and reports latencyMs 0', async () => {
    let i = 0;
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: `echo ${'abcd'[i++ % 4]}` }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n` })),
      // no `latencyMs`: the double reports 0 for work it really did, which is the whole failure mode
      deciderOptions: { delayMs: () => ASK_WALL_MS },
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    expect(r.steps).toBe(3);

    const asks = h.decider.calls.length;
    expect(asks).toBeGreaterThan(2); // several stages ask per step; the point is only that it is not one
    const doubleWallMs = asks * ASK_WALL_MS;

    // the reported quantity is untouched: the decider said 0 ms, so the records say 0 ms
    expect(r.timing.jevMs).toBe(0);
    for (const s of h.store.steps) expect(s.timing.jevMs).toBe(0);

    // and none of the double's wall reached the gated number — under the old subtraction harnessMs would have
    // been at least `doubleWallMs`, because that wall is inside the step and outside every other bucket
    expect(r.timing.harnessMs).toBeLessThan(doubleWallMs / 2);
    expect(r.timing.totalMs).toBeGreaterThan(doubleWallMs * 0.8);
  });

  it('still subtracts a real decider whose reported latency matches its wall', async () => {
    let i = 0;
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: `echo ${'abcd'[i++ % 4]}` }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n` })),
      deciderOptions: { delayMs: () => ASK_WALL_MS, latencyMs: ASK_WALL_MS },
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    const asks = h.decider.calls.length;
    expect(r.timing.jevMs).toBe(asks * ASK_WALL_MS);
    // the two terms agree, so `max` changes nothing: the harness share is still the small remainder
    expect(r.timing.harnessMs).toBeLessThan(asks * ASK_WALL_MS);
  });

  /**
   * OOS iteration 2, defect 3 (experiments/results/llm-jev-iter2.md §10): the measured ask wall
   * was DECLARED on the step draft, documented as "the wall the engine actually spent inside
   * `decider.ask`", used by `jevChargedMs` to decide what `harnessMs` is charged — and never
   * persisted. `grep -c jevWallMs` over that measurement's `state.json` and `steps.jsonl`
   * archives read 0 in both, so no record said which of the two numbers the gate had charged,
   * and the S0 timeline could be reconstructed only from `generatorMs`, `jevMs`, `execMs`,
   * `harnessMs`, `synthMs`, `imagesMs` and `totalMs`.
   */
  it('persists the measured ask wall on every step record and on the run', async () => {
    let i = 0;
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: `echo ${'abcd'[i++ % 4]}` }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n` })),
      deciderOptions: { delayMs: () => ASK_WALL_MS },
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    const asks = h.decider.calls.length;

    // every step that asked says how long it really spent there — the number `harnessMs` is
    // charged by, which the decider's own `latencyMs: 0` does not report
    for (const s of h.store.steps) {
      expect(s.timing.jevWallMs, `step ${s.step}`).toBeGreaterThan(0);
      expect(s.timing.jevMs).toBe(0);
      expect(s.timing.jevWallMs ?? 0).toBeGreaterThanOrEqual(s.timing.jevMs);
    }
    // and the run's own timeline sums them, like every other bucket
    const perStep = h.store.steps.reduce((a, s) => a + (s.timing.jevWallMs ?? 0), 0);
    expect(r.timing.jevWallMs).toBe(perStep);
    expect(r.timing.jevWallMs ?? 0).toBeGreaterThanOrEqual(asks * ASK_WALL_MS * 0.8);
    // it is additive: a record is JSON-round-trippable and the field survives it
    const roundTripped = JSON.parse(JSON.stringify(h.store.steps[0])) as { timing: { jevWallMs?: number } };
    expect(roundTripped.timing.jevWallMs).toBe(h.store.steps[0]?.timing.jevWallMs);
  });
});
