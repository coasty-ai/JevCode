/**
 * xAI (Grok) — OpenAI-compatible `/chat/completions` on `https://api.x.ai/v1`, driven by `openai-compat.ts`.
 *
 * Live evidence (2026-09-21, `grok-4.7`, streaming forced tool call):
 *  - `strict: true` tools, a named `tool_choice`, `parallel_tool_calls: false`, `seed`, `temperature` and
 *    `stream_options: {include_usage: true}` are all accepted; the whole tool-argument JSON arrives in ONE
 *    `delta.tool_calls[0].function.arguments` chunk (the accumulator handles either shape).
 *  - thinking text streams as `delta.reasoning_content` (measured, never rendered).
 *  - `reasoning_effort` accepts `low` / `medium` / `high`; `none` is a 400 (`This model does not support
 *    `reasoning_effort` value `none``), so §4.12's `{enabled: false}` becomes `low`.
 *  - TWO usage quirks, both confirmed arithmetically against three calls:
 *      (1) `usage.completion_tokens` EXCLUDES the reasoning tokens (28 completion + 35 reasoning, `total_tokens`
 *          1476 = 1413 prompt + 28 + 35), so billed output = completion + reasoning — the only provider here that
 *          splits them that way, and a plain `completion_tokens` read would under-bill every reasoning call.
 *      (2) the frame carries the price: `usage.cost_in_usd_ticks`, where 1e10 ticks = $1. 14,760,000 ticks =
 *          $0.001476 = 261×$2/M + 1152×$0.50/M + 63×$6/M exactly, at grok-4.7's published rates — so the client
 *          takes the wire's cost like openrouter.ts takes `usage.cost`, and the pricing table is only a fallback.
 *  - `GET /v1/models` is unusually rich: `context_length`, `aliases` and integer prices (`prompt_text_token_price`
 *    and friends, in the same 1e10-per-USD units: 20000 → $2.00 per 1M), plus a long-context tier above
 *    `long_context_threshold` (200k tokens) at double the rate.
 */
import type { GenerateReasoning, JsonObject } from '../core/types.js';
import { isJsonObject } from '../core/json.js';
import { getJson, joinUrl, sortModels } from './http.js';
import { createChatProvider } from './openai-compat.js';
import type { ChatQuirks, ChatRequestBody, EffortWord } from './openai-compat.js';
import { effortOf, pickEffort } from './openai-compat.js';
import { getArr, getNum, getStr } from './sse.js';
import type { GenerationProvider, ModelInfo, Pricing, ProviderConfig, ProviderDeps } from './types.js';

export const XAI_BASE_URL = 'https://api.x.ai/v1';
/** 500k context, tools, $2.00/$6.00 per 1M (live catalogue read 2026-09-21). */
export const XAI_DEFAULT_MODEL = 'grok-4.7';

/** xAI reports money and prices as integers: 1e10 units = $1 (equivalently a price of N = $N/10,000 per 1M tokens). */
export const XAI_TICKS_PER_USD = 1e10;

export const XAI_EFFORTS: readonly EffortWord[] = ['low', 'medium', 'high'];

export function xaiReasoning(r: GenerateReasoning): Partial<ChatRequestBody> | null {
  // there is no thinking-budget parameter on this API: a `{maxTokens}` request sends no reasoning field at all
  if ('maxTokens' in r) return null;
  const wanted = effortOf(r);
  if (wanted === null) return null;
  const effort = pickEffort(wanted, XAI_EFFORTS);
  return effort === null ? null : { reasoning_effort: effort };
}

export const XAI_QUIRKS: ChatQuirks = {
  id: 'xai',
  label: 'xai',
  path: '/chat/completions',
  transport: 'sse',
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  maxTokensField: 'max_tokens',
  systemRole: () => 'system',
  strictTools: true,
  toolChoice: 'named',
  parallelToolCalls: true,
  streamUsageOptIn: true,
  usageRequired: true,
  reasoningOutsideCompletion: true,
  costField: { field: 'cost_in_usd_ticks', perUsd: XAI_TICKS_PER_USD },
  seed: true,
  temperature: () => true,
  reasoning: (r) => (r === undefined ? null : xaiReasoning(r)),
};

export function createXaiProvider(cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  return createChatProvider(XAI_QUIRKS, cfg, deps);
}

/** A catalogue price (integer, 1e10 units per USD) as USD per 1M tokens. */
export function xaiPricePerM(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value < 0 ? null : (value / XAI_TICKS_PER_USD) * 1e6;
}

/** ids on this endpoint that are not text generators. */
const XAI_NON_TEXT = /(imagine|image|video|embedding|tts)/;

export function xaiModelInfo(row: JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null || XAI_NON_TEXT.test(id)) return null;
  const input = xaiPricePerM(getNum(row, 'prompt_text_token_price'));
  const output = xaiPricePerM(getNum(row, 'completion_text_token_price'));
  const cached = xaiPricePerM(getNum(row, 'cached_prompt_text_token_price'));
  if (input === null || output === null) return null; // a row without text prices is not a text model
  const pricing: Pricing = { inputPerM: input, outputPerM: output, cacheReadPerM: cached ?? input, cacheWritePerM: input };
  const ctx = getNum(row, 'context_length');
  const created = getNum(row, 'created');
  const owner = getStr(row, 'owned_by');
  const aliases = (getArr(row, 'aliases') ?? []).filter((a): a is string => typeof a === 'string');
  return {
    id,
    pricing,
    // every text model on this endpoint takes tools and reasons (the `-non-reasoning` variants are separate ids)
    tools: true,
    reasoning: !/non-reasoning/.test(id),
    ...(ctx !== null ? { contextTokens: Math.round(ctx) } : {}),
    ...(created !== null ? { created: Math.round(created) } : {}),
    ...(owner !== null ? { ownedBy: owner } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

export async function listXaiModels(apiKey: string, deps: ProviderDeps, baseUrl = XAI_BASE_URL): Promise<ModelInfo[]> {
  const json = await getJson({ label: 'xai', url: joinUrl(baseUrl, '/models'), headers: { authorization: `Bearer ${apiKey}` }, deps });
  const out: ModelInfo[] = [];
  // `/v1/models` and `/v1/language-models` return the same rows under `data` / `models`; both keys are read.
  for (const row of getArr(json, 'data') ?? getArr(json, 'models') ?? []) {
    if (!isJsonObject(row)) continue;
    const info = xaiModelInfo(row);
    if (info) out.push(info);
  }
  return sortModels(out);
}
