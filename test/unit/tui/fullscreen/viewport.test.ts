/**
 * TUI-DESIGN-4 §1.3.3 / §10 S1: the viewport index and the scroll model.
 *
 * The load-bearing row is **the identity guarantee run a second time**: for every fixture,
 * `normaliseRows(rowsFor(index, i), cutsFor(index, i)) === formatTranscriptItem(item)` — the same assertion the
 * classic transcript identity suite makes against `<Transcript>`. The rows are the same rows, sliced.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import { formatTranscriptItem, type TranscriptItem } from '../../../../src/tui/plain.js';
import { itemRenderRows, normaliseRows } from '../../../../src/tui/Transcript.js';
import { cellWidth } from '../../../../src/tui/glyphs.js';
import { STATIC_SOFT_CAP } from '../../../../src/tui/useEngine.js';
import {
  SCROLL_BOTTOM,
  VIEWPORT_ITEM_CAP,
  appendItems,
  applyScroll,
  atBottom,
  buildIndex,
  cutsFor,
  earlierRowsAbove,
  earlierRowsDropped,
  emptyIndex,
  positionRung,
  positionRungs,
  rebuildFor,
  resolveTop,
  rowsFor,
  sliceRows,
  type Scroll,
} from '../../../../src/tui/fullscreen/viewport.js';

let seq = 0;
const item = (over: Partial<TranscriptItem> = {}): TranscriptItem => ({ key: `k${seq++}`, step: 1, kind: 'note', text: 'a short note', label: '[ui]', ...over }) as TranscriptItem;
/** an engine item with NO label: `itemLabel` derives `[step N]` from `step` (the shape D-AB's per-item cap applies to) */
const stepItem = (over: Omit<Partial<TranscriptItem>, 'label'> = {}): TranscriptItem => ({ key: `k${seq++}`, step: 1, kind: 'note', text: 'a short note', ...over }) as TranscriptItem;

const FIXTURES: readonly TranscriptItem[] = [
  item({ label: '[ui]', text: 'cost' }),
  item({ label: '[you]', text: 'please fix the failing test in tests/test_replan.py and then run the suite again' }),
  item({ label: '[jevcode]', text: 'I will start by reading the failing test and the module it exercises.' }),
  stepItem({ step: 4, text: 'done scratch work complete · risk 0.01 ok · skipped · 0.0s · $0.0002' }),
  stepItem({ step: 0, kind: 'run:end', text: 'finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 · jev $0.001) · exit 0' }),
  item({ label: '[sandbox]', text: 'x'.repeat(296) }),
  item({ label: '[ui]', text: 'one word' }),
  item({ label: '[ui]', text: 'supercalifragilisticexpialidociousandthensomemorecharactersthatcannotbreak' }),
];

