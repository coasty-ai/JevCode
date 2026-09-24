/**
 * Numeric bounds shared across the harness (docs/COORDINATION-DESIGN.md §8.1: "every bound moves to `src/core/limits.ts`").
 *
 * Blocks land additively from the parallel designs and are unioned at merge — ADD TO THIS FILE, NEVER REORGANISE IT:
 *   1. the generator's relaxed-context bounds (COORDINATION-DESIGN §8, below);
 *   2. the orchestration bounds (ORCHESTRATION-DESIGN §8.2 D0 item 2, at the end of the file);
 *   3. IMPORT_LIMITS (IMPORT-DESIGN Appendix B, at the end of the file).
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
/**
 * contract 1.4 (COORDINATION-DESIGN §8.8 / §9, W2b follow-up): `## Other sessions` is filled from the coordination
 * runtime's `currentFacts()`, so its size follows the number of peers rather than a fixed 6 KiB. It takes at most
 * this share of the step's budget (`OTHER_SESSIONS_MAX_CHARS` still caps it absolutely): a peer's facts are the
 * cheapest section to lose — they are advisory, they are re-derived every step, and the section says so when it
 * clips. At the `CONTEXT_BUDGET_MIN_CHARS` floor this is 3,000 chars, which holds the ≤ 8 conflicts and ≤ 8
 * requests `buildFacts` may carry plus the first messages.
 */
export const OTHER_SESSIONS_SHARE = 0.05;

/**
 * contract 1.4 (COORDINATION-DESIGN §8.8 column 3) / TUI-DESIGN-5 §8.2 R13: the share of ONE `propose_fix` sample's
 * user message that `SynthesisContext.contextText` may take (`src/jev-modes/synth/llm/source.ts`). The fix prompt's own sections
 * are bounded by `PROMPT_LIMITS_FIX` — `fixPromptCharBound()` is ~120 k chars at the 4-listing default — so 24 KiB is
 * a tenth of the message and ~7 k tokens at `CHARS_PER_TOKEN`: enough for the task, the plan, the files in view and
 * the recent steps, and never enough to displace the code the sample has to edit. A longer view is clipped HEAD-first
 * (the head carries the task and the plan; the tail is the oldest history) with a named notice — §8.2's "no clip is
 * silent" — never truncated in silence.
 */
export const LLM_SAMPLE_CONTEXT_MAX_CHARS = 24 * 1024;

// --- §3.2 / §9.3 run claims (COORDINATION-DESIGN W0 item 1) -----------------------------
/**
 * contract 1.4: `RunMeta.claims[]` is capped at 64 — the FIRST row (the origin incarnation, which is the
 * provenance) plus the newest 63 (§3.2, §4.6 row 1 as amended). Only the origin and the maximum are ever read, so
 * pruning the middle is lossless.
 *
 * This is the file-header move of the duplicated copy in `src/coordination/claims.ts`: `src/checkpoint/**` writes
 * the capped array and must not import the ledger to learn the bound, and this module imports nothing, which is
 * exactly why it exists. `test/unit/checkpoint/run-claims.test.ts` pins the two to the same number.
 */
export const MAX_CLAIMS_PER_RUN = 64;

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
 * `src/jev-modes/synth/sieve/lanes.ts:45` holds the same number today and imports this one once the lift of
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

// ---------------------------------------------------------------------------------------
// Import (docs/IMPORT-DESIGN.md Appendix B) — unioned at merge; the block above it is orchestration, above that the
// relaxed-context bounds. ADD, NEVER REORGANISE.
// ---------------------------------------------------------------------------------------

/**
 * §2.8 / Appendix B. Frozen by `as const` so a caller cannot widen a bound at runtime; every
 * value is a positive finite number and the two shares sit in `(0, 0.5)`
 * (`test/unit/core/limits.test.ts`).
 */
