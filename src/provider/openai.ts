/**
 * OpenAI client over raw fetch + SSE. Two surfaces, one provider:
 *
 *  - `api: 'responses'` (the DEFAULT) — `POST /v1/responses`, the API OpenAI recommends for new projects and the only one
 *    that takes function tools on the current flagships. Measured 2026-09-21 against `gpt-5.6-terra` and `gpt-6-astra`:
 *    flat strict tools + a named `tool_choice` + `parallel_tool_calls: false` + `reasoning: {effort}` + `store: false`
 *    stream a forced tool call in ~2 s, and the terminal `response.completed` carries the full usage
 *    (`input_tokens_details.cached_tokens` / `cache_write_tokens`, `output_tokens_details.reasoning_tokens`).
 *  - `api: 'chat'` — `POST /v1/chat/completions`, kept for the 4.x-era ids and for OpenAI-compatible gateways. It is a
 *    thin `openai-compat.ts` quirks table.
 *
 * Live findings that shaped the tables (each one is a 400 this client now cannot produce):
 *  - `temperature` → `400 Unsupported parameter: 'temperature' is not supported with this model` on gpt-5.6-terra, so a
 *    non-null temperature is sent only for the gpt-4.1 / gpt-4o / gpt-4 / gpt-3.5 families.
 *  - `seed` → `400 Unknown parameter: 'seed'` on the Responses API: LLM-JEV-DESIGN §4.6's per-sample seed cannot be
 *    honoured here and is dropped (the sibling samples of a round differ by nothing on OpenAI — the engine's own facts).
 *  - Chat Completions + function tools → `400 Function tools with reasoning_effort are not supported for gpt-5.6-terra in
 *    /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'` — and the same 400
 *    arrives when `reasoning_effort` is omitted entirely (the model's default effort is what it objects to). The chat
 *    quirks table therefore pins `reasoning_effort: 'none'` whenever tools are present on a reasoning-era id.
 *  - `strict: true` is sent only for a schema OpenAI's strict mode accepts (provider/schema.ts). The harness's own
 *    `propose_action` schema (oneOf + const + minItems + an optional property) does not qualify, so it goes out
 *    non-strict — which the live check confirms is accepted and still produces valid arguments.
 *  - `developer` is the reasoning-era name for the system message; api.openai.com accepts it AND `system` on both
 *    families (checked on gpt-4.1-mini and gpt-5.6-terra / gpt-6-astra), but `system` is the only one a third-party
 *    OpenAI-compatible server is sure to know — so the chat surface picks the role per model (`openAiSystemRole`)
 *    rather than pinning `developer`, exactly as it picks `temperature`.
 *  - A reasoning-era id that does not accept `reasoning_effort: 'none'` (gpt-6-astra: `does not support 'none' with
 *    this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'`) therefore cannot take function tools on
 *    `/chat/completions` at all — `none` is a 400, and every other value (omission included) is the 400 above. That
 *    request is refused here, before the fetch, rather than sent as a guaranteed 400.
 *  - `reasoning_effort: 'max'` is a 400 on `/chat/completions` for both gpt-5.6-terra and gpt-6-astra but a 200 on
 *    `/v1/responses` for both, so the chat surface has its own word list (`openAiChatEfforts`).
 */
import { ProviderHttpError } from '../errors.js';
import { isJsonObject, parseJson } from '../core/json.js';
import type { AgentRequest, GenerateOptions, GenerateReasoning, GenerateRequest, GenerateResult, JsonObject, ToolCall, ToolChoice, ToolSpec } from '../core/types.js';
import { checkOpenAiStrict } from './schema.js';
import { agentCallId, agentReasoning, assistantParts, createCaller, emitToolCall, getJson, joinUrl, objectInput, openAiErrorFields, replayData, runGeneration, sortModels, userParts, validateGenerateRequest } from './http.js';
import type { ConsumeContext, HeldPartial } from './http.js';
import { createChatProvider, effortOf, pickEffort } from './openai-compat.js';
import type { ChatQuirks, ChatRequestBody, EffortWord } from './openai-compat.js';
import { TransportError, clipMessage, countOf, getArr, getNum, getObj, getStr, isRateLimit, isRetryableStatus, notify, parseSse, resolveDeps, sanitiseRequestId } from './sse.js';
import type { GenerationProvider, ModelInfo, ProviderConfig, ProviderDeps, ProviderOutcome, StreamPartial, TokenBreakdown } from './types.js';

