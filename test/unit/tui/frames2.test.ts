/**
 * TUI-DESIGN-2 §8.1 S4 (the twin test of §13 finding 2): every console status row of the §4.10 frames equals
 * `│ ` + statusLineText(frameState(id), W − 4) + ` │`, every rule row equals `panelStrip` / `paneRuleRow` / `brandRow`
 * / the plain rule for the frame's state, every console top edge equals `consoleTopEdge(badge, 'proj', W)` and every
 * card edge `cardTop` / `cardBottom` — so the drawings can never drift from the functions again. The frame states are
 * the ones the captions describe (jev-only session, `proj`, the 80×24 / 120×40 pairs).
 *
 * TUI-DESIGN-3 §8 S2: the round-2 `H-` drawings are frozen (docs/TUI-DESIGN-2.md takes pointer lines only this round), so their
 * idle rule rows keep `brandRow` — the idle truth of round 3 is the `F-W` set of docs/TUI-DESIGN-3.md §3.10 (dynamic rows only: the
 * plain rule or the strip, the 5-row mark with its caption / tagline from `wordmarkFrame`, the console edges and the status row),
 * rebuilt here from the twins with the jev-on caps. The round-2 spinner glyph (`⠹`) in H-D1 is folded to the D-P frame it drew.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EngineStatus, RunResult, SpendSnapshot, StageName } from '../../../src/core/types.js';
import { cardBottom, cardTop } from '../../../src/tui/card.js';
import { consoleBottom, consoleDivider, consoleTopEdge } from '../../../src/tui/console-lines.js';
import { GLYPHS, cellWidth, ruleRow } from '../../../src/tui/glyphs.js';
import { panelStrip, paneRuleRow, type PaneState } from '../../../src/tui/pane/model.js';
import { brandRow } from '../../../src/tui/splash.js';
import { spinnerGlyph } from '../../../src/tui/spinner.js';
import { wordmarkFrame } from '../../../src/tui/wordmark.js';
import { plainRule } from '../../../src/tui/Pane.js';
import { statusLineText, type GitZone, type StatusLineOptions, type StatusLineState } from '../../../src/tui/status/lines.js';
import { mkRunResult } from '../../fixtures/tui/fixtures.js';
import { frameGDecisions, workedRequest } from './pane/helpers.js';
import { toDecisionRow } from '../../../src/tui/pane/model.js';
import { reviewCardTitle } from '../../../src/tui/review/lines.js';

const DESIGN2 = fileURLToPath(new URL('../../../docs/TUI-DESIGN-2.md', import.meta.url));
const DESIGN3 = fileURLToPath(new URL('../../../docs/TUI-DESIGN-3.md', import.meta.url));
const VERSION = '0.2.0';
/** the version the round-3 frames were drawn with (package.json at the design's HEAD) */
const VERSION3 = '0.3.0';
/** the round-2 drawings predate D-P: their braille spinner cell is the D-P frame the same state draws today */
const R2_SPINNER = '⠹';

interface Frame {
  id: string;
  columns: number;
  rows: number;
  dynamic: number;
  scrollback: number;
  lines: string[];
}

