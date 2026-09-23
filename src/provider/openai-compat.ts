/**
 * The OpenAI-compatible `/chat/completions` client, parameterised by a per-provider quirks table (`ChatQuirks`).
 * Four of the seven registry providers ride on it — fireworks, meta, xai and openai's legacy chat mode — because the
 * request and the SSE chunk shape are the same everywhere; only the quirks differ, and every one of them below was
 * measured against the live endpoint on 2026-09-21 (see each client's `*_QUIRKS` doc comment for the evidence).
 *
 * What it does, in the same terms as openrouter.ts: streams `choices[0].delta.content` to `onDelta`, accumulates
 * `delta.tool_calls[i].function.arguments` by `index` for `onToolDelta`, counts `delta.reasoning_content` as reasoning
 * characters (never rendered), reads the accounting frame that precedes `data: [DONE]`, maps LLM-JEV-DESIGN §4.12's
 * `seed` / `reasoning` per provider (omitted where the API rejects it), reports §4.8's cancellation facts, and prices
 * from the wire when the provider returns a cost (xAI) or from the table when it does not.
 *
 * One provider (api.meta.ai) cannot stream what the harness needs — with `stream: true` it drops tool calls AND the
 * usage frame — so `transport: 'json'` sends the same body without `stream` and feeds the single completion object
 * through the same accumulator. That is the only shape difference; everything else (retries, aborts, redaction) is shared.
 */
import { ProviderHttpError } from '../errors.js';
import { isJsonObject, parseJson } from '../core/json.js';
import type { AgentMessage, AgentRequest, GenerateOptions, GenerateReasoning, GenerateRequest, GenerateResult, Json, JsonObject, ToolChoice, ToolSpec } from '../core/types.js';
import { checkOpenAiStrict } from './schema.js';
import { agentReasoning, chatAgentMessages, createCaller, joinUrl, replayData, runGeneration, toolStream, validateGenerateRequest } from './http.js';
import type { ConsumeContext, ErrorReader, HeldPartial, ToolStream } from './http.js';
import { openAiErrorFields } from './http.js';
import {
  TransportError,
  clipMessage,
  getArr,
  getNum,
  getObj,
  getStr,
  isRateLimit,
  isRetryableStatus,
  notify,
  parseSse,
  readStreamText,
  resolveDeps,
  sanitiseRequestId,
} from './sse.js';
import type { ChatAgentMessage, GenerationProvider, GenerationProviderName, ProviderConfig, ProviderDeps, ProviderOutcome, StreamPartial, TokenBreakdown } from './types.js';

// ---------------------------------------------------------------------------------------
// Wire types (request side only; responses are read field by field through the sse.ts accessors)
// ---------------------------------------------------------------------------------------

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant';
export type ChatToolWire = { type: 'function'; function: { name: string; description: string; parameters: JsonObject; strict?: true } };
export type ChatToolChoiceWire = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };

/** A chat message: the legacy string turn, or an agent turn (AGENT-LOOP-DESIGN §6.2: an assistant with calls, a `tool` result). */
export type ChatMessageWire = { role: ChatRole; content: string } | ChatAgentMessage;

/**
 * Everything any of the four clients sends. Unused members are simply absent from the wire (`JSON.stringify` drops
 * `undefined`), and every optional member is set by exactly one quirk, so the key set of a body is auditable in a test.
 */
export type ChatRequestBody = {
  model: string;
  messages: ChatMessageWire[];
  stream?: true;
  /** OpenAI: without `{include_usage: true}` a stream carries no usage at all; Fireworks always sends it, xAI too */
  stream_options?: { include_usage: true };
  max_tokens?: number;
  /** the replacement for the deprecated `max_tokens` on OpenAI (the limit includes hidden reasoning tokens) */
  max_completion_tokens?: number;
  tools?: ChatToolWire[];
  tool_choice?: ChatToolChoiceWire;
  /** sent as false whenever tools are present: the loop consumes exactly one action per step */
  parallel_tool_calls?: false;
  temperature?: number;
  seed?: number;
  reasoning_effort?: string;
  /** Fireworks' Anthropic-style thinking budget (overrides reasoning_effort there; the two cannot be combined) */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** OpenAI: keep the request out of the 30-day store */
  store?: false;
  /** Fireworks: fail instead of silently shrinking max_tokens when prompt + max_tokens exceeds the context window */
  context_length_exceeded_behavior?: 'error';
  /** agent, OpenAI chat: `AgentRequest.cacheKey` (https://developers.openai.com/api/docs/guides/prompt-caching) */
  prompt_cache_key?: string;
};

