/**
 * AGENT-LOOP-DESIGN §15 S6 `agent-stream` (§9.4, §A1, §A3, §A5): the default agent mode in a real pty, driven through the `--mock`
 * agent trajectory (src/cli/mock-trajectory.ts `mockAgentTurns`: native tool calls with ids) whose FIRST prose turn streams the
 * stream probe's `mixed` preset (`JEVCODE_MOCK_CHAT_STREAM`, one delta every `JEVCODE_MOCK_DELTA_MS`). What the TUI must do with it:
 *
 * - the prose is visible while its line is still open — the 30-word paragraph shows its early words in a frame before the delta
 *   that ends it (its newline) arrives, and the first line shows `Sure k01.` before ` Here is the plan k02.\n`;
 * - every line lands in the scrollback exactly once (no duplicate on commit, nothing dropped);
 * - the mini indicator (braille, `src/tui/anim/frames.ts`) sits in the console status row's glyph slot while the run works, next
 *   to its status word, and is gone at idle;
 * - no frame carries the removed 12-row 3D animation (its luminance rows `.,-~:;=!*#$@`), and no frame shows braille outside
 *   the status row.
 *
 * The same scenario is `test/pty/smoke/agent-stream.steps` in `test/pty/run-smoke.sh`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { markerRe, streamPreset } from '../../src/perf/stream-fixture.js';
import { CHAT_OPEN, EXIT_IDLE, PLACEHOLDER_FOLLOWUP, afterFirstFrame, cleanupScratch, countClears, drive, echoStep, hasExpect, labelStep, staticRows, stripAnsi, syncFrames, type SyncFrame } from './helpers.js';

afterEach(cleanupScratch);

/** the gap between two streamed deltas: long enough that a frame (≤ 33 ms at 30 fps) lands between them */
const DELTA_MS = 40;
const BRAILLE_RE = /[⠀-⣿]/;
/** a row of the removed 12-row 3D animation: only its luminance ramp and spaces, with at least four of the dense glyphs */
const ANIM_ROW_RE = /^[\s.,\-~:;=!*#$@]+$/;
const animRow = (l: string): boolean => ANIM_ROW_RE.test(l) && (l.match(/[~:;=!*#$@]/g) ?? []).length >= 4;
/** the console's status row: the row after the last `├` separator of the dynamic region (the boxed tier) */
function statusRow(f: SyncFrame): string | null {
  for (let i = f.dynamic.length - 1; i >= 0; i--) if ((f.dynamic[i] ?? '').startsWith('├')) return f.dynamic[i + 1] ?? null;
  return null;
}
const WORKING_RE = new RegExp(`^│ ${BRAILLE_RE.source}{1,3} (?:thinking|replying|reading|editing|running|testing)\\b`);

describe.skipIf(!hasExpect)('pty agent-stream: the default agent mode streams its prose, commits each line once, and shows the mini indicator (AGENT-LOOP-DESIGN §15 S6)', () => {
  it('a task on the --mock agent trajectory with the `mixed` preset streamed at 40 ms: partial lines before their newline, each line once in the scrollback, the indicator only while working, no 12-row animation', async () => {
    const preset = streamPreset('mixed');
    const r = await drive({
      name: 'agent-stream',
      args: ['chat', '--mock'],
      env: { JEVCODE_MOCK_CHAT_STREAM: 'mixed', JEVCODE_MOCK_DELTA_MS: String(DELTA_MS) },
      steps: [...CHAT_OPEN, 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', labelStep('jevcode', 'Sure k01\\.'), 'expect Done k05', 'expect set VALUE to 2', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.3', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const frames = syncFrames(r.text);
    const has = (f: SyncFrame, marker: string): boolean => f.lines.some((l) => markerRe(marker).test(l));

    // 1. partial prose before its newline: a frame shows the paragraph's early words while its last word (the delta before its
    // newline) is not there yet; the first line's first half shows before the delta that ends that line
    expect(frames.some((f) => has(f, 'p05') && !has(f, 'p30'))).toBe(true);
    expect(frames.some((f) => has(f, 'k01') && !has(f, 'k02'))).toBe(true);
    // and the words appear in order: the paragraph grows frame by frame (not in one paint at the newline)
    const firstAt = (m: string): number => frames.findIndex((f) => has(f, m));
    expect(firstAt('p05')).toBeLessThan(firstAt('p20'));
    expect(firstAt('p20')).toBeLessThan(firstAt('p30'));

    // 2. every line of the reply lands in the scrollback exactly once
    const committed = staticRows(r.text);
    const markers = preset.markers.filter((m): m is string => m !== null);
    for (const m of markers) expect(committed.filter((row) => markerRe(m).test(row)), m).toHaveLength(1);
    expect(stripAnsi(r.text)).toMatch(/\[jevcode\](?: |\S)*Sure k01\. Here is the plan k02\./);

    // 3. the mini indicator: in the status row while the run works, never at idle
    const working = frames.filter((f) => WORKING_RE.test(statusRow(f) ?? ''));
    expect(working.length).toBeGreaterThan(0);
    const idle = frames.filter((f) => /^│ idle\b/.test(statusRow(f) ?? ''));
    expect(idle.length).toBeGreaterThan(0);
    for (const f of idle) expect(BRAILLE_RE.test(statusRow(f) ?? ''), statusRow(f) ?? '').toBe(false);
    // the last frame is idle (the run ended; the follow-up placeholder is up)
    const lastConsole = [...frames].reverse().find((f) => statusRow(f) !== null)!;
    expect(BRAILLE_RE.test(statusRow(lastConsole) ?? '')).toBe(false);

    // 4. no 12-row animation: no luminance rows, and braille only ever in the status row (one row per frame at most)
    for (const f of frames) {
      expect(f.lines.filter(animRow), `frame ${f.index}`).toEqual([]);
      const braille = f.lines.filter((l) => BRAILLE_RE.test(l));
      expect(braille.length, `frame ${f.index}`).toBeLessThanOrEqual(1);
      if (braille.length === 1) expect(braille[0], `frame ${f.index}`).toBe(statusRow(f));
    }
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`agent-stream: ${frames.length} frames, ${working.length} with the indicator in the status row, ${idle.length} idle; ${committed.length} scrollback rows`);
  });
});
