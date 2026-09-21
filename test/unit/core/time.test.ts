/**
 * TUI-DESIGN §19.0 (O1 wave 0/2): `src/core/time.ts` — `sleep(ms, signal?, wake?)` per §13.2 (the `[r] retry now`
 * waker) and §15.2 `core/time.ts`, plus the duration helpers. Fake timers only; nothing here waits for real time.
 */
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../../src/errors.js';
import { AbortError } from '../../../src/errors.js';
import { MAX_TIMER_MS, formatDuration, parseDuration, percentile, sleep } from '../../../src/core/time.js';
import type { SleepFn } from '../../../src/core/time.js';

/** Settle a promise into a tagged result so a rejection never escapes the test. */
function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
}

describe('sleep(ms, signal?, wake?) — TUI-DESIGN §13.2 waker, §15.2 core/time.ts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the timer fires and not one millisecond before; the timer is gone afterwards', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with signal.reason when aborted mid-sleep and clears the timer (the engine abort ends the wait)', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const out = settled(sleep(5000, ac.signal));
    await vi.advanceTimersByTimeAsync(10);
    ac.abort(reason);
    expect(await out).toEqual({ ok: false, reason });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects at once on an already-aborted signal — signal wins even when wake is already aborted too', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const wake = new AbortController();
    const reason = new AbortError('signal');
    ac.abort(reason);
    wake.abort();
    expect(await settled(sleep(1000, ac.signal, wake.signal))).toEqual({ ok: false, reason });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves early when wake aborts (§13.2 `[r]`); the timer is cleared and a later signal abort is a no-op', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const wake = new AbortController();
    let done = false;
    const p = sleep(60_000, ac.signal, wake.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    wake.abort();
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    ac.abort(new AbortError('human_abort'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(true);
  });

  it('an already-aborted wake resolves immediately without creating a timer', async () => {
    vi.useFakeTimers();
    const wake = new AbortController();
    wake.abort();
    await sleep(60_000, undefined, wake.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds exactly one abort listener per signal while sleeping and none after any settle path (timer, signal, wake)', async () => {
    vi.useFakeTimers();
    for (const path of ['timer', 'signal', 'wake'] as const) {
      const ac = new AbortController();
      const wake = new AbortController();
      const out = settled(sleep(100, ac.signal, wake.signal));
      expect(getEventListeners(ac.signal, 'abort'), path).toHaveLength(1);
      expect(getEventListeners(wake.signal, 'abort'), path).toHaveLength(1);
      if (path === 'timer') await vi.advanceTimersByTimeAsync(100);
      else if (path === 'signal') ac.abort(new AbortError('human_abort'));
      else wake.abort();
      const r = await out;
      expect(r.ok, path).toBe(path !== 'signal');
      expect(getEventListeners(ac.signal, 'abort'), path).toHaveLength(0);
      expect(getEventListeners(wake.signal, 'abort'), path).toHaveLength(0);
      expect(vi.getTimerCount(), path).toBe(0);
    }
  });

  it('one controller per sleep: a wake that ended one sleep is spent; the next sleep needs its own and runs its full length', async () => {
    vi.useFakeTimers();
    const used = new AbortController();
    const first = sleep(1000, undefined, used.signal);
    used.abort();
    await first;
    // §13.2: the engine's onRetry creates a fresh controller before each sleep; reusing `used` would end the next sleep at once
    const fresh = new AbortController();
    let done = false;
    const second = sleep(1000, undefined, fresh.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(done).toBe(true);
  });

  it('NaN, negative and zero delays run on the next tick; Infinity and a delay above Node’s 2^31 − 1 ms cap are clamped to the cap — never a warning, never an early fire', async () => {
    vi.useFakeTimers();
    let n = 0;
    const quick = [sleep(Number.NaN), sleep(-5), sleep(0)].map((p) =>
      p.then(() => {
        n++;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(quick);
    expect(n).toBe(3);
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    let fired = 0;
    const clamped = [sleep(Number.MAX_SAFE_INTEGER), sleep(Number.POSITIVE_INFINITY)].map((p) =>
      p.then(() => {
        fired++;
      }),
    );
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
    expect(fired).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(clamped);
    expect(fired).toBe(2);
  });

  it('sleep(Infinity, signal, wake) is "until woken or aborted": wake resolves it, abort rejects it, nothing fires by itself', async () => {
    vi.useFakeTimers();
    const wake = new AbortController();
    let woken = false;
    const p = sleep(Number.POSITIVE_INFINITY, undefined, wake.signal).then(() => {
      woken = true;
    });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(woken).toBe(false);
    wake.abort();
    await p;
    expect(woken).toBe(true);
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    const out = settled(sleep(Number.POSITIVE_INFINITY, ac.signal));
    ac.abort(reason);
    expect(await out).toEqual({ ok: false, reason });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is the SleepFn shape both clients accept as an injected dependency', () => {
    const f: SleepFn = sleep;
    expect(f).toBe(sleep);
    expect(sleep.length).toBe(3);
  });
});

describe('duration helpers', () => {
  it('parseDuration accepts compound units and bare milliseconds, rejects junk with a ConfigError naming the setting', () => {
    expect(parseDuration('7h30m')).toBe(27_000_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('1500ms')).toBe(1500);
    expect(parseDuration(' 2H ')).toBe(7_200_000);
    expect(parseDuration('1500')).toBe(1500);
    expect(parseDuration('0.5s')).toBe(500);
    for (const bad of ['', 'soon', '5x', '30m5', '-3s', '0s']) {
      expect(() => parseDuration(bad, 'limits.maxWall')).toThrowError(ConfigError);
      expect(() => parseDuration(bad, 'limits.maxWall')).toThrowError(/limits\.maxWall/);
    }
  });

  it('formatDuration picks the coarsest unit that keeps the value exact', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1500)).toBe('1s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h30m');
  });

  it('percentile is nearest-rank and null on an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  });
});
