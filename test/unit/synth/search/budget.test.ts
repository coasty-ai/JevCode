import { describe, expect, it } from 'vitest';

import {
  COMPACT_NOUL_MIN_CANDIDATES,
  decideRunPlan,
  detectRunner,
  fitOracle,
  freshBudget,
  MIN_RUN_TIMEOUT_MS,
  oracleClass,
  parseQuixbugsCommand,
  perTestTimeout,
  QUIXBUGS_JEV_REQUESTS_MAX,
  QUIXBUGS_TEST_RUNS_MAX,
  REPO_JEV_REQUESTS_MAX,
  REPO_TEST_RUNS_MAX,
  runsLeft,
  runTimeout,
  shellWords,
  SIEVE_MAX_T_RUN_MS,
} from '../../../../src/synth/search/budget.js';
import { budget, GCD_BASELINE, oracle, QUIXBUGS_DIR, summary } from '../sieve/helpers.js';

const LIMITS = { commandTimeoutMs: 120_000, wallRemainingMs: 600_000, workspace: { git: true } };

describe('runner detection', () => {
  it('shellWords splits quoted words the way sh does', () => {
    expect(shellWords(`PYTHONDONTWRITEBYTECODE=1 python3 '/a b/run_tests.py' 'gcd' "x y.py" --max-failures 1000`)).toEqual(['PYTHONDONTWRITEBYTECODE=1', 'python3', '/a b/run_tests.py', 'gcd', 'x y.py', '--max-failures', '1000']);
    expect(shellWords(`'it'\\''s' a\\ b`)).toEqual([`it's`, 'a b']);
    expect(shellWords('   ')).toEqual([]);
  });
  it('parseQuixbugsCommand reads dir, name and candidate path back from quixbugsTestCommand()', () => {
    expect(parseQuixbugsCommand(GCD_BASELINE.command)).toEqual({ dir: QUIXBUGS_DIR, name: 'gcd', candidatePath: 'gcd.py' });
    expect(parseQuixbugsCommand('python3 run_tests.py kth /ws/kth.py')).toEqual({ dir: '.', name: 'kth', candidatePath: '/ws/kth.py' });
    expect(parseQuixbugsCommand('python3 -m pytest -q')).toBeNull();
    expect(parseQuixbugsCommand('python3 run_tests.py --help')).toBeNull();
  });
  it('detectRunner: quixbugs | pytest | other', () => {
    expect(detectRunner(GCD_BASELINE.command)).toBe('quixbugs');
    expect(detectRunner('python3 -m pytest -q')).toBe('pytest');
    expect(detectRunner('pytest tests/test_a.py')).toBe('pytest');
    expect(detectRunner('.venv/bin/pytest -q -x')).toBe('pytest');
    expect(detectRunner('py.test')).toBe('pytest');
    expect(detectRunner('npm test')).toBe('other');
    expect(detectRunner('python3 tests/test_gcd.py')).toBe('other');
  });
});

