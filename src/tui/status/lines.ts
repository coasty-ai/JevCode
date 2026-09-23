/**
 * The status line (TUI-DESIGN §7.4, A46, F16): one row, three zones, pure.
 *
 * `statusLineText(state, columns)` is the shared `lines()` function of the Ink status row, its
 * `PaneBoundary` fallback, the `--plain`/`--screen-reader` twins and the frame tests. Left zone:
 * the mode word or spinner + stage verb, then the badges `!n` · `sandbox: none` · `no-net` (a toast
 * replaces it, §7.5). Centre: the `/rename` title or run id, only when ≥ 24 cells stay free. Right
 * zone, right-aligned: `step N/M` + wall · `run $x.xx/y.yy <word>` · `sess $x.xx/y.yy <word>` ·
 * tokens (≥ 160) · git zone (≥ 100) · Jev sparkline (≥ 100) · ShortHelp · `⚠ secret?` (F-V, §4.10:
 * at the end of the row, never dropped); meter bars at ≥ 140. Drop order when short: ShortHelp →
 * sparkline → git → session meter → wall → centre. Cells are measured by O2's `stringWidth`, bars
 * and the sparkline are O4's, the money and meter words O6's, so every twin draws the same picture.
 * No I/O, no clock: `state.nowMs`. TUI-DESIGN-2 §1.5 / §4.8: the mode badge (`jev-only` · `jev+llm` · `llm-only`,
 * ` · next run` while a `/mode` is pending) and the conversational left words (`⠹ thinking` · `⠹ looking` ·
 * `⠹ replying` · `asking`); in the boxed tier the row is drawn at the console's inner width, in the flat tier the
 * badge leads the left zone (`jev-only · idle`) and is the first thing dropped when short.
 * TUI-DESIGN-3 §1.1 / §5.2 P6–P7 / §5.1 rule 7: the badge word comes from the one table `MODE_BADGE_WORD` (config/defaults.ts —
 * nothing here names a mode); `statusSpans` colours the left word and the meter words only (never the whole row); the
 * `starting` phase without a chat phase keeps the previous idle word (no wrong chrome between Enter and the bubble); the
 * centre shows `/rename` titles only, never the run id.
 */
import type { BlockingKind, BlockingRequest, ConfirmRequest, EngineMode, EngineStatus, GitHead, PeerView, RetryCause, RunResult, SandboxLevel, SpendSnapshot, StopReason } from '../../core/types.js';
// TUI-DESIGN-5 §2.1 rule 1 / rule 3a: the coordination FACADE, `import type` only — the type erases under
// `verbatimModuleSyntax`, so `src/coordination/**` never reaches the argv path (gate G-R5-1).
import type { Fold } from '../../coordination/index.js';
import { MODE_BADGE_WORD } from '../../config/defaults.js';
import { exitCodeFor } from '../../loop/stop.js';
import { SPARKLINE_CELLS, eighthBar, sparkline } from '../bars.js';
import { meterWord, usd2 } from '../budget/lines.js';
import { ELLIPSIS, stringWidth, truncateCells } from '../composer/width.js';
import { GLYPHS, glyphSet } from '../glyphs.js';
import type { GlyphSet } from '../glyphs.js';
import type { OverlayKind } from '../layout.js';
import type { ColorRole } from '../theme.js';
import { activeToast, asciiFold, oneLineSafe, toastPhase, toastRole, toastText } from '../toasts.js';
import type { Toast } from '../toasts.js';

// ---------------------------------------------------------------------------------------
// State view (a structural subset of UiState 1.1, §15 item 20, plus the optional extras it lacks)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §15 item 20 `RunPhase` (no 'paused': a blocking pause is overlay 'blocking' with run 'live'). */
export type StatusRunPhase = 'none' | 'starting' | 'live' | 'aborting' | 'pausing';
/** TUI-DESIGN §15 item 20 `GitZone` (O9 imports this shape). */
export interface GitZone {
  head: GitHead | null;
  ahead: number | null;
  behind: number | null;
  dirty: { modified: number; staged: number; untracked: number };
  linkedWorktree: boolean;
  frozen: boolean;
}
/** The part of `RetryView` (§15 item 20) the left zone reads. */
export interface StatusRetry {
  attempt: number;
  maxAttempts: number;
  cause: Pick<RetryCause, 'kind'>;
}

/**
 * TUI-DESIGN §7.4: what `statusLineText` reads. Every required member is a `UiState` 1.1 field with
 * its exact name and type (§15 item 20), so the reducer state is passed as is; the optional members
 * are inputs item 20 does not carry yet (see the O5 report: title, sandbox/noNetwork badges, disk
 * count, Jev latencies for the sparkline, the picker flag, an extrapolated wall clock).
 */
export interface StatusLineState {
  readonly run: StatusRunPhase;
  readonly mode: EngineMode | null;
  readonly status: EngineStatus | null;
  readonly ready: { step: number; maxSteps: number } | null;
  readonly done: RunResult | null;
  readonly runId: string | null;
  readonly overlay: OverlayKind;
  readonly pendingReview: ConfirmRequest | null;
  readonly retrying: StatusRetry | null;
  readonly blocking: BlockingRequest | null;
  readonly errors: number;
  readonly stageStartedAt: number | null;
  readonly toasts: readonly Toast[];
  readonly git: GitZone | null;
  readonly spend: { run: SpendSnapshot | null; session: { totalUsd: number; capUsd: number } | null };
  readonly draft: { readonly secretHits: number };
  readonly nowMs: number;
  /** `/rename` title (centre zone, in quotes); falls back to `runId` */
  readonly title?: string | null;
  /** `run:ready.sandbox` → `sandbox: none` badge */
  readonly sandbox?: SandboxLevel | null;
  /** `run:ready.noNetwork` → `no-net` badge */
  readonly noNetwork?: boolean;
  /** `notice checkpoint:degraded` count → `disk ×N` */
  readonly diskErrors?: number;
  /** last Jev request latencies (ms; null = failed attempt) for the sparkline */
  readonly jevLatencies?: readonly (number | null)[];
  /** the session picker is open in the pane slot → `picker` */
  readonly picker?: boolean;
  /** wall clock override (e.g. `status.wallMs + nowMs − statusAt` for the 1 Hz redraw) */
  readonly wallMs?: number | null;
  /** `run:end.exitCode`; derived with `exitCodeFor(done.stopReason, done.error)` when absent */
  readonly doneExitCode?: number | null;
  /** TUI-DESIGN-2 §1.5: the mode badge — the live mode and the `/mode` pending for the next run */
  readonly modeBadge?: { mode: EngineMode; pending: EngineMode | null } | null;
  /** TUI-DESIGN-2 §4.8: the conversational phase of a submission (`⠹ thinking` · `⠹ looking` · `⠹ replying`) */
  readonly thinking?: ThinkingPhase | null;
  /**
   * TUI-DESIGN-4 §7.10 (P-D10) item 1: the peer snapshot the controller supplies (`SessionHost.peers()`, contract
   * 1.7 item 9); null until the registry lands. The segment shows the **count only** — never a pid, never a path.
   *
   * TUI-DESIGN-5 §12 supersedes this as a **status segment** (`fold` below feeds `peerZoneText`); the field and
   * `peersText` stay because D-AC (b) keeps `/peers` exactly as TD4 §7.10 specifies it — `/peers` reads this
   * `PeerView`, it does not read the fold.
   */
  readonly peers?: PeerView | null;
  /**
   * TUI-DESIGN-5 §2.2: the coordination fold, the peer zone's only source. Absent or null until
   * `LedgerHandle.open()` resolves **after** `renderer.firstFrame()` (§2.1 rule 3), and then the segment is simply
   * absent — never a spinner, never a placeholder (§7 row 2).
   */
  readonly fold?: Fold | null;
  /**
   * TUI-DESIGN-5 §2.2: this session's identity, so my own run is not counted as a peer. Never `hostKey`
   * (§7 row 61). **Optional in the guard as well as the type**: absent or null excludes nothing and the zone
   * still renders off `fold` alone, because `⇄`/`✉` is the only signal that a peer is waiting on this session and
   * an idle TUI — which has no `runId` to identify itself with — is exactly when that matters (§2.2).
   */
  readonly selfId?: PeerZoneSelf | null;
  /**
   * TUI-DESIGN-5 §3.1 (R5-3) — the `ctx` cell text, already at the right rung for `columns`
   * (`ctx 41%` at 80–99, `ctx 41% · 6 files · 12 steps` at ≥ 100, the amber/red word **replacing** the cell).
   * The two width gates are `CONTEXT_MIN_COLUMNS` / `CONTEXT_FULL_COLUMNS` below; the cell is absent under 80.
   *
   * §8.4's fixture-first rule: R5-2 lands the segment's **position** (F-51/F-55's one push order) and its drop
   * rank in the same edit as `peers` and `agents` (§9.2, §14.2 #45); R5-3 lands the text. Until R5-3's
   * `ctxText(status.context, columns, g)` is in this file the caller supplies the string, so the order cannot
   * drift while the two PRs are in flight. The swap is one line in `rightZoneSegments`.
   */
  readonly ctx?: string | null;
  /** TUI-DESIGN-5 §4.4 (R5-4): the collapsed agents strip, same fixture-first rule as `ctx` — R5-4 replaces the read with `agentStripText(...)`. */
  readonly agents?: string | null;
  /**
   * AGENT-LOOP-DESIGN §A5 / peer review C: what a live agent run is doing now — `thinking` (a model turn), `reading` (a
   * read-only batch), `editing` / `running` (the mutating call), `testing` (the harness's test run). It replaces the stage
   * verb (the engine's stages are `propose` / `execute` for every one of those), named from t = 0 of the step. Absent or
   * null in every other mode.
   */
  readonly agentWord?: string | null;
}

