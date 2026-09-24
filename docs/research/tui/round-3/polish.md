# Round 3 — TOPIC R5: readability, pink polish and viral-worthy animations

Date 2026-09-21 · HEAD `626fc40` (round-2 tree, 0.3.0 pending its bump; `package.json` still reads 0.2.0, so the shipped brand row prints `◆ jevcode 0.2.0`) · author: research subagent, read-only pass — nothing under `src/` was changed. Every claim about the product carries a `file:line`; every claim about the captured frames names the capture and its line; external facts were fetched on 2026-09-21 and are marked as such; contrast ratios are computed with the WCAG 2.1 formula, not measured on a screen.

Owner decisions taken as given: the default engine mode becomes `jev-on` (badge `jev+llm`), `DEFAULT_MODE` stays one constant, TypeSafe native Jev stays preferred whenever `TYPESAFE_API_KEY` exists, the peer's `llm-jev` mode gets a badge-table entry (`llm+jev · verified`) and no string hard-codes which mode is the default. The mocks below therefore show the `jev+llm` badge and the jev-on caps (`run $x/2.00`, `sess $x/10.00`, `src/config/defaults.ts` via `resolve.ts:549-550` as the R3 report records); nothing in this report depends on the flip.

Standing constraints every proposal is checked against (§8 names the gate per proposal): first frame < 300 ms with zero network before it; zero clears outside shrink resizes; composer keystroke → frame p95 < 16 ms with key frames on Ink's immediate path (D-F, `src/tui/Transcript.tsx:59-65`); dynamic frames ≤ maxFps + 1 during a live run; `--plain` / `transcript.log` / TUI line identity for transcript items (text changes only in `itemsFromEvent` / `formatTranscriptItem`, `src/tui/plain.ts`); keys never printed or logged; no auto-approve; reduced motion (`--no-animation`, `JEVCODE_NO_ANIMATION`/`JEVCODE_REDUCED_MOTION`, `NO_COLOR`) and screen-reader mode keep working; the flat tier below 16 rows and the SSH fps-15 tier keep working; no new dependency; strict types.

---

## 0. Findings (measured on the captures and the code)

