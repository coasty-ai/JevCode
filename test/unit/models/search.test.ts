/** Ranking: the bands, the tie-breaks and the determinism a picker depends on. */
import { describe, expect, it } from 'vitest';
import { compareModels, filterModels, findModel, isSubsequence, matchModel, nearMisses, normalise, rankModels, searchModels } from '../../../src/models/search.js';
import { instantCatalogue } from '../../../src/models/list.js';
import type { ModelInfo } from '../../../src/models/types.js';
import { fixture, model, routedFetch, testDeps } from './helpers.js';

const POOL: ModelInfo[] = [
  model({ id: 'gpt-5', provider: 'openai', displayName: 'GPT-5', pricing: { inputPerM: 1.25, outputPerM: 10 }, supports: { tools: true, structuredOutput: true } }),
  model({ id: 'gpt-5-mini', provider: 'openai', displayName: 'GPT-5 mini', pricing: { inputPerM: 0.25, outputPerM: 2 }, supports: { tools: true } }),
  model({ id: 'gpt-6-astra', provider: 'openai', displayName: 'GPT-6 Astra', pricing: { inputPerM: 10, outputPerM: 50 }, supports: { tools: true, structuredOutput: true, reasoning: true, vision: true } }),
  model({ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5', pricing: { inputPerM: 2, outputPerM: 10 }, supports: { tools: true, vision: true } }),
  model({ id: 'z-ai/glm-5.3-flash', provider: 'openrouter', displayName: 'Z.ai: GLM 5.3 Flash', pricing: { inputPerM: 0.15, outputPerM: 0.5 }, supports: { tools: true, structuredOutput: true } }),
  model({ id: 'gpt-3.5-turbo', provider: 'openai', displayName: 'gpt-3.5-turbo', deprecated: true, pricing: { inputPerM: 0.5, outputPerM: 1.5 }, supports: { tools: true } }),
];

const ids = (hits: readonly { model: ModelInfo }[]): string[] => hits.map((h) => h.model.id);

describe('normalise / isSubsequence', () => {
  it('drops punctuation and case', () => {
    expect(normalise('GPT-5.6 Sol')).toBe('gpt56sol');
    expect(normalise('z-ai/glm-5.3-flash')).toBe('zaiglm53flash');
    expect(normalise('  ')).toBe('');
  });

  it('subsequence matching is in-order, not substring', () => {
    expect(isSubsequence('glm', 'zaiglm53flash')).toBe(true);
    expect(isSubsequence('gsh', 'zaiglm53flash')).toBe(true);
    expect(isSubsequence('mlg', 'zaiglm53flash')).toBe(false);
    expect(isSubsequence('', 'anything')).toBe(true);
  });
});

describe('rankModels', () => {
  it('an empty query returns everything in the deterministic default order', () => {
    const hits = rankModels('', POOL);
    expect(hits).toHaveLength(POOL.length);
    // cheapest first among tools-capable live models; the deprecated one last
    expect(ids(hits)).toEqual(['z-ai/glm-5.3-flash', 'gpt-5-mini', 'gpt-5', 'claude-sonnet-5', 'gpt-6-astra', 'gpt-3.5-turbo']);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it('exact beats prefix beats word beats fuzzy', () => {
    const hits = rankModels('gpt-5', POOL);
    expect(ids(hits)[0]).toBe('gpt-5');
    expect(hits[0]?.matched).toBe('exact');
    const mini = hits.find((h) => h.model.id === 'gpt-5-mini');
    expect(mini?.matched).toBe('prefix');
    expect((mini?.score ?? 0) < (hits[0]?.score ?? 0)).toBe(true);
  });

  it('prefers the closest id inside a band', () => {
    const hits = rankModels('gpt', POOL);
    expect(ids(hits).slice(0, 2)).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('matches a word inside a display name', () => {
    const hits = rankModels('sonnet', POOL);
    expect(ids(hits)).toEqual(['claude-sonnet-5']);
    expect(hits[0]?.matched).toBe('word');
  });

  it('matches a provider-qualified query against a bare id', () => {
    expect(ids(rankModels('openai/gpt-6-astra', POOL))).toEqual(['gpt-6-astra']);
    expect(ids(rankModels('anthropic claude', POOL))).toEqual(['claude-sonnet-5']);
  });

  it('treats the last path segment of a namespaced id as a prefix candidate', () => {
    const hits = rankModels('glm', POOL);
    expect(ids(hits)).toEqual(['z-ai/glm-5.3-flash']);
    expect(hits[0]?.matched).toBe('prefix');
  });

  it('falls back to a fuzzy subsequence', () => {
    const hits = rankModels('glmflash', POOL);
    expect(ids(hits)).toEqual(['z-ai/glm-5.3-flash']);
    expect(hits[0]?.matched).toBe('fuzzy');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(rankModels('zzzzqqq', POOL)).toEqual([]);
  });

  it('filters by provider and capability', () => {
    expect(ids(rankModels('', POOL, { providers: ['anthropic'] }))).toEqual(['claude-sonnet-5']);
    expect(ids(rankModels('', POOL, { capability: 'structuredOutput' }))).toEqual(['z-ai/glm-5.3-flash', 'gpt-5', 'gpt-6-astra']);
    expect(ids(rankModels('', POOL, { capability: ['structuredOutput', 'vision'] }))).toEqual(['gpt-6-astra']);
  });

  it('lists deprecated models last but can drop them', () => {
    expect(ids(rankModels('gpt', POOL))).toContain('gpt-3.5-turbo');
    expect(ids(rankModels('gpt', POOL)).at(-1)).toBe('gpt-3.5-turbo');
    expect(ids(rankModels('gpt', POOL, { includeDeprecated: false }))).not.toContain('gpt-3.5-turbo');
  });

  it('honours limit', () => {
    expect(rankModels('', POOL, { limit: 2 })).toHaveLength(2);
    expect(rankModels('', POOL, { limit: 0 })).toHaveLength(0);
  });

  it('is a stable total order regardless of input order', () => {
    const a = ids(rankModels('gpt', POOL));
    const b = ids(rankModels('gpt', [...POOL].reverse()));
    expect(a).toEqual(b);
  });

  it('ranks unpriced models after priced ones at the same score', () => {
    const pool = [model({ id: 'aa', supports: { tools: true } }), model({ id: 'ab', supports: { tools: true }, pricing: { inputPerM: 5, outputPerM: 5 } })];
    expect(ids(rankModels('', pool))).toEqual(['ab', 'aa']);
  });

  it('ranks tools-capable models before unknown-capability ones', () => {
    const pool = [model({ id: 'aa' }), model({ id: 'ab', supports: { tools: true } })];
    expect(ids(rankModels('', pool))).toEqual(['ab', 'aa']);
  });
});

describe('matchModel', () => {
  it('scores the empty query as a zero-score match', () => {
    expect(matchModel('', POOL[0] as ModelInfo)).toEqual({ kind: 'prefix', score: 0 });
  });

  it('is null when nothing matches', () => {
    expect(matchModel('qqq', POOL[0] as ModelInfo)).toBeNull();
  });
});

describe('filterModels / compareModels / findModel / nearMisses', () => {
  it('filterModels applies the same predicates without ranking', () => {
    expect(filterModels(POOL, { providers: ['openai'] }).map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-6-astra', 'gpt-3.5-turbo']);
  });

  it('compareModels is a usable sort comparator on its own', () => {
    const sorted = [...POOL].sort(compareModels).map((m) => m.id);
    expect(sorted[0]).toBe('z-ai/glm-5.3-flash');
    expect(sorted.at(-1)).toBe('gpt-3.5-turbo');
  });

  it('findModel is exact and trims', () => {
    expect(findModel(' gpt-5 ', POOL)?.id).toBe('gpt-5');
    expect(findModel('gpt5', POOL)).toBeNull();
  });

  it('nearMisses suggests ids for a typo', () => {
    expect(nearMisses('gpt5', POOL, 2).map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(nearMisses('gpt-5', POOL, 2).map((m) => m.id)).toEqual(['gpt-5-mini', 'gpt-3.5-turbo']);
    expect(nearMisses('', POOL)).toEqual([]);
  });
});

describe('searchModels', () => {
  it('ranks a caller-supplied list without any I/O', async () => {
    const hits = await searchModels('astra', { models: POOL });
    expect(ids(hits)).toEqual(['gpt-6-astra']);
  });

  it('loads the requested providers when given none', async () => {
    const f = routedFetch({ 'api.anthropic.com': { status: 200, body: fixture('anthropic-models.json') } });
    const hits = await searchModels('haiku', { providers: ['anthropic'], keys: { anthropic: 'k' }, deps: testDeps({ fetch: f.fetch }) });
    expect(ids(hits)).toEqual(['claude-haiku-4-5-20251001']);
  });

  it('works offline against the bundled snapshot', async () => {
    const hits = await searchModels('glm', { providers: ['openrouter'], offline: true, deps: testDeps({ fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch }) });
    expect(ids(hits)).toContain('z-ai/glm-5.3-flash');
  });
});

describe('ranking over the bundled snapshot', () => {
  const all = instantCatalogue();

  it('finds the default generator by a partial id', () => {
    expect(ids(rankModels('glm-5.3-flash', all)).slice(0, 2)).toContain('z-ai/glm-5.3-flash');
  });

  it('finds Claude models by family name', () => {
    const hits = rankModels('opus', all, { limit: 3 });
    expect(hits.every((h) => h.model.id.includes('opus'))).toBe(true);
  });

  it('a capability filter never returns a model without the flag', () => {
    for (const hit of rankModels('', all, { capability: 'reasoning' })) expect(hit.model.supports.reasoning).toBe(true);
  });
});
