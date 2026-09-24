/**
 * The session / rewind picker (TUI-DESIGN §8.4, §12.5, F-L, §24 rule rows, A56): modal in the pane slot with the
 * composer as the filter (`> filter: par_`). Rows come from O6's `pickerRows()` / `pickerHeader()` (sessions) and
 * O8's `rewindPickerRows()` (rewind); this module adds the selection window (`▌` marker), the Space preview
 * (`state.json` counts and a 4 KB `transcript.log` tail, read only on Space), the Ctrl-R inline rename, the
 * `x` then `y` delete that moves `<run-id>/` to `~/.jevcode/trash/` (never `rm -rf`), Ctrl-A widening, and the
 * hint row. Keys are resolved by `resolveKey` in `<App>` (`picker` actions); the reducer here is pure.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRow } from '../core/types.js';
import { pickerHeader, pickerRows, pickerSessions, type PickerSort } from '../session/picker-lines.js';
import { REWIND_RULE, rewindCandidates, rewindPickerRows, type RewindStep } from '../undo/plan.js';
import { GLYPHS, type GlyphSet, glyphTwin, truncateCells } from './glyphs.js';
// TUI-DESIGN-5 §6.4 (D-AQ): the `'models'` arm. Both modules are pure and take `src/models/**` by `import type`
// only (see `./models/state.ts`'s docblock), so this static import cannot put the catalogue — and with it
// `src/provider/openrouter.js` — on the first-frame graph (§6.2, gate G-R5-1).
import { INITIAL_MODELS, modelsReducer, providersCovered, selectedModel, visibleModels, type ModelsAction, type ModelsPickerState, type ModelsSearch } from './models/state.js';
import { modelRow, modelsRule, noProviderAtAll, provenanceRow, MODELS_LOADING, NO_PROVIDER_CONFIGURED, noModelMatchText, type ModelsText } from './models/lines.js';
import type { ModelInfo, ProviderId, SearchHit } from '../models/types.js';

/** §24: `Enter: continue as a follow-up · Space: preview · Ctrl-R: rename · x: delete`. */
export const PICKER_HINT = 'Enter: continue as a follow-up · Space: preview · Ctrl-R: rename · x: delete';
/** §8.4: the `x` arm asks for `y` on the hint row. */
export const PICKER_DELETE_HINT = 'delete this session? y confirms (moves the run dirs to ~/.jevcode/trash) · any other key cancels';
export const PICKER_RENAME_LABEL = 'rename: ';
export const PICKER_PREVIEW_LABEL = 'preview: ';
/** §8.4: the transcript tail read on Space. */
export const PREVIEW_TAIL_BYTES = 4096;
/** §24: `no session in <path> yet`. */
export const PICKER_EMPTY = (workspace: string): string => `no session in ${workspace} yet`;
export const REWIND_EMPTY = 'no committed step changed files';

export type PickerKind = 'sessions' | 'rewind' | 'models';

/**
 * TUI-DESIGN-5 §6.4 / F-58: the models picker's own hint row. `s` is deliberately **absent** — Claude Code forks
 * Enter (save as default) from `s` (session only), JevCode's Enter is the third, narrower "pending for the next
 * run only", and §15 Q18 asks the owner whether a save-as-default key is wanted at all. Until it is answered `s`
 * is a filter character like every other letter.
 */
export const MODELS_HINT = 'Enter: pend for the next run · Tab: narrow to this id · Esc: close';

/**
 * TUI-DESIGN-5 §2.8 (CO §7.3 step 2): the expanded resume card's keys row, and the sentence that tells the human
 * the filter is inert while it is open. The four letters resolve **only** in this sub-state (§7 row 91), which is
 * exactly why the row names them here and nowhere else.
 */
export const PICKER_CARD_KEYS = '[Enter] resume   [r] replay   [f] fresh   [d] diff   [w] who   [Esc] back';
export const PICKER_CARD_HINT = 'Esc returns to the list';
/**
 * §2.8: the card's rows when the caller supplied none. The full card (`paused 42 m ago · now at step 7 …`, the
 * HEAD-drift row, the live-elsewhere row) is built from a `PausePoint` and a `Fold`, neither of which `SessionRow`
 * carries — `PickerOpen.cardLines` is the seam that brings them. Until it is supplied the card names the run it
 * belongs to and its keys, which is the honest minimum: never a blank pane, never an invented step number.
 */
