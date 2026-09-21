/**
 * TUI-DESIGN §18: the pure parsers behind the perf probes (`src/perf/pty.ts`) — the clear-detection regex and its
 * self-test, clear events vs matches, frame splitting with the erase-count height, Static-row classification, chunk
 * timestamps, keystroke → frame pairing on the composer row, painted dynamic rows, per-frame cursor stats, the
 * drive.exp → typist step adapter, the per-second frame rate and the static / key / dynamic frame classes of §18's
 * frame-rate gate.
 */
import { describe, expect, it } from 'vitest';
import { BSU, CLEAR_RE, ESU, chunkTimeAt, classCounts, classifyFrame, classifyFrames, clearReSelfTest, clearStats, composerEndsWithKey, composerRow, countClears, cursorStats, decodeSendText, frameContent, frameMix, frameRows, framesPerSecond, framesPerSecondByClass, isBoxedFrame, keyLatencies, lastSendAtOrBefore, paintedRows, paintedRowsChanged, parseTiming, safeKey, sendTimes, splitFrames, staticRows, stripAnsi, summarise, throttleMs, toTypistSteps, wordmarkCells, type Chunk } from '../../../src/perf/pty.js';

const RULE = '\x1b[2m' + '─'.repeat(20) + '\x1b[22m';
/** an Ink frame as the pty shows it: hide, return to bottom, erase `prev + 1` rows, rows, cursor suffix */
function frame(rows: readonly string[], prevRows: number, cursorUp = 2): string {
  const erase = prevRows === 0 ? '' : '\x1b[2B\x1b[1G' + Array.from({ length: prevRows + 1 }, (_, i) => (i === 0 ? '\x1b[2K' : '\x1b[1A\x1b[2K')).join('') + '\x1b[G';
  return `${BSU}\x1b[?25l${erase}${rows.join('\r\n')}\r\n\x1b[${cursorUp}A\x1b[3G\x1b[?25h${ESU}`;
}

describe('CLEAR_RE (§18 finding 9)', () => {
  it('self-test: matches the four clear forms and not erase-line', () => {
    expect(clearReSelfTest()).toBe(true);
    expect(countClears('\x1b[2K\x1b[1A')).toBe(0);
    expect(countClears('\x1b[2J\x1b[3J\x1b[H')).toBe(2);
    expect(CLEAR_RE.lastIndex).toBe(0);
  });
  it('counts Ink clearTerminal (2J 3J H) as one event and two matches; RIS and alt-screen separately', () => {
    const s = 'x\x1b[2J\x1b[3J\x1b[Hy\x1bc\x1b[?1049h\x1b[?1049l\x1b[3J';
    expect(clearStats(s)).toEqual({ matches: 6, events: 5, ris: 1, altScreen: 2 });
    expect(clearStats('plain').events).toBe(0);
  });
});

describe('splitFrames', () => {
  it('cuts at BSU/ESU, keeps bytes outside, and derives the previous height from the erase count minus the trailing newline', () => {
    const cap = 'prologue' + frame([RULE, '> a', 'idle'], 0) + 'mid' + frame([RULE, '> ab', 'idle'], 3) + 'tail';
    const { frames, outside } = splitFrames(cap);
    expect(frames).toHaveLength(2);
    expect(outside).toBe('prologuemidtail');
    expect(frames[0]!.erased).toBe(0);
    expect(frames[0]!.height).toBe(0);
    expect(frames[1]!.erased).toBe(4);
    expect(frames[1]!.height).toBe(3);
    expect(frames[1]!.start).toBe(cap.indexOf(BSU, frames[0]!.end));
    expect(frames[1]!.end).toBe(cap.lastIndexOf(ESU) + ESU.length);
  });
  it('keeps an unterminated bracket as a frame', () => {
    const { frames } = splitFrames(`${BSU}\x1b[?25l\x1b[2K\x1b[1A\x1b[2Kcut`);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.height).toBe(1);
  });
  it('frameContent strips the erase prefix and the cursor suffix so a repaint compares equal to the frame before it', () => {
    const before = splitFrames(frame([RULE, '> abc', 'idle'], 3)).frames[0]!;
    const repaint = splitFrames(frame([RULE, '> abc', 'idle'], 5, 1)).frames[0]!;
    expect(frameContent(before.body)).toBe(frameContent(repaint.body));
    expect(frameContent(before.body)).toBe(`${RULE}\r\n> abc\r\nidle\r\n`);
  });
});

