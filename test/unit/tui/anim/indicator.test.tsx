/**
 * The mounted 3D indicator: the block is exactly the frame set's rows and cells, `tick` moves it, reduced motion pins
 * frame 0, `NO_COLOR` writes plain text, the kind follows the session state, the 12 fps tick runs only while the block
 * is up, and the frame sets are built once per (kind, size) and cheap enough to build on the first frame.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animSize } from '../../../../src/tui/anim/frames.js';
import {
  INDICATOR_LABEL,
  INDICATOR_TICK_MS,
  Indicator,
  clearFrameCache,
  frameCacheSize,
  frameSet,
  indicatorKindFor,
  useIndicatorTick,
} from '../../../../src/tui/anim/Indicator.js';
import { themeFor } from '../../../../src/tui/theme.js';
import { stripSgr } from '../stub-stdout.js';

const theme = themeFor('dark');
const base = { theme, reducedMotion: false, ascii: false, noColor: false } as const;

interface Leaf {
  readonly props: Record<string, unknown>;
  readonly text: string;
}

/** Every `<Text>` leaf of a rendered block, with the props it carries (colour is asserted on the tree: ink-testing-library's stdout has no colour). */
function leaves(node: ReactNode, out: Leaf[] = []): Leaf[] {
  if (Array.isArray(node)) {
    for (const n of node as ReactNode[]) leaves(n, out);
    return out;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const child = props['children'];
    if (typeof child === 'string') out.push({ props, text: child });
    else leaves(child as ReactNode, out);
    return out;
  }
  return out;
}

function lines(frame: string | undefined): string[] {
  return (frame ?? '').split('\n');
}

afterEach(() => {
  cleanup();
});

