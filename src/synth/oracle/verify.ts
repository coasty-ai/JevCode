/**
 * Candidate verification on a repository workspace (docs/JEV-ONLY-DESIGN.md §4.2 lanes, §4.3
 * caps): the sieve's goal-subset run is the reproduction script (`verifyRepro`, ≈ 1 s) and the
 * full-suite regression run is the scoped command (`chooseRegressionScope`, ≤ 6 test files),
 * both on git worktree lanes, never in the workspace. Without a reproduction (the best-guess
 * goal) only the regression run is made, and "plausible" means "nothing newly failing".
 *
 * Why not sieve/runner.ts: that runner is built around a test command whose output the
 * verifier's parsers read, with per-case timeouts for the QuixBugs runners; the reproduction's
 * verdict is code over a sentinel JSON line, the scoped suite runs at the module's own defaults
 * and the lane needs `PYTHONPATH` pointed at itself (editable installs of the workspace package
 * otherwise resolve to the workspace, not the lane). The contract is the runner's: pop jobs,
 * honour the StepBudget (runs and wall) and `ctx.signal`, mark classified diffs `tried`, defer
 * what did not finish under `mem.deferred`, refine t_run, emit one `verify` event per batch.
 *
 * Two rules measured on SWE-bench rung 3 (experiments/results/jev-only-rungs-1-2.md §21.4, §21.6):
 *
 * - **A lane pass is confirmed before it is a `plausible`.** django-15315's reproduction is a
 *   1/8 coin even under `PYTHONHASHSEED=0` (`hash(None)` is address-based on the venv's CPython
 *   3.9: 13 fail / 3 pass in 16 runs of the runner's own command), so one lane run of it made
 *   dead code after a `return` a "passer" 20 times in 167 runs and filled the passer cap with
 *   nothing four steps running. A candidate whose reproduction passes is re-run once in the same
 *   lane; only pass/pass goes on to the scoped regression run and can be `plausible`. Pass/fail is
 *   *unstable*: classified `unchanged` for the guard (the shared `VerifyStatus` has no other
 *   word for "not a fix"), marked `tried`, never dispatched to the regression run, its subset
 *   failure text prefixed `UNSTABLE_ACTUAL_PREFIX`, and counted as `unstable` in the batch's
 *   `verify` event. Under a stable oracle the rule costs one cheap reproduction per passer
 *   (≤ 5 per step); under a coin oracle it turns a 1/8 false-pass rate into 1/64.
 *
 * - **Rank order, and the top-ranked candidate first.** sympy-19954 (rung 3, §21.6 item 2): with
 *   two sympy tasks sharing the machine the scoped run took 72–82 s against an 11 s idle
 *   baseline, one or two regression runs consumed each step's wall, and the jobs deferred by the
 *   wall were re-dispatched *before* the step's fresh ranking — so at step 17 the candidate Jev
 *   ranked first (the known fix) was queued behind five carried passers and never ran. Carried
 *   and fresh jobs are now dispatched in rank order (`VerifyJob.key` descending, ties to the
 *   carried job so the earlier ranking keeps its place); the regression slots go to passers in
 *   rank order too — a passer takes a slot only when the slots left exceed the higher-ranked
 *   jobs still awaiting their reproduction verdict, and waits on its lane for them otherwise
 *   (one reproduction's time) — so what the passer cap defers is the lowest-ranked passers,
 *   never the #1; and the top job's runs are not cut by the step's wall (a step may overrun its
 *   caps by one in-flight run, §4.3). The lanes' recent run times feed the load-aware step
 *   sizing (`runSamplesOf`, budget.ts `applyLiveTRun`).
 */
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha12 } from '../../core/hash.js';
import { applyLiveTRun, emptyRunSamples, recordRunSamples, refineTRun } from '../search/budget.js';
import type { RunSamples } from '../search/budget.js';
import type { Goal, Lane, VerifyJob, VerifyOutcome, VerifyStatus } from '../search/types.js';
import { createLanes } from '../sieve/lanes.js';
import type { JobQueue, RunnerContext, RunnerMemory } from '../sieve/runner.js';
import { MAX_FULL_SUITE_RUNS_PER_STEP, RUN_OUTPUT_BYTES, awaitNextJob } from '../sieve/runner.js';
import type { AppliedCandidate, Progress, TestRunSummary } from '../types.js';
import { applyCandidate } from '../verify/apply.js';
import { summarize } from '../verify/index.js';
import { progress } from '../verify/progress.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import type { VerifyRunFn } from '../verify/types.js';
import { verifyRepro } from './goal.js';
import type { ReproSpec, VerifyReproResult } from './goal.js';
import { INSTALL_GENERATED_FILES, mergeSummaries, scopedPartOf } from './search.js';

