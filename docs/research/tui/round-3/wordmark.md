# Round 3 · R2 — the persistent animated wordmark

Research report for the round-3 request item 1 ("keep that animation for the jevcode, not disappear once it loads").
Written 2026-09-21 against HEAD `d09e24c` (0.3.0, the round-2 bundle at `dist/jevcode.mjs`, built 15:41). Everything
below was read in the source or measured on this machine (Apple Silicon, macOS 26, Node 22; load average 1.4–1.8 with a
peer session's `jevcode perf` run alive throughout — the CPU numbers carry that noise, the frame and byte counts do
not). Scratch artefacts: `/tmp/jc-idle/*.json` (per-chunk pty captures), the probe `/tmp/jc-idle/idle_probe.py`; nothing
was written into the repository except this file.

Design constraints honoured throughout (from the round-3 brief): first frame < 300 ms with zero network before it;
zero clears outside shrink resizes; composer keystroke → frame p95 < 16 ms (D-F); dynamic frames ≤ maxFps + 1 during a
live run; `--plain` / `transcript.log` / TUI line identity (the wordmark is dynamic-region only, never a transcript
item); keys never printed; reduced motion, screen reader, the flat tier below 16 rows and the SSH fps-15 tier keep
working; no new dependency; strict types. The owner's decisions (jev-on default with badge `jev+llm`, `DEFAULT_MODE` a
one-line constant, the peer's `llm-jev` becoming the default later) are respected: **no string in this design names a
mode**; the badge word comes from the existing table `modeBadgeWord` (`src/tui/status/lines.ts:105–109`, which already has
the `llm-jev` row).

---

## 0. What happens today (read, then measured)

### 0.1 The code path

| Piece | Where | What it does today |
| --- | --- | --- |
| Schedule | `src/tui/splash.ts:14–22` | `SPLASH_MS = 700`, tick `SPLASH_INTERVAL_MS = 50`, reveal to 400, shimmer 450–550, fade steps 600 / 650, settled at 700 |
| Frame | `src/tui/splash.ts:103–138` | `splashFrame(t, columns, g)` — 5 rows × 56 cells; **returns `rows: []` once `phase === 'settled'` or below 64 columns** (line 106). Roles: `JEV` `accent`, `CODE` `dim`, head / band `sweep` |
| Time source | `src/tui/motion.ts:21–28` | `useMotion(active, 700)` over Ink's `useAnimation({ interval: 50 })`; the subscriber **deactivates itself at 700 ms** (`stoppedRef`, lines 25–26) — nothing ticks afterwards |
| Mount | `src/tui/App.tsx:561–562` | `splash: boxed && !launchReducedMotion && !launch.screenReader ? 'running' : 'done'` |
| Settle | `src/tui/App.tsx:569–574` | the settle effect dispatches `splash:done` in the commit where `motion.settled` turns true |
| Slot | `src/tui/App.tsx:1916–1920` | `splashOn = splash === 'running' && motion.time < SPLASH_MS && columns >= 64 && boxed`; `paneWant = … wordmarkOn ? CAP.splash (5) : panel …` |
| Layout | `src/tui/layout.ts:141–187` | `computeLayout` 1.1; step 10 `z.pane = take(min(paneWant, CAP.pane))` — the pane yields **first** (`YIELD_ORDER`, line 124) and can be granted **partially** (3 of 5 rows) |
| Rule row | `src/tui/Pane.tsx:53–63` | while `splash === 'running'` and the wordmark has rows → the plain rule; then `brandRow` (`─── ◆ jevcode 0.3.0 ───`) until the first `run:ready`; then the panel strip |
| Render | `src/tui/App.tsx:2044–2048`, `2161–2190` | `<SplashRow>` per row: one `<Text>` per role run, `textProps(theme, role, depth)` |
| Cancel | `src/tui/useEngine.tsx:379–381`, `408`, `416`, `427`, `487`, `572`, `697`, `713` | `endSplash` on a key, `run:start`, `confirm:request`, any overlay change, `blocking:request`, `splash:done` — the wordmark **vanishes** in that commit |
| Brand row | `src/tui/splash.ts:141–174` | `brandText`, `brandGlyph` (`░ ▒ ▓ ◆` pulse for the < 64-column form), `brandRow`, `brandSpan` (the accent span the `RuleRow` colours, `App.tsx:2142–2158`) |
| Glyphs | `src/tui/glyphs.ts:151–154`, `203–206` | `▓ ▒ ░ ◆` and the `--ascii` twins `# + . *` |
| Theme roles | `src/tui/theme.ts:61`, `93–112` | `accent` cyan 117 `#7DD3FC`, `dim`, `sweep` whiteBright 195 `#E0F2FE`, `badge`. The pink retheme (topic R-palette) lands in this table; the wordmark only names roles |
| 1 Hz tick | `src/tui/useEngine.tsx:59`, `420–423`, `1004–1009` | `tick` changes `nowMs` every second → a React render of the App; Ink writes nothing when the output string is unchanged (see 0.3) |
| Timer allow-list | `test/unit/tui/spinner.test.ts:99–116` | `useAnimation(` only in `motion.ts`; `setInterval(` only in `spinner.ts` and `retry.ts` — any new time driver must live in `motion.ts` |

### 0.2 Idle frames today (pty, real bundle, hermetic env like `test/pty/run-smoke.sh`)

Probe: spawn `node bin/jevcode.js chat --mock --workspace <tmp>` under `pty.fork`, record every output chunk with a
monotonic timestamp, idle for N s after the first `ESC[?25l`, then `/exit`. Frames are Ink's synchronized-output brackets
(`ESC[?2026h … ESC[?2026l`, the same definition `src/perf/pty.ts:36` and `run-smoke.sh:91–104` use).

| Geometry / flags | First frame | Splash frames (0–750 ms) | Wordmark frames | Settled at | Splash bytes | **Idle frames, [1 s, N s]** | Idle bytes | Clears |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 24×80 (solo, N = 20) | 93 ms | 16 | 15 | 709 ms | 31,038 | **0** | **0** | 0 |
| 24×80 (N = 10) | 137 ms | 16 | 15 | 706 ms | 31,053 | **0** | 0 | 0 |
| 40×120 (solo, N = 12) | 110 ms | 16 | 15 | 707 ms | 41,349 | **0** | 0 | 0 |
| 24×80 `--fps 15` (N = 10) | 135 ms | 9 | 8 | 707 ms | 17,000 | **0** | 0 | 0 |
| 24×80 `--no-animation` (solo, N = 20) | 110 ms | 3 (no wordmark) | 0 | 0 (mounts settled) | 4,135 | **0** | 0 | 0 |
| 16×80 (N = 5) | 135 ms | 16 | 15 | 707 ms | 31,038 | **0** | 0 | 0 |
| 12×80 flat (N = 5) | 133 ms | 3 (no wordmark) | 0 | — | 1,606 | **0** | 0 | 0 |

Facts to build on:

- **Idle costs zero frames and zero bytes today.** The 1 Hz `tick` re-renders React, but Ink's `renderInteractiveFrame`
  writes only when `output !== this.lastOutput || this.log.isCursorDirty()` (`node_modules/ink/build/ink.js:790–793`).
  Any idle animation is therefore a pure addition on top of 0, and the gate has to be an absolute number.
- **Splash frame times at 24×80 (solo):** 0, 33, 92, 108, 158, 208, 258, 307, 358, 408, 457, 508, 558, 608, 660, 709 ms —
  the 50 ms `useAnimation` cadence exactly (the extra frame near 100 ms is the `[config]` static item). 15 wordmark
  frames in 700 ms, as `test/pty/round2.pty.test.ts:78` (`SPLASH_MAX_FRAMES = 15`) asserts.
