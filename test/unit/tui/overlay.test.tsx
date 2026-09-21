/**
 * TUI-DESIGN §19.3 (`overlay.test.tsx`): the one modal slot — `overlayWant()` per kind (review 8 · wizard 2–4 ·
 * followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 · exitConfirm 1), every kind renders its shared
 * `lines()` rows inside a fixed-height box (never more than `rows`), the §24 strings verbatim (exit confirm, the
 * minimum-size notice, the secret gate, the follow-up box, the blocking pane), and the palette rows / footer.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockingRequest } from '../../../src/core/types.js';
import { EXIT_CONFIRM_ROW, Overlay, minsizeNotice, overlayPreviewWant, overlayWant, type OverlayData } from '../../../src/tui/Overlay.js';
import { INITIAL_ONBOARDING, onboardingReducer } from '../../../src/tui/onboarding/reducer.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';

afterEach(() => cleanup());

const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
const blocking: BlockingRequest = { id: 'b1', step: 0, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found."', sources: ['env JEV_API_KEY', 'OPENROUTER_API_KEY'], stop: 'error', exitCode: 2 };
const followup = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
const paletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };

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
    expect(overlayPreviewWant('review', data)).toBe(6); // the fixture edit's `--- old / +++ new` preview
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
    expect(rows[0]).toMatch(/^┌ follow-up would exceed the session cap ─+┐$/);
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
    expect(rows.at(-1)).toMatch(/Tab completes · Enter runs an exact match · Esc closes$/);
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
