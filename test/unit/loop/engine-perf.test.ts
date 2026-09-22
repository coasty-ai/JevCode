import { cpus, loadavg } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, execResult, makeEngine, turn } from './fakes.js';
import { contextBudgetChars } from '../../../src/loop/context/limits.js';

const harnesses: Harness[] = [];

/**
 * The wall-clock half of these tests. This machine is shared with bench and perf runs, and `harnessMs` is real time, so
 * under load the number says nothing about the code — the gated home for it is `perf/step-overhead.ts`, which refuses to
 * publish a release number above `LOAD_QUIET`. Everything structural in these tests runs either way.
 */
function timingIsMeaningful(): boolean {
  return (loadavg()[0] ?? 0) <= cpus().length;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** 12 `run` steps whose output is 5 KiB each (letters, not digits: signature normalisation strips digits). */
async function twelveRunSteps(contextPolicy?: { view?: 'relaxed' | 'legacy' }): Promise<Harness> {
  let i = 0;
  const h = await makeEngine({
    turns: () => turn({ kind: 'run', command: `echo ${'abcdefghijkl'[i++]}` }, { remaining: ['keep going'] }),
    sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(5_000)}\n` })),
    limits: { maxSteps: 12 },
    ...(contextPolicy === undefined ? {} : { engine: { contextPolicy } }),
  });
  harnesses.push(h);
  return h;
}

describe('per-step cost is flat', () => {
  // docs/COORDINATION-DESIGN.md §8 relaxed the generator's window on purpose, so HEAD's flatness is now what
  // `contextPolicy.view: 'legacy'` pins (review finding 28: one setting must yield HEAD's prompt for the bench baselines).
  it('legacy view: prompt size does not grow with step count beyond the window, and harnessMs < 50 ms per step', async () => {
    const h = await twelveRunSteps({ view: 'legacy' });
    const r = await h.engine.run();
    expect(r.steps).toBe(12);
    const sizes = h.provider.requests.map((q) => q.messages.reduce((n, m) => n + m.content.length, 0));
    // From step 5 on the window is full (4 entries); size must stay flat (within 15 %).
    const settled = sizes.slice(4);
    const min = Math.min(...settled);
    const max = Math.max(...settled);
    expect(max - min).toBeLessThan(min * 0.15);
    expect(sizes[11]).toBeLessThan(sizes[4]! * 1.15);
    // nothing of §8 is persisted under the legacy view
    expect(h.store.last()!).not.toHaveProperty('history');
    expect(h.store.outputs.size).toBe(0);
    if (timingIsMeaningful()) {
      for (const ms of h.store.steps.map((s) => s.timing.harnessMs)) expect(ms).toBeLessThan(50);
      expect(r.timing.harnessMs).toBeLessThan(50 * 12);
    }
  });

  it('relaxed view (§8.3): the prompt grows to the history window, stays inside the budget, and Jev stays flat', async () => {
    const h = await twelveRunSteps();
    const r = await h.engine.run();
    expect(r.steps).toBe(12);
    const sizes = h.provider.requests.map((q) => q.messages.reduce((n, m) => n + m.content.length, 0));
    // the generator sees more than the 4-entry window did, and never more than the §8.2 budget
    expect(sizes[6]!).toBeGreaterThan(sizes[0]! * 2);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(contextBudgetChars());
    // §8.2 replaces flatness with a BOUND: the relaxed prompt grows with the tiers and the compaction folds it back
    // (a sawtooth by design). The invariant is per STEP, not per run, so it is checked on every `status` the engine
    // emitted: the history section never passes its 30 % allowance, at any point in the run.
    const meters = h.events
      .filter((e) => e.type === 'status')
      .map((e) => (e as { status: { context?: { promptChars: number; recentSteps: { chars: number; allowanceChars: number } } } }).status.context)
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    // the samples before the first prompt build are the restored object (§12.0.3: promptChars 0, no plan yet)
    const planned = meters.filter((m) => m.promptChars > 0);
    expect(meters.length).toBeGreaterThan(planned.length);
    expect(planned.length).toBeGreaterThanOrEqual(sizes.length);
    for (const m of planned) {
      expect(m.recentSteps.allowanceChars).toBe(Math.floor(contextBudgetChars() * 0.3));
      expect(m.recentSteps.chars).toBeLessThanOrEqual(m.recentSteps.allowanceChars);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.floor(contextBudgetChars() * 0.4) + Math.floor(contextBudgetChars() * 0.3) + 20_000);
    // and the compaction at step 8 really does fold it back: the step-9 prompt is smaller than the step-8 one
    expect(sizes[8]!).toBeLessThan(sizes[7]!);
    // §8.1 two windows: Jev's state is flat, exactly as before
    const judgeStates = h.decider.callsAt('judge').map((c) => JSON.stringify(c.state).length);
    expect(Math.max(...judgeStates.slice(4)) - Math.min(...judgeStates.slice(4))).toBeLessThan(Math.min(...judgeStates.slice(4)) * 0.15);
    // §8.9: the step overhead is unchanged (nothing synchronous, one stat round trip + ≤ 6 memoised output reads)
    if (timingIsMeaningful()) {
      for (const ms of h.store.steps.map((s) => s.timing.harnessMs)) expect(ms).toBeLessThan(50);
      expect(r.timing.harnessMs).toBeLessThan(50 * 12);
    }
    expect(r.tokensPerStep.every((t) => t === r.tokensPerStep[0])).toBe(true);
    expect(r.generatorTokensPerStep.every((t) => t === r.generatorTokensPerStep[0])).toBe(true);
    expect(r.tokensPerStep).toEqual(r.generatorTokensPerStep.map((g, i) => g + r.jevTokensPerStep[i]!));
  });
});
