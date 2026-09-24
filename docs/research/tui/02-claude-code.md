# 02 — Claude Code's terminal UI conventions (Anthropic): research notes for JevCode's interactive TUI

Written 2026-09-20 for the JevCode design of a chat-style interactive terminal UI on top of the existing engine
(prompt composer, slash commands, sessions/resume, steering, review prompts, a Jev-native decisions view, packaging).
Every claim below carries its source and the fetch date. Sources used:

- Official docs, fetched as raw markdown from `https://code.claude.com/docs/en/<page>.md` (the same URL without `.md` is the
  rendered page), 2026-09-20. Pages: interactive-mode, keybindings, commands, slash-commands, settings, settings-reference,
  statusline, hooks, hooks-guide, checkpointing, sessions, memory, terminal-config, fullscreen, permissions, permission-modes,
  costs, setup, troubleshooting, accessibility, env-vars, cli-reference, tools-reference, model-config, context-window.
- npm registry JSON: `https://registry.npmjs.org/@anthropic-ai/claude-code` and `/latest`, plus the 2.1.278 tarball and the
  `@anthropic-ai/claude-code-darwin-arm64` metadata, 2026-09-20.
- The upstream `CHANGELOG.md`: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` (7,158 lines, 2026-09-20).
- The native binary installed on the reference machine, `~/.local/share/claude/versions/2.1.267` (200,489,184 bytes), inspected with
  `file`, `codesign -dv`, `strings -n 3` (951,011 printable runs) and by executing it offline (`--version`, `--help`, `doctor`,
  and an onboarding first frame in a pty with `CLAUDE_CONFIG_DIR` pointed at a throwaway directory), 2026-09-20. Quotes of
  minified source text from the binary are marked "binary strings".
- Public write-ups: HN comments by an Anthropic TUI engineer (via `https://hn.algolia.com/api/v1/items/46701013`), GitHub
  issues #769, #1913, #3045, #37076, upstream PRs xterm.js #5453 and tmux #4744, the claude-chill README, and the
  Pragmatic Engineer article. Secondary claims are labelled as such.

Conventions in this file: "CC" = Claude Code; "docs:<page>" = `https://code.claude.com/docs/en/<page>` fetched 2026-09-20.
UNVERIFIED items are marked inline and collected at the end.

---

## 0. Ten findings that matter most for JevCode

1. **CC is no longer a Node program.** The npm package is a 184 KB wrapper whose `postinstall` hard-links a ~200–218 MB
   Bun-compiled native binary from a per-platform optional dependency; "The installed `claude` binary does not itself invoke
   Node" (docs:setup). JevCode's constraint (Node 22, one npm package, ink+react only) rules out copying this; §1 shows what
   is still transferable (one bundle, zero-dependency wrapper, `engines`, stable/latest channels, an offline `doctor`).
2. **Startup is not where CC wins.** Measured on the same Mac/clock: `claude --version` 22–28 ms (Bun binary), `node -e 0`
   31–32 ms, JevCode's real first frame in a pty 111–127 ms wall (child clock 80–93 ms), CC's own first interactive frame
   (fresh config, onboarding theme picker) 337–480 ms (§1.6). JevCode already beats CC's TUI first frame by ~3×.
3. **CC's flicker saga is the strongest argument for JevCode's existing `<Static>` + height-budget discipline.** Ink's classic
   renderer erases and redraws the dynamic region every frame and falls back to `clearTerminal` when the frame overflows the
   viewport (Ink 7.1.1 `ink.js` `shouldClearTerminalForFrame`); CC needed a from-scratch "differential renderer" (Jan 2026),
   upstream DEC 2026 patches to xterm.js and tmux, and finally an alternate-screen "fullscreen" renderer (§2). JevCode's
   zero-clears gate makes all of that unnecessary as long as the dynamic region stays ≤ rows − 2.
4. **The composer key model is stable and worth copying verbatim** (§3): Enter submits; `Ctrl+J`, `\`+Enter, Option+Enter
   and Shift+Enter (native in iTerm2/Ghostty/Kitty/WezTerm/Warp/Apple Terminal/Windows Terminal) insert a newline; `Esc`
   interrupts, `Esc Esc` clears the draft (saved to history) or opens rewind when empty; `Ctrl+C` interrupts → clears → exits
   on repeat; `Ctrl+D` twice within 800 ms exits; `Ctrl+R` reverse history; `Ctrl+O` transcript; `Ctrl+T` todo list;
   `Ctrl+B` background; `Ctrl+S` stash; `Ctrl+G` external editor; `Shift+Tab` cycles permission modes.
5. **Typing while the agent works queues the message; `Up` takes it back; `Esc` interrupts and sends the queue at once**
   (docs:interactive-mode). This is the exact steering model JevCode needs, mapped onto step boundaries.
6. **Permission prompts have three shapes and fixed wording**: "Yes", "Yes, and don't ask again for `<prefix>` commands in
   `<dir>`", "No, and tell Claude what to do differently (esc)"; `Tab` opens a comment field on Yes/No; `Esc` = No; the
   "don't ask again" row is suppressed when it would grant more than the prompt shows (§5). Risk is never a number in CC; a
   Jev-native prompt that shows the four risk dimensions with probabilities is a real differentiator.
7. **Sessions are JSONL files under `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`**, resumed with `--continue`,
   `--resume <id|name>`, or a picker whose keys (↑/↓, Enter, Space preview, `/` search, `Ctrl+R` rename, `Ctrl+A` all
   projects, `Esc`) JevCode can adopt over its existing `~/.jevcode/runs/<run-id>` checkpoints (§6).
8. **The rewind menu (`Esc Esc` on empty input or `/rewind`) offers "Restore code and conversation / Restore conversation /
   Restore code / Summarize from here / Summarize up to here / Never mind"** and snapshots before every turn; Bash-made
   changes are not tracked (§6.2). JevCode's per-step checkpoints already give the conversation half; the code half needs a
   workspace snapshot per step.
9. **The status line is a user script run on a 300 ms debounce with a documented JSON schema on stdin**, hidden during
   autocomplete/help/permission prompts, `COLUMNS`/`LINES` supplied, OSC 8 links allowed (§7.2). The schema field names are
   a good template for JevCode's `status` event payload; spawning a script per update is not (harness budget).
10. **Themes are six presets plus `auto` and JSON custom themes with named tokens** (`dark`, `light`, `dark-daltonized`,
    `light-daltonized`, `dark-ansi`, `light-ansi`; tokens like `promptBorder`, `planMode`, `diffAdded`) (§7.7). The
    daltonized pair matters for JevCode because the decisions pane currently encodes verdicts in red/yellow/green.

---

## 1. Packaging, install and startup

### 1.1 npm package metadata (registry, 2026-09-20)

From `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` (fetched 2026-09-20):

- `"version": "2.1.278"`, `"bin": {"claude": "bin/claude.exe"}`, `"engines": {"node": ">=22.0.0"}`, `"type": "module"`,
  `"dependencies": {}`, eight `optionalDependencies` pinned to the same version: `@anthropic-ai/claude-code-{darwin-arm64,
  darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, win32-x64, win32-arm64}`.
- `"scripts": {"postinstall": "node install.cjs", "prepare": "node -e \"if (!process.env.AUTHORIZED) { ... 'Direct
  publishing is not allowed.' ... }\""}` — the `prepare` guard blocks accidental `npm publish` from a dev machine.
- `dist.fileCount: 7`, `dist.unpackedSize: 184119` (the wrapper), `dist-tags: {stable: 2.1.267, latest: 2.1.278, next: 2.1.278}`.
- 521 published versions; in September 2026 the cadence was roughly one release per weekday (2.1.263 on 09-06 … 2.1.278 on 09-19).
- Platform package `@anthropic-ai/claude-code-darwin-arm64@2.1.278`: `os: ["darwin"], cpu: ["arm64"]`, `fileCount: 4`,
  `unpackedSize: 217695985` (`https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/latest`, 2026-09-20).
- Dated versions used below (registry `time`, 2026-09-20): 2.0.72 → 2025-12-17; 2.1.88 → 2026-03-30; 2.1.89 → 2026-03-31;
  2.1.198 → 2026-07-01; 2.1.239 → 2026-08-21; 2.1.267 → 2026-09-09; 2.1.278 → 2026-09-19.

### 1.2 What the tarball contains and what `install.cjs` does

Tarball `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.278.tgz` (downloaded 2026-09-20): `package/
cli-wrapper.cjs` (4,997 B), `install.cjs` (7,196 B), `bin/claude.exe` (500 B, an ASCII shell stub), `package.json`, `LICENSE.md`,
`README.md`, `sdk-tools.d.ts` (167,766 B). The stub prints `Error: claude native binary not installed.` and explains
`--ignore-scripts` / `--omit=optional`. `install.cjs` header comment (verbatim):

> "Detects the platform, finds the matching native binary from optionalDependencies, and copies it over the bin/claude.exe
> placeholder. After this runs, `claude` execs the native binary directly — no Node.js process stays resident."

Details worth noting: musl is detected with `process.report.getReport().header.glibcVersionRuntime === undefined` ("Faster than
spawning `ldd`"); Rosetta is detected with `sysctl -n sysctl.proc_translated` so an x64 Node on Apple Silicon still gets the
arm64 binary ("the x64 build needs AVX, which Rosetta doesn't emulate"); the binary is placed with `linkSync` first ("instant,
zero extra disk for a ~500MB binary"), falling back to `copyFileSync` on `EXDEV`/`EPERM`, and the stub is restored if the copy
fails. `docs:setup` confirms: "The npm package installs the same native binary as the standalone installer … The installed
`claude` binary does not itself invoke Node." and "As of v2.1.198, the npm package requires Node.js 22 or later … the install
completes and `claude` still runs, since the package downloads a native binary that doesn't use your Node.js at runtime."

### 1.3 The native binary

`file`: "Mach-O 64-bit executable arm64"; `codesign -dv`: `Identifier=com.anthropic.claude-code`, `TeamIdentifier=Q6L2SF6YDW`,
`flags=0x10000(runtime)` (hardened runtime), timestamp 2026-09-09 (local binary 2.1.267, 2026-09-20). Binary strings: `Bun.version`
×8, `$bunfs` ×8,865 (Bun's embedded virtual filesystem; module specifiers look like `import{U,Ds}from"/$bunfs/root/chunk-5xharng0.js"`),
`ink` ×3,334, `yoga` ×31, `react-devtools-core` ×0. `docs:setup` states "macOS: signed by 'Anthropic PBC' and notarized by Apple"
and that each release publishes a GPG-signed `manifest.json` with SHA256 checksums (fingerprint `31DD DE24 DDFA B679 F42D 7BD2
BAA9 29FF 1A7E CACE`). The Pragmatic Engineer article (2025-09-23, `https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built`,
fetched 2026-09-20) quotes: "The UI is written in React, using the Ink framework for interactive command-line elements" and
that Bun was chosen "for speed compared to other build systems like Webpack, Vite, and others." Whether the shipped `ink` is
upstream Ink or an in-house fork is UNVERIFIED (see §2.4).

### 1.4 ripgrep is embedded in the executable itself

Binary strings (2.1.267): `function Yeo(){if(no(a.USE_BUILTIN_RIPGREP)){let{cmd:r}=Dxe("rg",[]);if(r!=="rg")return{mode:"system",
command:r,args:[]}}if(Pc()){let r={mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}; …` and the error text
`"ripgrep not found on PATH. Install it (brew install ripgrep / apt install ripgrep / winget install BurntSushi.ripgrep.MSVC) or use the
native claude binary which embeds it."`. Verified by execution (2026-09-20): a symlink named `rg` to the binary prints `ripgrep 14.1.1
(rev 83c373b274)` / `features:+pcre2` and `./rg --no-config -n hello sample.txt` returns `1:hello world`. `claude doctor` run offline in a
throwaway `CLAUDE_CONFIG_DIR` prints `Search: OK (bundled)`; `docs:troubleshooting` says to set `USE_BUILTIN_RIPGREP=0` and check that
"the Search line shows the path of your system ripgrep instead of `OK (bundled)`". Alpine needs `USE_BUILTIN_RIPGREP=0` plus
`apk add … ripgrep` (docs:setup).

### 1.5 Install channels, auto-update, `doctor`

- Native installer (recommended): `curl -fsSL https://claude.ai/install.sh | bash` (`| bash -s stable`, `| bash -s 2.1.89`);
  Homebrew casks `claude-code` (stable) and `claude-code@latest`; `winget install Anthropic.ClaudeCode`; signed apt/dnf/apk repos
  with `stable`/`latest` channels; npm (docs:setup). "Native installations automatically update in the background"; "Claude Code
  checks for updates on startup and periodically while running. Updates download and install in the background, then take effect
  the next time you start Claude Code." Launcher: `~/.local/bin/claude` → symlink into `~/.local/share/claude/versions/` (confirmed
  locally: `~/.local/bin/claude -> …/versions/2.1.267`). Settings: `autoUpdatesChannel: "latest" | "stable"`, `minimumVersion`;
  env `DISABLE_AUTOUPDATER=1` ("Manual `claude update` still works"), `DISABLE_UPDATES=1` blocks everything (docs:env-vars).
- `claude doctor` "prints read-only installation and settings diagnostics without starting a session" (docs:setup). Observed
  output (offline, 2026-09-20): `Running: native (2.1.267)`, `Commit: a9e1808c8204`, `Platform: darwin-arm64`, `Path: …`,
  `Search: OK (bundled)`, `Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)`, `Auto-update channel: latest`, warnings with
  `Fix:` lines. `--bare` "skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and
  CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1" (`claude --help`, 2.1.267, run 2026-09-20).

### 1.6 Startup measurements (the reference machine: Apple Silicon, macOS 26, Node 22.23.2; 2026-09-20)

| Measurement | Result | How |
| --- | --- | --- |
| `claude --version` (Bun native binary 2.1.267) | 22, 23, 24, 23, 22 ms (5 runs, later 23/22/22) | wall clock around `~/.local/bin/claude --version` with `DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| `node -e 0` baseline | 32, 32, 31 ms | same clock |
| JevCode first frame (`node bin/jevcode.js run "x" --perf-exit-after-first-frame` in `script` pty, rows 40 cols 120, fresh `NODE_COMPILE_CACHE`, `JEVCODE_ASSERT_NO_NETWORK=1`) | 127, 117, 111, 112, 113 ms wall; child `FIRST_FRAME_MS` 93.4, 84.0, 79.6, 80.5, 81.3 | same clock; matches README's 80–90 ms child-clock numbers |
| CC first interactive frame (`claude --bare`, fresh `CLAUDE_CONFIG_DIR`, all nonessential traffic/telemetry/updates disabled, Python `pty.fork`, 40×120) | first byte 450 / 337 / 323 / 315 ms; first ≥400-byte frame 480 / 362 / 348 / 337 ms (4 runs) | the frame is the onboarding screen ("Welcome to Claude Code v2.1.267", "Choose the text style that looks best with your terminal", options `1. Auto (match terminal)` … `7. Light mode (ANSI colors only)`) |

Caveat: the CC number includes onboarding UI and whatever a fresh profile does at boot; a logged-in session may differ. It is
still evidence that a 200 MB Bun binary is not faster to first frame than JevCode's 1.5 MB esbuild bundle on Node 22 with
`module.enableCompileCache()`. Escape sequences observed in that first frame: `CSI ? 2004 h` (bracketed paste) ×1, `CSI ? 1004 h`
(focus reporting) ×1, `CSI ? 25 l` (hide cursor) ×1; no `CSI ? 1049 h` (the onboarding runs in the classic renderer) and no
`CSI ? 2026` in a dumb `TERM=xterm-256color` pty.

---

## 2. Rendering: the classic renderer, the flicker history, and fullscreen mode

### 2.1 What the classic Ink path does (verified in JevCode's own `node_modules/ink` 7.1.1, 2026-09-20)

- `render.js`: `maxFps: 30`; `ink.js`: `const renderThrottleMs = maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0` → 34 ms
  between frames by default; `throttle(this.onRender, renderThrottleMs, …)`.
- `log-update.js` erases the previous frame with `ansiEscapes.eraseLines(previousLineCount)` before writing the new one.
- `ink.js` `shouldClearTerminalForFrame({isTty, viewportRows, previousOutputHeight, nextOutputHeight, …})` returns true when
  `wasOverflowing || (isOverflowing && hadPreviousFrame)`, and then `this.options.stdout.write(ansiEscapes.clearTerminal +
  this.fullStaticOutput + outputToRender)` — the whole `<Static>` history is replayed. This is the path JevCode's
  `perf/render-lag.ts` gates at zero `\x1b[2J` after the first frame (DESIGN.md §12).
- The third-party analysis `https://raw.githubusercontent.com/atxtechbro/test-ink-flickering/main/INK-ANALYSIS.md` (fetched
  2026-09-20) describes the same mechanism: "Line 28 is the direct cause of flickering: stream.write(ansiEscapes.eraseLines
  (previousLineCount) + output)" and "every render walks through ALL child nodes recursively. There's no mechanism to skip
  unchanged subtrees."

### 2.2 The flicker history (primary quotes)

- Issue #769 "[BUG] In-progress Call causes Screen Flickering", opened 2025-04-12, still open, assignee `chrislloyd`
  (`https://github.com/anthropics/claude-code/issues/769`, 2026-09-20). Issue #1913 "Terminal Flickering" (2025-06-10, labels
  `area:tui`, `bug`, `duplicate`). Issue #37076 (2026-03-21) argues CC "does full viewport redraws on every state change (every
  streamed token, every tool call update, every UI transition)" and recommends bubbletea/ratatui; closed as duplicate
  (`https://github.com/anthropics/claude-code/issues/37076`, 2026-09-20).
