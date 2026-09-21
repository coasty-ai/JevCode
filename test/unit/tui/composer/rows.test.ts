/**
 * TUI-DESIGN §4.2, §19.0 (`rows.test.ts`): `layoutRows` / `cursorToRowX` / `viewport` / `maskSpans` keep widths; rows
 * partition the text; never split a grapheme or a chip; 12,000-char draft ≤ 2 ms (asserted at 3× = 6 ms).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GUTTER, MASK_GLYPH, MASK_GLYPH_ASCII, WRAP_LOOKBACK_CELLS, cursorToRowX, layoutRows, maskSpans, rowOfCursor, textUnits, viewport, type Row } from '../../../../src/tui/composer/rows.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { INSERT_POOL, bestMs, boundarySet, medianMs, mulberry32, pick } from './helpers.js';

/** Rows joined back: hard rows contribute their '\n' (except the last), soft rows nothing — the design's "text modulo wraps". */
function joinRows(text: string, rows: readonly Row[]): string {
  let out = '';
  rows.forEach((r, i) => {
    out += text.slice(r.start, r.end);
    if (r.hard && i < rows.length - 1) out += '\n';
  });
  return out;
}

function assertPartition(text: string, rows: readonly Row[], width: number): void {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]?.start).toBe(0);
  expect(rows[rows.length - 1]?.end).toBe(text.length);
  expect(rows[rows.length - 1]?.hard).toBe(true);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const next = rows[i + 1];
    if (r === undefined) continue;
    expect(r.end).toBeGreaterThanOrEqual(r.start);
    expect(r.cells).toBe(stringWidth(text.slice(r.start, r.end)));
    if (next !== undefined) expect(next.start).toBe(r.hard ? r.end + 1 : r.end);
    if (r.hard && r.end < text.length) expect(text[r.end]).toBe('\n');
    if (!r.hard) expect(r.end).toBeGreaterThan(r.start);
    // width bound: a row only exceeds it when one over-wide unit follows nothing but zero-width units
    if (r.cells > width) {
      const units = textUnits(text, r.start, r.end);
      expect(units.filter((u) => u.cells > 0).length).toBe(1);
    }
  }
  expect(joinRows(text, rows)).toBe(text);
}

