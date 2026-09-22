/**
 * Wire → `ModelInfo` for every provider's list endpoint, field by field over untrusted JSON (the
 * accessors come from provider/sse.ts, same as the streaming clients: nothing is trusted by cast,
 * and an unknown extra field is ignored rather than fatal).
 *
 * Shapes captured live 2026-09-21 — see providers.ts for the endpoints and counts. What each
 * provider does and does not tell us:
 *
 * | provider   | context | max out | pricing | tools | structured | reasoning | vision | deprecation |
 * |------------|---------|---------|---------|-------|------------|-----------|--------|-------------|
 * | anthropic  | yes     | yes     | no      | all   | yes        | yes       | yes    | no          |
 * | openai     | no      | no      | no      | no    | no         | no        | no     | yes         |
 * | openrouter | yes     | yes     | yes     | yes   | yes        | yes       | yes    | yes         |
 * | gemini     | yes     | yes     | no      | no    | no         | yes       | no     | no          |
 * | xai        | yes     | no      | yes     | no    | no         | no        | partly | no          |
 * | fireworks  | yes     | no      | no      | yes   | serving    | no        | yes    | no          |
 * | meta       | no      | no      | no      | no    | no         | no        | no     | no          |
 *
 * Everything in the "no" cells comes from the bundled snapshot (static.ts) via `enrich`.
 */
import { getArr, getNum, getObj, getStr } from '../provider/sse.js';
import { isJsonObject } from '../core/json.js';
import type { Json, JsonObject, ListBody, ModelInfo, ModelPricing, ModelSupports, ParseOptions, ProviderId } from './types.js';
import { PROVIDERS } from './providers.js';

// ---------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------

/** Optional numbers are kept only when they are a positive finite count. */
function count(v: number | null | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
}

/** Only the flags the provider actually stated; an unstated flag stays absent (absent ≠ false). */
export function supportsOf(f: { tools?: boolean | undefined; structuredOutput?: boolean | undefined; reasoning?: boolean | undefined; vision?: boolean | undefined }): ModelSupports {
  const s: ModelSupports = {};
  if (f.tools !== undefined) s.tools = f.tools;
  if (f.structuredOutput !== undefined) s.structuredOutput = f.structuredOutput;
  if (f.reasoning !== undefined) s.reasoning = f.reasoning;
  if (f.vision !== undefined) s.vision = f.vision;
  return s;
}

interface ModelDraft {
  id: string;
  provider: ProviderId;
  displayName: string;
  updatedAt: string;
  supports: ModelSupports;
  contextLength?: number | undefined;
  maxOutput?: number | undefined;
  pricing?: ModelPricing | undefined;
  deprecated?: boolean | undefined;
}

/** Assemble a `ModelInfo`, omitting (never nulling) every unknown optional member. */
export function buildModel(d: ModelDraft): ModelInfo {
  const info: ModelInfo = { id: d.id, provider: d.provider, displayName: d.displayName, supports: d.supports, updatedAt: d.updatedAt };
  const ctx = count(d.contextLength);
  if (ctx !== undefined) info.contextLength = ctx;
  const out = count(d.maxOutput);
  if (out !== undefined) info.maxOutput = out;
  if (d.pricing !== undefined) info.pricing = d.pricing;
  if (d.deprecated === true) info.deprecated = true;
  return info;
}

/**
 * Rates are derived by multiplying or dividing wire values, which leaves binary-float noise
 * ($0.00000005/token x 1e6 = 0.049999999999999996). Six decimals of a dollar per million tokens is
 * far finer than any provider publishes and keeps both the UI and the cache file clean.
 */
export const RATE_DECIMALS = 6;

export function roundRate(perM: number): number {
  const scale = 10 ** RATE_DECIMALS;
  return Math.round(perM * scale) / scale;
}

/** A pricing record, keeping `cacheReadPerM` only when the provider published one. */
export function pricingOf(inputPerM: number | null, outputPerM: number | null, cacheReadPerM?: number | null): ModelPricing | undefined {
  if (inputPerM === null || outputPerM === null || !Number.isFinite(inputPerM) || !Number.isFinite(outputPerM) || inputPerM < 0 || outputPerM < 0) return undefined;
  const p: ModelPricing = { inputPerM: roundRate(inputPerM), outputPerM: roundRate(outputPerM) };
  if (cacheReadPerM !== null && cacheReadPerM !== undefined && Number.isFinite(cacheReadPerM) && cacheReadPerM >= 0) p.cacheReadPerM = roundRate(cacheReadPerM);
  return p;
}

// ---------------------------------------------------------------------------------------
// Shared wire helpers
// ---------------------------------------------------------------------------------------

/** The list array of a response body: the first of the provider's `listKeys` that holds an array. */
export function listArray(provider: ProviderId, body: ListBody): readonly Json[] {
  for (const key of PROVIDERS[provider].listKeys) {
    const arr = getArr(body, key);
    if (arr !== null) return arr;
  }
  return [];
}

