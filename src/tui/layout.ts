/**
 * The one height allocator of the interactive TUI (TUI-DESIGN §2.1, D1, F3; TUI-DESIGN-2 §4.1–4.2 `computeLayout`
 * 1.1; TUI-DESIGN-3 §3.7 `computeLayout` 1.2 — the whole-or-absent pane grant for the wordmark). Pure: no I/O, no clock, no Ink. Vertical order top to bottom is `<Static>` scrollback · rule · live ·
 * banner · pane · queue · overlay · preview · [console: top edge · gate · composer · divider · status · bottom edge]
 * (flat tier: composer · status). Allocation order is the priority (status → rule → composer floor → chrome →
 * overlay → composer growth → queue → preview → live → banner → pane) and F3's yield order is its reverse (pane →
 * banner → live → preview → queue → composer growth → overlay → composer-to-1); chrome, rule and status never yield.
 */

/** TUI-DESIGN §2.1: below this many rows the region degrades to status · notice · composer (A100). */
export const MIN_ROWS = 8;
/** TUI-DESIGN §2.1: below this many columns the region degrades to status · notice · composer (A100). */
export const MIN_COLUMNS = 40;
/** TUI-DESIGN-2 §4.1: the boxed tier (console + cards) needs this many rows; below it the flat tier draws today's rows. */
export const BOXED_MIN_ROWS = 16;
/** TUI-DESIGN-2 §4.1 / §5.1: the 5-row wordmark needs this many columns; below it the brand row carries the splash. */
export const WORDMARK_MIN_COLUMNS = 64;

/** TUI-DESIGN §2.1 / TUI-DESIGN-2 §4.2: the A109 cap set — the most rows each slot may ever take. */
export const CAP = {
  live: 2,
  queue: 2,
  pane: 12,
  /** TUI-DESIGN-2 §4.6: the open (not full) Jev panel */
  panel: 6,
  reviewHeader: 8,
  /** TUI-DESIGN-2 §4.7: the boxed review card (title edge, keys, ruler, four gauges, matches_intent, bottom edge) */
  reviewCard: 9,
  preview: 8,
  wizard: 4,
  followup: 5,
  secret: 1,
  blocking: 4,
  palette: 8,
  undo: 1,
  exitConfirm: 1,
  /** TUI-DESIGN-2 §3.7: the flat intake row; boxed = 1 + card */
  intake: 1,
  minsize: 1,
  /** TUI-DESIGN-2 §4.7: the two edges a card adds */
  card: 2,
  composer: 6,
  composerTall: 8,
  banner: 1,
  /** TUI-DESIGN-2 §4.3: the console's top edge, divider and bottom edge */
  chrome: 3,
  /** TUI-DESIGN-2 §5.1 / TUI-DESIGN-3 §3: the wordmark rows in the pane slot (the splash, then the idle tenant) */
  splash: 5,
} as const;

/** TUI-DESIGN §2.1 / TUI-DESIGN-2 §3.7: the one modal slot directly above the composer holds at most one of these. */
export type OverlayKind = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm' | 'intake';

/** TUI-DESIGN §2.1: every overlay kind, in declaration order (tests iterate it). */
export const OVERLAY_KINDS: readonly OverlayKind[] = ['none', 'review', 'wizard', 'followup', 'secret', 'blocking', 'palette', 'undo', 'exitConfirm', 'intake'];

/** overlays that collapse the composer to one inactive row (F3; TUI-DESIGN-2 §3.7 adds `intake`) */
const COLLAPSING: ReadonlySet<OverlayKind> = new Set<OverlayKind>(['review', 'followup', 'blocking', 'exitConfirm', 'intake']);

/** TUI-DESIGN §2.1: true for the overlays that collapse the composer to one inactive row (F3, §6.2). */
export function isCollapsingOverlay(overlay: OverlayKind): boolean {
  return COLLAPSING.has(overlay);
}

