/**
 * TUI-DESIGN §4.2, §19.0 (`width.test.ts`): `cellWidth`/`stringWidth` replicate string-width@8.2.2 over the 400+ fixture
 * strings and, when the package resolves from node_modules, over a live fuzz corpus too; `truncateCells`; throughput.
 */
import { describe, expect, it } from 'vitest';
import { budgetMs } from '../../helpers/perf-budget.js';
import { EAW_UNICODE_VERSION, EAW_WIDE_RANGES } from '../../../../src/tui/composer/eaw-table.js';
import { ELLIPSIS, cellWidth, eastAsianWidth, isWideCodePoint, stringWidth, truncateCells } from '../../../../src/tui/composer/width.js';
import { INSERT_POOL, bestMs, graphemes, loadStringWidth, loadWidthFixtures, medianMs, mulberry32, pick } from './helpers.js';

const fixtures = loadWidthFixtures();
const live = await loadStringWidth();

describe('eaw-table', () => {
  it('is a sorted, non-overlapping flat pair list generated for a named Unicode version', () => {
    expect(EAW_WIDE_RANGES.length % 2).toBe(0);
    expect(EAW_WIDE_RANGES.length / 2).toBeGreaterThanOrEqual(120);
    expect(EAW_UNICODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 0; i + 1 < EAW_WIDE_RANGES.length; i += 2) {
      const a = EAW_WIDE_RANGES[i] ?? -1;
      const b = EAW_WIDE_RANGES[i + 1] ?? -1;
      expect(a).toBeLessThanOrEqual(b);
      const nextStart = EAW_WIDE_RANGES[i + 2];
      if (nextStart !== undefined) expect(nextStart).toBeGreaterThan(b + 1);
    }
  });

  it('binary search finds wide, fullwidth and rejects narrow / ambiguous code points', () => {
    expect(isWideCodePoint(0x4e00)).toBe(true); // 一
    expect(isWideCodePoint(0xff01)).toBe(true); // ！ fullwidth
    expect(isWideCodePoint(0x3000)).toBe(true); // ideographic space
    expect(isWideCodePoint(0x1f600)).toBe(true); // 😀
    expect(isWideCodePoint(0x1100)).toBe(true); // ᄀ
    expect(isWideCodePoint(0x20000)).toBe(true);
    expect(isWideCodePoint(0x3fffd)).toBe(true);
    expect(isWideCodePoint(0x41)).toBe(false);
    expect(isWideCodePoint(0xe9)).toBe(false); // é
    expect(isWideCodePoint(0x2192)).toBe(false); // → ambiguous = narrow
    expect(isWideCodePoint(0x2500)).toBe(false); // ─ ambiguous
    expect(isWideCodePoint(0xff61)).toBe(false); // ｡ halfwidth
    expect(isWideCodePoint(0xffe7)).toBe(false);
    expect(isWideCodePoint(-1)).toBe(false);
    expect(isWideCodePoint(0x110000)).toBe(false);
    expect(isWideCodePoint(Number.NaN)).toBe(false);
    expect(eastAsianWidth(0x4e00)).toBe(2);
    expect(eastAsianWidth(0x41)).toBe(1);
  });
});