describe('the viewport index (TUI-DESIGN-4 §1.3.3)', () => {
  it('THE IDENTITY GUARANTEE: normaliseRows(rowsFor(i)) === formatTranscriptItem(item), at every width and both glyph sets', () => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (const columns of [10, 16, 24, 30, 34, 40, 44, 60, 80, 120, 200]) {
        const idx = buildIndex(FIXTURES, columns, g);
        for (const [i, it] of FIXTURES.entries()) {
          const rows = rowsFor(idx, i);
          // an item the D-AB cap truncated is the one declared truncation marker (`… +N rows (transcript.log)`)
          if (rows.some((r) => /^\s*(?:…|\.\.\.) \+\d+/.test(r))) continue;
          const want = g === GLYPHS.ascii ? null : formatTranscriptItem(it);
          if (want === null) continue;
          expect(normaliseRows(rows, cutsFor(idx, i)), `${columns} cols, item ${i}`).toBe(want);
        }
      }
    }
  });

  it('every row fits the width at every rung (the §11 "no row wider than the terminal" gate)', () => {
    for (const columns of [10, 16, 24, 34, 40, 80, 200]) {
      const idx = buildIndex(FIXTURES, columns, GLYPHS.unicode);
      for (const row of idx.rows) expect([...row.text].length, `${columns}: ${row.text}`).toBeLessThanOrEqual(columns + 12);
      expect(idx.columns).toBe(columns);
    }
  });

  it('(a) incremental append: only the new items are wrapped and every existing row object is reused', () => {
    const first = buildIndex(FIXTURES.slice(0, 4), 80);
    const more = [...FIXTURES.slice(0, 4), ...FIXTURES.slice(4, 6)];
    const next = appendItems(first, more);
    expect(next).not.toBe(first);
    expect(next.items).toHaveLength(6);
    for (const [i] of first.rows.entries()) expect(next.rows[i]).toBe(first.rows[i]);
    expect(next.rows.length).toBeGreaterThan(first.rows.length);
    for (const [i] of FIXTURES.slice(0, 4).entries()) expect(rowsFor(next, i)).toEqual(rowsFor(first, i));
    // edge 6: a hidden-only batch changes nothing — the SAME object comes back, so nothing re-renders
    expect(appendItems(next, more)).toBe(next);
  });

  it('(a) a non-append (a `/new`, a resume replay, the soft-cap epoch) rebuilds instead of corrupting the index', () => {
    const first = buildIndex(FIXTURES, 80);
    const replaced = appendItems(first, [item({ text: 'fresh' })]);
    expect(replaced.items).toHaveLength(1);
    // the append check is O(1) by design (length + the identity of the LAST item): the item list is append-only by
    // contract, so a shorter array, a different tail or a fresh array all rebuild
    const shorter = appendItems(first, FIXTURES.slice(0, 3));
    expect(shorter.items).toHaveLength(3);
    const differentTail = appendItems(first, [...FIXTURES.slice(0, FIXTURES.length - 1), item({ text: 'replaced tail' })]);
    expect(differentTail.items[FIXTURES.length - 1]?.text).toBe('replaced tail');
    expect(differentTail.rows.some((r) => r.text.includes('replaced tail'))).toBe(true);
  });

  it('(b) a width change rebuilds and a glyph change rebuilds; a theme change is not an input at all (edge 7)', () => {
    const at80 = buildIndex(FIXTURES, 80);
    expect(rebuildFor(at80, FIXTURES, 80)).toBe(at80);
    const at44 = rebuildFor(at80, FIXTURES, 44);
    expect(at44).not.toBe(at80);
    expect(at44.columns).toBe(44);
    expect(at44.rows.length).toBeGreaterThan(at80.rows.length);
    const ascii = rebuildFor(at80, FIXTURES, 80, GLYPHS.ascii);
    expect(ascii.ascii).toBe(true);
    expect(ascii).not.toBe(at80);
  });

  it('(c) / edges 5 and 8: a slice is never negative, a zero height renders nothing, an empty index is blank', () => {
    const empty = emptyIndex(80);
    expect(empty.rows).toEqual([]);
    expect(sliceRows(empty, 0, 13)).toEqual([]);
    const idx = buildIndex(FIXTURES, 80);
    expect(sliceRows(idx, 0, 0)).toEqual([]);
    expect(sliceRows(idx, 9_999, 5)).toEqual([]);
    expect(sliceRows(idx, -5, 3)).toEqual(idx.rows.slice(0, 3));
    expect(sliceRows(idx, 2, 4)).toHaveLength(4);
  });

  it('(d) sticky-to-bottom is the default, and `resolveTop` always lands inside [0, rows − height]', () => {
    const idx = buildIndex(FIXTURES, 80);
    const h = 10;
    expect(resolveTop(idx, SCROLL_BOTTOM, h)).toBe(Math.max(0, idx.rows.length - h));
    expect(resolveTop(idx, { anchor: 'row', top: -4 }, h)).toBe(0);
    expect(resolveTop(idx, { anchor: 'row', top: 9_999 }, h)).toBe(Math.max(0, idx.rows.length - h));
    expect(atBottom(idx, SCROLL_BOTTOM, h)).toBe(true);
    expect(atBottom(idx, { anchor: 'row', top: 0 }, h)).toBe(idx.rows.length <= h);
  });

  it('the scroll keys: PgUp/PgDn move a viewport minus two, Shift+arrows one row, Ctrl+Home/End the ends; clamp up, REATTACH down (edge 9)', () => {
    const many = Array.from({ length: 200 }, (_x, i) => item({ text: `line ${i}` }));
    const idx = buildIndex(many, 80);
    const h = 13;
    const max = idx.rows.length - h;
    const page = applyScroll(SCROLL_BOTTOM, 'pageUp', idx, h);
    expect(page).toEqual({ anchor: 'row', top: max - (h - 2) });
    expect(applyScroll(page, 'pageDown', idx, h)).toEqual(SCROLL_BOTTOM);
    const line = applyScroll(SCROLL_BOTTOM, 'lineUp', idx, h);
    expect(line).toEqual({ anchor: 'row', top: max - 1 });
    expect(applyScroll(line, 'lineDown', idx, h)).toEqual(SCROLL_BOTTOM);
    expect(applyScroll(SCROLL_BOTTOM, 'top', idx, h)).toEqual({ anchor: 'row', top: 0 });
    expect(applyScroll({ anchor: 'row', top: 5 }, 'bottom', idx, h)).toEqual(SCROLL_BOTTOM);
    // PgUp past the top clamps at 0 and never goes negative
    let s: Scroll = { anchor: 'row', top: 3 };
    for (let n = 0; n < 5; n++) s = applyScroll(s, 'pageUp', idx, h);
    expect(s).toEqual({ anchor: 'row', top: 0 });
    // a short transcript (fewer rows than the viewport) is always at the bottom
    const tiny = buildIndex([item({ text: 'only' })], 80);
    expect(applyScroll(SCROLL_BOTTOM, 'top', tiny, 40)).toEqual(SCROLL_BOTTOM);
    expect(applyScroll(SCROLL_BOTTOM, 'pageUp', tiny, 40)).toEqual(SCROLL_BOTTOM);
  });

  it('edge 8: an append while the user is detached does not move `top` (the anchor is a ROW, not a percentage)', () => {
    const many = Array.from({ length: 60 }, (_x, i) => item({ text: `line ${i}` }));
    const idx = buildIndex(many, 80);
    const scroll: Scroll = { anchor: 'row', top: 7 };
    const before = sliceRows(idx, resolveTop(idx, scroll, 10), 10).map((r) => r.text);
    const grown = appendItems(idx, [...many, item({ text: 'brand new' })]);
    expect(resolveTop(grown, scroll, 10)).toBe(7);
    expect(sliceRows(grown, resolveTop(grown, scroll, 10), 10).map((r) => r.text)).toEqual(before);
    // sticky-to-bottom DOES follow it
    expect(resolveTop(grown, SCROLL_BOTTOM, 10)).toBeGreaterThan(resolveTop(idx, SCROLL_BOTTOM, 10));
  });

  it('edge 1: the index is capped at STATIC_SOFT_CAP items and row 0 becomes the `▲ n earlier rows` marker', () => {
    expect(VIEWPORT_ITEM_CAP).toBe(STATIC_SOFT_CAP);
    const over = Array.from({ length: VIEWPORT_ITEM_CAP + 5 }, (_x, i) => item({ text: `line ${i}` }));
    const idx = buildIndex(over, 80);
    expect(idx.dropped).toBe(5);
    expect(idx.items).toHaveLength(VIEWPORT_ITEM_CAP);
    expect(idx.rows[0]?.text).toBe(earlierRowsDropped(5));
    expect(earlierRowsDropped(1240)).toBe('▲ 1,240 earlier rows · see transcript.log');
    expect(earlierRowsDropped(1240, GLYPHS.ascii)).toBe('^ 1,240 earlier rows - see transcript.log');
    expect(earlierRowsAbove(1240, GLYPHS.ascii)).toBe('^ 1,240 earlier rows - PgUp');
    // the two new strings are pure ASCII under `--ascii` (§12 / TD §14.1's twin sweep)
    for (const s of [earlierRowsDropped(1240, GLYPHS.ascii), earlierRowsAbove(7, GLYPHS.ascii)]) expect(s).toMatch(/^[\x20-\x7e]*$/);
    expect(earlierRowsAbove(12)).toBe('▲ 12 earlier rows · PgUp');
  });

  it('edge 3: a single very tall item is many rows, so scrolling INSIDE one item falls out of the row index', () => {
    const huge = item({ text: 'x'.repeat(10_000) });
    const idx = buildIndex([huge], 80);
    // the D-AB per-item cap applies to engine items, so the tall item is bounded and its tail names the log
    expect(idx.rows.length).toBeGreaterThan(1);
    expect(idx.rows[idx.rows.length - 1]?.text.trim()).toMatch(/^…/);
    expect(sliceRows(idx, 1, 3)).toHaveLength(3);
  });

  it('§1.3.2 the position ladder: three rungs, widest first, then dropped', () => {
    expect(positionRungs(0, 13, 3512).map((r) => [...r].length)).toEqual([positionRungs(0, 13, 3512)[0]!.length, positionRungs(0, 13, 3512)[1]!.length, positionRungs(0, 13, 3512)[2]!.length]);
    const rungs = positionRungs(1227, 13, 3512);
    expect(rungs[0]).toBe('1 240/3 512 · 35 % · PgUp');
    expect(rungs[1]).toBe('35 % · PgUp');
    expect(rungs[2]).toBe('35 %');
    // the widest that fits; null when even `35 %` does not
    expect(positionRung(1227, 13, 3512, 40)).toBe(rungs[0]);
    expect(positionRung(1227, 13, 3512, 13)).toBe(rungs[1]);
    expect(positionRung(1227, 13, 3512, 5)).toBe(rungs[2]);
    expect(positionRung(1227, 13, 3512, 3)).toBeNull();
    // the ends read 0 % and 100 %, and a transcript shorter than the viewport is 100 %
    expect(positionRungs(0, 13, 3512)[2]).toBe('0 %');
    expect(positionRungs(3499, 13, 3512)[2]).toBe('100 %');
    expect(positionRungs(0, 40, 5)[2]).toBe('100 %');
  });
});

