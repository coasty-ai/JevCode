/**
 * AGENT-LOOP-DESIGN §6.2 (OpenAI-compatible row): the agent wire of openai-compat.ts for xAI, Fireworks and Meta — S2 tests
 * (a) golden bodies, (b) streams (interleaved calls, reasoning_content to onReasoning, Fireworks' replay capture),
 * (c) replay filtering, (d) a changed id at one index; plus the sessionHeader quirk.
 */
import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '../../../src/core/types.js';
import { FIREWORKS_QUIRKS, createFireworksProvider } from '../../../src/provider/fireworks.js';
import { META_QUIRKS, createMetaProvider } from '../../../src/provider/meta.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import { XAI_QUIRKS, createXaiProvider } from '../../../src/provider/xai.js';
import { NOTE, PROSE, READ_TOOL, RESULT_A, RESULT_B, TASK, agentReq, hooks, sseData, transcript } from './agent-helpers.js';
import { genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const FW = 'accounts/fireworks/models/glm-5p3-flash';
const fwCfg = providerCfg({ model: FW, baseUrl: 'https://api.fireworks.ai/inference/v1', priced: true });
const xaiCfg = providerCfg({ model: 'grok-4.7', baseUrl: 'https://api.x.ai/v1', priced: true });
const metaCfg = providerCfg({ model: 'muse-spark-1.3', baseUrl: 'https://api.meta.ai/v1' });
const FW_STATE = { provider: 'fireworks' as const, model: FW, data: { reasoning_content: 'Both files matter.' } };

const TOOL_WIRE = [{ type: 'function', function: { name: 'read_file', description: READ_TOOL.description, parameters: READ_TOOL.inputSchema, strict: true } }];
const CALLS_WIRE = [
  { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
  { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"test/a.test.ts"}' } },
];
const tail = [
  { role: 'tool', tool_call_id: 'call_a', content: RESULT_A },
  { role: 'tool', tool_call_id: 'call_b', content: RESULT_B },
  { role: 'user', content: NOTE },
];

const chunk = (model: string, delta: object): object => ({ id: 'chatcmpl-agent', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] });
const usage = (model: string): object => ({ id: 'chatcmpl-agent', model, choices: [], usage: { prompt_tokens: 500, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 9 } } });

