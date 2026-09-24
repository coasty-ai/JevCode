/**
 * TUI-DESIGN-5 §4.2 / §10 (R5-4): the agent tree's row grammar.
 *
 * The table test is keyed off the `AgentState` union itself — `Record<AgentState, …>` — so a seventeenth member
 * fails to COMPILE here rather than rendering a blank cell (§4.2's stated property, gate G-R5-10's shape).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentState } from '../../../../src/core/types.js';
import {
  AGENTS_EMPTY,
  NO_RISK_DIMENSIONS,
  AGENTS_MIN_COLUMNS,
  AGENTS_SPEND_COLUMNS,
  AGENTS_WIDE_COLUMNS,
  agentRowRole,
  agentRowText,
  agentRows,
  agentStateGlyph,
  agentStateText,
  agentStripText,
  agentTailText,
  budgetRaisedText,
  conflictText,
  droppedText,
  landedText,
  noProgressText,
  notLandedText,
  orchestrationStripText,
  pausedNowText,
  pausingText,
  resumedText,
  steeredText,
  tallyAgents,
  wallText,
} from '../../../../src/tui/agents/lines.js';
import { blockWidth } from '../../../../src/tui/block/lines.js';
import { GLYPHS, cellWidth, type GlyphSet } from '../../../../src/tui/glyphs.js';
import { agentKeysRow, agentScrollRow, agentSummaryRow, agentTabRows } from '../../../../src/tui/pane/agents.js';
import { REVIEW_WHY_REFUSAL } from '../../../../src/tui/review/lines.js';
import { AGENTS_MIN_COLUMNS as STATUS_AGENTS_MIN_COLUMNS } from '../../../../src/tui/status/lines.js';
import { agentBlockHead, agentBlockLines, agentScreenReaderLines } from '../../../../src/tui/plain.js';
import { ALL_AGENT_STATES, F54_ROWS, mkAgentRow } from './fixtures.js';

const ASCII_RE = /^[\x20-\x7e]*$/;

/**
 * §4.2's sixteen words, VERBATIM. The literal is a total `Record<AgentState, string>`: adding a state to the union
 * without adding its word is a `tsc --strict` error on this object, which is the whole point of the shape.
 */
const EXPECTED: Readonly<Record<AgentState, string>> = {
  planned: 'queued',
  starting: 'starting',
  running: 'step 4/12 propose',
  paused: 'paused (you)',
  parked: 'parked (waiting on fix-store)',
  review: 'needs approval',
  stalled: 'no progress 11 m',
  done: 'done, not landed',
  landing: 'landing',
  landed: 'landed @8bc0d11',
  conflicted: 'conflicts in src/checkpoint/store.ts',
  'failed-verify': 'npm run lint failed',
  kicked: 'kicked (1/1)',
  dropped: 'dropped',
  crashed: 'crashed at step 4 (propose)',
  'failed-start': 'failed to start (127)',
};

/** the one detail cell each state's word interpolates (`AgentRow.why`), chosen to produce EXPECTED above. */
const WHY: Readonly<Record<AgentState, string>> = {
  planned: '',
  starting: '',
  running: '',
  paused: '',
  parked: 'waiting on fix-store',
  review: '',
  stalled: '11 m',
  done: '',
  landing: '',
  landed: '8bc0d11',
  conflicted: 'src/checkpoint/store.ts',
  'failed-verify': 'npm run lint',
  kicked: '1/1',
  dropped: '',
  crashed: '',
  'failed-start': '127',
};

