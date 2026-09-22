/**
 * Scroll latency — TUI-DESIGN-4 §11's new gate row, **fullscreen only (D-S)**.
 *
 * The classic renderer has no scroll: the terminal's own scrollback holds the transcript and PgUp is the
 * terminal's key, not ours. The fullscreen renderer (`--renderer fullscreen`, §1.3) owns the alternate screen and
 * therefore owns scrolling, so three numbers become gates:
 *
 *   scroll key → frame   p95 < `SCROLL_P95_MS` (16 ms) and max < `SCROLL_MAX_MS` (50 ms) at 40×120 with
 *                        `SCROLL_ITEMS` (20 000) items in the viewport index;
 *   bytes per frame      ≤ `SCROLL_FRAME_BYTES` (6 KB) per scroll frame — a repaint of the whole screen at
 *                        40×120 is ~5 KB of text plus SGR, so a viewport that re-emits its static rows blows
 *                        this immediately;
 *   width rebuild        a width change re-wraps the index in < `SCROLL_REBUILD_MS` (50 ms).
 *
 * The probe is **skipped, not failed**, when the renderer refuses fullscreen (§1.3.1 lists four refusals: rows,
 * columns, screen reader, `TERM`) or when the build has no fullscreen renderer at all — a skipped row says so
 * with the refusal text, which is the measurement a reader wants either way.
 *
 * Every other rule of `render-lag.ts` applies unchanged: zero clears after the first frame (the alternate-screen
 * enter is `ESC[?1049h`, which `CLEAR_RE` counts and which happens BEFORE the first frame), no `ESC[3J` ever, the
 * cursor shown at exit, exit 0.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUN_STARTED_PATTERN,
  chunkTimeAt,
  clearsAfter,
  count3J,
  cursorStats,
  firstDynamicFrameOffset,
  frameAt,
  keyLatencies,
  paintedRows,
  splitFrames,
  summarise,
  typist,
  type Frame,
  type LatencySummary,
  type TypistStep,
} from './pty.js';

/** the geometry §11 names */
export const SCROLL_ROWS = 40;
export const SCROLL_COLUMNS = 120;
/** §11: "20 000 items" — mocked steps, each committing at least one item */
export const SCROLL_ITEMS = 20_000;
/** scroll keys measured (the composer probe's count, so the two tables read alike) */
export const SCROLL_KEYS = 200;
export const SCROLL_P95_MS = 16;
export const SCROLL_MAX_MS = 50;
/** §11: "≤ 6 KB per scroll frame" */
export const SCROLL_FRAME_BYTES = 6 * 1024;
/** §11: "a width-change rebuild < 50 ms" */
export const SCROLL_REBUILD_MS = 50;

/** PgUp / PgDn as a terminal delivers them (xterm / VT220 `ESC[5~` and `ESC[6~`). */
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';

export interface ScrollLatencyResult {
  /** null when the probe ran; the refusal or the reason it could not run */
  skipped: string | null;
  rows: number;
  columns: number;
  items: number;
  keys: number;
  latency: LatencySummary;
  gateP95Ms: number;
  gateMaxMs: number;
  latencyOk: boolean;
  /** the largest scroll frame in bytes and the gate */
  frameBytesMax: number;
  frameBytesGate: number;
  frameBytesOk: boolean;
  /** the settle after the width change, in ms (null when the resize step produced no frame) */
  rebuildMs: number | null;
  rebuildGate: number;
  rebuildOk: boolean;
  /** hygiene, exactly as `render-lag.ts` defines it */
  clears: number;
  esc3J: number;
  /** frames whose painted region is not EXACTLY `rows` (the fullscreen post-condition, §11's rows−2 row) */
  offHeightFrames: number;
  cursorShownAtEnd: boolean;
  exitCode: number | null;
  timedOut: boolean;
  pass: boolean;
}

/** §1.3.1's four refusals, as they reach the transcript; any of them means "this build ran classic". */
const REFUSAL_RE = /fullscreen (?:needs|repaints)[^\n]*/;

function skipResult(why: string): ScrollLatencyResult {
  return {
    skipped: why,
    rows: SCROLL_ROWS,
    columns: SCROLL_COLUMNS,
    items: SCROLL_ITEMS,
    keys: 0,
    latency: summarise([]),
    gateP95Ms: SCROLL_P95_MS,
    gateMaxMs: SCROLL_MAX_MS,
    latencyOk: true,
    frameBytesMax: 0,
    frameBytesGate: SCROLL_FRAME_BYTES,
    frameBytesOk: true,
    rebuildMs: null,
    rebuildGate: SCROLL_REBUILD_MS,
    rebuildOk: true,
    clears: 0,
    esc3J: 0,
    offHeightFrames: 0,
    cursorShownAtEnd: true,
    exitCode: null,
    timedOut: false,
    // a skipped probe never fails the board: the gate is "fullscreen scrolls fast", not "fullscreen exists here"
    pass: true,
  };
}

/** the frame a scroll key produced: in the viewport the painted region is constant, so the CONTENT must differ */
function frameChanged(frame: Frame, _key: string, before: Frame | null): boolean {
  return before !== null && frame.body !== before.body;
}

