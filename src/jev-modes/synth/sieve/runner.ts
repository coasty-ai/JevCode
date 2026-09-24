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
 * A `timeout` is final only when the candidate is a genuine hang (`timeoutKind`): the buggy
 * program hangs on the same case, or the alarm fired on the first case and the baseline
 * finished that case quickly. Otherwise — the run stopped on the alarm after passing cases, with
 * no case failing on a value — the verdict is PROVISIONAL: the candidate may be slow rather than
 * hanging (the per-case cap is fitted idle to a skewed distribution and the lanes run under the
 * bench's CPU contention: `longest_common_subsequence`'s gold, 94 ms idle on its slow case,
 * crossed a 500 ms cap under 5× load and was lost for the run, jev-only-quixbugs-3-inspection.md
 * §2). Provisional candidates go to `mem.retryTimeouts` instead of `tried`; at the end of the
 * batch up to RETRY_TIMEOUTS_MAX_PER_BATCH of them are re-run with the runners' full 2 s cap
 * (the stop rule kept, see `RunSettings`), and only that run classifies them (the rest wait for
 * the next call for the goal).
 *
 * A run the SANDBOX killed at the lane timeout is a `timeout` too, and final on its own — except
 * when EVERY classified run of the batch was killed that way and the batch measured a load of
 * ≥ LOAD_SCALE_MIN_RATIO (its run median against the oracle's estimate): ladder `account`, step
 * 18, "4 tested (4 timeout); run median 11550 ms" against 0.4–0.8 s in every other batch of the
 * run, with Jev's p = 1.00 pick in the batch (jev-only-ladder-4-analysis.md §1.3). Such a batch
 * says the lanes were starved, not that four candidates hang: its candidates are re-queued once
 * (`mem.retryTimeouts`, retried first at the next call for the goal, so after the rest of the
 * step's batches) with the lane timeout scaled by the observed load (IN_FLIGHT_RETRY_TIMEOUT_FACTOR
 * bounds it); the retry's verdict is final. A batch with at least one run that finished keeps
 * every killed run as a hang, and a lone killed run is a hang (IN_FLIGHT_RETRY_MIN_RUNS).
 *
 * The step's StepBudget is honoured (runs and wall), `ctx.signal` stops dispatching (in-flight
 * runs are bounded by their own timeout and killed by the sandbox), and up to `oracle.lanes`
 * runs overlap. Every lane run carries the oracle's adaptive per-test timeout (§4.1): as
 * `--timeout` on the QuixBugs runner's command, as JEVCODE_CASE_TIMEOUT_MS (with the
 * stop-after-one-timeout rule, JEVCODE_MAX_CASE_TIMEOUTS=1) in the environment of a pytest run,
 * which the bench's generated modules read; the sandbox timeout of a lane run is
 * `laneRunTimeout` (budget.ts), never the 120 s command default. Load awareness: once a batch has
 * LOAD_SAMPLE_MIN_RUNS measured runs whose median exceeds LOAD_SCALE_MIN_RATIO × the oracle's
 * t_run estimate, the per-case timeout of the rest of the batch is scaled by the observed ratio
 * (`scaledCaseTimeout`, bounded by 2 s) and the verify event says so ("load ×2.3, case timeout
 * 500→1150 ms"). After each batch the oracle learns the measured run median (`refineTRun`, with
 * the §2.4 hysteresis under load) and, once a run measures under 1 s, the fast suite's lane
 * count (`refineLanes`; the pool is widened at the next call). A job whose run was aborted,
 * killed on a timeout the step's remaining wall had cut short, or deferred (five passers
 * already, no run left for its full-suite check), is kept in `mem.deferred` under its goal and
 * dispatched first on the next call for that goal: the queue reserves the texts of popped jobs,
 * so nothing is ever pushed back into it, and a candidate is marked `tried` only when a
 * completed run gave it its final classification. Nothing here asks Jev anything: progress is
 * arithmetic on test ids and counts (`probe-progress-judgment.md`, 240/240), the tests are the
 * oracle.
 */
import { isAbsolute, relative, resolve } from 'node:path';

import { sha12 } from '../../../core/hash.js';
import type { Sandbox, StepWarmSummary } from '../../../core/types.js';
import { caseProfile, DEFAULT_CASE_TIMEOUT_MS, LANE_MAX_CASE_TIMEOUTS, laneRunTimeout, LOAD_SAMPLE_MIN_RUNS, LOAD_SCALE_MIN_RATIO, loadRatio, MIN_RUN_TIMEOUT_MS, parseQuixbugsCommand, PER_TEST_TIMEOUT_FACTOR, PROCESS_OVERHEAD_MS, refineLanes, refineTRun, RETRY_CASE_TIMEOUT_MS, RETRY_TIMEOUTS_MAX_PER_BATCH, RUN_TIMEOUT_FACTOR, scaledCaseTimeout, shellWords } from '../search/budget.js';
import type { Goal, Lane, OracleModel, StepBudget, VerifyJob, VerifyOutcome, VerifyStatus } from '../search/types.js';
import type { AppliedCandidate, Progress, TestRunSummary } from '../types.js';
import { applyCandidate } from '../verify/apply.js';
import { summarize } from '../verify/index.js';
import { progress } from '../verify/progress.js';
import { CASE_TIMEOUT_ENV, hangsOnEveryFailure, isCaseNotRun, isCaseTimeout, MAX_CASE_TIMEOUTS_ENV, quixbugsTestCommand } from '../verify/quixbugs.js';
import { RUN_FAILURE_ID, shellQuote } from '../verify/text.js';
import { scopeUsable } from '../../../workspace/tests.js';
import { emptyWarmStats, interpreterFor, WARM_ENV_FLAG, WarmPlane, warmDelta, warmModeFor, warmNote, warmRequested, type WarmScreen, type WarmStats } from '../warm/index.js';
import { createLanes, type LanePool } from './lanes.js';

/** §4.3: full-suite regression runs per step, "stop after the fifth passer" (decide() arbitrates ≤ 5 plausible). */
export const MAX_FULL_SUITE_RUNS_PER_STEP = 5;
/**
 * In-flight timeouts (module header): a batch is re-queued only when at least this many of its
 * runs were killed and none finished. Two independent candidates killed at the same wall is
 * already an unlikely shape for genuine hangs; one alone is a hang (the existing rule, kept).
 * The measured batch had four.
 */
export const IN_FLIGHT_RETRY_MIN_RUNS = 2;
/**
 * The retry's lane timeout is the batch's lane timeout × min(observed load, this): at the 23×
 * load of the measured batch a 0.5 s run needed ≈ 11.5 s, the lane timeout itself (3 × t_run
 * + 10 s); twice that covers it, while a batch of genuine hangs costs at most two lane timeouts
 * per lane once (the retry is final).
 */
export const IN_FLIGHT_RETRY_TIMEOUT_FACTOR = 2;
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
 * `stopRule: false` leaves the module's own default (no limit) for a caller that wants every
 * case's verdict.
 */
