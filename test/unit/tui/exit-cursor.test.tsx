/**
 * The renderer's `unmount()` leaves the terminal cursor under the last frame, at column 0, where the shell prints its
 * next prompt. The composer places the real cursor on its input row in every frame (`useCursor`), and Ink's
 * `log.done()` does not move a placed cursor back down, so an unmount that did nothing more left the shell's prompt
 * inside the console box, over the input row. `unmount()` now sets `Bridge.closing` and commits a last frame that places
 * no cursor, and Ink's own return-to-bottom (`ESC[<n>B ESC[G`) is the write for it. `test/pty/exit-cursor.pty.test.ts`
 * checks the same thing through a real terminal and a shell prompt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTuiRenderer, type TuiRenderer } from '../../../src/tui/App.js';
import { StubStdin, StubStdout } from './stub-stdout.js';
import { tick } from '../../fixtures/tui/fixtures.js';

const mounted: TuiRenderer[] = [];
afterEach(async () => {
  for (const r of mounted.splice(0)) await r.unmount();
});

/**
 * Where the cursor is after `out`, relative to where the output started (row 0), and the row of the last `╰` written.
 * Enough of a terminal for what Ink writes into a frame shorter than the screen: text, CR, LF, and CSI A / B / E / G.
 */
function cursorAfter(out: string): { row: number; col: number; bottom: number } {
  let row = 0;
  let col = 0;
  let bottom = -1;
  for (const m of out.matchAll(/\x1b\[([?]?)([0-9;]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b])/gu)) {
    const ch = m[4];
    if (ch !== undefined) {
      if (ch === '\r') col = 0;
      else if (ch === '\n') row += 1;
      else if (ch >= ' ') {
        if (ch === '╰') bottom = row;
        col += 1;
      }
      continue;
    }
    if (m[3] === undefined || m[1] === '?') continue;
    const n = Number((m[2] ?? '').split(';')[0] || '1');
    if (m[3] === 'A') row -= n;
    else if (m[3] === 'B') row += n;
    else if (m[3] === 'E') {
      row += n;
      col = 0;
    } else if (m[3] === 'G') col = n - 1;
  }
  return { row, col, bottom };
}

describe('unmount: the cursor is handed back under the console box, never on its input row', () => {
  it('a session frame places the cursor on the input row; after unmount it is on the row under ╰…╯, column 0', async () => {
    const stdout = new StubStdout(24, 80, true);
    const stdin = new StubStdin();
    const r = createTuiRenderer({
      task: '',
      resumeId: null,
      onAbort: () => undefined,
      mode: 'session',
      cwd: '/tmp/proj',
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { NO_COLOR: '1', JEVCODE_REDUCED_MOTION: '1' },
      interactive: true,
    });
    mounted.push(r);
    await r.firstFrame();
    await tick(60);
    const live = cursorAfter(stdout.frames.join(''));
    // the precondition the bug needs: the box is drawn and the cursor sits inside it, above its bottom edge
    expect(live.bottom).toBeGreaterThan(0);
    expect(live.row).toBeLessThan(live.bottom);
    await r.unmount();
    mounted.splice(0);
    const end = cursorAfter(stdout.frames.join(''));
    expect(end.bottom).toBe(live.bottom);
    expect(end.row).toBe(end.bottom + 1);
    expect(end.col).toBe(0);
  });
});
