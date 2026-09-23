import { describe, expect, it } from 'vitest';
import type { Decision } from '../../../../src/core/types.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import {
  NEAR_THRESHOLD_DELTA,
  SIDE_LEFT_CELLS,
  SIDE_RIGHT_CELLS,
  consumerRule,
  cycleTab,
  decisionText,
  defaultTab,
  foldByStep,
  foldPlanRecord,
  foldStageEnd,
  foldStepEnd,
  hasDelegation,
  nearThreshold,
  PANE_TABS,
  PANE_TABS_WITH_AGENTS,
  paneLines,
  paneRuleRow,
  paneTabsFor,
  panelStrip,
  sideBySide,
  TAB_TITLE,
  tabLines,
  tabStrip,
  toDecisionRow,
  type PaneOverlay,
  type PaneTab,
  type PlanView,
} from '../../../../src/tui/pane/model.js';
import { mkAgentRow } from '../agents/fixtures.js';
import { mkDecision } from '../../../fixtures/tui/fixtures.js';
import { frameDDecisions, frameDPlanView, paneState, planFixture, stepSevenDecisions } from './helpers.js';

const ASCII_RE = /^[\x20-\x7e]*$/;
/** a bar: a block glyph, or a run of track dots (the lone `·` is also the §24 separator, e.g. `unverified · no test evidence yet`) */
const BAR_RE = /[█▏▎▍▌▋▊▉]|·{3,}/;

const noul = (stage: Decision['stage'], id: string, p: number, over: Partial<Decision> = {}): Decision =>
  mkDecision({ stage, id, question: { type: 'noul', instructions: 'q', criteria: { true: { definition: 'yes it is' }, false: { definition: 'no it is not' } } }, answer: { type: 'noul', noul: p }, probability: p, confidence: Math.abs(2 * p - 1), ...over });
const score = (id: string, probs: Record<string, number>, over: Partial<Decision> = {}): Decision => {
  const kStar = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0';
  return mkDecision({ stage: 'risk', id, question: { type: 'score', instructions: 'q', criteria: ['l0', 'l1', 'l2', 'l3', 'l4'] }, answer: { type: 'score', score: Number(kStar), legend: {}, probabilities: probs, confidence: 0.5 }, probability: probs[kStar] ?? 0, confidence: 0.5, ...over });
};

describe('toDecisionRow: consumedBy (TUI-DESIGN §7.1 table)', () => {
  it.each<[string, Decision, string]>([
    ['intent.intent', stepSevenDecisions()[0]!, 'choice resolution → intent edit'],
    ['can_*', noul('intent', 'can_edit', 0.81), 'paired ≥ 0.5'],
    ['plan_still_valid', noul('intent', 'plan_still_valid', 0.88), '< 0.3 → stale_plan'],
    ['context.<path>', noul('context', 'src/a.py', 0.78), 'selected iff p ≥ 0.5'],
    ['risk harm dim (expected bound)', score('destructive', { '0': 0.1, '1': 0.9, '2': 0, '3': 0, '4': 0 }), 'band 0.3/0.7 (expected)'],
    ['risk alignment dim (tail bound)', score('plan_mismatch', { '0': 0.62, '1': 0.24, '2': 0.1, '3': 0.04, '4': 0 }), 'band 0.3/0.7 (tail)'],
    ['matches_intent', noul('risk', 'matches_intent', 0.88), '< 0.3 → appended to the reason'],
    ['evidence_consistent', noul('risk', 'evidence_consistent', 0.88), '< 0.3 → appended to the reason'],
    ['judge.succeeded', noul('judge', 'succeeded', 0.89), 'reported'],
    ['judge.error_present', noul('judge', 'error_present', 0.09), 'reported'],
    ['judge.new_information', noul('judge', 'new_information', 0.62), '≥ 0.7 → Plan rule b'],
    ['done_<j>', noul('judge', 'done_0', 0.78), '≥ 0.7 accept, < 0.3 reject'],
    ['task_complete', noul('complete', 'task_complete', 0.68), '≥ 0.85 → stop'],
    ['replan.next_move', mkDecision({ stage: 'replan', id: 'next_move', question: { type: 'choice', instructions: 'q', criteria: { change_approach: 'a', none_of_these: null } }, answer: { type: 'choice', choice: 'change_approach', probabilities: { change_approach: 0.7, none_of_these: 0.3 }, confidence: 0.4 }, probability: 0.7, verdict: 'chosen' }), 'choice resolution → move'],
    ['replan.can_*', noul('replan', 'can_change_approach', 0.7), 'paired ≥ 0.5'],
    ['task_impossible', noul('replan', 'task_impossible', 0.12), '≥ 0.85 → stop'],
    ['unknown id', noul('judge', 'tests_pass_unparsed', 0.5), 'reported'],
  ])('%s', (_name, d, expected) => {
    expect(toDecisionRow(d, 0.85).consumedBy).toBe(expected);
  });
  it('names the configured thresholds', () => {
    expect(toDecisionRow(noul('complete', 'task_complete', 0.9), 0.9).consumedBy).toBe('≥ 0.9 → stop');
    expect(toDecisionRow(noul('replan', 'task_impossible', 0.9), 0.85, 0.95).consumedBy).toBe('≥ 0.95 → stop');
  });
});

