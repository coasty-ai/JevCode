/**
 * TUI-DESIGN-4 §2.8 (P-R9) / §10 S2 (`console-lines.test.ts`): **every console row is exactly `columns` cells at
 * widths 0…200**, and `consoleDivider(w, ascii) !== consoleBottom(w, ascii)` for every `w ≥ 4`.
 *
 * The second assertion is the defect: with `teeLeft`/`teeRight` as `+` the `--ascii` divider `+---…---+` and the
 * bottom edge `+---…---+` are byte-identical, so the status compartment reads as a *second box* underneath the
 * composer. The tees are `|`, so the divider is `|---…---|` inside one box. Round 2's `console.test.ts` covers the
 * 40…400 band and the byte-for-byte H-A1 edges; this file covers the sub-40 widths the narrow ladder opened up.
 */
import { describe, expect, it } from 'vitest';
import { consoleBottom, consoleDivider, consoleInnerWidth, consoleLines, consoleRow, consoleTopEdge } from '../../../src/tui/console-lines.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

const SETS = [
  ['unicode', GLYPHS.unicode],
  ['ascii', GLYPHS.ascii],
] as const;

describe('every console row is exactly `columns` cells (§2.8, §11 "no row wider than the terminal")', () => {
  it.each(SETS)('%s: the four edge builders are exactly `columns` cells at widths 0…200', (_name, g) => {
    for (let w = 0; w <= 200; w++) {
      expect(cellWidth(consoleTopEdge('jev-only', 'proj', w, g)), `top ${w}`).toBe(w);
      expect(cellWidth(consoleDivider(w, g)), `divider ${w}`).toBe(w);
      expect(cellWidth(consoleBottom(w, g)), `bottom ${w}`).toBe(w);
      expect(cellWidth(consoleRow('idle · step 0/–', w, g)), `row ${w}`).toBe(w);
    }
  });

  it.each(SETS)('%s: a whole `consoleLines()` block is exactly `columns` cells on every row, at the sub-40 widths too', (_name, g) => {
    for (const columns of [2, 4, 8, 10, 16, 20, 24, 30, 34, 37, 40, 80, 120, 200]) {
      const lines = consoleLines({ columns, badge: 'jev-only', dir: 'proj', body: ['› hi', '  there'], status: 'idle', glyphs: g });
      expect(lines).toHaveLength(6);
      for (const l of lines) expect(cellWidth(l), `${columns}: ${JSON.stringify(l)}`).toBe(columns);
    }
  });
});

describe('P-R9: the divider and the bottom edge are different rows in both glyph sets', () => {
  it.each(SETS)('%s: `consoleDivider(w) !== consoleBottom(w)` for every w ≥ 4', (_name, g) => {
    for (let w = 4; w <= 200; w++) {
      expect(consoleDivider(w, g), `${w}`).not.toBe(consoleBottom(w, g));
    }
  });

  it('the ascii twin: `|---…---|` for the divider, `+---…---+` for the bottom, `+- … -+` for the top', () => {
    expect(consoleDivider(40, GLYPHS.ascii)).toBe(`|${'-'.repeat(38)}|`);
    expect(consoleBottom(40, GLYPHS.ascii)).toBe(`+${'-'.repeat(38)}+`);
    expect(consoleDivider(40)).toBe(`├${'─'.repeat(38)}┤`);
    expect(consoleBottom(40)).toBe(`╰${'─'.repeat(38)}╯`);
    for (const l of [consoleDivider(40, GLYPHS.ascii), consoleBottom(40, GLYPHS.ascii)]) expect(l).toMatch(/^[\x20-\x7e]*$/);
  });

  it('below 4 cells both degrade to a rule row (there is no room for a corner) and stay exactly `w`', () => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (const w of [0, 1, 2, 3]) {
        expect(cellWidth(consoleDivider(w, g))).toBe(w);
        expect(cellWidth(consoleBottom(w, g))).toBe(w);
      }
    }
  });
});

describe('consoleInnerWidth (the width every body builder is handed)', () => {
  it('is `columns − 4`, never below 1, and total-row arithmetic closes at every width', () => {
    for (let w = 0; w <= 200; w++) {
      const inner = consoleInnerWidth(w);
      expect(inner).toBeGreaterThanOrEqual(1);
      if (w >= 5) expect(inner).toBe(w - 4);
    }
    expect(consoleInnerWidth(Number.NaN)).toBe(1);
  });
});
