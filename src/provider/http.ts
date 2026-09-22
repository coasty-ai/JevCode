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
 *
 * Nothing here knows a wire shape: a client passes a `consume` that turns its own stream into a `ProviderOutcome`.
 */
import { JevCodeError, ProviderHttpError } from '../errors.js';
import type { GenerateOptions, GenerateRequest, GenerateResult, JsonObject } from '../core/types.js';
import {
  FIRST_BYTE_TIMEOUT_MS,
  IdleTimeoutError,
  TransportError,
  costFromPricing,
  getObj,
  getStr,
  httpError,
  linkedAbort,
  notify,
  parseJsonObject,
  rateLimitLedger,
  rateLimitedCancellation,
  readBodyCapped,
  requestIdOf,
  toCancelledGeneration,
  toTokenUsage,
  withRetry,
} from './sse.js';
import type { ModelInfo, ProviderConfig, ProviderDeps, ProviderOutcome, StreamPartial, TokenBreakdown } from './types.js';

/** §4.8: filled in a client's abort branch with what the stream had produced; read after the retry loop rethrows the abort reason. */
export interface HeldPartial {
  partial: StreamPartial | null;
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
  if (req.messages.length === 0) bad('messages is empty');
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
        try {
          return await call.consume(res.body, { opts, redact: d.redact, firstByteTimeoutMs: remaining, requestId, held });
        } catch (e) {
          if (opts.signal.aborted) throw opts.signal.reason;
          // Typed errors (HTTP / stream errors, renderer-callback bugs via notify) keep their class; anything else
          // (decoder faults, connection resets) is a transport failure and retried (RetryCause kind 'stream').
          if (e instanceof JevCodeError) throw e;
          throw new TransportError('stream', d.redact(`${call.label}: stream failure: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
        } finally {
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
  const held: HeldPartial = { partial: null };
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
    else if (limited.last) notify(opts.onCancelled, rateLimitedCancellation());
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
  };
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
