/**
 * The transport half that every HTTP generator client shares (DESIGN.md §7; anthropic.ts and openrouter.ts predate it
 * and keep their own copies verbatim — this module is what the five 2026-09 clients, openai / gemini / fireworks / meta /
 * xai, are built out of):
 *
 *  - `validateGenerateRequest` — the same request-level guard rails openrouter.ts applies (positive integer `maxTokens`,
 *    non-empty `messages`, finite-or-null `temperature`, integer `seed`, positive `reasoning.maxTokens`).
 *  - `createCaller` — one attempt: the header-phase timeout, the fetch, the request-id read, the non-200 → typed
 *    `ProviderHttpError` mapping with a redacted bounded body, then the provider's own `consume` under the remaining
 *    first-byte budget, with typed errors preserved and everything else classified as a retryable transport failure.
 *  - `runGeneration` — the retry chain (`withRetry`, 3 attempts, Retry-After or jittered backoff, every sleep ending on
 *    the sample's signal), the 429 ledger, LLM-JEV-DESIGN §4.8's `onCancelled` (streamed-so-far facts, or the
 *    rate-limited record when no stream ever opened) and the `GenerateResult` assembly (§4.12 fields included).
 *  - the agent half (AGENT-LOOP-DESIGN §6.1-§6.2) that all seven adapters share, anthropic.ts and openrouter.ts included:
 *    transcript validation, the replay rule, the chat-completions tool-call stream, unique call ids.
 *
 * Nothing here knows a wire shape: a client passes a `consume` that turns its own stream into a `ProviderOutcome`.
 */
import { JevCodeError, ProviderHttpError } from '../errors.js';
import { isJsonObject, parseJson } from '../core/json.js';
import type { AgentAssistantBlock, AgentMessage, AgentRequest, AgentUserBlock, GenerateOptions, GenerateReasoning, GenerateRequest, GenerateResult, Json, JsonObject, ProviderReplayState, ToolCall } from '../core/types.js';
import {
  FIRST_BYTE_TIMEOUT_MS,
  IdleTimeoutError,
  TransportError,
  clipMessage,
  costFromPricing,
  getObj,
  getStr,
  httpError,
  linkedAbort,
  notify,
  reportFirstByte,
  parseJsonObject,
  rateLimitLedger,
  rateLimitedCancellation,
  readBodyCapped,
  requestIdOf,
  toCancelledGeneration,
  toTokenUsage,
  withRetry,
} from './sse.js';
import type { ChatAgentMessage, ModelInfo, ProviderConfig, ProviderDeps, ProviderOutcome, StreamPartial, TokenBreakdown } from './types.js';

/** §4.8: filled in a client's abort branch with what the stream had produced; read after the retry loop rethrows the abort reason. */
export interface HeldPartial {
  partial: StreamPartial | null;
  /**
   * What the stream had produced when a MID-STREAM 429 frame killed the attempt (`isRateLimit`). Separate from
   * `partial`, which stays the abort-only slot: this one is read only on the rate-limited ending, so `onCancelled`
   * still fires exactly where core/types.ts documents it — just with the tokens that were served instead of zeros.
   */
  streamed: StreamPartial | null;
}

/** Everything a `consume` implementation needs besides the byte stream. */
export interface ConsumeContext {
  opts: GenerateOptions;
  redact: (s: string) => string;
  /** what is left of the 30 s first-byte budget after the header phase */
  firstByteTimeoutMs: number;
  /** TUI-DESIGN §15 item 4: the 200 response's request id, so a mid-stream error frame can name the stream that failed */
  requestId: string | null;
  held: HeldPartial;
  /**
   * contract 1.9 (Fastlane) §3.1: hand this to `parseSse` / `readStreamText` as `onFirstByte`. It is already
   * measured from the REQUEST going out (the header phase included) and already guarded, so a client passes it
   * through unchanged; it is absent when the caller asked for no TTFB, and then the clients pass nothing.
   */
  onFirstByte?: (ms: number) => void;
}

