/**
 * Visual rows of the composer (TUI-DESIGN §4.2, §4.3; 08 §8): split the logical text on '\n', soft-wrap each
 * logical line by summed cell width, never inside a grapheme or an atomic span (a paste chip label), breaking after
 * a space when one sits in the last 20 cells. Pure: the same `(text, columns, gutter, atoms)` always yields the
 * same rows, so the renderer's cursor and Ink's frame cannot disagree.
 */
import { cellWidth } from './width.js';

/** One visual row (TUI-DESIGN §4.2 `Row = { start, end, hard, cells }`): `[start, end)` UTF-16 offsets into the logical text; `hard` = ends at a '\n' or at the text end. */
export interface Row {
  readonly start: number;
  readonly end: number;
  readonly hard: boolean;
  readonly cells: number;
}

/** A half-open UTF-16 span `[start, end)` in the logical text: chip labels (TUI-DESIGN §4.1) and secret hits (§4.3). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Default gutter cells (`> ` / `  `) subtracted from `columns` (TUI-DESIGN §4.3). */
export const DEFAULT_GUTTER = 2;
/** A soft wrap prefers the last space within this many cells of the row end (TUI-DESIGN §4.2). */
export const WRAP_LOOKBACK_CELLS = 20;

let graphemeSegmenter: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemeSegmenter;
}

const ASCII_RE = /^[\u0000-\u007f]*$/;
// Printable ASCII only: width equals length, so a whole line can skip the unit walk (controls fall through to it).
const PRINTABLE_ASCII_RE = /^[ -~]*$/;

// A keystroke changes one logical line; the soft-wrap of every other line is memoised per (width, line text).
const LINE_LAYOUT_CACHE_MAX = 512;
const lineLayoutCache = new Map<string, readonly { start: number; end: number; cells: number }[]>();

/** One atomic display unit of the logical text (TUI-DESIGN §4.1, §4.2): a grapheme cluster or a whole atom span, at absolute UTF-16 offsets. */
export interface TextUnit {
  /** offset of the unit's first code unit in the logical text */
  readonly at: number;
  readonly len: number;
  readonly cells: number;
  readonly space: boolean;
}

function widthOf(s: string): number {
  if (ASCII_RE.test(s)) {
    let cells = 0;
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu >= 0x20 && cu <= 0x7e) cells++;
    }
    return cells;
  }
  let cells = 0;
  for (const { segment } of segmenter().segment(s)) cells += cellWidth(segment);
  return cells;
}

/**
 * Atomic units of `text[from, to)` (TUI-DESIGN §4.1, §4.2): grapheme clusters, except that every atom span (a chip
 * label) is one unit; `atoms` must be sorted and non-overlapping (see `layoutRows`). Never splits a grapheme; an atom
 * that straddles the range is clipped to it. Shared by `layoutRows` and the reducer's ↑/↓ column targeting.
 */
export function textUnits(text: string, from: number, to: number, atoms: readonly Span[] = []): TextUnit[] {
  const out: TextUnit[] = [];
  const emitPlain = (a: number, b: number): void => {
    if (b <= a) return;
    const chunk = text.slice(a, b);
    if (ASCII_RE.test(chunk)) {
      for (let i = 0; i < chunk.length; i++) {
        const cu = chunk.charCodeAt(i);
        out.push({ at: a + i, len: 1, cells: cu >= 0x20 && cu <= 0x7e ? 1 : 0, space: cu === 0x20 });
      }
      return;
    }
    for (const { segment, index } of segmenter().segment(chunk)) {
      out.push({ at: a + index, len: segment.length, cells: cellWidth(segment), space: segment === ' ' });
    }
  };
  let pos = from;
  for (const atom of atoms) {
    if (atom.end <= from) continue;
    if (atom.start >= to) break;
    const a = Math.max(atom.start, pos);
    const b = Math.min(atom.end, to);
    if (b <= a) continue;
    emitPlain(pos, a);
    out.push({ at: a, len: b - a, cells: widthOf(text.slice(a, b)), space: false });
    pos = b;
  }
  emitPlain(pos, to);
  return out;
}

