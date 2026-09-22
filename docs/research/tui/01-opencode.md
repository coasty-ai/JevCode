# 01 — opencode as the primary inspiration for the JevCode interactive TUI

Research notes for the JevCode design (Node 22.23.2, TypeScript strict, ESM, ONE npm package, runtime deps
ONLY `ink@7.1.1` + `react@19.3.0`, esbuild single file, first frame < 300 ms with zero network, rendering never
blocks the loop, zero terminal clears after the first frame, keys never in logs). Written 2026-09-20.

**Source conventions.** Every fact below was fetched on 2026-09-20. `R:<path>` expands to
`https://raw.githubusercontent.com/anomalyco/opencode/dev/<path>` (default branch `dev`); `O:<path>` expands to
`https://raw.githubusercontent.com/anomalyco/opentui/main/<path>`; `NM:<path>` is a file under
`<repo>/node_modules/<path>` (installed ink 7.1.1). `github.com/sst/opencode`
answers `HTTP/2 301` → `https://github.com/anomalyco/opencode` (curl -I, fetched 2026-09-20). Repo metadata from
`https://api.github.com/repos/anomalyco/opencode` (fetched 2026-09-20): `default_branch: dev`, `language: TypeScript`,
208,832 stars, MIT, `pushed_at: 2026-09-20T17:25:05Z`. The whole tree was pulled once with
`https://api.github.com/repos/anomalyco/opencode/git/trees/dev?recursive=1` (7,404 entries, `truncated: false`) and
individual files were read from the raw URLs. The GitHub REST API rate limit was exhausted late in the session, so two
issue-comment threads were read through the HTML pages instead (marked below).

---

## 1. Repository and package layout

- Monorepo, `bun@1.3.14` (`"packageManager": "bun@1.3.14"`), Turbo, oxlint; workspaces `packages/*`,
  `packages/console/*`, `packages/stats/*`, `packages/sdk/js`, `packages/slack`. Version catalog pins
  `"@opentui/core": "0.4.5"`, `"@opentui/solid": "0.4.5"`, `"@opentui/keymap": "0.4.5"`, `"solid-js": "1.9.10"`,
  `"effect": "4.0.0-beta.83"`, `"fuzzysort": "3.1.0"`, `"marked": "18.0.7"`, `"shiki": "4.2.0"`, `"ulid": "3.0.1"`,
  `"zod": "4.1.8"`. Root `"dev": "bun run --cwd packages/opencode src/index.ts"` (R:package.json, fetched 2026-09-20).
- 32 package dirs (`https://api.github.com/repos/anomalyco/opencode/contents/packages`, fetched 2026-09-20). File
  counts per package from the tree: `ui` 1,695, `opencode` 834, `web` 705, `app` 643, `console` 589, `core` 491,
  `desktop` 306, `tui` 241, `llm` 152, `session-ui` 118, `schema` 74, `sdk` 48, `plugin` 42, `server` 31, `cli` 25.
- **Which is which:**
  - `packages/tui` — the terminal UI, `@opencode-ai/tui` 1.18.31, `private: true`, SolidJS on OpenTUI; deps
    `@opentui/core|keymap|solid`, `clipboardy 4.0.0`, `diff`, `effect`, `fuzzysort`, `open 10.1.2`,
    `opentui-spinner`, `remeda`, `strip-ansi 7.1.2`, `solid-js` (R:packages/tui/package.json, fetched 2026-09-20).
    185 source files under `packages/tui/src` (tree count, fetched 2026-09-20).
  - `packages/opencode` — the CLI + server + agent runtime ("core" in the everyday sense), `name: opencode`
    1.18.31, `bin: { opencode: ./bin/opencode }`, yargs 18 CLI; depends on `@opencode-ai/tui`, `@opencode-ai/server`,
    `@opencode-ai/core`, ~25 `@ai-sdk/*` providers, `hono`, `drizzle-orm`, `@parcel/watcher`, `web-tree-sitter`,
    `ws` (R:packages/opencode/package.json, fetched 2026-09-20).
  - `packages/core`, `packages/server`, `packages/schema`, `packages/protocol`, `packages/client`, `packages/sdk`
    (generated SDK) — layered per AGENTS.md: "Keep runtime dependencies directed from Schema to Core and Protocol,
    then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or
    Server" (R:AGENTS.md, fetched 2026-09-20).
  - `packages/cli` — a newer preview CLI (`@opencode-ai/cli`, `bin: { lildax: ./bin/lildax.cjs }`) that runs the
    same TUI against a server transport (R:packages/cli/package.json, R:packages/cli/src/tui.ts, fetched 2026-09-20).
  - `packages/app` (web UI, embedded into the binary), `packages/desktop` (Electron), `packages/web` (docs site,
    `packages/web/src/content/docs/*.mdx`) (tree, fetched 2026-09-20).
- **Languages:** TypeScript everywhere; the TUI framework OpenTUI is a separate repo `anomalyco/opentui` ("written in
  Zig ... TypeScript directly or through React and Solid ... flexbox"), native Zig core under `packages/native/src/*.zig`
  called over FFI; "OpenCode uses OpenTUI in production for millions of users"; runs on "Bun 1.3.0 or later, or on
  Node.js 26.4.0 or later with ECMAScript modules (ESM) and `--experimental-ffi`" (O:packages/core/README.md, fetched
  2026-09-20). `@opentui/core@0.4.5` published 2026-07-17 with 8 platform `optionalDependencies`
  (`@opentui/core-darwin-arm64` ...) and deps `diff 9.0.0, marked 17.0.1, strip-ansi, string-width, bun-ffi-structs`
  (`https://registry.npmjs.org/@opentui%2Fcore`, fetched 2026-09-20). Latest is 0.5.11; opencode pins 0.4.5.
- **How the TUI talks to the core (the important architectural fact):** it is client/server over the same HTTP API
  in both modes, but the default is *in-process over a worker thread with a fake URL*:
  - `R:packages/opencode/src/cli/cmd/tui.ts` (fetched 2026-09-20): `const worker = new Worker(file, { env })`,
    `const client = Rpc.client<typeof rpc>(worker)`; when `--port`/`--hostname`/mDNS are given the worker starts a
    real listener (`client.call("server", network)`) and the TUI gets `{ url, headers: ServerAuth.headers() }`;
    otherwise `transport = { url: "http://opencode.internal", fetch: createWorkerFetch(client), events:
    createEventSource(client) }`. `createWorkerFetch` serialises a `Request` and calls the worker's `fetch` RPC.
  - The worker (`R:packages/opencode/src/cli/tui/worker.ts`, fetched 2026-09-20) answers `fetch` with
    `Server.Default().app.fetch(request)` (Hono in-process), forwards `GlobalBus.on("event", ...)` as
    `Rpc.emit("global.event", event)`, and exposes `snapshot()` (`writeHeapSnapshot("server.heapsnapshot")`),
    `server(...)`, `checkUpgrade`, `reload`, `shutdown`.
  - Remote attach: `opencode attach <url> [--dir] [--continue|-c] [--session|-s] [--fork] [--password|-p]
    [--username|-u] [--mini]` (R:packages/opencode/src/cli/cmd/attach.ts, fetched 2026-09-20). Server: `opencode
    serve [--port 4096] [--hostname 127.0.0.1] [--cors]`, `OPENCODE_SERVER_PASSWORD` basic auth, username default
    `opencode`; `GET /event` — "Server-sent events stream. First event is `server.connected`, then bus events";
    `GET /global/event` (R:packages/web/src/content/docs/server.mdx, fetched 2026-09-20).
  - Client side (`R:packages/tui/src/context/sdk.tsx`, fetched 2026-09-20): `sdk.global.event({ signal,
    sseMaxRetryAttempts: 0 })`, reconnect with `retryDelay = 1000`, `maxRetryDelay = 30000` exponential backoff,
    and a 16 ms coalescer: "If we just flushed recently (within 16ms), batch this with future events / Otherwise,
    process immediately to avoid latency", flushing inside Solid `batch()` "so all store updates result in a single
    render".
  - Session store (`R:packages/tui/src/context/sync.tsx`, fetched 2026-09-20) applies `session.updated`,
    `message.updated`, `message.part.updated`, `permission.*`, `question.*`, `todo.updated`, `session.diff`,
    `session.status` with `reconcile`/`produce`; per session it keeps at most 100 messages in memory
    (`if (updated.length > 100)` drop the oldest).
  - The developer guide still says "`packages/opencode/src/cli/cmd/tui/`: The TUI code, written in SolidJS with
    opentui" (R:CONTRIBUTING.md line 74, fetched 2026-09-20) — the code has since moved to `packages/tui`.

## 2. The TUI itself

### 2.1 Prompt editor (`R:packages/tui/src/component/prompt/index.tsx`, 1,716 lines, fetched 2026-09-20)

- Multi-line `<textarea ... minHeight={1} maxHeight={maxHeight()}>`, with
  `maxHeight = tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3))`; the home screen
  caps width with `prompt.max_width` (`"auto"` → `Math.max(75, Math.floor(dimensions().width * 0.7))`,
  R:packages/tui/src/routes/home.tsx, fetched 2026-09-20).
- Enter vs newline is a keybind, not a hard-coded rule (R:packages/tui/src/config/keybind.ts, fetched 2026-09-20):
  `input_submit: keybind("return", ...)`, `input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", ...)`.
  The docs add that Windows Terminal must be taught to send `"\u001b[13;2u"` for Shift+Enter
  (R:packages/web/src/content/docs/keybinds.mdx "Shift+Enter", fetched 2026-09-20).