export function defaultCardLines(session: SessionRow, runId: string, g: GlyphSet = GLYPHS.unicode): string[] {
  const title = session.title !== '' ? session.title : session.task60;
  return [`resume ${runId}${title === '' ? '' : ` ${g.dot} "${title}"`}`, PICKER_CARD_KEYS];
}

export interface PickerState {
  readonly kind: PickerKind;
  readonly sessions: readonly SessionRow[];
  readonly rewindSteps: readonly RewindStep[];
  readonly workspace: string;
  readonly selected: number;
  readonly widened: boolean;
  readonly sort: PickerSort;
  /** Space: the preview rows of the selected session (null = none shown) */
  readonly preview: readonly string[] | null;
  /** Ctrl-R: the inline rename field (the composer text is the new title) */
  readonly renaming: boolean;
  /** `x` pressed: the next `y` deletes */
  readonly deleteArmed: boolean;
  /**
   * TUI-DESIGN-5 §2.8 (R5-1's card, landed here with R5-4's shared-shell PR): the expanded resume card's focused
   * **sub-state** — `null` is the list, `{ runId }` is the card. It exists so the four card letters (`r` replay ·
   * `f` fresh · `d` diff · `w` who) can resolve **without** taking four more letters away from the filter, which
   * the picker's composer *is* (`src/session/picker-lines.ts:1–33`; §7 row 91). While it is set the filter is
   * inert and the card says `Esc returns to the list`; `KeyState.pickerCard` mirrors it for `resolveKey`.
   */
  readonly card: { readonly runId: string } | null;
  /**
   * TUI-DESIGN-5 §6.4 (D-AQ): the `'models'` arm's own state, folded into the picker's so the pane slot has one
   * reducer and one `PICKER_PANE_WANT`. It is `INITIAL_MODELS` for every other kind, and `modelsReducer` owns
   * every transition of it — this reducer only routes `move` / `page` / `clamp` and the `models` action.
   */
  readonly models: ModelsPickerState;
}

export type PickerAction =
  | { type: 'open'; kind: PickerKind; sessions?: readonly SessionRow[]; rewindSteps?: readonly RewindStep[]; workspace: string; sort?: PickerSort; models?: ModelsAction & { type: 'open' } }
  | { type: 'move'; by: number; count: number }
  | { type: 'page'; by: -1 | 1; size: number; count: number }
  | { type: 'widen' }
  | { type: 'preview'; lines: readonly string[] | null }
  | { type: 'rename'; on: boolean }
  | { type: 'deleteArm'; on: boolean }
  /** TUI-DESIGN-5 §2.8: Enter on a row opens its card; Esc (`{ runId: null }`) returns to the list. */
  | { type: 'card'; runId: string | null }
  /** TUI-DESIGN-5 §6.4: anything `modelsReducer` owns (`settled`, `close`), routed through the one picker reducer. */
  | { type: 'models'; action: ModelsAction }
  | { type: 'sessions'; sessions: readonly SessionRow[] }
  | { type: 'clamp'; count: number };

export const INITIAL_PICKER: PickerState = { kind: 'sessions', sessions: [], rewindSteps: [], workspace: '', selected: 0, widened: false, sort: 'updated', preview: null, renaming: false, deleteArmed: false, card: null, models: INITIAL_MODELS };

function clamp(selected: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(0, Math.floor(selected)), count - 1);
}

