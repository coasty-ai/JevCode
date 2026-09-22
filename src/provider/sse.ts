/**
 * Streaming transport shared by anthropic.ts and openrouter.ts (DESIGN.md §7):
 *  - an SSE parser over a WebStreams body with first-byte / idle timeouts,
 *  - the retry policy (research 07 §5: Anthropic SDK constants, 3 attempts, Retry-After ≤ 60 s),
 *  - HTTP error mapping with redacted, bounded bodies,
 *  - the pricing arithmetic used when the API returns no cost.
 * Everything here is provider-agnostic; the two clients only add their wire shapes.
 */
import { JevCodeError, ProviderHttpError, REQUEST_ID_MAX_CHARS, toJevCodeError } from '../errors.js';
import { isFiniteNumber, isJsonObject, parseJson } from '../core/json.js';
import { clip } from '../core/text.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';
import type { SleepFn } from '../core/time.js';
import type { CancelledGeneration, GenerateOptions, Json, JsonObject, RetryCause, RetryInfo, TokenUsage } from '../core/types.js';
import type { Pricing, ProviderDeps, SseOptions, SseRecord, StreamPartial, TokenBreakdown } from './types.js';

export const FIRST_BYTE_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 60_000;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
/** SSE allows CRLF, CR or LF; the global flag lets `lastIndex` resume mid-buffer. */
const LINE_END = /\r\n|\r|\n/g;

/** Retryable transport failure: nothing arrived in time. `status` 0 marks "no HTTP status". */
export class IdleTimeoutError extends ProviderHttpError {
  readonly phase: 'first_byte' | 'idle';
  constructor(phase: 'first_byte' | 'idle', waitedMs: number) {
    super(`idle_timeout: no ${phase === 'first_byte' ? 'byte' : 'data'} received for ${Math.round(waitedMs)} ms`, { status: 0, retryable: true });
    this.phase = phase;
  }
}

/** TUI-DESIGN §15 item 5 (`RetryCause.kind`): what a retryable status-0 failure was. */
export type TransportKind = 'network' | 'stream' | 'invalid';

/**
 * A retryable transport failure without an HTTP status, classified for `RetryCause` (TUI-DESIGN §13.2,
 * §15 item 5): `network` = the request never got an answer, `stream` = the answer was cut or empty,
 * `invalid` = a frame was not the documented JSON. `errno` is the OS / undici code found on the cause
 * chain (`ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, …) — a code word, never a body.
 */
export class TransportError extends ProviderHttpError {
  readonly kind: TransportKind;
  readonly errno: string | null;
  constructor(kind: TransportKind, message: string, opts: { cause?: unknown } = {}) {
    super(message, { status: 0, retryable: true, cause: opts.cause });
    this.kind = kind;
    this.errno = errnoOf(opts.cause);
  }
}

/** Walk a thrown value's `cause` chain for a string `code` (OS errno / undici `UND_ERR_*`); JevCodeErrors are skipped (their `code` is ours). */
export function errnoOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    if (!(cur instanceof JevCodeError)) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** TUI-DESIGN §13.2: codes rendered as `no response from <host> in N s` (a connect / headers / body timeout is a timeout, not "offline"). */
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** TUI-DESIGN §15 item 5: `RetryCause.message` is a redacted hint of at most 200 chars, never a body. */
const RETRY_CAUSE_MESSAGE_MAX = 200;

/**
 * TUI-DESIGN §15 item 4 / §10 (F9): a request id is server-controlled wire text and flows into `toJSON()` →
 * `SerializedError` → `state.json`, the epilogue and the `last: … · request-id <id>` row, so it is redacted like a body
 * (a proxy may echo a client header) BEFORE the clip — clipping first could cut a key so its pattern no longer matches.
 * Blank, missing or fully redacted-away ids are null.
 */
export function sanitiseRequestId(id: string | null | undefined, redact: (s: string) => string): string | null {
  if (id === null || id === undefined) return null;
  const t = redact(id.trim()).trim();
  return t.length > 0 ? clip(t, REQUEST_ID_MAX_CHARS) : null;
}