- CHANGELOG 2.0.72 (published 2025-12-17): "Reduced terminal flickering" and "Changed thinking toggle from Tab to Alt+T to avoid
  accidental triggers" (`CHANGELOG.md`, 2026-09-20).
- HN, 2026-01-21, user `chrislloyd` ("I work on TUI rendering for Claude Code"): "we shipped our differential renderer to
  everyone today. We rewrote our rendering system from scratch and only ~1/3 of sessions see at least a flicker. … We've also
  been working upstream to add synchronized output / DEC mode 2026 support to environments where CC runs and have had patches
  accepted to VSCode's terminal and tmux. Synchronized output totally eliminates flickering." In a reply: "The main two perf.
  issues were: 1. Since we no longer have [Static] components the app re-renders much more frequently with larger component
  trees. We were seeing unusual GC pauses because of having too much JSX … Better memoization has largely solved that. 2. The new
  renderer double buffers and blits similar cells between the front and [back buffer]" and, on tmux: "How tall is your tmux pane?
  If it's very small it might still flicker as CC tries to redraw scrollback." (`https://hn.algolia.com/api/v1/items/46701013`,
  2026-09-20). Another Anthropic reply in the same thread: "CC uses scrollback (because that's what most users expect) which it
  has to clear entirely and redraw everything when it changes (causing tearing/flickering)" (`https://news.ycombinator.com/item?id=46699072`,
  2026-09-20).
- Upstream patches by the same engineer: xterm.js PR #5453 "Add synchronized output support (DEC mode 2026)", opened 2025-12-04,
  merged 2025-12-20 (`https://github.com/xtermjs/xterm.js/pull/5453`, 2026-09-20); tmux PR #4744 "Support synchronized output mode
  (DECSET 2026) from applications", opened 2025-12-05, merged 2025-12-17 (`https://github.com/tmux/tmux/pull/4744`, 2026-09-20).
- The community workaround `claude-chill` is a PTY proxy: "Claude Code sends *entire* screen redraws in these sync blocks - often
  thousands of lines. Your terminal receives a 5000-line atomic update when only 20 lines are visible." It "uses a VT100 emulator to
  track screen state and renders only the differences" (`https://raw.githubusercontent.com/davidbeesley/claude-chill/master/README.md`,
  2026-09-20).
- Lesson for JevCode: CC dropped `<Static>` and paid for it with a renderer rewrite. JevCode keeps `<Static>` (append-only items)
  and a fixed-height dynamic region; the zero-clear gate is the cheap version of "differential rendering".

### 2.3 Fullscreen ("alternate screen") rendering (docs:fullscreen, docs:terminal-config, docs:env-vars; 2026-09-20)

- "It draws the interface on the terminal's alternate screen buffer, like `vim` or `htop`, and only renders messages that are
  currently visible." "The input box stays fixed at the bottom of the screen." "Only visible messages are kept in the render tree,
  so memory stays constant regardless of conversation length."
- Enable: `/tui fullscreen` ("saves the `tui` setting and relaunches into fullscreen with your conversation intact"), `/tui default`,
  `/tui` prints the active renderer; env `CLAUDE_CODE_NO_FLICKER=1` (CHANGELOG entries from the 2.1.88–2.1.92 range already speak of
  "`NO_FLICKER` mode", e.g. "Added focus view toggle (`Ctrl+O`) in `NO_FLICKER` mode"; 2.1.88 was published 2026-03-30);
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` forces classic and "Takes precedence over `CLAUDE_CODE_NO_FLICKER` and the `tui` setting".
  A startup dialog offers the switch and "stops offering after it has shown the dialog on three launches"; after two crashed starts
  CC "keeps using the classic renderer" and prints `Claude Code's fullscreen renderer has repeatedly failed to start on the reference machine`.
- Synchronized output: "Claude Code probes the terminal for synchronized-output support at startup and uses it when the terminal
  reports it." `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` "force-enable DEC private mode 2026 synchronized output when your terminal supports
  it but is not auto-detected … Has no effect under tmux." "tmux releases through the 3.6 series don't implement synchronized output".
  CHANGELOG: "Fixed flickering in JetBrains IDE terminals … on 2026.1+ by enabling synchronized output" and "Fixed synchronized
  output being assumed from the terminal's name in GNOME Terminal and Konsole versions that do not support it".