describe('fitOracle (§4.1)', () => {
  it('QuixBugs runner: 8 lanes under 1 s, per-test timeout clamp(3 × p50, 500, 2000), run timeout 3 × baseline + 10 s', () => {
    const o = fitOracle(GCD_BASELINE, LIMITS);
    expect(o.runner).toBe('quixbugs');
    expect(o.lanes).toBe(8);
    // 300 ms / 6 cases = 50 ms p50 → 150 ms → clamped up to the 500 ms floor
    expect(o.perTestTimeoutMs).toBe(500);
    expect(o.runTimeoutMs).toBe(3 * 300 + 10_000);
    expect(o.tRunMs).toEqual({ goalSubset: 300, fullSuite: 300 });
    expect(o.baselineDurationMs).toBe(300);
    expect(oracleClass(o)).toBe('quixbugs_class');
  });
  it('accepts a SynthesisContext-shaped argument (limits + workspaceInfo); the wall remaining is then the run limit', () => {
    const o = fitOracle(GCD_BASELINE, { limits: { commandTimeoutMs: 5000, maxWallMs: 3_600_000 }, workspaceInfo: { git: false } });
    expect(o).toMatchObject({ runner: 'quixbugs', lanes: 8, runTimeoutMs: 5000, perTestTimeoutMs: 500 });
    expect(fitOracle(summary({ command: 'pytest -q', failing: ['x'], durationMs: 200_000 }), { limits: { commandTimeoutMs: 900_000, maxWallMs: 100_000 }, workspaceInfo: { git: true } }).runTimeoutMs).toBe(100_000);
  });
  it('per-test timeout uses the measured p50 when given and clamps at 2 s', () => {
    expect(fitOracle(GCD_BASELINE, { ...LIMITS, perTestP50Ms: 400 }).perTestTimeoutMs).toBe(1200);
    expect(fitOracle(GCD_BASELINE, { ...LIMITS, perTestP50Ms: 1000 }).perTestTimeoutMs).toBe(2000);
    expect(perTestTimeout('quixbugs', 0)).toBe(500);
    expect(perTestTimeout('quixbugs', Number.NaN)).toBe(500);
    expect(perTestTimeout('pytest', 400)).toBeNull();
  });
  it('pytest module: 4 lanes, no per-test timeout, repository class when a run is 2 s or more', () => {
    const o = fitOracle(summary({ command: 'python3 -m pytest -q', passing: ['t::a'], failing: ['t::b'], durationMs: 5000 }), LIMITS);
    expect(o).toMatchObject({ runner: 'pytest', lanes: 4, perTestTimeoutMs: null, runTimeoutMs: 25_000 });
    expect(oracleClass(o)).toBe('repository_class');
    // a fast pytest suite (the ladder's 0.11 s) still gets 8 lanes: the lane count follows t_run
    expect(fitOracle(summary({ command: 'pytest -q', failing: ['t::b'], durationMs: 110 }), LIMITS).lanes).toBe(8);
  });
  it('large non-git workspace: 2 lanes regardless of speed; unknown size counts as small', () => {
    const s = summary({ command: 'npm test', failing: ['x'], durationMs: 200 });
    expect(fitOracle(s, { ...LIMITS, workspace: { git: false, sizeBytes: 60 * 1024 * 1024 } }).lanes).toBe(2);
    expect(fitOracle(s, { ...LIMITS, workspace: { git: true, sizeBytes: 60 * 1024 * 1024 } }).lanes).toBe(8);
    expect(fitOracle(s, { ...LIMITS, workspace: { git: false } }).lanes).toBe(8);
    expect(fitOracle(s, LIMITS).runner).toBe('other');
  });
  it('runTimeout is bounded by the command timeout and the remaining wall, never below the floor', () => {
    expect(runTimeout(100_000, { commandTimeoutMs: 120_000, wallRemainingMs: 600_000 })).toBe(120_000);
    expect(runTimeout(1000, { commandTimeoutMs: 120_000, wallRemainingMs: 5000 })).toBe(5000);
    expect(runTimeout(1000, { commandTimeoutMs: 120_000, wallRemainingMs: 10 })).toBe(MIN_RUN_TIMEOUT_MS);
  });
});

describe('freshBudget (§4.3)', () => {
  const fast = oracle({ tRunMs: { goalSubset: 300, fullSuite: 300 }, baselineDurationMs: 300 });
  const slow = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 }, baselineDurationMs: 5000 });
  it('QuixBugs-class: testWall ≤ min(90 s, wallRemaining / 4), 1,500 runs, 30 requests', () => {
    const b = freshBudget({ maxWallMs: 3_600_000 }, fast, 600_000, { now: () => 42 });
    expect(b).toMatchObject({ testWallLeftMs: 90_000, testRunsLeft: QUIXBUGS_TEST_RUNS_MAX, jevRequestsLeft: QUIXBUGS_JEV_REQUESTS_MAX, startedMs: 42, recursed: false });
    expect(freshBudget({ maxWallMs: 3_600_000 }, fast, 200_000).testWallLeftMs).toBe(50_000);
    expect(b.exhausted()).toBe(false);
  });
  it('repository-class: testWall ≤ min(8 × baseline, 600 s, wallRemaining), 16 runs, 60 requests', () => {
    const b = freshBudget({ maxWallMs: 3_600_000 }, slow, 1_000_000);
    expect(b).toMatchObject({ testWallLeftMs: 40_000, testRunsLeft: REPO_TEST_RUNS_MAX, jevRequestsLeft: REPO_JEV_REQUESTS_MAX });
    const django = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 120_000, fullSuite: 120_000 }, baselineDurationMs: 120_000 });
    expect(freshBudget({ maxWallMs: 3_600_000 }, django, 1_000_000).testWallLeftMs).toBe(600_000);
    expect(freshBudget({ maxWallMs: 3_600_000 }, django, 100_000).testWallLeftMs).toBe(100_000);
    // limits.maxWallMs bounds a wallRemaining that claims more than the run may ever have (or is not a number)
    expect(freshBudget({ maxWallMs: 30_000 }, django, 1_000_000).testWallLeftMs).toBe(30_000);
    expect(freshBudget({ maxWallMs: 30_000 }, django, Number.NaN).testWallLeftMs).toBe(30_000);
  });
  it('exhausted() once one counter is spent', () => {
    const b = freshBudget({ maxWallMs: 3_600_000 }, fast, 600_000);
    b.testRunsLeft = 0;
    expect(b.exhausted()).toBe(true);
    const c = freshBudget({ maxWallMs: 3_600_000 }, fast, 600_000);
    c.testWallLeftMs = 0;
    expect(c.exhausted()).toBe(true);
    const d = freshBudget({ maxWallMs: 3_600_000 }, fast, 600_000);
    d.jevRequestsLeft = 0;
    expect(d.exhausted()).toBe(true);
    expect(freshBudget({ maxWallMs: 3_600_000 }, fast, 0).exhausted()).toBe(true);
  });
});

