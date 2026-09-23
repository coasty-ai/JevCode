/**
 * Anthropic Messages API client over raw fetch + SSE (DESIGN.md §7, research 07 §1, §4, §5).
 * No SDK: the project allows Node built-ins only. Streams text to `onDelta`, tool-input JSON
 * fragments to `onToolDelta`, parses tool inputs once at the end, prices from `cfg.pricing`.
 * LLM-JEV-DESIGN §4.12: ignores `seed` / `reasoning` / `providerPrefs`; surfaces `message.id` as `generationId`;
 * §4.8: a cancelled stream's facts (message id, streamed sizes) go to `onCancelled` like openrouter.ts (no `servedProvider`).
 */
import { JevCodeError, ProviderHttpError } from '../errors.js';
import type { AgentMessage, AgentRequest, GenerateOptions, GenerateRequest, GenerateResult, GeneratorConfig, Json, JsonObject, Provider, ProviderReplayState, ToolCall } from '../core/types.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { anthropicInputSchema } from './anthropic-schema.js';
import { agentCallId, emitToolCall, messagesError, objectInput, replayData, warningLines } from './http.js';
import { clip } from '../core/text.js';
import {
  FIRST_BYTE_TIMEOUT_MS,
  IdleTimeoutError,
  TransportError,
  clipMessage,
  costFromPricing,
  getArr,
  getNum,
  getObj,
  getStr,
  httpError,
  isRetryableStatus,
  linkedAbort,
  notify,
  parseJsonObject,
  parseSse,
  readBodyCapped,
  reportFirstByte,
  requestIdOf,
  resolveDeps,
  sanitiseRequestId,
  toCancelledGeneration,
  toTokenUsage,
  withRetry,
} from './sse.js';
import type {
  AnthropicContentBlock,
  AnthropicRequestBody,
  AnthropicToolChoice,
  AnthropicToolDef,
  ProviderDeps,
  StreamPartial,
  TokenBreakdown,
} from './types.js';

export const ANTHROPIC_VERSION = '2023-06-01';

/** `error.type` → HTTP status, used for `event: error` frames that arrive after a 200 (research 07 §1.5). */
const ERROR_TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

function validateRequest(req: GenerateRequest): void {
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
    throw new ProviderHttpError(`invalid GenerateRequest: maxTokens must be a positive integer, got ${String(req.maxTokens)}`, { status: 0, retryable: false });
  }
  const messages = messagesError(req);
  if (messages !== null) throw new ProviderHttpError(`invalid GenerateRequest: ${messages}`, { status: 0, retryable: false });
  if (req.temperature !== null && !Number.isFinite(req.temperature)) {
    throw new ProviderHttpError('invalid GenerateRequest: temperature must be a finite number or null', { status: 0, retryable: false });
  }
}

/**
 * Exported so tests can assert the exact wire body (temperature omission, cache markers, tool_choice).
 *
 * LLM-JEV-DESIGN §4.12: the OpenRouter-side request fields are ignored here — the Messages API has no `seed`,
 * `providerPrefs` is OpenRouter routing, and `reasoning` maps to nothing (Sonnet 5 400s on `thinking`, research 07
 * §1.1; the harness never asks Claude for extended thinking). The body is built field by field, so none of them
 * can reach the wire.
 */
export function buildAnthropicBody(cfg: GeneratorConfig, req: GenerateRequest): AnthropicRequestBody {
  if (req.agent !== undefined) return buildAgentBody(cfg, req, req.agent);
  const body: AnthropicRequestBody = {
    model: cfg.model,
    max_tokens: req.maxTokens,
    stream: true,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  // The API rejects empty text blocks, so an empty system prompt is simply not sent.
  if (req.system.length > 0) body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  if (req.tools && req.tools.length > 0) {
    const tools: AnthropicToolDef[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Anthropic rejects oneOf/const in tool schemas: the action union is flattened (anthropic-schema.ts)
      input_schema: anthropicInputSchema(t.inputSchema),
      strict: true,
      // fragments reach onToolDelta as they are generated instead of in one burst at the end
      eager_input_streaming: true,
    }));
    // Breakpoint on the last tool caches tools + system together (prefix order tools -> system).
    tools[tools.length - 1]!.cache_control = { type: 'ephemeral' };
    body.tools = tools;
    if (req.toolChoice !== undefined) body.tool_choice = toolChoice(req.toolChoice);
  }
  // The engine copies the effective value into the request; null means "do not send the parameter"
  // (core/types.ts GenerateRequest), so cfg.temperature is deliberately not consulted here.
  if (req.temperature !== null) body.temperature = req.temperature;
  return body;
}

