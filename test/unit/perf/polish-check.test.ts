/**
 * `scripts/pty/polish-check.mjs` (TUI-DESIGN-3 §9, the hero-frame checklist V1–V21) over synthetic captures: the frame grammar
 * (scrollback above the rule row, dynamic region from it; wordmark rows; wrapped `<Static>` rows), a capture that honours every
 * predicate, and one defect per predicate — an orphan continuation, a run id in the status row, `starting` beside `Type to
 * steer`, a `[block]` painted pink, a fourth colour on a row, a missing spacer, a `[ui]` detail row at column 0, scientific
 * notation, a loop banner after `[run] end`, a spinner glyph outside the accent — each named by its V number.
 */
import { describe, expect, it } from 'vitest';
import { RUN_END_RE, RUN_STARTED_RE, checkPolish, paintRow, runEndSelfTest, stripAnsi, v13Rows, type PolishResult as Result } from '../../../scripts/pty/polish-check.mjs';

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
/**
 * The console box, **80 cells on every row** — TUI-DESIGN-4 §2.9 P-R13's V22 is exactly the predicate that a frame
 * never mixes two widths, so a fixture whose top edge is 75 cells and whose prompt row is 78 would fail it (and
 * did, until the integrator widened them on 2026-09-22). Top edge: `╭─ ` (3) + badge + ` ` (1) + dashes +
 * ` proj ─╮` (8) = 80. Prompt and status: `│ ` (2) + body padded to 76 + ` │` (2) = 80.
 */
const console_ = (prompt: string, status: string, badge = 'jev+llm'): string[] => [`${DIM}╭─ ${RESET}${PINK}\x1b[1m${badge}${RESET}${OFF}${DIM} ${'─'.repeat(68 - badge.length)} proj ─╮${RESET}`, `${DIM}│ ${RESET}${PINK}› ${OFF}${prompt}${' '.repeat(Math.max(0, 74 - stripAnsi(prompt).length))}${DIM} │${RESET}`, `${DIM}├${'─'.repeat(78)}┤${RESET}`, `${DIM}│ ${RESET}${status}${' '.repeat(Math.max(0, 76 - stripAnsi(status).length))}${DIM} │${RESET}`, `${DIM}╰${'─'.repeat(78)}╯${RESET}`];
const frame = (scroll: readonly string[], dyn: readonly string[]): string => `${BSU}\x1b[?25l${[...scroll, ...dyn].join('\r\n')}\r\n\x1b[?25h${ESU}`;
const IDLE_STATUS = 'idle                                   step 0/–  sess $0.00/10.00 ok  ? help';
const PLACEHOLDER = `${DIM}Say hi, ask a question, or describe a task…${RESET}`;
const idleDyn = (): string[] => [RULE, ...MARK, ...console_(PLACEHOLDER, IDLE_STATUS)];
const splashDyn = (): string[] => [RULE, '                ██ ▓▒░', '                ██', '                ██', '            ██  ██', '             ████', ...console_(PLACEHOLDER, IDLE_STATUS)];
const STEP = ` ${DIM}[step 1]${RESET} run $ python -m pytest -q tests/test_core.py · risk 0.00 ok\r\n          · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006`;
const YOU = `${DIM}    ${RESET}${PINK2}\x1b[1m[you]${RESET}${OFF} Fix the failing tests in tests/test_core.py without changing the\r\n          tests.`;
const BOT = `${PINK}\x1b[1m[jevcode]${RESET}${OFF} Hi. I'm ready when you are — describe a change you want in proj, or\r\n          ask what I can do.`;
// TUI-DESIGN-4 §3.6 (D-V, G1): `started · <badge> · <task>` and `finished · <reason> · <n> steps · …` — the run id
// left the frame for the epilogue, and no row carries a `k=v` pair any more (which is what un-defers V13, §11)
const RUN_START = `${DIM}    [run]${RESET} started \u00b7 jev+llm \u00b7 Fix the failing tests in tests/test_core.py\r\n          without changing the tests.`;
const RUN_END = `${DIM}    [run]${RESET} finished \u00b7 replan_stop \u00b7 9 steps \u00b7 14s \u00b7 $0.025 (generator $0.000\r\n          \u00b7 jev $0.025) \u00b7 exit 4`;
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
  it('every gated predicate passes; V13 is gated (D-V landed); V19 / V20 / V21 are skipped without a timing file', () => {
    const { results } = checkPolish(goodCapture(), { rows: 24, cols: 80, version: '0.3.0' });
    expect(failing(results)).toEqual([]);
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V14', 'V15', 'V16', 'V17', 'V18']) expect(by(results, id).pass, `${id}: ${by(results, id).detail}`).toBe(true);
    // TUI-DESIGN-4 §11: V13 is un-deferred by D-V and now gated; V19–V21 still need a timing file
    expect(by(results, 'V13').pass).toBe(true);
    for (const id of ['V19', 'V20', 'V21']) expect(by(results, id).pass).toBeNull();
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
  /**
   * TUI-DESIGN-4 §2.9 P-R13: V22 is the torn-frame predicate — one frame, two widths. The baseline it was written
   * against is A2's `out/tear`, 4 of 24 frames carrying a box row whose right border is the truncation ellipsis
   * while the rule row is already the new width. V6 catches neither half: no row here is wider than the terminal.
   */
  it('V22: a frame whose box rows are not the width of its own rule row, and a box row ending in the ellipsis', () => {
    const narrowBox = console_(PLACEHOLDER, IDLE_STATUS).map((r) => r.replace(/─{20}/, '─'.repeat(12)));
    expect(run(HEAD + frame([], idleDyn()) + frame([], [RULE, ...MARK, ...narrowBox]))).toEqual(expect.arrayContaining(['V22']));
    const truncated = console_(PLACEHOLDER, IDLE_STATUS).map((r, i) => (i === 1 ? `${r.slice(0, -1)}…` : r));
    expect(run(HEAD + frame([], idleDyn()) + frame([], [RULE, ...MARK, ...truncated]))).toEqual(expect.arrayContaining(['V22']));
    // …and the good capture, whose every box row is its rule row's width, passes
    expect(run(goodCapture())).not.toEqual(expect.arrayContaining(['V22']));
  });

  /**
   * TUI-DESIGN-4 §2.9 P-R13 / A2 D10: V23 is "no continuation row indented past its rung's gutter" — with §3.1's
   * blocks (D-W) a kv row's value column is a legal hang past 10, so the predicate learns the columns a block's
   * own rows open at and flags only an indent that matches none of them.
   */
  it('V23: a continuation indented past the gutter and past every column of its block', () => {
    const block = `${DIM}     [ui]${RESET} status\r\n          run        none\r\n                                   stray continuation`;
    expect(run(HEAD + frame([], idleDyn()) + frame(['', block], idleDyn()))).toEqual(expect.arrayContaining(['V23']));
    // the same block with the continuation under its own value column is legal
    const ok = `${DIM}     [ui]${RESET} status\r\n          run        none at all, a value long enough to wrap\r\n                     under its own column`;
    expect(run(HEAD + frame([], idleDyn()) + frame(['', ok], idleDyn()))).not.toEqual(expect.arrayContaining(['V23']));
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

/**
 * TUI-DESIGN-4 §11 and §3.7 (the R2 guard): the two predicates round 4 changes. V13 is un-deferred by D-V and
 * gated; V17's anchor is a glyph-agnostic exported constant whose ZERO-match in a capture that demonstrably ran
 * is a hard failure, not the vacuous `no run ended in this capture` pass round 3 reported.
 */
describe('V13 / V17 after D-V (TUI-DESIGN-4 §11, §3.7)', () => {
  it('the run-frame anchors match BOTH glyph sets and refuse the round-3 grammar they replaced', () => {
    expect(runEndSelfTest()).toEqual({ ok: true, failures: [] });
    expect(RUN_END_RE.test('    [run] finished · complete · 4 steps')).toBe(true);
    expect(RUN_END_RE.test('    [run] finished - complete - 4 steps')).toBe(true);
    expect(RUN_END_RE.test('    [run] end complete steps=4')).toBe(false);
    expect(RUN_STARTED_RE.test('    [run] started - jev+llm - t')).toBe(true);
  });

  it('V13: a `k=v` pair and a ` | ` separator are caught; the allowlisted rows are not', () => {
    expect(v13Rows(['    [step 1] intent · edit · 0.82 (confidence 0.71)'])).toEqual([]);
    expect(v13Rows(['    [step 1] intent=edit p=0.82'])).toHaveLength(1);
    expect(v13Rows(['    [step 1] outcome blocked: a | b'])).toHaveLength(1);
    // the three allowlisted producers (§3.6 edge 10 plus the prologue header the inventory missed)
    expect(v13Rows(['    [run] seeded from run r1: kind=edit'])).toEqual([]);
    expect(v13Rows(['    [step 2] directive move=change_approach'])).toEqual([]);
    expect(v13Rows(['    [run] jevcode session · proj | step 0/– starting'])).toEqual([]);
    // under --ascii the console's own `|` edges are not separators
    expect(v13Rows(['| a row inside the box |'], true)).toEqual([]);
  });

  it('V13 is gated by default and skipped with `v13: false`', () => {
    const cap = goodCapture();
    expect(by(checkPolish(cap, { rows: 24, cols: 80 }).results, 'V13').pass).toBe(true);
    expect(by(checkPolish(cap, { rows: 24, cols: 80, v13: false }).results, 'V13').pass).toBeNull();
    // the same capture with one `k=v` row fails
    const bad = cap + frame(['', `${DIM}    [step 2]${RESET} intent=edit p=0.82 c=0.71`], idleDyn());
    expect(by(checkPolish(bad, { rows: 24, cols: 80 }).results, 'V13').pass).toBe(false);
  });

  it('V17: zero anchor matches in a capture whose run started AND stopped is a HARD FAILURE, never a vacuous pass', () => {
    // a capture written by a pre-D-V build: `[run] end …` is present, the round-4 anchor matches nothing
    const staleEnd = `${DIM}    [run]${RESET} end replan_stop steps=9 wall=14s`;
    const stale = HEAD + frame([], splashDyn()) + frame([], idleDyn()) + frame(['', RUN_START, STEP], liveDyn()) + frame(['', staleEnd, '', UI_BLOCK], idleDyn());
    const r = by(checkPolish(stale, { rows: 24, cols: 80, v13: false }).results, 'V17');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('the anchor is stale');
  });

  it('V17: a capture with no run at all is skipped, not passed and not failed', () => {
    const noRun = HEAD + frame([], splashDyn()) + frame([], idleDyn()) + frame(['', YOU, '', BOT], idleDyn());
    const r = by(checkPolish(noRun, { rows: 24, cols: 80 }).results, 'V17');
    expect(r.pass).toBeNull();
    expect(r.detail).toBe('no run in this capture');
  });

  /**
   * Review finding 8: the hard failure used to depend on a `[ui] stopped —` row being present too, so ANY
   * capture whose epilogue is absent — the one-shot and signal paths write it to stderr, outside the frame
   * scrollback — fell through to the same vacuous pass with different prose. The failure now depends on the
   * run having STARTED, with exactly one exemption: the driver killed the child on its timeout.
   */
  it('V17: a stale anchor fails even when the `[ui] stopped —` epilogue row is absent', () => {
    const staleEnd = `${DIM}    [run]${RESET} end replan_stop steps=9 wall=14s`;
    const noEpilogue = HEAD + frame([], splashDyn()) + frame([], idleDyn()) + frame(['', RUN_START, STEP], liveDyn()) + frame(['', staleEnd], idleDyn());
    const r = by(checkPolish(noEpilogue, { rows: 24, cols: 80, v13: false }).results, 'V17');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('the anchor is stale');
    expect(r.detail).not.toContain('although the run stopped');
    // …and the one legitimate reason a started run has no end row: the driver's timeout killed it
    const killed = by(checkPolish(noEpilogue, { rows: 24, cols: 80, v13: false, timing: { steps: [{ t: 1, step: 4, op: 'timeout' }], chunks: [] } }).results, 'V17');
    expect(killed.pass).toBeNull();
    expect(killed.detail).toContain('killed on the driver timeout');
  });

  /**
   * Review finding 7: the session-header allowlist row was spelt with a literal `·`, but `sessionHeaderItem`
   * goes out through `glyphTwin` — so V13 failed on EVERY `--ascii` capture, including round 3's V21 twin
   * sweep. The allowlist is glyph-agnostic and the self-test covers both glyph sets.
   */
  it('V13: the session-header allowlist row is glyph-agnostic (an --ascii capture is not red)', () => {
    expect(v13Rows(['    [run] jevcode session - proj | step 0/- starting'], true)).toEqual([]);
    expect(v13Rows(['    [run] jevcode session · proj | step 0/– starting'], false)).toEqual([]);
    // a row that merely looks like it is not allowlisted
    expect(v13Rows(['    [run] jevcode sessions · proj | step 0/- starting'], true)).toHaveLength(1);
  });
});
