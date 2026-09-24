/**
 * provider/gemini.ts. The stream fixtures are HAND-BUILT to ai.google.dev/api/generate-content (this project's
 * GEMINI_API_KEY cannot reach the API: its project has the service disabled). The 403 fixture, by contrast, is the
 * recorded live answer, so the error path is verified against the real envelope.
 */
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { PROPOSE_ACTION_TOOL } from '../../../src/provider/actions.js';
import { buildGeminiBody, createGeminiProvider, geminiThinkingBudget, geminiThinkingConfig, geminiThinkingLevels, listGeminiModels } from '../../../src/provider/gemini.js';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { PROPOSE_TOOL, fixture, genOpts, providerCfg, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const cfg = (over = {}) => providerCfg({ model: 'gemini-3.8-flash', apiKey: 'AIzaSyTest0000000000000000000000000000', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', ...over });
const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('gemini: the request body', () => {
  it('moves the system prompt to systemInstruction, renames assistant→model, groups the declarations and forces one function by name', () => {
    const body = buildGeminiBody(
      cfg(),
      request({
        messages: [
          { role: 'user', content: 'Fix the bug.' },
          { role: 'assistant', content: 'Understood.' },
        ],
        tools: [PROPOSE_TOOL],
        toolChoice: { name: 'propose_action' },
        maxTokens: 4096,
        seed: 7,
        temperature: 0.4,
      }),
    );
    expect(body).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Fix the bug.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ],
      systemInstruction: { parts: [{ text: 'You are the generator.' }] },
      tools: [{ functionDeclarations: [{ name: 'propose_action', description: PROPOSE_TOOL.description, parametersJsonSchema: PROPOSE_TOOL.inputSchema }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['propose_action'] } },
      generationConfig: { maxOutputTokens: 4096, temperature: 0.4, seed: 7 },
    });
    expect(buildGeminiBody(cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: 'auto' })).toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(buildGeminiBody(cfg(), request({ tools: [PROPOSE_TOOL], toolChoice: 'required' })).toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect('systemInstruction' in buildGeminiBody(cfg(), request({ system: '' }))).toBe(false);
  });

  it("rewrites the harness's oneOf schema to anyOf, which is the only form Gemini does not silently ignore", () => {
    const body = buildGeminiBody(cfg(), request({ tools: [PROPOSE_ACTION_TOOL], toolChoice: { name: 'propose_action' } }));
    const schema = body.tools![0]!.functionDeclarations[0]!.parametersJsonSchema;
    const action = (schema['properties'] as Record<string, Record<string, unknown>>)['action']!;
    expect('oneOf' in action).toBe(false);
    expect(Array.isArray(action['anyOf'])).toBe(true);
    expect((action['anyOf'] as unknown[]).length).toBe(6);
    // everything else is copied verbatim
    expect(JSON.stringify(schema).replace(/anyOf/g, 'oneOf')).toBe(JSON.stringify(PROPOSE_ACTION_TOOL.inputSchema));
  });

  it('maps §4.12 reasoning to a level on Gemini 3 and to a budget on 2.5, never both', () => {
    expect(geminiThinkingLevels('gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(geminiThinkingLevels('gemini-2.5-flash')).toBeNull();
    // thinking cannot be switched off on Gemini 3: {enabled:false} lands on the lowest level the family has
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-3.8-flash')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-3.5-flash')).toEqual({ thinkingLevel: 'minimal' });
    expect(geminiThinkingConfig({ effort: 'medium' }, 'gemini-3.8-flash')).toEqual({ thinkingLevel: 'medium' });
    // 2.5: a budget, with the pro floor of 128 respected
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-2.5-pro')).toEqual({ thinkingBudget: 128 });
    expect(geminiThinkingConfig({ effort: 'medium' }, 'gemini-2.5-flash')).toEqual({ thinkingBudget: 8192 });
    // an explicit budget is always a budget
    expect(geminiThinkingConfig({ maxTokens: 4096 }, 'gemini-3.8-flash')).toEqual({ thinkingBudget: 4096 });
    expect(buildGeminiBody(cfg(), request({ reasoning: { effort: 'low' } })).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('resolves a 2.5 budget through the shared effort chain, so the highest efforts get the highest budget', () => {
    expect(geminiThinkingBudget('none')).toBe(0);
    expect(geminiThinkingBudget('minimal')).toBe(1024);
    expect(geminiThinkingBudget('low')).toBe(1024);
    expect(geminiThinkingBudget('medium')).toBe(8192);
    expect(geminiThinkingBudget('high')).toBe(24_576);
    // the table has no `xhigh` / `max`: EFFORT_CHAINS walks DOWN to `high`, never to the near-minimum `low`
    expect(geminiThinkingBudget('xhigh')).toBe(24_576);
    expect(geminiThinkingBudget('max')).toBe(24_576);
  });
});

describe('gemini: the stream', () => {
  it('collects text, a functionCall part and usageMetadata (thoughts billed as output, cached prompt split out)', async () => {
    const f = scriptedFetch([{ status: 200, body: splitEvery(fixture('gemini-tool.sse'), 29) }]);
    const { deps } = providerDeps(f.fetch);
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    const res = await createGeminiProvider(cfg({ priced: true }), deps).generate(
      request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }),
      genOpts({ onDelta: (t) => deltas.push(t), onToolDelta: (t) => toolDeltas.push(t) }),
    );
    // the `thought: true` part is measured, never rendered
    expect(deltas).toEqual(['Listing the files.']);
    expect(res.text).toBe('Listing the files.');
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input: { goal: 'list files', command: 'ls -la' }, rawJson: '{"goal":"list files","command":"ls -la"}' }]);
    // arguments arrive as an object in one part, so onToolDelta fires exactly once with the serialisation
    expect(toolDeltas).toEqual(['{"goal":"list files","command":"ls -la"}']);
    expect(res.stopReason).toBe('tool_calls');
    expect(res.model).toBe('gemini-3.8-flash');
    expect(res.generationId).toBe('aBcD1234');
    expect(res.usage).toEqual({
      inputTokens: 240,
      outputTokens: 18 + 14,
      costUsd: ((240 - 64) * 2 + 64 * 0.2 + 32 * 10) / 1e6,
      calls: 1,
      reasoningTokens: 14,
      // contract 1.9 (Fastlane) §3.4: `cachedContentTokenCount`, stated on its own beside the input total it is part of
      cacheReadTokens: 64,
    });
    expect(f.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(f.calls[0]!.headers['x-goog-api-key']).toBe(cfg().apiKey);
  });

  it('bills a built-in tool\'s prompt tokens as input, not as output', async () => {
    const chunk = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, toolUsePromptTokenCount: 40, totalTokenCount: 155 },
      modelVersion: 'gemini-3.8-flash',
      responseId: 'r-1',
    };
    const f = scriptedFetch([{ status: 200, body: `data: ${JSON.stringify(chunk)}\n\n` }]);
    const { deps } = providerDeps(f.fetch);
    const res = await createGeminiProvider(cfg({ priced: true }), deps).generate(request(), genOpts());
    expect(res.usage.inputTokens).toBe(140);
    expect(res.usage.outputTokens).toBe(15);
  });

  it('maps MAX_TOKENS to the `length` vocabulary the harness reads', async () => {
    const f = scriptedFetch([sse('gemini-length.sse')]);
    const { deps } = providerDeps(f.fetch);
    const res = await createGeminiProvider(cfg({ priced: true }), deps).generate(request({ maxTokens: 6 }), genOpts());
    expect(res.stopReason).toBe('length');
    expect(res.text).toBe('I will start by listing');
    expect(res.usage.outputTokens).toBe(6 + 26);
  });

  it('turns a prompt block (HTTP 200, no candidates) into a non-retryable error instead of an empty success', async () => {
    const f = scriptedFetch([sse('gemini-blocked.sse')]);
    const { deps } = providerDeps(f.fetch);
    const err = await createGeminiProvider(cfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(400);
    expect((err as ProviderHttpError).retryable).toBe(false);
    expect((err as Error).message).toContain('PROHIBITED_CONTENT');
  });

  it('an abort on an open stream reports what had arrived, including the usage the chunk already carried', async () => {
    const head = fixture('gemini-tool.sse').split('"finishReason"')[0]!.split('\n\n').slice(0, 2).join('\n\n') + '\n\n';
    const f = scriptedFetch([{ status: 200, body: [head], hang: true }]);
    const { deps } = providerDeps(f.fetch);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const cancelled: CancelledGeneration[] = [];
    const p = createGeminiProvider(cfg({ priced: true }), deps).generate(request(), genOpts({ signal: ac.signal, onCancelled: (c) => cancelled.push(c) }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]!.text).toBe('Listing the files.');
    expect(cancelled[0]!.reasoningChars).toBe('Thinking about the request.'.length);
    expect(cancelled[0]!.generationId).toBe('aBcD1234');
    expect(cancelled[0]!.usage).toMatchObject({ inputTokens: 240, outputTokens: 18 });
  });

  it('maps the recorded 403 (the service is disabled for this key) with its google.rpc reason, and never retries it', async () => {
    const f = scriptedFetch([{ status: 403, body: fixture('gemini-403-blocked.json') }]);
    const { deps } = providerDeps(f.fetch);
    const err = await createGeminiProvider(cfg(), deps)
      .generate(request(), genOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(403);
    expect((err as ProviderHttpError).retryable).toBe(false);
    expect((err as Error).message).toContain('PERMISSION_DENIED API_KEY_SERVICE_BLOCKED');
    expect(f.calls.length).toBe(1);
  });

  it('a 429 RESOURCE_EXHAUSTED is retried (Google publishes no Retry-After, so the backoff schedule applies)', async () => {
    const body = JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    const f = scriptedFetch([{ status: 429, body }, { status: 200, body: fixture('gemini-tool.sse') }]);
    const { deps, sleeps } = providerDeps(f.fetch);
    const res = await createGeminiProvider(cfg({ priced: true }), deps).generate(request(), genOpts());
    expect(res.rateLimited).toBe(true);
    expect(sleeps).toEqual([500]);
  });
});

describe('gemini: the catalogue', () => {
  it('keeps only models that support generateContent', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('gemini-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listGeminiModels('AIzaSyTest0000000000000000000000000000', deps);
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash-lite', 'gemini-3.8-flash']);
    expect(models.find((m) => m.id === 'gemini-3.8-flash')).toEqual({
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      contextTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
    });
    expect(f.calls[0]!.url).toContain('/v1beta/models?pageSize=1000');
  });
});