/** TUI-DESIGN §15 item 4: `request-id` (Anthropic) or `x-request-id` (OpenRouter and proxies), redacted and clipped; null when the response carried neither. */
export function requestIdOf(headers: Headers, redact: (s: string) => string): string | null {
  return sanitiseRequestId(headers.get('request-id') ?? headers.get('x-request-id'), redact);
}

/**
 * TUI-DESIGN §15 item 5: the cause a client reports before a retry sleep. The message is the error's own
 * (already redacted by its thrower) clipped to 200 chars; `code` is set for network / timeout causes so
 * the retry row can render the §13.2 offline copy from it.
 */
export function retryCauseOf(e: ProviderHttpError): RetryCause {
  const message = clip(e.message, RETRY_CAUSE_MESSAGE_MAX);
  if (e instanceof IdleTimeoutError) return { kind: 'timeout', status: null, code: 'TimeoutError', message };
  if (e.status > 0) return { kind: 'http', status: e.status, code: null, message };
  if (e instanceof TransportError) {
    if (e.kind === 'network' && e.errno !== null && TIMEOUT_CODES.has(e.errno)) return { kind: 'timeout', status: null, code: e.errno, message };
    return { kind: e.kind, status: null, code: e.errno, message };
  }
  return { kind: 'stream', status: null, code: errnoOf(e.cause), message };
}

interface TimedRead {
  done: boolean;
  value?: Uint8Array;
}

/**
 * Await one read, bounded by `timeoutMs` and by `signal`. The timer is created per read so an
 * active stream never accumulates timers; on timeout or abort the reader is cancelled so the
 * underlying connection closes instead of lingering until the server gives up.
 */
function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  phase: 'first_byte' | 'idle',
  signal: AbortSignal | undefined,
): Promise<TimedRead> {
  return new Promise<TimedRead>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      finish(() => {
        void reader.cancel().catch(() => undefined);
        reject(signal?.reason);
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        void reader.cancel().catch(() => undefined);
        reject(new IdleTimeoutError(phase, timeoutMs));
      });
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (r) => finish(() => resolve(r.done ? { done: true } : { done: false, value: r.value })),
      (e: unknown) => finish(() => reject(e)),
    );
  });
}

/**
 * Parse an SSE byte stream into records. Handles multi-line `data:`, comment lines (`: OPENROUTER
 * PROCESSING`), CRLF / CR / LF line endings and events split across arbitrary chunk boundaries.
 * `id:` and `retry:` fields are ignored. A trailing event without a blank line is flushed at EOF.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>, opts: SseOptions = {}): AsyncGenerator<SseRecord, void, undefined> {
  const firstByte = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idle = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBytes = opts.maxEventBytes ?? MAX_EVENT_BYTES;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const t0 = monotonicNow();
  let buffer = '';
  let sawByte = false;
  let event: string | undefined;
  let data: string[] = [];

  const takeRecord = (): SseRecord | null => {
    if (data.length === 0) {
      event = undefined;
      return null;
    }
    const rec: SseRecord = event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
    event = undefined;
    data = [];
    return rec;
  };
  const feedLine = (line: string): SseRecord | null => {
    if (line === '') return takeRecord();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null;
  };

  try {
    for (;;) {
      const r = await readWithTimeout(reader, sawByte ? idle : firstByte, sawByte ? 'idle' : 'first_byte', opts.signal);
      if (r.done) break;
      // contract 1.9 (Fastlane) §3.1: the first read that returned bytes is the TTFB, reported once and before the
      // record it carries is parsed — the hedge threshold (§3.2) reads it while the rest of the stream is still open.
      if (!sawByte) notify(opts.onFirstByte, Math.round(monotonicNow() - t0));
      sawByte = true;
      buffer += decoder.decode(r.value, { stream: true });
      if (buffer.length > maxBytes) {
        throw new ProviderHttpError(`sse event exceeds ${maxBytes} bytes`, { status: 0, retryable: false });
      }
      // Only complete lines are parsed; a trailing "\r" may be the first half of CRLF, so it waits.
      let start = 0;
      for (;;) {
        LINE_END.lastIndex = start;
        const hit = LINE_END.exec(buffer);
        if (!hit) break;
        if (hit[0] === '\r' && hit.index === buffer.length - 1) break;
        const line = buffer.slice(start, hit.index);
        start = hit.index + hit[0].length;
        const rec = feedLine(line);
        if (rec) yield rec;
      }
      buffer = buffer.slice(start);
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split(LINE_END)) {
        const rec = feedLine(line);
        if (rec) yield rec;
      }
    }
    const last = takeRecord();
    if (last) yield last;
  } finally {
    // Consumer may have stopped early (return/throw); release the connection either way.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Read a whole non-SSE 200 body as text under the same budgets `parseSse` uses (first byte, then idle between chunks,
 * and `maxEventBytes` as a hard cap). Needed by the one provider whose streaming surface cannot carry what the harness
 * needs — api.meta.ai drops tool calls and the usage frame when `stream: true` (provider/meta.ts) — so its client asks
 * for JSON and still gets the abort, timeout and size guarantees the streaming clients have.
 */
