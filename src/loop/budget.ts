/**
 * Budgets (DESIGN.md §6 "Budgets"): one `checkBudgets` with a fixed order, called at step
 * start (all four) and immediately before execute (spend_cap and wall_time only); the wall
 * deadline on the engine's single AbortController; the command-timeout clamp.
 */
import { BudgetError } from '../errors.js';
import type { BudgetKind } from '../errors.js';
import type { RunLimits } from '../core/types.js';

/** TUI-DESIGN §9.5 / §15 item 19: `token_cap` (--allow-unpriced) sits right after `spend_cap`. */
export const BUDGET_ORDER: readonly BudgetKind[] = ['spend_cap', 'token_cap', 'wall_time', 'max_steps', 'max_replans'];

export interface BudgetInput {
  spendExceeded: boolean;
  /** TUI-DESIGN §9.5: generator tokens used so far (input + output); only compared when a token cap is set */
  generatorTokens?: number;
  /** TUI-DESIGN §9.5: RunLimits.maxGeneratorTokens under --allow-unpriced; absent = no token cap */
  maxGeneratorTokens?: number;
  wallMsUsed: number;
  maxWallMs: number;
  /** committed steps */
  steps: number;
  maxSteps: number;
  /** replans issued so far */
  replans: number;
  maxReplans: number;
  /** the loop detector is tripped, so the next step would need a replan */
  replanPending: boolean;
  /** restrict to a subset (before execute: spend_cap and wall_time) */
  only?: readonly BudgetKind[];
}

/**
 * First exceeded budget in BUDGET_ORDER, or null. `max_replans` fires when a replan would be
 * needed (detector tripped) and the count already reached the limit, so the last permitted
 * directive still gets its step.
 */
export function checkBudgets(input: BudgetInput): BudgetKind | null {
  for (const kind of BUDGET_ORDER) {
    if (input.only && !input.only.includes(kind)) continue;
    switch (kind) {
      case 'spend_cap':
        if (input.spendExceeded) return kind;
        break;
      case 'token_cap':
        // TUI-DESIGN §9.5: `generatorTokens >= maxGeneratorTokens`; a missing or non-finite cap never fires
        if (input.maxGeneratorTokens !== undefined && Number.isFinite(input.maxGeneratorTokens) && (input.generatorTokens ?? 0) >= input.maxGeneratorTokens) return kind;
        break;
      case 'wall_time':
        if (input.wallMsUsed >= input.maxWallMs) return kind;
        break;
      case 'max_steps':
        if (input.steps >= input.maxSteps) return kind;
        break;
      case 'max_replans':
        if (input.replanPending && input.replans >= input.maxReplans) return kind;
        break;
    }
  }
  return null;
}

/** min(action.timeoutMs ?? default, max, wallRemaining), never below 1 ms. */
export function clampCommandTimeout(actionTimeoutMs: number | undefined, limits: RunLimits, wallRemainingMs: number): number {
  const requested = actionTimeoutMs ?? limits.commandTimeoutMs;
  return Math.max(1, Math.floor(Math.min(requested, limits.maxCommandTimeoutMs, wallRemainingMs)));
}

export interface WallDeadline {
  clear(): void;
}

/** setTimeout(...).unref() that aborts the controller with BudgetError('wall_time'). */
export function armWallDeadline(controller: AbortController, remainingMs: number): WallDeadline {
  const ms = Math.max(0, Math.min(remainingMs, 2_147_483_647));
  const t = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new BudgetError('wall_time'));
  }, ms);
  t.unref();
  return { clear: () => clearTimeout(t) };
}
