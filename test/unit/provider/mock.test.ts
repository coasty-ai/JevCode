import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AbortError, ProviderHttpError } from '../../../src/errors.js';
import { MOCK_CHAT_REPLY, MOCK_DEFAULT_USAGE, createMockProvider, withMockChat, type MockEmit } from '../../../src/provider/mock.js';
import { MOCK_DELTA_MS_DEFAULT, mockChatReplyFromEnv, mockTrajectory, streamLogSnapshot } from '../../../src/cli/mock-trajectory.js';
import { streamPreset } from '../../../src/perf/stream-fixture.js';
import type { CancelledGeneration, GenerateRequest, MockTurn } from '../../../src/core/types.js';
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

/**
 * A fake clock for the deadline pacing: `sleep(ms)` advances it by `ms` plus the next scripted overshoot (a macOS
 * timer wakes late), so the test sees exactly the waits the provider asked for and when each delta went out.
 */
function fakeClock(overshoots: readonly number[] = []): { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; waits: number[] } {
  let t = 0;
  let k = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      t += ms + (overshoots[k++] ?? 0);
    },
    waits,
  };
}

describe('createMockProvider: timed deltas (the stream probe, src/perf/stream-latency.ts)', () => {
  it('emits `deltas` in order at deadlines t0 + (i + 1) · gap: a late wake-up shortens the next wait instead of delaying every later delta', async () => {
    const clock = fakeClock([3, 0, 0, 0]);
    const log: string[] = [];
    const emits: MockEmit[] = [];
    let ns = 1000n;
    const p = createMockProvider({ turns: [{ deltas: ['ab', 'c\n', '', 'de'], deltaGapMs: 10 }], onEmit: (e) => (emits.push(e), log.push(`emit ${e.i}@${clock.now()}`)) }, { now: clock.now, sleep: clock.sleep, hrtimeNs: () => (ns += 5n) });
    const res = await p.generate(request(), genOpts({ onDelta: (d) => log.push(`delta ${JSON.stringify(d)}@${clock.now()}`) }));
    // the first sleep woke 3 ms late (13): the second wait is 7, so delta 1 still goes out at its deadline, 20
    expect(clock.waits).toEqual([10, 7, 10, 10]);
    expect(log).toEqual(['emit 0@13', 'delta "ab"@13', 'emit 1@20', 'delta "c\\n"@20', 'emit 2@30', 'delta ""@30', 'emit 3@40', 'delta "de"@40']);
    // one record per delta, before its onDelta, with its index, its length and the emission clock
    expect(emits).toEqual([
      { i: 0, chars: 2, ns: 1005n },
      { i: 1, chars: 2, ns: 1010n },
      { i: 2, chars: 0, ns: 1015n },
      { i: 3, chars: 2, ns: 1020n },
    ]);
    // the result is the concatenation; `text` is ignored for a timed turn
    expect(res.text).toBe('abc\nde');
    expect(res.stopReason).toBe('end_turn');
  });

  it('`latencyMs` is the time to first byte of a timed turn; a wake-up past a deadline skips the wait (no catch-up sleep)', async () => {
    const clock = fakeClock([25]);
    const at: number[] = [];
    const p = createMockProvider({ turns: [{ deltas: ['x', 'y', 'z'], deltaGapMs: 10, latencyMs: 50, text: 'ignored' }] }, { now: clock.now, sleep: clock.sleep });
    const res = await p.generate(request(), genOpts({ onDelta: () => at.push(clock.now()) }));
    // deadline 60 (50 + 10): the wait overshoots to 85, so y (deadline 70) and z (deadline 80) go out at once
    expect(clock.waits).toEqual([60]);
    expect(at).toEqual([85, 85, 85]);
    expect(res.text).toBe('xyz');
    expect(res.latencyMs).toBe(85);
  });

  it('a signal mid-stream stops the deltas and hands the streamed text to onCancelled exactly once', async () => {
    const clock = fakeClock();
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const cancelled: CancelledGeneration[] = [];
    const emitted: number[] = [];
    const p = createMockProvider({ turns: [{ deltas: ['one ', 'two ', 'three'], deltaGapMs: 5, generationId: 'gen-t' }], onEmit: (e) => emitted.push(e.i) }, { now: clock.now, sleep: clock.sleep });
    await expect(
      p.generate(request(), genOpts({ signal: ac.signal, onDelta: (d) => (d === 'two ' ? ac.abort(reason) : undefined), onCancelled: (c) => cancelled.push(c) })),
    ).rejects.toBe(reason);
    expect(emitted).toEqual([0, 1]);
    expect(cancelled).toEqual([{ text: 'one two ', toolChars: 0, reasoningChars: 0, model: 'mock', generationId: 'gen-t' }]);
  });

  it('onEmit fires for untimed turns too (one record for the whole text by default); without onEmit nothing else changes', async () => {
    const emits: MockEmit[] = [];
    const p = createMockProvider({ turns: [{ text: 'abcdefg' }, { text: 'abcdefg' }], onEmit: (e) => emits.push(e) }, { hrtimeNs: () => 7n });
    await p.generate(request(), genOpts());
    expect(emits).toEqual([{ i: 0, chars: 7, ns: 7n }]);
    const plain = createMockProvider({ turns: [{ text: 'abcdefg' }] }, { hrtimeNs: () => { throw new Error('the clock is read only for onEmit'); } });
    expect((await plain.generate(request(), genOpts())).text).toBe('abcdefg');
  });
});

