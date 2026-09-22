import { describe, expect, it } from 'vitest';

import {
  applyLiveTRun,
  CASE_TAIL_MAX_CASES,
  caseProfile,
  caseTail,
  COMPACT_NOUL_MIN_CANDIDATES,
  decideRunPlan,
  detectRunner,
  emptyRunSamples,
  estimateRunMs,
  fitOracle,
  freshBudget,
  hasCheapGoalSubset,
  LANE_MAX_CASE_TIMEOUTS,
  laneRunTimeout,
  LIVE_MIN_SAMPLES,
  LIVE_REPRO_WINDOW,
  LIVE_SCOPED_WINDOW,
  liveMedian,
  liveTRun,
  LOAD_SCALE_MIN_RATIO,
  loadRatio,
  MIN_RUN_TIMEOUT_MS,
  oracleClass,
  passersReserveMs,
  QUIXBUGS_CLASS_MAX_FULL_SUITE_MS,
  QUIXBUGS_TEST_WALL_MAX_MS,
  recordRunSamples,
  stepTestWallMs,
  parseQuixbugsCommand,
  perTestTimeout,
  PER_TEST_TIMEOUT_FACTOR,
  PER_TEST_TIMEOUT_MAX_MS,
  PER_TEST_TIMEOUT_MIN_MS,
  PROCESS_OVERHEAD_MS,
  pytestCaseDurations,
  pytestSessionMs,
  QUIXBUGS_JEV_REQUESTS_MAX,
  QUIXBUGS_TEST_RUNS_MAX,
  refineLanes,
  refineTRun,
  RANK_K_SITE_MAX,
  REPO_JEV_REQUESTS_MAX,
  REPO_PASSERS_RESERVED,
  REPO_TEST_RUNS_CAP,
  REPO_TEST_RUNS_MAX,
  REPO_TEST_WALL_MAX_MS,
  repositoryRunsPerStep,
  RETRY_CASE_TIMEOUT_MS,
  runsLeft,
  runTimeout,
  scaledCaseTimeout,
  shellWords,
  SESSION_OVERHEAD_MS,
  SIEVE_KEEP_FACTOR,
  SIEVE_MAX_T_RUN_MS,
  poolFitsRunBudget,
  rankPoolCap,
  siteShare,
} from '../../../../src/synth/search/budget.js';
import { MAX_FULL_SUITE_RUNS_PER_STEP } from '../../../../src/synth/sieve/runner.js';
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
  it('per-test timeout uses the measured per-case times when given (their tail) and clamps at 2 s', () => {
    expect(fitOracle(GCD_BASELINE, { ...LIMITS, caseDurationsMs: [400] }).perTestTimeoutMs).toBe(1200);
    expect(fitOracle(GCD_BASELINE, { ...LIMITS, caseDurationsMs: [10, 1000, 20] }).perTestTimeoutMs).toBe(2000);
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
    expect(caseProfile(BITCOUNT)).toEqual({ ran: 9, timeouts: 9, notRun: 0, finished: 0, caseLimitMs: 2000, sessionMs: null, startupMs: null, overheadMs: 200, finishedTotalMs: 38, finishedMeanMs: null, caseDurations: null, tailMs: null });
    const sq = caseProfile(SQRT);
    expect(sq).toMatchObject({ ran: 7, timeouts: 6, finished: 1, caseLimitMs: 2000, overheadMs: 200, finishedTotalMs: 29, finishedMeanMs: 29, tailMs: 29 });
    // no timeout: everything but process start is the finished cases (gcd: 300 ms over 6 cases); without
    // per-case times the tail is bounded by their total (it could all be one case)
    expect(caseProfile(GCD_BASELINE)).toMatchObject({ ran: 6, timeouts: 0, finished: 6, overheadMs: PROCESS_OVERHEAD_MS, finishedTotalMs: 100, caseDurations: null, tailMs: 100 });
    // the limit the cases ran under is read back (run_tests.py's text, 0.5 s); process start never exceeds what is left
    const rt = summary({ command: GCD_BASELINE.command, failing: ['gcd(13, 13)'], failures: [{ testId: 'gcd(13, 13)', call: 'gcd(13, 13)', expected: '13', actual: 'TIMEOUT after 0.5s' }], durationMs: 550 });
    expect(caseProfile(rt)).toMatchObject({ timeouts: 1, caseLimitMs: 500, overheadMs: 50, finishedTotalMs: 0, finishedMeanMs: null, tailMs: null });
    // stop-rule "not run" failures (lane runs) are neither finished nor timed out
    const nr = summary({ command: PYTEST, failing: ['a', 'b'], failures: [{ testId: 'a', call: 'a', expected: '', actual: CASE_TIMEOUT_2S }, { testId: 'b', call: 'b', expected: '', actual: 'test_x.CaseNotRun: not run: 1 earlier case(s) timed out' }], durationMs: 2300 });
    expect(caseProfile(nr)).toMatchObject({ ran: 2, timeouts: 1, notRun: 1, finished: 0, finishedMeanMs: null, tailMs: null });
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
  it('mixed baseline: the per-test timeout is clamp(3 × the tail of the cases that finished) — the hung cases do not vote', () => {
    // sqrt: one finished case in the 29 ms left → 87 ms → floor 500
    const sq = fitOracle(SQRT, LIMITS);
    expect(sq.perTestTimeoutMs).toBe(500);
    expect(sq.tRunMs.goalSubset).toBe(200 + 29 + 500);
    expect(oracleClass(sq)).toBe('quixbugs_class');
    // 4 hung cases at 2 s and 6 finished ones sharing 1.8 s with no per-case times: the tail is bounded by the
    // 1.8 s (3 × mean = 900 ms would have assumed the six are alike) → 2 s cap; a hanging lane run then costs 200 + 1800 + 2000
    const mixed = fitOracle(pytestBaseline({ hang: 4, wrong: 2, pass: 4, durationMs: 4 * 2000 + PROCESS_OVERHEAD_MS + 6 * 300 }), LIMITS);
    expect(mixed.perTestTimeoutMs).toBe(2000);
    expect(mixed.tRunMs.goalSubset).toBe(4000);
    expect(oracleClass(mixed)).toBe('repository_class');
    // with the six measured alike (300 ms each) the tail is 300 → 900 ms
    expect(fitOracle(pytestBaseline({ hang: 4, wrong: 2, pass: 4, durationMs: 4 * 2000 + PROCESS_OVERHEAD_MS + 6 * 300 }), { ...LIMITS, caseDurationsMs: [300, 300, 300, 300, 300, 300] }).perTestTimeoutMs).toBe(900);
    // measured per-case times handed in win over the profile's bound
    expect(fitOracle(SQRT, { ...LIMITS, caseDurationsMs: [400] }).perTestTimeoutMs).toBe(1200);
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
    expect(sq).toMatchObject({ timeouts: 6, finished: 1, sessionMs: 12_330, startupMs: 1040, overheadMs: SESSION_OVERHEAD_MS, finishedTotalMs: 280, finishedMeanMs: 280, tailMs: 280 });
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
    // without the stop rule the same 500 ms timeout costs 9 × 500 + 238 = 4.7 s a run: repository class, RANK; the runs per
    // step follow the wall: floor((min(8 × 18 238, 360 000) − 5 × 4738) × 4 lanes / 4738) = 103 (repositoryRunsPerStep, lane-seconds)
    const noStop = { ...o, tRunMs: { goalSubset: 4738, fullSuite: 4738 }, lanes: 4 };
    expect(oracleClass(noStop)).toBe('repository_class');
    const rb = freshBudget({ maxWallMs: 360_000 }, noStop, 360_000, { now: () => 0 });
    expect(rb.testWallLeftMs).toBe(8 * 18_238);
    expect(rb.testRunsLeft).toBe(103);
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

describe('per-test timeout from the tail of the per-case distribution (skew), load scaling', () => {
  /** pytest's `--durations=0` table under `-q` (the real shape, longest_common_subsequence's buggy baseline idle). */
  const LCS_IDS = Array.from({ length: 10 }, (_, i) => `tests/test_lcs.py::test_lcs[${i}-x]`);
  const durationsTable = (ms: readonly number[]): string =>
    `============================== slowest durations ===============================\n${ms
      .map((m, i) => ({ m, i }))
      .sort((a, b) => b.m - a.m)
      .map(({ m, i }) => `${(m / 1000).toFixed(2)}s call     ${LCS_IDS[i]}`)
      .join('\n')}\n0.01s setup    ${LCS_IDS[8]}\n\n(25 durations < 0.005s hidden.  Use -vv to show these durations.)\n`;
  /** LCS-like: one 184 ms case, nine 10 ms cases; four fail on values, every case finished; the output tail carries the table. */
  const skewed = (caseMs: readonly number[], over: Partial<TestRunSummary> = {}): TestRunSummary =>
    summary({
      command: PYTEST,
      passing: LCS_IDS.filter((_, i) => ![3, 5, 6, 7].includes(i)),
      failing: [3, 5, 6, 7].map((i) => LCS_IDS[i] ?? ''),
      failures: [3, 5, 6, 7].map((i) => ({ testId: LCS_IDS[i] ?? '', call: LCS_IDS[i] ?? '', expected: "'BCBA'", actual: "'BBDAB'" })),
      durationMs: 700,
      outputTail: `${durationsTable(caseMs)}=========================== short test summary info ============================\nFAILED ${LCS_IDS[3]} - AssertionError\n4 failed, 6 passed in 0.45s\n`,
      ...over,
    });
  const LCS_CASES = [10, 10, 10, 184, 10, 10, 10, 10, 10, 10];

  it('pytestCaseDurations reads the `call` rows of the durations table (setup/teardown and the hidden note ignored); empty without a table', () => {
    const rows = pytestCaseDurations(durationsTable(LCS_CASES));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ testId: LCS_IDS[3], ms: 180 }); // 0.18s: pytest prints two decimals
    expect(rows.slice(1).every((r) => r.ms === 10)).toBe(true);
    expect(pytestCaseDurations('4 failed, 6 passed in 0.45s\n')).toEqual([]);
    expect(pytestCaseDurations('')).toEqual([]);
    // run_tests.py's JSON has no table
    expect(pytestCaseDurations('{"passed": 1, "failures": [{"actual": "TIMEOUT after 2s"}]}')).toEqual([]);
  });
  it('caseTail: the maximum up to 20 samples, the p95 (nearest rank) above; ignores non-finite samples; null when empty', () => {
    expect(CASE_TAIL_MAX_CASES).toBe(20);
    expect(caseTail(LCS_CASES)).toBe(184);
    expect(caseTail([5])).toBe(5);
    expect(caseTail([])).toBeNull();
    expect(caseTail([Number.NaN, -1])).toBeNull();
    // 21 samples: rank ceil(0.95 × 21) = 20 → the second largest; the one outlier no longer sets the cap
    const twentyOne = [...Array.from({ length: 20 }, (_, i) => 10 + i), 5000];
    expect(caseTail(twentyOne)).toBe(29);
    // 100 samples: rank 95
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(caseTail(hundred)).toBe(95);
    expect(caseTail([...hundred].reverse())).toBe(95);
  });
  it('the skewed baseline (one 184 ms case, nine 10 ms cases): ≥ 552 ms, not the 500 ms floor the mean gave', () => {
    const prof = caseProfile(skewed(LCS_CASES));
    expect(prof.caseDurations).toHaveLength(10);
    expect(prof.tailMs).toBe(180);
    // the mean is skew-blind: (450 − 50) / 10 = 40 ms → 3 × 40 = 120 → the floor
    expect(prof.finishedMeanMs).toBe(40);
    expect(perTestTimeout('pytest', prof.finishedMeanMs)).toBe(PER_TEST_TIMEOUT_MIN_MS);
    // the tail: 3 × 180 = 540 ms from the table (two-decimal rounding), 552 from the measured 184 ms
    const o = fitOracle(skewed(LCS_CASES), LIMITS);
    expect(o.perTestTimeoutMs).toBe(540);
    expect(o.perTestTimeoutMs).toBeGreaterThan(PER_TEST_TIMEOUT_MIN_MS);
    expect(fitOracle(skewed(LCS_CASES), { ...LIMITS, caseDurationsMs: LCS_CASES }).perTestTimeoutMs).toBe(PER_TEST_TIMEOUT_FACTOR * 184);
    expect(PER_TEST_TIMEOUT_FACTOR * 184).toBeGreaterThanOrEqual(552);
    // the estimate of a lane run does not change: it is the finished cases' total plus start-up either way
    expect(o.tRunMs.goalSubset).toBe(PROCESS_OVERHEAD_MS + 450);
    // a uniform suite (ten 10 ms cases) stays at the floor
    expect(fitOracle(skewed(Array.from({ length: 10 }, () => 10)), LIMITS).perTestTimeoutMs).toBe(PER_TEST_TIMEOUT_MIN_MS);
    // the cases that hit the alarm do not vote even when the table lists them (their row is the limit itself)
    const withHang = skewed(LCS_CASES, { failures: [{ testId: LCS_IDS[3] ?? '', call: LCS_IDS[3] ?? '', expected: '', actual: CASE_TIMEOUT_2S }] });
    expect(caseProfile(withHang).caseDurations?.some((d) => d.testId === LCS_IDS[3])).toBe(false);
    expect(caseProfile(withHang).tailMs).toBe(10);
  });
  it('without per-case times the tail is bounded by the finished cases\' total (it could all be one case): LCS under `pytest -q`', () => {
    // the live baseline: "4 failed, 6 passed in 0.45s", no durations table → 400 ms of cases → 3 × 400 = 1 200 ms, not the 500 ms floor
    const plain = skewed(LCS_CASES, { outputTail: '4 failed, 6 passed in 0.45s\n' });
    const prof = caseProfile(plain);
    expect(prof.caseDurations).toBeNull();
    expect(prof.tailMs).toBe(400);
    expect(fitOracle(plain, LIMITS).perTestTimeoutMs).toBe(1200);
    // the bound never exceeds the 2 s cap and never moves a hang-dominated suite off the floor (bitcount: nothing finished)
    expect(fitOracle(BITCOUNT_LOADED, LIMITS).perTestTimeoutMs).toBe(PER_TEST_TIMEOUT_MIN_MS);
    expect(fitOracle(SQRT_LOADED, LIMITS).perTestTimeoutMs).toBe(840);
  });
  it('loadRatio and scaledCaseTimeout: the cap follows a batch median above 2 × the estimate, bounded by 2 s, never below the oracle\'s', () => {
    expect(LOAD_SCALE_MIN_RATIO).toBe(2);
    expect(loadRatio(1150, 500)).toBe(2.3);
    expect(loadRatio(300, 500)).toBe(1); // faster than estimated is not a load
    expect(loadRatio(null, 500)).toBe(1);
    expect(loadRatio(0, 500)).toBe(1);
    expect(loadRatio(Number.NaN, 500)).toBe(1);
    expect(loadRatio(1000, 0)).toBe(1000);
    expect(scaledCaseTimeout(500, 2.3)).toBe(1150);
    expect(scaledCaseTimeout(500, 1.9)).toBe(500);
    expect(scaledCaseTimeout(500, 2)).toBe(1000);
    expect(scaledCaseTimeout(500, 9)).toBe(PER_TEST_TIMEOUT_MAX_MS);
    expect(scaledCaseTimeout(1200, 2.5)).toBe(PER_TEST_TIMEOUT_MAX_MS);
    expect(scaledCaseTimeout(500, Number.NaN)).toBe(500);
    // the retry of a provisional timeout runs at the runners' own default
    expect(RETRY_CASE_TIMEOUT_MS).toBe(PER_TEST_TIMEOUT_MAX_MS);
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
  it('repository-class: testWall ≤ min(8 × baseline, 600 s, wallRemaining), 16 runs when every candidate costs a full suite, 60 requests', () => {
    const b = freshBudget({ maxWallMs: 3_600_000 }, slow, 1_000_000);
    // goal subset = full suite (5 s each): floor((40 s − 5 × 5 s) / 5 s) × 4 = 12, so the design's 16 is the floor
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
    expect(runsLeft(swe, b)).toBe(16); // min(16, floor(40 s x 4 / 5 s) = 32)
    // 10 <= 16 runs left: OOS 2026-09-22 ranked change 1 runs the pool instead of ordering it
    expect(decideRunPlan(10, replace, swe, b)).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 10 });
    expect(decideRunPlan(10, insert, swe, b)).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 10 });
    expect(decideRunPlan(17, replace, swe, b)).toEqual({ mode: 'RANK', k: 3, runsAllowed: 3 });
    expect(decideRunPlan(17, insert, swe, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    expect(decideRunPlan(COMPACT_NOUL_MIN_CANDIDATES - 1, replace, swe, b).k).toBe(3);
    expect(decideRunPlan(COMPACT_NOUL_MIN_CANDIDATES, replace, swe, b).k).toBe(5);
    expect(decideRunPlan(1641, replace, swe, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    // t_run no longer cuts SIEVE off on its own: the pool-against-budget comparison is the whole test,
    // and `runsLeft` is where an expensive run is already priced (OOS 2026-09-22 ranked change 1)
    expect(decideRunPlan(3, replace, oracle({ tRunMs: { goalSubset: SIEVE_MAX_T_RUN_MS, fullSuite: 0 } }), b).mode).toBe('SIEVE');
    expect(decideRunPlan(3, replace, oracle({ tRunMs: { goalSubset: SIEVE_MAX_T_RUN_MS + 1, fullSuite: 0 } }), b).mode).toBe('SIEVE');
    // an expensive run shrinks the runs left, and the pool stops fitting there
    const slow = oracle({ runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 60_000, fullSuite: 60_000 } });
    expect(runsLeft(slow, b)).toBe(0); // floor(40 s x 1 / 60 s)
    expect(decideRunPlan(3, replace, slow, b)).toEqual({ mode: 'RANK', k: 0, runsAllowed: 0 });
  });
  it('K never exceeds the runs left; an empty set is a SIEVE of nothing; arrays count like numbers', () => {
    const swe = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
    expect(decideRunPlan(200, insert, swe, budget({ testRunsLeft: 2 }))).toEqual({ mode: 'RANK', k: 2, runsAllowed: 2 });
    expect(decideRunPlan(200, insert, swe, budget({ testRunsLeft: 0 }))).toEqual({ mode: 'RANK', k: 0, runsAllowed: 0 });
    expect(decideRunPlan([], replace, quix, budget())).toEqual({ mode: 'SIEVE', k: 0, runsAllowed: 0 });
  });
});

describe('repository-class runs per step from the measured oracle, and the budget-sized RANK take (§4.3 / §2.4, 2026-09-20)', () => {
  // sympy-15345 as measured (jev-only-swebench-2-oracle): scoped `bin/test` on 6 files 18 642 ms, the reproduction 2 058 ms, 4 lanes
  const sympy = oracle({ runner: 'other', lanes: 4, tRunMs: { goalSubset: 2058, fullSuite: 18_642 }, perTestTimeoutMs: null, baselineDurationMs: 18_642 });
  // Django-15315-like: 100 s scoped runtests.py, a 2.8 s reproduction
  const django = oracle({ runner: 'other', lanes: 4, tRunMs: { goalSubset: 2800, fullSuite: 100_000 }, perTestTimeoutMs: null, baselineDurationMs: 100_000 });
  const replace = { kind: 'replace' as const };
  const insert = { kind: 'insert' as const };

  it('the reserve for the passers is the runner\'s passer cap', () => {
    expect(REPO_PASSERS_RESERVED).toBe(MAX_FULL_SUITE_RUNS_PER_STEP);
  });
  it('runs = floor((testWall − 5 × t_full) / t_repro) × lanes, bounded to [16, 160]', () => {
    // sympy-15345: wall 8 × 18.6 s = 149 s; reserve 93 s; floor(55.9 s / 2.06 s) = 27 → × 4 = 108 (the design's 16 let 16 of 727 run)
    expect(repositoryRunsPerStep(sympy, 8 * 18_642)).toBe(108);
    // Django: the 600 s cap; (600 − 500) × 4 / 2.8 = 142.8 → 142 (lane-seconds over t_run; the old floor-then-× lanes gave 140)
    expect(repositoryRunsPerStep(django, 600_000)).toBe(142);
    // the same wall with the reproduction measured at 8 s under load (the lanes' running median): 108 × 2.06 / 8 → 27
    expect(repositoryRunsPerStep({ ...sympy, tRunMs: { goalSubset: 8000, fullSuite: 18_642 } }, 8 * 18_642)).toBe(27);
    // a scoped suite over 120 s: the reserve exceeds the capped wall → the floor
    expect(repositoryRunsPerStep(oracle({ lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 150_000 } }), 600_000)).toBe(REPO_TEST_RUNS_MAX);
    // the cap: a fast reproduction against a 60 s scope: (480 − 300) / 2 = 90 → 360 → 160
    expect(repositoryRunsPerStep(oracle({ lanes: 4, tRunMs: { goalSubset: 2000, fullSuite: 60_000 } }), 480_000)).toBe(REPO_TEST_RUNS_CAP);
    // every candidate a full suite (best guess; a plain pytest module): (8b − 5b) / b × 4 = 12 → the design's 16, whatever b
    for (const b of [5000, 30_000, 75_000]) expect(repositoryRunsPerStep(oracle({ lanes: 4, tRunMs: { goalSubset: b, fullSuite: b } }), Math.min(8 * b, 600_000))).toBe(REPO_TEST_RUNS_MAX);
    expect(repositoryRunsPerStep(oracle({ lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 20_000 } }), 0)).toBe(REPO_TEST_RUNS_MAX);
  });
  it('freshBudget reads it for the repository class; the QuixBugs class keeps 1,500', () => {
    const b = freshBudget({ maxWallMs: 1_500_000 }, sympy, 1_400_000, { now: () => 0 });
    expect(b.testWallLeftMs).toBe(8 * 18_642);
    expect(b.testRunsLeft).toBe(108);
    expect(b.jevRequestsLeft).toBe(REPO_JEV_REQUESTS_MAX);
    // the wall remaining bounds the count too: 60 s of run left → wall 60 s → floor((60 − 93) …) < 0 → the floor
    expect(freshBudget({ maxWallMs: 1_500_000 }, sympy, 60_000).testRunsLeft).toBe(REPO_TEST_RUNS_MAX);
    expect(freshBudget({ maxWallMs: 1_500_000 }, django, 1_400_000).testRunsLeft).toBe(142);
    const quix = oracle({ lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 4000 } });
    expect(hasCheapGoalSubset(quix)).toBe(true);
    expect(freshBudget({ maxWallMs: 3_600_000 }, quix, 600_000).testRunsLeft).toBe(QUIXBUGS_TEST_RUNS_MAX);
  });
  it('hasCheapGoalSubset: the reproduction cheaper than the scoped suite; never when the two cost the same', () => {
    expect(hasCheapGoalSubset(sympy)).toBe(true);
    expect(hasCheapGoalSubset(oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }))).toBe(false);
    expect(hasCheapGoalSubset(oracle({ tRunMs: { goalSubset: 0, fullSuite: 5000 } }))).toBe(false);
  });
  it('RANK with sitesLeft on a cheap repository oracle: K is the site\'s share of the runs left, at most 16, never below 3/5 or above the runs left', () => {
    const b = freshBudget({ maxWallMs: 1_500_000 }, sympy, 1_400_000, { now: () => 0 }); // 108 runs
    expect(decideRunPlan(727, replace, sympy, b, { sitesLeft: 12 })).toEqual({ mode: 'RANK', k: 9, runsAllowed: 9 });
    expect(decideRunPlan(727, replace, sympy, b, { sitesLeft: 1 })).toEqual({ mode: 'RANK', k: RANK_K_SITE_MAX, runsAllowed: RANK_K_SITE_MAX });
    expect(decideRunPlan(727, replace, sympy, b, { sitesLeft: 4 })).toEqual({ mode: 'RANK', k: 16, runsAllowed: 16 });
    // a small share never undercuts the fixed rule (3 at replace sites, 5 at gaps and on compact sets)
    // 10 candidates against 20 runs left is a SIEVE now (ranked change 1); 100 against 20 is not.
    // The site's share caps what the SIEVE may SPEND here (review finding 7): floor(20/12) = 1.
    expect(decideRunPlan(10, replace, sympy, budget({ testRunsLeft: 20, testWallLeftMs: 600_000 }), { sitesLeft: 12 })).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 1 });
    expect(decideRunPlan(10, insert, sympy, budget({ testRunsLeft: 20, testWallLeftMs: 600_000 }), { sitesLeft: 12 })).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 1 });
    expect(decideRunPlan(100, replace, sympy, budget({ testRunsLeft: 20, testWallLeftMs: 600_000 }), { sitesLeft: 12 })).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    // never above the runs left
    expect(decideRunPlan(727, replace, sympy, budget({ testRunsLeft: 2, testWallLeftMs: 600_000 }), { sitesLeft: 1 })).toEqual({ mode: 'RANK', k: 2, runsAllowed: 2 });
    // without sitesLeft (the best-guess path, callers outside the loop): the fixed K
    expect(decideRunPlan(727, replace, sympy, b)).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    expect(decideRunPlan(10, replace, sympy, b)).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 10 });
  });
  /**
   * docs/research/llm-jev/oos-analysis-2026-09-22.md ranked change 1. Q2: 707 SIEVE/RANK
   * `candidate_*` requests, 64,961 questions, $0.4260 of the slice's $0.6233 (68 %); 393/397 of
   * the ladder's and 302/302 of SWE's fired in steps whose search found `plausible = 0`. Q4:
   * sympy-16792 (`20260922-063202-e44wjtrm`) enumerated 28,878 candidates, ranked 27,754 and
   * could test 1,191 — 178 requests / 26,489 questions for an order over a pool 24x the run
   * budget. Q5: QuixBugs paid 3 sieve requests across all ten tasks because a 9-11-site pool at
   * t_run <= 520 ms is fully testable in one round.
   */
  it('poolFitsRunBudget is the whole SIEVE/RANK test: a pool with a passer inside the run budget spends no ranking request, a pool larger than the budget still ranks (OOS 2026-09-22 ranked change 1)', () => {
    // QuixBugs shape: 11 sites x ~10 one-line edits at t_run 520 ms, decided by the goal test alone
    const quix = oracle({ lanes: 8, tRunMs: { goalSubset: 520, fullSuite: 520 } });
    const qb = budget({ testRunsLeft: 1500, testWallLeftMs: 90_000 });
    expect(poolFitsRunBudget(110, runsLeft(quix, qb))).toBe(true);
    expect(decideRunPlan(110, { kind: 'replace' }, quix, qb).mode).toBe('SIEVE');
    // sympy-16792's shape: the pool is 24x the runs the step can spend, so the order is still bought
    const sympy16792 = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 1574, fullSuite: 1574 } });
    const swe = budget({ testRunsLeft: 1191, testWallLeftMs: 600_000 });
    expect(runsLeft(sympy16792, swe)).toBe(1191);
    expect(poolFitsRunBudget(28_878, 1191)).toBe(false);
    expect(decideRunPlan(28_878, { kind: 'replace' }, sympy16792, swe).mode).toBe('RANK');
    // and at the boundary the comparison is pool <= budget, nothing else
    expect(poolFitsRunBudget(1191, 1191)).toBe(true);
    expect(poolFitsRunBudget(1192, 1191)).toBe(false);
    expect(poolFitsRunBudget(0, 0)).toBe(true); // an empty pool needs no order
  });

  /**
   * Review finding 5: the first version capped at `runsLeft` — the STEP's budget over every site
   * still to visit (4,574 in the reviewer's probe) where the visit itself runs `plan.k` = 5. It
   * priced ~1,000x more candidates than the order could pick and left ~90 % of change 1's saving
   * on the table. The cap is `k` plus at most `k` of margin for the `fixProbablyAbsent` signal.
   */
  it('rankPoolCap prices the ORDER, not the step: k = 5 prices at most 10, never runsLeft (review finding 5)', () => {
    expect(rankPoolCap(5, 4574)).toBe(10);
    expect(rankPoolCap(3, 4574)).toBe(6);
    expect(rankPoolCap(16, 4574)).toBe(32);
    // never more than the runs actually left, and never less than k itself
    expect(rankPoolCap(5, 7)).toBe(7);
    expect(rankPoolCap(5, 5)).toBe(5);
    expect(rankPoolCap(5, 2)).toBe(2);
    expect(rankPoolCap(0, 4574)).toBe(0);
    expect(rankPoolCap(5, 0)).toBe(0);
    expect(rankPoolCap(-5, 10)).toBe(0);
    // sympy-16792 (OOS 2026-09-22 Q4): 27,754 ranked to test 1,191 in 178 requests. At k = 5 the
    // priced pool is 10, which is ONE request of the 150-candidate repository chunk.
    const priced = Math.min(27_754, rankPoolCap(5, 1191));
    expect(priced).toBe(10);
    expect(Math.ceil(priced / 150)).toBe(1);
  });

  /**
   * Review finding 7: `decideRunPlan` returned `runsAllowed = n` for SIEVE, ignoring `sitesLeft`.
   * With a 60 s oracle, 1 lane and a 20 min wall the step has 20 runs for 12 sites, so an
   * 18-candidate pool at the first source of the first site took 18 of them and starved 11 sites.
   */
  it('SIEVE spreads the run budget over the sites too: the reviewer\'s 60 s oracle never spends 18 runs at one site (review finding 7)', () => {
    const slow = oracle({ runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 60_000, fullSuite: 60_000 } });
    const b = budget({ testRunsLeft: 1500, testWallLeftMs: 20 * 60_000 });
    expect(runsLeft(slow, b)).toBe(20); // floor(20 min x 1 lane / 60 s)
    const plan = decideRunPlan(18, replace, slow, b, { sitesLeft: 12 });
    // the pool fits the STEP, so it is still a SIEVE — but it may not spend the whole step here
    expect(plan.mode).toBe('SIEVE');
    expect(plan.runsAllowed).toBe(1); // floor(20 / 12)
    expect(plan.runsAllowed).toBeLessThan(18);
    // with no sitesLeft given (the best-guess path, callers outside the loop) the whole pool runs
    expect(decideRunPlan(18, replace, slow, b)).toEqual({ mode: 'SIEVE', k: 18, runsAllowed: 18 });
    // at the last site the share is the whole remaining budget
    expect(decideRunPlan(18, replace, slow, b, { sitesLeft: 1 })).toEqual({ mode: 'SIEVE', k: 18, runsAllowed: 18 });
    // siteShare itself: never 0 while a run is left, so a site can always make progress
    expect(siteShare(20, 12)).toBe(1);
    expect(siteShare(60, 4)).toBe(15);
    expect(siteShare(1, 12)).toBe(1);
    expect(siteShare(0, 12)).toBe(0);
  });

  it('the sized take is confined to the cheap repository oracle: equal-cost and QuixBugs-class plans are unchanged', () => {
    const equal = oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
    const b = budget({ testRunsLeft: 100, testWallLeftMs: 600_000 });
    expect(decideRunPlan(10, replace, equal, b, { sitesLeft: 1 })).toEqual({ mode: 'SIEVE', k: 10, runsAllowed: 10 });
    expect(decideRunPlan(200, insert, equal, b, { sitesLeft: 1 })).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
    // QuixBugs class (t_run < 2 s) with a cheaper subset: RANK only when the set outgrows the runs left, and then the fixed K
    const quix = oracle({ lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 4000 } });
    const qb = budget({ testWallLeftMs: 3000 }); // 80 runs
    expect(decideRunPlan(80, replace, quix, qb, { sitesLeft: 1 }).mode).toBe('SIEVE');
    expect(decideRunPlan(81, replace, quix, qb, { sitesLeft: 1 })).toEqual({ mode: 'RANK', k: 5, runsAllowed: 5 });
  });
});

