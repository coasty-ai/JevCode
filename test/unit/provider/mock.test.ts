import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { MOCK_DEFAULT_USAGE, createMockProvider } from '../../../src/provider/mock.js';
import type { MockTurn } from '../../../src/core/types.js';
import { genOpts, request } from './helpers.js';

describe('createMockProvider', () => {
  it('plays turns by call index with default usage and end_turn', async () => {
    const p = createMockProvider({ turns: [{ text: 'one' }, { text: 'two', usage: { costUsd: 0.01, inputTokens: 5 } }] });
    expect(p.name).toBe('mock');
    expect(p.model).toBe('mock');
    const a = await p.generate(request(), genOpts());
    expect(a).toMatchObject({ text: 'one', toolCalls: [], usage: MOCK_DEFAULT_USAGE, model: 'mock', stopReason: 'end_turn' });
    const b = await p.generate(request(), genOpts());
    expect(b.usage).toEqual({ inputTokens: 5, outputTokens: 200, costUsd: 0.01, calls: 1 });
    await expect(p.generate(request(), genOpts())).rejects.toSatisfy((e: unknown) => e instanceof ProviderHttpError && !e.retryable && e.message.includes('no scripted turn'));
  });

  it('streams text in deltaChunkSize pieces, whole text by default', async () => {
    const chunked = createMockProvider({ turns: [{ text: 'abcdefg' }], deltaChunkSize: 3, model: 'mock-sonnet' });
    const deltas: string[] = [];
    const res = await chunked.generate(request(), genOpts({ onDelta: (t) => deltas.push(t) }));
    expect(deltas).toEqual(['abc', 'def', 'g']);
    expect(res.text).toBe('abcdefg');
    expect(res.model).toBe('mock-sonnet');
    const whole = createMockProvider({ turns: [{ text: 'abcdefg' }] });
    const one: string[] = [];
    await whole.generate(request(), genOpts({ onDelta: (t) => one.push(t) }));
    expect(one).toEqual(['abcdefg']);
  });

  it('returns toolCalls from turn.toolCall with rawJson derived from input, forwarding it to onToolDelta', async () => {
    const input = { goal: 'g', action: { kind: 'done', summary: 's' }, plan: { done: [], remaining: [], openProblems: [] } };
    const p = createMockProvider({ turns: [{ text: 'Done.', toolCall: { name: 'propose_action', input, rawJson: '' } }] });
    const toolDeltas: string[] = [];
    const res = await p.generate(request(), genOpts({ onToolDelta: (t) => toolDeltas.push(t) }));
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input, rawJson: JSON.stringify(input) }]);
    expect(toolDeltas).toEqual([JSON.stringify(input)]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('throws a ProviderHttpError for turn.error without any internal retry', async () => {
    let calls = 0;
    const p = createMockProvider({
      turns: (_req, i) => {
        calls++;
        return i === 0 ? { error: { status: 529, retryable: true } } : { text: 'ok' };
      },
    });
    await expect(p.generate(request(), genOpts())).rejects.toMatchObject({ status: 529, retryable: true, code: 'provider_http' });
    expect(calls).toBe(1);
    expect((await p.generate(request(), genOpts())).text).toBe('ok');
  });

  it('function turns receive the request and index', async () => {
    const seen: number[] = [];
    const p = createMockProvider({
      turns: (req, i): MockTurn => {
        seen.push(i);
        return { text: `${req.messages[0]!.content}#${i}` };
      },
    });
    expect((await p.generate(request(), genOpts())).text).toBe('Fix the bug.#0');
    expect((await p.generate(request(), genOpts())).text).toBe('Fix the bug.#1');
    expect(seen).toEqual([0, 1]);
  });

  it('spreads latencyMs over the deltas through the injected sleep and reports it', async () => {
    const sleeps: number[] = [];
    const p = createMockProvider({ turns: [{ text: 'abcd', latencyMs: 40 }], deltaChunkSize: 2 }, { sleep: async (ms) => void sleeps.push(ms), now: () => 0 });
    const res = await p.generate(request(), genOpts());
    expect(sleeps).toEqual([20, 20]);
    expect(res.latencyMs).toBe(40);
  });

  it('respects an aborted signal', async () => {
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    ac.abort(reason);
    const p = createMockProvider({ turns: [{ text: 'x' }] });
    await expect(p.generate(request(), genOpts({ signal: ac.signal }))).rejects.toBe(reason);
  });
});