export async function readStreamText(stream: ReadableStream<Uint8Array>, opts: SseOptions = {}): Promise<string> {
  const firstByte = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idle = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBytes = opts.maxEventBytes ?? MAX_EVENT_BYTES;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const t0 = monotonicNow();
  let out = '';
  let sawByte = false;
  try {
    for (;;) {
      const r = await readWithTimeout(reader, sawByte ? idle : firstByte, sawByte ? 'idle' : 'first_byte', opts.signal);
      if (r.done) break;
      // contract 1.9 (Fastlane) §3.1: same TTFB report as `parseSse`, for the one client that reads JSON (meta.ai)
      if (!sawByte) notify(opts.onFirstByte, Math.round(monotonicNow() - t0));
      sawByte = true;
      out += decoder.decode(r.value, { stream: true });
      if (out.length > maxBytes) throw new ProviderHttpError(`response body exceeds ${maxBytes} bytes`, { status: 0, retryable: false });
    }
    out += decoder.decode();
    return out;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

/** Anthropic-SDK schedule: min(500·2^n, 8000) ms shrunk by up to 25 % (subtract-only jitter). */
export function backoffMs(retryIndex: number, random: () => number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** retryIndex, BACKOFF_CAP_MS);
  const u = Math.min(Math.max(random(), 0), 0.999_999);
  return Math.round(base * (1 - u * 0.25));
}

/** `retry-after-ms`, then `retry-after` (seconds or HTTP-date); only 0 < value ≤ 60 s is honoured. */
export function parseRetryAfter(headers: Headers, nowMs: () => number = Date.now): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms !== null) {
    const n = Number.parseFloat(ms);
    if (Number.isFinite(n) && n > 0 && n <= RETRY_AFTER_CAP_MS) return Math.round(n);
    return null;
  }
  const ra = headers.get('retry-after');
  if (ra === null) return null;
  const secs = Number.parseFloat(ra);
  let value: number;
  if (Number.isFinite(secs)) value = secs * 1000;
  else {
    const at = Date.parse(ra);
    if (!Number.isFinite(at)) return null;
    value = at - nowMs();
  }
  return value > 0 && value <= RETRY_AFTER_CAP_MS ? Math.round(value) : null;
}

/** Status-based retry class per research 07 §5 (both APIs agree on this set). */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500 && status <= 599;
}

export interface HttpErrorInput {
  provider: string;
  status: number;
  headers: Headers;
  body: string;
  redact: (s: string) => string;
  /** provider-specific override computed from the parsed body (e.g. Anthropic spend-limit 429) */
  retryableOverride?: boolean;
  /** short label extracted from the body (`error.type` / `metadata.error_type`) */
  kind?: string;
  message?: string;
  /** TUI-DESIGN §15 item 4: overrides the header-derived request id (e.g. Anthropic's body `request_id`); redacted and clipped here like the header value */
  requestId?: string | null;
}