- Full readline/Emacs set as keybinds: `input_line_home: ctrl+a`, `input_line_end: ctrl+e`, `input_move_left:
  left,ctrl+b`, `input_move_right: right,ctrl+f`, `input_delete_to_line_end: ctrl+k`, `input_delete_to_line_start:
  ctrl+u`, `input_delete_word_backward: ctrl+w,ctrl+backspace,alt+backspace`, `input_word_forward:
  alt+f,alt+right,ctrl+right`, `input_undo: ctrl+-,super+z`, `input_redo: ctrl+.,super+shift+z`, `input_select_all:
  super+a`, `input_clear: ctrl+c`, `input_paste: { key: "ctrl+v", preventDefault: false }` (same file).
- Submit path: a re-entrancy guard (`if (submitting) return false`) documented as preventing "a double-pressed
  Enter" sending "a phantom empty prompt to a freshly created session"; the native `onSubmit` is deferred twice
  ("IME: double-defer so the last composed character (e.g. Korean hangul) is flushed"); typing `exit`, `quit` or
  `:q` and pressing Enter exits; submit is refused while autocomplete is visible, while disabled, or with no model.
- History: `prompt-history.jsonl` in the state dir, `MAX_HISTORY_ENTRIES = 50`, one JSON `PromptInfo` per line,
  consecutive duplicates collapsed, self-healing rewrite on load (R:packages/tui/src/prompt/history.tsx, fetched
  2026-09-20). Up/Down are shared with cursor movement: `prompt.history.previous` only fires when
  `input.cursorOffset === 0`; if the cursor is on the first visual row but not at offset 0 it first jumps to 0 and
  returns `false` so the keymap falls through to `input.move.up`; symmetric for next/end (same file, lines 862-924).
- Placeholders rotate a random example: `` `Ask anything… "${example}"` `` and in shell mode
  `` `Run a command… "${example}"` ``; examples `["Fix a TODO in the codebase", "What is the tech stack of this
  project?", "Fix broken tests"]` / `["ls -la", "git status", "pwd"]` (R:packages/tui/src/routes/home.tsx, fetched
  2026-09-20).
- Paste (`onPaste`): CR-only newlines normalised ("Windows ConPTY/Terminal often sends CR-only newlines in bracketed
  paste"); an *empty* bracketed paste dispatches `prompt.paste` to read the OS clipboard (image support: macOS
  `osascript` PNG, Windows PowerShell, `wl-paste`/`xclip`, then `clipboardy`) (R:packages/tui/src/clipboard.ts,
  fetched 2026-09-20); a pasted `file://` path becomes an attachment; long pastes
  (`lineCount >= 3 || pastedContent.length > 150`) are folded into a virtual `[Pasted ~N lines]` token styled
  `extmark.paste`, toggleable via `paste_summary_enabled` / `experimental.disable_paste_summary`.
- Stash: `prompt.stash`, `prompt.stash.pop`, `prompt.stash.list` (+ `DialogStash`), all default `none`.
- `!` shell mode: the `!` binding is enabled only when the prompt is empty and the cursor is at offset 0
  (`input?.visualCursor.offset === 0`), sets `mode = "shell"`; `escape` or `backspace` at offset 0 leaves shell
  mode; the agent label is replaced by `Shell`, border turns `theme.primary`, hint `esc exit shell mode`; submit calls
  `sdk.client.session.shell(...)` and "The output of the command is added to the conversation as a tool result"
  (R:packages/web/src/content/docs/tui.mdx "Bash commands", fetched 2026-09-20).
- `@` mentions and `/` commands share one autocomplete (`visible: false | "@" | "/"`,
  R:packages/tui/src/component/prompt/autocomplete.tsx, fetched 2026-09-20): files come from the server
  (`limit: "20"`, "Trust the order returned by fff (frecency, fuzzy score, filename bonus, etc. are already factored
  in)"), plus `@agent` for non-primary agents, `@alias` references, MCP resources, `#L10-20` line ranges; non-file
  candidates are ranked by `fuzzysort` with `threshold: store.visible === "@" ? 0.5 : 0`, `limit: 10`, matching
  `description` only for `/`. Keys: `prompt.autocomplete.prev: up,ctrl+p`, `.next: down,ctrl+n`, `.hide: escape`,
  `.select: return`, `.complete: tab`. A file-level frecency store is kept (`R:packages/tui/src/prompt/frecency.tsx`).

### 2.2 Message list (`R:packages/tui/src/routes/session/index.tsx`, 2,706 lines, fetched 2026-09-20)

- `<scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1} scrollAcceleration={...}>` with an optional
  scrollbar (`scrollbar_toggle`); `PART_MAPPING = { text: TextPart, tool: ToolPart, reasoning: ReasoningPart }`.
- Streaming text renders through OpenTUI `<markdown streaming={true} syntaxStyle={syntax()}>`; code through `<code
  filetype=... streaming>` highlighted by tree-sitter in a worker (the build embeds `@opentui/core/parser.worker`
  as `opentui-tree-sitter-worker.js`, R:packages/opencode/script/build.ts, fetched 2026-09-20).
- Tool blocks: hidden entirely once completed unless details are on (`tool_details_visibility` kv, default `true`;
  `shouldHide` = `!showDetails && status === "completed"`); output is collapsed with `collapseToolOutput(output,
  maxLines, maxChars)` where generic tools use `maxLines = 3`, bash uses `maxLines = 10`, and
  `maxChars = maxLines * Math.max(20, ctx.width - 6)`; overflow shows "Click to expand"/"Click to collapse"
  (R:packages/tui/src/util/collapse-tool-output.ts and index.tsx lines 1803-1805, 2053-2055, fetched 2026-09-20).
- Reasoning: "Collapsed by default in hide mode: a single line throughout, so the layout never shifts"; `/thinking`
  cycles modes; `display_thinking` keybind default `none`.
- Diffs: `<diff ... addedBg removedBg contextBg addedSignColor lineNumberFg ...>`; `diff_style: "auto" | "stacked"`
  ("'auto' adapts to terminal width, 'stacked' always shows single column", R:packages/tui/src/config/index.tsx,
  fetched 2026-09-20); a full-screen diff viewer with keybinds `diff_close: escape,q`, `diff_toggle: enter,space`,
  `diff_next_hunk: ]`, `diff_previous_hunk: [`, `diff_next_file: n`, `diff_previous_file: p`,
  `diff_toggle_file_tree: b`, `diff_toggle_view: v` (split/unified), `diff_help: ?`.
- Undo banner inside the list: "`{n} message reverted`", "`{redoShortcut} or /redo to restore`", then per file
  `+additions`/`-deletions` in `theme.diffAdded`/`theme.diffRemoved`; clicking it asks `DialogConfirm` "Confirm
  Redo" (index.tsx lines 1200-1262). Aborted messages get " · interrupted".
- Message timestamps toggle (`session_toggle_timestamps`), generic tool output toggle, code-block conceal toggle
  (`messages_toggle_conceal: <leader>h`), copy message (`messages_copy: <leader>y`).

### 2.3 Sidebar, footer, status

- Footer (`R:packages/tui/src/routes/session/footer.tsx`, fetched 2026-09-20): left = working directory; right =
  `△ N Permission(s)` in `theme.warning` when requests are pending, `• N LSP` (green dot when > 0), `⊙ N MCP` (red
  when any errored), and a muted `/status` hint; while disconnected it alternates "Get started /connect".
- Sidebar (`sidebar_toggle: <leader>b`; R:packages/tui/src/routes/session/sidebar.tsx +
  `feature-plugins/sidebar/*.tsx`, fetched 2026-09-20): session title, share URL, channel badge when not `latest`,
  then a context widget computed from the last assistant message: `tokens = input + output + reasoning +
  cache.read + cache.write`, `percent = Math.round(tokens / model.limit.context * 100)`, rendered as
  "`{tokens} tokens`", "`{percent}% used`", "`{money} spent`" (session cost); LSP entries coloured
  `connected → success` else `error`; MCP entries `connected / failed / disabled / needs_auth /
  needs_client_registration` with per-status colours and "`(N active, M errors)`"; files changed; todo list.
- The prompt header shows the agent name (or `Shell`) and model; auto-permission mode shows a muted `auto`
  indicator (R:packages/web/src/content/docs/permissions.mdx, fetched 2026-09-20).
- Terminal title: `renderer.setTerminalTitle(\`OC | ${title}\`)`, cleared with `setTerminalTitle("")` on destroy
  (R:packages/tui/src/app.tsx, R:packages/tui/src/util/renderer.ts, fetched 2026-09-20); `OPENCODE_DISABLE_TERMINAL_TITLE`.
- Toasts: absolute `top={2} right={2}`, left/right border coloured by variant `info|success|warning|error`, default
  `duration: 5000` (R:packages/tui/src/ui/toast.tsx, fetched 2026-09-20).

### 2.4 Dialogs

- Generic layer (`R:packages/tui/src/ui/dialog.tsx`, fetched 2026-09-20): a full-screen absolute box `zIndex={3000}`
  with `paddingTop={dimensions().height / 4}`, `maxWidth={dimensions().width - 2}`, a *stack* (`store.stack`), escape
  pops one, `clear()`/`replace()`, and a modal mode pushed on the keymap mode stack.
