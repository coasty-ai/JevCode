/**
 * Token-level similarity for donor-code search: identifiers, numbers and strings are
 * normalised to ID/NUM/STR so `memo[i, j] = memo[i - 1, j]` and `dp[a, b] = dp[a - 1, b]`
 * compare equal, then Jaccard over token sets or Levenshtein over token sequences.
 */
import { isKeyword, tokenizeFragment } from './tokenize.js';
import type { Token } from './tokenize.js';

export type SimilarityMetric = 'levenshtein' | 'jaccard';

/** Map code tokens to a normalised alphabet; keywords and operators keep their text. */
export function normaliseTokens(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'NAME':
        out.push(isKeyword(t.text) ? t.text : 'ID');
        break;
      case 'NUMBER':
        out.push('NUM');
        break;
      case 'STRING':
        out.push('STR');
        break;
      case 'OP':
      case 'ERRORTOKEN':
        out.push(t.text);
        break;
      default:
        break; // NL, COMMENT and the like carry no code
    }
  }
  return out;
}

/** Normalised token sequence of a line or fragment (lenient tokenizer, never throws). */
export function normaliseLine(line: string): string[] {
  return normaliseTokens(tokenizeFragment(line));
}

/** Jaccard similarity of two token multisets treated as sets; 1 when both are empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Levenshtein distance between two token sequences. */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, sub);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 1 − levenshtein / max(len): 1 for identical sequences, 0 for nothing in common. */
export function levenshteinSimilarity(a: readonly string[], b: readonly string[]): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export interface NearDuplicate {
  /** Index into `corpusLines`. */
  index: number;
  line: string;
  /** Similarity in [0, 1]. */
  score: number;
}

export interface NearDuplicateOptions {
  metric?: SimilarityMetric;
  /** Skip corpus lines whose text equals `line` exactly (default false). */
  excludeExact?: boolean;
}

/**
 * Corpus lines whose normalised tokens are at least `threshold` similar to `line`, best first
 * (ties by corpus order). Blank and comment-only lines never match.
 */
export function nearDuplicates(line: string, corpusLines: readonly string[], threshold: number, opts: NearDuplicateOptions = {}): NearDuplicate[] {
  const metric = opts.metric ?? 'levenshtein';
  const target = normaliseLine(line);
  if (target.length === 0) return [];
  const out: NearDuplicate[] = [];
  corpusLines.forEach((candidate, index) => {
    if (opts.excludeExact === true && candidate === line) return;
    const toks = normaliseLine(candidate);
    if (toks.length === 0) return;
    const score = metric === 'jaccard' ? jaccard(target, toks) : levenshteinSimilarity(target, toks);
    if (score >= threshold) out.push({ index, line: candidate, score });
  });
  return out.sort((x, y) => y.score - x.score || x.index - y.index);
}
