/**
 * Oracle model and per-step budgets for the Ledger + Sieve search (docs/JEV-ONLY-DESIGN.md
 * §2.4, §4.1, §4.3). Everything here is arithmetic on the baseline run: which runner the test
 * command is, how many lanes to overlap, how long one run may take, how many runs and requests a
 * step may spend, and whether a candidate set is run whole (SIEVE) or Jev-ordered first (RANK).
 * No Jev question is asked; the numbers behind every constant are quoted from
 * experiments/results/ and experiments/designs/contrarian.md.
 */
import type { RunLimits } from '../../core/types.js';
import type { Candidate, Site, TestRunSummary } from '../types.js';
import { countCaseTimeouts } from '../verify/quixbugs.js';
import type { OracleModel, RunPlan, StepBudget } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement it rests on)
// ---------------------------------------------------------------------------------------

/**
 * SIEVE (run every candidate, let python3 rank) is allowed only when one goal-subset run is at
 * most this long: at the true line the whole first-order set runs in a median 3.8 s at 8-way
 * (`contrarian-exhaustive.truth.jsonl`, run p50 87–395 ms on non-looping lines); above 2 s per
 * run the arithmetic flips to Jev ordering (§2.4: 1,641 mutants × 5–60 s on SWE).
 */
export const SIEVE_MAX_T_RUN_MS = 2000;

/** §4.3: a suite is QuixBugs-class when the goal-subset run is under 2 s, repository-class otherwise. */
export const QUIXBUGS_CLASS_MAX_T_RUN_MS = 2000;

/** §4.1: 8 lanes when a run is under 1 s (QuixBugs runs are 87–395 ms p50 and the exhaustive study ran 8- and 12-way). */
export const FAST_SUITE_T_RUN_MS = 1000;
export const LANES_FAST_SUITE = 8;
/** §4.1: 4 lanes on pytest modules (3–20 s F2P runs; `contrarian.md` §3.2 sizes SWE steps at "/ 4"). */
export const LANES_PYTEST = 4;
/** §4.1: 2 lanes when the workspace is over 50 MB and not git (no worktrees, `cp -R` too costly). */
export const LANES_LARGE_NON_GIT = 2;
/** §4.2: `cp -R` shadow copies are made only up to this size. */
export const LARGE_WORKSPACE_BYTES = 50 * 1024 * 1024;

/**
 * Adaptive per-test timeout for the per-case runners (run_tests.py `--timeout`, the bench's
 * generated pytest module through JEVCODE_CASE_TIMEOUT_MS): clamp(3 × p50 of the baseline's
 * cases that finished, 0.5 s, 2 s); 0.5 s when no case finished (every case hung). The 0.5 s
 * floor rejected no gold fix on 35/35 enumerated replacements while cutting the
 * timeout-dominated programs (`sqrt` 47.6 s → 31.9 s; `contrarian-exhaustive.all.jsonl`,
 * `judge2-reliability-cost.md` graft 2); 2 s is both runners' default. Timed-out cases are
 * excluded from the p50 because they say nothing about how long a case takes, only that the
 * buggy program hangs on it (bitcount 9/9, sqrt 6/7: the old `duration / total` read them as a
 * 2 s p50 and kept the 2 s timeout).
 */
export const PER_TEST_TIMEOUT_FACTOR = 3;
export const PER_TEST_TIMEOUT_MIN_MS = 500;
export const PER_TEST_TIMEOUT_MAX_MS = 2000;
/** The per-case limit both runners apply when nothing else is said (run_tests.py --timeout 2; CASE_TIMEOUT_S = 2). */
export const DEFAULT_CASE_TIMEOUT_MS = 2000;
/**
 * Process start of one test run (`python3 -m pytest -q` on a 6-case generated module: 206 ms
 * wall on the reference machine, shunting_yard; run_tests.py's parent + one child ≈ the same).
 * Subtracted from the baseline before the finished cases' time is spread over them, and the
 * start-up a lane run is charged in the estimate. Not the baseline's own start-up: that one is
 * measured at the run's busiest moment (the engine, its Jev calls and the bench's sibling tasks
 * all start together) and read 865–1050 ms on every program of the second live bench while the
 * lanes' whole runs then measured 380–800 ms; pytest's session clock (`pytestSessionMs`) puts it
 * outside the suite's time, and every lane batch re-measures it (`refineTRun`).
 */
