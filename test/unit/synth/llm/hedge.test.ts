/**
 * contract 1.9 (Fastlane) §3.2 — the hedge (docs/LLM-LOOP-DESIGN.md §3.2, HARNESS-NEXT-DESIGN.md §6 S2:
 * "`hedgeAfterMs = clamp(2 × running TTFB p50, 3_000, 8_000)`, `LLM_HEDGES_PER_ROUND = 1`,
 * `CancelReason 'hedge'`, refused when `llmUsdLeft` cannot hold one more estimated-full-cost sample,
 * twin rotates `provider.order`"; §9.3 records the status as "no `hedgeAfterMs`, no `LLM_HEDGES_PER_ROUND`").
 *
 * The recorded shape this is for. `generator.jsonl` of the out-of-sample slice: 82 of 244 ladder and 51 of
 * 130 SWE `propose_fix` calls ended `stopReason:"timeout"` with `usage.outputTokens: 0` — silent from the
 * first byte to the deadline, 1,170 s of 2,423 s of ladder generator sample-time. §4.8 rev 4 answers the
 * REPEAT of that shape (the goal's next round waits longer); the hedge answers the occurrence itself, by
 * putting a second copy of a silent sample on a different upstream while the first is still waiting.
 *
 * The invariant every case below turns on: a hedge may make a round faster, never free and never unfunded.
 * Both legs are billed, the twin takes the same §4.11 hold every other sample takes, and a hedge the dollar
 * counter cannot cover at full estimated cost is REFUSED — a hedge storm must not leave a goal with no round.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CancelledGeneration, GenerateRequest, GenerateResult } from '../../../../src/core/types.js';
import { LLM_HEDGES_PER_ROUND, LLM_HEDGE_AFTER } from '../../../../src/core/limits.js';
import {
  HEDGE_ENV_FLAG,
  HEDGE_TWIN_OFFSET,
  createLlmSource,
  hedgeAfterMs,
  hedgeEnabled,
  hedgeOriginOf,
  type LlmBudget,
  type LlmFireInput,
  type LlmSource,
} from '../../../../src/synth/llm/source.js';
import { listingSet } from '../../../../src/synth/llm/prompt.js';
import type { GenerateFn, SampleGenerateOptions } from '../../../../src/synth/llm/types.js';
import { calcFiles, proposeFixCall } from './fixtures.js';
import { createMockProvider } from '../../../../src/provider/mock.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];
/** long enough that nothing times out inside a test that only advances past the hedge threshold */
const DEADLINE_MS = 60_000;

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 6, samplesLeft: 12, usdLeft: 1, ...over };
}

function fireInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: 'sys', userFor: (k) => `user ${k}`, files, listings, signal: new AbortController().signal, budget: b, deadlineMs: DEADLINE_MS, stagger: false, n: 1, ...over };
}

interface Leg {
  sample: number;
  req: GenerateRequest;
  opts: SampleGenerateOptions;
  /** answer this leg with a valid `propose_fix` */
  answer: () => void;
}

/**
 * A generate whose every call is parked until the test answers it, recording the request and the options so
 * `onFirstByte` can be driven by hand — the whole mechanism turns on WHEN the first byte lands, so the test
 * must own that clock rather than a provider double.
 */
