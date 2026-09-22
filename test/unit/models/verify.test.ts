/** The one-request key check: which endpoint, what it reports, and what it must never leak. */
import { describe, expect, it } from 'vitest';
import { verifyProvider, verifyProviders } from '../../../src/models/verify.js';
import { T0, fixture, routedFetch, scriptedFetch, testDeps } from './helpers.js';

describe('verifyProvider', () => {
  it('lists models for a provider whose catalogue needs the key, and counts them', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('anthropic-models.json') }]);
    let t = T0;
    const res = await verifyProvider({ provider: 'anthropic' }, 'sk-ant-key', testDeps({ fetch: f.fetch, now: () => (t += 20) }));
    expect(res).toEqual({ ok: true, provider: 'anthropic', latencyMs: 20, via: 'models', modelCount: 4 });
    expect(f.calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(f.calls[0]?.headers['x-api-key']).toBe('sk-ant-key');
  });

  it('uses the key endpoint for OpenRouter, whose model list answers unauthenticated', async () => {
    const f = scriptedFetch([{ status: 200, body: { data: { label: 'sk-or-v1-11d...94c', usage: 99.1, limit: null } } }]);
    const res = await verifyProvider({ provider: 'openrouter' }, 'sk-or-v1-key', testDeps({ fetch: f.fetch }));
    expect(f.calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(res.ok).toBe(true);
    expect(res.via).toBe('key');
    expect(res.modelCount).toBeUndefined();
    // the /key body carries a masked key label and account usage: none of it may escape
    expect(JSON.stringify(res)).not.toContain('sk-or-v1');
    expect(JSON.stringify(res)).not.toContain('99.1');
  });

  it('uses the key endpoint for xAI', async () => {
    const f = scriptedFetch([{ status: 200, body: { redacted_api_key: 'xai-...jRpB', name: 'team' } }]);
    const res = await verifyProvider({ provider: 'xai' }, 'xai-key', testDeps({ fetch: f.fetch }));
    expect(f.calls[0]?.url).toBe('https://api.x.ai/v1/api-key');
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('xai-');
  });

  it('reports a rejected key as an auth failure with the provider message', async () => {
    const f = scriptedFetch([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'API key is invalid.' } } }]);
    const res = await verifyProvider({ provider: 'anthropic' }, 'sk-bad', testDeps({ fetch: f.fetch }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('auth');
    expect(res.error?.status).toBe(401);
    expect(res.error?.message).toContain('API key is invalid');
  });

  it('never retries — a key check answers in one round trip', async () => {
    const f = scriptedFetch([{ status: 429, body: { error: { message: 'slow down' } } }]);
    const res = await verifyProvider({ provider: 'openai' }, 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(1);
    expect(res.error?.kind).toBe('rate_limit');
  });

  it('reports a transport failure without throwing', async () => {
    const f = scriptedFetch([{ status: 0, networkError: 'getaddrinfo ENOTFOUND api.openai.com' }]);
    const res = await verifyProvider({ provider: 'openai' }, 'k', testDeps({ fetch: f.fetch }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('network');
  });

  it('redacts a key that appears in the failure text', async () => {
    const f = scriptedFetch([{ status: 401, body: { error: { message: 'Incorrect API key provided: sk-abcdefgh12345678' } } }]);
    const res = await verifyProvider({ provider: 'openai' }, 'sk-abcdefgh12345678', testDeps({ fetch: f.fetch }));
    expect(res.error?.message).toContain('[REDACTED:pattern]');
    expect(res.error?.message).not.toContain('sk-abcdefgh12345678');
  });

  it('sends nothing at all without a key', async () => {
    const f = scriptedFetch([]);
    const res = await verifyProvider({ provider: 'openai' }, '   ', testDeps({ fetch: f.fetch }));
    expect(f.calls).toHaveLength(0);
    expect(res).toEqual({ ok: false, provider: 'openai', latencyMs: 0, via: 'none', error: { kind: 'no_key', status: null, message: 'openai: no API key', retryable: false } });
  });

  it('honours a custom base URL', async () => {
    const f = scriptedFetch([{ status: 200, body: { object: 'list', data: [] } }]);
    await verifyProvider({ provider: 'openai', baseUrl: 'https://gateway.internal/v1' }, 'k', testDeps({ fetch: f.fetch }));
    expect(f.calls[0]?.url).toBe('https://gateway.internal/v1/models');
  });

  it('flags a 200 that is not JSON', async () => {
    const f = scriptedFetch([{ status: 200, body: 'not json', headers: { 'content-type': 'text/plain' } }]);
    const res = await verifyProvider({ provider: 'openai' }, 'k', testDeps({ fetch: f.fetch }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('invalid');
  });
});

describe('verifyProviders', () => {
  it('checks several keys in parallel and skips blank ones', async () => {
    const f = routedFetch({
      'api.anthropic.com': { status: 200, body: fixture('anthropic-models.json') },
      'openrouter.ai': { status: 401, body: { error: { message: 'no' } } },
    });
    const results = await verifyProviders({ anthropic: 'a', openrouter: 'b', openai: '  ' }, testDeps({ fetch: f.fetch }));
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.provider === 'anthropic')?.ok).toBe(true);
    expect(results.find((r) => r.provider === 'openrouter')?.ok).toBe(false);
  });
});
