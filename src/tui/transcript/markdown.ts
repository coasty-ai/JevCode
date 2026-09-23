/**
 * Light markdown for the assistant's streamed prose (AGENT-LOOP-DESIGN §9.4, §A1; slice S5a): the reply block above the
 * rule and the `[jevcode]` rows it commits to `<Static>` draw every line through `proseRows`, so a line looks the same
 * while it streams and after it lands — which is what makes the commit a zero-jump move.
 *
 * What is rendered, and nothing else:
 * - `**bold**` → bold (markers hidden); a backtick span → the `code` role (markers hidden);
 * - `- item` / `* item` / `+ item` → `• item`, the wrap hanging under the item's text; `1. item` hangs the same way;
 * - `# heading` (1–6 `#`) → the heading text, bold;
 * - a fence line (```` ```lang ````) → `╶──── lang` in the `code` role (the legacy transcript's fence row), and the lines
 *   between two fences in the `code` role, verbatim, hard-wrapped by cells (code keeps its spacing).
 *
 * Every marker is a TOGGLE read left to right, and an unclosed one stays open to the end of the line. That is a deliberate
 * choice over "only render a closed pair": a toggle's effect depends only on the text before it, so the rows of a partial
 * line are a prefix of the rows of the finished line (the reply tail streams in place and may commit its finished rows
 * early). The one thing a later delta could still change is a trailing `*` (it may become `**`), so a PARTIAL line holds
 * it back, together with a trailing emoji/regional-indicator cluster that a following modifier could still widen.
 *
 * Pure and Ink-free: offsets are indices into the DISPLAY string (markers removed); `proseRows` cuts a display range
 * `[from, to)` so an overflow commit can split one line into two items that draw exactly the rows it replaces.
 */
import { GLYPHS, type GlyphSet } from '../glyphs.js';
import { wrapCells, wrapProse, type ProseWrap } from './wrap.js';

/** The kind of a prose line: running text, a line inside a fenced code block, or the fence line itself. */
export type ProseRole = 'text' | 'code' | 'fence';
/** The style of a run of display text. */
export type ProseStyle = 'plain' | 'bold' | 'code' | 'bullet' | 'heading';

/** A styled run `[from, to)` of a line's display text. */
export interface ProseRun {
  readonly from: number;
  readonly to: number;
  readonly style: ProseStyle;
}

/** A parsed line: what is drawn, how it is styled, and the hang its continuation rows take (a bullet's text column). */
export interface ProseLine {
  readonly display: string;
  readonly runs: readonly ProseRun[];
  readonly hang: number;
}

/** A styled piece of one drawn row. */
export interface ProseRowPart {
  readonly text: string;
  readonly style: ProseStyle;
}

/** One drawn row: its styled parts and the display range `[start, end)` of the line it shows. */
export interface ProseRow {
  readonly parts: readonly ProseRowPart[];
  readonly start: number;
  readonly end: number;
}

/** A fence line: optional indentation, three backticks, an optional info string. */
export const PROSE_FENCE_RE = /^\s*```/;

/** True for a line that opens or closes a fenced code block. */
export function isFenceLine(line: string): boolean {
  return PROSE_FENCE_RE.test(line);
}

/** The drawn form of a fence line — `╶──── lang` (`-----` under `--ascii`), the legacy transcript's fence row. */
export function fenceDisplay(line: string, g: GlyphSet = GLYPHS.unicode): string {
  const lang = line.replace(PROSE_FENCE_RE, '').trim().split(/\s+/)[0] ?? '';
  return `${g.fence}${g.rule.repeat(4)}${lang === '' ? '' : ` ${lang}`}`;
}

/** Tabs draw as four spaces in code and prose alike (a terminal's tab stops would make the width unknowable). */
function detab(s: string): string {
  return s.includes('\t') ? s.replaceAll('\t', '    ') : s;
}

const PICTOGRAPHIC_TAIL_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|‍)️?$/u;

/**
 * What a PARTIAL line shows: a trailing `*` is held (it may still become `**`), and so is a trailing pictographic or
 * regional-indicator cluster (a skin-tone modifier, a ZWJ or the second flag letter may still widen or join it).
 */
export function holdBack(line: string): string {
  let s = line;
  if (s.endsWith('*') && !s.endsWith('**')) s = s.slice(0, -1);
  const m = PICTOGRAPHIC_TAIL_RE.exec(s);
  if (m !== null) s = s.slice(0, m.index);
  return s;
}

/** The inline toggles (`**`, a backtick) over `text`, appended to `out` at display offset `base`. */
function inline(text: string, base: number, runs: ProseRun[], bold0 = false): string {
  let display = '';
  let bold = bold0;
  let code = false;
  let runStart = 0;
  let runStyle: ProseStyle = bold ? 'bold' : 'plain';
  const close = (): void => {
    if (display.length > runStart) runs.push({ from: base + runStart, to: base + display.length, style: runStyle });
    runStart = display.length;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '`') {
      close();
      code = !code;
      runStyle = code ? 'code' : bold ? 'bold' : 'plain';
      continue;
    }
    if (!code && ch === '*' && text[i + 1] === '*') {
      close();
      bold = !bold;
      runStyle = bold ? 'bold' : 'plain';
      i += 1;
      continue;
    }
    display += ch;
  }
  close();
  return display;
}

