/**
 * The composer (TUI-DESIGN §4.3 rendering and cursor, §4.5 paste lifecycle, §4.6 history, §4.7 undo, §4.8 external
 * editor, §4.10 secret spans, §5.3 ghost completion, §24 placeholders; A1–A4, A7, A11, A33, F4).
 *
 * Two halves. `useComposer()` owns the `TextBuffer` through O2's pure `reduceBuffer` (§4.1: the buffer lives in the
 * composer's own reducer; `<App>` sends it the composer `KeyAction`s the one `resolveKey` produced), the `PasteStore`
 * in a `useRef` (bodies never enter React state, an `EngineEvent`, `ui.json`, history or logs), the Ctrl-R search,
 * the scroll offset and the `DraftMirror` the resolver and the layout read. `composerView()` is the pure row
 * builder shared by the component and its tests: `layoutRows` → `viewport` → `maskSpans` (detected secret spans
 * render as `•` cells of equal width, so no frame carries the bytes) → gutter markers `↑N`/`↓N`. `<Composer>` is a
 * fixed-height overflow-hidden box of exactly `height` pre-sliced `wrap="truncate"` rows; the placeholder is a dim
 * sibling `<Text>`, never buffer text; the real cursor is placed through the single `useCursor` the App owns
 * (`cursor(pos)` during render) at `{ x: gutter + cursorX, y: top + cursorRow − scrollTop }`.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { HistoryStore, SecretHit } from '../../core/types.js';
import type { KeyAction } from '../keys/resolve.js';
import { GLYPHS, cellWidth, glyphTwin, truncateCells, type GlyphSet } from '../glyphs.js';
import type { PaletteGhost, PaletteGhostLegacy } from '../commands/palette.js';
import { textProps, themeFor, type ColorOn, type Theme } from '../theme.js';
import { editorRefusalToast } from '../secrets/gate-lines.js';
import { chipSpans, createBuffer, normaliseText, reduceBuffer, snapshotOf, type BufferAction, type ChipRef, type Snapshot, type TextBuffer } from './buffer.js';
import { PasteStore } from './paste.js';
import { DEFAULT_GUTTER, MASK_GLYPH, MASK_GLYPH_ASCII, cursorToRowX, layoutRows, maskSpans, viewport, type Row, type Span } from './rows.js';
import type { ExpandResult } from './submit.js';
import { stringWidth } from './width.js';

export { DEFAULT_GUTTER as GUTTER };

/** §4.3 prompts: row 0 `> ` in `--plain` / `--ascii` (yellow while a run is live = steer mode), continuation rows two spaces. TUI-DESIGN-2 §4.4: the Unicode TUI draws `› `. */
export const PROMPT = '> ';
export const PROMPT_ASCII = PROMPT;
export const PROMPT_UNICODE = '› ';
export const CONTINUATION = '  ';
/** TUI-DESIGN-2 §4.4: `› ` (`glyphs.prompt`) under Unicode / SR, `> ` under `--ascii`; identical cell width. */
export function promptFor(g: GlyphSet = GLYPHS.unicode): string {
  return `${g.prompt} `;
}
/** §8.4 / F-L: the composer as the picker's filter. */
export const FILTER_LABEL = 'filter: ';
/** §4.6 Ctrl-R: the search row prefix. */
export const SEARCH_LABEL = '(reverse-i-search)';
/** §6.2 / §24: the review note field label. */
export const NOTE_LABEL = 'note (≤ 600, Enter sends, Esc cancels): ';
/** §6.4: a note is one line of at most this many characters. */
export const NOTE_MAX = 600;

/** TUI-DESIGN-2 §4.4 / §12 "Console": the placeholders, verbatim; the `*Hint` members are appended at ≥ 100 inner cells. */
export const PLACEHOLDERS = {
  task: 'Say hi, ask a question, or describe a task…',
  taskHint: '/ commands · @ files',
  followup: 'Follow-up, question, or /command…',
  followupHint: '↑ history · Esc Esc menu',
  steer: 'Type to steer the next step…  Esc pauses',
  steerHint: 'Esc Esc aborts',
  reviewLong: '(review pending — keys in the card; d opens a note)',
  reviewShort: '(review pending)',
  thinking: '(thinking…)',
  followupWait: '(waiting for y/r/n)',
  exitWait: '(waiting for y/n)',
  blocked: '(paused — answer the pane above)',
  filter: FILTER_LABEL,
} as const;

/**
 * `done`: one-shot mode after `run:end` — the composer was mounted for steering only (§1) and the process is exiting (§3.3), so
 * no placeholder invites input. TUI-DESIGN-2 §4.4: `thinking` (a submission between Enter and its reply; the draft stays editable,
 * Enter is queued).
 */
