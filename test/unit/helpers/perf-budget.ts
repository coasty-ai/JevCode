/**
 * Wall-clock budgets in unit tests are calibrated on a developer machine. A shared CI runner can be several times
 * slower on some runs, and a retry lands on the same machine, so ci.yml and release.yml's gates set
 * JEVCODE_PERF_BUDGET_SCALE=3 on the unit step. Locally the scale is 1 and every budget is unchanged; an
 * algorithmic regression (an accidental O(n²)) still overshoots a 3× budget by far.
 */
export function perfBudgetScale(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['JEVCODE_PERF_BUDGET_SCALE']);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function budgetMs(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  return ms * perfBudgetScale(env);
}