/** TUI-DESIGN-2 §4.8: the three phases between Enter and a reply. */
export type ThinkingPhase = 'intake' | 'lookup' | 'replying';
/** TUI-DESIGN-2 §4.8 / §12 "Status": the left word per chat phase. */
export const THINKING_WORDS: Readonly<Record<ThinkingPhase, string>> = { intake: 'thinking', lookup: 'looking', replying: 'replying' };

/** TUI-DESIGN-3 §1.1 (D-N): the badge word is whatever `MODE_BADGE_WORD` says — a string, never an enumeration of modes here. */
export type ModeBadge = string;
/** TUI-DESIGN-3 §1.1: the ONE table maps a mode to its word (`jev-only` · `jev+llm` · `llm-only` · `llm+jev · verified`); the `·` folds to the glyph set's dot. */
export function modeBadgeWord(mode: EngineMode, g: GlyphSet = GLYPHS.unicode): ModeBadge {
  return MODE_BADGE_WORD[mode].replaceAll(' · ', ` ${g.dot} `);
}
/** TUI-DESIGN-2 §1.5 / §12 "Console": `jev-only`; `jev+llm · next run` while a pending mode differs from the live one. */
export function modeBadge(mode: EngineMode, pending: EngineMode | null, g: GlyphSet = GLYPHS.unicode): string {
  if (pending !== null && pending !== mode) return `${modeBadgeWord(pending, g)} ${g.dot} next run`;
  return modeBadgeWord(mode, g);
}

/** TUI-DESIGN §7.4 / §14.1: glyph mode, motion, spinner phase and renderer mode (all default to the Unicode session TUI). */
export interface StatusLineOptions {
  ascii?: boolean;
  reducedMotion?: boolean;
  spinnerFrame?: number;
  mode?: 'session' | 'one-shot';
  /** TUI-DESIGN-2 §1.5 / §4.8: the flat tier — `state.modeBadge` leads the left zone as `<badge> · <word>` (dropped first when short) */
  flatBadge?: boolean;
  /**
   * The TERMINAL width, for the two round-5 gates that TUI-DESIGN-5 states in terminal columns (`ctx` §3.1: 80 / 100;
   * `peers` §2.2: 80 / 100). The boxed console assembles this row at its INNER width (terminal − 4), so without this the
   * cells could never appear at an 80- or 100-column terminal — the 0.6.0 live drive at 24×80 showed no `ctx` cell while
   * the engine carried `status.context` on every status event. Absent (the flat tier, tests) → the row width is the terminal width.
   */
  terminalColumns?: number;
  /**
   * AGENT-LOOP-DESIGN §A3 / §A5: the mini indicator's frame for this tick at its two widths — the wide (3-cell) braille
   * form and the narrow (1-cell) one. It REPLACES the spinner glyph in the left word; the row draws the wide form only
   * while the row fits with it (the two extra cells are given up before anything else is dropped), so at 80 columns it
   * costs nothing. Absent (a screen reader, the twins, tests) → the spinner glyph as before.
   */
  indicatorWide?: string;
  indicatorNarrow?: string;
}

// ---------------------------------------------------------------------------------------
// Constants (§7.4, §14.1, §24)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §7.4: `still waiting` after 45 s in one stage. */
export const STILL_WAITING_MS = 45_000;
/** TUI-DESIGN §7.4: the centre zone needs this many free cells. */
export const CENTRE_MIN_FREE = 24;
/** TUI-DESIGN §14.1 (the 400-cell cap of the rule row, applied to the centre text): a title never draws more cells than this. */
export const CENTRE_MAX_CELLS = 400;
/** TUI-DESIGN §7.4: the git zone appears from 100 columns. */
export const GIT_ZONE_MIN_COLUMNS = 100;
/** TUI-DESIGN §7.4: the Jev sparkline appears from 100 columns. */
export const SPARKLINE_MIN_COLUMNS = 100;
/** TUI-DESIGN §7.4 / §22 (A46): 10-cell meter bars only at ≥ 140 columns. */
export const METER_BAR_MIN_COLUMNS = 140;
/** TUI-DESIGN §7.4: the meter bars are 10 cells wide. */
export const METER_BAR_CELLS = 10;
/** TUI-DESIGN §7.4 / §22 (A46): `gen 5.5k jev 28k` tokens only at ≥ 160 columns. */
export const TOKENS_MIN_COLUMNS = 160;
/** TUI-DESIGN §12.2: the git zone never exceeds 24 cells. */
export const GIT_ZONE_MAX_CELLS = 24;
/** Sanity bound on `columns` (no terminal is wider; keeps the fill bounded for a non-finite or absurd width). The row right-aligns to the true `columns` below it. */
export const MAX_COLUMNS = 4096;
/** The jev-only propose marker (`StatusLine.tsx` SYNTH_MARKER, kept). */
export const SYNTH_MARKER = '[synth]';
const ZONE_GAP = 2;
const STEP_WORDS: readonly string[] = ['intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete', 'replan', 'decompose', 'coordinate'];

