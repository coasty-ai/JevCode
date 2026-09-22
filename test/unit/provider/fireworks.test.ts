/**
 * provider/fireworks.ts and the shared openai-compat accumulator it rides on.
 * `fireworks-*.sse` and `fireworks-models.json` were RECORDED from api.fireworks.ai on 2026-09-21
 * (`accounts/fireworks/models/glm-5p3-flash`).
 */
import { describe, expect, it } from 'vitest';
import { AbortError } from '../../../src/errors.js';
import { FIREWORKS_QUIRKS, createFireworksProvider, fireworksReasoning, listFireworksModels } from '../../../src/provider/fireworks.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { PROPOSE_TOOL, fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const MODEL = 'accounts/fireworks/models/glm-5p3-flash';
const cfg = (over = {}) => providerCfg({ model: MODEL, apiKey: 'fw_test0000000000000000000000', baseUrl: 'https://api.fireworks.ai/inference/v1', ...over });
const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('fireworks: the request body', () => {
  it('always sends max_tokens (the API default of 2048 is too low), pins the context-overflow behaviour and keeps strict tools + a named choice', () => {
    const body = buildChatBody(FIREWORKS_QUIRKS, cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, maxTokens: 4096, seed: 7, temperature: 0.2 }));
    expect(body).toEqual({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are the generator.' },
        { role: 'user', content: 'Fix the bug.' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      tools: [{ type: 'function', function: { name: 'propose_action', description: PROPOSE_TOOL.description, parameters: PROPOSE_TOOL.inputSchema, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'propose_action' } },
      parallel_tool_calls: false,
      temperature: 0.2,
      seed: 7,
      // without this a prompt that overflows the window silently shrinks max_tokens instead of failing
      context_length_exceeded_behavior: 'error',
    });
  });

  it('substitutes `low` for a disabled-thinking request (the model 400s on reasoning_effort "none") and maps a budget to the thinking object', () => {
    expect(fireworksReasoning({ enabled: false })).toEqual({ reasoning_effort: 'low' });
    expect(fireworksReasoning({ effort: 'low' })).toEqual({ reasoning_effort: 'low' });
    expect(fireworksReasoning({ effort: 'medium' })).toEqual({ reasoning_effort: 'medium' });
    expect(fireworksReasoning({ maxTokens: 4096 })).toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    // the documented floor
    expect(fireworksReasoning({ maxTokens: 10 })).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
    const body = buildChatBody(FIREWORKS_QUIRKS, cfg(), request({ reasoning: { maxTokens: 4096 } }));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect('reasoning_effort' in body).toBe(false);
  });
});

describe('fireworks: the stream', () => {
  it('accumulates tool arguments across chunks, reads the trailing usage frame and prices from the table', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('fireworks-tool.sse'), 19) }]);
    const { deps } = providerDeps(f.fetch);
    const toolDeltas: string[] = [];
    const res = await createFireworksProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onToolDelta: (t) => toolDeltas.push(t) }),
    );
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.input).toMatchObject({ goal: expect.any(String), command: expect.any(String) });
    expect(toolDeltas.join('')).toBe(res.toolCalls[0]!.rawJson);
    expect(toolDeltas.length).toBeGreaterThan(1);
    expect(res.usage).toEqual({ inputTokens: 234, outputTokens: 26, costUsd: (234 * 2 + 26 * 10) / 1e6, calls: 1, reasoningTokens: 0 });
    expect(res.model).toBe(MODEL);
    expect(res.generationId).toBe('chatcmpl-6e2f4f05a36549c28cfdcb10b01e2eb0');
    expect(f.calls[0]!.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(f.calls[0]!.headers['authorization']).toBe(`Bearer ${cfg().apiKey}`);
  });

  it('reports a length stop verbatim', async () => {
    const f = scriptedFetch([sse('fireworks-length.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createFireworksProvider(cfg({ priced: true }), deps).generate(request({ maxTokens: 12 }), genOpts());
    expect(res.stopReason).toBe('length');
    expect(res.usage.outputTokens).toBe(12);
  });

  it('an abort mid-arguments reports the streamed facts once and drops the connection', async () => {
    const head = fixture('fireworks-tool.sse').split('"finish_reason":"tool_calls"')[0]!;
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = providerDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('signal');
    const cancelled: CancelledGeneration[] = [];
    const p = createFireworksProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ signal: ac.signal, onCancelled: (c) => cancelled.push(c), onToolDelta: (frag) => (frag.length > 0 ? ac.abort(reason) : undefined) }),
    );
    await expect(p).rejects.toBe(reason);
    expect(f.streams[0]!.cancelled()).toBe(true);
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]!.toolChars).toBeGreaterThan(0);
    expect(cancelled[0]!.usage).toBeUndefined();
    expect(cancelled[0]!.generationId).toBe('chatcmpl-6e2f4f05a36549c28cfdcb10b01e2eb0');
  });

  it('a 429 is retried with the backoff schedule and the result is flagged rateLimited', async () => {
    const body = JSON.stringify({ error: { object: 'error', type: 'invalid_request_error', code: 'rate_limit', message: 'slow down' }, request_id: 'req-1' });
    const f = scriptedFetch([{ status: 429, body }, { status: 200, body: fixture('fireworks-tool.sse') }]);
    const { deps, sleeps } = providerDeps(f.fetch);
    const res = await createFireworksProvider(cfg({ priced: true }), deps).generate(request(), genOpts());
    expect(res.rateLimited).toBe(true);
    expect(sleeps).toEqual([500]);
  });
});

describe('fireworks: the catalogue', () => {
  it('keeps chat models with their tool/vision/context metadata and drops the embedding rows', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('fireworks-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listFireworksModels('fw_test0000000000000000000000', deps);
    const ids = models.map((m) => m.id);
    expect(ids).toContain(MODEL);
    expect(ids).toContain('accounts/fireworks/routers/glm-5p3-fast');
    expect(ids).not.toContain('accounts/fireworks/models/qwen3-embedding-8b');
    expect(models.find((m) => m.id === MODEL)).toMatchObject({ contextTokens: expect.any(Number), tools: true, ownedBy: 'fireworks' });
  });
});
