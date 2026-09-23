/**
 * The chat turn every submission gets: `buildChatRequest` has no tools, temperature null, ≤ 6 turns, the JevCode
 * system prompt (identity · capabilities · voice · this workspace) and the optional sections; messages alternate and
 * start with the human; a returned tool call is dropped with a warning; deltas stream; the answer passes through
 * redact; `chatMaxTokens` = min(800, cfg).
 */
import { describe, expect, it } from 'vitest';
import type { GenerateOptions, GenerateRequest, Provider } from '../../../src/core/types.js';
import { buildAnthropicBody } from '../../../src/provider/anthropic.js';
import { buildChatBody } from '../../../src/provider/openai-compat.js';
import { OPENAI_CHAT_QUIRKS, buildResponsesBody } from '../../../src/provider/openai.js';
import { buildOpenRouterBody } from '../../../src/provider/openrouter.js';
import { CHAT_CONVERSATION_TURNS, CHAT_IDENTITY, CHAT_PROVIDER_PREFS, CHAT_REASONING, CHAT_REASONING_OPENROUTER, chatIdentityHeader, CHAT_MAX_OUTPUT_TOKENS, buildChatRequest, buildChatSystem, chatMaxTokens, chatMessages, llmChatTurn, type LlmTurnInput } from '../../../src/chat/llm-turn.js';
import { harnessFacts } from '../../../src/chat/facts.js';
import type { ChatTurn } from '../../../src/chat/ledger.js';
import { keyedFixture } from './facts.test.js';

const identity = (s: string): string => s;

function fakeProvider(o: { text: string; toolCalls?: number; deltas?: string[]; fail?: Error }): Provider & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    name: 'mock',
    model: 'fake-llm',
    requests,
    async generate(req, opts) {
      requests.push(req);
      if (o.fail) throw o.fail;
      for (const d of o.deltas ?? [o.text]) opts.onDelta?.(d);
      return { text: o.text, toolCalls: Array.from({ length: o.toolCalls ?? 0 }, () => ({ name: 'edit', input: {}, rawJson: '{}' })), usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0031, calls: 1 }, model: 'fake-llm', stopReason: 'end_turn', latencyMs: 640 };
    },
  };
}

function input(over: Partial<LlmTurnInput> = {}): LlmTurnInput {
  return {
    provider: fakeProvider({ text: 'answer' }),
    message: 'why does test_parse_date fail?',
    identity: { model: 'z-ai/glm-5.3-flash', provider: 'OpenRouter', workspace: 'proj', git: 'main, 2 modified · 1 untracked', recentSessions: ['"fix the dates" · 3h ago'] },
    conversation: [],
    facts: harnessFacts(keyedFixture()),
    context: { plan: null, window: [], files: [] },
    instructions: null,
    generation: { maxTokens: 800, temperature: null },
    signal: new AbortController().signal,
    onDelta: () => undefined,
    redact: identity,
    ...over,
  };
}