- `DialogSelect` (`R:packages/tui/src/ui/dialog-select.tsx`, fetched 2026-09-20): inline filter input, `fuzzysort`
  over `title` (+ category), grouping by `category`, keys `dialog.select.prev: up,ctrl+p`, `.next: down,ctrl+n`,
  `.page_up/.page_down: pageup/pagedown`, `.home/.end`, `.submit: return`; options carry `title, description,
  category, footer, disabled, onSelect`.
- Command palette (`command_list: ctrl+p`, R:packages/tui/src/component/command-palette.tsx, fetched 2026-09-20):
  built from the keymap registry, `keymap.getCommandEntries({ namespace: "palette", visibility: "reachable" })`,
  each row shows the formatted binding in `footer`, a "Suggested" category is prepended when unfiltered, selecting
  runs `keymap.dispatchCommand(name)`. Commands are declared once with `name, title, category, slashName,
  slashAliases, hidden, suggested, run` (e.g. `session.list` → `slashName: "sessions", slashAliases: ["resume",
  "continue"]`; `session.new` → `"new"`, aliases `["clear"]`; `model.list` → `"models"`, alias `"mo"`)
  (R:packages/tui/src/app.tsx lines 560-700, fetched 2026-09-20).
- Session picker (`session_list: <leader>l`, R:packages/tui/src/component/dialog-session-list.tsx, fetched
  2026-09-20): server search `session.list({ limit: search ? 30 : 100, search })` debounced 150 ms, top-level
  sessions sorted by `time.updated` desc, footer = basename of a non-main directory, pinned section
  (`session_pin_toggle: ctrl+f`), quick slots 1-9 (`<leader>1..9`), rename `ctrl+r`, delete `ctrl+d` with a two-press
  confirmation ("Press ${deleteHint()} again to confirm").
- Model picker (`model_list: <leader>m`, R:packages/tui/src/component/dialog-model.tsx, fetched 2026-09-20):
  categories Favorites → Recent → one per provider (sorted, `opencode` first), footer `Free` for zero-cost models,
  `model_favorite_toggle: ctrl+f`, `model_provider_list: ctrl+a`, `model_cycle_recent: f2` / `shift+f2`,
  `variant_cycle: ctrl+t`.
- Theme picker (`theme_list: <leader>t`, R:packages/tui/src/component/dialog-theme-list.tsx, fetched 2026-09-20):
  live preview `onMove={(opt) => theme.set(opt.value)}`, restores the initial theme on cancel; 33 bundled theme
  JSON files under `packages/tui/src/theme/assets/` (tree, fetched 2026-09-20) plus `system`.
- Help (`R:packages/tui/src/ui/dialog-help.tsx`) is one paragraph: "Press {commandShortcut()} to see all available
  actions and commands in any context." Also: status (`<leader>s`), agent list (`<leader>a`), MCP toggle
  (`dialog.mcp.toggle: space`), timeline (`<leader>g`), fork, stash, which-key panel (`ctrl+alt+k`), a debug
  overlay and an in-app console (`app.console`). Count: 21 `component/dialog-*.tsx`, 4 session-route dialogs,
  6 generic `ui/dialog*.tsx` (tree, fetched 2026-09-20).
- Question dialog (agent asks the user; R:packages/tui/src/routes/session/question.tsx, fetched 2026-09-20): one
  tab per question, options plus an "Other" free-text input, `left/right/h/l/tab` to move, Enter to confirm.

### 2.5 Permission / approval prompt (`R:packages/tui/src/routes/session/permission.tsx`, fetched 2026-09-20)

- Inline (not modal) panel above the prompt, `Show when={permissions().length > 0}`; a `permission | always |
  reject` stage machine; the option row is exactly
  `options={{ once: "Allow once", always: "Allow always", reject: "Reject" }}` with `escapeKey="reject"`, moved with
  `left/right` (and vim `h/l`), confirmed with Enter, `permission.prompt.fullscreen: ctrl+f` toggles a full-height
  view; edits show a `<diff>` from `request.metadata.diff` ("No diff provided" otherwise).
- Title per tool: `Edit <path>`, `Read <path>`, `Glob "<pattern>"`, `Grep "<pattern>"`, `List <dir>`, `Shell
  command`, `WebFetch <url>`, `Access external directory <dir>` (lists patterns), `Continue after repeated
  failures`, `Call tool <name>`.
- "Allow always" explains scope before committing: "This will allow the following patterns until OpenCode is
  restarted" (or "This will allow <permission> until OpenCode is restarted" for `*`). Rejecting inside a subagent
  session asks for guidance: "Tell OpenCode what to do differently".
- Reply API: `sdk.client.permission.reply({ reply: "once" | "always" | "reject", requestID })`; HTTP `POST
  /session/:id/permissions/:permissionID` body `{ response, remember? }` (server.mdx, fetched 2026-09-20).
- Policy side (R:packages/web/src/content/docs/permissions.mdx, fetched 2026-09-20): every rule resolves to
  `"allow" | "ask" | "deny"`; object syntax per tool (`"bash": { "*": "ask", "git *": "allow", "rm *": "deny" }`),
  "last matching rule winning", `*`/`?` wildcards, `~`/`$HOME` expansion, `external_directory`; `--auto` flag
  auto-approves anything not explicitly denied ("dangerous!" in the yargs help).

### 2.6 Leader key, keybind schema and defaults (`R:packages/tui/src/config/keybind.ts`, fetched 2026-09-20)

- `export const LeaderDefault = "ctrl+x"`; `leader_timeout` default 2000 ms ("controls how long OpenCode waits for
  the next key after the leader key", keybinds.mdx); implemented with `registerTimedLeader(keymap, { trigger:
  leader, timeoutMs: config.leader_timeout })` (R:packages/tui/src/keymap.tsx, fetched 2026-09-20).
- Value schema (Effect Schema): `BindingValueSchema = Union([Literal(false), Literal("none"), BindingItem,
  Array(BindingItem)])` where `BindingItem = Union([String, KeyStroke, BindingObject])`, `KeyStroke = { name, ctrl?,
  shift?, meta?, super?, hyper? }`, `BindingObject = { key, event?: "press"|"release", preventDefault?,
  fallthrough?, ...rest }`. A string may hold comma-separated chords; `<leader>` is a token. Unknown keys are dropped
  with a warning before parsing (`dropUnknownKeybinds`, R:packages/opencode/src/config/tui.ts, fetched 2026-09-20).
- 184 `keybind(...)` definitions (count, fetched 2026-09-20). Defaults worth copying verbatim:
  `app_exit: "ctrl+c,ctrl+d,<leader>q"`, `command_list: "ctrl+p"`, `editor_open: "<leader>e"`, `theme_list:
  "<leader>t"`, `sidebar_toggle: "<leader>b"`, `status_view: "<leader>s"`, `session_export: "<leader>x"`,
  `session_new: "<leader>n"`, `session_list: "<leader>l"`, `session_timeline: "<leader>g"`, `session_rename:
  "ctrl+r"`, `session_interrupt: "escape"`, `session_compact: "<leader>c"`, `session_parent: "up"`,
  `session_child_cycle: "right"`, `model_list: "<leader>m"`, `agent_list: "<leader>a"`, `agent_cycle: "tab"`,
  `agent_cycle_reverse: "shift+tab"`, `messages_page_up: "pageup,ctrl+alt+b"`, `messages_page_down:
  "pagedown,ctrl+alt+f"`, `messages_half_page_up: "ctrl+alt+u"`, `messages_first: "ctrl+g,home"`, `messages_last:
  "ctrl+alt+g,end"`, `messages_copy: "<leader>y"`, `messages_undo: "<leader>u"`, `messages_redo: "<leader>r"`,
  `history_previous: "up"`, `history_next: "down"`, `terminal_suspend: "ctrl+z"`, `input_paste: { key: "ctrl+v",
  preventDefault: false }`. Windows: `input_undo` gains `ctrl+z` and `terminal_suspend` is forced to `none`
  (keybinds.mdx note; `resolve(..., { terminalSuspend: process.platform !== "win32" })` in config/tui.ts).
- Each config key maps to a command id (`CommandMap`: `messages_undo → "session.undo"`, `input_submit →
  "input.submit"`, `command_list → "command.palette.show"` ...), so the palette, which-key and docs all derive
  from one table.

### 2.7 Slash commands, modes, shell, mentions

- Documented list (R:packages/web/src/content/docs/tui.mdx, fetched 2026-09-20): `/connect`, `/compact`
  (alias `/summarize`, `ctrl+x c`), `/details`, `/editor` (`ctrl+x e`), `/exit` (`/quit`, `/q`, `ctrl+x q`),
  `/export` (`ctrl+x x`, "Export current conversation to Markdown and open in your default editor"), `/help`,
  `/init` ("Guided setup for creating or updating `AGENTS.md`"), `/models` (`ctrl+x m`), `/new` (`/clear`,
  `ctrl+x n`), `/redo` (`ctrl+x r`), `/sessions` (`/resume`, `/continue`, `ctrl+x l`), `/share`, `/themes`
  (`ctrl+x t`), `/thinking`, `/undo` (`ctrl+x u`), `/unshare`. Code adds `/agents`, `/mcps`, `/skills`, `/status`,
  `/debug`, `/variants`, `/org`, `/move`, `/warp`, `/workspaces` (experimental) (grep of `slashName:` in app.tsx and
  prompt/index.tsx, fetched 2026-09-20). User-defined commands (`command` in opencode.json or markdown files in
  `.opencode/commands/`) also appear in `/` autocomplete with `$ARGUMENTS` templating
  (R:packages/web/src/content/docs/config.mdx "Commands", fetched 2026-09-20).
- `/export` produces `# <title>` then `## Assistant (<Agent> · <model> · <duration>)` sections, with reasoning and
  tool input/output included only when `thinking`/`toolDetails` options are on
  (R:packages/tui/src/util/transcript.ts, fetched 2026-09-20).