describe('toDecisionRow: near (TUI-DESIGN §7.1 `!` within 0.03)', () => {
  it('flags a context Noul at 0.52 (|0.52 − 0.5| = 0.02) and not at 0.54', () => {
    expect(toDecisionRow(noul('context', 'tests/test_a.py', 0.52), 0.85).near).toEqual({ threshold: 0.5, delta: expect.closeTo(0.02, 6) as number });
    expect(toDecisionRow(noul('context', 'tests/test_a.py', 0.54), 0.85).near).toBeNull();
    expect(toDecisionRow(noul('context', 'tests/test_a.py', 0.53), 0.85).near).not.toBeNull();
    expect(NEAR_THRESHOLD_DELTA).toBe(0.03);
  });
  it('measures a risk dimension on its consumed risk, not on p', () => {
    // tail mass 0.30 exactly: |risk − 0.30| = 0 → near, although p (the argmax level) is 0.70
    const d = score('plan_mismatch', { '0': 0.7, '1': 0, '2': 0, '3': 0.3, '4': 0 });
    const row = toDecisionRow(d, 0.85);
    expect(row.p).toBe(0.7);
    expect(row.near).toEqual({ threshold: 0.3, delta: expect.closeTo(0, 6) as number });
    // a far-from-band risk with p at 0.70 is not flagged
    expect(toDecisionRow(score('destructive', { '0': 0.7, '1': 0.3, '2': 0, '3': 0, '4': 0 }), 0.85).near).toBeNull();
  });
  it('picks the nearest of two thresholds and never flags a rule without one', () => {
    expect(toDecisionRow(noul('judge', 'done_0', 0.71), 0.85).near).toEqual({ threshold: 0.7, delta: expect.closeTo(0.01, 6) as number });
    expect(toDecisionRow(noul('judge', 'done_0', 0.29), 0.85).near?.threshold).toBe(0.3);
    expect(toDecisionRow(noul('complete', 'task_complete', 0.85), 0.85).near?.threshold).toBe(0.85);
    expect(toDecisionRow(stepSevenDecisions()[0]!, 0.85).near).toBeNull();
    expect(toDecisionRow(noul('judge', 'succeeded', 0.5), 0.85).near).toBeNull();
    expect(nearThreshold(Number.NaN, [0.5])).toBeNull();
    expect(nearThreshold(0.5, [])).toBeNull();
  });
});

