/**
 * TUI-DESIGN-4 §1.3.2 / §10 S1 (`fullscreen/layout.test.ts`): **exhaustive** — rows 0…120 × columns
 * {0,1,39,40,63,64,79,80,119,120,199,200} × every `OverlayKind` × composer wants 1…8, asserting `total === rows`
 * (the post-condition that makes the 37-clears cliff impossible) and the yield order; plus a 1 000-case random
 * property test, the tier table of §1.3.2, its eight edge cases, and §1.3.1's refusal matrix.
 */
import { describe, expect, it } from 'vitest';
import { CAP, MIN_COLUMNS, MIN_ROWS, OVERLAY_KINDS, WORDMARK_MIN_COLUMNS, type OverlayKind } from '../../../../src/tui/layout.js';
import { wordmarkBoxRows } from '../../../../src/tui/wordmark.js';
import { FULL_HERO_MIN_ROWS, FULL_MIN_COLUMNS, FULL_MIN_ROWS, FULL_MIN_VIEWPORT_ROWS, computeFullLayout, fullscreenRefusal, type FullLayout, type FullLayoutInput } from '../../../../src/tui/fullscreen/layout.js';

const base = (over: Partial<FullLayoutInput> = {}): FullLayoutInput => ({ rows: 24, columns: 80, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, gate: 0, ...over });

const total = (l: FullLayout): number => l.header + l.rule + l.overlay + l.preview + l.viewport + l.console;

