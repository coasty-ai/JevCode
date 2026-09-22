/**
 * `src/perf/render-lag.ts` pure parts: the child's `LAG_JSON` parser, the probe-floor calibration (`baselineFrom`,
 * `netLagP95`, `lagVerdict`: the gate is on the p95 net of the floor's median, raw when the floor is unusable, max
 * always raw), the geometry label and the splash bucket (TUI-DESIGN-2 §9: `dynamic` frames within 700 ms of the first
 * frame, the other classes reported, the window clipped at the first send, the gate ⌈(maxFps + 1) × 0.7⌉); plus a real
 * run of the baseline probe source itself.
 */
import { describe, expect, it } from 'vitest';
import { BASELINE_SECONDS, LAG_MAX_MS, LAG_P95_MS, LAG_PROBE_SOURCE, SPLASH_MS, SPLASH_SETTLE_MS, baselineFrom, describeGeometry, lagVerdict, measureLagBaseline, netLagP95, parseLag, runStartBucket, splashBucket, splashGateFor, type LagBaseline } from '../../../src/perf/render-lag.js';
import type { LagGeometry } from '../../../src/perf/render-lag.js';
import { BSU, ESU, classifyFrames, splitFrames, type Chunk } from '../../../src/perf/pty.js';

const floor: LagBaseline = { seconds: 17, samples: 1300, p50: 1.83, p95: 2.08, max: 2.71, ok: true };
const noisy: LagBaseline = { seconds: 17, samples: 1300, p50: 4.1, p95: 6.2, max: 9, ok: false };

describe('parseLag / baselineFrom', () => {
  it('reads LAG_JSON out of a capture and marks a floor usable only when its p95 is under the gate', () => {
    expect(parseLag('noise LAG_JSON={"p50":1.8,"p95":2.1,"max":2.7,"samples":1300} tail')).toEqual({ p50: 1.8, p95: 2.1, max: 2.7, samples: 1300 });
    expect(parseLag('no probe output')).toBeNull();
    expect(parseLag('LAG_JSON={"p50":null,"p95":null,"max":0,"samples":0}')).toEqual({ p50: null, p95: null, max: 0, samples: 0 });
    expect(baselineFrom({ p50: 1.8, p95: 2.1, max: 2.7, samples: 1300 }, 17)).toEqual({ seconds: 17, samples: 1300, p50: 1.8, p95: 2.1, max: 2.7, ok: true });
    expect(baselineFrom({ p50: 4.1, p95: LAG_P95_MS, max: 9, samples: 1300 }, 17).ok).toBe(false);
    expect(baselineFrom(null, 17)).toEqual({ seconds: 17, samples: 0, p50: null, p95: null, max: null, ok: false });
  });
});

describe('netLagP95 / lagVerdict', () => {
  it('subtracts the floor median from the raw p95, never below 0, and leaves the raw value when the floor is unusable', () => {
    expect(netLagP95(4.98, floor)).toBeCloseTo(3.15, 5);
    expect(netLagP95(1.0, floor)).toBe(0);
    expect(netLagP95(null, floor)).toBeNull();
    expect(netLagP95(4.98, noisy)).toBe(4.98);
  });
  it('gates net p95 < 5 ms and raw max < 50 ms, and needs samples', () => {
    expect(lagVerdict({ p50: 2.03, p95: 5.35, max: 17.37, samples: 1354 }, floor)).toEqual({ netP95: expect.closeTo(3.52, 5) as number, ok: true });
    expect(lagVerdict({ p50: 2.03, p95: 5.35, max: 17.37, samples: 1354 }, noisy)).toEqual({ netP95: 5.35, ok: false });
    expect(lagVerdict({ p50: 2.03, p95: 6.9, max: 17.37, samples: 1354 }, floor).ok).toBe(false);
    expect(lagVerdict({ p50: 2.03, p95: 4.0, max: LAG_MAX_MS, samples: 1354 }, floor).ok).toBe(false);
    expect(lagVerdict({ p50: null, p95: null, max: 0, samples: 0 }, floor)).toEqual({ netP95: null, ok: false });
    expect(lagVerdict(null, floor)).toEqual({ netP95: null, ok: false });
  });
  it('describeGeometry names the rows, reduced motion and the stress profile', () => {
    const g = { rows: 40, reducedMotion: false, profile: 'realistic' } as LagGeometry;
    expect(describeGeometry(g)).toBe('rows 40');
    expect(describeGeometry({ ...g, reducedMotion: true })).toBe('rows 40 reduced motion');
    expect(describeGeometry({ ...g, profile: 'stress' })).toBe('rows 40 stress');
  });
});

