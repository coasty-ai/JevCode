/**
 * The startup splash (TUI-DESIGN-2 §5; TUI-DESIGN-3 §3.4 A1): seven 5-row block letters on a 56-cell grid, two-tone
 * (`JEV` in `accent`, `CODE` in `dim`), revealed left to right over 400 ms behind a 3-cell `▓▒░` head, a 6-cell sweep
 * over 450–550 ms, then **held** from 550 ms — the resting mark with its `◆ <version>` caption (§3.5), the frame the
 * wordmark keeps for the rest of the idle session (the fade steps and the collapse of round 2 are gone; `splash:done`
 * still fires at 700 ms and changes no pixel). Every phase is a function of the elapsed time, never of a frame count,
 * so a slow terminal skips frames instead of running long (§5.2). `splashFrame` is the pure twin the App's pane slot
 * and the tests read; `restingFrame` is the held mark (`wordmark.ts` wraps it as `wordmarkFrame` and adds the idle
 * loop's band); `brandRow` is the one-line rule row for the states that hide the mark (`─── ◆ jevcode 0.3.0 ───…`) and
 * the form that carries the splash below 64 columns (the `◆` pulses `░ ▒ ▓ ◆` twice over 400 ms). No clock, no I/O,
 * no Ink here (`motion.ts` drives the time). Pure.
 */
import { GLYPHS, cellWidth, padEndCells, ruleRow, type GlyphSet } from './glyphs.js';
import type { ColorRole } from './theme.js';

/** TUI-DESIGN-2 §5.1: the splash settles after this long (the App dispatches `splash:done` in the same commit). */
export const SPLASH_MS = 700;
/** TUI-DESIGN-2 §5.1: the animation tick (20 fps ≤ maxFps 30; ≈ 67 ms effective under SSH's fps 15). */
export const SPLASH_INTERVAL_MS = 50;
/** TUI-DESIGN-2 §5.2 / TUI-DESIGN-3 §3.4: the reveal completes at 400 ms; the sweep runs 450–550; the mark is held from 550 (the settle sentinel). */
export const SPLASH_REVEAL_MS = 400;
export const SPLASH_SHIMMER_FROM_MS = 450;
export const SPLASH_SHIMMER_TO_MS = 550;
/** TUI-DESIGN-3 §3.4: the resting mark (with its caption) is on screen from here on — nothing after it changes a cell */
export const SPLASH_HELD_MS = SPLASH_SHIMMER_TO_MS;
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
/** TUI-DESIGN-3 §3.5: the caption `◆ <version>` starts two cells after the last `E` — grid cell 58, span `[58, 58 + cellWidth(caption))` */
export const CAPTION_GRID_CELL = 58;
/** TUI-DESIGN-3 §3.5: the tagline sits two cells after the mark on row 0 at `⌊(c − 56) / 2⌋ + 58 + 22 ≤ c ⇔ c ≥ 104` */
export const TAGLINE_MIN_COLUMNS = 104;
/** TUI-DESIGN-3 §3.5 / §5.1 rule 13: the owner's copy line, exactly; never in the band, never a transcript item */
export const TAGLINE = 'Decisions, not strings';

const RAW: readonly [string, string, string, string, string] = [
  '    ██ ███████ ██    ██  ██████  ██████  ██████  ███████',
  '    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██',
  '    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████',
  '██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██',
  ' ████  ███████   ████    ██████  ██████  ██████  ███████',
];

/** TUI-DESIGN-2 §5.1: the five wordmark rows, each padded with blanks to exactly `WORDMARK_CELLS` cells. */
export const WORDMARK: readonly [string, string, string, string, string] = [padEndCells(RAW[0], WORDMARK_CELLS), padEndCells(RAW[1], WORDMARK_CELLS), padEndCells(RAW[2], WORDMARK_CELLS), padEndCells(RAW[3], WORDMARK_CELLS), padEndCells(RAW[4], WORDMARK_CELLS)];

/** TUI-DESIGN-3 §3.4: `reveal` < 450 · `shimmer` < 550 · `held` from 550 (no fade, no settled-empty phase). */
export type SplashPhase = 'reveal' | 'shimmer' | 'held';

/** One coloured run of a row: cells `[from, to)` in the row string's own cell coordinates (the centring offset included). */
export interface SplashSpan {
  row: number;
  from: number;
  to: number;
  role: ColorRole;
}

export interface SplashFrame {
  /** exactly `WORDMARK_ROWS` rows (right-trimmed, ≤ columns cells), or [] below `WORDMARK_MIN_COLUMNS` */
  rows: string[];
  spans: readonly SplashSpan[];
  phase: SplashPhase;
}

