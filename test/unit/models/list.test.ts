/**
 * `listModels`: the network path, the cache path, the fallbacks, and the promise that it never
 * throws and never comes back empty.
 */
import { describe, expect, it } from 'vitest';
import { instantCatalogue, listModels, loadCatalogue, loadCatalogueFromEnv, toModelsError } from '../../../src/models/list.js';
import { CACHE_TTL_MS } from '../../../src/models/cache.js';
import { SNAPSHOT_AT } from '../../../src/models/static.js';
import { ProviderHttpError } from '../../../src/errors.js';
import { T0, entry, fixture, memoryCache, model, routedFetch, scriptedFetch, testDeps } from './helpers.js';
import type { Scripted } from './helpers.js';

const OK = { 'content-type': 'application/json' };

describe('listModels: network', () => {
  it('fetches, normalises, enriches, sorts and caches', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('anthropic-models.json'), headers: { ...OK, etag: 'W/"v1"' } }]);
    const cache = memoryCache();
    const res = await listModels('anthropic', 'sk-ant-test', testDeps({ fetch: f.fetch, cache: cache.cache }));

    expect(res.source).toBe('network');
    expect(res.stale).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.fetchedAt).toBe(new Date(T0).toISOString());
    expect(res.models.map((m) => m.id)).toEqual(['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-5']);
    // enriched from the snapshot: the wire has no prices
    expect(res.models.find((m) => m.id === 'claude-sonnet-5')?.pricing).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 });
    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0]?.etag).toBe('W/"v1"');
    expect(cache.writes[0]?.models).toHaveLength(4);
  });

  it('sends the provider auth headers and hits the documented URL', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('anthropic-models.json') }]);
    await listModels('anthropic', 'sk-ant-secret', testDeps({ fetch: f.fetch }));
    expect(f.calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(f.calls[0]?.headers['x-api-key']).toBe('sk-ant-secret');
    expect(f.calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('follows pagination', async () => {
    const f = scriptedFetch([
      { status: 200, body: fixture('anthropic-models-page1.json') },
      { status: 200, body: fixture('anthropic-models-page2.json') },
    ]);
    const res = await listModels('anthropic', 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.url).toContain('after_id=claude-sonnet-5');
    expect(res.models.map((m) => m.id)).toEqual(['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  });

  it('lists OpenRouter without a key (its catalogue endpoint is public)', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openrouter-models.json') }]);
    const res = await listModels('openrouter', null, testDeps({ fetch: f.fetch }));
    expect(res.source).toBe('network');
    expect(f.calls[0]?.headers['authorization']).toBeUndefined();
    expect(f.calls[0]?.headers['http-referer']).toContain('jevcode');
  });
});

describe('listModels: cache', () => {
  const cached = entry('openai', [model({ id: 'cached-model', provider: 'openai' })], { etag: 'W/"old"' });

  it('serves a fresh entry without touching the network', async () => {
    const f = scriptedFetch([]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: memoryCache([cached]).cache }));
    expect(f.calls).toHaveLength(0);
    expect(res.source).toBe('cache');
    expect(res.stale).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(['cached-model']);
  });

  it('refetches once the entry is older than the TTL', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const deps = testDeps({ fetch: f.fetch, cache: memoryCache([cached]).cache, now: () => T0 + CACHE_TTL_MS + 1 });
    const res = await listModels('openai', 'k', deps);
    expect(f.calls).toHaveLength(1);
    expect(res.source).toBe('network');
  });

  it('force refetches inside the TTL', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: memoryCache([cached]).cache }), { force: true });
    expect(f.calls).toHaveLength(1);
    expect(res.source).toBe('network');
  });

  it('revalidates with if-none-match and reuses the cached list on 304', async () => {
    const f = scriptedFetch([{ status: 304, headers: { etag: 'W/"old"' } }]);
    const cache = memoryCache([cached]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: cache.cache }), { force: true });
    expect(f.calls[0]?.headers['if-none-match']).toBe('W/"old"');
    expect(res.source).toBe('network');
    expect(res.models.map((m) => m.id)).toEqual(['cached-model']);
    // the TTL window restarts without a re-download
    expect(cache.writes[0]?.fetchedAt).toBe(new Date(T0).toISOString());
    expect(cache.writes[0]?.models).toEqual(cached.models);
  });

  it('never stores or serves an unfiltered list under the filtered key', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const cache = memoryCache([cached]);
    const all = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: cache.cache }), { includeNonChat: true });
    // the fresh cache entry is ignored (it holds the chat-filtered list) and the result is not written back
    expect(f.calls).toHaveLength(1);
    expect(all.models.length).toBe(22);
    expect(cache.writes).toHaveLength(0);
    expect(cache.reads).toEqual([]);
  });

  it('sends the validator on the first page only', async () => {
    const f = scriptedFetch([
      { status: 200, body: fixture('anthropic-models-page1.json') },
      { status: 200, body: fixture('anthropic-models-page2.json') },
    ]);
    const seeded = memoryCache([entry('anthropic', [model({ id: 'old', provider: 'anthropic' })], { etag: 'W/"a"', fetchedAt: new Date(T0 - CACHE_TTL_MS - 1).toISOString() })]);
    await listModels('anthropic', 'k', testDeps({ fetch: f.fetch, cache: seeded.cache }));
    expect(f.calls[0]?.headers['if-none-match']).toBe('W/"a"');
    expect(f.calls[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('an entry that lists no models reads as a miss, not as an empty catalogue', async () => {
    // parseCacheFile accepts `models: []`, and the 304 branch would otherwise rewrite it forward
    // with a fresh timestamp forever — so the module's "never empty" promise has to outrank it
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const empty = memoryCache([entry('openai', [], { etag: 'W/"empty"' })]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: empty.cache }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(res.source).toBe('network');
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('falls back to the snapshot rather than an empty cache entry when the network fails', async () => {
    const f = scriptedFetch([{ status: 0, networkError: 'ENOTFOUND' }]);
    const empty = memoryCache([entry('openai', [])]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: empty.cache }));
    expect(res.source).toBe('static');
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('honours a custom TTL', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: memoryCache([cached]).cache, now: () => T0 + 60_000 }), { ttlMs: 1000 });
    expect(res.source).toBe('network');
    expect(f.calls).toHaveLength(1);
  });
});

