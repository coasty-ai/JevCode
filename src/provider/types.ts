/**
 * Internal wire types for the two generator APIs (DESIGN.md §7, research 07 §1.3 and §2.3).
 * Exported for tests and for the engine's diagnostics; nothing outside provider/* depends on
 * them for control flow. Shapes are deliberately loose (`?` everywhere): both APIs document
 * that new fields and event types may appear and must be ignored.
 */
import type { GenerateOptions, GenerateRequest, GenerateResult, GeneratorConfig, Json, JsonObject, Provider, TokenUsage } from '../core/types.js';

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
// LLM-JEV-DESIGN §4.12 / §9.3 contract, stage-2 local declarations
//
// Structurally identical to the optional members stage 1 adds to core/types.ts (`GenerateRequest.seed /
// reasoning / providerPrefs`, `GenerateResult.generationId`, `TokenUsage.reasoningTokens / estimated`,
// `GenerateOptions.sample`). Every member is optional, so a plain `GenerateRequest` is assignable to
// `GenerateRequestExt` and a `GenerateResultExt` to `GenerateResult`: the providers implement the core
// `Provider` interface unchanged. TODO(llm-jev merge): once core/types.ts carries the fields, alias these
// to the core names and delete the duplicates.
// ---------------------------------------------------------------------------------------

export type ReasoningEffort = 'low' | 'medium' | 'high';
/**
 * `{enabled: false}` turns thinking off where the model allows it; `{enabled: true, effort}` asks for it at a level.
 *
 * Live 2026-09-21 (stage-2 probe + `GET /api/v1/models`): every `z-ai/glm-5.3*` variant carries `reasoning:
 * {mandatory: true, default_enabled: true, supported_efforts: [max, high, low], default_effort: max}`, and
 * `{enabled: false}` came back HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled" (unbilled).
 * For GLM send `{enabled: true, effort: 'low'}` — a forced tool call at `low` streamed in 486 ms with
 * `reasoning_tokens: 0`; `medium` is not in GLM's list. Omitting `reasoning` runs at the default effort, `max`.
 */
export interface GenerateReasoning {
  enabled: boolean;
  effort?: ReasoningEffort;
}
/** OpenRouter provider routing (research 07 §2.2): `requireParameters` filters endpoints to those supporting every parameter sent (tools, seed, …); `order` pins upstreams for reproducible billing. */
export interface GenerateProviderPrefs {
  requireParameters?: boolean;
  order?: string[];
}
export interface GenerateRequestExt extends GenerateRequest {
  /** integer; sample diversity across N parallel requests (§4.6) */
  seed?: number;
  reasoning?: GenerateReasoning;
  providerPrefs?: GenerateProviderPrefs;
}
export interface TokenUsageExt extends TokenUsage {
  /** `completion_tokens_details.reasoning_tokens`; absent when the frame did not carry it */
  reasoningTokens?: number;
  /** true when the numbers were derived (chars / 4 on a cancelled stream), not read from an accounting frame */
  estimated?: boolean;
}
export interface GenerateResultExt extends GenerateResult {
  usage: TokenUsageExt;
  /** OpenRouter's chunk `id` (`gen-…`): `GET /api/v1/generation?id=` names the exact bill (§4.8) */
  generationId?: string;
  /** OpenRouter's response `provider` field: the upstream that served the request (bills at its own rate, §8) */
  servedProvider?: string;
}
/**
 * §4.8: what a stream had produced when its signal fired. Handed to `GenerateOptionsExt.onCancelled` right before
 * the provider rethrows `signal.reason` (an aborted sample still yields no `GenerateResult`), so the engine can meter
 * the cancelled sample and keep the `generationId` for a post-hoc lookup.
 */
export interface CancelledGeneration {
  /** `estimated: true` unless the accounting frame had already arrived */
  usage: TokenUsageExt;
  generationId?: string;
  servedProvider?: string;
  model?: string;
  /** streamed so far */
  text: string;
  /** streamed tool-argument characters so far */
  toolChars: number;
}
export interface GenerateOptionsExt extends GenerateOptions {
  /** §4.6: 0-based index of this sample within a round (N parallel requests); absent for the single-sample propose path */
  sample?: number;
  /** §4.8: called once, before `signal.reason` is rethrown, when the signal aborted a stream in flight */
  onCancelled?: (partial: CancelledGeneration) => void;
}
/** A `Provider` whose results carry the stage-2 fields; assignable to `Provider`, so every existing slot takes it. */
export interface ProviderExt extends Provider {
  generate(req: GenerateRequestExt, opts: GenerateOptionsExt): Promise<GenerateResultExt>;
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
  /** https://openrouter.ai/docs/use-cases/reasoning-tokens: `enabled: false` disables thinking; `effort` asks for it at a level */
  reasoning?: OpenRouterReasoning;
  /** ProviderPreferences (research 07 §2.2) */
  provider?: OpenRouterProviderPrefs;
}
export interface OpenRouterReasoning {
  enabled?: boolean;
  effort?: ReasoningEffort;
}
export interface OpenRouterProviderPrefs {
  require_parameters?: boolean;
  order?: string[];
}
export interface OpenRouterToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonObject; strict: true };
}
export type OpenRouterToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } };
