# 06 — Interaction and visual conventions from the best terminal UIs

Research note for the JevCode interactive TUI (composer, slash commands, sessions, steering, review
prompts, Jev decisions view). Written 2026-09-20. Every claim carries its source and fetch date;
local sources are the installed `node_modules` of this repo (ink 7.1.1, chalk 5.6.2, Node 22.23.2).
Items that could not be fetched are marked **UNVERIFIED** with what was tried.

Constraints this note respects (README.md and DESIGN.md §10/§12, read 2026-09-20): Node 22, strict TS,
ESM, one npm package, runtime deps only `ink` 7.1.1 + `react` 19.3.0, esbuild single bundle, first
frame < 300 ms with zero network, rendering never blocks the loop, zero terminal clears after the first
frame (dynamic region ≤ `rows − 2`, `<Static>` for committed items), keys never in logs.

Current TUI baseline (`src/tui/App.tsx`, `src/tui/useEngine.tsx`, read 2026-09-20): one `useInput`
gated by `Boolean(isRawModeSupported)`, Ctrl-C → `onAbort('human_abort')`, `y`/`n` only while a
`confirm:request` is pending, `render({ exitOnCtrlC: false, patchConsole: false })`, panes = Static
transcript, 1-row rule `─`, 2-row live region, ≤ 12-row decisions pane, confirm box, 1-row status line.

---

## 0. What Ink 7.1.1 can actually deliver (measured locally)

