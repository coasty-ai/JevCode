/**
 * `src/perf/states.ts` `judgeSegment`: a shrink segment judged frame by frame against the geometry each frame was
 * painted in — an in-flight frame (written after the resize offset, before the TUI's first reaction, laid out for the
 * old geometry) is reported, a stale repaint at or after the reaction is a budget failure, the clear frame's painted
 * rows are recorded, and the clear count is per segment.
 */
import { describe, expect, it } from 'vitest';
import { BSU, ESU, splitFrames, type Chunk } from '../../../src/perf/pty.js';
import { judgeSegment } from '../../../src/perf/states.js';

const RULE = '─'.repeat(30);
function frame(rows: readonly string[], prevRows: number): string {
  const erase = prevRows === 0 ? '' : '\x1b[2B\x1b[1G' + Array.from({ length: prevRows + 1 }, (_, i) => (i === 0 ? '\x1b[2K' : '\x1b[1A\x1b[2K')).join('') + '\x1b[G';
  return `${BSU}\x1b[?25l${erase}${rows.join('\r\n')}\r\n\x1b[2A\x1b[3G\x1b[?25h${ESU}`;
}
function clearFrame(rows: readonly string[]): string {
  return `${BSU}\x1b[2J\x1b[3J\x1b[H[run] header\r\n[step 1] a\r\n${rows.join('\r\n')}\r\n\x1b[2A\x1b[3G\x1b[?25h${ESU}`;
}
const region = (n: number, draft: string): string[] => [RULE, ...Array.from({ length: n - 3 }, (_, i) => `pane ${i}`), `> ${draft}`, 'status'];

describe('judgeSegment (shrink 40 → 12 rows, budget 38 → 10)', () => {
  it('reports the in-flight frame, records the clear frame, and passes when every later frame fits the new budget', () => {
    const a = frame(region(16, 'draft A'), 16); // marker A
    const inFlight = frame(region(16, 'draft A'), 16); // already rendered when SIGWINCH landed
    const clear = clearFrame(region(10, 'draft A')); // Ink's one clear, already the new layout
    const b = frame(region(10, 'draft AB'), 10); // marker B
    const cap = a + inFlight + clear + b;
    const { frames } = splitFrames(cap);
    const resize = { off: a.length, t: 1000 };
    const chunks: Chunk[] = [
      { t: 990, off: 0, n: a.length },
      { t: 1002.1, off: a.length, n: inFlight.length },
      { t: 1005.8, off: a.length + inFlight.length, n: clear.length },
      { t: 1900, off: a.length + inFlight.length + clear.length, n: b.length },
    ];
    const g = judgeSegment('→B (40→12 rows)', 40, 12, 1, frames, cap, 0, 3, resize, chunks);
    expect(g).toMatchObject({ clears: 1, clearMatches: 2, allowed: 1, regionMax: 16, resizeAt: a.length, clearFramePainted: 10, inFlightPaints: 1, stalePaints: 0, budgetOk: true, frames: 3 });
    expect(g.inFlightMs).toBeCloseTo(2.1, 5);
  });
  it('counts a taller frame at or after the TUI reacted as a stale paint and fails the budget', () => {
    const a = frame(region(16, 'draft A'), 16);
    const clear = clearFrame(region(10, 'draft A'));
    const stale = frame(region(16, 'draft A'), 10); // the old tree painted after the reaction
    const b = frame(region(10, 'draft AB'), 16);
    const cap = a + clear + stale + b;
    const { frames } = splitFrames(cap);
    const g = judgeSegment('→B (40→12 rows)', 40, 12, 1, frames, cap, 0, 3, { off: a.length, t: 0 });
    expect(g).toMatchObject({ clears: 1, inFlightPaints: 0, stalePaints: 1, budgetOk: false, clearFramePainted: 10 });
  });
  it('a frame taller than both budgets is never in flight; without a resize offset the larger budget applies', () => {
    const a = frame(region(16, 'draft A'), 16);
    const huge = frame(region(40, 'draft A'), 16);
    const b = frame(region(10, 'draft AB'), 40);
    const cap = a + huge + b;
    const { frames } = splitFrames(cap);
    expect(judgeSegment('x', 40, 12, 1, frames, cap, 0, 2, { off: a.length, t: 0 })).toMatchObject({ inFlightPaints: 0, stalePaints: 1, budgetOk: false });
    expect(judgeSegment('x', 40, 12, 1, frames, cap, 0, 2, null)).toMatchObject({ inFlightPaints: 0, stalePaints: 0, budgetOk: false, resizeAt: null });
    expect(judgeSegment('x', 40, 40, 0, frames.slice(0, 1), a, 0, 1, null)).toMatchObject({ clears: 0, regionMax: 0, budgetOk: true });
  });
});
