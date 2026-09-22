/**
 * `scripts/pty/polish-check.mjs` (TUI-DESIGN-3 §9, the hero-frame checklist V1–V21) over synthetic captures: the frame grammar
 * (scrollback above the rule row, dynamic region from it; wordmark rows; wrapped `<Static>` rows), a capture that honours every
 * predicate, and one defect per predicate — an orphan continuation, a run id in the status row, `starting` beside `Type to
 * steer`, a `[block]` painted pink, a fourth colour on a row, a missing spacer, a `[ui]` detail row at column 0, scientific
 * notation, a loop banner after `[run] end`, a spinner glyph outside the accent — each named by its V number.
 */
import { describe, expect, it } from 'vitest';
import { checkPolish, paintRow, stripAnsi, type PolishResult as Result } from '../../../scripts/pty/polish-check.mjs';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
const PINK = '\x1b[38;5;211m';
const PINK2 = '\x1b[38;5;169m';
const DIM = '\x1b[2m';
const OFF = '\x1b[39m';
const RESET = '\x1b[22m';
const RULE = '─'.repeat(80);
const MARK = ['                ██ ███████ ██    ██  ██████  ██████  ██████  ███████', '                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██', '                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████', '            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██', `             ████  ███████   ████    ██████  ██████  ██████  ███████  ${PINK2}◆${OFF} ${DIM}0.3.0${RESET}`];
const HEAD = `${DIM}    [run]${RESET} jevcode session · proj | step 0/– starting\r\n`;
const console_ = (prompt: string, status: string, badge = 'jev+llm'): string[] => [`${DIM}╭─ ${RESET}${PINK}\x1b[1m${badge}${RESET}${OFF}${DIM} ${'─'.repeat(80 - 13 - badge.length - 4)} proj ─╮${RESET}`, `${DIM}│ ${RESET}${PINK}› ${OFF}${prompt}${' '.repeat(Math.max(0, 74 - stripAnsi(prompt).length))}${DIM} │${RESET}`, `${DIM}├${'─'.repeat(78)}┤${RESET}`, `${DIM}│ ${RESET}${status}${' '.repeat(Math.max(0, 76 - stripAnsi(status).length))}${DIM} │${RESET}`, `${DIM}╰${'─'.repeat(78)}╯${RESET}`];
const frame = (scroll: readonly string[], dyn: readonly string[]): string => `${BSU}\x1b[?25l${[...scroll, ...dyn].join('\r\n')}\r\n\x1b[?25h${ESU}`;
const IDLE_STATUS = 'idle                                   step 0/–  sess $0.00/10.00 ok  ? help';
const PLACEHOLDER = `${DIM}Say hi, ask a question, or describe a task…${RESET}`;
const idleDyn = (): string[] => [RULE, ...MARK, ...console_(PLACEHOLDER, IDLE_STATUS)];
const splashDyn = (): string[] => [RULE, '                ██ ▓▒░', '                ██', '                ██', '            ██  ██', '             ████', ...console_(PLACEHOLDER, IDLE_STATUS)];
const STEP = ` ${DIM}[step 1]${RESET} run $ python -m pytest -q tests/test_core.py · risk 0.00 ok\r\n          · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006`;
const YOU = `${DIM}    ${RESET}${PINK2}\x1b[1m[you]${RESET}${OFF} Fix the failing tests in tests/test_core.py without changing the\r\n          tests.`;
const BOT = `${PINK}\x1b[1m[jevcode]${RESET}${OFF} Hi. I'm ready when you are — describe a change you want in proj, or\r\n          ask what I can do.`;
const RUN_START = `${DIM}    [run]${RESET} start 20260921-212813-uo5luiq4 mode=jev-on task: Fix the failing tests\r\n          in tests/test_core.py without changing the tests.`;
const RUN_END = `${DIM}    [run]${RESET} end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025)\r\n          exit 4`;
const UI_BLOCK = `${DIM}     [ui]${RESET} stopped — replan_stop (exit 4)\r\n          run       20260921-212813-uo5luiq4\r\n          files     ~/.jevcode/runs/20260921-212813-uo5luiq4/\r\n                    (transcript.log, state.json, jevcode.log)`;
const STRIP_HEAD = '─── ▸ jev s1 · 75 decisions · risk 0.00 ok ';
const STRIP_TAIL = ' [d] [p] [t] [s] ──';
const STRIP = `${DIM}─── ${RESET}${PINK}▸ jev${OFF}${DIM} s1 · 75 decisions · risk 0.00 ok ${'─'.repeat(80 - STRIP_HEAD.length - STRIP_TAIL.length)}${STRIP_TAIL}${RESET}`;
const LIVE_STATUS = `${PINK}▓${OFF} context    step 1/40 0m05s  run $0.01/2.00 ok  sess $0.01/10.00 ok  ? help`;
const liveDyn = (): string[] => [STRIP, ...console_('\x1b[33mType to steer the next step…  Esc pauses\x1b[39m', LIVE_STATUS)];

/** a good session: prologue header, two splash frames, the settled frame, a turn, a run, the epilogue */
function goodCapture(): string {
  return HEAD + frame([], splashDyn()) + frame([], splashDyn()) + frame([], idleDyn()) + frame(['', YOU, '', BOT], idleDyn()) + frame(['', RUN_START, STEP], liveDyn()) + frame(['', RUN_END, '', UI_BLOCK], [STRIP, ...MARK, ...console_(PLACEHOLDER, '\x1b[33m\x1b[1midle exit 4\x1b[22m\x1b[39m  step 9/40 0m14s  run $0.03/2.00 ok  sess $0.03/10.00 ok  ? help')]);
}

const by = (results: Result[], id: string): Result => results.find((r) => r.id === id)!;
const failing = (results: Result[]): string[] => results.filter((r) => r.pass === false).map((r) => r.id);

describe('checkPolish over a capture that honours TUI-DESIGN-3 §9', () => {
  it('every gated predicate passes; V13 / V19 / V20 / V21 are skipped without a timing file', () => {
    const { results } = checkPolish(goodCapture(), { rows: 24, cols: 80, version: '0.3.0' });
    expect(failing(results)).toEqual([]);
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V14', 'V15', 'V16', 'V17', 'V18']) expect(by(results, id).pass, `${id}: ${by(results, id).detail}`).toBe(true);
    for (const id of ['V13', 'V19', 'V20', 'V21']) expect(by(results, id).pass).toBeNull();
    expect(by(results, 'V1').detail).toContain('11 dynamic rows');
    expect(by(results, 'V3').detail).toMatch(/^\d distinct SGR foregrounds/);
  });
  it('the frame grammar: scrollback above the rule row, the dynamic region from it, wordmark rows recognised, the prologue header counted as scrollback', () => {
    const { frames, scrollback } = checkPolish(goodCapture(), { rows: 24, cols: 80 });
    expect(frames).toHaveLength(6);
    expect(frames[0]!.scrollback).toEqual([]);
    expect(frames[0]!.dynamic).toHaveLength(11);
    expect(frames[3]!.scrollback[1]).toMatch(/^ {4}\[you\] Fix the failing tests/);
    expect(scrollback[0]).toBe('    [run] jevcode session · proj | step 0/– starting');
    expect(scrollback.filter((r) => /^ {10}/.test(r)).length).toBeGreaterThan(3);
  });
  it('paintRow tracks the foreground through 256-colour, truecolor and 16-colour SGRs, bold and dim', () => {
    const cells = paintRow(`${DIM}a${RESET}\x1b[38;5;211mb\x1b[39m\x1b[38;2;1;2;3mc\x1b[0m\x1b[35md\x1b[1me`);
    expect(cells.map((c) => [c.ch, c.fg, c.bold, c.dim])).toEqual([
      ['a', null, false, true],
      ['b', '38;5;211', false, false],
      ['c', '38;2;1;2;3', false, false],
      ['d', '35', false, false],
      ['e', '35', true, false],
    ]);
  });
});