- Trade-offs the docs call out: native `Cmd+F`/tmux search no longer see the conversation (`Ctrl+O` transcript mode, then `[` "writes
  the full conversation into your terminal's native scrollback", `v` opens it in `$VISUAL`/`$EDITOR`); mouse capture breaks native
  copy-on-select (`CLAUDE_CODE_DISABLE_MOUSE=1`, `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`); "Fullscreen rendering is incompatible with
  iTerm2's tmux integration mode (`tmux -CC`)"; `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` for ConPTY hosts that "coalesce these
  positioned writes incorrectly"; `CLAUDE_CODE_SCROLL_SPEED` (0.25–20) and `/scroll-speed`.
- DEC private modes present as literals in the 2.1.267 binary (strings, line-start after the ESC byte, 2026-09-20): `[?25h/l`
  (cursor), `[?2026h/l` (synchronized output), `[?1049h/l` (alternate screen), `[?1000h/l`, `[?1006h/l`, `[?1007h` (mouse: X11,
  SGR, alternate scroll), `[?1l`, `[?12l`; kitty keyboard query `[?u` ×1; `modifyOtherKeys` ×1. OSC prefixes: `]8;` ×11
  (hyperlinks), `]0;` ×3 (title), `]52;` ×2 (clipboard), `]11;` ×1 (background-colour query, presumably for the `auto` theme —
  inference), `]104;` ×1, `]1;`, `]3;`. A third-party deep dive on the leaked source names `utils/fullscreen.ts`, `ink/termio/dec.ts`,
  `ink/components/AlternateScreen.tsx` and says mouse tracking is "DEC 1000 + 1002 + 1003 + 1006", disabled "in reverse order"
  (`https://www.markdown.engineering/learn-claude-code/42-fullscreen-mode`, 2026-09-20; secondary, consistent with the strings).

### 2.4 Is it upstream Ink? (UNVERIFIED)

Issue #3045 (2025-07-06) found "Main executable: Single bundled JavaScript file (`cli.js` - ~7.6MB)", "Zero dependencies in
package.json - everything is bundled", "Claude Code is confirmed to use React Ink for its terminal UI" and specifically "React
Ink's TextInput component" (`https://github.com/anthropics/claude-code/issues/3045`, 2026-09-20) — that was the pre-Bun npm era.
Write-ups about the 2026-03-31 source-map leak (Layer5, NodeSource, InfoQ; fetched 2026-09-20 via search) say CC "uses React with
Ink" and runs on Bun; one dev.to post (dated 2026-04-01, treat with suspicion) claims "a custom React reconciler, a pure TypeScript
Yoga layout port" and "They use React Compiler". The binary has `ink` ×3,334 and `react-devtools-core` ×0. Conclusion: CC's
rendering layer is at minimum a heavily customised Ink-like layer with its own renderer; do not assume upstream Ink behaviour
from CC's behaviour or vice versa.

### 2.5 Screen-reader mode (docs:accessibility, 2026-09-20) — a plain renderer done well

"Claude Code prints labeled lines that a screen reader such as VoiceOver or NVDA reads in order." Enable with `claude
--ax-screen-reader`, `CLAUDE_AX_SCREEN_READER=1`, or `"axScreenReader": true`; first line `[Screen Reader Mode: on via flag]`.
Rules: "No box-drawing characters … No color-only cues … No redraws of content that hasn't changed. Progress spinners render as
static text". Labels: `you:`, `claude:`, `thinking:`, `tool:`, `tool error:`, `error:`, `warning:`, `Permission Required:`,
`Cost:`. It waits 3 s after the confirmation line (`CLAUDE_AX_STARTUP_QUIET_MS`) and 50 ms before writing a changed line
(`CLAUDE_AX_PREPARK_MS`). Mode changes are announced once: `[plan mode on]`, `[accept edits on]`. `prefersReducedMotion` reduces
"spinner, shimmer, and flash animations".

---

## 3. The prompt composer and its key model

### 3.1 Submit vs newline (docs:interactive-mode "Multiline input", docs:terminal-config, 2026-09-20)

| Method | Shortcut | Docs wording |
| --- | --- | --- |
| Quick escape | `\` + `Enter` | "Works in all terminals" |
| Option key | `Option+Enter` | "After enabling Option as Meta on macOS" (Apple Terminal: Settings → Profiles → Keyboard → "Use Option as Meta Key"; iTerm2: Profiles → Keys → General → Left/Right Option key "Esc+"; VS Code: `"terminal.integrated.macOptionIsMeta": true`) |
| Shift+Enter | `Shift+Enter` | "Native in iTerm2, WezTerm, Ghostty, Kitty, Warp, Apple Terminal, Windows Terminal"; other kitty-protocol terminals (foot, Alacritty ≥ 0.16) "Requires Claude Code v2.1.269 or later"; "VS Code, Cursor, Devin Desktop, Alacritty before 0.16, Zed: Run `/terminal-setup` once"; "gnome-terminal, JetBrains IDEs …: Not available; use Ctrl+J or `\` then Enter" |
| Control sequence | `Ctrl+J` | "Works in any terminal without configuration" |

Rebinding: "To bind newline to a different key, or to swap behavior so Enter inserts a newline and Shift+Enter submits, map the
`chat:newline` and `chat:submit` actions in your keybindings file." tmux needs `set -g allow-passthrough on`, `set -s extended-keys
on`, `set -as terminal-features 'xterm*:extkeys'` (docs:terminal-config).

**What `/terminal-setup` writes** (binary strings 2.1.267 + docs:terminal-config, 2026-09-20):
- VS Code / Cursor / Devin Desktop keybinding: `{key:"shift+enter",command:"workbench.action.terminal.sendSequence",args:{text:"\x1B\r"},
  when:"terminalFocus"}` — i.e. Shift+Enter is made to send `ESC CR` (Meta+Enter). Messages: "Installed VSCode terminal Shift+Enter key
  binding" / "… key binding already configured"; existing bindings are backed up ("Error backing up existing … terminal keybindings.
  Bailing out."). It also sets `terminal.integrated.gpuAcceleration` to `"off"` "to prevent garbled text" and
  `terminal.integrated.mouseWheelScrollSensitivity`.
- Zed: merges `{"context":"Terminal","bindings":{"shift-enter":["terminal::SendText","\x1B\r"]}}` into `~/.config/zed/keymap.json`
  (Linux honours `XDG_CONFIG_HOME`), after backing up to `keymap.json.<hash>.bak`.
- Apple Terminal: exports `com.apple.Terminal` with `defaults export` to `~/Library/Preferences/com.apple.Terminal.plist.bak`, edits the
  profile ("enables Option as Meta and turns off the audible bell"), re-imports and runs `killall cfprefsd`; in screen-reader mode the bell
  is left on (since v2.1.211).
- iTerm2: `defaults read com.googlecode.iterm2 AllowClipboardAccess` and enables it ("Applications in terminal may access clipboard") so
  `/copy` and OSC 52 work; "Restart iTerm2 for the change to take effect."

### 3.2 Editing keys (docs:interactive-mode "Text editing"; readline conventions since v2.1.261; not remappable)

`Ctrl+A`/`Ctrl+E` line start/end (logical line in multiline); `Ctrl+K` delete to end of line; `Ctrl+U` delete to line start ("On macOS
… map `Cmd+Backspace` to this shortcut"); `Ctrl+W` "Delete back to previous whitespace … One press removes a whole path or
`--flag=value`"; `Ctrl+Y` paste deleted text; `Alt+Y` cycle paste history; `Alt+B`/`Alt+F`/`Alt+D` word motions ("treat a word as a
run of letters and digits, so punctuation such as `_`, `.`, and `/` separates words"); `Ctrl+_` or `Ctrl+Shift+-` "Undo last input
edit". Other composer keys (General controls table): `Ctrl+S` "Stash or restore prompt"; `Ctrl+G` or `Ctrl+X Ctrl+E` "Open in default
text editor"; `Ctrl+L` "Redraw or clear the screen"; `Ctrl+V` (or `Cmd+V` in iTerm2, `Alt+V` on Windows/WSL) "Paste image from
clipboard — Inserts an `[Image #N]` chip"; `Up/Down` or `Ctrl+P`/`Ctrl+N` "first moves the cursor within the prompt. Once the cursor is
on the first or last visual row, pressing again navigates command history".

### 3.3 Paste handling (docs:terminal-config "Paste large content")

"When you paste more than 800 characters or more than three lines into the prompt, Claude Code collapses the input to a placeholder
such as `[Pasted text #1 +120 lines]` … Claude Code still sends the full content when you submit." Below 12 rows the line threshold
drops. Word/line deletes that reach inside a placeholder "remove the placeholder whole". Pasted content is cached under
`~/.claude/paste-cache/` so recalled history re-sends it; when the cache is gone CC "never sends the literal `[Pasted text #N]` string"
and cancels the submission if removal would change a `!` or `/` command. Bracketed paste (`CSI ? 2004 h`) was observed at startup (§1.6).

### 3.4 Prefix characters (docs:interactive-mode "Quick commands")

| Prefix | Meaning | Notes |
| --- | --- | --- |
| `/` at start | "Command or skill" | menu opens as you type; also mid-prompt after a space (§3.5) |
| `!` at start | "Shell mode — Run a command directly, add its output to the session, and have Claude respond to it" | history-based Tab completion from previous `!` commands in the project; live path completion on `/`; exit with `Escape`, `Backspace`, or `Ctrl+U` on empty; pasting text starting with `!` enters shell mode; `Ctrl+B` backgrounds; runs outside the sandbox; border colour token `bashBorder`; `respondToBashCommands: false` restores "output only" |
| `@` | "File path mention — Trigger file path autocomplete" | plus live sessions after one letter (v2.1.232+); `respectGitignore` keeps ignored files out; `fileSuggestion` (type `command`) can supply candidates from your own command; CHANGELOG 2.0.72: "Improved @ mention file suggestion speed (~3× faster in git repositories)" |
| `:` | Emoji shortcode (v2.1.217+) | `emojiCompletionEnabled` |
| `?` on empty input | "Toggle the shortcut help panel" | typing `?` with text inserts it |
| `#` | memory entry | only evidenced today by the theme token `memoryBackgroundColor` "Background behind `#` memory entries in the transcript" (docs:terminal-config); the memory page no longer documents a `#` shortcut — UNVERIFIED as a current feature |

### 3.5 Completion and the `/` menu (docs:commands "How the command menu matches what you type", docs:interactive-mode)

- "Claude Code highlights the top suggestion only when the letters after the `/` match a command's name or alias, from the start of
  the name or from a word within it, ignoring the `:`, `_`, and `-` separators. Typing `/adddir` highlights `/add-dir`, and typing
  `/new` highlights `/clear` through its alias." After a typo "Claude Code highlights nothing … `Enter` submits your text as typed and
  reports Unknown command." Unavailable commands are left out (`No commands match "/name"`); hidden ones (e.g. `/heapdump`) appear only
  when typed in full.
- Mid-prompt: "type `/` after a space, then the first letters of a name … Outside fullscreen: the rest of the top match appears as ghost
  text at your cursor, with a count such as `+2` when more commands match. Press `Tab` to insert the only match, or to open the list
  when several match". "Commands are only recognized at the start of a message"; "Up to six skills can be chained".
- Autocomplete keys (docs:keybindings `Autocomplete` context): `autocomplete:accept` Tab, `autocomplete:dismiss` Escape,
  `autocomplete:previous/next` Up/Down. Prompt suggestions (grey ghost text after a turn) accept with `Tab` or `Right arrow`; they are
  generated by "a background request that reuses the conversation's prompt cache" and can be disabled with `promptSuggestionEnabled:
  false` (docs:interactive-mode).

### 3.6 History and `Ctrl+R` (docs:interactive-mode "Command history")

"Input history is stored per working directory"; duplicates collapse; `!` history expansion is disabled. Inline reverse search
(classic renderer): `Ctrl+R` start, type to filter, `Ctrl+R` again for older matches, `Tab`/`Esc` accept and keep editing, `Enter`
"accept and execute", `Ctrl+C` cancel and restore, `Backspace` on empty cancels; it "always searches prompts from all projects".
Fullscreen opens a dialog where `Ctrl+S` cycles scope "session, project, everywhere". History file: `~/.claude/history.jsonl`
(CHANGELOG: "Fixed Ctrl+R history search and up-arrow history breaking when `~/.claude/history.jsonl` contains a malformed entry").
`CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` skips writing "prompt history and session transcripts" (docs:env-vars).

### 3.7 Vim mode (docs:interactive-mode "Vim editor mode", docs:terminal-config)

Enabled via `/config` → Editor mode or `"editorMode": "vim"` (`/vim` was "Removed in v2.1.92", docs:commands). Supported: `Esc`/`Ctrl+[`
→ NORMAL; `i I a A o O v V`; motions `h j k l w e b 0 $ ^ gg G f F t T ; ,`; `/` in NORMAL opens history search; operators `x dd D dw cc C
cw yy p P >> << J u .`; text objects `iw aw iW aW i" a" i' a' i( a( i[ a[ i{ a{`; VISUAL `d x y c s p r ~ u U > < J o`. "Block-wise visual
mode with `Ctrl+V` is not supported." "Pressing Enter still submits your prompt in INSERT mode, unlike standard Vim." `vimInsertModeRemaps:
{"jj": "<Esc>"}` (two printable chars, `<Esc>` only, one-second window; read only from user/`--settings`/managed so "a checked-out
repository can't remap your keystrokes"). The status line receives `vim.mode` (`NORMAL`, `INSERT`, `VISUAL`, `VISUAL LINE`) and
`hideVimModeIndicator` suppresses the built-in `-- INSERT --` row (docs:statusline).

### 3.8 Interrupt, cancel, exit (docs:interactive-mode "General controls"; docs:keybindings "Reserved shortcuts")

- `Esc`: "Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far. If you have messages
  queued, Claude Code sends them next. When a dialog is open, `Esc` closes the dialog. On a permission prompt, `Esc` declines the action".
- `Esc Esc`: "When the prompt input contains text, double `Esc` clears it and saves the draft to history so `Up` recalls it. When the
  input is empty, double `Esc` opens the rewind menu".
- `Ctrl+C`: "Interrupts a running operation. If nothing is running, the first press clears the prompt input and a second press exits
  Claude Code" (binary hint string: `Ctrl-C again to exit`). `Ctrl+D`: "The first press shows a confirmation hint and a second press
  within 800ms exits. When the prompt has text, `Ctrl+D` deletes the character after the cursor instead". `Ctrl+Z` suspends (Unix).
- Reserved (cannot be rebound): `Ctrl+C` "Hardcoded interrupt/cancel", `Ctrl+D` "Hardcoded exit", `Ctrl+M` (= Enter), `Ctrl+[` (= Escape),
  `Ctrl+I` (= Tab), `Ctrl+H` (backspace byte; `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE`), Caps Lock. Conflicts: `Ctrl+B` tmux prefix ("press twice
  to send"), `Ctrl+A` screen prefix, `Ctrl+Z` SIGTSTP.

### 3.9 Queueing and steering while the agent works (docs:interactive-mode "Queue messages while Claude works")

"Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn, and lists
the queued entries above the input box until it sends them." Delivery rules: "if you queue a message while Claude is running tool calls,
Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends with messages still queued,
Claude Code sends only the oldest as the next turn"; "Commands and shell commands: Claude Code holds them until the turn ends, then runs
them one at a time"; "Press `Esc` to interrupt the turn instead. Claude Code keeps what you queued and sends it right away." Some commands
run immediately (`/model`, `/effort`, `/fast`, `/status`). Take back: "Press `Up` from the first line of the input box to take back the
queued messages and commands … puts them in the input box, one per line". Keybindings: `chat:queueSubmit` `Ctrl+X Enter` "submits the
draft even while an autocomplete suggestion is highlighted. Requires v2.1.247"; CHANGELOG (2.1.27x): "Added a send-now key (ctrl+enter,
or ctrl+x ctrl+s) that interrupts the current turn and sends all queued messages at once; sent and queued messages show in gray until the
model receives them". Checkpointing caveat: a message that joins a running turn gets no checkpoint (docs:checkpointing).

### 3.10 Keybindings file (docs:keybindings, 2026-09-20)

`/keybindings` opens `~/.claude/keybindings.json`; changes "are automatically detected and applied without restarting". Shape:
`{"$schema": "https://www.schemastore.org/claude-code-keybindings.json", "bindings": [{"context": "Chat", "bindings": {"ctrl+e":
"chat:externalEditor", "ctrl+u": null}}]}`. Contexts: `Global, Chat, Autocomplete, Settings, Confirmation, Tabs, Help, Transcript,
HistorySearch, Task, ThemePicker, Attachments, Footer, MessageSelector, DiffDialog, DiffPanel, ModelPicker, EffortSlider, Select, Plugin,
Agents, Scroll`. Actions are `namespace:action`; defaults that matter: `app:interrupt` Ctrl+C, `app:exit` Ctrl+D, `app:toggleTodos` Ctrl+T,
`app:toggleTranscript` Ctrl+O, `history:search` Ctrl+R, `chat:cancel` Escape, `chat:submit` Enter, `chat:queueSubmit` Ctrl+X Enter,
`chat:newline` Ctrl+J, `chat:undo` Ctrl+_, `chat:externalEditor` Ctrl+G, `chat:stash` Ctrl+S, `chat:cycleMode` Shift+Tab (Meta+M on
Windows without VT), `chat:modelPicker` Meta+P, `chat:thinkingToggle` Meta+T, `chat:fastMode` Meta+O, `confirm:yes` Y/Enter,
`confirm:no` N/Escape, `confirm:nextField` Tab, `confirm:toggle` Space, `confirm:cycleMode` Shift+Tab, `task:background` Ctrl+B /
Ctrl+X Ctrl+B, `transcript:toggleShowAll` Ctrl+E, `transcript:exit` q/Ctrl+C/Escape, `select:next` Down/J/Ctrl+N, `select:previous`
Up/K/Ctrl+P, `messageSelector:up/down` with `K`/`J`. Chords: "sequences of keystrokes separated by spaces … Press each keystroke within 3
seconds"; `null` unbinds; validation warns on unknown contexts/actions, reserved conflicts and duplicates and "writes each one to the debug
log". `cmd` bindings "only detected in terminals that report the Super modifier, such as those supporting the Kitty keyboard protocol or
xterm's `modifyOtherKeys`".

---

## 4. Slash commands (docs:commands "All commands", exact purpose text, 2026-09-20)

| Command | Purpose (as written) |
| --- | --- |
| `/clear [name]` | "Start a new conversation with empty context" (alias `/new`; the previous conversation stays resumable) |
| `/compact [instructions]` | "Free up context by summarizing the conversation so far" (in a fresh session prints `Not enough messages to compact.`; docs:costs) |
| `/autocompact [auto\|<tokens>]` | "Set the auto-compact window: how full the context window gets before Claude Code compacts automatically" |
| `/config [key=value ...]` | "Open the Settings interface to adjust theme, model, output style, and other preferences" (`/config verbose=true`) |
| `/context [all]` | "Visualize current context usage as a colored grid" |
| `/cost` | "Alias for `/usage`" |
| `/usage` | "Show session cost, plan usage limits, and activity stats" (Session block example: `Total cost: $0.55` / `Total duration (API): 6m 20s` / `Total duration (wall): 6h 33m 10s` / `Total code changes: 0 lines added, 0 lines removed` / `Usage by model: claude-sonnet-4-6: 1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write ($0.55)`; docs:costs) |
| `/diff` | "Review the changes in your working tree, including the edits Claude has made so far" (viewer in classic; side panel ≥110 columns in fullscreen) |
| `/doctor` | "**[Skill]** Run a setup checkup that diagnoses issues and can fix them" (`claude doctor` is the read-only CLI form) |
| `/export [filename]` | "Export the current conversation as plain text" |
| `/focus` | "Toggle the focus view, which shows only your last prompt, a one-line tool-call summary with edit diffstats, and the final response" |
| `/help` | "Show help and available commands" |
| `/keybindings` | "Open your keyboard shortcuts file" |
| `/memory` | "Edit `CLAUDE.md` files, enable or disable auto memory, and view auto memory entries" |
| `/model [model]` | "Switch the AI model and save it as your default for new sessions" |
| `/effort [level\|auto\|status]` | "Set the effort level: `low` to `xhigh`, `max`, `ultracode`, or `auto`" |
| `/permissions` | "Manage allow, ask, and deny rules for tool permissions" |
| `/plan [description]` | "Enter plan mode directly from the prompt" |
| `/rename [name]` | "Rename the current session and show the name on the prompt bar. Without a name, auto-generates one from conversation history" |
| `/resume [session]` | "Resume a conversation by ID or name, or open the session picker" (alias `/continue`) |
| `/branch [name]` | "Create a branch of the current conversation at this point" |
| `/rewind` | "Rewind the conversation and/or code to a previous point, or summarize from a selected message" (aliases `/checkpoint`, `/undo`) |
| `/status` | "Open the Settings interface on the Status tab, showing version, model, account, and connectivity" (its `Setting sources` line names managed sources; docs:settings) |
| `/statusline` | "Configure Claude Code's status line. Describe what you want, or run without arguments to auto-configure from your shell prompt" |
| `/tasks` | "View and manage background work in the current session, including subagents that have finished" (alias `/bashes`) |
| `/terminal-setup` | "Install a Shift+Enter keybinding for newlines in VS Code, Cursor, Devin Desktop, Alacritty, or Zed. In Apple Terminal, enable Option+Enter for newlines and turn off the audible bell" |
| `/theme` | "Change the color theme. Includes an `auto` option that matches your terminal's light or dark background, light and dark variants, colorblind-accessible (daltonized) themes, ANSI themes that use your terminal's color palette, and any custom themes" |
| `/tui [default\|fullscreen]` | "Set the terminal UI renderer and relaunch into it with your conversation intact" |
| `/btw [question]` | "Ask a side question about the current session without adding to the conversation" (overlay; no tools; `c` copy, `f` fork) |
| `/release-notes` | "View the changelog in an interactive version picker" |
| `/vim` | "Removed in v2.1.92. To toggle between Vim and Normal editing modes, use `/config` → Editor mode" |
| `/exit` | "Exit the CLI" |

Custom commands are skills (docs:slash-commands, 2026-09-20): `.claude/commands/deploy.md` (legacy) and `.claude/skills/deploy/SKILL.md`
both create `/deploy`; personal ones live in `~/.claude/skills/`; frontmatter fields include `name`, `description`, `argument-hint`,
`arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `effort`, `context: fork`, `paths`; substitutions
`$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_PROJECT_DIR}`; inline shell injection `` !`git diff HEAD` ``
runs before the model sees the skill ("Non-zero exit aborts entire skill invocation"; `"disableSkillShellExecution": true`); `@file`
references attach files; namespacing `/plugin-name:skill-name`, `/apps/web:deploy`; MCP prompts as `/mcp:server-name:prompt-name`.

---

## 5. Permissions, modes and the review prompt

### 5.1 Modes and the `Shift+Tab` cycle (docs:permission-modes, 2026-09-20)

| Mode | "What runs without asking" |
| --- | --- |
| `default` (labelled **Manual**) | "Reads only" |
| `acceptEdits` | "Reads, file edits, and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, etc.)" |
| `plan` | "Reads, plus classifier-approved commands when auto mode is available" |
| `auto` | "Everything, with background safety checks" (a classifier model reviews actions) |
| `dontAsk` | "Reads and pre-approved tools; anything that would prompt is denied" |
| `bypassPermissions` | "Everything" — "Isolated containers and VMs only" |

"press `Shift+Tab` to cycle permission modes. From `auto`, the first press switches to `default`, and the cycle then runs `default` →
`acceptEdits` → `plan` → back to `default`." Optional modes slot in after `plan`; `dontAsk` never appears. Indicators: "`⏸ manual mode
on`", "`⏵⏵ accept edits on`" in the status bar; binary strings also contain `plan mode on` and `auto mode on`. Start mode:
`--permission-mode <mode>` (also `manual` alias), `permissions.defaultMode` in settings ("`auto` … in `.claude/settings.json` or
`.claude/settings.local.json` … doesn't take effect", `bypassPermissions` there "starts in Manual mode"). `--dangerously-skip-permissions`
= bypass; `--allow-dangerously-skip-permissions` adds it to the cycle without enabling it (`claude --help`).

### 5.2 The permission prompt (docs:permissions; binary strings 2.1.267; 2026-09-20)

- Option wording found in the binary: `"Yes, and don't ask again for ", <tool name>, " commands", " in ", <bold cwd>` (or `"on ", <host>`
  for remote/sandbox hosts); `"Yes, and always allow access to ", <path>, " from this project"`; `"Yes, and don't ask again for ",
  <domain>` (WebFetch); `"No, and tell Claude what to do differently ", <bold "(esc)">`; `"Deny, and tell Claude what to do differently
  (esc)"`; `eD={accept:"tell Claude what to do next",reject:"tell Claude what to do differently"}`; default question `"Do you want to
  proceed?"`; the always-allow label is dropped when it would not fit: `A=(w)=>\`Yes, and don't ask again for ${u.userFacingName} commands
  in ${w}\`` tried with the full cwd, then an abbreviated one, else `null`. A schema field explains suppression: `suppress_always_allow_rule:
  "True when the dialog must not offer the persistent "don't ask again" row for this ask: accepting it would write a whole-tool allow rule
  broader than the ask's own verb"`. Docs: "Sometimes a permission prompt offers only a one-time approval … Claude Code offers those options
  only when the prompt can show you everything they would allow".
- Keys (docs:keybindings `Confirmation`): `Y`/`Enter` yes, `N`/`Escape` no, Up/Down move, `Tab` "Next field" = "opens a comment field on
  that option" (Yes: "Claude Code runs the action, then sends your comment to Claude after the result"; No: "sends your comment to Claude
  as the reason for the denial, and Claude continues working. If you select **No** without a comment … Claude Code stops the turn").
  `Shift+Tab` on a file prompt "selects the option that allows the action for the rest of the session". Bash prompts add "**Yes, and switch
  to auto mode**" when auto mode is available. "Left/Right arrows: Cycle through dialog tabs". Mouse click selects in fullscreen.
- Persistence: "When you choose 'Yes, and don't ask again' … Claude Code saves the rule to `.claude/settings.local.json` at the root of the
  git repository"; compound commands save "a separate rule for each subcommand"; the written form is `Bash(npm run *)` (space form; `:*`
  suffix equivalent). Rule grammar `Tool(specifier)`: `Bash(npm run build)`, `Read(./.env)`, `Edit(/path/**)`, `WebFetch(domain:example.com)`,
  `mcp__server__tool`, `Tool(param:value)` for deny/ask; evaluation "deny, then ask, then allow"; a bare `Bash` deny "removes the tool from
  Claude's context entirely".
- No prompts for a built-in read-only command set ("Commands longer than 10,000 characters always prompt"); wrappers `timeout`, `time`,
  `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs` are stripped before matching; `cd` + `git` prompts "since running
  `git` in a new directory can execute that directory's hooks"; redirect targets are checked against `Edit`/`Read` rules and protected paths.
- Risk language: CC has no numeric risk. The classic prompt used to offer a model-written explanation ("Before v2.1.257, a
  `confirm:toggleExplanation` action, bound to `Ctrl+E` … showed a model-generated explanation of the command"; CHANGELOG: "Removed the
  Ctrl+E command explanation on Bash and PowerShell permission prompts"). Risk vocabulary lives in the auto-mode classifier rules
  (binary strings: `git_destructive`, `irreversible_deletion_general`, `irreversible_local_destruction`, `instruction_poisoning`,
  `merge_without_review`; "destructive/irreversible actions that user intent can clear"). `PermissionRequest` hooks can answer with
  `hookSpecificOutput.decision.behavior` allow/deny and `PreToolUse` with `permissionDecision: "allow" | "deny" | "ask"` plus
  `permissionDecisionReason` and `updatedInput` (docs:hooks).
- Away-from-keyboard notification: the `Notification` hook matcher `permission_prompt` fires when "the prompt has waited about six seconds
  … each keystroke defers it"; `idle_prompt` "about 60 seconds after Claude finishes responding" (docs:hooks).

### 5.3 Plan mode (docs:permission-modes "Analyze before you edit")

"Enter plan mode by pressing `Shift+Tab` or prefixing a single prompt with `/plan`" or `claude --permission-mode plan`; "Press `Shift+Tab`
again to leave plan mode without approving a plan." Approval dialog options: "**Yes, and use auto mode** … When auto mode is unavailable,
this option reads **Yes, auto-accept edits** … **Yes, manually approve edits** … **No, keep planning**"; `showClearContextOnPlanAccept`
adds a "clear context" option. Accepting a plan also titles the session (docs:sessions). Theme token `planMode` colours "Plan mode accent,
plan messages, and plan-mode dialogs".

---

## 6. Sessions, resume, checkpoints, memory

### 6.1 Sessions (docs:sessions, docs:cli-reference, 2026-09-20)

- Storage: "`~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric
  characters replaced by `-`" (names >200 chars are truncated + hashed). "Each line is a JSON object … The entry format is internal to
  Claude Code and changes between versions". `CLAUDE_CONFIG_DIR` relocates everything; `CLAUDE_CODE_PROJECT_DIR_NAME` pins the slug;
  `cleanupPeriodDays` (30) governs the retention sweep.
- Entry points: `claude --continue` / `-c` ("Reopens the most recent conversation in the current directory"), `claude --resume` / `-r`
  (picker), `--resume <name|id|transcript-path>`, `--from-pr <n>`, `--fork-session`, `--session-id <uuid>`, `--name`/`-n` (also sets the
  terminal title), `/resume`, `/rename`, `/branch`. Resume restores conversation, model, agent, permission mode (with exceptions), goal
  and scheduled tasks — but not `--mcp-config`, `--settings`, `--plugin-dir`, `--add-dir`.
- Picker keys: `↑/↓` navigate, `→/←` expand/collapse groups, `Enter` resume, `Space` preview (`Ctrl+V` fallback), `Ctrl+R` rename, `/` or any
  printable character searches (paste a PR URL to find its session), `Ctrl+A` all projects, `Ctrl+W` all worktrees, `Ctrl+B` current branch,
  `Esc` exit. Rows show "the session name if you set one, otherwise the AI-generated session title, conversation summary, or first prompt,
  along with time since last activity, git branch, and file size"; background sessions are marked `bg`.
- Naming: unnamed sessions get a default display name (`my-app-3f`) and "a short summary of your first prompt, written by a background
  request to the small/fast model, normally a Haiku-class model"; duplicate live names get a suffix like `auth-refactor-graceful-unicorn`.
- Cost of these conveniences: "Background jobs that summarize previous conversations for the `claude --resume` feature … consume a small
  amount of tokens (typically under $0.04 per session)" (docs:costs).

### 6.2 Checkpointing and rewind (docs:checkpointing, 2026-09-20)

"checkpointing automatically captures the state of your code before each prompt you send that starts a turn"; "Claude Code keeps file
snapshots for the 100 most recent checkpoints in a session"; snapshots are swept after `cleanupPeriodDays`. Menu: "Run `/rewind`, or press
`Esc` twice when the prompt input is empty"; options "**Restore code and conversation** … **Restore conversation** … **Restore code** …
**Summarize from here** … **Summarize up to here** … **Never mind**"; code options appear "only when the selected checkpoint has tracked
file changes"; after restore "the original prompt from the selected message is restored into the input field". Limitations: "Checkpointing
does not track files modified by Bash commands", subagent edits and external edits aren't restored, symlinked/hard-linked files are skipped
("`Restored the code, but skipped N files`"), and "Not a replacement for version control". The `MessageSelector` context binds `Up/K/Ctrl+P`,
`Down/J/Ctrl+N`, `Ctrl+Up`/`Shift+K` top, `Enter` select (docs:keybindings).

### 6.3 Memory (docs:memory, 2026-09-20)

Files: managed policy `CLAUDE.md`, project `./CLAUDE.md` or `./.claude/CLAUDE.md`, user `~/.claude/CLAUDE.md`, local `./CLAUDE.local.md`
(gitignore it), `.claude/rules/*.md` (recursive; `paths:` frontmatter scopes a rule; symlinks allowed), `~/.claude/rules/`. Loading: "loads
`CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every directory above it"; subdirectory files "are included when
Claude reads files in those subdirectories"; `@path/to/import` (relative to the file, depth 4, external imports need approval). Auto memory
is on by default, toggled in `/memory` (`autoMemoryEnabled`), stored under `<config>/projects/<slug>/memory/` (from the
`CLAUDE_CODE_PROJECT_DIR_NAME` example in docs:sessions). `/init` generates a CLAUDE.md; `--bare` and `CLAUDE_CODE_SIMPLE=1` skip discovery.

---

## 7. Footer, status line, notifications, spinner, thinking, output, themes

### 7.1 Footer and hints

The footer shows keyboard hints (`esc to interrupt`, `? for shortcuts`, `hold space to speak`), the permission-mode indicator, a PR/MR badge
("PR #446" with a green/yellow/red/gray underline; OSC 8 hyperlink; `FORCE_HYPERLINK=0/1`; refreshed after `git push`/`gh pr`), footer
indicators for tasks/teams/diff/artifacts (`Footer` keybinding context), `footerLinksRegexes` for clickable IDs, and the `Ctrl+T` task list
("shows up to five tasks at a time") (docs:interactive-mode, docs:statusline, docs:settings-reference). "With a custom status line configured,
Claude Code stops showing most of the footer's keyboard hints, including `esc to interrupt`, the `? for shortcuts` fallback" (docs:statusline).
Binary strings confirm the hint texts `esc to interrupt`, `? for shortcuts`, `Ctrl-C again to exit`, `(ctrl+o to expand)`, `Cooked for`,
`Next:` (the spinner's next-task line).

### 7.2 Status line (docs:statusline, 2026-09-20)

- Config: `"statusLine": {"type": "command", "command": "~/.claude/statusline.sh", "padding": 2}`; optional `refreshInterval` (seconds,
  min 1), `hideVimModeIndicator`; `/statusline <natural language>` generates the script into `~/.claude/`.
- "Your script runs once when a session starts … After that, it runs again when: A new assistant message arrives · `/compact` finishes ·
  The permission mode changes · Vim mode toggles · You change the `command` … · A `refreshInterval` timer elapses · A rate-limit window …
  reaches its `resets_at` time · A warm prompt cache … reaches its `expires_at` time". "Claude Code debounces updates at 300ms … If a new
  update triggers while your script is still running, Claude Code cancels the in-flight script."
- Output: multiple lines = multiple rows; ANSI colours; OSC 8 links; "Read the `COLUMNS` and `LINES` environment variables instead" of
  `tput cols`. "It temporarily hides during certain UI interactions, including autocomplete suggestions, the help menu, and permission
  prompts." "The status line renders in its own row above the built-in footer badges".
- stdin JSON (field names verbatim): `model.id`, `model.display_name`, `cwd`, `workspace.current_dir`, `workspace.project_dir`,
  `workspace.added_dirs`, `workspace.git_worktree`, `workspace.repo.{host,owner,name}`, `cost.total_cost_usd`, `cost.total_duration_ms`,
  `cost.total_api_duration_ms`, `cost.total_lines_added`, `cost.total_lines_removed`, `context_window.total_input_tokens`,
  `context_window.total_output_tokens`, `context_window.context_window_size`, `context_window.used_percentage`,
  `context_window.remaining_percentage`, `context_window.current_usage.{input_tokens,output_tokens,cache_creation_input_tokens,
  cache_read_input_tokens}`, `exceeds_200k_tokens`, `fast_mode`, `effort.level`, `thinking.enabled`, `rate_limits.five_hour.*`,
  `rate_limits.seven_day.*`, `rate_limits.spend_limit.*`, `prompt_cache.{warm,caching_observed,ttl,expires_at,misses,expected_rebuilds,
  hit_ratio,cache_write_tokens,miss_recache_tokens,recache_tokens_if_cold}`, `session_id`, `session_name`, `prompt_id`, `transcript_path`,
  `version`, `output_style.name`, `vim.mode`, `agent.name`, `pr.{number,url,review_state,kind}`, `worktree.{name,path,branch,original_cwd,
  original_branch}`, `hook_event_name`. "Fields may be `null` before the first API response completes". A `subagentStatusLine` command
  receives all visible subagent rows and returns `{"id","content"}` lines.

### 7.3 Notifications, bell, title (docs:terminal-config, docs:hooks, docs:settings-reference, binary strings; 2026-09-20)

- "By default Claude Code sends a desktop notification only in Ghostty, Kitty, and iTerm2. In other terminals, set `preferredNotifChannel`
  to `"terminal_bell"`". Values seen in the binary switch: `iterm2`, `iterm2_with_bell`, `kitty`, `ghostty`, `terminal_bell`,
  `notifications_disabled`, `auto` (auto picks by `$TERM_PROGRAM`, e.g. `Apple_Terminal` → `terminal_bell`); helper functions
  `notifyITerm2`, `notifyKitty`, `notifyGhostty`, `notifyBell`, `progress`. Which OSC each uses is not visible as a literal in the strings
  (UNVERIFIED); the hook schema in the binary says: `terminalSequence: "A terminal escape sequence (e.g. OSC 9 / OSC 777 desktop-notification)
  for Claude Code to emit on your behalf. Only notification/title OSCs (0, 1, 2, 9, 99, 777) and BEL are permitted; anything else is dropped."`
  iTerm2 needs Settings → Profiles → Terminal → "Notification Center Alerts" + "Filter Alerts → Send escape sequence-generated alerts"; tmux
  needs `allow-passthrough on`. `Notification` hooks fire "even with desktop notifications turned off" and can run `afplay …`.
- Timing (docs:hooks): `permission_prompt` after ~6 s without typing; `idle_prompt` ~60 s after the response; `elicitation_dialog` 6 s;
  `agent_needs_input`, `agent_completed` for background sessions.
- Terminal title: OSC 0 (`]0;` ×3 in the binary); `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` "disable automatic terminal title updates based
  on conversation context"; `--name` "shown in `/resume` and terminal title". Progress bar: `terminalProgressBarEnabled` (tmux passthrough
  needed; docs:terminal-config).

### 7.4 Spinner and turn duration

- Verbs (binary strings, contiguous list): Accomplishing, Actioning, Baking, Booping, Brewing, Cerebrating, Channelling, Clauding, Cogitating,
  Combobulating, Computing, Cooking, Crunching, Deliberating, Discombobulating, Doing, Effecting, Elucidating, Envisioning, Flibbertigibbeting,
  Forging, Frolicking, Germinating, Hatching, Herding, Honking, Ideating, Imagining, Incubating, Inferring, Manifesting, Marinating, Meandering,
  Moseying, Mulling, Mustering, Musing, Noodling, Percolating, Perusing, Philosophising, Pondering, Puttering, Reticulating, Ruminating,
  Schlepping, Shimmying, Simmering, Smooshing, Spelunking, Spinning, Stewing, Synthesizing, Tinkering, Transmuting, Unfurling, Unravelling,
  Vibing, Wandering, Whirring, Wibbling (plus Working, Thinking). Settings: `spinnerVerbs` "Add or replace the verbs shown while a turn runs",
  `spinnerTipsEnabled`, `spinnerTipsOverride` (`{id, text, cooldownSessions, priority}`, `tipsFile`), `showTurnDuration` ("Hide the 'Cooked
  for' duration after each response"; binary: `Show "Cooked for Nm Ns" after each assistant turn`), `prefersReducedMotion`.
- CHANGELOG: "the spinner status during long thinking: it now reads 'deep in thought' after 45s, and shows 'picking the thought back up'
  while recovering from the output-token limit"; "while a SessionStart, UserPromptSubmit, PreToolUse or SessionEnd hook runs, the spinner
  says so with elapsed time"; "the label and the 'Next:' task line now stay within one terminal row"; "keystrokes no longer occasionally wait
  a frame behind spinner or streaming repaints". Theme tokens `claude`/`claudeShimmer` colour "the spinner's animated gradient".

### 7.5 Thinking display

`Option+T`/`Alt+T` "Toggle extended thinking" (changed from Tab in 2.0.72 "to avoid accidental triggers"); `alwaysThinkingEnabled`;
`showThinkingSummaries` "See summaries of Claude's thinking instead of a collapsed stub"; screen-reader label `thinking:`; `ultrathink` in a
prompt is rendered with a rainbow gradient (tokens `rainbow_<color>`) (docs:interactive-mode, docs:settings-reference, docs:terminal-config).
Binary strings: `Thought for` ×1, `(ctrl+o to expand)` ×2.

### 7.6 Truncation and expansion

`Ctrl+O` "Toggle transcript viewer — Shows detailed tool usage and execution, with a timestamp and the model used on each assistant message.
Also expands lines that collapse by default, such as MCP calls, shown as a single `Called slack 3 times` line"; classic-renderer `Ctrl+E`
"Toggle show all content"; fullscreen: "Click a collapsed tool result to expand it". Limits: Bash results "Inline up to roughly 30,000
characters by default; past that, the path of a file saved to the session directory … plus a preview of up to the first 2,000 characters"
(`BASH_MAX_OUTPUT_LENGTH` default 30,000, max 150,000; `bashOutputMaxChars` up to 128,000; docs:tools-reference); "A Markdown table with more
than 200 rows renders its first 200 rows followed by a `… N more rows not shown` line" (docs:troubleshooting); "a diff contained a very long
single line … such lines now render truncated with a marker" (CHANGELOG). `/focus` hides everything but prompt, one-line tool summary and
final response.

### 7.7 Themes (docs:terminal-config "Match the color theme", docs:settings-reference, onboarding observed 2026-09-20)

Presets: `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi` plus `auto` ("detects your terminal's light or
dark background, so the theme follows OS appearance changes whenever your terminal does"). Onboarding wording: "Choose the text style that
looks best with your terminal / To change this later, run /theme / 1. Auto (match terminal) 2. Dark mode 3. Light mode 4. Dark mode
(colorblind-friendly) 5. Light mode (colorblind-friendly) 6. Dark mode (ANSI colors only) 7. Light mode (ANSI colors only)". Custom themes:
`~/.claude/themes/<slug>.json` with `name`, `base`, `overrides` (values `#rrggbb`, `rgb()`, `ansi256(n)`, `ansi:<name>`; unknown tokens
ignored; hot-reloaded). Tokens: `claude`, `text`, `inverseText`, `inactive`, `subtle`, `suggestion`, `permission`, `remember`, `success`,
`error`, `warning`, `merged`, `promptBorder`, `planMode`, `autoAccept`, `bashBorder`, `ide`, `fastMode`, `effortUltra`, `diffAdded`,
`diffRemoved`, `diffAddedDimmed`, `diffRemovedDimmed`, `diffAddedWord`, `diffRemovedWord`, `userMessageBackground`,
`bashMessageBackgroundColor`, `memoryBackgroundColor`, `selectionBg`, `rate_limit_fill`, `briefLabelYou`, `briefLabelClaude`,
`<color>_FOR_SUBAGENTS_ONLY`, shimmer variants. `/color` sets the prompt-bar colour per session; `Ctrl+T` in the `/theme` picker toggles
syntax highlighting.

---

## 8. Settings surfaces (docs:settings, docs:settings-reference, docs:env-vars; 2026-09-20)

Precedence (highest first): managed (`managed-settings.json`, MDM, console) → `claude --settings <json|path>` → `.claude/settings.local.json`
→ `.claude/settings.json` → `~/.claude/settings.json`; `~/.claude.json` is the app-written global config (sign-in, MCP, trust). "Settings
files are strict JSON: a `//` comment or a trailing comma is a syntax error". `/config` "lists a short set of personal options such as
theme, editor mode, and verbose output, not every settings key"; writes theme etc. to user settings and "Show tips" to project-local.
UI-related keys (exact one-liners): `editorMode` "Use vim key bindings in the input prompt"; `axScreenReader`; `prefersReducedMotion`;
`preferredNotifChannel`; `showTurnDuration`; `spinnerTipsEnabled`; `spinnerTipsOverride`; `spinnerVerbs`; `autoScrollEnabled`;
`promptSuggestionEnabled`; `emojiCompletionEnabled`; `fileSuggestion`; `respectGitignore`; `respondToBashCommands`; `defaultShell`;
`statusLine`; `footerLinksRegexes`; `alwaysThinkingEnabled`; `showThinkingSummaries`; `bashOutputMaxChars`; `autoMemoryEnabled`;
`autoCompactEnabled`; `autoCompactWindow`; `permissions.defaultMode`; `skipDangerousModePermissionPrompt`; `showClearContextOnPlanAccept`;
`env`; `autoUpdatesChannel`; `minimumVersion`; `tui`; `cleanupPeriodDays`; `vimInsertModeRemaps`; `theme`. Env vars that matter to a TUI:
`CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT`, `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT`,
`CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_DISABLE_MOUSE_CLICKS`, `CLAUDE_CODE_SCROLL_SPEED`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`,
`CLAUDE_CODE_BS_AS_CTRL_BACKSPACE`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` ("disable nonessential network traffic:
auto-updates, telemetry, error reporting, the `/feedback` command … release notes, the PR and MR status badge checks"), `DISABLE_AUTOUPDATER`,
`DISABLE_UPDATES`, `DISABLE_COST_WARNINGS`, `USE_BUILTIN_RIPGREP`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`,
`CLAUDE_CODE_SHELL_PREFIX`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` ("strip credentials from subprocess environments"), `BASH_MAX_OUTPUT_LENGTH`,
`CLAUDE_AX_SCREEN_READER`, `CLAUDE_CODE_ACCESSIBILITY`, `FORCE_HYPERLINK`. Also `CLAUDECODE=1` is set in every subprocess CC spawns.

---

## 9. What this means for JevCode (design implications, before the tables)

- JevCode's constraints (Node 22.23.2, ink 7.1.1 + react 19.3.0 only, one esbuild bundle, first frame < 300 ms with zero network, zero clears
  after the first frame, keys never in logs; DESIGN.md §10/§12) are compatible with everything in §3–§7 except mouse capture, alternate
  screen and script-based status lines. CC's own history shows the alternate-screen route was a rescue for a renderer that had abandoned
  `<Static>`; JevCode never left it.
- The composer must live inside the `rows − 2` dynamic budget: prompt box (1–N rows, capped), queue list (≤ 3 rows), status line (1),
  decisions pane (shrinks first), live region (2). CC's own recipe for tall content — commit it to scrollback, collapse the rest — is what
  `<Static>` already does; CC's collapse markers (`(ctrl+o to expand)`, `+N lines`, `… N more rows not shown`) give the vocabulary.
- Keys: JevCode currently reads only `y`/`n`/Ctrl-C through one `useInput`. Adopting CC's key model means a small key-dispatch layer with
  contexts (`Chat`, `Confirmation`, `Select`, `Transcript`) and `namespace:action` names, so a future `~/.config/jevcode/keybindings.json`
  can reuse CC's schema conventions. Shift+Enter arrives as `ESC CR` (what `/terminal-setup` installs) or as CSI-u `\x1b[13;2u` in kitty-protocol
  terminals; both must be recognised as `chat:newline` without enabling the kitty protocol.
- Jev-native differences worth making visible where CC shows nothing: the review prompt shows the four risk dimensions with probability and
  confidence (CC shows none); the decisions pane is the "transcript viewer" for Jev; a `Ctrl+O`-style toggle can switch between the
  compact transcript and the full decisions log; and "steering" text is not a chat turn but a directive Jev sees at the next intent choice.
- Sessions: `~/.jevcode/runs/<run-id>/` already holds `run.json`, `state.json`, `transcript.log`; a `--continue` (most recent run for this
  workspace) and a picker over runs (task summary, age, step count, stop reason, cost) map one-to-one onto CC's picker rows and keys.

---

## ADOPT

| What JevCode should do | Why | Source |
| --- | --- | --- |
| Composer submit/newline keys exactly as CC: `Enter` submits; `Ctrl+J`, `\`+`Enter`, `ESC CR` (Option+Enter / `/terminal-setup` output) and CSI-u `13;2u` (native Shift+Enter) insert a newline; `chat:submit`/`chat:newline` swappable | Works in every terminal without setup; matches what CC users already have configured in VS Code/Zed/iTerm2 | docs:interactive-mode, docs:terminal-config, binary `sendSequence … "\x1B\r"` (2026-09-20) |
| `Esc` interrupts the step; `Esc Esc` clears the draft (saving it to history) or opens a rewind/resume menu when empty; `Ctrl+C` interrupt → clear → exit-on-repeat with a `Ctrl-C again to exit` hint; `Ctrl+D` twice within 800 ms exits | Predictable, documented, and compatible with JevCode's `human_abort` shutdown path | docs:interactive-mode General controls; docs:keybindings Reserved (2026-09-20) |
| Bracketed paste (`CSI ? 2004 h/l`) and collapsing pastes > 800 chars or > 3 lines into `[Pasted text #N +L lines]`, sending the full text on submit | Keeps the composer inside the height budget; multi-line pastes never trigger a submit | docs:terminal-config Paste large content; startup pty observed `[?2004h` (2026-09-20) |
| Queue-while-running: `Enter` during a step queues, list queued items above the composer, `Up` from the first row takes them back, `Esc` interrupts and delivers now; deliver at the next step boundary and hand the text to Jev as a directive | This is CC's steering model and it maps cleanly onto JevCode's step loop; no mid-request interruption of the generator | docs:interactive-mode Queue messages (2026-09-20) |
| `/` menu with alias support, matching "from the start of the name or from a word within it, ignoring `:`, `_`, `-`", ghost-text completion with a `+N` count, `Tab` to accept/open, `Enter` submits typed text after a typo | Low-cost, high-polish; avoids surprising command execution on typos | docs:commands How the command menu matches (2026-09-20) |
| `!` shell mode with a distinct border colour, output committed to the transcript, `Esc`/`Backspace`/`Ctrl+U` on empty to exit; run it through JevCode's sandbox (unlike CC) | Users expect `!` for ad-hoc commands; JevCode can be stricter than CC here | docs:interactive-mode Shell mode; theme token `bashBorder` (2026-09-20) |
| `@` file completion sourced from `git ls-files` (respects .gitignore), cached per run, with `Tab` accept | CC found gitignore-respecting candidates and a 3× faster git path worth shipping | docs:settings-reference `respectGitignore`, `fileSuggestion`; CHANGELOG 2.0.72 (2026-09-20) |
| `Ctrl+R` reverse history (inline, per-workspace history file, duplicates collapsed, `Ctrl+R` next, `Tab`/`Esc` accept, `Enter` execute, `Ctrl+C` cancel); `Up`/`Down` history only from the first/last visual row | Readline muscle memory; documented semantics | docs:interactive-mode Command history (2026-09-20) |
| Review prompt: options "Yes", "Yes, and don't ask again for `<kind>` `<target>` in `<workspace>`", "No, and tell Jev/the generator what to do differently (esc)"; `y`/`Enter`, `n`/`Esc`, number keys, `Tab` opens a comment field whose text becomes the decline reason fed back to the generator; suppress the always-allow row when it would grant more than shown | CC's wording is battle-tested; the comment field is the cheapest steering channel; JevCode adds the risk dimensions CC lacks | binary strings 2.1.267; docs:permissions Add a comment (2026-09-20) |
| Persist "don't ask again" as `allow` rules in a project-local file (`.jevcode/settings.local.json`, gitignored) with `Tool(specifier)` grammar (`run(npm test *)`, `edit(src/**)`), evaluated deny → ask → allow; rules only skip the human confirm for 0.3–0.7 risk, never Jev's scoring or the ≥ 0.7 block | Same UX as CC without weakening JevCode's fixed thresholds | docs:permissions Manage permissions, Wildcard patterns (2026-09-20); README risk thresholds |
| Mode indicator on the prompt border (`⏸ manual` / `⏵⏵ accept edits` style) and `Shift+Tab` to cycle a small mode set (manual → accept-low-risk → plan/observe) | Discoverable, one key, no dialog | docs:permission-modes Switch permission modes (2026-09-20) |
| Sessions: `jevcode run --continue` (latest run for this workspace), `--resume <id|name>`, `--name`, `/resume` picker with CC's keys (`↑/↓`, `Enter`, `Space` preview, `/` search, `Ctrl+R` rename, `Ctrl+A` all workspaces, `Esc`) over `~/.jevcode/runs`; rows show task summary, age, steps, stop reason, cost | Reuses the existing checkpoint store; picker conventions already familiar | docs:sessions Use the session picker (2026-09-20); README `--resume` |
| Rewind menu on `Esc Esc`/`/rewind` listing steps with "Restore conversation" (truncate to step N, already possible from checkpoints) and, once a per-step workspace snapshot exists, "Restore code" and "Restore code and conversation"; say explicitly that command-made changes are not tracked until snapshots cover them | CC's exact option set is understood by users; the limitation wording is honest | docs:checkpointing (2026-09-20) |
| Status line: one row, rendered from the `status` event, updated event-driven with a ≥ 300 ms coalesce; hidden while autocomplete/help/confirm are open; expose the same numbers as a JSON `status` payload with CC-like field names (`cost.total_cost_usd`, `cost.total_duration_ms`, `context_window.used_percentage`, `session_id`, `version`) for scripts via `--status-json`/`transcript.log` | CC's schema is a de-facto standard for status scripts (ccstatusline, starship-claude) | docs:statusline How status lines work, Available data (2026-09-20) |
| Notifications: setting `notifChannel` ∈ {`auto`, `iterm2`, `iterm2_with_bell`, `kitty`, `ghostty`, `terminal_bell`, `off`}; fire on a pending review after ~6 s without keystrokes and on run end after ~60 s idle; emit only OSC 9 / OSC 99 / OSC 777 / BEL; set the title with OSC 0 (`--no-title` to disable); document tmux `allow-passthrough on` | Matches CC's channels and timing; the allowlist is CC's own | docs:terminal-config, docs:hooks Notification, binary `terminalSequence` schema (2026-09-20) |
| Spinner shows the stage verb (`intent`, `context`, `propose`, `risk`, `exec`, `judge`, `synth`) plus elapsed time, switches to a "still waiting" phrase after 45 s, and prints a `finished in Nm Ns · $x` line per step; honour `prefersReducedMotion`/`NO_COLOR` | Same affordance as CC's verbs and "Cooked for", but informative | docs:settings-reference spinner*/showTurnDuration; CHANGELOG "deep in thought after 45s" (2026-09-20) |
| Collapse by default with CC's markers: `(ctrl+o to expand)` on long tool output, `… N more rows not shown` on tables, `+N lines`; `Ctrl+O` toggles a verbose transcript that also shows every Jev decision with probability/confidence; cap inline command output shown in the transcript (JevCode already caps at 200 KB + 16 KB tail) | Keeps scrollback readable without losing data | docs:interactive-mode Ctrl+O; docs:troubleshooting Large tables; docs:tools-reference Output limits (2026-09-20) |
| Themes: `--theme auto|dark|light|dark-daltonized|light-daltonized|dark-ansi|light-ansi` (+ `JEVCODE_THEME`), `auto` via OSC 11 background query with a timeout and a dark default; risk/verdict colours defined as named tokens with daltonized variants and always paired with a text label | JevCode's decisions pane is red/yellow/green today; CC ships colourblind variants for exactly this reason | docs:terminal-config Match the color theme; onboarding observed; binary `]11;` (2026-09-20) |
| Keybinding layer with contexts and `namespace:action` names, chords with a 3 s timeout, `null` to unbind, reserved `Ctrl+C`/`Ctrl+D`/`Ctrl+M`/`Ctrl+[`/`Ctrl+I`, validation warnings; file `~/.config/jevcode/keybindings.json` reusing CC's schema shape | Lets JevCode adopt CC defaults now and rebinding later without redesign | docs:keybindings (2026-09-20) |
| `jevcode doctor` (offline, read-only): version, bundle path, Node version, sandbox level, terminal capabilities (sync output reply, kitty query reply, hyperlinks), config sources, warnings with `Fix:` lines | CC's `claude doctor` output is the model; JevCode already has `jevcode config` | `claude doctor` observed 2026-09-20; docs:setup |
| Screen-reader/plain mode: extend `--plain` with CC's label scheme (`you:`, `jev:`, `generator:`, `tool:`, `tool error:`, `error:`, `warning:`, `Review required:`, `Cost:`), no colour-only cues, static spinner text | Cheap, and it doubles as the log format | docs:accessibility (2026-09-20) |
| Synchronized output: wrap each Ink frame in `CSI ? 2026 h … CSI ? 2026 l` only after the terminal answers a DECRQM probe (`CSI ? 2026 $ p`) sent after the first frame; `JEVCODE_FORCE_SYNC_OUTPUT=1` override; never block the first frame on the probe | Eliminates residual tearing in supporting terminals (Ghostty, iTerm2, kitty, WezTerm, VS Code ≥ Dec 2025, tmux master) at zero layout cost | HN chrislloyd 2026-01-21; xterm.js #5453, tmux #4744; docs:env-vars FORCE_SYNC_OUTPUT (2026-09-20) |
| Packaging: keep one ESM bundle + `bin/jevcode.js`; `engines.node >=22.12`, `engine-strict`; publish `latest` and `stable` dist-tags; a `prepare` guard against direct `npm publish`; a CHANGELOG.md with one section per version; signed manifest later | The parts of CC's packaging that work in pure npm | registry JSON `scripts.prepare`, dist-tags (2026-09-20); README |
| Skills-style project commands: `.jevcode/commands/<name>.md` with `description`, `argument-hint`, `$ARGUMENTS`; listed in the `/` menu with a `[Project]` tag; no shell injection by default | Cheap extensibility, safe subset | docs:slash-commands (2026-09-20) |

## REJECT

| What not to do | Why |
| --- | --- |
| Ship a Bun-compiled native binary or per-platform optional dependencies | Violates JevCode's Node 22 / one-package / ink+react-only constraints; measured no first-frame benefit (CC ~340–480 ms onboarding frame vs JevCode 111–127 ms wall) (§1.6) |
| Embed or vendor ripgrep (or re-exec self as `rg`) | Not possible without native code; JevCode's candidate listing already uses cached `git ls-files`/`git status` within the 50 ms harness budget (README) |
| Abandon `<Static>` for a custom differential renderer | CC needed a from-scratch renderer, memoization work and upstream terminal patches to recover from exactly this (HN chrislloyd 2026-01-21); JevCode's zero-clears gate already holds |
| Alternate-screen "fullscreen" mode as the default | Loses native scrollback and search, needs mouse capture and OSC 52 copying, conflicts with `tmux -CC`, needs full-repaint workarounds on ConPTY (docs:fullscreen); JevCode's render-lag gate shows the classic path is enough when the dynamic region is bounded |
| Mouse tracking (`CSI ? 1000/1002/1003/1006 h`) | Breaks copy-on-select and tmux copy mode; CC had to add three env vars and a per-terminal "hold Fn/Option/Shift to select" hint (docs:fullscreen) |
| A user-supplied `statusLine` command spawned on every update | A process spawn per update fights the < 50 ms harness budget and the "rendering never blocks the loop" rule; CC itself caches and cancels in-flight scripts. Offer JSON status output instead |
| LLM-generated session titles, prompt suggestions, session recaps, `/btw` side questions | Each is a background model call ("typically under $0.04 per session") that JevCode's zero-network-at-launch and spend-cap accounting should not absorb; derive titles from the task text |
| Whimsical spinner verbs and tips | Jev's stage names carry information; CC's verbs are branding. Keep `spinnerVerbs`-style override only if it is free |
| Auto-updater, feature-flag fetches, telemetry, PR-status badge checks at launch | Zero network at launch is a JevCode gate; CC needs a dedicated env var (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) to turn these off |
| Full Kitty keyboard protocol (`CSI > 1 u`) and `modifyOtherKeys` | Ink 7.1.1's `useInput` does not decode CSI-u; only recognise the two Shift+Enter encodings and leave the rest to a later research item |
| A risk-free "Yes, and switch to auto mode" or `bypassPermissions` equivalent | JevCode's thresholds are fixed by design (risk ≥ 0.7 blocks, 0.3–0.7 asks); an "auto mode" that removes the ask step would remove the harness's core guarantee |
| Vim mode in v1 | Large surface (CC documents ~70 bindings) for little gain; keep the readline set and `chat:externalEditor` (`Ctrl+G`) instead |
| Emoji shortcodes, spell-check underlines, voice dictation, image paste chips | Not relevant to a code-repair harness; each adds dependencies or model calls |
| Hidden commands and typo-tolerant `Enter` | CC's rule is the right one: after a typo `Enter` submits the text and reports "Unknown command" rather than guessing |

## OPEN QUESTIONS

1. Shift+Enter detection inside Ink 7.1.1: does `useInput` deliver `\x1b\r` as `key.meta && key.return`, and does it pass `\x1b[13;2u`
   through as raw input? Needs a microbenchmark against `node_modules/ink/build/hooks/use-input.js` and `parse-keypress.js` before promising
   "native Shift+Enter" in iTerm2/Ghostty/kitty.
2. Where to hook DEC 2026 wrapping: Ink has no pre/post-frame hook, so the wrap has to happen in a `Writable` proxy handed to
   `render({stdout})`. Does the proxy cost show up in `perf/render-lag.ts` (p95 < 5 ms gate), and does `CSI ? 2026 $ p` ever arrive after
   the first `useInput` read in a way that leaks into the composer?
3. Steering semantics: should a queued human message become a Jev directive at the next intent Choice (one Noul "is this directive
   satisfied?"), or a new task boundary with a replan? CC's rule ("passes it to Claude as soon as those tool calls finish, within the same
   turn") has no Jev analogue; DESIGN.md §6 needs a decision.
4. "Restore code" cost: a per-step workspace snapshot (git stash-like object per step, or `git write-tree` into the run dir) must fit the
   < 50 ms harness budget on the 5,000-file fixture. Measure before promising CC's three-way rewind.
5. Always-allow rules vs Jev: rules skip the human confirm for 0.3–0.7 risk only. Should Jev see that a rule exists (as context) or not?
   And should rules be workspace-scoped like CC (`.claude/settings.local.json` at the git root) or run-scoped?
6. Session identity: `~/.jevcode/runs/<run-id>` is global; CC's picker is per project slug. Add a workspace index (`~/.jevcode/index.json`)
   or scan run.json files at picker time (cost on large `runs/` dirs)?
7. Notification OSC per terminal: CC's docs say iTerm2/Ghostty/Kitty get desktop notifications but the exact sequences are not visible in the
   binary (UNVERIFIED which of OSC 9 / 99 / 777 each channel uses). Verify against the terminals' own docs before implementing `auto`.
8. Height budget with a composer: with rows = 12 the current budget (status 1 + rule 1 + live 2 + decisions ≤ 6) leaves nothing for a
   multi-line prompt and a queue list. Decide the shrink order (decisions first, then live, then queue) and the minimum composer height.
9. Should JevCode expose `--tui plain|classic` now and reserve `fullscreen` for a later research round (only if a concrete flicker report
   survives the zero-clears gate)?
10. Keybindings file location: `~/.config/jevcode/keybindings.json` (XDG, matches the config file default) vs `~/.jevcode/` (matches runs).

## UNVERIFIED / not fetched

- Whether CC's shipped `ink` is upstream Ink or an in-house renderer; only indirect evidence (binary strings, leak write-ups, HN comment about
  removing `<Static>`). The dev.to "claude-code-kit" article is dated 2026-04-01 and is not relied on.
- The exact OSC sequence per notification channel (see Open question 7); functions `notifyITerm2`/`notifyKitty`/`notifyGhostty`/`notifyBell`
  exist but their payloads are not visible as literals.
- Comments by Anthropic staff on issue #769 (GitHub API rate-limited anonymously; `gh` not installed on the reference machine; the WebFetch rendering
  of the issue page showed no comments). The renderer-rewrite quotes come from the HN thread instead.
- That `CLAUDE_CODE_NO_FLICKER` shipped in exactly 2.1.88 (blog claim): the CHANGELOG mentions "`NO_FLICKER` mode" in the 2.1.89–2.1.92 range
  and 2.1.88 has no CHANGELOG section; the registry dates 2.1.88 to 2026-03-30.
- The `#` memory-entry prefix as a current feature: only the theme token description mentions it.
- CC's first-frame number is for the onboarding screen of a fresh profile with nonessential traffic disabled; a signed-in session was not
  measured (would require credentials and network).
