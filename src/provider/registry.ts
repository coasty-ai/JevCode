/**
 * The provider registry: one row per generator surface the tree can talk to, with everything the config layer, the
 * onboarding wizard and `/model` need — the key's env var, the base URL, the factory, the catalogue endpoint, the
 * default model, the docs link and the capability flags. Pure data plus three lookups; no I/O until `listModels` or
 * `create` is called, and nothing here imports config, cli, tui or session (they consume this, not the reverse).
 *
 * Membership, 2026-09-21:
 *  - `anthropic` and `openrouter` are the two the harness shipped with (provider/anthropic.ts, provider/openrouter.ts).
 *  - `openai`, `gemini`, `fireworks`, `meta`, `xai` are the five added here.
 *  - `typesafe` is deliberately NOT a row. It is the Jev DECIDER endpoint (`POST https://api.typesafe.ai/decisions`,
 *    models `jev-1.13.x`, priced per input token with a zero output rate — see src/jev/providers.ts `JEV_PROVIDERS` and
 *    src/jev/client.ts). It serves decisions, not chat completions: it has no messages/tools/streaming surface a
 *    `Provider` could be built on, so the decider keeps its own table and this registry stays generator-only.
 *  - `mock` / `null` are test doubles (provider/mock.ts, provider/null.ts), not registry rows.
 *
 * CONTRACT NOTE (src/core/types.ts is owned by the TUI/session round): core's `ProviderName` and
 * `GeneratorConfig.provider` still name only anthropic / openrouter / mock. Rows are therefore typed on
 * `GenerationProvider` / `ProviderConfig` (provider/types.ts); widening those two core unions to `ProviderId` makes
 * `createProvider()` return exactly a core `Provider` with no other change here.
 */
import { ConfigError } from '../errors.js';
import { ANTHROPIC_VERSION, createAnthropicProvider } from './anthropic.js';
import { createOpenRouterProvider, OPENROUTER_REFERER, OPENROUTER_TITLE } from './openrouter.js';
import { createOpenAiProvider, listOpenAiModels, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL } from './openai.js';
import { createGeminiProvider, listGeminiModels, GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL } from './gemini.js';
import { createFireworksProvider, listFireworksModels, FIREWORKS_BASE_URL, FIREWORKS_DEFAULT_MODEL } from './fireworks.js';
import { createMetaProvider, listMetaModels, META_BASE_URL, META_DEFAULT_MODEL } from './meta.js';
import { createXaiProvider, listXaiModels, XAI_BASE_URL, XAI_DEFAULT_MODEL } from './xai.js';
import { getJson, joinUrl, sortModels } from './http.js';
import { getArr, getNum, getStr } from './sse.js';
import { isJsonObject } from '../core/json.js';
import type { GeneratorConfig, JsonObject } from '../core/types.js';
import type { GenerationProvider, ModelInfo, Pricing, ProviderConfig, ProviderDeps, ProviderId } from './types.js';

export interface ProviderCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  vision: boolean;
}

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly displayName: string;
  /** the environment variable the key comes from (config/resolve.ts prepends it to the generator.apiKey lookup) */
  readonly keyEnv: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly docsUrl: string;
  readonly supports: ProviderCapabilities;
  readonly create: (cfg: ProviderConfig, deps: ProviderDeps) => GenerationProvider;
  /** the provider's own catalogue endpoint, filtered to text-generation models */
  readonly listModels: (apiKey: string, deps?: ProviderDeps) => Promise<ModelInfo[]>;
  /**
   * Why a forced (single, named) tool call cannot be requested, when it cannot: the API rejects it, so the client
   * downgrades the choice to `auto`. Absent ⇒ a named `tool_choice` is sent as asked.
   */
  readonly forcedToolLimitation?: string;
}

/** `listModels` takes an optional deps bag; a caller that passes none gets the real fetch and an identity redactor. */
function listDeps(deps: ProviderDeps | undefined): ProviderDeps {
  return deps ?? { redact: (s: string) => s };
}

// ---------------------------------------------------------------------------------------
// The two catalogues that live here (their clients predate provider/http.ts and have no list function)
// ---------------------------------------------------------------------------------------