/** What a client extracted from a non-200 body; `retryable` null = keep the status-based decision (`isRetryableStatus`). */
export interface ErrorFields {
  kind: string | null;
  message: string | null;
  requestId: string | null;
  retryable: boolean | null;
}

export type ErrorReader = (body: JsonObject | null, status: number, headers: Headers) => ErrorFields;

/** HTTP 429s that mean "the account is out of money", which no amount of waiting fixes (OpenAI guides/error-codes). */
const BILLING_429_CODES: ReadonlySet<string> = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active']);

/**
 * `{"error": {"message", "type", "param", "code"}}` — OpenAI's envelope, used verbatim by Fireworks (`code` carries a
 * label like `UNAUTHORIZED`, `type` is just `"error"`) and api.meta.ai. Fireworks also puts a `request_id` at the top
 * level. xAI answers some 400s with a FLAT variant instead — `{"code": "invalid-argument", "error": "<message>"}` —
 * so a string `error` is read as the message and the top-level `code` as the kind (measured: the `reasoning_effort:
 * none` rejection); without this the message would degrade to a bare `xai HTTP 400`.
 */
export const openAiErrorFields: ErrorReader = (body, status) => {
  const flat = getStr(body ?? null, 'error');
  const err = getObj(body, 'error');
  const type = getStr(err, 'type');
  const code = getStr(err, 'code') ?? getStr(body ?? null, 'code');
  const kind = type !== null && type !== 'error' ? type : code;
  const quota = code !== null && BILLING_429_CODES.has(code);
  return {
    kind,
    message: getStr(err, 'message') ?? flat,
    requestId: getStr(body ?? null, 'request_id'),
    // a 429 that is really a billing state is reported at once instead of burning the retry budget
    retryable: status === 429 && quota ? false : null,
  };
};

/**
 * Google's `{"error": {"code", "message", "status", "details"}}` (ai.google.dev/gemini-api/docs/api-errors). `status` is the
 * `google.rpc.Code` name — `RESOURCE_EXHAUSTED` is the retryable one, and a 400 `FAILED_PRECONDITION` ("enable billing")
 * or a 403 `PERMISSION_DENIED` (`API_KEY_SERVICE_BLOCKED`, what this project's key returns today) never is.
 */
export const googleErrorFields: ErrorReader = (body, status) => {
  const err = getObj(body, 'error');
  const rpc = getStr(err, 'status');
  const details = err?.['details'];
  let reason: string | null = null;
  if (Array.isArray(details)) {
    for (const d of details) {
      const r = getStr(typeof d === 'object' && d !== null && !Array.isArray(d) ? d : null, 'reason');
      if (r !== null) {
        reason = r;
        break;
      }
    }
  }
  const kind = reason !== null && rpc !== null ? `${rpc} ${reason}` : (rpc ?? reason);
  return { kind, message: getStr(err, 'message'), requestId: null, retryable: status === 429 ? true : null };
};

/** One request, as `createCaller` runs it. */
export interface HttpCall<T> {
  /** the provider label every message and RetryCause carries (`openai`, `gemini`, …) */
  label: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  readError: ErrorReader;
  consume: (stream: ReadableStream<Uint8Array>, ctx: ConsumeContext) => Promise<T>;
}

export interface ProviderCaller {
  attempt<T>(call: HttpCall<T>, opts: GenerateOptions, held: HeldPartial): Promise<T>;
}

/** The same guard rails openrouter.ts applies before a request is built; a bad request is status 0 and never retried. */
export function validateGenerateRequest(label: string, req: GenerateRequest): void {
  const bad = (msg: string): never => {
    throw new ProviderHttpError(`${label}: invalid GenerateRequest: ${msg}`, { status: 0, retryable: false });
  };
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) bad(`maxTokens must be a positive integer, got ${String(req.maxTokens)}`);
  const messages = messagesError(req);
  if (messages !== null) bad(messages);
  if (req.temperature !== null && !Number.isFinite(req.temperature)) bad('temperature must be a finite number or null');
  if (req.seed !== undefined && !Number.isInteger(req.seed)) bad(`seed must be an integer, got ${String(req.seed)}`);
  if (req.reasoning !== undefined && 'maxTokens' in req.reasoning && (!Number.isInteger(req.reasoning.maxTokens) || req.reasoning.maxTokens <= 0)) {
    bad(`reasoning.maxTokens must be a positive integer, got ${String(req.reasoning.maxTokens)}`);
  }
}

