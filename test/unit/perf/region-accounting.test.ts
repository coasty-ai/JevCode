/**
 * The dynamic region by Ink's own accounting (`log-update` erases exactly the previous write's line count), in both
 * parsers: `test/pty/helpers.ts` `units()` (drive.exp captures, the pty suite) and `src/perf/pty.ts` `eraseHeights` /
 * `splitRegion` / `framesTallerThan` / `paintedMax` / `classifyFrames` (typist captures, the perf probes). While no live
 * row sits above the rule the erase count and the rule parse agree (cross-checked on every capture); where a streaming
 * tail sits above the rule, or blank rows close the region, only the erase count sees the real region — and that is the
 * measure the region ≤ rows − 2 and taller-than-the-terminal gates now read.
 */
import { describe, expect, it } from 'vitest';
import { BSU, ESU, classifyFrames, eraseHeights, framesTallerThan, latin1View, paintedMax, paintedRows, regionRows, ruleRegionRows, splitFrames, splitRegion } from '../../../src/perf/pty.js';
import { frames as ptyFrames, regionCrossCheck, units } from '../../pty/helpers.js';

const RULE = '─'.repeat(20);

/** one Ink write as the pty shows it: hide, erase `prev + 1` rows (none for the first), the rows, the cursor suffix */
function write(rows: readonly string[], prev: number, opts: { sync?: boolean; newline?: boolean } = {}): string {
  const erase = prev === 0 ? '' : '\x1b[1B\x1b[1G' + Array.from({ length: prev + 1 }, (_, i) => (i === 0 ? '\x1b[2K' : '\x1b[1A\x1b[2K')).join('') + '\x1b[G';
  const body = `\x1b[?25l${erase}${rows.join('\r\n')}${opts.newline === false ? '' : '\r\n'}\x1b[2A\x1b[3G\x1b[?25h`;
  return opts.sync === false ? body : `${BSU}${body}${ESU}`;
}

describe('units() (pty helpers): rows by the next write’s erase count, cross-checked with the rule parse', () => {
  it('agrees with the rule parse on ordinary frames; a static commit keeps its rows above the region', () => {
    const cap = write([RULE, '› a', 'idle'], 0) + write(['[you] hi', RULE, '› ', 'idle'], 3) + write([RULE, '› b', 'idle'], 3) + write([RULE, '› bc', 'idle'], 3);
    // (the first unit is the BSU before the first hide: no rows)
    const all = units(cap).filter((u) => u.ruleIndex >= 0);
    expect(all.map((u) => u.rows)).toEqual([3, 3, 3, 3]);
    expect(all.map((u) => u.eraseRows)).toEqual([3, 3, 3, null]);
    expect(all[1]!.staticRows).toEqual(['[you] hi']);
    expect(regionCrossCheck(all)).toEqual({ compared: 3, mismatches: [] });
  });

  it('blank rows closing the region count (the rule parse drops them); a live tail above the rule is dynamic, not scrollback', () => {
    // frame 0: a region ending in two blank rows (5 rows by Ink's count); frame 1: a streaming tail of two rows above the rule
    const cap = write([RULE, '› ', 'idle', '', ''], 0) + write(['tail row one', 'tail row two', RULE, '› ', 'idle'], 5) + write([RULE, '› ', 'idle'], 5);
    const all = units(cap).filter((u) => u.ruleIndex >= 0);
    expect(all[0]).toMatchObject({ eraseRows: 5, ruleRows: 5, rows: 5 });
    // the tail: the rule parse sees 3 rows and calls the tail "static"; Ink erased all 5
    expect(all[1]).toMatchObject({ eraseRows: 5, ruleRows: 3, rows: 5, staticRows: [] });
    expect(regionCrossCheck(all).mismatches).toEqual([{ index: all[1]!.index, eraseRows: 5, ruleRows: 3 }]);
    expect(ptyFrames(cap).map((u) => u.rows)).toEqual([5, 5, 3]);
  });

  it('a cursor-only write is skipped; a clear-terminal unit or the last unit leaves the region to the rule parse', () => {
    const cursorOnly = `${BSU}\x1b[?25l\x1b[2A\x1b[3G\x1b[?25h${ESU}`;
    const clear = `\x1b[2J\x1b[H[you] hi\r\n${RULE}\r\n› \r\nidle\r\n`;
    const cap = write([RULE, '› a', 'idle'], 0) + cursorOnly + write([RULE, '› ab', 'idle'], 3) + clear + write([RULE, '› x', 'idle'], 3);
    const all = units(cap).filter((u) => u.ruleIndex >= 0);
    expect(all.map((u) => u.eraseRows)).toEqual([3, null, 3, null]);
    expect(all.map((u) => u.rows)).toEqual([3, 3, 3, 3]);
  });
});

