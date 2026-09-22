/**
 * Live model catalogue — the contract the TUI/CLI model picker codes against.
 *
 * One normalised `ModelInfo` per chat-capable model, however the provider spells its own list
 * response. Every list endpoint returns something different (OpenAI: id + created + shutdown_date,
 * nothing else; Anthropic: context, output cap and a capability tree; OpenRouter: context, per-token
 * pricing, supported_parameters and benchmarks; Gemini: token limits and generation methods;
 * Fireworks: supports_chat/tools/image + context; xAI: context + integer prices; Meta: bare ids),
 * so the shape below is the intersection the picker can rely on plus a bundled static snapshot that
 * fills the metadata the wire omits (src/models/static.ts).
 *
 * Nothing here throws: a picker asks for a list and always gets one (network → disk cache → bundled
 * snapshot), with `source`/`stale`/`error` describing what it got.
 */
import type { Json, JsonObject } from '../core/types.js';

/**
 * Providers with a live catalogue endpoint (src/models/providers.ts holds the table).
 *
 * Wider than core `ProviderName` ('anthropic' | 'openrouter' | 'mock'): the catalogue lists what a
 * key can see, which is independent of which providers have a generator adapter wired up. Use
 * `isGeneratorProvider` (providers.ts) for "can this run a generation today".
 */
export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'xai' | 'fireworks' | 'meta';

/** USD per million tokens. `cacheReadPerM` is absent when the provider publishes no cache-read rate. */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
}

/** Capability flags; a member is absent when the provider says nothing about it (absent ≠ false). */
export interface ModelSupports {
  tools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  vision?: boolean;
}

/**
 * One chat-capable model, normalised. `id` is what you pass as the model to the provider verbatim.
 * Optional members are omitted (not null) when unknown — the renderer decides what "unknown" looks
 * like; `exactOptionalPropertyTypes` keeps the two apart.
 */
export interface ModelInfo {
  id: string;
  provider: ProviderId;
  /** the provider's own label when it ships one, else a title-cased form of the id */
  displayName: string;
  /** input context window in tokens */
  contextLength?: number;
  /** max completion/output tokens */
  maxOutput?: number;
  pricing?: ModelPricing;
  supports: ModelSupports;
  /** the provider announced a shutdown / expiry date, or the snapshot marks it superseded */
  deprecated?: boolean;
  /** ISO 8601 of when this record was produced (fetch time, or the snapshot date for bundled rows) */
  updatedAt: string;
}

/** Capability names `searchModels` / `recommend` can filter on. */
export type Capability = keyof ModelSupports;

/**
 * Why a catalogue call could not use the network. Plain data (never an Error subclass): it is
 * rendered, logged and round-tripped through the cache file, and it must survive JSON.
 *
 * - `no_key`   — nothing to authenticate with (the picker shows "add a key")
 * - `auth`     — 401/403: the key is wrong or lacks the scope
 * - `rate_limit` — 429
 * - `http`     — any other non-2xx
 * - `network`  — DNS/TLS/socket/timeout, or `offline: true` was requested
 * - `invalid`  — 2xx whose body was not a list we recognise
 */
export interface ModelsError {
  kind: 'no_key' | 'auth' | 'rate_limit' | 'http' | 'network' | 'invalid';
  /** HTTP status when there was a response, else null */
  status: number | null;
  /** already redacted and clipped by the client */
  message: string;
  retryable: boolean;
}

/** Where a list came from. `static` is the bundled snapshot, which never needs the network. */
export type ListSource = 'network' | 'cache' | 'static';

export interface ListResult {
  provider: ProviderId;
  models: readonly ModelInfo[];
  source: ListSource;
  /** ISO 8601: when the models were fetched (or the snapshot date) */
  fetchedAt: string;
  /** true for anything but a fresh network read — the picker's "· cached" / "· offline" hint */
  stale: boolean;
  /** why the network was not used; absent on a clean network read */
  error?: ModelsError;
}

/** Injected side effects. Every member has a production default; tests pass fakes. */
export interface ModelsDeps {
  fetch?: typeof fetch;
  /** secret redaction for error text; identity when absent (src/core/redact.ts createRedactor().redact in production) */
  redact?: (s: string) => string;
  /** wall clock in ms (cache freshness and `updatedAt`); `Date.now` when absent */
  now?: () => number;
  /** disk cache; `null` disables caching entirely (tests and one-shot CLI reads) */
  cache?: ModelCache | null;
  /** retry backoff jitter source */
  random?: () => number;
  /** retry sleep; rejects with `signal.reason` on abort */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Pricing fallback merged over the snapshot's rates, for ids neither the wire nor the snapshot
   * prices. `src/provider/pricing.ts` (owned by the adapters group) is expected to satisfy this
   * interface; nothing here imports it, so its absence cannot break this module.
   */
  pricing?: PricingSource;
}