import { PROVIDER_BASE_URL } from './ids.js';
export const OPENAI_BASE_URL = PROVIDER_BASE_URL.openai;
/** developers.openai.com/api/docs/models — the mid-tier 2026-09 flagship: 1.05M context, 128K output, $2/$12 per 1M. */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.6-luna';

// ---------------------------------------------------------------------------------------
// Reasoning effort and temperature per model family
// ---------------------------------------------------------------------------------------

const EFFORTS_GPT6: readonly EffortWord[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_GPT56: readonly EffortWord[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_GPT5: readonly EffortWord[] = ['minimal', 'low', 'medium', 'high'];
const EFFORTS_O_SERIES: readonly EffortWord[] = ['low', 'medium', 'high'];

/**
 * The effort words a model id accepts, or null for a model with no reasoning control at all (gpt-4.1 / gpt-4o / gpt-4 /
 * gpt-3.5). `gpt-6-astra` rejects `none` (docs/guides/reasoning) — the substitution chain in openai-compat.ts then picks
 * `low`, the lowest it does accept, instead of sending a value the API would refuse.
 */
export function openAiEfforts(model: string): readonly EffortWord[] | null {
  if (/^gpt-6/.test(model)) return EFFORTS_GPT6;
  if (/^gpt-5\.6/.test(model)) return EFFORTS_GPT56;
  if (/^(gpt-5|o3|o4)/.test(model)) return /^o[34]/.test(model) ? EFFORTS_O_SERIES : EFFORTS_GPT5;
  return null;
}

/** GPT-5.x and later answer 400 for any sampling parameter; only the 4.x / 3.5 families still take one. */
export function openAiAcceptsTemperature(model: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-4-|gpt-4$|gpt-3\.5|chatgpt-4o)/.test(model);
}

/**
 * The words `/v1/chat/completions` accepts — the Responses vocabulary MINUS `max`. Measured 2026-09-21: chat answers
 * `400 Unsupported value: 'reasoning_effort' does not support 'max' with this model` on BOTH gpt-5.6-terra and
 * gpt-6-astra (`Supported values are: 'none', 'low', 'medium', 'high', 'xhigh'` / the same without `none`), while
 * `/v1/responses` accepts `max` on both. The effort set is per SURFACE as well as per model, so the chat quirk
 * substitutes down the chain (`max` → `xhigh`) instead of sending a value only the other surface takes.
 */
export function openAiChatEfforts(model: string): readonly EffortWord[] | null {
  const all = openAiEfforts(model);
  return all === null ? null : all.filter((e) => e !== 'max');
}

/**
 * The role the system prompt goes out under on `/chat/completions`. Measured 2026-09-21, api.openai.com accepts BOTH
 * `system` and `developer` on both families (4.1-mini and 5.6-terra / 6-astra), so this is not about an OpenAI 400: it
 * is about the OTHER half of this surface's audience. `developer` is the reasoning-era name OpenAI documents for the
 * reasoning models, and `system` is the only role a third-party OpenAI-compatible server can be relied on to know —
 * pinning `developer` for everyone is what a gateway pointed at this surface would reject. `openAiEfforts` already
 * names the reasoning-era families, so it is the same table.
 */
export function openAiSystemRole(model: string): 'system' | 'developer' {
  return openAiEfforts(model) !== null ? 'developer' : 'system';
}

/** LLM-JEV-DESIGN §4.12 → `reasoning: {effort}`; `{maxTokens}` has no counterpart (no thinking budget on either OpenAI surface) and is dropped. */
export function openAiReasoningEffort(r: GenerateReasoning, model: string): EffortWord | null {
  const allowed = openAiEfforts(model);
  if (allowed === null) return null;
  const wanted = effortOf(r);
  return wanted === null ? null : pickEffort(wanted, allowed);
}

// ---------------------------------------------------------------------------------------
// Responses API wire types (request side)
// ---------------------------------------------------------------------------------------

export type ResponsesContentPart = { type: 'input_text'; text: string } | { type: 'output_text'; text: string };
/**
 * An input item: the legacy text message, or an agent item (AGENT-LOOP-DESIGN §6.2) — a replayed `reasoning` output item
 * (verbatim JSON, `encrypted_content` included), a `function_call` by `call_id`, a `function_call_output`.
 */
export type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | JsonObject;
export type ResponsesToolWire = { type: 'function'; name: string; description: string; parameters: JsonObject; strict?: true };
export type ResponsesToolChoiceWire = 'auto' | 'required' | 'none' | { type: 'function'; name: string };
export type ResponsesRequestBody = {
  model: string;
  input: ResponsesInputItem[];
  /** the Responses API's system prompt; NOT carried over by `previous_response_id`, so it is sent every turn */
  instructions?: string;
  tools?: ResponsesToolWire[];
  tool_choice?: ResponsesToolChoiceWire;
  parallel_tool_calls?: false;
  /** includes hidden reasoning tokens: a small budget can be eaten by thinking (`incomplete_details.reason`) */
  max_output_tokens: number;
  /** agent requests add `summary: 'auto'`, which is what streams `response.reasoning_summary_text.delta` to `onReasoning` */
  reasoning?: { effort?: EffortWord; summary?: 'auto' };
  /** false keeps the request out of the 30-day store (and disables `previous_response_id`, which the harness never uses) */
  store: false;
  stream: true;
  temperature?: number;
  /** agent with replay on: the reasoning items come back with `encrypted_content`, the only way to replay them with `store: false` */
  include?: ['reasoning.encrypted_content'];
  /** agent: `AgentRequest.cacheKey` */
  prompt_cache_key?: string;
};

/**
 * Exported so tests can assert the exact wire body. The harness's history is plain text, so the input is a flat list of
 * message items — `input_text` parts for the user turns and `output_text` parts for the assistant ones (the shape a
 * stored conversation replays; verified live with a three-message history).
 */
export function buildResponsesBody(cfg: ProviderConfig, req: GenerateRequest): ResponsesRequestBody {
  if (req.agent !== undefined) return buildResponsesAgentBody(cfg, req, req.agent);
  const body: ResponsesRequestBody = {
    model: cfg.model,
    input: req.messages.map((m) => ({
      type: 'message',
      role: m.role,
      content: [m.role === 'assistant' ? { type: 'output_text', text: m.content } : { type: 'input_text', text: m.content }],
    })),
    max_output_tokens: req.maxTokens,
    store: false,
    stream: true,
  };
  if (req.system.length > 0) body.instructions = req.system;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(responsesTool);
    if (req.toolChoice !== undefined) body.tool_choice = responsesToolChoice(req.toolChoice);
    body.parallel_tool_calls = false;
  }
  if (req.temperature !== null && openAiAcceptsTemperature(cfg.model)) body.temperature = req.temperature;
  if (req.reasoning !== undefined) {
    const effort = openAiReasoningEffort(req.reasoning, cfg.model);
    if (effort !== null) body.reasoning = { effort };
  }
  // `seed` is deliberately absent: the Responses API answers 400 `Unknown parameter: 'seed'` (live 2026-09-21).
  return body;
}

