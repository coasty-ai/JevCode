import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, execResult, makeEngine, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe('per-step cost is flat', () => {
  it('prompt size does not grow with step count beyond the window, and harnessMs < 50 ms per step', async () => {
    let i = 0;
    const h = await makeEngine({
      // letters, not digits: signature normalisation strips digits and would (correctly) trip the loop detector
      turns: () => turn({ kind: 'run', command: `echo ${'abcdefghijkl'[i++]}` }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(5_000)}\n` })),
      limits: { maxSteps: 12 },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    expect(r.steps).toBe(12);
    const sizes = h.provider.requests.map((q) => q.messages.reduce((n, m) => n + m.content.length, 0));
    // From step 5 on the window is full (4 entries); size must stay flat (within 15 %).
    const settled = sizes.slice(4);
    const min = Math.min(...settled);
    const max = Math.max(...settled);
    expect(max - min).toBeLessThan(min * 0.15);
    expect(sizes[11]).toBeLessThan(sizes[4]! * 1.15);
    // Jev state size is also flat: recent holds at most 4 entries
    const judgeStates = h.decider.callsAt('judge').map((c) => JSON.stringify(c.state).length);
    expect(Math.max(...judgeStates.slice(4)) - Math.min(...judgeStates.slice(4))).toBeLessThan(Math.min(...judgeStates.slice(4)) * 0.15);
    const harness = h.store.steps.map((s) => s.timing.harnessMs);
    for (const ms of harness) expect(ms).toBeLessThan(50);
    expect(r.timing.harnessMs).toBeLessThan(50 * 12);
    expect(r.tokensPerStep.every((t) => t === r.tokensPerStep[0])).toBe(true);
  });
});