/** TUI-DESIGN-3 §3.4: the phase for an elapsed time (`reveal` < 450 · `shimmer` < 550 · `held`). */
export function splashPhase(t: number): SplashPhase {
  if (!Number.isFinite(t) || t < SPLASH_SHIMMER_FROM_MS) return 'reveal';
  if (t < SPLASH_HELD_MS) return 'shimmer';
  return 'held';
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

/** TUI-DESIGN-3 §3.5: the caption text `◆ <version>` (`* <version>` under `--ascii`). */
export function captionText(version: string, g: GlyphSet = GLYPHS.unicode): string {
  return `${g.brand} ${version}`;
}

/** TUI-DESIGN-3 §3.5: the caption is drawn only when `wordmarkOffset(columns) + 58 + cellWidth(caption) ≤ columns` — 73 columns for `◆ 0.3.0`, 85 for `◆ 0.10.0-rc.1`. */
export function captionFits(columns: number, caption: string): boolean {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (cols < WORDMARK_MIN_COLUMNS) return false;
  return wordmarkOffset(cols) + CAPTION_GRID_CELL + cellWidth(caption) <= cols;
}

/** TUI-DESIGN-3 §3.5: the tagline shows on row 0 at `columns ≥ TAGLINE_MIN_COLUMNS` (104). */
export function taglineFits(columns: number): boolean {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  return cols >= TAGLINE_MIN_COLUMNS && wordmarkOffset(cols) + CAPTION_GRID_CELL + cellWidth(TAGLINE) <= cols;
}

/** A colour band over the 56-cell grid (`[from, to)` in grid cells) — the idle loop's `loopBand(k)` or the shimmer's. */
export interface GridBand {
  from: number;
  to: number;
}

/** TUI-DESIGN-3 §3.4 / §3.8: the held mark — rows independent of the band, `spans(band)` colouring them. */
export interface RestingFrame {
  /** exactly `WORDMARK_ROWS` rows (right-trimmed, ≤ columns cells), or [] below `WORDMARK_MIN_COLUMNS` */
  rows: string[];
  /** `JEV` accent · `CODE` dim · the caption `◆` accent2 + version dim · the tagline dim · the band `sweep` over the letter cells only */
  spans(band: GridBand | null): SplashSpan[];
}

const EMPTY_RESTING: RestingFrame = { rows: [], spans: () => [] };

/**
 * TUI-DESIGN-3 §3.4–3.5: the resting mark for a terminal `columns` wide — the padded, centred `WORDMARK` rows with the
 * caption `◆ <version>` on the bottom row (when `captionFits`) and the tagline on row 0 (at ≥ 104 columns); the letters
 * `JEV` `accent`, `CODE` `dim`, the caption glyph `accent2`, its version and the tagline `dim`. `spans(band)` adds the
 * `sweep` band over grid cells `[from, to)` (letters only — blank cells have no glyph to colour; the caption and tagline
 * are never inside it). The rows never depend on the band (§3.8 ordering: the layout reads the rows, the render the band).
 */
export function restingFrame(columns: number, g: GlyphSet = GLYPHS.unicode, version: string | null = null): RestingFrame {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (cols < WORDMARK_MIN_COLUMNS) return EMPTY_RESTING;
  const offset = wordmarkOffset(cols);
  const pad = ' '.repeat(offset);
  const caption = version !== null && captionFits(cols, captionText(version, g)) ? captionText(version, g) : null;
  const tagline = taglineFits(cols) ? TAGLINE : null;
  const tail = (extra: string | null): string => (extra === null ? '' : `${' '.repeat(CAPTION_GRID_CELL - WORDMARK_CELLS)}${extra}`);
  const rows: string[] = [];
  for (let r = 0; r < WORDMARK_ROWS; r++) {
    const letters = cellsOf(WORDMARK[r] ?? '')
      .map((ch) => (ch === ' ' ? ' ' : g.full))
      .join('');
    const extra = r === 0 ? tail(tagline) : r === WORDMARK_ROWS - 1 ? tail(caption) : '';
    rows.push(`${pad}${letters}${extra}`.replace(/\s+$/, ''));
  }
  const spans = (band: GridBand | null): SplashSpan[] => {
    const out: SplashSpan[] = [];
    for (let r = 0; r < WORDMARK_ROWS; r++) {
      out.push({ row: r, from: offset, to: offset + JEV_END_CELL, role: 'accent' });
      out.push({ row: r, from: offset + JEV_END_CELL, to: offset + WORDMARK_CELLS, role: 'dim' });
      if (band !== null) {
        const from = Math.max(0, Math.floor(band.from));
        const to = Math.min(WORDMARK_CELLS, Math.floor(band.to));
        if (to > from) out.push({ row: r, from: offset + from, to: offset + to, role: 'sweep' });
      }
    }
    if (tagline !== null) out.push({ row: 0, from: offset + CAPTION_GRID_CELL, to: offset + CAPTION_GRID_CELL + cellWidth(tagline), role: 'dim' });
    if (caption !== null) {
      const at = offset + CAPTION_GRID_CELL;
      const glyphCells = cellWidth(g.brand);
      out.push({ row: WORDMARK_ROWS - 1, from: at, to: at + glyphCells, role: 'accent2' });
      out.push({ row: WORDMARK_ROWS - 1, from: at + glyphCells, to: at + cellWidth(caption), role: 'dim' });
    }
    return out;
  };
  return { rows, spans };
}

/**
 * TUI-DESIGN-2 §5.1–5.3 / TUI-DESIGN-3 §3.4: the wordmark rows at elapsed time `t` for a terminal `columns` wide —
 * `WORDMARK_ROWS` rows, each ≤ `columns` cells, with the colour spans on the row's own cells; [] below 64 columns and
 * never otherwise. Reveal: the letters up to `revealedCells(t)` and the `▓▒░` head right after them; shimmer: the
 * whole mark with a 6-cell `sweep` band; **held** (t ≥ 550): the resting mark with the caption `◆ <version>` when a
 * `version` is given (the App passes `VERSION`, so the frame the App swaps to at `splash:done` is cell-identical and
 * writes nothing). `--ascii` draws `#` letters with a `# + .` head. Spans are computed on the 56-cell grid and every
 * row is right-trimmed afterwards. Frame 0 is cell-identical to round 2's (the H-A1 fixtures).
 */
export function splashFrame(t: number, columns: number, g: GlyphSet = GLYPHS.unicode, version: string | null = null): SplashFrame {
  const phase = splashPhase(t);
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (cols < WORDMARK_MIN_COLUMNS) return { rows: [], spans: [], phase };
  if (phase === 'held') {
    const rest = restingFrame(cols, g, version);
    return { rows: rest.rows, spans: rest.spans(null), phase };
  }
  const offset = wordmarkOffset(cols);
  const pad = ' '.repeat(offset);
  const edge = phase === 'reveal' ? revealedCells(t) : WORDMARK_CELLS;
  const head = [g.shade3, g.shade2, g.shade1];
  const rows: string[] = [];
  const spans: SplashSpan[] = [];
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
      if (jevTo > 0) spans.push({ row: r, from: offset, to: offset + jevTo, role: 'accent' });
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

/** A version token after `jevcode` (`0.4.0`, `1.2.3-rc.1`, `0.4.0+build`); anything else ends the brand span at `jevcode`. */
const VERSION_TOKEN = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * TUI-DESIGN-2 §5.4 (finding 10), generalised by TUI-DESIGN-4 §1.2 P-H1: the `[from, to)` code-unit span of
 * `<glyph> jevcode[ <version>]` in a rule row, for the `accent` colour — any of the four pulse glyphs (`░ ▒ ▓ ◆`, or
 * their `--ascii` twins) counts, so the accent never blinks off while the one-line splash pulses below 64 columns.
 * The span ends **after the version** when the next token is one (the `brandRow` form, byte-identical to round 2) and
 * **at `jevcode`** when it is not — which is the strip's `◆ jevcode ─ ▸ jev s4 …` prefix (P-H1), where the following
 * token is a rule cell, not a version. Null when the row carries no brand (a pre-run strip, a truncated row).
 */
export function brandSpan(row: string, g: GlyphSet = GLYPHS.unicode): { from: number; to: number } | null {
  for (const glyph of [g.brand, g.shade1, g.shade2, g.shade3]) {
    const label = `${glyph} jevcode`;
    // rescan past a boundary failure: `◆ jevcodex … ◆ jevcode 0.4.0` must still colour the real brand (finding 22)
    for (let from = 0; ; ) {
      const at = row.indexOf(label, from);
      if (at === -1) break;
      from = at + 1;
      const afterLabel = at + label.length;
      // `jevcodex` is not the brand; the label must end the row or be followed by a space
      if (afterLabel < row.length && row[afterLabel] !== ' ') continue;
      if (afterLabel >= row.length) return { from: at, to: afterLabel };
      const rest = row.slice(afterLabel + 1);
      const cut = rest.indexOf(' ');
      const token = cut === -1 ? rest : rest.slice(0, cut);
      return VERSION_TOKEN.test(token) && token !== '' ? { from: at, to: afterLabel + 1 + token.length } : { from: at, to: afterLabel };
    }
  }
  return null;
}

/** The cells a row of a frame takes (tests: every row ≤ columns). */
export function frameRowCells(row: string): number {
  return cellWidth(row);
}
