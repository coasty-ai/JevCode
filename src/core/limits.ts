/**
 * Numeric bounds shared across the harness (docs/COORDINATION-DESIGN.md §8.1: "every bound moves to `src/core/limits.ts`").
 *
 * Blocks land additively from the parallel designs and are unioned at merge — ADD TO THIS FILE, NEVER REORGANISE IT:
 *   1. the generator's relaxed-context bounds (COORDINATION-DESIGN §8, below);
 *   2. the orchestration bounds (ORCHESTRATION-DESIGN §8.2 D0 item 2, at the end of the file);
 *   3. IMPORT_LIMITS (IMPORT-DESIGN Appendix B) when the import engine merges.
 * W0 still owes the moves of the other duplicated copies (`src/loop/window.ts:10-15`, `resume.ts:20-24`, `prompts.ts:15`,
 * `:220`, `:227`). Nothing here imports anything: it is the leaf both `src/checkpoint/**` and `src/loop/**` read.
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

// ---------------------------------------------------------------------------------------
// Orchestration (docs/ORCHESTRATION-DESIGN.md §8.2 D0 item 2)
// ---------------------------------------------------------------------------------------

/** §3.7: a written manifest is at most this many bytes, redacted and checksummed. */
export const MANIFEST_BYTES = 32 * 1024;
/** §3.7 `AgentSpec.task`: after `redact` + one-lining. */
export const AGENT_TASK_CHARS = 2_000;
/** §3.4 rule 2: `own` globs per agent; prefix-collapsed above this. */
export const OWN_GLOBS_MAX = 32;
/** §3.4 rule 2: one `own` glob is at most this many characters. */
export const OWN_GLOB_CHARS = 200;
/** §3.2: above this the shared-file prelude agent is not worth having and the option is deleted. */
export const PRELUDE_FILES_MAX = 8;
/** §5.1: verification commands per agent. */
export const VERIFY_COMMANDS_MAX = 4;
/** §5.2: lines of a failing verify command's output recorded on the land attempt. */
export const VERIFY_TAIL_LINES = 40;
/** §4.6: lines of an agent's output kept for the row's `Space` peek. */
export const AGENT_TAIL_LINES = 8;
/** §6.4 `orchestrate.agentJsonLineBytes`: longer child json lines are skipped and counted. */
export const AGENT_JSON_LINE_BYTES = 64 * 1024;
/** §3.4 rule 6: `dependsOn` is a DAG of at most this depth. */
export const DEPENDS_DEPTH_MAX = 2;
/** §2.1: depth is a constant, not a setting; `createEngine` refuses more. */
export const ORCHESTRATION_DEPTH_MAX = 1;
/** §2.6 / §3.3: the `## Agents` prompt section — at most this many items … */
export const AGENTS_PROMPT_ITEMS = 8;
/** … each clipped to this many characters. */
export const AGENTS_PROMPT_ITEM_CHARS = 300;
/** §5.2: one `land.jsonl` line is at most this many bytes. */
export const LAND_LOG_LINE_BYTES = 1024;
/**
 * §2.3 [G9] / §3.1 / corner row 16: dirty workspace entries replayed into an agent worktree. Above it
 * the untracked entries are dropped from the sync and above it in TRACKED entries the gate is shut.
 * `src/synth/sieve/lanes.ts:45` holds the same number today and imports this one once the lift of
 * `dirtySnapshot` into `src/orchestrate/worktree.ts` is complete (wave D2 item 17).
 */
export const DIRTY_ENTRIES_MAX = 200;
/**
 * §3.6 / §6.4 `orchestrate.minFreeBytes`: the pre-flight keeps this much disk free after every agent's worktree.
 * A setting in §6.4's table; this is the default the engine uses until `SETTINGS` resolves one (wave D3 item 26).
 */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
/** §3.6 / §6.4 `orchestrate.agentMemBytes`: from the bench's measured 2.9 GB RSS peak, rounded up. */
export const AGENT_MEM_BYTES = 3 * 1024 * 1024 * 1024;
/** §2.6 [D2]: paths per `git add` invocation, so a 200-entry change set stays inside `ARG_MAX`. */
export const ADD_SET_CHUNK = 256;
/**
 * §3.7 [D4]: rows of `ConfirmRequest.headline`. The band it fills is the one `reviewHeaderLines` /
 * `reviewCardLines` would have given `[…RISK_DIMENSIONS gauges, matchesIntent]` — four gauges plus one row —
 * so five is the count that keeps every ladder rung returning exactly what it returned before.
 */
export const HEADLINE_ROWS_MAX = 5;
