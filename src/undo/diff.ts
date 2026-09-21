/**
 * `/diff` rendering (TUI-DESIGN §12.6, D9) — pure.
 *
 * `diffStatBlock` turns `git diff --numstat -z` output (plus the untracked `--no-index` rows, the run-start dirty
 * set and the submodule list) into the inline block: header, one row per file with the letter `M/A/D/R/?/B/S`,
 * `+n −m`, a ≤ 10-cell bar, `†` for paths dirty before the run, the legend, and the 40-row cap.
 * `diffStepLines` renders `/diff <step>` from pre/post images with a dependency-free Myers line diff.
 *
 * Cell widths come from O2's `src/tui/composer/width.ts` (§4.2, string-width-identical); the helpers at the bottom
 * add the left-truncation and padding the diff rows need on top of `stringWidth` / `truncateCells`.
 */
import { cellWidth, stringWidth, truncateCells } from '../tui/composer/width.js';

// ---------------------------------------------------------------------------------------
// Constants (TUI-DESIGN §12.6)
// ---------------------------------------------------------------------------------------

/** Rows shown before `… N more files (/diff --all)`. */
export const DIFF_ROW_CAP = 40;
/** Bar cells, scaled to the largest row. */
export const DIFF_BAR_CELLS = 10;
/** Unborn repositories diff against the empty tree. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Untracked files get a `--no-index` numstat each, up to this many; the rest are listed `?` with sizes. */
export const DIFF_UNTRACKED_NUMSTAT_MAX = 20;
/** `/diff --full` without a pager, and `/diff <step>`, are capped at this many lines inline. */
export const DIFF_INLINE_MAX_LINES = 400;
/** Files larger than this are not diffed line by line. */
export const DIFF_MAX_FILE_BYTES = 1024 * 1024;
/** The path column is `columns − 32` cells wide. */
export const DIFF_PATH_MARGIN = 32;
export const DIFF_LEGEND = '† also modified before this run';

// ---------------------------------------------------------------------------------------
// --numstat -z parser
// ---------------------------------------------------------------------------------------