/** §8.4: the pure picker reducer. */
export function pickerReducer(s: PickerState, a: PickerAction): PickerState {
  switch (a.type) {
    case 'open':
      return { ...INITIAL_PICKER, kind: a.kind, sessions: a.sessions ?? [], rewindSteps: a.rewindSteps ?? [], workspace: a.workspace, sort: a.sort ?? 'updated', models: a.models === undefined ? INITIAL_MODELS : modelsReducer(INITIAL_MODELS, a.models) };
    case 'models':
      return { ...s, models: modelsReducer(s.models, a.action) };
    case 'move':
      // §6.4: the models arm keeps its selection in `ModelsPickerState` — one clamp, in `modelsReducer`
      if (s.kind === 'models') return { ...s, models: modelsReducer(s.models, { type: 'move', by: a.by, count: a.count }) };
      // §2.8: the card belongs to ONE row, so any movement of the selection closes it back to the list
      return { ...s, selected: clamp(s.selected + a.by, a.count), preview: null, deleteArmed: false, card: null };
    case 'page':
      if (s.kind === 'models') return { ...s, models: modelsReducer(s.models, { type: 'page', by: a.by, size: a.size, count: a.count }) };
      return { ...s, selected: clamp(s.selected + a.by * Math.max(1, a.size), a.count), preview: null, deleteArmed: false, card: null };
    case 'widen':
      return { ...s, widened: !s.widened, selected: 0, preview: null, deleteArmed: false, card: null };
    // §7 row 91, the BELT to `resolvePicker`'s braces: while the card owns the pane these three cannot start.
    // The resolver already refuses their keys, so nothing reaches here from a keystroke; a caller that dispatches
    // one directly (a test, a future `Renderer` verb) must not arm a delete behind a pane whose `pickerLines`
    // branch returns before `PICKER_DELETE_HINT` is ever built.
    case 'preview':
      return s.card !== null ? s : { ...s, preview: a.lines, deleteArmed: false };
    case 'rename':
      return s.card !== null ? s : { ...s, renaming: a.on, deleteArmed: false };
    case 'deleteArm':
      return s.card !== null ? s : { ...s, deleteArmed: a.on };
    case 'card':
      return { ...s, card: a.runId === null ? null : { runId: a.runId }, deleteArmed: false };
    case 'sessions':
      return { ...s, sessions: a.sessions, selected: clamp(s.selected, a.sessions.length) };
    case 'clamp': {
      if (s.kind === 'models') {
        const models = modelsReducer(s.models, { type: 'clamp', count: a.count });
        return models === s.models ? s : { ...s, models };
      }
      return s.selected === clamp(s.selected, a.count) ? s : { ...s, selected: clamp(s.selected, a.count) };
    }
  }
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §6.4 (D-AQ): the models arm's selectors — the composer text IS the query (`/resume`'s shape)
// ---------------------------------------------------------------------------------------

/** The ranked rows for the live composer text, and the pre-cap total the rule row reports (§12.5 S99). */
export function visibleModelHits(s: PickerState, search: ModelsSearch, filter: string): { hits: readonly SearchHit[]; total: number } {
  return visibleModels(s.models, search, filter);
}

/** The model Enter pends, or null when the query matched nothing. */
export function selectedModelRow(s: PickerState, search: ModelsSearch, filter: string): ModelInfo | null {
  return selectedModel(s.models, visibleModels(s.models, search, filter).hits);
}

/** §6.2: the providers the picker's load COVERS — answered plus still pending. Never `results.length` alone. */
export function modelProvidersCovered(s: PickerState): number {
  return providersCovered(s.models);
}

export type { ModelInfo, ProviderId };

/** The sessions the picker shows for the composer filter (O6's rule: workspace unless widened, filter, sort). */
export function visibleSessions(s: PickerState, filter: string): SessionRow[] {
  return pickerSessions(s.sessions, { workspace: s.workspace, widened: s.widened, ...(filter !== '' ? { filter } : {}), sort: s.sort });
}

export function selectedSession(s: PickerState, filter: string): SessionRow | null {
  const rows = visibleSessions(s, filter);
  return rows[clamp(s.selected, rows.length)] ?? null;
}

/**
 * §2.8: the session an OPEN card belongs to, resolved from the run id the card was opened for — **never** from
 * the live filter.
 *
 * The card is a focused sub-state over one run, and `selectedSession` answers the composer text, which the human
 * can still change from outside the picker (a `sessions` refresh, a rename commit, a caller that sets the draft).
 * Reading the selection here rendered the NEW row's title beside the OLD run id, and when the filter matched
 * nothing it produced `null` for a card that is demonstrably open. One card, one run, one lookup.
 */
export function sessionOfRun(s: PickerState, runId: string): SessionRow | null {
  return s.sessions.find((row) => row.runs.some((r) => r.runId === runId)) ?? null;
}

