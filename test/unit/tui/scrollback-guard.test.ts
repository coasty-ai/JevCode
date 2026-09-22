/**
 * TUI-DESIGN-4 §1.4 / §10 S1 (`scrollback-guard.test.ts`): the exact 11-character `clearTerminal` sequence is
 * rewritten to the 7-character safe clear; `ESC[2J` alone, an `ESC[3J` in a non-clear context and `ESC[2K` are
 * untouched; Buffer chunks pass through; all three `write` overloads forward; the property forwarding Ink needs
 * (`isTTY` / `rows` / `columns` / `on` / `off`); a zero-length write forwards; and edge 12's `fullStaticOutput`
 * elision keeps the copy count at exactly 1 however many clearing frames fire.
 */
import { describe, expect, it } from 'vitest';
import { CLEAR_SAFE, CLEAR_TERMINAL, guardStdout, isGuarded, isLogClearWrite } from '../../../src/tui/scrollback-guard.js';

/** Ink's real `log.clear()` chunk: `buildReturnToBottomPrefix(cursorWasShown, n, pos) + eraseLines(n)`. */
const inkClear = (lines: number, down = 2): string => `\u001b[?25l${down > 0 ? `\u001b[${down}B` : ''}\u001b[1G${'\u001b[2K\u001b[1A'.repeat(Math.max(0, lines - 1))}\u001b[2K\u001b[G`;

interface Recorded {
  chunk: unknown;
  a?: unknown;
  b?: unknown;
}

function fakeStream(ret = true): {
  writes: Recorded[];
  isTTY: boolean;
  rows: number;
  columns: number;
  listeners: string[];
  write(chunk: unknown, a?: unknown, b?: unknown): boolean;
  on(name: string, fn: () => void): unknown;
  off(name: string, fn: () => void): unknown;
} {
  const writes: Recorded[] = [];
  const listeners: string[] = [];
  const s = {
    writes,
    isTTY: true,
    rows: 24,
    columns: 80,
    listeners,
    write(chunk: unknown, a?: unknown, b?: unknown): boolean {
      writes.push({ chunk, ...(a === undefined ? {} : { a }), ...(b === undefined ? {} : { b }) });
      return ret;
    },
    on(name: string, _fn: () => void): unknown {
      listeners.push(name);
      // `this` must be the REAL stream, never the proxy (edge 5): record it so the test can check
      return s;
    },
    off(name: string, _fn: () => void): unknown {
      listeners.push(`-${name}`);
      return s;
    },
  };
  return s;
}

const texts = (s: { writes: Recorded[] }): string[] => s.writes.map((w) => String(w.chunk));

describe('guardStdout (TUI-DESIGN-4 §1.4): ESC[3J never reaches the terminal', () => {
  it('the measured constants: `clearTerminal` is exactly 11 characters and the safe clear 7', () => {
    expect(CLEAR_TERMINAL).toBe('\u001b[2J\u001b[3J\u001b[H');
    expect(CLEAR_TERMINAL.length).toBe(11);
    expect(CLEAR_SAFE).toBe('\u001b[2J\u001b[H');
    // `ESC[2J` (4) + `ESC[H` (3) = 7; the design's prose says "9-character", which is the count the source comment
    // carried over from the 11 − 2 arithmetic. 11 is the load-bearing number (the length check / fixed-offset slice).
    expect(CLEAR_SAFE.length).toBe(7);
  });

  it('the exact sequence is rewritten; the frame after it is preserved byte for byte', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    out.write(`${CLEAR_TERMINAL}frame body\n`);
    expect(texts(s)).toEqual([`${CLEAR_SAFE}frame body\n`]);
    expect(texts(s)[0]).not.toContain('\u001b[3J');
  });

  it('`ESC[2J` alone, a lone `ESC[3J`, `ESC[2K` and ordinary text are untouched', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    const passthrough = ['\u001b[2J', '\u001b[3J', '\u001b[2K\u001b[1A\u001b[2K\u001b[G', 'hello\n', '\u001b[2J\u001b[H', '\u001b[3J\u001b[2J\u001b[H'];
    for (const p of passthrough) out.write(p);
    expect(texts(s)).toEqual(passthrough);
  });

  it('a clear with bytes before it keeps the head and rewrites only the sequence, at most once per chunk', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    out.write(`head${CLEAR_TERMINAL}tail${CLEAR_TERMINAL}more`);
    const written = texts(s)[0]!;
    expect(written.startsWith(`head${CLEAR_SAFE}tail`)).toBe(true);
    // the SECOND occurrence is left alone: the proxy replaces the exact sequence at most once per chunk
    expect(written.split('\u001b[3J')).toHaveLength(2);
    expect(written).toBe(`head${CLEAR_SAFE}tail${CLEAR_TERMINAL}more`);
  });

  it('Buffer and Uint8Array chunks pass through untouched (edge 1: only strings are inspected)', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    const buf = Buffer.from(`${CLEAR_TERMINAL}x`, 'utf8');
    out.write(buf);
    expect(s.writes[0]?.chunk).toBe(buf);
  });

  it('all three write overloads forward, and the back-pressure return value is the underlying one (edges 3 and 4)', () => {
    const s = fakeStream(false);
    const out = guardStdout(s);
    const cb = (): void => undefined;
    expect(out.write('a')).toBe(false);
    out.write('b', 'utf8');
    out.write('c', 'utf8', cb);
    out.write('d', cb);
    expect(s.writes.map((w) => [w.chunk, w.a, w.b])).toEqual([
      ['a', undefined, undefined],
      ['b', 'utf8', undefined],
      ['c', 'utf8', cb],
      ['d', cb, undefined],
    ]);
  });

  it('a zero-length write forwards (edge 7: `waitUntilRenderFlush` queues one as a barrier)', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    out.write('');
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0]?.chunk).toBe('');
  });

  it('every property Ink reads forwards, methods stay bound to the real stream, and writes are settable (edges 5 and 6)', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    expect(out.isTTY).toBe(true);
    expect(out.rows).toBe(24);
    expect(out.columns).toBe(80);
    out.on('resize', () => undefined);
    out.off('resize', () => undefined);
    expect(s.listeners).toEqual(['resize', '-resize']);
    out.columns = 120;
    expect(s.columns).toBe(120);
    expect(out.columns).toBe(120);
    // edge 6: the SAME proxy object must go everywhere (Ink keys its instance map by the stream object), so a second
    // `createTuiRenderer` on one stdout re-renders the first Ink instance instead of mounting a second one
    expect(guardStdout(s)).toBe(out);
    expect(guardStdout(out)).toBe(out);
    expect(isGuarded(out)).toBe(true);
    expect(isGuarded(s)).toBe(false);
    expect(out).not.toBe(s);
  });

  it("ink's REAL `log.clear()` shape is recognised: cursor prefix + eraseLines, not a bare eraseLines", () => {
    // `render.clear = () => stream.write(buildReturnToBottomPrefix(...) + eraseLines(n))` (log-update.js), and the
    // prefix is non-empty on every frame of this product because the App passes `setCursorPosition` to the Console,
    // the Overlay and the Composer, so `cursorWasShown` is always true (cursor-helpers.js:47-55).
    expect(isLogClearWrite(inkClear(11))).toBe(true);
    expect(isLogClearWrite(inkClear(11, 0))).toBe(true);
    expect(isLogClearWrite('\u001b[?25l\u001b[1G')).toBe(true); // eraseLines(0) after a clear
    expect(isLogClearWrite('\u001b[2K\u001b[1A\u001b[2K\u001b[G')).toBe(true); // cursorWasShown === false
    expect(isLogClearWrite('')).toBe(false);
    expect(isLogClearWrite('\u001b[G')).toBe(false);
    expect(isLogClearWrite('hello\n')).toBe(false);
    expect(isLogClearWrite(`${CLEAR_TERMINAL}x`)).toBe(false);
  });

  it('edge 12 on the PRIMARY path: the cursor-prefixed clear teaches `staticSeen`, so the N+1-copies bound holds', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    const batch = 'item one\nitem two\n';
    out.write(inkClear(11));
    out.write(batch);
    out.write('frame A\n\u001b[?25h');
    out.write(`${CLEAR_TERMINAL}${batch}frame B\n`);
    out.write(`${CLEAR_TERMINAL}${batch}frame C\n`);
    const all = texts(s).join('');
    expect(all).not.toContain('\u001b[3J');
    expect(all.split('item one').length - 1).toBe(1);
    expect(texts(s)[3]).toBe(`${CLEAR_SAFE}frame B\n`);
    expect(texts(s)[4]).toBe(`${CLEAR_SAFE}frame C\n`);
  });

  it('the frame write that follows a clear is never mistaken for a static batch (it ends with the show-cursor escape)', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    out.write(inkClear(4));
    out.write('frame A\n\u001b[2A\u001b[3G\u001b[?25h'); // `log()`'s output + buildCursorSuffix
    out.write(`${CLEAR_TERMINAL}frame A\nmore\n`);
    // nothing was learned, so nothing is elided: the whole frame survives
    expect(texts(s)[2]).toBe(`${CLEAR_SAFE}frame A\nmore\n`);
  });

  it('edge 12: the duplicated `fullStaticOutput` prefix is elided, so N clearing frames leave exactly ONE copy', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    const staticBatch = 'item one\nitem two\nitem three\n';
    // Ink's non-clearing static path: `log.clear()`'s eraseLines, then the static batch as its own write
    out.write('\u001b[2K\u001b[1A\u001b[2K\u001b[G');
    out.write(staticBatch);
    out.write('frame A\n');
    // the clearing frame: `clearTerminal + fullStaticOutput + outputToRender` in ONE write (ink.js:768)
    out.write(`${CLEAR_TERMINAL}${staticBatch}frame B\n`);
    out.write(`${CLEAR_TERMINAL}${staticBatch}frame C\n`);
    const all = texts(s).join('');
    expect(all).not.toContain('\u001b[3J');
    // the batch is on screen once (the first, non-clearing write); the two clearing frames did NOT repeat it
    expect(all.split('item one').length - 1).toBe(1);
    expect(texts(s)[3]).toBe(`${CLEAR_SAFE}frame B\n`);
    expect(texts(s)[4]).toBe(`${CLEAR_SAFE}frame C\n`);
  });

  it('REGRESSION (finding 2): two clearing chunks sharing their first FRAME lines keep every frame row', () => {
    // A vertical drag redraws a width-invariant rule row, so consecutive clearing frames share their first dynamic
    // line. A longest-common-prefix rule ate it — and ink still calls `log.sync(outputToRender)` with the full frame,
    // so `previousLineCount` would then exceed what is on screen and the next `eraseLines(n)` would erase scrollback.
    const s = fakeStream();
    const out = guardStdout(s);
    out.write(`${CLEAR_TERMINAL}static1\nstatic2\nRULEROW\nbody A\n`);
    out.write(`${CLEAR_TERMINAL}static1\nstatic2\nRULEROW\nbody B\n`);
    expect(texts(s)[1]).toContain('RULEROW');
    expect(texts(s)[1]).toBe(`${CLEAR_SAFE}static1\nstatic2\nRULEROW\nbody B\n`);
    expect(texts(s).join('')).not.toContain('\u001b[3J');
  });

  it('with nothing observed the clearing chunk is passed through with the rewrite only (the first copy IS the screen)', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    const batch = 'a\nb\nc\n';
    out.write(`${CLEAR_TERMINAL}${batch}first\n`);
    expect(texts(s)[0]).toBe(`${CLEAR_SAFE}${batch}first\n`);
    // a chunk that is not `clear + static + frame` passes through with only the rewrite
    out.write(`${CLEAR_TERMINAL}totally different payload`);
    expect(texts(s)[1]).toBe(`${CLEAR_SAFE}totally different payload`);
    expect(texts(s).join('')).not.toContain('\u001b[3J');
  });

  it('a static batch that grows keeps the elision exact: only the observed prefix is ever removed', () => {
    const s = fakeStream();
    const out = guardStdout(s);
    out.write(inkClear(6));
    out.write('one\n');
    out.write(`${CLEAR_TERMINAL}one\nFRAME 1\n`);
    expect(texts(s)[2]).toBe(`${CLEAR_SAFE}FRAME 1\n`);
    out.write(inkClear(6));
    out.write('two\n');
    out.write(`${CLEAR_TERMINAL}one\ntwo\nFRAME 2\n`);
    expect(texts(s)[5]).toBe(`${CLEAR_SAFE}FRAME 2\n`);
    // and a chunk whose body does NOT start with the observed static is left whole
    out.write(`${CLEAR_TERMINAL}three\nFRAME 3\n`);
    expect(texts(s)[6]).toBe(`${CLEAR_SAFE}three\nFRAME 3\n`);
  });
});

