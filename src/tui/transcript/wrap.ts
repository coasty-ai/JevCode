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
 * Identity (§5.3, strengthened by TUI-DESIGN-4 §2.4 / P-R3): the rows never reorder, drop or add a token — strip each
 * row's leading spaces, join the rows, collapse space runs, and the body comes back byte for byte. The join is one
 * space **except at a cut**, where it is the empty string: at the supported minimum of 40 columns the body width is 30,
 * so any path, sha or run id of 31+ cells is hard-split by grapheme and the old unconditional space join was wrong
 * (measured: `edited packages/app/src/components/SomeVeryLongName.test.tsx in one step` fails at widths 30 and 40 and
 * passes at 70). `wrapBodyCut` reports those row indices as `cuts`; `wrapBody` stays the thin wrapper that drops them,
 * so **no caller changes**, and `joinWrapped(rows, cuts)` is now exact at every width. `transcript.log` and `--plain`
 * never see these rows; the TUI's `<Static>` is the only reader.
 */
import { stringWidth } from '../composer/width.js';
import { GLYPHS, type GlyphSet } from '../glyphs.js';

/** TUI-DESIGN-3 §5.1 rule 3: a final token narrower than this many cells joins the previous word on its row. */
export const ORPHAN_MIN_CELLS = 4;

/**
 * TUI-DESIGN-4 §2.4 (P-R3): a wrapped body and the rows that continue their predecessor **mid-token**. `cuts` holds
 * row indices (never 0), ascending and unique: `rows[i]` was produced by a grapheme cut of the token that ends
 * `rows[i − 1]`, so the §5.3 join must put no space between them. Row indices, never cell offsets, so a cut inside a
 * wide (CJK) cluster needs no special case.
 */
export interface WrappedBody {
  rows: string[];
  /** indices `i` where `rows[i]` continues `rows[i − 1]` mid-token */
  cuts: readonly number[];
}

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

/** rows plus the row still being filled, and the cut indices over `[...rows, last]` (TUI-DESIGN-4 §2.4). */
interface Packed {
  rows: string[];
  last: string;
  cuts: number[];
}

/**
 * the words of a chunk laid greedily into rows of ≤ `room(rowIndex)` cells; a word wider than its row is cut by
 * grapheme, and every piece after the first opens a row that continues its predecessor mid-token (a **cut**, indexed
 * over `[...rows, last]`).
 */
function packWords(words: readonly string[], room: (rowIndex: number) => number, startRow: number, seed: string): Packed {
  const rows: string[] = [];
  const cuts: number[] = [];
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
      // pieces[i] (i ≥ 1) opens the row `rows.length`, directly after pieces[i − 1] was pushed: that row is a cut
      if (i > 0) cuts.push(rows.length);
      cur = pieces[i]!;
      if (i < pieces.length - 1) push();
    }
  }
  return { rows, last: cur, cuts };
}

/**
 * Greedy word wrap of `text` into rows of ≤ `width` cells; `prefix` opens every row after the first (a leading `· `). A run of
 * two or more spaces is a group boundary (TUI-DESIGN-3 §5.1 rule 4: the epilogue's `<value>  (transcript.log, …)` keeps its
 * parenthetical whole on the next row rather than splitting it at the first word that fits); inside a group the words pack
 * greedily. Every character of every token is kept (§5.3), and a grapheme cut is reported as a cut row (§2.4).
 */
function wordWrap(text: string, width: number, prefix = ''): WrappedBody {
  if (text.trim() === '') return { rows: [text], cuts: [] };
  const parts = text.split(/( {2,})/);
  const rows: string[] = [];
  const cuts: number[] = [];
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
    // `packWords` indexes its cuts over `[...its rows, its last]`, which lands at `rows.length + c` here: its rows are
    // pushed in order from the current length and its `last` becomes `cur`, which is flushed at that same index.
    const base = rows.length;
    const packed = packWords(chunk.split(' ').filter((w) => w !== ''), room, rows.length, '');
    for (const c of packed.cuts) cuts.push(base + c);
    for (const r of packed.rows) {
      cur = r;
      flush();
    }
    cur = packed.last;
  }
  if (cur !== '' || rows.length === 0) flush();
  return { rows, cuts };
}

/**
 * TUI-DESIGN-3 §5.1 rule 3: the no-orphan rule over word-wrapped rows — when the final row's own text (after any
 * separator prefix) is narrower than `ORPHAN_MIN_CELLS` and the previous row holds at least two tokens, the previous
 * row's last token moves down to join it, provided the joined row still fits `width`.
 *
 * TUI-DESIGN-4 §2.4 edge 4: it moves **whole tokens only**, so it must never move one into a row that continues its
 * predecessor mid-token — `… abc` + `def` would gain a space that the cut says is not there. A cut final row is left
 * alone. No row is added or removed either way, so every cut index survives unchanged.
 */
