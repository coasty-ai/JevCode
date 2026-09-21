/**
 * Composer text buffer: model and pure reducer (TUI-DESIGN §4.1, §4.7; A1, 08 §8). Ink-free.
 *
 * Invariants the reducer keeps for every action sequence (fuzzed in §19.2):
 *   - `text` holds only '\n' below 0x20 (tabs are expanded on insert), no DEL/C1, no bidi controls, no lone surrogates;
 *   - `cursor` is a UTF-16 index on a grapheme boundary and never strictly inside a chip label (chips are atomic:
 *     motions skip them, Backspace/Delete/kill remove them whole and drop the `ChipRef` from `chips`);
 *   - a dropped `ChipRef` is parked in `retired` (≤ 32) for as long as its label can come back — yank / Alt+Y, undo /
 *     redo, `setText` from the external editor — and is re-adopted the moment the label reappears, so a moved chip
 *     stays atomic and still expands at submit; `clear` and a fresh buffer forget them;
 *   - chip identity is the label string (the design's `ChipRef` carries no position), so plain text a user types or
 *     pastes is never allowed to alias a live or retired label: `insert` rewrites `[Pasted #n, …]` to `[Pasted # n, …]`;
 *     yank, undo/redo, `setText` and history recall carry labels legitimately and are not rewritten;
 *   - `undo` pushes at most one snapshot per coalesced run of single-grapheme inserts; every other edit is one step;
 *   - history browsing (§4.6): editing a recalled entry keeps `level` and the stashed draft, as readline does, so Down
 *     still returns to the draft; leaving an edited level pushes one undo snapshot; `clear` abandons browsing;
 *   - no I/O and no clock: the 2 s coalescing idle rule reads the `nowMs` the caller passes.
 * Paste bodies never enter this module (§4.5): a chip is its label text plus a `ChipRef`.
 */
import { TAB_SPACES, normaliseChunk } from './filter.js';
import { KILL_RING_MAX, nextYankIndex, pushKill } from './killring.js';
import { DEFAULT_GUTTER, cursorToRowX, layoutRows, textUnits, type Row, type Span } from './rows.js';

export { TAB_SPACES };

/** Undo/redo unit (TUI-DESIGN §4.1); `chips` is carried so undoing a chip deletion restores its `ChipRef`. */
export interface Snapshot {
  readonly text: string;
  readonly cursor: number;
  readonly chips?: readonly ChipRef[];
}

/** A collapsed paste (TUI-DESIGN §4.1, §4.5): the body lives in the `PasteStore`, never here; `label` is `[Pasted #n, k lines]`. */
export interface ChipRef {
  readonly n: number;
  readonly lines: number;
  readonly bytes: number;
  readonly label: string;
}

/** Which history entries Up/Ctrl-R browse (TUI-DESIGN §4.6): this workspace, or every workspace after Ctrl-A. */
export type HistoryFilter = 'workspace' | 'all';

/** Up/Down history navigation state (TUI-DESIGN §4.6): level −1 is the live draft; `stash` holds it while browsing. */
export interface HistoryNav {
  readonly level: number;
  readonly stash: Snapshot | null;
  readonly filter: HistoryFilter;
}

/** The composer's whole editing state (TUI-DESIGN §4.1). */
export interface TextBuffer {
  /** logical text; only '\n' below 0x20 (tabs expanded on insert); chips appear as their label text */
  readonly text: string;
  /** UTF-16 index, always on a grapheme boundary and never inside a chip label */
  readonly cursor: number;
  /** sticky visual column for ↑/↓ */
  readonly preferredX: number | null;
  /** ≤ 16, newest first; survives submit for the process lifetime */
  readonly killRing: readonly string[];
  /** set right after a yank so Alt+Y rotates */
  readonly yankIndex: number | null;
  /** consecutive kills concatenate (readline): the direction of the last kill, null after any other action */
  readonly lastKill: 'append' | 'prepend' | null;
  /** ≤ 100 */
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  /** consecutive single-grapheme inserts share one undo step until whitespace/newline/motion/2 s idle */
  readonly coalescing: boolean;
  /** `nowMs` of the last coalescing insert (the 2 s idle rule; the caller supplies the clock) */
  readonly lastEditMs: number;
  /** bodies live in the PasteStore (§4.5), never here */
  readonly chips: readonly ChipRef[];
  /** ChipRefs whose label left the text but may return (kill ring, undo, editor round trip); ≤ `RETIRED_MAX`, newest first */
  readonly retired: readonly ChipRef[];
  readonly history: HistoryNav;
}

/** Cursor motions (TUI-DESIGN §4.1); up/down are visual rows, wordLeft/wordRight use `wordBoundary`, start/finish are the text ends. */
export type Motion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'wordLeft' | 'wordRight' | 'start' | 'finish';

