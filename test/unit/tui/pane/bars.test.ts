import { describe, expect, it } from 'vitest';
import { eighthBar } from '../../../../src/tui/bars.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';

describe('eighthBar cells are width 1 (TUI-DESIGN §7.2, 11 §3.1)', () => {
  it('every bar of p ∈ [0, 1] in 0.001 steps is exactly `cells` cells wide in every glyph mode', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) eighthBar(i / 100_000);
    console.log(`[measured] eighthBar: ${((performance.now() - t0) / 100).toFixed(3)} µs per bar over 100,000 bars`);
    for (const g of [GLYPHS.unicode, GLYPHS.ascii, GLYPHS.sr]) {
      for (let i = 0; i <= 1000; i++) {
        const bar = eighthBar(i / 1000, 10, g);
        expect(cellWidth(bar)).toBe(10);
        expect([...bar].length).toBe(10);
      }
    }
  });
  it('every cell is one of the glyph set cells', () => {
    const allowed = new Set([GLYPHS.unicode.full, GLYPHS.unicode.dot, ...GLYPHS.unicode.eighths.slice(1)]);
    for (let i = 0; i <= 100; i++) for (const ch of eighthBar(i / 100)) expect(allowed.has(ch)).toBe(true);
    const ascii = new Set(['#', '-', '1', '2', '3', '4', '5', '6', '7']);
    for (let i = 0; i <= 100; i++) for (const ch of eighthBar(i / 100, 10, GLYPHS.ascii)) expect(ascii.has(ch)).toBe(true);
  });
  it('is monotone in p', () => {
    const order = [...GLYPHS.unicode.dot, ...GLYPHS.unicode.eighths.slice(1), GLYPHS.unicode.full];
    const rank = (bar: string): number => [...bar].reduce((a, ch) => a + order.indexOf(ch), 0);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const r = rank(eighthBar(i / 1000));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
  it('has the same shape in ascii and unicode (block count, partial index, track length)', () => {
    for (let i = 0; i <= 100; i++) {
      const u = eighthBar(i / 100);
      const a = eighthBar(i / 100, 10, GLYPHS.ascii);
      const shape = (s: string, full: string, dot: string): string => [...s].map((c) => (c === full ? 'F' : c === dot ? '.' : 'p')).join('');
      expect(shape(a, '#', '-')).toBe(shape(u, '█', '·'));
    }
  });
});
