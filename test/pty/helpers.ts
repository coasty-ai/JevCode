/**
 * Helpers of the `pty` vitest project (TUI-DESIGN §19.5, §19.8; research 20). Every scenario drives the built CLI
 * (a per-run copy of `bin/jevcode.js` + `dist/jevcode.mjs` made by global-setup.ts, so a rebuild of the shared `dist/`
 * by another process mid-suite cannot tear a scenario) inside a real pseudo-TTY through `scripts/pty/drive.exp`,
 * spawned with `stdio: 'ignore'` (research 20 §4: expect needs no controlling tty), a fresh `JEVCODE_HOME` and
 * workspace, the requested `PTY_ROWS`/`PTY_COLS`, and `CI`/`CONTINUOUS_INTEGRATION`/colour/SSH hooks removed from the
 * child's environment. The capture is parsed into Ink write units (research 20 §3: the cursor-hide `ESC[?25l` opens
 * every frame; a clear-terminal frame opens with `ESC[2J`), each unit yielding its `ESC[2J` count, its static rows
 * (above the rule row), the dynamic-region row count (last rule row → last row) and the rule width, so the standing
 * rules — zero clears per geometry segment, region ≤ rows − 2 — are asserted per frame rather than per run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODE, MODE_BADGE_WORD } from '../../src/config/defaults.js';
// TUI-DESIGN-4 §3.7 (the R2 guard): the run-frame anchors are imported by name from the ONE formatter, never
// hard-coded here — a literal `·` stops matching in every `--ascii` capture (`glyphs.ts` renders `dot: '-'`).
import { GLYPH_DOT_CLASS, RUN_FINISHED_WORD, RUN_STARTED_WORD } from '../../src/tui/plain.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXPECT_BIN = '/usr/bin/expect';
export const DRIVER = join(ROOT, 'scripts', 'pty', 'drive.exp');
/** the repository launcher; scenarios run the per-run copy named by `JEVCODE_PTY_BIN` (see `binPath`) */
export const BIN = join(ROOT, 'bin', 'jevcode.js');
export const DIST = join(ROOT, 'dist', 'jevcode.mjs');
/** `skipIf(!hasExpect)` on every pty test (§19.5): expect(1) alone decides; a missing driver script is an error (global-setup.ts) */
export const hasExpect = existsSync(EXPECT_BIN);
/** artefacts (steps, capture, timing) of the last run of every scenario, kept for inspection */
export const ARTEFACTS = join(tmpdir(), 'jevcode-pty');
/** the env var through which global-setup.ts hands the per-run launcher copy to the test workers */
export const PTY_BIN_ENV = 'JEVCODE_PTY_BIN';

/** the launcher every scenario spawns: the per-run copy made by global-setup.ts (`<tmp>/bin/jevcode.js` next to its `dist/`) */
export function binPath(): string {
  const p = process.env[PTY_BIN_ENV];
  if (p === undefined || p === '') throw new Error(`pty: ${PTY_BIN_ENV} is not set — test/pty/global-setup.ts did not run (is the 'pty' vitest project configured?)`);
  return p;
}

export const CURSOR_HIDE = '\x1b[?25l';
export const ERASE_SCREEN = '\x1b[2J';
export const ERASE_LINE = '\x1b[2K';
/** the cursor-shape reset of the exit string (`RESTORE` in cli/fatal.ts): everything after it is post-exit output */
export const CURSOR_SHAPE_RESET = '\x1b[0 q';

/** a Tcl regex fragment that skips SGR sequences between two visible runs (the live composer's yellow `> `) */
export const SGR_GAP = '(?:\\x1b\\[[0-9;]*m)*';
/**
 * TUI-DESIGN-2 §4.5 / §4.9: every transcript label is its own dim span (`ESC[2m[step 2]ESC[22m read …`,
 * `ESC[2m[you]ESC[22m ESC[38;5;147mhi`), the badge in the console's top edge is an accent span after `╭─ `, so a sentinel
 * that spans a label and its text (or the edge and the badge) needs an SGR gap at the boundary — `labelStep` and
 * `topEdgeStep` build them; the round-1 `\[run\] start` no longer matches the raw bytes.
 */
export function labelStep(label: string, text: string): string {
  return `expect \\[${label}\\]${SGR_GAP} ${SGR_GAP}${text}`;
}
/** the console's top edge with this badge or title (`╭─ <badge>`, TUI-DESIGN-2 §4.3), the badge's colour span skipped */
export function topEdgeStep(badgeOrTitle: string): string {
  return `expect ╭─ ${SGR_GAP}${badgeOrTitle}`;
}
/**
 * the first-frame sentinel of research 20 §3: `expect \x1b\[\?25l`. Two rules every scenario keeps: expect consumes
 * its buffer up to each match, so a row drawn *before* a matched row in the same frame (the panel strip above the
 * console's placeholder) must be expected first; and the driver's `sleep` drains the pty into the capture, so a frame
 * that arrived during a sleep can never be matched by a later expect — expect first, then sleep.
 */
export const FIRST_FRAME_STEP = 'expect \\x1b\\[\\?25l';
/**
 * The composer prompt as a Tcl regex fragment: `› ` in the Unicode glyph set, `> ` under `--ascii` and in `--plain`
 * (TUI-DESIGN-2 §4.4 `PROMPT_UNICODE` / `PROMPT_ASCII`); the flat tier draws it at column 0, the boxed tier inside the
 * console row `│ › …`. Scenarios expect the prompt-agnostic form so a glyph change never re-times a scenario.
 */
