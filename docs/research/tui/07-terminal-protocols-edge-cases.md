# 07 — Terminal protocols and every edge case a chat TUI must survive

Research note for the interactive (chat-style) JevCode TUI. Written 2026-09-20. All web sources carry
their URL and the fetch date; local sources are paths under the repo (`node_modules/ink` is Ink 7.1.1,
`package.json` `"version": "7.1.1"`). Measurements were made on the reference machine (macOS 26.6.2, Apple Silicon,
Node v22.23.2, ICU 78.2 / Unicode 17.0 per `process.versions`) with a Python `pty.fork()` driver at
`/tmp/jevtui/pty_drive2.py` (millisecond-accurate `select` pump) because the Bash tool's stdin is a socket
and macOS `script(1)` refuses it (`tcgetattr/ioctl: Operation not supported on socket`). `tmux` is not
installed here, so tmux behaviour is sourced from its CHANGES file and man page only. `gh` is not
installed and the anonymous GitHub API was rate-limited, so GitHub issue *comments* (tmux #3335, mosh
issues) are marked UNVERIFIED where I could not read them through the web UI.

Constraints honoured throughout: Node 22, TypeScript strict, ESM, runtime deps only `ink` 7.1.1 and
`react` 19.3.0, esbuild single file, first frame < 300 ms with zero network, rendering never blocks the
loop, zero terminal clears after the first frame, keys never in logs.

## 0. What Ink 7.1.1 already does (read from `node_modules/ink/build/*.js`, 2026-09-20)

| Concern | Ink 7.1.1 behaviour (file) | Consequence for JevCode |
| --- | --- | --- |
| Raw mode | `stdin.setRawMode(true)` ref-counted per `useInput`/`usePaste`; `isRawModeSupported = stdin.isTTY` (`components/App.js`) | Gate `useInput` with `isActive: Boolean(isRawModeSupported)` (already done in `src/tui/App.tsx`) |
| Input reading | `stdin.addListener('readable', …)` + `stdin.read()` loop, one parser with a `pending` buffer (`components/App.js`, `input-parser.js`) | Chunk boundaries are handled; see the 20 ms flush below |
| Escape timeout | `const pendingInputFlushDelayMilliseconds = 20;` — a lone/incomplete ESC sequence is flushed as literal input after 20 ms (`components/App.js`) | Not configurable. Measured effects in §1.5 |
| Bracketed paste | `usePaste` writes `\u001B[?2004h`, ref-counted, `\u001B[?2004l` on unmount and on `pauseInput` (`components/App.js`, `hooks/use-paste.js`); parser waits for `\u001B[201~` before emitting `{paste}`; `hasPendingEscape()` excludes `\u001B[200` so the flush timer never fires mid-marker (`input-parser.js`) | Use `usePaste`; paste never reaches `useInput` when a paste listener exists |
| Kitty keyboard | opt-in `render({kittyKeyboard:{mode:'auto'|'enabled'|'disabled', flags}})`; auto: writes `\u001B[?u`, waits **200 ms** on a `stdin.on('data')` listener, on `CSI ? <digits> u` writes `CSI > <flags> u`; `CSI < u` on unmount and on `suspendTerminal`, re-push on resume (`ink.js` `confirmKittySupport`, `enableKittyProtocol`, `finishUnmount`, `endSuspend`) | No DA1 sentinel; leaks the response into `useInput` (measured, §1.2) |
| Kitty parsing | `parse-keypress.js` handles `CSI n;mods[:event][;text]u`, `CSI 1;mods:event letter`, `CSI n;mods:event ~`; modifiers `shift 1 alt 2 ctrl 4 super 8 hyper 16 meta 32 capsLock 64 numLock 128`; event `1 press 2 repeat 3 release` (`kitty-keyboard.js`) | `useInput` gives `key.shift/ctrl/meta/super/eventType` — enough for Shift+Enter |
| Synchronized output | `bsu='\u001B[?2026h'`, `esu='\u001B[?2026l'` around every frame when `stream.isTTY && (interactive ?? !isInCi)` (`write-synchronized.js`) — no DECRQM query, no timeout | Emitted unconditionally on TTYs; harmless where unsupported (measured: 1 BSU/ESU pair in the first frame) |
| Cursor | `\u001B[?25l` on first render, `\u001B[?25h` in `log.done()` and on unmount (`cursor-helpers.js`, `log-update.js`) | Restored on normal unmount and via `signal-exit` |
| Alternate screen | `alternateScreen` option writes `\u001B[?1049h` (+hide cursor) and `\u001B[?1049l` on unmount; "The terminal's scrollback buffer is not available while in the alternate screen" (`build/render.d.ts`) | Reject for the chat TUI (§2.4) |
| Resize | `stdout.on('resize')`; on width decrease `log.clear()` (erase lines, not clear screen) then re-layout (`ink.js` `resized`) | No debounce; one full render per event (§3.2) |
| Clear-screen path | `shouldClearTerminalForFrame`: `wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen || shouldClearOnUnmount`; writes `ansiEscapes.clearTerminal` = `ESC[2J ESC[3J ESC[H` (`ink.js`, `ansi-escapes/base.js`) | The DESIGN §10 height budget is what keeps this at zero |
| Exit hooks | `signalExit(this.unmount, {alwaysLast:false})` (`ink.js`) — signal-exit 3.0.7 | Covers SIGINT/SIGTERM/SIGHUP paths and `process.exit`; not SIGKILL, not a hung loop |
| Suspend to child | `useApp().suspendTerminal(cb)`: erases frame, shows cursor, `CSI < u`, exits alt screen, raw off, 2004 off; resume re-applies and repaints (`ink.js`, `readme.md` §suspendTerminal) | The primitive for `$EDITOR` and for a hand-rolled SIGTSTP handler |
| Text sanitising | `sanitize-ansi.js`: "Preserved: SGR sequences (colors, bold, etc. - end with 'm') and OSC sequences (hyperlinks, etc. - ESC ] or C1 OSC). Stripped: cursor movement, screen clearing" | Ink does **not** stop OSC injection from untrusted text; JevCode's `sanitizeStream` must (§5) |
| Width | `measure-text.js` → `widest-line` 6.0.0 → `string-width` 8.2.2 (Intl.Segmenter graphemes, `ambiguousIsNarrow = true`, RGI emoji = 2, tabs = 0) | Emoji/ZWJ measured correctly; ambiguous glyphs narrow (§4) |
| Colour | `chalk` 5.6.2 vendored `supports-color`: honours `FORCE_COLOR`, `--no-color`, `TERM=dumb`, `CI`, `COLORTERM=truecolor`, `TERM=xterm-kitty|xterm-ghostty|wezterm`, `TERM_PROGRAM=iTerm.app` (≥3 → truecolor) / `Apple_Terminal` (256) — **no `NO_COLOR` check anywhere** (`node_modules/chalk/source/vendor/supports-color/index.js`) | NO_COLOR must be mapped to `FORCE_COLOR=0` by JevCode before the bundle loads (§2.10) |
| CI | `is-in-ci` 2.0.0: `check('CI') || check('CONTINUOUS_INTEGRATION')` where a value of `'0'`/`'false'` does not count | `interactive=false` in CI even on a TTY |
| Window size fallback | `getWindowSize`: if `columns`/`rows` falsy → `terminal-size` 4.0.1, else `80×24` (`utils.js`) | Measured §3.7 |

## 1. Input protocols

### 1.1 Bracketed paste (DECSET 2004)

