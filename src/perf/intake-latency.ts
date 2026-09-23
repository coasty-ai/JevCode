/**
 * Intake reply latency (TUI-DESIGN-2 §3.12, §9 "intake reply wall time"): a `chat --mock` session in a real pty through
 * `perf/drivers/pty_type.py` (`pty.ts` `typist()`, which timestamps every chunk) receives greetings and questions about
 * the tool — messages the mock decider of §3.13 reads as `greeting_or_smalltalk` / `question_about_this_tool`, so every
 * one of them ends in a `[jevcode]` reply and none in a run. Two figures per message, both from the driver's clock:
 *
 *   bubble  Enter → the first frame after the send that carries the `[you] <text>` bubble (§3.1 row 1: the bubble and
 *           the `⠹ thinking` status are committed before the Jev request is sent) — the composer gate, p95 < 16 ms
 *   reply   Enter → the first frame after the send that carries a `[jevcode]` item (§3.1 rows 6–7) — the round-2 gate,
 *           p95 ≤ 40 ms with the mock answering at once (`mock0`); with the mock delayed 150 ms (`JEVCODE_MOCK_JEV_MS`,
 *           `mock150`) the same figure net of the delay is gated, and the frames showing `thinking` between Enter and
 *           the reply are counted (the delayed series is where the bubble frame and the reply frame come apart; at 0 ms
 *           both usually land in one immediate `<Static>` render)
 *
 * Hygiene per series: no run goes live — no frame's status row reads `step <n>/<max>` (`pty.ts` `RUN_STARTED_PATTERN`;
 * a greeting never starts a run, §3.3; the `[run] started` item this used to look for is no longer printed in the TUI),
 * zero clears after the first frame, the painted region within rows − 2, exit 0. The live gate of §9 (p95 < 1.5 s over a real provider) is the
 * S6 live scenario's, not this probe's: nothing here touches the network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { percentile } from '../core/time.js';
import { RUN_STARTED_PATTERN, clearsAfter, firstDynamicFrameOffset, frameAt, frameTime, paintedMax, searchPattern, splitFrames, stripAnsi, summarise, typist, type Chunk, type Frame, type LatencySummary, type TimingStep, type TypistStep } from './pty.js';

export type IntakeSeriesName = 'mock0' | 'mock150';

export interface IntakePair {
  /** the typist step number of the Enter */
  step: number;
  text: string;
  sentAt: number;
  /** arrival of the frame carrying `[you] <text>` (null when never seen) */
  bubbleAt: number | null;
  /** arrival of the frame carrying the first `[jevcode]` item after the send (null when never seen) */
  replyAt: number | null;
  bubbleMs: number | null;
  replyMs: number | null;
  /** frames between the Enter and the reply frame whose rows show the `thinking` status word (§4.8) */
  thinkingFrames: number;
}

export interface IntakeSeries {
  name: IntakeSeriesName;
  rows: number;
  columns: number;
  /** `JEVCODE_MOCK_JEV_MS` applied to the mock decider */
  jevMs: number;
  /** messages typed (the plan's length) */
  messages: number;
  /** measured Enters whose `send` record could not be located (no timing record or no capture offset): must be 0 for `pass` */
  dropped: number;
  /** Enter → `[you]` bubble frame */
  bubble: LatencySummary;
  /** Enter → `[jevcode]` reply frame, raw */
  reply: LatencySummary;
  /** the reply figure minus the mock's delay (equals `reply` at 0 ms) — the harness's own share, the gated figure */
  replyNet: LatencySummary;
  /** messages whose window showed at least one `thinking` frame */
  thinkingSeen: number;
  /** 1 when a frame's status row reads `step <n>/<max>` (a run went live), else 0 — must be 0 */
  runsStarted: number;
  clears: number;
  regionMax: number;
  exitCode: number | null;
  timedOut: boolean;
  bubbleOk: boolean;
  replyOk: boolean;
  hygieneOk: boolean;
  pass: boolean;
}

export interface IntakeLatencyResult {
  gateBubbleMs: number;
  gateReplyMs: number;
  series: IntakeSeries[];
  deviations: string[];
  pass: boolean;
}

const ROWS = 24;
const COLUMNS = 80;
export const INTAKE_BUBBLE_GATE_MS = 16;
export const INTAKE_REPLY_GATE_MS = 40;
export const INTAKE_DELAY_MS = 150;
/** greetings and tool questions, in rotation (§3.13 mock heuristics: `hi`/`thanks`/`ok`/`hello`/`bye` → greeting; `?` + you|mode|cost → tool question) */
export const INTAKE_MESSAGES: readonly string[] = ['hi', 'thanks', 'what can you do?', 'ok', 'which mode is this?', 'hello', 'how much has this cost?', 'bye'];
/** the pause after Enter before the next message: enough for the delayed mock (150 ms) plus the reply frame, never a measurement */
const SETTLE_MS = 600;

