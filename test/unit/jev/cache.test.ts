/**
 * docs/research/llm-jev/oos-analysis-2026-09-22.md ranked change 2. Q2(c): 454 of the slice's
 * 2,330 requests (19.5 %) repeated a `requestHash` already issued in the SAME run — 339 of the
 * ladder's 1,532, 115 of SWE's 744, 0 of QuixBugs' (the ten short runs never repeat). Same
 * question, same state, same model, no cache hit. The hash is already computed and already
 * written to `jev.jsonl`; the answer only has to be remembered.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, AskOptions, AskResult, Decider, Json, Question } from '../../../src/core/types.js';
import { requestHashOf } from '../../../src/jev/client.js';
import { createCachingDecider } from '../../../src/jev/cache.js';
import { noul } from '../../../src/jev/questions.js';

const OPTS: AskOptions = { signal: new AbortController().signal, stage: 'propose', step: 1 };

function question(text: string): Question {
  return noul(text, {
    true: { definition: 'it holds', examples: ['one', 'two'] },
    false: { definition: 'it does not hold', examples: ['three', 'four'] },
  });
}

/** A decider that counts what actually reached "the provider" and can be made to throw. */
function countingDecider(over: { throwOn?: number } = {}): Decider & { calls: number; states: Json[] } {
  let calls = 0;
  const states: Json[] = [];
  const answers: Record<string, Answer> = { q: { type: 'noul', noul: 0.42, confidence: 0.9 } };
  return {
    model: 'jev-1.13.0',
    provider: 'typesafe',
    get calls(): number {
      return calls;
    },
    states,
    ask: async (state: Json, questions: Record<string, Question>): Promise<AskResult> => {
      calls += 1;
      states.push(state);
      if (over.throwOn === calls) throw new Error('transport');
      return {
        answers,
        usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0.000042, calls: 1 },
        latencyMs: 210,
        model: 'jev-1.13.0',
        requestHash: requestHashOf('jev-1.13.0', state, questions),
        attempts: 1,
        id: `gen-${calls}`,
        costBasis: 'table',
      };
    },
  };
}

describe('within-run requestHash cache (OOS 2026-09-22 ranked change 2: 454 of 2,330 requests, 19.5 %, repeated a hash already issued in the same run)', () => {
  it('serves a repeated requestHash from the cache, makes no second provider call, and counts the hit', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const state: Json = { task: 'fix gcd', buggy_line: 'return gcd(a % b, b)' };
    const qs = { q: question('Is this the buggy line?') };

    // failing-first: the undecorated decider is what the 44 runs had — the same hash, twice on the wire
    const bare = countingDecider();
    await bare.ask(state, qs, OPTS);
    await bare.ask(state, qs, OPTS);
    expect(bare.calls).toBe(2);

    const first = await cached.ask(state, qs, OPTS);
    const second = await cached.ask(state, qs, OPTS);

    expect(inner.calls).toBe(1);
    expect(cached.hits).toBe(1);
    expect(cached.entries).toBe(1);
    // the answer is the recorded one, byte for byte
    expect(second.answers).toEqual(first.answers);
    expect(second.requestHash).toBe(first.requestHash);
    expect(second.model).toBe(first.model);
    expect(second.id).toBe(first.id);
    // and it costs nothing: a hit is not a call, not a token and not a millisecond
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
    expect(second.latencyMs).toBe(0);
    expect(second.attempts).toBe(1);
  });

  it('a different state or a different question is a different hash and still reaches the provider', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const qs = { q: question('Is this the buggy line?') };
    await cached.ask({ line: 'a' }, qs, OPTS);
    await cached.ask({ line: 'b' }, qs, OPTS);
    await cached.ask({ line: 'a' }, { q: question('Is this the buggy line, really?') }, OPTS);
    expect(inner.calls).toBe(3);
    expect(cached.hits).toBe(0);
    expect(cached.entries).toBe(3);
    // ... and asking the first one again is a hit
    await cached.ask({ line: 'a' }, qs, OPTS);
    expect(inner.calls).toBe(3);
    expect(cached.hits).toBe(1);
  });

  it('the key is the provider\'s own requestHash, so a hit joins to the jev.jsonl row that produced it', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const state: Json = { task: 'fix gcd' };
    const qs = { q: question('Is this the buggy line?') };
    const first = await cached.ask(state, qs, OPTS);
    expect(first.requestHash).toBe(requestHashOf('jev-1.13.0', state, qs));
    expect((await cached.ask(state, qs, OPTS)).requestHash).toBe(first.requestHash);
  });

  it('a failed ask is never remembered: the next ask of that hash reaches the provider again', async () => {
    const inner = countingDecider({ throwOn: 1 });
    const cached = createCachingDecider(inner);
    const state: Json = { task: 'fix gcd' };
    const qs = { q: question('Is this the buggy line?') };
    await expect(cached.ask(state, qs, OPTS)).rejects.toThrow('transport');
    expect(cached.entries).toBe(0);
    const retry = await cached.ask(state, qs, OPTS);
    expect(inner.calls).toBe(2);
    expect(cached.hits).toBe(0);
    expect(retry.usage.calls).toBe(1);
  });

  it('two concurrent asks of one hash share the single request (the streaming search runs sites in parallel)', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const state: Json = { task: 'fix gcd' };
    const qs = { q: question('Is this the buggy line?') };
    const [a, b] = await Promise.all([cached.ask(state, qs, OPTS), cached.ask(state, qs, OPTS)]);
    expect(inner.calls).toBe(1);
    expect(cached.hits).toBe(1);
    expect(b.answers).toEqual(a.answers);
    expect(a.usage.calls + b.usage.calls).toBe(1);
  });

  it('clear() drops the run\'s entries and the hit count', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const qs = { q: question('Is this the buggy line?') };
    await cached.ask({ line: 'a' }, qs, OPTS);
    await cached.ask({ line: 'a' }, qs, OPTS);
    expect(cached.hits).toBe(1);
    cached.clear();
    expect(cached.entries).toBe(0);
    expect(cached.hits).toBe(0);
    await cached.ask({ line: 'a' }, qs, OPTS);
    expect(inner.calls).toBe(2);
  });

  it('the model id is inside the hash, so the cache cannot serve one model\'s answer for another', async () => {
    const inner = countingDecider();
    const cached = createCachingDecider(inner);
    const state: Json = { task: 'fix gcd' };
    const qs = { q: question('Is this the buggy line?') };
    expect(requestHashOf('jev-1.13.0', state, qs)).not.toBe(requestHashOf('jev-1.14.0', state, qs));
    await cached.ask(state, qs, OPTS);
    expect(cached.entries).toBe(1);
  });
});