export function visibleRewindSteps(s: PickerState): RewindStep[] {
  return rewindCandidates(s.rewindSteps);
}

export function selectedRewindStep(s: PickerState): RewindStep | null {
  const rows = visibleRewindSteps(s);
  return rows[clamp(s.selected, rows.length)] ?? null;
}

export interface PickerLinesOptions {
  filter: string;
  rows: number;
  columns: number;
  nowMs: number;
  glyphs?: GlyphSet;
  live?: (runId: string) => boolean;
  /**
   * TUI-DESIGN-5 §6.4: the two halves of the catalogue seam, bound by the App from its one
   * `await import('../models/index.js')` (§6.2). Required for `kind === 'models'`; absent for every other kind,
   * and an absent seam renders the empty state rather than throwing — the App never opens the models arm before
   * the import resolves, so this is the belt to that braces.
   */
  models?: { text: ModelsText; search: ModelsSearch };
  /**
   * TUI-DESIGN-5 §2.8: the expanded resume card's rows, when `state.card !== null`. Absent falls back to
   * `defaultCardLines`. The card REPLACES the list in the pane slot — it is a focused sub-state, not a preview.
   */
  cardRows?: readonly string[];
}

/** §24: the picker's rule row (`─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────` or the rewind rule). */
export function pickerRule(s: PickerState, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  // TUI-DESIGN-5 §12.5 S99 / F-58: `─── models · 512 of 7 providers · by relevance ─ ↑↓ Enter Tab Esc ────`,
  // narrowing to `─── models · 512 ─ ↑↓ Enter Esc ────` (F-59). `modelsRule` pads to `columns` itself.
  if (s.kind === 'models') return modelsRule({ total: s.models.models.length, providers: providersCovered(s.models), columns, glyphs: g });
  if (s.kind === 'rewind') {
    const base = REWIND_RULE;
    const w = Math.max(0, Math.floor(columns));
    return truncateCells(base + g.rule.repeat(Math.max(0, w - base.length)), w, g);
  }
  return pickerHeader({ workspace: s.workspace, widened: s.widened, sort: s.sort, columns, ascii: g.mode === 'ascii' });
}

/**
 * §8.4 / F-L: the pane-slot rows — a window of session rows around the selection with the `▌` marker, then the
 * preview rows (`  preview: …`), then the hint row (or the delete confirmation / the rename field), padded to `rows`.
 */
