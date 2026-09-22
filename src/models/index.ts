/**
 * The live model catalogue. Everything a model picker, a key-setup wizard or `/model` needs, and
 * nothing that knows about rendering.
 *
 * ## What a picker calls, in what order
 *
 * 1. **First frame, no I/O.** `instantCatalogue()` (or `catalogue.instant()`) returns the bundled
 *    snapshot — every provider's flagship models with prices, windows and capabilities. Paint it.
 *    A picker must never await the network for its first frame.
 * 2. **Behind the frame.** `catalogue.load({ keys: keysFromEnv(env) })` refreshes every provider
 *    that has a key: network → `~/.jevcode/models/<provider>.json` (24 h TTL; revalidated by ETag
 *    when the provider offers one, which none did on 2026-09-21, so budget a refresh as a full
 *    re-download) → snapshot. It never throws and never returns an empty list; each `ListResult`
 *    carries `source` (`network` | `cache` | `static`), `fetchedAt`, `stale` and an optional
 *    `error`. Render those with `sourceLabel(result, Date.now())` and `errorLabel(provider, error)`.
 * 3. **Every keystroke.** `rankModels(query, models, { providers, capability, limit })` — pure,
 *    synchronous, deterministic; `SearchHit.matched` says whether it was an exact, prefix, word or
 *    fuzzy hit if the picker wants to highlight differently. Use `searchModels` only when the
 *    caller wants the load and the ranking in one await.
 * 4. **Rows.** `modelSummary(model)`, or compose from `contextSummary`, `formatPricing`,
 *    `capabilitySummary`. `compareModels` is the same tie-break chain the ranking uses, for a
 *    picker that sorts its own columns.
 * 5. **Empty query / onboarding.** `recommend({ task: 'generator', budget: 'balanced' })` gives a
 *    ranked shortlist with `reasons` strings to print next to each row. Pure and synchronous.
 * 6. **Key setup.** `keyEnvNames(provider)` and `providerSpec(provider).keyUrl` for the copy;
 *    `verifyProvider({ provider }, key)` for the check — one free GET, `{ ok, latencyMs, via,
 *    modelCount?, error? }`, no tokens spent and nothing from the response body surfaced.
 * 7. **Handing the choice to a run.** `generatorPricingOf(model.pricing)` converts catalogue rates
 *    into the engine's four-rate `GeneratorConfig['pricing']` (cache read 0.1x input when the
 *    provider publishes none, cache write 1.25x input — the config/defaults.ts rule).
 *    `isGeneratorProvider(model.provider)` says whether an adapter can run it today.
 *
 * `createCatalogue(deps)` binds one set of injected side effects (fetch, clock, cache, redaction,
 * pricing source) to all of the above; `defaultCatalogue()` is that with the real disk cache, the
 * snapshot pricing source and a redactor, and is the only entry point that touches the home
 * directory.
 *
 * Redaction is never off. Pass `deps.redact = createRedactor(secrets).redact` to have configured
 * keys named as well as matched; with nothing passed, every path falls back to `patternRedact`
 * (src/core/redact.ts), so `ModelsError.message` and `ProviderHttpError.body` are safe to render
 * whatever a provider or a gateway put in its error body.
 */
export type {
  Budget,
  CacheEntry,
  Capability,
  ListOptions,
  ListResult,
  ListSource,
  MatchKind,
  ModelCache,
  ModelInfo,
  ModelPricing,
  ModelSupports,
  ModelTask,
  ModelsDeps,
  ModelsError,
  PricingSource,
  ProviderId,
  ProviderSpec,
  RankOptions,
  RecommendOptions,
  Recommendation,
  SearchHit,
  SearchOptions,
  VerifyResult,
} from './types.js';

export {
  ANTHROPIC_VERSION_HEADER,
  GENERATOR_PROVIDERS,
  MAX_PAGE_SIZE,
  PROVIDERS,
  PROVIDER_IDS,
  authHeaders,
  isGeneratorProvider,
  isProviderId,
  keyCheckUrl,
  keyEnvNames,
  keyFromEnv,
  keysFromEnv,
  listUrl,
  providerDisplayName,
  providerFromModelId,
  providerSpec,
  providersWithKeys,
  resolveBaseUrl,
} from './providers.js';
export type { ProviderSpecEntry } from './providers.js';

export {
  XAI_PRICE_UNITS_PER_USD_PER_M,
  buildModel,
  fireworksLabel,
  isChatModelId,
  listArray,
  nextPageQuery,
  parseAnthropic,
  parseFireworks,
  parseGemini,
  parseMeta,
  parseModelList,
  parseOpenAi,
  parseOpenRouter,
  parseXai,
  pricingOf,
  sortModels,
  supportsOf,
  titleCaseId,
} from './parse.js';

export {
  SNAPSHOT,
  SNAPSHOT_AT,
  SNAPSHOT_DATE,
  allStaticModels,
  enrich,
  fireworksBucketPricing,
  isDatedVariant,
  resolveStatic,
  snapshotSize,
  staticModels,
} from './static.js';
export type { StaticModel } from './static.js';

