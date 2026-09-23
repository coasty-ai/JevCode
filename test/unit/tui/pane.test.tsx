/**
 * TUI-DESIGN §19.3 (`pane.test.tsx`): the pane component draws the pure tab builders (`paneLines`) inside a
 * fixed-height box, the rule row carries the tab header (`paneRule`) or the plain rule before any run, the
 * picker's rows and header take the slot when given, rows are coloured by their marker word only, and
 * `paneStateOf` maps `UiState` 1.1 to the builders' input.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Pane, paneRowRole, paneRule, paneStateOf, plainRule } from '../../../src/tui/Pane.js';
import { brandSegment, paneLines, paneRuleRow, panelStrip, toDecisionRow } from '../../../src/tui/pane/model.js';
import { ruleRowText, type RuleRowInput } from '../../../src/tui/Pane.js';
import { brandRow, brandSpan } from '../../../src/tui/splash.js';
import { initialUiState, uiReducer } from '../../../src/tui/useEngine.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import { positionRungs } from '../../../src/tui/fullscreen/viewport.js';
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

/**
 * TUI-DESIGN-4 §1.2 P-H1 (D-T a) / §10 S1: the permanent `◆ jevcode` brand on the rule row's strip. `panelStrip`
 * itself is byte-for-byte round 2's without the option — only `ruleRowText` passes it, and only after the first
 * `run:ready` (before it the rule row is `plainRule` or `brandRow`, which already carry the brand).
 */
describe('the brand prefix on the strip (TUI-DESIGN-4 §1.2 P-H1, D-T a)', () => {
  const s = () => ({ ...paneState({ step: 4, rows: Array.from({ length: 7 }, (_x, i) => toRow(i)) }), latencies: [] as readonly (number | null)[] });
  const toRow = (i: number) => toDecisionRow(mkDecision({ step: 4, id: `d${i}` }));

  it('absent by default (round 2 byte for byte), present with `brand: true`, and always exactly `columns` cells', () => {
    for (const c of [24, 40, 64, 66, 80, 100, 120, 160, 200, 400, 500]) {
      const plainStrip = panelStrip(s(), c);
      const branded = panelStrip(s(), c, GLYPHS.unicode, { brand: true });
      expect(plainStrip, `${c}`).not.toContain('jevcode');
      expect(cellWidth(branded), `${c}`).toBe(Math.min(c, 400));
      expect(cellWidth(plainStrip), `${c}`).toBe(Math.min(c, 400));
    }
    // OWNER ADDENDUM: the collapsed strip is quiet — the hotkey legend is gone from it (the keys still work)
    expect(panelStrip(s(), 80, GLYPHS.unicode, { brand: true })).toBe('─── ◆ jevcode ─ ▸ jev s4 · 7 decisions · plan 2/5 ──────────────────────────────');
    expect(panelStrip(s(), 120, GLYPHS.unicode, { brand: true })).toBe('─── ◆ jevcode ─ ▸ jev s4 · 7 decisions · plan 2/5 ──────────────────────────────────────────────────────────────────────');
    // a MINIMAL strip (the state F-H1 and the `brand-strip` gate draw) keeps the brand from 64 columns up
    const bare = { ...paneState({ step: 4, rows: [], lastRisk: null, plan: null }), latencies: [] as readonly (number | null)[] };
    for (const c of [64, 66, 72, 80, 120, 200]) expect(panelStrip(bare, c, GLYPHS.unicode, { brand: true }), `${c}`).toContain('◆ jevcode');
  });

  it('it is the FIRST segment dropped: a strip without the brand is byte-for-byte round 2’s, and no information segment goes while the brand is up', () => {
    // the whole of edge 1: below the width at which the brand fits, the branded strip IS the brandless strip
    for (let c = 0; c <= 400; c += 1) {
      const branded = panelStrip(s(), c, GLYPHS.unicode, { brand: true });
      const bare = panelStrip(s(), c);
      if (!branded.includes('jevcode')) expect(branded, `${c}`).toBe(bare);
      // no information segment is ever dropped while the brand is still there (the brand goes first)
      else for (const seg of ['7 decisions', 'plan 2/5']) if (bare.includes(seg)) expect(branded, `${c} ${seg}`).toContain(seg);
    }
  });

  it('the `--ascii` twin is pure ASCII (`* jevcode`) and `NO_COLOR` changes no text', () => {
    const a = panelStrip(s(), 100, GLYPHS.ascii, { brand: true });
    expect(a).toMatch(/^[\x20-\x7e]*$/);
    expect(a.startsWith('--- * jevcode - > jev')).toBe(true);
    expect(cellWidth(a)).toBe(100);
    expect(brandSegment()).toBe('◆ jevcode ─ ');
    expect(brandSegment(GLYPHS.ascii)).toBe('* jevcode - ');
  });

  it('`brandSpan` finds the strip prefix and stops at `jevcode` (no version token follows)', () => {
    const row = panelStrip(s(), 100, GLYPHS.unicode, { brand: true });
    const span = brandSpan(row);
    expect(span).not.toBeNull();
    expect(row.slice(span!.from, span!.to)).toBe('◆ jevcode');
    const ascii = panelStrip(s(), 100, GLYPHS.ascii, { brand: true });
    const aspan = brandSpan(ascii, GLYPHS.ascii);
    expect(ascii.slice(aspan!.from, aspan!.to)).toBe('* jevcode');
    // a brandless strip still returns null (splash.test.ts:216's rule, kept)
    expect(brandSpan(panelStrip(s(), 100))).toBeNull();
  });

  it('through `ruleRowText`: the brand appears only after the first `run:ready`; the pre-run rows are unchanged', () => {
    const input = (over: Partial<RuleRowInput> = {}): RuleRowInput => ({ state: paneState({ step: 4 }), latencies: [], paneRows: 0, columns: 80, overlay: 'none', terminalRows: 24, panel: 'collapsed', splash: 'done', splashTime: null, ranBefore: false, version: '0.4.0', ...over });
    expect(ruleRowText(input())).toBe(brandRow('0.4.0', 80));
    expect(ruleRowText(input({ wordmark: true, paneRows: 5 }))).toBe(plainRule(80));
    const after = ruleRowText(input({ ranBefore: true }));
    expect(after.startsWith('─── ◆ jevcode ─ ▸ jev')).toBe(true);
    expect(cellWidth(after)).toBe(80);
    // D-T a: the strip brand and the 5-row mark COEXIST (F-H1, F-H2; TD3 §729 F-W5)
    expect(ruleRowText(input({ ranBefore: true, wordmark: true, paneRows: 5 }))).toBe(after);
    // below 64 columns the brand is dropped by the shrink loop (edge 1)
    expect(ruleRowText(input({ ranBefore: true, columns: 44 }))).not.toContain('jevcode');
    // a picker header still wins (edge 4), and below 40 columns the row is the plain rule
    expect(ruleRowText(input({ ranBefore: true, pickerHeader: 'header' }))).toBe('header');
    expect(ruleRowText(input({ ranBefore: true, columns: 30 }))).toBe(plainRule(30));
  });
});