describe('listModels: fallbacks', () => {
  it('falls back to the snapshot when there is no key, without sending anything', async () => {
    const f = scriptedFetch([]);
    const res = await listModels('openai', null, testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(0);
    expect(res.source).toBe('static');
    expect(res.fetchedAt).toBe(SNAPSHOT_AT);
    expect(res.error).toEqual({ kind: 'no_key', status: null, message: 'openai: no API key', retryable: false });
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('falls back to a stale cache when the key is rejected', async () => {
    const f = scriptedFetch([{ status: 401, body: { error: { message: 'Incorrect API key provided: sk-inval****hape', type: 'invalid_request_error', code: 'invalid_api_key' } } }]);
    const stale = entry('openai', [model({ id: 'stale', provider: 'openai' })], { fetchedAt: new Date(T0 - CACHE_TTL_MS - 1).toISOString() });
    const res = await listModels('openai', 'sk-bad', testDeps({ fetch: f.fetch, cache: memoryCache([stale]).cache }));
    expect(res.source).toBe('cache');
    expect(res.models.map((m) => m.id)).toEqual(['stale']);
    expect(res.error?.kind).toBe('auth');
    expect(res.error?.status).toBe(401);
    expect(res.error?.message).toContain('Incorrect API key');
  });

  it('falls back to the snapshot on a transport failure, in one round trip', async () => {
    const f = scriptedFetch([{ status: 0, networkError: 'getaddrinfo ENOTFOUND api.openai.com' }]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(1);
    expect(res.source).toBe('static');
    expect(res.error?.kind).toBe('network');
    expect(res.error?.message).toContain('ENOTFOUND');
  });

  it('retries a 429 and succeeds', async () => {
    const f = scriptedFetch([
      { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'slow down' } } },
      { status: 200, body: fixture('openai-models.json') },
    ]);
    const deps = testDeps({ fetch: f.fetch });
    const res = await listModels('openai', 'k', deps);
    expect(f.calls).toHaveLength(2);
    expect(deps.sleeps).toEqual([1000]);
    expect(res.source).toBe('network');
  });

  it('gives up after the retry budget and falls back', async () => {
    const f = scriptedFetch([{ status: 503, body: 'overloaded' }, { status: 503, body: 'overloaded' }, { status: 503, body: 'overloaded' }]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(3);
    expect(res.source).toBe('static');
    expect(res.error?.kind).toBe('http');
    expect(res.error?.status).toBe(503);
  });

  it('treats a 200 that is not a list as invalid', async () => {
    const f = scriptedFetch([{ status: 200, body: '<html>nope</html>', headers: { 'content-type': 'text/html' } }]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch }));
    expect(res.source).toBe('static');
    expect(res.error?.kind).toBe('invalid');
  });

  it('treats an empty catalogue as invalid rather than replacing a good cache with nothing', async () => {
    const f = scriptedFetch([{ status: 200, body: { object: 'list', data: [] } }]);
    const cache = memoryCache([entry('openai', [model({ id: 'kept', provider: 'openai' })])]);
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: cache.cache }), { force: true });
    expect(res.models.map((m) => m.id)).toEqual(['kept']);
    expect(res.error?.kind).toBe('invalid');
    expect(cache.writes).toHaveLength(0);
  });

  it('offline never sends and prefers the cache', async () => {
    const f = scriptedFetch([]);
    const cached = entry('openai', [model({ id: 'cached', provider: 'openai' })], { fetchedAt: new Date(T0 - CACHE_TTL_MS * 10).toISOString() });
    const res = await listModels('openai', 'k', testDeps({ fetch: f.fetch, cache: memoryCache([cached]).cache }), { offline: true });
    expect(f.calls).toHaveLength(0);
    expect(res.source).toBe('cache');
    expect(res.error?.kind).toBe('network');

    const bare = await listModels('openai', 'k', testDeps({ fetch: f.fetch }), { offline: true });
    expect(bare.source).toBe('static');
  });

  it('stops paging when a provider keeps echoing the same cursor', async () => {
    // has_more: true with an unchanged last_id would otherwise cost the full MAX_PAGES round trips
    const stuck = { object: 'list', data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }], has_more: true, last_id: 'claude-sonnet-5' };
    const f = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 200, body: stuck })));
    const res = await listModels('anthropic', 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(2);
    expect(res.models.map((m) => m.id)).toEqual(['claude-sonnet-5']);
  });

  it('still follows a cursor that actually moves', async () => {
    const page = (id: string, next: string | null): Scripted => ({
      status: 200,
      body: { object: 'list', data: [{ id, display_name: id }], ...(next === null ? { has_more: false } : { has_more: true, last_id: next }) },
    });
    const f = scriptedFetch([page('claude-sonnet-5', 'claude-sonnet-5'), page('claude-opus-5', 'claude-opus-5'), page('claude-haiku-4-5', null)]);
    const res = await listModels('anthropic', 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(3);
    expect(res.models.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('rethrows the caller abort reason instead of swallowing it', async () => {
    const controller = new AbortController();
    const reason = new Error('picker closed');
    // what undici does: the request rejects once the linked signal fires
    const fetchImpl: typeof fetch = async () => {
      controller.abort(reason);
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    await expect(listModels('openai', 'k', testDeps({ fetch: fetchImpl }), { signal: controller.signal })).rejects.toBe(reason);
  });

  it('stops reading the body when the caller aborts after the headers arrive', async () => {
    // the picker's Esc: headers are in, the 8 MB body is still streaming. timedFetch's link to the
    // caller ends with the fetch promise, so the body read has to carry the signal itself.
    const controller = new AbortController();
    const reason = new Error('picker closed');
    let cancelled = false;
    let pushed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pushed++;
        if (pushed === 2) controller.abort(reason);
        c.enqueue(new TextEncoder().encode('{"data":[],'.padEnd(4096, ' ')));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    await expect(listModels('openai', 'k', testDeps({ fetch: fetchImpl }), { signal: controller.signal })).rejects.toBe(reason);
    expect(cancelled).toBe(true);
    // a handful of chunks, not the 8 MB cap
    expect(pushed).toBeLessThan(10);
  });
});

describe('loadCatalogue', () => {
  it('loads several providers in parallel and merges them', async () => {
    const f = routedFetch({
      'api.anthropic.com': { status: 200, body: fixture('anthropic-models.json') },
      'openrouter.ai': { status: 200, body: fixture('openrouter-models.json') },
    });
    const load = await loadCatalogue({ providers: ['anthropic', 'openrouter'], keys: { anthropic: 'a', openrouter: 'b' }, deps: testDeps({ fetch: f.fetch }) });
    expect(load.results.map((r) => r.provider)).toEqual(['anthropic', 'openrouter']);
    expect(load.results.every((r) => r.source === 'network')).toBe(true);
    expect(load.models.length).toBe(load.results.reduce((n, r) => n + r.models.length, 0));
    expect(new Set(load.models.map((m) => m.provider))).toEqual(new Set(['anthropic', 'openrouter']));
  });

  it('one failing provider does not empty the list', async () => {
    const f = routedFetch({
      'api.anthropic.com': { status: 500, body: 'boom' },
      'openrouter.ai': { status: 200, body: fixture('openrouter-models.json') },
    });
    const load = await loadCatalogue({ providers: ['anthropic', 'openrouter'], keys: { anthropic: 'a', openrouter: 'b' }, deps: testDeps({ fetch: f.fetch }) });
    const anthropic = load.results.find((r) => r.provider === 'anthropic');
    expect(anthropic?.source).toBe('static');
    expect(anthropic?.error?.kind).toBe('http');
    expect(load.models.some((m) => m.provider === 'openrouter')).toBe(true);
  });

  it('reads keys from the environment', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const load = await loadCatalogueFromEnv({ OPENAI_API_KEY: 'sk-env' }, { providers: ['openai'], deps: testDeps({ fetch: f.fetch }) });
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer sk-env');
    expect(load.results[0]?.source).toBe('network');
  });
});

describe('instantCatalogue', () => {
  it('is non-empty, sorted and needs no I/O', () => {
    const models = instantCatalogue();
    expect(models.length).toBeGreaterThan(20);
    expect(models.some((m) => m.id === 'z-ai/glm-5.3-flash')).toBe(true);
    const providers = [...new Set(models.map((m) => m.provider))];
    expect(providers.length).toBe(7);
  });

  it('can be narrowed to one provider', () => {
    expect(instantCatalogue(['anthropic']).every((m) => m.provider === 'anthropic')).toBe(true);
  });
});

describe('toModelsError', () => {
  it('classifies by status', () => {
    const at = (status: number): string => toModelsError(new ProviderHttpError('x', { status, retryable: false }), (s) => s).kind;
    expect(at(0)).toBe('network');
    expect(at(401)).toBe('auth');
    expect(at(403)).toBe('auth');
    expect(at(429)).toBe('rate_limit');
    expect(at(500)).toBe('http');
    expect(at(200)).toBe('invalid');
  });

  it('redacts a non-HTTP failure', () => {
    const e = toModelsError(new Error('boom with sk-or-v1-abcdef0123456789'), (s) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED:pattern]'));
    expect(e.message).toBe('boom with [REDACTED:pattern]');
    expect(e.kind).toBe('network');
  });
});
