/**
 * OpenRouter chat-completions client over raw fetch + SSE (DESIGN.md §7, research 07 §2, §4, §5).
 * Streams `choices[0].delta.content` to `onDelta`, accumulates `delta.tool_calls[i].function.arguments`
 * by index for `onToolDelta`, and takes `usage.cost` from the accounting frame that precedes `[DONE]`.
 * LLM-JEV-DESIGN §4.12: maps `seed` / `reasoning` / `providerPrefs`, records `reasoning_tokens`, the served
 * `provider` and the generation `id`, and hands a cancelled stream's partial accounting to `onCancelled` (§4.8).
 */
import { JevCodeError, ProviderHttpError } from '../errors.js';
import type { GeneratorConfig, JsonObject, ToolCall } from '../core/types.js';
import { parseJson } from '../core/json.js';
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
  parseRetryAfter,
  parseSse,
  readBodyCapped,
  requestIdOf,
  resolveDeps,
  sanitiseRequestId,
  toTokenUsage,
  withRetry,
} from './sse.js';
import type {
  CancelledGeneration,
  GenerateOptionsExt,
  GenerateRequestExt,
  GenerateResultExt,
  OpenRouterProviderPrefs,
  OpenRouterReasoning,
  OpenRouterRequestBody,
  OpenRouterToolChoice,
  ProviderDeps,
  ProviderExt,
  TokenBreakdown,
  TokenUsageExt,
} from './types.js';

export const OPENROUTER_REFERER = 'https://github.com/prateekjannu/jevcode';
export const OPENROUTER_TITLE = 'jevcode';

function validateRequest(req: GenerateRequestExt): void {
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
    throw new ProviderHttpError(`invalid GenerateRequest: maxTokens must be a positive integer, got ${String(req.maxTokens)}`, { status: 0, retryable: false });
  }
  if (req.messages.length === 0) throw new ProviderHttpError('invalid GenerateRequest: messages is empty', { status: 0, retryable: false });
  if (req.temperature !== null && !Number.isFinite(req.temperature)) {
    throw new ProviderHttpError('invalid GenerateRequest: temperature must be a finite number or null', { status: 0, retryable: false });
  }
  if (req.seed !== undefined && !Number.isInteger(req.seed)) {
    throw new ProviderHttpError(`invalid GenerateRequest: seed must be an integer, got ${String(req.seed)}`, { status: 0, retryable: false });
  }
}

/**
 * Exported so tests can assert the exact wire body.
 *
 * Model compatibility (no branch on the id — one body shape for every OpenRouter model):
 * - `z-ai/glm-5.3-flash` (the default generator, DECISIONS 2026-09-21): tools, tool_choice, parallel_tool_calls,
 *   structured_outputs, temperature and max_tokens are all in its supported-parameters list; `strict: true` on a
 *   function tool passes through (verified live 2026-09-21: a forced tool call came back with valid arguments).
 *   Max completion 131,072 tokens and context 1,310,720 — `--max-tokens` above 131,072 is a 400 from the API, not a
 *   silent clamp here (the default is 4,096).
 * - `anthropic/*`: OpenRouter maps `parallel_tool_calls: false` to `disable_parallel_tool_use` and `strict` to the
 *   Messages API's strict tool schema; `temperature` is omitted when the request says null (Sonnet 5 400s on it).
 * `parallel_tool_calls: false` is sent whenever tools are present: the loop consumes exactly one action per step.
 *
 * LLM-JEV-DESIGN §4.12 (all optional, absent from the wire when the request omits them): `seed` (GLM lists it; the N
 * samples of a round differ by seed, §4.6); `reasoning` → OpenRouter's `reasoning` object; `providerPrefs` →
 * `provider: {require_parameters, order}` (routes only to endpoints that support every parameter sent, e.g. tools + seed;
 * `order` pins the upstream so the served rate is the priced one).
 *
 * Live 2026-09-21 (stage-2 probe, `seed: 7`, forced tool, GLM 5.3 flash): `reasoning: {enabled: false}` is HTTP 400
 * "Reasoning is mandatory for this endpoint and cannot be disabled" — the models API lists `reasoning.mandatory: true`,
 * efforts `max | high | low`, default `max`, for every `z-ai/glm-5.3*`. `{enabled: true, effort: 'low'}` was accepted:
 * 486 ms, served by CoreWeave (32 endpoints; 3 at $0.075/$0.25, most at $0.15/$0.50), `id` and `provider` returned,
 * `reasoning_tokens: 0`, valid arguments, `usage.cost` = CoreWeave's rate exactly. This client sends what it is asked
 * and never rewrites the field: the caller picks `effort: 'low'` for GLM (`GenerateReasoning` in types.ts).
 */
