/**
 * The one height allocator of the interactive TUI (TUI-DESIGN §2.1, D1, F3). Pure: no I/O, no clock,
 * no Ink. Vertical order top to bottom is `<Static>` scrollback · rule · live · banner · pane · queue ·
 * overlay · preview · composer · status; allocation order is the priority (status → rule → composer
 * floor → overlay → composer growth → queue → preview → live → banner → pane) and F3's yield order is
 * its reverse (pane → banner → live → preview → queue → composer growth → overlay → composer-to-1).
 * `App.tsx` still carries the previous `computeLayout`; O9 switches it to this module (§15.2).
 */

/** TUI-DESIGN §2.1: below this many rows the region degrades to status · notice · composer (A100). */
export const MIN_ROWS = 8;
/** TUI-DESIGN §2.1: below this many columns the region degrades to status · notice · composer (A100). */
export const MIN_COLUMNS = 40;

/** TUI-DESIGN §2.1: the A109 cap set — the most rows each slot may ever take. */
export const CAP = {
  live: 2,
  queue: 2,
  pane: 12,
  reviewHeader: 8,
  preview: 8,
  wizard: 4,
  followup: 5,
  secret: 1,
  blocking: 4,
  palette: 8,
  undo: 1,
  exitConfirm: 1,
  minsize: 1,
  composer: 6,
  composerTall: 8,
  banner: 1,
} as const;

/** TUI-DESIGN §2.1: the one modal slot directly above the composer holds at most one of these. */
export type OverlayKind = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm';

/** TUI-DESIGN §2.1: every overlay kind, in declaration order (tests iterate it). */
export const OVERLAY_KINDS: readonly OverlayKind[] = ['none', 'review', 'wizard', 'followup', 'secret', 'blocking', 'palette', 'undo', 'exitConfirm'];

/** overlays that collapse the composer to one inactive row (F3) */
const COLLAPSING: ReadonlySet<OverlayKind> = new Set<OverlayKind>(['review', 'followup', 'blocking', 'exitConfirm']);

/** TUI-DESIGN §2.1: true for the overlays that collapse the composer to one inactive row (F3, §6.2). */
export function isCollapsingOverlay(overlay: OverlayKind): boolean {
  return COLLAPSING.has(overlay);
}

/** TUI-DESIGN §2.1: the wants a frame has; `rows`/`columns` come from `useWindowSize()` only (A93). */
export interface LayoutInput {
  rows: number;
  columns: number;
  overlay: OverlayKind;
  /** review 8 · wizard 2–4 · followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 · exitConfirm 1 */
  overlayWant: number;
  /** review only: confirmPreviewLines(req).length */
  previewWant: number;
  /** review `e`: preview may take the pane's rows */
  expanded: boolean;
  /** visual rows of the draft, ≥ 1 */
  composerWant: number;
  /** queued steers 0..8 */
  queueWant: number;
  /** 0..2 */
  liveWant: number;
  /** loop signature at x2/3 or a replan directive active (A45) */
  bannerWant: 0 | 1;
  /** 0 until run:ready or a picker; rows the active tab can fill, ≤ 12 */
  paneWant: number;
}

/** TUI-DESIGN §2.1: rows granted to every slot; `total ≤ budget = rows − 2` always. */
export interface Layout {
  budget: number;
  degraded: 'none' | 'minsize' | 'static-only';
  status: number;
  rule: number;
  live: number;
  banner: number;
  pane: number;
  queue: number;
  overlay: number;
  preview: number;
  composer: number;
  total: number;
}

/** TUI-DESIGN §2.1: F3's yield order — the first field here reaches 0 first under pressure. */
export const YIELD_ORDER: readonly (keyof Layout)[] = ['pane', 'banner', 'live', 'preview', 'queue', 'composer', 'overlay'];

/** a non-finite size is treated as absent (0 rows); the design's arithmetic then degrades to static-only */
function size(n: number): number {
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * TUI-DESIGN §2.1 `computeLayout` — the design's function verbatim (A10, A107, A109, C47, D1), with
 * non-finite inputs normalised first so NaN/Infinity can never leak into a row count. Invariants
 * (unit-tested exhaustively): `total ≤ budget`; `status === 1` at rows ≥ 3; `composer ≥ 1` at rows ≥ 5
 * unless the wizard owns the input; a non-wizard overlay is whole at rows ≥ max(8, want + 5), the wizard
 * at rows ≥ max(8, want + 4); fields reach 0 in `YIELD_ORDER`; the review header keeps ≥ 3 rows at rows ≥ 8;
 * ≤ 5 µs per call.
 */
export function computeLayout(i: LayoutInput): Layout {
  const rows = size(i.rows);
  const columns = size(i.columns);
  const budget = Math.max(0, rows - 2);
  let rem = budget;
  const take = (want: number): number => {
    const w = Number.isFinite(want) ? Math.floor(want) : want === Infinity ? rem : 0;
    const got = Math.max(0, Math.min(w, rem));
    rem -= got;
    return got;
  };
  const z: Layout = { budget, degraded: 'none', status: 0, rule: 0, live: 0, banner: 0, pane: 0, queue: 0, overlay: 0, preview: 0, composer: 0, total: 0 };
  if (rows < 3) {
    // budget 0 or 1: <Static> keeps flowing, nothing dynamic
    z.degraded = 'static-only';
    return z;
  }
  if (rows < MIN_ROWS || columns < MIN_COLUMNS) {
    // A100: status · notice · composer
    z.degraded = 'minsize';
    z.status = take(1);
    z.overlay = take(CAP.minsize);
    z.composer = take(1);
    z.total = budget - rem;
    return z;
  }
  z.status = take(1); // 1 never yields
  z.rule = take(1); // 2 never yields at rows ≥ 8
  if (i.overlay !== 'wizard') z.composer = take(1); // 3 composer floor ("composer-to-1" is the last yield); the wizard IS the input (refund)
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant); // 4 modal slot (review header: keys line is row 2)
  const cap = COLLAPSING.has(i.overlay) ? 1 : rows >= 40 ? CAP.composerTall : CAP.composer;
  if (i.overlay !== 'wizard') z.composer += take(Math.min(i.composerWant, cap) - 1); // 5 composer growth
  z.queue = take(Math.min(i.queueWant, CAP.queue)); // 6 queue ≤ 2
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0; // 7
  z.live = i.overlay === 'review' ? 0 : take(Math.min(i.liveWant, CAP.live)); // 8 live rows are reclaimed by a pending review (A42)
  z.banner = take(Math.min(i.bannerWant, CAP.banner)); // 9 the loop banner is one row (A45)
  z.pane = i.expanded ? 0 : take(Math.min(i.paneWant, CAP.pane)); // 10 pane yields first
  z.total = budget - rem;
  return z;
}

/**
 * TUI-DESIGN §4.3: the row the composer starts on inside the dynamic region — `rule + live + banner +
 * pane + queue + overlay + preview` from the same `Layout`, so cursor and frame cannot disagree.
 */
export function composerTop(l: Layout): number {
  return l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview;
}
