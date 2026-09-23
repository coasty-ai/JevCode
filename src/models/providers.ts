/**
 * The provider table: one row per catalogue endpoint, with everything a key-setup flow or a model
 * picker needs to name a provider, find its key and call its list endpoint.
 *
 * Verified live 2026-09-21 (one GET each, no tokens billed):
 *   OpenAI      GET https://api.openai.com/v1/models                        → {object, data[{id, object, created, owned_by, shutdown_date}]}      130 models
 *   Anthropic   GET https://api.anthropic.com/v1/models?limit=1000          → {data[{type, id, display_name, created_at, max_input_tokens,
 *                                                                              max_tokens, capabilities{…}}], has_more, first_id, last_id}        11 models
 *   OpenRouter  GET https://openrouter.ai/api/v1/models                     → {data[{id, canonical_slug, name, context_length, architecture,
 *                                                                              pricing, top_provider, supported_parameters, reasoning, …}],
 *                                                                              total_count, links}                                                443 models
 *   Fireworks   GET https://api.fireworks.ai/inference/v1/models            → {object, data[{id, kind, supports_chat, supports_tools,
 *                                                                              supports_image_input, context_length}]}                            26 models
 *   xAI         GET https://api.x.ai/v1/language-models                     → {models[{id, aliases, input_modalities, …_token_price, …}]}           8 models
 *   Meta        GET https://api.meta.ai/v1/models                           → {object, data[{id, object, created, owned_by}]}                       8 models
 *   Gemini      GET https://generativelanguage.googleapis.com/v1beta/models → 403 SERVICE_DISABLED on this project's key (endpoint shape per
 *                                                                              ai.google.dev/api/models: {models[…], nextPageToken})
 *
 * OpenRouter's list needs no key at all (verified: 200 unauthenticated), so `keyCheckPath` names the
 * endpoint that actually proves a key — the only way `verifyProvider` can tell a good OpenRouter key
 * from a missing one.
 */
import { OPENROUTER_REFERER, OPENROUTER_TITLE } from '../provider/openrouter.js';
import { PROVIDER_DISPLAY_NAME, PROVIDER_IDS, PROVIDER_KEY_ENV, keyEnvNames } from '../provider/ids.js';
import type { GeneratorConfig } from '../core/types.js';
import type { ProviderId } from './types.js';

/**
 * The ids and the key env names live in `provider/ids.ts` (zero imports, so the config layer can read them on the
 * first-frame path without loading this module's catalogue). They are re-exported here so that every caller of this
 * table keeps its import site; this file adds only the endpoint metadata around them.
 */
export { PROVIDER_IDS, keyEnvNames } from '../provider/ids.js';

/** One row of the provider table. */
export interface ProviderSpecEntry {
  id: ProviderId;
  /** what the picker prints ("OpenRouter", "Google Gemini") */
  displayName: string;
  /** scheme + host, no path */
  origin: string;
  /**
   * The version segment appended to a base URL that does not already end with it, so a caller's
   * `https://api.anthropic.com` and `https://api.anthropic.com/v1` both resolve to the same list URL
   * (config `BASE_URLS.anthropic` omits it, `BASE_URLS.openrouter` includes it).
   */
  versionPath: string;
  /** appended to the resolved base: the list endpoint */
  listPath: string;
  /** query parameters the list endpoint wants (page size, etc.) */
  listQuery: Readonly<Record<string, string>>;
  /** the array field of the list response, in the order to try */
  listKeys: readonly string[];
  /** env var names holding a key, in precedence order */
  keyEnv: readonly string[];
  /** a key-info endpoint (relative to the resolved base) for providers whose list is public */
  keyCheckPath: string | null;
  /** where a human gets a key (onboarding copy) */
  keyUrl: string;
}

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic's `anthropic-version` header value, sent on every catalogue request. */
export const ANTHROPIC_VERSION_HEADER = ANTHROPIC_VERSION;

/** Page sizes we ask for: one request covers every provider's catalogue today (the largest is 443). */
export const MAX_PAGE_SIZE = 1000;

