/**
 * The model picker's rows and reducer (TUI-DESIGN-5 §6.2, §6.4; D-AQ). Pure: no Ink, no clock, no I/O.
 *
 * ## Why every catalogue function arrives through a seam
 *
 * §6.2's first-frame rule forbids a **static, value-bearing** import of `src/models/**` (other than the zero-import
 * modules) from anything the first frame loads. The design names `src/models/static.ts` as one of the two zero-import
 * exceptions; **on this tree that is false** — `static.ts:38` imports `PROVIDER_IDS` from `./providers.js`, which
 * imports `../provider/openrouter.js` at `providers.ts:23`. `src/models/search.ts` reaches the same module through
 * `./list.js`, and `src/models/format.ts` imports `./providers.js` directly. So there is **no** value import of
 * `src/models/**` this module could make and stay inside the rule.
 *
 * Both modules therefore take `import type` only and receive the pure functions as a value (`ModelsSearch` here,
 * `ModelsText` in `./lines.js`). The `'models'` arm of `src/tui/Picker.tsx` binds them from the one
 * `await import('../models/index.js')` it already has to make for `loadCatalogue`, after `run:ready`; the unit tests
 * bind the real module directly, and `const api: ModelsApi = models` is the compile-time proof that the seam and
 * `src/models/index.ts` have not drifted.
 *
 * ## First paint
 *
 * `openModels(rows)` is synchronous and non-empty: the caller hands over the snapshot rows (`instantCatalogue()` /
 * `allStaticModels()`), which cost no I/O, and every `listModels` promise replaces its own provider's rows **in
 * place** as it settles (`settled`). A provider that comes back empty keeps the rows it already had — the picker
 * never blanks a column because a refresh failed (§7 rows 68, 70, 71, 72, 73).
 */
import type { ListResult, ModelInfo, ProviderId, RankOptions, SearchHit } from '../../models/types.js';

/** The ranking half of the seam — `rankModels` / `findModel` / `nearMisses` from `src/models/search.ts`. */
export interface ModelsSearch {
  rank(query: string, models: readonly ModelInfo[], opts?: RankOptions): SearchHit[];
  findModel(id: string, models: readonly ModelInfo[]): ModelInfo | null;
  nearMisses(id: string, models: readonly ModelInfo[], limit?: number): ModelInfo[];
}

/** The picker's state. `query` is the composer text; the composer owns it, this mirrors it for the clamp. */
export interface ModelsPickerState {
  /** the pool: the snapshot, with each provider's rows replaced as its list settles */
  readonly models: readonly ModelInfo[];
  /** one per provider that has answered — the provenance and error rows are built from these */
  readonly results: readonly ListResult[];
  /** providers whose `listModels` has not settled yet (empty = the load is done) */
  readonly pending: readonly ProviderId[];
  /** index into the ranked, limited row list */
  readonly selected: number;
  /** `open` has run (the picker is mounted); `close` clears it */
  readonly open: boolean;
}

export type ModelsAction =
  /**
   * first paint: the snapshot rows, plus the providers a load was started for (zero awaits).
   *
   * `results` is the **provenance the caller already holds** at open — for the mounted `/model` picker that is
   * `snapshotResults(instantCatalogue(), SNAPSHOT_AT)`, one `source: 'static'` row per provider, so the very first
   * frame reads `models · 512 of 7 providers` and `… bundled snapshot` instead of `of 0 providers` with a blank
   * provenance row (§12.5 S99's own rule, stated for `providersCovered`). It costs no I/O and no await; a real
   * `listModels` answer replaces its provider's row through `settled` exactly as before.
   */
  | { type: 'open'; models: readonly ModelInfo[]; pending?: readonly ProviderId[]; results?: readonly ListResult[] }
  /** one provider's `listModels` settled — its rows replace in place */
  | { type: 'settled'; result: ListResult }
  | { type: 'move'; by: number; count: number }
  | { type: 'page'; by: -1 | 1; size: number; count: number }
  /** the composer text changed: the row list shrank or grew under the cursor */
  | { type: 'clamp'; count: number }
  | { type: 'close' };

export const INITIAL_MODELS: ModelsPickerState = { models: [], results: [], pending: [], selected: 0, open: false };

/**
 * How many ranked rows the picker keeps at a time — a **viewport**, well past any pane height, that keeps
 * `rankModels`' output small. It is never the number the UI reports: `visibleModels` returns the pre-cap `total`
 * beside the capped `hits` for exactly that reason.
 */
export const MODELS_RANK_LIMIT = 200;

function clamp(selected: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(0, Math.floor(selected)), count - 1);
}

/**
 * Put `rows` where `provider`'s rows already are, dropping the ones they replace. An empty `rows` is a **no-op on
 * the pool**: `listModels` never returns empty on purpose, so an empty answer is a failure whose old rows must stay
 * on screen (§7 row 73 — "the old rows stay on screen").
 */
