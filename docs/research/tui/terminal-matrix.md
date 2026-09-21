# Terminal matrix and checklist for the JevCode TUI

Consolidated from research `07-terminal-protocols-edge-cases.md` §7 (capability matrix, fetched 2026-09-20),
§8 (how to test each item) and §9 (edge-case checklist), against the posture the implementation actually
takes (`docs/TUI-DESIGN.md` §14, D13; `src/tui/terminal.ts`, `src/tui/notify.ts`, `src/tui/secrets/clipboard.ts`,
`src/config/launch.ts`). Two questions per row: what does the terminal support, and does JevCode use it?
Cells marked `?` had no primary source in the research; nothing in the "verified" column has been exercised
on a real terminal other than the `expect(1)` pseudo-terminal (`TERM=xterm-256color`) that
`test/pty/run-smoke.sh` drives — see the last section for what that covers.

## 1. What JevCode sends and never sends (v1)

| Protocol | JevCode v1 | Why |
| --- | --- | --- |
| Bracketed paste (DECSET 2004) | **on** while Ink is mounted (Ink's `usePaste`); off in the exit string | pastes arrive whole; chips for > 3 lines / 800 chars |
| Synchronized output (mode 2026) | **on** around every frame (Ink); off in the exit string | no tearing; the perf probes count frames by its brackets |
| Kitty keyboard protocol (`CSI > 1 u`) | **never** (`kittyKeyboard: { mode: 'disabled' }`) | no handshake, no `CSI ? u` query, no reply filtering; Shift+Enter therefore is not a newline — Ctrl+J, Alt+Enter, `\` + Enter are |
| xterm `modifyOtherKeys`, tmux extended keys (`CSI > 4 ; 2 m`) | **never** sent; a `CSI 27;m;13~` that arrives anyway is swallowed as a newline | deferred with the kitty handshake (TUI-DESIGN §22, A78) |
| Terminal queries (DA1, `OSC 11` background, `CSI ? 2026 $ p`, XTVERSION, `OSC 52 ; ?`) | **never**, before or after the first frame | replies would land in the composer; runtime feature detection is env-only |
| Mouse reporting (1000/1002/1006) | **never** | text selection stays the terminal's |
| Alternate screen (1049) | **never**; the transcript is scrollback (`<Static>`) | zero clears after the first frame is a perf gate |
| Focus events (1004) | **never** requested; a leaked `CSI I` / `CSI O` is dropped by the input filter | deferred (C25) |
| Cursor shape (DECSCUSR) | `CSI 6 SP q` (steady bar) once at mount; `CSI 0 SP q` in the exit string | the real cursor is positioned with `useCursor`; no fake block cursor |
| Cursor visibility (25) | Ink hides and re-shows per changed frame; the exit string re-shows the cursor (`CSI ? 25 h`) before its final `SGR 0` | |
| Colour | ANSI-16 named colours, a textual marker beside every coloured word, no backgrounds; `NO_COLOR` → `FORCE_COLOR=0` in `bin/jevcode.js`; `--theme dark\|light\|daltonized\|ansi`; 16 colours inside tmux; no auto-detect of the background | `TERM=dumb` and `--no-color` read the same |
| OSC 52 clipboard | **write only**, only behind `--osc52` / `ui.osc52`, base64 payload, tmux DCS passthrough with doubled ESC; native tools first (`pbcopy`, `wl-copy`, `xclip`, `xsel`, 2 s each) | never a read (`?`) |
| OSC 8 hyperlinks | **never** | deferred (A87) |
| Notifications | opt-in `--notify` / `ui.notify` (on in screen-reader mode): BEL everywhere; OSC 9 on iTerm2 / Ghostty / WezTerm / foot; OSC 99 on kitty; tmux DCS passthrough; payload a redacted one-liner never starting `<digit>;` | review box untouched ~6 s, run end ~60 s, 95 % budget, budget stop |
| Window title (OSC 0/2) | flag `--title` / `ui.title` exists and is resolved, but **no OSC 2 write is wired in the tree as of 2026-09-21** (see `docs/STATUS.md`, deviations) | |
| Exit string | `ESC[?2004l ESC[?2026l ESC[0 SP q ESC[?25h ESC[0m`, written by an idempotent `restoreTerminal()` from unmount, `fatalExit`, SIGTSTP, SIGHUP and the `process.on('exit')` hook; never `ESC c`, `ESC[2J`, `ESC[3J` | measured: twice per exit in 17 of 19 pty scenarios on the 07:36Z bundle; exactly once in all 19 after the polish slot's restore change (bundle rebuilt 08:00Z) |

## 2. Capability matrix (research 07 §7, with JevCode's use of each row)

✅ supported · ⚙ needs a setting · ✗ absent · ? unverified in the research. "Use" is JevCode v1's dependence on the row.

| Feature | Use | iTerm2 3.5+ | Terminal.app | VS Code 1.109+ | Ghostty | kitty | WezTerm | Alacritty 0.16+ | foot | tmux 3.4+ | mosh 1.4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2004 paste | required for chips | ✅ | ? (assume ✅) | ✅ (drops chars on huge pastes) | ✅ | ✅ | ✅ | ✅ | ✅ | pass-through | ✅ |
| Kitty keyboard | not used | ✅ (Disambiguate setting) | ? | ✅ default on | ✅ | ✅ | ⚙ `enable_kitty_keyboard` | ✅ (Shift+Enter fixed 0.16) | ✅ 1.10.3 | ✗ (extended-keys instead) | ? (assume ✗) |
| modifyOtherKeys | not used | ✅ | ? | ? | ✅ | ✅ | ? | ? | ✅ 1.10.0 (Pv=2) | ✅ `extended-keys` | ? |
| 2026 sync | used (Ink) | ✅ 3.5.0 | ? (assume ✗; frames still correct, just unbracketed) | ✅ (xterm.js) | ✅ | ✅ | ✅ | ✅ 0.13 | ✅ 1.8 | ✅ 3.7 | ? |
| 1004 focus | not used | ✅ | ? | ? | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `focus-events on` | ? |
| 1006 mouse | not used | ✅ (pref) | ? | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `mouse` | ✅ |
| OSC 52 write | opt-in `--osc52` | ⚙ pref "Applications in terminal may access clipboard" | ✗? (→ `pbcopy`) | ✅ local, ✗ Remote-SSH | ✅ default allow | ✅ | ✅ | ✅ | ✅ | ⚙ `set-clipboard on` / passthrough | ✗? |
| OSC 8 | not used | ✅ 3.1 | ✗ | ✅ 1.72 | ✅ 2024-07 | ✅ 0.19 | ✅ | ✅ 0.11 | ✅ 1.7 | ⚙ `terminal-features *:hyperlinks` | ? |
| OSC 9 notify | opt-in `--notify` | ✅ ⚙ Filter Alerts | ✗? (BEL) | ✗ (BEL) | ✅ | ✅ (legacy; JevCode sends OSC 99 there) | ✅ | ✗? (BEL) | ✅ 1.8 | ⚙ `allow-passthrough on` | ? |
| OSC 777 / 99 | 99 on kitty | ✗ / ✗ | ✗ | ✗ | ✅ / ? | ✗ / ✅ | ✅ / ✗ | ✗ | ✅ / ✅ 1.18 | passthrough | ? |
| Truecolor | not used (ANSI-16) | ✅ | ✅ macOS 26 only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | needs `Tc`/`RGB` | ✅ 1.4 |
| DECSCUSR | used (bar at mount, reset at exit) | ✅ | ? | ✅ | ✅ | ✅ | ? | ✅ | ✅ (0 = foot.ini) | pass-through | ? |
| OSC 0/2 title | flag exists, not wired | ✅ (pref) | ✅? | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙ `allow-rename` | ? |

## 3. Per-terminal setup notes (what a user must change; the user guide repeats these)

| Terminal | Alt / Meta chords | Newline | Clipboard (`/copy`) | Notifications (`--notify`) | Other |
| --- | --- | --- | --- | --- | --- |
| iTerm2 | Profiles → Keys → *Left Option key: Esc+* | Ctrl+J, Alt+Enter, `\` + Enter | `pbcopy`; OSC 52 needs the clipboard pref and `--osc52` | OSC 9 (Filter Alerts may hide them) | detected by `TERM_PROGRAM=iTerm.app` |
| Terminal.app | Profiles → Keyboard → *Use Option as Meta key* | same | `pbcopy` (no OSC 52) | BEL | 2026 unverified; frames still correct |
| VS Code | `terminal.integrated.macOptionIsMeta` (macOS) | same | OSC 52 local only; native tool first | BEL | no `TERM` → colour follows `FORCE_COLOR`; huge pastes may drop characters (paste into a file and `@`-mention it) |
| Ghostty | default | same (kitty protocol not requested) | native / OSC 52 | OSC 9 (`GHOSTTY_RESOURCES_DIR`) | |
| kitty | default | same | native / OSC 52 | OSC 99 (`KITTY_WINDOW_ID` or `TERM=*kitty*`) | |
| WezTerm | default | same | native / OSC 52 | OSC 9 (`WEZTERM_PANE`) | `enable_kitty_keyboard` irrelevant |
| Alacritty | default | same | native / OSC 52 | BEL | |
| foot | default | same | native / OSC 52 | OSC 9 (`TERM=foot*`) | |
| tmux 3.4+ | inherits | same | `set -g set-clipboard on` + `set -g allow-passthrough on` for OSC 52 through tmux | `allow-passthrough on` (DCS-wrapped) | 16 colours by design; lower `escape-time` (the 30 ms Esc re-buffer adds to it) |
| ssh | inherits | same | native tool on the remote host; OSC 52 through ssh needs `--osc52` and the local terminal's permission | as the local terminal | `SSH_TTY`/`SSH_CONNECTION` → 15 fps default |
| mosh | inherits | same | ✗ (mosh drops OSC 52) | BEL only | treat 2026 / 1004 / kitty as unsupported |
| Linux console `TERM=linux`, `TERM=dumb` | n/a | same | native tool | BEL | ASCII glyphs auto (`--ascii`, `JEVCODE_ASCII=0` to force Unicode); `TERM=dumb` selects the plain renderer |
| Windows (ConPTY) | untested | untested | untested | untested | `--sandbox none`; sandboxed runs via WSL 2; ACL note instead of chmod |

## 4. Edge-case checklist (research 07 §9) with JevCode's handling and test status

Status: **pty** = covered by `test/pty/run-smoke.sh` (19 scenarios, 19/19 PASS in four runs on 2026-09-21 against the
built bundle) or by the `pty` vitest project (`npm run test:pty`, `test/pty/*.pty.test.ts`: 26 tests, 26 passed in three
runs on 2026-09-21 — the run log is in `docs/STATUS.md`, "Interactive TUI"); **unit** = covered by `test/unit/**`;
**manual** = needs a real terminal and has not been done; **n/a** = the protocol is not used.

| # | Edge case | JevCode handling | Status |
| --- | --- | --- | --- |
| 1 | Paste split across reads | Ink `usePaste` pending buffer | unit (`composer/paste`) |
| 2 | Paste with `\r\n`, `\t` | normalised to `\n`, tabs expanded on insert, bodies keep tabs | unit |
| 3 | Huge paste | chip `[Pasted #n, k lines]` over 3 lines / 800 chars; 1 MiB refused with a toast | unit; pty (`test/pty/chat.pty.test.ts`: 20 KB bracketed paste → one chip) |
| 4 | Paste without 2004 | a multi-character chunk without modifiers is paste-like | unit |
| 5 | Kitty handshake | n/a (never sent) | n/a |
| 6 | Kitty pop in the exit string | n/a; the exit string resets 2004, 2026, DECSCUSR, cursor, SGR | pty (count of `CSI 0 SP q` per capture: 1 after the 08:00Z rebuild, see §1) |
| 7 | Shift/Ctrl/Alt+Enter | Ctrl+J, Alt+Enter (`ESC \r`), `\` + Enter, xterm `CSI 27;m;13~` → newline; Shift+Enter needs a protocol | unit (`keys/resolve`) |
| 8 | Esc vs Alt chord | 30 ms re-buffer; a letter inside it is the Meta chord | unit (`keys/interrupts`, `resolve`) |
| 9 | Split CSI over 20 ms | Ink joins ≤ 20 ms; the input filter drops CSI leak-through (`[I`, `[O`, `[?0u`, `[24;80R`, mouse) | unit (`composer/filter`) |
| 10 | Ctrl+D | empty → two-press exit (with a live run: `[y] abort and exit  [n] stay`); text → delete forward | pty (`ctrld2`) |
| 11 | Ctrl+L | erase-lines + repaint through `useStdout().write('')`, never `ESC[2J` | unit (`keys/resolve`); no pty assertion yet |
| 12 | Ctrl+S / Ctrl+Q | Ink raw mode has IXON off; Ctrl+S is "newer" in history search | unit |
| 13 | Ctrl+Z | `suspendTerminal` → exit string → self-sent SIGSTOP; SIGCONT re-raws and repaints; 100 ms fallback | unit (`terminal.test.ts`); pty (`test/pty/chat.pty.test.ts`: SIGTSTP → state T → SIGCONT repaint); manual in a real shell |
| 14 | Terminal closed (stdin `end`, EIO, SIGHUP) | hang-up only while Ink holds raw mode → checkpoint, no terminal writes, exit 129; on a pipe `end` is the end of the task text | unit (`cli/fatal`) |
| 15 | Crash | `fatalExit`: exit code → restore terminal → `engine.abort('error')` → unmount → redacted epilogue → exit | unit |
| 16 | Resize storm | 50 ms trailing debounce on the composer re-wrap; budget from the new rows. Idle (no pane open): ≤ 1 clear per shrink, 0 per grow (smoke `resize`, `resize-grow`). With a live pane open: **1–2 clears per shrink measured 2026-09-21** — Ink 7.1.1's `resized` handler renders the stale tree at the new viewport (clear 1) before the App's rows state updates and the re-render clears again (clear 2); the pty regression gate is 2 per shrink, the design bound of 1 (research 20 §1) is open | pty (`resize`, `resize-grow`; the 30-event storm in `test/pty/chat.pty.test.ts`, gate ≤ 2 per shrink); perf `states` probe (`allowed 1` per shrink segment, fails at 2 — `docs/STATUS.md`) |
| 17 | 0×0 / tiny / 400 columns | Ink's 80×24 fallback on 0×0; below 40×8 the region degrades to status · notice · composer; rule capped at 400 | unit (`layout`) |
| 18 | `TERM=dumb`, no `TERM`, `CI` | plain renderer (no composer, no queries); ASCII glyphs on `dumb`/`linux` | unit (`cli/main`); pty (`plainwarn` for `--plain`) |
| 19 | stdin or stdout not a TTY | plain renderer; `chat` reads its task like `run` | unit |
| 20 | `NO_COLOR` | `FORCE_COLOR=0` set by `bin/jevcode.js` before the bundle loads; `src/tui/color-shim.ts` repeats it for tests | unit; pty (`test/pty/chat.pty.test.ts`: no SGR in any frame) |
| 21 | Focus events, query replies, mouse noise | dropped by the input filter; never requested | unit |
| 22 | OSC / C0 / bidi injection in generator text | `sanitizeStream` is the one choke point (items, live region, pastes, clipboard, epilogue) | unit |
| 23 | Emoji / ZWJ / VS16 width | `cellWidth` replicates `string-width@8.2.2` (fixture of ~400 strings) | unit (`composer/width`) |
| 24 | IME multi-codepoint chunk | inserted whole as text; grapheme cursor | unit |
| 25 | Clipboard | `/copy` redacted, native tool first, OSC 52 write only behind `--osc52` | unit (`secrets/clipboard`); manual per terminal |
| 26 | Notifications | BEL / OSC 9 / OSC 99 by env; never `9;<digit>;` | unit (`notify.test.ts`); manual per terminal |
| 27 | Cursor shape | `CSI 6 SP q` at mount, reset in the exit string | pty (present in every capture) |
| 28 | Title | flag resolved, not wired | — |
| 29 | Slow link | 15 fps under `SSH_TTY`/`SSH_CONNECTION`; `LIVE_FLUSH_MS` 50 (250 under reduced motion); no queries | unit (`config/launch`) |
| 30 | Ctrl-C before raw mode (load) | SIGINT/SIGTERM handlers installed before the first frame: restore, one-line epilogue, exit 130/143 | pty (`sigmid-early`, `sigmid-trust`) |

## 5. What the pty smoke exercises today (`test/pty/run-smoke.sh`, macOS `expect` 5.45, `TERM=xterm-256color`)

`firstframe` (argv-only first frame, `FIRST_FRAME_MS`), `chat-run-exit`, `s0-ctrlc`, `ctrld2`, `s1-clear`,
`s2-ctrlc-abort`, `s2-esc-pause`, `review-y`, `review-d`, `resize` (24×80 → 12×60 → 24×80), `resize-grow` (12×60 →
24×80), `exitlast` (`--exit-code last-run`), `budgetfirst` (`/budget session-spend-cap` before the first run),
`sigmid-trust`, `sigmid-early`, `plainwarn` (`--plain` TTY warning on stderr), `taskfile-missing`, `taskfile-header`,
`oneshot-ctrlc`. Each asserts the exit code, zero `ESC[2J`/`ESC[3J`/`ESC c`/`ESC[?1049h` after the first dynamic frame
(≤ 1 for the shrink segment of `resize`), zero expect timeouts, and scenario strings. Everything in §3 that names a
specific terminal application is unverified until someone runs the manual checklist there:

- [ ] Shift+Enter does nothing harmful; Ctrl+J / Alt+Enter / `\`+Enter insert a newline
- [ ] Alt+B / Alt+F move by word (Option-as-Meta set where needed)
- [ ] a 3-line and a 20 KB paste become one chip; a secret-looking paste opens the gate row
- [ ] Ctrl+Z, then `fg`: the frame repaints, raw mode is back, the exit string was written once
- [ ] drag-resize down to 12 rows and back: the draft survives; at most one clear on the shrink while idle (with a live pane open the tree shows 1–2 today — row 16)
- [ ] `/copy last` lands in the system clipboard; with `--osc52` inside tmux too
- [ ] `--notify`: a review left untouched for ~6 s notifies (OSC 9 / 99 / BEL per the row above)
- [ ] closing the window mid-run leaves `state.json` and exits 129 (check `~/.jevcode/runs/<id>/`)
- [ ] `NO_COLOR=1`: no SGR bytes, every state still readable through its marker word
