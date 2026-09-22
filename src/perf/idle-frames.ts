/**
 * Idle animation frames (TUI-DESIGN-3 §3.9, §9 "idle animation"): a `chat --mock` session left alone in a real pty for 31 s
 * after the wordmark settles — the typist (`perf/drivers/pty_type.py`, `pty.ts` `typist()`) sends no key and timestamps every
 * chunk — at 24×80 and 40×120. The idle sweep of the wordmark (§3.4: 16 written frames per 4 s pass, 6 s of rest, one pass per
 * 10 s while attentive) is the only thing that may write, so the budget is an absolute one:
 *
 *   frames   `dynamic` frames per one-second bucket over `[settle + 1 s, settle + 31 s)` ≤ `IDLE_FPS_PEAK` (4) in every bucket and
 *            ≤ `IDLE_FPS_MEAN` (2) on average — a frame is `dynamic` when it carries no new `<Static>` rows (`pty.ts` `staticRows`);
 *            with no key sent there is no `key` class
 *   bytes    the busiest second ≤ `IDLE_BYTES_PEAK` (12 KB) and the mean ≤ `IDLE_BYTES_MEAN` (5 KB/s): 4 frames × ≤ 2.9 KB
 *   hygiene  zero clears after the first frame, the painted region ≤ rows − 2 on every frame, exit 0
 *   cpu      the child's cumulative CPU time (`ps -o time=`) at the start and the end of the window — **reported**, not gated
 *            (§3.9: above 30 ms/s mean the owner lowers `LOOP_INTERVAL_MS`); null when the process could not be found
 *
 * The settle is the caption frame (`◆ <version>`, §3.5 — the round-3 settle sentinel; the brand row is the pre-round-3 twin, read
 * too so a bundle without the caption still measures); the window starts one second after it so the reveal's tail never counts.
 * `bucketIdle` and `judgeIdle` are pure (unit-tested on synthetic captures); `measureIdleFrames` drives the pty.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearsAfter, firstDynamicFrameOffset, frameAt, frameTime, paintedMax, splitFrames, staticRows, stripAnsi, typist, wordmarkCells, type Chunk, type Frame, type TypistStep } from './pty.js';

export const IDLE_FPS_PEAK = 4;
export const IDLE_FPS_MEAN = 2;
export const IDLE_BYTES_PEAK = 12 * 1024;
export const IDLE_BYTES_MEAN = 5 * 1024;
/** the window after the settle the gates apply to: `[settle + IDLE_WINDOW_FROM_MS, settle + IDLE_WINDOW_TO_MS)` */
export const IDLE_WINDOW_FROM_MS = 1000;
export const IDLE_WINDOW_TO_MS = 31_000;
/** how long the typist leaves the session alone after the first frame (the settle lands ≈ 550–700 ms in; the window ends at 31 s after it) */
export const IDLE_HOLD_MS = 33_000;
/** the settle sentinel: the caption `◆ <version>` (round 3) — or the brand row `◆ jevcode <version>` (pre-round-3 twin) */
export const SETTLE_RE = /◆ (?:jevcode )?\d+\.\d+\.\d+|â\u0097\u0086 (?:jevcode )?\d+\.\d+\.\d+/;

export interface IdleBucket {
  /** whole seconds after the settle: bucket 1 covers `[settle + 1 s, settle + 2 s)` */
  second: number;
  dynamic: number;
  static: number;
  bytes: number;
  /** frames of the bucket that carried wordmark cells */
  wordmark: number;
}

export interface IdleBuckets {
  /** arrival time of the settle frame (driver clock), null when no settle frame was seen */
  settleAt: number | null;
  settleIndex: number;
  buckets: IdleBucket[];
  /** wordmark frames inside the window */
  wordmarkFrames: number;
}

/** the arrival time and index of the first frame at or after `fromIndex` whose visible text matches the settle sentinel */
export function settleFrame(frames: readonly Frame[], chunks: readonly Chunk[], fromIndex: number): { index: number; at: number } | null {
  for (let i = Math.max(0, fromIndex); i < frames.length; i++) {
    const f = frames[i]!;
    if (!SETTLE_RE.test(stripAnsi(f.body))) continue;
    const t = frameTime(f, chunks);
    if (t !== null) return { index: i, at: t };
  }
  return null;
}