/** xorshift-ish PRNG so the property test is deterministic. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeFullLayout (TUI-DESIGN-4 §1.3.2): total === rows, exactly, for every input', () => {
  it('the constants of the table', () => {
    expect(FULL_MIN_ROWS).toBe(18);
    expect(FULL_MIN_COLUMNS).toBe(40);
    expect(FULL_HERO_MIN_ROWS).toBe(24);
    expect(FULL_MIN_VIEWPORT_ROWS).toBe(3);
  });

  it('exhaustive: rows 0…120 × 12 widths × every overlay × composer 1…8 — `total === rows` and no slot is negative', () => {
    const widths = [0, 1, 39, 40, 63, 64, 79, 80, 119, 120, 199, 200];
    // one `expect` for ~127 000 cases: the loop collects violations, so the assertion cost does not dominate the run
    const bad: string[] = [];
    let cases = 0;
    for (let rows = 0; rows <= 120; rows++) {
      for (const columns of widths) {
        for (const overlay of OVERLAY_KINDS) {
          for (let composerWant = 1; composerWant <= 8; composerWant++) {
            const l = computeFullLayout(base({ rows, columns, overlay, overlayWant: overlay === 'none' ? 0 : 9, previewWant: overlay === 'review' ? 12 : 0, composerWant, gate: composerWant % 2 === 0 ? 1 : 0 }));
            cases++;
            const at = `${rows}x${columns} ${overlay} c${composerWant}`;
            if (l.total !== rows) bad.push(`${at}: total ${l.total}`);
            if (total(l) !== rows) bad.push(`${at}: sum ${total(l)}`);
            if (l.console !== l.chrome + l.composer + l.status) bad.push(`${at}: console ${l.console}`);
            if (l.header < 0 || l.rule < 0 || l.overlay < 0 || l.preview < 0 || l.viewport < 0 || l.console < 0 || l.composer < 0 || l.status < 0) bad.push(`${at}: negative slot`);
          }
        }
      }
    }
    expect(bad.slice(0, 8)).toEqual([]);
    expect(cases).toBe(121 * 12 * OVERLAY_KINDS.length * 8);
  });

  it('1 000 random inputs (incl. non-finite and negative geometry) keep the post-condition', () => {
    const rnd = mulberry32(0x5eed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -40, 0.5, 23.7];
    for (let n = 0; n < 1000; n++) {
      const rows = rnd() < 0.1 ? pick(odd) : Math.floor(rnd() * 130);
      const columns = rnd() < 0.1 ? pick(odd) : Math.floor(rnd() * 220);
      const i = base({ rows, columns, overlay: pick(OVERLAY_KINDS), overlayWant: Math.floor(rnd() * 14), previewWant: Math.floor(rnd() * 50), expanded: rnd() < 0.2, composerWant: 1 + Math.floor(rnd() * 8), gate: rnd() < 0.3 ? 1 : 0, screenReader: rnd() < 0.1 });
      const l = computeFullLayout(i);
      const want = Number.isFinite(rows) ? Math.max(0, Math.floor(rows as number)) : 0;
      expect(l.total, JSON.stringify(i)).toBe(want);
      expect(total(l), JSON.stringify(i)).toBe(want);
    }
  });

  it('§1.3.2 the tier table: tall ≥ 24 · compact 18–23 · narrow < 64 columns', () => {
    const tall = computeFullLayout(base({ rows: 24, columns: 80 }));
    expect([tall.header, tall.rule, tall.viewport, tall.console]).toEqual([CAP.splash, 1, 24 - 11, 5]);
    expect(tall.degraded).toBe('none');
    // owner directive 3: the hero header IS the padded box — 9 rows at 40 rows, 5 at 24
    const wide = computeFullLayout(base({ rows: 40, columns: 120 }));
    expect([wide.header, wide.rule, wide.viewport, wide.console]).toEqual([wordmarkBoxRows(40), 1, 40 - 6 - wordmarkBoxRows(40), 5]);
    expect(wordmarkBoxRows(40)).toBe(9);
    for (const rows of [18, 20, 23]) {
      const l = computeFullLayout(base({ rows, columns: 80 }));
      expect([l.header, l.rule, l.viewport, l.console], `compact ${rows}`).toEqual([1, 1, rows - 7, 5]);
      expect(l.degraded).toBe('compact');
    }
    // F-H4: 20×80 is header 1 · rule 1 · viewport 13 · console 5
    expect(computeFullLayout(base({ rows: 20, columns: 80 })).viewport).toBe(13);
    // F-H5: 24×44 is header 1 · rule 1 · viewport 17 · console 5 (narrow: < 64 columns never draws the 5-row mark)
    const narrow = computeFullLayout(base({ rows: 24, columns: 44 }));
    expect([narrow.header, narrow.rule, narrow.viewport, narrow.console]).toEqual([1, 1, 17, 5]);
    expect(narrow.degraded).toBe('compact');
    expect(WORDMARK_MIN_COLUMNS).toBe(64);
  });

  it('edges 1, 2 and 8: non-finite / negative geometry is 0 and `minsize`; rows 1–2 are console only; a zero viewport is never negative', () => {
    for (const rows of [Number.NaN, -1, Number.NEGATIVE_INFINITY, 0]) {
      const l = computeFullLayout(base({ rows }));
      expect(l.total).toBe(0);
      expect(l.viewport).toBe(0);
      expect(l.degraded).toBe('minsize');
    }
    const one = computeFullLayout(base({ rows: 1 }));
    expect([one.status, one.composer, one.header, one.viewport, one.total]).toEqual([1, 0, 0, 0, 1]);
    const two = computeFullLayout(base({ rows: 2 }));
    expect([two.status, two.composer, two.header, two.viewport, two.total]).toEqual([1, 1, 0, 0, 2]);
  });

  it('edge 3: an overlay wanting more rows than the viewport has is capped — the TOTAL never grows', () => {
    for (const want of [1, 9, 40, 400]) {
      const l = computeFullLayout(base({ rows: 20, columns: 80, overlay: 'palette', overlayWant: want }));
      expect(l.total).toBe(20);
      expect(l.overlay).toBeLessThanOrEqual(want);
    }
  });

  it('edge 4 / the yield order: the header falls 5 → 1 → 0 before the viewport drops below three rows', () => {
    // a 9-row review card + its preview at 24 rows takes the header from 5 to 1
    const l = computeFullLayout(base({ rows: 24, columns: 80, overlay: 'review', overlayWant: CAP.reviewCard, previewWant: 6, composerWant: 8 }));
    expect(l.total).toBe(24);
    expect(l.header).toBeLessThan(CAP.splash);
    expect(l.viewport).toBeGreaterThanOrEqual(0);
    // as the rows run out the header is the LAST thing above the viewport to go
    const seen = new Set<number>();
    for (let rows = 3; rows <= 40; rows++) seen.add(computeFullLayout(base({ rows, columns: 80 })).header);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 5, 7, 9]);
    // whenever the header carries the mark, the viewport still has its floor and the header is the padded box
    for (let rows = 0; rows <= 120; rows++) {
      const f = computeFullLayout(base({ rows, columns: 80 }));
      if (f.header >= CAP.splash) {
        expect(f.viewport, `rows=${rows}`).toBeGreaterThanOrEqual(FULL_MIN_VIEWPORT_ROWS);
        expect(f.header, `rows=${rows}`).toBe(wordmarkBoxRows(rows));
      }
    }
  });

  it('the wizard is the input (the composer floor is refunded), and the gate row is boxed-only', () => {
    const wiz = computeFullLayout(base({ rows: 24, columns: 80, overlay: 'wizard', overlayWant: 4 }));
    expect(wiz.composer).toBe(0);
    expect(wiz.overlay).toBeGreaterThanOrEqual(1);
    expect(wiz.total).toBe(24);
    const gated = computeFullLayout(base({ rows: 24, columns: 80, overlay: 'secret', gate: 1 }));
    expect(gated.gate).toBe(1);
    expect(gated.total).toBe(24);
  });

  it('`degraded` is `minsize` below the product minimum and below the fullscreen minimum', () => {
    expect(computeFullLayout(base({ rows: 17, columns: 80 })).degraded).toBe('minsize');
    expect(computeFullLayout(base({ rows: 24, columns: 39 })).degraded).toBe('minsize');
    expect(MIN_ROWS).toBeLessThanOrEqual(FULL_MIN_ROWS);
    expect(MIN_COLUMNS).toBeLessThanOrEqual(FULL_MIN_COLUMNS);
  });
});

describe('fullscreenRefusal (TUI-DESIGN-4 §1.3.1): one note, in the table’s order', () => {
  const ok = { rows: 24, columns: 80, screenReader: false, term: 'xterm-256color' };
  it('null when it may run; otherwise §12’s exact sentence', () => {
    expect(fullscreenRefusal(ok)).toBeNull();
    expect(fullscreenRefusal({ ...ok, rows: 17 })).toBe('fullscreen needs 18 rows (now 17) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, rows: 0 })).toBe('fullscreen needs 18 rows (now 0) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, columns: 39 })).toBe('fullscreen needs 40 columns (now 39) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, screenReader: true })).toBe('fullscreen repaints the whole screen on every key; the classic renderer is used under a screen reader');
    expect(fullscreenRefusal({ ...ok, term: 'dumb' })).toBe('fullscreen needs a terminal that supports the alternate screen (TERM=dumb) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, term: 'DUMB' })).toBe('fullscreen needs a terminal that supports the alternate screen (TERM=DUMB) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, term: undefined })).toBe('fullscreen needs a terminal that supports the alternate screen (TERM=unset) — the classic renderer is used');
    expect(fullscreenRefusal({ ...ok, term: '  ' })).toBe('fullscreen needs a terminal that supports the alternate screen (TERM=unset) — the classic renderer is used');
  });
  it('rows win over columns, columns over the screen reader, the screen reader over TERM (the table’s order)', () => {
    expect(fullscreenRefusal({ rows: 10, columns: 10, screenReader: true, term: 'dumb' })).toContain('18 rows');
    expect(fullscreenRefusal({ rows: 24, columns: 10, screenReader: true, term: 'dumb' })).toContain('40 columns');
    expect(fullscreenRefusal({ rows: 24, columns: 80, screenReader: true, term: 'dumb' })).toContain('screen reader');
  });
  it('every geometry the allocator calls `minsize` is refused, and every geometry it runs is allowed', () => {
    for (let rows = 0; rows <= 40; rows++) {
      for (const columns of [0, 39, 40, 63, 64, 200]) {
        const refused = fullscreenRefusal({ rows, columns, screenReader: false, term: 'xterm' }) !== null;
        const l = computeFullLayout(base({ rows, columns, overlay: 'none' as OverlayKind }));
        expect(refused, `${rows}x${columns}`).toBe(l.degraded === 'minsize');
      }
    }
  });
});
