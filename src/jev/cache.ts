/**
 * Within-run answer cache keyed by `requestHash`
 * (docs/research/llm-jev/oos-analysis-2026-09-22.md ranked change 2).
 *
 * `requestHash` is `sha12(toJson({ model, state, questions }))` — computed in `jev/client.ts ask`
 * and already written to every `jev.jsonl` row. It is the complete input of a decision: the same
 * hash is the same model asked the same questions over byte-identical state, and Jev's answer to
 * it is a function of exactly those bytes. Re-issuing it buys nothing and costs a request.
 *
 * The slice re-issued 454 of its 2,330 requests (19.5 %) inside one run: 339 of the ladder's
 * 1,532, 115 of SWE's 744, 0 of QuixBugs' 54 — the small tasks never repeat, the long ones
 * repeat constantly because the search re-enters the same site with the same evidence. At the
 * slice's rates that is roughly 110 s and $0.05.
 *
 * Scope and honesty rules, so nothing downstream is misled:
 *
 * - One cache per run. The decorator holds it, and a decider is built once per run (cli/session.ts,
 *   bench/cli.ts), so a cache never crosses runs and never crosses a model change: the model id is
 *   inside the hash anyway.
 * - A hit returns the recorded answers with `usage` zeroed and `calls: 0`. The meter must not bill
 *   a call that was not made, and a spend cap must not be consumed twice by one question. The
 *   recorded `latencyMs` is likewise 0 — the hit took no wall.
 * - `requestHash` on a hit is the hash that was served, so the record still joins to the request
 *   that produced the answer; `id` carries the original response id and `attempts` is 1.
 * - Only successful asks are cached. A throw (HTTP, validation, abort) is never remembered: the
 *   next ask must be free to reach the provider.
 * - In-flight de-duplication is deliberate too: two concurrent asks of one hash share the single
 *   promise, so the streaming search's parallel sites cannot both pay for it.
 *
 * `hits` is the count the caller reports as `synth.jevCacheHits`.
 */
import type { AskOptions, AskResult, Decider, Json, Question } from '../core/types.js';
import { requestHashOf } from './client.js';

export interface CachingDecider extends Decider {
  /** requests served from the cache instead of the provider (`synth.jevCacheHits`) */
  readonly hits: number;
  /** distinct `requestHash` values the run has asked */
  readonly entries: number;
  /** drop every entry (a resumed run starts empty; the caller owns the lifetime) */
  clear(): void;
}

/** A hit costs nothing: no tokens, no call, no wall. */
function asHit(served: AskResult): AskResult {
  return {
    ...served,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
    latencyMs: 0,
    attempts: 1,
  };
}

/**
 * Wrap a decider so that a `requestHash` already answered in this run is answered from memory.
 * The hash is the provider's own: the wrapper does not recompute it, it reads it off the first
 * result, so it can never disagree with what `jev.jsonl` records.
 *
 * The first ask of a hash is a miss by construction (the hash is only known once the inner
 * decider returns), so the key is also computed locally from the request for the lookup. Both
 * keys are the same function of the same bytes; the local one is only ever used to find the
 * entry, never to label a record.
 */
export function createCachingDecider(inner: Decider, keyOf: (model: string, state: Json, questions: Record<string, Question>) => string = requestHashOf): CachingDecider {
  const done = new Map<string, AskResult>();
  const inFlight = new Map<string, Promise<AskResult>>();
  let hits = 0;

  async function ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> {
    const key = keyOf(inner.model, state, questions);
    const served = done.get(key);
    if (served !== undefined) {
      hits += 1;
      return asHit(served);
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      hits += 1;
      return asHit(await pending);
    }
    const p = inner.ask(state, questions, opts);
    inFlight.set(key, p);
    try {
      const result = await p;
      done.set(key, result);
      return result;
    } finally {
      // a throw is never remembered: the next ask must be free to reach the provider
      inFlight.delete(key);
    }
  }

  return {
    model: inner.model,
    provider: inner.provider,
    ask,
    get hits(): number {
      return hits;
    },
    get entries(): number {
      return done.size;
    },
    clear(): void {
      done.clear();
      hits = 0;
    },
  };
}
