/**
 * Meta — the Meta Model API (`https://api.meta.ai/v1`, OpenAI-compatible), NOT the retired public-preview "Llama API":
 * `api.llama.com` was shut down on 2026-07-06 and serves no models, and api.meta.ai serves the Muse family
 * (`muse-spark-1.3` and friends), no Llama weights. `META_LEGACY_BASE_URL` exists only so a config that still points at
 * the old host gets a message naming the successor instead of a bare DNS/404 failure.
 *
 * This is the most constrained provider in the registry, and every limit below was measured on 2026-09-21 against
 * `muse-spark-1.3`:
 *  - **Forced tool calls do not exist.** `tool_choice: {type: 'function', ...}` and `"required"` are both
 *    400 ``only `"auto"` is supported for `tool_choice`. `"none"`, `"required"`, and named function choices are not
 *    currently supported``. A forced choice is therefore downgraded to `auto` (quirks `toolChoice: 'auto-only'`): the
 *    model still sees the tool, and the harness still rejects a reply that is not a valid proposal.
 *  - **Streaming loses both the tool call and the usage frame.** With `stream: true` the same request that produces a
 *    `tool_calls` finish reason without streaming came back as prose with `finish_reason: "stop"`, no `tool_calls` and
 *    no usage chunk at all (even with `stream_options: {include_usage: true}`), and a `max_tokens: 12` request reported
 *    `stop` instead of `length`. Non-streaming returns all three correctly. So this client alone uses
 *    `transport: 'json'` — the same body without `stream`, the single completion fed through the shared accumulator —
 *    which costs the token-by-token render but keeps tool calls, the length stop and the accounting.
 *  - `strict: true` tools, `parallel_tool_calls: false`, `seed`, `temperature` and `reasoning_effort` are accepted
 *    (HTTP 200); whether the last one is honoured is not observable (the model reports `reasoning_tokens` either way).
 *  - No published price list exists for the Muse models, so `pricing.ts` marks them unknown: run this provider with
 *    `priced: false` and the engine reports `budget:unpriced` instead of billing $0 (TUI-DESIGN §9.5).
 */
import type { GenerateReasoning, JsonObject } from '../core/types.js';
import { isJsonObject } from '../core/json.js';
import { getJson, joinUrl } from './http.js';
import { createChatProvider } from './openai-compat.js';
import type { ChatQuirks, ChatRequestBody, EffortWord } from './openai-compat.js';
import { effortOf, pickEffort } from './openai-compat.js';
import { getArr, getNum, getStr } from './sse.js';
import type { GenerationProvider, ModelInfo, ProviderConfig, ProviderDeps } from './types.js';

import { PROVIDER_BASE_URL, PROVIDER_DEFAULT_MODEL } from './ids.js';
export const META_BASE_URL = PROVIDER_BASE_URL.meta;
/** The retired Llama API preview (sunset 2026-07-06); kept so a stale config can be recognised, never used by default. */
export const META_LEGACY_BASE_URL = 'https://api.llama.com/v1';
export const META_DEFAULT_MODEL = PROVIDER_DEFAULT_MODEL.meta;

export const META_EFFORTS: readonly EffortWord[] = ['low', 'medium', 'high'];

export function metaReasoning(r: GenerateReasoning): Partial<ChatRequestBody> | null {
  if ('maxTokens' in r) return null;
  const wanted = effortOf(r);
  if (wanted === null) return null;
  const effort = pickEffort(wanted, META_EFFORTS);
  return effort === null ? null : { reasoning_effort: effort };
}

export const META_QUIRKS: ChatQuirks = {
  id: 'meta',
  label: 'meta',
  path: '/chat/completions',
  // measured: `stream: true` drops tool calls AND usage on this endpoint (see the module comment)
  transport: 'json',
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  maxTokensField: 'max_tokens',
  systemRole: () => 'system',
  strictTools: true,
  // measured: named / `required` choices are a 400 here
  toolChoice: 'auto-only',
  parallelToolCalls: true,
  streamUsageOptIn: false,
  usageRequired: true,
  reasoningOutsideCompletion: false,
  costField: null,
  seed: true,
  temperature: () => true,
  reasoning: (r) => (r === undefined ? null : metaReasoning(r)),
};

export function createMetaProvider(cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  return createChatProvider(META_QUIRKS, cfg, deps);
}

/** ids on this endpoint that are not text generators (`muse-image-1.0`, `muse-voice-transcribe-1.0`, `sam-3.1`). */
const META_NON_TEXT = /(image|voice|transcribe|^sam-)/;

export function metaModelInfo(row: JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null || META_NON_TEXT.test(id)) return null;
  const created = getNum(row, 'created');
  const owner = getStr(row, 'owned_by');
  return {
    id,
    tools: true,
    // `-contributor` rows are the same weights on the contributor tier
    ...(created !== null && created > 0 ? { created: Math.round(created) } : {}),
    ...(owner !== null ? { ownedBy: owner } : {}),
  };
}

export async function listMetaModels(apiKey: string, deps: ProviderDeps, baseUrl = META_BASE_URL): Promise<ModelInfo[]> {
  const json = await getJson({ label: 'meta', url: joinUrl(baseUrl, '/models'), headers: { authorization: `Bearer ${apiKey}` }, deps });
  const out: ModelInfo[] = [];
  for (const row of getArr(json, 'data') ?? []) {
    if (!isJsonObject(row)) continue;
    const info = metaModelInfo(row);
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
