/**
 * TUI-DESIGN-4 §2.6 (P-R7, D5) / §10 S2 (`src/tui/fit.ts`): `fitRung` is the one cross-slot ladder helper — the
 * review keys row, `exitConfirmRow`, the intake row, the blocking card, §4.5's three confirm ladders and §2.5's
 * minsize notice all select through it. The two properties that make it correct are pinned here: the widest rung
 * that fits is chosen (never a truncation), and a rung is measured **after** its bindings are filled, so a rebound
 * key prints the right letter *and* the rung that is selected still fits.
 */
import { describe, expect, it } from 'vitest';
import { fillRung, fitRung, fitRungIn, fitRungIndex } from '../../../src/tui/fit.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

/**
 * §2.6 / §12: the review keys ladder, verbatim, with the measured widths the glossary states. The letters are
 * `{…}` placeholders because edge 4 makes the rungs **templates** filled from the effective bindings; filled with
 * the defaults they are byte-identical to §12's five rows.
 */
const REVIEW_RUNGS: readonly string[] = [
  '[{y}] approve  [{n}] decline  [{d}] decline+note  [{e}] expand preview  [{w}]1-5 why  [esc] decline      {abort}',
  '[{y}] approve [{n}] decline [{d}] decline+note [{e}] expand [{w}]1-5 why [esc] decline',
  '[{y}] ok [{n}] no [{d}] note [{e}] expand [{w}] why [esc] decline',
  '{y} ok · {n} no · {d} note · {e} exp · {w} why · esc',
  '{y}/{n}/{d}/{e}/{w} · esc',
];
const DEFAULTS = { y: 'y', n: 'n', d: 'd', e: 'e', w: 'w', abort: '[ctrl-c] abort run' } as const;
const filled = (values: Readonly<Record<string, string | null>> = DEFAULTS): string[] => REVIEW_RUNGS.map((r) => fillRung(r, values));

describe('fitRung (TUI-DESIGN-4 §2.6, P-R7)', () => {
  it('picks the widest rung that fits, and falls back to the narrowest when nothing does', () => {
    const rungs = ['wide wide wide', 'medium', 'tiny'];
    expect(fitRung(rungs, 100)).toBe('wide wide wide');
    expect(fitRung(rungs, 14)).toBe('wide wide wide');
    expect(fitRung(rungs, 13)).toBe('medium');
    expect(fitRung(rungs, 6)).toBe('medium');
    expect(fitRung(rungs, 5)).toBe('tiny');
    expect(fitRung(rungs, 0)).toBe('tiny');
    expect(fitRung(rungs, -5)).toBe('tiny');
    expect(fitRung(rungs, Number.NaN)).toBe('tiny');
    expect(fitRung([], 40)).toBe('');
    expect(fitRungIndex([], 40)).toBe(-1);
    expect(fitRungIndex(rungs, 13)).toBe(1);
  });

  it('round-4 review finding 6: an UNBOUNDED width takes the widest rung, not the narrowest', () => {
    // §9.2 makes `fitRung` the one cross-slot helper: S4's three confirm ladders, S5's review-keys row and intake
    // row and S6's blocking card may all hand it a width with no card behind it (the flat tier, a `--plain` twin, a
    // log sink). `Infinity` means "no bound", which is the *widest* rung — and `gutter.ts`'s `cappedTailRow` has
    // always read it that way, so the two helpers must not disagree.
    const rungs = ['wide wide wide', 'medium', 'tiny'];
    expect(fitRung(rungs, Number.POSITIVE_INFINITY)).toBe('wide wide wide');
    expect(fitRungIndex(rungs, Number.POSITIVE_INFINITY)).toBe(0);
    expect(fitRung(rungs, Number.MAX_SAFE_INTEGER)).toBe('wide wide wide');
    // …and the two "no room at all" forms still land on the narrowest
    expect(fitRungIndex(rungs, Number.NEGATIVE_INFINITY)).toBe(2);
    expect(fitRungIndex(rungs, Number.NaN)).toBe(2);
  });

  it('measures cells, not characters: a CJK rung is chosen by its terminal width', () => {
    const rungs = ['日本語のキー', 'y/n'];
    expect(cellWidth('日本語のキー')).toBe(12);
    expect(fitRung(rungs, 12)).toBe('日本語のキー');
    expect(fitRung(rungs, 11)).toBe('y/n');
  });

  it('§12: the five review rungs, byte for byte, at their measured widths 113 / 76 / 55 / 42 / 15', () => {
    const rows = filled();
    expect(rows).toEqual([
      '[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run',
      '[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline',
      '[y] ok [n] no [d] note [e] expand [w] why [esc] decline',
      'y ok · n no · d note · e exp · w why · esc',
      'y/n/d/e/w · esc',
    ]);
    expect(rows.map(cellWidth)).toEqual([113, 76, 55, 42, 15]);
  });

  it('§2.6: the ladder is monotone — every rung is strictly narrower than the one above it', () => {
    const w = filled().map(cellWidth);
    for (let i = 1; i < w.length; i++) expect(w[i]!, `${i}`).toBeLessThan(w[i - 1]!);
  });

  it('D5, the measured defect: at 40 columns the card inner width is 36 and **every key is still visible**', () => {
    // PROBED before this round: `│ [y] approve [n] decline [d] decline+not… │` — `[e]`, `[w]` and `[esc]` invisible
    const row = fitRung(filled(), 40 - 4);
    expect(row).toBe('y/n/d/e/w · esc'); // the 42-cell rung needs inner ≥ 42, i.e. columns ≥ 46
    expect(cellWidth(row)).toBeLessThanOrEqual(36);
    expect(fitRung(filled(), 46 - 4)).toBe('y ok · n no · d note · e exp · w why · esc');
    // the property the defect was about: no rung of the ladder loses a key, at any width
    for (const rung of filled()) for (const key of ['y', 'n', 'd', 'e', 'w', 'esc']) expect(rung, rung).toContain(key);
    for (let columns = 20; columns <= 200; columns++) {
      const r = fitRung(filled(), columns - 4);
      for (const key of ['y', 'n', 'd', 'e', 'w', 'esc']) expect(r, `${columns}`).toContain(key);
    }
  });

  it('§2.6: the chosen rung fits the card inner width (`columns − 4`) at every width 20…200, and 15 is the floor', () => {
    const rows = filled();
    for (let columns = 20; columns <= 200; columns++) {
      const row = fitRung(rows, columns - 4);
      expect(cellWidth(row), `${columns}`).toBeLessThanOrEqual(Math.max(15, columns - 4));
      if (columns - 4 >= 15) expect(cellWidth(row), `${columns}`).toBeLessThanOrEqual(columns - 4);
    }
    // edge 6: the two re-baselining bands — 36…40 (inner 32…36) and 117…119 (inner 113…115, where rung 0 newly fits)
    expect(fitRung(rows, 117 - 4)).toBe(rows[0]);
    expect(fitRung(rows, 116 - 4)).toBe(rows[1]);
  });
});

