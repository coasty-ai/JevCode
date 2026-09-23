/**
 * TUI-DESIGN-5 §10 (R5-5 `round5-import-app.test.tsx`): the import overlay mounted in the ONE modal slot —
 * `OverlayKind 'import'`, `COLLAPSING`, `OverlayData.import`, `overlayWant` and the rendered frame at the three
 * widths of §5.8, plus the resize matrix the pty scenario `r5-import-overlay.steps` drives (24×80 → 12×60 →
 * 40×120 mid-overlay, §10).
 *
 * The pty scenario itself is R5-2's W5 deliverable; this file proves the same geometry under `ink-testing-library`
 * so a regression is caught in the unit suite rather than only in the pty run. `App.tsx`'s overlay dispatch is
 * R5-4's W3 PR (§9.2), so the overlay is mounted through `<Overlay>` directly — the component `App.tsx` will
 * render — rather than through the App shell, which does not carry the `'import'` case yet.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Overlay, overlayWant, type OverlayData } from '../../../src/tui/Overlay.js';
import { CAP, OVERLAY_KINDS, computeLayout, isCollapsingOverlay, type LayoutInput } from '../../../src/tui/layout.js';
import { blockWidth } from '../../../src/tui/block/lines.js';
import { GLYPHS, cellWidth, type GlyphSet } from '../../../src/tui/glyphs.js';
import { applicableRows, summarisePlan } from '../../../src/import/index.js';
import type { ImportPlan } from '../../../src/core/types.js';
import { importReducer, initImportUi, scanningImportUi, type ImportUiInput } from '../../../src/tui/import/reducer.js';
import { importKeys, importLines, importRendered } from '../../../src/tui/import/lines.js';
import { importCardTitle } from '../../../src/tui/import/Report.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
const RAW = readFileSync(new URL('../../fixtures/import/plan.json', import.meta.url), 'utf8');
const plan = (): ImportPlan => JSON.parse(RAW) as ImportPlan;

function inputOf(): ImportUiInput {
  const p = plan();
  return { plan: p, summary: summarisePlan(p), applicable: applicableRows(p, { scope: 'both' }) };
}
const base: LayoutInput = { rows: 24, columns: 80, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0, paneWant: 0, chrome: 0, gate: 0 };

describe('§8.1 item 10 / §9.2: `import` joins the one modal slot', () => {
  it('`OverlayKind` gains exactly `import`, and `OVERLAY_KINDS` carries it last', () => {
    expect(OVERLAY_KINDS).toContain('import');
    expect(OVERLAY_KINDS[OVERLAY_KINDS.length - 1]).toBe('import');
    // the ambiguity card is gone with the conversational chat: one member fewer
    expect(OVERLAY_KINDS).toHaveLength(10);
    expect(new Set(OVERLAY_KINDS).size).toBe(10);
    expect(OVERLAY_KINDS).not.toContain('intake');
    // §14.2 #13: the model picker is a PANE-SLOT picker, so no `models` member joins here
    expect(OVERLAY_KINDS).not.toContain('models');
  });

  it('it collapses the composer to one inactive row (it needs an answer)', () => {
    expect(isCollapsingOverlay('import')).toBe(true);
    const l = computeLayout({ ...base, overlay: 'import', overlayWant: 8, composerWant: 4 });
    expect(l.composer).toBe(1);
    expect(l.overlay).toBe(8);
    expect(l.total).toBeLessThanOrEqual(l.budget);
  });

  it('`CAP.import` bounds the slot, and `computeLayout` stays sound over the whole grid', () => {
    expect(CAP.import).toBe(10);
    for (let rows = 2; rows <= 48; rows++) {
      for (const columns of [24, 40, 60, 80, 120, 200]) {
        for (const want of [0, 2, 5, 8, 10, 12]) {
          const l = computeLayout({ ...base, rows, columns, overlay: 'import', overlayWant: want });
          expect(l.total, `${rows}x${columns}:${want}`).toBeLessThanOrEqual(l.budget);
          // the minsize branch grants the NOTICE its row whatever the want is (TD4 §2.5 P-R5) — that row is the
          // explanation, not the overlay, so it is the one place `overlay > want` is correct
          if (l.degraded !== 'minsize') expect(l.overlay, `${rows}x${columns}:${want}`).toBeLessThanOrEqual(Math.max(0, want));
        }
      }
    }
  });
});

describe('`overlayWant("import", …)`', () => {
  it('is 0 with no data — an absent overlay never reserves a row', () => {
    expect(overlayWant('import', {}, 24, 80)).toBe(0);
  });

  it('is the rows the block produced, capped at `CAP.import`; boxed adds the two card edges', () => {
    const input = inputOf();
    const data: OverlayData = { import: { state: initImportUi(input), input } };
    const flat = overlayWant('import', data, 24, 80);
    expect(flat).toBe(Math.min(CAP.import, importLines(data.import!.state, input, 80).length));
    expect(flat).toBeGreaterThanOrEqual(2);
    const boxed = overlayWant('import', data, 24, 80, 3);
    expect(boxed).toBe(Math.min(CAP.import + CAP.card, Math.min(CAP.import, importLines(data.import!.state, input, 76).length) + CAP.card));
    expect(boxed).toBeGreaterThan(flat);
  });

  it('never exceeds `CAP.import` (+ the edges) at any width, in any step', () => {
    const input = inputOf();
    let state = initImportUi(input);
    for (const action of [{ type: 'open' } as const, { type: 'back' } as const, { type: 'review' } as const, { type: 'apply' } as const]) {
      state = importReducer(state, action, input);
      for (const columns of [24, 40, 60, 80, 120, 200]) {
        expect(overlayWant('import', { import: { state, input } }, 24, columns)).toBeLessThanOrEqual(CAP.import);
        expect(overlayWant('import', { import: { state, input } }, 24, columns, 3)).toBeLessThanOrEqual(CAP.import + CAP.card);
      }
    }
  });
});

describe('the frame (F-56) and the §5.8 widths', () => {
  function frame(columns: number, rows: number, chrome: 0 | 3 = 0, state = initImportUi(inputOf())): string[] {
    const input = inputOf();
    const data: OverlayData = { import: { state, input } };
    const want = overlayWant('import', data, rows, columns, chrome);
    const ui = render(<Overlay kind="import" rows={want} previewRows={0} columns={columns} terminalRows={rows} top={0} data={data} chrome={chrome} />);
    return strip(ui.lastFrame()).filter((l) => l !== '');
  }

  it('80×24 flat draws the head, the group rows and the keys row', () => {
    const rows = frame(80, 24);
    expect(rows[0]).toContain('Import — 10 to import · 2 to review · 7 skipped');
    expect(rows.some((r) => /^\s*memory\s+5/.test(r))).toBe(true);
    expect(rows.some((r) => r.includes('[y] import all 10'))).toBe(true);
  });

  it('the boxed tier is a rounded card titled `import`', () => {
    const rows = frame(80, 24, 3);
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]).toContain('import');
    expect(rows[rows.length - 1]?.startsWith('╰')).toBe(true);
    expect(importCardTitle(initImportUi(inputOf()))).toBe('import');
  });

  it('the card title names the step while it is scanning, applying or reviewing', () => {
    const input = inputOf();
    expect(importCardTitle(scanningImportUi())).toBe('import · scanning');
    expect(importCardTitle(importReducer(initImportUi(input), { type: 'review' }, input))).toBe('import · review');
    expect(importCardTitle(importReducer(initImportUi(input), { type: 'apply' }, input))).toBe('import · applying');
  });

  it('no rendered row ever exceeds the terminal width — 24×80 → 12×60 → 40×120 (the resize matrix)', () => {
    for (const [columns, rows] of [
      [80, 24],
      [60, 12],
      [120, 40],
      [40, 8],
      [200, 60],
    ] as const) {
      for (const chrome of [0, 3] as const) {
        for (const line of frame(columns, rows, chrome)) {
          expect(cellWidth(line), `${columns}x${rows}:${chrome}:${line}`).toBeLessThanOrEqual(columns);
        }
      }
    }
  });

  it('never paints more rows than the slot granted', () => {
    const input = inputOf();
    const data: OverlayData = { import: { state: initImportUi(input), input } };
    for (const rows of [0, 1, 2, 3, 6, 10]) {
      const ui = render(<Overlay kind="import" rows={rows} previewRows={0} columns={80} terminalRows={24} top={0} data={data} />);
      const painted = strip(ui.lastFrame()).filter((l) => l !== '').length;
      expect(painted, `${rows}`).toBeLessThanOrEqual(rows);
      cleanup();
    }
  });

  it('renders nothing when the App passes no `import` data', () => {
    const ui = render(<Overlay kind="import" rows={6} previewRows={0} columns={80} terminalRows={24} top={0} data={{}} />);
    expect(ui.lastFrame() ?? '').toBe('');
  });

  it('the `--ascii` frame is the same rows with no unicode glyph', () => {
    const input = inputOf();
    const data: OverlayData = { import: { state: initImportUi(input), input } };
    const want = overlayWant('import', data, 24, 80);
    const ui = render(<Overlay kind="import" rows={want} previewRows={0} columns={80} terminalRows={24} top={0} data={data} glyphs={GLYPHS.ascii} />);
    const text = strip(ui.lastFrame()).join('\n');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f\n ]*$/.test(text)).toBe(true);
    expect(text).toContain('Import - 10 to import - 2 to review - 7 skipped');
  });

  it('§13.1: the Ink rows ARE `importLines` — one formatter, three sinks', () => {
    const input = inputOf();
    const state = initImportUi(input);
    const data: OverlayData = { import: { state, input } };
    const want = overlayWant('import', data, 24, 80);
    const ui = render(<Overlay kind="import" rows={want} previewRows={0} columns={80} terminalRows={24} top={0} data={data} />);
    const painted = strip(ui.lastFrame()).filter((l) => l !== '');
    const expected = importLines(state, input, 80).slice(0, want).filter((l) => l !== '');
    expect(painted).toEqual(expected);
  });
});

/** the painted 40×24 frame, through the real `<Overlay>` — the component the App renders */
function frame40(): string[] {
  const input = inputOf();
  const data: OverlayData = { import: { state: initImportUi(input), input } };
  const want = overlayWant('import', data, 24, 40);
  const ui = render(<Overlay kind="import" rows={want} previewRows={0} columns={40} terminalRows={24} top={0} data={data} />);
  return strip(ui.lastFrame()).filter((l) => l !== '');
}