// ---------------------------------------------------------------------------------------
// Cells (§4.2 via O2's width.ts; §14.1 ellipsis twin)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §4.2 / §14.1: `truncateCells` (O2) ending in the glyph set's ellipsis — `…` (one cell) or the
 * `--ascii` `...` (three cells; `.`/`..` when fewer cells exist). Non-finite or ≤ 0 cells → ''.
 */
export function truncateStatus(s: string, cells: number, ascii = false): string {
  if (!ascii) return truncateCells(s, cells);
  if (!Number.isFinite(cells) || s.length === 0) return '';
  const limit = Math.max(0, Math.floor(cells));
  if (stringWidth(s) <= limit) return s;
  const mark = GLYPHS.ascii.ellipsis;
  if (limit < mark.length) return mark.slice(0, limit);
  const cut = truncateCells(s, limit - (mark.length - 1));
  return cut.endsWith(ELLIPSIS) ? cut.slice(0, -ELLIPSIS.length) + mark : cut;
}

function glyphs(ascii: boolean): GlyphSet {
  return glyphSet({ ascii });
}

// ---------------------------------------------------------------------------------------
// Money, meters, wall clock (§7.4, §9.6, §24; words and money from O6's budget/lines.ts)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §7.4 / §9.6 / §24: `run $x.xx/y.yy <word>` · `sess $x.xx/none uncapped`; `exceeded` (the meter's
 * own flag) forces `over`; a NaN cap prints `?` and fails closed through O6's `meterWord` (§9.5) — only
 * +Infinity is `uncapped`. With `bar`, O4's 10-cell `eighthBar` sits between the money and the word.
 */
export function meterText(label: 'run' | 'sess', totalUsd: number, capUsd: number, o: { exceeded?: boolean; bar?: boolean; ascii?: boolean } = {}): string {
  const word = o.exceeded === true ? 'over' : meterWord(totalUsd, capUsd);
  const cap = capUsd === Number.POSITIVE_INFINITY ? 'none' : Number.isFinite(capUsd) ? capUsd.toFixed(2) : '?';
  const withBar = o.bar === true && Number.isFinite(capUsd) && capUsd > 0;
  const bar = withBar ? ` ${eighthBar(Number.isFinite(totalUsd) ? totalUsd / capUsd : 0, METER_BAR_CELLS, glyphs(o.ascii === true))}` : '';
  return `${label} ${usd2(totalUsd)}/${cap}${bar} ${word}`;
}

/**
 * TUI-DESIGN §7.4 wall clock as every §2.3 frame draws it: `0m03s`, `4m12s`, `1h05m`. The
 * zero-padded form keeps the right zone from shifting on every 1 Hz redraw (see the O5 report:
 * §24 names `formatDuration`, whose `3s`/`1m2s` forms jitter). Non-finite or negative → ''.
 */
export function wallText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 100) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${h}h`;
}

/** TUI-DESIGN §7.4 / §1: `step N/M` — the first-frame sentinel; `step N/–` before `run:ready` (`-` under --ascii). */
export function stepText(step: number, maxSteps: number | null, ascii = false): string {
  const n = Number.isFinite(step) && step >= 0 ? Math.floor(step) : 0;
  const m = maxSteps !== null && Number.isFinite(maxSteps) && maxSteps > 0 ? String(Math.floor(maxSteps)) : ascii ? '-' : '–';
  return `step ${n}/${m}`;
}

/** TUI-DESIGN §7.4 / §9.5: token counts in k — `5.5k`, `28k`, `133k` (a whole thousand drops its `.0`); below 1,000 the integer. */
export function kShort(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  const k = v / 1000;
  const text = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${text}k`;
}

// ---------------------------------------------------------------------------------------
// Git zone and sparkline (§7.4, §12.2)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §12.2 / §24: `⎇ main ↑2 · 3~ 1?` / `⎇ 7d731c0e†` / `⎇ main (wt)` (`br main ^2 - 3~ 1?` under
 * --ascii), ≤ 24 cells: the branch keeps its tail after the last `/` first, then is cut by grapheme.
 * `m~` is the modified (work-tree-changed) count exactly as §12.2 pairs the zone `3~ 1?` with the banner
 * `3 modified · 1 staged · 1 untracked`; `n?` the untracked count. '' without a head.
 */
export function gitZoneText(zone: GitZone, ascii = false, maxCells = GIT_ZONE_MAX_CELLS): string {
  if (zone.head === null) return '';
  const g = glyphs(ascii);
  const head = zone.head;
  const fullName = head.kind === 'branch' ? head.name : head.kind === 'unborn' ? head.name : `${head.oid.slice(0, 8)}${g.dagger}`;
  let tail = '';
  if (zone.linkedWorktree) tail += ' (wt)';
  const ahead = zone.ahead ?? 0;
  const behind = zone.behind ?? 0;
  if (ahead > 0) tail += ` ${g.up}${Math.floor(ahead)}`;
  if (behind > 0) tail += ` ${g.down}${Math.floor(behind)}`;
  const dirty: string[] = [];
  if (zone.dirty.modified > 0) dirty.push(`${Math.floor(zone.dirty.modified)}~`);
  if (zone.dirty.untracked > 0) dirty.push(`${Math.floor(zone.dirty.untracked)}?`);
  if (dirty.length > 0) tail += ` ${g.dot} ${dirty.join(' ')}`;
  const cap = Math.max(0, Math.floor(Number.isFinite(maxCells) ? maxCells : 0));
  const build = (name: string): string => `${g.branch} ${name}${tail}`;
  let name = fullName;
  if (stringWidth(build(name)) > cap && head.kind !== 'detached') {
    const slash = name.lastIndexOf('/');
    if (slash !== -1 && slash < name.length - 1) name = name.slice(slash + 1);
  }
  if (stringWidth(build(name)) > cap) {
    const fixed = stringWidth(build(''));
    const room = cap - fixed;
    if (room >= 3) return build(truncateStatus(name, room, ascii));
    return truncateStatus(build(name), cap, ascii);
  }
  return build(name);
}

/** TUI-DESIGN §7.4: `jev ▂▃▂▅▂▂▇▃▂▁▂▃` — O4's `sparkline` over the last 12 Jev requests (fixed 0–1000 ms scale, failed attempt = space, short input padded on the left), always 16 cells. */
export function sparklineText(samples: readonly (number | null)[], ascii = false): string {
  return `jev ${sparkline(samples, glyphs(ascii), SPARKLINE_CELLS)}`;
}

// ---------------------------------------------------------------------------------------
// Left zone (§7.4, §13.1, §24)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §24 `paused: <reason>` per blocking kind (§24 lists four; drift and sandbox follow §7.4's `paused: <reason>` pattern — see the O5 report). */
export function pausedWord(kind: BlockingKind): string {
  switch (kind) {
    case 'jev-unreachable':
      return 'paused: jev unreachable';
    case 'key-rejected':
      return 'paused: key rejected';
    case 'checkpoint-degraded':
      return 'paused: checkpoint degraded';
    case 'spend-limit':
      return 'paused: spend limit';
    case 'drift':
      return 'paused: model drift';
    case 'sandbox-unavailable':
      return 'paused: sandbox unavailable';
    case 'land-preflight':
      return 'paused: land pre-flight';
    case 'lease-conflict':
      return 'paused: lease conflict';
  }
}

