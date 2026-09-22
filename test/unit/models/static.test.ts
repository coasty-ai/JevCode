/** The bundled snapshot and the metadata overlay it provides for the live lists. */
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../../../src/models/providers.js';
import { allStaticModels, enrich, fireworksBucketPricing, isDatedVariant, resolveStatic, SNAPSHOT, SNAPSHOT_AT, SNAPSHOT_DATE, snapshotSize, staticModels } from '../../../src/models/static.js';
import { parseModelList } from '../../../src/models/parse.js';
import { blendedPerM } from '../../../src/models/pricing.js';
import type { ModelInfo } from '../../../src/models/types.js';
import { fixture, model } from './helpers.js';

describe('snapshot', () => {
  it('parses into ModelInfo for every provider and stays small', () => {
    for (const provider of PROVIDER_IDS) {
      const models = staticModels(provider);
      expect(models.length, provider).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.provider).toBe(provider);
        expect(m.id.trim()).not.toBe('');
        expect(m.displayName.trim()).not.toBe('');
        expect(m.updatedAt).toBe(SNAPSHOT_AT);
        if (m.pricing !== undefined) {
          expect(m.pricing.inputPerM).toBeGreaterThanOrEqual(0);
          expect(m.pricing.outputPerM).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // "small": a hand-maintained table, not a mirror of 443 OpenRouter rows
    expect(snapshotSize()).toBeLessThanOrEqual(100);
    expect(allStaticModels()).toHaveLength(snapshotSize());
  });

  it('has no duplicate ids inside a provider and no id that is also an alias', () => {
    for (const provider of PROVIDER_IDS) {
      const rows = SNAPSHOT[provider];
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size, provider).toBe(ids.length);
      const aliases = rows.flatMap((r) => r.aliases ?? []);
      expect(new Set(aliases).size).toBe(aliases.length);
      for (const alias of aliases) expect(ids).not.toContain(alias);
    }
  });

  it('records the date it was taken', () => {
    expect(SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SNAPSHOT_AT.startsWith(SNAPSHOT_DATE)).toBe(true);
  });

  it('prices the default generator from config/defaults.ts', () => {
    const glm = resolveStatic('openrouter', 'z-ai/glm-5.3-flash');
    expect(glm?.pricing).toEqual({ inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05 });
  });
});

