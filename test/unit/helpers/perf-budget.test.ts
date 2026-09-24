import { describe, expect, it } from 'vitest';
import { deletedByUnitSetup } from '../setup-env.js';
import { budgetMs, perfBudgetScale } from './perf-budget.js';

describe('perf-budget', () => {
  it('scales a budget only by a sane JEVCODE_PERF_BUDGET_SCALE', () => {
    expect(budgetMs(5, {})).toBe(5);
    expect(budgetMs(5, { JEVCODE_PERF_BUDGET_SCALE: '3' })).toBe(15);
    for (const bad of ['', 'x', '0', '0.5', '-2', 'Infinity']) expect(perfBudgetScale({ JEVCODE_PERF_BUDGET_SCALE: bad })).toBe(1);
  });

  it('survives the unit setup file, which deletes every other JEVCODE_* variable (CI sets it; it was being dropped)', () => {
    expect(deletedByUnitSetup('JEVCODE_PERF_BUDGET_SCALE')).toBe(false);
  });
});
