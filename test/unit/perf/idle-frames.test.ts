/**
 * `src/perf/idle-frames.ts` pure parts (TUI-DESIGN-3 §3.9 / §9 "idle animation"): the settle frame (the caption `◆ <version>`, or the
 * brand-row twin), the per-second bucketing of the frames after it over `[settle + 1 s, settle + 31 s)`, and the gate arithmetic —
 * peak ≤ 4 and mean ≤ 2 dynamic frames per second, bytes ≤ 12 KB peak / ≤ 5 KB mean, hygiene — on synthetic captures: a design
 * pass (16 frames in 4 s then 6 s of rest, period 10 s), a loop that never rests, a fat frame, no settle at all.
 */
import { describe, expect, it } from 'vitest';
import { IDLE_BYTES_MEAN, IDLE_BYTES_PEAK, IDLE_FPS_MEAN, IDLE_FPS_PEAK, IDLE_WINDOW_FROM_MS, IDLE_WINDOW_TO_MS, SETTLE_RE, bucketIdle, describeIdle, judgeIdle, parsePsTime, settleFrame } from '../../../src/perf/idle-frames.js';
import { BSU, ESU, splitFrames, type Chunk } from '../../../src/perf/pty.js';

const fr = (rows: readonly string[]): string => `${BSU}\x1b[?25l${rows.join('\r\n')}\r\n\x1b[?25h${ESU}`;
const CONSOLE = ['╭─ jev+llm ─────── proj ─╮', '│ › Say hi, ask a question, or describe a task…  │', '├──────────┤', '│ idle       step 0/–  sess $0.00/10.00 ok  ? help │', '╰──────────╯'];
const MARK = ['        ██ ███████ ██    ██  ██████  ██████  ██████  ███████', '        ██ ██      ██    ██ ██      ██    ██ ██   ██ ██', '        ██ █████   ██    ██ ██      ██    ██ ██   ██ █████', '    ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██', '     ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0'];
const reveal = fr(['────', '  ██ ▓▒░', ...CONSOLE]);
const settled = fr(['────', ...MARK, ...CONSOLE]);
/** a band frame: the same rows with a sweep SGR on a few cells (colour only) */
const band = (k: number): string => fr(['────', ...MARK.map((r) => `${r.slice(0, 8 + k)}\x1b[38;5;224m${r.slice(8 + k, 12 + k)}\x1b[39m${r.slice(12 + k)}`), ...CONSOLE]);

/** a capture whose frames arrive at the given times (ms); chunks align one per frame */
function capture(frames: readonly { body: string; t: number }[]): { cap: string; chunks: Chunk[] } {
  let cap = '';
  const chunks: Chunk[] = [];
  for (const f of frames) {
    chunks.push({ t: f.t, off: cap.length, n: f.body.length });
    cap += f.body;
  }
  return { cap, chunks };
}

/** the design pass (TUI-DESIGN-3 §3.4): k = 1..16 written at 250 ms from `start`, then rest until `start + period` */
function pass(start: number): { body: string; t: number }[] {
  const out: { body: string; t: number }[] = [];
  for (let k = 1; k <= 16; k++) out.push({ body: band(k % 5), t: start + 250 * k });
  return out;
}

describe('settleFrame / SETTLE_RE', () => {
  it('finds the caption frame `◆ <version>` (utf8 and latin1) and the brand-row twin; null without either', () => {
    expect(SETTLE_RE.test('     ████  ███████  ◆ 0.3.0')).toBe(true);
    expect(SETTLE_RE.test('─── ◆ jevcode 0.2.0 ───')).toBe(true);
    expect(SETTLE_RE.test('â\u0097\u0086 0.10.0')).toBe(true);
    expect(SETTLE_RE.test('◆ jevcode')).toBe(false);
    const { cap, chunks } = capture([{ body: reveal, t: 100 }, { body: reveal, t: 150 }, { body: settled, t: 560 }, { body: settled, t: 700 }]);
    const { frames } = splitFrames(cap);
    expect(settleFrame(frames, chunks, 0)).toEqual({ index: 2, at: 560 });
    expect(settleFrame(frames, chunks, 3)).toEqual({ index: 3, at: 700 });
    expect(settleFrame(splitFrames(reveal + reveal).frames, [{ t: 1, off: 0, n: reveal.length }, { t: 2, off: reveal.length, n: reveal.length }], 0)).toBeNull();
  });
});

describe('bucketIdle (the 30 one-second buckets after the settle)', () => {
  it('a design pass (16 frames in 4 s, then rest; period 10 s) buckets to ≤ 4 per second with a 1.6/s mean, all wordmark frames, no static', () => {
    const settleAt = 560;
    const frames = [{ body: reveal, t: 100 }, { body: settled, t: settleAt }];
    // passes start at settle + 5,890 ms (the 700 ms `splash:done` + 5,750 ms rest, from the first frame at 100) and every 10 s after
    for (const start of [6450, 16_450, 26_450]) frames.push(...pass(start));
    const { cap, chunks } = capture(frames);
    const b = bucketIdle(splitFrames(cap).frames, chunks, 0);
    expect(b.settleAt).toBe(settleAt);
    expect(b.buckets).toHaveLength(30);
    expect(b.buckets[0]!.second).toBe(1);
    expect(Math.max(...b.buckets.map((x) => x.dynamic))).toBe(4);
    const total = b.buckets.reduce((n, x) => n + x.dynamic, 0);
    expect(total).toBe(48);
    expect(b.wordmarkFrames).toBe(48);
    expect(b.buckets.every((x) => x.static === 0)).toBe(true);
    expect(b.buckets.every((x) => x.bytes === x.dynamic * band(1).length || x.bytes === 0 || x.dynamic > 0)).toBe(true);
    const g = judgeIdle(b, { clears: 0, regionMax: 11, rows: 24, exitCode: 0, timedOut: false, frames: frames.length }, { rows: 24, columns: 80, wordmark: 'sweep' });
    expect(g.fpsMax).toBe(4);
    expect(g.fpsMean).toBeCloseTo(1.6, 5);
    expect(g.fpsOk).toBe(true);
    expect(g.bytesOk).toBe(true);
    expect(g.hygieneOk).toBe(true);
    expect(g.pass).toBe(true);
    expect(describeIdle(g)).toContain('48 dynamic frames over 30 s (peak 4/s, mean 1.60/s');
  });
  it('frames before `settle + 1 s` and at or after `settle + 31 s` are outside the window; a frame with new Static rows counts as static, not dynamic', () => {
    const early = { body: settled, t: 560 + 999 };
    const late = { body: settled, t: 560 + 31_000 };
    const inside = { body: settled, t: 560 + 1000 };
    const staticFrame = { body: fr(['[you] hi', '────', ...MARK, ...CONSOLE]), t: 560 + 5000 };
    const { cap, chunks } = capture([{ body: reveal, t: 100 }, { body: settled, t: 560 }, early, inside, staticFrame, late]);
    const b = bucketIdle(splitFrames(cap).frames, chunks, 0);
    expect(b.buckets.reduce((n, x) => n + x.dynamic, 0)).toBe(1);
    expect(b.buckets.reduce((n, x) => n + x.static, 0)).toBe(1);
    expect(b.buckets[0]!.dynamic).toBe(1);
    expect(b.buckets[4]!.static).toBe(1);
    expect(IDLE_WINDOW_FROM_MS).toBe(1000);
    expect(IDLE_WINDOW_TO_MS).toBe(31_000);
  });
  it('no settle frame: no buckets, and the geometry fails every gate rather than passing vacuously', () => {
    const { cap, chunks } = capture([{ body: reveal, t: 100 }, { body: reveal, t: 200 }]);
    const b = bucketIdle(splitFrames(cap).frames, chunks, 0);
    expect(b.settleAt).toBeNull();
    expect(b.buckets).toEqual([]);
    const g = judgeIdle(b, { clears: 0, regionMax: 11, rows: 24, exitCode: 0, timedOut: false, frames: 2 }, { rows: 24, columns: 80, wordmark: 'sweep' });
    expect(g.fpsOk).toBe(false);
    expect(g.bytesOk).toBe(false);
    expect(g.pass).toBe(false);
    expect(describeIdle(g)).toContain('settle NOT SEEN');
  });
});

describe('judgeIdle (the §3.9 gates)', () => {
  const base = (): ReturnType<typeof bucketIdle> => ({ settleAt: 560, settleIndex: 1, buckets: Array.from({ length: 30 }, (_, i) => ({ second: i + 1, dynamic: 0, static: 0, bytes: 0, wordmark: 0 })), wordmarkFrames: 0 });
  const hygiene = { clears: 0, regionMax: 11, rows: 24, exitCode: 0, timedOut: false, frames: 10 };
  const geo = { rows: 24, columns: 80, wordmark: 'sweep' as const };
  it('peak: a fifth frame in one second fails; mean: a loop that never rests (4/s for 30 s) fails the mean while every bucket passes the peak', () => {
    expect(IDLE_FPS_PEAK).toBe(4);
    expect(IDLE_FPS_MEAN).toBe(2);
    const five = base();
    five.buckets[3]!.dynamic = 5;
    expect(judgeIdle(five, hygiene, geo).fpsOk).toBe(false);
    const busy = base();
    for (const b of busy.buckets) b.dynamic = 4;
    const g = judgeIdle(busy, hygiene, geo);
    expect(g.fpsMax).toBe(4);
    expect(g.fpsMean).toBe(4);
    expect(g.fpsOk).toBe(false);
    const calm = base();
    for (let i = 0; i < 30; i += 2) calm.buckets[i]!.dynamic = 4;
    expect(judgeIdle(calm, hygiene, geo).fpsMean).toBe(2);
    expect(judgeIdle(calm, hygiene, geo).fpsOk).toBe(true);
  });
  it('bytes: 12 KB in one second is the peak limit, 5 KB/s the mean; a 3 KB frame × 4 passes', () => {
    expect(IDLE_BYTES_PEAK).toBe(12 * 1024);
    expect(IDLE_BYTES_MEAN).toBe(5 * 1024);
    // the design pass: 16 frames of ≈ 2.1 KB per 10 s at 80 columns (≈ 2.8 KB at 120) — four 2.9 KB frames in one second are inside the peak
    const ok = base();
    for (let i = 0; i < 30; i += 10) {
      for (let k = 0; k < 4; k++) {
        ok.buckets[i + k]!.dynamic = 4;
        ok.buckets[i + k]!.bytes = 4 * 2900;
      }
    }
    const g = judgeIdle(ok, hygiene, geo);
    expect(g.bytesMax).toBe(11_600);
    expect(g.bytesMean).toBeCloseTo((12 * 4 * 2900) / 30, 5);
    expect(g.bytesOk).toBe(true);
    expect(g.fpsOk).toBe(true);
    const fat = base();
    fat.buckets[0]!.bytes = 12 * 1024 + 1;
    expect(judgeIdle(fat, hygiene, geo).bytesOk).toBe(false);
    const heavy = base();
    for (const b of heavy.buckets) b.bytes = 5 * 1024 + 1;
    expect(judgeIdle(heavy, hygiene, geo).bytesOk).toBe(false);
  });
  it('hygiene: a clear, a region above rows − 2, a non-zero exit or a timeout fails; the CPU figure is carried, never gated', () => {
    const b = base();
    expect(judgeIdle(b, hygiene, geo).pass).toBe(true);
    expect(judgeIdle(b, { ...hygiene, clears: 1 }, geo).hygieneOk).toBe(false);
    expect(judgeIdle(b, { ...hygiene, regionMax: 23 }, geo).hygieneOk).toBe(false);
    expect(judgeIdle(b, { ...hygiene, exitCode: 1 }, geo).hygieneOk).toBe(false);
    expect(judgeIdle(b, { ...hygiene, timedOut: true }, geo).hygieneOk).toBe(false);
    const cpu = { startMs: 350, endMs: 890, deltaMs: 540, perSecondMs: 18 };
    const g = judgeIdle(b, hygiene, geo, cpu);
    expect(g.cpu).toEqual(cpu);
    expect(g.pass).toBe(true);
    expect(describeIdle(g)).toContain('cpu 540 ms over the window (18.0 ms/s)');
    expect(judgeIdle(b, hygiene, geo, { ...cpu, perSecondMs: 90 }).pass).toBe(true);
  });
  it('parsePsTime reads `m:ss.cc` and `h:mm:ss`', () => {
    expect(parsePsTime('0:01.23')).toBe(1230);
    expect(parsePsTime(' 12:03.50 ')).toBe(723_500);
    expect(parsePsTime('1:02:03')).toBe(3_723_000);
    expect(parsePsTime('garbage')).toBeNull();
  });
});