/** Build the typed error for a non-200 response; message and body are redacted and bounded. */
export function httpError(input: HttpErrorInput): ProviderHttpError {
  const shouldRetry = input.headers.get('x-should-retry');
  let retryable = input.retryableOverride ?? isRetryableStatus(input.status);
  if (shouldRetry === 'true') retryable = true;
  else if (shouldRetry === 'false') retryable = false;
  const detail = input.message ? `: ${input.message}` : '';
  const kind = input.kind ? ` ${input.kind}` : '';
  return new ProviderHttpError(clipMessage(input.redact(`${input.provider} HTTP ${input.status}${kind}${detail}`)), {
    status: input.status,
    retryable,
    retryAfterMs: parseRetryAfter(input.headers),
    body: clip(input.redact(input.body), 2048),
    // TUI-DESIGN §15 item 4: the request id rides the error into toJSON() / the retry row — redacted like the body (F9)
    requestId: sanitiseRequestId(input.requestId ?? requestIdOf(input.headers, input.redact), input.redact),
  });
}

/** Error text that ends up in `Error.message` (server-controlled) is kept short; the clipped body carries the rest. */
export const MAX_MESSAGE_CHARS = 512;
export function clipMessage(s: string): string {
  return clip(s, MAX_MESSAGE_CHARS);
}

/**
 * Renderer callbacks run inside the stream loop. A throwing `onDelta`/`onToolDelta` is a harness bug,
 * not a transport fault: it is surfaced as a typed 'internal' error so the retry loop never re-bills it.
 */
export function notify<T>(fn: ((value: T) => void) | undefined, value: T): void {
  if (!fn) return;
  try {
    fn(value);
  } catch (e) {
    throw toJevCodeError(e);
  }
}

/**
 * contract 1.9 (Fastlane) §3.1 (review defect 3): `GenerateOptions.onFirstByte` is documented as "called at most once
 * per `generate()`", but `withRetry` wraps the WHOLE attempt — so a retryable failure that lands after the stream
 * opened (research 07 §2.3's `data: {"error": …}` frame on a 200) runs the attempt body again and would report a
 * second TTFB. Two readings would enter the §3.2 threshold's p50 twice and double-count `StepVerifySummary.ttfbMs`.
 *
 * The latch is keyed on the OPTIONS OBJECT, which is exactly what one `generate()` owns and every attempt of it
 * shares: the harness hears about the first attempt that actually streamed, whatever the client's retry shape is, and
 * a client added later cannot forget the rule as long as it reports through here. The latch closes BEFORE the callback
 * runs, so a throwing callback (a harness bug, raised typed by `notify`) cannot let the next attempt report either.
 */
const firstByteReported = new WeakSet<GenerateOptions>();
export function reportFirstByte(opts: GenerateOptions, ms: number): void {
  if (opts.onFirstByte === undefined || firstByteReported.has(opts)) return;
  firstByteReported.add(opts);
  notify(opts.onFirstByte, ms);
}

/**
 * Read at most `cap` characters of a response body (error bodies are untrusted input), giving up after
 * `timeoutMs`. The status code carries the decision, so a body that trickles or hangs yields what has
 * arrived instead of holding the retry loop open.
 */
export async function readBodyCapped(res: Response, cap = 65_536, timeoutMs = FIRST_BYTE_TIMEOUT_MS): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), timeoutMs);
  try {
    while (out.length < cap) {
      const r = await reader.read();
      if (r.done) break;
      out += decoder.decode(r.value, { stream: true });
    }
  } catch {
    // cancelled by the timer or reset by the peer: keep the partial body
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return out.length > cap ? out.slice(0, cap) : out;
}

/** Parse a JSON body into an object, or null when it is not a JSON object. */
export function parseJsonObject(text: string): JsonObject | null {
  const r = parseJson(text.trim());
  return r.ok && isJsonObject(r.value) ? r.value : null;
}

export interface RetryContext {
  attempt: number;
  signal: AbortSignal;
}

/**
 * TUI-DESIGN §15 item 5 / §13.2: the hooks a provider threads from `GenerateOptions`. `onRetry` runs before
 * each backoff sleep with the `RetryInfo`; `wake` is a GETTER read after it, once per sleep, so the engine's
 * handler can hand every sleep a fresh AbortController (`[r] retry now` aborts the current one).
 */
export interface RetryHooks {
  onRetry?: (info: RetryInfo) => void;
  wake?: () => AbortSignal | undefined;
}