function readFrames(path: string = DESIGN2, idRe: RegExp = /^\*\*(H-[A-Z0-9]+w?)\.\s+(.*)$/, rowsFirst = false): Frame[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const frames: Frame[] = [];
  for (let n = 0; n < lines.length; n++) {
    const m = idRe.exec(lines[n] ?? '');
    if (!m) continue;
    const caption = m[2] ?? '';
    // TUI-DESIGN-2 captions read `W×H (`; TUI-DESIGN-3 §3.10 captions read `rows×columns` (`24×80 (11 dynamic rows; …)`)
    const geo = /(\d+)×(\d+)[^(]*\(/.exec(caption);
    const dyn = /(\d+) dynamic rows?/.exec(caption);
    const sb = /(\d+) scrollback rows? above/.exec(caption);
    if (!geo || !dyn) continue;
    // a caption may wrap onto a few prose lines before the blank line and the fence (TUI-DESIGN-3 F-W3 / F-W5 / F-W9)
    let k = n + 1;
    while (k < lines.length && k <= n + 6 && lines[k] !== '```') k++;
    if (lines[k] !== '```') continue;
    const body: string[] = [];
    for (k++; k < lines.length && lines[k] !== '```'; k++) body.push(lines[k] ?? '');
    const a = Number(geo[1]);
    const b = Number(geo[2]);
    frames.push({ id: m[1] ?? '', columns: rowsFirst ? b : a, rows: rowsFirst ? a : b, dynamic: Number(dyn[1]), scrollback: sb ? Number(sb[1]) : 0, lines: body });
  }
  return frames;
}

// ---- the frame states (the captions of §4.10)
function usage(input = 0, output = 0, cost = 0): SpendSnapshot['generator'] {
  return { inputTokens: input, outputTokens: output, costUsd: cost, calls: 1 };
}
function spend(totalUsd: number, capUsd: number): SpendSnapshot {
  return { generator: usage(4000, 1500, totalUsd * 0.9), jev: usage(20000, 8000, totalUsd * 0.1), totalUsd, capUsd, exceeded: totalUsd >= capUsd };
}
function status(step: number, maxSteps: number, wallMs: number, s: SpendSnapshot, stage: StageName | 'idle' = 'propose'): EngineStatus {
  return { step, maxSteps, wallMs, maxWallMs: 7_200_000, stage, spend: s, stopReason: null };
}
function done(stopReason: RunResult['stopReason'], steps: number, wallMs: number): RunResult {
  return { ...mkRunResult(stopReason), steps, wallMs };
}
const git = (dirty: { modified: number; untracked: number }, ahead = 0): GitZone => ({ head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) }, ahead, behind: 0, dirty: { modified: dirty.modified, staged: 0, untracked: dirty.untracked }, linkedWorktree: false, frozen: false });
/** sparkline levels: ▂ = (125, 250] ms, ▁ = (0, 125] ms */
const L1 = 100;
const L2 = 200;

function base(over: Partial<StatusLineState> = {}): StatusLineState {
  return { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: null }, draft: { secretHits: 0 }, nowMs: 0, ...over };
}
const sess125 = { totalUsd: 0, capUsd: 1.25 };
const jevOnly = { mode: 'jev-only' as const, pending: null };
const jevLlm = { mode: 'jev-on' as const, pending: null };

interface FrameState {
  status: StatusLineState;
  options?: StatusLineOptions;
  /** the rule row builder for the frame */
  rule: (columns: number) => string;
  /** the console badge or hosted title; null for the flat frames */
  badge: string | null;
  /** a card's title when the frame has one */
  card?: string;
  /** TUI-DESIGN-4 D-Z: the title the DOCUMENT's frame carries, when round 4 changed the one the function builds */
  cardDoc?: string;
}

const riskState = (step: number, rows: number, risk: number, verdict: 'ok' | 'review', plan: [number, number] | null): PaneState => ({
  tab: 'd',
  step,
  rows: Array.from({ length: rows }, (_, i) => toDecisionRow({ ...frameGDecisions()[0]!, step, id: `d${i}` })),
  plan: plan ? { step, plan: { done: Array.from({ length: plan[0] }, (_, i) => ({ text: `done ${i}`, evidence: { step: i + 1, judged: 0.9 } })), remaining: Array.from({ length: plan[1] - plan[0] }, (_, i) => `todo ${i}`), unverified: [], harnessProblems: [], openProblems: [] } } : null,
  timeline: [],
  synth: null,
  mode: 'jev-only',
  lastRisk: { risk, verdict },
});