/**
 * AGENT-LOOP-DESIGN §6.2, OpenAI Responses row: the transcript as input items — per assistant turn its replayed reasoning
 * items (same configured model only), an `output_text` message when it has prose, a `function_call` per call; per user
 * turn a `function_call_output` per result, then an `input_text` message for the texts. `include` asks for the encrypted
 * reasoning while replay is on; `prompt_cache_key` = the session; no `parallel_tool_calls` unless one call per turn.
 */
function buildResponsesAgentBody(cfg: ProviderConfig, req: GenerateRequest, a: AgentRequest): ResponsesRequestBody {
  const input: ResponsesInputItem[] = [];
  for (const m of a.messages) {
    if (m.role === 'user') {
      const { results, texts } = userParts(m.content);
      for (const r of results) input.push({ type: 'function_call_output', call_id: r.toolUseId, output: r.content });
      if (texts.length > 0) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: texts.join('\n\n') }] });
      continue;
    }
    const { text, calls } = assistantParts(m.content);
    const msg: ResponsesInputItem | null = text.length > 0 ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } : null;
    const fcs = new Map(calls.map((c) => [c.id, { type: 'function_call' as const, call_id: c.id, name: c.name, arguments: JSON.stringify(objectInput(c.input)) }]));
    const data = replayData(a, m, 'openai', cfg.model);
    const stored = isJsonObject(data) && Array.isArray(data['output']) ? data['output'].filter(isJsonObject) : [];
    // the captured output order: reasoning items verbatim where they were, the message and the calls at their markers
    let msgPlaced = false;
    for (const s of stored) {
      if (s['type'] === 'reasoning') input.push(s);
      else if (s['type'] === 'message' && msg !== null && !msgPlaced) {
        input.push(msg);
        msgPlaced = true;
      } else if (s['type'] === 'function_call') {
        const callId = getStr(s, 'call_id') ?? '';
        const fc = fcs.get(callId);
        if (fc === undefined) continue;
        const itemId = getStr(s, 'id');
        input.push(itemId !== null ? { ...fc, id: itemId } : fc);
        fcs.delete(callId);
      }
    }
    if (msg !== null && !msgPlaced) input.push(msg);
    input.push(...fcs.values());
  }
  const body: ResponsesRequestBody = { model: cfg.model, input, max_output_tokens: req.maxTokens, store: false, stream: true };
  if (req.system.length > 0) body.instructions = req.system;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(responsesTool);
    if (req.toolChoice !== undefined) body.tool_choice = responsesToolChoice(req.toolChoice);
    if (!a.parallelToolCalls) body.parallel_tool_calls = false;
  }
  if (req.temperature !== null && openAiAcceptsTemperature(cfg.model)) body.temperature = req.temperature;
  const reasoning = agentReasoning(req);
  const effort = reasoning === undefined ? null : openAiReasoningEffort(reasoning, cfg.model);
  if (openAiEfforts(cfg.model) !== null) body.reasoning = { ...(effort !== null ? { effort } : {}), summary: 'auto' };
  if (a.replayReasoning) body.include = ['reasoning.encrypted_content'];
  if (a.cacheKey.length > 0) body.prompt_cache_key = a.cacheKey;
  return body;
}