/** A throwing `wake` getter is a harness bug like a throwing `onDelta` (see `notify`): typed 'internal', never re-billed. */
function readWake(hooks: RetryHooks | undefined): AbortSignal | undefined {
  if (!hooks?.wake) return undefined;
  try {
    return hooks.wake();
  } catch (e) {
    throw toJevCodeError(e);
  }
}

/**
 * Run `attempt` up to MAX_ATTEMPTS times. Retries only ProviderHttpError with `retryable`;
 * everything else (abort reasons, programming errors, non-retryable HTTP errors) propagates at
 * once. Backoff sleeps await `signal`, so an engine abort ends the wait immediately; `hooks.wake`
 * (TUI-DESIGN §13.2) ends one sleep early without touching the attempt count or the schedule.
 */
export async function withRetry<T>(
  deps: { sleep: SleepFn; random: () => number },
  signal: AbortSignal,
  attempt: (ctx: RetryContext) => Promise<T>,
  hooks?: RetryHooks,
): Promise<T> {
  for (let i = 0; ; i++) {
    if (signal.aborted) throw signal.reason;
    try {
      return await attempt({ attempt: i + 1, signal });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (!(e instanceof ProviderHttpError) || !e.retryable || i + 1 >= MAX_ATTEMPTS) throw e;
      const delay = e.retryAfterMs ?? backoffMs(i, deps.random);
      // TUI-DESIGN §15.2 `provider/sse.ts` row: report the retry, then read the waker getter for this one sleep
      notify(hooks?.onRetry, { attempt: i + 1, maxAttempts: MAX_ATTEMPTS, waitMs: delay, retryAfter: e.retryAfterMs !== null, cause: retryCauseOf(e) });
      await deps.sleep(delay, signal, readWake(hooks));
    }
  }
}

export function resolveDeps(deps: ProviderDeps): Required<ProviderDeps> {
  return {
    fetch: deps.fetch ?? globalThis.fetch,
    redact: deps.redact,
    now: deps.now ?? monotonicNow,
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random,
  };
}

// ---------------------------------------------------------------------------------------
// Cost and usage
// ---------------------------------------------------------------------------------------

/** USD from per-million prices; cached tokens are billed at their own rates, not the input rate. */
export function costFromPricing(p: Pricing, t: TokenBreakdown): number {
  return (t.input * p.inputPerM + t.cacheRead * p.cacheReadPerM + t.cacheWrite * p.cacheWritePerM + t.output * p.outputPerM) / 1e6;
}

/**
 * TokenUsage for one call; `inputTokens` is the full context (uncached + cached), what tokens/step should measure.
 * `reasoningTokens` (LLM-JEV-DESIGN §4.12) is set when the frame carried it — a read 0 is kept; null (the default) = absent.
 */
export function toTokenUsage(t: TokenBreakdown, costUsd: number, reasoningTokens: number | null = null): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: t.input + t.cacheRead + t.cacheWrite,
    outputTokens: t.output,
    costUsd,
    calls: 1,
  };
  if (reasoningTokens !== null) usage.reasoningTokens = reasoningTokens;
  // contract 1.9 (Fastlane) §3.4: the cached shares of `inputTokens` the API itself reported, surfaced so the §3.3
  // prefix pinning can be measured (`StepVerifySummary.cacheRead` / `cacheWrite` / `cacheHitRate`). Set only when the
  // call really read or wrote cache, so a provider that caches nothing produces exactly the object it produced before.
  //
  // Review defect 9, decided rather than left implicit: this widening is UNGATED, so every `generator.jsonl` usage row
  // of a cache-serving provider grows two members in every mode. It is the only place the harness can learn the figures
  // (`LlmSource` sums them off the arrivals' `TokenUsage`), and a record shape that changes with a flag is worse than
  // one that grows once. test/unit/provider/cache-usage.test.ts pins both halves: an uncached call's object is
  // unchanged, and no records reader (the bench summariser, the checkpoint replay) rejects the wider rows.
  if (t.cacheRead > 0) usage.cacheReadTokens = t.cacheRead;
  if (t.cacheWrite > 0) usage.cacheWriteTokens = t.cacheWrite;
  return usage;
}

