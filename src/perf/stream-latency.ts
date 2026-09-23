/**
 * Streaming latency (opt-in: `JEVCODE_PERF_ONLY=stream-latency jevcode perf`): how fast, how completely and how
 * steadily a chat reply appears on screen while it is generated.
 *
 * The reply is a known one (`src/perf/stream-fixture.ts`) streamed by the `--mock` provider at a fixed gap
 * (`JEVCODE_MOCK_CHAT_STREAM`, `JEVCODE_MOCK_DELTA_MS`: `src/cli/mock-trajectory.ts`), paced against deadlines inside
 * the child, and every delta's emission is logged with `process.hrtime.bigint()` (`JEVCODE_PERF_STREAM_LOG`, written at
 * exit). The typist (`perf/drivers/pty_type.py`) timestamps every pty read on its own clock and records one
 * CLOCK_MONOTONIC_RAW bridge, which shares Node's hrtime base on macOS, so each emission lands on the pty timeline
 * (`pty.ts` `toDriverMs`) and is paired with the first pty write that shows its text. Every text delta ends in a unique
 * marker (`k01`, `p17`, …), matched as a whole token in a frame's visible rows. No network is touched.
 *
 * Series (three messages each — `hi`, `hello`, `thanks`, greetings the mock decider answers with a chat reply; the first
 * is the cold one and is reported apart): `chat-30ms` and `chat-5ms` at 24×80 and 40×120; `chat-ssh-30ms` with `SSH_TTY`
 * set (15 fps, the still indicator); `chat-mock150-2ms` with the mock decider delayed 150 ms (`JEVCODE_MOCK_JEV_MS`), where
 * the ~100 ms stream ends before the reading does, so `lastDelta → commit` shows whether the commit waits for Jev;
 * `long-2ms`, the ≈ 8 KB reply under `--perf-lag-probe` (reported: lag, bytes, memory); and `type-while-streaming`,
 * 10 keys/s into the composer while the 30 ms stream runs.
 *
 * Per message:
 *   deltaToPaint     emission → the first pty write carrying the delta's marker, for the writes before the commit
 *   firstFeedback    first emission → the first frame after it (anything at all changes on screen)
 *   firstTextPaint   first emission → the first frame showing any of the reply's text; `firstTextBurst` flags a
 *                    message whose deltas 0 and 1 left less than half a gap apart (the Enter frame held the first
 *                    emission back, so the first line break came with the first text and the figure measures the mock's
 *                    timing, not the renderer — the 5 ms and 2 ms series today; recorded, not gated)
 *   coverage         markers on screen before the commit ÷ markers emitted, leaving out the deltas emitted within one
 *                    throttle period of the commit (those may land first in the commit frame by design)
 *   dynamicFps       `dynamic` frames per second while the reply streams (busiest 1 s window; the frame spacing for
 *                    a stream shorter than a second)
 *   bytesPerChar     pty bytes from the first frame after the first emission through the commit frame ÷ reply chars
 *   commit           the first frame whose committed rows (above the dynamic region, by Ink's erase accounting —
 *                    `pty.ts` `splitRegion`) carry the reply's LAST marker; `lastDeltaToCommit` = its time − the last emission
 *   commitJump       reply rows of the last live frame that do not reappear verbatim, in order, in the committed block
 *                    (`rowDelta`, `colShift` and `blankLinesDropped` = blank lines of the reply − blank rows committed, beside it)
 * Per series: clears, `ESC[3J`, the tallest region (Ink's erase accounting), the child's RSS (`ps`), keystroke
 * latency (type-while-streaming) and the lag probe (long). The capture is the typist's latin1 view (string index =
 * byte offset); rows are decoded as UTF-8 before they are compared as text (`decodeRow`).
 *
 * Gates (recorded; the probe is red on arrival — it measures the tree before the streaming work): first text p95
 * ≤ 20 ms, coverage 100 %, commitJump 0, blankLinesDropped 0, lastDelta → commit p95 ≤ 50 ms, 0 clears, dynamic fps
 * ≤ maxFps + 1 (31 locally, 16 under SSH); type-while-streaming adds keystroke p95 < 16 ms. The probe is not in the
 * release set (`main.ts` `OPT_IN_PROBES`), so its reds never fail a release run until it moves there.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FPS, SSH_FPS } from '../config/defaults.js';
import type { StreamLogFile } from '../cli/mock-trajectory.js';
import { parseLag } from './render-lag.js';
import { markerRe, streamPreset, type StreamPreset, type StreamPresetName } from './stream-fixture.js';
import {
  BSU,
  chunkTimeAt,
  classifyFrames,
  clearsAfter,
  count3J,
  eraseHeights,
  firstDynamicFrameOffset,
  frameRowsRaw,
  keepExtra,
  frameTime,
  keyLatencies,
  keystrokeSteps,
  regionRows,
  safeKey,
  sendTimes,
  splitFrames,
  splitRegion,
  summarise,
  throttleMs,
  toDriverMs,
  typist,
  type Chunk,
  type ClockBridge,
  type Frame,
  type FrameClass,
  type LatencySummary,
  type TimingStep,
  type TypistStep,
} from './pty.js';

export const STREAM_FIRST_TEXT_GATE_MS = 20;
export const STREAM_LAST_DELTA_GATE_MS = 50;
export const STREAM_KEY_GATE_MS = 16;
/** the messages of every series: greetings, which the mock decider reads as `greeting_or_smalltalk` and answers with a chat reply */
export const STREAM_MESSAGES: readonly string[] = ['hi', 'hello', 'thanks'];
/** after the last delta: the commit (at most the 1.5 s intake grace) plus the frames around it — never a measurement */
const SETTLE_MS = 2000;
/** the pause after the host attached, before the first message */
const OPEN_MS = 400;
/** type-while-streaming: the first key this long after Enter (the first emission comes ≈ 60 ms after it), then 100 ms apart */
const TYPE_LEAD_MS = 80;
const TYPE_SPACING_MS = 100;

