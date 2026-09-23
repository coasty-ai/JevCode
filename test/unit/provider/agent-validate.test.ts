/**
 * AGENT-LOOP-DESIGN §6.1 / slice S2 test (e): `validateGenerateRequest` (http.ts) and its two local copies (openrouter.ts,
 * anthropic.ts) accept `messages: []` exactly when `req.agent` carries a non-empty transcript, and check that transcript
 * instead; a legacy request with `messages: []` still fails, with today's message.
 */
import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../../../src/errors.js';
import type { AgentMessage, GenerateRequest, GenerateResult } from '../../../src/core/types.js';
import { createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { createFireworksProvider } from '../../../src/provider/fireworks.js';
import { createGeminiProvider } from '../../../src/provider/gemini.js';
import { messagesError } from '../../../src/provider/http.js';
import { createMetaProvider } from '../../../src/provider/meta.js';
import { createOpenAiProvider } from '../../../src/provider/openai.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { createXaiProvider } from '../../../src/provider/xai.js';
import { agentReq, transcript } from './agent-helpers.js';
import { anthropicCfg, fixture, genOpts, openrouterCfg, providerCfg, providerDeps, request, scriptedFetch } from './helpers.js';

type Gen = { generate: (req: GenerateRequest, opts: ReturnType<typeof genOpts>) => Promise<GenerateResult> };

/** each adapter with a stream it accepts, so a request that passes validation completes */
const ADAPTERS: readonly { name: string; make: (f: typeof fetch) => Gen; body: string }[] = [
  { name: 'openrouter', make: (f) => createOpenRouterProvider(openrouterCfg({ model: 'z-ai/glm-5.3-flash' }), providerDeps(f).deps), body: fixture('openrouter-text.sse') },
  { name: 'anthropic', make: (f) => createAnthropicProvider(anthropicCfg(), providerDeps(f).deps), body: fixture('anthropic-text.sse') },
  { name: 'openai', make: (f) => createOpenAiProvider(providerCfg({ model: 'gpt-5.6-luna' }), providerDeps(f).deps), body: fixture('openai-responses-tool.sse') },
  { name: 'openai-chat', make: (f) => createOpenAiProvider(providerCfg({ model: 'gpt-4.1-mini' }), providerDeps(f).deps, { api: 'chat' }), body: fixture('openai-chat-tool.sse') },
  { name: 'xai', make: (f) => createXaiProvider(providerCfg({ model: 'grok-4.7' }), providerDeps(f).deps), body: fixture('xai-tool.sse') },
  { name: 'fireworks', make: (f) => createFireworksProvider(providerCfg({ model: 'accounts/fireworks/models/glm-5p3-flash' }), providerDeps(f).deps), body: fixture('fireworks-tool.sse') },
  { name: 'meta', make: (f) => createMetaProvider(providerCfg({ model: 'muse-spark-1.3' }), providerDeps(f).deps), body: fixture('meta-tool.json') },
  { name: 'gemini', make: (f) => createGeminiProvider(providerCfg({ model: 'gemini-3.8-flash' }), providerDeps(f).deps), body: fixture('gemini-tool.sse') },
];

async function rejection(p: Promise<unknown>): Promise<ProviderHttpError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProviderHttpError);
  return e as ProviderHttpError;
}

describe('agent requests pass validation with messages: [] (S2 test e)', () => {
  for (const a of ADAPTERS) {
    it(`${a.name}: an agent request with messages [] is sent; a legacy one with [] still fails before any fetch`, async () => {
      const f = scriptedFetch([{ status: 200, body: a.body }]);
      await a.make(f.fetch).generate(agentReq(), genOpts());
      expect(f.calls.length).toBe(1);

      const g = scriptedFetch([]);
      const e = await rejection(a.make(g.fetch).generate(request({ messages: [] }), genOpts()));
      expect(e.status).toBe(0);
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/invalid GenerateRequest: messages is empty$/);
      expect(g.calls.length).toBe(0);

      // an agent request with an empty transcript is not a legacy request either
      const h = scriptedFetch([]);
      const e2 = await rejection(a.make(h.fetch).generate(agentReq([]), genOpts()));
      expect(e2.message).toMatch(/agent\.messages is empty$/);
      expect(h.calls.length).toBe(0);
    });
  }
});