/**
 * LLM-JEV-DESIGN §4.8: the facts a provider hands to `onCancelled` (core/types.ts `CancelledGeneration`). `usage` is present only
 * when the accounting frame had already arrived, priced exactly as a completed call would be (`cost` from the frame, else
 * `price`); every other cancelled stream is estimated by the engine, never here.
 */
export function toCancelledGeneration(p: StreamPartial, price: (t: TokenBreakdown) => number): CancelledGeneration {
  const out: CancelledGeneration = { text: p.text, toolChars: p.toolChars, reasoningChars: p.reasoningChars };
  if (p.generationId !== null) out.generationId = p.generationId;
  if (p.servedProvider !== null) out.servedProvider = p.servedProvider;
  if (p.model !== null) out.model = p.model;
  if (p.tokens !== null) out.usage = toTokenUsage(p.tokens, p.cost ?? price(p.tokens), p.reasoningTokens);
  return out;
}

/**
 * The `onCancelled` facts of a call that ended rate-limited (core/types.ts `CancelledGeneration.rateLimited`): the retry
 * chain's every attempt was answered HTTP 429, or the signal aborted the call during a 429 backoff.
 *
 * With no argument nothing was served — zero streamed sizes, no ids, no usage — so the engine records the sample at zero
 * rather than from an estimate. `served` is for the other shape of the same ending: a 429 that arrived as a MID-STREAM
 * error frame (`isRateLimit` counts those), where the stream had opened and tokens had been served and billed before the
 * limiter cut it. Reporting zeros there would under-bill the run, so the streamed facts are kept and only the
 * `rateLimited` flag is added.
 */
export function rateLimitedCancellation(served?: CancelledGeneration): CancelledGeneration {
  return served === undefined ? { text: '', toolChars: 0, reasoningChars: 0, rateLimited: true } : { ...served, rateLimited: true };
}

/** HTTP 429 from the API or the upstream provider (`Provider returned error` with code 429 on a mid-stream frame counts too). */
export function isRateLimit(e: unknown): boolean {
  return e instanceof ProviderHttpError && e.status === 429;
}

/**
 * The 429 bookkeeping of one call, kept beside `withRetry` (which owns the attempts and the Retry-After / backoff sleeps):
 * `attempts` = how many attempts the rate limiter answered, `last` = whether the most recent failure was a 429 — the fact that
 * decides `rateLimited` when the chain gives up or an abort lands during the backoff. Wrap the attempt with `track`.
 */
export interface RateLimitLedger {
  attempts: number;
  last: boolean;
  track<T>(attempt: () => Promise<T>): Promise<T>;
}

export function rateLimitLedger(): RateLimitLedger {
  const ledger: RateLimitLedger = {
    attempts: 0,
    last: false,
    async track(attempt) {
      try {
        return await attempt();
      } catch (e) {
        // an abort reason or a non-HTTP failure is not a 429: the last word was something else
        ledger.last = isRateLimit(e);
        if (ledger.last) ledger.attempts += 1;
        throw e;
      }
    },
  };
  return ledger;
}

/** Non-negative finite integer from an untrusted field; anything else counts as 0. */
export function countOf(v: Json | undefined): number {
  return isFiniteNumber(v) && v >= 0 ? Math.round(v) : 0;
}

/** Link a per-attempt controller to the caller's signal so both paths abort the same fetch. */
// the implementation lives in core/abort.ts (the engine links per-sample signals with it too); re-exported for the clients
export { linkedAbort } from '../core/abort.js';

// ---------------------------------------------------------------------------------------
// Untrusted-JSON accessors (wire payloads are validated field by field, never trusted by cast)
// ---------------------------------------------------------------------------------------

export function getObj(o: JsonObject | null | undefined, key: string): JsonObject | null {
  const v = o?.[key];
  return isJsonObject(v) ? v : null;
}
export function getArr(o: JsonObject | null | undefined, key: string): Json[] | null {
  const v = o?.[key];
  return Array.isArray(v) ? v : null;
}
export function getStr(o: JsonObject | null | undefined, key: string): string | null {
  const v = o?.[key];
  return typeof v === 'string' ? v : null;
}
export function getNum(o: JsonObject | null | undefined, key: string): number | null {
  const v = o?.[key];
  return isFiniteNumber(v) ? v : null;
}
