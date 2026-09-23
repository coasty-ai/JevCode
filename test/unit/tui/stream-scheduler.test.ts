/**
 * TUI map top change 4 (slice S5a): the one stream scheduler — the first append after a quiet interval flushes
 * synchronously (a leading edge), later appends flush at most once per interval measured from the last flush, and no
 * timer exists while nothing is waiting. A fake clock drives every case.
 */
import { describe, expect, it } from 'vitest';
import { STREAM_LOCAL_MS, STREAM_REDUCED_MS, STREAM_SSH_MS, createStreamScheduler, streamIntervalMs, type StreamClock } from '../../../src/tui/stream-scheduler.js';

function fakeClock(): StreamClock & { t: number; advance(ms: number): void; timers: number } {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    get t() {
      return t;
    },
    set t(v: number) {
      t = v;
    },
    get timers() {
      return pending.size;
    },
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
  return clock;
}

describe('streamIntervalMs: the cadence from the launch', () => {
  it('launch.fps locally (33 ms at 30 fps), ≥ 67 ms over SSH, 250 ms under reduced motion', () => {
    expect(streamIntervalMs({ fps: 30 })).toBe(STREAM_LOCAL_MS);
    expect(STREAM_LOCAL_MS).toBe(33);
    expect(streamIntervalMs({ fps: 30, ssh: true })).toBe(STREAM_SSH_MS);
    expect(STREAM_SSH_MS).toBe(67);
    expect(streamIntervalMs({ fps: 15, ssh: true })).toBe(67);
    expect(streamIntervalMs({ fps: 30, reducedMotion: true })).toBe(STREAM_REDUCED_MS);
    expect(STREAM_REDUCED_MS).toBe(250);
    expect(streamIntervalMs({ fps: 60 })).toBe(17);
    expect(streamIntervalMs({ fps: 240 })).toBe(16);
    expect(streamIntervalMs({ fps: Number.NaN })).toBe(33);
    expect(streamIntervalMs({})).toBe(33);
  });
});

describe('createStreamScheduler', () => {
  it('the first append after quiet flushes synchronously as a leading edge, with no timer left behind', () => {
    const c = fakeClock();
    const flushes: boolean[] = [];
    const s = createStreamScheduler((leading) => flushes.push(leading), 33, c);
    s.poke();
    expect(flushes).toEqual([true]);
    expect(c.timers).toBe(0);
    expect(s.pending).toBe(false);
  });

  it('then at most one flush per interval measured from the last flush — a steady stream never stretches the interval', () => {
    const c = fakeClock();
    const at: number[] = [];
    const s = createStreamScheduler(() => at.push(c.t), 33, c);
    // an append every 5 ms for 500 ms
    for (let i = 0; i < 100; i++) {
      s.poke();
      c.advance(5);
    }
    c.advance(100);
    expect(at[0]).toBe(0);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!, `flush ${i}`).toBe(33);
    // ~500 ms / 33 ms flushes, never one per append
    expect(at.length).toBeLessThanOrEqual(Math.ceil(500 / 33) + 1);
    expect(at.length).toBeGreaterThanOrEqual(Math.floor(500 / 33));
  });

  it('a burst inside one interval is ONE trailing flush; quiet for an interval makes the next append leading again', () => {
    const c = fakeClock();
    const flushes: Array<[number, boolean]> = [];
    const s = createStreamScheduler((leading) => flushes.push([c.t, leading]), 33, c);
    s.poke();
    c.advance(1);
    for (let i = 0; i < 40; i++) s.poke();
    expect(flushes).toEqual([[0, true]]);
    c.advance(40);
    expect(flushes).toEqual([
      [0, true],
      [33, false],
    ]);
    c.advance(100);
    s.poke();
    expect(flushes.at(-1)).toEqual([141, true]);
    expect(c.timers).toBe(0);
  });

  it('flushNow flushes at once and cancels the pending one; cancel drops it; neither leaves a timer', () => {
    const c = fakeClock();
    const flushes: boolean[] = [];
    const s = createStreamScheduler((leading) => flushes.push(leading), 33, c);
    s.poke();
    c.advance(5);
    s.poke();
    expect(s.pending).toBe(true);
    s.flushNow();
    expect(flushes).toEqual([true, false]);
    expect(c.timers).toBe(0);
    c.advance(5);
    s.poke();
    expect(s.pending).toBe(true);
    s.cancel();
    c.advance(200);
    expect(flushes).toEqual([true, false]);
    expect(c.timers).toBe(0);
  });

  it('a leading edge reports how long the stream was quiet (the very first flush: forever); a cadence flush reports 0', () => {
    const c = fakeClock();
    const seen: Array<[boolean, number]> = [];
    const s = createStreamScheduler((leading, quiet) => seen.push([leading, quiet]), 33, c);
    c.advance(1000);
    s.poke();
    expect(seen[0]![0]).toBe(true);
    expect(seen[0]![1]).toBe(Number.POSITIVE_INFINITY);
    c.advance(50);
    s.poke();
    expect(seen[1]).toEqual([true, 50]);
    c.advance(10);
    s.poke();
    c.advance(40);
    expect(seen[2]).toEqual([false, 0]);
  });

  it('a non-positive or non-finite interval falls back to the local cadence', () => {
    expect(createStreamScheduler(() => undefined, 0).intervalMs).toBe(STREAM_LOCAL_MS);
    expect(createStreamScheduler(() => undefined, Number.NaN).intervalMs).toBe(STREAM_LOCAL_MS);
    expect(createStreamScheduler(() => undefined, 67).intervalMs).toBe(67);
  });
});
