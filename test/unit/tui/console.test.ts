/**
 * TUI-DESIGN-2 §4.3 / §8.1 S4 (`console.test.ts`): every console row is exactly `columns` cells for 40..400,
 * `consoleLines().length === body + gate + 4`, the top edge places the badge left and the dir right (and degrades to a
 * card edge when the dir cannot fit), the divider and bottom edge, the H-A1 / H-A1w edges byte for byte, the `--ascii` twin.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Console, type ConsoleProps } from '../../../src/tui/Console.js';
import { createBuffer, reduceBuffer } from '../../../src/tui/composer/buffer.js';
import type { StatusLineState } from '../../../src/tui/status/lines.js';
import { consoleBottom, consoleDivider, consoleInnerWidth, consoleLines, consoleRow, consoleTopEdge, consoleTopEdgeParts } from '../../../src/tui/console-lines.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

afterEach(() => cleanup());

/** round-4 review finding 9: the retired prop must not even be DECLARED (§9.2's `Console.tsx` row). */
const CONSOLE_SOURCE = readFileSync(new URL('../../../src/tui/Console.tsx', import.meta.url), 'utf8');

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
    // TUI-DESIGN-4 §2.8 (P-R9): the ascii divider is `|---…---|`, not `+---…---+` — with `+` it was byte-identical to
    // the bottom edge, so the status compartment read as a second box
    expect(ascii[2]).toBe(`|${'-'.repeat(38)}|`);
    expect(ascii.at(-1)).toBe(`+${'-'.repeat(38)}+`);
    expect(ascii[2]).not.toBe(ascii.at(-1));
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.2 (P-R2) — one geometry per frame.
// ---------------------------------------------------------------------------------------
describe('TUI-DESIGN-4 §2.2 (P-R2): the draft wraps at the same `columns` the edges use', () => {
  const idle: StatusLineState = { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: { totalUsd: 0, capUsd: 1.25 } }, draft: { secretHits: 0 }, nowMs: 0 };
  const noop = (): void => undefined;
  const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '').split('\n');
  const consoleAt = (columns: number, text: string): React.JSX.Element =>
    createElement(Console, {
      buffer: reduceBuffer(createBuffer(), { type: 'insert', text }),
      columns,
      height: 4,
      top: 1,
      scrollTop: 0,
      cursor: noop,
      active: true,
      mode: 'task' as const,
      rows: 24,
      badge: 'jev-only',
      dir: 'proj',
      status: idle,
      statusOptions: {},
    });

  it('§10 S2: render at 80 with a 120-char draft, re-render at 44 — every row is 44 cells in the SAME commit', () => {
    const draft = 'x'.repeat(120);
    const ui = render(consoleAt(80, draft));
    for (const l of strip(ui.lastFrame())) expect(cellWidth(l), `80: ${l}`).toBe(80);
    // the re-render is ONE commit at the new width: before P-R2 the edges followed `columns` while the body still
    // wrapped at the debounced `wrapColumns`, and A2 measured 4 of 24 frames carrying a box row that ended in `…`
    ui.rerender(consoleAt(44, draft));
    const rows = strip(ui.lastFrame());
    expect(rows.length).toBeGreaterThan(3);
    for (const l of rows) expect(cellWidth(l), `44: ${l}`).toBe(44);
    for (const l of rows) expect(l.endsWith('\u2026'), `44: ${l}`).toBe(false);
    cleanup();
  });

  it('round-4 review finding 9: `bodyColumns` is GONE from `ConsoleProps` — there is no second width left to pass', () => {
    // §9.2's `Console.tsx` row reads "S1 (drop `bodyColumns`, §2.2 P-R2)", and S1's W2 commit has landed: `App.tsx`
    // passes it nowhere and `wrapColumns` / `createResizeDebounce` / `RESIZE_DEBOUNCE_MS` are gone. Leaving the prop
    // DECLARED — even ignored — is the escape hatch P-R2 exists to remove, so the assertion is on the type and the
    // declaration, not on a behaviour an ignored prop could still satisfy.
    // @ts-expect-error `bodyColumns` is no longer a member of ConsoleProps (TUI-DESIGN-4 §2.2 P-R2)
    const retired: Partial<ConsoleProps> = { bodyColumns: 120 };
    expect(retired).toEqual({ bodyColumns: 120 });
    expect(CONSOLE_SOURCE).not.toMatch(/^\s*bodyColumns\??:/m);
    // …and one geometry per frame is still what the box draws: every row is exactly `columns` at every width
    const draft = 'the quick brown fox jumps over the lazy dog and keeps on running past the fence';
    // `ink-testing-library`'s stdout is a FIXED 100 columns, so a rendered sweep above it measures Ink, not the box
    for (const columns of [44, 60, 80, 100]) {
      const rows = strip(render(consoleAt(columns, draft)).lastFrame());
      for (const l of rows) expect(cellWidth(l), `${columns}: ${l}`).toBe(columns);
      cleanup();
    }
  });
});