export type StreamSeriesName = 'chat-30ms-24x80' | 'chat-5ms-24x80' | 'chat-30ms-40x120' | 'chat-5ms-40x120' | 'chat-ssh-30ms-24x80' | 'chat-mock150-2ms-24x80' | 'long-2ms-24x80' | 'type-while-streaming-30ms-24x80';

export interface StreamSeriesSpec {
  name: StreamSeriesName;
  rows: number;
  columns: number;
  preset: StreamPresetName;
  gapMs: number;
  /** `SSH_TTY` set: the child runs at `SSH_FPS` with the still indicator */
  ssh: boolean;
  /** `JEVCODE_MOCK_JEV_MS` */
  jevMs: number;
  /** keys typed while the reply streams */
  typing: boolean;
  /** `--perf-lag-probe` (event-loop lag, reported) */
  lagProbe: boolean;
  /** the series' verdict counts in the probe's `pass` (the long series is reported) */
  gated: boolean;
}

export const STREAM_SERIES: readonly StreamSeriesSpec[] = [
  { name: 'chat-30ms-24x80', rows: 24, columns: 80, preset: 'mixed', gapMs: 30, ssh: false, jevMs: 0, typing: false, lagProbe: false, gated: true },
  { name: 'chat-5ms-24x80', rows: 24, columns: 80, preset: 'mixed', gapMs: 5, ssh: false, jevMs: 0, typing: false, lagProbe: false, gated: true },
  { name: 'chat-30ms-40x120', rows: 40, columns: 120, preset: 'mixed', gapMs: 30, ssh: false, jevMs: 0, typing: false, lagProbe: false, gated: true },
  { name: 'chat-5ms-40x120', rows: 40, columns: 120, preset: 'mixed', gapMs: 5, ssh: false, jevMs: 0, typing: false, lagProbe: false, gated: true },
  { name: 'chat-ssh-30ms-24x80', rows: 24, columns: 80, preset: 'mixed', gapMs: 30, ssh: true, jevMs: 0, typing: false, lagProbe: false, gated: true },
  { name: 'chat-mock150-2ms-24x80', rows: 24, columns: 80, preset: 'mixed', gapMs: 2, ssh: false, jevMs: 150, typing: false, lagProbe: false, gated: true },
  { name: 'long-2ms-24x80', rows: 24, columns: 80, preset: 'long', gapMs: 2, ssh: false, jevMs: 0, typing: false, lagProbe: true, gated: false },
  { name: 'type-while-streaming-30ms-24x80', rows: 24, columns: 80, preset: 'mixed', gapMs: 30, ssh: false, jevMs: 0, typing: true, lagProbe: false, gated: true },
];

// ---------------------------------------------------------------------------------------
// Emissions
// ---------------------------------------------------------------------------------------

/** one streamed delta on the driver's timeline */
export interface Emission {
  i: number;
  /** driver ms */
  t: number;
}

/** The emission log's streams (one per chat turn, in order), mapped onto the driver's timeline through the clock bridge. */
export function streamsFromLog(log: StreamLogFile, clock: ClockBridge): Emission[][] {
  const out: Emission[][] = [];
  for (const e of log.emissions) {
    while (out.length <= e.s) out.push([]);
    out[e.s]!.push({ i: e.i, t: toDriverMs(clock, e.ns) });
  }
  return out;
}

/** The stream whose first emission falls in `[from, to)` (driver ms), or null. */
export function streamIn(streams: readonly Emission[][], from: number, to: number): Emission[] | null {
  return streams.find((s) => s.length > 0 && s[0]!.t >= from && s[0]!.t < to) ?? null;
}

// ---------------------------------------------------------------------------------------
// Reply rows and the commit comparison (pure row sets, no layout guesses)
// ---------------------------------------------------------------------------------------

/** a transcript label and its gutter (`    [jevcode] `, TUI-DESIGN-3 §5.1: right-aligned in 10 cells) */
const LABEL_RE = /^ {0,9}\[[a-z]+\] /;
/** a trailing caret or truncation glyph a live view may append, and trailing blanks */
const TRAILING_GLYPHS_RE = /[\s▍▌█…_]+$/u;

/** A row of a typist capture (latin1: one code unit per byte) as the terminal shows it: its bytes decoded as UTF-8. */
export function decodeRow(row: string): string {
  return Buffer.from(row, 'latin1').toString('utf8');
}

/** A row's reply content: the label, gutter / hanging indent, trailing blanks and a trailing caret removed. */
export function replyContent(row: string): string {
  return row.replace(LABEL_RE, '').replace(TRAILING_GLYPHS_RE, '').trim();
}