/** TUI-DESIGN §7.4 / §14.2: a braille frame (or `|/-\`) while animating; the glyph table's static spinner cell (`•` → `*`) under reduced motion. */
function spinnerGlyph(o: StatusLineOptions): string {
  const g = glyphs(o.ascii === true);
  if (o.reducedMotion === true) return g.spinnerStatic;
  const frames = g.spinner;
  const i = o.spinnerFrame !== undefined && Number.isFinite(o.spinnerFrame) ? Math.abs(Math.floor(o.spinnerFrame)) % frames.length : 0;
  return frames[i] ?? g.spinnerStatic;
}

function stepOf(s: StatusLineState): number {
  return s.status?.step ?? s.done?.steps ?? s.ready?.step ?? 0;
}

/** TUI-DESIGN §13.5: `run:end.exitCode` when the state carries it, else `exitCodeFor(stopReason, error)` (a ConfigError run is `idle exit 2`, not 1). */
function exitOf(s: StatusLineState, done: RunResult): number {
  if (s.doneExitCode !== undefined && s.doneExitCode !== null && Number.isFinite(s.doneExitCode)) return Math.floor(s.doneExitCode);
  return exitCodeFor(done.stopReason, done.error);
}

function finishingWord(reason: StopReason): string {
  return reason === 'human_abort' || reason === 'signal' ? 'aborting' : `done ${reason}`;
}

/** TUI-DESIGN §7.4 / §24: the mode word or spinner + stage verb (no badges, no toast); glyph-folded under --ascii. */
export function leftZoneWord(s: StatusLineState, o: StatusLineOptions = {}, narrow = false): string {
  const word = leftWord(s, o, narrow);
  return o.ascii === true ? asciiFold(word) : word;
}

/**
 * AGENT-LOOP-DESIGN §A3: the glyph in front of the left word — the mini indicator's frame (wide, or narrow when the row
 * is short) when the caller supplies one, else the spinner glyph (a braille frame or the shade pulse; the static cell
 * under reduced motion).
 */
function stateGlyph(o: StatusLineOptions, narrow: boolean): string {
  const mini = narrow ? (o.indicatorNarrow ?? o.indicatorWide) : (o.indicatorWide ?? o.indicatorNarrow);
  return mini !== undefined && mini !== '' ? mini : spinnerGlyph(o);
}

/** True when the options carry a wide indicator frame that a narrow one can replace (the row may give the two cells back). */
function canNarrow(o: StatusLineOptions): boolean {
  return o.indicatorWide !== undefined && o.indicatorNarrow !== undefined && o.indicatorWide !== o.indicatorNarrow;
}

function leftWord(s: StatusLineState, o: StatusLineOptions, narrow = false): string {
  if (s.overlay === 'wizard') return 'setup';
  if (s.overlay === 'palette') return 'palette';
  if (s.picker === true) return 'picker';
  if (s.run === 'aborting') return 'aborting';
  if (s.run === 'pausing') return `pausing after step ${stepOf(s)}`;
  // TUI-DESIGN-2 §3.1 row 1 / §4.8: between Enter and the reply — `⠹ thinking` · `⠹ looking` · `⠹ replying` (`• thinking`
  // under reduced motion). The submission runs under `run: 'starting'` until the reply or `run:start` (§3.1 row 5), so the
  // chat phase wins over the bare `starting` word; a live run never carries a phase (the controller refuses `converse` then)
  if (s.thinking !== undefined && s.thinking !== null && (s.run === 'none' || s.run === 'starting')) return `${stateGlyph(o, narrow)} ${THINKING_WORDS[s.thinking]}`;
  // TUI-DESIGN-3 §5.2 P7: `starting` without a chat phase (the frame between Enter and the bubble, the one-shot argv path
  // before `run:start`) keeps the previous idle word — the row never reads `starting` beside a `Type to steer` placeholder
  if (s.run === 'none' || s.run === 'starting') {
    if (s.done === null) return 'idle';
    return o.mode === 'one-shot' ? `done ${s.done.stopReason}` : `idle exit ${exitOf(s, s.done)}`;
  }
  // live
  if (s.blocking !== null) return pausedWord(s.blocking.kind);
  if (s.status?.blocked) return pausedWord(s.status.blocked);
  const disk = s.diskErrors ?? 0;
  if (Number.isFinite(disk) && disk > 0) return `disk ${GLYPHS.unicode.times}${Math.floor(disk)}`;
  if (s.retrying !== null) {
    if (s.retrying.cause.kind === 'network') return 'offline';
    return `retrying ${s.retrying.attempt}/${s.retrying.maxAttempts}`;
  }
  if (s.overlay === 'review') return 'review';
  if (s.pendingReview !== null) return 'review pending…';
  if (s.status !== null && s.status.stopReason !== null) return finishingWord(s.status.stopReason);
  // AGENT-LOOP-DESIGN §A5 / peer C: an agent run names what it is doing from t = 0 of the step, before any `status` event
  if (s.agentWord !== undefined && s.agentWord !== null && s.agentWord !== '') {
    if (s.stageStartedAt !== null && Number.isFinite(s.nowMs) && s.nowMs - s.stageStartedAt >= STILL_WAITING_MS) return `${stateGlyph(o, narrow)} ${s.agentWord} ${STILL_WAITING_SUFFIX}`;
    return `${stateGlyph(o, narrow)} ${s.agentWord}`;
  }
  const stage = s.status?.stage ?? 'idle';
  if (stage === 'idle') return 'starting';
  if (s.stageStartedAt !== null && Number.isFinite(s.nowMs) && s.nowMs - s.stageStartedAt >= STILL_WAITING_MS) return 'still waiting';
  const verb = stage === 'propose' && s.mode === 'jev-only' ? `propose ${SYNTH_MARKER}` : STEP_WORDS.includes(stage) ? stage : String(stage);
  return `${stateGlyph(o, narrow)} ${verb}`;
}

/** AGENT-LOOP-DESIGN §A5: an agent activity past `STILL_WAITING_MS` keeps its word and its animation, with this after it (a long model turn is not stuck). */
export const STILL_WAITING_SUFFIX = '· still waiting';

/** TUI-DESIGN §7.4 / §24 left-zone badges, in order: `!n` · `sandbox: none` · `no-net` (`⚠ secret?` sits at the end of the row: `secretBadge`). */
export function badges(s: StatusLineState): string[] {
  const out: string[] = [];
  if (Number.isFinite(s.errors) && s.errors > 0) out.push(`!${Math.floor(s.errors)}`);
  if (s.sandbox === 'none') out.push('sandbox: none');
  if (s.noNetwork === true) out.push('no-net');
  return out;
}

/** TUI-DESIGN §4.10 / F-V: ` ⚠ secret?` (`! secret?` under --ascii) at the end of the status line while the draft has a hit; '' otherwise. */
export function secretBadge(s: StatusLineState, ascii = false): string {
  if (!(Number.isFinite(s.draft.secretHits) && s.draft.secretHits > 0)) return '';
  return `${glyphs(ascii).warn} secret?`;
}

/** TUI-DESIGN §7.4 / §7.5: the whole left zone — the active toast, or the word followed by the badges (the flat-tier badge prefix is `statusZones`'s, so it can be dropped first). */
export function leftZoneText(s: StatusLineState, o: StatusLineOptions = {}, narrow = false): string {
  const toast = activeToast(s.toasts, s.nowMs);
  if (toast !== null) return toastText(toast, o.ascii === true);
  return [leftZoneWord(s, o, narrow), ...badges(s)].join(' ');
}