export function buildOpenRouterBody(cfg: GeneratorConfig, req: GenerateRequestExt): OpenRouterRequestBody {
  const messages: OpenRouterRequestBody['messages'] = [];
  if (req.system.length > 0) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body: OpenRouterRequestBody = {
    model: cfg.model,
    messages,
    stream: true,
    max_tokens: req.maxTokens,
    usage: { include: true },
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema, strict: true } }));
    if (req.toolChoice !== undefined) body.tool_choice = toolChoice(req.toolChoice);
    body.parallel_tool_calls = false;
  }
  // null means "do not send the parameter" (core/types.ts GenerateRequest); cfg.temperature is not a fallback.
  if (req.temperature !== null) body.temperature = req.temperature;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.reasoning !== undefined) body.reasoning = reasoningOf(req.reasoning);
  const provider = providerPrefsOf(req.providerPrefs);
  if (provider !== null) body.provider = provider;
  return body;
}

function reasoningOf(r: NonNullable<GenerateRequestExt['reasoning']>): OpenRouterReasoning {
  // `effort` alone implies enabled on OpenRouter; `enabled` is sent explicitly so the intent survives a model whose default differs.
  return r.enabled && r.effort !== undefined ? { enabled: true, effort: r.effort } : { enabled: r.enabled };
}

function providerPrefsOf(p: GenerateRequestExt['providerPrefs']): OpenRouterProviderPrefs | null {
  if (p === undefined) return null;
  const out: OpenRouterProviderPrefs = {};
  if (p.requireParameters !== undefined) out.require_parameters = p.requireParameters;
  if (p.order !== undefined && p.order.length > 0) out.order = [...p.order];
  return Object.keys(out).length > 0 ? out : null;
}