export type ComposerMode = 'task' | 'followup' | 'steer' | 'review' | 'thinking' | 'followupWait' | 'exitWait' | 'blocked' | 'filter' | 'done';

/** Below this many rows the review placeholder takes its short form (F-H, F-I, F-X vs F-G, F-J). */
export const SHORT_PLACEHOLDER_ROWS = 16;
/** TUI-DESIGN-2 §4.4: the hint suffix appears from this many inner cells. */
export const PLACEHOLDER_HINT_MIN_COLUMNS = 100;
/**
 * TUI-DESIGN-4 §4.3 P-P2 / §4.7 E11: the ghost the composer draws after the cursor. Round 4's three-member union and
 * round 3's two-member shape are both accepted — `App.tsx:2157` still builds the latter until §9.2's row lands.
 */
export type ComposerGhost = PaletteGhost | PaletteGhostLegacy;

/**
 * TUI-DESIGN-4 §4.3 P-P2: the ghost as one string — ` → /exit +2` for the arrow shape, `de +1` for a rest or a value.
 * `→` becomes `->` under `--ascii` (`glyphs.arrow`); the ` +N` suffix rule is round 3's, unchanged.
 */
export function ghostText(ghost: ComposerGhost, g: GlyphSet = GLYPHS.unicode): string {
  const more = ghost.more > 0 ? ` +${ghost.more}` : '';
  if ('kind' in ghost) return ghost.kind === 'arrow' ? ` ${g.arrow} ${ghost.target}${more}` : `${ghost.rest}${more}`;
  return ghost.arrow !== undefined && ghost.arrow !== '' ? ` ${g.arrow} ${ghost.arrow}${more}` : `${ghost.rest}${more}`;
}

/**
 * TUI-DESIGN-4 §4.7 E11: the ghost is cut to the room left on the draft's last row (`inner − cellWidth(row) − 1`).
 * Under four cells only the ` +N` count survives, under three nothing does — the palette rows carry the information,
 * so nothing is lost. Worst measured case `/budget ` + `max-generator-tokens` + ` +5` = 33 cells, which fits at 40.
 *
 * **The count is the part that survives the cut**, at every width: the rows on screen already spell the name the
 * ghost previews, but nothing else on the frame says how many other rows there are. So the truncation eats the
 * name and keeps ` +N` (`max-gen… +5`, never `max-generator-to…`); only when even ` +N` does not fit does the
 * span go empty.
 */
export function ghostSpan(ghost: ComposerGhost, room: number, g: GlyphSet = GLYPHS.unicode): string {
  const full = ghostText(ghost, g);
  const r = Number.isFinite(room) ? Math.floor(room) : 0;
  if (r >= cellWidth(full)) return full;
  if (r < 3) return '';
  const more = ghost.more > 0 ? ` +${ghost.more}` : '';
  const mw = cellWidth(more);
  if (r < 4) return more !== '' && mw <= r ? more : '';
  if (more === '') return truncateCells(full, r, g);
  // keep the suffix: truncate only the name part, and fall back to the count alone when the name has no room left
  const base = full.slice(0, full.length - more.length);
  return r - mw >= 2 ? `${truncateCells(base, r - mw, g)}${more}` : mw <= r ? more : truncateCells(full, r, g);
}

/** TUI-DESIGN-4 §5.3 P-C8 (a) / §12: the right-hand span a multi-line draft carries — `3 lines · ⏎ send`. */
export function multilineHint(lines: number, g: GlyphSet = GLYPHS.unicode): string {
  return `${lines} lines ${g.dot} ${g.mode === 'ascii' ? 'Enter' : '⏎'} send`;
}

/** the gap between a placeholder and its inline hint */
export const PLACEHOLDER_HINT_GAP = '   ';

/** TUI-DESIGN-2 §4.4: the placeholder's text and its width-gated hint (`right`: the console right-aligns it, H-A1w; `inline`: three spaces after the text, H-D1w). */
export interface PlaceholderParts {
  text: string;
  hint: string;
  align: 'right' | 'inline';
}

/**
 * The quiet start (2026-09): the workspace's most recent session is offered HERE — in the row the user is already
 * looking at — instead of a `recent: "<title>" …` item above the box. The title is clipped to the inner width so the
 * placeholder is always one row; Enter stays inert (it submits the draft), `/resume` is the verb.
 */
