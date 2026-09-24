/**
 * TUI-DESIGN-4 §11: the new gate rows that live in `src/perf/pty.ts` — the `NO_3J` assertion, the
 * "no frame taller than the terminal" predicate, and the glyph-agnostic named anchors with their two-glyph-set
 * self-test and their **zero-match hard failure** (A3 risk R2: a stale anchor silently turns the render-lag
 * window into the whole capture and the gate into a lie).
 */
import { describe, expect, it } from 'vitest';
import {
  BSU,
  END_PATTERN,
  ESU,
  NAMED_ANCHORS,
  RUN_STARTED_PATTERN,
  anchorSelfTest,
  clearReSelfTest,
  count3J,
  framesTallerThan,
  latin1View,
  locateAnchor,
  namedAnchor,
  no3JSelfTest,
  paintedRows,
  searchPattern,
  splitFrames,
} from '../../../src/perf/pty.js';

/** A frame of `rows` dynamic rows: a rule row then `rows - 1` body rows, inside the synchronized bracket. */
function frame(dynamicRows: number, scrollback: readonly string[] = []): string {
  const body = ['─'.repeat(40), ...Array.from({ length: Math.max(0, dynamicRows - 1) }, (_, i) => `body ${i}`)];
  return `${BSU}${[...scrollback, ...body].join('\r\n')}${ESU}`;
}

describe('the NO_3J gate (§11, §1.4)', () => {
  it('the regex matches only ESC[3J, and the self-test refuses the near misses', () => {
    expect(no3JSelfTest()).toBe(true);
    expect(count3J('\x1b[2J\x1b[H')).toBe(0);
    expect(count3J('\x1b[2J\x1b[3J\x1b[H')).toBe(1);
    expect(count3J('\x1b[3J\x1b[3J')).toBe(2);
    // ESC[2K (erase line) and ESC[3K (erase saved line) are ordinary output
    expect(count3J('\x1b[2K\x1b[3K')).toBe(0);
    // the existing clear self-test still holds: NO_3J is an added assertion, not a replacement
    expect(clearReSelfTest()).toBe(true);
  });
});

describe('the height gate (§11: no frame taller than the terminal)', () => {
  it('reports the frames whose painted dynamic region exceeds rows, and skips the settling frame after a resize', () => {
    const capture = [frame(8), frame(14), frame(9), frame(6)].join('');
    const { frames } = splitFrames(capture);
    expect(frames).toHaveLength(4);
    expect(paintedRows(frames[1]!.body)).toBe(14);
    expect(framesTallerThan(frames, 12).map((f) => f.index)).toEqual([1]);
    // §2.0 consequence (d): exactly one settling frame at the old geometry after a driver `resize` is expected
    expect(framesTallerThan(frames, 12, { skip: [1] })).toEqual([]);
    // nothing is taller than a generous terminal
    expect(framesTallerThan(frames, 40)).toEqual([]);
    // a frame with no rule row (a cursor-only repaint) is not measurable and is never reported
    const cursorOnly = splitFrames(`${BSU}\x1b[?25h${ESU}`).frames;
    expect(framesTallerThan(cursorOnly, 1)).toEqual([]);
  });
});

