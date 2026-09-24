/**
 * The import overlay's state machine (TUI-DESIGN-5 §5.2, §7 rows 52–60; IMPORT-DESIGN §5.2 [G2.5]). **Pure**:
 * no I/O, no clock, no Ink, and — gate G-R5-1 — **no value import of `src/import/**`**, which reaches
 * `node:fs`. Everything the reducer knows about the plan arrives as data at `initImportUi`.
 *
 * The one invariant that must live in TUI code rather than be assumed (§5.2, §7 row 58):
 *
 * > "What `y` applies" lives in TWO places in the engine — `PlanGroup.applicable` (`src/import/index.ts:645`,
 * > `key !== 'review' && key !== 'skipped'`) and `applicableRows`' own per-row `class === 'secret'` exclusion
 * > (`:687–698`, which ALSO drops `action === 'suggest'`). A UI that reads only the group flag would apply a
 * > credential if one ever reached an applicable group — and would today over-count a `config`-group `suggest`
 * > row, which `summarisePlan` counts in `toImport` and `applicableRows` refuses.
 *
 * `selectedRowIds` therefore **intersects** the human's selection with the `applicable` id list the caller got
 * from `applicableRows(plan, { scope })` **and** independently drops every `class === 'secret'` row. Belt and
 * braces, both asserted: `test/unit/tui/import/reducer.test.ts` plants a `secret`-class row with a plain
 * `create` action in the `memory` group and in the `applicable` list, and asserts `y` still never yields it.
 */
import type { PlanGroup, PlanGroupKey, PlanSummary } from '../../import/index.js';
import type { ImportPlan, PlanRow } from '../../core/types.js';

/** IMPORT-DESIGN §5.2: the overlay's steps. `scanning` is the pre-plan frame; `done` holds the applied counts. */
export type ImportStep = 'scanning' | 'groups' | 'rows' | 'review' | 'applying' | 'done';

/**
 * §5.2 / F-56: the group rows of the default view, in render order. `skipped` is NEVER a row (its count is in the
 * head) and `config` is rendered only when it has rows — see `groupRowsOf`.
 */
export const GROUP_VIEW_ORDER: readonly PlanGroupKey[] = ['memory', 'rules', 'commands', 'mcp', 'config', 'review'];

/** One rendered group row: engine counts plus the two facts the view adds. */
export interface ImportGroupRow {
  readonly key: PlanGroupKey;
  readonly rows: number;
  readonly bytes: number;
  /** `PlanGroup.applicable` — the GROUP flag, kept for the row's `—` / `needs you` marker, never for `y` */
  readonly applicable: boolean;
  /** how many of this group's rows `y` would actually write (the per-row intersection) */
  readonly selectable: number;
}

export interface ImportUiState {
  readonly step: ImportStep;
  readonly importId: string;
  readonly summary: PlanSummary;
  readonly groups: readonly ImportGroupRow[];
  /** index into `groups` */
  readonly cursor: number;
  /** the group whose rows are open, or null (step `rows`) */
  readonly expanded: PlanGroupKey | null;
  /** index into the expanded group's rows */
  readonly rowCursor: number;
  /** row ids the human turned OFF; every applicable row is on by default (§5.2: the common path is one key) */
  readonly off: ReadonlySet<string>;
  /** index into the review queue (step `review`) */
  readonly reviewAt: number;
  readonly applied: { readonly ok: number; readonly failed: number; readonly total: number } | null;
  /**
   * §7 row 59, behaviour 2: Ctrl-C during `applying` stopped the apply at a ROW BOUNDARY. The step becomes
   * `done` and the overlay prints the resume hint — it does NOT close (behaviour 3's answer), because the rows
   * already written are exactly what `jevcode import --resume` needs the human to know about.
   */
  readonly interrupted: boolean;
  readonly hint: string | null;
  /** Esc / Ctrl-C: the overlay closes and the plan is KEPT (§7 row 59, behaviour 3) */
  readonly closed: boolean;
}

/** Everything the reducer is given once, at open. The caller (`cli/import.ts`, `App.tsx`) does the I/O. */
export interface ImportUiInput {
  readonly plan: ImportPlan;
  readonly summary: PlanSummary;
  /** `applicableRows(plan, { scope })` — engine policy, never re-derived here (§5.2) */
  readonly applicable: readonly string[];
}

export type ImportAction =
  | { type: 'move'; by: -1 | 1 }
  /** Enter: expand the group under the cursor, or collapse back from the row view */
  | { type: 'open' }
  | { type: 'back' }
  /** Space: toggle the row under the row cursor, or the whole group in the group view */
  | { type: 'toggle' }
  /** `a` / `n` inside an expanded group */
  | { type: 'all' }
  | { type: 'none' }
  /** `r` */
  | { type: 'review' }
  /** `y` */
  | { type: 'apply' }
  | { type: 'escape' }
  | { type: 'applied'; ok: number; failed: number; total: number }
  /** §7 row 59, behaviour 2: Ctrl-C while `applying` — stop at the row boundary and keep the resume hint */
  | { type: 'interrupt'; ok?: number; total?: number }
  | { type: 'hint'; text: string | null };

