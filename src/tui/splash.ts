/**
 * The startup splash (TUI-DESIGN-2 §5): seven 5-row block letters on a 56-cell grid, two-tone (`JEV` in `accent`,
 * `CODE` in `dim`), revealed left to right over 400 ms behind a 3-cell `▓▒░` head, a 6-cell sweep over 450–550 ms,
 * two fade steps at 600 / 650 ms and settled at 700 ms — every phase a function of the elapsed time, never of a
 * frame count, so a slow terminal skips frames instead of running long (§5.2). `splashFrame` is the pure twin the
 * App's pane slot and the tests read; `brandRow` is the rule row the splash settles into (`─── ◆ jevcode 0.2.0 ───…`)
 * and the one-line form that carries the splash below 64 columns (the `◆` pulses `░ ▒ ▓ ◆` twice over 400 ms). No
 * clock, no I/O, no Ink here (`motion.ts` drives the time). Pure.
 */
import { GLYPHS, cellWidth, padEndCells, ruleRow, type GlyphSet } from './glyphs.js';
import type { ColorRole } from './theme.js';

/** TUI-DESIGN-2 §5.1: the splash settles after this long (the App dispatches `splash:done` in the same commit). */
export const SPLASH_MS = 700;
/** TUI-DESIGN-2 §5.1: the animation tick (20 fps ≤ maxFps 30; ≈ 67 ms effective under SSH's fps 15). */
export const SPLASH_INTERVAL_MS = 50;
/** TUI-DESIGN-2 §5.2: the reveal completes at 400 ms; the sweep runs 450–550; the two fade steps are 600 and 650. */
export const SPLASH_REVEAL_MS = 400;
export const SPLASH_SHIMMER_FROM_MS = 450;
export const SPLASH_SHIMMER_TO_MS = 550;
export const SPLASH_FADE_1_MS = 600;
export const SPLASH_FADE_2_MS = 650;
/** TUI-DESIGN-2 §5.1: the wordmark grid width (every `WORDMARK` row is padded to exactly this many cells). */
export const WORDMARK_CELLS = 56;
/** TUI-DESIGN-2 §5.1: the wordmark is 5 rows high (`CAP.splash`). */
export const WORDMARK_ROWS = 5;
/** the `J` occupies cells 0–6 and is complete in frame 0 (§5.2 row 0) */
export const REVEAL_FLOOR_CELLS = 7;
/** `JEV` ends at cell 22; `CODE` starts at cell 24 (cell 23 is blank on every row) */
export const JEV_END_CELL = 23;
/** the reveal head is three cells (`▓▒░`) */
export const HEAD_CELLS = 3;
/** the shimmer band is six cells wide (§5.2 rows 9–11) */
export const SWEEP_CELLS = 6;
/** TUI-DESIGN-2 §5.1: the 5-row wordmark needs at least this many columns; below it the one-line brand row carries the splash */
export const WORDMARK_MIN_COLUMNS = 64;

const RAW: readonly [string, string, string, string, string] = [
  '    ██ ███████ ██    ██  ██████  ██████  ██████  ███████',
  '    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██',
  '    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████',
  '██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██',
  ' ████  ███████   ████    ██████  ██████  ██████  ███████',
];

/** TUI-DESIGN-2 §5.1: the five wordmark rows, each padded with blanks to exactly `WORDMARK_CELLS` cells. */
export const WORDMARK: readonly [string, string, string, string, string] = [padEndCells(RAW[0], WORDMARK_CELLS), padEndCells(RAW[1], WORDMARK_CELLS), padEndCells(RAW[2], WORDMARK_CELLS), padEndCells(RAW[3], WORDMARK_CELLS), padEndCells(RAW[4], WORDMARK_CELLS)];

export type SplashPhase = 'reveal' | 'shimmer' | 'fade' | 'settled';

/** One coloured run of a row: cells `[from, to)` in the row string's own cell coordinates (the centring offset included). */
export interface SplashSpan {
  row: number;
  from: number;
  to: number;
  role: ColorRole;
}

export interface SplashFrame {
  /** exactly `WORDMARK_ROWS` rows (right-trimmed, ≤ columns cells), or [] once settled / below `WORDMARK_MIN_COLUMNS` */
  rows: string[];
  spans: readonly SplashSpan[];
  phase: SplashPhase;
}

/** TUI-DESIGN-2 §5.2: the phase for an elapsed time (`reveal` < 450 · `shimmer` < 600 · `fade` < 700 · `settled`). */
export function splashPhase(t: number): SplashPhase {
  if (!Number.isFinite(t) || t < SPLASH_SHIMMER_FROM_MS) return 'reveal';
  if (t < SPLASH_FADE_1_MS) return 'shimmer';
  if (t < SPLASH_MS) return 'fade';
  return 'settled';
}

/** TUI-DESIGN-2 §5.2: cells revealed at `t` — `⌈56 · t / 400⌉`, never below the `J` (7) and never above the grid (56). */
export function revealedCells(t: number): number {
  const ms = Number.isFinite(t) ? Math.max(0, t) : 0;
  return Math.min(WORDMARK_CELLS, Math.max(REVEAL_FLOOR_CELLS, Math.ceil((WORDMARK_CELLS * ms) / SPLASH_REVEAL_MS)));
}

/** TUI-DESIGN-2 §5.2 rows 9–11: the first cell of the 6-cell sweep band, left → right once over 450–550 ms. */
export function sweepStart(t: number): number {
  const span = SPLASH_SHIMMER_TO_MS - SPLASH_SHIMMER_FROM_MS;
  const k = Math.min(1, Math.max(0, (t - SPLASH_SHIMMER_FROM_MS) / span));
  return Math.round((WORDMARK_CELLS - SWEEP_CELLS) * k);
}