describe('src/perf/pty.ts: eraseHeights / splitRegion and the gates on them', () => {
  it('eraseHeights reads the next erasing frame; a viewport-filling frame (no trailing newline) is erased without the +1', () => {
    const cap = latin1View(write([RULE, '› a', 'idle'], 0) + write([RULE, '› a', 'idle', '', ''], 3) + write([RULE, 'full', 'x', 'y'], 5, { newline: false }) + write([RULE, 'z'], 3));
    const { frames } = splitFrames(cap);
    // the third frame fills the viewport: Ink wrote no trailing newline, so it erased exactly 4 rows (the stub writes prev + 1 = 4)
    expect(eraseHeights(frames)).toEqual([3, 5, 4, null]);
    expect(frames.map((_, i) => regionRows(frames, i, eraseHeights(frames)))).toEqual([3, 5, 4, 2]);
    expect(paintedRows(frames[1]!.body)).toBe(3);
    expect(ruleRegionRows(frames[1]!.body)).toBe(5);
  });

  it('a streaming tail above the rule: the region gates count it and the frame is dynamic, not static', () => {
    const tail = ['tail 1', 'tail 2', 'tail 3', 'tail 4', 'tail 5'];
    const cap = latin1View(write([RULE, '› ', 'idle'], 0) + write([...tail, RULE, '› ', 'idle'], 3) + write([RULE, '› ', 'idle'], 8));
    const { frames } = splitFrames(cap);
    const h = eraseHeights(frames);
    // a typist capture is latin1: the rows come back byte-wise
    expect(splitRegion(frames, 1, h)).toEqual({ staticRows: [], dynamicRows: [...tail, RULE, '› ', 'idle'].map(latin1View) });
    expect(paintedMax(frames)).toBe(8);
    expect(framesTallerThan(frames, 6)).toEqual([{ index: 1, painted: 8 }]);
    const chunks = frames.map((f, i) => ({ t: i * 100, off: f.start, n: f.end - f.start }));
    expect(classifyFrames(frames, chunks, [], 34)).toEqual(['dynamic', 'dynamic', 'dynamic']);
    // …while a real commit (rows written above a region that did not grow) is static
    const commit = latin1View(write([RULE, '› ', 'idle'], 0) + write(['[jevcode] done', RULE, '› ', 'idle'], 3) + write([RULE, '› ', 'idle'], 3));
    const cf = splitFrames(commit).frames;
    expect(classifyFrames(cf, cf.map((f, i) => ({ t: i * 100, off: f.start, n: f.end - f.start })), [], 34)).toEqual(['dynamic', 'static', 'dynamic']);
  });

  it('--ascii frames: the static class is found by the region, where the rule-only parse (`staticRows`) sees no `─` rule at all', () => {
    const cap = latin1View(write(['-'.repeat(20), '> ', 'idle'], 0) + write(['[you] hi', '-'.repeat(20), '> ', 'idle'], 3) + write(['-'.repeat(20), '> ', 'idle'], 3));
    const { frames } = splitFrames(cap);
    expect(classifyFrames(frames, frames.map((f, i) => ({ t: i * 100, off: f.start, n: f.end - f.start })), [], 34)).toEqual(['dynamic', 'static', 'dynamic']);
  });
});