export const PROVIDERS: Readonly<Record<ProviderId, ProviderSpecEntry>> = {
  anthropic: {
    id: 'anthropic',
    displayName: PROVIDER_DISPLAY_NAME.anthropic,
    origin: 'https://api.anthropic.com',
    versionPath: '/v1',
    listPath: '/models',
    listQuery: { limit: String(MAX_PAGE_SIZE) },
    listKeys: ['data'],
    keyEnv: PROVIDER_KEY_ENV.anthropic,
    keyCheckPath: null,
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    id: 'openai',
    displayName: PROVIDER_DISPLAY_NAME.openai,
    origin: 'https://api.openai.com',
    versionPath: '/v1',
    listPath: '/models',
    listQuery: {},
    listKeys: ['data'],
    keyEnv: PROVIDER_KEY_ENV.openai,
    keyCheckPath: null,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    id: 'openrouter',
    displayName: PROVIDER_DISPLAY_NAME.openrouter,
    origin: 'https://openrouter.ai',
    versionPath: '/api/v1',
    listPath: '/models',
    listQuery: {},
    listKeys: ['data'],
    keyEnv: PROVIDER_KEY_ENV.openrouter,
    // the list is public; /key is what a key check must call
    keyCheckPath: '/key',
    keyUrl: 'https://openrouter.ai/keys',
  },
  gemini: {
    id: 'gemini',
    displayName: PROVIDER_DISPLAY_NAME.gemini,
    origin: 'https://generativelanguage.googleapis.com',
    versionPath: '/v1beta',
    listPath: '/models',
    listQuery: { pageSize: String(MAX_PAGE_SIZE) },
    listKeys: ['models'],
    // GEMINI_API_KEY first: it is jevcode's canonical name, and it wins over the Google SDKs' own order
    // ("If both are set, GOOGLE_API_KEY takes precedence") for a user who has set both — see provider/ids.ts
    keyEnv: PROVIDER_KEY_ENV.gemini,
    keyCheckPath: null,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  xai: {
    id: 'xai',
    displayName: PROVIDER_DISPLAY_NAME.xai,
    origin: 'https://api.x.ai',
    versionPath: '/v1',
    /**
     * `/v1/models` over `/v1/language-models`: only the former carries `context_length` (verified
     * live — the language-models item has modalities and prices but no window). It also lists the
     * grok-imagine image/video families, which `isChatModelId` drops. `listKeys` accepts either
     * response so a caller pointed at `/language-models` still parses.
     */
    listPath: '/models',
    listQuery: {},
    listKeys: ['data', 'models'],
    keyEnv: PROVIDER_KEY_ENV.xai,
    keyCheckPath: '/api-key',
    keyUrl: 'https://console.x.ai',
  },
  fireworks: {
    id: 'fireworks',
    displayName: PROVIDER_DISPLAY_NAME.fireworks,
    origin: 'https://api.fireworks.ai',
    versionPath: '/inference/v1',
    listPath: '/models',
    listQuery: {},
    listKeys: ['data'],
    keyEnv: PROVIDER_KEY_ENV.fireworks,
    keyCheckPath: null,
    keyUrl: 'https://fireworks.ai/account/api-keys',
  },
  meta: {
    id: 'meta',
    displayName: PROVIDER_DISPLAY_NAME.meta,
    origin: 'https://api.meta.ai',
    versionPath: '/v1',
    listPath: '/models',
    listQuery: {},
    listKeys: ['data'],
    // the Meta Model API docs name MODEL_API_KEY; META_API_KEY is jevcode's own name for it and is read first
    keyEnv: PROVIDER_KEY_ENV.meta,
    keyCheckPath: null,
    keyUrl: 'https://ai.developer.meta.com',
  },
};

/**
 * Providers a run can actually generate with today — typed against core `GeneratorConfig['provider']`
 * so the link is visible: when an adapter lands, core's union widens and this list is where the
 * catalogue learns about it.
 */
export const GENERATOR_PROVIDERS: readonly GeneratorConfig['provider'][] = [...PROVIDER_IDS];

export function isProviderId(v: string): v is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

export function providerSpec(id: ProviderId): ProviderSpecEntry {
  return PROVIDERS[id];
}

/** "OpenRouter", "Google Gemini" — what a picker column shows. */
export function providerDisplayName(id: ProviderId): string {
  return PROVIDERS[id].displayName;
}

/** First non-empty `keyEnv` value in `env`, or null. Trims; an all-whitespace value counts as unset. */
export function keyFromEnv(id: ProviderId, env: NodeJS.ProcessEnv): string | null {
  for (const name of keyEnvNames(id)) {
    const v = env[name]?.trim();
    if (v !== undefined && v !== '') return v;
  }
  return null;
}

/** Every provider that has a key in `env` (the picker's "these are ready" set). */
export function providersWithKeys(env: NodeJS.ProcessEnv): readonly ProviderId[] {
  return PROVIDER_IDS.filter((id) => keyFromEnv(id, env) !== null);
}

/**
 * Every key `env` holds, keyed by provider — what `loadCatalogue` / `searchModels` take. Secrets
 * live only in the returned map (never logged, never cached); providers without a key are absent.
 */
export function keysFromEnv(env: NodeJS.ProcessEnv): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const key = keyFromEnv(id, env);
    if (key !== null) out[id] = key;
  }
  return out;
}