/** Every composer edit and motion as data (TUI-DESIGN §4.1); the reducer is the only writer of `TextBuffer`. */
export type BufferAction =
  /** already filtered (§4.4); `paste` = one undo step, no coalescing */
  | { type: 'insert'; text: string; paste?: boolean }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  /** up/down need the wrap width */
  | { type: 'move'; to: Motion; columns: number }
  | { type: 'kill'; what: 'toEnd' | 'toStart' | 'wordBack' | 'wordForward' }
  | { type: 'yank' }
  | { type: 'yankPop' }
  | { type: 'transpose' }
  | { type: 'undo' }
  | { type: 'redo' }
  /** history recall, external editor, unsteer */
  | { type: 'setText'; text: string; cursor?: number; pushUndo: boolean }
  /** Ctrl-C / Esc Esc: one undo snapshot so C-_ brings it back */
  | { type: 'clear' }
  /** insert a chip label as one atomic token */
  | { type: 'chip'; chip: ChipRef }
  /** `entries` oldest → newest (as `HistoryStore.entries()` returns); dir 1 = older, −1 = newer */
  | { type: 'history'; dir: -1 | 1; entries: readonly string[] }
  /** Ctrl-A in Ctrl-R widens (§4.6); returns to the live draft */
  | { type: 'historyFilter'; filter: HistoryFilter };

/** Snapshots kept each way (TUI-DESIGN §4.7). */
export const UNDO_MAX = 100;
/** A coalesced insert run ends after this much idle time (TUI-DESIGN §4.7). */
export const COALESCE_IDLE_MS = 2000;
/** Retired ChipRefs kept for re-adoption (TUI-DESIGN §4.1, §4.7): twice the kill ring, so every yankable label can come back. */
export const RETIRED_MAX = 2 * KILL_RING_MAX;

const ASCII_RE = /^[\u0000-\u007f]*$/;
const WORD_SEPARATORS = new Set(['/', '-', '_', '.']);
const LINE_CACHE_MAX = 256;

/** Bring text into the buffer's alphabet (TUI-DESIGN §4.1, §4.4): CRLF/CR/U+2028/2029 → '\n', tabs → spaces, no C0/DEL/C1/bidi/lone surrogates. The one shared normaliser (`filter.ts`). */
export function normaliseText(s: string): string {
  return normaliseChunk(s);
}

// ---------------------------------------------------------------------------------------------
// Segmenters: lazily created singletons (~5.6 ms for the pair, 12 §7) so they never sit on the first-frame path.
// ---------------------------------------------------------------------------------------------

let seg: Intl.Segmenter | null = null;
let wordSeg: Intl.Segmenter | null = null;
function graphemeSegmenter(): Intl.Segmenter {
  seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return seg;
}
function wordSegmenter(): Intl.Segmenter {
  wordSeg ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  return wordSeg;
}

const lineBoundaryCache = new Map<string, Uint32Array>();
const lineWordCache = new Map<string, readonly Span[]>();

/** Grapheme boundaries of one logical line (no '\n' inside), memoised per line string. */
function lineBoundaries(line: string): Uint32Array {
  if (ASCII_RE.test(line) && !line.includes('\r')) {
    const out = new Uint32Array(line.length + 1);
    for (let i = 0; i <= line.length; i++) out[i] = i;
    return out;
  }
  const hit = lineBoundaryCache.get(line);
  if (hit !== undefined) return hit;
  const positions: number[] = [0];
  for (const { index, segment } of graphemeSegmenter().segment(line)) positions.push(index + segment.length);
  const out = Uint32Array.from(positions);
  if (lineBoundaryCache.size >= LINE_CACHE_MAX) lineBoundaryCache.clear();
  lineBoundaryCache.set(line, out);
  return out;
}

/**
 * Every grapheme boundary of `text` as sorted UTF-16 offsets, 0 and `text.length` included (TUI-DESIGN §4.1).
 * Segmented per logical line through the lazily created grapheme segmenter and memoised per line.
 */
