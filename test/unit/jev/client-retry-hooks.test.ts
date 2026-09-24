/**
 * TUI-DESIGN §13.2 / §15 item 5 / §15.2 `jev/client.ts` row: `AskOptions.onRetry` fires with the RetryInfo before
 * each backoff sleep, `AskOptions.wake` is a GETTER read once per sleep, and the sleep is
 * `sleep(waitMs, opts.signal, opts.wake?.())`. The waker lifecycle test runs the real `sleep` against a fake fetch under
 * fake timers. `JevHttpError.toJSON()` carries status / retryable / side / requestId (§15 item 4). Offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevCodeError, JevHttpError, REQUEST_ID_MAX_CHARS } from '../../../src/errors.js';
import type { AskOptions, DeciderConfig, Json, RetryInfo } from '../../../src/core/types.js';
import { createJevDecider } from '../../../src/jev/client.js';
import { JEV_RETRY } from '../../../src/jev/types.js';
import { FAKE_KEY, fakeFetch, redact, sampleQuestions, validBody } from './helpers.js';
import type { Scripted } from './helpers.js';
import { JEV_PROVIDERS } from '../../../src/jev/providers.js';

const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: FAKE_KEY, model: 'typesafe/jev-1.13-20260917', pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };
const state: Json = { task: 'fix the failing test' };

type HookSleep = (ms: number, signal: AbortSignal, wake?: AbortSignal) => Promise<void>;

/** A sleep that never waits but records `(ms, wake)` and the call order; rejects like the real one when the signal is aborted. */
function recordingSleep(log: string[]): { sleep: HookSleep; sleeps: { ms: number; wake: AbortSignal | undefined }[] } {
  const sleeps: { ms: number; wake: AbortSignal | undefined }[] = [];
  return {
    sleeps,
    sleep: (ms, signal, wake) => {
      log.push('sleep');
      sleeps.push({ ms, wake });
      return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
    },
  };
}

/**
 * The engine's side of §13.2 (`askRecorded`, §15.2): `onRetry` creates a fresh AbortController per sleep and emits
 * `retry`; `wake` is the getter the client reads; `retryNow()` aborts the current controller and nulls it;
 * `retry:settled` (in `finally`) nulls it too.
 */
function fakeWaker(log: string[] = []) {
  let retryWaker: AbortController | null = null;
  const controllers: AbortController[] = [];
  const infos: RetryInfo[] = [];
  let wakeReads = 0;
  const hooks: Pick<AskOptions, 'onRetry' | 'wake'> = {
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
  const settle = (): void => {
    retryWaker = null;
  };
  return { hooks, retryNow, settle, controllers, infos, log, wakeReads: () => wakeReads };
}

function build(script: Scripted[], sleep?: HookSleep) {
  const ff = fakeFetch(script);
  const decider = createJevDecider(cfg, { fetch: ff.fetch, redact, random: () => 0, ...(sleep ? { sleep } : {}) });
  return { decider, calls: ff.calls };
}

function askOpts(hooks: Pick<AskOptions, 'onRetry' | 'wake'> = {}, signal = new AbortController().signal): AskOptions {
  return { signal, stage: 'risk', step: 1, ...hooks };
}

function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
}