/**
 * A row that shows part of the reply: its content is a verbatim piece of the reply text and holds a letter or a digit
 * (a lone `.` or a fence of backticks proves nothing — the 3D indicator's density glyphs are punctuation).
 */
export function isReplyRow(row: string, text: string): boolean {
  const c = replyContent(row);
  return c.length >= 2 && /[A-Za-z0-9]/.test(c) && text.includes(c);
}

/** blank lines in a reply (a trailing newline does not open one) */
export function replyBlankLines(text: string): number {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.filter((l) => l.trim() === '').length;
}

export interface CommitJump {
  /** reply rows in the last live frame's dynamic region */
  liveRows: number;
  /** rows of the committed block: the first reply row → the last, blank rows between them included */
  committedRows: number;
  /** committed − live */
  rowDelta: number;
  /** the largest column move of a row present in both (label, gutter, hanging indent) */
  colShift: number;
  /** live rows that do not reappear verbatim (raw text, columns included), in order, in the committed block — the gate */
  commitJump: number;
  /** blank lines of the reply − blank rows of the committed block (floored at 0) — gated at 0 */
  blankLinesDropped: number;
}

/** The commit comparison over pure row sets: the last live frame's reply rows against the committed block's rows. */
export function commitJumpOf(live: readonly string[], committed: readonly string[], text: string): CommitJump {
  const liveRows = live.filter((r) => isReplyRow(r, text)).map((r) => r.trimEnd());
  const first = committed.findIndex((r) => isReplyRow(r, text));
  let last = -1;
  for (let k = committed.length - 1; k >= 0; k--) {
    if (isReplyRow(committed[k]!, text)) {
      last = k;
      break;
    }
  }
  const block = first < 0 ? [] : committed.slice(first, last + 1).map((r) => r.trimEnd());
  let cursor = 0;
  let missing = 0;
  for (const r of liveRows) {
    const at = block.indexOf(r, cursor);
    if (at < 0) missing += 1;
    else cursor = at + 1;
  }
  let colShift = 0;
  for (const r of liveRows) {
    const c = replyContent(r);
    const twin = block.find((b) => replyContent(b) === c);
    if (twin !== undefined) colShift = Math.max(colShift, Math.abs(twin.indexOf(c) - r.indexOf(c)));
  }
  const blankRows = block.filter((r) => replyContent(r) === '').length;
  return { liveRows: liveRows.length, committedRows: block.length, rowDelta: block.length - liveRows.length, colShift, commitJump: missing, blankLinesDropped: Math.max(0, replyBlankLines(text) - blankRows) };
}

// ---------------------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------------------

export interface DeltaPaint {
  /** delta index in the preset */
  i: number;
  marker: string;
  /** emission, driver ms */
  at: number;
  /** emission → the first pty write carrying the marker (null: never on screen in this message's window) */
  ms: number | null;
  /** that write came before the commit frame */
  live: boolean;
}

export interface StreamMessage {
  index: number;
  text: string;
  cold: boolean;
  enterAt: number;
  emissions: number;
  enterToFirstEmissionMs: number | null;
  /** first → last emission */
  streamMs: number | null;
  firstFeedbackMs: number | null;
  firstTextPaintMs: number | null;
  /** emission of delta 0 → delta 1 (null with fewer than two emissions) */
  firstGapMs: number | null;
  /** deltas 0 and 1 left less than half the series' gap apart: `firstTextPaintMs` is not comparable (see the header) */
  firstTextBurst: boolean;
  /** live paints only (before the commit frame) */
  deltaToPaint: LatencySummary;
  /** marked deltas emitted more than one throttle period before the commit */
  eligible: number;
  paintedLive: number;
  /** paintedLive ÷ eligible (null when nothing was eligible) */
  coverage: number | null;
  neverPaintedLive: string[];
  framesDuringStream: number;
  dynamicFrames: number;
  dynamicFps: number | null;
  /** p50 / max spacing of the frames during the stream */
  frameSpacing: { p50: number | null; max: number | null };
  meanFrameBytes: number | null;
  bytesThroughCommit: number | null;
  bytesPerStreamedChar: number | null;
  commitAt: number | null;
  lastDeltaToCommitMs: number | null;
  commit: CommitJump | null;
  /** the emission stream lies after Enter and before the commit on the driver's timeline (the clock bridge holds) */
  clockOk: boolean;
  deltas: DeltaPaint[];
}

export interface MessageInput {
  frames: readonly Frame[];
  heights: readonly (number | null)[];
  classes: readonly FrameClass[];
  chunks: readonly Chunk[];
  /** the Enter `send` record: driver ms and the capture offset at the write */
  enter: { t: number; off: number };
  /** frames at or past this capture offset belong to the next message */
  endOff: number;
  emissions: readonly Emission[];
  preset: StreamPreset;
  /** the series' gap between deltas (`JEVCODE_MOCK_DELTA_MS`), for `firstTextBurst` */
  gapMs: number;
  throttle: number;
  index: number;
  text: string;
}

/** the first raw occurrence of `marker` in frame `f`, timed by the chunk holding its first byte (the frame's time as a fallback) */
function markerTime(f: Frame, marker: string, chunks: readonly Chunk[]): number | null {
  const at = f.body.indexOf(marker);
  const t = at < 0 ? null : chunkTimeAt(chunks, f.start + BSU.length + at);
  return t ?? frameTime(f, chunks);
}