/** `GET /v1/models` on the Messages API: `{data: [{id, display_name, created_at, max_input_tokens, max_tokens, capabilities}]}`, paginated by `after_id`. */
export function anthropicModelInfo(row: JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null) return null;
  const display = getStr(row, 'display_name');
  const ctx = getNum(row, 'max_input_tokens');
  const out = getNum(row, 'max_tokens');
  const created = getStr(row, 'created_at');
  const caps = row['capabilities'];
  const capObj = isJsonObject(caps) ? caps : null;
  const flag = (name: string): boolean | undefined => {
    const entry = capObj?.[name];
    return isJsonObject(entry) && typeof entry['supported'] === 'boolean' ? entry['supported'] : undefined;
  };
  const thinking = flag('thinking');
  const vision = flag('image_input');
  const createdAt = created === null ? Number.NaN : Date.parse(created) / 1000;
  return {
    id,
    tools: true,
    ...(display !== null ? { displayName: display } : {}),
    ...(ctx !== null ? { contextTokens: Math.round(ctx) } : {}),
    ...(out !== null ? { maxOutputTokens: Math.round(out) } : {}),
    ...(Number.isFinite(createdAt) ? { created: Math.round(createdAt) } : {}),
    ...(thinking !== undefined ? { reasoning: thinking } : {}),
    ...(vision !== undefined ? { vision } : {}),
  };
}

export async function listAnthropicModels(apiKey: string, deps: ProviderDeps, baseUrl = 'https://api.anthropic.com'): Promise<ModelInfo[]> {
  const json = await getJson({ label: 'anthropic', url: joinUrl(baseUrl, '/v1/models?limit=100'), headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }, deps });
  const out: ModelInfo[] = [];
  for (const row of getArr(json, 'data') ?? []) {
    if (!isJsonObject(row)) continue;
    const info = anthropicModelInfo(row);
    if (info) out.push(info);
  }
  return sortModels(out);
}

/** OpenRouter's catalogue: per-token price strings, `context_length`, `supported_parameters` (the tools/reasoning flags come from there). */
export function openRouterModelInfo(row: JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null) return null;
  const params = (getArr(row, 'supported_parameters') ?? []).filter((v): v is string => typeof v === 'string');
  const modalities = (getArr(getObjSafe(row, 'architecture'), 'input_modalities') ?? []).filter((v): v is string => typeof v === 'string');
  const outputs = (getArr(getObjSafe(row, 'architecture'), 'output_modalities') ?? []).filter((v): v is string => typeof v === 'string');
  if (outputs.length > 0 && !outputs.includes('text')) return null;
  const price = getObjSafe(row, 'pricing');
  const perM = (key: string): number | null => {
    const raw = price?.[key];
    const n = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isFinite(n) ? n * 1e6 : null;
  };
  const input = perM('prompt');
  const output = perM('completion');
  const cacheRead = perM('input_cache_read');
  const cacheWrite = perM('input_cache_write');
  const pricing: Pricing | null =
    input !== null && output !== null ? { inputPerM: input, outputPerM: output, cacheReadPerM: cacheRead ?? input * 0.1, cacheWritePerM: cacheWrite ?? input * 1.25 } : null;
  const name = getStr(row, 'name');
  const ctx = getNum(row, 'context_length');
  const created = getNum(row, 'created');
  const maxOut = getNum(getObjSafe(row, 'top_provider'), 'max_completion_tokens');
  const expiry = getStr(row, 'expiration_date');
  return {
    id,
    tools: params.includes('tools'),
    reasoning: params.includes('reasoning') || params.includes('reasoning_effort'),
    vision: modalities.includes('image'),
    ...(name !== null ? { displayName: name } : {}),
    ...(ctx !== null ? { contextTokens: Math.round(ctx) } : {}),
    ...(maxOut !== null ? { maxOutputTokens: Math.round(maxOut) } : {}),
    ...(created !== null ? { created: Math.round(created) } : {}),
    ...(expiry !== null ? { shutdownDate: expiry } : {}),
    ...(pricing !== null ? { pricing } : {}),
  };
}

function getObjSafe(row: JsonObject, key: string): JsonObject | null {
  const v = row[key];
  return isJsonObject(v) ? v : null;
}

export async function listOpenRouterModels(apiKey: string, deps: ProviderDeps, baseUrl = 'https://openrouter.ai/api/v1'): Promise<ModelInfo[]> {
  const json = await getJson({
    label: 'openrouter',
    url: joinUrl(baseUrl, '/models'),
    headers: { authorization: `Bearer ${apiKey}`, 'http-referer': OPENROUTER_REFERER, 'x-title': OPENROUTER_TITLE },
    deps,
  });
  const out: ModelInfo[] = [];
  for (const row of getArr(json, 'data') ?? []) {
    if (!isJsonObject(row)) continue;
    const info = openRouterModelInfo(row);
    if (info) out.push(info);
  }
  return sortModels(out);
}

