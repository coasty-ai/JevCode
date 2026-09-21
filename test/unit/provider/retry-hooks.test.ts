/**
 * TUI-DESIGN §13.2 / §15 item 5 / §15.2 `provider/sse.ts` row: `withRetry(deps, signal, attempt, hooks?)` reports each
 * retry through `hooks.onRetry`, reads the `hooks.wake` getter once per sleep and passes it to `deps.sleep`; both
 * providers thread `GenerateOptions.onRetry` / `wake` into it. `ProviderHttpError.toJSON()` carries status / retryable /
 * `side: 'generator'` / requestId (§15 item 4). §9.5: an OpenRouter `usage.cost` that is missing surfaces NaN for an
 * unpriced model. The waker lifecycle test runs the real `sleep` against a fake fetch under fake timers. Offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevCodeError, ProviderHttpError, REQUEST_ID_MAX_CHARS } from '../../../src/errors.js';
import type { GenerateOptions, RetryInfo } from '../../../src/core/types.js';
import { createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { IdleTimeoutError, MAX_ATTEMPTS, TransportError, errnoOf, requestIdOf, retryCauseOf, sanitiseRequestId, withRetry } from '../../../src/provider/sse.js';
import { anthropicCfg, fixture, genOpts, openrouterCfg, request, scriptedFetch, testDeps } from './helpers.js';
import type { ScriptedResponse } from './helpers.js';

const sse = (name: string, headers: Record<string, string> = {}) => ({ status: 200, headers: { 'content-type': 'text/event-stream', ...headers }, body: fixture(name) });
/** A raw SSE body (malformed-frame tests). */
const sseBody = (body: string, headers: Record<string, string> = {}) => ({ status: 200, headers: { 'content-type': 'text/event-stream', ...headers }, body });
/** A key-shaped canary the testDeps redactor recognises (`sk-or-v1-` + 20+ chars); never the configured test key. */
const CANARY = `sk-or-v1-CANARY${'k'.repeat(40)}`;
const ANT_CANARY = `sk-ant-CANARY${'k'.repeat(40)}`;
const identity = (s: string): string => s;

/** The engine's side of §13.2: a fresh AbortController per `onRetry`, `wake` as the getter, `retryNow()` aborts and nulls. */
function fakeWaker(log: string[] = []) {
  let retryWaker: AbortController | null = null;
  const controllers: AbortController[] = [];
  const infos: RetryInfo[] = [];
  let wakeReads = 0;
  const hooks: Pick<GenerateOptions, 'onRetry' | 'wake'> = {
    onRetry: (info) => {
      log.push('onRetry');
      infos.push(info);
      retryWaker = new AbortController();
      controllers.push(retryWaker);
    },
    wake: () => {
      log.push('wake');
      wakeReads++;
      return retryWaker?.signal;
    },
  };
  const retryNow = (): boolean => {
    if (!retryWaker) return false;
    retryWaker.abort();
    retryWaker = null;
    return true;
  };
  return { hooks, retryNow, controllers, infos, log, wakeReads: () => wakeReads };
}

