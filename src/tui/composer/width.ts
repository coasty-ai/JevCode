/**
 * Cell width of grapheme clusters and strings (TUI-DESIGN §4.2, A2, C20, A108).
 *
 * Replicates `string-width@8.2.2` — Ink's own measurer — without importing it (F18: ink + react are the
 * only runtime dependencies), so the composer's cursor arithmetic and Ink's layout agree cell for cell:
 *   1. a cluster made only of Default_Ignorable / Control / Format / Nonspacing_Mark / Enclosing_Mark /
 *      Surrogate code points is zero-width (tabs included: "ignored by design");
 *   2. an RGI emoji cluster (`\p{RGI_Emoji}`) is 2;
 *   3. an unqualified keycap (`[0-9#*]` + U+20E3) or a ZWJ sequence with ≥ 2 Extended_Pictographic is 2;
 *   4. modern Hangul jamo L+V(+T) collapse to one 2-cell syllable, unmatched jamo stay additive;
 *   5. otherwise the East Asian Width of the cluster's first visible scalar (Wide / Fullwidth = 2, ambiguous =
 *      narrow, `eaw-table.ts`) plus trailing Spacing_Mark and Halfwidth/Fullwidth Forms code points.
 * ANSI escapes are not stripped here: the composer buffer never holds C0/C1 (§4.4), so there is nothing to strip.
 * Every regex that needs the `v` flag is built lazily with `new RegExp` (the flag is ES2024; tsconfig targets es2023)
 * and, like the segmenter singletons, does not sit on the first-frame path.
 */
import { EAW_WIDE_RANGES } from './eaw-table.js';

// Printable ASCII: width equals length, no segmentation needed (string-width's own fast path).
const PRINTABLE_ASCII_RE = /^[ -~]*$/;
const UNQUALIFIED_KEYCAP_RE = /^[\d#*]\u20e3$/;
const HALFWIDTH_FULLWIDTH_FORMS_MIN = 0xff00;
const HALFWIDTH_FULLWIDTH_FORMS_MAX = 0xffef;
// string-width guards its emoji heuristics against pathological clusters longer than this.
const EMOJI_CLUSTER_MAX_LENGTH = 50;

interface UnicodeRegexes {
  readonly zeroWidthCluster: RegExp;
  readonly leadingNonPrinting: RegExp;
  readonly spacingMark: RegExp;
  readonly rgiEmoji: RegExp;
  readonly extendedPictographic: RegExp;
}

// Single-code-point zero-width test (rule 1 for one scalar): a plain `u`-flag class, cheaper than the `v`-flag sequence regex.
const ZERO_WIDTH_CP_RE = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Surrogate}]$/u;

/**
 * Width of a one-scalar cluster. Every single-code-point RGI emoji has Emoji_Presentation and is therefore East Asian
 * Wide (UAX #11), so rule 2 collapses into rule 5 here and the sequence regex is skipped; below U+0300 only C0/C1 and
 * the soft hyphen are zero-width.
 */
function singleCodePointWidth(cp: number): number {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad ? 0 : 1;
  if (ZERO_WIDTH_CP_RE.test(String.fromCodePoint(cp))) return 0;
  return eastAsianWidth(cp);
}

// Multi-code-point clusters repeat heavily in real text (é, ❤\ufe0f, flags, ZWJ families): memoise their width, bounded.
const CLUSTER_CACHE_MAX = 4096;
const clusterCache = new Map<string, number>();

let regexes: UnicodeRegexes | null = null;
function re(): UnicodeRegexes {
  if (regexes === null) {
    const np = '\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Nonspacing_Mark}|\\p{Enclosing_Mark}|\\p{Surrogate}';
    regexes = {
      zeroWidthCluster: new RegExp(`^(?:${np})+$`, 'v'),
      leadingNonPrinting: new RegExp(`^(?:${np})+`, 'v'),
      spacingMark: new RegExp('\\p{Spacing_Mark}', 'v'),
      rgiEmoji: new RegExp('^\\p{RGI_Emoji}$', 'v'),
      extendedPictographic: new RegExp('\\p{Extended_Pictographic}', 'gu'),
    };
  }
  return regexes;
}

let graphemeSegmenter: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemeSegmenter;
}

