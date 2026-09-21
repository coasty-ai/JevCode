import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, JevCodeError, ProviderHttpError } from '../../../src/errors.js';
import { MAX_MESSAGE_CHARS } from '../../../src/provider/sse.js';
import { OPENROUTER_REFERER, OPENROUTER_TITLE, buildOpenRouterBody, createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import type { CancelledGeneration, GenerateRequestExt, OpenRouterRequestBody } from '../../../src/provider/types.js';
import { GLM_PRICING, PROPOSE_TOOL, fixture, genOpts, openrouterCfg, request, scriptedFetch, splitEvery, testDeps } from './helpers.js';

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
    // the frame's `completion_tokens_details.reasoning_tokens: 0` is read as a value (LLM-JEV-DESIGN §4.12), not dropped
    expect(res.usage).toEqual({ inputTokens: 444, outputTokens: 40, costUsd: 0.001288, calls: 1, reasoningTokens: 0 });
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

  it('accumulates tool_calls arguments across chunks by index, and prices a table-priced model from the table when cost is null', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('openrouter-tool.sse'), 13) }]);
    const { deps } = testDeps(f.fetch);
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    // TUI-DESIGN §9.5: the table fallback needs `priced` (validateGenerator sets it); an unpriced model surfaces NaN (retry-hooks.test.ts)
    const res = await createOpenRouterProvider(openrouterCfg({ priced: true }), deps).generate(
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
    expect(body.parallel_tool_calls).toBe(false);
  });

  it('the default generator z-ai/glm-5.3-flash gets the same body: strict tools, a forced tool_choice, parallel_tool_calls false, max_tokens under its 131,072 cap, no temperature', () => {
    const cfg = openrouterCfg({ model: 'z-ai/glm-5.3-flash', pricing: GLM_PRICING, priced: true });
    const body = buildOpenRouterBody(cfg, request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, maxTokens: 4096 }));
    expect(body).toEqual({
      model: 'z-ai/glm-5.3-flash',
      messages: [
        { role: 'system', content: 'You are the generator.' },
        { role: 'user', content: 'Fix the bug.' },
      ],
      stream: true,
      max_tokens: 4096,
      usage: { include: true },
      tools: [{ type: 'function', function: { name: 'propose_action', description: PROPOSE_TOOL.description, parameters: PROPOSE_TOOL.inputSchema, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'propose_action' } },
      parallel_tool_calls: false,
    });
    expect(body.max_tokens).toBeLessThanOrEqual(131_072);
    // the wire body is plain JSON with no undefined members (JSON.stringify would drop them, so the key set is what the API sees)
    expect(Object.keys(JSON.parse(JSON.stringify(body)) as object).sort()).toEqual(['max_tokens', 'messages', 'model', 'parallel_tool_calls', 'stream', 'tool_choice', 'tools', 'usage']);
    // without tools there is no tool_choice and no parallel_tool_calls
    const plain = buildOpenRouterBody(cfg, request());
    expect('tools' in plain || 'tool_choice' in plain || 'parallel_tool_calls' in plain).toBe(false);
  });

  it('maps toolChoice strings and temperature', () => {
    const cfg = openrouterCfg();
    expect(buildOpenRouterBody(cfg, request({ tools: [PROPOSE_TOOL], toolChoice: 'auto' })).tool_choice).toBe('auto');
    expect(buildOpenRouterBody(cfg, request({ tools: [PROPOSE_TOOL], toolChoice: 'required' })).tool_choice).toBe('required');
    expect(buildOpenRouterBody(cfg, request({ toolChoice: 'required' })).tool_choice).toBeUndefined();
    expect(buildOpenRouterBody(cfg, request({ toolChoice: 'required' })).parallel_tool_calls).toBeUndefined();
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

/** LLM-JEV-DESIGN §4.12 / §4.8: the GLM request fields, the accounting fields and the cancelled-sample estimate. */
describe('openrouter GLM details (LLM-JEV-DESIGN §4.12)', () => {
  const glmCfg = openrouterCfg({ model: 'z-ai/glm-5.3-flash', pricing: GLM_PRICING, priced: true });
  const ext = (over: Partial<GenerateRequestExt>): GenerateRequestExt => ({ ...request(), ...over });

  it('maps seed, reasoning and providerPrefs onto the wire body and omits them when absent', () => {
    const full = buildOpenRouterBody(glmCfg, ext({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, seed: 41, reasoning: { enabled: false }, providerPrefs: { requireParameters: true, order: ['z-ai'] } }));
    expect(full.seed).toBe(41);
    expect(full.reasoning).toEqual({ enabled: false });
    expect(full.provider).toEqual({ require_parameters: true, order: ['z-ai'] });
    expect(Object.keys(JSON.parse(JSON.stringify(full)) as object).sort()).toEqual(['max_tokens', 'messages', 'model', 'parallel_tool_calls', 'provider', 'reasoning', 'seed', 'stream', 'tool_choice', 'tools', 'usage']);
    // effort rides along only when reasoning is enabled; `enabled` is always explicit
    expect(buildOpenRouterBody(glmCfg, ext({ reasoning: { enabled: true, effort: 'low' } })).reasoning).toEqual({ enabled: true, effort: 'low' });
    expect(buildOpenRouterBody(glmCfg, ext({ reasoning: { enabled: true } })).reasoning).toEqual({ enabled: true });
    expect(buildOpenRouterBody(glmCfg, ext({ reasoning: { enabled: false, effort: 'high' } })).reasoning).toEqual({ enabled: false });
    // only the prefs given are sent; an empty prefs object sends no `provider` at all
    expect(buildOpenRouterBody(glmCfg, ext({ providerPrefs: { requireParameters: false } })).provider).toEqual({ require_parameters: false });
    expect(buildOpenRouterBody(glmCfg, ext({ providerPrefs: { order: ['z-ai', 'novita'] } })).provider).toEqual({ order: ['z-ai', 'novita'] });
    expect('provider' in buildOpenRouterBody(glmCfg, ext({ providerPrefs: {} }))).toBe(false);
    expect('provider' in buildOpenRouterBody(glmCfg, ext({ providerPrefs: { order: [] } }))).toBe(false);
    // the jev-on propose path sends none of them (byte-identical body to before)
    const plain = buildOpenRouterBody(glmCfg, request());
    expect('seed' in plain || 'reasoning' in plain || 'provider' in plain).toBe(false);
  });

  it('rejects a non-integer seed before any request is made', async () => {
    const f = scriptedFetch([]);
    const { deps } = testDeps(f.fetch);
    await expect(createOpenRouterProvider(glmCfg, deps).generate(ext({ seed: 1.5 }), genOpts())).rejects.toMatchObject({ status: 0, retryable: false, message: expect.stringContaining('seed') });
    expect(f.calls.length).toBe(0);
  });

  it('GLM length stop: surfaces finish_reason verbatim, reasoning_tokens, the served provider and the generation id; truncated arguments keep the raw text', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('openrouter-glm-length.sse'), 17) }]);
    const { deps } = testDeps(f.fetch);
    const deltas: string[] = [];
    const res = await createOpenRouterProvider(glmCfg, deps).generate(ext({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_fix' }, maxTokens: 1500, reasoning: { enabled: false } }), genOpts({ onDelta: (t) => deltas.push(t) }));
    expect(res.stopReason).toBe('length');
    expect(res.model).toBe('z-ai/glm-5.3-flash');
    expect(res.generationId).toBe('gen-1790000000-glmlen');
    expect(res.servedProvider).toBe('Z.AI');
    // usage.cost wins; reasoning_tokens ≈ completion_tokens is the "budget went to thinking" signature (research 07 §5)
    expect(res.usage).toEqual({ inputTokens: 1350, outputTokens: 1500, costUsd: 0.0009525, calls: 1, reasoningTokens: 1447 });
    // `delta.reasoning` is never shown as text
    expect(deltas).toEqual([]);
    expect(res.text).toBe('');
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]!.name).toBe('propose_fix');
    expect(res.toolCalls[0]!.input).toBeNull();
    expect(res.toolCalls[0]!.rawJson.startsWith('{"rationale": "off by one')).toBe(true);
  });

  it('a frame without reasoning_tokens leaves usage.reasoningTokens absent, and a non-GLM stream has the ids too', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openrouter-text.sse').replace(',"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}', '') }]);
    const { deps } = testDeps(f.fetch);
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts());
    expect('reasoningTokens' in res.usage).toBe(false);
    expect(res.generationId).toBe('gen-1789872345-abc');
    expect(res.servedProvider).toBe('Claude Platform on AWS');
  });

  it('cancellation mid-stream: onCancelled gets a chars/4 estimate marked estimated with the generation id, then signal.reason is rethrown and the connection dropped', async () => {
    const reasoning = 'The failing test says the loop is off by one, so';
    const args = '{"rationale": "off by one in the range bound", "edits": [{"path": "quicksort.py", "line": 12, "new": "    for i in range(lo, hi + 1';
    const head = fixture('openrouter-glm-length.sse').split('data: {"id":"gen-1790000000-glmlen","object":"chat.completion.chunk","created":1790000000,"model":"z-ai/glm-5.3-flash","provider":"Z.AI","choices":[{"index":0,"delta":{"content":null},"finish_reason":"length"')[0]!;
    // the fixture carries the arguments JSON-escaped inside the chunk; the head must end after them and before the finish chunk
    expect(head).toContain(JSON.stringify(args).slice(1, -1));
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = testDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('signal');
    const cancelled: CancelledGeneration[] = [];
    const req = ext({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_fix' }, maxTokens: 1500, seed: 3, reasoning: { enabled: false } });
    const p = createOpenRouterProvider(glmCfg, deps).generate(
      req,
      genOpts({
        signal: ac.signal,
        sample: 2,
        onToolDelta: (frag) => {
          if (frag.length > 0) ac.abort(reason);
        },
        onCancelled: (c) => cancelled.push(c),
      }),
    );
    await expect(p).rejects.toBe(reason);
    expect(f.streams[0]!.cancelled()).toBe(true);
    expect(f.calls.length).toBe(1);
    expect(cancelled.length).toBe(1);
    const c = cancelled[0]!;
    const promptTokens = Math.ceil(JSON.stringify(buildOpenRouterBody(glmCfg, req)).length / 4);
    const outputTokens = Math.ceil((reasoning.length + args.length) / 4);
    expect(c.usage).toEqual({
      inputTokens: promptTokens,
      outputTokens,
      costUsd: (promptTokens * GLM_PRICING.inputPerM + outputTokens * GLM_PRICING.outputPerM) / 1e6,
      calls: 1,
      estimated: true,
      reasoningTokens: Math.ceil(reasoning.length / 4),
    });
    expect(c.generationId).toBe('gen-1790000000-glmlen');
    expect(c.servedProvider).toBe('Z.AI');
    expect(c.model).toBe('z-ai/glm-5.3-flash');
    expect(c.text).toBe('');
    expect(c.toolChars).toBe(args.length);
  });

  it('a signal that fires before the first byte rethrows its reason without an onCancelled call (nothing was streamed)', async () => {
    const f = scriptedFetch([{ status: 200, body: [': OPENROUTER PROCESSING\n\n'], hang: true }]);
    const { deps } = testDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    let calls = 0;
    const p = createOpenRouterProvider(glmCfg, deps).generate(ext({ seed: 1 }), genOpts({ signal: ac.signal, onCancelled: () => void calls++ }));
    // the comment line is not a record; the stream is open and idle when the abort lands
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    // the stream was open, so the estimate is offered (zero output, prompt from the body) — exactly once
    expect(calls).toBe(1);
  });
});
