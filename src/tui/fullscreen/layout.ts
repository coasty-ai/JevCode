/**
 * TUI-DESIGN-4 §1.3.2 — `computeFullLayout`, the exact-height allocator of the opt-in `ui.renderer: fullscreen`
 * layout. A **second** pure allocator, never merged into `computeLayout` (§1.3.5's discipline: if `ui.renderer` is
 * `classic` the tree is byte-for-byte today's), whose post-condition is
 * `header + rule + overlay + preview + viewport + console === rows` **exactly**, for every input.
 *
 * Why exactness is the single most load-bearing assertion in the renderer: one row of error costs a full-screen clear
 * **per keystroke** (audit A1 §3.2 measured 37 clears for 36 frames when the tree was one row too tall).
 *
 * Priority: status / console floor → rule → console growth → overlay → header (5 → 1 → 0) → viewport.
 *
 * | tier | rows | header | rule | viewport | console |
 * | --- | ---: | ---: | ---: | --- | ---: |
 * | **tall** | ≥ 24 (and ≥ 64 columns) | 5 (the mark) | 1 | `rows − 11` | 5 |
 * | **compact** | 18–23 | 1 (the brand strip) | 1 | `rows − 7` | 5 |
 * | **narrow** | < 64 columns, rows ≥ 18 | 1 (the brand strip) | 1 | `rows − 7` | 5 |
 * | below | — | refuse → classic (§1.3.1) |
 *
 * The `compact` / `narrow` header row **is** §1.2 P-H1's strip, verbatim (`panelStrip` with `brand: true` and the
 * right-aligned position ladder) — there is no second string to specify. Pure: no I/O, no clock, no Ink.
 */
import { CAP, MIN_COLUMNS, MIN_ROWS, WORDMARK_MIN_COLUMNS, chromeRows, isCollapsingOverlay, type OverlayKind } from '../layout.js';

/** §1.3.1: below this many rows `fullscreen` refuses and falls back to `classic`. */
export const FULL_MIN_ROWS = 18;
/** §1.3.1: below this many columns `fullscreen` refuses and falls back to `classic`. */
export const FULL_MIN_COLUMNS = 40;
/** §1.3.2: at and above this many rows (with ≥ 64 columns) the header is the 5-row mark; below it the 1-row brand strip. */
export const FULL_HERO_MIN_ROWS = 24;
/** §1.3.2: the header yields 5 → 1 → 0 before the viewport is cut below this many rows. */
export const FULL_MIN_VIEWPORT_ROWS = 3;

/** §1.3.2: what the fullscreen frame wants; the same quantities `computeLayout` reads, minus the pane (the header owns that slot). */
export interface FullLayoutInput {
  rows: number;
  columns: number;
  overlay: OverlayKind;
  /** review 9 · wizard 2–4 · followup 5 · blocking ≤ 6 · palette 2–8 · undo 3 · exitConfirm 3 · intake 3 */
  overlayWant: number;
  /** review only: `confirmPreviewLines(req).length` */
  previewWant: number;
  /** review `e`: the preview may take the viewport's rows */
  expanded: boolean;
  /** visual rows of the draft, ≥ 1 */
  composerWant: number;
  /** the secret-gate row the console hosts */
  gate: 0 | 1;
  /** the screen reader never reaches here (§1.3.1 refuses), but the tier function is shared */
  screenReader?: boolean;
}

/** §1.3.2: rows granted to every fullscreen slot. `total === rows` exactly, always. */
export interface FullLayout {
  /** 5 (the mark) · 1 (the brand strip) · 0 */
  header: number;
  /** the rule row with the brand prefix and the right-aligned position segment */
  rule: number;
  /** the modal slot, above the console exactly as in classic */
  overlay: number;
  preview: number;
  /** the scrolled transcript — everything left over, never negative */
  viewport: number;
  /** `chrome + composer + status` (5 in every shippable tier) */
  console: number;
  chrome: 0 | 3;
  gate: 0 | 1;
  /** the composer rows incl. the hosted gate row */
  composer: number;
  status: number;
  /** `header + rule + overlay + preview + viewport + console` — **always** `rows` (0 for a non-finite / negative size) */
  total: number;
  degraded: 'none' | 'compact' | 'minsize';
}