describe('withMockChat', () => {
  const chatReq = (): GenerateRequest => request();
  const toolReq = (): GenerateRequest => ({ ...request(), tools: [{ name: 'propose_action', description: 'd', inputSchema: { type: 'object' } }] });

  it('a chat request (no tools) gets MOCK_CHAT_REPLY by default and consumes no scripted turn', () => {
    const next = withMockChat([{ text: 'step one' }, { text: 'step two' }]);
    expect(next(chatReq())).toEqual({ text: MOCK_CHAT_REPLY });
    expect(next(toolReq())).toEqual({ text: 'step one' });
    expect(next(chatReq())).toEqual({ text: MOCK_CHAT_REPLY });
    expect(next(toolReq())).toEqual({ text: 'step two' });
  });

  it('the chat reply may be a whole turn — the timed stream — and `undefined` keeps the default', () => {
    const stream: MockTurn = { deltas: ['a', 'b'], deltaGapMs: 5 };
    const next = withMockChat([{ text: 'step one' }], stream);
    expect(next(chatReq())).toBe(stream);
    expect(next(toolReq())).toEqual({ text: 'step one' });
    expect(withMockChat([], undefined)(chatReq())).toEqual({ text: MOCK_CHAT_REPLY });
  });
});

describe('mockChatReplyFromEnv (src/cli/mock-trajectory.ts: the --mock seam of the stream probe)', () => {
  it('unset, empty or unknown preset → {} (withMockChat keeps the one-delta MOCK_CHAT_REPLY)', () => {
    expect(mockChatReplyFromEnv({})).toEqual({});
    expect(mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: '' })).toEqual({});
    expect(mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: 'fast', JEVCODE_MOCK_DELTA_MS: '5', JEVCODE_PERF_STREAM_LOG: '/tmp/x.json' })).toEqual({});
    // the knobs never touch the run trajectory
    expect(mockTrajectory(3, 0, false)).toEqual(mockTrajectory(3, 0, false));
  });

  it('a preset streams its deltas at JEVCODE_MOCK_DELTA_MS (default 30); no log hook without JEVCODE_PERF_STREAM_LOG', () => {
    const mixed = streamPreset('mixed');
    const a = mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: 'mixed' });
    expect(a.reply).toEqual({ deltas: mixed.deltas, deltaGapMs: MOCK_DELTA_MS_DEFAULT });
    expect(a.onEmit).toBeUndefined();
    expect(mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: ' long ', JEVCODE_MOCK_DELTA_MS: '2' }).reply).toEqual({ deltas: streamPreset('long').deltas, deltaGapMs: 2 });
    expect(mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: 'mixed', JEVCODE_MOCK_DELTA_MS: 'fast' }).reply?.deltaGapMs).toBe(MOCK_DELTA_MS_DEFAULT);
  });

  it('JEVCODE_PERF_STREAM_LOG collects one record per emission in memory, a new stream per chat turn, for one write at exit', async () => {
    const env = { JEVCODE_MOCK_CHAT_STREAM: 'mixed', JEVCODE_MOCK_DELTA_MS: '0', JEVCODE_PERF_STREAM_LOG: join(tmpdir(), `jevcode-mock-stream-log-${process.pid}.json`) };
    const n = streamPreset('mixed').deltas.length;
    for (let turn = 0; turn < 2; turn++) {
      // buildProvider builds a provider per chat turn: every one appends to the same process log
      const setup = mockChatReplyFromEnv(env);
      expect(setup.onEmit).toBeTypeOf('function');
      const p = createMockProvider({ turns: withMockChat([], setup.reply), ...(setup.onEmit !== undefined ? { onEmit: setup.onEmit } : {}) });
      await p.generate(request(), genOpts());
    }
    const log = streamLogSnapshot();
    expect(log).not.toBeNull();
    expect(log!).toMatchObject({ preset: 'mixed', gapMs: 0, deltas: n });
    expect(log!.emissions).toHaveLength(2 * n);
    expect(log!.emissions.filter((e) => e.s === 1).map((e) => e.i)).toEqual(Array.from({ length: n }, (_, i) => i));
    const ns = log!.emissions.map((e) => BigInt(e.ns));
    expect(ns.every((v, i) => i === 0 || v >= ns[i - 1]!)).toBe(true);
  });
});
