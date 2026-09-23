/**
 * Committed transcript rows in `<Static>` (TUI-DESIGN §15.1, §14.1 A28, §13.4, DESIGN §10; TUI-DESIGN-2 §4.5; TUI-DESIGN-3 §5.1):
 * Ink writes each item once and never re-lays it out, so the array is append-only and every row is keyed by the item's
 * immutable key. Every item's **text** is still `formatTranscriptItem(item)` — label + one space + text; only spaces and
 * line breaks are added around it:
 *
 * - **the label gutter** (D-L, rule 1): a fixed 10-cell right-aligned label column — `[jevcode]` / `[sandbox]` sit flush, shorter
 *   labels are padded on the left, `[step 100]` touches the edge and longer labels push the body by the excess — so every body
 *   starts at column 10 (`LABEL_GUTTER`) and wrapped rows hang there. **TUI-DESIGN-4 §2.3 (D-AB)** turns that one shape into a
 *   three-rung ladder by terminal width (`src/tui/gutter.ts`, zero-import, every name re-exported here): `gutter` at ≥ 34
 *   columns, `stacked` (the label on its own row, the body indented 2) at 24–33, `flush` (no gutter, the label the first token
 *   of row 0 — §5.1 P-C3) below 24; and it caps one **engine-produced** item at `STATIC_ITEM_MAX_ROWS` rows, the last of them
 *   `… +N rows (transcript.log)`. An item carrying `detailRows` from a command block is **exempt** (§3.1.5 gives it its own cap
 *   and its own footer, so `/config --all`, `/help`, `/plan` and `/diff --all` are never cut to 23 rows);
 * - **the wrap** (rule 3): the body is pre-split by `wrapBody` (segment-aware at ` · `, the no-orphan rule) into one `<Text>` per
 *   row, which also removes Ink's trailing-space artefacts;
 * - **detail rows** (rule 4, TUI-only): indented under the body column; a `label  value` table row (`/^\S+\s{2,}/`, the epilogue)
 *   hangs its wrap under the value;
 * - **spacers** (rule 9, owner directive 3): one blank row above a `[you]` turn, above the first `[jevcode]` of a turn, above
 *   `[run] start` / `end`, above a `[ui]` item that carries a detail body, and above every block head — any item whose label
 *   differs from its predecessor's (`[step n]`, `[review]`, a `[ui]` note after a bubble);
 * - **colour** (D-O, rule 2): the label is the speaker (`[jevcode]` `assistant`, `[you]` `you`, both bold; every other label `dim`),
 *   the body is the meaning (default for chat, steps, `[ui]` notes and detail rows; `warn` / `error` by level or verdict; `dim` only
 *   for `[run] git …`); fence lines (`/^```\w*$/`) draw as `╶──── <lang>` in the `code` role — the only text substitution beyond `--ascii`.
 *
 * Identity (§5.3, TUI-DESIGN-4 §2.4): strip each row's leading spaces, join with one space — **empty at a cut**, the row
 * indices `wrapBodyCut` reports for a token the wrap had to split by grapheme — collapse space runs →
 * `formatTranscriptItem(item)` (`normaliseRows(rows, cuts)`). In `stacked` the declared clause is one more row to strip (the
 * label row joins the body with one space); in `flush` the label already *is* row 0's first token. The cap row is the one case
 * where the rows do not reconstruct the item and is declared a truncation marker, the same class as `clipDetail`'s
 * `…[N lines omitted]`. Colours come from the theme (`/theme` changes new items only, R4); the `epoch` key remounts `<Static>` with
 * a fresh array past the 20,000-item soft cap (the header is printed with epoch 0 only). Every item renders inside its own
 * `PaneBoundary` (§13.4). The component is memoised: a hidden-only batch changes no prop, so it dirties no `<Static>` subtree
 * (§4.5); the App's `keySeq` hands `<Static>` a fresh `style` per key so a key's frame takes Ink's immediate path (TD2 D-F).
 */