export const PROMPT = '(?:›|>)';
/**
 * `expect <prompt> <text>`: the composer echo of `text` (regex metacharacters escaped) in either tier and glyph set. TUI-DESIGN-3 §2.6 /
 * D-O: the idle prompt is its own `accent` span, so an SGR reset sits between `› ` and the body — the gap is skipped here (forgetting
 * it fails every echo at once).
 */
export function echoStep(text: string): string {
  return `expect ${PROMPT} ${SGR_GAP}${text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}`;
}
/** the composer placeholders of TUI-DESIGN-2 §4.4 (the leading words, enough to be unique in a frame) */
export const PLACEHOLDER_TASK = 'Say hi';
export const PLACEHOLDER_FOLLOWUP = 'Follow-up, question';
export const PLACEHOLDER_STEER = 'Type to steer the next step';
/** the mode badge words of TUI-DESIGN-2 §1.5 as they appear in the console's top edge (boxed) or the status left zone (flat) */
export const BADGE_JEV_ONLY = 'jev-only';
export const BADGE_JEV_LLM = 'jev\\+llm';
/** TUI-DESIGN-3 §1.10: the default mode's badge word as a Tcl regex fragment — read from the one table, so a later flip moves nothing here */
export const BADGE_DEFAULT = MODE_BADGE_WORD[DEFAULT_MODE].replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
/** the default mode's badge word as plain text (for `toContain` / `startsWith` checks on stripped captures) */
export const BADGE_DEFAULT_TEXT = MODE_BADGE_WORD[DEFAULT_MODE];
/**
 * The first WORD of the default badge, escaped — `llm\+jev` for `llm+jev · verified`. Since the round-3
 * `DEFAULT_MODE` flip the badge carries a ` · verified` suffix, so an item that names it (`Mode: <badge> — …`)
 * wraps between the two at 80 columns and no `expect` can ever see the whole badge on one line. Scenario steps
 * anchor on this head; the suffix, where it matters, is asserted separately on the stripped capture.
 */
export const BADGE_DEFAULT_HEAD = BADGE_DEFAULT.split(' ')[0] ?? BADGE_DEFAULT;
export { DEFAULT_MODE };
/**
 * A settle pattern for a geometry: one row of exactly `cols` visible cells between two line breaks, SGR sequences
 * skipped. Every full-width row (the rule / brand row, the console edges and status compartment, the flat status row)
 * is padded to the terminal width by its `lines()` function, so a match means a frame laid out for that width was
 * written after the previous marker's echo (expect consumes its buffer up to each match). The brand row of
 * TUI-DESIGN-2 §5.4 carries `◆ jevcode` in the accent colour, so a pattern on one dim run (the round-1 `RULE_60`) no
 * longer matches it.
 */
export function fullWidthRowStep(cols: number): string {
  return `expect \\r\\n(?:(?:\\x1b\\[[0-9;]*m)*[^\\x1b\\r\\n]){${cols}}(?:\\x1b\\[[0-9;]*m)*\\r\\n`;
}

export interface TimingRecord {
  t: number;
  step: number;
  op: string;
  arg: string;
}

export interface Scenario {
  /** artefact directory name */
  name: string;
  /** jevcode argv after the binary (`--workspace` is appended by the wrapper) */
  args: readonly string[];
  /** driver steps, one per line (`expect | send | sleep | resize | signal | mark | eof`) */
  steps: readonly string[];
  rows?: number;
  cols?: number;
  /** extra environment for the child (e.g. `JEVCODE_MOCK_REVIEW_AT`, `NO_COLOR`) */
  env?: Readonly<Record<string, string>>;
  /** per-step expect timeout in seconds (default 30) */
  timeoutS?: number;
  /** files to create in the workspace before the spawn (relative path → contents) */
  files?: Readonly<Record<string, string>>;
  /** runs while the driver runs (e.g. a `ps` poll); its result lands on `Drive.during` */
  during?: (ctx: { workspace: string; home: string }) => Promise<unknown>;
  /** TUI-DESIGN-3 §1.8 edge 15: reuse an earlier scenario's HOME (its config.json) instead of a fresh one — the restart half of a two-run scenario */
  home?: string;
}

export interface Drive {
  /** the driver's exit code = the child's (128 + n for a signal death; 124 = an expect step timed out) */
  code: number;
  bytes: Buffer;
  /** the capture as UTF-8 (escape sequences included) */
  text: string;
  timing: TimingRecord[];
  /** `{"op":"timeout"}` records */
  timeouts: number;
  home: string;
  workspace: string;
  artefacts: string;
  during: unknown;
  /** `<home>/runs/<id>` directories, sorted */
  runDirs(): string[];
  /** the newest run's `transcript.log` lines (no trailing empty line), or null */
  transcript(): string[] | null;
  /** the newest run's `state.json` parsed, or null */
  state(): Record<string, unknown> | null;
}

const scratch: string[] = [];

/** register a temp dir for `cleanupScratch` (the pipe runs of twins.pty.test.ts) */
export function registerScratch(...dirs: string[]): void {
  scratch.push(...dirs);
}

