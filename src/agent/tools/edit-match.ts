/**
 * `edit_file` matching (docs/AGENT-LOOP-DESIGN.md §4.5). The driver reads the file and finds the span here; the engine
 * then applies a plain exact edit, so `Workspace.applyEdit` stays exact-only in every mode.
 *
 * The cascade: trivial errors → the placeholder guard → an exact match (line endings normalised to the file's style)
 * → four fallbacks in OpenCode's order, the first with exactly one span winning:
 *
 *   line-trimmed          lines compared with both ends trimmed
 *   indentation-flexible  the common leading indentation removed from both sides
 *   whitespace-normalised runs of whitespace (newlines included) collapse to one space
 *   escape-normalised     `\\n`, `\\t`, `\\"` in old_string read as `\n`, `\t`, `"` (new_string unescaped alike)
 *
 * A line match re-indents new_string by the file's indentation delta (Gemini CLI's `applyIndentation`: OpenCode's verbatim
 * splice lands mis-indented in Python). The splice keeps the file's line endings and a leading BOM. A fallback span far
 * larger than old_string is refused (the disproportion guard); no match answers with the closest window of the file, so
 * the model can copy the real text instead of guessing again.
 */
import { AGENT_READ_LINE_CHARS } from '../limits.js';

export type EditHow = 'whitespace' | 'indentation' | 'escapes';