describe('layoutRows', () => {
  it('empty text is one empty hard row; plain lines are hard rows', () => {
    expect(layoutRows('', 80)).toEqual([{ start: 0, end: 0, hard: true, cells: 0 }]);
    expect(layoutRows('abc', 80)).toEqual([{ start: 0, end: 3, hard: true, cells: 3 }]);
    expect(layoutRows('a\nb', 80)).toEqual([
      { start: 0, end: 1, hard: true, cells: 1 },
      { start: 2, end: 3, hard: true, cells: 1 },
    ]);
    expect(layoutRows('\n', 80)).toEqual([
      { start: 0, end: 0, hard: true, cells: 0 },
      { start: 1, end: 1, hard: true, cells: 0 },
    ]);
    expect(layoutRows('a\n\nb', 80).length).toBe(3);
  });

  it('soft-wraps at columns − gutter, breaking after the last space within 20 cells', () => {
    const rows = layoutRows('hello world foo', 10); // width 8
    expect(rows.map((r) => 'hello world foo'.slice(r.start, r.end))).toEqual(['hello ', 'world ', 'foo']);
    expect(rows.map((r) => r.hard)).toEqual([false, false, true]);
    expect(rows.map((r) => r.cells)).toEqual([6, 6, 3]);
  });

  it('breaks inside a word when no space sits in the last 20 cells', () => {
    const text = 'a ' + 'x'.repeat(50);
    const rows = layoutRows(text, 32); // width 30
    expect(rows[0]?.end).toBe(30); // the space is 28 cells back → beyond the look-back window → hard cut at width
    expect(rows.length).toBe(2);
    expect(WRAP_LOOKBACK_CELLS).toBe(20);
    const near = 'word ' + 'y'.repeat(10) + ' ' + 'z'.repeat(20);
    const r2 = layoutRows(near, 22); // width 20; the space after the y's is within 20 cells of the wrap point
    expect(near.slice(r2[0]?.start ?? 0, r2[0]?.end ?? 0)).toBe('word yyyyyyyyyy ');
  });

  it('never splits a grapheme and counts wide cells', () => {
    const text = '日本語テキスト'; // 7 × 2 cells
    const rows = layoutRows(text, 7); // width 5 → 2 clusters per row
    expect(rows.map((r) => text.slice(r.start, r.end))).toEqual(['日本', '語テ', 'キス', 'ト']);
    const fam = '👨\u200d👩\u200d👧\u200d👦'.repeat(3);
    const r2 = layoutRows(fam, 5); // width 3 → one family (2 cells) per row
    expect(r2.length).toBe(3);
    for (const r of r2) expect(boundarySet(fam).has(r.start) && boundarySet(fam).has(r.end)).toBe(true);
    const combining = 'e\u0301'.repeat(10);
    const r3 = layoutRows(combining, 6); // width 4
    for (const r of r3) expect(r.start % 2).toBe(0);
  });

  it('never splits an atom (chip label) and gives an over-wide unit its own row', () => {
    const label = '[Pasted #1, 12 lines]';
    const text = `see ${label} now`;
    const start = text.indexOf(label);
    const rows = layoutRows(text, 12, 2, { atoms: [{ start, end: start + label.length }] });
    for (const r of rows) {
      const inside = r.end > start && r.end < start + label.length;
      expect(inside).toBe(false);
      const startsInside = r.start > start && r.start < start + label.length;
      expect(startsInside).toBe(false);
    }
    expect(rows.some((r) => text.slice(r.start, r.end) === label)).toBe(true);
    // overlapping / unsorted / degenerate atoms are normalised
    const r2 = layoutRows(text, 12, 2, { atoms: [{ start: 5, end: 3 }, { start: start + 3, end: start + 8 }, { start, end: start + label.length }, { start: Number.NaN, end: 4 }] });
    expect(joinRows(text, r2)).toBe(text);
  });

  it('counts control code units as 0 cells like stringWidth, on the ASCII fast path and the unit walk alike', () => {
    for (const text of ['a\tb', 'a\rb', 'a\u007fb', '\t\t', 'x\u0000y', 'tab\tsep\tcols']) {
      const rows = layoutRows(text, 80);
      expect(rows.length).toBe(1);
      expect(rows[0]?.cells).toBe(stringWidth(text));
      // the same line forced through the unit walk (an atom makes the fast path ineligible) must agree
      const walked = layoutRows(text, 80, 2, { atoms: [{ start: 0, end: 1 }] });
      expect(walked[0]?.cells).toBe(stringWidth(text));
      expect(cursorToRowX(rows, text, text.length).x).toBe(stringWidth(text));
    }
    expect(layoutRows('a\tb', 80)[0]?.cells).toBe(2);
  });

  it('handles tiny, zero, negative, NaN and huge widths', () => {
    const text = 'ab cd';
    expect(layoutRows(text, 1).length).toBe(5); // width clamps to 1
    expect(layoutRows(text, 0).length).toBe(5);
    expect(layoutRows(text, -5).length).toBe(5);
    expect(layoutRows(text, Number.NaN).length).toBe(1); // non-finite columns → 80
    expect(layoutRows(text, Number.POSITIVE_INFINITY).length).toBe(1);
    expect(layoutRows(text, 1e9).length).toBe(1);
    expect(layoutRows(text, 10, Number.NaN).length).toBe(1);
    expect(layoutRows(text, 10, -4).length).toBe(1); // gutter clamps to 0
    expect(layoutRows('日', 2).length).toBe(1); // a 2-cell grapheme on a 1-cell row still gets its row
    expect(DEFAULT_GUTTER).toBe(2);
  });

  it('partitions the text for a seeded corpus (join modulo wraps == text; width ≤ columns − gutter)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 400; i++) {
      let text = '';
      const n = Math.floor(r() * 60);
      for (let k = 0; k < n; k++) text += r() < 0.08 ? '\n' : pick(r, INSERT_POOL);
      const columns = 3 + Math.floor(r() * 40);
      const rows = layoutRows(text, columns);
      assertPartition(text, rows, Math.max(1, columns - DEFAULT_GUTTER));
      const again = layoutRows(text, columns);
      expect(again).toEqual(rows); // pure
    }
  });
});

