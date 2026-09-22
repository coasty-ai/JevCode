/**
 * provider/openai.ts — the Responses API client (default) and the Chat Completions quirks table.
 * Every `.sse` / `.json` fixture here was RECORDED from api.openai.com on 2026-09-21 (gpt-5.6-terra), including the two
 * 400s the quirks table exists to avoid.
 */
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { PROPOSE_ACTION_TOOL } from '../../../src/provider/actions.js';
import {
  OPENAI_CHAT_QUIRKS,
  buildResponsesBody,
  createOpenAiProvider,
  isOpenAiChatModel,
  listOpenAiModels,
  openAiAcceptsTemperature,
  openAiEfforts,
  openAiReasoningEffort,
} from '../../../src/provider/openai.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { PROPOSE_TOOL, fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const cfg = (over = {}) => providerCfg({ model: 'gpt-5.6-terra', apiKey: 'sk-proj-test000000000000000000000000000000000000', baseUrl: 'https://api.openai.com/v1', ...over });
const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('openai: the Responses request body', () => {
  it('sends instructions + typed message items, flat strict tools, a flat named tool_choice and max_output_tokens — and never temperature or seed on a reasoning model', () => {
    const body = buildResponsesBody(
      cfg(),
      request({
        system: 'You are the generator.',
        messages: [
          { role: 'user', content: 'Fix the bug.' },
          { role: 'assistant', content: 'Understood.' },
          { role: 'user', content: 'Go ahead.' },
        ],
        tools: [PROPOSE_TOOL],
        toolChoice: { name: 'propose_action' },
        temperature: 0.2,
        seed: 7,
        maxTokens: 2048,
      }),
    );
    expect(body).toEqual({
      model: 'gpt-5.6-terra',
      instructions: 'You are the generator.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug.' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Understood.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go ahead.' }] },
      ],
      max_output_tokens: 2048,
      store: false,
      stream: true,
      tools: [{ type: 'function', name: 'propose_action', description: PROPOSE_TOOL.description, parameters: PROPOSE_TOOL.inputSchema, strict: true }],
      tool_choice: { type: 'function', name: 'propose_action' },
      parallel_tool_calls: false,
    });
    // live 2026-09-21: `temperature` is 400 `Unsupported parameter` and `seed` is 400 `Unknown parameter` on this model
    expect('temperature' in body).toBe(false);
    expect('seed' in body).toBe(false);
  });

  it('keeps temperature for the 4.x families only', () => {
    expect(openAiAcceptsTemperature('gpt-4o')).toBe(true);
    expect(openAiAcceptsTemperature('gpt-4.1-mini')).toBe(true);
    expect(openAiAcceptsTemperature('gpt-5.6-terra')).toBe(false);
    expect(openAiAcceptsTemperature('gpt-6-astra')).toBe(false);
    expect(buildResponsesBody(cfg({ model: 'gpt-4.1' }), request({ temperature: 0.3 })).temperature).toBe(0.3);
    expect('temperature' in buildResponsesBody(cfg({ model: 'gpt-4.1' }), request({ temperature: null }))).toBe(false);
  });

  it('omits `strict` for a schema OpenAI strict mode would reject — the harness\'s own propose_action — and keeps the tool otherwise unchanged', () => {
    const body = buildResponsesBody(cfg(), request({ tools: [PROPOSE_ACTION_TOOL], toolChoice: { name: PROPOSE_ACTION_TOOL.name } }));
    expect(body.tools).toEqual([{ type: 'function', name: 'propose_action', description: PROPOSE_ACTION_TOOL.description, parameters: PROPOSE_ACTION_TOOL.inputSchema }]);
    expect(body.tools![0]!.strict).toBeUndefined();
  });

  it('maps §4.12 reasoning to `reasoning.effort`, substituting the lowest level a family accepts and dropping a token budget', () => {
    expect(openAiEfforts('gpt-6-astra')).not.toContain('none');
    expect(openAiEfforts('gpt-4o')).toBeNull();
    // {enabled:false} is `none` where it exists, and gpt-6-astra's lowest (`low`) where it does not
    expect(openAiReasoningEffort({ enabled: false }, 'gpt-5.6-terra')).toBe('none');
    expect(openAiReasoningEffort({ enabled: false }, 'gpt-6-astra')).toBe('low');
    expect(openAiReasoningEffort({ enabled: false }, 'gpt-5.4')).toBe('minimal');
    expect(openAiReasoningEffort({ effort: 'low' }, 'gpt-5.6-terra')).toBe('low');
    expect(openAiReasoningEffort({ effort: 'medium' }, 'gpt-5.6-terra')).toBe('medium');
    // a thinking budget has no counterpart on either OpenAI surface
    expect(openAiReasoningEffort({ maxTokens: 2048 }, 'gpt-5.6-terra')).toBeNull();
    expect(openAiReasoningEffort({ effort: 'low' }, 'gpt-4o')).toBeNull();
    expect(buildResponsesBody(cfg(), request({ reasoning: { effort: 'low' } })).reasoning).toEqual({ effort: 'low' });
    expect('reasoning' in buildResponsesBody(cfg(), request({ reasoning: { maxTokens: 4096 } }))).toBe(false);
  });
});