export type EffortWord = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The per-provider differences. A field here exists because a live endpoint forced it, not because an SDK has an option.
 */
export interface ChatQuirks {
  id: GenerationProviderName;
  /** the label every error message, RetryCause and log line carries */
  label: string;
  /** appended to `cfg.baseUrl` */
  path: string;
  /** 'json' = the provider's SSE surface is unusable for tool calls / usage (api.meta.ai) */
  transport: 'sse' | 'json';
  headers: (apiKey: string) => Record<string, string>;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /**
   * The role the system prompt goes out under, per model. `developer` is OpenAI's reasoning-era name for it;
   * `system` is the only role a third-party OpenAI-compatible server can be relied on to know (api.openai.com itself
   * accepts both on both families — measured 2026-09-21 — so this is about the gateways, not about an OpenAI 400).
   * A function, like `temperature`, because one table serves every model of a provider.
   */
  systemRole: (model: string) => 'system' | 'developer';
  /** send `strict: true` on a tool whose schema passes `checkOpenAiStrict` (never on one that would 400) */
  strictTools: boolean;
  /** 'auto-only': the API rejects `required` and named choices (api.meta.ai), so a forced choice is downgraded */
  toolChoice: 'named' | 'auto-only';
  parallelToolCalls: boolean;
  /** add `stream_options: {include_usage: true}` (OpenAI needs it; Fireworks and xAI send usage regardless) */
  streamUsageOptIn: boolean;
  /** a stream/response without an accounting frame is a retryable transport failure rather than a silent $0 */
  usageRequired: boolean;
  /** xAI reports reasoning tokens OUTSIDE `completion_tokens`, so billed output = completion + reasoning */
  reasoningOutsideCompletion: boolean;
  /** a usage field carrying the provider's own price, and its units per USD (xAI: `cost_in_usd_ticks`, 1e10 ticks = $1) */
  costField: { field: string; perUsd: number } | null;
  /** the API accepts `seed` (OpenAI's Responses API answers 400 `Unknown parameter: 'seed'`) */
  seed: boolean;
  /** whether a non-null `temperature` may be sent for this model (GPT-5.x+ answers 400 for any sampling parameter) */
  temperature: (model: string) => boolean;
  /**
   * LLM-JEV-DESIGN §4.12 → wire fields; null = this provider/model takes no reasoning control and the parameter is
   * omitted. Called on EVERY request, `r` undefined when the caller asked for nothing: "the model's own default" is a
   * value the API can reject too (OpenAI's chat surface 400s on a reasoning-era id with tools unless
   * `reasoning_effort: 'none'` is present — omission included), so a quirk must be able to pin a field the caller
   * never mentioned. A quirk with nothing to say about `undefined` returns null and the parameter stays off the wire.
   */
  reasoning: (r: GenerateReasoning | undefined, model: string, hasTools: boolean) => Partial<ChatRequestBody> | null;
  /** fixed extras (Fireworks' context-overflow behaviour, OpenAI's `store: false`) */
  extras?: Partial<ChatRequestBody>;
  /** non-200 body reader (all four use OpenAI's envelope) */
  readError?: ErrorReader;
  /**
   * AGENT-LOOP-DESIGN §6.2, agent requests only: the header that carries `AgentRequest.cacheKey` so the provider routes
   * the session's turns to one cache (xAI `x-grok-conv-id`, Fireworks `x-session-affinity`).
   */
  sessionHeader?: string;
  /** agent requests only: the cache key goes in the body as `prompt_cache_key` (OpenAI's chat surface) */
  promptCacheKey?: boolean;
  /** agent requests only: `delta.reasoning_content` is captured as the turn's `providerState` and replayed on the assistant message (Fireworks) */
  replayReasoningContent?: boolean;
}

