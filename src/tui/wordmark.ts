/**
 * The wordmark (TUI-DESIGN-3 §3, D-I; owner directives 2–3, 2026-09; the owner's directive of 2026-09-23 "keep jevcode
 * branding on top only … chats appear after that"): the 5-row mark of `splash.ts`. In the classic (inline) renderer
 * the splash animates in the dynamic region for its short window and the SETTLED mark is then committed ONCE as the
 * first `<Static>` block of the session — every message lands below it and the console stays at the bottom; a long
 * session scrolls it off the top like any scrollback. The opt-in fullscreen renderer keeps it in its header slot
 * (`wordmarkBoxRows`, directive 3's height ladder). This module is the pure half: `wordmarkWanted` (WHETHER the
 * session commits a mark — a width rule; the old height tiers were only ever about dynamic rows), the committed
 * block's padding (`scrollbackMarkPad`), the idle sweep's band table `loopBand(k)` (fullscreen's header only — a
 * committed mark is never repainted) and the one constants table the owner can flip (§3.4), the caption / tagline
 * geometry (re-exported from `splash.ts`, which owns the grid — one import direction, no cycle) and `wordmarkFrame`,
 * the rows + `spans(band)` the App renders. No clock, no I/O, no Ink (`motion.ts` drives the loop). Pure.
 */
import type { RunPhase } from './useEngine.js';
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
/** directive 3 ("a lot of spacing in the branding box"): one blank row above and below the glyph rows from here up */
export const WORDMARK_PAD_MIN_ROWS = 26;
/** …and two blank rows above and below from here up */
export const WORDMARK_PAD2_MIN_ROWS = 34;

/** Every input already exists in `UiState` / the App. */
export interface WordmarkInput {
  /** `chromeRows(rows, columns, screenReader) === CAP.chrome` — the boxed tier (≥ 16 rows, ≥ 40 columns, no screen reader) */
  boxed: boolean;
  /** ≥ `WORDMARK_MIN_COLUMNS` (64) */
  columns: number;
  /** never under a screen reader (already flat; kept explicit) */
  screenReader: boolean;
  /** `off` → never */
  setting: WordmarkSetting;
}

/** TUI-DESIGN-2 §3.1 / TUI-DESIGN-3 §3.1: an engine run owns the session — `live`, `aborting`, `pausing` (`starting` is a submission in flight). */
export function runIsLive(run: RunPhase): boolean {
  return run === 'live' || run === 'aborting' || run === 'pausing';
}

/**
 * WHETHER the session's mark is drawn (the owner's directive of 2026-09-23) — true iff `boxed ∧ columns ≥ 64 ∧
 * ¬screenReader ∧ setting ≠ 'off'`. The classic renderer evaluates it ONCE, at the commit (the settle, the first
 * submit or the first `<Static>` item, whichever comes first), and commits the mark to the scrollback then or never —
 * a terminal that widens later never drops a mark into the middle of the transcript. The pinned mark's height rules
 * (21 rows; a panel / picker / review taking its rows below 30) existed because the mark held DYNAMIC rows; a
 * committed mark holds none, so only the width tier and the boxed tier's own 16-row floor remain.
 */
export function wordmarkWanted(i: WordmarkInput): boolean {
  const columns = Number.isFinite(i.columns) ? Math.floor(i.columns) : 0;
  return i.boxed && columns >= WORDMARK_MIN_COLUMNS && !i.screenReader && i.setting !== 'off';
}

/** directive 3: the blank rows drawn above AND below the glyph rows at a terminal height — 0 · 1 · 2 (the fullscreen header's box). */
export function wordmarkPad(rows: number): 0 | 1 | 2 {
  const r = Number.isFinite(rows) ? Math.floor(rows) : 0;
  if (r >= WORDMARK_PAD2_MIN_ROWS) return 2;
  if (r >= WORDMARK_PAD_MIN_ROWS) return 1;
  return 0;
}

/** directive 3: the fullscreen header's branding box — `WORDMARK_ROWS + 2 · wordmarkPad(rows)` (5 · 7 · 9). */
export function wordmarkBoxRows(rows: number): number {
  return WORDMARK_ROWS + 2 * wordmarkPad(rows);
}

/**
 * The committed (scrollback) block's blank rows above AND below the glyph rows — `max(1, wordmarkPad(rows))`, 1 · 2.
 * The scrollback's grammar is one blank row between blocks (TUI-DESIGN-3 §5.1 rule 9), so the mark never touches the
 * shell's prompt line above it or the first `[you]` bubble below it; directive 3's two rows hold from
 * `WORDMARK_PAD2_MIN_ROWS` up. The classic splash box takes the same rows, so the commit moves no console row.
 */
export function scrollbackMarkPad(rows: number): 1 | 2 {
  return wordmarkPad(rows) === 2 ? 2 : 1;
}

/** The committed block's height — `WORDMARK_ROWS + 2 · scrollbackMarkPad(rows)` (7 · 9); the classic splash box's want. */
export function scrollbackMarkRows(rows: number): number {
  return WORDMARK_ROWS + 2 * scrollbackMarkPad(rows);
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