export function pickerLines(s: PickerState, o: PickerLinesOptions): { lines: string[]; selected: number | null } {
  const g = o.glyphs ?? GLYPHS.unicode;
  const rows = Math.max(0, Math.floor(o.rows));
  if (rows === 0) return { lines: [], selected: null };
  const marker = g.mode === 'ascii' ? '> ' : '▌ ';
  const blank = '  ';
  const cols = Math.max(1, Math.floor(o.columns));
  // §2.8: the card is a focused sub-state — while it is open the pane is the card, the filter is inert, and the
  // four letters route to it. Only the sessions arm has one; `pickerReducer` clears `card` on every move.
  if (s.kind === 'sessions' && s.card !== null) {
    // §2.8: by RUN ID (`sessionOfRun`), so a filter the human changed under the card cannot rename it
    const sess = sessionOfRun(s, s.card.runId);
    const cardBody = o.cardRows ?? (sess === null ? [`resume ${s.card.runId}`, PICKER_CARD_KEYS] : defaultCardLines(sess, s.card.runId, g));
    const out = [...cardBody, PICKER_CARD_HINT].map((r) => truncateCells(`  ${glyphTwin(r, g)}`, cols, g)).slice(0, rows);
    while (out.length < rows) out.push('');
    return { lines: out, selected: null };
  }
  let body: string[];
  let count: number;
  if (s.kind === 'models') {
    // §6.4 / §6.8: one composed row per hit (the rung ladder drops parts, never cuts), the provenance row and the
    // hint row as the tail. The composer text IS the query — `/resume`'s shape, not a palette argument (D-AQ).
    const api = o.models;
    const hits = api === undefined ? [] : visibleModels(s.models, api.search, o.filter).hits;
    const tail: string[] = [];
    if (api !== undefined) {
      // §7 rows 71 + 74: S105 is printed ABOVE the rows a snapshot still has, never instead of them
      if (noProviderAtAll(s.models.results, s.models.models)) tail.push(`  ${glyphTwin(NO_PROVIDER_CONFIGURED, g)}`);
      // `provenanceRow` substitutes its own glyphs; `modelRow` does too. The HINT is this module's own string,
      // so §7 row 81's substitution has to happen here — under `--ascii` no `·` may reach a frame.
      const prov = provenanceRow(s.models.results, o.nowMs, cols - 2, api.text, g);
      if (prov !== '') tail.push(`  ${prov}`);
    }
    tail.push(`  ${glyphTwin(MODELS_HINT, g)}`);
    body = api === undefined ? [] : hits.map((h) => modelRow(h.model, cols - 2, api.text, g));
    count = body.length;
    // §6.2: "no hits" and "no catalogue yet" are DIFFERENT facts, and the rule row already reports the total —
    // saying `no model matches` beside `models · 512 of 7 providers` is the self-contradicting frame 1
    if (count === 0) body = [glyphTwin(api === undefined ? MODELS_LOADING : noModelMatchText(o.filter), g)];
    const sel = clamp(s.models.selected, count);
    const listRows = Math.max(1, rows - tail.length);
    const start = Math.max(0, Math.min(sel - Math.floor(listRows / 2), body.length - listRows));
    const shown = body.slice(start, start + listRows);
    const lines = shown.map((r, i) => truncateCells(`${count > 0 && start + i === sel ? marker : blank}${r}`, cols, g));
    const selectedRow = count > 0 && sel >= start && sel < start + listRows ? sel - start : null;
    const out = [...lines, ...tail.map((t) => truncateCells(t, cols, g))].slice(0, rows);
    while (out.length < rows) out.push('');
    return { lines: out, selected: selectedRow };
  }
  if (s.kind === 'rewind') {
    body = rewindPickerRows(s.rewindSteps, cols - 2);
    count = body.length;
    if (count === 0) body = [REWIND_EMPTY];
  } else {
    const list = visibleSessions(s, o.filter);
    body = pickerRows(list, { workspace: s.workspace, widened: s.widened, nowMs: o.nowMs, columns: cols - 2, sort: s.sort, ascii: g.mode === 'ascii', ...(o.filter !== '' ? { filter: o.filter } : {}), ...(o.live ? { live: o.live } : {}) });
    count = body.length;
    if (count === 0) body = [glyphTwin(PICKER_EMPTY(s.widened ? 'any workspace' : s.workspace), g)];
  }
  const sel = clamp(s.selected, count);
  const tail: string[] = [];
  if (s.preview !== null) for (const l of s.preview) tail.push(`  ${l}`);
  // §7 row 81: every tail string is a unicode ANCHOR with an `--ascii` twin — `PICKER_HINT` and
  // `PICKER_DELETE_HINT` both carry `·`, and pushing them raw put a unicode cell in an `--ascii` frame
  // (the models tail below has always been substituted; these three were the pre-existing leak).
  tail.push(glyphTwin(s.deleteArmed ? `  ${PICKER_DELETE_HINT}` : s.renaming ? `  ${PICKER_RENAME_LABEL}(type the new title, Enter saves, Esc cancels)` : `  ${PICKER_HINT}`, g));
  const listRows = Math.max(1, rows - tail.length);
  const start = Math.max(0, Math.min(sel - Math.floor(listRows / 2), body.length - listRows));
  const shown = body.slice(start, start + listRows);
  const lines = shown.map((r, i) => truncateCells(`${count > 0 && start + i === sel ? marker : blank}${r}`, cols, g));
  const selectedRow = count > 0 && sel >= start && sel < start + listRows ? sel - start : null;
  const out = [...lines, ...tail.map((t) => truncateCells(t, cols, g))].slice(0, rows);
  while (out.length < rows) out.push('');
  return { lines: out, selected: selectedRow };
}

/** The picker wants the whole pane slot (§2.2 row "picker open (pane slot, 12 rows incl. header)"). */
export const PICKER_PANE_WANT = 12;

// ---------------------------------------------------------------------------------------
// Space preview and x-then-y delete (§8.4)
// ---------------------------------------------------------------------------------------

