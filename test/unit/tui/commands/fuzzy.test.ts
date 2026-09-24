/**
 * TUI-DESIGN §19.0 / §5.4: fixed orderings (`res`, `sess`, `bud`, `parse_date`, `tst/a`), `rank()` over 5,000
 * synthetic paths × 40 queries with p50 ≤ 16 ms (the design bound) and p95 ≤ 48 ms (3× on the tail), spans
 * grapheme-aligned, the index copies its list, and the property `score(q, c) !== null ⇔ q is a case-folded
 * subsequence of c`.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { indexCandidates, isSubsequence, rank, score, snapSpans } from '../../../../src/tui/commands/fuzzy.js';
import { commandNames } from '../../../../src/tui/commands/registry.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASCII = ['src', 'lib', 'test', 'tests', 'parse', 'date', 'utils', 'client', 'server', 'index', 'main', 'config', 'session', 'budget', 'resume', 'engine', 'types', 'render', 'plan', 'risk'];
const CJK = ['日本語', '设置', '测试', '文档', '数据', '模型', '会话', '预算', '恢复', '引擎'];
const EXT = ['ts', 'tsx', 'py', 'md', 'json', 'js', 'go', 'rs'];

/** 5,000 synthetic paths: depth 1–6, 60 % ASCII, 20 % CJK, 20 % mixed */
function corpus(n = 5000, seed = 42): string[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const depth = 1 + Math.floor(rnd() * 6);
    const kind = rnd();
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) {
      const word = kind < 0.6 ? pick(ASCII) : kind < 0.8 ? pick(CJK) : rnd() < 0.5 ? pick(ASCII) : pick(CJK);
      parts.push(d === depth - 1 ? `${word}_${i % 97}.${pick(EXT)}` : word);
    }
    out.push(parts.join('/'));
  }
  return out;
}