/** a rate from the mean spacing needs this many frames; fewer (a ~100 ms burst) are no rate at all */
export const SHORT_WINDOW_MIN_FRAMES = 5;

/**
 * `dynamic` frames per second: the busiest 1 s window when the stream lasts a second or more; for a shorter stream the
 * mean spacing per second, from at least `SHORT_WINDOW_MIN_FRAMES` frames (null below that — two frames of a 90 ms
 * burst 26 ms apart are not a sustained 38 fps).
 */
export function streamFps(times: readonly number[], from: number, to: number): number | null {
  const ts = times.filter((t) => t >= from && t < to);
  if (ts.length === 0) return null;
  if (to - from >= 1000) {
    let best = 0;
    for (let a = 0; a < ts.length; a++) {
      let n = 0;
      for (let b = a; b < ts.length && ts[b]! < ts[a]! + 1000; b++) n += 1;
      best = Math.max(best, n);
    }
    return best;
  }
  if (ts.length < SHORT_WINDOW_MIN_FRAMES) return null;
  return Math.round(((ts.length - 1) * 1000) / (ts[ts.length - 1]! - ts[0]!));
}

/** The per-message analysis — pure over the capture's frames, their region heights and classes, and the emissions. */
export function analyseMessage(m: MessageInput): StreamMessage {
  const { frames, heights, classes, chunks, preset, emissions } = m;
  const idxs: number[] = [];
  for (let i = 0; i < frames.length; i++) if (frames[i]!.start >= m.enter.off && frames[i]!.start < m.endOff) idxs.push(i);
  const times = new Map<number, number | null>(idxs.map((i) => [i, frameTime(frames[i]!, chunks)]));
  // each frame's visible text once (a marker is searched in every frame of the window)
  const texts = new Map<number, string>(idxs.map((i) => [i, frameRowsRaw(frames[i]!.body).join('\n')]));
  const markers = preset.markers.map((mk, i) => ({ i, marker: mk })).filter((x): x is { i: number; marker: string } => x.marker !== null);
  const finalMarker = markers[markers.length - 1]?.marker ?? null;
  const tFirst = emissions[0]?.t ?? null;
  const tLast = emissions[emissions.length - 1]?.t ?? null;
  const commitIdx = finalMarker === null ? -1 : (idxs.find((i) => (splitRegion(frames, i, heights)?.staticRows ?? []).some((r) => markerRe(finalMarker).test(r))) ?? -1);
  const commitAt = commitIdx < 0 ? null : (times.get(commitIdx) ?? null);
  const live = tFirst === null ? [] : idxs.filter((i) => (commitIdx < 0 || i < commitIdx) && (times.get(i) ?? -Infinity) >= tFirst);
  const emissionAt = new Map(emissions.map((e) => [e.i, e.t]));

  const deltas: DeltaPaint[] = [];
  for (const { i, marker } of markers) {
    const at = emissionAt.get(i);
    if (at === undefined) continue;
    const re = markerRe(marker);
    let ms: number | null = null;
    let liveHit = false;
    for (const k of idxs) {
      if (commitIdx >= 0 && k > commitIdx) break;
      if (!re.test(texts.get(k) ?? '')) continue;
      const t = markerTime(frames[k]!, marker, chunks);
      // a marker cannot be painted before it was emitted; 1 ms absorbs the bridge's rounding
      if (t === null || t < at - 1) continue;
      ms = Math.max(0, t - at);
      liveHit = commitIdx < 0 || k < commitIdx;
      break;
    }
    deltas.push({ i, marker, at, ms: ms === null ? null : Math.round(ms * 10) / 10, live: liveHit });
  }
  const liveMs = deltas.filter((d) => d.live && d.ms !== null).map((d) => d.ms!);
  const eligibleDeltas = deltas.filter((d) => commitAt === null || d.at < commitAt - m.throttle);
  const paintedLive = eligibleDeltas.filter((d) => d.live && d.ms !== null).length;
  const firstFrameAfter = tFirst === null ? undefined : idxs.find((i) => (times.get(i) ?? -Infinity) >= tFirst);
  const paints = deltas.filter((d) => d.ms !== null).map((d) => d.at + d.ms!);
  const firstText = paints.length === 0 || tFirst === null ? null : Math.min(...paints) - tFirst;
  const firstGap = tFirst === null || emissions[1] === undefined ? null : Math.round((emissions[1].t - tFirst) * 10) / 10;
  const liveTimes = live.map((i) => times.get(i)).filter((t): t is number => t !== null && t !== undefined);
  const spacing = liveTimes.slice(1).map((t, k) => t - liveTimes[k]!);
  const dynTimes = live.filter((i) => classes[i] === 'dynamic').map((i) => times.get(i)).filter((t): t is number => t !== null && t !== undefined);
  const from = firstFrameAfter ?? (commitIdx >= 0 ? commitIdx : undefined);
  const bytesThroughCommit = commitIdx >= 0 && from !== undefined ? frames[commitIdx]!.end - frames[from]!.start : null;
  let commit: CommitJump | null = null;
  if (commitIdx >= 0) {
    const lastLive = live.length > 0 ? live[live.length - 1]! : [...idxs].reverse().find((i) => i < commitIdx);
    // rows compared as the terminal shows them: a typist capture is latin1, and the glyphs a row may end in (Ink's
    // truncation `…`, a caret) are multi-byte there
    const liveRows = (lastLive === undefined ? [] : (splitRegion(frames, lastLive, heights)?.dynamicRows ?? [])).map(decodeRow);
    const committed: string[] = [];
    for (const i of idxs) {
      if (i > commitIdx) break;
      if (tFirst !== null && (times.get(i) ?? -Infinity) < tFirst) continue;
      committed.push(...(splitRegion(frames, i, heights)?.staticRows ?? []).map(decodeRow));
    }
    commit = commitJumpOf(liveRows, committed, preset.text);
  }
  const clockOk = tFirst !== null && tFirst >= m.enter.t && (commitAt === null || (tLast !== null && tLast <= commitAt + 1));
  return {
    index: m.index,
    text: m.text,
    cold: m.index === 0,
    enterAt: m.enter.t,
    emissions: emissions.length,
    enterToFirstEmissionMs: tFirst === null ? null : tFirst - m.enter.t,
    streamMs: tFirst === null || tLast === null ? null : tLast - tFirst,
    firstFeedbackMs: firstFrameAfter === undefined || tFirst === null ? null : (times.get(firstFrameAfter) ?? tFirst) - tFirst,
    firstTextPaintMs: firstText,
    firstGapMs: firstGap,
    firstTextBurst: m.gapMs > 0 && firstGap !== null && firstGap < m.gapMs / 2,
    deltaToPaint: summarise(liveMs),
    eligible: eligibleDeltas.length,
    paintedLive,
    coverage: eligibleDeltas.length === 0 ? null : paintedLive / eligibleDeltas.length,
    neverPaintedLive: eligibleDeltas.filter((d) => !d.live || d.ms === null).map((d) => d.marker),
    framesDuringStream: live.length,
    dynamicFrames: dynTimes.length,
    dynamicFps: tFirst === null ? null : streamFps(dynTimes, tFirst, commitAt ?? (tLast ?? tFirst) + 1),
    frameSpacing: { p50: summarise(spacing).p50, max: spacing.length ? Math.max(...spacing) : null },
    meanFrameBytes: live.length === 0 ? null : Math.round(live.reduce((a, i) => a + (frames[i]!.end - frames[i]!.start), 0) / live.length),
    bytesThroughCommit,
    bytesPerStreamedChar: bytesThroughCommit === null ? null : Math.round((bytesThroughCommit / preset.text.length) * 10) / 10,
    commitAt,
    lastDeltaToCommitMs: commitAt === null || tLast === null ? null : commitAt - tLast,
    commit,
    clockOk,
    deltas,
  };
}