// ---------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    docsUrl: 'https://docs.claude.com/en/api/messages',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    // the Messages client takes the core GeneratorConfig; ProviderConfig carries every field it reads
    create: (cfg, deps) => createAnthropicProvider(asGeneratorConfig(cfg, 'anthropic'), deps),
    listModels: (apiKey, deps) => listAnthropicModels(apiKey, listDeps(deps)),
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'z-ai/glm-5.3-flash',
    docsUrl: 'https://openrouter.ai/docs/api-reference/chat-completion',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    create: (cfg, deps) => createOpenRouterProvider(asGeneratorConfig(cfg, 'openrouter'), deps),
    listModels: (apiKey, deps) => listOpenRouterModels(apiKey, listDeps(deps)),
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    baseUrl: OPENAI_BASE_URL,
    defaultModel: OPENAI_DEFAULT_MODEL,
    docsUrl: 'https://developers.openai.com/api/docs/api-reference/responses/create',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    create: (cfg, deps) => createOpenAiProvider(cfg, deps),
    listModels: (apiKey, deps) => listOpenAiModels(apiKey, listDeps(deps)),
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    baseUrl: GEMINI_BASE_URL,
    defaultModel: GEMINI_DEFAULT_MODEL,
    docsUrl: 'https://ai.google.dev/api/generate-content',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    create: (cfg, deps) => createGeminiProvider(cfg, deps),
    listModels: (apiKey, deps) => listGeminiModels(apiKey, listDeps(deps)),
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    keyEnv: 'FIREWORKS_API_KEY',
    baseUrl: FIREWORKS_BASE_URL,
    defaultModel: FIREWORKS_DEFAULT_MODEL,
    docsUrl: 'https://docs.fireworks.ai/api-reference/post-chatcompletions',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    create: (cfg, deps) => createFireworksProvider(cfg, deps),
    listModels: (apiKey, deps) => listFireworksModels(apiKey, listDeps(deps)),
  },
  {
    id: 'meta',
    displayName: 'Meta',
    keyEnv: 'META_API_KEY',
    baseUrl: META_BASE_URL,
    defaultModel: META_DEFAULT_MODEL,
    docsUrl: 'https://ai.developer.meta.com/docs/model-api',
    // no structured-output surface documented, and the tool surface cannot be forced (see forcedToolLimitation)
    supports: { tools: true, structuredOutput: false, reasoning: true, vision: false },
    create: (cfg, deps) => createMetaProvider(cfg, deps),
    listModels: (apiKey, deps) => listMetaModels(apiKey, listDeps(deps)),
    forcedToolLimitation:
      'api.meta.ai answers 400 `only "auto" is supported for tool_choice`: a named or required choice is downgraded to auto, and the client also has to use the non-streaming surface (streaming drops tool calls and usage)',
  },
  {
    id: 'xai',
    displayName: 'xAI (Grok)',
    keyEnv: 'XAI_API_KEY',
    baseUrl: XAI_BASE_URL,
    defaultModel: XAI_DEFAULT_MODEL,
    docsUrl: 'https://docs.x.ai/docs/api-reference',
    supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
    create: (cfg, deps) => createXaiProvider(cfg, deps),
    listModels: (apiKey, deps) => listXaiModels(apiKey, listDeps(deps)),
  },
];

/**
 * The two clients that predate provider/http.ts take a core `GeneratorConfig`, whose `provider` field is still the
 * narrow union. They never read it (both build their URL from `baseUrl` and their name is a literal), so the registry
 * supplies it here and the rest of the object is the caller's `ProviderConfig` unchanged.
 */
function asGeneratorConfig(cfg: ProviderConfig, provider: 'anthropic' | 'openrouter'): GeneratorConfig {
  return {
    provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    pricing: cfg.pricing,
    ...(cfg.priced !== undefined ? { priced: cfg.priced } : {}),
  };
}

const BY_ID: ReadonlyMap<string, ProviderSpec> = new Map(PROVIDERS.map((p) => [p.id, p]));

/** The row for an id, or null for anything that is not a registry provider (`mock`, `typesafe`, a typo). */
export function providerFor(id: string): ProviderSpec | null {
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

/** The row for an id, or a ConfigError naming every id that exists — the form the config layer wants. */
export function requireProvider(id: string, setting = 'generator.provider'): ProviderSpec {
  const spec = providerFor(id);
  if (spec !== null) return spec;
  throw new ConfigError(`${setting}: unknown provider "${id}" (known: ${PROVIDERS.map((p) => p.id).join(', ')})`, { setting });
}

/** The env var a provider's key comes from, or null for an unknown id. */
export function keyEnvFor(id: string): string | null {
  return providerFor(id)?.keyEnv ?? null;
}

/** Build a provider from its spec. Kept as a function so callers do not have to know that `spec.create` exists. */
export function createProvider(spec: ProviderSpec, cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  return spec.create(cfg, deps);
}

/** Every registry id, in table order (anthropic, openrouter, then the five 2026-09 additions). */
export const PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.map((p) => p.id);