/**
 * The frames of the idle window bucketed by the second of their arrival, counted from the settle frame's arrival time. A frame
 * is `dynamic` unless it carries new `<Static>` rows; its bytes are the whole bracket (`end − start`). Pure.
 */
export function bucketIdle(frames: readonly Frame[], chunks: readonly Chunk[], firstIdx: number, fromMs: number = IDLE_WINDOW_FROM_MS, toMs: number = IDLE_WINDOW_TO_MS): IdleBuckets {
  const settle = settleFrame(frames, chunks, firstIdx);
  if (settle === null) return { settleAt: null, settleIndex: -1, buckets: [], wordmarkFrames: 0 };
  const first = Math.ceil(fromMs / 1000);
  const last = Math.floor(toMs / 1000) - 1;
  const buckets: IdleBucket[] = [];
  for (let s = first; s <= last; s++) buckets.push({ second: s, dynamic: 0, static: 0, bytes: 0, wordmark: 0 });
  let wordmarkFrames = 0;
  for (let i = settle.index + 1; i < frames.length; i++) {
    const f = frames[i]!;
    const t = frameTime(f, chunks);
    if (t === null) continue;
    const rel = t - settle.at;
    if (rel < fromMs || rel >= toMs) continue;
    const b = buckets[Math.floor(rel / 1000) - first];
    if (b === undefined) continue;
    if (staticRows(f.body) > 0) b.static += 1;
    else b.dynamic += 1;
    b.bytes += f.end - f.start;
    if (wordmarkCells(f.body) > 0) {
      b.wordmark += 1;
      wordmarkFrames += 1;
    }
  }
  return { settleAt: settle.at, settleIndex: settle.index, buckets, wordmarkFrames };
}

export interface IdleGeometry {
  rows: number;
  columns: number;
  /** the wordmark setting the run was measured with (`sweep` = the loop) */
  wordmark: 'sweep' | 'static';
  settleAt: number | null;
  /** seconds covered by the window (30 by construction) */
  seconds: number;
  frames: number;
  /** dynamic frames in the window */
  dynamicFrames: number;
  /** busiest one-second bucket */
  fpsMax: number | null;
  fpsMean: number | null;
  /** the per-second dynamic counts, for the JSON */
  buckets: number[];
  bytesMax: number | null;
  bytesMean: number | null;
  /** the widest frame of the window in bytes */
  frameBytesMax: number | null;
  wordmarkFrames: number;
  staticFrames: number;
  clears: number;
  regionMax: number;
  /** the child's CPU time (ms) at the start and end of the window and the delta — reported; null when `ps` found no process */
  cpu: { startMs: number; endMs: number; deltaMs: number; perSecondMs: number } | null;
  exitCode: number | null;
  timedOut: boolean;
  fpsOk: boolean;
  bytesOk: boolean;
  hygieneOk: boolean;
  pass: boolean;
}

export interface IdleFramesResult {
  fpsPeakGate: number;
  fpsMeanGate: number;
  bytesPeakGate: number;
  bytesMeanGate: number;
  windowMs: { from: number; to: number };
  geometries: IdleGeometry[];
  deviations: string[];
  pass: boolean;
}

