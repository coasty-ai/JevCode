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
 * Adaptive per-test timeout for the QuixBugs runner: clamp(3 × baseline per-test p50, 0.5 s, 2 s).
 * The 0.5 s floor rejected no gold fix on 35/35 enumerated replacements while cutting the
 * timeout-dominated programs (`sqrt` 47.6 s → 31.9 s; `contrarian-exhaustive.all.jsonl`,
 * `judge2-reliability-cost.md` graft 2); 2 s is the runner's default (`run_tests.py --timeout`).
 */
export const PER_TEST_TIMEOUT_FACTOR = 3;
export const PER_TEST_TIMEOUT_MIN_MS = 500;
export const PER_TEST_TIMEOUT_MAX_MS = 2000;

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
   * measured per-test median (ms) for the QuixBugs runner when the caller has it; otherwise the
   * baseline's duration / total is used (the runner runs cases in parallel, so this is an
   * upper bound on the p50 and the clamp keeps it honest)
   */
  perTestP50Ms?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** §4.1 per-test timeout for the QuixBugs runner; null for other runners (they have no per-test knob). */
export function perTestTimeout(runner: OracleModel['runner'], perTestP50Ms: number): number | null {
  if (runner !== 'quixbugs') return null;
  const p50 = Number.isFinite(perTestP50Ms) && perTestP50Ms > 0 ? perTestP50Ms : 0;
  return Math.round(clamp(PER_TEST_TIMEOUT_FACTOR * p50, PER_TEST_TIMEOUT_MIN_MS, PER_TEST_TIMEOUT_MAX_MS));
}

/** §4.1 run timeout: min(commandTimeoutMs, 3 × baselineDuration + 10 s, wallRemaining), never below MIN_RUN_TIMEOUT_MS. */
export function runTimeout(baselineDurationMs: number, opts: Pick<FitOracleOptions, 'commandTimeoutMs' | 'wallRemainingMs'>): number {
  const byBaseline = RUN_TIMEOUT_FACTOR * Math.max(0, baselineDurationMs) + RUN_TIMEOUT_SLACK_MS;
  const t = Math.min(opts.commandTimeoutMs, byBaseline, opts.wallRemainingMs);
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
 * Fit the oracle model to the baseline run (§4.1). `tRunMs.goalSubset` starts equal to the
 * full-suite duration (the only measurement so far); the runner refines it from the subset
 * runs it makes. A timed-out baseline still yields a model (the caller parks the goals, §4.1).
 */
export function fitOracle(baseline: TestRunSummary, options: FitOracleOptions | FitOracleContext): OracleModel {
  const opts = toFitOptions(options);
  const runner = detectRunner(baseline.command);
  const baselineDurationMs = Math.max(0, Math.floor(baseline.durationMs));
  const perTestP50Ms = opts.perTestP50Ms ?? (baseline.total > 0 ? baselineDurationMs / baseline.total : baselineDurationMs);
  return {
    runner,
    lanes: laneCount(baselineDurationMs, opts.workspace),
    tRunMs: { goalSubset: baselineDurationMs, fullSuite: baselineDurationMs },
    perTestTimeoutMs: perTestTimeout(runner, perTestP50Ms),
    runTimeoutMs: runTimeout(baselineDurationMs, opts),
    baselineDurationMs,
  };
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
