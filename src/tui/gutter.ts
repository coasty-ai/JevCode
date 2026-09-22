/**
 * The label-gutter rung ladder (TUI-DESIGN-4 §2.3, D-AB). **Zero imports, by contract** — the same first-frame rule
 * `src/provider/ids.ts` states: `src/tui/block/lines.ts` is a no-Ink module that computes `blockWidth` before the
 * first frame, `src/tui/fullscreen/viewport.ts` needs the same arithmetic, and `Transcript.tsx` re-exports every
 * name here, so no existing importer changes and nothing on the first-frame path pulls Ink in behind this module.
 *
 * TUI-DESIGN-3 §5.1 rule 1 gave every transcript item a fixed 10-cell label column and floored the body at one cell.
 * Measured on the working tree at 10 columns that turns one 296-character step item into **258** committed rows, and
 * one `[sandbox]` item at 2×10 into 183 permanent scrollback rows. D-AB replaces the floor with three rungs by
 * terminal width and caps an engine-produced item at `STATIC_ITEM_MAX_ROWS`:
 *
 * | rung      | condition            | shape                                                        | body width                       |
 * | --------- | -------------------- | ------------------------------------------------------------ | -------------------------------- |
 * | `gutter`  | `columns ≥ 34`       | the label right-aligned in cells 0–8, the body from column 10 | `columns − max(9, label) − 1`     |
 * | `stacked` | `24 ≤ columns < 34`  | the label on its own row, the body indented 2                  | `columns − 2`                    |
 * | `flush`   | `columns < 24`       | no gutter, no indent; the label is the first token of row 0     | `columns`                        |
 *
 * The body width never reaches 0 (Ink loops on a 0-cell box) and the rung is applied unconditionally below its
 * threshold — under a screen reader `stacked` is strictly better than a one-cell body, not worse (§2.3 edge 5).
 * Pure: every function is a total function of `columns` (and, in `gutter`, the label's cell width).
 */

/** TUI-DESIGN-3 §5.1 rule 1 (D-L): bodies start at this column; the label is right-aligned in the `LABEL_GUTTER − 1` cells before the space. */
export const LABEL_GUTTER = 10;

/** TUI-DESIGN-4 §2.3 (D-AB): at or above this width the gutter is drawn; below it the label moves to its own row. */
export const STACKED_MIN_COLUMNS = 34;

/** TUI-DESIGN-4 §2.3 (D-AB): below this width even the 2-cell indent is dropped and the body uses the whole row. */
export const FLUSH_MIN_COLUMNS = 24;

/** TUI-DESIGN-4 §2.3 (D-AB): the row cap of one **engine-produced** item at every rung — 23 rows plus the `… +N rows (transcript.log)` tail. */
export const STATIC_ITEM_MAX_ROWS = 24;

/** TUI-DESIGN-4 §3.1.2 (D-U): `blockWidth` is clamped to this many cells however wide the terminal is. */
export const BLOCK_WIDTH_MAX = 160;

/** TUI-DESIGN-4 §2.3: the three rungs of the ladder. */
export type GutterMode = 'gutter' | 'stacked' | 'flush';

