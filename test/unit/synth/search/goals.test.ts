import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import {
  ATTACK_FIRST_ID,
  ATTACK_FIRST_INSTRUCTIONS,
  attackFirstQuestion,
  clusterFailures,
  codeOrder,
  framesIn,
  keyFrame,
  ledgerLine,
  MAX_CONSECUTIVE_BUDGET_HITS,
  MAX_SEARCHES_WITHOUT_COMMIT,
  noteBudgetHit,
  noteCommit,
  optionsFromFiles,
  park,
  parkReasonFor,
  pickGoal,
  pickGoalDetailed,
  reconcile,
  reopenOnChange,
} from '../../../../src/synth/search/goals.js';
import { createMemory, dropMemory, getMemory } from '../../../../src/synth/search/memory.js';
import { analyse } from '../../../../src/synth/py/index.js';
import type { LocalizeResult, SourceFile } from '../../../../src/synth/types.js';
import { RUN_FAILURE_ID } from '../../../../src/synth/verify/text.js';
import { choiceAnswer, scriptedAsk } from '../verify/helpers.js';
import { baselineOf, failure, goal, pytestBaseline, QUIXBUGS_DIR, quixbugsBaseline, rankedLine, searchFixture, verifyFixture } from './memory-goals.helpers.js';

const WITHDRAW = 'tests/test_account.py::test_withdraw_exact_balance_is_allowed';
const TRANSFER = 'tests/test_account.py::test_transfer_moves_money';
const STATEMENT = 'tests/test_account.py::test_statement_numbering_starts_at_one';

