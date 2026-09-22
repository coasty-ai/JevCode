/**
 * `/diff` rendering (TUI-DESIGN §12.6, D9) — pure, plus the sandboxed runner at the end of the file.
 *
 * `diffStatBlock` turns `git diff --numstat -z` output (plus the untracked `--no-index` rows, the run-start dirty
 * set and the submodule list) into the inline block: header, one row per file with the letter `M/A/D/R/?/B/S`,
 * `+n −m`, a ≤ 10-cell bar, `†` for paths dirty before the run, the legend, and the 40-row cap.
 * `diffStepLines` renders `/diff <step>` from pre/post images with a dependency-free Myers line diff.
 *
 * Cell widths come from O2's `src/tui/composer/width.ts` (§4.2, string-width-identical); the cell helpers add the
 * left-truncation and padding the diff rows need on top of `stringWidth` / `truncateCells`.
 *
 * Wave 2 (I/O, last section): `collectDiffStat` / `diffStatBlockFromGit` run the one `git diff --numstat -z HEAD --
 * <files>` spawn and the per-untracked `--no-index` spawns through the `Sandbox` interface (`runGit`, exit 1 =
 * success per A151) and feed the pure renderer; `collectFullDiff` produces the `/diff --full` text for pager.ts.
 */
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normaliseRelPath } from '../checkpoint/images.js';
import type { ExecResult, Sandbox } from '../core/types.js';
import { isSecretPath } from '../sandbox/paths.js';
import { cellWidth, stringWidth, truncateCells } from '../tui/composer/width.js';
// TUI-DESIGN-4 §14.2 review item 13: the pure line diff moved to an ink-free, fs-free module; this file re-exports it below
import { unifiedDiff } from '../tui/diff/text.js';
import { runGit, shellQuote, type GitRunOptions } from '../workspace/git.js';

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

/** TUI-DESIGN-4 §6.5 / §12: the run id shortened for a head — the distinguishing suffix, as `coordination/ids.ts:118` takes it. */
export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(-8) : runId;
}

/**
 * TUI-DESIGN-4 §6.5 item 2 / §12: `diff · run <id8> · N files · +a −b` — **short by construction** (≤ 52 cells) so it
 * is never truncated (A6-4 destroyed `0 skipped)` at 80 columns and still wrapped). Zero-valued clauses are dropped;
 * the non-zero `untracked` / `binary` / `skipped` counts move to their own rows at the bottom of the block
 * (`diffStatNoteRows`). 0 files → `diff · run <id8> · no changes` (edge 1).
 */
export function diffStatHeader(runId: string, s: DiffStatSummary): string {
  const head = `diff · run ${shortRunId(runId)}`;
  if (s.files === 0) return `${head} · no changes`;
  return `${head} · ${s.files} file${s.files === 1 ? '' : 's'} · +${s.added} −${s.deleted}`;
}

/** §6.5 item 2: the clauses the short head dropped, one row each, only when non-zero. */
export function diffStatNoteRows(s: DiffStatSummary): string[] {
  const rows: string[] = [];
  if (s.untracked > 0) rows.push(`${s.untracked} untracked`);
  if (s.binary > 0) rows.push(`${s.binary} binary`);
  if (s.skipped > 0) rows.push(`${s.skipped} skipped`);
  return rows;
}

