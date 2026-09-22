/**
 * Shared pseudo-TTY plumbing for the perf probes (TUI-DESIGN §18, DESIGN §12).
 *
 * Two drivers, one result shape:
 *
 *   `drive()`  runs `scripts/pty/drive.exp` (research 20) with a generated steps file — used by the state scenarios
 *              (`states.ts`), where only bytes, exit codes and clear counts matter.
 *   `typist()` runs `perf/drivers/pty_type.py`, a `pty.fork` driver that reads the master continuously (also while
 *              sleeping) and records the arrival time and byte offset of every chunk — used by the timing probes
 *              (`composer-latency.ts`, `render-lag.ts`). It exists because expect's `sleep` drains the pty once per
 *              25 ms while a Node child writes to its TTY synchronously, so a chatty child blocks in `write()`:
 *              measured 2026-09-21 at 40×120 on a live mocked run, 11 steps in 12 s and event-loop lag p50 114 ms
 *              during a drive.exp `sleep` against 399 steps in 11 s and lag p50 1.1 ms during a blocking `expect`.
 *              The typist's capture is decoded as latin1 so string indices equal byte offsets; every pattern the
 *              probes search for is ASCII.
 *
 * Frame timestamps: the typist's chunk records give the time of the chunk that completed a frame (`frameTime`), and a
 * keystroke's frame is the first frame written after the key's send offset whose **composer row** ends with that key
 * (`composerRow()`: the row directly above the status line — TUI-DESIGN §2.1's vertical order ends `… composer ·
 * status`, and toasts live in the status line). Matching `X\r\n` anywhere in the frame was wrong: a wrapped draft row
 * above the cursor row can end with a later key (the 2026-09-21 release run paired 23 of 200 `live` keys with a frame
 * that predated them, mostly at 0.0 ms), so the frame that predates the key still ends its cursor row with the
 * previous key and is skipped.
 *
 * `splitFrames()` cuts a capture at Ink's synchronized-output brackets (`ESC[?2026h` … `ESC[?2026l`,
 * `ink/build/write-synchronized.js`); `paintedRows()` measures a frame's dynamic region directly (last rule row → last
 * row, as `test/pty/helpers.ts` does) instead of inferring it from the erase count, which reads 0 for a clear-terminal
 * frame; `CLEAR_RE` is the §18 clear-detection alternation with its self-test.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { percentile } from '../core/time.js';
// TUI-DESIGN-4 §3.7 (the R2 guard): the run-frame anchors come from the ONE formatter, glyph-agnostic by
// construction. A hard-coded `·` silently stops matching in every `--ascii` capture and turns the render-lag
// window into the whole capture — the exact failure mode A3 recorded as risk R2.
import { RUN_END_PATTERN, RUN_STARTED_TAIL_PATTERN } from '../tui/plain.js';

export const BSU = '\x1b[?2026h';
export const ESU = '\x1b[?2026l';
/** Ink's `eraseLines(n)` writes `ESC[2K` once per erased row (`ansi-escapes`). */
const ERASE_LINE = /\x1b\[2K/g;

/**
 * TUI-DESIGN §18 (finding 9): ESC[2J, ESC[3J, ESC c (RIS) and the alternate-screen switch — a JavaScript regex
 * literal alternation (an escaped `\|` would be a literal pipe and match nothing).
 */
export const CLEAR_RE = /\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049[hl]/g;

/** §18: run before any clears gate — the regex must match the four clear forms and not `ESC[2K` (erase line). */
export function clearReSelfTest(): boolean {
  const must = ['\x1b[2J', '\x1b[3J', '\x1bc', '\x1b[?1049h', '\x1b[?1049l'];
  const hit = (s: string): boolean => {
    CLEAR_RE.lastIndex = 0;
    const r = CLEAR_RE.test(s);
    CLEAR_RE.lastIndex = 0;
    return r;
  };
  return must.every(hit) && !hit('\x1b[2K') && !hit('\x1b[1A');
}

/**
 * TUI-DESIGN-4 §11 (new gate row "no `ESC[3J` ever") / §1.4: `ESC[3J` deletes the user's **scrollback**, which is
 * theirs, not ours. A clear after a shrink is `ESC[2J ESC[H` and nothing else — Ink's own `clearTerminal`
 * (`ESC[2J ESC[3J ESC[H`) is exactly what `guardStdout` (§1.4) rewrites.
 */
export const NO_3J_RE = /\x1b\[[0-9;]*3J/g;

/** §11: the count of `ESC[3J` sequences in a capture; the gate is **0**, in every capture, at every geometry. */
export function count3J(s: string): number {
  return (s.match(NO_3J_RE) ?? []).length;
}

/** §11: run before the `NO_3J` gate — the regex must match the bare and parameterised forms and nothing adjacent. */
export function no3JSelfTest(): boolean {
  const hit = (x: string): boolean => {
    NO_3J_RE.lastIndex = 0;
    const r = NO_3J_RE.test(x);
    NO_3J_RE.lastIndex = 0;
    return r;
  };
  return hit('\x1b[3J') && hit('\x1b[?3J') === false && hit('\x1b[0;3J') && !hit('\x1b[2J') && !hit('\x1b[2K') && !hit('\x1b[3K') && !hit('3J');
}

/** Number of `CLEAR_RE` matches in `s` (`String.prototype.match` with a global regex ignores and resets `lastIndex`). */
export function countClears(s: string): number {
  return (s.match(CLEAR_RE) ?? []).length;
}

export interface ClearStats {
  /** raw `CLEAR_RE` matches (the §18 figure) */
  matches: number;
  /** clear events: Ink's `clearTerminal` is `ESC[2J ESC[3J ESC[H` (ansi-escapes), i.e. two matches for one clear; a lone ESC[3J, ESC c or ESC[?1049h/l counts once */
  events: number;
  /** ESC c (RIS) occurrences — must never appear */
  ris: number;
  /** alternate-screen switches — must never appear */
  altScreen: number;
}

const CLEAR_EVENT_RE = /\x1b\[[0-9;]*2J(?:\x1b\[3J)?(?:\x1b\[H)?|\x1b\[[0-9;]*3J|\x1bc|\x1b\[\?1049[hl]/g;

export function clearStats(s: string): ClearStats {
  return {
    matches: countClears(s),
    events: (s.match(CLEAR_EVENT_RE) ?? []).length,
    ris: (s.match(/\x1bc/g) ?? []).length,
    altScreen: (s.match(/\x1b\[\?1049[hl]/g) ?? []).length,
  };
}

/**
 * Letters a measured keystroke may use: uppercase, cycled — no two neighbours are equal, so a frame that still shows
 * the previous key never ends the composer row with the new one. (The pairing is on the composer row, `composerRow()`,
 * so other rows of the TUI cannot match whatever they end with.)
 */
export const SAFE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function safeKey(i: number): string {
  return SAFE_KEYS[i % SAFE_KEYS.length]!;
}

// ---------------------------------------------------------------------------------------
// Timing records (both drivers write the same shape)
// ---------------------------------------------------------------------------------------

export interface TimingStep {
  t: number;
  step: number;
  op: string;
  arg: string;
  /** typist `send` and `resize` records: the capture byte offset at the moment of the write / the TIOCSWINSZ */
  off?: number;
}

export interface Chunk {
  t: number;
  off: number;
  n: number;
}

export function parseTiming(text: string): { steps: TimingStep[]; chunks: Chunk[] } {
  const steps: TimingStep[] = [];
  const chunks: Chunk[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o['t'] !== 'number' || typeof o['op'] !== 'string') continue;
    if (o['op'] === 'chunk') {
      if (typeof o['off'] === 'number' && typeof o['n'] === 'number') chunks.push({ t: o['t'], off: o['off'], n: o['n'] });
      continue;
    }
    if (typeof o['step'] !== 'number') continue;
    steps.push({ t: o['t'], step: o['step'], op: o['op'], arg: typeof o['arg'] === 'string' ? o['arg'] : '', ...(typeof o['off'] === 'number' ? { off: o['off'] } : {}) });
  }
  return { steps, chunks };
}

// ---------------------------------------------------------------------------------------
// drive.exp
// ---------------------------------------------------------------------------------------

export interface DriveOptions {
  /** repository root (holds scripts/pty/drive.exp and perf/drivers/pty_type.py) */
  root: string;
  rows: number;
  columns: number;
  /** one drive.exp step per entry (`expect …`, `send …`, `sleep …`, `resize r c`, `mark …`, `eof`) */
  steps: readonly string[];
  /** the child command (argv) */
  command: readonly string[];
  /** environment for the driver and the child (PATH/HOME/TERM are filled in when absent; CI is never passed) */
  env?: Readonly<Record<string, string>>;
  /** per-expect-step timeout in seconds (default 60) */
  timeoutS?: number;
  /** hard cap on the whole drive (default 240 s); the driver is killed past it */
  wallMs?: number;
  /** file stem under `JEVCODE_PERF_KEEP` (when that env var names a directory, the capture and timing files are kept there as evidence) */
  label?: string;
}

/** `JEVCODE_PERF_KEEP=<dir>`: keep `<dir>/<label>.cap` and `<dir>/<label>.jsonl` after a drive (evidence for reviewers); off when unset. */
function keepEvidence(label: string | undefined, capture: string, timing: string): void {
  const dir = process.env['JEVCODE_PERF_KEEP'];
  if (dir === undefined || dir === '' || label === undefined) return;
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(capture, join(dir, `${label}.cap`));
    copyFileSync(timing, join(dir, `${label}.jsonl`));
  } catch {
    /* evidence only */
  }
}

export interface DriveResult {
  /** the child's exit code as propagated by the driver (124 = an expect step timed out; 128+n = signal) */
  code: number | null;
  capture: string;
  timing: TimingStep[];
  timedOut: boolean;
  /** the driver's own stderr */
  stderr: string;
  /** wall time of the whole drive */
  wallMs: number;
}

/**
 * The hermetic environment of every perf drive: a minimal env (never the parent's — no key variable, no `JEVCODE_CONFIG`,
 * no `CI`), `HOME` and `XDG_CONFIG_HOME` inside the scenario's temp dir so neither the XDG file nor the legacy
 * `$HOME/.config/jevcode/config.json` of the developer's saved login can reach the child (`src/config/resolve.ts`
 * candidates `[cwd/jevcode.json, xdgFile, legacyFile]`), and the extra-`.env` setting at a directory that does not
 * exist (it defaults to a sibling directory of the package root, which may hold keys). A scenario's
 * own `env` is layered on top (`JEVCODE_HOME`, the mock knobs; `XDG_CONFIG_HOME` when it wants its own).
 * `test/unit/perf/hermetic.test.ts` spawns `jevcode config` under this env with a legacy credentials file in the
 * parent's HOME and asserts that no `file:` source appears.
 */
export function baseEnv(opts: { env?: Readonly<Record<string, string>>; rows: number; columns: number }, dir: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    TERM: 'xterm-256color',
    OPEN_ASSIST_PATH: join(dir, 'no-extra-env'),
    ...opts.env,
    PTY_ROWS: String(opts.rows),
    PTY_COLS: String(opts.columns),
  };
}

/**
 * Run a driver with the scenario's temp dir as the child's cwd: `./.env` is a dotenv layer read from the process cwd
 * (src/config/resolve.ts), so a driver inheriting `jevcode perf`'s cwd — the repository root — would hand every keyless
 * scenario the repository's keys. Every path the drivers and the child use is absolute.
 */
function runDriver(driver: string, args: string[], env: Record<string, string>, wallMs: number, cwd: string): Promise<{ code: number | null; stderr: string; wallMs: number }> {
  const t0 = performance.now();
  return new Promise((resolveRun) => {
    const child = spawn(driver, args, { stdio: ['ignore', 'ignore', 'pipe'], env, cwd });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), wallMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolveRun({ code, stderr, wallMs: performance.now() - t0 });
    });
  });
}

function readOr(file: string, encoding: BufferEncoding): string {
  try {
    return readFileSync(file, encoding);
  } catch {
    return '';
  }
}

/** A drive.exp `sleep` step: seconds with millisecond precision (the state scenarios only; the timing probes use the typist). */
export function sleepStep(ms: number): string {
  return `sleep ${(ms / 1000).toFixed(3)}`;
}

/** Run drive.exp once; the steps, capture and timing files live in a fresh temp dir that is removed afterwards. */
export async function drive(opts: DriveOptions): Promise<DriveResult> {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-drive-'));
  const stepsFile = join(dir, 'steps.txt');
  const capture = join(dir, 'capture.log');
  const timing = join(dir, 'timing.jsonl');
  writeFileSync(stepsFile, `${opts.steps.join('\n')}\n`);
  try {
    const r = await runDriver(join(opts.root, 'scripts/pty/drive.exp'), ['--kill-on-timeout', stepsFile, capture, timing, String(opts.timeoutS ?? 60), '--', ...opts.command], baseEnv(opts, dir), opts.wallMs ?? 240_000, dir);
    const cap = readOr(capture, 'utf8');
    const { steps } = parseTiming(readOr(timing, 'utf8'));
    keepEvidence(opts.label, capture, timing);
    return { code: r.code, capture: cap, timing: steps, timedOut: r.code === 124 || steps.some((s) => s.op === 'timeout'), stderr: r.stderr, wallMs: r.wallMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// pty_type.py
// ---------------------------------------------------------------------------------------

export type TypistStep =
  | { op: 'expect'; pattern: string; timeoutMs?: number }
  | { op: 'send'; text: string }
  | { op: 'sleep'; ms: number }
  | { op: 'resize'; rows: number; columns: number }
  | { op: 'mark'; label: string }
  | { op: 'eof'; timeoutMs?: number };

export interface TypistOptions {
  root: string;
  rows: number;
  columns: number;
  steps: readonly TypistStep[];
  command: readonly string[];
  env?: Readonly<Record<string, string>>;
  wallMs?: number;
  /** see `DriveOptions.label` */
  label?: string;
}

export interface TypistResult extends DriveResult {
  /** every read from the master with its arrival time and byte offset */
  chunks: Chunk[];
}

/** Run the Python typist once; the capture comes back latin1-decoded (string index = byte offset). */
export async function typist(opts: TypistOptions): Promise<TypistResult> {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-typist-'));
  const stepsFile = join(dir, 'steps.json');
  const capture = join(dir, 'capture.bin');
  const timing = join(dir, 'timing.jsonl');
  writeFileSync(stepsFile, JSON.stringify(opts.steps));
  try {
    const r = await runDriver('/usr/bin/python3', [join(opts.root, 'perf/drivers/pty_type.py'), stepsFile, capture, timing, '--', ...opts.command], baseEnv(opts, dir), opts.wallMs ?? 240_000, dir);
    const cap = readOr(capture, 'latin1');
    const { steps, chunks } = parseTiming(readOr(timing, 'utf8'));
    keepEvidence(opts.label, capture, timing);
    return { code: r.code, capture: cap, timing: steps, chunks, timedOut: r.code === 124 || steps.some((s) => s.op === 'timeout'), stderr: r.stderr, wallMs: r.wallMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The arrival time of the chunk holding byte `offset` (null before the first chunk or past the last). */
export function chunkTimeAt(chunks: readonly Chunk[], offset: number): number | null {
  let lo = 0;
  let hi = chunks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid]!.off <= offset) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const c = chunks[best]!;
  return offset < c.off + c.n ? c.t : null;
}

// ---------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------

export interface Frame {
  /** offset of the BSU in the capture */
  start: number;
  /** offset just past the ESU */
  end: number;
  /** bytes between the brackets */
  body: string;
  /** `ESC[2K` count at the start of the frame: Ink erases the previous frame's `output + '\n'` (`ink.js` `outputToRender`), so this is the previous dynamic height + 1 (0 for a cursor-only frame) */
  erased: number;
  /** the previous frame's dynamic region in rows (`erased − 1`; 0 when nothing was erased) */
  height: number;
}

/** Cut the capture into synchronized-output frames; `outside` is every byte not inside a bracket (prologue, epilogue, unbracketed writes). */
export function splitFrames(capture: string): { frames: Frame[]; outside: string } {
  const frames: Frame[] = [];
  let outside = '';
  let pos = 0;
  for (;;) {
    const s = capture.indexOf(BSU, pos);
    if (s < 0) {
      outside += capture.slice(pos);
      break;
    }
    outside += capture.slice(pos, s);
    const e = capture.indexOf(ESU, s + BSU.length);
    if (e < 0) {
      // an unterminated bracket (the child was killed mid-frame): keep it as a frame so its bytes are still inspected
      const body = capture.slice(s + BSU.length);
      const erased = (body.match(ERASE_LINE) ?? []).length;
      frames.push({ start: s, end: capture.length, body, erased, height: Math.max(0, erased - 1) });
      break;
    }
    const body = capture.slice(s + BSU.length, e);
    const erased = (body.match(ERASE_LINE) ?? []).length;
    frames.push({ start: s, end: e + ESU.length, body, erased, height: Math.max(0, erased - 1) });
    pos = e + ESU.length;
  }
  return { frames, outside };
}

/** Index of the first frame whose BSU lies at or after `offset` (-1 when none). */
export function frameAt(frames: readonly Frame[], offset: number): number {
  return frames.findIndex((f) => f.start >= offset);
}

/** The time the frame finished arriving: the chunk holding its last byte. */
export function frameTime(frame: Frame, chunks: readonly Chunk[]): number | null {
  return chunkTimeAt(chunks, frame.end - 1);
}

/**
 * The visible content of a frame: the bytes after the leading cursor-hide / return-to-bottom / erase prefix and
 * before the trailing cursor-move / cursor-show suffix. Two frames that repaint the same screen compare equal here
 * even when the previous height (the erase count) or the cursor row differs (§18 Ctrl+L: "the frame bytes after
 * Ctrl+L equal the frame before it").
 */
export function frameContent(body: string): string {
  const prefix = /^(?:\x1b\[\?25l|\x1b\[\d*[ABG]|\x1b\[2K)+/;
  const suffix = /(?:\x1b\[\d*[AG]|\x1b\[\?25[hl])+$/;
  return body.replace(prefix, '').replace(suffix, '');
}

/** CSI (with intermediates such as `ESC[0 q`), OSC, the two-byte ESC forms — ASCII only, so it works on utf8 and latin1 captures alike. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * The visible rows of a frame as a terminal lays them out: ANSI stripped, one row per `\n` (the pty's `onlcr` turns
 * Ink's `\n` into `\r\n`; a row whose text itself ends in `\r` arrives as `\r\r\n`, still one line break — a bare
 * `\r` returns to column 0 and does not open a row), trailing carriage returns dropped, trailing empty rows dropped.
 * A cursor-only frame has none.
 */
export function frameRows(body: string): string[] {
  const rows = stripAnsi(body)
    .split('\n')
    .map((r) => r.replace(/\r+$/, ''));
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** the console's bottom edge (`╰…╯`, TUI-DESIGN-2 §4.3), its side (`│`) and divider (`├`) glyphs in utf8, latin1 and `--ascii` (`+`, `|`) */
const BOX_BOTTOM_RE = /^(?:╰|\u00e2\u0095\u00b0|\+-)/;
const BOX_SIDE_RE = /^(?:│|\u00e2\u0094\u0082|\|)/;
const BOX_DIVIDER_RE = /^(?:├|\u00e2\u0094\u009c|\+-)/;
const BOX_SIDE_LEFT_RE = /^(?:│|\u00e2\u0094\u0082|\|) ?/;
const BOX_SIDE_RIGHT_RE = / ?(?:│|\u00e2\u0094\u0082|\|)$/;

/**
 * The composer's last row. Flat tier (TUI-DESIGN §2.1): the row directly above the status line (`… composer · status`
 * is the bottom of every frame at rows ≥ 3; toasts render inside the status line). Boxed tier (TUI-DESIGN-2 §4.3): the
 * console ends `composer rows · divider ├─┤ · status │…│ · bottom edge ╰─╯`, so the composer's last row is the fourth
 * row from the bottom, returned without its `│ ` / ` │` edges and right padding — its text ends with the last key
 * typed, as in the flat tier. Null for a frame with too few rows.
 */
export function composerRow(body: string): string | null {
  const rows = frameRows(body);
  const n = rows.length;
  if (n >= 4 && BOX_BOTTOM_RE.test(rows[n - 1]!) && BOX_SIDE_RE.test(rows[n - 2]!) && BOX_DIVIDER_RE.test(rows[n - 3]!) && BOX_SIDE_RE.test(rows[n - 4]!)) {
    return rows[n - 4]!.replace(BOX_SIDE_RIGHT_RE, '').replace(BOX_SIDE_LEFT_RE, '').trimEnd();
  }
  return n >= 2 ? rows[n - 2]! : null;
}

/** true when the frame's dynamic rows are drawn in the boxed tier (a console bottom edge closes the frame, TUI-DESIGN-2 §4.1) */
export function isBoxedFrame(body: string): boolean {
  const rows = frameRows(body);
  const n = rows.length;
  return n >= 4 && BOX_BOTTOM_RE.test(rows[n - 1]!) && BOX_SIDE_RE.test(rows[n - 2]!) && BOX_DIVIDER_RE.test(rows[n - 3]!);
}

/** wordmark cells in a frame (`█`, TUI-DESIGN-2 §5.1; `#` letters under --ascii are not counted — the sweep head `#+.` would alias them) — utf8 or latin1 */
export function wordmarkCells(body: string): number {
  return (body.match(/█|\u00e2\u0096\u0088/g) ?? []).length;
}

/** The rule row opens the dynamic region: `────…` idle, `─── decisions s7 · …` with the pane, `---` under --ascii; `─` is `â\u0094\u0080` in a latin1 capture. */
const RULE_ROW_RE = /^(?:─{3}|-{3}|(?:\u00e2\u0094\u0080){3})(?:[ ─-]|\u00e2|$)/;

/**
 * The dynamic rows a frame painted: from its last rule row to its last row (`test/pty/helpers.ts` `units()` uses the
 * same definition). Null when the frame draws no rule row (a cursor-only frame). Unlike `Frame.height` this reads the
 * frame itself, so a clear-terminal frame (erase count 0) and a stale, taller tree painted after a shrink are measured.
 */
export function paintedRows(body: string): number | null {
  const rows = frameRows(body);
  for (let i = rows.length - 1; i >= 0; i--) if (RULE_ROW_RE.test(rows[i]!)) return rows.length - i;
  return null;
}

/**
 * TUI-DESIGN-4 §11 (new gate row "no frame taller than the terminal"): every frame whose painted dynamic region
 * exceeds `rows`, as `{ index, painted }`. The **first frame after a resize** is skipped (`skipAfterResize`): the
 * driver's two SIGWINCHes land between Ink's measure and its paint, so exactly one settling frame at the old
 * geometry is expected and is not a defect (§2.0 consequence (d)).
 *
 * `limit` is `rows` in the classic renderer; the fullscreen renderer's post-condition is equality, which the
 * caller checks with `paintedRows(frame) === rows` per frame.
 */
export function framesTallerThan(frames: readonly Frame[], rows: number, opts: { from?: number; skip?: readonly number[] } = {}): { index: number; painted: number }[] {
  const skip = new Set(opts.skip ?? []);
  const out: { index: number; painted: number }[] = [];
  for (let i = opts.from ?? 0; i < frames.length; i++) {
    if (skip.has(i)) continue;
    const painted = paintedRows(frames[i]!.body);
    if (painted !== null && painted > rows) out.push({ index: i, painted });
  }
  return out;
}

/** The tallest dynamic region painted by `frames[from..]` (0 when none paints a rule row). */
export function paintedMax(frames: readonly Frame[], from = 0): number {
  let max = 0;
  for (let i = from; i < frames.length; i++) max = Math.max(max, paintedRows(frames[i]!.body) ?? 0);
  return max;
}

/**
 * Rows of newly committed `<Static>` output inside a frame: the visible rows before the first rule row (`───…`, the
 * first dynamic row at every geometry ≥ 3 rows — the plain rule or the pane's tab header). 0 = a dynamic-only
 * repaint; -1 = no rule row at all (the first frame, whose header precedes the cursor hide). Ink renders a `<Static>`
 * change immediately and unthrottled (`reconciler.js` `isStaticDirty` → `onImmediateRender`), once when items are
 * appended and once more when the written children are removed, so under a fast run most frames are immediate ones.
 * Works on utf8 and latin1 captures alike (`─` is E2 94 80; both decodings keep those three code units adjacent).
 */
export function staticRows(body: string): number {
  const text = body.replace(/^(?:\x1b\[\?25l|\x1b\[\d*[ABG]|\x1b\[2K)+/, '');
  const rows = text.split('\r\n');
  const rule = /^(?:\x1b\[[0-9;]*m)*(?:─|\u00e2\u0094\u0080){3}/;
  for (let i = 0; i < rows.length; i++) if (rule.test(rows[i]!)) return i;
  return -1;
}

export interface FrameMix {
  /** frames carrying new Static rows */
  withStatic: number;
  /** dynamic-only repaints */
  dynamicOnly: number;
}

export function frameMix(frames: readonly Frame[]): FrameMix {
  let withStatic = 0;
  let dynamicOnly = 0;
  for (const f of frames) {
    if (staticRows(f.body) > 0) withStatic += 1;
    else dynamicOnly += 1;
  }
  return { withStatic, dynamicOnly };
}

/** The first dynamic frame: the first cursor-hide, the sentinel research 20 §3 recommends. */
export function firstDynamicFrameOffset(capture: string): number {
  const i = capture.indexOf('\x1b[?25l');
  return i < 0 ? 0 : i;
}

/** Clears (raw `CLEAR_RE` matches) from `offset` to the end of the capture. */
export function clearsAfter(capture: string, offset: number): number {
  return countClears(capture.slice(offset));
}

/** Count `\[step N\]` markers seen (a rough progress measure of a mocked run in a capture). */
export function maxStepSeen(capture: string): number {
  let max = 0;
  for (const m of capture.matchAll(/\[step (\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export interface CursorStats {
  /** the most `ESC[?25l` inside one bracket */
  hidesMaxPerFrame: number;
  /** frames whose bytes do not end with `ESC[?25h` — §18 "whenever the composer is active the frame ends with ESC[?25h", asserted per frame */
  framesWithoutShow: number;
  /** the last cursor-visibility byte of the capture is a show */
  shownAtEnd: boolean;
}

/**
 * §18 "Cursor and hide/show", per frame: at most one `ESC[?25l` inside each bracket, every frame ends with a show
 * (`ESC[?25h`, Ink's `buildCursorSuffix` once `useCursor` has a position — gated where the composer is active
 * throughout a capture, reported where it is collapsed by a review), and the last cursor visibility byte of the whole
 * capture is a show — the terminal is left with a visible cursor.
 */
export function cursorStats(frames: readonly Frame[], capture: string): CursorStats {
  let max = 0;
  let withoutShow = 0;
  for (const f of frames) {
    max = Math.max(max, (f.body.match(/\x1b\[\?25l/g) ?? []).length);
    if (!f.body.endsWith('\x1b[?25h')) withoutShow += 1;
  }
  const lastHide = capture.lastIndexOf('\x1b[?25l');
  const lastShow = capture.lastIndexOf('\x1b[?25h');
  return { hidesMaxPerFrame: max, framesWithoutShow: withoutShow, shownAtEnd: lastShow > lastHide };
}

// ---------------------------------------------------------------------------------------
// Keystroke → frame latency and frame rate (typist captures)
// ---------------------------------------------------------------------------------------

export interface KeyLatency {
  /** the typist step number of the `send` */
  step: number;
  key: string;
  sentAt: number;
  /** capture byte offset at the send */
  sentOff: number;
  frameIndex: number;
  frameAt: number;
  ms: number;
}

/**
 * Decides whether `frame` is the one a keystroke produced. `before` is the last frame completed before the key was
 * sent (null when none) — the screen the key acted on.
 */
export type KeyFrameMatcher = (frame: Frame, key: string, before: Frame | null) => boolean;

/** The composer's last row ends with the key (typing into an active composer). */
export const composerEndsWithKey: KeyFrameMatcher = (frame, key) => composerRow(frame.body)?.endsWith(key) ?? false;

/**
 * The frame paints a different number of dynamic rows than the screen the key acted on (a layout toggle such as the
 * review's `e`, which shows or hides the pane; the composer is collapsed then, so no row ends with the key).
 */
export const paintedRowsChanged: KeyFrameMatcher = (frame, _key, before) => {
  const now = paintedRows(frame.body);
  const was = before === null ? null : paintedRows(before.body);
  return now !== null && was !== null && now !== was;
};

/**
 * TUI-DESIGN-4 §4.2 / §11: the composer's row DIFFERS from the screen the key acted on. The palette's Enter cycle
 * REPLACES the draft with the selected command (`› /resume +36`), so no row can end with the key itself and
 * `composerEndsWithKey` never matches — but every press rewrites the row, which is exactly the frame to measure.
 */
export const composerRowChanged: KeyFrameMatcher = (frame, _key, before) => {
  const now = composerRow(frame.body);
  const was = before === null ? null : composerRow(before.body);
  return now !== null && was !== null && now !== was;
};

/**
 * For every measured `send` (its step number in `measured`), the first frame written at or after the send offset that
 * `matches` the key (default: the composer row ends with it), timestamped by the chunk that completed it. Frames are
 * consumed in order (a frame never answers two keys). Keys whose frame never arrived are left out (the caller compares
 * `samples` with the number of keys sent).
 */
export function keyLatencies(timing: readonly TimingStep[], frames: readonly Frame[], chunks: readonly Chunk[], measured: ReadonlySet<number>, matches: KeyFrameMatcher = composerEndsWithKey): KeyLatency[] {
  const out: KeyLatency[] = [];
  let cursor = 0;
  for (const s of timing) {
    if (s.op !== 'send' || !measured.has(s.step) || s.off === undefined) continue;
    const key = s.arg;
    let before: Frame | null = null;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i]!.end <= s.off) {
        before = frames[i]!;
        break;
      }
    }
    let found = -1;
    for (let i = cursor; i < frames.length; i++) {
      const f = frames[i]!;
      if (f.end <= s.off) continue;
      if (matches(f, key, before)) {
        found = i;
        break;
      }
    }
    if (found < 0) continue;
    const t = frameTime(frames[found]!, chunks);
    if (t === null) continue;
    cursor = found + 1;
    out.push({ step: s.step, key, sentAt: s.t, sentOff: s.off, frameIndex: found, frameAt: t, ms: Math.max(0, t - s.t) });
  }
  return out;
}

export interface LatencySummary {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  raw: number[];
}

export function summarise(values: readonly number[]): LatencySummary {
  return { samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null, raw: values.map((v) => Math.round(v * 10) / 10) };
}

export interface FpsSummary {
  /** the busiest one-second bucket (null when the window covers no whole second) */
  max: number | null;
  /** frames per covered second */
  mean: number | null;
  buckets: number[];
}

export const NO_FPS: FpsSummary = { max: null, mean: null, buckets: [] };

/**
 * Frames per second inside `[fromMs, toMs)`: frames are bucketed by the second of their arrival; only buckets fully
 * inside the window count. `max` is the busiest bucket, `mean` frames per covered second. `filter` sees the frame and
 * its index (so a per-frame classification computed once can be applied).
 */
export function framesPerSecond(frames: readonly Frame[], chunks: readonly Chunk[], fromMs: number, toMs: number, filter: (f: Frame, index: number) => boolean = () => true): FpsSummary {
  const firstBucket = Math.ceil(fromMs / 1000);
  const lastBucket = Math.floor(toMs / 1000) - 1;
  if (lastBucket < firstBucket) return { max: null, mean: null, buckets: [] };
  const counts = new Array<number>(lastBucket - firstBucket + 1).fill(0);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (!filter(f, i)) continue;
    const t = frameTime(f, chunks);
    if (t === null) continue;
    const b = Math.floor(t / 1000);
    if (b >= firstBucket && b <= lastBucket) counts[b - firstBucket]! += 1;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return { max: Math.max(...counts), mean: total / counts.length, buckets: counts };
}

// ---------------------------------------------------------------------------------------
// Frame classes (TUI-DESIGN §18 "Frame rate"): static / key / dynamic
// ---------------------------------------------------------------------------------------

/**
 * Why three classes. Ink 7.1.1 renders a commit that changed the `<Static>` subtree at once: `ink/build/reconciler.js`
 * `resetAfterCommit` sees `isStaticDirty` (set by `createInstance` / `commitUpdate` of the `internal_static` box) and
 * calls `onImmediateRender`, which the constructor binds to the raw `onRender` (`ink.js`: `this.rootNode.onImmediateRender
 * = this.onRender`), while every other commit goes through `throttle(this.onRender, renderThrottleMs, { leading: true,
 * trailing: true })` with `renderThrottleMs = Math.max(1, Math.ceil(1000 / maxFps))` — 34 ms at the default 30. So a
 * frame that carries new Static rows costs a frame per committed transcript item by design (`static`), a keystroke
 * renders on the throttle's leading edge and so follows the offered key rate (`key`: a frame within one throttle
 * period after a `send`), and only the rest (`dynamic`: spinner, clock, live flush, status-line and pane changes)
 * is what the `maxFps` throttle governs — the class the frame-rate gate applies to.
 */
export type FrameClass = 'static' | 'key' | 'dynamic';

export interface FrameClassCounts {
  static: number;
  key: number;
  dynamic: number;
}

/** Ink's render throttle period for `maxFps` (`ink.js`: `Math.max(1, Math.ceil(1000 / maxFps))`; 0 when unthrottled). */
export function throttleMs(maxFps: number): number {
  return maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
}

/** The times of every `send` step of a typist timing (keystrokes and pasted chunks alike), ascending. */
export function sendTimes(timing: readonly TimingStep[]): number[] {
  return timing
    .filter((s) => s.op === 'send')
    .map((s) => s.t)
    .sort((a, b) => a - b);
}

/** The latest of `sends` (ascending) at or before `t`; null when none. */
export function lastSendAtOrBefore(sends: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = sends.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sends[mid]! <= t) {
      best = sends[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Classify one frame: `static` when it carries new Static rows (`staticRows` > 0), else `key` when it arrived within
 * `throttle` ms after a send (`frameAtMs` is the arrival time; a frame with no chunk time can only be `dynamic`),
 * else `dynamic`. Static wins over key: an immediate Static render is one by design whatever the typist was doing.
 */
export function classifyFrame(frame: Frame, frameAtMs: number | null, sends: readonly number[], throttle: number): FrameClass {
  if (staticRows(frame.body) > 0) return 'static';
  if (frameAtMs !== null) {
    const s = lastSendAtOrBefore(sends, frameAtMs);
    if (s !== null && frameAtMs - s <= throttle) return 'key';
  }
  return 'dynamic';
}

/** One class per frame, aligned with `frames`. */
export function classifyFrames(frames: readonly Frame[], chunks: readonly Chunk[], sends: readonly number[], throttle: number): FrameClass[] {
  return frames.map((f) => classifyFrame(f, frameTime(f, chunks), sends, throttle));
}

export function classCounts(classes: readonly FrameClass[]): FrameClassCounts {
  const out: FrameClassCounts = { static: 0, key: 0, dynamic: 0 };
  for (const c of classes) out[c] += 1;
  return out;
}

export interface FpsByClass {
  all: FpsSummary;
  static: FpsSummary;
  key: FpsSummary;
  dynamic: FpsSummary;
}

/** `framesPerSecond` for every class over the same window (`classes` aligned with `frames`, from `classifyFrames`). */
export function framesPerSecondByClass(frames: readonly Frame[], chunks: readonly Chunk[], classes: readonly FrameClass[], fromMs: number, toMs: number): FpsByClass {
  const by = (c: FrameClass): FpsSummary => framesPerSecond(frames, chunks, fromMs, toMs, (_f, i) => classes[i] === c);
  return { all: framesPerSecond(frames, chunks, fromMs, toMs), static: by('static'), key: by('key'), dynamic: by('dynamic') };
}

/** `send X` for a measured keystroke followed by an exact pause: the send-to-send spacing is `pauseMs` (the typist keeps draining meanwhile). */
export function keystrokeSteps(key: string, pauseMs: number): TypistStep[] {
  return [
    { op: 'send', text: key },
    { op: 'sleep', ms: pauseMs },
  ];
}

/** Decode drive.exp's `send` escapes (`\r`, `\n`, `\t`, `\xHH`, `\\`) into the bytes a terminal would deliver. */
export function decodeSendText(text: string): string {
  return text.replace(/\\(x[0-9A-Fa-f]{2}|[rnt\\])/g, (_m, esc: string) => {
    if (esc.startsWith('x')) return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
    return esc === 'r' ? '\r' : esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
  });
}

/**
 * Translate drive.exp step lines (`expect <re>`, `send <text>`, `sleep <s>`, `resize <rows> <cols>`, `mark <label>`,
 * `eof`) into typist steps, so one scenario table can run under either driver. Regex syntax is shared for the patterns
 * the probes use (`\x1b\[\?25l`, `\S+`, `\d+`, `[a-z_]+`, `\r\n`): Tcl ARE and Python `re` read them alike.
 * Unknown lines throw — a scenario typo must not become a silent no-op.
 */
export function toTypistSteps(lines: readonly string[], timeoutMs: number): TypistStep[] {
  const out: TypistStep[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const op = sp < 0 ? line : line.slice(0, sp);
    const arg = sp < 0 ? '' : line.slice(sp + 1);
    if (op === 'expect') out.push({ op: 'expect', pattern: arg, timeoutMs });
    else if (op === 'send') out.push({ op: 'send', text: decodeSendText(arg) });
    else if (op === 'sleep') out.push({ op: 'sleep', ms: Math.round(Number(arg) * 1000) });
    else if (op === 'resize') {
      const [r, c] = arg.split(/\s+/).map(Number);
      if (r === undefined || c === undefined || !Number.isFinite(r) || !Number.isFinite(c)) throw new Error(`toTypistSteps: bad resize "${raw}"`);
      out.push({ op: 'resize', rows: r, columns: c });
    } else if (op === 'mark') out.push({ op: 'mark', label: arg });
    else if (op === 'eof') out.push({ op: 'eof', timeoutMs });
    else throw new Error(`toTypistSteps: unknown step "${raw}"`);
  }
  return out;
}

/**
 * The transcript's end item: `finished · <reason> · <n> steps` in either glyph set (TUI-DESIGN-4 §3.6 G1 rewrote
 * `end <reason> steps=…`; §3.7 moves this constant **in the same commit**). Imported, never re-spelt.
 */
export const END_PATTERN = RUN_END_PATTERN;
/** an SGR run between two visible spans — Tcl ARE (drive.exp) and Python bytes regex (the typist) read it alike */
export const SGR_GAP = '(?:\\x1b\\[[0-9;]*m)*';
/**
 * TUI-DESIGN-2 §4.5: every transcript label is its own dim span **and so is the text after it** —
 * `ESC[2m[run]ESC[22m ESC[…mstarted …` — so a sentinel spanning label and text carries **two** gaps, one on each
 * side of the space, exactly as `test/pty/helpers.ts`'s `labelStep` has always written it.
 *
 * MEASURED 2026-09-22 (integrator): with one gap this pattern matched nothing on a real capture, and because it
 * is the `RUN_STARTED` step of every perf scenario that needs a live run, `composer live`, `composer live-stress`,
 * `composer review` and the `states` scenarios `fault-pane`, `fault-live`, `resize`, `resize-live` and
 * `review 12x60` all timed out at exit 124 with `0/200 keys located` — the run they were measuring had started
 * fine, 20 s earlier. §3.7's G1 migration moved the constant and dropped the second gap with it.
 */
export const RUN_STARTED_PATTERN = `\\[run\\]${SGR_GAP} ${SGR_GAP}${RUN_STARTED_TAIL_PATTERN}`;

// ---------------------------------------------------------------------------------------
// Glyph-agnostic named anchors (TUI-DESIGN-4 §11, D-V ratification)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN-4 §11 / D-V: every window this harness measures is delimited by a **named** anchor, not by a literal
 * typed into a `.steps` file. Two properties are gated:
 *
 *  1. **glyph-agnostic** — the same anchor must match the unicode and the `--ascii` rendering of the same row, so a
 *     `--ascii` capture measures the same window (`anchorSelfTest` runs both glyph sets);
 *  2. **zero match is a hard failure** — A3's risk R2 is that a stale anchor silently turns the render-lag window
 *     into the whole capture and the gate into a lie. `locateAnchor` throws rather than returning -1.
 *
 * `src/perf/pty.ts:END_PATTERN` and `:RUN_STARTED_PATTERN` (the two constants D-V moves, §3.7 G1) are registered
 * here so the self-test covers them; §9.3 W4 adds the rest of §3.7's inventory in the same commit as the rewrite.
 */
export interface NamedAnchor {
  /** the name a scenario or a probe refers to */
  readonly name: string;
  /** the pattern, as a source string shared with `drive.exp` (Tcl ARE) and the Python typist */
  readonly pattern: string;
  /** rows that must match — one per glyph set (unicode, ascii) */
  readonly samples: readonly string[];
  /** rows that must NOT match (the near misses a stale anchor would swallow) */
  readonly negatives?: readonly string[];
}

/** TUI-DESIGN-4 §11: the registry. One row per window this harness measures. */
export const NAMED_ANCHORS: readonly NamedAnchor[] = [
  {
    name: 'run-started',
    pattern: RUN_STARTED_PATTERN,
    // one sample per glyph set (TUI-DESIGN-4 §11: a two-glyph-set self-test, or `--ascii` measures a different
    // window) PLUS the byte shape a real frame actually writes — the label is its own dim span and the text after
    // it opens another, so the space sits BETWEEN two SGR runs. Neither sample below had that shape, which is how
    // an anchor with one gap passed its own self-test and matched nothing on a capture (measured 2026-09-22).
    samples: [
      '[run] started \u00b7 jev+llm \u00b7 fix the failing test',
      '\x1b[2m[run]\x1b[22m started - jev+llm - fix the failing test',
      '\x1b[2m[run]\x1b[22m \x1b[2mstarted \u00b7 jev+llm \u00b7 fix the failing test\x1b[22m',
      '\x1b[2m[run]\x1b[22m \x1b[2mstarted - jev+llm - fix the failing test\x1b[22m',
    ],
    negatives: ['[run] ready', '[step 1] started', '[run] start 20260922-000000-aaaaaaaa'],
  },
  {
    name: 'run-end',
    pattern: END_PATTERN,
    samples: [
      '[run] finished \u00b7 complete \u00b7 12 steps \u00b7 4.9s',
      '\x1b[2m[run]\x1b[22m finished - max_replans - 3 steps - 1.0s',
      // TUI-DESIGN-4 §3.6 review item 5: an ERRORED run. The error clause is the LAST segment, after `exit <n>`,
      // precisely so the anchor still matches — an anchor that misses the runs that end badly is the one that
      // turns a measurement into a crash (`locateAnchor` throws on zero matches).
      '[run] finished \u00b7 error \u00b7 3 steps \u00b7 1.0s \u00b7 $0.00 (generator $0.00 \u00b7 jev $0.00) \u00b7 exit 5 \u00b7 jev_http: 500 from the decider',
      '[run] finished - error - 3 steps - 1.0s - $0.00 (generator $0.00 - jev $0.00) - exit 5 - jev_http: 500 from the decider',
      // the real byte shape: the label's span closes, the text's opens (this anchor never spans the two, but the
      // sample is here so the registry's shapes and a capture's cannot drift again)
      '\x1b[2m[run]\x1b[22m \x1b[2mfinished \u00b7 complete \u00b7 12 steps \u00b7 4.9s\x1b[22m',
    ],
    negatives: ['[run] finished', '12 steps', '[run] end complete steps=12'],
  },
];

/**
 * TUI-DESIGN-4 §11 (integrator 2026-09-22): the self-test also compiles every pattern the way the **typist**
 * does — a Python-style BYTES match — because that is the engine that reads a real capture and the one where a
 * bracket class over a multi-byte glyph silently stops matching. `Buffer` + a `latin1` view is the same test:
 * a pattern that only matches when the subject is decoded is exactly the defect.
 */
export function anchorBytesOk(a: NamedAnchor): boolean {
  // the `latin1` round trip makes each UTF-8 byte one code unit, so a JS RegExp sees the subject byte-wise —
  // the same way `re.compile(pattern.encode()).search(bytes)` does in `perf/drivers/pty_type.py`
  const bytes = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
  const re = new RegExp(bytes(a.pattern), 's');
  return a.samples.every((sample) => re.test(bytes(sample))) && (a.negatives ?? []).every((n) => !re.test(bytes(n)));
}

/** TUI-DESIGN-4 §11: the anchor with this name, or a throw naming the registry (a typo is never a silent skip). */
export function namedAnchor(name: string): NamedAnchor {
  const a = NAMED_ANCHORS.find((x) => x.name === name);
  if (a === undefined) throw new Error(`unknown perf anchor "${name}"; known: ${NAMED_ANCHORS.map((x) => x.name).join(', ')}`);
  return a;
}

/**
 * TUI-DESIGN-4 §11: the two-glyph-set self-test. Every registered anchor must match **every** sample and **no**
 * negative; the caller runs this before any gate reads a window, exactly as `clearReSelfTest` is run today.
 */
export function anchorSelfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const a of NAMED_ANCHORS) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern);
    } catch (e) {
      failures.push(`${a.name}: not a regex (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    for (const s of a.samples) if (!re.test(s)) failures.push(`${a.name}: no match in sample ${JSON.stringify(s)}`);
    for (const s of a.negatives ?? []) if (re.test(s)) failures.push(`${a.name}: matched the negative ${JSON.stringify(s)}`);
    // …and the same patterns compiled BYTE-wise, the way the typist reads a real capture (integrator 2026-09-22)
    if (!anchorBytesOk(a)) failures.push(`${a.name}: the pattern does not hold byte-wise — a multi-byte glyph inside a bracket class is one byte to \`perf/drivers/pty_type.py\``);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * TUI-DESIGN-4 §11: the offset of a named anchor in a capture. **Zero matches is a hard failure** — the window
 * would otherwise silently become the whole capture (A3 risk R2). `occurrence` is 1-based.
 */
export function locateAnchor(capture: string, name: string, occurrence = 1): number {
  const a = namedAnchor(name);
  const re = new RegExp(a.pattern, 'g');
  let seen = 0;
  for (let m = re.exec(capture); m !== null; m = re.exec(capture)) {
    seen += 1;
    if (seen === occurrence) return m.index;
  }
  throw new Error(`perf anchor "${name}" (/${a.pattern}/) matched ${seen} time(s) in the capture; occurrence ${occurrence} is required — the measured window would be wrong`);
}

/** the console's top edge with a badge or a card's title edge (`╭─ <title>`, TUI-DESIGN-2 §4.3 / §4.7): the title's colour span is skipped */
export function topEdgePattern(title: string): string {
  return `╭─ ${SGR_GAP}${title}`;
}