/** TUI-DESIGN-2 §5.1: the left offset that centres the grid — `⌊(columns − 56) / 2⌋`. */
export function wordmarkOffset(columns: number): number {
  return Math.max(0, Math.floor((columns - WORDMARK_CELLS) / 2));
}

function cellsOf(row: string): string[] {
  return [...row];
}

/**
 * TUI-DESIGN-2 §5.1–5.3: the wordmark rows at elapsed time `t` for a terminal `columns` wide — `WORDMARK_ROWS` rows,
 * each ≤ `columns` cells, with the colour spans on the row's own cells; [] once settled (t ≥ 700) or below 64 columns.
 * Reveal: the letters up to `revealedCells(t)` and the `▓▒░` head right after them; shimmer: the whole mark with a
 * 6-cell `sweep` band; fade 600: `JEV` loses its accent; fade 650: every letter dims. `--ascii` draws `#` letters with a
 * `# + .` head. Spans are computed on the 56-cell grid and every row is right-trimmed afterwards.
 */
export function splashFrame(t: number, columns: number, g: GlyphSet = GLYPHS.unicode): SplashFrame {
  const phase = splashPhase(t);
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (phase === 'settled' || cols < WORDMARK_MIN_COLUMNS) return { rows: [], spans: [], phase };
  const offset = wordmarkOffset(cols);
  const pad = ' '.repeat(offset);
  const edge = phase === 'reveal' ? revealedCells(t) : WORDMARK_CELLS;
  const head = [g.shade3, g.shade2, g.shade1];
  const rows: string[] = [];
  const spans: SplashSpan[] = [];
  const jevRole: ColorRole | null = phase === 'fade' ? (t >= SPLASH_FADE_2_MS ? 'dim' : null) : 'accent';
  const codeRole: ColorRole = 'dim';
  const band = phase === 'shimmer' ? sweepStart(t) : -1;
  for (let r = 0; r < WORDMARK_ROWS; r++) {
    const src = cellsOf(WORDMARK[r] ?? '');
    const out: string[] = [];
    for (let c = 0; c < WORDMARK_CELLS; c++) {
      if (c < edge) {
        const ch = src[c] ?? ' ';
        out.push(ch === ' ' ? ' ' : g.full);
      } else if (c < edge + HEAD_CELLS && edge < WORDMARK_CELLS) out.push(head[c - edge] ?? ' ');
      else out.push(' ');
    }
    const text = `${pad}${out.join('')}`.replace(/\s+$/, '');
    rows.push(text);
    const shown = Math.min(edge, WORDMARK_CELLS);
    if (shown > 0) {
      const jevTo = Math.min(shown, JEV_END_CELL);
      if (jevRole !== null && jevTo > 0) spans.push({ row: r, from: offset, to: offset + jevTo, role: jevRole });
      if (shown > JEV_END_CELL) spans.push({ row: r, from: offset + JEV_END_CELL, to: offset + shown, role: codeRole });
    }
    if (edge < WORDMARK_CELLS) spans.push({ row: r, from: offset + edge, to: offset + Math.min(WORDMARK_CELLS, edge + HEAD_CELLS), role: 'sweep' });
    if (band >= 0) spans.push({ row: r, from: offset + band, to: offset + Math.min(WORDMARK_CELLS, band + SWEEP_CELLS), role: 'sweep' });
  }
  return { rows, spans, phase };
}

/** TUI-DESIGN-2 §5.4: `◆ jevcode <version>` — the brand text of the rule row. */
export function brandText(version: string, g: GlyphSet = GLYPHS.unicode): string {
  return `${g.brand} jevcode ${version}`;
}

/** TUI-DESIGN-2 §5.1 one-line form: the `◆` pulses `░ ▒ ▓ ◆` twice over 400 ms; the brand glyph from then on (and for a null `t`). */
export function brandGlyph(t: number | null, g: GlyphSet = GLYPHS.unicode): string {
  if (t === null || !Number.isFinite(t) || t >= SPLASH_REVEAL_MS || t < 0) return g.brand;
  const steps = [g.shade1, g.shade2, g.shade3, g.brand];
  return steps[Math.floor(t / SPLASH_INTERVAL_MS) % steps.length] ?? g.brand;
}

/**
 * TUI-DESIGN-2 §5.4: the brand rule row `─── ◆ jevcode 0.2.0 ─────…` (`ruleRow(brandText, '', columns)`), exactly
 * `min(columns, 400)` cells; with an elapsed time the one-line form pulses the glyph (§5.1) — null draws the settled row.
 */
export function brandRow(version: string, columns: number, t: number | null = null, g: GlyphSet = GLYPHS.unicode): string {
  return ruleRow(`${brandGlyph(t, g)} jevcode ${version}`, '', columns, g);
}

/**
 * TUI-DESIGN-2 §5.4 (finding 10): the `[from, to)` code-unit span of `<glyph> jevcode <version>` in a rule row, for the
 * `accent` colour — any of the four pulse glyphs (`░ ▒ ▓ ◆`, or their `--ascii` twins) counts, so the accent never blinks
 * off while the one-line splash pulses below 64 columns. Null when the row is not a brand row.
 */
export function brandSpan(row: string, g: GlyphSet = GLYPHS.unicode): { from: number; to: number } | null {
  for (const glyph of [g.brand, g.shade1, g.shade2, g.shade3]) {
    const at = row.indexOf(`${glyph} jevcode `);
    if (at === -1) continue;
    const afterLabel = at + `${glyph} jevcode `.length;
    const end = row.indexOf(' ', afterLabel);
    return { from: at, to: end === -1 ? row.length : end };
  }
  return null;
}

/** The cells a row of a frame takes (tests: every row ≤ columns). */
export function frameRowCells(row: string): number {
  return cellWidth(row);
}