- **Under `--fps 15`** (render throttle `ceil(1000/15)` = 67 ms) the 50 ms ticks coalesce to a 100 ms cadence: 60, 176,
  208, 309, 408, 508, 608, 707 ms — 8 wordmark frames. `useAnimation` skips a tick that falls inside the throttle window
  (`node_modules/ink/build/hooks/use-animation.js:46–52`).
- **Bytes per wordmark frame** (all five rows change every frame): 24×80 1,621–2,226 B (mean 1,940; the shimmer frames
  2,156–2,226); 40×120 2,273–2,878 B (mean 2,584). Ink 7.1.1's incremental log-update rewrites **only changed lines**
  and moves over unchanged ones with `ESC[E` (`node_modules/ink/build/log-update.js:160–185`), so these numbers are the
  cost of "five rows with new SGR spans", not of the whole 11-row region; the console rows below are not rewritten.
- **CPU (ps `time`, 10 ms resolution; peer perf run alive):** 24×80 solo: 0.10 s at the first frame, 0.36 s at 0.91 s,
  0.48 s at 10.1 s, 0.53 s at 20.1 s → idle ≈ 5 ms CPU/s (10–20 s window), ≈ 13 ms/s over 0.9–10 s (includes the late
  startup: config, index fold, git head, history). `--no-animation` solo: 0.12 / 0.21 / 0.39 / 0.50 s at the same marks →
  idle ≈ 11 ms/s. The difference in the 0.1–0.9 s window between the two runs, 0.26 − 0.09 = **≈ 0.17 s for 15 wordmark
  frames ≈ 11 ms CPU per frame** (App re-render + Yoga + Ink render + line diff; an upper bound under load). This is the
  number the animation budget must respect: a permanent 4 fps would be ≈ 44 ms/s ≈ 4 % of one core.

### 0.3 Ink mechanics that decide the design (read in `node_modules/ink/build`, verified on the real renderer)

| Mechanism | Where | Consequence |
| --- | --- | --- |
| One shared animation timer, a single `setTimeout` to the earliest subscriber deadline; due times advance from elapsed time, never from tick count | `components/App.js:59–88` | a 250 ms subscriber wakes the process exactly 4×/s and never drifts; a second subscriber with another interval shares the timer |
| `useAnimation` coalesces ticks inside the render-throttle window | `hooks/use-animation.js:46–60` | at intervals ≥ throttle (250 ≥ 67) every tick renders; at 50 ms only every other tick renders under fps 15 (measured above) |
| Changing `interval` or `isActive` resets `time` to 0 (`shouldReset`) | `hooks/use-animation.js:32–36`, `86` | a two-interval loop (pass / rest) restarts its clock at each switch — the frame table must be indexed by the tick count of the current phase, not by wall time |
| Render throttle `throttle(onRender, ceil(1000/maxFps), { leading, trailing })`; `onImmediateRender = this.onRender` (raw) | `ink.js:194–215` | the only 34 ms window; key commits bypass it via the `<Static>` style update (D-F, `src/tui/Transcript.tsx:60–64`, `:136–138`) |
| **The log throttle has wait `undefined` → 0 ms** | `ink.js:221–236` (`throttle(fn, undefined, {…})`), `es-toolkit/dist/compat/function/throttle.js:33–40` | a frame written by an animation opens **no** window for a key's frame |
| Identical output → no write | `ink.js:790–793`, `log-update.js:118–125` | an animation tick whose frame changes nothing costs a React render but no bytes |

Verified on the real Ink renderer with a stub TTY (a temporary vitest file, run and deleted; pattern of
`test/unit/tui/key-immediate-render.test.tsx`):

| Experiment | Result |
| --- | --- |
| A written frame (leading edge), then a key commit (`keySeq` +1) 5 ms later | key painted **synchronously** (3 writes: BSU, body, ESU) and still painted at +65 ms |
| `useAnimation({ interval: 100 })` component; key commit 12 ms after its tick frame | key painted **synchronously** |
| `useAnimation({ interval: 250 })`, maxFps 30, 2 s | 7 frames written (3.5 fps; ticks at 250 … 1,750 inside the window) |
| `useAnimation({ interval: 250 })`, maxFps 15, 2 s | 7 frames — **identical**: the SSH tier does not change a 4 fps loop |
| `useAnimation({ interval: 500 })`, maxFps 30, 2 s | 3 frames |
| `useAnimation({ interval: 50 })`, maxFps 30 / 15, 2 s | 39 / 19 frames (19.5 / 9.5 fps: the throttle coalescing measured above) |

So: **an idle animation cannot add throttle latency to a keystroke's frame**; the composer gate is not at risk from the
frames themselves, only from CPU contention (≈ 11 ms per frame, which a key landing mid-render waits out — bounded by one
render).

### 0.4 What the layout grants (computed with `computeLayout` 1.1 from `src/tui/layout.ts`, via `npx tsx`)

`status 1 · rule 1 · composer 1 · chrome 3` are fixed in the boxed tier (6 rows); the pane slot yields first.

| Scenario (`paneWant`, others) | 40×120 (budget 38) | 24×80 (22) | 18×80 (16) | 16×80 / 16×64 (14) | 12×80 flat (10) | 8×40 (6) |
| --- | --- | --- | --- | --- | --- | --- |
| idle today (pane 0) | 6 | 6 | 6 | 6 | 3 | 3 |
| idle + wordmark 5 | pane 5 → 11 | 5 → 11 | 5 → 11 | 5 → 11 | 5 → 8 | **3** → 6 (partial) |
| wordmark + 6-row draft | 5 → 16 | 5 → 16 | 5 → 16 | **3** → 14 (partial) | **2** → 10 | 0 |
| thinking (pane 5, composer 1) | 5 → 11 | 5 → 11 | 5 → 11 | 5 → 11 | 5 → 8 | 3 |
| live 2 + wordmark 5 | 5 → 13 | 5 → 13 | 5 → 13 | 5 → 13 | 5 → 10 | 1 |
| live 2 + panel open 6 | 6 → 14 | 6 → 14 | 6 → 14 | 6 → 14 | 5 → 10 | 1 |
| live 2 + queue 2 + panel full 12 | 12 → 22 | 12 → 22 | 6 → 16 | 4 → 14 | 3 → 10 | 0 |
| palette card 8 + wordmark 5 | 5 → 19 | 5 → 19 | **2** → 16 | 0 → 14 | 0 → 10 | 0 |
| intake card 3 + wordmark 5 | 5 → 14 | 5 → 14 | 5 → 14 | 5 → 14 | 4 → 10 | 0 |
| review card 9 + preview 4 + wordmark 5 | 5 → 24 | **3** → 22 | 0 → 16 | 0 → 14 | 0 → 10 | 0 |
| wizard 4 + wordmark 5 | 5 → 14 | 5 → 14 | 5 → 14 | 5 → 14 | 4 → 10 | 0 |

The bold cells are **partial grants** — the top 2–3 rows of the letters with the rest cut off. `computeLayout` 1.1 has no
"whole or absent" rule for the pane (it has one for `chrome`, line 176). A persistent wordmark needs one (proposal 2).

---

## 1. (a) The persistent header — where it lives, when it hands off

### 1.1 The one rule

The wordmark is **the pane slot's idle tenant**. It occupies the 5 pane rows between the rule row and the console
whenever nothing else needs that slot, and it is granted **whole or not at all**. It never takes rows from anything
that exists today: allocation order is unchanged (pane still yields first), so every round-2 frame with a run, a panel, a
review or a picker is byte-for-byte what it is now.