export interface RepositoryQueueOptions {
  /** the reproduction to pass first; null = regression only (a best-guess goal) */
  spec: ReproSpec | null;
  /** the scoped command (workspace-relative paths; runs with cwd = lane) and its timeout; null command = no regression check possible */
  regression: { command: string | null; timeoutMs: number };
  /** the workspace venv's interpreter for the reproduction; the runner picks otherwise */
  python?: string;
  now?: () => number;
}

/**
 * Prefix of the subset failure text of an unstable candidate (passed the reproduction once,
 * failed the confirmation run): the outcome's status is `unchanged`, this is how it is told apart.
 */
export const UNSTABLE_ACTUAL_PREFIX = 'unstable:';

/** Whether an outcome is the unstable pass/fail of a candidate (never a fix, never regression-tested). */
export function isUnstableOutcome(o: Pick<VerifyOutcome, 'status' | 'subset'>): boolean {
  return o.status === 'unchanged' && o.subset.failures.some((f) => f.actual.startsWith(UNSTABLE_ACTUAL_PREFIX));
}

/**
 * Rank order of two jobs: negative when `a` ranks higher. `VerifyJob.key` descending — the
 * base's passing count, then the Noul/Choice p (RANK) or the source prior (SIEVE), then the
 * source prior — the same order sieve/queue.ts pops in.
 */
