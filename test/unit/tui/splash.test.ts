/**
 * TUI-DESIGN-2 §5 / §8.1 S4 (`splash.test.ts`); TUI-DESIGN-3 §3.4 / §8 S2: the wordmark rows are exactly 56 cells;
 * `splashFrame(t)` gives 5 rows (0 below 64 columns, never at t ≥ 700 — the mark is held), a monotone reveal, ≤ 12 changed
 * cells per 50 ms, the H-A1 / H-A2 rows byte for byte; phases `reveal < 450 · shimmer < 550 · held` (no `fade`); the held
 * frame equals `wordmarkFrame` cell for cell with the caption, so `splash:done` writes nothing; the brand row and its
 * pulse; the `--ascii` twin; ≤ 15 frames in 700 ms by construction.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import {
  HEAD_CELLS,
  REVEAL_FLOOR_CELLS,
  SPLASH_HELD_MS,
  SPLASH_INTERVAL_MS,
  SPLASH_MS,
  SWEEP_CELLS,
  WORDMARK,
  WORDMARK_CELLS,
  WORDMARK_MIN_COLUMNS,
  WORDMARK_ROWS,
  brandGlyph,
  brandRow,
  brandSpan,
  revealedCells,
  splashFrame,
  splashPhase,
  sweepStart,
  wordmarkOffset,
} from '../../../src/tui/splash.js';
import { wordmarkFrame } from '../../../src/tui/wordmark.js';

const H_A1_80 = ['                ██ ▓▒░', '                ██ ▓▒░', '                ██ ▓▒░', '            ██  ██ ▓▒░', '             ████  ▓▒░'];
const H_A2_80 = [
  '                ██ ███████ ██    ██  ██████  ██████  █▓▒░',
  '                ██ ██      ██    ██ ██      ██    ██ █▓▒░',
  '                ██ █████   ██    ██ ██      ██    ██ █▓▒░',
  '            ██  ██ ██       ██  ██  ██      ██    ██ █▓▒░',
  '             ████  ███████   ████    ██████  ██████  █▓▒░',
];

function changedCells(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.max(x.length, y.length);
  let d = 0;
  for (let i = 0; i < n; i++) if ((x[i] ?? ' ') !== (y[i] ?? ' ')) d++;
  return d;
}

describe('WORDMARK and the schedule (TUI-DESIGN-2 §5.1, §5.2)', () => {
  it('five rows, every one exactly 56 cells; JEV ends at cell 22 and CODE starts at 24 on every row', () => {
    expect(WORDMARK.length).toBe(WORDMARK_ROWS);
    expect(WORDMARK.every((r) => cellWidth(r) === WORDMARK_CELLS)).toBe(true);
    for (const r of WORDMARK) {
      expect([...r][23]).toBe(' ');
      expect(r.slice(0, 23).includes('█')).toBe(true);
      expect(r.slice(24).includes('█')).toBe(true);
    }
    expect(SPLASH_MS).toBe(700);
    expect(SPLASH_INTERVAL_MS).toBe(50);
    expect(Math.ceil(SPLASH_MS / SPLASH_INTERVAL_MS) + 1).toBeLessThanOrEqual(15); // ≤ 15 frames in 700 ms by construction
  });
  it('TUI-DESIGN-3 §3.4: phases by time: reveal < 450, shimmer < 550, held from 550 on (no fade, no settled-empty phase)', () => {
    expect(SPLASH_HELD_MS).toBe(550);
    expect(splashPhase(0)).toBe('reveal');
    expect(splashPhase(449)).toBe('reveal');
    expect(splashPhase(450)).toBe('shimmer');
    expect(splashPhase(549)).toBe('shimmer');
    expect(splashPhase(550)).toBe('held');
    expect(splashPhase(600)).toBe('held');
    expect(splashPhase(699)).toBe('held');
    expect(splashPhase(700)).toBe('held');
    expect(splashPhase(10_000)).toBe('held');
    expect(splashPhase(Number.NaN)).toBe('reveal');
    expect(['reveal', 'shimmer', 'held']).not.toContain('fade');
  });
  it('revealedCells: the J (7) in frame 0, ⌈56·t/400⌉ afterwards (42 at 300 ms), 56 from 400 ms; monotone', () => {
    expect(revealedCells(0)).toBe(REVEAL_FLOOR_CELLS);
    expect(revealedCells(300)).toBe(42);
    expect(revealedCells(400)).toBe(56);
    expect(revealedCells(1000)).toBe(56);
    let last = 0;
    for (let t = 0; t <= 700; t += 10) {
      const r = revealedCells(t);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(sweepStart(450)).toBe(0);
    expect(sweepStart(550)).toBe(WORDMARK_CELLS - SWEEP_CELLS);
    expect(wordmarkOffset(80)).toBe(12);
    expect(wordmarkOffset(120)).toBe(32);
  });
});

describe('splashFrame (TUI-DESIGN-2 §5.1–5.3)', () => {
  it('H-A1: frame 0 at 80 and 120 columns — the J column and the ▓▒░ head, right-trimmed', () => {
    const f = splashFrame(0, 80);
    expect(f.phase).toBe('reveal');
    expect(f.rows).toEqual(H_A1_80);
    expect(splashFrame(0, 120).rows).toEqual(H_A1_80.map((r) => `${' '.repeat(20)}${r}`));
    for (const row of f.rows) expect(cellWidth(row)).toBeLessThanOrEqual(80);
    // spans: JEV accent on cells 12..19, the head as sweep on 19..22
    expect(f.spans.filter((s) => s.row === 0)).toEqual([
      { row: 0, from: 12, to: 19, role: 'accent' },
      { row: 0, from: 19, to: 22, role: 'sweep' },
    ]);
  });
  it('H-A2: frame 6 (t = 300, 42 cells) at 80 columns', () => {
    expect(splashFrame(300, 80).rows).toEqual(H_A2_80);
  });
  it('5 rows at every t ≥ 0 (≥ 64 columns) — never [] at t ≥ 700 (the mark is held); [] below 64 columns; ≤ columns cells; ≤ 12 changed cells per 50 ms tick', () => {
    for (let t = 0; t <= SPLASH_MS + 300; t += SPLASH_INTERVAL_MS) {
      const f = splashFrame(t, 80, GLYPHS.unicode, '0.3.0');
      expect(f.rows.length).toBe(WORDMARK_ROWS);
      for (const row of f.rows) expect(cellWidth(row)).toBeLessThanOrEqual(80);
      expect(splashFrame(t, 63, GLYPHS.unicode, '0.3.0').rows).toEqual([]);
      expect(splashFrame(t, WORDMARK_MIN_COLUMNS, GLYPHS.unicode, '0.3.0').rows.length).toBe(WORDMARK_ROWS);
    }
    expect(splashFrame(700, 80).phase).toBe('held');
    expect(splashFrame(5000, 80).rows.length).toBe(WORDMARK_ROWS);
    for (let t = SPLASH_INTERVAL_MS; t <= SPLASH_MS; t += SPLASH_INTERVAL_MS) {
      const a = splashFrame(t - SPLASH_INTERVAL_MS, 80, GLYPHS.unicode, '0.3.0').rows;
      const b = splashFrame(t, 80, GLYPHS.unicode, '0.3.0').rows;
      for (let r = 0; r < WORDMARK_ROWS; r++) expect(changedCells(a[r] ?? '', b[r] ?? ''), `t=${t} row ${r}`).toBeLessThanOrEqual(7 + HEAD_CELLS);
    }
  });
  it('TUI-DESIGN-3 §3.4: the held frame (t = 550, 700, 10 000) equals wordmarkFrame(…).rows with spans(null) cell for cell — splash:done writes nothing; without a version the caption is absent', () => {
    const rest = wordmarkFrame({ columns: 80, version: '0.3.0' });
    for (const t of [550, 600, 650, 700, 10_000]) {
      const f = splashFrame(t, 80, GLYPHS.unicode, '0.3.0');
      expect(f.phase).toBe('held');
      expect(f.rows).toEqual(rest.rows);
      expect(f.spans).toEqual(rest.spans(null));
    }
    expect(splashFrame(700, 80).rows[4]).toBe(`${' '.repeat(12)}${WORDMARK[4]}`.replace(/\s+$/, ''));
    expect(splashFrame(700, 80, GLYPHS.unicode, '0.3.0').rows[4]).toBe(`${' '.repeat(12)}${WORDMARK[4]}  ◆ 0.3.0`);
    // the held frame carries no head and no band: JEV accent + CODE dim on every row, the caption ◆ accent2 + version dim
    const spans = splashFrame(700, 80, GLYPHS.unicode, '0.3.0').spans;
    expect(spans.filter((sp) => sp.role === 'sweep')).toEqual([]);
    expect(spans.filter((sp) => sp.row === 0)).toEqual([
      { row: 0, from: 12, to: 35, role: 'accent' },
      { row: 0, from: 35, to: 68, role: 'dim' },
    ]);
    expect(spans.filter((sp) => sp.row === 4 && sp.from >= 70)).toEqual([
      { row: 4, from: 70, to: 71, role: 'accent2' },
      { row: 4, from: 71, to: 77, role: 'dim' },
    ]);
    // the 120-column form adds the tagline on row 0
    expect(splashFrame(700, 120, GLYPHS.unicode, '0.3.0').rows[0]).toBe(`${' '.repeat(32)}${WORDMARK[0]}  Decisions, not strings`);
  });
  it('the reveal is monotone (a revealed cell never blanks again) and the complete mark at 400 ms is the padded WORDMARK centred', () => {
    let prev = splashFrame(0, 80).rows;
    for (let t = SPLASH_INTERVAL_MS; t <= 400; t += SPLASH_INTERVAL_MS) {
      const cur = splashFrame(t, 80).rows;
      for (let r = 0; r < WORDMARK_ROWS; r++) {
        const a = [...(prev[r] ?? '')];
        const b = [...(cur[r] ?? '')];
        const edge = 12 + revealedCells(t - SPLASH_INTERVAL_MS);
        for (let i = 12; i < edge; i++) if (a[i] === '█') expect(b[i], `t=${t} row ${r} cell ${i}`).toBe('█');
      }
      prev = cur;
    }
    expect(splashFrame(400, 80).rows).toEqual(WORDMARK.map((r) => `${' '.repeat(12)}${r}`.replace(/\s+$/, '')));
  });
  it('shimmer: a 6-cell sweep band moves left → right over 450–549; from 550 the mark is held — JEV keeps its accent, no fade ever', () => {
    const s0 = splashFrame(450, 80);
    expect(s0.phase).toBe('shimmer');
    const band0 = s0.spans.filter((s) => s.role === 'sweep' && s.row === 0);
    expect(band0).toEqual([{ row: 0, from: 12, to: 18, role: 'sweep' }]);
    const s1 = splashFrame(549, 80);
    expect(s1.phase).toBe('shimmer');
    expect(s1.spans.filter((s) => s.role === 'sweep' && s.row === 0)).toEqual([{ row: 0, from: 12 + 50, to: 12 + 56, role: 'sweep' }]);
    for (const t of [550, 600, 650, 700]) {
      const f = splashFrame(t, 80);
      expect(f.phase).toBe('held');
      expect(f.spans.filter((s) => s.role === 'sweep')).toEqual([]);
      expect(f.spans.filter((s) => s.row === 0)).toEqual([
        { row: 0, from: 12, to: 12 + 23, role: 'accent' },
        { row: 0, from: 12 + 23, to: 12 + 56, role: 'dim' },
      ]);
    }
  });
  it('the --ascii twin draws # letters with a # + . head, the caption `* 0.3.0`, and is pure ASCII', () => {
    const f = splashFrame(0, 80, GLYPHS.ascii);
    expect(f.rows[3]).toBe('            ##  ## #+.');
    for (let t = 0; t <= SPLASH_MS; t += 50) for (const row of splashFrame(t, 80, GLYPHS.ascii, '0.3.0').rows) expect(row).toMatch(/^[\x20-\x7e]*$/);
    expect(splashFrame(700, 80, GLYPHS.ascii, '0.3.0').rows[4]).toMatch(/#  \* 0\.3\.0$/);
  });
});

describe('brandRow (TUI-DESIGN-2 §5.4)', () => {
  it('H-A3: `─── ◆ jevcode 0.2.0 ───…` exactly columns cells; the one-line pulse ░ ▒ ▓ ◆ twice over 400 ms; the ascii twin', () => {
    expect(brandRow('0.2.0', 80)).toBe('─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────');
    expect(cellWidth(brandRow('0.2.0', 120))).toBe(120);
    expect(brandRow('0.2.0', 40, null)).toBe(`─── ◆ jevcode 0.2.0 ${'─'.repeat(20)}`);
    expect([0, 50, 100, 150, 200, 250, 300, 350].map((t) => brandGlyph(t))).toEqual(['░', '▒', '▓', '◆', '░', '▒', '▓', '◆']);
    expect(brandGlyph(400)).toBe('◆');
    expect(brandGlyph(null)).toBe('◆');
    expect(brandRow('0.2.0', 40, 50)).toBe(`─── ▒ jevcode 0.2.0 ${'─'.repeat(20)}`);
    expect(brandRow('0.2.0', 40, 700)).toBe(brandRow('0.2.0', 40, null));
    expect(brandRow('0.2.0', 40, null, GLYPHS.ascii)).toBe(`--- * jevcode 0.2.0 ${'-'.repeat(20)}`);
  });
  it('finding 10: brandSpan covers `<glyph> jevcode <version>` for every pulse glyph (░ ▒ ▓ ◆) and the ascii twins; null on a strip or a plain rule', () => {
    for (const t of [0, 50, 100, 150, null]) {
      const row = brandRow('0.2.0', 80, t);
      const span = brandSpan(row);
      expect(span).not.toBeNull();
      expect(row.slice(span!.from, span!.to)).toBe(`${brandGlyph(t)} jevcode 0.2.0`);
      expect(span!.from).toBe(4);
    }
    for (const t of [0, 50, 100, null]) {
      const row = brandRow('0.2.0', 80, t, GLYPHS.ascii);
      const span = brandSpan(row, GLYPHS.ascii);
      expect(row.slice(span!.from, span!.to)).toBe(`${brandGlyph(t, GLYPHS.ascii)} jevcode 0.2.0`);
    }
    expect(brandSpan('─── ▸ jev · no decisions yet ──── [d] [p] [t] [s] ──')).toBeNull();
    expect(brandSpan('─'.repeat(80))).toBeNull();
    expect(brandSpan('')).toBeNull();
  });

  /**
   * TUI-DESIGN-4 §1.2 P-H1: `brandSpan` used to assume a version token follows `jevcode` and ended the span at the
   * next space. The strip's prefix is `◆ jevcode ─ ▸ jev s4 …` — the following token is a rule cell, not a version —
   * so the span now ends at `jevcode` unless a real version token follows. The `brandRow` form is byte-identical.
   */
  it('the span ends after a VERSION token and at `jevcode` when the next token is not one (P-H1)', () => {
    const at = (row: string, g = GLYPHS.unicode): string | null => {
      const sp = brandSpan(row, g);
      return sp === null ? null : row.slice(sp.from, sp.to);
    };
    // round 2's form, unchanged
    expect(at('─── ◆ jevcode 0.4.0 ────')).toBe('◆ jevcode 0.4.0');
    expect(at('─── ◆ jevcode 1.2.3-rc.1 ────')).toBe('◆ jevcode 1.2.3-rc.1');
    expect(at('─── ◆ jevcode 0.4.0+build ────')).toBe('◆ jevcode 0.4.0+build');
    // round 4's strip prefix: a rule cell, a chevron or a word follows — the span stops at `jevcode`
    expect(at('─── ◆ jevcode ─ ▸ jev s4 · 7 decisions ──── [d] [p] [t] [s] ──')).toBe('◆ jevcode');
    expect(at('─── * jevcode - > jev s4 ----', GLYPHS.ascii)).toBe('* jevcode');
    expect(at('─── ◆ jevcode')).toBe('◆ jevcode');
    // the pulse glyphs all count, and `jevcodex` is not the brand
    for (const glyph of ['░', '▒', '▓', '◆']) expect(at(`── ${glyph} jevcode ─ ▸ jev`)).toBe(`${glyph} jevcode`);
    expect(brandSpan('─── ◆ jevcodex 0.4.0 ───')).toBeNull();
    // finding 22: a `jevcodex` BEFORE the real brand must not swallow the scan — the second occurrence wins
    expect(at('── ◆ jevcodex ─ ◆ jevcode 0.4.0 ──')).toBe('◆ jevcode 0.4.0');
    expect(at('── ◆ jevcodex ─ ◆ jevcode ─ ▸ jev s4 ──')).toBe('◆ jevcode');
    // and the span really is the SECOND occurrence, not the first
    const row = '── ◆ jevcodex ─ ◆ jevcode 0.4.0 ──';
    expect(brandSpan(row)?.from).toBe(row.indexOf('◆ jevcode 0.4.0'));
  });
});
