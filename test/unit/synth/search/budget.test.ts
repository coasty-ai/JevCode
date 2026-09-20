import { describe, expect, it } from 'vitest';

import {
  caseProfile,
  COMPACT_NOUL_MIN_CANDIDATES,
  decideRunPlan,
  detectRunner,
  estimateRunMs,
  fitOracle,
  freshBudget,
  LANE_MAX_CASE_TIMEOUTS,
  laneRunTimeout,
  MIN_RUN_TIMEOUT_MS,
  oracleClass,
  parseQuixbugsCommand,
  perTestTimeout,
  PROCESS_OVERHEAD_MS,
  pytestSessionMs,
  QUIXBUGS_JEV_REQUESTS_MAX,
  QUIXBUGS_TEST_RUNS_MAX,
  refineLanes,
  refineTRun,
  REPO_JEV_REQUESTS_MAX,
  REPO_TEST_RUNS_MAX,
  runsLeft,
  runTimeout,
  shellWords,
  SESSION_OVERHEAD_MS,
  SIEVE_KEEP_FACTOR,
  SIEVE_MAX_T_RUN_MS,
} from '../../../../src/synth/search/budget.js';
import type { TestRunSummary } from '../../../../src/synth/types.js';
import { budget, GCD_BASELINE, oracle, QUIXBUGS_DIR, summary } from '../sieve/helpers.js';

const PYTEST = 'python3 -m pytest -q';
const CASE_TIMEOUT_2S = 'test_x.CaseTimeout: no result after 2s';

/** A pytest baseline of the bench's generated module: `hang` cases timed out at 2 s, `wrong` failed with a value, `pass` passed. */
function pytestBaseline(o: { hang: number; wrong?: number; pass?: number; durationMs: number; command?: string; sessionS?: number }): TestRunSummary {
  const hangIds = Array.from({ length: o.hang }, (_, i) => `tests/test_x.py::test_x[${i}-hang]`);
  const wrongIds = Array.from({ length: o.wrong ?? 0 }, (_, i) => `tests/test_x.py::test_x[${i}-wrong]`);
  const passing = Array.from({ length: o.pass ?? 0 }, (_, i) => `tests/test_x.py::test_x[${i}-ok]`);
  const failed = hangIds.length + wrongIds.length;
  const counts = `${failed > 0 ? `${failed} failed` : ''}${failed > 0 && passing.length > 0 ? ', ' : ''}${passing.length > 0 ? `${passing.length} passed` : ''}`;
  return summary({
    command: o.command ?? PYTEST,
    failing: [...hangIds, ...wrongIds],
    passing,
    passed: passing.length,
    failures: [...hangIds.map((id) => ({ testId: id, call: id, expected: '7', actual: CASE_TIMEOUT_2S })), ...wrongIds.map((id) => ({ testId: id, call: id, expected: '7', actual: '6' }))],
    durationMs: o.durationMs,
    // the output tail ends with pytest's counts line when the session clock is given
    outputTail: o.sessionS === undefined ? '' : `E       ${CASE_TIMEOUT_2S}\n\ntests/test_x.py:66: CaseTimeout\n=== short test summary info ===\nFAILED tests/test_x.py::test_x[0-hang] - ${CASE_TIMEOUT_2S}\n${counts} in ${o.sessionS.toFixed(2)}s\n`,
  });
}