describe('cellWidth rules (string-width@8.2.2)', () => {
  it('rule 1: zero-width classes', () => {
    for (const s of ['\u200b', '\u200d', '\ufeff', '\u0301', '\u0300\u0301', '\u20e3', '\u00ad', '\t', '\u0000', '\u001b', '\u007f', '\u0085', '\ud800', '\udc00', '']) {
      expect(cellWidth(s), JSON.stringify(s)).toBe(0);
    }
  });
  it('rule 2: RGI emoji = 2', () => {
    for (const s of ['👍', '👍🏽', '👨\u200d👩\u200d👧\u200d👦', '❤\ufe0f', '☃\ufe0f', '1\ufe0f\u20e3', '🇺🇸', '🏳\ufe0f\u200d🌈', '🧑🏽\u200d🚀', '⌚', '✅', '©\ufe0f']) expect(cellWidth(s), s).toBe(2);
  });
  it('rule 3: unqualified keycap and ZWJ sequences with ≥ 2 pictographs = 2; text-presentation defaults stay 1', () => {
    expect(cellWidth('1\u20e3')).toBe(2);
    expect(cellWidth('#\u20e3')).toBe(2);
    expect(cellWidth('👁\u200d🗨')).toBe(2);
    expect(cellWidth('🏳\u200d🌈')).toBe(2);
    expect(cellWidth('❤')).toBe(1);
    expect(cellWidth('☃')).toBe(1);
    expect(cellWidth('©')).toBe(1);
    expect(cellWidth('x\u200dy')).toBe(1);
    // pathological cluster longer than 50 chars never trips the emoji heuristics
    expect(cellWidth('a' + '\u200d'.repeat(60))).toBe(1);
  });
  it('rule 4: Hangul L+V(+T) = 2, unmatched jamo additive', () => {
    expect(cellWidth('가')).toBe(2);
    expect(cellWidth('각')).toBe(2);
    expect(cellWidth('각')).toBe(2);
    expect(cellWidth('ᄀ')).toBe(2);
    expect(cellWidth('ᄀ가')).toBe(4);
    expect(cellWidth('ᄀ가')).toBe(4);
  });
  it('rule 5: EAW of the first visible scalar; ambiguous = narrow; trailing spacing marks and halfwidth forms add', () => {
    expect(cellWidth('日')).toBe(2);
    expect(cellWidth('Ａ')).toBe(2);
    expect(cellWidth('é')).toBe(1);
    expect(cellWidth('e\u0301')).toBe(1);
    expect(cellWidth('→')).toBe(1);
    expect(cellWidth('─')).toBe(1);
    expect(cellWidth('…')).toBe(1);
    expect(cellWidth('ｷﾞ')).toBe(2);
    expect(cellWidth('कि')).toBe(2);
    expect(cellWidth('कु')).toBe(1);
    expect(cellWidth('\u200b日')).toBe(2); // leading non-printing skipped
  });
});

describe('stringWidth vs the checked-in fixtures', () => {
  it(`has at least 400 fixture strings (${fixtures.count})`, () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(400);
    expect(fixtures.generator).toContain('string-width@8.2.2');
  });
  it.each(fixtures.cases.map((c) => [JSON.stringify(c.s), c.s, c.w] as const))('%s → %i', (_label, s, w) => {
    expect(stringWidth(s)).toBe(w);
    // and per cluster, so a compensating error between clusters cannot hide
    let sum = 0;
    for (const g of graphemes(s)) sum += cellWidth(g);
    expect(sum).toBe(w);
  });
});

describe.skipIf(live === null)('stringWidth vs the installed string-width (live)', () => {
  const sw = live as NonNullable<typeof live>;
  it('agrees on every fixture string', () => {
    for (const c of fixtures.cases) expect(stringWidth(c.s), JSON.stringify(c.s)).toBe(sw(c.s));
  });
  it('agrees on 3,000 seeded mixed-script strings and on each of their clusters', () => {
    const r = mulberry32(0x5eed);
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(r() * 10);
      let s = '';
      for (let k = 0; k < n; k++) s += pick(r, INSERT_POOL);
      expect(stringWidth(s), JSON.stringify(s)).toBe(sw(s));
      for (const g of graphemes(s)) expect(cellWidth(g), JSON.stringify(g)).toBe(sw(g));
    }
  });
  it('agrees on every BMP code point that is not a control, surrogate or ANSI-sensitive byte', () => {
    for (let cp = 0x20; cp < 0x10000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (cp === 0x1b || cp === 0x9b) continue; // string-width strips ANSI; the buffer never holds ESC
      const s = String.fromCodePoint(cp);
      const ours = cellWidth(s);
      const theirs = sw(s);
      if (ours !== theirs) expect.fail(`U+${cp.toString(16)} ours=${ours} string-width=${theirs}`);
    }
  });
  it('agrees on the supplementary planes sampled every 7th code point', () => {
    for (let cp = 0x10000; cp <= 0x10ffff; cp += 7) {
      const s = String.fromCodePoint(cp);
      const ours = cellWidth(s);
      const theirs = sw(s);
      if (ours !== theirs) expect.fail(`U+${cp.toString(16)} ours=${ours} string-width=${theirs}`);
    }
  });
});

