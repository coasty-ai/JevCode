import { describe, expect, it } from 'vitest';

import type { Move } from '../../../../../src/jev-modes/synth/types.js';
import { keepsCandidate, progress, REGRESSION_RULE, route } from '../../../../../src/jev-modes/synth/verify/progress.js';
import type { SearchState } from '../../../../../src/jev-modes/synth/verify/types.js';
import { summary } from './helpers.js';

const T = ['t1', 't2', 't3', 't4', 't5', 't6'];

describe('progress(): deltas computed in code', () => {
  it('a clean fix: everything newly passing, nothing newly failing', () => {
    const before = summary({ failing: ['t2', 't3', 't4', 't5', 't6'], passing: ['t1'] });
    const after = summary({ failing: [], passing: T });
    const p = progress(before, after);
    expect(p).toMatchObject({ allPass: true, improved: true, regressed: false, newlyPassing: ['t2', 't3', 't4', 't5', 't6'], newlyFailing: [] });
  });
  it('partial: 1/6 → 3/6, no regression', () => {
    const p = progress(summary({ failing: ['t2', 't3', 't4', 't5', 't6'], passing: ['t1'] }), summary({ failing: ['t4', 't5', 't6'], passing: ['t1', 't2', 't3'] }));
    expect(p).toMatchObject({ allPass: false, improved: true, regressed: false, newlyPassing: ['t2', 't3'], newlyFailing: [] });
  });
  it('partial_mixed: more pass but one that passed now fails → regressed', () => {
    const p = progress(summary({ failing: ['t2', 't3', 't4', 't5', 't6'], passing: ['t1'] }), summary({ failing: ['t1', 't5', 't6'], passing: ['t2', 't3', 't4'] }));
    expect(p).toMatchObject({ improved: true, regressed: true, newlyPassing: ['t2', 't3', 't4'], newlyFailing: ['t1'] });
  });
  it('lateral: same count, different set → regressed, not improved', () => {
    const p = progress(summary({ failing: ['t2'], passing: ['t1'] }), summary({ failing: ['t1'], passing: ['t2'] }));
    expect(p).toMatchObject({ improved: false, regressed: true, newlyPassing: ['t2'], newlyFailing: ['t1'] });
  });
  it('no change', () => {
    const before = summary({ failing: ['t2', 't3'], passing: ['t1'] });
    const p = progress(before, summary({ failing: ['t2', 't3'], passing: ['t1'] }));
    expect(p).toMatchObject({ improved: false, regressed: false, newlyPassing: [], newlyFailing: [], allPass: false });
  });
  it('without passing ids (run_tests.py, pytest -q): set differences over the failing ids', () => {
    const before = summary({ failing: ['t2', 't3', 't4'], passed: 3 });
    const after = summary({ failing: ['t4', 't1'], passed: 4 });
    const p = progress(before, after);
    expect(p.newlyPassing).toEqual(['t2', 't3']);
    expect(p.newlyFailing).toEqual(['t1']);
    expect(p.regressed).toBe(true);
    expect(p.improved).toBe(true);
  });
  it('count fallback: passed dropped with no failing ids at all still regresses (killed run)', () => {
    const before = summary({ failing: ['t2'], passing: ['t1', 't3'] });
    const after = summary({ failing: [], passing: [], passed: 0, total: 0, timedOut: true, exitCode: null });
    const p = progress(before, after);
    expect(p.regressed).toBe(true);
    expect(p.newlyFailing).toEqual([]);
    expect(p.newlyPassing).toEqual([]);
    expect(p.allPass).toBe(false);
  });
  it('a test that vanished (collection error) is not newly passing when passing ids are known', () => {
    const before = summary({ failing: ['t2'], passing: ['t1'] });
    const after = summary({ failing: ['test_x.py'], passing: [], passed: 0, errors: 1, failed: 0 });
    const p = progress(before, after);
    expect(p.newlyPassing).toEqual([]);
    expect(p.newlyFailing).toEqual([]); // 'test_x.py' never passed before
    expect(p.regressed).toBe(true); // count fallback: 1 → 0 passed
  });
  it('allPass needs something to have passed and no timeout', () => {
    expect(progress(summary({ failing: ['t1'] }), summary({ passed: 0, total: 0 })).allPass).toBe(false);
    expect(progress(summary({ failing: ['t1'] }), summary({ passing: ['t1'], timedOut: true })).allPass).toBe(false);
    expect(progress(summary({ failing: ['t1'] }), summary({ passing: ['t1'], skipped: 2 })).allPass).toBe(true);
  });
});