/** TUI-DESIGN-2 §1.5 / §4.8: the flat tier's `<badge> · ` prefix — only with `flatBadge`, a badge in the state and no toast on the zone; '' otherwise. */
export function flatBadgePrefix(s: StatusLineState, o: StatusLineOptions = {}): string {
  if (o.flatBadge !== true || s.modeBadge === undefined || s.modeBadge === null) return '';
  if (activeToast(s.toasts, s.nowMs) !== null) return '';
  const g = glyphs(o.ascii === true);
  return `${modeBadge(s.modeBadge.mode, s.modeBadge.pending, g)} ${g.dot} `;
}

// ---------------------------------------------------------------------------------------
// Right zone and assembly (§7.4)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN-5 §8.1 item 10 / §9.2 (§14.2 #45): eleven segments — round 4's nine plus `'ctx'` (§3.1, R5-3) and
 * `'agents'` (§4.4, R5-4). Exported so gate G-R5-10's shared-array identity test can import it.
 */
export type SegmentId = 'step' | 'run' | 'agents' | 'sess' | 'tokens' | 'ctx' | 'peers' | 'git' | 'spark' | 'help' | 'secret';
interface Segment {
  id: SegmentId;
  text: string;
  /** cells, measured once (the drop loop re-checks the fit several times per render) */
  width: number;
}
function seg(id: SegmentId, text: string): Segment {
  return { id, text, width: stringWidth(text) };
}

/**
 * TUI-DESIGN §7.4 drop order when short: ShortHelp → sparkline → git → the context cell → the peer zone → session
 * meter → wall (→ centre, which needs ≥ 24 free cells anyway); the flat-tier badge prefix goes before all of them
 * (TUI-DESIGN-2 §1.5).
 *
 * **TUI-DESIGN-5 §2.2 amends TUI-DESIGN-4 §7.10 edge 2**, which put `'peers'` **first**. TD4's segment was a bare
 * `<n> here` count; round 5's carries **unread-message counts** (`⇄ 2 live · 1 heads-up · ✉ 1`, §12 S6), and an
 * unread directed message outranks git state — a user who loses `⇄`/`✉` at 100 columns loses the only signal that
 * someone is waiting on them. So `'peers'` sits **fifth**: session money outranks it, git state and the sparkline
 * do not. `'agents'` is deliberately **absent** from this list (like `'run'` and `'step'`): the agents strip is the
 * run's own money and is never dropped (§4.4, §9.2, §14.2 #45). Seven entries.
 */
export const DROP_ORDER: readonly ('help' | 'spark' | 'git' | 'ctx' | 'peers' | 'sess' | 'wall')[] = ['help', 'spark', 'git', 'ctx', 'peers', 'sess', 'wall'];

// ---------------------------------------------------------------------------------------
// The peer zone (TUI-DESIGN-5 §2.2, §12 S6) — `⇄ 2 live · 1 heads-up · ✉ 1`
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN-5 §2.2: below this the whole peer segment is absent. */
export const PEERS_MIN_COLUMNS = 80;
/** TUI-DESIGN-5 §2.2: the heads-up clause is the first thing the segment drops, right to left, exactly as `gitZoneText` drops. */
export const HEADSUP_MIN_COLUMNS = 100;
/** TUI-DESIGN-5 §4.4 (R5-4's `agentStripText` gate, landed here with the one push-order edit, §9.2). */
export const AGENTS_MIN_COLUMNS = 40;

/**
 * TUI-DESIGN-5 §3.1 / §14.2 #38: the `ctx` cell's two rungs are **two gates, not one** — `CONTEXT_MIN_COLUMNS`
 * admits the short form `ctx 41%` (7 cells, which fits beside `run $0.12/2.00` at 80) and `CONTEXT_FULL_COLUMNS`
 * admits `formatMeter`'s whole `ctx 41% · 6 files · 12 steps` (28 cells). **At 40 columns the cell is absent.**
 *
 * §9.2 attributes these two constants to R5-3 along with `ctxText`; they are declared **here** because the segment
 * they gate is R5-2's (§9.1: "the `peers`, `ctx` and `agents` segments"), because `rightZoneSegments` cannot honour
 * "absent at 40" without them, and because §10 lists the rung test under R5-2 while nothing in the tree pinned the
 * rungs. **R5-3 imports them; it must not re-declare them** (recorded as a request in R5-2's report).
 */
export const CONTEXT_MIN_COLUMNS = 80;
/** TUI-DESIGN-5 §3.1: at or above this the `ctx` cell carries `formatMeter`'s whole row; below it, `ctx 41%` alone. */
export const CONTEXT_FULL_COLUMNS = 100;

/**
 * TUI-DESIGN-5 §2.2: what the peer zone reads about **this** session. Coordination's `SelfIdentity`
 * (`src/coordination/types.ts:369`) satisfies it structurally, so `src/cli/session.ts` passes the one the ledger
 * already built — and the zone never sees `hostKey`, a device-secret derivative (§7 row 61). It is deliberately
 * **not** `SelfIdentityView` (§8.1 item 4), which carries no `runId`/`sessionId` and so cannot exclude my own row.
 */
export interface PeerZoneSelf {
  readonly deviceId: string;
  readonly runId: string | null;
  readonly sessionId: string | null;
}

/**
 * TUI-DESIGN-5 §2.2: what the zone excludes when the host has not said who it is — nothing. A `deviceId` no
 * record can carry, and no run or session of my own, so every live row and every message is counted. It is the
 * conservative direction: over-counting shows a peer that is me, under-counting hides one that is not.
 */
const NO_SELF: PeerZoneSelf = { deviceId: '', runId: null, sessionId: null };

/** TUI-DESIGN-5 §2.2: the three numbers the segment renders, so the counting rule is testable without a glyph set. */
export interface PeerZoneCounts {
  readonly live: number;
  readonly headsUp: number;
  readonly mail: number;
}

/**
 * TUI-DESIGN-5 §2.2: `fold.liveness`, `fold.inbox` and `fold.acks`, counted. Pure, no clock — the fold's watcher
 * already maintains it (§7 rows 1, 2: before `open()` every map is empty and every count is 0).
 *
 * - **live**: every `Fold.live` row that is not my own run and whose `Fold.liveness` verdict is `'live'`. A row with
 *   no verdict is counted (unknown stays permissive, the rule `hostKey`/`bootId` follow); a `stale`, `gone`,
 *   `stale-reused-pid` or `unknown` verdict is not (§12 S3, S3a, S3b are `/who` rows, not this cell).
 * - **unread**: a message with no ack from **this device** in `fold.acks` — never a content comparison (§2.1 rule 4).
 *   My own messages, which come back through `@all`, are excluded by `from.deviceId` + `from.sessionId`.
 * - **headsUp** counts `type === 'heads-up'`; **mail** counts **everything else unread**. The split is `if/else`, so
 *   the two clauses never double-count one message AND — the fix pass — never drop one either: `MessageType` has
 *   fifteen members, and an earlier rule that counted only `heads-up` and only DIRECTED messages made an unread
 *   `note` / `request-release` / `who` broadcast to `@repoKey` invisible in both clauses. `✉` means "messages
 *   waiting for you, `/inbox` reads them", which a repo-wide `note` is.
 */