/** bitcount's first live baseline: 9 cases, every one at the 2 s alarm, 18 238 ms wall (no session clock in the fixture). */
const BITCOUNT = pytestBaseline({ hang: 9, durationMs: 18_238 });
/** sqrt's: 7 cases, 6 hang, one passes; 12 229 ms. */
const SQRT = pytestBaseline({ hang: 6, pass: 1, durationMs: 12_229 });
/** the second live bench, measured through the engine while four tasks started together: 13 370 ms wall, "6 failed, 1 passed in 12.33s" */
const SQRT_LOADED = pytestBaseline({ hang: 6, pass: 1, durationMs: 13_370, sessionS: 12.33 });
/** bitcount there: 19 309 ms wall, "9 failed in 18.44s" */
const BITCOUNT_LOADED = pytestBaseline({ hang: 9, durationMs: 19_309, sessionS: 18.44 });
/** mergesort there (no case timeouts): 1 497 ms wall, "13 failed, 1 passed in 0.44s" */
const MERGESORT_LOADED = pytestBaseline({ hang: 0, wrong: 13, pass: 1, durationMs: 1497, sessionS: 0.44 });

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
    expect(perTestTimeout('quixbugs', null)).toBe(500);
    // the generated pytest module reads the limit from JEVCODE_CASE_TIMEOUT_MS: pytest has the knob too; `other` has none
    expect(perTestTimeout('pytest', 400)).toBe(1200);
    expect(perTestTimeout('other', 400)).toBeNull();
  });
  it('pytest module: 4 lanes, per-test timeout from the finished cases (clamped at 2 s), repository class when a run is 2 s or more', () => {
    // 5 s over 2 cases, none timed out: p50 ≈ (5000 − 200) / 2 → 3 × 2400 clamps to 2 s
    const o = fitOracle(summary({ command: 'python3 -m pytest -q', passing: ['t::a'], failing: ['t::b'], durationMs: 5000 }), LIMITS);
    expect(o).toMatchObject({ runner: 'pytest', lanes: 4, perTestTimeoutMs: 2000, runTimeoutMs: 25_000, tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
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

describe('fitOracle on timeout-dominated baselines (§4.1 adaptive per-test timeout, §2.4 adjusted t_run)', () => {
  it('caseProfile reads the timed-out cases from the failure texts and spreads the rest over the finished ones', () => {
    expect(caseProfile(BITCOUNT)).toEqual({ ran: 9, timeouts: 9, notRun: 0, finished: 0, caseLimitMs: 2000, sessionMs: null, startupMs: null, overheadMs: 200, finishedTotalMs: 38, finishedP50Ms: null });
    const sq = caseProfile(SQRT);
    expect(sq).toMatchObject({ ran: 7, timeouts: 6, finished: 1, caseLimitMs: 2000, overheadMs: 200, finishedTotalMs: 29, finishedP50Ms: 29 });
    // no timeout: everything but process start is the finished cases (gcd: 300 ms over 6 cases)
    expect(caseProfile(GCD_BASELINE)).toMatchObject({ ran: 6, timeouts: 0, finished: 6, overheadMs: PROCESS_OVERHEAD_MS, finishedTotalMs: 100 });
    // the limit the cases ran under is read back (run_tests.py's text, 0.5 s); process start never exceeds what is left
    const rt = summary({ command: GCD_BASELINE.command, failing: ['gcd(13, 13)'], failures: [{ testId: 'gcd(13, 13)', call: 'gcd(13, 13)', expected: '13', actual: 'TIMEOUT after 0.5s' }], durationMs: 550 });
    expect(caseProfile(rt)).toMatchObject({ timeouts: 1, caseLimitMs: 500, overheadMs: 50, finishedTotalMs: 0, finishedP50Ms: null });
    // stop-rule "not run" failures (lane runs) are neither finished nor timed out
    const nr = summary({ command: PYTEST, failing: ['a', 'b'], failures: [{ testId: 'a', call: 'a', expected: '', actual: CASE_TIMEOUT_2S }, { testId: 'b', call: 'b', expected: '', actual: 'test_x.CaseNotRun: not run: 1 earlier case(s) timed out' }], durationMs: 2300 });
    expect(caseProfile(nr)).toMatchObject({ ran: 2, timeouts: 1, notRun: 1, finished: 0, finishedP50Ms: null });
  });
  it('every case hangs (bitcount): 500 ms per test, one timeout per lane run, QuixBugs-class, 8 lanes; the raw 18.2 s stays for reporting', () => {
    const o = fitOracle(BITCOUNT, LIMITS);
    expect(o.runner).toBe('pytest');
    expect(o.perTestTimeoutMs).toBe(500);
    // the lane run of a hanging candidate: process start + the finished cases' time (38 ms) + LANE_MAX_CASE_TIMEOUTS × 500 ms
    expect(LANE_MAX_CASE_TIMEOUTS).toBe(1);
    expect(o.tRunMs).toEqual({ goalSubset: 738, fullSuite: 738 });
    expect(oracleClass(o)).toBe('quixbugs_class');
    expect(o.lanes).toBe(8);
    expect(o.baselineDurationMs).toBe(18_238);
    // the workspace command still runs the module at its 2 s default: its timeout follows the raw baseline
    expect(o.runTimeoutMs).toBe(3 * 18_238 + 10_000);
    // the old arithmetic, for the record: a 2 s p50 → 2 s timeout, an 18.7 s t_run, repository class, 4 lanes
    expect(perTestTimeout('pytest', 18_238 / 9)).toBe(2000);
  });
  it('mixed baseline: the per-test timeout is clamp(3 × p50 of the cases that finished) — the hung cases do not vote', () => {
    // sqrt: one finished case in the 29 ms left → 87 ms → floor 500
    const sq = fitOracle(SQRT, LIMITS);
    expect(sq.perTestTimeoutMs).toBe(500);
    expect(sq.tRunMs.goalSubset).toBe(200 + 29 + 500);
    expect(oracleClass(sq)).toBe('quixbugs_class');
    // 4 hung cases at 2 s and 6 finished ones sharing 1.8 s: p50 300 → 900 ms; a hanging lane run then costs 200 + 1800 + 900
    const mixed = fitOracle(pytestBaseline({ hang: 4, wrong: 2, pass: 4, durationMs: 4 * 2000 + PROCESS_OVERHEAD_MS + 6 * 300 }), LIMITS);
    expect(mixed.perTestTimeoutMs).toBe(900);
    expect(mixed.tRunMs.goalSubset).toBe(2900);
    expect(oracleClass(mixed)).toBe('repository_class');
    // a measured p50 handed in wins over the profile's spread
    expect(fitOracle(SQRT, { ...LIMITS, perTestP50Ms: 400 }).perTestTimeoutMs).toBe(1200);
    // a baseline without case timeouts is its own estimate (mergesort's RecursionErrors, the ladder)
    expect(fitOracle(pytestBaseline({ hang: 0, wrong: 13, pass: 1, durationMs: 1960 }), LIMITS).tRunMs.goalSubset).toBe(1960);
  });
  it('with pytest\'s session clock the start-up burst at baseline time is not the suite\'s: sqrt under the bench load keeps a sub-second timeout and QuixBugs class', () => {
    expect(pytestSessionMs('6 failed, 1 passed in 12.33s\n')).toBe(12_330);
    expect(pytestSessionMs('noise\n9 failed in 18.44s\nmore noise')).toBe(18_440);
    expect(pytestSessionMs('no tests ran in 0.01s')).toBe(10);
    expect(pytestSessionMs('1 failed in 0.5s\n2 passed in 0.7s')).toBe(700); // the last counts line
    expect(pytestSessionMs('{"passed": 1, "actual": "TIMEOUT after 2s"}')).toBeNull(); // run_tests.py's JSON has no session
    expect(pytestSessionMs('')).toBeNull();
    // sqrt: 1 040 ms of the 13 370 ms wall was interpreter start-up (the engine, its Jev calls and three sibling
    // tasks starting together); the session's 330 ms outside the six alarms is collection + reports + one case
    const sq = caseProfile(SQRT_LOADED);
    expect(sq).toMatchObject({ timeouts: 6, finished: 1, sessionMs: 12_330, startupMs: 1040, overheadMs: SESSION_OVERHEAD_MS, finishedTotalMs: 280, finishedP50Ms: 280 });
    const o = fitOracle(SQRT_LOADED, LIMITS);
    expect(o.perTestTimeoutMs).toBe(840); // 3 × 280 — the same baseline without the session clock read 3 × 1170 → 2 s
    expect(fitOracle({ ...SQRT_LOADED, outputTail: '' }, LIMITS).perTestTimeoutMs).toBe(2000);
    expect(o.tRunMs.goalSubset).toBe(PROCESS_OVERHEAD_MS + SESSION_OVERHEAD_MS + 280 + 840); // 1 370: QuixBugs-class (was 3 370, repository)
    expect(oracleClass(o)).toBe('quixbugs_class');
    expect(oracleClass(fitOracle({ ...SQRT_LOADED, outputTail: '' }, LIMITS))).toBe('repository_class');
    expect(o.baselineDurationMs).toBe(13_370);
    // bitcount: nothing finished → 500 ms; 1 140 ms a hanging lane run
    const bc = fitOracle(BITCOUNT_LOADED, LIMITS);
    expect(bc.perTestTimeoutMs).toBe(500);
    expect(bc.tRunMs.goalSubset).toBe(200 + 50 + 390 + 500);
    expect(oracleClass(bc)).toBe('quixbugs_class');
    // mergesort: no alarm, the 0.44 s session plus a start-up is the run — 8 lanes, not the 4 its 1.5 s wall would give
    const ms = fitOracle(MERGESORT_LOADED, LIMITS);
    expect(ms.tRunMs.goalSubset).toBe(200 + 440);
    expect(ms.lanes).toBe(8);
    expect(fitOracle({ ...MERGESORT_LOADED, outputTail: '' }, LIMITS)).toMatchObject({ tRunMs: { goalSubset: 1497, fullSuite: 1497 }, lanes: 4 });
    // a session longer than the wall (a clock from some other output) is not trusted
    expect(caseProfile({ ...MERGESORT_LOADED, durationMs: 300 }).sessionMs).toBeNull();
  });
  it('refineLanes: a refined t_run under 1 s widens to the fast suite\'s 8 lanes, never narrows, never on inplace lanes', () => {
    expect(refineLanes(oracle({ lanes: 4, tRunMs: { goalSubset: 686, fullSuite: 686 } }), 'worktree')).toBe(8);
    expect(refineLanes(oracle({ lanes: 4, tRunMs: { goalSubset: 1000, fullSuite: 1000 } }), 'worktree')).toBe(4);
    expect(refineLanes(oracle({ lanes: 8, tRunMs: { goalSubset: 2500, fullSuite: 2500 } }), 'candidate_file')).toBe(8);
    expect(refineLanes(oracle({ lanes: 2, tRunMs: { goalSubset: 300, fullSuite: 300 } }), 'copy')).toBe(8);
    expect(refineLanes(oracle({ lanes: 1, tRunMs: { goalSubset: 300, fullSuite: 300 } }), 'inplace')).toBe(1);
  });
  it('estimateRunMs: sequential pytest stops after one timeout; run_tests.py overlaps its hung cases in rounds of 8; no knob → raw', () => {
    const prof = caseProfile(BITCOUNT);
    expect(estimateRunMs('pytest', prof, 500, 18_238)).toBe(738);
    expect(estimateRunMs('quixbugs', prof, 500, 18_238)).toBe(200 + 38 + Math.ceil(9 / 8) * 500);
    expect(estimateRunMs('other', prof, null, 18_238)).toBe(18_238);
    expect(estimateRunMs('pytest', prof, null, 18_238)).toBe(18_238);
    // the per-hang cost never exceeds the limit the case actually ran under
    expect(estimateRunMs('pytest', { ...prof, caseLimitMs: 300 }, 500, 18_238)).toBe(200 + 38 + 300);
  });
  it('decideRunPlan on bitcount: 421 candidates run as a SIEVE inside the 90 s test wall at 8 lanes', () => {
    const o = fitOracle(BITCOUNT, LIMITS);
    const b = freshBudget({ maxWallMs: 360_000 }, o, 360_000, { now: () => 0 });
    expect(b.testWallLeftMs).toBe(90_000);
    expect(b.testRunsLeft).toBe(QUIXBUGS_TEST_RUNS_MAX);
    // floor(90 000 × 8 / 738) = 975 runs fit the wall
    expect(runsLeft(o, b)).toBe(975);
    expect(decideRunPlan(421, { kind: 'replace' }, o, b)).toEqual({ mode: 'SIEVE', k: 421, runsAllowed: 421 });
    expect((421 * o.tRunMs.goalSubset) / o.lanes).toBeLessThan(90_000);
    // without the stop rule the same 500 ms timeout costs 9 × 500 + 238 = 4.7 s a run: repository class, RANK at 16 runs a step
    const noStop = { ...o, tRunMs: { goalSubset: 4738, fullSuite: 4738 }, lanes: 4 };
    expect(oracleClass(noStop)).toBe('repository_class');
    const rb = freshBudget({ maxWallMs: 360_000 }, noStop, 360_000, { now: () => 0 });
    expect(rb.testRunsLeft).toBe(REPO_TEST_RUNS_MAX);
    expect(decideRunPlan(421, { kind: 'replace' }, noStop, rb)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
  });
  it('refineTRun keeps a sieve-eligible estimate through a load spike within 1.5 × SIEVE_MAX_T_RUN_MS, takes anything else as measured', () => {
    expect(SIEVE_KEEP_FACTOR).toBe(1.5);
    expect(refineTRun(580, 650)).toBe(650); // dearer but still QuixBugs-class: the measurement is the better number
    expect(refineTRun(300, 270)).toBe(270); // cheaper than estimated
    expect(refineTRun(580, 2500)).toBe(580); // a loaded batch of long tracebacks: not the suite's speed
    expect(refineTRun(580, SIEVE_MAX_T_RUN_MS)).toBe(580); // 2000 is not under the class line, and inside the band
    expect(refineTRun(580, 3001)).toBe(3001); // above the band: the lanes are really that slow → RANK
    expect(refineTRun(5000, 2500)).toBe(2500); // a repository-class estimate has no sieve to keep
    expect(refineTRun(300, 0)).toBe(300);
    expect(refineTRun(300, Number.NaN)).toBe(300);
    expect(refineTRun(300, 270.4)).toBe(270);
  });
  it('laneRunTimeout tightens the workspace timeout to the lane settings, bounded by every case hitting the alarm', () => {
    const o = fitOracle(BITCOUNT, LIMITS);
    // min(64 714, max(3 × 738 + 10 s = 12 214, 200 + 9 × 500 + 10 s = 14 700))
    expect(laneRunTimeout(o, BITCOUNT)).toBe(14_700);
    expect(laneRunTimeout(o, BITCOUNT)).toBeLessThan(o.runTimeoutMs);
    // never above the oracle's run timeout, never below the floor
    expect(laneRunTimeout(oracle({ runTimeoutMs: 10_000, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 2000 }), GCD_BASELINE)).toBe(10_000);
    expect(laneRunTimeout(oracle({ runTimeoutMs: MIN_RUN_TIMEOUT_MS, tRunMs: { goalSubset: 1, fullSuite: 1 } }), GCD_BASELINE)).toBe(MIN_RUN_TIMEOUT_MS);
    // no per-test knob (runner other) or no baseline: 3 × t_run + 10 s
    expect(laneRunTimeout(oracle({ runner: 'other', runTimeoutMs: 120_000, tRunMs: { goalSubset: 5000, fullSuite: 5000 }, perTestTimeoutMs: null }), null)).toBe(25_000);
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