export interface EditRequest {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export type EditMatch =
  | {
      ok: true;
      /** `edit`: `old` occurs exactly once in the file; `write`: the whole new content (replace_all, or a span whose text repeats) */
      action: { kind: 'edit'; old: string; new: string } | { kind: 'write'; content: string };
      /** the file content after the change (for the syntax check) */
      newContent: string;
      replacements: number;
      /** 1-based lines of the replacement in the new file (single replacements only) */
      lines: [number, number] | null;
      how: EditHow | null;
      /** signed indentation shift applied to new_string, in characters */
      reindent: number;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------

const PLACEHOLDER = /^\s*(\/\/|#|\/\*|<!--)\s*\.{3}.*\b(rest|existing|unchanged|remaining|same)\b/i;

/**
 * §4.5 step 2: the first line of `text` that stands in for omitted code (`// ... rest unchanged`), unless the same line is
 * also in `keep` (old_string) — copying a comment the file already has is not an omission. A bare `...` is valid Python.
 */
export function placeholderLine(text: string, keep = ''): string | null {
  const kept = new Set(keep.split('\n').map((l) => l.trim()));
  for (const line of text.split('\n')) if (PLACEHOLDER.test(line) && !kept.has(line.trim())) return line.trim();
  return null;
}

// ---------------------------------------------------------------------------------------
// The file as lines, with offsets in both the LF view and the original bytes
// ---------------------------------------------------------------------------------------

interface FileView {
  bom: boolean;
  body: string;
  crlf: boolean;
  lines: string[];
  lf: string;
  lfStart: number[];
  origStart: number[];
}

function viewOf(content: string): FileView {
  const bom = content.startsWith('﻿');
  const body = bom ? content.slice(1) : content;
  const lines: string[] = [];
  const lfStart: number[] = [];
  const origStart: number[] = [];
  let crlfCount = 0;
  let lfCount = 0;
  let orig = 0;
  let lfPos = 0;
  for (;;) {
    const nl = body.indexOf('\n', orig);
    const end = nl < 0 ? body.length : nl;
    const cr = nl > 0 && body[nl - 1] === '\r';
    lfStart.push(lfPos);
    origStart.push(orig);
    lines.push(body.slice(orig, cr ? end - 1 : end));
    if (nl < 0) break;
    if (cr) crlfCount += 1;
    else lfCount += 1;
    lfPos += lines[lines.length - 1]!.length + 1;
    orig = nl + 1;
  }
  return { bom, body, crlf: crlfCount > lfCount, lines, lf: lines.join('\n'), lfStart, origStart };
}

/** An offset in the LF view → the offset in the original body. */
function toOrig(v: FileView, lfOffset: number): number {
  let lo = 0;
  let hi = v.lfStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (v.lfStart[mid]! <= lfOffset) lo = mid;
    else hi = mid - 1;
  }
  return v.origStart[lo]! + (lfOffset - v.lfStart[lo]!);
}

function lineOf(v: FileView, lfOffset: number): number {
  let n = 0;
  for (let i = 0; i < v.lfStart.length && v.lfStart[i]! <= lfOffset; i += 1) n = i;
  return n;
}

const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
const withEol = (s: string, crlf: boolean): string => (crlf ? s.replace(/\n/g, '\r\n') : s);

/** Replace `spans` (LF offsets, ascending, disjoint) with `replacement`, working on the original body. */
function splice(v: FileView, spans: readonly [number, number][], replacement: string): string {
  let out = '';
  let at = 0;
  for (const [s, e] of spans) {
    const os = toOrig(v, s);
    out += v.body.slice(at, os) + replacement;
    at = toOrig(v, e);
  }
  return (v.bom ? '﻿' : '') + out + v.body.slice(at);
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------------------
// Fallback matchers
// ---------------------------------------------------------------------------------------

interface Found {
  spans: [number, number][];
  how: EditHow;
  /** the matched line window (line matchers only), for re-indentation */
  window?: { start: number; oldLines: string[] };
  unescape?: boolean;
}

const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

function blockOf(old: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = old.endsWith('\n');
  const lines = (trailingNewline ? old.slice(0, -1) : old).split('\n');
  return { lines, trailingNewline };
}

function lineMatcher(v: FileView, old: string, same: (file: string[], old: string[]) => boolean, how: (file: string[], old: string[]) => EditHow): Found | null {
  const { lines: oldLines, trailingNewline } = blockOf(old);
  const k = oldLines.length;
  const starts: number[] = [];
  for (let i = 0; i + k <= v.lines.length; i += 1) if (same(v.lines.slice(i, i + k), oldLines)) starts.push(i);
  if (starts.length === 0) return null;
  const spans = starts.map((i): [number, number] => {
    const last = i + k - 1;
    let end = v.lfStart[last]! + v.lines[last]!.length;
    if (trailingNewline && last + 1 < v.lines.length) end += 1;
    return [v.lfStart[i]!, end];
  });
  const first = starts[0]!;
  return { spans, how: how(v.lines.slice(first, first + k), oldLines), window: { start: first, oldLines } };
}

function lineTrimmed(v: FileView, old: string): Found | null {
  return lineMatcher(
    v,
    old,
    (f, o) => f.every((line, j) => line.trim() === o[j]!.trim()),
    // only the leading whitespace differed → the model mis-indented; anything else → trailing whitespace too
    (f, o) => (f.every((line, j) => line.trimStart() === o[j]!.trimStart()) ? 'indentation' : 'whitespace'),
  );
}

function minIndent(lines: readonly string[]): number {
  let m = Infinity;
  for (const l of lines) if (l.trim() !== '') m = Math.min(m, leading(l).length);
  return m === Infinity ? 0 : m;
}

function indentationFlexible(v: FileView, old: string): Found | null {
  return lineMatcher(
    v,
    old,
    (f, o) => {
      const fi = minIndent(f);
      const oi = minIndent(o);
      return f.every((line, j) => (line.trim() === '' ? o[j]!.trim() === '' : line.slice(fi) === o[j]!.slice(oi)));
    },
    () => 'indentation',
  );
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function whitespaceNormalised(v: FileView, old: string): Found | null {
  const tokens = old.trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const before = /^\w/.test(tokens[0]!) ? '(?<!\\w)' : '';
  const after = /\w$/.test(tokens[tokens.length - 1]!) ? '(?!\\w)' : '';
  const re = new RegExp(`${before}${tokens.map(escapeRe).join('\\s+')}${after}`, 'g');
  const spans: [number, number][] = [];
  for (const m of v.lf.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  return spans.length === 0 ? null : { spans, how: 'whitespace' };
}

export function unescapeModelText(s: string): string {
  return s.replace(/\\(n|t|r|"|'|\\)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

function escapeNormalised(v: FileView, old: string): Found | null {
  const un = toLf(unescapeModelText(old));
  if (un === old) return null;
  const spans = occurrences(v.lf, un).map((s): [number, number] => [s, s + un.length]);
  return spans.length === 0 ? null : { spans, how: 'escapes', unescape: true };
}

// ---------------------------------------------------------------------------------------
// Re-indentation, the closest candidate, and the cascade
// ---------------------------------------------------------------------------------------

/** Shift every non-empty line of `text` from the model's indentation to the file's (`applyIndentation`). */
function reindent(text: string, fileIndent: string, oldIndent: string): { text: string; delta: number } {
  if (fileIndent === oldIndent) return { text, delta: 0 };
  const lines = text.split('\n');
  if (fileIndent.startsWith(oldIndent)) {
    const add = fileIndent.slice(oldIndent.length);
    return { text: lines.map((l) => (l.trim() === '' ? l : add + l)).join('\n'), delta: add.length };
  }
  if (oldIndent.startsWith(fileIndent)) {
    const cut = oldIndent.length - fileIndent.length;
    return { text: lines.map((l) => l.slice(Math.min(cut, leading(l).length))).join('\n'), delta: -cut };
  }
  return { text: lines.map((l) => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l)).join('\n'), delta: fileIndent.length - oldIndent.length };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.trim();
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>, la: string, lb: string): number {
  if (la.trim() === lb.trim()) return 1;
  let total = 0;
  let shared = 0;
  for (const n of a.values()) total += n;
  for (const [g, n] of b) {
    total += n;
    shared += Math.min(n, a.get(g) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

const CLOSEST_MIN_RATIO = 0.6;
const CLOSEST_SHOWN_LINES = 12;
const CLOSEST_MAX_PAIRS = 400_000;
const RE_READ = 'Re-read the file with read_file and copy old_string exactly (without the line-number prefix).';

function numbered(lines: readonly string[], first: number): string {
  return lines.map((l, i) => `${String(first + i).padStart(6)}\t${l.length > AGENT_READ_LINE_CHARS ? `${l.slice(0, AGENT_READ_LINE_CHARS)}… [line clipped]` : l}`).join('\n');
}

/** §4.5 step 7: the window of the file most similar to old_string, when it is similar enough to help. */
export function closestWindow(content: string, old: string): { start: number; lines: string[]; ratio: number } | null {
  const v = viewOf(content);
  const oldLines = blockOf(toLf(old)).lines;
  const k = oldLines.length;
  if (k === 0 || v.lines.length === 0) return null;
  const fileGrams = v.lines.map(bigrams);
  const oldGrams = oldLines.map(bigrams);
  const windows = Math.max(1, v.lines.length - k + 1);
  const stride = windows * k > CLOSEST_MAX_PAIRS ? Math.ceil((windows * k) / CLOSEST_MAX_PAIRS) : 1;
  let best: { start: number; ratio: number } | null = null;
  for (let i = 0; i < windows; i += stride) {
    let sum = 0;
    for (let j = 0; j < k && i + j < v.lines.length; j += 1) sum += dice(fileGrams[i + j]!, oldGrams[j]!, v.lines[i + j]!, oldLines[j]!);
    const ratio = sum / k;
    if (best === null || ratio > best.ratio) best = { start: i, ratio };
  }
  if (best === null || best.ratio < CLOSEST_MIN_RATIO) return null;
  return { start: best.start, lines: v.lines.slice(best.start, best.start + k), ratio: best.ratio };
}

function notFound(path: string, content: string, old: string): EditMatch {
  const c = closestWindow(content, old);
  if (c === null) return { ok: false, error: `ERROR: old_string not found in ${path}. ${RE_READ}` };
  const shown = c.lines.slice(0, CLOSEST_SHOWN_LINES);
  const a = c.start + 1;
  return { ok: false, error: `ERROR: old_string not found in ${path}. Closest match at lines ${a}-${c.start + c.lines.length}:\n${numbered(shown, a)}\n${RE_READ}` };
}

function ambiguous(path: string, v: FileView, spans: readonly [number, number][]): EditMatch {
  const lines = spans.slice(0, 10).map(([s]) => lineOf(v, s) + 1);
  return { ok: false, error: `ERROR: old_string matches ${spans.length} places in ${path} (lines ${lines.join(', ')}${spans.length > 10 ? ', …' : ''}); include more surrounding lines or set replace_all` };
}

function linesOfReplacement(v: FileView, start: number, replacement: string): [number, number] {
  const a = lineOf(v, start) + 1;
  const n = toLf(replacement).split('\n').length;
  return [a, a + Math.max(0, n - 1)];
}

/** Turn matched spans into the action the engine applies. */
function apply(v: FileView, spans: [number, number][], replacementLf: string, how: EditHow | null, delta: number): EditMatch {
  const replacement = withEol(replacementLf, v.crlf);
  const newContent = splice(v, spans, replacement);
  if (spans.length > 1) return { ok: true, action: { kind: 'write', content: newContent }, newContent, replacements: spans.length, lines: null, how, reindent: delta };
  const [s, e] = spans[0]!;
  const old = v.body.slice(toOrig(v, s), toOrig(v, e));
  // the engine's edit is exact and unique: a fallback span whose text also occurs elsewhere is written whole instead
  const action = old !== '' && occurrences(v.body, old).length === 1 ? { kind: 'edit' as const, old, new: replacement } : { kind: 'write' as const, content: newContent };
  return { ok: true, action, newContent, replacements: 1, lines: linesOfReplacement(v, s, replacementLf), how, reindent: delta };
}

/** §4.5: find old_string in `content` and build the engine action. `content` is the whole file (≤ 1 MiB). */
export function matchEdit(content: string, req: EditRequest): EditMatch {
  if (req.newString === req.oldString) return { ok: false, error: 'INVALID ARGUMENTS for edit_file: new_string is identical to old_string' };
  if (req.oldString === '') return { ok: false, error: 'INVALID ARGUMENTS for edit_file: old_string is empty; use write_file to create a file or replace a whole file' };
  const placeholder = placeholderLine(req.newString, req.oldString);
  if (placeholder !== null) return { ok: false, error: `ERROR: new_string contains a placeholder ("${placeholder}"); write the complete code` };
  const v = viewOf(content);
  const old = toLf(req.oldString);
  const neu = toLf(req.newString);

  const exact = occurrences(v.lf, old).map((s): [number, number] => [s, s + old.length]);
  if (exact.length === 1 || (exact.length > 1 && req.replaceAll)) return apply(v, exact, neu, null, 0);
  if (exact.length > 1) return ambiguous(req.path, v, exact);

  let firstAmbiguous: Found | null = null;
  for (const matcher of [lineTrimmed, indentationFlexible, whitespaceNormalised, escapeNormalised]) {
    const found = matcher(v, old);
    if (found === null) continue;
    if (found.spans.length > 1 && !req.replaceAll) {
      firstAmbiguous ??= found;
      continue;
    }
    // §4.5 step 6, the disproportion guard: a fallback span far larger than old_string is not what the model meant
    const oldLineCount = (found.unescape === true ? unescapeModelText(old) : old).split('\n').length;
    const limit = Math.max(oldLineCount + 3, 2 * oldLineCount);
    const tooBig = found.spans.some(([s, e]) => v.lf.slice(s, e).split('\n').length > limit);
    if (tooBig) return { ok: false, error: `ERROR: old_string only loosely matches ${req.path}, over a much larger span than old_string; ${RE_READ}` };
    let replacement = found.unescape === true ? toLf(unescapeModelText(neu)) : neu;
    let delta = 0;
    if (found.window !== undefined) {
      const j = found.window.oldLines.findIndex((l) => l.trim() !== '');
      if (j >= 0) {
        const r = reindent(replacement, leading(v.lines[found.window.start + j]!), leading(found.window.oldLines[j]!));
        replacement = r.text;
        delta = r.delta;
      }
    }
    return apply(v, found.spans, replacement, found.how, delta);
  }
  if (firstAmbiguous !== null) return ambiguous(req.path, v, firstAmbiguous.spans);
  return notFound(req.path, content, req.oldString);
}

/** The `OK: edited …` line of a successful edit (§4.3). */
export function editResultLine(path: string, m: Extract<EditMatch, { ok: true }>): string {
  const head = m.replacements === 1 && m.lines !== null ? `OK: edited ${path} (1 replacement, lines ${m.lines[0]}-${m.lines[1]})` : `OK: edited ${path} (${m.replacements} replacements)`;
  if (m.how === null) return head;
  return `${head} (matched after normalising ${m.how}${m.reindent !== 0 ? `; new_string re-indented by ${m.reindent}` : ''})`;
}
