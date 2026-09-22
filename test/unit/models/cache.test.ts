/** The disk cache: path resolution, a tolerant parse of an untrusted file, TTL and the write path. */
import { describe, expect, it } from 'vitest';
import {
  CACHE_TTL_MS,
  CACHE_VERSION,
  NULL_CACHE,
  cacheAgeMs,
  cacheFilePath,
  createModelCache,
  isFresh,
  modelsCacheDir,
  parseCacheFile,
  parseCachedModel,
  serialiseCacheEntry,
} from '../../../src/models/cache.js';
import type { CacheEntry } from '../../../src/models/types.js';
import { T0, entry, model } from './helpers.js';

const AT = new Date(T0).toISOString();

describe('cache paths', () => {
  it('defaults to ~/.jevcode/models', () => {
    expect(modelsCacheDir({}, '/home/u', '/work')).toBe('/home/u/.jevcode/models');
  });

  it('honours JEVCODE_HOME, resolved against cwd like the runs dir', () => {
    expect(modelsCacheDir({ JEVCODE_HOME: '/opt/jev' }, '/home/u', '/work')).toBe('/opt/jev/models');
    expect(modelsCacheDir({ JEVCODE_HOME: 'rel' }, '/home/u', '/work')).toBe('/work/rel/models');
    expect(modelsCacheDir({ JEVCODE_HOME: '   ' }, '/home/u', '/work')).toBe('/home/u/.jevcode/models');
  });

  it('one file per provider', () => {
    expect(cacheFilePath('/c', 'openrouter')).toBe('/c/openrouter.json');
  });
});

describe('parseCacheFile', () => {
  const good: CacheEntry = entry('openai', [model({ id: 'gpt-6-astra', provider: 'openai', contextLength: 10, pricing: { inputPerM: 1, outputPerM: 2 }, supports: { tools: true } })], { etag: 'W/"abc"' });

  it('round-trips what it writes', () => {
    expect(parseCacheFile(serialiseCacheEntry(good))).toEqual(good);
  });

  it('reads a missing, truncated or foreign file as a miss', () => {
    expect(parseCacheFile('')).toBeNull();
    expect(parseCacheFile('{"version":1,')).toBeNull();
    expect(parseCacheFile('[]')).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, version: 2 }))).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, provider: 'nope' }))).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, fetchedAt: '' }))).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, models: 'x' }))).toBeNull();
  });

  it('drops individual junk rows instead of the whole file', () => {
    const text = JSON.stringify({ version: CACHE_VERSION, provider: 'openai', fetchedAt: AT, etag: null, models: [{ id: 'ok', provider: 'openai', supports: {}, updatedAt: AT }, { id: '' }, null, 7, { id: 'other', provider: 'anthropic', supports: {}, updatedAt: AT }] });
    const parsed = parseCacheFile(text);
    expect(parsed?.models.map((m) => m.id)).toEqual(['ok']);
  });

  it('validates every field of a cached model', () => {
    expect(parseCachedModel({ id: 'm', provider: 'openai', supports: { tools: 'yes' }, contextLength: -5, maxOutput: 'x', pricing: { inputPerM: 'free', outputPerM: 1 }, updatedAt: AT })).toEqual({
      id: 'm',
      provider: 'openai',
      displayName: 'm',
      supports: {},
      updatedAt: AT,
    });
    expect(parseCachedModel({ id: 'm' })).toBeNull();
    expect(parseCachedModel('m')).toBeNull();
  });

  it('round-trips aliases, normalising junk out of the list', () => {
    const aliased = entry('xai', [model({ id: 'grok-4.20-0309-reasoning', provider: 'xai', aliases: ['grok-4.20', 'grok-4.20-reasoning'] })]);
    expect(parseCacheFile(serialiseCacheEntry(aliased))).toEqual(aliased);
    expect(parseCachedModel({ id: 'm', provider: 'xai', supports: {}, updatedAt: AT, aliases: ['a', 7, '', 'a', 'm'] })?.aliases).toEqual(['a']);
    expect('aliases' in (parseCachedModel({ id: 'm', provider: 'xai', supports: {}, updatedAt: AT, aliases: [] }) ?? {})).toBe(false);
    expect('aliases' in (parseCachedModel({ id: 'm', provider: 'xai', supports: {}, updatedAt: AT, aliases: 'a' }) ?? {})).toBe(false);
  });

  it('keeps a rate of exactly zero (free models are priced, not unpriced)', () => {
    const parsed = parseCachedModel({ id: 'm', provider: 'openrouter', supports: {}, updatedAt: AT, pricing: { inputPerM: 0, outputPerM: 0 } });
    expect(parsed?.pricing).toEqual({ inputPerM: 0, outputPerM: 0 });
  });
});