export function peerZoneCounts(fold: Fold, self: PeerZoneSelf): PeerZoneCounts {
  let live = 0;
  for (const hb of fold.live.values()) {
    if (self.runId !== null && hb.runId === self.runId) continue;
    const verdict = fold.liveness.get(`${hb.deviceId}/${hb.runId}/${hb.pid}`);
    if (verdict !== undefined && verdict !== 'live') continue;
    live++;
  }
  let headsUp = 0;
  let mail = 0;
  for (const msg of fold.inbox) {
    if (msg.from.deviceId === self.deviceId && msg.from.sessionId === self.sessionId) continue;
    const acks = fold.acks.get(msg.id) ?? [];
    if (acks.some((a) => a.deviceId === self.deviceId)) continue;
    if (msg.type === 'heads-up') headsUp++;
    else mail++;
  }
  return { live, headsUp, mail };
}

/**
 * TUI-DESIGN-5 §2.2 / §12 S6: `⇄ 2 live · 1 heads-up · ✉ 1`, three rungs and not one gate.
 *
 * `columns < PEERS_MIN_COLUMNS` → '' (the segment as a whole); `< HEADSUP_MIN_COLUMNS` → the heads-up clause drops
 * (`⇄ 2 live · ✉ 1`); at or above it the whole row. A clause whose count is 0 is **absent**, never `⇄ 0 live`, and
 * all three at 0 is ''. Every glyph comes from the set (`⇄` → `<>`, `✉` → `mail`, `·` → `-` under `--ascii`) —
 * never a literal here (§7 row 40 is the same defect for `·`).
 */
export function peerZoneText(fold: Fold, self: PeerZoneSelf, g: GlyphSet, columns: number): string {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (cols < PEERS_MIN_COLUMNS) return '';
  const { live, headsUp, mail } = peerZoneCounts(fold, self);
  const parts: string[] = [];
  if (live > 0) parts.push(`${g.peers} ${live} live`);
  if (headsUp > 0 && cols >= HEADSUP_MIN_COLUMNS) parts.push(`${headsUp} heads-up`);
  if (mail > 0) parts.push(`${g.mail} ${mail}`);
  return parts.join(` ${g.dot} `);
}

/**
 * **TUI-DESIGN-5 §12 "superseded, not kept" (§14.2 #10): this is no longer a status segment.** The right zone's
 * peer cell is `peerZoneText` (`⇄ 2 live · 1 heads-up · ✉ 1`, §12 S6), because the round-5 cell carries unread
 * message counts that TD4's bare count cannot express, and nothing pushes this into `rightZoneSegments` any more.
 *
 * **It has no caller in `src/` (stated, not implied).** `/peers` builds its own block in `src/cli/session.ts`
 * (`block('peers', …)`), which is R5-1's file; this function is retained as the one home of TD4 §7.10's `<n> here
 * · <m> stale` string for the `--plain` twin and its tests, and R5-1 may route `/peers`' head through it so the
 * string stays in one place (recorded as a request in R5-2's report). An earlier version of this comment claimed
 * `/peers` already called it, which is the kind of stale claim §13.4's anchor discipline exists to prevent.
 *
 * TUI-DESIGN-4 §7.10 item 1 / §12: the peer segment — `<n> here` when another instance holds this workspace, plus
 * `· <m> stale` when the registry still lists entries from killed instances. Empty when this is the only instance
 * (`live <= 1`) and nothing is stale, or when the registry is absent. Counts only: a pid or a path would identify
 * another user's process, and two instances by the same user in one multiplexer is the common case (edge 6), so
 * the copy is informational and never a warning colour.
 */
export function peersText(view: PeerView | null | undefined): string {
  if (view === null || view === undefined) return '';
  const here = Number.isFinite(view.live) ? Math.max(0, Math.floor(view.live)) : 0;
  const stale = Number.isFinite(view.stale) ? Math.max(0, Math.floor(view.stale)) : 0;
  /**
   * §7.10 item 1 is explicit: the segment exists "**when another instance holds the same workspace**". A
   * workspace whose only peers are dead registry rows is NOT shared, so `{ live: 1, stale: 2 }` shows nothing —
   * the stale count belongs to `/peers` and to the blocking pane (edge 1), which is where `[c] continue` is.
   */
  if (here <= 1) return '';
  const parts: string[] = [`${here} here`];
  if (stale > 0) parts.push(`${stale} stale`);
  return parts.join(' · ');
}

/**
 * TUI-DESIGN §24: `? help` / `Tab ⇥` / `Esc closes`; '' for overlays whose own rows list the keys (wizard,
 * follow-up, secret gate, blocking pane, undo prompt). The exit confirm keeps `? help` (F-W). Under --ascii
 * the palette hint is `Tab` (§14.1's table has no `⇥` twin).
 */
export function shortHelp(s: StatusLineState, ascii = false): string {
  if (s.overlay === 'palette') return ascii ? 'Tab' : 'Tab ⇥';
  if (s.picker === true) return 'Esc closes';
  if (s.overlay === 'none' || s.overlay === 'review' || s.overlay === 'exitConfirm') return '? help';
  return '';
}

function runSnapshot(s: StatusLineState): SpendSnapshot | null {
  return s.spend.run ?? s.status?.spend ?? null;
}

function wallOf(s: StatusLineState): number | null {
  if (s.wallMs !== undefined && s.wallMs !== null && Number.isFinite(s.wallMs)) return s.wallMs;
  if (s.status !== null) return s.status.wallMs;
  if (s.done !== null) return s.done.wallMs;
  return null;
}

/** TUI-DESIGN §7.4 / §9.5: `gen 5.5k jev 28k` (jev-only: `jev 28k`); under a token cap `gen 43.1k/133k tok`. */
export function tokensText(s: StatusLineState, snap: SpendSnapshot | null): string {
  const gt = s.status?.generatorTokens;
  if (gt !== undefined && gt.cap !== null && Number.isFinite(gt.cap)) return `gen ${kShort(gt.used)}/${kShort(gt.cap)} tok`;
  if (snap === null) return '';
  const gen = snap.generator.inputTokens + snap.generator.outputTokens;
  const jev = snap.jev.inputTokens + snap.jev.outputTokens;
  if (s.mode === 'jev-only') return `jev ${kShort(jev)}`;
  // AGENT-LOOP-DESIGN §14.3 item 2: no `jev …` token segment in agent mode (a normal agent run makes no Jev request)
  if (s.mode === 'agent') return `gen ${kShort(gen)}`;
  return `gen ${kShort(gen)} jev ${kShort(jev)}`;
}

