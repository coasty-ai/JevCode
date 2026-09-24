/**
 * TUI-DESIGN-4 §1.3.3 — the fullscreen renderer's scrolled transcript index, and its scroll model. **Pure**: no Ink,
 * no React, no clock, no I/O. `src/tui/fullscreen/Viewport.tsx` renders a slice of what this module produces.
 *
 * The identity guarantee is the whole point of building the index out of `<Transcript>`'s **own** builders
 * (`itemLines` → `bodyRowsCut` → `detailRows`, `src/tui/Transcript.tsx:89–200`): for every item,
 * `normaliseRows(index.rowsFor(i), index.cutsFor(i)) === formatTranscriptItem(item)` — the same assertion the classic
 * transcript identity suite makes, run a second time against this builder. The rows are the same rows, sliced.
 *
 * What the index does (§1.3.3 a–d):
 *  - (a) **incremental append** — `appendItems` wraps only the new items and reuses every row already built;
 *  - (b) **a full rebuild on a width or glyph-set change** — `rebuildFor` returns the old index unchanged when
 *    neither moved, so a caller can keep serving the old one until the new one is ready (edge 4: two widths are
 *    never interleaved);
 *  - (c) `sliceRows(index, top, n)`;
 *  - (d) sticky-to-bottom anchoring through `resolveTop` / `applyScroll`.
 *
 * Edge cases honoured here: (1) the index is capped at `STATIC_SOFT_CAP` items and row 0 becomes
 * `▲ <n> earlier rows · see transcript.log`; (3) the index is **rows**, not items, so scrolling inside one very tall
 * item falls out; (5) zero items is a blank viewport, never a negative slice; (7) the glyph set is part of the index
 * key but the **theme is not** — colours are applied at render from the item, so `/theme` never rebuilds the index
 * (the `--ascii` twins are not width-preserving, `…` → `...`, so glyphs must be); (8) an append while the user is
 * detached does not move `top`; (9) `PgUp` past the top clamps and `PgDn` past the bottom reattaches.
 *
 * Mouse reporting stays off (A1 §3.7: Ink has no mouse parser and an SGR report reaches `useInput` as the literal
 * text `[<64;10;5M`), so the only way to move is the keys of §1.3.3 — and `Home` / `End` are **not** among them:
 * `bindings.ts:92–93` bind them to `composer:lineStart` / `composer:lineEnd` and §1.3.5's "the key resolver
 * unchanged" means a fullscreen user must not lose them.
 */
import { GLYPHS, cellWidth, glyphTwin, type GlyphSet } from '../glyphs.js';
import { bodyRowsCut, bodyWidth, detailRows, fenceRow, gutterLabel, itemLabel, itemLines, isBlockItem, spacerAbove } from '../Transcript.js';
import { STATIC_ITEM_MAX_ROWS, capItemRows, cappedTailRow, gutterIndent, gutterMode, type GutterMode } from '../gutter.js';
import { stringWidth } from '../composer/width.js';
import type { TranscriptItem } from '../plain.js';
import { STATIC_SOFT_CAP } from '../useEngine.js';

/** §1.3.3 edge 1: the index holds at most this many items — the same soft cap `<Static>` already keeps. */
export const VIEWPORT_ITEM_CAP = STATIC_SOFT_CAP;

/** §1.3.3: the scroll anchor. `bottom` is sticky (opencode's `stickyStart: "bottom"`); `row` is a **row index**, not a percentage, so a review collapsing the composer does not move the view (edge 10). */
export type Scroll = { readonly anchor: 'bottom' } | { readonly anchor: 'row'; readonly top: number };

/** §1.3.3: the sticky default. */
export const SCROLL_BOTTOM: Scroll = { anchor: 'bottom' };

/** One screen row of the index. `item` is the index of the item it came from (`-1` for the elision marker and for spacers). */
export interface ViewportRow {
  readonly text: string;
  readonly item: number;
  /** true when this row is part of the item's `detail` body rather than its wrapped line (the renderer dims it) */
  readonly detail: boolean;
  /** a blank spacer row (rule 9) — never part of the identity join */
  readonly spacer: boolean;
}