const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/s;
const NUMBERED_RE = /^(\s*)(\d{1,3}[.)])\s+(.*)$/s;
const HEADING_RE = /^(#{1,6})\s+(.*)$/s;

/** Parse one line of prose into its display text, styled runs and hang. `partial` applies the hold-back rule. */
export function parseProse(line: string, role: ProseRole, g: GlyphSet = GLYPHS.unicode, partial = false): ProseLine {
  if (role === 'fence') {
    const display = fenceDisplay(line, g);
    return { display, runs: [{ from: 0, to: display.length, style: 'code' }], hang: 0 };
  }
  const raw = detab(partial ? holdBack(line) : line);
  if (role === 'code') return { display: raw, runs: raw === '' ? [] : [{ from: 0, to: raw.length, style: 'code' }], hang: 0 };
  const runs: ProseRun[] = [];
  const h = HEADING_RE.exec(raw);
  if (h !== null) {
    const display = inline(h[2]!, 0, runs, true);
    return { display, runs: runs.map((r) => (r.style === 'plain' || r.style === 'bold' ? { ...r, style: 'heading' as const } : r)), hang: 0 };
  }
  const b = BULLET_RE.exec(raw);
  if (b !== null && !(b[2] === '*' && raw.trimStart().startsWith('**'))) {
    const indent = b[1]!;
    const head = `${indent}${g.bullet} `;
    runs.push({ from: indent.length, to: indent.length + g.bullet.length, style: 'bullet' });
    const display = head + inline(b[3]!, head.length, runs);
    return { display, runs, hang: head.length };
  }
  const n = NUMBERED_RE.exec(raw);
  if (n !== null) {
    const head = `${n[1]!}${n[2]!} `;
    const display = head + inline(n[3]!, head.length, runs);
    return { display, runs, hang: head.length };
  }
  return { display: inline(raw, 0, runs), runs, hang: 0 };
}

/** The parts of the display range `[start, end)` under `runs`, prefixed by `lead` plain spaces. */
function partsOf(display: string, runs: readonly ProseRun[], start: number, end: number, lead: string): ProseRowPart[] {
  const parts: ProseRowPart[] = [];
  if (lead !== '') parts.push({ text: lead, style: 'plain' });
  let at = start;
  for (const r of runs) {
    if (r.to <= at || r.from >= end) continue;
    if (r.from > at) parts.push({ text: display.slice(at, r.from), style: 'plain' });
    const a = Math.max(r.from, at);
    const b = Math.min(r.to, end);
    if (b > a) parts.push({ text: display.slice(a, b), style: r.style });
    at = Math.max(at, b);
  }
  if (at < end) parts.push({ text: display.slice(at, end), style: 'plain' });
  return parts;
}

/** The options of one line's layout. */
export interface ProseRowsOptions {
  /** the display offset this item starts at (an overflow commit's continuation); default 0 */
  readonly from?: number;
  /** the display offset this item ends at (the head of an overflow commit); default the end of the line */
  readonly to?: number;
  /** a line still streaming: apply the hold-back rule */
  readonly partial?: boolean;
  readonly glyphs?: GlyphSet;
}

/**
 * The drawn rows of one prose line at `width` body cells: parse, wrap from `from` (word wrap for text with the bullet
 * hang, cell wrap for code; a `from` past 0 is a continuation, so its first row takes the hang too), keep the rows that
 * START before `to`, and split every row into styled parts. The cut is by rows, never by re-wrapping a truncated text: a
 * head `[0, to)` draws exactly the first rows the whole line draws (a word cut short at `to` could otherwise climb onto the
 * row before it). The rows' `start`/`end` are display offsets of the WHOLE line, so a caller can cut again at any row start.
 */
export function proseRows(line: string, role: ProseRole, width: number, o: ProseRowsOptions = {}): ProseRow[] {
  const g = o.glyphs ?? GLYPHS.unicode;
  const p = parseProse(line, role, g, o.partial === true);
  const from = Math.max(0, Math.min(o.from ?? 0, p.display.length));
  const to = o.to === undefined ? Number.POSITIVE_INFINITY : Math.max(from, o.to);
  const slice = p.display.slice(from);
  const wrapped: ProseWrap = role === 'text' ? wrapProse(slice, width, p.hang, from > 0) : wrapCells(slice, width);
  const rows: ProseRow[] = [];
  wrapped.rows.forEach((row, i) => {
    const start = from + (wrapped.starts[i] ?? 0);
    if (i > 0 && start >= to) return;
    const end = from + (wrapped.ends[i] ?? 0);
    const lead = row.slice(0, row.length - (end - start));
    rows.push({ parts: partsOf(p.display, p.runs, start, end, lead), start, end });
  });
  return rows;
}

/** The display length of a line (the `to` bound of a whole line), with the hold-back rule when `partial`. */
export function proseDisplayLength(line: string, role: ProseRole, g: GlyphSet = GLYPHS.unicode, partial = false): number {
  return parseProse(line, role, g, partial).display.length;
}

/** The plain text of a drawn row (its parts joined) — the string a test or a screen-reader twin compares. */
export function proseRowText(row: ProseRow): string {
  return row.parts.map((p) => p.text).join('');
}
