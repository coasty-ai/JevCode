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
import { countCaseTimeouts, isCaseNotRun, isCaseTimeout } from '../verify/quixbugs.js';
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
 * generated pytest module through JEVCODE_CASE_TIMEOUT_MS): clamp(3 × the *tail* of the
 * baseline's finished-case times, 0.5 s, 2 s); 0.5 s when no case finished (every case hung).
 * The tail, not the mean: per-case times are skewed — `longest_common_subsequence`'s slowest
 * case is ~40× its mean (184 ms against ≤ 14 ms for the other nine, idle; 330 ms under a load
 * average of 45), so 3 × mean (≈ 60 ms) fell to the 0.5 s floor and the floor became the cap,
 * and under the bench's 4–9× CPU contention the gold's slow case crossed it and was classified
 * `timeout` (experiments/results/jev-only-quixbugs-3-inspection.md §2). With ≤ CASE_TAIL_MAX_CASES
 * finished cases the tail is their maximum (every case must fit, and 20 samples give no
 * percentile worth the name); above it the p95, so one pathological case of a large suite does
 * not set the cap for all. Without per-case times (pytest without `--durations`, run_tests.py's
 * JSON) the tail is bounded by the finished cases' total — every finished millisecond could be
 * one case — which is honest about what is known and costs only hanging candidates (they pay
 * the cap once, under the stop rule). The 0.5 s floor rejected no gold fix on 35/35 enumerated
 * replacements while cutting the timeout-dominated programs (`sqrt` 47.6 s → 31.9 s;
 * `contrarian-exhaustive.all.jsonl`, `judge2-reliability-cost.md` graft 2); 2 s is both
 * runners' default. Timed-out cases never vote: they say nothing about how long a case takes,
 * only that the buggy program hangs on it (bitcount 9/9, sqrt 6/7: the old `duration / total`
 * read them as a 2 s p50 and kept the 2 s timeout).
 */
export const PER_TEST_TIMEOUT_FACTOR = 3;
export const PER_TEST_TIMEOUT_MIN_MS = 500;
export const PER_TEST_TIMEOUT_MAX_MS = 2000;
/** Up to this many finished cases the tail is the maximum; above it the CASE_TAIL_PERCENTILE quantile (nearest rank). */
export const CASE_TAIL_MAX_CASES = 20;
export const CASE_TAIL_PERCENTILE = 0.95;
/**
 * Load awareness on the lanes (sieve/runner.ts): once a batch has LOAD_SAMPLE_MIN_RUNS measured
 * runs and their median exceeds LOAD_SCALE_MIN_RATIO × the oracle's t_run estimate, the per-case
 * timeout of the rest of the batch is scaled by the observed ratio (bounded by
 * PER_TEST_TIMEOUT_MAX_MS). The QuixBugs run-3 bench ran 14 tasks × up to 8 lanes on 15 cores:
 * lane batch medians were 4–9× the idle run time, which is exactly the factor a per-case cap
 * fitted idle lacks. Four runs is the smallest sample whose median is not one outlier.
 */
export const LOAD_SCALE_MIN_RATIO = 2;
export const LOAD_SAMPLE_MIN_RUNS = 4;
/**
 * Provisional `timeout` verdicts (sieve/runner.ts `timeoutKind`): a candidate whose run stopped
 * on the alarm while no case had failed with a value might be slow rather than hanging; it is
 * re-run at the end of the batch with the runners' full 2 s cap (the stop rule kept: one alarm
 * decides) before it is classified, at most RETRY_TIMEOUTS_MAX_PER_BATCH per batch (the rest
 * wait for the next call for the goal). A genuine hang that reaches the retry costs one 2 s
 * alarm plus start-up; the two immediate rules (the buggy program hangs on the same case and
 * nothing passed, or the cap was already 2 s; the alarm fired on the first case and the
 * baseline finished it quickly) classify the bulk of them without a retry.
 */
export const RETRY_TIMEOUTS_MAX_PER_BATCH = 16;
export const RETRY_CASE_TIMEOUT_MS = PER_TEST_TIMEOUT_MAX_MS;
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
   * measured times (ms) of the cases that finished, when the caller has them (pytest
   * `--durations`, its own instrumentation); otherwise `caseProfile` reads pytest's durations
   * table from the output tail when the run printed one, and without that bounds the tail by
   * the finished cases' share of the baseline (the clamp keeps it honest)
   */
  caseDurationsMs?: readonly number[];
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
  /** mean time of a finished case (skew-blind: LCS's slowest case is ~40× it); null when no case finished */
  finishedMeanMs: number | null;
  /**
   * per-case times of the finished cases when the output carries pytest's `--durations` table
   * (the `call` phase; entries under 5 ms are hidden without -vv, which cannot move a maximum);
   * timed-out and not-run cases excluded; null when the output has no table
   */
  caseDurations: CaseDuration[] | null;
  /**
   * the tail of the finished cases' times the per-test timeout is fitted to (`caseTail`): the
   * maximum (≤ CASE_TAIL_MAX_CASES cases) or p95 of `caseDurations` when known, else the
   * finished cases' total (the bound: it could all be one case); null when no case finished
   */
  tailMs: number | null;
}