function normaliseAtoms(atoms: readonly Span[] | undefined): readonly Span[] {
  if (atoms === undefined || atoms.length === 0) return [];
  const sorted = atoms
    .filter((a) => Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start && a.start >= 0)
    .slice()
    .sort((x, y) => x.start - y.start);
  const out: Span[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a.start < last.end) {
      if (a.end > last.end) out[out.length - 1] = { start: last.start, end: a.end };
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Lay the logical `text` out as visual rows of at most `columns − gutter` cells (TUI-DESIGN §4.2). Hard rows end at '\n'
 * or at the end of the text; soft rows never split a grapheme or an atom (`opts.atoms`, e.g. chip label spans) and break
 * after the last space within the final 20 cells when one exists. Widths below one cell are treated as one cell, so a
 * single grapheme wider than the row still gets a row of its own. The empty text yields one empty hard row. `text` need
 * not be buffer-normalised: control code units (`\t`, `\r`, DEL) count 0 cells, exactly as `stringWidth` counts them.
 */
export function layoutRows(text: string, columns: number, gutter: number = DEFAULT_GUTTER, opts?: { atoms?: readonly Span[] }): Row[] {
  const safeColumns = Number.isFinite(columns) ? Math.floor(columns) : 80;
  const safeGutter = Number.isFinite(gutter) ? Math.max(0, Math.floor(gutter)) : DEFAULT_GUTTER;
  const width = Math.max(1, safeColumns - safeGutter);
  const atoms = normaliseAtoms(opts?.atoms);
  const rows: Row[] = [];
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    if (line.length === 0) {
      rows.push({ start: lineStart, end: lineEnd, hard: true, cells: 0 });
    } else if (atoms.length === 0 && line.length <= width && PRINTABLE_ASCII_RE.test(line)) {
      rows.push({ start: lineStart, end: lineEnd, hard: true, cells: line.length });
    } else {
      const lineAtoms = atoms.filter((a) => a.end > lineStart && a.start < lineEnd);
      const key = lineAtoms.length === 0 ? `${width}\u0000${line}` : null;
      const cached = key === null ? undefined : lineLayoutCache.get(key);
      if (cached !== undefined) {
        cached.forEach((r, i) => rows.push({ start: r.start + lineStart, end: r.end + lineStart, hard: i === cached.length - 1, cells: r.cells }));
        if (nl === -1) break;
        lineStart = nl + 1;
        continue;
      }
      const firstRow = rows.length;
      const units = textUnits(text, lineStart, lineEnd, atoms);
      let rowStart = lineStart; // absolute offsets
      let rowCells = 0;
      let lastSpaceIdx = -1; // index into units of the last space on the current row
      let cellsAtLastSpace = 0; // row cells including that space
      let i = 0;
      while (i < units.length) {
        const u = units[i];
        if (u === undefined) break;
        if (rowCells + u.cells > width && rowCells > 0) {
          // wrap: prefer breaking after a space inside the last 20 cells
          if (lastSpaceIdx >= 0 && rowCells - cellsAtLastSpace < WRAP_LOOKBACK_CELLS) {
            const sp = units[lastSpaceIdx];
            if (sp !== undefined) {
              const breakAt = sp.at + sp.len;
              rows.push({ start: rowStart, end: breakAt, hard: false, cells: cellsAtLastSpace });
              rowStart = breakAt;
              i = lastSpaceIdx + 1;
              rowCells = 0;
              lastSpaceIdx = -1;
              cellsAtLastSpace = 0;
              continue;
            }
          }
          rows.push({ start: rowStart, end: u.at, hard: false, cells: rowCells });
          rowStart = u.at;
          rowCells = 0;
          lastSpaceIdx = -1;
          cellsAtLastSpace = 0;
        }
        rowCells += u.cells;
        if (u.space) {
          lastSpaceIdx = i;
          cellsAtLastSpace = rowCells;
        }
        i++;
      }
      rows.push({ start: rowStart, end: lineEnd, hard: true, cells: rowCells });
      if (key !== null) {
        if (lineLayoutCache.size >= LINE_LAYOUT_CACHE_MAX) lineLayoutCache.clear();
        lineLayoutCache.set(key, rows.slice(firstRow).map((r) => ({ start: r.start - lineStart, end: r.end - lineStart, cells: r.cells })));
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return rows;
}

/** Visual position of `cursor` (TUI-DESIGN §4.2): the row that contains it and the summed cell width before it on that row. */
export function cursorToRowX(rows: readonly Row[], text: string, cursor: number): { row: number; x: number } {
  if (rows.length === 0) return { row: 0, x: 0 };
  const c = Number.isFinite(cursor) ? Math.min(Math.max(0, Math.floor(cursor)), text.length) : 0;
  let idx = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === undefined) continue;
    // a cursor exactly on a soft-row end belongs to the next row (it is the first cell of the continuation)
    if (c < r.end || (c === r.end && r.hard)) {
      idx = i;
      break;
    }
  }
  const r = rows[idx];
  if (r === undefined) return { row: 0, x: 0 };
  const before = text.slice(r.start, Math.max(r.start, Math.min(c, r.end)));
  let x = 0;
  if (ASCII_RE.test(before)) {
    for (let i = 0; i < before.length; i++) {
      const cu = before.charCodeAt(i);
      if (cu >= 0x20 && cu <= 0x7e) x++;
    }
  } else {
    for (const { segment } of segmenter().segment(before)) x += cellWidth(segment);
  }
  return { row: idx, x };
}

/** The visual row on which `cursor` sits, per `cursorToRowX` (TUI-DESIGN §4.6: Up on the first visual row recalls history). */
export function rowOfCursor(rows: readonly Row[], text: string, cursor: number): number {
  return cursorToRowX(rows, text, cursor).row;
}

/**
 * Scroll offset that keeps the cursor row visible in a `height`-row box (TUI-DESIGN §4.2):
 * `clamp(scrollTop, cursorRow − height + 1, cursorRow)`, never below 0; `height` < 1 or NaN behaves as 1, +Infinity as unbounded.
 */
export function viewport(cursorRow: number, height: number, scrollTop: number): number {
  const h = height > 0 ? Math.floor(height) : 1;
  const row = Number.isFinite(cursorRow) ? Math.max(0, Math.floor(cursorRow)) : 0;
  const top = Number.isFinite(scrollTop) ? Math.floor(scrollTop) : 0;
  const lo = Math.max(0, row - h + 1);
  const hi = row;
  return Math.min(Math.max(top, lo), hi);
}

/** Mask glyphs for `maskSpans` (TUI-DESIGN §4.3, §14.1): `•` normally, `*` under --ascii. */
export const MASK_GLYPH = '•';
/** `--ascii` twin of `MASK_GLYPH` (TUI-DESIGN §14.1). */
export const MASK_GLYPH_ASCII = '*';

/**
 * Display text of one row with every grapheme that intersects a detected secret span replaced by `glyph` repeated
 * to the same cell width (TUI-DESIGN §4.3): runs after `layoutRows`, so row widths and `cursorToRowX` are unchanged
 * and the human still sees where the secret sits. Spans are in logical-text coordinates.
 */
export function maskSpans(text: string, row: Row, spans: readonly Span[], glyph: string = MASK_GLYPH): string {
  const slice = text.slice(row.start, row.end);
  if (spans.length === 0 || slice.length === 0) return slice;
  const hits = spans.filter((s) => s.end > row.start && s.start < row.end);
  if (hits.length === 0) return slice;
  const inHit = (from: number, to: number): boolean => hits.some((s) => s.start < to && s.end > from);
  let out = '';
  if (ASCII_RE.test(slice)) {
    for (let i = 0; i < slice.length; i++) {
      const abs = row.start + i;
      const cu = slice.charCodeAt(i);
      const w = cu >= 0x20 && cu <= 0x7e ? 1 : 0;
      out += inHit(abs, abs + 1) ? glyph.repeat(w) : slice[i];
    }
    return out;
  }
  for (const { segment, index } of segmenter().segment(slice)) {
    const abs = row.start + index;
    out += inHit(abs, abs + segment.length) ? glyph.repeat(cellWidth(segment)) : segment;
  }
  return out;
}
