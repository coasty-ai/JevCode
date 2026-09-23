/**
 * A generator config the caller did not price is priced from the catalogue's rate card by the registry: OpenAI, Meta and
 * Fireworks send no cost on the wire, and without a rate card a run under a spend cap refuses them. Found by the first live
 * smoke of all seven providers.
 */
import { describe, expect, it } from 'vitest';
import { withTablePricing } from '../../../src/provider/registry.js';
import { pricingFor } from '../../../src/provider/pricing.js';
import type { ProviderConfig } from '../../../src/provider/types.js';

const base = (model: string): ProviderConfig => ({ model, apiKey: 'k', baseUrl: 'https://example.invalid', temperature: null, maxTokens: 100, pricing: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }, priced: false } as unknown as ProviderConfig);

describe('withTablePricing', () => {
  it('prices an unpriced config from the table when the model is known, with the table\'s own rates', () => {
    const out = withTablePricing('openai', base('gpt-5.6-luna'));
    expect(out.priced).toBe(true);
    expect(out.pricing).toEqual(pricingFor('openai', 'gpt-5.6-luna'));
    expect(pricingFor('openai', 'gpt-5.6-luna')).not.toBeNull();
    for (const [p, m] of [['meta', 'muse-spark-1.3'], ['fireworks', 'accounts/fireworks/models/glm-5p3-flash'], ['xai', 'grok-4.7']] as const) expect(withTablePricing(p, base(m)).priced, `${p}/${m}`).toBe(true);
  });

  it('leaves a model the table does not know unpriced, so the refusal and --allow-unpriced keep their meaning', () => {
    const out = withTablePricing('openai', base('gpt-99-nowhere'));
    expect(out.priced).toBe(false);
  });

  it('never touches a config the caller priced itself', () => {
    const own = { ...base('gpt-5.6-luna'), priced: true, pricing: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 1 } } as ProviderConfig;
    expect(withTablePricing('openai', own)).toBe(own);
  });
});