export interface NumstatRow {
  path: string;
  /** rename / copy source */
  from: string | null;
  /** null for binary rows (`-\t-`) */
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

function count(s: string): number | null {
  if (s === '-') return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * TUI-DESIGN §12.6: parse `git diff --numstat -z`. Records are `added TAB deleted TAB path NUL`; renames/copies are
 * `added TAB deleted TAB NUL from NUL to NUL`; binaries carry `-` for both counts. Torn or foreign trailing input is
 * dropped, never thrown on.
 */
export function parseNumstatZ(text: string): NumstatRow[] {
  const out: NumstatRow[] = [];
  if (text.length === 0) return out;
  const tokens = text.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? '';
    if (tok.length === 0) continue;
    const t1 = tok.indexOf('\t');
    if (t1 < 0) continue;
    const t2 = tok.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const a = tok.slice(0, t1);
    const d = tok.slice(t1 + 1, t2);
    const rest = tok.slice(t2 + 1);
    const added = count(a);
    const deleted = count(d);
    const binary = a === '-' && d === '-';
    if (!binary && (added === null || deleted === null)) continue;
    if (rest.length > 0) {
      out.push({ path: rest, from: null, added, deleted, binary });
      continue;
    }
    // rename: the two following NUL-separated tokens are from / to
    const from = tokens[i + 1];
    const to = tokens[i + 2];
    if (from === undefined || to === undefined || to.length === 0) break;
    out.push({ path: to, from, added, deleted, binary });
    i += 2;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Rows and the block
// ---------------------------------------------------------------------------------------

export type DiffLetter = 'M' | 'A' | 'D' | 'R' | '?' | 'B' | 'S';

export interface DiffStatRow {
  letter: DiffLetter;
  path: string;
  from: string | null;
  added: number;
  deleted: number;
  binary: boolean;
  /** `†`: also modified before this run */
  dirtyBefore: boolean;
  /** untracked rows past the `--no-index` budget carry their size instead of counts */
  bytes: number | null;
}

export interface DiffStatInput {
  runId: string;
  /** `git diff --numstat -z HEAD -- <changedFiles>` stdout (or against EMPTY_TREE_OID when unborn) */
  numstat: string;
  /** one entry per untracked file: its `--no-index` numstat when one was spawned (first 20), else its size */
  untracked?: readonly { path: string; numstat?: string; bytes?: number }[];
  /** paths dirty before the run (the run-start snapshot) → `†` */
  dirtyAtStart?: ReadonlySet<string>;
  /** files the run created (`A`) */
  created?: ReadonlySet<string>;
  /** files that no longer exist (`D`) */
  deleted?: ReadonlySet<string>;
  /** submodule paths (`S`, one row each) */
  submodules?: ReadonlySet<string>;
  /** files excluded from the diff (> 1 MiB, unreadable) */
  skipped?: readonly { path: string; reason: string }[];
  /** `--all`: lift the row cap */
  all?: boolean;
}

export interface DiffStatSummary {
  files: number;
  added: number;
  deleted: number;
  untracked: number;
  binary: number;
  skipped: number;
}

function letterFor(row: NumstatRow, input: DiffStatInput, untracked: boolean): DiffLetter {
  if (input.submodules?.has(row.path)) return 'S';
  if (untracked) return '?';
  if (row.from !== null) return 'R';
  if (row.binary) return 'B';
  if (input.deleted?.has(row.path)) return 'D';
  if (input.created?.has(row.path)) return 'A';
  return 'M';
}

/** TUI-DESIGN §12.6: the typed rows and the header counts behind `diffStatBlock`. */
export function diffStatRows(input: DiffStatInput): { rows: DiffStatRow[]; summary: DiffStatSummary } {
  const rows: DiffStatRow[] = [];
  const seen = new Set<string>();
  const dirty = input.dirtyAtStart ?? new Set<string>();
  for (const r of parseNumstatZ(input.numstat)) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    rows.push({ letter: letterFor(r, input, false), path: r.path, from: r.from, added: r.added ?? 0, deleted: r.deleted ?? 0, binary: r.binary, dirtyBefore: dirty.has(r.path) || (r.from !== null && dirty.has(r.from)), bytes: null });
  }
  let untrackedCount = 0;
  for (const u of input.untracked ?? []) {
    if (seen.has(u.path)) continue;
    seen.add(u.path);
    untrackedCount += 1;
    const parsed = u.numstat !== undefined ? parseNumstatZ(u.numstat) : [];
    const first = parsed[0];
    const binary = first?.binary ?? false;
    rows.push({
      letter: input.submodules?.has(u.path) ? 'S' : '?',
      path: u.path,
      from: null,
      added: first?.added ?? 0,
      deleted: first?.deleted ?? 0,
      binary,
      dirtyBefore: dirty.has(u.path),
      bytes: first === undefined && typeof u.bytes === 'number' ? u.bytes : null,
    });
  }
  const summary: DiffStatSummary = {
    files: rows.length,
    added: rows.reduce((n, r) => n + r.added, 0),
    deleted: rows.reduce((n, r) => n + r.deleted, 0),
    untracked: untrackedCount,
    binary: rows.filter((r) => r.binary).length,
    skipped: input.skipped?.length ?? 0,
  };
  return { rows, summary };
}

/** `diff (run <id> · N files · +a −b · c untracked · d binary · e skipped)` (TUI-DESIGN §12.6, §24). */
export function diffStatHeader(runId: string, s: DiffStatSummary): string {
  return `diff (run ${runId} · ${s.files} files · +${s.added} −${s.deleted} · ${s.untracked} untracked · ${s.binary} binary · ${s.skipped} skipped)`;
}

/** TUI-DESIGN §12.6: a ≤ `cells` bar of `+` then `-`, scaled to `maxTotal`; each non-zero side keeps at least one cell when there is room. */
export function diffBar(added: number, deleted: number, maxTotal: number, cells = DIFF_BAR_CELLS): string {
  if (cells <= 0 || maxTotal <= 0 || !Number.isFinite(maxTotal)) return '';
  const a = Math.max(0, added);
  const d = Math.max(0, deleted);
  if (a + d === 0) return '';
  const scale = cells / Math.max(maxTotal, a + d);
  let plus = Math.round(a * scale);
  let minus = Math.round(d * scale);
  if (a > 0 && plus === 0) plus = 1;
  if (d > 0 && minus === 0) minus = 1;
  while (plus + minus > cells) {
    if (plus >= minus && plus > (a > 0 ? 1 : 0)) plus -= 1;
    else if (minus > (d > 0 ? 1 : 0)) minus -= 1;
    else break;
  }
  return '+'.repeat(plus) + '-'.repeat(minus);
}

/** TUI-DESIGN §12.6: `1.2 KiB` style sizes for the untracked rows past the numstat budget. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n < 1024) return `${Math.floor(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${units[i]}`;
}

function countsText(r: DiffStatRow): string {
  if (r.bytes !== null) return formatBytes(r.bytes);
  if (r.binary) return 'bin';
  return `${`+${r.added}`.padStart(6)} ${`−${r.deleted}`.padEnd(6)}`;
}

/** The counts without padding, for rows under 40 columns. */
function compactCountsText(r: DiffStatRow): string {
  if (r.bytes !== null) return formatBytes(r.bytes);
  if (r.binary) return 'bin';
  return `+${r.added} −${r.deleted}`;
}

/** Below this many columns the bar is dropped (TUI-DESIGN §2.1: every row is cut by the pure function, never by Ink). */
export const DIFF_BAR_MIN_COLUMNS = 52;
/** Below this many columns the counts lose their padding. */
export const DIFF_PADDED_COUNTS_MIN_COLUMNS = 40;

/**
 * TUI-DESIGN §12.6 / §24: the inline `/diff` block. Header, rows ` M src/a.py            +120 −12  ++++++++--`
 * (path left-truncated by grapheme to `columns − 32`, `†` after paths dirty before the run), the `†` legend when
 * any, skipped files, and `… N more files (/diff --all)` past 40 rows unless `all`. Below 52 columns the bar is
 * dropped, below 40 the counts are compact, and every row is finally cut to `columns` cells (§2.1). Colour is the
 * renderer's (additive only; the signs carry the meaning).
 */
export function diffStatBlock(input: DiffStatInput, columns: number): string[] {
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const { rows, summary } = diffStatRows(input);
  const lines: string[] = [diffStatHeader(input.runId, summary)];
  const withBar = cols >= DIFF_BAR_MIN_COLUMNS;
  const padded = cols >= DIFF_PADDED_COUNTS_MIN_COLUMNS;
  const shown = input.all ? rows : rows.slice(0, DIFF_ROW_CAP);
  const counts = shown.map((r) => (padded ? countsText(r) : compactCountsText(r)));
  const countsWidth = counts.reduce((m, c) => Math.max(m, stringCells(c)), 0);
  // §12.6: the path column is `columns − 32` with the bar; without it the margin is what the letter, gaps and counts need
  const margin = withBar ? DIFF_PATH_MARGIN : 5 + countsWidth;
  const pathWidth = Math.max(8, cols - margin);
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.added + r.deleted), 0);
  shown.forEach((r, i) => {
    const label = r.from !== null ? `${r.from} → ${r.path}` : r.path;
    const mark = r.dirtyBefore ? '†' : '';
    const path = truncateLeftCells(label, pathWidth - stringCells(mark)) + mark;
    const bar = withBar && !r.binary && r.bytes === null ? diffBar(r.added, r.deleted, maxTotal) : '';
    lines.push(` ${r.letter} ${padEndCells(path, pathWidth)}  ${padEndCells(counts[i] ?? '', countsWidth)}  ${bar}`.trimEnd());
  });
  if (shown.some((r) => r.dirtyBefore)) lines.push(DIFF_LEGEND);
  for (const s of input.skipped ?? []) lines.push(`   skipped ${s.path}: ${s.reason}`);
  if (shown.length < rows.length) lines.push(`… ${rows.length - shown.length} more files (/diff --all)`);
  return lines.map((l) => truncateRightCells(l, cols));
}