/** a non-finite size is treated as absent (0 rows), exactly like `computeLayout`'s `size()` */
function size(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * §1.3.2: the allocator. Post-condition `total === rows` for **every** input (0 when `rows` is 0 or non-finite);
 * yields in the order header → overlay → composer growth, and never lets a slot go negative.
 */
export function computeFullLayout(i: FullLayoutInput): FullLayout {
  const rows = size(i.rows);
  const columns = size(i.columns);
  let rem = rows;
  const take = (want: number): number => {
    const w = Number.isFinite(want) ? Math.max(0, Math.floor(want)) : 0;
    const got = Math.min(w, rem);
    rem -= got;
    return got;
  };
  const z: FullLayout = { header: 0, rule: 0, overlay: 0, preview: 0, viewport: 0, console: 0, chrome: 0, gate: 0, composer: 0, status: 0, total: 0, degraded: 'minsize' };
  if (rows === 0) return z;
  // edge 2: rows 1–2 → console only (status, then the composer), header 0, viewport 0
  if (rows < 3) {
    z.status = take(1);
    z.composer = take(1);
    z.console = z.status + z.composer;
    z.total = rows - rem;
    return z;
  }
  const boxed = chromeRows(rows, columns, i.screenReader === true) === CAP.chrome;
  z.status = take(1); // 1 status never yields
  // 2 the console's edges: whole or absent, and only in the boxed tier (the same geometry rule as classic)
  if (boxed && rem >= CAP.chrome) {
    take(CAP.chrome);
    z.chrome = CAP.chrome;
  }
  const gate: 0 | 1 = z.chrome === CAP.chrome && i.gate === 1 ? 1 : 0;
  if (i.overlay !== 'wizard') {
    z.composer = take(1 + gate); // 3 the composer floor; the wizard IS the input (refund)
    z.gate = z.composer > 1 ? gate : 0;
  }
  z.rule = take(1); // 4 the rule row never yields at rows ≥ 3
  const cap = isCollapsingOverlay(i.overlay) ? 1 : rows >= 40 ? CAP.composerTall : CAP.composer;
  if (i.overlay !== 'wizard') z.composer += take(Math.min(i.composerWant, cap) - 1); // 5 console growth
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant); // 6 the modal slot; edge 3: the overlay is capped, never the total
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0;
  // 7 the header yields 5 → 1 → 0 before the viewport drops below three rows
  const hero = rows >= FULL_HERO_MIN_ROWS && columns >= WORDMARK_MIN_COLUMNS;
  if (hero && rem >= CAP.splash + FULL_MIN_VIEWPORT_ROWS) z.header = take(CAP.splash);
  else if (rem >= 1 + FULL_MIN_VIEWPORT_ROWS) z.header = take(1);
  z.viewport = take(rem); // 8 the viewport takes the remainder, so the total is exact
  z.console = z.chrome + z.composer + z.status;
  z.total = rows - rem;
  z.degraded = rows < FULL_MIN_ROWS || columns < FULL_MIN_COLUMNS || rows < MIN_ROWS || columns < MIN_COLUMNS ? 'minsize' : z.header === CAP.splash ? 'none' : 'compact';
  return z;
}

/** §1.3.1: the reason `fullscreen` was refused at this geometry / environment, or null when it may run. */
export interface FullscreenRefusalInput {
  rows: number;
  columns: number;
  screenReader: boolean;
  /** `process.env.TERM` — absent or `dumb` refuses */
  term: string | undefined;
}

/**
 * §1.3.1 refusal matrix. Each condition falls back to `classic` and appends **one** `[ui]` note naming the reason.
 * The non-TTY / CI / `--plain` / `--json` rows are silent (there is no TUI at all) and are decided before this call.
 * Order is the table's: rows, columns, screen reader, TERM.
 */
export function fullscreenRefusal(i: FullscreenRefusalInput): string | null {
  const rows = size(i.rows);
  const columns = size(i.columns);
  if (rows < FULL_MIN_ROWS) return `fullscreen needs ${FULL_MIN_ROWS} rows (now ${rows}) — the classic renderer is used`;
  if (columns < FULL_MIN_COLUMNS) return `fullscreen needs ${FULL_MIN_COLUMNS} columns (now ${columns}) — the classic renderer is used`;
  if (i.screenReader) return 'fullscreen repaints the whole screen on every key; the classic renderer is used under a screen reader';
  const term = (i.term ?? '').trim();
  // §1.3.1's condition is "`TERM` is `dumb` **or absent**" and its row is `TERM=<v>`; the absent case has no sensible
  // `<v>`, and an empty interpolation reads as a bug (`(TERM=)`). `<v>` is `unset` there — the §12 template is kept.
  if (term === '' || term.toLowerCase() === 'dumb') return `fullscreen needs a terminal that supports the alternate screen (TERM=${term === '' ? 'unset' : term}) — the classic renderer is used`;
  return null;
}