export function laneRunEnv(oracle: Pick<OracleModel, 'runner' | 'perTestTimeoutMs'>, opts: { stopRule?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = { ...LANE_RUN_ENV };
  if (oracle.runner === 'pytest' && oracle.perTestTimeoutMs !== null) {
    env[CASE_TIMEOUT_ENV] = String(Math.max(1, Math.round(oracle.perTestTimeoutMs)));
    if (opts.stopRule !== false) env[MAX_CASE_TIMEOUTS_ENV] = String(LANE_MAX_CASE_TIMEOUTS);
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
  /**
   * docs/LLM-JEV-DESIGN.md §4.8: full-suite (regression) runs made for passers this step, across every
   * `runQueue` / `runRepositoryQueue` call of the step — MAX_FULL_SUITE_RUNS_PER_STEP is a per-step
   * bound however many times the runner is entered (an LLM phase enters it once more after the
   * seeds). Reset by search/index.ts with the fresh StepBudget; absent = 0.
   */
  passersThisStep?: number;
  lanes?: LanePool;
  /**
   * The warm verification plane (docs/HARNESS-NEXT-DESIGN.md §3 M6): one persistent interpreter
   * per lane, screening candidate runs at fork cost. Lives beside the lane pool because it is
   * bound to the lane directories, is created lazily on the first servable command, and is
   * disposed whenever the pool is rebuilt (here and in `oracle/verify.ts runRepositoryQueue`,
   * the two places that rebuild it). Absent, disabled or unservable, every run takes exactly
   * today's cold path.
   *
   * Run-end teardown is the lane pool's: nothing disposes either at the end of a run, and both
   * are ended by `sandbox.killAll()` (`src/loop/engine.ts`) — which is layer 4 of the worker's
   * liveness ladder, and is also what closing the harness's end of the request fifo would do on
   * its own. Until then an idle worker exits by itself after `WARM_IDLE_MS`.
   */
  warm?: WarmScreen;
  /** `${base.id}|${scope}` → baseline restricted to the goal subset (pytest without passing ids needs one run) */
  subsetBaselines?: Map<string, TestRunSummary>;
  /**
   * goal id → jobs popped for that goal but not finished (aborted or wall-cut run, or deferred
   * past the passer cap); dispatched first on the next call for the same goal. Keyed by goal
   * because a job is only meaningful against the goal whose subset it was queued for.
   */
  deferred?: Map<string, VerifyJob[]>;
  /**
   * goal id → provisional timeouts awaiting their retry at the full cap (`timeoutKind`
   * 'provisional'): not in `tried` until that run classifies them. Retried first at the next
   * call for the goal; dropped when the memory has been re-baselined since (their verdict was
   * against a baseline the search no longer holds, like `deferred`, which index.ts resets).
   */
  retryTimeouts?: Map<string, PendingRetry[]>;
  /**
   * goal id → `tried` hashes of the candidates classified `unchanged` for that goal. An
   * `unchanged` verdict says "the goal's tests still fail the same way with this edit" — a fact
   * about the failure the goal had when it ran. A progress commit (a partial fix, search/index.ts)
   * removes that failure for the goal's remaining tests, which then fail for a new reason at a
   * new frame, so every `unchanged` verdict of the goal is stale and `forgetUnchangedTried`
   * takes those hashes out of `tried`: ladder `long_chain` run 3 tested the gold `clean.py` line
   * under the `load.py` crash (unchanged: every test still died in `parse_row`), and after the
   * `load.py` fix the line was excluded as tried while a wrong partial at the same site was
   * committed. `regressed`, `plausible`, `partial` and hang verdicts stay tried.
   */
  unchangedTried?: Map<string, Set<string>>;
  /**
   * OOS iteration 2, defect 2 (experiments/results/llm-jev-iter2.md §10): the warm plane's
   * counters for the step now running, summed over its sieve batches, so `StepRecord.verify.warm`
   * can carry them into `steps.jsonl` (`search/index.ts` reads it at `reportVerify`). `WarmStats`
   * itself is cumulative over the RUN and lives on `warm`; this is the per-STEP delta, reset by
   * the first batch of each step — a per-step field summed over the steps must not be a running
   * total. Absent when `JEVCODE_WARM` never asked for the plane, which is the default.
   */
  warmStep?: { step: number; warm: StepWarmSummary };
}

/** A `StepWarmSummary` with every counter at zero: the shape an unsupported runner records. */
export function emptyStepWarm(mode: StepWarmSummary['mode']): StepWarmSummary {
  return { mode, offered: 0, screened: 0, confirmed: 0, mismatches: 0, fallbacks: 0, restarts: 0, invalidations: 0, scopeUnusable: 0, deadlineRechecks: 0, screenMs: 0, confirmMs: 0 };
}

/** One batch's `WarmStats` delta as the step record's shape. */
export function stepWarmFrom(mode: StepWarmSummary['mode'], s: WarmStats): StepWarmSummary {
  return {
    mode,
    offered: s.offered,
    screened: s.screened,
    confirmed: s.confirmed,
    mismatches: s.mismatches,
    fallbacks: s.fallbacks,
    restarts: s.restarts,
    invalidations: s.invalidations,
    scopeUnusable: s.scopeUnusable,
    deadlineRechecks: s.deadlineRechecks,
    screenMs: s.screenMs,
    confirmMs: s.confirmMs,
    ...(s.disabledReason === null ? {} : { disabledReason: s.disabledReason }),
  };
}

/**
 * Add one batch's warm counters to the step's record (`RunnerMemory.warmStep`), starting a fresh
 * total when the step has moved on. `mode` wins for `on`: a step in which the plane served even
 * one command is not an unsupported one, whatever a later call for a different oracle says.
 */
export function recordWarmStep(mem: Pick<RunnerMemory, 'warmStep'>, step: number, add: StepWarmSummary): void {
  const cur = mem.warmStep?.step === step ? mem.warmStep.warm : null;
  if (cur === null) {
    mem.warmStep = { step, warm: add };
    return;
  }
  // the plane's `disable()` is one-way, so the first reason recorded in the step is the reason
  const reason = cur.disabledReason ?? add.disabledReason;
  mem.warmStep = {
    step,
    warm: {
      mode: cur.mode === 'on' || add.mode === 'on' ? 'on' : cur.mode,
      offered: cur.offered + add.offered,
      screened: cur.screened + add.screened,
      confirmed: cur.confirmed + add.confirmed,
      mismatches: cur.mismatches + add.mismatches,
      fallbacks: cur.fallbacks + add.fallbacks,
      restarts: cur.restarts + add.restarts,
      invalidations: cur.invalidations + add.invalidations,
      scopeUnusable: cur.scopeUnusable + add.scopeUnusable,
      deadlineRechecks: cur.deadlineRechecks + add.deadlineRechecks,
      screenMs: cur.screenMs + add.screenMs,
      confirmMs: cur.confirmMs + add.confirmMs,
      ...(reason === undefined ? {} : { disabledReason: reason }),
    },
  };
}

function recordUnchanged(mem: Pick<RunnerMemory, 'unchangedTried'>, goalId: string, diffHash: string): void {
  const map = mem.unchangedTried ?? new Map<string, Set<string>>();
  mem.unchangedTried = map;
  const set = map.get(goalId) ?? new Set<string>();
  set.add(diffHash);
  map.set(goalId, set);
}

/**
 * Forget the `unchanged` verdicts recorded for `goalId` (see `RunnerMemory.unchangedTried`): the
 * hashes leave `tried`, so the candidates are enumerated and run again on the new workspace.
 * Returns how many were forgotten.
 */
export function forgetUnchangedTried(mem: Pick<RunnerMemory, 'tried' | 'unchangedTried'>, goalId: string): number {
  const set = mem.unchangedTried?.get(goalId);
  if (set === undefined) return 0;
  let n = 0;
  for (const h of set) if (mem.tried.delete(h)) n += 1;
  mem.unchangedTried?.delete(goalId);
  return n;
}

/** A candidate whose first run was a provisional `timeout`, waiting for its retry at RETRY_CASE_TIMEOUT_MS without the stop rule. */
export interface PendingRetry {
  job: VerifyJob;
  applied: AppliedCandidate;
  /** sha12(applied.diff): a re-enumerated copy popped while the retry is pending is skipped, not run again */
  diffHash: string;
  /** the provisional run and the per-case cap it ran under */
  subset: TestRunSummary;
  caseTimeoutMs: number;
  /** the memory's baseline when the provisional run was judged; a different object means the search re-baselined */
  baseline: TestRunSummary;
  /** an in-flight timeout (the sandbox killed the run under load): the lane timeout the retry runs with */
  runTimeoutMs?: number;
}

/**
 * The slice of the VerifyQueue (sieve/queue.ts) the runner consumes: the best `n` jobs in key order,
 * and — when the queue streams an LLM round (docs/LLM-JEV-DESIGN.md §4.8) — an awaitable `next()`
 * that resolves with the next job or null once the source closed the queue, so lanes start on the
 * first parsed sample instead of after the last. A queue without `next` ends the worker on empty.
 */
export interface JobQueue {
  pop(n: number): VerifyJob[];
  /** streaming (docs/LLM-JEV-DESIGN.md §4.8): the next job while the queue is open, null on the close — or at once when `signal` aborts (the caller gives up its wait; the stream stays open) */
  next?(signal?: AbortSignal): Promise<VerifyJob | null>;
  /**
   * Whether the queue streams (an LLM round is landing samples). A batch begun in streaming mode ends on its first
   * `plausible` outcome — its full-suite run is behind it — so the controller decides over everything that landed
   * and cancels the round's losers at once (§4.2, §6.2) instead of waiting for the slowest sample or its deadline;
   * it re-enters the stream when the guard holds. A plain batch (jev-only) never streams and runs to its end.
   */
  readonly streaming?: boolean;
}

/** Node's timer ceiling (2³¹ − 1 ms): a longer delay fires at once, so a park's wall timer is clamped to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Park on a streaming queue (§4.8) until a job lands or the queue closes. The wait ends early with null when
 * `released` aborts (dispatch stopped: a decisive passer, the passer cap, a spent run count, a lane failure, the
 * step signal) or after `waitMs` (the wall would no longer fit one run), so a worker never sits in `next()` past
 * the batch's own stop rules while the round's feed is still open. Undefined when the queue cannot stream or
 * nothing can be waited for.
 */
export async function awaitNextJob(queue: JobQueue, released: AbortSignal, waitMs: number): Promise<VerifyJob | undefined> {
  if (queue.next === undefined || waitMs <= 0 || released.aborted) return undefined;
  const park = new AbortController();
  const release = (): void => park.abort();
  const timer = setTimeout(release, Math.min(waitMs, MAX_TIMER_MS));
  released.addEventListener('abort', release, { once: true });
  try {
    return (await queue.next(park.signal)) ?? undefined;
  } finally {
    clearTimeout(timer);
    released.removeEventListener('abort', release);
  }
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

/**
 * Did this run hit a deadline the BASELINE does not already hit (docs/HARNESS-NEXT-DESIGN.md
 * §3 M6, risk R-2)?
 *
 * A deadline is the one measurement the warm and the cold path cannot charge from the same
 * instant: a cold cap covers process start and the runner's own imports, a warm one covers a
 * fork, and the worker can only subtract a *measured estimate* of the difference. So a warm run
 * that hits a NEW deadline is never a verdict — `runTests` discards it and runs the command
 * cold, which decides. Without that, a real fix the warm cap happened to cut short would be
 * classified `timeout`, marked `tried`, and dropped for the run with nothing re-checking it.
 *
 * "New" is what keeps the guard affordable. A candidate that hangs exactly where the baseline
 * hangs tells the same story on both paths — that is `bitcount`'s 203 hanging candidates, whose
 * wall IS the per-case cap — and re-running every one of them cold would double the wall of the
 * task class the warm plane was built for, while deciding nothing. A timeout the baseline does
 * not have is the opposite: it is either a candidate that made things worse, or the cap being
 * wrong, and only a cold run can tell which.
 */
export function newDeadlineHit(run: Pick<TestRunSummary, 'timedOut' | 'failures'>, baseline: Pick<TestRunSummary, 'timedOut' | 'failures'>): boolean {
  if (run.timedOut) return !baseline.timedOut;
  const known = new Set(baseline.failures.filter((f) => isCaseTimeout(f.actual)).map((f) => f.testId));
  return run.failures.some((f) => isCaseTimeout(f.actual) && !known.has(f.testId));
}

/** Whether a `timeout` verdict is final ('hang') or awaits a retry at the full cap ('provisional'). */
export type TimeoutKind = 'hang' | 'provisional';

export interface TimeoutKindInput {
  /** the run classified `timeout` (the subset, or the full suite of a subset passer) */
  run: TestRunSummary;
  /** what that run was compared with (the goal-subset baseline, or the base's full summary) */
  base: TestRunSummary;
  runner: OracleModel['runner'];
  /** the per-case cap the run ran under (ms) */
  caseTimeoutMs: number;
  /** the load the batch has measured so far (`loadRatio`; 1 when unknown) */
  loadRatio: number;
}

/**
 * Is a `timeout` verdict the candidate's, or the cap's? Final ('hang') when:
 *
 * 1. the sandbox killed the run: its timeout is far above any per-case cap (`laneRunTimeout`);
 * 2. every case that hit the alarm is one the baseline hit it on too — the buggy program hangs
 *    there — and either the run was already at the full RETRY_CASE_TIMEOUT_MS cap (a retry could
 *    say nothing new) or no case passed at all (the candidate shows no improvement over the
 *    baseline on any case: bitcount's 203 hanging candidates in the second live bench alarm on
 *    the first case, none of them gets a retry). Not final when cases passed and the cap was
 *    below 2 s: `levenshtein`'s reference solution is exponential and takes 1.0 s idle on the
 *    case the buggy program alarms on at 2 s, so at a 500 ms cap the gold alarms exactly where
 *    the baseline does — and finishes at the retry's 2 s;
 * 3. (sequential pytest only) the alarm fired on the very first case — nothing passed, one
 *    timeout, the rest not run — and the baseline finished that case quickly: its own time when
 *    the baseline output has pytest's durations table, else the tail bound of the finished
 *    cases, times PER_TEST_TIMEOUT_FACTOR and the observed load, fits under the cap. Even at the
 *    observed load the case had three times its baseline time and did not return.
 *
 * Anything else is 'provisional': the candidate passed cases and then a case did not return
 * under a cap fitted idle — slow, or hanging on that input; the retry at the full 2 s cap
 * decides. The QuixBugs runner runs its cases in parallel, so rule 3's "first case" does not
 * exist there. Known gap: a fix slower than the cap on a case the buggy program hangs on, when
 * that case is the suite's first, is final under rule 2.
 */
export function timeoutKind(input: TimeoutKindInput): TimeoutKind {
  const { run, base } = input;
  if (run.timedOut) return 'hang';
  const alarmed = run.failures.filter((f) => isCaseTimeout(f.actual)).map((f) => f.testId);
  if (alarmed.length === 0) return 'hang';
  const noValueFailure = run.failures.every((f) => isCaseTimeout(f.actual) || isCaseNotRun(f.actual));
  const baseAlarmed = new Set(base.failures.filter((f) => isCaseTimeout(f.actual)).map((f) => f.testId));
  if (alarmed.every((id) => baseAlarmed.has(id)) && (input.caseTimeoutMs >= RETRY_CASE_TIMEOUT_MS || (run.passed === 0 && noValueFailure))) return 'hang';
  const firstCase = input.runner === 'pytest' && run.passed === 0 && alarmed.length === 1 && noValueFailure;
  if (firstCase) {
    const profile = caseProfile(base);
    const own = profile.caseDurations?.find((d) => d.testId === alarmed[0])?.ms;
    const baseMs = own ?? profile.tailMs;
    const load = Number.isFinite(input.loadRatio) && input.loadRatio > 1 ? input.loadRatio : 1;
    if (baseMs !== null && PER_TEST_TIMEOUT_FACTOR * baseMs * load <= input.caseTimeoutMs) return 'hang';
  }
  return 'provisional';
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

type JobResult =
  | { kind: 'outcome'; outcome: VerifyOutcome }
  | { kind: 'defer' }
  | { kind: 'provisional'; pending: PendingRetry }
  /** the sandbox killed the run at the lane timeout: final unless the whole batch did so under load (decided at the batch end) */
  | { kind: 'killed'; pending: PendingRetry; outcome: VerifyOutcome }
  | { kind: 'skip' };

/** One lane run: the summary, whether the batch must treat it as not having happened, and whether a warm worker produced it. */
type LaneRun = TestRunSummary & {
  aborted: boolean;
  warm: boolean;
  /**
   * iteration-2 defect 1 (experiments/results/llm-jev-iter2.md §7.3): this COLD run only happened
   * because a hot screen of the same command hit a deadline and was discarded. Its duration is a
   * bound, not a measurement of the candidate, and it must never reach `subsetDurations` — with
   * the plane on, deadline re-runs are the *only* cold runs a batch of non-passers makes, so
   * teaching from them makes the oracle's t_run a sample of nothing but timeouts (185 candidates
   * of `topological_ordering`: taught 11,655 ms against 510 ms cold on the identical batch).
   */
  recheck: boolean;
};

/**
 * The run's warm plane for this oracle, or null when the warm path is off: a non-Python runner,
 * `JEVCODE_WARM=off`, a suite command whose interpreter cannot be read off the command itself,
 * or a plane a screen/confirm mismatch has already disabled. Created lazily and kept on the
 * memory beside the lane pool; disposed with it.
 *
 * Exported for `test/unit/jev-modes/synth/sieve/warm-wiring.test.ts`: this is the only production
 * construction site of `WarmPlane`, so the default-on decision, the interpreter it boots and the
 * disabled latch are all decided here and nowhere else.
 */
export function warmPlaneFor(ctx: RunnerContext, mem: Pick<RunnerMemory, 'warm' | 'warmStep'>, oracle: OracleModel, spec: SuiteSpec): WarmScreen | null {
  const mode = warmModeFor(oracle);
  // The interpreter is the word the command names, never a guess: the plane boots that one and
  // `WarmPlane.serve` refuses any command naming another (site-packages are part of a verdict).
  const interpreter = mode === null ? null : interpreterFor(mode, spec.command);
  if (mode === null || interpreter === null) {
    mem.warm?.dispose();
    delete mem.warm;
    // OOS iteration 2, defect 4: `JEVCODE_WARM=on` here is a SILENT no-op — the flag asked for
    // the plane and this oracle has no shape for it. Iteration 2's "18-task warm A/B" was
    // really 14 for exactly this reason (SWE-bench's runner is `other`) and nothing said so, so
    // it is recorded on the step and said once per step in the event stream.
    if (warmRequested()) {
      const why: StepWarmSummary['mode'] = mode === null ? 'unsupported-runner' : 'unsupported-command';
      const first = mem.warmStep?.step !== ctx.step;
      recordWarmStep(mem, ctx.step, emptyStepWarm(why));
      if (first) {
        const what = why === 'unsupported-runner' ? `the \`${oracle.runner}\` runner has no warm shape (only quixbugs and pytest do)` : `the suite command names no interpreter this plane could boot: ${spec.command}`;
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail: `warm: ${WARM_ENV_FLAG}=on but ${what}; every run of this step is cold, and the step's record says warm.mode = ${why}`, candidates: 0, tested: 0 });
      }
    }
    return null;
  }
  const have = mem.warm;
  if (have !== undefined) return have.disabled ? null : have;
  const plane = new WarmPlane({ sandbox: ctx.sandbox, signal: ctx.signal, runDir: ctx.runDir, workspaceRoot: ctx.workspaceInfo.root, mode, interpreter, bootEnv: LANE_RUN_ENV });
  mem.warm = plane;
  return plane;
}

function emptySummary(command: string, actual: string): TestRunSummary {
  return { command, passed: 0, failed: 0, errors: 1, skipped: 0, total: 1, failing: [RUN_FAILURE_ID], passing: [], failures: [{ testId: RUN_FAILURE_ID, call: command, expected: 'the candidate applies and its tests run', actual }], exitCode: null, timedOut: false, durationMs: 0, outputTail: '' };
}

/**
 * Run the verification queue for one goal (§2.3 `runQueue`). Returns one VerifyOutcome per
 * candidate that completed; jobs whose run was aborted by `ctx.signal` or cut short by the
 * step's remaining wall, or deferred because the step already has five passers or no run left,
 * wait in `mem.deferred` under the goal; provisional timeouts wait in `mem.retryTimeouts` (see
 * the module header) and are retried at the end of the batch, at most RETRY_TIMEOUTS_MAX_PER_BATCH
 * of them. Charges the StepBudget (one per run, wall = batch elapsed), records the diff of every
 * finally classified candidate in `mem.tried` (the key D's queue excludes), refines
 * `mem.oracle.tRunMs` from the measured first runs (not the retries: they run at 2 s a case
 * without the stop rule) and emits one `synth` event per batch. A lane failure (a reset that did
 * not restore the lane) stops dispatch; the outcomes already classified are still returned, and
 * the error is thrown only when nothing completed.
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
    // the warm workers' cwd is a lane directory that no longer exists
    mem.warm?.dispose();
    delete mem.warm;
  }
  const pool = mem.lanes ?? (await createLanes(ctx, oracle));
  mem.lanes = pool;
  const warm = warmPlaneFor(ctx, mem, oracle, spec);
  const warmBefore: WarmStats = warm?.stats() ?? emptyWarmStats();
  let scopeUnusable = 0;
  /** latched once a scoped run of this goal reports zero collected tests (see `runGoalSubset`) */
  let scopeIsUnusable = false;
  /** candidates this batch classified on a warm worker and did not confirm cold (see `requeueScreened`) */
  const screenedThisBatch: { job: VerifyJob; diffHash: string }[] = [];
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
  /**
   * §3 M6, the "re-queue the batch cold" half of the screen/confirm rule. A warm verdict that was
   * never confirmed cold is only a screen: once one screened passer has disagreed with its cold
   * confirmation, every other candidate this batch classified warm is suspect too (a false
   * negative silently drops a real fix and marks it `tried`). Their hashes leave `tried` and
   * their jobs go back on the goal's deferred queue, where the now-disabled plane guarantees they
   * run cold at the next call.
   */
  const requeueScreened = (): void => {
    for (const s of screenedThisBatch.splice(0, screenedThisBatch.length)) {
      mem.tried.delete(s.diffHash);
      deferred.push(s.job);
    }
  };
  const retryByGoal = mem.retryTimeouts ?? new Map<string, PendingRetry[]>();
  mem.retryTimeouts = retryByGoal;
  const pendingRetries = retryByGoal.get(goal.id) ?? [];
  retryByGoal.set(goal.id, pendingRetries);
  // provisional timeouts from earlier calls are retried first; those judged against a baseline the
  // memory no longer holds (index.ts re-baselined after a commit) are dropped — not `tried`, so the
  // candidate can be enumerated again on the new base
  const carriedRetries = pendingRetries.splice(0, pendingRetries.length).filter((r) => r.baseline === baseline);
  const pendingHashes = new Set(carriedRetries.map((r) => r.diffHash));
  const scope = subsetScope(oracle, goal);

  const batchStart = now();
  const wallAtStart = budget.testWallLeftMs;
  let dispatched = 0;
  // the passer counter is the step's (RunnerMemory.passersThisStep), so a second call in the same step keeps the cap
  let passers = mem.passersThisStep ?? 0;
  let laneFailure: unknown = null;
  const results: { order: number; outcome: VerifyOutcome }[] = [];
  const subsetDurations: number[] = [];
  /**
   * iteration-2 defect 1: the goal-subset runs a warm worker served, each as the COLD cost it
   * bounds from below (its own duration + `PROCESS_OVERHEAD_MS`). Kept apart from the cold
   * sample because it may only hold or raise `tRunMs`, never lower it — see `sampleRun`.
   */
  const warmSubsetDurations: number[] = [];
  /**
   * Every COLD goal-subset run of the batch, deadline re-runs included — which is exactly what
   * `subsetDurations` held before iteration 2. Read only by the in-flight-timeout rule at the end
   * of the batch, which asks a different question from t_run: not "what does a run of this scope
   * cost?" (for which a run killed at its cap is no answer) but "were the lanes starved while
   * this batch ran?" (for which it is the evidence, and the reason ladder `account` step 18's
   * four killed candidates are re-queued rather than called hangs).
   */
  const coldRunDurations: number[] = [];
  const fullDurations: number[] = [];
  const provisional: { order: number; pending: PendingRetry }[] = [];
  const killed: { order: number; pending: PendingRetry; outcome: VerifyOutcome }[] = [];
  const retried = new Map<VerifyStatus, number>();

  const wallLeft = (): number => wallAtStart - (now() - batchStart);
  // contract 1.9 (Fastlane) §4.4: wall the caller reserved for the passer's confirm run. A run already on a lane may
  // use it (`capMs` below reads `wallLeft`), but no NEW candidate is dispatched into it. 0 for every caller but the
  // fast path, where it is the difference between a confirmed passer and a one-strike disarm.
  const reserveWallMs = Math.max(0, budget.reserveWallMs ?? 0);
  const dispatchWallLeft = (): number => wallLeft() - reserveWallMs;
  // §4.1: the sandbox timeout of a lane run derives from the oracle (the workspace command's
  // timeout tightened to the lane settings), never from a constant
  const laneTimeoutMs = laneRunTimeout(oracle, baseline);
  // a run the remaining wall cannot fit (one measured goal-subset run, or the run timeout when smaller) is not started
  const minRunWallMs = Math.min(laneTimeoutMs, Math.max(1, oracle.tRunMs.goalSubset));
  // A batch begun while the queue streams (an LLM round landing samples, §4.8) ends on its first decisive passer: a
  // `plausible` here has its full-suite run behind it, so the controller can decide over everything that landed and
  // cancel the round's losers the moment the guard commits (§4.2, §6.2) instead of waiting for the slowest sample or
  // its deadline. Runs already on a lane complete and are returned; the jobs still queued wait for the next call.
  const streamed = queue.streaming === true;
  let passerStop = false;
  // workers parked in `queue.next()` are released (null) when dispatch stops: a stop an active worker observed
  // (`released.abort()` in the worker), the step signal, or — the park's own timer — the wall no longer fitting a run
  const released = new AbortController();
  const onAbort = (): void => released.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const stopDispatch = (): boolean =>
    ctx.signal.aborted || laneFailure !== null || passerStop || dispatched >= runsAllowed || budget.testRunsLeft <= 0 || dispatchWallLeft() < minRunWallMs || passers >= MAX_FULL_SUITE_RUNS_PER_STEP;

  // Load awareness: the batch's measured run median against the oracle's estimate; once it
  // exceeds LOAD_SCALE_MIN_RATIO the per-case cap of the rest of the batch follows it (bounded by 2 s)
  const estimateMs = Math.max(1, oracle.tRunMs.goalSubset);
  let loadNow = 1;
  let caseTimeoutNow: number | null = oracle.perTestTimeoutMs;
  /**
   * The batch's measured run cost as a statement about a fresh process: the cold samples when it
   * has any, else the hot ones' lower bounds. Read by the load scaling and the in-flight-timeout
   * rule, both of which only ever act on a ratio ABOVE 1, so a cheap screen can tighten nothing.
   */
  const measuredMedian = (): number | null => median(subsetDurations.length > 0 ? subsetDurations : warmSubsetDurations);

  const observeLoad = (): void => {
    if (oracle.perTestTimeoutMs === null || subsetDurations.length + warmSubsetDurations.length < LOAD_SAMPLE_MIN_RUNS) return;
    const ratio = loadRatio(measuredMedian(), estimateMs);
    if (ratio <= loadNow) return;
    loadNow = ratio;
    caseTimeoutNow = scaledCaseTimeout(oracle.perTestTimeoutMs, ratio);
  };

  /**
   * iteration-2 defect 1 (experiments/results/llm-jev-iter2.md §7.3): where one run of the goal
   * subset goes in the oracle's t_run sample — the COLD sample, the HOT one, or nowhere.
   *
   * Before iteration 2 the rule was "only cold runs teach", which is right when cold is the whole
   * batch and catastrophic when it is not: with the warm plane on, the only candidates that reach
   * the cold path are the ones whose hot screen hit a deadline and was discarded, so the sample
   * became a sample of nothing but timeouts. On the recorded 185-candidate `topological_ordering`
   * batch that taught `run median 11655 ms` where the identical batch measured `510 ms` cold; the
   * estimate sized `laneTimeoutMs`, `minRunWallMs` and the run plan, `runs left` collapsed
   * 1,315 → 16, and four batches later every batch reported `0 tested (nothing ran)`. The task was
   * lost, twice independently, and that is why the plane's default is still off.
   *
   *   * a DEADLINE RE-RUN teaches nothing at all (`recheck`): a timeout is a bound, not a
   *     measurement of the candidate, on either path. This alone is the pass loss.
   *   * a COLD run that was nobody's re-run is the truth, exactly as before.
   *   * a HOT screen is a real run of the same case set under the same per-case cap, so it is
   *     kept — but only as a LOWER BOUND on what the cold run of it would cost (its duration plus
   *     `PROCESS_OVERHEAD_MS`, the harness's own measurement of the process start a screen does
   *     not pay). It may hold or RAISE the estimate, never lower it (see the refine below),
   *     because the
   *     screen skips more than process start: in pytest mode the warm parent has already imported
   *     the suite, and pricing the step's run budget on a screen would send pools to SIEVE that
   *     only the SCREEN can afford while every confirmation is still a cold run
   *     (test/unit/jev-modes/synth/sieve/screen-confirm-budget.test.ts pins that, and it is why the old rule
   *     excluded warm runs outright).
   */
  const sampleRun = (r: Pick<LaneRun, 'durationMs' | 'warm' | 'recheck'>): void => {
    if (!r.warm) coldRunDurations.push(r.durationMs);
    if (r.recheck) return;
    if (r.warm) warmSubsetDurations.push(r.durationMs + PROCESS_OVERHEAD_MS);
    else subsetDurations.push(r.durationMs);
    observeLoad();
  };

  /**
   * The lane settings of one run: the per-case cap (the oracle's, load-scaled, or the retry's full
   * cap) and the stop rule. The retry keeps the stop rule: it asks one question — does the case
   * that alarmed finish at 2 s? — and a genuine hang that reaches it then costs one alarm, not
   * (cases − passed) × 2 s (bitcount: 18 s a retry, sqrt: 12 s; a candidate that hangs on one
   * case is `timeout` with or without the rule, never a base).
   */
  interface RunSettings {
    caseTimeoutMs: number | null;
    stopRule: boolean;
    /** the sandbox timeout of the run when it is not the lane's own (an in-flight timeout's retry) */
    runTimeoutMs?: number;
  }
  const firstRun = (): RunSettings => ({ caseTimeoutMs: caseTimeoutNow, stopRule: true });
  const RETRY: RunSettings = { caseTimeoutMs: RETRY_CASE_TIMEOUT_MS, stopRule: true };
  /** The retry of an in-flight timeout: the cap it ran under, the lane timeout scaled by the load it was killed under. */
  const inFlightRetry = (p: PendingRetry): RunSettings => ({ caseTimeoutMs: caseTimeoutNow === null ? null : p.caseTimeoutMs, stopRule: true, ...(p.runTimeoutMs === undefined ? {} : { runTimeoutMs: p.runTimeoutMs }) });
  /**
   * The measured goal-subset baseline is a reference, not a candidate: it runs at the module's
   * own defaults (2 s a case, no stop rule), like the workspace baseline it stands in for. Under
   * the lane cap it is truncated exactly when the candidates are — the first skew re-check
   * measured LCS's clean lane at a 570 ms cap under 2.6× load, case 3 alarmed, the reference
   * read 3/10 instead of 6/10, and every no-op candidate that finished case 3 was `partial`.
   */
  const REFERENCE: RunSettings = { caseTimeoutMs: DEFAULT_CASE_TIMEOUT_MS, stopRule: false };
  const oracleFor = (s: RunSettings): OracleModel => (s.caseTimeoutMs === oracle.perTestTimeoutMs ? oracle : { ...oracle, perTestTimeoutMs: oracle.perTestTimeoutMs === null ? null : s.caseTimeoutMs });

  /**
   * iteration-2 defect 1, the compounding half (§7.3): the wall ONE HOT SCREEN may spend, which
   * is deliberately not the cold run's cap (`capMs()`, the lane run timeout).
   *
   * A screen that hits a deadline is discarded and the command is re-run cold, so every
   * millisecond it spends past the point where it is still cheaper than the run it replaces is
   * paid TWICE. `topological_ordering` measured this exactly: a candidate whose module import
   * loops is bounded cold by the per-case cap inside each case's own subprocess (~0.5 s) but
   * warm only by the whole-run deadline, so the screen burnt the full 14 s lane cap and the step
   * then paid 14 s more to re-run it cold — 5 candidates a batch, and the step's test wall was
   * gone. The bound here is the lane run timeout's own shape (`laneRunTimeout`) with the cold
   * path's 10 s process-start slack replaced by one per-case cap, because a warm run pays no
   * process start: three times what a run of this scope is estimated to cost, plus room for one
   * slow case to finish under its alarm. Never below MIN_RUN_TIMEOUT_MS (an under-fitted t_run
   * must not deadline every screen) and never above the cold cap the caller would have used.
   *
   * Cutting a screen short can only cost wall, never a verdict: `runTests` re-runs cold every
   * hot run that timed out, whatever the baseline does (see there).
   */
  const screenDeadline = (s: RunSettings, capNow: number): number => {
    const est = Math.max(1, oracle.tRunMs.goalSubset, oracle.tRunMs.fullSuite);
    const byRun = RUN_TIMEOUT_FACTOR * est + (s.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS);
    return Math.max(1, Math.min(capNow, Math.max(MIN_RUN_TIMEOUT_MS, byRun)));
  };

  /**
   * One test run on a lane; a sandbox failure is a run failure, never a pass, and never aborts
   * the batch. `aborted` also covers a kill on a timeout the step's remaining wall cut below the
   * oracle's run timeout: that says nothing about the candidate (it is not a probable infinite
   * loop), so it is deferred and re-run with the full timeout rather than classified `timeout`.
   */
  const runTests = async (command: string, lane: Lane, s: RunSettings, how: { cold?: boolean } = {}): Promise<LaneRun> => {
    const o = oracleFor(s);
    const runTimeoutMs = s.runTimeoutMs ?? (o === oracle ? laneTimeoutMs : laneRunTimeout(o, baseline));
    const capMs = (): number => Math.max(1, Math.min(runTimeoutMs, Math.max(1, wallLeft())));
    const env = laneRunEnv(o, { stopRule: s.stopRule });
    // set when a hot screen of this command was discarded on a deadline: the cold run below is
    // then a re-run, and a re-run's duration never teaches the oracle (see `LaneRun.recheck`)
    let recheck = false;
    // §3 M6: the warm plane screens; it never decides. A null here (command not servable, plane
    // disabled, worker anomaly) is the cold path below, unchanged.
    if (how.cold !== true && warm !== null) {
      const warmStarted = now();
      const cap = capMs();
      const hot = await warm.serve(lane, command, screenDeadline(s, cap), env);
      if (hot !== null) {
        const sum = summarize(command, hot, hot.durationMs > 0 ? hot.durationMs : now() - warmStarted);
        // A deadline is the one thing the two paths cannot be made to mean exactly the same
        // (the cold cap includes process start; the worker subtracts a *measured* estimate of
        // it, which is an estimate) — and since iteration 2 the screen's wall is deliberately
        // TIGHTER than the cold run's (`screenDeadline`), so a hot run killed on that wall says
        // nothing about the candidate at all. Either way a timed-out screen is not a verdict:
        // it is discarded and the command runs cold, which is what decides. Without this the
        // sieve would mark a candidate `tried` on a timeout the cold path never saw, and a
        // non-passer is never cold-confirmed by screen/confirm. (Before iteration 2 the test
        // was `newDeadlineHit` alone, which accepts a whole-run kill whenever the BASELINE is
        // killed too — sound at the cold cap, wrong at a tightened screen bound.)
        if (!sum.timedOut && !newDeadlineHit(sum, baseline)) return { ...sum, aborted: ctx.signal.aborted, warm: true, recheck: false };
        // the step's own remaining wall cut the run short: a cold re-run has no room either, so
        // the job is deferred exactly as a wall-cut cold run is (unchanged from iteration 1)
        if (sum.timedOut && !newDeadlineHit(sum, baseline) && cap < runTimeoutMs) return { ...sum, aborted: true, warm: true, recheck: false };
        warm.deadlineRecheck();
        recheck = true;
      }
    }
    const timeoutMs = capMs();
    const truncated = timeoutMs < runTimeoutMs;
    const started = now();
    try {
      const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: RUN_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir, env });
      const sum = summarize(command, res, res.durationMs > 0 ? res.durationMs : now() - started);
      const wallCut = truncated && res.killedBy === 'timeout';
      return { ...sum, aborted: res.killedBy === 'abort' || res.killedBy === 'wall_time' || wallCut || ctx.signal.aborted, warm: false, recheck };
    } catch (e: unknown) {
      const sum = summarize(command, { stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: null }, now() - started);
      return { ...sum, aborted: ctx.signal.aborted, warm: false, recheck };
    }
  };

  /**
   * The goal-subset run, with the scope-usability guard (§6 S1, risks R-11 / R-14): a scoped run
   * that collected nothing is not evidence — "0 failing" on an empty run reads as success — so it
   * is re-run at full scope, `scope_unusable` is recorded, and the caller compares the result
   * with the base's full summary instead of the file-restricted one.
   */
  const runGoalSubset = async (lane: Lane, s: RunSettings): Promise<LaneRun & { fullScope: boolean }> => {
    const wide = async (): Promise<LaneRun & { fullScope: boolean }> => {
      const w = await runTests(fullSuiteCommand(oracleFor(s), lane, spec), lane, s);
      return { ...w, fullScope: !w.aborted };
    };
    // Latched for the rest of the batch: this goal's scope collects nothing on this suite, so
    // every later candidate runs the full suite too. Without the latch a candidate whose scoped
    // run happened to collect something would be compared with the FULL baseline the first
    // widening cached, and read as a mass regression.
    if (scope.kind === 'files' && scopeIsUnusable) return wide();
    const first = await runTests(subsetCommand(oracleFor(s), goal, lane, spec), lane, s);
    if (scope.kind !== 'files' || first.aborted || first.timedOut || scopeUsable(first)) return { ...first, fullScope: scope.kind === 'full' };
    scopeIsUnusable = true;
    scopeUnusable += 1;
    warm?.scopeUnusable();
    if (budget.testRunsLeft <= 0) return { ...first, fullScope: false };
    budget.testRunsLeft -= 1;
    return wide();
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
    const s = await runGoalSubset(lane, REFERENCE);
    if (s.aborted) return 'defer';
    // an unusable scope makes the reference the full suite: the base's own summary already is that
    const measured = s.fullScope ? job.base.summary : s;
    subsetBaselines.set(key, measured);
    return measured;
  };

  /**
   * One candidate on one lane: apply, goal-subset run, full-suite run for a passer, classify.
   * `retry` re-runs a provisional timeout at the full cap without the stop rule; its verdict is
   * final. A first run whose `timeout` is provisional returns 'provisional' and is not `tried`.
   */
  const verifyJob = async (job: VerifyJob, lane: Lane, mode: 'first' | 'retry', retryOf?: PendingRetry): Promise<JobResult> => {
    let applied: AppliedCandidate;
    try {
      applied = applyCandidate(job.candidate, job.base.files);
    } catch (e: unknown) {
      return applyFailed(job, { candidate: job.candidate, files: [], diff: '' }, e);
    }
    const diffHash = sha12(applied.diff);
    // a re-enumerated copy of a candidate whose retry is pending: the retry decides, not another first run
    if (mode === 'first' && pendingHashes.has(diffHash)) return { kind: 'skip' };
    const subsetBase = await subsetBaselineFor(job, lane);
    if (subsetBase === 'defer') return { kind: 'defer' };
    try {
      await pool.applyToLane(lane, applied, job.base.files);
    } catch (e: unknown) {
      return applyFailed(job, applied, e);
    }
    if (budget.testRunsLeft <= 0) return { kind: 'defer' };
    budget.testRunsLeft -= 1;
    const settings = mode === 'retry' ? (retryOf?.runTimeoutMs === undefined ? RETRY : inFlightRetry(retryOf)) : firstRun();
    const sub = await runGoalSubset(lane, settings);
    if (sub.aborted) return { kind: 'defer' };
    let subsetRun: TestRunSummary = sub;
    let screened = sub.warm;
    // an unusable scope widened the run to the whole suite: compare it with the base's own summary
    const base = sub.fullScope && scope.kind === 'files' ? job.base.summary : subsetBase;
    const subsetIsFull = scope.kind === 'full' || sub.fullScope;
    // `tRunMs` sizes lane timeouts, `minRunWallMs`, the SIEVE/RANK plan and the load scaling, all
    // of which are statements about a FRESH PROCESS: `sampleRun` decides what this run may say
    // about one. Keeping the estimate cold is also what reserves enough remaining wall for the
    // cold confirmation of a passer found late in a batch.
    if (mode === 'first') sampleRun(sub);
    const subsetProgress = progress(base, subsetRun);
    const passesGoal = goalPasses(goal, subsetRun, subsetProgress);

    let full: TestRunSummary | undefined;
    let fullProgress: Progress | undefined;
    if (passesGoal) {
      if (subsetIsFull) {
        // the subset already was the whole suite: the run is spent and decides, whatever the passer count
        // (the cap of §4.3 bounds full-suite runs; here there is none to bound, and tests are the oracle)
        passers += 1;
        full = subsetRun;
      } else {
        if (passers >= MAX_FULL_SUITE_RUNS_PER_STEP || budget.testRunsLeft <= 0) return { kind: 'defer' };
        passers += 1;
        budget.testRunsLeft -= 1;
        const f = await runTests(fullSuiteCommand(oracleFor(settings), lane, spec), lane, settings);
        if (f.aborted) {
          passers -= 1;
          return { kind: 'defer' };
        }
        if (mode === 'first' && !f.warm && !f.recheck) fullDurations.push(f.durationMs);
        screened = screened || f.warm;
        full = f;
      }
      fullProgress = progress(job.base.summary, full);
    }
    let status = classifyOutcome({ subset: subsetRun, subsetProgress, passesGoal, ...(full !== undefined ? { full } : {}), ...(fullProgress !== undefined ? { fullProgress } : {}) });
    let confirmedCold = false;
    // ------------------------------------------------------------------------------------
    // §3 M6: screen hot, confirm COLD. A passer any part of which was produced on a warm worker
    // is re-verified by a fresh, isolated, cold full-suite run before it can reach
    // search/guard.ts decide(). The confirmation is never skipped — when the budget cannot hold
    // it the candidate is deferred, exactly as a missing full-suite run is — and nothing is
    // asked of Jev here: the tests are the oracle and the disagreement rule is arithmetic.
    // ------------------------------------------------------------------------------------
    if (status === 'plausible' && screened) {
      if (budget.testRunsLeft <= 0) {
        passers -= 1;
        return { kind: 'defer' };
      }
      budget.testRunsLeft -= 1;
      const cold = await runTests(fullSuiteCommand(oracleFor(settings), lane, spec), lane, settings, { cold: true });
      if (cold.aborted) {
        passers -= 1;
        return { kind: 'defer' };
      }
      warm?.confirmed(cold.durationMs);
      // a real cold full-suite measurement: exactly what `tRunMs.fullSuite` is
      if (mode === 'first') fullDurations.push(cold.durationMs);
      const coldProgress = progress(job.base.summary, cold);
      const coldPasses = goalPasses(goal, cold, coldProgress);
      const coldStatus = classifyOutcome({ subset: cold, subsetProgress: coldProgress, passesGoal: coldPasses, full: cold, fullProgress: coldProgress });
      full = cold;
      fullProgress = coldProgress;
      status = coldStatus;
      confirmedCold = true;
      // when the subset run WAS the whole suite, the cold confirmation replaces it outright:
      // what reaches guard.ts decide() (which re-checks `subset` in `isPlausible`) is then cold
      // end to end, not a warm screen carried alongside a cold verdict
      if (subsetIsFull) subsetRun = cold;
      if (coldStatus !== 'plausible') {
        // the warm pass the cap was spent on is disowned: it must not consume one of the step's
        // MAX_FULL_SUITE_RUNS_PER_STEP passers, nor feed stopDispatch()
        passers -= 1;
        // one disagreement ends the mechanism for the whole run and re-queues what it classified
        warm?.mismatch();
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail: `${goal.id}: screen:mismatch — a hot-screened passer at ${applied.candidate.site.file.path}:${applied.candidate.site.line} came back ${coldStatus} cold; the warm plane is off for the run and its batch re-runs cold`, candidates: 1, tested: 1 });
        requeueScreened();
      }
    }
    const outcome: VerifyOutcome = { job, applied, subset: subsetRun, progress: fullProgress ?? subsetProgress, status, ...(full !== undefined ? { full } : {}), ...(screened ? { screened: true } : {}), ...(confirmedCold ? { confirmedCold: true } : {}) };
    if (status === 'timeout' && mode === 'first') {
      // which run hung: the full suite of a subset passer, else the subset
      const hung = full !== undefined && (full.timedOut || hangsOnEveryFailure(full)) ? { run: full, base: job.base.summary } : { run: subsetRun, base };
      if (hung.run.timedOut) {
        // the sandbox killed the run at the lane timeout: a hang, unless the whole batch was killed under load (the batch end decides; `tried` waits)
        return { kind: 'killed', pending: { job, applied, diffHash, subset: hung.run, caseTimeoutMs: settings.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS, baseline }, outcome };
      }
      if (settings.caseTimeoutMs !== null) {
        const kind = timeoutKind({ run: hung.run, base: hung.base, runner: oracle.runner, caseTimeoutMs: settings.caseTimeoutMs, loadRatio: loadNow });
        if (kind === 'provisional') return { kind: 'provisional', pending: { job, applied, diffHash, subset: hung.run, caseTimeoutMs: settings.caseTimeoutMs, baseline } };
      }
    }
    // a warm verdict nothing cold confirmed is only a screen: recorded so that one screen/confirm
    // disagreement anywhere in the batch can withdraw it (`requeueScreened`) — in retry mode too,
    // where a withdrawn classification is just as wrong as in first mode
    if (screened && !confirmedCold) screenedThisBatch.push({ job, diffHash });
    mem.tried.add(diffHash); // only a finally classified candidate is "tried"; a deferred or provisional one runs again
    if (status === 'unchanged') recordUnchanged(mem, goal.id, diffHash); // stale once a progress commit changes what the goal's tests fail on
    if (mode === 'retry') retried.set(status, (retried.get(status) ?? 0) + 1);
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
      let job = carried.shift() ?? queue.pop(1)[0];
      // a streaming queue (an LLM round landing samples): park until the next job or the close, released early when dispatch stops or the wall runs down (§4.8)
      if (job === undefined) job = await awaitNextJob(queue, released.signal, dispatchWallLeft() - minRunWallMs);
      if (job === undefined) return;
      const order = dispatched;
      dispatched += 1;
      let r: JobResult;
      try {
        r = await pool.withLane((lane) => verifyJob(job, lane, 'first'));
      } catch (e: unknown) {
        // the lane could not be prepared or restored (a failing git reset, an aborted sandbox):
        // the job is not lost, no more work is dispatched, and the batch's outcomes still count
        laneFailure = e;
        r = { kind: 'defer' };
      }
      if (r.kind === 'defer') deferred.push(job);
      else if (r.kind === 'provisional') provisional.push({ order, pending: r.pending });
      else if (r.kind === 'killed') killed.push({ order, pending: r.pending, outcome: r.outcome });
      else if (r.kind === 'outcome') {
        results.push({ order, outcome: r.outcome });
        if (streamed && r.outcome.status === 'plausible') passerStop = true;
      }
      // a worker that sees dispatch stopped (this passer, the cap, the runs, a lane failure) releases the parked ones
      if (stopDispatch()) released.abort();
    }
  };
  const workers = Math.max(1, Math.min(pool.lanes.length, oracle.lanes));
  try {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
  // carried jobs that dispatch never reached stay first in line
  deferred.unshift(...carried);

  // In-flight timeouts (module header): every classified run of the batch killed at the lane
  // timeout, at least IN_FLIGHT_RETRY_MIN_RUNS of them, under a measured load — the verdicts
  // are provisional and the candidates wait in mem.retryTimeouts for the next call for the goal
  // (not `tried`), to run once more with the lane timeout scaled by that load. Otherwise every
  // killed run is the candidate's own hang: classified, tried.
  // unchanged from iteration 1: the starvation question, asked of every cold run this batch made
  const loadAtEnd = loadRatio(median(coldRunDurations), estimateMs);
  const inFlight = results.length === 0 && killed.length >= IN_FLIGHT_RETRY_MIN_RUNS && loadAtEnd >= LOAD_SCALE_MIN_RATIO;
  const inFlightTimeoutMs = Math.round(laneTimeoutMs * Math.min(Math.max(1, loadAtEnd), IN_FLIGHT_RETRY_TIMEOUT_FACTOR));
  // in dispatch order (the lanes complete in any order), so the retries keep the queue's ranking
  for (const k of [...killed].sort((a, b) => a.order - b.order)) {
    if (inFlight) pendingRetries.push({ ...k.pending, runTimeoutMs: inFlightTimeoutMs });
    else {
      mem.tried.add(k.pending.diffHash);
      results.push({ order: k.order, outcome: k.outcome });
    }
  }

  // The retry phase: provisional timeouts of earlier calls first, then this batch's, at most
  // RETRY_TIMEOUTS_MAX_PER_BATCH; the rest (and any retry the wall or the signal cut short) wait
  // in mem.retryTimeouts for the next call. Retries are re-runs of dispatched candidates: they
  // charge the budget, not `runsAllowed`.
  const retryQueue: { order: number; pending: PendingRetry }[] = [...carriedRetries.map((pending, i) => ({ order: -carriedRetries.length + i, pending })), ...provisional];
  const provisionalCount = retryQueue.length;
  const toRetry = retryQueue.splice(0, RETRY_TIMEOUTS_MAX_PER_BATCH);
  const stopRetry = (): boolean => ctx.signal.aborted || laneFailure !== null || budget.testRunsLeft <= 0 || dispatchWallLeft() < minRunWallMs;
  const retryWorker = async (): Promise<void> => {
    while (!stopRetry()) {
      const next = toRetry.shift();
      if (next === undefined) return;
      let r: JobResult;
      try {
        r = await pool.withLane((lane) => verifyJob(next.pending.job, lane, 'retry', next.pending));
      } catch (e: unknown) {
        laneFailure = e;
        r = { kind: 'defer' };
      }
      if (r.kind === 'outcome') results.push({ order: next.order, outcome: r.outcome });
      else pendingRetries.push(next.pending);
    }
  };
  if (toRetry.length > 0) await Promise.all(Array.from({ length: workers }, () => retryWorker()));
  // whatever the retry phase did not reach waits for the next call, in order
  pendingRetries.unshift(...toRetry.map((r) => r.pending));
  pendingRetries.push(...retryQueue.map((r) => r.pending));
  mem.passersThisStep = passers;

  budget.testWallLeftMs = Math.max(0, wallAtStart - (now() - batchStart));
  // the oracle learns the measured cost of this goal's subset and of the full suite (§4.1: t_run per
  // scope); the subset's, which §2.4 reads, keeps a sieve-eligible estimate through a load spike (`refineTRun`)
  const subsetMed = median(subsetDurations);
  const warmMed = median(warmSubsetDurations);
  if (subsetMed !== null && subsetMed > 0) oracle.tRunMs.goalSubset = refineTRun(oracle.tRunMs.goalSubset, subsetMed);
  // iteration-2 defect 1: with the plane on a whole batch can be hot. Its lower bounds may raise
  // the estimate (the lanes really are slow) but never lower it, so a step's run budget is still
  // priced on what a cold run costs — and, crucially, NOT on the deadline re-runs that used to be
  // the only cold samples such a batch produced.
  else if (warmMed !== null && warmMed > oracle.tRunMs.goalSubset) oracle.tRunMs.goalSubset = refineTRun(oracle.tRunMs.goalSubset, warmMed);
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
  // a hot-only batch says so: its median is a lower bound on a cold run, not a measurement of one
  const medNote = subsetMed !== null ? `run median ${Math.round(subsetMed)} ms` : warmMed !== null ? `run median ≥ ${Math.round(warmMed)} ms hot` : null;
  const timing = medNote === null ? '' : `; ${medNote}, t_run ${oracle.tRunMs.goalSubset} ms${oracle.lanes === lanesBefore ? '' : `, lanes ${lanesBefore} → ${oracle.lanes}`}`;
  const retriedCount = [...retried.values()].reduce((a, b) => a + b, 0);
  const retryNote =
    provisionalCount === 0
      ? ''
      : `; ${provisionalCount} provisional timeout${provisionalCount === 1 ? '' : 's'}: ${retriedCount} retried at ${RETRY_CASE_TIMEOUT_MS} ms${retriedCount > 0 ? ` (${[...retried.entries()].map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}, ${pendingRetries.length} pending`;
  const loadNote = caseTimeoutNow === oracle.perTestTimeoutMs || oracle.perTestTimeoutMs === null ? '' : `; load ×${loadNow.toFixed(1)}, case timeout ${oracle.perTestTimeoutMs}→${caseTimeoutNow} ms`;
  const inFlightNote = inFlight ? `; ${killed.length} in-flight timeout${killed.length === 1 ? '' : 's'} under load ×${loadAtEnd.toFixed(1)}: re-queued once, lane timeout ${laneTimeoutMs}→${inFlightTimeoutMs} ms` : '';
  const streamNote = passerStop ? '; streamed batch ended on its first passer' : '';
  const warmStats: WarmStats = { ...(warm === null ? emptyWarmStats() : warmDelta(warmBefore, warm.stats())), scopeUnusable };
  // OOS iteration 2, defect 2: the counters go on the step's record, not only into the free text
  // below — `--archive-runs` does not copy `transcript.log`, so until now no committed artefact
  // carried them and the warm A/B could not be audited from the results directory at all.
  if (warm !== null) recordWarmStep(mem, ctx.step, stepWarmFrom('on', warmStats));
  const detail = `${goal.id}: ${outcomes.length} tested on ${workers} lane${workers === 1 ? '' : 's'} (${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing ran'}); runs left ${budget.testRunsLeft}, test wall left ${Math.round(budget.testWallLeftMs / 1000)} s${timing}${loadNote}${inFlightNote}${retryNote}${streamNote}${warmNote(warmStats)}${ctx.signal.aborted ? '; aborted' : ''}${failureNote}`;
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail, candidates: dispatched, tested: outcomes.length });
  // a broken lane with nothing to show for the batch is an error the step must see; on abort the caller is stopping anyway
  if (laneFailure !== null && outcomes.length === 0 && !ctx.signal.aborted) throw new RunnerError(`lane failure during ${goal.id}: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`, { cause: laneFailure });
  return outcomes;
}

// ---------------------------------------------------------------------------------------
// The regression run of a progress commit (search/subgoal.ts commitProgress)
// ---------------------------------------------------------------------------------------

/**
 * One full-suite run of a `partial` on a free lane. `verifyJob` classifies a partial from its
 * goal-subset run alone — the full suite runs only for subset passers — so "newly passing goal
 * tests and nothing newly failing anywhere" is not yet a measured fact about a partial (a
 * variant of ladder `shared_frame`'s helper relaxation that passes 3 of the goal's 6 booking
 * tests and breaks `tests/test_checks.py` is a `partial` to the batch); this run makes it one
 * before the partial is committed. The candidate is applied over its own base's files (an
 * improved-base partial carries that base's edits), the command is the baseline's full-suite
 * command at the reference settings of `runQueue` (every case's verdict, the module's default
 * per-case cap, no stop rule) under the lane timeout, and the run is charged to the step budget
 * as one run — the commit's verification, not search cost, so it runs at a budget exit too.
 * Returns null when no lane pool exists (nothing ran this step, so nothing was held either),
 * when the run was aborted, or when the lane could not be prepared; a run the sandbox killed at
 * the lane timeout comes back `timedOut` for the caller to read. Never throws.
 */
export async function runRegressionCheck(ctx: RunnerContext, mem: RunnerMemory, goal: Pick<Goal, 'id'>, o: VerifyOutcome, opts: RunQueueOptions = {}): Promise<TestRunSummary | null> {
  const baseline = mem.baseline;
  const pool = mem.lanes;
  if (baseline === null || pool === undefined || ctx.signal.aborted) return null;
  const now = opts.now ?? Date.now;
  const oracle = mem.oracle;
  const budget = mem.stepBudget;
  const spec: SuiteSpec = { command: baseline.command, workspaceRoot: ctx.workspaceInfo.root };
  // the reference settings: the module's own per-case cap, every case's verdict (no stop rule)
  const reference: OracleModel = oracle.perTestTimeoutMs === null ? oracle : { ...oracle, perTestTimeoutMs: DEFAULT_CASE_TIMEOUT_MS };
  const timeoutMs = laneRunTimeout(reference, baseline);
  const started = now();
  let result: TestRunSummary | null = null;
  let failure = '';
  try {
    result = await pool.withLane(async (lane) => {
      await pool.applyToLane(lane, o.applied, o.job.base.files);
      const command = fullSuiteCommand(reference, lane, spec);
      const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: RUN_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir, env: laneRunEnv(reference, { stopRule: false }) });
      if (res.killedBy === 'abort' || res.killedBy === 'wall_time' || ctx.signal.aborted) return null;
      return summarize(command, res, res.durationMs > 0 ? res.durationMs : now() - started);
    });
  } catch (e: unknown) {
    failure = e instanceof Error ? e.message : String(e);
    result = null;
  }
  const elapsed = now() - started;
  budget.testRunsLeft = Math.max(0, budget.testRunsLeft - 1);
  budget.testWallLeftMs = Math.max(0, budget.testWallLeftMs - elapsed);
  const c = o.applied.candidate;
  const what = result === null ? (failure === '' ? 'aborted' : `lane failure: ${failure}`) : `${result.passed}/${result.total} pass, ${result.failed} failed, ${result.errors} errors${result.timedOut ? ', timed out' : ''} in ${result.durationMs} ms`;
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail: `${goal.id}: full-suite regression run of the held partial ${c.source}/${c.op} at ${c.site.file.path}:${c.site.line}: ${what}`, candidates: 1, tested: result === null ? 0 : 1 });
  return result;
}
