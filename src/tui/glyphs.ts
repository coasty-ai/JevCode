/**
 * Glyph table for the three visual twins (TUI-DESIGN §14.1 "Unicode" row, §7.2 bars, §6.5 screen
 * reader): every glyph the pane, review box, banner and bars draw has a `--ascii` substitute, and
 * the screen-reader set reuses the unicode glyphs (bars are replaced by aria text in bars.ts).
 * Also the cell-width helpers every line builder uses to honour its `columns` argument. Pure.
 */
import { sanitizeStream } from './plain.js';

export type GlyphMode = 'unicode' | 'ascii' | 'sr';

export interface GlyphSet {
  readonly mode: GlyphMode;
  /** rule row fill: `─` → `-` */
  readonly rule: string;
  /** loop banner signature separator: `›` → `>` */
  readonly chevron: string;
  /** `✓` → `+` */
  readonly check: string;
  /** `✗` → `x` */
  readonly cross: string;
  /** `↑` → `^` */
  readonly up: string;
  /** `↓` → `v` */
  readonly down: string;
  /** git zone `⎇` → `br` */
  readonly branch: string;
  /** `†` → `+` */
  readonly dagger: string;
  /** `•` → `*` */
  readonly bullet: string;
  /** bar track and separator `·` → `-` */
  readonly dot: string;
  /** review ruler band mark `┆` → `:` */
  readonly band: string;
  /** full bar cell `█` → `#` */
  readonly full: string;
  /** partial bar cells by eighths 1..7: `▏▎▍▌▋▊▉` → `1234567`; index 0 is the empty cell (never drawn) */
  readonly eighths: readonly string[];
  /** sparkline levels 0..8: index 0 = a failed attempt (space), 1..8 = `▁▂▃▄▅▆▇█` → `12345678` */
  readonly spark: readonly string[];
  /** spinner frames (braille → `|/-\`) */
  readonly spinner: readonly string[];
  /** the static spinner glyph under reduced motion (§7.4, §14.2): `•` → `*` (the same cell as `bullet`, so the ASCII twin table stays one-to-one) */
  readonly spinnerStatic: string;
  /** truncation mark `…` → `...` */
  readonly ellipsis: string;
  /** side-by-side pane divider `│` → `|` */
  readonly vbar: string;
  /** follow-up box corners and edges (§9.3 box) */
  readonly boxTopLeft: string;
  readonly boxTopRight: string;
  readonly boxBottomLeft: string;
  readonly boxBottomRight: string;
  readonly boxHorizontal: string;
  readonly boxVertical: string;
  /** `−` (minus sign in `|2p−1|`) → `-` */
  readonly minus: string;
  /** `→` → `->` */
  readonly arrow: string;
  /** `≥` → `>=` */
  readonly ge: string;
  /** `≤` → `<=` */
  readonly le: string;
  /** `×` → `x` */
  readonly times: string;
  /** `⚠` → `!` */
  readonly warn: string;
  /** em dash used for "not judged" cells `—` → `-` */
  readonly dash: string;
  /** `Σ` → `sum` */
  readonly sigma: string;
  /** `≈` → `~=` */
  readonly approx: string;
  /** range dash `–` (U+2013, §7.6 `outside 0.2–0.8`) → `-` */
  readonly range: string;
}