export const PROCESS_OVERHEAD_MS = 200;
/**
 * Inside a pytest session, what is neither a case nor a hung case's alarm: collection and the
 * reporting of the results (on idle cores: sqrt 50 ms with 6 failures, bitcount 60 ms with 9,
 * shunting_yard 20 ms with 4). Under load it grows with the failures reported, which is why the
 * rest of the session is spread over the finished cases as an upper bound on their p50.
 */
export const SESSION_OVERHEAD_MS = 50;
/** run_tests.py runs the JSON cases in parallel, `--jobs` = min(8, cpus): hanging cases cost rounds of 8, not a sum. */
export const RUN_TESTS_JOBS = 8;
/**
 * Stop rule the lanes set on the generated pytest module (JEVCODE_MAX_CASE_TIMEOUTS): after one
 * case timeout the remaining cases are reported "not run". A hanging candidate then costs one
 * per-test timeout plus process start (bitcount: 661 ms measured, against 9 × 2 s = 18 s
 * before), which is what lets the whole first-order set run (§2.4). See
 * src/bench/quixbugs/pytest.ts for what the rule gives up.
 */
export const LANE_MAX_CASE_TIMEOUTS = 1;
/**
 * §2.4 under CPU load: a measured batch median up to this multiple of SIEVE_MAX_T_RUN_MS does
 * not move a sieve-eligible t_run. The first live bench ran 4 programs × 8 lanes on 15 cores:
 * shunting_yard's 0.58 s suite measured 0.65 s per run in most batches and above 2 s in the
 * batches whose candidates all raised (long tracebacks), which flipped it to RANK and, at the
 * next step's `freshBudget`, to repository-class caps (16 runs per step).
 */
export const SIEVE_KEEP_FACTOR = 1.5;

/** §4.1: runTimeoutMs = min(limits.commandTimeoutMs, 3 × baselineDuration + 10 s, wallRemaining). */
export const RUN_TIMEOUT_FACTOR = 3;
export const RUN_TIMEOUT_SLACK_MS = 10_000;
/** The sandbox rejects a non-positive timeout; a run shorter than this cannot report anything useful. */
export const MIN_RUN_TIMEOUT_MS = 1000;

/** §4.3 QuixBugs-class caps: testWall ≤ min(90 s, wallRemaining / 4), testRuns ≤ 1,500, jevRequests ≤ 30. */
export const QUIXBUGS_TEST_WALL_MAX_MS = 90_000;
export const QUIXBUGS_TEST_WALL_FRACTION = 4;
export const QUIXBUGS_TEST_RUNS_MAX = 1500;
export const QUIXBUGS_JEV_REQUESTS_MAX = 30;

/**
 * §4.3 repository-class caps: testWall ≤ min(8 × baselineDuration, 600 s), testRuns ≤ 16
 * (12 subset + 3 full + 1 baseline), jevRequests ≤ 60 (SWE chunked ranking ≈ 11 chunks × ≤ 5 anchors).
 */
export const REPO_TEST_WALL_BASELINE_FACTOR = 8;
export const REPO_TEST_WALL_MAX_MS = 600_000;
export const REPO_TEST_RUNS_MAX = 16;
export const REPO_JEV_REQUESTS_MAX = 60;

/** §2.4: K = 3 at replace sites (Noul top-3 36–40/40, `probe-selection.md`). */
export const RANK_K_REPLACE = 3;
/** §2.4: K = 5 at insert sites (gold statements at Noul 0.33–0.39, `probe-selection.md`). */
export const RANK_K_INSERT = 5;
/** §2.4: above 60 candidates the ranker uses compact Nouls (top-3 36/40 at N = 254); top-5 recovers ≈ 2 more. */
export const COMPACT_NOUL_MIN_CANDIDATES = 61;
export const RANK_K_COMPACT = 5;

// ---------------------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------------------

