/**
 * The **pure** half of the diff surface (TUI-DESIGN-4 §6.1, §6.2; §14.2 review item 13): the Myers line diff and the
 * unified-diff writer, plus the one path/cell sanitising pair that `diff/summary.ts` and `diff/rows.ts` share.
 *
 * Why it is its own module. `src/undo/diff.ts` owns the `/diff` **command** — it opens files, spawns `git` and
 * imports `node:fs/promises`, `checkpoint/images.ts`, `sandbox/paths.ts` and `workspace/git.ts`. `unifiedDiff` and
 * `lineDiffCounts` are pure and were merely stored next to it, so every sink that formats an item (`plain.ts`,
 * `chat/bubbles.ts` through it) pulled the whole apparatus in behind one function. Round 4's item formatter is on
 * the first-frame path, so the pure half moved here: **this file imports nothing at all**. `undo/diff.ts`
 * re-exports every name, so no existing importer changes.
 *
 * It also owns the two sanitisers, because a diff is **model-authored text** on its way to a terminal:
 * `stripControls` (a command cannot drive the terminal — the pinned invariant of `plain.test.ts`) and `safePath`
 * (§6.1 edge 9: a header path carrying a newline used to tear the review card's box open).
 */

// ---------------------------------------------------------------------------------------
// Terminal safety (§6.1 edge 9, §6.2 edges 1, 3, 4, 7)
// ---------------------------------------------------------------------------------------

/** The byte-order mark, which is invisible and therefore lies about what changed (§6.2 edge 3). */
export const BOM = '﻿';

/**
 * C0 (including `\t`, `\n` and `\r`, which a *cell* must never carry), DEL and C1 — everything a terminal reads as
 * an escape or a control sequence. `sanitizeStream` (plain.ts) keeps `\t\n\r` because it works on whole streams;
 * a diff cell is one row of a fixed-width box, so all three are controls here too.
 */
// eslint-disable-next-line no-control-regex
export const CELL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Format / zero-width code points `sanitizeStream` does not cover (U+200B…U+200F, the bidi embeddings, overrides
 * and isolates, the word-joiner family, and U+FEFF away from the start) — §6.2 edge 4.
 */
export const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** `·` is the one visible stand-in: it is already the row grammar's separator glyph, so it needs no new legend. */
export const INVISIBLE_MARK = '·';

/**
 * §6.2 edge 1: a tab advances to the next `stop`-cell stop — expanded before a row is measured, so no fixed-width
 * box can break (A6-12). Counted from the start of the string, which is the row's own left edge.
 */
export function expandTabs(s: string, stop = 4): string {
  if (!s.includes('\t')) return s;
  let out = '';
  let col = 0;
  for (const ch of s) {
    if (ch === '\t') {
      const n = stop - (col % stop);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/**
 * Every C0/DEL/C1 control becomes `·`. This is the invariant `plain.test.ts` pins as "a command cannot drive the
 * terminal": model-authored diff content reaches the review card, the `--plain` confirmer's stdout and the screen
 * reader, and `\u001b[2J` inside a card row would clear the screen from inside the box.
 */
export function stripControls(s: string): string {
  return s.replace(CELL_CONTROL_RE, INVISIBLE_MARK);
}

/**
 * One diff cell, terminal-safe: a leading BOM named, tabs expanded, then every control and invisible code point
 * replaced by `·`. Tabs are expanded **first** so they still align, and the BOM is read before `INVISIBLE_RE`
 * would swallow it.
 */
export function sanitiseCell(raw: string, stop = 4): string {
  const bom = raw.startsWith(BOM) ? '<BOM>' : '';
  const body = bom === '' ? raw : raw.slice(BOM.length);
  return bom + stripControls(expandTabs(body, stop)).replace(INVISIBLE_RE, INVISIBLE_MARK);
}

/**
 * §6.1 edge 9: a header path that leaves this module is one line and carries no control character. git will happily
 * quote a path containing a newline or an ESC (`--- "a/we\\nird.py"`), `unquote` turns the escape back into the real
 * byte, and the card then renders `│   M we<newline>ird.py …` — `cellWidth` scores the row correctly and the box
 * still tears. Paths are also cell-truncated by their callers; this is the part that must happen once, at the source.
 */
export function safePath(p: string): string {
  return stripControls(p.replace(/\t/g, ' ')).replace(INVISIBLE_RE, INVISIBLE_MARK);
}

// ---------------------------------------------------------------------------------------
// git header paths (§6.1 edges 8, 10, 11; §6.2 — ONE parser, shared by summary.ts and rows.ts)
// ---------------------------------------------------------------------------------------

const UTF8 = new TextDecoder('utf-8', { fatal: false });

/**
 * §6.1 edge 8: git quotes a path whose bytes are not printable ASCII and writes every such **byte** as a
 * three-digit octal escape — `café.py` is `"caf\\303\\251.py"`, two escapes for one code point. Decoding each
 * escape on its own with `String.fromCharCode` yields `cafÃ©.py`, so the escapes are collected as a byte run and
 * decoded as UTF-8 once. The result still passes `safePath` before it leaves the parser: `"\\033[31m"` is a legal
 * quoted path.
 */
export function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  let out = '';
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length === 0) return;
    out += UTF8.decode(new Uint8Array(bytes));
    bytes = [];
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      flush();
      out += body[i];
      continue;
    }
    const next = body[i + 1] ?? '';
    if (next >= '0' && next <= '7' && /^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    flush();
    out += next === 't' ? '\t' : next === 'n' ? '\n' : next === 'r' ? '\r' : next;
    i += 1;
  }
  flush();
  return out;
}

