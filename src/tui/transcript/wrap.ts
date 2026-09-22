/**
 * Body wrapping of a transcript row (TUI-DESIGN-3 §5.1 rule 3, D-L): pure, one string in, the rows out. For a body that
 * carries the ` · ` separator (a step summary, `blocking`, `/jev`, `/cost` rows) whole segments are packed greedily into
 * rows of the given width and a continuation row leads with the separator (`· tests 4p/3f/0e · …`), so a wrap never
 * splits a figure from its word; a segment wider than a row falls back to the word rule. Every other body word-wraps.
 * The no-orphan rule closes both: a final token narrower than `ORPHAN_MIN_CELLS` (`4`, `5))`, `ok`) never sits alone —
 * it takes the previous row's last word down with it (`… (gen $0.000, jev $0.025)` / `exit 4`, F-R6). Widths are cells
 * (`stringWidth`), so CJK and emoji bodies wrap where a terminal breaks them; a single token wider than the row is cut
 * by grapheme. Under `--ascii` the separator is ` - ` (`glyphs.dot`).
 *
 * Identity (§5.3): the rows never reorder, drop or add a token — strip each row's leading spaces, join with one space,
 * collapse space runs, and the body comes back byte for byte (`joinWrapped`). `transcript.log` and `--plain` never see
 * these rows; the TUI's `<Static>` is the only reader.
 */
import { stringWidth } from '../composer/width.js';
import { GLYPHS, type GlyphSet } from '../glyphs.js';

/** TUI-DESIGN-3 §5.1 rule 3: a final token narrower than this many cells joins the previous word on its row. */
export const ORPHAN_MIN_CELLS = 4;

/** the segment separator of a body in this glyph set (` · `, ` - ` under `--ascii`) */
export function segmentSeparator(g: GlyphSet = GLYPHS.unicode): string {
  return ` ${g.dot} `;
}

let graphemes: Intl.Segmenter | null = null;

/** a token wider than the row, cut by grapheme into pieces of at most `width` cells (the last piece may be narrower) */
function hardSplit(token: string, width: number): string[] {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const { segment } of graphemes.segment(token)) {
    const sw = stringWidth(segment);
    if (w > 0 && w + sw > width) {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += segment;
    w += sw;
  }
  if (cur !== '') out.push(cur);
  // the no-orphan rule inside a cut token: the last piece keeps ≥ ORPHAN_MIN_CELLS cells when the previous piece can spare them
  if (out.length >= 2) {
    let last = out[out.length - 1]!;
    let prev = out[out.length - 2]!;
    while (stringWidth(last) < ORPHAN_MIN_CELLS && stringWidth(prev) > ORPHAN_MIN_CELLS) {
      const clusters = [...graphemes.segment(prev)].map((x) => x.segment);
      const moved = clusters.pop()!;
      prev = clusters.join('');
      last = `${moved}${last}`;
    }
    out[out.length - 2] = prev;
    out[out.length - 1] = last;
  }
  return out;
}

/** the words of a chunk laid greedily into rows of ≤ `room(rowIndex)` cells; a word wider than its row is cut by grapheme */
function packWords(words: readonly string[], room: (rowIndex: number) => number, startRow: number, seed: string): { rows: string[]; last: string } {
  const rows: string[] = [];
  let cur = seed;
  let index = startRow;
  const push = (): void => {
    rows.push(cur);
    cur = '';
    index += 1;
  };
  for (const word of words) {
    const next = cur === '' ? word : `${cur} ${word}`;
    if (stringWidth(next) <= room(index)) {
      cur = next;
      continue;
    }
    if (cur !== '') push();
    if (stringWidth(word) <= room(index)) {
      cur = word;
      continue;
    }
    const pieces = hardSplit(word, Math.max(1, room(index)));
    for (let i = 0; i < pieces.length; i++) {
      cur = pieces[i]!;
      if (i < pieces.length - 1) push();
    }
  }
  return { rows, last: cur };
}

/**
 * Greedy word wrap of `text` into rows of ≤ `width` cells; `prefix` opens every row after the first (a leading `· `). A run of
 * two or more spaces is a group boundary (TUI-DESIGN-3 §5.1 rule 4: the epilogue's `<value>  (transcript.log, …)` keeps its
 * parenthetical whole on the next row rather than splitting it at the first word that fits); inside a group the words pack
 * greedily. Every character of every token is kept (§5.3).
 */
function wordWrap(text: string, width: number, prefix = ''): string[] {
  if (text.trim() === '') return [text];
  const parts = text.split(/( {2,})/);
  const rows: string[] = [];
  let cur = '';
  const room = (rowIndex: number): number => (rowIndex === 0 ? width : width - stringWidth(prefix));
  const flush = (): void => {
    rows.push(rows.length === 0 ? cur : `${prefix}${cur}`);
    cur = '';
  };
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i]!;
    if (i % 2 === 1 || chunk === '') continue; // a gap, or the empty edge of a split
    const gap = i > 0 ? parts[i - 1]! : '';
    const candidate = cur === '' ? chunk : `${cur}${gap}${chunk}`;
    if (stringWidth(candidate) <= room(rows.length)) {
      cur = candidate;
      continue;
    }
    if (cur !== '') flush();
    if (stringWidth(chunk) <= room(rows.length)) {
      cur = chunk;
      continue;
    }
    const packed = packWords(chunk.split(' ').filter((w) => w !== ''), room, rows.length, '');
    for (const r of packed.rows) {
      cur = r;
      flush();
    }
    cur = packed.last;
  }
  if (cur !== '' || rows.length === 0) flush();
  return rows;
}

