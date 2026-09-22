/** Offline doubles for src/models/*: recorded provider list bodies, a scripted fetch, an in-memory cache. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CacheEntry, JsonObject, ModelCache, ModelInfo, ModelsDeps, ProviderId } from '../../../src/models/types.js';
import { parseCacheFile, serialiseCacheEntry } from '../../../src/models/cache.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'fixtures', 'models');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function fixture(name: string): JsonObject {
  const parsed: unknown = JSON.parse(fixtureText(name));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`fixture ${name} is not a JSON object`);
  return parsed as JsonObject;
}

export interface Scripted {
  status: number;
  headers?: Record<string, string>;
  /** string body, or an object serialised for you */
  body?: string | JsonObject;
  /** reject the fetch itself */
  networkError?: string;
}

export interface FetchRecord {
  url: string;
  headers: Record<string, string>;
}

export interface ScriptedFetch {
  fetch: typeof fetch;
  calls: FetchRecord[];
}

/** A fetch that answers from a script and records every request URL and header. */
export function scriptedFetch(script: readonly Scripted[]): ScriptedFetch {
  const calls: FetchRecord[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const idx = calls.length;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw !== undefined) for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, headers });
    const r = script[idx];
    if (r === undefined) throw new Error(`scriptedFetch: no response scripted for call ${idx + 1}`);
    if (r.networkError !== undefined) throw new TypeError(r.networkError);
    const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    // 204/304 must not carry a body
    const withBody = r.status === 204 || r.status === 304 ? null : body;
    return new Response(withBody, { status: r.status, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

/**
 * A fetch that routes by URL substring instead of by call order — the only safe shape when several
 * providers are loaded in parallel. Each route's responses are consumed in order.
 */
export function routedFetch(routes: Readonly<Record<string, Scripted | readonly Scripted[]>>): ScriptedFetch {
  const queues = new Map<string, Scripted[]>();
  for (const [match, value] of Object.entries(routes)) queues.set(match, Array.isArray(value) ? [...value] : [value as Scripted]);
  const calls: FetchRecord[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw !== undefined) for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url, headers });
    const match = [...queues.keys()].find((m) => url.includes(m));
    if (match === undefined) throw new Error(`routedFetch: no route for ${url}`);
    const queue = queues.get(match) ?? [];
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r === undefined) throw new Error(`routedFetch: route ${match} is exhausted`);
    if (r.networkError !== undefined) throw new TypeError(r.networkError);
    const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const withBody = r.status === 204 || r.status === 304 ? null : body;
    return new Response(withBody, { status: r.status, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

export interface MemoryCache {
  cache: ModelCache;
  files: Map<string, string>;
  reads: ProviderId[];
  writes: CacheEntry[];
}

/** An in-memory `ModelCache` over the same serialisation the disk cache uses. */
export function memoryCache(seed: readonly CacheEntry[] = []): MemoryCache {
  const files = new Map<string, string>();
  const reads: ProviderId[] = [];
  const writes: CacheEntry[] = [];
  for (const entry of seed) files.set(entry.provider, serialiseCacheEntry(entry));
  const cache: ModelCache = {
    path: (provider) => `memory:${provider}.json`,
    read: async (provider) => {
      reads.push(provider);
      const text = files.get(provider);
      return text === undefined ? null : parseCacheFile(text);
    },
    write: async (entry) => {
      writes.push(entry);
      files.set(entry.provider, serialiseCacheEntry(entry));
    },
  };
  return { cache, files, reads, writes };
}

export const T0 = Date.parse('2026-09-21T12:00:00.000Z');

/** Deps with a frozen clock, no sleeping and no jitter. */
export function testDeps(over: ModelsDeps = {}): ModelsDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => T0,
    random: () => 0,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    redact: (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED:pattern]'),
    ...over,
    sleeps,
  };
}

/** A `ModelInfo` builder for the pure ranking / recommendation tests. */
export function model(over: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    provider: 'openrouter',
    displayName: over.id,
    supports: {},
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...over,
  };
}

export function entry(provider: ProviderId, models: readonly ModelInfo[], over: Partial<CacheEntry> = {}): CacheEntry {
  return { version: 1, provider, fetchedAt: new Date(T0).toISOString(), etag: null, models, ...over };
}
