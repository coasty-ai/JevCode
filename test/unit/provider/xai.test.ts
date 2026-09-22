/**
 * provider/xai.ts. `xai-*.sse` and `xai-models.json` were RECORDED from api.x.ai on 2026-09-21 (grok-4.7); the 400
 * fixture is xAI's flat error envelope, copied from the live rejection of `reasoning_effort: "none"`.
 */
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { XAI_QUIRKS, XAI_TICKS_PER_USD, createXaiProvider, listXaiModels, xaiPricePerM, xaiReasoning } from '../../../src/provider/xai.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { PROPOSE_TOOL, fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const cfg = (over = {}) => providerCfg({ model: 'grok-4.7', apiKey: 'xai-test000000000000000000000000000000000000', baseUrl: 'https://api.x.ai/v1', ...over });
const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('xai: the request body', () => {
  it('sends strict tools, a named choice, seed and temperature, and substitutes `low` for a disabled-thinking request', () => {
    const body = buildChatBody(XAI_QUIRKS, cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, seed: 7, temperature: 0.2, reasoning: { enabled: false } }));
    expect(body.max_tokens).toBe(512);
    expect(body.seed).toBe(7);
    expect(body.temperature).toBe(0.2);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools![0]!.function.strict).toBe(true);
    // live: `none` is a 400 on this model, so {enabled:false} becomes the lowest level it has
    expect(body.reasoning_effort).toBe('low');
    expect(xaiReasoning({ effort: 'medium' })).toEqual({ reasoning_effort: 'medium' });
    // no thinking-budget parameter exists on this API
    expect(xaiReasoning({ maxTokens: 4096 })).toBeNull();
  });
});

describe('xai: the stream', () => {
  it('takes the wire cost, adds reasoning tokens to the billed output and counts reasoning_content as thinking characters', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('xai-tool.sse'), 31) }]);
    const { deps } = providerDeps(f.fetch);
    const toolDeltas: string[] = [];
    const res = await createXaiProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onToolDelta: (t) => toolDeltas.push(t) }),
    );
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.input).toEqual({ goal: 'List files in current directory', command: 'ls -la' });
    // the whole argument string arrives in one chunk on this API
    expect(toolDeltas).toEqual([res.toolCalls[0]!.rawJson]);
    // prompt 1413 (1152 cached) + completion 28 + reasoning 35 — the reasoning tokens are NOT inside completion_tokens
    expect(res.usage.inputTokens).toBe(1413);
    expect(res.usage.outputTokens).toBe(28 + 35);
    expect(res.usage.reasoningTokens).toBe(35);
    // 14,760,000 ticks = $0.001476, and the wire cost wins over the table (which would say something else entirely)
    expect(res.usage.costUsd).toBeCloseTo(14_760_000 / XAI_TICKS_PER_USD, 12);
    expect(res.usage.costUsd).toBeCloseTo(0.001476, 9);
    expect(res.model).toBe('grok-4.7');
    expect(res.generationId).toBe('4c9688b9-da1c-9fc6-bf6d-8ea4ea03b60e');
  });

  it("the wire cost matches the catalogue's own rates for this call (the units are self-consistent)", async () => {
    const f = scriptedFetch([sse('xai-tool.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createXaiProvider(cfg(), deps).generate(request(), genOpts());
    // grok-4.7: $2.00 input, $0.50 cached, $6.00 output per 1M
    const expected = ((1413 - 1152) * 2 + 1152 * 0.5 + 63 * 6) / 1e6;
    expect(res.usage.costUsd).toBeCloseTo(expected, 12);
  });

  it('reports a length stop and still takes the wire cost', async () => {
    const f = scriptedFetch([sse('xai-length.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createXaiProvider(cfg(), deps).generate(request({ maxTokens: 24 }), genOpts());
    expect(res.stopReason).toBe('length');
    // completion 24 + reasoning 49 (and total_tokens 1330 = prompt 1257 + 24 + 49, the arithmetic that proves the split)
    expect(res.usage.outputTokens).toBe(24 + 49);
    expect(res.usage.reasoningTokens).toBe(49);
    expect(res.usage.costUsd).toBeCloseTo(12_240_000 / XAI_TICKS_PER_USD, 12);
    expect(res.usage.costUsd).toBeCloseTo(((1257 - 1152) * 2 + 1152 * 0.5 + 73 * 6) / 1e6, 12);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('does not double-count reasoning when a frame folds it into completion_tokens (total_tokens is the arbiter)', async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 10 } };
    const body =
      `data: ${JSON.stringify({ id: 'x-1', model: 'grok-4.7', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'x-1', model: 'grok-4.7', choices: [], usage })}\n\ndata: [DONE]\n\n`;
    const f = scriptedFetch([{ status: 200, body }]);
    const { deps } = providerDeps(f.fetch);
    const res = await createXaiProvider(cfg({ priced: true }), deps).generate(request(), genOpts());
    // 130 - 100 === 30, so the 10 reasoning tokens are already inside completion_tokens
    expect(res.usage.outputTokens).toBe(30);
    expect(res.usage.reasoningTokens).toBe(10);
  });

  it('an abort during the thinking phase reports the reasoning characters streamed so far', async () => {
    const head = fixture('xai-tool.sse').split('\n\n').slice(0, 4).join('\n\n') + '\n\n';
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = providerDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const cancelled: CancelledGeneration[] = [];
    const p = createXaiProvider(cfg({ priced: true }), deps).generate(request(), genOpts({ signal: ac.signal, onCancelled: (c) => cancelled.push(c) }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]!.text).toBe('');
    expect(cancelled[0]!.reasoningChars).toBe('The user wants me'.length);
    expect(cancelled[0]!.usage).toBeUndefined();
  });

  it('reads the flat xAI error envelope ({code, error: "<message>"}) instead of degrading to a bare status line', async () => {
    const f = scriptedFetch([{ status: 400, body: fixture('xai-400-effort-none.json') }]);
    const { deps } = providerDeps(f.fetch);
    const err = await createXaiProvider(cfg(), deps)
      .generate(request({ reasoning: { enabled: false } }), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(400);
    expect((err as Error).message).toContain('invalid-argument');
    expect((err as Error).message).toContain('does not support `reasoning_effort` value `none`');
  });
});

describe('xai: the catalogue', () => {
  it('turns the integer catalogue prices into USD per 1M and drops the image/video rows', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('xai-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listXaiModels('xai-test000000000000000000000000000000000000', deps);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('grok-4.7');
    expect(ids).toContain('grok-build-0.1');
    expect(ids).not.toContain('grok-imagine-image');
    const grok = models.find((m) => m.id === 'grok-4.7')!;
    expect(grok.pricing).toEqual({ inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5, cacheWritePerM: 2 });
    expect(grok.contextTokens).toBe(500_000);
    expect(grok.tools).toBe(true);
    expect(grok.reasoning).toBe(true);
    expect(models.find((m) => m.id === 'grok-build-0.1')!.aliases).toContain('grok-code-fast-1');
    expect(models.find((m) => m.id === 'grok-4.20-0309-non-reasoning')!.reasoning).toBe(false);
    expect(xaiPricePerM(12_500)).toBe(1.25);
    expect(xaiPricePerM(null)).toBeNull();
  });
});
