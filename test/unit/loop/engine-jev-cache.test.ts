/**
 * The engine's wiring of the within-run `requestHash` cache
 * (docs/research/llm-jev/oos-analysis-2026-09-22.md ranked change 2; `src/jev/cache.ts`).
 *
 * The cache's own mechanics are covered by `test/unit/jev/cache.test.ts`. What has to be true
 * HERE is the part only the engine can get wrong, and it is the dangerous half: the cache must
 * never collapse two requests that are genuinely different. A false hit would answer one stage
 * with another stage's answer and no record would show it, because a hit is recorded in
 * jev.jsonl exactly like a call.
 *
 * So the guard is an identity over a whole ordinary run: every request the engine recorded
 * reached the provider, and every recorded `usage.calls` is 1. A cache hit is the only thing that
 * can make those two numbers differ — which is also how a hit is counted off the records
 * (`usage.calls === 0`), since the named `synth.jevCacheHits` field would need `src/core/types.ts`,
 * owned by another wave.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { alwaysApprove, createFakeSandbox, intentIs, makeEngine, passingTests, riskAll, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

describe('the engine serves Jev through the per-run requestHash cache (OOS 2026-09-22 ranked change 2)', () => {
  it('never collapses two different requests: over an ordinary run every recorded request reached the provider and billed one call', async () => {
    const h = await build({
      turns: [
        turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: ['fix f', 'run tests'] }),
        turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, { remaining: ['run tests'], done: ['fix f'] }),
        turn({ kind: 'run', command: 'pytest -q' }, { done: ['fix f', 'run tests'], remaining: [] }),
        turn({ kind: 'done', summary: 'f fixed, 2 tests pass' }, { done: ['fix f', 'run tests'], remaining: [] }),
      ],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('investigate', 1), intentIs('edit', 2), intentIs('verify', 3), intentIs('done', 4), riskAll({ 0: 1 })] },
      confirmer: alwaysApprove,
    });
    await h.engine.run();
    const recorded = h.store.jevRequests;
    expect(recorded.length).toBeGreaterThan(0);
    // one recorded request per provider call: no hit fired, so nothing was wrongly deduplicated
    expect(h.decider.calls).toHaveLength(recorded.length);
    expect(recorded.every((r) => r.usage.calls === 1)).toBe(true);
    // distinct hashes throughout — the engine's states carry the step, so an ordinary run repeats none
    expect(new Set(recorded.map((r) => r.requestHash)).size).toBe(recorded.length);
  });

  it('a hit would be visible in the records and free: `usage.calls` 0 is the counter, since it is billed by the meter as nothing', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'nothing to do' }, { done: [], remaining: [] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('done', 1), riskAll({ 0: 1 })] },
      confirmer: alwaysApprove,
    });
    await h.engine.run();
    const recorded = h.store.jevRequests;
    const hits = recorded.filter((r) => r.usage.calls === 0);
    // this run repeats nothing, so the count is 0 — the assertion pins the SHAPE the counter reads
    expect(hits).toHaveLength(0);
    expect(recorded.reduce((n, r) => n + r.usage.calls, 0)).toBe(h.decider.calls.length);
  });
});