describe('clusterFailures: pytest tracebacks', () => {
  const output = searchFixture('pytest-account-short.txt');
  const baseline = pytestBaseline(output);

  it('parses the baseline the way the verifier does (3 failing tests)', () => {
    expect(baseline.failing).toEqual([WITHDRAW, TRANSFER, STATEMENT]);
  });

  it('two tests raising in the same source function are one goal; an assertion in the test body is its own', () => {
    const goals = clusterFailures(baseline, { output, defaultFiles: ['src/account.py'] });
    expect(goals.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(goals[0]?.tests).toEqual([WITHDRAW, TRANSFER]);
    expect(goals[0]?.suspectedFiles).toEqual(['src/account.py']);
    expect(goals[0]?.planItem).toBe(`fix ${WITHDRAW}, +1 more in src/account.py`);
    expect(goals[1]?.tests).toEqual([STATEMENT]);
    // no source frame: the caller's default file is suspected, never the test module
    expect(goals[1]?.suspectedFiles).toEqual(['src/account.py']);
    expect(goals[1]?.planItem).toBe(`fix ${STATEMENT} in src/account.py`);
    for (const g of goals) {
      expect(g.status).toBe('open');
      expect(g.attempts).toBe(0);
      expect(g.phase).toBe('SEEDS');
      expect(g.failures.map((f) => f.testId)).toEqual(g.tests);
    }
  });

  it('with sourcePaths given, frames resolve only into those files (absolute prints included)', () => {
    const goals = clusterFailures(baseline, { output, sourcePaths: ['src/account.py'] });
    expect(goals[0]?.tests).toEqual([WITHDRAW, TRANSFER]);
    const absolute = output.replaceAll('src/account.py', '/abs/ws/src/account.py');
    const again = clusterFailures(pytestBaseline(absolute), { output: absolute, sourcePaths: ['src/account.py'] });
    expect(again[0]?.tests).toEqual([WITHDRAW, TRANSFER]);
    expect(again[0]?.suspectedFiles).toEqual(['src/account.py']);
    // a frame into a file that is not a source path still groups the tests (same function), but is never a suspected file
    const none = clusterFailures(baseline, { output, sourcePaths: ['src/other.py'] });
    expect(none).toHaveLength(2);
    expect(none[0]?.tests).toEqual([WITHDRAW, TRANSFER]);
    expect(none[0]?.suspectedFiles).toEqual([]);
  });

  it('three tests through the same line form one goal (events fixture)', () => {
    const events = searchFixture('pytest-events-short.txt');
    const goals = clusterFailures(pytestBaseline(events), { output: events });
    expect(goals).toHaveLength(1);
    expect(goals[0]?.tests).toHaveLength(3);
    expect(goals[0]?.suspectedFiles).toEqual(['src/events.py']);
  });

  it('frames in the test module cluster parametrised cases of one test; same-named tests in two files stay apart', () => {
    const two = verifyFixture('pytest-two-files.txt');
    const b = pytestBaseline(two, 'pytest -rA');
    const goals = clusterFailures(b, { output: two });
    const pair = goals.find((g) => g.tests.includes('test_sample.py::test_param[13-13-13]'));
    expect(pair?.tests).toEqual(['test_sample.py::test_param[13-13-13]', 'test_sample.py::test_param[20-100-20]']);
    expect(pair?.id).toBe('g1');
    expect(goals).toHaveLength(b.failing.length - 1);
    const eq = goals.filter((g) => g.tests.some((t) => t.endsWith('::test_fail_eq')));
    expect(eq).toHaveLength(2);
    // test-module frames never make a test file a suspected file
    for (const g of goals) expect(g.suspectedFiles).toEqual([]);
  });

  it('splits one function into two goals when the lines are more than ±3 apart, and keeps them together within the window', () => {
    const mk = (line: number, test: string): string => `_____ ${test} _____\ntests/test_m.py:5: in ${test}\n    f()\nsrc/m.py:${line}: in f\n    raise ValueError\nE   ValueError\n`;
    const out = `=== FAILURES ===\n${mk(10, 'test_a')}${mk(13, 'test_b')}${mk(12, 'test_c')}${mk(14, 'test_d')}=== short test summary info ===\n`;
    const b = baselineOf(['test_a', 'test_b', 'test_c', 'test_d'].map((t) => failure(`tests/test_m.py::${t}`, t, '', 'ValueError')));
    const goals = clusterFailures(b, { output: out });
    // 10, 12, 13 sit within ±3 of the first line; 14 does not (14 − 10 > 3)
    expect(goals.map((g) => g.tests.map((t) => t.split('::')[1]))).toEqual([['test_a', 'test_b', 'test_c'], ['test_d']]);
  });

  it('reads native Python frames and ignores stdlib / site-packages frames', () => {
    const frames = framesIn('Traceback (most recent call last):\n  File "/usr/lib/python3.12/json/__init__.py", line 3, in loads\n  File "/ws/tests/test_x.py", line 9, in test_x\n  File "/ws/pkg/mod.py", line 42, in compute\nValueError: bad');
    expect(frames).toEqual([
      { path: '/ws/tests/test_x.py', line: 9, fn: 'test_x', kind: 'test' },
      { path: '/ws/pkg/mod.py', line: 42, fn: 'compute', kind: 'source' },
    ]);
    expect(keyFrame(frames)?.path).toBe('/ws/pkg/mod.py');
    expect(keyFrame([])).toBeNull();
  });
});

describe('clusterFailures: run_tests.py JSON (one goal per test)', () => {
  it('five failing gcd cases become g1..g5 ordered by test id, suspecting the program file', () => {
    const b = quixbugsBaseline(verifyFixture('quixbugs-gcd-buggy.json'));
    const goals = clusterFailures(b, { defaultFiles: ['programs/gcd.py'] });
    expect(goals.map((g) => g.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
    expect(goals.map((g) => g.tests[0])).toEqual(['gcd(13, 13)', 'gcd(20, 100)', 'gcd(3, 12)', 'gcd(37, 600)', 'gcd(624129, 2061517)']);
    expect(goals[0]?.planItem).toBe('fix gcd(13, 13) in programs/gcd.py');
    expect(goals[0]?.suspectedFiles).toEqual(['programs/gcd.py']);
    expect(goals[0]?.failures[0]?.actual).toMatch(/RecursionError/);
  });

  it('the runner\'s "(at test.py:N: ...)" tail is a test-module frame: still one goal, program file suspected', () => {
    const b = quixbugsBaseline(verifyFixture('quixbugs-bfs-buggy.json'), 'python3 run_tests.py breadth_first_search programs/breadth_first_search.py');
    const goals = clusterFailures(b, { defaultFiles: ['programs/breadth_first_search.py'] });
    expect(goals).toHaveLength(1);
    expect(goals[0]?.suspectedFiles).toEqual(['programs/breadth_first_search.py']);
  });

  it('with the real runner (stdlib python3): the buggy gcd yields one goal per failing case', () => {
    const stdout = (() => {
      try {
        return execFileSync('python3', [join(QUIXBUGS_DIR, 'run_tests.py'), 'gcd', join(QUIXBUGS_DIR, 'programs/gcd.py'), '--max-failures', '1000'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      } catch (e) {
        // exit 1 iff something failed: the JSON line is still on stdout
        return (e as { stdout?: string }).stdout ?? '';
      }
    })();
    const b = quixbugsBaseline(stdout);
    expect(b.failing.length).toBeGreaterThanOrEqual(5);
    const goals = clusterFailures(b, { defaultFiles: ['programs/gcd.py'] });
    expect(goals).toHaveLength(b.failing.length);
    expect(new Set(goals.map((g) => g.id)).size).toBe(goals.length);
  });

  it('the synthetic <test run> failure is not a goal', () => {
    const b = baselineOf([failure(RUN_FAILURE_ID, 'pytest', 'completes', 'timeout after 120 s'), failure('gcd(1, 2)', 'gcd(1, 2)')]);
    const goals = clusterFailures(b);
    expect(goals.map((g) => g.tests)).toEqual([['gcd(1, 2)']]);
  });
});

describe('clusterFailures: workspace-files call shape', () => {
  it('a file map means: non-test files are source paths; a lone source file is the default suspect', () => {
    const files = new Map<string, SourceFile>([
      ['programs/gcd.py', { path: 'programs/gcd.py', src: 'def gcd(a, b):\n    return a\n', mod: analyse('def gcd(a, b):\n    return a\n') }],
      ['tests/test_gcd.py', { path: 'tests/test_gcd.py', src: '', mod: analyse('') }],
    ]);
    expect(optionsFromFiles(files)).toEqual({ sourcePaths: ['programs/gcd.py'], defaultFiles: ['programs/gcd.py'] });
    const goals = clusterFailures(quixbugsBaseline(verifyFixture('quixbugs-gcd-buggy.json')), files);
    expect(goals).toHaveLength(5);
    expect(goals[0]?.suspectedFiles).toEqual(['programs/gcd.py']);
    files.set('programs/other.py', { path: 'programs/other.py', src: '', mod: analyse('') });
    expect(optionsFromFiles(files)).toEqual({ sourcePaths: ['programs/gcd.py', 'programs/other.py'] });
  });

  it('with the file map (index.ts shape) pytest frames are still read, from the baseline outputTail', () => {
    // index.ts never passes the raw output; a ladder-sized run (1.6 KB) fits the 4,000-char tail whole.
    const output = searchFixture('pytest-account-short.txt');
    const files = new Map<string, SourceFile>([
      ['src/account.py', { path: 'src/account.py', src: '', mod: analyse('') }],
      ['tests/test_account.py', { path: 'tests/test_account.py', src: '', mod: analyse('') }],
    ]);
    const baseline = pytestBaseline(output);
    expect(baseline.outputTail).toBe(output);
    const goals = clusterFailures(baseline, files);
    expect(goals.map((g) => g.tests)).toEqual([[WITHDRAW, TRANSFER], [STATEMENT]]);
    expect(goals[0]?.suspectedFiles).toEqual(['src/account.py']);
    // an explicit `output` still wins over the tail
    expect(clusterFailures({ ...baseline, outputTail: '' }, { output, sourcePaths: ['src/account.py'] })[0]?.tests).toEqual([WITHDRAW, TRANSFER]);
  });

  it('a tail cut inside the FAILURES section degrades to one goal per lost test, never a crash or a wrong merge', () => {
    const output = searchFixture('pytest-account-short.txt');
    // cut just after the first section header: the withdraw traceback is lost, the other two survive whole
    const cut = output.slice(output.indexOf('tests/test_account.py:26'));
    const baseline = { ...pytestBaseline(output), outputTail: cut };
    const goals = clusterFailures(baseline, { sourcePaths: ['src/account.py'] });
    // transfer alone (withdraw has no section any more), statement alone, withdraw alone: three goals
    expect(goals.map((g) => g.tests)).toEqual([[STATEMENT], [TRANSFER], [WITHDRAW]]);
    expect(goals.find((g) => g.tests[0] === TRANSFER)?.suspectedFiles).toEqual(['src/account.py']);
    expect(goals.find((g) => g.tests[0] === WITHDRAW)?.suspectedFiles).toEqual([]);
  });
});

describe('clusterFailures: SBFL fallback', () => {
  it('tests sharing their best-ranked executed line cluster; a test executing none of the top lines stands alone', () => {
    const b = baselineOf([failure('t1', 't1'), failure('t2', 't2'), failure('t3', 't3'), failure('t4', 't4')]);
    const ranked = [rankedLine(1, 'src/m.py', 5), rankedLine(2, 'src/m.py', 9), rankedLine(7, 'src/m.py', 40)];
    const perTest = [
      { id: 't1', outcome: 'fail' as const, lines: { 'src/m.py': [5, 9] }, exception: null, durationMs: 1 },
      { id: 't2', outcome: 'fail' as const, lines: { 'src/m.py': [5] }, exception: null, durationMs: 1 },
      { id: 't3', outcome: 'fail' as const, lines: { 'src/m.py': [9] }, exception: null, durationMs: 1 },
      { id: 't4', outcome: 'fail' as const, lines: { 'src/m.py': [40] }, exception: null, durationMs: 1 },
    ];
    const goals = clusterFailures(b, { sbfl: { ranked, perTest } });
    expect(goals.map((g) => g.tests)).toEqual([['t1', 't2'], ['t3'], ['t4']]);
    expect(goals[0]?.suspectedFiles).toEqual(['src/m.py']);
    expect(goals[1]?.suspectedFiles).toEqual(['src/m.py']);
    expect(goals[2]?.suspectedFiles).toEqual([]);
  });
});

describe('reconcile', () => {
  it('keeps parked state and attempts by test-id overlap, marks a fixed goal, numbers new goals above every id', () => {
    const g1 = goal('g1', ['t_a', 't_b'], { status: 'parked', parkedReason: 'every source exhausted', attempts: 2 });
    const g2 = goal('g2', ['t_c'], { status: 'active', attempts: 1, phase: 'SKETCH' });
    g2.exhausted.set('src/m.py:3:replace', new Set(['mutation']));
    // the commit fixed t_c; t_b now passes too; t_d is newly failing
    const fresh = clusterFailures(baselineOf([failure('t_a', 't_a'), failure('t_d', 't_d')]));
    expect(fresh.map((g) => g.id)).toEqual(['g1', 'g2']);
    const out = reconcile([g1, g2], fresh, { remaining: ['fix t_a, +1 more in src/m.py'] });
    const byId = new Map(out.map((g) => [g.id, g]));
    expect([...byId.keys()].sort()).toEqual(['g1', 'g2', 'g3']);
    const a = byId.get('g1')!;
    expect(a.tests).toEqual(['t_a']);
    expect(a.status).toBe('parked');
    expect(a.parkedReason).toBe('every source exhausted');
    expect(a.attempts).toBe(2);
    // the engine's plan string is kept even though the cluster shrank
    expect(a.planItem).toBe('fix t_a, +1 more in src/m.py');
    const c = byId.get('g2')!;
    expect(c.status).toBe('fixed');
    expect(c.tests).toEqual(['t_c']);
    const d = byId.get('g3')!;
    expect(d.tests).toEqual(['t_d']);
    expect(d.status).toBe('open');
    expect(d.attempts).toBe(0);
  });

  it('an active goal whose tests still fail after a workspace change comes back open with its phase and exhausted sources', () => {
    const g1 = goal('g1', ['t_a'], { status: 'active', attempts: 1, phase: 'BEAM' });
    g1.exhausted.set('k', new Set(['donor']));
    const fresh = clusterFailures(baselineOf([failure('t_a', 't_a')]));
    const [out] = reconcile([g1], fresh, { remaining: [] });
    expect(out?.status).toBe('open');
    expect(out?.phase).toBe('BEAM');
    expect(out?.exhausted.get('k')).toEqual(new Set(['donor']));
  });

  it('a fresh clustering with no ledger is returned as is', () => {
    const fresh = clusterFailures(baselineOf([failure('t_a', 't_a')]));
    expect(reconcile([], fresh, { remaining: [] })).toEqual(fresh);
  });
});

describe('status transitions and parking', () => {
  it('noteBudgetHit parks at the second consecutive hit; noteCommit resets the counters', () => {
    const g = goal('g1', ['t']);
    expect(noteBudgetHit(g)).toBeNull();
    expect(g.status).toBe('open');
    expect(noteBudgetHit(g)).toBe(`${MAX_CONSECUTIVE_BUDGET_HITS} consecutive budget-hit steps`);
    expect(g.status).toBe('parked');
    noteCommit(g, false);
    expect(g.status).toBe('open');
    expect(g.budgetHits).toBe(0);
    expect(g.parkedReason).toBeUndefined();
    noteCommit(g, true);
    expect(g.status).toBe('fixed');
  });

  it('parkReasonFor names the §5.3 rule that fires', () => {
    expect(parkReasonFor({ attempts: 0, budgetHits: 0 })).toBeNull();
    expect(parkReasonFor({ attempts: MAX_SEARCHES_WITHOUT_COMMIT, budgetHits: 0 })).toBe('3 searches without a commit');
    expect(parkReasonFor({ attempts: 1, budgetHits: MAX_CONSECUTIVE_BUDGET_HITS })).toBe('2 consecutive budget-hit steps');
  });

  it('reopenOnChange re-opens a parked goal whose suspected file changed, keeps attempts, drops its caches', () => {
    const mem = createMemory('run-1');
    const parked = goal('g1', ['t_a'], { suspectedFiles: ['src/a.py'], attempts: 2 });
    park(parked, 'exhausted');
    const other = goal('g2', ['t_b'], { suspectedFiles: ['src/b.py'] });
    park(other, 'exhausted');
    const touched = goal('g3', ['t_c'], { suspectedFiles: ['src/a.py'] });
    touched.exhausted.set('k', new Set(['mutation']));
    mem.goals = [parked, other, touched];
    const cache = { files: [], functions: [], sites: [], requests: 0 } as LocalizeResult;
    mem.localizeCache.set('g1', cache);
    mem.localizeCache.set('g2', cache);
    mem.widenCursor.set('g1', 7);
    const reopened = reopenOnChange(mem, ['./src/a.py']);
    expect(reopened.map((g) => g.id)).toEqual(['g1']);
    expect(parked.status).toBe('open');
    expect(parked.attempts).toBe(2);
    expect(parked.parkedReason).toBeUndefined();
    expect(other.status).toBe('parked');
    expect(mem.localizeCache.has('g1')).toBe(false);
    expect(mem.localizeCache.has('g2')).toBe(true);
    expect(mem.widenCursor.has('g1')).toBe(false);
    // an open goal on the changed file keeps its status but loses the exhausted sets (lines moved)
    expect(touched.status).toBe('open');
    expect(touched.exhausted.size).toBe(0);
  });

  it('reopenOnChange also accepts the bare goal list', () => {
    const parked = goal('g1', ['t_a'], { suspectedFiles: ['src/a.py'] });
    park(parked, 'exhausted');
    expect(reopenOnChange([parked], ['src/a.py'])).toEqual([parked]);
    expect(parked.status).toBe('open');
  });

  it('the bare goal list of a registered run (index.ts passes mem.goals) still drops that run\'s caches', () => {
    dropMemory('run-reopen');
    const mem = getMemory('run-reopen');
    const committed = goal('g1', ['t_a'], { suspectedFiles: ['src/a.py'] });
    const parked = goal('g2', ['t_b'], { suspectedFiles: ['src/a.py'] });
    park(parked, 'exhausted');
    mem.goals = [committed, parked];
    const cache = { files: [], functions: [], sites: [], requests: 0 } as LocalizeResult;
    mem.localizeCache.set('g1', cache);
    mem.localizeCache.set('g2', cache);
    mem.widenCursor.set('g1', 5);
    mem.widenCursor.set('g2', 9);
    expect(reopenOnChange(mem.goals, ['src/a.py']).map((g) => g.id)).toEqual(['g2']);
    // the WIDENED cursor of the committed goal itself is stale too: its lines moved
    expect(mem.widenCursor.size).toBe(0);
    expect(mem.localizeCache.size).toBe(0);
    dropMemory('run-reopen');
  });

  it('ledgerLine counts active goals as open', () => {
    const goals = [goal('g1', ['a'], { status: 'fixed' }), goal('g2', ['b'], { status: 'fixed' }), goal('g3', ['c'], { status: 'active' }), goal('g4', ['d'], { status: 'parked' })];
    expect(ledgerLine(goals)).toBe('fixed 2, open 1, parked 1');
  });
});

describe('pickGoal (Q1 attack_first)', () => {
  const ctx = { task: 'Fix the failing tests in src/m.py' };
  const short = goal('g1', ['t_short'], { failures: [failure('t_short', 'f(1)', '2', '3')] });
  const long = goal('g2', ['t_long'], { failures: [failure('t_long', 'f([1, 2, 3, 4, 5, 6])', '2', '3')] });
  const big = goal('g3', ['t_x', 't_y'], { failures: [failure('t_x', 'g(1)', '2', '3'), failure('t_y', 'g(2)', '2', '3')] });

  it('one open goal is taken without a request, becomes active and counts one attempt (the controller does not count again)', async () => {
    const ask = scriptedAsk(() => ({}));
    const g = goal('g1', ['t']);
    const r = await pickGoalDetailed(ctx, { goals: [g, goal('g2', ['u'], { status: 'fixed' })] }, ask);
    expect(r).toMatchObject({ goal: g, method: 'single', requests: 0 });
    expect(g.status).toBe('active');
    expect(g.attempts).toBe(1);
    expect(ask.calls).toHaveLength(0);
    // three picks without a commit reach the §5.3 park rule exactly at the third search
    g.status = 'open';
    await pickGoalDetailed(ctx, { goals: [g] }, ask);
    expect(parkReasonFor(g)).toBeNull();
    g.status = 'open';
    await pickGoalDetailed(ctx, { goals: [g] }, ask);
    expect(g.attempts).toBe(MAX_SEARCHES_WITHOUT_COMMIT);
    expect(parkReasonFor(g)).toBe(`${MAX_SEARCHES_WITHOUT_COMMIT} searches without a commit`);
  });

  it('no open goal → null; a lone active goal resumes without another attempt', async () => {
    const ask = scriptedAsk(() => ({}));
    expect((await pickGoalDetailed(ctx, { goals: [goal('g1', ['t'], { status: 'parked' })] }, ask)).method).toBe('none');
    const active = goal('g1', ['t'], { status: 'active', attempts: 1 });
    const r = await pickGoalDetailed(ctx, { goals: [active, goal('g2', ['u'])] }, ask);
    expect(r.method).toBe('active');
    expect(active.attempts).toBe(1);
  });

  it('builds the measured question: verbatim wording, failing_<slug> keys, failure text descriptions, measured state shape', () => {
    const batch = attackFirstQuestion([short, big], ctx.task);
    expect(String(batch.question.instructions)).toBe(ATTACK_FIRST_INSTRUCTIONS);
    expect(batch.question.type).toBe('choice');
    const keys = Object.keys(batch.question.type === 'choice' ? batch.question.criteria : {});
    expect(keys).toEqual(['failing_t_short', 'failing_t_x', ESCAPE_KEY]);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    const criteria = batch.question.type === 'choice' ? batch.question.criteria : {};
    expect(criteria['failing_t_short']).toBe('f(1) -> 3, expected 2');
    const state = batch.state as { [k: string]: Json };
    expect(String(state['task']).startsWith('The program under repair fails several tests. `failing_tests` lists them with input, expected output and actual result.')).toBe(true);
    expect(String(state['task'])).toContain(ctx.task);
    expect(state['failing_tests']).toEqual({
      failing_t_short: { input: 'f(1)', expected: '2', actual: '3', status: 'fail' },
      failing_t_x: { input: 'g(1)', expected: '2', actual: '3', status: 'fail' },
    });
  });

  it('a clear argmax wins even against the code order', async () => {
    const goals = [goal('g1', ['t_short'], { failures: short.failures }), goal('g2', ['t_long'], { failures: long.failures })];
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_long: 0.7, failing_t_short: 0.2, none_of_these: 0.1 }) }));
    const r = await pickGoalDetailed(ctx, { goals }, ask);
    expect(r.goal?.id).toBe('g2');
    expect(r.method).toBe('jev');
    expect(r.probability).toBe(0.7);
    expect(r.requests).toBe(1);
    expect(ask.calls[0]?.stage).toBe('propose');
    expect(goals[1]?.status).toBe('active');
    expect(goals[1]?.attempts).toBe(1);
    expect(goals[0]?.status).toBe('open');
    expect(goals[0]?.attempts).toBe(0);
  });

  it('within the 0.02 tie margin the code tiebreak decides: fewest tests first', async () => {
    const goals = [goal('g1', ['t_x', 't_y'], { failures: big.failures }), goal('g2', ['t_long'], { failures: long.failures })];
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_x: 0.46, failing_t_long: 0.44, none_of_these: 0.1 }) }));
    const r = await pickGoalDetailed(ctx, { goals }, ask);
    expect(r.goal?.id).toBe('g2');
    expect(r.method).toBe('tiebreak');
    // just outside the margin Jev's pick stands
    const ask2 = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_x: 0.47, failing_t_long: 0.44, none_of_these: 0.09 }) }));
    const r2 = await pickGoalDetailed(ctx, { goals: [goal('g1', ['t_x', 't_y'], { failures: big.failures }), goal('g2', ['t_long'], { failures: long.failures })] }, ask2);
    expect(r2.goal?.id).toBe('g1');
    expect(r2.method).toBe('jev');
  });

  it('same test count → shortest input; same input size → fewest attempts', async () => {
    const tie = (qs: Record<string, import('../../../../src/core/types.js').Question>): Record<string, import('../../../../src/core/types.js').Answer> => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_long: 0.45, failing_t_short: 0.45, none_of_these: 0.1 }) });
    const r = await pickGoalDetailed(ctx, { goals: [goal('g1', ['t_long'], { failures: long.failures }), goal('g2', ['t_short'], { failures: short.failures })] }, scriptedAsk(tie));
    expect(r.goal?.id).toBe('g2');
    const a = goal('g1', ['t_a'], { attempts: 2, failures: [failure('t_a', 'f(1)')] });
    const b = goal('g2', ['t_b'], { attempts: 0, failures: [failure('t_b', 'f(2)')] });
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_a: 0.45, failing_t_b: 0.45, none_of_these: 0.1 }) }));
    const r2 = await pickGoalDetailed(ctx, { goals: [a, b] }, ask);
    expect(r2.goal?.id).toBe('g2');
    expect(r2.method).toBe('tiebreak');
  });

  it('the escape option winning hands the decision to the code order', async () => {
    const goals = [goal('g1', ['t_x', 't_y'], { failures: big.failures }), goal('g2', ['t_long'], { failures: long.failures })];
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_x: 0.4, failing_t_long: 0.1, none_of_these: 0.5 }) }));
    const r = await pickGoalDetailed(ctx, { goals }, ask);
    expect(r.goal?.id).toBe('g2');
    expect(r.method).toBe('tiebreak');
  });

  it('offers at most `max` goals, in code order', () => {
    const many = Array.from({ length: 12 }, (_, i) => goal(`g${i + 1}`, [`t_${String(i).padStart(2, '0')}`], { failures: [failure(`t_${String(i).padStart(2, '0')}`, 'f(' + '1'.repeat(12 - i) + ')')] }));
    const batch = attackFirstQuestion([...many].sort(codeOrder), ctx.task);
    expect(batch.offered).toHaveLength(10);
    expect(batch.offered[0]?.goal.id).toBe('g12');
  });

  it('uses ctx.ask when no JevAsk is passed, and refuses to guess without either', async () => {
    const goals = [goal('g1', ['t_a']), goal('g2', ['t_b'])];
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_b: 0.8, failing_t_a: 0.1, none_of_these: 0.1 }) }));
    const r = await pickGoalDetailed({ task: ctx.task, ask }, { goals });
    expect(r.goal?.id).toBe('g2');
    expect(ask.calls).toHaveLength(1);
    await expect(pickGoalDetailed(ctx, { goals: [goal('g1', ['t_a']), goal('g2', ['t_b'])] })).rejects.toThrow(/JevAsk/);
  });

  it('pickGoal is the plain form: the goal or null', async () => {
    const goals = [goal('g1', ['t_a']), goal('g2', ['t_b'])];
    const ask = scriptedAsk((qs) => ({ [ATTACK_FIRST_ID]: choiceAnswer(qs[ATTACK_FIRST_ID]!, { failing_t_b: 0.8, failing_t_a: 0.1, none_of_these: 0.1 }) }));
    expect((await pickGoal(ctx, { goals }, ask))?.id).toBe('g2');
    expect(await pickGoal(ctx, { goals: [goal('g3', ['t'], { status: 'fixed' })] })).toBeNull();
  });

  it('a missing or non-choice answer is an error, never a silent pick', async () => {
    const goals = [goal('g1', ['t_a']), goal('g2', ['t_b'])];
    const ask = scriptedAsk(() => ({ [ATTACK_FIRST_ID]: { type: 'noul', noul: 0.5 } }));
    await expect(pickGoalDetailed(ctx, { goals }, ask)).rejects.toThrow(/attack_first/);
  });
});