/**
 * TUI-DESIGN-2 §4.1: the chrome tier is a function of geometry alone — never of the remaining budget — so a box is
 * never half-drawn: `boxed` (3 rows of chrome) at rows ≥ 16 and columns ≥ 40 without a screen reader, else `flat` (0).
 */
export function chromeRows(rows: number, columns: number, screenReader: boolean): 0 | 3 {
  const r = Number.isFinite(rows) ? Math.floor(rows) : 0;
  const c = Number.isFinite(columns) ? Math.floor(columns) : 0;
  return r >= BOXED_MIN_ROWS && c >= MIN_COLUMNS && !screenReader ? CAP.chrome : 0;
}

/** TUI-DESIGN §2.1: the wants a frame has; `rows`/`columns` come from `useWindowSize()` only (A93). */
export interface LayoutInput {
  rows: number;
  columns: number;
  overlay: OverlayKind;
  /** review 8 (boxed 9) · wizard 2–4 · followup 5 · secret 1 (boxed 0) · blocking 2–4 (boxed ≤ 6) · palette 2–8 · undo 1 (boxed 3) · exitConfirm 1 (boxed 3) · intake 1 (boxed 3) */
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
  /** 0 (collapsed) · 6 (open) · 12 (full / picker) · 5 (splash); rows the active tab can fill */
  paneWant: number;
  /** TUI-DESIGN-2 §4.2: `chromeRows(rows, columns, screenReader)` — 3 in the boxed tier, 0 flat */
  chrome: 0 | 3;
  /** TUI-DESIGN-2 §4.2: the secret-gate row the console hosts (boxed tier only; the flat tier keeps the `secret` overlay) */
  gate: 0 | 1;
  /** TUI-DESIGN-3 §3.7: grant the pane its whole want or nothing (the wordmark is never cut to its top rows); panel / picker keep partial grants */
  paneWhole?: boolean;
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
  /** the composer rows incl. the hosted gate row (`gate`) */
  composer: number;
  /** TUI-DESIGN-2 §4.2: the console's three edge rows (whole or absent) */
  chrome: number;
  /** TUI-DESIGN-2 §4.2: the hosted secret-gate row (inside `composer`) */
  gate: 0 | 1;
  total: number;
}

/** TUI-DESIGN §2.1: F3's yield order — the first field here reaches 0 first under pressure. */
export const YIELD_ORDER: readonly (keyof Layout)[] = ['pane', 'banner', 'live', 'preview', 'queue', 'composer', 'overlay'];