const STATES: Readonly<Record<string, (wide: boolean) => FrameState>> = {
  'H-A1': () => ({ status: base(), rule: (c) => ruleRow('', '', c).replace(/^.*$/, '─'.repeat(c)), badge: 'jev-only' }),
  'H-A2': () => ({ status: base(), rule: (c) => '─'.repeat(c), badge: 'jev-only' }),
  'H-A3': (wide) => ({ status: base({ spend: { run: null, session: sess125 }, git: wide ? git({ modified: 3, untracked: 1 }) : null }), rule: (c) => brandRow(VERSION, c), badge: 'jev-only' }),
  'H-B2': (wide) => ({ status: base({ spend: { run: null, session: sess125 }, git: wide ? git({ modified: 3, untracked: 1 }) : null, ...(wide ? { jevLatencies: [L2, L2, L1, L2] } : {}) }), rule: (c) => brandRow(VERSION, c), badge: 'jev-only' }),
  'H-C1': (wide) => ({ status: base({ spend: { run: null, session: sess125 }, git: wide ? git({ modified: 3, untracked: 1 }) : null, ...(wide ? { jevLatencies: [L2, L2, L1, L2, L2] } : {}) }), rule: (c) => brandRow(VERSION, c), badge: 'jev-only' }),
  'H-D1': (wide) => ({
    status: base({ run: 'live', mode: 'jev-only', status: status(3, 40, 41_000, spend(0, 0.25)), spend: { run: spend(0, 0.25), session: sess125 }, git: wide ? git({ modified: 1, untracked: 0 }) : null, ...(wide ? { jevLatencies: [L2, L1, L2, L1, L1, L2, L1, L2, L1, L1, L1, L2] } : {}), stageStartedAt: 0 }),
    options: { spinnerFrame: 2 },
    rule: (c) => panelStrip({ ...riskState(3, 9, 0.1, 'ok', [1, 3]), latencies: [110] }, c),
    badge: 'jev-only',
  }),
  'H-E1': (wide) => ({
    status: base({ mode: 'jev-on', done: done('max_steps', 7, 252_000), status: status(7, 7, 252_000, spend(0.31, 2), 'complete'), spend: { run: spend(0.31, 2), session: { totalUsd: 0.31, capUsd: 10 } }, git: wide ? git({ modified: 1, untracked: 0 }, 2) : null }),
    // the open (6-row) panel never goes side by side (TUI-DESIGN-2 §4.6: only `full` keeps TD's rule), so the header's terminal height is 0
    rule: (c) => paneRuleRow(riskState(7, 12, 0.44, 'review', [2, 5]), 6, c, 'none', { terminalRows: 0, chevron: true }),
    badge: 'jev+llm',
  }),
  'H-F1': (wide) => ({
    status: base({ run: 'live', mode: 'jev-on', overlay: 'review', status: status(7, 40, 252_000, spend(0.31, 2)), spend: { run: spend(0.31, 2), session: { totalUsd: 0.31, capUsd: 10 } }, git: wide ? git({ modified: 1, untracked: 0 }, 2) : null, pendingReview: workedRequest() }),
    rule: (c) => panelStrip({ ...riskState(7, 12, 0.44, 'review', [2, 5]), latencies: [244] }, c),
    badge: 'jev+llm',
    card: reviewCardTitle(workedRequest(), wide ? 120 : 80),
    // TUI-DESIGN-4 D-Z / §6.1: the title's target now names the edit's counts (`edit src/a.py +1 −1`), which
    // TUI-DESIGN-2's H-F1 frame predates (A6-1: an edit action used to name no counts at all). The document's own
    // row is still read back verbatim against THIS title, so a drift on either side is still a failure.
    cardDoc: reviewCardTitle(workedRequest(), wide ? 120 : 80).replace(' +1 −1', ''),
  }),
  'H-G1': (wide) => ({ status: base({ spend: { run: null, session: sess125 }, git: wide ? git({ modified: 0, untracked: 0 }) : null }), rule: (c) => brandRow(VERSION, c), badge: 'jev+llm · next run' }),
  'H-H2': (wide) => ({ status: base({ overlay: 'wizard', spend: { run: null, session: sess125 }, git: wide ? git({ modified: 0, untracked: 0 }) : null }), rule: (c) => brandRow(VERSION, c), badge: 'setup · generator key' }),
  'H-I1': (wide) => ({ status: base({ overlay: 'intake', spend: { run: null, session: sess125 }, git: wide ? git({ modified: 3, untracked: 1 }) : null }), rule: (c) => brandRow(VERSION, c), badge: 'jev-only', card: wide ? '"the date parsing" — run this as a task?' : 'run this as a task?' }),
  'H-J1': () => ({ status: base({ overlay: 'intake', spend: { run: null, session: sess125 }, modeBadge: jevOnly }), options: { flatBadge: true }, rule: (c) => brandRow(VERSION, c), badge: null }),
  'H-J2': () => ({ status: base({ spend: { run: null, session: sess125 }, modeBadge: jevOnly }), options: { flatBadge: true }, rule: (c) => brandRow(VERSION, c), badge: null }),
};
void jevLlm;

