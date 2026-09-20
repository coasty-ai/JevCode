/**
 * Parallel batch verification on the shadow lanes (docs/JEV-ONLY-DESIGN.md §4, §4.3). `runQueue`
 * pops VerifyJobs, applies each to a free lane, runs the goal-subset command, and runs the full
 * suite only for subset passers (≤ 5 per step), classifying every candidate in code:
 *
 *   plausible   passes every goal test and the full-suite run shows no newly failing test
 *   partial     newly passing tests, nothing newly failing, goal not fully fixed (held, never committed here)
 *   regressed   a newly failing test or fewer passed (REGRESSION_RULE; nothing was written to the workspace)
 *   unchanged   no newly passing test
 *   timeout     the run was killed on its timeout, or every failing case hit the per-case timeout
 *               (a probable infinite loop; counts as a regression for routing, never held as a base)
 *   apply_failed the site is stale or the lane could not take the edit
 *
 * The step's StepBudget is honoured (runs and wall), `ctx.signal` stops dispatching (in-flight
 * runs are bounded by their own timeout and killed by the sandbox), and up to `oracle.lanes`
 * runs overlap. Every lane run carries the oracle's adaptive per-test timeout (§4.1): as
 * `--timeout` on the QuixBugs runner's command, as JEVCODE_CASE_TIMEOUT_MS (with the
 * stop-after-one-timeout rule, JEVCODE_MAX_CASE_TIMEOUTS=1) in the environment of a pytest run,
 * which the bench's generated modules read; the sandbox timeout of a lane run is
 * `laneRunTimeout` (budget.ts), never the 120 s command default. After each batch the oracle
 * learns the measured run median (`refineTRun`, with the §2.4 hysteresis under load) and, once a
 * run measures under 1 s, the fast suite's lane count (`refineLanes`; the pool is widened at the
 * next call). A job whose run was aborted, killed on a timeout the step's remaining wall had
 * cut short, or deferred (five passers already, no run left for its full-suite check), is kept
 * in `mem.deferred` under its goal and dispatched first on the next call for that goal: the
 * queue reserves the texts of popped jobs, so nothing is ever pushed back into it, and a
 * candidate is marked `tried` only when a completed run classified it. Nothing here asks Jev
 * anything: progress is arithmetic on test ids and counts (`probe-progress-judgment.md`,
 * 240/240), the tests are the oracle.
 */
import { isAbsolute, relative, resolve } from 'node:path';

import { sha12 } from '../../core/hash.js';
import type { Sandbox } from '../../core/types.js';
import { LANE_MAX_CASE_TIMEOUTS, laneRunTimeout, parseQuixbugsCommand, refineLanes, refineTRun, shellWords } from '../search/budget.js';
import type { Goal, Lane, OracleModel, StepBudget, VerifyJob, VerifyOutcome, VerifyStatus } from '../search/types.js';
import type { AppliedCandidate, Progress, TestRunSummary } from '../types.js';
import { applyCandidate } from '../verify/apply.js';
import { summarize } from '../verify/index.js';
import { progress } from '../verify/progress.js';
import { CASE_TIMEOUT_ENV, hangsOnEveryFailure, MAX_CASE_TIMEOUTS_ENV, quixbugsTestCommand } from '../verify/quixbugs.js';
import { RUN_FAILURE_ID, shellQuote } from '../verify/text.js';
import { createLanes, type LanePool } from './lanes.js';

/** §4.3: full-suite regression runs per step, "stop after the fifth passer" (decide() arbitrates ≤ 5 plausible). */
export const MAX_FULL_SUITE_RUNS_PER_STEP = 5;
/** Output kept per run: the parsers need the summary and the failure sections (same as the verifier's default). */
export const RUN_OUTPUT_BYTES = 256 * 1024;
/**
 * Environment of every test run on a lane. Python reuses a `__pycache__/*.pyc` whose recorded
 * source mtime (whole seconds) and size match the file, and `git clean -fdq` keeps ignored paths
 * such as `__pycache__/`: with eight lanes cycling same-length candidates within one second
 * (QuixBugs `gcd`: `gcd(a % b, b)` → `gcd(b, a % b)`), the first live bench ran 105 mutations at
 * the right line against stale bytecode and classified them all `unchanged`, the gold included.
 * No bytecode is written on the lanes, so none can be stale (the design's QuixBugs runner already
 * sets this; probe-question-design.md §8).
 */
