/**
 * `listModels` — one provider's catalogue, from the network when it can, from disk or the bundled
 * snapshot when it cannot, and never by throwing.
 *
 * Order of preference:
 *   1. a fresh cache entry (< TTL) unless `force`
 *   2. the network (ETag-revalidated when the cache had one; paged where the provider pages)
 *   3. any cache entry, however old            → `source: 'cache'`, `error` explains why
 *   4. the bundled snapshot                    → `source: 'static'`, `error` explains why
 *
 * Retry policy differs from the generator clients on purpose: 429 and 5xx are retried (withRetry,
 * 3 attempts, Retry-After honoured), but a transport failure is *not* — with a cache and a snapshot
 * behind it, a dead network should fall back in one round trip instead of three timeouts.
 */
import { ProviderHttpError } from '../errors.js';
import { httpError, parseJsonObject, readBodyCapped, withRetry } from '../provider/sse.js';
import { CATALOGUE_TIMEOUT_MS, ERROR_BODY_CAP, timedFetch } from './http.js';
import { sleep as defaultSleep } from '../core/time.js';
import { CACHE_TTL_MS, NULL_CACHE, defaultModelCache, isFresh } from './cache.js';
import { authHeaders, keysFromEnv, listUrl, PROVIDER_IDS } from './providers.js';
import { nextPageQuery, parseModelList, sortModels } from './parse.js';
import { allStaticModels, SNAPSHOT_AT, enrich, staticModels } from './static.js';
import type { CacheEntry, ListOptions, ListResult, ListSource, ModelCache, ModelInfo, ModelPricing, ModelsDeps, ModelsError, ProviderId } from './types.js';

/** Largest list body accepted; the biggest seen live is OpenRouter's ~730 KB for 443 models. */
export const MAX_LIST_BYTES = 8 * 1024 * 1024;
/** Guard against a provider paging forever (Anthropic and Gemini page; nobody needs more than this). */
export const MAX_PAGES = 10;

interface ResolvedDeps {
  fetch: typeof fetch;
  redact: (s: string) => string;
  now: () => number;
  cache: ModelCache;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  lookupPricing: ((provider: ProviderId, id: string) => ModelPricing | null) | undefined;
}

/**
 * Defaults for the injected side effects. `cache` defaults to *no* cache: touching the real home
 * directory is an explicit choice made by `defaultCatalogue()` (index.ts), never a surprise in a
 * unit test or a one-shot CLI read.
 */
function resolve(deps: ModelsDeps): ResolvedDeps {
  const pricing = deps.pricing;
  return {
    fetch: deps.fetch ?? globalThis.fetch,
    redact: deps.redact ?? ((s: string) => s),
    now: deps.now ?? Date.now,
    cache: deps.cache ?? NULL_CACHE,
    random: deps.random ?? Math.random,
    sleep: deps.sleep ?? defaultSleep,
    lookupPricing: pricing === undefined ? undefined : (provider, id) => pricing.lookup(provider, id),
  };
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

function kindOfStatus(status: number): ModelsError['kind'] {
  if (status === 0) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 200 && status < 300) return 'invalid';
  return 'http';
}

/** Any thrown value → the plain `ModelsError` a picker renders. Messages are already redacted. */
export function toModelsError(e: unknown, redact: (s: string) => string): ModelsError {
  if (e instanceof ProviderHttpError) {
    return { kind: kindOfStatus(e.status), status: e.status === 0 ? null : e.status, message: e.message, retryable: e.retryable };
  }
  const text = e instanceof Error ? e.message : String(e);
  return { kind: 'network', status: null, message: redact(text).slice(0, 512), retryable: true };
}

/** No key, nothing sent. */
function noKeyError(provider: ProviderId): ModelsError {
  return { kind: 'no_key', status: null, message: `${provider}: no API key`, retryable: false };
}

// ---------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------

function isoOf(ms: number): string {
  const at = new Date(ms);
  return Number.isFinite(at.getTime()) ? at.toISOString() : new Date(0).toISOString();
}

export interface FetchedPage {
  models: ModelInfo[];
  /** the response ETag, for the next revalidation */
  etag: string | null;
  /** the server answered 304: `models` is empty and the cached list still stands */
  notModified: boolean;
}