describe('Indicator: the block', () => {
  it('renders animSize rows of exactly w cells (24×12 roomy, 16×8 at 80 columns)', () => {
    for (const [columns, rows] of [[120, 40], [80, 24]] as const) {
      const size = animSize(columns, rows)!;
      const { lastFrame } = render(<Indicator {...base} kind="thinking" columns={columns} rows={rows} tick={0} />);
      const out = lines(lastFrame()).map((l) => stripSgr(l));
      expect(out, `${columns}x${rows}`).toHaveLength(size.h);
      const frame = frameSet('thinking', size.w, size.h)[0]!;
      // Ink drops the trailing blanks of a row; padded back, every row is the frame's row, exactly w cells
      for (const [i, l] of out.entries()) {
        expect(l.length, `${columns}x${rows} row ${i}`).toBeLessThanOrEqual(size.w);
        expect(l.padEnd(size.w), `${columns}x${rows} row ${i}`).toBe(frame[i]!);
      }
      cleanup();
    }
  });

  it('renders nothing below 60 columns or 16 rows', () => {
    for (const [columns, rows] of [[50, 40], [120, 15], [40, 10]] as const) {
      const { lastFrame } = render(<Indicator {...base} kind="running" columns={columns} rows={rows} tick={3} />);
      expect(stripSgr(lastFrame() ?? ''), `${columns}x${rows}`).toBe('');
      cleanup();
    }
  });

  it('tick selects frames[tick % n]; the same tick renders the same block', () => {
    const at = (tick: number): string => {
      const { lastFrame } = render(<Indicator {...base} kind="thinking" columns={120} rows={40} tick={tick} noColor />);
      const out = lastFrame() ?? '';
      cleanup();
      return out;
    };
    const n = frameSet('thinking', 24, 12).length;
    expect(at(0)).toBe(at(0));
    expect(at(7)).not.toBe(at(0));
    expect(at(n)).toBe(at(0));
    expect(at(n + 7)).toBe(at(7));
  });

  it('reducedMotion pins frame 0 whatever the tick says', () => {
    const at = (tick: number, reducedMotion: boolean): string => {
      const { lastFrame } = render(<Indicator {...base} reducedMotion={reducedMotion} kind="calling" columns={120} rows={40} tick={tick} noColor />);
      const out = lastFrame() ?? '';
      cleanup();
      return out;
    };
    expect(at(9, true)).toBe(at(0, true));
    expect(at(9, true)).toBe(at(0, false));
    expect(at(9, false)).not.toBe(at(0, false));
  });

  it('noColor emits plain text: no ANSI, no props, the frame byte for byte', () => {
    const { lastFrame } = render(<Indicator {...base} kind="verifying" columns={120} rows={40} tick={4} noColor />);
    const out = lastFrame() ?? '';
    expect(out).not.toMatch(/\u001B\[/);
    cleanup();
    const el = Indicator({ ...base, kind: 'verifying', columns: 120, rows: 40, tick: 4, noColor: true })!;
    for (const leaf of leaves(el)) expect(Object.keys(leaf.props).filter((k) => k !== 'children' && k !== 'wrap')).toEqual([]);
  });

  it('colour shades the luminance ramp into three bands: dim tail, accent2 body, bold accent highlights', () => {
    const el = Indicator({ ...base, kind: 'thinking', columns: 120, rows: 40, tick: 5, color: 24 })!;
    const seen = new Set<string>();
    for (const leaf of leaves(el)) {
      const chars = [...leaf.text].filter((c) => c !== ' ');
      if (chars.length === 0) continue;
      const colour = leaf.props['color'];
      const dim = leaf.props['dimColor'] === true;
      const bold = leaf.props['bold'] === true;
      const band = dim ? 'dim' : colour === '#f386a1' ? 'accent' : colour === '#d45bb6' ? 'accent2' : `?${String(colour)}`;
      seen.add(band);
      const ramp = band === 'dim' ? '.,-~' : band === 'accent2' ? ':;=!' : '*#$@';
      for (const c of chars) expect(ramp.includes(c), `${band}: ${c}`).toBe(true);
      expect(bold, band).toBe(band === 'accent');
    }
    expect([...seen].sort()).toEqual(['accent', 'accent2', 'dim']);
  });

  it('a label for every kind', () => {
    expect(INDICATOR_LABEL).toEqual({ thinking: 'thinking', running: 'running', calling: 'calling Jev', verifying: 'verifying' });
  });
});

describe('indicatorKindFor', () => {
  const s = { thinking: null, run: 'none', stage: null, streaming: false } as const;
  it('a submission in flight thinks, whatever else is happening', () => {
    for (const phase of ['intake', 'lookup', 'replying'] as const) {
      expect(indicatorKindFor({ ...s, thinking: phase })).toBe('thinking');
      expect(indicatorKindFor({ ...s, thinking: phase, run: 'live', stage: 'execute' })).toBe('thinking');
    }
  });

  it('a live run: execute runs, judge verifies, every model / Jev stage calls', () => {
    for (const run of ['live', 'aborting', 'pausing'] as const) {
      expect(indicatorKindFor({ ...s, run, stage: 'execute' })).toBe('running');
      expect(indicatorKindFor({ ...s, run, stage: 'judge' })).toBe('verifying');
      for (const stage of ['propose', 'intent', 'risk', 'replan', 'context', 'decompose', 'coordinate'] as const) {
        expect(indicatorKindFor({ ...s, run, stage })).toBe('calling');
      }
      // between stages a live run still shows something
      for (const stage of ['complete', 'idle', null] as const) expect(indicatorKindFor({ ...s, run, stage })).toBe('thinking');
    }
  });

  it('starting thinks, a streamed reply thinks, an idle session shows nothing', () => {
    expect(indicatorKindFor({ ...s, run: 'starting' })).toBe('thinking');
    expect(indicatorKindFor({ ...s, streaming: true })).toBe('thinking');
    expect(indicatorKindFor(s)).toBeNull();
    expect(indicatorKindFor({ ...s, run: 'none', stage: 'execute' })).toBeNull();
  });
});

describe('useIndicatorTick', () => {
  function Ticker({ active, reduced }: { active: boolean; reduced: boolean }): ReactElement {
    return <Text>{`t=${useIndicatorTick(active, reduced)}`}</Text>;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks at 12 fps while active and stops when it goes inactive', async () => {
    vi.useFakeTimers();
    const { lastFrame, rerender } = render(<Ticker active reduced={false} />);
    expect(lastFrame()).toBe('t=0');
    await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 4 + 5);
    expect(lastFrame()).toBe('t=4');
    rerender(<Ticker active={false} reduced={false} />);
    expect(lastFrame()).toBe('t=0');
    const idle = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 10);
    expect(lastFrame()).toBe('t=0');
    expect(vi.getTimerCount()).toBeLessThanOrEqual(idle);
  });

  it('runs no timer while inactive or under reduced motion', async () => {
    vi.useFakeTimers();
    for (const props of [{ active: false, reduced: false }, { active: true, reduced: true }]) {
      const before = vi.getTimerCount();
      const { lastFrame } = render(<Ticker active={props.active} reduced={props.reduced} />);
      await vi.advanceTimersByTimeAsync(INDICATOR_TICK_MS * 6);
      expect(lastFrame()).toBe('t=0');
      expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
      cleanup();
    }
  });
});

describe('the frame cache', () => {
  it('builds one frame set per (kind, w, h) and hands back the same arrays', () => {
    clearFrameCache();
    expect(frameCacheSize()).toBe(0);
    const a = frameSet('running', 24, 12);
    const b = frameSet('running', 24, 12);
    expect(b).toBe(a);
    expect(frameCacheSize()).toBe(1);
    frameSet('running', 16, 8);
    frameSet('calling', 24, 12);
    expect(frameCacheSize()).toBe(3);
    clearFrameCache();
    expect(frameCacheSize()).toBe(0);
    expect(frameSet('running', 24, 12)).not.toBe(a);
  });

  it('a cold 24×12 torus is a first-frame cost, not a startup cost', () => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      clearFrameCache();
      const t0 = performance.now();
      frameSet('thinking', 24, 12);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(100);
  });
});
