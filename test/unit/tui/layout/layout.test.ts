/**
 * TUI-DESIGN §19.0 / §19.1: `computeLayout` invariants exhaustively over rows 2..60 × columns 20..400 ×
 * every OverlayKind × overlay wants 0..12 (the other wants cycle through a seeded grid), then a second pass
 * sweeping each remaining want 0..12 with the others fixed; every §2.2 cell; every fenced frame of
 * docs/TUI-DESIGN.md §2.3 (width ≤ W by O2's `stringWidth`, cell-identical with string-width@8.2.2; dynamic
 * rows = caption); and the ≤ 5 µs gate on the median with 3× on the mean.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import {
  CAP,
  MIN_COLUMNS,
  MIN_ROWS,
  OVERLAY_KINDS,
  YIELD_ORDER,
  composerTop,
  computeLayout,
  isCollapsingOverlay,
  type Layout,
  type LayoutInput,
} from '../../../../src/tui/layout.js';

const DESIGN = fileURLToPath(new URL('../../../../docs/TUI-DESIGN.md', import.meta.url));

function input(o: Partial<LayoutInput> = {}): LayoutInput {
  return {
    rows: 24,
    columns: 80,
    overlay: 'none',
    overlayWant: 0,
    previewWant: 0,
    expanded: false,
    composerWant: 1,
    queueWant: 0,
    liveWant: 0,
    bannerWant: 0,
    paneWant: 0,
    ...o,
  };
}

/** the design's `rule·live·banner·pane·queue·overlay·preview·composer·status = total` notation */
function cells(l: Layout): string {
  return `${l.rule}·${l.live}·${l.banner}·${l.pane}·${l.queue}·${l.overlay}·${l.preview}·${l.composer}·${l.status} = ${l.total}`;
}

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