/** TUI-DESIGN §12.6: a ≤ `cells` bar of `+` then `-`, scaled to `maxTotal`; each non-zero side keeps at least one cell when there is room. */
export function diffBar(added: number, deleted: number, maxTotal: number, cells = DIFF_BAR_CELLS): string {
  if (cells <= 0 || maxTotal <= 0 || !Number.isFinite(maxTotal)) return '';
  // TUI-DESIGN-4 §6.5 item 4 (A6-17): a bar that is full on every row carries no information — the caller passes
  // `maxTotal <= 0` for that case, which the guard above already answers; the branch below stays the scaling one.
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
 * TUI-DESIGN §12.6 / §24 (+ TUI-DESIGN-4 §6.5): the inline `/diff` block. `columns` is the **body** width — the
 * caller passes `blockWidth(columns())`, not the terminal width, so round 3's 10-cell gutter no longer pushes every
 * row 10 cells past the right edge (A6-15). Header, rows ` M src/a.py            +120 −12  ++++++++--`
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
  // §6.5 item 4 (A6-17): when every row's churn is equal the bar is a full 10 cells everywhere — pure noise, so drop it
  const totals = rows.map((r) => r.added + r.deleted);
  const maxTotal = totals.reduce((m, t) => Math.max(m, t), 0);
  const equalChurn = totals.length > 1 && totals.every((t) => t === totals[0]);
  shown.forEach((r, i) => {
    const label = r.from !== null ? `${r.from} → ${r.path}` : r.path;
    const mark = r.dirtyBefore ? '†' : '';
    const path = truncateLeftCells(label, pathWidth - stringCells(mark)) + mark;
    const bar = withBar && !equalChurn && !r.binary && r.bytes === null ? diffBar(r.added, r.deleted, maxTotal) : '';
    lines.push(` ${r.letter} ${padEndCells(path, pathWidth)}  ${padEndCells(counts[i] ?? '', countsWidth)}  ${bar}`.trimEnd());
  });
  // §6.5 item 2: the counts the short head dropped, above the `†` footnote that explains a glyph in the rows
  for (const note of diffStatNoteRows(summary)) lines.push(note);
  if (shown.some((r) => r.dirtyBefore)) lines.push(DIFF_LEGEND);
  for (const s of input.skipped ?? []) lines.push(`   skipped ${s.path}: ${s.reason}`);
  if (shown.length < rows.length) lines.push(`… ${rows.length - shown.length} more files (/diff --all)`);
  return lines.map((l) => truncateRightCells(l, cols));
}

// ---------------------------------------------------------------------------------------
// Line diff (Myers) — TUI-DESIGN-4 §14.2 review item 13: the pure half lives in `src/tui/diff/text.ts`
// ---------------------------------------------------------------------------------------

/**
 * `lineDiff` / `unifiedDiff` / `lineDiffCounts` / `splitLines` are **pure** and now live in the ink-free, fs-free
 * `src/tui/diff/text.ts`, because `src/tui/plain.ts` (the one item formatter, on the first-frame path) and
 * `src/tui/diff/summary.ts` need them and must not pull `node:fs/promises`, `checkpoint/images.ts`,
 * `sandbox/paths.ts` and `workspace/git.ts` in behind one function. Every name is re-exported here, so no existing
 * importer of `src/undo/diff.ts` changes.
 */
export { DIFF_MAX_D, lineDiff, lineDiffCounts, splitLines, unifiedDiff, type DiffOp, type UnifiedDiffOptions } from '../tui/diff/text.js';

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

// ---------------------------------------------------------------------------------------
// I/O: the sandboxed `git diff --numstat -z HEAD -- <files>` runner behind diffStatBlock (TUI-DESIGN §12.6, D9)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §12.6 (A151): `--no-index` (and `--exit-code`) exit 1 means "differences found", not failure. */
export function noIndexOk(r: Pick<ExecResult, 'exitCode' | 'killedBy'>): boolean {
  return r.killedBy === null && (r.exitCode === 0 || r.exitCode === 1);
}

/** TUI-DESIGN §12.6: `/dev/null` is the empty side of every untracked file's `--no-index` diff. */
export const DEV_NULL = '/dev/null';
/** Default per-spawn timeout of the diff runners (the whole `/diff` is one keystroke's worth of waiting, never the loop's). */
export const DIFF_GIT_TIMEOUT_MS = 15_000;
/** `/diff --full` output bound (the pager file); past it a trailer says so. */
export const DIFF_FULL_MAX_BYTES = 16 * 1024 * 1024;
/** Untracked files shown in `/diff --full` (one `--no-index` spawn each). */
export const DIFF_FULL_UNTRACKED_MAX = 200;
/**
 * TUI-DESIGN §12.4 / §12.6 (C40): every pathspec-taking harness git call (`diff`, `ls-files`, `restore`) runs with
 * literal pathspecs — a recorded name such as `pages/[id].tsx` or `a*.py` is a file name, never a glob that would
 * also match (and, for `restore`, revert) `pages/i.tsx`. Merged into the child env by `runGit` (`GitRunOptions.env`).
 */
export const LITERAL_PATHSPECS_ENV: Readonly<Record<string, string>> = { GIT_LITERAL_PATHSPECS: '1' };
/**
 * TUI-DESIGN §12.6: pathspecs are handed to `sh -c` in one command string, so a run that touched thousands of files
 * is split into batches whose quoted pathspecs sum to at most this many bytes (Linux caps one argument at 128 KiB;
 * macOS the whole argv at 1 MiB) and the `-z` outputs are concatenated.
 */