/** TUI-DESIGN §7.4: the right-zone segments in order, before any drop (each already width-gated by `columns`). */
export function rightZoneSegments(s: StatusLineState, columns: number, o: StatusLineOptions = {}): { segments: Segment[]; wall: string } {
  const ascii = o.ascii === true;
  const segments: Segment[] = [];
  const maxSteps = s.status?.maxSteps ?? s.ready?.maxSteps ?? null;
  const wall = wallOf(s);
  const wallStr = wall === null ? '' : wallText(wall);
  segments.push(seg('step', stepText(stepOf(s), maxSteps, ascii)));
  const snap = runSnapshot(s);
  const bars = columns >= METER_BAR_MIN_COLUMNS;
  if (snap !== null) segments.push(seg('run', meterText('run', snap.totalUsd, snap.capUsd, { exceeded: snap.exceeded, bar: bars, ascii })));
  // TUI-DESIGN-5 §2.2 / §4.4 (§14.2 #45): agents sit beside `run` because they spend the run's money, and the strip
  // is NOT in `DROP_ORDER` — it is never dropped. R5-4 replaces the read with `agentStripText(...)` (§9.2).
  if (columns >= AGENTS_MIN_COLUMNS) {
    const agents = s.agents ?? '';
    if (agents.length > 0) segments.push(seg('agents', agents));
  }
  if (s.spend.session !== null) {
    const sess = s.spend.session;
    const exceeded = snap?.parentExceeded === true;
    segments.push(seg('sess', meterText('sess', sess.totalUsd, sess.capUsd, { exceeded, bar: bars, ascii })));
  }
  if (columns >= TOKENS_MIN_COLUMNS) {
    const t = tokensText(s, snap);
    if (t.length > 0) segments.push(seg('tokens', t));
  }
  // TUI-DESIGN-5 §2.2: `ctx` and `peers` sit after `tokens` because they are run facts, not workspace facts.
  // §3.1's gate is the width, and it is TWO rungs: below `CONTEXT_MIN_COLUMNS` the cell is absent entirely (never
  // a placeholder, never `ctx —%`). R5-3 replaces the read with `ctxText(s.status.context, columns, g)` (§9.2) —
  // the position and both gates are landed here so the order cannot drift while the two PRs are in flight.
  const gateColumns = o.terminalColumns ?? columns;
  if (gateColumns >= CONTEXT_MIN_COLUMNS) {
    const ctx = s.ctx ?? '';
    if (ctx.length > 0) segments.push(seg('ctx', ctx));
  }
  // TUI-DESIGN-5 §2.2: the FOLD alone is enough. `selfId` only EXCLUDES my own row and my own messages, and
  // `PeerZoneSelf.runId`/`sessionId` are already nullable, so a session with no run has a perfectly good value —
  // requiring it hid `✉` exactly when a peer's message matters most (an idle TUI). The default excludes nothing,
  // which is the honest answer when the caller has not said who it is.
  if (s.fold !== undefined && s.fold !== null) {
    const peerZone = peerZoneText(s.fold, s.selfId ?? NO_SELF, glyphs(ascii), gateColumns);
    if (peerZone.length > 0) segments.push(seg('peers', peerZone));
  }
  if (columns >= GIT_ZONE_MIN_COLUMNS && s.git !== null) {
    const g = gitZoneText(s.git, ascii);
    if (g.length > 0) segments.push(seg('git', g));
  }
  // AGENT-LOOP-DESIGN §14.3 item 2: the Jev sparkline is not drawn in agent mode
  if (columns >= SPARKLINE_MIN_COLUMNS && s.mode !== 'agent' && s.jevLatencies !== undefined && s.jevLatencies.length > 0) segments.push(seg('spark', sparklineText(s.jevLatencies, ascii)));
  const help = shortHelp(s, ascii);
  if (help.length > 0) segments.push(seg('help', help));
  const secret = secretBadge(s, ascii);
  if (secret.length > 0) segments.push(seg('secret', secret));
  return { segments, wall: wallStr };
}

/**
 * TUI-DESIGN §7.4 / §14.1: the centre zone's text — the `/rename` title in quotes (one line, no controls, no bidi or format
 * characters), else ''. TUI-DESIGN-3 §5.1 rule 7: never the run id (it lives in `[run] start` and the epilogue's `run` row).
 */
export function centreText(s: StatusLineState, ascii = false): string {
  const title = typeof s.title === 'string' ? oneLineSafe(s.title).trim() : '';
  if (title.length > 0) return `"${ascii ? asciiFold(title) : title}"`;
  return '';
}

/** TUI-DESIGN §7.4: the three zones after the drop order was applied; `right` is the list of surviving segment texts. */
export interface StatusZones {
  left: string;
  centre: string;
  right: string[];
  /**
   * which drops were needed to fit. TUI-DESIGN-5 §8.1 item 10: a **separately spelled** union that `dropped.push(d)`
   * writes `DROP_ORDER`'s members into, so it gains `'ctx'` with the context cell or the push does not compile.
   * `'agents'` is never here — the strip is not in `DROP_ORDER`.
   */
  dropped: ('badge' | 'ctx' | 'peers' | 'help' | 'spark' | 'git' | 'sess' | 'wall' | 'centre')[];
}

/** The usable width: NaN and negatives → 0, +Infinity and anything absurd → `MAX_COLUMNS`, fractions floored. */
function clampColumns(columns: number): number {
  if (!Number.isFinite(columns)) return columns === Number.POSITIVE_INFINITY ? MAX_COLUMNS : 0;
  return Math.max(0, Math.min(MAX_COLUMNS, Math.floor(columns)));
}

/** TUI-DESIGN §7.4: zone computation shared by `statusLineText` and its tests/twins. */
export function statusZones(s: StatusLineState, columns: number, o: StatusLineOptions = {}): StatusZones {
  const cols = clampColumns(columns);
  const ascii = o.ascii === true;
  let word = leftZoneText(s, o);
  const prefix = flatBadgePrefix(s, o);
  let left = `${prefix}${word}`;
  let leftWidth = stringWidth(left);
  const { segments, wall } = rightZoneSegments(s, cols, o);
  const dropped: StatusZones['dropped'] = [];
  const stepSeg = segments.find((x) => x.id === 'step')!;
  const wallWidth = wall.length > 0 ? 1 + stringWidth(wall) : 0;
  let wallOn = wall.length > 0;
  const rightTexts = (): string[] => segments.map((x) => (x.id === 'step' && wallOn ? `${x.text} ${wall}` : x.text));
  const rightWidth = (): number => segments.reduce((w, x) => w + x.width, wallOn ? wallWidth : 0) + ZONE_GAP * Math.max(0, segments.length - 1);
  const fits = (): boolean => leftWidth + ZONE_GAP + rightWidth() <= cols;
  const dropSeg = (id: SegmentId): boolean => {
    const i = segments.findIndex((x) => x.id === id);
    if (i === -1) return false;
    segments.splice(i, 1);
    return true;
  };
  // AGENT-LOOP-DESIGN §A5: the wide mini indicator gives its two extra cells back before anything else is dropped
  if (canNarrow(o) && !fits()) {
    word = leftZoneText(s, o, true);
    left = `${prefix}${word}`;
    leftWidth = stringWidth(left);
  }
  // TUI-DESIGN-2 §1.5: the flat-tier badge yields before `help`
  if (prefix !== '' && !fits()) {
    left = word;
    leftWidth = stringWidth(left);
    dropped.push('badge');
  }
  for (const d of DROP_ORDER) {
    if (fits()) break;
    if (d === 'wall') {
      if (wallOn) {
        wallOn = false;
        dropped.push('wall');
      }
      continue;
    }
    if (dropSeg(d)) dropped.push(d);
  }
  if (!fits()) {
    // the left zone yields last: keep the sentinel, the run meter and the secret badge whole when at all possible
    const room = cols - ZONE_GAP - rightWidth();
    if (room >= 4) left = truncateStatus(left, room, ascii);
    else {
      for (const id of ['tokens', 'run'] as const) if (!fits()) dropSeg(id);
      const roomNow = cols - ZONE_GAP - rightWidth();
      if (roomNow >= 4) left = truncateStatus(left, roomNow, ascii);
      else {
        dropSeg('secret');
        const last = cols - ZONE_GAP - stepSeg.width;
        left = last >= 4 ? truncateStatus(left, last, ascii) : '';
      }
    }
    leftWidth = stringWidth(left);
  }
  let centre = '';
  const free = cols - leftWidth - rightWidth() - 2 * ZONE_GAP;
  const wanted = centreText(s, ascii);
  if (wanted.length > 0) {
    if (free >= CENTRE_MIN_FREE) centre = truncateStatus(wanted, Math.min(free, CENTRE_MAX_CELLS), ascii);
    else dropped.push('centre');
  }
  return { left, centre, right: rightTexts(), dropped };
}