/** every §2.1 invariant for one input; violations are appended to `note` (first 20 kept by the caller) */
function checkInvariants(i: LayoutInput, note: (msg: string) => void): void {
  const { rows, columns, overlay, overlayWant } = i;
  const l = computeLayout(i);
  const budget = Math.max(0, rows - 2);
  const tag = `rows ${rows} cols ${columns} ${overlay}/${overlayWant} c${i.composerWant} q${i.queueWant} l${i.liveWant} p${i.paneWant} v${i.previewWant} → ${cells(l)}`;
  if (l.budget !== budget) note(`budget ${tag}`);
  const sum = l.status + l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview + l.composer;
  if (sum !== l.total) note(`sum≠total ${tag}`);
  if (l.total > budget) note(`total>budget ${tag}`);
  for (const k of ['status', 'rule', 'live', 'banner', 'pane', 'queue', 'overlay', 'preview', 'composer'] as const) {
    if (l[k] < 0 || !Number.isInteger(l[k])) note(`negative/fractional ${k} ${tag}`);
  }
  if (rows >= 3 && l.status !== 1) note(`status≠1 ${tag}`);
  if (rows < 3 && (l.degraded !== 'static-only' || l.total !== 0)) note(`rows<3 not static-only ${tag}`);
  if (rows >= 5 && overlay !== 'wizard' && l.composer < 1) note(`composer<1 ${tag}`);
  const degradedExpected = rows < 3 ? 'static-only' : rows < MIN_ROWS || columns < MIN_COLUMNS ? 'minsize' : 'none';
  if (l.degraded !== degradedExpected) note(`degraded ${l.degraded}≠${degradedExpected} ${tag}`);
  if (l.degraded === 'none') {
    if (l.rule !== 1) note(`rule≠1 ${tag}`);
    if (overlay === 'wizard' && l.composer !== 0) note(`wizard composer≠0 ${tag}`);
    if (overlay !== 'wizard' && overlay !== 'none' && rows >= Math.max(8, overlayWant + 5) && l.overlay !== overlayWant) note(`overlay whole ${tag}`);
    if (overlay === 'wizard' && rows >= Math.max(8, overlayWant + 4) && l.overlay !== overlayWant) note(`wizard whole ${tag}`);
    if (overlay === 'none' && l.overlay !== 0) note(`none overlay≠0 ${tag}`);
    if (overlay === 'review' && overlayWant >= 3 && l.overlay < 3) note(`review header<3 ${tag}`);
    if (overlay === 'review' && l.live !== 0) note(`review live≠0 ${tag}`);
    if (overlay !== 'review' && l.preview !== 0) note(`preview outside review ${tag}`);
    if (i.expanded && l.pane !== 0) note(`expanded pane≠0 ${tag}`);
    if (l.live > CAP.live || l.queue > CAP.queue || l.pane > CAP.pane || l.banner > CAP.banner) note(`cap ${tag}`);
    if (!i.expanded && l.preview > CAP.preview) note(`preview cap ${tag}`);
    const composerCap = isCollapsingOverlay(overlay) ? 1 : rows >= 40 ? CAP.composerTall : CAP.composer;
    if (overlay !== 'wizard' && l.composer > Math.max(1, Math.min(i.composerWant, composerCap))) note(`composer cap ${tag}`);
    // yield order: when a later-yielding field is short of its want, every earlier-yielding field is 0
    const wants: Record<(typeof YIELD_ORDER)[number], number> = {
      pane: i.expanded ? 0 : Math.min(i.paneWant, CAP.pane),
      banner: Math.min(i.bannerWant, CAP.banner),
      live: overlay === 'review' ? 0 : Math.min(i.liveWant, CAP.live),
      preview: overlay === 'review' ? Math.min(i.previewWant, i.expanded ? Infinity : CAP.preview) : 0,
      queue: Math.min(i.queueWant, CAP.queue),
      composer: overlay === 'wizard' ? 0 : Math.max(1, Math.min(i.composerWant, composerCap)),
      overlay: overlay === 'none' ? 0 : overlayWant,
      status: 1,
      rule: 1,
      budget: 0,
      degraded: 0,
      total: 0,
    };
    for (let a = 0; a < YIELD_ORDER.length; a++) {
      const later = YIELD_ORDER[a] as keyof typeof wants;
      const got = l[later] as number;
      const want = wants[later];
      const short = later === 'composer' ? got < want && got > 0 && want > 1 ? true : got < want : got < want;
      if (!short) continue;
      // the preview under `expanded` takes whatever remains, so it is never "short" for this rule
      if (later === 'preview' && i.expanded) continue;
      for (let b = 0; b < a; b++) {
        const earlier = YIELD_ORDER[b] as keyof Layout;
        const v = l[earlier] as number;
        // the composer floor (1) never yields; only its growth does
        const floor = earlier === 'composer' && overlay !== 'wizard' ? 1 : 0;
        if (v > floor) note(`yield order: ${String(later)} short but ${String(earlier)}=${v} ${tag}`);
      }
    }
  } else if (l.degraded === 'minsize') {
    if (l.rule !== 0 || l.live !== 0 || l.pane !== 0 || l.queue !== 0 || l.preview !== 0 || l.banner !== 0) note(`minsize extra fields ${tag}`);
    if (l.overlay !== Math.min(1, Math.max(0, budget - 1))) note(`minsize notice ${tag}`);
    if (l.composer !== Math.min(1, Math.max(0, budget - 2))) note(`minsize composer ${tag}`);
  }
  if (composerTop(l) + l.composer + l.status !== l.total) note(`composerTop ${tag}`);
}