describe('cursorToRowX', () => {
  it('maps cursors to rows and summed widths; a soft-row end belongs to the next row', () => {
    const text = 'hello world foo';
    const rows = layoutRows(text, 10);
    expect(cursorToRowX(rows, text, 0)).toEqual({ row: 0, x: 0 });
    expect(cursorToRowX(rows, text, 5)).toEqual({ row: 0, x: 5 });
    expect(cursorToRowX(rows, text, 6)).toEqual({ row: 1, x: 0 });
    expect(cursorToRowX(rows, text, 12)).toEqual({ row: 2, x: 0 });
    expect(cursorToRowX(rows, text, 15)).toEqual({ row: 2, x: 3 });
    expect(rowOfCursor(rows, text, 15)).toBe(2);
  });
  it('a hard-row end stays on its row; wide and zero-width graphemes count their cells', () => {
    const text = '日本\nab';
    const rows = layoutRows(text, 80);
    expect(cursorToRowX(rows, text, 2)).toEqual({ row: 0, x: 4 });
    expect(cursorToRowX(rows, text, 3)).toEqual({ row: 1, x: 0 });
    expect(cursorToRowX(rows, text, 5)).toEqual({ row: 1, x: 2 });
    const zw = 'a\u200bb';
    expect(cursorToRowX(layoutRows(zw, 80), zw, 3)).toEqual({ row: 0, x: 2 });
  });
  it('clamps out-of-range, NaN and empty inputs', () => {
    const text = 'abc';
    const rows = layoutRows(text, 80);
    expect(cursorToRowX(rows, text, -4)).toEqual({ row: 0, x: 0 });
    expect(cursorToRowX(rows, text, 99)).toEqual({ row: 0, x: 3 });
    expect(cursorToRowX(rows, text, Number.NaN)).toEqual({ row: 0, x: 0 });
    expect(cursorToRowX([], text, 1)).toEqual({ row: 0, x: 0 });
  });
  it('x equals the string width of the row prefix for a seeded corpus', () => {
    const r = mulberry32(5);
    for (let i = 0; i < 300; i++) {
      let text = '';
      const n = Math.floor(r() * 40);
      for (let k = 0; k < n; k++) text += r() < 0.1 ? '\n' : pick(r, INSERT_POOL);
      const columns = 4 + Math.floor(r() * 30);
      const rows = layoutRows(text, columns);
      const bs = [...boundarySet(text)];
      const cursor = pick(r, bs);
      const { row, x } = cursorToRowX(rows, text, cursor);
      const rr = rows[row];
      expect(rr).toBeDefined();
      if (rr === undefined) continue;
      expect(cursor).toBeGreaterThanOrEqual(rr.start);
      expect(cursor).toBeLessThanOrEqual(rr.end);
      expect(x).toBe(stringWidth(text.slice(rr.start, cursor)));
      expect(x).toBeLessThanOrEqual(Math.max(rr.cells, 0));
    }
  });
});

describe('viewport', () => {
  it('clamps scrollTop so the cursor row is visible', () => {
    expect(viewport(0, 3, 0)).toBe(0);
    expect(viewport(5, 3, 0)).toBe(3);
    expect(viewport(5, 3, 5)).toBe(5);
    expect(viewport(5, 3, 9)).toBe(5);
    expect(viewport(1, 3, 4)).toBe(1);
    expect(viewport(2, 3, 0)).toBe(0);
  });
  it('treats height < 1, NaN and Infinity safely and never goes negative', () => {
    expect(viewport(4, 0, 0)).toBe(4);
    expect(viewport(4, -2, 0)).toBe(4);
    expect(viewport(4, Number.NaN, 0)).toBe(4);
    expect(viewport(4, Number.POSITIVE_INFINITY, 2)).toBe(2);
    expect(viewport(Number.NaN, 3, 2)).toBe(0);
    expect(viewport(2, 3, Number.NaN)).toBe(0);
    expect(viewport(2, 3, -7)).toBe(0);
  });
});