function toolChoice(tc: NonNullable<GenerateRequest['toolChoice']>): AnthropicToolChoice {
  // Jev owns control flow: exactly one action per step, so parallel tool use is always off.
  if (tc === 'auto') return { type: 'auto', disable_parallel_tool_use: true };
  if (tc === 'required') return { type: 'any', disable_parallel_tool_use: true };
  return { type: 'tool', name: tc.name, disable_parallel_tool_use: true };
}

/**
 * AGENT-LOOP-DESIGN §6.5: every agent request is sent under both betas — context editing (the `context_management`
 * field, §7.3) and the thinking-binding controls (`thinking.block_binding`, whose absence of the header is a 400
 * `block_binding: Extra inputs are not permitted`). Legacy requests send neither.
 */
export const ANTHROPIC_AGENT_BETA = 'context-management-2025-06-27,thinking-binding-controls-2026-08-01';

/**
 * AGENT-LOOP-DESIGN §6.2 (Anthropic row), §6.3, §6.5: the agent turn. Adaptive thinking, `display: 'summarized'` (Sonnet 5
 * defaults to `omitted`, a long silent pause) and an EXPLICIT `prefix_mismatch_behavior` — `drop_block` in production,
 * `error` with `strictReplay` so any prefix edit fails the check; thinking is never disabled (Opus 5.5 / Fable 5.1 answer
 * `disabled` with a 400). `reasoning.effort` → `output_config.effort`; `{enabled: false}` / `{maxTokens}` map to nothing.
 * `temperature` is never sent: with thinking on, a non-default value is a 400 (and Sonnet 5 rejects sampling parameters
 * outright). Parallel tool use stays on unless the caller asked for one call per turn. Caching: the system and last-tool
 * breakpoints of the legacy body plus the top-level automatic one (3 of the 4 allowed). `clearToolResults` → one
 * `clear_tool_uses_20250919` edit, server-side clearing that does not count as a prefix edit.
 */
function buildAgentBody(cfg: GeneratorConfig, req: GenerateRequest, a: AgentRequest): AnthropicRequestBody {
  const body: AnthropicRequestBody = {
    model: cfg.model,
    max_tokens: req.maxTokens,
    stream: true,
    messages: a.messages.map((m) => ({ role: m.role, content: m.role === 'user' ? userContent(m) : assistantContent(m, replayData(a, m, 'anthropic', cfg.model)) })),
  };
  if (req.system.length > 0) body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  if (req.tools && req.tools.length > 0) {
    const tools: AnthropicToolDef[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: anthropicInputSchema(t.inputSchema), strict: true, eager_input_streaming: true }));
    tools[tools.length - 1]!.cache_control = { type: 'ephemeral' };
    body.tools = tools;
    if (req.toolChoice !== undefined) {
      const tc = toolChoice(req.toolChoice);
      if (a.parallelToolCalls) delete tc.disable_parallel_tool_use;
      body.tool_choice = tc;
    }
  }
  body.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: a.strictReplay === true ? 'error' : 'drop_block' } };
  if (req.reasoning !== undefined && 'effort' in req.reasoning) body.output_config = { effort: req.reasoning.effort };
  const c = a.clearToolResults;
  if (c !== undefined) {
    body.context_management = {
      edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: c.triggerTokens }, keep: { type: 'tool_uses', value: c.keep }, clear_at_least: { type: 'input_tokens', value: c.clearAtLeastTokens } }],
    };
  }
  body.cache_control = { type: 'ephemeral' };
  return body;
}

/** One user message: every `tool_result` first, then the texts (parallel-tool-use docs: results first, in one message). */
function userContent(m: Extract<AgentMessage, { role: 'user' }>): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  for (const b of m.content) if (b.type === 'tool_result') out.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError === true ? { is_error: true as const } : {}) });
  for (const b of m.content) if (b.type === 'text' && b.text.length > 0) out.push({ type: 'text', text: b.text });
  return out;
}