export function createCaller(d: Required<ProviderDeps>): ProviderCaller {
  return {
    async attempt<T>(call: HttpCall<T>, opts: GenerateOptions, held: HeldPartial): Promise<T> {
      const { controller, unlink } = linkedAbort(opts.signal);
      const t0 = d.now();
      let headersTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The header phase shares the first-byte budget: a server that never answers is a retryable timeout.
        const headersTimeout = new Promise<never>((_, reject) => {
          headersTimer = setTimeout(() => {
            controller.abort(new IdleTimeoutError('first_byte', FIRST_BYTE_TIMEOUT_MS));
            reject(new IdleTimeoutError('first_byte', FIRST_BYTE_TIMEOUT_MS));
          }, FIRST_BYTE_TIMEOUT_MS);
        });
        let res: Response;
        try {
          res = await Promise.race([
            // the defaults come first so a client that does not stream can set `accept: application/json` in its own headers
            d.fetch(call.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...call.headers }, body: call.body, signal: controller.signal }),
            headersTimeout,
          ]);
        } catch (e) {
          if (opts.signal.aborted) throw opts.signal.reason;
          if (e instanceof ProviderHttpError) throw e;
          // TUI-DESIGN §15 item 5: RetryCause kind 'network' with the errno from the cause chain
          throw new TransportError('network', d.redact(`${call.label}: network error: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
        } finally {
          clearTimeout(headersTimer);
        }
        // TUI-DESIGN §15 item 4 / §10 (F9): server-controlled wire text, redacted before it can reach state.json
        const requestId = requestIdOf(res.headers, d.redact);
        if (res.status !== 200) {
          const bodyText = await readBodyCapped(res);
          const fields = call.readError(parseJsonObject(bodyText), res.status, res.headers);
          throw httpError({
            provider: call.label,
            status: res.status,
            headers: res.headers,
            body: bodyText,
            redact: d.redact,
            requestId: requestId ?? fields.requestId,
            ...(fields.kind !== null ? { kind: fields.kind } : {}),
            ...(fields.message !== null ? { message: fields.message } : {}),
            ...(fields.retryable !== null ? { retryableOverride: fields.retryable } : {}),
          });
        }
        if (!res.body) throw new TransportError('stream', `${call.label}: 200 without a body`);
        const remaining = Math.max(1, FIRST_BYTE_TIMEOUT_MS - (d.now() - t0));
        // contract 1.9 (Fastlane) §3.1: TTFB is measured from the request going out, not from the body's first read, and
        // `reportFirstByte` makes it once per `generate()` — the first attempt that actually streamed — rather than once
        // per attempt. It keeps a throwing callback a typed 'internal' error, not a transport failure the loop re-bills.
        const onFirstByte = opts.onFirstByte === undefined ? undefined : (): void => reportFirstByte(opts, Math.round(d.now() - t0));
        try {
          return await call.consume(res.body, { opts, redact: d.redact, firstByteTimeoutMs: remaining, requestId, held, ...(onFirstByte === undefined ? {} : { onFirstByte }) });
        } catch (e) {
          if (opts.signal.aborted) throw opts.signal.reason;
          // Typed errors (HTTP / stream errors, renderer-callback bugs via notify) keep their class; anything else
          // (decoder faults, connection resets) is a transport failure and retried (RetryCause kind 'stream').
          if (e instanceof JevCodeError) throw e;
          throw new TransportError('stream', d.redact(`${call.label}: stream failure: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
        } finally {
          // a no-op for the connection once parseSse has drained the body to EOF: the socket is already back in the pool (keepalive.test.ts)
          controller.abort();
        }
      } finally {
        unlink();
      }
    },
  };
}

