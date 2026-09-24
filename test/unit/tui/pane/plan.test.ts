import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { NO_PLAN_YET, doneClaimIndex, doneRow, judgedTail, planRows, planSummaryRow, problemRow, unverifiedRow } from '../../../../src/tui/pane/plan.js';
import { paneState, planClaims, planFixture, planViewFixture } from './helpers.js';

const ASCII_RE = /^[\x20-\x7e]*$/;

describe('plan ledger rows (TUI-DESIGN §7.2 `p`, §24 `[x] [ ] [?] [!]`, frame F-K)', () => {
  it('renders the F-K plan tab at 80 columns exactly (done_1 is the engine id of s7’s second claim)', () => {
    const out = planRows(paneState({ tab: 'p' }), 12, 80);
    expect(out).toEqual([
      '[x] add failing test for parse_date                 s4  done_0 0.91',
      '[x] fix parse_date tz handling                      s6  done_0 0.78',
      '[?] update CHANGELOG                                s7  done_1 0.52  unverified',
      '[ ] run full suite',
      '[ ] remove debug print in utils.py',
      '[!] replan s6 change_approach: try tz-aware parsing instead of string ops',
      '[!] rejected_claim s5: "tests pass" done_0 0.12',
    ]);
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(80);
  });
  it('done_<j> is the claim’s index in the step’s judged claims, never a position in the ledger', () => {
    const view = { claimsByStep: planClaims() };
    expect(doneClaimIndex(view, 7, 'update CHANGELOG')).toBe(1);
    expect(doneClaimIndex(view, 7, 'fix parse_date tz handling')).toBe(0);
    expect(doneClaimIndex(view, 6, 'fix parse_date tz handling')).toBe(0);
    expect(doneClaimIndex(view, 7, 'never claimed')).toBeNull();
    expect(doneClaimIndex(view, 9, 'update CHANGELOG')).toBeNull();
    expect(doneClaimIndex({}, 7, 'update CHANGELOG')).toBeNull();
    expect(judgedTail(0.52, 1)).toBe('done_1 0.52');
    expect(judgedTail(0.52, null)).toBe('0.52');
    expect(judgedTail(-1, 0)).toBe('not judged');
    expect(judgedTail(Number.NaN, 0)).toBe('not judged');
  });
  it('prints the probability alone when the step’s claims are unknown (no fabricated id)', () => {
    const out = planRows(paneState({ plan: { step: 7, plan: planFixture() } }), 12, 80);
    expect(out[0]).toBe('[x] add failing test for parse_date                 s4  0.91');
    expect(out[2]).toBe('[?] update CHANGELOG                                s7  0.52  unverified');
    expect(out.join('\n')).not.toMatch(/\[[x?]\].*done_\d/);
    expect(out[6]).toBe('[!] rejected_claim s5: "tests pass" done_0 0.12');
  });
  it('row builders: done / unverified / problem forms', () => {
    expect(doneRow({ text: 't', evidence: { step: 6, judged: 0.8 } }, 1, 80, GLYPHS.unicode)).toMatch(/s6 {2}done_1 0\.80$/);
    expect(doneRow({ text: 't', evidence: { step: 2, judged: -1 } }, 0, 80, GLYPHS.unicode)).toMatch(/s2 {2}not judged$/);
    expect(doneRow({ text: 't', evidence: { step: 12, judged: 0.8 } }, null, 80, GLYPHS.unicode)).toMatch(/ s12 {2}0\.80$/);
    expect(unverifiedRow({ text: 't', step: 7, judged: 0.52 }, 1, 80, GLYPHS.unicode)).toMatch(/done_1 0\.52 {2}unverified$/);
    expect(unverifiedRow({ text: 't', step: 7, judged: 0.52 }, 1, 120, GLYPHS.unicode)).toMatch(/done_1 0\.52$/);
    expect(unverifiedRow({ text: 't', step: 7, judged: 0.52 }, 1, 59, GLYPHS.unicode)).toMatch(/done_1 0\.52$/);
    expect(problemRow({ kind: 'human', step: 0, text: 'from run x' })).toBe('[!] human s0: from run x');
    expect(problemRow({ kind: 'stale_plan', step: 3, text: 'a\nb' })).toBe('[!] stale_plan s3: a b');
    expect(problemRow({ kind: 'replan', step: 6, text: 'change_approach: x' })).toBe('[!] replan s6 change_approach: x');
    expect(planSummaryRow(planFixture())).toBe('plan  done 2  remaining 3  unverified 1  problems 2');
  });
  it('adds the evidence column at 120 columns and places `open:` on the last `[!]` row (F-Z)', () => {
    const out = planRows(paneState({ tab: 'p' }), 12, 120);
    expect(out).toEqual([
      '[x] add failing test for parse_date                 s4  done_0 0.91   evidence tests 41p/0f/0e',
      '[x] fix parse_date tz handling                      s6  done_0 0.78   evidence tests 41p/0f/0e',
      '[?] update CHANGELOG                                s7  done_1 0.52   unverified · no test evidence yet',
      '[ ] run full suite',
      '[ ] remove debug print in utils.py',
      '[!] replan s6 change_approach: try tz-aware parsing instead of string ops',
      '[!] rejected_claim s5: "tests pass" done_0 0.12                       open: test_parse_offsets is flaky',
    ]);
    expect(out[0]!.indexOf('evidence')).toBe(70);
    expect(out[6]!.indexOf('open:')).toBe(70);
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(120);
  });
  it('a second open problem climbs to the row above; ledger rows never carry one', () => {
    const view = planViewFixture();
    view.plan.openProblems = ['first', 'second', 'third', 'fourth', 'fifth'];
    const out = planRows(paneState({ plan: view }), 12, 120);
    expect(out[6]).toMatch(/open: first$/);
    expect(out[5]).toMatch(/open: second$/);
    expect(out[4]).toMatch(/open: third$/);
    expect(out[3]).toMatch(/open: fourth$/);
    for (const i of [0, 1, 2]) expect(out[i]).not.toContain('open:');
  });
  it('the narrow form (F-D half) drops the `unverified` tag and packs text, sN and done_j into the width', () => {
    const out = planRows(paneState({ tab: 'p' }), 12, 59);
    expect(out[0]).toBe('[x] add failing test for parse_date          s4 done_0 0.91');
    expect(out[2]).toBe('[?] update CHANGELOG                         s7 done_1 0.52');
    expect(out[2]).not.toContain('unverified');
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(59);
  });
  it('caps at rows, truncates to columns, renders the empty placeholder', () => {
    const s = paneState({ tab: 'p' });
    expect(planRows(s, 3, 80).length).toBe(3);
    expect(planRows(s, 0, 80)).toEqual([]);
    for (const c of [20, 59, 80, 120]) for (const l of planRows(s, 12, c)) expect(cellWidth(l)).toBeLessThanOrEqual(c);
    expect(planRows(paneState({ plan: null }), 5, 80)).toEqual([NO_PLAN_YET]);
    expect(planRows(paneState({ plan: { step: 1, plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] } } }), 5, 80)).toEqual([]);
  });
  it('handles wide and control-laden text, and drops bidi controls and U+2028/2029', () => {
    const plan = planFixture();
    plan.remaining = ['日本語のタスク'.repeat(10), 'x\u001b[31m\ny', 'run \u202etests\u202c now', 'a\u2028b\u2029c', 'p\u200e\u200fq\u2066r\u2069'];
    plan.unverified = [];
    const out = planRows(paneState({ plan: { step: 1, plan } }), 12, 59);
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(59);
    expect(out.find((l) => l.startsWith('[ ] x'))).toBe('[ ] x[31m y');
    expect(out.find((l) => l.startsWith('[ ] run'))).toBe('[ ] run tests now');
    expect(out.find((l) => l.startsWith('[ ] a'))).toBe('[ ] a b c');
    expect(out.find((l) => l.startsWith('[ ] p'))).toBe('[ ] pqr');
    for (const l of out) expect(l).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
  });
  it('ascii twin is ASCII for ASCII text', () => {
    for (const l of planRows(paneState({ tab: 'p' }), 12, 120, GLYPHS.ascii)) expect(l).toMatch(ASCII_RE);
  });
});
