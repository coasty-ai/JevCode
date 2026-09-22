# 04 — OpenAI Codex CLI (Rust/ratatui TUI): what to take for a Node + Ink chat UI

Research for the JevCode interactive TUI (composer, slash commands, sessions, steering, review
prompts, Jev-native decisions view). Fetched 2026-09-20. Every claim carries its source and the
fetch date. Nothing in the repo other than this file was modified.

**Source conventions used below**

- `RAW` = `https://raw.githubusercontent.com/openai/codex/2426ed7684c87f9a627c60b54271cfed77c979df`
  — the `main` HEAD of https://github.com/openai/codex on 2026-09-20 (`pushed_at
  2026-09-20T17:37:03Z`, 125,493 stars, default branch `main`; https://api.github.com/repos/openai/codex,
  fetched 2026-09-20). Line numbers are from these pinned files, downloaded with `curl` to
  `/tmp/codex-research/src/` and read with `sed -n`. `≈L` marks a line computed from a relative
  grep offset rather than read directly.
- `TS` = `https://raw.githubusercontent.com/openai/codex/rust-v0.2.0/codex-cli/` — the last tag at
  which the TypeScript/Ink implementation still existed (tags `rust-v0.2.0`, `rust-v0.5.0`,
  `rust-v0.10.0` return 200 for `src/cli.tsx`; `rust-v0.20.0` returns 404; fetched 2026-09-20).
- `INK` = `<repo>/node_modules/ink/build/` (ink 7.1.1 as
  installed; read 2026-09-20). Prior notes on Ink itself: `docs/research/01-ink-stack.md`.
- Directory listings came from `https://api.github.com/repos/openai/codex/contents/codex-rs/tui/src`
  (and subdirectories) fetched 2026-09-20 before the unauthenticated rate limit was hit; after that,
  only `raw.githubusercontent.com`, `github.com` HTML and `registry.npmjs.org` were used.

---

## 1. History: why Codex left TypeScript + Ink (quoted)

