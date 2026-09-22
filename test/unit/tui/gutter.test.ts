/**
 * TUI-DESIGN-4 §2.3 (D-AB) / §10 S2 (`src/tui/gutter.ts`): the three rungs of the label-gutter ladder, the body width
 * at each, the per-item row cap and its tail, and the **zero-import gate** — the module is reached by the no-Ink
 * `block/lines.ts` and by the first-frame path, so it must import nothing at all (the rule `src/provider/ids.ts`
 * states, asserted the same way).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_WIDTH_MAX,
  FLUSH_MIN_COLUMNS,
  LABEL_GUTTER,
  STACKED_MIN_COLUMNS,
  STATIC_ITEM_MAX_ROWS,
  capItemRows,
  cappedTailRow,
  cappedTailRowAscii,
  cappedTailRungs,
  isCappedTailRow,
  gutterBodyWidth,
  gutterIndent,
  gutterMode,
  rungBodyWidth,
} from '../../../src/tui/gutter.js';
import * as transcript from '../../../src/tui/Transcript.js';

const SOURCE = readFileSync(new URL('../../../src/tui/gutter.ts', import.meta.url), 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('the first-frame rule (§2.3: `block/lines.ts` is no-Ink and reaches this module)', () => {
  it('src/tui/gutter.ts contains no import statement at all', () => {
    expect(CODE).not.toMatch(/\bimport\b/);
    expect(CODE).not.toMatch(/\brequire\s*\(/);
    // an `export … from` is an import in disguise
    expect(CODE).not.toMatch(/\bfrom\s*['"]/);
  });

  it('states the rule in its own doc comment, so the next editor knows why', () => {
    expect(SOURCE).toMatch(/first-frame/i);
    expect(SOURCE).toMatch(/[Zz]ero imports/);
  });
});

describe('gutterMode (TUI-DESIGN-4 §2.3, D-AB)', () => {
  it('the three rungs and their exact boundaries', () => {
    expect([LABEL_GUTTER, STACKED_MIN_COLUMNS, FLUSH_MIN_COLUMNS, STATIC_ITEM_MAX_ROWS, BLOCK_WIDTH_MAX]).toEqual([10, 34, 24, 24, 160]);
    expect(gutterMode(34)).toBe('gutter');
    expect(gutterMode(33)).toBe('stacked');
    expect(gutterMode(24)).toBe('stacked');
    expect(gutterMode(23)).toBe('flush');
    expect(gutterMode(200)).toBe('gutter');
    expect(gutterMode(0)).toBe('flush');
  });

  it('a non-finite or negative width reads as 0 and lands on `flush` (never throws, never NaN)', () => {
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -80]) {
      expect(gutterMode(w)).toBe(w === Number.POSITIVE_INFINITY ? 'flush' : 'flush');
      expect(Number.isFinite(gutterBodyWidth(w))).toBe(true);
    }
  });
});

describe('gutterBodyWidth / gutterIndent: the rung table of §2.3', () => {
  it('gutter — `columns − max(9, label) − 1`, and a long label pushes the body by the excess', () => {
    expect(gutterBodyWidth(80, '[ui]'.length)).toBe(70);
    expect(gutterBodyWidth(80, '[jevcode]'.length)).toBe(70);
    expect(gutterBodyWidth(80, '[step 1000]'.length)).toBe(80 - 11 - 1);
    expect(gutterIndent(80, '[ui]'.length)).toBe(10);
    expect(gutterIndent(80, '[step 1000]'.length)).toBe(12);
  });

  it('stacked — the body is `columns − 2` and hangs at 2, whatever the label is', () => {
    for (let c = FLUSH_MIN_COLUMNS; c < STACKED_MIN_COLUMNS; c++) {
      expect(gutterBodyWidth(c, 20)).toBe(c - 2);
      expect(gutterIndent(c, 20)).toBe(2);
    }
  });

  it('flush — the body is the whole row and nothing is indented', () => {
    for (let c = 1; c < FLUSH_MIN_COLUMNS; c++) {
      expect(gutterBodyWidth(c, 9)).toBe(c);
      expect(gutterIndent(c, 9)).toBe(0);
    }
  });

  it('edge 1: the body width is ≥ 1 at every width 0…200 — Ink loops on a 0-cell box', () => {
    for (let c = 0; c <= 200; c++) {
      for (const label of [0, 4, 9, 11, 40]) {
        expect(gutterBodyWidth(c, label), `${c}/${label}`).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(gutterBodyWidth(c, label))).toBe(true);
      }
    }
  });

  it('the body plus its indent never exceeds the terminal above the flush rung (no row can overflow)', () => {
    for (let c = FLUSH_MIN_COLUMNS; c <= 200; c++) {
      expect(gutterBodyWidth(c, 9) + gutterIndent(c, 9), `${c}`).toBeLessThanOrEqual(c);
    }
  });
});

describe('rungBodyWidth (§3.1.2: the arithmetic of S3 `blockWidth`)', () => {
  it('the rung body width with no label, clamped to [1, 160] and never above the available width', () => {
    expect(rungBodyWidth(80)).toBe(70);
    expect(rungBodyWidth(34)).toBe(24);
    expect(rungBodyWidth(33)).toBe(31);
    expect(rungBodyWidth(24)).toBe(22);
    expect(rungBodyWidth(23)).toBe(23);
    expect(rungBodyWidth(10)).toBe(10);
    expect(rungBodyWidth(1)).toBe(1);
    expect(rungBodyWidth(0)).toBe(1);
  });

  it('§11 "block width": `max ≤ rungBodyWidth(columns) ≤ columns` for columns 1…200, and the 160-cell clamp bites', () => {
    for (let c = 1; c <= 200; c++) {
      const w = rungBodyWidth(c);
      expect(w, `${c}`).toBeGreaterThanOrEqual(1);
      expect(w, `${c}`).toBeLessThanOrEqual(Math.max(1, c));
      expect(w, `${c}`).toBeLessThanOrEqual(BLOCK_WIDTH_MAX);
    }
    expect(rungBodyWidth(400)).toBe(BLOCK_WIDTH_MAX);
  });
});

describe('the per-item row cap (§2.3, D-AB)', () => {
  const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `row ${i}`);

  it('≤ 24 rows pass through byte for byte; 25 become 23 rows plus the tail naming where the rest is', () => {
    expect(capItemRows(rows(24))).toEqual(rows(24));
    const capped = capItemRows(rows(25));
    expect(capped).toHaveLength(STATIC_ITEM_MAX_ROWS);
    expect(capped.slice(0, 23)).toEqual(rows(23));
    expect(capped.at(-1)).toBe('… +2 rows (transcript.log)');
    expect(capItemRows(rows(258)).at(-1)).toBe('… +235 rows (transcript.log)');
    expect(capItemRows(rows(258))).toHaveLength(24);
  });

  it('the `--ascii` twin of the tail, and the two builders agree on the count', () => {
    expect(cappedTailRow(7)).toBe('… +7 rows (transcript.log)');
    expect(cappedTailRowAscii(7)).toBe('... +7 rows (transcript.log)');
    expect(capItemRows(rows(30), cappedTailRowAscii).at(-1)).toBe('... +7 rows (transcript.log)');
  });

  it('round-4 review finding 8: `isCappedTailRow` requires the `+<n>` — a bare `…` / `...` row is ordinary body text', () => {
    // the predicate is the line-identity gate's SKIP rule (§2.3 Identity, §11): a row that is exactly an ellipsis is
    // common in user and tool text (a Python `...`, an elided log line) and `truncateCells(x, 1)` produces `…`, so
    // answering `true` for it would silently exempt whole items from the strongest gate this round adds
    expect(isCappedTailRow('…')).toBe(false);
    expect(isCappedTailRow('...')).toBe(false);
    expect(isCappedTailRow('… ')).toBe(false);
    expect(isCappedTailRow('… +')).toBe(false);
    // …and every rung of the ladder is still recognised, including the narrowest
    for (const ascii of [false, true]) for (const r of cappedTailRungs(9, ascii)) expect(isCappedTailRow(r), r).toBe(true);
    expect(cappedTailRungs(9).at(-1)).toBe('…+9');
    expect(cappedTailRungs(9, true).at(-1)).toBe('...+9');
    // the ladder by width: the widest rung that fits, then a last-resort cut below the narrowest (a 1–2-cell body)
    expect(cappedTailRow(9, 26)).toBe('… +9 rows (transcript.log)');
    expect(cappedTailRow(9, 25)).toBe('… +9 rows (log)');
    expect(cappedTailRow(9, 14)).toBe('… +9 rows');
    expect(cappedTailRow(9, 8)).toBe('… +9');
    expect(cappedTailRow(9, 4)).toBe('… +9');
    expect(cappedTailRow(9, 3)).toBe('…+9');
    expect(cappedTailRow(9, 2)).toBe('…+');
    expect(cappedTailRow(9, 1)).toBe('…');
    // §11 "no row wider than the terminal": the chosen tail fits its body width at every width 1…60
    for (let w = 1; w <= 60; w++) expect(cappedTailRow(123, w).length, `${w}`).toBeLessThanOrEqual(w);
    expect(cappedTailRow(9, Number.POSITIVE_INFINITY)).toBe('… +9 rows (transcript.log)');
  });

  it('the cap never returns an empty row and never drops a row below the cap', () => {
    for (let n = 0; n <= 60; n++) {
      const out = capItemRows(rows(n));
      expect(out.length).toBe(Math.min(n, STATIC_ITEM_MAX_ROWS));
      for (const r of out) expect(r).not.toBe('');
    }
  });
});

describe('Transcript.tsx re-exports every name, so no existing importer changes (§2.3)', () => {
  it('the rung, the constants and the cap are all reachable from `Transcript.js`', () => {
    expect(transcript.LABEL_GUTTER).toBe(LABEL_GUTTER);
    expect(transcript.STACKED_MIN_COLUMNS).toBe(STACKED_MIN_COLUMNS);
    expect(transcript.FLUSH_MIN_COLUMNS).toBe(FLUSH_MIN_COLUMNS);
    expect(transcript.STATIC_ITEM_MAX_ROWS).toBe(STATIC_ITEM_MAX_ROWS);
    expect(transcript.gutterMode(30)).toBe('stacked');
    expect(transcript.gutterBodyWidth(80, 4)).toBe(70);
    expect(transcript.rungBodyWidth(80)).toBe(70);
    expect(transcript.cappedTailRow(3)).toBe(cappedTailRow(3));
    expect(transcript.capItemRows(['a'])).toEqual(['a']);
  });
});