export function recentTaskPlaceholder(title: string, innerColumns: number = 0): string {
  const head = 'Say hi · /resume continues "';
  const width = Number.isFinite(innerColumns) && innerColumns > 0 ? innerColumns : 80;
  const room = width - stringWidth(head) - 3; // the prompt (2 cells) and the closing quote
  const t = room > 1 && stringWidth(title) > room ? `${title.slice(0, Math.max(1, room - 1))}…` : title;
  return `${head}${t}"`;
}

/** TUI-DESIGN-2 §4.4: the placeholder parts for a state (the short review form below 16 rows; the hint only at ≥ 100 inner cells). */
export function placeholderParts(mode: ComposerMode, rows: number, innerColumns: number = 0, recent: string | null = null): PlaceholderParts {
  const wide = Number.isFinite(innerColumns) && innerColumns >= PLACEHOLDER_HINT_MIN_COLUMNS;
  switch (mode) {
    case 'task':
      return { text: recent !== null && recent !== '' ? recentTaskPlaceholder(recent, innerColumns) : PLACEHOLDERS.task, hint: wide ? PLACEHOLDERS.taskHint : '', align: 'right' };
    case 'followup':
      return { text: PLACEHOLDERS.followup, hint: wide ? PLACEHOLDERS.followupHint : '', align: 'right' };
    case 'steer':
      return { text: PLACEHOLDERS.steer, hint: wide ? PLACEHOLDERS.steerHint : '', align: 'inline' };
    case 'review':
      return { text: rows < SHORT_PLACEHOLDER_ROWS ? PLACEHOLDERS.reviewShort : PLACEHOLDERS.reviewLong, hint: '', align: 'inline' };
    case 'thinking':
      return { text: PLACEHOLDERS.thinking, hint: '', align: 'inline' };
    case 'followupWait':
      return { text: PLACEHOLDERS.followupWait, hint: '', align: 'inline' };
    case 'exitWait':
      return { text: PLACEHOLDERS.exitWait, hint: '', align: 'inline' };
    case 'blocked':
      return { text: PLACEHOLDERS.blocked, hint: '', align: 'inline' };
    case 'filter':
    case 'done':
      return { text: '', hint: '', align: 'inline' };
  }
}

/** TUI-DESIGN-2 §4.4: the placeholder for a state — the text, then the hint after three spaces at ≥ 100 inner cells (the short review form on short terminals). */
export function placeholderFor(mode: ComposerMode, rows: number, innerColumns: number = 0): string {
  const p = placeholderParts(mode, rows, innerColumns);
  return p.hint === '' ? p.text : `${p.text}${PLACEHOLDER_HINT_GAP}${p.hint}`;
}

// ---------------------------------------------------------------------------------------
// Pure view (§4.3)
// ---------------------------------------------------------------------------------------

export interface ComposerViewInput {
  text: string;
  cursor: number;
  chips: readonly ChipRef[];
  columns: number;
  /** rows granted by `computeLayout` (≥ 1) */
  height: number;
  scrollTop: number;
  /** detected secret spans (§4.3, §10.1) */
  spans?: readonly Span[];
  /** `•` (or `*` under --ascii) */
  maskGlyph?: string;
  /** row-0 prefix (`› `, `› filter: `); defaults to the glyph set's prompt */
  prompt?: string;
  glyphs?: GlyphSet;
}

export interface ComposerView {
  /** exactly `height` rows (padded with '' when the draft is shorter), each prefixed and ≤ columns cells */
  rows: string[];
  /** the cursor inside the box (row relative to the box top, x in cells incl. the prefix), null when the cursor row is scrolled out */
  cursor: { row: number; x: number } | null;
  /** the scroll offset actually used (clamped so the cursor row is visible) */
  scrollTop: number;
  totalRows: number;
  hiddenAbove: number;
  hiddenBelow: number;
  cursorRow: 'first' | 'mid' | 'last';
}

function markerRow(text: string, marker: string, columns: number): string {
  const w = stringWidth(text);
  const mw = stringWidth(marker);
  if (w + 1 + mw > columns) return text;
  return `${text}${' '.repeat(columns - w - mw)}${marker}`;
}

/**
 * §4.3: the rows of the composer box — `layoutRows` (atoms = chip labels), `viewport` keeps the cursor row visible,
 * `maskSpans` after the layout (widths and cursor arithmetic unchanged), `↑N`/`↓N` right-aligned on the first/last
 * visible row when rows are hidden. Pure.
 */