describe('messagesError: the agent transcript is checked against what every wire rejects', () => {
  const t = transcript();
  const bad = (messages: AgentMessage[]): string | null => messagesError(agentReq(messages));

  it('accepts the two-turn transcript and a one-message task', () => {
    expect(bad(t)).toBeNull();
    expect(bad([t[0]!])).toBeNull();
  });

  it('a legacy request keeps its one rule', () => {
    expect(messagesError(request())).toBeNull();
    expect(messagesError(request({ messages: [] }))).toBe('messages is empty');
  });

  it('rejects a transcript that does not start and end with a user message', () => {
    expect(bad([t[1]!, t[2]!])).toBe('agent.messages must start with a user message');
    expect(bad([t[0]!, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }])).toBe('agent.messages must end with a user message');
  });

  it('rejects an unanswered tool_use, a result that answers nothing, a duplicate result and a reused id', () => {
    const onlyA: AgentMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_a', name: 'read_file', content: 'x' }] };
    expect(bad([t[0]!, t[1]!, onlyA])).toBe('agent.messages[2]: tool_use call_b has no tool_result');
    const stray: AgentMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_z', name: 'read_file', content: 'x' }] };
    expect(bad([t[0]!, stray])).toBe('agent.messages[1]: tool_result call_z answers no tool_use of the assistant message before it');
    const twice: AgentMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_a', name: 'read_file', content: 'x' },
        { type: 'tool_result', toolUseId: 'call_a', name: 'read_file', content: 'x' },
      ],
    };
    expect(bad([t[0]!, t[1]!, twice])).toBe('agent.messages[2]: tool_result call_a appears twice');
    expect(bad([...t, t[1]!, t[2]!])).toBe('agent.messages[3]: tool_use id call_a is not unique');
    // two assistant turns in a row: the first one's calls were never answered
    expect(bad([t[0]!, t[1]!, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, t[0]!])).toBe('agent.messages[2]: tool_use call_a has no tool_result');
  });

  it('rejects empty content, an empty call id and a malformed providerState', () => {
    expect(bad([{ role: 'user', content: [] }])).toBe('agent.messages[0] has no content');
    // every wire drops empty text: a user turn of nothing else would go out as content [] / parts [] (a 400) or vanish
    expect(bad([{ role: 'user', content: [{ type: 'text', text: '' }] }])).toBe('agent.messages[0] has only empty text');
    expect(bad([t[0]!, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '' }] }])).toBe('agent.messages[2] has only empty text');
    // a result with an empty note, and an empty assistant reply (sent as a placeholder where a wire needs one), are fine
    expect(bad([t[0]!, t[1]!, { ...t[2]!, content: [...t[2]!.content.slice(0, 2), { type: 'text', text: '' }] } as AgentMessage])).toBeNull();
    expect(bad([t[0]!, { role: 'assistant', content: [{ type: 'text', text: '' }] }, t[0]!])).toBeNull();
    const noId: AgentMessage = { role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'read_file', input: {} }] };
    expect(bad([t[0]!, noId, t[0]!])).toBe('agent.messages[1]: a tool_use needs a non-empty id and name');
    const state = { role: 'assistant', content: [{ type: 'text', text: 'x' }], providerState: { data: 1 } } as unknown as AgentMessage;
    expect(bad([t[0]!, state, t[0]!])).toBe('agent.messages[1]: providerState needs provider and model');
  });

  it('the error reaches the caller as a non-retryable status-0 ProviderHttpError naming the message', async () => {
    const f = scriptedFetch([]);
    const p = createOpenRouterProvider(openrouterCfg(), providerDeps(f.fetch).deps);
    const e = await rejection(p.generate(agentReq([t[0]!, t[1]!]), genOpts()));
    expect(e.message).toBe('invalid GenerateRequest: agent.messages must end with a user message');
    expect(e.status).toBe(0);
    expect(f.calls.length).toBe(0);
  });
});
