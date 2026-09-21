/**
 * Zero-clears per state and geometry segment (TUI-DESIGN §18 rows 4 and 8): every modal state the TUI has is driven
 * in a real pty and the capture is checked for `CLEAR_RE` (ESC[2J, ESC[3J, ESC c, ESC[?1049h/l — self-tested first),
 * the painted dynamic region (rows − 2, read from every frame with `pty.ts` `paintedRows`) and the exit code.
 *
 *   review    `JEVCODE_MOCK_REVIEW_AT=2` under `--mock`: the §6 box, answered with `y`
 *   palette   `/` opens it, two letters filter, Esc closes
 *   picker    `/resume` after a mocked run opens the session picker (`> filter:`), Esc closes
 *   wizard    `chat` with no key anywhere (temp HOME / XDG, no .env): the §11 wizard, Ctrl-C exits 2
 *   secret    a draft holding an `sk-ant-api03-…` canary + Enter: the §4.10 gate row, Esc dismisses
 *   fault     `JEVCODE_FAULT=render:composer` and `render:pane`: the §13.4 fallback row, the run continues
 *   resize    after a mocked run (pane open, idle) with a draft: 40×120 → 12×120 → 40×120; segments are delimited by
 *             marker keys typed before and after each resize (`A` | shrink | `B` | grow | `C`): the pre-shrink and the
 *             grow segments must have zero clears, the shrink segment at most one (research 20 §1: the previous frame
 *             is taller than the new terminal, so Ink erases it with one clear)
 *   resize-live  the same shrink and grow while the mocked run is live and the pane is streaming (`--mock-steps 3000
 *             --max-replans 100000`, resized right after `decisions s<n>` appears, then Ctrl-C twice) — the 1–2 clear
 *             race DESIGN §12 and `test/pty/smoke/resize-live.steps` describe; allowed 1 per shrink, the same bound
 *             `test/pty/chat.pty.test.ts` asserts, so the two gates agree
 *   resize-idle  research 20 §1's configuration for comparison: idle composer with a draft, no pane, 24×80 → 12×60 → 24×80
 *   ctrl-l    a 3-row draft with the pane open, then Ctrl+L: zero clears and the repaint's visible content equals the
 *             frame before it (one erase-lines + rewrite inside one BSU/ESU pair)
 *
 * Drivers: the resize scenarios run through `perf/drivers/pty_type.py` (`pty.ts` `typist()`), whose `resize` record
 * carries the capture byte offset of the TIOCSWINSZ, so every frame in a segment is judged against the budget of the
 * geometry it was painted in (`judgeSegment`): before the offset, rows − 2 of the old geometry; from the offset on,
 * the new one's — except frames the process had already rendered when SIGWINCH landed. Those *in-flight* frames are
 * the ones written after the offset but before the TUI's first reaction (a clear-terminal frame, or the first frame
 * that fits the new budget) and still fitting the old budget; measured 2026-09-21 on a live pane: one frame starting
 * at the resize byte offset itself, arriving 2 ms after the ioctl, followed 4 ms later by the single clear frame that
 * already carried the new layout. They are counted (`inFlightPaints`, `inFlightMs`) but not gated — no listener can
 * pre-empt a frame that is already being written. A taller-than-budget frame at or after the TUI's first reaction is
 * the stale-tree race DESIGN §12 describes (`stalePaints`) and fails `budgetOk`. The other scenarios run through
 * `scripts/pty/drive.exp`; both drivers take the same step lines (`pty.ts` `toTypistSteps`).
 *
 * Clears are counted as events: Ink's `clearTerminal` writes `ESC[2J ESC[3J ESC[H` (ansi-escapes), which is two
 * `CLEAR_RE` matches for one clear; both figures are reported, the gate is on events (0 outside shrink segments, ≤ 1
 * inside one), and `ESC c` / `ESC[?1049h` must never appear anywhere. The clear-terminal frame repaints Ink's whole
 * `fullStaticOutput` before the dynamic frame; its painted dynamic rows (`clearFramePainted`) must fit the new budget.
 *
 * The retry row (`JEVCODE_FAULT=jev:429`) and the blocking panes (`jev:401`, `persist:ENOSPC`) are listed in the
 * result as not driven: those fault hooks are not implemented in the tree (only `render:<pane>` is), see the report.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { END_PATTERN, clearReSelfTest, clearStats, composerRow, drive, firstDynamicFrameOffset, frameAt, frameContent, frameTime, paintedRows, sleepStep, splitFrames, toTypistSteps, typist, type Chunk, type DriveResult, type Frame } from './pty.js';

export interface Segment {
  label: string;
  /** rows of the geometry the segment ends in */
  rows: number;
  /** rows of the geometry the segment started in (differs from `rows` when a resize happened inside it) */
  fromRows: number;
  /** clear events (Ink's `clearTerminal` = ESC[2J ESC[3J ESC[H counts once; see `pty.ts` `clearStats`) */
  clears: number;
  /** raw `CLEAR_RE` matches (two per Ink clear) */
  clearMatches: number;
  allowed: number;
  /** tallest dynamic region painted after the segment's first frame (`pty.ts` `paintedRows`) */
  regionMax: number;
  /** capture byte offset of the resize inside this segment (typist scenarios); null without a resize */
  resizeAt: number | null;
  /** dynamic rows painted by the frame that carried the clear-terminal (null when no frame cleared) */
  clearFramePainted: number | null;
  /** frames written after the resize offset but before the TUI's first reaction, still laid out for the old geometry (already rendered when SIGWINCH landed; reported, not gated) */
  inFlightPaints: number;
  /** arrival of the last in-flight frame relative to the resize, ms (null without one or without chunk times) */
  inFlightMs: number | null;
  /** frames at or after the TUI's first reaction to the resize that painted more rows than the new geometry allows (DESIGN §12's stale-tree race; gated) */
  stalePaints: number;
  /** every frame after the segment's first fits the budget (rows − 2) of the geometry it was painted in */
  budgetOk: boolean;
  frames: number;
}