describe('toDecisionRow: label, kind, c~, text, servedModel', () => {
  it('labels choice / score / noul and marks the derived confidence', () => {
    const [intent, canEdit, , , pm] = stepSevenDecisions();
    expect(toDecisionRow(intent!, 0.85)).toMatchObject({ kind: 'choice', label: 'edit', cDerived: false, verdict: 'chosen', p: 0.64, c: 0.55, latencyMs: 231 });
    expect(toDecisionRow(canEdit!, 0.85)).toMatchObject({ kind: 'noul', label: 'noul', cDerived: true });
    expect(toDecisionRow(pm!, 0.85)).toMatchObject({ kind: 'score', label: 'L0', servedModel: 'typesafe/jev-1.13-20260917' });
    expect(Object.hasOwn(toDecisionRow(canEdit!, 0.85), 'servedModel')).toBe(false);
  });
  it('text is the chosen option / level / favoured Noul side, ≤ 300 chars', () => {
    const [intent, canEdit, canVerify, , pm] = stepSevenDecisions();
    expect(decisionText(intent!)).toBe('change source');
    expect(decisionText(pm!)).toBe('matches `intent` and the plan');
    expect(decisionText(canEdit!)).toBe('edit is what plan.remaining calls for');
    expect(decisionText(canVerify!)).toBe('verify would repeat work or skip a prerequisite');
    const long = mkDecision({ question: { type: 'score', instructions: 'q', criteria: ['x'.repeat(1000), 'b', 'c', 'd', 'e'] }, answer: { type: 'score', score: 0, legend: {}, probabilities: { '0': 1 }, confidence: 1 } });
    expect(decisionText(long).length).toBeLessThanOrEqual(300);
    expect(decisionText(mkDecision({ question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.3 } }))).toBe('');
    expect(decisionText(mkDecision({ question: { type: 'choice', instructions: 'q', criteria: { a: { definition: 'def a', examples: [] } } }, answer: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 } }))).toBe('def a');
  });
  it('consumerRule quantity is p except for risk dimensions', () => {
    expect(consumerRule(noul('context', 'x', 0.4)).quantity).toBe(0.4);
    expect(consumerRule(score('plan_mismatch', { '0': 0.7, '3': 0.3 })).quantity).toBeCloseTo(0.3, 6);
  });
  it('consumerRule draws its operators with the glyph set (the row keeps the unicode form)', () => {
    expect(consumerRule(noul('context', 'x', 0.4), {}, GLYPHS.ascii).text).toBe('selected iff p >= 0.5');
    expect(consumerRule(stepSevenDecisions()[0]!, {}, GLYPHS.ascii).text).toBe('choice resolution -> intent edit');
    expect(consumerRule(noul('judge', 'new_information', 0.7), {}, GLYPHS.ascii).text).toBe('>= 0.7 -> Plan rule b');
    for (const d of stepSevenDecisions()) expect(consumerRule(d, {}, GLYPHS.ascii).text).toMatch(ASCII_RE);
    expect(toDecisionRow(noul('context', 'x', 0.4), 0.85).consumedBy).toBe('selected iff p ≥ 0.5');
  });
});

describe('folds', () => {
  it('foldByStep keeps the rows of the last 3 steps', () => {
    let m = new Map();
    for (const step of [5, 6, 7, 8]) m = foldByStep(m, toDecisionRow(noul('judge', 'succeeded', 0.5, { step }), 0.85));
    expect([...m.keys()].sort()).toEqual([6, 7, 8]);
    m = foldByStep(m, toDecisionRow(noul('judge', 'error_present', 0.1, { step: 8 }), 0.85));
    expect(m.get(8)?.length).toBe(2);
  });
  it('foldStageEnd accumulates per stage, newest step first, capped; NaN ms counts as 0', () => {
    let t = foldStageEnd([], { step: 1, stage: 'intent', ms: 100 });
    t = foldStageEnd(t, { step: 1, stage: 'intent', ms: 50 });
    t = foldStageEnd(t, { step: 2, stage: 'risk', ms: Number.NaN });
    expect(t.map((s) => s.step)).toEqual([2, 1]);
    expect(t[1]?.stages.intent).toBe(150);
    expect(t[0]?.stages.risk).toBe(0);
    for (let s = 3; s < 60; s++) t = foldStageEnd(t, { step: s, stage: 'judge', ms: 1 });
    expect(t.length).toBe(30);
    expect(t[0]?.step).toBe(59);
  });
  it('foldStepEnd fills totals and generator usage', () => {
    const t = foldStepEnd([], { step: 3, timing: { generatorMs: 1, jevMs: 2, execMs: 3, harnessMs: 31, totalMs: 8200 }, usage: { generator: { inputTokens: 5000, outputTokens: 400, costUsd: 0.032, calls: 1 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } } });
    expect(t[0]).toMatchObject({ step: 3, totalMs: 8200, harnessMs: 31, generatorTokens: 5400, generatorUsd: 0.032 });
  });
  it('foldPlanRecord keeps the step\u2019s claims in done_<j> order and its parsed test counts (§7.2 `p` data)', () => {
    const view: PlanView = { step: 7, plan: planFixture() };
    const judge = { succeeded: 0.9, errorPresent: 0.1, newInformation: 0.2, tests: { source: 'parsed' as const, allPassed: true, passed: 41, failed: 0, errors: 0, command: 'pytest' }, doneClaims: [{ text: 'fix parse_date tz handling', judged: 0.78, accepted: true }, { text: 'update CHANGELOG', judged: 0.52, accepted: false }] };
    const next = foldPlanRecord(view, { step: 7, judge: judge as never });
    expect(next.claimsByStep?.get(7)).toEqual(['fix parse_date tz handling', 'update CHANGELOG']);
    expect(next.testsByStep?.get(7)).toEqual({ passed: 41, failed: 0, errors: 0 });
    expect(view.claimsByStep).toBeUndefined();
    const again = foldPlanRecord(next, { step: 8, judge: { ...judge, tests: null, doneClaims: [] } as never });
    expect(again.claimsByStep?.has(8)).toBe(false);
    expect(again.claimsByStep?.get(7)).toEqual(['fix parse_date tz handling', 'update CHANGELOG']);
    expect(foldPlanRecord(view, { step: 9, judge: null })).toBe(view);
  });
});

