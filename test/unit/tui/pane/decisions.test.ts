import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { NO_DECISIONS_YET, decisionRowAriaLabel, decisionRowNarrow, decisionRowText, decisionRows, verdictWord } from '../../../../src/tui/pane/decisions.js';
import { toDecisionRow } from '../../../../src/tui/pane/model.js';
import { mkDecision } from '../../../fixtures/tui/fixtures.js';
import { frameJDecisions, paneState, stepSevenDecisions } from './helpers.js';

const ASCII_RE = /^[\x20-\x7e]*$/;
const rows = stepSevenDecisions().map((d) => toDecisionRow(d, 0.85));
const [intent, canEdit, , context, planMismatch, matchesIntent, taskComplete] = rows;

describe('decisions rows at 80 columns (TUI-DESIGN §7.2, §24 "Pane rows", F-B)', () => {
  it('renders `sN stage id label bar [!]p.pp  c c.cc[~]  [verdict]` with the two-cell `s7` of §24', () => {
    expect(decisionRowText(intent!, 80)).toBe('s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen');
    expect(decisionRowText(canEdit!, 80)).toBe('s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~');
    expect(decisionRowText(context!, 80)).toBe('s7 context  tests/test_a.py  noul   █████▎···· !0.52  c 0.04~');
    expect(decisionRowText(planMismatch!, 80)).toBe('s7 risk     plan_mismatch    L0     ██████▎···  0.62  c 0.53   [ok]');
    expect(decisionRowText(matchesIntent!, 80)).toBe('s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~');
    expect(decisionRowText(taskComplete!, 80)).toBe('s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~');
  });
  it('a two-digit step widens the label for every row shown (F-Q `s12 judge   task_complete`)', () => {
    // completeThreshold 0.9 so p = 0.85 is not near (F-Q draws no `!`)
    const s12 = toDecisionRow(mkDecision({ step: 12, stage: 'judge', id: 'task_complete', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.85 }, probability: 0.85, confidence: 0.7 }), 0.9);
    expect(decisionRowText(s12, 80)).toBe('s12 judge    task_complete    noul   ████████▌·  0.85  c 0.70~');
    expect(decisionRowNarrow(s12, 59)).toBe('s12 judge   task_complete   noul  ████████▌· 0.85');
    const mixed = decisionRows(paneState({ rows: [s12, intent!] }), 12, 80);
    expect(mixed[1]).toBe('s7  intent   intent           edit   ██████▍···  0.64  c 0.55   chosen');
    expect(decisionRows(paneState({ rows: [intent!] }), 12, 80)[0]!.startsWith('s7 intent')).toBe(true);
  });
  it('brackets risk verdicts and leaves choice verdicts bare', () => {
    expect(verdictWord('ok')).toBe('[ok]');
    expect(verdictWord('review')).toBe('[review]');
    expect(verdictWord('block')).toBe('[block]');
    expect(verdictWord('chosen')).toBe('chosen');
    expect(verdictWord('overridden')).toBe('overridden');
    expect(verdictWord('fallback')).toBe('fallback');
    expect(verdictWord(undefined)).toBe('');
  });
  it('adds latencyMs and consumedBy (with `(near)`) at 120 columns in the F-J geometry', () => {
    expect(decisionRowText(intent!, 120)).toBe('s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  choice resolution → intent edit');
    expect(decisionRowText(context!, 120)).toBe('s7 context  tests/test_a.py  noul   █████▎···· !0.52  c 0.04~             198ms  selected iff p ≥ 0.5 (near)');
    expect(decisionRowText(taskComplete!, 120)).toMatch(/198ms {2}≥ 0\.85 → stop$/);
    const j = frameJDecisions().map((d) => toDecisionRow(d, 0.85));
    expect(decisionRowText(j[9]!, 120)).toBe('s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  band 0.3/0.7 (tail)');
    expect(decisionRowText(j[7]!, 120)).toBe('s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]       244ms  band 0.3/0.7 (expected)');
    for (const r of j) expect(decisionRowText(r, 120).indexOf('ms  ')).toBe(77);
  });
  it('narrow form (F-D): stage and id share 23 cells, no `c`, `!` in the cell before p (A100)', () => {
    expect(decisionRowNarrow(intent!, 59)).toBe('s7 intent  intent          edit  ██████▍··· 0.64 chosen');
    expect(decisionRowNarrow(context!, 59)).toBe('s7 context tests/test_a.py noul  █████▎····!0.52');
    expect(decisionRowNarrow(planMismatch!, 59)).toBe('s7 risk    plan_mismatch   L0    ██████▎··· 0.62 [ok]');
    expect(decisionRowNarrow(taskComplete!, 59)).toBe('s7 complete task_complete  noul  ██████▊··· 0.68');
    expect(decisionRowNarrow(intent!, 59)).not.toContain(' c ');
    expect(cellWidth(decisionRowNarrow(taskComplete!, 59))).toBeLessThanOrEqual(59);
  });
});