/** the gate arithmetic over a bucketed window — pure (unit-tested) */
export function judgeIdle(b: IdleBuckets, hygiene: { clears: number; regionMax: number; rows: number; exitCode: number | null; timedOut: boolean; frames: number }, geometry: { rows: number; columns: number; wordmark: 'sweep' | 'static' }, cpu: IdleGeometry['cpu'] = null): IdleGeometry {
  const counts = b.buckets.map((x) => x.dynamic);
  const bytes = b.buckets.map((x) => x.bytes);
  const seconds = b.buckets.length;
  const settled = b.settleAt !== null && seconds > 0;
  const dynamicFrames = counts.reduce((a, c) => a + c, 0);
  const staticFrames = b.buckets.reduce((a, x) => a + x.static, 0);
  const fpsMax = settled ? Math.max(...counts) : null;
  const fpsMean = settled ? dynamicFrames / seconds : null;
  const bytesMax = settled ? Math.max(...bytes) : null;
  const bytesMean = settled ? bytes.reduce((a, c) => a + c, 0) / seconds : null;
  const fpsOk = settled && fpsMax !== null && fpsMax <= IDLE_FPS_PEAK && fpsMean !== null && fpsMean <= IDLE_FPS_MEAN;
  const bytesOk = settled && bytesMax !== null && bytesMax <= IDLE_BYTES_PEAK && bytesMean !== null && bytesMean <= IDLE_BYTES_MEAN;
  const hygieneOk = hygiene.clears === 0 && hygiene.regionMax <= hygiene.rows - 2 && hygiene.exitCode === 0 && !hygiene.timedOut;
  return {
    rows: geometry.rows,
    columns: geometry.columns,
    wordmark: geometry.wordmark,
    settleAt: b.settleAt,
    seconds,
    frames: hygiene.frames,
    dynamicFrames,
    fpsMax,
    fpsMean,
    buckets: counts,
    bytesMax,
    bytesMean,
    frameBytesMax: null,
    wordmarkFrames: b.wordmarkFrames,
    staticFrames,
    clears: hygiene.clears,
    regionMax: hygiene.regionMax,
    cpu,
    exitCode: hygiene.exitCode,
    timedOut: hygiene.timedOut,
    fpsOk,
    bytesOk,
    hygieneOk,
    pass: fpsOk && bytesOk && hygieneOk,
  };
}

/** `ps -o time=` → milliseconds (`0:01.23`, `1:02:03.45`); null when unparsable */
export function parsePsTime(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const h = m[1] !== undefined ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] !== undefined ? Number(`0.${m[4]}`) : 0;
  return Math.round(((h * 60 + min) * 60 + s + frac) * 1000);
}

