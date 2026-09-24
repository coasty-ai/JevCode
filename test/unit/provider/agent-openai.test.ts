/**
 * AGENT-LOOP-DESIGN §6.2 (OpenAI Responses row; the chat surface rides on openai-compat): S2 tests (a) golden body,
 * (b) interleaved stream (reasoning items with encrypted_content, call_ids, summary deltas), (c) replay filtering,
 * (d) a changed call_id at one output_index.
 */
import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '../../../src/core/types.js';
import { ProviderHttpError } from '../../../src/errors.js';
import { buildResponsesBody, createOpenAiProvider, isReasoningSummaryRejection, OPENAI_CHAT_QUIRKS } from '../../../src/provider/openai.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import { NOTE, PROSE, READ_TOOL, RESULT_A, RESULT_B, TASK, agentReq, hooks, sseEvents, transcript } from './agent-helpers.js';
import { genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const MODEL = 'gpt-5.6-luna';
const cfg = providerCfg({ model: MODEL, baseUrl: 'https://api.openai.com/v1', priced: true });
const REASONING = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Both files.' }], encrypted_content: 'ENC1' };
const STATE = {
  provider: 'openai' as const,
  model: MODEL,
  data: { output: [REASONING, { type: 'message' }, { type: 'function_call', call_id: 'call_a', id: 'fc_a' }, { type: 'function_call', call_id: 'call_b', id: 'fc_b' }] },
};
const USAGE = { input_tokens: 300, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 } };