export function composerView(i: ComposerViewInput): ComposerView {
  const g = i.glyphs ?? GLYPHS.unicode;
  const columns = Math.max(1, Math.floor(Number.isFinite(i.columns) ? i.columns : 80));
  const height = Math.max(1, Math.floor(Number.isFinite(i.height) ? i.height : 1));
  const prompt = i.prompt ?? promptFor(g);
  const gutter = Math.max(stringWidth(prompt), CONTINUATION.length);
  const rows: Row[] = layoutRows(i.text, columns, gutter, { atoms: chipSpans(i.text, i.chips) });
  const at = cursorToRowX(rows, i.text, i.cursor);
  const scrollTop = viewport(at.row, height, i.scrollTop);
  const visible = rows.slice(scrollTop, scrollTop + height);
  const spans = i.spans ?? [];
  const glyph = i.maskGlyph ?? (g.mode === 'ascii' ? MASK_GLYPH_ASCII : MASK_GLYPH);
  const out: string[] = [];
  for (let k = 0; k < height; k++) {
    const r = visible[k];
    if (r === undefined) {
      out.push('');
      continue;
    }
    const idx = scrollTop + k;
    const body = spans.length > 0 ? maskSpans(i.text, r, spans, glyph) : i.text.slice(r.start, r.end);
    out.push(`${idx === 0 ? prompt : CONTINUATION}${body}`);
  }
  const hiddenAbove = scrollTop;
  const hiddenBelow = Math.max(0, rows.length - scrollTop - height);
  if (hiddenAbove > 0 && out.length > 0) out[0] = markerRow(out[0] ?? '', `${g.up}${hiddenAbove}`, columns);
  if (hiddenBelow > 0) {
    const last = Math.min(height, visible.length) - 1;
    if (last >= 0) out[last] = markerRow(out[last] ?? '', `${g.down}${hiddenBelow}`, columns);
  }
  const cursorVisible = at.row >= scrollTop && at.row < scrollTop + height;
  const cursorRow: ComposerView['cursorRow'] = rows.length <= 1 ? 'first' : at.row === 0 ? 'first' : at.row === rows.length - 1 ? 'last' : 'mid';
  return {
    rows: out,
    cursor: cursorVisible ? { row: at.row - scrollTop, x: (at.row === 0 ? stringWidth(prompt) : CONTINUATION.length) + at.x } : null,
    scrollTop,
    totalRows: rows.length,
    hiddenAbove,
    hiddenBelow,
    cursorRow,
  };
}

/** §4.3: the visual row count of a draft for `LayoutInput.composerWant` (≥ 1). */
export function draftRows(text: string, chips: readonly ChipRef[], columns: number, prompt: string = PROMPT_UNICODE): number {
  return Math.max(1, layoutRows(text, Math.max(1, Math.floor(columns)), Math.max(stringWidth(prompt), CONTINUATION.length), { atoms: chipSpans(text, chips) }).length);
}

/** §4.3: secret hits → spans in logical-text coordinates. */
export function hitSpans(hits: readonly SecretHit[]): Span[] {
  return hits.map((h) => ({ start: h.start, end: h.end }));
}

// ---------------------------------------------------------------------------------------
// Hook (§4.1, §4.5, §4.6, §4.7)
// ---------------------------------------------------------------------------------------

/** §4.6 Ctrl-R state: the query, the match index (0 = newest), the stashed draft and the filter. */
export interface HistorySearch {
  query: string;
  index: number;
  stash: Snapshot;
  filter: 'workspace' | 'all';
}

export interface DraftMirrorLike {
  empty: boolean;
  rows: number;
  cursorRow: 'first' | 'mid' | 'last';
  secretHits: number;
}

export interface ComposerDeps {
  /** the session history store (null before `setHost`); read on every Up / Ctrl-R, never cached */
  history: () => HistoryStore | null;
  /** `host.detectSecrets` (pattern-only before the host attaches) */
  detect: (text: string) => readonly SecretHit[];
  now?: () => number;
}

export type ApplyResult =
  | { kind: 'handled' }
  | { kind: 'unhandled' }
  | { kind: 'toast'; text: string; level: 'info' | 'error' }
  /** Ctrl-R Enter: the accepted entry is now the draft; the caller submits */
  | { kind: 'submit' }
  /** `→` at the end of the text: the caller may accept the ghost completion */
  | { kind: 'ghost' };

export interface ComposerController {
  readonly buffer: TextBuffer;
  readonly search: HistorySearch | null;
  readonly scrollTop: number;
  /** the paste store (bodies live here only) */
  readonly store: PasteStore;
  /** apply one resolver action; `columns` is the wrap width for ↑/↓ */
  apply(action: KeyAction, ctx: { columns: number; rows: number }): ApplyResult;
  dispatch(action: BufferAction): void;
  set(text: string, cursor?: number, pushUndo?: boolean): void;
  /** Ctrl-C / Esc Esc: one undo snapshot (§4.1 `clear`) */
  clear(): void;
  /** the paste chips' bodies for `routeSubmit` */
  expand(text: string): ExpandResult;
  /** every detected hit in the current draft */
  hits(): readonly SecretHit[];
  mirror(columns: number, prompt?: string): DraftMirrorLike;
  setScrollTop(n: number): void;
  /** the history form of the draft (chip labels with a redacted first line, §4.6) */
  historyText(redact: (s: string) => string): string;
  /** stash / restore the draft around the review note field (§6.2) */
  stash(): Snapshot;
  restore(s: Snapshot): void;
  /** the search-row text for the component (`(reverse-i-search)'q': match`) */
  searchRow(): string | null;
}

