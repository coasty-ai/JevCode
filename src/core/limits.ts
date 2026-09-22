/**
 * Numeric bounds shared across the harness.
 *
 * This file is created by orchestration (docs/ORCHESTRATION-DESIGN.md §8.2 wave D0 item 2) and
 * currently holds ONLY the orchestration block. The coordination design owns the rest of it
 * (docs/COORDINATION-DESIGN.md §14 item 3, "`src/core/limits.ts` (new) — every window / history /
 * read / prompt / context bound"): the window bounds of `loop/window.ts:10-15`, the resume bounds
 * of `config/resume.ts:20-24`, the prompt bounds of `provider/prompts.ts:11-24`, the read caps of
 * `loop/stages/execute.ts:64-80` (16 files / 32 KiB / 128 KiB), `session/seed.ts:11` and
 * `CHARS_PER_TOKEN = 3.4`. Those rows land additively when coordination merges; nothing in this
 * block is touched by that merge, and nothing here imports anything.
 */

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
/** §2.6 [D2]: paths per `git add` invocation, so a 200-entry change set stays inside `ARG_MAX`. */
export const ADD_SET_CHUNK = 256;