function responsesTool(t: ToolSpec): ResponsesToolWire {
  const tool: ResponsesToolWire = { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema };
  if (checkOpenAiStrict(t.inputSchema).ok) tool.strict = true;
  return tool;
}

/** The Responses API's flat form: `{type: 'function', name}`, not Chat Completions' `{type: 'function', function: {name}}`. */
function responsesToolChoice(tc: ToolChoice): ResponsesToolChoiceWire {
  if (tc === 'auto' || tc === 'required') return tc;
  return { type: 'function', name: tc.name };
}

// ---------------------------------------------------------------------------------------
// Responses API streaming
// ---------------------------------------------------------------------------------------

interface CallAcc {
  name: string;
  args: string;
  /** `response.function_call_arguments.done` / the finished item: authoritative over the deltas */
  finalArgs: string | null;
  /** AGENT-LOOP-DESIGN §6.2: the item's `call_id` (what a `function_call_output` answers) and its `fc_…` item id */
  callId: string;
  itemId: string;
  /** the call's position in `GenerateResult.toolCalls` (the `onToolCall` index) */
  ordinal: number;
}

interface RespState {
  text: string;
  refusal: string;
  reasoningChars: number;
  toolChars: number;
  model: string | null;
  generationId: string | null;
  calls: Map<number, CallAcc>;
  list: CallAcc[];
  tokens: TokenBreakdown;
  reasoningTokens: number | null;
  sawUsage: boolean;
  status: string | null;
  incompleteReason: string | null;
  /** AGENT-LOOP-DESIGN §6.1: the configured model when this is an agent request; null for legacy */
  agentModel: string | null;
  /** agent: the finished output items by `output_index`, and the terminal event's output array (the authority when present) */
  items: Map<number, JsonObject>;
  terminalOutput: JsonObject[] | null;
}

function newRespState(agentModel: string | null): RespState {
  return {
    text: '',
    refusal: '',
    reasoningChars: 0,
    toolChars: 0,
    model: null,
    generationId: null,
    calls: new Map(),
    list: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    reasoningTokens: null,
    sawUsage: false,
    status: null,
    incompleteReason: null,
    agentModel,
    items: new Map(),
    terminalOutput: null,
  };
}

/** The call at `output_index`; on an agent request an item with a different non-empty `call_id` at the same index starts a new call (§6.2). */
function accFor(st: RespState, index: number, callId: string | null = null): CallAcc {
  let acc = st.calls.get(index);
  if (!acc || (st.agentModel !== null && callId !== null && callId.length > 0 && acc.callId.length > 0 && acc.callId !== callId)) {
    acc = { name: '', args: '', finalArgs: null, callId: '', itemId: '', ordinal: st.list.length };
    st.calls.set(index, acc);
    st.list.push(acc);
  }
  if (callId !== null && callId.length > 0) acc.callId = callId;
  return acc;
}