describe('decideRunPlan (§2.4)', () => {
  const quix = oracle({ lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 } });
  const replace = { kind: 'replace' as const };
  const insert = { kind: 'insert' as const };
  it('SIEVE when the whole set fits the run budget and a run is cheap: 137 QuixBugs candidates', () => {
    const b = budget();
    expect(runsLeft(quix, b)).toBe(1500); // min(1500, floor(90 s × 8 / 0.3 s) = 2400)
    expect(decideRunPlan(137, replace, quix, b)).toEqual({ mode: 'SIEVE', k: 137, runsAllowed: 137 });
    expect(decideRunPlan(1500, insert, quix, b)).toEqual({ mode: 'SIEVE', k: 1500, runsAllowed: 1500 });
    expect(decideRunPlan(1501, replace, quix, b)).toMatchObject({ mode: 'RANK' });
  });
  it('the wall cap spread over the lanes binds before the run count', () => {
    const b = budget({ testWallLeftMs: 3000 });
    expect(runsLeft(quix, b)).toBe(80); // floor(3000 × 8 / 300)
    expect(decideRunPlan(80, replace, quix, b).mode).toBe('SIEVE');
    expect(decideRunPlan(81, replace, quix, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
  });
  it('RANK on slow oracles: K = 3 at replace sites, 5 at insert sites, 5 above 60 candidates', () => {
    const swe = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
    const b = budget({ testRunsLeft: 16, testWallLeftMs: 40_000 });
    expect(decideRunPlan(10, replace, swe, b)).toEqual({ mode: 'RANK', k: 3, runsAllowed: 3 });
    expect(decideRunPlan(10, insert, swe, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    expect(decideRunPlan(COMPACT_NOUL_MIN_CANDIDATES - 1, replace, swe, b).k).toBe(3);
    expect(decideRunPlan(COMPACT_NOUL_MIN_CANDIDATES, replace, swe, b).k).toBe(5);
    expect(decideRunPlan(1641, replace, swe, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    // exactly SIEVE_MAX_T_RUN_MS is still cheap enough; 1 ms more is not
    expect(decideRunPlan(3, replace, oracle({ tRunMs: { goalSubset: SIEVE_MAX_T_RUN_MS, fullSuite: 0 } }), b).mode).toBe('SIEVE');
    expect(decideRunPlan(3, replace, oracle({ tRunMs: { goalSubset: SIEVE_MAX_T_RUN_MS + 1, fullSuite: 0 } }), b).mode).toBe('RANK');
  });
  it('K never exceeds the runs left; an empty set is a SIEVE of nothing; arrays count like numbers', () => {
    const swe = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
    expect(decideRunPlan(200, insert, swe, budget({ testRunsLeft: 2 }))).toEqual({ mode: 'RANK', k: 2, runsAllowed: 2 });
    expect(decideRunPlan(200, insert, swe, budget({ testRunsLeft: 0 }))).toEqual({ mode: 'RANK', k: 0, runsAllowed: 0 });
    expect(decideRunPlan([], replace, quix, budget())).toEqual({ mode: 'SIEVE', k: 0, runsAllowed: 0 });
  });
});
