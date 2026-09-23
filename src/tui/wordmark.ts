/**
 * The PINNED wordmark (TUI-DESIGN-3 §3, D-I; owner directive 2, 2026-09): the 5-row mark of `splash.ts` held after
 * the reveal in its own whole-or-absent `mark` slot, up for the WHOLE session — a run, a reply, a stream and every
 * non-review overlay leave it alone, and only a panel / picker / pending review on a terminal too short to stack
 * both (rows < `WORDMARK_SHARE_MIN_ROWS`) takes its rows. Directive 3 pads the box with `wordmarkPad(rows)` blank
 * rows above and below the glyphs. This module is the pure half: the visibility selector `wordmarkWanted` (the WANT; the layout decides the SHOW), the idle sweep's band table
 * `loopBand(k)` and the one constants table the owner can flip (§3.4), the caption / tagline geometry (re-exported from
 * `splash.ts`, which owns the grid — one import direction, no cycle) and `wordmarkFrame`, the rows + `spans(band)` the
 * App renders. No clock, no I/O, no Ink (`motion.ts` drives the loop). Pure.
 */
import type { OverlayKind } from './layout.js';
import type { PanelState, RunPhase } from './useEngine.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { CAPTION_GRID_CELL, SWEEP_CELLS, TAGLINE, TAGLINE_MIN_COLUMNS, WORDMARK_CELLS, WORDMARK_MIN_COLUMNS, WORDMARK_ROWS, captionFits, captionText, restingFrame, taglineFits, type GridBand, type RestingFrame, type SplashSpan } from './splash.js';

export { CAPTION_GRID_CELL, TAGLINE, TAGLINE_MIN_COLUMNS, WORDMARK_MIN_COLUMNS, WORDMARK_ROWS, captionFits, captionText, taglineFits };
export type { GridBand, SplashSpan };

/** TUI-DESIGN-3 §6 item 4 / §3.2 twins: `ui.wordmark` — default `sweep` (`static` under the SSH launch source). */
export type WordmarkSetting = 'sweep' | 'static' | 'off';

// ----- TUI-DESIGN-3 §3.4: the loop's constants (one table; the owner can flip any of them)
/** 4 fps peak; ≥ any render throttle (34 / 67 ms) so no tick is coalesced */
export const LOOP_INTERVAL_MS = 250;
export const LOOP_STEP_CELLS = 4;
/** 6, the splash's */
export const LOOP_BAND_CELLS = SWEEP_CELLS;
/** k = 0..16; 16 visible frames (k = 1..16), the last clears the band */
export const LOOP_PASS_TICKS = 17;
/** → period 10 s while attentive */
export const LOOP_REST_MS = 5_750;
/** → period 30 s after 60 s without activity */
export const LOOP_REST_CALM_MS = 25_750;
export const LOOP_ATTENTIVE_MS = 60_000;
/** static after 10 min of inactivity */
export const LOOP_SLEEP_MS = 600_000;
export const LOOP_QUIET_AFTER_KEY_MS = 3_000;
/** §3.1: below it the boxed tier keeps the brand row (no palette / draft hand-off around every `/` command) */
export const WORDMARK_MIN_ROWS = 21;
/**
 * The PINNED mark (owner directive 2, 2026-09): at and above this many rows an open Jev panel, the session picker
 * and a pending review are drawn **below** the mark (they get their own `pane` slot, the mark keeps `mark`), so the
 * branding heads the pinned region for the whole session. Below it the terminal cannot hold both and the slot's old
 * tenant wins: `mark 7 + panel 6 + rule 1 + chrome 3 + composer 1 + status 1 = 19` leaves 11 rows of conversation at
 * 30 rows, and one row fewer would put the panel's own tab header under the conversation floor.
 */
export const WORDMARK_SHARE_MIN_ROWS = 30;
/** directive 3 ("a lot of spacing in the branding box"): one blank row above and below the glyph rows from here up */
export const WORDMARK_PAD_MIN_ROWS = 26;
/** …and two blank rows above and below from here up */
export const WORDMARK_PAD2_MIN_ROWS = 34;