export const DIFF_PATHSPEC_CHUNK_BYTES = 64 * 1024;
/**
 * TUI-DESIGN §12.6: the per-untracked-file `--no-index` spawns run at most this many at a time — `/diff` is allowed
 * while a run is live, and twenty simultaneous `sandbox-exec`/`sh`/`git` trios would compete with the live step.
 */
export const DIFF_NO_INDEX_CONCURRENCY = 2;
/** TUI-DESIGN §12.6 / §10: a changed file on the secret denylist is listed, never diffed, in `/diff --full`. */
export const SECRET_PATH_SKIP = 'secret path';

export interface DiffIoOptions {
  sandbox: Sandbox;
  /** realpath of the workspace (the sandbox's cwd; every path below is relative to it) */
  root: string;
  runId: string;
  /** pathspec batch bound in quoted bytes (default DIFF_PATHSPEC_CHUNK_BYTES) */
  pathspecChunkBytes?: number;
  /** the run's changed files (`state.createdThisRun` ∪ every `outcome.changedFiles`), workspace-relative */
  changedFiles: readonly string[];
  /** untracked paths among them (`??` in the status snapshot ∪ created files that were never added); derived with one `git ls-files --others` spawn when absent */
  untracked?: readonly string[];
  /** HEAD is unborn: diff against EMPTY_TREE_OID (§12.6) */
  unborn?: boolean;
  /** paths dirty before the run → `†` */
  dirtyAtStart?: ReadonlySet<string>;
  /** files the run created → `A` when tracked */
  created?: ReadonlySet<string>;
  /** submodule paths → `S` */
  submodules?: ReadonlySet<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DiffStatIoOptions extends DiffIoOptions {
  /** `--all`: lift the 40-row cap */
  all?: boolean;
  /** untracked files past this many get sizes instead of a `--no-index` numstat (default 20) */
  untrackedNumstatMax?: number;
}

export interface DiffIoTrace {
  /** sandbox spawns performed */
  spawns: number;
  /** git failures, one line each (never thrown: the block renders what it has) */
  errors: string[];
}

export interface DiffStatCollected extends DiffIoTrace {
  input: DiffStatInput;
}

interface PathFacts {
  /** normalised relative paths that exist on disk, with their sizes */
  existing: Map<string, number>;
  deleted: Set<string>;
  skipped: { path: string; reason: string }[];
}

function errnoOf(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** lstat every changed file once: sizes for the untracked rows, `D` for the missing ones, skips for the unreadable or escaping. */
async function pathFacts(root: string, changedFiles: readonly string[]): Promise<PathFacts> {
  const existing = new Map<string, number>();
  const deleted = new Set<string>();
  const skipped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of changedFiles) {
    const rel = normaliseRelPath(raw);
    if (rel === null) {
      if (!seen.has(`\0${raw}`)) {
        seen.add(`\0${raw}`);
        skipped.push({ path: raw, reason: 'outside the workspace' });
      }
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const st = await lstat(resolve(root, rel));
      if (st.isSymbolicLink() || !st.isFile()) {
        skipped.push({ path: rel, reason: st.isSymbolicLink() ? 'symlink' : 'not a regular file' });
        continue;
      }
      existing.set(rel, st.size);
    } catch (e) {
      const code = errnoOf(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') deleted.add(rel);
      else skipped.push({ path: rel, reason: `unreadable (${code ?? 'error'})` });
    }
  }
  return { existing, deleted, skipped };
}

/** Every diff runner spawn: the caller's timeout / signal, literal pathspecs (C40), then the call's own additions. */
function gitOpts(o: DiffIoOptions, extra: GitRunOptions = {}): GitRunOptions {
  const { env: extraEnv, ...rest } = extra;
  return { timeoutMs: o.timeoutMs ?? DIFF_GIT_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}), ...rest, env: { ...LITERAL_PATHSPECS_ENV, ...(extraEnv ?? {}) } };
}

function failureText(what: string, r: ExecResult): string {
  const line = r.stderr.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
  return `${what}: ${line.length > 0 ? line : `git exited ${r.exitCode ?? 'by signal'}`}`;
}

/**
 * TUI-DESIGN §12.6: split pathspecs into batches whose shell-quoted lengths (plus one separator each) stay within
 * `maxBytes`; a single pathspec longer than the bound forms its own batch. Pure; order preserved.
 */