export const LANE_RUN_ENV: Readonly<Record<string, string>> = { PYTHONDONTWRITEBYTECODE: '1' };

/**
 * The environment of one lane run: LANE_RUN_ENV plus, for a pytest run with a per-test timeout,
 * the two knobs the bench's generated QuixBugs modules read (§4.1: the adaptive per-case limit;
 * the stop rule that ends a run after LANE_MAX_CASE_TIMEOUTS case timeouts, so a hanging
 * candidate costs one timeout instead of cases × timeout). Other pytest suites ignore both. The
 * QuixBugs runner takes its limit on the command line instead (`quixbugsLaneCommand`).
 */
export function laneRunEnv(oracle: Pick<OracleModel, 'runner' | 'perTestTimeoutMs'>): Record<string, string> {
  const env: Record<string, string> = { ...LANE_RUN_ENV };
  if (oracle.runner === 'pytest' && oracle.perTestTimeoutMs !== null) {
    env[CASE_TIMEOUT_ENV] = String(Math.max(1, Math.round(oracle.perTestTimeoutMs)));
    env[MAX_CASE_TIMEOUTS_ENV] = String(LANE_MAX_CASE_TIMEOUTS);
  }
  return env;
}

export class RunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`RunnerError: ${message}`, options);
    this.name = 'RunnerError';
  }
}

/** What the runner needs from the SynthesisContext. */
export interface RunnerContext {
  runDir: string;
  sandbox: Pick<Sandbox, 'run'>;
  signal: AbortSignal;
  workspaceInfo: { root: string; git: boolean };
  step: number;
  emit: (e: { type: 'synth'; step: number; phase: string; detail: string; candidates?: number; tested?: number }) => void;
}

/**
 * What the runner needs from the SearchMemory (§2.1): the baseline (its command is the full-suite
 * command), the oracle (refined here from measured subset runs), the step budget (charged here),
 * `tried`, plus two caches the runner owns: the lane pool and the per-base goal-subset baselines.
 */
export interface RunnerMemory {
  baseline: TestRunSummary | null;
  oracle: OracleModel;
  stepBudget: StepBudget;
  /** sha12(diff) of every candidate ever run */
  tried: Set<string>;
  lanes?: LanePool;
  /** `${base.id}|${scope}` → baseline restricted to the goal subset (pytest without passing ids needs one run) */
  subsetBaselines?: Map<string, TestRunSummary>;
  /**
   * goal id → jobs popped for that goal but not finished (aborted or wall-cut run, or deferred
   * past the passer cap); dispatched first on the next call for the same goal. Keyed by goal
   * because a job is only meaningful against the goal whose subset it was queued for.
   */
  deferred?: Map<string, VerifyJob[]>;
}

/** The slice of the VerifyQueue (sieve/queue.ts) the runner consumes: the best `n` jobs in key order. */
export interface JobQueue {
  pop(n: number): VerifyJob[];
}

/** The full-suite command and where it runs from (the baseline's command; paths in it are workspace-relative or absolute). */
export interface SuiteSpec {
  command: string;
  workspaceRoot: string;
}

export interface RunQueueOptions {
  /** injectable clock */
  now?: () => number;
}

// ---------------------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------------------

/** Files of a goal's pytest node ids (`tests/test_x.py::test_a[0]` → `tests/test_x.py`), deduplicated, in order. */
export function goalTestFiles(goal: Pick<Goal, 'tests'>): string[] {
  const files: string[] = [];
  for (const id of goal.tests) {
    const at = id.indexOf('::');
    if (at <= 0) continue;
    const f = id.slice(0, at);
    if (!files.includes(f)) files.push(f);
  }
  return files;
}

