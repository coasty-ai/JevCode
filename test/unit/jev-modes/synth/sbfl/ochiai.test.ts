import { describe, expect, it } from 'vitest';

import {
  buildSpectrum,
  dstar,
  functionSuspiciousness,
  isFailing,
  ochiai,
  rankLines,
  rankOf,
  tarantula,
  top,
} from '../../../../../src/jev-modes/synth/sbfl/ochiai.js';
import type { PerTestResult, TestOutcome } from '../../../../../src/jev-modes/synth/sbfl/types.js';

const t = (id: string, outcome: TestOutcome, lines: number[], file = 'a.py'): PerTestResult => ({
  id,
  outcome,
  lines: { [file]: lines },
  exception: null,
  durationMs: 0,
});

// F = 3 (fail, error, timeout), P = 2, skip excluded.
//   line 1: ef 2, ep 2   line 2: ef 1, ep 1   line 3: ef 3, ep 0   line 5: ef 1, ep 0   line 4: skip only
const PER_TEST: PerTestResult[] = [
  t('f1', 'fail', [1, 2, 3]),
  t('f2', 'error', [1, 3]),
  t('p1', 'pass', [1, 2]),
  t('p2', 'pass', [1]),
  t('s', 'skip', [1, 2, 3, 4]),
  t('to', 'timeout', [3, 5]),
];

