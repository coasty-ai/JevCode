/**
 * Internal wire types for the two generator APIs (DESIGN.md §7, research 07 §1.3 and §2.3).
 * Exported for tests and for the engine's diagnostics; nothing outside provider/* depends on
 * them for control flow. Shapes are deliberately loose (`?` everywhere): both APIs document
 * that new fields and event types may appear and must be ignored.
 */
import type { GenerateOptions, GenerateRequest, GenerateResult, GeneratorConfig, Json, JsonObject, ReasoningEffort, ToolCall } from '../core/types.js';

// ---------------------------------------------------------------------------------------
// Shared transport
// ---------------------------------------------------------------------------------------

/** One SSE record: `event:` name (absent for OpenRouter, which sends bare `data:` lines) and the joined `data:` lines. */
export interface SseRecord {
  event?: string;
  data: string;
}

export interface SseOptions {
  /** Aborting stops the reader and rethrows `signal.reason`. */
  signal?: AbortSignal;
  /** Time allowed for the first byte (default 30 s). */
  firstByteTimeoutMs?: number;
  /** Time allowed between subsequent chunks (default 60 s). */
  idleTimeoutMs?: number;
  /** Upper bound on one buffered event (default 16 MiB); exceeding it is a non-retryable error. */
  maxEventBytes?: number;
}

/** Injectable side effects shared by the HTTP providers (tests pass fakes; production uses the defaults). */
export interface ProviderDeps {
  fetch?: typeof fetch;
  redact: (s: string) => string;
  /** monotonic clock in ms */
  now?: () => number;
  /** sleep that rejects with `signal.reason` on abort */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** U[0,1) source for backoff jitter */
  random?: () => number;
}

export type Pricing = GeneratorConfig['pricing'];

/** Token counts in the shape both cost formulas consume. */
export interface TokenBreakdown {
  /** uncached input tokens */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

// ---------------------------------------------------------------------------------------
// LLM-JEV-DESIGN §4.8 / §4.12 contract — declared once in src/core/types.ts (`GenerateRequest.seed / reasoning /
// providerPrefs`, `GenerateResult.generationId / servedProvider`, `TokenUsage.reasoningTokens / estimated`,
// `GenerateOptions.sample / onCancelled`, `CancelledGeneration`); the providers implement the core `Provider` unchanged.
// Only the stream-side working type lives here.
// ---------------------------------------------------------------------------------------

/**
 * What a stream had produced when its signal fired (the providers' `consumeStream` fills one in its abort branch; `generate`
 * turns it into a `CancelledGeneration` with `sse.ts toCancelledGeneration`). `tokens` is the accounting frame's reading
 * when it had arrived, else null — nothing here is estimated.
 */
export interface StreamPartial {
  text: string;
  toolChars: number;
  reasoningChars: number;
  model: string | null;
  generationId: string | null;
  servedProvider: string | null;
  tokens: TokenBreakdown | null;
  /** `usage.cost` when the frame carried one */
  cost: number | null;
  reasoningTokens: number | null;
}

// ---------------------------------------------------------------------------------------
// Anthropic Messages API, streaming (research 07 §1.3 verbatim events)
// ---------------------------------------------------------------------------------------

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface AnthropicMessageStart {
  type: 'message_start';
  message: { id?: string; model?: string; stop_reason?: string | null; usage?: AnthropicUsage };
}
export interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text?: string } | { type: 'tool_use'; id?: string; name?: string; input?: Json } | { type: string };
}
export interface AnthropicContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking?: string }
    | { type: 'signature_delta'; signature?: string }
    | { type: string };
}
export interface AnthropicContentBlockStop {
  type: 'content_block_stop';
  index: number;
}
export interface AnthropicMessageDelta {
  type: 'message_delta';
  delta?: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: AnthropicUsage;
}
export interface AnthropicMessageStop {
  type: 'message_stop';
}
export interface AnthropicPing {
  type: 'ping';
}
export interface AnthropicErrorBody {
  type: 'error';
  error: { type?: string; message?: string; details?: { error_code?: string } };
  request_id?: string;
}
export type AnthropicStreamEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | AnthropicMessageDelta
  | AnthropicMessageStop
  | AnthropicPing
  | AnthropicErrorBody;