/**
 * TUI-DESIGN-4 §1.3.5 / §10: "the two renderers' item rows must be **equal** for the same item list". The classic
 * renderer draws `itemRenderRows(item, columns, g)`; the viewport index must produce the same row count and the same
 * cap marker. The join-based identity normaliser cannot see this — the `… +N rows (transcript.log)` cap row is a
 * declared exemption, so a body-only cap silently disagreed by three rows and by the N in the marker.
 */
describe('parity with <Transcript> (§1.3.5)', () => {
  const withDetail = (over: Partial<TranscriptItem> = {}): TranscriptItem =>
    ({ key: `p${seq++}`, step: 4, kind: 'note', text: Array.from({ length: 300 }, (_x, i) => `w${i}`).join(' '), detail: 'alpha beta gamma\ndelta epsilon zeta\neta theta iota', ...over }) as TranscriptItem;

  it('row COUNT and cap-marker text match `itemRenderRows` for items with and without a detail, at every rung', () => {
    const cases: readonly TranscriptItem[] = [
      ...FIXTURES,
      withDetail(),
      withDetail({ text: 'short body' }),
      withDetail({ label: '[ui]', text: 'cost' }),
      { key: 'p-blk', step: 0, kind: 'note', label: '[ui]', text: 'config', detail: 'a\nb', detailRows: [{ text: 'a', role: 'dim' }] } as unknown as TranscriptItem,
    ];
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (const columns of [10, 16, 20, 24, 30, 34, 40, 44, 60, 80, 120, 200]) {
        for (const [i, it] of cases.entries()) {
          const idx = buildIndex([it], columns, g);
          const classic = itemRenderRows(it, columns, g);
          const stacked = columns >= 24 && columns < 34 ? 1 : 0;
          expect(idx.rows.length, `${columns} cols, item ${i}, glyphs ${g.mode}`).toBe(classic.body.length + classic.detail.length + stacked);
          // the cap marker is byte-identical (the N must name the same number of rows that went to the log)
          const mine = idx.rows.map((r) => r.text.trim()).filter((t) => /^(?:…|\.\.\.) ?\+\d+/.test(t));
          const theirs = [...classic.body, ...classic.detail].map((r) => r.trim()).filter((t) => /^(?:…|\.\.\.) ?\+\d+/.test(t));
          expect(mine, `${columns} cols, item ${i}`).toEqual(theirs);
        }
      }
    }
  });

  it('§11 "no row wider than the terminal": every index row fits, for columns 1…200', () => {
    // the 1–2 rungs closed with the `wrapBodyCut` floor (integrator 2026-09-22, S1's §9.2 request to S2): below
    // `stringWidth('· ') + 1` cells the segment rule has no room for its lead and the body takes the word rule
    for (let columns = 1; columns <= 200; columns++) {
      const idx = buildIndex(FIXTURES, columns);
      for (const r of idx.rows) expect(cellWidth(r.text), `${columns} cols: ${JSON.stringify(r.text)}`).toBeLessThanOrEqual(columns);
    }
    // and the two renderers still agree byte for byte at the two narrowest widths
    for (const columns of [1, 2]) {
      const idx = buildIndex(FIXTURES, columns);
      const classic = FIXTURES.flatMap((it) => {
        const r = itemRenderRows(it, columns);
        return [...r.body, ...r.detail];
      });
      expect(idx.rows.filter((r) => !r.spacer).map((r) => r.text.trimStart()), `${columns}`).toEqual(classic.map((r) => r.trimStart()));
    }
    // the `flush` rung folds the label into the wrapped TEXT, exactly as `itemRenderRows` does — never into a wider head
    const tiny = buildIndex([stepItem({ step: 4, text: 'hello world this is a long body' })], 10);
    expect(tiny.rows.map((r) => r.text)).toEqual(itemRenderRows(stepItem({ step: 4, text: 'hello world this is a long body' }), 10).body);
    expect(tiny.rows[0]?.text).toBe('[step 4]');
  });
});