describe('computeLayout invariants (TUI-DESIGN §2.1)', () => {
  it('holds exhaustively over rows 2..60 × columns 20..400 × every OverlayKind × overlay wants 0..12', () => {
    const rnd = mulberry32(0x5eed);
    const violations: string[] = [];
    let calls = 0;
    const note = (msg: string): void => {
      if (violations.length < 20) violations.push(msg);
    };
    for (let rows = 2; rows <= 60; rows++) {
      for (let columns = 20; columns <= 400; columns++) {
        for (const overlay of OVERLAY_KINDS) {
          for (let overlayWant = 0; overlayWant <= 12; overlayWant++) {
            checkInvariants({
              rows,
              columns,
              overlay,
              overlayWant,
              previewWant: [0, 4, 30][Math.floor(rnd() * 3)] ?? 0,
              expanded: overlay === 'review' && rnd() < 0.3,
              composerWant: [1, 1, 3, 6, 9, 12][Math.floor(rnd() * 6)] ?? 1,
              queueWant: [0, 0, 1, 2, 8][Math.floor(rnd() * 5)] ?? 0,
              liveWant: [0, 1, 2][Math.floor(rnd() * 3)] ?? 0,
              bannerWant: rnd() < 0.3 ? 1 : 0,
              paneWant: [0, 3, 12][Math.floor(rnd() * 3)] ?? 0,
            }, note);
            calls++;
          }
        }
      }
    }
    expect(calls).toBe(59 * 381 * OVERLAY_KINDS.length * 13);
    expect(violations).toEqual([]);
  });

  it('second pass: each remaining want (composer, queue, live, pane, preview, banner) swept 0..12 with the others fixed, over rows 2..60 × six column classes × every OverlayKind', () => {
    const violations: string[] = [];
    let calls = 0;
    const note = (msg: string): void => {
      if (violations.length < 20) violations.push(msg);
    };
    const fixed: Omit<LayoutInput, 'rows' | 'columns' | 'overlay'> = { overlayWant: 6, previewWant: 4, expanded: false, composerWant: 2, queueWant: 1, liveWant: 1, bannerWant: 0, paneWant: 12 };
    const sweeps: (keyof typeof fixed)[] = ['composerWant', 'queueWant', 'liveWant', 'paneWant', 'previewWant', 'bannerWant'];
    for (let rows = 2; rows <= 60; rows++) {
      for (const columns of [20, 39, 40, 80, 120, 400]) {
        for (const overlay of OVERLAY_KINDS) {
          for (const key of sweeps) {
            for (let want = 0; want <= 12; want++) {
              for (const expanded of overlay === 'review' && key === 'previewWant' ? [false, true] : [false]) {
                checkInvariants({ rows, columns, overlay, ...fixed, [key]: want, expanded }, note);
                calls++;
              }
            }
          }
        }
      }
    }
    expect(calls).toBe(59 * 6 * (OVERLAY_KINDS.length * 6 * 13 + 13));
    expect(violations).toEqual([]);
  });

  it('is pure and deterministic', () => {
    const i = input({ rows: 24, overlay: 'review', overlayWant: 8, previewWant: 4, paneWant: 12 });
    const a = computeLayout(i);
    const b = computeLayout({ ...i });
    expect(a).toEqual(b);
    expect(cells(a)).toBe('1·0·0·7·0·8·4·1·1 = 22');
  });

  it('the loop banner is capped at one row whatever the want (found by the second-pass sweep; the type says 0 | 1, the function clamps a wider caller too)', () => {
    const wide = (bannerWant: number, o: Partial<LayoutInput> = {}): LayoutInput => ({ ...input(o), bannerWant } as LayoutInput);
    expect(computeLayout(wide(2, { liveWant: 2, paneWant: 12 })).banner).toBe(1);
    expect(computeLayout(wide(12)).banner).toBe(CAP.banner);
    expect(computeLayout(wide(0)).banner).toBe(0);
    expect(cells(computeLayout(wide(6, { rows: 10, columns: 40, liveWant: 1, queueWant: 1, composerWant: 2, paneWant: 12 })))).toBe('1·1·1·1·1·0·0·2·1 = 8');
  });

  it('treats NaN, ±Infinity, negative and fractional sizes safely', () => {
    expect(computeLayout(input({ rows: Number.NaN })).degraded).toBe('static-only');
    expect(computeLayout(input({ rows: Number.POSITIVE_INFINITY })).degraded).toBe('static-only');
    expect(computeLayout(input({ rows: -5, columns: 80 })).total).toBe(0);
    expect(computeLayout(input({ rows: 24, columns: Number.NaN })).degraded).toBe('minsize');
    expect(computeLayout(input({ rows: 24.9, columns: 80.2 })).budget).toBe(22);
    const nanWants = computeLayout(input({ rows: 24, overlay: 'palette', overlayWant: Number.NaN, composerWant: Number.NaN, queueWant: Number.NaN, liveWant: Number.NaN, paneWant: Number.NaN }));
    expect(nanWants.overlay).toBe(0);
    expect(nanWants.composer).toBe(1);
    expect(nanWants.total).toBe(3);
    expect(Object.values(nanWants).every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
    const infWants = computeLayout(input({ rows: 24, overlay: 'palette', overlayWant: Number.POSITIVE_INFINITY, paneWant: Number.POSITIVE_INFINITY }));
    expect(infWants.overlay).toBe(19);
    expect(infWants.total).toBe(22);
    const negWants = computeLayout(input({ rows: 24, overlay: 'palette', overlayWant: -3, composerWant: -1, queueWant: -2, liveWant: -1, paneWant: -4 }));
    expect(negWants.overlay).toBe(0);
    expect(negWants.composer).toBe(1);
    expect(negWants.total).toBe(3);
    const huge = computeLayout(input({ rows: 1e9, columns: 1e9, paneWant: 12, composerWant: 100 }));
    expect(huge.budget).toBe(1e9 - 2);
    expect(huge.composer).toBe(CAP.composerTall);
    expect(huge.pane).toBe(CAP.pane);
  });

  it('rows 3–4 and rows ≤ 2 behave as the §2.2 tail rows say', () => {
    expect(cells(computeLayout(input({ rows: 2 })))).toBe('0·0·0·0·0·0·0·0·0 = 0');
    expect(cells(computeLayout(input({ rows: 3 })))).toBe('0·0·0·0·0·0·0·0·1 = 1');
    expect(cells(computeLayout(input({ rows: 4 })))).toBe('0·0·0·0·0·1·0·0·1 = 2');
    expect(cells(computeLayout(input({ rows: 6 })))).toBe('0·0·0·0·0·1·0·1·1 = 3');
    expect(computeLayout(input({ rows: 6 })).degraded).toBe('minsize');
    expect(computeLayout(input({ rows: 24, columns: 39 })).degraded).toBe('minsize');
    expect(cells(computeLayout(input({ rows: 24, columns: 39, paneWant: 12, composerWant: 4 })))).toBe('0·0·0·0·0·1·0·1·1 = 3');
  });

  it('runs in ≤ 5 µs per call: the median of 7 runs meets the design bound, the mean gets 3× (15 µs) for a loaded machine', () => {
    const inputs: LayoutInput[] = [];
    const rnd = mulberry32(7);
    for (let n = 0; n < 1024; n++) {
      inputs.push(
        input({
          rows: 8 + Math.floor(rnd() * 50),
          columns: 40 + Math.floor(rnd() * 100),
          overlay: OVERLAY_KINDS[Math.floor(rnd() * OVERLAY_KINDS.length)] ?? 'none',
          overlayWant: Math.floor(rnd() * 9),
          previewWant: Math.floor(rnd() * 30),
          expanded: rnd() < 0.2,
          composerWant: 1 + Math.floor(rnd() * 9),
          queueWant: Math.floor(rnd() * 8),
          liveWant: Math.floor(rnd() * 3),
          bannerWant: rnd() < 0.3 ? 1 : 0,
          paneWant: Math.floor(rnd() * 13),
        }),
      );
    }
    let sink = 0;
    for (let n = 0; n < 20_000; n++) sink += computeLayout(inputs[n & 1023] as LayoutInput).total; // warm-up
    const N = 100_000;
    const runs: number[] = [];
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      for (let n = 0; n < N; n++) sink += computeLayout(inputs[n & 1023] as LayoutInput).total;
      runs.push(((performance.now() - t0) * 1000) / N);
    }
    expect(sink).toBeGreaterThan(0);
    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[3] as number;
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    process.stderr.write(`computeLayout: median ${median.toFixed(3)} µs per call (bound 5), mean ${mean.toFixed(3)} µs (bound 15)\n`);
    expect(median).toBeLessThanOrEqual(5);
    expect(mean).toBeLessThanOrEqual(15);
  });
});