describe('the class reads both oracle costs, the wall reserves the scoped run, t_run follows the lanes (SWE-bench rung 3, 2026-09-20)', () => {
  // sympy-19954 as measured in rung 3: the reproduction 916 ms (3.5 s before the memory fix), the scoped baseline 41 353 ms idle,
  // its lane runs 48–82 s under `--concurrency 2`; 8 lanes (the reproduction is under 1 s)
  const sympy19954 = oracle({ runner: 'other', lanes: 8, tRunMs: { goalSubset: 916, fullSuite: 48_000 }, perTestTimeoutMs: null, baselineDurationMs: 41_353 });
  // django-15128 (solved by a SIEVE of 410 at step 2): a 985 ms reproduction, a 2.5 s scoped run
  const django15128 = oracle({ runner: 'other', lanes: 8, tRunMs: { goalSubset: 985, fullSuite: 2522 }, perTestTimeoutMs: null, baselineDurationMs: 2522 });
  const LIMITS_25M = { maxWallMs: 1_500_000 };

  it('oracleClass: QuixBugs only when the goal-subset run is under 2 s AND the scoped run under 10 s; QuixBugs and the ladder (equal costs) unchanged', () => {
    expect(QUIXBUGS_CLASS_MAX_FULL_SUITE_MS).toBe(10_000);
    expect(oracleClass(sympy19954)).toBe('repository_class');
    expect(oracleClass(django15128)).toBe('quixbugs_class');
    expect(oracleClass(oracle({ tRunMs: { goalSubset: 1999, fullSuite: 9999 } }))).toBe('quixbugs_class');
    expect(oracleClass(oracle({ tRunMs: { goalSubset: 1999, fullSuite: 10_000 } }))).toBe('repository_class');
    expect(oracleClass(oracle({ tRunMs: { goalSubset: 2000, fullSuite: 100 } }))).toBe('repository_class');
    expect(oracleClass(oracle({ tRunMs: { goalSubset: 300, fullSuite: 300 } }))).toBe('quixbugs_class');
    expect(oracleClass(oracle({ runner: 'pytest', tRunMs: { goalSubset: 5000, fullSuite: 5000 } }))).toBe('repository_class');
  });
  it('repro 0.9 s + scoped 48 s: repository class, the runs derived, the wall 8 × the scoped run with 5 × 48 s reserved for the passers', () => {
    const b = freshBudget(LIMITS_25M, sympy19954, 1_400_000, { now: () => 0 });
    expect(b.testWallLeftMs).toBe(8 * 48_000);
    expect(passersReserveMs(sympy19954)).toBe(5 * 48_000);
    // (384 s − 240 s) × 8 lanes / 0.916 s = 1257 → the 160 cap; the derived count, not the QuixBugs 1,500
    expect(b.testRunsLeft).toBe(REPO_TEST_RUNS_CAP);
    expect(b.testRunsLeft).toBe(repositoryRunsPerStep(sympy19954, b.testWallLeftMs));
    expect(Math.floor(((8 * 48_000 - 5 * 48_000) * 8) / 916)).toBe(1257);
    expect(b.jevRequestsLeft).toBe(REPO_JEV_REQUESTS_MAX);
    // the wall is the scoped run's cost, not the idle baseline's: 8 × 41.4 s would have been 331 s
    expect(b.testWallLeftMs).not.toBe(8 * 41_353);
    // under load the scoped median reads 80 s: the wall hits the 600 s cap and the reserve (400 s) leaves 200 s × 8 / 0.916 → still the cap
    const loaded = { ...sympy19954, tRunMs: { goalSubset: 1338, fullSuite: 80_000 } };
    expect(stepTestWallMs(loaded, 1_400_000)).toBe(REPO_TEST_WALL_MAX_MS);
    expect(repositoryRunsPerStep(loaded, REPO_TEST_WALL_MAX_MS)).toBe(REPO_TEST_RUNS_CAP);
    // a reserve past the wall (5 × 130 s over 600 s): the floor
    expect(repositoryRunsPerStep({ ...sympy19954, tRunMs: { goalSubset: 1000, fullSuite: 130_000 } }, REPO_TEST_WALL_MAX_MS)).toBe(REPO_TEST_RUNS_MAX);
    // the remaining run wall still bounds it
    expect(stepTestWallMs(sympy19954, 100_000)).toBe(100_000);
    // a SIEVE of the whole set only when it fits the derived count: 762 candidates do not, 150 do
    expect(decideRunPlan(762, { kind: 'insert' }, sympy19954, b).mode).toBe('RANK');
    expect(decideRunPlan(150, { kind: 'insert' }, sympy19954, b)).toEqual({ mode: 'SIEVE', k: 150, runsAllowed: 150 });
    expect(decideRunPlan(762, { kind: 'insert' }, sympy19954, b, { sitesLeft: 10 })).toEqual({ mode: 'RANK', k: 16, runsAllowed: 16 });
  });
  it('a cheap scoped run keeps the QuixBugs class, and its wall carries the passers\' reserve on top of the 90 s (django-15128\'s SIEVE of 410 still fits)', () => {
    const b = freshBudget(LIMITS_25M, django15128, 1_400_000, { now: () => 0 });
    expect(b.testRunsLeft).toBe(QUIXBUGS_TEST_RUNS_MAX);
    expect(b.testWallLeftMs).toBe(QUIXBUGS_TEST_WALL_MAX_MS + 5 * 2522);
    expect(decideRunPlan(410, { kind: 'insert' }, django15128, b)).toEqual({ mode: 'SIEVE', k: 410, runsAllowed: 410 });
    // the reserve never takes the wall past what the run has left
    expect(stepTestWallMs(django15128, 20_000)).toBe(Math.min(20_000, Math.floor(20_000 / 4) + 5 * 2522));
    expect(stepTestWallMs(django15128, 8_000)).toBe(8_000);
    // equal costs: no reserve, the design's numbers exactly
    expect(passersReserveMs(oracle({ tRunMs: { goalSubset: 300, fullSuite: 300 } }))).toBe(0);
    expect(stepTestWallMs(oracle({ tRunMs: { goalSubset: 300, fullSuite: 300 }, baselineDurationMs: 300 }), 600_000)).toBe(QUIXBUGS_TEST_WALL_MAX_MS);
    expect(stepTestWallMs(oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 5000, fullSuite: 5000 }, baselineDurationMs: 5000 }), 1_000_000)).toBe(40_000);
  });
  it('run samples: bounded windows of the last 16 reproduction and 4 scoped runs; a median only from 3 samples on', () => {
    expect([LIVE_REPRO_WINDOW, LIVE_SCOPED_WINDOW, LIVE_MIN_SAMPLES]).toEqual([16, 4, 3]);
    const s = emptyRunSamples();
    recordRunSamples(s, [900, 1000], [48_000]);
    expect(s).toEqual({ repro: [900, 1000], scoped: [48_000] });
    expect(liveMedian(s.repro)).toBeNull();
    recordRunSamples(s, [1100.4, Number.NaN, 0, -5], [72_000, 82_000, 47_000, 81_000]);
    expect(s.repro).toEqual([900, 1000, 1100]);
    expect(s.scoped).toEqual([72_000, 82_000, 47_000, 81_000]); // the 48 s run fell out of the window of 4
    expect(liveMedian(s.repro)).toBe(1000);
    expect(liveMedian(s.scoped)).toBe(76_500);
    recordRunSamples(s, Array.from({ length: 20 }, (_, i) => 2000 + i), []);
    expect(s.repro).toHaveLength(16);
    expect(s.repro[0]).toBe(2004);
  });
  it('liveTRun / applyLiveTRun: the windows\' medians once live (the reproduction through the §2.4 hysteresis), the oracle\'s numbers before', () => {
    const o = oracle({ runner: 'other', lanes: 8, tRunMs: { goalSubset: 916, fullSuite: 41_353 }, perTestTimeoutMs: null, baselineDurationMs: 41_353 });
    const s = recordRunSamples(emptyRunSamples(), [1300, 1400], [80_000, 72_000]);
    expect(liveTRun(o, s)).toEqual({ goalSubset: 916, fullSuite: 41_353, live: { repro: false, scoped: false } });
    recordRunSamples(s, [1338], [82_000]);
    const t = applyLiveTRun(o, s);
    expect(t).toEqual({ goalSubset: 1338, fullSuite: 80_000, live: { repro: true, scoped: true } });
    expect(o.tRunMs).toEqual({ goalSubset: 1338, fullSuite: 80_000 });
    // the class and the step follow: repository class, wall 600 s (8 × 80 s capped), 160 runs
    expect(oracleClass(o)).toBe('repository_class');
    const b = freshBudget({ maxWallMs: 1_500_000 }, o, 1_200_000, { now: () => 0 });
    expect(b.testWallLeftMs).toBe(REPO_TEST_WALL_MAX_MS);
    expect(b.testRunsLeft).toBe(REPO_TEST_RUNS_CAP);
    // hysteresis: a sieve-eligible 1.9 s reproduction measured at 2.5 s under load keeps 1.9 s; 8 s is the truth
    const sieve = oracle({ tRunMs: { goalSubset: 1900, fullSuite: 18_642 } });
    expect(liveTRun(sieve, recordRunSamples(emptyRunSamples(), [2500, 2500, 2600], [])).goalSubset).toBe(1900);
    expect(liveTRun(sieve, recordRunSamples(emptyRunSamples(), [8000, 8000, 8100], [])).goalSubset).toBe(8000);
    // idle 2 s → 108 runs a step; the same oracle with the lanes reporting 8 s → 27 (sympy-15345's numbers)
    const idle = oracle({ runner: 'other', lanes: 4, tRunMs: { goalSubset: 2058, fullSuite: 18_642 }, perTestTimeoutMs: null, baselineDurationMs: 18_642 });
    expect(freshBudget({ maxWallMs: 1_500_000 }, idle, 1_400_000).testRunsLeft).toBe(108);
    applyLiveTRun(idle, recordRunSamples(emptyRunSamples(), [8000, 7900, 8100], []));
    expect(idle.tRunMs.goalSubset).toBe(8000);
    expect(freshBudget({ maxWallMs: 1_500_000 }, idle, 1_400_000).testRunsLeft).toBe(27);
  });
});