export type OracleClass = 'quixbugs_class' | 'repository_class';

/** The parts of a `run_tests.py <name> <candidatePath>` command the runner needs to rebuild it per lane. */
export interface QuixbugsCommand {
  /** directory holding run_tests.py (bench/data/quixbugs or a copy) */
  dir: string;
  name: string;
  /** the program path as given on the baseline command (workspace-relative or absolute) */
  candidatePath: string;
}

/**
 * Split a shell command into words the way `sh` would for the quoting our own builders use
 * (single quotes, double quotes, backslash escapes); enough to read back `quixbugsTestCommand()`
 * and a pytest invocation. Environment assignments (`X=1`) stay as words.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? '';
    if (ch === "'") {
      inWord = true;
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end === -1 ? command.length : end);
      i = end === -1 ? command.length : end + 1;
    } else if (ch === '"') {
      inWord = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) i += 1;
        cur += command[i] ?? '';
        i += 1;
      }
      i += 1;
    } else if (ch === '\\' && i + 1 < command.length) {
      inWord = true;
      cur += command[i + 1] ?? '';
      i += 2;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      i += 1;
    } else {
      inWord = true;
      cur += ch;
      i += 1;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** `run_tests.py <name> <candidatePath>` read back from a command; null when the command is not the QuixBugs runner. */
export function parseQuixbugsCommand(command: string): QuixbugsCommand | null {
  const words = shellWords(command);
  const at = words.findIndex((w) => /(^|\/)run_tests\.py$/.test(w));
  if (at === -1) return null;
  const script = words[at] ?? '';
  const name = words[at + 1];
  const candidatePath = words[at + 2];
  if (name === undefined || candidatePath === undefined || name.startsWith('-') || candidatePath.startsWith('-')) return null;
  const slash = script.lastIndexOf('/');
  return { dir: slash === -1 ? '.' : script.slice(0, slash), name, candidatePath };
}

/** Which runner a test command is: the QuixBugs JSON runner, pytest (bare or `python -m pytest`), or something else. */
export function detectRunner(command: string): OracleModel['runner'] {
  if (parseQuixbugsCommand(command) !== null) return 'quixbugs';
  const words = shellWords(command);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    if (/(^|\/)pytest$/.test(w) || /(^|\/)py\.test$/.test(w)) return 'pytest';
    if (w === '-m' && words[i + 1] === 'pytest') return 'pytest';
  }
  return 'other';
}

// ---------------------------------------------------------------------------------------
// Oracle model
// ---------------------------------------------------------------------------------------

export interface FitOracleOptions {
  /** ctx.limits.commandTimeoutMs */
  commandTimeoutMs: number;
  /** wall time the run has left (ctx.limits.maxWallMs minus elapsed) */
  wallRemainingMs: number;
  workspace: {
    git: boolean;
    /** total size when known (bytes); unknown counts as small */
    sizeBytes?: number;
  };
  /**
   * measured per-test median (ms) of the cases that finished, when the caller has it (pytest
   * `--durations`); otherwise `caseProfile` spreads the baseline's time outside its timed-out
   * cases and process start over the finished cases (an upper bound on the p50; the clamp keeps
   * it honest)
   */
  perTestP50Ms?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Per-case timing of a baseline, read from its counts and failure texts (§4.1). The timed-out
 * cases are known from the runner's own text ("TIMEOUT after 2s", "CaseTimeout: no result after
 * 2s"); the rest of the baseline's duration is the finished cases plus process start.
 */
export interface CaseProfile {
  /** cases that ran: passed + failed + errors (skipped cases never ran) */
  ran: number;
  /** cases that hit the per-case limit */
  timeouts: number;
  /** cases the stop rule reported "not run" (none in a baseline; lane runs only) */
  notRun: number;
  /** cases that finished, whatever their verdict */
  finished: number;
  /** the per-case limit the timed-out cases ran under (ms); the runners' 2 s default when unknown */
  caseLimitMs: number;
  /** pytest's own session time ("… in 12.33s"), which excludes the interpreter's start-up; null when the output has none */
  sessionMs: number | null;
  /** the baseline's start-up as measured: duration − session; null without a session clock */
  startupMs: number | null;
  /**
   * fixed cost inside the measured span, at most the time left outside the timed-out cases:
   * collection and reporting (SESSION_OVERHEAD_MS) when the span is the session, process start
   * too (PROCESS_OVERHEAD_MS) when it is the whole run
   */
  overheadMs: number;
  /** the span minus timeouts × limit minus the fixed cost, ≥ 0: the finished cases' work (and, under load, the reporting of the failures) */
  finishedTotalMs: number;
  /** mean time of a finished case (an upper bound on the p50); null when no case finished */
  finishedP50Ms: number | null;
}

/**
 * pytest's session time from its counts line ("6 failed, 1 passed in 12.33s"; the last such line
 * of the output tail), in ms; null when the output is not pytest's or has no counts line. The
 * session starts after the interpreter and pytest itself have loaded, so what it measures is the
 * suite: collection, the cases, the reports.
 */
const PYTEST_COUNTS_LINE = /(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)\b[^\n]*?|no tests ran) in (\d+(?:\.\d+)?)s\b/g;
export function pytestSessionMs(outputTail: string): number | null {
  let last: string | null = null;
  for (const m of outputTail.matchAll(PYTEST_COUNTS_LINE)) last = m[1] ?? null;
  if (last === null) return null;
  const sec = Number(last);
  return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null;
}

