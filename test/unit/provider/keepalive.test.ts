/**
 * Keep-alive on the success path (network map 2026-09-23; sse.ts `drainToEof`). Every adapter stops reading at its
 * terminal record (`data: [DONE]`, `message_stop`), and cancelling the body there made undici destroy the socket, so
 * every request paid a fresh connect. These tests drive the REAL adapters through Node's global fetch against a local
 * node:http server that sends its terminal record and only then — a beat later, as a real gateway does — the chunked
 * terminator, and count the TCP connections the server accepted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { createFireworksProvider } from '../../../src/provider/fireworks.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { DRAIN_MS } from '../../../src/provider/sse.js';
import type { Provider } from '../../../src/core/types.js';
import { PRICING, anthropicCfg, openrouterCfg, request } from './helpers.js';

interface Local {
  base: string;
  /** TCP connections the server accepted */
  connections: () => number;
  /** the client port each request arrived from, in order: one port for two requests = one reused connection */
  ports: () => readonly number[];
  requests: () => number;
  close: () => Promise<void>;
}

/** how the server ends a response after its terminal record: `end` after `tailMs`, or never (`hold`) */
type Ending = { kind: 'end'; tailMs: number } | { kind: 'hold' };

const open: Local[] = [];

async function sseServer(frames: readonly string[], ending: Ending): Promise<Local> {
  let connections = 0;
  const ports: number[] = [];
  const server = http.createServer((req, res) => {
    ports.push(req.socket.remotePort ?? -1);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // one write per frame, so the terminal record is its own chunk
      for (const f of frames) res.write(f);
      if (ending.kind === 'end') setTimeout(() => res.end(), ending.tailMs);
    });
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const local: Local = {
    base: `http://127.0.0.1:${port}`,
    connections: () => connections,
    ports: () => ports,
    requests: () => ports.length,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  open.push(local);
  return local;
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

const OPENROUTER_FRAMES = [
  'data: {"id":"gen-1","provider":"Local","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.0001}}\n\n',
  'data: [DONE]\n\n',
];

const ANTHROPIC_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const redact = (s: string): string => s;

function openrouter(local: Local): Provider {
  return createOpenRouterProvider(openrouterCfg({ baseUrl: `${local.base}/api/v1`, priced: true }), { redact });
}

async function twice(p: Provider): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 2; i++) out.push((await p.generate(request(), { signal: new AbortController().signal })).text);
  return out;
}

describe('keep-alive: a finished stream leaves its socket in the pool', () => {
  it('openrouter: two sequential generate() calls ride ONE connection', async () => {
    const local = await sseServer(OPENROUTER_FRAMES, { kind: 'end', tailMs: 20 });
    expect(await twice(openrouter(local))).toEqual(['hi', 'hi']);
    expect(local.requests()).toBe(2);
    expect(new Set(local.ports()).size).toBe(1);
    expect(local.connections()).toBe(1);
  });

  it('openai-compatible (fireworks quirks): ONE connection for two calls', async () => {
    const local = await sseServer(OPENROUTER_FRAMES, { kind: 'end', tailMs: 20 });
    const p = createFireworksProvider({ model: 'accounts/fireworks/models/glm-5p3', apiKey: 'fw_test0000000000000000000000', baseUrl: `${local.base}/inference/v1`, temperature: null, maxTokens: 512, pricing: PRICING, priced: true }, { redact });
    expect(await twice(p)).toEqual(['hi', 'hi']);
    expect(local.connections()).toBe(1);
  });

  it('anthropic: ONE connection for two calls (the stream ends after message_stop)', async () => {
    const local = await sseServer(ANTHROPIC_FRAMES, { kind: 'end', tailMs: 20 });
    const p = createAnthropicProvider(anthropicCfg({ baseUrl: local.base }), { redact });
    expect(await twice(p)).toEqual(['hi', 'hi']);
    expect(local.connections()).toBe(1);
  });

  it('a server that holds the stream open after [DONE] costs at most DRAIN_MS, and that socket is not reused', async () => {
    const local = await sseServer(OPENROUTER_FRAMES, { kind: 'hold' });
    const p = openrouter(local);
    const t0 = performance.now();
    const r = await p.generate(request(), { signal: new AbortController().signal });
    const ms = performance.now() - t0;
    expect(r.text).toBe('hi');
    expect(ms).toBeGreaterThanOrEqual(DRAIN_MS - 20);
    expect(ms).toBeLessThan(DRAIN_MS + 750);
    await p.generate(request(), { signal: new AbortController().signal });
    const [first, second] = local.ports();
    expect(local.requests()).toBe(2);
    expect(second).not.toBe(first);
  });

  it('an abort during the drain ends it at once; the finished result still stands', async () => {
    const local = await sseServer(OPENROUTER_FRAMES, { kind: 'hold' });
    const ac = new AbortController();
    let abortedAt = 0;
    const abort = (): void => {
      abortedAt = performance.now();
      ac.abort(new Error('stop'));
    };
    // the text is complete before the abort lands: [DONE] arrived, only the drain is left
    const r = await openrouter(local).generate(request(), { signal: ac.signal, onDelta: () => setTimeout(abort, 30) });
    expect(r.text).toBe('hi');
    expect(abortedAt).toBeGreaterThan(0);
    expect(performance.now() - abortedAt).toBeLessThan(DRAIN_MS / 2);
  });
});