describe('splashBucket (TUI-DESIGN-2 §5.3 / §9 "dynamic fps")', () => {
  const fr = (rows: readonly string[]): string => `${BSU}\x1b[?25l${rows.join('\r\n')}\r\n\x1b[?25h${ESU}`;
  const wm = ['──', '  ██ ▓▒░', '╭─ jev-only ─╮', '│ › x │', '├──┤', '│ idle │', '╰──╯'];
  const settled = ['─── ◆ jevcode 0.2.0 ──', '╭─ jev-only ─╮', '│ › x │', '├──┤', '│ idle │', '╰──╯'];
  it('counts every frame within 700 ms of the first dynamic frame as dynamic when no classes are given, the wordmark frames among them, and whether the first frame carried the wordmark', () => {
    const cap = fr(wm) + fr(wm) + fr(settled) + fr(settled) + fr(settled);
    const { frames } = splitFrames(cap);
    const chunks: Chunk[] = frames.map((f, i) => ({ t: [100, 150, 700, 800, 1500][i]!, off: f.start, n: f.end - f.start }));
    expect(SPLASH_MS).toBe(700);
    expect(splashBucket(frames, chunks, 0)).toEqual({ frames: 4, staticFrames: 0, keyFrames: 0, wordmarkFrames: 2, inFirstFrame: true, windowMs: 700 });
    expect(splashBucket(frames, chunks, 2)).toEqual({ frames: 2, staticFrames: 0, keyFrames: 0, wordmarkFrames: 0, inFirstFrame: false, windowMs: 700 });
    expect(splashBucket(frames, chunks, 0, { windowMs: 100 })).toEqual({ frames: 2, staticFrames: 0, keyFrames: 0, wordmarkFrames: 2, inFirstFrame: true, windowMs: 100 });
    expect(splashBucket(frames, chunks, 9)).toEqual({ frames: 0, staticFrames: 0, keyFrames: 0, wordmarkFrames: 0, inFirstFrame: false, windowMs: 700 });
    // no chunk time for the first frame: nothing can be bucketed, the wordmark check still reads the frame
    expect(splashBucket(frames, [], 0)).toEqual({ frames: 0, staticFrames: 0, keyFrames: 0, wordmarkFrames: 0, inFirstFrame: true, windowMs: 700 });
  });
  it('counts only the `dynamic` class as splash frames: a typing (key) frame and a Static-carrying frame inside the window are reported apart, never gated', () => {
    const typed = ['──', '  ██ ▓▒░', '╭─ jev-only ─╮', '│ › xh │', '├──┤', '│ idle │', '╰──╯'];
    const bubble = ['[you] hi', '─── ◆ jevcode 0.2.0 ──', '╭─ jev-only ─╮', '│ › x │', '├──┤', '│ idle │', '╰──╯'];
    const cap = fr(wm) + fr(wm) + fr(typed) + fr(bubble) + fr(settled) + fr(settled);
    const { frames } = splitFrames(cap);
    const chunks: Chunk[] = frames.map((f, i) => ({ t: [100, 150, 210, 400, 650, 1500][i]!, off: f.start, n: f.end - f.start }));
    // a key sent at 200 ms: the 210 ms frame is its leading-edge render (`key`); the bubble frame carries a new Static row (`static`)
    const classes = classifyFrames(frames, chunks, [200], 34);
    expect(classes).toEqual(['dynamic', 'dynamic', 'key', 'static', 'dynamic', 'dynamic']);
    expect(splashBucket(frames, chunks, 0, { classes })).toEqual({ frames: 3, staticFrames: 1, keyFrames: 1, wordmarkFrames: 3, inFirstFrame: true, windowMs: 700 });
    // the window ends at the first send when that came earlier than 700 ms after the first frame: the key can never be a splash frame
    expect(splashBucket(frames, chunks, 0, { classes, firstSendAt: 200 })).toEqual({ frames: 2, staticFrames: 0, keyFrames: 0, wordmarkFrames: 2, inFirstFrame: true, windowMs: 100 });
    // a send after the window leaves it whole
    expect(splashBucket(frames, chunks, 0, { classes, firstSendAt: 900 }).windowMs).toBe(700);
  });
  it('splashGateFor is the dynamic-fps gate over the window: ⌈(maxFps + 1) × window / 1000⌉ — 22 at 30 fps over 700 ms, 15 at 20 fps, 4 over a 100 ms window', () => {
    expect(splashGateFor(30)).toBe(22);
    expect(splashGateFor(20)).toBe(15);
    expect(splashGateFor(30, 100)).toBe(4);
    expect(SPLASH_SETTLE_MS).toBeGreaterThan(SPLASH_MS);
  });
});

describe('measureLagBaseline (the probe source runs in a bare node)', () => {
  it('prints LAG_JSON after the requested seconds with samples of a 10 ms interval', async () => {
    expect(LAG_PROBE_SOURCE).toContain("'LAG_JSON='");
    expect(BASELINE_SECONDS).toBe(17);
    const b = await measureLagBaseline(1.2);
    // 1.2 s minus the 500 ms warm-up at a 10 ms interval: about 70 samples; the floor is machine-dependent, only its shape is asserted
    expect(b.seconds).toBe(1.2);
    expect(b.samples).toBeGreaterThan(40);
    expect(b.p50).not.toBeNull();
    expect(b.p95).not.toBeNull();
    expect(b.max).not.toBeNull();
    expect(b.p50!).toBeLessThanOrEqual(b.p95!);
    expect(b.p95!).toBeLessThanOrEqual(b.max!);
  }, 15_000);
});

describe('runStartBucket (TUI-DESIGN-3 §5.2 A5 / §9 "run-start bucket")', () => {
  const fr = (rows: readonly string[]): string => `${BSU}\x1b[?25l${rows.join('\r\n')}\r\n\x1b[?25h${ESU}`;
  const idle = ['─── ◆ jevcode 0.3.0 ──', '╭─ jev+llm ─╮', '│ › x │', '├──┤', '│ idle │', '╰──╯'];
  // TUI-DESIGN-4 §3.6 (D-V, G1) / §3.7: the run's opening item, the fixture `RUN_STARTED_PATTERN` must keep matching
  const start = ['    [run] started \u00b7 jev+llm \u00b7 t', '─── ◆ jevcode 0.3.0 ──', '╭─ jev+llm ─╮', '│ › x │', '├──┤', '│ ▓ context  step 0/40 │', '╰──╯'];
  const live = ['─── ▸ jev s1 · 2 decisions ──', '╭─ jev+llm ─╮', '│ › x │', '├──┤', '│ ▓ propose  step 1/40 │', '╰──╯'];
  it('counts the `dynamic` frames within one second of the `[run] start` frame; static frames in the window are not counted; −1 without a run', () => {
    const cap = fr(idle) + fr(idle) + fr(start) + fr(live) + fr(live) + fr(['[step 1] run $ pytest -q · risk 0.00 ok', ...live]) + fr(live) + fr(live);
    const { frames } = splitFrames(cap);
    const times = [100, 500, 1000, 1050, 1300, 1600, 1990, 2100];
    const chunks: Chunk[] = frames.map((f, i) => ({ t: times[i]!, off: f.start, n: f.end - f.start }));
    const classes = classifyFrames(frames, chunks, [], 34);
    expect(classes).toEqual(['dynamic', 'dynamic', 'static', 'dynamic', 'dynamic', 'static', 'dynamic', 'dynamic']);
    // the window [1000, 2000]: the start frame itself is static (it carries the item), three dynamic frames follow inside it, the 2100 frame is outside
    expect(runStartBucket(frames, chunks, classes, cap)).toBe(3);
    expect(runStartBucket(frames, chunks, classes, cap, 300)).toBe(1);
    expect(runStartBucket(splitFrames(fr(idle) + fr(idle)).frames, chunks, ['dynamic', 'dynamic'], fr(idle) + fr(idle))).toBe(-1);
    // a run that started but whose frame has no chunk time cannot be bucketed
    expect(runStartBucket(frames, [], classes, cap)).toBe(-1);
  });
});
