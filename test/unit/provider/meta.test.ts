/**
 * provider/meta.ts — the one client on the non-streaming transport. All four fixtures were RECORDED from api.meta.ai on
 * 2026-09-21 (`muse-spark-1.3`), including the 400 that proves a forced tool choice is impossible there.
 */
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { META_QUIRKS, createMetaProvider, listMetaModels, metaReasoning } from '../../../src/provider/meta.js';
import { buildChatBody, completionAsChunk } from '../../../src/provider/openai-compat.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { PROPOSE_TOOL, fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch } from './helpers.js';

const cfg = (over = {}) => providerCfg({ model: 'muse-spark-1.3', apiKey: 'LLM|607358788850350|nx9test0000000000000000', baseUrl: 'https://api.meta.ai/v1', ...over });
const json = (name: string) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: fixture(name) });

describe('meta: the request body', () => {
  it('omits `stream` (the streaming surface drops tool calls and usage) and downgrades a forced tool choice to auto', () => {
    const body = buildChatBody(META_QUIRKS, cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, seed: 7, temperature: 0.2 }));
    expect('stream' in body).toBe(false);
    expect('stream_options' in body).toBe(false);
    // live: a named or `required` choice is 400 `only "auto" is supported for tool_choice`
    expect(body.tool_choice).toBe('auto');
    expect(buildChatBody(META_QUIRKS, cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: 'required' })).tool_choice).toBe('auto');
    expect(body.max_tokens).toBe(512);
    expect(body.seed).toBe(7);
    expect(body.temperature).toBe(0.2);
    expect(body.tools![0]!.function.strict).toBe(true);
    expect(metaReasoning({ enabled: false })).toEqual({ reasoning_effort: 'low' });
    expect(metaReasoning({ maxTokens: 1024 })).toBeNull();
  });

  it('reshapes a completion into a chunk so the streaming accumulator can read it', () => {
    const chunk = completionAsChunk({
      id: 'chatcmpl-1',
      model: 'muse-spark-1.3',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(chunk).toEqual({
      id: 'chatcmpl-1',
      model: 'muse-spark-1.3',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      choices: [{ index: 0, delta: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    });
  });
});

describe('meta: the response', () => {
  it('parses the tool call, the text and the usage out of a non-streamed completion', async () => {
    const f = scriptedFetch([json('meta-tool.json')]);
    const { deps } = providerDeps(f.fetch);
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    const res = await createMetaProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onDelta: (t) => deltas.push(t), onToolDelta: (t) => toolDeltas.push(t) }),
    );
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input: { command: 'ls -la', goal: 'List files in directory' }, rawJson: '{"command":"ls -la","goal":"List files in directory"}' }]);
    // the whole body arrives at once, so each callback fires exactly once
    expect(deltas).toEqual(['Listing files — preparing your command.']);
    expect(toolDeltas.length).toBe(1);
    expect(res.usage).toEqual({ inputTokens: 598, outputTokens: 204, costUsd: (598 * 2 + 204 * 10) / 1e6, calls: 1, reasoningTokens: 117 });
    expect(res.model).toBe('muse-spark-1.3');
    expect(res.generationId).toBe('chatcmpl-01a0c71d-fb80-7573-8438-c80e3f413ddb');
    // the request asked for JSON, not SSE
    expect(f.calls[0]!.headers['accept']).toBe('application/json');
    expect(f.calls[0]!.url).toBe('https://api.meta.ai/v1/chat/completions');
  });

  it('reports the length stop that only the non-streaming surface returns', async () => {
    const f = scriptedFetch([json('meta-length.json')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createMetaProvider(cfg({ priced: true }), deps).generate(request({ maxTokens: 64 }), genOpts());
    expect(res.stopReason).toBe('length');
    expect(res.usage.outputTokens).toBe(64);
    expect(res.usage.reasoningTokens).toBe(61);
  });

  it('has no published price: an unpriced config yields NaN, not $0', async () => {
    const f = scriptedFetch([json('meta-tool.json')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createMetaProvider(cfg(), deps).generate(request(), genOpts());
    expect(Number.isNaN(res.usage.costUsd)).toBe(true);
    expect(res.usage.inputTokens).toBe(598);
  });

  it('maps the recorded tool_choice 400 with its message and never retries it', async () => {
    const f = scriptedFetch([{ status: 400, body: fixture('meta-400-tool-choice.json') }]);
    const { deps } = providerDeps(f.fetch);
    const err = await createMetaProvider(cfg(), deps)
      .generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(400);
    expect((err as ProviderHttpError).retryable).toBe(false);
    expect((err as Error).message).toContain('invalid_request_error');
    expect((err as Error).message).toContain('only `"auto"` is supported for `tool_choice`');
  });

  it('an abort before the body arrives still reports the (empty) facts once, then rethrows the reason', async () => {
    const f = scriptedFetch([{ status: 200, body: ['{"id":"chatcmpl-x",'], hang: true }]);
    const { deps } = providerDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const cancelled: CancelledGeneration[] = [];
    const p = createMetaProvider(cfg(), deps).generate(request(), genOpts({ signal: ac.signal, onCancelled: (c) => cancelled.push(c) }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(cancelled).toEqual([{ text: '', toolChars: 0, reasoningChars: 0 }]);
  });

  it('a body that is not JSON is a retryable transport failure, not a crash', async () => {
    const f = scriptedFetch([{ status: 200, body: 'not json' }, { status: 200, body: 'not json' }, { status: 200, body: 'not json' }]);
    const { deps } = providerDeps(f.fetch);
    await expect(createMetaProvider(cfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status: 0, retryable: true });
    expect(f.calls.length).toBe(3);
  });
});

describe('meta: the catalogue', () => {
  it('keeps the text models and drops the image / voice / segmentation rows', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('meta-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listMetaModels('LLM|607358788850350|nx9test0000000000000000', deps);
    expect(models.map((m) => m.id)).toEqual(['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.2-contributor', 'muse-spark-1.3', 'muse-spark-1.3-contributor']);
    expect(models.every((m) => m.tools === true)).toBe(true);
  });
});