/**
 * The cost of one call in USD: what the API charged when it says so, else the table when the model is priced, else NaN so
 * the engine can emit `budget:unpriced` (TUI-DESIGN §9.5) instead of silently billing $0.
 */
export function priceOutcome(cfg: ProviderConfig, tokens: TokenBreakdown, reported: number | null): number {
  if (reported !== null) return reported;
  return cfg.priced === true ? costFromPricing(cfg.pricing, tokens) : Number.NaN;
}

/**
 * Run one `generate()`: the retry chain, the 429 ledger, §4.8's cancellation record and the `GenerateResult`.
 * `attempt` performs one HTTP attempt and must fill `held.partial` when an abort lands on an open stream.
 */
export async function runGeneration(
  d: Required<ProviderDeps>,
  cfg: ProviderConfig,
  opts: GenerateOptions,
  attempt: (held: HeldPartial) => Promise<ProviderOutcome>,
): Promise<GenerateResult> {
  const t0 = d.now();
  const held: HeldPartial = { partial: null, streamed: null };
  const limited = rateLimitLedger();
  const tablePrice = (t: TokenBreakdown): number => (cfg.priced === true ? costFromPricing(cfg.pricing, t) : Number.NaN);
  let out: ProviderOutcome;
  try {
    // TUI-DESIGN §15.2: GenerateOptions.onRetry / wake thread into withRetry (§13.2)
    out = await withRetry(d, opts.signal, () => limited.track(() => attempt(held)), opts);
  } catch (e) {
    // §4.8: `held.partial` is set only by an abort that landed on an open stream, and only the abort reason reaches here
    // then. A throwing callback is a harness bug and must surface (typed 'internal', like a throwing onDelta), not vanish.
    if (held.partial !== null) notify(opts.onCancelled, toCancelledGeneration(held.partial, tablePrice));
    // A chain that ended on 429s reports the fact. When the last 429 was a mid-stream frame the stream HAD been served
    // (and billed), so the record is the streamed one with the flag added rather than "nothing was served".
    else if (limited.last) notify(opts.onCancelled, held.streamed === null ? rateLimitedCancellation() : rateLimitedCancellation(toCancelledGeneration(held.streamed, tablePrice)));
    throw e;
  }
  return {
    text: out.text,
    toolCalls: out.toolCalls,
    usage: toTokenUsage(out.tokens, priceOutcome(cfg, out.tokens, out.cost), out.reasoningTokens),
    model: out.model ?? cfg.model,
    stopReason: out.stopReason,
    latencyMs: Math.round(d.now() - t0),
    ...(out.generationId !== null ? { generationId: out.generationId } : {}),
    ...(out.servedProvider !== null ? { servedProvider: out.servedProvider } : {}),
    ...(limited.attempts > 0 ? { rateLimited: true } : {}),
    // AGENT-LOOP-DESIGN §6.1: set only by an agent request's stream, so a legacy result keeps exactly today's keys
    ...(out.providerState !== undefined ? { providerState: out.providerState } : {}),
    ...(out.warnings !== undefined && out.warnings.length > 0 ? { warnings: out.warnings } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// AGENT-LOOP-DESIGN §6.1-§6.2: the agent half every adapter shares. Nothing below runs for a request without `agent`
// except `messagesError`'s first line (today's rule) and `toolStream` with `split` false (today's accumulator).
// ---------------------------------------------------------------------------------------

/**
 * Why a request's messages cannot be sent, or null. Without `agent` this is today's rule, a non-empty `messages`. With
 * `agent` the caller sends `messages: []` (ignored either way) and the transcript is checked instead, against what every
 * wire here rejects with a 400 anyway — so a harness bug fails fast as a non-retryable status-0 error naming the
 * message instead of spending a round trip: the transcript starts and ends with a user message; every `tool_use` id is
 * unique and non-empty and is answered by a `tool_result` in the very next (user) message; every `tool_result` answers a
 * `tool_use` of the assistant message right before it (Anthropic: "tool_use ids were found without tool_result blocks
 * immediately after"; OpenAI: "an assistant message with 'tool_calls' must be followed by tool messages"). A user message
 * whose blocks are all empty text is refused too: every wire drops empty text, so it would go out as `content: []` /
 * `parts: []` (a 400) or vanish from the chat transcript altogether.
 */
export function messagesError(req: GenerateRequest): string | null {
  const a = req.agent;
  if (a === undefined) return req.messages.length === 0 ? 'messages is empty' : null;
  if (typeof a.cacheKey !== 'string') return 'agent.cacheKey must be a string';
  const ms: readonly AgentMessage[] = Array.isArray(a.messages) ? a.messages : [];
  if (ms.length === 0) return 'agent.messages is empty';
  const seen = new Set<string>();
  let open: Set<string> | null = null;
  for (const [i, m] of ms.entries()) {
    const at = `agent.messages[${i}]`;
    if (!Array.isArray(m.content) || m.content.length === 0) return `${at} has no content`;
    if (m.role === 'user') {
      const answered = new Set<string>();
      for (const b of m.content as readonly AgentUserBlock[]) {
        if (b.type === 'text') {
          if (typeof b.text !== 'string') return `${at}: a text block needs a string`;
        } else if (b.type === 'tool_result') {
          if (typeof b.toolUseId !== 'string' || b.toolUseId === '' || typeof b.name !== 'string' || typeof b.content !== 'string') return `${at}: a tool_result needs toolUseId, name and content strings`;
          if (open === null || !open.has(b.toolUseId)) return `${at}: tool_result ${b.toolUseId} answers no tool_use of the assistant message before it`;
          if (answered.has(b.toolUseId)) return `${at}: tool_result ${b.toolUseId} appears twice`;
          answered.add(b.toolUseId);
        } else return `${at}: unknown user block`;
      }
      for (const id of open ?? []) if (!answered.has(id)) return `${at}: tool_use ${id} has no tool_result`;
      if ((m.content as readonly AgentUserBlock[]).every((b) => b.type === 'text' && b.text === '')) return `${at} has only empty text`;
      open = null;
    } else if (m.role === 'assistant') {
      if (i === 0) return 'agent.messages must start with a user message';
      const unanswered = open === null ? undefined : [...open][0];
      if (unanswered !== undefined) return `${at}: tool_use ${unanswered} has no tool_result`;
      open = new Set();
      for (const b of m.content as readonly AgentAssistantBlock[]) {
        if (b.type === 'text') {
          if (typeof b.text !== 'string') return `${at}: a text block needs a string`;
        } else if (b.type === 'tool_use') {
          if (typeof b.id !== 'string' || b.id === '' || typeof b.name !== 'string' || b.name === '') return `${at}: a tool_use needs a non-empty id and name`;
          if (seen.has(b.id)) return `${at}: tool_use id ${b.id} is not unique`;
          seen.add(b.id);
          open.add(b.id);
        } else return `${at}: unknown assistant block`;
      }
      const ps = m.providerState;
      if (ps !== undefined && (typeof ps !== 'object' || ps === null || typeof ps.provider !== 'string' || typeof ps.model !== 'string')) return `${at}: providerState needs provider and model`;
    } else return `${at}: unknown role`;
  }
  return ms[ms.length - 1]!.role === 'user' ? null : 'agent.messages must end with a user message';
}

/**
 * §6.5's replay rule: an assistant record's `providerState.data` when replay is on and the record came from THIS provider
 * and the CONFIGURED model (never the served id); null otherwise, and the adapter then sends no reasoning state.
 */
export function replayData(a: AgentRequest, m: AgentMessage, provider: string, model: string): Json | null {
  if (!a.replayReasoning || m.role !== 'assistant' || m.providerState === undefined) return null;
  return m.providerState.provider === provider && m.providerState.model === model ? m.providerState.data : null;
}

export type AgentToolResult = Extract<AgentUserBlock, { type: 'tool_result' }>;
export type AgentToolUse = Extract<AgentAssistantBlock, { type: 'tool_use' }>;

/** A user message split the way every wire wants it: the tool results (first on the wire) and the non-empty texts. */
export function userParts(content: readonly AgentUserBlock[]): { results: AgentToolResult[]; texts: string[] } {
  const results: AgentToolResult[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (b.type === 'tool_result') results.push(b);
    else if (b.text.length > 0) texts.push(b.text);
  }
  return { results, texts };
}

/** An assistant message as prose (its non-empty text blocks, joined) and its calls, in order. */
export function assistantParts(content: readonly AgentAssistantBlock[]): { text: string; calls: AgentToolUse[] } {
  const texts: string[] = [];
  const calls: AgentToolUse[] = [];
  for (const b of content) {
    if (b.type === 'tool_use') calls.push(b);
    else if (b.text.length > 0) texts.push(b.text);
  }
  return { text: texts.join('\n\n'), calls };
}

/**
 * An agent turn's reasoning control: the request's, except `{enabled: false}`, which no agent turn sends (S2 amendment A4:
 * GLM answers it with HTTP 400; Opus 5.5 and Fable 5.1 cannot disable thinking) — it goes out as the model's default.
 */
export function agentReasoning(req: GenerateRequest): GenerateReasoning | undefined {
  return req.reasoning !== undefined && 'enabled' in req.reasoning ? undefined : req.reasoning;
}

/** Every wire here wants a call's arguments as a JSON object; a malformed call recorded with non-object input goes out as `{}`. */
export function objectInput(input: Json): JsonObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
}

type ChatReplay = Pick<Extract<ChatAgentMessage, { role: 'assistant' }>, 'reasoning_details' | 'reasoning_content'>;

/**
 * §6.2's chat-completions transcript (OpenRouter and openai-compat): an assistant turn is its prose — `null` exactly when it
 * carries calls and no prose, OpenAI's rule — its `tool_calls` with their ids, and whatever `replay` returns for it (the
 * adapter's reasoning field, already filtered by `replayData`); a user turn is one `tool` message per result, then one
 * `user` message for its texts.
 */
export function chatAgentMessages(a: AgentRequest, replay: (m: Extract<AgentMessage, { role: 'assistant' }>) => ChatReplay | null): ChatAgentMessage[] {
  const out: ChatAgentMessage[] = [];
  for (const m of a.messages) {
    if (m.role === 'user') {
      const { results, texts } = userParts(m.content);
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') });
      continue;
    }
    const { text, calls } = assistantParts(m.content);
    out.push({
      role: 'assistant',
      content: text.length > 0 || calls.length === 0 ? text : null,
      ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(objectInput(c.input)) } })) } : {}),
      ...replay(m),
    });
  }
  return out;
}

