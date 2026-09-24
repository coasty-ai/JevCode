/**
 * `AskOptions.quick` in the Jev client (docs/AGENT-LOOP-DESIGN.md §13.1 rule 6): one attempt, no retry chain, no backoff
 * and no `retry` event, so an outage costs the placement's deadline and never a 30 s failure. Ordinary asks keep their
 * retry chain unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { AskOptions, DeciderConfig, RetryInfo } from '../../../src/core/types.js';
import { JevHttpError, JevResponseError } from '../../../src/errors.js';
import { createJevDecider } from '../../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../../src/jev/providers.js';
import { FAKE_KEY, fakeFetch, recordingSleep, redact, sampleQuestions, validBody, type Scripted } from '../jev/helpers.js';

const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: FAKE_KEY, model: 'typesafe/jev-1.13-20260917', pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };

function build(script: Scripted[]) {
  const ff = fakeFetch(script);
  const rs = recordingSleep();
  const decider = createJevDecider(cfg, { fetch: ff.fetch, redact, random: () => 0, sleep: rs.sleep });
  return { decider, calls: ff.calls, sleeps: rs.sleeps };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

const opts = (o: Partial<AskOptions> = {}): AskOptions => ({ signal: new AbortController().signal, stage: 'loop', step: 3, ...o });

describe('quick Jev asks', () => {
  it('a 503 fails at once: one attempt, no sleep, no retry event', async () => {
    const retries: RetryInfo[] = [];
    const { decider, calls, sleeps } = build([{ status: 503, body: 'busy' }, { status: 200, body: validBody(sampleQuestions) }]);
    const e = await rejection(decider.ask({ t: 1 }, sampleQuestions, opts({ quick: true, onRetry: (i) => retries.push(i) })));
    expect(e).toBeInstanceOf(JevHttpError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(retries).toEqual([]);
  });

  it('a transient bad body is not retried either', async () => {
    const { decider, calls } = build([{ status: 200, body: 'not json' }, { status: 200, body: validBody(sampleQuestions) }]);
    expect(await rejection(decider.ask({ t: 1 }, sampleQuestions, opts({ quick: true })))).toBeInstanceOf(JevResponseError);
    expect(calls).toHaveLength(1);
  });

  it('a good answer is returned as usual', async () => {
    const { decider, calls } = build([{ status: 200, body: validBody(sampleQuestions) }]);
    const r = await decider.ask({ t: 1 }, sampleQuestions, opts({ quick: true }));
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('an ordinary ask still retries a 503', async () => {
    const { decider, calls, sleeps } = build([{ status: 503, body: 'busy' }, { status: 200, body: validBody(sampleQuestions) }]);
    const r = await decider.ask({ t: 1 }, sampleQuestions, opts());
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });
});