/**
 * The seam to `src/provider/pricing.ts`: given a provider and a model id, return USD/M rates or
 * null. Implemented there (adapters group) and injected; `src/models/pricing.ts` also exports a
 * snapshot-backed implementation so the catalogue is complete on its own.
 */
export interface PricingSource {
  lookup(provider: ProviderId, model: string): ModelPricing | null;
}

export interface ListOptions {
  /** re-fetch even when the cached entry is inside its TTL (the picker's refresh key) */
  force?: boolean;
  /** never touch the network: disk cache, then the bundled snapshot */
  offline?: boolean;
  /** keep embedding / image / audio / video models instead of dropping them */
  includeNonChat?: boolean;
  /** cache freshness window; `CACHE_TTL_MS` (24 h) when absent */
  ttlMs?: number;
  signal?: AbortSignal;
}

/** One cached provider list on disk (`~/.jevcode/models/<provider>.json`). */
export interface CacheEntry {
  /** bumped when the on-disk shape changes; a foreign version reads as a miss */
  version: 1;
  provider: ProviderId;
  /** ISO 8601 of the fetch that produced `models` */
  fetchedAt: string;
  /** the response's ETag, replayed as `if-none-match`; null when the provider sent none */
  etag: string | null;
  models: readonly ModelInfo[];
}

export interface ModelCache {
  /** `<dir>/<provider>.json` */
  path(provider: ProviderId): string;
  /** a missing, unreadable, malformed or foreign-version file reads as null — never throws */
  read(provider: ProviderId): Promise<CacheEntry | null>;
  /** best effort: a failed write is not an error for the caller (the list still returns) */
  write(entry: CacheEntry): Promise<void>;
}

/** What `rankModels` / `searchModels` matched on, best first. */
export type MatchKind = 'exact' | 'prefix' | 'word' | 'fuzzy';

export interface SearchHit {
  model: ModelInfo;
  /** higher is better; `rankModels` orders by it and breaks ties deterministically */
  score: number;
  matched: MatchKind;
}

export interface RankOptions {
  providers?: readonly ProviderId[];
  /** every named capability must be `true` on the model */
  capability?: Capability | readonly Capability[];
  /** cap the result length (after ranking) */
  limit?: number;
  /**
   * Deprecated models are listed by default and simply rank last (a user who asks for
   * `gpt-3.5-turbo` should still find it); pass `false` to drop them from the result.
   */
  includeDeprecated?: boolean;
}

export interface SearchOptions extends RankOptions {
  /** rank over these instead of loading anything (the pure path the picker uses while typing) */
  models?: readonly ModelInfo[];
  /** keys per provider for the loading path; a provider with no key falls back to cache/snapshot */
  keys?: Readonly<Partial<Record<ProviderId, string>>>;
  deps?: ModelsDeps;
  offline?: boolean;
  signal?: AbortSignal;
}

/** What the model is being picked for: the code-writing generator, or the Jev-side decider. */
export type ModelTask = 'generator' | 'decider';

/**
 * `cheap` / `balanced` / `premium` cap the blended rate (see `blendedPerM`); a number is that cap
 * in USD per million tokens; `any` does not filter on price.
 */
export type Budget = 'cheap' | 'balanced' | 'premium' | 'any' | number;

export interface RecommendOptions {
  task: ModelTask;
  budget?: Budget;
  /** rank over these instead of the bundled snapshot */
  models?: readonly ModelInfo[];
  providers?: readonly ProviderId[];
  limit?: number;
}

export interface Recommendation {
  model: ModelInfo;
  score: number;
  /** short human phrases, best first — rendered verbatim next to the row */
  reasons: readonly string[];
}

/** What to verify: a provider, optionally at a non-default base URL. */
export interface ProviderSpec {
  provider: ProviderId;
  /** overrides the registry base URL (proxies, gateways) */
  baseUrl?: string;
  /** reserved for adapters that need a model to verify against; the catalogue check never sends one */
  model?: string;
}

export interface VerifyResult {
  ok: boolean;
  provider: ProviderId;
  /** round trip of the single request, ms (0 when nothing was sent) */
  latencyMs: number;
  /** which endpoint answered: the model list, or the provider's key-info endpoint */
  via: 'models' | 'key' | 'none';
  /** models visible to this key, when the check listed them */
  modelCount?: number;
  error?: ModelsError;
}

/** Parse-time knobs shared by every provider normaliser. */
export interface ParseOptions {
  /** ISO 8601 stamped onto every produced `ModelInfo.updatedAt` */
  updatedAt: string;
  /** keep non-chat models (embeddings, image, audio, video, moderation) */
  includeNonChat?: boolean;
}

/** One provider's list response, already JSON-parsed. `Json` so a parser can be handed a fixture. */
export type ListBody = JsonObject;

/** Re-exported for parsers that walk untrusted wire values. */
export type { Json, JsonObject };
