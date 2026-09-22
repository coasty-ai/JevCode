/**
 * Bounds of the generator's relaxed context (docs/COORDINATION-DESIGN.md §8.1: "every bound moves to `src/core/limits.ts`").
 *
 * W0 moves the other duplicated copies here (`src/loop/window.ts:10-15`, `resume.ts:20-24`, `prompts.ts:15`, `:220`, `:227`);
 * THIS FILE CARRIES ONLY THE CONTEXT-POLICY CONSTANTS so that the branches landing in parallel union cleanly — add to it,
 * never reorganise it. Nothing here imports anything: it is the leaf both `src/checkpoint/**` and `src/loop/**` read.
 */

/** §12.0.3: the chars-per-token estimate behind `tokensInWindow` / `budgetTokens`; the generator's tokenizer is never called. */
export const CHARS_PER_TOKEN = 3.4;

// --- §8.2 budget ------------------------------------------------------------------------
/** the default when the pricing table carries no `contextTokens` column for the generator (§14 Q4) */
export const DEFAULT_GENERATOR_CONTEXT_TOKENS = 128_000;
/** `generatorContextTokens × CHARS_PER_TOKEN × CONTEXT_BUDGET_SHARE` is the window term */
export const CONTEXT_BUDGET_SHARE = 0.55;
/** the money term spends at most this share of the run's spend cap on prompt input */
export const CONTEXT_BUDGET_SPEND_SHARE = 0.5;
export const CONTEXT_BUDGET_MIN_CHARS = 60_000;
export const CONTEXT_BUDGET_MAX_CHARS = 800_000;
/** a budget above this share of the model window is clamped to the window (and `windowTooSmall` is surfaced) */
export const CONTEXT_BUDGET_WINDOW_MAX_SHARE = 0.9;

// --- §8.3 tiered history ----------------------------------------------------------------
/** the generator sees at least this many recent steps */
export const HISTORY_STEPS = 12;
/** the newest N entries ask for their output whole (≤ 32 KiB, head 24k + tail 8k) */
export const HISTORY_WHOLE = 2;
export const HISTORY_WHOLE_HEAD = 24 * 1024;
export const HISTORY_WHOLE_TAIL = 8 * 1024;
/** §8.2(a): the tier below "whole" — head 12k + tail 4k */
export const HISTORY_CLIPPED_HEAD = 12 * 1024;
export const HISTORY_CLIPPED_TAIL = 4 * 1024;
/** entries 3..6 show head 4k + tail 2k of the same text */
export const HISTORY_MID = 6;
export const HISTORY_MID_HEAD = 4096;
export const HISTORY_MID_TAIL = 2048;
/** §8.3: an output longer than the window body (400 + 200) is written whole, so no size band lacks both a file and a body */
export const OUTPUT_FILE_MIN_CHARS = 600;
/** §8.3: one output file is at most 1 MiB (head + tail with a marker), the `outputs/` dir at most 64 MiB per run */
export const OUTPUT_FILE_MAX_CHARS = 1024 * 1024;
export const OUTPUTS_DIR_MAX_BYTES = 64 * 1024 * 1024;
/** the `read` pseudo-path prefix that serves an output file from the run dir */
export const OUTPUT_READ_PREFIX = 'jevcode:';

// --- §8.4 files in view -----------------------------------------------------------------
export const FILE_CACHE_MAX_ENTRIES = 16;
export const FILE_MEMORY_MAX_ENTRIES = 64;
/** ≤ 32 KiB of one file in the prompt (one `[lines a–b of N]` window when the file is larger) */
export const FILE_VIEW_MAX_CHARS = 32 * 1024;
/** the default `contextPolicy.fileCacheBytes`: ≤ 96 KiB of file content re-read per step */
export const FILE_CACHE_BYTES = 96 * 1024;
/** §8.9: a file larger than this is never streamed for its raw sha256 at prompt build */
export const FILE_HASH_MAX_BYTES = 1024 * 1024;

// --- §8.5 read caps (they rise with the relaxed context) ---------------------------------
/** `read` accepts at most this many paths in one action */
export const READ_MAX_FILES = 16;
/** at most this much of any one file per `read` */
export const READ_MAX_FILE_CHARS = 32 * 1024;
/** at most this much across one `read` action */
export const READ_MAX_TOTAL_CHARS = 128 * 1024;

// --- §8.2 fill order shares and floors ---------------------------------------------------
export const FILES_SHARE = 0.4;
export const HISTORY_SHARE = 0.3;
export const KEPT_MAX_ITEMS = 24;
export const KEPT_ITEM_CHARS = 300;
export const SUMMARY_MAX_CHARS = 6 * 1024;
export const OTHER_SESSIONS_MAX_CHARS = 6 * 1024;

// --- §8.6 compaction ----------------------------------------------------------------------
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

// --- §8.3 restored-state bounds (a checkpoint is untrusted input, §9.3 / §10) -------------
/** `HistoryEntry.action` as §8.3 renders it */
export const HISTORY_ACTION_CHARS = 200;
/** `HistoryEntry.reason` (`WINDOW_REASON_MAX`) */
export const HISTORY_REASON_CHARS = 600;
/** `HistoryEntry.output` (the window body: head 400 + tail 200 plus the marker) */
export const HISTORY_BODY_CHARS = 700;
export const HISTORY_NOTES_MAX = 12;
export const HISTORY_NOTE_CHARS = 400;
export const HISTORY_SHOWN_FILES_MAX = 24;
export const HISTORY_PATH_CHARS = 400;
