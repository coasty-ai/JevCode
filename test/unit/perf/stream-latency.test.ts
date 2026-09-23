/**
 * `src/perf/stream-latency.ts` on synthetic captures: the pure analysis behind the opt-in stream probe — the emission
 * log on the clock bridge, the commit found by Ink's erase accounting (not by a label), per-delta paint pairing with
 * the within-throttle coverage exclusion, the commit comparison over pure row sets, the short-window frame rate and the
 * gate arithmetic of a whole series (an ideal stream passes every gate; today's shape fails the right ones).
 */
import { describe, expect, it } from 'vitest';
import { BSU, ESU, eraseHeights, latin1View, splitFrames, type Chunk, type ClockBridge, type TimingStep } from '../../../src/perf/pty.js';
import { STREAM_MESSAGES, STREAM_SERIES, analyseMessage, commitJumpOf, decodeRow, isReplyRow, judgeStreamSeries, replyBlankLines, replyContent, streamFps, streamIn, streamPlan, streamsFromLog, type StreamSeriesSpec } from '../../../src/perf/stream-latency.js';
import { streamPreset, type StreamPreset } from '../../../src/perf/stream-fixture.js';
import type { StreamLogFile } from '../../../src/cli/mock-trajectory.js';

const RULE = '─'.repeat(20);
const STATUS = 'idle  step 0/– ? help';

interface FrameSpec {
  t: number;
  static?: readonly string[];
  dyn: readonly string[];
}

/**
 * A latin1 capture (the typist's view) of Ink frames: each frame erases the previous region + 1 rows (log-update's
 * accounting), writes its static rows then its dynamic rows, and arrives in one chunk at `t`. `offsets[i]` is where
 * frame `i` starts in the capture (the `send` offset of an Enter written just before it).
 */
function capture(frames: readonly FrameSpec[]): { cap: string; chunks: Chunk[]; offsets: number[] } {
  let cap = '';
  let prev = 0;
  const chunks: Chunk[] = [];
  const offsets: number[] = [];
  for (const f of frames) {
    const erase = prev === 0 ? '' : Array.from({ length: prev + 1 }, (_, i) => (i === 0 ? '\x1b[2K' : '\x1b[1A\x1b[2K')).join('') + '\x1b[G';
    const body = `\x1b[?25l${erase}${[...(f.static ?? []), ...f.dyn].join('\r\n')}\r\n\x1b[2A\x1b[3G\x1b[?25h`;
    const bytes = latin1View(`${BSU}${body}${ESU}`);
    offsets.push(cap.length);
    chunks.push({ t: f.t, off: cap.length, n: bytes.length });
    cap += bytes;
    prev = f.dyn.length;
  }
  return { cap, chunks, offsets };
}

const tiny: StreamPreset = (() => {
  const deltas = ['Hello a01.\n', 'World a02.\n', '\n', 'End a03.'];
  return { name: 'mixed', deltas, markers: ['a01', 'a02', null, 'a03'], text: deltas.join('') };
})();

describe('reply rows and the commit comparison', () => {
  it('a reply row is a verbatim piece of the reply with a letter or digit; the label, gutter, caret and truncation glyph are not part of it', () => {
    const text = tiny.text;
    expect(replyContent('    [jevcode] Hello a01.')).toBe('Hello a01.');
    expect(replyContent('World a0…')).toBe('World a0');
    expect(isReplyRow('World a0…', text)).toBe(true);
    expect(isReplyRow('Hello a01.▍', text)).toBe(true);
    expect(isReplyRow('streaming… 11 chars', text)).toBe(false);
    expect(isReplyRow(RULE, text)).toBe(false);
    // punctuation alone proves nothing (the 3D indicator's density glyphs)
    expect(isReplyRow('  .  ', text)).toBe(false);
    expect(isReplyRow('', text)).toBe(false);
    // a typist row is latin1: decoded, Ink's truncation ellipsis is one glyph again
    expect(decodeRow(latin1View('World a0…'))).toBe('World a0…');
    expect(replyBlankLines('a\n\nb\n')).toBe(1);
    expect(replyBlankLines(streamPreset('mixed').text)).toBe(3);
  });

  it('commitJump: identical rows → 0; a label and hanging indent → every live row jumps, colShift 10; 2 live vs 15 committed → rowDelta 13; blank lines dropped → 3', () => {
    const mixed = streamPreset('mixed');
    const lines = mixed.text.split('\n');
    // the zero-jump commit: the rows the user saw are committed verbatim, blank lines kept
    expect(commitJumpOf(['const c01 = 1;', 'const c02 = 2;'], lines, mixed.text)).toMatchObject({ commitJump: 0, colShift: 0, blankLinesDropped: 0 });
    // today's commit: every non-blank line labelled, the 3 blank lines dropped (12 rows here: no wrapping in this fixture)
    const labelled = lines.filter((l) => l.trim() !== '').map((l) => `[jevcode] ${l}`);
    const j = commitJumpOf([RULE, 'const c01 = 1;', 'const c02 = 2;', STATUS], labelled, mixed.text);
    expect(j).toEqual({ liveRows: 2, committedRows: 12, rowDelta: 10, colShift: 10, commitJump: 2, blankLinesDropped: 3 });
    // the prototype's 2 → 15 (the paragraph wrapped over 3 more rows, hung at column 10): rowDelta 13
    const wrapped = [...labelled.slice(0, 4), '          p08 word p09', '          p16 word p17', '          p23 word p24', ...labelled.slice(4)];
    expect(commitJumpOf(['const c01 = 1;', 'const c02 = 2;'], wrapped, mixed.text).rowDelta).toBe(13);
    // nothing visible before the commit: nothing could jump — coverage is the gate that catches that
    expect(commitJumpOf(['streaming… 9 chars'], labelled, mixed.text)).toMatchObject({ liveRows: 0, commitJump: 0 });
  });
});

