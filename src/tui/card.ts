/**
 * Rounded cards (TUI-DESIGN-2 §4.7, §10.3): the text rows every boxed-tier modal draws with — the review card,
 * follow-up, undo, exit confirm, blocking and the palette / mention popup. Rows are strings first
 * (the `--ascii`, `--plain`, frame-test and `PaneBoundary` twins read the same functions); Ink only colours them.
 * The glyphs are the cli-boxes `round` set copied into `glyphs.ts` (`╭ ╮ ╰ ╯ │ ─`; `+ - |` under `--ascii`), so no
 * dependency is added. Every row is exactly `columns` cells. Pure.
 */
import { GLYPHS, cellWidth, fitCells, truncateCells, type GlyphSet } from './glyphs.js';

/** `╭─ ` + title + ` ` and ` ─╮` around a titled top edge: the title never takes more than `columns − 6` cells. */
export const CARD_TITLE_MARGIN = 6;

function width(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

/** TUI-DESIGN-2 §4.7: `╭─ <title ≤ columns − 6> ─…─╮`; an empty title draws `╭──…──╮`. Exactly `columns` cells (a rule below 4 cells). */
export function cardTop(title: string, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const w = width(columns);
  if (w === 0) return '';
  if (w < 4) return g.rule.repeat(w);
  const t = title === '' ? '' : truncateCells(title, Math.max(0, w - CARD_TITLE_MARGIN), g);
  if (t === '') return `${g.roundTopLeft}${g.rule.repeat(w - 2)}${g.roundTopRight}`;
  const head = `${g.roundTopLeft}${g.rule} ${t} `;
  return `${head}${g.rule.repeat(Math.max(0, w - cellWidth(head) - 1))}${g.roundTopRight}`;
}

/** TUI-DESIGN-2 §4.7: `│ ` + fitCells(text, columns − 4) + ` │`. Exactly `columns` cells (the bare text below 4 cells). */
export function cardRow(text: string, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const w = width(columns);
  if (w === 0) return '';
  if (w < 4) return fitCells(text, w, g);
  return `${g.boxVertical} ${fitCells(text, w - 4, g)} ${g.boxVertical}`;
}

/** TUI-DESIGN-2 §4.7: `╰──…──╯`. Exactly `columns` cells. */
export function cardBottom(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const w = width(columns);
  if (w === 0) return '';
  if (w < 4) return g.rule.repeat(w);
  return `${g.roundBottomLeft}${g.rule.repeat(w - 2)}${g.roundBottomRight}`;
}

/** TUI-DESIGN-2 §4.7: title edge, one row per body line, bottom edge — `body.length + 2` rows, each exactly `columns` cells. */
export function cardLines(title: string, body: readonly string[], columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  return [cardTop(title, columns, g), ...body.map((b) => cardRow(b, columns, g)), cardBottom(columns, g)];
}
