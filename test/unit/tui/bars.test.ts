import { describe, expect, it } from 'vitest';
import { SPARKLINE_CELLS, SPARKLINE_MAX_MS, barAriaLabel, eighthBar, sparkline, sparklineAriaLabel } from '../../../src/tui/bars.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

describe('eighthBar (TUI-DESIGN §7.2)', () => {
  it.each([
    [0, '··········'],
    [0.25, '██▌·······'],
    [0.44, '████▍·····'],
    [0.62, '██████▎···'],
    [0.64, '██████▍···'],
    [0.81, '████████▏·'],
    [0.88, '████████▊·'],
    [0.9, '█████████·'],
    [0.95, '█████████▌'],
    [1, '██████████'],
  ])('p=%d → %s', (p, bar) => {
    expect(eighthBar(p)).toBe(bar);
  });
  it('matches the design frames for the F-B column', () => {
    expect(eighthBar(0.78)).toBe('███████▊··');
    expect(eighthBar(0.89)).toBe('████████▉·');
    expect(eighthBar(0.68)).toBe('██████▊···');
    expect(eighthBar(0.61)).toBe('██████▏···');
    expect(eighthBar(0.24)).toBe('██▍·······');
    expect(eighthBar(0.05)).toBe('▌·········');
  });
  it('the full-cell count is ⌊p·cells⌋: the partial cell rounds, never into a full block', () => {
    expect(eighthBar(0.099)).toBe('▉·········');
    expect(eighthBar(0.199)).toBe('█▉········');
    expect(eighthBar(0.9999)).toBe('█████████▉');
    expect(eighthBar(0.7)).toBe('███████···');
    expect(eighthBar(0.3)).toBe('███·······');
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const full = (eighthBar(p).match(/█/g) ?? []).length;
      expect(full).toBe(Math.min(10, Math.floor(p * 10 + 1e-9)));
    }
  });
  it('clamps NaN to the empty track, ∞ to full, negatives to empty', () => {
    expect(eighthBar(Number.NaN)).toBe('··········');
    expect(eighthBar(Number.POSITIVE_INFINITY)).toBe('██████████');
    expect(eighthBar(Number.NEGATIVE_INFINITY)).toBe('··········');
    expect(eighthBar(-0.5)).toBe('··········');
    expect(eighthBar(7)).toBe('██████████');
  });
  it('honours cells: 0 / NaN → empty, 1000 → 1000 cells, fractional cells floor', () => {
    expect(eighthBar(0.5, 0)).toBe('');
    expect(eighthBar(0.5, Number.NaN)).toBe('');
    expect(eighthBar(0.5, -3)).toBe('');
    expect(cellWidth(eighthBar(0.5, 1000))).toBe(1000);
    expect(eighthBar(0.5, 2.9)).toBe('█·');
  });
  it('has the ascii twin (`#` on `-`, digit eighths) and the aria label', () => {
    expect(eighthBar(0.44, 10, GLYPHS.ascii)).toBe('####3-----');
    expect(eighthBar(1, 10, GLYPHS.ascii)).toBe('##########');
    expect(eighthBar(0, 10, GLYPHS.ascii)).toBe('----------');
    expect(barAriaLabel(0.44)).toBe('probability 0.44 of 1');
    expect(barAriaLabel(Number.NaN)).toBe('probability 0.00 of 1');
    expect(barAriaLabel(3)).toBe('probability 1.00 of 1');
  });
});

describe('sparkline (TUI-DESIGN §7.4)', () => {
  it('uses the fixed 0–1000 ms scale', () => {
    expect(SPARKLINE_MAX_MS).toBe(1000);
    expect(sparkline([0, 125, 250, 375, 500, 625, 750, 875, 1000, 5000], GLYPHS.unicode, 10)).toBe('▁▁▂▃▄▅▆▇██');
    expect(sparkline([1], GLYPHS.unicode, 1)).toBe('▁');
    expect(sparkline([999], GLYPHS.unicode, 1)).toBe('█');
  });
  it('renders a failed attempt as a space, pads short input on the left and keeps the last 12', () => {
    expect(sparkline([200, null, 200], GLYPHS.unicode, 3)).toBe('▂ ▂');
    expect(sparkline([200, Number.NaN], GLYPHS.unicode, 2)).toBe('▂ ');
    expect(sparkline([200], GLYPHS.unicode, 4)).toBe('   ▂');
    const many = Array.from({ length: 30 }, (_, i) => (i + 1) * 100);
    const s = sparkline(many);
    expect(s.length).toBe(SPARKLINE_CELLS);
    expect(s.endsWith('█')).toBe(true);
    expect(cellWidth(s)).toBe(12);
  });
  it('cells 0 / NaN → empty; ascii twin is digits', () => {
    expect(sparkline([100], GLYPHS.unicode, 0)).toBe('');
    expect(sparkline([100], GLYPHS.unicode, Number.NaN)).toBe('');
    expect(sparkline([125, 500, 1000, null], GLYPHS.ascii, 4)).toBe('148 ');
    expect(sparkline([], GLYPHS.unicode, 3)).toBe('   ');
  });
  it('negative and zero latencies sit on the lowest cell; huge ones on the top', () => {
    expect(sparkline([-5, 0, -Infinity, 1e9], GLYPHS.unicode, 4)).toBe('▁▁ █');
    expect(sparkline([-1], GLYPHS.ascii, 1)).toBe('1');
  });
  it('aria label lists the latencies', () => {
    expect(sparklineAriaLabel([231, null, 244])).toBe('jev latency last 3: 231 failed 244 ms');
    expect(sparklineAriaLabel([])).toBe('jev latency: no requests yet');
  });
});