describe('§5.8 / §12.4 S91 — `CAP.import` never silently eats a row', () => {
  it('at every width from 24 to 200, in BOTH glyph sets, the painted rows keep the keys row and `review`', () => {
    const input = inputOf();
    const state = initImportUi(input);
    for (let columns = 24; columns <= 200; columns++) {
      for (const g of [GLYPHS.unicode, GLYPHS.ascii] as const) {
        for (const chrome of [0, 3] as const) {
          const want = overlayWant('import', { import: { state, input } }, 24, columns, chrome, g);
          const inner = chrome === 3 ? Math.max(1, columns - 4) : columns;
          const budget = chrome === 3 ? Math.max(0, want - CAP.card) : want;
          // exactly what `ImportReport` paints for that grant
          const painted = importRendered(state, input, inner, g, budget).slice(0, budget).map((r) => r.text);
          const label = `${columns}:${g.mode}:${chrome}`;
          expect(painted.length, label).toBeLessThanOrEqual(budget);
          expect(painted[painted.length - 1], label).toBe(importKeys(input.summary.toImport, blockWidth(inner), g));
          expect(painted.some((r) => /^review\s+2/.test(r)), `${label} review`).toBe(true);
          expect(painted[0], label).toContain('Import');
        }
      }
    }
  });

  it('`overlayWant` measures the glyph set the component DRAWS — ascii and SR never lose a row to the slot', () => {
    const input = inputOf();
    let state = initImportUi(input);
    for (const action of [{ type: 'open' } as const, { type: 'back' } as const, { type: 'review' } as const, { type: 'back' } as const, { type: 'apply' } as const]) {
      state = importReducer(state, action, input);
      for (const columns of [24, 40, 60, 80, 120, 200]) {
        for (const g of [GLYPHS.unicode, GLYPHS.ascii, GLYPHS.sr] as readonly GlyphSet[]) {
          const want = overlayWant('import', { import: { state, input } }, 24, columns, 0, g);
          const painted = importRendered(state, input, columns, g, want);
          expect(want, `${state.step}:${columns}:${g.mode}`).toBeGreaterThanOrEqual(painted.length);
        }
      }
    }
  });

  it('the painted 40×24 frame is §5.8’s row set — head, five group rows, `review`, and the keys row', () => {
    const rows = frame40();
    expect(rows[0]).toBe('Import — 10 · 2 · 7');
    expect(rows[1]).toMatch(/^memory\s+5$/);
    expect(rows.some((r) => /^review\s+2$/.test(r))).toBe(true);
    expect(rows[rows.length - 1]).toBe('y all · Enter open · Esc');
    expect(rows).toHaveLength(8);
  });
});
