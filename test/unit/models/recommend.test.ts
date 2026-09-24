/** The shortlist: what each task weighs, what a budget excludes, and the reasons shown next to a row. */
import { describe, expect, it } from 'vitest';
import { BUDGET_CAPS, recommend, recommendOne } from '../../../src/models/recommend.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/config/defaults.js';
import { blendedPerM } from '../../../src/models/pricing.js';
import type { ProviderId } from '../../../src/models/types.js';
import { model } from './helpers.js';

/** config/defaults.ts types the default as a plain string; the catalogue wants the narrowed id. */
const DEFAULT_PROVIDER_ID: ProviderId = DEFAULT_PROVIDER;

describe('recommend over the bundled snapshot', () => {
  it('needs no I/O and returns a short list', () => {
    const list = recommend({ task: 'generator' });
    expect(list).toHaveLength(5);
    expect(list.every((r) => r.reasons.length > 0)).toBe(true);
  });

  it("puts the project's default generator first for both tasks", () => {
    expect(recommend({ task: 'generator' })[0]?.model.id).toBe(DEFAULT_MODEL);
    expect(recommendOne({ task: 'generator' })?.model.id).toBe(DEFAULT_MODEL);
    // the nudge is generator-only: for the decider task the shortlist leads with a fully capable model from a provider
    // a run can use — with seven generator providers that is no longer necessarily the shipped generator
    const decider = recommend({ task: 'decider' })[0];
    expect(decider?.model.supports).toMatchObject({ tools: true, structuredOutput: true, reasoning: true });
    expect(decider?.reasons.some((r) => r.includes('adapter ships today'))).toBe(true);
  });

  it('explains itself in the reasons', () => {
    const top = recommend({ task: 'generator', limit: 1 })[0];
    expect(top?.reasons[0]).toBe('tools + structured outputs + reasoning');
    expect(top?.reasons.some((r) => r.includes('context'))).toBe(true);
    expect(top?.reasons.some((r) => r.includes('/M in'))).toBe(true);
    expect(top?.reasons.some((r) => r.includes('adapter ships today'))).toBe(true);
  });

  it('never recommends a deprecated model', () => {
    expect(recommend({ task: 'generator', limit: 50 }).every((r) => r.model.deprecated !== true)).toBe(true);
  });

  it('respects a named budget', () => {
    for (const r of recommend({ task: 'generator', budget: 'cheap', limit: 50 })) {
      expect(blendedPerM(r.model.pricing) ?? Infinity).toBeLessThanOrEqual(BUDGET_CAPS.cheap);
    }
    const premium = recommend({ task: 'generator', budget: 'premium', limit: 50 });
    expect(premium.length).toBeGreaterThan(recommend({ task: 'generator', budget: 'cheap', limit: 50 }).length);
  });

  it('respects a numeric budget and drops unpriced models under one', () => {
    const pool = [
      model({ id: 'cheap', supports: { tools: true, structuredOutput: true }, pricing: { inputPerM: 0.1, outputPerM: 0.2 } }),
      model({ id: 'dear', supports: { tools: true, structuredOutput: true }, pricing: { inputPerM: 50, outputPerM: 100 } }),
      model({ id: 'unknown-price', supports: { tools: true, structuredOutput: true } }),
    ];
    expect(recommend({ task: 'generator', budget: 1, models: pool }).map((r) => r.model.id)).toEqual(['cheap']);
    expect(recommend({ task: 'generator', budget: 'any', models: pool }).map((r) => r.model.id)).toContain('unknown-price');
  });

  it('can be narrowed to one provider', () => {
    const list = recommend({ task: 'generator', providers: ['anthropic'] });
    expect(list.every((r) => r.model.provider === 'anthropic')).toBe(true);
  });
});