export function caseProfile(baseline: Pick<TestRunSummary, 'passed' | 'failed' | 'errors' | 'failures' | 'durationMs'> & Partial<Pick<TestRunSummary, 'outputTail'>>): CaseProfile {
  const counts = countCaseTimeouts(baseline);
  const ran = Math.max(0, baseline.passed + baseline.failed + baseline.errors);
  const timeouts = Math.min(ran, counts.timeouts);
  const notRun = Math.min(ran - timeouts, counts.notRun);
  const finished = Math.max(0, ran - timeouts - notRun);
  const caseLimitMs = counts.limitMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const duration = Math.max(0, Math.floor(baseline.durationMs));
  const session = pytestSessionMs(baseline.outputTail ?? '');
  const sessionMs = session !== null && session <= duration ? session : null;
  const startupMs = sessionMs === null ? null : duration - sessionMs;
  const span = sessionMs ?? duration;
  const restMs = Math.max(0, span - timeouts * caseLimitMs);
  const overheadMs = Math.min(restMs, sessionMs === null ? PROCESS_OVERHEAD_MS : SESSION_OVERHEAD_MS);
  const finishedTotalMs = Math.max(0, restMs - overheadMs);
  return { ran, timeouts, notRun, finished, caseLimitMs, sessionMs, startupMs, overheadMs, finishedTotalMs, finishedP50Ms: finished > 0 ? finishedTotalMs / finished : null };
}

/**
 * §4.1 per-test timeout for the runners with a per-case knob (run_tests.py, the generated pytest
 * module); null for `other` (nothing to pass it to). `finishedP50Ms` null or 0 (no case
 * finished: every case hung) gives the 0.5 s floor.
 */
export function perTestTimeout(runner: OracleModel['runner'], finishedP50Ms: number | null): number | null {
  if (runner === 'other') return null;
  const p50 = finishedP50Ms !== null && Number.isFinite(finishedP50Ms) && finishedP50Ms > 0 ? finishedP50Ms : 0;
  return Math.round(clamp(PER_TEST_TIMEOUT_FACTOR * p50, PER_TEST_TIMEOUT_MIN_MS, PER_TEST_TIMEOUT_MAX_MS));
}

/**
 * The adjusted t_run (§2.4, §4.1): what one lane run of a candidate that behaves like the
 * baseline costs *under the lane settings* — process start, plus Σ over the cases that will run
 * of min(observed case time, per-test timeout), plus collection and reporting. On the generated
 * pytest module the cases are sequential and the stop rule ends the run after
 * LANE_MAX_CASE_TIMEOUTS timeouts; run_tests.py runs its cases in rounds of RUN_TESTS_JOBS. With
 * pytest's session clock the start-up charged is PROCESS_OVERHEAD_MS, not the baseline's own
 * (see that constant); without it, a baseline without case timeouts is its own estimate (the raw
 * duration: the ladder's pytest modules under `-qq`, `other` runners).
 */
