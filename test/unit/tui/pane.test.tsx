/**
 * TUI-DESIGN §19.3 (`pane.test.tsx`): the pane component draws the pure tab builders (`paneLines`) inside a
 * fixed-height box, the rule row carries the tab header (`paneRule`) or the plain rule before any run, the
 * picker's rows and header take the slot when given, rows are coloured by their marker word only, and
 * `paneStateOf` maps `UiState` 1.1 to the builders' input.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Pane, paneRowRole, paneRule, paneStateOf, plainRule } from '../../../src/tui/Pane.js';
import { paneLines, paneRuleRow } from '../../../src/tui/pane/model.js';
import { initialUiState, uiReducer } from '../../../src/tui/useEngine.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';
import { paneState } from './pane/helpers.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');

describe('paneRule / plainRule (§7.2, §24)', () => {
  it('the plain rule before a run is `─` × columns (capped at 400); the tab header once the pane has rows', () => {
    expect(plainRule(80)).toBe('─'.repeat(80));
    expect(plainRule(80, GLYPHS.ascii)).toBe('-'.repeat(80));
    expect(plainRule(1000)).toHaveLength(400);
    const s = paneState();
    expect(paneRule(s, 0, 80, 'none', 24)).toBe('─'.repeat(80));
    const header = paneRule(s, 12, 80, 'none', 24);
    expect(header).toBe(paneRuleRow(s, 12, 80, 'none', { terminalRows: 24 }));
    expect(header).toMatch(/^─── decisions s7 · c~ derived \|2p−1\| ─+ \[d\]ecisions \[p\]lan \[t\]ime \[s\]ynth ──$/);
    expect(stringWidth(header)).toBe(80);
    // the picker header wins when the picker is open
    expect(paneRule(s, 12, 80, 'none', 24, GLYPHS.unicode, '─── sessions · proj ─')).toBe('─── sessions · proj ─');
    // below 40 columns: the plain rule (the header would not fit)
    expect(paneRule(s, 12, 30, 'none', 24)).toBe('─'.repeat(30));
  });
});

describe('<Pane>', () => {
  it('renders exactly `rows` truncating rows of the active tab, equal to paneLines', () => {
    const s = paneState();
    const ui = render(<Pane state={s} rows={5} columns={80} overlay="none" terminalRows={24} />);
    const rows = strip(ui.lastFrame());
    expect(rows).toEqual(paneLines(s, 5, 80, 'none', { terminalRows: 24 }));
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(80);
  });

  it('renders nothing for 0 rows; the picker override takes the slot with the selected row highlighted', () => {
    const none = render(<Pane state={paneState()} rows={0} columns={80} overlay="none" terminalRows={24} />);
    expect(none.lastFrame()).toBe('');
    cleanup();
    const ui = render(<Pane state={paneState()} rows={3} columns={80} overlay="none" terminalRows={24} lines={['▌ row a', '  row b', '  hint']} selected={0} />);
    expect(strip(ui.lastFrame())).toEqual(['▌ row a', '  row b', '  hint']);
  });

  it('side by side only under §7.2: columns ≥ 120 && rows ≥ 40 && overlay none', () => {
    const s = paneState();
    const wide = render(<Pane state={s} rows={12} columns={120} overlay="none" terminalRows={40} />);
    expect(strip(wide.lastFrame())[0]).toContain('│');
    cleanup();
    const overlaid = render(<Pane state={s} rows={12} columns={120} overlay="review" terminalRows={40} />);
    expect(strip(overlaid.lastFrame())[0]).not.toContain('│');
  });

  it('paneRowRole colours by the marker word only', () => {
    expect(paneRowRole('s7 risk  destructive L1 … [block]')).toBe('block');
    expect(paneRowRole('s7 risk  plan_mismatch L2 … [review]')).toBe('review');
    expect(paneRowRole('s7 intent intent edit … chosen [chosen]')).toBe('chosen');
    expect(paneRowRole('[!] replan s6 change_approach')).toBe('warn');
    expect(paneRowRole('(no decisions yet)')).toBe('dim');
    expect(paneRowRole('s7 judge succeeded noul …')).toBeNull();
  });

  it('paneStateOf maps the reducer state (tab, step, rows, plan, timeline, synth, mode)', () => {
    let s = initialUiState('t', null);
    s = uiReducer(s, { type: 'event', event: { type: 'run:start', runId: 'r', task: 't', mode: 'jev-only', resumedFromStep: null } });
    s = uiReducer(s, { type: 'event', event: { type: 'decision', decision: mkDecision({ step: 2 }) } });
    s = uiReducer(s, { type: 'event', event: { type: 'synth', step: 2, phase: 'verify', detail: 'tested 3/9' } });
    s = uiReducer(s, { type: 'tab', tab: 's' });
    const p = paneStateOf(s);
    expect(p.tab).toBe('s');
    expect(p.mode).toBe('jev-only');
    expect(p.rows).toHaveLength(1);
    expect(p.synth).toMatchObject({ step: 2, phase: 'verify' });
    expect(paneLines(p, 2, 80)[0]).toBe('synth  verify: tested 3/9');
  });
});
