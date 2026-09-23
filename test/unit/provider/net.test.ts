/**
 * provider/net.ts — the session-start connection prewarm (network map P5): one ANONYMOUS GET to the generator's own
 * origin, body read to the end and discarded, never under --mock / --no-network / the no-network assertion / a test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineMode } from '../../../src/core/types.js';
import { PREWARM_BODY_BYTES, PREWARM_PATH, prewarm, prewarmGenerator, prewarmSkip, prewarmUrl, type PrewarmConfig } from '../../../src/provider/net.js';
import { PROVIDER_BASE_URL, type ProviderId } from '../../../src/provider/ids.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { openrouterCfg, request } from './helpers.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  port: number;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** 401 JSON on the prewarm path (what the real APIs answer without a key), an OpenRouter stream on /chat/completions */
async function origin(o: { keyBody?: string } = {}): Promise<{ base: string; seen: Seen[]; connections: () => number }> {
  const seen: Seen[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, port: req.socket.remotePort ?? -1 });
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.0001}}\n\n');
        res.write('data: [DONE]\n\n');
        setTimeout(() => res.end(), 10);
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(o.keyBody ?? '{"error":{"message":"No auth credentials found","code":401}}');
    });
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, connections: () => connections };
}

function config(over: Partial<PrewarmConfig> & { baseUrl?: string } = {}): PrewarmConfig {
  return {
    noNetwork: over.noNetwork ?? false,
    missingSecrets: over.missingSecrets ?? (() => []),
    generator: over.generator ?? (() => ({ provider: 'openrouter', baseUrl: over.baseUrl ?? 'https://openrouter.ai/api/v1' })),
  };
}

const WHEN = { mode: 'llm-jev' as EngineMode, mock: false, offline: false };

describe('prewarmUrl', () => {
  it('lands on the generation origin of every provider (the base URL the adapter itself appends to)', () => {
    const ids = Object.keys(PROVIDER_BASE_URL) as ProviderId[];
    for (const id of ids) {
      const url = prewarmUrl({ provider: id, baseUrl: PROVIDER_BASE_URL[id] });
      expect(url).toBe(`${PROVIDER_BASE_URL[id]}${PREWARM_PATH[id]}`);
      expect(new URL(url!).origin).toBe(new URL(PROVIDER_BASE_URL[id]).origin);
    }
    expect(prewarmUrl({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/' })).toBe('https://openrouter.ai/api/v1/key');
    expect(prewarmUrl({ provider: 'openrouter', baseUrl: 'unix:/tmp/sock' })).toBeNull();
  });
});

describe('prewarm', () => {
  it('sends ONE anonymous GET (no key, no auth header), reads the 401 to its end, and the next generation reuses that socket', async () => {
    const o = await origin();
    const out = await prewarm({ provider: 'openrouter', baseUrl: `${o.base}/api/v1` }, new AbortController().signal);
    expect(out).toEqual({ kind: 'warmed', status: 401 });
    expect(o.seen).toHaveLength(1);
    expect(o.seen[0]!.method).toBe('GET');
    expect(o.seen[0]!.url).toBe('/api/v1/key');
    expect(o.seen[0]!.headers['authorization']).toBeUndefined();
    expect(o.seen[0]!.headers['x-api-key']).toBeUndefined();

    const cfg = openrouterCfg({ baseUrl: `${o.base}/api/v1`, priced: true });
    const r = await createOpenRouterProvider(cfg, { redact: (s) => s }).generate(request(), { signal: new AbortController().signal });
    expect(r.text).toBe('hi');
    // the generation carried the key; the prewarm never did
    expect(o.seen[1]!.headers['authorization']).toBe(`Bearer ${cfg.apiKey}`);
    expect(o.seen[1]!.port).toBe(o.seen[0]!.port);
    expect(o.connections()).toBe(1);
  });

  it('never throws: a refused connection, a throwing fetch and an abort are all just `failed`', async () => {
    expect(await prewarm({ provider: 'openrouter', baseUrl: 'http://127.0.0.1:9/api/v1' }, new AbortController().signal)).toEqual({ kind: 'failed' });
    const throwing = (() => {
      throw new Error('network before first frame: https://openrouter.ai/api/v1/key');
    }) as unknown as typeof fetch;
    expect(await prewarm({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }, new AbortController().signal, { fetch: throwing })).toEqual({ kind: 'failed' });
    const o = await origin();
    const ac = new AbortController();
    ac.abort(new Error('session over'));
    expect(await prewarm({ provider: 'openrouter', baseUrl: `${o.base}/api/v1` }, ac.signal)).toEqual({ kind: 'failed' });
  });

  it('an oversized answer is cut at PREWARM_BODY_BYTES (the socket is dropped, nothing else)', async () => {
    const o = await origin({ keyBody: 'x'.repeat(PREWARM_BODY_BYTES * 4) });
    expect(await prewarm({ provider: 'openrouter', baseUrl: `${o.base}/api/v1` }, new AbortController().signal)).toEqual({ kind: 'warmed', status: 401 });
  });
});

describe('prewarmSkip / prewarmGenerator', () => {
  const none: NodeJS.ProcessEnv = {};

  it('skips under --mock, --no-network, the no-network assertion, a test, jev-only and without a generator key', () => {
    expect(prewarmSkip(config(), { ...WHEN, mock: true }, none)).toBe('mock');
    expect(prewarmSkip(config({ noNetwork: true }), WHEN, none)).toBe('no-network');
    expect(prewarmSkip(config(), { ...WHEN, offline: true }, none)).toBe('no-network');
    expect(prewarmSkip(config(), WHEN, { VITEST: 'true' })).toBe('test');
    expect(prewarmSkip(config(), { ...WHEN, mode: 'jev-only' }, none)).toBe('jev-only');
    expect(prewarmSkip(config({ missingSecrets: () => ['generator.apiKey'] }), WHEN, none)).toBe('no-key');
    // a missing JEV key does not matter: the socket is the generator's
    expect(prewarmSkip(config({ missingSecrets: () => ['decider.apiKey'] }), WHEN, none)).toBeNull();
    expect(prewarmSkip(config(), WHEN, none)).toBeNull();
  });

  it('this very test process is a test: with the real environment nothing goes out', async () => {
    let calls = 0;
    const spy = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    expect(await prewarmGenerator(config(), WHEN, { fetch: spy })).toEqual({ kind: 'skipped', reason: 'test' });
    expect(calls).toBe(0);
  });

  it('fires one GET at the configured origin when allowed; an invalid generator section is simply no target', async () => {
    const urls: string[] = [];
    const spy = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response('{"error":{"code":401}}', { status: 401 });
    }) as typeof fetch;
    expect(await prewarmGenerator(config(), WHEN, { fetch: spy, processEnv: none })).toEqual({ kind: 'warmed', status: 401 });
    expect(urls).toEqual(['https://openrouter.ai/api/v1/key']);
    const broken = config({
      generator: () => {
        throw new Error('generator.model: not set');
      },
    });
    expect(await prewarmGenerator(broken, WHEN, { fetch: spy, processEnv: none })).toEqual({ kind: 'skipped', reason: 'no-target' });
    expect(await prewarmGenerator(config(), { ...WHEN, mock: true }, { fetch: spy, processEnv: none })).toEqual({ kind: 'skipped', reason: 'mock' });
    expect(urls).toHaveLength(1);
  });
});