describe('streamFps', () => {
  it('the busiest 1 s window for a stream of a second or more; the mean spacing per second for a shorter one (from five frames on)', () => {
    const every40 = Array.from({ length: 40 }, (_, i) => 1000 + i * 40);
    expect(streamFps(every40, 1000, 2600)).toBe(25);
    expect(streamFps([100, 140, 180, 220, 260], 100, 300)).toBe(25);
    // a burst of too few frames is no rate
    expect(streamFps([100, 126, 160], 100, 300)).toBeNull();
    expect(streamFps([100], 100, 300)).toBeNull();
    expect(streamFps([], 0, 2000)).toBeNull();
  });
});

describe('emissions on the clock bridge', () => {
  it('streamsFromLog maps every stream onto the driver timeline; streamIn picks the one that starts after an Enter', () => {
    const clock: ClockBridge = { t: 10, rawNs: 5_000_000_000n, errNs: 100 };
    const ns = (ms: number): string => String(5_000_000_000n + BigInt(Math.round((ms - 10) * 1e6)));
    const log: StreamLogFile = { preset: 'mixed', gapMs: 30, deltas: 2, emissions: [
      { s: 0, i: 0, chars: 3, ns: ns(100) },
      { s: 0, i: 1, chars: 3, ns: ns(130) },
      { s: 1, i: 0, chars: 3, ns: ns(900) },
      { s: 1, i: 1, chars: 3, ns: ns(930) },
    ] };
    const streams = streamsFromLog(log, clock);
    expect(streams.map((s) => s.map((e) => Math.round(e.t)))).toEqual([[100, 130], [900, 930]]);
    expect(streamIn(streams, 50, 800)?.[0]?.t).toBeCloseTo(100, 6);
    expect(streamIn(streams, 800, Infinity)?.[0]?.t).toBeCloseTo(900, 6);
    expect(streamIn(streams, 200, 800)).toBeNull();
  });
});