/** The scope a goal-subset run covers: `full` when the runner cannot narrow (QuixBugs runs its whole JSON suite anyway). */
export function subsetScope(oracle: Pick<OracleModel, 'runner'>, goal: Pick<Goal, 'tests'>): { kind: 'full' } | { kind: 'files'; files: string[] } {
  if (oracle.runner !== 'pytest') return { kind: 'full' };
  const files = goalTestFiles(goal);
  return files.length === 0 ? { kind: 'full' } : { kind: 'files', files };
}

/** The workspace-relative path of the QuixBugs program named on the baseline command. */
function programRelPath(candidatePath: string, workspaceRoot: string): string {
  if (!isAbsolute(candidatePath)) return candidatePath;
  const rel = relative(workspaceRoot, candidatePath);
  return rel === '' || rel.startsWith('..') ? candidatePath.slice(candidatePath.lastIndexOf('/') + 1) : rel;
}

/** The QuixBugs runner command pointed at the lane's copy of the program, with the adaptive per-test timeout (§4.1). */
function quixbugsLaneCommand(oracle: OracleModel, lane: Lane, spec: SuiteSpec): string {
  const parsed = parseQuixbugsCommand(spec.command);
  if (parsed === null) throw new RunnerError(`oracle says quixbugs but the command has no run_tests.py: ${spec.command}`);
  const rel = programRelPath(parsed.candidatePath, spec.workspaceRoot);
  const candidatePath = `${lane.dir}/${rel}`;
  // the lane command runs with cwd = lane.dir, so a run_tests.py named relative to the workspace must be anchored there
  const dir = isAbsolute(parsed.dir) ? parsed.dir : resolve(spec.workspaceRoot, parsed.dir);
  const opts: { timeoutSec?: number; slow?: boolean } = {};
  if (oracle.perTestTimeoutMs !== null) opts.timeoutSec = oracle.perTestTimeoutMs / 1000;
  if (shellWords(spec.command).includes('--slow')) opts.slow = true;
  return quixbugsTestCommand(dir, parsed.name, candidatePath, opts);
}

/** The workspace itself seen as a lane: for `run` proposals the engine executes with cwd = workspace root. */
export function workspaceLane(root: string): Lane {
  return { index: -1, dir: root, mode: 'inplace', busy: false };
}

/**
 * §4.3 goal-subset command: `run_tests.py <name> <lane candidate>` for the QuixBugs runner (the
 * whole JSON suite is the subset), the full command plus the goal's test files for pytest (the
 * goal's failing tests and the passing tests in the same files), the full command otherwise.
 * The lane form runs with `cwd = lane.dir`; the context form (`subsetCommand(ctx, mem, goal)`)
 * builds the same command for the workspace, for the cheap goal-subset `run` step of §2.2.
 */
export function subsetCommand(oracle: OracleModel, goal: Pick<Goal, 'tests'>, lane: Lane, spec: SuiteSpec): string;
export function subsetCommand(ctx: Pick<RunnerContext, 'workspaceInfo'>, mem: Pick<RunnerMemory, 'oracle' | 'baseline'>, goal: Pick<Goal, 'tests'>): string;
export function subsetCommand(a: OracleModel | Pick<RunnerContext, 'workspaceInfo'>, b: Pick<Goal, 'tests'> | Pick<RunnerMemory, 'oracle' | 'baseline'>, c: Lane | Pick<Goal, 'tests'>, spec?: SuiteSpec): string {
  if ('workspaceInfo' in a) {
    const mem = b as Pick<RunnerMemory, 'oracle' | 'baseline'>;
    if (mem.baseline === null) throw new RunnerError('subsetCommand needs a baseline run (its command is the full-suite command)');
    const root = a.workspaceInfo.root;
    return laneSubsetCommand(mem.oracle, c as Pick<Goal, 'tests'>, workspaceLane(root), { command: mem.baseline.command, workspaceRoot: root });
  }
  if (spec === undefined) throw new RunnerError('subsetCommand(oracle, goal, lane, spec) needs the suite spec');
  return laneSubsetCommand(a, b as Pick<Goal, 'tests'>, c as Lane, spec);
}

