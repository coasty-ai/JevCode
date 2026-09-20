/**
 * Minimal unified-diff generator for the mocked trajectories of the jev-only ladder suites
 * (docs/JEV-ONLY.md): the gold fix is handed to the mocked provider as a `patch` action, so
 * it has to be a `git apply`-able `-p1` diff computed in TypeScript from two texts (the loader
 * has no sandbox at load time). Line-based LCS; files here are under 100 lines.
 */

export interface DiffOp {
  kind: 'equal' | 'delete' | 'insert';
  /** index into the old lines (delete/equal) */
  oldIndex: number;
  /** index into the new lines (insert/equal) */
  newIndex: number;
}

const NO_NEWLINE = '\\ No newline at end of file';
/** A last line without a trailing newline is tagged so it never compares equal to the same text with one. */
const NONL_TAG = '\u0000';

function splitLines(text: string): string[] {
  if (text === '') return [];
  if (text.endsWith('\n')) return text.slice(0, -1).split('\n');
  const lines = text.split('\n');
  lines[lines.length - 1] = `${lines[lines.length - 1]!}${NONL_TAG}`;
  return lines;
}

function render(prefix: string, line: string): string[] {
  return line.endsWith(NONL_TAG) ? [`${prefix}${line.slice(0, -1)}`, NO_NEWLINE] : [`${prefix}${line}`];
}

/** Edit script old → new as equal/delete/insert ops (deletes before inserts inside a change). */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // lcs[i][j] = LCS length of old[i..] and new[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'equal', oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'delete', oldIndex: i, newIndex: j });
      i++;
    } else {
      ops.push({ kind: 'insert', oldIndex: i, newIndex: j });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'delete', oldIndex: i++, newIndex: j });
  while (j < m) ops.push({ kind: 'insert', oldIndex: i, newIndex: j++ });
  return ops;
}

interface Hunk {
  /** op index range [start, end) */
  start: number;
  end: number;
}

/** Group changed ops into hunks whose `context` lines overlap or touch (git's rule). */
function hunksOf(ops: readonly DiffOp[], context: number): Hunk[] {
  const changed: number[] = [];
  for (const [k, op] of ops.entries()) if (op.kind !== 'equal') changed.push(k);
  if (changed.length === 0) return [];
  const hunks: Hunk[] = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length, changed[0]! + 1 + context);
  for (const k of changed.slice(1)) {
    const s = Math.max(0, k - context);
    if (s <= end) end = Math.min(ops.length, k + 1 + context);
    else {
      hunks.push({ start, end });
      start = s;
      end = Math.min(ops.length, k + 1 + context);
    }
  }
  hunks.push({ start, end });
  return hunks;
}

/**
 * `diff --git a/<path> b/<path>` with 3 lines of context, byte-faithful to `git diff` on the
 * common cases (including files without a trailing newline). Empty string when equal.
 */
export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  if (oldText === newText) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of hunksOf(ops, context)) {
    const slice = ops.slice(h.start, h.end);
    const oldCount = slice.filter((o) => o.kind !== 'insert').length;
    const newCount = slice.filter((o) => o.kind !== 'delete').length;
    const first = slice[0]!;
    const oldStart = oldCount === 0 ? first.oldIndex : first.oldIndex + 1;
    const newStart = newCount === 0 ? first.newIndex : first.newIndex + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (op.kind === 'equal') out.push(...render(' ', a[op.oldIndex]!));
      else if (op.kind === 'delete') out.push(...render('-', a[op.oldIndex]!));
      else out.push(...render('+', b[op.newIndex]!));
    }
  }
  return `${out.join('\n')}\n`;
}

/** One diff per changed file, concatenated (files in the given order; unchanged files skipped). */
export function unifiedDiffFiles(files: readonly { path: string; oldText: string; newText: string }[]): string {
  return files.map((f) => unifiedDiff(f.path, f.oldText, f.newText)).join('');
}