/**
 * `some` rather than `includes` with a widening cast: the cast would keep compiling if
 * `GeneratorConfig['provider']` ever gained a member `ProviderId` does not have (`'mock'`), and
 * silently answer `true` for it. The comparison makes the overlap the compiler's business.
 */
export function isGeneratorProvider(id: ProviderId): boolean {
  return GENERATOR_PROVIDERS.some((p) => p === id);
}

/**
 * Resolve the API base for a provider, honouring a caller-supplied base URL (proxy, gateway, or
 * `GeneratorConfig.baseUrl`). Trailing slashes are dropped; the provider's version segment is
 * appended only when it is not already there, so both spellings of a base URL work.
 */
export function resolveBaseUrl(id: ProviderId, baseUrl?: string): string {
  const spec = PROVIDERS[id];
  const raw = baseUrl?.trim();
  const base = raw === undefined || raw === '' ? spec.origin : raw.replace(/\/+$/, '');
  return base.endsWith(spec.versionPath) ? base : `${base}${spec.versionPath}`;
}

function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return url;
  const qs = new URLSearchParams(entries).toString();
  return `${url}?${qs}`;
}

/** The list URL, with page-size query parameters. `extra` adds pagination cursors. */
export function listUrl(id: ProviderId, baseUrl?: string, extra: Readonly<Record<string, string>> = {}): string {
  const spec = PROVIDERS[id];
  return withQuery(`${resolveBaseUrl(id, baseUrl)}${spec.listPath}`, { ...spec.listQuery, ...extra });
}

/** The key-info URL for providers whose list endpoint is public, else null. */
export function keyCheckUrl(id: ProviderId, baseUrl?: string): string | null {
  const spec = PROVIDERS[id];
  return spec.keyCheckPath === null ? null : `${resolveBaseUrl(id, baseUrl)}${spec.keyCheckPath}`;
}

/**
 * Auth and identification headers for a catalogue request. An empty key yields no auth header at
 * all (OpenRouter's public list still answers; everyone else 401s, which is the honest result).
 */
export function authHeaders(id: ProviderId, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = apiKey?.trim() ?? '';
  switch (id) {
    case 'anthropic':
      if (key !== '') headers['x-api-key'] = key;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
      return headers;
    case 'gemini':
      if (key !== '') headers['x-goog-api-key'] = key;
      return headers;
    case 'openrouter':
      if (key !== '') headers['authorization'] = `Bearer ${key}`;
      headers['http-referer'] = OPENROUTER_REFERER;
      headers['x-title'] = OPENROUTER_TITLE;
      return headers;
    case 'openai':
    case 'xai':
    case 'fireworks':
    case 'meta':
      if (key !== '') headers['authorization'] = `Bearer ${key}`;
      return headers;
  }
}

/**
 * Best guess at which provider owns a model id, for `/model <id>` validation and for classifying an
 * id a user typed. Never a substitute for asking the provider — a heuristic over the id shapes seen
 * live on 2026-09-21.
 */
export function providerFromModelId(modelId: string): ProviderId | null {
  const id = modelId.trim().toLowerCase();
  if (id === '') return null;
  if (id.startsWith('accounts/fireworks/')) return 'fireworks';
  // a namespaced id ("z-ai/glm-5.3-flash", "anthropic/claude-sonnet-5") is OpenRouter's spelling
  if (id.includes('/')) return 'openrouter';
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('grok-')) return 'xai';
  if (id.startsWith('muse-') || id.startsWith('sam-')) return 'meta';
  if (id.startsWith('gpt-') || id.startsWith('chatgpt') || id === 'chat-latest' || /^o[1345](-|$)/.test(id)) return 'openai';
  return null;
}
