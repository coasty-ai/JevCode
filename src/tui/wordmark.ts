/**
 * The persistent wordmark (TUI-DESIGN-3 §3, D-I): the pane slot's idle tenant — the 5-row mark of `splash.ts` held
 * after the reveal, whole or absent (`computeLayout` 1.2 `paneWhole`), shown while idle and thinking, hidden while a
 * run is live or a panel / picker / review owns the slot, back under the strip after `run:end`. This module is the pure
 * half: the visibility selector `wordmarkWanted` (the WANT; the layout decides the SHOW), the idle sweep's band table
 * `loopBand(k)` and the one constants table the owner can flip (§3.4), the caption / tagline geometry (re-exported from
 * `splash.ts`, which owns the grid — one import direction, no cycle) and `wordmarkFrame`, the rows + `spans(band)` the
 * App renders. No clock, no I/O, no Ink (`motion.ts` drives the loop). Pure.
 */
import type { OverlayKind } from './layout.js';
import type { PanelState, RunPhase } from './useEngine.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { CAPTION_GRID_CELL, SWEEP_CELLS, TAGLINE, TAGLINE_MIN_COLUMNS, WORDMARK_CELLS, WORDMARK_MIN_COLUMNS, captionFits, captionText, restingFrame, taglineFits, type GridBand, type RestingFrame, type SplashSpan } from './splash.js';

export { CAPTION_GRID_CELL, TAGLINE, TAGLINE_MIN_COLUMNS, WORDMARK_MIN_COLUMNS, captionFits, captionText, taglineFits };
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
/** §3.2: the mark returns right after `run:end` only when the 8-row epilogue still fits above it */
export const WORDMARK_POST_RUN_MIN_ROWS = 24;

/** TUI-DESIGN-3 §3.1: every input already exists in `UiState` / the App. */
export interface WordmarkInput {
  /** `chromeRows(rows, columns, screenReader) === CAP.chrome` */
  boxed: boolean;
  /** ≥ `WORDMARK_MIN_ROWS` (21) */
  rows: number;
  /** `ranBefore && !postRunKeySeen`: after `run:end` the mark returns at once only at rows ≥ `WORDMARK_POST_RUN_MIN_ROWS`; below, on the first key */
  postRun: boolean;
  /** ≥ `WORDMARK_MIN_COLUMNS` (64) */
  columns: number;
  /** never under a screen reader (already flat; kept explicit) */
  screenReader: boolean;
  /** hidden while `runIsLive(run)`: `live` | `aborting` | `pausing`; `starting` (thinking) keeps it */
  run: RunPhase;
  /** only while `collapsed` */
  panel: PanelState;
  /** the picker owns the slot */
  pickerOpen: boolean;
  /** hidden for `review` (the review reclaims rows, TD A42); every other overlay keeps it if 5 whole rows remain */
  overlay: OverlayKind;
  /** review `e`: pane is 0 anyway */
  expanded: boolean;
  /** `off` → never */
  setting: WordmarkSetting;
}

/** TUI-DESIGN-2 §3.1 / TUI-DESIGN-3 §3.1: an engine run owns the session — `live`, `aborting`, `pausing` (`starting` is a submission in flight). */
function runIsLive(run: RunPhase): boolean {
  return run === 'live' || run === 'aborting' || run === 'pausing';
}

/**
 * TUI-DESIGN-3 §3.1: the WANT — true iff `boxed ∧ rows ≥ 21 ∧ columns ≥ 64 ∧ ¬screenReader ∧ ¬runIsLive(run) ∧ panel === 'collapsed'
 * ∧ ¬pickerOpen ∧ overlay ≠ 'review' ∧ ¬expanded ∧ setting ≠ 'off' ∧ (rows ≥ 24 ∨ ¬postRun)`. The layout's whole-or-absent grant decides the SHOW.
 */
export function wordmarkWanted(i: WordmarkInput): boolean {
  const rows = Number.isFinite(i.rows) ? Math.floor(i.rows) : 0;
  const columns = Number.isFinite(i.columns) ? Math.floor(i.columns) : 0;
  return (
    i.boxed &&
    rows >= WORDMARK_MIN_ROWS &&
    columns >= WORDMARK_MIN_COLUMNS &&
    !i.screenReader &&
    !runIsLive(i.run) &&
    i.panel === 'collapsed' &&
    !i.pickerOpen &&
    i.overlay !== 'review' &&
    !i.expanded &&
    i.setting !== 'off' &&
    (rows >= WORDMARK_POST_RUN_MIN_ROWS || !i.postRun)
  );
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
