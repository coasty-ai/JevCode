/**
 * TUI-DESIGN-2 §4.7 / §8.1 S4 (`card.test.ts`): every card row is exactly `columns` cells for 40..400, `cardLines().length ===
 * body + 2`, the title is cut to `columns − 6`, an empty title draws the bare edge, and the `--ascii` twin is pure ASCII.
 */
import { describe, expect, it } from 'vitest';
import { cardBottom, cardLines, cardRow, cardTop, CARD_TITLE_MARGIN } from '../../../src/tui/card.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

describe('cardLines (TUI-DESIGN-2 §4.7)', () => {
  it('every row is exactly columns cells for 40..400 and the row count is body + 2', () => {
    const body = ['[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)', 'x'.repeat(500), '', 'wide 日本語 text'];
    for (let columns = 40; columns <= 400; columns += 7) {
      const lines = cardLines('run this as a task?', body, columns);
      expect(lines.length).toBe(body.length + 2);
      for (const l of lines) expect(cellWidth(l), `${columns}: ${l}`).toBe(columns);
      expect(lines[0]?.startsWith('╭─ run this as a task? ')).toBe(true);
      expect(lines[0]?.endsWith('╮')).toBe(true);
      expect(lines.at(-1)).toBe(`╰${'─'.repeat(columns - 2)}╯`);
      for (const l of lines.slice(1, -1)) expect(l.startsWith('│ ') && l.endsWith(' │')).toBe(true);
    }
  });
  it('H-I1: the intake card at 80 columns, byte for byte', () => {
    expect(cardLines('run this as a task?', ['[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)'], 80)).toEqual([
      '╭─ run this as a task? ────────────────────────────────────────────────────────╮',
      '│ [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)    │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
    ]);
  });
  it('the title is cut to columns − 6 with the ellipsis; an empty title is the bare edge; tiny widths degrade to rules', () => {
    const long = cardTop('x'.repeat(200), 80);
    expect(cellWidth(long)).toBe(80);
    expect(long).toBe(`╭─ ${'x'.repeat(80 - CARD_TITLE_MARGIN - 1)}… ─╮`);
    expect(cardTop('', 10)).toBe('╭────────╮');
    expect(cardTop('t', 3)).toBe('───');
    expect(cardRow('abc', 3)).toBe('abc');
    expect(cardBottom(2)).toBe('──');
    expect(cardTop('t', 0)).toBe('');
    expect(cardLines('t', ['a'], Number.NaN)).toEqual(['', '', '']);
  });
  it('the --ascii twin is pure ASCII', () => {
    const lines = cardLines('exit?', ['a run is live: [y] abort and exit   [n] stay'], 60, GLYPHS.ascii);
    for (const l of lines) {
      expect(l).toMatch(/^[\x20-\x7e]*$/);
      expect(cellWidth(l)).toBe(60);
    }
    expect(lines[0]).toBe(`+- exit? ${'-'.repeat(60 - 10)}+`);
  });
});