function searchMatches(entries: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] ?? '';
    if (q === '' || e.toLowerCase().includes(q)) out.push(e);
  }
  return out;
}

/** The composer's own reducer hook (§4.1); the buffer, paste store, search and scroll state live here. */
export function useComposer(deps: ComposerDeps): ComposerController {
  const now = deps.now ?? Date.now;
  const [buffer, setBufferState] = useState<TextBuffer>(() => createBuffer());
  const [search, setSearchState] = useState<HistorySearch | null>(null);
  const [scrollTop, setScrollTopState] = useState(0);
  const bufferRef = useRef(buffer);
  const searchRef = useRef(search);
  const storeRef = useRef<PasteStore | null>(null);
  storeRef.current ??= new PasteStore();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const set = useCallback((b: TextBuffer): void => {
    bufferRef.current = b;
    setBufferState(b);
  }, []);
  const setSearch = useCallback((s: HistorySearch | null): void => {
    searchRef.current = s;
    setSearchState(s);
  }, []);
  const reduce = useCallback((a: BufferAction): void => set(reduceBuffer(bufferRef.current, a, now())), [set, now]);

  const controller = useMemo<ComposerController>(() => {
    const store = storeRef.current as PasteStore;
    const entries = (filter: 'workspace' | 'all'): readonly string[] => depsRef.current.history()?.entries(filter) ?? [];
    const applySearch = (s: HistorySearch): void => {
      const m = searchMatches(entries(s.filter), s.query);
      const idx = Math.min(s.index, Math.max(0, m.length - 1));
      const hit = m[idx];
      setSearch({ ...s, index: idx });
      if (hit !== undefined) set(reduceBuffer(bufferRef.current, { type: 'setText', text: hit, pushUndo: false }, now()));
    };
    const endSearch = (keep: boolean): void => {
      const s = searchRef.current;
      if (s === null) return;
      setSearch(null);
      if (!keep) set(reduceBuffer(bufferRef.current, { type: 'setText', text: s.stash.text, cursor: s.stash.cursor, pushUndo: false }, now()));
    };
    const c: ComposerController = {
      get buffer() {
        return bufferRef.current;
      },
      get search() {
        return searchRef.current;
      },
      get scrollTop() {
        return scrollTop;
      },
      store,
      dispatch: reduce,
      set(text, cursor, pushUndo = true) {
        set(reduceBuffer(bufferRef.current, cursor === undefined ? { type: 'setText', text, pushUndo } : { type: 'setText', text, cursor, pushUndo }, now()));
      },
      clear() {
        reduce({ type: 'clear' });
      },
      expand(text) {
        const r = store.expand(text, bufferRef.current.chips);
        return r.ok ? { ok: true, text: r.text } : { ok: false, n: r.missing.n, label: r.missing.label };
      },
      hits() {
        return depsRef.current.detect(bufferRef.current.text);
      },
      mirror(columns, prompt = PROMPT_UNICODE) {
        const b = bufferRef.current;
        const rows = layoutRows(b.text, Math.max(1, Math.floor(columns)), Math.max(stringWidth(prompt), CONTINUATION.length), { atoms: chipSpans(b.text, b.chips) });
        const at = cursorToRowX(rows, b.text, b.cursor);
        const cursorRow: DraftMirrorLike['cursorRow'] = rows.length <= 1 || at.row === 0 ? 'first' : at.row === rows.length - 1 ? 'last' : 'mid';
        return { empty: b.text.length === 0, rows: Math.max(1, rows.length), cursorRow, secretHits: b.text.length === 0 ? 0 : depsRef.current.detect(b.text).length };
      },
      setScrollTop(n) {
        setScrollTopState(Math.max(0, Math.floor(n)));
      },
      historyText(redact) {
        return store.labelsForHistory(bufferRef.current.text, bufferRef.current.chips, redact);
      },
      stash() {
        return snapshotOf(bufferRef.current);
      },
      restore(s) {
        set(reduceBuffer(bufferRef.current, { type: 'setText', text: s.text, cursor: s.cursor, pushUndo: false }, now()));
      },
      searchRow() {
        const s = searchRef.current;
        if (s === null) return null;
        return `${SEARCH_LABEL}'${s.query}': ${bufferRef.current.text.split('\n')[0] ?? ''}`;
      },
      apply(action, ctx) {
        const b = bufferRef.current;
        switch (action.type) {
          case 'insert':
            reduce({ type: 'insert', text: action.text });
            return { kind: 'handled' };
          case 'paste': {
            const d = store.accept(action.text, { rows: ctx.rows });
            switch (d.kind) {
              case 'refused':
                return { kind: 'toast', text: d.toast, level: 'error' };
              case 'chip':
                reduce({ type: 'chip', chip: d.chip });
                return { kind: 'handled' };
              case 'insert':
                reduce({ type: 'insert', text: d.text, paste: true });
                return { kind: 'handled' };
              case 'empty':
                return { kind: 'handled' };
            }
            return { kind: 'handled' };
          }
          case 'newline':
            reduce({ type: 'newline' });
            return { kind: 'handled' };
          case 'backspace':
            reduce({ type: 'backspace' });
            return { kind: 'handled' };
          case 'delete':
            reduce({ type: 'delete' });
            return { kind: 'handled' };
          case 'move':
            if (action.to === 'right' && b.cursor >= b.text.length) return { kind: 'ghost' };
            reduce({ type: 'move', to: action.to, columns: Math.max(1, ctx.columns - DEFAULT_GUTTER) });
            return { kind: 'handled' };
          case 'kill':
            reduce({ type: 'kill', what: action.what });
            return { kind: 'handled' };
          case 'yank':
            reduce({ type: 'yank' });
            return { kind: 'handled' };
          case 'yankPop':
            reduce({ type: 'yankPop' });
            return { kind: 'handled' };
          case 'transpose':
            reduce({ type: 'transpose' });
            return { kind: 'handled' };
          case 'undo':
            reduce({ type: 'undo' });
            return { kind: 'handled' };
          case 'redo':
            reduce({ type: 'redo' });
            return { kind: 'handled' };
          case 'history': {
            // the resolver's −1 is "previous" (older); the buffer's 1 is "older"
            const dir: 1 | -1 = action.dir === -1 ? 1 : -1;
            reduce({ type: 'history', dir, entries: entries(b.history.filter) });
            return { kind: 'handled' };
          }
          case 'historySearch': {
            const s = searchRef.current;
            switch (action.op) {
              case 'open':
                if (s !== null) {
                  applySearch({ ...s, index: s.index + 1 });
                  return { kind: 'handled' };
                }
                setSearch({ query: '', index: 0, stash: snapshotOf(b), filter: b.history.filter });
                return { kind: 'handled' };
              case 'query':
                if (s === null) return { kind: 'unhandled' };
                applySearch({ ...s, query: s.query + normaliseText(action.text ?? '').replace(/\n/g, ' '), index: 0 });
                return { kind: 'handled' };
              case 'backspace':
                if (s === null) return { kind: 'unhandled' };
                if (s.query === '') {
                  endSearch(false);
                  return { kind: 'handled' };
                }
                applySearch({ ...s, query: [...s.query].slice(0, -1).join(''), index: 0 });
                return { kind: 'handled' };
              case 'older':
                if (s === null) return { kind: 'unhandled' };
                applySearch({ ...s, index: s.index + 1 });
                return { kind: 'handled' };
              case 'newer':
                if (s === null) return { kind: 'unhandled' };
                applySearch({ ...s, index: Math.max(0, s.index - 1) });
                return { kind: 'handled' };
              case 'widen':
                if (s === null) return { kind: 'unhandled' };
                reduce({ type: 'historyFilter', filter: 'all' });
                applySearch({ ...s, filter: 'all', index: 0 });
                return { kind: 'handled' };
              case 'accept':
                endSearch(true);
                return { kind: 'handled' };
              case 'acceptSubmit':
                endSearch(true);
                return { kind: 'submit' };
              case 'cancel':
                endSearch(false);
                return { kind: 'handled' };
            }
            return { kind: 'unhandled' };
          }
          default:
            return { kind: 'unhandled' };
        }
      },
    };
    return c;
  }, [reduce, set, setSearch, now, scrollTop]);

  return controller;
}

