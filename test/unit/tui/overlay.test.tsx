/**
 * TUI-DESIGN §19.3 (`overlay.test.tsx`): the one modal slot — `overlayWant()` per kind (review 8 · wizard 2–4 ·
 * followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 · exitConfirm 1), every kind renders its shared
 * `lines()` rows inside a fixed-height box (never more than `rows`), the §24 strings verbatim (exit confirm, the
 * minimum-size notice, the secret gate, the follow-up box, the blocking pane), and the palette rows / footer.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockingRequest } from '../../../src/core/types.js';
import { EXIT_CONFIRM_ROW, EXIT_CONFIRM_ROW_COMPACT, EXIT_CONFIRM_RUNGS, Overlay, exitConfirmRow, minsizeNotice, minsizeRungs, overlayPreviewWant, overlayWant, type OverlayData } from '../../../src/tui/Overlay.js';
import { cardBottom, cardLines } from '../../../src/tui/card.js';
import { followupLines, reviewCardLines } from '../../../src/tui/review/lines.js';
import { blockingLines } from '../../../src/tui/blocking/lines.js';
import { INITIAL_ONBOARDING, onboardingReducer } from '../../../src/tui/onboarding/reducer.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import { computeLayout } from '../../../src/tui/layout.js';
import { CONFIRM_ABORT_RUNGS, CONFIRM_EXIT_RUNGS, CONFIRM_NEW_RUNGS, confirmRow, confirmRungs } from '../../../src/tui/commands/confirm.js';
import { wizardMinsizeRow } from '../../../src/tui/onboarding/lines.js';
import { previewWant } from '../../../src/tui/Review.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';

afterEach(() => cleanup());

const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
const blocking: BlockingRequest = { id: 'b1', step: 0, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found."', sources: ['env JEV_API_KEY', 'OPENROUTER_API_KEY'], stop: 'error', exitCode: 2 };
const followup = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
const paletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const wizardState = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
/** the `computeLayout` input every minsize case varies two fields of */
const base = { rows: 24, columns: 80, overlay: 'none' as const, overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0 as const, paneWant: 0, chrome: 0 as const, gate: 0 as const };

describe('overlayWant (§2.1)', () => {
  it('asks the layout for the design rows per kind', () => {
    const wizard = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    const data: OverlayData = { review: { req: mkConfirmRequest(), note: null }, wizard: { state: wizard, trust: null }, followup, secret: { hits: detectSecrets(`sk-ant-api03-${'A'.repeat(40)}`) }, blocking, palette: { query: '/b', state: paletteState, selected: 0 }, undo: { row: 'x' } };
    expect(overlayWant('none', data, 24, 80)).toBe(0);
    expect(overlayWant('review', data, 24, 80)).toBe(8);
    expect(overlayWant('wizard', data, 24, 80)).toBe(3);
    expect(overlayWant('followup', data, 24, 80)).toBe(5);
    expect(overlayWant('secret', data, 24, 80)).toBe(1);
    expect(overlayWant('blocking', data, 24, 80)).toBe(4);
    expect(overlayWant('palette', data, 24, 80)).toBeGreaterThanOrEqual(2);
    expect(overlayWant('palette', data, 24, 80)).toBeLessThanOrEqual(8);
    expect(overlayWant('undo', data, 24, 80)).toBe(1);
    expect(overlayWant('exitConfirm', data, 24, 80)).toBe(1);
    // the fixture edit's preview rows — TUI-DESIGN-4 §6.2 (S5's `diffRows`) re-shapes the body, so the pin is the
    // delegation (`previewWant(req)`), not a row count this file does not own
    expect(overlayPreviewWant('review', data)).toBe(previewWant(data.review!.req));
    expect(overlayPreviewWant('review', data)).toBeGreaterThan(0);
    expect(overlayPreviewWant('palette', data)).toBe(0);
  });
});

