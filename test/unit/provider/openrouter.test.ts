import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, JevCodeError, ProviderHttpError } from '../../../src/errors.js';
import { MAX_MESSAGE_CHARS } from '../../../src/provider/sse.js';
import { OPENROUTER_REFERER, OPENROUTER_TITLE, buildOpenRouterBody, createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import type { OpenRouterRequestBody } from '../../../src/provider/types.js';
import { PROPOSE_TOOL, fixture, genOpts, openrouterCfg, request, scriptedFetch, splitEvery, testDeps } from './helpers.js';

const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('createOpenRouterProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams text, skips ": OPENROUTER PROCESSING" comments, takes usage.cost over pricing and sends attribution headers', async () => {
    const f = scriptedFetch([sse('openrouter-text.sse')]);
    const { deps } = testDeps(f.fetch);
    const p = createOpenRouterProvider(openrouterCfg(), deps);
    expect(p.name).toBe('openrouter');
    const deltas: string[] = [];
    const res = await p.generate(request(), genOpts({ onDelta: (t) => deltas.push(t) }));
    expect(deltas).toEqual(['I', ' am ready.']);
    expect(res.text).toBe('I am ready.');
    expect(res.toolCalls).toEqual([]);
    expect(res.model).toBe('anthropic/claude-sonnet-5');
    expect(res.stopReason).toBe('stop');
    // usage.cost (0.001288) wins over the pricing table (which would give 0.001288 too here, so perturb the table)
    expect(res.usage).toEqual({ inputTokens: 444, outputTokens: 40, costUsd: 0.001288, calls: 1 });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers['authorization']).toBe(`Bearer ${openrouterCfg().apiKey}`);
    expect(call.headers['http-referer']).toBe(OPENROUTER_REFERER);
    expect(call.headers['x-title']).toBe(OPENROUTER_TITLE);
    expect(call.body).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      stream: true,
      max_tokens: 512,
      usage: { include: true },
      messages: [
        { role: 'system', content: 'You are the generator.' },
        { role: 'user', content: 'Fix the bug.' },
      ],
    });
    expect('temperature' in call.body).toBe(false);
  });

  it('prefers usage.cost even when the pricing table disagrees', async () => {
    const f = scriptedFetch([sse('openrouter-text.sse')]);
    const { deps } = testDeps(f.fetch);
    const res = await createOpenRouterProvider(openrouterCfg({ pricing: { inputPerM: 100, outputPerM: 100, cacheReadPerM: 100, cacheWritePerM: 100 } }), deps).generate(request(), genOpts());
    expect(res.usage.costUsd).toBe(0.001288);
  });

  it('accumulates tool_calls arguments across chunks by index, and prices from the table when cost is null', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('openrouter-tool.sse'), 13) }]);
    const { deps } = testDeps(f.fetch);
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onDelta: (t) => deltas.push(t), onToolDelta: (t) => toolDeltas.push(t) }),
    );
    expect(deltas).toEqual(['Editing.']);
    expect(toolDeltas.length).toBe(3);
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.rawJson).toBe(toolDeltas.join(''));
    expect(res.toolCalls[0]!.input).toEqual({ goal: 'add test', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: [], openProblems: [] } });
    expect(res.stopReason).toBe('tool_calls');
    // prompt 1000 = 300 uncached + 600 cached read + 100 cache write; completion 100
    expect(res.usage.inputTokens).toBe(1000);
    expect(res.usage.outputTokens).toBe(100);
    expect(res.usage.costUsd).toBeCloseTo((300 * 2 + 600 * 0.2 + 100 * 2.5 + 100 * 10) / 1e6, 12);

    const body = f.calls[0]!.body as unknown as OpenRouterRequestBody;
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'propose_action', description: PROPOSE_TOOL.description, parameters: PROPOSE_TOOL.inputSchema, strict: true } }]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'propose_action' } });
  });

  it('maps toolChoice strings and temperature', () => {
    const cfg = openrouterCfg();
    expect(buildOpenRouterBody(cfg, request({ tools: [PROPOSE_TOOL], toolChoice: 'auto' })).tool_choice).toBe('auto');
    expect(buildOpenRouterBody(cfg, request({ tools: [PROPOSE_TOOL], toolChoice: 'required' })).tool_choice).toBe('required');
    expect(buildOpenRouterBody(cfg, request({ toolChoice: 'required' })).tool_choice).toBeUndefined();
    expect('temperature' in buildOpenRouterBody(cfg, request({ temperature: null }))).toBe(false);
    expect(buildOpenRouterBody(cfg, request({ temperature: 0.2 })).temperature).toBe(0.2);
    // the request's null is authoritative: config is not a fallback (Sonnet 5 400s on any sampling param)
    expect('temperature' in buildOpenRouterBody(openrouterCfg({ temperature: 0.5 }), request({ temperature: null }))).toBe(false);
    expect(buildOpenRouterBody(openrouterCfg({ temperature: null }), request({ temperature: 0.5 })).temperature).toBe(0.5);
    expect(buildOpenRouterBody(cfg, request({ system: '' })).messages[0]).toEqual({ role: 'user', content: 'Fix the bug.' });
  });

  it('does not retry a 402 and surfaces the OpenRouter error shape', async () => {
    const f = scriptedFetch([{ status: 402, headers: { 'content-type': 'application/json' }, body: fixture('openrouter-402.json') }]);
    const { deps, sleeps } = testDeps(f.fetch);
    const err = (await createOpenRouterProvider(openrouterCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e)) as ProviderHttpError;
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(402);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('openrouter HTTP 402 payment_required');
    expect(err.message).toContain('insufficient credits');
    expect(f.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries 429 and 5xx (Retry-After honoured, capped at 60 s) then succeeds', async () => {
    const f = scriptedFetch([
      { status: 429, headers: { 'retry-after': '1' }, body: '{"error":{"code":429,"message":"You are being rate limited","metadata":{"error_type":"rate_limit_exceeded"}}}' },
      { status: 503, headers: { 'retry-after': '3600' }, body: fixture('openrouter-503.json') },
      sse('openrouter-text.sse'),
    ]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts());
    expect(res.text).toBe('I am ready.');
    expect(f.calls.length).toBe(3);
    // 1 s from the header; the 3600 s header is out of range so the default backoff (1000 ms at n=1) applies
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('does not retry 400/401/403/404', async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = scriptedFetch([{ status, body: '{"error":{"message":"User not found.","code":401}}' }]);
      const { deps } = testDeps(f.fetch);
      await expect(createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status, retryable: false });
      expect(f.calls.length).toBe(1);
    }
  });

  it('handles a mid-stream error chunk (HTTP 200) as the embedded status and retries it', async () => {
    const f = scriptedFetch([sse('openrouter-midstream-error.sse'), sse('openrouter-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts());
    expect(res.text).toBe('I am ready.');
    expect(f.calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('does not retry a mid-stream error with a non-retryable code', async () => {
    const t = fixture('openrouter-midstream-error.sse').replace('"code":429', '"code":403').replace('rate_limit_exceeded', 'content_policy_violation');
    const f = scriptedFetch([{ status: 200, body: t }]);
    const { deps } = testDeps(f.fetch);
    const err = (await createOpenRouterProvider(openrouterCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('content_policy_violation');
    expect(f.calls.length).toBe(1);
  });

  it('accepts a stream that ends with the usage frame but without [DONE], and rejects one cut before usage', async () => {
    const full = fixture('openrouter-text.sse');
    const noDone = full.replace('data: [DONE]\n\n', '');
    const cut = full.split('"usage"')[0]!.replace(/data: \{[^\n]*$/, '');
    const f = scriptedFetch([{ status: 200, body: noDone }, { status: 200, body: cut }, { status: 200, body: cut }, { status: 200, body: cut }]);
    const { deps } = testDeps(f.fetch);
    const p = createOpenRouterProvider(openrouterCfg(), deps);
    expect((await p.generate(request(), genOpts())).usage.costUsd).toBe(0.001288);
    await expect(p.generate(request(), genOpts())).rejects.toMatchObject({ status: 0, retryable: true });
    expect(f.calls.length).toBe(4);
  });

  it('stops on abort mid-stream and rethrows signal.reason', async () => {
    const head = fixture('openrouter-text.sse').split('data: {"id":"gen-1789872345-abc","object":"chat.completion.chunk","created":1789872345,"model":"anthropic/claude-sonnet-5","provider":"Claude Platform on AWS","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"')[0]!;
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = testDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('signal');
    const deltas: string[] = [];
    const p = createOpenRouterProvider(openrouterCfg(), deps).generate(
      request(),
      genOpts({
        signal: ac.signal,
        onDelta: (t) => {
          deltas.push(t);
          if (deltas.length === 2) ac.abort(reason);
        },
      }),
    );
    await expect(p).rejects.toBe(reason);
    expect(deltas).toEqual(['I', ' am ready.']);
    expect(f.streams[0]!.cancelled()).toBe(true);
  });

  it('redacts the bearer key from error text', async () => {
    const key = openrouterCfg().apiKey;
    const f = scriptedFetch([{ status: 401, body: `{"error":{"message":"bad ${key}","code":401}}` }]);
    const { deps } = testDeps(f.fetch);
    const err = (await createOpenRouterProvider(openrouterCfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.message).not.toContain(key);
    expect(err.body).not.toContain(key);
  });

  it('does not retry when onToolDelta throws; the harness bug surfaces as a typed internal error', async () => {
    const f = scriptedFetch([sse('openrouter-tool.sse'), sse('openrouter-tool.sse')]);
    const { deps, sleeps } = testDeps(f.fetch);
    const err = await createOpenRouterProvider(openrouterCfg(), deps)
      .generate(
        request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
        genOpts({
          onToolDelta: () => {
            throw new Error('tui reducer bug');
          },
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevCodeError);
    expect((err as JevCodeError).code).toBe('internal');
    expect(f.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('bounds the error message of a mid-stream error chunk and of an HTTP error body', async () => {
    const huge = 'y'.repeat(20_000);
    const mid = fixture('openrouter-midstream-error.sse').replace('"code":429', '"code":403').replace('Provider returned error', huge);
    const f = scriptedFetch([{ status: 200, body: mid }, { status: 400, body: `{"error":{"code":400,"message":"${huge}"}}` }]);
    const { deps } = testDeps(f.fetch);
    const p = createOpenRouterProvider(openrouterCfg(), deps);
    const e1 = (await p.generate(request(), genOpts()).catch((e: unknown) => e)) as ProviderHttpError;
    expect(e1.status).toBe(403);
    expect(e1.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(e1.body.length).toBeLessThanOrEqual(2048);
    const e2 = (await p.generate(request(), genOpts()).catch((e: unknown) => e)) as ProviderHttpError;
    expect(e2.status).toBe(400);
    expect(e2.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it('does not hang on an error response whose body never completes (fake timers): fails the attempt after 30 s and retries', async () => {
    vi.useFakeTimers();
    const f = scriptedFetch([{ status: 503, body: ['{"error":{"code":503,"mess'], hang: true }, sse('openrouter-text.sse')]);
    const { deps, sleeps } = testDeps(f.fetch, 0);
    const p = createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts());
    const settled = p.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const out = await settled;
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.r.text).toBe('I am ready.');
    expect(f.calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });
});
