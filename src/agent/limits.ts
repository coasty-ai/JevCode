/**
 * Every constant of the agent loop (docs/AGENT-LOOP-DESIGN.md §11). The engine and config values it builds on are
 * re-exported from where they already live, so a reader finds the whole table here and no number is declared twice.
 */
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../config/defaults.js';

export { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS };

/** floor of a turn's `maxTokens` (§6.3): the global 4,096 default is too small for a turn that writes a file */
export const AGENT_MAX_OUTPUT_TOKENS = 16_384;
/** calls kept from one reply; also the `StepAgentSummary.calls` cap */
export const AGENT_MAX_CALLS_PER_TURN = 32;
/** concurrent read-only calls in an observe batch */
export const AGENT_PARALLEL_READS = 8;
/** an observe step's `output` for the window and history; the transcript keeps each result whole */
export const AGENT_OBSERVE_OUTPUT_CHARS = 65_536;
/** continuation nudges per run (§3.3 rule 1) */
export const AGENT_CONTINUE_MAX = 2;
/** verification interventions per run, only under agent.verify tests (§3.3 rule 2) */
export const AGENT_VERIFY_MAX = 2;
/** the verify step's timeout, only under agent.verify tests (§3.3 rule 2); clamped to the wall time left */
export const AGENT_VERIFY_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;
/** review declines before `human_pause` (the engine stops; the driver only counts) */
export const AGENT_MAX_BLOCKS = 5;

/** §3.6 loop detection */
export const AGENT_LOOP_CONSECUTIVE = 3;
export const AGENT_LOOP_WINDOW = 10;
export const AGENT_LOOP_WINDOW_MAX = 5;
export const AGENT_MAX_LOOP_NUDGES = 5;

/** §3.6 progress check (RA2): Gemini CLI's constants */
export const AGENT_PROGRESS_FIRST_TURN = 30;
export const AGENT_PROGRESS_EVERY = 10;
export const AGENT_PROGRESS_THRESHOLD = 0.9;

/** §4.8 post-write syntax check */
export const AGENT_CHECK_TIMEOUT_MS = 5_000;
export const AGENT_CHECK_MAX_LINES = 20;

/** §4.6 read_file */
export const AGENT_READ_MAX_CHARS = 40_000;
export const AGENT_READ_DEFAULT_LINES = 2_000;
export const AGENT_READ_LINE_CHARS = 2_000;
/** the file size the driver reads (read_file, edit_file matching, the syntax check's pre-image) */
export const AGENT_FILE_MAX_BYTES = 1024 * 1024;
/** `read_file` with `paths: [...]` reads at most this many files in one call (§4.4 step 3) */
export const AGENT_READ_MAX_PATHS = 8;

/** §4.6 grep */
export const AGENT_GREP_TIMEOUT_MS = 20_000;
export const AGENT_GREP_DEFAULT_RESULTS = 100;
export const AGENT_GREP_MAX_RESULTS = 500;
export const AGENT_GREP_MAX_CHARS = 20_000;
/** files the JavaScript fallback (no ripgrep) reads at once; it scans every listed file until AGENT_GREP_TIMEOUT_MS */
export const AGENT_GREP_PARALLEL_READS = 16;
/** `rg --version`, probed once per run */
export const AGENT_RG_PROBE_TIMEOUT_MS = 5_000;

/** §4.6 glob */
export const AGENT_GLOB_MAX_PATHS = 500;

/** §4.7 todo_write */
export const AGENT_TODO_MAX_ITEMS = 30;
export const AGENT_TODO_ITEM_CHARS = 200;

/** §7.2 bash inline caps: exit 0 */
export const AGENT_BASH_OK_INLINE = 30_000;
export const AGENT_BASH_OK_HEAD = 12_000;
export const AGENT_BASH_OK_TAIL = 4_000;
/** §7.2 bash inline caps: non-zero exit, timeout or kill (errors are usually at the end) */
export const AGENT_BASH_FAIL_INLINE = 10_000;
export const AGENT_BASH_FAIL_HEAD = 3_000;
export const AGENT_BASH_FAIL_TAIL = 7_000;

