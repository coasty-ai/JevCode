# 03 — Gemini CLI as a reference for JevCode's interactive TUI

Research note for the JevCode chat-style TUI (composer, slash commands, sessions, steering,
review prompts, decisions view). Topic: **Gemini CLI** (`google-gemini/gemini-cli`), the most
relevant open-source Ink-based agent TUI. All notes are from primary sources fetched
**2026-09-20**.

## 0. Provenance and how to read the citations

- Every Gemini CLI source citation below is written `(RAW/<path>, fetched 2026-09-20)` where
  `RAW` = `https://raw.githubusercontent.com/google-gemini/gemini-cli/cfbcaa8df13ea4610bb379b377b56d62980c0032`.
  The same file on the moving branch is `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/<path>`.
  `cfbcaa8` was the head of `main` on 2026-09-18 20:34 UTC per
  `https://api.github.com/repos/google-gemini/gemini-cli/commits?sha=main&per_page=1` (fetched 2026-09-20).
- Package version at that commit: `0.62.0-nightly.20260918.g9450ade79`
  (RAW/packages/cli/package.json, fetched 2026-09-20).
- Ink facts about JevCode's own pinned Ink are from
  `/Users/prateekjannu/Documents/vscode/JevCode/node_modules/ink/build/*` (ink 7.1.1, read 2026-09-20).
  These matter because Gemini CLI does **not** run upstream Ink: its dependency is
  `"ink": "npm:@jrichman/ink@6.6.9"` (RAW/packages/cli/package.json, fetched 2026-09-20), a fork
  that adds `ResizeObserver`, `terminalCursorFocus`, `alternateBuffer`, `terminalBuffer`, `renderProcess`
  — none of which exist in Ink 7.1.1's `build/index.d.ts` / `build/render.d.ts` (read 2026-09-20).
- GitHub issue bodies were read through the web UI (`https://github.com/google-gemini/gemini-cli/issues/<n>`,
  fetched 2026-09-20) because the unauthenticated REST quota was exhausted mid-session
  (`https://api.github.com/rate_limit` returned `remaining: 0`, fetched 2026-09-20).
- Directory listings came from `https://api.github.com/repos/google-gemini/gemini-cli/contents/<path>?ref=cfbcaa8…`
  (fetched 2026-09-20). 260 source/doc files were pulled into `/tmp/gemini-cli-research/src/`.
- Gemini's runtime dependency list is 48 packages (`@google/genai`, `yargs`, `zod`, `fzf`, `string-width`,
  `chalk`, `lowlight`, `highlight.js`, `clipboardy`, `mnemonist`, `ink-spinner`, `ink-gradient`, `simple-git`, …)
  (RAW/packages/cli/package.json, fetched 2026-09-20). JevCode's constraint is **ink 7.1.1 + react 19.3.0 only**,
  so every ADOPT below names the Node built-in that replaces the Gemini dependency.

## 1. Architecture at a glance

- Entry: `packages/cli/src/gemini.tsx` `main()` → `startInteractiveUI()` dynamically imports
  `./interactiveCli.js` "so React/Ink are only parsed when needed" (RAW/packages/cli/src/gemini.tsx, fetched 2026-09-20).
- `interactiveCli.tsx` calls `render(<AppWrapper/>, { stdout, stderr, stdin: process.stdin, exitOnCtrlC: false,
  isScreenReaderEnabled: config.getScreenReader(), onRender: ({ renderTime }) => { if (renderTime > SLOW_RENDER_MS)
  recordSlowRender(...); profiler.reportFrameRendered(); }, standardReactLayoutTiming: …, patchConsole: false,
  alternateBuffer: useAlternateBuffer, terminalBuffer: config.getUseTerminalBuffer(), renderProcess: …,
  incrementalRendering: settings.merged.ui.incrementalRendering !== false && useAlternateBuffer && !isShpool })`
  and, before rendering under shpool, `await new Promise((resolve) => setTimeout(resolve, 100))`
  (RAW/packages/cli/src/interactiveCli.tsx, fetched 2026-09-20). Note `exitOnCtrlC: false` and
  `patchConsole: false` — identical to JevCode's current `render()` in `src/tui/App.tsx`.
- Provider stack (outer → inner): `SettingsContext → KeyMatchersProvider → KeypressProvider → MouseProvider →
  TerminalProvider → ScrollProvider → OverflowProvider → SessionStatsProvider → VimModeProvider → AppContainer`
  (RAW/packages/cli/src/interactiveCli.tsx, fetched 2026-09-20). `AppContainer.tsx` is 2,869 lines and owns all UI
  state; `App.tsx` (38 lines) only picks `QuittingDisplay` vs `ScreenReaderAppLayout` vs `DefaultAppLayout`
  (RAW/packages/cli/src/ui/App.tsx, fetched 2026-09-20).
- `DefaultAppLayout`: `<Box flexDirection="column" width={terminalWidth} height={isAlternateBuffer ? terminalHeight : undefined} ref={rootUiRef}>`
  containing `<MainContent/>` (history), an optional background-task pane, then a `mainControlsRef` column with
  `<Notifications/> <CopyModeWarning/> {customDialog | DialogManager | <Composer/>} <ExitWarning/>`
  (RAW/packages/cli/src/ui/layouts/DefaultAppLayout.tsx, fetched 2026-09-20).
- `Composer` = `QueuedMessageDisplay`, `TodoTray`, `ShortcutsHelp`, `ToastDisplay`, `StatusRow`,
  optional `DetailedMessagesDisplay` (debug console, `maxHeight = floor(max(terminalWidth*0.2, 5))`), `InputPrompt`,
  `Footer` (hidden when `ui.hideFooter` or screen reader) (RAW/packages/cli/src/ui/components/Composer.tsx, fetched 2026-09-20).
  Suggestions render `'above'` the prompt in alternate-buffer mode, `'below'` otherwise
  (`const suggestionsPosition = isAlternateBuffer ? 'above' : 'below'`, same file).
- Two rendering modes coexist: classic `<Static>` scrollback (the default; `ui.useAlternateBuffer` default `false`,
  `ui.terminalBuffer` default `false`, both `requiresRestart: true`) and a fork-only virtualized list
  (RAW/packages/cli/src/config/settingsSchema.ts, fetched 2026-09-20).

## 2. Keypress handling (`contexts/KeypressContext.tsx`, `utils/terminalCapabilityManager.ts`)

### 2.1 Capability probe at startup
- `TerminalCapabilityManager.detectCapabilities()` runs once, only when `stdin.isTTY && stdout.isTTY`, sets raw mode,
  and writes **one** batch: `HIDDEN_MODE ('\x1b[8m') + KITTY_QUERY ('\x1b[?u') + OSC_11_QUERY ('\x1b]11;?\x1b\\') +
  TERMINAL_NAME_QUERY ('\x1b[>q') + MODIFY_OTHER_KEYS_QUERY ('\x1b[>4;?m') + DEVICE_ATTRIBUTES_QUERY ('\x1b[c') +
  CLEAR_LINE_AND_RETURN ('\x1b[2K\r') + RESET_ATTRIBUTES ('\x1b[0m')`. Comment: "Use hidden mode to prevent potential
  'm' character from being printed to the terminal during startup". The Primary Device Attributes reply is the
  sentinel ("Since we send it last, receiving it means we can stop waiting"); hard timeout `setTimeout(cleanup, 1000)`
  (RAW/packages/cli/src/ui/utils/terminalCapabilityManager.ts, fetched 2026-09-20).
- Responses parsed: `KITTY_REGEX = /\x1b\[\?(\d+)u/`, `OSC_11_REGEX = /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/…/`,
  `TERMINAL_NAME_REGEX = /\x1bP>\|(.+?)(\x1b\\|\x07)/`, `MODIFY_OTHER_KEYS_REGEX = /\x1b\[>4;(\d+)m/` with
  `modifyOtherKeysSupported = level >= 2` (same file). tmux heuristic: "tmux 3.5+ may report #ffffff when it doesn't
  know the actual host terminal color (e.g. over mosh). We ignore this specific fallback value" (same file).
- `enableSupportedModes()`: kitty if supported (`'\x1b[>1u'`), else modifyOtherKeys (`'\x1b[>4;2m'`); "Always enable
  bracketed paste since it'll be ignored if unsupported." (`'\x1b[?2004h'`) (same file;
  sequences from RAW/packages/core/src/utils/terminal.ts, fetched 2026-09-20).
- Exit restores everything with one synchronous write:
  `TERMINAL_CLEANUP_SEQUENCE = '\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'` via
  `fs.writeSync(process.stdout.fd, …)`, registered on `process.on('exit'|'SIGTERM'|'SIGINT')` (same file).
- Terminal identification helpers: `isTmux` (`TMUX`), `isScreen` (`STY`), `isITerm2`, `isAlacritty`, `isAppleTerminal`,
  `isVSCodeTerminal` (`TERM_PROGRAM`), `isWindowsTerminal` (`WT_SESSION`), `isGhosttyTerminal` (same file).

### 2.2 The parser
- `KeypressProvider` replaces Ink's `useInput`: it reads `stdin.on('data')` itself after `setRawMode(true)` and
  `process.stdin.setEncoding('utf8')`, feeding a generator `emitKeys()` primed with `parser.next()`. Constants:
  `BACKSLASH_ENTER_TIMEOUT = 5; ESC_TIMEOUT = 50; PASTE_TIMEOUT = 30_000; FAST_RETURN_TIMEOUT = 30`
  (RAW/packages/cli/src/ui/contexts/KeypressContext.tsx, fetched 2026-09-20).
- Escape sequence buffering: after any chunk, `timeoutId = setTimeout(() => parser.next(''), ESC_TIMEOUT)`; an empty
  string means "timeout", which turns a lone `ESC` into `{name:'escape'}` and an `ESC x` pair into `alt+x` (same file).
- Table-driven legacy keys (`KEY_INFO_MAP`): `'[200~': paste-start`, `'[201~': paste-end`, rxvt `[a/[b/[c/[d` = shift
  arrows, `Oa..Od` = ctrl arrows, `[Z` and `OZ` = shift+tab ("SS3 Shift+Tab variant for Windows terminals"), F1–F20
  in three encodings (same file).