interface Row {
  name: string;
  i: Partial<LayoutInput>;
  /** expected `cells()` at rows 8, 12, 24, 40, 50 — a bare number means "same fields as the previous column, this total" */
  at: [string | number, string | number, string | number, string | number, string | number];
}

const TABLE: Row[] = [
  { name: 'idle, session start (pane 0, composer 1)', i: {}, at: ['1·0·0·0·0·0·0·1·1 = 3', 3, 3, 3, 3] },
  { name: 'idle after a run (pane 12, composer 1)', i: { paneWant: 12 }, at: ['1·0·0·3·0·0·0·1·1 = 6', '1·0·0·7·0·0·0·1·1 = 10', '1·0·0·12·0·0·0·1·1 = 15', 15, 15] },
  { name: 'idle, 6-row draft (pane 12)', i: { paneWant: 12, composerWant: 6 }, at: ['1·0·0·0·0·0·0·4·1 = 6', '1·0·0·2·0·0·0·6·1 = 10', '1·0·0·12·0·0·0·6·1 = 20', 20, 20] },
  { name: 'idle, 9-row draft (cap 8 at ≥ 40)', i: { paneWant: 12, composerWant: 9 }, at: ['1·0·0·0·0·0·0·4·1 = 6', '1·0·0·2·0·0·0·6·1 = 10', '1·0·0·12·0·0·0·6·1 = 20', '1·0·0·12·0·0·0·8·1 = 22', 22] },
  { name: 'live, streaming (live 2, pane 12)', i: { liveWant: 2, paneWant: 12 }, at: ['1·2·0·1·0·0·0·1·1 = 6', '1·2·0·5·0·0·0·1·1 = 10', '1·2·0·12·0·0·0·1·1 = 17', 17, 17] },
  { name: 'live, 2 queued, 1-row draft (live 2, queue 2)', i: { liveWant: 2, queueWant: 2, paneWant: 12 }, at: ['1·1·0·0·2·0·0·1·1 = 6', '1·2·0·3·2·0·0·1·1 = 10', '1·2·0·12·2·0·0·1·1 = 19', 19, 19] },
  { name: 'live, 2 queued, 3-row draft', i: { liveWant: 2, queueWant: 2, paneWant: 12, composerWant: 3 }, at: ['1·0·0·0·1·0·0·3·1 = 6', '1·2·0·1·2·0·0·3·1 = 10', '1·2·0·12·2·0·0·3·1 = 21', 21, 21] },
  { name: 'live + loop banner (live 2, banner 1)', i: { liveWant: 2, bannerWant: 1, paneWant: 12 }, at: ['1·2·1·0·0·0·0·1·1 = 6', '1·2·1·4·0·0·0·1·1 = 10', '1·2·1·12·0·0·0·1·1 = 18', 18, 18] },
  { name: 'review pending (header 8, preview 4)', i: { overlay: 'review', overlayWant: 8, previewWant: 4, paneWant: 12, liveWant: 2 }, at: ['1·0·0·0·0·3·0·1·1 = 6', '1·0·0·0·0·7·0·1·1 = 10', '1·0·0·7·0·8·4·1·1 = 22', '1·0·0·12·0·8·4·1·1 = 27', 27] },
  { name: 'review + `e` (preview 30 lines)', i: { overlay: 'review', overlayWant: 8, previewWant: 30, expanded: true, paneWant: 12 }, at: ['1·0·0·0·0·3·0·1·1 = 6', '1·0·0·0·0·7·0·1·1 = 10', '1·0·0·0·0·8·11·1·1 = 22', '1·0·0·0·0·8·27·1·1 = 38', '1·0·0·0·0·8·30·1·1 = 41'] },
  { name: 'palette open (8 rows incl. footer, composer 1)', i: { overlay: 'palette', overlayWant: 8, paneWant: 12 }, at: ['1·0·0·0·0·3·0·1·1 = 6', '1·0·0·0·0·7·0·1·1 = 10', '1·0·0·11·0·8·0·1·1 = 22', '1·0·0·12·0·8·0·1·1 = 23', 23] },
  { name: 'picker open (pane slot, 12 rows incl. header)', i: { paneWant: 12 }, at: ['1·0·0·3·0·0·0·1·1 = 6', '1·0·0·7·0·0·0·1·1 = 10', '1·0·0·12·0·0·0·1·1 = 15', 15, 15] },
  { name: 'onboarding wizard (4 rows; composer refunded)', i: { overlay: 'wizard', overlayWant: 4 }, at: ['1·0·0·0·0·4·0·0·1 = 6', 6, 6, 6, 6] },
  { name: '`/login` mid-run (wizard 4, live 2, pane 12)', i: { overlay: 'wizard', overlayWant: 4, liveWant: 2, paneWant: 12 }, at: ['1·0·0·0·0·4·0·0·1 = 6', '1·2·0·2·0·4·0·0·1 = 10', '1·2·0·12·0·4·0·0·1 = 20', 20, 20] },
  { name: 'follow-up budget confirm (5, pane 12, composer 1)', i: { overlay: 'followup', overlayWant: 5, paneWant: 12 }, at: ['1·0·0·0·0·3·0·1·1 = 6', '1·0·0·2·0·5·0·1·1 = 10', '1·0·0·12·0·5·0·1·1 = 20', 20, 20] },
  { name: 'retry row (live 1–2, pane 12)', i: { liveWant: 2, paneWant: 12 }, at: ['1·2·0·1·0·0·0·1·1 = 6', '1·2·0·5·0·0·0·1·1 = 10', '1·2·0·12·0·0·0·1·1 = 17', 17, 17] },
  { name: 'secret gate row (overlay 1, 3-row draft)', i: { overlay: 'secret', overlayWant: 1, composerWant: 3, paneWant: 12 }, at: ['1·0·0·0·0·1·0·3·1 = 6', '1·0·0·4·0·1·0·3·1 = 10', '1·0·0·12·0·1·0·3·1 = 18', 18, 18] },
  { name: 'blocking pane (4, pane 12, composer 1)', i: { overlay: 'blocking', overlayWant: 4, paneWant: 12 }, at: ['1·0·0·0·0·3·0·1·1 = 6', '1·0·0·3·0·4·0·1·1 = 10', '1·0·0·12·0·4·0·1·1 = 19', 19, 19] },
];