/** §7.1 budget */
export const AGENT_CONTEXT_WINDOW_SHARE = 0.9;
export const AGENT_CONTEXT_CAP_TOKENS = 200_000;
/** the window assumed when neither the pricing table nor the policy knows it */
export const AGENT_DEFAULT_WINDOW_TOKENS = 128_000;

/** §7.3 masking */
export const AGENT_MASK_AT = 0.5;
export const AGENT_MASK_MIN_RECLAIM_CHARS = 20_000;
export const AGENT_MASK_KEEP_RESULTS = 6;
export const AGENT_MASK_MIN_RESULT_CHARS = 800;
export const AGENT_ANTHROPIC_CLEAR_AT_LEAST_TOKENS = 5_000;

/** §7.4 compaction */
export const AGENT_COMPACT_AT = 0.85;
export const AGENT_COMPACT_KEEP_RESULTS = 3;
export const AGENT_COMPACT_RESULT_CHARS = 4_000;
export const AGENT_COMPACT_FILES = 5;
export const AGENT_COMPACT_FILE_CHARS = 6_000;
export const AGENT_COMPACT_SUMMARY_TOKENS = 2_000;
/** the code writer's findings section: the last 3 assistant texts, 600 chars each */
export const AGENT_COMPACT_FINDINGS = 3;
export const AGENT_COMPACT_FINDING_CHARS = 600;
/** the removed turns the llm writer reads are bounded to this many chars (one result is clipped to 2,000) */
export const AGENT_COMPACT_SOURCE_CHARS = 240_000;
export const AGENT_COMPACT_SOURCE_RESULT_CHARS = 2_000;

/** §5.3, §7.6 chat carry */
export const AGENT_CHAT_CARRY_TURNS = 20;
export const AGENT_CHAT_CARRY_CHARS = 14_000;

/** §5.3 first user message */
export const AGENT_DIRTY_PATHS_SHOWN = 8;
export const AGENT_TOP_LEVEL_ENTRIES = 40;
export const AGENT_PINNED_FILES = 3;
export const AGENT_PINNED_FILE_BYTES = 8 * 1024;
export const AGENT_SEED_TASK_CHARS = 300;

/** §3.2 `proposal.rawText` and the finish summary */
export const AGENT_RAW_TEXT_CHARS = 4_000;
export const AGENT_FINISH_SUMMARY_CHARS = 2_000;

/** §10 `CheckpointState.agentState` */
export const AGENT_STATE_MAX_BYTES = 65_536;

/** §13.1 rule 1: every in-run Jev placement */
export const JEV_QUICK_DEADLINE_MS = 400;
/** §A4: the first-turn effort hint (RA0) has a tighter deadline, since it sits in front of the first request */
export const JEV_EFFORT_HINT_DEADLINE_MS = 300;
/** §A4: P(conversational) at or above this sends the first turn at the provider's low effort */
export const JEV_EFFORT_HINT_THRESHOLD = 0.8;
/** §A4: RA0 reads the message and the session's last 2 turn one-liners */
export const JEV_EFFORT_HINT_MESSAGE_CHARS = 600;
export const JEV_EFFORT_HINT_TURNS = 2;
/** RA1 reads the last 6 step one-liners, RA2 the last 10 (§13.3) */
export const JEV_NUDGE_RECENT_STEPS = 6;
export const JEV_PROGRESS_RECENT_STEPS = 10;
export const JEV_PROGRESS_TASK_CHARS = 600;

/** §3.2: the tool-call ids of one turn that the model could not have meant to repeat get `call_<turn>_<i>` */
export const AGENT_SYNTHETIC_ID_PREFIX = 'call_';