describe('staticRows / frameMix', () => {
  it('counts the rows before the first rule row: 0 for a dynamic-only repaint, n for a Static-carrying frame, -1 without a rule', () => {
    expect(staticRows(splitFrames(frame([RULE, '> a', 'idle'], 3)).frames[0]!.body)).toBe(0);
    expect(staticRows(splitFrames(frame(['[step 1] intent=edit', '[step 1] risk ok', RULE, '> a', 'idle'], 3)).frames[0]!.body)).toBe(2);
    expect(staticRows('\x1b[?25l[run] header only\r\n')).toBe(-1);
    // the pane's tab header is a rule row too
    expect(staticRows(`\x1b[?25l\x1b[2K${'─'.repeat(3)} decisions s4 ${'─'.repeat(10)} [d]ecisions\r\n> a\r\n`)).toBe(0);
    // a latin1-decoded capture keeps ─ as three adjacent code units
    expect(staticRows(`\x1b[?25lâ\u0094\u0080â\u0094\u0080â\u0094\u0080â\u0094\u0080\r\n> a\r\n`)).toBe(0);
  });
  it('frameMix splits frames into Static-carrying and dynamic-only', () => {
    const { frames } = splitFrames(frame([RULE, '> a', 'idle'], 3) + frame(['[step 2] plan', RULE, '> a', 'idle'], 3) + frame([RULE, '> ab', 'idle'], 3));
    expect(frameMix(frames)).toEqual({ withStatic: 1, dynamicOnly: 2 });
  });
});

describe('timing records', () => {
  it('parseTiming separates chunk records from steps and keeps the send offset', () => {
    const text = ['{"t": 6.0, "step": 1, "op": "expect", "arg": "ready"}', '{"t": 7.5, "op": "chunk", "off": 0, "n": 120}', '{"t": 9.0, "step": 2, "op": "send", "arg": "A", "off": 120}', 'garbage', '{"t": 10, "op": "chunk", "off": 120, "n": 30}'].join('\n');
    const { steps, chunks } = parseTiming(text);
    expect(steps).toEqual([
      { t: 6, step: 1, op: 'expect', arg: 'ready' },
      { t: 9, step: 2, op: 'send', arg: 'A', off: 120 },
    ]);
    expect(chunks).toEqual([
      { t: 7.5, off: 0, n: 120 },
      { t: 10, off: 120, n: 30 },
    ]);
  });
  it('chunkTimeAt finds the chunk holding a byte offset', () => {
    const chunks: Chunk[] = [
      { t: 1, off: 0, n: 10 },
      { t: 2, off: 10, n: 5 },
      { t: 3, off: 15, n: 100 },
    ];
    expect(chunkTimeAt(chunks, 0)).toBe(1);
    expect(chunkTimeAt(chunks, 9)).toBe(1);
    expect(chunkTimeAt(chunks, 10)).toBe(2);
    expect(chunkTimeAt(chunks, 14)).toBe(2);
    expect(chunkTimeAt(chunks, 15)).toBe(3);
    expect(chunkTimeAt(chunks, 114)).toBe(3);
    expect(chunkTimeAt(chunks, 115)).toBeNull();
    expect(chunkTimeAt([], 0)).toBeNull();
  });
});