describe('analyseMessage (one message of a synthetic capture)', () => {
  const build = (commit: FrameSpec, gapMs = 30): ReturnType<typeof analyseMessage> => {
    const specs: FrameSpec[] = [
      { t: 100, dyn: [RULE, STATUS] },
      { t: 210, static: ['[you] hi'], dyn: [RULE, STATUS] },
      { t: 255, dyn: [RULE, 'streaming… 11 chars', STATUS] },
      { t: 290, dyn: [RULE, 'Hello a01.', 'World a02.', STATUS] },
      commit,
      { t: 400, dyn: [RULE, STATUS] },
    ];
    const { cap, chunks, offsets } = capture(specs);
    const { frames } = splitFrames(cap);
    const heights = eraseHeights(frames);
    return analyseMessage({
      frames,
      heights,
      classes: frames.map((_, i) => (specs[i]!.static ? 'static' : 'dynamic')),
      chunks,
      enter: { t: 200, off: offsets[1]! },
      endOff: cap.length,
      emissions: [
        { i: 0, t: 250 },
        { i: 1, t: 280 },
        { i: 2, t: 300 },
        { i: 3, t: 320 },
      ],
      preset: tiny,
      gapMs,
      throttle: 34,
      index: 0,
      text: 'hi',
    });
  };

  it("today's shape: the commit is found by its committed rows (not by a label), deltas pair with the first write that shows them, the within-throttle delta is left out of coverage, and the jump is measured", () => {
    const m = build({ t: 330, static: ['[jevcode] Hello a01.', '[jevcode] World a02.', '[jevcode] End a03.'], dyn: [RULE, STATUS] });
    expect(m.commitAt).toBe(330);
    expect(m.lastDeltaToCommitMs).toBe(10);
    expect(m.enterToFirstEmissionMs).toBe(50);
    expect(m.firstFeedbackMs).toBe(5);
    expect(m.firstTextPaintMs).toBe(40);
    expect(m).toMatchObject({ firstGapMs: 30, firstTextBurst: false });
    expect(m.deltas).toEqual([
      { i: 0, marker: 'a01', at: 250, ms: 40, live: true },
      { i: 1, marker: 'a02', at: 280, ms: 10, live: true },
      { i: 3, marker: 'a03', at: 320, ms: 10, live: false },
    ]);
    // a03 was emitted 10 ms before the commit, inside one 34 ms throttle period: not eligible
    expect(m).toMatchObject({ eligible: 2, paintedLive: 2, coverage: 1, neverPaintedLive: [] });
    expect(m.deltaToPaint).toMatchObject({ samples: 2, max: 40 });
    expect(m.framesDuringStream).toBe(2);
    expect(m.commit).toEqual({ liveRows: 2, committedRows: 3, rowDelta: 1, colShift: 10, commitJump: 2, blankLinesDropped: 1 });
    expect(m.clockOk).toBe(true);
    expect(m.bytesPerStreamedChar).toBeGreaterThan(0);
  });

  it('deltas 0 and 1 less than half a gap apart flag the first text as a burst (the mock held back by the Enter frame, not the renderer)', () => {
    const commit: FrameSpec = { t: 330, static: ['[jevcode] Hello a01.', '[jevcode] World a02.', '[jevcode] End a03.'], dyn: [RULE, STATUS] };
    // the same 30 ms apart: a burst against a 100 ms gap, not against 30 ms (above) or 60 ms (exactly half)
    expect(build(commit, 100)).toMatchObject({ firstGapMs: 30, firstTextBurst: true, firstTextPaintMs: 40 });
    expect(build(commit, 60).firstTextBurst).toBe(false);
    expect(build(commit, 0).firstTextBurst).toBe(false);
  });

  it('a zero-jump commit: the rows the user saw are committed verbatim with the blank line kept', () => {
    const m = build({ t: 330, static: ['Hello a01.', 'World a02.', '', 'End a03.'], dyn: [RULE, STATUS] });
    expect(m.commit).toEqual({ liveRows: 2, committedRows: 4, rowDelta: 2, colShift: 0, commitJump: 0, blankLinesDropped: 0 });
  });

  it('no commit (the last marker never reaches the scrollback): every paint counts as live, and the message is incomplete', () => {
    const m = build({ t: 330, dyn: [RULE, 'End a03.', STATUS] });
    expect(m.commitAt).toBeNull();
    expect(m.commit).toBeNull();
    expect(m.lastDeltaToCommitMs).toBeNull();
  });
});

/** An ideal or today-shaped stream of the real `mixed` preset for one message: emissions every `gap` ms, a frame 5 ms after each. */
function messageFrames(t0: number, gap: number, shape: 'ideal' | 'today'): { frames: FrameSpec[]; emissions: number[] } {
  const p = streamPreset('mixed');
  const frames: FrameSpec[] = [{ t: t0 - 40, static: ['[you] hi'], dyn: [RULE, STATUS] }];
  const emissions: number[] = [];
  let text = '';
  p.deltas.forEach((d, i) => {
    const at = t0 + i * gap;
    emissions.push(at);
    text += d;
    const lines = text.split('\n');
    const shown = shape === 'ideal' ? lines : lines.length > 1 ? lines.slice(-2).map((l) => l.slice(0, 81)) : ['streaming… 9 chars'];
    frames.push({ t: at + 5, dyn: [RULE, ...shown, STATUS] });
  });
  const committed = shape === 'ideal' ? text.split('\n') : text.split('\n').filter((l) => l.trim() !== '').map((l) => `[jevcode] ${l}`);
  const end = t0 + (p.deltas.length - 1) * gap;
  frames.push({ t: end + 8, static: committed, dyn: [RULE, STATUS] }, { t: end + 300, dyn: [RULE, STATUS] });
  return { frames, emissions };
}

function series(shape: 'ideal' | 'today', spec: StreamSeriesSpec) {
  const all: FrameSpec[] = [{ t: 50, dyn: [RULE, STATUS] }];
  const enterAt: number[] = [];
  const emissions: number[][] = [];
  for (let k = 0; k < STREAM_MESSAGES.length; k++) {
    const t0 = 1000 + k * 3000;
    enterAt.push(t0 - 60);
    const m = messageFrames(t0, 40, shape);
    all.push(...m.frames);
    emissions.push(m.emissions);
  }
  const { cap, chunks, offsets } = capture(all);
  // the Enter of message k is sent just before its `[you]` frame
  const bubbleIdx = all.map((f, i) => (f.static?.[0] === '[you] hi' ? i : -1)).filter((i) => i >= 0);
  const timing: TimingStep[] = bubbleIdx.map((fi, k) => ({ t: enterAt[k]!, step: 10 + k, op: 'send', arg: '\r', off: offsets[fi]! }));
  const clock: ClockBridge = { t: 0, rawNs: 1_000_000_000_000n, errNs: 0 };
  const log: StreamLogFile = { preset: 'mixed', gapMs: 40, deltas: 46, emissions: emissions.flatMap((es, s) => es.map((t, i) => ({ s, i, chars: 1, ns: String(clock.rawNs + BigInt(Math.round(t * 1e6))) }))) };
  return judgeStreamSeries({ spec, capture: cap, timing, chunks, clock, log, enters: timing.map((s) => s.step), keys: new Set(), exitCode: 0, timedOut: false, memory: null });
}