const UNICODE: GlyphSet = {
  mode: 'unicode',
  rule: '─',
  chevron: '›',
  check: '✓',
  cross: '✗',
  up: '↑',
  down: '↓',
  branch: '⎇',
  dagger: '†',
  bullet: '•',
  dot: '·',
  band: '┆',
  full: '█',
  eighths: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'],
  spark: [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spinnerStatic: '•',
  ellipsis: '…',
  vbar: '│',
  boxTopLeft: '┌',
  boxTopRight: '┐',
  boxBottomLeft: '└',
  boxBottomRight: '┘',
  boxHorizontal: '─',
  boxVertical: '│',
  minus: '−',
  arrow: '→',
  ge: '≥',
  le: '≤',
  times: '×',
  warn: '⚠',
  dash: '—',
  sigma: 'Σ',
  approx: '≈',
  range: '–',
};

const ASCII: GlyphSet = {
  mode: 'ascii',
  rule: '-',
  chevron: '>',
  check: '+',
  cross: 'x',
  up: '^',
  down: 'v',
  branch: 'br',
  dagger: '+',
  bullet: '*',
  dot: '-',
  band: ':',
  full: '#',
  eighths: ['', '1', '2', '3', '4', '5', '6', '7'],
  spark: [' ', '1', '2', '3', '4', '5', '6', '7', '8'],
  spinner: ['|', '/', '-', '\\'],
  spinnerStatic: '*',
  ellipsis: '...',
  vbar: '|',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
  minus: '-',
  arrow: '->',
  ge: '>=',
  le: '<=',
  times: 'x',
  warn: '!',
  dash: '-',
  sigma: 'sum',
  approx: '~=',
  range: '-',
};

/** Screen-reader twin: the unicode glyphs (bars are replaced by aria text in bars.ts, §7.2). */
const SR: GlyphSet = { ...UNICODE, mode: 'sr' };

/** TUI-DESIGN §14.1: the glyph table and its `--ascii` twin, plus the screen-reader set. */
export const GLYPHS: Readonly<Record<GlyphMode, GlyphSet>> = { unicode: UNICODE, ascii: ASCII, sr: SR };

/** TUI-DESIGN §14.1: the glyph set for a mode (`ascii` wins over `sr` when both are requested: an SR user on `--ascii` still gets ASCII cells). */
export function glyphSet(opts: { ascii?: boolean; screenReader?: boolean } = {}): GlyphSet {
  if (opts.ascii) return ASCII;
  return opts.screenReader ? SR : UNICODE;
}

let asciiTwinMap: Map<string, string> | null = null;
/** unicode glyph → ASCII twin for every single-glyph entry of the table (arrays pairwise; the first entry for a glyph wins, so `█` is `full`'s `#`, not `spark[8]`); built once. */
function asciiTwins(): Map<string, string> {
  if (asciiTwinMap) return asciiTwinMap;
  const m = new Map<string, string>();
  for (const key of Object.keys(UNICODE) as (keyof GlyphSet)[]) {
    if (key === 'mode') continue;
    const u = UNICODE[key];
    const a = ASCII[key];
    if (typeof u === 'string' && typeof a === 'string') {
      if (u.length > 0 && u !== a && !m.has(u)) m.set(u, a);
    } else if (Array.isArray(u) && Array.isArray(a)) {
      u.forEach((g, i) => {
        const t = a[i];
        if (typeof g === 'string' && typeof t === 'string' && g.length > 0 && g !== t && !m.has(g)) m.set(g, t);
      });
    }
  }
  asciiTwinMap = m;
  return m;
}

/** TUI-DESIGN §14.1: render a code-generated string (a consumer rule, a formula) in the glyph set — under `--ascii` every glyph of the unicode table becomes its twin (`→` → `->`, `≥` → `>=`); identity for the unicode and SR sets. Never applied to user text. */
export function glyphTwin(s: string, g: GlyphSet): string {
  if (g.mode !== 'ascii' || ASCII_PRINTABLE_RE.test(s)) return s;
  const m = asciiTwins();
  let out = '';
  for (const ch of s) out += m.get(ch) ?? ch;
  return out;
}

/** Width of the `sN` step label shared by a set of rows: 2 cells up to s9, 3 from s10, one more per further digit (§24 `s7 intent`, F-Q `s12 judge`). */
export function stepLabelCells(steps: Iterable<number>): number {
  let cells = 2;
  for (const step of steps) {
    const n = Number.isFinite(step) ? Math.abs(Math.trunc(step)) : 0;
    cells = Math.max(cells, 1 + String(n).length + (step < 0 ? 1 : 0));
  }
  return cells;
}

// ---------------------------------------------------------------------------------------
// Cell widths (a local stub of O2's composer/width.ts so every builder here can honour `columns`)
// ---------------------------------------------------------------------------------------

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]*$/;
let segmenter: Intl.Segmenter | null = null;

function graphemes(s: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: string[] = [];
  for (const seg of segmenter.segment(s)) out.push(seg.segment);
  return out;
}

/** Code points that join neighbours into one cluster whose width is not the sum of its parts: ZWJ, VS16, regional indicators (flags), skin-tone modifiers. Only these need grapheme segmentation. */
function joinsCluster(cp: number): boolean {
  return cp === 0x200d || cp === 0xfe0f || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

function needsSegmentation(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x200d) continue;
    if (c === 0x200d || c === 0xfe0f) return true;
    if (c === 0xd83c && joinsCluster(s.codePointAt(i) ?? 0)) return true;
  }
  return false;
}

/** Iteration units for truncation: grapheme clusters only when a joiner is present, code points otherwise (an order of magnitude faster on bar and box glyphs). */
function units(s: string): Iterable<string> {
  return needsSegmentation(s) ? graphemes(s) : s;
}