/** §5.2: the rows of one group, in plan order. Pure. */
export function rowsOfGroup(plan: ImportPlan, key: PlanGroupKey): readonly PlanRow[] {
  return plan.rows.filter((r) => groupKeyOf(r) === key);
}

/**
 * `src/import/index.ts:632–651`'s `groupOf`, restated for the TUI because the engine does not export it. Pinned
 * by `reducer.test.ts` against `summarisePlan`'s own per-group counts, so the two can never drift silently.
 */
export function groupKeyOf(row: Pick<PlanRow, 'class' | 'action'>): PlanGroupKey {
  if (row.action === 'review') return 'review';
  if (row.action.startsWith('skip:')) return 'skipped';
  if (row.action === 'suggest') return 'config';
  switch (row.class) {
    case 'memory':
      return 'memory';
    case 'rule':
      return 'rules';
    case 'command':
      return 'commands';
    case 'mcp':
      return 'mcp';
    default:
      return 'config';
  }
}

/**
 * §7 row 58: the per-row gate `y` obeys. A row is writable when the engine's own `applicableRows` listed it AND
 * its class is not `secret`. The second clause is redundant today — classification never emits a `secret`-class
 * row with a plain `create`/`append` action — and is kept because the invariant lives in two engine functions,
 * not one, and this is the surface that would apply the credential if it ever escaped.
 */
export function isWritableRow(row: Pick<PlanRow, 'id' | 'class'>, applicable: ReadonlySet<string>): boolean {
  return applicable.has(row.id) && row.class !== 'secret';
}

function groupRowsOf(plan: ImportPlan, summary: PlanSummary, applicable: ReadonlySet<string>): readonly ImportGroupRow[] {
  const byKey = new Map<PlanGroupKey, PlanGroup>(summary.groups.map((g) => [g.key, g]));
  const out: ImportGroupRow[] = [];
  for (const key of GROUP_VIEW_ORDER) {
    const g = byKey.get(key);
    if (g === undefined) continue;
    // §5.2: five named rows. `config` joins them ONLY when it has rows — `summarisePlan` counts it in `toImport`,
    // so hiding a non-empty `config` group would make the row counts sum to less than the head's `N to import`.
    if (key === 'config' && g.rows === 0) continue;
    const selectable = rowsOfGroup(plan, key).filter((r) => isWritableRow(r, applicable)).length;
    out.push({ key, rows: g.rows, bytes: g.bytes, applicable: g.applicable, selectable });
  }
  return out;
}

/** The plan's review queue — the rows `r` walks (§5.2). */
export function reviewRowsOf(plan: ImportPlan): readonly PlanRow[] {
  return plan.rows.filter((r) => r.action === 'review');
}

export function initImportUi(input: ImportUiInput): ImportUiState {
  const applicable = new Set(input.applicable);
  return {
    step: 'groups',
    importId: input.plan.importId,
    summary: input.summary,
    groups: groupRowsOf(input.plan, input.summary, applicable),
    cursor: 0,
    expanded: null,
    rowCursor: 0,
    off: new Set<string>(),
    reviewAt: 0,
    applied: null,
    interrupted: false,
    hint: null,
    closed: false,
  };
}

/** The pre-plan frame: `planImport` is still running and the overlay shows the scanning row. */
export function scanningImportUi(importId = ''): ImportUiState {
  return {
    step: 'scanning',
    importId,
    summary: { groups: [], toImport: 0, toReview: 0, skipped: 0, bytes: 0, credentialsFound: 0 },
    groups: [],
    cursor: 0,
    expanded: null,
    rowCursor: 0,
    off: new Set<string>(),
    reviewAt: 0,
    applied: null,
    interrupted: false,
    hint: null,
    closed: false,
  };
}

/**
 * §5.2 / §7 row 58: **exactly what `y` writes.** The engine's `applicableRows` output, minus the rows the human
 * turned off, minus every `class === 'secret'` row, in plan order. The group flag is never consulted.
 */
export function selectedRowIds(state: ImportUiState, input: ImportUiInput): readonly string[] {
  const applicable = new Set(input.applicable);
  return input.plan.rows.filter((r) => isWritableRow(r, applicable) && !state.off.has(r.id)).map((r) => r.id);
}

function clamp(n: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(max - 1, n));
}

/**
 * The reducer. `input` is the same object `initImportUi` was given — the plan never changes while the overlay is
 * open, so passing it per action keeps the state itself free of the plan (a state dump is counts and ids only).
 */