export function compareRank(a: Pick<VerifyJob, 'key'>, b: Pick<VerifyJob, 'key'>): number {
  for (let i = 0; i < 3; i++) {
    const d = (b.key[i] ?? 0) - (a.key[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The lanes' recent run times per runner memory (they outlive the step budget and the re-baselined oracle model). */
const RUN_SAMPLES = new WeakMap<RunnerMemory, RunSamples>();

/** The running measurements this runner recorded for `mem` (budget.ts `RunSamples`); empty until a batch ran. */
export function runSamplesOf(mem: RunnerMemory): RunSamples {
  let s = RUN_SAMPLES.get(mem);
  if (s === undefined) {
    s = emptyRunSamples();
    RUN_SAMPLES.set(mem, s);
  }
  return s;
}

/** Lane environment: no bytecode (sieve/runner.ts LANE_RUN_ENV) and the lane first on the module path. */
export function laneEnv(lane: Lane, hasSrc: boolean): Record<string, string> {
  const paths = hasSrc ? [join(lane.dir, 'src'), lane.dir] : [lane.dir];
  return { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: paths.join(':') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Copy the install-generated files the workspace has and the lane lacks (INSTALL_GENERATED_FILES). */
export async function restoreGeneratedFiles(root: string, lane: Lane): Promise<string[]> {
  if (lane.dir === root) return [];
  const copied: string[] = [];
  for (const rel of INSTALL_GENERATED_FILES) {
    const src = join(root, rel);
    const dst = join(lane.dir, rel);
    if (!(await exists(src)) || (await exists(dst))) continue;
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied.push(rel);
  }
  return copied;
}

function runFailure(command: string, actual: string): TestRunSummary {
  return { command, passed: 0, failed: 0, errors: 1, skipped: 0, total: 1, failing: [RUN_FAILURE_ID], passing: [], failures: [{ testId: RUN_FAILURE_ID, call: command, expected: 'the candidate applies and its tests run', actual }], exitCode: null, timedOut: false, durationMs: 0, outputTail: '' };
}

/** The confirmation run's failing summary, its failure text saying what happened on the first run. */
function unstableSummary(first: VerifyReproResult, again: VerifyReproResult): TestRunSummary {
  const note = `${UNSTABLE_ACTUAL_PREFIX} passed once (${first.verdict.actual.slice(0, 60)}), failed the confirmation run in the same lane: `;
  return { ...again.summary, failures: again.summary.failures.map((f) => ({ ...f, actual: `${note}${f.actual}`.slice(0, 400) })) };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Insert `job` into `sorted` (rank order) after every job that ranks at least as high. */
function insertByRank(sorted: VerifyJob[], job: VerifyJob): void {
  let i = 0;
  while (i < sorted.length && compareRank(sorted[i]!, job) <= 0) i++;
  sorted.splice(i, 0, job);
}

type JobResult = { kind: 'outcome'; outcome: VerifyOutcome } | { kind: 'defer' };

/**
 * Run the verification queue for one goal on a repository workspace. Returns one VerifyOutcome
 * per candidate that completed; deferred jobs wait under `mem.deferred[goal.id]`.
 */
export async function runRepositoryQueue(ctx: RunnerContext, mem: RunnerMemory, queue: JobQueue, goal: Goal, runsAllowed: number, opts: RepositoryQueueOptions): Promise<VerifyOutcome[]> {
  const baseline = mem.baseline;
  if (baseline === null) throw new Error('runRepositoryQueue needs a baseline run');
  const now = opts.now ?? Date.now;
  const oracle = mem.oracle;
  const budget = mem.stepBudget;
  const root = ctx.workspaceInfo.root;
  if (mem.lanes !== undefined && mem.lanes.mode !== 'inplace' && mem.lanes.lanes.length < oracle.lanes) {
    await mem.lanes.disposeLanes();
    delete mem.lanes;
  }
  const pool = mem.lanes ?? (await createLanes(ctx, oracle));
  mem.lanes = pool;
  const deferredByGoal = mem.deferred ?? new Map<string, VerifyJob[]>();
  mem.deferred = deferredByGoal;
  const deferred = deferredByGoal.get(goal.id) ?? [];
  deferredByGoal.set(goal.id, deferred);
  // carried jobs in rank order; fresh jobs are merged into them by rank as they are popped
  const carried = deferred.splice(0, deferred.length).sort(compareRank);
  const hasSrc = await exists(join(root, 'src'));

  const batchStart = now();
  const wallAtStart = budget.testWallLeftMs;
  const wallLeft = (): number => wallAtStart - (now() - batchStart);
  const reproTimeoutMs = opts.spec?.options.timeoutMs ?? 30_000;
  const minRunWallMs = Math.min(reproTimeoutMs, Math.max(1, oracle.tRunMs.goalSubset));
  let dispatched = 0;
  // the passer cap is the step's (RunnerMemory.passersThisStep, docs/LLM-JEV-DESIGN.md §4.8): a second call this step keeps counting
  let passers = mem.passersThisStep ?? 0;
  let unstable = 0;
  /** dispatch orders (= ranks within this call) whose reproduction verdict is not in yet */
  const pending = new Set<number>();
  let settleWaiters: (() => void)[] = [];
  const settle = (order: number): void => {
    if (!pending.delete(order)) return;
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const wake of waiters) wake();
  };
  const nextSettle = (): Promise<void> => new Promise<void>((resolve) => settleWaiters.push(resolve));
  /** higher-ranked jobs still awaiting their verdict: slots they may yet claim ahead of `order` */
  const pendingHigher = (order: number): number => {
    let n = 0;
    for (const o of pending) if (o < order) n += 1;
    return n;
  };
  let laneFailure: unknown = null;
  const results: { order: number; outcome: VerifyOutcome }[] = [];
  const reproDurations: number[] = [];
  const regressionDurations: number[] = [];
  // a batch begun while the queue streams ends on its first decisive passer (sieve/runner.ts `JobQueue.streaming`): a
  // `plausible` here passed the reproduction twice and its scoped regression, so the controller decides at once and
  // cancels the round's losers on the commit; runs already on a lane complete, the jobs still queued wait
  const streamed = queue.streaming === true;
  let passerStop = false;
  // workers parked in `queue.next()` are released when dispatch stops (an active worker's observation, the step signal) or the wall runs down (the park's timer)
  const released = new AbortController();
  const onAbort = (): void => released.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const stopDispatch = (): boolean =>
    ctx.signal.aborted || laneFailure !== null || passerStop || dispatched >= runsAllowed || budget.testRunsLeft <= 0 || wallLeft() < minRunWallMs || passers >= MAX_FULL_SUITE_RUNS_PER_STEP;
  const chargeRun = (): void => {
    budget.testRunsLeft = Math.max(0, budget.testRunsLeft - 1);
  };
  /**
   * Rank-ordered admission to the passer cap: a passer takes a regression slot when the slots
   * left exceed the higher-ranked jobs still pending (they may pass too and rank first), waits
   * while they settle, and is deferred once the cap is reached — so the deferred passers are the
   * lowest-ranked ones and the top-ranked passer always runs. Returns false to defer.
   */
  const admitPasser = async (order: number): Promise<boolean> => {
    for (;;) {
      if (ctx.signal.aborted) return false;
      if (passers >= MAX_FULL_SUITE_RUNS_PER_STEP) return false;
      if (passers < MAX_FULL_SUITE_RUNS_PER_STEP - pendingHigher(order)) return true;
      await nextSettle();
    }
  };

  /** The next job in rank order across the carried and the fresh queue (one-job lookahead on the queue); with nothing carried, a streaming queue is awaited — released early when dispatch stops or the wall runs down (§4.8). */
  const nextJob = async (): Promise<VerifyJob | undefined> => {
    let fresh = queue.pop(1)[0];
    if (fresh === undefined && carried.length === 0) fresh = await awaitNextJob(queue, released.signal, wallLeft() - minRunWallMs);
    if (fresh === undefined) return carried.shift();
    const top = carried[0];
    if (top === undefined || compareRank(fresh, top) < 0) return fresh;
    insertByRank(carried, fresh);
    return carried.shift();
  };

  /** The sandbox as a VerifyRunFn bound to one lane (cwd, env); a sandbox failure is a run failure, never a pass. `uncut`: the top job's runs are not cut by the step's wall. */
  const laneRun = (lane: Lane, uncut: boolean): VerifyRunFn => async (command, o) => {
    const timeoutMs = uncut ? Math.max(1, o.timeoutMs) : Math.max(1, Math.min(o.timeoutMs, Math.max(1, wallLeft())));
    const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: o.maxOutputBytes, signal: ctx.signal, cwd: o.cwd ?? lane.dir, env: laneEnv(lane, hasSrc) });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, timedOut: res.timedOut, killedBy: res.killedBy, durationMs: res.durationMs };
  };

  const runRegression = async (lane: Lane, command: string, uncut: boolean): Promise<TestRunSummary & { aborted: boolean }> => {
    const started = now();
    try {
      const timeoutMs = uncut ? Math.max(1, opts.regression.timeoutMs) : Math.max(1, Math.min(opts.regression.timeoutMs, Math.max(1, wallLeft())));
      const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: RUN_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir, env: laneEnv(lane, hasSrc) });
      const sum = summarize(command, res, res.durationMs > 0 ? res.durationMs : now() - started);
      const wallCut = !uncut && timeoutMs < opts.regression.timeoutMs && res.killedBy === 'timeout';
      return { ...sum, aborted: res.killedBy === 'abort' || res.killedBy === 'wall_time' || wallCut || ctx.signal.aborted };
    } catch (e: unknown) {
      return { ...summarize(command, { stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: null }, now() - started), aborted: ctx.signal.aborted };
    }
  };

  const applyFailed = (job: VerifyJob, applied: AppliedCandidate, e: unknown): JobResult => {
    const why = e instanceof Error ? e.message : String(e);
    const subset = runFailure(opts.regression.command ?? baseline.command, why);
    return { kind: 'outcome', outcome: { job, applied, subset, progress: progress(job.base.summary, subset), status: 'apply_failed' } };
  };

  const verifyJob = async (job: VerifyJob, lane: Lane, order: number): Promise<JobResult> => {
    const isTop = order === 0;
    let applied: AppliedCandidate;
    try {
      applied = applyCandidate(job.candidate, job.base.files);
    } catch (e: unknown) {
      return applyFailed(job, { candidate: job.candidate, files: [], diff: '' }, e);
    }
    const diffHash = sha12(applied.diff);
    try {
      await pool.applyToLane(lane, applied, job.base.files);
      await restoreGeneratedFiles(root, lane);
    } catch (e: unknown) {
      return applyFailed(job, applied, e);
    }
    if (budget.testRunsLeft <= 0 && !isTop) return { kind: 'defer' };
    const baseScoped = scopedPartOf(job.base.summary);
    let subset: TestRunSummary;
    let passes: boolean;
    let full: TestRunSummary | undefined;
    let fullProgress: Progress | undefined;
    let status: VerifyStatus;
    let isUnstable = false;
    if (opts.spec !== null) {
      chargeRun();
      const r = await verifyRepro(laneRun(lane, isTop), lane.dir, opts.spec, opts.python);
      if (ctx.signal.aborted) return { kind: 'defer' };
      reproDurations.push(r.result.durationMs);
      subset = r.summary;
      passes = r.verdict.pass;
      if (r.result.status === 'timeout') {
        status = 'timeout';
        passes = false;
      }
      if (passes) {
        // a pass is a fact of the code only when the same lane repeats it (django-15315's 1/8 coin, see the header)
        if (budget.testRunsLeft <= 0 && !isTop) return { kind: 'defer' };
        chargeRun();
        const again = await verifyRepro(laneRun(lane, isTop), lane.dir, opts.spec, opts.python);
        if (ctx.signal.aborted) return { kind: 'defer' };
        reproDurations.push(again.result.durationMs);
        if (!again.verdict.pass) {
          passes = false;
          isUnstable = true;
          unstable += 1;
          subset = unstableSummary(r, again);
        }
      }
    } else {
      // regression only: the scoped run is both the subset and the full run
      subset = baseScoped;
      passes = true;
    }
    let subsetProgress = progress(job.base.summary, mergeSummaries(baseScoped, opts.spec === null ? null : subset));
    if (passes) {
      if (opts.regression.command === null) {
        full = mergeSummaries(baseScoped, opts.spec === null ? null : subset);
        settle(order);
      } else {
        if (!(await admitPasser(order))) return { kind: 'defer' };
        if (budget.testRunsLeft <= 0 && !isTop) return { kind: 'defer' };
        passers += 1;
        settle(order);
        chargeRun();
        const reg = await runRegression(lane, opts.regression.command, isTop);
        if (reg.aborted) {
          passers -= 1;
          return { kind: 'defer' };
        }
        regressionDurations.push(reg.durationMs);
        full = mergeSummaries(reg, opts.spec === null ? null : subset);
        if (opts.spec === null) subset = reg;
      }
      fullProgress = progress(job.base.summary, full);
      subsetProgress = fullProgress;
      status = full.timedOut ? 'timeout' : fullProgress.regressed ? 'regressed' : 'plausible';
    } else {
      settle(order);
      status = subset.timedOut && !isUnstable ? 'timeout' : 'unchanged';
    }
    mem.tried.add(diffHash);
    const outcome: VerifyOutcome = { job, applied, subset, progress: fullProgress ?? subsetProgress, status, ...(full !== undefined ? { full } : {}) };
    return { kind: 'outcome', outcome };
  };

  const worker = async (): Promise<void> => {
    while (!stopDispatch()) {
      const job = await nextJob();
      if (job === undefined) return;
      const order = dispatched;
      dispatched += 1;
      pending.add(order);
      let r: JobResult;
      try {
        r = await pool.withLane((lane) => verifyJob(job, lane, order));
      } catch (e: unknown) {
        laneFailure = e;
        r = { kind: 'defer' };
      } finally {
        settle(order);
      }
      if (r.kind === 'defer') deferred.push(job);
      else {
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
  mem.passersThisStep = passers;
  deferred.unshift(...carried);
  deferred.sort(compareRank);

  budget.testWallLeftMs = Math.max(0, wallAtStart - (now() - batchStart));
  // the lanes' recent run times size the next step (budget.ts LIVE_*): the windows' medians once
  // they have enough samples, this batch's medians before that (§4.1 refineTRun as before)
  const reproMed = median(reproDurations);
  const regMed = median(regressionDurations);
  const live = applyLiveTRun(oracle, recordRunSamples(runSamplesOf(mem), reproDurations, regressionDurations));
  if (!live.live.repro && reproMed !== null && reproMed > 0) oracle.tRunMs.goalSubset = refineTRun(oracle.tRunMs.goalSubset, reproMed);
  if (!live.live.scoped && regMed !== null && regMed > 0) oracle.tRunMs.fullSuite = Math.round(regMed);

  results.sort((a, b) => a.order - b.order);
  const outcomes = results.map((r) => r.outcome);
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const k = isUnstableOutcome(o) ? 'unstable' : o.status;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const failureNote = laneFailure === null ? '' : `; lane failure: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`;
  const tRunNote = `; t_run reproduction ${oracle.tRunMs.goalSubset} ms${live.live.repro ? ' (live)' : ''}, scoped ${oracle.tRunMs.fullSuite} ms${live.live.scoped ? ' (live)' : ''}`;
  const timing = `${reproMed === null ? '' : `; reproduction median ${Math.round(reproMed)} ms`}${regMed === null ? '' : `; regression run median ${Math.round(regMed)} ms`}${tRunNote}`;
  const unstableNote = unstable === 0 ? '' : `; ${unstable} passed once and failed the confirmation run (unstable, not regression-tested)`;
  const streamNote = passerStop ? '; streamed batch ended on its first passer' : '';
  const detail = `${goal.id}: ${outcomes.length} tested on ${workers} lane${workers === 1 ? '' : 's'} (${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing ran'}); ${opts.spec === null ? 'regression only' : `reproduction ${opts.spec.testId} (a pass confirmed by a second run) then regression`}; runs left ${budget.testRunsLeft}, test wall left ${Math.round(budget.testWallLeftMs / 1000)} s${timing}${unstableNote}${streamNote}${deferred.length > 0 ? `; ${deferred.length} deferred` : ''}${ctx.signal.aborted ? '; aborted' : ''}${failureNote}`;
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail, candidates: dispatched, tested: outcomes.length });
  if (laneFailure !== null && outcomes.length === 0 && !ctx.signal.aborted) throw new Error(`lane failure during ${goal.id}: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`, { cause: laneFailure });
  return outcomes;
}
