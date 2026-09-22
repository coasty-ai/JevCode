/**
 * provider/http.ts — the transport half the five 2026-09 clients share: request validation, the error envelopes, the
 * retry chain, LLM-JEV-DESIGN §4.8's rate-limited cancellation, and the catalogue GET helper.
 */
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { getJson, googleErrorFields, joinUrl, openAiErrorFields, priceOutcome, validateGenerateRequest } from '../../../src/provider/http.js';
import { createXaiProvider } from '../../../src/provider/xai.js';
import { createOpenAiProvider } from '../../../src/provider/openai.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch } from './helpers.js';

const headers = (o: Record<string, string> = {}): Headers => new Headers(o);

describe('validateGenerateRequest', () => {
  it('rejects the four impossible requests as non-retryable status-0 errors', () => {
    const bad = (over: Parameters<typeof request>[0]): ProviderHttpError => {
      try {
        validateGenerateRequest('openai', request(over));
      } catch (e) {
        return e as ProviderHttpError;
      }
      throw new Error('expected a throw');
    };
    expect(bad({ maxTokens: 0 }).message).toContain('maxTokens must be a positive integer');
    expect(bad({ messages: [] }).message).toContain('messages is empty');
    expect(bad({ temperature: Number.NaN }).message).toContain('temperature must be');
    expect(bad({ seed: 1.5 }).message).toContain('seed must be an integer');
    expect(bad({ reasoning: { maxTokens: 0 } }).message).toContain('reasoning.maxTokens');
    const e = bad({ maxTokens: -1 });
    expect(e.status).toBe(0);
    expect(e.retryable).toBe(false);
    expect(() => validateGenerateRequest('openai', request())).not.toThrow();
  });
});

describe('error envelopes', () => {
  it('reads the OpenAI shape, the Fireworks label variant and the flat xAI shape', () => {
    expect(openAiErrorFields({ error: { message: 'no', type: 'invalid_request_error', code: null } }, 400, headers())).toEqual({
      kind: 'invalid_request_error',
      message: 'no',
      requestId: null,
      retryable: null,
    });
    expect(openAiErrorFields({ error: { message: 'nope', type: 'error', code: 'UNAUTHORIZED' }, request_id: 'req-7' }, 401, headers())).toEqual({
      kind: 'UNAUTHORIZED',
      message: 'nope',
      requestId: 'req-7',
      retryable: null,
    });
    expect(openAiErrorFields({ code: 'invalid-argument', error: 'bad effort' }, 400, headers())).toEqual({ kind: 'invalid-argument', message: 'bad effort', requestId: null, retryable: null });
  });

  it('never retries a 429 that is really an empty wallet, but leaves a real rate limit retryable', () => {
    expect(openAiErrorFields({ error: { message: 'quota', code: 'insufficient_quota' } }, 429, headers()).retryable).toBe(false);
    expect(openAiErrorFields({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 429, headers()).retryable).toBeNull();
  });

  it('reads Google\'s rpc status and reason', () => {
    const body = { error: { code: 403, message: 'blocked', status: 'PERMISSION_DENIED', details: [{ '@type': 't', reason: 'API_KEY_SERVICE_BLOCKED' }] } };
    expect(googleErrorFields(body, 403, headers())).toEqual({ kind: 'PERMISSION_DENIED API_KEY_SERVICE_BLOCKED', message: 'blocked', requestId: null, retryable: null });
    expect(googleErrorFields({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429, headers()).retryable).toBe(true);
  });
});

describe('priceOutcome', () => {
  const tokens = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 };
  it('prefers the reported cost, then the table, then NaN for an unpriced model', () => {
    expect(priceOutcome(providerCfg(), tokens, 0.5)).toBe(0.5);
    expect(priceOutcome(providerCfg({ priced: true }), tokens, null)).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 12);
    expect(Number.isNaN(priceOutcome(providerCfg(), tokens, null))).toBe(true);
  });
});

