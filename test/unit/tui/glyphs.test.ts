import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth, fitCells, glyphSet, glyphTwin, oneLineCells, padEndCells, padStartCells, ruleRow, stepLabelCells, truncateCells, type GlyphSet } from '../../../src/tui/glyphs.js';

const ASCII_RE = /^[\x20-\x7e]*$/;

function every(g: GlyphSet): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'mode') continue;
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'string') out.push(v);
  }
  return out;
}

describe('GLYPHS (TUI-DESIGN §14.1)', () => {
  it('the ascii twin is pure ASCII for every glyph and the unicode set is not empty anywhere', () => {
    for (const s of every(GLYPHS.ascii)) expect(s).toMatch(ASCII_RE);
    for (const s of every(GLYPHS.unicode)) expect(typeof s).toBe('string');
    expect(GLYPHS.unicode.eighths).toEqual(['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']);
    expect(GLYPHS.ascii.eighths).toEqual(['', '1', '2', '3', '4', '5', '6', '7']);
  });
  it('follows the §14.1 substitution table', () => {
    const a = GLYPHS.ascii;
    const u = GLYPHS.unicode;
    expect([u.rule, a.rule]).toEqual(['─', '-']);
    expect([u.chevron, a.chevron]).toEqual(['›', '>']);
    expect([u.check, a.check, u.cross, a.cross]).toEqual(['✓', '+', '✗', 'x']);
    expect([u.up, a.up, u.down, a.down]).toEqual(['↑', '^', '↓', 'v']);
    expect([u.branch, a.branch]).toEqual(['⎇', 'br']);
    expect([u.dagger, a.dagger, u.bullet, a.bullet, u.dot, a.dot, u.band, a.band]).toEqual(['†', '+', '•', '*', '·', '-', '┆', ':']);
    expect([u.full, a.full, u.spinnerStatic, a.spinnerStatic]).toEqual(['█', '#', '•', '*']);
    expect(a.spinner).toEqual(['|', '/', '-', '\\']);
    expect([u.arrow, a.arrow, u.ge, a.ge, u.le, a.le, u.approx, a.approx]).toEqual(['→', '->', '≥', '>=', '≤', '<=', '≈', '~=']);
    expect([u.range, a.range, u.minus, a.minus, u.dash, a.dash, u.sigma, a.sigma]).toEqual(['–', '-', '−', '-', '—', '-', 'Σ', 'sum']);
    expect(u.range.codePointAt(0)).toBe(0x2013);
    expect(u.minus.codePointAt(0)).toBe(0x2212);
  });
  it('glyphTwin substitutes every table glyph under --ascii and is the identity otherwise', () => {
    expect(glyphTwin('choice resolution → intent edit', GLYPHS.ascii)).toBe('choice resolution -> intent edit');
    expect(glyphTwin('paired ≥ 0.5 · |2p−1| ≈ 0 – ─┆', GLYPHS.ascii)).toBe('paired >= 0.5 - |2p-1| ~= 0 - -:');
    expect(glyphTwin('▂▃█▏', GLYPHS.ascii)).toBe('23#1');
    expect(glyphTwin('plain ascii', GLYPHS.ascii)).toBe('plain ascii');
    expect(glyphTwin('choice resolution → intent edit', GLYPHS.unicode)).toBe('choice resolution → intent edit');
    expect(glyphTwin('choice resolution → intent edit', GLYPHS.sr)).toBe('choice resolution → intent edit');
    expect(glyphTwin('', GLYPHS.ascii)).toBe('');
    for (const s of every(GLYPHS.unicode)) expect(glyphTwin(s, GLYPHS.ascii)).toMatch(/^[\x20-\x7e]*$|^[⠋⠙⠸⠼⠴⠦⠧⠇⠏]$/);
  });
  it('stepLabelCells is 2 up to s9, 3 from s10, one more per digit, and reads every step given', () => {
    expect(stepLabelCells([])).toBe(2);
    expect(stepLabelCells([0])).toBe(2);
    expect(stepLabelCells([7])).toBe(2);
    expect(stepLabelCells([9, 10])).toBe(3);
    expect(stepLabelCells([99])).toBe(3);
    expect(stepLabelCells([100])).toBe(4);
    expect(stepLabelCells([Number.NaN, 3.7])).toBe(2);
    expect(stepLabelCells([-12])).toBe(4);
  });
  it('the screen-reader set reuses the unicode glyphs under mode sr', () => {
    expect(GLYPHS.sr.mode).toBe('sr');
    expect({ ...GLYPHS.sr, mode: 'unicode' }).toEqual(GLYPHS.unicode);
  });
  it('glyphSet: ascii wins over screenReader; default unicode', () => {
    expect(glyphSet().mode).toBe('unicode');
    expect(glyphSet({ screenReader: true }).mode).toBe('sr');
    expect(glyphSet({ ascii: true, screenReader: true }).mode).toBe('ascii');
  });
});

describe('cellWidth', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 1],
    ['é', 1],
    ['日本', 4],
    ['한', 2],
    ['😀', 2],
    ['👨‍👩‍👧', 2],
    ['1️⃣', 1],
    ['​', 0],
    ['a\u0000b', 2],
    ['\x1b[31m', 4],
    ['─', 1],
    ['█▏▎▍▌▋▊▉·', 9],
    ['⠹', 1],
    ['⎇', 1],
  ])('%j → %d cells', (s, w) => {
    expect(cellWidth(s)).toBe(w);
  });
  it('is additive over ASCII and CJK mixes', () => {
    expect(cellWidth('ab日c')).toBe(5);
    expect(cellWidth('x'.repeat(10_000))).toBe(10_000);
  });
});

