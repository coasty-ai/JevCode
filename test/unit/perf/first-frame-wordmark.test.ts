/**
 * `wordmarkFirstFrame` (src/perf/first-frame.ts), the first-frame probe's splash reader, over synthetic pty bytes. The owner's
 * directive of 2026-09-23 commits the settled wordmark as the first `<Static>` block — at frame 0 when the frame already has
 * an item (`jevcode run "<task>"`'s header) — and Ink writes a frame's `<Static>` rows after the synchronized-output bracket
 * opens and BEFORE its log-update hides the cursor, so the reader counts from the bracket that opens the first frame.
 */
import { describe, expect, it } from 'vitest';
import { wordmarkFirstFrame } from '../../../src/perf/first-frame.js';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ROW = '    ██ ███████';

describe('wordmarkFirstFrame', () => {
  it('a chat first frame: splash frame 0 in the dynamic region, after the cursor hide', () => {
    expect(wordmarkFirstFrame(`${BSU}${HIDE}────\r\n${ROW}\r\n╭─ agent ─╮${SHOW}${ESU}`)).toBe(9);
  });
  it('a `run` first frame: the committed mark is written between the bracket and the hide — it counts', () => {
    expect(wordmarkFirstFrame(`\x1b[?1004h${BSU}${ROW}\r\n${ROW}\r\n    [run] jevcode task: x\r\n${HIDE}────\r\n╭─ agent ─╮${SHOW}${ESU}`)).toBe(18);
  });
  it('only the first frame: a later frame\'s cells never count', () => {
    expect(wordmarkFirstFrame(`${BSU}${HIDE}────\r\n╭─ agent ─╮${SHOW}${ESU}${BSU}${ROW}${HIDE}────${SHOW}${ESU}`)).toBe(0);
  });
  it('no bracket: from the hide, as before', () => {
    expect(wordmarkFirstFrame(`${ROW}${HIDE}────\r\n${ROW}${SHOW}`)).toBe(9);
  });
  it('no frame at all: 0', () => {
    expect(wordmarkFirstFrame(`${ROW}`)).toBe(0);
  });
});
