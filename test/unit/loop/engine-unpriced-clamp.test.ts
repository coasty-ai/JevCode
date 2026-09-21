/**
 * TUI-DESIGN §9.5 / §19.4 (O1): a provider or decider reporting a non-finite `costUsd` ("unpriced": OpenRouter / Jev
 * `usage.cost` null) is reported once through `budget:unpriced` and then clamped to 0 everywhere else — the step draft,
 * `StepRecord.usage`, the generator / jev records and the `generator:end` / `jev:request` events — so steps.jsonl and
 * `--json` never carry `null` for a `number` field (`JSON.stringify({ costUsd: NaN })` is `{"costUsd":null}`) and the
 * p50 behind `budget:warn.stepsLeftEstimate` stays finite. The fail-closed stop of engine-budget-events.test.ts is untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsage } from '../../../src/core/types.js';
import { createSpendMeter } from '../../../src/spend/meter.js';
import type { Harness } from './fakes.js';
import { makeEngine, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const read = (usage: Partial<TokenUsage>) => turn({ kind: 'read', paths: ['src/a.py'] }, {}, { usage });
// the production meter (spend/meter.ts clamps a non-finite cost to 0 like the engine does); the harness's fake meter sums raw
const realMeter = (capUsd: number) => ({ meter: createSpendMeter(capUsd), limits: { spendCapUsd: capUsd } });

describe('unpriced usage is clamped after budget:unpriced (TUI-DESIGN §9.5)', () => {
  it('generator NaN: the event fires once for the step; the step record, the generator record and generator:end carry a finite 0; no artefact has costUsd null; stepsLeftEstimate stays finite', async () => {
    const m = realMeter(1);
    const h = await build({ turns: [read({ costUsd: Number.NaN }), read({ costUsd: 0.55 }), read({ costUsd: 0.5 })], meter: m.meter, limits: { ...m.limits, maxSteps: 5 }, engine: { allowUnpriced: true } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('spend_cap');
    // three generator calls, one per step; the crossing step (3) is stopped by the cap, so only the NaN step and the 0.55 step commit
    expect(h.of('generator:end').map((e) => [e.step, e.usage.costUsd])).toEqual([[1, 0], [2, 0.55], [3, 0.5]]);
    expect(h.store.steps.map((s) => s.step)).toEqual([1, 2]);
    expect(h.of('budget:unpriced')).toEqual([{ type: 'budget:unpriced', side: 'generator', model: 'claude-sonnet-5', step: 1, tokens: { input: 1000, output: 200 } }]);

    // steps.jsonl: the committed record holds a finite number, and its JSON never says null
    const step1 = h.store.steps[0]!;
    expect(step1.usage.generator.costUsd).toBe(0);
    expect(step1.usage.generator).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 });
    expect(Number.isFinite(step1.usage.jev.costUsd)).toBe(true);
    expect(JSON.stringify(step1)).not.toContain('"costUsd":null');
    expect(h.store.steps[1]!.usage.generator.costUsd).toBe(0.55);

    // generator.jsonl and the generator:end event (the --json line)
    expect(h.store.generator[0]!.usage.costUsd).toBe(0);
    const end = h.of('generator:end')[0]!;
    expect(end.usage).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 });
    expect(JSON.parse(JSON.stringify(end)).usage.costUsd).toBe(0);

    // the per-step cost series behind stepsLeftEstimate is finite: the run-scope warns after the first commit all carry an estimate
    const warns = h.of('budget:warn').filter((w) => w.scope === 'run');
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w.stepsLeftEstimate).not.toBeNull();
      expect(Number.isFinite(w.stepsLeftEstimate)).toBe(true);
      expect(w.perStepUsd).toBeDefined();
      expect(Number.isFinite(w.perStepUsd)).toBe(true);
      expect(Number.isFinite(w.spentUsd)).toBe(true);
    }

    // nothing persisted or returned carries a poisoned number
    expect(JSON.stringify(h.store.states)).not.toContain('"costUsd":null');
    expect(JSON.stringify(h.store.generator)).not.toContain('"costUsd":null');
    expect(JSON.stringify(h.events)).not.toContain('"costUsd":null');
    expect(JSON.stringify(r)).not.toContain('"costUsd":null');
    expect(Number.isFinite(r.usage.generator.costUsd)).toBe(true);
    expect(h.meter.snapshot().totalUsd).toBeCloseTo(r.usage.generator.costUsd + r.usage.jev.costUsd, 9);
  });

  it('jev NaN: the jev records and the step record carry 0, the generator side is untouched, the event names the jev side', async () => {
    const m = realMeter(2);
    const h = await build({ turns: [read({ costUsd: 0.01 })], deciderOptions: { usage: { costUsd: Number.NaN } }, meter: m.meter, limits: { ...m.limits, maxSteps: 1 }, engine: { allowUnpriced: true } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(h.of('budget:unpriced')[0]).toMatchObject({ side: 'jev', step: 1, tokens: { input: 300, output: 20 } });
    expect(h.store.jevRequests.length).toBeGreaterThan(0);
    for (const rec of h.store.jevRequests) expect(rec.usage).toMatchObject({ inputTokens: 300, outputTokens: 20, costUsd: 0, calls: 1 });
    for (const e of h.of('jev:request')) expect(e.record.usage.costUsd).toBe(0);
    const step1 = h.store.steps[0]!;
    expect(step1.usage.jev.costUsd).toBe(0);
    expect(step1.usage.jev.calls).toBe(h.store.jevRequests.length);
    expect(step1.usage.generator.costUsd).toBe(0.01);
    expect(JSON.stringify([h.store.steps, h.store.jevRequests, h.events, r])).not.toContain('"costUsd":null');
  });

  it('the fail-closed stop keeps its finite record: without --allow-unpriced the step commits with costUsd 0, then the run stops with error unpriced_usage', async () => {
    const m = realMeter(2);
    const h = await build({ turns: [read({ costUsd: Number.NaN })], meter: m.meter, limits: { ...m.limits, maxSteps: 3 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(1);
    expect(r.error).toMatchObject({ code: 'config', exitCode: 2 });
    expect(h.store.steps[0]!.usage.generator.costUsd).toBe(0);
    expect(JSON.stringify(h.store.steps)).not.toContain('"costUsd":null');
  });
});