describe('judgeStreamSeries (gate arithmetic over a whole series)', () => {
  const spec = STREAM_SERIES.find((s) => s.name === 'chat-30ms-24x80')!;

  it('an ideal stream — text from the first token, every delta on screen, a verbatim commit right after the last delta — passes every gate', () => {
    const s = series('ideal', spec);
    expect(s.messages).toHaveLength(3);
    expect(s.messages.map((m) => m.emissions)).toEqual([46, 46, 46]);
    expect(s.firstTextPaint.p95).toBe(5);
    expect(s.firstTextBursts).toBe(0);
    expect(s.coverageMin).toBe(1);
    expect(s.commitJumpMax).toBe(0);
    expect(s.blankLinesDroppedMax).toBe(0);
    expect(s.lastDeltaToCommit.p95).toBe(8);
    expect(s.dynamicFpsMax).toBe(25);
    expect(s).toMatchObject({ instrumented: true, hygieneOk: true, firstTextOk: true, coverageOk: true, commitJumpOk: true, blankLinesOk: true, lastDeltaOk: true, clearsOk: true, fpsOk: true, pass: true });
  });

  it("today's shape — a counter until the first newline, the last two rows cut, a labelled commit without the blank lines — fails first text, coverage, jump and blank lines", () => {
    const s = series('today', spec);
    expect(s.hygieneOk).toBe(true);
    expect(s.firstTextOk).toBe(false);
    expect(s.coverageOk).toBe(false);
    expect(s.commitJumpOk).toBe(false);
    expect(s.blankLinesDroppedMax).toBe(3);
    expect(s.lastDeltaOk).toBe(true);
    expect(s.pass).toBe(false);
  });

  it('a series without its emission log is not instrumented: never a pass, whatever the frames show', () => {
    const s = series('ideal', spec);
    const bare = judgeStreamSeries({ spec, capture: '', timing: [], chunks: [], clock: null, log: null, enters: [], keys: new Set(), exitCode: 0, timedOut: false, memory: null });
    expect(s.pass).toBe(true);
    expect(bare).toMatchObject({ instrumented: false, hygieneOk: false, pass: false });
  });
});

describe('streamPlan', () => {
  it('three messages, each Enter recorded; the typing series types 10 keys/s through the stream and clears the draft after the commit', () => {
    const plain = streamPlan(STREAM_SERIES.find((s) => s.name === 'chat-30ms-24x80')!);
    expect(plain.enters).toHaveLength(3);
    for (const step of plain.enters) expect(plain.steps[step - 1]).toEqual({ op: 'send', text: '\r' });
    expect(plain.keys.size).toBe(0);
    expect(plain.steps.at(-1)).toEqual({ op: 'eof', timeoutMs: 20_000 });
    const typing = streamPlan(STREAM_SERIES.find((s) => s.typing)!);
    // 46 deltas × 30 ms = 1,380 ms of stream → 13 keys per message
    expect(typing.keys.size).toBe(39);
    for (const step of typing.keys) expect(typing.steps[step - 1]).toMatchObject({ op: 'send' });
    expect(typing.steps.filter((s) => s.op === 'send' && s.text === '\x03')).toHaveLength(3);
  });

  it('the series table: eight series, the long one reported, SSH and the delayed decider where the design says', () => {
    expect(STREAM_SERIES.map((s) => s.name)).toEqual(['chat-30ms-24x80', 'chat-5ms-24x80', 'chat-30ms-40x120', 'chat-5ms-40x120', 'chat-ssh-30ms-24x80', 'chat-mock150-2ms-24x80', 'long-2ms-24x80', 'type-while-streaming-30ms-24x80']);
    expect(STREAM_SERIES.filter((s) => !s.gated).map((s) => s.name)).toEqual(['long-2ms-24x80']);
    expect(STREAM_SERIES.find((s) => s.ssh)?.name).toBe('chat-ssh-30ms-24x80');
    expect(STREAM_SERIES.find((s) => s.jevMs === 150)?.name).toBe('chat-mock150-2ms-24x80');
  });
});
