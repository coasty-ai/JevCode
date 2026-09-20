import { describe, expect, it } from 'vitest';

import { toJson } from '../../../../src/core/json.js';
import { clusterFailures, park, reconcile } from '../../../../src/synth/search/goals.js';
import {
  attachPlanItems,
  createMemory,
  diffHash,
  dropMemory,
  emptyStepBudget,
  getMemory,
  markTried,
  parseGoalItem,
  planItemFor,
  rebuildFromPlan,
  recordCommit,
  restoreMemory,
  toPersisted,
  TRIED_PERSIST_MAX,
  UNFITTED_ORACLE,
  UNKNOWN_PLAN_PATH,
  wasTried,
} from '../../../../src/synth/search/memory.js';
import { isPersistedSearchState } from '../../../../src/synth/search/types.js';
import type { AppliedCandidate } from '../../../../src/synth/types.js';
import { baselineOf, failure, goal, pytestBaseline, searchFixture } from './memory-goals.helpers.js';

describe('plan-item grammar: fix <first_test_id>[, +N more] in <path>', () => {
  it('round-trips a single test, a cluster with +N more, and ids that contain commas and parentheses', () => {
    const cases = [
      { tests: ['gcd(13, 13)'], suspectedFiles: ['programs/gcd.py'], item: 'fix gcd(13, 13) in programs/gcd.py' },
      { tests: ['gcd(13, 13)', 'gcd(3, 12)', 'gcd(20, 100)'], suspectedFiles: ['programs/gcd.py'], item: 'fix gcd(13, 13), +2 more in programs/gcd.py' },
      { tests: ['tests/test_account.py::test_transfer_moves_money', 'x'], suspectedFiles: ['src/account.py'], item: 'fix tests/test_account.py::test_transfer_moves_money, +1 more in src/account.py' },
      { tests: ['tests/test_x.py::test_param[a in b-3]'], suspectedFiles: ['pkg/mod.py'], item: 'fix tests/test_x.py::test_param[a in b-3] in pkg/mod.py' },
    ];
    for (const c of cases) {
      expect(planItemFor(c)).toBe(c.item);
      expect(parseGoalItem(c.item)).toEqual({ firstTestId: c.tests[0], more: c.tests.length - 1, path: c.suspectedFiles[0] });
    }
  });

  it('falls back to the test file, then to the placeholder, when no file is suspected; both parse back', () => {
    const fromTest = planItemFor({ tests: ['tests/test_a.py::test_b'], suspectedFiles: [] });
    expect(fromTest).toBe('fix tests/test_a.py::test_b in tests/test_a.py');
    expect(parseGoalItem(fromTest)?.path).toBe('tests/test_a.py');
    const placeholder = planItemFor({ tests: ['gcd(1, 2)', 'gcd(2, 3)'], suspectedFiles: [] });
    expect(placeholder).toBe(`fix gcd(1, 2), +1 more in ${UNKNOWN_PLAN_PATH}`);
    expect(parseGoalItem(placeholder)).toEqual({ firstTestId: 'gcd(1, 2)', more: 1, path: UNKNOWN_PLAN_PATH });
  });

  it('tolerates items the grammar does not match by returning null', () => {
    for (const item of ['', 'fix', 'fix  in ', 'read the README', 'fix in src/x.py', 'fix , +2 more in src/x.py', 'run the tests', 'fix a in b c', 'fixed gcd(1, 2) in x.py']) {
      expect(parseGoalItem(item), item).toBeNull();
    }
    // surrounding whitespace is not an error
    expect(parseGoalItem('  fix t in src/x.py \n')).toEqual({ firstTestId: 't', more: 0, path: 'src/x.py' });
  });
});

describe('getMemory / tried / committed', () => {
  it('is one record per runId until dropped, with the unfitted oracle and an exhausted budget', () => {
    dropMemory('run-x');
    const a = getMemory('run-x');
    expect(getMemory('run-x')).toBe(a);
    expect(getMemory('run-y')).not.toBe(a);
    expect(a.oracle).toEqual(UNFITTED_ORACLE);
    expect(a.stepBudget.exhausted()).toBe(true);
    expect(emptyStepBudget().testRunsLeft).toBe(0);
    expect(dropMemory('run-x')).toBe(true);
    expect(getMemory('run-x')).not.toBe(a);
    dropMemory('run-x');
    dropMemory('run-y');
  });

  it('markTried is idempotent per diff and matches the loop detector hash; recordCommit keeps the hash durable', () => {
    const mem = createMemory('r');
    expect(markTried(mem, 'diff-a')).toBe(true);
    expect(markTried(mem, 'diff-a')).toBe(false);
    expect(wasTried(mem, 'diff-a')).toBe(true);
    expect(wasTried(mem, 'diff-b')).toBe(false);
    expect(diffHash('diff-a')).toMatch(/^[0-9a-f]{12}$/);
    const applied = { candidate: { id: 'c', text: 'x', source: 'mutation', op: 'o' }, files: [], diff: 'diff-b' } as unknown as AppliedCandidate;
    recordCommit(mem, applied);
    expect(mem.committed).toEqual([applied]);
    expect(mem.committedDiffHashes).toEqual([diffHash('diff-b')]);
    expect(wasTried(mem, 'diff-b')).toBe(true);
    recordCommit(mem, applied);
    expect(mem.committedDiffHashes).toHaveLength(1);
  });
});