/**
 * What an assistant turn with nothing to send (an empty reply: no text, no call) goes out as on the wires that reject an
 * empty turn — Anthropic's `content: []` and Gemini's `parts: []` are a 400. The chat wires send `''` and Responses sends
 * no item, so they need none.
 */
export const EMPTY_TURN_TEXT = '(no content)';

/** The prefix of an id this harness made up for a call the provider sent without one (gemini.ts sends no id for these). */
export const SYNTH_CALL_PREFIX = 'jc_';

/** A tool call's id on an agent result: the provider's, or a made-up unique one (the transcript threads results by it). */
export function agentCallId(id: string, ordinal: number): string {
  return id.length > 0 ? id : `${SYNTH_CALL_PREFIX}${Math.random().toString(36).slice(2, 10)}_${ordinal}`;
}

/**
 * Where an adapter's replay state names a call by id (`providerState.data[list][]` items of `type`, the id under `key`):
 * Anthropic's `blocks` tool_use markers, the Responses `output` function_call markers. A renamed call is renamed there
 * too, so the next turn's replay still finds it at its captured position.
 */
export interface CallIdMarkers {
  list: string;
  type: string;
  key: string;
}

/**
 * §6.1's "(unique)" id, made to hold by construction on an agent result: a call whose id is empty, repeats an earlier call
 * of the same turn, or repeats any `tool_use` id already in the transcript gets a made-up one (some OpenAI-compatible
 * upstreams number their calls `call_0`, `call_1` afresh every turn, which would otherwise make the NEXT request fail
 * `messagesError`), and `markers` carry the rename into the replay state (the n-th marker of a wire id is the n-th call
 * of it). The streamed `onToolCall` fragments carried the WIRE id: the transcript keys on `GenerateResult.toolCalls[].id`.
 */