/** §1.3.3: the wrapped-row index of a transcript at one width and one glyph set. */
export interface ViewportIndex {
  readonly columns: number;
  readonly ascii: boolean;
  /** every wrapped screen row, oldest first; row 0 is the elision marker once items have been dropped */
  readonly rows: readonly ViewportRow[];
  /** the items this index was built from (the tail of the caller's list once the cap bites) */
  readonly items: readonly TranscriptItem[];
  /** how many items were dropped off the front by `VIEWPORT_ITEM_CAP` */
  readonly dropped: number;
  /** per-item `[start, count)` into `rows`, parallel to `items` */
  readonly spans: readonly { readonly start: number; readonly count: number }[];
  /** per-item cut indices (`wrapBodyCut`), for the identity normaliser */
  readonly cuts: readonly (readonly number[])[];
}

/**
 * §12's `▲` and its `--ascii` twin `^` come from `GlyphSet.triangleUp`: the pair is one row of TD §14.1's
 * one-to-one twin table, so `glyphTwin` sees it too.
 */

/** The `▲ <n> earlier rows · see transcript.log` marker (§1.3.3 edge 1 / §12) — the rows past the cap are gone from the index but are in the log. */
export function earlierRowsDropped(n: number, g: GlyphSet = GLYPHS.unicode): string {
  return `${g.triangleUp} ${group(n)} earlier rows ${g.dot} see transcript.log`;
}

/** The `▲ <n> earlier rows · PgUp` marker (§12) — the rows are still in the index, above the viewport's top. */
export function earlierRowsAbove(n: number, g: GlyphSet = GLYPHS.unicode): string {
  return `${g.triangleUp} ${group(n)} earlier rows ${g.dot} PgUp`;
}

