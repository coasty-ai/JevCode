/**
 * The dependency-free fuzzy scorer (TUI-DESIGN §5.4, F17): prefix-then-subsequence with word-boundary
 * bonuses, used by the palette, the `@` mention popup, argument completion and the picker filter.
 * 1. case-fold both; 2. exact → 1000; prefix → 900 − candidate.length; word-prefix (after / - _ : . or a
 * lower→Upper hump) → 700 − wordIndex·10; 3. else greedy left-to-right subsequence: +10 per matched char,
 * +25 when the match starts a word, +15 when contiguous with the previous match, −1 per skipped char,
 * −0.1 per candidate length; paths add +40 when the query matches inside the basename (the basename match
 * is tried on its own and the better of the two wins); every query char must match in order (null
 * otherwise). Ties: shorter candidate, then original order. The lower-cased forms and word starts are
 * precomputed once per list (`indexCandidates`, which copies the list so a later mutation of the caller's
 * array cannot desynchronise the scratch buffers); `rank` allocates spans for the returned rows only.
 * Spans are grapheme-aligned: a match inside a cluster (`e` in `café` written e + U+0301, a person inside a
 * ZWJ family) is widened to the whole cluster so bolding never splits a base from its marks. Pure; ≤ 16 ms
 * per keystroke over 5,000 candidates (measured in test/unit/tui/commands/fuzzy.test.ts).
 */

/** TUI-DESIGN §5.4: one ranked candidate; `spans` are `[start, end)` code-unit ranges of the matched characters, snapped outward to grapheme boundaries. */
export interface Scored {
  candidate: string;
  score: number;
  spans: readonly [number, number][];
}

/** a list whose lower-cased forms and word starts are computed once (§5.4 "precompute … once per list") */
export interface CandidateIndex {
  readonly candidates: readonly string[];
  readonly folded: readonly string[];
  /** per candidate: code-unit positions that start a word (0 excluded), ascending */
  readonly wordStarts: readonly Uint32Array[];
  /** per candidate: index after the last `/`, or 0 */
  readonly basename: readonly number[];
  /** per-keystroke scratch (scores and the sort order) so `rank` allocates only the rows it returns */
  readonly scratch: { readonly scores: Float64Array; readonly order: Int32Array };
}

const SEP = new Set([47, 45, 95, 58, 46, 32]); // / - _ : . space

function isLower(cp: number, ch: string): boolean {
  if (cp < 128) return cp >= 97 && cp <= 122;
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

function isUpper(cp: number, ch: string): boolean {
  if (cp < 128) return cp >= 65 && cp <= 90;
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** case-fold per code point, keeping the code-unit length so spans stay aligned with the original text */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

function wordStartsOf(c: string): Uint32Array {
  const out: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c.charCodeAt(i - 1);
    if (SEP.has(prev)) {
      if (!SEP.has(c.charCodeAt(i))) out.push(i);
      continue;
    }
    const cur = c.charCodeAt(i);
    if (cur >= 0xdc00 && cur <= 0xdfff) continue; // inside a surrogate pair
    if (isUpper(cur, c[i] as string) && isLower(prev, c[i - 1] as string)) out.push(i);
  }
  return Uint32Array.from(out);
}

/** TUI-DESIGN §5.4 `indexCandidates` — precompute the case-folded list and word starts once (over a copy of the list). */
export function indexCandidates(candidates: readonly string[]): CandidateIndex {
  const copy = [...candidates];
  return {
    candidates: copy,
    folded: copy.map(fold),
    wordStarts: copy.map(wordStartsOf),
    basename: copy.map((c) => c.lastIndexOf('/') + 1),
    scratch: { scores: new Float64Array(copy.length), order: new Int32Array(copy.length) },
  };
}

let segmenter: Intl.Segmenter | null = null;

/** ascending grapheme-cluster start offsets of `s` plus `s.length` (one lazily created `Intl.Segmenter`) */
function graphemeBoundaries(s: string): number[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: number[] = [];
  for (const seg of segmenter.segment(s)) out.push(seg.index);
  out.push(s.length);
  return out;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * TUI-DESIGN §5.4 "spans grapheme-aligned": widen each `[start, end)` outward to the enclosing cluster
 * boundaries of `candidate` and merge spans that then touch or overlap. ASCII candidates are returned as is.
 */
export function snapSpans(candidate: string, spans: readonly [number, number][]): [number, number][] {
  if (spans.length === 0 || ASCII_ONLY.test(candidate)) return spans.map(([a, b]) => [a, b]);
  const bounds = graphemeBoundaries(candidate);
  const floor = (i: number): number => {
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((bounds[mid] as number) <= i) lo = mid;
      else hi = mid - 1;
    }
    return bounds[lo] as number;
  };
  const ceil = (i: number): number => {
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((bounds[mid] as number) >= i) hi = mid;
      else lo = mid + 1;
    }
    return bounds[lo] as number;
  };
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const s0 = floor(Math.max(0, Math.min(a, candidate.length)));
    const e0 = ceil(Math.max(0, Math.min(b, candidate.length)));
    const last = out[out.length - 1];
    if (last !== undefined && s0 <= last[1]) last[1] = Math.max(last[1], e0);
    else out.push([s0, e0]);
  }
  return out;
}