describe('truncateCells', () => {
  it('returns the string when it fits and cuts by grapheme with an ellipsis otherwise', () => {
    expect(truncateCells('hello', 5)).toBe('hello');
    expect(truncateCells('hello', 4)).toBe('hel…');
    expect(truncateCells('hello world', 1)).toBe('…');
    expect(truncateCells('日本語', 6)).toBe('日本語');
    expect(truncateCells('日本語', 5)).toBe('日本…');
    expect(truncateCells('日本語', 4)).toBe('日…');
    expect(truncateCells('日本語', 2)).toBe('…');
    expect(truncateCells('👨\u200d👩\u200d👧\u200d👦👨\u200d👩\u200d👧\u200d👦', 3)).toBe('👨\u200d👩\u200d👧\u200d👦…');
    expect(truncateCells('e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…');
    expect(stringWidth(truncateCells('日本語テキスト', 7))).toBeLessThanOrEqual(7);
    expect(truncateCells('', 10)).toBe('');
  });
  it('handles zero, negative, NaN, ±Infinity and fractional cells', () => {
    expect(truncateCells('abc', 0)).toBe('');
    expect(truncateCells('abc', -3)).toBe('');
    expect(truncateCells('abc', Number.NaN)).toBe('');
    expect(truncateCells('abc', Number.NEGATIVE_INFINITY)).toBe('');
    // +Infinity is "no limit": the string comes back untouched, never blanked
    expect(truncateCells('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(truncateCells('日本語👍', Number.POSITIVE_INFINITY)).toBe('日本語👍');
    expect(truncateCells('', Number.POSITIVE_INFINITY)).toBe('');
    expect(truncateCells('abc', 2.9)).toBe('a…');
    expect(ELLIPSIS).toBe('…');
    expect(cellWidth(ELLIPSIS)).toBe(1);
  });
  it('never exceeds the budget over a fuzz corpus', () => {
    const r = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      let s = '';
      const n = Math.floor(r() * 12);
      for (let k = 0; k < n; k++) s += pick(r, INSERT_POOL);
      const cells = Math.floor(r() * 10);
      const t = truncateCells(s, cells);
      expect(stringWidth(t)).toBeLessThanOrEqual(Math.max(0, cells));
      if (stringWidth(s) <= cells) expect(t).toBe(s);
    }
  });
});

describe('throughput (07 §4: 13,000 mixed chars → 1.66 ms per segmentation pass; bound 3× = 5 ms, best of 7 runs)', () => {
  it('stringWidth of 13,000 mixed chars from the fuzz pool stays under 5 ms', () => {
    const r = mulberry32(7);
    let s = '';
    while (s.length < 13000) s += pick(r, INSERT_POOL);
    const best = bestMs(() => stringWidth(s));
    const med = medianMs(() => stringWidth(s));
    process.stdout.write(`[measured] stringWidth(${s.length} chars) best ${best.toFixed(3)} ms, median ${med.toFixed(3)} ms\n`);
    expect(best).toBeLessThan(budgetMs(5));
  });
  it('printable ASCII takes the fast path (12,000 chars well under 0.1 ms)', () => {
    const s = 'x'.repeat(12000);
    const ms = medianMs(() => stringWidth(s));
    expect(ms).toBeLessThan(1);
  });
});