describe('keyLatencies / framesPerSecond', () => {
  it('pairs a measured send with the first later frame whose composer row ends with the key, timed by the chunk that completed it', () => {
    const f0 = frame([RULE, '> ', 'idle'], 0);
    const spinner = frame([RULE, '> A', 'idle'], 3); // arrived after the send of B but still shows A
    const fA = frame([RULE, '> A', 'idle'], 3);
    const fB = frame([RULE, '> AB', 'idle'], 3);
    const cap = f0 + fA + spinner + fB;
    const { frames } = splitFrames(cap);
    const offA = f0.length; // A sent after the first frame
    const offB = f0.length + fA.length; // B sent after A's frame
    // one chunk per frame, arriving at 100, 205, 300, 412 ms
    const chunks: Chunk[] = [
      { t: 100, off: 0, n: f0.length },
      { t: 205, off: f0.length, n: fA.length },
      { t: 300, off: f0.length + fA.length, n: spinner.length },
      { t: 412, off: f0.length + fA.length + spinner.length, n: fB.length },
    ];
    const timing = [
      { t: 200, step: 3, op: 'send', arg: 'A', off: offA },
      { t: 400, step: 5, op: 'send', arg: 'B', off: offB },
      { t: 401, step: 7, op: 'send', arg: 'C', off: offB }, // never rendered
    ];
    const lat = keyLatencies(timing, frames, chunks, new Set([3, 5, 7]));
    expect(lat.map((l) => [l.key, l.frameIndex, l.ms])).toEqual([
      ['A', 1, 5],
      ['B', 3, 12],
    ]);
    const s = summarise(lat.map((l) => l.ms));
    expect(s).toEqual({ samples: 2, p50: 5, p95: 12, max: 12, raw: [5, 12] });
    const fps = framesPerSecond(frames, chunks, 0, 2000);
    expect(fps.buckets).toEqual([4, 0]);
    expect(fps.max).toBe(4);
    expect(fps.mean).toBe(2);
    expect(framesPerSecond(frames, chunks, 0, 500)).toEqual({ max: null, mean: null, buckets: [] });
  });
  it('safeKey cycles the uppercase alphabet with no equal neighbours', () => {
    expect(safeKey(0)).toBe('A');
    expect(safeKey(25)).toBe('Z');
    expect(safeKey(26)).toBe('A');
    for (let i = 0; i < 60; i++) expect(safeKey(i)).not.toBe(safeKey(i + 1));
  });
});