export interface StateScenario {
  name: string;
  rows: number;
  columns: number;
  driver: 'expect' | 'typist';
  exitCode: number | null;
  expectedExit: number;
  timedOut: boolean;
  segments: Segment[];
  /** clear events over the whole capture after the first dynamic frame */
  clearsTotal: number;
  /** raw `CLEAR_RE` matches over the whole capture after the first dynamic frame */
  clearMatchesTotal: number;
  /** ESC c (RIS) and alternate-screen switches over the whole capture: must be 0 */
  forbidden: number;
  frames: number;
  /** Ctrl+L only: the repaint's visible content equals the frame before it */
  repaintEqual?: boolean;
  /** Ctrl+L only: frames between the marker before Ctrl+L and the marker after (the repaint itself, ideally 1) */
  repaintFrames?: number;
  pass: boolean;
}

export interface StatesResult {
  clearReSelfTest: boolean;
  scenarios: StateScenario[];
  notDriven: string[];
  pass: boolean;
}

const PROLOGUE = ['expect \\x1b\\[\\?25l', 'expect Describe the task', sleepStep(300)];
const START_RUN = ['send start the perf run', sleepStep(200), 'send \\r', 'expect ready'];
const RUN = [...START_RUN, `expect ${END_PATTERN}`, 'expect Follow-up or /command', sleepStep(300)];
const EXIT_IDLE = ['send /exit', sleepStep(200), 'send \\r', 'eof'];
const CANARY = `sk-ant-api03-${'A'.repeat(40)}`;
/** a marker key typed into the draft, then a wait for its frame, then a settle */
const marker = (key: string): string[] => ['send ' + key, `expect ${key}\\r\\n`, sleepStep(300)];
const EXPECT_TIMEOUT_S = 40;

interface Spec {
  name: string;
  rows: number;
  columns: number;
  args: string[];
  env: Record<string, string>;
  steps: string[];
  expectedExit: number;
  /** marker keys delimiting segments (in order) with the rows of each segment and its allowance */
  markers?: { key: string; rows: number; allowed: number }[];
  ctrlL?: { before: string; after: string };
  /** minimal env (no HOME/XDG/keys from the parent) */
  isolated?: boolean;
  /** the typist records the byte offset of each resize; drive.exp (default) does not */
  driver?: 'typist';
}