function toolChoice(tc: NonNullable<GenerateRequestExt['toolChoice']>): OpenRouterToolChoice {
  if (tc === 'auto' || tc === 'required') return tc;
  return { type: 'function', function: { name: tc.name } };
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

interface StreamOutcome {
  text: string;
  toolCalls: ToolCall[];
  tokens: TokenBreakdown;
  /** usage.cost when the API reported one */
  cost: number | null;
  /** `completion_tokens_details.reasoning_tokens` when the accounting frame carried it */
  reasoningTokens: number | null;
  model: string | null;
  /** the chunk `id` (`gen-…`), the handle for `GET /api/v1/generation?id=` */
  generationId: string | null;
  /** the response `provider` field: which upstream served (and billed) the request */
  servedProvider: string | null;
  /** verbatim `finish_reason` — `stop` / `tool_calls` / `length` (truncated: the caller decides, never a blind retry) */
  finishReason: string;
}

/** What `consumeStream` needs besides the body: the caller's options plus what a cancelled stream's estimate is priced from. */
interface StreamContext {
  opts: GenerateOptionsExt;
  redact: (s: string) => string;
  firstByteTimeoutMs: number;
  requestId: string | null;
  /** characters of the request body sent — the prompt side of a cancelled stream's estimate (chars / 4) */
  promptChars: number;
  /** the table price for a breakdown, or NaN for an unpriced model (the engine emits budget:unpriced) */
  tablePrice: (t: TokenBreakdown) => number;
}

/** chars / 4: the estimate used for a stream that ended before its accounting frame (§4.8; the id can replace it post hoc) */
const CHARS_PER_TOKEN = 4;
function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A `data:` chunk with a top-level `error` after HTTP 200 (research 07 §2.3): map to its status. */
function chunkError(err: JsonObject | null, redact: (s: string) => string, requestId: string | null): ProviderHttpError {
  const rawCode = err?.['code'];
  const status = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : typeof rawCode === 'string' && /^\d{3}$/.test(rawCode) ? Number(rawCode) : 500;
  const kind = getStr(getObj(err, 'metadata'), 'error_type') ?? '';
  const message = getStr(err, 'message') ?? '';
  return new ProviderHttpError(clipMessage(redact(`openrouter stream error ${status}${kind ? ` ${kind}` : ''}: ${message}`)), {
    status,
    retryable: isRetryableStatus(status),
    body: redact(JSON.stringify(err ?? {})).slice(0, 2048),
    requestId, // TUI-DESIGN §15 item 4: the 200 response's request id names the stream that failed
  });
}

async function consumeStream(body: ReadableStream<Uint8Array>, ctx: StreamContext): Promise<StreamOutcome> {
  const { opts, redact, requestId } = ctx;
  let text = '';
  let reasoningChars = 0;
  let toolChars = 0;
  let model: string | null = null;
  let generationId: string | null = null;
  let servedProvider: string | null = null;
  let finishReason: string | null = null;
  let sawDone = false;
  let sawUsage = false;
  let cost: number | null = null;
  let reasoningTokens: number | null = null;
  const tokens: TokenBreakdown = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const tools = new Map<number, ToolAcc>();
  const order: number[] = [];

  /**
   * §4.8: the signal fired while the stream was open. The accounting frame will never arrive, so the caller gets a
   * chars / 4 estimate (marked) plus the ids that let it be replaced post hoc; the abort reason is then rethrown,
   * so the sample still yields no GenerateResult.
   */
  const cancelled = (): CancelledGeneration => {
    const estimated = !sawUsage;
    const t: TokenBreakdown = estimated
      ? { input: tokensFromChars(ctx.promptChars), cacheRead: 0, cacheWrite: 0, output: tokensFromChars(text.length + toolChars + reasoningChars) }
      : tokens;
    const usage: TokenUsageExt = { ...toTokenUsage(t, estimated || cost === null ? ctx.tablePrice(t) : cost), estimated };
    const rt = estimated ? (reasoningChars > 0 ? tokensFromChars(reasoningChars) : null) : reasoningTokens;
    if (rt !== null) usage.reasoningTokens = rt;
    return {
      usage,
      text,
      toolChars,
      ...(generationId !== null ? { generationId } : {}),
      ...(servedProvider !== null ? { servedProvider } : {}),
      ...(model !== null ? { model } : {}),
    };
  };

  try {
    for await (const rec of parseSse(body, { signal: opts.signal, firstByteTimeoutMs: ctx.firstByteTimeoutMs })) {
      // parseSse yields every record of a chunk before it reads again; a signal that fired mid-chunk stops here, not at the next read
      if (opts.signal.aborted) throw opts.signal.reason;
      const data = rec.data.trim();
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      const parsed = parseJson(data);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        // TUI-DESIGN §15 item 5: RetryCause kind 'invalid'. A fixed hint, never `parsed.error`: V8's JSON.parse message embeds a
        // body snippet that pattern redaction cannot recognise (§15 item 5: the message is "never a body").
        throw new TransportError('invalid', clipMessage(redact(`openrouter: malformed sse data: ${parsed.ok ? 'not a JSON object' : 'not valid JSON'}`)));
      }
      const chunk = parsed.value;
      const err = getObj(chunk, 'error');
      if (err) throw chunkError(err, redact, requestId);
      model = getStr(chunk, 'model') ?? model;
      // Every chunk of one generation repeats the same `id` and `provider`; the first non-empty value is kept.
      // Both are wire text that reaches state.json and the transcript, so they are redacted like a request id.
      if (generationId === null) generationId = sanitiseRequestId(getStr(chunk, 'id'), redact);
      if (servedProvider === null) servedProvider = sanitiseRequestId(getStr(chunk, 'provider'), redact);

      const choice = getArr(chunk, 'choices')?.find((c) => typeof c === 'object' && c !== null && !Array.isArray(c) && (getNum(c, 'index') ?? 0) === 0);
      const choiceObj = typeof choice === 'object' && choice !== null && !Array.isArray(choice) ? choice : null;
      if (choiceObj) {
        const delta = getObj(choiceObj, 'delta');
        const content = getStr(delta, 'content');
        if (content !== null && content.length > 0) {
          text += content;
          notify(opts.onDelta, content);
        }
        // `delta.reasoning` (thinking text, present unless `reasoning.exclude`) is not shown; its length only feeds a cancelled stream's estimate
        reasoningChars += getStr(delta, 'reasoning')?.length ?? 0;
        const calls = getArr(delta, 'tool_calls');
        if (calls) {
          for (const [pos, c] of calls.entries()) {
            if (typeof c !== 'object' || c === null || Array.isArray(c)) continue;
            // `index` keys the accumulator (live observation); a missing index falls back to position.
            const index = getNum(c, 'index') ?? pos;
            let acc = tools.get(index);
            if (!acc) {
              acc = { id: '', name: '', args: '' };
              tools.set(index, acc);
              order.push(index);
            }
            const id = getStr(c, 'id');
            if (id) acc.id = id;
            const fn = getObj(c, 'function');
            const name = getStr(fn, 'name');
            if (name) acc.name = name;
            const frag = getStr(fn, 'arguments') ?? '';
            if (frag.length > 0) {
              acc.args += frag;
              toolChars += frag.length;
              notify(opts.onToolDelta, frag);
            }
          }
        }
        // verbatim: `length` means the completion budget ran out (reasoning may have eaten it — research 07 §5); the caller
        // sees it as stopReason and decides, this client never retries it
        const fr = getStr(choiceObj, 'finish_reason');
        if (fr !== null) finishReason = fr;
      }

      const usage = getObj(chunk, 'usage');
      if (usage) {
        sawUsage = true;
        const prompt = Math.max(0, Math.round(getNum(usage, 'prompt_tokens') ?? 0));
        const details = getObj(usage, 'prompt_tokens_details');
        const cached = Math.max(0, Math.round(getNum(details, 'cached_tokens') ?? 0));
        const cacheWrite = Math.max(0, Math.round(getNum(details, 'cache_write_tokens') ?? 0));
        tokens.cacheRead = Math.min(cached, prompt);
        tokens.cacheWrite = Math.min(cacheWrite, prompt - tokens.cacheRead);
        tokens.input = prompt - tokens.cacheRead - tokens.cacheWrite;
        tokens.output = Math.max(0, Math.round(getNum(usage, 'completion_tokens') ?? 0));
        const c = getNum(usage, 'cost');
        cost = c !== null && c >= 0 ? c : null;
        // typed since research 07 §2.3, read since LLM-JEV-DESIGN §4.12: `reasoning_tokens ≈ completion_tokens` with `length` = the budget went to thinking
        const rt = getNum(getObj(usage, 'completion_tokens_details'), 'reasoning_tokens');
        reasoningTokens = rt !== null ? Math.max(0, Math.round(rt)) : null;
      }
    }
  } catch (e) {
    if (opts.signal.aborted) {
      notify(opts.onCancelled, cancelled());
      throw opts.signal.reason;
    }
    throw e;
  }

  // The accounting frame is documented as always present; a stream cut before it is a transport
  // failure (the partial output was likely truncated too), so it is retried like a network error.
  if (!sawDone && !(finishReason !== null && sawUsage)) {
    // TUI-DESIGN §15 item 5: RetryCause kind 'stream'
    throw new TransportError('stream', 'openrouter: stream ended before [DONE] / usage frame');
  }
  if (!sawUsage) {
    throw new TransportError('stream', 'openrouter: stream completed without a usage frame');
  }

  const toolCalls: ToolCall[] = order.map((i) => {
    const acc = tools.get(i)!;
    const args = acc.args.length > 0 ? acc.args : '{}';
    const p = parseJson(args);
    // Invalid or truncated arguments keep the raw text with input null; actions.ts rejects them.
    return { name: acc.name, input: p.ok ? p.value : null, rawJson: args };
  });
  return { text, toolCalls, tokens, cost, reasoningTokens, model, generationId, servedProvider, finishReason: finishReason ?? 'stop' };
}

