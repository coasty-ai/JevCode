/** Ranking: the bands, the tie-breaks and the determinism a picker depends on. */
import { describe, expect, it } from 'vitest';
import { compareModels, filterModels, findModel, isRoutingVariant, isSubsequence, matchModel, nearMisses, normalise, rankModels, searchModels, variantRank } from '../../../src/models/search.js';
import { instantCatalogue } from '../../../src/models/list.js';
import { enrich } from '../../../src/models/static.js';
import { parseModelList } from '../../../src/models/parse.js';
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

  it('honours limit, clamping a negative one to empty like recommend does', () => {
    expect(rankModels('', POOL, { limit: 2 })).toHaveLength(2);
    expect(rankModels('', POOL, { limit: 0 })).toHaveLength(0);
    expect(rankModels('', POOL, { limit: -1 })).toHaveLength(0);
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

describe('routing variants', () => {
  const live = enrich('openrouter', parseModelList('openrouter', fixture('openrouter-models.json'), { updatedAt: '2026-09-21T12:00:00.000Z' }));

  it('recognises a :suffix route', () => {
    expect(isRoutingVariant('z-ai/glm-5.3-flash:free')).toBe(true);
    expect(isRoutingVariant('z-ai/glm-5.3-flash')).toBe(false);
    expect(variantRank(model({ id: 'a:batch' }))).toBe(1);
    expect(variantRank(model({ id: 'a' }))).toBe(0);
  });

  it('never lets a :free route top the opened picker, though it stays in the list', () => {
    // the recorded OpenRouter catalogue carries two :free rows, both priced at zero
    const free = live.filter((m) => isRoutingVariant(m.id));
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((m) => (m.pricing?.inputPerM ?? 1) === 0)).toBe(true);

    const opened = rankModels('', live);
    expect(isRoutingVariant(opened[0]?.model.id ?? '')).toBe(false);
    expect(opened.map((h) => h.model.id)).toEqual(expect.arrayContaining(free.map((m) => m.id)));

    // Within one (deprecated, tools) class every standard route ranks ahead of every variant.
    // Across classes it does not, and must not: deprecation and tool support are tie-breaks above
    // the variant rank, so a live tools-capable `:free` route correctly beats a deprecated model.
    const cls = (m: ModelInfo): string => `${m.deprecated === true ? 'dep' : 'live'}/${m.supports.tools === true ? 'tools' : 'no-tools'}`;
    const seenVariant = new Map<string, number>();
    opened.forEach((h, i) => {
      const key = cls(h.model);
      if (isRoutingVariant(h.model.id)) {
        if (!seenVariant.has(key)) seenVariant.set(key, i);
      } else {
        expect(seenVariant.get(key), `${h.model.id} ranked behind a variant of its own class`).toBeUndefined();
      }
    });
    expect([...seenVariant.keys()].length).toBeGreaterThan(0);
  });

  it('sorts a variant behind its own standard route even though it is cheaper', () => {
    const standard = model({ id: 'z-ai/glm-5.3-flash', pricing: { inputPerM: 0.15, outputPerM: 0.5 }, supports: { tools: true } });
    const free = model({ id: 'z-ai/glm-5.3-flash:free', pricing: { inputPerM: 0, outputPerM: 0 }, supports: { tools: true } });
    const batch = model({ id: 'z-ai/glm-5.3-flash:batch', pricing: { inputPerM: 0.075, outputPerM: 0.25 }, supports: { tools: true } });
    expect(compareModels(free, standard)).toBeGreaterThan(0);
    expect(compareModels(batch, standard)).toBeGreaterThan(0);
    // behind it, and among themselves the usual cheapest-first order resumes
    expect(ids(rankModels('', [free, batch, standard]))).toEqual(['z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash:free', 'z-ai/glm-5.3-flash:batch']);
  });

  it('a typed query still finds a variant — the closeness bonus outweighs the tie-break', () => {
    const standard = model({ id: 'z-ai/glm-5.3-flash', supports: { tools: true } });
    const free = model({ id: 'nex-agi/nex-n2.5-mini:free', supports: { tools: true } });
    expect(ids(rankModels('nexn25mini', [standard, free]))).toEqual(['nex-agi/nex-n2.5-mini:free']);
  });

  it('a capability filter over the live list is still variant-last', () => {
    const tools = rankModels('', live, { capability: 'tools' });
    expect(tools.length).toBeGreaterThan(0);
    expect(isRoutingVariant(tools[0]?.model.id ?? '')).toBe(false);
  });
});

describe('aliases', () => {
  const ALIASED: ModelInfo[] = [
    model({ id: 'grok-4.20-0309-reasoning', provider: 'xai', displayName: 'Grok 4.20 (reasoning)', aliases: ['grok-4.20', 'grok-4.20-reasoning'], supports: { tools: true } }),
    model({ id: 'grok-4.7', provider: 'xai', displayName: 'Grok 4.7', supports: { tools: true } }),
  ];

  it('findModel accepts a documented alias the provider accepts', () => {
    expect(findModel('grok-4.20', ALIASED)?.id).toBe('grok-4.20-0309-reasoning');
    expect(findModel(' grok-4.20-reasoning ', ALIASED)?.id).toBe('grok-4.20-0309-reasoning');
    expect(findModel('grok-4.7', ALIASED)?.id).toBe('grok-4.7');
    expect(findModel('grok-9', ALIASED)).toBeNull();
    expect(findModel('   ', ALIASED)).toBeNull();
  });

  it('a canonical id is never shadowed by another row that lists it as an alias', () => {
    const pool = [model({ id: 'a', aliases: ['b'] }), model({ id: 'b' })];
    expect(findModel('b', pool)?.id).toBe('b');
  });

  it('an alias is a search haystack', () => {
    expect(ids(rankModels('grok-4.20', ALIASED))).toEqual(['grok-4.20-0309-reasoning']);
    expect(rankModels('grok-4.20', ALIASED)[0]?.matched).toBe('exact');
  });

  it('nearMisses does not suggest the row the alias already resolves to', () => {
    // `grok-4.20` is not a near miss: findModel resolves it exactly, via the alias
    expect(nearMisses('grok-4.20', ALIASED, 2).map((m) => m.id)).toEqual([]);
    // a real typo still gets suggestions
    expect(nearMisses('grok47', ALIASED, 2).map((m) => m.id)).toEqual(['grok-4.7']);
  });

  it('the snapshot carries its aliases onto the models it produces', () => {
    const xai = instantCatalogue(['xai']);
    expect(xai.find((m) => m.id === 'grok-4.20-0309-reasoning')?.aliases).toEqual(['grok-4.20', 'grok-4.20-reasoning']);
    expect(findModel('grok-4.20', xai)?.id).toBe('grok-4.20-0309-reasoning');
    expect(findModel('gpt-5.6', instantCatalogue(['openai']))?.id).toBe('gpt-5.6-sol');
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
