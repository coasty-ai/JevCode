/**
 * Fireworks AI — OpenAI-compatible `/chat/completions` on `https://api.fireworks.ai/inference/v1`, driven by
 * `openai-compat.ts` (docs.fireworks.ai/api-reference/post-chatcompletions).
 *
 * Live evidence for every quirk below (2026-09-21, `accounts/fireworks/models/glm-5p3-flash`, streaming forced tool call):
 *  - `strict: true` on a function tool, a named `tool_choice`, `parallel_tool_calls: false`, `seed`, `temperature` and
 *    `stream_options: {include_usage: true}` are all accepted (HTTP 200, tool call streamed in ~1.4 s).
 *  - the accounting frame arrives as a final `choices: []` chunk before `data: [DONE]` — with
 *    `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` (mirrored under
 *    `output_tokens_details`) — and carries NO cost field, so the call is priced from the table.
 *  - `reasoning_effort` accepts `low` / `medium` / `high`; `none` is a 400 on this model
 *    (`GLM-5.3 is a thinking-only model; disabling thinking (reasoning_effort='none') is not supported`), so
 *    LLM-JEV-DESIGN §4.12's `{enabled: false}` becomes the lowest level the model has, `low` — the same substitution
 *    openrouter.ts documents for the GLM endpoints.
 *  - `thinking: {type: 'enabled', budget_tokens}` is accepted and overrides `reasoning_effort` (the two cannot be
 *    combined), which is what §4.12's `{maxTokens}` maps to; the API's floor is 1024 tokens.
 *  - `max_tokens` defaults to 2048 and, worse, a prompt that overflows the context silently SHRINKS it
 *    (`context_length_exceeded_behavior` defaults to `truncate`). This client always sends `max_tokens` and pins
 *    `context_length_exceeded_behavior: 'error'` so an oversized step fails loudly instead of being quietly truncated.
 */
import type { GenerateReasoning } from '../core/types.js';
import { getJson, joinUrl, sortModels } from './http.js';
import { createChatProvider } from './openai-compat.js';
import type { ChatQuirks, ChatRequestBody, EffortWord } from './openai-compat.js';
import { effortOf, pickEffort } from './openai-compat.js';
import { getArr, getNum, getStr } from './sse.js';
import { isJsonObject } from '../core/json.js';
import type { GenerationProvider, ModelInfo, ProviderConfig, ProviderDeps } from './types.js';

import { PROVIDER_BASE_URL, PROVIDER_DEFAULT_MODEL } from './ids.js';
export const FIREWORKS_BASE_URL = PROVIDER_BASE_URL.fireworks;
/** fireworks.ai/models: 1,048,576 context, tools, $0.15/$0.50 per 1M — the same weights the project's OpenRouter default runs. */
export const FIREWORKS_DEFAULT_MODEL = PROVIDER_DEFAULT_MODEL.fireworks;

/** Measured above; `none` and `minimal` are not in it, so `{enabled: false}` lands on `low`. */
export const FIREWORKS_EFFORTS: readonly EffortWord[] = ['low', 'medium', 'high'];

/** The API's documented floor for an Anthropic-style thinking budget. */
export const FIREWORKS_MIN_THINKING_BUDGET = 1024;

export function fireworksReasoning(r: GenerateReasoning): Partial<ChatRequestBody> | null {
  if ('maxTokens' in r) return { thinking: { type: 'enabled', budget_tokens: Math.max(FIREWORKS_MIN_THINKING_BUDGET, r.maxTokens) } };
  const wanted = effortOf(r);
  if (wanted === null) return null;
  const effort = pickEffort(wanted, FIREWORKS_EFFORTS);
  return effort === null ? null : { reasoning_effort: effort };
}

export const FIREWORKS_QUIRKS: ChatQuirks = {
  id: 'fireworks',
  label: 'fireworks',
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
  reasoningOutsideCompletion: false,
  costField: null,
  seed: true,
  temperature: () => true,
  reasoning: (r) => (r === undefined ? null : fireworksReasoning(r)),
  extras: { context_length_exceeded_behavior: 'error' },
  // AGENT-LOOP-DESIGN §6.2 (agent requests only): session affinity for the prompt cache (https://docs.fireworks.ai/guides/prompt-caching),
  // and `reasoning_content` captured and replayed on the assistant turn, which GLM's interleaved thinking needs (https://docs.fireworks.ai/guides/reasoning)
  sessionHeader: 'x-session-affinity',
  replayReasoningContent: true,
};

export function createFireworksProvider(cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  return createChatProvider(FIREWORKS_QUIRKS, cfg, deps);
}

/**
 * `GET /inference/v1/models` is undocumented but live and far richer than OpenAI's: each row carries `supports_chat`,
 * `supports_tools`, `supports_image_input`, `context_length` and `kind` (measured: 26 rows, 24 of them chat models).
 * Model ids are full resource paths with `p` for the dots of a version (`glm-5p3-flash`), and the Fast tier lives under
 * `accounts/fireworks/routers/<slug>-fast`.
 */
export function fireworksModelInfo(row: import('../core/types.js').JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null) return null;
  const kind = getStr(row, 'kind');
  const chat = row['supports_chat'];
  if (chat === false || kind === 'EMBEDDING_MODEL' || /embedding|reranker/.test(id)) return null;
  const created = getNum(row, 'created');
  const ctx = getNum(row, 'context_length');
  const owner = getStr(row, 'owned_by');
  const tools = row['supports_tools'];
  const vision = row['supports_image_input'];
  return {
    id,
    ...(created !== null ? { created: Math.round(created) } : {}),
    ...(ctx !== null ? { contextTokens: Math.round(ctx) } : {}),
    ...(owner !== null ? { ownedBy: owner } : {}),
    ...(typeof tools === 'boolean' ? { tools } : {}),
    ...(typeof vision === 'boolean' ? { vision } : {}),
  };
}

export async function listFireworksModels(apiKey: string, deps: ProviderDeps, baseUrl = FIREWORKS_BASE_URL): Promise<ModelInfo[]> {
  const json = await getJson({ label: 'fireworks', url: joinUrl(baseUrl, '/models'), headers: { authorization: `Bearer ${apiKey}` }, deps });
  const out: ModelInfo[] = [];
  for (const row of getArr(json, 'data') ?? []) {
    if (!isJsonObject(row)) continue;
    const info = fireworksModelInfo(row);
    if (info) out.push(info);
  }
  return sortModels(out);
}
