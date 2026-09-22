/**
 * The context policy's bounds and the §8.2 budget. Every constant now lives in `src/core/limits.ts` (§8.1 "one bounds
 * module"); this file re-exports them so the policy's own modules keep one import, and adds the two derived functions.
 * Jev's bounds are NOT here: `STATE_LIMITS` and the 4 × (400 + 200) window stay in loop/state.ts and loop/window.ts,
 * untouched (§8.1 "two windows").
 */
import {
  CHARS_PER_TOKEN,
  CONTEXT_BUDGET_MAX_CHARS,
  CONTEXT_BUDGET_MIN_CHARS,
  CONTEXT_BUDGET_SHARE,
  CONTEXT_BUDGET_SPEND_SHARE,
  CONTEXT_BUDGET_WINDOW_MAX_SHARE,
  COMPACT_EVERY,
  DEFAULT_GENERATOR_CONTEXT_TOKENS,
  FILE_CACHE_BYTES,
  HISTORY_STEPS,
} from '../../core/limits.js';
import type { CompactionMode, ContextPolicyOptions } from './types.js';

export * from '../../core/limits.js';

/** What the §8.2 budget was derived from — `/context` prints the binding term and the meter surfaces `windowTooSmall`. */
export interface ContextBudget {
  chars: number;
  /** the model's context window in tokens */
  windowTokens: number;
  /** which term bound the budget */
  boundBy: 'window' | 'money' | 'floor' | 'ceiling';
  /** the money term in chars when it could be computed (null when no spend cap / pricing was given) */
  moneyChars: number | null;
  /** estimated generator input $ per step at this budget, null when unpriced */
  usdPerStep: number | null;
  /** §8.2: the budget would have exceeded 90 % of the model window and was clamped to it */
  windowTooSmall: boolean;
}

export interface BudgetInput {
  /** the model's context window in tokens (`contextPolicy.windowTokens` → pricing table → default) */
  windowTokens?: number;
  /** `RunLimits.spendCapUsd` */
  spendCapUsd?: number;
  /** `RunLimits.maxSteps` */
  maxSteps?: number;
  /** `EngineOptions.generatorPricing.inputPerM` — $ per million input tokens */
  inputPerM?: number;
  /** `contextPolicy.budgetChars` overrides everything below the window clamp */
  override?: number;
}

function finitePositive(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * §8.2: `clamp(min(windowTokens × 3.4 × 0.55, (spendCapUsd × 0.5 / (maxSteps × inputPerM)) × 1e6 × 3.4), 60k, 800k)`,
 * then clamped to 90 % of the window so a small model is never handed a prompt budget larger than its context.
 */
export function contextBudget(input: BudgetInput = {}): ContextBudget {
  const windowTokens = finitePositive(input.windowTokens) ?? DEFAULT_GENERATOR_CONTEXT_TOKENS;
  const windowChars = windowTokens * CHARS_PER_TOKEN * CONTEXT_BUDGET_SHARE;
  const cap = finitePositive(input.spendCapUsd);
  const steps = finitePositive(input.maxSteps);
  const perM = finitePositive(input.inputPerM);
  const moneyChars = cap !== null && steps !== null && perM !== null ? ((cap * CONTEXT_BUDGET_SPEND_SHARE) / (steps * perM)) * 1e6 * CHARS_PER_TOKEN : null;
  const override = finitePositive(input.override);
  const wanted = override ?? (moneyChars === null ? windowChars : Math.min(windowChars, moneyChars));
  let boundBy: ContextBudget['boundBy'] = override !== null ? 'window' : moneyChars !== null && moneyChars < windowChars ? 'money' : 'window';
  let chars = wanted;
  if (chars < CONTEXT_BUDGET_MIN_CHARS) {
    chars = CONTEXT_BUDGET_MIN_CHARS;
    boundBy = 'floor';
  } else if (chars > CONTEXT_BUDGET_MAX_CHARS) {
    chars = CONTEXT_BUDGET_MAX_CHARS;
    boundBy = 'ceiling';
  }
  // §8.2 / review D8: never hand a 32k-window model a 120k-char prompt budget — the window wins and the run says so
  const windowMax = Math.floor(windowTokens * CHARS_PER_TOKEN * CONTEXT_BUDGET_WINDOW_MAX_SHARE);
  const windowTooSmall = chars > windowMax;
  if (windowTooSmall) {
    chars = windowMax;
    boundBy = 'window';
  }
  const rounded = Math.max(1, Math.round(chars));
  const usdPerStep = perM === null ? null : (rounded / CHARS_PER_TOKEN / 1e6) * perM;
  return { chars: rounded, windowTokens, boundBy, moneyChars: moneyChars === null ? null : Math.round(moneyChars), usdPerStep, windowTooSmall };
}

/** The window-only form, kept for callers that have no money context (tests, tools). */
export function contextBudgetChars(windowTokens: number = DEFAULT_GENERATOR_CONTEXT_TOKENS): number {
  return contextBudget({ windowTokens }).chars;
}

// ---------------------------------------------------------------------------------------
// §12.0.1 `EngineOptions.contextPolicy?` → the bounds one engine runs with
// ---------------------------------------------------------------------------------------

/** Every bound the engine reads per step: resolved once in the constructor, never re-derived. */
export interface ResolvedContextPolicy {
  /** `'legacy'` → HEAD's prompt and none of §8's bookkeeping (review finding 28) */
  view: 'relaxed' | 'legacy';
  historySteps: number;
  fileCacheBytes: number;
  /** 0 disables the interval trigger */
  compactEvery: number;
  compaction: CompactionMode;
  budget: ContextBudget;
  /** `budget.chars`, the value every section share is taken from */
  budgetChars: number;
  /** the model's context window in tokens — reported by the meter beside the budget (review finding 51) */
  windowTokens: number;
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * §8.2 / §12.0.1: the policy for one run.
 *
 * `windowTokens` comes from `contextPolicy.windowTokens`, else from the pricing table's `contextTokens` column when the
 * caller passes one, else the 128k default.
 * TODO(§14 Q4, contract 1.4): `GeneratorConfig['pricing']` has no `contextTokens` member at HEAD, so `EngineOptions
 * .generatorPricing` cannot supply it yet — `engine.ts` passes `contextPolicy.windowTokens` and this default until the
 * column lands, at which point the engine passes `generatorPricing.contextTokens` here and nothing else changes.
 */
export function resolveContextPolicy(p?: ContextPolicyOptions, budget?: Omit<BudgetInput, 'windowTokens' | 'override'>): ResolvedContextPolicy {
  const compactEvery = p?.compactEvery;
  const resolved = contextBudget({
    ...budget,
    ...(p?.windowTokens !== undefined ? { windowTokens: p.windowTokens } : {}),
    ...(p?.budgetChars !== undefined ? { override: p.budgetChars } : {}),
  });
  return {
    view: p?.view ?? 'relaxed',
    historySteps: positive(p?.historySteps, HISTORY_STEPS),
    fileCacheBytes: positive(p?.fileCacheBytes, FILE_CACHE_BYTES),
    compactEvery: compactEvery !== undefined && Number.isFinite(compactEvery) && compactEvery >= 0 ? Math.floor(compactEvery) : COMPACT_EVERY,
    compaction: p?.compaction ?? 'code',
    budget: resolved,
    budgetChars: resolved.chars,
    windowTokens: resolved.windowTokens,
  };
}