export function replaceProviderRows(models: readonly ModelInfo[], provider: ProviderId, rows: readonly ModelInfo[]): readonly ModelInfo[] {
  if (rows.length === 0) return models;
  const out: ModelInfo[] = [];
  let inserted = false;
  for (const m of models) {
    if (m.provider !== provider) {
      out.push(m);
      continue;
    }
    if (!inserted) {
      out.push(...rows);
      inserted = true;
    }
  }
  if (!inserted) out.push(...rows);
  return out;
}

/** The pure reducer. Every arm is synchronous; nothing here awaits, reads a clock or touches `src/models/**`. */
export function modelsReducer(s: ModelsPickerState, a: ModelsAction): ModelsPickerState {
  switch (a.type) {
    case 'open':
      return { models: a.models, results: a.results ?? [], pending: a.pending ?? [], selected: 0, open: true };
    case 'settled': {
      const provider = a.result.provider;
      // one row per provider: a second answer (a refresh) replaces the first, it never appends
      const results = [...s.results.filter((r) => r.provider !== provider), a.result];
      const pending = s.pending.filter((p) => p !== provider);
      return { ...s, models: replaceProviderRows(s.models, provider, a.result.models), results, pending };
    }
    case 'move':
      return { ...s, selected: clamp(s.selected + a.by, a.count) };
    case 'page':
      return { ...s, selected: clamp(s.selected + a.by * Math.max(1, a.size), a.count) };
    case 'clamp':
      return s.selected === clamp(s.selected, a.count) ? s : { ...s, selected: clamp(s.selected, a.count) };
    case 'close':
      return INITIAL_MODELS;
  }
}

/** What one keystroke's ranking produced: the viewport's rows, and how many the query matched before the cap. */
export interface VisibleModels {
  readonly hits: readonly SearchHit[];
  /**
   * Matches **before** `limit`. `MODELS_RANK_LIMIT` is a viewport, never a reported total: with a 512-row
   * catalogue and an empty query the old shape made the header read `models · 200` and the `--plain` head
   * `(1-40 of 200)`, and rows 201… were unreachable by scrolling with nothing on screen saying so (the same
   * viewport/row-count distinction §13.2 clause 6 draws for the agents tab).
   */
  readonly total: number;
}

/** The ranked rows for the live composer text. Pure and synchronous — one call per keystroke (gate G-R5-5). */
export function visibleModels(s: ModelsPickerState, search: ModelsSearch, query: string, limit: number = MODELS_RANK_LIMIT): VisibleModels {
  const all = search.rank(query, s.models);
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : all.length;
  return { hits: all.length > cap ? all.slice(0, cap) : all, total: all.length };
}

/**
 * §12.5 S99 / F-58: the provider count the rule row shows — every provider the load **covers**, whether or not it
 * has answered. `results.length` alone reads `models · 69 of 0 providers` on the first synchronous paint, which is
 * the one frame §6.2 exists to make correct.
 */
export function providersCovered(s: ModelsPickerState): number {
  return s.results.length + s.pending.length;
}

/**
 * §6.2 / §12.5 S99: the bundled snapshot expressed as one `ListResult` per provider — **pure, no I/O, no clock**.
 *
 * The picker's first paint is `instantCatalogue()` (a flat `ModelInfo[]`), but every provenance string
 * (`sourceLabel`, `errorLabel`, `catalogueSummary`) and the rule row's provider count are written against
 * `ListResult`. Without this the first frame would have to claim either seven `pending` providers (a lie — no load
 * was started) or zero providers (§12.5 S99's named failure, `models · 69 of 0 providers`). One `source: 'static'`
 * row per provider is the truth: the rows are the bundled snapshot, nothing was fetched, and `catalogueSettled`
 * stays false so `/model <id>` still warns rather than refusing (§7 row 100).
 *
 * Providers keep first-appearance order, which is `sortModels`' order, so the provenance row lists them in the
 * same order the rows do. `fetchedAt` is the snapshot date the caller read from the catalogue (`SNAPSHOT_AT`).
 */
export function snapshotResults(models: readonly ModelInfo[], fetchedAt: string): ListResult[] {
  const byProvider = new Map<ProviderId, ModelInfo[]>();
  for (const m of models) {
    const rows = byProvider.get(m.provider);
    if (rows === undefined) byProvider.set(m.provider, [m]);
    else rows.push(m);
  }
  return [...byProvider].map(([provider, rows]) => ({ provider, models: rows, source: 'static' as const, fetchedAt, stale: true }));
}

/** The row Enter picks, or null when the query matched nothing. */
export function selectedModel(s: ModelsPickerState, hits: readonly SearchHit[]): ModelInfo | null {
  return hits[clamp(s.selected, hits.length)]?.model ?? null;
}

/**
 * §6.4: has the catalogue **settled live**? Only then may `/model <id>` refuse an unknown id. `static` means the
 * bundled snapshot answered, which says nothing about whether the id exists; a provider still in flight says even
 * less. With no result at all the answer is "no", so the offline first run warns and sets the value (§7 row 100).
 */
export function catalogueSettled(results: readonly ListResult[], pending: readonly ProviderId[] = []): boolean {
  return pending.length === 0 && results.length > 0 && results.every((r) => r.source !== 'static');
}