```ts
// src/tui/wordmark.ts (new, pure) — the visibility selector; every input is already in UiState / the App
export interface WordmarkInput {
  boxed: boolean;            // chromeRows(rows, columns, screenReader) === 3  (App.tsx:548–549)
  columns: number;           // ≥ WORDMARK_MIN_COLUMNS (64)
  screenReader: boolean;     // never under a screen reader (already flat, kept explicit)
  run: RunPhase;             // hidden while runIsLive(run): 'live' | 'aborting' | 'pausing' (App.tsx:114–116)
  panel: PanelState;         // only while 'collapsed'
  pickerOpen: boolean;       // the picker owns the slot
  overlay: OverlayKind;      // hidden for 'review' (the review reclaims rows, TD A42); every other overlay keeps it if the layout grants 5 whole rows
  expanded: boolean;         // review `e`: pane is 0 anyway
  setting: 'sweep' | 'static' | 'off';   // proposal 7; 'off' → never
}
export function wordmarkWanted(i: WordmarkInput): boolean;   // the want; the layout's whole-or-absent grant decides the show
```

### 1.2 State → rows, boxed tier (≥ 16 rows, ≥ 64 columns)

| State | Rule row | Pane slot | Dynamic rows 24×80 | Notes |
| --- | --- | --- | --- | --- |
| first frame (t = 0) | plain rule | splash frame 0 (`J` + `▓▒░`) | 11 | unchanged — `step 0/–` sentinel in the console, `wordmarkCells > 0` (first-frame gate) |
| reveal / shimmer (0–550 ms) | plain rule | wordmark, as today | 11 | unchanged frames 0–11 of §5.2 |
| **held (≥ 550 ms)** | plain rule | **resting wordmark** (`JEV` accent, `CODE` dim) + caption `◆ 0.3.0` (≥ 74 cols) | 11 | the fade steps 600/650 and the collapse at 700 are removed; `splash:done` still fires at 700 (state hygiene, cancel semantics) but changes no pixel |
| idle, no run yet | plain rule | resting wordmark; the loop runs (§2) | 11 | today: brand row + console = 6 |
| thinking (`run === 'starting'`, intake / lookup / reply) | plain rule | wordmark stays | 11 | the spinner row is the other dynamic row; a pass already running finishes |
| intake card `run this as a task?` | plain rule | wordmark stays | 14 | fits at 16 rows exactly (14/14) |
| wizard (first run, no key) | plain rule | wordmark stays | 14 | the console hosts the wizard rows |
| palette | plain rule | wordmark **if** 5 whole rows remain (24×80 yes; 16–18 rows no) | 19 / 14 | hand-off and return around the palette at small heights |
| `run:start` → live, before `run:ready` | **brand row** (as today, `Pane.tsx:61`) | **hidden** (pane 0) | 6 + live | zero animation frames during a run; the console border turns `borderFocus` |
| live after `run:ready` | panel strip `▸ jev s3 · …` | hidden | 6–10 | as today |
| review pending | strip | hidden | as today | `overlay === 'review'` hides it before the layout does |
| `run:end` → idle after a run | strip (`▸ jev s7 · 12 decisions …`) | **wordmark returns** | 11 | the strip keeps its information; the mark sits under it (mock F-W5) |
| panel open / full, picker | tab header | panel / picker rows | as today | `/panel off`, Alt+J, Esc bring the mark back |
| < 64 columns | brand row (static after 400 ms) | 0 | 6 | as today; **no idle pulse** (zero idle frames below 64 columns) |
| draft grows so that < 5 rows remain (16–17 rows only) | plain rule | hidden until the draft shrinks | 14 | at ≥ 18 rows a 6-row draft still leaves ≥ 5 (table §0.4) |

### 1.3 Flat tier (rows 8–15) and 8 rows

| Rows | What the header is | Idle frames |
| --- | --- | --- |
| 12 (flat) | the static brand row `─── ◆ jevcode 0.3.0 ───` on the rule, today's `›` row, today's status row (mock F-W7) | 0 |
| 8 (flat, `MIN_ROWS`) | the same three rows; at 8×40 also below 64 columns | 0 |
| < 8 or < 40 columns (minsize) | status · notice · composer, no brand | 0 |

Decision: **the 5-row wordmark stays a boxed-tier feature** (as the splash is today, §4.1 of TUI-DESIGN-2). At 12 rows
the arithmetic allows it (8/10) but leaves two rows of headroom, so a 3-row draft would hand it off and back while the
user types; the flat tier is the minimal UI by design and stays frame-free. The brand row keeps carrying the name and
version there.

### 1.4 Reduced motion, screen reader, `--plain`, no colour, `--ascii`, SSH

| Mode | Wordmark | Reveal | Loop | Frames while idle |
| --- | --- | --- | --- | --- |
| `--no-animation` / `JEVCODE_REDUCED_MOTION` / `ui.reducedMotion` | **static resting mark from frame 0** (fully revealed, `JEV` accent, `CODE` dim, caption) | none | none (no subscriber mounted) | 0 |
| `--screen-reader` | none (flat tier; `wordmarkWanted` false) | none | none | 0 |
| `--plain` / pipe | nothing (no dynamic region) | — | — | — |
| `NO_COLOR` / `--no-color` / `TERM=dumb` (depth 0) | static resting mark; the reveal still runs (its head `▓▒░` is a cell change, visible without colour) | yes | **off** — the band is colour-only, invisible at depth 0, so no frames are spent on it | 0 |
| `--ascii` | `#` letters, `#+.` head (as today); the band is colour-only, identical to Unicode | yes | yes (colour) | as Unicode |
| `--fps 15` (SSH) | identical; 250 ms ticks are never coalesced (67 ms throttle) | 100 ms cadence (measured) | 4 fps peak, identical byte cost | as maxFps 30 |

### 1.5 The key that used to kill the splash

Today the first key ends the splash and the wordmark vanishes (`useEngine.tsx:415–418`, `App.tsx` cancel rows). With a
persistent mark, a key during the reveal must not remove it. New semantics: **a key completes the reveal** — the next
frame shows the whole resting mark (no head, no band) and the character in the composer. `endSplash` keeps flipping
`splash` to `done` (the reducer test `round2-reducer.test.ts:64–78` stays true); only the App's row source changes
(§3, proposal 3). `run:start`, `confirm:request`, overlay changes and `blocking:request` also flip `splash` and the
visibility selector hides the mark where the state table says so — nothing new is stored for that.

---

## 2. (b) The animation

### 2.1 Common ground

- Grid, glyphs, roles and centring are the splash's (`WORDMARK`, `WORDMARK_CELLS = 56`, `wordmarkOffset`, roles
  `accent` / `dim` / `sweep`; `src/tui/splash.ts:24–47`, `87–90`). The pink retheme changes only `theme.ts` triples.
- Time comes from Ink's shared timer through **one hook in `motion.ts`** (the only module allowed to call
  `useAnimation(`, `spinner.test.ts:109–113`). Every phase is a function of the tick count of the current phase (Ink resets
  `time` when the interval or `isActive` changes, §0.3), so a slow terminal skips frames instead of running long, as §5.2
  demands.
- **Zero frames unless something is visible:** a tick whose frame equals the previous one is never produced — the hook
  is inactive in every state below whose row says "0".
- Pause rule: **no pass starts within 3,000 ms of the last key** (`UiState.lastKeystrokeAt`, `useEngine.tsx:164`, `418`) —
  a typing burst keeps the mark still, a thinking pause lets it move; a pass already running (≤ 4 s) finishes rather than
  leaving a half-lit band. This is for calm and CPU, not for latency (§0.3: written frames do not delay key frames).
- Attention decay (CPU): full cadence for 60 s after the last activity (key, `run:end`, a reply, a resize, a panel
  change), then one pass every 30 s, then **static after 10 minutes** until the next activity. Constants in one table so
  the owner can flip them.

### 2.2 Candidate A — the `▓▒░` sweep, looping (recommended)