describe('glyph-agnostic named anchors (§11, D-V)', () => {
  it('every registered anchor matches both glyph sets and none of its negatives', () => {
    const r = anchorSelfTest();
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(NAMED_ANCHORS.map((a) => a.name)).toEqual(['run-started', 'run-end']);
    // the two constants D-V moves in §3.7 G1 are the ones registered
    expect(namedAnchor('run-started').pattern).toBe(RUN_STARTED_PATTERN);
    expect(namedAnchor('run-end').pattern).toBe(END_PATTERN);
  });

  it('an unknown anchor name throws and names the registry (a typo is never a silent skip)', () => {
    expect(() => namedAnchor('run-ended')).toThrow(/unknown perf anchor "run-ended".*run-started, run-end/);
  });

  it('zero matches is a hard failure, not -1 (A3 risk R2)', () => {
    const capture = '\u2502 \u2591 intent    step 0/40 0m00s \u2502\r\n[run] finished \u00b7 complete \u00b7 3 steps \u00b7 1.2s\r\n';
    expect(locateAnchor(capture, 'run-started')).toBe(capture.indexOf('step 0/40'));
    expect(locateAnchor(capture, 'run-end')).toBeGreaterThan(0);
    expect(() => locateAnchor('nothing here', 'run-end')).toThrow(/matched 0 time\(s\).*the measured window would be wrong/);
    expect(() => locateAnchor(capture, 'run-end', 2)).toThrow(/matched 1 time\(s\) in the capture; occurrence 2 is required/);
  });

  it('the `--ascii` capture measures the same window as the unicode one', () => {
    const unicode = '\u2502 \u2591 intent    step 0/40 0m00s \u2502\r\n\x1b[2m[run]\x1b[22m finished \u00b7 complete \u00b7 3 steps\r\n';
    const ascii = '| . intent    step 0/40 0m00s |\r\n[run] finished - complete - 3 steps\r\n';
    for (const name of ['run-started', 'run-end']) {
      expect(() => locateAnchor(unicode, name), `${name} unicode`).not.toThrow();
      expect(() => locateAnchor(ascii, name), `${name} ascii`).not.toThrow();
    }
  });

  /**
   * The chat rebuild (merge 946faa8) stopped printing the `[run] started · …` item in the TUI, and the perf anchor
   * still waited for it: every live-run scenario timed out at exit 124 while its self-test passed on hand-written
   * samples. The anchor is now the status row, whose idle form (`step 0/–`, `step 0/-` under --ascii) must never match
   * — the run is live only once the maximum is known — and the old item row is a registered negative.
   */
  it('the run-started anchor is the status row `step <n>/<max>`, never the idle `step 0/–` or the old `[run] started` item', () => {
    expect(RUN_STARTED_PATTERN).toBe('step \\d+/\\d+');
    const a = namedAnchor('run-started');
    expect(a.negatives?.some((n) => n.includes('step 0/\u2013'))).toBe(true);
    expect(a.negatives?.some((n) => n.includes('step 0/-'))).toBe(true);
    expect(a.negatives?.some((n) => n.includes('started \u00b7 jev+llm'))).toBe(true);
    // one sample per glyph set and tier, cut from real frames: boxed unicode, boxed --ascii, flat
    expect(a.samples.some((x) => x.startsWith('\x1b[38;5;169m\u2502 '))).toBe(true);
    expect(a.samples.some((x) => x.startsWith('\x1b[38;5;169m| '))).toBe(true);
    expect(() => locateAnchor('\u2502 idle  step 0/\u2013  ? help \u2502\r\n| idle  step 0/-  ? help |', 'run-started')).toThrow(/matched 0 time/);
  });

  it('a typist capture is latin1: `latin1: true` compiles the pattern byte-wise, the way the Python typist does', () => {
    const utf8 = '\u2502 \u2591 intent    step 0/40 \u2502\r\n\x1b[2m[run]\x1b[22m \x1b[2mfinished \u00b7 complete \u00b7 3 steps \u00b7 1.0s\x1b[22m\r\n';
    const latin1 = latin1View(utf8);
    // the unicode `·` alternative is two bytes in a latin1 view: searched as written it never matches a unicode frame
    expect(searchPattern(latin1, END_PATTERN)).toBe(-1);
    expect(searchPattern(latin1, END_PATTERN, { latin1: true })).toBe(latin1.indexOf('finished'));
    expect(() => locateAnchor(latin1, 'run-end', 1, { latin1: true })).not.toThrow();
    expect(locateAnchor(latin1, 'run-started', 1, { latin1: true })).toBe(latin1.indexOf('step 0/40'));
    // the ascii run-started pattern reads the same either way
    expect(searchPattern(latin1, RUN_STARTED_PATTERN)).toBe(searchPattern(latin1, RUN_STARTED_PATTERN, { latin1: true }));
  });

  /**
   * Review finding 20: the anchor must match an **errored** run too. `locateAnchor` throws on zero matches, so
   * the first perf scenario that ends in `error` would turn a measurement into a crash. §3.6 review item 5 put
   * the error clause LAST, after `exit <n>`, precisely so `finished · <reason> · <n> steps` still matches —
   * the registry now carries the sample that keeps that true, in both glyph sets.
   */
  it('the run-end anchor matches an errored run, in both glyph sets', () => {
    const errored = '\x1b[2m[run]\x1b[22m finished \u00b7 error \u00b7 3 steps \u00b7 1.0s \u00b7 $0.00 (generator $0.00 \u00b7 jev $0.00) \u00b7 exit 5 \u00b7 jev_http: 500 from the decider\r\n';
    const erroredAscii = '[run] finished - error - 3 steps - 1.0s - $0.00 (generator $0.00 - jev $0.00) - exit 5 - jev_http: 500 from the decider\r\n';
    expect(() => locateAnchor(errored, 'run-end')).not.toThrow();
    expect(() => locateAnchor(erroredAscii, 'run-end')).not.toThrow();
    // …and the registry gates it, so a future rewrite of the clause cannot silently break the window again
    expect(namedAnchor('run-end').samples.some((x) => x.includes('error'))).toBe(true);
    expect(anchorSelfTest().ok).toBe(true);
  });
});