/** the message texts, `n` of them, cycling `INTAKE_MESSAGES` */
export function messagePlan(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(INTAKE_MESSAGES[i % INTAKE_MESSAGES.length]!);
  return out;
}

/** the frame's visible text carries the bubble of `text` (one item per line, §3.10; a latin1 capture keeps ASCII intact) */
function hasBubble(frame: Frame, text: string): boolean {
  return stripAnsi(frame.body).includes(`[you] ${text}`);
}
function hasReply(frame: Frame): boolean {
  return stripAnsi(frame.body).includes('[jevcode] ');
}
function showsThinking(frame: Frame): boolean {
  return /\bthinking\b/.test(stripAnsi(frame.body));
}

/**
 * Pair every measured Enter (`measured` holds the typist step numbers of the `\r` sends, aligned with `texts`) with the
 * first later frame carrying its bubble and the first later frame carrying a reply; frames are consumed in order so a
 * frame never answers two messages. Thinking frames are those strictly between the Enter and the reply frame.
 */
export function pairIntake(timing: readonly TimingStep[], frames: readonly Frame[], chunks: readonly Chunk[], measured: readonly number[], texts: readonly string[]): IntakePair[] {
  const out: IntakePair[] = [];
  let cursor = 0;
  for (const [i, step] of measured.entries()) {
    const s = timing.find((r) => r.op === 'send' && r.step === step);
    const text = texts[i];
    if (s === undefined || s.off === undefined || text === undefined) continue;
    let bubbleAt: number | null = null;
    let replyAt: number | null = null;
    let thinking = 0;
    let replyIdx = -1;
    for (let k = cursor; k < frames.length; k++) {
      const f = frames[k]!;
      if (f.end <= s.off) continue;
      const t = frameTime(f, chunks);
      if (bubbleAt === null && hasBubble(f, text)) bubbleAt = t;
      if (hasReply(f)) {
        replyAt = t;
        replyIdx = k;
        break;
      }
      if (showsThinking(f)) thinking += 1;
    }
    if (replyIdx >= 0) cursor = replyIdx + 1;
    out.push({ step, text, sentAt: s.t, bubbleAt, replyAt, bubbleMs: bubbleAt === null ? null : Math.max(0, bubbleAt - s.t), replyMs: replyAt === null ? null : Math.max(0, replyAt - s.t), thinkingFrames: thinking });
  }
  return out;
}

/** `summarise` over the non-null values of one figure */
function summary(values: readonly (number | null)[]): LatencySummary {
  return summarise(values.filter((v): v is number => v !== null));
}

/**
 * The series verdicts from its pairs — pure, so the gate logic is unit-tested without a pty. `expected` is the number of
 * messages typed: a measured Enter that `pairIntake` could not locate (a lost timing record) shrinks `pairs`, and the
 * series is then incomplete (`dropped > 0`) rather than a shorter passing series.
 */
export function judgeIntake(name: IntakeSeriesName, jevMs: number, pairs: readonly IntakePair[], hygiene: { runsStarted: number; clears: number; regionMax: number; rows: number; exitCode: number | null; timedOut: boolean }, expected: number = pairs.length): Omit<IntakeSeries, 'rows' | 'columns'> {
  const bubble = summary(pairs.map((p) => p.bubbleMs));
  const reply = summary(pairs.map((p) => p.replyMs));
  const replyNet = summary(pairs.map((p) => (p.replyMs === null ? null : Math.max(0, p.replyMs - jevMs))));
  const dropped = Math.max(0, expected - pairs.length);
  const complete = dropped === 0 && pairs.length === expected && bubble.samples === pairs.length && reply.samples === pairs.length && pairs.length > 0;
  const bubbleOk = complete && bubble.p95 !== null && bubble.p95 < INTAKE_BUBBLE_GATE_MS;
  const replyOk = complete && replyNet.p95 !== null && replyNet.p95 <= INTAKE_REPLY_GATE_MS;
  const hygieneOk = hygiene.runsStarted === 0 && hygiene.clears === 0 && hygiene.regionMax <= hygiene.rows - 2 && hygiene.exitCode === 0 && !hygiene.timedOut;
  return {
    name,
    jevMs,
    messages: expected,
    dropped,
    bubble,
    reply,
    replyNet,
    thinkingSeen: pairs.filter((p) => p.thinkingFrames > 0).length,
    runsStarted: hygiene.runsStarted,
    clears: hygiene.clears,
    regionMax: hygiene.regionMax,
    exitCode: hygiene.exitCode,
    timedOut: hygiene.timedOut,
    bubbleOk,
    replyOk,
    hygieneOk,
    pass: bubbleOk && replyOk && hygieneOk,
  };
}