function objects(items: readonly Json[]): JsonObject[] {
  return items.filter((v): v is JsonObject => isJsonObject(v));
}

function nonEmpty(s: string | null): boolean {
  return s !== null && s.trim() !== '';
}

/** `true` / `false` from a boolean field; undefined for anything else (including a missing field). */
function flag(o: JsonObject | null, key: string): boolean | undefined {
  const v = o?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** Anthropic's capability tree: `capabilities.<name>.supported`. */
function capability(caps: JsonObject | null, name: string): boolean | undefined {
  return flag(getObj(caps, name), 'supported');
}

function hasModality(o: JsonObject | null, key: string, modality: string): boolean | undefined {
  const arr = getArr(o, key);
  if (arr === null) return undefined;
  return arr.some((v) => typeof v === 'string' && v.toLowerCase() === modality);
}

function includesString(arr: readonly Json[] | null, value: string): boolean {
  return arr !== null && arr.some((v) => typeof v === 'string' && v === value);
}

/** "muse-spark-1.3-contributor" → "Muse Spark 1.3 Contributor" (providers that ship no label). */
export function titleCaseId(id: string): string {
  return id
    .split(/[-_]/)
    .filter((w) => w !== '')
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * "accounts/fireworks/models/glm-5p3-flash" → "glm-5.3-flash";
 * "accounts/fireworks/routers/kimi-k3-fast" → "kimi-k3-fast (router)".
 * Fireworks encodes version dots as `p` inside a resource path; the label undoes both.
 */
export function fireworksLabel(id: string): string {
  const parts = id.split('/');
  const slug = parts[parts.length - 1] ?? id;
  const dotted = slug.replace(/(\d)p(\d)/g, '$1.$2');
  return parts.includes('routers') ? `${dotted} (router)` : dotted;
}

// ---------------------------------------------------------------------------------------
// Chat filters — what a generator picker should show
// ---------------------------------------------------------------------------------------

/** Non-text OpenAI families: embeddings, audio, images, video, moderation, search-wrapped, completions-only. */
const OPENAI_NON_CHAT = /(embedding|tts|whisper|transcribe|diarize|moderation|dall-e|image|realtime|audio|sora|search|-instruct|live)/;
const OPENAI_CHAT_PREFIX = /^(gpt-|chatgpt|chat-latest$|o[1345](-|$))/;
const XAI_NON_CHAT = /(imagine|image|video|embed|tts|whisper)/;
const META_NON_CHAT = /(image|voice|transcribe|^sam-)/;
const GEMINI_NON_CHAT = /(embedding|embed-|imagen|veo-|tts|aqa|learnlm-.*-tts)/;

/**
 * Whether an id looks like a text/chat model for `provider`, used where the wire carries no
 * capability flag (OpenAI, xAI, Meta, Gemini id guard). Pure and exported so the filter is testable
 * on its own and a caller can opt out (`includeNonChat`).
 */
export function isChatModelId(provider: ProviderId, id: string): boolean {
  const lower = id.trim().toLowerCase();
  switch (provider) {
    case 'openai':
      return OPENAI_CHAT_PREFIX.test(lower) && !OPENAI_NON_CHAT.test(lower);
    case 'xai':
      return !XAI_NON_CHAT.test(lower);
    case 'meta':
      return !META_NON_CHAT.test(lower);
    case 'gemini':
      return !GEMINI_NON_CHAT.test(lower);
    case 'anthropic':
    case 'openrouter':
    case 'fireworks':
      // these carry an explicit signal on the wire; the id says nothing
      return true;
  }
}

// ---------------------------------------------------------------------------------------
// Per-provider normalisers
// ---------------------------------------------------------------------------------------

/**
 * Anthropic `GET /v1/models`. Since Mar 2026 the model object carries `max_input_tokens`,
 * `max_tokens` and a `capabilities` tree, so context, output cap, structured outputs, thinking and
 * image input all come from the wire; only pricing is snapshot-only. Tool use is a property of the
 * Messages API rather than a capability flag, so it is asserted for every listed model.
 */
export function parseAnthropic(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('anthropic', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    const caps = getObj(m, 'capabilities');
    out.push(
      buildModel({
        id,
        provider: 'anthropic',
        displayName: getStr(m, 'display_name') ?? id,
        updatedAt: opts.updatedAt,
        contextLength: getNum(m, 'max_input_tokens') ?? undefined,
        maxOutput: getNum(m, 'max_tokens') ?? undefined,
        supports: supportsOf({
          tools: true,
          structuredOutput: capability(caps, 'structured_outputs'),
          reasoning: capability(caps, 'thinking'),
          vision: capability(caps, 'image_input'),
        }),
      }),
    );
  }
  return out;
}

/**
 * OpenAI `GET /v1/models`. The list is every model type with no capability or context metadata, so
 * the id filter does the work and the snapshot supplies the rest. `shutdown_date` is the one piece
 * of lifecycle data on the wire (a date once a deprecation is announced, else null).
 */
export function parseOpenAi(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('openai', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    if (opts.includeNonChat !== true && !isChatModelId('openai', id)) continue;
    out.push(
      buildModel({
        id,
        provider: 'openai',
        displayName: id,
        updatedAt: opts.updatedAt,
        supports: supportsOf({}),
        deprecated: nonEmpty(getStr(m, 'shutdown_date')) ? true : undefined,
      }),
    );
  }
  return out;
}

/**
 * OpenRouter `GET /api/v1/models` — the only endpoint that carries everything: `context_length`,
 * `top_provider.max_completion_tokens`, per-token `pricing` as decimal strings, the
 * `supported_parameters` list, `architecture.input_modalities` and `expiration_date`.
 *
 * `context_length` is the model's window; `top_provider.context_length` can be smaller (the default
 * route's own limit — 1,310,720 vs 1,048,576 for z-ai/glm-5.3-flash on 2026-09-21). The window is
 * what a picker compares models by, so that is what is reported.
 */
export function parseOpenRouter(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('openrouter', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    const arch = getObj(m, 'architecture');
    const top = getObj(m, 'top_provider');
    const params = getArr(m, 'supported_parameters');
    if (opts.includeNonChat !== true && hasModality(arch, 'output_modalities', 'text') === false) continue;
    const price = getObj(m, 'pricing');
    // `supported_parameters` is the authority; a `reasoning` block alone still proves reasoning
    const reasoning = params !== null ? includesString(params, 'reasoning') || includesString(params, 'reasoning_effort') : getObj(m, 'reasoning') !== null ? true : undefined;
    out.push(
      buildModel({
        id,
        provider: 'openrouter',
        displayName: getStr(m, 'name') ?? id,
        updatedAt: opts.updatedAt,
        contextLength: getNum(m, 'context_length') ?? getNum(top, 'context_length') ?? undefined,
        maxOutput: getNum(top, 'max_completion_tokens') ?? undefined,
        pricing: pricingOf(perMillion(getStr(price, 'prompt')), perMillion(getStr(price, 'completion')), perMillion(getStr(price, 'input_cache_read'))),
        supports: supportsOf({
          tools: params === null ? undefined : includesString(params, 'tools'),
          structuredOutput: params === null ? undefined : includesString(params, 'structured_outputs'),
          reasoning,
          vision: hasModality(arch, 'input_modalities', 'image'),
        }),
        deprecated: nonEmpty(getStr(m, 'expiration_date')) ? true : undefined,
      }),
    );
  }
  return out;
}

/** OpenRouter prices are decimal strings of USD per token ("0.00000015" = $0.15/M). */
function perMillion(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
}

/**
 * Gemini `GET /v1beta/models`. `name` is `models/<id>`; `baseModelId` is documented as the value to
 * pass to a generation request, so it wins when present. `supportedGenerationMethods` is the chat
 * filter (an embedding or TTS model has no `generateContent`), and `thinking` is a real boolean.
 */
export function parseGemini(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('gemini', body))) {
    const name = getStr(m, 'name');
    const base = getStr(m, 'baseModelId');
    const id = nonEmpty(base) && base !== null ? base : (name ?? '').replace(/^models\//, '');
    if (!nonEmpty(id)) continue;
    const methods = getArr(m, 'supportedGenerationMethods');
    if (opts.includeNonChat !== true) {
      if (methods !== null && !includesString(methods, 'generateContent')) continue;
      if (!isChatModelId('gemini', id)) continue;
    }
    out.push(
      buildModel({
        id,
        provider: 'gemini',
        displayName: getStr(m, 'displayName') ?? id,
        updatedAt: opts.updatedAt,
        contextLength: getNum(m, 'inputTokenLimit') ?? undefined,
        maxOutput: getNum(m, 'outputTokenLimit') ?? undefined,
        supports: supportsOf({ reasoning: flag(m, 'thinking') }),
      }),
    );
  }
  return out;
}

/**
 * Fireworks `GET /inference/v1/models` (OpenAI-shaped, undocumented but live): `supports_chat`,
 * `supports_tools`, `supports_image_input`, `context_length` and `kind` are all present.
 * `structuredOutput` is asserted for chat models because `response_format: {type: 'json_schema'}` is
 * a serving-layer feature of the Fireworks inference stack, not a per-model capability.
 */
export function parseFireworks(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('fireworks', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    const chat = flag(m, 'supports_chat') === true && getStr(m, 'kind') !== 'EMBEDDING_MODEL';
    if (opts.includeNonChat !== true && !chat) continue;
    out.push(
      buildModel({
        id,
        provider: 'fireworks',
        displayName: fireworksLabel(id),
        updatedAt: opts.updatedAt,
        contextLength: getNum(m, 'context_length') ?? undefined,
        supports: supportsOf({
          tools: flag(m, 'supports_tools'),
          structuredOutput: chat ? true : undefined,
          vision: flag(m, 'supports_image_input'),
        }),
      }),
    );
  }
  return out;
}

/**
 * xAI `GET /v1/models` (also parses `GET /v1/language-models`, whose array is `models`). Prices are
 * integers in units of 1e-10 USD per token, so USD per million = value / 10,000 — checked against
 * docs.x.ai/developers/pricing on 2026-09-21: grok-4.7 `20000`/`5000`/`60000` = $2.00 / $0.50 / $6.00
 * and grok-4.3 `12500`/`2000`/`25000` = $1.25 / $0.20 / $2.50, both exact.
 *
 * `long_context_threshold` (200k) doubles the rates above it; the doubled tier is not modelled here —
 * `pricing` is the below-threshold rate, which is what a cost estimate for a coding turn should use.
 */
export function parseXai(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('xai', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    if (opts.includeNonChat !== true && !isChatModelId('xai', id)) continue;
    out.push(
      buildModel({
        id,
        provider: 'xai',
        displayName: id,
        updatedAt: opts.updatedAt,
        contextLength: getNum(m, 'context_length') ?? undefined,
        pricing: pricingOf(xaiPrice(m, 'prompt_text_token_price'), xaiPrice(m, 'completion_text_token_price'), xaiPrice(m, 'cached_prompt_text_token_price')),
        supports: supportsOf({ vision: hasModality(m, 'input_modalities', 'image') }),
      }),
    );
  }
  return out;
}

/** xAI price unit: 1e-10 USD per token → USD per million tokens. */
export const XAI_PRICE_UNITS_PER_USD_PER_M = 10_000;

function xaiPrice(m: JsonObject, key: string): number | null {
  const v = getNum(m, key);
  return v === null ? null : v / XAI_PRICE_UNITS_PER_USD_PER_M;
}

/**
 * Meta Model API `GET /v1/models` — bare OpenAI model objects (`id`, `object`, `created`,
 * `owned_by`), no metadata at all, so everything but the id comes from the snapshot. The legacy
 * `api.llama.com` Llama API was retired 2026-07-06 and serves no models.
 */
export function parseMeta(body: ListBody, opts: ParseOptions): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of objects(listArray('meta', body))) {
    const id = getStr(m, 'id');
    if (!nonEmpty(id) || id === null) continue;
    if (opts.includeNonChat !== true && !isChatModelId('meta', id)) continue;
    out.push(buildModel({ id, provider: 'meta', displayName: titleCaseId(id), updatedAt: opts.updatedAt, supports: supportsOf({}) }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Dispatch and pagination
// ---------------------------------------------------------------------------------------

const PARSERS: Readonly<Record<ProviderId, (body: ListBody, opts: ParseOptions) => ModelInfo[]>> = {
  anthropic: parseAnthropic,
  openai: parseOpenAi,
  openrouter: parseOpenRouter,
  gemini: parseGemini,
  xai: parseXai,
  fireworks: parseFireworks,
  meta: parseMeta,
};

/** Normalise one page of a provider's list response. Never throws; a foreign body yields `[]`. */
export function parseModelList(provider: ProviderId, body: ListBody, opts: ParseOptions): ModelInfo[] {
  return PARSERS[provider](body, opts);
}

/**
 * The query parameters that fetch the next page, or null when the response is the last one.
 * Anthropic pages with `after_id` + `has_more`; Gemini with `pageToken` + `nextPageToken`. OpenAI,
 * OpenRouter, xAI, Fireworks and Meta return their whole catalogue in one response (443 models is
 * the largest seen live, in a single OpenRouter page with `links.next: null`).
 */
export function nextPageQuery(provider: ProviderId, body: ListBody): Record<string, string> | null {
  if (provider === 'anthropic') {
    const last = getStr(body, 'last_id');
    return body['has_more'] === true && nonEmpty(last) && last !== null ? { after_id: last } : null;
  }
  if (provider === 'gemini') {
    const token = getStr(body, 'nextPageToken');
    return nonEmpty(token) && token !== null ? { pageToken: token } : null;
  }
  return null;
}

/** Drop duplicate ids (first wins) and order deterministically: live models first, then id. */
export function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const unique: ModelInfo[] = [];
  for (const m of models) {
    const key = `${m.provider}\u0000${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }
  return unique.sort((a, b) => {
    const da = a.deprecated === true ? 1 : 0;
    const db = b.deprecated === true ? 1 : 0;
    if (da !== db) return da - db;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