describe('fillRung (§2.6 edge 4: a rebinding must change the letters)', () => {
  it('a rebound approve key prints the right letter and the rung is re-measured after filling', () => {
    const rebound = { ...DEFAULTS, y: 'a', n: 'r' };
    const rows = filled(rebound);
    expect(rows[2]).toBe('[a] ok [r] no [d] note [e] expand [w] why [esc] decline');
    expect(rows.map(cellWidth)).toEqual([113, 76, 55, 42, 15]);
    // a two-cell binding widens the rung, and the selection notices
    const wide = filled({ ...DEFAULTS, y: 'F1' });
    expect(cellWidth(wide[2]!)).toBe(56);
    expect(fitRung(wide, 55)).toBe(wide[3]);
    expect(fitRung(rows, 55)).toBe(rows[2]);
  });

  it('§2.6 edge 5: a `null` value drops the slot **and its trailing spaces**, so the rung is narrower, not truncated', () => {
    const noRun = fillRung(REVIEW_RUNGS[0]!, { ...DEFAULTS, abort: null });
    expect(noRun).toBe('[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline');
    expect(cellWidth(noRun)).toBe(89);
    expect(noRun).not.toContain('ctrl-c');
    // …and at a width where the full rung would not fit, the abort-less rung does
    expect(fitRung([noRun, ...filled().slice(1)], 90)).toBe(noRun);
  });

  it('an unknown placeholder is left standing (a typo is visible in a frame test, never a silent empty slot)', () => {
    expect(fillRung('[{y}] ok [{zz}] hm', { y: 'y' })).toBe('[y] ok [{zz}] hm');
  });

  it('round-4 review finding 6: a `null` slot in the MIDDLE drops its own brackets too — never `[] decline`', () => {
    // the drop unit is the slot's whole whitespace-delimited token, punctuation included, plus its trailing spaces
    expect(fillRung('[{y}] ok [{n}] decline [{e}] expand', { y: 'y', n: null, e: 'e' })).toBe('[y] ok decline [e] expand');
    expect(fillRung('[{y}] ok [{n}]', { y: 'y', n: null })).toBe('[y] ok');
    expect(fillRung('{y} ok · {n} · {d} note', { y: 'y', n: null, d: 'd' })).toBe('y ok · · d note');
    // …so the CONVENTION a rung template must follow (§2.6 edge 5's `{abort}` already does): a droppable phrase is
    // ONE placeholder, and then the whole phrase leaves with it
    expect(fillRung('[{y}] ok {decline} [{e}] expand', { y: 'y', decline: null, e: 'e' })).toBe('[y] ok [e] expand');
    expect(fillRung('[{y}] ok {decline}', { y: 'y', decline: '[n] decline' })).toBe('[y] ok [n] decline');
    // the neighbouring slots still fill: the scan is left to right and never swallows the next placeholder
    expect(fillRung('[{y}]/[{n}]/[{d}]', { y: 'y', n: 'n', d: 'd' })).toBe('[y]/[n]/[d]');
  });
});

describe('fitRungIn (§2.6 edge 2: `--ascii` uses the same letters, `·` → `-`)', () => {
  it('the twin is measured in its own glyph set', () => {
    const ascii = fitRungIn(REVIEW_RUNGS, 42, GLYPHS.ascii, DEFAULTS);
    expect(ascii).toBe('y ok - n no - d note - e exp - w why - esc');
    expect(cellWidth(ascii)).toBe(42);
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
    expect(fitRungIn(REVIEW_RUNGS, 42, GLYPHS.unicode, DEFAULTS)).toBe('y ok · n no · d note · e exp · w why · esc');
  });

  it('edge 1: the flat tier has no card, so the width is `columns` and the same ladder answers', () => {
    expect(fitRungIn(REVIEW_RUNGS, 55, GLYPHS.unicode, DEFAULTS)).toBe('[y] ok [n] no [d] note [e] expand [w] why [esc] decline');
  });
});
