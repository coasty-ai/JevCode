/**
 * Bounds of the generator's relaxed context (docs/COORDINATION-DESIGN.md §8.2–§8.6). Jev's bounds are NOT here: `STATE_LIMITS`
 * and the 4 × (400 + 200) window stay in loop/state.ts and loop/window.ts, untouched (§8.1 "two windows"). W0 moves these to
 * `src/core/limits.ts` together with the other duplicated copies; until then this file is the one definition for the context policy.
 */
import { WINDOW_OUTPUT_HEAD, WINDOW_OUTPUT_TAIL } from '../window.js';
import type { CompactionMode, ContextPolicyOptions } from './types.js';

/** §12.0.3: the chars-per-token estimate behind `tokensInWindow` / `budgetTokens`; the generator's tokenizer is never called. */
export const CHARS_PER_TOKEN = 3.4;
/** §8.2: the default when the pricing table carries no `contextTokens` column for the generator (§14 Q4). */
export const DEFAULT_GENERATOR_CONTEXT_TOKENS = 128_000;
/** §8.2: `contextBudgetChars = clamp(generatorContextTokens × 3.4 × 0.55, 120k, 800k)`. */
export const CONTEXT_BUDGET_SHARE = 0.55;
export const CONTEXT_BUDGET_MIN_CHARS = 120_000;
export const CONTEXT_BUDGET_MAX_CHARS = 800_000;

export function contextBudgetChars(generatorContextTokens: number = DEFAULT_GENERATOR_CONTEXT_TOKENS): number {
  const tokens = Number.isFinite(generatorContextTokens) && generatorContextTokens > 0 ? generatorContextTokens : DEFAULT_GENERATOR_CONTEXT_TOKENS;
  return Math.min(CONTEXT_BUDGET_MAX_CHARS, Math.max(CONTEXT_BUDGET_MIN_CHARS, Math.round(tokens * CHARS_PER_TOKEN * CONTEXT_BUDGET_SHARE)));
}

// §8.3 tiered history
/** the generator sees at least this many recent steps */
export const HISTORY_STEPS = 12;
/** the newest N entries show their output whole (≤ 32 KiB, head 24k + tail 8k) */
export const HISTORY_WHOLE = 2;
export const HISTORY_WHOLE_HEAD = 24 * 1024;
export const HISTORY_WHOLE_TAIL = 8 * 1024;
/** entries 3..6 show head 4k + tail 2k of the same text */
export const HISTORY_MID = 6;
export const HISTORY_MID_HEAD = 4096;
export const HISTORY_MID_TAIL = 2048;
/** an output longer than the window body (600 chars) is written whole to `outputs/step-<n>.txt` so no clip is ever silent */
export const OUTPUT_FILE_MIN_CHARS = WINDOW_OUTPUT_HEAD + WINDOW_OUTPUT_TAIL;
/** §8.3: one output file is at most 1 MiB (head + tail with a marker), the `outputs/` dir at most 64 MiB per run (oldest deleted) */
export const OUTPUT_FILE_MAX_CHARS = 1024 * 1024;
export const OUTPUTS_DIR_MAX_BYTES = 64 * 1024 * 1024;
/** the `read` pseudo-path prefix that serves an output file from the run dir */
export const OUTPUT_READ_PREFIX = 'jevcode:';

// §8.4 files in view
export const FILE_CACHE_MAX_ENTRIES = 16;
export const FILE_MEMORY_MAX_ENTRIES = 64;
/** ≤ 32 KiB of one file in the prompt */
export const FILE_VIEW_MAX_CHARS = 32 * 1024;
/** the default `contextPolicy.fileCacheBytes`: ≤ 96 KiB of file content re-read per step */
export const FILE_CACHE_BYTES = 96 * 1024;
/** §8.9: a file larger than this is never streamed for its raw sha256 at prompt build (the shown window's hash detects change) */
export const FILE_HASH_MAX_BYTES = 1024 * 1024;

// §8.2 fill order shares and floors
export const FILES_SHARE = 0.4;
export const HISTORY_SHARE = 0.3;
export const SUMMARY_MAX_CHARS = 6 * 1024;

// §8.6 compaction
export const COMPACT_EVERY = 8;
/** the built prompt passing this share of the budget triggers a compaction after the step commits */
export const COMPACT_AT_PCT = 85;
/** §8.5 meter colours */
export const METER_AMBER_PCT = 85;
export const METER_RED_PCT = 95;
/** the rolling summary text is at most 3 KiB */
export const SUMMARY_TEXT_MAX_CHARS = 3 * 1024;
export const SUMMARY_OBJECTIVE_CHARS = 400;
export const SUMMARY_BLOCKED_ITEMS = 4;
export const SUMMARY_BLOCKED_CHARS = 200;
export const SUMMARY_ACTIVE_ITEMS = 4;
export const SUMMARY_COMPLETED_ITEMS = 12;
export const SUMMARY_FILES_ITEMS = 16;
export const SUMMARY_NOTES_MAX = 24;

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
  budgetChars: number;
  /** the model's context window in tokens — reported by the meter beside the budget (review finding 51) */
  windowTokens: number;
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * §8.2 / §12.0.1: the policy for one run. `generatorContextTokens` is the pricing table's column when it exists (§14 Q4 is
 * still open, so today the default 128k applies unless `budgetChars` is given outright).
 */
export function resolveContextPolicy(p?: ContextPolicyOptions, generatorContextTokens?: number): ResolvedContextPolicy {
  const compactEvery = p?.compactEvery;
  return {
    view: p?.view ?? 'relaxed',
    historySteps: positive(p?.historySteps, HISTORY_STEPS),
    fileCacheBytes: positive(p?.fileCacheBytes, FILE_CACHE_BYTES),
    compactEvery: compactEvery !== undefined && Number.isFinite(compactEvery) && compactEvery >= 0 ? Math.floor(compactEvery) : COMPACT_EVERY,
    compaction: p?.compaction ?? 'code',
    budgetChars: positive(p?.budgetChars, contextBudgetChars(generatorContextTokens)),
    windowTokens: positive(generatorContextTokens, DEFAULT_GENERATOR_CONTEXT_TOKENS),
  };
}
