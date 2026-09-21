/**
 * TUI-DESIGN-2 §3.6 jev+llm turn (S3, §8.1 row `llm-turn.test.ts`): `buildChatRequest` has no tools, temperature null,
 * ≤ 6 turns, the system prompt literal and the optional sections; messages alternate and start with the human; a returned
 * tool call is dropped with a warning; deltas stream; the answer passes through redact; `chatMaxTokens` = min(800, cfg).
 */
import { describe, expect, it } from 'vitest';
import type { GenerateRequest, Provider } from '../../../src/core/types.js';
import { CHAT_CONVERSATION_TURNS, CHAT_MAX_OUTPUT_TOKENS, CHAT_SYSTEM_PROMPT, buildChatRequest, chatMaxTokens, chatMessages, llmChatTurn, type LlmTurnInput } from '../../../src/chat/llm-turn.js';
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
  it('system = the literal prompt + session facts (+ instructions, plan, recent steps, files); no tools, no toolChoice, temperature null, maxTokens ≤ 800', () => {
    const req = buildChatRequest(input({ generation: { maxTokens: 4096, temperature: null } }));
    expect(req.system.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(CHAT_SYSTEM_PROMPT).toBe(['You are the assistant of JevCode, a coding agent in which Jev (a decision model) makes every decision. You are in a conversation about the code in the workspace named below.', 'Answer the question. Do not propose file edits, patches or commands to run: the human starts a run for that by describing a task, and Jev then decides each step.', 'Be concrete, cite paths and line numbers you were shown, and keep the answer under twelve lines. If the shown files do not contain the answer, say what to open next.'].join('\n'));
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