describe('the sixteen AgentState words (TUI-DESIGN-5 §4.2, OR §4.6 verbatim)', () => {
  it.each(ALL_AGENT_STATES)('%s renders its exact word', (state) => {
    expect(agentStateText(mkAgentRow({ state, why: WHY[state] }))).toBe(EXPECTED[state]);
  });

  it('the union and the expectation table are the same sixteen members (a new state cannot slip past)', () => {
    expect(ALL_AGENT_STATES).toHaveLength(16);
    expect([...ALL_AGENT_STATES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(ALL_AGENT_STATES).size).toBe(16);
  });

  it('a state whose word needs a detail falls back to the bare word rather than printing `landed @` (§13.2)', () => {
    expect(agentStateText(mkAgentRow({ state: 'landed', why: '' }))).toBe('landed');
    expect(agentStateText(mkAgentRow({ state: 'conflicted', why: '' }))).toBe('conflicts');
    expect(agentStateText(mkAgentRow({ state: 'failed-verify', why: '' }))).toBe('verify failed');
    expect(agentStateText(mkAgentRow({ state: 'kicked', why: '' }))).toBe('kicked');
    expect(agentStateText(mkAgentRow({ state: 'parked', why: '' }))).toBe('parked');
    expect(agentStateText(mkAgentRow({ state: 'stalled', why: '' }))).toBe('no progress');
    expect(agentStateText(mkAgentRow({ state: 'failed-start', why: '' }))).toBe('failed to start');
  });

  it('every state has a glyph, and every glyph has an --ascii twin (§12.3 S60)', () => {
    const unicode = new Set<string>();
    for (const state of ALL_AGENT_STATES) {
      const u = agentStateGlyph(state, GLYPHS.unicode);
      const a = agentStateGlyph(state, GLYPHS.ascii);
      expect(u, state).not.toBe('');
      expect(a, `${state} ascii`).toMatch(ASCII_RE);
      unicode.add(u);
    }
    // §12.3 S60's own list: ten glyphs carry sixteen states
    expect(unicode.size).toBe(10);
    expect([...unicode].sort().join('')).toBe(['○', '◌', '●', '⏸', '⚠', '✓', '⟳', '✗', '↻', '−'].sort().join(''));
  });

  it('the glyph map is not injective but the WORD always distinguishes (conflicted vs crashed)', () => {
    expect(agentStateGlyph('conflicted')).toBe(agentStateGlyph('crashed'));
    expect(agentStateText(mkAgentRow({ state: 'conflicted', why: 'a.ts' }))).not.toBe(agentStateText(mkAgentRow({ state: 'crashed' })));
  });

  it('the colour role is the three-way split, and `null` for the quiet states', () => {
    expect(agentRowRole('landed')).toBe('ok');
    expect(agentRowRole('review')).toBe('warn');
    expect(agentRowRole('crashed')).toBe('error');
    expect(agentRowRole('running')).toBeNull();
  });
});

describe('the row at 40 / 80 / 120 (§4.12)', () => {
  const row = F54_ROWS[0] as ReturnType<typeof mkAgentRow>;

  it('40: glyph, slug and the state word only', () => {
    const t = agentRowText(row, { width: 40 });
    expect(t).toContain('tui-rows');
    expect(t).toContain('step 4/12 propose');
    expect(t).not.toContain('$');
    expect(cellWidth(t)).toBeLessThanOrEqual(40);
  });

  it('80: + $spent/cap and the wall', () => {
    const t = agentRowText(row, { width: 80 });
    expect(t).toContain('$0.11/0.30');
    expect(t).toContain('6m');
    expect(t).not.toContain('jevcode/tui-rows');
  });

  it('120: + the branch / verify column', () => {
    const t = agentRowText(row, { width: 120 });
    expect(t).toContain('jevcode/tui-rows');
    const landed = F54_ROWS[3] as ReturnType<typeof mkAgentRow>;
    expect(agentRowText(landed, { width: 120 })).toContain(`npm test ${GLYPHS.unicode.check}`);
  });

  it('the screen-reader twin drops the glyph column — the word already carries the fact', () => {
    const t = agentRowText(row, { width: 120, g: GLYPHS.sr, sr: true });
    expect(t.startsWith('tui-rows')).toBe(true);
    expect(t).not.toContain('●');
  });

  it('--ascii is pure ASCII at every width, including the six new glyph twins', () => {
    for (const r of F54_ROWS) for (const w of [40, 80, 120, 200]) expect(agentRowText(r, { width: w, g: GLYPHS.ascii }), `${r.slug}@${w}`).toMatch(ASCII_RE);
  });

  it('wallText is total and never negative', () => {
    expect(wallText(41_000)).toBe('41s');
    expect(wallText(6 * 60_000)).toBe('6m');
    expect(wallText(64 * 60_000)).toBe('1h04m');
    expect(wallText(Number.NaN)).toBe('0s');
    expect(wallText(-5)).toBe('0s');
  });

  it('the 120-column tail falls back through branch → own → empty', () => {
    expect(agentTailText(mkAgentRow({ branch: null, own: ['src/a/**', 'src/b/**'] }), GLYPHS.unicode)).toBe('src/a/** src/b/**');
    expect(agentTailText(mkAgentRow({ branch: null, own: [] }), GLYPHS.unicode)).toBe('');
  });
});

describe('agentRows never omits a row (§4.2, §13.2 clause 6)', () => {
  it('a property over widths 1…200 and row counts 1…40: the row count is always rows.length', () => {
    for (let n = 1; n <= 40; n += 3) {
      const rows = Array.from({ length: n }, (_, i) => mkAgentRow({ slug: `a${i}`, state: ALL_AGENT_STATES[i % 16] as AgentState }));
      for (let w = 1; w <= 200; w += 7) {
        const built = agentRows(rows, { width: w });
        expect(built, `n=${n} w=${w}`).toHaveLength(n);
      }
    }
  });

  it('no row is ever wider than the width it was built at (gate G-R5-6 shape)', () => {
    for (let w = 4; w <= 200; w += 3) {
      for (const r of F54_ROWS) expect(cellWidth(agentRowText(r, { width: w })), `${r.slug}@${w}`).toBeLessThanOrEqual(w);
    }
  });

  it('an empty set is the empty state, never zero rows', () => {
    const built = agentRows([], { width: 80 });
    expect(built).toHaveLength(1);
    expect(built[0]).toEqual({ kind: 'note', text: AGENTS_EMPTY });
  });
});

describe('the collapsed strip (§4.4, §12.3 S61 / S62)', () => {
  it('S61 at 80+: `agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓`', () => {
    const rows = [F54_ROWS[0], F54_ROWS[1], F54_ROWS[3]].filter((r): r is NonNullable<typeof r> => r !== undefined);
    expect(agentStripText(rows, { width: 80, dock: true })).toBe('agents 3 · ✓1 ● 1 ⏸1 · $0.36/0.90 · dock ✓');
  });

  it('S61 at 40 (AGENTS_MIN_COLUMNS): the counts drop, the money never does', () => {
    const rows = [F54_ROWS[0], F54_ROWS[1], F54_ROWS[3]].filter((r): r is NonNullable<typeof r> => r !== undefined);
    expect(agentStripText(rows, { width: AGENTS_MIN_COLUMNS })).toBe('agents 3 · $0.36/0.90');
    expect(AGENTS_MIN_COLUMNS).toBe(40);
    expect(AGENTS_SPEND_COLUMNS).toBe(80);
    expect(AGENTS_WIDE_COLUMNS).toBe(120);
  });

  it('an empty set has no strip at all (the segment is absent, not `agents 0`)', () => {
    expect(agentStripText([], { width: 120 })).toBe('');
  });

  it('S62 from `EngineStatus.orchestration`: the overshoot is OMITTED, never zeroed, when absent (§13.2 clause 5)', () => {
    const s = { manifestId: 'm', agents: 3, live: 2, landed: 1, reserveUsd: 0.9, heldUsd: 0.41 };
    expect(orchestrationStripText(s, { width: 120, spendUsd: 0.41, failed: 0, overshootUsd: 0.06 })).toBe('agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)');
    expect(orchestrationStripText(s, { width: 120, spendUsd: 0.41, failed: 0 })).toBe('agents 2/3 ✓1 ✗0 · $0.41/0.90');
  });

  it('S62 never DERIVES its failure count: 3 agents, 1 live, 0 landed, 2 parked is not `✗2` (§13.2 clause 5)', () => {
    const s = { manifestId: 'm', agents: 3, live: 1, landed: 0, reserveUsd: 0.9, heldUsd: 0.41 };
    const out = orchestrationStripText(s, { width: 120, spendUsd: 0.12 });
    // `agents − live − landed` would label both healthy parked children a failure
    expect(out).not.toContain('✗');
    expect(out).toBe('agents 1/3 ✓0 · $0.12/0.90');
    // supplied on the status object, or in the options, it is printed — including a known zero
    expect(orchestrationStripText({ ...s, failed: 2 }, { width: 120, spendUsd: 0.12 })).toContain('✗2');
    expect(orchestrationStripText(s, { width: 120, spendUsd: 0.12, failed: 0 })).toContain('✗0');
  });

  it('S62 never prints a HOLD as spend: with no spend figure the hold is named as one', () => {
    const s = { manifestId: 'm', agents: 3, live: 2, landed: 1, reserveUsd: 0.9, heldUsd: 0.41 };
    // `$0.41/0.90` here would claim 41 cents were SPENT; $0.41 is money reserved and not yet spent
    expect(orchestrationStripText(s, { width: 120 })).toBe('agents 2/3 ✓1 · held $0.41 of 0.90');
    expect(orchestrationStripText(s, { width: 120 })).not.toMatch(/\$0\.41\/0\.90/);
  });

  it('tallyAgents is total over NaN money', () => {
    const t = tallyAgents([mkAgentRow({ spendUsd: Number.NaN, capUsd: Number.NaN })]);
    expect(t.total).toBe(1);
    expect(t.spendUsd).toBe(0);
  });
});

describe('§13.1 / §13.2 clause 6: the four render targets are ONE producer', () => {
  it('the `--plain` block, the Ink tab and `jevcode agents list` draw byte-identical row strings', () => {
    for (const columns of [40, 80, 120]) {
      const width = blockWidth(columns);
      const plain = agentBlockLines(F54_ROWS, columns).filter((l) => l.trim() !== '');
      const direct = F54_ROWS.map((r) => agentRowText(r, { width, slugCells: Math.max(...F54_ROWS.map((x) => cellWidth(x.slug))) }));
      expect(plain, `columns=${columns}`).toEqual(direct);
      // the tab's body rows are the same strings; the tab adds only geometry (summary, marker, keys)
      const tab = agentTabRows({ agents: F54_ROWS }, 20, width).filter((l) => !l.startsWith('agents ') && !l.startsWith('…'));
      expect(tab, `tab columns=${columns}`).toEqual(direct);
    }
  });

  it("the `--plain` twin's row count equals rows.length, whatever the Ink tab's viewport does", () => {
    const rows = Array.from({ length: 30 }, (_, i) => mkAgentRow({ slug: `a${i}` }));
    expect(agentBlockLines(rows, 120).filter((l) => l.trim() !== '')).toHaveLength(30);
    // the tab at 12 rows shows fewer, and says so — it is a viewport, never a filter
    const tab = agentTabRows({ agents: rows }, 12, 120);
    expect(tab.length).toBeLessThan(30);
    expect(tab.some((l) => l.includes('below'))).toBe(true);
  });

  it('the screen-reader twin is the same rows without the glyph column, one per agent', () => {
    const sr = agentScreenReaderLines(F54_ROWS, 120);
    expect(sr).toHaveLength(F54_ROWS.length);
    for (const l of sr) expect(l).not.toMatch(/^[●○◌⏸⚠✓⟳✗↻−]/);
  });

  it('the head names the count (the `--plain` block and `annotateBlock` share it)', () => {
    expect(agentBlockHead(F54_ROWS)).toBe('agents (5)');
    expect(agentBlockHead([])).toBe('agents');
  });
});

describe('§12.3 S73 / S75 – S79: the six strings with no caller yet, anchored here (§13.4)', () => {
  /**
   * §13.1 row 6 gives S60–S86 one home — this module — and §13.4 makes a zero-match grep in the pin test a HARD
   * failure, not a skip. These six have no supervisor to call them in this build, exactly like S74 / S80–S83 /
   * S85, which were built for the same reason: an unbuilt anchor is a hole the inventory cannot see through.
   */
  it('S73: the five per-agent verb lines, verbatim', () => {
    expect(pausingText('tui-rows', 4, 'propose', 41_000)).toBe('pausing tui-rows · step 4 commits first (propose, 41s)');
    expect(pausedNowText('tui-rows', 4, 'propose')).toBe('paused tui-rows now at step 4 (propose): proposal kept — resume replays it');
    expect(resumedText('tui-rows', 5, true)).toBe('resumed tui-rows at step 5 (replayed the paused proposal; risk re-checked)');
    expect(resumedText('tui-rows', 5, false)).toBe('resumed tui-rows at step 5 (fresh step)');
    expect(steeredText('test-fixture', 1, 4)).toBe('steered test-fixture (1 queued for its step 4)');
    expect(budgetRaisedText('tui-rows', 0.3, 0.5, { spentUsd: 1.43, capUsd: 2 }, true)).toBe('tui-rows cap $0.30 → $0.50 (session $1.43/2.00) — resumed');
    expect(budgetRaisedText('tui-rows', 0.3, 0.5, { spentUsd: 1.43, capUsd: 2 }, false)).toBe('tui-rows cap $0.30 → $0.50 (session $1.43/2.00)');
  });

  it('S75: the land receipt names the dock branch, the merge commit and every verification', () => {
    expect(landedText('fix-store', 'jevcode/dock-a2fee9c1', '8bc0d11', [{ command: 'npm test', ok: true, tests: 412 }, { command: 'typecheck', ok: true }])).toBe('landed fix-store into jevcode/dock-a2fee9c1 @8bc0d11 · npm test ✓ (412) · typecheck ✓');
  });

  it('S76: the land refusal names what was removed and the two-step override', () => {
    expect(notLandedText('fix-store', 'removed 4 assertions in test/unit/store.test.ts')).toBe('fix-store not landed: removed 4 assertions in test/unit/store.test.ts — /agent fix-store land --anyway (twice) overrides');
  });

  it('S77: the conflict names the other child, the file, the lines and the kick budget', () => {
    expect(conflictText('fix-store', 'tui-rows', 'src/checkpoint/store.ts', { from: 361, to: 383 }, { n: 1, of: 1 })).toBe('fix-store conflicts with tui-rows in src/checkpoint/store.ts (lines 361–383) — kicked (1 of 1)');
  });

  it('S78: the drop says the branch is KEPT, because the commits are still reachable', () => {
    expect(droppedText('test-fixture', 'jevcode/test-fixture', 1)).toBe('dropped test-fixture (branch jevcode/test-fixture kept, 1 commit)');
    expect(droppedText('test-fixture', null, 2)).toBe('dropped test-fixture (no branch, 2 commits lost)');
  });

  it('S79: the no-progress row carries its evidence before its three keys', () => {
    expect(noProgressText('tui-rows', '11 m', 4)).toBe('tui-rows: no progress for 11 m (same step 4, no files changed) — [p] pause · [k] kick · [x] drop');
  });

  it('every one of the six has an --ascii twin and an SR twin (§12.3, no unicode leaks)', () => {
    const built = (g: GlyphSet): string[] => [
      pausingText('a', 1, 'propose', 1000, g),
      pausedNowText('a', 1, 'propose', g),
      resumedText('a', 1, true),
      steeredText('a', 1, 1),
      budgetRaisedText('a', 0.1, 0.2, { spentUsd: 1, capUsd: 2 }, true, g),
      landedText('a', 'jevcode/dock', 'abc1234', [{ command: 'npm test', ok: false }], g),
      notLandedText('a', 'r', g),
      conflictText('a', 'b', 'p.ts', { from: 1, to: 2 }, { n: 1, of: 1 }, g),
      droppedText('a', 'jevcode/a', 1),
      noProgressText('a', '11 m', 4, g),
    ];
    for (const l of built(GLYPHS.ascii)) expect(l, l).toMatch(ASCII_RE);
    // §12.3's SR column for all six rows is *same* / *spoken as written*: the SR twin is the unicode text, and
    // the assertion that matters is that it is never the ASCII one (`--ascii` wins over `screenReader`, §14.2 #53)
    expect(built(GLYPHS.sr)).toEqual(built(GLYPHS.unicode));
    expect(built(GLYPHS.sr)).not.toEqual(built(GLYPHS.ascii));
  });
});

describe('§13.4: one string, one home', () => {
  it('`REVIEW_WHY_REFUSAL` is defined EXACTLY once in src/ — a two-home string is the drift the inventory prevents', () => {
    const root = fileURLToPath(new URL('../../../../src', import.meta.url));
    const defs: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
          if (/export const REVIEW_WHY_REFUSAL\b/.test(readFileSync(full, 'utf8'))) defs.push(full);
        }
      }
    };
    walk(root);
    expect(defs.map((f) => f.slice(root.length + 1))).toEqual(['tui/review/lines.ts']);
    // and the one that survives is the one TD §6.2's ratified invariant allows: only `y` approves, Enter is inert
    expect(REVIEW_WHY_REFUSAL).toContain('[y] approves');
    expect(REVIEW_WHY_REFUSAL).not.toContain('[Enter] approves');
    // it is built AROUND this module's S65, so the two can never say different things about the same card
    expect(REVIEW_WHY_REFUSAL.startsWith(NO_RISK_DIMENSIONS)).toBe(true);
  });

  it('`AGENTS_MIN_COLUMNS` has one value in its two homes (§4.4: the strip rung and the segment gate)', () => {
    // the constant is declared here AND in `src/tui/status/lines.ts` (R5-2's file): `StatusLine.tsx` reads the
    // status copy as the default width while `agentStripText` compares against this one, so a change to either
    // alone silently changes which rung the status strip draws. R5-2 has the re-export request; this is the guard.
    expect(AGENTS_MIN_COLUMNS).toBe(STATUS_AGENTS_MIN_COLUMNS);
  });
});