describe('freshness', () => {
  const e = entry('openai', []);

  it('is fresh inside the TTL and stale outside it', () => {
    expect(isFresh(e, T0)).toBe(true);
    expect(isFresh(e, T0 + CACHE_TTL_MS - 1)).toBe(true);
    expect(isFresh(e, T0 + CACHE_TTL_MS)).toBe(false);
    expect(isFresh(e, T0 + 1000, 500)).toBe(false);
  });

  it('an unparseable timestamp is never fresh', () => {
    expect(isFresh({ ...e, fetchedAt: 'yesterday' }, T0)).toBe(false);
    expect(cacheAgeMs({ ...e, fetchedAt: 'yesterday' }, T0)).toBeNull();
  });

  it('a timestamp in the future is never fresh either', () => {
    // a clock briefly set forward would otherwise pin the catalogue until the wall clock caught up
    expect(isFresh({ ...e, fetchedAt: '2099-01-01T00:00:00.000Z' }, T0)).toBe(false);
    expect(isFresh({ ...e, fetchedAt: new Date(T0 + 1).toISOString() }, T0)).toBe(false);
    expect(isFresh({ ...e, fetchedAt: new Date(T0).toISOString() }, T0)).toBe(true);
  });

  it('reports age', () => {
    expect(cacheAgeMs(e, T0 + 5000)).toBe(5000);
    expect(cacheAgeMs(e, T0 - 5000)).toBe(0);
  });
});

describe('createModelCache', () => {
  it('reads and writes through the injected file functions', async () => {
    const files = new Map<string, string>();
    const cache = createModelCache('/c', {
      readFile: async (p) => {
        const t = files.get(p);
        if (t === undefined) throw new Error('ENOENT');
        return t;
      },
      writeFile: async (p, text) => {
        files.set(p, text);
      },
    });
    expect(await cache.read('openai')).toBeNull();
    const e = entry('openai', [model({ id: 'gpt-6-astra', provider: 'openai' })]);
    await cache.write(e);
    expect(files.has('/c/openai.json')).toBe(true);
    expect(await cache.read('openai')).toEqual(e);
  });

  it('a file written for another provider is not served', async () => {
    const files = new Map<string, string>([['/c/openai.json', serialiseCacheEntry(entry('anthropic', []))]]);
    const cache = createModelCache('/c', { readFile: async (p) => files.get(p) ?? '', writeFile: async () => undefined });
    expect(await cache.read('openai')).toBeNull();
  });

  it('a failing write is swallowed', async () => {
    const cache = createModelCache('/c', {
      readFile: async () => {
        throw new Error('nope');
      },
      writeFile: async () => {
        throw new Error('EROFS');
      },
    });
    await expect(cache.write(entry('openai', []))).resolves.toBeUndefined();
  });

  it('NULL_CACHE stores nothing', async () => {
    await NULL_CACHE.write(entry('openai', [model({ id: 'x', provider: 'openai' })]));
    expect(await NULL_CACHE.read('openai')).toBeNull();
  });
});