export const IMPORT_LIMITS = {
  // ----- discover (§4.2.2) -----
  /** deepest real artefact observed is `~/.claude/projects/<slug>/<session>/subagents/x.jsonl` (depth 5) */
  walkDepth: 8,
  /** per root; `~/.claude/projects` alone is 10,220 entries today */
  walkEntries: 20_000,
  /** per root; a cold NFS `$HOME` must not hang the wizard */
  walkMs: 2_000,
  /** one atlas row cannot produce 3,371 plan rows */
  filesPerRow: 512,
  /** `= INSTRUCTIONS_READ_CAP_BYTES` (`config/instructions.ts:24`) */
  sourceReadCapBytes: 4 * 1024 * 1024,
  /** metadata pass only; the largest transcript on the author's machine is 151 MB */
  transcriptScanBytes: 256 * 1024,
  /** a NUL in this prefix means the file is not text (§4.4.1 rule 5) */
  binarySniffBytes: 8 * 1024,
  /** stat→read race slack (§6 row 31) */
  readSlackBytes: 64 * 1024,

  // ----- destination (§2.2, §2.8) -----
  memoryDirBytes: 512 * 1024,
  memoryFiles: 200,
  /** Claude's own index cap is 200 lines / 25 KB */
  memoryIndexLines: 200,
  memoryIndexBytes: 8 * 1024,
  topicBytes: 8 * 1024,
  /** Windsurf's own rule cap is 12,000 chars → clipped with a notice */
  ruleBytes: 4 * 1024,
  commandBytes: 8 * 1024,
  /** keeps `AGENTS.md` under `INSTRUCTIONS_MAX_BYTES` (32 KiB) with headroom */
  agentsAppendBytes: 8 * 1024,
  /** per rule, after brace expansion */
  rulePatterns: 200,
  /** rule files a session matches against per step [G1.6] */
  ruleFiles: 200,
  mcpServers: 64,
  /** `slugOf` output cap [G1.2] */
  slugMaxChars: 64,

  // ----- prompt: shares of the step's context budget (§2.10.3) [G2.7] -----
  /** the `## Memory (index)` system-prompt section, once per run */
  memoryIndexPromptBytes: 8 * 1024,
  rulesInScopeShare: 0.1,
  rulesInScopeMin: 2 * 1024,
  rulesInScopeMax: 12 * 1024,
  memoryInScopeShare: 0.14,
  memoryInScopeMin: 2 * 1024,
  memoryInScopeMax: 16 * 1024,

  // ----- jev (§4.4.3) -----
  /** `assertQuestionBatch` (`jev/questions.ts:102`) caps at 1,000; the import budget is far under it */
  jevRequests: 3,
  jevQuestions: 400,
  jevHeadings: 5,
  jevHeadingCells: 80,
  /** only under `--jev-sample=head400` [G2.4] */
  jevSentenceChars: 200,

  // ----- plan (§4.5) -----
  planRows: 2_000,
  /** bounds the O(N²) Jaccard pass [G1.6] */
  dedupePairs: 20_000,
  minhashBands: 8,

  // ----- artefacts (§4.6, §4.7.6) -----
  reportBytes: 1 * 1024 * 1024,
  sourceLineBytes: 2 * 1024,
  /** newest import dirs kept; the rest are GC'd at the start of the next import [G1.4] */
  importsKeep: 10,
  lockStaleMs: 10 * 60 * 1000,
} as const;

/** The literal type of `IMPORT_LIMITS`, for callers that thread a narrowed copy through a seam. */
export type ImportLimits = typeof IMPORT_LIMITS;

// --- contract 1.9 (Fastlane) §3.2: the generator-path hedge (docs/LLM-LOOP-DESIGN.md §3.2) -------
/**
 * Hedge twins one LLM round may fire. One — a hedge is a second copy of a sample that has not
 * produced a first byte, and a second copy per round is already the whole of what the latency
 * tail costs; more turns a slow provider into a spend multiplier. The twin is booked at full
 * estimated cost like every other sample, and the round refuses it when the dollar counter
 * cannot hold one more, so a hedge storm can never leave a goal with zero rounds (§3.2).
 *
 * Shared, so it lives here rather than beside one owner (§3.5).
 */
export const LLM_HEDGES_PER_ROUND = 1;
/** §3.2: the hedge threshold is `clamp(factor × the running TTFB p50, minMs, maxMs)`; a sample silent that long is hedged. */
export const LLM_HEDGE_AFTER = { factor: 2, minMs: 3_000, maxMs: 8_000 } as const;