export function graphemeBoundaries(text: string): Uint32Array {
  if (ASCII_RE.test(text) && !text.includes('\r')) {
    const out = new Uint32Array(text.length + 1);
    for (let i = 0; i <= text.length; i++) out[i] = i;
    return out;
  }
  const chunks: Uint32Array[] = [];
  let total = 0;
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const b = lineBoundaries(text.slice(lineStart, lineEnd));
    // drop the leading 0 of every line but the first: it equals the previous line's end + 1 ('\n' is a boundary on both sides)
    const from = lineStart === 0 ? 0 : 1;
    const part = new Uint32Array(b.length - from + (nl === -1 ? 0 : 1));
    let k = 0;
    for (let i = from; i < b.length; i++) part[k++] = (b[i] ?? 0) + lineStart;
    if (nl !== -1) part[k++] = nl + 1;
    chunks.push(part);
    total += part.length;
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  const out = new Uint32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** `[start, end)` of the logical line containing `pos` (`end` is the '\n' index or the text length). `lastIndexOf` treats a negative fromIndex as 0, so pos 0 is special-cased. */
function lineRange(text: string, pos: number): { start: number; end: number } {
  const start = pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', Math.max(0, pos));
  return { start, end: nl === -1 ? text.length : nl };
}

/** Largest grapheme boundary strictly before `pos` on its logical line, or the '\n' before the line when `pos` is at the line start. */
function prevGrapheme(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const { start, end } = lineRange(text, pos);
  if (pos === start) return start - 1; // over the '\n'
  const line = text.slice(start, end);
  if (ASCII_RE.test(line)) return pos - 1;
  const b = lineBoundaries(line);
  const rel = pos - start;
  let lo = 0;
  let hi = b.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = b[mid] ?? 0;
    if (v < rel) {
      best = v;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return start + best;
}

/** Smallest grapheme boundary strictly after `pos` on its logical line, or past the '\n' when `pos` is at the line end. */
function nextGrapheme(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const { start, end } = lineRange(text, pos);
  if (pos === end) return end + 1; // over the '\n'
  const line = text.slice(start, end);
  if (ASCII_RE.test(line)) return pos + 1;
  const b = lineBoundaries(line);
  const rel = pos - start;
  let lo = 0;
  let hi = b.length - 1;
  let best = end - start;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = b[mid] ?? 0;
    if (v > rel) {
      best = v;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return start + best;
}

/** True when `pos` is on a grapheme boundary of `text` (TUI-DESIGN §4.1: the cursor moves only through grapheme boundaries). */
export function isGraphemeBoundary(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return pos === 0 || pos === text.length;
  if (text[pos] === '\n' || text[pos - 1] === '\n') return true;
  const { start, end } = lineRange(text, pos);
  const line = text.slice(start, end);
  if (ASCII_RE.test(line)) return true;
  const b = lineBoundaries(line);
  const rel = pos - start;
  let lo = 0;
  let hi = b.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = b[mid] ?? 0;
    if (v === rel) return true;
    if (v < rel) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** Word spans of one logical line: `isWordLike` segments split further at `/ - _ .` (TUI-DESIGN §4.1). Memoised per line. */
function lineWords(line: string): readonly Span[] {
  const hit = lineWordCache.get(line);
  if (hit !== undefined) return hit;
  const out: Span[] = [];
  for (const s of wordSegmenter().segment(line)) {
    if (s.isWordLike !== true) continue;
    let runStart = -1;
    for (let i = 0; i < s.segment.length; i++) {
      const ch = s.segment[i] ?? '';
      if (WORD_SEPARATORS.has(ch)) {
        if (runStart !== -1) out.push({ start: s.index + runStart, end: s.index + i });
        runStart = -1;
      } else if (runStart === -1) runStart = i;
    }
    if (runStart !== -1) out.push({ start: s.index + runStart, end: s.index + s.segment.length });
  }
  if (lineWordCache.size >= LINE_CACHE_MAX) lineWordCache.clear();
  lineWordCache.set(line, out);
  return out;
}

/**
 * Word motion target (TUI-DESIGN §4.1): dir −1 = the start of the word before `from` (readline backward-word),
 * dir 1 = the end of the word after `from`; crosses logical lines; 0 / `text.length` when no word remains.
 * Words are `Intl.Segmenter('word')` `isWordLike` segments with `/ - _ .` as extra separators.
 */
export function wordBoundary(text: string, from: number, dir: -1 | 1): number {
  let pos = Math.min(Math.max(0, Math.floor(from)), text.length);
  if (!Number.isFinite(pos)) pos = 0;
  return onGraphemeBoundary(text, rawWordBoundary(text, pos, dir), dir);
}

/** ICU's word segmenter can break inside a grapheme cluster (e.g. an LV syllable + trailing jamo); a word motion never may. */
function onGraphemeBoundary(text: string, pos: number, dir: -1 | 1): number {
  let p = pos;
  while (p > 0 && p < text.length && !isGraphemeBoundary(text, p)) p = dir === -1 ? prevGrapheme(text, p) : nextGrapheme(text, p);
  return p;
}

function rawWordBoundary(text: string, from: number, dir: -1 | 1): number {
  let pos = from;
  if (dir === -1) {
    for (;;) {
      const { start, end } = lineRange(text, pos);
      const words = lineWords(text.slice(start, end));
      let best = -1;
      for (const w of words) {
        if (start + w.start < pos) best = start + w.start;
        else break;
      }
      if (best !== -1) return best;
      if (start === 0) return 0;
      pos = start - 1;
    }
  }
  for (;;) {
    const { start, end } = lineRange(text, pos);
    const words = lineWords(text.slice(start, end));
    for (const w of words) {
      if (start + w.end > pos) return start + w.end;
    }
    if (end >= text.length) return text.length;
    pos = end + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Chips as atoms
// ---------------------------------------------------------------------------------------------

/** Every occurrence of every chip label in `text` as sorted, non-overlapping spans (TUI-DESIGN §4.1: chips are atomic). */
export function chipSpans(text: string, chips: readonly ChipRef[]): Span[] {
  if (chips.length === 0) return [];
  const found: Span[] = [];
  for (const c of chips) {
    if (c.label.length === 0) continue;
    let i = text.indexOf(c.label);
    while (i !== -1) {
      found.push({ start: i, end: i + c.label.length });
      i = text.indexOf(c.label, i + c.label.length);
    }
  }
  found.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of found) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start < last.end) {
      if (s.end > last.end) out[out.length - 1] = { start: last.start, end: s.end };
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Atomic spans of the buffer's chips, for `layoutRows`/`textUnits` (TUI-DESIGN §4.2). */
export function bufferAtoms(b: TextBuffer): Span[] {
  return chipSpans(b.text, b.chips);
}

function atomAround(atoms: readonly Span[], pos: number): Span | null {
  for (const a of atoms) {
    if (a.start < pos && pos < a.end) return a;
    if (a.start >= pos) break;
  }
  return null;
}

/** Move `pos` out of a chip interior towards `dir` (−1 = its start, 1 = its end). */
function snapOut(atoms: readonly Span[], pos: number, dir: -1 | 1): number {
  const a = atomAround(atoms, pos);
  return a === null ? pos : dir === -1 ? a.start : a.end;
}

/**
 * The buffer's boundary model (TUI-DESIGN §4.1): a chip is one atomic token, so its two ends are always legal cursor
 * positions and its interior never is; between chips the legal positions are the grapheme boundaries. A combining mark
 * typed right after a label therefore stands alone instead of gluing itself to the `]` — exactly how `textUnits` lays it out.
 */
export function isLegalCursor(text: string, pos: number, chips: readonly ChipRef[] = []): boolean {
  if (!Number.isInteger(pos) || pos < 0 || pos > text.length) return false;
  const atoms = chipSpans(text, chips);
  for (const a of atoms) {
    if (a.start === pos || a.end === pos) return true;
    if (a.start < pos && pos < a.end) return false;
  }
  return isGraphemeBoundary(text, pos);
}

/** Largest legal position strictly before `pos` (a whole chip counts as one unit; a chip end is never jumped over). */
function prevUnit(text: string, atoms: readonly Span[], pos: number): number {
  for (const a of atoms) if (a.end === pos) return a.start;
  let c = prevGrapheme(text, pos);
  for (const a of atoms) {
    if (a.end < pos && a.end > c) c = a.end; // the grapheme before `pos` began inside/at the label: stop at the label's end
    else if (a.start < c && c < a.end) c = a.start;
  }
  return c;
}

/** Smallest legal position strictly after `pos` (mirror of `prevUnit`). */
function nextUnit(text: string, atoms: readonly Span[], pos: number): number {
  for (const a of atoms) if (a.start === pos) return a.end;
  let c = nextGrapheme(text, pos);
  for (const a of atoms) {
    if (a.start > pos && a.start < c) c = a.start;
    else if (a.start < c && c < a.end) c = a.end;
  }
  return c;
}

/**
 * Nearest legal cursor position to `pos` (TUI-DESIGN §4.1): clamped, outside every chip, on a grapheme boundary of the
 * text between chips; `dir` −1 snaps backwards (the default, used after deletions and restores), 1 forwards (after an insertion).
 */
export function snapCursor(text: string, pos: number, chips: readonly ChipRef[] = [], dir: -1 | 1 = -1): number {
  const p = Number.isFinite(pos) ? Math.min(Math.max(0, Math.floor(pos)), text.length) : text.length;
  const atoms = chipSpans(text, chips);
  const inside = atomAround(atoms, p);
  if (inside !== null) return dir === -1 ? inside.start : inside.end;
  for (const a of atoms) if (a.start === p || a.end === p) return p;
  if (isGraphemeBoundary(text, p)) return p;
  return dir === -1 ? prevUnit(text, atoms, p) : nextUnit(text, atoms, p);
}

/** Live and retired ChipRefs of a buffer state (TUI-DESIGN §4.1). */
interface ChipSets {
  readonly chips: readonly ChipRef[];
  readonly retired: readonly ChipRef[];
}

/**
 * Split `candidates` (preferred order, duplicates by `n` resolved to the first) into the chips whose label occurs in
 * `text` and the retired ones that may still come back (TUI-DESIGN §4.1: a whole-chip deletion drops its ChipRef; a
 * label returning through yank / undo / `setText` re-adopts it). `retired` is capped at `RETIRED_MAX`.
 */
function partitionChips(text: string, candidates: readonly ChipRef[]): ChipSets {
  if (candidates.length === 0) return { chips: candidates, retired: candidates };
  const seen = new Set<number>();
  const chips: ChipRef[] = [];
  const retired: ChipRef[] = [];
  for (const c of candidates) {
    if (seen.has(c.n) || c.label.length === 0) continue;
    seen.add(c.n);
    (text.includes(c.label) ? chips : retired).push(c);
  }
  return { chips, retired: retired.length > RETIRED_MAX ? retired.slice(0, RETIRED_MAX) : retired };
}

/** `chips` then `retired` of `b`: the candidate order every edit re-partitions from. */
function allChips(b: Pick<TextBuffer, 'chips' | 'retired'>): readonly ChipRef[] {
  return b.retired.length === 0 ? b.chips : [...b.chips, ...b.retired];
}

/** `[Pasted #n, k lines]` → `[Pasted # n, k lines]`: still readable, never a chip (TUI-DESIGN §4.1, §4.5). */
export function defusedLabel(label: string): string {
  const hash = label.indexOf('#');
  return hash === -1 ? label.slice(0, 1) + ' ' + label.slice(1) : label.slice(0, hash + 1) + ' ' + label.slice(hash + 1);
}

/**
 * After inserting `len` code units at `at` into `text`, rewrite every live or retired chip label that overlaps the inserted
 * range (TUI-DESIGN §4.1, §4.5): such an occurrence was formed by this insert — pasted whole, or completed keystroke by
 * keystroke — because the cursor never sits inside an existing label. Existing labels touching the range at either end
 * are untouched. Returns the text and the cursor (`at + len`, shifted when a space landed before it).
 */
export function defuseInserted(text: string, at: number, len: number, chips: readonly ChipRef[]): { text: string; cursor: number } {
  let out = text;
  let cursor = at + len;
  if (chips.length === 0 || len === 0 || !text.includes('[')) return { text: out, cursor };
  for (const c of chips) {
    if (c.label.length === 0) continue;
    const d = defusedLabel(c.label);
    let i = out.indexOf(c.label, Math.max(0, at - c.label.length + 1));
    while (i !== -1 && i < cursor) {
      const occEnd = i + c.label.length;
      if (occEnd > at) {
        out = out.slice(0, i) + d + out.slice(occEnd);
        const hash = c.label.indexOf('#');
        const space = i + (hash === -1 ? 1 : hash + 1); // where `defusedLabel` put its space
        if (space <= cursor) cursor += d.length - c.label.length;
        i = out.indexOf(c.label, i + d.length);
      } else {
        i = out.indexOf(c.label, i + 1);
      }
    }
  }
  return { text: out, cursor };
}

// ---------------------------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------------------------

const LIVE_DRAFT: HistoryNav = { level: -1, stash: null, filter: 'workspace' };

/**
 * A fresh buffer (TUI-DESIGN §4.1); `killRing` (and `retired`, so a killed chip label yanked into the next draft is still
 * recognised and refused at submit rather than sent as text) may be carried over from the previous buffer so they survive submit.
 */
export function createBuffer(
  init: { text?: string; cursor?: number; killRing?: readonly string[]; chips?: readonly ChipRef[]; retired?: readonly ChipRef[]; filter?: HistoryFilter } = {},
): TextBuffer {
  const text = normaliseText(init.text ?? '');
  const sets = partitionChips(text, [...(init.chips ?? []), ...(init.retired ?? [])]);
  return {
    text,
    cursor: snapCursor(text, init.cursor ?? text.length, sets.chips),
    preferredX: null,
    killRing: (init.killRing ?? []).slice(0, KILL_RING_MAX),
    yankIndex: null,
    lastKill: null,
    undo: [],
    redo: [],
    coalescing: false,
    lastEditMs: 0,
    chips: sets.chips,
    retired: sets.retired,
    history: { ...LIVE_DRAFT, filter: init.filter ?? 'workspace' },
  };
}

/** The undo unit of the current state (TUI-DESIGN §4.1). */
export function snapshotOf(b: Pick<TextBuffer, 'text' | 'cursor' | 'chips'>): Snapshot {
  return { text: b.text, cursor: b.cursor, chips: b.chips };
}

function pushUndo(b: TextBuffer): readonly Snapshot[] {
  const next = [...b.undo, snapshotOf(b)];
  return next.length > UNDO_MAX ? next.slice(next.length - UNDO_MAX) : next;
}

/** Common bookkeeping after an edit that is its own undo step: redo cleared, coalescing ended, yank/kill chains broken; history browsing state untouched (§4.6). */
function edited(b: TextBuffer, text: string, cursor: number, undo: readonly Snapshot[], extra: Partial<TextBuffer> = {}, dir: -1 | 1 = -1): TextBuffer {
  const sets = partitionChips(text, allChips(b));
  return {
    ...b,
    text,
    cursor: snapCursor(text, cursor, sets.chips, dir),
    preferredX: null,
    yankIndex: null,
    lastKill: null,
    undo,
    redo: [],
    coalescing: false,
    chips: sets.chips,
    retired: sets.retired,
    ...extra,
  };
}

/** A motion: nothing changes but the cursor; every chain (coalescing, kill, yank) ends. */
function moved(b: TextBuffer, cursor: number, preferredX: number | null = null): TextBuffer {
  if (cursor === b.cursor && preferredX === b.preferredX && !b.coalescing && b.lastKill === null && b.yankIndex === null) return b;
  return { ...b, cursor, preferredX, coalescing: false, lastKill: null, yankIndex: null };
}

function countGraphemes(s: string, max: number): number {
  if (ASCII_RE.test(s)) return s.length;
  let n = 0;
  for (const _ of graphemeSegmenter().segment(s)) {
    n++;
    if (n >= max) break;
  }
  return n;
}

function isWhitespace(s: string): boolean {
  return /^\s+$/.test(s);
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

function insertText(b: TextBuffer, raw: string, paste: boolean, nowMs: number): TextBuffer {
  const text = normaliseText(raw);
  if (text.length === 0) return b;
  const atoms = bufferAtoms(b);
  const at = snapOut(atoms, b.cursor, 1);
  const { text: next, cursor } = defuseInserted(b.text.slice(0, at) + text + b.text.slice(at), at, text.length, allChips(b));
  if (paste || text.includes('\n') || countGraphemes(text, 2) !== 1) {
    return edited(b, next, cursor, pushUndo(b), { lastEditMs: nowMs }, 1);
  }
  // single grapheme: coalesce with the running step unless a boundary condition ended it
  const idle = !Number.isFinite(nowMs) || nowMs - b.lastEditMs > COALESCE_IDLE_MS;
  const undo = b.coalescing && !idle ? b.undo : pushUndo(b);
  const sets = partitionChips(next, allChips(b));
  return {
    ...b,
    text: next,
    cursor: snapCursor(next, cursor, sets.chips, 1),
    preferredX: null,
    yankIndex: null,
    lastKill: null,
    undo,
    redo: [],
    coalescing: !isWhitespace(text),
    lastEditMs: nowMs,
    chips: sets.chips,
    retired: sets.retired,
  };
}

function removeSpan(b: TextBuffer, from: number, to: number, extra: Partial<TextBuffer> = {}): TextBuffer {
  if (to <= from) return b;
  const next = b.text.slice(0, from) + b.text.slice(to);
  return edited(b, next, from, pushUndo(b), extra);
}

/** Visual rows of one logical line `[start, end)` in absolute offsets (TUI-DESIGN §4.1: Segmenter cost is per logical line). */
function rowsOfLine(text: string, start: number, end: number, columns: number, atoms: readonly Span[]): Row[] {
  const local = atoms.filter((a) => a.end > start && a.start < end).map((a) => ({ start: Math.max(a.start, start) - start, end: Math.min(a.end, end) - start }));
  return layoutRows(text.slice(start, end), columns, DEFAULT_GUTTER, { atoms: local }).map((r) => ({ ...r, start: r.start + start, end: r.end + start }));
}

/**
 * ↑/↓ by visual row with a sticky column (TUI-DESIGN §4.1 `preferredX`): lays out only the cursor's logical line and,
 * when the cursor sits on its first/last row, the neighbouring logical line — never the whole draft.
 */
function moveVertical(b: TextBuffer, dir: -1 | 1, columns: number): TextBuffer {
  const atoms = bufferAtoms(b);
  const { start, end } = lineRange(b.text, b.cursor);
  const rows = rowsOfLine(b.text, start, end, columns, atoms);
  const { row, x } = cursorToRowX(rows, b.text, b.cursor);
  const wantX = b.preferredX ?? x;
  let target: Row | undefined = rows[row + dir];
  if (target === undefined) {
    if (dir === -1) {
      if (start === 0) return moved(b, b.cursor, wantX);
      const prev = lineRange(b.text, start - 1);
      const prevRows = rowsOfLine(b.text, prev.start, prev.end, columns, atoms);
      target = prevRows[prevRows.length - 1];
    } else {
      if (end >= b.text.length) return moved(b, b.cursor, wantX);
      const next = lineRange(b.text, end + 1);
      target = rowsOfLine(b.text, next.start, next.end, columns, atoms)[0];
    }
  }
  if (target === undefined) return moved(b, b.cursor, wantX);
  const units = textUnits(b.text, target.start, target.end, atoms);
  let pos = target.start;
  let acc = 0;
  for (const u of units) {
    if (acc + u.cells > wantX) break;
    acc += u.cells;
    pos = u.at + u.len;
  }
  // on a soft row the row end is the first cell of the next row; stay on the target row's last unit instead
  if (!target.hard && pos === target.end && units.length > 0) {
    const last = units[units.length - 1];
    if (last !== undefined) pos = last.at;
  }
  return moved(b, snapOut(atoms, pos, -1), wantX);
}

function move(b: TextBuffer, to: Motion, columns: number): TextBuffer {
  const atoms = bufferAtoms(b);
  switch (to) {
    case 'left':
      return moved(b, b.cursor === 0 ? 0 : prevUnit(b.text, atoms, b.cursor));
    case 'right':
      return moved(b, b.cursor >= b.text.length ? b.text.length : nextUnit(b.text, atoms, b.cursor));
    case 'home':
      return moved(b, snapOut(atoms, lineRange(b.text, b.cursor).start, -1));
    case 'end':
      return moved(b, snapOut(atoms, lineRange(b.text, b.cursor).end, 1));
    case 'wordLeft':
      return moved(b, snapOut(atoms, wordBoundary(b.text, b.cursor, -1), -1));
    case 'wordRight':
      return moved(b, snapOut(atoms, wordBoundary(b.text, b.cursor, 1), 1));
    case 'start':
      return moved(b, 0);
    case 'finish':
      return moved(b, b.text.length);
    case 'up':
      return moveVertical(b, -1, columns);
    case 'down':
      return moveVertical(b, 1, columns);
  }
}

function kill(b: TextBuffer, what: 'toEnd' | 'toStart' | 'wordBack' | 'wordForward'): TextBuffer {
  const atoms = bufferAtoms(b);
  const { start, end } = lineRange(b.text, b.cursor);
  let from = b.cursor;
  let to = b.cursor;
  let forward = true;
  switch (what) {
    case 'toEnd':
      to = b.cursor === end && end < b.text.length ? end + 1 : end;
      break;
    case 'toStart':
      from = start;
      forward = false;
      break;
    case 'wordBack':
      from = wordBoundary(b.text, b.cursor, -1);
      forward = false;
      break;
    case 'wordForward':
      to = wordBoundary(b.text, b.cursor, 1);
      break;
  }
  from = snapOut(atoms, from, -1);
  to = snapOut(atoms, to, 1);
  if (to <= from) return b;
  const killed = b.text.slice(from, to);
  const how = b.lastKill === null ? 'unshift' : forward ? 'append' : 'prepend';
  const killRing = pushKill(b.killRing, killed, how);
  return removeSpan(b, from, to, { killRing, lastKill: forward ? 'append' : 'prepend' });
}

function yank(b: TextBuffer): TextBuffer {
  const head = b.killRing[0];
  if (head === undefined || head.length === 0) return b;
  const atoms = bufferAtoms(b);
  const at = snapOut(atoms, b.cursor, 1);
  const next = b.text.slice(0, at) + head + b.text.slice(at);
  return edited(b, next, at + head.length, pushUndo(b), { yankIndex: 0 }, 1);
}

function yankPop(b: TextBuffer): TextBuffer {
  if (b.yankIndex === null || b.killRing.length === 0) return b;
  const current = b.killRing[b.yankIndex];
  if (current === undefined) return b;
  const from = b.cursor - current.length;
  if (from < 0 || b.text.slice(from, b.cursor) !== current) return b;
  const idx = nextYankIndex(b.killRing, b.yankIndex);
  if (idx === null) return b;
  const replacement = b.killRing[idx] ?? '';
  const next = b.text.slice(0, from) + replacement + b.text.slice(b.cursor);
  // a rotation amends the yank: no new undo step (undo returns to the pre-yank text, as in Emacs)
  const sets = partitionChips(next, allChips(b));
  return { ...b, text: next, cursor: from + replacement.length, chips: sets.chips, retired: sets.retired, yankIndex: idx, preferredX: null, coalescing: false, lastKill: null };
}

function transpose(b: TextBuffer): TextBuffer {
  const atoms = bufferAtoms(b);
  const { start, end } = lineRange(b.text, b.cursor);
  const atLineEnd = b.cursor >= end;
  let aStart: number;
  let aEnd: number;
  let cStart: number;
  let cEnd: number;
  if (atLineEnd) {
    // act on the two units before the cursor
    cEnd = b.cursor;
    cStart = prevUnit(b.text, atoms, cEnd);
    if (cStart < start || cStart === cEnd) return b;
    aEnd = cStart;
    aStart = prevUnit(b.text, atoms, aEnd);
    if (aStart < start || aStart === aEnd) return b;
  } else {
    aEnd = b.cursor;
    aStart = prevUnit(b.text, atoms, aEnd);
    if (aStart < start || aStart === aEnd) return b;
    cStart = b.cursor;
    cEnd = nextUnit(b.text, atoms, cStart);
    if (cEnd > end || cEnd === cStart) return b;
  }
  const a = b.text.slice(aStart, aEnd);
  const c = b.text.slice(cStart, cEnd);
  const next = b.text.slice(0, aStart) + c + a + b.text.slice(cEnd);
  return edited(b, next, cEnd, pushUndo(b));
}

function restore(b: TextBuffer, snap: Snapshot, undo: readonly Snapshot[], redo: readonly Snapshot[]): TextBuffer {
  const text = normaliseText(snap.text);
  const sets = partitionChips(text, [...(snap.chips ?? []), ...allChips(b)]);
  return {
    ...b,
    text,
    cursor: snapCursor(text, snap.cursor, sets.chips),
    preferredX: null,
    yankIndex: null,
    lastKill: null,
    undo,
    redo,
    coalescing: false,
    chips: sets.chips,
    retired: sets.retired,
  };
}

function undo(b: TextBuffer): TextBuffer {
  const snap = b.undo[b.undo.length - 1];
  if (snap === undefined) return b;
  const redo = [...b.redo, snapshotOf(b)];
  return restore(b, snap, b.undo.slice(0, -1), redo.length > UNDO_MAX ? redo.slice(redo.length - UNDO_MAX) : redo);
}

function redo(b: TextBuffer): TextBuffer {
  const snap = b.redo[b.redo.length - 1];
  if (snap === undefined) return b;
  return restore(b, snap, pushUndo(b), b.redo.slice(0, -1));
}

function setText(b: TextBuffer, raw: string, cursor: number | undefined, push: boolean): TextBuffer {
  const text = normaliseText(raw);
  const sets = partitionChips(text, allChips(b));
  const c = snapCursor(text, cursor ?? text.length, sets.chips);
  if (push) return edited(b, text, c, pushUndo(b));
  return { ...b, text, cursor: c, chips: sets.chips, retired: sets.retired, preferredX: null, yankIndex: null, lastKill: null, coalescing: false };
}

/** Ctrl-C / Esc Esc (TUI-DESIGN §4.1, §4.6): one undo snapshot, every ChipRef forgotten, history browsing abandoned (the draft stays two undos away). */
function clear(b: TextBuffer): TextBuffer {
  const history: HistoryNav = b.history.level === -1 ? b.history : { ...LIVE_DRAFT, filter: b.history.filter };
  if (b.text.length === 0 && b.chips.length === 0) {
    const m = moved(b, 0);
    return b.retired.length === 0 && history === b.history ? m : { ...m, retired: [], history };
  }
  return { ...edited(b, '', 0, pushUndo(b)), chips: [], retired: [], history };
}

function insertChip(b: TextBuffer, chip: ChipRef): TextBuffer {
  if (chip.label.length === 0) return b;
  const atoms = bufferAtoms(b);
  const at = snapOut(atoms, b.cursor, 1);
  const next = b.text.slice(0, at) + chip.label + b.text.slice(at);
  const chips = [...b.chips.filter((c) => c.n !== chip.n), chip];
  const withChips: TextBuffer = { ...b, chips };
  return edited(withChips, next, at + chip.label.length, pushUndo(b), {}, 1);
}

/** Return to the live draft (level −1) from any history level, restoring the stashed draft; `undo`/`redo` as the caller decided. */
function restoreStash(b: TextBuffer, undo: readonly Snapshot[] = b.undo, redo: readonly Snapshot[] = b.redo): TextBuffer {
  if (b.history.level === -1) return b;
  const stash = b.history.stash ?? { text: '', cursor: 0, chips: [] };
  const text = normaliseText(stash.text);
  const sets = partitionChips(text, [...(stash.chips ?? []), ...allChips(b)]);
  return {
    ...b,
    text,
    cursor: snapCursor(text, stash.cursor, sets.chips),
    preferredX: null,
    yankIndex: null,
    lastKill: null,
    undo,
    redo,
    coalescing: false,
    chips: sets.chips,
    retired: sets.retired,
    history: { ...b.history, level: -1, stash: null },
  };
}

/** Show history entry `level` (0 = newest) with the cursor at its end; `undo`/`redo`/`stash` as the caller decided. */
function showEntry(b: TextBuffer, entry: string, level: number, stash: Snapshot | null, undo: readonly Snapshot[], redo: readonly Snapshot[]): TextBuffer {
  const text = normaliseText(entry);
  const sets = partitionChips(text, allChips(b));
  return {
    ...b,
    text,
    cursor: snapCursor(text, text.length, sets.chips),
    preferredX: null,
    yankIndex: null,
    lastKill: null,
    undo,
    redo,
    coalescing: false,
    chips: sets.chips,
    retired: sets.retired,
    history: { ...b.history, level, stash },
  };
}

/**
 * Undo/redo stacks to carry when leaving history level ≥ 0 (TUI-DESIGN §4.6, §4.7): an entry the user edited in place
 * is snapshotted once so Ctrl+_ can bring the edit back; an untouched entry leaves the stacks alone.
 */
function leavingLevel(b: TextBuffer, shown: string | undefined): { undo: readonly Snapshot[]; redo: readonly Snapshot[] } {
  const dirty = shown === undefined || normaliseText(shown) !== b.text;
  return dirty ? { undo: pushUndo(b), redo: [] } : { undo: b.undo, redo: b.redo };
}

function history(b: TextBuffer, dir: -1 | 1, entries: readonly string[]): TextBuffer {
  const level = b.history.level;
  const entryAt = (lvl: number): string | undefined => entries[entries.length - 1 - lvl];
  if (dir === 1) {
    const entry = entryAt(level + 1);
    if (entry === undefined) return b;
    // leaving the live draft stashes it and is the one undo step of the whole recall (§4.7)
    if (level === -1) return showEntry(b, entry, 0, snapshotOf(b), pushUndo(b), []);
    const stacks = leavingLevel(b, entryAt(level));
    return showEntry(b, entry, level + 1, b.history.stash, stacks.undo, stacks.redo);
  }
  if (level === -1) return b;
  const stacks = leavingLevel(b, entryAt(level));
  if (level === 0) return restoreStash(b, stacks.undo, stacks.redo);
  const entry = entryAt(level - 1);
  if (entry === undefined) return restoreStash(b, stacks.undo, stacks.redo);
  return showEntry(b, entry, level - 1, b.history.stash, stacks.undo, stacks.redo);
}

/** Ctrl-A in Ctrl-R widens (TUI-DESIGN §4.6): back to the live draft with the new filter; like every action, it ends the kill/yank/coalescing chains. */
function historyFilter(b: TextBuffer, filter: HistoryFilter): TextBuffer {
  const live = restoreStash(b);
  const chained = live.coalescing || live.lastKill !== null || live.yankIndex !== null;
  if (live === b && live.history.filter === filter && !chained) return b;
  return { ...live, coalescing: false, lastKill: null, yankIndex: null, history: live.history.filter === filter ? live.history : { ...live.history, filter } };
}

/**
 * The composer reducer (TUI-DESIGN §4.1, §4.7): pure over `(buffer, action, nowMs)`; `nowMs` only feeds the 2 s
 * insert-coalescing idle rule and defaults to 0 (never idle) so callers without a clock still get correct text.
 */
export function reduceBuffer(b: TextBuffer, a: BufferAction, nowMs: number = 0): TextBuffer {
  switch (a.type) {
    case 'insert':
      return insertText(b, a.text, a.paste === true, nowMs);
    case 'newline':
      return insertText(b, '\n', true, nowMs);
    case 'backspace': {
      if (b.cursor <= 0) return moved(b, 0);
      const atoms = bufferAtoms(b);
      return removeSpan(b, prevUnit(b.text, atoms, b.cursor), b.cursor);
    }
    case 'delete': {
      if (b.cursor >= b.text.length) return moved(b, b.text.length);
      const atoms = bufferAtoms(b);
      return removeSpan(b, b.cursor, nextUnit(b.text, atoms, b.cursor));
    }
    case 'move':
      return move(b, a.to, a.columns);
    case 'kill':
      return kill(b, a.what);
    case 'yank':
      return yank(b);
    case 'yankPop':
      return yankPop(b);
    case 'transpose':
      return transpose(b);
    case 'undo':
      return undo(b);
    case 'redo':
      return redo(b);
    case 'setText':
      return setText(b, a.text, a.cursor, a.pushUndo);
    case 'clear':
      return clear(b);
    case 'chip':
      return insertChip(b, a.chip);
    case 'history':
      return history(b, a.dir, a.entries);
    case 'historyFilter':
      return historyFilter(b, a.filter);
  }
}
