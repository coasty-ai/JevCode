/**
 * AGENT-LOOP-DESIGN §A3 / §A5 (slice S5a): the mini indicators — braille frames at one row, in the status row's glyph
 * slot. Every frame is exactly its width in cells, braille only (the ASCII twin ASCII only), every shape moves, the four
 * shapes are told apart, and the still frame is one of the shape's own drawings.
 */
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { INDICATOR_KINDS, MINI_NARROW_CELLS, MINI_WIDE_CELLS, miniFrame, miniFrames } from '../../../../src/tui/anim/frames.js';

const BRAILLE = /^[⠀-⣿]+$/u;

/** The dot grid of a braille string (2 × 4 dots per cell), `#` lit — what the frames were chosen by looking at. */
function dots(s: string): string[] {
  const bits = [
    [0x01, 0x02, 0x04, 0x40],
    [0x08, 0x10, 0x20, 0x80],
  ];
  const rows = ['', '', '', ''];
  for (const ch of s) {
    const b = ch.codePointAt(0)! - 0x2800;
    for (let y = 0; y < 4; y++) rows[y] += `${b & bits[0]![y]! ? '#' : '.'}${b & bits[1]![y]! ? '#' : '.'}`;
  }
  return rows;
}

describe('mini indicator frames', () => {
  it('the wide form is 3 cells and the narrow form the old 1-cell slot, braille only, at every frame of every shape', () => {
    expect(MINI_WIDE_CELLS).toBe(3);
    expect(MINI_NARROW_CELLS).toBe(1);
    for (const kind of INDICATOR_KINDS) {
      for (const [cells, frames] of [
        [MINI_WIDE_CELLS, miniFrames(kind, MINI_WIDE_CELLS)],
        [MINI_NARROW_CELLS, miniFrames(kind, MINI_NARROW_CELLS)],
      ] as const) {
        expect(frames.length, kind).toBeGreaterThanOrEqual(4);
        for (const f of frames) {
          expect(f, `${kind}@${cells}`).toMatch(BRAILLE);
          expect(stringWidth(f), `${kind}@${cells} ${f}`).toBe(cells);
          expect([...f].length).toBe(cells);
        }
      }
    }
  });

  it('every shape moves: at least four distinct frames at both widths, and consecutive ticks differ somewhere in the cycle', () => {
    for (const kind of INDICATOR_KINDS) {
      for (const cells of [MINI_WIDE_CELLS, MINI_NARROW_CELLS]) {
        const frames = miniFrames(kind, cells);
        expect(new Set(frames).size, `${kind}@${cells}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('the four shapes are told apart: no wide frame of one shape is a frame of another', () => {
    const owner = new Map<string, string>();
    for (const kind of INDICATOR_KINDS) {
      for (const f of miniFrames(kind, MINI_WIDE_CELLS)) {
        const prev = owner.get(f);
        expect(prev === undefined || prev === kind, `${f} is both ${prev} and ${kind}`).toBe(true);
        owner.set(f, kind);
      }
    }
  });

  it('the donut is a ring with a hole — the wide still frame lights the 12-dot oval and leaves its 4×2 centre dark', () => {
    const still = miniFrame('donut', 0, MINI_WIDE_CELLS, { still: true });
    expect(dots(still)).toEqual(['.####.', '#....#', '#....#', '.####.']);
    // the moving frames are that ring with a two-dot dark arc: 10 of the 12 dots lit, never a centre dot
    for (const f of miniFrames('donut', MINI_WIDE_CELLS)) {
      const g = dots(f);
      expect(g.join('').split('#').length - 1, f).toBe(10);
      expect(g[1]!.slice(1, 5) + g[2]!.slice(1, 5), f).toBe('........');
    }
  });

  it('frames cycle on the tick (negative and huge ticks included), and the still frame ignores the tick', () => {
    const frames = miniFrames('wave', MINI_WIDE_CELLS);
    expect(miniFrame('wave', 0, MINI_WIDE_CELLS)).toBe(frames[0]);
    expect(miniFrame('wave', frames.length, MINI_WIDE_CELLS)).toBe(frames[0]);
    expect(miniFrame('wave', -1, MINI_WIDE_CELLS)).toBe(frames[frames.length - 1]);
    expect(miniFrame('wave', 1e9 + 3, MINI_WIDE_CELLS)).toBe(frames[(1e9 + 3) % frames.length]);
    expect(miniFrame('wave', Number.NaN, MINI_WIDE_CELLS)).toBe(frames[0]);
    for (const kind of INDICATOR_KINDS) {
      const a = miniFrame(kind, 3, MINI_WIDE_CELLS, { still: true });
      expect(miniFrame(kind, 7, MINI_WIDE_CELLS, { still: true })).toBe(a);
      expect(a).toMatch(BRAILLE);
    }
  });

  it('the ASCII twin (--ascii / NO_COLOR) is one printable ASCII cell per frame, still under reduced motion', () => {
    for (const kind of INDICATOR_KINDS) {
      const frames = miniFrames(kind, MINI_WIDE_CELLS, true);
      for (const f of frames) expect(f).toMatch(/^[\x21-\x7e]$/);
      expect(miniFrame(kind, 5, MINI_WIDE_CELLS, { ascii: true, still: true })).toBe(frames[0]);
      expect(miniFrame(kind, 1, MINI_NARROW_CELLS, { ascii: true })).toBe(frames[1]);
    }
  });
});