describe('the retry chain', () => {
  it('a call whose every attempt is a 429 ends rate-limited: onCancelled records the fact with nothing streamed', async () => {
    const body = JSON.stringify({ code: 'rate-limit', error: 'slow down' });
    const f = scriptedFetch([
      { status: 429, body },
      { status: 429, body },
      { status: 429, body },
    ]);
    const { deps, sleeps } = providerDeps(f.fetch);
    const cancelled: CancelledGeneration[] = [];
    const p = createXaiProvider(providerCfg({ model: 'grok-4.7' }), deps).generate(request(), genOpts({ onCancelled: (c) => cancelled.push(c) }));
    await expect(p).rejects.toMatchObject({ status: 429, retryable: true });
    expect(f.calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(cancelled).toEqual([{ text: '', toolChars: 0, reasoningChars: 0, rateLimited: true }]);
  });

  it('a chain that dies on MID-STREAM 429 frames reports what was served, not zeros', async () => {
    // The recorded xAI transcript up to (but not including) its finish_reason / usage frames, then a 429 delivered as
    // a mid-stream error frame — the shape every one of these APIs may send after a 200 (`isRateLimit` counts it).
    // Tokens were served and billed here, so the rate-limited record must carry the streamed facts: reporting the
    // zero-sized "nothing was served" record instead would book the sample at zero rather than let the engine estimate.
    const served = fixture('xai-tool.sse').split('\n\n').filter((c) => c.trim().length > 0).slice(0, -3).join('\n\n');
    const frame = 'data: {"id":"4c9688b9-da1c-9fc6-bf6d-8ea4ea03b60e","object":"chat.completion.chunk","created":0,"model":"grok-4.7","choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"code":429,"type":"rate_limit_exceeded","message":"Too many requests"}}';
    const body = `${served}\n\n${frame}\n\n`;
    const f = scriptedFetch([
      { status: 200, body },
      { status: 200, body },
      { status: 200, body },
    ]);
    const { deps } = providerDeps(f.fetch);
    const cancelled: CancelledGeneration[] = [];
    const p = createXaiProvider(providerCfg({ model: 'grok-4.7', priced: true }), deps).generate(request(), genOpts({ onCancelled: (c) => cancelled.push(c) }));
    await expect(p).rejects.toMatchObject({ status: 429, retryable: true });
    expect(f.calls.length).toBe(3);
    expect(cancelled.length).toBe(1);
    const rec = cancelled[0]!;
    expect(rec.rateLimited).toBe(true);
    expect(rec.toolChars).toBeGreaterThan(0);
    expect(rec.reasoningChars).toBeGreaterThan(0);
    expect(rec.generationId).toBe('4c9688b9-da1c-9fc6-bf6d-8ea4ea03b60e');
    expect(rec.model).toBe('grok-4.7');
    // the accounting frame never arrived, so there is nothing to price: the engine estimates from the sizes above
    expect(rec.usage).toBeUndefined();
  });

  it('honours Retry-After over the backoff schedule', async () => {
    const f = scriptedFetch([{ status: 429, headers: { 'retry-after': '2' }, body: '{}' }, { status: 200, body: fixture('xai-tool.sse') }]);
    const { deps, sleeps } = providerDeps(f.fetch);
    const res = await createXaiProvider(providerCfg({ model: 'grok-4.7' }), deps).generate(request(), genOpts());
    expect(sleeps).toEqual([2000]);
    expect(res.rateLimited).toBe(true);
  });

  it('classifies a failed fetch as a retryable network error carrying the errno', async () => {
    const f = scriptedFetch([{ status: 0, networkError: 'fetch failed' }, { status: 200, body: fixture('xai-tool.sse') }]);
    const { deps } = providerDeps(f.fetch);
    const res = await createXaiProvider(providerCfg({ model: 'grok-4.7' }), deps).generate(request(), genOpts());
    expect(res.toolCalls.length).toBe(1);
    expect(f.calls.length).toBe(2);
  });

  it('reports each retry to onRetry with a redacted cause', async () => {
    const f = scriptedFetch([{ status: 503, body: '{"error":{"message":"overloaded","type":"server_error"}}' }, { status: 200, body: fixture('openai-responses-tool.sse') }]);
    const { deps } = providerDeps(f.fetch);
    const infos: { attempt: number; kind: string; status: number | null }[] = [];
    await createOpenAiProvider(providerCfg({ model: 'gpt-5.6-terra' }), deps).generate(
      request(),
      genOpts({ onRetry: (i) => infos.push({ attempt: i.attempt, kind: i.cause.kind, status: i.cause.status }) }),
    );
    expect(infos).toEqual([{ attempt: 1, kind: 'http', status: 503 }]);
  });

  it('an abort that lands before the response headers never calls onCancelled (the engine estimates alone)', async () => {
    const pending: typeof fetch = (_input, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const { deps } = providerDeps(pending);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    let calls = 0;
    const p = createOpenAiProvider(providerCfg({ model: 'gpt-5.6-terra' }), deps).generate(request(), genOpts({ signal: ac.signal, onCancelled: () => void calls++ }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});

describe('getJson', () => {
  it('returns the parsed object and maps a non-200 to the same typed error a generation gets', async () => {
    const ok = scriptedFetch([{ status: 200, body: '{"data":[]}' }]);
    expect(await getJson({ label: 'openai', url: 'https://x.invalid/v1/models', headers: {}, deps: providerDeps(ok.fetch).deps })).toEqual({ data: [] });
    expect(ok.calls[0]!.init.method).toBe('GET');

    const bad = scriptedFetch([{ status: 500, body: '{"error":{"message":"boom","type":"server_error"}}' }]);
    await expect(getJson({ label: 'openai', url: 'https://x.invalid/v1/models', headers: {}, deps: providerDeps(bad.fetch).deps })).rejects.toMatchObject({ status: 500, retryable: true });

    const html = scriptedFetch([{ status: 200, body: '<html>proxy</html>' }]);
    await expect(getJson({ label: 'openai', url: 'https://x.invalid/v1/models', headers: {}, deps: providerDeps(html.fetch).deps })).rejects.toMatchObject({ status: 0 });
  });
});

describe('joinUrl', () => {
  it('drops trailing slashes so a config with or without one hits the same endpoint', () => {
    expect(joinUrl('https://api.x.ai/v1', '/chat/completions')).toBe('https://api.x.ai/v1/chat/completions');
    expect(joinUrl('https://api.x.ai/v1///', '/chat/completions')).toBe('https://api.x.ai/v1/chat/completions');
  });
});
