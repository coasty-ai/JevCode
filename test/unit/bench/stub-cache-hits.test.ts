/**
 * Review finding 8: "a cache hit is the jev.jsonl row with `usage.calls === 0`" is false.
 *
 * `src/bench/stub-decider.ts` returns `calls: 0` on EVERY request — deliberately, because the
 * record's `jevRequests` counts requests made and the stub makes none (its own count travels as
 * `stubbedJevRequests`). Deriving cache hits from the usage therefore counted every stubbed
 * request as a hit: 100 % false positives on the arm the bench uses most.
 *
 * So a hit is marked (`JevRequestRecord.cached`) and counted from the mark. The stub is
 * unchanged, and it must never produce one.
 */
import { describe, expect, it } from 'vitest';

import type { AskOptions, JevRequestRecord, Question } from '../../../src/core/types.js';
import { createStubDecider } from '../../../src/bench/stub-decider.js';
import { noul } from '../../../src/jev/questions.js';

const OPTS: AskOptions = { signal: new AbortController().signal, stage: 'propose', step: 1 };

function question(text: string): Question {
  return noul(text, { true: { definition: 'it holds', examples: ['a', 'b'] }, false: { definition: 'it does not', examples: ['c', 'd'] } });
}

/** How the engine counts a step's hits (engine.ts, the `jevCacheHits` fold). */
function hitsOf(rows: readonly JevRequestRecord[]): number {
  return rows.filter((r) => r.cached === true).length;
}

describe('the bench stub decider and cache-hit accounting (review finding 8)', () => {
  it('reports calls: 0 on every request and marks NONE of them cached, so the stub arm counts zero hits', async () => {
    const stub = createStubDecider();
    const qs = { q: question('Is this the buggy line?') };
    const a = await stub.ask({ line: 'a' }, qs, OPTS);
    const b = await stub.ask({ line: 'b' }, qs, OPTS);
    const c = await stub.ask({ line: 'a' }, qs, OPTS); // the same hash twice: still not a cache hit

    // the stub's own contract, unchanged
    expect([a, b, c].every((r) => r.usage.calls === 0)).toBe(true);
    expect(a.requestHash).toBe(c.requestHash);
    // ... and not one of them is marked, so the derived count is 0 where the old inference said 3
    expect([a, b, c].every((r) => r.cached === undefined)).toBe(true);
    const rows: JevRequestRecord[] = [a, b, c].map((r, i) => ({ step: 1, stage: 'propose', requestHash: r.requestHash, latencyMs: r.latencyMs, questions: 1 + i * 0, usage: r.usage, model: r.model, attempts: r.attempts }));
    expect(hitsOf(rows)).toBe(0);
    expect(rows.filter((r) => r.usage.calls === 0)).toHaveLength(3); // what the old inference would have counted
  });

  it('a marked row is the only thing that counts as a hit', () => {
    const row = (over: Partial<JevRequestRecord>): JevRequestRecord => ({ step: 1, stage: 'propose', requestHash: 'h', latencyMs: 0, questions: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, model: 'm', attempts: 1, ...over });
    expect(hitsOf([row({}), row({ cached: true }), row({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 } })])).toBe(1);
  });
});