describe('TUI-DESIGN-2 §4.10 frames rebuilt from the twins (§8.1 S4, §13 finding 2)', () => {
  const frames = readFrames();
  it('every frame has a state', () => {
    for (const f of frames) expect(STATES[f.id.replace(/w$/, '')], f.id).toBeDefined();
  });
  it.each(frames.map((f) => ({ id: f.id, f })))('$id: rule row, console edges, status row and card edges equal the functions', ({ f }) => {
    const wide = f.id.endsWith('w');
    const st = STATES[f.id.replace(/w$/, '')]!(wide);
    const W = f.columns;
    const dynamic = f.lines.slice(f.scrollback);
    // the rule row
    expect(dynamic[0]).toBe(st.rule(W));
    expect(cellWidth(dynamic[0] ?? '')).toBe(W);
    if (st.badge === null) {
      // flat tier: the status row is the last dynamic row at the terminal width, the badge leading its left zone
      expect(dynamic.at(-1)).toBe(statusLineText(st.status, W, st.options ?? {}));
      return;
    }
    // the console: top edge, divider, status row, bottom edge
    const top = dynamic.findIndex((l) => l.startsWith('╭─ ') && l.endsWith(' proj ─╮'));
    expect(top, `${f.id} console top edge`).toBeGreaterThanOrEqual(0);
    expect(dynamic[top]).toBe(consoleTopEdge(st.badge, 'proj', W));
    const bottom = dynamic.length - 1;
    expect(dynamic[bottom]).toBe(consoleBottom(W));
    expect(dynamic[bottom - 2]).toBe(consoleDivider(W));
    const statusRow = statusLineText(st.status, W - 4, st.options ?? {});
    expect((dynamic[bottom - 1] ?? '').replace(R2_SPINNER, spinnerGlyph(st.options?.spinnerFrame ?? 0))).toBe(`│ ${statusRow} │`);
    // a card above the console: title edge and bottom edge from card.ts
    if (st.card !== undefined) {
      const cardTopRow = dynamic.findIndex((l) => l.startsWith('╭─ ') && !l.endsWith(' proj ─╮'));
      expect(cardTopRow, `${f.id} card top`).toBeGreaterThanOrEqual(0);
      expect(dynamic[cardTopRow]).toBe(cardTop(st.cardDoc ?? st.card, W, GLYPHS.unicode));
      // and the round-4 title still draws a full-width, well-formed card edge
      expect(cellWidth(cardTop(st.card, W, GLYPHS.unicode))).toBe(W);
      expect(dynamic[top - 1]).toBe(cardBottom(W));
    }
  });
});

// ---- TUI-DESIGN-3 §3.10: the F-W frames (dynamic rows only; the mark from `wordmarkFrame`, the jev-on caps)
const sess10 = { totalUsd: 0, capUsd: 10 };
const jevOn = { mode: 'jev-on' as const, pending: null };

interface FrameState3 extends FrameState {
  /** the wordmark rows expected between the rule row and the console (none for the flat frames) */
  mark: boolean;
  /** the status row is illustrative in the design (the wizard's flat form) — width and shape only */
  statusIllustrative?: boolean;
}