export function importReducer(state: ImportUiState, action: ImportAction, input: ImportUiInput): ImportUiState {
  const applicable = new Set(input.applicable);
  switch (action.type) {
    case 'move': {
      if (state.step === 'rows' && state.expanded !== null) {
        const rows = rowsOfGroup(input.plan, state.expanded);
        return { ...state, rowCursor: clamp(state.rowCursor + action.by, rows.length), hint: null };
      }
      if (state.step === 'review') {
        const q = reviewRowsOf(input.plan);
        return { ...state, reviewAt: clamp(state.reviewAt + action.by, q.length), hint: null };
      }
      if (state.step !== 'groups') return state;
      return { ...state, cursor: clamp(state.cursor + action.by, state.groups.length), hint: null };
    }
    case 'open': {
      if (state.step === 'rows') return { ...state, step: 'groups', expanded: null, rowCursor: 0, hint: null };
      if (state.step !== 'groups') return state;
      const g = state.groups[state.cursor];
      if (g === undefined) return state;
      // §5.2: `r` is the review queue's key; Enter on the review row goes there too rather than into a dead list
      if (g.key === 'review') return { ...state, step: 'review', reviewAt: 0, hint: null };
      return { ...state, step: 'rows', expanded: g.key, rowCursor: 0, hint: null };
    }
    case 'back': {
      if (state.step === 'rows') return { ...state, step: 'groups', expanded: null, rowCursor: 0, hint: null };
      if (state.step === 'review') return { ...state, step: 'groups', reviewAt: 0, hint: null };
      return state;
    }
    case 'toggle': {
      const off = new Set(state.off);
      const flip = (rows: readonly PlanRow[]): void => {
        const writable = rows.filter((r) => isWritableRow(r, applicable));
        const anyOn = writable.some((r) => !off.has(r.id));
        for (const r of writable) {
          if (anyOn) off.add(r.id);
          else off.delete(r.id);
        }
      };
      if (state.step === 'rows' && state.expanded !== null) {
        const row = rowsOfGroup(input.plan, state.expanded)[state.rowCursor];
        if (row === undefined) return state;
        // a row `y` can never write has nothing to toggle; say so rather than pretending the key worked
        if (!isWritableRow(row, applicable)) return { ...state, hint: IMPORT_HINT_NOT_APPLICABLE };
        if (off.has(row.id)) off.delete(row.id);
        else off.add(row.id);
        return { ...state, off, hint: null };
      }
      if (state.step !== 'groups') return state;
      const g = state.groups[state.cursor];
      if (g === undefined) return state;
      const rows = rowsOfGroup(input.plan, g.key);
      // a GROUP `y` can never write (`review`, a `config` group of `suggest` rows) answers with the same
      // sentence the row view gives, rather than swallowing the key (finding 18)
      if (rows.filter((r) => isWritableRow(r, applicable)).length === 0) return { ...state, hint: IMPORT_HINT_NOT_APPLICABLE };
      flip(rows);
      return { ...state, off, hint: null };
    }
    case 'all':
    case 'none': {
      if (state.step !== 'rows' || state.expanded === null) return state;
      const off = new Set(state.off);
      for (const r of rowsOfGroup(input.plan, state.expanded)) {
        if (!isWritableRow(r, applicable)) continue;
        if (action.type === 'all') off.delete(r.id);
        else off.add(r.id);
      }
      return { ...state, off, hint: null };
    }
    case 'review':
      return state.step === 'applying' || state.step === 'done' ? state : { ...state, step: 'review', reviewAt: 0, hint: null };
    case 'apply': {
      if (state.step === 'applying' || state.step === 'done' || state.step === 'scanning') return state;
      const ids = selectedRowIds(state, input);
      if (ids.length === 0) return { ...state, hint: IMPORT_HINT_NOTHING };
      return { ...state, step: 'applying', hint: null };
    }
    case 'escape': {
      // §7 row 59: THREE behaviours, and this is the only place two of them meet. During `applying` Esc / Ctrl-C
      // is behaviour 2 — stop at the row boundary and show the resume hint — never behaviour 3's silent close.
      if (state.step === 'applying') return importReducer(state, { type: 'interrupt' }, input);
      // behaviour 3: the overlay closes and the PLAN is kept — nothing is written, nothing is deleted
      if (state.step === 'rows' || state.step === 'review') return importReducer(state, { type: 'back' }, input);
      return { ...state, closed: true, hint: null };
    }
    case 'interrupt': {
      if (state.step !== 'applying') return state;
      const total = action.total ?? selectedRowIds(state, input).length;
      const ok = action.ok ?? state.applied?.ok ?? 0;
      return { ...state, step: 'done', interrupted: true, applied: { ok, failed: 0, total }, hint: null };
    }
    case 'applied':
      return { ...state, step: 'done', applied: { ok: action.ok, failed: action.failed, total: action.total }, interrupted: false, hint: null };
    case 'hint':
      return { ...state, hint: action.text };
  }
}

/**
 * IMPORT-DESIGN §5.2: `nothing selected — Space turns a group on, or Esc to close`.
 *
 * Every hint here is the UNICODE anchor; the `--ascii` twin is produced by `glyphTwin` inside `importBlockRows`
 * (`./lines.ts`), never by a second literal (§13.4). `lines.test.ts` sweeps both sets over every step.
 */
export const IMPORT_HINT_NOTHING = 'nothing selected — Space turns a group on, or Esc to close';
/** the row `y` can never write (a review, a skip, a `suggest` or a credential): the key is answered, not swallowed. */
export const IMPORT_HINT_NOT_APPLICABLE = 'that row is not imported by [y] — it needs review, or it is a credential';