describe('maskSpans', () => {
  it('replaces hit graphemes with • cells of equal width and leaves row widths unchanged', () => {
    const text = 'key sk-ant-abcdefghijklmnopqrstuvwxyz end';
    const rows = layoutRows(text, 80);
    const row = rows[0];
    if (row === undefined) throw new Error('row');
    const span = { start: 4, end: 4 + 'sk-ant-abcdefghijklmnopqrstuvwxyz'.length };
    const masked = maskSpans(text, row, [span]);
    expect(masked).toBe('key ' + MASK_GLYPH.repeat(span.end - span.start) + ' end');
    expect(stringWidth(masked)).toBe(row.cells);
    expect(maskSpans(text, row, [span], MASK_GLYPH_ASCII)).toContain('*'.repeat(5));
    expect(maskSpans(text, row, [])).toBe(text);
  });
  it('wide and multi-code-point graphemes mask to their cell width; spans clip to the row', () => {
    const text = 'a日👍e\u0301b\nsecond';
    const rows = layoutRows(text, 80);
    const row0 = rows[0];
    if (row0 === undefined) throw new Error('row');
    const masked = maskSpans(text, row0, [{ start: 1, end: 6 }]);
    expect(masked).toBe('a' + MASK_GLYPH.repeat(2 + 2 + 1) + 'b');
    // a span ending inside the e + U+0301 cluster still masks the whole cluster
    expect(maskSpans(text, row0, [{ start: 4, end: 5 }])).toBe('a日👍' + MASK_GLYPH + 'b');
    expect(stringWidth(masked)).toBe(row0.cells);
    // a span that spills past the row end only masks the row's part
    const row1 = rows[1];
    if (row1 === undefined) throw new Error('row');
    expect(maskSpans(text, row1, [{ start: 5, end: 12 }])).toBe(MASK_GLYPH.repeat(4) + 'nd'); // 'second' starts at 8
  });
  it('keeps widths over a seeded corpus with random spans', () => {
    const r = mulberry32(31);
    for (let i = 0; i < 300; i++) {
      let text = '';
      const n = Math.floor(r() * 30);
      for (let k = 0; k < n; k++) text += pick(r, INSERT_POOL);
      const rows = layoutRows(text, 20);
      const a = Math.floor(r() * (text.length + 1));
      const b = Math.floor(r() * (text.length + 1));
      const spans = [{ start: Math.min(a, b), end: Math.max(a, b) }];
      for (const row of rows) expect(stringWidth(maskSpans(text, row, spans))).toBe(row.cells);
    }
  });
});

describe('perf (TUI-DESIGN §18: layoutRows of a 12,000-char draft ≤ 2 ms; asserted at 3× = 6 ms, best of 7 runs)', () => {
  const WORDS = ['the', 'quick', 'fix', 'for', 'src/loop/engine.ts', 'returns', 'null', 'when', 'the', 'plan', 'is', 'stale', 'and', 'jev', 'says', 'replan'];
  /** A realistic long draft: prose with paths, some CJK, accented letters and emoji sprinkled in (≈ 12 % non-ASCII). */
  function realisticDraft(seed: number): string {
    const rr = mulberry32(seed);
    let t = '';
    while (t.length < 12000) {
      const roll = rr();
      t += roll < 0.08 ? pick(rr, ['日本語', 'café', '👍', '한글', 'naïve', '—']) : pick(rr, WORDS);
      t += rr() < 0.04 ? '\n' : ' ';
    }
    return t;
  }
  it('cold layout of a realistic 12,000-char draft stays under 6 ms; one keystroke later it is a fraction of that', () => {
    let salt = 0;
    const drafts = Array.from({ length: 8 }, (_, i) => realisticDraft(500 + i));
    const cold = bestMs(() => layoutRows(drafts[salt++ % drafts.length] ?? '', 80), 8);
    process.stdout.write(`[measured] layoutRows(12,000-char realistic draft, 80 cols) cold best ${cold.toFixed(3)} ms\n`);
    expect(cold).toBeLessThan(6);
    const base = drafts[0] ?? '';
    const warm = bestMs(() => layoutRows(base + (salt++ % 2 === 0 ? 'a' : 'b'), 80)); // one keystroke: only the last line is re-laid
    process.stdout.write(`[measured] layoutRows after one keystroke: best ${warm.toFixed(3)} ms\n`);
    expect(warm).toBeLessThan(6);
    const plain = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ').slice(0, 12000);
    const ms2 = bestMs(() => layoutRows(plain, 80));
    process.stdout.write(`[measured] layoutRows(${plain.length} ASCII chars, 80 cols) best ${ms2.toFixed(3)} ms\n`);
    expect(ms2).toBeLessThan(6);
  });
  it('worst case — a 12,000-char draft drawn from the emoji/CJK/combining fuzz pool — is reported and bounded loosely', () => {
    const r = mulberry32(12);
    const texts: string[] = [];
    for (let k = 0; k < 6; k++) {
      let t = '';
      while (t.length < 12000) t += r() < 0.05 ? '\n' : pick(r, INSERT_POOL);
      texts.push(t);
    }
    let i = 0;
    const cold = bestMs(() => layoutRows(texts[i++ % texts.length] ?? '', 80), 6);
    const med = medianMs(() => layoutRows(texts[i++ % texts.length] ?? '', 80), 5);
    process.stdout.write(`[measured] layoutRows(12,000 chars from the fuzz pool, 80 cols) cold best ${cold.toFixed(3)} ms, median ${med.toFixed(3)} ms\n`);
    expect(cold).toBeLessThan(30);
  });
});
