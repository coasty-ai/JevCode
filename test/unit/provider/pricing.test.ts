/** provider/pricing.ts — the matcher, the long-context tiers, the unknown rows and the shape config/defaults.ts merges. */
import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, effectivePricing, isKnownPrice, priceRowFor, pricingEntries, pricingFor } from '../../../src/provider/pricing.js';
import { costFromPricing } from '../../../src/provider/sse.js';
import { PROVIDER_IDS } from '../../../src/provider/registry.js';

describe('the table', () => {
  it('every row names a registry provider, cites a dated source and is internally consistent', () => {
    for (const row of MODEL_PRICES) {
      expect(PROVIDER_IDS, row.model).toContain(row.provider);
      expect(row.source, row.model).toMatch(/20\d\d-\d\d-\d\d/);
      expect(row.model.length, row.model).toBeGreaterThan(0);
      if (!isKnownPrice(row)) continue;
      const pr = row.pricing;
      expect(pr.inputPerM, row.model).toBeGreaterThan(0);
      expect(pr.outputPerM, row.model).toBeGreaterThan(0);
      // a cached read is never dearer than a fresh read, and no rate is negative or absurd
      expect(pr.cacheReadPerM, row.model).toBeLessThanOrEqual(pr.inputPerM);
      expect(pr.cacheReadPerM, row.model).toBeGreaterThanOrEqual(0);
      expect(pr.cacheWritePerM, row.model).toBeGreaterThanOrEqual(0);
      expect(pr.outputPerM, row.model).toBeLessThan(1000);
      const long = row.longContext;
      if (long) {
        expect(long.thresholdInputTokens, row.model).toBeGreaterThan(0);
        // the long-context tier is the expensive one
        expect(long.pricing.inputPerM, row.model).toBeGreaterThanOrEqual(pr.inputPerM);
        expect(long.pricing.outputPerM, row.model).toBeGreaterThanOrEqual(pr.outputPerM);
      }
    }
  });

  it('has no duplicate (provider, model) rows', () => {
    const keys = MODEL_PRICES.map((r) => `${r.provider}\u0000${r.model.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('priceRowFor', () => {
  it('prefers the longest matching prefix so a family never borrows a sibling rate', () => {
    expect(pricingFor('openai', 'gpt-5.6-terra')).toEqual({ inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2, cacheWritePerM: 2 });
    expect(pricingFor('openai', 'gpt-5.6-luna')!.inputPerM).toBe(0.2);
    expect(pricingFor('openai', 'gpt-5.6')!.outputPerM).toBe(20);
    expect(pricingFor('openai', 'gpt-5.5-pro')!.outputPerM).toBe(180);
    expect(pricingFor('openai', 'gpt-5.5')!.outputPerM).toBe(30);
    expect(pricingFor('openai', 'gpt-5-mini')!.outputPerM).toBe(2);
    expect(pricingFor('openai', 'gpt-5')!.outputPerM).toBe(10);
    // dated snapshots inherit their family's rate
    expect(pricingFor('openai', 'gpt-5.4-mini-2026-03-17')).toEqual(pricingFor('openai', 'gpt-5.4-mini'));
  });

  it('is scoped by provider and returns null for a model nobody priced', () => {
    expect(pricingFor('gemini', 'gpt-5.6-terra')).toBeNull();
    expect(priceRowFor('openai', 'whisper-1')).toBeNull();
    expect(pricingFor('xai', 'grok-4.7')).toEqual({ inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5, cacheWritePerM: 2 });
  });

  it('prices the Meta muse-spark tiers from the live catalogue (read 2026-09-23) and keeps any other Meta id unknown', () => {
    expect(pricingFor('meta', 'muse-spark-1.3')).toEqual({ inputPerM: 1.25, outputPerM: 4.25, cacheReadPerM: 0.15, cacheWritePerM: 1.25 });
    expect(pricingFor('meta', 'muse-spark-1.3-contributor')).toEqual({ inputPerM: 0.1, outputPerM: 0.2, cacheReadPerM: 0.002, cacheWritePerM: 0.1 });
    const other = priceRowFor('meta', 'muse-nowhere')!;
    expect(isKnownPrice(other)).toBe(false);
    expect(pricingFor('meta', 'muse-nowhere')).toBeNull();
    expect(other.notes).toContain('priced: false');
  });

  it('marks unlisted Fireworks ids unknown while keeping the published ones', () => {
    expect(pricingFor('fireworks', 'accounts/fireworks/models/glm-5p3-flash')).toEqual({ inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.03, cacheWritePerM: 0.15 });
    expect(pricingFor('fireworks', 'accounts/fireworks/models/inkling')).toBeNull();
    expect(priceRowFor('fireworks', 'accounts/fireworks/models/inkling')!.notes).toContain('parameter-count bucket');
  });

  it('prices a bare Fireworks model name as the accounts/fireworks/models/ id the API serves it as (S6 live, `--model glm-5p3-flash`)', () => {
    expect(pricingFor('fireworks', 'glm-5p3-flash')).toEqual(pricingFor('fireworks', 'accounts/fireworks/models/glm-5p3-flash'));
    expect(pricingFor('fireworks', ' GLM-5p3-flash ')).toEqual(pricingFor('fireworks', 'accounts/fireworks/models/glm-5p3-flash'));
    // an unlisted bare name is still unknown (the parameter-count bucket), and no other provider borrows the prefix
    expect(pricingFor('fireworks', 'inkling')).toBeNull();
    expect(pricingFor('openrouter', 'glm-5p3-flash')).toBeNull();
  });
});

describe('effectivePricing', () => {
  it('switches to the long-context tier above the threshold', () => {
    const grok = priceRowFor('xai', 'grok-4.7')!;
    expect(effectivePricing(grok, 199_999)!.inputPerM).toBe(2);
    expect(effectivePricing(grok, 200_001)).toEqual({ inputPerM: 4, outputPerM: 12, cacheReadPerM: 1, cacheWritePerM: 4 });
    const pro = priceRowFor('gemini', 'gemini-2.5-pro')!;
    expect(effectivePricing(pro, 10)!.outputPerM).toBe(10);
    expect(effectivePricing(pro, 300_000)!.outputPerM).toBe(15);
    // a row without a tier keeps one price, and an unknown row has none at all
    const flash = priceRowFor('gemini', 'gemini-3.8-flash')!;
    expect(effectivePricing(flash, 900_000)).toEqual(effectivePricing(flash, 1));
    expect(effectivePricing(priceRowFor('meta', 'muse-spark-1.3')!, 1)!.inputPerM).toBe(1.25);
    expect(effectivePricing(priceRowFor('meta', 'muse-nowhere')!, 1)).toBeNull();
  });

  it('feeds costFromPricing directly, so a long prompt is billed at the tier that applies', () => {
    const grok = priceRowFor('xai', 'grok-4.7')!;
    const tokens = { input: 250_000, cacheRead: 0, cacheWrite: 0, output: 1000 };
    expect(costFromPricing(effectivePricing(grok, tokens.input)!, tokens)).toBeCloseTo((250_000 * 4 + 1000 * 12) / 1e6, 12);
  });
});

describe('pricingEntries', () => {
  it('returns lowercased [id, Pricing] pairs the config table can merge, and only for priced rows', () => {
    const entries = pricingEntries();
    const map = new Map(entries);
    expect(map.get('gpt-6-astra')).toEqual({ inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 10 });
    expect(map.get('gemini-3.8-flash')!.outputPerM).toBe(3.75);
    expect(map.get('z-ai/glm-5.3-flash')!.inputPerM).toBe(0.15);
    expect(map.has('muse-')).toBe(false);
    expect(entries.length).toBe(MODEL_PRICES.filter(isKnownPrice).length);
    for (const [id] of entries) expect(id).toBe(id.toLowerCase());
    // the returned objects are copies: mutating one must not poison the table
    map.get('gpt-6-astra')!.inputPerM = 999;
    expect(pricingFor('openai', 'gpt-6-astra')!.inputPerM).toBe(10);
  });
});
