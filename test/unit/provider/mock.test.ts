import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { MOCK_DEFAULT_USAGE, createMockProvider } from '../../../src/provider/mock.js';
import type { CancelledGeneration, MockTurn } from '../../../src/core/types.js';
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

  it('function turns key on opts.sample and may script a length stop, reasoning tokens and a generation id (LLM-JEV-DESIGN stage 3 tests)', async () => {
    const p = createMockProvider({
      turns: (_req, _index, o): MockTurn => {
        const sample = o.sample ?? -1;
        return sample === 1
          ? { text: `s${sample}`, stopReason: 'length', usage: { outputTokens: 1500, reasoningTokens: 1447 }, generationId: `gen-${sample}` }
          : { text: `s${sample}`, generationId: `gen-${sample}` };
      },
    });
    const samples = [0, 1, 2];
    // fired together, like a round of N parallel requests
    const results = await Promise.all(samples.map((sample) => p.generate(request(), genOpts({ sample }))));
    expect(results.map((r) => r.text)).toEqual(['s0', 's1', 's2']);
    expect(results.map((r) => r.stopReason)).toEqual(['end_turn', 'length', 'end_turn']);
    expect(results.map((r) => r.generationId)).toEqual(['gen-0', 'gen-1', 'gen-2']);
    expect(results[1]!.usage).toEqual({ inputTokens: 1000, outputTokens: 1500, costUsd: 0, calls: 1, reasoningTokens: 1447 });
    expect('reasoningTokens' in results[0]!.usage).toBe(false);
    // without a sample the third argument still arrives (the single-sample propose path)
    expect((await p.generate(request(), genOpts())).text).toBe('s-1');
  });

  it('a signal that fires mid-text hands the streamed facts (no estimate) to onCancelled once and rethrows its reason', async () => {
    const ac = new AbortController();
    const reason = new AbortError('signal');
    const cancelled: CancelledGeneration[] = [];
    const p = createMockProvider({ turns: [{ text: 'abcdef', generationId: 'gen-x' }], deltaChunkSize: 2 });
    await expect(
      p.generate(request(), genOpts({ signal: ac.signal, onDelta: () => ac.abort(reason), onCancelled: (c) => cancelled.push(c) })),
    ).rejects.toBe(reason);
    expect(cancelled).toEqual([{ text: 'ab', toolChars: 0, reasoningChars: 0, model: 'mock', generationId: 'gen-x' }]);
  });

  it('streams tool-argument JSON in deltaChunkSize pieces after the text; a signal landing mid-arguments reports the streamed toolChars (the forced propose_fix sample of §4.8)', async () => {
    const input = { rationale: 'off by one in the range bound', edits: [{ path: 'quicksort.py', line: 12, new: '    for i in range(lo, hi + 1):' }] };
    const rawJson = JSON.stringify(input);
    const turn: MockTurn = { text: 'ok', toolCall: { name: 'propose_fix', input, rawJson: '' }, generationId: 'gen-s2' };
    const frags: string[] = [];
    const res = await createMockProvider({ turns: [turn], deltaChunkSize: 10 }).generate(request(), genOpts({ onToolDelta: (f) => frags.push(f) }));
    expect(frags.length).toBe(Math.ceil(rawJson.length / 10));
    expect(frags.join('')).toBe(rawJson);
    expect(res.toolCalls).toEqual([{ name: 'propose_fix', input, rawJson }]);

    const ac = new AbortController();
    const reason = new AbortError('signal');
    const cancelled: CancelledGeneration[] = [];
    let seen = 0;
    const p = createMockProvider({ turns: [turn], deltaChunkSize: 10 }).generate(
      request(),
      genOpts({
        signal: ac.signal,
        onToolDelta: (f) => {
          seen += f.length;
          if (seen >= 30) ac.abort(reason);
        },
        onCancelled: (c) => cancelled.push(c),
      }),
    );
    await expect(p).rejects.toBe(reason);
    expect(cancelled).toEqual([{ text: 'ok', toolChars: 30, reasoningChars: 0, model: 'mock', generationId: 'gen-s2' }]);
  });
});