/**
 * One provider's whole catalogue over the wire (following its pagination), normalised but not yet
 * enriched. Throws `ProviderHttpError` — the caller decides whether to fall back.
 */
export async function fetchProviderModels(provider: ProviderId, apiKey: string | null, deps: ModelsDeps = {}, opts: ListOptions & { etag?: string | null; baseUrl?: string } = {}): Promise<FetchedPage> {
  const d = resolve(deps);
  const updatedAt = isoOf(d.now());
  const baseHeaders = authHeaders(provider, apiKey);
  const timeoutMs = CATALOGUE_TIMEOUT_MS;
  const models: ModelInfo[] = [];
  let etag: string | null = null;
  let query: Record<string, string> = {};

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = listUrl(provider, opts.baseUrl, query);
    // revalidation is a property of the whole list, so the validator rides the first page only:
    // a 304 on page 2 would otherwise discard the pages already read
    const headers = page === 0 && opts.etag !== undefined && opts.etag !== null && opts.etag !== '' ? { ...baseHeaders, 'if-none-match': opts.etag } : baseHeaders;
    const res = await withRetry({ sleep: d.sleep, random: d.random }, opts.signal ?? new AbortController().signal, async () => {
      const r = await timedFetch({ fetch: d.fetch, url, headers, timeoutMs, signal: opts.signal, redact: d.redact });
      if (r.status === 304) return r;
      if (!r.ok) {
        const body = await readBodyCapped(r, ERROR_BODY_CAP, timeoutMs);
        const parsed = parseJsonObject(body);
        const errObj = parsed === null ? null : parsed['error'];
        const message = typeof errObj === 'object' && errObj !== null && !Array.isArray(errObj) && typeof errObj['message'] === 'string' ? errObj['message'] : undefined;
        throw httpError({ provider, status: r.status, headers: r.headers, body, redact: d.redact, kind: 'models', ...(message === undefined ? {} : { message }) });
      }
      return r;
    });

    if (page === 0) etag = res.headers.get('etag');
    if (res.status === 304) return { models: [], etag, notModified: true };

    const text = await readBodyCapped(res, MAX_LIST_BYTES, timeoutMs);
    const body = parseJsonObject(text);
    if (body === null) {
      throw new ProviderHttpError(`${provider} models: response was not a JSON object (${text.length} bytes)`, { status: res.status, retryable: false });
    }
    const parseOpts = opts.includeNonChat === true ? { updatedAt, includeNonChat: true } : { updatedAt };
    models.push(...parseModelList(provider, body, parseOpts));
    const next = nextPageQuery(provider, body);
    if (next === null) break;
    query = next;
  }
  return { models, etag, notModified: false };
}

// ---------------------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------------------

function result(provider: ProviderId, models: readonly ModelInfo[], source: ListSource, fetchedAt: string, error?: ModelsError): ListResult {
  const r: ListResult = { provider, models, source, fetchedAt, stale: source !== 'network' };
  if (error !== undefined) r.error = error;
  return r;
}

function fromCache(provider: ProviderId, entry: CacheEntry, source: ListSource, error?: ModelsError): ListResult {
  return result(provider, entry.models, source, entry.fetchedAt, error);
}

function fromStatic(provider: ProviderId, error?: ModelsError): ListResult {
  return result(provider, sortModels(staticModels(provider)), 'static', SNAPSHOT_AT, error);
}

/**
 * OpenRouter's list endpoint answers unauthenticated (verified live), so a missing key is not a
 * reason to skip the network there. Every other provider 401s, and that round trip is pointless.
 */
function listNeedsKey(provider: ProviderId): boolean {
  return provider !== 'openrouter';
}

/**
 * One provider's catalogue. Never throws and never returns an empty list for a known provider: the
 * bundled snapshot is always behind it.
 *
 * `apiKey` may be null (no key configured). `deps.cache` is the disk cache — absent means "do not
 * cache" (see `defaultCatalogue` for the wired-up production path).
 */
