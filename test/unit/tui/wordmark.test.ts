/**
 * TUI-DESIGN-3 §3 / §8 S2 (`wordmark.test.ts`): `loopBand(k)` equals the §3.4 table for k = 0…16 and is null outside; every
 * pass frame changes ≤ 8 cells per row and ≤ 40 in total (colour only — the letters never change); `wordmarkFrame` rows are
 * exactly 5, each ≤ columns cells, identical between frames; the caption `◆ <version>` iff `captionFits` at grid span
 * `[58, 58 + cellWidth(caption))` (73 columns for `◆ 0.3.0`, 85 for `◆ 0.10.0-rc.1`), never inside a band span, `◆` `accent2`;
 * the tagline iff ≥ 104 columns; the `--ascii` twin is pure ASCII (`* 0.3.0`); `wordmarkWanted` is the PINNED predicate
 * (owner directive 2) over 1,000 random inputs; `wordmarkPad` / `wordmarkBoxRows` are directive 3's padding ladder;
 * the constants table.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import { OVERLAY_KINDS, type OverlayKind } from '../../../src/tui/layout.js';
import { SPLASH_HELD_MS, SWEEP_CELLS, WORDMARK, WORDMARK_CELLS, splashFrame, wordmarkOffset } from '../../../src/tui/splash.js';
import type { PanelState } from '../../../src/tui/useEngine.js';
import {
  CAPTION_GRID_CELL,
  LOOP_ATTENTIVE_MS,
  LOOP_BAND_CELLS,
  LOOP_INTERVAL_MS,
  LOOP_PASS_TICKS,
  LOOP_QUIET_AFTER_KEY_MS,
  LOOP_REST_CALM_MS,
  LOOP_REST_MS,
  LOOP_SLEEP_MS,
  LOOP_STEP_CELLS,
  TAGLINE,
  TAGLINE_MIN_COLUMNS,
  WORDMARK_MIN_COLUMNS,
  WORDMARK_MIN_ROWS,
  WORDMARK_PAD_MIN_ROWS,
  WORDMARK_PAD2_MIN_ROWS,
  WORDMARK_SHARE_MIN_ROWS,
  captionFits,
  captionText,
  loopBand,
  wordmarkBoxRows,
  wordmarkFrame,
  wordmarkPad,
  wordmarkWanted,
  type WordmarkInput,
  type WordmarkSetting,
} from '../../../src/tui/wordmark.js';

/** §3.4: k · t · band cells (inclusive) — `s = −6 + 4k`, `[max(0, s), min(56, s + 6))` */
const TABLE: readonly [number, [number, number] | null][] = [
  [0, null],
  [1, [0, 3]],
  [2, [2, 7]],
  [3, [6, 11]],
  [4, [10, 15]],
  [5, [14, 19]],
  [6, [18, 23]],
  [7, [22, 27]],
  [8, [26, 31]],
  [9, [30, 35]],
  [10, [34, 39]],
  [11, [38, 43]],
  [12, [42, 47]],
  [13, [46, 51]],
  [14, [50, 55]],
  [15, [54, 55]],
  [16, null],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the role of every cell of a row after the spans are applied (later spans win, as `SplashRow` paints them) */
function rolesOf(row: string, spans: readonly { row: number; from: number; to: number; role: string }[], r: number): (string | null)[] {
  const cells = [...row];
  const out: (string | null)[] = cells.map(() => null);
  for (const sp of spans.filter((x) => x.row === r)) for (let i = sp.from; i < sp.to && i < cells.length; i++) out[i] = sp.role;
  return out;
}

describe('the constants table (TUI-DESIGN-3 §3.4)', () => {
  it('holds the design values exactly', () => {
    expect(LOOP_INTERVAL_MS).toBe(250);
    expect(LOOP_STEP_CELLS).toBe(4);
    expect(LOOP_BAND_CELLS).toBe(SWEEP_CELLS);
    expect(LOOP_BAND_CELLS).toBe(6);
    expect(LOOP_PASS_TICKS).toBe(17);
    expect(LOOP_REST_MS).toBe(5_750);
    expect(LOOP_REST_CALM_MS).toBe(25_750);
    expect(LOOP_ATTENTIVE_MS).toBe(60_000);
    expect(LOOP_SLEEP_MS).toBe(600_000);
    expect(LOOP_QUIET_AFTER_KEY_MS).toBe(3_000);
    expect(WORDMARK_MIN_ROWS).toBe(21);
    expect(WORDMARK_SHARE_MIN_ROWS).toBe(30);
    expect(WORDMARK_PAD_MIN_ROWS).toBe(26);
    expect(WORDMARK_PAD2_MIN_ROWS).toBe(34);
    expect(WORDMARK_MIN_COLUMNS).toBe(64);
    expect(CAPTION_GRID_CELL).toBe(58);
    expect(TAGLINE_MIN_COLUMNS).toBe(104);
    expect(TAGLINE).toBe('Decisions, not strings');
    // the period arithmetic: 16 written frames in 4.0 s, then 5.75 s of rest → a 10 s period; 30 s calm; the first pass at 6,450 ms
    expect((LOOP_PASS_TICKS - 1) * LOOP_INTERVAL_MS).toBe(4_000);
    expect((LOOP_PASS_TICKS - 1) * LOOP_INTERVAL_MS + LOOP_REST_MS + LOOP_INTERVAL_MS).toBe(10_000);
    expect((LOOP_PASS_TICKS - 1) * LOOP_INTERVAL_MS + LOOP_REST_CALM_MS + LOOP_INTERVAL_MS).toBe(30_000);
    expect(700 + LOOP_REST_MS).toBe(6_450);
    expect(LOOP_INTERVAL_MS).toBeGreaterThanOrEqual(67); // ≥ any render throttle: no tick is coalesced under --fps 15
  });
});

describe('loopBand (TUI-DESIGN-3 §3.4)', () => {
  it.each(TABLE.map(([k, cells]) => ({ k, cells })))('k = $k → $cells', ({ k, cells }) => {
    const band = loopBand(k);
    if (cells === null) expect(band).toBeNull();
    else expect(band).toEqual({ from: cells[0], to: cells[1] + 1 });
  });
  it('is null outside 0..16 and for non-finite input; every band is ≤ 6 cells inside the 56-cell grid; consecutive bands overlap by 2 and advance by 4', () => {
    for (const k of [-1, 17, 18, 100, Number.NaN, Number.POSITIVE_INFINITY]) expect(loopBand(k)).toBeNull();
    let prev: { from: number; to: number } | null = null;
    for (let k = 1; k <= 15; k++) {
      const b = loopBand(k)!;
      expect(b.to - b.from).toBeLessThanOrEqual(LOOP_BAND_CELLS);
      expect(b.from).toBeGreaterThanOrEqual(0);
      expect(b.to).toBeLessThanOrEqual(WORDMARK_CELLS);
      if (prev !== null && k > 2 && k < 15) expect(b.from - prev.from).toBe(LOOP_STEP_CELLS);
      prev = b;
    }
    // the last band reaches the last cell; the clearing tick writes no band
    expect(loopBand(15)!.to).toBe(WORDMARK_CELLS);
    expect(loopBand(LOOP_PASS_TICKS - 1)).toBeNull();
  });
});

describe('wordmarkFrame (TUI-DESIGN-3 §3.4–3.5)', () => {
  const g = GLYPHS.unicode;
  it('5 rows, each ≤ columns cells, the padded WORDMARK centred; [] below 64 columns; the rows never depend on the band', () => {
    for (const columns of [64, 72, 73, 80, 100, 104, 120, 200]) {
      const f = wordmarkFrame({ columns, version: '0.3.0' });
      expect(f.rows).toHaveLength(5);
      for (const row of f.rows) expect(cellWidth(row), `${columns} cols: ${row}`).toBeLessThanOrEqual(columns);
      const off = wordmarkOffset(columns);
      for (let r = 0; r < 5; r++) expect(f.rows[r]!.startsWith(`${' '.repeat(off)}${WORDMARK[r]!.trimEnd()}`)).toBe(true);
      expect(f.rows).toEqual(wordmarkFrame({ columns, version: '0.3.0' }).rows);
    }
    expect(wordmarkFrame({ columns: 63, version: '0.3.0' }).rows).toEqual([]);
    expect(wordmarkFrame({ columns: 63, version: '0.3.0' }).spans(loopBand(6))).toEqual([]);
    expect(wordmarkFrame({ columns: Number.NaN, version: '0.3.0' }).rows).toEqual([]);
  });
  it('every pass frame is colour only: the letter cells are unchanged, ≤ 8 changed cells per row and ≤ 40 per frame vs the previous', () => {
    const f = wordmarkFrame({ columns: 80, version: '0.3.0' });
    let prev = f.rows.map((row, r) => rolesOf(row, f.spans(loopBand(0)), r));
    for (let k = 1; k < LOOP_PASS_TICKS; k++) {
      const cur = f.rows.map((row, r) => rolesOf(row, f.spans(loopBand(k)), r));
      let total = 0;
      for (let r = 0; r < 5; r++) {
        let changed = 0;
        for (let i = 0; i < cur[r]!.length; i++) if (cur[r]![i] !== prev[r]![i]) changed++;
        expect(changed, `k=${k} row ${r}`).toBeLessThanOrEqual(8);
        total += changed;
      }
      expect(total, `k=${k}`).toBeLessThanOrEqual(40);
      prev = cur;
    }
    // the band colours letters only inside the 56-cell grid; JEV accent / CODE dim outside it
    const spans6 = f.spans(loopBand(6));
    const roles = rolesOf(f.rows[0]!, spans6, 0);
    for (let i = 12 + 18; i < 12 + 24; i++) expect(roles[i]).toBe('sweep');
    expect(roles[12]).toBe('accent');
    expect(roles[12 + 17]).toBe('accent');
    expect(roles[12 + 24]).toBe('dim');
    expect(roles[12 + 55]).toBe('dim');
    // k = 1 leaves JEV's tail and CODE untouched: the band is cells 0–3 only
    const roles1 = rolesOf(f.rows[0]!, f.spans(loopBand(1)), 0);
    for (let i = 12; i < 16; i++) expect(roles1[i]).toBe('sweep');
    expect(roles1[16]).toBe('accent');
    expect(roles1[12 + 23]).toBe('dim');
    // §3.8: `spans(loopBand(16))` clears the band — no sweep span at all
    expect(f.spans(loopBand(16)).filter((sp) => sp.role === 'sweep')).toEqual([]);
    expect(f.spans(null).filter((sp) => sp.role === 'sweep')).toEqual([]);
  });
  it('caption `◆ <version>` iff captionFits: grid span [58, 58 + cells) — 73 columns for `◆ 0.3.0`, 85 for `◆ 0.10.0-rc.1`; `◆` accent2, the version dim; never inside a band', () => {
    expect(captionText('0.3.0')).toBe('◆ 0.3.0');
    expect(cellWidth(captionText('0.3.0'))).toBe(7);
    expect(cellWidth(captionText('0.10.0-rc.1'))).toBe(13);
    expect(captionFits(72, '◆ 0.3.0')).toBe(false);
    expect(captionFits(73, '◆ 0.3.0')).toBe(true);
    expect(captionFits(84, '◆ 0.10.0-rc.1')).toBe(false);
    expect(captionFits(85, '◆ 0.10.0-rc.1')).toBe(true);
    expect(captionFits(63, '◆ 0.3.0')).toBe(false);
    for (let columns = 64; columns <= 130; columns++) {
      for (const version of ['0.3.0', '0.10.0-rc.1']) {
        const caption = captionText(version);
        const f = wordmarkFrame({ columns, version });
        const off = wordmarkOffset(columns);
        const last = f.rows[4]!;
        const fits = captionFits(columns, caption);
        expect(last.includes(caption), `${columns} ${version}`).toBe(fits);
        if (fits) {
          expect([...last].slice(off + CAPTION_GRID_CELL).join('')).toBe(caption);
          const spans = f.spans(loopBand(15));
          const glyph = spans.find((sp) => sp.role === 'accent2');
          expect(glyph).toEqual({ row: 4, from: off + CAPTION_GRID_CELL, to: off + CAPTION_GRID_CELL + 1, role: 'accent2' });
          expect(spans).toContainEqual({ row: 4, from: off + CAPTION_GRID_CELL + 1, to: off + CAPTION_GRID_CELL + cellWidth(caption), role: 'dim' });
          // never inside a band: every sweep span ends at or before the grid's end (cell 56 < 58)
          for (const sp of spans.filter((x) => x.role === 'sweep')) expect(sp.to).toBeLessThanOrEqual(off + WORDMARK_CELLS);
        } else expect(f.spans(null).some((sp) => sp.role === 'accent2')).toBe(false);
      }
    }
  });
  it('the tagline `Decisions, not strings` sits two cells after the mark on row 0 iff columns ≥ 104, in dim, never in the band', () => {
    for (let columns = 64; columns <= 140; columns++) {
      const f = wordmarkFrame({ columns, version: '0.3.0' });
      const has = f.rows[0]!.includes(TAGLINE);
      expect(has, `${columns}`).toBe(columns >= TAGLINE_MIN_COLUMNS);
      if (has) {
        const off = wordmarkOffset(columns);
        expect([...f.rows[0]!].slice(off + CAPTION_GRID_CELL).join('')).toBe(TAGLINE);
        expect(f.spans(loopBand(14))).toContainEqual({ row: 0, from: off + CAPTION_GRID_CELL, to: off + CAPTION_GRID_CELL + cellWidth(TAGLINE), role: 'dim' });
        expect(cellWidth(f.rows[0]!)).toBeLessThanOrEqual(columns);
      }
    }
    // the F-W1w row 0 at 120 columns, verbatim
    expect(wordmarkFrame({ columns: 120, version: '0.3.0' }).rows[0]).toBe('                                    ██ ███████ ██    ██  ██████  ██████  ██████  ███████  Decisions, not strings');
    expect(wordmarkFrame({ columns: 120, version: '0.3.0' }).rows[4]).toBe('                                 ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0');
  });
  it('the --ascii twin is pure ASCII with the caption `* 0.3.0`; the held splash frame equals the wordmark frame in both sets', () => {
    const a = wordmarkFrame({ columns: 80, version: '0.3.0', glyphs: GLYPHS.ascii });
    for (const row of a.rows) expect(row).toMatch(/^[\x20-\x7e]*$/);
    expect(a.rows[4]).toMatch(/#  \* 0\.3\.0$/);
    expect(a.rows[3]).toBe('            ##  ## ##       ##  ##  ##      ##    ## ##   ## ##');
    for (const set of [GLYPHS.unicode, GLYPHS.ascii]) {
      const held = splashFrame(SPLASH_HELD_MS, 80, set, '0.3.0');
      const rest = wordmarkFrame({ columns: 80, version: '0.3.0', glyphs: set });
      expect(held.rows).toEqual(rest.rows);
      expect(held.spans).toEqual(rest.spans(null));
    }
    expect(g.brand).toBe('◆');
  });
});

describe('wordmarkWanted — the PINNED mark (owner directive 2)', () => {
  const base: WordmarkInput = { boxed: true, rows: 24, columns: 80, screenReader: false, panel: 'collapsed', pickerOpen: false, overlay: 'none', setting: 'sweep' };
  const PANELS: readonly PanelState[] = ['collapsed', 'open', 'full'];
  const SETTINGS: readonly WordmarkSetting[] = ['sweep', 'static', 'off'];
  /** the rule, restated: geometry ∧ ¬SR ∧ setting ≠ off, and a slot claimant only wins below `WORDMARK_SHARE_MIN_ROWS` */
  const predicate = (i: WordmarkInput): boolean => {
    if (!i.boxed || i.rows < 21 || i.columns < 64 || i.screenReader || i.setting === 'off') return false;
    const claims = i.panel !== 'collapsed' || i.pickerOpen || i.overlay === 'review';
    return !claims || i.rows >= 30;
  };

  it('the geometry gates are the only unconditional ones', () => {
    expect(wordmarkWanted(base)).toBe(true);
    expect(wordmarkWanted({ ...base, rows: 21 })).toBe(true);
    expect(wordmarkWanted({ ...base, rows: 20 })).toBe(false);
    expect(wordmarkWanted({ ...base, columns: 64 })).toBe(true);
    expect(wordmarkWanted({ ...base, columns: 63 })).toBe(false);
    expect(wordmarkWanted({ ...base, boxed: false })).toBe(false);
    expect(wordmarkWanted({ ...base, screenReader: true })).toBe(false);
    for (const setting of SETTINGS) expect(wordmarkWanted({ ...base, setting }), setting).toBe(setting !== 'off');
    expect(wordmarkWanted({ ...base, rows: Number.NaN })).toBe(false);
    expect(wordmarkWanted({ ...base, columns: Number.NaN })).toBe(false);
  });

  it('the run phase, the stream and every non-review overlay leave the mark alone (the pin)', () => {
    // there is no `run` / `postRun` input at all any more: the mark is up for the whole session
    for (const overlay of OVERLAY_KINDS) expect(wordmarkWanted({ ...base, overlay }), overlay).toBe(overlay !== 'review');
    for (const overlay of OVERLAY_KINDS) expect(wordmarkWanted({ ...base, overlay, rows: 30 }), `${overlay}@30`).toBe(true);
    expect(Object.keys(base).sort()).toEqual(['boxed', 'columns', 'overlay', 'panel', 'pickerOpen', 'rows', 'screenReader', 'setting']);
  });

  it('a panel / picker / pending review yields the mark only below WORDMARK_SHARE_MIN_ROWS', () => {
    expect(WORDMARK_SHARE_MIN_ROWS).toBe(30);
    for (const claim of [{ panel: 'open' } as const, { panel: 'full' } as const, { pickerOpen: true }, { overlay: 'review' as const }]) {
      expect(wordmarkWanted({ ...base, ...claim, rows: 29 }), `${JSON.stringify(claim)}@29`).toBe(false);
      expect(wordmarkWanted({ ...base, ...claim, rows: 30 }), `${JSON.stringify(claim)}@30`).toBe(true);
      expect(wordmarkWanted({ ...base, ...claim, rows: 60 }), `${JSON.stringify(claim)}@60`).toBe(true);
      // the geometry gates still win over the sharing rule
      expect(wordmarkWanted({ ...base, ...claim, rows: 60, columns: 63 })).toBe(false);
      expect(wordmarkWanted({ ...base, ...claim, rows: 60, screenReader: true })).toBe(false);
      expect(wordmarkWanted({ ...base, ...claim, rows: 60, setting: 'off' })).toBe(false);
    }
    for (const panel of PANELS) expect(wordmarkWanted({ ...base, panel }), panel).toBe(panel === 'collapsed');
    // at 30 rows `mark 7 + panel 6 + rule 1 + chrome 3 + composer 1 + status 1 = 19` — 11 rows of conversation
    expect(wordmarkBoxRows(30) + 6 + 1 + 3 + 1 + 1).toBe(19);
  });

  it('equals the restated predicate over 1,000 random inputs', () => {
    const rnd = mulberry32(0x0d1);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    for (let n = 0; n < 1000; n++) {
      const i: WordmarkInput = {
        boxed: rnd() < 0.8,
        rows: 8 + Math.floor(rnd() * 40),
        columns: 40 + Math.floor(rnd() * 100),
        screenReader: rnd() < 0.1,
        panel: pick(PANELS),
        pickerOpen: rnd() < 0.1,
        overlay: pick(OVERLAY_KINDS) as OverlayKind,
        setting: pick(SETTINGS),
      };
      expect(wordmarkWanted(i), JSON.stringify(i)).toBe(predicate(i));
    }
  });
});

describe('the padded branding box (owner directive 3)', () => {
  it('wordmarkPad is 0 · 1 · 2 and the box is 5 · 7 · 9 rows', () => {
    for (const rows of [0, 8, 21, 24, 25]) expect(wordmarkPad(rows), `${rows}`).toBe(0);
    for (const rows of [26, 30, 33]) expect(wordmarkPad(rows), `${rows}`).toBe(1);
    for (const rows of [34, 40, 120]) expect(wordmarkPad(rows), `${rows}`).toBe(2);
    expect(wordmarkPad(Number.NaN)).toBe(0);
    expect(wordmarkBoxRows(24)).toBe(5);
    expect(wordmarkBoxRows(26)).toBe(7);
    expect(wordmarkBoxRows(34)).toBe(9);
    // the box is always the glyph rows plus an EQUAL number of blank rows above and below
    for (let rows = 0; rows <= 60; rows++) expect(wordmarkBoxRows(rows) - 2 * wordmarkPad(rows)).toBe(5);
  });
  it('the glyph rows keep at least 4 cells of side margin from 64 columns up', () => {
    for (const columns of [64, 72, 80, 100, 120]) {
      const f = wordmarkFrame({ columns, version: '0.3.0' });
      const left = f.rows[4]!.length - f.rows[4]!.trimStart().length;
      expect(left, `${columns} left`).toBeGreaterThanOrEqual(4);
      for (const row of f.rows) expect(columns - cellWidth(row), `${columns} right`).toBeGreaterThanOrEqual(0);
    }
    // 64 columns is the tightest: (64 − 56) / 2 = 4 cells each side
    expect(wordmarkOffset(64)).toBe(4);
    expect(wordmarkOffset(80)).toBe(12);
  });
});
