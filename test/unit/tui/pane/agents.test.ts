/**
 * TUI-DESIGN-5 §4.3 / §4.11 F-54 / §13.2 clause 6: the `'a'` pane tab's geometry.
 *
 * The rows themselves are `src/tui/agents/lines.ts`'s and are tested there; this file pins what the TAB adds —
 * the viewport (which scrolls, never filters), the scroll marker, the keys row (reachable only while focused) and
 * the summary row that must agree with the collapsed strip.
 */
import { describe, expect, it } from 'vitest';
import type { AgentState } from '../../../../src/core/types.js';
import { AGENTS_TAB_ROWS, agentStripText } from '../../../../src/tui/agents/lines.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { agentKeysRow, agentScrollRow, agentSummaryRow, agentTabRows, agentViewport } from '../../../../src/tui/pane/agents.js';
import { ALL_AGENT_STATES, F54_ROWS, mkAgentRow } from '../agents/fixtures.js';

const many = (n: number) => Array.from({ length: n }, (_, i) => mkAgentRow({ slug: `agent-${i}`, state: ALL_AGENT_STATES[i % 16] as AgentState }));

describe('the viewport scrolls, it never filters (§4.2, §13.2 clause 6)', () => {
  it('everything fits below the want: no marker, no scroll', () => {
    expect(agentViewport(5, 12, 0)).toEqual({ start: 0, end: 5, above: 0, below: 0 });
  });

  it('above the want the window centres on the cursor and reports what is off-screen', () => {
    expect(agentViewport(30, 10, 0)).toEqual({ start: 0, end: 10, above: 0, below: 20 });
    expect(agentViewport(30, 10, 15)).toEqual({ start: 10, end: 20, above: 10, below: 10 });
    expect(agentViewport(30, 10, 29)).toEqual({ start: 20, end: 30, above: 20, below: 0 });
  });

  it('a NaN / out-of-range cursor or want is clamped, never thrown', () => {
    expect(agentViewport(30, Number.NaN, Number.NaN).end).toBeGreaterThan(0);
    expect(agentViewport(30, 10, -5).start).toBe(0);
    expect(agentViewport(30, 10, 1e9).end).toBe(30);
  });

  it('the marker names both directions and is empty when nothing is hidden', () => {
    expect(agentScrollRow(0, 0)).toBe('');
    expect(agentScrollRow(3, 0)).toBe('… ↑3 above');
    expect(agentScrollRow(3, 4)).toBe('… ↑3 above · ↓4 below');
    expect(agentScrollRow(3, 4, GLYPHS.ascii)).toBe('... ^3 above - v4 below');
  });

  it('with 30 agents and 12 rows the tab still ACCOUNTS for all 30 (shown + above + below)', () => {
    const rows = agentTabRows({ agents: many(30) }, 14, 120, GLYPHS.unicode, { cursor: 0 });
    const marker = rows.find((l) => l.startsWith('…')) ?? '';
    const below = Number(/↓(\d+) below/.exec(marker)?.[1] ?? '0');
    const body = rows.filter((l) => !l.startsWith('agents ') && !l.startsWith('…') && l.trim() !== '');
    expect(body.length + below).toBe(30);
    expect(AGENTS_TAB_ROWS).toBe(12);
  });
});

describe('the tab at its row and column budgets (F-54, §4.12)', () => {
  it('never returns more rows than granted, at any grant from 1 to 20', () => {
    for (let n = 1; n <= 20; n++) expect(agentTabRows({ agents: F54_ROWS, paneFocus: true }, n, 120).length, `n=${n}`).toBeLessThanOrEqual(n);
  });

  it('never returns a row wider than the width, at any width from 4 to 200', () => {
    for (let w = 4; w <= 200; w += 7) for (const l of agentTabRows({ agents: F54_ROWS, paneFocus: true }, 12, w)) expect(cellWidth(l), `${w}: ${l}`).toBeLessThanOrEqual(w);
  });

  it('the keys row is drawn only while the tab is FOCUSED (unfocused the letters go to the composer, §4.3)', () => {
    const focused = agentTabRows({ agents: F54_ROWS, paneFocus: true }, 12, 120);
    const unfocused = agentTabRows({ agents: F54_ROWS, paneFocus: false }, 12, 120);
    expect(focused.some((l) => l.includes('Enter'))).toBe(true);
    expect(unfocused.some((l) => l.includes('Enter'))).toBe(false);
  });

  it('the keys row ladders down by width (§4.12: rung 1 at 120, rung 4 at 40)', () => {
    expect(agentKeysRow(120)).toBe('Enter attach · p pause · t steer · + budget · d diff · k kick · x x drop · l land');
    expect(agentKeysRow(40)).toBe('Enter · p · t · x x · l');
    for (const w of [20, 40, 80, 120]) expect(cellWidth(agentKeysRow(w)), `w=${w}`).toBeLessThanOrEqual(Math.max(w, cellWidth(agentKeysRow(1))));
  });

  it('an empty set is the empty state, not a blank tab', () => {
    expect(agentTabRows({ agents: [] }, 12, 120)).toEqual(['no agents in this run yet']);
    expect(agentTabRows({}, 12, 120)).toEqual(['no agents in this run yet']);
  });

  it('a zero row or column grant is zero rows (Ink loops on a 0-cell box)', () => {
    expect(agentTabRows({ agents: F54_ROWS }, 0, 120)).toEqual([]);
    expect(agentTabRows({ agents: F54_ROWS }, 12, 0)).toEqual([]);
  });

  it('the summary row and the collapsed strip count the same agents (§4.4: the two can never disagree)', () => {
    const summary = agentSummaryRow(F54_ROWS, 200, GLYPHS.unicode, true);
    const strip = agentStripText(F54_ROWS, { width: 200, dock: true });
    for (const part of ['agents 5', '✓1', '● 1', '⏸1']) {
      expect(summary, part).toContain(part);
      expect(strip, part).toContain(part);
    }
  });

  it('the summary OMITS a zero count, exactly as the strip does — a `✓0` cell is a bug, not a state (§13.2 clause 5)', () => {
    const one = [mkAgentRow({ slug: 'solo', state: 'running' })];
    expect(agentSummaryRow(one, 200)).toBe('agents 1 · ● 1');
    expect(agentStripText(one, { width: 200 })).toBe('agents 1 · ● 1 · $0.11/0.30');
    for (const row of [agentSummaryRow(one, 200), agentStripText(one, { width: 200 })]) {
      expect(row).not.toContain('✓0');
      expect(row).not.toContain('⏸0');
      expect(row).not.toContain('✗0');
    }
    // the two agree cell for cell: the strip is the summary plus the money (and the same dock cell)
    const tally = (l: string): string[] => l.split(' · ').filter((c) => !c.startsWith('$'));
    for (const rows of [one, F54_ROWS, [...F54_ROWS, mkAgentRow({ slug: 'z', state: 'crashed' })]]) {
      expect(tally(agentSummaryRow(rows, 200, GLYPHS.unicode, true))).toEqual(tally(agentStripText(rows, { width: 200, dock: true })));
    }
  });

  it('a set with only quiet states has no count cell at all, and never an all-zero one', () => {
    const quiet = [mkAgentRow({ slug: 'a', state: 'planned' }), mkAgentRow({ slug: 'b', state: 'done' })];
    expect(agentSummaryRow(quiet, 200)).toBe('agents 2');
    expect(agentStripText(quiet, { width: 200 })).toBe('agents 2 · $0.22/0.60');
  });
});