The splash's own 6-cell `sweep` band crosses the 56-cell grid left → right, 4 cells per frame at 4 fps (16 cells/s: a
glide, where the boot shimmer ran 500 cells/s). Colour only: letter cells inside the band take the `sweep` role over
`accent` / `dim`; blank cells stay blank; the caption and tagline are never in the band.

Frame table (one pass; `t` from the pass start; band `[max(0, s), min(56, s + 6))`, `s = −6 + 4k`):

| k | t (ms) | band cells | written? | k | t (ms) | band cells | written? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | ∅ (`s = −6`) | no (identical) | 9 | 2,250 | 30–35 | yes |
| 1 | 250 | 0–3 | yes | 10 | 2,500 | 34–39 | yes |
| 2 | 500 | 2–7 | yes | 11 | 2,750 | 38–43 | yes |
| 3 | 750 | 6–11 | yes | 12 | 3,000 | 42–47 | yes |
| 4 | 1,000 | 10–15 | yes | 13 | 3,250 | 46–51 | yes |
| 5 | 1,250 | 14–19 | yes | 14 | 3,500 | 50–55 | yes |
| 6 | 1,500 | 18–23 | yes (mock F-W2) | 15 | 3,750 | 54–55 | yes |
| 7 | 1,750 | 22–27 | yes | 16 | 4,000 | ∅ (`s = 58`) | yes (clears the band) |
| 8 | 2,000 | 26–31 | yes | rest | 4,000 → 10,000 | — | no ticks (one 5,750 ms subscriber wake) |

Per pass: **16 written frames in 4.0 s (peak 4/s), then 6.0 s of silence → period 10 s, mean 1.6 fps.** Changed cells
per row per frame ≤ 8 (4 leave, 4 enter; fewer where the band covers blanks), ≤ 40 per frame. Under decay: one pass per
30 s (mean 0.53 fps); static after 10 min.

```ts
// src/tui/wordmark.ts — constants (one table)
export const LOOP_INTERVAL_MS = 250;        // 4 fps peak; ≥ any render throttle (34 / 67 ms) so no tick is coalesced (§0.3)
export const LOOP_STEP_CELLS = 4;
export const LOOP_BAND_CELLS = SWEEP_CELLS; // 6, the splash's
export const LOOP_PASS_TICKS = 17;          // k = 0..16; 16 visible frames
export const LOOP_REST_MS = 5_750;          // → period 10 s while attentive
export const LOOP_REST_CALM_MS = 25_750;    // → period 30 s after 60 s without activity
export const LOOP_ATTENTIVE_MS = 60_000;
export const LOOP_SLEEP_MS = 600_000;       // static after 10 min
export const LOOP_QUIET_AFTER_KEY_MS = 3_000;
export const CAPTION_MIN_COLUMNS = 74;      // ⌊(c−56)/2⌋ + 56 + 9 ≤ c  ⇔  c ≥ 74
export const TAGLINE_MIN_COLUMNS = 104;     // ⌊(c−56)/2⌋ + 58 + 22 ≤ c ⇔  c ≥ 104
export function loopBand(k: number): { from: number; to: number } | null;   // the table above, pure
export function wordmarkFrame(i: { columns: number; band: { from: number; to: number } | null; version: string; tagline: boolean; glyphs: GlyphSet }): SplashFrame; // rows + spans; caption/tagline spans in `dim`
```

### 2.3 Candidate B — the caption pulse (cheapest)

The mark rests; only the caption's brand glyph breathes through the existing `brandGlyph` ladder
(`src/tui/splash.ts:146–150`): one breath = `░ → ▒ → ▓ → ◆` at 1 fps (4 frames), one breath every 6 s.

| t (ms) | caption | written? |
| --- | --- | --- |
| 0 | `░ 0.3.0` | yes |
| 1,000 | `▒ 0.3.0` | yes |
| 2,000 | `▓ 0.3.0` | yes |
| 3,000 | `◆ 0.3.0` | yes (rest state) |
| 3,000 → 6,000 | — | no ticks |

Mean 0.67 fps, peak 1 fps; **one row rewritten per frame** (≈ 150–250 B). Exists only at ≥ 74 columns (the caption's
geometry); below it there is nothing to animate. Weakest identity — the letters never move — but the right choice for a
`wordmark: 'calm'` setting if the owner wants one.

### 2.4 Candidate C — the twinkle

Every 2 s one letter lights up in `sweep` for one frame, in order `J E V C O D E` (deterministic, from a table, never
`Math.random`): frame "on" at t, frame "off" at t + 250 → 2 frames / 2 s = 1 fps mean, 4 fps never; the letter's five
rows are rewritten each time (≈ 1.9 KB per frame at 80 columns). Needs the two-interval scheme (1,750 / 250 ms) to avoid
no-op ticks. Subtle, but "sparkle" reads as noise on a static mark and it lacks the boot animation's motion, which is
what the request names.

### 2.5 Comparison and the pick

| | A sweep loop | B caption pulse | C twinkle |
| --- | --- | --- | --- |
| Peak dynamic fps (gate ≤ 4) | 4 | 1 | 4 (two frames 250 ms apart) |
| Mean fps, attentive | 1.6 | 0.67 | 1.0 |
| Bytes per written frame, 80 / 120 cols (from §0.2 measurements) | ≈ 2.1 / 2.8 KB | ≈ 0.2 / 0.2 KB | ≈ 1.9 / 2.6 KB |
| Bytes per second, attentive | ≈ 3.4 / 4.5 KB/s (peak 8.4 / 11.2 KB/s) | ≈ 0.13 KB/s | ≈ 1.9 / 2.6 KB/s |
| CPU per second, attentive (≈ 11 ms per frame, §0.2) | ≈ 18 ms/s (peak 44 ms/s) | ≈ 7 ms/s | ≈ 11 ms/s |
| Continuity with the boot splash | the same band, same role, same width | the < 64-column brand pulse | none |
| Reads at depth 0 | no (skipped) | yes (cell change) | no (skipped) |

**Pick A**, with B kept in the report as the fallback for a future `'calm'` value. A is "that animation" the request
names, it reuses `SWEEP_CELLS` and the `sweep` role byte for byte, and with the rest / decay rules its mean cost is
well under 2 frames/s and ≈ 2 % of a core while the user is present, ≈ 0.6 % after a minute, 0 after ten.

### 2.6 What Ink's interval gives (measured, §0.3)

`useAnimation({ interval: 250 })` produced 7 written frames in 2,000 ms at maxFps 30 **and** at maxFps 15 (ticks at 250,
500, … 1,750; the 2,000 ms tick fell on the window edge): one render per tick, no coalescing, no drift. The two-interval
scheme (`isActive` and `interval` switched by the pass / rest phase) resets the hook's clock at each switch, so `k` is the
hook's `frame` value within the pass, and the rest is one wake at `LOOP_REST_MS`.

---

## 3. (c) Perf accounting and the gates

### 3.1 Cost model (per written idle frame)

