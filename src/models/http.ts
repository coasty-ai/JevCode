/**
 * The one HTTP primitive the catalogue uses: a GET with a hard per-attempt deadline, linked to the
 * caller's abort signal, whose failures arrive as `ProviderHttpError` so the house retry helper
 * (provider/sse.ts `withRetry`) can reason about them.
 *
 * A transport failure is reported as **non-retryable** on purpose. The generator clients retry
 * because there is no alternative to the network; the catalogue always has a disk cache and a
 * bundled snapshot behind it, so a dead network should fall back after one round trip instead of
 * three timeouts.
 */
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
