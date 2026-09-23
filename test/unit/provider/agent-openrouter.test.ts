/**
 * AGENT-LOOP-DESIGN §6.2 (OpenRouter row), §6.5 and the S2 amendment: the agent wire of openrouter.ts — S2 tests (a) golden
 * body, (b) interleaved stream, (c) replay only to the same provider + configured model, (d) a changed id at one index.
 */
import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '../../../src/core/types.js';
import { OPENROUTER_AGENT_PREFS, buildOpenRouterBody, createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { NOTE, PROSE, READ_TOOL, RESULT_A, RESULT_B, TASK, agentReq, hooks, sseData, transcript } from './agent-helpers.js';
import { GLM_PRICING, genOpts, openrouterCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const GLM = 'z-ai/glm-5.3-flash';
const cfg = openrouterCfg({ model: GLM, pricing: GLM_PRICING, priced: true });
const DETAILS = [{ type: 'reasoning.text', text: 'Both files matter.', signature: 'sig-or', format: 'unknown', index: 0 }];
const STATE = { provider: 'openrouter' as const, model: GLM, data: { reasoning_details: DETAILS } };

const chunk = (delta: object, extra: object = {}): object => ({ id: 'gen-agent-1', model: GLM, provider: 'Together', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const USAGE = { id: 'gen-agent-1', model: GLM, provider: 'Together', choices: [], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.00012, completion_tokens_details: { reasoning_tokens: 12 } } };

describe('openrouter agent wire (AGENT-LOOP-DESIGN §6.2)', () => {
  it('(a) golden body: native tool_calls with ids, reasoning_details replayed, tool messages then the text, latency routing, session_id, no parallel_tool_calls', () => {
    const body = buildOpenRouterBody(cfg, agentReq(transcript(STATE)));
    const golden = {
      model: GLM,
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
          reasoning_details: DETAILS,
        },
        { role: 'tool', tool_call_id: 'call_a', content: RESULT_A },
        { role: 'tool', tool_call_id: 'call_b', content: RESULT_B },
        { role: 'user', content: NOTE },
      ],
      stream: true,
      max_tokens: 16384,
      usage: { include: true },
      tools: [{ type: 'function', function: { name: 'read_file', description: READ_TOOL.description, parameters: READ_TOOL.inputSchema, strict: true } }],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      provider: { require_parameters: false, sort: 'latency' },
      session_id: 'sess-1',
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
    expect(OPENROUTER_AGENT_PREFS).toEqual({ requireParameters: false, sort: 'latency' });
  });

  it('one call per turn sends parallel_tool_calls false; {enabled: false} is never sent; caller prefs win; an assistant turn with only calls has content null', () => {
    const one = buildOpenRouterBody(cfg, agentReq(transcript(), { parallelToolCalls: false }, { reasoning: { enabled: false }, providerPrefs: { requireParameters: true, order: ['friendli'] } }));
    expect(one.parallel_tool_calls).toBe(false);
    expect('reasoning' in one).toBe(false);
    expect(one.provider).toEqual({ require_parameters: true, order: ['friendli'] });
    const t = transcript();
    t[1] = { role: 'assistant', content: t[1]!.content.filter((b) => b.type === 'tool_use') };
    const quiet = buildOpenRouterBody(cfg, agentReq(t, { cacheKey: '' }));
    expect(quiet.messages[2]).toMatchObject({ role: 'assistant', content: null });
    expect('session_id' in quiet).toBe(false);
  });

  it('(b) interleaved stream: ids, names, arguments, onToolCall order, onReasoning, reasoning_details merged by index', async () => {
    const stream = sseData([
      chunk({ role: 'assistant', reasoning: 'Think', reasoning_details: [{ type: 'reasoning.text', text: 'Think', index: 0, format: 'unknown' }] }),
      chunk({ reasoning: ' more', reasoning_details: [{ type: 'reasoning.text', text: ' more', index: 0 }, { type: 'reasoning.encrypted', data: 'abc', index: 1 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', signature: 'sig-1', index: 0 }, { type: 'reasoning.encrypted', data: 'def', index: 1 }] }),
      chunk({ content: 'Reading.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"src/a.ts"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: 'th":"b.ts"}' } }] }),
      { id: 'gen-agent-1', model: GLM, provider: 'Together', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      USAGE,
    ]);
    const f = scriptedFetch([{ status: 200, body: splitEvery(stream, 17) }]);
    const h = hooks();
    const res = await createOpenRouterProvider(cfg, providerDeps(f.fetch).deps).generate(
      agentReq(),
      genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r), onToolDelta: (d) => h.toolDeltas.push(d), onDelta: (d) => h.deltas.push(d) }),
    );
    expect(h.calls).toEqual([
      { index: 0, id: 'call_a', name: 'read_file', fragment: '' },
      { index: 1, id: 'call_b', name: 'read_file', fragment: '{"pa' },
      { index: 0, id: 'call_a', name: 'read_file', fragment: '{"path":"src/a.ts"}' },
      { index: 1, id: 'call_b', name: 'read_file', fragment: 'th":"b.ts"}' },
    ]);
    expect(h.toolDeltas).toEqual(['{"pa', '{"path":"src/a.ts"}', 'th":"b.ts"}']);
    expect(h.reasoning).toEqual(['Think', ' more']);
    expect(h.deltas).toEqual(['Reading.']);
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'src/a.ts' }, rawJson: '{"path":"src/a.ts"}', id: 'call_a' },
      { name: 'read_file', input: { path: 'b.ts' }, rawJson: '{"path":"b.ts"}', id: 'call_b' },
    ]);
    expect(res.providerState).toEqual({
      provider: 'openrouter',
      model: GLM,
      data: {
        reasoning_details: [
          { type: 'reasoning.text', text: 'Think more', index: 0, format: 'unknown', signature: 'sig-1' },
          { type: 'reasoning.encrypted', data: 'abcdef', index: 1 },
        ],
      },
    });
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage.costUsd).toBe(0.00012);
    // the body that went out is the agent body
    expect(f.calls[0]!.body['session_id']).toBe('sess-1');
  });

  it('the same stream on a legacy request: no ids, no providerState (only the reasoning text is surfaced when asked for)', async () => {
    const stream = sseData([
      chunk({ reasoning: 'Think', reasoning_details: [{ type: 'reasoning.text', text: 'Think', index: 0 }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'propose_action', arguments: '{}' } }] }),
      USAGE,
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createOpenRouterProvider(cfg, providerDeps(f.fetch).deps).generate(request(), genOpts());
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input: {}, rawJson: '{}' }]);
    expect('providerState' in res).toBe(false);
  });

  it('(c) providerState from another provider, another configured model, or with replay off is not sent', () => {
    const sent = (req: GenerateRequest): boolean => 'reasoning_details' in buildOpenRouterBody(cfg, req).messages[2]!;
    expect(sent(agentReq(transcript(STATE)))).toBe(true);
    expect(sent(agentReq(transcript({ ...STATE, model: 'z-ai/glm-5.3' })))).toBe(false);
    expect(sent(agentReq(transcript({ ...STATE, provider: 'fireworks' })))).toBe(false);
    expect(sent(agentReq(transcript(STATE), { replayReasoning: false }))).toBe(false);
  });

  it('(d) two chunks at one index with different ids are two calls (agent); a legacy request keeps concatenating', async () => {
    const stream = sseData([
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_b', function: { arguments: '' } }] }),
      USAGE,
    ]);
    const h = hooks();
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createOpenRouterProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts({ onToolCall: (d) => h.calls.push(d) }));
    expect(res.toolCalls.map((c) => [c.id, c.input])).toEqual([
      ['call_a', { path: 'a' }],
      ['call_b', { path: 'b' }],
    ]);
    expect(h.calls.map((c) => c.index)).toEqual([0, 1]);
    const g = scriptedFetch([{ status: 200, body: stream }]);
    const legacy = await createOpenRouterProvider(cfg, providerDeps(g.fetch).deps).generate(request(), genOpts());
    expect(legacy.toolCalls).toEqual([{ name: 'read_file', input: null, rawJson: '{"path":"a"}{"path":"b"}' }]);
  });

  it('a call the upstream sent without an id gets a unique made-up one on an agent result', async () => {
    const stream = sseData([chunk({ tool_calls: [{ index: 0, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }), USAGE]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createOpenRouterProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    expect(res.toolCalls[0]!.id).toMatch(/^jc_[a-z0-9]+_0$/);
  });
});