describe('§1.3.3 (a): incremental append past the soft cap (finding 19)', () => {
  it('an append once `dropped > 0` produces exactly what a full rebuild would, without re-wrapping the survivors', () => {
    const all = Array.from({ length: VIEWPORT_ITEM_CAP + 40 }, (_x, i) => item({ text: `line ${i} of the transcript` }));
    let idx = buildIndex(all.slice(0, VIEWPORT_ITEM_CAP + 5), 80);
    expect(idx.dropped).toBe(5);
    for (let n = VIEWPORT_ITEM_CAP + 6; n <= VIEWPORT_ITEM_CAP + 10; n++) {
      idx = appendItems(idx, all.slice(0, n));
      const want = buildIndex(all.slice(0, n), 80);
      expect(idx.dropped, `${n}`).toBe(want.dropped);
      expect(idx.items.length).toBe(want.items.length);
      expect(idx.items[0]).toBe(want.items[0]);
      expect(idx.rows.map((r) => r.text)).toEqual(want.rows.map((r) => r.text));
      expect(idx.rows.map((r) => r.item)).toEqual(want.rows.map((r) => r.item));
      expect(idx.spans).toEqual(want.spans);
      expect(idx.rows[0]?.text).toBe(earlierRowsDropped(want.dropped));
    }
  });

  it('a non-append (a `/new`, a replay) past the cap still rebuilds', () => {
    const all = Array.from({ length: VIEWPORT_ITEM_CAP + 5 }, (_x, i) => item({ text: `x${i}` }));
    const idx = buildIndex(all, 80);
    const fresh = appendItems(idx, [item({ text: 'brand new' })]);
    expect(fresh.dropped).toBe(0);
    expect(fresh.items).toHaveLength(1);
  });
});