// ---------------------------------------------------------------------------------------
// Line diff (Myers, O((N+M)·D), bounded)
// ---------------------------------------------------------------------------------------

export type DiffOp = { op: 'eq' | 'del' | 'ins'; line: string };

/** Beyond this edit distance the diff degrades to "everything removed, everything added" (memory bound ≈ D² ints). */
export const DIFF_MAX_D = 1500;

/**
 * TUI-DESIGN §12.6: split into lines for diffing; `noEol` records a missing trailing newline so the diff can
 * print `\ No newline at end of file` like git does.
 */
export function splitLines(text: string): { lines: string[]; noEol: boolean } {
  if (text.length === 0) return { lines: [], noEol: false };
  const lines = text.split('\n');
  const noEol = !text.endsWith('\n');
  if (!noEol) lines.pop();
  return { lines, noEol };
}

function myers(a: readonly string[], b: readonly string[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, maxD);
  const offset = limit + 1;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * offset + 1);
  v[offset + 1] = 0;
  for (let d = 0; d <= limit; d++) {
    const snapshot = new Int32Array(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
  }
  return null;
}

function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[], offset: number, dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: 'eq', line: a[x]! });
    }
    if (x === prevX) {
      y--;
      ops.push({ op: 'ins', line: b[y]! });
    } else {
      x--;
      ops.push({ op: 'del', line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: 'eq', line: a[x]! });
  }
  ops.reverse();
  return ops;
}

