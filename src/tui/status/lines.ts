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
   */
  readonly peers?: PeerView | null;
}

/** TUI-DESIGN-2 §4.8: the three phases between Enter and a reply. */
export type ThinkingPhase = 'intake' | 'lookup' | 'replying';
/** TUI-DESIGN-2 §4.8 / §12 "Status": the left words per phase (`asking` is the `intake` overlay's word). */
export const THINKING_WORDS: Readonly<Record<ThinkingPhase, string>> = { intake: 'thinking', lookup: 'looking', replying: 'replying' };
/** TUI-DESIGN-2 §3.7 / §12: the left word while the intake card asks `run this as a task?`. */
export const ASKING_WORD = 'asking';

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
export function leftZoneWord(s: StatusLineState, o: StatusLineOptions = {}): string {
  const word = leftWord(s, o);
  return o.ascii === true ? asciiFold(word) : word;
}

function leftWord(s: StatusLineState, o: StatusLineOptions): string {
  if (s.overlay === 'wizard') return 'setup';
  if (s.overlay === 'palette') return 'palette';
  // TUI-DESIGN-2 §3.7 / §4.8: the intake card owns the left word
  if (s.overlay === 'intake') return ASKING_WORD;
  if (s.picker === true) return 'picker';
  if (s.run === 'aborting') return 'aborting';
  if (s.run === 'pausing') return `pausing after step ${stepOf(s)}`;
  // TUI-DESIGN-2 §3.1 row 1 / §4.8: between Enter and the reply — `⠹ thinking` · `⠹ looking` · `⠹ replying` (`• thinking`
  // under reduced motion). The submission runs under `run: 'starting'` until the reply or `run:start` (§3.1 row 5), so the
  // chat phase wins over the bare `starting` word; a live run never carries a phase (the controller refuses `converse` then)
  if (s.thinking !== undefined && s.thinking !== null && (s.run === 'none' || s.run === 'starting')) return `${spinnerGlyph(o)} ${THINKING_WORDS[s.thinking]}`;
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
  const stage = s.status?.stage ?? 'idle';
  if (stage === 'idle') return 'starting';
  if (s.stageStartedAt !== null && Number.isFinite(s.nowMs) && s.nowMs - s.stageStartedAt >= STILL_WAITING_MS) return 'still waiting';
  const verb = stage === 'propose' && s.mode === 'jev-only' ? `propose ${SYNTH_MARKER}` : STEP_WORDS.includes(stage) ? stage : String(stage);
  return `${spinnerGlyph(o)} ${verb}`;
}

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
export function leftZoneText(s: StatusLineState, o: StatusLineOptions = {}): string {
  const toast = activeToast(s.toasts, s.nowMs);
  if (toast !== null) return toastText(toast, o.ascii === true);
  return [leftZoneWord(s, o), ...badges(s)].join(' ');
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

type SegmentId = 'step' | 'run' | 'sess' | 'tokens' | 'git' | 'spark' | 'help' | 'secret' | 'peers';
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
 * TUI-DESIGN §7.4 drop order when short: the peer count → ShortHelp → sparkline → git → session meter → wall (→
 * centre, which needs ≥ 24 free cells anyway); the flat-tier badge prefix goes before all of them (TUI-DESIGN-2
 * §1.5). TUI-DESIGN-4 §7.10 edge 2 puts `peers` **first**: it is informational, and the run's own numbers are not.
 */
export const DROP_ORDER: readonly ('peers' | 'help' | 'spark' | 'git' | 'sess' | 'wall')[] = ['peers', 'help', 'spark', 'git', 'sess', 'wall'];

/**
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
  if (s.spend.session !== null) {
    const sess = s.spend.session;
    const exceeded = snap?.parentExceeded === true;
    segments.push(seg('sess', meterText('sess', sess.totalUsd, sess.capUsd, { exceeded, bar: bars, ascii })));
  }
  if (columns >= TOKENS_MIN_COLUMNS) {
    const t = tokensText(s, snap);
    if (t.length > 0) segments.push(seg('tokens', t));
  }
  if (columns >= GIT_ZONE_MIN_COLUMNS && s.git !== null) {
    const g = gitZoneText(s.git, ascii);
    if (g.length > 0) segments.push(seg('git', g));
  }
  if (columns >= SPARKLINE_MIN_COLUMNS && s.jevLatencies !== undefined && s.jevLatencies.length > 0) segments.push(seg('spark', sparklineText(s.jevLatencies, ascii)));
  // TUI-DESIGN-4 §7.10 item 1: the peer count sits before ShortHelp and is the first segment dropped (edge 2)
  const peers = peersText(s.peers);
  if (peers.length > 0) segments.push(seg('peers', peers));
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
  /** which drops were needed to fit */
  dropped: ('badge' | 'peers' | 'help' | 'spark' | 'git' | 'sess' | 'wall' | 'centre')[];
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
  const word = leftZoneText(s, o);
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
      const spinner = o.reducedMotion === true ? g.spinnerStatic : g.spinner.find((f) => word.startsWith(`${f} `)) ?? null;
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