/**
 * §6.2: an output item as the replay state keeps it — a reasoning item verbatim, and only with `encrypted_content` (the
 * one form `store: false` can replay); position markers for the message and each call.
 */
function replayMarker(item: JsonObject): JsonObject | null {
  const type = getStr(item, 'type');
  if (type === 'reasoning') return typeof item['encrypted_content'] === 'string' ? item : null;
  if (type === 'message') return { type: 'message' };
  const callId = getStr(item, 'call_id');
  if (type !== 'function_call' || callId === null) return null;
  const id = getStr(item, 'id');
  return id !== null ? { type: 'function_call', call_id: callId, id } : { type: 'function_call', call_id: callId };
}

/** `{"type": "error", ...}` after a 200, and `response.failed`'s `response.error`: both map to an HTTP-shaped failure. */
function responsesError(err: JsonObject | null, redact: (s: string) => string, requestId: string | null): ProviderHttpError {
  const code = getStr(err, 'code') ?? '';
  const message = getStr(err, 'message') ?? '';
  const status = getNum(err, 'status') ?? (/rate_limit|slow_down/.test(code) ? 429 : /server|overload/.test(code) ? 503 : 500);
  return new ProviderHttpError(clipMessage(redact(`openai stream error ${status}${code ? ` ${code}` : ''}: ${message}`)), {
    status,
    retryable: isRetryableStatus(status),
    body: redact(JSON.stringify(err ?? {})).slice(0, 2048),
    requestId,
  });
}

function readResponseObject(resp: JsonObject | null, st: RespState, ctx: ConsumeContext): void {
  if (!resp) return;
  st.model = getStr(resp, 'model') ?? st.model;
  if (st.generationId === null) st.generationId = sanitiseRequestId(getStr(resp, 'id'), ctx.redact);
  st.status = getStr(resp, 'status') ?? st.status;
  const incomplete = getObj(resp, 'incomplete_details');
  st.incompleteReason = getStr(incomplete, 'reason') ?? st.incompleteReason;
  const usage = getObj(resp, 'usage');
  if (usage) {
    st.sawUsage = true;
    const input = countOf(usage['input_tokens']);
    const details = getObj(usage, 'input_tokens_details');
    const cached = Math.min(countOf(details?.['cached_tokens']), input);
    const written = Math.min(countOf(details?.['cache_write_tokens']), input - cached);
    st.tokens.cacheRead = cached;
    st.tokens.cacheWrite = written;
    st.tokens.input = input - cached - written;
    // `output_tokens` already includes the hidden reasoning tokens — reported separately, never added twice
    st.tokens.output = countOf(usage['output_tokens']);
    const rt = getNum(getObj(usage, 'output_tokens_details'), 'reasoning_tokens');
    st.reasoningTokens = rt !== null ? Math.max(0, Math.round(rt)) : st.reasoningTokens;
  }
  // The terminal event repeats the whole output array: it is the authority on every tool call's arguments — but only
  // when it actually carries them. An EMPTY `arguments` string is not an authority: a snapshot that repeats the item
  // with `"arguments": ""` would otherwise erase the streamed deltas, and `respOutcome` turns an empty string into
  // `{}`, i.e. a truncated call reported as a well-formed empty proposal with the raw text needed to diagnose it gone.
  // Same rule as the `response.output_item.done` path below: non-empty wins, nothing else overwrites.
  const output = getArr(resp, 'output');
  if (output) {
    if (st.agentModel !== null && output.length > 0) st.terminalOutput = output.filter(isJsonObject);
    for (const [i, item] of output.entries()) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      if (getStr(item, 'type') !== 'function_call') continue;
      const acc = accFor(st, i, getStr(item, 'call_id'));
      acc.name = getStr(item, 'name') ?? acc.name;
      const args = getStr(item, 'arguments');
      if (args !== null && args.length > 0) acc.finalArgs = args;
    }
  }
}

/** Agent requests only: the turn's reasoning state — the output in order (reasoning items verbatim) — or undefined when it carried no replayable reasoning. */
function respReplayState(st: RespState): ProviderOutcome['providerState'] {
  if (st.agentModel === null) return undefined;
  const items = st.terminalOutput ?? [...st.items.entries()].sort((x, y) => x[0] - y[0]).map(([, item]) => item);
  const output = items.map(replayMarker).filter((m): m is JsonObject => m !== null);
  return output.some((m) => m['type'] === 'reasoning') ? { provider: 'openai', model: st.agentModel, data: { output } } : undefined;
}