export function estimateRunMs(runner: OracleModel['runner'], profile: CaseProfile, perTestTimeoutMs: number | null, baselineDurationMs: number): number {
  const raw = Math.max(0, Math.floor(baselineDurationMs));
  if (runner === 'other') return raw;
  const perHang = perTestTimeoutMs === null ? profile.caseLimitMs : Math.min(profile.caseLimitMs, perTestTimeoutMs);
  const hangs = runner === 'pytest' ? Math.min(profile.timeouts, LANE_MAX_CASE_TIMEOUTS) : Math.ceil(profile.timeouts / RUN_TESTS_JOBS);
  if (runner === 'pytest' && profile.sessionMs !== null) return Math.round(PROCESS_OVERHEAD_MS + profile.overheadMs + profile.finishedTotalMs + hangs * perHang);
  if (perTestTimeoutMs === null || profile.timeouts === 0) return raw;
  return Math.round(profile.overheadMs + profile.finishedTotalMs + hangs * perHang);
}

/**
 * §4.1 lane count re-read from a refined t_run: a suite whose lane runs measure under 1 s is a
 * fast suite and gets the fast suite's 8 lanes, whatever the baseline's start-up burst said
 * (the second live bench fitted 4 lanes to every program from 1.2–19 s baselines and then
 * measured 380–800 ms runs on them). Only ever wider: the pool is rebuilt when it grows, and a
 * loaded batch is no reason to shrink it. `inplace` lanes (a large non-git workspace) stay one.
 */
export function refineLanes(oracle: Pick<OracleModel, 'lanes' | 'tRunMs'>, laneMode: 'candidate_file' | 'worktree' | 'copy' | 'inplace'): number {
  if (laneMode === 'inplace') return oracle.lanes;
  if (oracle.tRunMs.goalSubset < FAST_SUITE_T_RUN_MS) return Math.max(oracle.lanes, LANES_FAST_SUITE);
  return oracle.lanes;
}

/** §4.1 run timeout: min(commandTimeoutMs, 3 × baselineDuration + 10 s, wallRemaining), never below MIN_RUN_TIMEOUT_MS. */
export function runTimeout(baselineDurationMs: number, opts: Pick<FitOracleOptions, 'commandTimeoutMs' | 'wallRemainingMs'>): number {
  const byBaseline = RUN_TIMEOUT_FACTOR * Math.max(0, baselineDurationMs) + RUN_TIMEOUT_SLACK_MS;
  const t = Math.min(opts.commandTimeoutMs, byBaseline, opts.wallRemainingMs);
  return Math.max(MIN_RUN_TIMEOUT_MS, Math.floor(t));
}

/**
 * The sandbox timeout of one *lane* run: the oracle's `runTimeoutMs` (sized for the workspace
 * command, which runs at the module's 2 s default: the engine's own `run` proposals) tightened
 * to what the lane settings allow — 3 × the adjusted t_run + 10 s, or every case that ran
 * hitting the per-test timeout plus process start and 10 s, whichever is larger (the per-case
 * alarm bounds each case; only a candidate that never returns to the interpreter — a C-level
 * loop — can outlive it, and that is what this timeout is for). A lane run that hits it is a
 * `timeout` outcome; before this the lanes shared the 66 s workspace timeout on bitcount.
 */
export function laneRunTimeout(oracle: Pick<OracleModel, 'runTimeoutMs' | 'tRunMs' | 'perTestTimeoutMs' | 'runner'>, baseline: Pick<TestRunSummary, 'passed' | 'failed' | 'errors' | 'failures' | 'durationMs'> | null): number {
  const byTRun = RUN_TIMEOUT_FACTOR * Math.max(0, oracle.tRunMs.goalSubset) + RUN_TIMEOUT_SLACK_MS;
  let byCases = 0;
  if (baseline !== null && oracle.perTestTimeoutMs !== null && oracle.runner !== 'other') {
    const profile = caseProfile(baseline);
    byCases = profile.overheadMs + profile.ran * oracle.perTestTimeoutMs + RUN_TIMEOUT_SLACK_MS;
  }
  const t = Math.min(oracle.runTimeoutMs, Math.max(byTRun, byCases));
  return Math.max(MIN_RUN_TIMEOUT_MS, Math.floor(t));
}