/**
 * TUI-DESIGN §7.4: the status row — left zone, centre (when ≥ 24 cells are free), right zone
 * right-aligned to `columns`; never wider than `columns` (measured in cells by O2's `stringWidth`),
 * '' when `columns` is 0, NaN or negative. The `step N/M` sentinel is always present when anything is.
 */
export function statusLineText(s: StatusLineState, columns: number, o: StatusLineOptions = {}): string {
  return assemble(s, columns, o).text;
}

/** the assembled row plus where its parts landed (string indices), so `statusSpans` colours the words without re-deriving the text */
interface Assembled {
  text: string;
  zones: StatusZones | null;
  /** index of the left zone (always 0 when present; -1 when the left zone was dropped) */
  leftAt: number;
  /** index of each surviving right segment's text, aligned with `zones.right`; empty when the right zone was cut */
  rightAt: number[];
}

function assemble(s: StatusLineState, columns: number, o: StatusLineOptions = {}): Assembled {
  const cols = clampColumns(columns);
  const none: Assembled = { text: '', zones: null, leftAt: -1, rightAt: [] };
  if (cols <= 0) return none;
  const ascii = o.ascii === true;
  const z = statusZones(s, cols, o);
  const right = z.right.join(' '.repeat(ZONE_GAP));
  const lw = stringWidth(z.left);
  const rw = stringWidth(right);
  if (lw + rw === 0) return none;
  const segmentsAt = (rightStart: number): number[] => {
    const out: number[] = [];
    let at = rightStart;
    for (const seg of z.right) {
      out.push(at);
      at += seg.length + ZONE_GAP;
    }
    return out;
  };
  if (lw === 0) {
    if (rw <= cols) {
      const pad = ' '.repeat(cols - rw);
      return { text: `${pad}${right}`, zones: z, leftAt: -1, rightAt: segmentsAt(pad.length) };
    }
    return { text: truncateStatus(right, cols, ascii), zones: z, leftAt: -1, rightAt: [] };
  }
  if (lw + ZONE_GAP + rw > cols) {
    // only reachable when even the sentinel alone does not fit: keep as much of it as the row allows
    return { text: truncateStatus(z.left.length > 0 ? `${z.left}  ${right}` : right, cols, ascii), zones: z, leftAt: z.left.length > 0 ? 0 : -1, rightAt: [] };
  }
  const gap = cols - lw - rw;
  if (z.centre.length > 0) {
    const cw = stringWidth(z.centre);
    const before = Math.floor((gap - cw) / 2);
    const after = gap - cw - before;
    const head = `${z.left}${' '.repeat(before)}${z.centre}${' '.repeat(after)}`;
    return { text: `${head}${right}`, zones: z, leftAt: 0, rightAt: segmentsAt(head.length) };
  }
  const head = `${z.left}${' '.repeat(gap)}`;
  return { text: `${head}${right}`, zones: z, leftAt: 0, rightAt: segmentsAt(head.length) };
}

// ---------------------------------------------------------------------------------------
// Spans (TUI-DESIGN-3 §5.2 P6, D-P): the coloured parts of the row — never the whole row
// ---------------------------------------------------------------------------------------

/** A half-open span of `text` (string indices) and the colour role it takes. */
export interface StatusSpan {
  from: number;
  to: number;
  role: ColorRole;
  /** the span is drawn bold too (the done word) */
  bold?: boolean;
}

export interface StatusSpans {
  /** `statusLineText(state, columns, o)` — the same string, byte for byte */
  text: string;
  /** ascending, non-overlapping */
  spans: StatusSpan[];
}

/** TUI-DESIGN-3 §5.2 P6 / D-P: the meter word's role — `high` warns, `critical` and `over` are errors, the rest is plain. */
export function meterWordRole(word: string): ColorRole | null {
  if (word === 'high') return 'warn';
  if (word === 'critical' || word === 'over') return 'error';
  return null;
}

/**
 * TUI-DESIGN-3 §5.2 P6 (D-P): the status row as text plus the spans that carry colour — the leading spinner glyph
 * (`accent`), the left word once a run ended (`ok` for `complete`, `warn` otherwise, bold), a toast by its level (A7:
 * `dim` in its last second), the flat tier's badge prefix (`badge`), the meter words (`high` → `warn`, `critical` /
 * `over` → `error`) and `⚠ secret?` (`secret`). Everything else stays the terminal's default foreground: the status is
 * a fact. `text` equals `statusLineText` for the same inputs.
 */
export function statusSpans(s: StatusLineState, columns: number, o: StatusLineOptions = {}): StatusSpans {
  const a = assemble(s, columns, o);
  const spans: StatusSpan[] = [];
  if (a.zones === null) return { text: a.text, spans };
  const ascii = o.ascii === true;
  const g = glyphs(ascii);
  if (a.leftAt === 0) {
    const left = a.zones.left;
    const toast = activeToast(s.toasts, s.nowMs);
    const prefix = a.zones.dropped.includes('badge') ? '' : flatBadgePrefix(s, o);
    const badgeWord = prefix === '' ? '' : prefix.slice(0, prefix.length - ` ${g.dot} `.length);
    if (badgeWord !== '' && left.startsWith(badgeWord)) spans.push({ from: 0, to: badgeWord.length, role: 'badge' });
    const wordAt = left.startsWith(prefix) ? prefix.length : 0;
    const word = left.slice(wordAt);
    if (toast !== null) {
      const role: ColorRole = toastPhase(toast, s.nowMs) === 'fading' ? 'dim' : toastRole(toast.level);
      if (word.length > 0) spans.push({ from: wordAt, to: wordAt + word.length, role });
    } else {
      // AGENT-LOOP-DESIGN §A3: the mini indicator sits where the spinner glyph sat and takes the same colour
      const mini = [o.indicatorWide, o.indicatorNarrow].find((f) => f !== undefined && f !== '' && word.startsWith(`${f} `)) ?? null;
      const spinner = mini ?? (o.reducedMotion === true ? g.spinnerStatic : (g.spinner.find((f) => word.startsWith(`${f} `)) ?? null));
      if (spinner !== null && word.startsWith(`${spinner} `)) spans.push({ from: wordAt, to: wordAt + spinner.length, role: 'accent' });
      else if (s.run === 'none' && s.done !== null && s.overlay === 'none' && s.picker !== true) {
        const idle = leftZoneWord(s, o);
        if (word.startsWith(idle) && idle.length > 0) spans.push({ from: wordAt, to: wordAt + idle.length, role: s.done.stopReason === 'complete' ? 'ok' : 'warn', bold: true });
      }
    }
  }
  a.zones.right.forEach((seg, i) => {
    const at = a.rightAt[i];
    if (at === undefined) return;
    if (seg.startsWith('run $') || seg.startsWith('sess $')) {
      const sp = seg.lastIndexOf(' ');
      const word = seg.slice(sp + 1);
      const role = meterWordRole(word);
      if (role !== null) spans.push({ from: at + sp + 1, to: at + seg.length, role });
    } else if (seg === secretBadge(s, ascii) && seg.length > 0) spans.push({ from: at, to: at + seg.length, role: 'secret' });
  });
  return { text: a.text, spans: spans.filter((x) => x.to > x.from && x.to <= a.text.length).sort((x, y) => x.from - y.from) };
}