// ---------------------------------------------------------------------------------------
// External editor (§4.8)
// ---------------------------------------------------------------------------------------

export interface EditorDeps {
  env: NodeJS.ProcessEnv;
  /** `useApp().suspendTerminal` (callback form) */
  suspendTerminal: (cb: () => Promise<void>) => Promise<void>;
  /** `<runDir>/drafts` or `~/.jevcode/drafts` (0700) — never `<runDir>/tmp` */
  dir: string;
  seq: number;
  pid?: number;
  detect: (text: string) => readonly SecretHit[];
  spawn?: typeof spawn;
}

export type EditorResult = { kind: 'ok'; text: string } | { kind: 'refused'; toast: string } | { kind: 'failed'; toast: string };

/**
 * §4.8 Ctrl+G / `/editor`: refused while the draft has a secret hit; else the draft (chip labels kept) goes to
 * `<dir>/edit-<pid>-<seq>.md` (0600 inside a 0700 dir), `$VISUAL` ?? `$EDITOR` ?? `vi` runs through `/bin/sh -c`
 * under `suspendTerminal`, exit 0 reads the file back normalised, non-zero keeps the draft; the file is always unlinked.
 */
export async function openExternalEditor(text: string, d: EditorDeps): Promise<EditorResult> {
  const hits = d.detect(text);
  if (hits.length > 0) return { kind: 'refused', toast: editorRefusalToast(hits) };
  const editor = (d.env['VISUAL'] ?? d.env['EDITOR'] ?? 'vi').trim() || 'vi';
  const file = join(d.dir, `edit-${d.pid ?? process.pid}-${d.seq}.md`);
  try {
    mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (e) {
    return { kind: 'failed', toast: `editor: could not write the draft (${(e as NodeJS.ErrnoException).code ?? 'error'}); draft kept` };
  }
  let code: number | null = null;
  try {
    await d.suspendTerminal(async () => {
      code = await new Promise<number | null>((resolve) => {
        const child = (d.spawn ?? spawn)('/bin/sh', ['-c', `${editor} "$0"`, file], { stdio: 'inherit' });
        child.once('error', () => resolve(null));
        child.once('close', (c) => resolve(c));
      });
    });
    if (code !== 0) return { kind: 'failed', toast: `editor exited ${code ?? 'with an error'}; draft kept` };
    const back = normaliseText(readFileSync(file, 'utf8')).replace(/\n$/, '');
    return { kind: 'ok', text: back };
  } catch (e) {
    return { kind: 'failed', toast: `editor failed: ${e instanceof Error ? e.message : String(e)}; draft kept` };
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------
// Component (§4.3)
// ---------------------------------------------------------------------------------------

export interface ComposerProps {
  buffer: TextBuffer;
  /** the width the rows are laid out in (the console's inner width in the boxed tier) */
  columns: number;
  /** rows granted by `computeLayout` */
  height: number;
  /** `composerTop(layout)`: the row the box starts on inside the dynamic region */
  top: number;
  scrollTop: number;
  /** the single `useCursor().setCursorPosition` the App owns; called during render */
  cursor: (pos: CursorPosition | undefined) => void;
  /** false while a collapsing overlay owns the input or the review is deferred: no cursor, dim placeholder row */
  active: boolean;
  mode: ComposerMode;
  /** the terminal height (placeholder form) */
  rows: number;
  /** a run is live: the `>` takes the `steer` role (amber); `accent` (pink) at rest — TUI-DESIGN-3 D-O */
  live?: boolean;
  spans?: readonly Span[];
  /** the ghost completion after the cursor (dim): TUI-DESIGN-4 §4.3's three-member union or round 3's shape */
  ghost?: ComposerGhost | null;
  /** Ctrl-R row */
  searchRow?: string | null;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: ColorOn;
  onScroll?: (scrollTop: number) => void;
  /** TUI-DESIGN-2 §4.3: the console's inner width the placeholder hint is right-aligned in (defaults to `columns`) */
  innerColumns?: number;
  /** TUI-DESIGN-2 §4.3: the console row's `x` offset (2 inside `│ `); the flat tier passes 0 */
  cursorOffsetX?: number;
}

/** TUI-DESIGN-2 §4.4 / TD §14.1: the placeholder row text after the prompt — text, then the hint right-aligned (`right`) or after three spaces (`inline`), never wider than `width`; `--ascii` draws the glyph twins (`...`, `-`, `^`). */
export function placeholderRow(mode: ComposerMode, rows: number, width: number, promptWidth: number, g: GlyphSet = GLYPHS.unicode, recent: string | null = null): string {
  const raw = placeholderParts(mode, rows, width, recent);
  const parts = { text: glyphTwin(raw.text, g), hint: glyphTwin(raw.hint, g), align: raw.align };
  if (parts.hint === '') return parts.text;
  const room = width - promptWidth;
  if (parts.align === 'inline') return stringWidth(parts.text) + PLACEHOLDER_HINT_GAP.length + stringWidth(parts.hint) <= room ? `${parts.text}${PLACEHOLDER_HINT_GAP}${parts.hint}` : parts.text;
  const gap = room - stringWidth(parts.text) - stringWidth(parts.hint);
  return gap >= PLACEHOLDER_HINT_GAP.length ? `${parts.text}${' '.repeat(gap)}${parts.hint}` : parts.text;
}

/** §4.3: the composer box — `height` pre-sliced rows, the placeholder as a dim sibling, the cursor at `cursorToRowX`. */
export function Composer(p: ComposerProps): React.JSX.Element {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const height = Math.max(1, Math.floor(p.height));
  const base = promptFor(g);
  const prompt = p.mode === 'filter' ? `${base}${FILTER_LABEL}` : base;
  const view = composerView({ text: p.buffer.text, cursor: p.buffer.cursor, chips: p.buffer.chips, columns: p.columns, height, scrollTop: p.scrollTop, spans: p.spans ?? [], prompt, glyphs: g });
  if (view.scrollTop !== p.scrollTop) p.onScroll?.(view.scrollTop);
  const empty = p.buffer.text.length === 0;
  const placeholder = placeholderRow(p.mode, p.rows, p.innerColumns ?? p.columns, stringWidth(prompt), g);
  // TUI-DESIGN-3 §2.6 (D-O): pink at rest, amber while a run is live
  const promptProps = p.live === true && p.active ? textProps(theme, 'steer', color) : p.active ? textProps(theme, 'accent', color) : {};
  const dx = p.cursorOffsetX ?? 0;
  // TUI-DESIGN-4 §5.3 P-C8 (a): the multi-line send hint, only while the draft has an interior newline and only at
  // the width where the other right-hand spans survive
  const newlines = p.buffer.text.includes('\n') ? p.buffer.text.split('\n').length : 0;
  const multi = newlines > 1 && (p.innerColumns ?? p.columns) >= PLACEHOLDER_HINT_MIN_COLUMNS ? multilineHint(newlines, g) : null;
  if (p.active && view.cursor !== null && p.searchRow == null) p.cursor({ x: dx + view.cursor.x, y: p.top + view.cursor.row });
  else if (p.active && p.searchRow != null) p.cursor({ x: Math.min(dx + p.columns - 1, dx + stringWidth(p.searchRow)), y: p.top });
  else p.cursor(undefined);
  const rowsOut = view.rows.map((r, i) => {
    const isPromptRow = view.scrollTop + i === 0 && r.startsWith(prompt);
    const body = isPromptRow ? r.slice(prompt.length) : r;
    const onCursorRow = view.cursor !== null && view.cursor.row === i && p.buffer.cursor >= p.buffer.text.length;
    // TUI-DESIGN-4 §4.7 E11: the ghost never pushes the row past the console's inner width
    const ghost = p.ghost != null && onCursorRow ? ghostSpan(p.ghost, (p.innerColumns ?? p.columns) - cellWidth(r) - 1, g) : '';
    // TUI-DESIGN-4 §5.3 P-C8 (a): `N lines · ⏎ send` on the last row of a multi-line draft, right-aligned, dropped
    // below PLACEHOLDER_HINT_MIN_COLUMNS with the other right-hand spans (the flat tier included)
    // the span sits on the last row of the DRAFT (never on a padding row below it), and gives way to the `↓N`
    // marker, which already owns that corner when the draft scrolls
    const hint = multi !== null && view.hiddenBelow === 0 && i === Math.min(view.rows.length, view.totalRows - view.scrollTop) - 1 ? multi : '';
    const gap = hint === '' ? 0 : (p.innerColumns ?? p.columns) - cellWidth(r) - cellWidth(ghost) - cellWidth(hint);
    return (
      <Box key={`c${i}`} height={1} overflow="hidden">
        <Text wrap="truncate">
          {isPromptRow ? <Text {...promptProps}>{prompt}</Text> : null}
          {body}
          {ghost === '' ? null : <Text {...textProps(theme, 'dim', color)}>{ghost}</Text>}
          {hint !== '' && gap >= 1 ? <Text {...textProps(theme, 'dim', color)}>{`${' '.repeat(gap)}${hint}`}</Text> : null}
          {i === 0 && empty && !p.searchRow && placeholder !== '' ? <Text {...textProps(theme, 'placeholder', color)}>{placeholder}</Text> : null}
        </Text>
      </Box>
    );
  });
  if (p.searchRow != null) {
    rowsOut[0] = (
      <Box key="search" height={1} overflow="hidden">
        <Text wrap="truncate">{p.searchRow}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {rowsOut}
    </Box>
  );
}
