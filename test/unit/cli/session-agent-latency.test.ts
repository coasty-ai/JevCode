/**
 * AGENT-LOOP-DESIGN §A1 "works perfectly": from Enter to the first model request, the harness adds p95 ≤ 50 ms. Slice S4 owns the
 * engine half (createEngine().run() → the first generate()); this is the SESSION half — `host.submit` (the composer's Enter) to the
 * moment the controller calls `engine.run()` — measured with the real `--mock` provider and decider builds (`buildProvider`
 * selecting the agent trajectory, `buildDecider`'s mock) and an instant scripted engine, so every millisecond is the controller's:
 * the `[you]` bubble, the key check, the spend gate, the conversation carry, the seed from the (prefetched) parent run, the
 * cached provider, the decider, the engine options, the index line and the log retarget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeController, type Harness } from './helpers.js';
import { budgetMs } from '../helpers/perf-budget.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function pct(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

describe('§A1 latency: Enter → engine.run(), session side, --mock', () => {
  it('p95 of 60 sequential agent turns (replies and tasks) is well under 50 ms; the first (cold) turn is reported apart', async () => {
    let t0 = 0;
    const samples: number[] = [];
    const h = await makeController({
      flags: { mode: 'agent', mock: true },
      decider: 'controller',
      script: (o) => ({
        onRun: () => samples.push(performance.now() - t0),
        stop: /^(hi|hello|thanks)\b/.test(o.task) ? 'answered' : 'complete',
        steps: 1,
        cost: { generator: 0.0001, jev: 0 },
      }),
    });
    harnesses.push(h);
    void h.controller.run();
    await h.ready();
    const texts = ['hi', 'fix the failing test', 'thanks', 'add a --dry-run flag', 'hello'];
    for (let i = 0; i < 61; i++) {
      t0 = performance.now();
      await h.submit(texts[i % texts.length]!);
    }
    expect(samples).toHaveLength(61);
    const cold = samples[0]!;
    const warm = samples.slice(1).sort((a, b) => a - b);
    const p50 = pct(warm, 50);
    const p95 = pct(warm, 95);
    const max = warm.at(-1)!;
    console.log(`[measured] Enter → engine.run() (session side, --mock, agent): cold ${cold.toFixed(2)} ms; warm n=${warm.length} p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms · max ${max.toFixed(2)} ms (target p95 ≤ 50 ms)`);
    expect(p95).toBeLessThan(budgetMs(50));
  });
});
