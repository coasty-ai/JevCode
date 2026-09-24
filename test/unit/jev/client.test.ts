import { describe, expect, it } from 'vitest';
import { AbortError, BudgetError, ConfigError, JevCodeError, JevHttpError, JevModelDriftError, JevResponseError, REQUEST_ID_MAX_CHARS } from '../../../src/errors.js';
import { sha12 } from '../../../src/core/hash.js';
import { toJson } from '../../../src/core/json.js';
import type { AskOptions, DeciderConfig, Json } from '../../../src/core/types.js';
import {
  APP_TITLE,
  DEFAULT_REFERER,
  UNKNOWN_MODEL_HINT_RE,
  backoffMs,
  checkServedModel,
  createJevDecider,
  errorHint,
  isDatedModelId,
  isRetryableStatus,
  normaliseModelId,
  parseRetryAfterMs,
} from '../../../src/jev/client.js';
import { JEV_RESPONSE_BODY_MAX_BYTES, JEV_RETRY } from '../../../src/jev/types.js';
import { FAKE_KEY, fakeFetch, loadLiveProbe, recordingSleep, redact, sampleQuestions, validBody } from './helpers.js';
import type { Scripted } from './helpers.js';
import { JEV_PROVIDERS } from '../../../src/jev/providers.js';

// contract 1.2 (TUI-DESIGN-2 §6 item 4): the three required provider fields
const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: FAKE_KEY, model: 'typesafe/jev-1.13-20260917', pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };
const state: Json = { task: 'fix the failing test', proposal: { action: { kind: 'run', command: 'pytest -q' } } };

function askOpts(signal = new AbortController().signal): AskOptions {
  return { signal, stage: 'risk', step: 1 };
}

