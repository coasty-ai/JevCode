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
 */
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha12 } from '../../core/hash.js';
import { refineTRun } from '../search/budget.js';
import type { Goal, Lane, VerifyJob, VerifyOutcome, VerifyStatus } from '../search/types.js';
import { createLanes } from '../sieve/lanes.js';
import type { JobQueue, RunnerContext, RunnerMemory } from '../sieve/runner.js';
import { MAX_FULL_SUITE_RUNS_PER_STEP, RUN_OUTPUT_BYTES } from '../sieve/runner.js';
import type { AppliedCandidate, Progress, TestRunSummary } from '../types.js';
import { applyCandidate } from '../verify/apply.js';
import { summarize } from '../verify/index.js';
import { progress } from '../verify/progress.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import type { VerifyRunFn } from '../verify/types.js';
import { verifyRepro } from './goal.js';
import type { ReproSpec } from './goal.js';
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

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
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
  const carried = deferred.splice(0, deferred.length);
  const hasSrc = await exists(join(root, 'src'));

  const batchStart = now();
  const wallAtStart = budget.testWallLeftMs;
  const wallLeft = (): number => wallAtStart - (now() - batchStart);
  const reproTimeoutMs = opts.spec?.options.timeoutMs ?? 30_000;
  const minRunWallMs = Math.min(reproTimeoutMs, Math.max(1, oracle.tRunMs.goalSubset));
  let dispatched = 0;
  let passers = 0;
  let laneFailure: unknown = null;
  const results: { order: number; outcome: VerifyOutcome }[] = [];
  const reproDurations: number[] = [];
  const regressionDurations: number[] = [];
  const stopDispatch = (): boolean => ctx.signal.aborted || laneFailure !== null || dispatched >= runsAllowed || budget.testRunsLeft <= 0 || wallLeft() < minRunWallMs || passers >= MAX_FULL_SUITE_RUNS_PER_STEP;

  /** The sandbox as a VerifyRunFn bound to one lane (cwd, env); a sandbox failure is a run failure, never a pass. */
  const laneRun = (lane: Lane): VerifyRunFn => async (command, o) => {
    const timeoutMs = Math.max(1, Math.min(o.timeoutMs, Math.max(1, wallLeft())));
    const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: o.maxOutputBytes, signal: ctx.signal, cwd: o.cwd ?? lane.dir, env: laneEnv(lane, hasSrc) });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, timedOut: res.timedOut, killedBy: res.killedBy, durationMs: res.durationMs };
  };

  const runRegression = async (lane: Lane, command: string): Promise<TestRunSummary & { aborted: boolean }> => {
    const started = now();
    try {
      const timeoutMs = Math.max(1, Math.min(opts.regression.timeoutMs, Math.max(1, wallLeft())));
      const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: RUN_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir, env: laneEnv(lane, hasSrc) });
      const sum = summarize(command, res, res.durationMs > 0 ? res.durationMs : now() - started);
      const wallCut = timeoutMs < opts.regression.timeoutMs && res.killedBy === 'timeout';
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

  const verifyJob = async (job: VerifyJob, lane: Lane): Promise<JobResult> => {
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
    if (budget.testRunsLeft <= 0) return { kind: 'defer' };
    const baseScoped = scopedPartOf(job.base.summary);
    let subset: TestRunSummary;
    let passes: boolean;
    let full: TestRunSummary | undefined;
    let fullProgress: Progress | undefined;
    let status: VerifyStatus;
    if (opts.spec !== null) {
      budget.testRunsLeft -= 1;
      const r = await verifyRepro(laneRun(lane), lane.dir, opts.spec, opts.python);
      if (ctx.signal.aborted) return { kind: 'defer' };
      reproDurations.push(r.result.durationMs);
      subset = r.summary;
      passes = r.verdict.pass;
      if (r.result.status === 'timeout') {
        status = 'timeout';
        passes = false;
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
      } else {
        if (passers >= MAX_FULL_SUITE_RUNS_PER_STEP || budget.testRunsLeft <= 0) return { kind: 'defer' };
        passers += 1;
        budget.testRunsLeft -= 1;
        const reg = await runRegression(lane, opts.regression.command);
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
      status = subset.timedOut ? 'timeout' : 'unchanged';
    }
    mem.tried.add(diffHash);
    const outcome: VerifyOutcome = { job, applied, subset, progress: fullProgress ?? subsetProgress, status, ...(full !== undefined ? { full } : {}) };
    return { kind: 'outcome', outcome };
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
        laneFailure = e;
        r = { kind: 'defer' };
      }
      if (r.kind === 'defer') deferred.push(job);
      else results.push({ order, outcome: r.outcome });
    }
  };
  const workers = Math.max(1, Math.min(pool.lanes.length, oracle.lanes));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  deferred.unshift(...carried);

  budget.testWallLeftMs = Math.max(0, wallAtStart - (now() - batchStart));
  const reproMed = median(reproDurations);
  if (reproMed !== null && reproMed > 0) oracle.tRunMs.goalSubset = refineTRun(oracle.tRunMs.goalSubset, reproMed);
  const regMed = median(regressionDurations);
  if (regMed !== null && regMed > 0) oracle.tRunMs.fullSuite = Math.round(regMed);

  results.sort((a, b) => a.order - b.order);
  const outcomes = results.map((r) => r.outcome);
  const counts = new Map<VerifyStatus, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const failureNote = laneFailure === null ? '' : `; lane failure: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`;
  const timing = `${reproMed === null ? '' : `; reproduction median ${Math.round(reproMed)} ms`}${regMed === null ? '' : `; regression run median ${Math.round(regMed)} ms`}`;
  const detail = `${goal.id}: ${outcomes.length} tested on ${workers} lane${workers === 1 ? '' : 's'} (${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing ran'}); ${opts.spec === null ? 'regression only' : `reproduction ${opts.spec.testId} then regression`}; runs left ${budget.testRunsLeft}, test wall left ${Math.round(budget.testWallLeftMs / 1000)} s${timing}${deferred.length > 0 ? `; ${deferred.length} deferred` : ''}${ctx.signal.aborted ? '; aborted' : ''}${failureNote}`;
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'verify', detail, candidates: dispatched, tested: outcomes.length });
  if (laneFailure !== null && outcomes.length === 0 && !ctx.signal.aborted) throw new Error(`lane failure during ${goal.id}: ${laneFailure instanceof Error ? laneFailure.message : String(laneFailure)}`, { cause: laneFailure });
  return outcomes;
}