/** Preference chain per requested level: the level itself first, then the documented neighbours (a model that lacks `none` gets the lowest it has). */
const EFFORT_CHAINS: Readonly<Record<EffortWord, readonly EffortWord[]>> = {
  none: ['none', 'minimal', 'low'],
  minimal: ['minimal', 'none', 'low'],
  low: ['low', 'minimal', 'medium'],
  medium: ['medium', 'low', 'high'],
  high: ['high', 'xhigh', 'medium'],
  xhigh: ['xhigh', 'max', 'high'],
  max: ['max', 'xhigh', 'high'],
};

/**
 * The effort word to send for `wanted` on a model that accepts `allowed`, or null when none of the chain fits (the
 * parameter is then omitted, i.e. the model's own default runs — never a 400 and never a silent rewrite to something
 * far from what was asked). Reasoning-effort value sets are model-specific on every provider here.
 *
 * Generic in the accepted set so a caller whose words are a narrower union (gemini.ts's budget table) gets that union
 * back and can index its own record without a cast.
 */
export function pickEffort<T extends EffortWord>(wanted: EffortWord, allowed: readonly T[]): T | null {
  for (const candidate of EFFORT_CHAINS[wanted]) {
    const hit = allowed.find((a) => a === candidate);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** LLM-JEV-DESIGN §4.12's union as an effort word; `{maxTokens}` is a budget, not a level, so it has none. */
export function effortOf(r: GenerateReasoning): EffortWord | null {
  if ('effort' in r) return r.effort;
  if ('maxTokens' in r) return null;
  return 'none';
}

// ---------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------

/** Exported so every client's test can assert the exact wire body. */
export function buildChatBody(q: ChatQuirks, cfg: ProviderConfig, req: GenerateRequest): ChatRequestBody {
  const a = req.agent;
  const messages: ChatRequestBody['messages'] = [];
  if (req.system.length > 0) messages.push({ role: q.systemRole(cfg.model), content: req.system });
  if (a !== undefined) messages.push(...chatAgentMessages(a, (m) => replayedReasoning(q, cfg, a, m)));
  else for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body: ChatRequestBody = { model: cfg.model, messages };
  if (q.transport === 'sse') {
    body.stream = true;
    if (q.streamUsageOptIn) body.stream_options = { include_usage: true };
  }
  if (q.maxTokensField === 'max_tokens') body.max_tokens = req.maxTokens;
  else body.max_completion_tokens = req.maxTokens;
  const hasTools = req.tools !== undefined && req.tools.length > 0;
  if (hasTools) {
    body.tools = req.tools!.map((t) => toolWire(q, t));
    if (req.toolChoice !== undefined) body.tool_choice = toolChoiceWire(q, req.toolChoice);
    // AGENT-LOOP-DESIGN §6.2: an agent turn takes the provider's default (parallel) unless it asked for one call per turn
    if (q.parallelToolCalls && (a === undefined || !a.parallelToolCalls)) body.parallel_tool_calls = false;
  }
  // null means "do not send the parameter" (core/types.ts GenerateRequest); cfg.temperature is not a fallback.
  if (req.temperature !== null && q.temperature(cfg.model)) body.temperature = req.temperature;
  if (req.seed !== undefined && q.seed) body.seed = req.seed;
  Object.assign(body, q.reasoning(a === undefined ? req.reasoning : agentReasoning(req), cfg.model, hasTools) ?? {});
  if (q.extras) Object.assign(body, q.extras);
  if (a !== undefined && q.promptCacheKey === true && a.cacheKey.length > 0) body.prompt_cache_key = a.cacheKey;
  return body;
}

/**
 * AGENT-LOOP-DESIGN §6.2, OpenAI-compatible row: the transcript as native chat messages (http.ts `chatAgentMessages`); an
 * assistant turn of a `replayReasoningContent` quirk also carries its `reasoning_content`, same configured model only.
 */
function replayedReasoning(q: ChatQuirks, cfg: ProviderConfig, a: AgentRequest, m: AgentMessage): { reasoning_content: string } | null {
  const data = q.replayReasoningContent === true ? replayData(a, m, q.id, cfg.model) : null;
  const text = isJsonObject(data) ? data['reasoning_content'] : undefined;
  return typeof text === 'string' ? { reasoning_content: text } : null;
}

/** `strict: true` only for a schema OpenAI's strict mode actually accepts (provider/schema.ts); the harness's own `propose_action` does not qualify. */
function toolWire(q: ChatQuirks, t: ToolSpec): ChatToolWire {
  const fn: ChatToolWire['function'] = { name: t.name, description: t.description, parameters: t.inputSchema };
  if (q.strictTools && checkOpenAiStrict(t.inputSchema).ok) fn.strict = true;
  return { type: 'function', function: fn };
}

/**
 * A forced choice on a provider that only takes `auto` (api.meta.ai answers
 * 400 ``only `"auto"` is supported for `tool_choice```) is downgraded to `auto` rather than failing the step: the
 * model is still told about the tool, the harness still validates what comes back, and the fact is in the quirks table.
 */
function toolChoiceWire(q: ChatQuirks, tc: ToolChoice): ChatToolChoiceWire {
  if (q.toolChoice === 'auto-only') return 'auto';
  if (tc === 'auto' || tc === 'required') return tc;
  return { type: 'function', function: { name: tc.name } };
}

// ---------------------------------------------------------------------------------------
// Stream / response accumulation
// ---------------------------------------------------------------------------------------

interface ChatState {
  /** AGENT-LOOP-DESIGN §6.1: the configured model when this is an agent request (ids kept, calls split, reasoning captured) */
  agentModel: string | null;
  /** the turn's `reasoning_content`, kept for replay (agent requests of a `replayReasoningContent` quirk only) */
  reasoningText: string;
  text: string;
  reasoningChars: number;
  toolChars: number;
  model: string | null;
  generationId: string | null;
  finishReason: string | null;
  refusal: string;
  sawUsage: boolean;
  cost: number | null;
  reasoningTokens: number | null;
  tokens: TokenBreakdown;
  tools: ToolStream;
}

function newState(opts: GenerateOptions, agentModel: string | null): ChatState {
  return {
    agentModel,
    reasoningText: '',
    text: '',
    reasoningChars: 0,
    toolChars: 0,
    model: null,
    generationId: null,
    finishReason: null,
    refusal: '',
    sawUsage: false,
    cost: null,
    reasoningTokens: null,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    tools: toolStream(opts, agentModel !== null),
  };
}

/** A top-level `error` after HTTP 200 (every one of these APIs may send one mid-stream): map it to its status. */
function chunkError(q: ChatQuirks, err: JsonObject, redact: (s: string) => string, requestId: string | null): ProviderHttpError {
  const raw = err['code'];
  const status = typeof raw === 'number' && Number.isInteger(raw) ? raw : typeof raw === 'string' && /^\d{3}$/.test(raw) ? Number(raw) : 500;
  const kind = getStr(err, 'type') ?? '';
  const message = getStr(err, 'message') ?? '';
  return new ProviderHttpError(clipMessage(redact(`${q.label} stream error ${status}${kind ? ` ${kind}` : ''}: ${message}`)), {
    status,
    retryable: isRetryableStatus(status),
    body: redact(JSON.stringify(err)).slice(0, 2048),
    requestId,
  });
}

/**
 * Merge one `usage` object into the accounting state. A stream may carry SEVERAL of them (a gateway that repeats a
 * partial object before `[DONE]`, a provider that sends a running total and then a final one), so the merge is
 * field-by-field and DEGENERATE frames are ignored outright: a `usage` carrying neither `prompt_tokens` nor
 * `completion_tokens` says nothing, and letting it overwrite a real frame with zeros would bill the call at $0 with a
 * clean `stop` — exactly the silent $0 TUI-DESIGN §9.5 forbids. Such a frame does not satisfy `usageRequired` either
 * (`sawUsage` is set only once a token count was actually read), so a stream that carries nothing else still fails
 * loudly as a transport error instead of being recorded free.
 */
function readUsage(q: ChatQuirks, usage: JsonObject, st: ChatState): void {
  const promptRaw = getNum(usage, 'prompt_tokens');
  const completionRaw = getNum(usage, 'completion_tokens');
  if (promptRaw === null && completionRaw === null) return;
  st.sawUsage = true;
  // the prompt total the state already holds, so a frame that omits `prompt_tokens` keeps the last real reading
  let prompt = st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite;
  if (promptRaw !== null) {
    prompt = Math.max(0, Math.round(promptRaw));
    const details = getObj(usage, 'prompt_tokens_details');
    const cached = Math.max(0, Math.round(getNum(details, 'cached_tokens') ?? 0));
    const cacheWrite = Math.max(0, Math.round(getNum(details, 'cache_write_tokens') ?? 0));
    st.tokens.cacheRead = Math.min(cached, prompt);
    st.tokens.cacheWrite = Math.min(cacheWrite, prompt - st.tokens.cacheRead);
    st.tokens.input = prompt - st.tokens.cacheRead - st.tokens.cacheWrite;
  }
  if (completionRaw !== null) {
    const completion = Math.max(0, Math.round(completionRaw));
    // Fireworks mirrors the count under both names; xAI and OpenAI use completion_tokens_details.
    const rt = getNum(getObj(usage, 'completion_tokens_details'), 'reasoning_tokens') ?? getNum(getObj(usage, 'output_tokens_details'), 'reasoning_tokens');
    st.reasoningTokens = rt !== null ? Math.max(0, Math.round(rt)) : st.reasoningTokens;
    st.tokens.output = billedOutput(q, usage, prompt, completion, st.reasoningTokens ?? 0);
  }
  if (q.costField !== null) {
    const ticks = getNum(usage, q.costField.field);
    if (ticks !== null && ticks >= 0) st.cost = ticks / q.costField.perUsd;
  }
}

/**
 * Billed output tokens. Everywhere but xAI `completion_tokens` already includes the hidden reasoning tokens; on xAI it
 * does not (`total_tokens` = prompt + completion + reasoning, verified against `cost_in_usd_ticks` to the cent). The
 * total is used as the arbiter rather than trusting the flag blindly: if a future xAI model folds reasoning back into
 * `completion_tokens`, `total - prompt === completion` says so and the tokens are not counted twice.
 */
function billedOutput(q: ChatQuirks, usage: JsonObject, prompt: number, completion: number, reasoning: number): number {
  if (!q.reasoningOutsideCompletion || reasoning === 0) return completion;
  const total = getNum(usage, 'total_tokens');
  if (total !== null && Math.round(total) - prompt === completion) return completion;
  return completion + reasoning;
}

/** One `chat.completion.chunk` (streaming) or one synthesised chunk (the JSON transport). */
function applyChunk(q: ChatQuirks, chunk: JsonObject, st: ChatState, ctx: ConsumeContext): void {
  const err = getObj(chunk, 'error');
  if (err) throw chunkError(q, err, ctx.redact, ctx.requestId);
  st.model = getStr(chunk, 'model') ?? st.model;
  // wire text that reaches state.json and the transcript → redacted and clipped like a request id
  if (st.generationId === null) st.generationId = sanitiseRequestId(getStr(chunk, 'id'), ctx.redact);

  const choices = getArr(chunk, 'choices');
  const choice = choices?.find((c) => typeof c === 'object' && c !== null && !Array.isArray(c) && (getNum(c, 'index') ?? 0) === 0);
  const choiceObj = typeof choice === 'object' && choice !== null && !Array.isArray(choice) ? choice : null;
  if (choiceObj) {
    const delta = getObj(choiceObj, 'delta');
    const content = getStr(delta, 'content');
    if (content !== null && content.length > 0) {
      st.text += content;
      notify(ctx.opts.onDelta, content);
    }
    // thinking text (Fireworks / xAI `reasoning_content`, OpenRouter-style `reasoning`): never rendered, only measured (§4.8);
    // AGENT-LOOP-DESIGN §6.2: it streams to `onReasoning`, and a replaying quirk keeps `reasoning_content` for the next turn
    const rc = getStr(delta, 'reasoning_content') ?? '';
    const rs = getStr(delta, 'reasoning') ?? '';
    st.reasoningChars += rc.length + rs.length;
    if (rc.length > 0) notify(ctx.opts.onReasoning, rc);
    if (rs.length > 0) notify(ctx.opts.onReasoning, rs);
    if (st.agentModel !== null && q.replayReasoningContent === true) st.reasoningText += rc;
    const refusal = getStr(delta, 'refusal');
    if (refusal !== null) st.refusal += refusal;
    const calls = getArr(delta, 'tool_calls');
    if (calls) {
      for (const [pos, c] of calls.entries()) {
        if (typeof c !== 'object' || c === null || Array.isArray(c)) continue;
        const fnObj = getObj(c, 'function');
        const frag = getStr(fnObj, 'arguments') ?? '';
        st.tools.push(getNum(c, 'index') ?? pos, getStr(c, 'id'), getStr(fnObj, 'name'), frag);
        st.toolChars += frag.length;
      }
    }
    // verbatim: `length` means the completion budget ran out (reasoning may have eaten it); the caller decides, this client never retries it
    const fr = getStr(choiceObj, 'finish_reason');
    if (fr !== null) st.finishReason = fr;
  }

  const usage = getObj(chunk, 'usage');
  if (usage) readUsage(q, usage, st);
}

function outcomeOf(q: ChatQuirks, st: ChatState): ProviderOutcome {
  // A structured-output refusal arrives in its own field instead of the body: it is surfaced as text with a
  // `refusal` stop reason, so the step is recorded as a malformed reply rather than an empty success.
  const refused = st.refusal.length > 0 && st.text.length === 0;
  return {
    text: refused ? st.refusal : st.text,
    // Invalid or truncated arguments keep the raw text with input null; actions.ts rejects them as a malformed proposal.
    toolCalls: st.tools.calls(st.agentModel !== null),
    tokens: st.tokens,
    cost: st.cost,
    reasoningTokens: st.reasoningTokens,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    stopReason: refused ? 'refusal' : (st.finishReason ?? 'stop'),
    ...(st.agentModel !== null && st.reasoningText.length > 0 ? { providerState: { provider: q.id, model: st.agentModel, data: { reasoning_content: st.reasoningText } } } : {}),
  };
}

function heldOf(st: ChatState): StreamPartial {
  return {
    text: st.text,
    toolChars: st.toolChars,
    reasoningChars: st.reasoningChars,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    tokens: st.sawUsage ? st.tokens : null,
    cost: st.cost,
    reasoningTokens: st.reasoningTokens,
  };
}

/** The SSE path (OpenAI chat, Fireworks, xAI). */
async function consumeChatSse(q: ChatQuirks, stream: ReadableStream<Uint8Array>, ctx: ConsumeContext, agentModel: string | null): Promise<ProviderOutcome> {
  const st = newState(ctx.opts, agentModel);
  let sawDone = false;
  try {
    for await (const rec of parseSse(stream, { signal: ctx.opts.signal, firstByteTimeoutMs: ctx.firstByteTimeoutMs, ...(ctx.onFirstByte === undefined ? {} : { onFirstByte: ctx.onFirstByte }) })) {
      // parseSse yields every record of a chunk before it reads again; a signal that fired mid-chunk stops here
      if (ctx.opts.signal.aborted) throw ctx.opts.signal.reason;
      const data = rec.data.trim();
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      if (data.length === 0) continue;
      const parsed = parseJson(data);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        // TUI-DESIGN §15 item 5: RetryCause kind 'invalid'; a fixed hint, never the parser message (it embeds a body snippet)
        throw new TransportError('invalid', clipMessage(ctx.redact(`${q.label}: malformed sse data: ${parsed.ok ? 'not a JSON object' : 'not valid JSON'}`)));
      }
      applyChunk(q, parsed.value, st, ctx);
    }
  } catch (e) {
    if (ctx.opts.signal.aborted) {
      ctx.held.partial = heldOf(st);
      throw ctx.opts.signal.reason;
    }
    // A 429 delivered as a mid-stream error frame cut a stream that had already been served: keep its facts so the
    // chain's rate-limited record is what streamed, not zeros (http.ts `HeldPartial.streamed`).
    if (isRateLimit(e)) ctx.held.streamed = heldOf(st);
    throw e;
  }
  if (!sawDone && !(st.finishReason !== null && st.sawUsage)) {
    throw new TransportError('stream', `${q.label}: stream ended before [DONE] / usage frame`);
  }
  if (q.usageRequired && !st.sawUsage) throw new TransportError('stream', `${q.label}: stream completed without a usage frame`);
  return outcomeOf(q, st);
}

/** The non-streaming path (api.meta.ai): one `chat.completion` object, reshaped into a chunk and run through the same accumulator. */
async function consumeChatJson(q: ChatQuirks, stream: ReadableStream<Uint8Array>, ctx: ConsumeContext, agentModel: string | null): Promise<ProviderOutcome> {
  const st = newState(ctx.opts, agentModel);
  let text: string;
  try {
    text = await readStreamText(stream, { signal: ctx.opts.signal, firstByteTimeoutMs: ctx.firstByteTimeoutMs, ...(ctx.onFirstByte === undefined ? {} : { onFirstByte: ctx.onFirstByte }) });
    if (ctx.opts.signal.aborted) throw ctx.opts.signal.reason;
  } catch (e) {
    if (ctx.opts.signal.aborted) {
      // nothing was delivered before the abort (the body arrives at once), but the headers had arrived: §4.8 still reports the facts
      ctx.held.partial = heldOf(st);
      throw ctx.opts.signal.reason;
    }
    throw e;
  }
  const parsed = parseJson(text.trim());
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new TransportError('invalid', clipMessage(ctx.redact(`${q.label}: malformed response: ${parsed.ok ? 'not a JSON object' : 'not valid JSON'}`)));
  }
  applyChunk(q, completionAsChunk(parsed.value), st, ctx);
  if (q.usageRequired && !st.sawUsage) throw new TransportError('stream', `${q.label}: response carried no usage`);
  return outcomeOf(q, st);
}