/** A finite, non-negative integer column count (a non-finite or negative `columns` reads as 0). */
function cols(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

/** TUI-DESIGN-4 §2.3 (D-AB): the rung at a terminal width — `gutter` ≥ 34, `stacked` 24–33, `flush` below 24. */
export function gutterMode(columns: number): GutterMode {
  const w = cols(columns);
  if (w >= STACKED_MIN_COLUMNS) return 'gutter';
  if (w >= FLUSH_MIN_COLUMNS) return 'stacked';
  return 'flush';
}

/**
 * TUI-DESIGN-4 §2.3: the cells the body of a transcript row gets at a width — the rung's body width, never below 1.
 * `labelCells` is the label's own cell width and only matters on the `gutter` rung, where a label wider than the
 * gutter (`[step 1000]`) pushes the body right by the excess.
 */
export function gutterBodyWidth(columns: number, labelCells = 0): number {
  const w = cols(columns);
  switch (gutterMode(w)) {
    case 'gutter':
      return Math.max(1, w - Math.max(LABEL_GUTTER - 1, Math.max(0, Math.floor(labelCells))) - 1);
    case 'stacked':
      return Math.max(1, w - 2);
    case 'flush':
      return Math.max(1, w);
  }
}

/** TUI-DESIGN-4 §2.3: the cells a continuation row of the body is indented by at a width (`gutter` 10, `stacked` 2, `flush` 0). */
export function gutterIndent(columns: number, labelCells = 0): number {
  const w = cols(columns);
  switch (gutterMode(w)) {
    case 'gutter':
      return Math.max(LABEL_GUTTER - 1, Math.max(0, Math.floor(labelCells))) + 1;
    case 'stacked':
      return 2;
    case 'flush':
      return 0;
  }
}

/**
 * TUI-DESIGN-4 §3.1.2 (D-U): the rung's body width with **no** label — `columns − 10` in `gutter`, `columns − 2` in
 * `stacked`, `columns` in `flush`, clamped to `[1, 160]` and never floored above the width that is actually
 * available. This is the arithmetic of S3's `blockWidth` (`src/tui/block/lines.ts`, §3.1.2), kept here so the rung
 * table has one definition: a block's rows hang under column 10 whatever the item's label turns out to be.
 */
export function rungBodyWidth(columns: number): number {
  const w = cols(columns);
  const body = gutterMode(w) === 'gutter' ? w - LABEL_GUTTER : gutterMode(w) === 'stacked' ? w - 2 : w;
  return Math.min(BLOCK_WIDTH_MAX, Math.max(1, body));
}

/**
 * TUI-DESIGN-4 §2.3: the tail row an engine item over `STATIC_ITEM_MAX_ROWS` rows ends with (`n` = the rows not
 * drawn), widest first. The ladder exists because the `flush` rung goes down to 1 cell and the full sentence is 26:
 * §11's "no row wider than the terminal" is a gate, so the tail is **chosen**, never truncated (the same rule §2.6
 * applies to every other row of this round). Every rung is ASCII plus at most one `…`, so `length` **is** the cell
 * width and this module stays import-free.
 */
export function cappedTailRungs(n: number, ascii = false): string[] {
  const k = Math.max(0, Math.floor(n));
  const e = ascii ? '...' : '…';
  // every rung carries the `+<n>`: a bare `…` is ordinary body text (`truncateCells(x, 1)` produces one, and a
  // Python ellipsis or an elided log line is a `...`), and `isCappedTailRow` is the **skip rule** of the line-identity
  // gate (§2.3 Identity, §11) — a predicate that answered `true` for it would quietly drop whole items from the
  // strongest gate this round adds. The narrowest rung closes the gap the dropped 1-cell rung left: `…+<n>`.
  return [`${e} +${k} rows (transcript.log)`, `${e} +${k} rows (log)`, `${e} +${k} rows`, `${e} +${k}`, `${e}+${k}`];
}

/**
 * TUI-DESIGN-4 §2.3: the tail row at a body width — the widest rung that fits, the narrowest when none does.
 * `width` defaults to `Infinity`, which is the `… +N rows (transcript.log)` of the design's table.
 */
export function cappedTailRow(n: number, width = Number.POSITIVE_INFINITY, ascii = false): string {
  const rungs = cappedTailRungs(n, ascii);
  // the same reading of an unbounded width as `fit.ts`'s `fitRungIndex`: `Infinity` is the widest rung, `NaN` is no room
  const room = width === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Number.isFinite(width) ? Math.floor(width) : 0;
  for (const r of rungs) if (r.length <= room) return r;
  // Below the narrowest rung — a 1- or 2-cell body, which only the `flush` rung can produce — no distinguishable
  // marker exists at all: cut the narrowest one, the last resort §2.6 allows, so the row still obeys §11's "no row
  // wider than the terminal". `isCappedTailRow` answers `false` for the cut form on purpose: at that width the row is
  // indistinguishable from body text, and the identity gate must not skip an item on a guess.
  const narrowest = rungs[rungs.length - 1]!;
  return room >= 1 && room < narrowest.length ? narrowest.slice(0, room) : narrowest;
}

/** The `--ascii` twin of `cappedTailRow` (the ellipsis is the only glyph in it). */
export function cappedTailRowAscii(n: number, width = Number.POSITIVE_INFINITY): string {
  return cappedTailRow(n, width, true);
}

/**
 * TUI-DESIGN-4 §2.3: true when a row is the cap's truncation marker at any rung of the ladder (the identity test
 * skips those items). The `+<n>` group is **required** — a row that is exactly `…` or exactly `...` is ordinary body
 * text, and classifying it as the marker would silently exempt its item from the line-identity gate.
 */
export function isCappedTailRow(row: string): boolean {
  return /^(?:…|\.\.\.) ?\+\d+(?: rows(?: \((?:transcript\.log|log)\))?)?$/.test(row);
}

/**
 * TUI-DESIGN-4 §2.3: cap an **engine-produced** item's rows — up to `STATIC_ITEM_MAX_ROWS` rows pass through
 * unchanged; beyond it the first `STATIC_ITEM_MAX_ROWS − 1` rows are kept and the last row becomes the tail naming
 * where the rest is. An item carrying `detailRows` from a command block is exempt and must not be passed here
 * (it keeps its own §3.1.5 cap and footer); a proposal preview keeps `clipDetail`'s marker.
 */
export function capItemRows(rows: readonly string[], tail: (n: number) => string = (n) => cappedTailRow(n), max: number = STATIC_ITEM_MAX_ROWS): string[] {
  if (rows.length <= max) return [...rows];
  return [...rows.slice(0, max - 1), tail(rows.length - (max - 1))];
}