describe('openai: the Responses stream', () => {
  it('streams a forced tool call, prefers the final arguments, reports usage with cached/reasoning details and prices from the table', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('openai-responses-tool.sse'), 17) }]);
    const { deps } = providerDeps(f.fetch);
    const toolDeltas: string[] = [];
    const res = await createOpenAiProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onToolDelta: (t) => toolDeltas.push(t) }),
    );
    expect(res.model).toBe('gpt-5.6-terra');
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.input).toEqual({ goal: 'List current directory files', command: 'ls' });
    expect(toolDeltas.length).toBe(12);
    expect(toolDeltas.join('')).toBe(res.toolCalls[0]!.rawJson);
    expect(res.usage).toEqual({ inputTokens: 198, outputTokens: 26, costUsd: (198 * 2 + 26 * 10) / 1e6, calls: 1, reasoningTokens: 0 });
    expect(res.generationId).toBe('resp_0ac1713f5a4e1ca7016ab1f29b685487d09c8437630d074816');
    expect(res.servedProvider).toBeUndefined();
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers['authorization']).toBe(`Bearer ${cfg().apiKey}`);
  });

  it('an unpriced model yields NaN instead of a silent $0 (TUI-DESIGN §9.5)', async () => {
    const f = scriptedFetch([sse('openai-responses-tool.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createOpenAiProvider(cfg(), deps).generate(request(), genOpts());
    expect(Number.isNaN(res.usage.costUsd)).toBe(true);
  });

  it('a budget eaten by the reply is `incomplete` with reason max_output_tokens → stopReason "length", with the truncated arguments kept raw', async () => {
    const f = scriptedFetch([sse('openai-responses-length.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createOpenAiProvider(cfg({ priced: true }), deps).generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, maxTokens: 16 }), genOpts());
    expect(res.stopReason).toBe('length');
    expect(res.usage.outputTokens).toBe(16);
    expect(res.toolCalls[0]!.rawJson).toBe('{"goal":"');
    expect(res.toolCalls[0]!.input).toBeNull();
  });

  it('an abort mid-arguments reports the streamed facts once and rethrows the reason (§4.8)', async () => {
    const head = fixture('openai-responses-tool.sse').split('event: response.function_call_arguments.done')[0]!;
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = providerDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('signal');
    const cancelled: CancelledGeneration[] = [];
    const p = createOpenAiProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ signal: ac.signal, onCancelled: (c) => cancelled.push(c), onToolDelta: () => ac.abort(reason) }),
    );
    await expect(p).rejects.toBe(reason);
    expect(f.streams[0]!.cancelled()).toBe(true);
    expect(cancelled.length).toBe(1);
    // the usage frame only arrives with response.completed, so the record carries the ids and the streamed sizes, no usage
    expect(cancelled[0]!.usage).toBeUndefined();
    expect(cancelled[0]!.generationId).toBe('resp_0ac1713f5a4e1ca7016ab1f29b685487d09c8437630d074816');
    expect(cancelled[0]!.toolChars).toBeGreaterThan(0);
    expect(cancelled[0]!.text).toBe('');
  });

  it('a stream that ends before a terminal event is a retryable transport failure, and a terminal event without usage too', async () => {
    const head = fixture('openai-responses-tool.sse').split('event: response.completed')[0]!;
    const f = scriptedFetch([{ status: 200, body: head }, { status: 200, body: head }, { status: 200, body: head }]);
    const { deps, sleeps } = providerDeps(f.fetch);
    await expect(createOpenAiProvider(cfg(), deps).generate(request(), genOpts())).rejects.toMatchObject({ status: 0, retryable: true });
    expect(f.calls.length).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it('maps the recorded 400 for an unsupported parameter, redacting the body and keeping it non-retryable', async () => {
    const f = scriptedFetch([{ status: 400, body: fixture('openai-400-temperature.json') }]);
    const { deps } = providerDeps(f.fetch);
    const err = await createOpenAiProvider(cfg({ model: 'gpt-4.1' }), deps)
      .generate(request({ temperature: 0.2 }), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    const httpErr = err as ProviderHttpError;
    expect(httpErr.status).toBe(400);
    expect(httpErr.retryable).toBe(false);
    expect(httpErr.message).toContain('invalid_request_error');
    expect(httpErr.message).toContain("'temperature' is not supported");
    expect(f.calls.length).toBe(1);
  });
});

describe('openai: the Chat Completions surface', () => {
  it('pins reasoning_effort to "none" when tools are present (the API 400s otherwise) and uses developer/max_completion_tokens', () => {
    const body = buildChatBody(OPENAI_CHAT_QUIRKS, cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' }, reasoning: { effort: 'medium' } }));
    expect(body.messages[0]).toEqual({ role: 'developer', content: 'You are the generator.' });
    expect(body.max_completion_tokens).toBe(512);
    expect('max_tokens' in body).toBe(false);
    expect(body.reasoning_effort).toBe('none');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'propose_action' } });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.store).toBe(false);
    // without tools the caller's level is honoured
    expect(buildChatBody(OPENAI_CHAT_QUIRKS, cfg(), request({ reasoning: { effort: 'medium' } })).reasoning_effort).toBe('medium');
  });

  it('maps the recorded 400 the quirks table exists to avoid, keeping the API\'s own remedy in the message', async () => {
    // What /v1/chat/completions answers for gpt-5.6-terra when tools are present and reasoning_effort is anything but
    // 'none' (including absent). Recorded live; the quirks table above is why this client no longer produces it.
    const f = scriptedFetch([{ status: 400, body: fixture('openai-chat-400-reasoning-tools.json') }]);
    const { deps } = providerDeps(f.fetch);
    const err = await createOpenAiProvider(cfg(), deps, { api: 'chat' })
      .generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).retryable).toBe(false);
    expect((err as Error).message).toContain('use /v1/responses');
  });

  it('streams a tool call through the shared chat accumulator', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('openai-chat-tool.sse'), 23) }]);
    const { deps } = providerDeps(f.fetch);
    const res = await createOpenAiProvider(cfg({ priced: true }), deps, { api: 'chat' }).generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }), genOpts());
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.input).toMatchObject({ command: expect.any(String), goal: expect.any(String) });
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('openai: the catalogue', () => {
  it('filters GET /models down to chat models and attaches the static sizes', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openai-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listOpenAiModels('sk-proj-test000000000000000000000000000000000000', deps);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gpt-6-astra');
    expect(ids).toContain('gpt-5.6-terra');
    expect(ids).toContain('o4-mini');
    // the list is not filtered server-side: embeddings, images, audio, realtime and completions-only ids are dropped here
    expect(ids).not.toContain('text-embedding-ada-002');
    expect(ids).not.toContain('gpt-image-2');
    expect(ids).not.toContain('gpt-realtime');
    expect(ids).not.toContain('gpt-4o-mini-tts');
    expect(ids).not.toContain('gpt-3.5-turbo-instruct');
    const astra = models.find((m) => m.id === 'gpt-6-astra')!;
    expect(astra).toMatchObject({ contextTokens: 1_048_576, maxOutputTokens: 128_000, reasoning: true, tools: true, ownedBy: expect.any(String) });
    // newest first
    expect(models[0]!.created).toBeGreaterThanOrEqual(models[models.length - 1]!.created!);
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(isOpenAiChatModel('gpt-5.1-codex')).toBe(true);
    expect(isOpenAiChatModel('gpt-5-search-api')).toBe(false);
  });
});
