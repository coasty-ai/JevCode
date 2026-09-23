/**
 * AGENT-LOOP-DESIGN §6.2 (Gemini row): the agent wire of gemini.ts — S2 tests (a) golden body, (b) stream (thought
 * summaries to onReasoning, ids and thoughtSignature kept), (c) replay filtering, (d) calls arrive whole, one per part.
 * Not verifiable live with this project's key (403 API_KEY_SERVICE_BLOCKED): the fixtures are built to the reference.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, GenerateRequest } from '../../../src/core/types.js';
import { buildGeminiBody, createGeminiProvider } from '../../../src/provider/gemini.js';
import { geminiToolSchema } from '../../../src/provider/schema.js';
import { NOTE, PROSE, READ_TOOL, RESULT_A, RESULT_B, TASK, agentReq, hooks, sseData, transcript } from './agent-helpers.js';
import { genOpts, providerCfg, providerDeps, request, scriptedFetch } from './helpers.js';

const MODEL = 'gemini-3.8-flash';
const cfg = providerCfg({ model: MODEL, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', priced: true });
const STATE = { provider: 'gemini' as const, model: MODEL, data: { calls: ['SIG-A', null], text: null } };
const USAGE = { promptTokenCount: 300, candidatesTokenCount: 20, thoughtsTokenCount: 5 };

const modelTurn = (req: GenerateRequest): object => buildGeminiBody(cfg, req).contents[1]!;

describe('gemini agent wire (AGENT-LOOP-DESIGN §6.2)', () => {
  it('(a) golden body: functionCall {id, name, args} with its thoughtSignature, functionResponse by id with output / error, thinkingLevel per turn, includeThoughts', () => {
    const body = buildGeminiBody(cfg, agentReq(transcript(STATE)));
    const golden = {
      contents: [
        { role: 'user', parts: [{ text: TASK }] },
        {
          role: 'model',
          parts: [
            { text: PROSE },
            { functionCall: { id: 'call_a', name: 'read_file', args: { path: 'src/a.ts' } }, thoughtSignature: 'SIG-A' },
            { functionCall: { id: 'call_b', name: 'read_file', args: { path: 'test/a.test.ts' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'call_a', name: 'read_file', response: { output: RESULT_A } } },
            { functionResponse: { id: 'call_b', name: 'read_file', response: { error: RESULT_B } } },
            { text: NOTE },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } },
      systemInstruction: { parts: [{ text: 'You are JevCode.' }] },
      tools: [{ functionDeclarations: [{ name: 'read_file', description: READ_TOOL.description, parametersJsonSchema: geminiToolSchema(READ_TOOL.inputSchema) }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('includeThoughts on every agent request of a thinking family (2.5 with its budget, 3.x with no effort); never on a legacy request', () => {
    const flash25 = providerCfg({ model: 'gemini-2.5-flash', baseUrl: cfg.baseUrl });
    expect(buildGeminiBody(flash25, agentReq()).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    expect(buildGeminiBody(cfg, agentReq(transcript(), {}, { reasoning: { enabled: false } })).generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(buildGeminiBody(cfg, request({ reasoning: { effort: 'low' } })).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('(b) stream: thought summaries to onReasoning, ids and thoughtSignature kept per call', async () => {
    const stream = sseData(
      [
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Plan', thought: true }] } }], usageMetadata: { promptTokenCount: 300 }, modelVersion: MODEL, responseId: 'r1' },
        {
          candidates: [
            {
              index: 0,
              content: {
                role: 'model',
                parts: [
                  { text: 'Reading.' },
                  { functionCall: { id: 'fc-1', name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG1' },
                  { functionCall: { id: 'fc-2', name: 'read_file', args: { path: 'b' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: USAGE,
          modelVersion: MODEL,
          responseId: 'r1',
        },
      ],
      '',
    );
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const h = hooks();
    const res = await createGeminiProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r) }));
    expect(h.reasoning).toEqual(['Plan']);
    expect(h.calls).toEqual([
      { index: 0, id: 'fc-1', name: 'read_file', fragment: '{"path":"a"}' },
      { index: 1, id: 'fc-2', name: 'read_file', fragment: '{"path":"b"}' },
    ]);
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a' }, rawJson: '{"path":"a"}', id: 'fc-1' },
      { name: 'read_file', input: { path: 'b' }, rawJson: '{"path":"b"}', id: 'fc-2' },
    ]);
    expect(res.providerState).toEqual({ provider: 'gemini', model: MODEL, data: { calls: ['SIG1', null], text: null } });
    expect(res.stopReason).toBe('tool_calls');
  });

  it('a legacy request keeps neither ids nor signatures', async () => {
    const stream = sseData(
      [{ candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'fc-1', name: 'propose_action', args: {} }, thoughtSignature: 'S' }] }, finishReason: 'STOP' }], usageMetadata: USAGE }],
      '',
    );
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createGeminiProvider(cfg, providerDeps(f.fetch).deps).generate(request(), genOpts());
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input: {}, rawJson: '{}' }]);
    expect('providerState' in res).toBe(false);
  });

  it('(c) signatures from another provider, another configured model, or with replay off are not sent', () => {
    const signed = (req: GenerateRequest): boolean => JSON.stringify(modelTurn(req)).includes('SIG-A');
    expect(signed(agentReq(transcript(STATE)))).toBe(true);
    expect(signed(agentReq(transcript({ ...STATE, model: 'gemini-3.1-pro' })))).toBe(false);
    expect(signed(agentReq(transcript({ ...STATE, provider: 'openai' })))).toBe(false);
    expect(signed(agentReq(transcript(STATE), { replayReasoning: false }))).toBe(false);
  });

  it('a Gemini 3 turn replayed without its signatures carries the documented stand-in on its first call only; a 2.5 model gets none', () => {
    const skip = { thoughtSignature: 'skip_thought_signature_validator' };
    expect(modelTurn(agentReq(transcript(STATE), { replayReasoning: false }))).toEqual({
      role: 'model',
      parts: [
        { text: PROSE },
        { functionCall: { id: 'call_a', name: 'read_file', args: { path: 'src/a.ts' } }, ...skip },
        { functionCall: { id: 'call_b', name: 'read_file', args: { path: 'test/a.test.ts' } } },
      ],
    });
    const flash25 = providerCfg({ model: 'gemini-2.5-flash', baseUrl: cfg.baseUrl });
    expect(JSON.stringify(buildGeminiBody(flash25, agentReq(transcript())).contents)).not.toContain('thoughtSignature');
  });

  it('an empty model turn goes out as a placeholder text, never as empty parts', () => {
    const t: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: NOTE }] },
    ];
    expect(modelTurn(agentReq(t))).toEqual({ role: 'model', parts: [{ text: '(no content)' }] });
  });

  it('(d) calls arrive whole, one per part: two unnamed-id calls are two calls, and a made-up id never goes back on the wire', async () => {
    const stream = sseData(
      [
        {
          candidates: [
            {
              index: 0,
              content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }, { functionCall: { name: 'read_file', args: { path: 'b' } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: USAGE,
        },
      ],
      '',
    );
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createGeminiProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    const ids = res.toolCalls.map((c) => c.id!);
    expect(ids[0]).toMatch(/^jc_/);
    expect(new Set(ids).size).toBe(2);
    const next: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      { role: 'assistant', content: res.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id!, name: c.name, input: c.input })) },
      { role: 'user', content: res.toolCalls.map((c) => ({ type: 'tool_result' as const, toolUseId: c.id!, name: c.name, content: 'ok' })) },
    ];
    const wire = JSON.stringify(buildGeminiBody(cfg, agentReq(next)).contents);
    expect(wire).not.toContain('jc_');
    expect(wire).toContain('"functionResponse":{"name":"read_file","response":{"output":"ok"}}');
  });
});