- Kitty CSI-u: `/^(\d+)(?:;(\d+))?(?:;(\d+))?([~^$u])$/`; xterm `modifyOtherKeys` is normalised: "modifyOtherKeys
  format: CSI 27 ; modifier ; key ~ — Treat as CSI u: key + 'u'". Modifier bits: `shift = !!(modifier & 1); alt =
  !!(modifier & 2); ctrl = !!(modifier & 4); cmd = !!(modifier & 8)`. `KITTY_CODE_MAP` covers 57358–57416 PUA keys and
  numpad 57399–57408; any code point 33..0x10FFFF outside surrogates becomes an insertable char (same file).
- OSC handling: reads `ESC ] … BEL | ESC \`; only OSC 52 (`/^52;[cp];(.*)$/`) is used — base64 clipboard replies are
  emitted as a `paste` key (same file). Mouse: SGR (`ESC [ <`) and X11 (`ESC [ M` + 3 bytes) are parsed to completion
  then dropped by `nonKeyboardEventFilter` together with `FOCUS_IN`/`FOCUS_OUT` (same file).
- Paste: `bufferPaste()` accumulates between `paste-start`/`paste-end` into one `{name:'paste', insertable:true,
  sequence}`; `PASTE_TIMEOUT` (30 s) emits `AppEvent.PasteTimeout` and flushes (same file).
- Two heuristics for terminals **without** kitty/bracketed paste: `bufferFastReturn` — "Converts return keys pressed
  quickly after insertable keys into a shift+return … to accommodate older terminals that paste text without
  bracketing" (30 ms window, installed only `if (!terminalCapabilityManager.isKittyProtocolEnabled())`); and
  `bufferBackslashEnter` — a `\` followed within 5 ms by Enter becomes shift+enter (newline) (same file).
- macOS Option-key fallback: `MAC_ALT_KEY_CHARACTER_MAP = { '∫':'b', 'ƒ':'f', 'µ':'m', 'Ω':'z', '¸':'Z', '∂':'d' }`
  with a Greek-locale exception so `Ω` stays typeable when `LANG` starts with `el` (same file).
- Double ESC (`ESC ESC`) emits two `escape` keys (same file). Ctrl+letter: `!escaped && ch <= '\x1a'` →
  `name = String.fromCharCode(code + 'a' - 1), ctrl = true` (same file).
- Dispatch: subscribers are stored in a `MultiMap<number, KeypressHandler>` by `KeypressPriority { Low = -100,
  Normal = 0, High = 100, Critical = 200 }`; "Within a priority level, use stack behavior (last subscribed is first to
  handle)"; a handler returning `true` stops propagation (same file). `useKeypress(handler, { isActive, priority })`
  is a 44-line subscribe/unsubscribe effect (RAW/packages/cli/src/ui/hooks/useKeypress.ts, fetched 2026-09-20).
- Debug: `general.debugKeystrokeLogging` logs `[DEBUG] Keystroke: {json}` and `[DEBUG] Raw StdIn:` — i.e. keys **can**
  reach logs when the user opts in (KeypressContext.tsx; setting in RAW/packages/cli/src/config/settingsSchema.ts,
  fetched 2026-09-20). JevCode's rule is "keys never appear in logs", so this is a REJECT.

### 2.3 Key bindings as data
- `enum Command` has 79 members with VS-Code-style ids: `RETURN='basic.confirm'`, `ESCAPE='basic.cancel'`,
  `QUIT='basic.quit'`, `EXIT='basic.exit'`, `HOME='cursor.home'`, `KILL_LINE_RIGHT='edit.deleteRightAll'`,
  `KILL_LINE_LEFT='edit.deleteLeftAll'`, `CLEAR_INPUT='edit.clear'`, `UNDO='edit.undo'`, `REVERSE_SEARCH=
  'history.search.start'`, `ACCEPT_SUGGESTION='suggest.accept'`, `SUBMIT='input.submit'`, `QUEUE_MESSAGE=
  'input.queueMessage'`, `NEWLINE='input.newline'`, `OPEN_EXTERNAL_EDITOR='input.openExternalEditor'`,
  `TOGGLE_YOLO='app.toggleYolo'`, `CYCLE_APPROVAL_MODE='app.cycleApprovalMode'`, `SHOW_MORE_LINES='app.showMoreLines'`,
  `CLEAR_SCREEN='app.clearScreen'`, `SUSPEND_APP='app.suspend'`, `DUMP_FRAME='app.dumpFrame'`
  (RAW/packages/cli/src/ui/key/keyBindings.ts, fetched 2026-09-20).
- Defaults (`defaultKeyBindingConfig`, same file): QUIT `ctrl+c`; EXIT `ctrl+d`; ESCAPE `escape`, `ctrl+[`; HOME
  `ctrl+a`,`home`; END `ctrl+e`,`end`; MOVE_RIGHT `right`,`ctrl+f`; MOVE_WORD_LEFT `ctrl+left`,`alt+left`,`alt+b`;
  MOVE_WORD_RIGHT `ctrl+right`,`alt+right`,`alt+f`; KILL_LINE_RIGHT `ctrl+k`; KILL_LINE_LEFT `ctrl+u`; CLEAR_INPUT
  `ctrl+c`; DELETE_WORD_BACKWARD `ctrl+backspace`,`alt+backspace`,`ctrl+w`; DELETE_WORD_FORWARD `ctrl+delete`,
  `alt+delete`,`alt+d`; DELETE_CHAR_RIGHT `delete`,`ctrl+d`; HISTORY_UP/DOWN `ctrl+p`/`ctrl+n`; REVERSE_SEARCH `ctrl+r`;
  DIALOG_NAVIGATION_UP/DOWN `up`,`k` / `down`,`j`; ACCEPT_SUGGESTION `tab`,`enter`; NEWLINE `ctrl+enter`,`cmd+enter`,
  `alt+enter`,`shift+enter`,`ctrl+j`; OPEN_EXTERNAL_EDITOR `ctrl+g`,`ctrl+shift+g` (old `ctrl+x` is
  `DEPRECATED_OPEN_EXTERNAL_EDITOR` and only prints a hint); PASTE_CLIPBOARD `ctrl+v`,`cmd+v`,`alt+v`; SHOW_ERROR_DETAILS
  `f12`; TOGGLE_MARKDOWN `alt+m`; TOGGLE_YOLO `ctrl+y`; CYCLE_APPROVAL_MODE `shift+tab`; SHOW_MORE_LINES `ctrl+o`;
  CLEAR_SCREEN `ctrl+l`; SUSPEND_APP `ctrl+z`; SCROLL_UP/DOWN `shift+up`/`shift+down`; PAGE_UP/DOWN `pageup`/`pagedown`.
- Undo/redo are platform-specific: `getPlatformUndoBindings` → win32 `ctrl+z, alt+z`; darwin `cmd+z, alt+z`;
  Linux/WSL `alt+z, cmd+z, ctrl+z` ("Promote Alt+Z to avoid Windows interception, but keep Ctrl+Z for smart bubbling");
  redo is `ctrl+shift+z, cmd+shift+z, alt+shift+z` everywhere (same file). Note the intentional conflicts: `ctrl+c` is
  both QUIT and CLEAR_INPUT, `ctrl+d` both EXIT and DELETE_CHAR_RIGHT, `ctrl+z` both UNDO (Linux) and SUSPEND — resolved
  by handler order, not by the table.
- User overrides live in `~/.gemini/keybindings.json`, a JSON array like VS Code's: `{"command":"edit.clear","key":
  "cmd+l"}`, unbind with `"command":"-app.toggleYolo"`; "Key matching is explicit … a binding for `ctrl+f` will only
  trigger on exactly `ctrl+f`"; literal characters such as `"Å"` are accepted because "Terminals often translate
  complex key combinations (especially on macOS with the Option key) into special characters"
  (RAW/docs/reference/keyboard-shortcuts.md, fetched 2026-09-20). The reference table in that doc is generated from the
  enum (`<!-- KEYBINDINGS-AUTOGEN:START -->`, `npm run docs:keybindings` in RAW/package.json, fetched 2026-09-20).

### 2.4 What Ink 7.1.1 already gives JevCode (verified in node_modules, 2026-09-20)
- `render()` options include `kittyKeyboard?: { mode?: 'auto'|'enabled'|'disabled'; flags?: KittyFlagName[] }`
  ("Protocol is opt-in: if kittyKeyboard is not specified, do nothing"; auto mode "query the terminal for kitty keyboard
  protocol support"), `isScreenReaderEnabled` (default `process.env['INK_SCREEN_READER'] === 'true'`), `maxFps`
  (default 30; `renderThrottleMs = Math.max(1, Math.ceil(1000 / maxFps))`), `incrementalRendering` ("only updates changed
  lines"), `concurrent`, `interactive`, `alternateScreen` (`build/render.d.ts`, `build/ink.js`).
- `usePaste(handler, { isActive })`: "Bracketed paste mode (`\x1b[?2004h`) is automatically enabled while the hook is
  active … `usePaste` and `useInput` can be used together … paste content is never forwarded to `useInput` handlers when
  `usePaste` is active" (`build/hooks/use-paste.d.ts`); `App.js` writes `\u001B[?2004h/l` itself and, with no paste
  listener, delivers the paste to `useInput` as one string (`build/components/App.js` lines 186–192).
- `useInput`'s `Key` already has `meta`, `super`, `hyper` ("Only available with kitty keyboard protocol"), `home`, `end`,
  `pageUp`, `pageDown`, `delete` (`build/hooks/use-input.d.ts`). `useCursor().setCursorPosition({x,y}|undefined)` puts the
  **real** terminal cursor at a position "relative to the Ink output origin … useful for IME" (`build/hooks/use-cursor.d.ts`).
  `useWindowSize()`, `useBoxMetrics()`, `measureElement()`, `useIsScreenReaderEnabled()`, `useAnimation()` are exported
  (`build/index.d.ts`). Gemini's fork substitutes `ResizeObserver` and a `terminalCursorFocus` Text prop for these.

## 3. The text buffer (`components/shared/text-buffer.ts`, 4,285 lines)

- Model: `TextBufferState { lines: string[]; cursorRow; cursorCol; preferredCol; undoStack; redoStack; clipboard;
  selectionAnchor; viewportWidth; viewportHeight; visualLayout; pastedContent: Record<string,string>; expandedPaste;
  yankRegister }` — logical lines + a derived visual layout; `cursorCol` is a **code-point** index, all slicing goes
  through `cpLen`/`cpSlice` (RAW/packages/cli/src/ui/components/shared/text-buffer.ts, fetched 2026-09-20).
- Pure reducer `textBufferReducerLogic(state, action, options)` with actions `insert | set_text | add_pasted_content |
  backspace | move | set_cursor | delete | delete_word_left | delete_word_right | kill_line_right | kill_line_left |
  undo | redo | replace_range | move_to_offset | create_undo_snapshot | set_viewport | toggle_paste_expansion` plus ~60
  `vim_*` actions handled by `vim-buffer-actions.ts` (same file). `useTextBuffer()` wraps it in `useReducer` and exposes
  a `TextBuffer` interface (`setText, insert, newline, backspace, del, move, undo, redo, replaceRange, deleteWordLeft,
  deleteWordRight, killLineRight, killLineLeft, handleInput, openInExternalEditor, replaceRangeByOffset, getOffset,
  moveToOffset, moveToVisualPosition, …`) (same file).
- Undo: snapshot-per-edit (`pushUndo` copies `lines`, cursor, `pastedContent`, `expandedPaste`), `historyLimit = 100`,
  redo stack cleared on every new edit (same file). `set_text` accepts `pushToUndo?: boolean` so external-editor
  round-trips do not create a second snapshot.
- **No kill ring**: `kill_line_right`/`kill_line_left` just slice the line (and `kill_line_right` at EOL joins the next
  line, "Act as a delete"); the discarded text is not stored — `clipboard` and `yankRegister` are only used by vim
  actions (same file). Ctrl+Y is `TOGGLE_YOLO`, not yank (keyBindings.ts).
- Word movement uses ICU: `for (const seg of segmenter.segment(line)) … if (seg.isWordLike) targetIdx = seg.index`
  (`findPrevWordBoundary`/`findNextWordBoundary`, same file) plus script-aware helpers (`getCharScript`,
  `isDifferentScript`, `isCombiningMark = /\p{M}/u`) and vim "big word" variants.
- Wide characters: `textUtils.ts` — `toCodePoints()` with an ASCII fast path and an LRU cache
  (`LRU_BUFFER_PERF_CACHE_LIMIT = 20000`), `getCachedStringWidth()` wraps `string-width` in `try/catch` with
  "Fallback for characters that cause string-width to crash (e.g. U+0602) See: …/issues/16418"; `stripUnsafeCharacters()`
  strips ANSI, C0/C1 and bidi controls (`/[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F‎‏‪-‮⁦-⁩​﻿]/g`)
  then `node:util` `stripVTControlCharacters` (RAW/packages/cli/src/ui/utils/textUtils.ts, fetched 2026-09-20).
  Visual layout is memoised per logical line (`getLineLayoutCacheKey(line, viewportWidth, isCursorOnLine, cursorCol)`,
  `lineLayoutCache` LRU) (text-buffer.ts).
- Large pastes become placeholders: `LARGE_PASTE_LINE_THRESHOLD = 5; LARGE_PASTE_CHAR_THRESHOLD = 500`; id text
  `[Pasted Text: N lines]` / `[Pasted Text: N chars]` (with ` #2` suffixes); `expandPastePlaceholders()` re-inlines them
  at submit; Ctrl+O over a placeholder toggles expansion (`EXPAND_PASTE`) (same file; InputPrompt.tsx). Paste input is
  normalised `payload.replace(/\r\n|\r/g, '\n')`; `singleLine` buffers strip newlines; an `inputFilter` hook exists.
- Drag-and-drop paths: `escapePastedPaths` → `parsePastedPaths(ch.trim())` escapes spaces in dropped file paths
  (text-buffer.ts lines 2959–2980; RAW/packages/cli/src/ui/utils/clipboardUtils.ts, fetched 2026-09-20).
- External editor: `fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-edit-'))` + `buffer.txt`, dispatch
  `create_undo_snapshot`, `await openFileInEditor(filePath, stdin, setRawMode, preferredEditor, openEditorInNewWindow)`,
  read back with `\r\n?` → `\n`, re-collapse unchanged pasted blocks into their placeholders, `set_text … pushToUndo:
  false`, unlink + rmdir in `finally` (text-buffer.ts). Ink 7.1.1 exposes `SuspendTerminal`/`TerminalSuspension` types
  from `AppContext` for exactly this hand-over (`build/index.d.ts`).
- `handleInput(key)` order (same file): paste → RETURN/NEWLINE (newline unless `singleLine`) → MOVE_LEFT/RIGHT/UP/DOWN
  (return `false` at buffer edges so the caller can run history navigation) → word moves → HOME/END → CLEAR_INPUT
  (`ctrl+c`, only if text non-empty, else `false` so QUIT sees it) → word deletes → backspace/delete → UNDO/REDO (only
  if stacks non-empty) → `key.insertable` insert → `false`.
- Microbenchmark (Node v22.23.2, Apple Silicon, `/tmp/jevcode-tui-bench/bench.mjs`, run 2026-09-20): `Intl.Segmenter`
  previous-word on a 500-char line 32 µs (ASCII) / 46 µs (CJK+emoji); regex fallback 8.5 µs / 9.4 µs; `Array.from()`
  code points of a 10k-char line 24 µs / 28 µs; ASCII scan fast path 11 µs; `util.stripVTControlCharacters` on 10k chars
  2.3 µs (4.7 µs with 200 escapes); naive wrap of 10k ASCII into 100 columns 1.1 µs. All are far below one 50 ms
  frame, so a JevCode buffer built on built-ins does not need Gemini's LRU caches for prompts under ~10k chars.

## 4. The composer (`components/InputPrompt.tsx`, 1,933 lines)

- Widths: `calculatePromptWidths(mainContentWidth)` → `FRAME_PADDING_AND_BORDER = 4`, `PROMPT_PREFIX_WIDTH = 2` ("'> '
  or '! '"), `inputWidth = max(mainContentWidth - 6, 1)`, `suggestionsWidth = max(20, mainContentWidth)`
  (RAW/packages/cli/src/ui/components/InputPrompt.tsx, fetched 2026-09-20).
- Prefix glyph and status: `'!'` in shell mode (`'(r:) '` during reverse search), `'*'` in YOLO, else `'>'`; status text
  `'Shell mode' | 'YOLO mode' | 'Plan mode' | 'Accepting edits'` coloured `theme.ui.symbol | status.error |
  status.success | status.warning`; border colour = that status colour or `theme.ui.focus` when focused, `border.default`
  otherwise (same file). Placeholder `'  Type your message or @path/to/file'`; vim placeholders `"  Press 'Esc' for NORMAL
  mode."` / `"  Press 'i' for INSERT mode."` (Composer.tsx).
- Under `NO_COLOR` or `ui.useBackgroundColor=false` the input is framed by two `height={0}` round-border boxes
  (`borderTop` only / `borderBottom` only) instead of a background tint: `const useLineFallback = !!process.env['NO_COLOR']`
  (InputPrompt.tsx). Cursor: `chalk.inverse(char)` plus the fork-only `terminalCursorFocus`/`terminalCursorPosition`
  Text props (same file) — in Ink 7.1.1 use `useCursor()` instead.
- Escape: `useRepeatedKeyPress({ windowMs: 500 })`; first press shows an "escape prompt", second press within 500 ms
  clears the buffer if non-empty, else submits `'/rewind'` if there is history, else emits `'Nothing to rewind to'`
  (same file). During generation Escape is **not** consumed here (`if (isGenerating) return false`) so the global
  cancel handler in `useGeminiStream` gets it: `if (key.name === 'escape' && !isShellFocused) { cancelOngoingRequest(false);
  return true; }` active only while `Responding | WaitingForConfirmation`
  (RAW/packages/cli/src/ui/hooks/useGeminiStream.ts, fetched 2026-09-20).
- Submit: `SUBMIT` (Enter) when `buffer.text.trim()`; if the char before the cursor is `\` → `buffer.backspace();
  buffer.newline()` (typed line-continuation); if an "unsafe" paste happened within 40 ms → `buffer.newline()` instead
  of submitting (comment: "40ms is chosen arbitrarily as it is faster than a typical human could go from pressing paste
  to pressing enter"). `isTerminalPasteTrusted(kittyProtocolSupported)` returns `kittyProtocolSupported` because Cursor on
  Windows mis-reports bracketed paste (issue 3763 cited in code) (InputPrompt.tsx).
- History navigation: Up/Down act as history only when the cursor is on the first/last **visual** line (or the buffer
  is a single visual line); otherwise Up on a non-zero column first goes `home`. `useInputHistory` caches text+cursor per
  history level and restores the cursor when returning to a level ("Level -1 is the current unsubmitted prompt")
  (InputPrompt.tsx; RAW/packages/cli/src/ui/hooks/useInputHistory.ts, fetched 2026-09-20). Ctrl+P/Ctrl+N always navigate.
- Steering while busy: `QUEUE_MESSAGE` (Tab) while `Responding|WaitingForConfirmation` pushes the text to a queue;
  `useMessageQueue` submits the joined queue (`messageQueue.join('\n\n')`) as soon as `streamingState === Idle`; slash
  and shell commands are refused with `'Shell commands cannot be queued'` / `'Slash commands cannot be queued'` unless
  the slash command is `isSafeConcurrent` (InputPrompt.tsx; RAW/packages/cli/src/ui/hooks/useMessageQueue.ts,
  fetched 2026-09-20). Up on an empty prompt pops all queued messages back into the editor (`tryLoadQueuedMessages`).
- `?` on an empty buffer opens `ShortcutsHelp`; double plain Tab within `DOUBLE_TAB_CLEAN_UI_TOGGLE_WINDOW_MS = 350`
  toggles "clean UI" details; `CLEAR_SCREEN` (Ctrl+L) hides the banner and calls `onClearScreen` (InputPrompt.tsx).
- Clipboard: `PASTE_CLIPBOARD` reads `clipboardy` (or writes `'\x1b]52;c;?\x07'` when `experimental.useOSC52Paste`),
  and if the clipboard holds an image it saves it and inserts `@relative/path` (same file). Right-click release also
  pastes; left click moves the cursor via `moveToVisualPosition`; double-click toggles a paste placeholder (same file).
- Keypress subscription: `useKeypress(handleInput, { isActive: !isEmbeddedShellFocused && !copyModeEnabled, priority:
  true })` — high priority so dialogs/global handlers registered later at the same level are below it (same file).

## 5. Completion: slash commands and `@` paths

- `useCommandCompletion` derives `CompletionMode { IDLE, AT, SLASH, PROMPT, SHELL }` from the buffer and multiplexes
  `useSlashCompletion`, `useAtCompletion`, shell completion and "prompt completion" (ghost text)
  (RAW/packages/cli/src/ui/hooks/useCommandCompletion.tsx, fetched 2026-09-20).
- Slash: commands are a tree (`SlashCommand { name, altNames?, description, hidden?, kind, action?, completion?,
  subCommands?, autoExecute? }`); the hook resolves `leafCommand`, `isArgumentCompletion`, and `isPerfectMatch`
  (`leafCommand && partial === '' && leafCommand.action`). Matching uses `AsyncFzf` over command names with a prefix
  fallback "when fzf instance creation fails"; ordering prefers exact name, then exact altName, then name prefix, then
  altName prefix; commands without `description` or with `hidden` are excluded. Sub-commands of `chat`/`resume` get
  `sectionTitle` groups (RAW/packages/cli/src/ui/hooks/useSlashCompletion.ts, fetched 2026-09-20; RAW/docs/cli/
  session-management.md describes the `-- auto --` / `-- checkpoints --` separators, fetched 2026-09-20).
- Enter on a suggestion: if `suggestion.submitValue` → submit it; if argument completion on an `isAutoExecutableCommand`
  → submit the completed text; if command-name completion and the command has no `completion` function → submit;
  otherwise insert into the prompt ("Default behavior: auto-complete to prompt box") (InputPrompt.tsx).
- `@` paths: a reducer with `status: idle|initializing|ready|searching|error`; `FileSearchFactory` (gitignore-aware,
  `cache: true, cacheTtl: 30`) feeds `AsyncFzf` with `limit: MAX_SUGGESTIONS_TO_SHOW * 3`; each search has an
  `AbortController`, a "slow search" timer and `DEFAULT_SEARCH_TIMEOUT_MS = 5000`
  (RAW/packages/cli/src/ui/hooks/useAtCompletion.ts, fetched 2026-09-20).
- `SuggestionsDisplay`: `MAX_SUGGESTIONS_TO_SHOW = 8`; `▲` above when `scrollOffset > 0`, `▼` below when more, then
  `(activeIndex+1/total)`; in `'slash'` mode the label column is `min(maxLabelLength, floor(width*0.5))`; descriptions
  are `sanitizeForDisplay(description, 100)` with `wrap="truncate"`; long values show ` → `/` ← ` and expand with
  Right/Left (`EXPAND_SUGGESTION`/`COLLAPSE_SUGGESTION`); `'Loading suggestions...'` while loading; section headers
  render `-- {sectionTitle} --`; kinds add ` [MCP]` / ` [Agent]` suffixes
  (RAW/packages/cli/src/ui/components/SuggestionsDisplay.tsx, fetched 2026-09-20).
- Reverse search: Ctrl+R (`REVERSE_SEARCH`) over shell history in shell mode or over prior prompts otherwise; Esc
  restores the pre-search text and cursor; Tab accepts, Enter submits the highlighted match (InputPrompt.tsx).

## 6. Shell mode (`!`)

- Typing `!` into an **empty** buffer toggles shell mode and clears the `!`: `if (key.sequence === '!' && buffer.text ===
  '' && !(completion.showSuggestions && isShellSuggestionsVisible)) { setShellModeActive(!shellModeActive); buffer.setText('');
  … }`; Esc leaves shell mode; placeholder becomes `'  Type your shell command'` (InputPrompt.tsx; Composer.tsx).
- Shell history is a separate file capped at `MAX_HISTORY_LENGTH = 100` lines (RAW/packages/cli/src/ui/hooks/
  useShellHistory.ts, fetched 2026-09-20); Up/Down in shell mode walk it. Shell completions come from provider modules
  (`hooks/shell-completions/{gitProvider,npmProvider}.ts`, listing fetched 2026-09-20).
- Interactive shells can be focused with Tab (`FOCUS_SHELL_INPUT`) when a PTY is active; the loading row then shows
  `'! Shell awaiting input (Tab to focus)'` (`INTERACTIVE_SHELL_WAITING_PHRASE`, RAW/packages/cli/src/ui/hooks/
  usePhraseCycler.ts, fetched 2026-09-20). Not applicable to JevCode's non-PTY sandbox.

## 7. Footer and status row

- Footer items are user-orderable ids: `workspace`, `git-branch`, `sandbox`, `model-name`, `context-used`, `quota`,
  `memory-usage`, `session-id`, `hostname`, `auth`, `code-changes`, `token-count`, plus a `ConsoleSummaryDisplay`
  error count shown when `errorCount > 0 && (isFullErrorVerbosity || debugMode || isDevelopment)`
  (RAW/packages/cli/src/ui/components/Footer.tsx, fetched 2026-09-20; ids in RAW/packages/cli/src/config/footerItems.ts).
- Sandbox indicator strings: `'untrusted'` (warning colour) when the folder is untrusted, `process.env['SANDBOX']` name
  when running inside one, `'current process'`, else `'no sandbox'` in `theme.status.error` (Footer.tsx).
- Context usage: `percentageUsed = (percentage*100).toFixed(0)`, colour `status.error` at ≥100 %, `status.warning` at
  ≥ `model.compressionThreshold` (default `DEFAULT_COMPRESSION_THRESHOLD = 0.5`), label `'%'` below
  `MIN_TERMINAL_WIDTH_FOR_FULL_LABEL = 100` columns else `'% used'`
  (RAW/packages/cli/src/ui/components/ContextUsageDisplay.tsx and constants.ts, fetched 2026-09-20).
- Git branch: `git rev-parse --abbrev-ref HEAD` (falls back to `--short HEAD` when detached), then `fs.watch(gitDir)`
  refreshes on `HEAD` changes with a 100 ms debounce (RAW/packages/cli/src/ui/hooks/useGitBranchName.ts, fetched
  2026-09-20). JevCode already has a scrubbed-env git helper; reuse it rather than spawning bare `git`.
- `StatusRow` hosts the `LoadingIndicator`, `ContextUsageDisplay`, `ApprovalModeIndicator`, `ShellModeIndicator`,
  `RawMarkdownIndicator`, with a `COLLISION_GAP: 10` layout constant and a fork `ResizeObserver` to measure width
  (RAW/packages/cli/src/ui/components/StatusRow.tsx, fetched 2026-09-20).
- Window title: `stdout.write(`\x1b]0;${paddedTitle}\x07`)` only when the title changed, gated by
  `ui.hideWindowTitle`/`ui.showStatusInTitle`/`ui.dynamicWindowTitle` (RAW/packages/cli/src/ui/AppContainer.tsx,
  fetched 2026-09-20).

## 8. Theme system (`ui/themes/*`, `ui/semantic-colors.ts`)

- Raw palette `ColorsTheme { type: 'light'|'dark'|'ansi'|'custom'; Background; Foreground; LightBlue; AccentBlue;
  AccentPurple; AccentCyan; AccentGreen; AccentYellow; AccentRed; DiffAdded; DiffRemoved; Comment; Gray; DarkGray;
  InputBackground?; MessageBackground?; FocusBackground?; FocusColor?; GradientColors? }`
  (RAW/packages/cli/src/ui/themes/theme.ts, fetched 2026-09-20).
- Semantic layer `SemanticColors { text: { primary, secondary, link, accent, response }; background: { primary, message,
  input, focus, diff: { added, removed } }; border: { default }; ui: { comment, symbol, active, dark, focus, gradient };
  status: { error, success, warning } }` (RAW/packages/cli/src/ui/themes/semantic-tokens.ts, fetched 2026-09-20).
  Components import a **getter proxy** so theme changes need no re-render plumbing: `export const theme: SemanticColors =
  { get text() { return themeManager.getSemanticColors().text; } … }` (RAW/packages/cli/src/ui/semantic-colors.ts).
- `NO_COLOR`: `getActiveTheme() { if (process.env['NO_COLOR']) { return NoColorTheme; } … }` where every colour is the
  empty string and only `hljs-link` keeps `textDecoration: 'underline'` (RAW/packages/cli/src/ui/themes/theme-manager.ts
  and themes/builtin/no-color.ts, fetched 2026-09-20). Ink renders `color=""` as no SGR, so the same components run.
- Light/dark: the OSC 11 reply is parsed to hex and `getThemeTypeFromBackgroundColor()` returns `'light'` when
  `getLuminance(color) > 128`; `pickDefaultThemeName()` prefers a built-in theme whose `Background` equals the terminal
  background exactly, else DefaultLight/DefaultDark (theme.ts). `isThemeCompatible()` blends `Background`, `DarkGray`,
  `InputBackground`, `MessageBackground`, `FocusBackground` toward the real terminal background with
  `DEFAULT_BACKGROUND_OPACITY = 0.16`, `DEFAULT_INPUT_BACKGROUND_OPACITY = 0.24`, `DEFAULT_SELECTION_OPACITY = 0.2`,
  `DEFAULT_BORDER_OPACITY = 0.4` (theme-manager.ts; constants.ts). `useTerminalTheme` polls OSC 11 every
  `ui.terminalBackgroundPollingInterval` seconds when `ui.autoThemeSwitching` and switches Default themes on luminance
  change, calling `refreshStatic()` so already-committed history is re-tinted (RAW/packages/cli/src/ui/hooks/
  useTerminalTheme.ts, fetched 2026-09-20). Issue #19040 "Flicker each time we query for the background color"
  (2026-02-13, closed) shows the polling itself caused flicker until an equality guard was added (#19174)
  (https://github.com/google-gemini/gemini-cli/issues/19040, fetched 2026-09-20).
- Built-ins: dark `ansi-dark, atom-one-dark, ayu-dark, default-dark, dracula-dark, github-dark(-colorblind), holiday-dark,
  shades-of-purple-dark, solarized-dark, tokyonight-dark`; light `ansi-light, ayu-light, default-light,
  github-light(-colorblind), googlecode-light, solarized-light, xcode-light` (directory listing fetched 2026-09-20).
  `DEFAULT_THEME = DefaultDark` (theme-manager.ts). Custom themes go in `settings.json` `ui.customThemes` with
  `"type": "custom"` and hex or CSS colour names; a theme can also be a `.json` file path (RAW/docs/cli/themes.md,
  fetched 2026-09-20). Syntax colours are a `hljs-*` → colour map on each `Theme` (`theme.getInkColor('hljs-keyword')`).

## 9. `<Static>`, overflow, and the flicker history

- Classic mode renders `<Static key={uiState.historyRemountKey} items={[<AppHeader/>, ...staticHistoryItems,
  ...lastResponseHistoryItems]}>{(item) => item}</Static>` followed by `pendingItems` (the in-flight turn)
  (RAW/packages/cli/src/ui/components/MainContent.tsx, fetched 2026-09-20). Items after the last user prompt are
  `isExpandable`; height caps: `availableTerminalHeight = uiState.constrainHeight || !isExpandable ?
  staticAreaMaxItemHeight : undefined` with `staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100)` and
  `MAX_GEMINI_MESSAGE_LINES = 65536` "to mitigate performance issues in the worst case" (MainContent.tsx;
  AppContainer.tsx; constants.ts).
- The dynamic budget: `availableTerminalHeight = Math.max(0, terminalHeight - stableControlsHeight -
  backgroundTaskHeight - 1)`, where `stableControlsHeight` is measured from `mainControlsRef` with the fork's
  `ResizeObserver` (AppContainer.tsx). `useTerminalSize()` falls back to `columns || 60`, `rows || 20`
  (RAW/packages/cli/src/ui/hooks/useTerminalSize.ts, fetched 2026-09-20) — Ink 7.1.1's `useWindowSize()` is the
  built-in equivalent.
- `MaxSizedBox`: measures its child with `ResizeObserver`, `MINIMUM_MAX_HEIGHT = 2`, reserves one row for the notice
  `... first N lines hidden (Ctrl+O to show) ...` (or `... N hidden (Ctrl+O) ...` when `isNarrowWidth`), clips with
  `overflow="hidden"` and a negative `marginTop` for `overflowDirection='top'`, and registers its `useId()` in
  `OverflowContext` (RAW/packages/cli/src/ui/components/shared/MaxSizedBox.tsx, fetched 2026-09-20).
  `OverflowProvider` batches `addOverflowingId/removeOverflowingId` through `setTimeout(…, 0)` because "showing an
  overflow hint causes a layout shift that hides the hint, which then restores the layout and shows the hint again"
  (RAW/packages/cli/src/ui/contexts/OverflowContext.tsx, fetched 2026-09-20). `ShowMoreLines` prints `Press Ctrl+O to
  show more lines` only when something overflows and `constrainHeight` (RAW/…/ShowMoreLines.tsx, fetched 2026-09-20).
  `SlicingMaxSizedBox` pre-truncates strings to `MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20000` before layout
  (RAW/…/shared/SlicingMaxSizedBox.tsx, fetched 2026-09-20).
- Ctrl+O (`SHOW_MORE_LINES`) sets `constrainHeight=false` and calls `refreshStatic()`; any next key re-enables the
  constraint and refreshes again (AppContainer.tsx lines 1880–1935). `refreshStatic` is literally
  `if (!isAlternateBuffer && !config.getUseTerminalBuffer()) { stdout.write(ansiEscapes.clearTerminal);
  setHistoryRemountKey((prev) => prev + 1); }` — a full clear + `<Static>` remount, also used after theme changes,
  Alt+M markdown toggle, editor close and session resume (AppContainer.tsx; useSessionResume.ts).
- `useFlickerDetector(rootUiRef, terminalHeight)`: after every render, `measureElement(rootUiRef.current).height >
  terminalHeight` while `constrainHeight` → `recordFlickerFrame(config)` telemetry + `AppEvent.Flicker`
  (RAW/packages/cli/src/ui/hooks/useFlickerDetector.ts, fetched 2026-09-20). `DebugProfiler` counts frames, "idle
  frames" (rendered > `MIN_TIME_FROM_ACTION_TO_BE_IDLE = 500` ms from any action while no spinner is mounted) and
  flicker frames (RAW/packages/cli/src/ui/components/DebugProfiler.tsx, fetched 2026-09-20).
- Issue trail (all https://github.com/google-gemini/gemini-cli/…, fetched 2026-09-20): #20217 "Flickering when typing
  file paths" (2026-02-24, closed: "conflicts between max height of tool calls and the height of the terminal on smaller
  terminals"), fixed by PR #21416 (merged 2026-03-18: shell output "wrongly constrained to 40% of the screen height when
  constrainHeight was true", `toolLayoutUtils.ts` recalculated); #21924 "High performance and flicker free behavior on
  terminal resize" (2026-03-10, open: migrate `Static` → `RenderStatic`, "there is a large flicker of previously rendered
  content on resize"); #22004 tmux spinner flicker (2026-03-11, open; asks for "Synchronized Output (DCS = 1 s ST)");
  PR #24512 "enable TerminalBuffer mode to solve flicker" (merged 2026-04-03: virtualized list + static rendering +
  scrollback "backbuffer", settings `ui.terminalBuffer`, `ui.renderProcess`, Ink fork bumped to 6.6.7); #26798
  "Terminal flickering due to manual full-screen clears" (2026-05-10, **closed as not planned** — `refreshStatic` uses
  `ansiEscapes.clearTerminal`, "visible flickering, especially on remote SSH connections or slower terminals"); #28370
  Windows "full-history replay" on resize/hot-reload (2026-07-12, closed: "calling addItem inside a synchronous forEach
  loop on a large historical array triggers an avalanche of React state updates"); #28395 "Blocking Synchronous I/O on
  the Main Thread Causes UI Stutter" (2026-07-13, open: `fs.mkdtempSync()` in `shell.ts`); #29295 (2026-09-12, open):
  "The CliSpinner animates its frames very fast, and the InputPrompt updates the cursor using terminalCursorFocus, which
  triggers aggressive native cursor toggles."
- Ink 7.1.1's own rule (JevCode's runtime): `shouldClearTerminalForFrame` returns true for `wasOverflowing ||
  (isOverflowing && hadPreviousFrame) || isLeavingFullscreen || shouldClearOnUnmount`, and unconditionally on Windows
  console when `wasFullscreen || isFullscreen`; the clear path writes `ansiEscapes.clearTerminal + this.fullStaticOutput
  + outputToRender` (`node_modules/ink/build/ink.js`, read 2026-09-20). That is the replay JevCode's `rows − 2` budget
  already avoids; Gemini's Ctrl+O "unconstrained" mode deliberately enters it and then hides it behind a manual clear.

## 10. Streaming markdown and code blocks

- `MarkdownDisplay` is a hand-rolled line parser, not a markdown library: `headerRegex = /^ *(#{1,4}) +(.*)/`,
  `codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/`, `ulItemRegex`, `olItemRegex`, `hrRegex = /^ *([-*_] *){3,} *$/`,
  `tableRowRegex`, `tableSeparatorRegex`; inline emphasis/links go through `RenderInline`; tables through
  `TableRenderer` (RAW/packages/cli/src/ui/utils/MarkdownDisplay.tsx, fetched 2026-09-20). An unterminated fence at
  end of a pending stream is still rendered as a code block (`if (inCodeBlock) … isPending`). `renderMarkdown=false`
  (Alt+M) prints the raw text through `colorizeCode` as markdown.
- Code: `lowlight` (`createLowlight(common)`), `lowlight.highlight(lang, line)` when `lowlight.registered(language)`
  else `highlightAuto`, HAST nodes mapped to `<Text color={theme.getInkColor(cls)}>`; wrapped in `MaxSizedBox` when a
  height is provided; optional line numbers (`ui.showLineNumbers`) (RAW/packages/cli/src/ui/utils/CodeColorizer.tsx,
  fetched 2026-09-20). Each Gemini message is prefixed `'✦ '` and its height budget reduced by one row
  (RAW/…/messages/GeminiMessageContent.tsx, fetched 2026-09-20).

## 11. Tool confirmation dialog (`messages/ToolConfirmationMessage.tsx`, 1,107 lines)

- Options are a `RadioButtonSelect` list built per type. Edit: `Allow once` (`ProceedOnce`), `Allow for this session`
  (`ProceedAlways`), `Allow for this file in all future sessions` (`ProceedAlwaysAndSave`), `Modify with external editor`
  (`ModifyWithEditor`, hidden in IDE mode), `No, suggest changes (esc)` (`Cancel`). Exec: `Allow once`, `Allow for this
  session`, `Allow this command for all future sessions`, `No, suggest changes (esc)`. MCP adds `Allow tool for this
  session` (`ProceedAlwaysTool`) and `Allow all server tools for this session` (`ProceedAlwaysServer`)
  (RAW/packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx, fetched 2026-09-20).
- Keys: the dialog subscribes with `{ isActive: isFocused, priority: true }`; Esc → `setIsCancelling(true)` and a
  `useEffect` calls `handleConfirm(Cancel)` on the next render ("TODO(#23009) … calling handleConfirm immediately upon
  keypress removes the tool UI component while the UI is in an expanded state … causing render two footers"); Ctrl+C
  (`QUIT`) returns `false` so it bubbles to the app-level quit handler (same file). List navigation: Up/Down and `k`/`j`
  (`DIALOG_NAVIGATION_*`), Enter confirms, and digits pick an item with multi-digit accumulation
  (`NUMBER_INPUT_TIMEOUT_MS = 1000`, `showNumbers` default `true`) (RAW/packages/cli/src/ui/hooks/useSelectionList.ts
  and components/shared/RadioButtonSelect.tsx, fetched 2026-09-20).
- Height: `availableBodyContentHeight = max(availableTerminalHeight − (HEIGHT_QUESTION 1 + MARGIN_QUESTION_BOTTOM 1 +
  SHOW_MORE_LINES_HEIGHT 1 + optionsCount + securityWarningsHeight + extraInfoLines), 2)`; diffs go through
  `DiffRenderer` inside a `MaxSizedBox` (ToolConfirmationMessage.tsx). A queue component (`ToolConfirmationQueue`) shows
  the one confirming tool with pending siblings; `MainContent` scrolls to the end whenever one appears.

## 12. Loading indicator, spinner, witty phrases

- Spinner: `ink-spinner` `'dots'` via `GeminiSpinner`; `CliSpinner` increments `debugState.debugNumAnimatedComponents`
  while mounted (so the profiler knows a frame is animated) and honours `ui.showSpinner !== false`
  (RAW/packages/cli/src/ui/components/CliSpinner.tsx and GeminiRespondingSpinner.tsx, fetched 2026-09-20). Waiting
  for confirmation shows the static glyph `'⠏'`.
- Text: `primaryText = thought.subject ?? currentLoadingPhrase ?? 'Thinking...'`; right of it
  `(esc to cancel, ${elapsedTime}s)` (switching to `formatDuration` after 60 s); witty phrase only when
  `primaryText === 'Thinking...'`, `dimColor italic` (RAW/packages/cli/src/ui/components/LoadingIndicator.tsx,
  fetched 2026-09-20). Narrow terminals stack these vertically (`isNarrowWidth`).
- `usePhraseCycler`: `PHRASE_CHANGE_INTERVAL_MS = 10000` for tips, `WITTY_PHRASE_CHANGE_INTERVAL_MS = 5000` for wit,
  random pick, minimum display time before re-pick, `customWittyPhrases` override, `'Waiting for user confirmation...'`
  while waiting (RAW/packages/cli/src/ui/hooks/usePhraseCycler.ts, fetched 2026-09-20). `WITTY_LOADING_PHRASES` has
  ~125 entries starting `"I'm Feeling Lucky"`, `'Shipping awesomeness'`, `'Reticulating splines'`
  (RAW/packages/cli/src/ui/constants/wittyPhrases.ts, fetched 2026-09-20). `ui.accessibility.disableLoadingPhrases`
  turns them off (settingsSchema.ts).

## 13. Screen-reader mode

- `--screen-reader` flag or `ui.accessibility.screenReader` → `config.getScreenReader()` → Ink's
  `isScreenReaderEnabled` render option (RAW/packages/cli/src/config/config.ts; interactiveCli.tsx, fetched 2026-09-20).
- `ScreenReaderAppLayout` puts `<Footer/>` **above** the history, wraps `MainContent` in `<Box flexGrow={1}
  overflow="hidden">`, uses `width="90%" height="100%"`, and skips the decorative pieces (RAW/packages/cli/src/ui/layouts/
  ScreenReaderAppLayout.tsx, fetched 2026-09-20). Components use `aria-label` on `Text` (prompt status, `(r:)`),
  `SCREEN_READER_USER_PREFIX`, `SCREEN_READER_LOADING/RESPONDING` alt text instead of the spinner
  (InputPrompt.tsx; GeminiRespondingSpinner.tsx; textConstants.ts). Ink 7.1.1 renders unthrottled in this mode:
  `const unthrottled = options.debug || this.isScreenReaderEnabled` (`node_modules/ink/build/ink.js`, read 2026-09-20).

## 14. Sessions, `/chat`, `/resume`, history persistence

- Auto-saved sessions live in `~/.gemini/tmp/<project_hash>/chats/`; resume with `gemini --resume` (latest), `--resume
  <index>` or `--resume <uuid>`; `--list-sessions` prints `1. Fix bug in auth (2 days ago) [a1b2c3d4]`; `--delete-session
  <index|id>` (RAW/docs/cli/session-management.md, fetched 2026-09-20; flags in RAW/packages/cli/src/config/config.ts).
  Issue #29410 (2026-09-19, open): "resume latest reopens most recently started session, not most recently used"
  (https://github.com/google-gemini/gemini-cli/issues/29410, fetched 2026-09-20).
- `/resume` (alias `/chat`) opens a **Session Browser** dialog: browse, preview (date, message count, first prompt),
  `/` to search, Enter to resume, Esc to exit (session-management.md; `resumeCommand.ts` returns `{ type: 'dialog',
  dialog: 'sessionBrowser' }`, RAW/packages/cli/src/ui/commands/resumeCommand.ts, fetched 2026-09-20).
- Manual checkpoints: `/chat save <tag>`, `/chat list`, `/chat resume <tag>` (alt `load`), `/chat delete <tag>`,
  `/chat share [file.md|.json]`, `/chat debug` (exports the last API request); tags are stored as
  `checkpoint-<tag>.json` in the project's gemini dir (RAW/packages/cli/src/ui/commands/chatCommand.ts;
  RAW/packages/core/src/core/logger.ts `path.join(this.geminiDir, \`checkpoint-${encodedTag}.json\`)`, fetched 2026-09-20).
- Resume implementation: `historyManager.clearItems(); uiHistory.forEach((item, index) => addItem(item, index, true));
  refreshStatic(); … await config.getGeminiClient()?.resumeChat(clientHistory, resumedData)`, with an
  `isResuming` flag that shows `'Resuming session...'` (RAW/packages/cli/src/ui/hooks/useSessionResume.ts, fetched
  2026-09-20). This synchronous `forEach → addItem` is the loop blamed in #28370.
- Prompt history across sessions: `Logger` appends every user message to `logs.json` and `getPreviousUserMessages()`
  returns them newest-first; `useInputHistoryStore` merges past + current session and drops consecutive duplicates
  (RAW/packages/core/src/core/logger.ts; RAW/packages/cli/src/ui/hooks/useInputHistoryStore.ts, fetched 2026-09-20).

## 15. Checkpointing (file snapshots) and `/restore`

- Disabled by default; `settings.json` → `general.checkpointing.enabled: true`; "The `--checkpointing` command-line
  flag was removed in version 0.11.0" (RAW/docs/cli/checkpointing.md, fetched 2026-09-20).
- Before a file-modifying tool runs, a commit is made in a **shadow git repo** at `~/.gemini/history/<project_hash>`
  (`GIT_DIR: path.join(repoDir, '.git'), GIT_WORK_TREE: this.projectRoot`, dedicated gitconfig with `gpgsign = false`,
  the user's `.gitignore` copied in); restore is `repo.raw(['restore', '--source', commitHash, '.'])`; conversation +
  the pending tool call are saved as JSON under `~/.gemini/tmp/<project_hash>/checkpoints`; `/restore [<file>]` lists or
  restores and "Re-propose[s] the original tool call" (checkpointing.md; RAW/packages/core/src/services/gitService.ts,
  fetched 2026-09-20). `cleanupCheckpoints()` deletes that directory at every startup
  (RAW/packages/cli/src/utils/cleanup.ts, fetched 2026-09-20).

## 16. Approval modes

- `enum ApprovalMode { DEFAULT = 'default', AUTO_EDIT = 'autoEdit', YOLO = 'yolo', PLAN = 'plan' }`
  (RAW/packages/core/src/policy/types.ts, fetched 2026-09-20). CLI: `--yolo`/`-y` or `--approval-mode
  default|auto_edit|yolo|plan` ("Cannot use both --yolo (-y) and --approval-mode together"); untrusted folders force
  `DEFAULT` (RAW/packages/cli/src/config/config.ts, fetched 2026-09-20).
- Runtime: `Shift+Tab` cycles default → auto_edit → plan ("Plan mode is skipped when the agent is busy"), `Ctrl+Y`
  toggles YOLO (keyboard-shortcuts.md); the prompt prefix becomes `*` and the status text `YOLO mode` in red
  (InputPrompt.tsx). Confirmation dialogs suppress redirection warnings in YOLO/AUTO_EDIT (ToolConfirmationMessage.tsx).

## 17. Console patching, exit and cleanup

- `ConsolePatcher` replaces `console.log/warn/error/debug/info`, formats with `util.format`, and either forwards to
  `onNewMessage({type, content, count})` (shown in the F12 debug console and counted in the footer) or, in `stderr` mode,
  writes to the original `console.error`; `debug` is dropped unless `debugMode`; non-interactive drops `info/log`
  (RAW/packages/cli/src/ui/utils/ConsolePatcher.ts, fetched 2026-09-20). Registered last so shutdown logs still route
  (gemini.tsx: "Register ConsolePatcher cleanup last").
- Ctrl+C: `keyMatchers[Command.QUIT](key)` → `void cancelOngoingRequest?.(); handleCtrlCPress();` where
  `useRepeatedKeyPress({ windowMs: WARNING_PROMPT_DURATION_MS })` (3000 ms) calls `handleExitRepeat(count)`:
  `count > 1` → `/quit`, `count > 2` → `recordExitFail(config)`. Ctrl+D (`EXIT`) is ignored while the buffer has text
  ("If the input field is non-empty, do not exit"). `ExitWarning` renders `Press Ctrl+C again to exit.` /
  `Press Ctrl+D again to exit.` (AppContainer.tsx; RAW/packages/cli/src/ui/components/ExitWarning.tsx; constants.ts,
  fetched 2026-09-20). `handleGlobalKeypress` has **no** buffer-state guard on `QUIT`, and both it and the composer
  subscribe with `priority: true` (`useKeypress(handleGlobalKeypress, { isActive: true, priority: true })`,
  AppContainer.tsx line 2049; InputPrompt.tsx). Same-priority order is "last subscribed is first to handle" and both
  handlers re-subscribe whenever their `useCallback` deps change, so whether a first Ctrl+C clears a non-empty prompt
  (`edit.clear`, as docs/reference/keyboard-shortcuts.md promises: "Cancel the current request or quit the CLI when
  input is empty") or arms the exit warning depends on React effect ordering, not on an explicit rule (KeypressContext.tsx
  `broadcast`; AppContainer.tsx, fetched 2026-09-20).
- Quit flow renders a final `QuittingDisplay` (stats items) in place of the app, then `runExitCleanup()` which first
  drains stdin: "drain stdin to prevent printing garbage on exit https://github.com/google-gemini/gemini-cli/issues/16801"
  (`resume().removeAllListeners('data').on('data', () => {})`, 50 ms), runs sync then async cleanups, disposes config,
  shuts down telemetry; `setupSignalHandlers()` maps SIGHUP/SIGTERM/SIGINT to the same path; `setupTtyCheck()` polls
  every 5 s and exits on TTY loss (RAW/packages/cli/src/utils/cleanup.ts; RAW/packages/cli/src/ui/components/
  QuittingDisplay.tsx, fetched 2026-09-20). Terminal modes are restored by `cleanupTerminalOnExit` (§2.1).
- Memory: `gemini.tsx` relaunches itself with `--max-old-space-size=<n>` when the heap looks too small ("Need to
  relaunch with more memory") (RAW/packages/cli/src/gemini.tsx, fetched 2026-09-20).

## 18. Packaging

- npm workspaces (`packages/*`); the published `@google/gemini-cli` is **one bundle**: `bin: { gemini: 'bundle/gemini.js' }`,
  `files: ['bundle/', 'README.md', 'LICENSE']`, `engines.node >= 20.0.0`; `npm run bundle` = generate git info → build
  devtools → `node esbuild.config.js` → `copy_bundle_assets.js` (RAW/package.json, fetched 2026-09-20).
- `esbuild.config.js`: `bundle: true, platform: 'node', format: 'esm', splitting: true, outdir: 'bundle'`, banner
  `const require = (await import('node:module')).createRequire(import.meta.url); const __chunk_filename = …; const
  __chunk_dirname = …;`, `define` for `__filename/__dirname`, `process.env.CLI_VERSION`, `NODE_ENV`, `DEV`, `external`
  only native addons (`@lydell/node-pty*`, `@github/keytar`), an `alias` that patches `is-in-ci` with a local shim, a
  wasm embed plugin, and a **second entry** `worker/worker-entry` taken from `require.resolve('ink')`'s directory for
  the fork's render-process mode (RAW/esbuild.config.js, fetched 2026-09-20). This matches JevCode's `createRequire`
  banner and `process.env.DEV` define (docs/DESIGN.md §12).
- Docs are generated from code: `scripts/generate-keybindings-doc.ts`, `generate-settings-doc.ts`,
  `generate-settings-schema.ts` (scripts listing and RAW/package.json, fetched 2026-09-20). `docs/npm.md` states
  "When this package is published, it is bundled into a single executable file" (RAW/docs/npm.md, fetched 2026-09-20).

## 19. Performance practice

- Startup phases are timed with `startupProfiler.start('cli_startup' | 'load_settings' | 'parse_arguments' | …)`;
  slow frames (`renderTime > SLOW_RENDER_MS`) and flicker frames are sent as telemetry (gemini.tsx; interactiveCli.tsx).
- `perf-tests/` harness: `performance.now()`, `process.cpuUsage()`, `perf_hooks.monitorEventLoopDelay()`
  (p50/p95/p99/max), warm-up run discarded, N=5 samples, IQR outlier filter, median, `baselines.json`, fail at
  `baseline × 1.15` (RAW/perf-tests/README.md, fetched 2026-09-20). Comparable to JevCode's `perf/render-lag.ts`
  (loop lag p95 < 5 ms) but Gemini has no first-frame gate.
- Hot-path caches: `LRUCache` (mnemonist) for code points, string widths and per-line layouts (`LRU_BUFFER_PERF_CACHE_LIMIT
  = 20000`); shell output ring `MAX_SHELL_OUTPUT_SIZE = 10_000_000` with `SHELL_OUTPUT_TRUNCATION_BUFFER = 1_000_000`
  "This avoids an O(n) string copy on every appended chunk" (constants.ts; textUtils.ts).
- Known perf debts they carry: sync I/O on the loop (#28395), `forEach → addItem` history replay (#28370), spinner +
  cursor toggling (#29295), full clears on `refreshStatic` (#26798), resize replay (#21924) — all cited in §9.

## 20. ADOPT (what JevCode should do)

| # | Adopt | Why | Source |
|---|---|---|---|
| A1 | Keep `render({ exitOnCtrlC: false, patchConsole: false })`; add `isScreenReaderEnabled` from a `--screen-reader` flag / `INK_SCREEN_READER`, and `kittyKeyboard: { mode: 'auto' }`. | Gemini uses the same two flags; Ink 7.1.1 does the kitty query natively (no hand-rolled `\x1b[?u` probe needed). | interactiveCli.tsx; `node_modules/ink/build/render.d.ts` (2026-09-20) |
| A2 | Use Ink 7.1.1 `usePaste` + `useInput` (separate channels) instead of a custom stdin parser. Treat a paste as one `insert` with `\r\n?`→`\n` normalisation and the 5-line/500-char placeholder rule (`[Pasted Text: N lines]`), expanded at submit. | Gets bracketed paste for free (`\x1b[?2004h` managed by Ink); Gemini's placeholder keeps the composer short and avoids the "paste submits" bug. | use-paste.d.ts; text-buffer.ts `LARGE_PASTE_*` |
| A3 | Composer as a pure reducer (`lines[] + cursor[row,col]` in code points, undo/redo snapshot stack capped at 100, `set_text(pushToUndo)`), unit-tested without Ink. | Mirrors JevCode's existing `uiReducer` discipline; Gemini's 4k-line buffer is testable because it is a reducer. | text-buffer.ts |
| A4 | Word boundaries with `Intl.Segmenter('word')` (`isWordLike`), code points via `Array.from`, sanitising with `util.stripVTControlCharacters` + Gemini's C0/C1/bidi regex. | All Node built-ins; measured 32–46 µs/500 chars for the segmenter, ≤ 5 µs for stripping 10k chars (§3) — no caches needed at JevCode's prompt sizes. | text-buffer.ts; textUtils.ts; /tmp bench |
| A5 | Key bindings as a `Command` enum → binding table (`basic.quit`, `input.submit`, `input.newline`, `edit.deleteRightAll` …) with platform-specific undo, and a `~/.jevcode/keybindings.json` override in the VS Code array format (`"-command"` to unbind). Generate the shortcuts doc from the table. | Decouples 30+ handlers from key names; the same table drives the `?` help panel and docs. | keyBindings.ts; docs/reference/keyboard-shortcuts.md |
| A6 | Multi-line editing keys: Enter submits, `shift/ctrl/alt/cmd+enter` and `ctrl+j` insert newline, trailing `\`+Enter continues the line, `ctrl+g` external editor via Ink's `SuspendTerminal`. | Works in terminals without CSI-u (`ctrl+j`, `\`); external editor round-trip through a temp file with a single undo snapshot. | keyBindings.ts NEWLINE; InputPrompt.tsx submit; text-buffer.ts `openInExternalEditor` |
| A7 | Exit semantics in **one** handler that reads buffer state: `Ctrl+C` with text → clear prompt; with empty prompt → cancel the current step and arm a 3 s window (`Press Ctrl+C again to exit.`), second press exits; `Ctrl+D` exits only on an empty prompt; `Esc` = cancel current step. Keep JevCode's checkpoint-then-exit and code 130. | Prevents accidental loss of a run and matches the documented Gemini contract, without Gemini's reliance on same-priority subscription order (§17). | AppContainer.tsx `handleExitRepeat`; ExitWarning.tsx; keyboard-shortcuts.md |
| A8 | Slash-command tree `{ name, altNames, description, hidden, completion(partial), subCommands, autoExecute }`; prefix-then-fuzzy (own ~50-line subsequence scorer instead of `fzf`), `isPerfectMatch` → Enter executes; suggestions pane fixed at ≤ 8 rows with `▲/▼` and `(i/N)`, label column ≤ 50 % width. | Gives `/resume`, `/config`, `/mode`, `/decisions`, `/help`, `/quit` a uniform UX inside JevCode's height budget. | useSlashCompletion.ts; SuggestionsDisplay.tsx |
| A9 | `@path` completion over JevCode's existing cached candidate file list (already computed for the context Noul), debounced, abortable (`AbortController`), max 8 results; drag-dropped paths get spaces escaped. | Reuses the engine's file index instead of a second walker; Gemini's timeouts/abort show the failure modes to cover. | useAtCompletion.ts; clipboardUtils.ts |
| A10 | Steering: Tab while the engine is busy queues the prompt (`QueuedMessageDisplay` above the composer); queue drains on the next `run:ready`/idle; Up on an empty prompt pulls the queue back. Map to JevCode `directive` events. | Turns the run monitor into a chat without interrupting a step; clear rule set for what cannot be queued. | useMessageQueue.ts; InputPrompt.tsx `QUEUE_MESSAGE` |
| A11 | Review dialog = `RadioButtonSelect`: `[1] Approve once  [2] Approve this kind for the run  [3] Decline (esc)` with `j/k`/arrows/digits, `Esc` = decline, `Ctrl+C` bubbles to quit; keep Jev's four risk dimensions + reason above the list inside the budgeted preview rows. | Replaces y/n with a discoverable list; digit selection with a 1 s accumulator handles > 9 items. | ToolConfirmationMessage.tsx; useSelectionList.ts |
| A12 | Semantic theme tokens (`text.primary/secondary/accent`, `status.error/success/warning`, `border.default`, `ui.focus`) behind a getter proxy; `NO_COLOR` → all-empty palette and the line-border fallback; detect light/dark once from OSC 11 (`\x1b]11;?\x1b\\`, luminance > 128) **after the first frame**, no polling. | Zero re-render plumbing for theme changes; honours `NO_COLOR` without per-component branches; first frame stays network- and query-free. | semantic-colors.ts; no-color.ts; theme.ts; #19040 |
| A13 | Footer/status line items as an ordered list (`workspace`, `git-branch`, `sandbox`, `mode`, `step`, `spend`, `context %`) with narrow-width variants (`%` vs `% used`, threshold `MIN_TERMINAL_WIDTH_FOR_FULL_LABEL = 100`). Branch via JevCode's scrubbed git helper + `fs.watch(.git, 'HEAD')` 100 ms debounce. | Same information density, adapts to 60-column terminals. | Footer.tsx; ContextUsageDisplay.tsx; useGitBranchName.ts |
| A14 | Loading row: spinner + `(esc to cancel, Ns)` + the current Jev stage; make phrases opt-in (`ui.wittyPhrases`, default off) and never render an animated component while a confirmation is pending. | Gemini's spinner is its top flicker source in tmux (#22004, #29295); JevCode's 20 fps live coalescer already bounds redraws. | LoadingIndicator.tsx; issues #22004/#29295 |
| A15 | Sessions: `/resume` opens a list of JevCode run ids from `~/.jevcode/runs` (date, task first line, stop reason) with `/`-search, Enter, Esc; `jevcode run --resume` without id = most recently **used**; add `--list-sessions`. | Gemini's browser UX is good; #29410 shows "latest" must mean last-used. | session-management.md; #29410 |
| A16 | Screen-reader layout: when enabled, put the status line first, drop the rule/spinner, and use `aria-label` text for prompt state; Ink renders unthrottled in that mode. | Cheap, and Ink 7.1.1 supports it natively. | ScreenReaderAppLayout.tsx; ink.js |
| A17 | Measure the composer/controls height with Ink 7.1.1 `useBoxMetrics`/`measureElement` and subtract it from JevCode's `rows − 2` budget so the transcript pane never pushes the dynamic region past the viewport; add a `useFlickerDetector`-style assertion (`measureElement(root).height > rows`) to the perf gate. | Gemini's `availableTerminalHeight = rows − stableControlsHeight − 1` is the right formula; JevCode already gates `\x1b[2J` = 0. | AppContainer.tsx; useFlickerDetector.ts |
| A18 | Prompt history: persist submitted prompts per workspace (append-only JSONL under `~/.jevcode`), dedupe consecutive duplicates, restore cursor when returning to a history level; separate 100-entry history for `!` shell commands if shell mode is added. | Matches Gemini's `logs.json` + `useInputHistoryStore`; keeps secrets out because prompts are redacted through JevCode's redactor before write. | useInputHistoryStore.ts; useInputHistory.ts; useShellHistory.ts |
| A19 | Console capture: keep `patchConsole: false` but install a tiny `ConsolePatcher` that routes `console.*` to a bounded in-memory list shown by `F12` and counted in the status line; restore on unmount. | Stray logs never break the frame; Gemini's 74-line class is the whole design. | ConsolePatcher.ts |
| A20 | Exit hygiene: one synchronous `fs.writeSync(stdout.fd, '\x1b[<u\x1b[?2004l\x1b[?25h')` on `exit`/SIGTERM/SIGINT (only the modes JevCode enables), drain stdin ~50 ms before exit, clear the OSC 0 title if set. | Avoids garbage after exit (#16801) and stuck kitty/paste modes after a crash. | terminalCapabilityManager.ts; cleanup.ts |

## 21. REJECT (what not to copy)

| # | Reject | Why |
|---|---|---|
| R1 | Gemini's hand-written stdin parser (`KeypressContext.tsx`, 900 lines: ESC timeouts, `bufferFastReturn`, `bufferBackslashEnter`, OSC/mouse parsing). | Ink 7.1.1 already parses legacy + CSI-u keys, bracketed paste and kitty; duplicating it adds a second raw-mode owner and 30 ms/5 ms heuristics that mis-fire on fast typists. |
| R2 | The private Ink fork features: `ResizeObserver`, `terminalCursorFocus`, `alternateBuffer`/`terminalBuffer`/`renderProcess`, worker render process, `VirtualizedList` scrollback backbuffer. | Not in Ink 7.1.1 and against the two-dependency rule; JevCode's `<Static>` + `rows − 2` budget already yields zero clears. `useCursor()` and `useBoxMetrics()` cover the two genuinely useful bits. |
| R3 | `refreshStatic()` = `ansiEscapes.clearTerminal` + `<Static>` remount (Ctrl+O unconstrained mode, theme change, Alt+M, resume). | Violates "zero terminal clears after the first frame"; Gemini closed the complaint as not planned (#26798). JevCode's transcript items are immutable, so theme/markdown toggles must apply to future items only, or reopen via a pager. |
| R4 | `general.debugKeystrokeLogging` (`[DEBUG] Raw StdIn:` / `Keystroke:` logs). | Keys must never appear in logs; JevCode's `JEVCODE_TRACE` already logs only `ctrl`/`input` metadata for Ctrl-C and y/n — keep it that way and drop even that for the composer. |
| R5 | OSC 11 background polling (`ui.autoThemeSwitching`, `terminalBackgroundPollingInterval`). | Caused flicker (#19040/#19174) and would run a query on a timer; a single post-first-frame query is enough. |
| R6 | Third-party runtime deps: `fzf`, `string-width`, `chalk`, `lowlight`/`highlight.js`, `clipboardy`, `mnemonist`, `ink-spinner`, `ink-gradient`, `simple-git`, `yargs`, `zod`. | Forbidden by the one-package/two-deps constraint; replacements are `Intl.Segmenter`, a small wcwidth table, Ink `color`, a ≤ 200-line fence/heading highlighter, OSC 52 or no clipboard, `Map`, `useAnimation`, `node:child_process`, `util.parseArgs`. |
| R7 | Full markdown + syntax-highlighting of streamed text (`MarkdownDisplay` + `lowlight common`, `MAX_GEMINI_MESSAGE_LINES = 65536`). | Highlighting every streamed delta is CPU on the loop; JevCode's proposals are tool calls/diffs, not prose. Render fences and headings only, and only on the committed `proposal` item. |
| R8 | Shadow-git checkpointing (`~/.gemini/history/<hash>`) and `/restore`. | JevCode already checkpoints every step atomically with `--resume`; a second git tree inside the seatbelt profile conflicts with the write-deny rules for `~/.jevcode`. |
| R9 | Witty phrases / tips cycling on 5 s and 10 s timers by default. | Extra state updates while idle; JevCode's spinner is the only animation and the perf gate counts idle frames. Make it opt-in (A14). |
| R10 | Vim mode (60 reducer actions, `vim-buffer-actions.ts`). | Large surface for a first release; revisit after the composer is stable. |
| R11 | Synchronous `forEach → addItem` history replay and sync I/O (`fs.mkdtempSync`) on the render loop. | Root causes of #28370 and #28395; JevCode's event bus already replays into one reducer dispatch per event — keep replays batched into one `items` array update. |
| R12 | Approval **modes** that auto-approve (`--yolo`, `auto_edit`, `Ctrl+Y`, `Shift+Tab` cycling). | JevCode's risk thresholds are fixed by design (≥ 0.7 block, 0.3–0.7 ask, no auto-approve); expose only the read-only/plan equivalent if any. |
| R13 | Interactive PTY shell focus (`Tab` to focus, background shells, `Ctrl+B/L/K`). | JevCode's sandbox is non-interactive by contract (detached process group, output cap, tree kill). |
| R14 | Resolving key conflicts (`ctrl+c` = quit *and* clear, `ctrl+d` = exit *and* delete-right, `ctrl+z` = undo *and* suspend) by subscription order across two `priority: true` handlers. | Order flips whenever either handler re-subscribes (their `useCallback` deps change on most state updates); JevCode should route every key through one matcher that consults buffer/engine state explicitly. |

## 22. OPEN QUESTIONS

1. **Wide-character width without `string-width`.** Node has no built-in `wcwidth`. Options: (a) a hand-rolled table of
   East-Asian-Wide/emoji ranges (~40 ranges, needs a test corpus); (b) import `string-width` transitively through Ink's
   bundle (works with esbuild but violates the spirit of the two-dependency rule); (c) ASCII-only fast path plus
   `Intl.Segmenter('grapheme')` counting graphemes as width 1 (wrong for CJK). Which does the design accept? Gemini needed
   a crash fallback even with `string-width` (U+0602, issue 16418).
2. **Cursor rendering.** Ink 7.1.1 `useCursor().setCursorPosition` positions the real cursor (good for IME, no inverse
   glyph); Gemini's `chalk.inverse` fallback flickers with spinners (#29295). Do we use the real cursor and hide it while
   the spinner runs, or the inverse glyph only?
3. **Does Ink 7.1.1's kitty `auto` detection or bracketed-paste enable write anything before the first frame?**
   `ink.js` "Auto mode: query the terminal" — need to confirm it happens after the first `render()` commit so the
   `perf/first-frame.ts` zero-network/zero-read contract and the `stty` pty harness are unaffected.
4. **Suggestions pane inside the `rows − 2` budget.** Eight suggestion rows + a multi-line composer + decisions pane will
   not fit at `rows = 12`. Proposal: suggestions steal from the decisions pane first (like the confirm preview), min 3
   rows; confirm the allocation order in DESIGN.md §10.
5. **Theme/markdown toggles vs immutable `<Static>` items.** Without `refreshStatic` (R3), a theme switch applies only to
   new items. Is that acceptable, or should `/theme` be restart-only (Gemini marks `useAlternateBuffer` and
   `incrementalRendering` `requiresRestart: true`)?
6. **Escape ambiguity.** Ink emits `escape` after its own timeout; Gemini uses 50 ms and a double-ESC rule. With Esc =
   "cancel step", a slow `ESC f` (alt+f) over SSH could cancel a step. Should Esc-cancel require two presses within
   500 ms like Gemini's clear/rewind gesture?
7. **Prompt history file and secrets.** Prompts may contain pasted keys; Gemini writes them raw to `logs.json`. JevCode's
   redactor is seeded with configured secrets only — is that sufficient for history persistence, or should history be
   opt-in?
8. **Which Gemini slash commands map to Jev-native views?** Candidates: `/decisions` (full decisions list with
   probability/confidence, paged), `/plan` (persistent plan), `/budget`, `/mode jev-on|jev-off|jev-only` (restart-only?),
   `/resume`, `/config`. Needs product decision before the command tree is frozen.
9. **`--list-sessions` ordering and "latest".** JevCode run ids are timestamp-prefixed (created), but `--resume` with no
   id should pick the most recently *used* run (#29410); this needs a `lastUsed` field in `run.json`.
10. **Ink 7.1.1 `incrementalRendering` and `maxFps`.** Gemini only enables incremental rendering in alternate-buffer mode.
    Is it safe with `<Static>` in Ink 7.1.1, and should JevCode lower `maxFps` from 30 to 20 to match `LIVE_FLUSH_MS = 50`?
    Needs a render-lag measurement under `perf/render-lag.ts`.
11. **UNVERIFIED**: the exact behaviour of Gemini's session browser keys and `--delete-session` from the browser; the doc
    was cut at "From the Session Browser:" and `components/SessionBrowser.tsx` was not read in full.