/** remove the temp homes/workspaces of the scenarios run so far (call from `afterEach`) */
export function cleanupScratch(): void {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * The variables `childEnv` removes from the caller's environment: CI, colour, SSH and dev hooks, every key variable
 * (TUI-DESIGN-2 §1.1 / §8.2: the zero-argument and mode-switch scenarios depend on which keys exist; a developer's shell
 * must not decide), `JEVCODE_CONFIG` (a configured credentials file would be read before the XDG/legacy candidates,
 * `src/config/resolve.ts`) and the terminal multiplexer markers.
 */
export const CHILD_ENV_UNSET: readonly string[] = ['CI', 'CONTINUOUS_INTEGRATION', 'NO_COLOR', 'FORCE_COLOR', 'SSH_TTY', 'SSH_CONNECTION', 'JEVCODE_TRACE', 'JEVCODE_FAULT', 'JEVCODE_MOCK_REVIEW_AT', 'JEVCODE_AUTONOMY', 'JEVCODE_MOCK_INTAKE', 'JEVCODE_MOCK_JEV_MS', 'JEVCODE_HOME', 'JEVCODE_CONFIG', 'JEVCODE_ASSERT_NO_NETWORK', 'JEVCODE_MODE', 'JEV_PROVIDER', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'JEVCODE_API_KEY', 'JEVCODE_EXTRA_ENV_FILE', 'PTY_TERM', 'PTY_KILL_ON_TIMEOUT', 'PTY_AUTO_REVIEW', 'TERM_PROGRAM', 'TMUX', 'STY'];

/**
 * The child environment: the caller's env minus `CHILD_ENV_UNSET`, plus an isolated `HOME`, `JEVCODE_HOME` and XDG
 * config dir — hermetic against a developer's saved login: `resolveConfig` falls back to the legacy
 * `$HOME/.config/jevcode/config.json` when the XDG file is absent (`src/config/resolve.ts` candidates `[cwd/jevcode.json,
 * xdgFile, legacyFile]`), so `HOME` must point into the scenario's temp home too, not only `XDG_CONFIG_HOME`
 * (`test/unit/perf/hermetic.test.ts` spawns `jevcode config` under this env with a legacy credentials file in the
 * caller's HOME and asserts no `file:` source). `SSH_TTY`/`SSH_CONNECTION` are removed because `resolveLaunchSettings`
 * (src/config/launch.ts) drops the default fps to 15 on a slow link, which would change every frame count and arming
 * margin of the suite on an SSH session.
 */
export function childEnv(home: string, rows: number, cols: number, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CHILD_ENV_UNSET) delete env[k];
  env['HOME'] = home;
  env['JEVCODE_HOME'] = home;
  env['XDG_CONFIG_HOME'] = join(home, 'xdg');
  // `JEVCODE_EXTRA_ENV_FILE` names a second dotenv layer (src/config/resolve.ts). The variable may already be set in
  // the developer's shell at a file that holds keys, which would make a scenario keyless by accident, so it is
  // overwritten with a path that does not exist rather than merely unset
  env['JEVCODE_EXTRA_ENV_FILE'] = join(home, 'no-extra-env');
  env['PTY_ROWS'] = String(rows);
  env['PTY_COLS'] = String(cols);
  if (env['LANG'] === undefined || env['LANG'] === '') env['LANG'] = 'en_US.UTF-8';
  return { ...env, ...extra };
}

/** the wall-clock backstop of one scenario: the driver is killed, then any jevcode child it left on the pty */
const HARD_TIMEOUT_MS = 150_000;

