/**
 * TUI-DESIGN-2 §4.2 / §8.1 S4 (`cursor.test.tsx`): the one cursor formula — `y = composerTop(layout) + view.cursor.row`,
 * `x = 2 + view.cursor.x` in the boxed tier: idle (`consoleTop + 1`), the hosted gate row up (`consoleTop + 2`), a 3-row draft
 * with the cursor on its last row (`consoleTop + 3`); the flat tier keeps today's values (`x = view.cursor.x`, `y = composerTop`).
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { CursorPosition } from 'ink';
import { Console } from '../../../src/tui/Console.js';
import { Composer } from '../../../src/tui/composer/Composer.js';
import { createBuffer, reduceBuffer } from '../../../src/tui/composer/buffer.js';
import { CAP, chromeRows, composerTop, computeLayout, consoleTop, type LayoutInput } from '../../../src/tui/layout.js';
import type { StatusLineState } from '../../../src/tui/status/lines.js';

afterEach(() => cleanup());

const status: StatusLineState = { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: null }, draft: { secretHits: 0 }, nowMs: 0 };

function layoutFor(o: Partial<LayoutInput>): ReturnType<typeof computeLayout> {
  return computeLayout({ rows: 24, columns: 80, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0, paneWant: 0, chrome: chromeRows(24, 80, false), gate: 0, ...o });
}

describe('the cursor formula (TUI-DESIGN-2 §4.2)', () => {
  it('idle: y = consoleTop + 1, x = 2 + prompt width', () => {
    const layout = layoutFor({});
    expect(composerTop(layout)).toBe(consoleTop(layout) + 1);
    const positions: (CursorPosition | undefined)[] = [];
    render(<Console buffer={createBuffer()} columns={80} height={layout.composer} top={consoleTop(layout)} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={24} badge="jev-only" dir="proj" status={status} statusOptions={{}} />);
    expect(positions.at(-1)).toEqual({ x: 2 + 2, y: consoleTop(layout) + 1 });
  });
  it('the hosted gate row: the draft moves one row down (y = consoleTop + 2) and the layout floor is 1 + gate', () => {
    const layout = layoutFor({ overlay: 'secret', overlayWant: 0, gate: 1 });
    expect(layout.gate).toBe(1);
    expect(layout.composer).toBe(2);
    expect(composerTop(layout)).toBe(consoleTop(layout) + 2);
    const positions: (CursorPosition | undefined)[] = [];
    const b = reduceBuffer(createBuffer(), { type: 'insert', text: 'use the key' });
    render(<Console buffer={b} columns={80} height={layout.composer - layout.gate} top={consoleTop(layout)} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={24} badge="jev-only" dir="proj" gate="Looks like this contains a secret (sk-ant-…). Send anyway? y/N" status={status} statusOptions={{}} />);
    expect(positions.at(-1)).toEqual({ x: 2 + 2 + 'use the key'.length, y: consoleTop(layout) + 2 });
  });
  it('a 3-row draft with the cursor on the last row: y = consoleTop + 3', () => {
    const layout = layoutFor({ composerWant: 3 });
    expect(layout.composer).toBe(3);
    const positions: (CursorPosition | undefined)[] = [];
    const b = reduceBuffer(createBuffer(), { type: 'insert', text: 'one\ntwo\nthree' });
    render(<Console buffer={b} columns={80} height={layout.composer} top={consoleTop(layout)} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={24} badge="jev-only" dir="proj" status={status} statusOptions={{}} />);
    expect(positions.at(-1)).toEqual({ x: 2 + 2 + 'three'.length, y: consoleTop(layout) + 3 });
  });
  it('the flat tier keeps today’s values: x = view.cursor.x, y = composerTop = consoleTop', () => {
    const layout = computeLayout({ rows: 12, columns: 60, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0, paneWant: 0, chrome: chromeRows(12, 60, false), gate: 0 });
    expect(layout.chrome).toBe(0);
    expect(composerTop(layout)).toBe(consoleTop(layout));
    const positions: (CursorPosition | undefined)[] = [];
    const b = reduceBuffer(createBuffer(), { type: 'insert', text: 'hi' });
    render(<Composer buffer={b} columns={60} height={1} top={composerTop(layout)} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={12} />);
    expect(positions.at(-1)).toEqual({ x: 2 + 2, y: composerTop(layout) });
  });
  it('the review card leaves the composer inactive: no cursor; the wizard places it after the masked cells on the console’s field row', () => {
    const layout = layoutFor({ overlay: 'review', overlayWant: CAP.reviewCard, previewWant: 4 });
    const positions: (CursorPosition | undefined)[] = [];
    render(<Console buffer={createBuffer()} columns={80} height={1} top={consoleTop(layout)} scrollTop={0} cursor={(p) => positions.push(p)} active={false} mode="review" rows={24} badge="jev+llm" dir="proj" status={status} statusOptions={{}} />);
    expect(positions.at(-1)).toBeUndefined();
  });
});