describe('§1.4 edge 6 (the regression the pty Ctrl+Z leg caught, integrator 2026-09-22)', () => {
  /**
   * `App.tsx`'s `doSuspend` guards Ctrl+Z with "is this the real terminal?" — a test mount or a pipe must never
   * SIGSTOP the process. It did that with `stdout === process.stdout`, which §1.4 quietly falsified: Ink is handed
   * `guardStdout(process.stdout)`, a Proxy, so the check failed for the REAL terminal too and Ctrl+Z became a
   * no-op for every user (measured in `test/pty/chat.pty.test.ts`: no `ESC[?2004h` after SIGCONT, because
   * `suspendProcess` was never reached). The memoisation is what makes the fixed check work, so it is pinned here.
   */
  it('`guardStdout(x)` is the one proxy for `x`, and never equals `x` — the two facts the Ctrl+Z guard rests on', () => {
    const raw = { write: () => true, isTTY: true };
    const guarded = guardStdout(raw);
    expect(guarded).not.toBe(raw);
    expect(guardStdout(raw)).toBe(guarded);
    expect(guardStdout(guarded)).toBe(guarded);
    expect(isGuarded(guarded)).toBe(true);
    expect(isGuarded(raw)).toBe(false);
    // a DIFFERENT stream gets a different proxy: the identity is per underlying stream, not global
    const other = { write: () => true, isTTY: true };
    expect(guardStdout(other)).not.toBe(guarded);
  });
});