describe('<Overlay> (§0, §24)', () => {
  it('exit confirm: the one §24 row', () => {
    const ui = render(<Overlay kind="exitConfirm" rows={1} previewRows={0} columns={80} terminalRows={24} top={0} data={{}} />);
    expect(strip(ui.lastFrame())).toEqual([EXIT_CONFIRM_ROW]);
    expect(EXIT_CONFIRM_ROW).toBe('a run is live: [y] abort and exit   [n] stay              (Enter does nothing)');
  });

  it('minimum-size notice (degraded) and its ASCII twin', () => {
    const ui = render(<Overlay kind="none" rows={1} previewRows={0} columns={80} terminalRows={6} top={0} data={{}} degraded="minsize" />);
    expect(strip(ui.lastFrame())).toEqual(['terminal 80×6 is below the 40×8 minimum — panes hidden, transcript above']);
    expect(minsizeNotice(80, 6, GLYPHS.ascii)).toBe('terminal 80x6 is below the 40x8 minimum - panes hidden, transcript above');
  });

  it('secret gate row, follow-up box (5 rows, F-P) and blocking pane (F-U) render their shared lines within the rows', () => {
    const gate = render(<Overlay kind="secret" rows={1} previewRows={0} columns={80} terminalRows={24} top={0} data={{ secret: { hits: detectSecrets(`sk-ant-api03-${'A'.repeat(40)}`) } }} />);
    expect(strip(gate.lastFrame())).toEqual(['Looks like this contains a secret (sk-ant-…). Send anyway? y/N']);
    cleanup();
    const box = render(<Overlay kind="followup" rows={5} previewRows={0} columns={80} terminalRows={24} top={0} data={{ followup }} />);
    const rows = strip(box.lastFrame());
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^╭ follow-up would exceed the session cap ─+╮$/);
    expect(rows[1]).toContain('[y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel');
    expect(rows[3]).toContain('Enter does nothing here. A clamped run stops at the session cap (spend_cap).');
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(80);
    cleanup();
    const pane = render(<Overlay kind="blocking" rows={4} previewRows={0} columns={80} terminalRows={24} top={0} data={{ blocking }} />);
    const b = strip(pane.lastFrame());
    expect(b).toHaveLength(4);
    expect(b[0]).toBe('jev: key rejected (HTTP 401 — "User not found.")');
    expect(b[3]).toBe('[r] retry with the current key   [l] /login   [q] stop (exit 2)');
    cleanup();
    const two = render(<Overlay kind="blocking" rows={2} previewRows={0} columns={80} terminalRows={24} top={0} data={{ blocking }} />);
    expect(strip(two.lastFrame())).toHaveLength(2);
  });

  it('palette: ≤ rows rows, the footer last, the selected row marked, the mention popup reuses the slot', () => {
    const ui = render(<Overlay kind="palette" rows={8} previewRows={0} columns={80} terminalRows={24} top={0} data={{ palette: { query: '/b', state: paletteState, selected: 0 } }} />);
    const rows = strip(ui.lastFrame());
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0]).toMatch(/^▌ \/budget/);
    // TUI-DESIGN-4 §4.4 (S4's `paletteFooter`): the footer is now state-aware and names what Enter does *here*
    expect(rows.at(-1)).toMatch(/Enter runs \/budget/);
    expect(rows.at(-1)).toMatch(/Esc (closes|clears)/);
    cleanup();
    const mention = render(<Overlay kind="palette" rows={4} previewRows={0} columns={80} terminalRows={24} top={0} data={{ mention: { rows: ['src/a.py', 'src/b.py', 'tests/test_a.py'], selected: 1 } }} />);
    const m = strip(mention.lastFrame());
    expect(m).toHaveLength(4);
    expect(m[1]).toBe('▌ src/b.py');
    expect(m[3]).toContain('Enter inserts @path');
  });

  it('review: the header and preview through <Review>; undo: the one-row ask; nothing for `none`', () => {
    const req = mkConfirmRequest('c1', 7);
    const ui = render(<Overlay kind="review" rows={8} previewRows={4} columns={80} terminalRows={24} top={0} data={{ review: { req, note: null } }} />);
    const rows = strip(ui.lastFrame());
    expect(rows).toHaveLength(12);
    expect(rows[0]).toContain('review  step 7');
    cleanup();
    const ask = 'src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort';
    const undo = render(<Overlay kind="undo" rows={1} previewRows={0} columns={120} terminalRows={24} top={0} data={{ undo: { row: ask } }} />);
    expect(strip(undo.lastFrame())).toEqual([ask]);
    cleanup();
    const narrow = render(<Overlay kind="undo" rows={1} previewRows={0} columns={80} terminalRows={24} top={0} data={{ undo: { row: ask } }} />);
    expect(stringWidth(strip(narrow.lastFrame())[0] ?? '')).toBeLessThanOrEqual(80);
    cleanup();
    const none = render(<Overlay kind="none" rows={0} previewRows={0} columns={80} terminalRows={24} top={0} data={{}} />);
    expect(none.lastFrame()).toBe('');
  });

  it('wizard: the provider step rows (F-M) with the ASCII / screen-reader twins', () => {
    const state = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    const ui = render(<Overlay kind="wizard" rows={3} previewRows={0} columns={80} terminalRows={24} top={0} data={{ wizard: { state, trust: null } }} />);
    const rows = strip(ui.lastFrame());
    expect(rows).toEqual(['No API key found. Pick the generator provider:', '  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)', 'Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)']);
    cleanup();
    const sr = render(<Overlay kind="wizard" rows={3} previewRows={0} columns={80} terminalRows={24} top={0} data={{ wizard: { state, trust: null } }} screenReader />);
    expect(strip(sr.lastFrame())[2]).toBe('Enter selection (1-2):');
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.5 (P-R4, P-R6) and §2.6 (P-R7) — the minsize ladder and the confirm ladders.
// ---------------------------------------------------------------------------------------
describe('the minimum-size notice is a measured ladder (TUI-DESIGN-4 §2.5, P-R4)', () => {
  it('the five rungs of §12, byte for byte, at `30×5`', () => {
    expect(minsizeRungs(30, 5)).toEqual([
      'terminal 30×5 is below the 40×8 minimum — panes hidden, transcript above',
      '30×5 < 40×8 minimum — panes hidden',
      'too small: need 40×8',
      'need 40×8',
      '40×8 min',
    ]);
    expect(minsizeRungs(30, 5).map(cellWidth)).toEqual([72, 34, 20, 9, 8]);
  });

  it('§2.5: the rung is chosen by MEASURING the formatted candidate — three-digit dimensions widen the top rung', () => {
    expect(cellWidth(minsizeRungs(30, 5)[0]!)).toBe(72);
    expect(cellWidth(minsizeRungs(100, 5)[0]!)).toBe(73);
    expect(cellWidth(minsizeRungs(200, 3)[0]!)).toBe(73);
    // …so the choice must be a measurement: the top rung fits at exactly 72 cells and drops out one cell below
    expect(cellWidth(minsizeRungs(72, 5)[0]!)).toBe(72);
    expect(minsizeNotice(72, 5)).toBe(minsizeRungs(72, 5)[0]);
    expect(minsizeNotice(71, 5)).toBe(minsizeRungs(71, 5)[1]);
    // and a three-digit width needs one more cell for the same sentence, which a constant threshold cannot know
    expect(cellWidth(minsizeRungs(100, 5)[0]!)).toBe(73);
    expect(minsizeNotice(100, 5)).toBe(minsizeRungs(100, 5)[0]);
  });

  it('the short dimension is NAMED — the measured misreading `terminal 30×40 is below the 4…` cannot recur', () => {
    expect(minsizeRungs(100, 5)[2]).toBe('too short: need 8 rows');
    expect(minsizeRungs(30, 40)[2]).toBe('too narrow: need 40 cols');
    expect(minsizeRungs(30, 5)[2]).toBe('too small: need 40×8');
    expect(minsizeRungs(100, 5)[3]).toBe('need 8 rows');
    expect(minsizeRungs(30, 40)[3]).toBe('need 40 cols');
    expect(minsizeNotice(24, 40)).not.toMatch(/…$/);
    expect(minsizeNotice(24, 40)).toContain('cols');
  });

  it('§10 S2: `cellWidth(notice) ≤ columns` ALWAYS, at widths 10…80 × (short rows / short cols / both) × three-digit dimensions', () => {
    const cases: [number, number][] = [];
    for (let c = 10; c <= 80; c++) for (const r of [3, 5, 7, 40, 120]) cases.push([c, r]);
    cases.push([100, 5], [100, 120], [200, 3], [39, 8], [40, 7]);
    for (const [c, r] of cases) {
      for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
        const notice = minsizeNotice(c, r, g);
        expect(cellWidth(notice), `${c}×${r}`).toBeLessThanOrEqual(c);
        // and it is the *widest* rung that fits — never a narrower one, never a truncation
        const rungs = minsizeRungs(c, r, g);
        const widest = rungs.find((x) => cellWidth(x) <= c) ?? rungs.at(-1)!;
        expect(notice, `${c}×${r}`).toBe(cellWidth(widest) <= c ? widest : notice);
        if (cellWidth(widest) <= c) expect(notice).not.toMatch(/…$/);
      }
    }
  });

  it('the `--ascii` twin is pure ASCII and `40x8`, and the boundary `40×8` is NOT minsize (the caller never asks)', () => {
    const a = minsizeNotice(30, 5, GLYPHS.ascii);
    expect(a).toMatch(/^[\x20-\x7e]*$/);
    expect(minsizeRungs(30, 5, GLYPHS.ascii)[1]).toBe('30x5 < 40x8 minimum - panes hidden');
    // at 40×8 the layout is not degraded, so nothing here is drawn
    expect(computeLayout({ ...base, rows: 8, columns: 40 }).degraded).toBe('none');
    expect(computeLayout({ ...base, rows: 7, columns: 40 }).degraded).toBe('minsize');
    expect(computeLayout({ ...base, rows: 8, columns: 39 }).degraded).toBe('minsize');
  });

  it('round-4 review finding 11: with NEITHER dimension short the ladder states the minimum and nothing false', () => {
    // the old last arm (`need 40 cols`) was reached both when only the columns were short and when neither was, so
    // `minsizeRungs(100, 120)` claimed `too narrow: need 40 cols` about a 100-column terminal. Unreachable from
    // `computeLayout` — which is exactly why a test must not pin the false sentence as the contract.
    for (const [c, r] of [[100, 120], [40, 8], [80, 24], [200, 60]] as const) {
      expect(minsizeRungs(c, r), `${c}×${r}`).toEqual(['40×8 min']);
      expect(minsizeNotice(c, r), `${c}×${r}`).toBe('40×8 min');
      expect(computeLayout({ ...base, rows: r, columns: c }).degraded, `${c}×${r}`).toBe('none');
    }
    expect(minsizeRungs(100, 120, GLYPHS.ascii)).toEqual(['40x8 min']);
    // …and each of the three reachable cases still names the dimension that is actually short
    expect(minsizeRungs(100, 5)[2]).toBe('too short: need 8 rows');
    expect(minsizeRungs(30, 40)[2]).toBe('too narrow: need 40 cols');
    expect(minsizeRungs(30, 5)[2]).toBe('too small: need 40×8');
  });
});

describe('P-R6 (D4): the wizard survives minsize, read-only (TUI-DESIGN-4 §2.5)', () => {
  it('at minsize the overlay draws the notice AND a one-row wizard twin — never a composer prompt', () => {
    const state = { ...wizardState, step: 'options' as const };
    const ui = render(<Overlay kind="wizard" rows={2} previewRows={0} columns={38} terminalRows={7} top={0} degraded="minsize" data={{ wizard: { state, trust: null } }} />);
    const rows = strip(ui.lastFrame());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(minsizeNotice(38, 7));
    expect(rows[1]).toBe(wizardMinsizeRow(state, 38));
    expect(rows[1]).toContain('setup');
    for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(38);
  });

  it('round-4 review finding 1: the branch is keyed on the DATA, not on `kind` — `App.tsx` passes `kind=\'none\'` at minsize', () => {
    // `App.tsx:2248` is `kind={layout.degraded === 'minsize' ? 'none' : overlayKind}` (S1's file, §9.2), so a branch
    // gated on `kind === 'wizard'` is dead code as wired and D4 stays open. `overlayData.wizard` is non-null exactly
    // when `state.overlay === 'wizard'`, so the dispatch reads that instead and reaches a frame through the product
    // path today — this is the prop combination the App can actually produce.
    const state = { ...wizardState, step: 'options' as const };
    const asWired = render(<Overlay kind="none" rows={2} previewRows={0} columns={38} terminalRows={7} top={0} degraded="minsize" data={{ wizard: { state, trust: null } }} />);
    const rows = strip(asWired.lastFrame());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(minsizeNotice(38, 7));
    expect(rows[1]).toContain('setup');
  });

  it('one row granted (all `computeLayout` gives today): the WIZARD row wins — it names setup and the size', () => {
    const state = { ...wizardState, step: 'options' as const };
    const one = render(<Overlay kind="none" rows={1} previewRows={0} columns={38} terminalRows={7} top={0} degraded="minsize" data={{ wizard: { state, trust: null } }} />);
    const row = strip(one.lastFrame())[0] ?? '';
    expect(row).toBe(wizardMinsizeRow(state, 38, false, { alone: true }));
    expect(row).toContain('setup');
    expect(row).toContain('40×8'); // the generic notice is gone, so the row must carry the size itself
    expect(cellWidth(row)).toBeLessThanOrEqual(38);
    cleanup();
    // with no wizard open the notice is unchanged at one row, and a `key` step already names the size in its own row
    const other = render(<Overlay kind="none" rows={1} previewRows={0} columns={38} terminalRows={7} top={0} degraded="minsize" data={{}} />);
    expect(strip(other.lastFrame())).toEqual([minsizeNotice(38, 7)]);
    cleanup();
    const key = render(<Overlay kind="none" rows={1} previewRows={0} columns={60} terminalRows={7} top={0} degraded="minsize" data={{ wizard: { state: { ...wizardState, step: 'key' as const }, trust: null } }} />);
    expect(strip(key.lastFrame())[0]).toBe('setup · key — terminal too small; ≥ 40×8 to type');
  });

  it('edge 2: the minsize wizard row never draws a caret and never a key byte, at every field step', () => {
    for (const step of ['key', 'generatorKey', 'jevKey'] as const) {
      const state = { ...wizardState, step, length: 51 };
      const ui = render(<Overlay kind="none" rows={2} previewRows={0} columns={38} terminalRows={7} top={0} degraded="minsize" data={{ wizard: { state, trust: null } }} />);
      const row = strip(ui.lastFrame())[1] ?? '';
      expect(row).not.toContain('›');
      expect(row).not.toContain('sk-');
      expect(row).not.toContain('51');
      cleanup();
    }
  });
});

describe('exitConfirmRow is a fitRung ladder too (TUI-DESIGN-4 §2.6, P-R7)', () => {
  it('the ladder is monotone, every rung names both keys, and the chosen rung fits at every width 20…200', () => {
    expect(EXIT_CONFIRM_RUNGS[0]).toBe(EXIT_CONFIRM_ROW);
    const widths = EXIT_CONFIRM_RUNGS.map(cellWidth);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!, `${i}`).toBeLessThan(widths[i - 1]!);
    for (const r of EXIT_CONFIRM_RUNGS) {
      expect(r).toContain('[y]');
      expect(r).toContain('[n]');
    }
    for (let columns = 20; columns <= 200; columns++) {
      const inner = Math.max(0, columns - 4);
      const row = exitConfirmRow(inner);
      if (inner >= cellWidth(EXIT_CONFIRM_RUNGS.at(-1)!)) expect(cellWidth(row), `${columns}`).toBeLessThanOrEqual(inner);
      expect(row).toContain('[y]');
      expect(row).toContain('[n]');
    }
    // round 2's finding 5 is unchanged: at 80 columns (76 inner) the compact row, above it the §24 row
    expect(exitConfirmRow(76)).toBe(EXIT_CONFIRM_ROW_COMPACT);
    expect(exitConfirmRow(cellWidth(EXIT_CONFIRM_ROW))).toBe(EXIT_CONFIRM_ROW);
    // `(Enter does nothing)` — the statement that justifies the inert Enter — survives down to the third rung
    expect(exitConfirmRow(50)).toContain('Enter');
  });

  it('round-4 review finding 7: the PRODUCT path measures the rung in the glyph set it draws it in (§2.6 edge 2)', () => {
    // `Overlay.tsx`'s one call site dropped `g`, so the ladder was measured in the unicode table even under
    // `--ascii` — harmless only while the four rungs happen to be pure ASCII, and invisible to a test that passes
    // `g` itself. This renders the overlay through the product path and compares with the builder in the same set.
    for (const columns of [40, 44, 60, 80, 120]) {
      for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
        const ui = render(<Overlay kind="exitConfirm" rows={3} previewRows={0} columns={columns} terminalRows={24} top={0} data={{}} chrome={3} glyphs={g} />);
        const rows = strip(ui.lastFrame()).filter((r) => r.trim() !== '');
        const inner = Math.max(0, columns - 4);
        const expected = exitConfirmRow(inner, g);
        expect(rows.some((r) => r.includes(expected)), `${columns}/${g.mode}: ${JSON.stringify(rows)}`).toBe(true);
        for (const r of rows) expect(cellWidth(r), `${columns}/${g.mode}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
        cleanup();
      }
    }
  });

  it('§10 S2: the three §4.5 confirm ladders — at widths 20…200 the chosen rung fits `columns − 4` and names [y] and [n]', () => {
    // §10 S2 names this row in `overlay.test.tsx`; the ladders themselves are S4's `commands/confirm.ts`, and they
    // select through S2's `fitRung` (§9.2's `src/tui/fit.ts` row), so the gate belongs on both sides.
    const ladders = [CONFIRM_NEW_RUNGS, CONFIRM_ABORT_RUNGS, CONFIRM_EXIT_RUNGS];
    for (const rungs of ladders) {
      const widths = rungs.map(cellWidth);
      for (let i = 1; i < widths.length; i++) expect(widths[i]!, JSON.stringify(rungs[i])).toBeLessThan(widths[i - 1]!);
      for (const r of rungs) {
        expect(r).toContain('[y]');
        expect(r).toContain('[n]');
      }
    }
    for (const kind of ['new', 'abort', 'exit'] as const) {
      const rungs = confirmRungs(kind);
      const floor = cellWidth(rungs.at(-1)!);
      for (let columns = 20; columns <= 200; columns++) {
        for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
          const inner = Math.max(0, columns - 4);
          const row = confirmRow(kind, inner, g);
          expect(row, `${kind}/${columns}`).toContain('[y]');
          expect(row, `${kind}/${columns}`).toContain('[n]');
          if (inner >= floor) expect(cellWidth(row), `${kind}/${columns}`).toBeLessThanOrEqual(inner);
          expect(cellWidth(row), `${kind}/${columns}`).toBeLessThanOrEqual(Math.max(floor, inner));
        }
      }
    }
    // the ladder is TOTAL over `ConfirmKind`: `/history clear` keeps its own `y/N` and is not one (S4's `confirm.ts`)
    expect(['new', 'abort', 'exit'].every((k) => confirmRungs(k as 'new').length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.1 / §2.3 / §11 — the narrow ladder reaches EVERY overlay and card row.
//
// `ink-testing-library`'s stdout is a FIXED 100 columns (`build/index.js`: `get columns() { return 100 }`),
// so a *rendered* sweep above 100 measures Ink's own `wrap="truncate"`, not the product. The rendered half
// therefore stops at 80 and the 120-column rung is asserted over the pure line builders, which is where the
// width contract actually lives ("the cut is a function, never Ink clipping", `review/lines.ts:6`).
// ---------------------------------------------------------------------------------------
describe('the narrow ladder: no overlay row is wider than the terminal (§2.1 states 5, 9, 10, 11, 12; §11)', () => {
  const req = mkConfirmRequest('c1', 7);
  const ask = 'src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort';
  const data: OverlayData = {
    review: { req, note: null },
    followup,
    blocking,
    palette: { query: '/b', state: paletteState, selected: 0 },
    secret: { hits: detectSecrets(`sk-ant-api03-${'A'.repeat(40)}`) },
    undo: { row: ask },
    wizard: { state: wizardState, trust: null },
  };
  const KINDS = ['review', 'followup', 'blocking', 'palette', 'secret', 'undo', 'wizard', 'exitConfirm'] as const;
  const BOX = /^[╭│├╰+|]/;

  it.each([40, 44, 60, 80])('rendered at %i columns: every overlay row fits and no box row ends in the truncation ellipsis (V22)', (columns) => {
    for (const kind of KINDS) {
      for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
        const ui = render(<Overlay kind={kind} rows={8} previewRows={4} columns={columns} terminalRows={24} top={0} data={data} glyphs={g} />);
        const rows = strip(ui.lastFrame());
        expect(rows.length, `${kind}@${columns}`).toBeGreaterThan(0);
        for (const r of rows) {
          expect(cellWidth(r), `${kind}@${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
          // V22: a row that opens with a box glyph is a frame row; it must never END in the truncation ellipsis
          if (BOX.test(r)) expect(r.endsWith(g.ellipsis), `${kind}@${columns}: ${JSON.stringify(r)}`).toBe(false);
        }
        cleanup();
      }
    }
  });

  it.each([40, 44, 60, 80, 120])('the card builders at %i columns: every boxed row is exactly `columns` cells and the frame closes', (columns) => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      // the boxed builders: every row is exactly `columns` cells and the last row closes the frame
      for (const lines of [followupLines(followup, 8, columns, g), cardLines('exit?', [exitConfirmRow(Math.max(1, columns - 4), g)], columns, g)]) {
        expect(lines.length, `${columns}`).toBeGreaterThan(0);
        for (const r of lines) {
          expect(cellWidth(r), `${columns}: ${JSON.stringify(r)}`).toBe(columns);
          expect(r.endsWith(g.ellipsis), `${columns}: ${JSON.stringify(r)}`).toBe(false);
        }
        expect(lines.at(-1), `${columns}`).toBe(cardBottom(columns, g));
      }
      // the review card and the blocking pane degrade to flat rows at some rungs: the contract there is ≤ `columns`
      // `blockingLines` has no glyph parameter yet — §2.6 P-R7's `fitRung` rung for the blocking card is S6's file
      for (const lines of [reviewCardLines(req, 1, 4, columns, g), blockingLines(blocking, 4, columns)]) {
        for (const r of lines) expect(cellWidth(r), `${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
      }
      // the flat rows (no card): ≤ columns, never truncated to an ellipsis-only row
      for (const r of [minsizeNotice(columns, 5, g), exitConfirmRow(columns, g)]) {
        expect(cellWidth(r), `${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
        expect(r).not.toBe(g.ellipsis);
      }
    }
  });

});
