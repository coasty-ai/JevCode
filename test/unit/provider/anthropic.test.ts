import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, JevCodeError, ProviderHttpError } from '../../../src/errors.js';
import { IdleTimeoutError, MAX_MESSAGE_CHARS } from '../../../src/provider/sse.js';
import { ANTHROPIC_VERSION, buildAnthropicBody, createAnthropicProvider } from '../../../src/provider/anthropic.js';
import type { AnthropicRequestBody, GenerateRequestExt } from '../../../src/provider/types.js';
import { PROPOSE_TOOL, anthropicCfg, fixture, genOpts, request, scriptedFetch, splitEvery, testDeps } from './helpers.js';

const sse = (name: string, headers: Record<string, string> = {}) => ({ status: 200, headers: { 'content-type': 'text/event-stream', ...headers }, body: fixture(name) });

describe('createAnthropicProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams a text-only reply, reports usage/cost/model/stopReason and sends the documented headers', async () => {
    const f = scriptedFetch([sse('anthropic-text.sse')]);
    const { deps } = testDeps(f.fetch);
    const p = createAnthropicProvider(anthropicCfg(), deps);
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-sonnet-5');
    const deltas: string[] = [];
    const res = await p.generate(request(), genOpts({ onDelta: (t) => deltas.push(t) }));
    expect(deltas).toEqual(['Hello', ', world', '!']);
    expect(res.text).toBe('Hello, world!');
    expect(res.toolCalls).toEqual([]);
    expect(res.model).toBe('claude-sonnet-5');
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 475, outputTokens: 16, costUsd: (475 * 2 + 16 * 10) / 1e6, calls: 1 });
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(f.calls.length).toBe(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe(anthropicCfg().apiKey);
    expect(call.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 512, stream: true, messages: [{ role: 'user', content: 'Fix the bug.' }] });
    expect(call.body['system']).toEqual([{ type: 'text', text: 'You are the generator.', cache_control: { type: 'ephemeral' } }]);
    expect('temperature' in call.body).toBe(false);
    expect('tools' in call.body).toBe(false);
  });

  it('accumulates a tool_use input across partial_json deltas (arbitrary chunking) and prices cache tokens', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('anthropic-tool.sse'), 11) }]);
    const { deps } = testDeps(f.fetch);
    const p = createAnthropicProvider(anthropicCfg(), deps);
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    const res = await p.generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }), genOpts({ onDelta: (t) => deltas.push(t), onToolDelta: (t) => toolDeltas.push(t) }));
    expect(deltas).toEqual(['I will edit the file.']);
    expect(res.text).toBe('I will edit the file.');
    expect(toolDeltas.length).toBe(3);
    expect(res.toolCalls.length).toBe(1);
    const tc = res.toolCalls[0]!;
    expect(tc.name).toBe('propose_action');
    expect(tc.rawJson).toBe(toolDeltas.join(''));
    expect(tc.input).toEqual({
      goal: 'fix the off-by-one',
      action: { kind: 'edit', path: 'src/a.py', old: 'i < n', new: 'i <= n' },
      plan: { done: [], remaining: ['run tests'], openProblems: [] },
    });
    expect(res.stopReason).toBe('tool_use');
    // input 120 (uncached) + cache write 1500 + cache read 2400; output 51
    expect(res.usage.inputTokens).toBe(120 + 1500 + 2400);
    expect(res.usage.outputTokens).toBe(51);
    expect(res.usage.costUsd).toBeCloseTo((120 * 2 + 2400 * 0.2 + 1500 * 2.5 + 51 * 10) / 1e6, 12);

    const body = f.calls[0]!.body as unknown as AnthropicRequestBody;
    expect(body.tools).toEqual([{ name: 'propose_action', description: PROPOSE_TOOL.description, input_schema: PROPOSE_TOOL.inputSchema, strict: true, eager_input_streaming: true, cache_control: { type: 'ephemeral' } }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'propose_action', disable_parallel_tool_use: true });
  });

  it('maps toolChoice auto/required and places cache_control only on the last tool', () => {
    const cfg = anthropicCfg();
    const two = [PROPOSE_TOOL, { ...PROPOSE_TOOL, name: 'other' }];
    expect(buildAnthropicBody(cfg, request({ tools: two, toolChoice: 'auto' })).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    const b = buildAnthropicBody(cfg, request({ tools: two, toolChoice: 'required' }));
    expect(b.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    expect(b.tools![0]!.cache_control).toBeUndefined();
    expect(b.tools![1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(buildAnthropicBody(cfg, request({ toolChoice: 'auto' })).tool_choice).toBeUndefined();
    expect(buildAnthropicBody(cfg, request({ system: '' })).system).toBeUndefined();
  });

  it('omits temperature when the request says null (even if config has a number) and includes it when set', () => {
    const cfg = anthropicCfg();
    expect('temperature' in buildAnthropicBody(cfg, request({ temperature: null }))).toBe(false);
    expect(buildAnthropicBody(cfg, request({ temperature: 0 })).temperature).toBe(0);
    expect(buildAnthropicBody(cfg, request({ temperature: 0.7 })).temperature).toBe(0.7);
    // GenerateRequest.temperature is the effective value the engine already resolved; null = do not send.
    expect('temperature' in buildAnthropicBody(anthropicCfg({ temperature: 1 }), request({ temperature: null }))).toBe(false);
    expect(buildAnthropicBody(anthropicCfg({ temperature: null }), request({ temperature: 1 })).temperature).toBe(1);
  });

  it('ignores the OpenRouter-side request fields seed / reasoning / providerPrefs (LLM-JEV-DESIGN §4.12)', () => {
    const cfg = anthropicCfg();
    const base = request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } });
    const withExt: GenerateRequestExt = { ...base, seed: 7, reasoning: { enabled: true, effort: 'low' }, providerPrefs: { requireParameters: true, order: ['anthropic'] } };
    const body = buildAnthropicBody(cfg, withExt);
    expect(body).toEqual(buildAnthropicBody(cfg, base));
    const keys = Object.keys(JSON.parse(JSON.stringify(body)) as object);
    expect(keys).not.toContain('seed');
    expect(keys).not.toContain('reasoning');
    expect(keys).not.toContain('provider');
    expect(keys).not.toContain('thinking');
  });

  it('retries a 529 once (backoff, redacted body) and succeeds on the second attempt', async () => {
    const f = scriptedFetch([{ status: 529, headers: { 'content-type': 'application/json' }, body: fixture('anthropic-529.json') }, sse('anthropic-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const res = await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts());
    expect(res.text).toBe('Hello, world!');
    expect(f.calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('honours Retry-After on a 429 and gives up after three attempts with the last error', async () => {
    const f = scriptedFetch([
      { status: 429, headers: { 'retry-after': '2' }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' },
      { status: 500, body: '{"type":"error","error":{"type":"api_error","message":"boom"}}' },
      { status: 503, body: 'upstream unavailable' },
    ]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const err = await createAnthropicProvider(anthropicCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    const e = err as ProviderHttpError;
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.body).toBe('upstream unavailable');
    expect(f.calls.length).toBe(3);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it('does not retry a 400 and exposes type, message and redacted body', async () => {
    const f = scriptedFetch([{ status: 400, body: fixture('anthropic-400.json') }]);
    const { deps, sleeps } = testDeps(f.fetch);
    const err = await createAnthropicProvider(anthropicCfg(), deps)
      .generate(request({ temperature: 0.3 }), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    const e = err as ProviderHttpError;
    expect(e.status).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('anthropic HTTP 400 invalid_request_error');
    expect(e.message).toContain('temperature');
    expect(e.code).toBe('provider_http');
    expect(e.exitCode).toBe(5);
    expect(f.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it.each([401, 403, 404, 402, 413])('does not retry %i', async (status) => {
    const f = scriptedFetch([{ status, body: '{"type":"error","error":{"type":"x","message":"y"}}' }]);
    const { deps } = testDeps(f.fetch);
    await expect(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status, retryable: false });
    expect(f.calls.length).toBe(1);
  });

  it('does not retry a spend-limit 429 that carries no retry-after', async () => {
    const f = scriptedFetch([{ status: 429, body: fixture('anthropic-429-spend-limit.json') }]);
    const { deps } = testDeps(f.fetch);
    await expect(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status: 429, retryable: false });
    expect(f.calls.length).toBe(1);
  });

  it('redacts the API key if it ever appears in an error body', async () => {
    const key = anthropicCfg().apiKey;
    const f = scriptedFetch([{ status: 401, body: `{"type":"error","error":{"type":"authentication_error","message":"bad key ${key}"}}` }]);
    const { deps } = testDeps(f.fetch);
    const err = (await createAnthropicProvider(anthropicCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.message).not.toContain(key);
    expect(err.body).not.toContain(key);
    expect(err.message).toContain('[REDACTED:pattern]');
  });

  it('treats an `event: error` after HTTP 200 like its status (529 → retry) and a network error as retryable', async () => {
    const f = scriptedFetch([sse('anthropic-stream-error.sse'), { status: 0, networkError: 'fetch failed' }, sse('anthropic-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const res = await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts());
    expect(res.text).toBe('Hello, world!');
    expect(f.calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('treats a stream cut before message_delta as a retryable transport failure', async () => {
    const cut = fixture('anthropic-text.sse').split('event: message_delta')[0]!;
    const f = scriptedFetch([{ status: 200, body: cut }, { status: 200, body: cut }, { status: 200, body: cut }]);
    const { deps } = testDeps(f.fetch);
    await expect(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status: 0, retryable: true });
    expect(f.calls.length).toBe(3);
  });

  it('stops the stream on abort and rethrows signal.reason without retrying', async () => {
    const head = fixture('anthropic-text.sse').split('event: content_block_stop')[0]!;
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = testDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const deltas: string[] = [];
    const p = createAnthropicProvider(anthropicCfg(), deps).generate(
      request(),
      genOpts({
        signal: ac.signal,
        onDelta: (t) => {
          deltas.push(t);
          if (deltas.length === 3) ac.abort(reason);
        },
      }),
    );
    await expect(p).rejects.toBe(reason);
    expect(deltas).toEqual(['Hello', ', world', '!']);
    expect(f.streams[0]!.cancelled()).toBe(true);
    expect(f.calls.length).toBe(1);
  });

  it('rejects an already-aborted signal before fetching', async () => {
    const f = scriptedFetch([]);
    const { deps } = testDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('signal');
    ac.abort(reason);
    await expect(createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts({ signal: ac.signal }))).rejects.toBe(reason);
    expect(f.calls.length).toBe(0);
  });

  it('keeps an unparsable (truncated) tool input as input null with the raw text', async () => {
    const t = fixture('anthropic-tool.sse').replace(/event: content_block_delta\ndata: \{"type":"content_block_delta","index":1,"delta":\{"type":"input_json_delta","partial_json":"\\"plan\\".*?\n\n/s, '').replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"');
    const f = scriptedFetch([{ status: 200, body: t }]);
    const { deps } = testDeps(f.fetch);
    const res = await createAnthropicProvider(anthropicCfg(), deps).generate(request({ tools: [PROPOSE_TOOL] }), genOpts());
    expect(res.stopReason).toBe('max_tokens');
    expect(res.toolCalls[0]!.input).toBeNull();
    expect(res.toolCalls[0]!.rawJson.startsWith('{"goal"')).toBe(true);
    expect(res.usage.outputTokens).toBe(51);
  });

  it('validates the request shape before spending', async () => {
    const f = scriptedFetch([]);
    const { deps } = testDeps(f.fetch);
    const p = createAnthropicProvider(anthropicCfg(), deps);
    await expect(p.generate(request({ maxTokens: 0 }), genOpts())).rejects.toMatchObject({ retryable: false });
    await expect(p.generate(request({ messages: [] }), genOpts())).rejects.toMatchObject({ retryable: false });
    await expect(p.generate(request({ temperature: Number.NaN }), genOpts())).rejects.toMatchObject({ retryable: false });
    expect(f.calls.length).toBe(0);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const f = scriptedFetch([sse('anthropic-text.sse')]);
    const { deps } = testDeps(f.fetch);
    await createAnthropicProvider(anthropicCfg({ baseUrl: 'https://proxy.example/' }), deps).generate(request(), genOpts());
    expect(f.calls[0]!.url).toBe('https://proxy.example/v1/messages');
  });

  it('does not retry or re-bill when a renderer callback throws; the error keeps its class', async () => {
    const f = scriptedFetch([sse('anthropic-text.sse'), sse('anthropic-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch);
    const err = await createAnthropicProvider(anthropicCfg(), deps)
      .generate(
        request(),
        genOpts({
          onDelta: () => {
            throw new RangeError('renderer bug');
          },
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevCodeError);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect((err as JevCodeError).code).toBe('internal');
    expect((err as JevCodeError).cause).toBeInstanceOf(RangeError);
    expect(f.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('bounds Error.message even when the server sends a huge error message', async () => {
    const huge = 'x'.repeat(20_000);
    const f = scriptedFetch([{ status: 400, body: `{"type":"error","error":{"type":"invalid_request_error","message":"${huge}"}}` }]);
    const { deps } = testDeps(f.fetch);
    const err = (await createAnthropicProvider(anthropicCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.status).toBe(400);
    expect(err.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(err.body.length).toBeLessThanOrEqual(2048);
  });

  it('retries as a network error when the stream goes idle for 60 s (fake timers), then succeeds', async () => {
    vi.useFakeTimers();
    const head = fixture('anthropic-text.sse').split('event: content_block_stop')[0]!;
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }, sse('anthropic-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const deltas: string[] = [];
    const p = createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts({ onDelta: (t) => deltas.push(t) }));
    const settled = p.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const out = await settled;
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.r.text).toBe('Hello, world!');
    expect(f.calls.length).toBe(2);
    expect(f.streams[0]!.cancelled()).toBe(true);
    expect(sleeps).toEqual([500]);
    // the retried attempt re-streams (known open issue: GenerateOptions has no onRetry hook)
    expect(deltas.slice(0, 3)).toEqual(['Hello', ', world', '!']);
  });

  it('gives up with a first_byte IdleTimeoutError when the server never answers the request (fake timers)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const never: typeof fetch = (_input, init) =>
      new Promise<Response>((_, reject) => {
        calls++;
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const { deps, sleeps } = testDeps(never, 0);
    const p = createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts());
    const settled = p.then(
      () => null,
      (e: unknown) => e,
    );
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(30_000);
    const err = await settled;
    expect(err).toBeInstanceOf(IdleTimeoutError);
    expect((err as IdleTimeoutError).phase).toBe('first_byte');
    expect((err as IdleTimeoutError).retryable).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });
});