describe('frame rows (composer row, painted rows, cursor per frame)', () => {
  it('stripAnsi / frameRows drop escapes and trailing empty rows; composerRow is the row above the status line', () => {
    const body = splitFrames(frame([RULE, '> abc', 'idle  ? help'], 3)).frames[0]!.body;
    expect(stripAnsi('\x1b[2m─\x1b[22m\x1b[0 q\x1b]0;t\x07x')).toBe('─x');
    expect(frameRows(body)).toEqual(['─'.repeat(20), '> abc', 'idle  ? help']);
    expect(composerRow(body)).toBe('> abc');
    expect(composerRow(`${BSU}\x1b[?25l\x1b[1A\x1b[3G\x1b[?25h${ESU}`.slice(BSU.length, -ESU.length))).toBeNull();
    expect(isBoxedFrame(body)).toBe(false);
  });
  it('composerRow unwraps the boxed console (TUI-DESIGN-2 §4.3): the fourth row from the bottom without its edges and padding, in utf8, latin1 and --ascii', () => {
    const boxed = [RULE, '╭─ jev-only ───── proj ─╮', '│ › a draft         │', '│   more textK      │', '├───────────────────┤', '│ idle       ? help │', '╰───────────────────╯'];
    const body = splitFrames(frame(boxed, 7)).frames[0]!.body;
    expect(isBoxedFrame(body)).toBe(true);
    expect(composerRow(body)).toBe('  more textK');
    expect(composerEndsWithKey(splitFrames(frame(boxed, 7)).frames[0]!, 'K', null)).toBe(true);
    // the same frame as a latin1-decoded capture (`│` = C3 94 82 → â\u0094\u0082)
    const latin1 = Buffer.from(frame(boxed, 7), 'utf8').toString('latin1');
    expect(composerRow(splitFrames(latin1).frames[0]!.body)).toBe('  more textK');
    const ascii = [RULE, '+- jev-only ----- proj -+', '| > a draft         |', '|   more textK      |', '+-------------------+', '| idle       ? help |', '+-------------------+'];
    expect(composerRow(splitFrames(frame(ascii, 7)).frames[0]!.body)).toBe('  more textK');
    // the flat tier is unchanged: the row above the status row
    expect(composerRow(splitFrames(frame([RULE, '› abc', 'jev-only · idle'], 3)).frames[0]!.body)).toBe('› abc');
  });
  it('wordmarkCells counts the `█` cells of a splash frame in utf8 and latin1', () => {
    const rows = [RULE, '    ██ ▓▒░', '    ██ ▓▒░', '╭─ jev-only ─╮', '│ › Say hi   │', '├────────────┤', '│ idle       │', '╰────────────╯'];
    const body = splitFrames(frame(rows, 0)).frames[0]!.body;
    expect(wordmarkCells(body)).toBe(4);
    expect(wordmarkCells(Buffer.from(body, 'utf8').toString('latin1'))).toBe(4);
    expect(wordmarkCells(splitFrames(frame([RULE, '› x', 'idle'], 3)).frames[0]!.body)).toBe(0);
    // a row whose text ends in a carriage return arrives as CR CR LF through the pty: one line break, not two
    expect(frameRows('a\r\r\nb\r\nc\r\n')).toEqual(['a', 'b', 'c']);
    expect(paintedRows(`${'─'.repeat(4)}\r\nloop banner\r\r\n> x\r\nidle\r\n`)).toBe(4);
  });
  it('paintedRows counts from the last rule row to the last row, in utf8 and latin1 captures, and through a clear-terminal frame', () => {
    expect(paintedRows(splitFrames(frame(['[step 1] a', '[step 1] b', RULE, '> a', 'idle'], 0)).frames[0]!.body)).toBe(3);
    expect(paintedRows(`\x1b[?25l\x1b[2K${'─'.repeat(3)} decisions s4 ${'─'.repeat(10)} [d]ecisions\r\npane\r\n> a\r\nidle\r\n`)).toBe(4);
    expect(paintedRows(`\x1b[?25lâ\u0094\u0080â\u0094\u0080â\u0094\u0080â\u0094\u0080\r\n> a\r\nidle\r\n`)).toBe(3);
    // Ink's clearTerminal frame: 2J 3J H, the whole Static history, then the dynamic frame — erase count 0, painted 3
    const clear = splitFrames(`${BSU}\x1b[2J\x1b[3J\x1b[H[run] header\r\n[step 1] a\r\n${RULE}\r\n> a\r\nidle\r\n\x1b[2A\x1b[3G\x1b[?25h${ESU}`).frames[0]!;
    expect(clear.height).toBe(0);
    expect(paintedRows(clear.body)).toBe(3);
    expect(paintedRows('\x1b[?25l\x1b[1A\x1b[3G\x1b[?25h')).toBeNull();
    // a Static row that merely starts with three dashes and text is not a rule
    expect(paintedRows('\x1b[?25l---not a rule\r\n> a\r\nidle\r\n')).toBeNull();
  });
  it('cursorStats counts hides per frame, frames that do not end with a show, and the final visibility', () => {
    const shown = frame([RULE, '> a', 'idle'], 3);
    const noShow = `${BSU}\x1b[?25l\x1b[?25l${RULE}\r\n> a\r\nidle\r\n\x1b[2A${ESU}`;
    const { frames } = splitFrames(shown + noShow);
    expect(cursorStats(frames, shown + noShow)).toEqual({ hidesMaxPerFrame: 2, framesWithoutShow: 1, shownAtEnd: false });
    expect(cursorStats(splitFrames(shown).frames, shown)).toEqual({ hidesMaxPerFrame: 1, framesWithoutShow: 0, shownAtEnd: true });
  });
});