const STATES3: Readonly<Record<string, FrameState3>> = {
  'F-W1': { status: base({ spend: { run: null, session: sess10 } }), rule: (c) => plainRule(c), badge: 'jev+llm', mark: true },
  'F-W1w': { status: base({ spend: { run: null, session: sess10 }, git: git({ modified: 3, untracked: 1 }) }), rule: (c) => plainRule(c), badge: 'jev+llm', mark: true },
  'F-W3': { status: base({ run: 'starting', thinking: 'intake', spend: { run: null, session: sess10 } }), options: { spinnerFrame: 2 }, rule: (c) => plainRule(c), badge: 'jev+llm', mark: true },
  'F-W5': { status: base({ ready: { step: 3, maxSteps: 40 }, spend: { run: null, session: { totalUsd: 0.04, capUsd: 10 } } }), rule: (c) => panelStrip({ ...riskState(3, 7, 0.12, 'ok', [1, 4]), latencies: [] }, c), badge: 'jev+llm', mark: true },
  'F-W7': { status: base({ spend: { run: null, session: sess10 }, modeBadge: jevOn }), options: { flatBadge: true }, rule: (c) => brandRow(VERSION3, c), badge: null, mark: false },
  // the smallest geometry: drawn before the session meter arrives (no `sess` zone at 60 inner cells)
  'F-W8': { status: base(), rule: (c) => plainRule(c), badge: 'jev+llm', mark: true },
  'F-W9': { status: base({ overlay: 'wizard', spend: { run: null, session: sess10 }, modeBadge: jevOn }), options: { flatBadge: true }, rule: (c) => brandRow(VERSION3, c), badge: null, mark: false, statusIllustrative: true },
};

describe('TUI-DESIGN-3 §3.10 F-W frames rebuilt from the twins (§8 S2; dynamic rows only)', () => {
  const frames = readFrames(DESIGN3, /^\*\*(F-W[0-9]+w?)\.\s+(.*)$/, true);
  it('finds F-W1, F-W1w, F-W3, F-W5, F-W7, F-W8 and F-W9 (F-W2 is an annotation, not a frame)', () => {
    expect(frames.map((f) => f.id)).toEqual(['F-W1', 'F-W1w', 'F-W3', 'F-W5', 'F-W7', 'F-W8', 'F-W9']);
    for (const f of frames) expect(STATES3[f.id], f.id).toBeDefined();
  });
  it.each(frames.map((f) => ({ id: f.id, f })))('$id: dynamic rows = caption, every row ≤ W, the rule row, the mark rows with caption / tagline, the console edges and the status row equal the functions', ({ f }) => {
    const st = STATES3[f.id]!;
    const W = f.columns;
    expect(f.scrollback).toBe(0);
    expect(f.lines.length).toBe(f.dynamic);
    expect(f.dynamic).toBeLessThanOrEqual(f.rows - 2);
    for (const row of f.lines) expect(cellWidth(row), `${f.id} row wider than ${W}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
    // the rule row
    expect(f.lines[0]).toBe(st.rule(W));
    expect(cellWidth(f.lines[0] ?? '')).toBe(W);
    // the mark: five rows from wordmarkFrame (caption iff it fits, tagline at ≥ 104 columns)
    if (st.mark) {
      const mark = wordmarkFrame({ columns: W, version: VERSION3 });
      expect(f.lines.slice(1, 6)).toEqual(mark.rows);
      expect(f.lines.slice(1, 6).some((r) => r.includes(`◆ ${VERSION3}`))).toBe(W >= 73);
      expect(f.lines[1]?.includes('Decisions, not strings')).toBe(W >= 104);
    } else {
      expect(f.lines.slice(1).some((r) => r.includes('██'))).toBe(false);
    }
    if (st.badge === null) {
      // flat tier: the status row is the last dynamic row at the terminal width
      const last = f.lines.at(-1) ?? '';
      if (st.statusIllustrative === true) expect(cellWidth(last)).toBeLessThanOrEqual(W);
      else expect(last).toBe(statusLineText(st.status, W, st.options ?? {}));
      return;
    }
    const top = f.lines.findIndex((l) => l.startsWith('╭─ ') && l.endsWith(' proj ─╮'));
    expect(top, `${f.id} console top edge`).toBe(st.mark ? 6 : 1);
    expect(f.lines[top]).toBe(consoleTopEdge(st.badge, 'proj', W));
    const bottom = f.lines.length - 1;
    expect(f.lines[bottom]).toBe(consoleBottom(W));
    expect(f.lines[bottom - 2]).toBe(consoleDivider(W));
    expect(f.lines[bottom - 1]).toBe(`│ ${statusLineText(st.status, W - 4, st.options ?? {})} │`);
  });
});