/**
 * `{choices: [{message: {content, tool_calls}}]}` → `{choices: [{delta: {...}}]}`, so the JSON transport shares every
 * line of the streaming accumulator (tool-call arguments arrive complete, so `onToolDelta` fires once).
 */
export function completionAsChunk(completion: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of ['id', 'model', 'usage', 'error'] as const) {
    const v = completion[key];
    if (v !== undefined) out[key] = v;
  }
  const choices = getArr(completion, 'choices') ?? [];
  const mapped: Json[] = choices.map((c, i) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return { index: i };
    const msg = getObj(c, 'message');
    const delta: JsonObject = {};
    for (const key of ['content', 'reasoning_content', 'refusal', 'tool_calls'] as const) {
      const v = msg?.[key];
      if (v !== undefined && v !== null) delta[key] = v;
    }
    const fr = getStr(c, 'finish_reason');
    return { index: getNum(c, 'index') ?? i, delta, ...(fr !== null ? { finish_reason: fr } : {}) };
  });
  out['choices'] = mapped;
  return out;
}

// ---------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------

export function createChatProvider(q: ChatQuirks, cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  const d = resolveDeps(deps);
  const caller = createCaller(d);
  const url = joinUrl(cfg.baseUrl, q.path);
  const readError = q.readError ?? openAiErrorFields;

  return {
    name: q.id,
    model: cfg.model,
    async generate(req: GenerateRequest, opts: GenerateOptions): Promise<GenerateResult> {
      validateGenerateRequest(q.label, req);
      const body = JSON.stringify(buildChatBody(q, cfg, req));
      const a = req.agent;
      const agentModel = a === undefined ? null : cfg.model;
      // AGENT-LOOP-DESIGN §6.2: the session header rides on agent requests only (legacy headers are unchanged)
      const session = a !== undefined && q.sessionHeader !== undefined && a.cacheKey.length > 0 ? { [q.sessionHeader]: a.cacheKey } : {};
      const attempt = (held: HeldPartial): Promise<ProviderOutcome> =>
        caller.attempt(
          {
            label: q.label,
            url,
            headers: { ...q.headers(cfg.apiKey), ...(q.transport === 'json' ? { accept: 'application/json' } : {}), ...session },
            body,
            readError,
            consume: (stream, ctx) => (q.transport === 'sse' ? consumeChatSse(q, stream, ctx, agentModel) : consumeChatJson(q, stream, ctx, agentModel)),
          },
          opts,
          held,
        );
      return runGeneration(d, cfg, opts, attempt);
    },
  };
}
