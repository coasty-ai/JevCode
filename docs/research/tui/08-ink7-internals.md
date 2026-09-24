# 08 — Ink 7.1.1 internals for a chat composer and a scrolling transcript

Research for the JevCode interactive TUI (prompt composer, slash commands, sessions/resume, steering, review
prompts, Jev decisions view). Date of all reads and fetches: **2026-09-20**. Author: research agent.

**Method.** Every Ink claim below was read from the *installed* package at
`<repo>/node_modules/ink/build/` (ink 7.1.1, `package.json` `"version": "7.1.1"`,
`"engines": {"node": ">=22"}`), cited as `file.js:line`. Behaviour that could not be settled by reading was probed by
running the installed parser modules directly and by rendering real Ink trees against (a) fake TTY streams with exact
geometry and byte counting and (b) a real pty created with macOS `script -q /dev/null sh -c 'stty rows 24 cols 80; node …'`.
Microbenchmarks ran in `/tmp/ink-bench` against a fresh `npm install ink@7.1.1 react@19.3.0` (38 packages), Node
v22.23.2 (ICU 78.2, Unicode 17.0), never inside the repo. Web sources are cited with URL and the fetch date. Items marked
**UNVERIFIED** could not be fetched or were only summarised by the fetch tool rather than quoted.

Repo constraints this respects: Node 22.23.2, TS strict/no `any`, ESM, one npm package, runtime deps only `ink@7.1.1` and
`react@19.3.0`, esbuild single file, first frame < 300 ms with zero network, rendering never blocks the loop, zero
terminal clears after the first frame (`shouldClearTerminalForFrame` discipline, DESIGN.md §10), keys never in logs.

---

## 0. Executive summary (what decides the design)

1. **Ink has everything a composer needs except the text buffer**: `useInput` (parsed keys), `usePaste` (bracketed
   paste on a separate channel), `useCursor` (real terminal cursor placement → IME), `kittyKeyboard` (Shift+Enter,
   Super, release events), `suspendTerminal` (`$EDITOR`, `!` passthrough), `useWindowSize`, `<Box overflow="hidden">`.
   It has **no scrolling primitive** (`overflow` is clip-only; no `scrollTop`), **no multi-line text input**, and the two
   npm inputs (`ink-text-input@6.0.0`, `@inkjs/ui@2.0.0`) are single-line, string-index cursors, last published May 2024,
   and pull `chalk` → they violate the two-dependency rule anyway. **Hand-roll the buffer** (§9).
