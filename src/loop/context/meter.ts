/**
 * The context meter (docs/COORDINATION-DESIGN.md §8.7, §12.0.3): `ContextUsage` is computed at exactly two points — after
 * the step's prompt is built and after a compaction — from chars, with `CHARS_PER_TOKEN = 3.4` as the token estimate. Pure;
 * the engine keeps the last object and `status()` returns it unchanged.
 */
import { CHARS_PER_TOKEN, DEFAULT_GENERATOR_CONTEXT_TOKENS, METER_AMBER_PCT, METER_RED_PCT, type ContextBudget } from './limits.js';
import type { CompactionMode, ContextCheckpointExtension, ContextUsage, RecentStepsUsage } from './types.js';

export interface ContextUsageInput {
  /** §12.0.3 / review D15: the WHOLE prompt — the system prompt plus the step's user message */
  promptChars: number;
  budgetChars: number;
  /** the model's context window in tokens (§8.2 `generatorContextTokens`); defaults to the 128k table default */
  windowTokens?: number;
  budget?: ContextBudget;
  recentSteps?: RecentStepsUsage;
  promptBuildMs?: number;
  refreshMs?: number;
  files: number;
  historyEntries: number;
  summaryAt: number | null;
  lastCompactionStep: number | null;
  compactions: number;
  lastCompactionAt: string | null;
  compaction: CompactionMode;
}

/**
 * §12.0.3: tokens = round(chars / 3.4); pct = round(100 × tokensInWindow / budgetTokens) — the share of the PROMPT BUDGET,
 * with the model's window reported beside it (`windowTokens`, review finding 51).
 */
export function computeContextUsage(i: ContextUsageInput): ContextUsage {
  const promptChars = Math.max(0, Math.round(i.promptChars));
  const budgetChars = Math.max(1, Math.round(i.budgetChars));
  const tokensInWindow = Math.round(promptChars / CHARS_PER_TOKEN);
  const budgetTokens = Math.max(1, Math.round(budgetChars / CHARS_PER_TOKEN));
  return {
    promptChars,
    budgetChars,
    pct: Math.round((100 * tokensInWindow) / budgetTokens),
    files: i.files,
    historyEntries: i.historyEntries,
    summaryAt: i.summaryAt,
    lastCompactionStep: i.lastCompactionStep,
    tokensInWindow,
    budgetTokens,
    // review D15: never inflate a small window to hide the budget — §8.2 clamps the BUDGET to the window instead
    windowTokens: Math.round(i.budget?.windowTokens ?? i.windowTokens ?? DEFAULT_GENERATOR_CONTEXT_TOKENS),
    compactions: i.compactions,
    lastCompactionAt: i.lastCompactionAt,
    compaction: i.compaction,
    budgetBoundBy: i.budget?.boundBy ?? 'window',
    usdPerStep: i.budget?.usdPerStep ?? null,
    windowTooSmall: i.budget?.windowTooSmall ?? false,
    recentSteps: i.recentSteps ?? { chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 },
    promptBuildMs: Math.max(0, Math.round((i.promptBuildMs ?? 0) * 100) / 100),
    refreshMs: Math.max(0, Math.round((i.refreshMs ?? 0) * 100) / 100),
  };
}

/** §12.0.3: before the first prompt of a process the object is derived from the restored state (promptChars 0, counters as persisted). */
export function restoredContextUsage(state: ContextCheckpointExtension, budget: ContextBudget, compaction: CompactionMode): ContextUsage {
  const summaryAt = state.summaryAt ?? null;
  return computeContextUsage({
    promptChars: 0,
    budgetChars: budget.chars,
    budget,
    files: state.fileCache?.length ?? 0,
    historyEntries: state.history?.length ?? 0,
    summaryAt,
    lastCompactionStep: summaryAt,
    compactions: state.compactions ?? 0,
    lastCompactionAt: state.lastCompactionAt ?? null,
    compaction,
  });
}

export type MeterLevel = 'ok' | 'amber' | 'red';

/** §8.5: amber at 85 %, red at 95 %. */
export function meterLevel(pct: number): MeterLevel {
  if (pct >= METER_RED_PCT) return 'red';
  if (pct >= METER_AMBER_PCT) return 'amber';
  return 'ok';
}

/** §8.2(c): the `/context` recent-steps line — `recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)`. */
export function formatRecentSteps(u: ContextUsage): string {
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const r = u.recentSteps;
  return `recent steps ${k(r.chars)} of ${k(r.allowanceChars)} (${r.whole} whole, ${r.clipped} clipped, ${r.oneLine} one-line)`;
}

/** §8.2: the `/context` budget line — it names the term that bound the budget, money included. */
export function formatBudget(u: ContextUsage, o: { maxSteps?: number; spendCapUsd?: number } = {}): string {
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const per = u.usdPerStep === null ? '' : ` (est. $${u.usdPerStep.toFixed(3)} per step)`;
  if (u.windowTooSmall) return `budget ${k(u.budgetChars)} chars — capped by the ${k(u.windowTokens)}-token model window${per}`;
  if (u.budgetBoundBy === 'money' && o.spendCapUsd !== undefined && o.maxSteps !== undefined) {
    return `budget ${k(u.budgetChars)} chars — capped by the $${o.spendCapUsd.toFixed(2)} run cap at ${o.maxSteps} steps${per}`;
  }
  if (u.budgetBoundBy === 'floor') return `budget ${k(u.budgetChars)} chars — the floor${per}`;
  if (u.budgetBoundBy === 'ceiling') return `budget ${k(u.budgetChars)} chars — the ceiling${per}`;
  return `budget ${k(u.budgetChars)} chars of the ${k(u.windowTokens)}-token window${per}`;
}

/** The S5 zone text: `ctx 41% · 6 files · 12 steps`. */
export function formatMeter(u: ContextUsage): string {
  const files = `${u.files} file${u.files === 1 ? '' : 's'}`;
  const steps = `${u.historyEntries} step${u.historyEntries === 1 ? '' : 's'}`;
  return `ctx ${u.pct}% · ${files} · ${steps}`;
}