Before borrowing conventions from Go/Rust/Python TUIs, the key-parsing floor is Ink's
`parse-keypress.js` (a copy of enquirer's keypress parser plus a kitty CSI-u parser) and
`use-input.js`, which reduces a keypress to `(input: string, key: Key)` with booleans
`upArrow downArrow leftArrow rightArrow pageDown pageUp home end return escape ctrl shift tab
backspace delete meta super hyper capsLock numLock` and `eventType`
(`node_modules/ink/build/hooks/use-input.d.ts`, read 2026-09-20).

**Measurement 1 — what `useInput` sees for each terminal sequence.** Script `/tmp/jevtui/keys.mjs`
imported `node_modules/ink/build/parse-keypress.js` and reproduced the `input` derivation in
`use-input.js` (Node v22.23.2, run 2026-09-20). Selected rows:

| Key (sequence) | `name` | ctrl | meta | shift | `input` |
| --- | --- | --- | --- | --- | --- |
| Ctrl+A/E/B/F/K/U/W/Y/D/L/R/P/N/G/O/T (`\x01`…) | letter | true | – | – | letter |
| Ctrl+H (`\x08`) | `backspace` | false | – | – | `""` (indistinguishable from Backspace) |
| Ctrl+I (`\t`) / Ctrl+M (`\r`) | `tab` / `return` | – | – | – | Tab/Enter (indistinguishable) |
| Ctrl+J (`\n`) | `enter` | – | – | – | `"\n"` — **`key.return` is false**; test `input === '\n'` |
| Ctrl+_ (`\x1f`) | `""` | false | – | – | `"\u001f"` (raw byte, no name) |
| Ctrl+Space (`\x00`) | `` ` `` | true | – | – | `` "`" `` (mis-named; do not bind) |
| Backspace (`\x7f`) / Alt+Backspace (`\x1b\x7f`) | `backspace` | – | false/true | – | `""` |
| Alt+B / Alt+F / Alt+D (`\x1bb`…) | letter | – | true | – | letter |
| Alt+Enter (`\x1b\r`) | `return` | – | true | – | `"\r"` |
| Ctrl+Left / Ctrl+Right (`\x1b[1;5D/C`) | `left`/`right` | true | – | – | `""` |
| Alt+Left / Alt+Right (`\x1b[1;3D/C`) | `left`/`right` | – | true | – | `""` |
| Shift+Up (`\x1b[1;2A`), Shift+Tab (`\x1b[Z`) | `up`/`tab` | – | – | true | `""` |
| Alt+Delete (`\x1b[3;3~`), Ctrl+Delete (`\x1b[3;5~`) | `delete` | –/true | true/– | – | `""` |
| PgUp/PgDn/Home/End/Insert/F1/F5 | named | – | – | – | `""` |
| Shift+Enter, kitty (`\x1b[13;2u`) | `return` | – | – | **true** | `"\r"` |
| Ctrl+Enter / Alt+Enter, kitty (`\x1b[13;5u`, `\x1b[13;3u`) | `return` | true/– | –/true | – | `"\r"` |
| **Shift+Enter, xterm modifyOtherKeys (`\x1b[27;2;13~`)** | `""` | – | – | – | **`"[27;2;13~"`** leaks as typed text |
| Ctrl+Enter, xterm modifyOtherKeys (`\x1b[27;5;13~`) | `""` | – | – | – | `"[27;5;13~"` leaks |
| Esc Esc (`\x1b\x1b`) | `escape` | – | **true** | – | `"\u001b"` → stripped to `""` |
| Ctrl+Backspace kitty (`\x1b[127;5u`) | `backspace` | true | – | – | `""` |

Consequences for the keymap: (a) Shift+Enter is only reliable under the kitty protocol; the
xterm `CSI 27;mod;code~` form (produced by xterm/foot/VTE when `modifyOtherKeys` is on) is not
parsed and would inject `[27;2;13~` into the composer, so JevCode must detect and swallow that
pattern itself; (b) Ctrl+J is a free, universally-parsed newline key (`input === '\n'`);
(c) Alt+Enter is parsed in both legacy and kitty encodings; (d) Ctrl+H cannot be a separate
binding; (e) `key.meta && key.escape` is how a double-Esc arrives when both bytes land in one chunk.

**Measurement 2 — parse cost.** 200,000 `parseKeypress` calls over five mixed sequences took
25.7 ms = **129 ns/call** on Node v22.23.2 (same script, 2026-09-20). Key parsing is not a budget
concern; the budget lives in React re-renders per keystroke (see §5).

**Ink facts used below** (all read 2026-09-20 in `node_modules/ink/build/`):
- Bracketed paste: `input-parser.js` recognises `'\u001B[200~'`…`'\u001B[201~'`; `usePaste`
  “Bracketed paste mode (`\x1b[?2004h`) is automatically enabled while the hook is active” and
  “paste content is never forwarded to `useInput` handlers when `usePaste` is active”
  (`hooks/use-paste.js`). Without a paste listener, `components/App.js` emits the paste through the
  normal input channel (`if (internal_eventEmitter.current.listenerCount('paste') === 0) { emitInput(event.paste) }`).
- Lone ESC: an incomplete escape sequence is held and flushed after
  `const pendingInputFlushDelayMilliseconds = 20;` (`components/App.js:45`). So a bare Esc press
  is delivered ~20 ms late, and Alt+letter typed slowly (>20 ms) can split into Esc + letter.
- Esc also “Reset[s] focus when there's an active focused component” when the focus manager is
  enabled (`components/App.js`).
- Kitty protocol is **opt-in**: `render({ kittyKeyboard: { mode: 'auto' | 'enabled' | 'disabled', flags } })`;
  default flags `['disambiguateEscapeCodes']`; auto mode writes `'\u001B[?u'`, waits up to
  `setTimeout(cleanup, 200)` ms for `CSI ? flags u`, then writes `` `\u001B[>${flags}u` ``
  (`ink.js` `initKittyKeyboard`/`confirmKittySupport`/`enableKittyProtocol`). Disabled when not
  interactive or either stream is not a TTY.
- `render()` options now include `alternateScreen` (default false; “The terminal's scrollback buffer
  is not available while in the alternate screen”), `maxFps` (default 30), `incrementalRendering`
  (default false), `isScreenReaderEnabled` (default `process.env['INK_SCREEN_READER'] === 'true'`),
  `interactive` (`render.d.ts`).
- `<Text wrap>` accepts `wrap | truncate | truncate-start | truncate-middle | truncate-end`;
  `<Box borderStyle>` accepts `single double round bold singleDouble doubleSingle classic`
  (`classic` is ASCII `+-|`) (https://raw.githubusercontent.com/vadimdemedes/ink/master/readme.md,
  fetched 2026-09-20).
- Focus: `useFocus`/`useFocusManager` — “When the user presses Tab, focus switches to the next
  focusable component. Shift+Tab switches to the previous one” (same readme).
- Colour: `colorize.js` calls `chalk` (chalk 5.6.2). Its vendored `supports-color` honours argv
  `--no-color`/`--no-colors`/`--color=false|never`, `--color`, env `FORCE_COLOR` (`'true'`→1,
  `'false'`→0, `''`→1, else `min(int,3)`), `TF_BUILD`, `TERM=dumb`, the CI vendor list,
  `COLORTERM=truecolor`, `TERM=xterm-kitty|xterm-ghostty|wezterm`, `TERM_PROGRAM`
  (iTerm/Apple_Terminal), `/-256(color)?$/`; **it does not read `NO_COLOR`** (grep of
  `node_modules/chalk` and `node_modules/ink/build` for `NO_COLOR` returned nothing, 2026-09-20).

**Measurement 3 — Node's built-in colour detection**, `tty.WriteStream.prototype.getColorDepth(env)`
(Node v22.23.2, 2026-09-20): `{TERM:xterm-256color}`→8; `+COLORTERM:truecolor`→24; `{TERM:dumb}`→1;
`{TERM:xterm-256color,NO_COLOR:'1'}`→1; `{TERM:dumb,FORCE_COLOR:'1'}`→4; `{FORCE_COLOR:'3'}`→24;
`{TERM:xterm-256color,TMUX:'1'}`→24; `{TERM:linux}`→4; `{TERM_PROGRAM:'vscode'}`→1 (no TERM);
`{CI:'1'}`→1; `{NODE_DISABLE_COLORS:'1'}`→1. Node docs: “Disabling color support is also possible by
using the `NO_COLOR` and `NODE_DISABLE_COLORS` environment variables” and `FORCE_COLOR = 0|1|2|3`
forces 2/16/256/16M colours (https://nodejs.org/docs/latest-v22.x/api/tty.html, fetched 2026-09-20).
This shell had `LANG=C.UTF-8` and **no `TERM`** set (the tool's non-TTY shell), a reminder that
TERM-based heuristics must fail safe.

---

## 1. Quit, cancel and interrupt semantics

Survey (all fetched 2026-09-20):

| Program | Quit | Cancel / back | Notes |
| --- | --- | --- | --- |
| lazygit | `quit: [q, <ctrl+c>]`, `quitWithoutChangingDirectory: Q` | `return: <esc>` (“Cancel”) | `confirmOnQuit: false` option (https://raw.githubusercontent.com/jesseduffield/lazygit/master/docs/Config.md; Keybindings_en.md) |
| gitui | `quit: Char('q')`, `exit: Char('c') CONTROL` | `exit_popup: Esc` | (https://raw.githubusercontent.com/gitui-org/gitui/master/src/keys/key_list.rs) |
| k9s | `:quit`/`:q`, `ctrl-c` | `<esc>` “Bails out of view/command/filter mode” | config `noExitOnCtrlC`: “Toggles whether k9s should exit when CTRL-C is pressed. When set to true, you will need to exist k9s via the :quit command. Default is false.” (https://k9scli.io/topics/commands/, https://k9scli.io/topics/config/) |
| tig | `q` “Close view, if multiple views are open it will jump back to the previous view”; `Q` Quit | – | (https://raw.githubusercontent.com/jonas/tig/master/doc/manual.adoc) |
| htop | `F10, q: Quit` | – | (https://raw.githubusercontent.com/htop-dev/htop/main/htop.1.in) |
| btop | `q` quit; `Esc`/`m` menu | `Esc` | README key summary only; in-app help is primary (https://raw.githubusercontent.com/aristocratos/btop/main/README.md) |
| fzf | `ctrl-c`, `ctrl-g`, `ctrl-q`, `esc` → `abort`; `enter` → `accept` | – | (https://raw.githubusercontent.com/junegunn/fzf/master/man/man1/fzf.1) |
| glow | `q` quit, `esc` “clear filter”/“cancel” | | (https://raw.githubusercontent.com/charmbracelet/glow/master/ui/stashhelp.go) |
| bubbles `list` | `Quit: "q", "esc"`, `ForceQuit: "ctrl+c"` (active during filtering) | `ClearFilter: "esc"`, `CancelWhileFiltering: "esc"` | (https://raw.githubusercontent.com/charmbracelet/bubbles/master/list/keys.go) |
| helix picker/prompt | `Escape`, `Ctrl-c` close | | (https://raw.githubusercontent.com/helix-editor/helix/master/book/src/keymap.md) |
| Textual | `Binding("ctrl+q", "quit", "Quit", show=False, priority=True)`; `ctrl+c` → `help_quit` “Alert users that Ctrl+C no longer quits” | modal screens return a value via `dismiss()` | (https://textual.textualize.io/guide/input/, https://textual.textualize.io/api/app/) |
| opencode | `app_exit: "ctrl+c,ctrl+d,<leader>q"`, `input_clear: "ctrl+c"`, `session_interrupt: "escape"` | | leader `ctrl+x`, `leader_timeout` 2000 ms (https://opencode.ai/docs/keybinds/) |
| Claude Code | Ctrl+C: “Interrupts a running operation. If nothing is running, the first press clears the prompt input and a second press exits”; Ctrl+D: “The first press shows a confirmation hint and a second press within 800ms exits. When the prompt has text, `Ctrl+D` deletes the character after the cursor instead” | Esc: “Stop the current response or tool call mid-turn … When a dialog is open, `Esc` closes the dialog. On a permission prompt, `Esc` declines the action”; Esc+Esc: “When the prompt input contains text, double `Esc` clears it and saves the draft to history so `Up` recalls it” | (https://code.claude.com/docs/en/interactive-mode) |
| Node readline | Ctrl+C “Emit `SIGINT` or close the readline instance”; Ctrl+D “Delete right or close the readline instance in case the current line is empty / EOF” | | (https://nodejs.org/docs/latest-v22.x/api/readline.html) |
| GNU readline | `end-of-file (usually C-d)`: “If this character is read when there are no characters on the line, and point is at the beginning of the line, Readline interprets it as the end of input and returns EOF.” | | (https://www.gnu.org/software/bash/manual/html_node/Commands-For-Text.html, curl 2026-09-20) |
| clig.dev | “If a user hits Ctrl-C (the INT signal), exit as soon as possible”; during long cleanup “press Ctrl+C again to force” | | (https://clig.dev/) |

Design reading. Browsing TUIs (lazygit, gitui, tig, htop, glow, bubbles) quit on bare `q` because
they have no text field. A chat TUI cannot: `q` is a letter. All three chat harnesses converge on
the *readline* contract instead: Ctrl+C is context-sensitive (interrupt → clear → exit on second
press), Ctrl+D on an empty composer is EOF/exit (Claude Code adds a confirmation hint + 800 ms
window), Esc is “stop / close / decline”. Textual's move away from Ctrl+C-quits is the same
lesson from the other direction. JevCode's engine already models `human_abort` as a checkpointed
stop with exit 130 (README “Exit codes”), which is what a *second* Ctrl+C should do; the first
Ctrl+C should interrupt the current step (steer) or clear the composer.

---

## 2. Help overlay and how good TUIs document their keys

- `?` is the near-universal help key: lazygit `optionMenu: '?'` (“Open keybindings menu”), k9s
  `?` “Show active keyboard mnemonics and help”, bubbles list `ShowFullHelp: "?"` / `CloseFullHelp: "?"`,
  glow `?` “more”/“close help”, htop `F1, h, ?: Go to the help screen`, tig `h` “Switch to help view”
  (`?` is search-backwards in tig), gitui `open_help: Char('h')` (vim-style config rebinds it to
  `F(1)`) (sources in §1 table; https://raw.githubusercontent.com/gitui-org/gitui/master/vim_style_key_config.ron,
  fetched 2026-09-20). Claude Code: “`?` on empty input — Toggle the shortcut help panel. Typing `?`
  when the input already contains text inserts the character” (interactive-mode doc, 2026-09-20).
- Two-level help is the Charm pattern: `KeyMap` interface `ShortHelp() []key.Binding` (“a slice of
  bindings to be displayed in the short version”) and `FullHelp() [][]key.Binding` (“grouped by
  columns”); defaults `ShortSeparator " • "`, `FullSeparator "    "`, `Ellipsis "…"`; the short view is
  “gracefully truncated, showing only as many help items as possible” at the width
  (https://raw.githubusercontent.com/charmbracelet/bubbles/master/help/help.go, fetched 2026-09-20).
  Bindings carry their own display text: `key.WithKeys("k", "up")`, `key.WithHelp("↑/k", "move up")`
  (https://raw.githubusercontent.com/charmbracelet/bubbles/master/key/key.go, fetched 2026-09-20).
- Textual renders the footer from the focused widget's `BINDINGS`; `show=False` hides a binding,
  `key_display` overrides the key text, `compact` and `show_command_palette` (“Display the key to
  invoke the command palette (show on the right hand side of the footer)”) are reactives
  (https://textual.textualize.io/widgets/footer/, fetched 2026-09-20).
- Helix shows a which-key style popup for pending multi-key sequences: `auto-info` “Displays info
  boxes”, default `true` (https://raw.githubusercontent.com/helix-editor/helix/master/book/src/editor.md,
  fetched 2026-09-20).
- lazygit generates its docs from code: `pkg/cheatsheet/generate.go` — “This 'script' generates files
  called Keybindings_{{.LANG}}.md … The content of these generated files is a keybindings cheatsheet”,
  run with `go generate ./...`; the files carry “This file is auto-generated. To update, make the
  changes in the pkg/i18n directory and then run `go generate ./...`”
  (https://raw.githubusercontent.com/jesseduffield/lazygit/master/pkg/cheatsheet/generate.go, fetched 2026-09-20).
- gitui lets users override how keys are *displayed*: `key_symbols.ron` overrides defaults such as
  `⏎` and `⇧` (https://raw.githubusercontent.com/gitui-org/gitui/master/KEY_CONFIG.md, fetched 2026-09-20).
- htop keeps a permanent function-key bar at the bottom and offers `--no-function-bar` to hide it
  (htop.1.in, 2026-09-20).

Implication: one typed keymap table (`src/tui/keymap.ts`) should feed (1) the input dispatcher,
(2) the `?` overlay (ShortHelp in the status line, FullHelp as an overlay pane), (3) `jevcode keys`
plain output, and (4) `docs/KEYS.md`, with a unit test asserting the doc is regenerated — the lazygit
pattern in TypeScript.

---

## 3. Command palette conventions

- VS Code: Command Palette “⇧⌘P (Windows, Linux Ctrl+Shift+P)”; Quick Open “⌘P (Windows, Linux
  Ctrl+P)” with “Tip: Type ? to view command suggestions”
  (https://code.visualstudio.com/docs/getstarted/tips-and-tricks, fetched 2026-09-20).
- Textual: “Press Ctrl+P to invoke the command palette”; “Commands are looked up via a _fuzzy_ search,
  which means Textual will show commands that match the keys you type in the same order, but not
  necessarily at the start of the command”; `COMMAND_PALETTE_BINDING = "ctrl+backslash"` “restores
  the pre-0.77.0 binding”; providers implement `search(query)` (“Called on each key-press”) and
  `discover()` (shown when the input is empty) (https://textual.textualize.io/guide/command_palette/,
  fetched 2026-09-20).
- opencode: `command_list: "ctrl+p"`, plus a `leader` (`ctrl+x`) for most app commands
  (https://opencode.ai/docs/keybinds/, fetched 2026-09-20).
- helix: `Space ?` “Open command palette”, `:` “Enter command mode”; picker keys `Tab/Down/Ctrl-n`,
  `Shift-Tab/Up/Ctrl-p`, `Enter`, `Escape/Ctrl-c` (keymap.md, 2026-09-20).
- k9s: `:` “Enter command mode” (`:pod⏎`), `ctrl-a` “Show all available resource alias”; tig `:` “Open
  prompt”; lazygit `executeShellCommand: ':'` (sources in §1).
- fzf is the reference palette engine: `--layout=reverse`, `--info=inline`, `--prompt='> '`,
  `--pointer='▌'`, `--marker='┃'`, `--no-unicode`, `--border=rounded|sharp|bold|double|…`, default
  `ctrl-j/ctrl-n/down` and `ctrl-k/ctrl-p/up` movement, `tab`/`shift-tab` toggle, `enter` accept
  (fzf.1, 2026-09-20).
- Claude Code uses a prefix instead of a chord: “`/` at start — Command or skill”, “`!` at start —
  Shell mode”, “`@` — File path mention” (interactive-mode, 2026-09-20).

Conflict analysis for a composer that honours readline: **Ctrl+K is kill-line** (readline
`kill-line (C-k)`, Node readline “Delete from the current position to the end of line”, fzf, bubbles
textarea `DeleteAfterCursor: "ctrl+k"`, helix prompt `Ctrl-k`, Claude Code “Delete to end of line”) —
binding it to a palette would break muscle memory. **Ctrl+P is previous-history** in readline, Node
readline, fzf, helix prompt, bubbles textarea (`LinePrevious: "up", "ctrl+p"`) and Claude Code
(“`Up/Down arrows` or `Ctrl+P`/`Ctrl+N`”); Textual and opencode chose it only because their inputs do
not implement Ctrl+P history. **Ctrl+Shift+P** is not distinguishable from Ctrl+P without the kitty
protocol (Ink measurement: legacy Ctrl+letter has no shift bit). Therefore the palette should open on
`/` at column 0 of an empty composer (the chat-CLI convention, discoverable, needs no modifier) with
**Ctrl+/ as the chord alias** where parseable (kitty `CSI 47;5u` parses as `name '/', ctrl` — Measurement 1;
legacy terminals usually send `\x1f` for Ctrl+/, which arrives as raw `"\u001f"` and can be matched
by `input === '\u001f'`), and Ctrl+K/Ctrl+P must stay readline.

---

## 4. Line editing: the readline/emacs contract

Sources: GNU Bash manual, Readline User Manual, Node readline “TTY keybindings”, helix prompt table,
bubbles `textinput`/`textarea`, fish, fzf, Claude Code (all fetched 2026-09-20).

| Action | readline (bash manual / rluserman) | Node readline table | helix prompt | bubbles textarea | fish | Claude Code |
| --- | --- | --- | --- | --- | --- | --- |
| Start / end of line | `beginning-of-line (C-a)` “Move to the start of the current line. This may also be bound to the Home key”; `end-of-line (C-e)` | Ctrl+A / Ctrl+E | `Ctrl-a, Home` / `Ctrl-e, End` | `LineStart: "home","ctrl+a"`; `LineEnd: "end","ctrl+e"` | Ctrl+A/E | Ctrl+A/E “In multiline input, moves to the start of the current logical line” |
| Char back / fwd | `backward-char (C-b)`, `forward-char (C-f)` | Ctrl+B / Ctrl+F | `Ctrl-b, Left` / `Ctrl-f, Right` | `"left","ctrl+b"` / `"right","ctrl+f"` | | |
| Word back / fwd | `backward-word (M-b)` “Words are composed of letters and digits”; `forward-word (M-f)` | “Ctrl+Left arrow or Meta+B” (Ctrl+Left “Doesn't work on Mac”) | `Alt-b, Ctrl-Left` / `Alt-f, Ctrl-Right` | `"alt+left","alt+b"` / `"alt+right","alt+f"`; textinput adds `"ctrl+left"`/`"ctrl+right"` | Alt+B/F | Alt+B/F “Requires Option as Meta on macOS” |
| Kill to end / start | `kill-line (C-k)`; `unix-line-discard (C-u)` | Ctrl+K / Ctrl+U | `Ctrl-k` / `Ctrl-u` | `"ctrl+k"` / `"ctrl+u"` | Ctrl+K / Ctrl+U | Ctrl+K / Ctrl+U “Stores deleted text for pasting” |
| Kill word back | `unix-word-rubout (C-w)`, `backward-kill-word (M-DEL)` | “Ctrl+W or Ctrl+Backspace”, Meta+Backspace | `Ctrl-w, Alt-Backspace, Ctrl-Backspace` | `"alt+backspace","ctrl+w"` | Ctrl+W, Alt+Backspace | Ctrl+W “One press removes a whole path or `--flag=value`” |
| Kill word fwd | `kill-word (M-d)` | “Meta+D or Meta+Delete” | `Alt-d, Alt-Delete, Ctrl-Delete` | `"alt+delete","alt+d"` | Alt+D | Alt+D |
| Yank / cycle | `yank (C-y)`, `yank-pop (M-y)`; kill ring: “Any number of consecutive kills save all of the killed text together” (rluserman) | Ctrl+Y “Only works with text deleted by Ctrl+U or Ctrl+K”; Meta+Y | | | Ctrl+Y | Ctrl+Y; Alt+Y |
| Delete char fwd | `delete-char (C-d)` | Ctrl+D | `Delete, Ctrl-d` | `"delete","ctrl+d"` | Ctrl+D | Ctrl+D when prompt has text |
| Transpose / undo | `transpose-chars (C-t)`; undo `C-_` | Ctrl+- (0x1F) “Undo previous change”; Ctrl+6 (0x1E) redo | | `TransposeCharacterBackward: "ctrl+t"` | Ctrl+Z undo | `Ctrl+_` or `Ctrl+Shift+-` “Undo last input edit” |
| Clear screen | `clear-screen (C-l)` “Clear the screen, then redraw the current line” | Ctrl+L | | | Ctrl+L | Ctrl+L “Forces a full terminal redraw” |
| Case ops | `upcase-word (M-u)`, `downcase-word (M-l)`, `capitalize-word (M-c)` | | | `"alt+u"`, `"alt+l"`, `"alt+c"` | | |

(Bash manual pages: https://www.gnu.org/software/bash/manual/html_node/Commands-For-Moving.html and
Commands-For-Text.html fetched via curl 2026-09-20; Commands-For-Killing.html and
Commands-For-History.html returned HTTP 429/ECONNRESET/timeouts on four attempts — the kill/yank and
history definitions above are taken from the Readline User Manual mirror
https://tiswww.case.edu/php/chet/readline/rluserman.html, fetched 2026-09-20, and from Node's table.
Node: https://nodejs.org/docs/latest-v22.x/api/readline.html; helix keymap.md; bubbles
https://raw.githubusercontent.com/charmbracelet/bubbles/master/textarea/textarea.go and
.../textinput/textinput.go; fish https://fishshell.com/docs/current/interactive.html; Claude Code
https://code.claude.com/docs/en/interactive-mode.)

Platform caveats worth writing into the help overlay: Alt/Option shortcuts need “Option as Meta” on
macOS (Claude Code note; xterm: with `metaSendsEscape` the terminal will “prefix a key with the ESC
character”, https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt, curl 2026-09-20); Ctrl+Left/Right
“Doesn't work on Mac” by default (Node readline table) because macOS binds them to Spaces — so every
word motion needs both Alt+B/F and Ctrl+Left/Right, as helix and bubbles textinput do.
Ctrl+M/Ctrl+I/Ctrl+H are not separate keys (Textual: “Ctrl+M is indistinguishable from Enter, and
Ctrl+I is indistinguishable from Tab”, https://textual.textualize.io/guide/input/, 2026-09-20;
Measurement 1).

Rendering budget: every keystroke is one React state update. Ink throttles frames to `maxFps` 30
(≈33 ms) and `useInput` runs handlers inside `reconciler.discreteUpdates` (use-input.js); keep the
composer's state in a reducer, keep the composer box a fixed-height `<Box overflow="hidden">` within
the `rows − 2` budget, and never re-render `<Static>` items on keystrokes (DESIGN §10).

---

## 5. History

- readline: `previous-history (C-p)`, `next-history (C-n)`, `reverse-search-history (C-r)` incremental,
  `history-search-backward` searches “for the string of characters between the start of the current
  line and the point” (prefix search) (rluserman, 2026-09-20; Node table Ctrl+N/Ctrl+P).
- fzf's shell integration binds `'^R' fzf-history-widget` (also `'^T'` files, `'\ec'` cd) and runs
  fzf with `--scheme=history --bind=ctrl-r:toggle-sort,alt-r:toggle-raw`, deduplicating entries
  (https://raw.githubusercontent.com/junegunn/fzf/master/shell/key-bindings.zsh, fetched 2026-09-20).
  fish: Up/Down search history, “Alt+Up/Down search for tokens”, Ctrl+R “opens the history in a pager”
  (fish docs, 2026-09-20).
- Multi-line rule (Claude Code): “When the input spans more than one visual row … first moves the
  cursor within the prompt. Once the cursor is on the first or last visual row, pressing again
  navigates command history” (2026-09-20). opencode: `history_previous: "up"`, `history_next: "down"`.
- Node readline defaults: `historySize` 30, `removeHistoryDuplicates` false (readline docs, 2026-09-20).
- Where history lives: per-workspace under `~/.jevcode` (the runs dir already exists, README), never
  including secrets — the redactor seeded with configured secrets (README “Configuration”) must run
  over prompts before they are persisted, because a user may paste a key into the composer.

---

## 6. Tab completion and inline suggestions

- readline: `complete (TAB)`; `possible-completions (M-?)`; `menu-complete` “replaces the word to be
  completed with a single match … Repeatedly executing `menu-complete` steps through the list”;
  variables `show-all-if-ambiguous` (“matches to be listed immediately instead of ringing the bell”,
  default off), `completion-query-items` (default 100), `menu-complete-display-prefix` (default off),
  `page-completions` (default on), `colored-stats` (uses `LS_COLORS`)
  (https://www.gnu.org/software/bash/manual/html_node/Commands-For-Completion.html and
  Readline-Init-File-Syntax.html, fetched 2026-09-20).
- fish autosuggestion: shown “in a muted gray color” after the cursor; → or Ctrl+F accepts, Alt+→/Alt+F
  accepts one word; Tab on ambiguity “opens a menu (the 'pager')” with descriptions, navigated with
  arrows/Tab/Shift-Tab (fish docs, 2026-09-20).
- bubbles textinput: `AcceptSuggestion: "tab"`, `NextSuggestion: "down","ctrl+n"`,
  `PrevSuggestion: "up","ctrl+p"`, suggestion text styled after the cursor (textinput.go, 2026-09-20).
  Textual Input: “right — Move the cursor right or accept the completion suggestion”
  (https://textual.textualize.io/widgets/input/, 2026-09-20). helix prompt: `Tab` next completion,
  `BackTab` previous (keymap.md). Claude Code: Tab “accepts the selected suggestion” (2026-09-20).

For slash commands the fish/bubbles model fits the height budget best: a dim ghost completion of the
best match after the cursor (0 extra rows), Tab/→ to accept, and a bounded list (≤ 6 rows, taken from
the decisions pane first, as the confirm preview already does in `computeLayout`) only while the
prefix is ambiguous.

---

## 7. Newlines, multi-line input and paste

- Newline keys in chat TUIs: opencode `input_newline: "shift+return,ctrl+return,alt+return,ctrl+j"`,
  `input_submit: "return"` (2026-09-20); Claude Code lists `\`+Enter, Option+Enter, Shift+Enter (with
  terminal setup) and Ctrl+J (interactive-mode, 2026-09-20; the multiline table was present in the
  fetched page but the fetch tool's excerpt cut it — rows for Ctrl+J and Shift+Enter are **partially
  verified**).
- Encodings (Measurement 1): kitty `CSI 13;2u` → `key.return && key.shift`; `\x1b\r` (Alt+Enter) →
  `key.return && key.meta`; `\n` (Ctrl+J) → `input === '\n'`; xterm `CSI 27;2;13~` → garbage text.
  kitty spec: Enter/Tab/Backspace “still generate the same bytes as in legacy mode” unless flag 8;
  modified versions use `CSI number ; modifier u`; supporters include “WezTerm, alacritty, foot,
  ghostty, iTerm2, Windows Terminal, and Rio” (https://sw.kovidgoyal.net/kitty/keyboard-protocol/,
  fetched 2026-09-20). xterm: with `modifyOtherKeys` = 2 “shift-Tab sends CSI 2 7 ; 2 ; 9 ~ rather than
  CSI Z” (ctlseqs.txt, 2026-09-20) — the same `CSI 27;mod;code~` shape Ink does not parse.
- Paste: xterm “When bracketed paste mode is set, the program will receive: ESC [ 2 0 0 ~ , followed
  by the pasted text, followed by ESC [ 2 0 1 ~” (`Ps = 2 0 0 4 -> Set bracketed paste mode`)
  (ctlseqs.txt, 2026-09-20). readline `enable-bracketed-paste` (default On) inserts “each paste into
  the editing buffer as a single string of characters” (Readline-Init-File-Syntax, 2026-09-20). Ink:
  `usePaste` (see §0). Claude Code pastes images as an `[Image #N]` chip (2026-09-20) — the analogous
  JevCode move is collapsing a pasted block > N lines into a `[pasted 42 lines]` chip in the composer
  while sending the full text.

---

## 8. Lists, tables, transcript navigation

Vim/neovim definitions (https://raw.githubusercontent.com/neovim/neovim/master/runtime/doc/motion.txt and
scroll.txt, fetched 2026-09-20): `gg` “Goto line [count], default first line”; `G` “Goto line
[count], default last line”; `j` synonyms `<Down> CTRL-J <NL> CTRL-N`; `k` synonyms `<Up> CTRL-P`;
`CTRL-D` “Scroll window Downwards … 'scroll' option (default: half a screen)”; `CTRL-U` half up;
`<PageDown>/CTRL-F` “Scroll window [count] pages Forwards”; `<PageUp>/CTRL-B` pages back.

| Component | up/down | page | half page | top/bottom |
| --- | --- | --- | --- | --- |
| bubbles viewport | `"up","k"` / `"down","j"` | `PageUp: "pgup","b"`; `PageDown: "pgdown","space","f"` | `HalfPageUp: "u","ctrl+u"`; `HalfPageDown: "d","ctrl+d"` | – (https://raw.githubusercontent.com/charmbracelet/bubbles/master/viewport/keymap.go) |
| bubbles list | `"up","k"` (help `↑/k`) / `"down","j"` | prev `"left","h","pgup","b","u"`; next `"right","l","pgdown","f","d"` | | `"home","g"` / `"end","G"` (list/keys.go) |
| lazygit | `prevItem: [<up>, k]`, `nextItem: [<down>, j]` | `prevPage: ','`, `nextPage: .`; main pane `scrollUpMain: [<pgup>, K, <ctrl+u>]`, `scrollDownMain: [<pgdown>, J, <ctrl+d>]` | | `gotoTop: [<, <home>]`, `gotoBottom: ['>', <end>]` (Config.md) |
| helix | `h j k l` + arrows | `Ctrl-b/PageUp`, `Ctrl-f/PageDown` | `Ctrl-u`, `Ctrl-d` | `gg`, `ge`/`G` (keymap.md) |
| tig | `Up/Down`, `j/k` | `ScrollBack/ScrollFwd` (page), `Insert`/`Delete` (one line) | – | (manual.adoc) |
| htop | `Up, Alt-k` / `Down, Alt-j`; `PgUp, PgDn`; `Home`/`End` | | | (htop.1.in) |
| opencode | `messages_page_up: "pageup,ctrl+alt+b"`, `messages_half_page_up: "ctrl+alt+u"`, `messages_first: "ctrl+g,home"`, `messages_last: "ctrl+alt+g,end"` | | | (keybinds doc) |
| Claude Code transcript viewer | `{` / `}` “Jump to the previous or next user prompt, like vim paragraph motion”; `q`, `Ctrl+C`, `Esc` exit | | | (interactive-mode) |

Transcript scrolling versus `<Static>`: JevCode commits transcript items to `<Static>` so the
*terminal's own scrollback* is the transcript viewer (DESIGN §10); Claude Code's `[` “Write the full
conversation to your terminal's native scrollback so `Cmd+F`, tmux copy mode, and other native tools
can search it” confirms native scrollback is what power users want. A separate scroll mode (vim keys,
`/` search) belongs to an opt-in *viewer* over the run's `transcript.log`, not to the live frame.

---

## 9. Search and filter

`/` starts a search everywhere: lazygit `startSearch: /`, `nextMatch: "n"`, `prevMatch: "N"`
(searching border colour `searchingActiveBorderColor: [cyan, bold]`); tig `/` “Search the view”, `?`
backwards, `n`/`N`; k9s `/filter⏎`, `/! filter⏎` inverse, `/-l` labels, `/-f` fuzzy; htop `F3, /`
incremental search and `F4, \` filter; glow `/` “find”; bubbles list `Filter: "/"`, `ClearFilter: "esc"`,
`AcceptWhileFiltering: "enter","tab","shift+tab","ctrl+k","up","ctrl+j","down"` (all 2026-09-20).
Esc clears the filter but does not quit (bubbles, glow, k9s).

---

## 10. Status bar layout

- helix defines three aligned zones: `left = ["mode", "spinner"]`, `center = ["file-name"]`,
  `right = ["diagnostics", "selections", "position", "file-encoding", "file-line-ending", "file-type"]`,
  `separator = "│"`, `mode.normal = "NORMAL"`… ; elements include `spinner`, `spacer`,
  `position-percentage`, `version-control`, `register`, `code-action-hint` (editor.md, 2026-09-20).
- lazygit: bottom “app status” line shows toasts and waiting spinners (`pkg/gui/controllers/helpers/app_status_helper.go`
  renders via `self.c.Views().AppStatus`, spinner rate `Gui.Spinner.Rate`; default frames
  `[●∙∙, ∙●∙, ∙∙●, ∙●∙]` at `rate: 180` ms) (2026-09-20).
- htop: permanent F-key bar (`--no-function-bar` to hide). Textual Footer: bindings left, palette key
  right. bubbles help: one line, ` • ` separators, truncated with `…`.
- Spinners (bubbles/spinner.go, 2026-09-20): `Line {"|","/","-","\\"}` 10 fps; `MiniDot`
  `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 12 fps; `Points {"∙∙∙","●∙∙","∙●∙","∙∙●"}` 7 fps; `Ellipsis {"",".","..","..."}` 3 fps
  (ASCII-safe). Progress (bubbles/progress.go): `DefaultFullCharHalfBlock = '▌'`,
  `DefaultEmptyCharBlock = '░'`, `PercentFormat: " %3.0f%%"`, `defaultWidth = 40`, `fps = 60`.

JevCode's status line already carries step/max, wall, tokens, cost, stage, spinner (DESIGN §10).
Zoning it helix-style — left `mode · stage · spinner`, centre `run-id / session title`, right
`step 3/40 · 02:14 · $0.41/2.00 · ? help` — keeps one row and gives the `?` hint a fixed home.
Use `<Spacer>` between zones and `wrap="truncate-middle"` on the centre.

---

## 11. Toasts and notifications

- Textual `notify(message, title='', severity='information', timeout=None)`, severities
  `"information" | "warning" | "error"`, `NOTIFICATION_TIMEOUT` 5 s; toasts render through a `ToastRack`
  with `-information/-warning/-error` classes (https://textual.textualize.io/api/app/ and
  /widgets/toast/, fetched 2026-09-20).
- lazygit `AddToastStatus`: “delay := lo.Ternary(kind == types.ToastKindError, time.Second*4, time.Second*2)”,
  error toasts `gocui.ColorRed`, others `gocui.ColorCyan`; the newest status wins the single bottom
  line (https://raw.githubusercontent.com/jesseduffield/lazygit/master/pkg/gui/status/status_manager.go,
  fetched 2026-09-20).
- k9s flash messages: **UNVERIFIED** (not on the commands/config pages fetched).

Under the height budget a toast cannot be a floating box; the lazygit model (toast text *replaces*
the status-line left zone for 2 s / 4 s for errors, with a `!`/`✓` marker) costs zero rows and no
clears. Anything the user must not miss (budget stop, sandbox degraded, spend > 80 %) should also be
a `<Static>` transcript item so it survives the toast.

---

## 12. Confirm dialogs and safe defaults

- clig.dev: “Confirm before doing anything dangerous” with three levels — mild (optional
  confirmation), moderate (prompt, offer dry-run), severe (“require typing the target name or
  `--confirm="name"` flag”); “Only use prompts or interactive elements if `stdin` is an interactive
  terminal”; “If `--no-input` is passed, don't prompt”; “Never _require_ a prompt” (https://clig.dev/,
  fetched 2026-09-20).
- Textual modal example: `Button("Quit", variant="error", id="quit")`,
  `Button("Cancel", variant="primary", id="cancel")` — destructive action styled as error, safe action
  as primary; `ModalScreen` dims the background and “Prevents unintended key bindings from the app”
  (https://textual.textualize.io/guide/screens/, fetched 2026-09-20).
- lazygit: `confirm: <enter>`, `return: <esc>`, warnings suppressible per class
  (`skipDiscardChangeWarning`, `skipStashWarning`, `skipAmendWarning`) (Config.md, 2026-09-20).
- k9s: `ctrl-d` “To delete a resource” (documented as requiring confirmation) versus `ctrl-k` “To kill a
  resource” immediately; `readOnly` disables all mutating commands (commands/config pages, 2026-09-20).
- Claude Code permission prompt: “On a permission prompt, `Esc` declines the action, the same as **No**
  without a comment”; Left/Right “Cycle through dialog tabs”; Tab opens a comment field on Yes/No
  (interactive-mode, 2026-09-20). Heroku style guide: prompts must always have a flag/arg bypass
  (https://devcenter.heroku.com/articles/cli-style-guide, fetched 2026-09-20).

JevCode's review prompt (risk 0.3–0.7, “no auto-approve”, README) is a *severe* confirmation by
clig's scale because it executes in the user's workspace: keep explicit `y`/`n`, make Enter act on
the *focused* option with **decline focused by default**, Esc = decline (Claude Code convention),
and never let a stale keypress approve: the current TUI Confirmer already declines a superseded
request rather than approving it (`createTuiConfirmer` in `useEngine.tsx`). Add `a` = approve and
show the risk dimension that triggered review in the box header so the reason is visible without
scrolling.

---

## 13. Colour conventions and colour-blind-safe design

- Semantics in the wild: Heroku — “Yellow and red are reserved for errors and warnings”, suggested
  palette “magenta, cyan, blue, green, and gray” (cli-style-guide, 2026-09-20). Textual base variables
  `$warning`, `$error`, `$success`, `$accent` (“Used sparingly to draw attention”), text tiers `$text`,
  `$text-muted`, `$text-disabled` (https://textual.textualize.io/guide/design/, 2026-09-20). lazygit
  `activeBorderColor: [green, bold]`, `unstagedChangesColor: [red]`, `searchingActiveBorderColor: [cyan, bold]`
  (Config.md). lazygit toasts cyan/red. JevCode DESIGN §10 already uses red = block, yellow = review /
  overridden / fallback, dim = ok/chosen.
- Never colour alone: WCAG 1.4.1 “Color is not used as the only visual means of conveying information,
  indicating an action, prompting a response, or distinguishing a visual element”; example “A form that
  uses color and text to indicate required fields” (https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html,
  fetched 2026-09-20). Okabe–Ito Color Universal Design palette: orange 230,159,0; sky blue
  86,180,233; bluish green 0,158,115; yellow 240,228,66; blue 0,114,178; vermilion 213,94,0; reddish
  purple 204,121,167; rule “do not use the combination of red and green. Use magenta (purple) and green
  instead” and add “shapes, patterns, or text labels” (https://jfly.uni-koeln.de/color/, fetched 2026-09-20).
- Disable/force: NO_COLOR — “when present and not an empty string (regardless of its value), prevents
  the addition of ANSI color”; “User-level configuration files and per-instance command-line arguments
  should override the `NO_COLOR` environment variable” (https://no-color.org/, fetched 2026-09-20).
  clig.dev: disable colour when not a TTY, `NO_COLOR`, `TERM=dumb`, `--no-color`. Node
  `getColorDepth` honours `NO_COLOR`/`NODE_DISABLE_COLORS`/`FORCE_COLOR` (Measurement 3); Ink's chalk
  honours `--no-color` and `FORCE_COLOR` but **not `NO_COLOR`** (§0), so `bin/jevcode.js` must map
  `NO_COLOR` → `process.env.FORCE_COLOR = '0'` before importing the bundle (chalk reads env at module
  init), unless `FORCE_COLOR` is already set (the no-color.org precedence rule).

Rule set for JevCode: every coloured token carries a marker or word — `✗ block`, `! review`,
`✓ ok`, `~ overridden`, `↩ fallback`; ASCII fallbacks `x ! + ~ <`. Red/yellow/green from the ANSI
16 palette (user-themed, honours light/dark) rather than truecolor hexes; dim for secondary.
Prefer red-vs-blue/cyan contrasts over red-vs-green for paired states (risk ↔ safe) per Okabe–Ito.

---

## 14. Light vs dark background

- termenv (used by lipgloss/glow) queries `OSC 11 ; ? ST` (`o.termStatusReport(11)`), refuses under
  `TERM` starting `screen`/`tmux`/`dumb` (“screen/tmux can't support OSC, because they can be connected
  to multiple terminals concurrently”), falls back to `COLORFGBG` (“splits on ';' and uses the last
  value as an ANSI colour index”), defaults to `ANSIColor(0)`, and decides dark by HSL lightness
  `return l < 0.5` (https://raw.githubusercontent.com/muesli/termenv/master/termenv_unix.go and
  output.go, fetched 2026-09-20). `OSCTimeout = 5 * time.Second` for the reply. xterm: for OSC 11
  “If a "?" is given rather than a name or RGB specification, xterm replies with a control sequence of
  the same form” (ctlseqs.txt, 2026-09-20).
- lipgloss `LightDark(hasDarkBG)(lightColor, darkColor)` and colour downsampling “to the best available
  profile” (https://raw.githubusercontent.com/charmbracelet/lipgloss/master/README.md, 2026-09-20);
  glow “tries to detect your terminal's current background color and automatically picks either the
  dark or the light style” (glow README, 2026-09-20). Textual `textual-dark`/`textual-light` themes;
  k9s `invert: false # Invert dark/light theme` (2026-09-20).

For JevCode the safest path is *not to need the answer*: use only the terminal's ANSI 16 named colours
and `dimColor`, never set backgrounds, and never draw light-on-light hexes. If a detection is added,
send `\x1b]11;?\x1b\\` **after the first frame** (zero-network/zero-blocking budget), read the reply
from the same stdin stream Ink owns (it arrives as an `OSC` chunk that `parse-keypress` will not
name — filter `^\x1b\]11;` before it reaches the composer), time out at ~100 ms, skip under
`TMUX`/`STY`/`TERM=dumb`, and honour `COLORFGBG` as termenv does. **UNVERIFIED**: whether Ink's
`input-parser.js` holds an OSC reply as “pending” or emits it as text — its CSI/SS3 parser has no OSC
branch (read 2026-09-20), so the reply would be delivered as a raw string; test in a real pty first.

---

## 15. Box drawing and Unicode fallbacks

- `is-unicode-supported` (sindresorhus): on non-Windows `return TERM !== 'linux'; // Linux console (kernel)`;
  on Windows true for `WT_SESSION`, `TERMINUS_SUBLIME`, `ConEmuTask === '{cmd::Cmder}'`,
  `TERM_PROGRAM === 'Terminus-Sublime' | 'vscode'`, `TERM === 'xterm-256color' | 'alacritty' |
  'rxvt-unicode' | 'rxvt-unicode-256color'`, `TERMINAL_EMULATOR === 'JetBrains-JediTerm'`
  (https://raw.githubusercontent.com/sindresorhus/is-unicode-supported/main/index.js, fetched 2026-09-20).
- fzf `--no-unicode` “substitutes ASCII alternatives for drawing characters”; htop `-U --no-unicode: Do
  not use unicode but ASCII characters for graph meters`; btop `--force-utf` “Override automatic UTF
  locale detection”, `-t, --tty` “Force tty mode with ANSI symbols and 16 colors”, `graph_symbol:
  "braille", "block" or "tty"`, `rounded_corners … ignored if TTY mode is ON`; lazygit
  `border: rounded` (rounded, single, double, hidden, bold), `nerdFontsVersion: ""` (“empty disables
  icons”); k9s `noIcons` “Toggles icons display as not all terminal support these chars”
  (all 2026-09-20). Ink `borderStyle="classic"` is the ASCII border (readme, 2026-09-20).
- Locale: JevCode's sandbox passes `LANG` through (README “Sandbox guarantees”), and the reference machine
  reports `LANG=C.UTF-8`; the composite rule should be `unicode = !(TERM==='linux') && /utf-?8/i.test(LC_ALL||LC_CTYPE||LANG||'')`
  on POSIX, the is-unicode-supported allow-list on Windows, overridable with `--ascii`/`JEVCODE_ASCII=1`.

Glyph table (unicode → ASCII): rule `─` → `-`; spinner MiniDot → `Line`/`Ellipsis`; markers
`✓ ✗ ! ~ ↩ …` → `+ x ! ~ < ...`; borders `round` → `classic`; progress `▌░` → `#-`; pointer `▌` →
`>`; separators `│` → `|`, ` • ` → ` | `.

---

## 16. CLI guideline documents mapped to `src/cli/args.ts`

- GNU: “All programs should support two standard options: ‘--version’ and ‘--help’”; “Please define
  long-named options that are equivalent to the single-letter Unix-style options”; `--help` “should
  output brief documentation for how to invoke the program, on standard output, then exit
  successfully”; `--version` prints “name, version, origin and legal status, all on standard output”
  (https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces.html via curl and
  https://www.gnu.org/prep/standards/standards.html, fetched 2026-09-20; the dedicated `--help` page
  returned 429/timeouts on three attempts).
- POSIX Utility Syntax Guidelines: “Utility names should be between two and nine characters”; “Each
  option name should be a single alphanumeric character”; “Each option and option-argument should be a
  separate argument”; “All options should precede operands on the command line”; `--` ends options;
  `-` operand means stdin/stdout; `[ ]` optional, `...` repetition, `|` alternatives
  (https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html, fetched 2026-09-20).
- clig.dev (2026-09-20): help on `-h`/`--help`; “Lead with examples”; “If the user did something wrong
  and you can guess what they meant, suggest it”; stdout for output, stderr for messaging; “Return zero
  exit code on success, non-zero on failure”; `--json`, `--plain`; “Use standard names for flags”
  (`-a/--all -d/--debug -f/--force --json -h/--help -n/--dry-run --no-input -o/--output -p/--port
  -q/--quiet -u/--user --version`); “Show progress if something takes a long time”; “Make things time
  out”; “Suggest commands the user should run”.
- Heroku CLI style guide (2026-09-20): “Flags are preferred to args”; “Stdout should be used for all
  output and stderr for warning, errors and out of band information”; “Human-readable output should be
  grep-parseable”; `--json`; “Color can be disabled by the user by adding `--no-color`, setting
  `COLOR=false`, or when the output is not a tty”; prompts need flag bypasses.
- 12-Factor CLI Apps (Jeff Dickey, Medium): **UNVERIFIED** — https://medium.com/@jdxcode/12-factor-cli-apps-dd3c227a0e46
  returned HTTP 403 to the fetch tool and a 5 KB bot-block page to curl with a browser UA;
  web.archive.org is blocked for the tool. The Heroku style guide above (same author/organisation) is
  used in its place.

Where `args.ts` (read 2026-09-20) already complies: `-h/--help`, `-v/--version`, `--help` to stdout
exit 0 (`main.tsx`), usage error → stderr + exit 2, strict `parseArgs`, `--plain`, `--json` on
`config`, `--resume`, long names for every flag, exit-code table in README. Gaps: no `--no-color`
(chalk would honour it, but strict `parseArgs` rejects it), no `--no-input` (clig; equals “decline
every review, never wait”), no `-q/--quiet`, `-n/--dry-run`, no `jevcode run` bare → interactive
composer (today it fails with “missing task text”), `--version` prints one line (GNU wants origin/
licence too; keep one line, add `--version --json`?). `usageText()` does not lead with examples.

---

## 17. Proposed JevCode keymap sheet

Notation: `C-` Ctrl, `M-` Alt/Option (Esc-prefixed), `S-` Shift. “Ink” column says how the key
arrives (Measurement 1). Contexts nest: **Global** applies always; **Composer** when the prompt has
focus (default); **Review** while `confirm:request` is pending (takes precedence over Composer);
**Palette**/**Help**/**Picker** are modal overlays that consume every key until closed.

### 17.1 Global

| Key | Action | Ink | Rationale / precedent |
| --- | --- | --- | --- |
| `C-c` (1st) | Interrupt the running step (`engine.abort` is too coarse — add `engine.interrupt()` → steer); if idle and composer non-empty, clear composer (save draft to history) | `ctrl && input==='c'` | Claude Code, opencode `input_clear`, clig “exit as soon as possible” |
| `C-c` (2nd within 1.5 s, or when idle+empty) | `human_abort`: checkpoint, exit 130 | same | Claude Code double-press; clig “press Ctrl+C again to force”; README exit codes |
| `C-d` on empty composer | Exit hint on 1st press, exit on 2nd within 800 ms | `ctrl && input==='d'` | readline EOF; Node readline; Claude Code 800 ms |
| `?` on empty composer | Toggle help overlay | `input==='?'` | lazygit/k9s/glow/bubbles/Claude Code |
| `F1` | Same as `?` (works when composer has text) | `name f1` | htop `F1, h, ?`; gitui vim-style `open_help: F(1)` |
| `C-l` | Redraw (re-emit the dynamic frame; never `\x1b[2J`) | `ctrl && 'l'` | readline `clear-screen`; Claude Code “Forces a full terminal redraw” |
| `Esc` | Close overlay → cancel palette → decline review → (idle) no-op | `key.escape` (20 ms flush) | universal “back” |
| `Esc Esc` | Clear composer, keep draft in history; if empty open steering menu | `escape && meta` or two Esc < 300 ms | Claude Code |
| `C-o` | Toggle decisions detail view (last 12 → full per-step decision list, in an overlay pane) | `ctrl && 'o'` | Claude Code `Ctrl+O` transcript viewer |
| `C-z` | Not bound; let the tty suspend (raw mode swallows it — document that `C-z` is unsupported) | `ctrl && 'z'` | Node readline note “Moves running process into background” |

### 17.2 Composer (single/multi-line prompt, readline-compatible)

| Key | Action | Ink |
| --- | --- | --- |
| `Enter` | Submit (task, steering message, or slash command) | `key.return && !shift && !meta && !ctrl` |
| `S-Enter` (kitty), `M-Enter`, `C-j`, `\`+`Enter` | Insert newline | `return&&shift` / `return&&meta` / `input==='\n'` / trailing backslash |
| xterm `CSI 27;2;13~` / `CSI 27;5;13~` | Treat as newline; swallow the text | detect `input` matching `/^\[27;[2-8];13~$/` |
| `C-a` `Home` / `C-e` `End` | Line start / end (logical line in multi-line) | ctrl letter / `key.home|end` |
| `C-b` `←` / `C-f` `→` | Char back / forward; `→` at end accepts ghost suggestion | |
| `M-b` `C-←` / `M-f` `C-→` | Word back / forward | `meta&&'b'`, `ctrl&&leftArrow` |
| `C-k` / `C-u` | Kill to end / to start of line (kill ring) | |
| `C-w` `M-Backspace` | Kill word back (whitespace-delimited like readline `unix-word-rubout`) | `ctrl&&'w'`, `backspace&&meta` |
| `M-d` `M-Delete` `C-Delete` | Kill word forward | |
| `C-y` / `M-y` | Yank / cycle kill ring | |
| `C-t` | Transpose chars | |
| `C-_` | Undo (Node/Claude Code convention; byte `0x1f`) | `input==='\u001f'` |
| `Backspace` / `Delete`, `C-d` (non-empty) | Delete back / forward | |
| `↑`/`↓` | Move within multi-line; at first/last row → history prev/next | `upArrow/downArrow` |
| `C-p` / `C-n` | History prev / next (always) | |
| `C-r` | Reverse-incremental history search (fzf-style overlay, `C-r` again toggles sort) | |
| `Tab` / `S-Tab` | Accept suggestion / cycle completions; `S-Tab` cycle back | `key.tab`, `tab&&shift` |
| `/` at column 0 (empty) | Open palette pre-filled with `/` | |
| `C-/` | Open palette (kitty `47;5u` or legacy `0x1f` when configured) | `ctrl&&'/'` or `\u001f` (conflicts with undo → prefer `/`) |
| `@` | File-path completion (workspace-scoped, respects secret-file denylist) | |
| `!` at column 0 | Run a shell command through the sandbox and add its output as context | |
| Paste | `usePaste` → insert as one unit; > 12 lines collapse to `[pasted N lines]` chip | bracketed paste |

### 17.3 Review prompt (risk 0.3–0.7)

| Key | Action | Precedent |
| --- | --- | --- |
| `n`, `Esc` | Decline (default focus) | Claude Code Esc=No; Textual Cancel=primary |
| `y`, `a` | Approve | JevCode existing `y`; k9s ctrl-d confirms |
| `Enter` | Act on focused option (decline unless moved) | lazygit `confirm: <enter>` |
| `←`/`→`, `Tab` | Move focus between `[decline] [approve]` | Claude Code Left/Right |
| `d` | Show full diff/command preview (scrollable, `j/k`, `q` back) | tig/lazygit `d` conventions |
| `e` | Explain: expand the four risk dimensions with probabilities | Decisions view |
| `s` | Steer: decline *and* open composer with a prefilled “instead, …” message | JevCode-specific |
| never | Auto-approve on timeout (TUI); non-TTY declines after `confirmTimeoutMs` (existing) | README |

### 17.4 Palette / pickers (`/` commands, sessions, models)

`↑`/`C-p`/`C-k` up, `↓`/`C-n`/`C-j` down (fzf, helix picker), `PgUp/PgDn` page, `Enter` accept,
`Tab` accept-and-keep-editing args, `Esc`/`C-c` close, type to fuzzy-filter (Textual/fzf), empty
query shows `discover()`-style list of all commands with one-line descriptions and their key
aliases (Textual). Layout fzf `--layout=reverse` (prompt on top) inside the dynamic region, max 8 rows.

Slash commands to expose (each also a flag or env for scripting — clig “Never require a prompt”):
`/help`, `/keys`, `/new`, `/resume <id>`, `/sessions`, `/steer <text>` (queue for next step),
`/pause`, `/continue`, `/stop`, `/plan`, `/decisions [step]`, `/config`, `/model`, `/mode
jev-on|jev-off|jev-only`, `/budget spend|steps|wall`, `/export`, `/plain`, `/quit`.

### 17.5 Help overlay

Opened by `?`/`F1`; `?`/`Esc`/`q` close; `j/k`/`↑↓`/`PgUp/PgDn` scroll; `/` filters rows; grouped
by context (Global, Composer, Review, Palette, Transcript viewer) — bubbles `FullHelp` columns;
generated from `keymap.ts`, including per-terminal notes (“Shift+Enter needs kitty protocol; use
Ctrl+J”, “Option as Meta on macOS”). Status-line right zone shows the ShortHelp for the current
context: idle `? help · / commands · C-c quit`; running `Esc/C-c interrupt · C-o decisions`; review
`y approve · n decline · d diff · s steer`.

### 17.6 Transcript / decisions viewer (opt-in overlay over the committed items)

`j/k` `↑↓`, `C-d/C-u` half page, `C-f/C-b` `PgDn/PgUp` page, `g`/`gg`/`Home` top, `G`/`End` bottom,
`{`/`}` previous/next user prompt, `/` search + `n`/`N`, `[` write full transcript to native
scrollback (Claude Code), `v` open `transcript.log` in `$VISUAL`/`$EDITOR`, `q`/`Esc` back.

---

## ADOPT

| What JevCode should do | Why | Source |
| --- | --- | --- |
| One typed `keymap.ts` table → dispatcher, `?` overlay, status-line ShortHelp, `jevcode keys`, `docs/KEYS.md`; test asserts docs regenerate cleanly | Single source of truth; docs cannot drift | lazygit `pkg/cheatsheet/generate.go` + “auto-generated” notice; bubbles `KeyMap`/`help.go`; Textual Footer (all 2026-09-20) |
| Readline-exact composer bindings (C-a/e/b/f/k/u/w/y, M-b/f/d, M-Backspace, C-←/→, C-p/n, C-r, C-t, C-_) | Every reference input agrees; power-user muscle memory | bash manual Commands-For-Moving/Text; rluserman; Node readline table; helix prompt; bubbles textarea/textinput; fish; Claude Code |
| Ctrl+C: interrupt → clear → exit on second press; Ctrl+D on empty = exit with 800 ms confirm hint; Esc = back/decline | Chat TUIs converged; clig; existing exit-130 semantics | Claude Code, opencode, clig.dev, readline `end-of-file` |
| `?` (empty composer) and `F1` open help; two-level help (status-line short / overlay full) | Universal convention; fits `rows − 2` budget | lazygit, k9s, glow, htop `F1 h ?`, bubbles help, Claude Code `?` |
| Palette on `/` (empty composer), not Ctrl+K / Ctrl+P | Ctrl+K = kill-line, Ctrl+P = history in every readline; Ctrl+Shift+P unparseable without kitty | §3 conflict analysis; Measurement 1 |
| Newline via kitty `S-Enter`, `M-Enter`, `C-j`, and `\`+Enter; swallow xterm `CSI 27;mod;13~` | Only kitty S-Enter parses in Ink 7.1.1; xterm form leaks text | Measurement 1; kitty protocol doc; ctlseqs.txt |
| Enable `render({ kittyKeyboard: { mode: 'auto' } })` after verifying first-frame cost | Disambiguates Esc/Alt/Shift+Enter; 200 ms query is async and harmless elsewhere | ink.js `confirmKittySupport` (read 2026-09-20) |
| `usePaste` in the composer; collapse big pastes to a chip | Bracketed paste is standard; keeps the frame small | ink use-paste.js; xterm 2004; readline `enable-bracketed-paste` On; Claude Code chips |
| Review prompt: decline focused by default, `Esc` declines, `Enter` acts on focus, add `a`/`d`/`e`/`s` | Severe-level confirmation per clig; safe default | clig.dev; Textual QuitScreen variants; Claude Code Esc=No |
| Marker + word with every colour; ANSI-16 named colours only; no backgrounds; red↔cyan/blue pairs | Colour-blind safety and light/dark neutrality without detection | WCAG 1.4.1; Okabe–Ito; Heroku “yellow and red reserved”; Textual `$text-muted` |
| Honour `NO_COLOR` by setting `FORCE_COLOR=0` in `bin/jevcode.js` when `NO_COLOR` is non-empty and `FORCE_COLOR` unset; add `--no-color` to `FLAGS` | Ink's chalk 5.6.2 ignores `NO_COLOR`; strict `parseArgs` rejects unknown `--no-color` | grep of node_modules (2026-09-20); no-color.org precedence; Node tty docs |
| Unicode gate: `TERM!=='linux'` && UTF-8 locale on POSIX, allow-list on Windows; `--ascii` override; glyph table incl. `borderStyle="classic"` | Proven heuristics; ASCII fallbacks keep the layout identical | is-unicode-supported; fzf `--no-unicode`; htop `-U`; btop `--force-utf`; Ink readme |
| Helix-style 3-zone status line with `<Spacer>` and `truncate-middle`; toasts replace the left zone for 2 s (4 s errors) and also land in `<Static>` | Zero extra rows, zero clears | helix `[editor.statusline]`; lazygit `AddToastStatus`; Textual `notify` severities |
| Transcript lives in native scrollback (`<Static>`); vim-key viewer only as opt-in overlay over `transcript.log` | Preserves the zero-clear invariant; matches power-user expectations | DESIGN §10; Claude Code `[` to native scrollback |
| Add `--no-input` (decline all reviews, never wait), `-q/--quiet`, examples-first `--help`, `jevcode run` with no task → composer | clig standard flags; “Lead with examples”; GNU `--help` | clig.dev; GNU standards; Heroku style guide |
| Prompt history per workspace under `~/.jevcode`, deduplicated, redacted before write | Users paste secrets; README key-hygiene rule | README; Node readline `removeHistoryDuplicates`; fzf history dedupe |

## REJECT

| What not to do | Why |
| --- | --- |
| Bare `q` to quit | It is a letter in a composer; only browse-only TUIs (lazygit, tig, htop, glow) can afford it |
| Ctrl+K or Ctrl+P as the command palette | Break readline kill-line / previous-history (bash manual, Node table, fzf, helix, bubbles, Claude Code) |
| Ctrl+Shift+P, Ctrl+Space, Ctrl+H as distinct bindings | Not distinguishable in legacy parsing: no shift bit on Ctrl+letter; `\x00` mis-named `` ` ``; `\x08` = backspace (Measurement 1; Textual note) |
| Relying on Shift+Enter alone for newlines | Unparsed outside kitty; xterm `modifyOtherKeys` form injects `[27;2;13~` (Measurement 1) |
| A leader key (opencode `ctrl+x`) | Ctrl+X is already a readline prefix (Claude Code documents `Ctrl+X Ctrl+E` as “the readline-native binding” and `Ctrl+X Ctrl+K`); the 2 s `leader_timeout` adds an ambiguity window; JevCode has few enough commands for `/` |
| Alternate screen (`render({ alternateScreen: true })`) | Kills native scrollback (“The terminal's scrollback buffer is not available while in the alternate screen”, Ink readme) and contradicts the `<Static>` design |
| Floating toast boxes / modal dialogs that grow the dynamic region | Any frame taller than `rows − 2` triggers Ink's clear-terminal path (DESIGN §10, research 01) |
| Truecolor hex palettes and coloured backgrounds | Light/dark and 16-colour terminals; termenv/lipgloss downsample but Ink hexes need `getColorDepth` gating; ANSI-16 names inherit the user's theme |
| Colour-only state (green ok / red block) | WCAG 1.4.1; ~1 in 12 males red–green deficient (Okabe–Ito page) |
| Synchronous OSC 11 background query at launch | Blocks first frame; unsupported under tmux/screen (termenv guard); reply would land in the composer as text |
| `Ctrl+C` exits immediately | Loses steering and the “clear composer” affordance; every chat TUI double-presses; k9s even offers `noExitOnCtrlC` |
| Auto-approve reviews on timeout in the TUI | README: “no auto-approve”; clig severe confirmations |
| Emoji/Nerd Font icons by default | k9s `noIcons`, lazygit `nerdFontsVersion: ""` default off; width measurement and font risk; use ASCII-safe markers |
| Vim modal editing in the composer by default | Claude Code ships it as an opt-in mode; readline emacs is the default everywhere else |

## OPEN QUESTIONS

1. **Kitty auto-detection vs first-frame budget**: Ink writes `CSI ? u` at init and waits 200 ms;
   does the query byte or the reply interfere with the perf harness's `script`-based first-frame
   measurement (`perf/first-frame.ts` looks for the `step 0/` sentinel)? Needs a measured run at
   rows 40 / rows 12 before adoption.
2. **OSC 11 reply routing**: Ink's `input-parser.js` has no OSC branch (read 2026-09-20); a background
   query reply will reach `useInput` as raw text. Either filter `^\x1b\]11;` in the composer or drop
   detection entirely (the ANSI-16 rule removes the need). Test in a real pty.
3. **Engine API for steering/interrupt**: `Engine.abort(reason)` exists; a non-fatal
   `interrupt()`/`steer(text)` that ends the current step, checkpoints, and injects the message into the
   next step's window is required for the first-Ctrl+C and `/steer` semantics (§17.1; DESIGN §6 not
   re-read for this note).
4. **Composer height under `rows − 2`**: how many composer rows to reserve (proposal: 1 growing to 5,
   then internal scroll) and which pane yields first — extend `computeLayout()`'s allocation order
   (status, rule, live, composer, confirm, decisions).
5. **Ctrl+/ encoding**: legacy terminals send `0x1f` for Ctrl+/ (same byte as Ctrl+_ undo). Bind
   `0x1f` to undo (readline/Node/Claude Code) and give the palette only `/`, or detect kitty and bind
   `CSI 47;5u`? Recommend the former.
6. **Alt on macOS**: Option-as-Meta is off by default in Terminal.app/iTerm2 (Claude Code note); should
   the help overlay detect `TERM_PROGRAM` and show the setup hint, and should `Esc` followed by a
   letter within Ink's 20 ms flush window be treated as Meta (it already is when bytes arrive together)?
7. **`--version` content**: GNU wants name/version/origin/licence on stdout; clig wants `--version`;
   keep the current one-liner and add `--json`? Decide with packaging research (research 05/08).
8. **History persistence and redaction**: file format (JSONL with timestamps and workspace hash?),
   size cap (Node readline default 30 is too small; fzf users expect thousands), and whether
   `/steer` messages are historised separately from task prompts.
9. **12-Factor CLI Apps** could not be fetched (403/bot-block/archive blocked); if a reviewer has the
   text, check the “be speedy” thresholds against our 300 ms first-frame gate.
10. **Gemini CLI shortcuts** (`docs/cli/keyboard-shortcuts.md`) returned 404 and the GitHub API listing
    403; not needed for the design but would add a third data point on Ctrl+C/Ctrl+D double-press timing.
