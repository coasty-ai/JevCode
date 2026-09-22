/**
 * The context meter (docs/COORDINATION-DESIGN.md §8.7, §12.0.3): `ContextUsage` is computed at exactly two points — after
 * the step's prompt is built and after a compaction — from chars, with `CHARS_PER_TOKEN = 3.4` as the token estimate. Pure;
 * the engine keeps the last object and `status()` returns it unchanged.
 */
import { CHARS_PER_TOKEN, DEFAULT_GENERATOR_CONTEXT_TOKENS, METER_AMBER_PCT, METER_RED_PCT } from './limits.js';
import type { CompactionMode, ContextCheckpointExtension, ContextUsage } from './types.js';

export interface ContextUsageInput {
  promptChars: number;
  budgetChars: number;
  /** the model's context window in tokens (§8.2 `generatorContextTokens`); defaults to the 128k table default */
  windowTokens?: number;
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
    windowTokens: Math.max(budgetTokens, Math.round(i.windowTokens ?? DEFAULT_GENERATOR_CONTEXT_TOKENS)),
    compactions: i.compactions,
    lastCompactionAt: i.lastCompactionAt,
    compaction: i.compaction,
  };
}

/** §12.0.3: before the first prompt of a process the object is derived from the restored state (promptChars 0, counters as persisted). */
export function restoredContextUsage(state: ContextCheckpointExtension, budgetChars: number, compaction: CompactionMode, windowTokens?: number): ContextUsage {
  const summaryAt = state.summaryAt ?? null;
  return computeContextUsage({
    promptChars: 0,
    budgetChars,
    ...(windowTokens === undefined ? {} : { windowTokens }),
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

/** The S5 zone text: `ctx 41% · 6 files · 12 steps`. */
export function formatMeter(u: ContextUsage): string {
  const files = `${u.files} file${u.files === 1 ? '' : 's'}`;
  const steps = `${u.historyEntries} step${u.historyEntries === 1 ? '' : 's'}`;
  return `ctx ${u.pct}% · ${files} · ${steps}`;
}
