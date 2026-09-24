import { describe, expect, it } from 'vitest';
import { BudgetError } from '../../../src/errors.js';
import { armWallDeadline, checkBudgets, clampCommandTimeout } from '../../../src/loop/budget.js';
import { classifyAbort, exitCodeFor } from '../../../src/loop/stop.js';
import { DEFAULT_LIMITS } from './fakes.js';

const base = { spendExceeded: false, wallMsUsed: 0, maxWallMs: 1000, steps: 0, maxSteps: 10, replans: 0, maxReplans: 2, replanPending: false };

describe('checkBudgets', () => {
  it('returns the first exceeded budget in the fixed order', () => {
    expect(checkBudgets(base)).toBeNull();
    expect(checkBudgets({ ...base, spendExceeded: true, wallMsUsed: 5000, steps: 99 })).toBe('spend_cap');
    expect(checkBudgets({ ...base, wallMsUsed: 1000, steps: 99 })).toBe('wall_time');
    expect(checkBudgets({ ...base, steps: 10, replans: 5, replanPending: true })).toBe('max_steps');
    expect(checkBudgets({ ...base, replans: 2, replanPending: true })).toBe('max_replans');
    expect(checkBudgets({ ...base, replans: 2, replanPending: false })).toBeNull();
  });
  it('token_cap (TUI-DESIGN §9.5) sits after spend_cap and fires only when a cap is set and reached', () => {
    expect(checkBudgets({ ...base, generatorTokens: 133_000 })).toBeNull();
    expect(checkBudgets({ ...base, generatorTokens: 133_000, maxGeneratorTokens: 133_000 })).toBe('token_cap');
    expect(checkBudgets({ ...base, generatorTokens: 132_999, maxGeneratorTokens: 133_000 })).toBeNull();
    expect(checkBudgets({ ...base, spendExceeded: true, generatorTokens: 1, maxGeneratorTokens: 1 })).toBe('spend_cap');
    expect(checkBudgets({ ...base, wallMsUsed: 1000, generatorTokens: 1, maxGeneratorTokens: 1 })).toBe('token_cap');
  });
  it('`only` restricts the checks (before execute: spend_cap and wall_time)', () => {
    expect(checkBudgets({ ...base, steps: 10, only: ['spend_cap', 'wall_time'] })).toBeNull();
    expect(checkBudgets({ ...base, steps: 10, wallMsUsed: 2000, only: ['spend_cap', 'wall_time'] })).toBe('wall_time');
  });
  it('clampCommandTimeout = min(action ?? default, max, wall remaining), at least 1 ms', () => {
    expect(clampCommandTimeout(undefined, DEFAULT_LIMITS, 1e9)).toBe(120_000);
    expect(clampCommandTimeout(5_000, DEFAULT_LIMITS, 1e9)).toBe(5_000);
    expect(clampCommandTimeout(9e9, DEFAULT_LIMITS, 1e9)).toBe(600_000);
    expect(clampCommandTimeout(undefined, DEFAULT_LIMITS, 250)).toBe(250);
    expect(clampCommandTimeout(undefined, DEFAULT_LIMITS, 0)).toBe(1);
  });
  it('armWallDeadline aborts the controller with BudgetError(wall_time)', async () => {
    const c = new AbortController();
    armWallDeadline(c, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toBeInstanceOf(BudgetError);
    expect(classifyAbort(c.signal.reason)).toEqual({ interrupt: 'wall_time', stop: 'wall_time' });
    const c2 = new AbortController();
    const d = armWallDeadline(c2, 5);
    d.clear();
    await new Promise((r) => setTimeout(r, 15));
    expect(c2.signal.aborted).toBe(false);
  });
  it('exit codes follow the §11 table', () => {
    expect(exitCodeFor('complete')).toBe(0);
    expect(exitCodeFor('max_steps')).toBe(4);
    expect(exitCodeFor('replan_stop')).toBe(4);
    expect(exitCodeFor('human_abort')).toBe(130);
    expect(exitCodeFor('error', { name: 'JevHttpError', code: 'jev_http', message: '', exitCode: 5 })).toBe(5);
    expect(exitCodeFor('error')).toBe(1);
    // TUI-DESIGN §13.5: human_pause and token_cap are the exit-4 family; degraded → 3; signals 143 / 129 / 130
    expect(exitCodeFor('human_pause')).toBe(4);
    expect(exitCodeFor('token_cap')).toBe(4);
    expect(exitCodeFor('complete', undefined, true)).toBe(3);
    expect(exitCodeFor('error', { name: 'E', code: 'jev_http', message: '', exitCode: 5 }, true)).toBe(5);
    expect(exitCodeFor('signal', undefined, false, 'SIGTERM')).toBe(143);
    expect(exitCodeFor('signal', undefined, false, 'SIGHUP')).toBe(129);
    expect(exitCodeFor('signal', undefined, false, 'SIGINT')).toBe(130);
  });
});