- Agents: "two built-in agents you can switch between with the `Tab` key. **build** - Default, full-access agent
  ... **plan** - Read-only agent ... Denies file edits by default, Asks permission before running bash commands";
  `@general` subagent via mention (R:README.md, fetched 2026-09-20).
- `/undo` and `/redo` are git-snapshot based: "Undo last message in the conversation. Removes the most recent user
  message, all subsequent responses, and any file changes ... Internally, this uses Git to manage the file
  changes. So your project **needs to be a Git repository**" (tui.mdx). Mechanics in
  `R:packages/opencode/src/snapshot/index.ts` (807 lines, fetched 2026-09-20):
  - a *separate* git dir: `gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))`,
    every call is `git --git-dir <gitdir> --work-tree <worktree> ...` with `-c core.autocrlf=false -c
    core.longpaths=true -c core.symlinks=true -c core.quotepath=false`;
  - `git init` once, then `config core.fsmonitor false`, `feature.manyFiles true`, `index.version 4`,
    `index.threads true`, `core.untrackedCache true`; the object store is shared with the real repo through
    `rev-parse --git-common-dir` ("Reuse the hashes for the git storage between the original repo and snapshot on
    huge repos like chromium checkout");
  - `track()` = stage changed + untracked files via `diff-files --name-only -z` and `ls-files --others
    --exclude-standard -z`, skipping ignored files (`check-ignore --no-index --stdin -z`) and untracked files over
    `limit = 2 * 1024 * 1024` bytes, `add --all --sparse --pathspec-from-file=- --pathspec-file-nul`, then
    `write-tree` → the snapshot hash; `gc --prune=7.days` occasionally;
  - `restore(hash)` = `read-tree <hash>` then `checkout-index -a -f`; `revert(patches)` = `checkout <hash> --
    <file>` per file (batched `ls-tree` first) or delete the file if it did not exist in the tree; `diff(hash)` =
    `diff --cached --no-ext-diff <hash> -- .`; `diffFull(from, to)` uses `diff --name-status` + `--numstat` and
    `cat-file --batch`;
  - enabled only when `state.vcs === "git"` and `config.snapshot !== false` ("For large repositories ... the
    snapshot system can cause slow indexing and significant disk usage", config.mdx "Snapshot").
  - `R:packages/opencode/src/session/revert.ts` (fetched 2026-09-20): `rev.snapshot = session.revert?.snapshot ??
    (yield* snap.track())`, `snap.restore(previous)`, `snap.revert(patches)`, `rev.diff = snap.diff(rev.snapshot)`;
    `unrevert` restores the saved snapshot and finally deletes the reverted messages. HTTP: `POST
    /session/:id/revert { messageID, partID? }`, `POST /session/:id/unrevert` (server.mdx).
- `/share` → `POST /session/:id/share`, public URL `opncd.ai/s/<share-id>` copied to clipboard; modes `share:
  "manual" | "auto" | "disabled"` (R:packages/web/src/content/docs/share.mdx, fetched 2026-09-20).
- `/compact` → `POST /session/:id/summarize`; `/init` → `POST /session/:id/init`; `/new` → `POST /session`;
  `Escape` → `POST /session/:id/abort` (server.mdx; keybind `session_interrupt: escape`).

## 3. Sessions, storage and config

- Paths are XDG (`xdg-basedir`): `data = ~/.local/share/opencode`, `cache = ~/.cache/opencode`, `config =
  ~/.config/opencode`, `state = ~/.local/state/opencode`, `log = <data>/log`, `bin = <cache>/bin`, `tmp =
  <os.tmpdir>/opencode`; all created at import time with `fs.mkdir(..., { recursive: true })`
  (R:packages/core/src/global.ts, fetched 2026-09-20). Logs keep "the most recent 10 log files"
  (R:packages/web/src/content/docs/troubleshooting.mdx, fetched 2026-09-20).
- Sessions/messages/parts now live in SQLite (drizzle): `join(Global.Path.data, "opencode.db")` (channel builds use
  `opencode-<channel>.db`, override `OPENCODE_DB`), `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`
  (R:packages/core/src/database/database.ts, fetched 2026-09-20); 19 dated migrations from `20260127222353` to
  `20260504145000` (tree, fetched 2026-09-20). The pre-SQLite layout was plain JSON —
  `storage/session/info/<id>.json`, `storage/session/message/<sessionID>/<msgID>.json`,
  `storage/session/part/<sessionID>/<msgID>/<partID>.json`, later `session/<projectID>/<id>.json`,
  `message/<sessionID>/*.json`, `part/<messageID>/*.json`, `session_diff/<id>.json` — with numbered migrations
  (R:packages/opencode/src/storage/storage.ts, fetched 2026-09-20).
- IDs (R:packages/opencode/src/id/id.ts, fetched 2026-09-20): `<prefix>_<12 hex><14 base62>` where prefixes are
  `ses`, `msg`, `prt`, `per`, `que`, `evt`, `job`, `pty`, `tool`, `wrk`; the hex part is `(Date.now() * 0x1000 +
  counter)` as 6 big-endian bytes (monotonic within a millisecond), `descending` ids bit-invert it so newest sorts
  first; `LENGTH = 26`.
- TUI-local state: `kv.json` written atomically (`<file>.<pid>.<uuid>.tmp` + `rename`) under a cross-process
  `Flock` (R:packages/tui/src/context/kv.tsx, R:packages/tui/src/util/persistence.ts, fetched 2026-09-20) holding
  `tool_details_visibility`, `theme_mode_lock`, `animations_enabled`, `paste_summary_enabled`, pins, slots, etc.
- Resume/multi-session: `opencode [project] [--continue|-c] [--session|-s <id>] [--fork] [--prompt] [--model|-m]
  [--agent] [--auto] [--port] [--hostname] [--mdns] [--cors] [--mini]` (R:packages/opencode/src/cli/cmd/tui.ts and
  cli.mdx, fetched 2026-09-20); `validateSession` runs before the TUI mounts; sessions are project-scoped and
  child (subagent) sessions are navigated with `up/left/right/<leader>down`; quick slots `<leader>1..9`; an
  "epilogue" string set by the UI is printed to stdout after the renderer is destroyed
  (`if (result.epilogue) process.stdout.write(result.epilogue + "\n")`, R:packages/tui/src/app.tsx, fetched
  2026-09-20).
- Config split: `opencode.json`/`.jsonc` = runtime (`$schema: https://opencode.ai/config.json`; keys include
  `model`, `small_model`, `agent`, `permission`, `command`, `mcp`, `provider`, `share`, `snapshot`, `autoupdate`,
  `instructions`, `plugin`, `formatter`, `lsp`, `compaction`, `watcher`, `experimental`); `tui.json`/`.jsonc` = UI
  (`$schema: https://opencode.ai/tui.json`; `theme`, `keybinds`, `plugin`, `plugin_enabled`, `leader_timeout`,
  `attention{enabled,notifications,sound,volume,sound_pack,sounds}`, `prompt{max_height,max_width}`,
  `scroll_speed` (>= 0.001, default 3), `scroll_acceleration{enabled}`, `diff_style`, `cursor{style:
  block|underline|line|default, blinking}`, `mouse` (default true)) (R:packages/tui/src/config/index.tsx and
  R:packages/web/src/content/docs/tui.mdx "Configure", fetched 2026-09-20). "Legacy `theme`, `keybinds`, and `tui`
  keys in `opencode.json` are deprecated and automatically migrated when possible" (config.mdx; `hadLegacy` check
  in R:packages/opencode/src/config/config.ts line 57).
- TUI config precedence (R:packages/opencode/src/config/tui.ts, fetched 2026-09-20): global
  `~/.config/opencode/tui.json` → `OPENCODE_TUI_CONFIG` → project `tui.json` files "applied root-first so the
  closest file wins" → `.opencode` directories walking up + `OPENCODE_CONFIG_DIR`; deep-merged; invalid files are
  skipped with a warning ("every broken-config path degrades gracefully rather than crashing TUI startup"). The
  same loader triggers `npm.install(dir, { add: [{ name: "@opencode-ai/plugin" }] })` for every `.opencode` dir
  that declares plugins — at startup.
- Runtime config precedence, 8 levels: remote `.well-known/opencode` → global → `OPENCODE_CONFIG` → project →
  `.opencode` dirs → `OPENCODE_CONFIG_CONTENT` → managed files → macOS managed preferences (config.mdx).
- Custom themes: `~/.config/opencode/themes/*.json`, `.opencode/themes/*.json`; JSON with `defs`, hex or ANSI
  0-255, `{dark, light}` variants, `"none"` = terminal default; the `system` theme "Generates gray scale ... based on
  your terminal's background color" and "Uses ANSI colors (0-15)" (R:packages/web/src/content/docs/themes.mdx,
  fetched 2026-09-20).

## 4. Terminal handling (OpenTUI, as configured by opencode)