/** Binary search over the generated W + F table (TUI-DESIGN §4.2): true when `codePoint` is East Asian Wide or Fullwidth. */
export function isWideCodePoint(codePoint: number): boolean {
  if (!(codePoint >= 0)) return false; // NaN and negatives
  const ranges = EAW_WIDE_RANGES;
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = ranges[mid * 2] ?? Number.POSITIVE_INFINITY;
    const end = ranges[mid * 2 + 1] ?? Number.NEGATIVE_INFINITY;
    if (codePoint < start) hi = mid - 1;
    else if (codePoint > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** East Asian Width of one code point with ambiguous = narrow (string-width's default): 2 for W/F, else 1 (TUI-DESIGN §4.2). */
export function eastAsianWidth(codePoint: number): 1 | 2 {
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isHangulLeadingJamo(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c);
}
function isHangulVowelJamo(cp: number): boolean {
  return (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6);
}
function isHangulTrailingJamo(cp: number): boolean {
  return (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb);
}
function isHangulJamo(cp: number): boolean {
  return isHangulLeadingJamo(cp) || isHangulVowelJamo(cp) || isHangulTrailingJamo(cp);
}

function isDoubleWidthNonRgiEmojiSequence(cluster: string, r: UnicodeRegexes): boolean {
  if (cluster.length > EMOJI_CLUSTER_MAX_LENGTH) return false;
  if (UNQUALIFIED_KEYCAP_RE.test(cluster)) return true;
  if (cluster.includes('\u200d')) {
    const pictographics = cluster.match(r.extendedPictographic);
    return pictographics !== null && pictographics.length >= 2;
  }
  return false;
}

/** string-width's `hangulClusterWidth`: undefined when the visible cluster does not start with jamo. */
function hangulClusterWidth(visible: string, r: UnicodeRegexes): number | undefined {
  const cps: number[] = [];
  for (const ch of visible) {
    if (r.zeroWidthCluster.test(ch)) continue;
    cps.push(ch.codePointAt(0) ?? 0);
  }
  if (cps.length === 0) return undefined;
  let width = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] ?? 0;
    if (!isHangulJamo(cp)) {
      if (width === 0) return undefined;
      for (let k = i; k < cps.length; k++) width += eastAsianWidth(cps[k] ?? 0);
      return width;
    }
    const next = cps[i + 1];
    if (isHangulLeadingJamo(cp) && next !== undefined && isHangulVowelJamo(next)) {
      width += 2;
      const after = cps[i + 2];
      i += after !== undefined && isHangulTrailingJamo(after) ? 2 : 1;
      continue;
    }
    width += eastAsianWidth(cp);
  }
  return width;
}

/** Trailing Spacing_Mark and Halfwidth/Fullwidth Forms code points after the first visible scalar add their EAW. */
function trailingWidth(visible: string, r: UnicodeRegexes): number {
  let extra = 0;
  let first = true;
  for (const ch of visible) {
    if (first) {
      first = false;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (r.spacingMark.test(ch) || (cp >= HALFWIDTH_FULLWIDTH_FORMS_MIN && cp <= HALFWIDTH_FULLWIDTH_FORMS_MAX)) extra += eastAsianWidth(cp);
  }
  return extra;
}

/**
 * Cells one grapheme cluster occupies under string-width@8.2.2's rules (TUI-DESIGN §4.2): 0, 1 or 2 for every
 * ordinary cluster; string-width's own additive cases (unmatched Hangul jamo runs, trailing spacing marks such as
 * Devanagari `कि`) return their summed width so `stringWidth` stays cell-identical with Ink.
 */
export function cellWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  const first = cluster.charCodeAt(0);
  if (cluster.length === 1) return first >= 0xd800 && first <= 0xdfff ? 0 : singleCodePointWidth(first);
  if (cluster.length === 2 && first >= 0xd800 && first <= 0xdbff) {
    const second = cluster.charCodeAt(1);
    if (second >= 0xdc00 && second <= 0xdfff) return singleCodePointWidth(cluster.codePointAt(0) ?? 0);
  }
  const hit = clusterCache.get(cluster);
  if (hit !== undefined) return hit;
  const w = multiCodePointWidth(cluster);
  if (clusterCache.size >= CLUSTER_CACHE_MAX) clusterCache.clear();
  clusterCache.set(cluster, w);
  return w;
}

/** Rules 1–5 for a cluster of two or more scalars (string-width's general path). */
function multiCodePointWidth(cluster: string): number {
  const r = re();
  if (r.zeroWidthCluster.test(cluster)) return 0;
  if (r.rgiEmoji.test(cluster) || isDoubleWidthNonRgiEmojiSequence(cluster, r)) return 2;
  const visible = cluster.replace(r.leadingNonPrinting, '');
  const hangul = hangulClusterWidth(visible, r);
  if (hangul !== undefined) return hangul;
  const cp = visible.codePointAt(0);
  if (cp === undefined) return 0;
  return eastAsianWidth(cp) + trailingWidth(visible, r);
}

/**
 * Whole non-ASCII strings repeat frame after frame — the console's status row and edges, the rule, card edges, the
 * placeholder — and each one paid a fresh `Intl.Segmenter` pass per render (28.7 ms of the Console's 108 ms in a CPU
 * profile of a streamed chat reply). Their widths are memoised in a bounded map: at most `WIDTH_CACHE_MAX` entries,
 * each key at most `WIDTH_CACHE_MAX_LENGTH` UTF-16 units (a longer string is measured every time, so the keys hold
 * ≲ 4 MiB at worst), the oldest insertion evicted first (a `Map` iterates in insertion order). A width is a pure
 * function of the string, so a hit is the same number the segmenter pass returns. Keys are stored as copies
 * (`detached`): a row cut from a large string (a streamed reply, a file in a diff preview) is a V8 slice that would
 * otherwise keep the whole parent alive for as long as the entry lives.
 */
export const WIDTH_CACHE_MAX = 4096;
export const WIDTH_CACHE_MAX_LENGTH = 512;
const widthCache = new Map<string, number>();

/** Σ `cellWidth` over the grapheme clusters of `s` (TUI-DESIGN §4.2); printable ASCII short-circuits to `s.length`. */
export function stringWidth(s: string): number {
  if (s.length === 0) return 0;
  if (PRINTABLE_ASCII_RE.test(s)) return s.length;
  if (s.length > WIDTH_CACHE_MAX_LENGTH) return segmentedWidth(s);
  const hit = widthCache.get(s);
  if (hit !== undefined) return hit;
  const width = segmentedWidth(s);
  if (widthCache.size >= WIDTH_CACHE_MAX) {
    const oldest = widthCache.keys().next();
    if (oldest.done !== true) widthCache.delete(oldest.value);
  }
  widthCache.set(detached(s), width);
  return width;
}

/** A copy of `s` that shares no storage with a string it may have been sliced from (V8 flattens the concatenation, then slices the copy). */
function detached(s: string): string {
  return ` ${s}`.slice(1);
}

/** The uncached measure behind `stringWidth`'s non-ASCII path. */
function segmentedWidth(s: string): number {
  let width = 0;
  for (const { segment } of segmenter().segment(s)) width += cellWidth(segment);
  return width;
}

/** The width cache's current entry count (the bound is `WIDTH_CACHE_MAX`; tests assert it). */
export function stringWidthCacheSize(): number {
  return widthCache.size;
}

/** Ellipsis appended by `truncateCells` (TUI-DESIGN §4.2); one cell wide (U+2026 is East Asian Ambiguous = narrow). */
export const ELLIPSIS = '…';

/**
 * Truncate `s` to at most `cells` columns by whole graphemes, appending `…` when anything was cut (TUI-DESIGN §4.2).
 * `+Infinity` is "no limit" and returns `s` untouched; NaN, `-Infinity` and negative budgets yield ''; a string whose
 * width already fits (a zero-width string under a 0 budget included) is returned as is; a `cells` of 1 that must cut yields `…` alone.
 */
export function truncateCells(s: string, cells: number): string {
  if (cells === Number.POSITIVE_INFINITY) return s;
  if (!Number.isFinite(cells) || s.length === 0) return '';
  const limit = Math.max(0, Math.floor(cells));
  if (PRINTABLE_ASCII_RE.test(s)) {
    if (s.length <= limit) return s;
    return limit === 0 ? '' : s.slice(0, limit - 1) + ELLIPSIS;
  }
  if (stringWidth(s) <= limit) return s; // includes a zero-width string under a zero budget
  if (limit === 0) return '';
  const budget = limit - 1; // leave one cell for the ellipsis
  let used = 0;
  let out = '';
  for (const { segment } of segmenter().segment(s)) {
    const w = cellWidth(segment);
    if (used + w > budget) break;
    used += w;
    out += segment;
  }
  return out + ELLIPSIS;
}
