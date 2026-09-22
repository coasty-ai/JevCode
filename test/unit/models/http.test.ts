/**
 * The catalogue's two HTTP primitives: the deadline/abort-linked GET, and the body reader that
 * keeps the caller's signal in force after the response headers have arrived.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE_TIMEOUT_MS, ERROR_BODY_CAP, readBody, timedFetch } from '../../../src/models/http.js';
import { ProviderHttpError } from '../../../src/errors.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A body that keeps producing `chunk` until it is cancelled, counting pulls. */
function endlessBody(chunk: string, onPull?: (n: number) => void): { stream: ReadableStream<Uint8Array>; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      onPull?.(pulls);
      c.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

describe('timedFetch', () => {
  it('wraps a transport failure as a non-retryable status-0 error, with the message redacted', async () => {
    const failing = (async () => {
      throw new TypeError('connect ECONNREFUSED with sk-proj-REALKEY1234567890abcdefghijklmn');
    }) as unknown as typeof fetch;
    const err = await timedFetch({ fetch: failing, url: 'https://x/y', headers: {}, timeoutMs: 100, redact: (s) => s.replace(/sk-\S+/g, '[R]') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(0);
    expect((err as ProviderHttpError).retryable).toBe(false);
    expect((err as Error).message).toBe('connect ECONNREFUSED with [R]');
  });

  it('rethrows the caller reason rather than wrapping it', async () => {
    const controller = new AbortController();
    const reason = new Error('picker closed');
    controller.abort(reason);
    // undici rejects immediately when the signal it was handed is already aborted
    const never = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException('This operation was aborted', 'AbortError');
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(timedFetch({ fetch: never, url: 'https://x/y', headers: {}, timeoutMs: 100, signal: controller.signal, redact: (s) => s })).rejects.toBe(reason);
  });

  it('aborts on its own deadline', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })) as unknown as typeof fetch;
    const err = await timedFetch({ fetch: hang, url: 'https://x/y', headers: {}, timeoutMs: 5, redact: (s) => s }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(0);
  });

  it('leaves no listener on the caller signal once it has settled', async () => {
    const controller = new AbortController();
    const ok = (async () => new Response('{}', { headers: JSON_HEADERS })) as unknown as typeof fetch;
    await timedFetch({ fetch: ok, url: 'https://x/y', headers: {}, timeoutMs: 100, signal: controller.signal, redact: (s) => s });
    // firing the signal afterwards must not throw out of an orphaned handler
    expect(() => controller.abort(new Error('later'))).not.toThrow();
  });
});

describe('readBody', () => {
  it('reads a whole body and matches readBodyCapped when there is no signal', async () => {
    expect(await readBody(new Response('hello'), 100, 1000)).toBe('hello');
    expect(await readBody(new Response(null, { status: 304 }), 100, 1000)).toBe('');
  });

  it('caps what it reads, with and without a signal', async () => {
    expect(await readBody(new Response('abcdefghij'), 4, 1000)).toBe('abcd');
    expect(await readBody(new Response('abcdefghij'), 4, 1000, new AbortController().signal)).toBe('abcd');
  });

  it('stops an in-flight body when the caller aborts, and rethrows the reason', async () => {
    const controller = new AbortController();
    const reason = new Error('picker closed');
    const body = endlessBody('x'.repeat(1024), (n) => {
      if (n === 3) controller.abort(reason);
    });
    const res = new Response(body.stream, { headers: JSON_HEADERS });
    await expect(readBody(res, 8 * 1024 * 1024, CATALOGUE_TIMEOUT_MS, controller.signal)).rejects.toBe(reason);
    expect(body.cancelled()).toBe(true);
    expect(body.pulls()).toBeLessThan(10);
  });

  it('sends nothing to the socket when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    const body = endlessBody('x'.repeat(16));
    const res = new Response(body.stream, { headers: JSON_HEADERS });
    await expect(readBody(res, ERROR_BODY_CAP, 1000, controller.signal)).rejects.toBe(reason);
    expect(body.pulls()).toBe(0);
    expect(body.cancelled()).toBe(true);
  });

  it('keeps the partial body when its own deadline fires', async () => {
    const controller = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        pulls++;
        if (pulls > 1) await new Promise((r) => setTimeout(r, 50));
        c.enqueue(new TextEncoder().encode('ab'));
      },
    });
    const text = await readBody(new Response(stream, { headers: JSON_HEADERS }), 1_000_000, 5, controller.signal);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(1000);
    expect(controller.signal.aborted).toBe(false);
  });

  it('removes its listener once the body is drained', async () => {
    const controller = new AbortController();
    expect(await readBody(new Response('done'), 100, 1000, controller.signal)).toBe('done');
    expect(() => controller.abort(new Error('later'))).not.toThrow();
  });
});