async function runSeries(root: string, bin: string, name: IntakeSeriesName, jevMs: number, n: number): Promise<IntakeSeries> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  try {
    const texts = messagePlan(n);
    const steps: TypistStep[] = [
      { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 20_000 },
      { op: 'expect', pattern: 'Say hi', timeoutMs: 20_000 },
      // the host is attached once the session meter is in the status row (a submission typed earlier would be held, §3.9)
      { op: 'expect', pattern: 'sess \\$', timeoutMs: 20_000 },
      { op: 'sleep', ms: 300 },
    ];
    const measured: number[] = [];
    for (const text of texts) {
      steps.push({ op: 'send', text }, { op: 'sleep', ms: 150 });
      measured.push(steps.length + 1);
      steps.push({ op: 'send', text: '\r' }, { op: 'sleep', ms: SETTLE_MS });
    }
    steps.push({ op: 'send', text: '/exit' }, { op: 'sleep', ms: 200 }, { op: 'send', text: '\r' }, { op: 'eof', timeoutMs: 20_000 });
    const r = await typist({
      root,
      rows: ROWS,
      columns: COLUMNS,
      steps,
      command: [process.execPath, bin, 'chat', '--mock', '--source', 'perf', '--workspace', ws],
      env: { JEVCODE_HOME: home, NODE_ENV: 'production', JEVCODE_MOCK_JEV_MS: String(jevMs) },
      wallMs: 300_000,
      label: `intake-${name}`,
    });
    const { frames } = splitFrames(r.capture);
    const firstDyn = firstDynamicFrameOffset(r.capture);
    const firstIdx = Math.max(0, frameAt(frames, firstDyn));
    const pairs = pairIntake(r.timing, frames, r.chunks, measured, texts);
    const runsStarted = searchPattern(r.capture, RUN_STARTED_PATTERN, { latin1: true }) >= 0 ? 1 : 0;
    const judged = judgeIntake(name, jevMs, pairs, { runsStarted, clears: clearsAfter(r.capture, firstDyn), regionMax: paintedMax(frames, firstIdx + 1), rows: ROWS, exitCode: r.code, timedOut: r.timedOut }, texts.length);
    return { ...judged, rows: ROWS, columns: COLUMNS };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

export const INTAKE_DEVIATIONS: readonly string[] = [
  'the live gate of TUI-DESIGN-2 §9 (intake reply wall time p95 < 1.5 s over a real provider) is measured by the S6 live scenario and test/live/intake.live.test.ts, not here: this probe never touches the network and gates the harness share against the mock decider (≤ 40 ms p95 at 0 ms, and net of the delay at JEVCODE_MOCK_JEV_MS=150)',
  'the bubble figure is the frame carrying the `[you]` item, not the composer echo of Enter: at 0 ms the bubble and the reply usually land in one immediate <Static> render, so the two figures coincide there and come apart only in the delayed series',
];

export async function measureIntakeLatency(opts: { root: string; bin: string; messages?: number; onProgress?: (line: string) => void }): Promise<IntakeLatencyResult> {
  const n = opts.messages ?? 20;
  const series: IntakeSeries[] = [];
  const report = (s: IntakeSeries): void => {
    series.push(s);
    opts.onProgress?.(`intake ${s.name} (mock ${s.jevMs} ms): ${s.bubble.samples}/${s.messages} bubbles, p50 ${s.bubble.p50?.toFixed(1)} p95 ${s.bubble.p95?.toFixed(1)} max ${s.bubble.max?.toFixed(1)} ms (gate < ${INTAKE_BUBBLE_GATE_MS}${s.bubbleOk ? '' : ' EXCEEDED'}); ${s.reply.samples}/${s.messages} replies, p50 ${s.reply.p50?.toFixed(1)} p95 ${s.reply.p95?.toFixed(1)} max ${s.reply.max?.toFixed(1)} ms raw, p95 ${s.replyNet.p95?.toFixed(1)} ms net of the delay (gate ≤ ${INTAKE_REPLY_GATE_MS}${s.replyOk ? '' : ' EXCEEDED'}); thinking seen in ${s.thinkingSeen}/${s.messages}; ${s.dropped} Enter${s.dropped === 1 ? '' : 's'} not located; runs started ${s.runsStarted}, clears ${s.clears}, region max ${s.regionMax}, exit ${s.exitCode}${s.timedOut ? ' TIMEOUT' : ''} → ${s.pass ? 'pass' : 'FAIL'}`);
  };
  report(await runSeries(opts.root, opts.bin, 'mock0', 0, n));
  report(await runSeries(opts.root, opts.bin, 'mock150', INTAKE_DELAY_MS, n));
  return { gateBubbleMs: INTAKE_BUBBLE_GATE_MS, gateReplyMs: INTAKE_REPLY_GATE_MS, series, deviations: [...INTAKE_DEVIATIONS], pass: series.every((s) => s.pass) };
}

/** the p95 of one figure across every series (the README's one-line summary) */
export function intakeP95(r: IntakeLatencyResult, pick: (s: IntakeSeries) => LatencySummary): number | null {
  return percentile(
    r.series.flatMap((s) => pick(s).raw),
    95,
  );
}