2. **Shift+Enter is a terminal problem, not an Ink problem.** Legacy terminals send `\r` for both. With kitty protocol
   Ink parses `CSI 13;2u` into `key.return && key.shift` (probe-verified). Without it, the only distinguishable
   newline keys are Alt/Option+Enter (`ESC CR` → `key.return && key.meta`) and Ctrl+J (`\n` → `name 'enter'`, which
   `useInput` does **not** map to `key.return`). xterm `modifyOtherKeys` form `CSI 27;2;13~` is **not parsed**: it
   arrives in the composer as the literal text `[27;2;13~` (probe-verified). Adopt: kitty `auto`, plus Alt+Enter,
   Ctrl+J and `\`+Enter fallbacks (the same set Claude Code and opencode document).
3. **The clear-terminal path is exactly as feared and measurable**: with the dynamic region 4 rows over the viewport,
   every keystroke costs **29,765 bytes and one `ESC[2J`** (500-line transcript replayed), a `<Static>` append
   **62 KB and two clears**. Inside the budget the same keystroke costs **893 B** (standard) or **127 B**
   (`incrementalRendering`) at 24×80. Keep the `rows − 2` budget; it is the whole game.
4. **`incrementalRendering: true` cuts per-keystroke bytes 7–8×** (893→127 at 24×80, 2093→247 at 50×200) and to
   zero `ESC[2K` erases, with identical render time. It gives **nothing on `<Static>` append frames** (Ink calls
   `log.clear()` then rewrites the whole region). Risk: line-diff desync if the terminal wraps a line Ink thought fit.
5. **`<Static>` items committed while `suspendTerminal()` is active are silently dropped** (verified on a real pty and
   in the harness): `onRender` returns early while suspended (`ink.js:336-342`) and `<Static>` advances its index on
   every commit (`Static.js:15-17`). Buffer transcript items during `!`/`$EDITOR` and flush after resume.
6. **`<Static>` is not a list, it is an append cursor.** Replacing the `items` array with a different array renders
   nothing new (probe: 0 of 3 items) unless `<Static key={sessionId}>` remounts it (3 of 3). Sessions/resume must key it.
7. **Escape has a 20 ms latency** (`App.js:44-45`, measured 21 ms) and a lone `ESC [` split across chunks > 20 ms
   apart is delivered as text `[` then `D` (measured). Fine locally; document for high-latency SSH.
8. **Raw mode, cursor, bracketed paste and kitty are restored on every exit path** — `process.exit`, uncaught throw,
   unhandled SIGINT, handled SIGTERM → `process.exit(143)`, manual `unmount()` — verified byte-for-byte (§3.1).
9. **Memory**: production React + Ink retains ~50–240 B/frame with repeating strings, but **~1 KB per frame of unique
   text** (Ink's unbounded `measureText`/`wrapText` caches, `measure-text.js:2`, `wrap-text.js:3`): 5,000 unique
   127-char frames → 4.7 MB. React's **development** build additionally leaks 3.4–7 KB/frame of `PerformanceMeasure`
   entries into Node's user-timing buffer. `scripts/build.mjs:29` already defines `NODE_ENV=production` for `dist/`;
   `npm run dev` (tsx) and vitest do not.
10. **`ink-testing-library@4.0.0`'s fake stdout has `columns` but no `rows`**, so every `getWindowSize()` falls back to
    `terminal-size`, which opens `/dev/tty` (`terminal-size/index.js:101-112`): **2.34 ms per call** vs 0.0003 ms. Give
    test stdouts a `rows` field.
11. **First frame vs transcript size** (production, 120 cols, in-process): 0 items 6.6 ms · 100 → 10 ms · 500 → 27 ms
    · 2,000 → 94 ms · 5,000 → 183 ms; 500 items that *wrap* at 80 cols → ~86 ms. `--resume` must replay in batches
    after the first frame, not in it.
12. **`src/tui/App.tsx:125-126` writes `input=${JSON.stringify(input)}` to `JEVCODE_TRACE`.** With a composer that is
    keystroke logging. Remove or reduce to key-class before the composer lands.

---

## 1. Rendering pipeline (commit → frame → bytes)

**Commit hook.** React's `resetAfterCommit(rootNode)` runs `onComputeLayout` (Yoga layout at terminal width), emits
layout listeners, resets `fullStaticOutput` if the `<Static>` node identity changed, and then: if `isStaticDirty` it
calls `onImmediateRender` (bypasses the fps throttle) and **returns**, else `onRender` (throttled)
(`reconciler.js:92-118`). `<Static>` marks `isStaticDirty` in `createInstance` and `commitUpdate`
(`reconciler.js:152-158, 224-226`).

**Throttle.** `maxFps` default 30 → `renderThrottleMs = Math.max(1, Math.ceil(1000 / maxFps))` = 34 ms, es-toolkit
`throttle(..., {leading: true, trailing: true})` (`ink.js:194-214`; default in `render.js:16`). `debug` or screen-reader
mode disables throttling (`ink.js:193`). A keystroke therefore renders immediately (leading edge); bursts coalesce and
the trailing call guarantees the final state; worst-case added latency is one throttle window. `throttledLog` wraps
`log()` in `BSU`/`ESU` only when the frame actually changes (`ink.js:221-236`).

**Frame.** `onRender` renders the DOM to `{output, outputHeight, staticOutput}` (`renderer.js:3-53`), measures only that
step for `onRender({renderTime})` (`ink.js:347-349` — Yoga layout and the stdout write are **not** included), appends
new static output to `fullStaticOutput` (`ink.js:416`) and calls `renderInteractiveFrame` (`ink.js:748-798`):

```
viewportRows = stdout.rows (24 if unknown)             // ink.js:753
isFullscreen = outputHeight >= viewportRows            // ink.js:754  → no trailing '\n' when fullscreen
if shouldClearTerminalForFrame(...)                    // ink.js:756-777
    write(BSU) write(clearTerminal + fullStaticOutput + outputToRender) log.sync(outputToRender) write(ESU)
else if hasStaticOutput                                // ink.js:779-790
    write(BSU) log.clear() write(staticOutput) log(outputToRender) write(ESU)
else if output !== lastOutput || log.isCursorDirty()  // ink.js:791-794
    throttledLog(outputToRender)
```

`ansiEscapes.clearTerminal` is `ESC[2J ESC[3J ESC[H` (erase screen, erase scrollback, home) on non-old-Windows
(`node_modules/ansi-escapes/base.js:124-130`) — it destroys scrollback, which is why JevCode gates on zero `ESC[2J`.

**The clear predicate** (`ink.js:89-112`), verbatim:

```
const hadPreviousFrame = previousOutputHeight > 0;
const wasFullscreen = previousOutputHeight >= viewportRows;
const wasOverflowing = previousOutputHeight > viewportRows;
const isOverflowing = nextOutputHeight > viewportRows;
const isFullscreen = nextOutputHeight >= viewportRows;
const isLeavingFullscreen = wasFullscreen && nextOutputHeight < viewportRows;
const shouldClearOnUnmount = isUnmounting && wasFullscreen;
if (isWindowsConsole && (wasFullscreen || isFullscreen)) { return true; }
return (wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen || shouldClearOnUnmount);
```

So `rows − 1` is the last safe height (`>=` triggers only `isLeavingFullscreen`/unmount clears), `rows − 2` leaves
one row of slack for a wrapped status line. On Windows console any fullscreen frame clears (`ink.js:88`, comment
cites #969). The 7.1.1 fix #974 ("fix: preserve last <Static> line erased after a full-clear frame", by costajohnt,
merged 2026-07-16, https://github.com/vadimdemedes/ink/pull/974, fetched 2026-09-20) made the clear path write
`outputToRender` (with trailing newline) so `log.sync`'s recorded height matched what was on screen; before it "the
next incremental frame's `eraseLines(previousLineCount)` reached one row too far and erased the last committed
`<Static>` line". Release notes: "Fix: Preserve last `<Static>` line erased after a full-clear frame (#974)" and "Make
`measureElement()` also return position coordinates (#968)" (https://github.com/vadimdemedes/ink/releases/tag/v7.1.1,
16 Jul, fetched 2026-09-20). v7.1.0 (17 Jun): "Add `suspendTerminal()` to hand the terminal to a child process (#972)"
(https://github.com/vadimdemedes/ink/releases/tag/v7.1.0, page partially failed to load — **UNVERIFIED beyond that
bullet**). v7.0.0 (8 Apr) per the fetch tool's summary (not verbatim, **UNVERIFIED wording**): Node 22 + React 19.2
required, `usePaste`, `useWindowSize`, `useBoxMetrics`, `useAnimation`, `alternateScreen`, `interactive`, `wrap="hard"`,
"Pressing Backspace now correctly sets `key.backspace` instead of `key.delete`", "`key.meta` is no longer set to `true`
when Escape is pressed", "Fix incremental rendering for trailing newline (#910)", kitty querying (#895)
(https://github.com/vadimdemedes/ink/releases/tag/v7.0.0, fetched 2026-09-20). `https://api.github.com/repos/vadimdemedes/ink/releases`
returned HTTP 403 (unauthenticated rate limit) both via WebFetch and curl — **UNVERIFIED**.

### 1.1 `<Static>` semantics (append-only cursor)

`Static.js:9-27`: `const [index, setIndex] = useState(0)`; renders `items.slice(index)`; `useLayoutEffect(() =>
setIndex(items.length), [items.length])`; container style `position: 'absolute', flexDirection: 'column'`. The static
node is laid out and rendered as its own `Output` and a `'\n'` is appended "because static output doesn't have one, so
interactive output will override last line of static output" (`renderer.js:30-46`). Readme: "`<Static>` only renders
new items in the `items` prop and ignores items that were previously rendered" (installed `readme.md:1541`).

Probed consequences (production React, fake TTY 40×120):
- Replace `items` (5 items → different 3-item array), same `key`: **0 of 3** new items written. With
  `<Static key={sessionId}>` remount: **3 of 3** written. `onStaticChange` resets `fullStaticOutput` on identity change
  (`reconciler.js:98-105`, `ink.js:325-327`), so keyed remount is the supported way to switch transcripts.
- Two commits while suspended: both batches lost (§6).
- Every append frame costs `log.clear()` (erase whole dynamic region) + static bytes + full dynamic rewrite, inside one
  `BSU`/`ESU` pair (`ink.js:779-790`), in both log-update modes (measured §11).
- `fullStaticOutput` grows for the life of the process (`ink.js:416`) and is replayed whole on every clear-path frame.

### 1.2 log-update: what is erased per frame

Standard mode (`log-update.js:20-57`): `stream.write(returnPrefix + ansiEscapes.eraseLines(previousLineCount) + str +
cursorSuffix)`; `previousLineCount = lines.length` where `lines = str.split('\n')` **including the empty trailing
element** → for a dynamic region of H rows it erases H+1 lines. `eraseLines(n)` is `n × ESC[2K` interleaved with
`n−1 × ESC[1A` plus `ESC[G` (`ansi-escapes/base.js:77-89`) — measured `ESC[2K` per keystroke frame: 7 (6 rows), 23 (22
rows), 49 (48 rows). Incremental mode (`log-update.js:105-198`): `cursorUp(previousLines.length − 1)`, then per line
`cursorTo(0) + line + eraseEndLine` only where `nextLines[i] !== previousLines[i]` (comment: "We do not write lines if
the contents are the same. This prevents flickering during renders.", confirmed at tag v7.1.1
https://github.com/vadimdemedes/ink/blob/v7.1.1/src/log-update.ts fetched 2026-09-20); shrinking output erases the extra
lines; first frame and `str === '\n'` fall back to full write. `render.clear()` in both modes erases everything, so
static appends get no incremental benefit. Cursor-only frames (`str === previousOutput && cursorChanged`) write just
`hide + returnToBottom + cursorUp + cursorTo + show` (`log-update.js:36-44`, `cursor-helpers.js:39-44`).

Readme on `incrementalRendering`: "Enable incremental rendering mode which only updates changed lines instead of
redrawing the entire output. This can reduce flickering and improve performance for frequently updating UIs."
(`readme.md:2671-2677`). Trade-off: the diff assumes the terminal cursor is exactly `previousLines.length − 1` rows below
the frame top, i.e. no line auto-wrapped and nothing else wrote to the terminal. Any width mis-measure (terminal
wcwidth ≠ string-width) or stray write desyncs it until the next `clear()` (resize narrower, static append, suspend
resume). Standard mode self-heals every frame. Ink itself mitigates stray writes: `patchConsole` and `useStdout().write`
route through `log.clear()` + `restoreLastOutput()` (`ink.js:433-461`).

### 1.3 Synchronized output, alternate screen, resize, non-interactive

- `BSU = ESC[?2026h`, `ESU = ESC[?2026l`; used when `stream.isTTY && (interactive ?? !isInCi)` (`write-synchronized.js:2-8`,
  `ink.js:714-716`). Wraps clear-path frames, static appends, console writes and every changed `throttledLog` frame.
- `alternateScreen`: writes `ESC[?1049h` + hide cursor at construction, `ESC[?1049l` + show at unmount (`ink.js:699-705,
  548-552`); "The terminal's scrollback buffer is not available while in the alternate screen" (`readme.md:2726`).
  `<Static>` still works but lands in the alt buffer — useless for a scrollback transcript. **Reject** for JevCode.
- Resize: Ink subscribes to `stdout 'resize'` before any component; on shrink it `log.clear()`s (comment: "to prevent
  duplicate overlapping re-renders"), then recomputes layout and renders **unthrottled** (`ink.js:279-291`).
  `useWindowSize` is a second subscriber that sets state → a second frame (`hooks/use-window-size.js:7-20`). Readme:
  "When the terminal is resized narrower, ghost lines may briefly appear depending on the terminal emulator's reflow
  behavior." (`readme.md:2268`). Scrollback (Static) is reflowed by the terminal, not by Ink.
- `getWindowSize(stdout)`: `if (columns && rows) return …; const fallbackSize = terminalSize(); return {columns:
  columns || fallbackSize.columns || 80, rows: rows || fallbackSize.rows || 24}` (`utils.js:7-18`). `terminal-size@4.0.1`
  checks `process.stdout/stderr` rows+columns, then `COLUMNS`/`LINES`, then on darwin `devTty()` (opens `/dev/tty` and
  builds a `tty.WriteStream`), then `tput cols`/`tput lines` via `execFileSync` with a 500 ms timeout
  (`terminal-size/index.js:9-16, 68-112`). Measured: `getWindowSize({columns: 100})` = **2.34 ms/call**; with `rows`
  0.0003 ms. `ink-testing-library@4.0.0`'s `Stdout` has `get columns() { return 100 }` and no `rows`
  (`ink-testing-library/build/index.js:4-6`) → every Ink layout in `test/unit/tui/app.test.tsx` and `height.test.tsx`
  pays it (and would spawn `tput` on Linux CI without `/dev/tty`).
- Non-interactive (`interactive` false, or CI, or non-TTY stdout): static output is written as it comes, the dynamic
  frame only at unmount, no erase/cursor/sync/kitty (`ink.js:362-370, 553-559`; `readme.md:2706`). JevCode's plain
  mode already bypasses Ink there.

### 1.4 Memory behaviour (measured)

Module-level caches with no eviction: `measure-text.js:2` `const cache = new Map()` keyed by the full text of every
`<Text>` ever measured; `wrap-text.js:3` `const cache = {}` keyed by `text + maxWidth + wrapType` for every text that
had to wrap or truncate. Per-frame `Output` caches are per instance and die with the frame (`output.js:4-46`).
Measurements (2 `<Text>` nodes, one frame per unique string, explicit GC before/after):

| Build | Strings | Frames | Heap Δ | per frame |
| --- | --- | --- | --- | --- |
| React dev (NODE_ENV unset) | alternating 2 | 2,000 | 13.2 MB | 6,940 B |
| React dev | unique 46-char | 5,000 | 16.4 MB | 3,431 B |
| React prod | alternating 2 (fake TTY / no flush / non-TTY / **real pty**) | 2,000 | 0.18 / 0.09 / 0.46 / 0.19 MB | 95 / 49 / 239 / 97 B |
| React prod | unique 127-char (wrapping) | 5,000 | 4.7 MB | 985 B |

Heap-snapshot diff of the dev run: `+7,993 PerformanceMeasure`, `+7,993 "primary-light"`, `+5,994 "Components ⚛"`,
`+5,994 "– children"` strings over 2,000 frames — React's Performance Tracks, "only available in development and
profiling builds of React" (https://react.dev/reference/dev-tools/react-performance-tracks, fetched 2026-09-20),
emitted with `performance.measure`; Node keeps measures until `performance.clearMeasures()` (verified: 50,000 measures
→ `getEntriesByType('measure').length === 50000`). `react-reconciler/index.js` and `react/index.js` select the
development build whenever `process.env.NODE_ENV !== 'production'`. `dist/jevcode.mjs` contains
`react-reconciler.production` and zero `Components ⚛` (`scripts/build.mjs:29` `define: { 'process.env.DEV': '"false"',
'process.env.NODE_ENV': '"production"' }`), so the shipped bundle is safe; `npm run dev`/vitest are not.

---

## 2. Input pipeline

### 2.1 Raw mode lifecycle and exit restoration

`App.js`: `isRawModeSupported = stdin.isTTY` (:121). `setRawMode(true)` from the first hook does `stdin.setEncoding('utf8')`,
`stdin.ref()`, `stdin.setRawMode(true)`, attaches one `'readable'` listener and increments a refcount (:208-231);
the last `setRawMode(false)` detaches input immediately but defers the terminal teardown to a microtask so a same-render
replacement component keeps raw mode without a disable/enable cycle (:233-249). If `isRawModeSupported` is false the
call **throws** `"Raw mode is not supported on the current process.stdin…"` (:210-215) — hence JevCode's
`{ isActive: Boolean(isRawModeSupported) }` gate stays mandatory. Unmount effect: `cliCursor.show(stdout)`, disable raw
mode, `ESC[?2004l` if bracketed paste was on (:465-482). `Ink` registers `signalExit(this.unmount, { alwaysLast: false })`
(`ink.js:255`); signal-exit 3.0.7 patches `process.reallyExit` and `process.emit('exit')` so its listeners run **after**
the app's own `'exit'` listeners (`signal-exit/index.js:170-199`), and for fatal signals only acts when no other listener
is registered (`listeners.length === emitter.count`, then re-raises the signal) (`signal-exit/index.js:110-135`). Ink's
`unmount(error)` treats a numeric/null argument as "process exiting" and resolves synchronously (`ink.js:574-592`).

Probe (fake TTY, `kittyKeyboard: {mode: 'enabled'}`, `useInput` + `usePaste`), writes after the app's `'exit'` listener,
identical for `process.exit(0)`, uncaught throw (exit 1), unhandled SIGINT, own SIGTERM handler → `process.exit(143)`,
and manual `unmount()`:

```
ESC[?25h            (App unmount effect: cliCursor.show)
stdin.setRawMode(false); stdin.unref()
ESC[?2004l          (bracketed paste off)
ESC[<u              (kitty pop, ink.js:540)
ESC[?25h            (log.done)
```

JevCode's own `process.on('SIGINT'|'SIGTERM')` handlers mean signal-exit never re-raises; the checkpoint-then-`exit`
path in `main.tsx` ends in `process.exit`, which runs the sequence above. `cli-cursor`'s `restore-cursor` also writes
`ESC[?25h` to **process.stderr** on exit regardless of Ink's stdout (observed as a stray `[?25h` when stdout was a fake).

### 2.2 Chunk parsing (`input-parser.js`)

`createInputParser().push(chunk)` splits a stdin chunk into events (`:125-165`): text runs, complete escape sequences,
and `{paste}` objects. CSI parsing accepts parameter bytes `0x30–0x3F`, intermediates `0x20–0x2F`, final `0x40–0x7E`,
and a second `[` right after CSI for `ESC[[A`-style legacy keys (`:13-37`); SS3 (`ESC O x`) is fixed length (`:38-51`);
`ESC ESC` + CSI is meta-prefixed (`:79-94`); any other `ESC x` is one two-codepoint event (`:65-73`). Bracketed paste:
`pasteStart = ESC[200~`, `pasteEnd = ESC[201~`; content between them becomes `{paste: …}` **unparsed**, and an
unfinished paste stays pending without a flush timer (`:148-157, 174-180`). Backspace bytes `0x7F`/`0x08` inside a text
run are split into single events ("When a user holds the backspace key, the terminal sends repeated bytes in a single
stdin chunk"); `\r`, `\n`, `\t` are **not** split "because they can legitimately appear inside pasted text" (`:104-124`).
Incomplete escapes are flushed after `pendingInputFlushDelayMilliseconds = 20` (`App.js:44-45, 164-174`).

Probe (`createInputParser` from the installed build):

| push | events | pending escape |
| --- | --- | --- |
| `"ab"` | `["ab"]` | no |
| `"\x1b"` | `[]` → flushed after 20 ms as `"\x1b"` | yes |
| `"\x1b["` then `"A"` | `[]` then `["\x1b[A"]` | yes → no |
| `"\x1b[200~hello\nworld"` then `"\x1b[201~"` | `[]` then `[{paste:"hello\nworld"}]` | no (paste) |
| `"\x7f\x7f\x7fabc"` | `["\x7f","\x7f","\x7f","abc"]` | no |
| `"\r\n\ttabbed"` | `["\r\n\ttabbed"]` (one event) | no |
| `"日本語👍"` | `["日本語👍"]` | no |
| `"\x1b[13;2u\x1b[13;2u"` | two events | no |
| `"\x1b\x1b"` then `"\x1b[27;2;13~"` | `[]` then `["\x1b\x1b","\x1b[27;2;13~"]` | yes → no |

End-to-end timing through a real render (`useInput` handler timestamps): plain keys 0–0.5 ms; **Escape alone 21.3 ms**;
`ESC[` + `D` 2 ms apart → one `leftArrow` at 2.4 ms; 30 ms apart → `input "["` at 21 ms then `input "D", shift` at 31 ms
(garbage into a composer). A multi-character chunk such as `"ab"` (fast typing or a paste without bracketed mode)
reaches `useInput` as **one** call with `input === "ab"` (readme: "if the user pastes text and it's more than one
character, the callback will be called only once", `use-input.js:7`).

### 2.3 Key parsing (`parse-keypress.js`)

Order: kitty `CSI codepoint ; mods[:event] [; text] u` (`kittyKeyRe :125`, `parseKittyKeypress :280-340`), then kitty
enhanced legacy `CSI num ; mods : event {letter|~}` (`:129, 343-365`), then a **safe empty** result for a CSI-u that
failed validation (`:393-404`), then legacy (`:405-492`). Names that exist: `up down left right clear end home insert
delete pageup pagedown f1–f12 tab return enter escape space backspace` plus digits (`'number'`), lower-case letters (Shift
sets `shift`), and under kitty `capslock scrolllock numlock printscreen pause menu f13–f35 kp0–kp9 kpdecimal … kpbegin
mediaplay … mutevolume leftshift … righthyper leftmeta rightmeta isoLevel3Shift isoLevel5Shift` (`:6-91, 166-258`).
`nonAlphanumericKeys = [...Object.values(keyName), 'backspace']` (`:92`) is what `useInput` blanks `input` for.

Legacy specifics: `'\r'` and `'\x1b\r'` → `return` (meta when 2 bytes) (`:414-419`); `'\n'` → **`enter`** (comment:
"enter, should have been called linefeed") (`:420-422`); `'\b'`/`'\x7f'` (and ESC-prefixed) → `backspace` (`:428-437`);
`'\x1b'`/`'\x1b\x1b'` → `escape` (`:438-442`); `0x01–0x1A` → ctrl+letter (`:447-451`); `ESC letter` → meta+letter,
`shift` if upper (`:465-470`); `fnKeyRe` handles `CSI 1;mods X` and `CSI n;mods ~` with xterm modifier bits
`ctrl = mods&4`, `meta = mods&10`, `shift = mods&1` (`:471-491`). Kitty: codepoint 13 → `return` **printable with text
`'\r'`**, 32 → `space` (`:303-310`), 1–26 → ctrl+letter (`:315-319`), modifiers `shift 1, alt 2, ctrl 4, super 8, hyper
16, meta 32, capsLock 64, numLock 128`, value is `mods − 1` (`kitty-keyboard.js:22-31`, `:285`), `meta = alt|meta`
(`:273`), `eventType` 1 press / 2 repeat / 3 release (`:262-268`).

Probe of `parseKeypress` + what `useInput` delivered end to end (`input`, true `key` fields):

| Keys / sequence | `useInput` result |
| --- | --- |
| Enter `\r` | `"\r"`, `return` |
| Ctrl+J `\n` | name `enter` → `input "\n"`, **no `key.return`** (no Key field for `enter`) |
| Alt/Option+Enter `ESC \r` | `"\r"`, `return meta` |
| kitty Shift+Enter `CSI 13;2u` | `"\r"`, `return shift eventType=press` |
| kitty Ctrl+Enter `CSI 13;5u` | `"\r"`, `return ctrl` |
| kitty Enter release `CSI 13;1:3u` | `return eventType=release` (must be ignored by the composer) |
| xterm modifyOtherKeys Shift+Enter `CSI 27;2;13~` | **`"[27;2;13~"`, no key flags** — inserted as text |
| Shift+Tab `CSI Z` | `""`, `tab shift` |
| Ctrl+Left `CSI 1;5D` / Alt+Left `CSI 1;3D` | `leftArrow ctrl` / `leftArrow meta` |
| Alt+b `ESC b` / Alt+f | `"b"` `meta` / `"f"` `meta` (composer must check `meta` before inserting) |
| Backspace `\x7f`, Ctrl+H `\x08` | both `backspace` (indistinguishable) |
| Delete `CSI 3~` | `delete` |
| Ctrl+C `\x03` and kitty `CSI 99;5u` | both `"c"`, `ctrl` (JevCode's check works in both modes) |
| Ctrl+D `\x04` | `"d"`, `ctrl` (no EOF semantics in raw mode) |
| Ctrl+/ `\x1f` | **`"\x1f"`, no flags** — a C0 byte delivered as text |
| Ctrl+Space `\x00` | name `` ` ``, `ctrl` |
| `é`, `日`, `👍`, `"ab"` | delivered verbatim as `input` |
| Focus-in/out `CSI I`/`CSI O`, CPR `CSI 24;80R`, kitty reply `CSI ?1u`, SGR mouse | **`"[I"`, `"[24;80R"`, …** as text (leading ESC stripped, `use-input.js:97-99`) |
| Bracketed paste, no `usePaste` | `"x\ny"` via `useInput` (`App.js:188-191`) |
| Bracketed paste, with `usePaste` | `usePaste("x\ny")` only; `useInput` silent |
| kitty Super+k `CSI 107;9u` | `"k"`, `super` |
| kitty CapsLock `CSI 57358u` | `""`, `eventType=press` (no `key` field for the lock key itself) |

`useInput` mapping rules (`use-input.js:39-113`): `key.*` booleans from `keypress.name`; `input` is the kitty `text`
for printable keys, the letter for kitty ctrl+letter, `''` for other kitty keys, `keypress.name` for legacy ctrl,
else the raw `sequence`; `''` for legacy `nonAlphanumericKeys`; a leading `ESC` is stripped from unresolved sequences;
a single upper-case char sets `shift`; the handler runs inside `reconciler.discreteUpdates` (sync priority — one frame
per keystroke, measured `framesPerKeyMax = 1`). `exitOnCtrlC` (default true, `render.js:14`) makes `App.handleInput`
exit on the raw byte `'\x03'` (`App.js:148-154`) and `useInput` swallow `ctrl+c` (`:104-106`); JevCode passes `false`.

Consequences for the composer: filter `input` before insertion — drop when `key.ctrl || key.meta || key.super ||
key.hyper`, drop `eventType === 'release' | 'repeat'`-only semantics as designed, drop any code unit `< 0x20` except
`\t` and the newline keys, drop `0x7F`, and drop strings that start with `[` and look like a CSI body when they arrive
without a printable prefix (defence against focus/CPR/mouse leak-through). Never log `input`.

### 2.4 `usePaste` and bracketed paste

`usePaste(handler, {isActive})` enables raw mode **and** `setBracketedPasteMode(true)` → `ESC[?2004h` on a TTY stdout,
refcounted, `ESC[?2004l` when the last consumer leaves (`hooks/use-paste.js:29-60`, `App.js:257-274`). Probe: without
`usePaste` Ink never writes `?2004h` and paste text goes to `useInput`; with it, `?2004h` at mount and `?2004l` at exit.
Readme: "`usePaste` and `useInput` can be used together in the same component. They operate on separate event channels,
so paste content is never forwarded to `useInput` handlers when `usePaste` is active." (`readme.md:1850`). Suspension
turns it off/on around the child (`App.js:282-315`). Paste content is raw: it may contain `\r\n`, tabs, `ESC` sequences
from a terminal that does not bracket well, or megabytes — normalise (`\r\n`→`\n`, strip C0/ESC except `\n\t`) and
collapse large pastes to a placeholder the way Claude Code does ("When you paste more than 800 characters or more than
three lines into the prompt, Claude Code collapses the input to a placeholder such as `[Pasted text #1 +120 lines]`",
https://code.claude.com/docs/en/terminal-config, fetched 2026-09-20).

### 2.5 kitty keyboard protocol

Option: `kittyKeyboard?: { mode?: 'auto' | 'enabled' | 'disabled'; flags?: KittyFlagName[] }`, flags
`disambiguateEscapeCodes 1, reportEventTypes 2, reportAlternateKeys 4, reportAllKeysAsEscapeCodes 8,
reportAssociatedText 16` (`kitty-keyboard.d.ts:1-23`, `kitty-keyboard.js:3-9`). Not specified → nothing happens
(`ink.js:800-803`). Default flags `['disambiguateEscapeCodes']` (`:809`). `'enabled'` pushes when stdin **and** stdout
are TTYs even in CI (`:812-817`). `'auto'` requires interactive + both TTYs (`:819-823`), then **only** sends the query
`ESC[?u` and waits up to `setTimeout(cleanup, 200)` for a `CSI ? digits u` reply (`:830-864`; matcher `:35-82`); the
code comment says "This avoids maintaining a hardcoded whitelist of terminal names" — the installed readme's claim of
"a heuristic precheck (known terminals like kitty, WezTerm, Ghostty)" (`readme.md:2768`) is **stale relative to the
code**. Non-reply bytes buffered during detection are `stdin.unshift`ed back (`:840-844`). Push is `ESC[>{flags}u`
(`:866`), pop `ESC[<u` at unmount (`:540`) and around suspension (`:892, 930-932`). `Key` gains `super hyper capsLock
numLock` and `eventType?: 'press' | 'repeat' | 'release'` (`use-input.d.ts:69-98`).

Spec (https://sw.kovidgoyal.net/kitty/keyboard-protocol/, fetched 2026-09-20): query `CSI ? u` → reply `CSI ? flags u`;
push `CSI > flags u`, pop `CSI < number u`; "the modifier value is `1 + actual modifiers`"; event types press 1, repeat 2,
release 3; with only the disambiguate flag, Enter, Tab and Backspace "retain their traditional byte values unless the
'report all keys as escape codes' flag is set" — so **plain** Enter stays `\r` and only *modified* Enter becomes
`CSI 13;mods u`, exactly what the composer wants. Readme behaviour notes: "`Shift+Enter` vs `Enter` - the shift modifier
is correctly reported", "`Ctrl+I` vs `Tab`", "`Escape` key vs `Ctrl+[`" (`readme.md:2789-2800`).

Terminal reality (https://code.claude.com/docs/en/terminal-config, fetched 2026-09-20): Shift+Enter "Works without
setup" in "Ghostty, Kitty, iTerm2, WezTerm, Warp, Apple Terminal, Windows Terminal" and in "Other terminals that support
the kitty keyboard protocol, such as foot and Alacritty 0.16 or later"; VS Code/Cursor/Zed need `/terminal-setup`
(which "writes a Shift+Enter keybinding into the terminal's configuration file", VS Code binding sends `\u001b[13;2u`);
gnome-terminal and JetBrains: "Not available; use Ctrl+J or `\` then Enter"; tmux needs `set -s extended-keys on` and
`set -as terminal-features 'xterm*:extkeys'`; macOS Option-as-Meta must be enabled for Option+Enter. opencode ships
`"input_newline": "shift+return,ctrl+return,alt+return,ctrl+j"`, `"input_submit": "return"`, leader `ctrl+x`,
`"app_exit": "ctrl+c,ctrl+d,<leader>q"`, `"session_interrupt": "escape"` (https://opencode.ai/docs/keybinds/, fetched
2026-09-20). xterm's `modifyOtherKeys` (`CSI 27;mod;key~`, or `CSI key;mod u` with `formatOtherKeys`, enabled by
`CSI > 4;2 m`) is documented at https://invisible-island.net/xterm/modified-keys.html (fetched 2026-09-20); Ink never
enables it and does not parse the `27;…~` form, so a user-configured terminal sending it leaks text (table above).

### 2.6 `useFocus` / `useFocusManager` (and why the composer should avoid them)

`App.js:368-385`: whenever at least one focusable is registered, `Tab` (`'\t'`) and `Shift+Tab` (`ESC[Z`) move focus —
and the same bytes are **still delivered** to every `useInput` handler (both are listeners on `internal_eventEmitter`),
and `Escape` clears the active focus (`:156-158`). Probe with `useFocus({autoFocus: true})` mounted: `useInput` received
`tab`, `tab shift`, `escape` normally. A composer that uses Tab for slash-command completion and Escape for "stop
generation" should not register focusables, or call `useFocusManager().disableFocus()`; `focus(id)`, `focusNext/Previous`,
`activeId` exist for a keyboard-driven review dialog (`hooks/use-focus-manager.d.ts`).

---

## 3. Real cursor placement and IME (`useCursor`)

`useCursor()` returns `{ setCursorPosition(position | undefined) }`; the position is stored in a ref during render and
pushed to Ink in a `useInsertionEffect` **with no dependency array** (runs every render, and its cleanup hides the
cursor on unmount) (`hooks/use-cursor.js:10-27`). `Ink.setCursorPosition` → `log.setCursorPosition` marks
`cursorDirty` (`ink.js:306-309`, `log-update.js:97-100`); a frame is emitted even if the text is unchanged
(`ink.js:791`). After writing the frame log-update appends `cursorUp(visibleLineCount − y) + cursorTo(x) + ESC[?25h`
(`cursor-helpers.js:13-21`); before the next erase it hides the cursor and moves back to the bottom (`:26-34, 49-55`).
Coordinates: `x` column 0-based, `y` "Row position from the top of the Ink output (0 = first line)" — the **dynamic**
frame, not the terminal (`readme.md:2476-2497`). The cursor is hidden by default (`log-update.js:21-24`) and shown only
via this suffix, so with `useCursor` the terminal cursor sits exactly in the composer and the terminal's IME preedit
(CJK, dead keys, emoji picker) appears there — readme: "This is essential for IME (Input Method Editor) support, where
the composing character is displayed at the cursor location" (`readme.md:2450`). The readme example computes `x`
with `string-width` ("Use `string-width` to calculate `x` for strings containing wide characters (CJK, emoji)",
`readme.md:2484`); Ink's `examples/cursor-ime/cursor-ime.tsx` at v7.1.1 does the same
(https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/examples/cursor-ime/cursor-ime.tsx, fetched 2026-09-20,
summarised by the tool — **wording UNVERIFIED**). JevCode cannot import `string-width`; §9 gives the minimal width
function. Because `cursorTo(x)` is absolute, `x` must match the **terminal's** width table, not Ink's — mismatches show
as a cursor one cell off for exotic clusters until the next keystroke; harmless but note it.

---

## 4. Layout and text facts that shape the composer and transcript

- **No scrolling.** `overflow | overflowX | overflowY: 'visible' | 'hidden'` only (`styles.d.ts:277-293`); `hidden` emits
  a clip rectangle (`render-node-to-output.js:105-130`, `output.js:60-70, 98-136`). Scroll = slice the data yourself.
- **Text wrap modes**: `'wrap' | 'hard' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start'`
  (`styles.d.ts:6`); `wrap` = `wrapAnsi(text, w, {trim:false, hard:true})`, `hard` adds `wordWrap:false`, truncate
  variants use `cliTruncate` with position (`wrap-text.js:4-36`). Wrapping happens **twice**: in Yoga's measure function
  (`dom.js:91-106`) and at render when `widestLine(text) > getMaxWidth(yogaNode)` (`render-node-to-output.js:90-103`),
  both cached by full text. Pre-wrapped rows rendered with `wrap="truncate"` skip both when they fit.
- **Output** builds a cell grid, writes styled chars, gives wide chars a trailing `''` placeholder cell and repairs
  half-overwritten wide chars (`output.js:154-190`), then `trimEnd()`s every line (`:195-201`) — trailing spaces vanish,
  but a styled (inverse) space survives because the SGR reset follows it.
- `<Text>` maps props to chalk (`Text.js:16-44`) and sets `textWrap` (`:48`); `<Transform transform(line, index)>`
  post-processes each output line (`Transform.js:6-14`, applied in `output.js:144-146`); `squashTextNodes` runs
  `sanitizeAnsi` on the concatenated text (`squash-text-nodes.js:33`).
- `useBoxMetrics(ref)` → `{width, height, left, top, hasMeasured}` updated after every render and on root layout
  commits (`hooks/use-box-metrics.js:45-79`; `.d.ts:8-31` has **no** `clientWidth` — the GitHub master readme's mention
  of `clientWidth/clientHeight` is newer than 7.1.1, https://raw.githubusercontent.com/vadimdemedes/ink/master/readme.md
  fetched 2026-09-20). `measureElement(node)` → `{x, y, width, height}` in layout-tree coordinates; returns zeros during
  render (`measure-element.js:9-30`). Useful to size the composer's viewport rows from the actual box height.
- **Screen-reader mode** (`isScreenReaderEnabled` or `INK_SCREEN_READER=true`, `ink.js:185-187`): unthrottled; output is
  a text tree (rows joined by `' '`, columns by `'\n'`, `aria-role`/`aria-state` prefixes like `(checked) checkbox: …`)
  with no Yoga positions and **no clipping** (`render-node-to-output.js:24-69`); static output is erased-then-written
  above, the frame is `wrapAnsi`-hard-wrapped and replaced with `eraseLines(lastOutputHeight)`, never `clearTerminal`
  (`ink.js:371-414`). `<Box aria-hidden>` renders nothing; `aria-label` replaces children (`Box.js:9-25`,
  `Text.js:12, 45-47`). For JevCode: composer `aria-role="textbox" aria-state={{multiline: true}}`, decisions
  `aria-role="list"`/`"listitem"`, spinner `aria-hidden`.

---

## 5. `suspendTerminal()` — `$EDITOR` and `!` shell passthrough

Type: `(callback) => Promise<void>` or `() => Promise<TerminalSuspension>` with `resume()` and `Symbol.asyncDispose`
(`components/AppContext.d.ts:7-18`). `beginSuspend` (`ink.js:872-912`): flush pending render/log, `log.clear()` (erase
the dynamic region), `log.done()` (show cursor), `ESC[<u` if kitty, exit alt screen, then `pauseInput()` → raw mode off,
`stdin.unref()`, parser reset, `ESC[?2004l` (`App.js:282-300`). While suspended, `onRender` and `writeToStdout/Stderr`
return early (`ink.js:336-342, 440-442, 467-469`). `endSuspend` (`:913-948`): `resumeInput()` (raw on, `ref()`,
`'readable'` re-attached, `?2004h`), re-enter alt screen, re-push the **same** kitty flags, reset `lastOutput`/
`log.reset()`, full re-render and `waitUntilRenderFlush`. Readme: "restores the terminal modes the child expects (raw
mode off, cursor visible, bracketed paste off, alternate screen exited, kitty keyboard protocol off)" and "Suspending
while a suspension is already active throws" (`readme.md:1963-2000`).

Real-pty probe (child `sh -c 'echo CHILD-OUTPUT-LINE'` with `stdio: 'inherit'`, two `<Static>` appends inside the
callback, one after): pty bytes were
`…item-0\r\n ESC[?25l live 1\r\n … ESC[2K ESC[1A ESC[2K ESC[G ESC[?25h CHILD-OUTPUT-LINE\r\n ESC[?2026h ESC[?25l live 3\r\n
… item-3-after-resume\r\n live 4\r\n …`; **`item-1`/`item-2` never appeared**, `live 3` did, zero `ESC[2J`, and keys
typed after resume arrived normally (`a`, `b`, `\r`). The child's output stays in scrollback above the redrawn frame —
exactly the `!cmd` UX wanted — but transcript items must be queued during suspension and appended after `resume()`.
Raw mode is off during the child (`process.stdin.isRaw === false` logged), so Ctrl-C reaches the child as SIGINT.
Ctrl-Z: in raw mode `\x1a` arrives as `ctrl+z`, no SIGTSTP; implement as `suspendTerminal()` → `process.kill(process.pid,
'SIGTSTP')` → `resume()` on `SIGCONT`, or ignore.

---

## 6. `waitUntilRenderFlush`, `onRender`, `patchConsole`, `exitOnCtrlC`

- `waitUntilRenderFlush()`: yields a macrotask, in concurrent mode awaits the next commit, `flushSyncWork()`, flushes both
  throttles, then awaits `stdout.write('', cb)` as a barrier (`ink.js:617-654`); readme: `onRender` "does not wait for
  `stdout`/`stderr` stream callbacks" (`readme.md:2644`) — JevCode's `--perf-exit-after-first-frame` already awaits
  the flush, which is the right gate.
- `patchConsole` default true routes `console.*` through `log.clear()` + write + `restoreLastOutput()` inside `BSU/ESU`
  (`ink.js:663-678, 433-489`); JevCode uses `false`, so any stray `console.log` in a dependency corrupts the frame — keep
  the redirect of `console` to the run log in `main.tsx` instead. `useStdout().write(data)` is the sanctioned way to
  emit arbitrary text above the frame (same path, `App.js:505-508`); `data` must end in `'\n'`.
- `exitOnCtrlC` — see §2.3: under kitty Ctrl+C is `CSI 99;5u`, which `App.handleInput` (`input === '\x03'`) would not
  recognise; JevCode's `key.ctrl && input === 'c'` check must stay the single Ctrl-C handler.

---

## 7. Survey: `ink-text-input` and `@inkjs/ui` on npm

| Package | latest | published | `modified` | deps | peer | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ink-text-input` | 6.0.0 | 2024-05-14 | 2024-05-21 | `chalk ^5.3.0`, `type-fest ^4.18.2` | `ink >=5`, `react >=18` | 23 versions since 2017-07-09 |
| `@inkjs/ui` | 2.0.0 | 2024-05-22 | 2024-05-22 | `chalk ^5.3.0`, `cli-spinners ^3.0.0`, `deepmerge ^4.3.1`, `figures ^6.1.0` | `ink >=5` | 3 versions since 2023-05-07 |

Sources: https://registry.npmjs.org/ink-text-input and https://registry.npmjs.org/@inkjs/ui (fetched 2026-09-20).
Both are 28 months without a release and pre-date Ink 7's `usePaste`/`useCursor`/kitty support. Source review (tool
summaries, **not verbatim**): `ink-text-input` `source/index.tsx` on `master` — props `value onChange onSubmit
placeholder focus mask showCursor highlightPastedText`; cursor drawn with `chalk.inverse` on the char at a **string
index** `cursorOffset`; handles `leftArrow rightArrow backspace delete return`, ignores `upArrow downArrow tab ctrl+c`;
**no newline support, no `string-width`/`Intl.Segmenter`, no `useCursor`, no `usePaste`**; paste is guessed from
`input.length > 1` (https://raw.githubusercontent.com/vadimdemedes/ink-text-input/master/source/index.tsx, fetched
2026-09-20; the `main` branch URL returned 404). `@inkjs/ui` `use-text-input-state.ts`: reducer with `cursorOffset` as a
string index bounded by `state.value.length`, `moveCursorLeft/Right`, `delete`, prefix `suggestions`; single-line;
`use-text-input.ts` draws `chalk.inverse` at `cursorOffset`, filters up/down/ctrl+c/tab/shift+tab
(https://raw.githubusercontent.com/vadimdemedes/ink-ui/main/source/components/text-input/use-text-input-state.ts and
`use-text-input.ts`, fetched 2026-09-20). Neither is multi-line, grapheme-aware, wide-char-aware, IME-capable, or
dependency-clean. **Reject both; hand-roll.**

opencode (the reference UI the user named) does not use Ink at all: `@opencode-ai/tui@1.18.31` depends on
`@opentui/core`, `@opentui/keymap`, `@opentui/solid`, `solid-js`, `clipboardy`, `fuzzysort`
(https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json, fetched 2026-09-20); its
`packages/tui/src/prompt/` holds `display.ts frecency.tsx history.tsx part.ts stash.tsx traits.ts`
(https://github.com/anomalyco/opencode/tree/dev/packages/tui/src/prompt, fetched 2026-09-20). Its keybinding
*defaults* are only documented on the docs site (quoted §2.5); `keymap.tsx` contains the registry, not the defaults.
Lesson to borrow: multi-key newline set, frecency-ranked slash completion, a "stash" for interrupted drafts, and
prompt history as a first-class module.

---

## 8. Design: hand-rolled text buffer (`src/tui/composer/*`, ink+react only)

**Data model.** `TextBuffer = { text: string; cursor: number /* UTF-16 code-unit index, always on a grapheme boundary */;
anchor: number | null /* selection */; killRing: string[]; history: string[]; historyIdx: number | null }`. Keep the
cursor as a code-unit index for O(1) slicing; move it by **graphemes** using `Intl.Segmenter(undefined, {granularity:
'grapheme'})` (`segment(text)` then `containing(idx)`) — Node 22 built-in; measured 3,240 chars / 2,280 graphemes in
0.37 ms per full pass, so segmenting the current line per keystroke is free. Word motions (Alt+b/f, Alt+d, Ctrl+W)
use `granularity: 'word'` with `isWordLike`.

**Width (`cellWidth(cluster)`), re-implemented minimally to match Ink's `string-width@8.2.2` rules**
(`node_modules/string-width/index.js:5-14`): (1) cluster is zero-width if it matches
`/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`;
(2) `/^\p{RGI_Emoji}$/v` → 2 (verified the `v` flag works on Node 22: `👨‍👩‍👧` and `👍` both match); (3) keycap
`^[\d#*]⃣$` and ZWJ sequences with ≥ 2 `\p{Extended_Pictographic}` → 2; (4) modern Hangul L+V(+T) jamo → 2;
(5) otherwise East Asian Width of the first visible scalar with **ambiguous = narrow** (Ink's default
`ambiguousIsNarrow = true`) plus trailing spacing marks / Halfwidth-Fullwidth forms. EAW needs only the **Wide** and
**Fullwidth** ranges: `get-east-asian-width@1.7.0` has 125 Wide pairs and 3 Fullwidth pairs (`lookup-data.js`, first
pairs `0x1100–0x115f, 0x231a–0x231b, 0x2329–0x232a, …`), i.e. a 256-number sorted table with binary search — generate it
at build time from the devDependency into a checked-in `eaw-table.ts` with the Unicode version in a comment. Tab →
expand to spaces on insert (Ink ignores tabs in width: "Tabs are ignored by design", `string-width/index.js:8`).

**Layout.** `layout(buffer, cols): Row[]` where `Row = { start: number; end: number; hard: boolean; cells: number }`:
split on `\n` (hard rows), then soft-wrap each logical line by accumulated `cellWidth` at `cols − gutter`, never
splitting a grapheme, breaking after spaces when possible (mirror `wrapAnsi` `hard:true` semantics so what the user sees
matches what the transcript will show after submit — or simply commit the raw text and let `<Static>` wrap it).
Cursor → `(row, x)` by walking rows; `x` is the summed width of graphemes before the cursor on that row.

**Viewport.** The composer box is `height={composerRows}` (from the height budget; 1 row minimum when the budget is
tight, growing to `min(rows.length, MAX_COMPOSER_ROWS)`), `overflow="hidden"`, `flexDirection="column"`; keep
`scrollTop` so the cursor row is visible (`scrollTop = clamp(scrollTop, cursorRow − h + 1, cursorRow)`); render exactly
`h` `<Text wrap="truncate">` rows of pre-sliced text (never re-wrapped by Ink); prefix row 0 with the prompt glyph and
continuation rows with two spaces; show `↑N`/`↓N` overflow markers in the gutter. Call
`setCursorPosition({ x: gutter + cursorX, y: composerTop + cursorRow − scrollTop })` **during render** (matching
`use-cursor.js`'s insertion effect), `y` measured from the top of the dynamic frame (use a computed layout constant or
`measureElement` from an effect). Draw no inverse block; the real cursor is the cursor (blink, IME, screen readers).

**Key map** (all via one `useInput`; `usePaste` for paste; all handlers return early on `eventType === 'release'`):

| Action | keys (legacy → kitty) |
| --- | --- |
| submit | `key.return` with no modifiers (input `'\r'`); ignore if buffer empty; ignore repeat/release |
| newline | `key.return` with `key.shift` or `key.meta` or `key.ctrl` (kitty `13;2u`/`13;3u`/`13;5u`, legacy `ESC \r`), `input === '\n'` (Ctrl+J), and a trailing backslash + Enter |
| left/right by grapheme | `leftArrow`/`rightArrow` without ctrl/meta |
| word left/right | `leftArrow`/`rightArrow` with `ctrl` or `meta`; `meta` with `input` `b`/`f` |
| line start/end | `home`/`end`, `ctrl && input in {a,e}` |
| up/down | move by visual row; at first/last row: history prev/next when the buffer is single-line and unmodified |
| delete back/forward | `backspace` (also Ctrl+H, indistinguishable), `delete` |
| kill word back / forward | `ctrl && input==='w'`, `meta && input==='d'`; kill to end/start of line `ctrl+k` / `ctrl+u`; yank `ctrl+y` |
| clear draft | `escape` when buffer non-empty (else `escape` = steer/stop); Ctrl+C: clear draft if non-empty, else abort (JevCode's existing `human_abort`) — matches opencode's `input_clear: ctrl+c` |
| external editor | `ctrl+g` → `suspendTerminal(async () => spawn($EDITOR, [tmpfile], {stdio:'inherit'}))` |
| shell passthrough | leading `!` in an empty buffer switches the prompt glyph; Enter runs it under `suspendTerminal` |
| slash menu | leading `/` opens completion; `tab` accepts; no `useFocus` anywhere in the tree |
| insert | anything else with `!ctrl && !meta && !super && !hyper` after the C0/CSI filter of §2.3 |

**Paste** (`usePaste`): normalise `\r\n|\r` → `\n`, strip `[\x00-\x08\x0b-\x1f\x7f]` and `ESC`-sequences, insert at
cursor as one undo step; if `> 3` lines or `> 800` chars, insert `[Pasted #n, k lines]` and keep the body in a side
table submitted with the message (Claude Code's approach, source in §2.4). Also accept multi-char `useInput` chunks as
"paste-like" when the terminal lacks bracketed paste (probe: fast `ab` arrives as one call).

**Undo/redo**: coalesce consecutive single-grapheme inserts into one step; `ctrl+z`/`ctrl+_` undo — remember `\x1f` is
delivered as raw text (§2.3), so match `input === '\x1f'`.

**Testing**: pure functions (`layout`, `cellWidth`, `moveByGrapheme`, reducer) tested without Ink; integration via
`ink-testing-library` **with** a stdout that has `rows` (or a project fake) and `stdin.write('\x1b[13;2u')` etc.

---

## 9. Design: scrolling transcript on `<Static>`

- Committed items → `<Static key={sessionId} items={items}>`; never mutate items; append-only; batch resume replay
  (`--resume` with N items) as `header` in the first frame, then chunks of ≤ 200 items per commit via `setTimeout(0)`
  (500 wrapped items in one frame cost ~86 ms in-process; 5,000 unwrapped 183 ms). Keep each item's lines ≤ `columns`
  or pre-wrap them so `wrapText` is not invoked twice per item.
- "Scrolling" the transcript is the terminal's scrollback (Static) — do not build an in-app scroller (would require a
  fullscreen/alt-screen renderer and would fight the zero-clear gate). Provide `/transcript` to open the run's
  `transcript.log` in `$PAGER` via `suspendTerminal` instead (the child output stays in scrollback).
- The dynamic region = composer (1–6 rows) + decisions pane (shrinks first) + status + optional review dialog, all
  fixed-height `overflow="hidden"`, total ≤ `rows − 2` from `useWindowSize()` (replace the hand-rolled
  `useTerminalSize` in `App.tsx:90-103`; identical semantics, one fewer listener to maintain).
- During `suspendTerminal`, queue engine events that would append items; dispatch them after `resume()` (§5).
- A live streaming region keeps a short tail (already ≤ 2 rows, truncated), which also bounds the unique-string cache
  growth (§1.4) to ~1 KB per flush; at 20 fps for an 8-hour session that is ≈ 0.5 GB **only if every frame's text is
  unique** — realistic flushes repeat text often; still, prefer `Math.floor`-bucketed counters (`streaming… 1.2k chars`)
  over exact counts to cut unique strings.

---

## 10. Packaging notes (only what this topic touches)

- Keep `--define:process.env.NODE_ENV='"production"'` (already in `scripts/build.mjs:29`); additionally run vitest and
  `npm run dev` with `NODE_ENV=production` when measuring, or accept the dev-only `PerformanceMeasure` growth.
- Bundling with `--packages=external` (as the benchmark did) is **not** what JevCode does — JevCode inlines ink and react
  into `dist/jevcode.mjs`; the React build selection therefore happens at bundle time via `define`, which is correct.
- Key logging (`App.tsx:125-126`) and test-stdout `rows` are covered in ADOPT A15/A10.

---

## 11. Microbenchmark results

Harness: `/tmp/ink-bench/bench.mjs` (500-line `<Static>` transcript + bordered 6-row composer bound to `useInput`,
`maxFps: 1000` so the throttle does not hide costs, fake TTY streams with exact `columns/rows`, bytes and
`ESC[2J`/`ESC[2K` counted per write; 60 keystrokes then a 3-line bracketed paste; production React unless noted),
`bench2.mjs` (dynamic region grown to the budget / over it, `<Static>` appends), `bench3.mjs` (first frame vs items).
Wall = `stdin.write` → `waitUntilRenderFlush` resolved. Fake streams have no real terminal write cost; a real-pty run of
the same structure (§5) showed identical sequences and zero clears.

**Per keystroke, dynamic region 6 rows (production React):**

| geometry | mode | wall p50 / p95 (ms) | `onRender` renderTime p50 (ms) | bytes / key | `ESC[2K` / frame | paste 3 lines (bytes) |
| --- | --- | --- | --- | --- | --- | --- |
| 24×80 | standard | 0.30 / 0.65 | 0.19 | **893** | 7 | 893 |
| 24×80 | incremental | 0.31 / 0.51 | 0.19 | **127** | 0 | 216 |
| 50×200 | standard | 0.46 / 0.71 | 0.34 | **2,093** | 7 | 2,093 |
| 50×200 | incremental | 0.45 / 1.08 | 0.34 | **247** | 0 | 456 |

Frames per keystroke: exactly 1 in every run. First frame (in-process, after imports) 65–86 ms with the 500 wrapped
lines; `ESC[2J` after the first frame: 0 in all in-budget runs. Dev-build React numbers were within noise (wall p50
0.46 ms) except memory (§1.4).

**Dynamic region grown to the `rows − 2` budget (production):**

| geometry | dyn rows | mode | bytes / key | renderTime p50 (ms) | `ESC[2K` |
| --- | --- | --- | --- | --- | --- |
| 24×80 | 22 | standard | 1,436 | 0.97 | 23 |
| 24×80 | 22 | incremental | 176 | 0.90 | 0 |
| 50×200 | 48 | standard | 3,542 | 3.18 | 49 |
| 50×200 | 48 | incremental | 374 | 2.47 | 0 |

**`<Static>` append (one transcript line) with the region at 6 / budget rows:** 24×80: 963 / 1,506 B; 50×200: 2,163 /
3,612 B; identical for both log-update modes; `ESC[2K` = dyn rows + 1 in both modes (the `log.clear()` path).

**Overflow (24×80, dynamic region 28 rows, i.e. 4 over):** keystroke **29,765 B and 1 × `ESC[2J` per frame**
(renderTime 0.79 ms); `<Static>` append **62,330 B and ~2 × `ESC[2J`** per append. This is the Qwen Code #1778 / Ink
#450 flicker path already cited in DESIGN.md §10, now with numbers.

**First frame vs `<Static>` size (120 cols, unwrapped 75-char lines, production):** 0 → 6.6 ms · 100 → 10.2 · 500 →
26.8 · 2,000 → 94.3 · 5,000 → 182.8 ms; bytes 46 → 308 KB.

**Other measurements:** Escape flush latency 21.3 ms; `Intl.Segmenter` 0.37 ms per 3,240-char pass; `getWindowSize`
without `rows` 2.34 ms/call; heap growth table in §1.4.

---

## 12. ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | Hand-roll `TextBuffer` + `layout` + `cellWidth` (ink+react only), cursor by grapheme via `Intl.Segmenter`, EAW table generated from `get-east-asian-width` at build time, RGI-emoji via `\p{RGI_Emoji}` `v`-flag | Both npm inputs are single-line, string-index, `chalk`-dependent, 28 months stale; Node 22 has the primitives | §7, §8; `string-width/index.js:5-14`; npm registry JSON (2026-09-20) |
| A2 | `useCursor` to place the real cursor in the composer; compute `x` with the same `cellWidth`; no inverse-block cursor | IME preedit lands in the composer; cursor-only frames are cheap | `use-cursor.js:10-27`, `cursor-helpers.js:13-21`, `readme.md:2447-2497` |
| A3 | `usePaste` + normalisation + large-paste placeholder; also treat multi-char `useInput` chunks as paste-like | Separate channel, bracketed paste auto-managed; raw content may carry `\r\n`/ESC | `use-paste.js:29-60`, `App.js:188-191, 257-274`; Claude Code terminal-config (2026-09-20) |
| A4 | `render({ kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] } })` and newline on `return` with shift or meta or ctrl, `input === '\n'` (Ctrl+J), trailing backslash + Enter | Only kitty distinguishes Shift+Enter; the fallbacks match Claude Code/opencode; `auto` is one 200 ms query, no whitelist | `ink.js:799-871`; kitty spec; probe table §2.3; opencode keybinds docs |
| A5 | Filter `input` before insertion (ctrl/meta/super/hyper, `release`, C0 except `\n\t`, `0x7F`, CSI-body leak-through) | `\x1f`, `[I`, `[24;80R`, `[27;2;13~` arrive as text | probe §2.3, `use-input.js:82-99` |
| A6 | `incrementalRendering: true` behind a `--render-mode` flag defaulting to on, with `standard` as the escape hatch | 7–8× fewer bytes per keystroke, zero `ESC[2K`; same render time; fallback if a terminal desyncs | §1.2, §11 |
| A7 | Keep the `rows − 2` budget; composer 1–6 rows inside it; decisions pane shrinks first | 893 B vs 29,765 B + `ESC[2J` per keystroke | `ink.js:89-112, 748-798`, §11 |
| A8 | `<Static key={sessionId}>`; queue transcript items during `suspendTerminal`; batch `--resume` replay after the first frame | Replaced arrays render nothing; items during suspension are dropped; 5,000 items cost 183 ms | `Static.js:9-27`, `reconciler.js:98-105`, §5 pty probe, §11 |
| A9 | `!cmd` and `$EDITOR` via `suspendTerminal(async () => spawn(..., {stdio:'inherit'}))`; `/transcript` opens `$PAGER` the same way | Restores raw/cursor/paste/kitty/alt-screen and redraws; child output stays in scrollback | `ink.js:683-698, 872-948`, `App.js:282-315`, §5 |
| A10 | Replace `useTerminalSize` with `useWindowSize`; test fakes get `rows` | Same semantics; avoids `terminal-size` `/dev/tty` open at 2.34 ms/layout | `use-window-size.js:7-20`, `utils.js:7-18`, `terminal-size/index.js:68-112` |
| A11 | `maxFps: 60` for the interactive TUI (composer + 20 fps live coalescer stay well under) | Default 34 ms throttle is the worst-case keystroke latency; frames cost 0.2–0.4 ms | `ink.js:194-214`, §11 |
| A12 | Keep `exitOnCtrlC: false`, `patchConsole: false`; single Ctrl-C handler `key.ctrl && input === 'c'` (clear draft if non-empty, else abort) | Works for `\x03` and kitty `CSI 99;5u`; App-level check only sees `\x03` | `App.js:148-154`, `use-input.js:72-77, 104-106`, probe |
| A13 | No `useFocus` in the composer tree (or `disableFocus()`); Tab = completion, Escape = steer/stop | Tab/Shift+Tab/Escape are also consumed by the focus manager when any focusable exists | `App.js:156-158, 368-385`, probe §2.6 |
| A14 | ARIA: `aria-role="textbox"` + `aria-state={{multiline:true}}` on the composer, `list`/`listitem` on decisions, `aria-hidden` on spinners | Screen-reader renderer is a text tree with role/state prefixes and no clipping | `render-node-to-output.js:24-69`, `ink.js:371-414`, `readme.md:3005-3044` |
| A15 | Remove/redact `App.tsx:125-126` key logging; bucket live counters to reduce unique strings | Keys must never appear in logs; unique frame strings cost ~1 KB each forever | `App.tsx:125-126`, `measure-text.js:2`, `wrap-text.js:3`, §1.4 |
| A16 | Run vitest/perf with `NODE_ENV=production` (dist already does) | Dev React leaks `PerformanceMeasure`s at 3.4–7 KB/frame | `react-reconciler/index.js`, `scripts/build.mjs:29`, §1.4 |

## 13. REJECT

| # | Do not | Why |
| --- | --- | --- |
| R1 | `ink-text-input`, `@inkjs/ui` (or vendoring them) | Single-line, string-index cursor, no wide chars/IME/paste hook, pull `chalk`; stale since May 2024 (§7) |
| R2 | `alternateScreen: true` / an in-app scrolling transcript | Kills scrollback, `<Static>` becomes pointless, and any in-app scroller needs fullscreen frames that trip the clear predicate (`ink.js:89-112, 699-705`) |
| R3 | Relying on `key.return` for Ctrl+J or on `input === '\r'` alone for Shift+Enter | `\n` maps to name `enter` with no `Key` field; legacy Shift+Enter is byte-identical to Enter (§2.3) |
| R4 | Parsing `CSI 27;2;13~` ourselves by enabling `modifyOtherKeys` (`CSI > 4;2 m`) | Ink's parser has no branch for it; the sequence leaks as text; kitty `auto` covers the same terminals |
| R5 | `useFocus`/Tab navigation inside the composer | Focus manager eats Tab/Shift+Tab/Escape semantics (§2.6) |
| R6 | An inverse-video fake cursor | Breaks IME, blink, and screen readers; `useCursor` exists and costs a few bytes per frame |
| R7 | Rendering the whole transcript as dynamic `<Box>` rows or letting the composer grow unbounded | Anything ≥ `rows` rows triggers `clearTerminal + fullStaticOutput` replay every frame (29.7 KB / 62 KB measured) |
| R8 | `useStdout().write` for transcript items instead of `<Static>` (tempting: no React render per item) | Loses Ink's width measurement/wrapping and the clear-path replay; keep `<Static>`, pre-wrap if cost matters |
| R9 | Committing transcript items while suspended | Silently dropped (§5) |
| R10 | `exitOnCtrlC: true` | Would swallow Ctrl-C from `useInput` and misses kitty `CSI 99;5u` |
| R11 | Depending on `terminal-size` fallback (0 rows/cols) anywhere hot | `/dev/tty` open or `tput` exec per layout call |
| R12 | Trusting the installed readme's "heuristic precheck" for kitty auto | Code sends only `ESC[?u` with a 200 ms timeout (`ink.js:824-864`) |

## 14. OPEN QUESTIONS

1. **Terminal-side width vs our table.** `cursorTo(x)` is absolute; when the terminal's wcwidth disagrees with the
   hand-rolled table (new emoji, ambiguous-width in CJK locales), the cursor lands one cell off. Offer
   `--ambiguous-wide`? Probe the terminal once with CPR (`ESC[6n`) after printing a test cluster? (CPR replies would
   need to be intercepted before `useInput`, cf. `ink.js:830-864` for the pattern.)
2. **incrementalRendering desync in the wild.** Which terminals wrap at the last column despite `trimEnd()`ed rows
   (Windows console per `ink.js:88` comment; ConPTY?). Needs a soak test on Windows Terminal, tmux, and VS Code.
3. **Suspension race**: engine events arriving while suspended are dispatched to React (state updates happen) — we
   verified `live 3` rendered after resume — but the event queue for `<Static>` must be ours. Should the engine be
   paused (backpressure) during `!cmd` rather than buffering?
4. **Kitty `reportEventTypes`**: worth requesting to ignore `repeat` for Enter (avoid double submit on held key), at the
   cost of every handler needing the `release` filter? Default stays `disambiguateEscapeCodes` only.
5. **Static cache growth**: `fullStaticOutput` (`ink.js:416`) and the `measureText` Map grow with the transcript for the
   process lifetime; for multi-hour sessions with thousands of items, is a periodic `key`-remount (which resets
   `fullStaticOutput`, not the Map) acceptable, or do we cap session length per process?
6. **Upstream**: file Ink issues for (a) `<Static>` items lost during `suspendTerminal`, (b) stale kitty readme text,
   (c) unparsed `CSI 27;m;k~`, (d) unbounded `measureText`/`wrapText` caches — or carry patches? JevCode's one-package
   rule forbids a fork dependency, so behavioural workarounds are the only option today.
7. **Ink 7.1.0/7.0.0 release bodies** and `useBoxMetrics.clientWidth` on master could not be fetched verbatim (GitHub
   API 403, release page partially failed); re-check before pinning any newer Ink.
