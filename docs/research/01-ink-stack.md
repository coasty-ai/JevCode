# 01 — Ink terminal-UI stack for Node (research notes)

Research date: **2026-09-19**. All facts below carry their source URL and fetch date. Items marked **UNVERIFIED** could not be confirmed from a primary source; what was tried is noted. Empirical numbers were measured locally on macOS (Darwin 25.6.0), Node v22.23.2, in a scratch dir (`/tmp/inkbench`) with `ink@7.1.1 react@19.3.0 ink-testing-library@4.0.0` installed from npm on 2026-09-19.

## 1. Ink: current version, peers, engines, deps

Source: https://registry.npmjs.org/ink/latest (fetched 2026-09-19) and https://registry.npmjs.org/ink (time field, fetched 2026-09-19).

| Field | Value |
|---|---|
| `version` (dist-tag `latest`) | **`7.1.1`** (published `2026-07-16T13:07:31.525Z`) |
| `type` | `"module"` (ESM package) |
| `exports` | `{"types": "./build/index.d.ts", "default": "./build/index.js"}` — a single ESM entry, no `require` condition |
| `engines.node` | **`>=22`** |
| `peerDependencies.react` | **`>=19.2.0`** |
| `peerDependencies.@types/react` | `>=19.2.0` (optional per `peerDependenciesMeta`) |
| `peerDependencies.react-devtools-core` | `>=6.1.2` (optional) |
| dist-tags | `{"next":"3.0.0-7","latest":"7.1.1"}` (the `next` tag is stale) |
| repository | `git+https://github.com/vadimdemedes/ink.git` |

`dependencies` of ink@7.1.1 (same source): `@alcalzone/ansi-tokenize ^0.3.0`, `ansi-escapes ^7.3.0`, `ansi-styles ^6.2.3`, `auto-bind ^5.0.1`, `chalk ^5.6.2`, `cli-boxes ^4.0.1`, `cli-cursor ^4.0.0`, `cli-truncate ^6.0.0`, `code-excerpt ^4.0.0`, `es-toolkit ^1.45.1`, `indent-string ^5.0.0`, `is-in-ci ^2.0.0`, `patch-console ^2.0.0`, `react-reconciler ^0.33.0`, `scheduler ^0.27.0`, `signal-exit ^3.0.7`, `slice-ansi ^9.0.0`, `stack-utils ^2.0.6`, `string-width ^8.2.0`, `terminal-size ^4.0.1`, `type-fest ^5.5.0`, `widest-line ^6.0.0`, `wrap-ansi ^10.0.0`, `ws ^8.20.0`, **`yoga-layout ~3.2.1`**.

Installed tree check (local `npm install`, re-verified 2026-09-19 with `npm ls yoga-layout react-reconciler`): `yoga-layout 3.2.1` (npm `latest`, published 2024-12-13), `react-reconciler 0.33.0` (published 2025-10-01); `node_modules` for ink+react+ink-testing-library = 23 MB (`du -sh`). Note: `react-reconciler` `latest` is now **0.34.0** (2026-09-09, peer `react ^19.3.0`), which is outside Ink's `^0.33.0` range, so Ink 7.1.1 keeps resolving 0.33.0 (https://registry.npmjs.org/react-reconciler, fetched 2026-09-19).

### Ink release timeline and breaking changes

Source: https://github.com/vadimdemedes/ink/releases and the per-tag release pages (fetched 2026-09-19; api.github.com was rate-limited on re-check) and npm `time` field at https://registry.npmjs.org/ink (fetched 2026-09-19). Dates below are npm publish dates (UTC).