import { memo, useMemo, type ComponentProps } from 'react';
import { Box, Static, Text } from 'ink';
import { PaneBoundary, paneFailedLine, type PaneFailure } from './PaneBoundary.js';
import { stringWidth } from './composer/width.js';
import { formatTranscriptItem, isChatLabel, isRunHeaderItem, stepLabel, type TranscriptItem } from './plain.js';
import { PROSE_LABEL, proseLayout, type ProseLayout } from './reply-state.js';
import type { ProseStyle } from './transcript/markdown.js';
import { itemRole, labelRole, textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';
import { GLYPHS, glyphTwin, type GlyphSet } from './glyphs.js';
import { FLUSH_MIN_COLUMNS, LABEL_GUTTER, STACKED_MIN_COLUMNS, STATIC_ITEM_MAX_ROWS, cappedTailRow, cappedTailRowAscii, cappedTailRungs, capItemRows, gutterBodyWidth, gutterIndent, gutterMode, isCappedTailRow, rungBodyWidth, type GutterMode } from './gutter.js';
import { joinWrapped, wrapBody, wrapBodyCut } from './transcript/wrap.js';

/**
 * TUI-DESIGN-4 §2.3 / §3.1.2: `src/tui/gutter.ts` is the rung's home (zero imports, so the no-Ink `block/lines.ts` and the
 * first-frame path can reach it); every name is re-exported here so no existing importer of `Transcript.tsx` changes.
 */
export { FLUSH_MIN_COLUMNS, LABEL_GUTTER, STACKED_MIN_COLUMNS, STATIC_ITEM_MAX_ROWS, cappedTailRow, cappedTailRowAscii, cappedTailRungs, capItemRows, gutterBodyWidth, gutterIndent, gutterMode, isCappedTailRow, rungBodyWidth, type GutterMode };

/** The former `itemColor` rule, now theme-driven (kept as a named export for the tests). */
export function itemColor(item: TranscriptItem, theme: Theme = themeFor('dark'), enabled: ColorOn = true): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = itemRole(item);
  return role === null ? {} : textProps(theme, role, enabled);
}

/** The pane name of the per-item boundary (`JEVCODE_FAULT=render:static` throws once inside one item). */
export const STATIC_ITEM_PANE = 'static';