function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('retryCauseOf / errnoOf / requestIdOf (TUI-DESIGN §15 items 4–5)', () => {
  it('classifies http, timeout, network, stream and invalid causes; message is the error’s own redacted text clipped to 200', () => {
    const http = new ProviderHttpError('anthropic HTTP 529 overloaded_error: Overloaded', { status: 529, retryable: true, retryAfterMs: 2000 });
    expect(retryCauseOf(http)).toEqual({ kind: 'http', status: 529, code: null, message: 'anthropic HTTP 529 overloaded_error: Overloaded' });
    expect(retryCauseOf(new IdleTimeoutError('first_byte', 30_000))).toEqual({ kind: 'timeout', status: null, code: 'TimeoutError', message: 'idle_timeout: no byte received for 30000 ms' });
    expect(retryCauseOf(new IdleTimeoutError('idle', 60_000))).toMatchObject({ kind: 'timeout', code: 'TimeoutError' });
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) });
    expect(retryCauseOf(new TransportError('network', 'anthropic: network error: fetch failed', { cause: dns }))).toEqual({ kind: 'network', status: null, code: 'ENOTFOUND', message: 'anthropic: network error: fetch failed' });
    // a connect / headers / body timeout on the socket is a timeout (§13.2 `no response from <host>`), not "offline"
    for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(retryCauseOf(new TransportError('network', 'x', { cause: { code } }))).toMatchObject({ kind: 'timeout', status: null, code });
    }
    expect(retryCauseOf(new TransportError('stream', 'openrouter: stream ended before [DONE] / usage frame'))).toEqual({ kind: 'stream', status: null, code: null, message: 'openrouter: stream ended before [DONE] / usage frame' });
    expect(retryCauseOf(new TransportError('stream', 'reset', { cause: { code: 'ECONNRESET' } }))).toMatchObject({ kind: 'stream', code: 'ECONNRESET' });
    expect(retryCauseOf(new TransportError('invalid', 'anthropic: malformed sse data (no event): not an object'))).toMatchObject({ kind: 'invalid', status: null, code: null });
    // a plain status-0 ProviderHttpError (not one of ours) falls back to `stream`, still reading the cause chain
    expect(retryCauseOf(new ProviderHttpError('odd', { status: 0, retryable: true, cause: { cause: { code: 'EPIPE' } } }))).toEqual({ kind: 'stream', status: null, code: 'EPIPE', message: 'odd' });
    const long = retryCauseOf(new ProviderHttpError('m'.repeat(500), { status: 503, retryable: true }));
    expect(long.message).toHaveLength(200);
    expect(long.message.endsWith('…')).toBe(true);
  });

  it('errnoOf walks the cause chain for a string code, skips JevCodeError codes and gives up at depth 8', () => {
    expect(errnoOf(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }))).toBe('ECONNREFUSED');
    expect(errnoOf(new JevCodeError('internal', 'wrapped', { cause: { code: 'EPIPE' } }))).toBe('EPIPE');
    expect(errnoOf(new JevCodeError('internal', 'bare'))).toBeNull();
    expect(errnoOf({ code: 23 })).toBeNull(); // DOMException-style numeric codes are not errnos
    expect(errnoOf(new DOMException('t', 'TimeoutError'))).toBeNull();
    expect(errnoOf(null)).toBeNull();
    expect(errnoOf('ENOTFOUND')).toBeNull();
    let deep: { cause?: unknown; code?: string } = { code: 'EDEEP' };
    for (let i = 0; i < 9; i++) deep = { cause: deep };
    expect(errnoOf(deep)).toBeNull();
    let near: { cause?: unknown; code?: string } = { code: 'ENEAR' };
    for (let i = 0; i < 6; i++) near = { cause: near };
    expect(errnoOf(near)).toBe('ENEAR');
  });

  it('requestIdOf prefers request-id over x-request-id, trims, redacts, clips at the shared 128-char cap and returns null when absent, blank or redacted away', () => {
    expect(REQUEST_ID_MAX_CHARS).toBe(128);
    expect(requestIdOf(new Headers({ 'request-id': 'req_a', 'x-request-id': 'b' }), identity)).toBe('req_a');
    expect(requestIdOf(new Headers({ 'x-request-id': '  b  ' }), identity)).toBe('b');
    expect(requestIdOf(new Headers({ 'x-request-id': '   ' }), identity)).toBeNull();
    expect(requestIdOf(new Headers(), identity)).toBeNull();
    expect(requestIdOf(new Headers({ 'request-id': 'r'.repeat(200) }), identity)).toBe(`${'r'.repeat(REQUEST_ID_MAX_CHARS - 1)}…`);
    // F9: a proxy echoing a client header — the redactor runs first, so the key never reaches toJSON() / state.json
    const { deps } = testDeps(scriptedFetch([]).fetch);
    expect(requestIdOf(new Headers({ 'x-request-id': CANARY }), deps.redact)).toBe('[REDACTED:pattern]');
    expect(requestIdOf(new Headers({ 'request-id': `req_${CANARY}` }), deps.redact)).toBe('req_[REDACTED:pattern]');
    // redact BEFORE clip: clipping first would cut the key so its pattern no longer matches
    const long = requestIdOf(new Headers({ 'request-id': `${'p'.repeat(120)}${CANARY}` }), deps.redact);
    expect(long).toHaveLength(REQUEST_ID_MAX_CHARS);
    expect(long).not.toContain('sk-or');
    expect(long!.endsWith('…')).toBe(true);
    // sanitiseRequestId is the shared primitive (header value or Anthropic body request_id)
    expect(sanitiseRequestId(null, identity)).toBeNull();
    expect(sanitiseRequestId(undefined, identity)).toBeNull();
    expect(sanitiseRequestId('   ', identity)).toBeNull();
    expect(sanitiseRequestId('req_1', () => '')).toBeNull();
    expect(sanitiseRequestId(' req_1 ', identity)).toBe('req_1');
  });

  it('ProviderHttpError.toJSON() for a transport failure (TransportError, IdleTimeoutError): status 0, retryable, side generator, requestId null, no body', () => {
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) });
    const t = new TransportError('network', 'anthropic: network error: fetch failed', { cause: dns });
    expect(t.toJSON()).toEqual({ name: 'TransportError', code: 'provider_http', message: 'anthropic: network error: fetch failed', exitCode: 5, status: 0, retryable: true, side: 'generator', requestId: null });
    expect('body' in t.toJSON()).toBe(false);
    expect('errno' in t.toJSON()).toBe(false);
    const idle = new IdleTimeoutError('idle', 60_000);
    expect(idle.toJSON()).toEqual({ name: 'IdleTimeoutError', code: 'provider_http', message: 'idle_timeout: no data received for 60000 ms', exitCode: 5, status: 0, retryable: true, side: 'generator', requestId: null });
    expect(JSON.parse(JSON.stringify(idle))).toMatchObject({ status: 0, retryable: true, side: 'generator', requestId: null });
  });
});