describe('one defect per predicate (each named by its V number)', () => {
  const run = (cap: string): string[] => failing(checkPolish(cap, { rows: 24, cols: 80, version: '0.3.0' }).results);
  it('V1: no settled frame (the mark never rests) — and V2 with it', () => {
    const cap = HEAD + frame([], splashDyn()) + frame([], [RULE, ...console_(PLACEHOLDER, IDLE_STATUS)]);
    expect(run(cap)).toEqual(expect.arrayContaining(['V1', 'V2']));
  });
  it('V2: an idle frame without the mark before the first run', () => {
    const cap = HEAD + frame([], splashDyn()) + frame([], idleDyn()) + frame([], [`${DIM}─── ◆ jevcode 0.3.0 ${'─'.repeat(60)}${RESET}`, ...console_(PLACEHOLDER, IDLE_STATUS)]);
    expect(run(cap)).toContain('V2');
  });
  it('V3 / V4: an eighth foreground colour, four colours on one row', () => {
    const many = ['\x1b[31m', '\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[36m', '\x1b[37m', '\x1b[38;5;211m', '\x1b[38;5;169m'].map((c, i) => `${c}x${i}\x1b[39m`).join('');
    const cap = goodCapture() + frame([`${DIM}     [ui]${RESET} ${many}`], idleDyn());
    const f = run(cap);
    expect(f).toContain('V3');
    expect(f).toContain('V4');
  });
  it('V5: `[block]` painted pink', () => {
    const cap = goodCapture() + frame([`${DIM} [step 2]${RESET} ${PINK}risk 0.99 [block]${OFF} · blocked · 1.2s · $0.003`], idleDyn());
    expect(run(cap)).toContain('V5');
  });
  it('V6: a row wider than the terminal', () => {
    const cap = goodCapture() + frame([`${DIM}     [ui]${RESET} ${'x'.repeat(80)}`], idleDyn());
    expect(run(cap)).toContain('V6');
  });
  it('V7: an orphan continuation row (`4` alone, `ok` alone)', () => {
    const cap = goodCapture() + frame([`${DIM}    [run]${RESET} end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit\r\n          4`], idleDyn());
    expect(run(cap)).toContain('V7');
  });
  it('V8: a scrollback row outside the grammar (a label not right-aligned in the gutter)', () => {
    const cap = goodCapture() + frame([`${DIM}[ui]${RESET} mode jev+llm already`], idleDyn());
    expect(run(cap)).toContain('V8');
  });
  it('V9: a code point outside the glyph set and the prose set', () => {
    const cap = goodCapture() + frame([`${DIM}     [ui]${RESET} done ✔ really`], idleDyn());
    expect(run(cap)).toContain('V9');
  });
  it('V10: a `[you]` turn without its spacer; a `[ui]` head with detail without its spacer', () => {
    const cap = goodCapture() + frame([`${DIM}     [ui]${RESET} note`, `${PINK2}    [you]${OFF} hi`], idleDyn());
    expect(run(cap)).toContain('V10');
    const cap2 = goodCapture() + frame([`${DIM}     [ui]${RESET} note`, `${DIM}     [ui]${RESET} cost\r\n          run $0.310 of $2.000`], idleDyn());
    expect(run(cap2)).toContain('V10');
  });
  it('V11: scientific notation, a five-figure price, a `1m2s` duration', () => {
    expect(run(goodCapture() + frame([`${DIM}     [ui]${RESET} jev $0.029 for 1,204 questions (~$2.4e-5 each)`], idleDyn()))).toContain('V11');
    expect(run(goodCapture() + frame([`${DIM}     [ui]${RESET} cost $1.2345678`], idleDyn()))).toContain('V11');
    expect(run(goodCapture() + frame([`${DIM} [step 3]${RESET} run $ pytest -q · risk 0.44 [review] · declined · judge 0.50 · 1m2s · jev 1.4k`], idleDyn()))).toContain('V11');
  });
  it('V12: a run id in the status row', () => {
    const cap = goodCapture() + frame([], [RULE, ...MARK, ...console_(PLACEHOLDER, 'idle        20260921-212813-uo5luiq4        step 0/–  sess $0.00/10.00 ok  ? help')]);
    expect(run(cap)).toContain('V12');
  });
  it('V14 / V15: a whole-row coloured status, a spinner glyph outside the accent', () => {
    const whole = `\x1b[33m${IDLE_STATUS}\x1b[39m`;
    expect(run(goodCapture() + frame([], [RULE, ...MARK, ...console_(PLACEHOLDER, whole)]))).toContain('V14');
    const wrong = `\x1b[36m▓\x1b[39m thinking                             step 0/–  sess $0.00/10.00 ok  ? help`;
    expect(run(goodCapture() + frame([], [RULE, ...MARK, ...console_('\x1b[2m(thinking…)\x1b[22m', wrong)]))).toContain('V15');
    expect(run(goodCapture() + frame([], [RULE, ...MARK, ...console_('\x1b[2m(thinking…)\x1b[22m', `${PINK}▓${OFF} thinking                             step 0/–  sess $0.00/10.00 ok  ? help`)]))).not.toContain('V15');
  });
  it('V16: `starting` beside `Type to steer` in one frame', () => {
    const cap = goodCapture() + frame([], [STRIP, ...console_('\x1b[33mType to steer the next step…  Esc pauses\x1b[39m', 'starting                                step 0/–  sess $0.00/10.00 ok  ? help')]);
    expect(run(cap)).toContain('V16');
  });
  it('V17: a loop banner row in the dynamic region after `[run] end`', () => {
    const cap = goodCapture() + frame([], [STRIP, '\x1b[33mloop · patch repeated 2 of 3\x1b[39m', ...console_(PLACEHOLDER, IDLE_STATUS)]);
    expect(run(cap)).toContain('V17');
  });
  it('V18: a row after a `[ui]` head that is not indented to column 10', () => {
    const cap = goodCapture() + frame(['', `${DIM}     [ui]${RESET} cost\r\n    run $0.310 of $2.000`], idleDyn());
    expect(run(cap)).toContain('V18');
  });
  it('V19 / V20 with a timing file: the intake wait from the `-sent` / `-reply` marks, the splash and idle rates from the chunk records', () => {
    const cap = goodCapture();
    // one chunk per frame at increasing times: splash at 100 / 150, settle at 700, the turn at 3000, the run at 5000, the end at 9000
    const bsuAt: number[] = [];
    let at = cap.indexOf(BSU);
    while (at >= 0) {
      bsuAt.push(at);
      at = cap.indexOf(BSU, at + 1);
    }
    const times = [100, 150, 700, 3000, 5000, 9000];
    const chunks = bsuAt.map((off, i) => ({ t: times[i]!, op: 'chunk', off, n: (bsuAt[i + 1] ?? cap.length) - off }));
    const steps = [
      { t: 2500, step: 1, op: 'send', arg: 'hi' },
      { t: 2600, step: 2, op: 'send', arg: '\\r' },
      { t: 2600, step: 3, op: 'mark', arg: 'hi-sent' },
      { t: 3000, step: 4, op: 'mark', arg: 'hi-reply' },
    ];
    const { results } = checkPolish(cap, { rows: 24, cols: 80, version: '0.3.0', timing: { steps, chunks } });
    expect(by(results, 'V19').pass).toBe(true);
    expect(by(results, 'V19').detail).toContain('p95 400 ms over 1 intake');
    expect(by(results, 'V20').pass).toBe(true);
    // a slow intake fails V19
    const slow = checkPolish(cap, { rows: 24, cols: 80, timing: { steps: [{ t: 0, step: 1, op: 'mark', arg: 'hi-sent' }, { t: 1600, step: 2, op: 'mark', arg: 'hi-reply' }], chunks } }).results;
    expect(by(slow, 'V19').pass).toBe(false);
  });
});