describe('tabs, default tab, side-by-side rule (TUI-DESIGN §7.2)', () => {
  it('cycles d → p → t → s → d and back', () => {
    expect(cycleTab('d', 1)).toBe('p');
    expect(cycleTab('s', 1)).toBe('d');
    expect(cycleTab('d', -1)).toBe('s');
  });
  it('jev-only defaults to s while propose runs, d otherwise', () => {
    expect(defaultTab('jev-only', 'propose')).toBe('s');
    expect(defaultTab('jev-only', 'risk')).toBe('d');
    expect(defaultTab('jev-on', 'propose')).toBe('d');
    expect(defaultTab(null, null)).toBe('d');
  });
  it.each<[number, number, PaneOverlay, boolean]>([
    [40, 120, 'none', true],
    [50, 200, 'none', true],
    [39, 120, 'none', false],
    [40, 119, 'none', false],
    [40, 120, 'review', false],
    [40, 120, 'palette', false],
  ])('rows %d columns %d overlay %s → %s', (rows, columns, overlay, expected) => {
    expect(sideBySide(rows, columns, overlay)).toBe(expected);
  });
});

describe('paneRuleRow (§24 "Rule row")', () => {
  it('renders the §24 strings at 80 and the [t]imeline form at 120, exactly columns wide', () => {
    const s = paneState();
    expect(paneRuleRow(s, 12, 80, 'none')).toBe('─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──');
    expect(paneRuleRow({ ...s, tab: 'p' }, 12, 80, 'none')).toMatch(/^─── plan s7 · done 2 rem 3 unv 1 prob 2 ─+ \[d\]ecisions \[p\]lan \[t\]ime \[s\]ynth ──$/);
    expect(paneRuleRow({ ...s, tab: 't' }, 12, 80, 'none').startsWith('─── timeline s7 ')).toBe(true);
    expect(paneRuleRow({ ...s, tab: 's' }, 12, 80, 'none').startsWith('─── synth s7 ')).toBe(true);
    const wide = paneRuleRow(s, 12, 120, 'none');
    expect(wide).toMatch(/\[t\]imeline \[s\]ynth ─────$/);
    for (const c of [40, 59, 80, 120, 200]) expect(cellWidth(paneRuleRow(s, 12, c, 'none'))).toBe(c);
  });
  it('names the second tab when side by side and never exceeds 400 cells', () => {
    const s = paneState();
    expect(paneRuleRow(s, 12, 120, 'none', { terminalRows: 40 })).toMatch(/\[s\]ynth ─── plan ─$/);
    expect(paneRuleRow(s, 12, 120, 'review', { terminalRows: 40 })).toMatch(/\[s\]ynth ─────$/);
    expect(cellWidth(paneRuleRow(s, 12, 1000, 'none'))).toBe(400);
    expect(paneRuleRow(s, 12, 0, 'none')).toBe('');
  });
  it('has an ascii twin and drops the legend below 80 columns', () => {
    const s = paneState();
    expect(paneRuleRow(s, 12, 80, 'none', { glyphs: GLYPHS.ascii })).toMatch(/^[\x20-\x7e]*$/);
    expect(paneRuleRow(s, 12, 59, 'none')).toBe('─── decisions s7 ───── [d]ecisions [p]lan [t]ime [s]ynth ──');
    expect(paneRuleRow({ ...s, plan: null, tab: 'p' }, 12, 80, 'none').startsWith('─── plan s7 ─')).toBe(true);
  });
});