export function createOpenRouterProvider(cfg: GeneratorConfig, deps: ProviderDeps): ProviderExt {
  const d = resolveDeps(deps);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // NaN for an unpriced model: the engine emits budget:unpriced instead of billing $0 (TUI-DESIGN §9.5)
  const tablePrice = (t: TokenBreakdown): number => (cfg.priced === true ? costFromPricing(cfg.pricing, t) : Number.NaN);

  async function attempt(body: string, opts: GenerateOptionsExt): Promise<StreamOutcome> {
    const { controller, unlink } = linkedAbort(opts.signal);
    const t0 = d.now();
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    try {
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
            headers: {
              authorization: `Bearer ${cfg.apiKey}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
              'http-referer': OPENROUTER_REFERER,
              'x-title': OPENROUTER_TITLE,
            },
            body,
            signal: controller.signal,
          }),
          headersTimeout,
        ]);
      } catch (e) {
        if (opts.signal.aborted) throw opts.signal.reason;
        if (e instanceof ProviderHttpError) throw e;
        // TUI-DESIGN §15 item 5: RetryCause kind 'network' with the errno from the cause chain
        throw new TransportError('network', d.redact(`openrouter: network error: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
      } finally {
        clearTimeout(headersTimer);
      }
      // TUI-DESIGN §15 item 4: `x-request-id` when OpenRouter or a proxy sets one (httpError reads the same headers); redacted wire text (F9)
      const requestId = requestIdOf(res.headers, d.redact);
      if (res.status !== 200) {
        const bodyText = await readBodyCapped(res);
        const json = parseJsonObject(bodyText);
        const err = getObj(json, 'error');
        const kind = getStr(getObj(err, 'metadata'), 'error_type') ?? undefined;
        const message = getStr(err, 'message') ?? undefined;
        // 402 is "add credits and retry" unless it is the in-flight budget limiter with a Retry-After.
        const inFlight402 = res.status === 402 && parseRetryAfter(res.headers) !== null && getStr(getObj(err, 'metadata'), 'limit_source') === 'openrouter_in_flight_budget';
        throw httpError({
          provider: 'openrouter',
          status: res.status,
          headers: res.headers,
          body: bodyText,
          redact: d.redact,
          ...(kind !== undefined ? { kind } : {}),
          ...(message !== undefined ? { message } : {}),
          ...(inFlight402 ? { retryableOverride: true } : {}),
        });
      }
      if (!res.body) throw new TransportError('stream', 'openrouter: 200 without a body');
      const remaining = Math.max(1, FIRST_BYTE_TIMEOUT_MS - (d.now() - t0));
      try {
        return await consumeStream(res.body, { opts, redact: d.redact, firstByteTimeoutMs: remaining, requestId, promptChars: body.length, tablePrice });
      } catch (e) {
        if (opts.signal.aborted) throw opts.signal.reason;
        // Typed errors (HTTP/stream errors, renderer-callback bugs via notify) keep their class; anything
        // else (decoder faults, stream resets) is a transport failure and retried (RetryCause kind 'stream').
        if (e instanceof JevCodeError) throw e;
        throw new TransportError('stream', d.redact(`openrouter: stream failure: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
      } finally {
        controller.abort();
      }
    } finally {
      unlink();
    }
  }

  return {
    name: 'openrouter',
    model: cfg.model,
    async generate(req: GenerateRequestExt, opts: GenerateOptionsExt): Promise<GenerateResultExt> {
      validateRequest(req);
      const body = JSON.stringify(buildOpenRouterBody(cfg, req));
      const t0 = d.now();
      // TUI-DESIGN §15.2 `provider/openrouter.ts`: GenerateOptions.onRetry / wake thread into withRetry (§13.2)
      const out = await withRetry(d, opts.signal, () => attempt(body, opts), opts);
      // usage.cost is what OpenRouter bills. Without it (BYOK, a missing frame field) a table-priced model
      // (cfg.priced, set by validateGenerator; absent = false) falls back to the table; an unpriced one
      // surfaces NaN so the engine can emit budget:unpriced (TUI-DESIGN §9.5 — the meter clamps NaN to 0
      // and figures render `$?`) instead of silently billing $0.
      const costUsd = out.cost ?? tablePrice(out.tokens);
      const usage: TokenUsageExt = toTokenUsage(out.tokens, costUsd);
      if (out.reasoningTokens !== null) usage.reasoningTokens = out.reasoningTokens;
      return {
        text: out.text,
        toolCalls: out.toolCalls,
        usage,
        model: out.model ?? cfg.model,
        stopReason: out.finishReason,
        latencyMs: Math.round(d.now() - t0),
        ...(out.generationId !== null ? { generationId: out.generationId } : {}),
        ...(out.servedProvider !== null ? { servedProvider: out.servedProvider } : {}),
      };
    },
  };
}