describe('openai-compat agent wire: golden bodies (S2 test a)', () => {
  it('xai: tool_calls with ids, tool messages, reasoning_effort per turn, no parallel_tool_calls; reasoning_content is never replayed', () => {
    const body = buildChatBody(XAI_QUIRKS, xaiCfg, agentReq(transcript({ ...FW_STATE, provider: 'xai', model: 'grok-4.7' })));
    const golden = {
      model: 'grok-4.7',
      messages: [{ role: 'system', content: 'You are JevCode.' }, { role: 'user', content: TASK }, { role: 'assistant', content: PROSE, tool_calls: CALLS_WIRE }, ...tail],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16384,
      tools: TOOL_WIRE,
      tool_choice: 'auto',
      reasoning_effort: 'low',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('fireworks: reasoning_content replayed on the assistant turn, context_length_exceeded_behavior kept', () => {
    const body = buildChatBody(FIREWORKS_QUIRKS, fwCfg, agentReq(transcript(FW_STATE)));
    const golden = {
      model: FW,
      messages: [
        { role: 'system', content: 'You are JevCode.' },
        { role: 'user', content: TASK },
        { role: 'assistant', content: PROSE, tool_calls: CALLS_WIRE, reasoning_content: 'Both files matter.' },
        ...tail,
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16384,
      tools: TOOL_WIRE,
      tool_choice: 'auto',
      reasoning_effort: 'low',
      context_length_exceeded_behavior: 'error',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('meta: the JSON transport body (no stream), tool_choice auto', () => {
    const body = buildChatBody(META_QUIRKS, metaCfg, agentReq());
    const golden = {
      model: 'muse-spark-1.3',
      messages: [{ role: 'system', content: 'You are JevCode.' }, { role: 'user', content: TASK }, { role: 'assistant', content: PROSE, tool_calls: CALLS_WIRE }, ...tail],
      max_tokens: 16384,
      tools: TOOL_WIRE,
      tool_choice: 'auto',
      reasoning_effort: 'low',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('one call per turn restores parallel_tool_calls false; {enabled:false} is not sent as a disable', () => {
    const body = buildChatBody(XAI_QUIRKS, xaiCfg, agentReq(transcript(), { parallelToolCalls: false }, { reasoning: { enabled: false } }));
    expect(body.parallel_tool_calls).toBe(false);
    expect('reasoning_effort' in body).toBe(false);
  });
});

describe('openai-compat agent wire: session headers', () => {
  it('xai sends x-grok-conv-id and fireworks x-session-affinity on agent requests only; an empty cache key sends none', async () => {
    const xs = sseData([chunk('grok-4.7', { content: 'ok' }), usage('grok-4.7')]);
    const f = scriptedFetch([
      { status: 200, body: xs },
      { status: 200, body: xs },
      { status: 200, body: xs },
    ]);
    const x = createXaiProvider(xaiCfg, providerDeps(f.fetch).deps);
    await x.generate(agentReq(), genOpts());
    await x.generate(request(), genOpts());
    await x.generate(agentReq(transcript(), { cacheKey: '' }), genOpts());
    expect(f.calls[0]!.headers['x-grok-conv-id']).toBe('sess-1');
    expect('x-grok-conv-id' in f.calls[1]!.headers).toBe(false);
    expect('x-grok-conv-id' in f.calls[2]!.headers).toBe(false);

    const fs = sseData([chunk(FW, { content: 'ok' }), usage(FW)]);
    const g = scriptedFetch([{ status: 200, body: fs }]);
    await createFireworksProvider(fwCfg, providerDeps(g.fetch).deps).generate(agentReq(), genOpts());
    expect(g.calls[0]!.headers['x-session-affinity']).toBe('sess-1');
  });
});

describe('openai-compat agent wire: streams (S2 test b)', () => {
  const interleaved = (model: string, reasoningField: 'reasoning_content'): string =>
    sseData([
      chunk(model, { role: 'assistant', [reasoningField]: 'Think ' }),
      chunk(model, { [reasoningField]: 'twice.' }),
      chunk(model, { content: 'Reading.' }),
      chunk(model, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path"' } }] }),
      chunk(model, { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } }] }),
      chunk(model, { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }),
      { id: 'chatcmpl-agent', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      usage(model),
    ]);

  it('fireworks: interleaved calls with ids, onToolCall order, reasoning_content to onReasoning and captured as providerState', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(interleaved(FW, 'reasoning_content'), 19) }]);
    const h = hooks();
    const res = await createFireworksProvider(fwCfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r) }));
    expect(h.reasoning).toEqual(['Think ', 'twice.']);
    expect(h.calls).toEqual([
      { index: 0, id: 'call_1', name: 'read_file', fragment: '{"path"' },
      { index: 1, id: 'call_2', name: 'read_file', fragment: '{"path":"b"}' },
      { index: 0, id: 'call_1', name: 'read_file', fragment: ':"a"}' },
    ]);
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a' }, rawJson: '{"path":"a"}', id: 'call_1' },
      { name: 'read_file', input: { path: 'b' }, rawJson: '{"path":"b"}', id: 'call_2' },
    ]);
    expect(res.providerState).toEqual({ provider: 'fireworks', model: FW, data: { reasoning_content: 'Think twice.' } });
    expect(res.text).toBe('Reading.');
  });

  it('xai: the same stream surfaces reasoning to onReasoning but keeps no replay state; a legacy request keeps no ids', async () => {
    const f = scriptedFetch([
      { status: 200, body: interleaved('grok-4.7', 'reasoning_content') },
      { status: 200, body: interleaved('grok-4.7', 'reasoning_content') },
    ]);
    const x = createXaiProvider(xaiCfg, providerDeps(f.fetch).deps);
    const h = hooks();
    const res = await x.generate(agentReq(), genOpts({ onReasoning: (r) => h.reasoning.push(r) }));
    expect(h.reasoning).toEqual(['Think ', 'twice.']);
    expect(res.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect('providerState' in res).toBe(false);
    const legacy = await x.generate(request(), genOpts());
    expect(legacy.toolCalls.every((c) => !('id' in c))).toBe(true);
    expect('providerState' in legacy).toBe(false);
  });

  it('meta (JSON transport): two calls in one completion come back with their ids', async () => {
    const completion = {
      id: 'chatcmpl-meta',
      model: 'muse-spark-1.3',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Reading.',
            tool_calls: [
              { id: 'call_m1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
              { id: 'call_m2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    };
    const f = scriptedFetch([{ status: 200, body: JSON.stringify(completion) }]);
    const h = hooks();
    const res = await createMetaProvider(metaCfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts({ onToolCall: (d) => h.calls.push(d) }));
    expect(res.toolCalls.map((c) => [c.id, c.input])).toEqual([
      ['call_m1', { path: 'a' }],
      ['call_m2', { path: 'b' }],
    ]);
    expect(h.calls.map((c) => [c.index, c.id])).toEqual([
      [0, 'call_m1'],
      [1, 'call_m2'],
    ]);
  });
});

describe('openai-compat agent wire: replay filtering and id splits (S2 tests c, d)', () => {
  it('(c) fireworks reasoning_content from another provider, another configured model, or with replay off is not sent', () => {
    const sent = (req: GenerateRequest): boolean => 'reasoning_content' in buildChatBody(FIREWORKS_QUIRKS, fwCfg, req).messages[2]!;
    expect(sent(agentReq(transcript(FW_STATE)))).toBe(true);
    expect(sent(agentReq(transcript({ ...FW_STATE, model: 'accounts/fireworks/models/glm-5p3' })))).toBe(false);
    expect(sent(agentReq(transcript({ ...FW_STATE, provider: 'openrouter' })))).toBe(false);
    expect(sent(agentReq(transcript(FW_STATE), { replayReasoning: false }))).toBe(false);
  });

  it('an upstream that renumbers its calls every turn never reuses a transcript id or repeats one within a turn', async () => {
    // the transcript already holds call_a / call_b; this upstream answers with call_a again, twice
    const stream = sseData([
      chunk('grok-4.7', { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] }),
      chunk('grok-4.7', { tool_calls: [{ index: 1, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"y"}' } }] }),
      chunk('grok-4.7', { tool_calls: [{ index: 2, id: 'call_c', type: 'function', function: { name: 'read_file', arguments: '{"path":"z"}' } }] }),
      usage('grok-4.7'),
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createXaiProvider(xaiCfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    const ids = res.toolCalls.map((c) => c.id!);
    expect(ids[0]).toMatch(/^jc_[a-z0-9]+_0$/);
    expect(ids[1]).toMatch(/^jc_[a-z0-9]+_1$/);
    expect(ids[2]).toBe('call_c');
    expect(new Set(ids).size).toBe(3);
  });

  it('(d) two chunks at one index with different ids are two calls', async () => {
    const stream = sseData([
      chunk('grok-4.7', { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] }),
      chunk('grok-4.7', { tool_calls: [{ index: 0, id: 'call_y', type: 'function', function: { name: 'read_file', arguments: '{"path":"y"}' } }] }),
      usage('grok-4.7'),
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createXaiProvider(xaiCfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    expect(res.toolCalls.map((c) => [c.id, c.input])).toEqual([
      ['call_x', { path: 'x' }],
      ['call_y', { path: 'y' }],
    ]);
  });
});