describe('the §2.2 allocation table, recomputed from the function', () => {
  const ROWS = [8, 12, 24, 40, 50] as const;
  const cases = TABLE.flatMap((row) =>
    ROWS.map((rows, n) => {
      const exp = row.at[n];
      return { name: row.name, rows, exp, i: row.i };
    }),
  );
  it.each(cases)('$name at rows $rows → $exp', ({ rows, exp, i }) => {
    const l = computeLayout(input({ ...i, rows }));
    if (typeof exp === 'number') expect(l.total).toBe(exp);
    else expect(cells(l)).toBe(exp);
    expect(l.total).toBeLessThanOrEqual(rows - 2);
    expect(l.total).toBeLessThanOrEqual(27 + (i.expanded ? l.preview : 0));
  });

  it('minimum size (rows 5–7 or columns < 40): rows 6 → notice 1 + composer 1 + status 1 = 3 of 4', () => {
    const l = computeLayout(input({ rows: 6, paneWant: 12, composerWant: 4 }));
    expect(l.budget).toBe(4);
    expect([l.overlay, l.composer, l.status, l.total]).toEqual([1, 1, 1, 3]);
    expect(l.degraded).toBe('minsize');
  });

  it('at rows 40 and 50 nothing but the composer cap changes and the region never exceeds 27 rows without `e`', () => {
    for (const row of TABLE) {
      if (row.i.expanded) continue;
      const a = computeLayout(input({ ...row.i, rows: 40 }));
      const b = computeLayout(input({ ...row.i, rows: 50 }));
      expect(cells(a)).toBe(cells(b));
      expect(a.total).toBeLessThanOrEqual(27);
    }
  });
});