/**
 * The replay state this adapter captures (`providerState.data.blocks`): the turn's content in wire order — thinking and
 * redacted-thinking blocks verbatim, text blocks with their text, tool_use blocks by id — so a replay puts each thinking
 * block back at its own position (a thinking block's signature binds everything before it).
 */
type ReplayBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string } | { type: 'text'; text: string } | { type: 'tool_use'; id: string };

function replayBlocks(data: Json | null): ReplayBlock[] | null {
  const raw = isJsonObject(data) ? data['blocks'] : undefined;
  if (!Array.isArray(raw)) return null;
  const out: ReplayBlock[] = [];
  for (const b of raw) {
    if (!isJsonObject(b)) continue;
    const s = (k: string): string | null => (typeof b[k] === 'string' ? (b[k] as string) : null);
    if (b['type'] === 'thinking' && s('thinking') !== null && s('signature') !== null) out.push({ type: 'thinking', thinking: s('thinking')!, signature: s('signature')! });
    else if (b['type'] === 'redacted_thinking' && s('data') !== null) out.push({ type: 'redacted_thinking', data: s('data')! });
    else if (b['type'] === 'text' && s('text') !== null) out.push({ type: 'text', text: s('text')! });
    else if (b['type'] === 'tool_use' && s('id') !== null) out.push({ type: 'tool_use', id: s('id')! });
  }
  return out;
}

/**
 * An assistant turn. Without replay state: its blocks in transcript order (empty text dropped — the API rejects it). With
 * it: the captured wire order, thinking verbatim; the text keeps the wire's segmentation when the transcript's text is the
 * same prose, else the transcript's text goes where the first text block was; calls are the transcript's (its input may
 * be repaired), matched by id; anything the capture did not list is appended.
 */
function assistantContent(m: Extract<AgentMessage, { role: 'assistant' }>, data: Json | null): AnthropicContentBlock[] {
  const texts: AnthropicContentBlock[] = [];
  const uses = new Map<string, AnthropicContentBlock>();
  const plain: AnthropicContentBlock[] = [];
  for (const b of m.content) {
    const block: AnthropicContentBlock | null = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: objectInput(b.input) } : b.text.length > 0 ? { type: 'text', text: b.text } : null;
    if (block === null) continue;
    plain.push(block);
    if (block.type === 'tool_use') uses.set(block.id, block);
    else texts.push(block);
  }
  const stored = replayBlocks(data);
  if (stored === null || !stored.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) return plain;
  const prose = (bs: readonly (ReplayBlock | AnthropicContentBlock)[]): string => bs.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const segmented = prose(stored) === prose(texts);
  const out: AnthropicContentBlock[] = [];
  let textPlaced = false;
  for (const b of stored) {
    if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push(b);
    else if (b.type === 'text') {
      if (segmented) {
        if (b.text.length > 0) out.push({ type: 'text', text: b.text });
      } else if (!textPlaced) out.push(...texts);
      textPlaced = true;
    } else {
      const u = uses.get(b.id);
      if (u !== undefined) out.push(u);
      uses.delete(b.id);
    }
  }
  if (!textPlaced && !segmented) {
    const firstUse = out.findIndex((b) => b.type === 'tool_use');
    out.splice(firstUse === -1 ? out.length : firstUse, 0, ...texts);
  }
  out.push(...uses.values());
  return out;
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; json: string; startInput: Json; ordinal: number }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted'; data: string }
  | { kind: 'other' };

interface StreamOutcome {
  text: string;
  toolCalls: ToolCall[];
  tokens: TokenBreakdown;
  model: string | null;
  /** `message_start.message.id` (`msg_…`), redacted and clipped like a request id */
  generationId: string | null;
  stopReason: string;
  /** agent requests only (AGENT-LOOP-DESIGN §6.1, §6.5, §7.3) */
  providerState?: ProviderReplayState;
  contextEdits?: { clearedToolUses: number; clearedInputTokens: number };
  warnings?: string[];
}

/**
 * §6.5: a non-empty `input_transformations` (on `message_start`, again on a final `message_delta` after a server-side
 * fallback) → one line per entry naming its `reason`; an entry of an unknown shape still yields a line.
 */
function transformationLines(list: Json | undefined, into: string[]): void {
  if (!Array.isArray(list)) return;
  for (const t of list) {
    if (!isJsonObject(t)) continue;
    const path = getStr(t, 'path');
    into.push(`anthropic ${getStr(t, 'type') ?? 'input transformation'}: ${getStr(t, 'reason') ?? 'unknown reason'}${path !== null ? ` at ${path}` : ''}`);
  }
}

