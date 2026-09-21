/** Offline test doubles for provider/*: byte streams, a scripted fetch, fixtures. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerateOptions, GenerateRequest, GeneratorConfig, ToolSpec } from '../../../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'fixtures', 'provider');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Split a transcript into fixed-size pieces so chunk boundaries fall inside events, lines and UTF-8 sequences. */
export function splitEvery(text: string, n: number): Uint8Array[] {
  const bytes = encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += n) out.push(bytes.subarray(i, i + n));
  return out;
}

export interface StreamControl {
  stream: ReadableStream<Uint8Array>;
  /** push another chunk (only for streams created with `hang: true`) */
  push: (chunk: string | Uint8Array) => void;
  close: () => void;
  cancelled: () => boolean;
}

/** A body stream; with `hang` it stays open after the initial chunks until close() is called. */
export function bodyStream(chunks: (string | Uint8Array)[], hang = false): StreamControl {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? encode(ch) : ch);
      if (!hang) {
        c.close();
        closed = true;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (ch) => {
      if (!closed && !cancelled) controller?.enqueue(typeof ch === 'string' ? encode(ch) : ch);
    },
    close: () => {
      if (!closed && !cancelled) {
        closed = true;
        controller?.close();
      }
    },
    cancelled: () => cancelled,
  };
}

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | (string | Uint8Array)[];
  /** keep the body open after the chunks (abort / idle tests) */
  hang?: boolean;
  /** reject the fetch itself (network error) */
  networkError?: string;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface ScriptedFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
  streams: StreamControl[];
}

/** A fetch that answers from a script, recording every request (parsed body + lower-cased headers). */
export function scriptedFetch(script: ScriptedResponse[]): ScriptedFetch {
  const calls: FetchCall[] = [];
  const streams: StreamControl[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const idx = calls.length;
    const rawHeaders = init?.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init: init ?? {}, body, headers });
    const r = script[idx];
    if (!r) throw new Error(`scriptedFetch: no response scripted for call ${idx + 1}`);
    if (r.networkError !== undefined) throw new TypeError(r.networkError);
    const chunks = r.body === undefined ? [] : typeof r.body === 'string' ? [r.body] : r.body;
    const control = bodyStream(chunks, r.hang ?? false);
    streams.push(control);
    const signal = init?.signal;
    if (signal) {
      const onAbort = (): void => {
        // a real fetch tears the body down on abort; mirror that so hung streams end
        control.stream.cancel().catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return new Response(control.stream, { status: r.status, headers: r.headers ?? {} });
  };
  return { fetch: fetchImpl as typeof fetch, calls, streams };
}

export const PRICING: GeneratorConfig['pricing'] = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
/** The default generator's rates (config/defaults.ts, OpenRouter models API 2026-09-21). */
export const GLM_PRICING: GeneratorConfig['pricing'] = { inputPerM: 0.09, outputPerM: 0.3, cacheReadPerM: 0.018, cacheWritePerM: 0.1125 };

export function anthropicCfg(over: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-test-key-000000000000000000000000', baseUrl: 'https://api.anthropic.com', temperature: null, maxTokens: 4096, pricing: PRICING, ...over };
}

export function openrouterCfg(over: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', apiKey: 'sk-or-v1-testkey000000000000000000000000000000', baseUrl: 'https://openrouter.ai/api/v1', temperature: null, maxTokens: 4096, pricing: PRICING, ...over };
}

export function request(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return { system: 'You are the generator.', messages: [{ role: 'user', content: 'Fix the bug.' }], maxTokens: 512, temperature: null, ...over };
}

export const PROPOSE_TOOL: ToolSpec = {
  name: 'propose_action',
  description: 'Propose exactly one action.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'action', 'plan'],
    properties: {
      goal: { type: 'string' },
      action: { type: 'object', additionalProperties: false, required: ['kind', 'command'], properties: { kind: { type: 'string', enum: ['run'] }, command: { type: 'string' } } },
      plan: { type: 'object', additionalProperties: false, required: ['done', 'remaining', 'openProblems'], properties: { done: { type: 'array', items: { type: 'string' } }, remaining: { type: 'array', items: { type: 'string' } }, openProblems: { type: 'array', items: { type: 'string' } } } },
    },
  },
};

/** Deps that make retries instant and jitter deterministic; sleeps are recorded. */
export function testDeps(fetchImpl: typeof fetch, random = 0): { deps: { fetch: typeof fetch; redact: (s: string) => string; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; random: () => number; now: () => number }; sleeps: number[] } {
  const sleeps: number[] = [];
  let t = 0;
  return {
    sleeps,
    deps: {
      fetch: fetchImpl,
      redact: (s: string) => s.replace(/sk-(ant|or-v1)-[A-Za-z0-9_-]{20,}/g, '[REDACTED:pattern]'),
      sleep: async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw signal.reason;
        sleeps.push(ms);
      },
      random: () => random,
      now: () => (t += 7),
    },
  };
}

export function genOpts(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { signal: new AbortController().signal, ...over };
}
