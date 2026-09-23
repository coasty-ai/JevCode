/**
 * AGENT-LOOP-DESIGN §A3 / §A5 (slice S5a): which mini indicator a session state shows. The 3D block and its 12 fps tick
 * are gone; what is left is the choice of shape — the legacy modes by stage, agent mode by activity — and the status
 * row's use of it (the frame replaces the spinner glyph, the wide form gives its extra cells back before anything is
 * dropped, there is none under a screen reader, and it rides the spinner's tick).
 */
import { describe, expect, it } from 'vitest';
import { agentIndicatorKind, indicatorKindFor, type AgentActivity } from '../../../../src/tui/anim/Indicator.js';
import { MINI_NARROW_CELLS, MINI_WIDE_CELLS, miniFrame } from '../../../../src/tui/anim/frames.js';
import { statusLineText, statusSpans, statusZones, type StatusLineState } from '../../../../src/tui/status/lines.js';
import { initialUiState } from '../../../../src/tui/useEngine.js';
import { statusView } from '../../../../src/tui/StatusLine.js';
import { mkStatus } from '../../../fixtures/tui/fixtures.js';

describe('indicatorKindFor (legacy modes): the shape follows the stage', () => {
  it('a submission in flight or a starting run is the donut; a live run is a cube in execute, a wave in judge, a globe while a model or Jev is called', () => {
    expect(indicatorKindFor({ thinking: 'intake', run: 'none', stage: null, streaming: false })).toBe('donut');
    expect(indicatorKindFor({ thinking: null, run: 'starting', stage: null, streaming: false })).toBe('donut');
    expect(indicatorKindFor({ thinking: null, run: 'live', stage: 'execute', streaming: false })).toBe('cube');
    expect(indicatorKindFor({ thinking: null, run: 'live', stage: 'judge', streaming: false })).toBe('wave');
    for (const stage of ['propose', 'intent', 'risk', 'replan', 'context', 'decompose', 'coordinate'] as const) expect(indicatorKindFor({ thinking: null, run: 'live', stage, streaming: false }), stage).toBe('globe');
    expect(indicatorKindFor({ thinking: null, run: 'live', stage: 'idle', streaming: false })).toBe('donut');
    expect(indicatorKindFor({ thinking: null, run: 'none', stage: null, streaming: true })).toBe('donut');
  });

  it('none at idle: nothing in flight, nothing streaming', () => {
    expect(indicatorKindFor({ thinking: null, run: 'none', stage: null, streaming: false })).toBeNull();
    expect(indicatorKindFor({ thinking: null, run: 'none', stage: 'idle', streaming: false })).toBeNull();
  });
});

describe('agentIndicatorKind: the shape follows what the agent is doing (§A3)', () => {
  it('a model turn → donut · reading → globe · editing / running → cube · the harness tests → wave', () => {
    const want: Record<AgentActivity, string> = { thinking: 'donut', reading: 'globe', editing: 'cube', running: 'cube', testing: 'wave' };
    for (const [a, k] of Object.entries(want)) expect(agentIndicatorKind(a as AgentActivity), a).toBe(k);
  });
});

describe('the status row: the mini indicator replaces the spinner glyph', () => {
  const thinkingState = (): StatusLineState => ({ ...statusView(initialUiState('', null, { mode: 'session' })), thinking: 'intake' as const, run: 'starting' as const });
  const wide = miniFrame('donut', 2, MINI_WIDE_CELLS);
  const narrow = miniFrame('donut', 2, MINI_NARROW_CELLS);

  it('the wide frame leads the left word when the row has room, coloured like the spinner (accent)', () => {
    const row = statusLineText(thinkingState(), 76, { indicatorWide: wide, indicatorNarrow: narrow });
    expect(row.startsWith(`${wide} thinking`)).toBe(true);
    const spans = statusSpans(thinkingState(), 76, { indicatorWide: wide, indicatorNarrow: narrow });
    expect(spans.spans[0]).toEqual({ from: 0, to: wide.length, role: 'accent' });
  });

  it('no added cells at 80 columns: on a busy row the wide form narrows to the old 1-cell slot BEFORE anything else is dropped', () => {
    const busy: StatusLineState = {
      ...statusView({ ...initialUiState('', null, { mode: 'session' }), run: 'live', mode: 'agent', status: mkStatus(3, 'propose'), statusAt: 0, stageStartedAt: 0, nowMs: 1000 }),
      agentWord: 'thinking',
      spend: { run: mkStatus(3, 'propose').spend, session: { totalUsd: 0.13, capUsd: 50 } },
      ctx: 'ctx 41%',
    };
    const inner = 76;
    const spinner = statusZones(busy, inner, { spinnerFrame: 0 });
    const withMini = statusZones(busy, inner, { spinnerFrame: 0, indicatorWide: wide, indicatorNarrow: narrow });
    // the same segments survive as with the one-cell spinner glyph — the indicator costs the row nothing
    expect(withMini.right).toEqual(spinner.right);
    expect(withMini.dropped).toEqual(spinner.dropped);
    expect(withMini.left.startsWith(`${narrow} thinking`)).toBe(true);
    expect(statusLineText(busy, inner, { indicatorWide: wide, indicatorNarrow: narrow }).length).toBeLessThanOrEqual(inner);
  });

  it('without an indicator (a screen reader, the twins) the row keeps the spinner glyph and draws no braille', () => {
    const row = statusLineText(thinkingState(), 76, { spinnerFrame: 1 });
    expect(row).toMatch(/^▒ thinking/);
    expect(row).not.toMatch(/[⠀-⣿]/u);
  });
});