export function chunkPathspecs(paths: readonly string[], maxBytes: number = DIFF_PATHSPEC_CHUNK_BYTES): string[][] {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DIFF_PATHSPEC_CHUNK_BYTES;
  const out: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const p of paths) {
    const cost = Buffer.byteLength(shellQuote(p)) + 1;
    if (cur.length > 0 && used + cost > cap) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(p);
    used += cost;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** `Promise.all` with at most `limit` tasks in flight; results in input order; never rejects when `fn` does not. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const n = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

/** One `git ls-files -z --others --exclude-standard -- <files>` per pathspec batch: which of the existing files are untracked (only when the caller did not say). */
async function deriveUntracked(o: DiffIoOptions, files: readonly string[], trace: DiffIoTrace): Promise<string[]> {
  if (files.length === 0) return [];
  const out: string[] = [];
  for (const batch of chunkPathspecs(files, o.pathspecChunkBytes)) {
    try {
      trace.spawns += 1;
      const r = await runGit(o.sandbox, o.root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...batch], gitOpts(o));
      if (!r.ok) {
        trace.errors.push(failureText('ls-files', r));
        continue;
      }
      out.push(...r.stdout.split('\0').filter((p) => p.length > 0));
    } catch (e) {
      trace.errors.push(`ls-files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * TUI-DESIGN §12.6: the `/diff` data through the sandbox — one `git diff --numstat -z --ignore-submodules=dirty
 * <HEAD | empty tree> -- <tracked>` spawn (awaited off the loop; `runGit` adds `--no-ext-diff --no-textconv` and
 * the neutralising flags), plus `git diff --no-index --numstat -z -- /dev/null <f>` for the first 20 untracked
 * files (exit 1 = differences = success, A151) and sizes for the rest. Never throws for a git failure: the block
 * renders what it has and `errors` says what did not.
 */
export async function collectDiffStat(o: DiffStatIoOptions): Promise<DiffStatCollected> {
  const trace: DiffIoTrace = { spawns: 0, errors: [] };
  const facts = await pathFacts(o.root, o.changedFiles);
  const existing = [...facts.existing.keys()];
  const untrackedList = o.untracked === undefined ? await deriveUntracked(o, existing, trace) : o.untracked.map((p) => normaliseRelPath(p)).filter((p): p is string => p !== null);
  const untracked = new Set(untrackedList.filter((p) => facts.existing.has(p)));
  const tracked = [...existing.filter((p) => !untracked.has(p)), ...facts.deleted];
  let numstat = '';
  // one `--numstat -z` spawn per pathspec batch (one batch for any ordinary run); `-z` records concatenate cleanly
  for (const batch of chunkPathspecs(tracked, o.pathspecChunkBytes)) {
    try {
      trace.spawns += 1;
      const base = o.unborn === true ? EMPTY_TREE_OID : 'HEAD';
      const r = await runGit(o.sandbox, o.root, ['diff', '--numstat', '-z', '--ignore-submodules=dirty', base, '--', ...batch], gitOpts(o));
      if (noIndexOk(r)) numstat += r.stdout;
      else trace.errors.push(failureText('diff', r));
    } catch (e) {
      trace.errors.push(`diff: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const max = Math.max(0, Math.floor(o.untrackedNumstatMax ?? DIFF_UNTRACKED_NUMSTAT_MAX));
  const untrackedRows: { path: string; numstat?: string; bytes?: number }[] = [];
  const list = [...untracked];
  const withNumstat = list.slice(0, max);
  // bounded concurrency: `/diff` may run beside a live step (§12.6)
  const results = await mapLimit(withNumstat, DIFF_NO_INDEX_CONCURRENCY, async (p): Promise<{ path: string; numstat?: string; bytes?: number }> => {
    const bytes = facts.existing.get(p) ?? 0;
    try {
      trace.spawns += 1;
      const r = await runGit(o.sandbox, o.root, ['diff', '--no-index', '--numstat', '-z', '--', DEV_NULL, p], gitOpts(o));
      if (noIndexOk(r)) return { path: p, numstat: r.stdout };
      trace.errors.push(failureText(`diff --no-index ${p}`, r));
    } catch (e) {
      trace.errors.push(`diff --no-index ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { path: p, bytes };
  });
  untrackedRows.push(...results);
  for (const p of list.slice(max)) untrackedRows.push({ path: p, bytes: facts.existing.get(p) ?? 0 });
  const input: DiffStatInput = {
    runId: o.runId,
    numstat,
    untracked: untrackedRows,
    deleted: facts.deleted,
    skipped: facts.skipped,
    ...(o.dirtyAtStart ? { dirtyAtStart: o.dirtyAtStart } : {}),
    ...(o.created ? { created: o.created } : {}),
    ...(o.submodules ? { submodules: o.submodules } : {}),
    ...(o.all === true ? { all: true } : {}),
  };
  return { input, spawns: trace.spawns, errors: trace.errors };
}

/** TUI-DESIGN §12.6: `collectDiffStat` fed to the pure `diffStatBlock` — the inline `/diff` item's lines. */
export async function diffStatBlockFromGit(o: DiffStatIoOptions, columns: number): Promise<{ lines: string[]; spawns: number; errors: string[] }> {
  const c = await collectDiffStat(o);
  return { lines: diffStatBlock(c.input, columns), spawns: c.spawns, errors: c.errors };
}

export interface FullDiffIoOptions extends DiffIoOptions {
  /** `--color=always` for the pager; false for the inline block */
  color: boolean;
  /** files larger than this are excluded (default 1 MiB, §12.6) */
  maxFileBytes?: number;
  maxOutputBytes?: number;
  /** the configured secret stores (§10; `config.secretPaths`); with the basename denylist they decide `isDenied` when it is not given */
  secretPaths?: readonly string[];
  /** TUI-DESIGN §10 / §12.6: a changed file that must be listed, never diffed (default: `isSecretPath(root, rel, secretPaths)`) */
  isDenied?: (rel: string) => boolean;
  /** `config.redact` — the assembled text passes through it before it is written or rendered (§10.6, §13.6) */
  redact?: (s: string) => string;
}

export interface FullDiffCollected extends DiffIoTrace {
  /** the unified diff text (tracked files first, then one `--no-index` block per untracked file), redacted */
  text: string;
  skipped: { path: string; reason: string }[];
  /** the git output hit `maxOutputBytes` */
  truncated: boolean;
  /** the inline block's first line when the text is incomplete (null otherwise) — pager.ts `notice` */
  notice: string | null;
}

/** `core.quotePath=false` cannot ride `runGit`'s `-c` position (its value is not a flag), so it travels as a scoped config env (git ≥ 2.31). */
const QUOTEPATH_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotePath', GIT_CONFIG_VALUE_0: 'false' };

/** The sandbox glues `head + marker + 16 KB tail` when the output cap is passed (run.ts `StreamCollector.finish`). */
const TRUNCATION_MARKER_RE = /\n…\[output truncated: \d+ bytes omitted\]…\n/;
/** A file-diff boundary, with or without the `--color=always` SGR prefix. */
const DIFF_GIT_BOUNDARY_RE = /\n(?:\x1b\[[0-9;]*m)*diff --git /g;

/** `… output truncated at 16 MiB` — the trailer at the end of an incomplete `/diff --full` text (§12.6). */
export function truncatedTrailer(maxBytes: number): string {
  return `… output truncated at ${formatBytes(maxBytes)}`;
}

/** TUI-DESIGN §12.6: the inline block's first line when the patch is incomplete. */
export function truncatedNotice(maxBytes: number): string {
  return `${truncatedTrailer(maxBytes)} — the patch ends at the last complete file diff`;
}

/**
 * TUI-DESIGN §12.6: a capped git output as an appliable prefix — the sandbox's head only (the tail after the
 * `…[output truncated: N bytes omitted]…` marker is dropped), cut back to the last `diff --git` boundary so no torn
 * hunk survives; with a single torn file diff the cut falls on the last complete line instead. Text without the
 * marker (the cap was hit on stderr, or not at all) is returned unchanged. Pure.
 */
export function cutTruncatedDiff(stdout: string): string {
  const m = TRUNCATION_MARKER_RE.exec(stdout);
  if (m === null) return stdout;
  const head = stdout.slice(0, m.index);
  let lastBoundary = -1;
  for (const b of head.matchAll(DIFF_GIT_BOUNDARY_RE)) lastBoundary = b.index;
  if (lastBoundary > 0) return head.slice(0, lastBoundary + 1);
  const lastLine = head.lastIndexOf('\n');
  return lastLine >= 0 ? head.slice(0, lastLine + 1) : '';
}

/**
 * TUI-DESIGN §12.6: the `/diff --full` text — `git diff [--color=always] --submodule=short --ignore-submodules=dirty
 * <HEAD | empty tree> -- <tracked ≤ 1 MiB>` with `core.quotePath=false` and literal pathspecs, one spawn per
 * pathspec batch, then `git diff --no-index -- /dev/null <f>` per untracked file (exit 1 = success). Files over
 * `maxFileBytes` and files on the secret denylist (§10) are listed in `skipped`, never diffed; a capped output is cut
 * at the last complete file diff (never a torn hunk with the sandbox's marker in it) and the text ends with the
 * `… output truncated at …` trailer; the whole text passes `redact` before it leaves this function.
 */
export async function collectFullDiff(o: FullDiffIoOptions): Promise<FullDiffCollected> {
  const trace: DiffIoTrace = { spawns: 0, errors: [] };
  const maxFile = o.maxFileBytes ?? DIFF_MAX_FILE_BYTES;
  const maxOut = o.maxOutputBytes ?? DIFF_FULL_MAX_BYTES;
  const denied = o.isDenied ?? ((rel: string): boolean => isSecretPath(o.root, rel, o.secretPaths ?? []));
  const redact = o.redact ?? ((s: string): string => s);
  const facts = await pathFacts(o.root, o.changedFiles);
  const skipped = [...facts.skipped];
  const small: string[] = [];
  for (const [p, bytes] of facts.existing) {
    if (denied(p)) skipped.push({ path: p, reason: SECRET_PATH_SKIP });
    else if (bytes > maxFile) skipped.push({ path: p, reason: `> ${formatBytes(maxFile)}` });
    else small.push(p);
  }
  const deleted: string[] = [];
  for (const p of facts.deleted) {
    // a deleted secret file's diff would print its former content
    if (denied(p)) skipped.push({ path: p, reason: SECRET_PATH_SKIP });
    else deleted.push(p);
  }
  const untrackedList = o.untracked === undefined ? await deriveUntracked(o, small, trace) : o.untracked.map((p) => normaliseRelPath(p)).filter((p): p is string => p !== null);
  const untracked = new Set(untrackedList.filter((p) => facts.existing.has(p)));
  const tracked = [...small.filter((p) => !untracked.has(p)), ...deleted];
  const color = o.color ? ['--color=always'] : ['--no-color'];
  const parts: string[] = [];
  let truncated = false;
  let budget = maxOut;
  const take = (r: ExecResult): void => {
    const text = r.truncated ? cutTruncatedDiff(r.stdout) : r.stdout;
    parts.push(text);
    budget -= Buffer.byteLength(text);
    truncated = truncated || r.truncated;
  };
  for (const batch of chunkPathspecs(tracked, o.pathspecChunkBytes)) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    try {
      trace.spawns += 1;
      const base = o.unborn === true ? EMPTY_TREE_OID : 'HEAD';
      const r = await runGit(o.sandbox, o.root, ['diff', ...color, '--submodule=short', '--ignore-submodules=dirty', base, '--', ...batch], gitOpts(o, { maxOutputBytes: budget, env: { ...QUOTEPATH_ENV } }));
      if (noIndexOk(r)) take(r);
      else trace.errors.push(failureText('diff', r));
    } catch (e) {
      trace.errors.push(`diff: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const list = [...untracked].filter((p) => small.includes(p));
  for (const p of list.slice(0, DIFF_FULL_UNTRACKED_MAX)) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    try {
      trace.spawns += 1;
      const r = await runGit(o.sandbox, o.root, ['diff', '--no-index', ...color, '--', DEV_NULL, p], gitOpts(o, { maxOutputBytes: budget, env: { ...QUOTEPATH_ENV } }));
      if (noIndexOk(r)) take(r);
      else trace.errors.push(failureText(`diff --no-index ${p}`, r));
    } catch (e) {
      trace.errors.push(`diff --no-index ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const p of list.slice(DIFF_FULL_UNTRACKED_MAX)) skipped.push({ path: p, reason: `untracked file cap (${DIFF_FULL_UNTRACKED_MAX})` });
  let text = parts.join('');
  if (truncated) text += `${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${truncatedTrailer(maxOut)}\n`;
  return { text: redact(text), skipped, truncated, notice: truncated ? truncatedNotice(maxOut) : null, spawns: trace.spawns, errors: trace.errors };
}