Spec: "When bracketed paste mode is set, pasted text is bracketed with control sequences so that the
program can differentiate pasted text from typed-in text. When bracketed paste mode is set, the program
will receive: ESC [ 2 0 0 ~ , followed by the pasted text, followed by ESC [ 2 0 1 ~ ." and
"Ps = 2 0 0 4 -> Set bracketed paste mode, xterm." (xterm ctlseqs,
https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt, fetched 2026-09-20).

Edge cases and how Ink handles them (measured 2026-09-20 with `/tmp/jevtui/inkprobe.mjs`, a 2-hook
Ink app under a pty):

- **Chunk split across reads.** `\x1b[200~line1\nli` then 30 ms later `ne2\tTab\x1b[201~` → one
  `PASTE "line1\nline2\tTab" len=15`. The parser returns `pendingFrom(escapeIndex)` when `\x1b[201~` is
  missing and `hasPendingEscape()` returns false for a pending paste, so the 20 ms flush never splits it.
- **Newlines and tabs** arrive verbatim inside the paste (above). A composer must insert them as text,
  never as Enter/Tab keys; `splitBackspaceBytes` deliberately does *not* split `\r`/`\t` "because they can
  legitimately appear inside pasted text" (`input-parser.js`).
- **Very large paste.** 20,003 bytes split in two writes → one `PASTE … len=20003`. Cost is linear
  (`input.indexOf(pasteEnd)` per push over the accumulated `pending`), i.e. O(n²) in the number of chunks
  for a paste of n bytes; at 64 KB and ~4 KB chunks that is 16 scans of ≤64 KB — fine. Claude Code
  collapses pastes ">800 characters or more than three lines" into `[Pasted text #1 +120 lines]` and
  keeps the body in `~/.claude/paste-cache/` (https://code.claude.com/docs/en/terminal-config, fetched
  2026-09-20) — adopt the placeholder idea, keep the body in memory (and the run dir), never in logs.
- **Injection through paste.** Terminals strip ESC from pasted text: Alacritty "Bracketed paste mode now
  filters escape sequences beginning with \x1b" (Version 0.2.1) and "EOT (\x03) escaping bracketed paste
  mode" fixed in 0.12.0 (https://raw.githubusercontent.com/alacritty/alacritty/master/CHANGELOG.md,
  fetched 2026-09-20). Do not rely on it: a paste that contains `\x1b[201~` (e.g. from a non-filtering
  terminal or mosh) would end the paste early and the rest is parsed as keys. Mitigation: run every paste
  through the same C0/C1 filter as command output (§5) and treat any `ESC[`-prefixed key that arrives
  within a few ms after a paste end as suspect (log-free).
- **Without bracketed paste** (Terminal.app profiles with it off, `TERM=dumb` terminals, some IDE
  consoles) a multi-line paste arrives as `\r`-separated chunks; `useInput` then sees `return` keys. opencode
  and Claude Code both fall back to timing heuristics; Claude Code documents that "The VS Code integrated
  terminal can drop characters from very large pastes" (terminal-config page above). Adopt a
  fast-typing heuristic: ≥ 3 printable events within one `readable` callback or within 5 ms count as a paste.
- **Ghostty paste protection.** `clipboard-paste-protection` default `true` ("Require confirmation before
  pasting text that appears unsafe … pasting text with newlines") and `clipboard-paste-bracketed-safe`
  default `true` ("If true, bracketed pastes will be considered safe")
  (https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/config/Config.zig, fetched 2026-09-20;
  https://ghostty.org/docs/config/reference, fetched 2026-09-20). Enabling 2004 therefore also removes a
  confirmation dialog for the user.
- **Mode must be turned off** on exit/suspend/crash or the shell shows `00~`/`01~` around pastes
  ("How to fix your terminal prepending 00~ when pasting", https://shivankaul.com/blog/paste-bracketing-iterm2,
  fetched 2026-09-20 via search). Ink writes `\u001B[?2004l` on unmount and in `pauseInput`.

Terminals: xterm, iTerm2, kitty, WezTerm, Alacritty, foot, Ghostty, Windows Terminal all ✅ in the Helix
matrix (Windows Terminal "(borked)" with a link to crossterm#737)
(https://raw.githubusercontent.com/wiki/helix-editor/helix/Terminal-Support.md, fetched 2026-09-20);
tmux passes it through; mosh implemented it 2013-05-29 (PR #430, https://github.com/mobile-shell/mosh/pull/430,
fetched 2026-09-20 via search). Terminal.app: UNVERIFIED (no primary source; commonly on since 10.x).

Test: unit-test the composer reducer with the three chunkings above; pty test with `pty_drive2.py`
writing the split paste; assert exactly one `paste` event and that `\r` inside a paste never submits.

### 1.2 Kitty keyboard protocol

Spec (https://sw.kovidgoyal.net/kitty/keyboard-protocol/ and its source
https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/keyboard-protocol.rst, fetched 2026-09-20):

- Encoding: "CSI unicode-key-code:alternate-key-codes ; modifiers:event-type ; text-as-codepoints u";
  `modifiers = 1 + bits` with shift 1, alt 2, ctrl 4, super 8, hyper 16, meta 32, caps_lock 64,
  num_lock 128; event type 1 press, 2 repeat, 3 release. Functional keys: ESCAPE `27 u`, ENTER `13 u`,
  TAB `9 u`, BACKSPACE `127 u`.
- Query/response: "CSI ? u" → "CSI ? flags u". Push "CSI > flags u", pop "CSI < number u", set
  "CSI = flags ; mode u".
- Flags: 1 Disambiguate escape codes, 2 Report event types, 4 Report alternate keys, 8 Report all keys as
  escape codes, 16 Report associated text (Ink's `kittyFlags` mirror these names).
- Disambiguate rule: "The only exceptions are the Enter, Tab and Backspace keys which still generate the
  same bytes as in legacy mode this is to allow the user to type and execute commands in the shell such as
  reset after a program that sets this mode crashes without clearing it." Shifted variants do become CSI u
  (e.g. Shift+Tab `CSI 9 ; 2 u`; Shift+Enter arrives as `CSI 13 ; 2 u`, which is what opencode documents
  for Windows Terminal: "\u001b[13;2u", https://opencode.ai/docs/keybinds/, fetched 2026-09-20).
- Stack: "Terminals should limit the size of the stack as appropriate, to prevent Denial-of-Service attacks.
  Terminals must maintain separate stacks for the main and alternate screens. If a pop request is received
  that empties the stack, all flags are reset. If a push request is received and the stack is full, the
  oldest entry from the stack must be evicted."
- Detection: "An application can query the terminal for support of this protocol by sending the escape
  code querying for the current progressive enhancement status followed by request for the primary device
  attributes. If an answer for the device attributes is received without getting back an answer for the
  progressive enhancement the terminal does not support this protocol." DA1 is `CSI c` → e.g.
  "CSI ? 1 ; 2 c" / "CSI ? 6 2 ; Ps c" (xterm ctlseqs.txt, fetched 2026-09-20).
- Text/IME: "If no known key is associated with the text the key number 0 must be used … The exact
  behavior in these situations depends on the OS, keyboard layout, IME system in use and so on. In general,
  if the terminal emulator receives no key information, the key number 0 must be used to indicate a pure
  'text event'."
- The spec lists supporting terminals: Alacritty (PR 7125), foot (#319), Ghostty, iTerm2 (gitlab issue
  10017), Rio, WezTerm, xterm.js (PR 5600); the rendered page also lists "Microsoft Terminal".

Measured Ink 7.1.1 behaviour (2026-09-20, `PROBE_KITTY=1 node inkprobe.mjs` under the pty driver):

1. Ink writes `\x1b[?u` **before** the first frame (byte offset 0 of the pty transcript), then
   `\x1b[?2026h`, the frame, `\x1b[?25l`.
2. No response within 200 ms → nothing else; protocol stays off. A response arriving *after* 200 ms
   (`\x1b[?0u` at ~650 ms) was delivered to `useInput` as `KEY "[?0u"` — garbage that a composer would
   insert as text. Over an ssh link with RTT > 200 ms this is the normal case.
3. Response within the window (`\x1b[?0u` at 130 ms): Ink wrote `\x1b[>1u` (push flags=1) **and still
   emitted `KEY "[?0u"` to `useInput`**. Cause: Ink's detector uses `stdin.on('data')` while the App's
   reader uses `'readable'` + `read()`; Node: "If both 'readable' and 'data' are used at the same time,
   'readable' takes precedence in controlling the flow, i.e. 'data' will be emitted only when stream.read()
   is called." (https://nodejs.org/docs/latest-v22.x/api/stream.html, fetched 2026-09-20) — so the same
   chunk is consumed by the key parser *and* seen by the detector.
4. With the protocol on, `\x1b[13;2u` → `KEY "\r" {return, shift, eventType:'press'}`; `\x1b[27u` →
   `{escape}`; `\x1b[9;2u` → `{shift, tab}`; `\x1b[99;5u` → `KEY "c" {ctrl}`. On unmount Ink wrote
   `\x1b[<u` before `\x1b[?25h`. Both push and pop were observed in the transcript
   (`/tmp/jevtui/c2.out`).
5. The kitty regexes run before legacy parsing even when the protocol was never enabled, so a terminal
   that speaks CSI u unprompted (VS Code with `terminal.integrated.enableKittyKeyboardProtocol` on) is
   still decoded.
6. Reply shapes (measured 2026-09-20): CSI-shaped replies arrive in `useInput` as **one** string each —
   `"[?0u"` (kitty), `"[?62;22c"` (DA1), and by the same parser rule a DECRQM reply `CSI ? 2026 ; 2 $ y`
   would be `"[?2026;2$y"` — because `parseCsiSequence` accepts parameter bytes 0x30–0x3f and
   intermediates 0x20–0x2f up to a final 0x40–0x7e. An **OSC-shaped** reply is not parsed at all:
   `ESC ] 11;rgb:1e1e/1e1e/1e1e ESC \` came out as three events `"]"`, `"11;rgb:1e1e/1e1e/1e1e"`, `"\\"`
   (the parser's `parseEscapedCodePoint` takes ESC plus one code point). The same applies to DCS replies
   (XTVERSION `DCS > | text ST`).

Consequences: use `kittyKeyboard: {mode: 'disabled'}` and own the handshake: write `CSI ? u` + `CSI c`
together (spec technique), consume `CSI ? … u` and `CSI ? … c` from the parser output before they reach
the composer (Ink's parser hands them to `useInput` as `[?0u`-style strings, so filter `/^\[\?[\d;]*[uc]$/`
there), never time-box shorter than 1 s, and only then write `CSI > 1 u` (flags 1 only: flag 8 would make
every letter arrive as CSI u and flag 2 would double every key with a release event). Push exactly once,
pop exactly once (`CSI < u`) in every exit path: unmount, `suspendTerminal`, SIGTSTP (§3.3), uncaught
exception, SIGTERM/SIGHUP. Because Enter/Tab/Backspace keep legacy bytes under flag 1, the shell stays
usable after a crash that failed to pop — the spec designed for that.

Terminal matrix for the protocol: kitty ✅ (author); Ghostty ✅ (spec list; Helix ✅); foot 1.10.3
"Kitty keyboard protocol (#319): Report event types, Report alternate keys, Report all keys as escape
codes, Report associated text" (https://codeberg.org/dnkl/foot/raw/branch/master/CHANGELOG.md, fetched
2026-09-20); WezTerm off by default — "`enable_kitty_keyboard = false` … When set to `true`, wezterm will
honor kitty keyboard protocol escape sequences" (https://wezterm.org/config/lua/config/enable_kitty_keyboard.html,
fetched 2026-09-20); Alacritty "Support for kitty's keyboard protocol" (0.13.0) and 0.16.0 fixed
"`Enter`,`Tab`, `Backspace` not disambiguated with `shift` in kitty keyboard's disambiguate mode"
(Alacritty CHANGELOG above) — Claude Code accordingly says "Alacritty 0.16 or later"; iTerm2: kitty spec
lists it; 3.5.0 changelog: "Enabling CSI u mode in your profile does not enable Disambiguate Escapes now.
This additional setting is now exposed in the Terminal State menu." and the CSI u doc says "CSI u mode is
no longer recommended. Applications should implement the Kitty keyboard protocol instead."
(https://iterm2.com/downloads/stable/iTerm2-3_5_0.changelog, https://iterm2.com/documentation-csiu.html,
fetched 2026-09-20); Windows Terminal Preview 1.25 (2026-03-05): "Windows Terminal now ships with built-in
support for Kitty's Keyboard protocol, which allows commandline applications to disambiguate keys such as
Esc from Ctrl+[ and receive information about which modifiers were pressed"
(https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-25-release/, fetched 2026-09-20);
VS Code: xterm.js PR "Implement kitty keyboard protocol (CSI =|?|>|< u)" merged 2026-01-10
(https://github.com/xtermjs/xterm.js/pull/5600, fetched 2026-09-20), shipped in VS Code 1.109 (2026-02-04)
"The Kitty keyboard protocol has been implemented and will be rolling out to stable this release"
(https://code.visualstudio.com/updates/v1_109, fetched 2026-09-20), setting
`terminal.integrated.enableKittyKeyboardProtocol` `default: true`
(https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts,
fetched 2026-09-20); Terminal.app: UNVERIFIED (Claude Code's table puts "Apple Terminal" under "Works
without setup" for Shift+Enter but does not say how); tmux: **no kitty protocol** — it implements xterm
`extended-keys` (see §1.3) and issue "Support for Kitty's keyboard protocol #3335" (2022-09-19) is closed;
its comments could not be read (rate-limited) — UNVERIFIED which resolution.

Test: pty tests that (a) answer `CSI ? 0 u` + `CSI ? 62 c`, (b) answer only `CSI ? 62 c`, (c) answer
nothing for 2 s, (d) answer late; assert push/pop bytes in the transcript and zero garbage in the composer.

### 1.3 xterm modifyOtherKeys (XTMODKEYS) and tmux

"CSI > Pp ; Pv m … Set/reset key modifier options (XTMODKEYS), xterm. … Pp = 4 -> modifyOtherKeys." and
"When modifyOtherKeys is set to 1, the usual shift- and control- modifiers are used … When modifyOtherKeys
is set to 2, all of the modifiers apply. For example, shift-Tab sends CSI 2 7 ; 2 ; 9 ~ rather than CSI Z"
(ctlseqs.txt, fetched 2026-09-20). Values: "0 (Off) … 1 (User) … 2 (Program)"; `formatOtherKeys` 0 →
`CSI 27 ; modifier ; code ~`, 1 → `CSI code ; modifier u`; enable with `CSI > 4 ; 2 m`, reset with
`CSI > 4 m` (https://invisible-island.net/xterm/modified-keys.html, fetched 2026-09-20). Modifier
parameter: 2 Shift, 3 Alt, 4 Shift+Alt, 5 Control, 6 Shift+Control, 7 Alt+Control, 8 Shift+Alt+Control,
9 Meta (same page). Ink's `fnKeyRe` decodes the `CSI 27;m;k~` shape only as a generic function key; a
composer needs its own decoder for `27;mod;13~` (Shift+Enter = `CSI 27;2;13~`).

tmux: "extended-keys [on | off | always] Controls how modified keys … are reported. This is the equivalent
of the modifyOtherKeys xterm(1) resource. When set to on, the program inside the pane can request one of
two modes … When set to always, modes 1 and 2 can still be requested by applications, but mode 1 will be
forced instead of the standard mode. … tmux will always request extended keys itself if the terminal
supports them." and "extended-keys-format [csi-u | xterm] … C-S-a will be reported as `^[[27;6;65~` when
set to xterm, and as `^[[65;6u` when set to csi-u." (https://raw.githubusercontent.com/tmux/tmux/master/tmux.1,
fetched 2026-09-20). History: 3.2 "Add support for extended keys - both xterm(1)'s CSI 27 ~ sequence and
the libtickit CSI u sequence are accepted; only the latter is output"; 3.2a "Add an 'always' value for the
'extended-keys' option"; 3.5 "Revamp extended keys support to more closely match xterm and support mode 2
as well as mode 1 … changes tmux to always request mode 2 from parent terminal"
(https://raw.githubusercontent.com/tmux/tmux/master/CHANGES, fetched 2026-09-20). Claude Code's
recommended tmux config: `set -g allow-passthrough on`, `set -s extended-keys on`,
`set -as terminal-features 'xterm*:extkeys'` (terminal-config page). So inside tmux the app should send
`CSI > 4 ; 2 m` (and reset with `CSI > 4 m` on exit) and expect CSI u *shaped* keys without a kitty
handshake; `CSI ? u` gets no reply.

### 1.4 Shift+Enter / Ctrl+Enter / Alt+Enter without kitty

Legacy encoding table (kitty spec "Legacy key event encoding", fetched 2026-09-20): Enter → `0xd` for
plain, shift and ctrl; `0x1b 0xd` for alt. So without an enhanced protocol Shift+Enter and Ctrl+Enter are
byte-identical to Enter; only Alt/Option+Enter is distinguishable (`ESC CR`, which Ink already decodes:
`s === '\x1b\r'` → `return` with `meta` in `parse-keypress.js`) — and only when the terminal sends Option
as Meta: Terminal.app "Use Option as Meta Key", iTerm2 Left/Right Option "Esc+", VS Code
`"terminal.integrated.macOptionIsMeta": true`, Ghostty `macos-option-as-alt` (Claude terminal-config
page; Ghostty Config.zig "If `true`, the *Option* key will be treated as *Alt*", fetched 2026-09-20).

Claude Code's `/terminal-setup` "writes a Shift+Enter keybinding into the terminal's configuration file"
for "VS Code, Cursor, Devin Desktop, Alacritty before 0.16, and Zed"; the VS Code binding uses
`workbench.action.terminal.sendSequence` with text `"\u001b\r"` (i.e. it fakes Alt+Enter)
(https://code.claude.com/docs/en/terminal-config, fetched 2026-09-20; sequence per
https://kane.mx/posts/2025/vscode-remote-ssh-claude-code-keybindings/ and
https://claudelog.com/faqs/claude-code-terminal-setup/, fetched 2026-09-20 via search — secondary). VS Code
documents the mechanism: `{"key": "ctrl+u", "command": "workbench.action.terminal.sendSequence",
"args": {"text": "\u001b[1;5D\u007f"}}` and "The sendSequence command only works with the \u0000 format"
(https://code.visualstudio.com/docs/terminal/advanced, fetched 2026-09-20). Since VS Code 1.109 the kitty
path exists too, so the binding is a fallback for older VS Code/Cursor forks.

opencode's defaults: `"input_submit": "return"`, `"input_newline": "shift+return,ctrl+return,alt+return,ctrl+j"`,
`"session_interrupt": "escape"`, `"app_exit": "ctrl+c,ctrl+d,<leader>q"`, `"input_clear": "ctrl+c"`
(https://opencode.ai/docs/keybinds/, fetched 2026-09-20). Claude Code: "press Ctrl+J, or type `\` and then
press Enter. Both work in every terminal with no setup." Adopt all three universal newline paths
(Ctrl+J = `0x0a`, which Ink names `enter` as opposed to `return` = `0x0d`; backslash-Enter; Alt+Enter) plus
Shift/Ctrl+Enter when a protocol delivers them.

### 1.5 Esc ambiguity and escape timeouts

"Esc key generates the byte 0x1b which also is used to indicate the start of an escape code" (kitty spec).
Reference timeouts: neovim `'ttimeoutlen' 'ttm' number (default 50)` — "Time in milliseconds to wait for a
key code sequence to complete" (https://raw.githubusercontent.com/neovim/neovim/master/runtime/doc/options.txt,
fetched 2026-09-20); Node readline `const ESCAPE_CODE_TIMEOUT = 500;`
(https://raw.githubusercontent.com/nodejs/node/v22.x/lib/internal/readline/interface.js, fetched 2026-09-20);
tmux "escape-time time Set the time in milliseconds for which tmux waits after an escape is input" and
3.5 "Reduce default escape-time to 10 milliseconds" (tmux.1, CHANGES, fetched 2026-09-20); Ink 20 ms.

Measured (2026-09-20, `pty_drive2.py`, Ink 7.1.1): ESC then `x` after 5 / 12 / 18 ms → `KEY "x" {meta}`
(Alt+x); after 25 / 40 ms → `{escape}` then `x`. Split arrow `ESC[` + `A` after 5 / 15 ms → `{upArrow}`;
after 25 ms → `KEY "["` then `KEY "A" {shift}` (garbage). So Ink's fixed 20 ms is tight compared with
neovim's 50 and tmux's forwarding path (10 ms default, extended to 500 ms while requests are pending: 3.7
"Reduce request timeout to 500 milliseconds to match the extended escape-time"). A real terminal writes a
whole sequence in one `write(2)` and ssh preserves that in one segment, so splits are rare; they happen
under mosh/tmux re-encoding or TCP fragmentation. Handling: (1) treat a bare `escape` key as "cancel /
interrupt" only on key-up semantics we do not have, so require Esc to be *followed by ≥ 50 ms of silence*
in our own layer (re-buffer Ink's `escape` event for 30 ms and drop it if the next event is a printable
that completes an Alt-chord) — this recovers the 25–50 ms window; (2) never bind destructive actions to a
single Esc (Claude Code uses `Esc` = interrupt, `Esc Esc` = clear draft/rewind:
https://code.claude.com/docs/en/interactive-mode, fetched 2026-09-20); (3) under kitty flag 1, Esc is
`CSI 27 u` and the ambiguity vanishes — another reason to negotiate it.

### 1.6 Control bytes under raw mode: Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+S/Q, Ctrl+L

What Node's raw mode really changes (libuv, `UV_TTY_MODE_RAW`): `tmp.c_iflag &= ~(BRKINT | ICRNL | INPCK
| ISTRIP | IXON); tmp.c_oflag |= (ONLCR); tmp.c_cflag |= (CS8); tmp.c_lflag &= ~(ECHO | ICANON | IEXTEN
| ISIG); tmp.c_cc[VMIN] = 1; tmp.c_cc[VTIME] = 0;` and the original is saved for `uv_tty_reset_mode()`
(https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/tty.c, fetched 2026-09-20). Measured with
`stty -a` before/after `setRawMode(true)` in a pty (2026-09-20): `icanon isig iexten echo` → off,
`icrnl ixon brkint` → off; `opost onlcr` stay on; `ixany imaxbel` stay on. Node docs: "Ctrl+C will no
longer cause a SIGINT when in this mode" (https://nodejs.org/docs/latest-v22.x/api/tty.html, fetched
2026-09-20).

Measured byte delivery (2026-09-20): `0x04` (Ctrl+D), `0x13 0x11` (Ctrl+S, Ctrl+Q), `0x1a` (Ctrl+Z) all
arrive as `data`; none is interpreted by the line discipline. Therefore: IXON is off, so Ctrl+S never
freezes the display and Ctrl+Q is a free key; Ctrl+Z does not stop the process (see §3.3 for
implementing it ourselves); Ctrl+D is a normal key. Readline semantics to copy: "end-of-file (usually C-d)
The character indicating end-of-file as set, for example, by stty." and "delete-char (C-d) Delete the
character at point. If this function is bound to the same character as the tty EOF character, as C-d
commonly is, see above for the effects." (https://tiswww.case.edu/php/chet/readline/readline.html, fetched
2026-09-20) — i.e. Ctrl+D on an **empty** composer = exit (ask to confirm if a run is active, like Claude
Code's "Ctrl+D Exit Claude Code session"), on non-empty = delete-forward. Ctrl+L: readline "clear-screen
(C-l) Clear the screen, then redraw the current line"; for a `<Static>`-based Ink TUI a true clear would
wipe scrollback semantics, so Ctrl+L should mean "force a full repaint of the dynamic region" (Ink:
`instance.clear()` then re-render — `clear()` uses `eraseLines`, not `ESC[2J`, and keeps the zero-clear
gate intact) and never emit `ESC[2J`/`ESC[3J`. Ctrl+C: Ink delivers it as `key.ctrl && input==='c'`
(`exitOnCtrlC:false`); opencode maps Ctrl+C to clear-input-then-exit, Claude Code to "Interrupt, or clear
input"; keep JevCode's two-press semantics from DESIGN §11 (first press aborts the step, second exits).

### 1.7 IME composition

Terminals commit IME text as ordinary bytes after composition; the app never sees pre-edit text. Under
kitty flag 16 the text rides in the `text-as-codepoints` field with key `0` for pure text events (spec
quote in §1.2). Because JevCode negotiates flag 1 only, IME text arrives as plain UTF-8 chunks, often
several code points per chunk (a CJK word or an emoji ZWJ sequence). Handle: treat any multi-code-point
chunk without ESC as text insertion (not as N keys), and do word/cursor logic on grapheme clusters (§4).
Edge: dead keys on macOS send nothing until the second key; Alt+letter with Option-as-Meta off sends
`å`-style text with no modifier ("the alt modifier is consumed by the OS itself", kitty spec) — do not
try to detect Alt from such text.

## 2. Output protocols

### 2.1 Synchronized output (DEC private mode 2026)

"BSU (begin synchronized update, `CSI ? 2026 h`), and ESU (end synchronized update, `CSI ? 2026 l`)";
query "Use `CSI ? 2026 $ p` … If you get nothing back (DECRQM not implemented at all) or you get back a
`CSI ? 2026 ; 0 $ y` then synchronized output is not supported"; reply values 0 not recognized, 1 set,
2 reset, 3 permanently set, 4 permanently reset; timeout: "So far there is no real concensus if and if so
how long a timeout should be." Support list in the spec repo: Alacritty, foot, ghostty, iTerm2, Kitty,
Wezterm, Windows Terminal (wt#18826), xterm.js (#3375)
(https://raw.githubusercontent.com/contour-terminal/vt-extensions/master/synchronized-output.md, fetched
2026-09-20). Also: Alacritty 0.13.0 "Synchronized updates now use `CSI 2026`"; foot 1.8.0 "Support for
DECSET/DECRST 2026"; iTerm2 3.5.0 "Add DECSET 2026 for synchronized updates."; WezTerm "DECSET 2026 is set
to batch (hold) rendering until DECSET 2026 is reset" (https://raw.githubusercontent.com/wezterm/wezterm/main/docs/escape-sequences.md,
fetched 2026-09-20); tmux 3.7 "Add support for applications to use synchronized output mode (DECSET 2026)"
and "Respond to DECRQM 2026" (CHANGES). Terminal.app: absent from every list — UNVERIFIED/assume no.

Ink already brackets every frame (`shouldSynchronize`) without querying. A terminal that implements
`CSI ? 2026 h` but never sees the `l` (crash between BSU and ESU) may freeze until its own timeout; Ink's
writes are synchronous string concatenations so the pair is always in one `write`, except in
`renderInteractiveFrame`'s `hasStaticOutput` branch where BSU, static, frame and ESU are four writes —
still same tick. Keep it; add ESU (`\x1b[?2026l`) to the crash-restore string (§3.5) so a frozen terminal
is released.

### 2.2 Focus in/out (1004)

"Ps = 1 0 0 4 -> Send FocusIn/FocusOut events, xterm." and "it causes xterm to send CSI I when the terminal
gains focus, and CSI O when it loses focus." (ctlseqs.txt). foot 1.26.0: "When enabling 'focus mode'
(private mode 1004), foot now sends a focus event immediately, to inform the application what the current
state is" (foot CHANGELOG); tmux `focus-events [on | off]` "focus events are requested from the terminal if
supported and passed through … Attached clients should be detached and attached again after changing this
option." (tmux.1); iTerm2 3.5.0 "Squelch audible beeps when focus reporting is the likely cause."
Helix matrix ✅ for Alacritty, kitty, WezTerm, foot, Rio, Windows Terminal, iTerm2, Warp, GNOME, Ghostty.
Use: suppress notifications while focused (Ghostty has its own `desktop-notifications.inhibit-when-focused`
analogue in foot), pause the spinner when unfocused to cut ssh traffic. Measured 2026-09-20: Ink's `useInput`
receives them as `input === "[I"` / `"[O"` with no key flags — filter exactly those two strings before
the composer, and treat `[I` as "focused" state for the notification policy. Turn off (`CSI ? 1004 l`)
in every exit path or the shell receives `^[[I` on every focus change.

### 2.3 Mouse reporting (1000/1002/1006) versus text selection

"Ps = 1 0 0 0 -> Send Mouse X & Y on button press and release", "1 0 0 2 -> Use Cell Motion Mouse
Tracking", "1 0 0 6 -> Enable SGR Mouse Mode"; SGR: "CSI < followed by semicolon-separated encoded button
value, Px and Py ordinates and a final character which is M for button press and m for button release";
wheel: "Wheel mice may return buttons 4 and 5. Those buttons are represented by the same event codes as
buttons 1 and 2 respectively, except that 64 is added to the event code. Release events for the wheel
buttons are not reported." and "By default, the wheel mouse events (buttons 4 and 5) are translated to
scroll-back and scroll-forw actions" (ctlseqs.txt, fetched 2026-09-20). kitty: "`grabbed` refers to when
the program running in the terminal has requested mouse events" and selection then needs a modifier
(https://sw.kovidgoyal.net/kitty/conf/, fetched 2026-09-20; the default `mouse_map` lines were truncated in
my fetch — UNVERIFIED wording). iTerm2 profile: "Enable mouse reporting: If selected, applications may
choose to receive information about the mouse." and "Report mouse wheel events: If disabled, the mouse
wheel will always perform its default action (such as scrolling history)."
(https://iterm2.com/documentation-preferences-profiles-terminal.html, fetched 2026-09-20).

Verdict for a scrollback-based chat TUI: **do not enable mouse reporting.** With any of 1000/1002 on, the
wheel stops scrolling the terminal's own history (the transcript lives there via `<Static>`) and
click-drag selection needs Shift/Option in most terminals; Claude Code's fullscreen mode has to reimplement
scrolling and copy for exactly this reason (terminal-config "In this mode you scroll with the mouse or
PageUp inside Claude Code rather than with your terminal's native scrollback"). Ink's parser has no mouse
decoder; if a terminal sends SGR mouse anyway (leftover mode from a crashed program) each report arrives in
`useInput` as one string — measured `KEY "[<64;10;5M"` for a wheel-up at (10,5) — so filter
`/^\[<\d+;\d+;\d+[Mm]$/` as noise.

### 2.4 Alternate screen (1049)

"Ps = 1 0 4 9 -> Save cursor as in DECSC, xterm. After saving the cursor, switch to the Alternate Screen
Buffer, clearing it first." / "Use Normal Screen Buffer and restore cursor as in DECRC" (ctlseqs.txt).
Ink: `render({alternateScreen:true})`, "Note: The terminal's scrollback buffer is not available while in
the alternate screen" (`render.d.ts`). Pros: no clear-path flicker, arbitrary layouts. Cons: transcript not
searchable/copyable with native tools, lost on exit unless replayed, kitty keyboard stack is per screen
(spec §1.2). Claude Code only offers it as an opt-in fix ("/tui fullscreen") and provides a `[` key to
"Write the full conversation to your terminal's native scrollback". REJECT for the default JevCode TUI;
keep the `<Static>` + `rows − 2` budget (DESIGN §10), which measured 0 `ESC[2J` at 5×20 and 0×0 (§3.7).

### 2.5 OSC 52 clipboard

"Ps = 5 2 -> Manipulate Selection Data. … Pt is parsed as Pc ; Pd. The first, Pc, may contain zero or more
characters from the set c , p , q , s , 0 , 1 , 2 , 3 , 4 , 5 , 6 , and 7 … The second parameter, Pd, gives
the selection data. Normally this is a string encoded in base64 (RFC-4648) … If the second parameter is a
? , xterm replies to the host with the selection data" (ctlseqs.txt). Support: kitty ✅ (`clipboard_control`);
WezTerm "Manipulate clipboard: Requests to query the clipboard are ignored. Allows setting or clearing the
clipboard" (escape-sequences.md); foot `c` clipboard, `s`/`p` primary, `security.osc52` option (1.20.0)
(foot ctlseqs/CHANGELOG); Alacritty write ✅, "OSC 52 paste ability is now disabled by default" (0.13.0),
"OSC 52 is now disabled on unfocused windows" (0.11.0); Ghostty `clipboard-write` default `allow`,
`clipboard-read` default `ask` ("system clipboard (OSC 52, for googling)", Config.zig); iTerm2 needs
"Applications in terminal may access clipboard" (Claude terminal-config: `/terminal-setup` "enables
'Applications in terminal may access clipboard' … so the `/copy` command can write to your system
clipboard") and 3.5.0 "Clipboard content reporting via control sequence OSC 52 is now supported, but
requires user consent"; VS Code added OSC 52 in June 2024 via `@xterm/addon-clipboard` but "silently
ignored when connected via Remote SSH" (https://github.com/microsoft/vscode-remote-release/issues/11475,
fetched 2026-09-20 via search — secondary); Windows Terminal ✅ per Helix "Set OS Clipboard"; Terminal.app
absent from every list — assume ✗. tmux: "set-clipboard [on | external | off] Attempt to set the terminal
clipboard content using the xterm(1) escape sequence, if there is an Ms entry in the terminfo(5)
description … If set to external, tmux will attempt to set the terminal clipboard but ignore attempts by
applications to set tmux buffers." (tmux.1) — default `external` since 2.6 (CHANGES), so an app inside tmux
needs either `set -s set-clipboard on` or the passthrough wrapper. opencode does both:
`` const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07` `` and
`` const passthrough = `\x1bPtmux;\x1b${sequence}\x1b\\` `` written when `process.env.TMUX`
(https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/clipboard.ts, fetched
2026-09-20); it also falls back to `pbcopy`/`wl-copy`/`xclip`. Adopt: `/copy` writes OSC 52 (never a read
`?`, which prompts or is denied), plus `pbcopy` on macOS via `spawn` with the text on stdin; wrap in
`DCS tmux; ESC … ST` with ESC doubled when `TMUX` is set ("allow-passthrough … using a terminal escape
sequence (\ePtmux;...\e\e)", tmux.1). Cap payload at 64 KiB base64 (kitty rejects invalid base64;
terminals have limits) and never put secrets on the clipboard without the redactor.

### 2.6 OSC 8 hyperlinks

Format "OSC 8 ; params ; URI ST" … close "OSC 8 ; ; ST"; "Both VTE and iTerm2 limit the URI to 2083
bytes"; terminals that parse OSC per ECMA-48 ignore it safely (https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda,
fetched 2026-09-20). Adoption: Alacritty since v0.11 (2022-10-13), foot 1.7.0, Ghostty 2024-07-07,
iTerm2 3.1, kitty 0.19, WezTerm since 2018, Windows Terminal v1.4, xterm.js 5.0 / VS Code 1.72, tmux since
3.4 "Requires user to add `set -ga terminal-features "*:hyperlinks"`"; Terminal.app is not in the list
(https://raw.githubusercontent.com/Alhadis/OSC8-Adoption/master/README.md, fetched 2026-09-20). Ink's
`sanitizeAnsi` passes OSC through, so `\u001B]8;;file:///…\u0007path\u001B]8;;\u0007` inside `<Text>`
works, and `ansi-escapes` (Ink dependency, not ours) uses BEL as terminator. Adopt for file paths in the
transcript with `file://` URIs only when `TERM_PROGRAM`/`TERM` is in the adoption list, never for
untrusted URLs (an attacker-controlled URI in a proposal text is a phishing vector: emit paths we
resolved ourselves). Use `ESC \` as ST for tmux compatibility, BEL elsewhere is also accepted.

### 2.7 Desktop notifications: BEL, OSC 9, OSC 777, OSC 99

- BEL: "BEL Bell (BEL is Ctrl-G)" (ctlseqs.txt). Universal; iTerm2 posts Notification Center alerts for
  the bell when "Notification Center alerts" is on ("iTerm2 will post a notifications when sessions
  receive output, become idle, ring the bell, close, or get a proprietary escape sequence", iTerm2 profile
  docs); Claude Code's `/terminal-setup` "turns off the audible bell in your Apple Terminal profile".
- OSC 9 (iTerm2): "To post a notification: OSC 9 ; [Message content goes here] ST"
  (https://iterm2.com/documentation-escape-codes.html, fetched 2026-09-20); kitty "also supports the legacy
  OSC 9 protocol developed by iTerm2" (https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/desktop-notifications.rst,
  fetched 2026-09-20); foot 1.8.0 "OSC 9 desktop notifications (iTerm2 compatible)"; WezTerm "iTerm2 Show
  System Notification … `printf "\e]9;%s\e\\" "hello there"`"; Ghostty `desktop-notifications` default
  `true`: "applications running in the terminal can show desktop notifications using certain escape
  sequences such as OSC 9 or OSC 777" (Config.zig). Conflict: ConEmu/Windows Terminal use `OSC 9;4` for
  progress bars — Ghostty issue "ConEmu progress reports (OSC9) conflict with desktop notifications (OSC 9)
  and show spurious notifications" (#3119, title via search 2026-09-20); foot 1.20.0 "OSC-9:
  sequences beginning with `<number>;` are now ignored. These sequences are ConEmu/Windows Terminal
  sequences, and not intended to be notifications." (CHANGELOG). Never start an OSC 9 payload with a
  digit and semicolon.
- OSC 777 (urxvt): foot `\E] 777;notify;_title_;_msg_ \E\\`; WezTerm "Only the notify extension is
  supported"; Ghostty ✅ (above).
- OSC 99 (kitty): "<OSC> 99 ; metadata ; payload <terminator>", example `printf '\x1b]99;i=1:d=0;Hello
  world\x1b\\'` + `printf '\x1b]99;i=1:p=body;This is cool\x1b\\'`, query with `p=?`
  (https://sw.kovidgoyal.net/kitty/desktop-notifications/, fetched 2026-09-20); foot 1.18.0 "Support for
  OSC-99"; Ghostty parser support UNVERIFIED (discussion #10998 only).
- Delivery through tmux needs `allow-passthrough on` (Claude terminal-config: "The allow-passthrough line
  lets notifications and progress updates reach the outer terminal").
- Claude Code policy: "By default Claude Code sends a desktop notification only in Ghostty, Kitty, and
  iTerm2. In other terminals, set preferredNotifChannel to 'terminal_bell'" and iTerm2 needs "Filter
  Alerts" → "Send escape sequence-generated alerts".

Adopt: on `confirm:request` and `run:end` when the terminal reported FocusOut (or when focus is unknown
and the event is a confirm), emit BEL by default; emit OSC 9 additionally when `TERM_PROGRAM` ∈
{iTerm.app, ghostty, WezTerm} or `TERM` ∈ {xterm-kitty, xterm-ghostty, foot*}; OSC 99 for kitty; wrap in
tmux passthrough when `TMUX` is set. Payload = redacted one-liner ("JevCode: review needed, step 7").

### 2.8 Cursor shape (DECSCUSR) and visibility (25)

"Set cursor style (DECSCUSR), VT520. Ps = 0 -> blinking block. Ps = 1 -> blinking block (default). Ps = 2 ->
steady block. Ps = 3 -> blinking underline. Ps = 4 -> steady underline. Ps = 5 -> blinking bar, xterm.
Ps = 6 -> steady bar, xterm. Ps = 7 -> initial resources, xterm." and "Ps = 2 5 -> Show cursor (DECTCEM)"
/ "Hide cursor (DECTCEM)" (ctlseqs.txt). foot: "In foot, Ps=0 means 'use style from foot.ini'" (foot
ctlseqs). Ink hides the cursor for the whole session and re-shows on exit; a composer needs a visible caret:
Ink 7.1 provides `useCursor`/`setCursorPosition` (`hooks/use-cursor.js`, `cursor-helpers.js`
`buildCursorSuffix` moves the real cursor and writes `\u001B[?25h`). Use the real cursor (IME candidate
windows anchor to it) rather than a drawn block. Set `CSI 6 SP q` (steady bar) on start and restore with
`CSI 0 SP q` on exit — value 0 is the safe "terminal default" across xterm/foot; never leave a bar cursor
in the shell.

### 2.9 Terminal title (OSC 0/2)

"Ps = 0 -> Change Icon Name and Window Title to Pt." / "Ps = 2 -> Change Window Title to Pt." (ctlseqs.txt);
WezTerm "Set Icon Name and Window Title" and "Set Window Title" supported; Ghostty reference lists OSC 0 and
OSC 2 (https://ghostty.org/docs/vt/reference, fetched 2026-09-20). Titles are not restorable (xterm has
XTPUSHSGR-style title stacks `CSI 22;0 t` / `CSI 23;0 t` but support is uneven — UNVERIFIED matrix).
Adopt: set `OSC 2 ; jevcode: <task head> ST` only when `TERM_PROGRAM`/`TERM` is known and the user has not
disabled it; on exit write `OSC 2 ; ST` (empty) — imperfect, so keep it opt-in (`--title`), default off.

### 2.10 Colour capability: NO_COLOR, FORCE_COLOR, COLORTERM, CLICOLOR, TERM=dumb, CI

- NO_COLOR: "Command-line software which adds ANSI color to its output by default should check for a
  NO_COLOR environment variable that, when present and not an empty string (regardless of its value),
  prevents the addition of ANSI color." and "User-level configuration files and per-instance command-line
  arguments should override the NO_COLOR environment variable." (https://no-color.org/, fetched 2026-09-20).
- Node `getColorDepth` order (https://raw.githubusercontent.com/nodejs/node/v22.x/lib/internal/tty.js,
  fetched 2026-09-20): `FORCE_COLOR` ('' / '1' / 'true' → 16, '2' → 256, '3' → 16m, anything else → 2);
  then `NODE_DISABLE_COLORS`, `NO_COLOR`, `TERM === 'dumb'` → 2; win32 by build; `TMUX` → 16m;
  `TF_BUILD`+`AGENT_NAME` → 16; `CI` → per-vendor map else 2; `TERM_PROGRAM` `iTerm.app` (version < 3 → 256
  else 16m), `HyperTerm`/`MacTerm` → 16m, `Apple_Terminal` → 256; `COLORTERM` truecolor/24bit → 16m;
  `TERM` `/truecolor/` → 16m, `^xterm-256` → 256, known names → 16; `COLORTERM` set → 16; else 2.
  Measured 2026-09-20 in a pty: `TERM=xterm-ghostty` → **4** (Node does not know Ghostty; chalk does),
  `TERM=xterm-kitty` → 24, `CI=1` → 1, `NO_COLOR=1 COLORTERM=truecolor` → 1, `FORCE_COLOR=0` → 1,
  `FORCE_COLOR=3 TERM=dumb` → 24, `TMUX` set → 24, `TERM_PROGRAM=Apple_Terminal` → 8. On a pipe
  `process.stdout.getColorDepth` **does not exist** (`TypeError: process.stdout.getColorDepth is not a
  function`) — guard with `typeof`.
- chalk (inside Ink) ignores `NO_COLOR` (§0) but honours `FORCE_COLOR`; `envForceColor()` reads
  `process.env` at call time inside `_supportsColor`, which chalk runs at module evaluation. In the single
  esbuild bundle that happens during `import('../dist/jevcode.mjs')`, so `bin/jevcode.js` (which already
  runs before the import) must translate: `if ('NO_COLOR' in env && env.NO_COLOR !== '' && !('FORCE_COLOR' in env)) env.FORCE_COLOR = '0'`
  and `CLICOLOR_FORCE=1` → `FORCE_COLOR=1` when unset (CLICOLOR is a BSD convention with no primary spec
  fetched — UNVERIFIED; treat `CLICOLOR=0` like NO_COLOR). `--color`/`--no-color` flags are already parsed
  by chalk's `hasFlag`, and per no-color.org flags win.
- Truecolor vs 256: Terminal.app "doesn't support truecolor" as of macOS 12.5 (Helix wiki) but macOS 26
  Tahoe's Terminal "will support 24-bit color and Powerline fonts" (MacRumors 2025-06-16,
  https://www.macrumors.com/2025/06/16/apples-terminal-app-macos-tahoe/, fetched 2026-09-20 via search —
  secondary; Apple's own "What's new" page did not state it when fetched). Use Ink `<Text color>` with
  named ANSI colours by default and hex only when depth ≥ 24; chalk downsamples automatically.
- Background detection for theme: `OSC 11 ; ? ST` → reply of the same form ("If a '?' is given rather than
  a name or RGB specification, xterm replies with a control sequence of the same form", ctlseqs.txt);
  Ghostty `osc-color-report-format` default `16-bit` (`rrrr/gggg/bbbb`), `none` disables replies (Config.zig).
  Measured 2026-09-20: through Ink the reply is shredded into three `useInput` strings (§1.2 item 6), so
  either (a) do not send OSC-shaped queries at all and accept an unknown background (default `dark`,
  `--theme light` flag), or (b) insert a demux `Readable` between `process.stdin` and Ink that strips
  complete `ESC ] … ESC \`/`BEL` and `ESC P … ESC \` replies before Ink's parser sees them (it must proxy
  `isTTY`, `setRawMode`, `setEncoding`, `ref`/`unref`, `read`, `'readable'`). CSI-shaped queries (kitty,
  DA1, `CSI ? 2026 $ p`) are safe to send together and to filter in `useInput`; never block the first frame
  on any reply; parse both 8- and 16-bit colour forms if (b) is built.

## 3. Process and terminal lifecycle

### 3.1 What to restore, and in what order

Exit string (one `write`, idempotent): `ESC[<u` (only if pushed) · `ESC[>4m` (only if XTMODKEYS set) ·
`ESC[?1004l` · `ESC[?2004l` · `ESC[?2026l` · `ESC[0 q` · `ESC[?25h` · `ESC[0m` · `\r\n` when the cursor is
mid-line. Then `stdin.setRawMode(false)` (libuv restores the saved termios). Node's default SIGINT/SIGTERM
handlers "reset the terminal mode before exiting with code 128 + signal number. If one of these signals
has a listener installed, its default behavior will be removed" (https://nodejs.org/docs/latest-v22.x/api/process.html,
fetched 2026-09-20) — JevCode installs listeners (DESIGN §11), so it must call `uv_tty_reset_mode`'s JS
equivalent itself: `process.stdin.setRawMode(false)` (synchronous) in the `'exit'` handler, where
"Listener functions must only perform synchronous operations" (same page).

### 3.2 SIGWINCH and resize storms

"'SIGWINCH' is delivered when the console has been resized." (process docs); "The 'resize' event is
emitted whenever either of the writeStream.columns or writeStream.rows properties have changed." (tty docs,
fetched 2026-09-20). Measured 2026-09-20: 30 `TIOCSWINSZ`+SIGWINCH changes 2 ms apart → **30** `resize`
events (Node coalesces nothing); Ink runs `calculateLayout()` + `onRender()` per event and on width
decrease `log.clear()` first. Mitigation: debounce at the App level — recompute layout from
`stdout.columns/rows` on a 50 ms trailing timer (drag-resizing produces a burst per pixel step), render
once with the final size; Ink's own `resized` still fires per event, but its render is bounded by `maxFps`
(30 → 34 ms throttle, `renderThrottleMs`). The height budget must be re-evaluated from the *new* rows before
Ink's next frame, or one oversized frame triggers `clearTerminal`; DESIGN §10 already reads
`useWindowSize()` synchronously — keep the budget computed inside render from the same `rows` Ink uses.
foot's mode 2048 "In-band window resize notifications" (1.21.0) would deliver size via the input stream
(ssh-safe) — parse `CSI 48 ; rows ; cols ; … t` if seen, but do not enable (matrix too thin).

### 3.3 SIGTSTP / SIGCONT (Ctrl+Z)

Under raw mode `ISIG` is off, so Ctrl+Z is the byte `0x1a` (measured §1.6); an external `kill -TSTP`
still stops the process. Measured 2026-09-20: with a handler that calls `setRawMode(false)` and
`process.kill(process.pid, 'SIGSTOP')`, the pty's termios read from the master showed `icanon=1 isig=1
echo=1 ixon=1` while stopped and after SIGCONT, and `process.stdin.isRaw` was `false` on SIGCONT — i.e.
nothing re-enables raw mode for us. bash restores its *own* saved tty state around foreground jobs
("Save the tty settings before we start the job in the foreground." … `save_stty = shell_tty_info` …
`shell_tty_info = save_stty; set_tty_state ();`, https://git.savannah.gnu.org/cgit/bash.git/plain/jobs.c,
fetched 2026-09-20), so an app that leaves raw mode on when stopping gets a cooked shell only because bash
fixes it; other launchers (`nohup`, CI runners, `script`) do not. Implementation: `process.on('SIGTSTP')`
→ `suspendTerminal()` semantics without a child (erase frame, exit string §3.1, raw off) → `SIGSTOP` self;
`process.on('SIGCONT')` → re-run the same enable sequence as startup (raw on, 2004 on, kitty push, 1004 on)
→ force a full repaint (Ink's `endSuspend` resets `lastOutput` and calls `onRender`; expose it through
`useApp().suspendTerminal()` returning a suspension whose `resume()` we call on SIGCONT). Map the `0x1a`
key to the same handler so Ctrl+Z works as users expect (Claude Code: "Ctrl+Z Suspend Claude Code").

### 3.4 SIGHUP, EIO and EPIPE (terminal window closed, ssh dropped)

"'SIGHUP' … on non-Windows platforms, the default behavior of SIGHUP is to terminate Node.js, but once a
listener has been installed its default behavior will be removed." (process docs). Measured 2026-09-20:
closing the pty master with raw mode on produced, in order, `stdin end`, then the `SIGHUP` handler ran,
exit code 129 — **but only when `stdin`/`stdout` had `'error'` listeners**; the first run without them
never reached the handler because a write to the dead pty raised an unhandled `EIO` error first. Rules:
install `process.stdout.on('error')`/`stderr.on('error')`/`stdin.on('error')` that swallow `EIO`/`EPIPE`
and mark the terminal dead; in the SIGHUP/`end` path write the checkpoint (DESIGN §11 `shutdown('signal')`),
never write to the terminal, exit 129. `'SIGPIPE' is ignored by default` (process docs) so `--plain | head`
surfaces as `EPIPE` on write, same handler.

### 3.5 Crash restore

`signal-exit` 3.0.7 runs Ink's `unmount` on `process.exit`, uncaught fatal paths that reach `process.exit`,
and the signals it hooks (`node_modules/signal-exit/index.js`, `signals.js`); `unmount` writes `CSI < u`,
exits the alternate screen, `log.done()` shows the cursor, App cleanup disables raw mode and writes
`\u001B[?2004l`. Gaps: a `SIGKILL`, an OOM abort, or a hung event loop leave raw mode + 2004 + kitty flags
on. Mitigation A: JevCode's `fatal()` writes the exit string §3.1 synchronously before Ink runs. Mitigation
B (spawned-parent pattern): not possible with one process and one bundle without a second `node` — reject;
instead document `reset`/`stty sane` in the error message that `bin/jevcode.js` prints when it catches a
bundle-load failure. The kitty exception for Enter (§1.2) is what keeps `reset` typeable.

### 3.6 TERM=dumb, missing TERM, CI, and TTY combinations

- `TERM=dumb`: Node depth 1 (measured), chalk level 0 unless `FORCE_COLOR`; terminals with `TERM=dumb`
  (Emacs `M-x shell`, some IDE consoles) do not move cursors: force `--plain` when `TERM === 'dumb'` even if
  `isTTY`. Missing `TERM` → Node depth 1 (measured); treat as xterm for sequences but no colour.
- CI: Ink `interactive=false` when `CI` is set (is-in-ci), and then "disables ANSI erase sequences, cursor
  manipulation, synchronized output, resize handling, and kitty keyboard auto-detection, writing only the
  final frame at unmount" (`render.d.ts`). JevCode already prefers `--plain` when not both TTYs; add `CI`.
- stdout TTY but stdin not (`echo task | jevcode run`): no raw mode, no keys; today's `createTuiRenderer`
  auto-declines confirms with `IDENTITY_NO_TTY`. Keep, but also skip the kitty/DA1/OSC 11 queries (answers
  would never arrive) and skip 2004/1004.
- stdin TTY but stdout not (`jevcode run … > log`): Ink `interactive=false`; must not set raw mode (the user
  cannot see the composer). Rule: composer requires `stdin.isTTY && stdout.isTTY && !CI && TERM !== 'dumb'`.
- `process.stdout.isTTY` is `undefined` (not `false`) on a pipe (measured: property absent) — use `Boolean()`.

### 3.7 Zero/undefined/tiny/huge sizes

Measured 2026-09-20: a pty with `TIOCSWINSZ` 0×0 gives `columns: 0, rows: 0`, `getWindowSize() = [0,0]`;
Ink's `getWindowSize` falls through to `terminal-size` 4.0.1 which returned `{columns:0, rows:0}` in 0.13 ms
(no spawn on a TTY), then Ink defaults to `80×24`; with `COLUMNS=100 LINES=30` in env it returned
`100×30` in 0.03 ms; on a pipe it took 7.12 ms and returned 80×24 (it may exec `tput`/`stty` there — the
source imports `execFileSync` with `timeout: 500`; TTY path never hits it). The built `dist/jevcode.mjs`
rendered its first frame at 0×0 (as 80×24) and at 5×20 in ~73 ms with **0** `ESC[2J`, 1 BSU/ESU pair, one
hide-cursor (transcript at `/tmp/jevtui/ff5x20.out`, `ff0x0.out`). At 5 rows the budget is 3 dynamic rows
(status, rule, one live row); the composer must be allowed to take the whole budget below ~8 rows and hide
the decisions pane; below 3 rows render only the status line. Huge widths (≥ 500 columns) are cheap for
Ink (Yoga layout is per node, not per column) but string building of `RULE_CHAR.repeat(columns)` and
`wrap-ansi` on long lines cost O(columns) per frame — cap the rule at `min(columns, 400)`, and wrap
transcript items once at commit time (they are `<Static>`), not per frame.

## 4. Unicode width

- Node 22.23.2 has `Intl.Segmenter` (grapheme and word) with ICU 78.2 / Unicode 17.0 (measured
  `process.versions`). Measured grapheme counts: `é` 1, `👍🏽` 1, `👨‍👩‍👧‍👦` (7 code points) 1,
  `❤️` 1, `1️⃣` 1, `🇺🇸` 1, `\u001b[31m` 5. Throughput: 13,000 mixed chars → 1.66 ms per full
  segmentation pass; the ASCII fast path regex is 0.0014 ms. So segment only lines that fail
  `/^[ -~]*$/` (string-width does exactly this).
- `string-width` 8.2.2 (Ink's measurer) rules, quoted from its header: "Skip non-printing clusters
  (Default_Ignorable, Control, pure nonspacing/enclosing Mark, lone Surrogates). Tabs are ignored by design.
  RGI emoji clusters (\p{RGI_Emoji}) are double-width … Otherwise use East Asian Width of the cluster's
  first visible code point". Measured widths: `é` 1 (2 with `ambiguousIsNarrow:false`), `漢字` 4, `👍🏽` 2,
  `👨‍👩‍👧‍👦` 2, `❤` 1 but `❤️` 2, `☃` 1 but `☃️` 2, `1️⃣` 2, `​` 0, `\t` 0, `→` 1 (2 ambiguous-wide),
  `Ａ` 2, `│`/`─` 1 (2 ambiguous-wide).
- UAX #11: values F, H, W, Na, A, N; "Ambiguous characters behave like wide or narrow characters depending
  on the context … If the context cannot be established reliably, they should be treated as narrow
  characters by default." and Emoji_Presentation characters are W except Regional Indicators
  (https://www.unicode.org/reports/tr11/, fetched 2026-09-20). UTS #51: VS16 U+FE0F "emoji presentation
  selector", VS15 U+FE0E text presentation; "When an emoji ZWJ sequence is sent to a system that does not
  have a corresponding single glyph, the ZWJ characters are ignored and a fallback sequence of separate
  emoji is displayed" (https://www.unicode.org/reports/tr51/, fetched 2026-09-20) — i.e. a terminal
  without the glyph renders the family as 4 emoji = 8 cells while string-width says 2: the classic
  misalignment. Terminals disagree among themselves on VS16 (`❤️`) and on ZWJ fallbacks; there is no query
  for it (kitty's "text sizing" and mode 2027 proposals are not in Ink or in enough terminals — reject).
- Policy: (1) measure with `string-width` (same as Ink) so the composer's cursor math and Ink's layout
  agree; (2) never let *untrusted* text sit on the last dynamic rows unclipped — `wrap="truncate"` per row
  is what bounds misalignment to one row; (3) treat `\t` as 0-width per string-width but *expand* tabs to
  spaces before measuring (readline shows them as up to 8 cells) — for command output expand to the next
  multiple of 8; for the composer insert as 4 spaces and keep the literal `\t` in the submitted text? No:
  keep what the user typed, display expanded; (4) RTL/bidi: punt — no shaping, no reordering; terminals
  render logical order; note in docs; (5) combining marks and ZWJ: cursor moves by grapheme
  (`Intl.Segmenter`), Backspace deletes a grapheme, Ctrl+W deletes by `granularity:'word'` segments;
  (6) ambiguous-width glyphs used by JevCode itself (`─`, `⠋`, `…`): keep them out of width-critical
  right-aligned columns or make `ambiguousIsNarrow` configurable via `JEVCODE_AMBIGUOUS_WIDE=1` for CJK
  locales (string-width option `ambiguousIsNarrow`); (7) C0/C1 and lone surrogates are width 0 in
  string-width but are stripped earlier anyway (§5).

## 5. Untrusted output and ANSI injection

Generator text and command output are hostile. Ink's `<Text>` keeps SGR **and OSC** (§0), so OSC 52
(clipboard write), OSC 8 (spoofed links), OSC 0/2 (title), OSC 9/99 (fake notifications) would pass. JevCode's
`sanitizeStream` already removes `/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g` (`src/tui/plain.ts`),
which kills ESC (0x1b) and all C1 introducers (0x9b CSI, 0x9d OSC) before Ink sees them — keep it as the
single choke point for transcript items, live region, composer paste, and clipboard payloads. Extra cases:
`\r` (progress bars) is preserved by design and handled by `liveLines`; DEL 0x7f removed; U+2028/2029 line
separators are not line breaks for Ink but are for some editors — normalise to `\n`; zero-width and bidi
controls (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069) are "Default_Ignorable"/format characters that
string-width counts as 0 but which can reorder or hide text ("Trojan Source") — strip U+202A–U+202E and
U+2066–U+2069 from untrusted text, keep U+200D (ZWJ) so emoji survive. Terminal-side, Ink's tokenizer
already recognises tmux's doubled-ESC passthrough (`ansi-tokenizer.js` comment "Tmux escapes ESC bytes in
payload as ESC ESC").

## 6. Slow links: ssh, mosh, tmux

- ssh is byte-transparent; the costs are latency (kitty/DA1/OSC 11 round trips — hence ≥ 1 s budgets and
  never blocking the first frame) and bandwidth (every frame is a full rewrite of the dynamic region:
  `rows − 2` lines × columns; at 40×120 that is ≤ 5 KB per frame, 20 fps = 100 KB/s worst case). Reduce
  with Ink's `maxFps` (default 30) lowered to 15 when `SSH_CONNECTION`/`SSH_TTY` is set, the 50 ms live
  coalescer (DESIGN §10) and `incrementalRendering: true` (`log-update.js` `createIncremental` rewrites
  only changed lines) — measure flicker before adopting incremental mode, since it relies on cursor-up
  arithmetic that resize can desynchronise.
- mosh re-emulates the terminal: it implements bracketed paste (2013), "Add true color support" appears in
  the 1.4.0 release (https://github.com/mobile-shell/mosh/releases/tag/mosh-1.4.0, fetched 2026-09-20), and
  its ChangeLog lists "Implement XTerm mouse mode" (1.2.5). OSC 52, OSC 8, 1004, kitty keyboard, 2026: not
  found in any mosh source I could fetch — treat as unsupported (the yudai gist "tmux + mosh OSC 52
  clipboard paste hack" exists precisely because OSC 52 does not pass — UNVERIFIED beyond that). Detection
  is impossible from env (mosh sets nothing standard); queries simply get no answer, which the ≥ 1 s
  timeout handles.
- tmux: see §1.3 (extended-keys), §2.5 (set-clipboard/passthrough), §2.7 (allow-passthrough), §2.1 (2026
  since 3.7). `TMUX` env identifies it; `TERM` is `screen*`/`tmux*`. Node maps `TMUX` → truecolor blindly
  (§2.10) — trust `COLORTERM` from the outer terminal is *not* visible inside tmux, so keep 256 colours
  unless `tmux-256color`+`Tc`/`RGB` is known: use 16 named colours inside tmux.

## 7. Terminal matrix (✅ supported, ⚙ needs setting, ✗ absent, ? UNVERIFIED)

| Feature | iTerm2 3.5+ | Terminal.app | VS Code 1.109+ | Ghostty | kitty | WezTerm | Alacritty 0.16+ | foot | tmux 3.4+ | mosh 1.4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2004 paste | ✅ | ? (assume ✅) | ✅ (drops chars on huge pastes) | ✅ | ✅ | ✅ | ✅ | ✅ | pass-through | ✅ |
| Kitty kbd | ✅ (Disambiguate setting) | ? | ✅ default on | ✅ | ✅ | ⚙ `enable_kitty_keyboard` | ✅ (Shift+Enter fixed 0.16) | ✅ 1.10.3 | ✗ (extended-keys instead) | ? (assume ✗) |
| modifyOtherKeys | ✅ (listed on xterm page) | ? | ? | ✅ (kitty superset) | ✅ (xterm page) | ? | ? | ✅ 1.10.0 (Pv=2) | ✅ `extended-keys` | ? |
| 2026 sync | ✅ 3.5.0 | ? (assume ✗) | ✅ (xterm.js) | ✅ | ✅ | ✅ | ✅ 0.13 | ✅ 1.8 | ✅ 3.7 | ? |
| 1004 focus | ✅ | ? | ? | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `focus-events on` | ? |
| 1006 mouse | ✅ (pref) | ? | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `mouse` | ✅ |
| OSC 52 write | ⚙ pref | ✗? | ✅ local, ✗ Remote-SSH | ✅ default allow | ✅ | ✅ | ✅ | ✅ | ⚙ `set-clipboard on` / passthrough | ✗? |
| OSC 8 | ✅ 3.1 | ✗ (not in adoption list) | ✅ 1.72 | ✅ 2024-07 | ✅ 0.19 | ✅ | ✅ 0.11 | ✅ 1.7 | ⚙ `terminal-features *:hyperlinks` | ? |
| OSC 9 notify | ✅ ⚙ Filter Alerts | ✗? | ✗ | ✅ | ✅ (legacy) | ✅ | ✗? | ✅ 1.8 | ⚙ `allow-passthrough on` | ? |
| OSC 777 / 99 | ✗ / ✗ (has OSC 1337 Notification) | ✗ | ✗ | ✅ / ? | ✗ / ✅ | ✅ / ✗ | ✗ | ✅ / ✅ 1.18 | passthrough | ? |
| Truecolor | ✅ | ✅ macOS 26 only (secondary source) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | needs `Tc`/`RGB` | ✅ 1.4 |
| DECSCUSR | ✅ | ? | ✅ | ✅ | ✅ | ? | ✅ | ✅ (0 = foot.ini) | pass-through | ? |
| OSC 0/2 title | ✅ ("Terminal may report window title" pref) | ✅? | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `allow-rename` | ? |

Sources per row are the sections above; cells marked `?` had no primary source fetched on 2026-09-20.

## 8. How to test each item

- **pty harness (integration).** The repo's `perf/first-frame.ts` already uses `script -q /dev/null sh -c
  'stty rows 40 cols 120; exec node …'`; for input-driven tests use Python's `pty.fork()`
  (`/tmp/jevtui/pty_drive2.py` pattern: `TIOCSWINSZ`, `os.write(fd, bytes)` at millisecond offsets,
  `os.kill(pid, SIGWINCH|SIGTSTP|SIGCONT|SIGHUP)`, `termios.tcgetattr(master)` to inspect the slave's termios,
  `os.close(master)` for hang-up). `/usr/bin/expect` exists on macOS too but Python gives exact timing.
  Assert on the byte transcript: counts of `\x1b[2J` (must be 0 after the first frame), `\x1b[?2004h/l`,
  `\x1b[>1u`/`\x1b[<u`, `\x1b[?1004h/l`, `\x1b[?25l/h` pairs, and that the final bytes contain the full
  exit string.
- **Unit (no pty).** The composer reducer takes `KeyEvent | PasteEvent | FocusEvent | Response` objects,
  so feed it: split CSI, ESC+x at 5/25 ms (simulate with injected timestamps), pastes with `\r\n\t`, 64 KB
  paste, Ctrl+D empty/non-empty, Ctrl+Z byte, kitty `CSI 13;2u`, xterm `CSI 27;2;13~`, `CSI I/O`, `CSI ?0u`,
  `CSI ?62c`, OSC 11 replies in both bit depths, SGR mouse noise. Use `ink-testing-library` for frames at
  rows 3/5/12/40 × columns 20/80/400 and assert `lastFrame().split('\n').length ≤ rows − 2`.
- **Width.** Table-driven test over the strings in §4 comparing `string-width` to the expected cell counts,
  plus a "no line exceeds columns" invariant over random Unicode (fast-check is not a dependency — use a
  deterministic PRNG).
- **Signals.** pty test: SIGTSTP → termios cooked while stopped → SIGCONT → raw again and one repaint;
  close master → checkpoint file exists, exit 129, no write attempted after `end`.
- **Colour env.** Spawn the CLI with the env combos of §2.10 and assert the presence/absence of `\x1b[3`
  SGR in the first frame.
- **Manual matrix.** A `jevcode doctor --terminal` command that prints the negotiated capabilities (queries
  + env) and a checklist to run in each real terminal (Shift+Enter, paste 3 lines, Ctrl+Z, focus out,
  resize drag, `/copy`), recording results into `docs/research/tui/terminal-matrix.md`.

## 9. Checklist

| # | Edge case | Sequence / signal | Handle | Test |
| --- | --- | --- | --- | --- |
| 1 | Paste split across reads | `ESC[200~ … ESC[201~` | Ink `usePaste` pending buffer | pty split write |
| 2 | Paste with `\r\n\t` | same | insert as text, expand tabs for display | unit |
| 3 | Huge paste | same | placeholder `[Pasted #n, k lines]`, body in memory | pty 64 KB |
| 4 | Paste without 2004 | fast `\r` chunks | timing heuristic | unit with timestamps |
| 5 | Kitty handshake | `CSI ? u` + `CSI c` | own detection, ≥ 1 s, filter replies | pty 4 answer patterns |
| 6 | Kitty pop everywhere | `CSI < u` | exit string in unmount/suspend/TSTP/fatal/HUP | pty transcript |
| 7 | Shift/Ctrl/Alt+Enter | `CSI 13;2u`, `CSI 27;2;13~`, `ESC CR`, `0x0a`, `\`+Enter | all map to newline | unit |
| 8 | Esc vs Alt-chord | `0x1b` + byte within 20 ms | Ink meta; re-buffer escape 30 ms | pty 5/12/18/25/40 ms |
| 9 | Split CSI over 20 ms | `ESC[` … `A` | tolerate garbage `[`/`A` by dropping lone `[` followed by a letter within 50 ms | pty |
| 10 | Ctrl+D | `0x04` | empty → exit (confirm), else delete-forward | unit |
| 11 | Ctrl+L | `0x0c` | repaint dynamic region, no `ESC[2J` | pty count |
| 12 | Ctrl+S/Q | `0x13`/`0x11` | IXON off → free keys (history search / no-op) | pty |
| 13 | Ctrl+Z | `0x1a`, SIGTSTP/SIGCONT | restore → SIGSTOP; re-enable on CONT | pty termios |
| 14 | Terminal closed | `end`, EIO, SIGHUP | error listeners, checkpoint, exit 129 | pty close |
| 15 | Crash | uncaught | exit string first, then Ink unmount via signal-exit | unit + pty |
| 16 | Resize storm | SIGWINCH × N | 50 ms debounce, budget from new rows | pty 30 events |
| 17 | 0×0 / 5×20 / 400 cols | `columns`=0 | Ink 80×24 fallback; composer-only layout < 8 rows | pty |
| 18 | TERM=dumb / no TERM / CI | env | force plain / no colour | spawn env |
| 19 | stdin≠TTY or stdout≠TTY | `isTTY` undefined | plain renderer, no queries | spawn |
| 20 | NO_COLOR | env | `FORCE_COLOR=0` in `bin/jevcode.js` before import | spawn |
| 21 | Focus events | `CSI I` / `CSI O` (arrive as `"[I"`/`"[O"`) | notify only when unfocused; filter from keys | unit |
| 21b | Query replies | `[?0u`, `[?62;22c`, `[?2026;2$y` single strings; OSC replies shredded | consume in `useInput`; never send OSC/DCS queries through Ink | pty + unit |
| 22 | Mouse noise | `CSI <b;x;yM` | drop; never enable 1000–1006 | unit |
| 23 | OSC injection | `ESC ]`, `0x9d` | `sanitizeStream` C0/C1 strip + bidi controls | unit |
| 24 | Emoji/ZWJ/VS16 width | — | string-width; truncate per row | unit table |
| 25 | IME multi-codepoint chunk | UTF-8 text | insert as text; grapheme cursor | unit |
| 26 | Clipboard | `OSC 52 ; c ; b64` (+ tmux DCS) | `/copy` write-only, `pbcopy` fallback, redact | pty transcript |
| 27 | Notifications | BEL / OSC 9 / 99 / 777 | per-terminal table; never `9;<digit>;` | pty transcript |
| 28 | Cursor shape | `CSI 6 SP q` / `CSI 0 SP q` | set on start, reset in exit string | pty |
| 29 | Title | `OSC 2` | opt-in `--title`, reset empty on exit | pty |
| 30 | Slow link | — | `maxFps` 15 under `SSH_TTY`, 50 ms coalescer, ≥ 1 s query budgets | perf/render-lag variant |

## 10. ADOPT

| What | Why | Source |
| --- | --- | --- |
| `usePaste` + bracketed paste from Ink; placeholder collapse for > 3 lines / > 800 chars | Ink handles chunk splits and mid-marker flush suppression correctly (measured); placeholder keeps the composer usable | `node_modules/ink/build/input-parser.js`, `hooks/use-paste.js`; Claude terminal-config (fetched 2026-09-20) |
| Own kitty handshake: `CSI ? u` + `CSI c`, ≥ 1 s, flags = 1 only, filter `[?…u`/`[?…c`; `kittyKeyboard: {mode:'disabled'}` | Ink's auto mode leaks the reply into `useInput` (measured) and times out at 200 ms with no DA1 sentinel | `ink.js` `confirmKittySupport`; kitty spec detection paragraph (fetched 2026-09-20); Node stream docs |
| Send only CSI-shaped queries (`CSI ? u`, `CSI c`, `CSI ? 2026 $ p`) and filter their single-string replies in `useInput`; no OSC 11 / XTVERSION unless a pre-Ink stdin demux exists | Ink's parser has no OSC/DCS state: an OSC reply is shredded into three key events (measured) | `input-parser.js`; measured 2026-09-20 |
| Inside tmux send `CSI > 4 ; 2 m` and decode both `CSI 27;m;k~` and `CSI k;m u`; reset `CSI > 4 m` on exit | tmux has no kitty protocol; extended-keys is its path and Claude Code documents the user-side config | tmux.1, tmux CHANGES 3.2/3.2a/3.5, Claude terminal-config (all fetched 2026-09-20) |
| Newline paths: Ctrl+J, `\`+Enter, Alt+Enter, plus Shift/Ctrl+Enter when a protocol delivers them | The only universally available paths; matches Claude Code and opencode | Claude interactive-mode; opencode keybinds (fetched 2026-09-20) |
| Esc handling: 30 ms re-buffer on top of Ink's 20 ms; single Esc = interrupt, double Esc = clear | Ink's 20 ms is below neovim's 50 ms; measured garbage at 25 ms gaps | measured; nvim options.txt (fetched 2026-09-20) |
| One idempotent exit string (§3.1) written in `fatal()`, SIGTSTP, SIGHUP, unmount | signal-exit misses SIGKILL/hangs; kitty pop, 2004, 1004, DECSCUSR and 2026 must all be undone | libuv tty.c; signal-exit source; measured SIGTSTP/SIGHUP |
| `stdin/stdout/stderr 'error'` listeners for EIO/EPIPE before any SIGHUP logic; no terminal writes in shutdown | Without them the HUP handler never ran (measured) | measured 2026-09-20; Node process docs |
| SIGTSTP → restore + SIGSTOP; SIGCONT → re-enable + repaint via `suspendTerminal` primitive | Nothing restores raw mode on CONT (measured); bash only saves its own state | bash jobs.c; measured |
| 50 ms resize debounce with the height budget computed from the same `rows` Ink reads | Node emits one `resize` per SIGWINCH (30/30 measured); an oversized frame triggers `clearTerminal` | measured; `ink.js` `shouldClearTerminalForFrame` |
| Composer-only layout below 8 rows; status-only below 3; rule capped at 400 columns | Budget math at 5×20 and 0×0 verified 0 clears | measured first frames |
| `bin/jevcode.js`: `NO_COLOR`→`FORCE_COLOR=0`, `TERM=dumb`/`CI`→plain, guard `getColorDepth` with `typeof` | chalk 5.6.2 ignores NO_COLOR; Node's depth table mis-rates Ghostty (16) and tmux (16m); pipe has no `getColorDepth` | chalk vendored supports-color; Node internal tty.js; measured |
| Keep `<Static>` scrollback, no alternate screen, no mouse reporting | Native scrollback, selection and search keep working; kitty stack per screen adds state | `render.d.ts`; ctlseqs wheel text; Claude fullscreen docs |
| Real cursor via Ink `useCursor`, DECSCUSR bar on start, `CSI 0 SP q` on exit | IME anchors to the real cursor; 0 is the portable reset | `cursor-helpers.js`; ctlseqs DECSCUSR; foot ctlseqs |
| Notifications: BEL default; OSC 9 for iTerm2/Ghostty/WezTerm/foot, OSC 99 for kitty; tmux passthrough | Matches Claude Code's shipped policy and the terminals' docs | iTerm2 escape codes; kitty desktop-notifications; Ghostty Config.zig; foot; WezTerm |
| `/copy`: OSC 52 write-only (+`pbcopy`), tmux DCS wrapper with doubled ESC, 64 KiB cap, redacted | opencode's proven sequence; reads prompt or are denied | opencode clipboard.ts; tmux.1; kitty clipboard.rst |
| OSC 8 only for self-resolved `file://` paths, only on adoption-list terminals | Ink passes OSC through; Terminal.app is absent from the list | Alhadis adoption README; `sanitize-ansi.js` |
| `string-width`/`Intl.Segmenter` for all width and cursor math; strip bidi controls; expand tabs for display | Same measurer as Ink → no drift; 1.66 ms per 13 k chars is affordable | measured; string-width source; UAX #11/UTS #51 |
| `maxFps: 15` under `SSH_TTY`; ≥ 1 s query budgets; never block the first frame on a reply | Round trips and bandwidth on slow links | ssh reasoning §6; Ink `renderThrottleMs` |
| `jevcode doctor --terminal` + pty test suite in Python for signals/timing | The matrix has too many `?` cells to trust without a repeatable probe | §7, §8 |

## 11. REJECT

| What | Why |
| --- | --- |
| Ink `kittyKeyboard: {mode:'auto'}` | 200 ms window, no DA1 sentinel, and the reply leaks into `useInput` (measured `KEY "[?0u"`) |
| Kitty flags 2/4/8/16 | Release/repeat events double every key; flag 8 turns text into escape codes; Ink decodes them but the composer gains nothing and IME text would need flag 16 |
| `alternateScreen: true` for the default TUI | Loses native scrollback/selection/search; separate kitty stack; Claude Code offers it only as a flicker workaround |
| Mouse reporting (1000/1002/1006) | Breaks wheel scrollback and plain drag-selection in every terminal; Ink has no decoder |
| Relying on terminal-side paste sanitising | Only some terminals strip ESC inside pastes; mosh/tmux re-encode |
| `ESC[2J`/`ESC[3J` on Ctrl+L or resize | Violates the zero-clear gate and destroys scrollback; Ink `clear()` (erase lines) suffices |
| Reading the clipboard (`OSC 52 ; c ; ?`) | Prompts (Ghostty ask, iTerm2 consent) or is ignored (WezTerm); no use case |
| Depending on `TMUX`→truecolor or `TERM_PROGRAM` for colour depth | Node's table is wrong for Ghostty and blind inside tmux; prefer `COLORTERM` and 16 named colours |
| Terminal title by default | Not reliably restorable; opt-in only |
| Mode 2048 in-band resize, mode 2027 grapheme width, kitty text-sizing | Only foot/kitty; SIGWINCH + string-width cover us |
| Second "guardian" process to restore the terminal after SIGKILL | Violates the one-bundle/one-process design; document `reset` instead |
| Bidi/RTL shaping | No terminal-agnostic way; render logical order and say so |

## 12. OPEN QUESTIONS

1. Terminal.app on macOS 26: does it send a distinguishable Shift+Enter (Claude Code lists "Apple Terminal"
   as working without setup) and does it implement 1004/2026/OSC 8/OSC 52? Needs a manual `doctor` run;
   no primary Apple source found (Apple's "What's new" page did not state features when fetched).
2. tmux #3335 resolution and whether tmux ≥ 3.5 ever answers `CSI ? u` or forwards `CSI > u` when
   `extended-keys always` — comments unreadable (API rate limit); test in a real tmux (not installed here).
3. Ink upstream: should we report the `readable`/`data` double-consumption of the kitty reply and the
   fixed 20 ms flush (a `escapeCodeTimeout` option would remove our re-buffering layer)? Filing an issue
   costs nothing but the fix would not land in the pinned 7.1.1.
4. mosh 1.4 support for OSC 52 / 1004 / kitty / 2026 remains UNVERIFIED; a `doctor` run over mosh would
   settle it. Also whether mosh preserves `ESC` inside bracketed pastes.
5. Windows Terminal and xterm.js: which kitty flags beyond 1 are honoured (both sources describe the
   feature without a flag list); irrelevant if we negotiate flag 1 only.
6. Ghostty OSC 99 (only a discussion thread found) and Ghostty's own VT reference is "work-in-progress" —
   the matrix cells for Ghostty notifications should be re-checked when its docs land.
7. `incrementalRendering: true` on slow links: measure flicker and resize robustness before switching; the
   standard mode rewrites the whole dynamic region per frame.
8. Should `Ctrl+D` on an empty composer exit immediately (opencode) or require confirmation while a step is
   in flight (JevCode has an in-progress checkpoint to protect)? Proposed: confirm while `state.done === null`.
9. Is a pre-Ink stdin demux stream (to consume OSC 11 / OSC 52 `?` / DCS replies before Ink's parser) worth
   its proxy surface (`isTTY`, `setRawMode`, `setEncoding`, `ref/unref`, `read`, `'readable'`, `unshift`),
   or is "dark by default + `--theme`" enough? Prototype cost is one file and one pty test.
10. Where should the NO_COLOR→FORCE_COLOR shim live so `ink-testing-library` unit tests see the same
   behaviour as the bundle — `bin/jevcode.js` only, or a tiny `src/cli/env-shim.ts` imported first by
   `main.tsx` (esbuild preserves import order, so a first-position side-effect import works in both)?