/** Strip one leading component (`a/`, `b/`), as `-p1` does; `/dev/null` is "no side"; a prefix-less path is kept whole. */
export function stripOne(p: string): string | null {
  if (p === '/dev/null') return null;
  const slash = p.indexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * §6.1 edge 10: GNU diff writes `+++ b/x\t<timestamp>`; git never does. The tab and everything after it go.
 * `marker` is `'--- '` or `'+++ '` (or `''` when the caller already sliced it off).
 */
export function headerPath(line: string, marker = ''): string | null {
  let rest = line.slice(marker.length);
  if (!rest.startsWith('"')) {
    const tab = rest.indexOf('\t');
    if (tab !== -1) rest = rest.slice(0, tab);
  }
  const p = stripOne(unquote(rest.trim()));
  return p === null ? null : safePath(p);
}

/** The two paths of a `diff --git a/x b/y` line, or null when neither split agrees. Shared by both parsers. */
export function parseDiffGitLine(line: string): { oldPath: string | null; newPath: string | null } | null {
  const rest = line.slice('diff --git '.length).trim();
  const out = (a: string | null, b: string | null): { oldPath: string | null; newPath: string | null } => ({ oldPath: a === null ? null : safePath(a), newPath: b === null ? null : safePath(b) });
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
    return m ? out(stripOne(unquote(m[1] ?? '')), stripOne(unquote(m[2] ?? ''))) : null;
  }
  // names with spaces are not quoted here, so prefer the split where both sides agree
  let at = rest.indexOf(' b/');
  while (at !== -1) {
    const a = rest.slice(0, at);
    const b = rest.slice(at + 1);
    if (a.length > 2 && a.slice(2) === b.slice(2)) return out(stripOne(a), stripOne(b));
    at = rest.indexOf(' b/', at + 1);
  }
  at = rest.indexOf(' b/');
  if (at === -1) return null;
  return out(stripOne(rest.slice(0, at)), stripOne(rest.slice(at + 1)));
}

/** `rename to` / `copy to` / `rename from` carry a bare (possibly quoted) path with no `a/` prefix to strip. */
export function sectionPath(raw: string): string {
  return safePath(unquote(raw.trim()));
}

// ---------------------------------------------------------------------------------------
// Line diff (Myers, O((N+M)·D), bounded) — moved verbatim from `src/undo/diff.ts`
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
  const v = new Int32Array(2 * offset + 1);
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

/** §6.2 edge 8: git's own text for a file whose last line has no newline. Kept verbatim wherever it appears. */
export const NO_EOL_TEXT = '\\ No newline at end of file';
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
    out.push(NO_EOL_TEXT);
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