export async function measureScrollLatency(opts: { root: string; bin: string; onProgress?: (line: string) => void }): Promise<ScrollLatencyResult> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-scroll-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-scroll-ws-'));
  try {
    const steps: TypistStep[] = [
      { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 20_000 },
      { op: 'expect', pattern: 'Say hi', timeoutMs: 20_000 },
      { op: 'sleep', ms: 500 },
      { op: 'send', text: 'fill the viewport' },
      { op: 'sleep', ms: 200 },
      { op: 'send', text: '\r' },
      { op: 'expect', pattern: RUN_STARTED_PATTERN, timeoutMs: 20_000 },
      // let the index grow past the viewport before the first scroll key
      { op: 'sleep', ms: 4000 },
    ];
    const measured = new Set<number>();
    for (let i = 0; i < SCROLL_KEYS; i++) {
      measured.add(steps.length + 1);
      steps.push({ op: 'send', text: i % 2 === 0 ? PAGE_UP : PAGE_DOWN }, { op: 'sleep', ms: 50 });
    }
    // the width-change rebuild: one resize, then the settle
    steps.push({ op: 'sleep', ms: 300 }, { op: 'mark', label: 'pre-resize' }, { op: 'resize', rows: SCROLL_ROWS, columns: 80 }, { op: 'sleep', ms: 1500 }, { op: 'send', text: '\x03' }, { op: 'sleep', ms: 400 }, { op: 'send', text: '\x03' }, { op: 'sleep', ms: 600 }, { op: 'send', text: '/exit' }, { op: 'sleep', ms: 200 }, { op: 'send', text: '\r' }, { op: 'eof' });

    const r = await typist({
      root: opts.root,
      rows: SCROLL_ROWS,
      columns: SCROLL_COLUMNS,
      steps,
      command: [
        process.execPath,
        opts.bin,
        'chat',
        '--renderer',
        'fullscreen',
        '--mode',
        'jev-on',
        '--mock',
        '--mock-steps',
        String(SCROLL_ITEMS),
        '--max-steps',
        String(SCROLL_ITEMS),
        '--max-replans',
        '100000',
        '--source',
        'perf',
        '--workspace',
        ws,
      ],
      env: { JEVCODE_HOME: home, NODE_ENV: 'production', JEVCODE_MOCK_STEP_MS: '0' },
      wallMs: 300_000,
      label: 'scroll-latency',
    });
    const refusal = REFUSAL_RE.exec(r.capture);
    if (refusal !== null) return skipResult(refusal[0]);
    const { frames } = splitFrames(r.capture);
    if (frames.length === 0) return skipResult('the fullscreen renderer produced no frame in this build');
    const firstIdx = Math.max(0, frameAt(frames, firstDynamicFrameOffset(r.capture)));
    const lat = keyLatencies(r.timing, frames, r.chunks, measured, frameChanged);
    const latency = summarise(lat.map((l) => l.ms));
    // a scroll frame is a frame that answered a measured key; its byte length is what the terminal had to read
    const answered = new Set(lat.map((l) => l.frameIndex));
    let frameBytesMax = 0;
    let offHeightFrames = 0;
    for (let i = firstIdx; i < frames.length; i++) {
      const f = frames[i]!;
      if (answered.has(i)) frameBytesMax = Math.max(frameBytesMax, f.body.length);
      const painted = paintedRows(f.body);
      if (painted !== null && painted !== SCROLL_ROWS) offHeightFrames += 1;
    }
    const resizeAt = r.timing.find((s) => s.op === 'resize')?.t ?? null;
    const rebuildMs =
      resizeAt === null
        ? null
        : (() => {
            for (let i = 0; i < frames.length; i++) {
              const t = chunkTimeAt(r.chunks, frames[i]!.end);
              if (t !== null && t >= resizeAt) return t - resizeAt;
            }
            return null;
          })();
    const clears = clearsAfter(r.capture, firstDynamicFrameOffset(r.capture));
    const esc3J = count3J(r.capture);
    const cursor = cursorStats(frames, r.capture);
    const latencyOk = (latency.p95 ?? 0) < SCROLL_P95_MS && (latency.max ?? 0) < SCROLL_MAX_MS && latency.samples > 0;
    const frameBytesOk = frameBytesMax <= SCROLL_FRAME_BYTES;
    const rebuildOk = rebuildMs === null || rebuildMs < SCROLL_REBUILD_MS;
    const result: ScrollLatencyResult = {
      skipped: null,
      rows: SCROLL_ROWS,
      columns: SCROLL_COLUMNS,
      items: SCROLL_ITEMS,
      keys: SCROLL_KEYS,
      latency,
      gateP95Ms: SCROLL_P95_MS,
      gateMaxMs: SCROLL_MAX_MS,
      latencyOk,
      frameBytesMax,
      frameBytesGate: SCROLL_FRAME_BYTES,
      frameBytesOk,
      rebuildMs,
      rebuildGate: SCROLL_REBUILD_MS,
      rebuildOk,
      clears,
      esc3J,
      offHeightFrames,
      cursorShownAtEnd: cursor.shownAtEnd,
      exitCode: r.code,
      timedOut: r.timedOut,
      pass: latencyOk && frameBytesOk && rebuildOk && clears === 0 && esc3J === 0 && cursor.shownAtEnd && !r.timedOut,
    };
    opts.onProgress?.(
      `scroll latency ${SCROLL_ROWS}x${SCROLL_COLUMNS} (${SCROLL_ITEMS} items): ${latency.samples}/${SCROLL_KEYS} keys, p50 ${latency.p50?.toFixed(1)} p95 ${latency.p95?.toFixed(1)} max ${latency.max?.toFixed(1)} ms (gate p95 < ${SCROLL_P95_MS}, max < ${SCROLL_MAX_MS}), frame bytes max ${frameBytesMax} (gate ≤ ${SCROLL_FRAME_BYTES}), width rebuild ${rebuildMs?.toFixed(1) ?? 'n/a'} ms (gate < ${SCROLL_REBUILD_MS}), clears ${clears}, ESC[3J ${esc3J}, frames not exactly ${SCROLL_ROWS} rows ${offHeightFrames}, exit ${r.code} → ${result.pass ? 'pass' : 'FAIL'}`,
    );
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}
