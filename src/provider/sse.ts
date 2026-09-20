/**
 * Streaming transport shared by anthropic.ts and openrouter.ts (DESIGN.md §7):
 *  - an SSE parser over a WebStreams body with first-byte / idle timeouts,
 *  - the retry policy (research 07 §5: Anthropic SDK constants, 3 attempts, Retry-After ≤ 60 s),
 *  - HTTP error mapping with redacted, bounded bodies,
 *  - the pricing arithmetic used when the API returns no cost.
 * Everything here is provider-agnostic; the two clients only add their wire shapes.
 */
import { ProviderHttpError, toJevCodeError } from '../errors.js';
import { isFiniteNumber, isJsonObject, parseJson } from '../core/json.js';
import { clip } from '../core/text.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';
import type { Json, JsonObject, TokenUsage } from '../core/types.js';
import type { Pricing, ProviderDeps, SseOptions, SseRecord, TokenBreakdown } from './types.js';

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
 * Run `attempt` up to MAX_ATTEMPTS times. Retries only ProviderHttpError with `retryable`;
 * everything else (abort reasons, programming errors, non-retryable HTTP errors) propagates at
 * once. Backoff sleeps await `signal`, so an engine abort ends the wait immediately.
 */
export async function withRetry<T>(
  deps: Required<Pick<ProviderDeps, 'sleep' | 'random'>>,
  signal: AbortSignal,
  attempt: (ctx: RetryContext) => Promise<T>,
): Promise<T> {
  for (let i = 0; ; i++) {
    if (signal.aborted) throw signal.reason;
    try {
      return await attempt({ attempt: i + 1, signal });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (!(e instanceof ProviderHttpError) || !e.retryable || i + 1 >= MAX_ATTEMPTS) throw e;
      const delay = e.retryAfterMs ?? backoffMs(i, deps.random);
      await deps.sleep(delay, signal);
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

/** TokenUsage for one call; `inputTokens` is the full context (uncached + cached), what tokens/step should measure. */
export function toTokenUsage(t: TokenBreakdown, costUsd: number): TokenUsage {
  return {
    inputTokens: t.input + t.cacheRead + t.cacheWrite,
    outputTokens: t.output,
    costUsd,
    calls: 1,
  };
}

/** Non-negative finite integer from an untrusted field; anything else counts as 0. */
export function countOf(v: Json | undefined): number {
  return isFiniteNumber(v) && v >= 0 ? Math.round(v) : 0;
}

/** Link a per-attempt controller to the caller's signal so both paths abort the same fetch. */
export function linkedAbort(signal: AbortSignal): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => signal.removeEventListener('abort', onAbort) };
}

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