/** the cumulative CPU time (ms) of the first `node … bin/jevcode.js … --workspace <ws>` process, or null */
function cpuTimeOf(workspace: string): number | null {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,time=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const cmd = m[3] ?? '';
      if (cmd.includes(workspace) && cmd.includes('bin/jevcode.js') && !cmd.includes('pty_type.py')) return parsePsTime(m[2] ?? '');
    }
  } catch {
    /* ps unavailable: reported as null */
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** sample the child's CPU time at `atMs` and `untilMs` after the drive started (wall clock of this process) */
async function sampleCpu(workspace: string, atMs: number, untilMs: number, done: () => boolean): Promise<IdleGeometry['cpu']> {
  await sleep(atMs);
  const start = cpuTimeOf(workspace);
  if (start === null) return null;
  const t0 = Date.now();
  let end = start;
  while (Date.now() - t0 < untilMs - atMs && !done()) {
    await sleep(500);
    const v = cpuTimeOf(workspace);
    if (v === null) break;
    end = v;
  }
  const seconds = Math.max(1, (untilMs - atMs) / 1000);
  return { startMs: start, endMs: end, deltaMs: end - start, perSecondMs: (end - start) / seconds };
}

export const IDLE_DEVIATIONS: readonly string[] = [
  'the CPU figure is the child\'s cumulative `ps -o time=` sampled from the harness at ≈ 2 s and ≈ 32 s after the spawn (centisecond resolution, the whole process incl. the 1 Hz tick), reported and not gated (TUI-DESIGN-3 §3.9: above 30 ms/s mean the owner lowers LOOP_INTERVAL_MS by one constant)',
  'frames are classed `dynamic` unless they carry new `<Static>` rows; with no key sent the `key` class is empty, so the bucket counts are the whole idle traffic',
];

async function runGeometry(root: string, bin: string, rows: number, columns: number): Promise<IdleGeometry> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  try {
    const steps: TypistStep[] = [
      { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 20_000 },
      { op: 'expect', pattern: 'Say hi', timeoutMs: 20_000 },
      { op: 'mark', label: 'first-frame' },
      // no key: the reveal settles by itself, the loop rests, passes and rests again — 33 s covers the 31 s window after the settle
      { op: 'sleep', ms: IDLE_HOLD_MS },
      { op: 'mark', label: 'idle-end' },
      { op: 'send', text: '/exit' },
      { op: 'sleep', ms: 200 },
      { op: 'send', text: '\r' },
      { op: 'eof', timeoutMs: 20_000 },
    ];
    let finished = false;
    const cpuP = sampleCpu(ws, 2000, IDLE_HOLD_MS - 1000, () => finished);
    const r = await typist({ root, rows, columns, steps, command: [process.execPath, bin, 'chat', '--mock', '--source', 'perf', '--workspace', ws], env: { JEVCODE_HOME: home, NODE_ENV: 'production' }, wallMs: 120_000, label: `idle-frames-${rows}x${columns}` });
    finished = true;
    const cpu = await cpuP;
    const { frames } = splitFrames(r.capture);
    const firstDyn = firstDynamicFrameOffset(r.capture);
    const firstIdx = Math.max(0, frameAt(frames, firstDyn));
    const buckets = bucketIdle(frames, r.chunks, firstIdx);
    const g = judgeIdle(buckets, { clears: clearsAfter(r.capture, firstDyn), regionMax: paintedMax(frames, firstIdx + 1), rows, exitCode: r.code, timedOut: r.timedOut, frames: frames.length }, { rows, columns, wordmark: 'sweep' }, cpu);
    const inWindow = frames.filter((f, i) => i > buckets.settleIndex && buckets.settleAt !== null && (frameTime(f, r.chunks) ?? -1) - buckets.settleAt >= IDLE_WINDOW_FROM_MS && (frameTime(f, r.chunks) ?? Number.POSITIVE_INFINITY) - buckets.settleAt < IDLE_WINDOW_TO_MS);
    return { ...g, frameBytesMax: inWindow.length ? Math.max(...inWindow.map((f) => f.end - f.start)) : null };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

export function describeIdle(g: IdleGeometry): string {
  return `idle ${g.rows}×${g.columns}: settle ${g.settleAt === null ? 'NOT SEEN' : `${g.settleAt.toFixed(0)} ms`}, ${g.dynamicFrames} dynamic frames over ${g.seconds} s (peak ${g.fpsMax ?? '–'}/s, mean ${g.fpsMean?.toFixed(2) ?? '–'}/s; gate ≤ ${IDLE_FPS_PEAK} / ≤ ${IDLE_FPS_MEAN}${g.fpsOk ? '' : ' EXCEEDED'}), ${g.wordmarkFrames} with the wordmark, ${g.staticFrames} static; bytes peak ${g.bytesMax ?? '–'} mean ${g.bytesMean?.toFixed(0) ?? '–'}/s (gate ≤ ${IDLE_BYTES_PEAK} / ≤ ${IDLE_BYTES_MEAN}${g.bytesOk ? '' : ' EXCEEDED'}; widest frame ${g.frameBytesMax ?? '–'} B); clears ${g.clears}, region max ${g.regionMax}, cpu ${g.cpu === null ? 'n/a' : `${g.cpu.deltaMs} ms over the window (${g.cpu.perSecondMs.toFixed(1)} ms/s)`}, exit ${g.exitCode}${g.timedOut ? ' TIMEOUT' : ''} → ${g.pass ? 'pass' : 'FAIL'}`;
}

export async function measureIdleFrames(opts: { root: string; bin: string; onProgress?: (line: string) => void }): Promise<IdleFramesResult> {
  const geometries: IdleGeometry[] = [];
  for (const [rows, columns] of [
    [24, 80],
    [40, 120],
  ] as const) {
    const g = await runGeometry(opts.root, opts.bin, rows, columns);
    geometries.push(g);
    opts.onProgress?.(describeIdle(g));
  }
  return { fpsPeakGate: IDLE_FPS_PEAK, fpsMeanGate: IDLE_FPS_MEAN, bytesPeakGate: IDLE_BYTES_PEAK, bytesMeanGate: IDLE_BYTES_MEAN, windowMs: { from: IDLE_WINDOW_FROM_MS, to: IDLE_WINDOW_TO_MS }, geometries, deviations: [...IDLE_DEVIATIONS], pass: geometries.every((g) => g.pass) };
}
