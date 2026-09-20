import { describe, expect, it } from 'vitest';
import { jaccard, levenshtein, levenshteinSimilarity, nearDuplicates, normaliseLine, normaliseTokens } from '../../../../src/synth/py/similarity.js';
import { tokenize } from '../../../../src/synth/py/tokenize.js';
import { fixture } from './helpers.js';

describe('normalisation', () => {
  it('maps identifiers, numbers and strings to ID/NUM/STR and keeps keywords and operators', () => {
    expect(normaliseLine('memo[i, j] = memo[i - 1, j]')).toEqual(['ID', '[', 'ID', ',', 'ID', ']', '=', 'ID', '[', 'ID', '-', 'NUM', ',', 'ID', ']']);
    expect(normaliseLine("if source == '' or target == '':")).toEqual(['if', 'ID', '==', 'STR', 'or', 'ID', '==', 'STR', ':']);
    expect(normaliseLine('return f"{x}" + 0x10 + .5j')).toEqual(['return', 'STR', '+', 'NUM', '+', 'NUM']);
  });
  it('drops comments, newlines and structure tokens', () => {
    expect(normaliseLine('    x = 1  # note')).toEqual(['ID', '=', 'NUM']);
    expect(normaliseLine('')).toEqual([]);
    expect(normaliseLine('# only a comment')).toEqual([]);
    expect(normaliseTokens(tokenize('def f():\n    return 1\n'))).toEqual(['def', 'ID', '(', ')', ':', 'return', 'NUM']);
  });
  it('is lenient on fragments', () => {
    expect(normaliseLine('foo(a,')).toEqual(['ID', '(', 'ID', ',']);
    expect(normaliseLine("x = '''unterminated")).toEqual(['ID', '=', "'", 'STR', 'ID']);
  });
});

describe('jaccard and levenshtein over tokens', () => {
  it('jaccard over sets', () => {
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
    expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(['a'], [])).toBe(0);
  });
  it('levenshtein distance and similarity', () => {
    expect(levenshtein(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(levenshtein(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(levenshtein(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(levenshtein([], ['a', 'b'])).toBe(2);
    expect(levenshtein(['k', 'i', 't', 't', 'e', 'n'], ['s', 'i', 't', 't', 'i', 'n', 'g'])).toBe(3);
    expect(levenshteinSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(levenshteinSimilarity(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'x'])).toBeCloseTo(0.75);
    expect(levenshteinSimilarity([], [])).toBe(1);
    expect(levenshteinSimilarity(['a'], ['b'])).toBe(0);
  });
});

describe('nearDuplicates', () => {
  const lines = fixture('knapsack').split('\n');
  it('finds the structurally identical line and the near miss in knapsack.py', () => {
    const hits = nearDuplicates('dp[a, b] = dp[a - 1, b]', lines, 0.6);
    expect(hits[0]).toEqual({ index: 9, line: '            memo[i, j] = memo[i - 1, j]', score: 1 });
    expect(hits.map((h) => h.index)).toContain(6); // `weight, value = items[i - 1]` has the same assignment shape
    expect(hits.length).toBeGreaterThan(1);
    for (let k = 1; k < hits.length; k++) expect(hits[k - 1]!.score).toBeGreaterThanOrEqual(hits[k]!.score);
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0.6);
    // a lower threshold admits more lines, never fewer
    expect(nearDuplicates('dp[a, b] = dp[a - 1, b]', lines, 0.4).length).toBeGreaterThanOrEqual(hits.length);
  });
  it('threshold filters, excludeExact drops the line itself, jaccard metric is available', () => {
    const line = lines[9]!;
    expect(nearDuplicates(line, lines, 1).map((h) => h.index)).toEqual([9]);
    expect(nearDuplicates(line, lines, 1, { excludeExact: true })).toEqual([]);
    const jac = nearDuplicates('for k in range(1, n + 1):', lines, 0.7, { metric: 'jaccard' });
    expect(jac.map((h) => h.index).sort((a, b) => a - b)).toEqual([5, 8]);
    expect(jac[0]!.score).toBe(1);
  });
  it('blank, comment-only and prose lines never match; an empty query gives nothing', () => {
    expect(nearDuplicates('x = 1', ['', '# comment', '   '], 0)).toEqual([]);
    expect(nearDuplicates('', lines, 0)).toEqual([]);
    const hits = nearDuplicates('return memo[len(items), capacity]', lines, 0.5);
    expect(hits[0]).toMatchObject({ index: 17, score: 1 });
    expect(nearDuplicates('return memo[len(items), capacity]', lines, 0.9).map((h) => h.index)).toEqual([17]);
  });
});
