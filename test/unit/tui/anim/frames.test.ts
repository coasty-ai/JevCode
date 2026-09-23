/** The 3D indicator frames: deterministic, correctly sized, visibly drawn, cheap enough to precompute per size. */
import { describe, expect, it } from 'vitest';
import { ANIM_FPS, LUMINANCE, animSize, cubeFrames, globeFrames, indicatorFrames, torusFrames, waveFrames } from '../../../../src/tui/anim/frames.js';

const KINDS = ['thinking', 'running', 'calling', 'verifying'] as const;

describe('indicator frames', () => {
  it('every renderer returns the requested frame count, each frame exactly height rows of width cells', () => {
    for (const kind of KINDS) {
      const frames = indicatorFrames(kind, 24, 12, 16);
      expect(frames, kind).toHaveLength(16);
      for (const f of frames) {
        expect(f, kind).toHaveLength(12);
        for (const row of f) expect(row.length, kind).toBe(24);
      }
    }
  });

  it('is deterministic: the same size gives byte-identical frames twice', () => {
    for (const kind of KINDS) expect(indicatorFrames(kind, 30, 10, 8)).toEqual(indicatorFrames(kind, 30, 10, 8));
  });

  it('draws something in every frame, and consecutive frames differ (it moves)', () => {
    for (const kind of KINDS) {
      const frames = indicatorFrames(kind, 24, 12, 12);
      for (const f of frames) expect(f.join('').replace(/ /g, '').length, kind).toBeGreaterThan(20);
      const distinct = new Set(frames.map((f) => f.join('\n')));
      expect(distinct.size, kind).toBeGreaterThan(6);
    }
  });

  it('the torus uses only the donut luminance ramp and lights a solid ring', () => {
    const frames = torusFrames(40, 20, 4);
    for (const f of frames) for (const row of f) for (const ch of row) expect(ch === ' ' || LUMINANCE.includes(ch)).toBe(true);
    expect(frames[0]!.join('').replace(/ /g, '').length).toBeGreaterThan(120);
  });

  it('clamps tiny sizes up to a drawable minimum instead of throwing', () => {
    for (const fn of [torusFrames, cubeFrames, globeFrames, waveFrames]) {
      const f = fn(1, 1, 1);
      expect(f.length).toBe(2);
      expect(f[0]![0]!.length).toBe(8);
      expect(f[0]!.length).toBe(4);
    }
  });

  it('every glyph of every renderer is ASCII from the donut ramp or a space (the TUI colours them; no ANSI in the strings)', () => {
    for (const kind of KINDS) for (const f of indicatorFrames(kind, 24, 12, 8)) for (const row of f) for (const ch of row) expect(ch === ' ' || LUMINANCE.includes(ch), `${kind}: ${JSON.stringify(ch)}`).toBe(true);
  });

  it('animSize: 24×12 on a roomy terminal, 16×8 at 80 columns, none below 60 columns or 16 rows; ANIM_FPS is 12', () => {
    expect(animSize(120, 40)).toEqual({ w: 24, h: 12 });
    expect(animSize(100, 24)).toEqual({ w: 24, h: 12 });
    expect(animSize(80, 24)).toEqual({ w: 16, h: 8 });
    expect(animSize(99, 30)).toEqual({ w: 16, h: 8 });
    expect(animSize(59, 40)).toBeNull();
    expect(animSize(120, 15)).toBeNull();
    expect(ANIM_FPS).toBe(12);
  });

  it('a 24×12 torus at 60 frames precomputes in tens of milliseconds (best of 3; the bound is loose for a loaded machine)', () => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); torusFrames(24, 12, 60); best = Math.min(best, performance.now() - t0); }
    expect(best).toBeLessThan(150);
  });
});