describe('withRetry hooks (TUI-DESIGN §13.2, §15.2 provider/sse.ts)', () => {
  it('calls onRetry with the RetryInfo, then reads wake once per sleep and hands it to deps.sleep as the third argument', async () => {
    const w = fakeWaker();
    const sleeps: { ms: number; signal: AbortSignal | undefined; wake: AbortSignal | undefined }[] = [];
    const deps = {
      sleep: async (ms: number, signal?: AbortSignal, wake?: AbortSignal): Promise<void> => {
        w.log.push('sleep');
        sleeps.push({ ms, signal, wake });
      },
      random: () => 0,
    };
    const signal = new AbortController().signal;
    let n = 0;
    const r = await settled(
      withRetry(
        deps,
        signal,
        async () => {
          n++;
          throw new ProviderHttpError(`e${n}`, { status: 529, retryable: true, retryAfterMs: n === 1 ? 2000 : null });
        },
        w.hooks,
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatchObject({ message: 'e3' });
    expect(n).toBe(MAX_ATTEMPTS);
    expect(w.infos).toEqual([
      { attempt: 1, maxAttempts: MAX_ATTEMPTS, waitMs: 2000, retryAfter: true, cause: { kind: 'http', status: 529, code: null, message: 'e1' } },
      { attempt: 2, maxAttempts: MAX_ATTEMPTS, waitMs: 1000, retryAfter: false, cause: { kind: 'http', status: 529, code: null, message: 'e2' } },
    ]);
    expect(w.log).toEqual(['onRetry', 'wake', 'sleep', 'onRetry', 'wake', 'sleep']);
    expect(w.wakeReads()).toBe(2);
    expect(sleeps.map((s) => s.ms)).toEqual([2000, 1000]);
    expect(sleeps.every((s) => s.signal === signal)).toBe(true);
    expect(sleeps[0]!.wake).toBe(w.controllers[0]!.signal);
    expect(sleeps[1]!.wake).toBe(w.controllers[1]!.signal);
    expect(sleeps[0]!.wake).not.toBe(sleeps[1]!.wake);
  });

  it('without hooks (or with empty hooks) the third argument is undefined and the schedule is unchanged', async () => {
    for (const hooks of [undefined, {}]) {
      const wakes: (AbortSignal | undefined)[] = [];
      const deps = {
        sleep: async (_ms: number, _signal?: AbortSignal, wake?: AbortSignal): Promise<void> => {
          wakes.push(wake);
        },
        random: () => 0,
      };
      let n = 0;
      await expect(
        withRetry(
          deps,
          new AbortController().signal,
          async () => {
            n++;
            if (n < 3) throw new ProviderHttpError('busy', { status: 503, retryable: true });
            return 'done';
          },
          hooks,
        ),
      ).resolves.toBe('done');
      expect(wakes).toEqual([undefined, undefined]);
    }
  });

  it('a throwing onRetry or wake surfaces as a typed internal error and ends the chain before the next attempt or sleep', async () => {
    for (const hooks of [
      {
        onRetry: (): void => {
          throw new TypeError('renderer bug');
        },
      },
      {
        wake: (): AbortSignal | undefined => {
          throw new RangeError('waker bug');
        },
      },
    ]) {
      const sleeps: number[] = [];
      let n = 0;
      const r = await settled(
        withRetry(
          { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 },
          new AbortController().signal,
          async () => {
            n++;
            throw new ProviderHttpError('busy', { status: 503, retryable: true });
          },
          hooks,
        ),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBeInstanceOf(JevCodeError);
        expect((r.reason as JevCodeError).code).toBe('internal');
      }
      expect(n).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });
});

describe('providers thread GenerateOptions.onRetry / wake into withRetry (TUI-DESIGN §15.2 anthropic.ts / openrouter.ts)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('anthropic: HTTP 529 then a Retry-After 429 then success — two RetryInfos with http causes and request ids on the errors', async () => {
    const f = scriptedFetch([
      { status: 529, headers: { 'content-type': 'application/json', 'request-id': 'req_529' }, body: fixture('anthropic-529.json') },
      { status: 429, headers: { 'retry-after': '2' }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' },
      sse('anthropic-text.sse'),
    ]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const w = fakeWaker();
    const res = await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts(w.hooks));
    expect(res.text).toBe('Hello, world!');
    expect(f.calls.length).toBe(3);
    expect(sleeps).toEqual([500, 2000]);
    expect(w.infos).toEqual([
      { attempt: 1, maxAttempts: 3, waitMs: 500, retryAfter: false, cause: { kind: 'http', status: 529, code: null, message: 'anthropic HTTP 529 overloaded_error: Overloaded' } },
      { attempt: 2, maxAttempts: 3, waitMs: 2000, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'anthropic HTTP 429 rate_limit_error: slow down' } },
    ]);
    expect(w.log).toEqual(['onRetry', 'wake', 'onRetry', 'wake']);
    expect(w.controllers).toHaveLength(2);
  });

  it('anthropic: an `event: error` after HTTP 200 and a network error report http / network causes', async () => {
    const f = scriptedFetch([sse('anthropic-stream-error.sse'), { status: 0, networkError: 'fetch failed' }, sse('anthropic-text.sse')]);
    const { deps } = testDeps(f.fetch, 0);
    const w = fakeWaker();
    await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts(w.hooks));
    expect(w.infos.map((i) => i.cause)).toEqual([
      { kind: 'http', status: 529, code: null, message: 'anthropic stream error overloaded_error (529): Overloaded' },
      { kind: 'network', status: null, code: null, message: 'anthropic: network error: fetch failed' },
    ]);
  });

  it('openrouter: a Retry-After 429, a stream cut before the usage frame and a malformed frame report http / stream / invalid causes', async () => {
    const full = fixture('openrouter-text.sse');
    const cut = full.split('"usage"')[0]!.replace(/data: \{[^\n]*$/, '');
    const f = scriptedFetch([
      { status: 429, headers: { 'retry-after': '1', 'x-request-id': 'or_429' }, body: '{"error":{"code":429,"message":"You are being rate limited","metadata":{"error_type":"rate_limit_exceeded"}}}' },
      { status: 200, body: cut },
      sse('openrouter-text.sse'),
    ]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const w = fakeWaker();
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts(w.hooks));
    expect(res.text).toBe('I am ready.');
    expect(sleeps).toEqual([1000, 1000]);
    expect(w.infos).toEqual([
      { attempt: 1, maxAttempts: 3, waitMs: 1000, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'openrouter HTTP 429 rate_limit_exceeded: You are being rate limited' } },
      { attempt: 2, maxAttempts: 3, waitMs: 1000, retryAfter: false, cause: { kind: 'stream', status: null, code: null, message: 'openrouter: stream ended before [DONE] / usage frame' } },
    ]);

    const g = scriptedFetch([{ status: 200, body: 'data: not json\n\n' }, sse('openrouter-text.sse')]);
    const second = testDeps(g.fetch, 0);
    const w2 = fakeWaker();
    await createOpenRouterProvider(openrouterCfg(), second.deps).generate(request(), genOpts(w2.hooks));
    expect(w2.infos[0]!.cause).toMatchObject({ kind: 'invalid', status: null, code: null });
    expect(w2.infos[0]!.cause.message.startsWith('openrouter: malformed sse data')).toBe(true);
  });

  it('§13.2 waker lifecycle end to end (anthropic, fake fetch, real sleep): two [r] presses in one 3-attempt chain each shorten exactly one sleep', async () => {
    vi.useFakeTimers();
    const f = scriptedFetch([{ status: 503, body: 'upstream unavailable' }, { status: 503, body: 'upstream unavailable' }, sse('anthropic-text.sse')]);
    // no `sleep` injected: resolveDeps falls back to core/time.ts sleep
    const deps = { fetch: f.fetch, redact: (s: string) => s, random: () => 0 };
    const w = fakeWaker();
    const t0 = Date.now();
    const out = settled(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts(w.hooks)));

    await flush();
    expect(f.calls.length).toBe(1); // attempt 1 failed; the 500 ms backoff is pending
    expect(w.controllers).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // only the backoff timer survives the attempt

    expect(w.retryNow()).toBe(true);
    await flush();
    expect(f.calls.length).toBe(2); // attempt 2 ran without the clock moving
    expect(w.controllers).toHaveLength(2);

    expect(w.retryNow()).toBe(true);
    await flush();
    expect(f.calls.length).toBe(3);

    const r = await out;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe('Hello, world!');
    expect(Date.now() - t0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(w.wakeReads()).toBe(2);
    expect(w.retryNow()).toBe(false); // the last controller was consumed by press #2; nothing is left to abort
  });

  it('a stale press between sleeps never shortens the following sleep (one controller per sleep)', async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      if (n === 2) await gate;
      return n < 3 ? new Response('busy', { status: 503 }) : new Response(fixture('anthropic-text.sse'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const w = fakeWaker();
    const out = settled(createAnthropicProvider(anthropicCfg(), { fetch: fetchImpl, redact: (s) => s, random: () => 0 }).generate(request(), genOpts(w.hooks)));
    await flush();
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(500); // sleep 1 ends by its timer
    await flush();
    expect(n).toBe(2); // attempt 2 held by the gate
    expect(w.retryNow()).toBe(true); // aborts the spent controller 1: harmless
    expect(w.retryNow()).toBe(false);
    release!();
    await flush();
    expect(w.controllers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(n).toBe(2); // sleep 2 (1000 ms) runs its full length
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(n).toBe(3);
    expect((await out).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('redaction of the retry row and the serialized error (TUI-DESIGN §15 item 5 "never a body", §10 F9)', () => {
  it('openrouter: a 503 body and an x-request-id carrying a key — RetryCause.message (≤ 200), toJSON().message and toJSON().requestId never contain the key or the body text', async () => {
    // the key first so the redaction (not the 512-char clip) is what removes it; 1000 x's to exercise the clip
    const body = JSON.stringify({ error: { code: 503, message: `${CANARY} ${'x'.repeat(1000)}`, metadata: { error_type: 'upstream_unavailable' } } });
    const fail = { status: 503, headers: { 'content-type': 'application/json', 'x-request-id': `or_${CANARY}` }, body };
    const f = scriptedFetch([fail, sse('openrouter-text.sse')]);
    const { deps } = testDeps(f.fetch, 0);
    const w = fakeWaker();
    await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts(w.hooks));
    const m = w.infos[0]!.cause.message;
    expect(m.length).toBeLessThanOrEqual(200);
    expect(m.startsWith('openrouter HTTP 503 upstream_unavailable: [REDACTED:pattern] xxxx')).toBe(true);
    expect(m.endsWith('…')).toBe(true);
    expect(m).not.toContain(CANARY);
    expect(m).not.toContain('sk-or');

    const g = scriptedFetch([fail, fail, fail]);
    const second = testDeps(g.fetch, 0);
    const r = await settled(createOpenRouterProvider(openrouterCfg(), second.deps).generate(request(), genOpts()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.reason as ProviderHttpError;
    const json = e.toJSON();
    expect(json.requestId).toBe('or_[REDACTED:pattern]');
    expect(json.message).not.toContain(CANARY);
    expect(json.message.startsWith('openrouter HTTP 503 upstream_unavailable: [REDACTED:pattern] xxxx')).toBe(true);
    expect(json.message).toHaveLength(512); // MAX_MESSAGE_CHARS: the clipped message, never the 2 KiB body
    expect(json.message).not.toContain('x'.repeat(600));
    expect(JSON.stringify(json)).not.toContain('sk-or');
    expect('body' in json).toBe(false);
    expect(e.body).not.toContain(CANARY); // the body field itself is redacted too (pre-existing)
  });

  it('anthropic: a body request_id and a request-id header carrying a key are redacted before they reach toJSON()', async () => {
    const withBodyId = { status: 529, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: `req_${ANT_CANARY}` }) };
    const f = scriptedFetch([withBodyId, withBodyId, withBodyId]);
    const { deps } = testDeps(f.fetch, 0);
    const r = await settled(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.reason as ProviderHttpError).toJSON()).toMatchObject({ status: 529, requestId: 'req_[REDACTED:pattern]' });

    const withHeader = { status: 529, headers: { 'content-type': 'application/json', 'request-id': ANT_CANARY }, body: fixture('anthropic-529.json') };
    const g = scriptedFetch([withHeader, withHeader, withHeader]);
    const second = testDeps(g.fetch, 0);
    const rr = await settled(createAnthropicProvider(anthropicCfg(), second.deps).generate(request(), genOpts()));
    expect(rr.ok).toBe(false);
    if (!rr.ok) expect((rr.reason as ProviderHttpError).toJSON().requestId).toBe('[REDACTED:pattern]');
  });

  it("'invalid' frames: the message is a fixed hint — no V8 snippet, no body bytes, no key; the event name is clipped to 40 (anthropic) — for both the RetryCause and the thrown error", async () => {
    const malformed = sseBody(`event: message_start\ndata: ${ANT_CANARY} not json\n\n`);
    const f = scriptedFetch([malformed, sse('anthropic-text.sse')]);
    const { deps } = testDeps(f.fetch, 0);
    const w = fakeWaker();
    await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts(w.hooks));
    expect(w.infos[0]!.cause).toEqual({ kind: 'invalid', status: null, code: null, message: 'anthropic: malformed sse data (message_start): not valid JSON' });

    const g = scriptedFetch([malformed, malformed, malformed]);
    const r = await settled(createAnthropicProvider(anthropicCfg(), testDeps(g.fetch, 0).deps).generate(request(), genOpts()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const json = (r.reason as ProviderHttpError).toJSON();
      expect(json).toEqual({ name: 'TransportError', code: 'provider_http', message: 'anthropic: malformed sse data (message_start): not valid JSON', exitCode: 5, status: 0, retryable: true, side: 'generator', requestId: null });
      for (const forbidden of ['not json', 'Unexpected token', ANT_CANARY, 'sk-ant']) expect(json.message).not.toContain(forbidden);
    }

    // a JSON body that is not an object, and a wire event name over 40 chars
    const array = sseBody(`event: ${'e'.repeat(60)}\ndata: [1, 2, 3]\n\n`);
    const h = scriptedFetch([array, sse('anthropic-text.sse')]);
    const w2 = fakeWaker();
    await createAnthropicProvider(anthropicCfg(), testDeps(h.fetch, 0).deps).generate(request(), genOpts(w2.hooks));
    expect(w2.infos[0]!.cause.message).toBe(`anthropic: malformed sse data (${'e'.repeat(39)}…): not a JSON object`);

    // openrouter: the same fixed hint
    const or = scriptedFetch([sseBody(`data: ${CANARY} not json\n\n`), sseBody('data: "just a string"\n\n'), sse('openrouter-text.sse')]);
    const w3 = fakeWaker();
    await createOpenRouterProvider(openrouterCfg(), testDeps(or.fetch, 0).deps).generate(request(), genOpts(w3.hooks));
    expect(w3.infos.map((i) => i.cause.message)).toEqual(['openrouter: malformed sse data: not valid JSON', 'openrouter: malformed sse data: not a JSON object']);
  });

  it('end to end: three network failures throw a TransportError whose toJSON() is the status-0 generator shape', async () => {
    const f = scriptedFetch([{ status: 0, networkError: 'fetch failed' }, { status: 0, networkError: 'fetch failed' }, { status: 0, networkError: 'fetch failed' }]);
    const { deps } = testDeps(f.fetch, 0);
    const r = await settled(createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBeInstanceOf(TransportError);
    expect((r.reason as TransportError).toJSON()).toEqual({ name: 'TransportError', code: 'provider_http', message: 'openrouter: network error: fetch failed', exitCode: 5, status: 0, retryable: true, side: 'generator', requestId: null });
  });
});

describe('ProviderHttpError.toJSON() (TUI-DESIGN §15 item 4, §15.2 sse.ts row)', () => {
  it('carries status, retryable, side generator and the request id — header first, Anthropic body request_id as the fallback, null when neither', async () => {
    const cases: { response: ScriptedResponse; status: number; message: string; requestId: string | null }[] = [
      { response: { status: 529, headers: { 'request-id': 'hdr_1' }, body: fixture('anthropic-529.json') }, status: 529, message: 'anthropic HTTP 529 overloaded_error: Overloaded', requestId: 'hdr_1' },
      { response: { status: 529, body: fixture('anthropic-529.json') }, status: 529, message: 'anthropic HTTP 529 overloaded_error: Overloaded', requestId: 'req_011CfDvcnay8azepbdSioxW2' },
      { response: { status: 503, body: 'upstream unavailable' }, status: 503, message: 'anthropic HTTP 503', requestId: null },
    ];
    for (const c of cases) {
      const f = scriptedFetch([c.response, c.response, c.response]);
      const { deps } = testDeps(f.fetch, 0);
      const r = await settled(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts()));
      expect(r.ok, c.message).toBe(false);
      if (r.ok) continue;
      const e = r.reason as ProviderHttpError;
      expect(e.toJSON()).toEqual({ name: 'ProviderHttpError', code: 'provider_http', message: c.message, exitCode: 5, status: c.status, retryable: true, side: 'generator', requestId: c.requestId });
      expect('body' in e.toJSON()).toBe(false);
      expect(JSON.parse(JSON.stringify(e))).toMatchObject({ side: 'generator', status: c.status, requestId: c.requestId });
    }
  });

  it('a mid-stream error carries the 200 response’s request id; OpenRouter uses x-request-id', async () => {
    const f = scriptedFetch([sse('anthropic-stream-error.sse', { 'request-id': 'req_stream' }), sse('anthropic-stream-error.sse', { 'request-id': 'req_stream' }), sse('anthropic-stream-error.sse', { 'request-id': 'req_stream' })]);
    const { deps } = testDeps(f.fetch, 0);
    const r = await settled(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.reason as ProviderHttpError).toJSON()).toMatchObject({ side: 'generator', status: 529, requestId: 'req_stream' });

    const g = scriptedFetch([{ status: 402, headers: { 'x-request-id': 'or_402' }, body: fixture('openrouter-402.json') }]);
    const second = testDeps(g.fetch, 0);
    const rr = await settled(createOpenRouterProvider(openrouterCfg(), second.deps).generate(request(), genOpts()));
    expect(rr.ok).toBe(false);
    if (!rr.ok) expect((rr.reason as ProviderHttpError).toJSON()).toMatchObject({ side: 'generator', status: 402, retryable: false, requestId: 'or_402' });

    const h = scriptedFetch([sse('openrouter-midstream-error.sse', { 'x-request-id': 'or_mid' }), sse('openrouter-text.sse')]);
    const third = testDeps(h.fetch, 0);
    const w = fakeWaker();
    await createOpenRouterProvider(openrouterCfg(), third.deps).generate(request(), genOpts(w.hooks));
    expect(w.infos[0]!.cause).toEqual({ kind: 'http', status: 429, code: null, message: 'openrouter stream error 429 rate_limit_exceeded: Provider returned error' });

    // the exhausted mid-stream chain: the thrown error carries the 200 response's x-request-id
    const mid = sse('openrouter-midstream-error.sse', { 'x-request-id': 'or_mid' });
    const k = scriptedFetch([mid, mid, mid]);
    const fourth = testDeps(k.fetch, 0);
    const rm = await settled(createOpenRouterProvider(openrouterCfg(), fourth.deps).generate(request(), genOpts()));
    expect(rm.ok).toBe(false);
    if (!rm.ok) expect((rm.reason as ProviderHttpError).toJSON()).toMatchObject({ side: 'generator', status: 429, retryable: true, requestId: 'or_mid' });

    // anthropic `event: error` after a 200 without a request-id header → requestId null
    const bare = sse('anthropic-stream-error.sse');
    const m = scriptedFetch([bare, bare, bare]);
    const fifth = testDeps(m.fetch, 0);
    const ra = await settled(createAnthropicProvider(anthropicCfg(), fifth.deps).generate(request(), genOpts()));
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect((ra.reason as ProviderHttpError).toJSON()).toEqual({ name: 'ProviderHttpError', code: 'provider_http', message: 'anthropic stream error overloaded_error (529): Overloaded', exitCode: 5, status: 529, retryable: true, side: 'generator', requestId: null });
  });
});

describe('unpriced usage (TUI-DESIGN §9.5)', () => {
  it('openrouter: a missing usage.cost prices from the table only when cfg.priced is true; otherwise (false or absent) costUsd is NaN, tokens intact', async () => {
    const table = (300 * 2 + 600 * 0.2 + 100 * 2.5 + 100 * 10) / 1e6;
    for (const [cfg, expected] of [
      [openrouterCfg({ priced: true }), table],
      [openrouterCfg({ priced: false }), Number.NaN],
      [openrouterCfg(), Number.NaN],
    ] as const) {
      const f = scriptedFetch([sse('openrouter-tool.sse')]);
      const { deps } = testDeps(f.fetch);
      const res = await createOpenRouterProvider(cfg, deps).generate(request(), genOpts());
      if (Number.isNaN(expected)) expect(res.usage.costUsd).toBeNaN();
      else expect(res.usage.costUsd).toBeCloseTo(expected, 12);
      expect(res.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, calls: 1 });
    }
  });

  it('openrouter: a reported usage.cost of 0 (free / BYOK) is kept as 0 — never mistaken for "missing" — for priced, unpriced and absent-priced configs', async () => {
    const full = fixture('openrouter-text.sse');
    expect(full).toContain('"cost":0.001288');
    const free = full.replace('"cost":0.001288', '"cost":0');
    for (const cfg of [openrouterCfg({ priced: true }), openrouterCfg({ priced: false }), openrouterCfg()]) {
      const f = scriptedFetch([{ status: 200, body: free }]);
      const { deps } = testDeps(f.fetch);
      const res = await createOpenRouterProvider(cfg, deps).generate(request(), genOpts());
      expect(res.usage.costUsd).toBe(0);
      expect(Object.is(res.usage.costUsd, 0)).toBe(true);
      // the frame's `reasoning_tokens: 0` is a reading, not an absence (LLM-JEV-DESIGN §4.12)
      expect(res.usage).toEqual({ inputTokens: 444, outputTokens: 40, costUsd: 0, calls: 1, reasoningTokens: 0 });
    }
    // a negative or non-numeric cost is "missing" (the `c >= 0` branch), so the §9.5 rule applies
    for (const bad of ['"cost":-1', '"cost":"0.001"', '"cost":null']) {
      const f = scriptedFetch([{ status: 200, body: full.replace('"cost":0.001288', bad) }]);
      const res = await createOpenRouterProvider(openrouterCfg(), testDeps(f.fetch).deps).generate(request(), genOpts());
      expect(res.usage.costUsd, bad).toBeNaN();
    }
  });

  it('openrouter: a reported usage.cost is used as-is even for an unpriced model; anthropic always prices from the table', async () => {
    const f = scriptedFetch([sse('openrouter-text.sse')]);
    const { deps } = testDeps(f.fetch);
    const res = await createOpenRouterProvider(openrouterCfg({ priced: false }), deps).generate(request(), genOpts());
    expect(res.usage.costUsd).toBe(0.001288);

    const g = scriptedFetch([sse('anthropic-text.sse')]);
    const second = testDeps(g.fetch);
    const ares = await createAnthropicProvider(anthropicCfg({ priced: false }), second.deps).generate(request(), genOpts());
    expect(ares.usage.costUsd).toBeCloseTo((475 * 2 + 16 * 10) / 1e6, 12);
  });
});