| # | Finding | Evidence | Fixed by |
| --- | --- | --- | --- |
| F1 | **The wordmark vanishes at 700 ms.** `splashFrame` returns `[]` once `phase === 'settled'` (`src/tui/splash.ts:106`), `paneWant` drops to 0 (`src/tui/App.tsx:1916-1920`) and the 5-row slot collapses into the one-line brand row `─── ◆ jevcode 0.2.0 ───` (`auto-24x80.txt:169-170`). A key before 700 ms kills it outright (`useEngine.tsx:415-419` `endSplash` on `key`). The user asked for the mark to stay. | `auto-24x80.txt:160-175`, `auto-40x120.txt:160-170` | P1 |
| F2 | **Two frames of wrong chrome after every Enter.** Between the submit and the `[you]` bubble the status word reads `starting` and the placeholder flips to `Type to steer the next step…  Esc pauses` (at 120 columns also `Esc Esc aborts`), then back to `(thinking…)`. Cause: `composerMode` reads `state.run !== 'none' ? 'steer'` (`App.tsx:1961-1962, 1972-1973`) while `run` is already `'starting'` (`send()` dispatches `run:starting` before the controller's `thinking` phase arrives) and `leftWord` returns `'starting'` for the same state (`src/tui/status/lines.ts:336`). TUI-DESIGN-2 records it as deviation 4 and leaves it. | `auto-24x80.txt:183-187, 313-318`; `auto-40x120.txt:178-182` | P7 |
| F3 | **Continuation rows without indent.** A `[ui]` item's `detail` rows render as bare `<Text>` at column 0 (`Transcript.tsx:127-131`), so `/jev`, `/cost` and the run epilogue read as four or five unrelated lines: `[ui] jev` / `typesafe · api.typesafe.ai · …` / `questions 0 · …` (`auto-24x80.txt:264-267`); `[ui] stopped — replan_stop (exit 4)` / `run       2026…` / `files     /tmp/…/  ` / `(transcript.log, state.json, jevcode.log)` / … (`auto-24x80.txt:1351-1356`). The detail row is also word-wrapped by Ink at the full width, so `(transcript.log, …)` and `locally; nothing is sent)` land at column 0 on their own rows. | `auto-24x80.txt:264-267, 1351-1356, 1380-1382, 1404-1410` | P3, P13 |
| F4 | **Orphaned wraps in the compact step rows.** `[step 1] … · risk 0.00 ok · tests ` / `4p/3f/0e · judge 0.49 · 4.9s · $0.006` (the word `tests` is separated from its value), `[step 2] … · risk ` / `0.76 [block] · blocked …`, `[step 4] … · risk 0.99 [block] · ` / `blocked · 0.7s · $0.002`. The rows are the item word-wrapped by Ink at spaces (`Transcript.tsx:118-126`); the ` · ` segment separators are not preferred break points. | `auto-24x80.txt:657-658, 861-862, 968-969, 1099-1100` | P4 |
| F5 | **`[run] end … exit` / `4`.** The run-end line is 76 cells of text after a 6-cell gutter at 80 columns, so the last token wraps alone: `[run] end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit` / `       4`. At 120 columns the `[run] warn: stop: … (already directed at step ` / `      5))` row shows the same failure. | `auto-24x80.txt:1349-1350`; `auto-40x120.txt` run-end block (`[run] warn: stop:` row) | P4, P5 |
| F6 | **Machine tokens in the conversation.** `start 20260921-212813-uo5luiq4 mode=jev-only task: …` (`plain.ts:310`), `end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit 4` (`plain.ts:400-410`), `replan gather_context p=0.62 c=0.54 impossible=0.20: After repeating … (p=0.62, task_impossible=0.20): …` (the numbers twice, `plain.ts:347`), `loop tripped: done:063b9cc65e6c x3` (`plain.ts:345`), `~$5.5e-6 each` in `/cost` (`src/tui/budget/lines.ts:341`). The 24-character run id appears in `[run] start`, the epilogue (three times) and the status centre. | `auto-24x80.txt:335, 1098, 1115, 1316, 1349, 1352-1356, 1409` | P5, P13 |
| F7 | **The `[sandbox]` paragraph on the first screen.** Three rows at 80 columns, two at 120, before the user has typed anything (`sandboxText`, `src/tui/onboarding/lines.ts:291-295`). | `auto-24x80.txt:13-15`; `auto-40x120.txt:13-14` | P12 |
| F8 | **The loop banner survives the run.** `loop  replan 2/5 s10 gather_context p 1.00 imp .16` stays on screen after `[run] end` through `/jev`, `/cost` and `/exit`. `state.loop` is reset at run start and on `steer:applied` (`useEngine.tsx:547, 691`) but not in the `run:end` branch; `bannerRow` (`src/tui/pane/banner.ts:115-125`) draws whatever is there. | `auto-24x80.txt:1358-1431`; `auto-40x120.txt` after `[run] end` | P8 |
| F9 | **The status row after a run is a yellow bold bar.** `statusRole` returns `warn` for any non-`complete` stop and the Console applies it to the whole row (`src/tui/StatusLine.tsx:66-69`, `src/tui/Console.tsx:174-200`): `idle exit 4   step 9/40 0m14s  run $0.03/0.25 ok  sess $0.03/1.25 ok  ? help` all bold yellow. The live spinner glyph is uncoloured (the status row is one string, `statusLineText`, `status/lines.ts:566-588`). | `auto-24x80.txt:1360-1431` | P6, P8 |
| F10 | **Dense status row.** Two meters with their word (`run $0.01/0.25 ok  sess $0.00/1.25 ok`), `? help`, the git zone `⎇ main · 1092?` and a 12-cell sparkline at 120 columns: 7 segments (`status/lines.ts:443-472`). The `1092?` is the demo's `.venv`; the meters repeat `ok` twice. | `auto-40x120.txt` live frames | P6 (colour only), §4 |
| F11 | **Ragged left edge.** Bodies start at column 6 (`[run]`, `[you]`), 5 (`[ui]`), 9 (`[step 1]`), 10 (`[step 10]`, `[jevcode]`, `[sandbox]`): the hanging indent is `label.length + 1` per item (`Transcript.tsx:2-6, 118-126`). | every capture | P3 |
| F12 | **The palette is blue/cyan.** `accent` `#7DD3FC` (cyan-300), `badge` bold cyan, `borderFocus` `#38BDF8`, `you` `#A5B4FC` (indigo-300), `sweep` `#E0F2FE`, `ok` `#4ADE80` (`src/tui/theme.ts:90-114`); the light theme moves the warning family to blue (`theme.ts:117-133`). No pink anywhere; the `assistant` role has no colour (`theme.ts:107`). | code | P2 |
| F13 | **Copy names Claude where GLM runs.** `mode jev+llm from the next run — Claude writes the code…` (`src/cli/session.ts:241`), `WHAT_IT_IS_TEXT` and `HOW_TO_TASK_SUFFIX['jev-on']` (`src/chat/facts.ts:110, 118, 126`); the default generator is `z-ai/glm-5.3-flash`. The R3 report's F9 records the same; listed here because the strings are transcript text. | `auto-24x80.txt:238-245, 286-287` | P14 (with R3 P11) |
| F14 | **The badge word table exists but is split.** `modeBadgeWord` (`status/lines.ts:107-109`) and `modeWord` (`src/chat/replies.ts:98-100`) each map `EngineMode → word`; `llm-jev` maps to `llm-jev` in both; `theme.ts:108` hard-codes `marker: 'jev-only'` for the `badge` role. | code | P14 |
| F15 | **Frame numbers at HEAD (the budget the proposals spend).** First frame 99–172 ms live, 122–131 ms cold p95 in `perf` (`docs/STATUS.md` Round 2 tables); splash 15 wordmark frames in 700 ms; `dynamic` 18–21 frames/s live (gate 31); composer p95 5.3–6.7 ms idle/live/palette (gate 16); clears 0; `hi` → `[jevcode]` 240–265 ms live. | `docs/live/tui/round-2/README.md`, `docs/STATUS.md:697-780`, `perf/results/latest.json` | §8 gates |
| F16 | **The typesafe.ai palette, confirmed on the live page (curl, 2026-09-21).** `rgb(30,30,30)`/`#1e1e1e` ×514 (background), `rgb(222,222,222)`/`#dedede` ×61, `rgb(243,134,161)`/`#f386a1` ×52 (the pink), `rgb(254,254,254)`/`#fefefe` ×79, `rgb(196,196,196)` ×15 (= `#c4c4c4`), `#e5e5e5` ×6, `#d45bb6`/`rgb(212,91,182)` ×6, `#abbab9` ×3, `#09aea1` ×1, `#03aa5c` ×1; fonts `Inter`, `JetBrains Mono`, `Fragment Mono` (the task's `Die Grotesk C` is not in the HTML; it may be loaded by CSS). The primary pink is used ~9× more than the magenta: pink is the accent, magenta is the secondary. | Appendix B | P2 |

---

## 1. What was read and measured

- Captures: `docs/live/tui/round-2/auto-24x80.txt` (1,431 lines, one frame every ~50 ms while the splash ran, then per commit) and `auto-40x120.txt` (1,216 lines), both SGR-stripped; the timing in `auto-24x80.jsonl` (first frame 146 ms, `hi` → `[jevcode]` 265 ms, task → `[run] start` 180 ms, run 14.7 s) and the README table (`docs/live/tui/round-2/README.md`). Zero rows wider than the geometry in either capture (the README's own count; re-checked with `awk 'length > 80'` on the 24×80 file: 0 hits after code-point counting).
- Code: `src/tui/App.tsx` (2,378 lines: `liveLines` 185-202, the splash wiring 570-573 and 1916-1920, `composerMode` 1952-1979, the rule row 1981-2001, `RuleRow` 2142-2159, `SplashRow` 2161-2196), `src/tui/Transcript.tsx` (156), `src/tui/plain.ts` (1,001: `itemsFromEvent` 291-413, `stepSummaryText` 464-485, `formatTranscriptItem` 487-489, `sessionHeaderItem` 841-844), `src/tui/console-lines.ts`, `src/tui/card.ts`, `src/tui/status/lines.ts` (588), `src/tui/pane/*.ts` (1,006), `src/tui/review/lines.ts` (360), `src/tui/spinner.ts` (82), `src/tui/splash.ts` (179), `src/tui/motion.ts` (28), `src/tui/theme.ts` (239), `src/tui/glyphs.ts` (474), `src/tui/toasts.ts` (258), `src/tui/layout.ts` (204), `src/tui/Console.tsx`, `src/tui/StatusLine.tsx`, `src/tui/Review.tsx`, `src/tui/Overlay.tsx`, `src/tui/Pane.tsx`, `src/tui/useEngine.tsx` (1,024), `src/tui/composer/Composer.tsx` (placeholders 53-122), `src/chat/replies.ts`, `src/chat/facts.ts`, `src/chat/bubbles.ts`, `src/chat/lines.ts`, `src/cli/epilogue.ts` (154), `src/cli/session.ts` (the `block()` helper 1215-20 20 12 61 79 80 81 33 98 100 204 250 395 398 399 400 701 (1215+8) ), `/jev` 2515-2530, `/cost` 2479-2485), `src/tui/budget/lines.ts` (`costBlock` 322-20 20 12 61 79 80 81 33 98 100 204 250 395 398 399 400 701 (322+36) )), `src/tui/onboarding/lines.ts`, `src/tui/blocking/lines.ts`, `src/perf/{first-frame,render-lag,composer-latency,states}.ts`.
- Docs: `docs/TUI-DESIGN-2.md` §4 (frames H-A1…H-I1w at 1036-1447), §5 (splash), §9 (gates); `docs/TUI.md:270-348`; `docs/STATUS.md` Round 2; the round-2 visual design `docs/research/tui/round-2/design-visual.md`; the existing research notes on opencode (`docs/research/tui/01-opencode.md`), Claude Code, Gemini CLI and conventions (`06-tui-conventions.md` §13).
- External (2026-09-21): typesafe.ai (curl, Appendix B); charm `bubbles/spinner/spinner.go` and `progress/progress.go`; `lipgloss` README; opencode `docs/themes` and `docs/tui`; Gemini CLI `docs/cli/themes`; gh-dash `configuration/theme`; Claude Code `interactive-mode`, `statusline`, `terminal-config` (Appendix A).

---

## 2. Row-by-row critique of the captured frames (deliverable a)

### 2.1 `auto-24x80.txt`

| Rows | What the frame shows | What is wrong | Fix |
| --- | --- | --- | --- |
| 1 | `[run] jevcode session · JevCode | step 0/– starting` | The session header wears the `[run]` label although no run exists (`sessionHeaderItem` is kind `run:start`, step null → `stepLabel` → `[run]`, `plain.ts:841-844`). `| step 0/– starting` duplicates the status row's sentinel one frame later. It is a synthetic item printed by the TUI and `--plain` alike (never in `transcript.log`). | P13c (optional text change), P3 (gutter) |
| 2-7 | plain rule + the wordmark's `J` and `▓▒░` head | Good: frame 0 is the splash; the console is complete in the same frame. The rule above the wordmark is a bare `─` row — one of three rule styles on screen within a second (plain, brand, strip). | P1 keeps the plain rule only while the mark animates |
| 8 | `╭─ jev-only ──…── JevCode ─╮` | Fine. The badge is cyan bold; it will be pink (P2). | — |
| 9 | `│ › Say hi, ask a question, or describe a task…` | Good copy. At 80 columns the `/ commands · @ files` hint is dropped (needs ≥ 100 inner cells, `Composer.tsx:80`). | — |
| 11 | `│ idle … step 0/–  ? help │` | Fine as a first frame (no session meter yet, by design §5.3). | — |
| 13-15 | `[sandbox] seatbelt — writes confined to the workspace and run dirs; harness ` / `secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network ` / `allowed unless --no-network` | Three rows of policy prose before any interaction; trailing spaces on rows 13 and 14 (Ink's wrap leaves the separator); the hanging indent (10) does not line up with the header row's body (column 6). | P12, P3 |
| 160-168 | the complete wordmark for one frame; the status row now carries `sess $0.00/1.25 ok` | The mark is at its best here — and it is gone on the next commit. | P1 |
| 169-175 | `─── ◆ jevcode 0.2.0 ───…` + console | The 5 wordmark rows collapse: the console jumps up five rows 700 ms after start. Version `0.2.0` on a 0.3.0 tree. | P1; release bump |
| 183-187 | `│ › Type to steer the next step…  Esc pauses` / `│ starting …` | The wrong-chrome flash of F2, for one or two frames after every Enter. | P7 |
| 189 | ` ` / `[you] hi` | Good: spacer, dim label, the body in the `you` colour. Body starts at column 6. | P3 (column 10, label bright) |
| 190-206 | `│ › (thinking…)` + `⠋ thinking` … `⠹ thinking` | Braille at 8 fps, uncoloured. Three frames captured ≈ 250 ms. | P6 (pink pulse) |
| 209-210 | `[jevcode] Hi. I'm ready when you are — describe a change you want in` / `          jevcode-r2-ws-yOYIvP, or ask what I can do.` | Good hanging indent; the label is dim like every other label, so the assistant's voice has no colour of its own. | P2 (`assistant` pink) |
| 214 | `│ › Follow-up, question, or /command…` | Good. | — |
| 238-245 | two `[jevcode]` facts, 4 rows each | Eight rows for "what can you do?"; the second fact's last row is a 12-cell orphan `with /mode jev-on.`; "Claude writes the code" under a GLM default. | P14 (copy), §4 length rule |
| 264-267 | `[ui] jev` / `typesafe · api.typesafe.ai · jev-1.13.0 (pinned)` / `questions 0 · latency p50 — · p95 — · jev cost $0.000` / `intake: 2 messages · p50 118 ms · $0.0004 · last: question_about_this_tool 1.00` | F3: the three detail rows sit at column 0, indistinguishable from new items; `question_about_this_tool 1.00` is an internal key with a probability. | P3, P13 |
| 286-287 | `[ui] mode jev+llm from the next run — Claude writes the code, Jev still decides ` / `     every step (persist: jevcode config set mode jev-on)` | 2 rows for a mode switch; trailing space; "Claude". | P14 |
| 289 | `╭─ jev+llm · next run ───…` | Good: the pending badge in the top edge. | — |
| 321 | `[you] Fix the failing tests in tests/test_core.py without changing the tests.` | Good. | — |
| 335-336 | `[run] start 20260921-212813-uo5luiq4 mode=jev-only task: Fix the failing tests` / `      in tests/test_core.py without changing the tests.` | The 24-char id and `mode=` before the task; the task repeats the bubble two rows above (needed in `transcript.log`, which starts here). | P5 (id last, `·` separators) |
| 337 | `[run] git main · 1092 untracked` | Fine (the 1092 is the demo `.venv`). | — |
| 338 | `─── ▸ jev s0 · 63 decisions ───…─── [d] [p] [t] [s] ──` | The strip appears at once; `63 decisions` before step 1 (the intake's Noul rows). Bracketed letters look like hot keys but are labels (TD §3.1). | P9 (sweep), §4 |
| 340-345 | `│ starting   20260921-212813-uo5luiq4    step 0/40 …` | The run id as the status centre for one frame. | §4 (centre shows the title only) |
| 657-658 | `[step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok · tests ` / `         4p/3f/0e · judge 0.49 · 4.9s · $0.006` | F4: `tests` orphaned from `4p/3f/0e`; trailing space. | P4 |
| 691 | `synth goal: g1: fix issue::d577757d in calc/core.py (1 test, attempt 1, picked …` | The live row is useful but reads as a log line: two colons, a hash, cut at 79. | §4 (live-row style), no text change needed (dynamic) |
| 861-862 | `[step 2] patch 9 line unified diff "apply best-guess fix (no reprod…" · risk ` / `         0.76 [block] · blocked · 4.3s · $0.005` | F4: `risk ` orphaned; the goal quote is clipped at 32 chars mid-word (`STEP_GOAL_CHARS`, `plain.ts:420`). | P4; keep the clip (text) |
| 962 | `loop  patch:diff  x2/3` | Two spaces as separators, a signature kind, `x2/3` — cryptic; whole row yellow. | P8 (clear at run end), §4 copy `loop · patch repeated 2 of 3` (dynamic row, no identity cost) |
| 1098-1100 | `[step 6] loop tripped: done:063b9cc65e6c x3` / `[step 6] done partial: … · risk 1.00 [block] · ` / `blocked · 0.7s · $0.002` | Hash in the transcript; `· ` orphan. | P5, P4 |
| 1115-1119 | `[step 7] replan gather_context p=0.62 c=0.54 impossible=0.20: After repeating the same done proposal 3 times, Jev directs \`gather_context\` (p=0.62, task_impossible=0.20): …` (5 rows) | The numbers appear twice (the k=v head and Jev's prose); five yellow rows. | P5 (head form), §4 |
| 1316-1324 | two `[step 10] replan …` items, 9 rows | Same, plus nested parentheses `(… (already directed at step 7); treated as stop_and_report (DESIGN §5.5: …))`. | P5 |
| 1345-1346 | `[run] warn: stop: replan_stop at step 9 (gather_context directed again for ` / `      done:063b9cc65e6c (already directed at step 7))` | `warn: stop:` double prefix; the same hash a third time. | P5 |
| 1349-1350 | `[run] end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit` / `       4` | F5: the worst orphan on the screen, on the most important line of the run. | P4, P5 |
| 1351-1356 | `[ui] stopped — replan_stop (exit 4)` / `run       2026…` / `files     /tmp/…/  ` / `(transcript.log, state.json, jevcode.log)` / `resume    jevcode run --resume 2026…` / `report    jevcode report 2026…   (redacted bundle written ` / `locally; nothing is sent)` | F3: the epilogue's table (`epilogueRows`, `src/cli/epilogue.ts:75-82`, labels `padEnd(10)`) is a TUI `detail`; the rows are unindented and wrapped at column 0. The id three times. | P3, P13 |
| 1357-1358 | strip + `loop  replan 2/5 s10 gather_context p 1.00 imp .16` | F8: the banner outlives the run. | P8 |
| 1360-1362 | `│ idle exit 4   step 9/40 0m14s  run $0.03/0.25 ok  sess $0.03/1.25 ok  ? help │` | F9: the whole row bold yellow; the run meter stays after the run. | P6 spans, P8 |
| 1379-1382 | `[ui] jev` + 3 rows (`… (pinned) → resolved jev-1.13.0`, `questions 4606 · latency p50 424 ms · p95 424 ms · jev cost $0.025`, `intake: 3 messages · …`) | F3. `p50 424 ms · p95 424 ms` after 4,606 questions is plausibly the last request's latency reported twice — worth a look by the owner of `/jev`; not a rendering matter. | P3, P13 |
| 1404-1410 | `[ui] run $0.025 of $0.250 (10 %)` / `session $0.03 of $1.25 (2 %, 1 run)` / `per step p50 $0.002 · last $0.002 · about 108 steps left` / `jev $0.025 for 4,606 questions (~$5.5e-6 each, p50 424 ms)` / `basis: jev provider usage.cost` / `raise: /budget spend-cap <usd> · /budget session-spend-cap <usd|none>` / `chat $0.0005 for 3 messages (~$1.8e-4 each, p50 118 ms)` | The block's first row is its head, so `[ui]` labels `run $0.025 of $0.250` rather than `cost`; `5.5e-6`; six unindented rows. | P13 |
| 1418 | `│ › /exit` | Fine. | — |

### 2.2 `auto-40x120.txt` (what the width adds or changes)

| Rows | Frame | Critique |
| --- | --- | --- |
| 9 | `│ › Say hi, ask a question, or describe a task…  …  / commands · @ files │` | The right-aligned hint is the best row of the first frame: two ideas, one row, dim. Keep. |
| 13-14 | `[sandbox] …` | Two rows; still a paragraph. |
| 169 | `─── ◆ jevcode 0.2.0 ───…` (120 rules) | 100 cells of rule for 16 cells of content. P1 adds the tagline; the rule still dominates. |
| 178-182 | `│ › Type to steer the next step…  Esc pauses   Esc Esc aborts` / `│ starting …` | F2 with the wide hint: three wrong hints in one flash. |
| 202 | `[jevcode] Hi. I'm ready … jevcode-r2-ws-gZw7Zz, or ask what I can do.` | One row: the reply catalogue's 160-char cap fits at 120. |
| 214 | `│ › Follow-up, question, or /command…  …  ↑ history · Esc Esc menu │` | Good. |
| 236-240 | two facts, 3 rows each | Six rows; fine at this width. |
| 339 | `─── ▸ jev s0 · 63 decisions ──…── [d]ecisions [p]lan [t]imeline [s]ynth ─────` | The long labels read as menu items; 35 cells of tail. |
| live status rows | `│ ⠋ execute           step 0/40 0m03s  run $0.01/0.25 ok  sess $0.00/1.25 ok  ⎇ main · 1092?  jev ▄▄▂▁▂▂▁▁▂▂▃▁  ? help │` | Seven segments, two `ok`, a 12-cell sparkline that reads as noise without a scale; `1092?`. The gap after the left word is the empty centre. |
| `[step 1] …` | one row of 114 cells | Good: at 120 the step line is exactly what §4.5 designed. |
| `[run] warn: stop: replan_stop at step 7 (… (already directed at step ` / `      5))` | F5 at 120: the orphan `5))`. |
| `[run] end replan_stop steps=7 wall=9s cost=$0.020 (gen $0.000, jev $0.020) exit 4` | Fits on one row here; the k=v tokens remain. |
| epilogue | `files     /tmp/jevcode-r2-home-OS4MIZ/runs/20260921-212834-6nl3fcv7/  (transcript.log, state.json, jevcode.log)` | Fits; still unindented under `[ui]`. |
| after `[run] end` | `loop  replan 2/5 s8 gather_context p 1.00 imp .18` on every later frame | F8. |

### 2.3 Replacement frames

Legend: rows above the rule are `<Static>` scrollback drawn with the 10-cell right-aligned label gutter (P3); every dynamic row is inside `rows − 2`. Colour is written beside each frame (`pink` = `#f386a1`, `magenta` = `#d45bb6`, `grey` = `#abbab9`, `dim` = the terminal's faint attribute). Every row below was width-checked by script at its geometry (24×80 → 80 cells, 40×120 → 120 cells); box rows are exactly the width.

**R-1. Hero (idle before the first turn), 24×80 — 12 dynamic rows; replaces `auto-24x80.txt:169-175`.** The wordmark stays after the 700 ms reveal: `JEV` pink, `CODE` grey, the tagline dim and right-aligned to the mark's right edge, the plain rule above it dim. Badge pink bold; `›` default; placeholder dim; status default.

```text frame80
    [run] jevcode session · JevCode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████
                                              Decisions, not strings
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-1w. Hero, 40×120 — 12 dynamic rows.** The mark is centred at column 32; the hint `/ commands · @ files` and the git zone appear at this width.

```text frame120
    [run] jevcode session · JevCode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                                    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                                    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
                                ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
                                 ████  ███████   ████    ██████  ██████  ██████  ███████
                                                                  Decisions, not strings
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                           step 0/–  sess $0.00/10.00 ok  ⎇ main · 3~ 1?  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-2. Thinking, 24×80 — 6 dynamic rows; replaces `auto-24x80.txt:189-206` (and the F2 flash at 183-187).** The hero ended at the first submission; the brand row now carries the tagline. The `[you]` label is bright (`#fefefe`, bold), its body default. The spinner is the pink shade pulse (P6); the placeholder `(thinking…)` is shown from the very first frame after Enter (P7).

```text frame80
    [run] jevcode session · JevCode | step 0/– starting

    [you] hi
─── ◆ jevcode 0.3.0 · Decisions, not strings ───────────────────────────────────
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › (thinking…)                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ thinking                             step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-2w. Thinking, 40×120.**

```text frame120
    [run] jevcode session · JevCode | step 0/– starting

    [you] hi
─── ◆ jevcode 0.3.0 · Decisions, not strings ───────────────────────────────────────────────────────────────────────────
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › (thinking…)                                                                                                        │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▓ thinking                                                     step 0/–  sess $0.00/10.00 ok  ⎇ main · 3~ 1?  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-3. Chatting (the reply), 24×80 — 6 dynamic rows; replaces `auto-24x80.txt:209-215`.** `[jevcode]` label pink bold, body default; the wrap hangs under column 10; the first row is exactly 80 cells (the wrap point is unchanged: the gutter is 10 for both labels).

```text frame80
    [you] hi

[jevcode] Hi. I'm ready when you are — describe a change you want in JevCode, or
          ask what I can do.
─── ◆ jevcode 0.3.0 · Decisions, not strings ───────────────────────────────────
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-3w. Chatting, 40×120.** One intake latency sample fills the sparkline's last cell.

```text frame120
    [you] hi

[jevcode] Hi. I'm ready when you are — describe a change you want in JevCode, or ask what I can do.
─── ◆ jevcode 0.3.0 · Decisions, not strings ───────────────────────────────────────────────────────────────────────────
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                         step 0/–  sess $0.00/10.00 ok  ⎇ main · 3~ 1?  jev            ▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-4. Run live, 24×80 — 7 dynamic rows; replaces `auto-24x80.txt:335-345, 657-700`.** The 71-character task bubble now wraps at 80 (the gutter costs `[you]` rows four cells against today — see P3); the `tests.` continuation is 6 cells, inside V7's bound but the visible price of alignment. `[run] start` puts the id last (P5); the step row breaks before ` · ` and the separator leads the continuation (P4); the strip's `▸` and `jev` are pink, the rest dim; the console edges are magenta while live; the `›` prompt pink; the spinner pink; the live `synth` row dim.

```text frame80
    [you] Fix the failing tests in tests/test_core.py without changing the
          tests.

    [run] start jev-on · Fix the failing tests in tests/test_core.py without
          changing the tests. · run 20260921-212813-uo5luiq4
    [run] git main · 1092 untracked
 [step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok
          · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006
─── ▸ jev s1 · 75 decisions · risk 0.00 ok · plan 0/2 ─────── [d] [p] [t] [s] ──
synth goal: g1: fix issue::d577757d in calc/core.py (1 test, attempt 1, picked …
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › Type to steer the next step…  Esc pauses                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ context    step 1/40 0m05s  run $0.01/2.00 ok  sess $0.01/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-4w. Run live, 40×120 — 7 dynamic rows.** The step row is one line here; the strip shows the long labels and `jev 146ms`. `[run] start` breaks before `· run <id>` (P4) even at this width.

```text frame120
    [you] Fix the failing tests in tests/test_core.py without changing the tests.

    [run] start jev-on · Fix the failing tests in tests/test_core.py without changing the tests.
          · run 20260921-212834-6nl3fcv7
    [run] git main · 1092 untracked
 [step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok · tests 4p/3f/0e · judge 0.45 · 3.6s · $0.006
─── ▸ jev s1 · 75 decisions · risk 0.00 ok · plan 0/2 · jev 146ms ────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
synth goal: g1: fix issue::d577757d in calc/core.py (1 test, attempt 1, picked 3 of 137 candidates)
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › Type to steer the next step…  Esc pauses   Esc Esc aborts                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▓ context          step 1/40 0m03s  run $0.01/2.00 ok  sess $0.01/10.00 ok  ⎇ main · 1092?  jev ▄▄▂▁▂▂▁▁▂▂▃▁  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-5. Review card, 24×80 — 19 dynamic rows; the design's H-F1 with the gutter and the arm rule (P11).** Edges yellow (`review`); the keys row is dim until the card is armed (≈150 ms or the flush), then bold yellow; gauge bars default; preview dim. The `[step 6]` row above now wraps at the ` · ` before `judge`.

```text frame80
 [step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e
          · judge 0.61 · 2.4s · $0.031
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] ──────────── [d] [p] [t] [s] ──
╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "make parse_date timez… ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)     │
│ 1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…  │
│ 2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task a… │
│ 3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification… │
│ 4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restora… │
│ 5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of…  │
│   --- old                                                                    │
│   return datetime.strptime(s, FMT)                                           │
│   +++ new                                                                    │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)              │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › (review pending — keys in the card; d opens a note)                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ review       step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-5w. Review card, 40×120 — 19 dynamic rows (H-F1w with the gutter).**

```text frame120
 [step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e · judge 0.61 · 2.4s · $0.031
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 · jev 244ms ──── [d]ecisions [p]lan [t]imeline [s]ynth ─────
╭─ review · step 7 · risk 0.44 (tail on plan_mismatch) · edit src/a.py "make parse_date timezone-aware" · jev 244ms ───╮
│ [y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline         [ctrl-c] abort run │
│ dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k… │
│ 1 destructive  L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recover… │
│ 2 out_of_scope L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]`/`task` a… │
│ 3 plan_mismatch L2 ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step                │
│ 4 irreversible L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git c… │
│ 5 matches_intent   ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`   │
│   --- old                                                                                                            │
│   return datetime.strptime(s, FMT)                                                                                   │
│   +++ new                                                                                                            │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › (review pending — keys in the card; d opens a note)                                                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ review                               step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-6. Run end, 24×80 — 6 dynamic rows; replaces `auto-24x80.txt:1349-1362`.** `[run] end` in the `·` form (P5) breaks before `· exit 4` (P4); the epilogue's four detail rows are indented under the label column and their own values (P3/P13); the loop banner is gone (P8); only the left word `idle exit 4` is coloured (yellow, P6), the edges are back to dim.

```text frame80
    [run] end replan_stop · 9 steps · 14s · $0.025 (gen $0.000, jev $0.025)
          · exit 4
     [ui] stopped — replan_stop (exit 4)
          run       20260921-212813-uo5luiq4
          files     ~/.jevcode/runs/20260921-212813-uo5luiq4/
                    (transcript.log, state.json, jevcode.log)
          resume    jevcode run --resume 20260921-212813-uo5luiq4
          report    jevcode report 20260921-212813-uo5luiq4
                    (redacted bundle written locally; nothing is sent)
─── ▸ jev s9 · 75 decisions · risk 0.99 [block] ───────────── [d] [p] [t] [s] ──
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4  step 9/40 0m14s  run $0.03/2.00 ok  sess $0.03/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-6w. Run end, 40×120 — 6 dynamic rows.**

```text frame120
    [run] end replan_stop · 7 steps · 9s · $0.020 (gen $0.000, jev $0.020) · exit 4
     [ui] stopped — replan_stop (exit 4)
          run       20260921-212834-6nl3fcv7
          files     ~/.jevcode/runs/20260921-212834-6nl3fcv7/  (transcript.log, state.json, jevcode.log)
          resume    jevcode run --resume 20260921-212834-6nl3fcv7
          report    jevcode report 20260921-212834-6nl3fcv7   (redacted bundle written locally; nothing is sent)
─── ▸ jev s7 · 75 decisions · risk 1.00 [block] · plan 0/2 · jev 172ms ───── [d]ecisions [p]lan [t]imeline [s]ynth ─────
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4        step 7/40 0m09s  run $0.02/2.00 ok  sess $0.02/10.00 ok  ⎇ main · 1092?  jev ▂▁▂▄▂▂▄▂▂▄▂▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-7. Error (blocking pane: Jev unreachable), 24×80 — 12 dynamic rows.** The blocking item is red (`level: 'error'`, `plain.ts:393`); the card's edges red (`Overlay.tsx:293`); the composer collapsed with `(paused — answer the pane above)`; the status left word `paused: jev unreachable`, the session meter dropped by the drop order (`status/lines.ts:406`). The card body follows `blockingRowsStructured` for `jev-unreachable` (`blocking/lines.ts:134-142`): title + retry segment packed into the title edge (cut to 74 cells by `cardTop`), then the keys and the `last:` row.

```text frame80
    [run] blocking: jev unreachable after 3 attempts · retrying in 30s (auto,
          doubles to 5 min)
─── ▸ jev s3 · 41 decisions · risk 0.12 ok ────────────────── [d] [p] [t] [s] ──
╭─ jev unreachable after 3 attempts · retrying in 30s (auto, doubles to 5 mi… ─╮
│ [r] now  [q] stop                                                            │
│ last: ECONNREFUSED api.typesafe.ai                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ────────────────────────────────────────────────────────── JevCode ─╮
│ › (paused — answer the pane above)                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ paused: jev unreachable                   step 3/40 1m02s  run $0.04/2.00 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-7w. Error, 40×120 — 11 dynamic rows.** The title and keys pack into one card title at this width.

```text frame120
    [run] blocking: jev unreachable after 3 attempts · retrying in 30s (auto, doubles to 5 min)
─── ▸ jev s3 · 41 decisions · risk 0.12 ok · plan 1/3 · jev 118ms ────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
╭─ jev unreachable after 3 attempts · retrying in 30s (auto, doubles to 5 min) · [r] now  [q] stop ────────────────────╮
│ last: ECONNREFUSED api.typesafe.ai                                                                                   │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ────────────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ › (paused — answer the pane above)                                                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ paused: jev unreachable                      step 3/40 1m02s  run $0.04/2.00 ok  sess $0.04/10.00 ok  ⎇ main · 3~ 1? │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**R-8. Wizard (first run, no key anywhere), 24×80 — 14 dynamic rows.** The hero stays up behind the wizard (the pane slot is not the console), so the first-run screen is the mark, the tagline and one key field. The title string (`setup · api key`) is R3's to fix; the rows are `wizardLines` (`onboarding/lines.ts:234-243`): title bold, the masked field, the hint dim. `? help` is `''` under the wizard (`status/lines.ts:413-418`); no session meter yet.

```text frame80
    [run] jevcode session · JevCode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████
                                              Decisions, not strings
╭─ setup · api key ────────────────────────────────────────────────── JevCode ─╮
│ OpenRouter API key (OPENROUTER_API_KEY) — serves Jev and the generator       │
│ › ••••••••••••••••••••                                                       │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back     │
├──────────────────────────────────────────────────────────────────────────────┤
│ setup                                                               step 0/– │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**R-8w. Wizard, 40×120 — 14 dynamic rows.**

```text frame120
    [run] jevcode session · JevCode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                                    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                                    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
                                ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
                                 ████  ███████   ████    ██████  ██████  ██████  ███████
                                                                  Decisions, not strings
╭─ setup · api key ────────────────────────────────────────────────────────────────────────────────────────── JevCode ─╮
│ OpenRouter API key (OPENROUTER_API_KEY) — serves Jev and the generator                                               │
│ › ••••••••••••••••••••                                                                                               │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back                                             │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ setup                                                                                                       step 0/– │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Notes on the frames: (1) the tagline row makes the hero 6 pane rows (`CAP.hero = 6`); at 24×80 the hero + wizard frame is 14 dynamic rows of a 22-row budget, so every state above fits without yielding; (2) the header row keeps its text — only its label is right-aligned into the gutter; (3) the status rows are `statusLineText(state, 76)` / `(…, 116)` output with the jev-on caps; the drop order is unchanged and visible in R-7 (the session meter yields to the long left word); (4) no frame paints a background, in keeping with F2 of TUI-DESIGN §14.1.

---

## 3. The pink palette applied

### 3.1 Role table (replaces the dark/light tables at `src/tui/theme.ts:90-133`)

`ansi256` indices are the nearest cube/grey-ramp cells; contrast is WCAG 2.1 against `#1e1e1e` (dark) or `#ffffff` (light), computed, not measured.

| Role | Dark truecolor / 256 / 16 | Contrast on #1e1e1e | Light truecolor / 256 / 16 | Contrast on #fff | Marker (unchanged) | Where it shows |
| --- | --- | --- | --- | --- | --- | --- |
| `accent` | `#f386a1` / 211 / `magentaBright` | 6.9:1 | `#be185d` / 125 / `magenta` | 6.0:1 | '' | brand row `◆ jevcode <v>`, wordmark `JEV`, picker selection, wizard/hosted console title, the run-start sweep |
| `assistant` (new colour) | `#f386a1` / 211 / `magentaBright`, bold | 6.9:1 | `#be185d` / 125 / `magenta`, bold | 6.0:1 | `[jevcode]` | the `[jevcode]` label only (bodies stay default) |
| `badge` | `#f386a1` / 211 / `magentaBright`, bold | 6.9:1 | `#be185d` / 125 / `magenta`, bold | 6.0:1 | the badge word (marker string → `'badge'`, F14) | console top edge; flat-tier status prefix |
| `spinner` (new role) | `#f386a1` / 211 / `magentaBright` | 6.9:1 | `#be185d` / 125 / `magenta` | 6.0:1 | the glyph | the status row's leading glyph (P6) |
| `steer` | `#f386a1` / 211 / `magentaBright` | 6.9:1 | `#be185d` / 125 / `magenta` | 6.0:1 | `>` | the `›` prompt while a run is live |
| `borderFocus` | `#d45bb6` / 169 / `magenta` | 4.7:1 | `#a21caf` / 127 / `magenta` | 6.3:1 | `live` | console edges while a run is live; the run-end border fade passes through it |
| `you` | `#fefefe` / 231 / `whiteBright`, bold | 17.9:1 | `#1e1e1e` / 234 / `black`, bold | 17.9:1 | `[you]` | the `[you]` label only (bodies default) |
| `ok` / `chosen` | `#03aa5c` / 35 / `green` | 5.5:1 | `#047857` / 29 / `green` | 5.6:1 | `✓` / `[chosen]` | `✓` toasts, `ok` verdicts, `[chosen]`, `complete` status |
| `code` | `#abbab9` / 249 / `white` | 8.3:1 | `#4b5563` / 240 / `black` | 7.6:1 | `╶` | fence rules |
| `sweep` | `#fefefe` / 231 / `whiteBright` | 17.9:1 | `#d45bb6` / 169 / `magenta` | 4.7:1 | '' | the 3-cell reveal head, the 6-cell shimmer band, the streaming caret |
| `dim`, `rule`, `placeholder`, `border` | dim (unchanged) | — | dim | — | — | everything secondary |
| `error`, `block` | `#F87171` / 203 / `red` (unchanged) | 5.9:1 | unchanged | — | `error`, `[block]` | unchanged (daltonized swaps to blue as today) |
| `warn`, `review`, `secret` | `#FBBF24` / 214 / `yellow` (unchanged; light theme blue as today) | 9.6:1 | unchanged | — | `warning`, `[review]`, `⚠ secret?` | unchanged |

Two rules keep the palette restrained: **pink marks the product** (the brand, the assistant, the badge, the spinner, the prompt while Jev is working, the selection) and **magenta marks "live"** (the console edges and the run-start sweep, the info toast). Verdict words are never pink — red `[block]` (hue 0°) and pink (hue 345°) are neighbours, so the two must never share a row's meaning; the "≤ 3 colours per row" check in §7 and the `itemRole` rule (`theme.ts:203-210`: a `[block]` row is red in full, the label dim) guarantee that. Teal `#09aea1` stays unused (reserved; it would become the daltonized `ok` if the owner wants the swap to stay within the typesafe set). `daltonized` inherits every pink row and keeps its red↔blue swap (`theme.ts:136-146`); `ansi` derives as today (`theme.ts:149-161`: `magentaBright`/`magenta`/`green`, never dims). Backgrounds stay unset (the terminal's own `#1e1e1e`-class background is the canvas; F2 of TUI-DESIGN §14.1).

### 3.2 Where typesafe.ai is pink, and the TUI place that inherits it

| typesafe.ai usage (Appendix B) | TUI twin |
| --- | --- |
| the wordmark and primary buttons (`#f386a1`, ~52 uses) | the wordmark `JEV`, the brand row `◆ jevcode`, the badge |
| links and highlighted words in the copy | the `[jevcode]` label, the selected palette row's `▌` marker, the picker's selected row |
| the secondary gradient tint (`#d45bb6`, 6 uses) | the live console edges, the run-start rule sweep, `!` info toasts |
| body text `#dedede` / `#fefefe`, muted `#abbab9` / `#c4c4c4` | default text; `[you]` label bright; `code` grey; the rest dim |
| the accent green `#03aa5c` | `✓`, `ok`, `[chosen]`, the `complete` status |
| the copy "Decisions, not strings" | the hero tagline and the brand row's suffix at ≥ 64 columns |

Fonts: the terminal's; the block-letter wordmark and every glyph in the table render identically in JetBrains Mono, Menlo, SF Mono and Cascadia. `docs/TUI.md` "Terminal setup notes" can recommend JetBrains Mono as the font the mark was tuned on — a documentation line, not a code change.

---

## 4. Message style guide (deliverable b)

1. **Label column: 10 cells, labels right-aligned, bodies at column 10.** `[jevcode]`, `[sandbox]` (9) sit flush; `[you]`, `[run]`, `[ui]`, `[step 7]`, `[setup]`, `[config]` are padded on the left. `[step 100]` (10) touches the gutter's edge; steps ≥ 100 push the body by one cell — accepted (the default cap is 40). The row's *text* is unchanged: `formatTranscriptItem(item)` is still label + one space + text; only leading spaces are added (see §6 for the identity normaliser).
2. **Label colour is the speaker; body colour is the meaning.** `[jevcode]` pink bold, `[you]` bright bold, every other label dim. Bodies: default for chat and steps; yellow for `warn`/`[review]` rows; red for `error`/`[block]`; dim for `[ui]` notes and `[run] git …`. Never colour a body pink.
3. **Wrap at ` · ` before wrapping at spaces.** For `step`, `run:start`, `run:end`, `blocking`, `replan` and any text containing ` · `: fit whole segments on a row; a continuation row starts with `· ` (the separator leads); a segment wider than the row falls back to word wrap; never leave a token shorter than 4 cells alone on a row (`4`, `5))`, `·`).
4. **Detail rows (TUI-only) indent under the body column** and wrap with a hanging indent under their own value when they are a two-column table (`label.padEnd(10) value`, the epilogue's form): `files     ~/…/` then `(transcript.log, …)` under the path.
5. **Sentence case, no trailing period on single-line items**, one thought per row. `[ui]` heads are nouns (`jev`, `cost`, `stopped — replan_stop (exit 4)`), not the first data row (F6/`/cost`).
6. **Numbers.** Money `$0.025` (three decimals; four below $0.001 — `stepCostText`, `plain.ts:423-426`), caps with two (`$2.00`), never scientific notation (`~$5.5e-6 each` → `~$0.000006 each`, or `≈ 0.6¢ per 1,000`); durations `4.9s`, `14s`, `1m02s`; probabilities two decimals; percentages `10%` (the space in `10 %` is a local-item text; either is acceptable, pick one and keep it — the mocks keep the code's form).
7. **Ids.** A run id appears in at most two scrollback rows per run: the end of `[run] start` (needed in `transcript.log`) and the epilogue's `run` row. Never in the status centre (the centre shows `/rename` titles only); never in a `[step N]` row; loop signatures print as `done ×3`, the hash stays in the panel and `/why`.
8. **Max line length.** A `[jevcode]` reply ≤ 160 characters (two rows at 80, `REPLY_TEXT_MAX`); a fact ≤ 240; a step row is whatever the segments need — it wraps by rule 3; `[ui]` heads ≤ 60 so they never wrap.
9. **Spacing rows.** One blank row above every `[you]` turn, above the first `[jevcode]` item of a turn, above `[run] start` and `[run] end` (today's rule, `Transcript.tsx:96-101`), and — new — above a `[ui]` item that carries a detail body (`/jev`, `/cost`, the epilogue, `/help`), so a block reads as a block.
10. **Hidden in compact.** Unchanged: `intent`, `context`, `synth`, `proposal`, `risk`, `outcome`, `judge`, `plan`, `run:ready` (`plain.ts:80`). Visible: `step`, `run:start`, `run:end`, `confirm:resolved`, `error`, `transcript`, `loop:tripped`, `replan`, `steer:*`, `pause`, `budget`, `retry`, `notice`, `workspace`, `blocking`, `secret-ack`, `ui`, `chat`. The replan/loop rows earn their place by being one row each after P5.
11. **Bubbles.** No box, no background, no rail glyph — the scrollback must stay plain text (identity). The pink label *is* the bubble.
12. **Dynamic rows** (not transcript): the live `synth` row dim; the loop banner reads `loop · patch repeated 2 of 3` / `loop · replan 1 of 5 · s7 gather_context (p 0.62 · impossible 0.20)` (` · ` separators like every other row; `bannerRow`, `pane/banner.ts:115-125`, no identity cost); the status row colours only the left word and the meter words (`half` default, `high` yellow, `critical`/`over` red), never the whole row.
13. **Copy.** Generator-neutral ("the model writes the code"); "Jev decides every step" is the sentence to repeat; product names as typesafe.ai writes them (Jev, System One Models, Decisions API); the tagline exactly `Decisions, not strings`.

---

## 5. Animation catalogue (deliverable c)

Every animation below ticks through Ink's `useAnimation` via `useMotion` (`src/tui/motion.ts:21-28`) or the existing 8 fps spinner interval (`src/tui/spinner.ts:16`), so it is coalesced by Ink's 34 ms render throttle and can never exceed `maxFps` on its own; key frames keep the immediate path (D-F), so no animation adds to composer latency. None adds or removes rows while it runs (zero clears). The reduced-motion twin is stated for each; `--ascii` twins come from the glyph table.

### 5.1 Splash → persistent hero (P1)

| t (ms) | frame | phase | change | colour |
| --- | --- | --- | --- | --- |
| 0 | 0 | reveal | `J` (cells 0–6) + `▓▒░` head at 7–9; console complete with `step 0/–` (today's frame 0, `splash.ts:103-138`) | `J` pink, head near-white |
| 50–400 | 1–8 | reveal | edge advances 7 cells/frame (`revealedCells`, `splash.ts:75-78`) | `JEV` pink, `CODE` grey |
| 450–550 | 9–11 | shimmer | 6-cell band left → right once (`sweepStart`, `splash.ts:81-85`) | band near-white |
| 600 | 12 | settle | the tagline row appears (dim); **no fade-to-default** (today's frame 12) | — |
| 650 | 13 | settle | **no dim step** (today's frame 13 dims every letter) — the mark keeps pink/grey | — |
| 700 | 14 | hero | `useMotion` reports `settled`; the subscriber stops; the rows stay | — |
| ≥ 700 | — | hero | nothing ticks; the hero persists until the first submission, `/panel`, the picker, or a resize below 16 rows / 64 columns | — |

A key during the reveal no longer removes the mark: it jumps to the hero in the same commit (the reducer's `key` action ends the *animation*, `useEngine.tsx:415-419`; hero visibility is a separate predicate, P1). Reduced motion / screen reader: frame 0 is the hero. Below 64 columns: today's one-line brand pulse (`brandGlyph`, `splash.ts:146-150`) then the brand row with the tagline dropped. Gates: first frame unchanged in content (frame 0 + one blank pane row: 12 dynamic rows ≤ 22); splash bucket ≤ 15 frames as today (`render-lag.ts` splash gate); zero clears (the pane slot never shrinks until the first turn, and that shrink is a *height decrease of the dynamic region*, which costs no clear — the region only ever gets shorter, as the `chrome-tiers` scenario shows).

### 5.2 Thinking spinner (P6)

Frames `░ ▒ ▓ █ ▓ ▒` at 125 ms (8 fps, today's interval; 750 ms cycle), pink; the glyph is the brand's own reveal head, so the set stays one. Words unchanged: `thinking` · `looking` · `replying` (`THINKING_WORDS`, `status/lines.ts:100`), stage verbs while live. `--ascii`: `. + # # + .`. Reduced motion: a steady `◆` (today `•`, `glyphs.ts:122`). Alternative considered: keep braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (charm MiniDot, Gemini's `dots`) — industry default but off-brand; the shade pulse needs no new glyph and every cell is already width-tested. Gate: same frame count as today (spinner frames are `dynamic`, measured 18–21/s live).

### 5.3 Streaming caret (jev-on / llm-jev live region)

While `generator:delta` text flows (`liveLines`, `App.tsx:185-202`), the last live row ends with `▍` on even spinner frames and nothing on odd ones (a 4 Hz blink riding the existing 8 fps tick, no extra timer); colour `sweep`. Reduced motion: steady `▍`. `--ascii`: `|`. Gate: zero added frames (the live flush already redraws these rows).

### 5.4 Run start: rule sweep (P9)

At `run:start` the rule row becomes the strip in one commit (today). New: for 300 ms a 12-cell band of the rule's `─` cells lights magenta and travels left → right (6 frames at 50 ms via a second `useMotion(runStarting, 300)`), then the strip stands still. The console edges flip dim → magenta in the first of those frames (one SGR change). Reduced motion: no sweep, instant flip. Gate: ≤ 6 `dynamic` frames in the run's first second on top of the spinner's 8 → ≤ 14 + the live flush; Ink's throttle bounds the total at 30 regardless; zero clears (same rows).

### 5.5 Run end: border fade (P9)

At `run:end` the edges go magenta → pink → dim over three frames at 70 ms (`useMotion(runEnded, 210)`); at 16 colours `magenta → magentaBright → dim`. The status row's left word takes its final colour in the same first frame (yellow for a non-complete stop, green for `complete`). Reduced motion: instant. Gate: 3 frames.

### 5.6 Toasts (P10)

`! <text>` (info, pink), `✓ <text>` (ok, green), `! <text>` (error, red) replace the left zone for 2 s / 4 s (`toasts.ts:27-29`). New: in the toast's last 1,000 ms the text is dim — the 1 Hz `tick` that already redraws the clock carries the change (`toast.untilMs − nowMs ≤ 1000 → dim`), so no timer is added. Reduced motion: same (a dim step is not motion). `--ascii`: `+`/`!`.

### 5.7 Review card arm (P11)

Frame 1 (the commit that draws the card): edges yellow/red, **keys row dim**, gauges default, preview dim. Frame 2 (`overlay:armed`, ≥ 150 ms or the flush, `App.tsx` arm effect): keys row bold in the verdict colour — today's look. The user sees the card "wake up" exactly when `y` becomes live; the `d` note field inherits the armed style. Reduced motion: same two frames (state, not motion). Gate: zero added frames (the arm dispatch already commits).

### 5.8 What is deliberately not animated

Transcript text (a typewriter would delay the reply and fight `<Static>`'s write-once rule); panel open/close (six rows appearing gradually would move the composer under the cursor); the meters (they change with data); the placeholder (it changes with state, P7 removes its only flicker).

---

## 6. The identity rule (deliverable d)

| Proposal | Changes transcript **text**? | Where the change lives | Twins to update |
| --- | --- | --- | --- |
| P1 hero, P2 palette, P3 gutter + detail indent, P4 segment wrap, P6 spinner/status spans, P7 placeholder flash, P8 banner clear, P9 sweeps, P10 toast dim, P11 arm style, P15 palette card colour | **No** — colour, spacing, wrapping, dynamic rows only | `Transcript.tsx`, `theme.ts`, `Console.tsx`, `StatusLine.tsx`, `Review.tsx`, `Overlay.tsx`, `App.tsx`, `useEngine.tsx`, `splash.ts`, `layout.ts`, `spinner.ts`, `glyphs.ts` | none for text; the frame-identity tests learn the gutter normaliser (§9.1) |
| P5 `[run] start` / `[run] end` / `replan` / `loop:tripped` / `[run] warn: stop:` forms | **Yes** — engine items in `transcript.log` | `itemsFromEvent` (`plain.ts:310, 345, 347, 400-410`) and the engine's `transcript` text for the stop warning (`src/loop/**` emits `stop: …`; find with `grep -rn "'stop: '" src/loop`) | `plain.test.ts`, `test/pty/smoke/*.steps` regexes (`end (complete|…)` still matches; `mode=` greps do not), `docs/TUI-DESIGN-2.md` §12 glossary, `docs/TUI.md`, `docs/STATUS.md`; anything that parses `transcript.log` (`grep -rn "steps=" src test` before changing) |
| P12 `[sandbox]` short text + detail | **Yes** — a `notice` of kind `sandbox` is an engine item | `sandboxText` (`onboarding/lines.ts:291-295`) plus a `detail` argument at the engine's notice site | `onboarding/lines.test.ts`, `facts` tests (the `sandbox` fact quotes it), `plainwarn.steps` if it greps the sentence |
| P13 `/jev`, `/cost`, epilogue heads and rows; the `5.5e-6` | **Yes, local items only** — `[ui]` items are printed by the TUI and `--plain`, never in `transcript.log` (`plain.ts:496-508` `localItem`) | `session.ts:2526-2530` (`/jev`), `budget/lines.ts:322-20 20 12 61 79 80 81 33 98 100 204 250 395 398 399 400 701 (322+36) )` (`costBlock`), `epilogue.ts:75-98`, `session.ts:2479` (`block('cost', …)`) | `round2.pty.test.ts:312` (`chat $<usd> for 1 message (~$<each> each, …)` regex), `budget` unit tests, `epilogue` tests, the `--plain` twin prints the same rows |
| P13c session header without `| step 0/– starting` | **Yes, synthetic item** (TUI + `--plain` first line, never `transcript.log`) | `sessionHeaderItem` / `headerItem` (`plain.ts:827-844`) | `plain.test.ts`, `taskfile-header.steps`, `chat.pty.test.ts:81` (`step 0/` sentinel must still be found — it is, in the status row), `perf/first-frame.ts` reads the status row's sentinel |
| P14 copy ("Claude" → neutral), badge table | **Yes** — `MODE_*_SET` are local items; the facts are `[jevcode]` chat items (local when idle, engine `notice` while live) | `session.ts:241-244`, `facts.ts:110-126`, `status/lines.ts:105-114`, `replies.ts:98-100`, `theme.ts:108` | R3 P11 owns the wording; this report only lists the sites |

The identity predicate after P3/P4 (to replace `wrapLike` in `app.test.tsx:299` and `round2-transcript.test.tsx:84-98`): for every visible item, take its rows, drop leading spaces of the first row and the gutter of the continuation rows, join the rows with single spaces, collapse runs of spaces — the result equals `formatTranscriptItem(item)`. This is stronger and simpler than "word-wrapped at the commit width with a hanging indent of `label.length + 1`" and holds under any wrap rule that never splits or reorders tokens. `--plain` and `transcript.log` are untouched by P3/P4.

---

## 7. "Viral-worthy" as a checklist (deliverable e)

Each line is a predicate over a pty capture (`<name>.txt` SGR-stripped, `<name>.cap` raw bytes) that `docs/live/tui/round-2/summarize.py` or a new `scripts/pty/polish-check.mjs` can evaluate; the integrator ticks them from the artefact, not from a screenshot.

| # | Check | How to verify |
| --- | --- | --- |
| V1 | **Hero fits 24×80**: the settled idle frame has ≥ 5 rows containing `██`, the row `Decisions, not strings`, the `›` prompt with `Say hi, ask a question, or describe a task…`, and ≤ 12 dynamic rows | first frame after `mark settled` in `.txt`; count rows between the rule and the bottom edge |
| V2 | **The mark survives the load**: wordmark cells > 0 in the settled frame and in every frame until the first `[you]` row (inverts today's `splash-settle.steps` assertion) | `.txt` scan |
| V3 | **Every colour a role**: distinct SGR foregrounds in a whole session ≤ 7 (pink, magenta, near-white, grey, red, yellow, green) plus dim/bold | regex over `.cap`: `\x1b\[38;2;\d+;\d+;\d+m`, `\x1b\[38;5;\d+m`, `\x1b\[9?[0-7]m` |
| V4 | **≤ 3 colours per row** (dim/bold not counted) | per-row set of foreground SGRs in `.cap` |
| V5 | **Verdict words never pink**: no `[block]`/`[review]`/`error` token inside a pink span | `.cap` span walk |
| V6 | **No row wider than the terminal** (today: 0) | code-point count per `.txt` row ≤ columns |
| V7 | **No orphaned wrap**: no scrollback continuation row (≥ 10 leading spaces) whose trimmed text is < 4 cells or matches `^[\d)\]·]+$` | `.txt` scan |
| V8 | **Label gutter**: every scrollback row either has its label's `]` at index 8 or is a continuation/detail row starting with ≥ 10 spaces | regex `^\s*\[[^\]]+\] ` with `]` at index 8 |
| V9 | **Consistent glyph set**: every non-ASCII code point in `.txt` is in `GlyphSet` (unicode), the wordmark cells, or the prose set `— – … ’ “ ” ×` | script with the allow-list built from `src/tui/glyphs.ts` |
| V10 | **Blank row before every turn**: a blank row precedes every `[you]`, the first `[jevcode]` of a turn, `[run] start`, `[run] end`, and a `[ui]` head with detail | `.txt` scan |
| V11 | **Numbers**: no `e-` scientific notation; every `$` figure matches `\$\d+\.\d{2,4}`; durations match `\d+(\.\d)?s|\d+m\d{2}s|\d+h\d{2}m` | regex over `.txt` |
| V12 | **Ids**: a run id (`\d{8}-\d{6}-[a-z0-9]{8}`) appears in ≤ 2 scrollback rows per run and never in a status row | `.txt` scan |
| V13 | **No `key=value` tokens in compact scrollback rows** (after P5) | regex `\b\w+=\S` count 0, excluding `--flags` |
| V14 | **Status row colour is local**: the coloured span on the console status row covers ≤ 30% of the inner width | `.cap` span walk |
| V15 | **Spinner is pink**: the SGR before the leading status glyph is the accent | `.cap` |
| V16 | **No wrong-chrome flash**: no frame contains both `starting` and `Type to steer` (P7) | `.txt` scan |
| V17 | **No stale banner**: no `loop ` row in any frame after `[run] end` (P8) | `.txt` scan |
| V18 | **Detail rows indented**: every row following a `[ui]` head until the next label starts with ≥ 10 spaces | `.txt` scan |
| V19 | **First reply fast**: `hi` → `[jevcode]` ≤ 300 ms live (today 240–265) | `.jsonl` marks |
| V20 | **Motion budget**: ≤ 15 wordmark frames in 700 ms; ≤ 6 sweep frames per run start; `dynamic` ≤ maxFps + 1 in every 1 s bucket; 0 clears outside shrink segments | `render-lag.ts` classes, `helpers.ts` `countClears` |
| V21 | **Twins hold**: the same capture under `--ascii`, `--no-color`, `--no-animation`, `--screen-reader` and at 12×60 passes V6–V13 and V16–V18 (V1–V5, V15, V20 are colour/motion and are skipped) | the smoke matrix |

---

## 8. Proposals

Each: what changes · where · edge cases · tests · the perf gate it must satisfy. Ordered by user value; P1–P4 and P7–P8 are the round's core.

**P1. Persistent hero: the wordmark stays after the reveal, with the tagline.**
- What: a third splash state. `SplashState = 'running' | 'hero' | 'done'` (`useEngine.tsx:99`): `running` while `t < 700`, `hero` from the settle (or a key/reduced motion at mount) until the first submission (`run:starting`), `/panel`, the picker, or `turns > 0`; `done` afterwards. `splashFrame` gains a `hero` phase that returns the complete mark with its spans (pink/grey, no fade) plus a sixth row — the tagline `HERO_TAGLINE = 'Decisions, not strings'` right-aligned to the grid's right edge, role `dim`; `CAP.hero = 6` (`layout.ts:20-49`); `paneWant` reads `hero ? CAP.hero : …` (`App.tsx:1920`); the rule row above stays `plainRule` while the hero is up and becomes the brand row (with ` · Decisions, not strings` at ≥ 64 columns, `brandRow`, `splash.ts:156-158`) once it ends; the two fade frames (`SPLASH_FADE_1_MS`, `SPLASH_FADE_2_MS`, `splash.ts:21-22`) become the tagline's appearance and a no-op.
- Where: `src/tui/splash.ts`, `src/tui/motion.ts` (unchanged), `src/tui/layout.ts`, `src/tui/useEngine.tsx` (`endSplash` → `settleSplash`; the `key` action no longer collapses the mark; `run:starting`, `picker`, `panel` and `turn` end the hero), `src/tui/App.tsx:1916-1920, 1981-2001`, `src/tui/Pane.tsx:53-63` (`ruleRowText` for `hero`).
- Edge cases: columns < 64 → no rows, the brand row pulses then settles (today); rows < 16 → flat tier, no hero; a resize into/out of the hero geometry while idle → the slot appears/disappears (a grow costs no clear; a shrink is the allowed one); the wizard at startup → hero + wizard (14 rows at 24×80, fits); `/panel` before any turn → the panel replaces the hero and the hero does not come back; screen reader → no hero (as today, no wordmark); `--no-animation` → hero from frame 0; one-shot `jevcode run` → `run:start` ends it at once (no hero ever shows); the picker (`/resume`) → the picker owns the slot.
- Tests: `splash.test.ts` (hero phase rows = padded WORDMARK + tagline, spans pink/grey, `[]` below 64 columns); `reducer` test for the three states and every ending action; `height.test.tsx` at 16/24/40 rows with the hero; `frames2.test.ts` gains R-1/R-1w/R-8/R-8w; `splash-settle.steps` flips to expect wordmark cells *after* `◆ jevcode`… no — the brand row appears only after the hero ends, so the step becomes `expect Decisions, not strings` then `send hi`, `expect ◆ jevcode`; `splash.steps` (a key at 100 ms) expects the hero, not the collapse; `round2.pty.test.ts:401-479` updated likewise.
- Gate: first frame < 300 ms (content unchanged; +1 blank row); zero clears; `render-lag` splash bucket ≤ 15 frames; `composer-latency` idle p95 < 16 ms with a 12-row dynamic region (re-measure; expected +≤ 1 ms from the larger repaint); `rows − 2` at every geometry.

**P2. The pink theme.**
- What: the role table of §3.1 in `DARK`/`LIGHT` (`theme.ts:90-133`); `assistant` gains a colour; a new `spinner` role (or reuse `accent` — a separate role lets `ansi` and daltonized tune it); `badge.marker` → `'badge'` (F14); `NO_MARKER_ROLES` unchanged. `Transcript.tsx:108-134`: the label takes `assistant`/`you`/`dim` by label, the body takes `itemRole` minus the `you` colour (bodies default). `Console.tsx:182` already colours the badge; `Console.tsx:109` the edges; the prompt glyph `steer` (`Console.tsx:142`).
- Edge cases: `--no-color`/`NO_COLOR`/`TERM=dumb` → markers carry the meaning (`validateTheme`, `theme.ts:219-239`); `--theme ansi` → `magentaBright`/`magenta`/`green` only, never dim; `light` uses the darker pinks (§3.1); daltonized keeps red↔blue; `/theme` swaps new items and the dynamic region only (R4).
- Tests: `theme.test.ts:94` (the §4.9 table) → the §3.1 table; a computed-contrast assertion (relative luminance ≥ 4.5:1 for every coloured role against `#1e1e1e` in dark and `#ffffff` in light); `validateTheme` still passes; snapshot of `textProps` at 16/256/24.
- Gate: none (colour is SGR bytes; the frame byte count grows by a few hundred bytes per frame — well inside the lag gate).

**P3. Fixed label gutter and indented detail rows.**
- What: `TranscriptRow` (`Transcript.tsx:108-134`) renders `label.padStart(10)` in a `flexShrink=0` box and the body in a box starting at column 10 (so wrapped rows hang at 10); detail rows render inside the body box (indent 10) and, when they match `/^(\S+\s{2,})/`, with a hanging indent under the value; a spacer row above a `[ui]` item with detail (`spacerAbove`, `Transcript.tsx:96-101`).
- Edge cases: **the gutter costs the short-label rows cells** — a `[you]` or `[run]` body has 70 cells at 80 columns instead of 74 (a 71-character task bubble that fits today wraps, R-4), `[ui]` loses 5, `[step N]` loses 1, `[jevcode]` and `[sandbox]` lose none; the alignment is worth four cells, but the owner should see the trade in R-4 before approving; labels longer than 9 (`[step 100]`, a custom `UiLabel`) shift the body by the excess; `--ascii` unchanged; screen reader unchanged (the SR renderer is `--plain`); 40-column terminals: body width `columns − 10` ≥ 30 — fine; the epoch remount (`Transcript.tsx:139-141`) unaffected.
- Tests: `round2-transcript.test.tsx:84-98` identity → the §6 normaliser; new: bodies start at column 10 for every label; detail rows indent; `app.test.tsx:299`; `round2.pty.test.ts:654` (transcript.log rebuilt from wrapped rows at 80) with the normaliser.
- Gate: identity (predicate updated, text unchanged); `static-append` probe unchanged (one commit per item).

**P4. Segment-aware wrap for `·`-separated rows.**
- What: in `TranscriptRow`, split the body on ` · ` when present; pack segments greedily into rows of `columns − 10`; a continuation row begins `· `; a segment wider than a row word-wraps; a final token narrower than 4 cells joins the previous segment (never `4` alone). Rendering as pre-split rows (one `<Text>` per row inside the body box) also removes Ink's trailing-space artefacts (`auto-24x80.txt:657`).
- Edge cases: user text containing ` · ` (a `[you]` bubble) is wrapped the same way — harmless; `--ascii` rows use ` - ` (`glyphs.ts:159, 168`: `dot` → `-`), so the splitter takes the glyph set's separator; `detail` rows keep plain wrap.
- Tests: unit table of (text, width) → rows for the F4/F5 cases (`[step 1]…`, `[run] end … exit 4`, `[run] warn: stop: …`); identity normaliser holds; no continuation row shorter than 4 cells over 1,000 random step records (fast-check style, like `buffer.property.test.ts`).
- Gate: identity (text unchanged); no perf impact (pure string work per commit).

**P5. Conversation-grade `[run]`/`replan`/`loop` texts (transcript text change).**
- What, in `itemsFromEvent` (`plain.ts`): `run:start` → `start <mode> · <task ≤ 160> · run <id>[ · resumed from step N]` (`:310`); `run:end` → `end <stop> · <n> steps · <wall> · <cost>[ (gen $x, jev $y)] · exit <n>[ · error <code>: <msg>]`, the parenthesis only when both sides are non-zero (`:400-410`); `replan` → `replan → <move> (p <p> · impossible <i>): <text>` (`:347`); `loop:tripped` → `loop tripped ×<n>: <signature>` (`:345`); the engine's `stop: …` warning → `stop · <reason> at step <n> — <detail>` (find the emitter under `src/loop/`). `stepSummaryText` is untouched.
- Edge cases: `transcript.log` readers (`grep -rn "steps=\|mode=" src test bench` first; `jevcode report` copies the file, it does not parse it); the smoke regexes `\[run\] start`, `end (complete|max_steps|…)` (`test/pty/smoke/*.steps`) still match; `docs/TUI-DESIGN-2.md` §12 glossary and `docs/TUI.md:270-280` name the old forms → update; `--json` is unaffected (structured).
- Tests: `plain.test.ts` new expectations; `round2.pty.test.ts:149` (`[run] start`, `[step N]`), `chat-task.steps`; a `transcript.log` golden for one mocked run.
- Gate: identity kept by construction (one formatter, three sinks); no perf impact.

**P6. Pink spinner and status-row spans.**
- What: `glyphs.ts:121-122` spinner frames `['░','▒','▓','█','▓','▒']`, `spinnerStatic: '◆'`; ASCII twin `['.','+','#','#','+','.']`, static `*`; `status/lines.ts` exports `statusSpans(state, columns, opts): { text, spans: [{from,to,role}] }` marking the leading spinner glyph (`spinner`), the left word when `done` (`ok`/`warn`), the meter words (`high` → `warn`, `critical`/`over` → `error`) and `⚠ secret?` (`secret`); `Console.tsx:195-200` and `StatusLine.tsx:71-82` render the spans instead of colouring the whole row (`statusRole` retires); the streaming caret in `liveLines` consumers (`App.tsx:2027-20 20 12 61 79 80 81 33 98 100 204 250 395 398 399 400 701 (2027+8) )`) via a `caret` flag on even spinner frames.
- Edge cases: `--ascii` (`|/-\` today → the new ASCII set; `asciiFold` skips the spinner array, `toasts.ts:79`); reduced motion (`spinnerGlyph`, `spinner.ts:48-54` → `◆`); the flat tier (`StatusLine.tsx`); a toast in the left zone takes the toast colour (P10); `NO_COLOR` → text only.
- Tests: `spinner.test.ts:18-45` frame set; `status/lines.test.ts` spans (positions computed from `statusZones`, `status/lines.ts:497-559`); `round2-console.test.tsx` SGR spans; the §14.2 source scan unchanged (no new timer).
- Gate: `dynamic` fps unchanged (same tick); key latency unchanged (the status row is not on the key path).

**P7. No wrong chrome between Enter and the bubble.**
- What: `composerMode` (`App.tsx:1952-1979`) treats `state.run === 'starting' && !runIsLive(state.run)` as the previous idle mode (`followup`/`task`) until `thinking` is set, and `leftWord` (`status/lines.ts:336`) returns the idle word (`idle`) instead of `starting` for that window — the controller's `thinking(phase)` dispatch (`session.ts` submit path) arrives within the same tick in practice; alternatively dispatch `thinking: 'intake'` together with `run:starting` in `send()` (`App.tsx`, the `submit` branch) so the very first frame reads `▓ thinking` / `(thinking…)`.
- Edge cases: a submission that becomes a run without a chat phase (argv task, `--task-file`) → `run:start` follows and the steer placeholder is correct from then on; a `/steer` while live is unaffected (`run === 'live'`); the `STILL_THINKING_TOAST` path (`App.tsx` `onEnter`) reads `chatThinking`, unchanged.
- Tests: `round2-app.test.tsx`: after Enter the first frame has no `Type to steer` and no `starting`; `intake-latency` probe's `thinking seen` counter (`STATUS.md` intake rows show `0/20` today because the bubble frame reads `starting`) should become 20/20.
- Gate: intake bubble p95 < 16 ms (unchanged path).

**P8. Clear the loop banner at run end; keep the strip.**
- What: the `run:end` branch of `applyEvent` (`useEngine.tsx:722-744`, the `runsEnded` increment) sets `loop: null` and `loopFold: emptyLoopFold()`; the strip keeps `risk 0.99 [block]` (it is the run's record) but the `▸` and `jev` take the accent.
- Edge cases: a `steer:applied` after the run cannot happen; `/resume` starts a new run (its own reset at `useEngine.tsx:547`).
- Tests: `round2-reducer.test.ts`: `run:end` → `loop === null`; a pty assertion V17.
- Gate: none.

**P9. Run-start rule sweep and run-end border fade.**
- What: a second `useMotion` instance in `App.tsx` keyed on `state.runId` (`useMotion(active, 300)`): while `time < 300` the `RuleRow` (`App.tsx:2142-2159`) paints cells `[⌊time/50⌋·W/6, +12)` in `borderFocus`; at `run:end` a third instance (`useMotion(ended, 210)`) drives the edge colour through `borderFocus → accent → border` at 70 ms steps in `Console.tsx:109`. `motion.ts` is already generic; the §14.2 grep test (`spinner.test.ts:99-128`) still sees `useAnimation(` only in `motion.ts`.
- Edge cases: reduced motion → both skipped (the flag is already read at `App.tsx` mount); a run shorter than 300 ms (`--mock`) → the end fade starts while the sweep runs: the end wins (`runId` changes); 16-colour terminals → two-step fade; the flat tier has no edges → sweep only; `--ascii` unaffected (colour only).
- Tests: `app.test.tsx` with a fake clock: sweep frames ≤ 6, no row-count change, the strip text identical in every frame; render-lag `dynamic` ≤ 31 in the run-start second (add a `run-start` bucket beside the splash bucket in `render-lag.ts`).
- Gate: `dynamic` ≤ maxFps + 1; zero clears; no key latency impact (D-F).

**P10. Toast colours and the last-second dim.**
- What: `toastText` unchanged; `activeToast` consumers colour by level (`ok` green, `info` pink, `error` red) via the status spans (P6); `toastPhase(t, nowMs) = 'fading'` when `untilMs − nowMs ≤ 1000` → `dim` added to the span.
- Edge cases: a toast pushed during a live run shares the row with the spinner glyph — the glyph keeps its colour, the toast its own (two colours + dim ≤ 3); reduced motion identical.
- Tests: `status/toasts.test.ts` (phase), `status/lines.test.ts` (span roles).
- Gate: none (the 1 Hz tick already exists).

**P11. Review card: dim keys until armed.**
- What: `Review.tsx` receives `armed: boolean` (from `state.overlayArmed` through `OverlayData.review`); `isKeys` rows render `dim` while `!armed`, bold verdict colour when armed (`Review.tsx:165, 183`); the flat tier does the same for row 2 (`Review.tsx:131`).
- Edge cases: the `d` note field replaces the keys row (armed by then); screen reader (the SR review is typed lines, unchanged); a card that never arms (an unmount) never lights.
- Tests: `review.test.tsx`: two frames (unarmed dim, armed bold); `review-y.steps` unchanged (`y` before the arm still never approves — the drawing does not touch `resolveKey`).
- Gate: review invariants (only `y` approves; Enter inert) untouched.

**P12. One-line `[sandbox]` notice with the policy as detail.**
- What: `sandboxText` → `seatbelt · writes only in the workspace and run dirs · secrets, ~/.ssh and ~/.aws unreadable · network on (--no-network cuts it)` — still one row at 120 and two at 80; the engine's notice gains `detail` with today's sentence (TUI-only body); the `none` variant likewise.
- Edge cases: the `sandbox` fact (`facts.ts:189`) quotes the same function — the shorter text is a better answer; `config-table.ts:44` keeps its own longer sentence.
- Tests: `onboarding/lines.test.ts`, facts tests, the smoke that greps the sentence (`grep -rn "writes confined" test`).
- Gate: identity (engine item text changed in its one source; `transcript.log` twin follows).

**P13. `/jev`, `/cost` and the epilogue as blocks.**
- What: `session.ts:2479` → `block('cost', costBlock(...))` so the head is `cost`; `budget/lines.ts:341` → `~$0.000006 each` (`toFixed(6)`, trimmed) or `≈ ${(each*1000).toFixed(2)}¢ per 1,000`; `/jev` row 3 `last: question_about_this_tool 1.00` → `last: question about this tool (1.00)`; the epilogue rows keep `padEnd(10)` (P3 indents and hangs them); P13c (optional): `sessionHeaderItem` → `jevcode session · <dir>` and `headerItem` → `jevcode task: <task>` without the sentinel.
- Edge cases: `--plain` prints the same local items (twins); `--json` carries `ui` lines — head text change only.
- Tests: `round2.pty.test.ts:312` regex; `budget` unit tests; `epilogue` tests unchanged; P13c: `plain.test.ts`, `taskfile-header.steps`, `chat.pty.test.ts:81` (the sentinel is still in the status row).
- Gate: none.

**P14. Copy and the badge table (with R3 P11).**
- What: `BADGE_WORDS: Readonly<Record<EngineMode, string>> = { 'jev-only': 'jev-only', 'jev-on': 'jev+llm', 'jev-off': 'llm-only', 'llm-jev': 'llm+jev · verified' }` in `status/lines.ts:105-114`, imported by `replies.ts:98-100` (one table); `theme.ts:108` marker `'badge'`; "Claude writes the code" → "the model writes the code" at `session.ts:241`, `facts.ts:110, 118, 126`; `WIZARD_PROVIDER_TITLE_MODE` already uses the table (`onboarding/lines.ts:73-75`). The badge with the pending suffix reads `llm+jev · verified · next run` (21 + 11 cells) — fits the 80-column top edge (`TOP_EDGE_FIXED` 8 + 7 dir leaves 65).
- Edge cases: none beyond R3's.
- Tests: `status/lines.test.ts`, `replies` tests, `round2.pty.test.ts:345-399` (badge strings).
- Gate: none.

**P15. Palette and picker selection in pink.**
- What: `PaletteRowText` (`Overlay.tsx:195-216`): the selected row's `▌` marker and matched spans take `accent` (today bold only); `Pane.tsx:123` already uses `accent` for the picker's selected row.
- Tests: `round2-overlay.test.tsx` SGR check.
- Gate: composer-latency `palette` series p95 < 16 ms (colour only).

---

## 9. Test plan (deliverable f)

### 9.1 Unit (vitest `unit`, offline)

| Area | File | New / changed assertions |
| --- | --- | --- |
| Theme | `test/unit/tui/theme.test.ts` | §3.1 table values at 24/256/16; every coloured role ≥ 4.5:1 against `#1e1e1e` (dark) and `#ffffff` (light) by the WCAG formula; `assistant` has a colour and the `[jevcode]` marker; `badge.marker === 'badge'`; `ansi` never dims; daltonized keeps red↔blue |
| Splash / hero | `test/unit/tui/splash.test.ts` | `splashFrame(t ≥ 700)` returns 6 rows (mark + tagline) with pink/grey spans and no `sweep`; tagline right edge = `offset + 56`; `[]` below 64 columns; ≤ 12 changed cells per 50 ms tick still holds through 600/650 |
| Reducer | `test/unit/tui/round2-reducer.test.ts` | `SplashState` transitions: `running →(settle)→ hero →(run:starting | panel | picker | turn)→ done`; `key` while running → `hero` (not `done`); `run:end` → `loop === null` |
| Layout | `test/unit/tui/layout/layout.test.ts`, `height.test.tsx` | `CAP.hero = 6`; hero + wizard at 16/24/40 rows ≤ `rows − 2`; pane yields first |
| Transcript | `test/unit/tui/round2-transcript.test.tsx` | gutter: every body at column 10; identity by the §6 normaliser; segment wrap table (F4/F5 rows); no continuation < 4 cells over 1,000 random `StepRecord`s; detail rows indented, hanging under `label  value`; spacer above `[ui]` with detail; `[jevcode]` label pink, `[you]` label bright, bodies uncoloured |
| Formatter | `test/unit/tui/plain.test.ts` | P5 texts; a golden `transcript.log` for one mocked run; `stepSummaryText` unchanged |
| Status | `test/unit/tui/status/lines.test.ts`, `toasts.test.ts` | `statusSpans` positions and roles (spinner, done word, meter words, secret, toast); `toastPhase`; drop order unchanged |
| Spinner | `test/unit/tui/spinner.test.ts` | frame set `░▒▓█▓▒`, static `◆`, ASCII twin; the §14.2 source scan still lists `useAnimation(` in `motion.ts` only |
| Console / review / overlay | `round2-console.test.tsx`, `review.test.tsx`, `round2-overlay.test.tsx` | edge roles idle/live/fading; keys row dim → bold on `armed`; palette selection pink |
| App | `test/unit/tui/app.test.tsx`, `round2-app.test.tsx` | no `Type to steer` / `starting` frame after Enter; sweep ≤ 6 frames with unchanged row count (fake clock); border fade 3 frames; hero present until the first submission |
| Frames | `test/unit/tui/frames2.test.ts` | the §4.10 frames re-baselined for the gutter and P5 texts; R-1/R-1w/R-8/R-8w added (the test rebuilds every frame from the twins and compares with the design document, so `docs/TUI-DESIGN-2.md` §4.10 or a new §4.11 must carry the new frames verbatim) |
| Copy | `test/unit/chat/*`, `test/unit/cli/*` | no "Claude" in mode items or facts; one badge table |

### 9.2 pty (`test/pty`, `--mock`)

- `splash-settle.steps`: `expect Decisions, not strings` after the settle; wordmark cells > 0 in the settled frame; `send hi` → `expect ◆ jevcode` on the first `[you]` frame; still 0 clears.
- `splash.steps`: a key at 100 ms → the mark completes (hero) instead of vanishing; `expect (?:›|>) h` unchanged.
- New `hero-panel.steps`: `/panel` before any turn replaces the hero; `/panel off` does not bring it back.
- New `polish.steps` at 24×80 and 40×120 through `chat-task`'s path: run `scripts/pty/polish-check.mjs` over the capture for V1–V18 (the checklist as code; V7, V13, V16, V17 are the regression guards for F2/F4/F5/F8).
- `round2.pty.test.ts:149` (`chat-task`): add V7 and V18 over the `.txt`; `:312` regex for `/cost`; `:654` identity with the normaliser.
- Twins: `chat-hi` under `--ascii`, `--no-color`, `--no-animation`, `--screen-reader`, and `chat-ambiguous-flat` at 12×60 pass V6–V13, V16–V18.

### 9.3 perf (`jevcode perf`, `src/perf/*`)

- `first-frame.ts`: unchanged gate (< 300 ms cold p95 at 40×120, 24×80, 8×40; frame 0 carries wordmark cells at ≥ 16×64).
- `render-lag.ts`: splash bucket ≤ 15 frames; add a `run-start` bucket (`framesPerSecondByClass(frames, …, tRunStart, tRunStart + 1000)`) gated at `maxFps + 1`; 0 clears; region ≤ `rows − 2` (12 during the hero).
- `composer-latency.ts`: `idle` series now types into the hero (12-row region): p95 < 16 ms, max < 50 ms — re-baseline `perf/results/latest.json`; `live`, `palette`, `review` unchanged.
- `states.ts`: `wizard` scenario at 24×80 and 12×60 shows the hero at 24×80 only; `review-card`, `palette-card`, `intake-card` unchanged in clears.
- `intake-latency.ts`: `thinking seen` 20/20 (P7).

### 9.4 Live (paid, once per provider, into `docs/live/tui/round-3/`)

Re-run `docs/live/tui/round-2/run-live.sh` for `auto-24x80` and `auto-40x120` on the new bundle; run `polish-check.mjs` on the captures; compare the README table (first frame, settle, `hi` → `[jevcode]`, task → `[run] start`, clears, key bytes = none).

---

## 10. Risks and open questions

- **Pink beside red.** `[block]`/`error` red `#F87171` and the pink `#f386a1` are 15° apart in hue; a row with a pink label and a red body is legible (bold + marker) but not pretty. If the owner prefers, shift `error` toward `#ef4444` (more saturated, less pink) — a one-line theme change; V4/V5 keep the two apart in meaning either way.
- **Hero lifetime.** This report ends the hero at the first submission. The alternative — committing the mark once into `<Static>` so it scrolls with the conversation like opencode's home logo — would put six wordmark rows into the TUI's scrollback that `--plain` does not print; the identity predicate would need a carve-out like the header's. Recommended only if the owner wants the mark visible after the first turn.
- **Version string.** `VERSION` reads `package.json` (0.2.0) — the brand row will say `0.2.0` until the release bump (`docs/RELEASE.md`).
- **`/jev` p50 = p95.** `questions 4606 · latency p50 424 ms · p95 424 ms` in the capture looks like one sample; a data question for the `/jev` owner, not a rendering one.
- **`transcript.log` consumers.** P5 changes engine-item text; a `grep -rn "steps=\|mode=\|wall=" src test bench` must come before it lands. The `--json` stream is untouched.
- **The `◈`/shade choice.** The shade pulse reuses tested glyphs; if the owner prefers braille, P6 becomes colour-only (`spinner` role) with today's frames.
- **R3 overlap.** The wizard title, the one-key copy and the "Claude" wording are R3's; this report only fixes their look and lists the strings.

---

## Appendix A — external patterns extracted (fetched 2026-09-21)

| Source | Pattern worth copying | Applied as |
| --- | --- | --- |
| charm `bubbles/spinner/spinner.go` | Spinner sets with fps: `Line |/-\` 10 fps; `Dot ⣾⣽⣻⢿⡿⣟⣯⣷ ` 10 fps; `MiniDot ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 12 fps (today's JevCode set at 8 fps); `Pulse █▓▒░` 8 fps; `Points ∙∙∙ ●∙∙ ∙●∙ ∙∙●` 7 fps; `Meter ▱▱▱ ▰▱▱ ▰▰▱ ▰▰▰ ▰▰▱ ▰▱▱ ▱▱▱` 7 fps; "most of the time you'll just want foreground … coloring" | P6: the `Pulse` family (already in the glyph table) at the existing 8 fps, foreground only |
| charm `bubbles/progress/progress.go` | defaults: full `▌`, empty `░`, width 40, gradient `#5A56E0 → #EE6FF8` (purple → neon pink), percent `" %3.0f%%"`, spring at 60 fps | the streaming caret `▍`; the meters stay text (a gradient bar would be colour without a marker) |
| `lipgloss` README | rounded/normal/thick/double/ASCII border sets; `Place`/`JoinHorizontal`; adaptive light/dark colours; downsampling by profile | the console and cards already use the `round` set (`card.ts`); the depth downshift is `colorAt` (`theme.ts:181-185`) |
| opencode `docs/themes`, `docs/tui`, `01-opencode.md` | theme keys `primary secondary accent … text textMuted … border borderActive borderSubtle`; themes reference colours by name, ANSI number or `none`; footer = cwd left, `△ N Permission(s)` warning right; toasts with a coloured side border, 5 s; the prompt header shows agent + model; long pastes fold into `[Pasted ~N lines]` | the role names map 1:1 (`accent`, `border`/`borderFocus`, `dim`); the badge-in-the-edge is our "agent + model" header |
| Claude Code `interactive-mode`, `statusline`, `terminal-config` | theme tokens: `claude` "Primary brand accent, used for the spinner and assistant label" with a `claudeShimmer` pair for the spinner gradient; `promptBorder`; status line example `[$MODEL] 📁 dir | 45% context`, threshold colours green/yellow/red, `▓▓▓░░░` bars; `/theme` presets `dark, light, dark-daltonized, light-daltonized, dark-ansi, light-ansi`; custom themes `~/.claude/themes/*.json` with `#rrggbb`, `ansi256(n)`, `ansi:<name>` | the brand accent colours the spinner and the assistant label (P2/P6); meter words coloured by threshold (P6); our four themes mirror the six presets |
| Gemini CLI `docs/cli/themes`, `03-gemini-cli.md` §12 | custom theme schema `background.primary`, `text.{primary,secondary,link,accent}`, `border.{default,focused}`, `status.{success,warning,error}`, `ui.{comment,symbol,gradient}`; example Gruvbox hexes; spinner `dots` with `(esc to cancel, Ns)` and witty phrases every 5 s (off in accessibility mode) | `border.default/focused` = our `border`/`borderFocus`; no witty phrases (they are motion in text) |
| gh-dash `configuration/theme` | YAML `colors.text.{primary "#ffffff", secondary "#c6c6c6", inverted, faint "#8a8a8a", warning, success}`, `border.{primary "#808080", secondary, faint}`, `ui.table.showSeparators` | the three-tier text (`#fefefe`/`#dedede`/`#abbab9`) and one border tier |
| `06-tui-conventions.md` §13 | "Yellow and red are reserved for errors and warnings", palette "magenta, cyan, blue, green, and gray"; never colour alone; Okabe–Ito: prefer magenta/green over red/green | pink/magenta as the accent family is the conventional non-semantic choice; every colour keeps its marker |

## Appendix B — the typesafe.ai palette as fetched (curl, 605,701 bytes of HTML, 2026-09-21)

| colour | occurrences (hex + rgb forms) | role on the site (inferred from frequency) | ANSI-256 nearest |
| --- | --- | --- | --- |
| `#1e1e1e` / `rgb(30, 30, 30)` | 514 | page background | 234 |
| `#fefefe` / `rgb(254, 254, 254)` | 79 | headline text | 231 |
| `#dedede` / `rgb(222, 222, 222)` | 61 | body text | 253 |
| `#f386a1` / `rgb(243, 134, 161)` | 52 | primary pink | 211 (`#ff87af`) |
| `rgb(196, 196, 196)` (= `#c4c4c4`) | 15 | muted text | 251 |
| `#e5e5e5` | 6 | light text | 254 |
| `#d45bb6` / `rgb(212, 91, 182)` | 6 | secondary magenta | 169 (`#d75faf`) |
| `#abbab9` / `rgb(171, 186, 185)` | 3 | grey-teal muted | 249 |
| `#09aea1` | 1 | teal accent | 37 |
| `#03aa5c` | 1 | green accent | 35 |

Fonts in the HTML: `Inter` (Framer default), `JetBrains Mono` (6 declarations), `Fragment Mono` (3). Copy lines present verbatim: "Decisions, not strings", "more like code", "Zero Hallucinations", "Machine-Native Intelligence", "calibrated confidence", "Jev returns typed decisions with calibrated probabilities". Product names: TypeSafe AI, Jev, System One Models.