function resizeSteps(prefix: string[], shrink: string, grow: string, tail: string[]): string[] {
  return [...prefix, 'send a draft that survives the resize ', sleepStep(200), ...marker('A'), `resize ${shrink}`, sleepStep(800), ...marker('B'), `resize ${grow}`, sleepStep(800), ...marker('C'), ...tail];
}

function specs(): Spec[] {
  const both: [number, number][] = [
    [24, 80],
    [12, 60],
  ];
  const out: Spec[] = [];
  for (const [rows, columns] of both) {
    out.push({
      name: 'review',
      rows,
      columns,
      args: ['--mock', '--mock-steps', '5'],
      env: { JEVCODE_MOCK_REVIEW_AT: '2' },
      steps: [...PROLOGUE, 'send start the perf run', sleepStep(200), 'send \\r', 'expect \\[y\\] approve', sleepStep(400), 'send y', 'expect confirm \\S+ approved', `expect ${END_PATTERN}`, 'expect Follow-up or /command', ...EXIT_IDLE],
      expectedExit: 0,
    });
    out.push({
      name: 'palette',
      rows,
      columns,
      args: ['--mock'],
      env: {},
      steps: [...PROLOGUE, 'send /', 'expect Tab completes', sleepStep(200), 'send he', sleepStep(200), 'send \\x1b', sleepStep(200), 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
      expectedExit: 0,
    });
    out.push({
      name: 'wizard',
      rows,
      columns,
      args: [],
      env: {},
      isolated: true,
      steps: ['expect \\x1b\\[\\?25l', 'expect No API key found', sleepStep(500), 'send \\x03', 'eof'],
      expectedExit: 2,
    });
    out.push({
      name: 'secret',
      rows,
      columns,
      args: ['--mock'],
      env: {},
      steps: [...PROLOGUE, `send token ${CANARY}`, sleepStep(200), 'send \\r', 'expect Looks like this contains', sleepStep(400), 'send \\x1b', sleepStep(200), 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
      expectedExit: 0,
    });
  }
  out.push({
    name: 'picker',
    rows: 24,
    columns: 80,
    args: ['--mock', '--mock-steps', '4'],
    env: {},
    steps: [...PROLOGUE, ...RUN, 'send /resume', sleepStep(200), 'send \\r', 'expect filter:', sleepStep(400), 'send \\x1b', 'expect Follow-up or /command', ...EXIT_IDLE],
    expectedExit: 0,
  });
  // render:composer throws in the first frame: the boundary's fallback row is a bare `>` (no placeholder) for the rest of the
  // session and keys still work (§13.4), so the scenario waits for the `[ui]` failure item instead of the placeholder
  out.push({
    name: 'fault-composer',
    rows: 24,
    columns: 80,
    args: ['--mock', '--mock-steps', '4'],
    env: { JEVCODE_FAULT: 'render:composer' },
    steps: ['expect \\x1b\\[\\?25l', 'expect composer pane failed to render', sleepStep(500), 'send start the perf run', sleepStep(200), 'send \\r', 'expect ready', `expect ${END_PATTERN}`, sleepStep(500), ...EXIT_IDLE],
    expectedExit: 0,
  });
  // render:pane throws when the decisions pane first renders (after run:ready)
  out.push({
    name: 'fault-pane',
    rows: 24,
    columns: 80,
    args: ['--mock', '--mock-steps', '4'],
    env: { JEVCODE_FAULT: 'render:pane' },
    steps: [...PROLOGUE, 'send start the perf run', sleepStep(200), 'send \\r', 'expect ready', 'expect pane pane failed to render', `expect ${END_PATTERN}`, 'expect Follow-up or /command', ...EXIT_IDLE],
    expectedExit: 0,
  });
  const resizeMarkers = (hi: number): NonNullable<Spec['markers']> => [
    { key: 'A', rows: hi, allowed: 0 },
    { key: 'B', rows: 12, allowed: 1 },
    { key: 'C', rows: hi, allowed: 0 },
  ];
  // idle pane after a finished run: Ctrl-C clears the draft (S1), then /exit
  out.push({
    name: 'resize',
    rows: 40,
    columns: 120,
    driver: 'typist',
    args: ['--mock', '--mock-steps', '4'],
    env: {},
    steps: resizeSteps([...PROLOGUE, ...RUN], '12 120', '40 120', ['send \\x03', 'expect Follow-up or /command', ...EXIT_IDLE]),
    expectedExit: 0,
    markers: resizeMarkers(40),
  });
  // live pane streaming (the shrink race): Ctrl-C clears the draft (S1), a second Ctrl-C aborts the run (S2), then /exit
  out.push({
    name: 'resize-live',
    rows: 40,
    columns: 120,
    driver: 'typist',
    args: ['--mock', '--mock-steps', '3000', '--max-steps', '3000', '--max-replans', '100000'],
    env: {},
    steps: resizeSteps([...PROLOGUE, ...START_RUN, 'expect decisions s\\d+'], '12 120', '40 120', ['send \\x03', sleepStep(300), 'send \\x03', `expect ${END_PATTERN}`, 'expect Follow-up or /command', ...EXIT_IDLE]),
    expectedExit: 0,
    markers: resizeMarkers(40),
  });
  // research 20 §1's configuration: idle composer with a draft, no pane, 24×80 → 12×60 → 24×80
  out.push({
    name: 'resize-idle',
    rows: 24,
    columns: 80,
    driver: 'typist',
    args: ['--mock'],
    env: {},
    steps: resizeSteps([...PROLOGUE], '12 60', '24 80', ['send \\x03', 'expect Describe the task', ...EXIT_IDLE]),
    expectedExit: 0,
    markers: resizeMarkers(24),
  });
  out.push({
    name: 'ctrl-l',
    rows: 24,
    columns: 80,
    args: ['--mock', '--mock-steps', '4'],
    env: {},
    steps: [...PROLOGUE, ...RUN, `send ${'x'.repeat(70)} ${'y'.repeat(70)} `, sleepStep(200), 'send Q', 'expect Q\\r\\n', sleepStep(400), 'send \\x0c', sleepStep(500), 'send R', 'expect R\\r\\n', sleepStep(200), 'send \\x03', 'expect Follow-up or /command', ...EXIT_IDLE],
    expectedExit: 0,
    ctrlL: { before: 'Q', after: 'R' },
  });
  return out;
}

/** The first frame at or after `from` whose composer row ends with `key`. */
function markerFrame(frames: readonly Frame[], from: number, key: string): number {
  for (let i = from; i < frames.length; i++) if (composerRow(frames[i]!.body)?.endsWith(key)) return i;
  return -1;
}

/** The resize inside a segment: its capture byte offset and the driver-clock time of the TIOCSWINSZ. */
export interface ResizeMark {
  off: number;
  t: number;
}

/**
 * Judge the frames of one segment: bytes from the start of frame `fromIdx` up to the start of frame `toIdx` (or the
 * end) for clears; every frame after the segment's first, including the marker frame that ends it, for the painted
 * region. With a `resize` (typist scenarios) frames before its offset are held to the old geometry's budget; from the
 * offset on, frames are in flight until the TUI's first reaction (a clear-terminal frame, or the first frame fitting
 * the new budget) and must fit the old budget; from that reaction on they must fit the new budget (see the header).
 * Without a recorded offset (drive.exp) a resize segment is held to the larger of the two budgets.
 */
export function judgeSegment(label: string, fromRows: number, rows: number, allowed: number, frames: readonly Frame[], capture: string, fromIdx: number, toIdx: number, resize: ResizeMark | null, chunks: readonly Chunk[] = []): Segment {
  const start = frames[fromIdx]?.start ?? capture.length;
  const end = toIdx < frames.length ? frames[toIdx]!.start : capture.length;
  const inner = frames.slice(fromIdx + 1, Math.min(frames.length, toIdx + 1));
  const oldBudget = fromRows - 2;
  const newBudget = rows - 2;
  let regionMax = 0;
  let budgetOk = true;
  let stalePaints = 0;
  let inFlightPaints = 0;
  let inFlightMs: number | null = null;
  let clearFramePainted: number | null = null;
  let reacted = resize === null;
  for (const f of inner) {
    const painted = paintedRows(f.body);
    if (painted === null) continue;
    regionMax = Math.max(regionMax, painted);
    const cleared = clearStats(f.body).events > 0;
    if (cleared) clearFramePainted = painted;
    if (resize === null) {
      if (painted > Math.max(oldBudget, newBudget)) budgetOk = false;
      continue;
    }
    if (f.start < resize.off) {
      if (painted > oldBudget) budgetOk = false;
      continue;
    }
    if (!reacted && !cleared && painted > newBudget && painted <= oldBudget) {
      inFlightPaints += 1;
      const t = frameTime(f, chunks);
      if (t !== null) inFlightMs = Math.max(inFlightMs ?? 0, t - resize.t);
      continue;
    }
    reacted = true;
    if (painted > newBudget) {
      budgetOk = false;
      stalePaints += 1;
    }
  }
  const cs = clearStats(capture.slice(start, end));
  return { label, rows, fromRows, clears: cs.events, clearMatches: cs.matches, allowed, regionMax, resizeAt: resize?.off ?? null, clearFramePainted, inFlightPaints, inFlightMs, stalePaints, budgetOk, frames: Math.max(0, toIdx - fromIdx) };
}

async function runSpec(root: string, bin: string, s: Spec): Promise<StateScenario> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  try {
    const env: Record<string, string> = { JEVCODE_HOME: home, NODE_ENV: 'production', XDG_CONFIG_HOME: join(home, 'xdg'), ...s.env };
    if (s.isolated) env['HOME'] = home;
    const command = [process.execPath, bin, 'chat', '--source', 'perf', '--workspace', ws, ...s.args];
    const label = `state-${s.name}-${s.rows}x${s.columns}`;
    const driver = s.driver ?? 'expect';
    const r: DriveResult =
      driver === 'typist'
        ? await typist({ root, rows: s.rows, columns: s.columns, steps: toTypistSteps(s.steps, EXPECT_TIMEOUT_S * 1000), command, env, wallMs: 180_000, label })
        : await drive({ root, rows: s.rows, columns: s.columns, steps: s.steps, command, env, timeoutS: EXPECT_TIMEOUT_S, wallMs: 180_000, label });
    const { frames } = splitFrames(r.capture);
    const firstDyn = firstDynamicFrameOffset(r.capture);
    const firstIdx = Math.max(0, frameAt(frames, firstDyn));
    const total = clearStats(r.capture.slice(firstDyn));
    const forbidden = clearStats(r.capture).ris + clearStats(r.capture).altScreen;
    const resizes: ResizeMark[] = r.timing.filter((t) => t.op === 'resize' && t.off !== undefined).map((t) => ({ off: t.off!, t: t.t }));
    const chunks: readonly Chunk[] = 'chunks' in r ? (r as { chunks: Chunk[] }).chunks : [];
    const segments: Segment[] = [];
    if (s.markers && s.markers.length > 0) {
      // segment k runs from marker k−1's frame (or the first dynamic frame) up to marker k's frame; the last runs to the end
      let from = firstIdx;
      let prevRows = s.rows;
      for (const m of s.markers) {
        const at = markerFrame(frames, from, m.key);
        if (at < 0) break;
        // the bytes from the previous marker's frame to this marker's frame include the resize between them (if any)
        const lo = frames[from]!.start;
        const hi = frames[at]!.start;
        const resize = m.rows === prevRows ? null : (resizes.find((o) => o.off >= lo && o.off < hi) ?? null);
        segments.push(judgeSegment(`→${m.key} (${prevRows}→${m.rows} rows)`, prevRows, m.rows, m.rows === prevRows ? 0 : m.allowed, frames, r.capture, from, at, resize, chunks));
        from = at;
        prevRows = m.rows;
      }
      segments.push(judgeSegment(`after ${s.markers[s.markers.length - 1]!.key} (${prevRows} rows)`, prevRows, prevRows, 0, frames, r.capture, from, frames.length, null));
    } else {
      segments.push(judgeSegment('whole', s.rows, s.rows, 0, frames, r.capture, firstIdx, frames.length, null));
    }
    let repaintEqual: boolean | undefined;
    let repaintFrames: number | undefined;
    if (s.ctrlL) {
      const q = markerFrame(frames, firstIdx, s.ctrlL.before);
      const rr = q >= 0 ? markerFrame(frames, q + 1, s.ctrlL.after) : -1;
      if (q >= 0 && rr > q) {
        repaintFrames = rr - q - 1;
        const before = frameContent(frames[q]!.body);
        // the repaint is the last frame before the `after` marker's frame (a toast or clock tick could precede it)
        const repaint = rr - 1 > q ? frameContent(frames[rr - 1]!.body) : '';
        repaintEqual = repaint !== '' && repaint === before;
      } else {
        repaintEqual = false;
        repaintFrames = 0;
      }
    }
    // every marker must have been found (a missing one would silently shorten the segment list)
    const markersFound = !s.markers || segments.length === s.markers.length + 1;
    const budgetOk = segments.every((g) => g.budgetOk);
    const clearsOk = segments.every((g) => g.clears <= g.allowed);
    const clearFrameOk = segments.every((g) => g.clearFramePainted === null || g.clearFramePainted <= g.rows - 2);
    const pass = markersFound && clearsOk && budgetOk && clearFrameOk && forbidden === 0 && r.code === s.expectedExit && !r.timedOut && (repaintEqual ?? true);
    return { name: s.name, rows: s.rows, columns: s.columns, driver, exitCode: r.code, expectedExit: s.expectedExit, timedOut: r.timedOut, segments, clearsTotal: total.events, clearMatchesTotal: total.matches, forbidden, frames: frames.length, ...(repaintEqual !== undefined ? { repaintEqual } : {}), ...(repaintFrames !== undefined ? { repaintFrames } : {}), pass };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

export async function measureStates(opts: { root: string; bin: string; onProgress?: (line: string) => void }): Promise<StatesResult> {
  const selfTest = clearReSelfTest();
  const scenarios: StateScenario[] = [];
  for (const s of specs()) {
    const r = await runSpec(opts.root, opts.bin, s);
    scenarios.push(r);
    const segs = r.segments.map((g) => `${g.label}: ${g.clears}/${g.allowed} clears (${g.clearMatches} matches), painted ≤ ${g.regionMax}${g.clearFramePainted !== null ? ` (clear frame painted ${g.clearFramePainted})` : ''}${g.inFlightPaints > 0 ? ` (${g.inFlightPaints} in flight, last +${g.inFlightMs?.toFixed(1)} ms)` : ''}${g.stalePaints > 0 ? ` STALE PAINTS ${g.stalePaints}` : ''}${g.budgetOk ? '' : ' OVER BUDGET'}`).join('; ');
    opts.onProgress?.(`state ${r.name} ${r.rows}x${r.columns} (${r.driver}): exit ${r.exitCode} (want ${r.expectedExit})${r.timedOut ? ' TIMEOUT' : ''}, frames ${r.frames}, forbidden ${r.forbidden}, ${segs}${r.repaintEqual !== undefined ? `, ctrl-l repaint equal ${r.repaintEqual} (${r.repaintFrames} frames)` : ''} → ${r.pass ? 'pass' : 'FAIL'}`);
  }
  return {
    clearReSelfTest: selfTest,
    scenarios,
    notDriven: ['retry row (JEVCODE_FAULT=jev:429 is not implemented in this tree)', 'blocking pane (JEVCODE_FAULT=jev:401 / persist:ENOSPC are not implemented in this tree)'],
    pass: selfTest && scenarios.every((s) => s.pass),
  };
}