/** Decider with scripted fetch, jitter-free backoff and recorded sleeps (`extra.cfg` = another DeciderConfig, e.g. the TypeSafe one). */
function build(script: Scripted[], extra: { random?: () => number; cfg?: DeciderConfig } = {}) {
  const ff = fakeFetch(script);
  const rs = recordingSleep();
  let clock = 0;
  const decider = createJevDecider(extra.cfg ?? cfg, {
    fetch: ff.fetch,
    redact,
    random: extra.random ?? (() => 0),
    sleep: rs.sleep,
    now: () => (clock += 7),
  });
  return { decider, calls: ff.calls, sleeps: rs.sleeps };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('createJevDecider: wire protocol', () => {
  it('posts { model, state, questions } with the lab.mjs headers and returns the validated result', async () => {
    const body = validBody(sampleQuestions, { id: 'gen-dec-1' });
    const { decider, calls } = build([{ status: 200, body, headers: { 'x-generation-id': 'gen-dec-1', 'x-provider-name': 'TypeSafe' } }]);
    expect(decider.model).toBe(cfg.model);
    expect(decider.provider).toBe('openrouter'); // contract 1.2 (TUI-DESIGN-2 §6 item 7): cfg.provider rides the Decider
    const res = await decider.ask(state, sampleQuestions, askOpts());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(cfg.baseUrl);
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe(DEFAULT_REFERER);
    expect(headers['X-Title']).toBe(APP_TITLE);
    expect(APP_TITLE).toBe('jevcode');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.bodyJson).toEqual({ model: cfg.model, state, questions: toJson(sampleQuestions) });

    expect(res.model).toBe('typesafe/jev-1.13-20260917');
    expect(res.id).toBe('gen-dec-1');
    expect(res.attempts).toBe(1);
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 10, costUsd: 100 * 4.2e-8, calls: 1 });
    expect(res.requestHash).toBe(sha12(toJson({ model: cfg.model, state, questions: sampleQuestions })));
    expect(res.requestHash).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(res.answers).sort()).toEqual(Object.keys(sampleQuestions).sort());
  });

  it('requestHash is independent of key order and sends the configured model verbatim', async () => {
    const aliasCfg: DeciderConfig = { ...cfg, model: 'TypeSafe/Jev-1.13', pinned: false };
    const ff = fakeFetch([{ status: 200, body: validBody(sampleQuestions) }, { status: 200, body: validBody(sampleQuestions) }]);
    const decider = createJevDecider(aliasCfg, { fetch: ff.fetch, redact });
    const a = await decider.ask({ x: 1, y: 2 }, sampleQuestions, askOpts());
    const b = await decider.ask({ y: 2, x: 1 }, sampleQuestions, askOpts());
    expect(a.requestHash).toBe(b.requestHash);
    expect((ff.calls[0]!.bodyJson as { model: string }).model).toBe('TypeSafe/Jev-1.13');
  });

  it('falls back to the x-generation-id header when the body has no id; null when neither', async () => {
    const { decider } = build([
      { status: 200, body: validBody(sampleQuestions), headers: { 'x-generation-id': 'gen-dec-hdr' } },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBe('gen-dec-hdr');
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBeNull();
  });

  it('accepts the verbatim live probe body', async () => {
    const fx = loadLiveProbe();
    const { decider } = build([{ status: 200, body: fx.response }]);
    const res = await decider.ask(state, fx.questions, askOpts());
    expect(res.usage.costUsd).toBeCloseTo(895 * 4.2e-8, 12);
    expect(res.model).toBe('typesafe/jev-1.13-20260917');
    // TUI-DESIGN-2 §2.4 / §6 item 6: OpenRouter's body carries usage.cost, so the basis is the provider's figure, not the table
    expect(res.costBasis).toBe('provider');
    expect(res.usage.costUsd).toBeCloseTo(res.usage.inputTokens * cfg.pricing.inputUsdPerToken, 12);
  });

  it('rejects an empty question batch as an internal error without a request', async () => {
    const { decider, calls } = build([]);
    const e = await rejection(decider.ask(state, {}, askOpts()));
    expect(e).toBeInstanceOf(JevCodeError);
    expect((e as JevCodeError).code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it.each([null, 42, true])('rejects a state Jev would 400 (%j) before any request; a string state is sent', async (bad) => {
    const { decider, calls } = build([{ status: 200, body: validBody(sampleQuestions) }]);
    const e = await rejection(decider.ask(bad, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevCodeError);
    expect((e as JevCodeError).code).toBe('internal');
    expect(calls).toHaveLength(0);
    await expect(decider.ask('plain text state', sampleQuestions, askOpts())).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('validates its configuration up front', () => {
    expect(() => createJevDecider({ ...cfg, apiKey: '' }, { redact })).toThrow(ConfigError);
    expect(() => createJevDecider({ ...cfg, baseUrl: 'not a url' }, { redact })).toThrow(/--jev-base-url/);
    expect(() => createJevDecider({ ...cfg, baseUrl: 'mailto:someone@example.com' }, { redact })).toThrow(/--jev-base-url.*http/);
    expect(() => createJevDecider({ ...cfg, baseUrl: 'ftp://openrouter.ai/x' }, { redact })).toThrow(ConfigError);
    expect(() => createJevDecider({ ...cfg, baseUrl: 'http://127.0.0.1:8080/decisions' }, { redact })).not.toThrow();
    expect(() => createJevDecider({ ...cfg, model: ' ' }, { redact })).toThrow(/--jev-model/);
    expect(() => createJevDecider(cfg, { redact: undefined as unknown as (s: string) => string })).toThrow(JevCodeError);
    expect(() => createJevDecider(cfg, { redact: 'nope' as unknown as (s: string) => string })).toThrow(/redact/);
    try {
      createJevDecider({ ...cfg, apiKey: '' }, { redact });
    } catch (e) {
      expect((e as ConfigError).exitCode).toBe(2);
      expect((e as ConfigError).setting).toBe('jev-api-key');
    }
  });
});

describe('createJevDecider: retry schedule', () => {
  it('429 with Retry-After: 2 sleeps exactly 2000 ms then succeeds', async () => {
    const { decider, calls, sleeps } = build([
      { status: 429, body: { error: { message: 'rate limited', code: 429 } }, headers: { 'retry-after': '2' } },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it('Retry-After: 120 is ignored in favour of the backoff schedule', async () => {
    const { decider, sleeps } = build([
      { status: 429, body: '', headers: { 'retry-after': '120' } },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    await decider.ask(state, sampleQuestions, askOpts());
    expect(sleeps).toEqual([500]);
  });

  it('503 twice then 200: sleeps 500 then 1000 (jitter 0), three attempts', async () => {
    const { decider, sleeps, calls } = build([
      { status: 503, body: { error: { message: 'provider overloaded' } } },
      { status: 503, body: 'error code: 524\n' },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(sleeps).toEqual([500, 1000]);
    expect(calls).toHaveLength(3);
    expect(res.attempts).toBe(3);
  });

  it('jitter subtracts up to 25 % and the backoff caps at 5000 ms', () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(2, () => 0)).toBe(1000);
    expect(backoffMs(1, () => 0.5)).toBe(438);
    expect(backoffMs(1, () => 0.999)).toBeGreaterThanOrEqual(375);
    expect(backoffMs(10, () => 0)).toBe(5000);
    expect(JEV_RETRY.attempts).toBe(3);
  });

  it('gives up after three retryable failures with the last JevHttpError', async () => {
    const { decider, sleeps, calls } = build([
      { status: 500, body: '' },
      { status: 502, body: '' },
      { status: 529, body: { error: { message: 'TypeSafe is temporarily overloaded. Retry after a short delay.' } } },
    ]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevHttpError);
    const err = e as JevHttpError;
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
    expect(err.exitCode).toBe(5);
    expect(err.message).toContain('temporarily overloaded');
    expect(sleeps).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('400 is not retried, carries status, body and retryAfterMs null; nothing leaks the key', async () => {
    const fx = loadLiveProbe();
    const leaky = { error: { message: `bad request for ${FAKE_KEY}`, code: 400, echo: fx.errors.zod400 } };
    const { decider, calls, sleeps } = build([{ status: 400, body: leaky }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevHttpError);
    const err = e as JevHttpError;
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.retryAfterMs).toBeNull();
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.body).not.toContain(FAKE_KEY);
    expect(err.message).toContain('[KEY]');
    expect(err.body.length).toBeLessThanOrEqual(2000);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([401, 402, 403, 404, 501])('%i is never retried', async (status) => {
    const { decider, calls } = build([{ status, body: { error: { message: 'no' } } }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect((e as JevHttpError).status).toBe(status);
    expect((e as JevHttpError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('isRetryableStatus follows the adopted policy exactly', () => {
    expect([408, 429, 500, 502, 503, 504, 524, 529, 599].every(isRetryableStatus)).toBe(true);
    expect([200, 400, 401, 402, 403, 404, 413, 501, 600].some(isRetryableStatus)).toBe(false);
  });

  it('parseRetryAfterMs honours seconds in (0, 60] only', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs('60')).toBe(60000);
    expect(parseRetryAfterMs('61')).toBeNull();
    expect(parseRetryAfterMs('0')).toBeNull();
    expect(parseRetryAfterMs('-3')).toBeNull();
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it('a network error (fetch rejects) is retried', async () => {
    const { decider, sleeps, calls } = build([
      { throw: new TypeError('fetch failed', { cause: new Error('ECONNRESET') }) },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(sleeps).toEqual([500]);
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it('a network error on every attempt surfaces as status 0 with the cause message', async () => {
    const err = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND openrouter.ai') });
    const { decider } = build([{ throw: err }, { throw: err }, { throw: err }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect((e as JevHttpError).status).toBe(0);
    expect((e as JevHttpError).retryable).toBe(true);
    expect((e as JevHttpError).message).toContain('ENOTFOUND');
  });

  it('a per-attempt TimeoutError abort is retried', async () => {
    const { decider, sleeps, calls } = build([{ timeout: true }, { status: 200, body: validBody(sampleQuestions) }]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(sleeps).toEqual([500]);
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it('an engine abort (AbortError reason) is not retried and its reason is rethrown', async () => {
    const controller = new AbortController();
    const reason = new AbortError('human_abort');
    const { decider, calls, sleeps } = build([{ waitForAbort: true }, { status: 200, body: validBody(sampleQuestions) }]);
    const pending = decider.ask(state, sampleQuestions, askOpts(controller.signal));
    controller.abort(reason);
    const e = await rejection(pending);
    expect(e).toBe(reason);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('a wall-time BudgetError abort during the backoff sleep is rethrown and stops retrying', async () => {
    const controller = new AbortController();
    const reason = new BudgetError('wall_time');
    const ff = fakeFetch([{ status: 503, body: '' }, { status: 200, body: validBody(sampleQuestions) }]);
    const decider = createJevDecider(cfg, {
      fetch: ff.fetch,
      redact,
      random: () => 0,
      sleep: (_ms, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          controller.abort(reason);
        }),
    });
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts(controller.signal)));
    expect(e).toBe(reason);
    expect(ff.calls).toHaveLength(1);
  });

  it('an already-aborted signal short-circuits before any request', async () => {
    const controller = new AbortController();
    const reason = new AbortError('signal');
    controller.abort(reason);
    const { decider, calls } = build([{ status: 200, body: validBody(sampleQuestions) }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts(controller.signal)));
    expect(e).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it('the per-attempt signal is a linked controller: an engine abort mid-request aborts the fetch and rejects the ask', async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | null = null;
    // a fetch that only settles when its signal aborts, so the abort has to propagate through the link
    const pendingFetch: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        fetchSignal = init?.signal ?? null;
        fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
      });
    const decider = createJevDecider(cfg, { fetch: pendingFetch, redact: (s) => s });
    const p = decider.ask(state, sampleQuestions, askOpts(controller.signal));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchSignal).not.toBeNull();
    expect(fetchSignal!.aborted).toBe(false);
    controller.abort(new AbortError('human_abort'));
    expect(fetchSignal!.aborted).toBe(true);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});

describe('createJevDecider: validation path', () => {
  it('a transient shape failure is retried once without a backoff sleep, then succeeds', async () => {
    const { decider, calls, sleeps } = build([
      { status: 200, body: { model: 'typesafe/jev-1.13-20260917', usage: { input_tokens: 1, output_tokens: 1, cost: 0 } } },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(res.attempts).toBe(2);
  });

  it('a non-JSON 200 body counts as transient and is retried once', async () => {
    const { decider, calls } = build([{ status: 200, body: '<html>edge error</html>' }, { status: 200, body: validBody(sampleQuestions) }]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it('two transient failures in a row throw the second JevResponseError', async () => {
    const bad: Json = { model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
    const { decider, calls } = build([{ status: 200, body: '' }, { status: 200, body: bad }, { status: 200, body: validBody(sampleQuestions) }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevResponseError);
    expect(calls).toHaveLength(2);
  });

  it('a deterministic mismatch (choice not argmax) is thrown at once and billed once', async () => {
    const body = JSON.parse(JSON.stringify(validBody(sampleQuestions))) as { answers: Record<string, Record<string, Json>> };
    body.answers['next_action']!['choice'] = 'read_more_code';
    const { decider, calls } = build([{ status: 200, body: body as unknown as Json }, { status: 200, body: validBody(sampleQuestions) }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevResponseError);
    expect((e as JevResponseError).transient).toBe(false);
    expect((e as JevResponseError).path).toBe('answers."next_action".choice');
    expect(calls).toHaveLength(1);
  });

  it('the validation retry does not consume an HTTP attempt', async () => {
    const { decider, calls, sleeps } = build([
      { status: 503, body: '' },
      { status: 503, body: '' },
      { status: 200, body: '' },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000]);
    expect(res.attempts).toBe(4);
  });

  it('a 200 body over the byte cap is a transient failure: retried once, never buffered whole', async () => {
    const huge = `{"model":"m","pad":"${'x'.repeat(JEV_RESPONSE_BODY_MAX_BYTES + 16)}"}`;
    const { decider, calls, sleeps } = build([{ status: 200, body: huge }, { status: 200, body: validBody(sampleQuestions) }]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(res.attempts).toBe(2);

    const twice = build([{ status: 200, body: huge }, { status: 200, body: huge }]);
    const e = await rejection(twice.decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevResponseError);
    expect((e as JevResponseError).transient).toBe(true);
    expect((e as JevResponseError).message).toContain('exceeds');
  });

  it('a declared content-length over the cap is refused without reading the body', async () => {
    const { decider, calls } = build([
      { status: 200, body: validBody(sampleQuestions), headers: { 'content-length': String(JEV_RESPONSE_BODY_MAX_BYTES * 2), 'content-type': 'application/json' } },
      { status: 200, body: validBody(sampleQuestions) },
    ]);
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it('an oversize error body is clipped on the JevHttpError and still classified by status', async () => {
    const { decider } = build([{ status: 400, body: `{"error":{"message":"${'e'.repeat(JEV_RESPONSE_BODY_MAX_BYTES + 16)}"}}` }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevHttpError);
    expect((e as JevHttpError).status).toBe(400);
    expect((e as JevHttpError).body.length).toBeLessThanOrEqual(2000);
    expect((e as JevHttpError).message.length).toBeLessThan(400);
  });

  it('redacts validation error messages', async () => {
    const bad: Json = { model: `leak ${FAKE_KEY}`, answers: { in_scope: 1 }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
    const { decider } = build([{ status: 200, body: bad }]);
    const e = await rejection(decider.ask(state, sampleQuestions, askOpts()));
    expect(e).toBeInstanceOf(JevResponseError);
    expect((e as JevResponseError).message).not.toContain(FAKE_KEY);
  });
});

describe('model id helpers (§5.4 rule 7)', () => {
  it('normaliseModelId lowercases and strips the typesafe/ prefix', () => {
    expect(normaliseModelId('TypeSafe/Jev-1.13')).toBe('jev-1.13');
    expect(normaliseModelId(' typesafe/jev-1.13-20260917 ')).toBe('jev-1.13-20260917');
    expect(normaliseModelId('jev-1.13')).toBe('jev-1.13');
  });
  it('isDatedModelId recognises a -YYYYMMDD suffix', () => {
    expect(isDatedModelId('typesafe/jev-1.13-20260917')).toBe(true);
    expect(isDatedModelId('jev-1.13-20260917')).toBe(true);
    expect(isDatedModelId('typesafe/jev-1.13')).toBe(false);
    expect(isDatedModelId('typesafe/jev-1.13.0')).toBe(false);
  });

  const served = 'typesafe/jev-1.13-20260917';
  const table: { name: string; configured: { model: string; pinned: boolean }; served: string; resolved: string | null; ok: boolean; firstCall?: boolean }[] = [
    { name: 'dated, equal', configured: { model: 'typesafe/jev-1.13-20260917', pinned: true }, served, resolved: null, ok: true },
    { name: 'dated, casing differs', configured: { model: 'TypeSafe/JEV-1.13-20260917', pinned: true }, served, resolved: null, ok: true },
    { name: 'dated, bare id configured', configured: { model: 'jev-1.13-20260917', pinned: true }, served, resolved: null, ok: true },
    { name: 'dated, different date -> drift (first call)', configured: { model: 'typesafe/jev-1.13-20260801', pinned: true }, served, resolved: null, ok: false, firstCall: true },
    { name: 'alias resolves to dated', configured: { model: 'typesafe/jev-1.13', pinned: false }, served, resolved: null, ok: true },
    { name: 'bare alias, any casing', configured: { model: 'Jev-1.13', pinned: false }, served, resolved: null, ok: true },
    { name: 'alias served verbatim', configured: { model: 'typesafe/jev-1.13', pinned: false }, served: 'typesafe/jev-1.13', resolved: null, ok: true },
    { name: 'alias prefix of a different minor is drift', configured: { model: 'jev-1.1', pinned: false }, served, resolved: null, ok: false, firstCall: true },
    { name: 'alias, unrelated model -> drift', configured: { model: 'typesafe/jev-1.12', pinned: false }, served, resolved: null, ok: false, firstCall: true },
    { name: 'resolved, later response equal', configured: { model: 'typesafe/jev-1.13', pinned: false }, served, resolved: served, ok: true },
    { name: 'resolved, later response differs -> drift (not first call)', configured: { model: 'typesafe/jev-1.13', pinned: false }, served: 'typesafe/jev-1.13-20261001', resolved: served, ok: false, firstCall: false },
    { name: 'resolved compares case-insensitively', configured: { model: 'typesafe/jev-1.13', pinned: false }, served: 'TypeSafe/Jev-1.13-20260917', resolved: served, ok: true },
  ];
  it.each(table)('$name', (row) => {
    const out = checkServedModel(row.configured, row.served, row.resolved);
    expect(out.ok).toBe(row.ok);
    if (out.ok) {
      expect(normaliseModelId(out.resolved)).toBe(normaliseModelId(row.served));
    } else {
      expect(out.error).toBeInstanceOf(JevModelDriftError);
      expect(out.error.configured).toBe(row.configured.model);
      expect(out.error.served).toBe(row.served);
      expect(out.error.exitCode).toBe(row.firstCall ? 2 : 5);
      expect(out.error.message).toContain('--jev-model');
    }
  });
});

describe('TUI-DESIGN-2 §2.4: the TypeSafe native provider through the same client', () => {
  const tsCfg: DeciderConfig = { provider: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1/systemone', apiKey: FAKE_KEY, model: 'jev-1.13.0', pinned: true, pricing: JEV_PROVIDERS.typesafe.pricing, providerSource: 'auto:typesafe-key' };
  /** PROBE: TypeSafe's 200 body — served `jev-1.13.0`, `usage` without `cost`, no `id` */
  const tsBody = (): Json => validBody(sampleQuestions, { model: 'jev-1.13.0', usage: { input_tokens: 319, output_tokens: 23 } });
  const unknownModel400: Json = { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-1.13' } };

  it('posts to api.typesafe.ai with the bearer + content type only (no HTTP-Referer / X-Title) and names its provider', async () => {
    const { decider, calls } = build([{ status: 200, body: tsBody() }], { cfg: tsCfg });
    expect(decider.provider).toBe('typesafe');
    const res = await decider.ask(state, sampleQuestions, askOpts());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}`, 'Content-Type': 'application/json' });
    expect('HTTP-Referer' in headers).toBe(false);
    expect('X-Title' in headers).toBe(false);
    expect(calls[0]!.bodyJson).toEqual({ model: 'jev-1.13.0', state, questions: toJson(sampleQuestions) });
    expect(res.model).toBe('jev-1.13.0');
    expect(checkServedModel({ model: tsCfg.model, pinned: tsCfg.pinned, provider: 'typesafe' }, res.model, null)).toEqual({ ok: true, resolved: 'jev-1.13.0' });
  });

  it('prices a response without usage.cost from the provider table (input × 4.2e-8, output free) with costBasis table; a wire cost wins with costBasis provider', async () => {
    const { decider } = build([{ status: 200, body: tsBody() }, { status: 200, body: validBody(sampleQuestions, { model: 'jev-1.13.0', usage: { input_tokens: 319, output_tokens: 23, cost: 0.001 } }) }], { cfg: tsCfg });
    const table = await decider.ask(state, sampleQuestions, askOpts());
    expect(table.usage).toEqual({ inputTokens: 319, outputTokens: 23, costUsd: 319 * 4.2e-8, calls: 1 });
    expect(table.usage.costUsd).toBeCloseTo(0.000013398, 12);
    expect(table.costBasis).toBe('table');
    const wire = await decider.ask(state, sampleQuestions, askOpts());
    expect(wire.usage.costUsd).toBe(0.001);
    expect(wire.costBasis).toBe('provider');
  });

  it('captures x-typesafe-request-id as the result id when the body has none — redacted, clipped to REQUEST_ID_MAX_CHARS, the provider header first', async () => {
    const { decider } = build(
      [
        { status: 200, body: tsBody(), headers: { 'x-typesafe-request-id': 'req-abc-123', 'request-id': 'generic-1' } },
        { status: 200, body: tsBody(), headers: { 'x-typesafe-request-id': `req-${FAKE_KEY}-x` } },
        { status: 200, body: tsBody(), headers: { 'x-typesafe-request-id': 'r'.repeat(REQUEST_ID_MAX_CHARS + 50) } },
        { status: 200, body: validBody(sampleQuestions, { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, id: 'body-id' }), headers: { 'x-typesafe-request-id': 'req-hdr' } },
        { status: 200, body: tsBody(), headers: { 'request-id': 'generic-2' } },
        { status: 200, body: tsBody() },
      ],
      { cfg: tsCfg },
    );
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBe('req-abc-123');
    const redacted = (await decider.ask(state, sampleQuestions, askOpts())).id;
    expect(redacted).toBe('req-[KEY]-x');
    expect(redacted).not.toContain(FAKE_KEY);
    expect((await decider.ask(state, sampleQuestions, askOpts())).id!.length).toBeLessThanOrEqual(REQUEST_ID_MAX_CHARS);
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBe('body-id');
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBe('generic-2');
    expect((await decider.ask(state, sampleQuestions, askOpts())).id).toBeNull();
  });

  it('rides the request id on JevHttpError for the §13.2 `last: … · request-id <id>` row', async () => {
    const { decider } = build([{ status: 503, body: '', headers: { 'x-typesafe-request-id': 'req-1' } }, { status: 503, body: '', headers: { 'x-typesafe-request-id': 'req-2' } }, { status: 503, body: '', headers: { 'x-typesafe-request-id': 'req-3' } }], { cfg: tsCfg });
    const e = (await rejection(decider.ask(state, sampleQuestions, askOpts()))) as JevHttpError;
    expect(e).toBeInstanceOf(JevHttpError);
    expect(e.requestId).toBe('req-3');
    expect(e.toJSON().requestId).toBe('req-3');
  });

  it('reads detail.message and a string detail as the hint; 422 is not retried', async () => {
    const { decider, calls, sleeps } = build([{ status: 422, body: { detail: { error_type: 'validation_error', message: 'state must be   an object' } } }], { cfg: tsCfg });
    const e = (await rejection(decider.ask(state, sampleQuestions, askOpts()))) as JevHttpError;
    expect(e).toBeInstanceOf(JevHttpError);
    expect(e.status).toBe(422);
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('Jev HTTP 422: state must be an object');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    const s = build([{ status: 422, body: { detail: 'Too many choices. Must have at most 255 choices.' } }], { cfg: tsCfg });
    expect(((await rejection(s.decider.ask(state, sampleQuestions, askOpts()))) as JevHttpError).message).toBe('Jev HTTP 422: Too many choices. Must have at most 255 choices.');
  });

  it('errorHint: error.message, then detail.message, then a string detail, then the body; whitespace collapsed, ≤ 200 chars', () => {
    expect(errorHint(JSON.stringify({ error: { message: 'first' }, detail: { message: 'second' } }))).toBe('first');
    expect(errorHint(JSON.stringify({ detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-1.13' } }))).toBe('Unknown model: jev-1.13');
    expect(errorHint(JSON.stringify({ detail: '  too\n many   choices ' }))).toBe('too many choices');
    expect(errorHint(JSON.stringify({ detail: [{ loc: ['body'] }] }))).toBe('{"detail":[{"loc":["body"]}]}');
    expect(errorHint('error code: 524\n')).toBe('error code: 524');
    expect(errorHint(`{"detail":{"message":"${'m'.repeat(500)}"}}`)).toHaveLength(200);
  });

  it('400 api_usage_error "Unknown model" → ConfigError exit 2 on decider.model, the host actually used and the provider\'s accepts line; one request, no retry hook, never a JevHttpError', async () => {
    const { decider, calls, sleeps } = build([{ status: 400, body: unknownModel400, headers: { 'x-typesafe-request-id': 'req-400' } }], { cfg: { ...tsCfg, model: 'jev-1.13', pinned: false } });
    let hooks = 0;
    const e = await rejection(decider.ask(state, sampleQuestions, { ...askOpts(), onRetry: () => void (hooks += 1) }));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e).not.toBeInstanceOf(JevHttpError);
    const ce = e as ConfigError;
    expect(ce.exitCode).toBe(2);
    expect(ce.setting).toBe('decider.model');
    expect(ce.message).toBe('--jev-model: "jev-1.13" is not served by api.typesafe.ai (Unknown model: jev-1.13); TypeSafe accepts jev-1.13.0 or jev-latest');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(hooks).toBe(0);
    // the 400's JevHttpError rides as `cause`, so the request id a support report needs is kept (message verbatim, §12)
    expect(ce.cause).toBeInstanceOf(JevHttpError);
    const cause = ce.cause as JevHttpError;
    expect(cause.requestId).toBe('req-400');
    expect(cause.status).toBe(400);
    expect(cause.toJSON().requestId).toBe('req-400');
    expect(cause.body).toContain('Unknown model');
    expect(cause.body).not.toContain(FAKE_KEY);
  });

  it('the same mapping on 422, on OpenRouter\'s wording and host, and never for a 5xx or an unrelated 400', async () => {
    const via422 = build([{ status: 422, body: { detail: 'Unknown model: typesafe/jev-9' } }], { cfg: { ...tsCfg, model: 'typesafe/jev-9', pinned: false } });
    expect(await rejection(via422.decider.ask(state, sampleQuestions, askOpts()))).toBeInstanceOf(ConfigError);
    const or = build([{ status: 400, body: { error: { message: 'typesafe/jev-9 is not a valid model ID', code: 400 } } }], { cfg: { ...cfg, model: 'typesafe/jev-9', pinned: false } });
    const oe = (await rejection(or.decider.ask(state, sampleQuestions, askOpts()))) as ConfigError;
    expect(oe).toBeInstanceOf(ConfigError);
    expect(oe.message).toBe('--jev-model: "typesafe/jev-9" is not served by openrouter.ai (typesafe/jev-9 is not a valid model ID); OpenRouter accepts typesafe/jev-1.13-20260917 or typesafe/jev-1.13');
    const noEndpoints = build([{ status: 404, body: { error: { message: 'No endpoints found for typesafe/jev-9', code: 404 } } }], { cfg: { ...cfg, model: 'typesafe/jev-9', pinned: false } });
    // a 404 is not one of the two mapped statuses: it stays the non-retryable JevHttpError it is today
    expect(await rejection(noEndpoints.decider.ask(state, sampleQuestions, askOpts()))).toBeInstanceOf(JevHttpError);
    const overloaded = build([{ status: 503, body: { detail: { message: 'unknown model backend overloaded' } } }, { status: 200, body: tsBody() }], { cfg: tsCfg });
    expect((await overloaded.decider.ask(state, sampleQuestions, askOpts())).attempts).toBe(2);
    const unrelated = build([{ status: 400, body: { detail: { error_type: 'api_usage_error', message: 'state too large' } } }], { cfg: tsCfg });
    const ue = (await rejection(unrelated.decider.ask(state, sampleQuestions, askOpts()))) as JevHttpError;
    expect(ue).toBeInstanceOf(JevHttpError);
    expect(ue.status).toBe(400);
    expect(UNKNOWN_MODEL_HINT_RE.test('Unknown model: x')).toBe(true);
    expect(UNKNOWN_MODEL_HINT_RE.test('state too large')).toBe(false);
  });

  it('checkServedModel under TypeSafe naming: jev-latest resolves to jev-1.13.0; a patch id pins; jev-1.13 never matches jev-1.13.0', () => {
    expect(checkServedModel({ model: 'jev-latest', pinned: false, provider: 'typesafe' }, 'jev-1.13.0', null)).toEqual({ ok: true, resolved: 'jev-1.13.0' });
    expect(checkServedModel({ model: 'jev-latest', pinned: false, provider: 'typesafe' }, 'jev-1.13.0', 'jev-1.13.0').ok).toBe(true);
    const later = checkServedModel({ model: 'jev-latest', pinned: false, provider: 'typesafe' }, 'jev-1.14.0', 'jev-1.13.0');
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.exitCode).toBe(5);
    expect(checkServedModel({ model: 'jev-1.13.0', pinned: true, provider: 'typesafe' }, 'jev-1.13.1', null).ok).toBe(false);
    expect(checkServedModel({ model: 'jev-1.13', pinned: false, provider: 'typesafe' }, 'jev-1.13.0', null).ok).toBe(false);
    // `provider` is read: a caller that derived `pinned` under OpenRouter's naming (`normaliseJevModelId`, pinned:false for jev-1.13.0)
    // still gets equality on typesafe — jev-1.13.0 is pinned there, so jev-1.13.1 and a suffixed id are drift, not an alias resolution
    expect(checkServedModel({ model: 'jev-1.13.0', pinned: false, provider: 'typesafe' }, 'jev-1.13.1', null).ok).toBe(false);
    expect(checkServedModel({ model: 'jev-1.13.0', pinned: false, provider: 'typesafe' }, 'jev-1.13.0-rc1', null).ok).toBe(false);
    expect(checkServedModel({ model: 'jev-1.13.0', pinned: false }, 'jev-1.13.0-rc1', null).ok).toBe(true); // no provider: the caller's alias verdict stands
    expect(checkServedModel({ model: 'jev-1.13.0', pinned: false, provider: 'typesafe' }, 'JEV-1.13.0', null)).toEqual({ ok: true, resolved: 'JEV-1.13.0' });
    // and on openrouter the dated id is pinned whatever the caller said
    expect(checkServedModel({ model: 'typesafe/jev-1.13-20260917', pinned: false, provider: 'openrouter' }, 'jev-1.13-20260917-2', null).ok).toBe(false);
    expect(checkServedModel({ model: 'typesafe/jev-1.13-20260917', pinned: false }, 'jev-1.13-20260917-2', null).ok).toBe(true);
    // a caller's pinned: true is never undone by the provider's naming
    expect(checkServedModel({ model: 'jev-latest', pinned: true, provider: 'typesafe' }, 'jev-1.13.0', null).ok).toBe(false);
  });

  it('refuses an unknown provider up front, like every other configuration fault', () => {
    expect(() => createJevDecider({ ...tsCfg, provider: 'other' as unknown as DeciderConfig['provider'] }, { redact })).toThrow(/--jev-provider/);
    expect(() => createJevDecider({ ...tsCfg, provider: 'other' as unknown as DeciderConfig['provider'] }, { redact })).toThrow(ConfigError);
  });
});
