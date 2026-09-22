/**
 * `hedgedCall` (contract 1.9 "Fastlane" §3.2, docs/LLM-LOOP-DESIGN.md §3.2) — the single-call race the `jev-on`
 * propose path uses, as against the round's own hedge in `source.ts`.
 *
 * The module's whole failure contract is one sentence: *"a leg that rejects while the other is still live is not
 * the call's answer"*, which is what makes a hedged call **never less reliable than an unhedged one**. The
 * adversarial review's defect **A1** found the one drain order where that was false, and it is the order a real
 * provider produces most often: two legs of the SAME request against the same upstream settle in the same
 * microtask drain, the origin with a 5xx and the twin with an answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEDGE_TWIN_OFFSET, hedgeAfterMs, hedgedCall } from '../../../../src/synth/llm/hedge.js';

interface Pending<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function pending<T>(): Pending<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('§3.2 hedgedCall — a hedged call is never less reliable than an unhedged one', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Review defect A1, verbatim. The twin has ALREADY settled with a result when the origin's rejection is the
   * event the race hands back. Filtering `live` on "has this leg settled" (rather than on "is this the leg whose
   * event I just consumed") removed the twin too, `live.length === 0` broke the loop and the origin's error was
   * thrown over a result that was sitting in hand. In the engine this is a failed propose attempt on a jev-on S2
   * step where an UNHEDGED call would have succeeded.
   */
  it('takes the twin\'s result when the twin settles in the same drain as the origin\'s rejection', async () => {
    const origin = pending<string>();
    const twin = pending<string>();
    const call = hedgedCall<string>({
      hedge: true,
      p50TtfbMs: () => null,
      run: (leg) => (leg.twin ? twin.promise : origin.promise),
    });
    // the origin produced no first byte, so the twin is fired
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 1);
    // ...and both legs settle in ONE drain, the origin first
    origin.reject(new Error('origin boom'));
    twin.resolve('TWIN');
    const out = await call;
    expect(out.result).toBe('TWIN');
    expect(out.wonBy).toBe('twin');
    expect(out.hedges).toBe(1);
    expect(out.hedgeWins).toBe(1);
  });

  it('takes the twin\'s result when the origin rejects first and the twin answers a tick later', async () => {
    const origin = pending<string>();
    const twin = pending<string>();
    const call = hedgedCall<string>({ hedge: true, p50TtfbMs: () => null, run: (leg) => (leg.twin ? twin.promise : origin.promise) });
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 1);
    origin.reject(new Error('origin boom'));
    await vi.advanceTimersByTimeAsync(1);
    twin.resolve('TWIN');
    await expect(call).resolves.toMatchObject({ result: 'TWIN', wonBy: 'twin' });
  });

  it('the ORIGIN\'s error still travels when BOTH legs reject — the unhedged answer, unchanged', async () => {
    const origin = pending<string>();
    const twin = pending<string>();
    const call = hedgedCall<string>({ hedge: true, p50TtfbMs: () => null, run: (leg) => (leg.twin ? twin.promise : origin.promise) });
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 1);
    origin.reject(new Error('origin boom'));
    twin.reject(new Error('twin boom'));
    await expect(call).rejects.toThrow('origin boom');
  });

  it('an origin that answers first wins, cancels the twin and reports hedgeWins 0', async () => {
    const origin = pending<string>();
    const twin = pending<string>();
    let twinAborted = 0;
    const call = hedgedCall<string>({
      hedge: true,
      p50TtfbMs: () => null,
      run: (leg) => {
        if (!leg.twin) return origin.promise;
        leg.signal.addEventListener('abort', () => {
          twinAborted += 1;
        });
        return twin.promise;
      },
    });
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 1);
    origin.resolve('ORIGIN');
    const out = await call;
    expect(out).toMatchObject({ result: 'ORIGIN', wonBy: 'origin', hedges: 1, hedgeWins: 0 });
    expect(twinAborted).toBe(1);
  });

  it('the twin carries HEDGE_TWIN_OFFSET as its leg index, and an unhedged call runs exactly one leg', async () => {
    const seen: number[] = [];
    const armed = hedgedCall<string>({
      hedge: true,
      p50TtfbMs: () => null,
      run: (leg) => {
        seen.push(leg.sample);
        return leg.twin ? Promise.resolve('TWIN') : new Promise<string>(() => undefined);
      },
    });
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 1);
    expect((await armed).result).toBe('TWIN');
    expect(seen).toEqual([0, HEDGE_TWIN_OFFSET]);

    const off: number[] = [];
    const plain = await hedgedCall<string>({
      hedge: false,
      p50TtfbMs: () => null,
      run: (leg) => {
        off.push(leg.sample);
        return Promise.resolve('ONE');
      },
    });
    expect(plain).toMatchObject({ result: 'ONE', hedges: 0, hedgeWins: 0, wonBy: 'origin' });
    expect(off).toEqual([0]);
  });
});