function respOutcome(st: RespState): ProviderOutcome {
  const toolCalls: ToolCall[] = st.list.map((acc) => {
    const raw = acc.finalArgs ?? acc.args;
    const args = raw.length > 0 ? raw : '{}';
    const p = parseJson(args);
    const call: ToolCall = { name: acc.name, input: p.ok ? p.value : null, rawJson: args };
    if (st.agentModel !== null) call.id = agentCallId(acc.callId, acc.ordinal);
    return call;
  });
  const providerState = respReplayState(st);
  const refused = st.refusal.length > 0 && st.text.length === 0;
  let stopReason: string;
  if (st.status === 'incomplete') stopReason = st.incompleteReason === 'max_output_tokens' ? 'length' : (st.incompleteReason ?? 'incomplete');
  else if (refused) stopReason = 'refusal';
  else stopReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  return {
    text: refused ? st.refusal : st.text,
    toolCalls,
    tokens: st.tokens,
    // OpenAI never returns a price; the table (or NaN) prices the call
    cost: null,
    reasoningTokens: st.reasoningTokens,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    stopReason,
    ...(providerState !== undefined ? { providerState } : {}),
  };
}

function respHeld(st: RespState): StreamPartial {
  return {
    text: st.text,
    toolChars: st.toolChars,
    reasoningChars: st.reasoningChars,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    tokens: st.sawUsage ? st.tokens : null,
    cost: null,
    reasoningTokens: st.reasoningTokens,
  };
}

async function consumeResponses(stream: ReadableStream<Uint8Array>, ctx: ConsumeContext, agentModel: string | null): Promise<ProviderOutcome> {
  const st = newRespState(agentModel);
  let terminal = false;
  try {
    for await (const rec of parseSse(stream, { signal: ctx.opts.signal, firstByteTimeoutMs: ctx.firstByteTimeoutMs, ...(ctx.onFirstByte === undefined ? {} : { onFirstByte: ctx.onFirstByte }) })) {
      if (ctx.opts.signal.aborted) throw ctx.opts.signal.reason;
      const data = rec.data.trim();
      if (data.length === 0) continue;
      const parsed = parseJson(data);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        throw new TransportError('invalid', clipMessage(ctx.redact(`openai: malformed sse data: ${parsed.ok ? 'not a JSON object' : 'not valid JSON'}`)));
      }
      const ev = parsed.value;
      const type = getStr(ev, 'type') ?? rec.event ?? '';
      switch (type) {
        case 'response.created':
        case 'response.in_progress':
        case 'response.queued':
          readResponseObject(getObj(ev, 'response'), st, ctx);
          break;
        case 'response.output_item.added':
        case 'response.output_item.done': {
          const item = getObj(ev, 'item');
          const outputIndex = getNum(ev, 'output_index');
          if (getStr(item, 'type') === 'function_call') {
            const acc = accFor(st, outputIndex ?? st.list.length, getStr(item, 'call_id'));
            const named = acc.name.length === 0;
            acc.name = getStr(item, 'name') ?? acc.name;
            acc.itemId = getStr(item, 'id') ?? acc.itemId;
            const args = getStr(item, 'arguments');
            if (type === 'response.output_item.done' && args !== null && args.length > 0) acc.finalArgs = args;
            // §6.1: the call is named before its first argument fragment
            if (named && acc.name.length > 0) emitToolCall(ctx.opts, acc.ordinal, acc.callId, acc.name, '');
          }
          if (type === 'response.output_item.done' && st.agentModel !== null && item !== null && outputIndex !== null) st.items.set(outputIndex, item);
          break;
        }
        case 'response.output_text.delta': {
          const d = getStr(ev, 'delta') ?? '';
          if (d.length > 0) {
            st.text += d;
            notify(ctx.opts.onDelta, d);
          }
          break;
        }
        case 'response.refusal.delta':
          st.refusal += getStr(ev, 'delta') ?? '';
          break;
        case 'response.function_call_arguments.delta': {
          const acc = accFor(st, getNum(ev, 'output_index') ?? 0);
          const d = getStr(ev, 'delta') ?? '';
          if (d.length > 0) {
            acc.args += d;
            st.toolChars += d.length;
            notify(ctx.opts.onToolDelta, d);
            emitToolCall(ctx.opts, acc.ordinal, acc.callId, acc.name, d);
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const acc = accFor(st, getNum(ev, 'output_index') ?? 0);
          const args = getStr(ev, 'arguments');
          // non-empty only: an empty `arguments` never outranks what the deltas already spelled out
          if (args !== null && args.length > 0) acc.finalArgs = args;
          break;
        }
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta': {
          // thinking text: measured for §4.8, never rendered; AGENT-LOOP-DESIGN §6.2: it streams to `onReasoning`
          const d = getStr(ev, 'delta') ?? '';
          st.reasoningChars += d.length;
          if (d.length > 0) notify(ctx.opts.onReasoning, d);
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          readResponseObject(getObj(ev, 'response'), st, ctx);
          terminal = true;
          break;
        case 'response.failed': {
          readResponseObject(getObj(ev, 'response'), st, ctx);
          throw responsesError(getObj(getObj(ev, 'response'), 'error'), ctx.redact, ctx.requestId);
        }
        case 'error':
          throw responsesError(getObj(ev, 'error') ?? ev, ctx.redact, ctx.requestId);
        default:
          // "new event types may be added": content_part.added/done, output_text.done, obfuscation fields, …
          break;
      }
      if (terminal) break;
    }
  } catch (e) {
    if (ctx.opts.signal.aborted) {
      ctx.held.partial = respHeld(st);
      throw ctx.opts.signal.reason;
    }
    // A 429 delivered as a mid-stream error frame cut a stream that had already been served: keep its facts so the
    // chain's rate-limited record is what streamed, not zeros (http.ts `HeldPartial.streamed`).
    if (isRateLimit(e)) ctx.held.streamed = respHeld(st);
    throw e;
  }
  if (!terminal) throw new TransportError('stream', 'openai: stream ended before response.completed / response.incomplete');
  if (!st.sawUsage) throw new TransportError('stream', 'openai: terminal event carried no usage');
  return respOutcome(st);
}