describe('keyLatencies pairs on the composer row', () => {
  it('skips a frame whose wrapped draft row ends with the key while the cursor row does not (an intervening Static frame), and takes the later frame', () => {
    // a 2-row draft whose first (wrapped) row ends with D; the key D is typed at the end of the second row
    const draft1 = 'abcd'.repeat(19) + 'ABCD';
    const before = frame([RULE, `> ${draft1}`, 'ABC', 'idle'], 4);
    const staticFrame = frame(['[step 7] intent=edit', RULE, `> ${draft1}`, 'ABC', 'idle'], 4); // written after the send of D, still shows ABC
    const real = frame([RULE, `> ${draft1}`, 'ABCD', 'idle'], 4);
    const cap = before + staticFrame + real;
    const { frames } = splitFrames(cap);
    expect(frames).toHaveLength(3);
    const chunks: Chunk[] = [
      { t: 100, off: 0, n: before.length },
      { t: 200, off: before.length, n: staticFrame.length },
      { t: 209, off: before.length + staticFrame.length, n: real.length },
    ];
    const lat = keyLatencies([{ t: 198, step: 9, op: 'send', arg: 'D', off: before.length }], frames, chunks, new Set([9]));
    expect(lat.map((l) => [l.key, l.frameIndex, l.ms])).toEqual([['D', 2, 11]]);
  });
  it('the toggle matcher pairs a key with the first frame whose painted rows differ from the screen the key acted on', () => {
    const collapsed = frame([RULE, 'pane 1', 'pane 2', 'review', '> (review pending)', 'idle'], 6);
    const tick = frame([RULE, 'pane 1', 'pane 2', 'review', '> (review pending)', 'idle 0m07s'], 6); // the 1 Hz clock, same layout
    const expanded = frame([RULE, 'review', '> (review pending)', 'idle 0m07s'], 6);
    const cap = collapsed + tick + expanded;
    const { frames } = splitFrames(cap);
    const chunks: Chunk[] = [
      { t: 100, off: 0, n: collapsed.length },
      { t: 150, off: collapsed.length, n: tick.length },
      { t: 160, off: collapsed.length + tick.length, n: expanded.length },
    ];
    const lat = keyLatencies([{ t: 140, step: 3, op: 'send', arg: 'e', off: collapsed.length }], frames, chunks, new Set([3]), paintedRowsChanged);
    expect(lat.map((l) => [l.frameIndex, l.ms])).toEqual([[2, 20]]);
    // without a screen before the key nothing can be compared
    expect(keyLatencies([{ t: 1, step: 3, op: 'send', arg: 'e', off: 0 }], frames, chunks, new Set([3]), paintedRowsChanged)).toEqual([]);
  });
});