function laneSubsetCommand(oracle: OracleModel, goal: Pick<Goal, 'tests'>, lane: Lane, spec: SuiteSpec): string {
  if (oracle.runner === 'quixbugs') return quixbugsLaneCommand(oracle, lane, spec);
  const scope = subsetScope(oracle, goal);
  if (scope.kind === 'full') return spec.command;
  return `${spec.command} ${scope.files.map(shellQuote).join(' ')}`;
}

/** The full-suite command for a lane: the baseline command, re-pointed at the lane's file for the QuixBugs runner. */
export function fullSuiteCommand(oracle: OracleModel, lane: Lane, spec: SuiteSpec): string {
  if (oracle.runner === 'quixbugs') return quixbugsLaneCommand(oracle, lane, spec);
  return spec.command;
}

// ---------------------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------------------

/** Does the subset run show every goal test passing, with nothing broken in the subset's scope? */
export function goalPasses(goal: Pick<Goal, 'tests'>, subset: TestRunSummary, subsetProgress: Progress): boolean {
  if (subset.total === 0 || subset.timedOut) return false;
  // A pass of the goal's tests needs at least one passed test, and a run that errors where the
  // baseline did not (a collection error: the candidate does not even import) ran no goal test at
  // all; its failing ids name the module, not the tests, so the id check below cannot see it.
  if (subset.passed === 0 || subset.errors > subsetProgress.before.errors) return false;
  const failing = new Set(subset.failing);
  if (failing.has(RUN_FAILURE_ID)) return false;
  if (goal.tests.some((t) => failing.has(t))) return false;
  // with passing ids (pytest -rA) a goal test that vanished from the run is not a pass
  if (subset.passing.length > 0) {
    const passing = new Set(subset.passing);
    if (goal.tests.some((t) => !passing.has(t))) return false;
  }
  return !subsetProgress.regressed;
}

export interface ClassifyInput {
  subset: TestRunSummary;
  subsetProgress: Progress;
  /** present only when the goal subset passed and a full-suite run was made (or the subset was the full suite) */
  full?: TestRunSummary;
  fullProgress?: Progress;
  passesGoal: boolean;
}

/**
 * The status table of the module header, in code. A run whose every failing case hit the
 * per-case timeout (or was not run after one, the lanes' stop rule) is `timeout` like a run the
 * sandbox killed: the candidate hangs, whatever it does on the cases that passed (§4.1); before
 * this such a run read as `unchanged` when the buggy program hung on the same cases.
 */
export function classifyOutcome(input: ClassifyInput): VerifyStatus {
  if (input.subset.timedOut) return 'timeout';
  if (input.passesGoal && input.full !== undefined && input.fullProgress !== undefined) {
    if (input.full.timedOut || hangsOnEveryFailure(input.full)) return 'timeout';
    return input.fullProgress.regressed ? 'regressed' : 'plausible';
  }
  if (hangsOnEveryFailure(input.subset)) return 'timeout';
  if (input.subsetProgress.regressed) return 'regressed';
  if (input.subsetProgress.newlyPassing.length > 0 || input.subsetProgress.improved) return 'partial';
  return 'unchanged';
}

// ---------------------------------------------------------------------------------------
// Subset baselines
// ---------------------------------------------------------------------------------------

/** A summary knows its passing ids when it lists some, or when nothing passed (nothing to list). */
function knowsPassingIds(s: TestRunSummary): boolean {
  return s.passing.length > 0 || s.passed === 0;
}