describe('decisionRows(state, rows, columns)', () => {
  it('shows the newest `rows` rows, newest last', () => {
    const s = paneState();
    const out = decisionRows(s, 3, 80);
    expect(out.length).toBe(3);
    expect(out[2]).toContain('task_complete');
    expect(out[0]).toContain('plan_mismatch');
    expect(decisionRows(s, 100, 80).length).toBe(rows.length);
  });
  it('renders the §24 empty row and honours rows/columns 0', () => {
    expect(decisionRows(paneState({ rows: [] }), 5, 80)).toEqual([NO_DECISIONS_YET]);
    expect(decisionRows(paneState({ rows: [] }), 5, 10)).toEqual(['(no decis…']);
    expect(decisionRows(paneState(), 0, 80)).toEqual([]);
    expect(decisionRows(paneState(), 5, 0)).toEqual([]);
  });
  it('switches to the narrow form below 80 columns and truncates to columns', () => {
    for (const c of [20, 40, 59, 79, 80, 100, 120, 200]) {
      for (const l of decisionRows(paneState(), 12, c)) expect(cellWidth(l)).toBeLessThanOrEqual(c);
    }
    expect(decisionRows(paneState(), 12, 79)[0]).not.toContain(' c ');
    expect(decisionRows(paneState(), 12, 80)[0]).toContain(' c ');
  });
  it('truncates long and wide ids with the ellipsis and keeps every row ≤ columns', () => {
    const long = toDecisionRow(mkDecision({ stage: 'context', id: 'src/a/very/long/path/to/some/module_name.py', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.7 }, probability: 0.7 }), 0.85);
    const cjk = toDecisionRow(mkDecision({ stage: 'context', id: '日本語のファイル/テスト.py', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.7 }, probability: 0.7 }), 0.85);
    const emoji = toDecisionRow(mkDecision({ stage: 'context', id: '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀.py', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.7 }, probability: 0.7 }), 0.85);
    for (const r of [long, cjk, emoji]) {
      for (const c of [59, 80, 120]) expect(cellWidth(decisionRowText(r, c))).toBeLessThanOrEqual(c);
      expect(cellWidth(decisionRowNarrow(r, 59))).toBeLessThanOrEqual(59);
    }
    expect(decisionRowText(long, 80)).toContain('src/a/very/long…');
    expect(decisionRowText(cjk, 80)).toContain('…');
    // the id cell keeps its 16-cell width so the bar column stays aligned (compare cells, not code units)
    const cellsBefore = (line: string, marker: string): number => cellWidth(line.slice(0, line.indexOf(marker)));
    expect(cellsBefore(decisionRowText(cjk, 80), 'noul')).toBe(cellsBefore(decisionRowText(intent!, 80), 'edit'));
    expect(cellsBefore(decisionRowText(emoji, 80), 'noul')).toBe(cellsBefore(decisionRowText(intent!, 80), 'edit'));
    expect(cellsBefore(decisionRowNarrow(cjk, 59), 'noul')).toBe(cellsBefore(decisionRowNarrow(intent!, 59), 'edit'));
  });
  it('strips control characters, bidi controls and U+2028/2029 from ids and labels', () => {
    const evil = toDecisionRow(mkDecision({ stage: 'context', id: 'a\u001b[2Jb\nc', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.7 }, probability: 0.7 }), 0.85);
    expect(decisionRowText(evil, 80)).not.toMatch(/[\u0000-\u001f]/);
    expect(decisionRowText(evil, 80)).toContain('ab c');
    expect(decisionRowText(evil, 80)).not.toMatch(/\u001b|\[\d+[A-Za-z]/);
    const bidi = toDecisionRow(mkDecision({ stage: 'context', id: 'src/\u202eyp.a\u202c\u2028x', question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.7 }, probability: 0.7 }), 0.85);
    for (const line of [decisionRowText(bidi, 80), decisionRowText(bidi, 120), decisionRowNarrow(bidi, 59), decisionRowAriaLabel(bidi)]) {
      expect(line).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
      expect(line).toContain('src/yp.a x');
    }
  });
});

describe('ascii and screen-reader twins', () => {
  it('ascii rows are pure ASCII at 80 and at 120 (consumedBy through the glyph set) and keep the layout', () => {
    const a = decisionRowText(intent!, 80, GLYPHS.ascii);
    expect(a).toMatch(ASCII_RE);
    expect(a).toBe('s7 intent   intent           edit   ######3---  0.64  c 0.55   chosen');
    const wide = decisionRowText(intent!, 120, GLYPHS.ascii);
    expect(wide).toMatch(ASCII_RE);
    expect(wide).toBe('s7 intent   intent           edit   ######3---  0.64  c 0.55   chosen     231ms  choice resolution -> intent edit');
    expect(decisionRowText(context!, 120, GLYPHS.ascii)).toMatch(/198ms {2}selected iff p >= 0\.5 \(near\)$/);
    expect(decisionRowText(taskComplete!, 120, GLYPHS.ascii)).toMatch(/198ms {2}>= 0\.85 -> stop$/);
    for (const r of rows) for (const c of [59, 80, 120]) expect(decisionRowText(r, c, GLYPHS.ascii)).toMatch(ASCII_RE);
    for (const l of decisionRows(paneState(), 12, 120, GLYPHS.ascii)) expect(l).toMatch(ASCII_RE);
    for (const l of decisionRows(paneState(), 12, 59, GLYPHS.ascii)) expect(l).toMatch(ASCII_RE);
  });
  it('sr rows drop the bar and the aria label carries the probability', () => {
    const sr = decisionRowText(intent!, 80, GLYPHS.sr);
    expect(sr).not.toMatch(/[█▏▎▍▌▋▊▉·]/);
    expect(sr).toContain('0.64  c 0.55   chosen');
    expect(decisionRowText(intent!, 120, GLYPHS.sr)).toMatch(/chosen +231ms {2}choice resolution → intent edit$/);
    expect(decisionRowNarrow(intent!, 59, GLYPHS.sr)).not.toContain('█');
    expect(decisionRowAriaLabel(intent!)).toBe('step 7, intent, intent, edit, probability 0.64 of 1, confidence 0.55, chosen');
    expect(decisionRowAriaLabel(context!)).toBe('step 7, context, tests/test_a.py, noul, probability 0.52 of 1, confidence 0.04 derived, near threshold 0.5');
    expect(decisionRowAriaLabel(planMismatch!)).toMatch(/, ok$/);
  });
});