/** Request body we send (research 07 §1.1, §4). */
export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  stream: true;
  system?: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
}
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JsonObject;
  strict: true;
  eager_input_streaming: true;
  cache_control?: { type: 'ephemeral' };
}
export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use: true }
  | { type: 'any'; disable_parallel_tool_use: true }
  | { type: 'tool'; name: string; disable_parallel_tool_use: true };

// ---------------------------------------------------------------------------------------
// OpenRouter chat completions, streaming (research 07 §2.3)
// ---------------------------------------------------------------------------------------

export interface OpenRouterToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
export interface OpenRouterChoiceDelta {
  role?: string;
  content?: string | null;
  /** reasoning text when `reasoning.exclude` is false; not rendered, not accumulated */
  reasoning?: string | null;
  tool_calls?: OpenRouterToolCallDelta[];
}
export interface OpenRouterChoice {
  index?: number;
  delta?: OpenRouterChoiceDelta;
  finish_reason?: string | null;
  native_finish_reason?: string | null;
}
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | null;
  is_byok?: boolean;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}
export interface OpenRouterError {
  code?: number | string;
  message?: string;
  metadata?: { error_type?: string; limit_source?: string; [k: string]: Json | undefined };
}
export interface OpenRouterChunk {
  id?: string;
  object?: string;
  model?: string;
  provider?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage | null;
  error?: OpenRouterError;
}

export interface OpenRouterRequestBody {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream: true;
  max_tokens: number;
  tools?: OpenRouterToolDef[];
  tool_choice?: OpenRouterToolChoice;
  /** sent as `false` whenever `tools` is present: the loop consumes exactly one action per step (Anthropic: `disable_parallel_tool_use`) */
  parallel_tool_calls?: false;
  usage: { include: true };
  temperature?: number;
  /** integer; a supported parameter of z-ai/glm-5.3-flash (config/defaults.ts) */
  seed?: number;
  /** https://openrouter.ai/docs/use-cases/reasoning-tokens: `{enabled: false}` disables thinking; `{effort}` asks for it at a level (effort implies enabled); `{max_tokens}` is a thinking budget (one of effort / max_tokens, never both) */
  reasoning?: OpenRouterReasoning;
  /** ProviderPreferences (research 07 §2.2) */
  provider?: OpenRouterProviderPrefs;
}
/**
 * The wire form of core `GenerateReasoning` (LLM-JEV-DESIGN §4.12), sent as given.
 *
 * Finding for the spec owner (live 2026-09-21, stage-2 probe + `GET /api/v1/models`): every `z-ai/glm-5.3*` variant
 * carries `reasoning: {mandatory: true, supported_efforts: [max, high, low], default_effort: max}`, and `{enabled: false}`
 * came back HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled" (unbilled). The working GLM call
 * is `{effort: 'low'}` (a forced tool call streamed in 486 ms with `reasoning_tokens: 0`); `medium` is not in GLM's
 * list, and omitting `reasoning` runs at the default effort, `max` (research 07 §5: the budget goes to thinking).
 *
 * `{max_tokens}` (core `{maxTokens}`, 2026-09-21): OpenRouter's documented thinking budget ("Anthropic-style"; the docs say
 * effort and max_tokens are alternatives, and that a model supporting only one of them has the other translated — a
 * budget into an effort level by its share of `max_tokens`). Whether the GLM endpoints, which list `supported_efforts`,
 * honour a budget directly is not verified live; the client sends it as given (a pass-through for the latency-tail tuning).
 */
export type OpenRouterReasoning = { enabled: false } | { effort: ReasoningEffort } | { max_tokens: number };
export interface OpenRouterProviderPrefs {
  require_parameters: boolean;
}
export interface OpenRouterToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonObject; strict: true };
}
export type OpenRouterToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } };

// ---------------------------------------------------------------------------------------
// Multi-provider additions (2026-09-21): the ids, the structural Provider the new HTTP clients
// return, the config subset they read, and the outcome every client hands to `finishGeneration`.
//
// CONTRACT NOTE for the core owner (src/core/types.ts is owned by the TUI/session round): core's
// `ProviderName` is still `'anthropic' | 'openrouter' | 'mock'` and `GeneratorConfig.provider` still
// `'anthropic' | 'openrouter'`. Widening them to `ProviderId` (below) makes `GenerationProvider`
// exactly `Provider`, and `createProvider(...)` directly usable by loop/engine.ts; until then the
// registry is typed on the structural `GenerationProvider` (core `Provider` is assignable to it).
// ---------------------------------------------------------------------------------------

/** Every provider the registry can build a generator for (registry.ts `PROVIDERS`); `mock` and `null` are test doubles, not registry rows. */
export type ProviderId = 'anthropic' | 'openrouter' | 'openai' | 'gemini' | 'fireworks' | 'meta' | 'xai';

/** `Provider.name` widened by the test doubles' ids; core `ProviderName` is a subset of it. */
export type GenerationProviderName = ProviderId | 'mock';

/**
 * Structurally core's `Provider` with a widened `name` (core `Provider` is assignable to this; the reverse holds once
 * `ProviderName` is widened — see the contract note above). Every `create<X>Provider` returns one.
 */
export interface GenerationProvider {
  readonly name: GenerationProviderName;
  readonly model: string;
  generate(req: GenerateRequest, opts: GenerateOptions): Promise<GenerateResult>;
}

/**
 * Everything an HTTP client reads out of `GeneratorConfig` — a `GeneratorConfig` is assignable to it, and a caller that
 * has no `provider` field yet (the registry, tests) can build one. `priced` keeps its `GeneratorConfig` meaning
 * (TUI-DESIGN §9.5): absent/false ⇒ a call the API did not price yields `costUsd` NaN (`budget:unpriced`), never a table price.
 */
export interface ProviderConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  /** null = do not send the sampling parameter at all */
  temperature: number | null;
  maxTokens: number;
  pricing: Pricing;
  priced?: boolean;
}

/**
 * What one completed stream produced, in the shape `finishGeneration` (http.ts) turns into a `GenerateResult`.
 * `cost` is set only when the API itself reported a price (OpenRouter `usage.cost`, xAI `usage.cost_in_usd_ticks`);
 * everything else is priced from the table or surfaced as NaN.
 */
export interface ProviderOutcome {
  text: string;
  toolCalls: ToolCall[];
  tokens: TokenBreakdown;
  cost: number | null;
  reasoningTokens: number | null;
  model: string | null;
  generationId: string | null;
  servedProvider: string | null;
  /** the wire's finish reason, normalised to the vocabulary synth/llm/schema.ts `isLengthStop` reads (`length` / `max_tokens`) */
  stopReason: string;
}

/** One model as the provider's own catalogue endpoint reports it (registry.ts `ProviderSpec.listModels`). */
export interface ModelInfo {
  id: string;
  /** the provider's own label when it has one (Anthropic `display_name`, Gemini `displayName`, OpenRouter `name`) */
  displayName?: string;
  /** context window in tokens when the API reports one (OpenAI's does not) */
  contextTokens?: number;
  maxOutputTokens?: number;
  /** unix seconds, as reported */
  created?: number;
  ownedBy?: string;
  /** the API said this model takes function/tool calls (absent = the API does not say) */
  tools?: boolean;
  /** the API said this model reasons / thinks (absent = the API does not say) */
  reasoning?: boolean;
  vision?: boolean;
  /** an announced retirement (OpenAI `shutdown_date`, OpenRouter `expiration_date`), verbatim */
  shutdownDate?: string;
  /** per-million USD when the catalogue itself carries prices (xAI, OpenRouter); never from our table */
  pricing?: Pricing;
  /** ids the provider accepts for the same weights (xAI `aliases`) */
  aliases?: readonly string[];
}