export interface PickerFs {
  readFileSync(path: string, enc: 'utf8'): string;
  existsSync(path: string): boolean;
  statSync(path: string): { size: number; isDirectory(): boolean };
  /** the last `bytes` of a file */
  readTail(path: string, bytes: number): string;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, o: { recursive: true; mode?: number }): void;
}

export const NODE_PICKER_FS: PickerFs = {
  readFileSync: (p, e) => readFileSync(p, e),
  existsSync: (p) => existsSync(p),
  statSync: (p) => statSync(p),
  readTail: (p, bytes) => {
    const size = statSync(p).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  },
  renameSync: (a, b) => renameSync(a, b),
  mkdirSync: (p, o) => {
    mkdirSync(p, o);
  },
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * §8.4 Space: `preview: plan done 2/5 · remaining 3 · spend $0.310 · stop max_steps @ step 7` from `state.json`
 * (parsed only now) plus the last two lines of a 4 KB `transcript.log` tail; never `steps.jsonl`. Errors → one row.
 */
export function readPickerPreview(runsDir: string, runId: string, fs: PickerFs = NODE_PICKER_FS): string[] {
  const dir = join(runsDir, runId);
  const out: string[] = [];
  try {
    const raw = fs.readFileSync(join(dir, 'state.json'), 'utf8');
    const env = asRecord(JSON.parse(raw));
    const state = asRecord(env?.['state']) ?? env;
    const plan = asRecord(state?.['plan']);
    const done = Array.isArray(plan?.['done']) ? plan['done'].length : 0;
    const remaining = Array.isArray(plan?.['remaining']) ? plan['remaining'].length : 0;
    const spend = asRecord(state?.['spend']);
    const total = typeof spend?.['totalUsd'] === 'number' ? (spend['totalUsd'] as number) : null;
    const stop = typeof state?.['stopReason'] === 'string' ? (state['stopReason'] as string) : 'in progress';
    const step = typeof state?.['step'] === 'number' ? (state['step'] as number) : null;
    const interrupted = asRecord(state?.['interrupted']) !== null ? ' · interrupted' : '';
    out.push(`${PICKER_PREVIEW_LABEL}plan done ${done}/${done + remaining} · remaining ${remaining}${total !== null ? ` · spend $${total.toFixed(3)}` : ''} · stop ${stop}${step !== null ? ` @ step ${step}` : ''}${interrupted}`);
  } catch (e) {
    out.push(`${PICKER_PREVIEW_LABEL}state.json unreadable (${(e as NodeJS.ErrnoException).code ?? 'parse error'})`);
  }
  try {
    const t = join(dir, 'transcript.log');
    if (fs.existsSync(t)) {
      const tail = fs.readTail(t, PREVIEW_TAIL_BYTES).split('\n').filter((l) => l.trim() !== '');
      for (const l of tail.slice(-2)) out.push(l);
    }
  } catch {
    /* no transcript: the state row alone */
  }
  return out;
}

export interface TrashResult {
  ok: boolean;
  moved: string[];
  failed: { runId: string; code: string }[];
}

/** §8.4 `x` then `y`: move every run dir of the session to `~/.jevcode/trash/<run-id>/` — never `rm -rf`, never for `source !== 'cli'`. */
export function moveRunsToTrash(runsDir: string, trashDir: string, runIds: readonly string[], fs: PickerFs = NODE_PICKER_FS): TrashResult {
  const res: TrashResult = { ok: true, moved: [], failed: [] };
  try {
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ok: false, moved: [], failed: runIds.map((id) => ({ runId: id, code: (e as NodeJS.ErrnoException).code ?? 'EMKDIR' })) };
  }
  for (const id of runIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      res.failed.push({ runId: id, code: 'EINVAL' });
      continue;
    }
    const from = join(runsDir, id);
    try {
      if (!fs.existsSync(from)) {
        res.failed.push({ runId: id, code: 'ENOENT' });
        continue;
      }
      fs.renameSync(from, join(trashDir, id));
      res.moved.push(id);
    } catch (e) {
      res.failed.push({ runId: id, code: (e as NodeJS.ErrnoException).code ?? 'ERENAME' });
    }
  }
  res.ok = res.failed.length === 0;
  return res;
}