function isZeroWidth(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f004 && cp <= 0x1f004) ||
    cp === 0x1f0cf ||
    (cp >= 0x1f18e && cp <= 0x1f18e) ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

/** Width of one unit (a code point, or a grapheme cluster around joiners): 2 when any code point is East Asian wide / emoji presentation, 0 when every code point is zero-width, else 1. */
function unitWidth(g: string): number {
  let width = 0;
  for (let i = 0; i < g.length; i++) {
    const cp = g.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++;
    if (isZeroWidth(cp)) continue;
    if (isWide(cp)) return 2;
    width = 1;
  }
  return width;
}

/** TUI-DESIGN §4.2 (local stub of O2's `cellWidth`): terminal cells a string occupies — ASCII fast path, per-code-point widths otherwise, grapheme clusters only around joiners. */
export function cellWidth(s: string): number {
  if (s.length === 0) return 0;
  if (ASCII_PRINTABLE_RE.test(s)) return s.length;
  let width = 0;
  if (!needsSegmentation(s)) {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i) ?? 0;
      if (cp > 0xffff) i++;
      if (isZeroWidth(cp)) continue;
      width += isWide(cp) ? 2 : 1;
    }
    return width;
  }
  for (const g of graphemes(s)) width += unitWidth(g);
  return width;
}

/** TUI-DESIGN §6.1 / §7.2: cut a string to at most `max` cells, ending in the glyph set's ellipsis when anything was dropped (the ellipsis is dropped too when it cannot fit); `Infinity` never cuts, NaN / ≤ 0 yield ''. */
export function truncateCells(s: string, max: number, g: GlyphSet = UNICODE): string {
  if (Number.isNaN(max) || max <= 0) return '';
  const width = cellWidth(s);
  if (width <= max) return s;
  const ell = g.ellipsis;
  const ellWidth = cellWidth(ell);
  const budget = max >= ellWidth + 1 ? max - ellWidth : max;
  let out = '';
  let used = 0;
  for (const u of units(s)) {
    const w = unitWidth(u);
    if (used + w > budget) break;
    out += u;
    used += w;
  }
  return max >= ellWidth + 1 ? out + ell : out;
}

/** Pad on the right to exactly `width` cells (never truncates). */
export function padEndCells(s: string, width: number): string {
  const w = cellWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** Pad on the left to exactly `width` cells (never truncates). */
export function padStartCells(s: string, width: number): string {
  const w = cellWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/** Exactly `width` cells: truncated with the ellipsis when longer, space-padded when shorter. */
export function fitCells(s: string, width: number, g: GlyphSet = UNICODE): string {
  if (width <= 0) return '';
  return padEndCells(truncateCells(s, width, g), width);
}

/** Bidi controls — ALM, LRM/RLM, the embeddings/overrides U+202A–202E and the isolates U+2066–2069 — dropped so generator text can never reorder what the reviewer reads (§14.1; Trojan-Source). `sanitizeStream` (plain.ts, O10) does not strip them yet, so they are stripped here as well. */
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Line breaks (CRLF, CR, LF, U+2028/2029) and tabs collapse to one space. */
const BREAK_RE = /\r\n|[\r\n\t\u2028\u2029]/g;

/** TUI-DESIGN §14.1: every pane cell is one logical line — breaks (incl. U+2028/2029) and tabs become one space, `sanitizeStream` drops C0 / DEL / C1, and the bidi controls are dropped too; the result never moves the cursor nor reorders the row. */
export function oneLineCells(s: string): string {
  if (ASCII_PRINTABLE_RE.test(s)) return s;
  return sanitizeStream(s.replace(BREAK_RE, ' ')).replace(BIDI_CONTROL_RE, '');
}

/** A rule row: `─── <left> ` + fill + `<right>` cut to `min(columns, 400)` cells (§14.1 "rule capped at min(columns, 400)"). */
export function ruleRow(left: string, right: string, columns: number, g: GlyphSet = UNICODE): string {
  const width = Math.min(Math.max(0, Math.floor(columns)), 400);
  if (width === 0) return '';
  const head = `${g.rule.repeat(3)} ${left} `;
  const headW = cellWidth(head);
  const rightW = cellWidth(right);
  if (headW + rightW <= width) return head + g.rule.repeat(width - headW - rightW) + right;
  if (headW <= width) return head + g.rule.repeat(width - headW);
  return truncateCells(head, width, g);
}