describe('frame classes (§18 frame rate: static / key / dynamic)', () => {
  it('throttleMs is Ink\'s renderThrottleMs: ceil(1000 / maxFps), at least 1, 0 when unthrottled', () => {
    expect(throttleMs(30)).toBe(34);
    expect(throttleMs(15)).toBe(67);
    expect(throttleMs(4)).toBe(250);
    expect(throttleMs(2000)).toBe(1);
    expect(throttleMs(0)).toBe(0);
  });
  it('sendTimes collects every send (measured or not) ascending; lastSendAtOrBefore finds the latest one not after t', () => {
    const timing = [
      { t: 50, step: 1, op: 'expect', arg: 'ready' },
      { t: 300, step: 4, op: 'send', arg: 'B', off: 10 },
      { t: 100, step: 2, op: 'send', arg: 'A', off: 5 },
      { t: 200, step: 3, op: 'sleep', arg: '100' },
      { t: 320, step: 5, op: 'send', arg: '\x03', off: 12 },
    ];
    const sends = sendTimes(timing);
    expect(sends).toEqual([100, 300, 320]);
    expect(lastSendAtOrBefore(sends, 99)).toBeNull();
    expect(lastSendAtOrBefore(sends, 100)).toBe(100);
    expect(lastSendAtOrBefore(sends, 299.9)).toBe(100);
    expect(lastSendAtOrBefore(sends, 310)).toBe(300);
    expect(lastSendAtOrBefore(sends, 1000)).toBe(320);
    expect(lastSendAtOrBefore([], 5)).toBeNull();
  });
  it('classifyFrame: new Static rows win, then a frame within one throttle period after a send is a key frame, the rest is dynamic', () => {
    const staticFrame = splitFrames(frame(['[step 3] intent=edit', RULE, '> A', 'idle'], 3)).frames[0]!;
    const dyn = splitFrames(frame([RULE, '> A', 'idle 0m03s'], 3)).frames[0]!;
    const sends = [1000, 1100];
    // a Static-carrying frame is static even right after a key
    expect(classifyFrame(staticFrame, 1003, sends, 34)).toBe('static');
    // inside the window after a send: key; at the boundary still key; one ms past it: dynamic
    expect(classifyFrame(dyn, 1003, sends, 34)).toBe('key');
    expect(classifyFrame(dyn, 1034, sends, 34)).toBe('key');
    expect(classifyFrame(dyn, 1035, sends, 34)).toBe('dynamic');
    expect(classifyFrame(dyn, 1102, sends, 34)).toBe('key');
    // before any send, or without an arrival time, a non-static frame is dynamic
    expect(classifyFrame(dyn, 900, sends, 34)).toBe('dynamic');
    expect(classifyFrame(dyn, null, sends, 34)).toBe('dynamic');
    // the first frame (header before the cursor hide, no rule row) is not a Static append
    expect(classifyFrame(splitFrames(`${BSU}\x1b[?25l[run] header\r\n${ESU}`).frames[0]!, 1003, [], 34)).toBe('dynamic');
  });
  it('classifyFrames / classCounts / framesPerSecondByClass: one class per frame, busiest bucket per class over the window', () => {
    const f0 = frame([RULE, '> ', 'idle'], 0);
    const fStatic = frame(['[step 1] plan', RULE, '> ', 'idle'], 3);
    const fKey = frame([RULE, '> A', 'idle'], 3);
    const fTick = frame([RULE, '> A', 'idle 0m01s'], 3);
    const fStatic2 = frame(['[step 2] plan', RULE, '> A', 'idle 0m01s'], 3);
    const fKey2 = frame([RULE, '> AB', 'idle 0m01s'], 3);
    const cap = f0 + fStatic + fKey + fTick + fStatic2 + fKey2;
    const { frames } = splitFrames(cap);
    expect(frames).toHaveLength(6);
    const lens = [f0, fStatic, fKey, fTick, fStatic2, fKey2].map((x) => x.length);
    let off = 0;
    // arrivals: 500 (prologue), 1010 static, 1205 key (send at 1200), 1600 tick, 2050 static, 2310 key (send at 2300)
    const times = [500, 1010, 1205, 1600, 2050, 2310];
    const chunks: Chunk[] = lens.map((n, i) => {
      const c = { t: times[i]!, off, n };
      off += n;
      return c;
    });
    const timing = [
      { t: 1200, step: 3, op: 'send', arg: 'A', off: lens[0]! + lens[1]! },
      { t: 2300, step: 5, op: 'send', arg: 'B', off: off - lens[5]! },
    ];
    const classes = classifyFrames(frames, chunks, sendTimes(timing), 34);
    expect(classes).toEqual(['dynamic', 'static', 'key', 'dynamic', 'static', 'key']);
    expect(classCounts(classes)).toEqual({ static: 2, key: 2, dynamic: 2 });
    const fps = framesPerSecondByClass(frames, chunks, classes, 1000, 3000);
    expect(fps.all.buckets).toEqual([3, 2]);
    expect(fps.static).toMatchObject({ buckets: [1, 1], max: 1, mean: 1 });
    expect(fps.key).toMatchObject({ buckets: [1, 1], max: 1 });
    expect(fps.dynamic).toMatchObject({ buckets: [1, 0], max: 1, mean: 0.5 });
    // the index-aware filter of framesPerSecond is what the split uses
    expect(framesPerSecond(frames, chunks, 1000, 3000, (_f, i) => i === 3).buckets).toEqual([1, 0]);
    // no whole second inside the window: nothing to bucket
    expect(framesPerSecondByClass(frames, chunks, classes, 1000, 1500).dynamic).toEqual({ max: null, mean: null, buckets: [] });
  });
});

describe('toTypistSteps (drive.exp step lines → typist steps)', () => {
  it('translates every step kind, decodes send escapes, converts seconds to ms and keeps the expect timeout', () => {
    expect(decodeSendText('a\\r\\x03\\x1b\\\\b\\n')).toBe('a\r\x03\x1b\\b\n');
    expect(toTypistSteps(['expect \\x1b\\[\\?25l', '# comment', '', 'send start\\r', 'sleep 0.3', 'resize 12 120', 'mark shrunk', 'eof'], 40_000)).toEqual([
      { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 40_000 },
      { op: 'send', text: 'start\r' },
      { op: 'sleep', ms: 300 },
      { op: 'resize', rows: 12, columns: 120 },
      { op: 'mark', label: 'shrunk' },
      { op: 'eof', timeoutMs: 40_000 },
    ]);
    expect(() => toTypistSteps(['signal INT'], 1000)).toThrow(/unknown step/);
    expect(() => toTypistSteps(['resize 12'], 1000)).toThrow(/bad resize/);
  });
});