// ---------------------------------------------------------------------------------------
// Chat Completions quirks (the legacy surface / OpenAI-compatible gateways)
// ---------------------------------------------------------------------------------------

/**
 * Live 2026-09-21: with function tools present, `gpt-5.6-terra` answers 400 unless `reasoning_effort` is exactly `none`
 * — including when the field is omitted. So on a reasoning-era id the field is pinned to `none` whenever tools are sent;
 * without tools the caller's level is honoured through the usual substitution chain.
 *
 * A reasoning-era id that does not ACCEPT `none` (gpt-6-astra, per `EFFORTS_GPT6`) therefore has no way to send tools
 * on this surface at all: every value 400s and so does omitting the field. That combination fails here, before the
 * request is built, rather than spending a round trip on a guaranteed 400 — with the remedy in the message.
 */
export const OPENAI_CHAT_QUIRKS: ChatQuirks = {
  id: 'openai',
  label: 'openai',
  path: '/chat/completions',
  transport: 'sse',
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  maxTokensField: 'max_completion_tokens',
  systemRole: openAiSystemRole,
  strictTools: true,
  toolChoice: 'named',
  parallelToolCalls: true,
  streamUsageOptIn: true,
  usageRequired: true,
  reasoningOutsideCompletion: false,
  costField: null,
  seed: false,
  temperature: openAiAcceptsTemperature,
  reasoning: (r, model, hasTools): Partial<ChatRequestBody> | null => {
    const allowed = openAiChatEfforts(model);
    if (allowed === null) return null;
    if (hasTools) {
      if (allowed.includes('none')) return { reasoning_effort: 'none' };
      throw new ProviderHttpError(
        `openai: ${model} cannot be sent function tools on /v1/chat/completions — it rejects reasoning_effort 'none' and 400s for every other value, omission included; use the Responses surface for this model (the default, api: 'responses')`,
        { status: 0, retryable: false },
      );
    }
    if (r === undefined) return null;
    const wanted = effortOf(r);
    const effort = wanted === null ? null : pickEffort(wanted, allowed);
    return effort === null ? null : { reasoning_effort: effort };
  },
  extras: { store: false },
  // AGENT-LOOP-DESIGN §6.2 (agent requests only): the session id as `prompt_cache_key`
  promptCacheKey: true,
};

// ---------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------