interface Frame {
  id: string;
  columns: number;
  rows: number;
  dynamic: number;
  scrollback: number;
  lines: string[];
  caption: string;
}

/** captions `W×H (D dynamic rows[; S scrollback rows above])` or `(N of D dynamic rows shown)` (§19.1) */
function readFrames(): Frame[] {
  const text = readFileSync(DESIGN, 'utf8');
  const lines = text.split('\n');
  const frames: Frame[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? '';
    const m = /^\*\*F-([A-Z]+)\.\s+(.*)$/.exec(line);
    if (!m) continue;
    const caption = m[2] ?? '';
    const geo = /(\d+)×(\d+)\s+\(/.exec(caption);
    const dyn = /(?:(\d+) of )?(\d+) dynamic rows?/.exec(caption);
    const sb = /(\d+) scrollback rows? above/.exec(caption);
    if (!geo || !dyn) continue;
    let k = n + 1;
    while (k < lines.length && lines[k] === '') k++;
    if (lines[k] !== '```') continue;
    const body: string[] = [];
    for (k++; k < lines.length && lines[k] !== '```'; k++) body.push(lines[k] ?? '');
    frames.push({
      id: `F-${m[1]}`,
      columns: Number(geo[1]),
      rows: Number(geo[2]),
      dynamic: Number(dyn[1] ?? dyn[2]),
      scrollback: sb ? Number(sb[1]) : 0,
      lines: body,
      caption,
    });
  }
  return frames;
}

describe('every fenced frame of docs/TUI-DESIGN.md §2.3 (TUI-DESIGN §19.1)', () => {
  const frames = readFrames();
  it('finds the 27 worked frames F-A … F-AA', () => {
    expect(frames.map((f) => f.id)).toEqual(['F-A', 'F-B', 'F-C', 'F-D', 'F-E', 'F-F', 'F-G', 'F-H', 'F-I', 'F-J', 'F-K', 'F-L', 'F-M', 'F-N', 'F-O', 'F-P', 'F-Q', 'F-R', 'F-S', 'F-T', 'F-U', 'F-V', 'F-W', 'F-X', 'F-Y', 'F-Z', 'F-AA']);
  });
  it.each(frames.map((f) => ({ id: f.id, f })))('$id: every row ≤ W cells and the row count matches its caption', ({ f }) => {
    expect(f.lines.length).toBe(f.dynamic + f.scrollback);
    for (const row of f.lines) expect(stringWidth(row), `${f.id} row wider than ${f.columns}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(f.columns);
    // the dynamic rows shown never exceed the rows − 2 budget of the captioned geometry
    expect(f.dynamic).toBeLessThanOrEqual(Math.max(0, f.rows - 2));
  });
});