function isWordStart(ws: Uint32Array, i: number): boolean {
  if (i === 0) return true;
  // ws is ascending; binary search
  let lo = 0;
  let hi = ws.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ws[mid] as number;
    if (v === i) return true;
    if (v < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** greedy subsequence of `q` (code points) in `c` from `from`; returns the score (before the length penalty) and, when asked, the positions */
function greedy(q: string, c: string, from: number, ws: Uint32Array, positions: [number, number][] | null): number | null {
  let score = 0;
  let ci = from;
  let prevEnd = -1;
  for (const ch of q) {
    const at = c.indexOf(ch, ci);
    if (at < 0) return null;
    score += 10;
    if (isWordStart(ws, at)) score += 25;
    if (at === prevEnd) score += 15;
    score -= at - ci;
    positions?.push([at, ch.length]);
    prevEnd = at + ch.length;
    ci = prevEnd;
  }
  return score;
}

/** collapse adjacent single-character matches into spans */
function toSpans(positions: readonly [number, number][]): [number, number][] {
  const spans: [number, number][] = [];
  for (const [p, len] of positions) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last[1] === p) last[1] = p + len;
    else spans.push([p, p + len]);
  }
  return spans;
}

/** score one indexed candidate; `positions` (when given) receives the match positions of the winning strategy */
function scoreAt(q: string, idx: CandidateIndex, n: number, positions: [number, number][] | null): number | null {
  const c = idx.folded[n] as string;
  if (q.length === 0) return 0;
  if (q.length > c.length) return null;
  if (c === q) {
    positions?.push([0, c.length]);
    return 1000;
  }
  if (c.startsWith(q)) {
    positions?.push([0, q.length]);
    return 900 - c.length;
  }
  const ws = idx.wordStarts[n] as Uint32Array;
  for (let w = 0; w < ws.length; w++) {
    const i = ws[w] as number;
    if (c.startsWith(q, i)) {
      positions?.push([i, q.length]);
      return 700 - (w + 1) * 10;
    }
  }
  const base = idx.basename[n] as number;
  let best: number | null = null;
  let bestFrom = 0;
  if (base > 0) {
    const b = greedy(q, c, base, ws, null);
    if (b !== null) {
      best = b + 40;
      bestFrom = base;
    }
  }
  const whole = greedy(q, c, 0, ws, null);
  if (whole !== null && (best === null || whole > best)) {
    best = whole;
    bestFrom = 0;
  }
  if (best === null) return null;
  if (positions !== null) greedy(q, c, bestFrom, ws, positions);
  return best - 0.1 * c.length;
}

/** TUI-DESIGN §5.4 `score` — null when the case-folded query is not a subsequence of the candidate. */
export function score(query: string, candidate: string): { score: number; spans: [number, number][] } | null {
  const idx = indexCandidates([candidate]);
  const positions: [number, number][] = [];
  const s = scoreAt(fold(query), idx, 0, positions);
  if (s === null) return null;
  return { score: s, spans: snapSpans(candidate, toSpans(positions)) };
}

/**
 * TUI-DESIGN §5.4 `rank` — the top `limit` matches in score order; ties by shorter candidate, then original
 * order. An empty query returns the first `limit` candidates in original order. Accepts a plain list or a
 * prebuilt `CandidateIndex` (the per-keystroke path).
 */
export function rank(query: string, candidates: readonly string[] | CandidateIndex, limit = 8): Scored[] {
  const idx: CandidateIndex = Array.isArray(candidates) ? indexCandidates(candidates as readonly string[]) : (candidates as CandidateIndex);
  const n = Math.min(idx.candidates.length, idx.folded.length, idx.scratch.scores.length);
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : n;
  if (max === 0 || n === 0) return [];
  const q = fold(query);
  const { scores, order } = idx.scratch;
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const s = scoreAt(q, idx, i, null);
    if (s === null) continue;
    scores[i] = s;
    order[matched++] = i;
  }
  const sorted = order.subarray(0, matched);
  sorted.sort((a, b) => (scores[b] as number) - (scores[a] as number) || (idx.candidates[a] as string).length - (idx.candidates[b] as string).length || a - b);
  const out: Scored[] = [];
  for (let k = 0; k < matched && k < max; k++) {
    const i = sorted[k] as number;
    const positions: [number, number][] = [];
    scoreAt(q, idx, i, positions);
    const candidate = idx.candidates[i] as string;
    out.push({ candidate, score: scores[i] as number, spans: snapSpans(candidate, toSpans(positions)) });
  }
  return out;
}

/** TUI-DESIGN §5.4 (property): true iff the case-folded query is a subsequence of the case-folded candidate. */
export function isSubsequence(query: string, candidate: string): boolean {
  const q = fold(query);
  const c = fold(candidate);
  let ci = 0;
  for (const ch of q) {
    const at = c.indexOf(ch, ci);
    if (at < 0) return false;
    ci = at + ch.length;
  }
  return true;
}