/** The baseline restricted to the goal's test files, from ids (pytest -rA); null when the ids are not known. */
export function restrictToFiles(base: TestRunSummary, files: readonly string[]): TestRunSummary | null {
  if (!knowsPassingIds(base)) return null;
  const inScope = (id: string): boolean => files.some((f) => id === f || id.startsWith(`${f}::`));
  const failing = base.failing.filter(inScope);
  const passing = base.passing.filter(inScope);
  return { ...base, failing, passing, failures: base.failures.filter((f) => inScope(f.testId)), passed: passing.length, failed: failing.length, errors: 0, skipped: 0, total: passing.length + failing.length };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------------------
// runQueue
// ---------------------------------------------------------------------------------------

type JobResult = { kind: 'outcome'; outcome: VerifyOutcome } | { kind: 'defer' };

function emptySummary(command: string, actual: string): TestRunSummary {
  return { command, passed: 0, failed: 0, errors: 1, skipped: 0, total: 1, failing: [RUN_FAILURE_ID], passing: [], failures: [{ testId: RUN_FAILURE_ID, call: command, expected: 'the candidate applies and its tests run', actual }], exitCode: null, timedOut: false, durationMs: 0, outputTail: '' };
}

/**
 * Run the verification queue for one goal (§2.3 `runQueue`). Returns one VerifyOutcome per
 * candidate that completed; jobs whose run was aborted by `ctx.signal` or cut short by the
 * step's remaining wall, or deferred because the step already has five passers or no run left,
 * wait in `mem.deferred` under the goal. Charges the StepBudget (one per run, wall = batch
 * elapsed), records the diff of every completed candidate in `mem.tried` (the key D's queue
 * excludes), refines `mem.oracle.tRunMs` from the measured runs and emits one `synth` event per
 * batch. A lane failure (a reset that did not restore the lane) stops dispatch; the outcomes
 * already classified are still returned, and the error is thrown only when nothing completed.
 */
export async function runQueue(ctx: RunnerContext, mem: RunnerMemory, queue: JobQueue, goal: Goal, runsAllowed: number, opts: RunQueueOptions = {}): Promise<VerifyOutcome[]> {
  const baseline = mem.baseline;
  if (baseline === null) throw new RunnerError('runQueue needs a baseline run (its command is the full-suite command)');
  const now = opts.now ?? Date.now;
  const oracle = mem.oracle;
  const budget = mem.stepBudget;
  const spec: SuiteSpec = { command: baseline.command, workspaceRoot: ctx.workspaceInfo.root };
  // A pool built for an earlier oracle with fewer lanes (a repository-class first baseline that a
  // re-fit made QuixBugs-class) would serialise the batch at its old width: rebuild it.
  if (mem.lanes !== undefined && mem.lanes.mode !== 'inplace' && mem.lanes.lanes.length < oracle.lanes) {
    await mem.lanes.disposeLanes();
    delete mem.lanes;
  }
  const pool = mem.lanes ?? (await createLanes(ctx, oracle));
  mem.lanes = pool;
  const subsetBaselines = mem.subsetBaselines ?? new Map<string, TestRunSummary>();
  mem.subsetBaselines = subsetBaselines;
  const deferredByGoal = mem.deferred ?? new Map<string, VerifyJob[]>();
  mem.deferred = deferredByGoal;
  const deferred = deferredByGoal.get(goal.id) ?? [];
  deferredByGoal.set(goal.id, deferred);
  // jobs carried over from earlier calls are dispatched first; a job deferred *during* this call
  // goes back on `deferred` for the next call, never into this call's supply (it would be popped
  // again at once and charged a run per loop until runsAllowed ran out)
  const carried = deferred.splice(0, deferred.length);
  const scope = subsetScope(oracle, goal);

  const batchStart = now();
  const wallAtStart = budget.testWallLeftMs;
  let dispatched = 0;
  let passers = 0;
  let laneFailure: unknown = null;
  const results: { order: number; outcome: VerifyOutcome }[] = [];
  const subsetDurations: number[] = [];
  const fullDurations: number[] = [];

  const wallLeft = (): number => wallAtStart - (now() - batchStart);
  // §4.1: the sandbox timeout of a lane run derives from the oracle (the workspace command's
  // timeout tightened to the lane settings), never from a constant
  const laneTimeoutMs = laneRunTimeout(oracle, baseline);
  const env = laneRunEnv(oracle);
  // a run the remaining wall cannot fit (one measured goal-subset run, or the run timeout when smaller) is not started
  const minRunWallMs = Math.min(laneTimeoutMs, Math.max(1, oracle.tRunMs.goalSubset));
  const stopDispatch = (): boolean =>
    ctx.signal.aborted || laneFailure !== null || dispatched >= runsAllowed || budget.testRunsLeft <= 0 || wallLeft() < minRunWallMs || passers >= MAX_FULL_SUITE_RUNS_PER_STEP;

  /**
   * One test run on a lane; a sandbox failure is a run failure, never a pass, and never aborts
   * the batch. `aborted` also covers a kill on a timeout the step's remaining wall cut below the
   * oracle's run timeout: that says nothing about the candidate (it is not a probable infinite
   * loop), so it is deferred and re-run with the full timeout rather than classified `timeout`.
   */
  const runTests = async (command: string, lane: Lane): Promise<TestRunSummary & { aborted: boolean }> => {
    const timeoutMs = Math.max(1, Math.min(laneTimeoutMs, Math.max(1, wallLeft())));
    const truncated = timeoutMs < laneTimeoutMs;
    const started = now();
    try {
      const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: RUN_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir, env: { ...env } });
      const s = summarize(command, res, res.durationMs > 0 ? res.durationMs : now() - started);
      const wallCut = truncated && res.killedBy === 'timeout';
      return { ...s, aborted: res.killedBy === 'abort' || res.killedBy === 'wall_time' || wallCut || ctx.signal.aborted };
    } catch (e: unknown) {
      const s = summarize(command, { stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: null }, now() - started);
      return { ...s, aborted: ctx.signal.aborted };
    }
  };

  /** Baseline the subset run is compared with: the base's full summary, or its restriction to the goal's files. */
  const subsetBaselineFor = async (job: VerifyJob, lane: Lane): Promise<TestRunSummary | 'defer'> => {
    if (scope.kind === 'full') return job.base.summary;
    const key = `${job.base.id}|${scope.files.join('|')}`;
    const cached = subsetBaselines.get(key);
    if (cached !== undefined) return cached;
    const byIds = restrictToFiles(job.base.summary, scope.files);
    if (byIds !== null) {
      subsetBaselines.set(key, byIds);
      return byIds;
    }
    // pytest without passing ids: measure the subset once on the clean lane (one charged run)
    if (budget.testRunsLeft <= 0) return 'defer';
    budget.testRunsLeft -= 1;
    await pool.applyToLane(lane, { candidate: job.candidate, files: [], diff: '' }, job.base.files);
    const s = await runTests(subsetCommand(oracle, goal, lane, spec), lane);
    if (s.aborted) return 'defer';
    subsetBaselines.set(key, s);
    return s;
  };

  const verifyJob = async (job: VerifyJob, lane: Lane): Promise<JobResult> => {
    let applied: AppliedCandidate;
    try {
      applied = applyCandidate(job.candidate, job.base.files);
    } catch (e: unknown) {
      return applyFailed(job, { candidate: job.candidate, files: [], diff: '' }, e);
    }
    const subsetBase = await subsetBaselineFor(job, lane);
    if (subsetBase === 'defer') return { kind: 'defer' };
    try {
      await pool.applyToLane(lane, applied, job.base.files);
    } catch (e: unknown) {
      return applyFailed(job, applied, e);
    }
    if (budget.testRunsLeft <= 0) return { kind: 'defer' };
    budget.testRunsLeft -= 1;
    const subset = await runTests(subsetCommand(oracle, goal, lane, spec), lane);
    if (subset.aborted) return { kind: 'defer' };
    subsetDurations.push(subset.durationMs);
    const subsetProgress = progress(subsetBase, subset);
    const passesGoal = goalPasses(goal, subset, subsetProgress);

    let full: TestRunSummary | undefined;
    let fullProgress: Progress | undefined;
    if (passesGoal) {
      if (scope.kind === 'full') {
        // the subset already was the whole suite: the run is spent and decides, whatever the passer count
        // (the cap of §4.3 bounds full-suite runs; here there is none to bound, and tests are the oracle)
        passers += 1;
        full = subset;
      } else {
        if (passers >= MAX_FULL_SUITE_RUNS_PER_STEP || budget.testRunsLeft <= 0) return { kind: 'defer' };
        passers += 1;
        budget.testRunsLeft -= 1;
        const f = await runTests(fullSuiteCommand(oracle, lane, spec), lane);
        if (f.aborted) {
          passers -= 1;
          return { kind: 'defer' };
        }
        fullDurations.push(f.durationMs);
        full = f;
      }
      fullProgress = progress(job.base.summary, full);
    }
    const status = classifyOutcome({ subset, subsetProgress, passesGoal, ...(full !== undefined ? { full } : {}), ...(fullProgress !== undefined ? { fullProgress } : {}) });
    mem.tried.add(sha12(applied.diff)); // only a completed candidate is "tried"; a deferred one runs again
    const outcome: VerifyOutcome = { job, applied, subset, progress: fullProgress ?? subsetProgress, status, ...(full !== undefined ? { full } : {}) };
    return { kind: 'outcome', outcome };
  };

  const applyFailed = (job: VerifyJob, applied: AppliedCandidate, e: unknown): JobResult => {
    const why = e instanceof Error ? e.message : String(e);
    const subset = emptySummary(spec.command, why);
    const p = progress(job.base.summary, subset);
    return { kind: 'outcome', outcome: { job, applied, subset, progress: p, status: 'apply_failed' } };
  };

  const worker = async (): Promise<void> => {
    while (!stopDispatch()) {
      const job = carried.shift() ?? queue.pop(1)[0];
      if (job === undefined) return;
      const order = dispatched;
      dispatched += 1;
      let r: JobResult;
      try {
        r = await pool.withLane((lane) => verifyJob(job, lane));
      } catch (e: unknown) {
        // the lane could not be prepared or restored (a failing git reset, an aborted sandbox):
        // the job is not lost, no more work is dispatched, and the batch's outcomes still count
        laneFailure = e;
        r = { kind: 'defer' };
      }
      if (r.kind === 'defer') deferred.push(job);
      else results.push({ order, outcome: r.outcome });
    }
  };
  const workers = Math.max(1, Math.min(pool.lanes.length, oracle.lanes));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  // carried jobs that dispatch never reached stay first in line
  deferred.unshift(...carried);

  budget.testWallLeftMs = Math.max(0, wallAtStart - (now() - batchStart));
  // the oracle learns the measured cost of this goal's subset and of the full suite (§4.1: t_run per
  // scope); the subset's, which §2.4 reads, keeps a sieve-eligible estimate through a load spike (`refineTRun`)
  const subsetMed = median(subsetDurations);
  if (subsetMed !== null && subsetMed > 0) oracle.tRunMs.goalSubset = refineTRun(oracle.tRunMs.goalSubset, subsetMed);
  const fullMed = median(fullDurations);
  if (fullMed !== null && fullMed > 0) oracle.tRunMs.fullSuite = Math.round(fullMed);
  // a fast suite gets the fast suite's lanes (§4.1); the pool is widened at the next call
  const lanesBefore = oracle.lanes;
  oracle.lanes = refineLanes(oracle, pool.mode);

  results.sort((a, b) => a.order - b.order);
  const outcomes = results.map((r) => r.outcome);
  const counts = new Map<VerifyStatus, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const failureNote = laneFailure === null ? '' : `; lane failure: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`;
  const timing = subsetMed === null ? '' : `; run median ${Math.round(subsetMed)} ms, t_run ${oracle.tRunMs.goalSubset} ms${oracle.lanes === lanesBefore ? '' : `, lanes ${lanesBefore} → ${oracle.lanes}`}`;
  const detail = `${goal.id}: ${outcomes.length} tested on ${workers} lane${workers === 1 ? '' : 's'} (${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing ran'}); runs left ${budget.testRunsLeft}, test wall left ${Math.round(budget.testWallLeftMs / 1000)} s${timing}${ctx.signal.aborted ? '; aborted' : ''}${failureNote}`;
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail, candidates: dispatched, tested: outcomes.length });
  // a broken lane with nothing to show for the batch is an error the step must see; on abort the caller is stopping anyway
  if (laneFailure !== null && outcomes.length === 0 && !ctx.signal.aborted) throw new RunnerError(`lane failure during ${goal.id}: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`, { cause: laneFailure });
  return outcomes;
}
