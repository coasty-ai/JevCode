# 10 — Sessions and multi-turn semantics in agent CLIs, mapped onto JevCode's run/checkpoint model

Research note for the interactive JevCode TUI. Fetch date for every source: **2026-09-20**. Primary sources are
raw source files (`raw.githubusercontent.com`, branch named in the URL), official docs pages, and files under
`~/.jevcode/runs` and this repo. Where a page could not be fetched the item is marked **UNVERIFIED** with what was
tried. Quotes are verbatim unless marked "(summary)". Method notes are in §0; the JevCode proposal starts at §15;
ADOPT/REJECT tables and open questions close the file.

## 0. Method and what could not be verified

- `gh` is not installed on this machine; `api.github.com` unauthenticated listings were exhausted after 4 calls
  (`x-ratelimit-remaining: 0`, HTTP 403), so directory listings came from `github.com/<owner>/<repo>/tree/...`
  HTML pages and file contents from `raw.githubusercontent.com` (not rate-limited the same way).
- The Codex docs moved: `https://developers.openai.com/codex/cli/reference`, `/codex/cli/features` and
  `/codex/config-reference` all return `308` to `https://learn.chatgpt.com/docs/...` (observed 2026-09-20). The
  `docs/*.md` files in `openai/codex` are 100–700-byte stubs pointing at those pages
  (https://raw.githubusercontent.com/openai/codex/main/docs/getting-started.md, 177 bytes, fetched 2026-09-20).
  The redirected pages were fetched through a summarising fetcher; text from them is marked "(summary)" and only
  used where the Rust source confirms it.
- **UNVERIFIED**: Crush TUI key bindings for the session switcher (`https://github.com/charmbracelet/crush/tree/main/internal/tui`
  returned 404; the README names only `ctrl+l` model picker and `ctrl+p` command palette). Gemini's default
  keybinding source (`packages/cli/src/config/keyBindings.ts` 404) — the docs page
  `docs/reference/keyboard-shortcuts.md` was used instead. Codex `/undo`: the summarised docs page mentions it,
  but `codex-rs/tui/src/slash_command.rs` (fetched 2026-09-20) has **no** `Undo` variant and
  `codex-rs/core/src/config/mod.rs` calls `ghost_snapshot` "Compatibility-only config", so `/undo` is treated as
  removed. opencode server-side pickup of a prompt sent while a session is busy: the TUI sends it regardless of
  status (`packages/tui/src/component/prompt/index.tsx` line 1095 calls `sdk.client.session.prompt(` with no idle
  gate); how `session/prompt.ts` merges it into the running loop was not traced line by line.

## 1. What a "session" is, per tool

| Tool | Unit | Identity | Source |
| --- | --- | --- | --- |
| Claude Code | "A session is a saved conversation tied to a project directory. Claude Code stores it locally as you work, so you can resume where you left off, branch to try a different approach, or switch between tasks." | UUID (`--session-id` "must be a valid UUID"); optional name (`--name`, `/rename`); AI title from first prompt | https://code.claude.com/docs/en/sessions ; https://code.claude.com/docs/en/cli-reference (fetched 2026-09-20) |
| opencode | Session row: `id`, `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `title`, `version`, `share_url`, `summary_*`, `cost`, `tokens_input/output/reasoning/cache_read/cache_write`, `revert`, `permission`, `agent`, `model`, `time_compacting`, `time_archived` | id + slug; default title `New session - <ISO time>` (`isDefaultTitle` regex); fork title `${title} (fork #1)` | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/session/sql.ts ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/session.ts (fetched 2026-09-20) |
| Codex | "thread" = one rollout JSONL file; `SessionMeta { session_id, id, forked_from_id, forked_from_ordinal_exclusive, parent_thread_id, timestamp, cwd, runtime_workspace_roots, originator, cli_version, agent_nickname, agent_role, agent_path, source, thread_source, model_provider, base_instructions, dynamic_tools, ... }` | ThreadId (UUID) in the filename | https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs lines 915–945 (fetched 2026-09-20) |
| Gemini CLI | "The complete conversation history, including: Your prompts and the model's responses. All tool executions (inputs and outputs). Token usage statistics (input, output, cached, etc.). Assistant thoughts and reasoning summaries" | UUID (`sessionId`), per `projectHash` | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md (fetched 2026-09-20) |
| Crush | SQLite `sessions(id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at)`; Go struct adds `EstimatedUsage`, `SummaryMessageID` | id; title (a child "title session" is created with `Title: "Generate a title"`) | https://raw.githubusercontent.com/charmbracelet/crush/main/internal/db/migrations/20250424200609_initial.sql ; https://raw.githubusercontent.com/charmbracelet/crush/main/internal/session/session.go (fetched 2026-09-20) |

Observation: every tool separates a small **index row** (title, time, cwd, counts/cost) from the **transcript
body**. Crush and opencode keep the row in SQLite; Codex mirrors JSONL metadata into SQLite ("This crate ... extracts
rollout metadata from JSONL rollouts and mirrors it into a local SQLite database",
https://raw.githubusercontent.com/openai/codex/main/codex-rs/state/src/lib.rs, fetched 2026-09-20); Claude Code
scans `.jsonl` transcripts. JevCode can have the same split with a JSONL index (Node built-ins only; no SQLite).

## 2. Storage: paths and formats

| Tool | Path | Format | Source |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<project>/<session-id>.jsonl`, "`<project>` is your working directory path with non-alphanumeric characters replaced by `-`"; over 200 chars: truncated + hash. Also `projects/<project>/<session>/subagents/`, `<session>/tool-results/`, `file-history/<session>/` ("Pre-edit snapshots for checkpoint restore (100 most recent)"), `history.jsonl` ("Every prompt typed with timestamp and project path (used for up-arrow recall, `Ctrl+R` search)"), `sessions/` ("One small file per running session (for detecting concurrent sessions and crashes)") | JSONL: "Each line is a JSON object for a message, tool use, or metadata entry. The entry format is internal to Claude Code and changes between versions" | https://code.claude.com/docs/en/sessions ; https://code.claude.com/docs/en/claude-directory (fetched 2026-09-20) |
| Claude Code retention | "Files are deleted once older than `cleanupPeriodDays` (default: 30 days, minimum: 1)"; exempt: `history.jsonl`, `stats-cache.json`, auto memory | — | https://code.claude.com/docs/en/claude-directory (fetched 2026-09-20) |
| opencode | `Global.Path.data = path.join(xdgData!, "opencode")` (so `~/.local/share/opencode`); legacy JSON store `<data>/storage/{project,session,message,part,session_diff}/*.json` with a `migration` marker; current rows in SQLite via drizzle (`SessionTable`, `MessageTable`, `PartTable` with `data: text({ mode: "json" })`); undo snapshots `<data>/snapshot/<project.id>/<Hash.fast(worktree)>` as a bare git dir; plans `<worktree>/.opencode/plans/<created>-<slug>.md` | JSON files → SQLite; JSON blobs per message/part | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/global.ts ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/session/sql.ts ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/snapshot/index.ts line 71 (fetched 2026-09-20) |
| Codex | `// Resolve ~/.codex/sessions/YYYY/MM/DD path.` then `SESSIONS_SUBDIR` / `year` / `%02 month` / `%02 day`; `pub const SESSIONS_SUBDIR: &str = "sessions"; pub const ARCHIVED_SESSIONS_SUBDIR: &str = "archived_sessions";` filename `rollout-{timestamp}-{thread_id}.jsonl` with timestamp `[year]-[month]-[day]T[hour]-[minute]-[second]`; SQLite mirror home overridable by `CODEX_SQLITE_HOME` | JSONL `RolloutLine { timestamp, ordinal, item }`; `history.persistence` = `save-all | none`, `history.max_bytes` (summary of config reference) | https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs lines 1700–1720 ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/lib.rs lines 84–85 ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/rollout_file_name.rs ; https://learn.chatgpt.com/docs/config-file/config-reference (summary) (fetched 2026-09-20) |
| Gemini CLI | "Sessions are stored in `~/.gemini/tmp/<project_hash>/chats/`"; filename `${SESSION_FILE_PREFIX}${timestamp}-${safeSessionId.slice(0, 8)}.jsonl` where timestamp is ISO minus seconds with `:`→`-`; subagents nested under the parent id; first record is the metadata `{ sessionId, projectHash, startTime, lastUpdated, kind, directories }`; legacy `.json` files are renamed to `.jsonl` on resume | JSONL with record kinds: message (`id`), `$set` (metadata/checkpoint rebuild), `$rewindTo`; writes go through `${file}.tmp-${pid}` | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md ; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts lines 476–545, 58–68, 619 (fetched 2026-09-20) |
| Gemini retention | `general.sessionRetention { enabled: true, maxAge: "30d", maxCount: 50 }`, `minRetention` default `"1d"`; `model.maxSessionTurns` (-1 unlimited) | — | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md (fetched 2026-09-20) |
| Crush | Config: `./.crushrc`, `./crushrc`, `~/.config/crush/crushrc` ("A `crushrc` is just Bash with some Crush-specific builtins"); "Data directories such as `~/.local/share/crush` and `%LOCALAPPDATA%\crush` contain JSON state only"; per-project `data_directory` default `.crush` ("Directory for storing application data. Relative paths are resolved against the working directory") and logs `./.crush/logs/crush.log` | SQLite (goose migrations: `add_summary_message_id`, `add_is_summary_message`, `add_todos_to_sessions`, `add_read_files_table`, ...) | https://raw.githubusercontent.com/charmbracelet/crush/main/README.md ; https://raw.githubusercontent.com/charmbracelet/crush/main/internal/config/config.go line 389 ; https://github.com/charmbracelet/crush/tree/main/internal/db/migrations (fetched 2026-09-20) |

## 3. `--continue` / `--resume` and the picker

### 3.1 Flags

- Claude Code `--continue, -c`: "Load the most recent conversation in the current directory ... Skips sessions
  created with `claude -p` or the Agent SDK, and sessions whose first prompt was `/loop`." `--resume, -r`: "Resume a
  specific session by ID or name, or show an interactive picker to choose a session. In place of an ID, you can
  pass the absolute path to a session's `.jsonl` transcript file." `--fork-session`: "When resuming, create a new
  session ID instead of reusing the original". `--no-session-persistence`: "Disable session persistence so sessions
  are not saved to disk and cannot be resumed. Print mode only." (https://code.claude.com/docs/en/cli-reference,
  fetched 2026-09-20). "if there isn't one yet, it prints `No conversation found to continue` and exits"
  (https://code.claude.com/docs/en/common-workflows, fetched 2026-09-20).
- opencode `run`: `--continue`/`-c` "continue the last session", `--session`/`-s` "session id to continue", `--fork`
  "fork the session before continuing (requires --continue or --session)", `--title` "title for the session (uses
  truncated prompt if no value provided)", `--format` "format: default (formatted) or json (raw JSON events)",
  `--replay` "replay interactive session history on resume and after resize (use --no-replay to disable)",
  `--replay-limit` "cap visible interactive replay to the newest N messages"
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/run.ts lines 143–236,
  fetched 2026-09-20). `opencode` (TUI) has the same `--continue/--session/--fork/--prompt`
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/tui.ts lines 86–102).
  `opencode session list` prints `Session ID | Title | Updated` (title width ≥ 25, `Locale.todayTimeOrDateTime`),
  `--format json` gives `{ id, title, updated, created, projectId, directory }`, and pipes through `less -R -S` on a
  TTY (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/session.ts).
- Codex: `codex resume` "Continue a previous interactive session by ID or resume the most recent chat", `--last`,
  `--all` "to include sessions outside current directory", `codex fork`, `codex archive/unarchive/delete <SESSION>`,
  `codex exec resume [SESSION_ID]` (summary of https://learn.chatgpt.com/docs/developer-commands?surface=cli, fetched
  2026-09-20). Source confirms sort keys "Created"/"Updated" and a footer `" enter resume   esc new   ctrl+c quit\n
  ctrl+o comfy   ctrl+t preview"` plus hints `"esc start new"`, `"esc clear search"`, `"ctrl+o dense view"`,
  `"ctrl+t transcript"`, `"ctrl+e expand"`, `"Type to search"`, `"Search scanned first {} sessions; more may exist"`,
  `"Loading older sessions…"` (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/resume_picker.rs
  lines 801–803, 2118, 3502, 4488–4639, fetched 2026-09-20).
- Gemini: `--resume`/`-r` "Resume a previous session. Use `"latest"` for most recent or index number (for example
  `--resume 5`)", `--list-sessions` "List available sessions for the current project and exit", `--delete-session`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md lines 65–67, fetched
  2026-09-20). `gemini -r "latest" "query"` = "Continue session with a new prompt" (same page line 16). List output:
  `1. Fix bug in auth (2 days ago) [a1b2c3d4]` (session-management.md).
- Crush: root and `run` both take `-s/--session` "Continue a previous session by ID" and `-C/--continue` "Continue the
  most recent session"; `run` adds `-q/--quiet` "Hide spinner", `-v/--verbose`, `-m/--model`, `--small-model`,
  `--reasoning-effort` (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/run.go lines 168–174 ;
  https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/root.go lines 55–64, fetched 2026-09-20).

### 3.2 What the picker lists and its keys

- Claude Code: "Each row shows the session name if you set one, otherwise the AI-generated session title,
  conversation summary, or first prompt, along with time since last activity, git branch, and file size. Widen to all
  projects with `Ctrl+A` to also see each session's project path." Keys: `↑/↓`, `→/←` "Expand or collapse grouped
  sessions", `Enter`, `Space` "Preview the session content", `Ctrl+R` rename, `/` or any printable char = search
  ("Paste a GitHub ... pull or merge request URL to find the session that created it"), `Ctrl+A` all projects,
  `Ctrl+W` all worktrees, `Ctrl+B` current branch, `Esc`. Default scope: "Sessions from the current worktree" plus
  sessions that "added the current directory with `/add-dir`". Background sessions are "marked `bg`"
  (https://code.claude.com/docs/en/sessions, fetched 2026-09-20). Cost is **not** a column; `/cost` is per session.
- Codex: `ThreadItem { first_user_message, preview, cwd, git_branch, created_at ("from the filename timestamp with
  second precision"), updated_at (file mtime) }`; scan caps `MAX_SCAN_FILES = 10000`, `HEAD_RECORD_LIMIT = 10`,
  `USER_EVENT_SCAN_LIMIT = 200`; paginated by a `Cursor { ts, id }` "stable by the requested sort key"
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/list.rs lines 52–135, 165–200, fetched
  2026-09-20). Picker shows time, cwd, initial message, git branch (summary of https://learn.chatgpt.com/docs/codex/cli).
- Gemini Session Browser: columns `Index │ Msgs │ Age │ Name` (or `Match` while searching), 20 per page
  (`SESSIONS_PER_PAGE = 20`), `sortOrder: 'date' | 'messages' | 'name'`, `x` deletes, `/` searches "by ID or content",
  `Enter` resumes, `Esc` exits (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/components/SessionBrowser.tsx
  lines 107, 133–158, 359 ; docs/cli/session-management.md, fetched 2026-09-20).
- Crush: picker shows `IsBusy` ("set while an agent turn is in flight for that session") and `AttachedClients`
  ("how many clients are currently viewing it") because "Two clients with the same `--cwd` join the same underlying
  workspace" (https://raw.githubusercontent.com/charmbracelet/crush/main/README.md "Sharing a workspace across
  clients", fetched 2026-09-20). Sessions carry `cost`, `prompt_tokens`, `completion_tokens` in the row itself.

## 4. What a resume restores; transcript replay

- Claude Code: "Conversation history: the full history, including tool calls and results. A tool that was still
  running when the previous process ended ... doesn't finish or run again when you resume". "Model: the session
  continues on the model it was using." Permission mode is restored only on the terminal path, not from the picker or
  `/resume`. "Not every configuration flag from the original launch is restored. If the session depended on
  `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or directories added with `--add-dir`, pass them
  again". "If you resume the same session in two terminals without forking, messages from both interleave into one
  transcript." Large idle sessions get a dialog: "Resume from summary: runs `/compact` immediately ... Resume full
  session as-is ... Don't ask me again" (https://code.claude.com/docs/en/sessions, fetched 2026-09-20).
- opencode: interactive mini mode replays history on resume (`--replay`, `--replay-limit`); the TUI streams the
  stored messages from the server (run.ts lines 225–234, fetched 2026-09-20).
- Gemini: `/rewind` → "`recordingService.rewindTo(messageId)` ... `client.setHistory(clientHistory)`" — the UI history
  is rebuilt from the recorded messages
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/commands/rewindCommand.tsx,
  fetched 2026-09-20).
- JevCode today: "Resume always begins a new step at `intent`; no stage is ever re-run and no recorded proposal is
  replayed" and `--resume` "loads `state.json` ... as the sole truth, then reads `steps.jsonl` and, for every record
  with `step > state.step`, folds that record's own content ... into the window" (DESIGN.md §9; `src/checkpoint/resume.ts`
  `foldStepsIntoState`). Config on resume: "Task, workspace, mode, provider, generator and decider models ... are
  taken from `run.json` and replace the normal precedence chain (a run must stay comparable with itself)" (DESIGN.md §9).

## 5. Queueing while the agent runs; steering; Esc

- Claude Code: "Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of
  interrupting the turn, and lists the queued entries above the input box until it sends them." Delivery rule:
  "if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool
  calls finish, within the same turn. When the turn ends with messages still queued, Claude Code sends only the
  oldest as the next turn." Commands "are held until the turn ends, then run ... one at a time". "Press `Esc` to
  interrupt the turn instead. Claude Code keeps what you queued and sends it right away." Take-back: "Press `Up` from
  the first line of the input box to take back the queued messages" (https://code.claude.com/docs/en/interactive-mode
  "Queue messages while Claude works", fetched 2026-09-20). `Esc`: "Interrupt Claude, or close a dialog ... Claude
  keeps the work done so far." `Esc`+`Esc`: "When the prompt input contains text, double `Esc` clears it and saves the
  draft to history so `Up` recalls it. When the input is empty, double `Esc` opens the rewind menu" (same page).
  Checkpoint consequence: "When a message you queue ... reaches Claude within the running turn, it joins that turn
  instead of starting a new one. ... Claude Code doesn't create a checkpoint for it"
  (https://code.claude.com/docs/en/checkpointing, fetched 2026-09-20).
- Codex TUI: `InputQueueState` has `queued_user_messages: VecDeque<QueuedUserMessage>` ("User inputs queued while a
  turn is in progress."), `rejected_steers_queue` ("User messages that tried to steer a non-regular turn and must be
  retried first."), `pending_steers` ("Steers already submitted to core but not yet committed into history."),
  `submit_pending_steers_after_interrupt` ("When set, the next interrupt should resubmit all pending steers as one
  fresh user turn instead of restoring them into the composer.")
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget/input_queue.rs lines 22–52,
  fetched 2026-09-20). The edit-queued binding is `Alt+Up`, falling back to `Shift+Left` under tmux, Apple Terminal,
  Warp and VS Code because they "intercept or silently swallow Alt+Up"
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget.rs lines 191–222). Queue persists:
  `pub const MAX_QUEUE_ITEMS: usize = 100;` "Maximum number of pending user submissions permitted for one thread." and
  `QueuedUserSubmissionRecord` in SQLite (https://raw.githubusercontent.com/openai/codex/main/codex-rs/state/src/lib.rs).
  `is_normal_backtrack_mode`: "In this state Esc-Esc backtracking is enabled." (chatwidget.rs line 1781). Docs
  (summary): `Tab` queues a follow-up, `Esc Esc` "Edit previous message and fork"
  (https://learn.chatgpt.com/docs/developer-commands?surface=cli, fetched 2026-09-20).
- Gemini: `input.queueMessage` = `Tab` "Queue the current prompt to be processed after the current task finishes.";
  `basic.quit` = `Ctrl+C` "Cancel the current request or quit the CLI when input is empty."; `basic.cancel` = `Esc`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/keyboard-shortcuts.md lines 13–16,
  92, fetched 2026-09-20). Implementation joins queued messages: `messageQueue.join('\n\n')` submitted when
  `streamingState === StreamingState.Idle && !isCompressing && isMcpReady`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/hooks/useMessageQueue.ts).
- opencode: `session_interrupt: escape` (https://opencode.ai/docs/keybinds/, fetched 2026-09-20). The prompt
  component requires **two presses within 5 s**: `setStore("interrupt", store.interrupt + 1); setTimeout(() =>
  setStore("interrupt", 0), 5000); if (store.interrupt >= 2) { void sdk.client.session.abort(...) }` and the hint
  text toggles `"again to interrupt"` / `"interrupt"`
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/component/prompt/index.tsx lines 392–425,
  1587–1590, fetched 2026-09-20). Server-side, a running session is `status.set(sessionID, { type: "busy" })` and
  mutating operations `assertNotBusy` (`session/prompt.ts` line 1089; `session/revert.ts` line 40).

## 6. /undo, /rewind, /restore — what reverts

| Tool | Command | Reverts | Mechanism / limits | Source |
| --- | --- | --- | --- | --- |
| Claude Code | `/rewind` or `Esc Esc` (empty input) | Menu: "Restore code and conversation", "Restore conversation", "Restore code", "Summarize from here", "Summarize up to here", "Never mind"; code options appear "only when the selected checkpoint has tracked file changes" | "Every prompt you send that starts a turn creates a new checkpoint"; "file snapshots for the 100 most recent checkpoints"; "Checkpointing does not track files modified by Bash commands"; subagent edits, external changes, symlinked/hard-linked paths not restored ("`Restored the code, but skipped N files`"); snapshots swept after ~30 days | https://code.claude.com/docs/en/checkpointing (fetched 2026-09-20) |
| opencode | `/undo` "Undo last message in the conversation" (`ctrl+x u`), `/redo` (`ctrl+x r`); config `"snapshot": false` disables | `SessionRevert.revert`: walks messages, collects `patch` parts after the revert point, `snap.track()` (a `write-tree` of the work tree into the bare snapshot repo) if no snapshot yet, `snap.restore(previous)` then `snap.revert(patches)` (`git checkout <hash> -- <file>`, delete files that "did not exist in snapshot"), computes diff summary; `unrevert` = `snap.restore(snapshot)`; `cleanup` deletes the reverted messages/parts when the next prompt arrives; both assert not busy | Snapshot repo per project/worktree: `git init` with `GIT_DIR=<data>/snapshot/...`, `GIT_WORK_TREE=<worktree>`, `core.fsmonitor false`, `feature.manyFiles true`, `index.version 4`; alternates to the real repo's objects "on huge repos like chromium"; large untracked files excluded; conversation and files both revert (messages removed lazily) | https://opencode.ai/docs/tui/ ; https://opencode.ai/docs/config/ ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/revert.ts ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/snapshot/index.ts lines 71–75, 318–345, 382–441 (fetched 2026-09-20) |
| Codex | no `/undo` in current source; `Esc Esc` backtrack/fork | `GhostSnapshotConfig` is "Compatibility-only config retained so legacy `ghost_snapshot` settings" (fields `ignore_large_untracked_files/dirs`, `disable_warnings`) | Conversation-level backtrack + fork rather than file revert | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs lines 228–250, 3848–3866 ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/slash_command.rs (fetched 2026-09-20) |
| Gemini | `/restore [tool_call_id]` "Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested"; `/rewind` "Jump back to a specific message and restart the conversation" with "rewind history only, revert code changes only, or both" | Checkpointing (off by default; `general.checkpointing.enabled`; `--checkpointing` flag "removed in version 0.11.0"): "A commit is made in a special, shadow Git repository located in your home directory (`~/.gemini/history/<project_hash>`)", conversation and the pending tool call saved to `~/.gemini/tmp/<project_hash>/checkpoints`; restore will "Revert all files in your project to the state captured in the snapshot. Restore the conversation history in the CLI. Re-propose the original tool call." | Whole-tree shadow git commit before each file-modifying tool | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md (via fetch) ; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/commands.md lines 336–357 ; packages/cli/src/ui/commands/restoreCommand.ts, rewindCommand.tsx (fetched 2026-09-20) |
| Crush | none found (files table `files(session_id, path, content, version)` stores file versions per session) | — | UNVERIFIED beyond the schema | https://raw.githubusercontent.com/charmbracelet/crush/main/internal/db/migrations/20250424200609_initial.sql (fetched 2026-09-20) |

Cache note that matters for JevCode's economics: "`/rewind` truncates your conversation back to an earlier turn. The
remaining history is the same content the cache was built from at that point ... so the next request hits the
earlier cache entry" whereas compaction "invalidates the conversation layer"
(https://code.claude.com/docs/en/prompt-caching, fetched 2026-09-20).

## 7. /compact and context-window summaries

- Claude Code `/compact [instructions]`: "Free up context by summarizing the conversation so far. Optionally pass
  focus instructions for the summary." `/clear [name]`: "Start a new conversation with empty context. Pass a name to
  label the previous conversation in the `/resume` picker." (https://code.claude.com/docs/en/commands, fetched
  2026-09-20). Auto-compact: "`/autocompact 500k` ... saves it to your user settings as `autoCompactWindow`"; "If you
  don't set an auto-compact window, Claude Code compacts when the conversation reaches the model's context limit"
  (https://code.claude.com/docs/en/model-config). Hooks `PreCompact`/`PostCompact` with `trigger: "manual" | "auto"`
  and `custom_instructions` (https://code.claude.com/docs/en/hooks). CLAUDE.md may carry `# Compact instructions`
  (https://code.claude.com/docs/en/costs).
- opencode: config `compaction: { auto, prune, reserved }` (docs) plus `preserve_recent_tokens` and `tail_turns` in
  source; prune "goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool calls, then erases
  output of older tool calls to free context space", `PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`, skips the
  two most recent user turns and stops at the last summary; a dedicated `compaction` agent writes the summary; errors
  "Conversation history too large to compact - exceeds model context limit"
  (https://opencode.ai/docs/config/ ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/compaction.ts
  lines 28–29, 115–119, 228, 271–316, 358, 450–454, fetched 2026-09-20). `/compact` = `ctrl+x c`.
- Codex: `/compact` "summarize conversation to prevent hitting the context limit", `/recap` "summarize the current
  conversation now" (slash_command.rs lines 94–95); `model_auto_compact_token_limit`: "Token threshold that triggers
  automatic history compaction (unset uses model defaults)" (config-reference, summary) (fetched 2026-09-20).
- Gemini `/compress` (alt names `summarize`, `compact`): "Compresses the context by replacing it with a summary";
  reports `originalTokenCount`/`newTokenCount`; refuses with "Already compressing, wait for previous request to
  complete" (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/commands/compressCommand.ts,
  fetched 2026-09-20). Hook `PreCompress` "Before context compression" (docs/hooks/index.md).
- Crush: `sessions.summary_message_id` and `messages.is_summary_message` migrations imply summary-message compaction
  (migration list above, fetched 2026-09-20); UI command UNVERIFIED.
- JevCode: not needed as a context mechanism — "the generator prompt is O(plan + window + context), never
  O(transcript)" (DESIGN.md §6). The equivalent knobs are `Plan` retention (§17 "Plan retention bloat") and the
  4-entry window.

## 8. /export and /share

- Claude Code `/export [filename]`: "Export the current conversation as plain text."; "Run `/export` to open a menu
  that lets you copy the current conversation to your clipboard or save it as a plain-text file, with messages and
  tool outputs rendered as readable text. Pass a filename to skip the menu". Structured alternatives: `claude -p
  --output-format json|stream-json`, hooks' `transcript_path` (https://code.claude.com/docs/en/sessions ;
  https://code.claude.com/docs/en/commands, fetched 2026-09-20).
- opencode `/export` "Export current conversation to Markdown" (`ctrl+x x`); CLI `opencode export` with
  `--sanitize` "redact sensitive transcript and file data" which replaces every text/reasoning/tool output/file path
  with `[redacted:<kind>:<id>]` placeholders (https://opencode.ai/docs/tui/ ;
  https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/export.ts lines 11–17,
  231–232, fetched 2026-09-20). `/share` "Creates a unique public URL for your session" `opncd.ai/s/<share-id>`,
  config `share: "manual" | "auto" | "disabled"`, `/unshare` will "remove the share link and delete the data related
  to the conversation" (https://opencode.ai/docs/share/, fetched 2026-09-20).
- Codex `/export` "export the conversation as markdown", `/rollout` "print the rollout file path", `/copy` "copy the
  last response or part of it" (slash_command.rs lines 106–108, 152, fetched 2026-09-20).
- Gemini `/resume share [filename]` "Exports the current conversation to Markdown or JSON" (`/chat share file.md` or
  `file.json`); `/export-session` "Export the current session to a JSON file" (docs/reference/commands.md lines
  99–100 ; exportSessionCommand.ts line 20, fetched 2026-09-20).

## 9. /diff, /cost, /status

- Claude Code `/diff`: "Review the changes in your working tree, including the edits Claude has made so far." The
  diff viewer's "**Current** view shows your uncommitted changes from git" and has "a turn view for each prompt after
  which Claude edited files ... Claude Code builds the turn views from Claude's file edits rather than from git, so a
  change Claude makes through a shell command appears only under Current" (https://code.claude.com/docs/en/interactive-mode
  "Review changes with /diff", fetched 2026-09-20). `/cost` "Alias for `/usage`"; the Session block prints
  `Total cost: $0.55 / Total duration (API): 6m 20s / Total duration (wall): 6h 33m 10s / Total code changes: 0 lines
  added, 0 lines removed / Usage by model: ...`; "These totals reset when `/clear` starts a new session"; compared
  with `--max-budget-usd` (https://code.claude.com/docs/en/costs ; https://code.claude.com/docs/en/commands).
- Codex `/diff` "show git diff (including untracked files)", `/status` "show current session configuration and token
  usage", `/usage` "view account usage or use a usage limit reset" (slash_command.rs lines 109, 116, 119).
- Gemini `/stats [session|model|tools]` (alt `usage`) "Check session stats" (statsCommand.ts lines 85–87).
- opencode `status_view` `<leader>s`; `opencode stats` "Display token usage and cost statistics" (docs/cli);
  `Session.summary { additions, deletions, files }` shown per session (sql.ts).

## 10. /model mid-session

- Claude Code `/model [model]`: "Switch the AI model and save it as your default for new sessions."; `Option+P`
  "Switch models without clearing your prompt" (commands, interactive-mode). "Resumed sessions ... keep the model they
  were using when the transcript was saved, regardless of the current `model` setting." (model-config). "Each model
  has its own cache. Switching with `/model` means the next request reads the entire conversation history with no
  cache hits ... Claude Code asks you to confirm the switch only while the cache is still warm"
  (https://code.claude.com/docs/en/prompt-caching, fetched 2026-09-20). Mid-turn: `/model` "applies your change to
  the next request it makes in that turn" (interactive-mode).
- opencode: `model_list` `<leader>m`, `model_cycle_recent` `f2`, `model_provider_list` `ctrl+a`, `variant_cycle`
  `ctrl+t`; the session row stores `model: { id, providerID, variant? }` and `agent` (keybinds docs; sql.ts).
- Codex `/model` "choose what model and reasoning effort to use" (slash_command.rs line 129). Crush: "switch LLMs
  mid-session while preserving context", `ctrl+l` model picker (README).
- JevCode constraint: a run's provider/model are frozen in `run.json` ("an explicit `--provider`, `--model` or
  `--jev-model` that differs is `ConfigError`", DESIGN.md §9). So `/model` can only apply to the **next run**.

## 11. /clear vs /new

- Claude Code: `/clear` = new conversation, previous saved and resumable; "Running `/clear` starts a new session:
  recall then lists the new session's prompts first, with earlier sessions' prompts after them" (interactive-mode);
  rewind menu gains `/resume <session-id> (previous session)` (checkpointing). Hooks: `SessionEnd` with
  `reason: "clear"`, then `SessionStart` matcher `"clear"` (hooks).
- Gemini: `/clear` (alt `new`) "Clear the screen and start a new session"; implementation fires
  `fireSessionEndEvent(SessionEndReason.Clear)`, `randomUUID()` new session id, `resetChat()`, then
  `fireSessionStartEvent(SessionStartSource.Clear)`; `Ctrl+L` "only clears the terminal display and redraws the UI,
  preserving the active conversation context" (clearCommand.ts ; docs/reference/commands.md lines 102–109).
- opencode `/new` "Start a new session" (`ctrl+x n`); Codex `/new` "start a new chat during a conversation" vs
  `/clear` "clear the terminal and start a new chat" (slash_command.rs lines 92, 101).

## 12. Project instruction files

| Tool | Files and order | Caps / notes | Source |
| --- | --- | --- | --- |
| Claude Code | Managed `CLAUDE.md`; `~/.claude/CLAUDE.md`; `./CLAUDE.md` or `./.claude/CLAUDE.md`; `./CLAUDE.local.md`; `.claude/rules/*.md`. "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every directory above it ... All discovered files are concatenated into context rather than overriding each other ... ordered from the filesystem root down to your working directory". Subdirectory files "are included when Claude reads files in those subdirectories". `AGENTS.md` read only when "no `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it" (v2.1.277+); `AGENTS.local.md`, `AGENTS.override.md`, `.agents/` "Not read" | `@path` imports "maximum depth of four hops"; "target under 200 lines per CLAUDE.md file"; edits mid-session don't apply until `/clear`, `/compact` or restart | https://code.claude.com/docs/en/memory ; https://code.claude.com/docs/en/prompt-caching (fetched 2026-09-20) |
| opencode | `globalFiles = [<config>/AGENTS.md, ~/.claude/CLAUDE.md]` (first that exists); `instructionFiles = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md" // deprecated]` with `fs.findUp(file, ctx.directory, ctx.worktree)` and "The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor."; then `config.instructions` globs and `https://` URLs with `Effect.timeout(5000)` | `OPENCODE_DISABLE_PROJECT_CONFIG` skips project files; `/init` "Guided setup for creating or updating AGENTS.md" | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/instruction.ts lines 60–67, 110–150 ; https://opencode.ai/docs/rules/ (fetched 2026-09-20) |
| Codex | `~/.codex/AGENTS.md` then repository root to cwd, plus `AGENTS.override.md` (summary of learn.chatgpt.com/docs/codex/cli); `project_doc_max_bytes` "Maximum bytes read from `AGENTS.md`", `project_doc_fallback_filenames` "Additional filenames to try when `AGENTS.md` is missing." | `pub(crate) const AGENTS_MD_MAX_BYTES: usize = DEFAULT_PROJECT_DOC_MAX_BYTES; // 32 KiB`; `/init` "create an AGENTS.md file with instructions for Codex" | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs line 250, 4252 ; slash_command.rs line 93 (fetched 2026-09-20) |
| Gemini | 1. `~/.gemini/GEMINI.md`; 2. "workspace directories and their parent directories"; 3. JIT: "When a tool accesses a file or directory, the CLI automatically scans for `GEMINI.md` files in that directory and its ancestors up to a trusted root"; upward search stops at the git root / trusted root and skips `~/.gemini` itself; `context.fileName` may be a list e.g. `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]` | `/memory show`, `/memory reload`; `@file.md` imports; footer shows count of loaded context files | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-md.md ; packages/core/src/utils/memoryDiscovery.ts lines 317–382, 455–500 (fetched 2026-09-20) |
| Crush | `defaultContextPaths = [".github/copilot-instructions.md", ".cursorrules", ..., "CLAUDE.md", ..., "crush.md", "Crush.md", "CRUSH.md", "AGENTS.md", "agents.md", "Agents.md"]`; globals `~/.config/crush/CRUSH.md` and `~/.config/AGENTS.md` (`option global-context-path`); `initialize_as` default `AGENTS.md` | `context_paths`, `global_context_paths` config keys | https://raw.githubusercontent.com/charmbracelet/crush/main/internal/config/config.go lines 24–44, 378–395 ; README "Global context files" (fetched 2026-09-20) |

## 13. Hooks and events

- Claude Code: every hook receives `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`,
  `permission_mode`, `hook_event_name`; `SessionStart` matchers `"startup"`, `"resume"`, `"clear"`, `"compact"`,
  `"fork"` (output `additionalContext`); `SessionEnd` reasons `"clear"`, `"resume"`, `"logout"`,
  `"prompt_input_exit"`, `"other"`; `UserPromptSubmit` gets `prompt` and may return `updatedPrompt`; `Stop` carries
  `stop_hook_active`; `PreCompact`/`PostCompact` `trigger: "manual" | "auto"`; exit `2` blocks
  (https://code.claude.com/docs/en/hooks, fetched 2026-09-20).
- Codex: hook events `PreToolUse, PostToolUse, SessionStart, SessionEnd, SubagentStart, SubagentStop,
  UserPromptSubmit, Stop, Interrupt, PreCompact, PostCompact, PermissionRequest` via `hooks.json` or `[hooks]`
  (config-reference, summary); `allow_managed_hooks_only = true` in `requirements.toml`
  (https://raw.githubusercontent.com/openai/codex/main/docs/config.md, fetched 2026-09-20).
- Gemini: `SessionStart` "(startup, resume, clear)", `SessionEnd` "(exit, clear)", `BeforeAgent`, `AfterAgent`,
  `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`; JSON
  over stdin/stdout, configured in `settings.json`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md, fetched 2026-09-20).
- opencode: `experimental.session.compacting` and `experimental.compaction.autocontinue` plugin triggers
  (compaction.ts lines 373–375, 501); Crush: "preliminary support for hooks" (README).
- JevCode already has the equivalent **event stream**: `EngineEvent` (`run:start`, `run:ready`, `step:*`,
  `stage:*`, `decision`, `proposal`, `risk`, `confirm:*`, `exec:*`, `outcome`, `judge`, `plan`, `loop:tripped`,
  `replan`, `checkpoint`, `status`, `transcript`, `error`, `run:end`) in `src/core/types.ts`, consumed by the TUI, the
  plain renderer and the bench through one `EngineEmitter`.

## 14. JevCode today (what the session layer builds on) and measurements

Existing model (`src/core/types.ts`, DESIGN.md §6, §9, §11): a **run** = `~/.jevcode/runs/<YYYYMMDD>-<HHMMSS>-<8
base32>/` with `run.json` (`RunMeta { runId, task, workspace, mode, config (secrets as fingerprints), versions,
createdAt, overrides[], resumes[], resolvedJevModel, jevModelDrift }`), `state.json` (`CheckpointEnvelope { version:
1, checksum, state: CheckpointState }` where `CheckpointState` holds `step, plan, window, loopDetector, spend,
wallMsUsed, timing, counters, directive, lastTestRun, lastChangeStep, createdThisRun, stopReason, interrupted,
consecutiveStageFailures, synthState?, resumes, updatedAt`), `state.prev.json`, `steps.jsonl`, `decisions.jsonl`,
`jev.jsonl`, `generator.jsonl`, `transcript.log`. `StopReason = 'complete' | 'max_steps' | 'spend_cap' | 'wall_time' |
'max_replans' | 'human_abort' | 'signal' | 'replan_stop' | 'impossible' | 'generator_done' | 'error'`. `Plan` has
`done[]` (with `evidence { step, judged }`), `remaining[]`, `unverified[]`, `openProblems[]` (generator-owned) and
`harnessProblems[]` (`kind: 'replan' | 'rejected_claim' | 'stale_plan'`), rendered under "harnessProblems (owned by
the harness; you cannot remove these)" in `src/provider/prompts.ts` line 133. A pending `ReplanDirective` is passed
to the propose stage as `directive: draft.directive?.text` (`src/loop/engine.ts` line 861) and rendered as "Replan
directive from Jev (move ..., p=..., task_impossible=...)" (prompts.ts line 167). `WindowEntry { step, intent,
action, outcome, reason?, judge?, completion?, output? (≤ 600 chars), truncated?, shownFiles, notes }`, last 4.
Change tracking: `ActionOutcome.changedFiles`, `CheckpointState.createdThisRun`, `TargetInfo { existsBefore,
tracked, createdThisRun, recoverable: tracked || created }` (`src/workspace/files.ts` line 318). The TUI is a run
monitor: `App.tsx` mounts one `useInput` (Ctrl-C → `onAbort('human_abort')`, `y`/`n` while a confirm is pending).

Measurements on this machine (Apple Silicon, Node 22.23.2, 2026-09-20; scripts under `/tmp/jev-picker/`):

| What | Value |
| --- | --- |
| `~/.jevcode/runs` | 148 entries; 141 match the run-id regex and have `run.json`; 140 have a parseable `state.json` (one fixture dir `other-probe/` holds a 23-byte `{"secret":"other-run"}`); 14 GB total, of which `bench-work/` is 8.2 GB |
| `run.json` size | min 2,414 B, p50 3,905 B, max 7,773 B (the task text dominates: a SWE-bench task was 7.7 KB) |
| `state.json` size | p50 13,778 B, max 30,241 B |
| `steps.jsonl` size | p50 100,410 B, max 4,415,165 B (25 steps), total 166 MB over 140 runs |
| `transcript.log` size | p50 9,241 B, max 30,683 B |
| Picker scan A: serial `readFile`+`JSON.parse` of `run.json` and `state.json` for 141 runs | 47 ms cold page cache, 20 ms warm (2.2 MB read) |
| Picker scan B: `run.json` + `stat(state.json)` only | 9.5 ms |
| Picker scan C: `Promise.all` full reads of both | 8.3 ms |
| Picker scan D: first 4 KB of `state.json` + `run.json` | 14.7 ms (no gain: the envelope's `state` is not header-first) |
| Picker scan E: one `sessions/index.jsonl` with 141 × ~284-byte lines | 40,043 B; read + parse **0.13 ms** (0.33 ms warm rerun) |
| Parsing the largest `steps.jsonl` (4.4 MB, 25 rows) | 14.9 ms — the picker must never do this |
| Preview: read last 4 KB of `transcript.log` and take the last 3 lines | 0.71 ms; tail reads e.g. `[run] end max_steps steps=25 wall=2m30s cost=$0.539 (gen $0.481, jev $0.058)` |
| `stopReason` over 140 runs | max_steps 62, generator_done 37, complete 23, max_replans 9, replan_stop 7, spend_cap 1, null 1 |

## 15. Proposal: the JevCode session model

### 15.1 Definitions

- **Run** stays exactly what it is: one task text, one run dir, one `CheckpointState`, its own budgets and
  `stopReason`. Nothing in §6/§9/§11 changes for a run.
- **Session** = an ordered list of runs in one workspace (realpath), plus human events (rename, steer, undo). The
  session id is the **first run's id** (no new id format; sortable; `RUN_ID_RE` already validates it). `RunMeta`
  gains `sessionId: string`, `parentRunId: string | null`, `source: 'cli' | 'bench' | 'perf'` (Codex keeps
  `INTERACTIVE_SESSION_SOURCES`; Claude Code "Skips sessions created with `claude -p`"). Existing runs without
  `source` are classified by `workspace` prefix `~/.jevcode/runs/bench-work/`.
- **Turn** = one run. A follow-up prompt never mutates a finished run's checkpoint; it starts a new run
  (`parentRunId = previous`), which keeps "a run must stay comparable with itself" (DESIGN.md §9) and keeps the bench
  untouched.
- **Directive** = human text delivered to the harness: either the task of a new run or a steering note consumed by a
  running one. Stored as `HarnessProblem { kind: 'human', text (≤ 600 chars, redacted), step }`; the
  `HarnessProblemKind` union gains `'human'`. The prompt renders it in the existing "harnessProblems (owned by the
  harness; you cannot remove these)" list, so no new prompt section is needed.

### 15.2 Follow-up prompt = new run seeded with the previous run's plan/window plus a human directive

`EngineOptions.seed?: { fromRunId, plan: Plan, window: WindowEntry[], lastTestRun, createdThisRun }`, filled by the
CLI from the parent's `state.json` (one file, < 1 ms). Rules:

1. `task` of the new run = the follow-up text. The generator prompt's task section shows both: `## Task` (follow-up)
   and `## Session so far` = the seeded `plan.done` (with evidence) — the generator already receives "a persistent
   plan (done with evidence, remaining, open problems)" (README), so the carried context is the plan, not a transcript.
2. Seed `plan.done` verbatim; keep `plan.remaining`/`unverified`, drop `openProblems` (generator-owned, replaced
   each step anyway) and drop expired `harnessProblems` except the new `{ kind: 'human', text: followUp, step: 0 }`.
   For step 1 only, the `human` problem counts as "a replan directive was issued this step" for Plan rule (b), so the
   generator may drop `remaining` items the follow-up made obsolete (DESIGN.md §6 Plan (b)).
3. Seed the window with the parent's last 4 entries, each with `notes: [..., 'from run <parentRunId>']`; step
   numbers restart at 1 in the new run (the window entry keeps its original `step`; the note disambiguates).
4. `createdThisRun` carries over so `TargetInfo.recoverable` stays true for files the session created; `lastTestRun`
   carries over with `lastChangeStep = null` so `testsCurrent` is recomputed honestly.
5. Spend, wall time, loop detector, `resolvedJevModel` start fresh per run (budgets are per run; the status line
   shows run and session totals, the latter summed from the index).
6. Jev sees the follow-up in the intent state as the human directive (same slot as a replan directive text). Whether
   `task` for the completion Noul should be the follow-up alone or "original + follow-up" is an open question (§18).

### 15.3 Mid-run steering = queued directive consumed at the next step

- `Engine.steer(text): { queued: number }` appends `{ text, at }` to `CheckpointState.pendingDirectives`
  (new field, max 8 items × 600 chars, redacted before it can reach `state.json`, written with the next checkpoint;
  Codex persists queued submissions with `MAX_QUEUE_ITEMS = 100`, Claude Code keeps them in memory only). Emits
  `steer:queued { step, index, text }` (transcript item, dim).
- Consumption point: **step start, immediately after `checkBudgets()` and before the replan/intent request**. The
  engine moves every pending directive into `plan.harnessProblems` as `kind: 'human'` (expiring like a replan
  directive: superseded by the next human directive or replan, never silently), puts the concatenated text into the
  intent state's directive slot, resets the loop detector counts (a human instruction is a legitimate change of
  course, like `onReplan`), and emits `steer:applied { step, count }`. This is the same rule Claude Code uses
  ("passes it to Claude as soon as those tool calls finish, within the same turn") mapped onto JevCode's only safe
  mutation point, and it never touches the in-flight stage (§11 state-mutation rule: plan mutates only at commit).
- The TUI composer stays active while the run is live. `Enter` with text while `state.done === null` → `steer`; the
  queued lines render above the composer (Claude Code: "lists the queued entries above the input box") inside the
  height budget (≤ 2 rows, `wrap="truncate"`, the decisions pane shrinks first). `Up` on the first composer line takes
  the queue back into the composer (Claude Code semantics) and calls `engine.unsteer()`.
- Not steering: `y`/`n` while a confirm is pending (unchanged), slash commands (run immediately if read-only, e.g.
  `/plan`, `/cost`; deferred to run end otherwise, e.g. `/undo`).

### 15.4 Interrupting: Esc, Ctrl-C

- `Esc` (composer empty, run live) = **pause**: `engine.pause()` sets `pauseRequested`; the engine stops at the next
  §9.1 rule-1 point (step start, alongside `checkBudgets`) with a new `StopReason 'human_pause'` (exit 4 family: "run
  stopped without completion by a budget or directive"). Nothing mid-execute is killed, the step in flight commits
  whole, and `--resume`/follow-up treat `human_pause` like `null` ("any other value or null → resume normally", §9).
  The status line reads `pausing after step N`. Double-`Esc` within 2 s = abort now (`human_abort`, §9.1 rules 1–3,
  sandbox tree kill) — opencode needs two presses within 5 s to `session.abort`, and Claude Code reserves double-Esc
  for rewind; JevCode's Ctrl-C already means abort, so the double-Esc shortcut is the only overlap and it stays
  consistent (Esc = gentle, Esc Esc = hard, Ctrl-C = hard, Ctrl-C twice = `process.exit` as today).
- The process does **not** exit after a run stops in the interactive TUI; the composer becomes active, the run's
  `run:end` item is in `<Static>`, and the next prompt is a follow-up (§15.2). `jevcode run "task"` (task from argv)
  keeps today's exit-after-run behaviour; `jevcode` with no task opens the session TUI.

### 15.5 What to persist under `~/.jevcode`

```
~/.jevcode/runs/<run-id>/            unchanged, plus:
   pre/<step>/<sha256(relpath)>      pre-images written atomically before edit|write|patch (skip > 1 MiB, note skipped)
   run.json                          + sessionId, parentRunId, source, title?, instructions[] (§15.8)
   steps.jsonl                       StepRecord + planAfter (bounded: 20 items × 200 chars per list)
~/.jevcode/sessions/index.jsonl      append-only; one ≤ 512-byte line per event; readers fold by runId, last wins
   { t, kind: 'run:start', sessionId, runId, parentRunId, workspace, task60, mode, source }
   { t, kind: 'run:end',   sessionId, runId, stopReason, steps, costUsd: { generator, jev }, wallMs, changedFiles: n }
   { t, kind: 'rename',    sessionId, title }
   { t, kind: 'steer' | 'undo' | 'pause', sessionId, runId, step, text60?, files?: n }
~/.jevcode/history.jsonl             { t, workspace, text } prompt history for Up/Ctrl-R; passes redact(); off with JEVCODE_NO_HISTORY=1
```

- One index for all workspaces (Claude Code splits per `<project>` dir; Codex mirrors into SQLite). At 284 B/line,
  10,000 runs ≈ 2.8 MB, still one `readFile` (< 5 ms extrapolated from 0.13 ms/40 KB). Filter by `workspace` for
  the default picker scope; `Ctrl-A` widens (Claude Code key).
- Torn last line tolerated exactly like `steps.jsonl` ("readers ... skip a corrupt trailing line with a warning", §9).
  Bench and perf runs (`source !== 'cli'`) do **not** write the index (they are the 8.2 GB and would flood it; also
  avoids concurrent-append interleaving from `--concurrency N` workers).
- `jevcode sessions reindex` rebuilds the index from `run.json` + `stat(state.json).mtime` (9.5 ms for 141 runs
  measured; `stopReason`/cost columns show `?` until a row is selected and its `state.json` parsed).
- No automatic deletion (bench evidence lives in the same tree); `jevcode sessions prune --older-than 30d --source
  cli` is explicit (Claude Code default 30 days; Gemini `maxAge: "30d"`).
- Transcript per session = the ordered runs' `transcript.log` files; `/export` concatenates them with run headers.
  No second copy of the transcript.

### 15.6 Resume picker (`jevcode -r`, `/resume`, `/sessions`)

- Data path: index only (0.13 ms), never `state.json` for the list and never `steps.jsonl` (14.9 ms for one 4.4 MB
  file). Row = `time ago │ steps │ stop │ $cost │ title-or-task60 │ (workspace basename when widened)`; `stop` uses
  the existing verdict colours (complete green, budget stops yellow, error red, `human_pause` dim). Cost is a column
  because JevCode's whole point is the cost split; Crush stores cost on the row, Claude Code only per session.
- Selection preview (on `Space`, Claude Code key; Codex `ctrl+t transcript`): parse that run's `state.json` (≤ 30 KB)
  for `plan.done.length / remaining`, `spend`, `stopReason`, `interrupted`, and tail 4 KB of `transcript.log`
  (0.71 ms). Both after the first frame, in a fixed-height `<Box overflow="hidden">` so the height budget holds.
- Keys: `↑/↓`, `Enter` resume (follow-up composer opens on that session), `Space` preview, `/` or typing = filter
  (title, task, run id), `Ctrl-A` all workspaces, `Ctrl-R` rename (writes a `rename` line), `x` delete (Gemini) with
  confirm, `Esc` close. Sort: updated (default) / created (Codex offers exactly these two).
- Gating on resume of a stopped run: existing §9 rules apply unchanged (`complete` needs `--force`; un-raised budget
  → message naming the flag). In the TUI these become the `/budget` command (§15.9) instead of an exit.
- First-frame contract: `jevcode` with no arguments renders the composer from argv only; the index is read after
  `firstFrame()` and fills a one-row "recent: <title> · <time ago> (Enter to continue, -r to browse)" hint.

### 15.7 `/undo` and `/rewind` given what the harness tracks

What is known per step: `outcome.changedFiles` (from file actions, or `git status --porcelain` after a `run`),
`createdThisRun`, `TargetInfo.recoverable = tracked || created`, and — with §15.5 — pre-images for edit/write/patch.
Unknown: pre-images of files a `run` command modified (only names via porcelain), and files a command created that
git ignores.

- `/undo` (no argument) = revert the **last committed step's** file changes: for `edit|write|patch` restore the
  pre-images (delete the file if `createdThisRun` and no pre-image); for `run` steps, `git checkout -- <path>` for
  tracked `changedFiles` and `unlink` for `createdThisRun` paths, both through the harness git with the scrubbed env
  (DESIGN.md §8), never `git reset`/`stash`; refuse others by name: `restored 3 files, skipped 1 (not git-recoverable:
  build/out.txt)` (Claude Code wording: "Restored the code, but skipped N files"; its own limitation "Checkpointing
  does not track files modified by Bash commands" is the same boundary).
- `/rewind` opens a list of steps with changed files (like Claude Code's prompt list) and offers `files`,
  `plan+window`, `both` (Claude Code's three restore options; Gemini's "rewind history only, revert code changes only,
  or both"). `plan+window` to step N = restore `StepRecord.planAfter` (hence `planAfter` in `steps.jsonl`) and
  truncate the window to entries `≤ N`; this is only allowed while no run is live (`opencode assertNotBusy`), and it
  applies to the **next run's seed**, never to a committed checkpoint — the reverted run's `state.json` is
  immutable, so the bench record stays honest. The undo itself is recorded as an index line and as
  `HarnessProblem { kind: 'human', text: 'human reverted step N: <files>' }` in the next run's seed so the generator
  knows the tree changed underneath it.
- Whole-tree shadow-git snapshots (opencode/Gemini) are rejected for v1 (§17): a `write-tree` per step on a
  5,000-file fixture competes with the < 50 ms harness budget, and pre-images are O(changed files).

### 15.8 Instruction files

Load `AGENTS.md` by walking up from the workspace realpath to the workspace root only (the sandbox and path rules are
workspace-scoped; opencode stops at the worktree, Gemini at the git root), first match wins (opencode: "The first
project-level match wins"), `CLAUDE.md` as the fallback name (opencode and Crush both read it), plus
`~/.config/jevcode/AGENTS.md`. Cap at 32 KiB (Codex `AGENTS_MD_MAX_BYTES // 32 KiB`), record `{ path, sha256, bytes
}` in `run.json.instructions[]` so runs remain comparable, redact, and inject into the generator **system** prompt as
`## Project instructions`. Loaded per run at init (after the first frame; DESIGN.md §12 ordering contract), never
re-read mid-run (Claude Code: edits apply only after `/clear`, `/compact` or restart). Not fed into Jev state in v1
(§18 open question).

### 15.9 Slash commands (one-line semantics)

| Command | Semantics | Precedent |
| --- | --- | --- |
| `/help` | list commands and keys | all |
| `/new` | end the current session; next prompt starts a new session in this workspace (process stays) | opencode `/new`, Codex `/new`, Gemini `/clear` alt `new` |
| `/resume [id\|title]` | open the picker (§15.6); with an argument, continue that session | Claude `/resume`, Codex `/resume`, Gemini `/resume` |
| `/sessions` | alias of `/resume` | opencode `/sessions` |
| `/rename <title>` | set the session title (index `rename` line; shown on the status line) | Claude `/rename`, Codex `/rename` |
| `/pause`, `/abort` | same as `Esc` / `Esc Esc` (§15.4) | — |
| `/undo` | revert the last committed step's files (§15.7) | opencode `/undo`, Claude `/rewind` |
| `/rewind [step]` | step list → files / plan+window / both (§15.7) | Claude `/rewind`, Gemini `/rewind` |
| `/diff [step]` | `git diff --stat` of the session's `changedFiles` (or one step's), harness git, scrubbed env; untracked files listed | Claude `/diff`, Codex `/diff` "including untracked files" |
| `/plan` | print the current `Plan`: done (with `evidence.step/judged`), remaining, unverified, open/harness problems | JevCode-specific; replaces `/compact` |
| `/decisions [n] [stage]` | expand the decisions pane: last n `Decision`s with probability, confidence, verdict, latency | Jev-native |
| `/jev` | decider model id (`resolvedJevModel`, drift), questions asked, latency p50/p95, Jev cost | Jev-native |
| `/cost` | run and session totals: generator vs Jev cost, tokens per step (flat-tokens check), wall time | Claude `/cost`, Gemini `/stats`, Codex `/status` |
| `/budget spend-cap\|max-steps\|max-wall\|max-replans <v>` | raise a limit for the next run or a resume; recorded in `run.json.overrides[]` | JevCode §9 overrides |
| `/model <id>`, `/provider`, `/mode jev-on\|jev-off\|jev-only` | apply to the **next run** only (frozen per run) | Claude `/model`; JevCode §9 |
| `/config` | the `jevcode config` table (secrets as fingerprints) | JevCode |
| `/export [file]` | plain-text session transcript (all runs' `transcript.log` in order, headers per run), already redacted | Claude `/export`, Codex `/export` |
| `/status` | run id, session id, step/max, stage, sandbox level, workspace, stop reason | Codex `/status` |
| `/exit` | quit (also `Ctrl-D` with an empty composer, first press confirms) | all |
| `!cmd` | **not in v1** (§17): would bypass the risk stage; possible later as a human-authored `run` step | Claude, opencode, Codex, Gemini |
| `@path` | pin files into the next step's context (within the 12 files / 60 KB cap), shown as `shownFiles` | Claude, opencode, Codex |

### 15.10 Events for scripts

`jevcode run --plain --json` writes the redacted `EngineEvent` union as JSONL to stdout (opencode `--format json` "raw
JSON events"; Claude `--output-format stream-json`), adding `session:start { sessionId, runId, parentRunId }`,
`steer:queued`, `steer:applied`, `session:end { reason }`. No command hooks in v1 (§17).

## 16. ADOPT

| What JevCode should do | Why | Source / evidence |
| --- | --- | --- |
| Session = ordered runs; follow-up = new run seeded with plan/window + `HarnessProblem { kind: 'human' }` (§15.2) | Keeps `run.json` immutability and bench comparability; the prompt already renders harness problems | DESIGN.md §6, §9; `src/provider/prompts.ts` line 133 |
| Steering queue consumed at step start; queued lines shown above the composer; `Up` takes them back (§15.3) | Matches Claude Code delivery rule and take-back; Codex persists the queue (`MAX_QUEUE_ITEMS = 100`) | https://code.claude.com/docs/en/interactive-mode ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/state/src/lib.rs (fetched 2026-09-20) |
| `Esc` = pause after this step (`human_pause`), `Esc Esc` (2 s) / `Ctrl-C` = abort now (§15.4) | Gentle stop needs a rule-1 commit point; opencode's double-press pattern; Claude's "keeps the work done so far" | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/component/prompt/index.tsx lines 392–425 ; DESIGN.md §9.1 |
| `sessions/index.jsonl` as the picker's only list source; `state.json` only for the selected row; never `steps.jsonl` | 0.13 ms vs 47 ms (scan A) vs 14.9 ms for one large `steps.jsonl` — measured (§14); Codex and Crush keep a row store separate from transcripts | §14 table; https://raw.githubusercontent.com/openai/codex/main/codex-rs/state/src/lib.rs ; Crush initial migration |
| Picker row = time ago, steps, stop reason, cost, title/task; `Space` preview, `Ctrl-A` widen, `Ctrl-R` rename, `x` delete, `Esc` | Claude Code and Gemini keys; cost on the row like Crush | https://code.claude.com/docs/en/sessions ; SessionBrowser.tsx ; Crush schema (fetched 2026-09-20) |
| Exclude bench/perf runs from the index and the picker via `RunMeta.source` | Claude skips `-p`/SDK sessions; Codex has `INTERACTIVE_SESSION_SOURCES`; 8.2 GB of bench work here | https://code.claude.com/docs/en/cli-reference ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/rollout.rs |
| Pre-image capture for edit/write/patch under `<run>/pre/`; `/undo` restores pre-images, `git checkout --` for tracked, `unlink` for created; name what it skipped | Claude Code's checkpoint boundary ("does not track files modified by Bash commands") and skip message; O(changed files) fits the 50 ms budget | https://code.claude.com/docs/en/checkpointing ; DESIGN.md §12 |
| `/rewind` with files / plan+window / both, only while idle, applied to the next run's seed; `planAfter` in `steps.jsonl` | Claude Code's three restore options; Gemini's "history only, code only, or both"; opencode `assertNotBusy` | checkpointing docs; commands.md lines 347–357; revert.ts line 40 |
| `/plan`, `/decisions`, `/jev`, `/cost` instead of `/compact` | The prompt is O(plan + window); the decisions record is the product | DESIGN.md §6; README |
| `/model`, `/provider`, `/mode`, `/budget` apply to the next run; a differing model on resume stays `ConfigError` | "a run must stay comparable with itself"; Claude Code also freezes the model per resumed session | DESIGN.md §9; https://code.claude.com/docs/en/model-config |
| Load `AGENTS.md` (first match walking up to the workspace root), `CLAUDE.md` fallback, 32 KiB cap, sha256 in `run.json`, system prompt only | opencode first-match rule; Codex 32 KiB default; Claude Code's on-disk snapshot semantics | instruction.ts lines 122–131; config/mod.rs line 250; https://code.claude.com/docs/en/prompt-caching |
| `history.jsonl` for Up/Ctrl-R, redacted, `JEVCODE_NO_HISTORY=1` opt-out | Claude Code `history.jsonl`; Codex `history.persistence = none` | claude-directory page; config-reference (summary) |
| `/export` = concatenated redacted `transcript.log`s; `--json` event stream for scripts | Claude `/export` plain text; opencode `--format json`; opencode `export --sanitize` shows the redaction expectation | sessions page; run.ts; export.ts |
| Replay on resume = header + previous run's plan summary + last 4 window entries into `<Static>` once; full text via `/export` or `--replay-limit N` | opencode `--replay-limit`; Ink height-budget discipline forbids re-rendering scrollback | run.ts lines 225–234; DESIGN.md §10 |

## 17. REJECT

| What not to do | Why |
| --- | --- |
| Store sessions in SQLite (opencode, Codex mirror, Crush) | Runtime deps are only ink + react; on the pinned Node 22.23.2 `import('node:sqlite')` loads (`DatabaseSync, StatementSync, backup, constants`) but prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (verified locally 2026-09-20), so the format could shift under a checkpoint; a 40 KB JSONL index reads in 0.13 ms |
| Whole-tree shadow git snapshots per step (opencode `write-tree`, Gemini `~/.gemini/history/<hash>`) | `git add -A`/`write-tree` on a 5,000-file workspace competes with the < 50 ms p95 harness budget and needs alternates/large-file exclusion (opencode snapshot/index.ts lines 195–231); pre-images are O(changed files) |
| `/compact` / auto-compaction / summary agents | JevCode never sends the transcript; the plan and 4-entry window are the context — compaction would summarise nothing the model sees |
| Mutating a finished run's checkpoint on follow-up or `/rewind` | Breaks `run.json` comparability and bench evidence; a new run with a seed is cheaper and auditable |
| Interrupting mid-stage on a single `Esc` (Claude Code behaviour) | JevCode's abort mid-execute kills the sandbox tree and commits an `interrupted` step; a gentle pause at the rule-1 point loses nothing and is what a decision-record user wants |
| `/model` mid-run (Claude Code applies it "to the next request it makes in that turn") | Per-run model is frozen for comparability (§9); also every step's `generator.jsonl` row would need a model column |
| Command hooks (Claude/Codex/Gemini hooks running user commands) | Hooks run arbitrary commands with harness privileges outside the sandbox; the risk stage is the control point; expose the JSON event stream instead |
| `!cmd` shell mode in v1 | Bypasses Jev's risk stage and the review flow; revisit as a human-authored `run` step with `risk` skipped but outcome judged |
| `/share` to a hosted service | No network beyond providers/Jev; keys must never leave the machine; `/export` covers the need |
| Automatic 30-day deletion | Bench results and `decisions.jsonl` are research data; make pruning explicit |
| Per-workspace hashed index directories (Claude Code `projects/<encoded path>`) | One index filtered by `workspace` realpath is simpler and avoids the 200-char truncation + hash rule |
| Resuming the same run from two processes | Claude Code warns transcripts "interleave"; JevCode should take a `run.lock` (Claude Code `sessions/` "one small file per running session") and refuse |
| Parsing `steps.jsonl` or full `state.json` for every picker row | 14.9 ms for one large file and 47 ms for the fleet, all before the user can act |

## 18. Open questions

1. Completion Noul on follow-ups: should `task` for `task_complete` be the follow-up text alone, or "original task +
   follow-up"? Jev's criteria reference a current passing test run; a follow-up like "also update the docs" may not
   need tests. Needs a calibration look at the 212k recorded decisions (DESIGN.md §17).
2. Should the human directive enter Jev's intent/risk state (as the replan directive text does today) or only the
   generator prompt? Entering it lets Jev score `plan_mismatch` against the human's wish; it also changes question
   semantics that were calibrated without it.
3. `human_pause` as a new `StopReason` (exit 4) versus reusing `human_abort` with a `paused: true` flag: the bench
   `BenchStopReason` union and `exitCodeFor` both grow either way.
4. `planAfter` in `StepRecord` adds ~4–8 KB per step to `steps.jsonl` (p50 100 KB today); alternative: rebuild the
   plan at step N by replaying `PlanDraft`s from steps.jsonl (deterministic given the rules) — slower but no format change.
5. Pre-image size cap (1 MiB proposed) and whether to capture pre-images for files a `run` command is about to touch
   (unknowable) — accept the Claude Code boundary or run `git stash create` (read-only object creation, no work-tree
   change) before every `run` step for tracked files?
6. Concurrent index appends: `--concurrency N` bench workers are excluded, but two interactive sessions in different
   terminals can append simultaneously; lines ≤ 512 B with `O_APPEND` are practically atomic on APFS/ext4, but a
   `sessions/index.lock` (like `run.lock`) or per-process shard files would remove the doubt.
7. `@path` pins and Jev's context stage: pinned files count against the 12-file/60 KB cap — should they bypass the
   `p ≥ 0.5` Noul selection or be scored and merely boosted?
8. Whether `jevcode` with no arguments should open the composer (opencode/Claude Code default) or print usage as
   today; the first-frame benchmark must then cover the composer frame.
9. Crush's multi-client `IsBusy` / `AttachedClients` signals: if a `jevcode serve`-style attach ever exists, the
   index would need live status rows; out of scope now.
10. Title generation: Claude Code uses a Haiku-class background request for a "Generated title"; JevCode must not spend
    on that (zero-network first frame, spend cap semantics) — use the first 60 chars of the task and `/rename`.
