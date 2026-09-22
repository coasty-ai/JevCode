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
import { GLYPHS, type GlyphSet, truncateCells } from './glyphs.js';

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

export type PickerKind = 'sessions' | 'rewind';

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
}

export type PickerAction =
  | { type: 'open'; kind: PickerKind; sessions?: readonly SessionRow[]; rewindSteps?: readonly RewindStep[]; workspace: string; sort?: PickerSort }
  | { type: 'move'; by: number; count: number }
  | { type: 'page'; by: -1 | 1; size: number; count: number }
  | { type: 'widen' }
  | { type: 'preview'; lines: readonly string[] | null }
  | { type: 'rename'; on: boolean }
  | { type: 'deleteArm'; on: boolean }
  /** TUI-DESIGN-5 §2.8: Enter on a row opens its card; Esc (`{ runId: null }`) returns to the list. */
  | { type: 'card'; runId: string | null }
  | { type: 'sessions'; sessions: readonly SessionRow[] }
  | { type: 'clamp'; count: number };

export const INITIAL_PICKER: PickerState = { kind: 'sessions', sessions: [], rewindSteps: [], workspace: '', selected: 0, widened: false, sort: 'updated', preview: null, renaming: false, deleteArmed: false, card: null };

function clamp(selected: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(0, Math.floor(selected)), count - 1);
}

/** §8.4: the pure picker reducer. */
export function pickerReducer(s: PickerState, a: PickerAction): PickerState {
  switch (a.type) {
    case 'open':
      return { ...INITIAL_PICKER, kind: a.kind, sessions: a.sessions ?? [], rewindSteps: a.rewindSteps ?? [], workspace: a.workspace, sort: a.sort ?? 'updated' };
    case 'move':
      // §2.8: the card belongs to ONE row, so any movement of the selection closes it back to the list
      return { ...s, selected: clamp(s.selected + a.by, a.count), preview: null, deleteArmed: false, card: null };
    case 'page':
      return { ...s, selected: clamp(s.selected + a.by * Math.max(1, a.size), a.count), preview: null, deleteArmed: false, card: null };
    case 'widen':
      return { ...s, widened: !s.widened, selected: 0, preview: null, deleteArmed: false, card: null };
    case 'preview':
      return { ...s, preview: a.lines, deleteArmed: false };
    case 'rename':
      return { ...s, renaming: a.on, deleteArmed: false };
    case 'deleteArm':
      return { ...s, deleteArmed: a.on };
    case 'card':
      return { ...s, card: a.runId === null ? null : { runId: a.runId }, deleteArmed: false };
    case 'sessions':
      return { ...s, sessions: a.sessions, selected: clamp(s.selected, a.sessions.length) };
    case 'clamp':
      return s.selected === clamp(s.selected, a.count) ? s : { ...s, selected: clamp(s.selected, a.count) };
  }
}

/** The sessions the picker shows for the composer filter (O6's rule: workspace unless widened, filter, sort). */
export function visibleSessions(s: PickerState, filter: string): SessionRow[] {
  return pickerSessions(s.sessions, { workspace: s.workspace, widened: s.widened, ...(filter !== '' ? { filter } : {}), sort: s.sort });
}

export function selectedSession(s: PickerState, filter: string): SessionRow | null {
  const rows = visibleSessions(s, filter);
  return rows[clamp(s.selected, rows.length)] ?? null;
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
}

/** §24: the picker's rule row (`─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────` or the rewind rule). */
export function pickerRule(s: PickerState, columns: number, g: GlyphSet = GLYPHS.unicode): string {
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
  let body: string[];
  let count: number;
  if (s.kind === 'rewind') {
    body = rewindPickerRows(s.rewindSteps, cols - 2);
    count = body.length;
    if (count === 0) body = [REWIND_EMPTY];
  } else {
    const list = visibleSessions(s, o.filter);
    body = pickerRows(list, { workspace: s.workspace, widened: s.widened, nowMs: o.nowMs, columns: cols - 2, sort: s.sort, ascii: g.mode === 'ascii', ...(o.filter !== '' ? { filter: o.filter } : {}), ...(o.live ? { live: o.live } : {}) });
    count = body.length;
    if (count === 0) body = [PICKER_EMPTY(s.widened ? 'any workspace' : s.workspace)];
  }
  const sel = clamp(s.selected, count);
  const tail: string[] = [];
  if (s.preview !== null) for (const l of s.preview) tail.push(`  ${l}`);
  tail.push(s.deleteArmed ? `  ${PICKER_DELETE_HINT}` : s.renaming ? `  ${PICKER_RENAME_LABEL}(type the new title, Enter saves, Esc cancels)` : `  ${PICKER_HINT}`);
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