/** §4.1 lane count: 8 when a run is under 1 s, 2 on a large non-git workspace, 4 otherwise. */
export function laneCount(tRunMs: number, workspace: FitOracleOptions['workspace']): number {
  const large = !workspace.git && (workspace.sizeBytes ?? 0) > LARGE_WORKSPACE_BYTES;
  if (large) return LANES_LARGE_NON_GIT;
  if (tRunMs < FAST_SUITE_T_RUN_MS) return LANES_FAST_SUITE;
  return LANES_PYTEST;
}

/**
 * The SynthesisContext shape `fitOracle` also accepts: the command timeout and the workspace
 * flag come from the context; the wall remaining is unknown there and is taken as the run's
 * whole wall limit (an upper bound; `freshBudget` applies the step's real remaining wall).
 */
export interface FitOracleContext {
  limits: Pick<RunLimits, 'commandTimeoutMs' | 'maxWallMs'>;
  workspaceInfo: { git: boolean };
}

function toFitOptions(o: FitOracleOptions | FitOracleContext): FitOracleOptions {
  if ('limits' in o) return { commandTimeoutMs: o.limits.commandTimeoutMs, wallRemainingMs: o.limits.maxWallMs, workspace: { git: o.workspaceInfo.git } };
  return o;
}

/**
 * Fit the oracle model to the baseline run (§4.1). `tRunMs` (both scopes) is the adjusted
 * estimate of one lane run (`estimateRunMs`), which the class (§4.3), the lane count and the
 * §2.4 run plan read; `baselineDurationMs` keeps the raw duration for reporting and for the
 * repository-class wall (8 × baseline); `runTimeoutMs` bounds the workspace command, which
 * still runs at the module's 2 s default. The runner refines `tRunMs.goalSubset` from the
 * subset runs it measures (`refineTRun`). A timed-out baseline still yields a model (the caller
 * parks the goals, §4.1).
 */
export function fitOracle(baseline: TestRunSummary, options: FitOracleOptions | FitOracleContext): OracleModel {
  const opts = toFitOptions(options);
  const runner = detectRunner(baseline.command);
  const baselineDurationMs = Math.max(0, Math.floor(baseline.durationMs));
  const profile = caseProfile(baseline);
  const perTestTimeoutMs = perTestTimeout(runner, opts.perTestP50Ms ?? profile.finishedP50Ms);
  const tRun = estimateRunMs(runner, profile, perTestTimeoutMs, baselineDurationMs);
  return {
    runner,
    lanes: laneCount(tRun, opts.workspace),
    tRunMs: { goalSubset: tRun, fullSuite: tRun },
    perTestTimeoutMs,
    runTimeoutMs: runTimeout(baselineDurationMs, opts),
    baselineDurationMs,
  };
}

/**
 * The runner's refinement of t_run from a batch's measured median (§4.1 "measured on the
 * goal-subset command"), with the §2.4 hysteresis under CPU load: a median that keeps the suite
 * QuixBugs-class is taken as is (cheaper or dearer than estimated, it is the better number); a
 * median above the class line but within SIEVE_KEEP_FACTOR × SIEVE_MAX_T_RUN_MS does not move a
 * sieve-eligible estimate (the lanes are loaded, not the suite slow; the wall is charged from
 * real elapsed time, so nothing overruns); anything above that is the truth and flips to RANK.
 */
export function refineTRun(previousMs: number, measuredMs: number): number {
  if (!Number.isFinite(measuredMs) || measuredMs <= 0) return previousMs;
  const measured = Math.round(measuredMs);
  if (measured < QUIXBUGS_CLASS_MAX_T_RUN_MS) return measured;
  if (previousMs <= SIEVE_MAX_T_RUN_MS && measured <= SIEVE_MAX_T_RUN_MS * SIEVE_KEEP_FACTOR) return previousMs;
  return measured;
}

