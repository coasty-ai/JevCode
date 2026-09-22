import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, JevCodeError, ProviderHttpError } from '../../../src/errors.js';
import { IdleTimeoutError, MAX_MESSAGE_CHARS, backoffMs, clipMessage, costFromPricing, httpError, isRateLimit, isRetryableStatus, notify, parseRetryAfter, parseSse, rateLimitLedger, rateLimitedCancellation, readBodyCapped, withRetry } from '../../../src/provider/sse.js';
import type { SseRecord } from '../../../src/provider/types.js';
import { PRICING, bodyStream, encode, fixture, splitEvery } from './helpers.js';

async function collect(stream: ReadableStream<Uint8Array>, opts: Parameters<typeof parseSse>[1] = {}): Promise<SseRecord[]> {
  const out: SseRecord[] = [];
  for await (const r of parseSse(stream, opts)) out.push(r);
  return out;
}

describe('parseSse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses a full Anthropic transcript in one chunk, keeping event names and padded data', async () => {
    const recs = await collect(bodyStream([fixture('anthropic-text.sse')]).stream);
    expect(recs.map((r) => r.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    // the parser keeps the payload verbatim (trailing padding included); consumers trim
    expect(recs[0]!.data.endsWith('         ')).toBe(true);
    expect(JSON.parse(recs[0]!.data.trim())).toMatchObject({ type: 'message_start' });
  });

  it.each([1, 2, 3, 7, 64])('yields identical records when the bytes arrive %i at a time', async (n) => {
    const whole = await collect(bodyStream([fixture('anthropic-tool.sse')]).stream);
    const pieces = await collect(bodyStream(splitEvery(fixture('anthropic-tool.sse'), n)).stream);
    expect(pieces).toEqual(whole);
    expect(pieces.length).toBe(13);
  });

  it('skips comment lines and handles bare data records (OpenRouter shape)', async () => {
    const recs = await collect(bodyStream(splitEvery(fixture('openrouter-text.sse'), 5)).stream);
    expect(recs.length).toBe(5);
    expect(recs.every((r) => r.event === undefined)).toBe(true);
    expect(recs[4]!.data).toBe('[DONE]');
    expect(recs.some((r) => r.data.includes('OPENROUTER PROCESSING'))).toBe(false);
  });

  it('joins multi-line data with newlines and drops the single leading space only', async () => {
    const recs = await collect(bodyStream(['event: x\ndata: line one\ndata:  two spaces\ndata:\ndata: end\n\n']).stream);
    expect(recs).toEqual([{ event: 'x', data: 'line one\n two spaces\n\nend' }]);
  });

  it('accepts CRLF and lone CR line endings, including a CRLF split across chunks', async () => {
    const text = 'event: a\r\ndata: {"n":1}\r\n\r\nevent: b\rdata: {"n":2}\r\r';
    const recs = await collect(bodyStream([text]).stream);
    expect(recs).toEqual([
      { event: 'a', data: '{"n":1}' },
      { event: 'b', data: '{"n":2}' },
    ]);
    const bytes = encode('data: one\r');
    const rest = encode('\ndata: two\r\n\r\n');
    const split = await collect(bodyStream([bytes, rest]).stream);
    expect(split).toEqual([{ data: 'one\ntwo' }]);
  });

  it('flushes a trailing record without a final blank line and ignores id/retry fields', async () => {
    const recs = await collect(bodyStream(['id: 7\nretry: 100\ndata: tail']).stream);
    expect(recs).toEqual([{ data: 'tail' }]);
  });

  it('does not split multi-byte UTF-8 characters across chunk boundaries', async () => {
    const text = 'data: héllo → wörld ✓\n\n';
    const recs = await collect(bodyStream(splitEvery(text, 1)).stream);
    expect(recs).toEqual([{ data: 'héllo → wörld ✓' }]);
  });

  it('times out when the first byte does not arrive within 30 s (fake timers)', async () => {
    vi.useFakeTimers();
    const control = bodyStream([], true);
    const it = parseSse(control.stream);
    const p = it.next();
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => e instanceof IdleTimeoutError && e.phase === 'first_byte' && e.retryable && e.status === 0);
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(control.cancelled()).toBe(true);
  });

  it('times out when no data arrives for 60 s after the first record, but not before', async () => {
    vi.useFakeTimers();
    const control = bodyStream(['data: first\n\n'], true);
    const it = parseSse(control.stream);
    expect((await it.next()).value).toEqual({ data: 'first' });
    const p = it.next();
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => e instanceof IdleTimeoutError && e.phase === 'idle');
    await vi.advanceTimersByTimeAsync(59_000);
    control.push(': keep-alive\n\n');
    // the keep-alive comment resets the idle clock
    await vi.advanceTimersByTimeAsync(59_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('stops on the caller signal and rethrows signal.reason', async () => {
    const control = bodyStream(['data: one\n\n'], true);
    const ac = new AbortController();
    const it = parseSse(control.stream, { signal: ac.signal });
    expect((await it.next()).value).toEqual({ data: 'one' });
    const p = it.next();
    const reason = new AbortError('human_abort');
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(control.cancelled()).toBe(true);
  });

  it('rejects a single event larger than maxEventBytes as non-retryable', async () => {
    const big = `data: ${'x'.repeat(200)}`;
    const control = bodyStream([big], true);
    await expect(collect(control.stream, { maxEventBytes: 100 })).rejects.toSatisfy((e: unknown) => e instanceof ProviderHttpError && !e.retryable);
  });

  it('cancels the reader when the consumer stops early', async () => {
    const control = bodyStream(['data: a\n\ndata: b\n\n'], true);
    for await (const r of parseSse(control.stream)) {
      expect(r.data).toBe('a');
      break;
    }
    expect(control.cancelled()).toBe(true);
  });
});

describe('retry policy helpers', () => {
  it('follows min(500·2^n, 8000) with subtract-only jitter of at most 25 %', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(4, () => 0)).toBe(8000);
    expect(backoffMs(10, () => 0)).toBe(8000);
    expect(backoffMs(0, () => 0.999)).toBeGreaterThanOrEqual(375);
    expect(backoffMs(0, () => 0.5)).toBe(438);
    expect(backoffMs(1, () => 0.999)).toBeLessThanOrEqual(1000);
  });

  it('honours retry-after-ms first, then retry-after seconds or HTTP-date, only within (0, 60 s]', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500', 'retry-after': '30' }))).toBe(1500);
    expect(parseRetryAfter(new Headers({ 'retry-after': '2.5' }))).toBe(2500);
    expect(parseRetryAfter(new Headers({ 'retry-after': '60' }))).toBe(60_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': '61' }))).toBeNull();
    expect(parseRetryAfter(new Headers({ 'retry-after': '0' }))).toBeNull();
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(parseRetryAfter(new Headers())).toBeNull();
    const now = Date.UTC(2026, 8, 19, 12, 0, 0);
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(now + 10_000).toUTCString() }), () => now)).toBe(10_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(now - 10_000).toUTCString() }), () => now)).toBeNull();
  });

  it('classifies statuses per research 07 §5', () => {
    for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 402, 403, 404, 413, 200, 0]) expect(isRetryableStatus(s)).toBe(false);
  });

  it('rateLimitLedger: counts the attempts a 429 answered and remembers whether the last word was one; the cancellation facts are zero sizes + rateLimited', async () => {
    const ledger = rateLimitLedger();
    const e429 = new ProviderHttpError('busy', { status: 429, retryable: true });
    const e503 = new ProviderHttpError('down', { status: 503, retryable: true });
    await expect(ledger.track(() => Promise.reject(e429))).rejects.toBe(e429);
    expect([ledger.attempts, ledger.last]).toEqual([1, true]);
    await expect(ledger.track(() => Promise.reject(e503))).rejects.toBe(e503);
    expect([ledger.attempts, ledger.last]).toEqual([1, false]);
    await expect(ledger.track(() => Promise.reject(e429))).rejects.toBe(e429);
    expect([ledger.attempts, ledger.last]).toEqual([2, true]);
    // an abort reason is not a 429; a success leaves the ledger as it was
    await expect(ledger.track(() => Promise.reject(new AbortError('signal')))).rejects.toBeInstanceOf(AbortError);
    expect([ledger.attempts, ledger.last]).toEqual([2, false]);
    await expect(ledger.track(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect([ledger.attempts, ledger.last]).toEqual([2, false]);
    expect(isRateLimit(e429)).toBe(true);
    expect(isRateLimit(e503)).toBe(false);
    expect(isRateLimit(new RangeError('bug'))).toBe(false);
    expect(rateLimitedCancellation()).toEqual({ text: '', toolChars: 0, reasoningChars: 0, rateLimited: true });
  });

  it('withRetry: three attempts, retryAfterMs preferred over backoff, then gives up with the last error', async () => {
    const sleeps: number[] = [];
    const deps = { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 };
    let n = 0;
    const err = (i: number): ProviderHttpError => new ProviderHttpError(`e${i}`, { status: 529, retryable: true, retryAfterMs: i === 1 ? 2000 : null });
    await expect(
      withRetry(deps, new AbortController().signal, async () => {
        n++;
        throw err(n);
      }),
    ).rejects.toMatchObject({ message: 'e3' });
    expect(n).toBe(3);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it('withRetry: non-retryable and foreign errors propagate immediately; abort during backoff rethrows the reason', async () => {
    let n = 0;
    await expect(
      withRetry({ sleep: async () => undefined, random: () => 0 }, new AbortController().signal, async () => {
        n++;
        throw new ProviderHttpError('nope', { status: 400, retryable: false });
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(n).toBe(1);
    await expect(withRetry({ sleep: async () => undefined, random: () => 0 }, new AbortController().signal, async () => Promise.reject(new RangeError('bug')))).rejects.toBeInstanceOf(RangeError);

    const ac = new AbortController();
    const reason = new AbortError('signal');
    const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
      ac.abort(reason);
      throw signal?.reason;
    };
    await expect(
      withRetry({ sleep, random: () => 0 }, ac.signal, async () => {
        throw new ProviderHttpError('busy', { status: 503, retryable: true });
      }),
    ).rejects.toBe(reason);
  });
});

describe('costFromPricing', () => {
  it('bills each token class at its own per-million rate', () => {
    expect(costFromPricing(PRICING, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(2, 10);
    expect(costFromPricing(PRICING, { input: 120, cacheRead: 2400, cacheWrite: 1500, output: 51 })).toBeCloseTo((120 * 2 + 2400 * 0.2 + 1500 * 2.5 + 51 * 10) / 1e6, 12);
  });
});

describe('bounded error plumbing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('readBodyCapped caps the body and returns the partial text when the peer stalls', async () => {
    const big = new Response('a'.repeat(70_000));
    expect((await readBodyCapped(big, 1000)).length).toBe(1000);
    expect(await readBodyCapped(new Response(null, { status: 500 }))).toBe('');

    vi.useFakeTimers();
    const control = bodyStream(['{"error":'], true);
    const p = readBodyCapped(new Response(control.stream, { status: 500 }), 65_536, 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    control.push('"more"');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('{"error":"more"');
    expect(control.cancelled()).toBe(true);
  });

  it('httpError clips the message, redacts and clips the body, and applies x-should-retry', () => {
    const redact = (s: string): string => s.replaceAll('SECRET', '[REDACTED]');
    const e = httpError({ provider: 'p', status: 200, headers: new Headers({ 'x-should-retry': 'true' }), body: 'SECRET '.repeat(1000), redact, message: 'SECRET '.repeat(200) });
    expect(e.retryable).toBe(true);
    expect(e.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(e.message).not.toContain('SECRET');
    expect(e.body).not.toContain('SECRET');
    expect(e.body.length).toBeLessThanOrEqual(2048);
    expect(httpError({ provider: 'p', status: 503, headers: new Headers({ 'x-should-retry': 'false' }), body: '', redact }).retryable).toBe(false);
    expect(clipMessage('short')).toBe('short');
  });

  it('notify converts a throwing callback into a typed internal error and passes through JevCodeErrors', () => {
    let seen = '';
    notify((v: string) => void (seen = v), 'x');
    expect(seen).toBe('x');
    notify(undefined, 'ignored');
    expect(() =>
      notify(() => {
        throw new TypeError('bug');
      }, 1),
    ).toThrowError(JevCodeError);
    const typed = new ProviderHttpError('keep', { status: 0, retryable: false });
    expect(() =>
      notify(() => {
        throw typed;
      }, 1),
    ).toThrow(typed);
  });
});