/** TUI-DESIGN-2 §4.5 / §9: the only text substitution beyond `--ascii` — a line that is exactly a code fence. */
export const FENCE_RE = /^```(\w*)$/;

/** TUI-DESIGN-3 §5.1 rule 4: a detail row shaped like the epilogue's `label     value` table hangs its wrap under the value. */
export const DETAIL_TABLE_RE = /^(\S+\s{2,})/;

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** rendered once at the top of the scrollback (the task / session header, present from the first frame) */
  header?: TranscriptItem;
  theme?: Theme;
  /** colour on/off or the depth (`colorDepth()`); markers stay either way */
  color?: ColorOn;
  /** `--ascii`: glyph twins on code-generated text (items stay canonical in transcript.log) */
  glyphs?: GlyphSet;
  /** `<Static>` remount generation (A28) */
  epoch?: number;
  /** §13.4: one failing item → one fallback row, reported here (the App logs and appends the `[ui]` item) */
  onFail?: (failure: PaneFailure) => void;
  /** `JEVCODE_FAULT` (`render:static` throws once inside one item) */
  fault?: string | undefined;
  /** the log name in the fallback row (default `jevcode.log`) */
  log?: string;
  /**
   * The commit width (TUI-DESIGN-2 §3.10 / §9; TUI-DESIGN-3 §5.1 rule 3): the body is pre-split at `columns − max(9, label) − 1`
   * cells by `wrapBody`, and each item box is laid out at exactly this width. Ink's `<Static>` box is `position: absolute` with no
   * width, so Yoga sizes it fit-content and never shrinks its flex items: without an exact width the body would wrap at the full
   * width and overflow the terminal by the gutter. Without `columns` (a test without geometry) the body is one `<Text>` Ink wraps.
   */
  columns?: number;
  /**
   * The App's `keySeq` (useEngine.tsx `UiState.keySeq`, TUI-DESIGN-2 §9 D-F): every key re-renders this memoised
   * component and hands `<Static>` a fresh `style` object, so Ink commits the key's frame on its immediate path
   * (`isStaticDirty` → `onImmediateRender`) instead of the 34 ms throttle's trailing edge. Nothing else re-renders it.
   */
  keySeq?: number;
  /**
   * The stream scheduler's leading-edge counter (`UiState.paintSeq`, TUI map top change 4): the first streamed append after
   * a quiet interval bumps it, which hands `<Static>` a fresh `style` exactly as a key does, so the first token of a reply
   * paints on Ink's immediate path instead of waiting out the trailing edge of the render throttle.
   */
  paintSeq?: number;
}

/** `<Static>`'s `style` prop type (a fresh object per key; the content never changes). */
type StaticStyle = NonNullable<ComponentProps<typeof Static>['style']>;

/** One item's lines: the formatted line, then its detail body split on '\n' (TUI-only, §15.1). */
export function itemLines(item: TranscriptItem, g: GlyphSet = GLYPHS.unicode): { line: string; detail: string[] } {
  const line = glyphTwin(formatTranscriptItem(item), g);
  const detail = item.detail === undefined || item.detail === '' ? [] : item.detail.split('\n').map((l) => glyphTwin(l, g));
  return { line, detail };
}

/** §13.4: the one-row fallback for an item that threw while rendering. */
export function itemFailedRow(errorName: string, log?: string): string {
  return paneFailedLine(STATIC_ITEM_PANE, errorName, log);
}

/**
 * OWNER ADDENDUM (2026-09): the two run-header items the INTERACTIVE transcript no longer prints — `[run] started ·
 * <badge> · <task>` (the status row already carries the run state, and the task is the `[you]` bubble one row above)
 * and `[run] git <branch> · <state>` (`/status` has git, and the status row's git zone repeats it every second).
 * They are dropped at the TUI's item filter only: `--plain`, `--json` and `transcript.log` keep every one of them,
 * exactly like the quiet start's `[sandbox]` rows. `[run] finished · …` stays — it is the one row the run's outcome
 * lives on. The `workspace` kind also carries `instructions: …` and the HEAD-drift warning, which are kept. The
 * predicate lives in `plain.ts` (the reducer reads it too, AGENT-LOOP-DESIGN §9.4) and is re-exported here.
 */
export { isRunHeaderItem };

/** TUI-DESIGN-2 §4.5: the label of a row — `item.label` (`[ui]`, `[you]`, `[jevcode]`, …) or `stepLabel(step)`. */
export function itemLabel(item: TranscriptItem): string {
  return item.label ?? stepLabel(item.step);
}

/** TUI-DESIGN-3 §5.1 rule 1: the label right-aligned in the gutter — `[jevcode]` flush, `     [ui]` padded, `[step 100]` and longer as they are. */
export function gutterLabel(label: string): string {
  const pad = LABEL_GUTTER - 1 - stringWidth(label);
  return pad > 0 ? `${' '.repeat(pad)}${label}` : label;
}

/**
 * TUI-DESIGN-3 §5.1 rule 1 + TUI-DESIGN-4 §2.3 (D-AB): the body's width at a commit width — the **rung's** body width
 * (`columns − max(9, label cells) − 1` in `gutter`, `columns − 2` in `stacked`, `columns` in `flush`), never below 1.
 */
export function bodyWidth(columns: number, label: string): number {
  return gutterBodyWidth(columns, stringWidth(label));
}

/**
 * TUI-DESIGN-4 §2.3: an item carrying `detailRows` from a command block (§3.1.3) is **exempt** from
 * `STATIC_ITEM_MAX_ROWS` — it already carries its own §3.1.5 cap (`/config` 24 · `/help` 60 · `/plan` 40 · `/diff` 42 ·
 * `/diff --all` `Infinity`) and its own `… +N more · <command>` footer, so capping it at 24 rows would destroy every
 * documented escape hatch. The contract member (§8 item 1) is landed by the `plain.ts` owner, so the predicate reads
 * it structurally and answers `false` until then; engine items (`itemsFromEvent`, `stepSummaryText`, `[sandbox]`)
 * never carry it.
 */
export function isBlockItem(item: TranscriptItem): boolean {
  if (!('detailRows' in item)) return false;
  const rows = (item as { readonly detailRows?: unknown }).detailRows;
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * TUI-DESIGN-3 §5.1 rule 3 + TUI-DESIGN-4 §2.3: the body's rows and their cut indices at a commit width. One row and no
 * cuts without geometry. `cap` applies D-AB's per-item row cap to an **engine-produced** item: beyond
 * `STATIC_ITEM_MAX_ROWS` the first 23 rows are kept and the last becomes `… +N rows (transcript.log)` (the `--ascii`
 * twin uses `...`). The cap row is a declared truncation marker, so `cuts` past it are dropped with the rows.
 */
export function bodyRowsCut(text: string, columns: number | undefined, label: string, g: GlyphSet = GLYPHS.unicode, cap = false): { rows: string[]; cuts: readonly number[]; capped: boolean } {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return { rows: [text], cuts: [], capped: false };
  const w = wrapBodyCut(text, bodyWidth(columns, label), g);
  if (!cap || w.rows.length <= STATIC_ITEM_MAX_ROWS) return { rows: w.rows, cuts: w.cuts, capped: false };
  const tailWidth = bodyWidth(columns, label);
  const rows = capItemRows(w.rows, (n) => cappedTailRow(n, tailWidth, g.mode === 'ascii'));
  return { rows, cuts: w.cuts.filter((c) => c < rows.length - 1), capped: true };
}

/** TUI-DESIGN-3 §5.1 rule 3: the body's rows at a commit width (`wrapBody`); one row without geometry. */
export function bodyRows(text: string, columns: number | undefined, label: string, g: GlyphSet = GLYPHS.unicode, cap = false): string[] {
  return bodyRowsCut(text, columns, label, g, cap).rows;
}

/**
 * TUI-DESIGN-3 §5.1 rule 4: a detail line's rows at the body width — a `label     value` row (`DETAIL_TABLE_RE`) wraps its value
 * and hangs the continuations under the value column; any other line wraps like a body. One row without geometry.
 */
export function detailRows(line: string, width: number | undefined, g: GlyphSet = GLYPHS.unicode): string[] {
  if (width === undefined || !Number.isFinite(width) || width <= 0) return [line];
  const m = DETAIL_TABLE_RE.exec(line);
  if (m === null) return wrapBody(line, width, g);
  const head = m[1]!;
  const hang = stringWidth(head);
  const value = line.slice(head.length);
  if (hang >= width - 4) return wrapBody(line, width, g);
  const rows = wrapBody(value, width - hang, g);
  return rows.map((r, i) => (i === 0 ? `${head}${r}` : `${' '.repeat(hang)}${r}`));
}

/**
 * TUI-DESIGN-3 §5.3 / TUI-DESIGN-4 §2.4: the identity normaliser over a rendered item's rows (the label row and its hanging
 * continuations; detail rows excluded by the caller) — strip leading spaces, join with one space **except at a cut**,
 * collapse runs → `formatTranscriptItem(item)`. `cuts` defaults to `[]`, which is exactly the round-3 behaviour, so the two
 * existing in-process helpers keep compiling while they are moved to `joinWrapped(rows, cuts)`. In the `stacked` rung the
 * label row is row 0 and joins the body with one space — one more row to strip, no new clause; in `flush` the label is
 * already row 0's first token.
 */
export function normaliseRows(rows: readonly string[], cuts: readonly number[] = []): string {
  return joinWrapped(rows, cuts);
}

/** TUI-DESIGN-4 §2.3: true when a rendered item's last row is the cap's truncation marker, at any rung of its ladder (the identity test skips those items). */
export function isCapRow(row: string): boolean {
  return isCappedTailRow(row);
}

/** TUI-DESIGN-2 §4.5 / §9: a fence line becomes `╶──── <lang>` / `╶────`; anything else is returned unchanged. */
export function fenceRow(text: string, g: GlyphSet = GLYPHS.unicode): { text: string; fence: boolean } {
  const m = FENCE_RE.exec(text);
  if (m === null) return { text, fence: false };
  const lang = m[1] ?? '';
  return { text: `${g.fence}${g.rule.repeat(4)}${lang === '' ? '' : ` ${lang}`}`, fence: true };
}

/**
 * TUI-DESIGN-2 §4.5 / TUI-DESIGN-3 §5.1 rule 9 + **TUI-DESIGN-4 §5.1 P-C1 (D-Y)** + **owner directive 3 (2026-09)**:
 * one spacer per **block**, never per item — above the **first** item of a chat turn, above `[run] start` / `[run]
 * end`, above a `[ui]` item that carries a detail body (`/jev`, `/cost`, the epilogue, `/help`), and above every
 * other item whose label differs from its predecessor's (each `[step n]` head, a `[review]`, a `[ui]` note that
 * follows a bubble). So a `[you]` message and its `[jevcode]` reply, a reply and the next `[you]`, and every
 * `[run]` / `[step]` block are separated by exactly one blank row, and nothing is ever separated by two.
 *
 * Round 3 had `if (item.label === '[you]') return true;` **unconditionally** while `[jevcode]` one line later was
 * already conditioned on `prev.label !== item.label`, so a 3-line `[you]` message drew a blank row between every line
 * (6 rows for 3 lines; 17 for the 9-line paste A5 measured). Both branches are now the one rule
 * `isChatLabel(item.label) ⇒ prev.label !== item.label`, which is exactly `isTurnContinuation`'s negation — the two
 * halves of D-Y ship together, so a continuation item never draws a dim label *and* a blank row above it (the dim
 * label says "same turn" and the blank row said "new block": §5.1's table wants one signal, not two).
 */
export function spacerAbove(item: TranscriptItem, prev: TranscriptItem | null): boolean {
  if (prev === null) return false;
  if (isChatLabel(item.label)) return !isTurnContinuation(item, prev);
  if (item.kind === 'run:start' || item.kind === 'run:end') return true;
  if (item.label === '[ui]' && item.detail !== undefined && item.detail !== '') return true;
  // owner directive 3: every BLOCK head gets its blank row — a `[step n]` head, a `[review]`, a `[ui]` note after a
  // bubble. A run of items sharing one label (a step's own rows, consecutive `[ui]` notes) stays contiguous, so two
  // blank rows can never land in a row and a multi-row block still reads as one thing.
  return itemLabel(item) !== itemLabel(prev);
}

/**
 * TUI-DESIGN-3 §5.1 rule 2 (D-O): the body's role — the meaning, never the speaker. `warn` / `error` by level or verdict (the
 * theme's `itemRole`), `dim` for `level: 'dim'` (the quiet startup items) and for the `[run] git …` workspace rows; chat bodies,
 * steps, `[ui]` notes and proposals stay default.
 */
export function bodyRole(item: TranscriptItem): ColorRole | null {
  // the quiet startup grade: a `dim` item IS its dim body (the `[sandbox]` / `recent:` one-liners)
  if (item.level === 'dim') return 'dim';
  const role = itemRole(item);
  if (role === 'you' || role === 'assistant') return null;
  if (role === 'dim') return item.kind === 'workspace' ? 'dim' : null;
  return role;
}

/**
 * TUI-DESIGN-4 §5.1 (D-Y, as ratified): a **turn** is a maximal run of contiguous visible items sharing the same chat
 * label. `prev` is the visible predecessor (under `compact` too), so "same label ⇒ same turn" is the whole rule; a
 * `[ui]`/`[run]`/`[step]` item is its own block and is never a continuation.
 */
export function isTurnContinuation(item: TranscriptItem, prev: TranscriptItem | null): boolean {
  return prev !== null && isChatLabel(item.label) && prev.label === item.label;
}

/**
 * TUI-DESIGN-3 §5.1 rule 2 (D-O) + TUI-DESIGN-4 §5.1 (D-Y): the label's props — the two chat labels in their pinks,
 * bold on the **first** item of a turn; the *same text* at `dim` on every continuation item, **including the item that
 * is a surviving blank line**, so the gutter stays a column of labels instead of a column of shouting. Every other
 * label is dim as before. This is a **colour-only** change: `gutterLabel(label)` is still rendered unconditionally
 * (`Transcript.tsx`'s one `<Text {...lProps}>` below), `stripAnsi` is unchanged, and every TUI row still normalises to
 * `formatTranscriptItem(item)` — under `NO_COLOR` the two forms are byte-identical.
 */
export function labelProps(item: TranscriptItem, theme: Theme, color: ColorOn, continuation = false): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = labelRole(item);
  if (continuation && role !== 'dim') return textProps(theme, 'dim', color);
  const props = textProps(theme, role, color);
  return role === 'dim' || Object.keys(props).length === 0 ? props : { ...props, bold: true };
}

/**
 * TUI-DESIGN-4 §2.3 (D-AB): **every row one item commits**, at its rung — the body rows and, under them, the rows of
 * a plain `detail` string — with the cap applied to the **whole** budget when the item is engine-produced.
 *
 * The cap is keyed on the item's SOURCE, and the source owns all of its rows: `clipDetail` bounds a detail's source
 * *lines*, not its rendered rows, so at a narrow rung each of those lines re-wraps into four to eight rows and an
 * item whose body alone is under 24 rows still commits far more (measured on this tree: one `[run]` item with a
 * six-line epilogue detail draws 27 rows at 10 columns and 34 at 16). Capping the body alone would leave exactly the
 * wall D-AB exists to close. An item carrying `detailRows` from a command block is exempt whole (§3.1.5 gives it its
 * own cap and footer), and the tail names everything not drawn, wherever the cut falls.
 */
export function itemRenderRows(item: TranscriptItem, columns: number | undefined, g: GlyphSet = GLYPHS.unicode): { body: string[]; detail: string[]; mode: GutterMode; indent: number; width: number | undefined; fence: boolean; capped: boolean } {
  const label = glyphTwin(itemLabel(item), g);
  const f = fenceRow(item.text, g);
  const hasWidth = columns !== undefined && Number.isFinite(columns) && columns > 0;
  const mode: GutterMode = hasWidth ? gutterMode(columns) : 'gutter';
  // `flush`: the label is the first token of row 0, so the body text carries it and the plain join already returns the item
  const text = mode === 'flush' ? `${label} ${f.fence ? f.text : glyphTwin(item.text, g)}` : f.fence ? f.text : glyphTwin(item.text, g);
  const gutterLabelCells = mode === 'gutter' ? label : '';
  const body = bodyRows(text, hasWidth ? columns : undefined, gutterLabelCells, g, false);
  const width = hasWidth ? bodyWidth(columns, gutterLabelCells) : undefined;
  const indent = hasWidth ? gutterIndent(columns, stringWidth(label)) : LABEL_GUTTER;
  const detail = itemLines(item, g).detail.flatMap((d) => detailRows(d, width, g));
  // the `stacked` rung spends one of the item's rows on the label's own row, so the cap's budget is one smaller
  // there: `STATIC_ITEM_MAX_ROWS` bounds what the ITEM commits to the scrollback, not what this function returns
  const max = STATIC_ITEM_MAX_ROWS - (mode === 'stacked' ? 1 : 0);
  if (isBlockItem(item) || body.length + detail.length <= max) return { body, detail, mode, indent, width, fence: f.fence, capped: false };
  const tailWidth = width ?? Number.POSITIVE_INFINITY;
  const all = capItemRows([...body, ...detail], (n) => cappedTailRow(n, tailWidth, g.mode === 'ascii'), max);
  return { body: all.slice(0, Math.min(body.length, all.length)), detail: all.slice(Math.min(body.length, all.length)), mode, indent, width, fence: f.fence, capped: true };
}

/** AGENT-LOOP-DESIGN §9.4: the Ink props of a prose style (bold · the code role · the bullet in the accent · a bold heading). */
function proseStyleProps(style: ProseStyle, theme: Theme, color: ColorOn): { color?: string; dimColor?: boolean; bold?: boolean } {
  switch (style) {
    case 'bold':
    case 'heading':
      return { bold: true };
    case 'code':
      return textProps(theme, 'code', color);
    case 'bullet':
      return textProps(theme, 'accent', color);
    case 'plain':
      return {};
  }
}

/** The props of the reply block's streaming caret (`▍`, the legacy live region's `sweep`). */
export interface ProseCaret {
  readonly text: string;
}

/**
 * AGENT-LOOP-DESIGN §9.4 / §A1: every terminal row one prose item draws, as a flat list of one-row `<Text>`s — the blank
 * spacer row, the label row (stacked / flush rungs), then the body rows with the label (or its blank cell) in the gutter.
 * `<Static>` renders the whole list; the reply block renders the tail of the same list, so a committed line draws the
 * rows it streamed in, byte for byte. `caret` is appended to the last body row (never wider: the row truncates).
 */
export function proseItemRows(item: TranscriptItem, prev: TranscriptItem | null, columns: number | undefined, theme: Theme, color: ColorOn, glyphs: GlyphSet, caret: ProseCaret | null = null, layout?: ProseLayout): React.JSX.Element[] {
  const l = layout ?? proseLayout(item, prev, columns, glyphs);
  const label = glyphTwin(PROSE_LABEL, glyphs);
  const lProps = labelProps(item, theme, color, isTurnContinuation(item, prev));
  const out: React.JSX.Element[] = [];
  if (l.spacer) out.push(<Text key={`${item.key}:sp`} wrap="truncate"> </Text>);
  if (l.labelRow) out.push(<Text key={`${item.key}:lr`} wrap="truncate" {...lProps}>{label}</Text>);
  const gutter = l.mode === 'gutter' ? l.indent - 1 : 0;
  // a partial text line that ends in whitespace: the wrap drops the trailing gap, so the caret keeps it (one free cell)
  // and stands where the next word will start, not hugging the last one
  const trailingGap = item.prose?.partial === true && item.prose.role === 'text' && /\s$/u.test(item.prose.line);
  l.rows.forEach((row, i) => {
    // the caret only ever takes a FREE cell: on a full row it would push Ink's truncation ellipsis over the last glyph
    const cells = i === l.rows.length - 1 ? stringWidth(row.parts.map((p) => p.text).join('')) : l.width;
    const last = cells < l.width;
    const gap = last && trailingGap && cells > 0 && cells + 1 < l.width ? ' ' : '';
    out.push(
      <Text key={`${item.key}:r${i}`} wrap="truncate">
        {l.mode === 'gutter' ? i === 0 && l.labelCell ? <Text {...lProps}>{gutterLabel(label)}</Text> : ' '.repeat(gutter) : null}
        {l.mode === 'gutter' ? ' ' : l.mode === 'stacked' ? '  ' : ''}
        {row.parts.map((p, k) => (
          <Text key={`p${k}`} {...proseStyleProps(p.style, theme, color)}>
            {p.text}
          </Text>
        ))}
        {last && caret !== null && caret.text !== '' ? <Text {...textProps(theme, 'sweep', color)}>{`${gap}${caret.text}`}</Text> : null}
      </Text>,
    );
  });
  return out;
}

/**
 * TUI-DESIGN-4 §2.3 (D-AB) / §5.1 P-C3: one rendered item at its rung. `gutter` is round 3's shape unchanged. In
 * `stacked` the label takes its own row and the body hangs at 2 cells, so a 24–33-column terminal keeps every
 * character instead of wrapping a 1-cell body. In `flush` the label box is dropped entirely and the label is
 * prefixed into the body's text — `columns ≤ 10` degrades to plain wrapped text rather than a zero-width body
 * (`flexShrink={0}` on a 9-cell box would otherwise eat the whole row). The cap is applied to engine items only.
 * AGENT-LOOP-DESIGN §9.4: a prose item draws `proseItemRows` instead — the rows the reply block streamed it in.
 */
export function TranscriptRow({ item, prev, theme, color, glyphs, columns }: { item: TranscriptItem; prev: TranscriptItem | null; theme: Theme; color: ColorOn; glyphs: GlyphSet; columns: number | undefined }): React.JSX.Element {
  if (item.prose !== undefined) {
    const hasWidth = columns !== undefined && Number.isFinite(columns) && columns > 0;
    return (
      <Box flexDirection="column" {...(hasWidth ? { width: columns } : {})}>
        {proseItemRows(item, prev, columns, theme, color, glyphs)}
      </Box>
    );
  }
  const label = glyphTwin(itemLabel(item), glyphs);
  const role = bodyRole(item);
  const r = itemRenderRows(item, columns, glyphs);
  const bodyProps = r.fence ? textProps(theme, 'code', color) : role === null ? {} : textProps(theme, role, color);
  const lProps = labelProps(item, theme, color, isTurnContinuation(item, prev));
  const hasWidth = columns !== undefined && Number.isFinite(columns) && columns > 0;
  const bodyRowEls = r.body.map((row, i) => (
    <Text key={`${item.key}:b${i}`} wrap="truncate" {...bodyProps}>
      {row}
    </Text>
  ));
  const detailEls = r.detail.map((row, i) => (
    <Box key={`${item.key}:d${i}`} {...(r.indent > 0 ? { marginLeft: r.indent } : {})}>
      <Text wrap="truncate">{row}</Text>
    </Box>
  ));
  if (hasWidth && r.mode !== 'gutter') {
    return (
      <Box flexDirection="column" marginTop={spacerAbove(item, prev) ? 1 : 0} width={columns}>
        {r.mode === 'stacked' ? <Text wrap="truncate" {...lProps}>{label}</Text> : null}
        <Box flexDirection="column" {...(r.mode === 'stacked' ? { marginLeft: 2 } : {})}>{bodyRowEls}</Box>
        {detailEls}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={spacerAbove(item, prev) ? 1 : 0} {...(hasWidth ? { width: columns } : {})}>
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text {...lProps}>{gutterLabel(label)}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          {hasWidth ? bodyRowEls : <Text {...bodyProps}>{r.body[0] ?? ''}</Text>}
        </Box>
      </Box>
      {detailEls}
    </Box>
  );
}

function TranscriptImpl({ items, header, theme = themeFor('dark'), color = true, glyphs = GLYPHS.unicode, epoch = 0, onFail, fault, log, columns, keySeq = 0, paintSeq = 0 }: TranscriptProps): React.JSX.Element {
  // a new (empty) style object per key (and per leading-edge stream flush) → Ink's reconciler runs `commitUpdate` on the
  // <Static> box → immediate render
  const staticStyle = useMemo<StaticStyle>(() => ({}), [keySeq, paintSeq]);
  // Prepending keeps the array append-only from <Static>'s point of view: index 0 never changes. After a soft-cap
  // remount (epoch > 0) the header is already in the scrollback and is never printed again.
  const all = useMemo(() => (header && epoch === 0 ? [header, ...items] : [...items]), [header, items, epoch]);
  return (
    <Static key={`static-${epoch}`} items={all} style={staticStyle}>
      {(item, index) => (
        // `render:static` targets the first item only: every item of one pass renders before any boundary's
        // componentDidCatch marks the fault as fired, so a fault on all of them would degrade the whole pass
        <PaneBoundary key={item.key} pane={STATIC_ITEM_PANE} fault={index === 0 ? fault : undefined} {...(onFail ? { onFail } : {})} {...(log !== undefined ? { log } : {})} fallback={(f) => <Text color="red" wrap="truncate">{itemFailedRow(f.error.name, log)}</Text>}>
          <TranscriptRow item={item} prev={index > 0 ? (all[index - 1] ?? null) : null} theme={theme} color={color} glyphs={glyphs} columns={columns} />
        </PaneBoundary>
      )}
    </Static>
  );
}

/** TUI-DESIGN-2 §4.5: memoised so a hidden-only batch (same `visibleItems` array) re-renders nothing under `<Static>`. */
export const Transcript = memo(TranscriptImpl);
