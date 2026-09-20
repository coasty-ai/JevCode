/**
 * Line-based edits on Python source (1-based physical lines, line endings preserved) and a
 * `diff --git` unified diff that `git apply` accepts.
 */
import { PyEditError } from './errors.js';

interface PhysicalLine {
  text: string;
  /** '\n', '\r\n' or '' (only the last line may lack an ending). */
  ending: string;
}

function split(src: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  if (src === '') return out;
  let start = 0;
  for (let k = 0; k < src.length; k++) {
    if (src[k] !== '\n') continue;
    const crlf = k > 0 && src[k - 1] === '\r';
    out.push({ text: src.slice(start, crlf ? k - 1 : k), ending: crlf ? '\r\n' : '\n' });
    start = k + 1;
  }
  if (start < src.length) out.push({ text: src.slice(start), ending: '' });
  return out;
}

function join(lines: readonly PhysicalLine[]): string {
  let s = '';
  for (const l of lines) s += l.text + l.ending;
  return s;
}

function check(lineNo: number, count: number): void {
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > count) throw new PyEditError(lineNo, count);
}

/** Number of physical lines (a trailing newline does not start a new line). */
export function lineCount(src: string): number {
  return split(src).length;
}

/** Leading whitespace of a line. */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** Whitespace string for an indent given as spaces count or literal. */
function indentString(indent: string | number): string {
  return typeof indent === 'number' ? ' '.repeat(Math.max(0, indent)) : indent;
}

/**
 * Re-indent a block: strip the common leading whitespace of its non-blank lines, then prefix
 * every non-blank line with `indent`. Blank lines stay empty. Relative indentation is kept.
 */
export function reindent(text: string, indent: string | number): string {
  const prefix = indentString(indent);
  const lines = text.split('\n');
  const nonBlank = lines.filter((l) => l.trim() !== '');
  let common: string | null = null;
  for (const l of nonBlank) {
    const ws = indentOf(l);
    if (common === null) common = ws;
    else {
      let k = 0;
      while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
      common = common.slice(0, k);
    }
  }
  const strip = common ?? '';
  return lines.map((l) => (l.trim() === '' ? '' : prefix + l.slice(strip.length))).join('\n');
}

/**
 * Replace physical line `lineNo` with `text` (which may hold several lines). The replaced
 * line's ending is kept; extra lines use the same ending.
 */
export function replaceLine(src: string, lineNo: number, text: string): string {
  const lines = split(src);
  check(lineNo, lines.length);
  const old = lines[lineNo - 1]!;
  const ending = old.ending === '' ? (lines[lineNo - 2]?.ending ?? '\n') : old.ending;
  const parts = text.split('\n');
  const repl: PhysicalLine[] = parts.map((t, k) => ({ text: t, ending: k === parts.length - 1 ? old.ending : ending }));
  lines.splice(lineNo - 1, 1, ...repl);
  return join(lines);
}

/**
 * Insert `text` (re-indented to `indent`) after physical line `afterLineNo`; 0 inserts at the
 * top. When the anchor is the last line and has no trailing newline it gains one.
 */
export function insertLine(src: string, afterLineNo: number, text: string, indent: string | number = ''): string {
  const lines = split(src);
  if (afterLineNo !== 0) check(afterLineNo, lines.length);
  const anchor = afterLineNo === 0 ? undefined : lines[afterLineNo - 1];
  const ending = anchor === undefined || anchor.ending === '' ? (lines.find((l) => l.ending !== '')?.ending ?? '\n') : anchor.ending;
  const body = reindent(text, indent).split('\n');
  const inserted: PhysicalLine[] = body.map((t) => ({ text: t, ending }));
  if (anchor !== undefined && anchor.ending === '') {
    anchor.ending = ending;
    inserted[inserted.length - 1]!.ending = '';
  }
  lines.splice(afterLineNo, 0, ...inserted);
  return join(lines);
}

/** Delete physical line `lineNo`. */
export function deleteLine(src: string, lineNo: number): string {
  const lines = split(src);
  check(lineNo, lines.length);
  lines.splice(lineNo - 1, 1);
  return join(lines);
}