describe('§13.2 clause 1 / §12: the --ascii and SR twins are width-correct too', () => {
  const many = Array.from({ length: 6 }, (_, i) => mkAgentRow({ slug: `agent-${i}`, state: ALL_AGENT_STATES[i % 16] as AgentState }));

  it('every row, keys row and summary fits its width under --ascii, whose twins are MULTI-cell (`...`, `<>`, `mail`)', () => {
    for (const g of [GLYPHS.ascii, GLYPHS.sr]) {
      for (let w = 8; w <= 200; w += 3) {
        for (const r of F54_ROWS) expect(cellWidth(agentRowText(r, { width: w, g })), `row ${r.slug}@${w} ${g.mode}`).toBeLessThanOrEqual(w);
        expect(cellWidth(agentSummaryRow(many, w, g, true)), `summary@${w} ${g.mode}`).toBeLessThanOrEqual(w);
        expect(cellWidth(agentScrollRow(3, 4, g)), `marker ${g.mode}`).toBeLessThanOrEqual(cellWidth(agentScrollRow(3, 4, GLYPHS.ascii)) + 8);
      }
      // the keys row ladders by MEASUREMENT, so its widest rung still fits 40 cells under a multi-cell twin
      for (const w of [40, 80, 120]) expect(cellWidth(agentKeysRow(w, g)), `keys@${w} ${g.mode}`).toBeLessThanOrEqual(w);
    }
  });

  it('a piped `--plain` twin (no TTY width) renders the 120-column form (§13.2 clause 1)', () => {
    const piped = agentBlockLines(F54_ROWS).filter((l) => l.trim() !== '');
    expect(piped).toEqual(agentBlockLines(F54_ROWS, AGENTS_WIDE_COLUMNS).filter((l) => l.trim() !== ''));
    // the columns the 80-cell default dropped survive the pipe: the block gutter takes 10 cells, so 120 is
    // `blockWidth(120) = 110` — the spend / wall rung — while 80 is 70 cells, below `AGENTS_SPEND_COLUMNS`
    expect(piped.join('\n')).toContain('$0.11/0.30');
    expect(piped.join('\n')).toContain('6m');
    expect(agentBlockLines(F54_ROWS, 80).join('\n')).not.toContain('$0.11/0.30');
    expect(agentScreenReaderLines(F54_ROWS).join('\n')).toContain('$0.11/0.30');
    // and the 120-column rung itself (the branch / verify column) is reached once the gutter is paid for
    expect(agentBlockLines(F54_ROWS, AGENTS_WIDE_COLUMNS + 10).join('\n')).toContain('jevcode/tui-rows');
  });
});