/** a non-finite size is treated as absent (0 rows); the design's arithmetic then degrades to static-only */
function size(n: number): number {
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * TUI-DESIGN §2.1 `computeLayout` — the design's function verbatim (A10, A107, A109, C47, D1) plus TUI-DESIGN-2
 * §4.2's step 3b (the console's chrome, whole or absent, after the composer floor and before the overlay; the
 * composer floor is `1 + gate` in the boxed tier), with non-finite inputs normalised first so NaN/Infinity can never
 * leak into a row count. Invariants (unit-tested exhaustively): `total ≤ budget`; `status === 1` at rows ≥ 3;
 * `composer ≥ 1` at rows ≥ 5 unless the wizard owns the input; `chrome ∈ {0, 3}` and `chrome === 3 ⇒ rows ≥ 16`;
 * a flat non-wizard overlay is whole at rows ≥ max(8, want + 5) (boxed: want + 8 + gate), the wizard at rows ≥
 * max(8, want + 4) (boxed: want + 7); fields reach 0 in `YIELD_ORDER`; the review header keeps ≥ 3 rows at rows ≥ 8;
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
  const z: Layout = { budget, degraded: 'none', status: 0, rule: 0, live: 0, banner: 0, pane: 0, queue: 0, overlay: 0, preview: 0, composer: 0, chrome: 0, gate: 0, total: 0 };
  if (rows < 3) {
    // budget 0 or 1: <Static> keeps flowing, nothing dynamic
    z.degraded = 'static-only';
    return z;
  }
  if (rows < MIN_ROWS || columns < MIN_COLUMNS) {
    /**
     * TUI-DESIGN-4 §2.5 P-R5 — the order becomes **notice → composer → status**, amending TD §2.1 A100's
     * `status · notice · composer`. At budget 1 (rows 3–4) A100's order spent the only row on a spinner-less
     * status row and left the user with no explanation of why every pane is gone; the notice IS the explanation.
     *
     * TUI-DESIGN-4 §2.5 P-R6 (D4) — under `overlay: 'wizard'` the slot is **notice(1) · wizard(1)** and there is
     * **no composer**: at minsize the wizard is read-only (§2.5's "one answer, stated once"), so a composer whose
     * Enter cannot start anything must not be drawn under it. PROBED at 40×5 on a first run: the user was invited
     * to type a task during onboarding. Keys are consumed and answer `WIZARD_MINSIZE_TOAST`.
     */
    z.degraded = 'minsize';
    const wizard = i.overlay === 'wizard';
    z.overlay = take(wizard ? CAP.minsize + 1 : CAP.minsize);
    if (!wizard) z.composer = take(1);
    z.status = take(1);
    z.total = budget - rem;
    return z;
  }
  const boxed = i.chrome === CAP.chrome && rows >= BOXED_MIN_ROWS;
  const gate: 0 | 1 = boxed && i.gate === 1 ? 1 : 0;
  z.status = take(1); // 1 never yields
  z.rule = take(1); // 2 never yields at rows ≥ 8
  if (i.overlay !== 'wizard') {
    // 3 composer floor ("composer-to-1" is the last yield); the wizard IS the input (refund); the hosted gate row never yields (§4.2)
    z.composer = take(1 + gate);
    z.gate = z.composer > 1 ? gate : 0;
  }
  z.chrome = boxed && rem >= CAP.chrome ? take(CAP.chrome) : 0; // 3b the console's edges: whole or absent, never yields (§4.2)
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant); // 4 modal slot (review header: keys line is row 2; boxed: the card)
  const cap = COLLAPSING.has(i.overlay) ? 1 : rows >= 40 ? CAP.composerTall : CAP.composer;
  if (i.overlay !== 'wizard') z.composer += take(Math.min(i.composerWant, cap) - 1); // 5 composer growth
  z.queue = take(Math.min(i.queueWant, CAP.queue)); // 6 queue ≤ 2
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0; // 7
  z.live = i.overlay === 'review' ? 0 : take(Math.min(i.liveWant, CAP.live)); // 8 live rows are reclaimed by a pending review (A42)
  z.banner = take(Math.min(i.bannerWant, CAP.banner)); // 9 the loop banner is one row (A45)
  // 10 pane yields first; TUI-DESIGN-3 §3.7 (`computeLayout` 1.2): under `paneWhole` the want is granted whole or not at all
  const want = Math.min(i.paneWant, CAP.pane);
  z.pane = i.expanded ? 0 : i.paneWhole === true ? (Number.isFinite(want) && rem >= Math.floor(want) ? take(want) : 0) : take(want);
  z.total = budget - rem;
  return z;
}

/**
 * TUI-DESIGN-2 §4.2: the console's top-edge row inside the dynamic region (boxed) — `rule + live + banner + pane +
 * queue + overlay + preview`; identical to the flat tier's composer row.
 */
export function consoleTop(l: Layout): number {
  return l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview;
}

/**
 * TUI-DESIGN §4.3 / TUI-DESIGN-2 §4.2: the row the `›` composer starts on inside the dynamic region — one below the
 * console's top edge, below the hosted gate row when it is up; the flat tier's value is `consoleTop` itself. The only
 * cursor formula: `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }` in the boxed tier.
 */
export function composerTop(l: Layout): number {
  return consoleTop(l) + (l.chrome > 0 ? 1 + l.gate : 0);
}