| Version | Published | Notes |
|---|---|---|
| 5.0.0 | 2024-05-11 | (last 5.x = 5.2.1, 2025-04-29) |
| **6.0.0** | 2025-05-29 | Breaking: "Require Node.js 20", "Require React 19 (#719)" (https://github.com/vadimdemedes/ink/releases/tag/v6.0.0, fetched 2026-09-19) |
| 6.8.0 | 2026-02-19 | last 6.x |
| **7.0.0** | 2026-04-08 | see below |
| 7.1.0 | 2026-06-17 | "Add `suspendTerminal()` to hand the terminal to a child process (#972)" (https://github.com/vadimdemedes/ink/releases/tag/v7.1.0) |
| **7.1.1** | 2026-07-16 | "Fix: Preserve last `<Static>` line erased after a full-clear frame (#974)"; "Make `measureElement()` also return position coordinates (#968)" (https://github.com/vadimdemedes/ink/releases/tag/v7.1.1) |

**Ink 7.0.0 breaking changes** (quoted from https://github.com/vadimdemedes/ink/releases/tag/v7.0.0, fetched 2026-09-19):
- "Require Node.js 22"
- "Require React 19.2+ — Ink now uses `useEffectEvent` internally to avoid re-subscribing input handlers on every render"
- "Pressing Backspace now correctly sets `key.backspace` instead of `key.delete` (#634)" — "If you were checking `key.delete` to handle backspace, switch to `key.backspace`"
- "`key.meta` is no longer set to `true` when Escape is pressed" — "Now only `key.escape` is `true`."

New in 7.0.0 (same source): `usePaste` (bracketed paste, "pasted text arrives as a single string"), `useWindowSize` (`{columns, rows}`), `useBoxMetrics`, `useAnimation`, `render()` options `alternateScreen` and `interactive`, `useFocusManager().activeId`, `<Box>` `borderBackgroundColor`/`maxWidth`/`maxHeight`/`aspectRatio`/`alignContent`/`position="static"`/`top|right|bottom|left`, `<Text wrap="hard">`, kitty keyboard: in `mode: 'auto'` Ink now queries all terminals instead of a hardcoded allowlist (release note "Query all terminals in auto mode instead of hardcoded allowlist"). Note the protocol is still opt-in — see the `kittyKeyboard` row in section 3. 7.0.1 fixed "Restore `useApp` exit typing" and "Respect `disableFocus()` when handling Escape (#937)"; 7.0.2 "Defer raw mode disable to prevent process hang on component swap"; 7.0.3–7.0.6 (2026-05-13 … 2026-06-12) are further patch releases not itemised here (https://github.com/vadimdemedes/ink/releases, fetched 2026-09-19).

ESM-only: confirmed empirically — `require("ink")` on Node 22.23.2 fails with `ERR_REQUIRE_ASYNC_MODULE: require() cannot be used on an ESM graph with top-level await` (re-run 2026-09-19; the TLA is `const Yoga = wrapAssembly(await loadYoga());` in `node_modules/yoga-layout/dist/src/index.js` line 13). Use `import`.

## 2. Companion package versions

Sources: `https://registry.npmjs.org/<pkg>/latest` and `/<pkg>` (time field), all fetched 2026-09-19.

| Package | `latest` | Published | `engines.node` | peerDependencies | Supports Ink 7? |
|---|---|---|---|---|---|
| `react` | **19.3.0** | 2026-09-09T17:21Z | `>=0.10.0` | — | yes (Ink needs >=19.2.0; 19.2.0 was 2025-10-01) |
| `@types/react` | **19.3.0** | 2026-09-09T18:08Z | — | — (`dependencies: csstype ^3.2.2`) | yes |
| `ink-testing-library` | **4.0.0** | 2024-05-22 | `>=18` | `@types/react >=18.0.0` (optional); **no `ink` peer** | **Works empirically** (see section 6); dev-tested upstream only against `ink ^5.0.0`/`react ^18.3.1` (https://raw.githubusercontent.com/vadimdemedes/ink-testing-library/master/package.json, fetched 2026-09-19). Last commit on `master` is 2024-05-22 ("4.0.0", "Fix CI"; https://github.com/vadimdemedes/ink-testing-library/commits/master, fetched 2026-09-19); repo page shows 7 open issues. UNVERIFIED: the previously noted `pushed_at` 2024-06-28 — api.github.com was rate-limited from this IP on 2026-09-19 and could not be re-read. |
| `ink-spinner` | **5.0.0** | 2023-03-01 | `>=14.16` | `ink >=4.0.0`, `react >=18.0.0` | Range nominally allows Ink 7; dev-tested only against `ink ^4.0.0`, `react ^18` (https://raw.githubusercontent.com/vadimdemedes/ink-spinner/master/package.json, fetched 2026-09-19). Depends on `cli-spinners ^2.7.0`. |
| `ink-text-input` | **6.0.0** | 2024-05-14 | `>=18` | `ink >=5`, `react >=18` | Range nominally allows Ink 7; dev-tested only against `ink ^5.0.0`, `react ^18.3.1` (https://raw.githubusercontent.com/vadimdemedes/ink-text-input/master/package.json, fetched 2026-09-19). Depends on `chalk ^5.3.0`, `type-fest ^4.18.2`. |

Recommendation: `ink-spinner` and `ink-text-input` have not been released since 2023/2024 and predate Ink 6/7 and React 19; both are trivially re-implementable (a spinner is `useAnimation`/`setInterval` + `cli-spinners`; a one-line text input is `useInput` + state). UNVERIFIED whether either has Ink-7-specific bugs (api.github.com rate-limited on 2026-09-19; repo HTML pages re-fetched 2026-09-19 confirm `ink-spinner` 2 open issues / 29 commits and `ink-text-input` 15 open issues / 73 commits, but show no commit dates). Registry `time` confirms no release after 2023-03-01 (ink-spinner) and 2024-05-14 (ink-text-input); https://registry.npmjs.org/ink-spinner and https://registry.npmjs.org/ink-text-input, fetched 2026-09-19.

## 3. Ink APIs relevant to JevCode (verified from readme.md @ v7.1.1 and src)

README source: https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/readme.md (fetched 2026-09-19). Source: https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/render.ts and `src/ink.tsx`, `src/components/App.tsx`, `src/hooks/use-input.ts` (fetched 2026-09-19).

### `render(tree, options?)` options (from `src/render.ts` `RenderOptions`, defaults from `render()`)

| Option | Type / default | Notes (quoted where exact wording matters) |
|---|---|---|
| `stdout` | `NodeJS.WriteStream`, `process.stdout` | Ink keeps one instance per stdout; calling `render()` again for the same stdout prints a warning to native stderr and reuses the instance. |
| `stdin` | `process.stdin` | |
| `stderr` | `process.stderr` | |
| `debug` | `false` | "If true, each update will be rendered as separate output, without replacing the previous one." Also disables throttling (`unthrottled = options.debug || isScreenReaderEnabled`). |
| `exitOnCtrlC` | `true` | Ink listens for `\x03` and calls exit; needed because raw mode swallows SIGINT. |
| `patchConsole` | `true` | "Ink intercepts their output, clears the main output, renders output from the console method, and then rerenders the main output again." "Once unmount starts, Ink restores the native console before React cleanup runs." Powered by `patch-console`. |
| `onRender` | `({renderTime: number}) => void` | Runs after each commit; "does not wait for `stdout`/`stderr` stream callbacks." |
| `maxFps` | `number`, **`30`** | "Maximum frames per second for render updates." |
| `incrementalRendering` | `false` | "only updates changed lines instead of redrawing the entire output." |
| `concurrent` | `false` | React ConcurrentRoot; "Some tests may need to use `act()`". |
| `interactive` | `true` (`false` if CI or `stdout.isTTY` falsy) | See section 3.6. |
| `alternateScreen` | `false` | vim-style alt buffer; "Ignored when `interactive` is `false`". |
| `isScreenReaderEnabled` | `process.env['INK_SCREEN_READER'] === 'true'` | |
| `kittyKeyboard` | `{mode?: 'auto'|'enabled'|'disabled', flags?: KittyFlagName[]}` (`src/kitty-keyboard.ts`) | **Opt-in: when the option is omitted Ink does nothing** (`ink.tsx` `initKittyKeyboard`: "Protocol is opt-in: if kittyKeyboard is not specified, do nothing"). Only when an object is passed do `mode` default to `'auto'` and `flags` to `['disambiguateEscapeCodes']`; `'enabled'` force-enables when both stdin and stdout are TTYs. (https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/ink.tsx and `src/kitty-keyboard.ts`, fetched 2026-09-19.) |

`Instance` returned: `rerender(tree)`, `unmount()`, `waitUntilExit()` ("resolves with the value passed to `exit(value)` and rejects with the error passed to `exit(error)`"), `waitUntilRenderFlush()`, `cleanup()`, `clear()`. Also `renderToString(tree, {columns = 80})` renders synchronously to a string with no terminal side-effects (README "renderToString").

### `<Static>` (append-only transcript)
README: "`<Static>` component permanently renders its output above everything else. It's useful for displaying activity like completed tasks or logs - things that don't change after they're rendered." Props: `items: Array`, `style: object` (Box styles), `children(item, index)`; "a `key` must be assigned to the root component." Caveat: "`<Static>` only renders new items in the `items` prop and ignores items that were previously rendered... changes you make to previous items will not trigger a rerender." Implementation (`ink.tsx` `onRender`): new static output is appended to `fullStaticOutput` and written once; `handleStaticChange` resets it when the `<Static>` identity changes.

### `useInput(inputHandler, options?)`
Handler `(input: string, key: Key)`; `key` fields (README): `leftArrow, rightArrow, upArrow, downArrow, return, escape, ctrl, shift, tab, backspace, delete, pageDown, pageUp, home, end, meta, super, hyper, capsLock, numLock, eventType`. Options: `isActive?: boolean`. Paste: "if the user pastes text and it's more than one character, the callback will be called only once". **Gotcha (verified in `src/hooks/use-input.ts` lines 164-174):** raw mode is skipped only when `options.isActive === false`; `undefined` still calls `setRawMode(true)`.

### `useApp()` / `useStdout()` / `useStdin()` / `measureElement`
- `useApp()` returns `{exit(errorOrResult?), waitUntilRenderFlush(), suspendTerminal(callback?)}`; "`exit()` resolves with `undefined`. `exit(error)` rejects when `error` is an `Error`. `exit(value)` resolves with `value`."
- `useStdout()` returns `{stdout, write(data: string)}`; `write` is "similar to `<Static>`, except it can't accept components; it only works with strings" and writes above Ink's output.
- `useStdin()` returns `{stdin, isRawModeSupported: boolean, setRawMode(bool)}`. `isRawModeSupported` is literally `stdin.isTTY` (`App.tsx` line 209: `const isRawModeSupported = stdin.isTTY;`). `setRawMode` "will throw unless the current `stdin` supports `setRawMode`" — error text: "Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default."
- `measureElement(ref)` returns `{x, y, width, height}` (x/y added in 7.1.1); returns all zeros "when called during render (before layout is calculated). Call it from post-render code, such as `useEffect`". `useBoxMetrics(ref)` (7.0.0) returns `{width, height, left, top, hasMeasured}` reactively.
- `useWindowSize()` returns `{columns, rows}` and re-renders on resize.

### `<Box>` flex props (README headers, v7.1.1)
Dimensions `width/height/minWidth/minHeight/maxWidth/maxHeight/aspectRatio`; padding/margin (`padding*, margin*, paddingX/Y, marginX/Y`); `gap/columnGap/rowGap`; flex `flexGrow/flexShrink/flexBasis/flexDirection/flexWrap/alignItems/alignSelf/alignContent/justifyContent`; `position/top/right/bottom/left`; `display/overflowX/overflowY/overflow`; borders `borderStyle/borderColor/border*Color/border*DimColor/border*BackgroundColor/borderTop|Right|Bottom|Left`; `backgroundColor`. README: "It's like `<div style="display: flex">` in the browser."

### 3.6 Behaviour when stdout is not a TTY / in CI
- Detection (`ink.tsx` line 1053): `interactive ?? (!isInCi && Boolean(this.options.stdout.isTTY))`. `is-in-ci@2.0.0` is literally `check('CI') || check('CONTINUOUS_INTEGRATION')`, where a value of `'0'` or `'false'` counts as not-CI (https://raw.githubusercontent.com/sindresorhus/is-in-ci/main/index.js, fetched 2026-09-19; identical to the installed copy); README: "When running on CI (detected via the `CI` environment variable)... Only the last frame is rendered on exit... Terminal resize events are not listened to." Opt out with `CI=false`.
- Non-interactive path (`ink.tsx` `onRender`): new `<Static>` output is written immediately (`stdout.write(staticOutput)`); dynamic output is only stored and written once at `unmount()`. The `interactive` JSDoc in `src/render.ts` (not the README, which lacks this phrase): "When non-interactive, Ink disables ANSI erase sequences, cursor manipulation, synchronized output, resize handling, and kitty keyboard auto-detection, writing only the final frame at unmount." (https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/render.ts, fetched 2026-09-19).
- **Empirical (2026-09-19, `node app.mjs | cat -v`)**: with 4 `<Static>` items appended over time plus a live counter, piped output was exactly the 4 static lines (`S:log 0`..`S:log 3`), a blank line, then `live n=4` — no escape codes. With `CI=true` and a TTY-less pipe, same shape. `process.stdout.isTTY` is `undefined` (not `false`) when piped.
- **Empirical: `useInput` with non-TTY stdin crashes.** `node app.mjs < /dev/null` with an unguarded `useInput` prints the Ink error box "Raw mode is not supported on the current process.stdin". Passing `{isActive: isRawModeSupported}` **still crashes** because `stdin.isTTY` is `undefined`, not `false`. `{isActive: Boolean(isRawModeSupported)}` works (`raw=undefined`, "exited ok"). JevCode must gate `useInput` and `usePaste` (both skip `setRawMode(true)` only when `options.isActive === false`: `use-input.ts:169`, `use-paste.ts:48-52`) with `isActive: Boolean(isRawModeSupported)`, or skip Ink entirely in headless/benchmark mode. **Correction:** `useFocus` does *not* need this guard — `use-focus.ts` lines 70-72 read `if (!isRawModeSupported || !isActive) { return; }` before `setRawMode(true)`, and `undefined` is falsy, so it is already safe on non-TTY stdin (https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/hooks/use-focus.ts, fetched 2026-09-19).

## 4. Rendering model, throttling, perf pitfalls

Source: `src/ink.tsx` @ v7.1.1 (fetched 2026-09-19) unless noted.

- **Synchronous, event-loop-bound.** `onRender` runs `render(this.rootNode)` (Yoga layout + string output) synchronously on the JS thread, then `stdout.write`. Default root is React `LegacyRoot` (sync); `concurrent: true` switches to `ConcurrentRoot`. Long renders block the event loop for their duration; `onRender({renderTime})` exposes the per-frame cost.
- **Throttling.** `maxFps` default 30 → `renderThrottleMs = Math.max(1, Math.ceil(1000 / maxFps))` = 34 ms, applied via `es-toolkit/compat` `throttle(onRender, ms, {leading: true, trailing: true})`. Both the layout pass and the stdout write are throttled. `debug: true` or screen-reader mode disables throttling. Discussion #657 (2024-04-16) argues the 30 fps cap "leads to sluggish feeling TUIs"; no maintainer change (https://github.com/vadimdemedes/ink/discussions/657, fetched 2026-09-19).
- **Full-screen clear path (biggest flicker source).** `shouldClearTerminalForFrame`: when the previous frame was overflowing (`previousOutputHeight > viewportRows`), or the next frame overflows and there was a previous frame, or when leaving fullscreen, Ink clears the whole terminal and redraws; on Windows any fullscreen frame triggers a clear (#969). Qwen Code's analysis (issue opened 2026-02-10, now closed): "If dynamic output height is greater than or equal to terminal height, Ink falls back to a fullscreen path that clears the entire terminal and redraws everything." — "This threshold is the biggest flicker trigger." (https://github.com/QwenLM/qwen-code/issues/1778, fetched 2026-09-19). Ink issue #450 ("Flickering when rendering element with height precisely equal to `process.stdout.rows`", opened 2021-06-17, closed; reporter was on Windows Terminal) documents flicker when a Box's height equals `process.stdout.rows` and that "when i reduce the height by one, the problem goes away entirely" (https://github.com/vadimdemedes/ink/issues/450, fetched 2026-09-19).
- **Dynamic region is fully re-rendered every frame** (Yoga layout of the whole tree + full string rebuild), even for unchanged content; `<Static>` content is written once and never re-laid-out. So: commit completed transcript lines to `<Static>` and keep the live region small (well under `rows`). Qwen Code mitigations (same issue): "Keep Dynamic Output Below Terminal Height", "Use `<Static>` For Long, Append-Only History", "Split on newlines and commit completed lines to `<Static>`", and "Batch Streaming Updates" — "buffering a short interval (for example 50–100ms or one logical line) and updating once per batch may help".
- `incrementalRendering: true` (PR #781 "feat: incremental rendering" by wu-json, merged 2025-11-12; made opt-in at sindresorhus's request) does line-based diffing; caveat, in the author's words: "This PR uses a line-based diff to determine which lines to re-render. However in your example, since the colors are changing across columns, this PR ... won't prevent flickering because every line will have a line change" — i.e. it only helps when whole lines stay unchanged (https://github.com/vadimdemedes/ink/pull/781, fetched 2026-09-19). Ink also emits synchronized-output escapes (`bsu`/`esu`) around writes when the terminal supports it.
- `patchConsole` re-render cost: each `console.log` clears and redraws the live region — route agent logs through `<Static>` or `useStdout().write()` instead, or disable `patchConsole` and log to a file.
- Unmount duplicate-static guard (#397): on `unmount()`, Ink skips a final `onRender()` if static output exists and no render is pending, to avoid duplicating `<Static>` children.

## 5. Startup cost, ESM, bundling

- **Published numbers: UNVERIFIED.** Searched "Ink startup time yoga-layout wasm import cost" and "Ink React CLI startup time bundling esbuild" (WebSearch, 2026-09-19); only qualitative statements were found, e.g. "Yoga's WASM binary adds startup latency — noticeable on first run" (https://www.codeline.co/thoughts/repo-review/2025/ink-react-for-cli-apps, fetched 2026-09-19; full sentence: "Yoga's WASM binary adds startup latency — noticeable on first run if you're used to fast CLI tools." — no numbers given).
- **Measured locally (2026-09-19, Node v22.23.2, macOS, warm disk cache, 5 cold processes):** `import('react')` = 3.7–4.7 ms; `import('ink')` (incl. transitive deps) = **93–99 ms** (re-run 2026-09-19: 95–103 ms in 7 of 8 processes, one outlier at 120 ms); whole-process wall time `node t.mjs` = 0.11–0.12 s vs bare `node -e ''` = 0.01 s. Breakdown: `yoga-layout` 16–17 ms (WASM instantiate via top-level await; package is 296 KB), `react-reconciler` 19–20 ms, `chalk` ~3 ms; the remainder is Ink's ~25 dependency graph resolution of unbundled ESM files.
- **ESM-only:** `"type":"module"` with a single `default` export condition; `require()` fails with `ERR_REQUIRE_ASYNC_MODULE` (section 1). Project must be ESM (`"type":"module"`, `.mts`/`.mjs`, or `tsx`/`tsc` with `module: NodeNext`).
- **Bundling:** Ink itself recommends nothing specific beyond `npm install ink react` (README "Install"). Community starters use tsup/esbuild bundles (e.g. https://github.com/thaitype/ink-cli-starter, "Ink v6 and React 19 (ESM)", via search 2026-09-19). Bundling to a single ESM file with esbuild (`--format=esm --platform=node --bundle`) removes most of the module-graph resolution cost; the yoga WASM load (~16 ms) remains. UNVERIFIED: exact savings from bundling (not measured).
- React 19.2.0 (2025-10-01) is the floor because Ink 7 uses `useEffectEvent` (https://react.dev/blog/2025/10/01/react-19-2 mentions `useEffectEvent`, fetched 2026-09-19).

## 6. Unit testing with ink-testing-library (verified against Ink 7.1.1)

Source: https://raw.githubusercontent.com/vadimdemedes/ink-testing-library/master/readme.md and `source/index.ts` (fetched 2026-09-19).

- `render(tree)` returns `{lastFrame(), frames: string[], rerender(tree), unmount(), cleanup(), stdin, stdout, stderr}`. `stdout.lastFrame()`/`stdout.frames`, `stderr.lastFrame()`/`stderr.frames`. Exported `cleanup()` unmounts all instances.
- Internals: it calls Ink's `render(tree, {stdout, stderr, stdin, debug: true, exitOnCtrlC: false, patchConsole: false})`. Fake `Stdout` has `columns = 100` and **no `isTTY`**, so Ink 7 treats it as non-interactive — but `debug: true` makes Ink write every frame anyway, so `frames`/`lastFrame()` still work. Fake `Stdin` has `isTTY = true` (so `isRawModeSupported === true` and `useInput` works) and `write(data)` emits `'readable'` + `'data'`.
- **Empirical compatibility test (2026-09-19, ink@7.1.1 + react@19.3.0 + ink-testing-library@4.0.0):** a `useInput`-driven component: `lastFrame()` → `"Got:"`; after `stdin.write('ab')` + 20 ms → `"Got: ab"`; after `stdin.write('\r')` → `"Got: ab!"` with `frames.length === 3`. Passed.
- Pattern:
  ```tsx
  import {render} from 'ink-testing-library';
  const {lastFrame, frames, stdin, rerender, unmount} = render(<App />);
  expect(lastFrame()).toContain('...');
  stdin.write('y');            // key input; use '\r' for Enter, '\u001B[A' for up arrow
  await new Promise(r => setTimeout(r, 0));  // let React flush (Ink debug mode is unthrottled)
  rerender(<App step={2} />);
  unmount();
  ```
- Because `stdin.write` is synchronous-emit but React state updates flush on the next tick, `await` a tick (or a small `delay`) before asserting. With `concurrent: true` you would need `act()` (README note), but ink-testing-library does not pass `concurrent`.
- Alternative without a fake terminal: Ink's own `renderToString(tree, {columns})` for pure snapshot tests (no hooks/input).

## 7. Decisions / implications for JevCode

1. Pin `ink@7.1.1`, `react@19.3.0`, `@types/react@19.3.0`; require Node >=22; project must be ESM.
2. Transcript = `<Static items={completedEntries}>`; live region = current tool call / spinner / input only. Keep live region height well below `rows` (use `useWindowSize()`) to avoid the full-clear path.
3. Headless/benchmark mode (SWE-bench / Terminal-Bench harnesses pipe stdout, no TTY): either skip Ink and print plain lines, or rely on Ink's non-interactive mode (static lines stream, live frame printed at exit) and gate `useInput`/`usePaste` with `isActive: Boolean(isRawModeSupported)` (`useFocus` already guards internally).
4. Set `patchConsole: false` and send logs to a file; use `useStdout().write()` for out-of-band text.
5. Skip `ink-spinner`/`ink-text-input` (unreleased since 2023/2024, tested only on Ink 4/5 + React 18); implement in-house with `useAnimation`/`useInput`.
6. Budget ~100 ms for Ink import unbundled on a warm machine; bundle with esbuild for production to reduce it (savings UNVERIFIED).

## Verification log (2026-09-19)

Adversarial re-check of every version, date, field, quote and URL above against primary sources (npm registry JSON, raw.githubusercontent.com @ v7.1.1, GitHub release/issue/PR pages, local re-runs in `/tmp/inkbench` on Node v22.23.2). All 17 cited URLs returned HTTP 200. Anonymous `api.github.com` was rate-limited from this IP, so GitHub facts were re-verified from the HTML pages instead.

**Confirmed unchanged (no edit needed):** ink 7.1.1 / 2026-07-16T13:07:31.525Z, `type: module`, single-`default` `exports`, `engines.node >=22`, peers `react >=19.2.0` / `@types/react >=19.2.0` (optional) / `react-devtools-core >=6.1.2` (optional), dist-tags `{next: 3.0.0-7, latest: 7.1.1}`, full 25-entry `dependencies` list incl. `yoga-layout ~3.2.1` and `react-reconciler ^0.33.0`; publish dates 5.0.0 2024-05-11, 5.2.1 2025-04-29, 6.0.0 2025-05-29, 6.8.0 2026-02-19, 7.0.0 2026-04-08, 7.0.1 2026-04-17, 7.0.2 2026-05-05, 7.1.0 2026-06-17; v7.0.0 / v6.0.0 / v7.1.0 / v7.1.1 release bodies quoted verbatim (incl. #634, #719, #972, #974, #968); react 19.3.0 and @types/react 19.3.0 both 2026-09-09, react 19.2.0 2025-10-01; ink-testing-library 4.0.0 (2024-05-22, engines >=18, peer `@types/react >=18.0.0` optional, no ink peer, devDeps ink ^5.0.0 / react ^18.3.1); ink-spinner 5.0.0 (2023-03-01, >=14.16, peers ink >=4.0.0 / react >=18.0.0, dep cli-spinners ^2.7.0); ink-text-input 6.0.0 (2024-05-14, >=18, peers ink >=5 / react >=18, deps chalk ^5.3.0 / type-fest ^4.18.2); `render.ts` defaults (debug false, exitOnCtrlC true, patchConsole true, maxFps 30, incrementalRendering false, concurrent false, alternateScreen false, `isScreenReaderEnabled` from `INK_SCREEN_READER`); `ink.tsx:1053` interactive detection; `App.tsx:209` `isRawModeSupported = stdin.isTTY`; `use-input.ts` `=== false` check; `renderThrottleMs = Math.max(1, Math.ceil(1000/maxFps))` via `es-toolkit/compat` `throttle(..., {leading: true, trailing: true})`; `LegacyRoot`/`ConcurrentRoot` selection; `shouldClearTerminalForFrame` logic incl. `isWindowsConsole` (#969); #397 unmount guard; `bsu`/`esu`; `renderToString` `columns ?? 80`; `Instance` = rerender/unmount/waitUntilExit/waitUntilRenderFlush/cleanup/clear; `useApp` = exit/waitUntilRenderFlush/suspendTerminal; all README quotes in section 3; ink-testing-library `source/index.ts` internals (debug true, exitOnCtrlC false, patchConsole false, Stdout columns 100 and no isTTY, Stdin isTTY true emitting `readable`+`data`); discussion #657 (2024-04-16, "sluggish", no maintainer change); React 19.2 blog post mentions `useEffectEvent`; thaitype/ink-cli-starter wording; local re-runs reproduced `ERR_REQUIRE_ASYNC_MODULE`, the piped/CI=true output shape, the `useInput` crash with `isActive: isRawModeSupported` vs success with `Boolean(...)`, the ITL `useInput` test ("Got: ab!", 3 frames), `import('react')` 3.7–4.3 ms, yoga 15.5–16 ms, react-reconciler 19.7–19.8 ms, chalk ~2.8 ms, wall 0.11–0.12 s vs 0.01 s, `yoga-layout` 296 KB, `node_modules` 23 MB.

**Corrections made:**
1. Section 3.6 / Section 7: **`useFocus` does not need an `isActive: Boolean(isRawModeSupported)` guard** — `use-focus.ts:70-72` already returns early when `!isRawModeSupported || !isActive`. Only `useInput` and `usePaste` use the `=== false` check. (https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/hooks/use-focus.ts)
2. Section 3 `render()` table: **`kittyKeyboard` is opt-in, not "default mode `'auto'`"** — `ink.tsx` `initKittyKeyboard` does nothing when the option is omitted; `'auto'` and `['disambiguateEscapeCodes']` are defaults only once an object is passed. (https://raw.githubusercontent.com/vadimdemedes/ink/v7.1.1/src/ink.tsx, `src/kitty-keyboard.ts`)
3. Section 3.6: "writing only the final frame at unmount" was attributed to the README; it is in the `interactive` JSDoc of `src/render.ts`. Re-attributed and quoted in full.
4. Section 4: Qwen Code #1778 quotes were paraphrases; replaced with verbatim text ("If dynamic output height is greater than or equal to terminal height ...", "This threshold is the biggest flicker trigger.", "Batch Streaming Updates" / "buffering a short interval (for example 50–100ms or one logical line) ...") and added the issue date 2026-02-10 and state (closed).
5. Section 4: PR #781 "only prevents flickering when entire lines change" is not in the PR; replaced with the author's actual comment and marked the summary as paraphrase. Added title/author/opt-in context.
6. Section 4: Ink issue #450 — added exact title, the reporter's quote, and that it was reported on Windows Terminal.
7. Section 2: ink-testing-library `pushed_at` 2024-06-28 could not be re-read (API rate-limit); replaced with the verifiable last-commit date 2024-05-22 from the commits page and marked `pushed_at` UNVERIFIED. Added open-issue count 7.
8. Section 2: ink-spinner/ink-text-input UNVERIFIED note updated with what was re-fetched (issue counts 2 / 15, commit counts 29 / 73, still no commit dates).
9. Section 1: added that `react-reconciler` `latest` is now 0.34.0 (2026-09-09, peer react ^19.3.0) and stays outside Ink's `^0.33.0` range; added publish dates for yoga-layout 3.2.1 and react-reconciler 0.33.0.
10. Section 1: 7.0.1 also shipped "Respect `disableFocus()` when handling Escape (#937)"; noted 7.0.3–7.0.6 exist (2026-05-13 … 2026-06-12). Clarified the 7.0.0 kitty note (auto-mode query, protocol still opt-in). Added the exact yoga-layout top-level-await line.
11. Section 3.6: `is-in-ci` behaviour made precise (`CI` or `CONTINUOUS_INTEGRATION`, `'0'`/`'false'` excluded) with source URL.
12. Section 5: codeline.co page is now fetched (was "not independently fetched"); full sentence quoted. Timing line notes the re-run range and one 120 ms outlier.
13. Release-table source line: switched from the rate-limited API URL to the HTML release pages actually used.

**Still UNVERIFIED after this pass:** ink-testing-library `pushed_at`; whether ink-spinner / ink-text-input have Ink-7-specific bugs; any published Ink startup-time numbers; exact savings from esbuild bundling (not measured).