/** One line of pytest's `--durations` table: `0.18s call  tests/test_x.py::test_x[3-...]`. */
export interface CaseDuration {
  testId: string;
  ms: number;
}

const PYTEST_DURATION_LINE = /^\s*(\d+(?:\.\d+)?)s\s+(call|setup|teardown)\s+(\S.*?)\s*$/gm;

/**
 * pytest's `--durations=N` table read from an output tail (`-q` prints it too): the `call`
 * phase of every listed test, in the table's (descending) order. Empty when the output has no
 * table. Under `-q` entries below 5 ms are replaced by "(N durations < 0.005s hidden)", so the
 * list may be shorter than the suite; a maximum is unaffected, a p95 over a large suite is not.
 */
export function pytestCaseDurations(outputTail: string): CaseDuration[] {
  const out: CaseDuration[] = [];
  for (const m of outputTail.matchAll(PYTEST_DURATION_LINE)) {
    if (m[2] !== 'call') continue;
    const sec = Number(m[1]);
    const testId = (m[3] ?? '').trim();
    if (!Number.isFinite(sec) || sec < 0 || testId === '') continue;
    out.push({ testId, ms: Math.round(sec * 1000) });
  }
  return out;
}

/**
 * The tail of a per-case time distribution the per-test timeout is fitted to: the maximum when
 * there are at most CASE_TAIL_MAX_CASES samples, else the CASE_TAIL_PERCENTILE quantile by
 * nearest rank (so 21+ samples let one pathological case go unprotected rather than set the cap
 * for all). Non-finite and negative samples are ignored; null when nothing is left.
 */
export function caseTail(durationsMs: readonly number[]): number | null {
  const xs = durationsMs.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length <= CASE_TAIL_MAX_CASES) return xs[xs.length - 1] ?? null;
  const rank = Math.min(xs.length, Math.max(1, Math.ceil(CASE_TAIL_PERCENTILE * xs.length)));
  return xs[rank - 1] ?? null;
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
  // per-case times when the output has pytest's durations table; the cases that hit the alarm or were not run do not vote
  const unfinished = new Set<string>();
  for (const f of baseline.failures) if (isCaseTimeout(f.actual) || isCaseNotRun(f.actual)) unfinished.add(f.testId);
  const table = pytestCaseDurations(baseline.outputTail ?? '').filter((d) => !unfinished.has(d.testId));
  const caseDurations = table.length > 0 ? table : null;
  const tailMs = caseDurations !== null ? caseTail(caseDurations.map((d) => d.ms)) : finished > 0 ? finishedTotalMs : null;
  return { ran, timeouts, notRun, finished, caseLimitMs, sessionMs, startupMs, overheadMs, finishedTotalMs, finishedMeanMs: finished > 0 ? finishedTotalMs / finished : null, caseDurations, tailMs };
}

/**
 * §4.1 per-test timeout for the runners with a per-case knob (run_tests.py, the generated pytest
 * module); null for `other` (nothing to pass it to). `tailMs` is the tail of the finished cases'
 * times (`CaseProfile.tailMs`, `caseTail`); null or 0 (no case finished: every case hung) gives
 * the 0.5 s floor.
 */
export function perTestTimeout(runner: OracleModel['runner'], tailMs: number | null): number | null {
  if (runner === 'other') return null;
  const tail = tailMs !== null && Number.isFinite(tailMs) && tailMs > 0 ? tailMs : 0;
  return Math.round(clamp(PER_TEST_TIMEOUT_FACTOR * tail, PER_TEST_TIMEOUT_MIN_MS, PER_TEST_TIMEOUT_MAX_MS));
}

/**
 * The load a batch runs under, read from its measured run median against the oracle's t_run
 * estimate (§2.4's "measured on the goal-subset command"): 1 when nothing was measured or the
 * lanes are no slower than estimated. Never below 1: a batch faster than estimated is a better
 * t_run (`refineTRun`), not a reason to tighten a per-case cap fitted to the baseline.
 */
export function loadRatio(medianMs: number | null, estimateMs: number): number {
  if (medianMs === null || !Number.isFinite(medianMs) || medianMs <= 0) return 1;
  const est = Math.max(1, Number.isFinite(estimateMs) ? estimateMs : 1);
  return Math.max(1, medianMs / est);
}

/**
 * The per-case timeout for the rest of a loaded batch: the oracle's cap scaled by the observed
 * load once it exceeds LOAD_SCALE_MIN_RATIO, bounded by PER_TEST_TIMEOUT_MAX_MS (the runners'
 * default, the cap the retry runs at); the oracle's cap unchanged below the threshold.
 */
export function scaledCaseTimeout(baseMs: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < LOAD_SCALE_MIN_RATIO) return baseMs;
  return Math.round(clamp(baseMs * ratio, baseMs, PER_TEST_TIMEOUT_MAX_MS));
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
  const perTestTimeoutMs = perTestTimeout(runner, opts.caseDurationsMs !== undefined ? caseTail(opts.caseDurationsMs) : profile.tailMs);
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