// ---------------------------------------------------------------------------------------
// One series
// ---------------------------------------------------------------------------------------

export interface StreamSeries {
  name: StreamSeriesName;
  rows: number;
  columns: number;
  preset: StreamPresetName;
  gapMs: number;
  /** the child's render rate: `DEFAULT_FPS`, or `SSH_FPS` under SSH */
  fps: number;
  throttleMs: number;
  ssh: boolean;
  jevMs: number;
  gated: boolean;
  replyChars: number;
  deltas: number;
  messages: StreamMessage[];
  /** over every message (cold included) */
  firstTextPaint: LatencySummary;
  /** messages whose first text is a burst (`StreamMessage.firstTextBurst`): the figure is recorded but not comparable */
  firstTextBursts: number;
  deltaToPaint: LatencySummary;
  lastDeltaToCommit: LatencySummary;
  /** the lowest coverage of any message */
  coverageMin: number | null;
  commitJumpMax: number | null;
  blankLinesDroppedMax: number | null;
  dynamicFpsMax: number | null;
  bytesPerStreamedCharMean: number | null;
  clears: number;
  esc3J: number;
  /** the tallest dynamic region after the first frame (Ink's erase accounting, the rule parse where it is silent) */
  regionMax: number;
  /** type-while-streaming: keystroke → frame over the keys typed during the streams */
  typing: LatencySummary | null;
  keysSent: number;
  /** long: the child's event-loop lag probe */
  lag: { p50: number | null; p95: number | null; max: number; samples: number } | null;
  /** the child's resident set (`ps -o rss=`): after the settle, the largest seen, before `/exit`; MiB */
  memory: { startMiB: number; maxMiB: number; endMiB: number } | null;
  /** the emission log was written and the clock bridge recorded */
  instrumented: boolean;
  exitCode: number | null;
  timedOut: boolean;
  firstTextOk: boolean;
  coverageOk: boolean;
  commitJumpOk: boolean;
  blankLinesOk: boolean;
  lastDeltaOk: boolean;
  clearsOk: boolean;
  fpsOk: boolean;
  typingOk: boolean;
  /** every message streamed, committed and lined up; exit 0; no timeout; region ≤ rows − 2 */
  hygieneOk: boolean;
  pass: boolean;
}