function parked(): { generate: GenerateFn; legs: Leg[] } {
  const legs: Leg[] = [];
  const provider = createMockProvider({ turns: () => ({ toolCall: proposeFixCall([FIX]) }) });
  const generate: GenerateFn = (req, o) =>
    new Promise<GenerateResult>((resolve, reject) => {
      legs.push({
        sample: o.sample,
        req,
        opts: o,
        answer: () => void provider.generate(req, { signal: o.signal }).then(resolve, reject),
      });
      o.signal.addEventListener('abort', () => {
        o.onCancelled?.({ text: '', toolChars: 0, reasoningChars: 0 } satisfies CancelledGeneration);
        reject(o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted'));
      });
    });
  return { generate, legs };
}

function source(over: Parameters<typeof createLlmSource>[0] = { generate: parked().generate }): LlmSource {
  return createLlmSource({ pricing: PRICING, env: {}, ...over });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('§3.2 the threshold', () => {
  it('is clamp(2 × the running TTFB p50, 3 s, 8 s), and the CEILING before a run has any TTFB at all', () => {
    // no evidence yet: the first round of a run is also the coldest connection, so it is not hedged at 3 s
    expect(hedgeAfterMs(null)).toBe(LLM_HEDGE_AFTER.maxMs);
    expect(hedgeAfterMs(200)).toBe(LLM_HEDGE_AFTER.minMs);
    expect(hedgeAfterMs(2_000)).toBe(4_000);
    expect(hedgeAfterMs(9_000)).toBe(LLM_HEDGE_AFTER.maxMs);
    expect(LLM_HEDGE_AFTER.factor).toBe(2);
  });

  it('is armed by the caller’s pin first and `JEVCODE_HEDGE` second, and is OFF by default', () => {
    expect(hedgeEnabled(undefined, {})).toBe(false);
    expect(hedgeEnabled(undefined, { [HEDGE_ENV_FLAG]: 'on' })).toBe(true);
    expect(hedgeEnabled(undefined, { [HEDGE_ENV_FLAG]: 'ON ' })).toBe(true);
    expect(hedgeEnabled(undefined, { [HEDGE_ENV_FLAG]: 'off' })).toBe(false);
    // the pin wins both ways: a bench arm can force it on, and a caller can force it off under the env
    expect(hedgeEnabled(true, {})).toBe(true);
    expect(hedgeEnabled(false, { [HEDGE_ENV_FLAG]: 'on' })).toBe(false);
  });

  it('names a twin by its origin', () => {
    expect(hedgeOriginOf(0)).toBeNull();
    expect(hedgeOriginOf(2)).toBeNull();
    expect(hedgeOriginOf(HEDGE_TWIN_OFFSET)).toBe(0);
    expect(hedgeOriginOf(HEDGE_TWIN_OFFSET + 2)).toBe(2);
  });
});

describe('§3.2 firing', () => {
  it('fires nothing when hedging is off, however long the sample stays silent (today’s behaviour)', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate });
    const b = budget();
    expect(src.fire(fireInput(b)).fired).toBe(true);
    await vi.advanceTimersByTimeAsync(LLM_HEDGE_AFTER.maxMs * 3);
    expect(g.legs).toHaveLength(1);
    g.legs[0]!.answer();
    await vi.advanceTimersByTimeAsync(0);
    const round = src.round()!;
    expect(round.hedges).toBe(0);
    expect(round.hedgeWins).toBe(0);
  });

  it('fires one twin when the origin produces no first byte, with the origin’s message and the rotated order', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true, providerOrder: ['Z.AI', 'Inceptron', 'Fireworks'] });
    const b = budget();
    src.fire(fireInput(b, { n: 3, userFor: (k) => `user ${k}` }));
    expect(g.legs.map((l) => l.sample)).toEqual([0, 1, 2]);
    // sample 1 is served at 100 ms: its own hedge is cancelled, and it teaches the run a p50 of 100 ms
    g.legs[1]!.opts.onFirstByte?.(100);
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null));
    // exactly ONE twin, even though TWO samples (0 and 2) were silent past the threshold
    expect(g.legs).toHaveLength(4);
    expect(LLM_HEDGES_PER_ROUND).toBe(1);
    const twin = g.legs[3]!;
    expect(hedgeOriginOf(twin.sample)).toBe(0);
    // the twin is its origin's request byte for byte except the upstream order — same prompt, same seed, so the cache hits
    expect(twin.req.messages).toEqual(g.legs[0]!.req.messages);
    expect(twin.req.temperature).toBe(g.legs[0]!.req.temperature);
    expect(twin.req.seed).toBe(g.legs[0]!.req.seed);
    expect(g.legs[0]!.req.providerPrefs?.order).toEqual(['Z.AI', 'Inceptron', 'Fireworks']);
    expect(twin.req.providerPrefs?.order).toEqual(['Inceptron', 'Fireworks', 'Z.AI']);
    expect(src.round()!.hedges).toBe(1);
    // the ledgers count it as the sample it is: its own hold and its own `samplesLeft`
    expect(b.samplesLeft).toBe(12 - 4);
    expect(src.round()!.reservedUsd).toBeGreaterThan(0);
    for (const leg of g.legs) leg.answer();
    await vi.advanceTimersByTimeAsync(0);
    await src.collectAll();
  });

  it('does not hedge a sample whose first byte landed: a stream that started is being served', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true });
    src.fire(fireInput(budget()));
    g.legs[0]!.opts.onFirstByte?.(40);
    await vi.advanceTimersByTimeAsync(LLM_HEDGE_AFTER.maxMs * 3);
    expect(g.legs).toHaveLength(1);
    expect(src.round()!.hedges).toBe(0);
    // and the TTFB it reported is the run's p50, which is what the next threshold reads
    expect(src.p50TtfbMs()).toBe(40);
    expect(src.hedgeAfterMs()).toBe(LLM_HEDGE_AFTER.minMs);
    g.legs[0]!.answer();
    await src.collectAll();
    expect(src.round()!.ttfbMs).toEqual([40]);
  });
});