- Renderer construction (R:packages/tui/src/app.tsx lines 194-206, fetched 2026-09-20):
  `createCliRenderer({ externalOutputMode: "passthrough", targetFps: 60, gatherStats: false, exitOnCtrlC: false,
  useKittyKeyboard: {}, autoFocus: false, openConsoleOnError: false, useMouse: !Flag.OPENCODE_DISABLE_MOUSE &&
  input.config.mouse, consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] } })`.
  Before mounting: `renderer.getPalette({ size: 16 })` is pre-warmed and
  `const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"` — up to a 1 s wait on the OSC 10/11 answer
  ("Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash").
- **Alternate screen is the default.** `screenMode?: ScreenMode` "Defaults to \"alternate-screen\"";
  `type ScreenMode = "alternate-screen" | "main-screen" | "split-footer"`; `ExternalOutputMode = "capture-stdout" |
  "passthrough"` ("capture-stdout: Queue stdout and replay it above the split footer. Only valid with
  split-footer"); env overrides `OTUI_USE_ALTERNATE_SCREEN`, `OTUI_OVERRIDE_STDOUT`; `footerHeight` default 12
  (O:packages/core/src/renderer.ts lines 201-250, 370-385, fetched 2026-09-20). The main TUI therefore owns the
  whole screen; `opencode --mini` / `opencode run --interactive` instead uses `screenMode: "split-footer",
  footerHeight: FOOTER_HEIGHT, externalOutputMode: "capture-stdout", targetFps: 30, useMouse: false,
  useKittyKeyboard: { events: process.platform === "win32" }` and streams immutable rows into scrollback
  (R:packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts lines 181-192 and scrollback.surface.ts, fetched
  2026-09-20) — "replay commits immutable scrollback rows" on resume/resize (runtime.ts).
- Exact sequences (O:packages/native/src/ansi.zig, fetched 2026-09-20): `switchToAlternateScreen = "\x1b[?1049h"`
  / `"\x1b[?1049l"`; mouse `"\x1b[?1000h"`, `"\x1b[?1002h"`, `"\x1b[?1003h"`, SGR `"\x1b[?1006h"`;
  `bracketedPasteSet = "\x1b[?2004h"` / `Reset = "\x1b[?2004l"`; `focusSet = "\x1b[?1004h"`; synchronized output
  `syncSet = "\x1b[?2026h"` / `syncReset = "\x1b[?2026l"`; kitty keyboard `csiUQuery = "\x1b[?u"`, `csiUPush =
  "\x1b[>{d}u"`, `csiUPop = "\x1b[<u"`; capability probes `decrqmBracketedPaste = "\x1b[?2004$p"`, `decrqmSync =
  "\x1b[?2026$p"`, `cursorPositionRequest = "\x1b[6n"`, `oscThemeQueries = "\x1b]10;?\x07\x1b]11;?\x07"`; cursor
  shapes `"\x1b[2 q"` block, `"\x1b[1 q"` blinking block, `"\x1b[6 q"` bar, `"\x1b[4 q"` underline, reset
  `"\x1b[0 q"`; OSC 52 framing `"\x1b]52;c;" ... "\x1b\\"` (or BEL under GNU screen).
- Kitty flags default `0b00101` = disambiguate + alternate keys ("Bit 2 (0b100): Report alternate keys ... Default
  0b00101 (5)", O:packages/native/src/terminal.zig line 187); `KittyKeyboardOptions { disambiguate?, alternateKeys?,
  events?, allKeysAsEscapes?, reportText? }` (O:packages/core/src/renderer.ts lines 597-640); when kitty is not
  supported it falls back to xterm `modifyOtherKeys`; "Always just try to enable bracketed paste, even if it was
  reported as not supported" (terminal.zig line 726); on Windows ConPTY it assumes `rgb`, `ansi256` and bracketed
  paste (line 453-458).
- Teardown order `resetState` (terminal.zig lines 284-330): show cursor → SGR reset → reset mouse pointer → kitty
  pop → modifyOtherKeys off → mouse off → bracketed paste off → focus tracking off → leave alt screen → colour
  scheme updates (mode 2031) off → title cleared. OSC 111 (reset background) is deliberately *not* sent: "In
  Ghostty, sending the reset alone is enough to poison later OSC 11 background reporting ... which breaks theme
  detection on the next app startup".
- Startup capability flow (O:packages/core/src/specs/terminal-startup.md, fetched 2026-09-20): native writes
  "theme color queries, `XTVERSION`, cursor position requests, capability queries, and width/scale probes"; a
  "5000ms capability timeout"; remote mode auto-detected from `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`,
  `MOSH_CONNECTION`; tmux < 3.6 wraps OSC palette queries in DCS passthrough. Response recognisers cover DECRPM
  `ESC[?…$y`, CPR `ESC[row;colR`, XTVERSION `ESC P>|…ESC \`, kitty graphics `ESC _G…`, kitty keyboard `ESC[?Nu`,
  DA1, pixel size `ESC[4;h;wt`, OSC 99 and iTerm2 `OSC 1337;Capabilities=`
  (O:packages/core/src/lib/terminal-capability-detection.ts, fetched 2026-09-20).
- Resize: `process.on("SIGWINCH", ...)` only "when attached to the process's real stdout"; the mini mode
  re-renders on `CliRenderEvents.RESIZE` (renderer.ts lines 1234-1239; runtime.lifecycle.ts line 370).
- Scrolling: `scroll_speed` (default `CustomSpeedScroll(3)`) or `MacOSScrollAccel` when
  `scroll_acceleration.enabled` (R:packages/tui/src/util/scroll.ts, fetched 2026-09-20); keyboard paging via the
  `messages_*` keybinds; mouse wheel through the mouse protocol.
- Copy: OSC 52 through the native layer (`copyToClipboardOSC52`, capability `osc52_support: "supported" |
  "unsupported" | "unknown"`, O:packages/core/src/lib/clipboard.ts) and a TS fallback that writes
  `` `\x1b]52;c;${base64}\x07` `` plus a tmux passthrough `` `\x1bPtmux;\x1b${sequence}\x1b\\` `` when `TMUX` or
  `STY` is set (R:packages/tui/src/clipboard.ts `writeOsc52`); copy-on-select is on by default
  (`OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` disables it, cli.mdx); `ctrl+y` copies the console selection.
- Suspend/external editor: `terminal_suspend: ctrl+z` runs `renderer.suspend(); process.once("SIGCONT", () =>
  renderer.resume())` (app.tsx lines 871-877); `/editor` suspends, spawns `$VISUAL || $EDITOR` on a temp
  `${Date.now()}.md`, resumes (R:packages/tui/src/editor.ts, fetched 2026-09-20); GUI editors need `--wait`
  (tui.mdx).
- Windows: `win32DisableProcessedInput()` clears `ENABLE_PROCESSED_INPUT` via `kernel32 SetConsoleMode` so Ctrl+C
  is a key, and `win32InstallCtrlCGuard()` re-applies it because "Various runtimes can re-apply console modes"
  (R:packages/tui/src/terminal-win32.ts, fetched 2026-09-20).
- Attention: focus tracking (mode 1004) gates desktop notifications — "non-subagent events request desktop
  notifications only when the terminal is blurred" — delivered via kitty OSC 99 / iTerm2 OSC 1337 when detected,
  plus optional sounds (tui.mdx "Attention"; capability regexes above). SIGHUP destroys the renderer (app.tsx).

## 5. Packaging and distribution

- **Binaries:** `Bun.build({ ..., minify: true, splitting: true, format: "esm", compile: { target:
  "bun-<os>-<arch>[-baseline][-musl]", outfile: "dist/<name>/bin/opencode", execArgv:
  ["--user-agent=opencode/<version>", "--use-system-ca", "--"], autoloadBunfig: false, autoloadDotenv: false } })`
  for 12 targets: linux arm64/x64/x64-baseline/arm64-musl/x64-musl/x64-baseline-musl, darwin arm64/x64/x64-baseline,
  windows arm64/x64/x64-baseline ("baseline" = no AVX2). Entry points: `src/index.ts`, the TUI server worker
  `./src/cli/tui/worker.ts`, the tree-sitter worker and the embedded web UI; versions injected with `define:
  { OPENCODE_VERSION, OPENCODE_CHANNEL, OPENCODE_MODELS_DEV ... }`; a smoke test runs `<binary> --version` for the
  host target; each target gets a `package.json` `{ name, version, preferUnplugged: true, os: [os], cpu: [arch],
  libc? }`; on release: `gh release upload v<version> ./dist/*.zip ./dist/*.tar.gz --clobber`
  (R:packages/opencode/script/build.ts, fetched 2026-09-20).
- **npm:** `opencode-ai@1.18.31` (latest, published 2026-09-14T17:47:43Z; 12,146 versions; dist-tags `latest`,
  `beta`, `dev`, `next`, `tui-v2` and ~35 `snapshot-*` tags) has *no* `dependencies`, `bin: { opencode:
  "bin/opencode.exe" }`, `scripts: { postinstall: "node ./postinstall.mjs" }`, `os: ["darwin","linux","win32"]`,
  `cpu: ["arm64","x64"]`, and 12 `optionalDependencies` `opencode-<os>-<arch>[-baseline][-musl]@1.18.31`
  (`https://registry.npmjs.org/opencode-ai`, fetched 2026-09-20). `opencode-darwin-arm64@1.18.31` `unpackedSize:
  144,470,642` bytes (`https://registry.npmjs.org/opencode-darwin-arm64`, fetched 2026-09-20).
- `R:packages/opencode/script/publish.ts` (fetched 2026-09-20) writes the wrapper package with a `bin/opencode.exe`
  *shell script* that only prints "Error: opencode-ai's postinstall script was not run ... when using
  --ignore-scripts ... or when using a package manager like pnpm that does not run postinstall scripts by default";
  `postinstall.mjs` (R:packages/opencode/script/postinstall.mjs) resolves the right platform package
  (`require.resolve("<name>/package.json")`), hard-links or copies `bin/opencode` over `bin/opencode.exe`, verifies
  with `--version`, and falls back to `npm install --ignore-scripts --no-save --loglevel=error --prefix <tmpdir>
  <name>@<version>`. AVX2 detection: `/proc/cpuinfo`, `sysctl -n hw.optional.avx2_0`, PowerShell
  `IsProcessorFeaturePresent(40)`; musl via `/etc/alpine-release` or `ldd --version`. Publishing is idempotent
  (`npm view <name>@<version>` first) and channel-tagged: `npm publish *.tgz --access public --tag <channel>`.
- The older launcher `R:packages/opencode/bin/opencode` (fetched 2026-09-20) is a Node script: walks up
  `node_modules` for the platform package, honours `OPENCODE_BIN_PATH`, spawns with `stdio: "inherit"`, forwards
  `SIGINT`, `SIGTERM`, `SIGHUP` to the child, re-raises the child's signal on itself.
- **curl installer** (`R:install`, 460 lines, fetched 2026-09-20; served as `https://opencode.ai/install`): detects
  `darwin|linux|windows` × `x64|arm64`, Rosetta (`sysctl -n sysctl.proc_translated`), musl, AVX2 → asset name
  `opencode-<target>.zip|.tar.gz` from `https://github.com/anomalyco/opencode/releases/latest/download/`; flags
  `--version|-v`, `--binary|-b`, `--no-modify-path`; install dir `$HOME/.opencode/bin` (README documents the priority
  `$OPENCODE_INSTALL_DIR` → `$XDG_BIN_DIR` → `$HOME/bin` → `$HOME/.opencode/bin`); skips if `opencode --version`
  already equals the target; draws a progress bar from `curl --trace-ascii` through a FIFO; appends `export PATH=` to
  the first existing rc file of the detected shell (`fish_add_path` for fish); writes `$GITHUB_PATH` under Actions;
  ends with an ASCII logo and "OpenCode includes free models, to start:".
- **Homebrew:** tap `anomalyco/homebrew-tap`, file `opencode.rb` at the tap root (not `Formula/`), generated by
  publish.ts (its header still says "This file was generated by GoReleaser. DO NOT EDIT."), `depends_on "ripgrep"`,
  per-arch `url` to the GitHub release zip/tar.gz + `sha256`, `bin.install "opencode"`
  (`https://raw.githubusercontent.com/anomalyco/homebrew-tap/master/opencode.rb`, fetched 2026-09-20). README:
  `brew install anomalyco/tap/opencode` "(recommended, always up to date)" vs `brew install opencode` "(official brew
  formula, updated less)"; also `scoop`, `choco`, `pacman`, `paru -S opencode-bin`, `mise use -g opencode`,
  `nix run nixpkgs#opencode` (R:README.md, fetched 2026-09-20). publish.ts also pushes an AUR `PKGBUILD` for
  `opencode-bin` and a Docker image `ghcr.io/anomalyco/opencode` for `linux/amd64,linux/arm64`.
- **Release automation** (R:.github/workflows/publish.yml, 517 lines, fetched 2026-09-20): triggers `push` to
  `dev`, `beta`, `ci`, `snapshot-*` and `workflow_dispatch` with `bump: major|minor|patch` or `version`; jobs
  `version` (`./script/version.ts` creates a *draft* GitHub release with notes from `script/changelog.ts`) →
  `build-cli` (`./packages/opencode/script/build.ts`) → `sign-cli-windows` (Azure Trusted Signing, re-zips) →
  `build-electron` (6-host matrix) → `publish` (`./script/publish.ts`: rewrites every `package.json` version, tags
  `v<version>`, publishes npm/AUR/brew/Docker, then `gh release edit <tag> --draft=false`); runners are
  `blacksmith-4vcpu-ubuntu-2404`. Version/channel are baked in at build time (`InstallationVersion`,
  `InstallationChannel`), surfaced by `opencode --version|-v` (R:packages/opencode/src/index.ts, fetched 2026-09-20).
- **Upgrade command** (R:packages/opencode/src/cli/cmd/upgrade.ts, R:packages/opencode/src/installation/index.ts,
  fetched 2026-09-20): `opencode upgrade [target] [--method|-m curl|npm|pnpm|bun|brew|choco|scoop]`; method detection:
  `process.execPath` containing `.opencode/bin` or `.local/bin` → `curl`, else probes `npm list -g --depth=0`,
  `yarn global list`, `pnpm list -g --depth=0`, `bun pm ls -g`, `brew list --formula opencode`, `scoop list
  opencode`, `choco list --limit-output opencode`; "latest" from `brew info --json=v2` or
  `https://formulae.brew.sh/api/formula/opencode.json`, `<registry>/opencode-ai/<channel>`, Chocolatey OData, or
  `https://api.github.com/repos/anomalyco/opencode/releases/latest`; if the method is `unknown` it warns "may be
  managed by a package manager" and asks "Install anyways?". Auto-update runs from the TUI 1 s after start
  (`setTimeout(() => client.call("checkUpgrade", ...), 1000).unref()`): `autoupdate: false` or
  `OPENCODE_DISABLE_AUTOUPDATE` skip; `"notify"` or a non-patch bump only emits `installation.update-available`;
  otherwise it silently upgrades (R:packages/opencode/src/cli/upgrade.ts, fetched 2026-09-20). Docs: "Notice that
  this only works if it was not installed using a package manager such as Homebrew" (config.mdx "Autoupdate").

## 6. Performance claims and issues

- No quantitative startup/latency claims in the README or docs (R:README.md, tui.mdx, fetched 2026-09-20). The
  only hard numbers are design constants: `targetFps: 60` (TUI), `targetFps: 30` (mini), 16 ms event batching,
  100 messages per session in memory, tool output collapsed to 3/10 lines, `leader_timeout` 2000 ms,
  `waitForThemeMode(1000)`, 5000 ms capability timeout.
- Startup work that opencode does before/around the first frame (all fetched 2026-09-20): spawn a `Worker` running
  the Hono server (cli/cmd/tui.ts); read and deep-merge every `tui.json` and `npm install` plugin deps per
  `.opencode` dir (config/tui.ts); `validateSession`; terminal capability + palette queries with a 1 s theme-mode
  wait (app.tsx); `checkUpgrade` after 1 s. Two documented consequences: #7979 "Very Slow OpenCode Loading Time"
  (label `perf`, "It downloads content checker binary (oh-my-opencode) then it performs update of plugins", Windows,
  closed 2026-03-05, 35 reactions) and #14965 "Slow startup" (open since 2026-02-24, 20 reactions: "happens in
  Ghostty but doesn't happen in Terminal or Alacritty ... or Kitty") — the HTML page shows no maintainer diagnosis
  (`https://github.com/anomalyco/opencode/issues/7979`, `.../issues/14965`, fetched 2026-09-20 via API and via
  WebFetch of the HTML page; root cause of #14965 UNVERIFIED — the terminal-only reproduction is consistent with a
  capability/OSC round-trip wait but no source confirms it).
- Flicker/blank-screen cluster after the Nov-2025 v1.0 rewrite to OpenTUI (search
  `https://api.github.com/search/issues?q=repo:anomalyco/opencode+is:issue+flicker`, fetched 2026-09-20): #3935
  "Unstable TUI" ("disappearing content area, that sporadically comes back, or you have to try to change the theme to
  make it redraw", Ghostty, label `opentui`, 2025-11-05 → closed 2025-11-12), #3780 "opentui: Rapid blinking in
  iTerm2", #3776 "Screen becomes completely blank" (57 comments), #4905 "Screen flickering/vibrating on diff views
  in v1.0.120, causes PTY host crash", #2500 "scrollbars missing", #32985 "does not work well inside GNU Screen (no
  truecolor, broken copy/paste, no mouse...)" (open), #42264 "TUI: text disappears during LLM streaming, main
  thread stuck in timerfd busy-loop (TreeSitter worker stack overflow)" (open, 2026-08-13: "the streaming code path
  doesn't update the text buffer independently of the highlight result, a worker crash leaves the displayed code
  frozen").
- Pre-rewrite: #811 "Text rendering is VERY slow (and CPU usage is really high even when idle)" (v0.2.15,
  Go/Bubble Tea era, "the main tui process uses 25-30% of a Xeon processor" idle, 84 comments, closed 2025-11-20)
  (`https://github.com/anomalyco/opencode/issues/811`, fetched 2026-09-20 via API + HTML).
- Memory: #20695 "Memory Megathread" (170 reactions, 144 comments, 2026-04-02 → closed 2026-09-08) asks users to
  "press ctrl+p and select heap snapshot" or run with `OPENCODE_AUTO_HEAP_SNAPSHOT=1` ("opencode checks memory once a
  minute and automatically writes a heap snapshot when rss is above 2gb"); related #5363 "eating 70gb of memory?",
  #9743 OOM kills, #13230 "kernel soft lockups ... 111GB virt", #17047 "Tool.define() accumulates wrapper closures:
  unbounded memory leak", #16697 "Multiple memory leaks cause unbounded RAM growth during extended TUI usage"
  (search API, fetched 2026-09-20). The code keeps the tooling: `Heap.start()` at CLI entry, hidden
  `app.heap_snapshot` command writing `tui.heapsnapshot` + `server.heapsnapshot`.
- Troubleshooting guidance: `--print-logs`, `--log-level DEBUG`, and for Windows "If you're experiencing slow
  performance ... try using WSL" (troubleshooting.mdx, fetched 2026-09-20).

## 7. Feasibility check against Ink 7.1.1 (installed) and measurements

- `NM:ink/build/render.d.ts` (fetched 2026-09-20) exposes `exitOnCtrlC`, `patchConsole`, `onRender`,
  `isScreenReaderEnabled`, `maxFps` (implementation default `options.maxFps ?? 30`), `incrementalRendering`,
  `concurrent`, `kittyKeyboard?: KittyKeyboardOptions` = `{ mode?: 'auto' | 'enabled' | 'disabled'; flags?:
  KittyFlagName[] }` with `kittyFlags = { disambiguateEscapeCodes: 1, reportEventTypes: 2, reportAlternateKeys: 4,
  reportAllKeysAsEscapeCodes: 8, reportAssociatedText: 16 }`, `interactive`, and `alternateScreen` (doc note: "The
  terminal's scrollback buffer is not available while in the alternate screen"). Instance methods include
  `waitUntilRenderFlush`, `clear`, `unmount`.
- Hooks (`NM:ink/build/index.d.ts`): `useInput` (`Key` has `shift`, `meta`, and `super`/`hyper` "Only available
  with kitty keyboard protocol"), `usePaste` ("Bracketed paste mode (`\x1b[?2004h`) is automatically enabled while
  the hook is active ... paste content is never forwarded to `useInput` handlers"), `useApp().suspendTerminal`
  (callback or `await using suspension = await suspendTerminal()`; "restore Ink's terminal state and force a full
  redraw"), `useCursor`, `useAnimation`, `useWindowSize`, `useBoxMetrics`, `useFocus`, `useFocusManager`, `Static`.
  Ink has no mouse protocol, no OSC 52, no scroll container, no markdown/syntax renderables — those must be
  hand-written from Node built-ins.
- Microbenchmarks run in the repo (2026-09-20, Node v22.23.2, unbundled `node_modules`, 3 runs):
  `import('react')` 4.3-5.8 ms, `import('ink')` 95.3-142.8 ms (cold first run 142.8 ms), process at 108.7-162.9 ms;
  the existing esbuild bundle `node bin/jevcode.js --version` completes in 0.02 s wall (`/usr/bin/time -p`). So the
  bundled path (DESIGN.md §12) is what keeps a chat-style TUI under the 300 ms first-frame gate; an unbundled Ink
  import alone would spend a third of it.
- Scale of what opencode ships (counts, fetched 2026-09-20): 184 keybind definitions, 19 documented slash commands
  (+ ~10 from code), 31 dialog components, 33 theme files, 185 TUI source files, 12 platform binaries of ~144 MB
  unpacked each, 12,146 npm versions published.

## 8. What to copy in spirit — for a Node + Ink implementation with only `ink` + `react`

1. **One command registry, three surfaces.** Declare every action once as `{ name, title, category, slashName,
   slashAliases, keybind, hidden, run }` (app.tsx pattern) and derive the `/` autocomplete, the `ctrl+p` palette
   (title + category + rendered binding, "Suggested" first) and the help text from it. Keep JevCode's existing
   `computeLayout` and `<Static>` transcript; the palette is a fixed-height overlay inside the `rows − 2` budget.
2. **Keybind config = keybind schema.** A `tui.keybinds` table in `jevcode.json` (or a separate `jevcode.tui.json`)
   mirroring opencode's value grammar: `"none" | false | "ctrl+x,<leader>q" | [ ... ] | { key, preventDefault }`,
   leader `ctrl+x`, `leader_timeout` 2000 ms, unknown keys dropped with a warning. Reuse the opencode default names
   where the concept exists (`app_exit`, `command_list`, `session_list`, `session_new`, `session_interrupt`,
   `messages_page_up/down`, `messages_undo/redo`, `input_submit`, `input_newline`, `history_previous/next`).
3. **Composer.** `useInput` + `usePaste`; Enter submits, `ctrl+j` always inserts a newline, `shift/alt/ctrl+return`
   when `kittyKeyboard: { mode: 'auto' }` reports them; readline subset (`ctrl+a/e/k/u/w`, `alt+b/f`); up/down = cursor
   move inside multi-line text, history only from offset 0 / end of buffer (quote the opencode rule); 50-entry JSONL
   history in `~/.jevcode/state/prompt-history.jsonl`; paste summary `[Pasted ~N lines]` for >= 3 lines or > 150
   chars; rotating placeholder; disabled + dimmed while a step is running with the text preserved (opencode's
   "queued prompts" is the analogue); typing `exit`/`quit`/`:q` exits.
4. **`!` shell mode and `@` mentions.** `!` at an empty prompt switches the label to `Shell` and routes the line to
   the sandbox (`exec:*` events already exist); `@` opens a fuzzy file list over the engine's candidate-file listing
   (limit 20, frecency-boosted), `Tab` completes, `Enter` selects, `Esc` hides.
5. **Message list semantics.** Tool/exec blocks collapsed to 3 lines (10 for `run` output) with an expand toggle,
   reasoning/"synth" progress folded to one line so "the layout never shifts", an " · interrupted" marker, an undo
   banner "`N steps reverted — <key> or /redo to restore`" listing files with `+a/-d`.
6. **Status/footer/sidebar.** Footer: workspace dir left; right: `△ N review` when a confirmation is pending,
   sandbox level, `/status`. Sidebar (`<leader>b`, only when `columns` allows): task, run id, model + Jev model,
   `tokens`, `% of context`, `$ spent / cap`, step/max, wall time. JevCode's decisions pane is unique — keep it and
   give it `/decisions` + a keybind; opencode has nothing comparable.
7. **Review prompt.** Keep the inline box but adopt the three-option row `Approve once | Approve for this pattern
   (this run) | Decline`, `Esc` = decline, `left/right` + Enter, `ctrl+f` full-height diff preview, per-action titles
   (`Edit <path>`, `Run <command>`), and an optional "tell Jev/the generator what to do differently" text on decline.
8. **Sessions.** `jevcode` (no task) opens a home screen with the composer; `-c/--continue`, `-s/--session <id>`,
   `/sessions` (aliases `/resume`, `/continue`) showing runs sorted by `time.updated` with search, two-press delete,
   pin/quick-slots; print an epilogue `resume with: jevcode run --resume <id>` after unmount.
9. **Undo/redo via a shadow git dir.** `git --git-dir ~/.jevcode/snapshot/<workspace-hash> --work-tree <ws>` with
   `write-tree` per step before the action executes, `read-tree` + `checkout-index -a -f` to restore, skip
   > 2 MiB untracked files and ignored files, `gc --prune=7.days`; only when the workspace is a git repo, config
   `snapshot: false` to disable. This composes with the existing step checkpoints (§9 of DESIGN.md).
10. **Terminal hygiene.** Bracketed paste (Ink does it), kitty keyboard `auto` (Ink does it, falls back cleanly),
    `useWindowSize` for SIGWINCH, `suspendTerminal` for `/editor` (`$VISUAL || $EDITOR`, temp `.md`), OSC 52 copy
    with tmux/screen passthrough for `/copy`, terminal title `JevCode | <task>` cleared on exit, cursor shape
    restored with `\x1b[0 q`, SIGHUP → unmount. No alternate screen, no mouse capture.
11. **Packaging.** Keep ONE pure-JS package (no `optionalDependencies`, no `postinstall`); copy the *process*: version
    baked by esbuild `--define`, `--version`, `smoke: node bin/jevcode.js --version` in CI, idempotent
    `npm view` before `npm publish --tag <channel>`, `latest`/`beta`/`dev` dist-tags, `jevcode upgrade` that detects
    `npm list -g`/`pnpm`/`bun`/`brew` and refuses unknown methods, and a `notify`-only autoupdate check *after* the
    first frame (never before; zero network at launch).
12. **Perf discipline to keep (already stronger in JevCode).** Event coalescing (opencode 16 ms; JevCode 50 ms),
    bounded in-memory history (opencode 100 messages/session), hidden heap-snapshot command for leak hunts, and —
    the lesson of #14965/#3935 — never block the first paint on terminal query round-trips.

---

## ADOPT

| What JevCode should do | Why | Source |
| --- | --- | --- |
| Single command registry feeding `/` autocomplete, `ctrl+p` palette and help | One table = consistent names, bindings shown next to commands, no drift | R:packages/tui/src/app.tsx, R:packages/tui/src/component/command-palette.tsx (2026-09-20) |
| Keybind grammar `"none"\|false\|"a,b"\|[...]\|{key,preventDefault}`, leader `ctrl+x`, `leader_timeout` 2000 | Proven, documented, avoids terminal conflicts; unknown keys warn instead of crash | R:packages/tui/src/config/keybind.ts, R:packages/web/src/content/docs/keybinds.mdx (2026-09-20) |
| Enter submits; `ctrl+j` + `shift/alt/ctrl+return` newline; readline subset | `ctrl+j` works in every terminal; kitty adds the rest; users expect Emacs keys | keybind.ts `input_submit`, `input_newline`; NM:ink/build/hooks/use-paste.d.ts, render.d.ts `kittyKeyboard` (2026-09-20) |
| History only from buffer start/end; 50-entry JSONL in the state dir | Disambiguates arrows in a multi-line editor; cheap persistence with no deps | R:packages/tui/src/component/prompt/index.tsx lines 862-924, R:packages/tui/src/prompt/history.tsx (2026-09-20) |
| Paste folding `[Pasted ~N lines]` at >= 3 lines or > 150 chars; CR-only normalisation | Keeps the composer within the height budget; Windows ConPTY quirk | prompt/index.tsx lines 1206-1211, 1403-1411 (2026-09-20) |
| Submit re-entrancy guard | Double Enter otherwise sends an empty prompt | prompt/index.tsx lines 931-946 (2026-09-20) |
| `!` shell mode at empty prompt, `Esc`/`Backspace` exits | Zero-cost affordance; output becomes a transcript item | prompt/index.tsx lines 826-858; tui.mdx "Bash commands" (2026-09-20) |
| `@` fuzzy file mention (limit 20, frecency), `Tab` complete | Direct reuse of the engine's candidate file list; matches user habit | R:packages/tui/src/component/prompt/autocomplete.tsx (2026-09-20) |
| Tool output collapsed to 3 (10 for run) lines; reasoning to one line | "the layout never shifts"; fits Ink Static discipline | session/index.tsx lines 1591-1605, 1803, 2053 (2026-09-20) |
| Three-option review row `once / always(this run) / reject`, `Esc` = reject, `ctrl+f` diff | Clear, keyboard-only, explains "always" scope before committing | R:packages/tui/src/routes/session/permission.tsx lines 400-430 (2026-09-20) |
| Footer `△ N` pending reviews + `/status` hint; sidebar tokens / `% used` / `$ spent` | Compact, glanceable; formula is simple | R:packages/tui/src/routes/session/footer.tsx, feature-plugins/sidebar/context.tsx (2026-09-20) |
| Session picker: `time.updated` desc, search, two-press delete, pins, quick slots | Fast resume without leaving the TUI | R:packages/tui/src/component/dialog-session-list.tsx (2026-09-20) |
| Theme picker live preview + restore on cancel; small theme set + `system` (ANSI 16) | Cheap to implement; `system` avoids truecolor assumptions | R:packages/tui/src/component/dialog-theme-list.tsx, themes.mdx (2026-09-20) |
| Shadow-git snapshots (`--git-dir` outside the repo, `write-tree`/`read-tree`/`checkout-index`) for `/undo` `/redo` | Undo of file changes without touching the user's `.git`; 2 MiB/ignored-file guards | R:packages/opencode/src/snapshot/index.ts, R:packages/opencode/src/session/revert.ts (2026-09-20) |
| Terminal title `JevCode \| <task>` cleared on exit; SIGHUP → unmount | Users run many agents; title cleanup avoids stale titles | R:packages/tui/src/app.tsx lines 459-476, util/renderer.ts (2026-09-20) |
| OSC 52 copy with tmux/screen passthrough | Only clipboard path that works over SSH with zero deps | R:packages/tui/src/clipboard.ts `writeOsc52` (2026-09-20) |
| `/editor` via `suspendTerminal` and `$VISUAL \|\| $EDITOR`, temp `.md`, `--wait` note | Long prompts; Ink 7.1.1 supports suspension natively | R:packages/tui/src/editor.ts; NM:ink/build/components/AppContext.d.ts (2026-09-20) |
| Epilogue printed after unmount (resume command) | Scrollback keeps the run id after the UI is gone | R:packages/tui/src/app.tsx line 363 (2026-09-20) |
| Idempotent channel-tagged publish, baked version, `--version` smoke test, `jevcode upgrade` with method detection | Mature release hygiene that fits a pure-JS package | R:packages/opencode/script/publish.ts, build.ts, installation/index.ts (2026-09-20) |
| Hidden heap-snapshot command; bounded in-memory history | The Memory Megathread shows why | issue #20695; R:packages/tui/src/context/sync.tsx line 341 (2026-09-20) |
| Never block first paint on terminal queries; run update checks after the first frame | #14965/#3935 class of bugs; JevCode's zero-network-at-launch gate | R:packages/tui/src/app.tsx lines 241-243; cli/cmd/tui.ts `checkUpgrade` (2026-09-20) |

## REJECT

| What not to do | Why |
| --- | --- |
| Alternate screen (`\x1b[?1049h`) as the default | Kills scrollback; opencode's own `--mini` mode had to invent "split-footer" + "capture-stdout" to give it back (O:renderer.ts lines 201-250; R:run/runtime.lifecycle.ts, 2026-09-20). JevCode's Static discipline already yields a scrollback-native transcript. |
| Mouse capture by default (`\x1b[?1000/1002/1003/1006h`) | Breaks native selection/scroll; opencode added `mouse: false`, `OPENCODE_DISABLE_MOUSE` and a copy-on-select opt-out to cope (tui.mdx, cli.mdx, 2026-09-20). Ink has no mouse parser anyway. |
| A native renderer / OpenTUI / SolidJS | Violates the ink+react-only constraint; needs Bun or Node 26 `--experimental-ffi` (O:packages/core/README.md, 2026-09-20). |
| Per-platform binaries via `optionalDependencies` + `postinstall` | ~144 MB per platform, pnpm/`--ignore-scripts` failure mode documented in the wrapper itself (publish.ts, registry JSON, 2026-09-20). JevCode has no native code. |
| curl-pipe-bash installer, Homebrew tap, AUR, Docker image | All presuppose static binaries; a Node CLI installs with `npm i -g`. |
| Installing plugin dependencies (`npm install`) during TUI startup | Direct cause of #7979 "Very Slow OpenCode Loading Time" (2026-09-20). |
| Waiting up to 1 s for `waitForThemeMode` / 5 s capability timeout before mounting | Incompatible with the < 300 ms first-frame gate; suspected in Ghostty-only slow starts (#14965, UNVERIFIED). |
| `targetFps: 60` and per-frame full redraws | Ink throttles to `maxFps` 30 by default and JevCode coalesces at 20 fps; the render-lag gate (< 5 ms p95) is the constraint that matters. |
| SQLite session store, drizzle migrations | Not available under the deps constraint (see open question on `node:sqlite`); JevCode's per-run JSON checkpoints already exist. |
| Hosted `/share`, auto-share, sync to a server | Out of scope and a secrets/redaction surface. |
| Self-modifying silent autoupdate | "only works if it was not installed using a package manager" (config.mdx); notify-only is enough for an npm CLI. |
| Which-key panel, 33 themes, 184 keybinds, 31 dialogs at once | Scope creep for a single-package harness; adopt the registry pattern, ship a dozen commands well. |
| Subprocess clipboard readers (`osascript`, `powershell`, `xclip`) | Spawns processes on paste; OSC 52 write + bracketed paste read covers the terminal case. |

## OPEN QUESTIONS

1. Does Ink 7.1.1's `kittyKeyboard: { mode: 'auto' }` push `\x1b[>1u` and correctly report `shift+return`
   (`\x1b[13;2u`) on Ghostty/kitty/WezTerm/iTerm2, and does the query round-trip (`\x1b[?u`) ever delay the first
   frame? Needs a pty test like `perf/first-frame.ts` with `TERM` variants (Ink source: NM:ink/build/ink.js
   `kittyQuery*` bytes, 2026-09-20).
2. `node:sqlite` in Node 22.23.2: stable without a flag or not? If stable it is a Node built-in and would satisfy
   the "only Node built-ins" rule for a session index; UNVERIFIED here (not checked against Node docs). JSON
   `run.json` scanning is the safe default.
3. Should "Approve for this pattern (this run)" exist at all? DESIGN.md fixes the 0.3-0.7 risk band as "pauses for
   human confirmation ... with no auto-approve"; opencode's `always` is per-pattern until restart
   (permission.tsx, 2026-09-20). A session-scoped allow-list for an *identical* command/path could be a policy
   change that needs a Jev-side decision, not just UI.
4. Snapshots vs the sandbox: opencode snapshots the *whole* worktree per message; JevCode already checkpoints step
   state. Snapshot per step (before each `edit/write/patch/run`) or per human turn? Cost on 5,000-file workspaces
   must fit the 50 ms harness overhead gate (`perf/step-overhead.ts`).
5. Multi-line composer inside a `rows − 2` dynamic budget: opencode allows up to `height / 3` rows. What is the
   composer cap when a review box and the decisions pane are also visible — shrink decisions first (current rule) or
   hide the live region?
6. Chat-style multi-turn on top of the engine: the current engine takes one task per run. Does a second prompt in
   the same session become a new `run` with `--resume`, or a "steering" directive injected into the plan
   (opencode's queued prompts model)?
7. `@` mention ranking: opencode delegates to a native frecency-aware file finder (`fff`). With Node built-ins only,
   is a simple subsequence scorer over the engine's candidate list (with `.gitignore` filtering already done)
   fast enough at 5,000 files within a keystroke (< 16 ms)?
8. Focus tracking (`\x1b[?1004h`) for "notify only when blurred" — worth the extra input parsing in Ink (which does
   not recognise focus events), or skip notifications entirely in v1?
9. Should `jevcode` with no arguments open the interactive home (opencode's `$0 [project]`) while `jevcode run
   "<task>"` keeps today's monitor behaviour, and does `--plain`/non-TTY need a line-mode composer (`readline`)?
10. Root cause of #14965 (Ghostty-only slow start) and #42264 (worker crash freezes streaming text) — worth
    tracking as they illustrate the two failure classes (blocking terminal queries; render depending on an
    async highlighter) that the JevCode design must avoid by construction.