| Component | Measured / derived | Source |
| --- | --- | --- |
| Bytes, 24×80, five rows change | 1,621–2,226 B (mean 1,940) | §0.2 splash frames |
| Bytes, 40×120 | 2,273–2,878 B (mean 2,584) | §0.2 |
| Bytes, one caption row | ≈ 150–250 B | line-diff renderer (`log-update.js:160–185`); a 10-cell row + `ESC[E` × 10 + prefix / suffix |
| CPU per frame | ≈ 11 ms (upper bound; load 1.4–1.8) | §0.2 difference of the 0.1–0.9 s CPU windows |
| Idle baseline today | 0 B/s; ≈ 5–11 ms CPU/s (the 1 Hz tick's React render) | §0.2 |
| Key latency impact | none from the frames (log throttle wait 0; key commits bypass the render throttle) — at most one in-flight render (≈ 11 ms) | §0.3 experiments |

### 3.2 Gates (new rows, old rows unchanged)

| Gate | Threshold | How it is kept | Where measured |
| --- | --- | --- | --- |
| **Idle dynamic fps** | ≤ 4 in any one-second bucket; mean ≤ 2/s over [1 s, 31 s] | `LOOP_INTERVAL_MS = 250`, 16 frames per 10 s | new `idle-frames` probe (proposal 5), pty `wordmark-idle.steps` |
| **Idle bytes** | ≤ 12 KB/s in the busiest second; ≤ 5 KB/s mean | ≤ 2.9 KB per frame × 4 | same probe (`Frame.body.length`) |
| Idle CPU | reported (child `ps -o time` delta over 30 s), not gated in round 3 | decay rules | same probe |
| First frame | < 300 ms; frame 0 **is** splash frame 0 (`wordmarkCells > 0`, `step 0/`) — **unchanged** | frame 0 is byte-identical | `src/perf/first-frame.ts:79–90` |
| Zero clears | 0 outside shrink segments | the region never exceeds `rows − 2` (whole-or-absent pane ≤ budget); hand-offs are height changes inside the budget, like `/panel` today | `render-lag.ts`, `states.ts`, every `.steps` |
| Composer p95 | < 16 ms idle / live / palette / review — **unchanged**; the idle series now types while the mark rests (the 3 s quiet rule pauses passes from key 1) | D-F + log throttle 0 ms | `composer-latency.ts`; add one `idle-loop` series whose first key is sent 200 ms into a pass |
| Dynamic fps during a run | ≤ maxFps + 1 — unchanged | the mark is hidden while `runIsLive` | `render-lag.ts` |
| Splash bucket | ≤ 22 `dynamic` frames in the first 700 ms — unchanged (15 reveal frames; the first pass begins at 700 + 5,750 ms) | `LOOP_REST_MS` | `render-lag.ts:57–66` |
| Reduced motion | 0 wordmark **frames** after frame 0 (the static mark is in frame 0) | no subscriber | `splash-reduced.steps` rewritten (§4) |
| Line identity | unaffected: no transcript item changes; the caption / tagline are dynamic rows, never `<Static>` | — | `plain.test.ts`, `app.test.tsx:299` untouched |

---

## 4. (d) Sentinels and the tests that pin today's behaviour

The `step 0/–` first-frame sentinel (`src/tui/status/lines.ts:211–215`, `src/perf/first-frame.ts:79`) lives in the console
status row and is **unchanged**. The brand row `◆ jevcode` was the round-2 "settled" sentinel; with the mark persistent
there is no collapse to detect, so the settled state needs a new marker: **the caption `◆ <version>`** (present at ≥ 74
columns from 550 ms on: `expect ◆ \d+\.\d+\.\d+` in expect syntax; `* \d+…` under `--ascii`). Below 74 columns
(64–73) the settle is detected structurally: a wordmark frame whose bottom row is the complete `RAW[4]` with no
`▓▒░` head and no band (the python check in `run-smoke.sh` `splash_settle` already parses frames).

| Test / probe | Today's assertion | Change |
| --- | --- | --- |
| `test/pty/smoke/splash.steps`, `splash-wide.steps`; `run-smoke.sh:239` `wordmark` check | wordmark cells before the key > 0, **0 after** | after the key: cells > 0 **and no `▓▒░` head** (the key completes the reveal); the idle frame is 11 rows |
| `test/pty/smoke/splash-settle.steps:6` (`expect ◆ jevcode`), `run-smoke.sh:91–104`, `:238–239` (`after_brand = 0`) | ≤ 15 wordmark frames, none at or after the brand row | `expect ◆ \d+\.\d+\.\d+`; ≤ 15 wordmark frames **before the caption frame**; every frame after it carries the mark; 0 loop frames within 5 s of settle (first pass at 6.45 s) |
| `test/pty/smoke/splash-reduced.steps`; `round2.pty.test.ts:429–438` | "no wordmark anywhere", idle frame 6 rows | the static mark from frame 0 (cells > 0 in frame 0, **no** `▓▒░`), 0 later wordmark frames, idle frame 11 rows |
| `round2.pty.test.ts:400–427` (splash 24×80 / 40×120) | after the echo frame no wordmark row; last frame 6 rows with `─── ◆ jevcode` | after the echo frame the **complete** mark; last frame 11 rows, rule row plain, caption present |
| `round2.pty.test.ts:440–461` (settle) | brand row frame; `all.at(-1).dynamic.length === 6` | caption frame as the settle mark; 11 rows |
| `round2.pty.test.ts:463–478` (run:start cancels) | no wordmark frame from `[run] start` on | unchanged in spirit: hidden while live; **add** "returns after `end`" |
| `round2.pty.test.ts:481–500` (`--ascii`) | `--- * jevcode 0.3.0 -` brand row in the plain text | the brand row appears only in hand-off states now; assert `* 0.3.0` caption instead and `#` letters after the key |
| `test/pty/helpers.ts:81–91` (`fullWidthRowStep`), `chat.pty.test.ts:232–237` | frames recognised by a full-width row | unaffected (the plain rule is full width) |
| `test/unit/tui/app.test.tsx:42–61` (H-A1 / H-A3) | after `splash:done`: 6 dynamic rows, `─── ◆ jevcode` | 11 rows, plain rule, `WORDMARK[4]` + `◆ <version>` on the last mark row |
| `test/unit/tui/round2-app.test.tsx:171–200` (finding 2: brand row until `run:ready`) | the rule row is the brand row through a submission | the rule row is the **plain rule** while the mark shows; the brand row appears at `run:start` (mark hidden) until `run:ready` — the "never flickers to the strip" assertion stays |
| `round2-app.test.tsx:243–270` (`]` opens a headed tab, Esc collapses to the brand row) | `dyn` length 6 after Esc | 11 (the mark returns) |
| `test/unit/tui/frames2.test.ts:106–131` (H-A3, H-B2, H-C1, H-G1, H-H2, H-I1 rule = `brandRow`) | brand row | `plainRule` for the boxed idle frames (H-J1 / H-J2 flat rows keep `brandRow`) |
| `test/unit/tui/splash.test.ts:59–68`, `103–118`, `134–146` | phases `fade` / `settled`; `[]` at t ≥ 700; fade steps | phases `reveal · shimmer · held`; rows at every t ≥ 0; no fade |
| `test/unit/tui/round2-reducer.test.ts:64–78` | every cancel row flips `splash` once | unchanged |
| `test/unit/tui/spinner.test.ts:109–116` | `useAnimation(` only in `motion.ts` | unchanged — the loop hook lives in `motion.ts` |
| `src/perf/render-lag.ts` splash bucket, `first-frame.ts` `splashOk` | unchanged | unchanged (frame 0 identical; no pass inside 700 ms) |
| `README.md:18`, `:101–102`, `:291`; `docs/TUI.md:56–62`, `:627–628`; TUI-DESIGN-2 §5 | "settles into the brand row … dies on your first key" | rewritten (proposal 8) |

---

## 5. (e) Version and badge near the wordmark

- **Version:** the caption `◆ 0.3.0` (`g.brand` + `VERSION` from `src/version.ts`, role `dim`) in the trailing cells
  of the mark's bottom row, two cells after the last `E`: cells `[offset + 58, offset + 67)`; drawn only when
  `columns ≥ 74` (§2.2 constants). It is the settle sentinel (§4) and it appears the moment the reveal completes (a key or
  550 ms). Below 74 columns the version is still in the brand row of every hand-off state and in `/version`.
- **Tagline (optional, one constant):** `Decisions, not strings` (owner's copy line) in `dim`, two cells after the mark
  on row 0, at `columns ≥ 104` — shown in mock F-W1w. `TAGLINE_ENABLED = true` is one line to flip; it is never in the
  band and never a transcript item.
- **Mode badge:** stays exactly where round 2 put it — the console's top edge one row under the mark
  (`╭─ jev+llm ──── proj ─╮`, `src/tui/Console.tsx:110–112`, `:180–186`, role `badge`), the word from `modeBadgeWord`
  (`lines.ts:107–109`). Nothing in `wordmark.ts` names a mode; when `DEFAULT_MODE` flips to the peer's `llm-jev` the badge
  row of that table changes and the wordmark does not.
- **Brand row** `─── ◆ jevcode 0.3.0 ───` (`splash.ts:156–158`) is kept verbatim for every state that hides the mark
  before the first `run:ready`, for < 64 columns and for the flat tier — one string, one formatter, as today.

---

## 6. (f) Mocks

Legend as in TUI-DESIGN-2 §4.10: rows above the rule are scrollback (cut with `…`), the rule row and everything below
are dynamic; every row was width-checked by the script that produced it. Colour: `JEV` `accent`, `CODE` `dim`, caption
and tagline `dim`, band `sweep`; the status texts are illustrative (`sess $0.00/10.00` is the jev-on session cap of the
owner's decision).

**F-W1. 24x80 idle, wordmark resting: 2 scrollback rows above, 11 dynamic rows (plain rule · 5 wordmark rows with the version caption · 5 console rows)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: openrouter · typesafe/jev-1.13-20260917 · key OPENROUTER_API_K
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W1w. 40x120 idle, wordmark resting with the tagline on row 0 (2 scrollback rows above, 11 dynamic rows)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: openrouter · typesafe/jev-1.13-20260917 · key OPENROUTER_API_KEY (dotenv:/Users/me/proj/.env) · about 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  ██████  ███████  Decisions, not strings
                                    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                                    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
                                ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
                                 ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                           step 0/–  sess $0.00/10.00 ok  ⎇ main · 3~ 1?  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**F-W2. 24x80 during a loop pass, frame k=6 (t = 1,500 ms into the pass): the band covers grid cells 18–23 (end of E, start of V) — colour only, no cell changes**

```
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
                              ^^^^^^  <- sweep band, frame k=6 (annotation)
```

**F-W3. 24x80 thinking (intake in flight, run `starting`): the wordmark stays; the spinner row is the only other dynamic row**

```
[you] hi
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › (thinking…)                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⠹ thinking                             step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W4. 24x80 live run after run:ready: the wordmark has handed off (pane 0); strip + 2 live rows + console = 8 dynamic rows (as today)**

```
[step 2] proposal edit src/parse.py · risk 0.12 ok · executed
─── ▸ jev s3 · 7 decisions · risk 0.12 ok · plan 1/4 ──────── [d] [p] [t] [s] ──
$ pytest -q
collected 3 items
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⠹ execute                         step 3/40 0m04s  run $0.02/2.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W5. 24x80 idle after a run: the strip keeps the rule row, the wordmark returns below it (11 dynamic rows)**

```
[run] end complete · 3 steps · $0.04
─── ▸ jev s3 · 7 decisions · risk 0.12 ok · plan 1/4 ──────── [d] [p] [t] [s] ──
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                  step 3/40  sess $0.04/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W6. 16x80 idle (budget 14): 11 dynamic rows fit; a 4-row draft, the palette or the review card hands the wordmark off (all-or-nothing)**

```
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W7. 12x80 flat tier: the static brand row, no wordmark, zero idle frames (3 dynamic rows, unchanged from today)**

```
─── ◆ jevcode 0.3.0 ────────────────────────────────────────────────────────────
› Say hi, ask a question, or describe a task…
jev+llm · idle                             step 0/–  sess $0.00/10.00 ok  ? help
```

**F-W8. 16x64, the narrowest wordmark geometry: no caption (needs ≥ 74 columns), no tagline (needs ≥ 104)**

```
────────────────────────────────────────────────────────────────
        ██ ███████ ██    ██  ██████  ██████  ██████  ███████
        ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
        ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
    ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
     ████  ███████   ████    ██████  ██████  ██████  ███████
╭─ jev+llm ───────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                │
├──────────────────────────────────────────────────────────────┤
│ idle                                        step 0/–  ? help │
╰──────────────────────────────────────────────────────────────╯
```


---

## 7. (g) Test plan

### 7.1 Unit (vitest `unit`, offline)

| File | Cases |
| --- | --- |
| `test/unit/tui/wordmark.test.ts` (new) | `loopBand(k)` equals the §2.2 table for k = 0…16 and is `null` outside; every frame ≤ 8 changed cells per row vs the previous frame and ≤ 40 in total; `wordmarkFrame` rows are exactly 5, each ≤ `columns` cells, letters never change between frames (colour only); caption present iff `columns ≥ 74`, at `[offset + 58, offset + 67)`, never inside a band span; tagline iff `≥ 104` and `TAGLINE_ENABLED`; `--ascii` twin is pure ASCII (`* 0.3.0`); `wordmarkWanted` truth table over `run × panel × picker × overlay × columns × boxed × screenReader × setting` (property test, 1,000 random inputs: wanted ⇒ boxed ∧ columns ≥ 64 ∧ ¬screenReader ∧ ¬runIsLive ∧ panel collapsed ∧ ¬picker ∧ overlay ≠ review ∧ setting ≠ off) |
| `test/unit/tui/splash.test.ts` | phases `reveal < 450 · shimmer < 550 · held`; rows at t = 700 and 10,000 equal the resting frame; frame 0 unchanged (H-A1 fixtures); no `fade` |
| `test/unit/tui/layout/layout.test.ts` | `paneWhole`: pane ∈ {0, want} for every input; `total ≤ budget`; the §0.4 table rows added to `TABLE` (`layout.test.ts:322–340`) at 8 / 12 / 16 / 24 / 40 rows: idle + wordmark → `1·0·0·5·0·0·0·1·1 = 11` at 16 / 24 / 40, `… 0 … = 6` at 16 with a 6-row draft, palette at 16 → pane 0; yield order unchanged; ≤ 5 µs |
| `test/unit/tui/motion.test.tsx` (new, real Ink renderer on `StubStdout`, the pattern of `key-immediate-render.test.tsx`) | `useIdleLoop` writes 16 frames in a pass and none in the rest (fake time via a 20 ms `LOOP_INTERVAL_MS` override); inactive under reduced motion / depth 0 / hidden / within 3 s of a key; `attention` tiers switch the rest interval; the subscriber count returns to 0 when hidden (`animationSubscribersRef.size` observed through frame counts) |
| `test/unit/tui/round2-reducer.test.ts` | `lastActivityAt` set by `key`, `run:end`, `chat-decisions` / reply, `panel`, resize; `splash` cancel rows unchanged |
| `test/unit/tui/app.test.tsx`, `round2-app.test.tsx`, `frames2.test.ts` | the §4 rewrites: 11-row idle frames, plain rule while the mark shows, brand row at `run:start`, strip + mark after `run:end`, `]` / Esc hand-off and return, reduced motion static mark from frame 0, `--ascii` caption |
| `test/unit/tui/spinner.test.ts` | unchanged allow-list (`useAnimation(` only in `motion.ts`) — fails if the hook lands elsewhere |

### 7.2 pty (`test/pty/smoke/*.steps` + `round2.pty.test.ts`, `--mock`, hermetic)

| Scenario | Geometry | Steps | Checks |
| --- | --- | --- | --- |
| `splash.steps` / `splash-wide.steps` (rewritten) | 24×80 / 40×120 | `expect step 0/` → sleep 0.1 → `send h` → `expect › h` | wordmark cells > 0 before and after the key; no `▓▒░` after the echo frame; idle frame 11 rows; 0 clears |
| `splash-settle.steps` (rewritten) | 24×80 | no key; `expect ◆ \d+\.\d+\.\d+`; `mark settled`; sleep 5 | ≤ 15 wordmark frames before the caption frame; caption at 500–900 ms; **0 frames** in the 5 s after settle (first pass at 6.45 s); 0 clears |
| `wordmark-idle.steps` (new) | 24×80 and 40×120 | settle; **sleep 12** | exactly one pass: 14–18 frames in [6 s, 11 s] after settle, ≤ 4 in any 1-s bucket, each ≤ 3 KB, band cells only in `sweep` SGR, letters unchanged, 0 clears, region 11 rows |
| `wordmark-key-during-pass.steps` (new) | 24×80 | settle; sleep 7.0 (mid-pass); `send h`; `expect › h`; sleep 3.5 | echo within 16 ms of the send (driver clock); the running pass finishes (≤ 10 more frames); no new pass within 3 s of the key |
| `wordmark-handoff.steps` (new) | 24×80 | `fix the failing test\r` → `expect \[run\] start` → `expect end` → `expect Follow-up` | no wordmark frame between `[run] start` and `end`; the frame after `end` has the strip **and** the mark (11 rows); `/panel\r` → mark gone, `▾ decisions`; `/panel off\r` → mark back |
| `wordmark-reduced.steps` (new; replaces `splash-reduced`) | 24×80 `--no-animation` | first frame; sleep 12 | frame 0 carries the complete mark and no `▓▒░`; 0 wordmark frames afterwards; idle 11 rows |
| `wordmark-16.steps` (new) | 16×80 | settle; type 3 lines (Alt+Enter) | mark hidden when the draft reaches 4 rows, back after Ctrl-C; never a partial mark (no frame with 1–4 wordmark rows) |
| `chrome-tiers.steps` (extended) | 24×80 → 12×60 → 24×80 | as today | no wordmark at 12×60 (brand row static), mark back at 24×80; clears ≤ 1 in the shrink segment |
| `wordmark-nocolor.steps` (new) | 24×80 `--no-color` | settle; sleep 12 | 0 idle frames (the loop is off at depth 0); the reveal still ran |

### 7.3 perf

- New probe `idle-frames` (`src/perf/idle-frames.ts`, `ProbeName` in `src/perf/main.ts:46–47`): `chat --mock` at 24×80 and
  40×120, 31 s idle after the first frame, typist driver with no keys; reports frames per 1-s bucket (max, mean), bytes/s
  (max, mean), wordmark frames, clears, region max, child CPU delta (`ps -o time` at 1 s and 31 s); gates fps ≤ 4 / mean
  ≤ 2, bytes ≤ 12 KB/s / 5 KB/s, clears 0, region ≤ rows − 2. One README row, one `latest.json` block.
- `composer-latency.ts`: add series `idle-loop` — 200 keys at 100 ms starting 200 ms into the first pass (the typist
  waits 6.65 s after the first frame); gated like `idle` (p95 < 16 ms, max < 50 ms).
- `render-lag.ts`, `first-frame.ts`, `intake-latency.ts`, `states.ts`: unchanged; re-baseline `latest.json`.

---

## 8. Proposals

1. **Split the wordmark out of the splash and make it persistent.** *What:* new pure module `src/tui/wordmark.ts`
   (resting frame, `loopBand`, `wordmarkFrame`, caption / tagline, `wordmarkWanted`, the constants table of §2.2);
   `src/tui/splash.ts` keeps the reveal and shimmer and gains `phase 'held'` in place of `fade` / `settled` — `splashFrame`
   returns the resting frame for every `t ≥ 550`, never `[]` at ≥ 64 columns; `SPLASH_MS = 700` stays as the `splash:done`
   moment (no pixel changes at 700). *Where:* `src/tui/splash.ts:17–22`, `:66–72`, `:103–138`; `src/tui/App.tsx:1916–1920`
   (`splashOn` → `wordmarkOn` from the selector), `:2044–2048` (render the resting / loop frame), `:2161–2190`
   (`SplashRow` reused). *Edge cases:* a key during the reveal completes it (the reducer still flips `splash`); below 64
   columns nothing changes; `--ascii` caption `* 0.3.0`; the caption is omitted below 74 columns, the tagline below 104;
   spans are computed on the 56-cell grid and rows right-trimmed afterwards (caption appended after the trim). *Tests:*
   `wordmark.test.ts`, `splash.test.ts` rewrites (§7.1), H-A1 fixtures unchanged. *Gate:* first frame unchanged (frame 0
   byte-identical, `wordmarkCells > 0`, `step 0/` < 300 ms).

2. **`computeLayout` 1.2 — whole-or-absent pane grant.** *What:* `LayoutInput.paneWhole?: boolean`; step 10 becomes
   `z.pane = i.expanded ? 0 : i.paneWhole ? (rem >= want ? take(want) : 0) : take(min(paneWant, CAP.pane))` with `want =
   min(paneWant, CAP.pane)`; the App sets `paneWhole: wordmarkOn` (the panel and picker keep partial grants as today).
   *Where:* `src/tui/layout.ts:76–100`, `:184`; `src/tui/App.tsx:1922–1938`. *Edge cases:* the wizard / intake / palette
   at 16–18 rows (table §0.4) hide the mark rather than cut it; `NaN` / `Infinity` inputs normalised by `size()` as today;
   yield order and every existing `TABLE` row unchanged. *Tests:* `layout.test.ts` invariants + rows (§7.1). *Gate:* `total
   ≤ budget` at every geometry; ≤ 5 µs per call.

3. **Visibility selector, hand-off, and the rule row.** *What:* `wordmarkWanted(input)` (§1.1) drives `paneWant = 5` +
   `paneWhole`; `ruleRowText` gains `wordmark: boolean` and returns `plainRule` while the mark shows, replacing the
   `splash === 'running'` branch; the brand row is returned exactly where it is today otherwise (`!ranBefore`), the strip
   after `run:ready`. `RuleRow` / `brandSpan` untouched. *Where:* `src/tui/Pane.tsx:24–63`; `src/tui/App.tsx:1980–1998`.
   *Edge cases:* `run === 'starting'` (thinking) keeps the mark; `run:start` hides it in the same commit (the run's
   `resetForRun` already flips `splash`, `useEngine.tsx:572`); `review` hides it before the layout would; picker forces
   `full`; Esc on an empty idle draft collapses the panel and brings the mark back; `/panel off` likewise; the setting
   `'off'` (proposal 7) hides it everywhere. *Tests:* `round2-app.test.tsx` finding-2 rewrite (brand row at `run:start` →
   strip at `run:ready`, mark at `run:end`), `frames2.test.ts` rule sources, `wordmark-handoff.steps`. *Gate:* zero
   clears (region ≤ rows − 2, verified by `states.ts` `resize-idle` and the new steps), dynamic fps during a run
   unchanged (the mark is never drawn while live).

4. **The idle loop hook in `motion.ts`.** *What:* `useIdleLoop(active, attention): { k: number; passing: boolean }` over
   `useAnimation` with two intervals (`LOOP_INTERVAL_MS` during a pass, `LOOP_REST_MS` / `LOOP_REST_CALM_MS` during the rest)
   and `isActive = active && !reducedMotion && depth > 0 && wordmarkOn && nowMs − lastKeystrokeAt ≥ 3,000 && attention !==
   'asleep'`; `k` is the hook's `frame` within the pass; a key during a pass does not deactivate the hook (the pass
   finishes), it only blocks the next pass. `UiState.lastActivityAt` (reducer: `key`, `run:end`, reply / `chat-decisions`,
   `panel`, geometry change) feeds the attention tiers. *Where:* `src/tui/motion.ts` (the only `useAnimation(` module,
   `spinner.test.ts:109–113`), `src/tui/useEngine.tsx:164`, `:415–418` (+ `lastActivityAt`), `src/tui/App.tsx:569–574`
   (mount next to `useMotion`). *Edge cases:* the hook resets its clock on interval / active changes (§0.3) so `k` is
   phase-local; SSH fps 15 unaffected (250 ≥ 67); `--no-animation` and the file key `ui.reducedMotion` at `setUi` stop it
   mid-pass (the next frame is the resting mark: one write); Ctrl-L repaint keeps the current frame; no tick is ever
   produced while hidden (subscriber count 0 → no `setTimeout` alive, `App.js:93–97`). *Tests:* `motion.test.tsx`,
   `wordmark-idle.steps`, `wordmark-key-during-pass.steps`, `wordmark-nocolor.steps`. *Gate:* idle dynamic fps ≤ 4 (peak),
   mean ≤ 2; composer p95 unchanged.

5. **Perf: the `idle-frames` probe and the `idle-loop` composer series.** *What:* §7.3. *Where:* `src/perf/idle-frames.ts`
   (new), `src/perf/main.ts:46–47`, `:184–215`, `src/perf/readme.ts` (two rows), `src/perf/composer-latency.ts:10–34`,
   `:57–60`, `test/unit/perf/*`. *Edge cases:* the probe must wait past the first pass start (6.45 s) and cover ≥ 2
   periods (30 s); the CPU delta uses `ps -o time` (10 ms resolution) and is reported, not gated; the stress profile does
   not apply. *Tests:* `test/unit/perf/idle-frames.test.ts` (bucketing, gate arithmetic on synthetic captures). *Gate:*
   fps ≤ 4 / ≤ 2 mean, bytes ≤ 12 / 5 KB/s, 0 clears, region ≤ rows − 2, composer `idle-loop` p95 < 16 ms.

6. **Tests and sentinels.** *What:* the §4 table — rewrite `splash*.steps`, `run-smoke.sh` `wordmark` / `splash_settle`
   checks (after-key cells > 0 and no head; settle = caption frame; `after_brand` → `frames_after_settle_5s = 0`), the
   `round2.pty.test.ts` splash block, `app.test.tsx` H-A3, `round2-app.test.tsx` finding 2 / `]`-Esc, `frames2.test.ts`
   rule sources, `splash.test.ts` phases; add the seven new `.steps` of §7.2 and `BRAND_STEP` → `CAPTION_STEP = 'expect ◆
   \\d+\\.\\d+\\.\\d+'` in `round2.pty.test.ts:81`. *Where:* listed per row in §4. *Edge cases:* 16×64 has no caption —
   its settle check is structural (complete bottom row, no `▓▒░`); `--ascii` uses `* \d+`. *Tests:* they are the tests.
   *Gate:* 0 expect timeouts, `restores = 1`, clears per scenario as today.

7. **A setting and a command (small, optional).** *What:* `ui.wordmark: 'sweep' | 'static' | 'off'` (default `'sweep'`)
   in the config schema and `jevcode config` table; `/wordmark [sweep|static|off]` (`inspect`, `any`; plain twin prints
   the value) so a user who finds the loop distracting can keep the mark still or drop it. *Where:* `src/config/**`
   (schema + defaults + `config-table.ts`), `src/tui/commands/registry.ts`, `docs/COMMANDS.md` via `scripts/gen-docs.mjs`.
   *Edge cases:* `'static'` still shows the mark and the reveal; `'off'` never grants the pane to the mark and never
   mounts the hook; the value arrives at `setUi` (after the first frame — frame 0 is unaffected, as `reducedMotion`
   today). *Tests:* config schema test, command registry test, one pty step (`/wordmark off\r` → 6-row idle frame).
   *Gate:* none new (the `'off'` frame equals today's idle frame).

8. **Docs.** *What:* TUI-DESIGN-3 section "Wordmark" (this report's §1–§3 condensed: state table, frame table, gates),
   `docs/TUI.md:56–62` ("settles into the brand row … dies on your first key" → "stays; the sweep loops every 10 s; a key
   completes the reveal"), `docs/TUI.md:627–628` (smoke list), `README.md:18`, `:101–102`, `:291`, the glossary rows
   "Rule row" / "Splash" in TUI-DESIGN-2 §12 (new strings: caption `◆ <version>`, tagline `Decisions, not strings`),
   `docs/DECISIONS.md` entry "The wordmark stays; the sweep loops at 4 fps peak, 1.6 fps mean, and sleeps", `CHANGELOG.md`
   0.4.0. *Where:* as listed. *Edge cases:* `docs/KEYS.md` / `docs/COMMANDS.md` regenerate from the registry if proposal 7
   lands. *Tests:* `readme.test.ts` rows; the §19.0 doc-sync test if it covers TUI-DESIGN sections. *Gate:* n/a.

Suggested order: 1 → 2 → 3 (one PR: the mark stays, static, all tests green) → 4 → 5 (the loop and its gates) → 6 runs
alongside each → 7 → 8.

---

## 9. Risks

- **CPU while idle.** ≈ 11 ms per written frame (upper bound, measured under load) means ≈ 18 ms/s ≈ 2 % of a core at
  the attentive cadence, ≈ 44 ms/s during a pass; today's idle is ≈ 5–11 ms/s. The decay tiers (30 s period after 60 s,
  static after 10 min) and the 3 s quiet-after-key rule bound it; the `idle-frames` probe reports the child's CPU so the
  first release run puts a real number in `latest.json`. If it reads > 30 ms/s mean, drop `LOOP_INTERVAL_MS` to 333 ms
  (3 fps, 12 frames per pass) — one constant.
- **Hand-off jumps at 16–18 rows.** The console moves 5 rows when the mark hides for a 4-row draft, the palette or the
  review card and returns afterwards; at ≥ 19 rows only the run and the panel move it. Documented; the alternative (a
  partial mark) is worse.
- **Test churn.** Twelve unit / pty tests and two smoke checks pin the collapse (§4). All are visual-only; no transcript
  identity test changes.
- **Merge overlap.** `src/tui/App.tsx:1915–1998` and `:2044–2048` are also where the peer's llm-jev branch and the
  round-3 pink / jev-on topics land (the badge in the console top edge, the theme table). The wordmark touches only roles
  and `modeBadgeWord`, so the overlap is textual, not semantic.
- **Reduced-motion first frame now carries wordmark cells.** `render-lag.ts` reports `splashWordmarkFrames` for the
  reduced-motion geometry (reported, not gated) and `first-frame.ts` gates `splashOk` only where a wordmark is expected;
  neither breaks, but `latest.json` and the README row text change.
- **Measurements ran beside a peer `jevcode perf`** (load 1.4–1.8; `README.md` and `perf/results/latest.json` were
  rewritten by that run at 15:47, not by this work). Frame and byte counts are timer-driven and unaffected; the CPU
  figures are upper bounds.

## 10. Open questions for the owner

1. After the first run, should the mark return under the strip (this design, mock F-W5) or stay hidden for the rest of the
   session so post-run screens keep the transcript in focus? One line in `wordmarkWanted` either way.
2. Tagline on by default at ≥ 104 columns (F-W1w), or off until the pink retheme lands?
3. Attention tiers: 10 s / 30 s / static-after-10-min — acceptable, or should the loop never sleep?
4. Should `--no-animation` show the static mark (this design) or keep today's brand-row-only frame (fewer rows for
   reduced-motion users who may also prefer less on screen)?
5. Proposal 7 (`ui.wordmark` + `/wordmark`) — worth the surface, or is `--no-animation` enough as the escape hatch?