**Announcement.** Discussion #1174 "Codex CLI is Going Native", fouad-openai, 2025-05-30
(https://github.com/openai/codex/discussions/1174, HTML fetched 2026-09-20):

> "If you're a TypeScript developer like me, you're probably wondering why would we do this.
> High-level: we want to use the best tool for the job. While Codex CLI ships with a neat terminal
> UI, which has been easy to whip up and iterate with React-based ink — the core of this project is
> an "agentic" harness, aka calling the model in a loop. Our goal is to make the software pieces as
> efficient as possible and there were a few areas we wanted to improve:
> Zero-dependency Install — currently Node v22+ is required, which is frustrating or a blocker for
> some users
> Native Security Bindings — surprise! we already ship a Rust for linux sandboxing since the
> bindings were available
> Optimized Performance — no runtime garbage collection, resulting in lower memory consumption
> Extensible Protocol — we've been working on a "wire protocol" for Codex CLI to allow developers to
> extend the agent in different languages (including Type/JavaScript, Python, etc) and MCPs (already
> supported in Rust)"

Note what is *not* in the list: the TUI. The stated reasons are install friction (Node 22),
sandboxing bindings, GC/memory, and a wire protocol. Secondary coverage repeats the same four
points and adds nothing about flicker or startup (InfoQ 2025-06-04, Bruno Couriol,
https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite/; devclass 2025-06-02, Tim
Anderson, https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589;
both fetched 2026-09-20).

**Cutover burndown.** Issue #1262 "Rust CLI Cutover (Burndown List)"
(https://github.com/openai/codex/issues/1262, fetched 2026-09-20) lists the P1 TUI parity items the
Rust TUI had to reach: "Hitting Ctrl+C once should interrupt the model and give you a chance to
redirect it #1244", "Hitting Ctrl+C twice should exit the TUI #1245", "Improve Markdown rendering
#1246", "Improve copy/paste in the Rust TUI, or at least make the existing solution more
discoverable #1247", "Support the /model command #1251", "Support the /approval command #1252",
"Support the /diff command #1253"; P2: "Implement session management, which entails browsing and
resuming sessions. #1255", "Support the /compact command #1257", "Support @ for fuzzy file search
#1261".

**TypeScript-era TUI problems that are on record** (all fetched 2026-09-20):
- #355 "bug: resizing terminal leads to bad artifacts" (v0.1.2504172351, macOS): "Cascading 'send
  message' input field rendering on resizing" — the classic Ink erase-N-lines-after-rewrap failure
  (https://github.com/openai/codex/issues/355).
- #1080 "codex CLI fails in CI environments (GitHub Actions) due to Ink raw mode error, even with
  --quiet, CODEX_QUIET_MODE=1, and --no-terminal" (https://github.com/openai/codex/issues/1080);
  #1208 same class for Jupyter (title from https://api.github.com/search/issues?q=repo:openai/codex+ink+created:2025-04-01..2025-06-30).
- The TS code itself: `TS/src/utils/terminal.ts` L41–55 `clearTerminal()` calls `inkRenderer.clear()`
  and then writes `"\x1b[3J\x1b[H\x1b[2J"` with the comment "avoid unnecessary clears on every render
  to minimise flicker"; L57–84 `onExit()` explains that skipping `unmount()` "leaves the terminal in
  raw-mode after the Node process has exited which looks like a 'frozen' shell".
  `TS/src/components/chat/terminal-chat.tsx` L400–403: "Dynamic layout constraints – keep total
  rendered rows <= terminal rows" using `useTerminalSize()` — the same height budget JevCode §10
  already has. `TS/src/components/chat/terminal-message-history.tsx` L47: `<Static
  items={["header", ...messages]}>`. `TS/package.json`: `"ink": "^5.2.0"`, `"react": "^18.2.0"`,
  `"engines": {"node": ">=22"}`, plus 22 other runtime deps (`openai`, `express`, `marked-terminal`,
  `zod`…). `TS/src/cli.tsx` L599–611: `render(<App …/>, { patchConsole: process.env["DEBUG"] ? false
  : true })`.
- TS-era keys: `TS/src/components/chat/terminal-chat-input.tsx` L459–464: Ctrl+C →
  `setTimeout(() => { app.exit(); onExit(); process.exit(0); }, 60)`; L968–984: Esc required two
  presses within 1.5 s ("We require two presses within a short window (1.5s) to avoid accidental
  cancellations"). The Rust TUI replaced both (see §6).

**Packaging then and now** (https://registry.npmjs.org/@openai/codex, fetched 2026-09-20):
- 0.1.4160940 (2025-04-16): 17 `dependencies`, `unpackedSize` 12.87 MB. 0.1.2505172129 (published
  2025-05-18 UTC, the last build before native binaries appeared): 24 deps, 18.16 MB. 0.1.2505191453
  (2025-05-19): 79.39 MB (the jump when native binaries were bundled — inference from size, not
  stated). 0.20.0 (2025-08-09): first version with zero `dependencies`, 87.7 MB.
- Latest 0.155.1: `unpackedSize` **13,206 bytes**, `fileCount` 3, `bin: {"codex": "bin/codex.js"}`,
  `type: module`, `engines: {"node": ">=16"}`, and six `optionalDependencies`
  (`@openai/codex-darwin-arm64` = `npm:@openai/codex@0.155.1-darwin-arm64`, `-darwin-x64`,
  `-linux-x64`, `-linux-arm64`, `-win32-x64`, `-win32-arm64`). `RAW/codex-cli/bin/codex.js` L16–23
  maps `process.platform/arch` → target triple → platform package; L84–95 resolves
  `<pkg>/vendor/<triple>/bin/codex`; the comment at the spawn site: "Use an asynchronous spawn
  instead of spawnSync so that Node is able to respond to signals (e.g. Ctrl-C / SIGINT) while the
  native binary is executing."

---

## 2. Architecture of the Rust TUI at HEAD (numbers)

Crate `codex-tui` (`RAW/codex-rs/tui/Cargo.toml`, fetched 2026-09-20). Workspace pins:
`ratatui = { version = "0.30.2", default-features = false, … }` (workspace `Cargo.toml` L419),
`crossterm = "0.29.0"` (L351) **patched** to `https://github.com/openai-oss-forks/crossterm` rev
`45fecb95…` (L625); `nucleo` (fuzzy matcher, git rev, L401); `arboard = "3"` (clipboard, L318);
`image` (L379); `supports-color = "3.0.2"` (L483); `syntect = "5"` (L484). PR #1685 "fix: correctly
wrap history items" (nornagon-openai, 2025-07-26): "Had to patch ratatui to expose
set_viewport_area … Ideally I think this feature should be upstreamed into ratatui"
(https://github.com/openai/codex/pull/1685, fetched 2026-09-20) — the inline viewport needed a
forked renderer from day one.

File sizes (lines, `wc -l` on the pinned downloads): `bottom_pane/chat_composer.rs` 13,036;
`bottom_pane/textarea.rs` 4,619; `keymap.rs` 4,075; `bottom_pane/mod.rs` 3,884; `lib.rs` 3,957;
`diff_render.rs` 2,745; `bottom_pane/approval_overlay.rs` 2,517; `chatwidget.rs` 2,131; `tui.rs`
1,445; `custom_terminal.rs` 1,395; `insert_history.rs` 1,250; `app.rs` 1,184; `wrapping.rs` 2,096.
`resume_picker.rs` is 251,988 bytes (directory listing). The composer alone is larger than all of
`src/tui/` in JevCode.

**Event model.** `RAW/codex-rs/tui/src/tui.rs` L570–604 `pub enum TuiEvent { Key(KeyEvent),
Paste(String), Mouse(MouseEvent), Resize(Size), Draw, Resume, FocusGained, FocusLost }` with doc
"Resize is separate from `Draw` so the app can run feature-gated pre-render logic" and "`Resume`:
The first repaint after returning from process suspension … resize events are not delivered while
the process is suspended". Draw requests go through `FrameRequester` (`tui/frame_requester.rs`
L1–13: "coalesces many requests into a single notification on a broadcast channel … actor-style
design") clamped by `tui/frame_rate_limiter.rs` L12–13: `MIN_FRAME_INTERVAL: Duration =
Duration::from_nanos(8_333_334)` ("A 120 FPS minimum frame interval"). Every frame is wrapped in
`stdout().sync_update(|_| { … })` (tui.rs L1172, L1322) — DEC 2026 synchronized output, the same
`\x1b[?2026h/l` Ink 7 emits (`INK/write-synchronized.js`: `bsu = '\u001B[?2026h'`, `esu =
'\u001B[?2026l'`).

**Input plumbing.** `tui/event_stream.rs` L11–17: the crossterm `EventStream` is dropped and
recreated around terminal handoffs because "it will continue to read from stdin even if it is not
actively being polled … potentially stealing input from other processes reading stdin, like
terminal text editors". Startup probes (`terminal_probe.rs` L1–12) bound cursor-position/colour/kitty
queries to `DEFAULT_TIMEOUT … 250` ms (L24) because "Crossterm's public helpers wait up to two
seconds". `tui/input_boundary.rs` L24–28 drains pending input "before a screen can accept a
security-sensitive decision" (approval prompts cannot be answered by a stray keystroke).

---

## 3. The inline viewport + scrollback history (the core design)

**Statement of intent.** `insert_history.rs` L1–5: "Codex uses the terminal scrollback itself for
finalized chat history, so inserting a history cell is an escape-sequence operation rather than a
normal ratatui render." `tui.rs` L429: "Initialize the terminal (inline viewport; history stays in
normal scrollback)". CLI: `RAW/codex-rs/tui/src/cli.rs` L77–82 `--no-alt-screen`: "Disable
alternate screen mode / Runs the TUI in inline mode, preserving terminal scrollback history."
Config `tui.alternate_screen` (`RAW/codex-rs/protocol/src/config_types.rs` L659–667): `Auto` "Use
alternate screen mode." (default), `Always`, `Never` "Never use alternate screen (inline mode
only)". `lib.rs` L2024–2037 `determine_alt_screen_mode`: `--no-alt-screen` wins, else `!=
AltScreenMode::Never`. **Important nuance:** `alt_screen_enabled` governs *overlays only* —
`tui.rs` L715 "Set whether overlays switch to the alternate screen or stay inline." The main chat is
inline unless `tui_fullscreen_transcript` puts the session in `TranscriptMode::Owned`
(`transcript_mode.rs` L13–19: owned only when `owned_enabled && alternate_screen_enabled`;
`lib.rs` L1844–1848). So the default Codex experience today = inline composer at the bottom,
history in native scrollback, Ctrl+T/`/diff` overlays on the alternate screen.

**Viewport model** (`custom_terminal.rs`, a vendored ratatui `Terminal`): fields "Area of the
viewport" / "Last known position of the cursor. Used to find the new area when the viewport is
inlined and the terminal resized." / "Count of visible history rows rendered above the viewport in
inline mode." (L148–155). The initial viewport is `Rect::new(0, cursor_pos.y, 0, 0)` (L226–231),
so the UI starts *where the shell prompt left the cursor*; if CPR (`ESC[6n`) is unanswered it falls
back to origin ("Some PTYs do not answer CPR" L189–193). Each draw (`tui.rs` L1152–1240) sets
`area.height = height.min(screen_size.height)` from the widget's `desired_height(width)`
(`app.rs` L1142–1160 passes `chat_widget.desired_height(width)` into `tui.draw_with_resize_reflow`),
and if the bottom would exceed the screen it *scrolls the whole terminal up* first
(`scrollback.grow_viewport`, L1199–1206) — history rows leave the screen into scrollback.

**Insertion algorithm** (`insert_history.rs` L166–215, `InsertHistoryMode::Standard`):
1. If the viewport is not yet at the bottom, scroll it down with a scroll region and reverse
   index: `SetScrollRegion(top_1based..screen_size.height)`, `MoveTo(0, area.top())`, N ×
   `Print("\x1bM")`, `ResetScrollRegion` (L170–183).
2. `SetScrollRegion(1..area.top())` — "Limit the scroll region to the lines from the top of the
   screen to the top of the viewport. With this in place, when we add lines inside this area, only
   the lines in this area will be scrolled." (L184–199, with an ASCII diagram).
3. `MoveTo(0, cursor_top)`; for each pre-wrapped line: `Print("\r\n")` then `write_history_line`
   (clears continuation rows for wide lines, sets fg/bg, `Clear(UntilNewLine)`, writes styled spans
   with a `ModifierDiff` that only emits changed SGR attributes) (L204–210, L294–342, L384–450).
4. `ResetScrollRegion`; `MoveTo(last_cursor_pos)` — "insert_history_lines should be
   cursor-position-neutral :)" (L200–203, L212–213).
Escape sequences: `SetScrollRegion` writes `"\x1b[{};{}r"` (L345–352), `ResetScrollRegion` writes
`"\x1b[r"` (L365–370). Lines are pre-wrapped at `area.width` (`HistoryLineWrapPolicy::PreWrap`)
except URL-only lines, which are left intact "so that terminal emulators can match them as
clickable links" (L124–135, L231–268). Batches are queued (`tui.rs` L1059–1076
`pending_history_lines … schedule_frame()`) and flushed inside the synchronized frame (L1125–1150),
with the rule "A failed write can already have emitted part of this batch. Never retry that batch
automatically: replaying it would duplicate the successful prefix."

**Terminal-specific strategies** (`tui/scrollback.rs` L19–50, L67–101): `Standard`; `Zellij`
(uses backend `scroll_region_up`); `FullScreen` for Windows Terminal (`TerminalName::WindowsTerminal
|| WT_SESSION`), because "Partial DEC scroll regions can discard rows instead of moving them into
Windows Terminal's scrollback" (L85–87) and "CSI S can discard departing rows in QTermWidget and
xterm.js. Newlines at the bottom of the history region preserve native scrollback" (L68–70). Also
"DECSTBM requires two distinct rows" (L87), so a 1-row history region takes the full-screen path.
`InsertHistoryMode::FullScreen` (L137–165) clears from the viewport, writes history at
`area.top()`, then advances `area.height` empty rows so "history ends immediately above the
composer".

**Resize.** Terminal scrollback rewraps natively, but Codex-written rows were pre-wrapped at the
old width, so `transcript_reflow.rs` L1–7: "Width resize reflow treats the in-memory transcript
cells as the source of truth, clears Codex-owned history, and re-emits the cells at the current
width", debounced by `TRANSCRIPT_REFLOW_DEBOUNCE = 75 ms`, capped per terminal
(`resize_reflow_cap.rs` L19–22: VS Code 1,000 rows, Windows Terminal 9,001, WezTerm 3,500,
Alacritty 10,000; "Replaying more rows than the terminal retains wastes work"). The legacy path
keeps a cursor heuristic: "If we resized AND the cursor moved, we adjust the viewport area to keep
the cursor in the same position. This is a heuristic that seems to work well at least in iTerm2."
(`tui.rs` L1387–1396). A tmux `SizeMonitor` polls every 500 ms because tmux can drop SIGWINCH
(`tui/size_monitor.rs` L1–3, L19).

**Bugs this design produced** (all github.com, fetched 2026-09-20): #1478 "Repeated Text Fragment
When Scrolling in Codex CLI" (0.2.0, Warp/Sakura; https://github.com/openai/codex/issues/1478);
PR #1685 (wrapping, needed a ratatui fork); PR #1758 "clamp render area to terminal size" — "Clamps
the viewport height to the actual terminal size and switches to saturating_sub when computing
cursor_top, eliminating two possible panics in tui::app and insert_history"
(https://github.com/openai/codex/pull/1758); PR #1774 "fix insert_history modifier handling"
(https://github.com/openai/codex/pull/1774); #22953 "Codex CLI flickers on Windows PowerShell and
scrollback becomes unreadable"; #19535 "Codex flickering issue on running 'npm build'"; #11901
"Extensive UI flickering when codex is working" (titles from
https://api.github.com/search/issues, 2026-09-20). Also `tui/terminal_stderr.rs` L1–6: "Some macOS
frameworks and runtime diagnostics write directly to file descriptor 2. While the inline TUI is
active, those writes paint into the same terminal region as the composer" — they redirect fd 2 while
the TUI owns the terminal.

**How this maps onto Ink 7.1.1** (`INK/ink.js`, read 2026-09-20). Ink already implements the same
*contract* — committed lines are written once above a redrawn dynamic region — but with erase/rewrite
instead of DECSTBM: `renderInteractiveFrame` L748–795: when there is new `<Static>` output,
`this.log.clear(); this.options.stdout.write(staticOutput); this.log(outputToRender);` (L779–786);
`useStdout().write()` → `writeToStdout` does the same `this.log.clear(); …write(data);
this.restoreLastOutput()` (L433–460). `log-update.js` erases with
`ansiEscapes.eraseLines(previousLineCount)` and relies on the frame being the last N lines. The full
clear path (`shouldClearTerminalForFrame`, L89–112: `wasOverflowing || (isOverflowing &&
hadPreviousFrame) || isLeavingFullscreen || shouldClearOnUnmount`, plus `isWindowsConsole &&
(wasFullscreen || isFullscreen)`) is exactly what JevCode's `rows − 2` budget avoids. Measured cost
of the Ink path (§11): ~300 bytes and 7 `ESC[2K` per committed line with a 6-row dynamic region;
a DECSTBM insert would be ~120 bytes and touch zero dynamic rows. That saving is not worth a
renderer fork (§13 REJECT).

---

## 4. Terminal setup and teardown (exact sequences)

`tui.rs` L236–256 `set_modes()`: `execute!(stdout(), EnableBracketedPaste)`; `enable_raw_mode()`;
`keyboard_modes::enable_keyboard_enhancement(&mut stdout())` with the comment "Enable keyboard
enhancement flags so modifiers for keys like Enter are disambiguated. chat_composer.rs is using a
keyboard event listener to enter for any modified keys to create a new line that require this";
`EnableFocusChange` on non-Windows, `DisableFocusChange` on Windows.

Kitty flags (`tui/keyboard_modes.rs` ≈L238–250): `KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
| REPORT_ALTERNATE_KEYS`; `REPORT_EVENT_TYPES` is added only on confirmed CSI-u transports because
"iTerm and Ghostty can leak shortcut release events that the terminal consumes. tmux's xterm key
format also loses Shift-Enter when event types are reported." Under tmux they additionally send
xterm `modifyOtherKeys` `"\x1b[>4;2m"` (≈L330) and reset with `"\x1b[>4;0m"` (≈L348), only "when
tmux confirms csi-u formatting" (≈L266–269). Kill switch: env `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT`
(L20); WSL + VS Code disables it "to avoid enabling the keyboard mode that can break dead-key
composition" (L49–57). Ink 7.1.1 supports the same five flags by name (`INK/kitty-keyboard.js`:
`disambiguateEscapeCodes: 1, reportEventTypes: 2, reportAlternateKeys: 4, reportAllKeysAsEscapeCodes:
8, reportAssociatedText: 16`) via the opt-in `kittyKeyboard` render option (research 01 §3).

Teardown (`tui.rs` L313–349 `restore_common`): pop the alternate-screen stack, `DisableBracketedPaste`,
`DisableFocusChange`, `disable_raw_mode()`, then `SetCursorStyle::DefaultUserShape,
crossterm::cursor::Show`. `restore_after_exit` (L372–384) uses `KeyboardRestore::ResetAfterExit`
"so the parent shell recovers even if a terminal missed the stack pop": `PopKeyboardEnhancementFlags`
+ `ResetKeyboardEnhancementFlags` = `"\x1b[<u"` (≈L300–313). A panic hook restores first
(`set_panic_hook` L561–567), and `TerminalInitializationGuard` restores if init fails midway
(`tui/input_boundary.rs` L12–22). After `fg` from Ctrl-Z they force `disable_raw_mode(); enable_raw_mode()`
because "A shell may restore the job's saved termios after the process receives `SIGCONT`" (L356–366);
`SUSPEND_KEY = ctrl('z')` (`tui/job_control.rs` L23). Stdin is `tcflush`ed when the event stream is
recreated (L393–403).

Alternate screen: `tui/alternate_screen.rs` L1–5 "Push only on entry and pop before leaving; the main
screen keeps its own TUI mode until terminal handoff." On entry with `capture_mouse=false` they enable
*alternate scroll* `"\x1b[?1007h"` (`tui.rs` L260–265, `alternate_screen.rs` L88) so a wheel becomes
arrow keys in pagers; transcript overlays instead request pointer reports
`"\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1003h"` (L47) and undo them in reverse (L104–108). Focus
events drive notifications only (`should_emit_notification`, `tui.rs` L108–113). Terminal title is
`"\x1b]0;{}\x07"` after sanitising control chars and bidi codepoints ("Trojan Source")
(`terminal_title.rs` L1–15, L90).

---

## 5. Composer (`bottom_pane/chat_composer.rs`, `textarea.rs`, `paste_burst.rs`)

Module doc (L1–14): "The chat composer is the bottom-pane text input state machine. It edits the
`TextArea` buffer and attachment elements, routes popup keys, promotes completed slash commands to
atomic elements, and handles Enter submission/newlines … detects unbracketed paste bursts from raw
key streams, particularly on Windows." Dispatch: `handle_key_event` (L1954) ignores `Release`
events, then `handle_key_event_inner` (L1969–2006) routes to `handle_key_event_with_slash_popup` /
`_file_popup` / `_skill_popup` / `_mentions_v2_popup` / `handle_key_event_without_popup` and always
calls `sync_popups()` afterwards ("After every handled key, we call `sync_popups` so UI state
follows the latest buffer/cursor", L27–30).

**Default bindings** (`keymap.rs` L1641–1742, L1866–1880, L2454–2463, fetched 2026-09-20):
`submit: Enter` (L1674); `queue: Tab` (L1675); `insert_newline: ctrl('j'), plain(Enter) [context],
shift(Enter), alt(Enter)` (L1685–1689); `history_search_previous: ctrl('r')` (L1680);
`move_left: Left, ctrl('b')`, `move_up: Up, ctrl('p')` (L1691–1693); `kill_line_start: ctrl('u')`,
`kill_line_end: ctrl('k')`, `yank: ctrl('y')` (L1739–1742); `open_transcript: ctrl('t')` (L1641);
`open_external_editor: ctrl('g')` (L1645); `copy: ctrl('o')` (L1646); `interrupt_turn: Esc` (L1658);
fixed (non-remappable): `fixed.quit = ctrl('d')`, `fixed.paste_image = ctrl('v')`, `shift(Tab)`
(cycle mode), `fixed.backtrack = Esc` (L2454–2463). Composer doc L166–167: "`Enter` submits
immediately. `Tab` requests queuing while a task is running; if no task is running, `Tab` submits
just like Enter so input is never dropped." The `?` shortcut overlay lists Compose: `/ Commands`,
`@ Mention files`, `! Shell command`, "New line", "Paste image", "External editor", "Search history";
Session: "Queue message"/"Send message", `shift+Tab Change mode`, "Interrupt"/"Quit"; Transcript:
"Open transcript", "Find text", `pgup / pgdn Scroll`, `ctrl+home / ctrl+end Top / latest`
(`bottom_pane/shortcut_overlay.rs` L72–145). Footer hints: `" for shortcuts"` (after `?`), `" to
queue message"`, `" again to quit"`, `" to edit previous message"` (`bottom_pane/footer.rs` L345,
L351, L929, L943).

**History (↑/↓ and Ctrl+R)** (L69–95): "Persistent cross-session history (text-only storage …)"
merged with "Local in-session history (full text + text elements + …)"; `Up` recalls only when the
cursor is at position 0 / the buffer is untouched (`should_handle_navigation`, L3543–3566); "Ctrl+R
searches history in the footer and previews matches in the composer … Enter accepts the preview; Esc
restores the original draft." Slash commands are "staged for local history … then record it after
`ChatWidget` dispatches the command" (L91–94). `textarea.rs` L1–12 keeps "a single-entry kill
buffer" (not an Emacs ring) that survives submit so `Ctrl+K` … `Ctrl+Y` works across a clear.

**Paste.** Bracketed paste arrives as `TuiEvent::Paste`; `app.rs` ≈L1000–1010 normalises: "Pasted
text may contain CRLF pairs or bare CRs (e.g., from iTerm2), but tui-textarea expects LF. Normalize
CRLF pairs before bare CRs" → `pasted.replace("\r\n", "\n").replace('\r', "\n")`. Large pastes:
`LARGE_PASTE_CHAR_THRESHOLD: usize = 1000` (L430) become an atomic placeholder
`format!("[Pasted Content {char_count} chars]")` (L1917), numbered `#2`, `#3` for equal sizes
(L189–197), expanded on submit. Image paths pasted as text are sniffed with `image::image_dimensions`
and attached (`handle_paste_image_path`, L1200–1215); `Ctrl+V` reads the clipboard through
`arboard`, encodes PNG to a temp file, with a PowerShell fallback under WSL (`clipboard_paste.rs`
L51–58, L121–123, L154–205). Non-bracketed bursts (`paste_burst.rs` L1–19, constants L157–170):
`PASTE_BURST_MIN_CHARS = 3`, `PASTE_BURST_CHAR_INTERVAL = 8 ms`, `PASTE_BURST_ACTIVE_IDLE_TIMEOUT =
60 ms` (8 ms in tests), `PASTE_ENTER_SUPPRESS_WINDOW = 120 ms`; the first ASCII char is *held* for
up to 8 ms "(flicker suppression)", non-ASCII/IME chars are never held (L221–235). The state machine
"never mutates the textarea directly" (L21–22) — it is a pure decision function, unit-tested.

**`/` and `@` popups.** `MAX_POPUP_ROWS: usize = 8` "Keep this consistent across all popups for a
uniform feel" (`bottom_pane/popup_consts.rs` L12–14); standard hint "Press Enter to confirm or Esc to
go back" (L17–25). Command popup hides aliases (`ALIAS_COMMANDS = [Quit, Btw]`, `command_popup.rs`
L19–22) and is allowed only when no `@`/`$` token is active and not in `!` shell mode
(`sync_popups`, L3925–3990). `Esc` "records the first-line `/name` token and keeps the popup closed
while that token is unchanged" (L60–63). File search: "`ChatComposer` publishes every change of the
`@token` as `AppEvent::StartFileSearch(query)`. This manager owns a single `codex-file-search`
session for the current search root, updates the query on every keystroke, and drops the session
when the query becomes empty" (`file_search.rs` L1–6); results are discarded if the query moved on
(`session_token`, L108–125); the popup keeps `display_query` vs `pending_query` and a `waiting`
flag so stale rows stay visible while typing (`file_search_popup.rs` L17–31, L47–56) and shows at
most `MAX_POPUP_ROWS` matches (L78). Composer doc L19–22: "By default, `@` lists plugins, filesystem
entries, and skills … `$` lists individual skills and apps".

**External editor.** `Ctrl+G` (keymap L1645) → `external_editor::resolve_editor_command()` prefers
`VISUAL` over `EDITOR` (`external_editor.rs` L39–42); the TUI pauses its event stream and restores
terminal modes around the child (`app/input.rs` L231–272, `tui.rs` L874 `with_restored`).

**Height.** The inline viewport height is the bottom pane's `desired_height(width)` — composer rows
+ popup + status + footer (`bottom_pane/mod.rs` L2271–2273, `app.rs` L1142–1160). Nothing above it
is redrawn; everything above is scrollback.

---

## 6. Interrupt, quit, Esc, Ctrl+C, Ctrl+D (state machine)

`chatwidget.rs` L567–569: "Quit/interrupt behavior intentionally spans layers: the bottom pane owns
local input routing (which view gets Ctrl+C), while `ChatWidget` owns process-level decisions such
as interrupting active work, arming the double-press quit shortcut, and requesting shutdown-first
exit."

- **Esc** while a turn runs = interrupt (`interrupt_turn: Esc`, keymap L1658; status row shows
  `(12s • Esc to interrupt)`). Esc while idle with an empty composer *primes backtracking*: "The
  first `Esc` in the main view 'primes' the feature … A subsequent `Esc` starts compact transcript
  browsing and highlights the latest user prompt … `Enter` requests a revert before the selected
  prompt and reopens it for editing." (`app_backtrack.rs` L10–14; `app/input.rs` L561–575). Esc also
  dismisses popups, leaves `!` shell mode when the buffer is empty (L3474–3482), and is always
  "Cancel" in MCP elicitations "so dismissal never silently becomes 'continue without info'"
  (`approval_overlay.rs` L8–10).
- **Ctrl+C** (`bottom_pane/mod.rs` L922–957 `on_ctrl_c`): active view gets first refusal; else if a
  history search is open it is cancelled; else if the composer is **non-empty it is cleared**
  (`clear_composer_for_ctrl_c`) and the footer shows the quit hint; only an empty composer returns
  `NotHandled`. Then `chatwidget/interaction.rs` L540–600: with `DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED`
  (currently `false`, `bottom_pane/mod.rs` L229) *off*, "if cancellable work is active → interrupt,
  else → `request_quit_without_confirmation()`"; with it on, the first press arms a 1 s window
  (`QUIT_SHORTCUT_TIMEOUT = Duration::from_secs(1)`, L220, "Keeping a single value ensures Ctrl+C and
  Ctrl+D behave identically") and shows `" again to quit"`.
- **Ctrl+D** quits only "when the composer is empty and no modal/popup is active" (L603–606;
  composer L3532–3541 returns `None` for Ctrl+D on empty so the app layer sees it); `Ctrl+C` followed
  by `Ctrl+D` must not quit ("We require the second press to match this key", `chatwidget.rs`
  L750–754). Offline (reconnecting) Ctrl+C/Ctrl+D exit immediately (`app.rs` L877–889).
- Quit is "shutdown-first" (`AppEvent::Exit(ExitMode::ShutdownFirst)`, `chatwidget.rs` L1434–1441)
  with a "shutdown in progress" bottom pane — i.e. checkpoints/cleanup run before the process exits.

## 7. Queued follow-ups and steering while a turn runs

`bottom_pane/pending_input_preview.rs` L1–10: "displays pending steers plus follow-up inputs held
while a turn is in progress. The widget renders pending steers first, then rejected steers that will
be resubmitted at end of turn, then ordinary queued user messages. Pending steers explain that they
will be submitted after the next tool/result boundary unless the user invokes the interrupt binding
to send them immediately. The edit hint at the bottom only appears when there are actual queued user
inputs to pop back into the composer … Defaults to Alt+Up"; `PREVIEW_LINE_LIMIT: usize = 3`.
`chatwidget/input_queue.rs` doc: "User inputs queued while a turn is in progress", "User messages that
tried to steer a non-regular turn and must be retried first", "When set, the next interrupt should
resubmit all pending steers as one fresh user turn instead of restoring them into the composer".
Semantics: **Enter during a turn = steer** (delivered at the next tool boundary), **Tab = queue**
(delivered after the turn) — the official docs page also lists `Tab` for queuing messages during a
turn, `Esc` to interrupt, `Ctrl+T` transcript, `Ctrl+V` image paste and `--no-alt-screen`
(https://learn.chatgpt.com/docs/codex/cli, the redirect target of developers.openai.com/codex/cli;
summarised by the fetch tool, exact wording not captured; fetched 2026-09-20). The footer switches to `" to queue message"` while running (`footer.rs` L351).

## 8. Approval overlay (`bottom_pane/approval_overlay.rs`)

Doc L1–12: "converts agent approval requests (exec/apply-patch/MCP elicitation) into a
list-selection view with action-specific options and shortcuts … 1. Selection always emits an
explicit decision event back to the app. 2. MCP elicitation keeps `Esc` mapped to `Cancel` … This
module does not evaluate whether an action is safe to run; it only presents choices and routes user
decisions." Request kinds L70–75: `Exec`, `Permissions`, `ApplyPatch`, `McpElicitation`, each with
`reason: Option<String>`.

Header (`build_header`, L693–770): optional `"Thread: "` (bold), `"Environment: "` (bold), then
`Line::from(vec!["Reason: ".into(), reason.clone().italic()])` (L712–713), then the command as
`strip_bash_lc_and_escape(&request.command)` → `highlight_bash_to_lines` with `"$ "` prepended
(L731–738). Titles L284–296: `"Would you like to grant these permissions?"`, `"Would you like to
make the following edits?"` (apply-patch header is the diff summary from `apply_patch_header.rs`),
`"{server} needs your approval."`. Exec options (L832–916), in order and with keymap groups:
`"Yes, proceed"` (`approve`), `"Yes, and don't ask again for commands that start with `{prefix}`"`
(`approve_for_prefix`, hidden if the prefix contains a newline), `"Yes, and don't ask again for
this command in this session"` (`approve_for_session`), `"No, continue without running it"`
(`deny`), `"No, and tell Codex what to do differently"` (`decline`; default `decline: Esc, n`,
keymap L1933). Patch options L1018–1028: `"Yes, proceed"`, `"Yes, and don't ask again for these
files"`, `"No, and tell Codex what to do differently"`. Permission grants L1045–1062 add `"Yes,
grant for this turn with strict auto review"` (`r`). A `header_view_all_hint` opens the full diff in a
pager (`open_fullscreen`, default Ctrl+Shift+A per test name `default_approval_open_fullscreen_includes_ctrl_shift_a`,
keymap L4048). The prompt is *deferred while the user is typing*: it is shown only once the
composer has been idle for `APPROVAL_PROMPT_TYPING_IDLE_DELAY = Duration::from_secs(1)`
(`bottom_pane/mod.rs` L222; `approval_prompt_delay_remaining` L717–724 measures from
`last_composer_activity_at`), and buffered input is discarded before a security decision
(`input_boundary.rs` L24–28). Contrast with the TS era (`TS/src/components/chat/terminal-chat-command-review.tsx`
L83–115): `"Yes (y)"`, `"Yes, always approve this exact command for this session (a)"`, `"Explain this
command (x)"`, `"Edit or give feedback (e)"`, `"Switch approval mode (s)"`, `"No, and keep going
(n)"`, `"No, and stop for now (esc)"` — the Rust version dropped Explain/Switch and made labels full
sentences.

## 9. Diff rendering, `/diff`, `/status`, `/model`, `/approvals`, transcript overlay

`diff_render.rs` L1–33: "Each `FileChange` variant (Add / Delete / Update) is rendered as a block of
diff lines, each prefixed by a right-aligned line number, a gutter sign (`+` / `-` / ` `), and the
content text … syntax-highlighted … diff backgrounds adapt to the terminal's background lightness …
Dark terminals get muted tints … light terminals get GitHub-style pastels … fixed palettes for
truecolor / 256-color / 16-color terminals … hunks are highlighted as a single concatenated block …
long lines are hard-wrapped at the available column width." Palette L64–79: dark add bg
`#213A2B`, dark del bg `#4A221D`, light add `#dafbe1`, light del `#ffebe9`; 256-colour indices 22/52
(dark) and 194/224 (light). `/diff` (`get_git_diff.rs` L1–6) "returns the diff for tracked changes as
well as any untracked files" by running `git diff --color` plus, per untracked file, `git diff
--color --no-index /dev/null <file>` (L105–112), with `-c core.hooksPath=/dev/null` and executable
filters disabled (L17–24), 30 s timeout. The result opens in a `StaticOverlay` pager
(`pager_overlay.rs` L1–4) on the alternate screen; pager keys: `PageUp`/`ctrl('b')`, half page
`ctrl('u')`/`ctrl('d')`, `close: q, ctrl('c')`, `close_transcript: ctrl('t')` (keymap L1866–1880);
footer shows `" {percent}% "` (L268).

Slash commands (`slash_command.rs` L15–84 enum; descriptions L89–153): `/status` "show current
session configuration and token usage", `/model` "choose what model and reasoning effort to use",
`/permissions` "choose what Codex is allowed to do" (the old `/approvals`), `/diff` "show git diff
(including untracked files)", `/compact`, `/review`, `/resume` "resume a saved chat", `/new`, `/fork`,
`/clear` "clear the terminal and start a new chat", `/copy`, `/export` "export the conversation as
markdown", `/raw` "toggle raw scrollback mode for copy-friendly terminal selection", `/mention`,
`/keymap` "remap TUI shortcuts", `/vim`, `/quit`|`/exit`, `/feedback`, `/rollout` "print the rollout
file path". Gating: `available_during_task()` returns `false` for `New, Archive, Delete, Fork,
Worktree, Init, Compact, Recap, Export, Keymap, Vim, … Review, Plan, Cd, Clear, Logout` (L233–256);
`supports_inline_args()` for `Review, Rename, New, Clear, Fork, Plan, Goal, … Resume` (L163–185).
`/status` renders a card (`status/card.rs`, 36 KB) with rate limits and token usage
(`status/rate_limits.rs`, `status/thread_usage.rs`, listing 2026-09-20).

Transcript (`Ctrl+T`): `HistoryCell` is the unit of display — `fn display_lines(&self, width: u16)
-> Vec<Line<'static>>` and `fn raw_lines(&self)` "copy-friendly plain logical lines for raw
scrollback mode" (`history_cell/mod.rs` trait). The overlay "appends a cached live tail derived from
the active cell" (L7–8) so in-flight output is visible in the pager; `transcript_view.rs` L1–5:
"Anchors address content inside an entry, so prepending history never renumbers them".

## 10. Status line, spinner, streaming pace

`status_indicator_widget.rs`: header defaults to `"Working"` (L99); `interrupt_binding =
plain(Esc)` (L106); spans: activity indicator, shimmered header, then
`format!("({pretty_elapsed} • ")`, the key hint, `" to interrupt)"` (L252–259), optional `" · "`
message; `fmt_elapsed_compact`: `"12s"`, `"1m 05s"`, `"1h 02m 03s"` (L76–88). Redraw cadence: 32 ms
while animating, else 1,000 ms (L305–313). Indicator: with truecolor a shimmered `•`; otherwise
`•`/`◦` toggled every 600 ms (`motion.rs` L65–76); reduced-motion mode hides it or uses a static
bullet (L26–44). `summary_shimmer.rs` L1–6: "two-second sweep … Only brightness changes … The wave
spans at least six terminal columns so short labels do not flash one letter at a time. Unknown
palettes use static dim text".

Streaming (`streaming/controller.rs` L1–5): "Each stream partitions rendered markdown into a
*stable region* (committed to scrollback via the animation queue) and a *tail region* (mutable,
displayed in the active-cell slot)". Commit boundary = newline (`markdown_stream.rs` L1–9).
Pacing (`streaming/chunking.rs` L1–27, L85–116): `Smooth` drains one queued line per tick; enter
`CatchUp` when queue ≥ `ENTER_QUEUE_DEPTH_LINES = 8` or oldest ≥ `ENTER_OLDEST_AGE = 120 ms`; exit at
≤ `EXIT_QUEUE_DEPTH_LINES = 2` / `EXIT_OLDEST_AGE = 40 ms` held `EXIT_HOLD = 250 ms`;
`SEVERE_QUEUE_DEPTH_LINES = 64` / `SEVERE_OLDEST_AGE = 300 ms` overrides the re-entry hold. Tables
are held back as mutable tail until finalised because "adding a new row can change every column's
width" (controller L12–20).

Logging: `session_log.rs` L85–92 writes JSONL only when `CODEX_TUI_RECORD_SESSION=1`
(`CODEX_TUI_SESSION_LOG_PATH` override), file mode `0o600` (L21); it records inbound `AppEvent`s —
whether raw key events are included was **not verified** (the serialiser at L140+ was not read).

---

## 11. Measurements made (2026-09-20, the reference machine, Node v22.23.2)

1. **Ink `<Static>` append cost vs a DECSTBM insert** — `/tmp/codex-research/bench/ink-bytes.mjs`
   (imports `node_modules/ink` and `react` from the repo; fake 120×40 `isTTY` Writable; 300 items
   appended one per frame under a fixed 6-row `overflow="hidden"` dynamic region):
   `inkBytesTotal 89,854` → **300 B per append**, `inkWrites 1,808`, `ESC[2K` count **2,100 (7 per
   append = 6 dynamic rows + 1)**, cursor-up sequences 1,800, `ESC[2J` **0**, **0.905 ms per append**
   (React reconcile + Yoga + write, in-process). Cost model of Codex's Standard insert for the same
   90-byte line (one batch per line: `ESC[1;{top}r` + `ESC[{row};1H` + `\r\n` + `ESC[2K` + text +
   `ESC[r` + `ESC[{y};{x}H`): **≈120 B per append**, zero dynamic rows rewritten. Conclusion: Ink's
   path costs ~2.5× the bytes and rewrites the dynamic region on every commit, but at ≤ 20 commits/s
   that is ≈ 6 KB/s — irrelevant next to the terminal's own repaint.
2. **JevCode baseline** (`perf/results/latest.json`, measured 2026-09-20T05:24:52Z): first frame cold
   median 89.0 ms / p95 89.9 ms, warm median 80.1 ms (gate 300 ms, `pass: true`); `dist/jevcode.mjs`
   1,576,081 bytes. Codex's Rust binary is not comparable (no Node boot), but its npm *wrapper* is
   13,206 bytes and spawns a ~100 MB platform binary (§1).
3. **Source volume**: Codex's composer (`chat_composer.rs` 13,036 + `textarea.rs` 4,619 +
   `chat_composer_history.rs` 1,628 + `paste_burst.rs` 590 lines) versus JevCode's whole `src/tui/`
   (App 208 + useEngine 298 + five more files). Budget accordingly: a *good* composer is thousands of
   lines even with a dependency-free design.

---

## 12. ADOPT

| # | What JevCode should do | Why | Source |
|---|---|---|---|
| A1 | Keep `<Static>` as the scrollback writer; keep the `rows − 2` height budget; do **not** emulate `insert_history_lines` | Same contract (write once above, redraw a small region), 0 `ESC[2J`; DECSTBM saves ~180 B/commit but needs a renderer fork, per-terminal strategies (Zellij, Windows Terminal), CPR probes and produced #1478/#1685/#1758/#1774 | §3, §11.1; `INK/ink.js` L779–786; PR #1685 |
| A2 | Two-region streaming: newline-gated commit of *stable* lines into `<Static>`, mutable tail in the live region; keep tables/fenced blocks in the tail until closed | Removes "text twice / not at all" risk and keeps the live region 2 rows; Codex's design statement | `streaming/controller.rs` L1–20; `markdown_stream.rs` L1–9 |
| A3 | Commit-tick pacing with hysteresis: 1 line/tick at 50 ms, catch-up when queue ≥ 8 lines or oldest ≥ 120 ms, exit at ≤ 2 lines/40 ms held 250 ms | Smooth display under bursty deltas without falling behind; pure policy over `(depth, oldest_age)` is unit-testable | `streaming/chunking.rs` L85–116 |
| A4 | Composer keys: `Enter` submit; `Shift+Enter` / `Alt+Enter` / `Ctrl+J` newline; `Tab` = queue while running, submit when idle; `↑` history only at cursor 0; `Ctrl+R` reverse search with live preview, `Esc` restores draft; `Ctrl+U/K/Y` single-entry kill buffer that survives submit | Matches Codex defaults users already know; "input is never dropped" | `keymap.rs` L1674–1742; composer doc L69–95, L166–167; `textarea.rs` L1–12 |
| A5 | Enable kitty keyboard via Ink `kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes','reportAlternateKeys'] }`; provide `JEVCODE_TUI_DISABLE_KEYBOARD_ENHANCEMENT` | Shift+Enter needs it; Codex uses exactly these two flags and an env kill switch | `keyboard_modes.rs` L20, ≈L238–250; `INK/kitty-keyboard.js` |
| A6 | Bracketed paste with `usePaste`; normalise `\r\n`→`\n` then `\r`→`\n`; pastes > 1,000 chars become an atomic `[Pasted Content N chars]` placeholder expanded at submit; Enter inside a paste is a newline | Prevents accidental submit of multi-line pastes and 500-line composers | `app.rs` ≈L1000–1010; composer L189–197, L430, L1917; `INK/hooks/use-paste.js` |
| A7 | `/` popup ≤ 8 rows, fuzzy, hide aliases, `Tab` completes, `Enter` runs, `Esc` dismisses and remembers the token; gate commands with `availableDuringTask` | Uniform popup height; no popup fighting the user | `popup_consts.rs` L12–25; composer L60–63; `slash_command.rs` L233–256 |
| A8 | `@` file mention: async search session per query, `waiting` state keeps stale rows, ≤ 8 rows, drop results whose query moved on; implement with `fs.opendir` walk + `.gitignore`-ish skip list + a small subsequence scorer (no deps) | Keystroke-latency UX without blocking the loop | `file_search.rs` L1–6, L108–125; `file_search_popup.rs` L17–31, L78 |
| A9 | Review prompt as a list-selection: title, `Reason:` (italic, from Jev's dominant risk dimension), `$ <command>` or diff summary, options `Yes, proceed` / `Yes, and don't ask again for <kind> this run` / `No, continue without running it` / `No, and tell the generator what to do differently`; `Esc` and `n` = decline; defer showing the prompt until the composer has been idle for 1 s and drain buffered input before it can accept a key | Sentence labels beat `[y]/[n]`; the idle deferral + drain prevent a typed-ahead `y` from approving | `approval_overlay.rs` L1–12, L284–296, L712–738, L832–916, L1018–1028; `bottom_pane/mod.rs` L222, L717–724; `input_boundary.rs` L24–28 |
| A10 | `Esc` = interrupt current step (single press) with the hint `(12s • Esc to interrupt)`; `Ctrl+C` = clear a non-empty composer, else abort with checkpoint (JevCode's existing `human_abort`); `Ctrl+D` on an empty composer = quit; second-key must match | Codex's shipped semantics after burndown #1244/#1245; Ink already delivers `\x03` as input when `exitOnCtrlC:false` | §6; `status_indicator_widget.rs` L252–259; `INK/components/App.js` L149–153 |
| A11 | Steering: `Enter` during a step queues a *steer* shown as "will be sent at the next step boundary"; `Tab` queues for after the run; preview ≤ 3 lines above the composer; `Alt+↑` pops the last queued item back into the composer | Lets the human redirect Jev's loop without aborting | `pending_input_preview.rs` L1–10; `input_queue.rs` doc |
| A12 | Status row: `Working (elapsed • Esc to interrupt) · stage`, redraw at 1 s when idle and only animate when `JEVCODE_ANIMATIONS`/`NO_COLOR` permit; `•`/`◦` fallback | Reduced-motion and 1 Hz idle keep render lag tiny | `status_indicator_widget.rs` L76–88, L305–313; `motion.rs` L26–76 |
| A13 | Resize: debounce 75 ms, recompute the budget, never rewrite scrollback (terminal rewraps it); keep committed lines `wrap="wrap"` in `<Static>` so Ink hard-wraps once at commit width | Codex has to rebuild scrollback because it pre-wraps; Ink's Static also pre-wraps, so accept stale wrap on resize rather than replay | `transcript_reflow.rs` L1–7; `resize_reflow_cap.rs` L1–9 |
| A14 | Teardown on every exit path (normal, `uncaughtException`, signals): pop kitty flags (`ESC[<u`), `ESC[?2004l`, `ESC[?1004l`, `ESC[0 q`, `ESC[?25h`, raw mode off | "leaves the terminal in raw-mode … looks like a 'frozen' shell" (TS) and "so the parent shell recovers even if a terminal missed the stack pop" (Rust) | `tui.rs` L313–349, L372–384; `TS/src/utils/terminal.ts` L57–84 |
| A15 | Transcript/diff viewers: `/transcript` and `/diff` write to a temp file and hand the terminal to `$PAGER`/`less -R` via Ink's terminal suspension, then force a redraw | Codex uses the alternate screen for these overlays; Ink's `alternateScreen` is instance-wide and a full-height dynamic frame would hit the clear-terminal path | `pager_overlay.rs` L1–4; `INK/ink.js` L89–112; research 01 (`useApp().suspendTerminal`) |
| A16 | Never log composer text: replace the `JEVCODE_TRACE` line in `src/tui/App.tsx` (`tui.useInput input=${JSON.stringify(input)}`) with control-key names only | Project rule "keys never appear in logs"; a pasted API key in the composer would otherwise hit the trace file | `src/tui/App.tsx` (read 2026-09-20); `session_log.rs` L21, L85–92 |
| A17 | Packaging: keep one platform-independent bundle + `bin/jevcode.js`; steal only the wrapper's error message pattern ("Reinstall … npm install -g …") and async spawn/signal forwarding *if* a child ever needs it | Codex's six-platform `optionalDependencies` split exists only because of native binaries | `codex-cli/bin/codex.js` L16–23, L84–95; npm metadata §1 |
| A18 | Terminal title `ESC]0;jevcode · <task 40 chars>BEL` after stripping control/bidi characters | Cheap, useful in tab bars; sanitisation matters because titles come from model/task text | `terminal_title.rs` L1–15, L90 |

## 13. REJECT

| # | What not to do | Why |
|---|---|---|
| R1 | Implement a Codex-style inline viewport in Ink with raw `ESC[{a};{b}r` writes above Ink's frame | Ink's `log-update` owns the last N lines and erases with `eraseLines(previousLineCount)`; raw scroll-region writes need the absolute row of Ink's frame (a CPR round-trip Codex bounds at 250 ms), break on Zellij/Windows Terminal without per-terminal strategies, and Codex needed a ratatui fork plus four follow-up fixes. Gain ≈ 180 B/commit (§11.1). |
| R2 | Alternate screen for the main chat (`tui_fullscreen_transcript` "owned" mode) | Loses native scrollback/copy — the very reason Codex defaults to inline; Ink `alternateScreen` is all-or-nothing per instance and would force a scrolling transcript widget. |
| R3 | Kitty `reportEventTypes` / `reportAllKeysAsEscapeCodes` | Codex gates event types off on iTerm2/Ghostty/tmux: "can leak shortcut release events that the terminal consumes" (`keyboard_modes.rs` ≈L241–250). |
| R4 | Double-press Ctrl+C as the *only* way to quit | Codex ships `DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED = false`; a checkpointing harness can quit on one press once the composer is empty (A10). |
| R5 | Windows paste-burst heuristics (hold first char 8 ms, retro-capture) | JevCode targets macOS/Linux TTYs with bracketed paste; the held first character is visible input latency. Keep only the 120 ms "Enter is a newline" window after a paste. |
| R6 | A remappable keymap system (`keymap.rs` 4,075 lines, `/keymap`) | Fixed bindings + `?` overlay; remapping conflicts (Ctrl+Z, Esc) cost Codex a validation layer. |
| R7 | Image paste (`Ctrl+V`, `arboard`, `image`) | No vision path in JevCode's generator loop; needs native clipboard access. |
| R8 | Mouse capture (`?1000/1002/1003/1006h`) | Only used in Codex's alt-screen transcript; Ink has no mouse parser; wheel must keep scrolling native scrollback. |
| R9 | TS-era patterns: `patchConsole: true`, `process.exit(0)` 60 ms after Ctrl+C, double-Esc 1.5 s interrupt, `clearTerminal()` writing `ESC[3J ESC[H ESC[2J` | Each violates a JevCode invariant (zero clears, checkpoint-before-exit) or was replaced by Codex itself. |
| R10 | Rebuilding scrollback on width change (`resize_reflow`) | Requires clearing Codex-owned rows and replaying up to 10,000 rows; JevCode's `transcript.log` already holds the canonical text. |
| R11 | A 120 FPS frame scheduler | Ink throttles at `maxFps` 30 by default (`INK/render.js` L16) and JevCode coalesces at 20 fps; the status row only needs 1 Hz when idle. |
| R12 | A separate "raw scrollback" mode (`/raw`) | Ink `<Static>` output is already plain rows in native scrollback; no boxed cells to strip. |

## 14. OPEN QUESTIONS

1. Does Ink 7.1.1's terminal suspension (`useApp().suspendTerminal`, `ink.js` `isSuspended`
   L336–341, L440–443) release raw mode, bracketed paste and kitty flags for a child `less -R`, and
   redraw cleanly on return? Needs a pty test before A15 is committed.
2. With `kittyKeyboard: { mode: 'auto' }`, does `useInput` expose Shift+Enter as `key.shift &&
   key.return` on iTerm2, Ghostty, WezTerm, Terminal.app (no kitty support) and inside tmux? Codex's
   tmux path additionally needs `modifyOtherKeys` (`ESC[>4;2m`), which Ink does not emit.
3. Ink does not appear to parse focus events (`ESC[I` / `ESC[O`; not found in `INK/components/App.js`
   or `input-parser.js`, grep 2026-09-20 — UNVERIFIED). If enabled they would leak as input; keep
   `?1004` off unless parsed.
4. Realistic dynamic-region size: composer (1–8 rows) + queue preview (≤ 3) + decisions pane (≤ 12)
   + status (1) ≈ 24 rows at most — every `<Static>` commit rewrites it (§11.1). Re-run the benchmark
   with that layout and a 500 delta/s mock to confirm render-lag p95 < 5 ms still holds.
5. Where do Jev decisions live in a chat UI? Codex has no analogue. Options: (a) keep the fixed
   decisions pane; (b) commit each decision as a dim one-line `<Static>` item under its step; (c) both,
   with `/decisions` opening the pager view. Decide with the height budget in hand.
6. Should `Esc` also decline a pending review prompt (Codex: `Esc` = decline)? It conflicts with
   `Esc` = interrupt if a prompt appears while the human is about to interrupt.
7. Sessions: Codex's `/resume` picker is 252 KB of Rust. JevCode has `--resume <id>`; a minimal
   `/resume` list over `~/.jevcode/runs/*/run.json` (id, task, stopReason, mtime) is probably enough.
8. Whether Codex's `session_log.rs` serialiser includes key events (not read) — relevant only as a
   cautionary example for A16.