/** Thousands grouping, the codebase's existing form (`chat/bubbles.ts:53`, `import/report.ts:57`): `1,240`. */
function group(n: number): string {
  return String(Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * §1.3.2's ladder block and frames F-H3 / F-H4 / F-H5 draw the position segment's counters as `1 240/3 512` — a
 * plain space, not the product's comma (finding 12). The frames are the spec and `docs/**` is S6's, so the builder
 * matches the document here and `positionRungs` is pinned byte-exact against it; `group()` (comma) keeps its other
 * callers, which no frame draws.
 */
function groupPos(n: number): string {
  return String(Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** An empty index at a geometry (the zero-item case, edge 5: the viewport is blank and the total is still exactly `rows`). */
export function emptyIndex(columns: number, g: GlyphSet = GLYPHS.unicode): ViewportIndex {
  return { columns: size(columns), ascii: g.mode === 'ascii', rows: [], items: [], dropped: 0, spans: [], cuts: [] };
}

function size(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * The rows one item contributes. This **mirrors `<Transcript>`'s `itemRenderRows` step for step** — the same
 * `fenceRow` / `glyphTwin` text, the same `flush` label folding (the label is the first token of row 0's *text*, so
 * the row is never wider than the terminal), the same body width, and D-AB's per-item cap applied to
 * `body + detail` **together**, with the same `max` reduction on the `stacked` rung. Capping the body alone produced
 * a different row count *and* a different `… +N rows (transcript.log)` marker from the classic renderer for every
 * item carrying a `detail` (measured: 27 rows / `… +12` against 24 rows / `… +15`), which §1.3.5 and §10's "the two
 * renderers' item rows must be equal for the same item list" forbid and the join-based identity normaliser cannot
 * see (the cap marker is a declared exemption).
 *
 * The one thing `itemRenderRows` does not return is `wrapBodyCut`'s cut indices, which §2.4's identity normaliser
 * needs — hence `bodyRowsCut` here rather than `bodyRows`; they are the same function.
 */
function rowsOfItem(item: TranscriptItem, at: number, columns: number, g: GlyphSet): { rows: ViewportRow[]; cuts: readonly number[] } {
  const label = glyphTwin(itemLabel(item), g);
  const f = fenceRow(item.text, g);
  const w = size(columns);
  const mode: GutterMode = gutterMode(w);
  // `flush`: the label is the first token of row 0's TEXT (never a wider row head), exactly as `itemRenderRows` does
  const text = mode === 'flush' ? `${label} ${f.fence ? f.text : glyphTwin(item.text, g)}` : f.fence ? f.text : glyphTwin(item.text, g);
  const gutterLabelCells = mode === 'gutter' ? label : '';
  const built = bodyRowsCut(text, w, gutterLabelCells, g, false);
  const width = bodyWidth(w, gutterLabelCells);
  const indent = gutterIndent(w, stringWidth(label));
  const detailAll = itemLines(item, g).detail.flatMap((d) => detailRows(d, width, g));
  // the `stacked` rung spends one of the item's rows on the label's own row, so the cap's budget is one smaller there
  const max = STATIC_ITEM_MAX_ROWS - (mode === 'stacked' ? 1 : 0);
  let bodyText = built.rows;
  let detailText = detailAll;
  let cuts = built.cuts;
  if (!isBlockItem(item) && bodyText.length + detailText.length > max) {
    const all = capItemRows([...bodyText, ...detailText], (n) => cappedTailRow(n, width, g.mode === 'ascii'), max);
    const kept = Math.min(bodyText.length, all.length);
    bodyText = all.slice(0, kept);
    detailText = all.slice(kept);
    // the last drawn row is the cap marker, which is a declared truncation exemption: no cut may point past it
    cuts = built.cuts.filter((c) => c < (detailText.length === 0 ? bodyText.length - 1 : bodyText.length));
  }
  const out: ViewportRow[] = [];
  if (mode === 'stacked') out.push({ text: label, item: at, detail: false, spacer: false });
  for (const [i, row] of bodyText.entries()) {
    const head = mode === 'gutter' ? (i === 0 ? `${gutterLabel(label)} ` : ' '.repeat(indent)) : mode === 'stacked' ? '  ' : '';
    out.push({ text: `${head}${row}`, item: at, detail: false, spacer: false });
  }
  for (const row of detailText) out.push({ text: `${' '.repeat(indent)}${row}`, item: at, detail: true, spacer: false });
  // `cuts` index into the body rows only, and in `stacked` the label row shifts them by one
  const shift = mode === 'stacked' ? 1 : 0;
  return { rows: out, cuts: cuts.map((c) => c + shift) };
}

/** §1.3.3: build the whole index at a width. O(items); use `appendItems` for the steady state. */
export function buildIndex(items: readonly TranscriptItem[], columns: number, g: GlyphSet = GLYPHS.unicode): ViewportIndex {
  const w = size(columns);
  const ascii = g.mode === 'ascii';
  if (w === 0) return { columns: 0, ascii, rows: [], items: [...items], dropped: 0, spans: items.map(() => ({ start: 0, count: 0 })), cuts: items.map(() => []) };
  const dropped = Math.max(0, items.length - VIEWPORT_ITEM_CAP);
  const kept = dropped === 0 ? items : items.slice(dropped);
  const rows: ViewportRow[] = [];
  const spans: { start: number; count: number }[] = [];
  const cuts: (readonly number[])[] = [];
  if (dropped > 0) rows.push({ text: earlierRowsDropped(dropped, g), item: -1, detail: false, spacer: false });
  for (const [i, item] of kept.entries()) {
    if (spacerAbove(item, i === 0 ? null : (kept[i - 1] ?? null))) rows.push({ text: '', item: -1, detail: false, spacer: true });
    const built = rowsOfItem(item, i, w, g);
    spans.push({ start: rows.length, count: built.rows.length });
    cuts.push(built.cuts);
    rows.push(...built.rows);
  }
  return { columns: w, ascii, rows, items: [...kept], dropped, spans, cuts };
}

/**
 * §1.3.3 (a): append **only** the new items. `next` must start with `index.items` (the append-only `<Static>`
 * contract); when it does not — a `/new`, a `--resume` replay or the soft-cap epoch bump — the index is rebuilt.
 * Edge 6: a hidden-only batch changes nothing, so the **same object** comes back and no consumer re-renders.
 */
export function appendItems(index: ViewportIndex, next: readonly TranscriptItem[], g: GlyphSet = GLYPHS.unicode): ViewportIndex {
  if (index.columns === 0 || (g.mode === 'ascii') !== index.ascii) return buildIndex(next, index.columns, g);
  const base = index.dropped;
  // how many of `next` this index already covers (the dropped head plus the kept tail)
  const have = base + index.items.length;
  if (next.length < have) return buildIndex(next, index.columns, g);
  // O(1) append check, not an O(n) scan: the list is append-only by contract, so the same LAST covered item
  // identifies it. A `/new`, a `--resume` replay or the soft-cap epoch bump replaces the array and fails this test.
  if (index.items.length === 0 ? base > 0 : next[have - 1] !== index.items[index.items.length - 1]) return buildIndex(next, index.columns, g);
  if (next.length === have) return index;

  // §1.3.3 (a) past the soft cap: shed the items the cap now drops WITHOUT re-wrapping anything that survives.
  // Falling back to `buildIndex` here made every append past 20 000 items pay A1's 16.3 ms rebuild for the rest of
  // the session — which is the one size at which incremental append was asked for.
  const dropped = Math.max(0, next.length - VIEWPORT_ITEM_CAP);
  const remove = dropped - base;
  let rows: ViewportRow[];
  let spans: { start: number; count: number }[];
  let cuts: (readonly number[])[];
  let kept: TranscriptItem[];
  if (remove > 0) {
    // `buildIndex` emits the spacer directly above an item's span, so slicing at the first survivor's `start` drops
    // it with the item — exactly what `buildIndex` would do (it never emits a spacer above the first kept item).
    const cut = index.spans[remove]?.start ?? index.rows.length;
    const shift = cut - 1; // the new array is [marker, ...rows.slice(cut)]
    rows = [{ text: earlierRowsDropped(dropped, g), item: -1, detail: false, spacer: false }];
    for (const r of index.rows.slice(cut)) rows.push({ text: r.text, item: r.item >= 0 ? r.item - remove : -1, detail: r.detail, spacer: r.spacer });
    spans = index.spans.slice(remove).map((sp) => ({ start: sp.start - shift, count: sp.count }));
    cuts = index.cuts.slice(remove);
    kept = index.items.slice(remove);
  } else {
    rows = [...index.rows];
    spans = [...index.spans];
    cuts = [...index.cuts];
    kept = [...index.items];
    if (dropped > 0) rows[0] = { text: earlierRowsDropped(dropped, g), item: -1, detail: false, spacer: false };
  }
  for (let i = have; i < next.length; i++) {
    const item = next[i]!;
    if (spacerAbove(item, next[i - 1] ?? null)) rows.push({ text: '', item: -1, detail: false, spacer: true });
    const built = rowsOfItem(item, kept.length, index.columns, g);
    spans.push({ start: rows.length, count: built.rows.length });
    cuts.push(built.cuts);
    rows.push(...built.rows);
    kept.push(item);
  }
  return { columns: index.columns, ascii: index.ascii, rows, items: kept, dropped, spans, cuts };
}

/**
 * §1.3.3 (b): the width / glyph-set guard. Returns the **same** index when neither moved (so nothing rebuilds on a
 * `/theme`, edge 7) and a fresh one otherwise. Edge 4: the caller keeps serving the old index until this returns.
 */
export function rebuildFor(index: ViewportIndex, items: readonly TranscriptItem[], columns: number, g: GlyphSet = GLYPHS.unicode): ViewportIndex {
  if (size(columns) === index.columns && (g.mode === 'ascii') === index.ascii) return appendItems(index, items, g);
  return buildIndex(items, columns, g);
}

/** §1.3.3: the rows of item `i` (the identity test's input — `normaliseRows(rowsFor(idx, i), cutsFor(idx, i))`). */
export function rowsFor(index: ViewportIndex, i: number): readonly string[] {
  const span = index.spans[i];
  if (span === undefined) return [];
  return index.rows.slice(span.start, span.start + span.count).filter((r) => !r.detail).map((r) => r.text);
}

/** §1.3.3: the cut indices of item `i` (the row indices at which `wrapBodyCut` had to split a token by grapheme). */
export function cutsFor(index: ViewportIndex, i: number): readonly number[] {
  return index.cuts[i] ?? [];
}

/** §1.3.3 (d) / edge 9: the top row of the viewport for a scroll state, always inside `[0, max(0, rows − height)]`. */
export function resolveTop(index: ViewportIndex, scroll: Scroll, height: number): number {
  const h = size(height);
  const max = Math.max(0, index.rows.length - h);
  if (scroll.anchor === 'bottom') return max;
  return Math.min(max, Math.max(0, size(scroll.top)));
}

/** §1.3.3 (c) / edge 8: the visible rows. Never a negative slice; a zero-height viewport renders nothing. */
export function sliceRows(index: ViewportIndex, top: number, height: number): readonly ViewportRow[] {
  const h = size(height);
  if (h === 0) return [];
  const t = Math.min(Math.max(0, size(top)), Math.max(0, index.rows.length));
  return index.rows.slice(t, t + h);
}

/** §1.3.3: the scroll keys. Every one is free in the `composer` context; `Home` / `End` are deliberately NOT here. */
export type ScrollKey = 'pageUp' | 'pageDown' | 'lineUp' | 'lineDown' | 'top' | 'bottom';

/**
 * §1.3.3: the scroll reducer. `PgUp` / `PgDn` move one viewport minus two rows (the two-row overlap every pager
 * keeps so the reader does not lose their place); `Shift+↑` / `Shift+↓` one row; `Ctrl+Home` / `Ctrl+End` the ends.
 * Edge 9: past the top it clamps, past the bottom it **reattaches** (the anchor goes back to `bottom`, so a later
 * append follows again). Submitting, `Esc` on an empty draft and any `run:start` reattach through `SCROLL_BOTTOM`.
 */
export function applyScroll(scroll: Scroll, key: ScrollKey, index: ViewportIndex, height: number): Scroll {
  return applyScrollAt(scroll, key, index.rows.length, height);
}

/** The same reducer over a row COUNT, for the renderer, which knows the height and the total but holds no index in its key path. */
export function applyScrollAt(scroll: Scroll, key: ScrollKey, totalRows: number, height: number): Scroll {
  const h = size(height);
  const max = Math.max(0, size(totalRows) - h);
  if (key === 'bottom') return SCROLL_BOTTOM;
  if (key === 'top') return max === 0 ? SCROLL_BOTTOM : { anchor: 'row', top: 0 };
  const step = key === 'pageUp' || key === 'pageDown' ? Math.max(1, h - 2) : 1;
  const dir = key === 'pageUp' || key === 'lineUp' ? -1 : 1;
  const from = scroll.anchor === 'bottom' ? max : Math.min(max, Math.max(0, size(scroll.top)));
  const clamped = Math.max(0, Math.min(max, from + dir * step));
  // edge 9: past the bottom REATTACHES (a later append follows again); past the top clamps at row 0
  return clamped >= max ? SCROLL_BOTTOM : { anchor: 'row', top: clamped };
}

/** §1.3.3: true when the view is pinned to the newest row (an append must follow it; the position segment says `100 %`). */
export function atBottom(index: ViewportIndex, scroll: Scroll, height: number): boolean {
  return resolveTop(index, scroll, height) >= Math.max(0, index.rows.length - size(height));
}

/**
 * §1.3.2: the position segment's rung ladder, **widest first**, fed to `panelStrip` as its rightmost segment. At the
 * stated fullscreen minimum of 40 columns the 24-cell widest rung would eat the whole strip, and this is the only way
 * to know where you are in a viewport with no native scrollbar — so it degrades rung by rung and is then dropped,
 * **after** `◆ jevcode` and **before** any pane information.
 *
 * ```
 * [24]  1 240/3 512 · 35 % · PgUp
 * [13]  35 % · PgUp
 *  [4]  35 %
 *        (dropped — the strip's information wins)
 * ```
 *
 * The counters are grouped with the document's plain space (`groupPos`), byte-exact to the ladder block and to
 * frames F-H3 / F-H4 / F-H5.
 */
export function positionRungs(top: number, height: number, total: number): string[] {
  const h = size(height);
  const n = size(total);
  const t = Math.min(Math.max(0, size(top)), Math.max(0, n - h));
  const last = Math.min(n, t + h);
  const max = Math.max(0, n - h);
  const pct = max === 0 ? 100 : Math.round((t / max) * 100);
  return [`${groupPos(last)}/${groupPos(n)} · ${pct} % · PgUp`, `${pct} % · PgUp`, `${pct} %`];
}

/** The widest position rung that fits `width` cells, or null when even the narrowest does not (the segment is dropped). */
export function positionRung(top: number, height: number, total: number, width: number): string | null {
  const room = size(width);
  for (const r of positionRungs(top, height, total)) if (cellWidth(r) <= room) return r;
  return null;
}