describe('truncateCells', () => {
  it('leaves a fitting string alone and cuts with the glyph set ellipsis otherwise', () => {
    expect(truncateCells('hello', 5)).toBe('hello');
    expect(truncateCells('hello world', 8)).toBe('hello w…');
    expect(cellWidth(truncateCells('hello world', 8))).toBe(8);
    expect(truncateCells('hello world', 8, GLYPHS.ascii)).toBe('hello...');
  });
  it('never splits a wide character and never exceeds max', () => {
    for (let max = 0; max <= 12; max++) {
      const t = truncateCells('日本語テキスト', max);
      expect(cellWidth(t)).toBeLessThanOrEqual(max);
    }
    expect(truncateCells('日本語', 5)).toBe('日本…');
    expect(truncateCells('日本語', 4)).toBe('日…');
  });
  it('keeps grapheme clusters whole', () => {
    expect(truncateCells('a👨‍👩‍👧bc', 4)).toBe('a👨‍👩‍👧…');
    expect(truncateCells('a👨‍👩‍👧b', 3)).toBe('a…');
    expect(truncateCells('👨‍👩‍👧bc', 2)).toBe('…');
    expect(truncateCells('e\u0301x', 2)).toBe('e\u0301x');
    expect(truncateCells('e\u0301xy', 2)).toBe('e\u0301…');
  });
  it('handles max ≤ 0, NaN, Infinity and max below the ellipsis width', () => {
    expect(truncateCells('abc', 0)).toBe('');
    expect(truncateCells('abc', -3)).toBe('');
    expect(truncateCells('abc', Number.NaN)).toBe('');
    expect(truncateCells('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(truncateCells('abcdef', 1)).toBe('a');
    expect(truncateCells('abcdef', 2, GLYPHS.ascii)).toBe('ab');
    expect(truncateCells('abcdef', 4, GLYPHS.ascii)).toBe('a...');
  });
  it('is fast on a huge input', () => {
    const big = 'x'.repeat(200_000) + '日'.repeat(50_000);
    const t0 = performance.now();
    expect(cellWidth(truncateCells(big, 80))).toBe(80);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('pad / fit / oneLine', () => {
  it('pads by cells, not by code units', () => {
    expect(padEndCells('日', 4)).toBe('日  ');
    expect(padStartCells('日', 4)).toBe('  日');
    expect(padEndCells('toolong', 3)).toBe('toolong');
    expect(fitCells('日本語', 4)).toBe('日… ');
    expect(cellWidth(fitCells('abc', 10))).toBe(10);
    expect(fitCells('abc', 0)).toBe('');
  });
  it('oneLineCells drops controls and collapses breaks', () => {
    expect(oneLineCells('a\r\nb\tc\u001b[2Jd\u0085e')).toBe('a b c[2Jd\u0085e'.replace('\u0085', ''));
    expect(oneLineCells('plain')).toBe('plain');
    expect(oneLineCells('a\u007fb\u0000c')).toBe('abc');
  });
  it('oneLineCells strips bidi controls (Trojan-Source) and turns U+2028/2029 into spaces (§14.1)', () => {
    expect(oneLineCells('run \u202etests\u202c now')).toBe('run tests now');
    expect(oneLineCells('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde');
    expect(oneLineCells('\u200eL\u200fR\u061cA')).toBe('LRA');
    expect(oneLineCells('\u202a\u202b\u202c\u202d\u202ex')).toBe('x');
    expect(oneLineCells('a\u2028b\u2029c')).toBe('a b c');
    // joiners and marks that shape legitimate text survive
    expect(oneLineCells('👨\u200d👩\u200d👧')).toBe('👨\u200d👩\u200d👧');
    expect(oneLineCells('e\u0301 \u200bx')).toBe('e\u0301 \u200bx');
    expect(oneLineCells('x'.repeat(100_000)).length).toBe(100_000);
  });
});

describe('ruleRow', () => {
  it('is exactly `columns` cells from 20 to 200 and capped at 400', () => {
    for (let c = 20; c <= 200; c += 7) expect(cellWidth(ruleRow('decisions s7', ' [d]ecisions [p]lan [t]ime [s]ynth ──', c))).toBe(c);
    expect(cellWidth(ruleRow('x', ' y ', 1000))).toBe(400);
  });
  it('drops the right part when it does not fit, then truncates the head; 0 columns → empty', () => {
    const r = ruleRow('decisions s7', ' [d]ecisions [p]lan [t]ime [s]ynth ──', 20);
    expect(r).toBe('─── decisions s7 ───');
    expect(cellWidth(ruleRow('a very long left label here', ' right ', 10))).toBe(10);
    expect(ruleRow('a', 'b', 0)).toBe('');
    expect(ruleRow('a', 'b', Number.NaN)).toBe('');
  });
  it('has an ASCII twin', () => {
    expect(ruleRow('plan s7', ' [d]ecisions ', 40, GLYPHS.ascii)).toMatch(ASCII_RE);
  });
});