describe('§3.2 the loser', () => {
  it('cancels the twin with reason `hedge` when the origin answers first, and bills both legs', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true });
    const b = budget();
    src.fire(fireInput(b));
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null));
    expect(g.legs).toHaveLength(2);
    g.legs[0]!.answer();
    await vi.advanceTimersByTimeAsync(0);
    const arrivals = await src.collectAll();
    const twin = arrivals.find((a) => a.sample === HEDGE_TWIN_OFFSET)!;
    expect(twin.status).toBe('cancelled');
    expect(twin.detail).toContain('hedge');
    // §3.2: the cancelled leg is metered from what it streamed — a hedge is faster, never free
    expect(twin.usd).toBeGreaterThan(0);
    expect(twin.estimated).toBe(true);
    const round = src.round()!;
    expect(round.hedges).toBe(1);
    // the ORIGIN won, so the hedge bought nothing and says so
    expect(round.hedgeWins).toBe(0);
    expect(round.usd).toBeGreaterThan(twin.usd);
    expect(round.closed).toBe(true);
  });

  it('counts a hedgeWin and cancels the origin when the twin answers first', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true });
    src.fire(fireInput(budget()));
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null));
    g.legs[1]!.answer();
    await vi.advanceTimersByTimeAsync(0);
    const arrivals = await src.collectAll();
    expect(arrivals.find((a) => a.sample === 0)!.status).toBe('cancelled');
    expect(arrivals.find((a) => a.sample === HEDGE_TWIN_OFFSET)!.status).toBe('valid');
    const round = src.round()!;
    expect(round.hedges).toBe(1);
    expect(round.hedgeWins).toBe(1);
    // and the candidate the twin produced is the round's: a hedge that wins must actually deliver one
    expect(round.distinct).toBe(1);
  });
});

describe('§3.2 the refusal', () => {
  it('refuses the hedge when the dollar counter cannot hold one more sample at its FULL estimate', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true });
    // enough for the one sample the round fires and nothing beyond it
    const b = budget({ usdLeft: 0 });
    b.usdLeft = 0;
    const fired = src.fire(fireInput(b, { budget: b }));
    expect(fired.fired).toBe(false);

    const b2 = budget({ usdLeft: 1 });
    const g2 = parked();
    const src2 = source({ generate: g2.generate, hedge: true });
    expect(src2.fire(fireInput(b2)).fired).toBe(true);
    // the step's counter is spent by something else while the sample is in flight (the engine re-installs it)
    b2.usdLeft = 0;
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null));
    expect(g2.legs).toHaveLength(1);
    const round = src2.round()!;
    expect(round.hedges).toBe(0);
    // the refusal is recorded, not swallowed: the §8 decline histogram reads it
    expect(round.hedgesRefused).toBe(1);
    g2.legs[0]!.answer();
    await src2.collectAll();
  });

  it('refuses when the sample counter is spent, and never hedges a twin of a twin', async () => {
    vi.useFakeTimers();
    const g = parked();
    const src = source({ generate: g.generate, hedge: true });
    const b = budget({ samplesLeft: 1 });
    src.fire(fireInput(b));
    expect(b.samplesLeft).toBe(0);
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) * 3);
    expect(g.legs).toHaveLength(1);
    expect(src.round()!.hedgesRefused).toBe(1);
    g.legs[0]!.answer();
    await src.collectAll();
  });
});