/** Drive one scenario to completion; never throws on a non-zero exit (the test asserts the code). */
export async function drive(s: Scenario): Promise<Drive> {
  const rows = s.rows ?? 24;
  const cols = s.cols ?? 80;
  const home = s.home ?? mkdtempSync(join(tmpdir(), `jevcode-pty-home-`));
  const workspace = mkdtempSync(join(tmpdir(), `jevcode-pty-ws-`));
  scratch.push(...(s.home === undefined ? [home] : []), workspace);
  mkdirSync(join(home, 'xdg'), { recursive: true });
  for (const [rel, body] of Object.entries(s.files ?? {})) {
    const p = join(workspace, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const artefacts = join(ARTEFACTS, s.name);
  rmSync(artefacts, { recursive: true, force: true });
  mkdirSync(artefacts, { recursive: true });
  const stepsFile = join(artefacts, 'steps.txt');
  const capture = join(artefacts, 'capture.bin');
  const timingFile = join(artefacts, 'timing.jsonl');
  writeFileSync(stepsFile, `${s.steps.join('\n')}\n`);
  const argv = [DRIVER, '--kill-on-timeout', stepsFile, capture, timingFile, String(s.timeoutS ?? 30), '--', process.execPath, binPath(), ...s.args, '--workspace', workspace];
  const env = childEnv(home, rows, cols, s.env);
  const child = spawn(EXPECT_BIN, ['-f', ...argv], { cwd: workspace, env, stdio: 'ignore' });
  const exit = new Promise<number>((res) => {
    // SIGKILL to the driver skips its own --kill-on-timeout cleanup (drive.exp), so the jevcode grandchild on the pty is
    // killed here too; otherwise it would keep running (and holding the pty) after the scenario gave up
    const hard = setTimeout(() => {
      for (const p of jevcodeProcesses(workspace)) {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      child.kill('SIGKILL');
    }, HARD_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(hard);
      res(code ?? (signal ? 128 : 1));
    });
    child.on('error', () => {
      clearTimeout(hard);
      res(1);
    });
  });
  const during = s.during ? s.during({ workspace, home }) : Promise.resolve(undefined);
  const code = await exit;
  const duringResult = await during;
  const bytes = existsSync(capture) ? readFileSync(capture) : Buffer.alloc(0);
  const timing = existsSync(timingFile)
    ? readFileSync(timingFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as TimingRecord)
    : [];
  const runs = (): string[] => {
    const dir = join(home, 'runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .sort()
      .map((n) => join(dir, n));
  };
  return {
    code,
    bytes,
    text: bytes.toString('utf8'),
    timing,
    timeouts: timing.filter((r) => r.op === 'timeout').length,
    home,
    workspace,
    artefacts,
    during: duringResult,
    runDirs: runs,
    transcript() {
      const last = runs().at(-1);
      if (last === undefined) return null;
      const p = join(last, 'transcript.log');
      if (!existsSync(p)) return null;
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines;
    },
    state() {
      const last = runs().at(-1);
      if (last === undefined) return null;
      const p = join(last, 'state.json');
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    },
  };
}

// ---------------------------------------------------------------------------------------
// capture parsing
// ---------------------------------------------------------------------------------------

// CSI (with intermediates such as the `ESC[0 q` cursor shape), OSC, and the two-byte ESC forms
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;
const SGR_RE = /\x1b\[([0-9;]*)m/g;
// the rule row opens the dynamic region: `────…` idle, `─── decisions s7 · …` with the pane, `---` under --ascii
const RULE_RE = /^(?:─{3}|-{3})(?:[ ─-]|$)/;
// an item line of the three-way identity (§15.1): `stepLabel()` or a renderer label, then a space; TUI-DESIGN-2 §3.10
// adds the chat labels `[you]` / `[jevcode]` (one item per line); TUI-DESIGN-3 §5.1 rule 1 (D-L) right-aligns the label in a
// 10-cell gutter, so a label row may carry up to 9 leading spaces — `ungutter()` removes them before any identity comparison
const ITEM_RE = /^ {0,9}\[(?:run|step \d+|ui|setup|config|sandbox|you|jevcode)\] /;

/** TUI-DESIGN-3 §5.1 rule 1: a label row without its gutter padding (`    [run] start …` → `[run] start …`); other rows unchanged */
export function ungutter(row: string): string {
  return ITEM_RE.test(row) ? row.replace(/^ +/, '') : row;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** the capture from the first dynamic frame on (research 20 §3) */
export function afterFirstFrame(text: string): string {
  const i = text.indexOf(CURSOR_HIDE);
  return i < 0 ? text : text.slice(i);
}

/** `ESC[2J` occurrences (the smoke's clears gate; a clear-terminal frame is one `ESC[2J ESC[3J ESC[H`) */
export function countClears(text: string): number {
  return text.split(ERASE_SCREEN).length - 1;
}

/** alt-screen switches and RIS — never allowed (D13) */
export function countForbidden(text: string): number {
  return (text.match(/\x1b\[\?1049[hl]|\x1bc/g) ?? []).length;
}

/** SGR sequences; `ignoreReset` drops `ESC[0m` / `ESC[m` (the exit string's attribute reset, §14.2) */
export function countSgr(text: string, opts: { ignoreReset?: boolean } = {}): number {
  let n = 0;
  for (const m of text.matchAll(SGR_RE)) {
    const params = m[1] ?? '';
    if (opts.ignoreReset && (params === '' || params === '0')) continue;
    n += 1;
  }
  return n;
}

export interface FrameUnit {
  /** index in the unit list */
  index: number;
  raw: string;
  /** ANSI-stripped lines (trailing empty lines removed) */
  lines: string[];
  /** `ESC[2J` count inside this unit (a clear-terminal frame) */
  clears: number;
  /** `ESC[2K` count at the unit's start = the previous frame's rows + 1 (Ink's own accounting) */
  erased: number;
  /** index of the last rule row, or -1 */
  ruleIndex: number;
  /** rows of the dynamic region (rule row → last row), or null when the unit draws no frame */
  rows: number | null;
  /** visible width of the rule row (the geometry the App rendered for), or null */
  ruleWidth: number | null;
  /**
   * rows above the rule row: the `<Static>` items this unit committed (wrapped at the terminal width). In a
   * clear-terminal unit (`clears > 0`) Ink rewrites its whole `fullStaticOutput` first (ink.js: `clearTerminal +
   * fullStaticOutput + output`), so these rows then repeat every earlier item — `staticRows()` dedupes that.
   */
  staticRows: string[];
}

/**
 * Split a capture into Ink write units. A unit opens with the cursor hide (every frame, every cursor-only update)
 * or with `ESC[2J` (a clear-terminal frame, which Ink writes without a preceding hide). Text after the exit
 * string's cursor-shape reset (`ESC[0 q`) is dropped unless `untilRestore` is false.
 */
export function units(text: string, opts: { untilRestore?: boolean } = {}): FrameUnit[] {
  let t = text;
  if (opts.untilRestore !== false) {
    const first = t.indexOf(CURSOR_HIDE);
    const cut = first < 0 ? -1 : t.indexOf(CURSOR_SHAPE_RESET, first);
    if (cut >= 0) t = t.slice(0, cut);
  }
  const parts = t.split(/(?=\x1b\[\?25l|\x1b\[2J)/);
  const out: FrameUnit[] = [];
  parts.forEach((raw, index) => {
    const stripped = stripAnsi(raw).replace(/\r\n|\r/g, '\n');
    const lines = stripped.split('\n');
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    let ruleIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (RULE_RE.test(lines[i] ?? '')) {
        ruleIndex = i;
        break;
      }
    }
    const rule = ruleIndex >= 0 ? lines[ruleIndex] ?? '' : null;
    // the erase prefix (hide · return-to-bottom · eraseLines) is the run of escape sequences and control bytes
    // before the unit's first printable character
    const head = /^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x1f\x7f])*/.exec(raw)?.[0] ?? '';
    const erased = head.split(ERASE_LINE).length - 1;
    out.push({
      index,
      raw,
      lines,
      clears: countClears(raw),
      erased,
      ruleIndex,
      rows: ruleIndex >= 0 ? lines.length - ruleIndex : null,
      ruleWidth: rule === null ? null : [...rule].length,
      staticRows: ruleIndex >= 0 ? lines.slice(0, ruleIndex) : index === 0 ? lines : [],
    });
  });
  return out;
}

/** the units that draw a dynamic frame (a rule row), from the first frame on */
export function frames(text: string, opts: { untilRestore?: boolean } = {}): FrameUnit[] {
  return units(text, opts).filter((u) => u.rows !== null);
}

/** the synchronized-output brackets every frame is written inside (`ESC[?2026h` … `ESC[?2026l`; `src/perf/pty.ts` `BSU`/`ESU`) */
export const BSU = '\x1b[?2026h';

export interface SyncFrame {
  /** index in the frame list */
  index: number;
  /** ANSI-stripped lines (trailing empty lines removed) */
  lines: string[];
  /** index of the last rule row, or -1 when the frame draws none */
  ruleIndex: number;
  /** the dynamic region (rule row → last row); empty without a rule row */
  dynamic: string[];
}

/**
 * The capture split at the synchronized-output bracket (`BSU`) instead of the cursor hide: Ink writes `ESC[?25l` only
 * while the cursor is shown, so the frames drawn while it stays hidden — under a card or the intake row, where the
 * composer is collapsed — carry no hide and `units()` merges them into one unit. Every frame opens with a BSU (the
 * App's render wrapper), so this split is one frame per bracket. Text after the exit string's cursor-shape reset is
 * dropped like in `units()`.
 */
export function syncFrames(text: string): SyncFrame[] {
  let t = text;
  const first = t.indexOf(BSU);
  const cut = first < 0 ? -1 : t.indexOf(CURSOR_SHAPE_RESET, first);
  if (cut >= 0) t = t.slice(0, cut);
  const parts = t.split(BSU).slice(1);
  return parts.map((raw, index) => {
    const lines = stripAnsi(raw).replace(/\r\n|\r/g, '\n').split('\n');
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    let ruleIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (RULE_RE.test(lines[i] ?? '')) {
        ruleIndex = i;
        break;
      }
    }
    return { index, lines, ruleIndex, dynamic: ruleIndex >= 0 ? lines.slice(ruleIndex) : [] };
  });
}

/** indices of the sync frames whose lines contain `needle` */
export function syncFramesWith(all: readonly SyncFrame[], needle: string | RegExp): number[] {
  const test = typeof needle === 'string' ? (l: string): boolean => l.includes(needle) : (l: string): boolean => needle.test(l);
  return all.filter((f) => f.lines.some(test)).map((f) => f.index);
}

/** true when the indices form one contiguous run (a card that stayed open draws in every frame between its first and last) */
export function contiguous(indices: readonly number[]): boolean {
  return indices.every((v, i) => i === 0 || v === indices[i - 1]! + 1);
}

/** index of the first unit whose stripped lines contain `needle` (a visible marker typed into the composer), or -1 */
export function unitIndexOf(all: readonly FrameUnit[], needle: string): number {
  return all.findIndex((u) => u.lines.some((l) => l.includes(needle)));
}

/**
 * `ESC[2J` counts per marker segment: segment i spans the units after the previous marker's frame up to and including
 * the first frame that shows `needles[i]` (a composer echo such as `> draftZa`); the first segment starts at the
 * capture's first unit. A needle that never appears (or appears out of order) yields `clears: -1` and no unit.
 */
export function segmentClears(all: readonly FrameUnit[], needles: readonly string[]): Array<{ clears: number; unit: FrameUnit | undefined }> {
  const out: Array<{ clears: number; unit: FrameUnit | undefined }> = [];
  let from = -1;
  for (const needle of needles) {
    const to = unitIndexOf(all, needle);
    const hit = to > from;
    out.push({ clears: hit ? all.slice(from + 1, to + 1).reduce((n, u) => n + u.clears, 0) : -1, unit: hit ? all[to] : undefined });
    if (hit) from = to;
  }
  return out;
}

/**
 * Every row written above the rule (the header, then each unit's new `<Static>` items), in order. A clear-terminal
 * unit repeats Ink's whole `fullStaticOutput` before its new items (see `FrameUnit.staticRows`): when its rows start
 * with everything collected so far only the remainder is appended; a repeat that does not line up (a static row
 * re-wrapped by a width change) is skipped entirely rather than double-counted.
 */
export function staticRows(text: string): string[] {
  const rows: string[] = [];
  for (const u of units(text)) {
    if (u.clears === 0) {
      rows.push(...u.staticRows);
      continue;
    }
    const repeats = u.staticRows.length >= rows.length && rows.every((r, i) => u.staticRows[i] === r);
    if (repeats) rows.push(...u.staticRows.slice(rows.length));
  }
  return rows;
}

/** rows that are transcript items (§15.1 labels), i.e. neither wrapped continuations nor TUI-only detail rows — returned without the gutter padding, so they compare with transcript.log lines */
export function itemRows(rows: readonly string[]): string[] {
  return rows.filter((r) => ITEM_RE.test(r)).map(ungutter);
}

/** true when a row starts a transcript item (§15.1 label) */
export function isItemRow(row: string): boolean {
  return ITEM_RE.test(row);
}

/**
 * true for the renderer-local items that have no transcript.log twin (the header, the sandbox line, idle `[ui]` rows,
 * and the chat bubbles — TUI-DESIGN-2 §3.10: `[you]` is appended before any run starts and a `[jevcode]` reply is
 * emitted while no engine is live, so neither has a transcript.log line)
 */
export function isLocalItem(raw: string): boolean {
  const row = ungutter(raw);
  return /^\[run\] jevcode (?:session ·|task:|resuming) /.test(row) || row.startsWith('[sandbox] ') || row.startsWith('[ui] ') || row.startsWith('[setup] ') || row.startsWith('[config] ') || row.startsWith('[you] ') || row.startsWith('[jevcode] ');
}

/**
 * TUI-DESIGN-2 §4.5 / §9 (b): in the default `compact` transcript the TUI's item rows are a subsequence of
 * `transcript.log` — the stage kinds (`intent`, `context`, `proposal`, `risk`, `outcome`, `judge`, `plan`) and `run:ready`
 * are hidden, one `[step N]` summary line per step is shown. Returns the transcript indices matched in order, or the
 * first row that is not in the transcript (after the previous match) as `missing`.
 */
export function subsequenceOf(rows: readonly string[], transcript: readonly string[]): { matched: number[]; missing: string | null } {
  const matched: number[] = [];
  let from = 0;
  for (const row of rows) {
    let at = -1;
    for (let i = from; i < transcript.length; i++) {
      if (transcript[i] === row) {
        at = i;
        break;
      }
    }
    if (at < 0) return { matched, missing: row };
    matched.push(at);
    from = at + 1;
  }
  return { matched, missing: null };
}

/**
 * The stage lines the compact transcript hides (TUI-DESIGN-2 §4.5), in their TUI-DESIGN-4 §3.6 (D-V) text:
 * `[step N] intent · …`, `context · …`, `synth · …`, `proposal · …`, `risk <p> <verdict> …`, `done · …`,
 * `judge <p> · …` / `judge skipped · …`, `plan · …`, and `[run] ready …` (deleted as an item by G1).
 *
 * The separator is written `[·-]`, never `·` — `glyphs.ts` renders `dot: '-'` under `--ascii`. And `done` MUST
 * carry its separator: the compact transcript's own `[step N]` SUMMARY row also opens with `done` (`done scratch
 * work complete · risk 0.01 ok · …`, `stepOutcomeText`) and is the one row this predicate must NOT match.
 */
export const HIDDEN_STAGE_RE = /^ *\[step \d+\] (?:intent [·-] |context [·-] |synth [·-] |proposal [·-] |risk \d|done [·-] |judge (?:\d|skipped)|plan [·-] )|^ *\[run\] ready /;

/** true when a stripped frame line is a boxed-tier console or card edge (TUI-DESIGN-2 §4.1: `╭ … ╮`, `╰ … ╯`; `+-` under --ascii) */
export function isBoxEdge(line: string): boolean {
  return /^[╭╰]/.test(line) || /^\+-/.test(line);
}

/** the composer/console tier a frame was drawn in (TUI-DESIGN-2 §4.1): boxed when a console top edge is among its dynamic rows */
export function frameTier(unit: FrameUnit): 'boxed' | 'flat' {
  const dyn = unit.ruleIndex >= 0 ? unit.lines.slice(unit.ruleIndex) : unit.lines;
  return dyn.some((l) => /^╭─ /.test(l) || /^\+- /.test(l)) ? 'boxed' : 'flat';
}

/** the wall time between a `send` step whose arg is `sendArg` (first occurrence at or after `afterStep`) and the next `expect` step matching `expectIncludes` */
export function wallBetween(timing: readonly TimingRecord[], sendArg: string, expectIncludes: string, afterStep = 0): number | null {
  const sent = timing.find((r) => r.op === 'send' && r.arg === sendArg && r.step >= afterStep);
  if (sent === undefined) return null;
  const got = timing.find((r) => r.op === 'expect' && r.step > sent.step && r.arg.includes(expectIncludes));
  return got === undefined ? null : got.t - sent.t;
}

export interface Reflow {
  /** the transcript lines rebuilt from consecutive static rows, in order */
  lines: string[];
  /** continuation rows joined into their line */
  wrappedRows: number;
  /** rows that belong to no transcript line: the header, local items and their continuations, TUI-only detail rows */
  leftovers: string[];
  /** a row that neither continued the open line nor started the next transcript line while a line was open */
  mismatches: Array<{ row: string; remaining: string }>;
}

/**
 * Undo Ink's soft wrap of the `<Static>` rows at a narrow width, guided by the transcript.log lines they must rebuild
 * (§15.1 three-way identity at a realistic width). Ink (wrap-ansi, `hard: true, trim: false`) keeps every character
 * of a line across its rows, except that a row whose text ends in the break space and carries no trailing SGR reset
 * is `trimEnd()`ed by Ink's output stage; a row that is already full pushes the break space to the start of the next
 * row. So a continuation row is exactly the next prefix of the open line, either directly or after the line's
 * trimmed break spaces. A row with a §15.1 label that starts the next transcript line opens it; every other row —
 * the header, `[sandbox]`, `[ui]` items and their continuations, the dim detail rows under a proposal — is a leftover.
 */
export function reflowAgainst(rows: readonly string[], transcript: readonly string[], opts: { hangingIndent?: boolean } = {}): Reflow {
  const out: Reflow = { lines: [], wrappedRows: 0, leftovers: [], mismatches: [] };
  let next = 0;
  let open: { text: string; remaining: string } | null = null;
  for (const raw of rows) {
    // TUI-DESIGN-2 §3.10 / §9 (a), TUI-DESIGN-3 §5.1 / §5.3: a continuation row hangs at column 10 and a label row is padded into the
    // 10-cell gutter — neither indent is part of the line, so both are dropped before the row is matched (the §5.3 normaliser: strip
    // the leading spaces, join with one space; a row that leads with the `· ` separator joins after the previous segment's last token)
    const row: string = opts.hangingIndent ? raw.replace(/^ +/, '') : raw;
    if (open !== null) {
      let rest: string | null = null;
      if (open.remaining.startsWith(row)) rest = open.remaining.slice(row.length);
      else {
        const trimmed: string = open.remaining.replace(/^ +/, '');
        if (trimmed !== open.remaining && trimmed.startsWith(row)) rest = trimmed.slice(row.length);
      }
      if (rest !== null) {
        open.text += row;
        open.remaining = rest;
        out.wrappedRows += 1;
        if (rest.trim() === '') {
          out.lines.push(transcript[next - 1] ?? open.text);
          open = null;
        }
        continue;
      }
      out.mismatches.push({ row: raw, remaining: open.remaining });
      open = null;
    }
    const line = transcript[next];
    if (line !== undefined && isItemRow(row) && !isLocalItem(row) && line.startsWith(row)) {
      next += 1;
      const remaining: string = line.slice(row.length);
      if (remaining.trim() === '') out.lines.push(line);
      else open = { text: row, remaining };
      continue;
    }
    out.leftovers.push(row);
  }
  if (open !== null) out.mismatches.push({ row: '<end of capture>', remaining: open.remaining });
  return out;
}

/** the first timing record with this op (and, optionally, an arg containing `argIncludes`) */
export function timingOf(timing: readonly TimingRecord[], op: string, argIncludes?: string): TimingRecord | undefined {
  return timing.find((r) => r.op === op && (argIncludes === undefined || r.arg.includes(argIncludes)));
}

/** the last timing record with this op (and, optionally, an arg containing `argIncludes`) */
export function lastTimingOf(timing: readonly TimingRecord[], op: string, argIncludes?: string): TimingRecord | undefined {
  return [...timing].reverse().find((r) => r.op === op && (argIncludes === undefined || r.arg.includes(argIncludes)));
}

/** the `mark <label>` record */
export function markOf(timing: readonly TimingRecord[], label: string): TimingRecord | undefined {
  return timing.find((r) => r.op === 'mark' && r.arg === label);
}

/**
 * run-specific tokens normalised so two mocked runs of the same task compare line for line: the run id, `<n>ms`, `wall=`, and the
 * step summary's elapsed seconds (`· 0.0s ·`, TUI-DESIGN-3 §5.4) — a loaded machine measures 0.1s where an idle one measures 0.0s,
 * and the §15.1 identity gate is about the text, never the clock
 */
export function normaliseRunLine(line: string): string {
  return line
    .replace(/\b\d{8}-\d{6}-[a-z0-9]{8}\b/g, '<run-id>')
    .replace(/\b\d+ms\b/g, '<ms>')
    .replace(/\b\d+m\d{2}s\b/g, '<s>')
    .replace(/\b\d+\.\d+s\b/g, '<s>')
    .replace(/wall=\S+/g, 'wall=<t>');
}

/** the newest mtime under a directory tree (for the stale-bundle check) */
export function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/** `ps -axo pid=,stat=,command=` rows of `node …/bin/jevcode.js … --workspace <ws>` (never the expect driver, whose argv also holds the path) */
export function jevcodeProcesses(workspace: string): Array<{ pid: number; stat: string }> {
  const r = spawnSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' });
  const out: Array<{ pid: number; stat: string }> = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3] ?? '';
    if (!cmd.includes(workspace) || !cmd.includes('bin/jevcode.js') || cmd.startsWith(EXPECT_BIN)) continue;
    if (!cmd.startsWith(process.execPath) && !/^\S*node\b/.test(cmd)) continue;
    out.push({ pid: Number(m[1]), stat: m[2] ?? '' });
  }
  return out;
}

/**
 * Poll `ps` until the jevcode process of this workspace reports a state accepted by `want` — a state prefix such as
 * `T` (stopped) or a predicate — or the deadline passes; `states` lists the distinct states seen, in order.
 */
export async function waitForProcessState(workspace: string, want: string | ((stat: string) => boolean), deadlineMs: number): Promise<{ seen: boolean; states: string[] }> {
  const accept = typeof want === 'string' ? (stat: string): boolean => stat.startsWith(want) : want;
  const t0 = Date.now();
  const states: string[] = [];
  while (Date.now() - t0 < deadlineMs) {
    for (const p of jevcodeProcesses(workspace)) {
      if (states.at(-1) !== p.stat) states.push(p.stat);
      if (accept(p.stat)) return { seen: true, states };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { seen: false, states };
}

/** the controlling terminal of a process (`ps -o tty=` → `/dev/ttys012`), or null when it has none */
export function ttyOf(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' });
  const name = (r.stdout ?? '').trim();
  return name === '' || name === '??' || name === '-' ? null : `/dev/${name}`;
}

/** `stty -a -f <tty>` — the line discipline of a pty as seen from outside the process that owns it (macOS `-f`) */
export function sttyAll(tty: string): string | null {
  const r = spawnSync('stty', ['-a', '-f', tty], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '') : null;
}

/** true when the flag is on in an `stty -a` dump (`icanon`), false when off (`-icanon`), null when absent */
export function sttyFlag(dump: string, flag: string): boolean | null {
  if (new RegExp(`(^|\\s)${flag}(\\s|$)`).test(dump)) return true;
  if (new RegExp(`(^|\\s)-${flag}(\\s|$)`).test(dump)) return false;
  return null;
}

/** poll `stty -a` on a tty until `accept` holds for the dump (or the deadline passes); returns the last dump taken */
export async function waitForStty(tty: string, accept: (dump: string) => boolean, deadlineMs: number): Promise<{ ok: boolean; dump: string | null }> {
  const t0 = Date.now();
  let last: string | null = null;
  while (Date.now() - t0 < deadlineMs) {
    last = sttyAll(tty);
    if (last !== null && accept(last)) return { ok: true, dump: last };
    await new Promise((r) => setTimeout(r, 25));
  }
  return { ok: false, dump: last };
}

/**
 * Ink turns raw mode and bracketed paste on in the effect after the first commit, i.e. after the first frame's bytes
 * (research 20 §2: a key sent before that is a cooked-mode byte — echoed by the kernel, Ctrl-C a SIGINT death,
 * Ctrl-Z a SIGTSTP). `ESC[?2004h` is written by that same `setRawMode(true)`, so it is the sentinel every scenario
 * expects before its first `send`; it is written again by Ink's `resumeInput` after a Ctrl-Z resume.
 */
export const RAW_MODE_STEP = 'expect \\x1b\\[\\?2004h';
/**
 * The controller attaches the host and hands the renderer the session meter (`sess $0.00/50.00 ok` in the status
 * right zone) right before its loop awaits the first submission (§1 session loop). A key that needs the controller —
 * `/exit`, the second Ctrl-C or Ctrl-D — sent before that point is dropped (measured: `/exit` + Enter at t≈100 ms
 * clears the draft and the process stays), so every idle scenario waits for the badge first. Prompts typed earlier are
 * held and flushed when the host attaches (§4.9), which is why the run scenarios never needed it.
 */
export const IDLE_STEP = 'expect sess \\$';
/** the standard opening of every chat scenario at ≥ 80 columns: first frame, placeholder, raw mode, host attached */
export const CHAT_OPEN: readonly string[] = [FIRST_FRAME_STEP, `expect ${PLACEHOLDER_TASK}`, RAW_MODE_STEP, IDLE_STEP];
/** the narrow-terminal opening: the quiet start prints no `[sandbox]` item in the TUI, so the attached host is the status row's `sess $…` badge */
export const CHAT_OPEN_NARROW: readonly string[] = [FIRST_FRAME_STEP, `expect ${PLACEHOLDER_TASK}`, RAW_MODE_STEP, 'expect sess \\$'];
/**
 * The run is live. **OWNER ADDENDUM (2026-09):** the `[run] started · <badge> · <task>` item is no longer printed in
 * the interactive transcript (`isRunHeaderItem`; `--plain` and `--json` keep it), so a scenario can no longer wait on
 * it — it waits on the **status row** instead, which is exactly the row the addendum says already carries the run
 * state: `step <n>/<max>` (never the idle `step 0/–`) appears in the frame `run:ready` commits. `RUN_STARTED_ROW_RE` below is still the
 * anchor over a `--plain` transcript. Every mocked run of the pty project says `--mode jev-on` explicitly
 * (`MOCK_RUN_MODE`): the scripted `--mock` trajectory is a generator trajectory, and under the round-2 default
 * `jev-only` (§1.1) the real synthesizer would run instead of it.
 */
export const RUN_STARTED_STEP = 'expect step \\d+/\\d+';
/**
 * TUI-DESIGN-4 §3.6 (G1) / §3.7: the run's last item, `finished · <reason> · <n> steps · …`. `reason` is a Tcl
 * alternation (`complete|max_steps`), written without a capture group so `drive.exp`'s `-re` keeps one match.
 */
export function runFinishedStep(reason: string): string {
  return `expect ${RUN_FINISHED_WORD} ${GLYPH_DOT_CLASS} ${reason}`;
}
/** the glyph-agnostic `[run] finished · …` anchor over a **stripped** capture row (the gutter is 0–9 cells) */
export const RUN_FINISHED_ROW_RE = new RegExp(`^ {0,9}\\[run\\] ${RUN_FINISHED_WORD} ${GLYPH_DOT_CLASS} `);
/** the glyph-agnostic `[run] started · …` anchor over a **stripped** capture row */
export const RUN_STARTED_ROW_RE = new RegExp(`^ {0,9}\\[run\\] ${RUN_STARTED_WORD} ${GLYPH_DOT_CLASS} `);
export const MOCK_RUN_MODE: readonly string[] = ['--mode', 'jev-on'];
/** the opening of a one-shot `run` scenario: the first frame, raw mode (the steering composer), then the run's start item */
export const RUN_OPEN: readonly string[] = [FIRST_FRAME_STEP, RAW_MODE_STEP, RUN_STARTED_STEP];
/** type a task and submit it; the run is live once the status row reads `step 1/…` (the mock intake reads a ≥ 3-word imperative without `?` as `coding_task`, TUI-DESIGN-2 §3.13) */
export function submitTask(text: string): string[] {
  return [`send ${text}`, echoStep(text), 'send \\r', RUN_STARTED_STEP];
}
/** leave an idle session through /exit */
export const EXIT_IDLE: readonly string[] = ['send /exit', echoStep('/exit'), 'send \\r', 'eof'];