/** Every input already exists in `UiState` / the App. */
export interface WordmarkInput {
  /** `chromeRows(rows, columns, screenReader) === CAP.chrome` */
  boxed: boolean;
  /** ≥ `WORDMARK_MIN_ROWS` (21) */
  rows: number;
  /** ≥ `WORDMARK_MIN_COLUMNS` (64) */
  columns: number;
  /** never under a screen reader (already flat; kept explicit) */
  screenReader: boolean;
  /** a panel that cannot fit BELOW the mark takes its rows (rows < `WORDMARK_SHARE_MIN_ROWS`) */
  panel: PanelState;
  /** the picker, same rule */
  pickerOpen: boolean;
  /** a `review` overlay, same rule; every other overlay never touches the mark */
  overlay: OverlayKind;
  /** `off` → never */
  setting: WordmarkSetting;
}

/** The overlay / pane tenants that need the mark's rows when the terminal is too short to stack both. */
function claimsMarkSlot(i: WordmarkInput): boolean {
  return i.panel !== 'collapsed' || i.pickerOpen || i.overlay === 'review';
}

/** TUI-DESIGN-2 §3.1 / TUI-DESIGN-3 §3.1: an engine run owns the session — `live`, `aborting`, `pausing` (`starting` is a submission in flight). */
export function runIsLive(run: RunPhase): boolean {
  return run === 'live' || run === 'aborting' || run === 'pausing';
}

/**
 * The PINNED mark's WANT (owner directive 2) — true iff `boxed ∧ rows ≥ 21 ∧ columns ≥ 64 ∧ ¬screenReader ∧
 * setting ≠ 'off'`, **regardless of the run phase, `postRun`, a stream or any non-review overlay**; the only yield is
 * a panel / picker / pending review at fewer than `WORDMARK_SHARE_MIN_ROWS` rows, where the two cannot be stacked.
 * The layout's whole-or-absent grant of the `mark` slot decides the SHOW.
 */
export function wordmarkWanted(i: WordmarkInput): boolean {
  const rows = Number.isFinite(i.rows) ? Math.floor(i.rows) : 0;
  const columns = Number.isFinite(i.columns) ? Math.floor(i.columns) : 0;
  if (!i.boxed || rows < WORDMARK_MIN_ROWS || columns < WORDMARK_MIN_COLUMNS || i.screenReader || i.setting === 'off') return false;
  return !claimsMarkSlot(i) || rows >= WORDMARK_SHARE_MIN_ROWS;
}

/** directive 3: the blank rows drawn above AND below the glyph rows at a terminal height — 0 · 1 · 2. */
export function wordmarkPad(rows: number): 0 | 1 | 2 {
  const r = Number.isFinite(rows) ? Math.floor(rows) : 0;
  if (r >= WORDMARK_PAD2_MIN_ROWS) return 2;
  if (r >= WORDMARK_PAD_MIN_ROWS) return 1;
  return 0;
}

/** directive 3: the whole branding box — `WORDMARK_ROWS + 2 · wordmarkPad(rows)` (5 · 7 · 9), the `mark` slot's want. */
export function wordmarkBoxRows(rows: number): number {
  return WORDMARK_ROWS + 2 * wordmarkPad(rows);
}

/**
 * TUI-DESIGN-3 §3.4: the band of pass tick `k` — `s = −6 + 4k`, cells `[max(0, s), min(56, s + 6))`; null when empty (k = 0 writes
 * nothing, k = 16 clears the band) and outside `0..LOOP_PASS_TICKS − 1`.
 */
export function loopBand(k: number): GridBand | null {
  if (!Number.isFinite(k)) return null;
  const n = Math.floor(k);
  if (n < 0 || n >= LOOP_PASS_TICKS) return null;
  const s = -LOOP_BAND_CELLS + LOOP_STEP_CELLS * n;
  const from = Math.max(0, s);
  const to = Math.min(WORDMARK_CELLS, s + LOOP_BAND_CELLS);
  return to > from ? { from, to } : null;
}

/** TUI-DESIGN-3 §3.4 / §3.8: the rows never depend on the band; `spans(band)` colours them (`loop.band`, never `loopBand(loop.k)`). */
export type WordmarkFrame = RestingFrame;

/** TUI-DESIGN-3 §3.4: the resting mark with the caption `◆ <version>` (when it fits) and the tagline (≥ 104 columns); `rows: []` below 64 columns. */
export function wordmarkFrame(i: { columns: number; version: string; glyphs?: GlyphSet }): WordmarkFrame {
  return restingFrame(i.columns, i.glyphs ?? GLYPHS.unicode, i.version);
}