export interface OpenAiProviderOptions {
  /** `responses` (default) or the legacy `chat` surface */
  api?: 'responses' | 'chat';
}

export function createOpenAiProvider(cfg: ProviderConfig, deps: ProviderDeps, opts: OpenAiProviderOptions = {}): GenerationProvider {
  if ((opts.api ?? 'responses') === 'chat') return createChatProvider(OPENAI_CHAT_QUIRKS, cfg, deps);
  const d = resolveDeps(deps);
  const caller = createCaller(d);
  const url = joinUrl(cfg.baseUrl, '/responses');

  return {
    name: 'openai',
    model: cfg.model,
    async generate(req: GenerateRequest, genOpts: GenerateOptions): Promise<GenerateResult> {
      validateGenerateRequest('openai', req);
      const body = JSON.stringify(buildResponsesBody(cfg, req));
      const agentModel = req.agent === undefined ? null : cfg.model;
      const attempt = (held: HeldPartial): Promise<ProviderOutcome> =>
        caller.attempt({ label: 'openai', url, headers: { authorization: `Bearer ${cfg.apiKey}` }, body, readError: openAiErrorFields, consume: (stream, ctx) => consumeResponses(stream, ctx, agentModel) }, genOpts, held);
      return runGeneration(d, cfg, genOpts, attempt);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------

/**
 * `GET /v1/models` returns EVERY model type with no capability or context metadata (id, object, created, owned_by,
 * shutdown_date — measured: 130 rows, 118 of them not chat models), so the picker filters by id and the sizes come from
 * this hand-kept table (docs/models/<id>, 2026-09-21).
 */
interface OpenAiCatalogueRow {
  prefix: string;
  contextTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  vision: boolean;
}
const OPENAI_CATALOGUE: readonly OpenAiCatalogueRow[] = [
  { prefix: 'gpt-6', contextTokens: 1_048_576, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.6', contextTokens: 1_048_576, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.5', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.4', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.3', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.2', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5.1', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-5', contextTokens: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { prefix: 'gpt-4.1', contextTokens: 1_047_576, maxOutputTokens: 32_768, reasoning: false, vision: true },
  { prefix: 'gpt-4o', contextTokens: 128_000, maxOutputTokens: 16_384, reasoning: false, vision: true },
  { prefix: 'o4-mini', contextTokens: 200_000, maxOutputTokens: 100_000, reasoning: true, vision: true },
  { prefix: 'o3', contextTokens: 200_000, maxOutputTokens: 100_000, reasoning: true, vision: true },
];

/** ids that are chat-shaped but not text generators (audio, images, transcription, embeddings, search wrappers, completions-only). */
const OPENAI_NON_CHAT = /(-realtime|realtime-|-audio|audio-|-transcribe|transcribe|-tts|tts-|-search|search-|embedding|image|moderation|whisper|-instruct|video|live|dall-e|codex-mini|babbage|davinci)/;

export function isOpenAiChatModel(id: string): boolean {
  return /^(gpt-|o3|o4-|chatgpt-)/.test(id) && !OPENAI_NON_CHAT.test(id);
}

export function openAiModelInfo(row: JsonObject): ModelInfo | null {
  const id = getStr(row, 'id');
  if (id === null || !isOpenAiChatModel(id)) return null;
  const cat = OPENAI_CATALOGUE.find((c) => id.startsWith(c.prefix));
  const created = getNum(row, 'created');
  const owner = getStr(row, 'owned_by');
  const shutdown = getStr(row, 'shutdown_date');
  return {
    id,
    ...(created !== null ? { created } : {}),
    ...(owner !== null ? { ownedBy: owner } : {}),
    ...(shutdown !== null ? { shutdownDate: shutdown } : {}),
    ...(cat ? { contextTokens: cat.contextTokens, maxOutputTokens: cat.maxOutputTokens, reasoning: cat.reasoning, vision: cat.vision, tools: true } : {}),
  };
}

export async function listOpenAiModels(apiKey: string, deps: ProviderDeps, baseUrl = OPENAI_BASE_URL): Promise<ModelInfo[]> {
  const json = await getJson({ label: 'openai', url: joinUrl(baseUrl, '/models'), headers: { authorization: `Bearer ${apiKey}` }, deps });
  const out: ModelInfo[] = [];
  for (const row of getArr(json, 'data') ?? []) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const info = openAiModelInfo(row);
    if (info) out.push(info);
  }
  return sortModels(out);
}