/**
 * TUI-DESIGN-3 §5.1 rule 3: the no-orphan rule over word-wrapped rows — when the final row's own text (after any
 * separator prefix) is narrower than `ORPHAN_MIN_CELLS` and the previous row holds at least two tokens, the previous
 * row's last token moves down to join it, provided the joined row still fits `width`.
 */
export function joinOrphan(rows: readonly string[], width: number, prefix = ''): string[] {
  if (rows.length < 2) return [...rows];
  const out = [...rows];
  const last = out[out.length - 1]!;
  const lastPrefix = prefix !== '' && last.startsWith(prefix) ? prefix : '';
  const lastBody = last.slice(lastPrefix.length);
  if (lastBody === '' || stringWidth(lastBody) >= ORPHAN_MIN_CELLS) return out;
  const prevIndex = out.length - 2;
  const prev = out[prevIndex]!;
  const prevPrefix = prevIndex > 0 && prefix !== '' && prev.startsWith(prefix) ? prefix : '';
  const prevBody = prev.slice(prevPrefix.length);
  const sp = prevBody.lastIndexOf(' ');
  if (sp <= 0) return out;
  const token = prevBody.slice(sp + 1);
  const head = prevBody.slice(0, sp);
  if (token === '' || head.trim() === '') return out;
  // never across a segment boundary: the separator itself is not a token to move, and a segment's last word stays with its segment
  const dot = prefix.trim();
  if (dot !== '' && (token === dot || head.endsWith(` ${dot}`) || head === dot)) return out;
  const joined = `${lastPrefix}${token} ${lastBody}`;
  if (stringWidth(joined) > width) return out;
  out[prevIndex] = `${prevPrefix}${head}`;
  out[out.length - 1] = joined;
  return out;
}

/**
 * TUI-DESIGN-3 §5.1 rule 3 (D-L): the rows of a body at `width` cells — segment-aware (` · `) with the separator leading
 * every continuation row, word wrap otherwise, the no-orphan rule last. `width ≤ 0` or a non-finite width returns the
 * body as one row (the caller had no geometry). Never adds, drops or reorders a token (§5.3).
 */
export function wrapBody(text: string, width: number, g: GlyphSet = GLYPHS.unicode): string[] {
  if (!Number.isFinite(width) || width <= 0) return [text];
  const w = Math.floor(width);
  if (stringWidth(text) <= w) return [text];
  const sep = segmentSeparator(g);
  const lead = `${g.dot} `;
  if (!text.includes(sep)) return joinOrphan(wordWrap(text, w), w);
  const segments = text.split(sep);
  const rows: string[] = [];
  let cur = '';
  for (const seg of segments) {
    const first = rows.length === 0 && cur === '';
    const candidate = cur === '' ? (first ? seg : `${lead}${seg}`) : `${cur}${sep}${seg}`;
    if (stringWidth(candidate) <= w) {
      cur = candidate;
      continue;
    }
    if (cur !== '') rows.push(cur);
    const own = rows.length === 0 ? seg : `${lead}${seg}`;
    if (stringWidth(own) <= w) {
      cur = own;
      continue;
    }
    // a segment wider than a row: the word rule inside it — the separator is the first word of its first row, so the
    // rows after it carry no separator (the §5.3 join would otherwise invent one)
    let wrapped = wordWrap(own, w);
    // the segment's first word is itself wider than the row: keep the separator glued to its first piece (never a lone `·` row)
    if (wrapped[0] === g.dot) wrapped = wordWrap(seg, w - stringWidth(lead)).map((r, k) => (k === 0 ? `${lead}${r}` : r));
    rows.push(...wrapped.slice(0, -1));
    cur = wrapped[wrapped.length - 1] ?? '';
  }
  if (cur !== '') rows.push(cur);
  return joinOrphan(rows, w, lead);
}

/**
 * TUI-DESIGN-3 §5.3 — the identity normaliser (R5 `polish.md:521`, no separator clause): strip the leading spaces of
 * every row, join with one space, collapse space runs. For any rows `wrapBody` produced this returns the body — exactly
 * whenever no single token is wider than the row (a 71-cell path at a 40-cell width is cut by grapheme, and the join then
 * carries one space inside it; nothing is lost); for a rendered item (label row + hanging continuations) it returns
 * `formatTranscriptItem(item)`.
 */
export function joinWrapped(rows: readonly string[]): string {
  return rows
    .map((r) => r.replace(/^ +/, ''))
    .join(' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