describe('route(): the code-owned policy, every branch', () => {
  const search = (over: Partial<SearchState> = {}): SearchState => ({ candidatesRemainingAtSite: 3, sourcesRemainingAtSite: 2, sitesRemaining: 2, budgetExhausted: false, ...over });
  const P = (over: { allPass?: boolean; improved?: boolean; regressed?: boolean; newlyFailing?: string[] }) => ({
    before: summary({ failing: ['t1'] }),
    after: summary({ failing: ['t1'] }),
    newlyPassing: [],
    newlyFailing: over.newlyFailing ?? [],
    allPass: over.allPass ?? false,
    improved: over.improved ?? false,
    regressed: over.regressed ?? false,
  });

  const table: [string, ReturnType<typeof P>, SearchState, Move][] = [
    ['all pass → accept_and_stop', P({ allPass: true, improved: true }), search(), 'accept_and_stop'],
    ['all pass even on an empty budget → accept_and_stop', P({ allPass: true, improved: true }), search({ budgetExhausted: true }), 'accept_and_stop'],
    ['improved, not regressed → accept_and_continue', P({ improved: true }), search(), 'accept_and_continue'],
    ['improved, not regressed, budget out → accept_and_continue (kept; the loop checks budget next)', P({ improved: true }), search({ budgetExhausted: true }), 'accept_and_continue'],
    ['regressed with candidates left → revert_try_next', P({ regressed: true, newlyFailing: ['t9'] }), search(), 'revert_try_next'],
    ['improved but regressed (partial_mixed) → revert_try_next', P({ improved: true, regressed: true, newlyFailing: ['t9'] }), search(), 'revert_try_next'],
    ['regressed and the newly failing test is the attacked one → still revert (REGRESSION_RULE)', P({ improved: true, regressed: true, newlyFailing: ['t1'] }), search({ attackedTestId: 't1' }), 'revert_try_next'],
    ['no change with candidates left → revert_try_next', P({}), search(), 'revert_try_next'],
    ['no change, candidates exhausted, sources left → widen_sources', P({}), search({ candidatesRemainingAtSite: 0 }), 'widen_sources'],
    ['no change, candidates and sources exhausted, sites left → revert_relocalise', P({}), search({ candidatesRemainingAtSite: 0, sourcesRemainingAtSite: 0 }), 'revert_relocalise'],
    ['no change, everything exhausted → revert_relocalise (search widens localisation)', P({}), search({ candidatesRemainingAtSite: 0, sourcesRemainingAtSite: 0, sitesRemaining: 0 }), 'revert_relocalise'],
    ['regressed, sources exhausted at the site → widen_sources', P({ regressed: true }), search({ candidatesRemainingAtSite: 0 }), 'widen_sources'],
    ['no progress and budget exhausted → give_up', P({}), search({ budgetExhausted: true }), 'give_up'],
    ['regressed and budget exhausted → give_up', P({ regressed: true }), search({ budgetExhausted: true, candidatesRemainingAtSite: 5 }), 'give_up'],
  ];
  for (const [name, p, s, expected] of table) {
    it(name, () => {
      expect(route(p, s)).toBe(expected);
    });
  }
  it('the regression rule is written down and keepsCandidate matches the accept moves', () => {
    expect(REGRESSION_RULE).toMatch(/revert on any regression/);
    expect(keepsCandidate('accept_and_stop')).toBe(true);
    expect(keepsCandidate('accept_and_continue')).toBe(true);
    for (const m of ['revert_try_next', 'revert_relocalise', 'widen_sources', 'give_up'] as Move[]) expect(keepsCandidate(m)).toBe(false);
  });
  it('the probe\'s 240-item expectation reproduces: fix/partial/partial_mixed/regression/no_change under (3,2), (0,2), (0,0) contexts', () => {
    // mirrors expectedMove() in experiments/progress/probe.mts with the brief's source/site ordering
    const cases: { kind: string; p: ReturnType<typeof P>; ctx: [number, number]; expected: Move }[] = [
      { kind: 'fix', p: P({ allPass: true, improved: true }), ctx: [3, 2], expected: 'accept_and_stop' },
      { kind: 'partial', p: P({ improved: true }), ctx: [3, 2], expected: 'accept_and_continue' },
      { kind: 'partial_mixed', p: P({ improved: true, regressed: true, newlyFailing: ['x'] }), ctx: [3, 2], expected: 'revert_try_next' },
      { kind: 'regression', p: P({ regressed: true, newlyFailing: ['x'] }), ctx: [3, 2], expected: 'revert_try_next' },
      { kind: 'regression', p: P({ regressed: true, newlyFailing: ['x'] }), ctx: [0, 2], expected: 'revert_relocalise' },
      { kind: 'no_change', p: P({}), ctx: [0, 0], expected: 'revert_relocalise' },
    ];
    for (const c of cases) {
      const s = search({ candidatesRemainingAtSite: c.ctx[0], sourcesRemainingAtSite: 0, sitesRemaining: c.ctx[1] });
      expect(route(c.p, s), c.kind).toBe(c.expected);
    }
  });
});