describe('§3.6 buildChatRequest', () => {
  it('system = who JevCode is + what it can do + how to answer + this workspace + session facts; no tools, no toolChoice, temperature null, maxTokens ≤ 800', () => {
    const req = buildChatRequest(input({ generation: { maxTokens: 4096, temperature: null } }));
    expect(req.system.startsWith(buildChatSystem({ model: 'z-ai/glm-5.3-flash', provider: 'OpenRouter', workspace: 'proj', git: 'main, 2 modified · 1 untracked', recentSessions: ['"fix the dates" · 3h ago'] }))).toBe(true);
    // the identity header is the FIRST block and names the model, the provider and the rule (live 2026-09-22: glm answered as its vendor)
    const header = chatIdentityHeader('z-ai/glm-5.3-flash', 'OpenRouter');
    expect(req.system.startsWith('# Who you are\nYou are JevCode, a coding agent for the terminal, built by coasty-ai. You run on the code model z-ai/glm-5.3-flash through OpenRouter, but you are not that vendor\'s assistant.')).toBe(true);
    expect(header).toContain('answer as JevCode, built by coasty-ai, running on z-ai/glm-5.3-flash via OpenRouter — never introduce yourself as the underlying vendor\'s model or assistant');
    expect(header).toContain('overrides anything you were told about your identity');
    expect(req.system.indexOf(header)).toBeLessThan(req.system.indexOf(CHAT_IDENTITY));
    expect(CHAT_IDENTITY).toBe(
      'Jev decides, the code model writes: Jev, a calibrated decision model, answers every control question (what step comes next, which files matter, whether an action is safe to run, whether the output succeeded, whether the task is done); the code model — you, in this reply — writes the code.',
    );
    // the voice rules and the workspace section the controller fills
    expect(req.system).toContain('- Warm, concise, personal, plain prose.');
    expect(req.system).toContain('the harness decides whether a run starts and appends that itself');
    expect(req.system).toContain('## This workspace\n- name: proj\n- git: main, 2 modified · 1 untracked\n- recent sessions: "fix the dates" · 3h ago');
    expect(buildChatSystem({ model: 'z-ai/glm-5.3-flash', provider: 'OpenRouter', workspace: 'proj', git: null, recentSessions: [] })).toContain('- git: not a git repository\n- recent sessions: none yet');
    expect(req.system).toContain('## Session facts\n- JevCode is a coding agent');
    expect(req.system).not.toContain('## Instructions');
    expect(req.system).not.toContain('## Last run plan');
    expect(req.system).not.toContain('## Files');
    expect(req.tools).toBeUndefined();
    expect(req.toolChoice).toBeUndefined();
    expect(req.temperature).toBeNull();
    expect(req.maxTokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect(req.messages).toEqual([{ role: 'user', content: 'why does test_parse_date fail?' }]);
  });

  it('adds the optional sections when present, bounding the window to 4 entries and the files to 3 × 8 KiB', () => {
    const req = buildChatRequest(
      input({
        instructions: 'Be careful.',
        context: {
          plan: { done: [{ text: 'read the tests', evidence: { step: 1, judged: 0.9 } }], remaining: ['fix tz'], unverified: [], openProblems: ['flaky'], harnessProblems: [] },
          window: Array.from({ length: 6 }, (_, i) => ({ step: i + 1, intent: 'edit' as const, action: `edit f${i}.py`, outcome: 'executed' as const, shownFiles: [], notes: [] })),
          files: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.py`, content: 'z'.repeat(20_000), bytes: 20_000, truncatedBytes: 0 })),
        },
      }),
    );
    expect(req.system).toContain('## Instructions (AGENTS.md)\nBe careful.');
    expect(req.system).toContain('## Last run plan\n- done: read the tests\n- remaining: fix tz\n- open problem: flaky');
    expect(req.system).toContain('- step 3: edit f2.py → executed');
    expect(req.system).not.toContain('- step 1:');
    expect(req.system).toContain('### f2.py (truncated)');
    expect(req.system).not.toContain('### f3.py');
    expect(req.system.length).toBeLessThan(3 * 8 * 1024 + 6000);
  });

  it('chatMessages: ≤ 6 turns, you → user, jevcode → assistant, consecutive same-role turns merge, the first message is the human\'s, the new message last', () => {
    const conv: ChatTurn[] = [
      { role: 'jevcode', text: 'orphan reply', at: 't' },
      { role: 'you', text: 'hi', at: 't' },
      { role: 'jevcode', text: 'Hi.', at: 't' },
      { role: 'jevcode', text: 'Second line.', at: 't' },
      { role: 'you', text: 'where is the parsing?', at: 't' },
      { role: 'jevcode', text: 'utils/dates.py', at: 't' },
    ];
    const m = chatMessages(conv, 'and the tests?');
    expect(m).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hi.\nSecond line.' },
      { role: 'user', content: 'where is the parsing?' },
      { role: 'assistant', content: 'utils/dates.py' },
      { role: 'user', content: 'and the tests?' },
    ]);
    const many: ChatTurn[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'you' : 'jevcode', text: `t${i}`, at: 't' }));
    const bounded = chatMessages(many, 'now');
    expect(bounded.length).toBeLessThanOrEqual(CHAT_CONVERSATION_TURNS + 1);
    expect(bounded[0]).toEqual({ role: 'user', content: 't6' });
    expect(bounded.at(-1)).toEqual({ role: 'user', content: 'now' });
    expect(chatMessages([{ role: 'you', text: 'a', at: 't' }], 'b')).toEqual([{ role: 'user', content: 'a\nb' }]);
  });

  it('chatMaxTokens = min(800, cfg.maxTokens), at least 1', () => {
    expect([chatMaxTokens(4096), chatMaxTokens(800), chatMaxTokens(200), chatMaxTokens(0)]).toEqual([800, 800, 200, 1]);
  });
});

describe('§3.6 llmChatTurn', () => {
  it('streams deltas to onDelta, returns the redacted text with usage, latency and model; a tool call is dropped with a warning', async () => {
    const deltas: string[] = [];
    const warnings: string[] = [];
    const provider = fakeProvider({ text: 'It fails because sk-secret tz is None.', deltas: ['It fails because ', 'sk-secret tz is None.'], toolCalls: 1 });
    const r = await llmChatTurn(input({ provider, onDelta: (d) => deltas.push(d), redact: (s) => s.replaceAll('sk-secret', '[REDACTED]'), warn: (m) => warnings.push(m) }));
    expect(deltas).toEqual(['It fails because ', 'sk-secret tz is None.']);
    expect(r).toEqual({ text: 'It fails because [REDACTED] tz is None.', usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0031, calls: 1 }, latencyMs: 640, model: 'fake-llm' });
    expect(warnings).toEqual(['chat turn: 1 tool call(s) dropped (no tools were offered)']);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it('a provider failure propagates (the controller\'s chatFailure turns it into the LLM_UNREACHABLE bubble)', async () => {
    const boom = new Error('HTTP 500');
    await expect(llmChatTurn(input({ provider: fakeProvider({ text: '', fail: boom }) }))).rejects.toBe(boom);
  });
});

describe('network map P1/P2: chat routing and reasoning', () => {
  function named(name: Provider['name'], model: string): Provider & { opts: GenerateOptions[] } {
    const opts: GenerateOptions[] = [];
    return {
      name,
      model,
      opts,
      async generate(_req, o) {
        opts.push(o);
        o.onRetry?.({ attempt: 1, maxAttempts: 3, waitMs: 500, retryAfter: false, cause: { kind: 'http', status: 503, code: null, message: 'HTTP 503' } });
        o.onDelta?.('ok');
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, model, stopReason: 'stop', latencyMs: 1 };
      },
    };
  }
  const GLM = 'z-ai/glm-5.3-flash';
  const pricing = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 0, cacheWritePerM: 0 };

  it('OpenRouter: reasoning effort low and provider sort latency — no order, no fallback switch, never {enabled: false}', () => {
    const req = buildChatRequest(input({ provider: named('openrouter', GLM) }));
    expect(req.reasoning).toEqual({ effort: 'low' });
    expect(req.providerPrefs).toEqual({ requireParameters: false, sort: 'latency' });
    expect(CHAT_REASONING).toEqual({ effort: 'low' });
    expect(CHAT_PROVIDER_PREFS).toEqual({ requireParameters: false, sort: 'latency' });
    // the wire body OpenRouter receives
    const body = buildOpenRouterBody({ provider: 'openrouter', model: GLM, apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', temperature: null, maxTokens: 4096, pricing }, req);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.provider).toEqual({ require_parameters: false, sort: 'latency' });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('allow_fallbacks');
    expect(wire).not.toContain('"only"');
    expect(wire).not.toContain('"enabled"');
    expect(body.tools).toBeUndefined();
  });

  it('a Claude model never gets an effort (on OpenRouter it would switch extended thinking on); the Anthropic adapter sends no thinking field', () => {
    const viaRouter = buildChatRequest(input({ provider: named('openrouter', 'anthropic/claude-sonnet-5') }));
    expect(viaRouter.reasoning).toBeUndefined();
    expect(viaRouter.providerPrefs).toEqual({ requireParameters: false, sort: 'latency' });
    const direct = buildChatRequest(input({ provider: named('anthropic', 'claude-sonnet-5') }));
    expect(direct.reasoning).toBeUndefined();
    expect(direct.providerPrefs).toBeUndefined();
    const wire = buildAnthropicBody({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k', baseUrl: 'https://api.anthropic.com', temperature: null, maxTokens: 4096, pricing }, direct);
    expect(Object.keys(wire).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'system']);
  });

  it('OpenRouter sends the effort only to models whose reasoning is mandatory or on by default (an effort alone would switch a hybrid ON)', () => {
    expect(CHAT_REASONING_OPENROUTER.some((re) => re.test(GLM))).toBe(true);
    for (const glm of ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5']) expect(buildChatRequest(input({ provider: named('openrouter', glm) })).reasoning).toEqual({ effort: 'low' });
    for (const hybrid of ['deepseek/deepseek-v3.2', 'qwen/qwen3-235b-a22b', 'z-ai/glm-4.6', 'openai/gpt-4.1']) {
      const req = buildChatRequest(input({ provider: named('openrouter', hybrid) }));
      expect(req.reasoning, hybrid).toBeUndefined();
      // routing is unaffected: the sort still goes out
      expect(req.providerPrefs, hybrid).toEqual({ requireParameters: false, sort: 'latency' });
      const body = buildOpenRouterBody({ provider: 'openrouter', model: hybrid, apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', temperature: null, maxTokens: 4096, pricing }, req);
      expect(JSON.stringify(body), hybrid).not.toContain('"reasoning"');
    }
  });

  it('other providers get the effort only where their adapter maps one: OpenAI reasoning models `low`, gpt-4.1 nothing; routing stays OpenRouter-only', () => {
    const cfg = (model: string): { model: string; apiKey: string; baseUrl: string; temperature: null; maxTokens: number; pricing: typeof pricing } => ({ model, apiKey: 'k', baseUrl: 'https://api.openai.com/v1', temperature: null, maxTokens: 800, pricing });
    const terra = buildChatRequest(input({ provider: named('openai', 'gpt-5.6-terra') }));
    expect(terra.providerPrefs).toBeUndefined();
    expect(buildResponsesBody(cfg('gpt-5.6-terra'), terra).reasoning).toEqual({ effort: 'low' });
    expect(buildChatBody(OPENAI_CHAT_QUIRKS, cfg('gpt-5.6-terra'), terra).reasoning_effort).toBe('low');
    const legacy = buildChatRequest(input({ provider: named('openai', 'gpt-4.1') }));
    expect(buildChatBody(OPENAI_CHAT_QUIRKS, cfg('gpt-4.1'), legacy).reasoning_effort).toBeUndefined();
    // the scripted provider ignores both; routing is never sent to it
    expect(buildChatRequest(input()).providerPrefs).toBeUndefined();
  });

  it('llmChatTurn hands the provider an onRetry that reaches the input (the live text restarts on a retry)', async () => {
    const provider = named('openrouter', GLM);
    const events: string[] = [];
    await llmChatTurn(input({ provider, onRetry: () => events.push('retry'), onDelta: (d) => events.push(`delta:${d}`) }));
    expect(events).toEqual(['retry', 'delta:ok']);
    // without an onRetry the option is absent, not a no-op
    const bare = named('openrouter', GLM);
    await llmChatTurn(input({ provider: bare }));
    expect('onRetry' in bare.opts[0]!).toBe(false);
  });

  it('llmChatTurn calls onEnd once the provider returned, after the last delta and never on a failure', async () => {
    const events: string[] = [];
    await llmChatTurn(input({ provider: named('openrouter', GLM), onDelta: (d) => events.push(`delta:${d}`), onEnd: () => events.push('end') }));
    expect(events).toEqual(['delta:ok', 'end']);
    const boom = new Error('boom');
    const failed: string[] = [];
    await expect(llmChatTurn(input({ provider: fakeProvider({ text: '', fail: boom }), onEnd: () => failed.push('end') }))).rejects.toBe(boom);
    expect(failed).toEqual([]);
  });
});
