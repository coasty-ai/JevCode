/** Price maths, the bridge to the engine's four-rate pricing, and the strings a picker prints. */
import { describe, expect, it } from 'vitest';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR } from '../../../src/config/defaults.js';
import { BLENDED_INPUT_SHARE, blendedPerM, estimateCostUsd, findPricingByModelId, formatPricing, formatRate, formatTokens, generatorPricingOf, mergePricingSources, modelBlendedPerM, snapshotPricingSource } from '../../../src/models/pricing.js';
import { model } from './helpers.js';

describe('blendedPerM', () => {
  it('weights input 80 / output 20 so prompt-heavy agent turns order correctly', () => {
    expect(BLENDED_INPUT_SHARE).toBe(0.8);
    expect(blendedPerM({ inputPerM: 1, outputPerM: 6 })).toBeCloseTo(2, 10);
    expect(blendedPerM(undefined)).toBeNull();
    expect(modelBlendedPerM(model({ id: 'x' }))).toBeNull();
  });

  it('a cheap-input, expensive-output model does not look free', () => {
    const cheapIn = blendedPerM({ inputPerM: 0.1, outputPerM: 30 }) ?? 0;
    const flat = blendedPerM({ inputPerM: 2, outputPerM: 6 }) ?? 0;
    expect(cheapIn).toBeGreaterThan(flat);
  });
});

describe('generatorPricingOf', () => {
  it('derives the two rates the engine needs and no list publishes', () => {
    expect(generatorPricingOf({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 })).toEqual({
      inputPerM: 2,
      outputPerM: 10,
      cacheReadPerM: 0.2,
      cacheWritePerM: 2 * CACHE_WRITE_FACTOR,
    });
  });

  it('falls back to the config/defaults.ts factor when no cache-read rate is published', () => {
    expect(generatorPricingOf({ inputPerM: 3, outputPerM: 9 })).toEqual({
      inputPerM: 3,
      outputPerM: 9,
      cacheReadPerM: 3 * CACHE_READ_FACTOR,
      cacheWritePerM: 3 * CACHE_WRITE_FACTOR,
    });
  });
});

describe('estimateCostUsd', () => {
  it('bills uncached input, cache reads and output separately', () => {
    const cost = estimateCostUsd({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 }, { input: 1_000_000, cacheRead: 1_000_000, output: 100_000 });
    expect(cost).toBeCloseTo(2 + 0.2 + 1, 10);
  });

  it('missing counts are zero', () => {
    expect(estimateCostUsd({ inputPerM: 5, outputPerM: 5 }, {})).toBe(0);
  });
});

describe('formatting', () => {
  it('formats rates like money', () => {
    expect(formatRate(0)).toBe('$0');
    expect(formatRate(0.002)).toBe('$0.002');
    expect(formatRate(0.006)).toBe('$0.006');
    expect(formatRate(0.05)).toBe('$0.05');
    expect(formatRate(0.1)).toBe('$0.10');
    expect(formatRate(0.5)).toBe('$0.50');
    expect(formatRate(1.25)).toBe('$1.25');
    expect(formatRate(2)).toBe('$2');
    expect(formatRate(2.5)).toBe('$2.50');
    expect(formatRate(180)).toBe('$180');
    expect(formatRate(-1)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('formats a pricing record, cache rate included only when published', () => {
    expect(formatPricing({ inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05 })).toBe('$0.15/M in · $0.50/M out · $0.05/M cached');
    expect(formatPricing({ inputPerM: 30, outputPerM: 180 })).toBe('$30/M in · $180/M out');
    expect(formatPricing(undefined)).toBe('unpriced');
  });

  it('formats token counts for a narrow column', () => {
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(0)).toBe('—');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(65_536)).toBe('66k');
    expect(formatTokens(262_144)).toBe('262k');
    expect(formatTokens(1_048_576)).toBe('1.0M');
    expect(formatTokens(1_310_720)).toBe('1.3M');
    expect(formatTokens(10_000_000)).toBe('10M');
  });
});

describe('pricing sources', () => {
  it('the snapshot source resolves exact ids, aliases and dated variants', () => {
    const source = snapshotPricingSource();
    expect(source.lookup('anthropic', 'claude-sonnet-5')).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 });
    expect(source.lookup('anthropic', 'claude-haiku-4-5-20251001')).toEqual({ inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 });
    expect(source.lookup('openai', 'gpt-5.6')).toEqual({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 });
    expect(source.lookup('openai', 'nope')).toBeNull();
  });

  it('merge takes the first hit and ignores absent sources', () => {
    const first = { lookup: (): null => null };
    const second = { lookup: (): { inputPerM: number; outputPerM: number } => ({ inputPerM: 7, outputPerM: 7 }) };
    expect(mergePricingSources(undefined, first, null, second).lookup('openai', 'x')).toEqual({ inputPerM: 7, outputPerM: 7 });
    expect(mergePricingSources().lookup('openai', 'x')).toBeNull();
  });

  it('finds a price from an id alone', () => {
    expect(findPricingByModelId('claude-opus-5')).toEqual({ provider: 'anthropic', pricing: { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 } });
    expect(findPricingByModelId('z-ai/glm-5.3-flash')?.provider).toBe('openrouter');
    expect(findPricingByModelId('not-a-model')).toBeNull();
  });

  it("never hands out the snapshot's own objects", () => {
    const p = snapshotPricingSource().lookup('anthropic', 'claude-sonnet-5');
    if (p !== null) p.inputPerM = 999;
    expect(snapshotPricingSource().lookup('anthropic', 'claude-sonnet-5')?.inputPerM).toBe(2);
  });
});