describe('§13.2 clause 6 / §4.2: the row budget is spent explicitly — nothing vanishes without saying so', () => {
  it('for every budget 2…20 and every row count 1…20: shown + above + below === rows.length, with a marker whenever rows are hidden', () => {
    for (let count = 1; count <= 20; count++) {
      const rows = many(count);
      for (let n = 2; n <= 20; n++) {
        for (const focused of [false, true]) {
          const out = agentTabRows({ agents: rows, paneFocus: focused }, n, 120);
          expect(out.length, `n=${n} count=${count}`).toBeLessThanOrEqual(n);
          const marker = out.find((l) => l.startsWith('…')) ?? '';
          const above = Number(/↑(\d+) above/.exec(marker)?.[1] ?? '0');
          const below = Number(/↓(\d+) below/.exec(marker)?.[1] ?? '0');
          const shown = out.filter((l) => !l.startsWith('agents ') && !l.startsWith('…') && !l.startsWith('Enter') && l.trim() !== '').length;
          expect(shown + above + below, `n=${n} count=${count} focused=${focused}: ${JSON.stringify(out)}`).toBe(count);
          if (shown < count) expect(marker, `n=${n} count=${count} focused=${focused}: no marker for ${count - shown} hidden rows`).not.toBe('');
        }
      }
    }
  });

  it('n = 2 with 6 agents shows the marker rather than 1 of 6 in silence (the `slice(0, n)` defect)', () => {
    const out = agentTabRows({ agents: many(6) }, 2, 120);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('agents 6');
    expect(out[1]).toBe('… ↓6 below');
  });

  it('n = 1 is the summary row, which NAMES every agent — the one declared exception, and not a filter', () => {
    const out = agentTabRows({ agents: many(6) }, 1, 120);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('agents 6');
  });

  it('the keys row is the FIRST thing dropped, before any agent row or the marker', () => {
    // at four rows there is room for the reminder; at three the row goes to information instead
    expect(agentTabRows({ agents: many(6), paneFocus: true }, 4, 120).some((l) => l.startsWith('Enter'))).toBe(true);
    expect(agentTabRows({ agents: many(6), paneFocus: true }, 3, 120).some((l) => l.startsWith('Enter'))).toBe(false);
    expect(agentTabRows({ agents: many(6), paneFocus: true }, 3, 120).some((l) => l.startsWith('…'))).toBe(true);
  });

  it('the viewport follows the CURSOR, so rows 13+ of a 30-row tree are reachable (§13.2 clause 6)', () => {
    const rows = many(30);
    const at = (cursor: number): string[] => agentTabRows({ agents: rows, agentCursor: cursor }, 14, 120);
    expect(at(0).some((l) => l.includes('agent-0'))).toBe(true);
    expect(at(0).some((l) => l.includes('agent-20'))).toBe(false);
    expect(at(20).some((l) => l.includes('agent-20'))).toBe(true);
    expect(at(29).some((l) => l.includes('agent-29'))).toBe(true);
    // and `agentTabRows`'s own `opts.cursor` still wins, for the callers that hold their own
    expect(agentTabRows({ agents: rows, agentCursor: 0 }, 14, 120, GLYPHS.unicode, { cursor: 29 }).some((l) => l.includes('agent-29'))).toBe(true);
  });
});