describe('score / rank (TUI-DESIGN §5.4)', () => {
  it('exact > prefix > word-prefix > subsequence; null when a query char is missing', () => {
    expect(score('budget', 'budget')?.score).toBe(1000);
    expect(score('bud', 'budget')?.score).toBe(900 - 6);
    expect(score('date', 'parse_date')?.score).toBe(700 - 10);
    expect(score('Date', 'parse_date')?.score).toBe(690);
    expect(score('pd', 'parse_date')?.score).toBeGreaterThan(0);
    expect(score('xyz', 'parse_date')).toBeNull();
    expect(score('', 'anything')).toEqual({ score: 0, spans: [] });
    expect(score('longer than', 'short')).toBeNull();
    expect(score('date', 'parseDate')?.score).toBe(690);
  });
  it('spans are aligned code-unit ranges over the original candidate', () => {
    expect(score('bud', 'budget')?.spans).toEqual([[0, 3]]);
    expect(score('pd', 'parse_date')?.spans).toEqual([[0, 1], [6, 7]]);
    expect(score('日', 'src/日本語.ts')?.spans).toEqual([[4, 5]]);
    expect(score('🎉', 'a/🎉.md')?.spans).toEqual([[2, 4]]);
    expect(score('İ', 'İstanbul')?.spans).toEqual([[0, 1]]);
  });
  it('spans are grapheme-aligned (§5.4): a match inside a cluster is widened to the whole cluster', () => {
    const cafe = 'cafe\u0301'; // e + combining acute: one cluster [3, 5)
    expect(score('e', cafe)?.spans).toEqual([[3, 5]]);
    expect(score('cafe', cafe)?.spans).toEqual([[0, 5]]);
    const family = 'x/👨\u200d👩\u200d👧.md'; // ZWJ sequence: one cluster of 8 code units at [2, 10)
    expect(score('👨', family)?.spans).toEqual([[2, 10]]);
    expect(score('👧', family)?.spans).toEqual([[2, 10]]);
    expect(score('x.md', family)?.spans).toEqual([[0, 1], [10, 13]]);
    // two matches in one cluster merge; a flag pair stays whole; ASCII is untouched
    expect(snapSpans('a\u0301b', [[0, 1], [1, 2]])).toEqual([[0, 2]]);
    expect(snapSpans('🇯🇵x', [[0, 2]])).toEqual([[0, 4]]);
    expect(snapSpans('plain', [[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]]);
    expect(snapSpans('é', [])).toEqual([]);
    expect(rank('e', [cafe, 'echo'])[1]?.spans).toEqual([[3, 5]]);
  });
  it('indexCandidates copies the list: mutating the caller\'s array afterwards never desynchronises rank()', () => {
    const list = ['alpha', 'beta', 'gamma'];
    const idx = indexCandidates(list);
    list.push('delta', 'epsilon', 'zeta');
    list[0] = 'omega';
    expect(rank('a', idx).map((r) => r.candidate)).toEqual(['alpha', 'gamma', 'beta']); // prefix, then the earlier `a`
    expect(idx.candidates).toEqual(['alpha', 'beta', 'gamma']);
    list.length = 0;
    expect(rank('a', idx)).toHaveLength(3);
  });
  it('fixed orderings for the commands and paths of the design', () => {
    const names = commandNames().map((n) => n.slice(1));
    // TUI-DESIGN-5 §2.9: `/request` joins the subsequence tail of `res` (r-e-s in order)
    expect(rank('res', names).map((r) => r.candidate)).toEqual(['resume', 'request']);
    expect(rank('re', names).map((r) => r.candidate)).toEqual(['resume', 'rename', 'rewind', 'report', 'request', 'fullscreen', 'provider']); // TUI-DESIGN-4: /fullscreen joins the subsequence tail; TUI-DESIGN-5: /request is a word-prefix match after /report
    expect(rank('sess', names)[0]?.candidate).toBeUndefined(); // `sessions` is an alias, not a name
    expect(rank('bud', names).map((r) => r.candidate)).toEqual(['budget']);
    // TUI-DESIGN-5 §2.9: `/inbox` carries `b` at index 2 and outranks `/calibration` (index 4); the scorer is unchanged, the pool grew
    expect(rank('b', names).map((r) => r.candidate).slice(0, 4)).toEqual(['budget', 'abort', 'inbox', 'calibration']);
    const paths = ['src/parse_date.py', 'tests/test_parse_date.py', 'src/dates/parser.py', 'docs/parse.md', 'tst/a.py', 'tst/b/a.py', 'src/a.py'];
    expect(rank('parse_date', paths).map((r) => r.candidate)).toEqual(['src/parse_date.py', 'tests/test_parse_date.py']);
    expect(rank('tst/a', paths).map((r) => r.candidate)).toEqual(['tst/a.py', 'tst/b/a.py', 'tests/test_parse_date.py']);
    expect(rank('sess', ['a/session.ts', 'session', 'src/sessions/index.ts']).map((r) => r.candidate)).toEqual(['session', 'a/session.ts', 'src/sessions/index.ts']);
  });
  it('ties: shorter candidate, then original order; limit honoured; empty query keeps original order', () => {
    expect(rank('a', ['ab', 'ac', 'a', 'abc']).map((r) => r.candidate)).toEqual(['a', 'ab', 'ac', 'abc']);
    expect(rank('a', ['xa', 'ya', 'za'], 2).map((r) => r.candidate)).toEqual(['xa', 'ya']);
    expect(rank('', ['c', 'b', 'a'], 2).map((r) => r.candidate)).toEqual(['c', 'b']);
    expect(rank('a', ['a'], 0)).toEqual([]);
    expect(rank('a', ['a', 'ba'], Number.POSITIVE_INFINITY)).toHaveLength(2);
    expect(rank('a', ['a', 'ba'], Number.NaN)).toHaveLength(2);
  });
  it('is case-insensitive and treats a basename match as better than a directory match', () => {
    expect(rank('README', ['docs/readme.md', 'README.md']).map((r) => r.candidate)).toEqual(['README.md', 'docs/readme.md']);
    const a = score('cfg', 'config/x.ts');
    const b = score('cfg', 'src/config.ts');
    expect(b?.score ?? 0).toBeGreaterThan(a?.score ?? 0);
  });
  it('property: score(q, c) !== null ⇔ q is a case-folded subsequence of c (2,000 seeded cases incl. unicode)', () => {
    const rnd = mulberry32(7);
    const alphabet = [...'abcABC_/-. 日本é🎉İ'];
    const pick = (): string => alphabet[Math.floor(rnd() * alphabet.length)] as string;
    for (let n = 0; n < 2000; n++) {
      const c = Array.from({ length: Math.floor(rnd() * 12) }, pick).join('');
      const q = Array.from({ length: Math.floor(rnd() * 4) }, pick).join('');
      expect(score(q, c) !== null, `seed 7 case ${n}: q=${JSON.stringify(q)} c=${JSON.stringify(c)}`).toBe(isSubsequence(q, c));
    }
  });
});

describe('performance (F17: ≤ 16 ms per keystroke over 5,000 candidates)', () => {
  it('p50 rank() over 40 queries of 1–12 chars ≤ 16 ms (the design bound) and p95 ≤ 48 ms (3× on the tail); both are reported', () => {
    const list = indexCandidates(corpus());
    const rnd = mulberry32(99);
    const queries: string[] = [];
    const pool = [...ASCII, ...CJK, 'tst/a', 'parse_date', 'sess', 'bud', 'res'];
    for (let n = 0; n < 40; n++) {
      const base = pool[Math.floor(rnd() * pool.length)] as string;
      const len = 1 + Math.floor(rnd() * 12);
      queries.push((base + base).slice(0, len));
    }
    for (let round = 0; round < 3; round++) for (const q of queries) rank(q, list); // warm-up (JIT tiering)
    const times: number[] = [];
    let total = 0;
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const t0 = performance.now();
        total += rank(q, list).length;
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    const p50 = times[Math.floor(times.length * 0.5)] as number;
    process.stderr.write(`fuzzy rank over 5,000 candidates: p50 ${p50.toFixed(2)} ms (bound 16), p95 ${p95.toFixed(2)} ms (bound 48)\n`);
    expect(total).toBeGreaterThan(0);
    expect(p50).toBeLessThanOrEqual(16);
    expect(p95).toBeLessThanOrEqual(48);
  });
});