export function withUniqueCallIds(res: GenerateResult, a: AgentRequest, markers?: CallIdMarkers): GenerateResult {
  const seen = new Set<string>();
  for (const m of a.messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') seen.add(b.id);
  const nth = new Map<string, number>();
  const renames = new Map<string, string>();
  for (const [i, c] of res.toolCalls.entries()) {
    const wire = c.id ?? '';
    const k = nth.get(wire) ?? 0;
    nth.set(wire, k + 1);
    const id = wire.length === 0 || seen.has(wire) ? agentCallId('', i) : wire;
    if (id !== wire && wire.length > 0) renames.set(`${k}:${wire}`, id);
    c.id = id;
    seen.add(id);
  }
  if (renames.size > 0 && markers !== undefined && res.providerState !== undefined) res.providerState = renamedMarkers(res.providerState, markers, renames);
  return res;
}

function renamedMarkers(state: ProviderReplayState, m: CallIdMarkers, renames: ReadonlyMap<string, string>): ProviderReplayState {
  const data = state.data;
  const list = isJsonObject(data) ? data[m.list] : undefined;
  if (!isJsonObject(data) || !Array.isArray(list)) return state;
  const nth = new Map<string, number>();
  const next = list.map((item): Json => {
    const id = isJsonObject(item) && item['type'] === m.type ? item[m.key] : undefined;
    if (!isJsonObject(item) || typeof id !== 'string') return item;
    const k = nth.get(id) ?? 0;
    nth.set(id, k + 1);
    const to = renames.get(`${k}:${id}`);
    return to === undefined ? item : { ...item, [m.key]: to };
  });
  return { ...state, data: { ...data, [m.list]: next } };
}

/**
 * A chat-completions `function.arguments` value as a fragment: the string the spec sends, or — agent requests only — an
 * object some OpenAI-compatible upstreams send instead (GLM, non-streamed JSON transports), serialised rather than lost
 * as `{}`. A legacy request keeps today's reading (a non-string is no fragment).
 */
export function argumentsFragment(raw: Json | undefined, agent: boolean): string {
  if (typeof raw === 'string') return raw;
  return agent && isJsonObject(raw) ? JSON.stringify(raw) : '';
}

/** One `onToolCall` fragment (§6.1). `index` is the call's ORDINAL — its position in `GenerateResult.toolCalls` — not a wire index. */
export function emitToolCall(opts: GenerateOptions, index: number, id: string, name: string, fragment: string): void {
  notify(opts.onToolCall, { index, ...(id.length > 0 ? { id } : {}), ...(name.length > 0 ? { name } : {}), fragment });
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
  ordinal: number;
}

export interface ToolStream {
  /** one `delta.tool_calls[]` entry of a chat-completions stream */
  push(index: number, id: string | null, name: string | null, frag: string): void;
  /** the calls in order of first appearance; `agent` keeps (or makes up) the ids */
  calls(agent: boolean): ToolCall[];
}

/**
 * The chat-completions tool-call accumulator openrouter.ts and openai-compat.ts share: keyed by stream `index`, name and
 * id overwritten when non-empty, `onToolDelta` per non-empty fragment — exactly the legacy one. With `split` (agent
 * requests only) a chunk that NAMES a function under a non-empty id different from the id already stored at its index
 * starts a NEW call instead of concatenating (§6.2: some OpenAI-compatible upstreams stream parallel calls that share one
 * index). A new call always opens with its name (the OpenAI streaming shape), so an upstream that re-stamps a fresh id on
 * every argument chunk of ONE call does not split it into fragments. `onToolCall` fires
 * next to `onToolDelta`, and also once when a chunk first names the call, so a renderer can say "writing edit_file…"
 * before any argument arrives.
 */
export function toolStream(opts: GenerateOptions, split: boolean): ToolStream {
  const byIndex = new Map<number, ToolAcc>();
  const list: ToolAcc[] = [];
  return {
    push(index, id, name, frag) {
      let acc = byIndex.get(index);
      if (acc === undefined || (split && id !== null && id.length > 0 && name !== null && name.length > 0 && acc.id.length > 0 && acc.id !== id)) {
        acc = { id: '', name: '', args: '', ordinal: list.length };
        byIndex.set(index, acc);
        list.push(acc);
      }
      // with `split` the id a call opened under stays its id, so a re-stamped argument chunk neither renames nor splits it
      const adoptId = id !== null && id.length > 0 && id !== acc.id && (!split || acc.id.length === 0);
      const learned = adoptId || (name !== null && name.length > 0 && name !== acc.name);
      if (adoptId) acc.id = id;
      if (name) acc.name = name;
      if (frag.length > 0) {
        acc.args += frag;
        notify(opts.onToolDelta, frag);
      }
      if (frag.length > 0 || learned) emitToolCall(opts, acc.ordinal, acc.id, acc.name, frag);
    },
    calls(agent) {
      return list.map((acc) => {
        const args = acc.args.length > 0 ? acc.args : '{}';
        const p = parseJson(args);
        // Invalid or truncated arguments keep the raw text with input null; actions.ts / the agent's repair reject them.
        const call: ToolCall = { name: acc.name, input: p.ok ? p.value : null, rawJson: args };
        if (agent) call.id = agentCallId(acc.id, acc.ordinal);
        return call;
      });
    },
  };
}

/** One redacted, clipped line per distinct notice (`GenerateResult.warnings`). */
export function warningLines(lines: readonly string[], redact: (s: string) => string): string[] {
  return [...new Set(lines.map((l) => clipMessage(redact(l))))];
}

/** `baseUrl` without trailing slashes, so `${base}${path}` is stable whatever the config carried. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Newest first, then by id, so a picker's first rows are the current flagships. Sorts in place and returns the array. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

/** How long a catalogue GET may take in total (`listModels` is an interactive lookup, not a generation). */
export const LIST_TIMEOUT_MS = 30_000;

export interface GetJsonOptions {
  label: string;
  url: string;
  headers: Record<string, string>;
  deps: ProviderDeps;
  readError?: ErrorReader;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One GET returning a JSON object — the shape every `ProviderSpec.listModels` needs (`GET /models`). Errors are the same
 * typed, redacted, bounded `ProviderHttpError` a generation gets, so a key mistake surfaces identically in both paths.
 */
export async function getJson(o: GetJsonOptions): Promise<JsonObject> {
  const fetchImpl = o.deps.fetch ?? globalThis.fetch;
  const redact = o.deps.redact;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? LIST_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(o.url, { method: 'GET', headers: { accept: 'application/json', ...o.headers }, signal });
  } catch (e) {
    if (o.signal?.aborted) throw o.signal.reason;
    throw new TransportError('network', redact(`${o.label}: network error listing models: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
  }
  const bodyText = await readBodyCapped(res, 4_000_000);
  const json = parseJsonObject(bodyText);
  if (res.status !== 200) {
    const fields = (o.readError ?? openAiErrorFields)(json, res.status, res.headers);
    throw httpError({
      provider: o.label,
      status: res.status,
      headers: res.headers,
      body: bodyText,
      redact,
      requestId: requestIdOf(res.headers, redact) ?? fields.requestId,
      ...(fields.kind !== null ? { kind: fields.kind } : {}),
      ...(fields.message !== null ? { message: fields.message } : {}),
      ...(fields.retryable !== null ? { retryableOverride: fields.retryable } : {}),
    });
  }
  if (json === null) throw new TransportError('invalid', `${o.label}: model list was not a JSON object`);
  return json;
}