/** Let fetch → body read → parse → next attempt run under fake timers without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

const ok = (): Scripted => ({ status: 200, body: validBody(sampleQuestions) });

describe('AskOptions.onRetry / wake (TUI-DESIGN §13.2, §15 item 5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onRetry gets the RetryInfo of the failed attempt before each backoff sleep, in order onRetry → wake → sleep, never after the last failure', async () => {
    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    const { decider, calls } = build(
      [{ status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '2' } }, { status: 503, body: '' }, ok()],
      rs.sleep,
    );
    const res = await decider.ask(state, sampleQuestions, askOpts(w.hooks));
    expect(res.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(w.infos).toEqual([
      { attempt: 1, maxAttempts: JEV_RETRY.attempts, waitMs: 2000, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'Jev HTTP 429: rate limited' } },
      { attempt: 2, maxAttempts: JEV_RETRY.attempts, waitMs: 1000, retryAfter: false, cause: { kind: 'http', status: 503, code: null, message: 'Jev HTTP 503' } },
    ]);
    expect(w.log).toEqual(['onRetry', 'wake', 'sleep', 'onRetry', 'wake', 'sleep']);
    expect(rs.sleeps.map((s) => s.ms)).toEqual([2000, 1000]);
    // the getter is read once per sleep and every sleep sees the controller onRetry just created
    expect(w.wakeReads()).toBe(2);
    expect(w.controllers).toHaveLength(2);
    expect(rs.sleeps[0]!.wake).toBe(w.controllers[0]!.signal);
    expect(rs.sleeps[1]!.wake).toBe(w.controllers[1]!.signal);
    expect(rs.sleeps[0]!.wake).not.toBe(rs.sleeps[1]!.wake);
  });

  it('a chain that gives up reports two retries for three failures; the thrown JevHttpError.toJSON() adds status, retryable, side and requestId', async () => {
    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    const { decider } = build(
      [
        { status: 503, body: '', headers: { 'x-request-id': 'req_1' } },
        { status: 503, body: '' },
        { status: 529, body: { error: { message: 'TypeSafe is temporarily overloaded.' } }, headers: { 'x-request-id': 'req_3' } },
      ],
      rs.sleep,
    );
    const r = await settled(decider.ask(state, sampleQuestions, askOpts(w.hooks)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBeInstanceOf(JevHttpError);
    const err = r.reason as JevHttpError;
    expect(err.toJSON()).toEqual({
      name: 'JevHttpError',
      code: 'jev_http',
      message: 'Jev HTTP 529: TypeSafe is temporarily overloaded.',
      exitCode: 5,
      status: 529,
      retryable: true,
      side: 'jev',
      requestId: 'req_3',
    });
    expect(JSON.parse(JSON.stringify(err))).toMatchObject({ side: 'jev', status: 529, requestId: 'req_3' });
    expect('body' in err.toJSON()).toBe(false);
    expect(w.infos).toHaveLength(2);
    expect(w.infos.map((i) => i.attempt)).toEqual([1, 2]);
  });

  it('network and timeout causes: kind and code come from the cause chain (ENOTFOUND, TimeoutError, ETIMEDOUT), status null, message redacted', async () => {
    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }) });
    const { decider } = build([{ throw: dns }, { timeout: true }, ok()], rs.sleep);
    await decider.ask(state, sampleQuestions, askOpts(w.hooks));
    expect(w.infos.map((i) => i.cause)).toEqual([
      { kind: 'network', status: null, code: 'ENOTFOUND', message: 'Jev request failed: TypeError: fetch failed (getaddrinfo ENOTFOUND openrouter.ai)' },
      { kind: 'timeout', status: null, code: 'TimeoutError', message: `Jev request timed out after ${JEV_RETRY.attemptTimeoutMs} ms` },
    ]);
    expect(w.infos.map((i) => i.retryAfter)).toEqual([false, false]);

    // a socket-level timeout is a timeout, not "offline" (§13.2 `no response from <host> in 10 s`)
    const w2 = fakeWaker();
    const rs2 = recordingSleep(w2.log);
    const socket = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
    const second = build([{ throw: socket }, ok()], rs2.sleep);
    await second.decider.ask(state, sampleQuestions, askOpts(w2.hooks));
    expect(w2.infos[0]!.cause).toEqual({ kind: 'timeout', status: null, code: 'ETIMEDOUT', message: 'Jev request failed: TypeError: fetch failed (connect ETIMEDOUT)' });

    // a cause chain without a code word yields null, never a guess
    const w3 = fakeWaker();
    const rs3 = recordingSleep(w3.log);
    const third = build([{ throw: new TypeError('fetch failed', { cause: new Error('socket hang up') }) }, ok()], rs3.sleep);
    await third.decider.ask(state, sampleQuestions, askOpts(w3.hooks));
    expect(w3.infos[0]!.cause).toMatchObject({ kind: 'network', status: null, code: null });
  });

  it('§13.2 timeout classification when the per-attempt timer fires but the transport rejects with a plain Error: kind timeout, code TimeoutError, the "timed out" message, status 0, the raw rejection kept under the cause', async () => {
    vi.useFakeTimers();
    // a fetch that only settles when the attempt controller aborts — and then with a plain Error, not a TimeoutError
    const socketClosedOnAbort = (n: { calls: number }, okFrom: number): typeof fetch =>
      ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        n.calls++;
        const signal = init?.signal;
        if (n.calls < okFrom && signal) {
          return new Promise<Response>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('socket closed')), { once: true });
          });
        }
        return Promise.resolve(new Response(JSON.stringify(validBody(sampleQuestions)), { status: 200, headers: { 'content-type': 'application/json' } }));
      }) as typeof fetch;

    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    const n = { calls: 0 };
    const decider = createJevDecider(cfg, { fetch: socketClosedOnAbort(n, 2), redact, random: () => 0, sleep: rs.sleep });
    const out = settled(decider.ask(state, sampleQuestions, askOpts(w.hooks)));
    await flush();
    expect(n.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(JEV_RETRY.attemptTimeoutMs); // the attempt timer fires → the controller aborts → the fake rejects with Error('socket closed')
    await flush();
    const r = await out;
    expect(r.ok).toBe(true);
    expect(n.calls).toBe(2);
    expect(w.infos).toHaveLength(1);
    // one predicate for the message and the classification: never 'network' with a "timed out" message
    expect(w.infos[0]!.cause).toEqual({ kind: 'timeout', status: null, code: 'TimeoutError', message: `Jev request timed out after ${JEV_RETRY.attemptTimeoutMs} ms` });

    // the exhausted chain: the thrown error is status 0 / retryable / requestId null, its cause is TimeoutError-named and keeps the raw rejection
    const w2 = fakeWaker();
    const rs2 = recordingSleep(w2.log);
    const n2 = { calls: 0 };
    const second = createJevDecider(cfg, { fetch: socketClosedOnAbort(n2, 99), redact, random: () => 0, sleep: rs2.sleep });
    const out2 = settled(second.ask(state, sampleQuestions, askOpts(w2.hooks)));
    for (let i = 0; i < JEV_RETRY.attempts; i++) {
      await flush();
      await vi.advanceTimersByTimeAsync(JEV_RETRY.attemptTimeoutMs);
    }
    await flush();
    const r2 = await out2;
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(n2.calls).toBe(JEV_RETRY.attempts);
    const err = r2.reason as JevHttpError;
    expect(err).toBeInstanceOf(JevHttpError);
    expect(err.toJSON()).toEqual({ name: 'JevHttpError', code: 'jev_http', message: `Jev request timed out after ${JEV_RETRY.attemptTimeoutMs} ms`, exitCode: 5, status: 0, retryable: true, side: 'jev', requestId: null });
    expect((err.cause as Error).name).toBe('TimeoutError');
    expect(((err.cause as Error).cause as Error).message).toBe('socket closed');
    expect(w2.infos.map((i) => i.cause.kind)).toEqual(['timeout', 'timeout']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cause.message is the redacted hint clipped to 200 chars — never the body, never the key', async () => {
    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    const { decider } = build([{ status: 503, body: { error: { message: `${'x'.repeat(400)} ${FAKE_KEY}` } } }, ok()], rs.sleep);
    await decider.ask(state, sampleQuestions, askOpts(w.hooks));
    const m = w.infos[0]!.cause.message;
    expect(m.length).toBeLessThanOrEqual(200);
    expect(m).toMatch(/^Jev HTTP 503: x+…$/);
    expect(m).not.toContain(FAKE_KEY);
    expect(m).not.toContain('[KEY]');
  });

  it('§13.2 waker lifecycle against a fake fetch with the real sleep: two [r] presses in one 3-attempt chain each shorten exactly one sleep', async () => {
    vi.useFakeTimers();
    const w = fakeWaker();
    const { decider, calls } = build([{ status: 503, body: '' }, { status: 503, body: '' }, ok()]);
    const t0 = Date.now();
    const out = settled(decider.ask(state, sampleQuestions, askOpts(w.hooks)));

    await flush();
    expect(calls).toHaveLength(1); // attempt 1 failed; the 500 ms backoff sleep is pending
    expect(w.controllers).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // exactly the backoff timer (the per-attempt timer was cleared)

    expect(w.retryNow()).toBe(true); // [r] #1 aborts controller 1 → sleep 1 resolves now
    await flush();
    expect(calls).toHaveLength(2); // attempt 2 ran without the clock moving
    expect(w.controllers).toHaveLength(2); // onRetry made a fresh controller for sleep 2 (1000 ms)
    expect(vi.getTimerCount()).toBe(1);

    expect(w.retryNow()).toBe(true); // [r] #2 aborts controller 2 only
    await flush();
    expect(calls).toHaveLength(3);

    const r = await out;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attempts).toBe(3);
    expect(Date.now() - t0).toBe(0); // neither sleep waited
    expect(vi.getTimerCount()).toBe(0); // nothing left running
    expect(w.wakeReads()).toBe(2);
    expect(w.controllers[0]!.signal.aborted && w.controllers[1]!.signal.aborted).toBe(true);
    // retry:settled nulls the waker (engine `finally`); a stray press afterwards is inert — no spin
    w.settle();
    expect(w.retryNow()).toBe(false);
  });

  it('a stale press — after a sleep ended by its own timer, while the next attempt is in flight — never shortens the following sleep', async () => {
    vi.useFakeTimers();
    const w = fakeWaker();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      if (n === 2) await gate;
      return n < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify(validBody(sampleQuestions)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const decider = createJevDecider(cfg, { fetch: fetchImpl, redact, random: () => 0 });
    const out = settled(decider.ask(state, sampleQuestions, askOpts(w.hooks)));

    await flush();
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(500); // sleep 1 ends by its timer
    await flush();
    expect(n).toBe(2); // attempt 2 in flight, held by the gate
    // the press finds controller 1 (already used by a finished sleep): aborting it is harmless and the waker is nulled
    expect(w.retryNow()).toBe(true);
    expect(w.retryNow()).toBe(false);
    release!();
    await flush();
    expect(w.controllers).toHaveLength(2); // attempt 2 failed → onRetry created controller 2 → sleep 2 (1000 ms)
    expect(w.controllers[1]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(n).toBe(2); // sleep 2 ran its full length despite the stale press
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(n).toBe(3);
    const r = await out;
    expect(r.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an engine abort during a sleep still wins over the waker: the reason is rethrown, no further request', async () => {
    vi.useFakeTimers();
    const w = fakeWaker();
    const ac = new AbortController();
    const reason = new JevCodeError('abort', 'aborted: human_abort');
    const { decider, calls } = build([{ status: 503, body: '' }, ok()]);
    const out = settled(decider.ask(state, sampleQuestions, askOpts(w.hooks, ac.signal)));
    await flush();
    expect(calls).toHaveLength(1);
    ac.abort(reason);
    const r = await out;
    expect(r).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing onRetry or wake is a harness bug: typed internal error, chain stopped before the next request, no sleep', async () => {
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
      const log: string[] = [];
      const rs = recordingSleep(log);
      const { decider, calls } = build([{ status: 503, body: '' }, ok()], rs.sleep);
      const r = await settled(decider.ask(state, sampleQuestions, askOpts(hooks)));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBeInstanceOf(JevCodeError);
      expect((r.reason as JevCodeError).code).toBe('internal');
      expect(calls).toHaveLength(1);
      expect(rs.sleeps).toEqual([]);
    }
  });

  it('onRetry is not called for the validation retry (no sleep) nor for a non-retryable 400', async () => {
    const w = fakeWaker();
    const rs = recordingSleep(w.log);
    // a body without `answers` is the transient shape (§5.2): retried once, without a backoff sleep
    const bad: Json = { model: cfg.model, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
    const { decider, calls } = build([{ status: 200, body: bad }, ok()], rs.sleep);
    await decider.ask(state, sampleQuestions, askOpts(w.hooks));
    expect(calls).toHaveLength(2);
    expect(w.infos).toEqual([]);
    expect(rs.sleeps).toEqual([]);

    const w2 = fakeWaker();
    const rs2 = recordingSleep(w2.log);
    const second = build([{ status: 400, body: { error: { message: 'bad request' } } }], rs2.sleep);
    await expect(second.decider.ask(state, sampleQuestions, askOpts(w2.hooks))).rejects.toBeInstanceOf(JevHttpError);
    expect(w2.infos).toEqual([]);
  });

  it('requestId: request-id, then x-request-id, then x-generation-id; null for a transport failure; redacted (F9) then clipped to the shared 128-char cap', async () => {
    expect(REQUEST_ID_MAX_CHARS).toBe(128);
    const cases: { headers: Record<string, string>; expected: string | null }[] = [
      { headers: { 'request-id': 'a', 'x-request-id': 'b', 'x-generation-id': 'c' }, expected: 'a' },
      { headers: { 'x-request-id': ' b ', 'x-generation-id': 'c' }, expected: 'b' },
      { headers: { 'x-generation-id': 'gen-9' }, expected: 'gen-9' },
      { headers: { 'x-generation-id': '   ' }, expected: null },
      { headers: {}, expected: null },
      { headers: { 'request-id': 'r'.repeat(300) }, expected: `${'r'.repeat(REQUEST_ID_MAX_CHARS - 1)}…` },
      // a proxy echoing a client header: the key is redacted before the clip, so toJSON() / state.json never see it
      { headers: { 'x-request-id': FAKE_KEY }, expected: '[KEY]' },
      { headers: { 'request-id': `req_${FAKE_KEY}` }, expected: 'req_[KEY]' },
      { headers: { 'request-id': `${'p'.repeat(120)}${FAKE_KEY}` }, expected: `${'p'.repeat(120)}[KEY]` }, // 125 chars after redaction: under the cap, no clip
      { headers: { 'request-id': `${'p'.repeat(130)}${FAKE_KEY}` }, expected: `${'p'.repeat(REQUEST_ID_MAX_CHARS - 1)}…` }, // redacted first (135 chars), then clipped
    ];
    for (const c of cases) {
      const { decider } = build([{ status: 400, body: '', headers: { 'content-type': 'application/json', ...c.headers } }]);
      const r = await settled(decider.ask(state, sampleQuestions, askOpts()));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect((r.reason as JevHttpError).requestId).toBe(c.expected);
      expect((r.reason as JevHttpError).toJSON()).toMatchObject({ side: 'jev', status: 400, retryable: false, requestId: c.expected });
      expect(JSON.stringify((r.reason as JevHttpError).toJSON())).not.toContain(FAKE_KEY);
    }
    const err = new TypeError('fetch failed');
    const { decider } = build([{ throw: err }, { throw: err }, { throw: err }], recordingSleep([]).sleep);
    const r = await settled(decider.ask(state, sampleQuestions, askOpts()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.reason as JevHttpError).toJSON()).toMatchObject({ side: 'jev', status: 0, retryable: true, requestId: null });
  });

  it('an injected two-argument sleep (JevClientDeps shape) keeps working: the waker is simply not observed', async () => {
    const sleeps: number[] = [];
    const legacy = (ms: number, signal: AbortSignal): Promise<void> => {
      sleeps.push(ms);
      return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
    };
    const w = fakeWaker();
    const ff = fakeFetch([{ status: 503, body: '' }, ok()]);
    const decider = createJevDecider(cfg, { fetch: ff.fetch, redact, random: () => 0, sleep: legacy });
    const res = await decider.ask(state, sampleQuestions, askOpts(w.hooks));
    expect(res.attempts).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(w.infos).toHaveLength(1);
    expect(w.wakeReads()).toBe(1);
  });
});