export {
  CACHE_TTL_MS,
  CACHE_VERSION,
  NULL_CACHE,
  cacheAgeMs,
  cacheFilePath,
  createModelCache,
  defaultModelCache,
  isFresh,
  modelsCacheDir,
  parseCacheFile,
  parseCachedModel,
  serialiseCacheEntry,
} from './cache.js';
export type { CacheDeps } from './cache.js';

export { CATALOGUE_TIMEOUT_MS, ERROR_BODY_CAP, readBody, timedFetch } from './http.js';

export { MAX_LIST_BYTES, MAX_PAGES, diskCacheDeps, fetchProviderModels, instantCatalogue, listModels, loadCatalogue, loadCatalogueFromEnv, toModelsError } from './list.js';
export { RATE_DECIMALS, roundRate } from './parse.js';
export type { CatalogueLoad, FetchedPage, LoadOptions } from './list.js';

export {
  BLENDED_INPUT_SHARE,
  blendedPerM,
  estimateCostUsd,
  findPricingByModelId,
  formatPricing,
  formatRate,
  formatTokens,
  generatorPricingOf,
  mergePricingSources,
  modelBlendedPerM,
  snapshotPricingSource,
} from './pricing.js';

export { CLOSENESS_MAX, compareModels, filterModels, findModel, isRoutingVariant, isSubsequence, matchModel, nearMisses, normalise, rankModels, searchModels, variantRank } from './search.js';

export { BUDGET_CAPS, DEFAULT_MODEL_BONUS, DEPRECATED_PENALTY, PRICE_REFERENCE_PER_M, RECOMMEND_LIMIT, VARIANT_PENALTY, recommend, recommendOne } from './recommend.js';

export { verifyProvider, verifyProviders } from './verify.js';

export {
  CAPABILITY_LABELS,
  capabilitySummary,
  catalogueSummary,
  contextSummary,
  errorLabel,
  modelSummary,
  relativeAge,
  sourceLabel,
} from './format.js';

import { patternRedact } from '../core/redact.js';
import { diskCacheDeps, instantCatalogue, listModels, loadCatalogue } from './list.js';
import { mergePricingSources, snapshotPricingSource } from './pricing.js';
import { keysFromEnv } from './providers.js';
import { recommend } from './recommend.js';
import { searchModels } from './search.js';
import { verifyProvider } from './verify.js';
import type { CatalogueLoad, LoadOptions } from './list.js';
import type { ListOptions, ListResult, ModelInfo, ModelsDeps, ProviderId, ProviderSpec, RecommendOptions, Recommendation, SearchHit, SearchOptions, VerifyResult } from './types.js';

/** One catalogue bound to a set of injected side effects — what a session holds on to. */
export interface Catalogue {
  readonly deps: ModelsDeps;
  /** the bundled snapshot, no I/O — the first frame */
  instant(providers?: readonly ProviderId[]): readonly ModelInfo[];
  list(provider: ProviderId, apiKey: string | null, opts?: ListOptions): Promise<ListResult>;
  load(opts?: Omit<LoadOptions, 'deps'>): Promise<CatalogueLoad>;
  search(query: string, opts?: Omit<SearchOptions, 'deps'>): Promise<SearchHit[]>;
  recommend(opts: RecommendOptions): Recommendation[];
  verify(spec: ProviderSpec, apiKey: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<VerifyResult>;
}

/** Bind `deps` to every catalogue entry point. No I/O happens until a method is called. */
export function createCatalogue(deps: ModelsDeps = {}): Catalogue {
  return {
    deps,
    instant: (providers) => (providers === undefined ? instantCatalogue() : instantCatalogue(providers)),
    list: (provider, apiKey, opts) => listModels(provider, apiKey, deps, opts),
    load: (opts) => loadCatalogue({ ...opts, deps }),
    search: (query, opts) => searchModels(query, { ...opts, deps }),
    recommend,
    verify: (spec, apiKey, opts) => verifyProvider(spec, apiKey, deps, opts),
  };
}

/**
 * The production catalogue: the real disk cache under `~/.jevcode/models` (or `$JEVCODE_HOME`),
 * keys read from `env` by the caller, the snapshot as the pricing fallback behind whatever
 * `deps.pricing` provides, and a redactor.
 *
 * The redactor is wired here as well as defaulted inside `listModels`/`verifyProvider` so that
 * `catalogue.deps.redact` is a function a caller can reuse and assert on, rather than `undefined`
 * that happens to be substituted three layers down.
 */
export function defaultCatalogue(env: NodeJS.ProcessEnv = process.env, deps: ModelsDeps = {}): Catalogue {
  const merged: ModelsDeps = {
    ...diskCacheDeps(deps, env),
    redact: deps.redact ?? patternRedact,
    pricing: mergePricingSources(deps.pricing, snapshotPricingSource()),
  };
  return createCatalogue(merged);
}

/** Keys from `env` plus a production catalogue — the two lines a session needs to open a picker. */
export function catalogueFromEnv(env: NodeJS.ProcessEnv = process.env, deps: ModelsDeps = {}): { catalogue: Catalogue; keys: Partial<Record<ProviderId, string>> } {
  return { catalogue: defaultCatalogue(env, deps), keys: keysFromEnv(env) };
}