describe('persisted state round trip', () => {
  const output = searchFixture('pytest-account-short.txt');
  const baseline = pytestBaseline(output);
  const WITHDRAW = 'tests/test_account.py::test_withdraw_exact_balance_is_allowed';
  const STATEMENT = 'tests/test_account.py::test_statement_numbering_starts_at_one';

  function populated(): ReturnType<typeof createMemory> {
    const mem = createMemory('run-p');
    const g1 = goal('g1', [WITHDRAW, 'tests/test_account.py::test_transfer_moves_money'], { suspectedFiles: ['src/account.py'], attempts: 2, phase: 'WIDENED' });
    const g2 = goal('g2', [STATEMENT], { suspectedFiles: ['src/account.py'], attempts: 1 });
    park(g2, 'every source exhausted at every site');
    const g3 = goal('g3', ['tests/test_account.py::test_deposit'], { suspectedFiles: ['src/account.py'], status: 'fixed' });
    mem.goals = [g1, g2, g3];
    markTried(mem, 'd1');
    markTried(mem, 'd2');
    mem.widenCursor.set('g1', 17);
    mem.committedDiffHashes.push(diffHash('d0'));
    return mem;
  }

  it('toPersisted is version 1, Json-serialisable, and accepted by the frozen guard', () => {
    const p = toPersisted(populated());
    expect(p.version).toBe(1);
    expect(p.tried).toEqual([diffHash('d1'), diffHash('d2')]);
    expect(p.widenCursor).toEqual({ g1: 17 });
    expect(p.committedDiffHashes).toEqual([diffHash('d0')]);
    expect(p.goals['g2']).toEqual({ status: 'parked', attempts: 1, budgetHits: 0, phase: 'SEEDS', parkedReason: 'every source exhausted at every site', tests: [STATEMENT], planItem: `fix ${STATEMENT} in src/account.py` });
    expect(p.goals['g1']).not.toHaveProperty('parkedReason');
    expect(isPersistedSearchState(toJson(p))).toBe(true);
    expect(isPersistedSearchState(null)).toBe(false);
    expect(isPersistedSearchState({ version: 2, tried: [] })).toBe(false);
  });

  it('rebuildFromPlan restores ids, statuses, attempts, phases, cursors and tried from the same baseline', () => {
    const before = populated();
    const persisted = toPersisted(before);
    const plan = { remaining: before.goals.filter((g) => g.status !== 'fixed').map((g) => g.planItem) };
    const rebuilt = rebuildFromPlan(plan, baseline, persisted, { output, defaultFiles: ['src/account.py'] });
    const byId = new Map(rebuilt.goals.map((g) => [g.id, g]));
    expect([...byId.keys()].sort()).toEqual(['g1', 'g2', 'g3']);
    const g1 = byId.get('g1')!;
    expect(g1.status).toBe('open');
    expect(g1.attempts).toBe(2);
    expect(g1.phase).toBe('WIDENED');
    expect(g1.tests).toHaveLength(2);
    expect(g1.planItem).toBe(plan.remaining[0]);
    const g2 = byId.get('g2')!;
    expect(g2.status).toBe('parked');
    expect(g2.parkedReason).toBe('every source exhausted at every site');
    expect(g2.attempts).toBe(1);
    const g3 = byId.get('g3')!;
    expect(g3.status).toBe('fixed');
    expect(g3.tests).toEqual(['tests/test_account.py::test_deposit']);
    expect(rebuilt.tried).toEqual(before.tried);
    expect(rebuilt.widenCursor).toEqual(new Map([['g1', 17]]));
    expect(rebuilt.committedDiffHashes).toEqual([diffHash('d0')]);
    expect(rebuilt.baseline).toBe(baseline);

    const mem = createMemory('run-r');
    mem.localizeCache.set('stale', { files: [], functions: [], sites: [], requests: 0 });
    restoreMemory(mem, rebuilt);
    expect(mem.goals).toBe(rebuilt.goals);
    expect(mem.baseline).toBe(baseline);
    expect(mem.localizeCache.size).toBe(0);
    expect(toPersisted(mem)).toEqual({ ...persisted, goals: { ...persisted.goals, g1: { ...persisted.goals['g1']!, status: 'open' } } });
  });

  it('without persisted state the goals are the fresh clustering attached to the plan items; junk items are ignored', () => {
    const rebuilt = rebuildFromPlan({ remaining: ['inspect the repo', `fix ${STATEMENT} in src/account.py`] }, baseline, null, { output, defaultFiles: ['src/account.py'] });
    expect(rebuilt.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(rebuilt.goals[1]?.planItem).toBe(`fix ${STATEMENT} in src/account.py`);
    expect(rebuilt.tried.size).toBe(0);
    expect(rebuilt.widenCursor.size).toBe(0);
  });

  it('a persisted goal whose tests pass now is fixed; a persisted active goal re-opens; cursors of vanished goals are dropped', () => {
    const before = createMemory('run-q');
    before.goals = [goal('g1', ['t_a'], { status: 'active', attempts: 1 }), goal('g2', ['t_b'], { attempts: 3 })];
    before.widenCursor.set('g1', 4);
    before.widenCursor.set('g2', 9);
    const persisted = toPersisted(before);
    const rebuilt = rebuildFromPlan({ remaining: [] }, baselineOf([failure('t_a', 't_a')]), persisted);
    expect(rebuilt.goals.map((g) => [g.id, g.status, g.attempts])).toEqual([
      ['g1', 'open', 1],
      ['g2', 'fixed', 3],
    ]);
    expect(rebuilt.widenCursor).toEqual(new Map([['g1', 4], ['g2', 9]]));
    // a goal that vanished entirely (no tests, no record) keeps no cursor
    const noG2 = { ...persisted, goals: { g1: persisted.goals['g1']! } };
    expect(rebuildFromPlan({ remaining: [] }, baselineOf([failure('t_a', 't_a')]), noG2).widenCursor).toEqual(new Map([['g1', 4]]));
  });

  it('the (mem, plan, persisted) shape restores placeholders before the baseline exists; reconcile then inherits their state', () => {
    const before = populated();
    const persisted = toPersisted(before);
    const mem = createMemory('run-m');
    const plan = { remaining: [...before.goals.filter((g) => g.status !== 'fixed').map((g) => g.planItem), 'fix tests/test_account.py::test_new in src/account.py', 'look around'] };
    rebuildFromPlan(mem, plan, persisted);
    expect(mem.tried).toEqual(before.tried);
    expect(mem.widenCursor).toEqual(new Map([['g1', 17]]));
    expect(mem.committedDiffHashes).toEqual([diffHash('d0')]);
    expect(mem.goals.map((g) => [g.id, g.status, g.tests.length])).toEqual([
      ['g1', 'open', 2],
      ['g2', 'parked', 1],
      ['g3', 'fixed', 1],
      ['g4', 'open', 1],
    ]);
    expect(mem.goals[1]?.parkedReason).toBe('every source exhausted at every site');
    expect(mem.goals[3]?.tests).toEqual(['tests/test_account.py::test_new']);
    expect(mem.goals[3]?.suspectedFiles).toEqual(['src/account.py']);
    // the baseline arrives: the fresh clustering takes the placeholders' ids and state
    const goals = reconcile(mem.goals, clusterFailures(baseline, { output, defaultFiles: ['src/account.py'] }), plan);
    const byId = new Map(goals.map((g) => [g.id, g]));
    expect([...byId.keys()].sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(byId.get('g1')?.attempts).toBe(2);
    expect(byId.get('g1')?.failures).toHaveLength(2);
    expect(byId.get('g2')?.status).toBe('parked');
    expect(byId.get('g3')?.status).toBe('fixed');
    // the plan item whose test does not fail (any more) is a fixed goal, not a phantom open one
    expect(byId.get('g4')?.status).toBe('fixed');
    // without persisted state only the plan items seed the placeholders
    const bare = createMemory('run-n');
    rebuildFromPlan(bare, { remaining: [`fix ${STATEMENT} in src/account.py`] }, null);
    expect(bare.goals.map((g) => [g.id, g.tests])).toEqual([['g1', [STATEMENT]]]);
  });

  it('attachPlanItems matches on the first test id only and never rewrites a fixed goal', () => {
    const open = goal('g1', ['t_a', 't_b']);
    const fixed = goal('g2', ['t_c'], { status: 'fixed' });
    attachPlanItems([open, fixed], ['fix t_b in src/m.py', 'fix t_c in src/m.py ']);
    expect(open.planItem).toBe('fix t_b in src/m.py');
    expect(fixed.planItem).toBe('fix t_c in src/m.py');
  });

  it('bounds the persisted tried list to the newest TRIED_PERSIST_MAX hashes and stays well under the 64 KB synthState cap', () => {
    const mem = createMemory('run-big');
    for (let i = 0; i < TRIED_PERSIST_MAX + 250; i++) markTried(mem, `diff-${i}`);
    mem.goals = Array.from({ length: 12 }, (_, i) => goal(`g${i + 1}`, [`tests/test_long_module_name.py::test_case_with_a_long_name_${i}[param-${i}]`]));
    const p = toPersisted(mem);
    expect(p.tried).toHaveLength(TRIED_PERSIST_MAX);
    expect(p.tried[0]).toBe(diffHash('diff-250'));
    expect(p.tried[p.tried.length - 1]).toBe(diffHash(`diff-${TRIED_PERSIST_MAX + 249}`));
    expect(JSON.stringify(p).length).toBeLessThan(60 * 1024);
  });
});