// ---------------------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------------------

type Op = { kind: 'eq' | 'del' | 'ins'; a: number; b: number };

/** Edit distance beyond which the diff degrades to one replace hunk (memory is O(D²)). */
const MAX_EDIT_DISTANCE = 4000;

/**
 * Myers' O((N+M)·D) shortest edit script on the middle of two line arrays (common prefix and
 * suffix trimmed first). Deletions are preferred before insertions on ties, so a changed line
 * renders as `-old` then `+new`.
 */
function myers(a: readonly string[], b: readonly string[], offA: number, offB: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // V holds the furthest x reached on diagonal k, stored at k + off (padded so the window
  // k ∈ [-(d+1), d+1] never leaves the array); `trace[d]` is that window of V before step d.
  const off = max + 2;
  const v = new Int32Array(2 * max + 5);
  v[off + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, a, b, offA, offB);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], dFinal: number, a: readonly string[], b: readonly string[], offA: number, offB: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d >= 0; d--) {
    const win = trace[d]!;
    const at = (k: number): number => win[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'eq', a: offA + x, b: offB + y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: 'ins', a: offA + x, b: offB + prevY });
      else ops.push({ kind: 'del', a: offA + prevX, b: offB + y });
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

/** Edit script over two line arrays: common prefix/suffix, Myers in the middle. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ kind: 'eq', a: k, b: k });
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const middle = midA.length === 0 || midB.length === 0 ? null : myers(midA, midB, pre, pre);
  if (middle !== null) ops.push(...middle);
  else {
    for (let i = 0; i < midA.length; i++) ops.push({ kind: 'del', a: pre + i, b: pre });
    for (let j = 0; j < midB.length; j++) ops.push({ kind: 'ins', a: pre + midA.length, b: pre + j });
  }
  for (let k = 0; k < suf; k++) ops.push({ kind: 'eq', a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

function diffLines(src: string): { lines: string[]; trailingNewline: boolean } {
  if (src === '') return { lines: [], trailingNewline: true };
  const lines = src.split('\n');
  const trailingNewline = lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * `diff --git` unified diff with 3 lines of context, `--- a/path` / `+++ b/path` headers and
 * "\ No newline at end of file" markers. Returns '' when the sources are identical.
 */
export function unifiedDiff(path: string, oldSrc: string, newSrc: string, context = 3): string {
  if (oldSrc === newSrc) return '';
  const A = diffLines(oldSrc);
  const B = diffLines(newSrc);
  const ops = editScript(A.lines, B.lines);
  // A missing trailing newline only differs on the last line; force it into the diff when it changed.
  if (A.trailingNewline !== B.trailingNewline && A.lines.length > 0 && B.lines.length > 0) {
    const last = ops[ops.length - 1]!;
    if (last.kind === 'eq') ops.splice(ops.length - 1, 1, { kind: 'del', a: last.a, b: last.b }, { kind: 'ins', a: last.a + 1, b: last.b });
  }
  const changed = ops.map((o) => o.kind !== 'eq');
  const hunks: Op[][] = [];
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    let last = k;
    while (end < ops.length) {
      if (changed[end]) last = end;
      else if (end - last > 2 * context) break;
      end++;
    }
    hunks.push(ops.slice(start, Math.min(ops.length, last + context + 1)));
    k = last + 1;
  }
  const render = (line: string, side: 'a' | 'b', index: number): string[] => {
    const src = side === 'a' ? A : B;
    const isLast = index === src.lines.length - 1;
    return isLast && !src.trailingNewline ? [line, NO_NEWLINE] : [line];
  };
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const first = hunk[0]!;
    const aCount = hunk.filter((o) => o.kind !== 'ins').length;
    const bCount = hunk.filter((o) => o.kind !== 'del').length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) {
      if (o.kind === 'eq') out.push(...render(` ${A.lines[o.a]!}`, 'a', o.a));
      else if (o.kind === 'del') out.push(...render(`-${A.lines[o.a]!}`, 'a', o.a));
      else out.push(...render(`+${B.lines[o.b]!}`, 'b', o.b));
    }
  }
  return `${out.join('\n')}\n`;
}