export function joinOrphan(rows: readonly string[], width: number, prefix = '', cuts: readonly number[] = []): string[] {
  if (rows.length < 2) return [...rows];
  const out = [...rows];
  if (cuts.includes(out.length - 1)) return out;
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
 * TUI-DESIGN-3 §5.1 rule 3 (D-L) + TUI-DESIGN-4 §2.4 (P-R3): the rows of a body at `width` cells **and** the indices of
 * the rows that continue their predecessor mid-token — segment-aware (` · `) with the separator leading every
 * continuation row, word wrap otherwise, the no-orphan rule last. `width ≤ 0` or a non-finite width returns the body as
 * one row with no cuts (the caller had no geometry). Never adds, drops or reorders a token (§5.3).
 */
export function wrapBodyCut(text: string, width: number, g: GlyphSet = GLYPHS.unicode): WrappedBody {
  if (!Number.isFinite(width) || width <= 0) return { rows: [text], cuts: [] };
  const w = Math.floor(width);
  if (stringWidth(text) <= w) return { rows: [text], cuts: [] };
  const sep = segmentSeparator(g);
  const lead = `${g.dot} `;
  /**
   * §11's frame rule ("no row is ever wider than the terminal") beats the segment rule when there is no room for
   * both. A continuation row opens with `lead` (2 cells), so a segment row needs `stringWidth(lead) + 1` cells to
   * carry one cell of content; at `width ≤ 2` the segment branch used to commit a 3-cell `· c` row into a 1- and
   * 2-column terminal (measured: `a · b · c` at 1 and 2 → `["a","· b","· c"]`, in BOTH renderers, because
   * `itemRenderRows` and `buildIndex` call this one function). Below that floor the whole body takes the word rule,
   * which §2.4 already names as the fallback "a segment wider than a row falls back to the word rule" — at these
   * widths every segment is. The §5.3 join is unaffected: `joinWrapped(["a","·","b","·","c"])` is the body again.
   */
  if (!text.includes(sep) || w <= stringWidth(lead)) {
    const wrapped = wordWrap(text, w);
    return { rows: joinOrphan(wrapped.rows, w, '', wrapped.cuts), cuts: wrapped.cuts };
  }
  const segments = text.split(sep);
  const rows: string[] = [];
  const cuts: number[] = [];
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
    // the segment's first word is itself wider than the row: keep the separator glued to its first piece (never a
    // lone `·` row) — but only when the glued row still FITS. `· 本` is 4 cells: at 3 columns the cosmetic rule
    // used to commit a row wider than the terminal, which §11 forbids, so there the lone `·` row stands. The §5.3
    // join returns the body in both shapes (`joinWrapped(['·','本']) === '· 本'`).
    if (wrapped.rows[0] === g.dot) {
      const room = w - stringWidth(lead);
      const inner = room > 0 ? wordWrap(seg, room) : null;
      if (inner && stringWidth(`${lead}${inner.rows[0] ?? ''}`) <= w) wrapped = { rows: inner.rows.map((r, k) => (k === 0 ? `${lead}${r}` : r)), cuts: inner.cuts };
    }
    // `cur` is always pushed at `rows.length`, so the wrapped block occupies `[base, base + wrapped.rows.length)`
    const base = rows.length;
    for (const c of wrapped.cuts) cuts.push(base + c);
    rows.push(...wrapped.rows.slice(0, -1));
    cur = wrapped.rows[wrapped.rows.length - 1] ?? '';
  }
  if (cur !== '') rows.push(cur);
  return { rows: joinOrphan(rows, w, lead, cuts), cuts };
}

/**
 * TUI-DESIGN-3 §5.1 rule 3 (D-L): the rows of a body at `width` cells — the thin wrapper over `wrapBodyCut` that drops
 * the cut list, so every caller that only draws rows is unchanged.
 */
export function wrapBody(text: string, width: number, g: GlyphSet = GLYPHS.unicode): string[] {
  return wrapBodyCut(text, width, g).rows;
}

/**
 * TUI-DESIGN-3 §5.3 / TUI-DESIGN-4 §2.4 — the identity normaliser (R5 `polish.md:521`, no separator clause): strip the
 * leading spaces of every row, join with one space **except at a cut**, where the join is empty, collapse space runs.
 * For any rows `wrapBodyCut` produced this returns the body **unconditionally**, at every width; called without `cuts`
 * (the default `[]`) it is exactly the round-3 behaviour, so the two existing helpers keep compiling. For a rendered
 * item (label row + hanging continuations) it returns `formatTranscriptItem(item)`.
 */
export function joinWrapped(rows: readonly string[], cuts: readonly number[] = []): string {
  const cut = new Set(cuts);
  let out = '';
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] ?? '').replace(/^ +/, '');
    out = i === 0 ? row : `${out}${cut.has(i) ? '' : ' '}${row}`;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}