describe('resolveStatic', () => {
  it('matches an exact id', () => {
    expect(resolveStatic('anthropic', 'claude-sonnet-5')?.displayName).toBe('Claude Sonnet 5');
  });

  it('matches an alias', () => {
    expect(resolveStatic('openai', 'gpt-5.6')?.id).toBe('gpt-5.6-sol');
    expect(resolveStatic('xai', 'grok-4.20')?.id).toBe('grok-4.20-0309-reasoning');
  });

  it('matches a dated snapshot of a known id', () => {
    expect(resolveStatic('anthropic', 'claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
    expect(resolveStatic('openai', 'gpt-5.5-2026-04-23')?.id).toBe('gpt-5.5');
    expect(resolveStatic('openrouter', 'z-ai/glm-5.3-flash-20260826')?.id).toBe('z-ai/glm-5.3-flash');
    expect(resolveStatic('openai', 'gpt-5.4-latest')?.id).toBe('gpt-5.4');
  });

  it('never lets a family member inherit a sibling price', () => {
    // `gpt-5` is a prefix of `gpt-5-nano`, which is a different model at a different price
    expect(resolveStatic('openai', 'gpt-5-nano')).toBeNull();
    expect(resolveStatic('openai', 'gpt-5-pro')).toBeNull();
    expect(resolveStatic('anthropic', 'claude-opus-4-5-20251101')).toBeNull();
    expect(isDatedVariant('gpt-5', 'gpt-5-nano')).toBe(false);
    expect(isDatedVariant('gpt-5', 'gpt-5-20260101')).toBe(true);
    expect(isDatedVariant('gpt-5', 'gpt-5')).toBe(false);
  });

  it('is empty-safe', () => {
    expect(resolveStatic('openai', '')).toBeNull();
    expect(resolveStatic('openai', '   ')).toBeNull();
  });
});

describe('enrich', () => {
  it('fills what the OpenAI list omits and keeps what the wire said', () => {
    const live = parseModelList('openai', fixture('openai-models.json'), { updatedAt: '2026-09-21T12:00:00.000Z' });
    const enriched = enrich('openai', live);
    const astra = enriched.find((m) => m.id === 'gpt-6-astra');
    expect(astra).toMatchObject({
      displayName: 'GPT-6 Astra',
      contextLength: 1_050_000,
      maxOutput: 128_000,
      pricing: { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
      supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    });
    // a dated id inherits its base row
    expect(enriched.find((m) => m.id === 'gpt-5.4-2026-03-05')?.pricing).toEqual({ inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 });
    // an id the snapshot does not know stays bare rather than guessing
    expect(enriched.find((m) => m.id === 'chat-latest')?.pricing).toBeUndefined();
  });

  it('never overwrites a live value', () => {
    const live: ModelInfo[] = [model({ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Live Name', contextLength: 123, supports: { tools: false } })];
    const [out] = enrich('anthropic', live);
    expect(out?.displayName).toBe('Live Name');
    expect(out?.contextLength).toBe(123);
    expect(out?.supports.tools).toBe(false);
    expect(out?.supports.vision).toBe(true); // absent on the wire, filled from the snapshot
  });

  it('or-s deprecation and never un-deprecates', () => {
    const live: ModelInfo[] = [model({ id: 'claude-sonnet-5', provider: 'anthropic', deprecated: true })];
    expect(enrich('anthropic', live)[0]?.deprecated).toBe(true);
  });

  it('uses the injected pricing source before the Fireworks bucket fallback', () => {
    const live: ModelInfo[] = [model({ id: 'accounts/fireworks/models/mystery-8b', provider: 'fireworks' })];
    expect(enrich('fireworks', live)[0]?.pricing).toEqual({ inputPerM: 0.2, outputPerM: 0.2 });
    const external = enrich('fireworks', live, () => ({ inputPerM: 9, outputPerM: 9 }));
    expect(external[0]?.pricing).toEqual({ inputPerM: 9, outputPerM: 9 });
  });

  it('does not mutate the snapshot rows it copies from', () => {
    const live: ModelInfo[] = [model({ id: 'claude-sonnet-5', provider: 'anthropic' })];
    const out = enrich('anthropic', live)[0];
    expect(out?.pricing).toBeDefined();
    if (out?.pricing !== undefined) out.pricing.inputPerM = 999;
    expect(resolveStatic('anthropic', 'claude-sonnet-5')?.pricing?.inputPerM).toBe(2);
  });
});

describe('fireworksBucketPricing', () => {
  it('buckets by the parameter count in the id', () => {
    expect(fireworksBucketPricing('accounts/fireworks/models/tiny-3b')).toEqual({ inputPerM: 0.1, outputPerM: 0.1 });
    expect(fireworksBucketPricing('accounts/fireworks/models/qwen3-embedding-8b')).toEqual({ inputPerM: 0.2, outputPerM: 0.2 });
    expect(fireworksBucketPricing('accounts/fireworks/models/gpt-oss-120b')).toEqual({ inputPerM: 0.9, outputPerM: 0.9 });
    expect(fireworksBucketPricing('accounts/fireworks/models/muse-glimmer-30b')).toEqual({ inputPerM: 0.9, outputPerM: 0.9 });
  });

  it('declines to guess without a parameter count', () => {
    expect(fireworksBucketPricing('accounts/fireworks/models/kimi-k3')).toBeNull();
    expect(fireworksBucketPricing('accounts/fireworks/models/glm-5p3-flash')).toBeNull();
  });
});

describe('snapshot sanity', () => {
  it('every priced model has a plausible blended rate', () => {
    for (const m of allStaticModels()) {
      const blended = blendedPerM(m.pricing);
      if (blended === null) continue;
      expect(blended, m.id).toBeGreaterThanOrEqual(0);
      expect(blended, m.id).toBeLessThan(100);
    }
  });

  it('cache reads are never more expensive than fresh input', () => {
    for (const m of allStaticModels()) {
      if (m.pricing?.cacheReadPerM === undefined) continue;
      expect(m.pricing.cacheReadPerM, m.id).toBeLessThanOrEqual(m.pricing.inputPerM);
    }
  });
});