/**
 * TUI-DESIGN-4 §1.2 P-H1 edge 5 and §1.3.2: the two option paths round 4 adds to the slot's most-pinned builders —
 * the panel tab header's brand, and the fullscreen position ladder as the strip's right segment with its own rung
 * ladder inside the SAME shrink loop. Drop order: **brand → position rungs (widest → narrowest → dropped) → pane
 * segments from the right**.
 */
describe('P-H1 edge 5 and the §1.3.2 position ladder', () => {
  const rows7 = Array.from({ length: 7 }, (_x, i) => toDecisionRow(mkDecision({ step: 4, id: `d${i}` })));
  /** the F-H3 / F-H4 / F-H5 state: `▸ jev s4 · 7 decisions` with no plan and no risk segment */
  const st = () => ({ ...paneState({ step: 4, rows: rows7, plan: null, lastRisk: null }), latencies: [] as readonly (number | null)[] });
  const panel = () => paneState({ step: 4, rows: rows7, plan: null, lastRisk: null });
  const POS = positionRungs(1227, 13, 3512);

  it('edge 5: `paneRuleRow({ brand: true })` prefixes the open / full panel header, and drops it first when narrow', () => {
    const s = panel();
    const wide = paneRuleRow(s, 12, 100, 'none', { terminalRows: 24, chevron: true, brand: true });
    expect(wide.startsWith('─── ◆ jevcode ─ ▾ decisions s4')).toBe(true);
    expect(cellWidth(wide)).toBe(100);
    // the same header without the option is byte-for-byte round 2's
    expect(paneRuleRow(s, 12, 100, 'none', { terminalRows: 24, chevron: true })).not.toContain('jevcode');
    // the brand is dropped FIRST when the header runs out of width; the row stays exactly `columns` cells
    for (let c = 40; c <= 200; c++) {
      const branded = paneRuleRow(s, 12, c, 'none', { terminalRows: 24, chevron: true, brand: true });
      const bare = paneRuleRow(s, 12, c, 'none', { terminalRows: 24, chevron: true });
      expect(cellWidth(branded), `${c}`).toBe(c);
      if (!branded.includes('jevcode')) expect(branded, `${c}`).toBe(bare);
    }
    expect(paneRuleRow(s, 12, 44, 'none', { terminalRows: 24, chevron: true, brand: true })).not.toContain('jevcode');
    // the `--ascii` twin
    const a = paneRuleRow(s, 12, 100, 'none', { terminalRows: 24, chevron: true, brand: true, glyphs: GLYPHS.ascii });
    expect(a).toMatch(/^[\x20-\x7e]*$/);
    expect(a.startsWith('--- * jevcode - v decisions s4')).toBe(true);
  });

  it('through `ruleRowText`: an open panel after the first run carries the brand; before it, it does not', () => {
    const input = (over: Partial<RuleRowInput> = {}): RuleRowInput => ({ state: panel(), latencies: [], paneRows: 6, columns: 100, overlay: 'none', terminalRows: 24, panel: 'open', splash: 'done', splashTime: null, ranBefore: true, version: '0.4.0', ...over });
    expect(ruleRowText(input()).startsWith('─── ◆ jevcode ─ ▾ ')).toBe(true);
    expect(ruleRowText(input({ panel: 'full', paneRows: 12 })).startsWith('─── ◆ jevcode ─ ▾ ')).toBe(true);
    // D-T a is satisfied in EVERY post-run state: collapsed, open and full all carry the word
    for (const pn of ['collapsed', 'open', 'full'] as const) expect(ruleRowText(input({ panel: pn, paneRows: pn === 'collapsed' ? 0 : 6 })), pn).toContain('jevcode');
    expect(ruleRowText(input({ ranBefore: false }))).not.toContain('jevcode');
  });

  it('F-H4 / F-H5: the branded strip with the position segment, byte-exact at 80, 44 and 40 columns', () => {
    expect(POS).toEqual(['1 240/3 512 · 35 % · PgUp', '35 % · PgUp', '35 %']);
    // F-H4 (fullscreen compact, 80 columns): brand + pane information + the widest rung, right-aligned.
    // The document's frame opens with TWO rule cells; `ruleRow` has opened every strip with three since round 2 and
    // every round-2 fixture pins that, so the one cell moved from the fill to the lead (deviation, reported).
    expect(panelStrip(st(), 80, GLYPHS.unicode, { brand: true, position: POS })).toBe('─── ◆ jevcode ─ ▸ jev s4 · 7 decisions ──────────── 1 240/3 512 · 35 % · PgUp ──');
    // F-H5 (fullscreen narrow, 44 columns): the brand went first, and the ladder is down to its 4-cell rung
    expect(panelStrip(st(), 44, GLYPHS.unicode, { brand: true, position: POS })).toBe('─── ▸ jev s4 · 7 decisions ───────── 35 % ──');
    // §1.3.2's sentence: "a 40-column fullscreen strip reads `── ▸ jev s4 · 7 decisions ── 35 % ──`"
    const at40 = panelStrip(st(), 40, GLYPHS.unicode, { brand: true, position: POS });
    expect(at40).toBe('─── ▸ jev s4 · 7 decisions ───── 35 % ──');
    expect(cellWidth(at40)).toBe(40);
    // the `--ascii` twin of the narrow rung
    expect(panelStrip(st(), 44, GLYPHS.ascii, { brand: true, position: POS })).toBe('--- > jev s4 - 7 decisions --------- 35 % --');
  });

  it('the drop order over columns 0…400: brand before any rung, every rung before any pane segment', () => {
    for (let c = 0; c <= 400; c++) {
      const row = panelStrip(st(), c, GLYPHS.unicode, { brand: true, position: POS });
      expect(cellWidth(row), `${c}`).toBe(Math.min(c, 400));
      const rung = POS.findIndex((r) => row.includes(r));
      // the brand only survives while the WIDEST rung is still up (it is dropped strictly first)
      if (row.includes('◆ jevcode')) expect(rung, `${c}: brand up but rung ${rung}`).toBe(0);
      // no pane segment is dropped while any rung is still drawn
      const bare = panelStrip(st(), c, GLYPHS.unicode, { position: POS });
      if (rung !== -1) for (const seg of ['7 decisions']) if (bare.includes(seg)) expect(row, `${c} ${seg}`).toContain(seg);
    }
    // the ladder degrades monotonically as the row narrows and never improves
    let worst = 0;
    for (let c = 400; c >= 0; c--) {
      const row = panelStrip(st(), c, GLYPHS.unicode, { brand: true, position: POS });
      const rung = POS.findIndex((r) => row.includes(r));
      const level = rung === -1 ? POS.length : rung;
      expect(level, `${c}`).toBeGreaterThanOrEqual(worst);
      worst = level;
    }
    // OWNER ADDENDUM: absent `position` the classic strip is QUIET — no rung and no hotkey legend at all
    for (const c of [40, 44, 80, 120, 400]) {
      const classic = panelStrip(st(), c, GLYPHS.unicode, { brand: true });
      expect(classic, `${c}`).not.toContain('[d]');
      expect(classic, `${c}`).toContain('▸ jev');
      for (const r of POS) expect(classic, `${c} ${r}`).not.toContain(r);
    }
  });

  it('`ruleRowText({ position })`: the fullscreen rule row right-aligns the segment at 80 and 44 columns', () => {
    const input = (over: Partial<RuleRowInput> = {}): RuleRowInput => ({ state: panel(), latencies: [], paneRows: 0, columns: 80, overlay: 'none', terminalRows: 24, panel: 'collapsed', splash: 'done', splashTime: null, ranBefore: true, version: '0.4.0', ...over });
    expect(ruleRowText(input({ position: POS }))).toBe(panelStrip(st(), 80, GLYPHS.unicode, { brand: true, position: POS }));
    expect(ruleRowText(input({ columns: 44, position: POS }))).toBe(panelStrip(st(), 44, GLYPHS.unicode, { brand: true, position: POS }));
    // absent / null `position` is the classic tail, byte for byte
    expect(ruleRowText(input({ position: null }))).toBe(ruleRowText(input()));
    expect(ruleRowText(input())).not.toContain('[d]');
  });
});