/**
 * TUI-DESIGN §12.6: a dependency-free line diff (Myers) with common prefix/suffix trimming; past `maxD` edits
 * it returns the whole-file replacement so memory stays bounded. Applying the ops to `a` always yields `b`.
 */
export function lineDiff(a: readonly string[], b: readonly string[], maxD = DIFF_MAX_D): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = a.slice(0, start).map((line) => ({ op: 'eq', line }));
  const tail: DiffOp[] = a.slice(endA).map((line) => ({ op: 'eq', line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid = myers(midA, midB, Math.max(0, maxD)) ?? [...midA.map((line): DiffOp => ({ op: 'del', line })), ...midB.map((line): DiffOp => ({ op: 'ins', line }))];
  return [...head, ...mid, ...tail];
}

/** Added / deleted line counts for the non-git `/diff` fallback (TUI-DESIGN §12.6). */
export function lineDiffCounts(a: string, b: string): { added: number; deleted: number } {
  const ops = lineDiff(splitLines(a).lines, splitLines(b).lines);
  let added = 0;
  let deleted = 0;
  for (const o of ops) {
    if (o.op === 'ins') added++;
    else if (o.op === 'del') deleted++;
  }
  return { added, deleted };
}

export interface UnifiedDiffOptions {
  aPath: string;
  bPath: string;
  /** context lines per hunk side (default 3) */
  context?: number;
  maxD?: number;
}

const NO_EOL = '\\ No newline at end of file';
/** Appended to a last line that has no trailing newline so the line diff sees it as a different line (git's rule). */
const NOEOL_MARK = '\u0000\u0000noeol';

function taggedLines(text: string): string[] {
  const { lines, noEol } = splitLines(text);
  if (noEol && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]!}${NOEOL_MARK}`;
  return lines;
}

function hunkRange(start: number, len: number): string {
  // unified format: `start,len`; `len` omitted when 1; an empty side reports the line before it
  if (len === 0) return `${start},0`;
  return len === 1 ? `${start + 1}` : `${start + 1},${len}`;
}

function pushLine(out: string[], sign: string, line: string): void {
  if (line.endsWith(NOEOL_MARK)) {
    out.push(`${sign}${line.slice(0, -NOEOL_MARK.length)}`);
    out.push(NO_EOL);
  } else {
    out.push(`${sign}${line}`);
  }
}

/**
 * TUI-DESIGN §12.6: unified diff lines (`--- a/x`, `+++ b/x`, `@@ -s,n +s,n @@`, ` `/`-`/`+` rows, git's
 * `\\ No newline at end of file`) between two texts. Empty when the texts are identical.
 */
export function unifiedDiff(a: string, b: string, opts: UnifiedDiffOptions): string[] {
  const context = Math.max(0, Math.floor(opts.context ?? 3));
  const ops = lineDiff(taggedLines(a), taggedLines(b), opts.maxD);
  const changeIdx: number[] = [];
  ops.forEach((o, i) => {
    if (o.op !== 'eq') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];
  const out: string[] = [`--- ${opts.aPath}`, `+++ ${opts.bPath}`];
  // hunks: change runs separated by more than 2 × context equal lines
  const groups: [number, number][] = [];
  let gs = changeIdx[0]!;
  let ge = gs;
  for (const i of changeIdx.slice(1)) {
    // (i - ge - 1) equal lines sit between two changes; more than 2 × context of them starts a new hunk
    if (i - ge - 1 > 2 * context) {
      groups.push([gs, ge]);
      gs = i;
    }
    ge = i;
  }
  groups.push([gs, ge]);
  // a/b line index at every op position
  const aAt = new Int32Array(ops.length + 1);
  const bAt = new Int32Array(ops.length + 1);
  let ai = 0;
  let bi = 0;
  ops.forEach((o, i) => {
    aAt[i] = ai;
    bAt[i] = bi;
    if (o.op !== 'ins') ai++;
    if (o.op !== 'del') bi++;
  });
  aAt[ops.length] = ai;
  bAt[ops.length] = bi;
  for (const [s, e] of groups) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    const aStart = aAt[from]!;
    const bStart = bAt[from]!;
    out.push(`@@ -${hunkRange(aStart, aAt[to + 1]! - aStart)} +${hunkRange(bStart, bAt[to + 1]! - bStart)} @@`);
    for (let i = from; i <= to; i++) {
      const o = ops[i]!;
      pushLine(out, o.op === 'eq' ? ' ' : o.op === 'del' ? '-' : '+', o.line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// /diff <step> from images
// ---------------------------------------------------------------------------------------

export interface StepDiffFile {
  path: string;
  /** pre-image bytes; null when the file did not exist (or no copy was taken) */
  pre: Uint8Array | null;
  /** post-image bytes (the file as the step left it, or the current file when unchanged since); null when deleted */
  post: Uint8Array | null;
  /** the file differs from the step's post image now → `(changed since)` */
  changedSince?: boolean;
  /** no pre-image copy was taken (size / cap): only sizes can be shown */
  preUnavailable?: boolean;
}

/** TUI-DESIGN §12.6 binary rows: git's heuristic, a NUL in the first 8000 bytes. */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * TUI-DESIGN §12.6: `/diff <step>` — for each file a `diff step N -- <path>` header (`(changed since)` when the
 * file moved on after the step), then the unified diff between the pre- and post-images (`/dev/null` for
 * created / deleted files), `Binary files differ` for binaries, sizes only past 1 MiB; capped at `maxLines`.
 */
export function diffStepLines(step: number, files: readonly StepDiffFile[], opts: { context?: number; maxLines?: number } = {}): string[] {
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DIFF_INLINE_MAX_LINES));
  const out: string[] = [];
  if (files.length === 0) return [`diff step ${step}: no files recorded`];
  for (const f of files) {
    const header = `diff step ${step} -- ${f.path}${f.changedSince ? ' (changed since)' : ''}`;
    out.push(header);
    const preLen = f.pre?.length ?? 0;
    const postLen = f.post?.length ?? 0;
    if (f.preUnavailable) {
      out.push(`(no pre-image: file was ${f.pre === null ? 'not copied' : 'skipped'}; after ${formatBytes(postLen)})`);
      continue;
    }
    if (f.pre === null && f.post === null) {
      out.push('(no content recorded)');
      continue;
    }
    if (preLen > DIFF_MAX_FILE_BYTES || postLen > DIFF_MAX_FILE_BYTES) {
      out.push(`(files > 1 MiB: before ${formatBytes(preLen)}, after ${formatBytes(postLen)})`);
      continue;
    }
    if ((f.pre !== null && isBinary(f.pre)) || (f.post !== null && isBinary(f.post))) {
      out.push(`Binary files differ (before ${formatBytes(preLen)}, after ${formatBytes(postLen)})`);
      continue;
    }
    const a = f.pre === null ? '' : decoder.decode(f.pre);
    const b = f.post === null ? '' : decoder.decode(f.post);
    const body = unifiedDiff(a, b, { aPath: f.pre === null ? '/dev/null' : `a/${f.path}`, bPath: f.post === null ? '/dev/null' : `b/${f.path}`, ...(opts.context !== undefined ? { context: opts.context } : {}) });
    if (body.length === 0) out.push('(no changes)');
    else out.push(...body);
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, Math.max(0, maxLines - 1));
    kept.push(`… ${out.length - kept.length} more lines`);
    return kept;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Cell widths (TUI-DESIGN §4.2, over O2's width.ts)
// ---------------------------------------------------------------------------------------

/** Printable ASCII only: one cell per character, no segmentation needed (the common case for paths). */
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]*$/;

let segmenterInstance: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  if (segmenterInstance === null) segmenterInstance = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenterInstance;
}

/** TUI-DESIGN §4.2: the grapheme clusters of `s` (Intl.Segmenter; a printable-ASCII string is its characters). */
export function graphemes(s: string): string[] {
  if (s.length === 0) return [];
  if (ASCII_PRINTABLE_RE.test(s)) return [...s];
  const out: string[] = [];
  for (const seg of segmenter().segment(s)) out.push(seg.segment);
  return out;
}

/** TUI-DESIGN §4.2: terminal cells of one grapheme cluster — O2's `cellWidth` (string-width@8 rules: VS16 emoji, flags, keycaps and ZWJ sequences are 2). */
export function graphemeCells(g: string): number {
  return cellWidth(g);
}

/** Display width of `s` in cells (TUI-DESIGN §4.2; O2's `stringWidth`). */
export function stringCells(s: string): number {
  return stringWidth(s);
}

/** Keep the tail of `s` within `max` cells, prefixed with `…` when truncated (TUI-DESIGN §12.6 "left-truncated by grapheme"). */
export function truncateLeftCells(s: string, max: number): string {
  const cells = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (cells === 0) return '';
  if (stringCells(s) <= cells) return s;
  if (cells === 1) return '…';
  if (ASCII_PRINTABLE_RE.test(s)) return `…${s.slice(s.length - (cells - 1))}`;
  const gs = graphemes(s);
  let width = 0;
  let i = gs.length;
  while (i > 0) {
    const w = graphemeCells(gs[i - 1]!);
    if (width + w > cells - 1) break;
    width += w;
    i--;
  }
  return `…${gs.slice(i).join('')}`;
}

/** TUI-DESIGN §4.2: keep the head of `s` within `max` cells, suffixed with `…` when truncated (O2's `truncateCells`; a non-finite `max` yields ''). */
export function truncateRightCells(s: string, max: number): string {
  return truncateCells(s, Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0);
}

/** TUI-DESIGN §4.2: pad with spaces to `width` cells (never truncates). */
export function padEndCells(s: string, width: number): string {
  const w = stringCells(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}