/** §7.3: `context_management.applied_edits` → the tool uses and input tokens the server cleared; null when none was applied. */
function appliedEdits(cm: JsonObject | null): { clearedToolUses: number; clearedInputTokens: number } | null {
  const edits = getArr(cm, 'applied_edits');
  if (edits === null || edits.length === 0) return null;
  let clearedToolUses = 0;
  let clearedInputTokens = 0;
  for (const e of edits) {
    if (!isJsonObject(e)) continue;
    clearedToolUses += Math.max(0, Math.round(getNum(e, 'cleared_tool_uses') ?? 0));
    clearedInputTokens += Math.max(0, Math.round(getNum(e, 'cleared_input_tokens') ?? 0));
  }
  return { clearedToolUses, clearedInputTokens };
}

/** §4.8: set in the abort branch with what the stream had produced; `generate` reads it after the retry loop rethrows the abort reason. */
type Held = { partial: StreamPartial | null };

function readUsage(u: JsonObject | null, into: TokenBreakdown): void {
  if (!u) return;
  // message_delta.usage is cumulative; each field present overwrites the earlier value.
  const input = getNum(u, 'input_tokens');
  const cw = getNum(u, 'cache_creation_input_tokens');
  const cr = getNum(u, 'cache_read_input_tokens');
  const out = getNum(u, 'output_tokens');
  if (input !== null) into.input = Math.max(0, Math.round(input));
  if (cw !== null) into.cacheWrite = Math.max(0, Math.round(cw));
  if (cr !== null) into.cacheRead = Math.max(0, Math.round(cr));
  if (out !== null) into.output = Math.max(0, Math.round(out));
}