export async function listModels(provider: ProviderId, apiKey: string | null, deps: ModelsDeps = {}, opts: ListOptions = {}): Promise<ListResult> {
  const d = resolve(deps);
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  // the cache file is keyed by provider alone: an unfiltered list must not be stored or served
  // under the same key as the chat-filtered one the picker asks for
  const cache = opts.includeNonChat === true ? NULL_CACHE : d.cache;
  const cached = await cache.read(provider);

  if (cached !== null && opts.force !== true && opts.offline !== true && isFresh(cached, d.now(), ttl)) {
    return fromCache(provider, cached, 'cache');
  }
  if (opts.offline === true) {
    const error: ModelsError = { kind: 'network', status: null, message: `${provider}: offline`, retryable: true };
    return cached !== null ? fromCache(provider, cached, 'cache', error) : fromStatic(provider, error);
  }
  const key = apiKey?.trim() ?? '';
  if (key === '' && listNeedsKey(provider)) {
    const error = noKeyError(provider);
    return cached !== null ? fromCache(provider, cached, 'cache', error) : fromStatic(provider, error);
  }

  try {
    const fetched = await fetchProviderModels(provider, key === '' ? null : key, deps, { ...opts, etag: cached?.etag ?? null });
    const fetchedAt = isoOf(d.now());
    if (fetched.notModified && cached !== null) {
      // revalidated: same models, new timestamp, so the TTL window restarts without a re-download
      const entry: CacheEntry = { version: 1, provider, fetchedAt, etag: fetched.etag ?? cached.etag, models: cached.models };
      await cache.write(entry);
      return result(provider, cached.models, 'network', fetchedAt);
    }
    const models = sortModels(enrich(provider, fetched.models, d.lookupPricing));
    if (models.length === 0) {
      const error: ModelsError = { kind: 'invalid', status: null, message: `${provider} models: response listed no usable models`, retryable: false };
      return cached !== null ? fromCache(provider, cached, 'cache', error) : fromStatic(provider, error);
    }
    await cache.write({ version: 1, provider, fetchedAt, etag: fetched.etag, models });
    return result(provider, models, 'network', fetchedAt);
  } catch (e) {
    if (opts.signal?.aborted === true) throw opts.signal.reason;
    const error = toModelsError(e, d.redact);
    return cached !== null ? fromCache(provider, cached, 'cache', error) : fromStatic(provider, error);
  }
}

export interface CatalogueLoad {
  results: readonly ListResult[];
  /** every provider's models, deduped and ordered (live models first, then id) */
  models: readonly ModelInfo[];
}

export interface LoadOptions extends ListOptions {
  providers?: readonly ProviderId[];
  keys?: Readonly<Partial<Record<ProviderId, string>>>;
  deps?: ModelsDeps;
}

/**
 * Several providers at once (the picker's "everything I have a key for"). Providers are fetched in
 * parallel; a provider that fails contributes its cache or snapshot rows and an `error` on its own
 * `ListResult`, so one bad key never empties the list.
 */
export async function loadCatalogue(opts: LoadOptions = {}): Promise<CatalogueLoad> {
  const providers = opts.providers ?? PROVIDER_IDS;
  const keys = opts.keys ?? {};
  const results = await Promise.all(providers.map((id) => listModels(id, keys[id] ?? null, opts.deps ?? {}, opts)));
  return { results, models: sortModels(results.flatMap((r) => r.models)) };
}

/** Providers keyed from `env`, then loaded (`keysFromEnv` + `loadCatalogue`). */
export async function loadCatalogueFromEnv(env: NodeJS.ProcessEnv = process.env, opts: LoadOptions = {}): Promise<CatalogueLoad> {
  return loadCatalogue({ ...opts, keys: opts.keys ?? keysFromEnv(env) });
}

/**
 * The instant, never-empty catalogue: every provider's bundled snapshot, with no I/O at all. What a
 * picker paints on its first frame before any `listModels` promise settles.
 */
export function instantCatalogue(providers: readonly ProviderId[] = PROVIDER_IDS): readonly ModelInfo[] {
  return sortModels(allStaticModels(providers));
}

/** The production cache wired to `~/.jevcode/models` — the one place the real home directory enters. */
export function diskCacheDeps(deps: ModelsDeps = {}, env: NodeJS.ProcessEnv = process.env): ModelsDeps {
  // an explicit `cache: null` means "no cache" and stays that way; only an absent one gets the disk
  return { ...deps, cache: deps.cache === undefined ? defaultModelCache(env) : deps.cache };
}