describe('paneLines (§7.2 lines(state, rows, columns, overlay))', () => {
  const tabs: PaneTab[] = ['d', 'p', 't', 's'];
  it('never returns more than rows rows nor a row wider than columns, every tab at 59/80/120 and rows 0..14', () => {
    for (const tab of tabs) {
      const s = paneState({ tab });
      for (const columns of [20, 59, 80, 120]) {
        for (let rows = 0; rows <= 14; rows++) {
          const lines = paneLines(s, rows, columns, 'none');
          expect(lines.length).toBeLessThanOrEqual(rows);
          for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
        }
      }
    }
  });
  it('goes side by side only under the rule: divider at cell 59, the next tab on the right headed by its summary (F-D)', () => {
    const s = paneState();
    const side = paneLines(s, 12, 120, 'none', { terminalRows: 40 });
    expect(side.length).toBe(8);
    for (const l of side) {
      expect(cellWidth(l)).toBeLessThanOrEqual(120);
      expect([...l.slice(0, 59)].length).toBe(59);
      expect(l[59]).toBe('│');
    }
    expect(side[0]!.slice(60)).toBe(' plan  done 2  remaining 3  unverified 1  problems 2');
    expect(side[1]!.slice(60)).toBe(' [x] add failing test for parse_date          s4 done_0 0.91');
    expect(side[3]!.slice(60)).toBe(' [?] update CHANGELOG                         s7 done_1 0.52');
    expect(side[0]!.slice(0, 59)).toBe('s7 intent  intent          edit  ██████▍··· 0.64 chosen    ');
    expect(side[6]!.slice(0, 59)).toBe('s7 complete task_complete  noul  ██████▊··· 0.68           ');
    expect(side[7]!.slice(0, 59)).toBe(' '.repeat(59));
    expect(side[7]!.slice(60)).toBe(' [!] rejected_claim s5: "tests pass" done_0 0.12');
    expect(SIDE_LEFT_CELLS + 1 + SIDE_RIGHT_CELLS).toBe(120);
    expect(paneLines(s, 12, 120, 'review', { terminalRows: 40 }).some((l) => l.includes('│'))).toBe(false);
    expect(paneLines(s, 12, 120, 'none', { terminalRows: 39 }).some((l) => l.includes('│'))).toBe(false);
    expect(paneLines(s, 12, 119, 'none', { terminalRows: 40 }).some((l) => l.includes('│'))).toBe(false);
    // the pane's own row budget never triggers it
    expect(paneLines(s, 12, 120, 'none').some((l) => l.includes('│'))).toBe(false);
  });
  it('above 120 columns both halves keep the narrow form and the 59 + 1 + 60 geometry (§7.2)', () => {
    const s = paneState();
    const at120 = paneLines(s, 12, 120, 'none', { terminalRows: 50 });
    const at200 = paneLines(s, 12, 200, 'none', { terminalRows: 50 });
    expect(at200).toEqual(at120);
    for (const l of at200) {
      expect(cellWidth(l)).toBeLessThanOrEqual(120);
      expect(l).not.toContain(' c 0.');
      expect(l).not.toMatch(/\d+ms {2}/);
    }
    // the plan on the left, the timeline on the right: both narrow, the right half never wider than 59 + the leading space
    const planLeft = paneLines({ ...s, tab: 'p' }, 12, 200, 'none', { terminalRows: 50 });
    expect(planLeft[0]!.slice(0, 59)).toBe('[x] add failing test for parse_date          s4 done_0 0.91');
    expect(planLeft[0]!.slice(60)).toBe(' time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  …');
    for (const l of planLeft) expect(cellWidth(l.slice(60))).toBeLessThanOrEqual(60);
    // a plan-less state on the right shows the placeholder, no summary row
    expect(paneLines({ ...s, plan: null }, 12, 200, 'none', { terminalRows: 50 })[0]!.slice(60)).toBe(' (no plan yet)');
  });
  it('renders the F-D pane modulo the frame\u2019s hand-drawn spacing (its left half is 61 cells, §7.2 says 59)', () => {
    const state = paneState({ tab: 'd', step: 3, rows: frameDDecisions().map((d) => toDecisionRow(d, 0.85)), plan: frameDPlanView() });
    const side = paneLines(state, 12, 120, 'none', { terminalRows: 50 });
    const collapse = (l: string): string => l.replace(/ +/g, ' ').trimEnd();
    expect(collapse(side[0]!)).toBe('s3 intent intent edit ██████▍··· 0.64 chosen │ plan done 2 remaining 4 unverified 1 problems 1');
    expect(collapse(side[1]!)).toBe('s3 intent can_edit noul ████████▏· 0.81 │ [x] add failing test for parse_date s1 done_0 0.91');
    expect(collapse(side[3]!)).toBe('s3 intent plan_still_val… noul ████████▊· 0.88 │ [?] update CHANGELOG s2 done_1 0.52');
    expect(collapse(side[7]!)).toBe('s2 judge succeeded noul █████████· 0.90 │ [!] replan s2 change_approach: try tz-aware parsing');
    expect(collapse(side[11]!)).toBe('s2 complete task_complete noul ████▍····· 0.44 │');
  });
  it('handles rows/columns of 0, NaN and Infinity', () => {
    const s = paneState();
    expect(paneLines(s, 0, 80)).toEqual([]);
    expect(paneLines(s, Number.NaN, 80)).toEqual([]);
    expect(paneLines(s, 5, 0)).toEqual([]);
    expect(paneLines(s, 5, Number.NaN)).toEqual([]);
    expect(paneLines(s, Number.POSITIVE_INFINITY, 80).length).toBe(0);
    expect(paneLines(s, 3, Number.POSITIVE_INFINITY).length).toBe(0);
  });
  it('renders the narrow content of every tab at 59 columns (§19.0 "every tab at 59/80/120")', () => {
    expect(paneLines(paneState({ tab: 'd' }), 12, 59)[0]).toBe('s7 intent  intent          edit  ██████▍··· 0.64 chosen');
    expect(paneLines(paneState({ tab: 'p' }), 12, 59)[0]).toBe('[x] add failing test for parse_date          s4 done_0 0.91');
    expect(paneLines(paneState({ tab: 'p' }), 12, 59)[5]).toBe('[!] replan s6 change_approach: try tz-aware parsing instea…');
    expect(paneLines(paneState({ tab: 't' }), 12, 59)[0]).toBe('time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  …');
    expect(paneLines(paneState({ tab: 't' }), 12, 59)[1]).toMatch(/^ {6}s7 {2}I+C+P+R+X+J+ {2}total …$/);
    expect(paneLines(paneState({ tab: 's' }), 12, 59)).toEqual(['synth  verify: tested 37/137 candidates at kth.py:12', '       candidates=137 tested=37']);
    expect(paneLines(paneState({ tab: 'd' }), 12, 80)[0]).toBe('s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen');
    expect(paneLines(paneState({ tab: 'p' }), 12, 120)[0]).toBe('[x] add failing test for parse_date                 s4  done_0 0.91   evidence tests 41p/0f/0e');
  });
  it('ascii twin has no non-ASCII cell for any tab at 59/80/120, side by side included', () => {
    for (const tab of tabs) {
      for (const columns of [59, 80, 120]) for (const l of paneLines(paneState({ tab }), 12, columns, 'none', { glyphs: GLYPHS.ascii })) expect(l).toMatch(ASCII_RE);
      for (const l of paneLines(paneState({ tab }), 12, 120, 'none', { glyphs: GLYPHS.ascii, terminalRows: 50 })) expect(l).toMatch(ASCII_RE);
    }
  });
  it('screen-reader twin has no bar glyph on any tab, wide, narrow or side by side', () => {
    for (const tab of tabs) {
      for (const columns of [59, 80, 120]) {
        const lines = paneLines(paneState({ tab }), 12, columns, 'none', { glyphs: GLYPHS.sr });
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(l).not.toMatch(BAR_RE);
      }
      for (const l of paneLines(paneState({ tab }), 12, 120, 'none', { glyphs: GLYPHS.sr, terminalRows: 50 })) expect(l).not.toMatch(BAR_RE);
    }
    expect(paneLines(paneState({ tab: 'd' }), 12, 80, 'none', { glyphs: GLYPHS.sr })[0]).toBe('s7 intent   intent           edit    0.64  c 0.55   chosen');
  });
  it('is fast: 1,000 renders of the 12-row decisions tab at 120 columns', () => {
    const s = paneState();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) paneLines(s, 12, 120, 'none');
    const ms = performance.now() - t0;
    console.log(`[measured] paneLines 12 rows × 120 columns: ${(ms / 1000).toFixed(3)} ms per call (bound 1.5 ms)`);
    expect(ms).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §4.3: the `'a'` tab, the two constants and the two computed tab strips (R5-4's §10)
// ---------------------------------------------------------------------------------------

describe("the `'a'` pane tab (TUI-DESIGN-5 §4.3, §14.2 #1 / #31)", () => {
  /**
   * The regression guard the design names: the two-argument `cycleTab` cases at `:165–167` above are green **and
   * unedited**, which is true only because the default binds to the FOUR-member `PANE_TABS`. This case states the
   * reason so a future widening of `PANE_TABS` itself fails here with the explanation attached.
   */
  it('the default is the four production tabs; the five-tab list is a separate constant', () => {
    expect(PANE_TABS).toEqual(['d', 'p', 't', 's']);
    expect(PANE_TABS_WITH_AGENTS).toEqual(['d', 'p', 't', 's', 'a']);
    expect(cycleTab('s', 1)).toBe('d');
    expect(cycleTab('d', -1)).toBe('s');
  });

  it("cycleTab('s', 1, PANE_TABS_WITH_AGENTS) === 'a', and the wrap comes back to 'd'", () => {
    expect(cycleTab('s', 1, PANE_TABS_WITH_AGENTS)).toBe('a');
    expect(cycleTab('a', 1, PANE_TABS_WITH_AGENTS)).toBe('d');
    expect(cycleTab('d', -1, PANE_TABS_WITH_AGENTS)).toBe('a');
  });

  it("paneTabsFor(false) excludes 'a', so ] and [ skip it", () => {
    expect(paneTabsFor(false)).toEqual(PANE_TABS);
    expect(paneTabsFor(true)).toEqual(PANE_TABS_WITH_AGENTS);
    expect(paneTabsFor(false)).not.toContain('a');
    for (const t of PANE_TABS) {
      expect(cycleTab(t, 1, paneTabsFor(false))).not.toBe('a');
      expect(cycleTab(t, -1, paneTabsFor(false))).not.toBe('a');
    }
  });

  it("a tab outside the list (the focused 'a' tab the instant the last agent ends) restarts at an end, never undefined", () => {
    expect(cycleTab('a', 1, PANE_TABS)).toBe('d');
    expect(cycleTab('a', -1, PANE_TABS)).toBe('s');
    expect(cycleTab('d', 1, [])).toBe('p');
  });

  it('TAB_TITLE is total over PaneTab (TypeScript finds a new tab here for free)', () => {
    const titles: Readonly<Record<PaneTab, string>> = TAB_TITLE;
    expect(Object.keys(titles).sort()).toEqual(['a', 'd', 'p', 's', 't']);
    expect(titles.a).toBe('agents');
    for (const t of PANE_TABS_WITH_AGENTS) expect(titles[t], t).not.toBe('');
  });

  it('hasDelegation reads the ROWS, so no second flag can disagree with them', () => {
    expect(hasDelegation({})).toBe(false);
    expect(hasDelegation({ agents: [] })).toBe(false);
    expect(hasDelegation({ agents: [mkAgentRow()] })).toBe(true);
  });

  it('tabStrip is the ONE builder both literals became (§12.3 S86, not F-54’s `d p t s [a]` form)', () => {
    expect(tabStrip(PANE_TABS, 'long', true)).toBe('[d]ecisions [p]lan [t]imeline [s]ynth');
    expect(tabStrip(PANE_TABS, 'long', false)).toBe('[d]ecisions [p]lan [t]ime [s]ynth');
    expect(tabStrip(PANE_TABS_WITH_AGENTS, 'long', false)).toBe('[d]ecisions [p]lan [t]ime [s]ynth [a]gents');
    expect(tabStrip(PANE_TABS_WITH_AGENTS, 'short', false)).toBe('[d] [p] [t] [s] [a]');
    expect(tabStrip(PANE_TABS, 'short', false)).toBe('[d] [p] [t] [s]');
  });

  it('the rule-row strip (`:355`) is computed: the `[a]gents` segment appears only while delegating, at wide AND narrow', () => {
    const base = paneState({ tab: 'd' });
    const wide = paneRuleRow(base, 12, 130, 'none');
    const narrow = paneRuleRow(base, 12, 80, 'none');
    expect(wide).toContain('[d]ecisions [p]lan [t]imeline [s]ynth');
    expect(wide).not.toContain('[a]gents');
    expect(narrow).toContain('[t]ime ');
    expect(narrow).not.toContain('[a]gents');

    const delegating = { ...base, agents: [mkAgentRow()] };
    expect(paneRuleRow(delegating, 12, 130, 'none')).toContain('[d]ecisions [p]lan [t]imeline [s]ynth [a]gents');
    // §4.12: the strip's TEXT shortens before the strip is dropped — at 80 the long five-segment form does not fit
    // beside the label, so the short one is drawn rather than `ruleRow` dropping the whole tab list (which would
    // take away the one row that tells the user the `'a'` tab exists)
    expect(paneRuleRow(delegating, 12, 80, 'none')).toContain('[d] [p] [t] [s] [a]');
    for (const w of [40, 80, 120, 130]) expect(cellWidth(paneRuleRow(delegating, 12, w, 'none')), `w=${w}`).toBe(w);
  });

  it('with NOTHING delegating the narrow rule row is byte-for-byte round 4\'s, at every width the fallback could reach', () => {
    /**
     * The long → short fallback exists for the fifth `[a]gents` segment. Applied unconditionally it also rewrote
     * round 4's landed row at every width below ~54 columns, where `ruleRow` used to drop the right segment whole
     * (`─── decisions s7 ────` at 40, not `─── decisions s7 ── [d] [p] [t] [s] ──`). These are the bytes at HEAD,
     * captured against the round-4 implementation, so the gate catches a re-widening of the fallback.
     */
    const s = paneState({ tab: 'd' });
    expect(paneRuleRow(s, 12, 40, 'none')).toBe('─── decisions s7 ───────────────────────');
    expect(paneRuleRow(s, 12, 50, 'none')).toBe('─── decisions s7 ─────────────────────────────────');
    expect(paneRuleRow(s, 12, 54, 'none')).toBe('─── decisions s7  [d]ecisions [p]lan [t]ime [s]ynth ──');
    expect(paneRuleRow(s, 12, 59, 'none')).toBe('─── decisions s7 ───── [d]ecisions [p]lan [t]ime [s]ynth ──');
    // the short form is never drawn while the four-tab list is the list — even at one cell
    for (let w = 1; w <= 53; w++) expect(paneRuleRow(s, 12, w, 'none'), `w=${w}`).not.toContain('[d] [p]');
    // and the collapsed strip's own row is untouched at the same widths (it has always shortened by dropping
    // segments from the right, which is round 2's loop and not this fallback)
    const strip = { ...s, latencies: [] as readonly (number | null)[] };
    expect(panelStrip(strip, 40)).toBe('─── ▸ jev s7 ──────── [d] [p] [t] [s] ──');
    expect(panelStrip(strip, 50)).toBe('─── ▸ jev s7 · 7 decisions ──── [d] [p] [t] [s] ──');
  });

  it('the collapsed strip (`:377`) is computed the same way, at wide and narrow', () => {
    const base = { ...paneState({ tab: 'd' }), latencies: [] as readonly (number | null)[] };
    expect(panelStrip(base, 130)).toContain('[d]ecisions [p]lan [t]imeline [s]ynth');
    expect(panelStrip(base, 130)).not.toContain('[a]gents');
    expect(panelStrip(base, 80)).toContain('[d] [p] [t] [s]');
    expect(panelStrip(base, 80)).not.toContain('[a]');

    const delegating = { ...base, agents: [mkAgentRow()] };
    expect(panelStrip(delegating, 130)).toContain('[d]ecisions [p]lan [t]imeline [s]ynth [a]gents');
    expect(panelStrip(delegating, 80)).toContain('[d] [p] [t] [s] [a]');
    for (const w of [40, 80, 120, 130]) expect(cellWidth(panelStrip(delegating, w)), `w=${w}`).toBe(w);
  });

  it('S86b: the focused rule row says so, so the focus state is never invisible', () => {
    const focused = { ...paneState({ tab: 'a' }), agents: [mkAgentRow()], paneFocus: true };
    expect(paneRuleRow(focused, 12, 130, 'none')).toContain('[a]gents · Esc unfocuses');
    const unfocused = { ...focused, paneFocus: false };
    expect(paneRuleRow(unfocused, 12, 130, 'none')).not.toContain('Esc unfocuses');
  });

  it("the `'a'` arm of tabLines mounts the agents tab, and the rule label carries the tally", () => {
    const s = { ...paneState({ tab: 'a' }), agents: [mkAgentRow(), mkAgentRow({ slug: 'b' })] };
    const lines = tabLines(s, 'a', 12, 120);
    expect(lines.some((l) => l.includes('tui-rows'))).toBe(true);
    expect(paneRuleRow(s, 12, 130, 'none')).toContain('agents s7 · 2 agents');
  });
});