function streamError(data: JsonObject, redact: (s: string) => string, requestId: string | null): ProviderHttpError {
  const err = getObj(data, 'error');
  const type = getStr(err, 'type') ?? 'unknown_error';
  const message = getStr(err, 'message') ?? '';
  const status = ERROR_TYPE_STATUS[type] ?? 500;
  return new ProviderHttpError(clipMessage(redact(`anthropic stream error ${type} (${status}): ${message}`)), {
    status,
    retryable: isRetryableStatus(status),
    body: redact(JSON.stringify(data)).slice(0, 2048),
    requestId, // TUI-DESIGN §15 item 4: the 200 response's request-id names the stream that failed
  });
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  opts: GenerateOptions,
  redact: (s: string) => string,
  firstByteTimeoutMs: number,
  requestId: string | null,
  held: Held,
  agentModel: string | null,
  onFirstByte?: (ms: number) => void,
): Promise<StreamOutcome> {
  const blocks = new Map<number, Block>();
  // blocks in stream order; `blocks` maps an index to its CURRENT block, so a second start at a used index is a new block, never a duplicate
  const order: Block[] = [];
  let text = '';
  let toolChars = 0;
  // AGENT-LOOP-DESIGN §6.1: agent-only facts (a legacy request records none of them, so its result is unchanged)
  let reasoningChars = 0;
  let toolOrdinal = 0;
  const notices: string[] = [];
  let edits: { clearedToolUses: number; clearedInputTokens: number } | null = null;
  let model: string | null = null;
  let generationId: string | null = null;
  let stopReason: string | null = null;
  let sawStop = false;
  let sawDelta = false;
  const tokens: TokenBreakdown = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  try {
    for await (const rec of parseSse(body, { signal: opts.signal, firstByteTimeoutMs, ...(onFirstByte === undefined ? {} : { onFirstByte }) })) {
      // parseSse yields every record of a chunk before it reads again; a signal that fired mid-chunk stops here, not at the next read
      if (opts.signal.aborted) throw opts.signal.reason;
      // Live streams pad the JSON with trailing spaces; parse the trimmed text.
      const parsed = parseJson(rec.data.trim());
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        // TUI-DESIGN §15 item 5: RetryCause kind 'invalid'. A fixed hint, never `parsed.error`: V8's JSON.parse message embeds a
        // body snippet ("Unexpected token 'o', \"not json sk\"... is not valid JSON") that pattern redaction cannot recognise;
        // the event name is wire text too, so it is redacted and clipped.
        const eventLabel = rec.event === undefined ? 'no event' : clip(rec.event, 40);
        throw new TransportError('invalid', clipMessage(redact(`anthropic: malformed sse data (${eventLabel}): ${parsed.ok ? 'not a JSON object' : 'not valid JSON'}`)));
      }
      const data = parsed.value;
      const type = getStr(data, 'type') ?? rec.event ?? '';
      switch (type) {
        case 'message_start': {
          const msg = getObj(data, 'message');
          model = getStr(msg, 'model') ?? model;
          // wire text that reaches state.json and the transcript → redacted and clipped like a request id
          if (generationId === null) generationId = sanitiseRequestId(getStr(msg, 'id'), redact);
          readUsage(getObj(msg, 'usage'), tokens);
          if (agentModel !== null) {
            transformationLines(msg?.['input_transformations'], notices);
            edits = appliedEdits(getObj(msg, 'context_management')) ?? edits;
          }
          break;
        }
        case 'content_block_start': {
          const index = getNum(data, 'index');
          const cb = getObj(data, 'content_block');
          if (index === null || !cb) break;
          const cbType = getStr(cb, 'type');
          let block: Block;
          if (cbType === 'text') {
            const initial = getStr(cb, 'text') ?? '';
            block = { kind: 'text', text: initial };
            if (initial.length > 0) {
              text += initial;
              notify(opts.onDelta, initial);
            }
          } else if (cbType === 'tool_use') {
            block = { kind: 'tool_use', id: getStr(cb, 'id') ?? '', name: getStr(cb, 'name') ?? '', json: '', startInput: cb['input'] ?? null, ordinal: toolOrdinal++ };
            // §6.1: the call is named before its first argument fragment
            emitToolCall(opts, block.ordinal, block.id, block.name, '');
          } else if (cbType === 'thinking') {
            const initial = getStr(cb, 'thinking') ?? '';
            block = { kind: 'thinking', thinking: initial, signature: getStr(cb, 'signature') ?? '' };
            if (initial.length > 0) notify(opts.onReasoning, initial);
          } else if (cbType === 'redacted_thinking') block = { kind: 'redacted', data: getStr(cb, 'data') ?? '' };
          else block = { kind: 'other' };
          blocks.set(index, block);
          order.push(block);
          break;
        }
        case 'content_block_delta': {
          const index = getNum(data, 'index');
          const delta = getObj(data, 'delta');
          const block = index === null ? undefined : blocks.get(index);
          const dType = getStr(delta, 'type');
          if (dType === 'text_delta') {
            const t = getStr(delta, 'text') ?? '';
            if (t.length > 0) {
              text += t;
              if (block?.kind === 'text') block.text += t;
              notify(opts.onDelta, t);
            }
          } else if (dType === 'input_json_delta' && block?.kind === 'tool_use') {
            const frag = getStr(delta, 'partial_json') ?? '';
            if (frag.length > 0) {
              block.json += frag;
              toolChars += frag.length;
              notify(opts.onToolDelta, frag);
              emitToolCall(opts, block.ordinal, block.id, block.name, frag);
            }
          } else if (dType === 'thinking_delta' && block?.kind === 'thinking') {
            // §6.2: the summarized thinking streams to `onReasoning`; the text and signature are kept for replay
            const t = getStr(delta, 'thinking') ?? '';
            if (t.length > 0) {
              block.thinking += t;
              if (agentModel !== null) reasoningChars += t.length;
              notify(opts.onReasoning, t);
            }
          } else if (dType === 'signature_delta' && block?.kind === 'thinking') block.signature += getStr(delta, 'signature') ?? '';
          // unknown deltas carry nothing the harness shows
          break;
        }
        case 'content_block_stop':
          break;
        case 'message_delta': {
          const delta = getObj(data, 'delta');
          stopReason = getStr(delta, 'stop_reason') ?? stopReason;
          readUsage(getObj(data, 'usage'), tokens);
          sawDelta = true;
          if (agentModel !== null) {
            transformationLines(data['input_transformations'] ?? delta?.['input_transformations'], notices);
            edits = appliedEdits(getObj(data, 'context_management') ?? getObj(delta, 'context_management')) ?? edits;
          }
          break;
        }
        case 'message_stop':
          sawStop = true;
          break;
        case 'ping':
          break;
        case 'error':
          throw streamError(data, redact, requestId);
        default:
          // "new event types may be added, and your code should handle unknown event types gracefully"
          break;
      }
      if (sawStop) break;
    }
  } catch (e) {
    if (opts.signal.aborted) {
      // §4.8: the signal fired while the stream was open. Record the message id and the streamed sizes (and the usage when
      // message_delta had already delivered the output count), then rethrow the reason: the sample yields no GenerateResult.
      held.partial = { text, toolChars, reasoningChars, model, generationId, servedProvider: null, tokens: sawDelta ? tokens : null, cost: null, reasoningTokens: null };
      throw opts.signal.reason;
    }
    throw e;
  }
  if (!sawStop && !sawDelta) {
    // TUI-DESIGN §15 item 5: RetryCause kind 'stream'
    throw new TransportError('stream', 'anthropic: stream ended before message_delta/message_stop');
  }

  const toolCalls: ToolCall[] = [];
  const replay: JsonObject[] = [];
  let thought = false;
  for (const b of order) {
    if (b.kind === 'tool_use') {
      const call = toToolCall(b);
      if (agentModel !== null) call.id = agentCallId(b.id, b.ordinal);
      toolCalls.push(call);
      replay.push({ type: 'tool_use', id: call.id ?? '' });
    } else if (b.kind === 'text') replay.push({ type: 'text', text: b.text });
    else if (b.kind === 'thinking') {
      thought = true;
      replay.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    } else if (b.kind === 'redacted') {
      thought = true;
      replay.push({ type: 'redacted_thinking', data: b.data });
    }
  }
  const out: StreamOutcome = { text, toolCalls, tokens, model, generationId, stopReason: stopReason ?? (sawStop ? 'end_turn' : 'unknown') };
  if (agentModel !== null) {
    // §6.5: the turn's content in wire order, thinking verbatim and unredacted (a redaction could corrupt a signature)
    if (thought) out.providerState = { provider: 'anthropic', model: agentModel, data: { blocks: replay } };
    if (edits !== null) out.contextEdits = edits;
    if (notices.length > 0) out.warnings = warningLines(notices, redact);
  }
  return out;
}

