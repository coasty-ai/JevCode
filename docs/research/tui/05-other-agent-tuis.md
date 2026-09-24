# 05 — Other coding-agent terminal UIs: conventions and performance lessons

Research for the JevCode interactive TUI (chat composer, slash commands, sessions, steering,
review prompts, Jev-native decisions view, packaging). All fetches dated **2026-09-20**. Primary
sources are raw source files, official docs, npm registry JSON and the installed
`node_modules/ink` (7.1.1) / `react` (19.3.0) in this repo (`node -e` check, 2026-09-20; Node
`v22.23.2` per `node --version`, 2026-09-20). Items that could not be fetched are marked
**UNVERIFIED** with what was tried (§10).

Constraints this research respects (from the task and DESIGN.md §10/§12): Node 22, TS strict,
ESM, one npm package, runtime deps only `ink 7.1.1` + `react 19.3.0`, esbuild single bundle,
first frame < 300 ms with zero network, rendering never blocks the loop, zero terminal clears
after the first frame, keys never in logs.

---

## 0. Version snapshot and framework per tool

| Tool | Framework / language (evidence) | Package shape (evidence) |
| --- | --- | --- |
| Crush | Go 1.27.0; `bubbletea/v2 v2.0.9`, `lipgloss/v2 v2.0.6`, `bubbles/v2 v2.2.1`, `glamour/v2 v2.0.1`, `x/ansi v0.11.8`, `ultraviolet` (https://raw.githubusercontent.com/charmbracelet/crush/main/go.mod, 2026-09-20) | single Go binary; UI packages `internal/ui/{anim,attachments,chat,common,completions,dialog,diffview,exitbanner,image,list,logo,model,notification,styles,util,xchroma}` (https://github.com/charmbracelet/crush/tree/main/internal/ui, 2026-09-20) |
| aider | Python; `prompt_toolkit` (`PromptSession`, `KeyBindings`, `FileHistory`, `ThreadedCompleter`, `EditingMode`, `ModalCursorShapeConfig`) + Rich `Console`/`MarkdownStream` (https://raw.githubusercontent.com/Aider-AI/aider/main/aider/io.py, 2026-09-20) | pip/uv package; readline-style prompt, not a full-screen TUI |
| Pi (badlogic/pi-mono) | TypeScript; custom `pi-tui` "Terminal UI library with differential rendering" (https://raw.githubusercontent.com/badlogic/pi-mono/main/README.md, 2026-09-20) | npm `@mariozechner/pi-coding-agent` 0.73.1, 11.2 MB / 711 files, Node `>=20.6.0`, deprecated: "please use @earendil-works/pi-coding-agent instead going forward" (https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest, 2026-09-20) |
| Qwen Code | Ink 7 fork of Gemini CLI: PR "feat(cli): virtual viewport for long conversations on ink 7" (https://github.com/QwenLM/qwen-code/pull/4146, 2026-09-20) | npm `@qwen-code/qwen-code` 0.24.2, bin `cli-entry.js`, Node `>=22.0.0`, **124,177,702 B unpacked / 1,267 files**, optional deps `sharp`, `node-pty`, clipboard, audio capture (https://registry.npmjs.org/@qwen-code/qwen-code/latest, 2026-09-20) |
| Continue CLI (`cn`) | Ink: `ink ^6.1.0`, `react ^19.1.0`, `ink-testing-library ^4.0.0`; tsc + esbuild (https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/package.json, 2026-09-20) | npm `@continuedev/cli` 1.5.47, bin `dist/cn.js`, Node `>=18`, **64,823,055 B / 454 files** (https://registry.npmjs.org/@continuedev/cli/latest, 2026-09-20) |
| Amp CLI | Closed source; framework **UNVERIFIED** (binary distribution, no JS deps visible) | npm `@ampcode/cli` launcher **7,125 B / 6 files**, bin `amp.exe`, 5 optional platform packages `@ampcode/cli-{linux-x64,win32-x64,darwin-x64,linux-arm64,darwin-arm64}` (https://registry.npmjs.org/@ampcode/cli/latest, 2026-09-20); `@sourcegraph/amp` is "Renamed to @ampcode/cli" (https://registry.npmjs.org/@sourcegraph/amp/latest, 2026-09-20) |
| Goose CLI | Rust; `rustyline 18` (custom-bindings, with-file-history), `cliclack 0.5`, `console 0.16`, `indicatif 0.18`, `bat 0.26`, `comfy-table 8`; **no ratatui/crossterm** (https://raw.githubusercontent.com/block/goose/main/crates/goose-cli/Cargo.toml, 2026-09-20) | single binary; line-editor UI (not full-screen) |
| Cline CLI | OpenTUI + React: `@opentui/core 0.4.3`, `@opentui/react 0.4.3`, `react 19.2.4`, `react-reconciler 0.33.0`, `commander 14.0.3`, `@clack/prompts 1.2.0`; built with Bun (`"build": "bun run bun.mts"`), Node ≥22 (https://raw.githubusercontent.com/cline/cline/main/apps/cli/package.json, 2026-09-20); "Streaming TUI built on OpenTUI with markdown rendering, syntax-highlighted diffs, scrollable chat, and mouse support." (https://raw.githubusercontent.com/cline/cline/main/apps/cli/README.md, 2026-09-20) | npm `@cline/cli` 3.0.62 |
| Kilo CLI | "a fork of [OpenCode](https://opencode.ai) and supports the same configuration options" (https://kilo.ai/docs/code-with-ai/platforms/cli, 2026-09-20); opencode itself is `@opentui/core` + `@opentui/solid` + `solid-js`, Bun, no ink/react (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json, 2026-09-20) | npm `@kilocode/cli` 7.7.5 launcher 26,484 B + 12 platform packages + `postinstall: node ./postinstall.mjs` (https://registry.npmjs.org/@kilocode/cli/latest, 2026-09-20); `opencode-ai` 1.18.31 launcher 7,865 B + 12 platform packages + postinstall (https://registry.npmjs.org/opencode-ai/latest, 2026-09-20) |
| Mistral Vibe | Python ≥3.12; `textual==8.2.8`, `rich==15.0.0`, 93 deps; entry points `vibe`, `vibe-acp`, `vibe-app-server` (https://raw.githubusercontent.com/mistralai/mistral-vibe/main/pyproject.toml, 2026-09-20) | `curl -LsSf https://mistral.ai/vibe/install.sh | bash`, `uv tool install mistral-vibe`, `pip install mistral-vibe` (https://raw.githubusercontent.com/mistralai/mistral-vibe/main/README.md, 2026-09-20) |

Packaging lesson: every tool that ships a full-screen TUI in JS (opencode, Kilo, Amp, Cline)
ships **native binaries via optionalDependencies + a tiny launcher + postinstall**; the two
Ink-based tools ship 65–124 MB of JS. JevCode's single esbuild bundle with two runtime deps is
already the leanest shape in this set; the thing to copy is the *size discipline*, not the
binary-launcher pattern (§7 ADOPT/REJECT).

---

## 1. Charmbracelet Crush

- **Framework**: Bubble Tea v2 (table above). Frame cache: "Bubble Tea calls View after every
  Update, so a flood of wheel events pays for a full redraw per event even when the scroll
  offset did not move (clamped at the top or bottom) or moved back to a position rendered a
  moment ago." Serving cached frames "keeps the event loop draining instead of blocking input
  behind redraw work."; `frameCacheTTL` bounds staleness (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/framecache.go, 2026-09-20).
- **Sidebar** (`sidebar.go`): session title, working directory, model info, modified files,
  "LSPs", "MCPs", skills; model info carries `ContextUsed: m.session.CompletionTokens +
  m.session.PromptTokens`, `Cost: m.session.Cost`, `ModelContext: model.CatwalkCfg.ContextWindow`,
  `EstimatedUsage`; reasoning shown as `"Thinking On"` / `"Thinking Off"` / `"Reasoning %s"`;
  compact mode skips the sidebar (`if m.session == nil || m.isCompact { return }`); scrollbar
  "Always visible when focused, otherwise auto-hide" (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/sidebar.go, 2026-09-20). Exact context-% format string lives in `common.ModelInfo()`, not located — **UNVERIFIED**.
- **LSP/MCP status**: LSP states `unstarted`/`stopped` → OfflineIcon, `starting...` → BusyIcon,
  Ready → OnlineIcon + per-severity diagnostic counts, `error`/`error: {message}` → ErrorIcon,
  `disabled` → DisabledIcon; overflow "…and {n} more" (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/lsp.go, 2026-09-20). MCP states starting/connected/error/"needs authentication"/disabled with `"{count} tools"`, `"{count} prompts"`, `"{count} resources"` (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/mcp.go, 2026-09-20).
- **Status bar** (`status.go`): help hints, mode badges (Plan, YOLO), info types
  error/warn/update/info/success, messages truncated with `"…"`; **no token/cost in the status
  bar** (they live in the sidebar) (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/status.go, 2026-09-20).
- **Keybindings** (`keys.go`, verbatim key → help): global `ctrl+c` "quit", `ctrl+g` "more",
  `ctrl+p` "commands", `ctrl+m`/`ctrl+l` "models", `ctrl+z` "suspend", `ctrl+s` "sessions",
  `tab` "change focus", `ctrl+y` "toggle yolo", `shift+tab` "mode"; editor `enter` "send",
  `ctrl+o` "open editor", `shift+enter`/`ctrl+j` "newline", `ctrl+f` "add image", `ctrl+v`
  "paste image from clipboard", `@` "mention file", `/` "commands"; chat `ctrl+n` "new
  session", `ctrl+d` "toggle details", `ctrl+t`/`ctrl+space` "toggle tasks", `pgdown`/`f`,
  `pgup`/`b`, `space` "expand/collapse" (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/keys.go, 2026-09-20). README: "`ctrl+l`" opens the model picker, "`ctrl+p`" the commands palette (https://raw.githubusercontent.com/charmbracelet/crush/main/README.md, 2026-09-20).
- **Permission dialog** (`dialog/permissions.go`): title `"Permission Required"`; buttons
  `"Allow"` (`a`/`A`/`ctrl+a`), `"Allow for Session"` (`s`/`S`/`ctrl+s`), `"Deny"` (`d`/`D`);
  `left`/`h`, `right`/`l`, `tab` move; `enter` or `ctrl+y` confirm; Escape denies; per-tool
  body: diff preview for Edit/Write/MultiEdit, syntax-highlighted command for Bash, URL for
  Fetch, JSON params by default; diff view `t` toggles split/unified, `f` fullscreen,
  `shift+arrows`/`H`/`J`/`K`/`L` scroll (https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/dialog/permissions.go, 2026-09-20). Config: `permissions.allowed_tools` "List of tools that don't require permission prompts"; CLI `permissions allow view ls grep edit mcp_context7_get-library-doc`, `permissions deny bash sourcegraph`; `--yolo` with "Be very, very careful with this feature." (README above; schema https://raw.githubusercontent.com/charmbracelet/crush/main/schema.json, 2026-09-20).
- **Config surface** (`schema.json`): `options.tui.{compact_mode, diff_mode (unified|split),
  completions, transparent, scrollbar, mouse, exit_banner}`, `options.notifications`,
  `options.progress` "Show indeterminate progress updates", `options.attribution`,
  `options.disable_auto_summarize`, `options.auto_lsp` (schema URL above). Attribution modes
  `assisted-by` (default, "Adds `Assisted-by: Crush:[ModelID]`"), `co-authored-by`, `none`,
  plus `generated_with` (https://github.com/charmbracelet/crush, 2026-09-20).
- **Sessions**: "maintain multiple work sessions and contexts per project"; session list shows
  `IsBusy` ("set while an agent turn is in flight") and `AttachedClients` (https://github.com/charmbracelet/crush, 2026-09-20).
- **Telemetry**: pseudonymous metrics, opt out `CRUSH_DISABLE_METRICS=1` or `DO_NOT_TRACK=1` (same page).
- **Performance statements**: none quantitative; only the frame-cache rationale above.

## 2. aider

- **Framework**: prompt_toolkit line editor + Rich streaming markdown (`get_assistant_mdstream()`,
  `MarkdownStream`); dumb terminals fall back to plain `input()`; Console degraded to
  `force_terminal=False, no_color=True` on init failure (https://raw.githubusercontent.com/Aider-AI/aider/main/aider/io.py, 2026-09-20).
- **Slash commands** (verbatim names): `/add /architect /ask /chat-mode /clear /code /commit
  /context /copy /copy-context /diff /drop /edit /editor /editor-model /exit /git /help /lint
  /load /ls /map /map-refresh /model /models /multiline-mode /ok /paste /quit /read-only
  /reasoning-effort /report /reset /run /save /settings /test /think-tokens /tokens /undo /voice
  /weak-model /web`; e.g. `/diff` "Display the diff of changes since the last message", `/undo`
  "Undo the last git commit if done by aider", `/tokens` "Report on tokens used by current chat
  context", `/multiline-mode` "Toggle multiline mode (swaps behavior of Enter and Meta+Enter)" (https://aider.chat/docs/usage/commands.html, 2026-09-20).
- **Keybindings**: `KeyBindings` in `io.py`: Ctrl+Z suspend (when SIGTSTP exists), Ctrl+Space
  inserts a space, Ctrl+Up/Ctrl+Down history, Ctrl+X Ctrl+E external editor, Enter = newline in
  multiline mode else submit, Alt+Enter the inverse (io.py above). Docs add Emacs `Ctrl-L` clear
  screen, `Ctrl-R` reverse search, `Ctrl-Up/Down` "Scroll back through messages", and a full vi
  mode (`--vim`) (https://aider.chat/docs/usage/commands.html, 2026-09-20).
- **Autocomplete**: `AutoCompleter(Completer)` completes slash commands, file paths from
  `addable_rel_fnames`, and words tokenised from file contents (min 3 chars), wrapped in
  `ThreadedCompleter` (io.py above).
- **Prompt**: prefix `"> "`, `"multi> "`, or `"<edit_format> "` + `"> "`; continuation lines
  reuse the prefix; a `placeholder` survives an interruption until the next input (io.py above).
- **Confirm prompt** (`confirm_ask`): signature `(question, default="y", subject=None,
  explicit_yes_required=False, group=None, allow_never=False)`; `valid_responses = ["yes", "no",
  "skip", "all"]` (+ `"don't"` when `allow_never`); suffix e.g.
  `" (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]: "`; `--yes-always` short-circuits
  (`res = "n" if explicit_yes_required else "y"`); a `group.preference` answers the whole group (io.py above; https://aider.chat/docs/config/options.html, 2026-09-20).
- **Cost/tokens**: `tokens_report = f"Tokens: {format_tokens(self.message_tokens_sent)} sent"`
  + `", {n} cache write"` + `", {n} cache hit"` + `", {n} received."`; `cost_report = f"Cost:
  ${format_cost(self.message_cost)} message, ${format_cost(self.total_cost)} session."`;
  printed with `self.io.tool_output(self.usage_report)` (https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py, 2026-09-20). `format_tokens`: `<1000` raw,
  `<10000` → `f"{count / 1000:.1f}k"`, else `f"{round(count / 1000)}k"` (https://raw.githubusercontent.com/Aider-AI/aider/main/aider/utils.py, 2026-09-20).
- **Watch mode**: `--watch-files`; one-line comments starting/ending with `AI` are collected;
  `AI!` "make changes to your code", `AI?` "answer your question"; markers removed afterwards (https://aider.chat/docs/usage/watch.html, 2026-09-20).
- **Modes**: code / ask / architect / help; per-message `/code`, `/ask`, `/architect`, `/help`;
  persistent `/chat-mode <mode>` or `--chat-mode <mode>`; `--architect`; architect "will propose
  changes and an editor model will translate that proposal into specific file edits" with
  `--editor-model` and `editor-diff`/`editor-whole` formats (https://aider.chat/docs/usage/modes.html, 2026-09-20).
- **/voice**: records until "press `ENTER` when done", transcribes into the prompt; needs
  PortAudio (https://aider.chat/docs/usage/voice.html, 2026-09-20); `--voice-format` (wav; webm/mp3 need ffmpeg), `--voice-language`, `--voice-input-device` (options page above).
- **Git/undo**: "Whenever aider edits a file, it commits those changes with a descriptive commit
  message."; `/undo` "will undo and discard the last change"; `--no-auto-commits`,
  `--no-dirty-commits`; attribution `--attribute-author` ("(aider)" in author),
  `--attribute-co-authored-by` trailer (https://aider.chat/docs/git.html, 2026-09-20).
- **Notifications**: `--notifications` bell when the LLM is done; `--notifications-command`;
  default command `terminal-notifier`/`osascript` on macOS, `notify-send` on Linux, PowerShell on
  Windows (options page + io.py above).
- **Output flags**: `--dark-mode`, `--light-mode`, `--pretty` (default True), `--stream`
  (default True), `--code-theme`, `--show-diffs`, `--fancy-input` (default True),
  `--multiline`, `--chat-history-file` (`.aider.chat.history.md`), `--restore-chat-history`,
  `--llm-history-file`, `--check-update` (options page above).
- **Performance statements**: none published.

## 3. Pi coding agent (Mario Zechner)

- **Why not Ink**: he rejected Ink because he did not want to "write your TUI like a React app",
  Blessed as "mostly unmaintained", OpenTUI as "explicitly not production ready", and built his
  own as "a fun little challenge" (https://mariozechner.at/posts/2025-11-30-pi-coding-agent/, 2026-09-20).
- **Scrollback philosophy**: full-screen TUIs (he names Amp and opencode) "lose the scrollback
  buffer" and must reimplement search/scroll; "Mouse scrolling specifically always feels kind of
  off in such TUIs." Pi keeps the primary screen: "You get to use all the built-in functionality
  like natural scrolling and search within the scrollback buffer." (same post).
- **Differential rendering** (`tui-main-screen.ts`): first render "just output everything
  without clearing (assumes clean screen)"; "Width changes always need a full re-render because
  wrapping changes."; height changes normally full re-render except Termux where "a full redraw
  causes the entire history to replay"; "Differential rendering can only touch what was actually
  visible. If the first changed line is above the previous viewport, we need a full redraw.";
  otherwise cursor to first changed line and rewrite to the end; sequences `"\x1b[?2026h"` /
  `"\x1b[?2026l"` (begin/end synchronized output), full clear `"\x1b[2J\x1b[H\x1b[3J"`, `"\x1b[2K"`,
  `"\x1b[${n}A"`/`"\x1b[${n}B"`, `"\x1b[${col}G"`; tracks `previousViewportTop`, `maxLinesRendered` (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/tui-main-screen.ts, 2026-09-20). Blog: "In any capable terminal like Ghostty or iTerm2, this works brilliantly and you never see any flicker. In less fortunate terminal implementations like VS Code's built-in terminal, you will get some flicker."; memory cost "a few hundred kilobytes for very large sessions" (blog above).
- **Render scheduling** (`tui.ts`): `private static readonly MIN_RENDER_INTERVAL_MS = 16;`;
  `requestRender()` queues via `process.nextTick()` under that spacing; input uses
  `requestImmediateRender()`; cursor placement via `CURSOR_MARKER = "\x1b_pi:c\x07"` extracted by
  `extractCursorPosition`; components "should cache their rendered output and only re-render when
  necessary" via `invalidate()` (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/tui.ts and .../packages/tui/README.md, 2026-09-20).
- **Input**: Kitty keyboard protocol via `matchesKey()`; bracketed paste "with markers for >10
  line pastes" (tui README above). Per-terminal Shift+Enter notes: Kitty/iTerm2 "Works out of
  the box"; Ghostty mapping "sends a raw linefeed byte. Inside pi, that is indistinguishable from
  `Ctrl+J`"; VS Code 1.109.5+ enables kitty protocol by default; CSI-u forms `\x1b[13;2u`
  (Shift+Enter), `\x1b[13;3u` (Option+Enter) (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/terminal-setup.md, 2026-09-20).
- **Keybindings** (`~/.pi/agent/keybindings.json`, action ids): `tui.input.submit` enter;
  `tui.input.newLine` shift+enter, ctrl+j; `app.interrupt` escape; `app.clear` ctrl+c;
  `app.exit` ctrl+d; `app.suspend` ctrl+z; `app.editor.external` ctrl+g; `app.model.select`
  ctrl+l; `app.model.cycleForward` ctrl+p; `app.thinking.cycle` shift+tab; `app.thinking.toggle`
  ctrl+t; `app.tools.expand` ctrl+o; `app.message.copy` ctrl+x; `app.message.followUp` alt+enter;
  `app.message.dequeue` alt+up; `app.clipboard.pasteImage` ctrl+v; editor emacs set
  (`ctrl+a/e/b/f/k/u/w/y`, `alt+b/f/d`), `tui.editor.undo` ctrl+- (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/keybindings.md, 2026-09-20). README: Ctrl+C clears, twice quits; Escape twice opens `/tree` (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md, 2026-09-20).
- **Steering vs follow-up**: "**Enter** queues a steering message, delivered after the current
  assistant turn finishes executing its tool calls."; "**Alt+Enter** queues a follow-up message,
  delivered after the agent finishes all work."; "**Escape** aborts and restores queued messages
  to the editor."; `!command` runs and sends output to the model, `!!command` runs without
  sending it (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/usage.md, 2026-09-20).
- **Slash commands**: `/login /logout /model /thinking /scoped-models /settings /resume /new
  /name /session /tree /trust /fork /clone /compact /copy /export /import /share /bug /reload
  /hotkeys /changelog /llama /quit`; sessions `--continue`/`-c`, `--resume`/`-r` picker,
  `--session <path|id>`, `--fork`, `--no-session`; output modes `--print`/`-p`, `--mode json`
  (JSONL), `--mode rpc` (README above).
- **Footer**: "working directory, session name, total token/cache usage (`↑` input, `↓` output,
  `R` cache read, `W` cache write, `CH` cache hit rate), cost, context usage, current model" (README above).
- **Approval UX**: none — tools execute directly; control only via `--tools`, `--exclude-tools`,
  `--no-builtin-tools` (README above).
- **Performance statements**: qualitative only (flicker-free on Ghostty/iTerm2; VS Code
  flickers; 16 ms min render interval).

## 4. Qwen Code (Ink 7 fork of Gemini CLI)

- **Issue #1778 "Ink Rendering And Flicker in Qwen Code: An Introduction"**: "Flicker happens
  when those writes are large, frequent, or visible as intermediate states"; "If dynamic output
  height is **greater than or equal to** terminal height, Ink falls back to a fullscreen path
  that clears the entire terminal and redraws everything" — "the biggest flicker trigger",
  worst on Windows Terminal, remote VMs, tmux, short terminals; seven mitigations: keep dynamic
  output below terminal height, move long histories to `<Static>`, segment streaming output into
  static segments, "Batch streaming updates (50-100ms intervals)", avoid unnecessary rerenders,
  evaluate incremental line rendering, "Design assuming synchronized output support is
  unavailable" (https://github.com/QwenLM/qwen-code/issues/1778, 2026-09-20).
- **Issue #1491**: "When processing with prompt, pressing Ctrl-E/Ctrl-F makes the interface
  flicker" (CLI 0.6.2, Linux, Node 24.12.0); closed by PR #4146 (https://github.com/QwenLM/qwen-code/issues/1491, 2026-09-20).
- **PR #3905 "fix(cli): unfreeze Ctrl+O compact-mode toggle on long conversations"**: the toggle
  called `refreshStatic()`, which cleared the terminal and remounted every `<Static>` item
  synchronously, blocking input for seconds; fix: `compactToggleHasVisualEffect()` skips the
  remount when nothing visible changes, and `<Static>` is fed a growing slice — below 100 items
  in one render, above that 50-item chunks via `setImmediate`; alternatives listed verbatim
  "sealed prefix + live tail", "true viewport virtualization", "ANSI-output caching", each
  "changes UX or requires an architectural rewrite" (https://github.com/QwenLM/qwen-code/pull/3905, 2026-09-20).
- **PR #4146 "feat(cli): virtual viewport for long conversations on ink 7"**: "On a 1000-turn
  conversation that's 1000 `HistoryItemDisplay` renders + ink layout passes whenever Ctrl+O /
  model change / Alt+M / resize forces a remount."; adds `VirtualizedList.tsx` (~760 LoC),
  `StaticRender.tsx` (`React.memo` for completed items), SGR/X11 mouse parser, auto-hide
  scrollbar; O(log n) offset lookup (https://github.com/QwenLM/qwen-code/pull/4146, 2026-09-20).
  Design doc: ports gemini-cli's virtualized list to Ink 7 (`useBoxMetrics` replaces
  `ResizeObserver`), runs in the **alternate screen**, ~2,800 LoC, trades "Host scrollback loss";
  `ui.useTerminalBuffer` (default `true`) gates it, legacy `<Static>` path kept for screen
  readers / piped output (https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/design/virtual-viewport/README.md, 2026-09-20).
- **Issue #8659** (after #4146): "the TUI output flickers/tears continuously" in Alibaba Cloud
  Workbench (`TERM=xterm`, empty `COLORTERM`), attributed to the virtualized mode's
  "full-screen ANSI redraws that web terminals cannot handle smoothly"; workaround
  `{"ui": {"useTerminalBuffer": false, "mouseTracking": false, "renderMode": "raw"}}` (https://github.com/QwenLM/qwen-code/issues/8659, 2026-09-20).
- **Settings**: `ui.useTerminalBuffer` (bool, default `true`) "Render conversation history in an
  in-app scrollable viewport instead of the terminal scrollback buffer."; `ui.mouseTracking`
  (default `true`); `ui.showScrollbar`; `ui.renderMode` `"render"|"raw"`; `ui.theme` default
  `"Qwen Dark"`; `ui.hideBanner`, `ui.hideTips`, `ui.showLineNumbers` (https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md, 2026-09-20).
- **Keybindings** (docs, verbatim): Esc "Close dialogs and suggestions. With an empty prompt,
  cancel an ongoing request"; Ctrl+C "Cancel the ongoing request and clear the input"; Ctrl+D
  "Exit the application if the input is empty"; Ctrl+L "Clear the screen"; Ctrl+S stash input;
  Enter submit "or steer current turn"; Ctrl+Enter/Cmd+Enter/Shift+Enter "Insert a newline";
  Ctrl+Q queue for next turn; Ctrl+Y "Retry the last failed request"; `!` shell mode, `?`
  shortcuts overlay, `/` slash completion, `@` file completion; Ctrl+R "Reverse search through
  input/shell history"; Ctrl+O/Alt+T expand/collapse thinking; Alt+M rich/raw markdown; Ctrl+T
  tool descriptions; emacs editing Ctrl+A/E/U/K/W (https://qwenlm.github.io/qwen-code-docs/en/users/reference/keyboard-shortcuts/, 2026-09-20).
- **Performance statements**: qualitative (multi-second Ctrl+O freezes on >200-turn histories,
  "scroll storms"); no ms figures published.

## 5. Continue CLI (`cn`)

- **Framework**: Ink 6 + React 19 (table). UI files: `TUIChat.tsx`, `UserInput.tsx`,
  `TextBuffer.ts`, `SlashCommandUI.tsx`, `SessionSelector.tsx`, `ModelSelector.tsx`,
  `DiffViewer.tsx`, `ColoredDiff.tsx`, `ToolResultSummary.tsx`, `Timer.tsx`,
  `LoadingAnimation.tsx`, `MarkdownRenderer.tsx`, `SyntaxHighlighter.ts` (https://github.com/continuedev/continue/tree/main/extensions/cli/src/ui, 2026-09-20).
- **Modes**: TUI by default; `-p` headless "for: Scripts and automation, CI/CD pipelines, Docker
  containers"; `FORCE_NO_TTY`; "automatically detects TTY-less environments and adjusts its
  behavior"; `cn --resume` (https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/README.md, 2026-09-20); `cn -p "your prompt"` "runs to completion and prints its response to stdout" (https://docs.continue.dev/cli/quickstart, 2026-09-20).
- **Slash commands**: `/help /clear /login /logout /update /whoami /info` ("session data
  (tokens, costs)") `/model /config /mcp /init /compact /resume /fork /title|/rename /exit /jobs
  /diff /apply` (https://docs.continue.dev/cli/tui-mode, 2026-09-20).
- **Approval UX**: options "Continue", "Continue + don't ask again" (persists to
  `~/.continue/permissions.yaml`), "No" (same page). Policies `allow` / `ask` / `exclude`; flags
  `--allow`, `--ask`, `--exclude`, `--auto` (all tools), `--readonly` (plan mode); precedence
  mode flags → CLI flags → `permissions.yaml` → defaults; read-only tools (Read, List, Search,
  Fetch, Diff, AskQuestion, …) default `allow`, Edit/MultiEdit/Write/Bash "default to `ask`" (https://docs.continue.dev/cli/tool-permissions, 2026-09-20). Mode cycling `normal → plan → auto` is unit-tested (`toolPermissionService.switchMode()`) (https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/src/ui/UserInput.keyboard.test.ts, 2026-09-20); the key that cycles it is **UNVERIFIED** in docs.
- **Keybindings**: docs list only ↑/↓ and Enter for prompts (tui-mode page above) — thin;
  **UNVERIFIED** beyond that.
- **Cost/tokens**: `/info` only (above). **Performance statements**: none.

## 6. Amp CLI

- **Keybindings** (verbatim table): Ctrl+O command palette; Ctrl+G open prompt in editor; Ctrl+V
  paste image; Ctrl+S "Toggle Dial/show thread mode"; Ctrl+R prompt history; ↑/↓ queued/previous
  messages; Alt+T expand thinking/tool blocks; Alt+D toggle reasoning effort; Alt+R toggle fast
  mode; chords `Ctrl+C Ctrl+N` archive + new thread, `Ctrl+C Ctrl+E` archive + quit, `Ctrl+C
  Ctrl+C` quit; `Esc Esc` interrupt turn; `@` mention; Enter submit; Shift+Enter newline
  "(supported terminals)", Ctrl+J newline "(any terminal)", `\` + Return newline; customizable via
  `amp.keymap` in `~/.config/amp/settings.json`, "define chords using spaces between keys", `null`
  unbinds (https://ampcode.com/docs/cli/keybindings, 2026-09-20).
- **Sessions/threads**: `amp`, `echo "commit all my changes" | amp`, `--executor
  local|orb|runner:<id>`; "Amp automatically checks and installs new versions in the background"
  (https://ampcode.com/docs/cli, 2026-09-20); `-x`/`--execute` "sends the message provided to
  `-x` to the agent, waits until the agent ends its turn, prints its final message, and exit[s]",
  auto-activates when stdout is redirected (https://ampcode.com/docs/cli/execute-mode, 2026-09-20);
  `--stream-json` (one JSON object per line; `type: "system"/"user"/"assistant"/"result"`),
  `--stream-json-input`, `--stream-json-thinking` (https://ampcode.com/docs/cli/streaming-json, 2026-09-20).
- **Modes ("the Dial")**: `low` "You know exactly what you want.", `medium` "This should be your
  default.", `high`, `ultra`; "Turn the dial with `Ctrl+S`"; `smart`/`deep`/`rush`/`large`
  deprecated (https://ampcode.com/news/the-dial, 2026-09-20). Rush was "67% cheaper and 50% faster than `smart`" token-by-token (https://ampcode.com/news/rush-mode, 2026-09-20).
- **Permissions**: ordered rules `"amp.permissions": [{ "tool": "Bash", "matches": { "cmd":
  "*git commit*" }, "action": "ask"}, …, { "tool": "*", "action": "delegate", "to":
  "my-permission-helper"}]`, actions allow / reject / ask / delegate (https://ampcode.com/news/tool-level-permissions, 2026-09-20); philosophy: "restrictions aren't necessary for tools like this with an easy undo action" (https://ampcode.com/notes/permissions, 2026-09-20). The ask prompt's on-screen labels are **UNVERIFIED** (not documented).
- **Cost display**: `amp.showCosts` default `true`; `amp.terminal.detailsExpandedByDefault`
  default `false`; `amp.notifications.enabled` default `true` ("when the agent completes a task
  or is blocked waiting for user input"); `amp.terminal.copyOnSelect`; `amp.updates.mode`
  `auto|warn|disabled`; `amp.thread.autoArchiveOnQuit` (https://ampcode.com/docs/cli/settings, 2026-09-20).
- **Performance statements**: none for the TUI.

## 7. Goose CLI

- **Framework**: rustyline + cliclack (table). Slash commands (`input.rs`): `/exit /quit /? /help
  /t [name] /prompts /prompt /extension /builtin /mode /model /clear /new /compact /summarize
  (deprecated) /edit /skills /r` ("toggle full tool output"); help text: "Enter - Send message /
  Ctrl+{newline_key} - Add a newline (configurable via GOOSE_CLI_NEWLINE_KEY) / Ctrl+C - Clear
  current line if text is entered, otherwise exit the session."; Ctrl+M also submits (https://raw.githubusercontent.com/block/goose/main/crates/goose-cli/src/session/input.rs, 2026-09-20).
- **Docs**: `/mode <name>` ('auto', 'approve', 'chat', 'smart_approve'); `/compact` "Compact and
  summarize the current conversation to reduce context length"; `/t` cycles light → dark →
  ansi; `/ + <Tab>` completes; shortcuts Ctrl+C, Ctrl+J, Cmd+Up/Down history, Ctrl+R reverse
  search; `goose session --resume`, `--fork` (requires `--resume`), `--name`, `--session-id`,
  `goose session list --format json` (https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/goose-cli-commands.md, 2026-09-20).
- **Approval prompt** (`session/mod.rs`): `"Goose would like to call the above tool, do you
  allow?"` with `"Allow"` → `Permission::AllowOnce`, `"Always Allow"` → `AlwaysAllow`, `"Deny"`
  → `DenyOnce`, `"Cancel"`; rendered by `cliclack::select`; `ErrorKind::Interrupted` (Ctrl+C) →
  `Permission::Cancel` (https://raw.githubusercontent.com/block/goose/main/crates/goose-cli/src/session/mod.rs, 2026-09-20). `GOOSE_MODE` default `"auto"` (env doc below).
- **Env/config**: `GOOSE_CLI_THEME` light|dark|ansi (default ansi), `GOOSE_CLI_NEWLINE_KEY`
  default `"j"`, `GOOSE_CLI_BELL` (bell "when an interactive turn finishes or tool approval is
  required", default false), `GOOSE_CLI_SHOW_COST` (default false), `GOOSE_CLI_SHOW_THINKING`,
  `GOOSE_CLI_MIN_PRIORITY` (tool output verbosity 0.0–1.0), `GOOSE_CLI_MAX_CODE_BLOCK_LINES` 50,
  `GOOSE_CLI_TRUNCATED_SHOW_LINES` 20, `GOOSE_CONTEXT_LIMIT` (https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/environment-variables.md, 2026-09-20).
- **Performance statements**: none.

## 8. Cline CLI

- **Framework**: OpenTUI + React, Bun-built (table). TUI docs (verbatim): `Tab` "toggle
  Plan/Act"; `Shift+Tab` "toggle auto-approve all"; `Ctrl+C` "abort a running turn; press again
  to exit"; `Ctrl+D` "exit when the prompt is empty and idle"; `Ctrl+L` "clear the chat view or
  current conversation"; slash `/settings /model /account /mcp /compact /undo /clear /history
  /help /quit`; `@file` mentions; status bar: active model, context usage, cost, workspace/branch,
  git diff stats, Plan/Act state, auto-approve status (https://raw.githubusercontent.com/cline/cline/main/docs/usage/tui.mdx, 2026-09-20).
- **Flags**: `-i, --tui`; `-y, --yolo` "Skip tool approval prompts, enable submit_and_exit, and
  disable spawn/team tools by default"; `--json` "Output NDJSON instead of styled text"; `--zen`
  dispatch to background hub; `--acp`; `-p, --plan`; `--thinking [none|low|medium|high|xhigh]`;
  `--retries <count>` default 3 (apps/cli/README.md above). `--auto-approve` defaults `true`
  (false in ACP); NDJSON fields `type, text, ts, say/ask, reasoning, partial`; `cline --id
  <session-id>` resumes; `cline history` (https://docs.cline.bot/cline-cli/cli-reference, 2026-09-20). "Headless is triggered when using flags like `--json`, when stdin is piped, or when output is redirected." (https://docs.cline.bot/cline-cli/overview, 2026-09-20).
- **Approval prompt labels**: **UNVERIFIED** (not in docs fetched).
- **Performance statements**: none.

## 9. Kilo CLI (and its upstream opencode)

- **Kilo**: fork statement (table); `~/.config/kilo/tui.jsonc` global, `.kilo/tui.json` project;
  sidebar footer shows account balance, team name, Kilo Pass usage; privacy mode renders balance
  as `•••` and collapses team name to "Team credits"; permissions `"allow"` / `"ask"` / `"deny"`
  with wildcard rules; `kilo --continue` / `-c`; "Kilo also handles links inside the TUI, so mouse
  capture does not make supported HTTP(S) links inactive."; suspend `ctrl+z` (disabled on
  Windows) (https://kilo.ai/docs/code-with-ai/platforms/cli and https://kilo.ai/docs/cli, 2026-09-20). Slash `/sessions /new /models /agents /review /exit /connect /status /themes /privacy` (https://kilo.ai/docs/cli, 2026-09-20). Kilo's `/docs/cli/keybinds` and `/docs/cli/configuration` returned 404 — keybinds are inherited from opencode (below).
- **opencode keybinds** (`tui.json`, verbatim): `leader` = `ctrl+x`, timeout 2000 ms; `app_exit`
  `ctrl+c,ctrl+d,<leader>q`; `session_new` `<leader>n`; `session_list` `<leader>l`;
  `session_interrupt` `escape`; `session_compact` `<leader>c`; `input_submit` `return`;
  `input_newline` `shift+return,ctrl+return,alt+return,ctrl+j`; `input_clear` `ctrl+c`;
  `messages_page_up` `pageup,ctrl+alt+b`; `agent_cycle` `tab`, reverse `shift+tab`; `model_list`
  `<leader>m`; `theme_list` `<leader>t`; `sidebar_toggle` `<leader>b`; `status_view`
  `<leader>s`; `help` `<leader>h`; `messages_copy` `<leader>y`; `messages_undo` `<leader>u`;
  `messages_redo` `<leader>r`; disable with `"none"` or `false` (https://opencode.ai/docs/keybinds/, 2026-09-20).
- **opencode TUI**: slash `/connect /compact (/summarize) /details /editor /exit (/quit /q)
  /export /help /init /models /new (/clear) /redo /sessions (/resume /continue) /share /themes
  /thinking /undo /unshare`; undo/redo "needs to be a Git repository"; mouse capture default
  `"mouse": true` (https://opencode.ai/docs/tui/, 2026-09-20).
- **Performance statements**: none.

## 10. Mistral Vibe

- **Framework**: Textual 8.2.8 (table). README: "Autocompletion for slash commands (`/`) and file
  paths (`@`)", "Persistent command history", multiline `Ctrl+J` or `Shift+Enter`; keys `Ctrl+O`
  toggle tool output, `Ctrl+T` todo list, `Ctrl+\` debug console, `Shift+Tab` cycle agents,
  `Ctrl+Y`/`Ctrl+Shift+C` copy, `Ctrl+G` external editor, `Ctrl+R` voice recording; exit
  "Ctrl+C / Ctrl+D twice within ~1 second" with `ask_confirmation_on_exit`; queue: "Empty Enter
  or Ctrl+Enter steers the queued prompts into the active turn", "Escape interrupts the active
  turn and pauses remaining prompts", "Enter resumes a paused queue"; context shown in a
  "bottom-right gauge" (https://raw.githubusercontent.com/mistralai/mistral-vibe/main/README.md, 2026-09-20).
- **Approval**: agent profiles `ask` "Requires approval for tool executions", `plan`
  "Auto-approves safe tools like `grep` and `read`", `accept-edits` "Auto-approves file edits
  only", `auto-approve`; cycle with Shift+Tab (same README). Prompt labels **UNVERIFIED**.
- **Sessions/budgets**: `--continue`/`-c`, `--resume` picker, `--resume SESSION_ID` (partial
  match); programmatic `-p`, `--output text|json|streaming`, `--max-price DOLLARS`,
  `--max-tokens N`, `--max-turns N` (same README). Slash `/help /retry /mcp /connectors /voice
  /theme /config` (same README).
- **Performance statements**: none ("Built with modern libraries for a smooth and efficient
  workflow" only).

---

## 11. Comparison table

| Tool | Framework | Scrollback kept? | Submit / newline | Interrupt | Quit | External editor | Tool-detail toggle | Mode/agent cycle | Sessions | Cost/tokens/context | Approval UX | Keymap file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Crush | Bubble Tea v2 | no (full-screen) | enter / shift+enter, ctrl+j | — | ctrl+c | ctrl+o | ctrl+d details | shift+tab | ctrl+s list, ctrl+n new | sidebar: tokens, cost, context window | dialog Allow / Allow for Session / Deny (a/s/d) | no (`tui` options only) |
| aider | prompt_toolkit | yes | Enter / Alt+Enter (swappable) | Ctrl+C | /exit, /quit | Ctrl+X Ctrl+E | — | /chat-mode | history file | "Tokens: … Cost: $… message, $… session." | text prompt (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again | no |
| Pi | custom pi-tui | yes (differential) | enter / shift+enter, ctrl+j | escape | ctrl+d, ctrl+c ×2 | ctrl+g | ctrl+o tools, ctrl+t thinking | shift+tab thinking | -c, -r picker, /resume /fork | footer ↑↓ R W CH, cost, context %, model | none (no prompts) | `~/.pi/agent/keybindings.json` |
| Qwen Code | Ink 7 | no by default (`useTerminalBuffer: true`, alt screen) | Enter / Ctrl+Enter, Shift+Enter | Esc / Ctrl+C | Ctrl+D | — | Ctrl+O, Ctrl+T | — | — | — (docs) | Gemini-style dialog (not fetched) | no |
| Continue | Ink 6 | yes | Enter | — | /exit | — | — | normal→plan→auto | --resume, /resume /fork | /info | Continue / Continue + don't ask again / No | no |
| Amp | binary (unverified) | no (full-screen, per Pi blog) | Enter / Shift+Enter, Ctrl+J, `\`+Return | Esc Esc | Ctrl+C Ctrl+C | Ctrl+G | Alt+T | Ctrl+S dial | threads, -x | `amp.showCosts` | rules allow/reject/ask/delegate | `amp.keymap` |
| Goose | rustyline + cliclack | yes | Enter / Ctrl+J (configurable) | Ctrl+C | Ctrl+C on empty, /exit | /edit | /r | /mode | --resume, --fork | `GOOSE_CLI_SHOW_COST` | select Allow / Always Allow / Deny / Cancel | env vars |
| Cline | OpenTUI + React | full-screen (scrollable chat) | Enter | Ctrl+C | Ctrl+C ×2, Ctrl+D | — | — | Tab plan/act, Shift+Tab auto-approve | --id, /history | status bar model, context, cost, branch, diff stats | (labels unverified); -y skips | no |
| Kilo/opencode | OpenTUI + Solid | no (full-screen) | return / shift+return, ctrl+j | escape | ctrl+c, ctrl+d, `<leader>q` | /editor | /details | tab / shift+tab | -c, /sessions | Kilo footer balance | allow/ask/deny rules | `tui.json(c)` |
| Vibe | Textual | no (Textual app) | Enter / Ctrl+J, Shift+Enter | Escape | Ctrl+C/D ×2 | Ctrl+G | Ctrl+O | Shift+Tab | -c, --resume | gauge | profiles ask/plan/accept-edits/auto-approve | config |

(Sources: the per-tool sections above, all fetched 2026-09-20.)

## 12. De-facto standard: features in ≥ 3 tools

| Feature | Tools (≥3) | Evidence |
| --- | --- | --- |
| Enter submits; **Shift+Enter and/or Ctrl+J** inserts newline | Crush, Pi, Amp, opencode/Kilo, Goose, Vibe, Qwen | keys.go; keybindings.md; ampcode keybindings; opencode keybinds; input.rs; Vibe README; Qwen shortcuts (all 2026-09-20) |
| **Escape interrupts** the running turn | Pi, Amp (Esc Esc), opencode/Kilo, Vibe, Qwen | same sources |
| **Ctrl+C clears input / first press aborts; second press (or Ctrl+D) exits** | Pi, Cline, Vibe, Amp, Goose, Qwen | Pi README; tui.mdx; Vibe README; Amp keybindings; input.rs; Qwen shortcuts |
| **Ctrl+G** opens the prompt in `$EDITOR` (Crush uses Ctrl+O, aider Ctrl+X Ctrl+E) | Pi, Amp, Vibe | keybindings.md; Amp keybindings; Vibe README |
| **Ctrl+O** toggles tool-output detail (Crush Ctrl+D, opencode `/details`, Goose `/r`) | Pi, Vibe, Qwen | keybindings.md; Vibe README; Qwen shortcuts |
| **Shift+Tab** cycles a mode/agent/thinking level | Crush, Pi, Cline, opencode/Kilo, Vibe | keys.go; keybindings.md; tui.mdx; opencode keybinds; Vibe README |
| **`/` slash-command completion and `@` file completion popup** | Crush, aider, Vibe, Qwen, Continue, Cline, opencode | keys.go (`@` "mention file", `/` "commands"); io.py AutoCompleter; Vibe README; Qwen shortcuts; Continue tui-mode; tui.mdx; opencode |
| Slash set: **/help, /new|/clear, /sessions|/resume, /model(s), /compact, /exit|/quit** | Pi, Continue, Goose, Cline, opencode/Kilo, Vibe, aider (subset) | per-tool lists above |
| **/undo** (git-backed) | aider, Cline, opencode/Kilo | git.html; tui.mdx; opencode tui |
| **/export or /copy** transcript | aider (/copy, /copy-context), Pi (/export, /copy), opencode (/export), Amp (Ctrl+X copy in Pi; Amp copyOnSelect) | per-tool lists |
| **Session resume: `-c/--continue` most recent + `--resume` picker** | Pi, Vibe, Kilo/opencode, Continue (`--resume`), Goose (`--resume`), Cline (`--id`) | per-tool sections |
| **Fork a session** | Pi (`--fork`, `/fork`), Goose (`--fork`), Continue (`/fork`) | per-tool sections |
| **Steering vs queued follow-up while the agent runs** | Pi (Enter steer / Alt+Enter follow-up), Qwen (Enter steer / Ctrl+Q queue), Vibe (Enter/Ctrl+Enter steer; Escape pauses queue), Amp (↑/↓ queued messages) | usage.md; Qwen shortcuts; Vibe README; Amp keybindings |
| **Three-way approval: allow once / allow for session (don't ask again) / deny** | Crush, Goose, Continue, aider ((A)ll/(S)kip all/(D)on't ask again), Amp (rules) | permissions.go; mod.rs; tui-mode; io.py; tool-level-permissions |
| **Persisted permission rules with allow/ask/deny(+delegate)** | Amp, opencode/Kilo, Continue, Crush (`allowed_tools`) | tool-level-permissions; kilo docs; tool-permissions; schema.json |
| **Footer/status with tokens, cost and context %** | Pi, Crush (sidebar), Cline, aider (line), Vibe (gauge), Kilo (balance), Amp (`showCosts`), Goose (opt-in) | per-tool sections |
| **Compact/summarize** context | Pi, Goose, Continue, Cline, opencode/Kilo, Crush (`disable_auto_summarize`) | per-tool lists |
| **Bell/notification when done or blocked on input** | aider (`--notifications`), Goose (`GOOSE_CLI_BELL`), Amp (`amp.notifications.enabled`), Crush (`options.notifications`) | options.html; environment-variables.md; settings; schema.json |
| **Headless/print mode + JSON stream** | Pi (`--mode json`), Amp (`--stream-json`), Cline (`--json` NDJSON), Continue (`-p`), Vibe (`--output json|streaming`), Goose (`session list --format json`) | per-tool sections |
| **Theme switch incl. an `ansi`/16-colour theme** | Goose (`/t` light/dark/ansi), Crush (`internal/ui/common/ansi16.go`), opencode (`/themes`), Vibe (`/theme`), aider (`--dark-mode/--light-mode`) | per-tool sections; https://github.com/charmbracelet/crush/tree/main/internal/ui/common (2026-09-20) |
| **User-editable keymap file with action ids** | Pi, Amp, opencode/Kilo | keybindings.md; `amp.keymap`; `tui.json` |
| **Ctrl+Z suspend** | Crush, aider, Pi, opencode/Kilo | keys.go; io.py; keybindings.md; kilo docs |
| **Image paste (Ctrl+V)** | Crush, Pi, Amp | keys.go; keybindings.md; Amp keybindings |
| **Voice input** | aider (`/voice`), Vibe (`Ctrl+R`, `/voice`) — only 2 | not standard |

---

## 13. Performance lessons, cross-checked against the installed Ink 7.1.1

1. **The overflow → clear-terminal path is the flicker.** Qwen #1778 names it "the biggest
   flicker trigger" (§4). In the installed Ink it is `shouldClearTerminalForFrame`: returns
   true when `wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen ||
   shouldClearOnUnmount`, and on Windows consoles whenever `wasFullscreen || isFullscreen`
   (comment: "Windows consoles scroll the buffer when the bottom-right cell is written … (#969)");
   the frame is then `ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender`
   (`<repo>/node_modules/ink/build/ink.js` lines 83–113 and
   756–770, ink 7.1.1, read 2026-09-20). DESIGN.md §10's `rows − 2` budget is therefore the
   correct lever and must survive the composer (§8 open question 1).
2. **Ink 7.1.1 already ships what Pi and Claude Code built by hand**, at zero dependency cost:
   - synchronized output: `export const bsu = '\u001B[?2026h'; export const esu =
     '\u001B[?2026l';` and `shouldSynchronize(stream, interactive) = 'isTTY' in stream &&
     stream.isTTY && (interactive ?? !isInCi)` (`node_modules/ink/build/write-synchronized.js`,
     read 2026-09-20). Ink wraps both the clear-terminal path and the static+dynamic path in
     bsu/esu (`ink.js` 757–790). Qwen's "Design assuming synchronized output support is
     unavailable" still applies: unsupporting terminals ignore the mode.
   - line-differential output: `incrementalRendering` "only updates changed lines instead of
     redrawing the entire output. This can reduce flickering and improve performance for
     frequently updating UIs." (`node_modules/ink/readme.md` §incrementalRendering, read
     2026-09-20). Implementation: `createIncremental` compares `nextLines[i] ===
     previousLines[i]` and skips ("We do not write lines if the contents are the same. This
     prevents flickering during renders."), writing `cursorTo(0) + line + eraseEndLine` only for
     changed rows; the default `createStandard` writes `eraseLines(previousLineCount) + str`
     every frame (`node_modules/ink/build/log-update.js`, read 2026-09-20). **Measured** (§14):
     16× fewer bytes per frame at 30 rows.
   - kitty keyboard protocol: `render(..., {kittyKeyboard: {mode: 'auto'}})`; auto mode
     sends `CSI ? u` and enables only on reply ("The CSI ? u query is safe to send to any
     terminal — unsupporting terminals simply won't respond, and the 200ms timeout handles
     that.", `ink.js` `initKittyKeyboard`/`confirmKittySupport`, read 2026-09-20); it
     disambiguates "`Shift+Enter` vs `Enter`", "`Ctrl+I` vs `Tab`", "`Escape` key vs
     `Ctrl+[`" and keeps "Ctrl+letter shortcuts work as expected" (readme §kittyKeyboard).
   - bracketed paste: `usePaste` "Bracketed paste mode (`\x1b[?2004h`) is automatically enabled
     while the hook is active" and paste content "is never forwarded to `useInput`" (readme
     §usePaste; `components/App.js` writes `\u001B[?2004h`/`l`, read 2026-09-20).
   - hardware cursor for IME: `useCursor().setCursorPosition({x, y})`, "essential for IME
     (Input Method Editor) support" (readme §useCursor) — Pi does the same with its
     `CURSOR_MARKER`.
   - `$EDITOR` hand-off: `useApp().suspendTerminal(callback?)` "Temporarily hands the terminal
     over to a child process (such as `$EDITOR`, `less`, or `fzf`), then restores Ink's terminal
     state and forces a full redraw." (readme §suspendTerminal).
   - throttle: `maxFps` default 30 → `renderThrottleMs = Math.max(1, Math.ceil(1000 / maxFps))`
     (`ink.js` 194–198); Pi uses `MIN_RENDER_INTERVAL_MS = 16`; JevCode's 20 fps live coalescer
     (DESIGN §10) sits below both.
   - `alternateScreen: true` exists but "The terminal's scrollback buffer is not available while
     in the alternate screen" (readme §alternateScreen) — the trade Qwen made and #8659 paid for.
3. **Never remount `<Static>`.** Qwen's Ctrl+O freeze came from `refreshStatic()` remounting
   every item (PR #3905). Ink's `<Static>` only renders `items.slice(index)` with `index`
   advanced in `useLayoutEffect` (`node_modules/ink/build/components/Static.js`, read
   2026-09-20); any key change or `items` reset replays everything. JevCode's append-only,
   never-edited transcript items (DESIGN §10) are the right invariant; toggles (details on/off)
   must only affect dynamic panes or append new items.
4. **Static replay cost grows linearly with the transcript.** §14 measurement: at 1,000 committed
   items the clear-terminal frame is ~293 KB; at 20 fps that is ~5.7 MB/s of terminal writes.
   That is why the budget gate must be 0 clears, not "few".
5. **Full-screen + mouse capture is the contested choice.** Pi: scrolling "always feels kind of
   off"; Qwen #8659: web terminals tear under full-screen redraws and users must set
   `mouseTracking: false`; opencode ships `"mouse": true` and documents disabling native
   selection (§9). Crush needs a frame cache purely to survive wheel-event floods (§1).
6. **Input must bypass render throttling.** Pi's `requestImmediateRender()` for keystrokes and
   Crush's frame cache "keeps the event loop draining" both exist to keep typing latency below
   the render budget; in Ink terms, composer keystrokes should update only the composer's own
   `<Box>` (small subtree) and never trigger a transcript re-render.
7. **Secondary source (not in the topic list, cite with care)**: Claude Code "rewrote the
   renderer from scratch — while still keeping React as the component model" because Ink
   "didn't support the kind of fine-grained incremental updates needed for a long-running
   interactive UI" (https://steipete.me/posts/2025/signature-flicker, 2026-09-20). Ink 7.1.1's
   `incrementalRendering` is the upstream answer to that gap.

## 14. Measurements made (2026-09-20, Node v22.23.2, ink 7.1.1 from this repo's node_modules)

Scripts in `/tmp/jevtui/` (scratch; not committed).

**A. `bench-logupdate.mjs`** — bytes written per frame by Ink's two log-update strategies
(`logUpdate.create(stream, {incremental})`) for a 120-column region where exactly one line
changes per frame, 1,000 frames, fake TTY stream counting bytes:

| mode | rows | bytes/frame | writes/frame | µs/frame (CPU) |
| --- | --- | --- | --- | --- |
| standard (default) | 10 | 1,176 | 1 | 3 |
| standard (default) | 30 | 3,496 | 1 | 4 |
| incremental | 10 | 156 | 1 | 2 |
| incremental | 30 | 216 | 1 | 5 |

Reading: the default path rewrites the whole dynamic region (~1 byte per cell plus escapes);
incremental writes ~16× fewer bytes at 30 rows with no measurable CPU cost. The bytes are what
the terminal must parse and paint, so this is the flicker/latency lever for the live pane,
decisions pane and composer. (The script printed a trailing `[?25h` from `cliCursor` — Ink
shows the cursor again on process exit.)

**B. `bench-static-replay.mjs`** — size of Ink's overflow frame `clearTerminal +
fullStaticOutput + frame` (§13.1) as the committed transcript grows (3 lines × ~100 cols per
item, 20-row dynamic frame):

| committed items | static bytes | overflow frame bytes | KB/s at 20 fps |
| --- | --- | --- | --- |
| 50 | 14,550 | 16,661 | 325 |
| 200 | 58,200 | 60,311 | 1,178 |
| 1,000 | 291,000 | 293,111 | 5,725 |

Reading: one violated height budget on a long run costs megabytes per second of terminal
output and a visible whole-screen repaint per frame; the perf gate of zero `\x1b[2J` after the
first frame (DESIGN §12) is the right gate.

**C. Environment**: `node --version` → `v22.23.2` (matches `.nvmrc` pin); installed `ink`
7.1.1, `react` 19.3.0 (`node -e` over package.json, 2026-09-20).

---

## 15. ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | Keep the primary screen and scrollback (no `alternateScreen`), keep `<Static>` append-only, keep the `rows − 2` budget; add a **composer capped at N rows (e.g. 5) with internal scrolling** counted inside the budget | Overflow → clear-terminal is "the biggest flicker trigger"; alternate screen loses scrollback and tears in web terminals | Qwen #1778, #8659; Pi blog; ink.js `shouldClearTerminalForFrame` (all 2026-09-20) |
| A2 | `render(..., { incrementalRendering: true })` and re-run `perf/render-lag.ts` to confirm zero `\x1b[2J` and lower bytes | 16× fewer bytes/frame measured; Ink wraps frames in `?2026h/l` already | §14 A; `log-update.js`; `write-synchronized.js` |
| A3 | `kittyKeyboard: { mode: 'auto' }` so Shift+Enter, Ctrl+I/Tab and Escape are unambiguous where supported; **Ctrl+J is the universal newline fallback**; document per-terminal setup like Pi's `terminal-setup.md` | 7 of 10 tools use shift+enter/ctrl+j; Ghostty/Apple Terminal need mapping; VS Code ≥1.109.5 has kitty on by default | opencode keybinds; Pi terminal-setup.md; ink readme §kittyKeyboard |
| A4 | Composer keys: `Enter` submit, `Shift+Enter`/`Ctrl+J` newline, `Esc` interrupt current step (maps to a `directive` event, not abort), `Ctrl+C` clear input / second press within 1 s exits, `Ctrl+D` exit on empty, `Ctrl+G` `$EDITOR` via `suspendTerminal`, `Ctrl+O` toggle decision/tool detail rows, `Up/Down` prompt history, `Ctrl+R` reverse history search (later), `Ctrl+Z` suspend | Each appears in ≥3 tools (§12); Ink provides `suspendTerminal` | §12 rows 1–6, 21 |
| A5 | `usePaste` for bracketed paste; collapse pastes > 10 lines to `[pasted N lines]` in the composer while sending the full text | Pi marks ">10 line pastes"; Ink `usePaste` keeps paste out of `useInput` | Pi tui README; ink readme §usePaste |
| A6 | `useCursor().setCursorPosition` for the composer so IME and the hardware cursor land on the caret | Ink documents it as "essential for IME"; Pi does the same via `CURSOR_MARKER` | ink readme §useCursor; pi tui.ts |
| A7 | Slash commands (minimum): `/help /new /resume [id] /sessions /model /budget /decisions /diff /undo /export /copy /editor /compact? /status /quit(/exit)`; `/`-prefixed completion popup within the budget; `@path` completion over the workspace candidate list | Core set present in ≥5 tools; JevCode already has candidate listing and checkpoints | §12 rows 7–10 |
| A8 | Sessions: add `-c/--continue` (most recent run for this workspace) and `/sessions` picker over `~/.jevcode/runs` (read only after first frame); keep `--resume <id>`; consider `--fork` = new run id seeded from a checkpoint | Pi, Vibe, Kilo, Continue, Goose, Cline all expose continue + picker; fork in 3 | §12 rows 11–12 |
| A9 | **Steering**: `Enter` while a step runs queues a steering message delivered at the next intent Choice; `Alt+Enter` (or `Ctrl+Q`) queues a follow-up delivered at `run:end`/`done`; `Esc` cancels the in-flight generator/synth call and returns queued text to the composer | Pi/Qwen/Vibe converge on exactly this split | Pi usage.md; Qwen shortcuts; Vibe README |
| A10 | Review prompt: keep `[y] approve [n] decline`, add `Esc` = decline, `d` = toggle diff/command preview (split/unified not needed), `t`/`f` reserved; show the four risk dimensions first, preview second | Crush dialog is the richest; Escape-denies is common | permissions.go; Goose mod.rs |
| A11 | Status/footer content: `step/max · wall · ↑gen ↓gen tokens · Jev calls · $gen/$jev of cap · stage · spinner`, using aider's `format_tokens` ("1.2k", "12k") and "message, session" split for cost; add **context-window % of the last generator request** as a Jev-native "window" figure | Cost + tokens + context % appear in 8 tools; aider's compact formatting is proven | §12 row 15; aider base_coder.py/utils.py |
| A12 | Jev-native decisions view: keep the 12-row pane; `Ctrl+O` expands the selected decision (all Noul probabilities, criteria, reason) into an appended `<Static>` item rather than resizing the pane | Detail toggles must never remount Static (Qwen #3905) | §13.3 |
| A13 | Bell: `\x07` on `confirm:request` and `run:end` behind `--bell`/`JEVCODE_BELL` (default off) | aider/Goose/Amp/Crush all ship it; Amp fires "when the agent … is blocked waiting for user input" | options.html; environment-variables.md; Amp settings |
| A14 | Keymap file `~/.config/jevcode/keybindings.json` with action ids (`composer.submit`, `composer.newline`, `run.interrupt`, `review.approve`, …), `"none"` disables; no leader key by default | Pi, Amp, opencode use action ids + unbind sentinel | keybindings.md; `amp.keymap`; opencode keybinds |
| A15 | Prompt history file `~/.jevcode/history` written through the redactor, `--no-history` opt-out | aider `FileHistory`, Vibe "Persistent command history", Goose/Amp Ctrl+R | io.py; Vibe README; Amp keybindings |
| A16 | Theme: `--theme dark|light|ansi` (16-colour `ansi` for tmux/web terminals) honouring `NO_COLOR`; no theme gallery | Goose ships ansi default; Crush has `ansi16.go`; web terminals lack `COLORTERM` (#8659) | environment-variables.md; crush common listing; #8659 |
| A17 | Packaging: keep one bundle; add a CI gate on `npm pack --dry-run` size and file count (target ≪ 1 MB vs Continue 64.8 MB / Qwen 124 MB); `files` whitelist; no `postinstall`; `--version`/`--help` answered before any import of Ink | Size discipline is the differentiator; all binary-shipping tools need postinstall | npm registry JSON (§0) |
| A18 | Headless parity: `--plain` stays; add `--json` NDJSON of `EngineEvent`s (`type`, `ts`, `step`, payload) for scripts, auto-enabled when stdout is not a TTY and `--json` given | Cline `--json`, Amp `--stream-json`, Pi `--mode json`, Vibe `--output streaming` | §12 row 18 |
| A19 | `/export` writes the transcript items as markdown to a file (same item list as `transcript.log`) and `/copy` copies the last proposal via OSC 52 when supported, else prints a path | Pi `/export`, opencode `/export`, aider `/copy-context` | §12 row 10 |
| A20 | Exit banner / final summary line on `run:end` (stop reason, cost, run id, resume hint) | Crush `exit_banner`; aider session cost line | schema.json; base_coder.py |

## 16. REJECT

| # | What not to do | Why |
| --- | --- | --- |
| R1 | Alternate screen + virtualized history (Qwen PR #4146 path, ~2,800 LoC) | Loses scrollback; tears in web terminals (#8659); JevCode's append-only Static + budget already avoids the remount storms it was built to fix |
| R2 | Mouse capture / SGR mouse tracking | Pi: scrolling "always feels kind of off"; Qwen users must disable it; Crush needs a frame cache to survive wheel floods; native selection/scroll is free |
| R3 | A custom renderer (Pi, Claude Code) | Ink 7.1.1 already has synchronized output, incremental line diff, kitty protocol, bracketed paste, cursor control; deps are frozen at ink+react |
| R4 | Leader-key chords as the primary scheme (opencode `ctrl+x`) | Discoverability cost; JevCode has < 15 actions; allow chords only via the keymap file |
| R5 | Remounting `<Static>` for any toggle (Qwen `refreshStatic()`) | Multi-second freezes at >200 items; replay cost is linear (§14 B) |
| R6 | Vim editing mode (aider `--vim`) | Scope; prompt_toolkit gives it for free, Ink does not |
| R7 | Voice input (aider `/voice`, Vibe `Ctrl+R`) | Needs PortAudio/ffmpeg or native capture deps (Qwen ships optional audio deps); violates the two-dependency rule |
| R8 | LSP/MCP sidebars (Crush) | JevCode has neither; sidebar rows would eat the height budget |
| R9 | Background auto-update (Amp, Kilo/opencode postinstall, Continue `/update`) and telemetry (Crush metrics) | Zero network at launch; keys never leave the machine |
| R10 | Platform-binary `optionalDependencies` + `postinstall` launcher (opencode, Kilo, Amp, Cline) | Not applicable to a Node bundle; postinstall is a supply-chain surface |
| R11 | Theme galleries, transparency, exit banners as art (Crush `transparent`, `exit_banner`) | Cosmetic; JevCode's differentiator is the decisions view |
| R12 | Persisted "always allow" rules that bypass Jev (Amp rules, Continue permissions.yaml, Crush `allowed_tools`, Goose `Always Allow`) | Jev scores risk on every action by design; README fixes thresholds and forbids auto-approve in the 0.3–0.7 band; at most an in-memory "approve for this session for this exact target" (open question 3) |
| R13 | `Ctrl+L` as model picker (Crush, Pi) | Conflicts with the older `Ctrl+L` = clear-screen convention (aider, Qwen, Cline); JevCode has no runtime model switch anyway |
| R14 | `Ctrl+C` = immediate quit (Crush) | Every other tool uses clear/abort-then-exit; accidental loss of a composed prompt |
| R15 | `--yolo`/`-y` skip-all flag | Bench already uses `alwaysDecline`; a skip-all mode would invert the harness' safety model |
| R16 | Git auto-commits per edit (aider) and git-dependent `/undo` (opencode) | JevCode has per-step checkpoints; undo should revert a checkpointed patch, not depend on the user's git state |
| R17 | Ink `maxFps` above 30 or below 20 for the live pane | 20 fps coalescer already meets the lag gates; Pi's 16 ms floor buys nothing in a scrollback UI |

## 17. OPEN QUESTIONS

1. **Composer vs height budget**: with status (1) + rule (1) + live (2) + decisions (≤12) +
   confirm (≤ 8+header) a 5-row composer overflows a 24-row terminal; which pane shrinks first
   (decisions, then live?), and does a 10-row terminal drop the decisions pane entirely?
2. **Does `kittyKeyboard: {mode:'auto'}` affect first frame?** The `CSI ? u` query and 200 ms
   timeout run after `render()`; verify in `perf/first-frame.ts` that the sentinel time is
   unchanged and the query bytes do not break the pty parse (they are stripped by Ink, but the
   harness reads raw pty output).
3. **"Approve for this session"**: is an in-memory allow-list keyed by `(action kind, target)`
   compatible with "no auto-approve" for risk 0.3–0.7, or must every mid-risk action prompt?
   If allowed, Jev should be told (a `confirm:resolved` with `source: session-rule`).
4. **Steering semantics under Jev-decides**: is a steering message an extra input to the next
   intent Choice (Jev sees it and decides), a forced replan, or both? What happens to a steering
   message in `jev-only` mode where there is no generator to steer?
5. **`/undo`**: revert the last committed step's patch from its checkpoint and append an `undo`
   transcript item; does Jev re-judge the plan afterwards, and how is a dirty user tree handled?
6. **`--continue` scoping**: most recent run globally or per `--workspace`? Pi/Vibe are global;
   Kilo is "most recent workspace session".
7. **Ctrl+Z**: Ink's `suspendTerminal` is for child processes; a true SIGTSTP suspend needs raw
   mode off + `process.kill(process.pid, 'SIGTSTP')` and a repaint on `SIGCONT` — test on macOS.
8. **History redaction**: prompts typed by the human may contain secrets not in the redactor's
   seed set; is a heuristic (`sk-…`, `ghp_…`) plus `--no-history` enough?
9. **Windows console**: Ink forces clear-terminal on any fullscreen frame on `win32`; JevCode
   targets macOS/Linux — document as unsupported or test in Windows Terminal?
10. **`incrementalRendering` + `<Static>` interplay**: verify that a Static flush (which calls
    `this.log.clear()` then rewrites) does not defeat the incremental diff for that frame, and
    measure bytes with `perf/render-lag.ts` at rows 12 and 40.
11. **Escape key latency**: without kitty protocol Ink must wait for a possible escape sequence
    continuation; measure Esc-to-interrupt latency and whether `Esc Esc` (Amp) is needed.
12. **Decisions detail expansion (A12)** appends items; on a long run this grows scrollback —
    acceptable, or should the expansion be a dynamic overlay within the budget?

## 18. UNVERIFIED / not fetched

- Amp CLI's UI framework (binary-only npm package; no manifest evidence). Amp's on-screen
  approval labels (`ampcode.com/notes/permissions` and `/news/tool-level-permissions` describe
  rules, not the prompt). `https://ampcode.com/docs/modes` → 404; modes taken from
  `/news/the-dial` and `/news/rush-mode`.
- Cline and Mistral Vibe approval prompt labels (docs fetched do not show them).
- Crush exact context-% / cost format string (`common.ModelInfo()` not found under
  `internal/ui/common`, listing fetched 2026-09-20).
- Continue CLI keybindings beyond ↑/↓/Enter; `UserInput.keyboard.test.ts` only tests mode
  cycling order.
- Kilo `https://kilo.ai/docs/cli/keybinds`, `/docs/cli/configuration`, and
  `raw.githubusercontent.com/Kilo-Org/kilocode/main/cli/README.md` → 404; keybinds inherited
  from opencode (`/docs/keybinds/`).
- Goose `documentation/docs/guides/goose-permissions.md` and the block.github.io permissions page
  → 404/empty; approval labels taken from `crates/goose-cli/src/session/mod.rs` instead.
- Qwen `qwenlm.github.io/.../design/virtual-viewport/` → 404; used the raw repo markdown.
- GitHub contents API returned 403 (rate limit) for `crush/internal/tui` (path does not exist;
  `internal/ui` does), `continue/extensions/cli/src/{ui,commands}`, `cline/cline/contents/cli`
  (CLI lives at `apps/cli`); HTML tree pages and raw files were used instead.
- Pi: `packages/tui/src/tui.ts` holds only the abstract `doRender()`; algorithm quoted from
  `tui-main-screen.ts`. The README names `@earendil-works/pi-coding-agent`; npm shows
  `@mariozechner/pi-coding-agent` deprecated in favour of it.
- Gemini CLI, Codex CLI and Claude Code are covered in `docs/research/05-cli-architectures.md`
  and were not re-fetched here except the secondary Claude Code flicker post (§13.7).

## 19. Verification log (2026-09-20)

Fetched via WebFetch/WebSearch: charmbracelet/crush README, schema.json, go.mod,
internal/ui listing, internal/ui/model/{keys,status,sidebar,lsp,mcp,framecache}.go,
internal/ui/dialog listing + permissions.go, internal/ui/common listing; aider docs
commands/watch/modes/voice/options/git + aider/io.py, coders/base_coder.py, utils.py; pi-mono
README, packages/tui/README.md, packages/tui/src/{tui,tui-main-screen}.ts, packages/tui/src
listing, coding-agent README + docs listing + docs/{keybindings,tui,terminal-setup,usage}.md,
mariozechner.at 2025-11-30 post, npm `@mariozechner/pi-coding-agent`; qwen-code issues #1778,
#1491, #8659, PRs #3905, #4146, docs/design/virtual-viewport/README.md,
docs/users/configuration/settings.md, keyboard-shortcuts page, npm `@qwen-code/qwen-code`;
continue extensions/cli/{package.json,README.md}, src/ui listing,
src/ui/UserInput.keyboard.test.ts, docs tui-mode/tool-permissions/quickstart, npm
`@continuedev/cli`; ampcode.com docs cli/{keybindings,execute-mode,streaming-json,settings},
news/{tool-level-permissions,the-dial,rush-mode}, notes/permissions, npm `@ampcode/cli`,
`@sourcegraph/amp`; goose crates/goose-cli/{Cargo.toml,src/session/input.rs,src/session/mod.rs},
documentation/docs/guides/{goose-cli-commands,environment-variables}.md; cline
apps/cli/{package.json,README.md}, docs/usage/tui.mdx, docs.cline.bot cline-cli/{overview,
cli-reference}, blog cline-cli-2-0; kilo.ai docs cli + code-with-ai/platforms/cli, npm
`@kilocode/cli`, `opencode-ai`, anomalyco/opencode packages/opencode/package.json,
opencode.ai docs keybinds + tui; mistral-vibe README.md + pyproject.toml; steipete.me
signature-flicker (secondary). Read locally: `node_modules/ink/{readme.md,
build/ink.js, build/log-update.js, build/write-synchronized.js, build/kitty-keyboard.js,
build/components/{Static,App}.js, build/hooks/*}`. Ran: `/tmp/jevtui/bench-logupdate.mjs`,
`/tmp/jevtui/bench-static-replay.mjs`, `node --version`.