describe('formulas against hand-computed values', () => {
  it('ochiai = ef / sqrt(F * (ef + ep))', () => {
    expect(ochiai(3, 1, 4)).toBeCloseTo(0.75, 12);
    expect(ochiai(2, 0, 2)).toBe(1);
    expect(ochiai(0, 5, 4)).toBe(0);
    expect(ochiai(2, 0, 0)).toBe(0);
  });

  it('tarantula = (ef/F) / (ef/F + ep/P), zero totals count as 0', () => {
    expect(tarantula(3, 1, 4, 2)).toBeCloseTo(0.6, 12);
    expect(tarantula(2, 0, 2, 5)).toBe(1);
    expect(tarantula(0, 3, 2, 5)).toBe(0);
    expect(tarantula(1, 1, 1, 0)).toBe(1);
    expect(tarantula(0, 0, 0, 0)).toBe(0);
  });

  it('dstar = ef^2 / (ep + nf), Infinity for the perfect suspect', () => {
    expect(dstar(3, 1, 4)).toBeCloseTo(4.5, 12);
    expect(dstar(3, 1, 4, 3)).toBeCloseTo(13.5, 12);
    expect(dstar(2, 0, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(dstar(0, 0, 2)).toBe(0);
    expect(dstar(0, 3, 2)).toBe(0);
  });

  it('failing = fail | error | timeout', () => {
    expect((['fail', 'error', 'timeout'] as TestOutcome[]).every(isFailing)).toBe(true);
    expect(isFailing('pass')).toBe(false);
    expect(isFailing('skip')).toBe(false);
  });
});

describe('buildSpectrum', () => {
  it('counts ef/ep per line, excludes skipped tests, counts a line once per test', () => {
    const s = buildSpectrum([...PER_TEST, t('dup', 'fail', [7, 7, 7])]);
    expect(s.totalFailed).toBe(4);
    expect(s.totalPassed).toBe(2);
    const by = new Map(s.lines.map((l) => [l.line, l]));
    expect(by.get(1)).toMatchObject({ file: 'a.py', ef: 2, ep: 2 });
    expect(by.get(3)).toMatchObject({ ef: 3, ep: 0 });
    expect(by.get(5)).toMatchObject({ ef: 1, ep: 0 });
    expect(by.get(7)).toMatchObject({ ef: 1, ep: 0 });
    expect(by.has(4)).toBe(false);
  });
});

describe('rankLines', () => {
  it('ranks by Ochiai with (file, line) tie-break and assigns 1-based ranks', () => {
    const r = rankLines(PER_TEST);
    expect(r.map((x) => x.line)).toEqual([3, 1, 5, 2]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
    expect(r[0]!.score).toBeCloseTo(1, 12);
    expect(r[1]!.score).toBeCloseTo(2 / Math.sqrt(12), 12);
    expect(r[2]!.score).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(r[1]!.score).toBeCloseTo(r[2]!.score, 12); // the tie broken by line number
    expect(r[3]!.score).toBeCloseTo(1 / Math.sqrt(6), 12);
    expect(r[0]).toMatchObject({ ef: 3, ep: 0 });
  });

  it('keeps all three scores on every row and switches the primary with `formula`', () => {
    const tar = rankLines(PER_TEST, 'tarantula');
    expect(tar.map((x) => x.line)).toEqual([3, 5, 1, 2]);
    expect(tar[0]!.score).toBe(tar[0]!.scores.tarantula);
    expect(tar[1]!.scores.tarantula).toBeCloseTo(1, 12);
    expect(tar[2]!.scores.tarantula).toBeCloseTo(0.4, 12);
    const ds = rankLines(PER_TEST, 'dstar');
    expect(ds.map((x) => x.line)).toEqual([3, 1, 5, 2]);
    expect(ds[0]!.score).toBe(Number.POSITIVE_INFINITY);
    expect(ds[1]!.score).toBeCloseTo(4 / 3, 12);
    expect(ds[0]!.scores.ochiai).toBeCloseTo(1, 12);
  });

  it('breaks equal scores across files by file name, then line', () => {
    const r = rankLines([t('f', 'fail', [9], 'b.py'), t('f2', 'fail', [1], 'a.py'), t('f3', 'fail', [1], 'b.py')]);
    // every line has ef 1, ep 0 but F = 3, so all tie at 1/sqrt(3)
    expect(r.map((x) => `${x.file}:${x.line}`)).toEqual(['a.py:1', 'b.py:1', 'b.py:9']);
  });

  it('returns an empty ranking when nothing was executed', () => {
    expect(rankLines([])).toEqual([]);
    expect(rankLines([t('p', 'pass', [])])).toEqual([]);
  });
});

describe('top / rankOf', () => {
  it('top(k) slices the ranking; rankOf finds a line or null', () => {
    const r = rankLines(PER_TEST);
    expect(top(r, 2).map((x) => x.line)).toEqual([3, 1]);
    expect(top(r, 0)).toEqual([]);
    expect(top(r, 99)).toHaveLength(4);
    expect(rankOf(r, 'a.py', 3)).toBe(1);
    expect(rankOf(r, 'a.py', 2)).toBe(4);
    expect(rankOf(r, 'a.py', 4)).toBeNull();
    expect(rankOf(r, 'b.py', 3)).toBeNull();
  });
});

describe('functionSuspiciousness', () => {
  it('takes the max over covered lines, omits uncovered spans, drops lines outside spans', () => {
    const r = rankLines(PER_TEST);
    const fns = functionSuspiciousness(r, [
      { file: 'a.py', name: 'f', startLine: 1, endLine: 2 },
      { file: 'a.py', name: 'g', startLine: 3, endLine: 5 },
      { file: 'a.py', name: 'h', startLine: 6, endLine: 9 },
      { file: 'b.py', name: 'other', startLine: 1, endLine: 9 },
    ]);
    expect(fns.map((f) => f.name)).toEqual(['g', 'f']);
    expect(fns[0]).toMatchObject({ rank: 1, bestLine: 3, coveredLines: 2 });
    expect(fns[0]!.score).toBeCloseTo(1, 12);
    expect(fns[1]).toMatchObject({ rank: 2, bestLine: 1, coveredLines: 2 });
    expect(fns[1]!.score).toBeCloseTo(2 / Math.sqrt(12), 12);
  });

  it('breaks ties by file, then start line, then name', () => {
    // every covered line has ef 1, ep 0 with F 2, so all four spans tie at 1/sqrt(2)
    const r = rankLines([t('f', 'fail', [1, 10]), t('f2', 'fail', [1], 'b.py')]);
    const fns = functionSuspiciousness(r, [
      { file: 'b.py', name: 'z', startLine: 1, endLine: 5 },
      { file: 'a.py', name: 'late', startLine: 10, endLine: 12 },
      { file: 'a.py', name: 'Outer.early', startLine: 1, endLine: 5 },
      { file: 'a.py', name: 'Outer', startLine: 1, endLine: 12 },
    ]);
    expect(fns.map((f) => `${f.file}:${f.name}`)).toEqual(['a.py:Outer', 'a.py:Outer.early', 'a.py:late', 'b.py:z']);
    expect(fns.map((f) => f.rank)).toEqual([1, 2, 3, 4]);
  });
});
