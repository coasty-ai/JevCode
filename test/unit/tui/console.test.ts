/**
 * TUI-DESIGN-2 §4.3 / §8.1 S4 (`console.test.ts`): every console row is exactly `columns` cells for 40..400,
 * `consoleLines().length === body + gate + 4`, the top edge places the badge left and the dir right (and degrades to a
 * card edge when the dir cannot fit), the divider and bottom edge, the H-A1 / H-A1w edges byte for byte, the `--ascii` twin.
 */
import { describe, expect, it } from 'vitest';
import { consoleBottom, consoleDivider, consoleInnerWidth, consoleLines, consoleRow, consoleTopEdge, consoleTopEdgeParts } from '../../../src/tui/console-lines.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

describe('consoleLines (TUI-DESIGN-2 §4.3)', () => {
  it('every row is exactly columns cells for 40..400; the row count is body + gate + 4', () => {
    for (let columns = 40; columns <= 400; columns += 9) {
      const body = ['› Say hi, ask a question, or describe a task…', '  a continuation row', 'x'.repeat(600)];
      const lines = consoleLines({ columns, badge: 'jev-only', dir: 'proj', body, status: 'idle'.padEnd(consoleInnerWidth(columns) - 16) + 'step 0/–  ? help' });
      expect(lines.length).toBe(body.length + 4);
      for (const l of lines) expect(cellWidth(l), `${columns}: ${l}`).toBe(columns);
      const gated = consoleLines({ columns, badge: 'jev-only', dir: 'proj', body, gate: 'Looks like this contains a secret (sk-ant-…). Send anyway? y/N', status: 'idle' });
      expect(gated.length).toBe(body.length + 5);
      for (const l of gated) expect(cellWidth(l)).toBe(columns);
      expect(gated[1]?.startsWith('│ Looks like')).toBe(true);
    }
  });
  it('H-A1 and H-A1w: the top edge, divider, status row and bottom edge, byte for byte', () => {
    expect(consoleTopEdge('jev-only', 'proj', 80)).toBe('╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮');
    expect(consoleTopEdge('jev-only', 'proj', 120)).toBe('╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮');
    expect(consoleTopEdge('jev+llm · next run', 'proj', 80)).toBe('╭─ jev+llm · next run ────────────────────────────────────────────────── proj ─╮');
    expect(consoleTopEdge('setup · generator key', 'proj', 80)).toBe('╭─ setup · generator key ─────────────────────────────────────────────── proj ─╮');
    expect(consoleDivider(80)).toBe(`├${'─'.repeat(78)}┤`);
    expect(consoleBottom(80)).toBe(`╰${'─'.repeat(78)}╯`);
    expect(consoleRow('idle                                                        step 0/–  ? help', 80)).toBe('│ idle                                                        step 0/–  ? help │');
    expect(consoleRow('› Say hi, ask a question, or describe a task…', 80)).toBe('│ › Say hi, ask a question, or describe a task…                                │');
    expect(consoleInnerWidth(80)).toBe(76);
    expect(consoleInnerWidth(120)).toBe(116);
    expect(consoleInnerWidth(3)).toBe(1);
  });
  it('the parts join to the edge; the dir is cut, then dropped before the fill goes negative; an empty dir is a card edge', () => {
    const p = consoleTopEdgeParts('jev-only', 'proj', 80);
    expect(`${p.left}${p.badge}${p.fill}${p.dir}${p.right}`).toBe(consoleTopEdge('jev-only', 'proj', 80));
    expect(p.badge).toBe('jev-only');
    expect(p.dir).toBe('proj');
    const cut = consoleTopEdge('jev-only', 'a-very-long-workspace-directory-name', 40);
    expect(cellWidth(cut)).toBe(40);
    expect(cut).toMatch(/^╭─ jev-only ─ a-very-long-work…? ─╮$|^╭─ jev-only ─ .*… ─╮$/);
    // a badge that leaves no room for the dir drops the dir and draws like a card title (cut to columns − 6)
    const dropped = consoleTopEdge('a'.repeat(34), 'proj', 40);
    expect(cellWidth(dropped)).toBe(40);
    expect(dropped).toBe(`╭─ ${'a'.repeat(34)} ─╮`);
    expect(consoleTopEdge('a'.repeat(40), 'proj', 40)).toBe(`╭─ ${'a'.repeat(33)}… ─╮`);
    expect(consoleTopEdge('jev-only', '', 80)).toBe(`╭─ jev-only ${'─'.repeat(80 - 13)}╮`);
    expect(consoleTopEdge('x', 'y', 3)).toBe('───');
  });
  it('a hosted title replaces the badge; the --ascii twin draws `+- jev-only ------ proj -+`', () => {
    const lines = consoleLines({ columns: 40, badge: 'jev-only', dir: 'proj', title: 'sessions · filter', body: ['› filter: par'], status: 'picker  step 0/–' });
    expect(lines[0]?.startsWith('╭─ sessions · filter ')).toBe(true);
    const ascii = consoleLines({ columns: 40, badge: 'jev-only', dir: 'proj', body: ['> hi'], status: 'idle', glyphs: GLYPHS.ascii });
    expect(ascii[0]).toBe(`+- jev-only ${'-'.repeat(40 - 20)} proj -+`);
    for (const l of ascii) {
      expect(l).toMatch(/^[\x20-\x7e]*$/);
      expect(cellWidth(l)).toBe(40);
    }
    expect(ascii[2]).toBe(`+${'-'.repeat(38)}+`);
  });
});