export interface StreamSeriesInput {
  spec: StreamSeriesSpec;
  capture: string;
  timing: readonly TimingStep[];
  chunks: readonly Chunk[];
  clock: ClockBridge | null;
  log: StreamLogFile | null;
  /** the typist step numbers of the three Enters */
  enters: readonly number[];
  /** the typist step numbers of the measured keys (type-while-streaming) */
  keys: ReadonlySet<number>;
  exitCode: number | null;
  timedOut: boolean;
  memory: StreamSeries['memory'];
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** Analyse one series' capture and judge it — pure, so the arithmetic is unit-tested on synthetic captures. */
export function judgeStreamSeries(x: StreamSeriesInput): StreamSeries {
  const { spec } = x;
  const preset = streamPreset(spec.preset);
  const fps = spec.ssh ? SSH_FPS : DEFAULT_FPS;
  const throttle = throttleMs(fps);
  const { frames } = splitFrames(x.capture);
  const heights = eraseHeights(frames);
  const sends = sendTimes(x.timing);
  const classes = classifyFrames(frames, x.chunks, sends, throttle);
  const streams = x.clock !== null && x.log !== null ? streamsFromLog(x.log, x.clock) : [];
  const enters = x.enters.map((step) => x.timing.find((s) => s.op === 'send' && s.step === step)).filter((s): s is TimingStep & { off: number } => s !== undefined && s.off !== undefined);
  const messages: StreamMessage[] = enters.map((e, k) => {
    const next = enters[k + 1];
    const emissions = streamIn(streams, e.t, next?.t ?? Infinity) ?? [];
    return analyseMessage({ frames, heights, classes, chunks: x.chunks, enter: { t: e.t, off: e.off }, endOff: next?.off ?? x.capture.length, emissions, preset, gapMs: spec.gapMs, throttle, index: k, text: STREAM_MESSAGES[k] ?? '' });
  });
  const firstDyn = firstDynamicFrameOffset(x.capture);
  const firstIdx = Math.max(0, frames.findIndex((f) => f.start >= firstDyn));
  let regionMax = 0;
  for (let i = firstIdx + 1; i < frames.length; i++) regionMax = Math.max(regionMax, regionRows(frames, i, heights) ?? 0);
  const clears = clearsAfter(x.capture, firstDyn);
  const esc3J = count3J(x.capture);
  const typing = spec.typing ? summarise(keyLatencies(x.timing, frames, x.chunks, x.keys).map((l) => l.ms)) : null;
  const vals = <T>(f: (m: StreamMessage) => T | null): T[] => messages.map(f).filter((v): v is T => v !== null);
  const firstTextPaint = summarise(vals((m) => m.firstTextPaintMs));
  const deltaToPaint = summarise(messages.flatMap((m) => m.deltas.filter((d) => d.live && d.ms !== null).map((d) => d.ms!)));
  const lastDeltaToCommit = summarise(vals((m) => m.lastDeltaToCommitMs));
  const coverages = vals((m) => m.coverage);
  const jumps = vals((m) => m.commit?.commitJump ?? null);
  const blanks = vals((m) => m.commit?.blankLinesDropped ?? null);
  const fpsVals = vals((m) => m.dynamicFps);
  const bpc = vals((m) => m.bytesPerStreamedChar);
  const instrumented = x.clock !== null && x.log !== null;
  const complete = messages.length === STREAM_MESSAGES.length && messages.every((m) => m.emissions === preset.deltas.length && m.commitAt !== null && m.clockOk);
  const hygieneOk = instrumented && complete && x.exitCode === 0 && !x.timedOut && regionMax <= spec.rows - 2;
  const firstTextOk = complete && firstTextPaint.p95 !== null && firstTextPaint.p95 <= STREAM_FIRST_TEXT_GATE_MS;
  const coverageOk = complete && coverages.length === messages.length && coverages.every((c) => c === 1);
  const commitJumpOk = complete && jumps.length === messages.length && jumps.every((j) => j === 0);
  const blankLinesOk = complete && blanks.length === messages.length && blanks.every((b) => b === 0);
  const lastDeltaOk = complete && lastDeltaToCommit.p95 !== null && lastDeltaToCommit.p95 <= STREAM_LAST_DELTA_GATE_MS;
  const clearsOk = clears === 0 && esc3J === 0;
  const fpsOk = fpsVals.every((v) => v <= fps + 1);
  const typingOk = !spec.typing || (typing !== null && typing.samples > 0 && typing.p95 !== null && typing.p95 < STREAM_KEY_GATE_MS);
  const pass = hygieneOk && clearsOk && (!spec.gated || (firstTextOk && coverageOk && commitJumpOk && blankLinesOk && lastDeltaOk && fpsOk && typingOk));
  return {
    name: spec.name,
    rows: spec.rows,
    columns: spec.columns,
    preset: spec.preset,
    gapMs: spec.gapMs,
    fps,
    throttleMs: throttle,
    ssh: spec.ssh,
    jevMs: spec.jevMs,
    gated: spec.gated,
    replyChars: preset.text.length,
    deltas: preset.deltas.length,
    messages,
    firstTextPaint,
    firstTextBursts: messages.filter((m) => m.firstTextBurst).length,
    deltaToPaint,
    lastDeltaToCommit,
    coverageMin: coverages.length ? Math.min(...coverages) : null,
    commitJumpMax: jumps.length ? Math.max(...jumps) : null,
    blankLinesDroppedMax: blanks.length ? Math.max(...blanks) : null,
    dynamicFpsMax: fpsVals.length ? Math.max(...fpsVals) : null,
    bytesPerStreamedCharMean: bpc.length ? round1(bpc.reduce((a, b) => a + b, 0) / bpc.length) : null,
    clears,
    esc3J,
    regionMax,
    typing,
    keysSent: x.keys.size,
    lag: spec.lagProbe ? parseLag(x.capture) : null,
    memory: x.memory,
    instrumented,
    exitCode: x.exitCode,
    timedOut: x.timedOut,
    firstTextOk,
    coverageOk,
    commitJumpOk,
    blankLinesOk,
    lastDeltaOk,
    clearsOk,
    fpsOk,
    typingOk,
    hygieneOk,
    pass,
  };
}

// ---------------------------------------------------------------------------------------
// Driving a series
// ---------------------------------------------------------------------------------------

/** The typist plan of a series: the opening, three messages (each Enter recorded), keys while streaming, `/exit`. */
export function streamPlan(spec: StreamSeriesSpec): { steps: TypistStep[]; enters: number[]; keys: Set<number> } {
  const preset = streamPreset(spec.preset);
  const streamMs = preset.deltas.length * spec.gapMs;
  const steps: TypistStep[] = [
    { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 20_000 },
    { op: 'expect', pattern: 'Say hi', timeoutMs: 20_000 },
    // the host is attached once the session meter is in the status row (a submission typed earlier would be held)
    { op: 'expect', pattern: 'sess \\$', timeoutMs: 20_000 },
    { op: 'sleep', ms: OPEN_MS },
  ];
  const enters: number[] = [];
  const keys = new Set<number>();
  let k = 0;
  for (const text of STREAM_MESSAGES) {
    steps.push({ op: 'send', text }, { op: 'sleep', ms: 150 });
    enters.push(steps.length + 1);
    steps.push({ op: 'send', text: '\r' });
    if (spec.typing) {
      steps.push({ op: 'sleep', ms: TYPE_LEAD_MS });
      const n = Math.max(1, Math.floor(streamMs / TYPE_SPACING_MS));
      for (let j = 0; j < n; j++) {
        keys.add(steps.length + 1);
        steps.push(...keystrokeSteps(safeKey(k++), TYPE_SPACING_MS));
      }
      // Ctrl-C with a draft clears it (the reply has committed by then), so the next message is typed into an empty composer
      steps.push({ op: 'sleep', ms: Math.max(0, streamMs - n * TYPE_SPACING_MS) + SETTLE_MS }, { op: 'send', text: '\x03' }, { op: 'sleep', ms: 300 });
    } else steps.push({ op: 'sleep', ms: streamMs + SETTLE_MS });
  }
  steps.push({ op: 'send', text: '/exit' }, { op: 'sleep', ms: 200 }, { op: 'send', text: '\r' }, { op: 'eof', timeoutMs: 20_000 });
  return { steps, enters, keys };
}

/** the resident set (KiB) of the `node … bin/jevcode.js … --workspace <ws>` child, or null */
function rssOf(workspace: string): number | null {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const cmd = m[2] ?? '';
      if (cmd.includes(workspace) && cmd.includes('bin/jevcode.js') && !cmd.includes('pty_type.py')) return Number(m[1]);
    }
  } catch {
    /* ps unavailable: reported as null */
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** sample the child's RSS once a second while the drive runs (a `ps` a second is the whole cost) */
async function sampleRss(workspace: string, done: () => boolean): Promise<number[]> {
  const out: number[] = [];
  await sleep(1500);
  while (!done()) {
    const v = rssOf(workspace);
    if (v !== null) out.push(v);
    await sleep(1000);
  }
  return out;
}

async function runSeries(root: string, bin: string, spec: StreamSeriesSpec): Promise<StreamSeries> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const logPath = join(home, 'stream-emissions.json');
  try {
    const plan = streamPlan(spec);
    let finished = false;
    const rssP = sampleRss(ws, () => finished);
    const r = await typist({
      root,
      rows: spec.rows,
      columns: spec.columns,
      steps: plan.steps,
      command: [process.execPath, bin, 'chat', '--mock', '--source', 'perf', '--workspace', ws, ...(spec.lagProbe ? ['--perf-lag-probe'] : [])],
      env: {
        JEVCODE_HOME: home,
        NODE_ENV: 'production',
        JEVCODE_MOCK_CHAT_STREAM: spec.preset,
        JEVCODE_MOCK_DELTA_MS: String(spec.gapMs),
        JEVCODE_PERF_STREAM_LOG: logPath,
        JEVCODE_MOCK_JEV_MS: String(spec.jevMs),
        ...(spec.ssh ? { SSH_TTY: '/dev/ttys999' } : {}),
      },
      wallMs: 180_000,
      label: `stream-${spec.name}`,
    });
    finished = true;
    const rss = await rssP;
    let log: StreamLogFile | null = null;
    try {
      log = JSON.parse(readFileSync(logPath, 'utf8')) as StreamLogFile;
      keepExtra(`stream-${spec.name}`, logPath, 'emissions.json');
    } catch {
      log = null;
    }
    const mib = (kib: number): number => Math.round((kib / 1024) * 10) / 10;
    const memory = rss.length === 0 ? null : { startMiB: mib(rss[0]!), maxMiB: mib(Math.max(...rss)), endMiB: mib(rss[rss.length - 1]!) };
    return judgeStreamSeries({ spec, capture: r.capture, timing: r.timing, chunks: r.chunks, clock: r.clock, log, enters: plan.enters, keys: plan.keys, exitCode: r.code, timedOut: r.timedOut, memory });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------

export interface StreamLatencyResult {
  gates: { firstTextP95Ms: number; coverage: number; commitJump: number; blankLinesDropped: number; lastDeltaToCommitP95Ms: number; clears: number; dynamicFps: number; dynamicFpsSsh: number; keyP95Ms: number };
  series: StreamSeries[];
  deviations: string[];
  pass: boolean;
}

export const STREAM_DEVIATIONS: readonly string[] = [
  'the reply is streamed by the --mock provider inside the TUI process (deadline-paced timers, no network): it measures the TUI and the chat path from the provider\'s onDelta on, not SSE parsing or HTTP ingress',
  'the first message of every series is the cold one (first chat turn of the session) and is reported apart; the gates apply over all three messages, the cold one included',
  'coverage leaves out the deltas emitted within one throttle period (ceil(1000 / fps)) of the commit frame: those may land first in the commit by design',
  'dynamic fps over a stream shorter than one second (the 5 ms and 2 ms series) is the mean frame spacing expressed per second, not a whole-second bucket, and needs at least 5 frames (a ~100 ms burst gives no rate)',
  'deltaToPaint (per delta, live writes only) and bytes per streamed character are reported, not gated',
  'memory is the child\'s RSS from `ps -o rss=` once a second (after a 1.5 s start-up), reported, not gated',
  'the probe is opt-in (not in the release set) while it is red: JEVCODE_PERF_ONLY=stream-latency',
];

export function describeStreamSeries(s: StreamSeries): string {
  const pct = (v: number | null): string => (v === null ? '–' : `${Math.round(v * 100)}%`);
  const f1 = (v: number | null | undefined): string => (v == null ? '–' : v.toFixed(1));
  const cold = s.messages[0];
  return `stream ${s.name} (${s.preset} ${s.replyChars} chars / ${s.deltas} deltas at ${s.gapMs} ms, ${s.fps} fps${s.jevMs > 0 ? `, mock decider ${s.jevMs} ms` : ''}${s.gated ? '' : ', reported'}): first text p50 ${f1(s.firstTextPaint.p50)} p95 ${f1(s.firstTextPaint.p95)} ms (cold ${f1(cold?.firstTextPaintMs)}; gate ≤ ${STREAM_FIRST_TEXT_GATE_MS}${s.firstTextOk ? '' : ' FAIL'}${s.firstTextBursts > 0 ? `; ${s.firstTextBursts}/${s.messages.length} burst, not comparable` : ''}), delta→paint live p50 ${f1(s.deltaToPaint.p50)} p95 ${f1(s.deltaToPaint.p95)} ms, coverage min ${pct(s.coverageMin)} (${s.messages.map((m) => `${m.paintedLive}/${m.eligible}`).join(' · ')}${s.coverageOk ? '' : ' FAIL'}), commit jump max ${s.commitJumpMax ?? '–'} (rows ${s.messages.map((m) => (m.commit ? `${m.commit.liveRows}→${m.commit.committedRows}, col +${m.commit.colShift}` : '–')).join(' · ')}${s.commitJumpOk ? '' : ' FAIL'}), blank lines dropped ${s.blankLinesDroppedMax ?? '–'}${s.blankLinesOk ? '' : ' FAIL'}, last delta→commit p95 ${f1(s.lastDeltaToCommit.p95)} ms${s.lastDeltaOk ? '' : ' FAIL'}, dynamic fps max ${s.dynamicFpsMax ?? '–'} (gate ≤ ${s.fps + 1}${s.fpsOk ? '' : ' FAIL'}), ${f1(s.bytesPerStreamedCharMean)} B/char, clears ${s.clears}, ESC[3J ${s.esc3J}, region max ${s.regionMax}${s.typing ? `, keys p95 ${f1(s.typing.p95)} ms over ${s.typing.samples}/${s.keysSent}${s.typingOk ? '' : ' FAIL'}` : ''}${s.lag ? `, lag p95 ${f1(s.lag.p95)} max ${f1(s.lag.max)} ms` : ''}${s.memory ? `, rss ${s.memory.startMiB}→${s.memory.maxMiB} MiB` : ''}, exit ${s.exitCode}${s.timedOut ? ' TIMEOUT' : ''}${s.instrumented ? '' : ' (NO EMISSION LOG OR CLOCK)'} → ${s.pass ? 'pass' : 'FAIL'}`;
}

export async function measureStreamLatency(opts: { root: string; bin: string; series?: readonly StreamSeriesSpec[]; onProgress?: (line: string) => void }): Promise<StreamLatencyResult> {
  const series: StreamSeries[] = [];
  for (const spec of opts.series ?? STREAM_SERIES) {
    const s = await runSeries(opts.root, opts.bin, spec);
    series.push(s);
    opts.onProgress?.(describeStreamSeries(s));
  }
  return {
    gates: { firstTextP95Ms: STREAM_FIRST_TEXT_GATE_MS, coverage: 1, commitJump: 0, blankLinesDropped: 0, lastDeltaToCommitP95Ms: STREAM_LAST_DELTA_GATE_MS, clears: 0, dynamicFps: DEFAULT_FPS + 1, dynamicFpsSsh: SSH_FPS + 1, keyP95Ms: STREAM_KEY_GATE_MS },
    series,
    deviations: [...STREAM_DEVIATIONS],
    pass: series.every((s) => s.pass),
  };
}