describe('task weighting', () => {
  const tooling = model({ id: 'tooling', supports: { tools: true, structuredOutput: false }, contextLength: 1_000_000, pricing: { inputPerM: 3, outputPerM: 9 } });
  const structured = model({ id: 'structured', supports: { tools: false, structuredOutput: true }, contextLength: 128_000, pricing: { inputPerM: 3, outputPerM: 9 } });
  const cheap = model({ id: 'cheap', supports: { tools: true, structuredOutput: true }, contextLength: 128_000, pricing: { inputPerM: 0.05, outputPerM: 0.1 } });
  const roomy = model({ id: 'roomy', supports: { tools: true, structuredOutput: true }, contextLength: 1_000_000, pricing: { inputPerM: 8, outputPerM: 24 } });

  it('the generator weighs tools over structured output', () => {
    const ranked = recommend({ task: 'generator', models: [tooling, structured] }).map((r) => r.model.id);
    expect(ranked[0]).toBe('tooling');
  });

  it('the decider weighs structured output over tools', () => {
    const ranked = recommend({ task: 'decider', models: [tooling, structured] }).map((r) => r.model.id);
    expect(ranked[0]).toBe('structured');
  });

  it('the decider prefers cheap where the generator prefers context', () => {
    expect(recommend({ task: 'generator', models: [cheap, roomy] }).map((r) => r.model.id)[0]).toBe('roomy');
    expect(recommend({ task: 'decider', models: [cheap, roomy] }).map((r) => r.model.id)[0]).toBe('cheap');
  });

  it('a wired adapter breaks a tie in favour of a provider that can run today', () => {
    const same = { supports: { tools: true, structuredOutput: true }, contextLength: 200_000, pricing: { inputPerM: 1, outputPerM: 2 } };
    const ranked = recommend({ task: 'generator', models: [model({ id: 'a', provider: 'meta', ...same }), model({ id: 'b', provider: 'anthropic', ...same })] });
    expect(ranked[0]?.model.id).toBe('b');
    expect(ranked[0]?.reasons).toContain('Anthropic adapter ships today');
  });

  it('is deterministic regardless of input order', () => {
    const pool = [cheap, roomy, tooling, structured];
    const a = recommend({ task: 'generator', models: pool }).map((r) => `${r.model.id}:${r.score}`);
    const b = recommend({ task: 'generator', models: [...pool].reverse() }).map((r) => `${r.model.id}:${r.score}`);
    expect(a).toEqual(b);
  });

  it('ranks an OpenRouter routing variant below the model it wraps', () => {
    const base = { supports: { tools: true, structuredOutput: true, reasoning: true }, contextLength: 1_000_000 };
    const pool = [
      model({ id: 'vendor/m:free', ...base, pricing: { inputPerM: 0, outputPerM: 0 } }),
      model({ id: 'vendor/m:batch', ...base, pricing: { inputPerM: 0.05, outputPerM: 0.1 } }),
      model({ id: 'vendor/m', ...base, pricing: { inputPerM: 0.5, outputPerM: 1.5 } }),
    ];
    const ranked = recommend({ task: 'generator', models: pool });
    expect(ranked[0]?.model.id).toBe('vendor/m');
    expect(ranked[1]?.reasons).toContain('routing variant, not a distinct model');
  });

  it("nudges a near-tie towards jevcode's own default generator", () => {
    const base = { provider: DEFAULT_PROVIDER_ID, supports: { tools: true, structuredOutput: true, reasoning: true }, contextLength: 1_310_720 };
    const shipped = model({ id: DEFAULT_MODEL, ...base, pricing: { inputPerM: 0.15, outputPerM: 0.5 } });
    // a hundredth of a cent cheaper, otherwise identical
    const cheaper = model({ id: 'vendor/cheaper-flash', ...base, pricing: { inputPerM: 0.065, outputPerM: 0.26 } });
    const ranked = recommend({ task: 'generator', models: [cheaper, shipped] });
    expect(ranked[0]?.model.id).toBe(DEFAULT_MODEL);
    expect(ranked[0]?.reasons).toContain("jevcode's default generator");
    // the nudge is generator-only: the decider default is a Jev model, which is not in any catalogue
    expect(recommend({ task: 'decider', models: [cheaper, shipped] })[0]?.model.id).toBe('vendor/cheaper-flash');
  });

  it('the nudge loses to a model with more capability', () => {
    const shipped = model({ id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER_ID, supports: { tools: true }, contextLength: 1_310_720, pricing: { inputPerM: 0.15, outputPerM: 0.5 } });
    const capable = model({ id: 'vendor/full', provider: DEFAULT_PROVIDER_ID, supports: { tools: true, structuredOutput: true, reasoning: true }, contextLength: 1_310_720, pricing: { inputPerM: 0.15, outputPerM: 0.5 } });
    expect(recommend({ task: 'generator', models: [shipped, capable] })[0]?.model.id).toBe('vendor/full');
  });

  it('an empty pool yields nothing rather than throwing', () => {
    expect(recommend({ task: 'generator', models: [] })).toEqual([]);
    expect(recommendOne({ task: 'generator', models: [] })).toBeNull();
  });
});
