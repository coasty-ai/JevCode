/**
 * The picker contract: the exact sequence src/models/index.ts documents — paint the snapshot, load
 * behind the frame, rank on every keystroke, verify a pasted key, hand the choice to a run — driven
 * end to end against recorded list bodies.
 */
import { describe, expect, it } from 'vitest';
import * as models from '../../../src/models/index.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/config/defaults.js';
import { T0, entry, fixture, memoryCache, routedFetch, testDeps } from './helpers.js';

describe('the barrel', () => {
  it('exports everything a picker is documented to call', () => {
    for (const name of [
      'instantCatalogue',
      'listModels',
      'loadCatalogue',
      'loadCatalogueFromEnv',
      'rankModels',
      'searchModels',
      'recommend',
      'verifyProvider',
      'keysFromEnv',
      'keyEnvNames',
      'providerDisplayName',
      'providerSpec',
      'modelSummary',
      'sourceLabel',
      'errorLabel',
      'generatorPricingOf',
      'isGeneratorProvider',
      'createCatalogue',
      'defaultCatalogue',
      'catalogueFromEnv',
    ] as const) {
      expect(typeof models[name], name).toBe('function');
    }
    expect(models.PROVIDER_IDS).toHaveLength(7);
    expect(models.CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('the picker flow', () => {
  it('1. paints the snapshot with no I/O, 2. loads behind the frame, 3. ranks a keystroke', async () => {
    const f = routedFetch({
      'api.anthropic.com': { status: 200, body: fixture('anthropic-models.json') },
      'openrouter.ai': { status: 200, body: fixture('openrouter-models.json') },
    });
    const cache = memoryCache();
    const catalogue = models.createCatalogue(testDeps({ fetch: f.fetch, cache: cache.cache }));

    // 1. first frame
    const first = catalogue.instant();
    expect(first.length).toBeGreaterThan(20);
    expect(f.calls).toHaveLength(0);

    // 2. refresh
    const load = await catalogue.load({ providers: ['anthropic', 'openrouter'], keys: { anthropic: 'a', openrouter: 'r' } });
    expect(load.results.every((r) => r.source === 'network')).toBe(true);
    expect(models.catalogueSummary(load.results)).toContain('2 providers');
    expect(cache.writes.map((w) => w.provider).sort()).toEqual(['anthropic', 'openrouter']);

    // 3. keystrokes
    expect(models.rankModels('son', load.models)[0]?.model.id).toBe('claude-sonnet-5');
    expect(models.rankModels('glm', load.models)[0]?.model.id).toBe('z-ai/glm-5.3-flash');

    // 4. the row a picker prints
    const row = models.modelSummary(models.rankModels('glm', load.models)[0]?.model ?? first[0]!);
    expect(row).toContain('OpenRouter');
    expect(row).toContain('/M in');

    // 5. provenance
    expect(models.sourceLabel(load.results[0]!, T0)).toBe('live');
  });

  it('opens with a cached list and no network when one is fresh', async () => {
    const seeded = entry('openrouter', models.instantCatalogue(['openrouter']));
    const f = routedFetch({});
    const catalogue = models.createCatalogue(testDeps({ fetch: f.fetch, cache: memoryCache([seeded]).cache }));
    const load = await catalogue.load({ providers: ['openrouter'] });
    expect(f.calls).toHaveLength(0);
    expect(load.results[0]?.source).toBe('cache');
    expect(models.sourceLabel(load.results[0]!, T0)).toBe('cached just now');
  });

  it('degrades to the snapshot with an explanation when nothing works', async () => {
    const f = routedFetch({ 'api.openai.com': { status: 0, networkError: 'ENOTFOUND' } });
    const catalogue = models.createCatalogue(testDeps({ fetch: f.fetch }));
    const load = await catalogue.load({ providers: ['openai'], keys: { openai: 'k' } });
    const result = load.results[0]!;
    expect(result.source).toBe('static');
    expect(result.models.length).toBeGreaterThan(0);
    expect(models.errorLabel('openai', result.error!)).toBe('OpenAI: offline — showing the last list');
  });

  it('recommends, verifies and hands the choice to a generator config', async () => {
    const f = routedFetch({ 'openrouter.ai/api/v1/key': { status: 200, body: { data: { label: 'sk-or-v1-x...y' } } } });
    const catalogue = models.createCatalogue(testDeps({ fetch: f.fetch }));

    const top = catalogue.recommend({ task: 'generator', budget: 'balanced' })[0]!;
    expect(top.model.id).toBe(DEFAULT_MODEL);
    expect(top.model.provider).toBe(DEFAULT_PROVIDER);

    const check = await catalogue.verify({ provider: 'openrouter' }, 'sk-or-v1-key');
    expect(check.ok).toBe(true);

    expect(models.generatorPricingOf(top.model.pricing!)).toEqual({ inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05, cacheWritePerM: 0.15 * 1.25 });
    expect(models.isGeneratorProvider(top.model.provider)).toBe(true);
  });

  it('searches through the bound deps', async () => {
    const f = routedFetch({ 'api.anthropic.com': { status: 200, body: fixture('anthropic-models.json') } });
    const catalogue = models.createCatalogue(testDeps({ fetch: f.fetch }));
    const hits = await catalogue.search('fable', { providers: ['anthropic'], keys: { anthropic: 'k' } });
    expect(hits[0]?.model.id).toBe('claude-fable-5-1');
  });
});

describe('defaultCatalogue', () => {
  it('wires the disk cache and the snapshot pricing source without doing any I/O up front', () => {
    const catalogue = models.defaultCatalogue({ JEVCODE_HOME: '/tmp/jevcode-test-home' });
    expect(catalogue.deps.cache).not.toBeNull();
    expect(catalogue.deps.cache?.path('openai')).toBe('/tmp/jevcode-test-home/models/openai.json');
    expect(catalogue.deps.pricing?.lookup('anthropic', 'claude-sonnet-5')).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 });
  });

  it('leaves an explicitly disabled cache disabled', () => {
    const catalogue = models.defaultCatalogue({}, { cache: null });
    expect(catalogue.deps.cache).toBeNull();
  });

  it('prefers an injected pricing source over the snapshot', () => {
    const catalogue = models.defaultCatalogue({}, { pricing: { lookup: () => ({ inputPerM: 42, outputPerM: 42 }) } });
    expect(catalogue.deps.pricing?.lookup('anthropic', 'claude-sonnet-5')).toEqual({ inputPerM: 42, outputPerM: 42 });
  });

  it('catalogueFromEnv hands back the keys it found', () => {
    const { catalogue, keys } = models.catalogueFromEnv({ OPENROUTER_API_KEY: 'r', ANTHROPIC_API_KEY: 'a' });
    expect(keys).toEqual({ anthropic: 'a', openrouter: 'r' });
    expect(catalogue.instant(['openrouter']).length).toBeGreaterThan(0);
  });
});