/**
 * Tool input is parsed once, at the end. With eager streaming the server does not validate the
 * JSON, so a truncated (max_tokens) or invalid input yields `input: null` with the raw text kept;
 * actions.ts rejects it as a malformed proposal while usage is still returned and billed.
 */
function toToolCall(b: Extract<Block, { kind: 'tool_use' }>): ToolCall {
  if (b.json.length === 0) {
    const raw = JSON.stringify(b.startInput ?? {});
    return { name: b.name, input: b.startInput ?? {}, rawJson: raw };
  }
  const parsed = parseJson(b.json);
  return { name: b.name, input: parsed.ok ? parsed.value : null, rawJson: b.json };
}

export function createAnthropicProvider(cfg: GeneratorConfig, deps: ProviderDeps): Provider {
  const d = resolveDeps(deps);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  // The Messages API reports tokens only, so the table prices every call (config fails closed on an unpriced model, §9.5).
  const tablePrice = (t: TokenBreakdown): number => costFromPricing(cfg.pricing, t);

  async function attempt(body: string, opts: GenerateOptions, held: Held, agentModel: string | null): Promise<StreamOutcome> {
    const { controller, unlink } = linkedAbort(opts.signal);
    const t0 = d.now();
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The header phase shares the first-byte budget: a server that never answers is a network error.
      const headersTimeout = new Promise<never>((_, reject) => {
        headersTimer = setTimeout(() => {
          controller.abort(new IdleTimeoutError('first_byte', FIRST_BYTE_TIMEOUT_MS));
          reject(new IdleTimeoutError('first_byte', FIRST_BYTE_TIMEOUT_MS));
        }, FIRST_BYTE_TIMEOUT_MS);
      });
      let res: Response;
      try {
        res = await Promise.race([
          d.fetch(url, {
            method: 'POST',
            headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', accept: 'text/event-stream', ...(agentModel !== null ? { 'anthropic-beta': ANTHROPIC_AGENT_BETA } : {}) },
            body,
            signal: controller.signal,
          }),
          headersTimeout,
        ]);
      } catch (e) {
        if (opts.signal.aborted) throw opts.signal.reason;
        if (e instanceof ProviderHttpError) throw e;
        // TUI-DESIGN §15 item 5: RetryCause kind 'network' with the errno from the cause chain
        throw new TransportError('network', d.redact(`anthropic: network error: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
      } finally {
        clearTimeout(headersTimer);
      }
      // TUI-DESIGN §15 item 4: Anthropic sends `request-id` as a header and `request_id` in error bodies; both are wire text → redacted (F9)
      const requestId = requestIdOf(res.headers, d.redact);
      if (res.status !== 200) {
        const bodyText = await readBodyCapped(res);
        const json = parseJsonObject(bodyText);
        const err = getObj(json, 'error');
        const kind = getStr(err, 'type') ?? undefined;
        const message = getStr(err, 'message') ?? undefined;
        // A spend-cap 429 has no retry-after and "keeps failing until access resumes".
        const spendLimit = res.status === 429 && res.headers.get('retry-after') === null && getStr(getObj(err, 'details'), 'error_code') === 'enforced_spend_limit_reached';
        throw httpError({
          provider: 'anthropic',
          status: res.status,
          headers: res.headers,
          body: bodyText,
          redact: d.redact,
          requestId: requestId ?? getStr(json, 'request_id'),
          ...(kind !== undefined ? { kind } : {}),
          ...(message !== undefined ? { message } : {}),
          ...(spendLimit ? { retryableOverride: false } : {}),
        });
      }
      if (!res.body) throw new TransportError('stream', 'anthropic: 200 without a body');
      const remaining = Math.max(1, FIRST_BYTE_TIMEOUT_MS - (d.now() - t0));
      // contract 1.9 (Fastlane) §3.1: TTFB measured from the request going out (header phase included); `reportFirstByte`
      // reports it once per `generate()` — this client's retry loop re-runs the body, and a mid-stream 429/5xx frame lands
      // AFTER the stream opened, so a per-attempt report would enter two readings into the §3.2 threshold's p50.
      const onFirstByte = opts.onFirstByte === undefined ? undefined : (): void => reportFirstByte(opts, Math.round(d.now() - t0));
      try {
        return await consumeStream(res.body, opts, d.redact, remaining, requestId, held, agentModel, onFirstByte);
      } catch (e) {
        if (opts.signal.aborted) throw opts.signal.reason;
        // Typed errors (HTTP/stream errors, renderer-callback bugs via notify) keep their class; anything
        // else (decoder faults, stream resets) is a transport failure and retried (RetryCause kind 'stream').
        if (e instanceof JevCodeError) throw e;
        throw new TransportError('stream', d.redact(`anthropic: stream failure: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
      } finally {
        // a no-op for the connection once parseSse has drained the body to EOF: the socket is already back in the pool (keepalive.test.ts)
        controller.abort();
      }
    } finally {
      unlink();
    }
  }

  return {
    name: 'anthropic',
    model: cfg.model,
    async generate(req: GenerateRequest, opts: GenerateOptions): Promise<GenerateResult> {
      validateRequest(req);
      const body = JSON.stringify(buildAnthropicBody(cfg, req));
      const t0 = d.now();
      const held: Held = { partial: null };
      let out: StreamOutcome;
      try {
        // TUI-DESIGN §15.2 `provider/anthropic.ts`: GenerateOptions.onRetry / wake thread into withRetry (§13.2)
        out = await withRetry(d, opts.signal, () => attempt(body, opts, held, req.agent !== undefined ? cfg.model : null), opts);
      } catch (e) {
        // §4.8, as openrouter.ts: onCancelled runs outside the retry loop (whose catches rethrow signal.reason whenever the
        // signal is aborted), so a throwing callback surfaces as 'internal' like a throwing onDelta instead of vanishing.
        if (held.partial !== null) notify(opts.onCancelled, toCancelledGeneration(held.partial, tablePrice));
        throw e;
      }
      return {
        text: out.text,
        toolCalls: out.toolCalls,
        usage: toTokenUsage(out.tokens, tablePrice(out.tokens)),
        model: out.model ?? cfg.model,
        stopReason: out.stopReason,
        latencyMs: Math.round(d.now() - t0),
        ...(out.generationId !== null ? { generationId: out.generationId } : {}),
        ...(out.providerState !== undefined ? { providerState: out.providerState } : {}),
        ...(out.contextEdits !== undefined ? { contextEdits: out.contextEdits } : {}),
        ...(out.warnings !== undefined ? { warnings: out.warnings } : {}),
      };
    },
  };
}
