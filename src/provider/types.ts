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
// The exact shapes §4.12 / §9.2 stage 1 add to core/types.ts (`GenerateRequest.seed / reasoning / providerPrefs`,
// `GenerateResult.generationId`, `TokenUsage.reasoningTokens / estimated`, `GenerateOptions.sample`), declared here
// until src/core/types.ts carries them. Every member is optional, so a plain `GenerateRequest` is assignable to
// `GenerateRequestExt` and a `GenerateResultExt` to `GenerateResult`: the providers implement the core `Provider`
// interface unchanged. TODO(llm-jev merge, src/core/types.ts): once stage 1 lands the fields, alias these to the core
// names (`export type GenerateRequestExt = GenerateRequest` etc.) and delete the duplicates — the shapes are identical.
// ---------------------------------------------------------------------------------------

/** §4.12 verbatim. */
export type ReasoningEffort = 'low' | 'medium';
/**
 * §4.12 verbatim: `{enabled: false}` turns thinking off where the model allows it; `{effort}` asks for it at a level
 * (on OpenRouter `effort` alone implies enabled). Sent as given, never rewritten.
 *
 * Finding for the spec owner (live 2026-09-21, stage-2 probe + `GET /api/v1/models`): every `z-ai/glm-5.3*` variant
 * carries `reasoning: {mandatory: true, supported_efforts: [max, high, low], default_effort: max}`, and `{enabled: false}`
 * came back HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled" (unbilled). The working GLM call
 * is `{effort: 'low'}` (a forced tool call streamed in 486 ms with `reasoning_tokens: 0`); `medium` is not in GLM's
 * list, and omitting `reasoning` runs at the default effort, `max` (research 07 §5: the budget goes to thinking).
 */
export type GenerateReasoning = { enabled: false } | { effort: ReasoningEffort };
/** §4.12 verbatim: OpenRouter routes only to endpoints that support every parameter sent (tools, seed, …; research 07 §2.2). */
export interface GenerateProviderPrefs {
  requireParameters: boolean;
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
  /** §4.8: set by the engine's `recordCancelledSample()` estimate, never by a provider — a provider's `usage` is always read from an accounting frame */
  estimated?: boolean;
}
export interface GenerateResultExt extends GenerateResult {
  usage: TokenUsageExt;
  /** the API's id for this generation: OpenRouter's chunk `id` (`gen-…`, the handle for `GET /api/v1/generation?id=`, §4.8) or Anthropic's `message.id` (`msg_…`) */
  generationId?: string;
  /** OpenRouter's response `provider` field: the upstream that served the request (bills at its own rate, §8); absent on Anthropic */
  servedProvider?: string;
}
/**
 * §4.8: what the provider knows about a stream when its signal fired, handed to `GenerateOptionsExt.onCancelled` right
 * before `signal.reason` is rethrown (an aborted sample still yields no `GenerateResult`).
 *
 * The estimate is the ENGINE'S (§4.8 `Engine.recordCancelledSample()`: input = a sibling sample's `prompt_tokens`, output
 * = `toolChars` / 4, priced at the served rate, `estimated: true`). This record carries only the facts the engine cannot
 * recover on its own: the ids for the post-hoc lookup and the streamed sizes. It is NOT delivered when the abort lands
 * before the response headers (the prompt may still be billed) — the engine estimates alone then. Proposed precedence
 * (addition to §9.3, for the spec owner): the engine takes `generationId` / `servedProvider` / `toolChars` / `usage` from
 * here when the callback fired, else uses its own estimate.
 */
export interface CancelledGeneration {
  generationId?: string;
  servedProvider?: string;
  model?: string;
  /** text streamed so far */
  text: string;
  /** tool-argument characters streamed so far (§4.8: the estimate's output side is `toolChars / 4`) */
  toolChars: number;
  /** thinking characters streamed so far (`delta.reasoning`; billed as output too, research 07 §5); 0 on Anthropic (thinking is never requested) */
  reasoningChars: number;
  /** present only when the accounting frame had already arrived (the abort landed between it and the end of the stream): read and priced like a completed call, not estimated */
  usage?: TokenUsageExt;
}
export interface GenerateOptionsExt extends GenerateOptions {
  /** §4.6: 0-based index of this sample within a round (N parallel requests); absent for the single-sample propose path */
  sample?: number;
  /**
   * §4.8 (addition, not in §9.3 — see `CancelledGeneration`): called at most once, after the stream's abort and before
   * `signal.reason` is rethrown, when the signal aborted a stream whose response headers had arrived. Runs outside the retry
   * loop: a throwing callback is a harness bug and propagates as a typed 'internal' error in place of the abort reason,
   * exactly like a throwing `onDelta` (never swallowed by the abort path).
   */
  onCancelled?: (partial: CancelledGeneration) => void;
}
/** A `Provider` whose results carry the stage-2 fields; assignable to `Provider`, so every existing slot takes it. All three providers implement it. */
export interface ProviderExt extends Provider {
  generate(req: GenerateRequestExt, opts: GenerateOptionsExt): Promise<GenerateResultExt>;
}
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
  /** https://openrouter.ai/docs/use-cases/reasoning-tokens: `{enabled: false}` disables thinking; `{effort}` asks for it at a level (effort implies enabled) */
  reasoning?: OpenRouterReasoning;
  /** ProviderPreferences (research 07 §2.2) */
  provider?: OpenRouterProviderPrefs;
}
export type OpenRouterReasoning = { enabled: false } | { effort: ReasoningEffort };
export interface OpenRouterProviderPrefs {
  require_parameters: boolean;
}
export interface OpenRouterToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonObject; strict: true };
}
export type OpenRouterToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } };
