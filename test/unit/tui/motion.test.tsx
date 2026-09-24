/**
 * TUI-DESIGN-3 §3.6 / §8 S2 (`motion.test.tsx`): `useIdleLoop` on the real Ink renderer (a stub TTY, the
 * `key-immediate-render.test.tsx` pattern; the intervals scaled through the test overrides) — starts in `rest` when activated
 * and writes no band before the rest interval; a pass writes 16 frames (k = 1..16) and the rest none; a key mid-pass leaves the
 * band non-null until k = 16 and no new pass starts within the quiet window; `band` is null in every rest render (the wake
 * glitch); inactive under reduced motion / depth 0 (`enabled` false), hidden, `splashRunning` and `asleep`; the subscriber
 * count returns to 0 when hidden (observed through frame counts); `attentionAt` tiers; a key commit 5 ms after an animation
 * frame paints synchronously (D-F re-asserted beside the loop).
 */
// Load-sensitive REAL-RENDERER tests (Ink on a real event loop): under a shared-machine load spike a single case can miss its
// frame window and fail while passing alone (observed on a loaded machine). Every top-level suite
// carries `{ retry: 1 }`: one retry absorbs a hiccup; a real regression still fails twice and stays red.
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { LOOP_ATTENTIVE_MS, LOOP_PASS_TICKS, LOOP_SLEEP_MS, loopBand } from '../../../src/tui/wordmark.js';
import { attentionAt, useIdleLoop, type IdleLoopInput } from '../../../src/tui/motion.js';
import type { TranscriptItem } from '../../../src/tui/plain.js';
import { Transcript } from '../../../src/tui/Transcript.js';
import { StubStdin, StubStdout } from './stub-stdout.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/** one array for every render: a fresh `items` would itself re-render `<Static>` */
const NO_ITEMS: readonly TranscriptItem[] = [];
/** the scaled intervals: the pass tick ≥ the 17 ms throttle of maxFps 60 (no tick is coalesced), a 120 ms rest, a 200 ms quiet window */
const PASS_MS = 25;
const REST_MS = 120;
const QUIET_MS = 200;

const ACTIVE: IdleLoopInput = { shown: true, splashRunning: false, enabled: true, attention: 'attentive', nowMs: 10_000, lastKeystrokeAt: 0, intervalMs: PASS_MS, restMs: REST_MS, quietMs: QUIET_MS };

function Probe({ input, keySeq, text }: { input: IdleLoopInput; keySeq: number; text: string }): React.JSX.Element {
  const loop = useIdleLoop(input);
  const band = loop.band === null ? 'none' : `${loop.band.from}-${loop.band.to}`;
  return (
    <Box flexDirection="column">
      <Transcript items={NO_ITEMS} keySeq={keySeq} columns={60} />
      <Text>{`phase=${loop.phase} k=${loop.k} band=${band} ${text}`}</Text>
    </Box>
  );
}

interface Seen {
  phase: string;
  k: number;
  band: string;
  /** ms since the mount (or the last `rerender`) when the frame was written — the load-independent clock of every timing assertion */
  at: number;
}

interface Mount {
  stdout: StubStdout;
  /** every frame's loop line, in write order */
  seen: () => Seen[];
  painted: () => string;
  /** re-render and reset the clock the `at` stamps count from */
  rerender: (input: IdleLoopInput, keySeq?: number, text?: string) => void;
  unmount: () => void;
}

const mounts: Mount[] = [];
afterEach(() => {
  for (const m of mounts.splice(0)) m.unmount();
});

function mount(input: IdleLoopInput): Mount {
  const stdout = new StubStdout(24, 60, true);
  const stdin = new StubStdin();
  const stamps: number[] = [];
  let origin = Date.now();
  const write = stdout.write;
  stdout.write = (chunk: string): boolean => {
    stamps.push(Date.now() - origin);
    return write(chunk);
  };
  const inst = render(<Probe input={input} keySeq={0} text="t0" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    maxFps: 60,
    patchConsole: false,
    exitOnCtrlC: false,
    // the stub is a TTY; without this Ink's `is-in-ci` (CI=true on every runner) makes it non-interactive and it writes only at unmount
    interactive: true,
  });
  let lastKeySeq = 0;
  let lastText = 't0';
  const m: Mount = {
    stdout,
    seen: () =>
      stdout.frames
        .map((f, i) => ({ m: /phase=(\w+) k=(\d+) band=(\S+)/.exec(strip(f)), at: stamps[i] ?? 0 }))
        .filter((x): x is { m: RegExpExecArray; at: number } => x.m !== null)
        .map((x) => ({ phase: x.m[1] ?? '', k: Number(x.m[2]), band: x.m[3] ?? '', at: x.at })),
    painted: () => strip(stdout.frames.join('')),
    rerender: (i, keySeq = lastKeySeq, text = lastText) => {
      lastKeySeq = keySeq;
      lastText = text;
      origin = Date.now();
      inst.rerender(<Probe input={i} keySeq={keySeq} text={text} />);
    },
    unmount: () => inst.unmount(),
  };
  mounts.push(m);
  return m;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(3);
  }
  return pred();
}

/**
 * The k values of the band frames of every pass, in order, de-duplicated. k = 0 (the transition render: phase `pass`, no band —
 * identical pixels in the App) and k = 16 (the clearing write, which is the first `rest` render of the next rest, band none) are
 * not band frames: a pass writes 15 band frames + 1 clearing frame = 16 written frames (§3.4).
 */
function passKs(seen: readonly Seen[]): number[] {
  const out: number[] = [];
  for (const s of seen) if (s.phase === 'pass' && s.k > 0 && out[out.length - 1] !== s.k) out.push(s.k);
  return out;
}
const LAST_BAND_K = LOOP_PASS_TICKS - 2; // 15
/** true once a pass has written its clearing frame: a `rest` frame follows the last k = 15 frame */
function passDone(seen: readonly Seen[], from = 0): boolean {
  const tail = seen.slice(from);
  const last15 = tail.map((s) => s.phase === 'pass' && s.k === LAST_BAND_K).lastIndexOf(true);
  return last15 !== -1 && tail.slice(last15 + 1).some((s) => s.phase === 'rest');
}

describe('attentionAt (TUI-DESIGN-3 §3.6)', { retry: 1 }, () => {
  it('< 60 s attentive · < 10 min calm · else asleep; non-finite input is attentive', () => {
    expect(attentionAt(10_000, 10_000)).toBe('attentive');
    expect(attentionAt(10_000 + LOOP_ATTENTIVE_MS - 1, 10_000)).toBe('attentive');
    expect(attentionAt(10_000 + LOOP_ATTENTIVE_MS, 10_000)).toBe('calm');
    expect(attentionAt(10_000 + LOOP_SLEEP_MS - 1, 10_000)).toBe('calm');
    expect(attentionAt(10_000 + LOOP_SLEEP_MS, 10_000)).toBe('asleep');
    expect(attentionAt(Number.NaN, 0)).toBe('attentive');
    expect(attentionAt(0, 0)).toBe('attentive');
  });
});

describe('useIdleLoop on the real renderer (TUI-DESIGN-3 §3.6)', { retry: 1 }, () => {
  it('starts in `rest` when activated and writes no band before the rest interval; then one pass of 16 written frames (k = 1..16, the last clears the band) and the rest writes nothing', async () => {
    const m = mount(ACTIVE);
    // the pass: k = 1..15 in order, each with the §3.4 band, then the clearing frame (band none) — 16 written frames
    await waitFor(() => passDone(m.seen()), 4000);
    // every frame before the first band frame is a rest frame, and the first band frame is written no earlier than the rest interval
    // (timestamps, not sleeps: a loaded machine only delays writes, never advances them)
    const firstPass = m.seen().findIndex((s) => s.phase === 'pass' && s.k > 0);
    expect(firstPass).toBeGreaterThanOrEqual(1);
    // (the one `pass k=0` transition render carries no band either — identical pixels in the App)
    expect(m.seen().slice(0, firstPass).every((s) => s.band === 'none' && (s.phase === 'rest' || s.k === 0))).toBe(true);
    expect(m.seen()[firstPass]!.at).toBeGreaterThanOrEqual(REST_MS - 5);
    const ks = passKs(m.seen());
    expect(ks).toEqual(Array.from({ length: LAST_BAND_K }, (_, i) => i + 1));
    for (const s of m.seen().filter((x) => x.phase === 'pass')) {
      const b = loopBand(s.k);
      expect(s.band).toBe(b === null ? 'none' : `${b.from}-${b.to}`);
    }
    const seen = m.seen();
    const last15 = seen.map((x) => x.phase === 'pass' && x.k === LAST_BAND_K).lastIndexOf(true);
    expect(seen[last15 + 1]).toMatchObject({ phase: 'rest', k: 0, band: 'none' });
    // 16 written frames per pass: 15 bands + the clearing frame (frames with a band ≥ 15, distinct band texts = 15)
    expect(new Set(seen.filter((x) => x.band !== 'none').map((x) => x.band)).size).toBe(LAST_BAND_K);
    // the rest after the pass: the next pass follows no earlier than the rest interval after the clearing frame (the 10 s period, scaled)
    await waitFor(() => passKs(m.seen()).filter((k) => k === 1).length >= 2, 4000);
    const all = m.seen();
    const second = all.findIndex((s, i) => s.phase === 'pass' && s.k === 1 && i > last15);
    const clearing = all.slice(0, second).map((s) => s.phase === 'rest').lastIndexOf(true);
    expect(second).toBeGreaterThan(last15);
    expect(all[second]!.at - all[last15 + 1]!.at).toBeGreaterThanOrEqual(REST_MS - 5);
    expect(all.slice(last15 + 1, clearing + 1).every((s) => s.phase === 'rest' && s.band === 'none')).toBe(true);
  });

  it('`band` is null in every rest render — the wake render where `frame` is already 1 included', async () => {
    const m = mount(ACTIVE);
    await waitFor(() => passDone(m.seen()), 4000);
    await sleep(REST_MS + 20);
    for (const s of m.seen()) if (s.phase === 'rest') expect(s.band).toBe('none');
    // and no rest frame carries a k
    for (const s of m.seen()) if (s.phase === 'rest') expect(s.k).toBe(0);
  });

  it('a key mid-pass changes nothing: the band stays non-null up to k = 15 and the pass finishes; no new pass starts within the quiet window; a quiet clock lets the next pass start', async () => {
    const m = mount(ACTIVE);
    await waitFor(() => passKs(m.seen()).some((k) => k >= 4), 4000);
    // the key: lastKeystrokeAt = now (the quiet rule would say "not quiet" — read only at the next rest → pass transition)
    const keyAt = ACTIVE.nowMs;
    m.rerender({ ...ACTIVE, lastKeystrokeAt: keyAt }, 1, 'key');
    await waitFor(() => passDone(m.seen()), 4000);
    const ks = passKs(m.seen());
    const after = ks.slice(ks.indexOf(4));
    // every tick from the key to the end is still a pass frame with the table's band, up to k = 15, then the clearing frame
    expect(after.at(-1)).toBe(LAST_BAND_K);
    expect(after).toEqual(Array.from({ length: LAST_BAND_K - 3 }, (_, i) => i + 4));
    for (const k of after) expect(loopBand(k)).not.toBeNull();
    const endedAt = m.seen().length;
    // the rest tick finds a recent key: no pass for the rest interval + the quiet window (+ margin)
    await sleep(REST_MS + QUIET_MS + 150);
    expect(m.seen().slice(endedAt).every((s) => s.phase === 'rest')).toBe(true);
    // the clock moves past the quiet window: the next rest tick starts a pass
    m.rerender({ ...ACTIVE, lastKeystrokeAt: keyAt, nowMs: keyAt + QUIET_MS + 1 });
    await waitFor(() => passKs(m.seen()).filter((k) => k === 1).length >= 2, 4000);
    expect(passKs(m.seen()).filter((k) => k === 1).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['reduced motion / depth 0 (enabled false)', { ...ACTIVE, enabled: false }],
    ['hidden (the mark has no rows)', { ...ACTIVE, shown: false }],
    ['the splash still running', { ...ACTIVE, splashRunning: true }],
    ['asleep (10 min without activity)', { ...ACTIVE, attention: 'asleep' as const }],
  ])('inactive: %s — no subscriber, no frame after the mount for two rest intervals', async (_name, input) => {
    const m = mount(input);
    const n = m.stdout.frames.length;
    await sleep(REST_MS * 2 + PASS_MS * 4);
    expect(m.stdout.frames.length).toBe(n);
    expect(m.seen().every((s) => s.phase === 'rest' && s.band === 'none')).toBe(true);
  });

  it('hiding the mark mid-pass deactivates the subscriber (no frame after the hide render); showing it again starts with a full rest', async () => {
    const m = mount(ACTIVE);
    await waitFor(() => passKs(m.seen()).some((k) => k >= 3), 4000);
    m.rerender({ ...ACTIVE, shown: false });
    await sleep(40); // the hide render is a plain commit inside the throttle window: written at the trailing edge
    const n = m.stdout.frames.length;
    expect(m.seen().at(-1)).toMatchObject({ phase: 'rest', k: 0, band: 'none' });
    await sleep(REST_MS + PASS_MS * 4);
    expect(m.stdout.frames.length).toBe(n);
    // back: rest first, then a pass from k = 1 — the first band frame no earlier than the rest interval after the re-show
    m.rerender(ACTIVE);
    const shownAt = m.seen().length;
    await waitFor(() => passKs(m.seen().slice(shownAt)).length > 0, 4000);
    const tail = m.seen().slice(shownAt);
    const first = tail.findIndex((s) => s.phase === 'pass' && s.k > 0);
    expect(tail.slice(0, first).every((s) => s.band === 'none' && (s.phase === 'rest' || s.k === 0))).toBe(true);
    expect(tail[first]!.k).toBe(1);
    expect(tail[first]!.at).toBeGreaterThanOrEqual(REST_MS - 5);
  });

  it('calm attention rests longer: with `restMs` unset the calm rest is 25,750 ms — here only the tier flag is asserted through the scaled override (the pass itself is identical)', async () => {
    const m = mount({ ...ACTIVE, attention: 'calm' });
    await waitFor(() => passDone(m.seen()), 4000);
    expect(passKs(m.seen()).slice(0, LAST_BAND_K)).toEqual(Array.from({ length: LAST_BAND_K }, (_, i) => i + 1));
  });

  it('D-F beside the loop: a key commit right after an animation frame paints synchronously (the <Static> style update takes onImmediateRender)', async () => {
    const m = mount(ACTIVE);
    await waitFor(() => passKs(m.seen()).some((k) => k >= 2), 4000);
    // the band frame was just written (≤ 17 ms throttle window open); the key's commit must not wait for it
    const before = m.stdout.frames.length;
    m.rerender(ACTIVE, 1, 'key-A');
    expect(m.painted()).toContain('key-A');
    expect(m.stdout.frames.length).toBeGreaterThan(before);
    await sleep(5);
    m.rerender(ACTIVE, 2, 'key-B');
    expect(m.painted()).toContain('key-B');
    // the loop is unaffected by the two keys: the pass keeps going to k = 15 and its clearing frame
    await waitFor(() => passDone(m.seen()), 4000);
    expect(passKs(m.seen()).at(-1)).toBe(LAST_BAND_K);
  });
});
