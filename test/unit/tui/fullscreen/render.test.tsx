/**
 * TUI-DESIGN-4 §10 S1 *render*: **the test that would have caught the 37-clears cliff.**
 *
 * §1.3.2 edge 5 makes "the **rendered** height equals the allocated height" the load-bearing invariant of the whole
 * fullscreen renderer: a single wrapped row makes the tree one row too tall, and audit A1 §3.2 measured a full
 * `clearTerminal` on **every** frame in that state (37 clears for 36 frames). `computeFullLayout`'s arithmetic is
 * pinned exhaustively in `layout.test.ts`; this file pins the other half — that the React tree Ink actually lays out
 * is exactly `layout.viewport` lines for `<Viewport>` and exactly `rows` lines for the composed frame.
 */
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import { OVERLAY_KINDS } from '../../../../src/tui/layout.js';
import type { TranscriptItem } from '../../../../src/tui/plain.js';
import { computeFullLayout, type FullLayoutInput } from '../../../../src/tui/fullscreen/layout.js';
import { Viewport } from '../../../../src/tui/fullscreen/ViewportBox.js';
import { SCROLL_BOTTOM, buildIndex, emptyIndex, type Scroll } from '../../../../src/tui/fullscreen/viewport.js';

const frames: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.unmount();
});

let seq = 0;
const item = (text: string): TranscriptItem => ({ key: `r${seq++}`, step: 1, kind: 'note', text, label: '[ui]' }) as unknown as TranscriptItem;
const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
/**
 * Ink writes `output + '\n'` and `ink-testing-library` keeps the frame without it, and a row whose content is only
 * spaces comes back trimmed — so H blank rows are `H − 1` newlines and a 0-row box and a 1-blank-row box are both
 * the empty string. The height assertion is therefore `split('\n').length` for `h ≥ 1` and `frame === ''` for `h = 0`.
 */
const lineCount = (s: string | undefined, h: number): number => {
  const t = strip(s);
  if (h === 0) return t === '' ? 0 : t.split('\n').length;
  return t.split('\n').length;
};

const base = (over: Partial<FullLayoutInput> = {}): FullLayoutInput => ({ rows: 24, columns: 80, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, gate: 0, ...over });

function mount(el: React.JSX.Element): { frame: () => string } {
  const r = render(el);
  frames.push({ unmount: () => r.unmount() });
  return { frame: () => strip(r.lastFrame()) };
}

describe('<Viewport> renders EXACTLY its allocated height (§1.3.2 edge 5)', () => {
  const BIG = Array.from({ length: 400 }, (_x, i) => item(`transcript row ${i} with enough text to wrap at narrow widths for sure`));

  it('the allocator matrix: `lastFrame().split("\\n").length === layout.viewport` for every tier', () => {
    const indexes = new Map([40, 80, 200].map((c) => [c, buildIndex(BIG, c)]));
    for (const rows of [18, 19, 23, 24, 30, 60]) {
      for (const columns of [40, 80, 200]) {
        for (const overlay of OVERLAY_KINDS) {
          for (const composerWant of [1, 8]) {
            const layout = computeFullLayout(base({ rows, columns, overlay, overlayWant: overlay === 'none' ? 0 : 4, composerWant }));
            const index = indexes.get(columns)!;
            const ui = mount(<Viewport index={index} height={layout.viewport} scroll={SCROLL_BOTTOM} />);
            expect(lineCount(ui.frame(), layout.viewport), `${rows}x${columns} ${overlay} c${composerWant}`).toBe(layout.viewport);
            for (const line of strip(ui.frame()).split('\n')) expect([...line].length, `${rows}x${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
            frames.pop()?.unmount();
          }
        }
      }
    }
  }, 120_000);

  it('0 / 1 / 20 000 items all render exactly `height` rows, and a 10 000-character single line never wraps the box', () => {
    const cases: Array<readonly TranscriptItem[]> = [[], [item('only one')], Array.from({ length: 20_000 }, (_x, i) => item(`row ${i}`)), [item('x'.repeat(10_000))]];
    for (const [n, items] of cases.entries()) {
      for (const columns of [40, 200]) {
        const index = items.length === 0 ? emptyIndex(columns) : buildIndex(items, columns);
        for (const height of [0, 1, 13, 49]) {
          const ui = mount(<Viewport index={index} height={height} scroll={SCROLL_BOTTOM} />);
          expect(lineCount(ui.frame(), height), `case ${n}, ${columns} cols, h${height}`).toBe(height);
          for (const line of strip(ui.frame()).split('\n')) expect([...line].length).toBeLessThanOrEqual(columns);
          frames.pop()?.unmount();
        }
      }
    }
  }, 60_000);

  it('a scrolled view keeps the height and draws the `▲ n earlier rows · PgUp` marker as its FIRST row, never an extra one', () => {
    const index = buildIndex(BIG, 80);
    const scroll: Scroll = { anchor: 'row', top: 40 };
    const ui = mount(<Viewport index={index} height={13} scroll={scroll} showAbove />);
    expect(lineCount(ui.frame(), 13)).toBe(13);
    expect(strip(ui.frame()).split('\n')[0]).toContain('earlier rows');
    expect(strip(ui.frame()).split('\n')[0]).toContain('PgUp');
  });

  it('the `--ascii` index draws the marker with `^` and no non-ASCII byte in it', () => {
    const index = buildIndex(BIG, 80, GLYPHS.ascii);
    const ui = mount(<Viewport index={index} height={5} scroll={{ anchor: 'row', top: 9 }} showAbove />);
    const first = strip(ui.frame()).split('\n')[0] ?? '';
    expect(first.trimEnd()).toMatch(/^\^ \d+ earlier rows - PgUp$/);
  });
});

describe('the composed fullscreen frame is EXACTLY `rows` lines', () => {
  const Slot = ({ h, fill }: { h: number; fill: string }): React.JSX.Element | null =>
    h <= 0 ? null : (
      <Box flexDirection="column" height={h} overflow="hidden">
        {Array.from({ length: h }, (_x, i) => (
          <Text key={`s${i}`} wrap="truncate">
            {fill}
          </Text>
        ))}
      </Box>
    );

  it('header + rule + overlay + preview + viewport + console === rows, over the allocator matrix', () => {
    const items = Array.from({ length: 600 }, (_x, i) => item(`row ${i} of a transcript that is comfortably long enough to wrap`));
    for (const rows of [18, 20, 23, 24, 30, 40]) {
      for (const columns of [40, 64, 80, 120]) {
        for (const overlay of ['none', 'review', 'palette', 'wizard'] as const) {
          const layout = computeFullLayout(base({ rows, columns, overlay, overlayWant: overlay === 'none' ? 0 : 4, previewWant: overlay === 'review' ? 6 : 0, composerWant: 3 }));
          expect(layout.total, `${rows}x${columns} ${overlay}`).toBe(rows);
          const index = buildIndex(items, columns);
          const ui = mount(
            <Box flexDirection="column">
              <Slot h={layout.header} fill={'H'.repeat(columns)} />
              <Slot h={layout.rule} fill={'─'.repeat(columns)} />
              <Viewport index={index} height={layout.viewport} scroll={SCROLL_BOTTOM} />
              <Slot h={layout.overlay} fill={'O'.repeat(columns)} />
              <Slot h={layout.preview} fill={'P'.repeat(columns)} />
              <Slot h={layout.console} fill={'C'.repeat(columns)} />
            </Box>,
          );
          expect(lineCount(ui.frame(), rows), `${rows}x${columns} ${overlay}`).toBe(rows);
          frames.pop()?.unmount();
        }
      }
    }
  }, 60_000);
});
