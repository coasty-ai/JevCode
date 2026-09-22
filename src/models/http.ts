/**
 * The two HTTP primitives the catalogue uses: a GET with a hard per-attempt deadline linked to the
 * caller's abort signal, and a body reader that stays linked to that signal while the body drains.
 * Failures arrive as `ProviderHttpError` so the house retry helper (provider/sse.ts `withRetry`)
 * can reason about them.
 *
 * A transport failure is reported as **non-retryable** on purpose. The generator clients retry
 * because there is no alternative to the network; the catalogue always has a disk cache and a
 * bundled snapshot behind it, so a dead network should fall back after one round trip instead of
 * three timeouts.
 */
import { readBodyCapped } from '../provider/sse.js';
import { ProviderHttpError } from '../errors.js';

/** Per-attempt cap on a catalogue request (every list endpoint answers in well under a second). */
export const CATALOGUE_TIMEOUT_MS = 10_000;

/** Longest error body read before it is clipped into the error message. */
export const ERROR_BODY_CAP = 8192;

export interface TimedFetchInput {
  fetch: typeof fetch;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  redact: (s: string) => string;
}

/**
 * GET `url`. Rethrows the caller's `signal.reason` when the caller aborted; otherwise wraps the
 * failure (DNS, TLS, socket, or our own deadline) as a status-0 `ProviderHttpError`.
 *
 * The deadline and the link to `signal` cover the *request*: both are released when the fetch
 * promise settles, which is when the response headers arrive, not when its body is drained. Read
 * the body with `readBody` below so the caller keeps control of the rest of the transfer.
 */
export async function timedFetch(input: TimedFetchInput): Promise<Response> {
  const { signal } = input;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`catalogue request timed out after ${input.timeoutMs} ms`)), input.timeoutMs);
  try {
    return await input.fetch(input.url, { method: 'GET', headers: input.headers, signal: controller.signal });
  } catch (e) {
    if (signal?.aborted === true) throw signal.reason;
    throw new ProviderHttpError(input.redact(e instanceof Error ? e.message : String(e)).slice(0, 512), { status: 0, retryable: false, cause: e });
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read at most `cap` characters of a response body, under the caller's abort signal.
 *
 * The house reader (`provider/sse.ts readBodyCapped`, used verbatim when there is no signal) has
 * its own stall timer but takes no signal, and `timedFetch`'s link to the caller necessarily ends
 * when the headers arrive. Without this, closing the picker part-way through OpenRouter's list body
 * (~730 KB live, `MAX_LIST_BYTES` 8 MB) would leave up to `timeoutMs` of un-cancellable streaming
 * behind it, once per page. An abort cancels the reader and rethrows `signal.reason`; everything
 * else matches `readBodyCapped` — a stalled or reset body yields whatever arrived.
 */
export async function readBody(res: Response, cap: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal === undefined) return readBodyCapped(res, cap, timeoutMs);
  if (signal.aborted) {
    await res.body?.cancel().catch(() => undefined);
    throw signal.reason;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  const timer = setTimeout(cancel, timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8');
  let out = '';
  try {
    while (out.length < cap) {
      const r = await reader.read();
      if (r.done) break;
      out += decoder.decode(r.value, { stream: true });
    }
  } catch {
    // cancelled by the deadline, cancelled by the caller, or reset by the peer: keep the partial body
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
  }
  if (signal.aborted) throw signal.reason;
  return out.length > cap ? out.slice(0, cap) : out;
}