/** §4.3 class of a suite: the goal-subset run under 2 s is QuixBugs-class, anything slower repository-class. */
export function oracleClass(oracle: OracleModel): OracleClass {
  return oracle.tRunMs.goalSubset < QUIXBUGS_CLASS_MAX_T_RUN_MS ? 'quixbugs_class' : 'repository_class';
}

// ---------------------------------------------------------------------------------------
// Step budget
// ---------------------------------------------------------------------------------------

export interface FreshBudgetOptions {
  /** injectable clock for tests */
  now?: () => number;
}

/**
 * A fresh StepBudget (§4.3) for one synthesize() call. `exhausted()` is true once one of the
 * three counters is spent: the search returns `budget` and the step becomes a cheap
 * goal-subset `run` (§2.2), so a step never overruns its caps by more than one in-flight run.
 */
export function freshBudget(limits: Pick<RunLimits, 'maxWallMs'>, oracle: OracleModel, wallRemainingMs: number, opts: FreshBudgetOptions = {}): StepBudget {
  // a remaining wall above the run's whole limit (or not finite) is unknown: the limit is the bound then
  const wallRemaining = Number.isFinite(wallRemainingMs) ? Math.max(0, Math.min(wallRemainingMs, limits.maxWallMs)) : limits.maxWallMs;
  const cls = oracleClass(oracle);
  const testWallLeftMs =
    cls === 'quixbugs_class'
      ? Math.floor(Math.min(QUIXBUGS_TEST_WALL_MAX_MS, wallRemaining / QUIXBUGS_TEST_WALL_FRACTION))
      : Math.floor(Math.min(REPO_TEST_WALL_BASELINE_FACTOR * oracle.baselineDurationMs, REPO_TEST_WALL_MAX_MS, wallRemaining));
  const budget: StepBudget = {
    jevRequestsLeft: cls === 'quixbugs_class' ? QUIXBUGS_JEV_REQUESTS_MAX : REPO_JEV_REQUESTS_MAX,
    testRunsLeft: cls === 'quixbugs_class' ? QUIXBUGS_TEST_RUNS_MAX : REPO_TEST_RUNS_MAX,
    testWallLeftMs,
    startedMs: (opts.now ?? Date.now)(),
    recursed: false,
    exhausted: () => budget.testRunsLeft <= 0 || budget.testWallLeftMs <= 0 || budget.jevRequestsLeft <= 0,
  };
  return budget;
}

/** Runs the step can still afford: the count cap, or the wall cap spread over the lanes (§2.4 `runsLeft`). */
export function runsLeft(oracle: OracleModel, budget: StepBudget): number {
  const tRun = Math.max(1, oracle.tRunMs.goalSubset);
  const byWall = Math.floor((Math.max(0, budget.testWallLeftMs) * Math.max(1, oracle.lanes)) / tRun);
  return Math.max(0, Math.min(budget.testRunsLeft, byWall));
}

/**
 * §2.4, the central decision: SIEVE when the whole candidate set fits the run budget and a run
 * is cheap (tests rank, no Jev request); otherwise RANK with K = 3 at replace sites, 5 at insert
 * sites, and 5 whenever the set is large enough for compact Nouls. The cut is a budget, never a
 * probability threshold: a confident wrong rank costs a step, not the fix.
 */
export function decideRunPlan(cands: readonly Candidate[] | number, site: Pick<Site, 'kind'>, oracle: OracleModel, budget: StepBudget): RunPlan {
  const n = typeof cands === 'number' ? cands : cands.length;
  const left = runsLeft(oracle, budget);
  if (n <= left && oracle.tRunMs.goalSubset <= SIEVE_MAX_T_RUN_MS) return { mode: 'SIEVE', k: n, runsAllowed: n };
  let k = site.kind === 'insert' ? RANK_K_INSERT : RANK_K_REPLACE;
  if (n >= COMPACT_NOUL_MIN_CANDIDATES) k = Math.max(k, RANK_K_COMPACT);
  k = Math.min(k, left);
  return { mode: 'RANK', k, runsAllowed: k };
}
