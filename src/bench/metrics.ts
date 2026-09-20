/**
 * Aggregation rules of DESIGN.md §13, applied identically to every condition: evaluated set,
 * pass rate as passed/evaluated (n), steps-to-solve over passed tasks only with a censored
 * solve curve, steps used over all runs, tokens-per-step curve with n, null percentiles,
 * stop-reason histogram, paired intersection with modelDrift excluded.
 */
import { percentile } from '../core/time.js';
import type { BenchSuite, BenchTaskRecord, EngineMode } from '../core/types.js';
import type { ConditionMetrics, PairedRow, SolvePoint, Stat, SuiteComparison, SuiteMetrics, TokensPoint } from './types.js';

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number | null {
  return percentile(xs, 50);
}

export function stat(xs: readonly number[]): Stat {
  return { n: xs.length, mean: mean(xs), median: median(xs) };
}

export function round(x: number | null, digits = 4): number | null {
  if (x === null) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function isEvaluated(r: BenchTaskRecord): boolean {
  return r.pass !== null;
}
export function isNotRun(r: BenchTaskRecord): boolean {
  return r.stopReason === 'not_run';
}
export function isUnsupported(r: BenchTaskRecord): boolean {
  return r.pass === null && r.reason === 'unsupported-locally';
}
/** evaluator ran (or the engine errored) but produced no verdict */
export function isUnevaluated(r: BenchTaskRecord): boolean {
  return r.pass === null && !isNotRun(r) && !isUnsupported(r);
}

/** solved(k) = |passed with steps <= k| / |evaluated|; failed and budget-stopped runs are censored, never solves. */
export function solveCurve(records: readonly BenchTaskRecord[], maxSteps: number): SolvePoint[] {
  const evaluated = records.filter(isEvaluated);
  const passedSteps = evaluated.filter((r) => r.pass === true).map((r) => r.steps);
  const top = Math.max(maxSteps, ...passedSteps, 1);
  const out: SolvePoint[] = [];
  for (let k = 1; k <= top; k++) {
    const solved = passedSteps.filter((s) => s <= k).length;
    out.push({ k, solved, fraction: evaluated.length === 0 ? null : solved / evaluated.length });
  }
  return out;
}

/** Per step index: mean generator+Jev tokens and the number of runs that executed that step. */
export function tokensPerStepCurve(records: readonly BenchTaskRecord[]): TokensPoint[] {
  const longest = Math.max(0, ...records.map((r) => r.tokensPerStep.length));
  const out: TokensPoint[] = [];
  for (let i = 0; i < longest; i++) {
    const xs: number[] = [];
    for (const r of records) {
      const v = r.tokensPerStep[i];
      if (v !== undefined && Number.isFinite(v)) xs.push(v);
    }
    if (xs.length > 0) out.push({ step: i + 1, mean: mean(xs)!, n: xs.length });
  }
  return out;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function computeConditionMetrics(all: readonly BenchTaskRecord[], condition: EngineMode, maxSteps: number): ConditionMetrics {
  const records = all.filter((r) => r.condition === condition);
  const evaluated = records.filter(isEvaluated);
  const passed = evaluated.filter((r) => r.pass === true);
  const ran = records.filter((r) => !isNotRun(r));
  const stepsToSolve = passed.map((r) => r.steps);
  const stopReasons: Record<string, number> = {};
  for (const r of records) stopReasons[r.stopReason] = (stopReasons[r.stopReason] ?? 0) + 1;
  const allTokens = ran.flatMap((r) => r.tokensPerStep.filter((x) => Number.isFinite(x)));
  const latencies = ran.flatMap((r) => r.jevLatencyMs.raw);
  const reads = sum(ran.map((r) => r.reads));
  const generator = sum(records.map((r) => r.cost.generator));
  const jev = sum(records.map((r) => r.cost.jev));
  return {
    condition,
    tasks: records.length,
    evaluated: evaluated.length,
    passed: passed.length,
    passRate: evaluated.length === 0 ? null : passed.length / evaluated.length,
    passRateText: `${passed.length}/${evaluated.length} (n=${evaluated.length})`,
    unevaluated: records.filter(isUnevaluated).map((r) => r.task),
    unsupported: records.filter(isUnsupported).map((r) => r.task),
    notRun: records.filter(isNotRun).map((r) => r.task),
    stepsToSolve: { ...stat(stepsToSolve), values: [...stepsToSolve].sort((a, b) => a - b) },
    solveCurve: solveCurve(records, maxSteps),
    stepsUsed: stat(ran.map((r) => r.steps)),
    stopReasons,
    tokensPerStepCurve: tokensPerStepCurve(ran),
    meanTokensPerStep: { mean: mean(allTokens), steps: allTokens.length },
    jevLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    jevRequests: sum(ran.map((r) => r.jevRequests)),
    jevQuestions: sum(ran.map((r) => r.jevQuestions)),
    blocked: sum(ran.map((r) => r.blocked)),
    reviews: sum(ran.map((r) => r.reviews)),
    declined: sum(ran.map((r) => r.declined)),
    loops: sum(ran.map((r) => r.loops)),
    replans: sum(ran.map((r) => r.replans)),
    reads: { total: reads, meanPerRun: ran.length === 0 ? null : reads / ran.length },
    cost: { generator, jev, total: generator + jev },
    wallMs: stat(ran.map((r) => r.wallMs)),
    modelDrift: records.filter((r) => r.modelDrift).map((r) => r.task),
    runsWithError: records.filter((r) => r.stopReason === 'error').map((r) => r.task),
  };
}

/** Tasks with an evaluated record in every condition; tasks with modelDrift in any condition are excluded. */
export function pairedTaskIds(records: readonly BenchTaskRecord[], conditions: readonly EngineMode[]): { paired: string[]; incomplete: string[]; drift: string[] } {
  const byTask = new Map<string, Map<EngineMode, BenchTaskRecord>>();
  for (const r of records) {
    let m = byTask.get(r.task);
    if (!m) {
      m = new Map();
      byTask.set(r.task, m);
    }
    m.set(r.condition, r);
  }
  const paired: string[] = [];
  const incomplete: string[] = [];
  const drift: string[] = [];
  for (const [task, m] of byTask) {
    const recs = conditions.map((c) => m.get(c));
    if (recs.some((r) => r === undefined || !isEvaluated(r))) {
      incomplete.push(task);
      continue;
    }
    if (recs.some((r) => r!.modelDrift)) {
      drift.push(task);
      continue;
    }
    paired.push(task);
  }
  return { paired: paired.sort(), incomplete: incomplete.sort(), drift: drift.sort() };
}

export function computeSuiteComparison(records: readonly BenchTaskRecord[], suite: BenchSuite, conditions: readonly EngineMode[], maxSteps: number): SuiteComparison {
  const suiteRecords = records.filter((r) => r.suite === suite);
  const { paired, incomplete, drift } = pairedTaskIds(suiteRecords, conditions);
  const pairedSet = new Set(paired);
  const pairedRecords = suiteRecords.filter((r) => pairedSet.has(r.task));
  const perCondition: Record<string, ConditionMetrics> = {};
  for (const c of conditions) perCondition[c] = computeConditionMetrics(pairedRecords, c, maxSteps);
  const rows: PairedRow[] = paired.map((task) => {
    const row: PairedRow = { task, pass: {}, steps: {}, reads: {}, cost: {} };
    for (const c of conditions) {
      const r = pairedRecords.find((x) => x.task === task && x.condition === c)!;
      row.pass[c] = r.pass;
      row.steps[c] = r.steps;
      row.reads[c] = r.reads;
      row.cost[c] = r.cost.generator + r.cost.jev;
    }
    return row;
  });
  return { suite, conditions: [...conditions], pairedTasks: paired, incompletePairs: incomplete, excludedForDrift: drift, perCondition, rows };
}

export function computeSuiteMetrics(records: readonly BenchTaskRecord[], suite: BenchSuite, conditions: readonly EngineMode[], maxSteps: number): SuiteMetrics {
  const suiteRecords = records.filter((r) => r.suite === suite);
  const perCondition: Record<string, ConditionMetrics> = {};
  for (const c of conditions) perCondition[c] = computeConditionMetrics(suiteRecords, c, maxSteps);
  return { suite, perCondition, comparison: computeSuiteComparison(records, suite, conditions, maxSteps) };
}

export function suitesIn(records: readonly BenchTaskRecord[]): BenchSuite[] {
  const out: BenchSuite[] = [];
  for (const r of records) if (!out.includes(r.suite)) out.push(r.suite);
  return out;
}

/** pairComplete = every condition of the task has a record whose engine ran (not `not_run`). */
export function withPairComplete(records: readonly BenchTaskRecord[], conditions: readonly EngineMode[]): BenchTaskRecord[] {
  const ranBy = new Map<string, Set<EngineMode>>();
  for (const r of records) {
    if (isNotRun(r)) continue;
    const key = `${r.suite}\u0000${r.task}`;
    let s = ranBy.get(key);
    if (!s) {
      s = new Set();
      ranBy.set(key, s);
    }
    s.add(r.condition);
  }
  return records.map((r) => {
    const s = ranBy.get(`${r.suite}\u0000${r.task}`);
    return { ...r, pairComplete: conditions.every((c) => s?.has(c) ?? false) };
  });
}