describe('openai responses agent wire (AGENT-LOOP-DESIGN §6.2)', () => {
  it('(a) golden body: reasoning items replayed in place, function_call / function_call_output by call_id, include, prompt_cache_key, summary auto, no parallel_tool_calls', () => {
    const body = buildResponsesBody(cfg, agentReq(transcript(STATE)));
    const golden = {
      model: MODEL,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK }] },
        REASONING,
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PROSE }] },
        { type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{"path":"src/a.ts"}', id: 'fc_a' },
        { type: 'function_call', call_id: 'call_b', name: 'read_file', arguments: '{"path":"test/a.test.ts"}', id: 'fc_b' },
        { type: 'function_call_output', call_id: 'call_a', output: RESULT_A },
        { type: 'function_call_output', call_id: 'call_b', output: RESULT_B },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: NOTE }] },
      ],
      max_output_tokens: 16384,
      store: false,
      stream: true,
      instructions: 'You are JevCode.',
      tools: [{ type: 'function', name: 'read_file', description: READ_TOOL.description, parameters: READ_TOOL.inputSchema, strict: true }],
      tool_choice: 'auto',
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'sess-1',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('replay off drops include and the state; one call per turn sends parallel_tool_calls false; {enabled:false} sends no effort', () => {
    const body = buildResponsesBody(cfg, agentReq(transcript(STATE), { replayReasoning: false, parallelToolCalls: false }, { reasoning: { enabled: false } }));
    expect('include' in body).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ summary: 'auto' });
    expect(body.input.some((i) => i['type'] === 'reasoning')).toBe(false);
  });

  it('a non-reasoning model on Responses asks for no encrypted reasoning and sends no reasoning object', () => {
    const body = buildResponsesBody(providerCfg({ model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' }), agentReq(transcript(STATE)));
    expect('include' in body).toBe(false);
    expect('reasoning' in body).toBe(false);
    expect(body.input.some((i) => i['type'] === 'reasoning')).toBe(false);
  });

  it('reasoningSummary false drops only the summary; with no effort either, no reasoning object at all', () => {
    expect(buildResponsesBody(cfg, agentReq(transcript(STATE)), { reasoningSummary: false }).reasoning).toEqual({ effort: 'low' });
    expect('reasoning' in buildResponsesBody(cfg, agentReq(transcript(STATE), {}, { reasoning: { enabled: false } }), { reasoningSummary: false })).toBe(false);
    expect(buildResponsesBody(cfg, agentReq(transcript(STATE)), { reasoningSummary: false }).include).toEqual(['reasoning.encrypted_content']);
  });

  it('an unverified organization: the summary 400 is retried once without summary, and later turns never send it', async () => {
    const rejected = JSON.stringify({
      error: {
        message: 'Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.',
        type: 'invalid_request_error',
        param: 'reasoning.summary',
        code: 'unsupported_value',
      },
    });
    const ok = sseEvents([{ type: 'response.completed', response: { id: 'r', model: MODEL, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }], usage: USAGE } }]);
    const f = scriptedFetch([
      { status: 400, body: rejected },
      { status: 200, body: ok },
      { status: 200, body: ok },
    ]);
    const p = createOpenAiProvider(cfg, providerDeps(f.fetch).deps);
    const first = await p.generate(agentReq(), genOpts());
    expect(first.stopReason).not.toBe('error');
    expect(f.calls[0]!.body['reasoning']).toEqual({ effort: 'low', summary: 'auto' });
    expect(f.calls[1]!.body['reasoning']).toEqual({ effort: 'low' });
    await p.generate(agentReq(), genOpts());
    expect(f.calls.length).toBe(3);
    expect(f.calls[2]!.body['reasoning']).toEqual({ effort: 'low' });
  });

  it('any other 400 is not retried, and a legacy request is never retried', async () => {
    const other = JSON.stringify({ error: { message: 'Your organization must be verified to stream this model.', type: 'invalid_request_error', param: 'stream', code: 'unsupported_value' } });
    const f = scriptedFetch([
      { status: 400, body: other },
      { status: 400, body: JSON.stringify({ error: { message: 'reasoning summaries are unavailable', type: 'invalid_request_error' } }) },
    ]);
    const p = createOpenAiProvider(cfg, providerDeps(f.fetch).deps);
    await expect(p.generate(agentReq(), genOpts())).rejects.toBeInstanceOf(ProviderHttpError);
    expect(f.calls.length).toBe(1);
    await expect(p.generate(request(), genOpts())).rejects.toBeInstanceOf(ProviderHttpError);
    expect(f.calls.length).toBe(2);
    expect(isReasoningSummaryRejection(new ProviderHttpError('openai HTTP 400 invalid_request_error: bad', { status: 400, retryable: false, body: '{"param":"reasoning.summary"}' }))).toBe(true);
    expect(isReasoningSummaryRejection(new ProviderHttpError('openai HTTP 500: summary', { status: 500, retryable: true }))).toBe(false);
  });

  it('a call id renamed for uniqueness is renamed in its function_call marker too, which keeps its fc_ item id', async () => {
    const item = { id: 'fc_9', type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{"path":"c"}' };
    const reasoning = { id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: 'ENC2' };
    const stream = sseEvents([
      { type: 'response.output_item.added', output_index: 1, item },
      { type: 'response.completed', response: { id: 'r', model: MODEL, status: 'completed', output: [reasoning, item], usage: USAGE } },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createOpenAiProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(transcript(STATE)), genOpts());
    const id = res.toolCalls[0]!.id!;
    expect(id).toMatch(/^jc_/);
    expect(res.providerState!.data).toEqual({ output: [reasoning, { type: 'function_call', call_id: id, id: 'fc_9' }] });
  });

  it('(b) stream: summary deltas to onReasoning, calls named then streamed by output_index, call_ids kept, reasoning items captured with encrypted_content', async () => {
    const item1 = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' };
    const item2 = { id: 'fc_2', type: 'function_call', status: 'completed', call_id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' };
    const reasoning = { id: 'rs_9', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'ENC9' };
    const stream = sseEvents([
      { type: 'response.created', response: { id: 'resp_1', model: MODEL, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_9', type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...item1, status: 'in_progress', arguments: '' } },
      { type: 'response.output_item.added', output_index: 2, item: { ...item2, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_2', delta: '{"path":"b"}' },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '"a"}' },
      { type: 'response.output_item.done', output_index: 1, item: item1 },
      { type: 'response.output_item.done', output_index: 2, item: item2 },
      { type: 'response.completed', response: { id: 'resp_1', model: MODEL, status: 'completed', output: [reasoning, item1, item2], usage: USAGE } },
    ]);
    const f = scriptedFetch([{ status: 200, body: splitEvery(stream, 29) }]);
    const h = hooks();
    const res = await createOpenAiProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r) }));
    expect(h.reasoning).toEqual(['Plan']);
    expect(h.calls).toEqual([
      { index: 0, id: 'call_1', name: 'read_file', fragment: '' },
      { index: 1, id: 'call_2', name: 'read_file', fragment: '' },
      { index: 0, id: 'call_1', name: 'read_file', fragment: '{"path":' },
      { index: 1, id: 'call_2', name: 'read_file', fragment: '{"path":"b"}' },
      { index: 0, id: 'call_1', name: 'read_file', fragment: '"a"}' },
    ]);
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a' }, rawJson: '{"path":"a"}', id: 'call_1' },
      { name: 'read_file', input: { path: 'b' }, rawJson: '{"path":"b"}', id: 'call_2' },
    ]);
    expect(res.providerState).toEqual({
      provider: 'openai',
      model: MODEL,
      data: { output: [reasoning, { type: 'function_call', call_id: 'call_1', id: 'fc_1' }, { type: 'function_call', call_id: 'call_2', id: 'fc_2' }] },
    });
    expect(res.stopReason).toBe('tool_calls');
    expect(f.calls[0]!.body['prompt_cache_key']).toBe('sess-1');
  });

  it('a reasoning item without encrypted_content is not replayable and no state is kept; a legacy request keeps no ids', async () => {
    const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' };
    const stream = sseEvents([
      { type: 'response.output_item.added', output_index: 1, item },
      { type: 'response.completed', response: { id: 'r', model: MODEL, status: 'completed', output: [{ id: 'rs_1', type: 'reasoning', summary: [] }, item], usage: USAGE } },
    ]);
    const f = scriptedFetch([
      { status: 200, body: stream },
      { status: 200, body: stream },
    ]);
    const p = createOpenAiProvider(cfg, providerDeps(f.fetch).deps);
    const agent = await p.generate(agentReq(), genOpts());
    expect(agent.toolCalls[0]!.id).toBe('call_1');
    expect('providerState' in agent).toBe(false);
    const legacy = await p.generate(request(), genOpts());
    expect(legacy.toolCalls).toEqual([{ name: 'read_file', input: {}, rawJson: '{}' }]);
  });

  it('(c) state from another provider, another configured model, or with replay off is not sent', () => {
    const sent = (req: GenerateRequest): boolean => buildResponsesBody(cfg, req).input.some((i) => i['type'] === 'reasoning');
    expect(sent(agentReq(transcript(STATE)))).toBe(true);
    expect(sent(agentReq(transcript({ ...STATE, model: 'gpt-6-astra' })))).toBe(false);
    expect(sent(agentReq(transcript({ ...STATE, provider: 'openrouter' })))).toBe(false);
    expect(sent(agentReq(transcript(STATE), { replayReasoning: false }))).toBe(false);
  });

  it('(d) a second function_call item with a different call_id at one output_index is a second call', async () => {
    const a = { id: 'fc_a', type: 'function_call', call_id: 'call_x', name: 'read_file', arguments: '' };
    const b = { id: 'fc_b', type: 'function_call', call_id: 'call_y', name: 'read_file', arguments: '' };
    const stream = sseEvents([
      { type: 'response.output_item.added', output_index: 0, item: a },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a"}' },
      { type: 'response.output_item.added', output_index: 0, item: b },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"b"}' },
      { type: 'response.completed', response: { id: 'r', model: MODEL, status: 'completed', usage: USAGE } },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createOpenAiProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    expect(res.toolCalls.map((c) => [c.id, c.input])).toEqual([
      ['call_x', { path: 'a' }],
      ['call_y', { path: 'b' }],
    ]);
  });
});

describe('openai chat-surface agent wire (openai-compat quirks)', () => {
  it('(a) golden body: tool_calls with ids, tool messages, prompt_cache_key, no parallel_tool_calls; nothing replayed', () => {
    const chatCfg = providerCfg({ model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' });
    const body = buildChatBody(OPENAI_CHAT_QUIRKS, chatCfg, agentReq(transcript(STATE)));
    const golden = {
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are JevCode.' },
        { role: 'user', content: TASK },
        {
          role: 'assistant',
          content: PROSE,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
            { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"test/a.test.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: RESULT_A },
        { role: 'tool', tool_call_id: 'call_b', content: RESULT_B },
        { role: 'user', content: NOTE },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 16384,
      tools: [{ type: 'function', function: { name: 'read_file', description: READ_TOOL.description, parameters: READ_TOOL.inputSchema, strict: true } }],
      tool_choice: 'auto',
      store: false,
      prompt_cache_key: 'sess-1',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });
});
