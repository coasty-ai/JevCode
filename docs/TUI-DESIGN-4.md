# JevCode TUI round 4 — implementation design (the brand up top, command output, resize & terminal robustness, Enter-cycling, conversation, file edits, production hardening)

Written 2026-09-21 against the working tree of `main` at `046b250` — i.e. **round 3 as it is being implemented right
now** (`docs/TUI-DESIGN-3.md`, five slots, most of `src/tui/**` uncommitted). Line anchors are `file:line` in that
working tree unless a row says PROBED, in which case the number is from the **last committed tree `ec61170`** where the
seven round-4 audits ran their captures. The two trees differ: `src/tui/wordmark.ts`, `src/tui/transcript/wrap.ts`,
`src/tui/commands/local.ts`, `src/perf/idle-frames.ts` and 24 `.steps` files exist only in the working tree
(`git status`), so every audit sentence about "the wordmark" is a static reading and every capture is round 2 + the
committed half of round 3. Where that matters the text says so.

Inputs: the seven audits under `docs/research/tui/round-4/` — `pinned-header.md` (**A1**), `resize-robustness.md`
(**A2**), `command-output-style.md` (**A3**), `palette-enter-cycling.md` (**A4**), `conversation-edge-cases.md`
(**A5**), `file-edit-display.md` (**A6**), `production-hardening.md` (**A7**) — with their captures and probe
harnesses (`pinned-header-probe/`, `resize-probe/`, `captures/a5/`, the two `file-edit-*.cap` pairs).
`docs/TUI-DESIGN.md` is `TD §n`, `docs/TUI-DESIGN-2.md` `TD2 §n`, `docs/TUI-DESIGN-3.md` `TD3 §n`. Round 4 **builds on**
round 3 and never respecifies it: the 10-cell label gutter (TD3 §5.1 rule 1), the segment-aware wrap (rule 3), the
TypeSafe pink roles (TD3 §2), the persistent wordmark (TD3 §3), the 21 aliases and the palette row anatomy (TD3 §4) and
the §5.3 identity normaliser are **given**. Where round 4 changes one of them the row says which TD3 rule it amends.

**This is revision 2.** Every finding of the round-4 design review is applied in place; **§14.2 "Review log"** is
the audit trail (what changed in which section, or why a finding was rejected, with the evidence that decided it).
If a sentence here disagrees with a memory of revision 1, §14.2 says which way it moved and why.

Read §0 → §8 → §9 (your slot) → the sections your slot's row names. Frames are captioned
`**F-xN. … W×H (D dynamic rows; S scrollback rows above)**` in TD2 §8.1's `readFrames` grammar; every frame row below
was width-checked by script at its geometry (`scripts/pty/polish-check.mjs` reads them back — TD3 §9).

**Standing constraints every proposal keeps** (the brief; §11 names the gate per change): first frame < 300 ms with
zero network and zero file I/O before it; composer keystroke → frame p95 < 16 ms with key frames on Ink's immediate
path (TD2 D-F); render lag p95 < 5 ms while typing during a run; dynamic frames ≤ maxFps + 1 during a run; zero
terminal clears outside shrink resizes; `transcript.log` == `--plain` == TUI rows through the one formatter
`src/tui/plain.ts` or a **declared** normaliser; keys never printed or logged; no auto-approve of reviews; reduced
motion / screen reader / `--plain` / `--ascii` / `NO_COLOR` / SSH fps 15 / the flat tier < 16 rows all keep working; no
new runtime dependency (`ink` + `react` only); strict types, no `any`.

**The user's round-4 request, verbatim** (six sentences; the section that answers each is in brackets): 1 "make sure
jevcode stays up on top the ascii design" [§1] · 2 "the output of the commands look super clean … super detailed …
nice separated" [§3] · 3 "the TUI is really robust handles all edges and corner cases and does not look weird when
resized … heavy production grade" [§2, §7] · 4 "file edits and all the commands look the cleanest without missing
anything" [§6, §3] · 5 "the most intuitive UI even the texts in the history … the most clear separations" [§5, §3.6] ·
6 "when we are going through commands after typing / we can click enter button and toggle through options" [§4].
Earlier, from the same user: opencode-like looks, "viral worthy", "conversational in the highest degree".

---

## 0. Owner decisions (D-S … D-AB) and how each is honoured

Ten decisions. **D-S is the owner's architecture call** and is presented as a decision table in §1.1 with a
recommendation; the rest are this document's, with the ones marked **ratify** needing the owner's word before the slot
that lands them starts. Nothing in D-G … D-R (rounds 1–3) is reopened.

| Decision | Status | Honoured in | How, and why |
| --- | --- | --- | --- |
| **D-S** *the header architecture.* The classic hybrid (`<Static>` scrollback + a bounded dynamic region) stays the **default** and gains three visibility changes so the word `jevcode` is on screen in every state; the literal pinned-at-row-1 layout ships as an **opt-in** renderer `ui.renderer: fullscreen` (`--fullscreen`), which forces `alternateScreen: true` + `incrementalRendering: true`, adds a keyboard-scrolled viewport, `/scrollback` and an on-exit transcript dump, and refuses (falling back to classic with one note) below 18 rows / 40 columns / under a screen reader / `TERM=dumb` / non-TTY | **OWNER, ratify** (recommended: yes to both halves; §1.1 has the table and the two fallbacks) | §1 | A1 measured it: full-screen on the **primary** screen is unshippable — Ink writes `ESC[2J ESC[3J` at unmount for every fullscreen session (`ink.js:96–99`, capture `A-full-24x80-std.cap.gz`) and `ESC[3J` deletes the user's scrollback. On the alternate screen it works but costs 2.2× the bytes per keystroke at 24×80, 6.7× at 60×200, **misses D-F** at 60×200 with the default renderer (p95 17.15 ms vs 3.81 ms hybrid) and has a cliff: a tree one row too tall produces a full `clearTerminal` **on every frame** (measured 37 clears / 36 frames). It also takes away wheel scrolling, find-in-scrollback and whole-session copy. The user's sentence is satisfiable inside the hybrid for ≈ 200 lines (D-T + the brand rule); the literal reading is satisfiable only behind a flag. Claude Code ships exactly this split (`docs/research/tui/02-claude-code.md:205–215`) |
| **D-T** *the brand never leaves, and the mark stays up during a run at ≥ 32 rows.* (a) After the first `run:ready` the rule row's strip gains a `◆ jevcode` prefix — dropped first when the strip runs out of width, and **drawn whether or not the 5-row mark is up**: TD3 §729 already decided that "the strip keeps its information; the mark sits under it" (F-W5), which is what F-H1, F-H2 and §11's `brand-strip` gate draw; (b) `wordmarkWanted` stops hiding the mark while a run is live once `rows ≥ WORDMARK_LIVE_MIN_ROWS = 32`, with the idle sweep frozen while live so a run still writes zero decoration frames | **ratify** (recommended) | §1.2 | Measured on the **working tree** (offline `computeLayout` probe, this document's §1.2 table): today the mark sits at physical rows 12–16 of 21, 15–19 of 24, 31–35 of 40, **51–55 of 60** — the taller the terminal, the *lower* the brand, which is the user's complaint in one table; and it is absent in every live frame. With the mark up during a run the worst-case live region is `rule 1 + live 2 + banner 1 + queue 2 + mark 5 + console 5 = 16`, so 32 rows still leaves **16 rows of visible conversation** — the floor. Below 32 the run needs the rows |
| **D-U** *one command-output grammar.* `block(head, rows: BlockRow[], opts)` replaces `block(head, string[])` at all **24** call sites in one commit — **20 in `session.ts`** (`:1682, 2529, 2586, 2608, 2613, 2658, 2776, 2809, 2824, 2840, 2846, 2865, 2872, 2950, 2981, 3118, 3175, 3189, 3791, 3910`; the definition at `:1364` excluded) **plus the 4 App-local twins** (`/help`, `/why`, `/decisions`, `/plan`); `blockWidth(columns)` — the **rung's** body width (`columns − 10` in `gutter`, `columns − 2` in `stacked`, `columns` in `flush`), clamped to `[1, 160]` and never floored above the available width — is the one width every body builder is given; five row kinds (`kv` · `facts` · `table` · `rule` · `note`) plus `gap`; four block tiers `tight`/`narrow`/`standard`/`wide` at width 34/60/100; `/config` folds default-valued rows behind `… +N settings at their defaults (/config --all)` and never folds a row with a problem | **ratify** (recommended) | §3.1–§3.3 | PROBED (A3, `ec61170`): **58 of 109 command-output rows exceed 80 cells**; `/config` alone is 42 rows with a **182-cell** widest row because `config-table.ts:107` pads the value column to the longest value (an absolute path) — still true in the working tree, verified. Seven of twelve body builders take no width at all. Round 3's D-L moves detail rows to column 10, so **every** pane-derived block would otherwise overflow by exactly 10 cells |
| **D-V** *D-M is discharged: the engine-item text rewrite lands in round 4.* The §3.6 table rewrites `run:start`, `run:ready` (deleted as an item), `intent`, `context`, `synth`, `proposal`, `risk`, `confirm:resolved`, `outcome`, `judge`, `plan`, `loop:tripped`, `replan`, `steer:*`, `pause:requested`, `retry:settled`, the `stop:` line (deleted), `run:end` and the epilogue rows, in `src/tui/plain.ts` (+ `src/loop/stop.ts`), with the complete pin inventory of §3.7 — **including `src/perf/pty.ts:800` `END_PATTERN` and `:804` `RUN_STARTED_PATTERN`, which must move in the same commit** | **ratify** (recommended: land it) | §3.6, §3.7 | TD3 D-M deferred exactly this to round 4 and named the cost: twelve test files plus the two perf constants. The measured payoff (A3 §2.9, §4): the same stop is stated **three times in three consecutive rows**; an `ok` risk verdict costs **8 terminal rows**; `[run] end … exit` / `0` wraps a token alone; a compact run drops from 20 to 18 terminal rows and the run id from three places to one. R2 of A3's risk table is the danger: a stale `END_PATTERN` silently turns the render-lag window into the whole capture and the gate into a lie |
| **D-W** *a block is the same in all three sinks.* `Engine.annotateBlock(head, rows, opts)` (contract, additive) emits one `notice ui` per row, head first, so a command issued while a run is live writes the same rows to `transcript.log` from the TUI as from `--plain`; capped at `BLOCK_LOG_MAX = 24` rows with a final `… +N more rows` | decided (not an owner taste call — see why) | §3.5 | PROBED (A3 §2.8): the same `/cost` issued while a run is live writes **1 row** to `transcript.log` from the TUI and **7** from `--plain`, and the logged row (`run $0.000 of $2.000 (0 %)`) does not name the command. Both alternatives were weighed: "head only" makes `--plain`'s stdout and `--plain`'s `transcript.log` disagree, which breaks the standing rule in a second place. `annotateBlock` is the only option under which all three sinks match |
| **D-X** *the palette model:* **"Tab goes deeper. Enter runs what is written. Enter with nothing written yet walks the list."** Cycling never mutates the draft (the highlight is a dim ghost); the ghost **is** the highlight (one `paletteGhostFor(query, matches, selected)`); Enter runs iff the draft is exact **and** the marker is on the draft's own row; the marker resets to the top on every query change; `/new`, `/abort`, `/exit` and `/history clear` reached **through the palette** get a one-row confirm whose Enter is inert | **ratify** the provenance rule (the rest decided) | §4 | The user's sentence 6 is literally "click enter button and toggle through options", so Enter cycles. A4 proved the safety property: **no sequence consisting only of Enter presses can execute `/new`, `/exit`, `/abort` or `/history clear`** (§4.1). Measured today (A4 p1, A5 case 41): ↓↓Enter on `/` yields `[ui] error: unknown command /` and the palette stays open; the ghost previews `matches[0]` while the marker sits on `matches[selected]`, so two commands are on screen at once (A4 p5) |
| **D-Y** *the conversation is turns, not lines.* One spacer per **turn** (not per item); `bubbleLines` keeps blank lines and expands tabs to 4; a clipped message says how much is missing; a burst of Enters is N Enters; Enter while thinking **queues** (cap 1) instead of dropping; a steer gets its `[you]` bubble; a conversation-only session is minted, persisted and replayed on `/resume` | **ratify** the three text changes (bubbles, the clip marker, the steer bubble) | §5 | PROBED (A5): a 3-line message renders as **3 `[you]` turns with a blank row between every line** — 17 rows for a 9-line paste (`Transcript.tsx:160` is unconditional for `[you]` while `:161` gets `[jevcode]` right); `bubbles.ts:24–25` drops blank lines and collapses tabs, so pasted code is misrepresented; two Enters in one read become newlines and a later `/exit` line is submitted as chat; Enter while thinking drops the submission; a conversation-only session is never written to disk so `/resume` can never restore it. The turn rule cuts a 9-line paste from 17 rows to 10 |
| **D-Z** *one diff renderer.* `src/tui/diff/rows.ts` (`diffRows`) is the only place a diff becomes rows — the review card, the `<Static>` detail body and `/diff <step>` all call it; `ColorRole` gains `added` · `removed` · `hunk` · `diffMeta`, each with its sign already in the text; `editSummary(action)` names the files and counts of **every** edit action including `patch` | **ratify** (P1/P6/P7 are engine-item text and ride D-V's commit series) | §6 | PROBED (A6): a `patch` proposal **never names a file** (`plain.ts:165–168` → `18 line unified diff`); an `edit` preview is two whole blobs labelled `--- old` / `+++ new` with no signs, numbers or context; **every** preview and detail row is painted flat `dim` (`Review.tsx:136,183`, `Transcript.tsx:216`) because `ColorRole` (`theme.ts:69`) has no added/removed member — with or without colour a removed and an added line look identical. The product already owns a correct `unifiedDiff()` (`undo/diff.ts:443`) that the review path never calls |
| **D-AA** *hardening.* `guard()` gets a per-pane latch; a failing checkpoint write degrades **loudly** and the epilogue never advertises a resume that cannot work (exit 3); every React boundary hole is closed **including the wordmark**; one typed `parseFault()` with 13 scenarios; a 45 s submission watchdog and an unconditional second-Ctrl-C exit; `explainFsError` turns raw errnos into sentences | **ratify** | §7 | PROBED (A7): `guard()` (`App.tsx:1962–1982`) has **no latch**, so a deterministic builder throw is an unbounded render + dispatch loop committing one `<Static>` item per iteration on Ink's immediate path — an unkillable flood; deleting or chmod-ing the runs dir mid-run is **completely silent** (run reports `complete`, exit 0, and the epilogue advertises `resume jevcode run --resume <id>` for a directory that no longer exists); `JEVCODE_FAULT=render:<pane>` fires in **1 of 6** React boundaries in the default frame, and round 3's wordmark — the idle tenant, on screen most of a session — renders at `App.tsx:2186–2192` outside every boundary |
| **D-AB** *the narrow ladder.* Three rungs by terminal width, not two: `columns ≥ 34` today's gutter (TD3 rule 1); `24 ≤ columns < 34` **stacked** (label on its own row, body at `columns − 2` with a 2-cell hang); `columns < 24` **flush** (no gutter, body at `columns`); plus a per-item cap `STATIC_ITEM_MAX_ROWS = 24` with a final `… +N rows (transcript.log)` row at every rung, **applied to engine-produced items only** — an item carrying `detailRows` from a command block keeps its own §3.1.5 cap and footer, so `/config --all`, `/help`, `/plan` and `/diff --all` are never cut to 23 rows (§2.3's source-keyed exemption). The rung also fixes `blockWidth`, which is the rung's body width and has **no lower floor** | **ratify** (this is where A2 and A7 disagreed — §14.1 row 4) | §2.3 | Measured on the **working tree**: at 10 columns `bodyWidth` is 1 and a 296-char step item commits **258 rows**; at 2×10 a single `[sandbox]` item became **183 permanent scrollback rows** (A7 §2.3, `tiny2.cap`). A2 wanted a stacked ladder (keeps every character, many rows); A7 wanted one truncated row (bounded, loses the text forever). The ladder plus the cap is bounded **and** lossless up to 24 rows, and the tail names where the rest is |

**Kept from TD/TD2/TD3, untouched:** one modal slot; one `computeLayout` (the classic renderer's — `fullscreen` gets a
*second*, separate allocator, §1.3); `<Static>` the only scrollback writer in classic; `lines()` twins; no new
dependency; Jev decides; the review invariants (`app.test.tsx:342–461`, only `y` approves, Enter inert);
`itemsFromEvent`/`formatTranscriptItem` as the one item source; `useAnimation(` only in `motion.ts`, `setInterval(` only
in `spinner.ts`/`retry.ts`; `src/synth/**`, `src/bench/**`, `src/jev/**` read-only this round. `src/loop/**` is
read-only **except** `src/loop/stop.ts:56` (D-V deletes the `stop:` line) and `src/loop/engine.ts`'s `annotateBlock`
(D-W) and checkpoint-degrade emit (D-AA) — three named edits, listed in §9.

---

### 0.1 Owner ratification (2026-09-22, before implementation)

| Decision | Owner's word |
| --- | --- |
| D-S | **Ratified**: the classic hybrid (native scrollback, the mark above the console, the `◆ jevcode` brand permanent on the strip) stays the default; `ui.renderer: fullscreen` ships as the opt-in that pins the header at the physical top (alternate screen + incremental rendering forced, keyboard scrolling, `/scrollback`, the on-exit transcript dump). Measured trade-off (audit A1): the full-screen layout costs 2.2–6.7× the bytes per keystroke, misses the 16 ms key gate at 60×200 without incremental rendering, and loses the terminal's own scrollback and search. The user's "stays up on top" is met at the top of the interactive region by default and at the physical top by `/fullscreen`; the owner will put this choice to the user in the round-3/4 report. |
| D-T (a)(b) | **Ratified** as amended (brand prefix drawn whether or not the mark is up; the mark stays up during a live run at ≥ 32 rows with the sweep frozen). |
| D-U | **Ratified** as amended (rung-derived `blockWidth` clamped to [1, 160], 24 call sites, tiers tight/narrow/standard/wide). |
| D-V | **Ratified — land it** (mechanical pin inventory with counts; glyph-agnostic named anchors with two-glyph-set self-tests and zero-match hard failure; the `outcome blocked/declined/failed` row so V13 can pass). |
| D-W | Noted as decided (`[ui] <row>` per row in both stdout and transcript.log). |
| D-X | **Ratified** as sharpened (`fromPalette` = `acceptedRef` set only by an accept or a cycle, cleared by any edit; `arg0`/`restTail`; S-ARGBAD; fitRung confirm ladders; the gated `--plain` numbered pick). |
| D-Y | **Ratified** as amended (dim label on every continuation row; the intake body ladder keeps `(Enter does nothing)`; P-C17(c) TUI half dropped for Esc). |
| D-Z | **Ratified** as amended (two line-number columns with `< 60` / `< 20` degradations; no `/diff` pointer on the pre-apply card). |
| D-AA | **Ratified** as extended (`/ui reset` and `/peers` fully specified; the wizard read-only at minsize). |
| D-AB | **Ratified** as amended (`STATIC_ITEM_MAX_ROWS = 24` for engine-produced items only; command-block items keep their own cap and footer). |
| Mechanical consequences | Accepted: `src/tui/fit.ts`, `src/tui/gutter.ts`, 37 → 41 commands, `createResizeDebounce` leaves the public index (CHANGELOG), §7.13(f) withdrawn in favour of documenting the `rows < 3` static-only contract, `guardStdout` additions. |

## 1. "jevcode stays up on top": the header, the layout model, and the opt-in full screen (D-S, D-T)

### 1.0 Where the brand actually is, measured on the working tree

`computeLayout` run offline against the in-flight round-3 tree (idle, boxed, 80 columns, `paneWhole: true`,
`paneWant: CAP.splash`), physical rows counted from the top of the terminal because the dynamic region is the **last**
`total` rows once the scrollback has filled:

| terminal rows | dynamic rows | mark at physical rows | top of the mark, % down the screen | during a live run |
| ---: | ---: | --- | ---: | --- |
| 21 | 11 | 12–16 | 57 % | absent |
| 24 | 11 | 15–19 | 63 % | absent |
| 40 | 11 | 31–35 | 78 % | absent |
| 60 | 11 | 51–55 | 85 % | absent |

Round 3 made the mark **persistent**; it did not make it **top-anchored**, and `wordmarkWanted`
(`src/tui/wordmark.ts:77–94`) still returns false for `run ∈ {live, aborting, pausing}` at every height. After the
first `run:ready` the word `jevcode` also leaves the rule row altogether (`Pane.tsx:66,71,72`: `plainRule` while the
mark is up and `!ranBefore`, `brandRow` while `!ranBefore`, `panelStrip` after). So on a 60-row terminal during a run
the brand is nowhere in the dynamic region. That is the whole of the user's sentence 1.

### 1.1 The decision table (D-S — the owner's call)

`H` = the 5-row ASCII mark at physical row 1 in every frame. Every number is A1's measurement (60 keys 100 ms apart,
200 transcript items, `stdout.write` instrumented inside the prototype, `pinned-header-probe/results.jsonl`).

| criterion | **A** fullscreen + alt screen | **A′** fullscreen, primary screen | **B** classic today | **B+** classic + D-T (recommended default) | **B′** DECSTBM header outside Ink |
| --- | --- | --- | --- | --- | --- |
| mark at physical row 1, always | **yes** | yes | no (row `r−9`) | no | yes |
| the word `jevcode` on screen in every state | yes | yes | **no** (gone after run 1, gone while live) | **yes** (strip prefix) | yes |
| the 5-row mark visible during a run | yes | yes | **no** | **yes at ≥ 32 rows** | yes |
| native scrollback (wheel, Shift+PgUp) | **lost** | lost | kept | **kept** | **lost** (region lines are not saved) |
| find-in-scrollback / whole-session copy | lost | lost | kept | **kept** | lost |
| bytes/keystroke 24×80 · 60×200 | 2 855 · 8 585 (std) / 181 · 409 (inc) | same | 1 695 · 3 675 | **= B** | ≈ B |
| composer p95 at 60×200 | **17.15 ms ✗** std / 12.48 ms inc | same | **3.81 ms** | = B | ≈ B |
| bytes per scroll step | 3.4–5.3 KB | same | **0** (the terminal scrolls) | 0 | 0 |
| clears | 1/shrink + 1 at unmount, all **inside** the alt buffer | 1/shrink + **1 at unmount on the user's screen**, each `2J`+`3J` | 1/shrink (`3J` — §1.4 fixes it) | = B | ≥ 1/shrink, **header destroyed by `ESC[H`** |
| off-by-one failure mode | **37 clears / 36 frames** | same | none (budget `rows − 2`) | none | same as A |
| exit leaves the transcript on screen | no, unless dumped (§1.3.5) | yes | yes | yes | yes |
| crash / SIGKILL | user stranded on the alt buffer unless `RESTORE` writes `1049l` | screen wiped by the unmount clear | safe | **safe** | margins left set |
| screen reader | must refuse (5.1 KB/key, `ink.js:370–412`) | must refuse | works | **works** | n/a |
| new surface to own | viewport, wrapped index, scroll keys, sticky-bottom, position row, exit dump, alt teardown ≈ 900 lines | + scrollback destruction | 0 | **≈ 200 lines** | margins + header painter + a clear filter, ≈ 300 lines + terminal risk |

**Recommendation: ship B+ as the default and A as `ui.renderer: fullscreen`.** A′ is not shippable (reason 1 of A1
§6 — Ink's unmount clear carries `ESC[3J`). B′ is rejected on the record: lines scrolled out of a DECSTBM region are
not appended to the saved-lines buffer in xterm-family terminals, so B′ pays A's price (no native scrollback) *and*
adds out-of-band terminal state nothing in the codebase owns, *and* `clearTerminal`'s `ESC[H` homes outside the region
and destroys the header on every shrink. A **falsifiable** two-observation probe per terminal is specified in §2.9 P-R14
in case anyone wants to re-open it.

**The two fallbacks, if the owner declines part of D-S.** (a) *Decline the fullscreen renderer:* §1.3 moves to round 5
verbatim and slot **S1** loses ~60 % of its work; §1.2, §1.4, §1.5 and everything else in this document are unaffected.
(b) *Decline B+ too* (keep today's visibility): §1.2 is dropped, request 1 is answered only behind `--fullscreen`, and
the `wordmark-live` and `brand-strip` gates of §11 are dropped. Neither fallback touches another section.

### 1.2 The classic renderer (`ui.renderer: classic`, the default) — three changes

Nothing architectural changes. `computeLayout`, `CAP`, `<Static>`, `Transcript`, `Console`, `Overlay`, `Review`,
`Composer`, `StatusLine`, the key resolver and `plain.ts` are all untouched by this subsection.

**P-H1 — the brand prefix on the rule row.** `panelStrip` (`src/tui/pane/model.ts`) gains an optional
`brand: boolean`; when set it prepends the segment `◆ jevcode` (accent; `* jevcode` under `--ascii`) and includes it in
the existing shrink loop, so it is the **first** segment dropped when the strip runs out of width.
`ruleRowText` (`src/tui/Pane.tsx:62–73`) passes `brand: true` on **every** `panelStrip` call — **the strip brand and
the 5-row mark coexist**, which is what F-H1, F-H2 and §11's `brand-strip` gate draw and what TD3 already decided:
`docs/TUI-DESIGN-3.md:729` — "the strip keeps its information; **the mark sits under it** (F-W5)". The code agrees:
`Pane.tsx:66` returns `plainRule` only while `!i.ranBefore`, so after the first run the rule row **is** `panelStrip`
(`:72`) with the mark below it. There is no repetition to avoid: the rule row's `◆ jevcode` is a 9-cell segment, the
mark is a 5-row figure under it, and the two together are the "brand up top" the user asked for. (An earlier draft
carried a `brand: !i.wordmark` clause justified as "F-W5's strip would repeat the mark"; that is false about round 3
and contradicted its own frames — §14.2 "Review log" item 6.) `brandSpan` (`src/tui/splash.ts:259–268`) currently finds
`<glyph> jevcode ` and ends the span at the **next space**, i.e. it assumes a version token follows; it is generalised
to end at `jevcode` when the following token is not a version. That one-line change is the only colouring change.

*Edge cases.* (1) < 64 columns: the brand is dropped by the existing `while (segments.length > 1)` loop, so a
40-column strip is byte-for-byte today's. (2) `--ascii`: `g.brand` is already `*`. (3) `NO_COLOR` / depth 0: identical
text, no SGR — the word still reads. (4) picker open: `pickerHeader` wins (`Pane.tsx:63`), unchanged. (5) panel
open/full: `paneRuleRow` wins; the tab header takes the same prefix through the same helper and the same drop order.
(6) splash running below 64 columns: `brandRow` already carries the brand — guarded by the `wordmark` branch at
`Pane.tsx:65–67`, no double brand. (7) `RULE_MAX_CELLS = 400` (`Pane.tsx:17`) unchanged. (8) the string `◆ jevcode`
must never be mistaken for a transcript row by the pty helpers — `pty.ts`'s `composerRow`/`paintedRows` key off the
console box, not the rule row (verified). (9) **the rule-row fixtures that re-pin in the same commit, enumerated
here.** §3.7 does **not** list them — that table is the D-V engine-item inventory and the two sets are disjoint:
`test/unit/tui/round2-lines.test.ts:99, 100, 114–120, 281, 282, 297` (exact `panelStrip` / `ruleRowText` strings —
the bulk of the work) · `test/unit/tui/app.test.tsx:106` (`/─── ▸ jev s3 · 3 decisions/`) ·
`test/unit/tui/height.test.tsx:94` · `test/unit/tui/round3-wordmark-app.test.tsx:218, 226, 235, 245` ·
`test/unit/tui/splash.test.ts:216` (`brandSpan` returns null for a brandless strip — it must keep doing so for the
*pre-run* rule row and now find the span in the post-run one) · `test/pty/round2.pty.test.ts:557` ·
`test/pty/round3.pty.test.ts:136` · `src/perf/states.ts:278`. `app.test.tsx:106` is a **declared carve-out** to
§9.1's "never in `app.test.tsx`" rule, landed by S1 in W2 and recorded in §9.2's `App.tsx` row.

**P-H2 — the mark stays up during a run at ≥ 32 rows (D-T).** `wordmark.ts` gains
`export const WORDMARK_LIVE_MIN_ROWS = 32;` and `wordmarkWanted`'s `!runIsLive(i.run)` clause becomes
`(!runIsLive(i.run) || rows >= WORDMARK_LIVE_MIN_ROWS)`. The idle sweep is **not** enabled while live: `useIdleLoop`'s
`shown` input (`App.tsx:2069`) already gates it and gains `&& !runIsLive(state.run)`, so a run still writes zero
decoration frames and the `dynamic ≤ maxFps + 1` gate is untouched.

Arithmetic (offline probe, 80 columns, worst case `live 2 · banner 1 · queue 2`):
`rule 1 + live 2 + banner 1 + queue 2 + mark 5 + chrome 3 + composer 1 + status 1 = 16`; at 32 rows the budget is 30 and
`rows − total = 16` rows of conversation stay visible. At 30 rows it is 14, at 24 rows 8 — below the floor, so the mark
yields, which is what the whole-or-absent grant (`layout.ts:183`, `paneWhole`) already does for free.

*Edge cases.* (1) a panel opening mid-run still wins the slot (`panel !== 'collapsed'` clause, unchanged). (2) a review
arming mid-run still hides the mark (`overlay === 'review'`, TD A42, unchanged). (3) shrinking 40 → 30 mid-run: the
mark disappears in **one** frame — the whole-or-absent grant means there is never a partial mark — and costs the one
legitimate shrink clear. (4) `run:end` at ≥ 32 rows: the mark was already up, so `WORDMARK_POST_RUN_MIN_ROWS`
(`wordmark.ts:40`) becomes a no-op there; **assert** it, do not delete it — 21–31 rows still need it. (5) `--fps 15`
(SSH) and `ui.wordmark: static`: the static mark is shown, zero frames either way. (6) screen reader: unchanged (flat
tier, no mark). (7) `expanded` (review `e`): pane is 0 anyway.

**P-H3 — the wordmark renders inside a boundary.** `App.tsx:2186–2192` renders `mark.rows.slice(…).map(… <SplashRow
spans={mark.spans(loop.band)…}/>)` with **no `PaneBoundary` and no `guard()` around `mark.spans(...)`** — only the
producer `wordmarkFrame(...)` is guarded (`:2038`). This is §7.3's P-P3 item 2 and is listed here because it is the
same five rows: the branch is wrapped in `<PaneBoundary pane="wordmark" …>` and `mark.spans(loop.band)` moves inside a
`guard('wordmark', …, [])` whose fallback is **blank rows of the same height** (the idle tenant disappearing silently
is the correct degradation; the `[ui]` item carries the detail). Owner: S1; the boundary catalogue is §7.3.

### 1.3 `ui.renderer: fullscreen` — the opt-in pinned-header layout

Entered only with `alternateScreen: true` **and** `incrementalRendering: true`, both **forced**, never defaulted.

#### 1.3.1 Selection and refusal

`ui.renderer: 'classic' | 'fullscreen'` (default `classic`) is a **launch** setting — Ink fixes `alternateScreen` in
its constructor (`node_modules/ink/build/ink.js:256`), so it cannot be toggled in place. Precedence flag > env > file >
default, exactly like `fps` and `renderMode` (`src/config/launch.ts:39,104–106,127–137`). `--fullscreen` and
`--renderer <classic|fullscreen>` in `src/cli/args.ts`; `JEVCODE_RENDERER` in `.env.example`; a `ui.renderer` row in
`src/config/types.ts` / `ui.ts` / `config-table.ts`. `/fullscreen` persists the setting and offers a relaunch (it never
switches in place: `render()` is called once per stdout, `render.js:45–58`).

Refusal matrix — each falls back to `classic` and appends **one** `[ui]` note naming the reason:

| condition | reason string |
| --- | --- |
| `rows < 18` | `fullscreen needs 18 rows (now <n>) — the classic renderer is used` |
| `columns < 40` | `fullscreen needs 40 columns (now <n>) — the classic renderer is used` |
| `launch.screenReader` | `fullscreen repaints the whole screen on every key; the classic renderer is used under a screen reader` |
| `TERM` is `dumb` or absent | `fullscreen needs a terminal that supports the alternate screen (TERM=<v>) — the classic renderer is used` |
| `stdout.isTTY !== true` or `interactive === false` (CI) | (silent — no TUI at all) |
| `--plain` / `--json` | (silent — no TUI at all) |

`src/cli/fatal.ts`'s `RESTORE` (`:24`) gains `\x1b[?1049l` **only when the alternate screen was entered** — a
module-level flag set by `createTuiRenderer`. Without it a crash strands the user on a blank alternate buffer.

#### 1.3.2 `computeFullLayout` — the exact-height allocator (the anti-cliff)

A **second** pure allocator in new `src/tui/fullscreen/layout.ts`, never merged into `computeLayout`, whose
post-condition is `header + rule + viewport + console === rows` **exactly**, for every input, with a returned
`degraded: 'none' | 'compact' | 'minsize'`. Priority: status/console floor → rule → console growth → overlay → header
(5 → 1 → 0) → viewport. One row of error costs a full-screen clear **per keystroke** (A1 §3.2, measured 37 clears for
36 frames), so this function's post-condition is the single most load-bearing assertion in the renderer.

| tier | rows | header | rule / position | viewport | console | invariant |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| **tall** | ≥ 24 | 5 (mark) | 1 | `rows − 11` | 5 | ✓ |
| **compact** | 18–23 | **1** (brand strip) | 1 | `rows − 7` | 5 | ✓ |
| **narrow** (< 64 cols, any rows ≥ 18) | ≥ 18 | 1 (brand strip) | 1 | `rows − 7` | 5 | ✓ |
| below | — | — | — | — | — | refuse → classic (§1.3.1) |

*(An earlier draft had `hero ≥ 30` and `tall 24–29` as two rows with byte-identical columns; they are one tier.)*

**The `compact` / `narrow` header row is §1.2 P-H1's strip, verbatim** — `panelStrip` with `brand: true`, the same
builder, the same drop order, right-aligned position segment appended. There is no second string to specify.

**The position segment has its own rung ladder**, fed through `panelStrip`'s existing shrink loop as its rightmost
segment, because at the stated fullscreen minimum of 40 columns the 24-cell `1 240/3 512 · 35 % · PgUp` would eat
the whole strip, and it is the only way to know where you are in a viewport with no native scrollbar:

```
[24]  1 240/3 512 · 35 % · PgUp
[13]  35 % · PgUp
 [4]  35 %
       (dropped — the strip's information wins)
```

It is dropped **after** `◆ jevcode` and **before** any pane information, so a 40-column fullscreen strip reads
`── ▸ jev s4 · 7 decisions ── 35 % ──`.

Two frames pin the tiers this table would otherwise leave undrawn:

**F-H4. `fullscreen` compact, 20×80 (20 rows: header 1 · rule 1 · viewport 13 · console 5).** The header is the
brand strip — the same `panelStrip` row P-H1 builds, with the position segment right-aligned — and the 5-row mark
is not drawn below 24 rows.

```
── ◆ jevcode ─ ▸ jev s4 · 7 decisions ───────────── 1 240/3 512 · 35 % · PgUp ──
     [ui] cost
          run        $0.001 of $2.00 · 0 %
          session    $0.001 of $10.00 · 0 % · 1 run
          per step   p50 $0.000 · last $0.000 · about 9 577 steps left

 [step 4] done scratch work complete · risk 0.01 ok · skipped · 0.0s ·
          $0.0002

    [run] finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 ·
          jev $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run        20260922-035503-kntk2yw3
          files      ~/.jevcode/runs/20260922-035503-kntk2yw3/
                     transcript.log · state.json · jevcode.log
╭─ jev+llm ──────────────────────────────────────────────────────────── ws-a3 ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                            step 4/40  sess $0.001/10.00 ok       ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-H5. `fullscreen` narrow, 24×44 (24 rows: header 1 · rule 1 · viewport 17 · console 5).** The brand is the first
segment the strip drops below 64 columns (P-H1 edge 1), so the rule row carries the pane information and the
4-cell position rung. The transcript is in §2.3's `gutter` rung (44 ≥ 34) with a 34-cell body, and the viewport is
a **slice**: the `[ui] cost` head and its `run` row have scrolled above the top.

```
── ▸ jev s4 · 7 decisions ────────── 35 % ──
          session    $0.001 of $10.00 · 0 %
                     · 1 run
          per step   p50 $0.000 · last
                     $0.000 · about 9 577
                     steps left

 [step 4] done scratch work complete · risk
          0.01 ok · skipped · 0.0s · $0.0002

    [run] finished · complete · 4 steps ·
          0.1s · $0.001 (generator $0.000 ·
          jev $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run 20260922-035503-kntk2yw3
          files ~/.jevcode/runs/20260922-0…
          transcript.log · state.json ·
          jevcode.log
          resume jevcode run --resume …
╭─ jev+llm ──────────────────────── ws-a3 ─╮
│ › Say hi, ask a question, or descri…     │
├──────────────────────────────────────────┤
│ idle          step 4/40     ? help       │
╰──────────────────────────────────────────╯
```

An overlay takes its rows from the **viewport**, in the same yield order as classic, and the header yields 5 → 1 before
the viewport drops below 3 rows. The composer grows inside the console exactly as today (cap 6, 8 at rows ≥ 40).

*Edge cases.* (1) non-finite / negative `rows`/`columns` → 0, `degraded: 'minsize'` (the `size()` normalisation of
`layout.ts:151`). (2) rows 1–2 → console only, header 0, viewport 0. (3) an overlay wanting more rows than the viewport
has → the **overlay** is capped, never the total. (4) composer at its 8-row cap + a 9-row review card + a 5-row header
at 24 rows → the header yields to 1. (5) the **rendered** height must equal the allocated height: every slot is a
fixed-height `overflow: hidden` Box and every row is `<Text wrap="truncate">` — a single wrapped row breaks the
invariant. (6) wide graphemes: a row whose cell width exceeds `columns` is truncated by **cells**
(`src/tui/composer/width.ts` `stringWidth`, `glyphs.ts` `truncateCells`), never by code units. (7) an item with an
embedded `\n` contributes one viewport row per line. (8) a zero-height viewport mid-resize renders nothing, never a
negative slice.

#### 1.3.3 `<Viewport>` — the scrolling transcript and the identity guarantee

`src/tui/fullscreen/viewport.ts` (pure) turns `TranscriptItem[]` into wrapped screen rows using the **same** builders
`<Transcript>` uses — `itemLines` → `bodyRows` → `wrapBody` (`Transcript.tsx:89–120`) — with: (a) **incremental
append**, only new items wrapped; (b) a **full rebuild on a width change**, keeping the old index until the new one is
ready; (c) `slice(top, n)`; (d) sticky-to-bottom anchoring. `src/tui/fullscreen/Viewport.tsx` is a fixed-height
`overflow: hidden` Box of `<Text wrap="truncate">` rows.

**The identity guarantee is the same test, run twice:** `normaliseRows(index.rowsFor(item)) === formatTranscriptItem(item)`
for every fixture in the existing transcript identity suite, run against the viewport builder **as well as**
`<Transcript>`. The rows are the same rows, sliced.

Scroll model. State `scroll: { anchor: 'bottom' } | { anchor: 'row'; top: number }` in `UiState`; default
sticky-to-bottom (opencode's `stickyStart: "bottom"`, `docs/research/tui/01-opencode.md:134`).

**Keys — every one of them free in the `composer` context, checked against `bindings.ts`:** `PgUp`/`PgDn` = one
viewport minus two rows (free: `bindings.ts:129–130, 141–142` bind them only in `picker` and `palette`);
`Shift+↑`/`Shift+↓` = one row (free); **`Ctrl+Home`/`Ctrl+End` = top / bottom-and-reattach**. **Plain `Home` and
`End` are NOT free** — `bindings.ts:92` binds `composer:lineStart` to `['ctrl+a', 'home']` and `:93`
`composer:lineEnd` to `['ctrl+e', 'end']`, and §1.3.5's "the key resolver **unchanged**" means a fullscreen user
must not lose go-to-line-start / go-to-line-end while typing. An earlier draft claimed Home/End were free; they are
not (§14.2 "Review log" item 32). Taking `Ctrl+Home`/`Ctrl+End` keeps the resolver, `docs/KEYS.md`, `completions/*`
and `man/jevcode.1` **untouched**, which is the whole point of §1.3.5's discipline.
Submitting, `Esc` on an empty draft and any `run:start` reattach to the bottom. **Mouse reporting stays off**: A1 §3.7
measured that Ink has no mouse parser and an SGR report reaches `useInput` as the literal text `[<64;10;5M`, so
enabling it would type into the composer on every wheel tick and break click-drag selection in every emulator. The
position indicator folds into the existing rule row, right-aligned, costing **zero** extra rows:
`── ◆ jevcode ─ ▸ jev s7 · 12 decisions ───────── 1 240/3 512 · 35 % ──`, reusing `panelStrip`'s right segment
(`src/tui/pane/model.ts`).

*Edge cases.* (1) 20 000 items = 40 000 wrapped rows, +15.7 MB, a 16.3 ms rebuild at 80 columns (A1 §3.5): cap the
index at the existing `STATIC_SOFT_CAP = 20_000` (`useEngine.tsx:53`) and show `▲ n earlier rows · see transcript.log`
as row 0 past it. (2) `--resume` seeds thousands of items before frame 0 → index **lazily**: frame 0 wraps only the last
`viewport` rows, the rest on an idle callback, so first frame < 300 ms holds. (3) a single 10 000-character line wraps
to ~125 rows, taller than the viewport — the index is rows, not items, so scrolling *within* one item falls out. (4) a
width change during a run: append into the new index only after the rebuild completes; never interleave two widths.
(5) zero items: the viewport is blank and the total is still exactly `rows`. (6) hidden items (`visibleItems`,
`useEngine.tsx:75–92`) are excluded, and a hidden-only batch must not invalidate the index (the same stable-reference
trick `useVisibleItems` already uses). (7) `--ascii` / `/theme`: glyphs and colours are applied at **render**, not in
the index, so a theme change never rebuilds it. (8) an append while the user is detached must not move the view; the
position indicator updates. (9) PgUp past the top clamps; PgDn past the bottom reattaches. (10) a pending review
collapses the composer and takes viewport rows — the anchor is a **row index**, not a percentage, so it survives.
(11) terminal selection works for visible rows only; §1.3.5 is the escape hatch.

#### 1.3.4 What the alternate screen takes away, and how it is paid back

`/scrollback` — `suspendTerminal()` (which already leaves the alt screen, `ink.js:894–900`), print the whole transcript
to the **primary** screen through `createPlainRenderer` (`src/tui/plain.ts:902`), wait for a key, resume. Native copy
and find are available for as long as the user wants. Under `classic` the command answers
`[ui] /scrollback is a fullscreen command; your terminal's scrollback already has the transcript`.

On exit — after `1049l`, write the whole transcript to the primary screen (`ui.fullscreenDump`, default on; skipped
when the transcript is empty or the session ended with `--json`). The dump is produced by the **same**
`createPlainRenderer`, so it is byte-identical to a `--plain` run of the same script: the session ends with the same
scrollback classic would have left. *Edge cases:* a very long transcript is written in 64 KB chunks so a slow link
cannot push the exit past `UNMOUNT_TIMEOUT_MS`; a crash before `unmount()` leaves no dump and `RESTORE`'s `1049l` still
runs (`transcript.log` is the documented source of truth); Ctrl-C during the dump stops writing and exits 130;
`/scrollback` while a run is live is allowed — items queue through the existing `createSuspensionQueue`
(`src/tui/terminal.ts:174–203`) and the review box must not arm while suspended (reuse the existing suspension gate).

#### 1.3.5 What does *not* change

`<FullApp>` reuses `Console`, `Overlay`, `Review`, `Composer`, `StatusLine`, `Transcript`'s builders and the key
resolver **unchanged**; only `<Static>` → `<Viewport>` and the allocator differ. If `ui.renderer` is `classic` the tree
is byte-for-byte today's. This discipline is the whole risk mitigation for the second renderer (§9 records it as slot
S1's standing rule, and §10 makes it a test: the two renderers' item rows must be equal for the same item list).

### 1.4 `scrollback-guard.ts` — stop deleting the user's terminal history (ships regardless of D-S)

PROBED on the shipped build (A1 §3.3, `product-shrink-panelfull-40x100-to-10x60.cap`): every shrink resize that
overflows the previous frame writes `ESC[2J ESC[3J ESC[H`, and **`ESC[3J` erases the terminal's saved-lines buffer** —
everything the user had scrolled through, including the shell history from before `jevcode` started. The zero-clear
gate accepts one clear per shrink (TD §1891) and has never distinguished the two bytes.

Ink offers no hook (`resized()` does not reset `lastOutputHeight`, `ink.js:279–291`; the public `clear()` does not
either, `:655–662`), so the fix is a one-method write filter on the stream handed to `render()`: new
`src/tui/scrollback-guard.ts` exporting `guardStdout(stream): NodeJS.WriteStream` — a `Proxy` whose **only** trap is
`write`, rewriting the exact **11-character** sequence `\x1b[2J\x1b[3J\x1b[H` to `\x1b[2J\x1b[H` and passing
everything else through untouched. (Measured: `ansi-escapes`' `clearTerminal` is
`` `${eraseScreen}${ESC}3J${ESC}H` `` — `node_modules/ansi-escapes/base.js:124–130` — i.e. `\u001b[2J\u001b[3J\u001b[H`,
`.length === 11`. An earlier draft said 9 bytes, which breaks any length check or fixed-offset slice.) Wired at `App.tsx:2382–2444` (`createTuiRenderer`: `const out = guardStdout(stdout)`, used for `render({
stdout: out })`, the `'resize'` listener, the title and cursor-shape writes).

*Edge cases.* (1) the chunk may be a `Buffer` (Ink always writes strings; `patchConsole` and third-party writes may
not) — only inspect when `typeof chunk === 'string'`. (2) match at the head **and** with `indexOf`, replacing the exact
sequence **at most once** per chunk. (3) both `write(chunk, encoding, cb)` and `write(chunk, cb)` overloads forward and
return the original boolean. (4) back-pressure: return the underlying return value unchanged, never buffer. (5)
`isTTY`, `rows`, `columns`, `on/off/once`, `destroyed`, `writableEnded`, `_writableState` all forward — Ink reads every
one (`ink.js:113–122`). (6) Ink keys its instance map by the stream object (`render.js:45–58`), so the **same** proxy
object goes everywhere and is never mixed with the raw `process.stdout`. (7) `waitUntilRenderFlush()` queues an empty
write as a barrier — forward zero-length writes. (8) `src/cli/fatal.ts`'s `RESTORE` (`:24`) and
`installTerminalHygiene` write to the raw stream at exit and never write `3J`; they keep using `process.stdout`.
(9) `--plain` / piped output never constructs the renderer. (10) non-TTY / CI: Ink never takes the clear branch; the
proxy is inert. (11) Windows console (`ink.js:87–99` forces a clear on every fullscreen frame) makes the filter *more*
important — **but on old Windows `clearTerminal` is `` `${eraseScreen}${ESC}0f` `` with **no `3J` at all**
(`base.js:124`), so the proxy is a legitimate no-op there. The terminal-matrix assertion is therefore "**no `3J`
appears in the capture**", never "the filter fired". (12) **declared trade-off, with its real bound.** Ink writes
`ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender` in **one** write (`ink.js:768`), and
`fullStaticOutput` is append-only for the whole session (`:354, :416` `this.fullStaticOutput += staticOutput;`). So
the duplication is **per clearing frame and unbounded**: **N clearing frames leave N+1 full copies**, and
`fullStaticOutput` grows with the session (measured 4 616 B after a 40-step mocked run, but a long session is
megabytes). The clearing frame fires on every width shrink (`ink.js:279–286` `resized()` → `log.clear()`) *and* on
every frame taller than the terminal — i.e. **continuously while a user drags a window edge**. For the "power user
in tmux at 60×200 resizing constantly" persona, `3J` alone would turn "your history is deleted" into "your history
is buried under twenty copies of the transcript", which is not obviously better.
**Mitigation, which ships with the filter** (A1's own alternative, answering its open question 2): when
`guardStdout` rewrites a clear, it also **elides the `fullStaticOutput` prefix that immediately follows it in the
same chunk** — the chunk becomes `\x1b[2J\x1b[H` + `outputToRender` only. The result is a clean screen with the
real history **still above it in the terminal's saved lines**, which is the behaviour a user expects from a
resize, and the copy count stays at exactly 1 forever. The proxy recognises the prefix positionally (it is the
bytes between the rewritten clear and the frame Ink is about to draw), never by content, and a chunk that does not
have the `clear + static + frame` shape is passed through untouched.
**Gate.** The resize matrix asserts, per shrink `resize` step, **bytes written ≤ 2 × the settled frame's bytes**,
and that the whole capture contains **exactly one** `[run] started` occurrence per run — a byte-level bound the
old wording had no gate for at all. Both are stated in `docs/TUI.md`'s terminal-hygiene section and beside the
gate.

### 1.5 The height guard — make the cliff impossible to reintroduce

A permanent pty assertion plus a dev-only in-product assertion that no frame is taller than the terminal.
`src/perf/pty.ts` already measures `paintedRows`; it gains a hard assertion helper that fails on `paintedRows > rows`
for **every** capture in the pty suite (today the `≤ rows − 2` assertion lives only in the perf probes), and
`test/pty/run-smoke.sh` runs it on every `.steps` capture. `JEVCODE_ASSERT_HEIGHT=1` (a `parseFault` field, §7.11)
throws in development when a rendered frame's line count exceeds `rows`; when unset an early `return` compiles it out
of the default path.

*Edge cases.* (1) a shrink segment legitimately paints one taller frame before the rerender — assert **per geometry
segment**, skipping the first frame after a `resize` step (the existing segment machinery, TD §1891). (2) `<Static>`
rows are not part of the frame height — count only the dynamic block. (3) screen-reader mode has no log-update frame
structure — skip. (4) fullscreen: the assertion is `=== rows`, not `≤ rows − 2`.

### 1.6 Frames

**F-H1. Classic, after the first run, idle, 24×80 (11 dynamic rows; 6 scrollback rows above).** The brand is back on
the rule row and the mark is under it (D-T a + F-W5). `◆ jevcode` accent; the mark's `JEV` accent, `CODE` dim.

```
 [step 4] done scratch work complete · risk 0.01 ok · skipped · 0.0s · $0.0002

    [run] finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 ·
          jev $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run        20260922-035503-kntk2yw3
── ◆ jevcode ─ ▸ jev s4 · 7 decisions · risk 0.01 ok ──── [d] [p] [t] [s] ──────
                    ██  ██████ ██   ██     ▓▒░
                    ██  ██     ██   ██     ▓▒░
                ██  ██  ████   ██   ██     ▓▒░
                ██████  ██      ██ ██      ▓▒░
                 ████   ██████   ███       ▓▒░  ◆ 0.3.0
╭─ jev+llm ──────────────────────────────────────────────────────────── ws-a3 ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                            step 4/40  sess $0.001/10.00 ok       ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-H2. Classic, live run at 34 rows (14 dynamic rows drawn — rule 1 · live 2 · banner 1 · mark 5 · console 5; the 16 of P-H2's arithmetic is the worst case, which additionally grants queue 2).** The mark stays up (D-T b); the sweep is frozen.

```
── ◆ jevcode ─ ▸ jev s7 · 12 decisions · risk 0.20 ok ─── [d] [p] [t] [s] ──────
  $ python -m pytest tests/test_replan.py -q
  ..F                                                                     ▍
  loop · replan 1 of 5 · s7 gather_context (p 0.62 · impossible 0.20)
                    ██  ██████ ██   ██     ▓▒░
                    ██  ██     ██   ██     ▓▒░
                ██  ██  ████   ██   ██     ▓▒░
                ██████  ██      ██ ██      ▓▒░
                 ████   ██████   ███       ▓▒░  ◆ 0.3.0
╭─ jev+llm ──────────────────────────────────────────────────────────── ws-a3 ─╮
│ › Type to steer the next step…                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ judging                       step 7/40  run $0.012/2.00 ok         ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-H3. `fullscreen`, 24×80 (24 rows, exactly).** Header rows 1–5, rule 6 with the brand prefix **and** the position
segment (the mark and the strip brand coexist here exactly as in classic, P-H1), viewport 7–19 (13 rows, a **slice**
— the `per step` row of the `/cost` block has scrolled above the top), console 20–24. Nothing above row 1; `PgUp`
scrolls the viewport; `/scrollback` and the exit dump give the terminal's own scrollback back.

```
                    ██  ██████ ██   ██     ▓▒░
                    ██  ██     ██   ██     ▓▒░
                ██  ██  ████   ██   ██     ▓▒░
                ██████  ██      ██ ██      ▓▒░
                 ████   ██████   ███       ▓▒░  ◆ 0.3.0
── ◆ jevcode ─ ▸ jev s4 · 7 decisions ───────────── 1 240/3 512 · 35 % · PgUp ──
     [ui] cost
          run        $0.001 of $2.00 · 0 %
          session    $0.001 of $10.00 · 0 % · 1 run

 [step 4] done scratch work complete · risk 0.01 ok · skipped · 0.0s ·
          $0.0002

    [run] finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 ·
          jev $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run        20260922-035503-kntk2yw3
          files      ~/.jevcode/runs/20260922-035503-kntk2yw3/
                     transcript.log · state.json · jevcode.log
╭─ jev+llm ──────────────────────────────────────────────────────────── ws-a3 ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                            step 4/40  sess $0.001/10.00 ok       ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

---

## 2. Resize and terminal robustness (D-AB; request 3)

The good news first, so nobody re-does it: A2 ran **829 600** `computeLayout` combinations (rows 0–60 × 17 widths × 10
overlay kinds × 8 overlay wants × 5 composer wants × screen-reader on/off) against the **in-flight** tree with **zero**
invariant violations, and `consoleTopEdge`/`consoleRow`/`consoleDivider`/`consoleBottom` are exactly `columns` cells at
every width 0–200. Boot at 15 geometries (0×0 … 60×200) gives 0 clears and region ≤ rows − 2 everywhere. A 20-resize
storm in 48 ms, a resize during a frame write, Ctrl-Z/SIGCONT, SIGHUP (129), a 500-line/25 KB paste, `/help`, `/diff`,
`NO_COLOR`, `--ascii`, `LANG=C`, SSH fps 15, `--screen-reader`, `TERM=screen/tmux/vt100` are **all** 0 clears, 0
alt-screen, 0 RIS. The height allocator is not where the trouble is.

**The trouble is wherever terminal width meets text, plus the frame drawn between two geometries.**

### 2.0 The driver fact that reframes every resize test

`drive.exp`'s `resize R C` runs `stty rows R cols C` (`scripts/pty/drive.exp:154–158`), and macOS applies the operands
with **two ioctls**, so the child sees **two** SIGWINCHes: `(newRows, oldCols)` then `(newRows, newCols)`. Proven with a
Node probe (`resize-probe/jr4-winch.mjs`, capture `jr4-winch.cap`). Consequences: (a) every existing `test/pty` resize
step is really two transitions; (b) the App's rows-only fast path (`App.tsx:2424`) misses the second one; (c) a pty
"geometry segment" must be keyed on the **pair** (rule-row width, row count), not on width alone — `test/pty/helpers.ts`'s
`units()` keys on `ruleWidth` today and merges segments.

**Consequence (d), which is why the clear gate is worded the way it is in §2.1 and §11.** Once a segment is keyed on
the pair, one driver `resize 12 60` from 24×80 becomes **two** segments — `(80, 12)` then `(60, 12)` — so a bound of
"≤ 1 clear per segment" permits exactly the 2 clears A2 measured and **cannot detect the defect it exists to close**.
Ink re-renders on every SIGWINCH independently of P-R1's 8 ms `SYNC_COMMIT_MIN_MS` guard
(`node_modules/ink/build/ink.js:278–291`: `resized()` calls `this.log.clear()` on a width decrease and then
`this.onRender()`), and §2.1 row 17 already concedes that multiple geometries reach the wire. **The gate is
therefore a per-USER-RESIZE budget: ≤ 1 clear across the whole two-SIGWINCH transition of one driver `resize`
step.** The segment stays keyed on the pair for every *width* predicate (V22, V23, the rule-row width); the clear
assertion is keyed on the **driver step**. Explicit, falsifiable baseline for the ladder's first rung
(24×80 → `resize 12 60`): **today 2 clears, after §2.2 exactly 1**, and a `resize 40 120` grow step is **0** both
before and after.

**Decision (against A2 P12's recommendation, §14.1 row 5): do not reorder the driver's two ioctls.** A2 suggested
`cols` then `rows` so the *last* event is the rows change the fast path handles; once §2.2 commits on **both** axes the
reorder buys nothing and would re-baseline six scenarios' clear counts (`resize.steps`, `resize-grow.steps`,
`resize-live.steps`, `r3-wizard-resize.steps`, `chrome-tiers.steps`, `states.ts` `resizeMarkers`). Instead: add
`resize-rows R` and `resize-cols C` steps for deliberately testing one axis, document the two-event behaviour as
`docs/research/tui/20-pty-driver-findings.md` §6, and re-key the segment helper on the pair.

### 2.1 The matrix, as the round-4 test plan

`test/pty/resize.pty.test.ts` (new) drives **one step file per state** through the ladder
`24×80 → 12×60 → 8×40 → 5×30 → 40×120 → 24×80`, plus a 20-event storm, asserting **≤ 1 clear per driver `resize`
step that shrinks** (down from the 2 A2 measured — the budget is per user resize, not per geometry segment: §2.0
consequence (d)), **0 per grow step**, and per geometry segment `region ≤ rows − 2`, **V22**, **V23**, 0 forbidden
sequences (`ESC[?1049h/l` outside `fullscreen`, `ESC c`, `ESC[3J`), exit 0.

| # | state | today (PROBED, `ec61170`) | after |
| ---: | --- | --- | --- |
| 1 | splash (resize at 200/350/500 ms) | OK, 0 clears | unchanged |
| 2 | idle hero, empty draft | OK, 0 clears | unchanged |
| 3 | idle hero, 1-column change | cosmetic | clean (§2.2) |
| 4 | idle, 120-char draft | **2 torn frames on shrink, 1 on grow** (D1) | **0** |
| 5 | chatting, intake card up | **8 box rows end in `…`** at 120→40 | 0 |
| 6 | thinking / live + 1-row panel | D1 + 1 clear per shrink | 1 clear, 0 torn |
| 7 | live, `/panel full`, 20 pane rows | D1 | as 6 |
| 8 | live, resize **inside** a frame write | OK, 0 clears | unchanged |
| 9 | review card (16 dyn rows) | **2 clears per shrink** (D9), keys row cut at 40 (D5) | 1 clear, every key visible (§2.6) |
| 10 | palette open | 2 clears per shrink | 1 |
| 11 | picker open (18 dyn rows) | 2 clears per shrink | 1 |
| 12 | wizard (provider step) | **a dead composer at minsize** (D4) | the wizard owns the row (§2.5) |
| 13 | `/help` block in scrollback | OK | unchanged |
| 14 | `/diff --full` (PAGER=cat) then back | OK | unchanged; a **real** pager stays `manual` (§2.10) |
| 15 | 500-line / 25 KB paste, then resize | OK (one chip, no body in any frame) | unchanged |
| 16 | Ctrl-Z → SIGCONT → resize | OK (draft survives, raw mode back, exit 0) | unchanged |
| 17 | storm: 20 resizes in 48 ms | OK, 0 clears, 3 segments reach the wire | unchanged + the §2.2 storm guard measured |
| 18 | **2×8 and 1×20** | **20 permanent scrollback rows for one item; two 0-row frames** | ≤ 24 rows + a tail; one informative row (§2.3, §2.5) |
| 19 | 24×80 → 20×12 → 24×80 with the wordmark up | **unprobed** (the mark is not in `ec61170`) | **must be probed once round 3 lands**: ≥ 5 `██` rows in the settled frame after every return to ≥ 21×64 |

Row 19 is the one open cell of this matrix and is called out again in §11 as a gate that cannot be signed off from the
audits alone.

### 2.2 One geometry per frame (closes D1 and D9)

Two changes that must land together; either alone leaves a skew.

**P-R1 — commit synchronously on any shrinking dimension and on every width change.** `App.tsx:2419–2427`:

```
-  let lastRows = geometryOf().rows;
+  let last = geometryOf();
+  let lastSyncAt = 0;
   const onEarlyResize = (): void => {
     const g = geometryOf();
     bridge.geometry = g;
     bridge.notify();
-    const shrank = g.rows < lastRows;
-    lastRows = g.rows;
-    if (shrank && instance !== null) instance.rerender(tree());
+    const shrank = g.rows < last.rows || g.columns < last.columns;
+    const widthChanged = g.columns !== last.columns;
+    last = g;
+    const now = nowMs();
+    if ((shrank || widthChanged) && instance !== null && now - lastSyncAt >= SYNC_COMMIT_MIN_MS) {
+      lastSyncAt = now;
+      instance.rerender(tree());
+    }
   };
```

`SYNC_COMMIT_MIN_MS = 8` is the storm guard: `instance.rerender` is a synchronous `updateContainerSync` +
`flushSyncWork`, and §2.0 means 20 driver resizes are ~40 events; the debounce catches the tail either way.
**`nowMs()` in that patch is `performance.now()`, defined once here and used by both timing sites in this
document** — P-R1's storm guard and §7.8's 45 s submission watchdog. It is **not** `App.tsx:561`'s
`const now = p.now ?? Date.now`, which §7.8 edge 4 already forbids for a deadline because an NTP jump would fire it
early or late; the same hazard applies to an 8 ms guard, which an NTP jump could disable for the length of the
jump.

**P-R2 — delete `wrapColumns`; the draft wraps at the same `columns` the edges use.** Today `wrapColumns` is a
50 ms-debounced state (`App.tsx:647,723–728`) while the box edges follow `columns` immediately, so for up to 50 ms
(≈ 130 ms at `--fps 15`) the box is one width and the body another. Measured (A2 `out/tear`, 24 rows, 80→60→100→44→80):
**4 of 24 frames** carry a box row whose right border is the truncation ellipsis, and one grow frame draws a stray `│`
mid-row with dead space after it. Change: `wrapColumns` and its effect are deleted; `App.tsx:1703` `composer.apply({
columns })`, `:2228` `bodyColumns={columns}` (or the prop is dropped, `Console.tsx:65,124`), `:2268`
`<Composer columns={columns}>`; `RESIZE_DEBOUNCE_MS` (`src/tui/terminal.ts:19–20`) retires with its one consumer. The
work the debounce was protecting — re-running `draftRows` — already runs on **every** render at `wrapInner`
(`App.tsx:2015`), so nothing new is paid per keystroke; it is now paid on the commits P-R1 already performs.

*Edge cases.* (1) a 6-row draft at 200 columns shrunk to 40: `draftRows` must be re-run **before** `computeLayout` in
the same render or the layout grants fewer rows than the Console draws — keeping **one** value is exactly what
guarantees it. (2) the cursor formula `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }`
(`Console.tsx:10–12`) is recomputed in the same render. (3) a draft that is a paste chip is width-independent. (4) the
wizard hosting the console rows (`Console.tsx:111–114` `wizardBodyRows`). (5) the picker's `filter: ` prompt has a
different prompt width (`App.tsx:2015`). (6) `--screen-reader` flat tier has no box and still must not skew. (7)
0-column / non-finite `columns` — `Console.tsx:124` already clamps to 4. (8) during a `suspendTerminal()` window
(Ctrl-Z, `$EDITOR`) a resize must **not** write: assert `instance.rerender` produces no bytes while Ink is suspended,
else guard with the suspension flag the `<Static>` queue already keeps (`terminal.ts:174–203`). (9) `instance === null`
before `render()` returns — already handled. (10) `stdout` is not `process.stdout` (unit mounts) — the listener is only
attached when `typeof stdout.on === 'function'`, unchanged. (11) 0×0 — `geometryOf` falls back to 80×24 so neither flag
fires.

### 2.3 The narrow ladder and the per-item row cap (D-AB)

`Transcript.tsx:112–114` floors `bodyWidth` at 1, so a narrow terminal turns one item into a wall. Measured on the
**working tree**: at 10 columns a 296-char step item commits **258 rows**; the audit measured 183 permanent scrollback
rows for one `[sandbox]` item at 2×10. The rung lives in **new `src/tui/gutter.ts`** — a zero-import module, so
`src/tui/block/lines.ts` (no Ink) and the first-frame path can both reach it — and `Transcript.tsx` re-exports
every name, so no existing importer changes:

```ts
// src/tui/gutter.ts (new, pure, ZERO imports; import-gate test as for src/provider/ids.ts)
export const LABEL_GUTTER = 10;          // TD3 rule 1 (moved here from Transcript.tsx, re-exported there)
export const STACKED_MIN_COLUMNS = 34;   // below it the gutter is dropped
export const FLUSH_MIN_COLUMNS   = 24;   // below it the indent is dropped too
export const STATIC_ITEM_MAX_ROWS = 24;  // per ENGINE-PRODUCED item, at every rung — see the exemption below
export type GutterMode = 'gutter' | 'stacked' | 'flush';
export function gutterMode(columns: number): GutterMode;
```

| rung | condition | shape | body width |
| --- | --- | --- | ---: |
| `gutter` | `columns ≥ 34` | today's: label right-aligned in cells 0–8, body from column 10 (TD3 rule 1) | `columns − max(9, label) − 1` |
| `stacked` | `24 ≤ columns < 34` | the label on its own row, the body indented 2 | `columns − 2` |
| `flush` | `columns < 24` | no gutter, no indent | `columns` |

**The cap is a property of the item's SOURCE, not of `<Static>`.** At every rung, when
`bodyRows(...).length > STATIC_ITEM_MAX_ROWS` an **engine-produced** item (the 296-char step item, the `[sandbox]`
item A7 measured) commits the first 23 rows plus `… +N rows (transcript.log)` (dim). An item carrying `detailRows`
**from a command block is exempt** — it already carries its own §3.1.5 cap (`/config` 24 · `/help` 60 · `/plan` 40 ·
`/diff` 42 · `/diff --all` `Infinity`) and its own footer naming where the rest is. Applying the 24-row cap to a
block would destroy every documented escape hatch: a user who follows `… +34 settings at their defaults
(/config --all)` would land on a truncated table, and `/diff --all` — whose cap §6.5 item 3 deliberately raises to
`Infinity` to close A6-5 — would become **worse** than the 60-row re-cap A6-5 reported. Measured effect on the
296-char step item: 258 → 24 rows at 10 columns, 63 → 24 at 16, unchanged at ≥ 34.

| item source | cap | footer |
| --- | --- | --- |
| engine item (`itemsFromEvent`, `stepSummaryText`, `[sandbox]`) | `STATIC_ITEM_MAX_ROWS = 24` at every rung | `… +N rows (transcript.log)` |
| a command block (`detailRows` set, §3.1.3) | the block's own §3.1.5 cap; `Infinity` for `/diff --all` | the block's own `… +N more · <command>` |
| a proposal preview (`detailKind: 'diff'`) | `clipDetail`, unchanged | `…[N lines omitted]`, unchanged |

The unit case that pins it: `/diff --all` at **10 columns** keeps its full row count.

*Edge cases.* (1) `columns` 1–3: body width ≥ 1, never 0 (Ink loops on 0). (2) a label wider than the gutter
(`[step 1000]`): `max(9, label)` already handles it and `stacked` makes it moot. (3) a `detail` body
(`DETAIL_TABLE_RE`, `Transcript.tsx:51`) uses the **same** mode. (4) `--ascii` labels are the same width. (5) under a
screen reader `stacked` is strictly better, so apply the ladder unconditionally below the threshold. (6) the
`<Static>` box `width={columns}` (`Transcript.tsx:197`) follows the mode. (7) **a resize does not re-wrap items already
committed to `<Static>`** — the terminal hard-wraps them; only new items use the new mode. This is inherent to
scrollback and is documented in `docs/TUI.md`, and it is exactly why the floor exists. (8) `columns === undefined`
(unit tests without geometry) — unchanged, one `<Text>`. (9) `transcript.log` and `--plain` are **unwrapped** and are
not affected at any rung (the identity test gains a column-sweep case proving it).

**Identity.** Layout only in `gutter`. In `stacked` the §5.3 normaliser gains **one declared clause**: *the label row
and the following body rows join with one space* — the same join, one more row to strip. In `flush` the label is the
first token of row 0, so the plain join already returns `formatTranscriptItem(item)`. The cap row is the one case where
the rendered rows do **not** reconstruct the item; it is declared as a **truncation marker** (the same class as
`clipDetail`'s `…[N lines omitted]`) and the identity test skips items whose rendered rows end with it.

### 2.4 The identity normaliser becomes exact under a hard grapheme cut

Measured on the **working tree** (this document's probe), body `edited packages/app/src/components/SomeVeryLongName.test.tsx in one step`:

| width | rows | `joinWrapped(rows) === body` |
| ---: | ---: | --- |
| 30 | 4 | **false** — `…/components/So` + `meVeryLongName.test.tsx …` joins with a space |
| 40 | 3 | **false** |
| 70 | 2 | true |

At the **supported minimum of 40 columns** the body width is 30, so any path, sha or run id of 31+ cells already breaks
the standing identity rule today. `wrapBody` is right to hard-split (`transcript/wrap.ts:29–59` `hardSplit`); the
normaliser is wrong to assume it never happens.

**P-R3.** `src/tui/transcript/wrap.ts` gains a sibling that reports the cuts, and `joinWrapped` honours them:

```ts
export interface WrappedBody { rows: string[]; /** indices i where rows[i] continues rows[i−1] mid-token */ cuts: readonly number[] }
export function wrapBodyCut(text: string, width: number, g?: GlyphSet): WrappedBody;
export function joinWrapped(rows: readonly string[], cuts: readonly number[] = []): string;  // '' at a cut, ' ' otherwise
```

`wrapBody` stays the thin wrapper `wrapBodyCut(...).rows`, so **no caller changes**. `hardSplit` returns its piece
count, `packWords` threads the cut indices, and `normaliseRows` (`Transcript.tsx:142`) gains the parameter it needs
to forward them — today its signature is `normaliseRows(rows: readonly string[]): string`, which receives nothing to
forward:

```ts
export function normaliseRows(rows: readonly string[], cuts: readonly number[] = []): string;  // default [] = today
```

**The two legs of the identity gate get different treatment, because only one of them is in-process.**

| leg | how it gets the cuts |
| --- | --- |
| the **unit** legs (`round2-transcript.test.tsx:23`, `app.test.tsx:299`, `round4-identity.test.ts`) | `wrapBodyCut` is called in the same process; pass `cuts` to `normaliseRows` |
| the **pty** leg (`twins.pty.test.ts:96–120`, which builds `const rows = staticRows(narrow.text)` from a terminal capture and has no `WrappedBody` in scope) | **do not join at all.** Re-run `wrapBodyCut(formatTranscriptItem(item), bodyWidth(cols, label))` on the *expected* text and compare **row for row** against the captured rows. This needs no cut list, is a strictly stronger assertion (it pins the wrap points too), and removes the ad-hoc re-join at `:98–130` |

So the §11 wording is precise: **the in-process legs become unconditional; the pty leg becomes row-exact.** It is
the in-process leg that "fails today at 40 columns for any 31-cell token".

*Edge cases.* (1) a cut inside a wide (CJK) cluster — cut indices are **row** indices, so width does not matter.
(2) `rows[0]` can never be a cut. (3) the segment-aware path (`wrap.ts:175–200`) where a continuation begins with
`· ` is **not** a cut. (4) `joinOrphan` (`:137`) moves whole tokens only and must not turn a cut into a non-cut —
assert it. (5) an empty body. (6) `width ≤ 0` → one row, no cuts. (7) the `stacked`/`flush` rungs of §2.3 compose with
cuts (the label row is never a cut).

This **strengthens** the line-identity gate from "whenever no token is wider than the row" to unconditional; TD3 §5.3's
paragraph gains the cut clause and its two test helpers (`app.test.tsx:299`, `round2-transcript.test.tsx:23`) move to
`joinWrapped(rows, cuts)`.

### 2.5 The minimum-size notice, and the wizard that must survive it

**P-R4 — a width ladder for `minsizeNotice`, and the short dimension named.** `src/tui/Overlay.tsx:49–53` builds a
sentence that is **72 cells** at 30×5 and is only ever shown when the terminal is *smaller than 40×8*, so it is
**always** truncated (PROBED: `terminal 30×5 is below the 40…` at 5×30; `terminal 30×40 is below the 4…`
mid-resize, which reads as if 40 rows were too few).

**The rung is chosen by measuring the FORMATTED candidate — `fitRung` (§2.6) over the substituted strings — not by a
constant threshold.** The builder interpolates `${columns}${times}${rows}` (`Overlay.tsx:49–53`), so the top rung is
72 cells at `30×5`, **73** at `100×5` and **75** at `100×120`: any fixed number is wrong for a three-digit
dimension. The widths below are illustrative measurements of the `30×5` rendering, not thresholds:

| text (illustrative width at `30×5`) |
| --- |
| `terminal 30×5 is below the 40×8 minimum — panes hidden, transcript above` *(72)* |
| `30×5 < 40×8 minimum — panes hidden` *(34)* |
| `too short: need 8 rows` / `too narrow: need 40 cols` / `too small: need 40×8` *(22 / 24 / 22)* |
| `need 8 rows` / `need 40 cols` / `need 40×8` *(11 / 13 / 11)* |
| `40×8 min` *(8)* |

**P-R5 — the minsize allocation order becomes notice → composer → status.** `layout.ts:167–173` allocates
status → notice → composer, so at budget 1 (rows 3–4) the user gets a spinner-less status row and no explanation.
Amends TD §2.1 A100's sentence.

**P-R6 — the wizard survives minsize (D4, the worst corner case in the corpus).** `computeLayout`'s minsize branch does
not special-case `overlay === 'wizard'`, unlike the normal path which refunds the composer floor
(`layout.ts:178–182`), and `Overlay.tsx:282–284` returns the notice for every kind. PROBED, first run with no key at
40×5: the user is invited to type a task into a composer whose Enter cannot start anything, during onboarding, with the
status row still claiming `setup`. Fix: at minsize with `overlay === 'wizard'` allocate **notice(1) · wizard(1)** and
**no composer**; `Overlay.tsx` renders a one-row wizard twin from a new `wizardMinsizeRow(state, columns)` in
`src/tui/onboarding/lines.ts`; `App.tsx:2268` passes `EMPTY_BUFFER` for `wizard` as it already does for collapsing
overlays.

**The one answer to "can the user still type?", stated once because a first-run user must not have to guess.**
**No — at minsize the wizard is read-only.** Every step's row is informational; keys are consumed and produce one
toast, `resize to at least 40×8 to continue setup`. The two reasons: an invisible masked field during API-key
entry is its own hazard (edge 2 exists precisely to forbid drawing it), and a numbered choice the user cannot see
the options for is not a choice. §12's string is the normative one —
`setup · key — terminal too small; ≥ 40×8 to type` — and edge 2's "the minsize row shows the `•` count only"
applies to the **key** step's row when the user has *already* typed at a larger size and then shrunk: the count is
a progress indicator for text that exists, never an invitation to add to it. Esc still cancels, Ctrl-C still exits
2 with the epilogue (edge 5), and growing the terminal back to ≥ 40×8 restores the full wizard with the draft
intact.

*Edge cases.* (1) one row per wizard step (`options`, `key`, `verify`, `trust`, `mode`, `done`) from one table —
`1 typesafe  2 openrouter` is 24 cells and fits. (2) the masked field must **never** be drawn at 1 row in a way that
could echo a key: the minsize row shows the `•` count of **already-entered** text only (never a caret, never a
character), or nothing — and because the row is read-only (above), no key can add to it there. (3) rows < 3 (static-only): the wizard cannot
be shown at all — emit **one** `<Static>` item `setup needs a terminal of at least 40×8` per size drop, never per
frame. (4) Esc → options → resize → Esc. (5) Ctrl-C at minsize still exits 2 with the epilogue (PROBED: it does).
(6) `--screen-reader` must not swallow the numbered prompt. (7) `--plain`'s wizard has no region and is unaffected.
(8) `assertNoKeyBytes` over the whole capture.

### 2.6 One rung ladder for every keys row (D5)

`src/tui/review/lines.ts:19,21,168` picks `REVIEW_KEYS_120` at `columns >= 120` and `REVIEW_KEYS_80` (76 cells)
otherwise, then hard-truncates. PROBED at 40 columns the reviewer sees
`│ [y] approve [n] decline [d] decline+not… │` — `[e] expand`, `[w]1-5 why` and **`[esc] decline`** are invisible on
the one row a reviewer must read, while the gauge block beside it already has a narrow rung.

**P-R7.** One helper `fitRung(rungs, cells)` = the widest rung whose `cellWidth ≤ cells`, used by the review keys row,
`exitConfirmRow` (`Overlay.tsx:36–38`, which already has a two-rung ladder), the intake row and the blocking card.
Rungs (verbatim in §12):

```
[113]  [y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run
 [76]  [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
 [55]  [y] ok [n] no [d] note [e] expand [w] why [esc] decline
 [42]  y ok · n no · d note · e exp · w why · esc
 [15]  y/n/d/e/w · esc
```

Selection takes the **card's inner width** (`columns − 4`), not `columns`; `truncateCells` stays only as a last resort.

*Edge cases.* (1) the flat tier has no card, so `columns` is the width. (2) `--ascii`: same letters, `·` → `-`.
(3) `--screen-reader` uses `SR_REVIEW_CHOICES` (`review/lines.ts:27`), untouched. (4) **a rebinding must change the
letters**: the rungs are literals today, which is a latent second defect — they become **templates** filled from the
effective bindings (TD3 §4.4 F10 `setBindings`) and measured *after* filling, so a rebound approve key prints the
right letter **and** the rung that is selected still fits. (5) `[ctrl-c] abort run` only while a run is live — its
slot is dropped from the template, not truncated, and the rung is re-measured. (6) widths 36–40, where the card's
inner width is 32–36, and widths 117–119, where the 113-cell rung newly fits and two captures re-baseline.

### 2.7 An OSC answer on stdin is typed into the composer (D6)

`src/tui/composer/filter.ts:40` `OSC_LEAK_RE = /^\]\d+;/` requires the chunk to **start with** `]`. Measured: Ink hands
the filter the body **without** the `]` for the first OSC of a read, so an OSC 11 answer appears in the draft
(`│ › 11;rgb:0000/0000/0000`), two answers concatenate, and with a non-empty draft Ctrl-D ×2 stops exiting — the
session appears wedged (driver exit 124). jevcode never *sends* a query (`kittyKeyboard: {mode:'disabled'}`,
`App.tsx:2437`), but an answer arrives anyway from a program that ran before it in the same pane (neovim queries OSC 11
at startup), from tmux passthrough, or from a terminal that volunteers OSC 4/11 on focus.

**P-R8.** Treat a chunk as an OSC answer when it matches
`/^\]?\d{1,4};(?:rgb:[0-9a-f/]+|[A-Za-z0-9+/=]{0,4096}|[\x20-\x7e]{0,256})(?:\x07|\x1b\\)?$/i` **and** it did not arrive
as bracketed-paste content **and** it contains no newline; additionally split the raw chunk on `]` and require **every**
piece to be a leak body (extend the existing `isLeakBody` fold, `filter.ts:86,108`). Keep the `osc` drop reason so the
`key filtered` trace still names it. The module doc-comment at `:1–17` currently asserts "OSC fragments all arrive as
text with the leading ESC stripped" — the measurement says the `]` is stripped too; correct it.

*Edge cases.* (1) a human typing `11;rgb:…` — mitigated by requiring **one** `useInput` text chunk of ≥ 6 chars with
no preceding keystroke in the same tick; a typed digit-semicolon string arrives one keystroke at a time, so the rule
cannot fire on typing (asserted with 20 "a human typed this" negatives). (2) OSC 52 base64 may be long — cap at 4096
and drop the remainder rather than insert it. (3) both the ST (`ESC \`) and BEL forms. (4) an OSC split across two
reads: the tail has no `;` prefix and is indistinguishable from typed text — a **documented limit**, the same as the
CSI tail at `filter.ts:14–16`. (5) two answers concatenated (the measured case). (6) an answer arriving while the
review box is up — the box already swallows printable keys; assert it still does. (7) an answer under
`--screen-reader`, where numbered prompts read digits — the filter runs before the prompt reader; add the case.
(8) dropping an OSC 52 answer is also the privacy-correct behaviour: it can carry clipboard content.

### 2.8 Four small fixes

| # | defect (PROBED) | fix | where |
| --- | --- | --- | --- |
| **P-R9** | `--ascii` draws the console divider and the bottom edge identically (`+---…---+` twice), so the status compartment reads as a second box | the ascii `teeLeft`/`teeRight` glyphs become `|`, so the divider is `\|---…---\|` and the bottom `+---…---+`; `consoleDivider` needs no change if the glyphs carry it | `src/tui/glyphs.ts`; assert `consoleDivider(w, ascii) !== consoleBottom(w, ascii)` for w ≥ 4 and both exactly `w` cells for w 0–200 |
| **P-R10** | `TERM=dumb` turns `jevcode chat` into `jevcode: missing task text` (exit 2) and the word `TERM` never appears | `selectRenderer` carries a `reason: 'dumb' \| 'ci' \| 'stdin-not-tty' \| 'stdout-not-tty' \| 'flag'` and the controller's usage error prints it with the three ways out (§12) | `src/cli/main.tsx:50–71`, `src/cli/session.ts:325–327`, the usage-error site |
| **P-R11** | EPIPE on stdout exits **129** with an empty stderr | one line to stderr before the exit; **keep 129** — `EXIT_CODE_TABLE` uses it for SIGHUP and changing it is a compatibility break for no gain (§14.1 row 9) | `src/cli/fatal.ts:29,218–221`; guard the write (stderr may also be closed) |
| **P-R12** | `docs/research/tui/terminal-matrix.md` §2 says "16 colours inside tmux by design"; the build emits 85 `38;5;` per capture under `TERM=screen-256color`/`tmux-256color` and 0 under `vt100` | replace the row with the measurement; note that `38;2;` is never emitted, so tmux without `Tc` is irrelevant | docs; the `theme-*` scenarios gain a `PTY_TERM` axis |

### 2.9 Two new frame predicates and one research probe

**P-R13 — V22 and V23**, implemented exactly as A2's `resize-probe/widths.mjs` and `borders.mjs`, added to
`scripts/pty/polish-check.mjs` beside V6 ("no row wider than the terminal"), which catches neither half of D1:

- **V22 — self-consistent frame width.** In every frame, every row starting with a box glyph (`╭ │ ├ ╰ + |`) is exactly
  the width of that frame's rule row, and **no** such row ends in the truncation ellipsis. *Exempt:* frames with no
  rule row (minsize, static-only), `--screen-reader` (no box). A card inside the region uses the same rule against the
  same rule row. Baseline to beat: `out/tear` 4/24 frames → **0**.
- **V23 — no over-indented continuation.** No scrollback continuation row starts with more spaces than the gutter of
  its rung (§2.3). Round 3's `wrapBody` already produces zero rows beginning with a space at every width I tried;
  nothing asserts it today (A2 D10).

**P-R14 — decide DECSTBM on evidence, if it is ever re-opened.** Two observations per terminal, five minutes total,
added to `docs/research/tui/terminal-matrix.md` as two columns and to `scripts/pty/decstbm-probe.sh`: (1) with
`printf '\e[6;24r'; seq 1 200`, are the scrolled-out lines in the terminal's scrollback? (2) after
`printf '\e[2J\e[3J\e[H'`, is the region still set? Terminals: Terminal.app, iTerm2, Ghostty, WezTerm, Alacritty,
kitty, tmux, GNU screen, VS Code integrated, Windows Terminal, ConPTY. This **cannot** be answered from a pty capture,
which is why A2 and A1 could not answer it.

### 2.10 What stays `manual` after round 4 (stated, not hidden)

Real emulators (iTerm2, Terminal.app, VS Code, Ghostty, kitty, WezTerm, Alacritty, Windows Terminal/ConPTY) — the new
manual item is D1's torn frame while dragging, which §2.2 should remove; an **interactive** pager (`less`) owning the
terminal across a resize, then `q` — the `<Static>` suspension queue (`terminal.ts:174–203`) is the code at risk;
emoji/ZWJ widths, which `drive.exp` mangles (§2.0 rule 3) — add a `sendbytes <hex>` step to the driver or measure with
a Node pty harness; one unreproduced run in which terminal noise launched `$EDITOR` (`out/noise/capture.bin:10497`,
vim's alt screen, a 21-byte draft file) — needs a `JEVCODE_TRACE` run with the same 8-write burst.

---

## 3. Command output style, and the history text D-M deferred (D-U, D-V, D-W; requests 2, 4, 5)

### 3.0 The one plumbing path today, and what is wrong with it

Every multi-row command output goes through **one** six-line helper, `src/cli/session.ts:1364` `block(head, lines)`:
in the TUI the body becomes one `detail` string rendered by `Transcript.tsx:214–218` as indented, unconditionally
**undecorated** rows; in `--plain` each body line becomes its own `[ui] …` item; while a run is live only the **head**
reaches `transcript.log`. There are **20** `block()` call sites in `session.ts` — `:1682, 2529, 2586, 2608, 2613, 2658, 2776, 2809, 2824,
2840, 2846, 2865, 2872, 2950, 2981, 3118, 3175, 3189, 3791, 3910` (the definition at `:1364` is not one) — and
4 App-local twins (`App.tsx` `/help`,
`/why`, `/decisions`, `/plan`).

Measured (PROBED, `ec61170`; re-verified in the working tree where a file:line is given):

| fact | evidence |
| --- | --- |
| **58 of 109** command-output rows exceed 80 cells | A3 §1.2, `plain1` capture |
| `/config` is **42 rows** with a **182-cell** widest row; at 24×40 it is ~120 terminal rows | `config-table.ts:106–109` pads `value` to the longest value, which is an absolute path — **unchanged in the working tree** |
| **7 of 12** body builders take no width at all: `configTableLines`, `costBlock`, `whyBlock`, `calibrationBlock`, `diffStepLines`, `epilogueRows`, the inline `/status` `/jev` `/budget` rows | A3 §1.3 |
| `/help` prints **different text** in the TUI (`palette.helpLines`) and in `--plain` (`session.helpLines`, up to **605 cells**) | A3 §2.7 (round 3 F9 deletes the second formatter; §3.3 finishes the job) |
| a blank separator row inside a block **vanishes** in the TUI (Ink measures empty `<Text>` at height 0) and prints as `[ui] ` **with a trailing space** in `--plain` | `config-table.ts:110` |
| the same `/cost` while live writes **1** row to `transcript.log` from the TUI and **7** from `--plain`, and the logged row does not name the command | A3 §2.8 |
| round 3's D-L moves detail rows to column 10 while `session.ts` still passes the full terminal width, so **every** pane-derived block overflows by exactly 10 cells | `session.ts:827,1292` `columns()`; `Transcript.tsx:48` |

### 3.1 The command output style

#### 3.1.1 The block frame

```
<blank row>                                   ← TD3 rule 9 (a [ui] item with a detail)
     [ui] <head>                              ← a noun, sentence case, ≤ 40 cells, never a data row
          <row 1>                             ← body rows start at the body column (10)
          <row 2>
          <footer>                            ← dim, only when something was elided
<blank row>                                   ← NEW in round 4: two blocks never touch
```

A block is **always transcript rows, never a card**: the one modal slot (TD §6) stays reserved for review, intake, the
picker, the palette and the wizard. `/rewind` and `/resume` keep their overlays; their *no-prompter fallback* stays a
block. The head may carry **one** right-hand meta field when it disambiguates: `cost · run 4 steps`, `diff · 3 files`,
`decisions · last 12 of 83`. Never the run id (rule §3.1.4).

#### 3.1.2 The width contract

The rung predicate and the gutter constant must be reachable from a **no-Ink** module, so they move out of
`Transcript.tsx` into a tiny importless one and `Transcript.tsx` re-exports them — the same shape (and the same
import-gate test) as `src/provider/ids.ts`, which round 3 landed for exactly this reason:

```ts
// src/tui/gutter.ts (new, pure, ZERO imports — an import-gate test keeps it that way for the first-frame path)
export const LABEL_GUTTER = 10;                            // TD3 rule 1
export const STACKED_MIN_COLUMNS = 34;
export const FLUSH_MIN_COLUMNS = 24;
export const STATIC_ITEM_MAX_ROWS = 24;
export type GutterMode = 'gutter' | 'stacked' | 'flush';
export function gutterMode(columns: number): GutterMode;
// Transcript.tsx re-exports all six so no existing importer changes (§2.3).
```

```ts
// src/tui/block/lines.ts (new, pure, no Ink)
import { LABEL_GUTTER, gutterMode } from '../gutter.js';
/**
 * The width every body builder is given. It is a function of the RUNG (§2.3), not of `columns` alone, because the
 * row the block is rendered into is exactly the rung's body width — `columns − max(9, label) − 1` in `gutter`
 * (Transcript.tsx:112–114, i.e. `columns − 10` for any label ≤ 9 cells such as `[ui]`), `columns − 2` in `stacked`
 * and `columns` in `flush`. There is NO lower clamp above 1: a floor above the available width IS the bug.
 */
export function blockWidth(columns: number): number {
  const c = Number.isFinite(columns) ? Math.floor(columns) : 0;
  const body = gutterMode(c) === 'gutter' ? c - LABEL_GUTTER : gutterMode(c) === 'stacked' ? c - 2 : c;
  return Math.max(1, Math.min(160, body));
}
```

**Why not `Math.max(28, …)`.** An earlier draft floored at 28. That floor **exceeds** the rendered body width for
every terminal narrower than 38 columns, so every block row would overflow the terminal at columns ∈ [34, 37]
(gutter rung: body 24–27 vs a promised 28), at columns ∈ [24, 29] (stacked rung: body 22–27) and at every
columns < 24 (flush rung: body = columns) — and §2.3 explicitly designs for 10 columns and 2×10, so those widths do
occur. The `commands-width` gate sampled 40/80/120 only and could not see it (§14.2 "Review log" item 7).

Every body builder takes `width = blockWidth(columns())` and **must** return rows of at most `width` cells. Four
tiers, all derived from `width` (so 40/60/80/120 columns give 30/50/70/110). **They are named `tight` / `narrow` /
`standard` / `wide`; only §2.3's terminal-width rung is called `stacked`**, and the two must never be confused:
`renderBlock` receives the **width**, `TranscriptRow` receives the **columns**.

| width | tier | tables | kv rows | facts rows |
| --- | --- | --- | --- | --- |
| < 34 | **tight** | the key row, then the value indented 2 | key on its own dim row, value indented 2 | one segment per row, `· ` leading |
| 34–59 | **narrow** | 2 columns (the last dropped), `… +N more` | `key(10) value`, value elided | segments packed, `· ` leading on continuations |
| 60–99 | **standard** | 3 columns | `key(10) value` | segments packed |
| ≥ 100 | **wide** | 3 columns + the one extra column each builder declares (latency, evidence, source) | `key(10) value` | segments packed |

The flat tier (< 16 rows) and `--plain` use the same function; `--plain` on a pipe is `80 − 10 = 70`
(`session.ts:827` already falls back to 80). The **upper** clamp at 160 matters because the identity pty run drives
640 columns (`twins.pty.test.ts:98`) where an unclamped block would emit 630-cell rows; the **lower** bound is 1
(never 0 — Ink loops on a 0-width box), and `columns` unknown / 0 resolves through `gutterMode(0) === 'flush'` to 1.
**This resolves A3 P7 vs A6 P5 (§14.1 row 2): one rung-derived function, both sets of call sites.**

#### 3.1.3 The five row kinds (plus `gap`)

```ts
export type BlockRow =
  | { kind: 'kv';    key: string; value: string; role?: ColorRole }
  | { kind: 'facts'; segments: string[]; role?: ColorRole }
  | { kind: 'table'; cells: string[]; header?: true; align?: ('l' | 'r')[] }
  | { kind: 'rule';  caption?: string }
  | { kind: 'note';  text: string }
  | { kind: 'gap' };
export function renderBlock(rows: readonly BlockRow[], width: number, g: GlyphSet): { text: string; role: ColorRole }[];
```

| kind | shape | example at width 70 | roles (≤ 3 per row) |
| --- | --- | --- | --- |
| **kv** | `key.padEnd(10)` + value (10 = `epilogue.ts:77–80`'s existing `padEnd(10)`) | `session    $0.04 of $10.00 · 12 % · 3 runs` | `dim` key, default value, one accent |
| **facts** | `a · b · c`, wrapped at ` · ` by TD3 rule 3 | `questions 83 · p50 0 ms · p95 2 ms · $0.001` | default, one accent |
| **table** | a dim header row, then aligned columns; numerics right-aligned | `bin        n  mean p  observed  bar` | `dim` header, default cells, one accent for the bar |
| **rule** | `╶──── <caption>` (`fenceRow`, `Transcript.tsx:147`, already implemented) | `╶──── pending` | `code` |
| **note** | two leading spaces, `dim` | `  … +18 settings at their defaults (/config --all)` | `dim` |
| **gap** | one blank row | | — |

`renderBlock` is pure: it does the column arithmetic, the ` · ` / hanging-indent wrap of TD3 rule 3 and the truncation
of §3.1.5, and returns **pre-split** rows — one `<Text>` per row, which also removes Ink's trailing-space artefact.
A block mixes kinds freely but **never changes the key column inside one block**.

**`gap` exists because Ink measures `<Text>{''}</Text>` at height 0** (verified with `ink-testing-library`:
`<Text>{''}</Text>` collapses to height 0 while `<Box height={1}/>` yields a blank line). It renders as
`<Box height={1}/>` in the TUI and as a bare empty line (no label, no trailing space) in `--plain`.

**A `block` never emits a label-only row; an empty *chat* item does** — §5.2 P-C4 gives `formatTranscriptItem`
(`plain.ts:487`) a `trimEnd()` precisely so an empty `[you]` item's stored row is `"[you]"` with no trailing space.
The two are distinguished by **label**, and that is how the §3.5 normaliser drops gaps: a row that is exactly a
label (`[you]` / `[jevcode]`) is a **chat** blank line and is compared like any other row; a row that is empty with
**no** label is a block `gap` and is dropped on both sides. (An earlier draft asserted "`formatTranscriptItem` never
produces a label-only row", which §5.2 falsifies in the same document — §14.2 "Review log" item 17.) A gap as the first or last row of a block is dropped (the block has its own blanks); two consecutive gaps collapse
to one; `--json` emits nothing for a gap; `transcript.log` never carries one (it holds no information).

#### 3.1.4 Numbers, units, ids, paths (extends TD3 rule 6)

| quantity | format | source of truth |
| --- | --- | --- |
| money ≥ $0.001 | `$0.025` | `stepCostText` `plain.ts:423` |
| money < $0.001 | `$0.0002` | same |
| caps | `$2.00`, `$10.00` | `usd2` `budget/lines.ts:33` |
| per-unit money | `$0.000006` — **never** `9.9e-6` | TD3 rule 6 |
| percent | `12 %` (one space, no decimals) — **the only form**; `/calibration`'s `nearPct` moves to it (§14.1 row 7) | `/cost` today |
| duration < 10 s | `4.9s` | `stepWallText` `plain.ts:429` |
| duration ≥ 10 s | `14s`, `1m02s`, `1h04m` | `formatDuration` `core/time.ts` |
| latency | `231 ms` (space, integer) | `/jev` today |
| bytes | `12 B`, `1.2 kB`, `4.0 MiB` | `formatBytes` `undo/diff.ts` |
| counts ≥ 10 000 | `12 480` | `grouped` `budget/lines.ts:39` |
| probability / risk | `0.95` | `p2` `plain.ts` |
| tokens | `12.4k` | `kTokens` `plain.ts` |
| a run id | **only** in `[run] start`'s successor, the epilogue `run` row and `/status`'s `run` row (TD3 rule 7) | §3.6 |
| a path | `shortPath()` (§3.4) | new |
| a missing value | `—`, never an empty cell, never `null` | `/jev` today |

#### 3.1.5 Truncation

| case | rule |
| --- | --- |
| a value longer than its column | prose elides **right** with `…`; a path elides **left** (`…/T/a3-ws/src/app.py`); an **identifier is never elided** — the row wraps instead |
| a list | `a, b, c (+4)` — `LIST_MAX = 5`, as `plain.ts` already does |
| rows beyond a cap | one dim footer `… +N more · <the command that shows them>` |
| block caps | `/config` 24 · `/help` 60 (`HELP_MAX_LINES`) · `/decisions` n · `/plan` 40 · `/diff` 42 · `/why` 24 (`WHY_MAX_LINES`) · `/calibration` 19 · `/errors` 12 |

#### 3.1.6 Colour roles inside a block (≤ 3 per row)

Round 3 rule 2 gives bodies the default role and takes `[ui]` out of `dim`. Round 4 extends it to the **detail rows**,
which `Transcript.tsx:216` paints with no props at all today:

| element | role |
| --- | --- |
| the block head | default (the label is `dim`) |
| a kv key, a table header, a footer, a `rule` caption | `dim` |
| a value, a fact, a table cell | default |
| a bar (`eighthBar`) | `accent2` |
| a verdict `ok` | `ok`; `[review]` `warn`; `[block]` `error` |
| a diff `+` row | `added`; `-` row `removed`; `@@` `hunk`; `diff --git`/`index`/`---`/`+++` `diffMeta` (§6.2) |
| a meter word `high` | `warn`; `critical` / `over` | `error` |
| a `pending:` row | `accent` |
| everything else | default |

Rows that arrive as raw strings (`/why`, `/plan`, `/decisions`, `/calibration`) are classified by a pure
`detailRole(text): ColorRole | null`. **The classifier only runs on rows whose block declared its syntax** (a
`BlockRow.syntax?: 'diff'` flag, or `TranscriptItem.detailKind` of §6.4) — never globally, so a `/why` body line that
happens to start with `+` is not painted green.

#### 3.1.7 Empty and error states: an empty state is never an error

Every empty state is a **sentence in the body**, never a head, never a parenthesis-only fragment:

| block | today | round 4 |
| --- | --- | --- |
| `/decisions` | `(no decisions yet)` | `no decisions yet — they appear from the first step` |
| `/plan` | `(no plan yet)` | `no plan yet — Jev writes one at the first step` |
| `/errors` | `(no warnings or errors yet)` | `nothing to report — no warnings or errors this session` |
| `/budget` pending | `pending: none` | `nothing pending` |
| `/jev` before a run | `decider —` | `decider not resolved yet — the first question resolves it` |
| `/cost` before a run | `session $0.00 of $10.00 (0 %, 0 runs)` **as the head** | head `cost`; body `no runs yet — the session has spent $0.00 of $10.00` |
| `/undo`, no run | `error: /undo: no finished run in this session yet` | `nothing to undo — no run has finished in this session` (an **info** item) |
| `/undo`, no changed step | `error: /undo: no step of the last run changed files` | `nothing to undo — the last run changed no files` |
| `/diff`, no run | `error: /diff: no run in this session yet` | `nothing to diff — no run in this session yet` |
| `/report`, no run | error | `nothing to report yet — a run has to finish first` |
| `/resume`, no sessions | `noSessionMessage` | kept, plus `start one by typing a task` |
| `/history clear` | `history cleared` | `history cleared — 0 entries kept` |

Only a **refused or malformed** request is an error, and errors keep one shape:

```
error: /<command>[ <arg>] — <what went wrong> — <what to do instead>
```

Measured rewrites (PROBED `idle6`): `error: /undo: expected a step none yet with changed files, got "2"` (the "expected
`<set>`" phrase with an empty set substituted) becomes `error: /undo 2 — no run has finished in this session yet` or
`error: /undo 2 — step 2 changed no files; steps with changes: 1, 3`; `error: /export: /nope/dir/x.log is on the secret
denylist; JevCode never writes there` — which reports a path *outside the workspace* as a denylist hit — becomes
`error: /export — /nope/dir/x.log is outside the workspace; pass a path inside <ws> or omit it`, with the denylist
wording kept only for a real denylist hit.

**"Did you mean".** `unknown command /bogus; type / to list commands` becomes
`error: /bogus — not a command. Did you mean /budget? · type / to list commands`, using `rank(token, commandNames())`
(`src/tui/commands/fuzzy.ts`) and showing the top match when its score ≥ the word-prefix band (700). The tokeniser
error quotes the **whole** rejected line (clipped at 80) instead of the first token, so the measured `/bogus/steer`
cascade is legible on the first repeat. *Edge cases:* no match above the band → no suggestion clause; the token **is**
a valid alias → never reached (TD3 rule 1); prefer the best *available* match while live and fall back to the best
overall with the availability note; `rank` over 41 names + 21 aliases is O(62) and runs on **Enter**, not per key.

### 3.2 Frames (every row width-checked at its geometry, drawn with round 3's 10-cell gutter)

**F-B1. `/status` after a run, 24×80** — kv rows, key column 10, `shortPath`; the 106-cell row of A3 §2.2 is gone.

```

     [ui] status
          run        20260922-035503-kntk2yw3 · complete (exit 0)
          session    20260922-035503-kntk2yw3 · 1 run · $0.001
          step       4 of 40 · idle
          workspace  ~/T/a3-ws-jC6j7y · no git repository
          sandbox    seatbelt · lock released

```

**F-B2. `/cost` after a run, 24×80** — a noun head; no scientific notation; the last kv row wraps **under its value
column**, never to column 0.

```

     [ui] cost
          run        $0.001 of $2.00 · 0 %
          session    $0.001 of $10.00 · 0 % · 1 run
          per step   p50 $0.000 · last $0.000 · about 9 577 steps left
          generator  $0.000 · provider usage
          jev        $0.001 · 83 questions · $0.000006 each · p50 0 ms
          chat       $0.0001 · 1 message · p50 0 ms
          raise it   /budget spend-cap <usd> · /budget session-spend-cap
                     <usd|none>

```

**F-B3. `/config` at 24×80** — body width 70; the source is a **dim parenthetical on rows that are not at their
default**, which is what makes three columns fit in 70 cells; default rows fold behind the footer; a row with a
**problem** (§7.5) is never folded and carries `✗`.

```

     [ui] config · 6 set, 34 at their defaults
          setting                     value
          mode                        jev-on  (flag)
          generator.model             z-ai/glm-5.3-flash
          decider.model               typesafe/jev-1.13-20260917
          limits.spendCapUsd          $2.000
          limits.maxSteps             lots  (file)  ✗ expected an integer ≥ 1
          session.spendCapUsd         $10.000  (derived: 5 × limits.spendCap…
          workspace                   ~/T/a3-ws-eO2WYu  (flag)
          runsDir                     …/a3-home-L5tIsG/runs  (env)
          … +34 settings at their defaults (/config --all)
          ╶──── sandbox
          seatbelt · writes only in the workspace and run dirs · secrets,
          ~/.ssh, ~/.aws unreadable · network on (--no-network)

```

**F-B4. `/config` at 24×40** — body width 30 (gutter rung; `blockWidth(40) = 30`), the **tight** block tier: the key
on its own row, the value indented 2. Note the two axes: the *item* is in §2.3's `gutter` rung (columns ≥ 34) while
the *block* is in §3.1.2's `tight` tier (width < 34).
Compare today's three rows plus a blank per setting.

```

     [ui] config · 6 set, 34 default
          mode
            jev-on  (flag)
          generator.model
            z-ai/glm-5.3-flash
          decider.model
            typesafe/jev-1.13-2026…
          limits.spendCapUsd
            $2.000
          workspace
            ~/T/a3-ws-eO2WYu  (flag)
          … +34 default (/config --all)

```

**F-B5. `/diff` after a run with changes, 24×80** — today's `diffStatBlock` grammar given the **body** width; the `†`
legend folds into the head's meta; the header is built short instead of being truncated (§6.5).

```

     [ui] diff · 3 files · +42 −7 · 1 already dirty
          M  src/loop/engine.ts             +31 −4  ███████████▌
          A  tests/test_replan.py           +11 −0  ████
          D  scratch_0.py†                   +0 −3  ▌
          … +2 more files (/diff --all)

```

**F-B6. `/diff 1` with a real hunk, 24×80** — `+` rows `added`, `-` rows `removed`, `@@` `hunk`, the file rule
`diffMeta` (§6.2); the `---`/`+++` pair becomes one rule row. **`/diff <step>` keeps its git-shaped, sign-prefixed
text and gains no line-number columns** — §6.5 item 5: the TUI routes it through `detailKind: 'diff'` for **colour
only**, so `/copy diff` and `--full` stay pasteable. §6.2's two-column numbered shape is for the **review card**
and the proposal-preview detail body (F-E1), which are read, not pasted.

```

     [ui] diff · step 1 · scratch_0.py
          ╶──── a/scratch_0.py → b/scratch_0.py
          @@ -1,3 +1,4 @@
           import sys
          -VALUE_0 = 0
          +VALUE_0 = 3
          +VALUE_1 = 7
           print(VALUE_0)
          … +38 more lines (/diff --full)

```

**F-B7. An error, 24×80** — the fixed shape, wrapping under the gutter.

```
     [ui] error: /undo 2 — step 2 changed no files; steps with
          changes: 1, 3
```

### 3.3 The per-command work list

`W` = the builder receives a width today. Everything in the "round 4" column is `BlockRow[]` through `renderBlock`.

| command | builder (file:line) | W | round 4 |
| --- | --- | --- | --- |
| `/config` | `config-table.ts:104` | **no** | `configTableLines(record, { sandboxLevel, width, all })`: three columns sized to `width` (`setting` = `min(28, longest)`, `source` = `min(20, longest)`, `value` = the rest, min 12); a `derived (…)` suffix that does not fit moves to its own indented `note` row; default rows fold behind the footer; the head carries `· 6 set, 34 at their defaults`; the sandbox footer becomes `{kind:'rule',caption:'sandbox'}` + a `facts` row; `session.spendCapUsd effective …` (`session.ts`) becomes a kv row **inside** the table. **`configTableLines`/`configTableRows` already take `{ all }`** (`config-table.ts:70, 104`); what is missing is the `--all` **flag spec** in `registry.ts` and the arg plumbing |
| `/status` | inline, `session.ts` | no | kv rows `run` `session` `step` `workspace` `sandbox` with `shortPath` (F-B1) |
| `/cost` | `costBlock` `budget/lines.ts:322` | no | `(input, width)`; kv rows; `raise it` gets a key; `~$9.9e-6 each` → `$0.000006 each` (TD3 rule 6); `(1 runs)` → `1 run` (a real pluralisation bug at `session.ts`, `costBlock` already gets it right) |
| `/jev` | inline, 3 rows | no | kv rows `decider` `latency` `cost` `intake`; the empty state is §3.1.7's sentence |
| `/budget` | inline, 2 + pending | no | kv `run` `session`, then a `rule` caption `pending · next /resume or run` and one kv row per pending value (today the parenthetical repeats on every row); the `<set>` echo uses the **same** key and order as the show form |
| `/why` | `whyBlock` `why.ts:227` | **no** | `(d, ctx, g, width)`; the `L3`/`L4` prose wraps with a hanging indent **under the probability column**, never to column 0 |
| `/calibration` | `calibrationBlock` `calibration.ts:333` | **no** | `(stats, g, width)`; at width 30 drop the `bar` column first, then `observed` |
| `/diff` | `diffStatBlock` `undo/diff.ts:263` | yes (terminal) | takes the **body** width; the header is built short; see §6.5 |
| `/diff <step>` | `diffStepLines` `undo/diff.ts:522` | **no** | `(step, files, { context, maxLines, width })`; a source line longer than the width is **never wrapped** (a wrapped diff line is a lie) — elide right with `…` and add the footer |
| `/plan`, `/decisions` | `planRows`, `decisionRows` | yes (terminal) | call sites pass `blockWidth(columns())` — **required by TD3 rule 4**, else every row overflows by 10 |
| epilogue | `epilogueRows` `epilogue.ts:75–81` (the `files` row is `:78`, `resume` `:79`, `report` `:80`) | **no** | `(ctx, width)`; kv rows at key 10 with `shortPath`; the stderr twin (`epilogueLines`, `:89`) uses `columns − 2` for its two-space indent |
| `/help` | **two** formatters today | TUI yes / plain no | round 3 F9 already routes both to `palette.helpLines(columns, …)`; round 4 adds the style: group by `CommandSpec.category` — **which already exists** (`registry.ts:45` `export type CommandCategory = 'session' | 'run' | 'inspect' | 'money' | 'config' | 'files' | 'ui' | 'project';`, `:62` the field, used at `:112, 123, 134, 147…`), so the work is the **grouping that consumes it**, not the field — with a `rule` row per group, align `name(12) alias(3) usage`, and move the availability tag to a dim right-hand column instead of inline `(idle only)`. `HELP_COMPACTION_LEVELS` gains a level 5: drop the group rules |
| `/errors` | the kept item texts | — | `note` rows; the empty state of §3.1.7 |
| **`/peers`** (**new**, §7.10) | — | — | a block: head `peers · <n> here, <m> stale`, one kv row per peer (`workspace`, `started <t> ago`, state) — never a pid, never a path; empty state `no other jevcode is working in this workspace`; stub state `the peer registry is not available in this build` |
| **`/ui reset`** (**new**, §7.1) | — | — | one-line item `ui reset — <n> panes unlatched` / `nothing was latched`; clears every `guard()` pane latch |
| **`/fullscreen`** (**new**, §1.3.1) | — | — | one-line item: persists `ui.renderer` and offers a relaunch (it never switches in place — `render()` is called once per stdout) |
| **`/scrollback`** (**new**, §1.3.4) | — | — | no block: suspends, prints the transcript to the primary screen through `createPlainRenderer`, resumes. Under `classic` the one-line answer of §12 |
| the rest (`/new` `/rename` `/steer` `/model` `/provider` `/mode` `/trust` `/export` `/report` `/logout` `/copy` `/transcript` `/panel` `/theme` `/history`) | one-line items | — | §3.1.7's error shape and §3.4's paths; no block |

*Edge cases for the API itself.* (1) `columns` unknown / 0 → `gutterMode` says `flush` and `blockWidth` returns 1
(never 0); a one-cell block is legible nonsense, but it is **bounded** and does not overflow, which is the property
the gate asserts. (2) 640 columns → ceiling 160.
(3) a key longer than 10 → the value moves to the next row indented 2, the key keeps its own row. (4) a value with a
zero-width or wide grapheme → **all** arithmetic through `glyphs.ts` `cellWidth`/`truncateCells`, never
`String.length`. (5) a value containing `\n` or a control byte → `oneLine`/`sanitizeStream` as today. (6) a row exactly
`width` → no wrap, no trailing space. (7) `rows.length === 0` → the head alone, no gap rows. (8) `--ascii` → ` - ` for
` · `, `-` for the rule (`glyphs.ts:159,168`). (9) screen reader → tables drop bars and emit cells as the pane builders
already do. (10) `NO_COLOR` / depth 1 → `role` is ignored by `textProps`; rows byte-identical. (11) a resize between
the command and the next frame → `<Static>` rows are already committed at the old width; that is today's behaviour for
every item and stays (the block is scrollback, §2.3 edge 7).

*Edge cases for `/config`.* (1) an empty record → the header row + `no settings resolved yet`. (2) a masked secret
(`<dotenv:/x/.env> (sha256:3f9a2c1d)`) → **never** elided in the middle of the fingerprint; elide the source path
instead. (3) an `.ignored` row stays directly under its effective row and is **never** folded. (4) `--all` with 60
rows on a 24-row terminal → the block is scrollback, so it scrolls; `STATIC_ITEM_MAX_ROWS` does not apply because the
item carries `detailRows` from a command block (§2.3's source-keyed exemption), and the block's own §3.1.5 cap and
footer govern instead.
(5) width < 34 → F-B4's `tight` tier (§3.1.2 — not §2.3's `stacked` rung). (6) a setting name longer than 28 → the name keeps its own row.
(7) `jevcode config --json` untouched. (8) **a row with a problem is never folded** (§7.5).

### 3.4 `shortPath()` — one function, every path

```ts
// src/core/text.ts (beside clip / firstLine)
export function shortPath(abs: string, o: { root: string; home?: string; width: number }): string;
```

Workspace-relative when inside `root` (`src/app.py`); `~`-abbreviated when inside `$HOME`; otherwise **left**-elided to
`width` keeping the last two segments (`…/runs/20260922-035503-kntk2yw3/`). It **never breaks a run id**: if the last
segment alone exceeds `width` the row wraps instead of eliding. Consumers: `/status`, `/config`, `/export`, `/report`,
the epilogue (`abbreviateDir` becomes a thin wrapper), `/diff` heads, `[sandbox]`, and every error that names a file.

*Edge cases.* (1) `root === home` → `~` wins. (2) a real directory literally named `~…` → only a literal `$HOME`
**prefix** is substituted (today's `abbreviateDir` rule). (3) a relative path is returned unchanged. (4) a UNC /
Windows path → no substitution (out of scope; must not throw). (5) wide graphemes → cell arithmetic. (6) a
denied/secret path still passes `redact` **first**.

Measured motivation (PROBED `postrun`): the epilogue's `files` row splits a run id **mid-token**
(`…/runs/2` ⏎ `0260922-…`), and its `report` row's continuation lands at column 0 under the key column so it reads as
a new key.

### 3.5 The `--plain` twin, `annotateBlock`, and the declared normaliser (D-W)

Two mechanical changes make the three sinks agree:

1. **`block()` gains an explicit row list both renderers walk.** `renderBlock` produces the rows once (as **rendered
   row texts**, `string[]`); the TUI hands them to one item as `detailRows`, `--plain` emits one `[ui] <row>` item per
   row through a new `Renderer.blockLines(lines: readonly string[])` whose **default implementation is today's
   per-line `note`**, so no renderer breaks. **The body row keeps its `[ui] ` prefix in `--plain`** — this is today's
   behaviour (`session.ts:1364–1371` `note(head, opts); for (const l of lines) note(l, opts);`) and the one form
   §14.1 row 6's argument depends on. A bare-line body was considered for A6-16 ("each pre-padded row gains a 5-cell
   prefix and the counts/bar columns no longer line up") and **rejected**: it has exactly the property §14.1 row 6
   rejects "head only" for — `--plain`'s stdout and `--plain`'s `transcript.log` would disagree, breaking the standing
   rule in a second place. **A6-16 is closed by the width contract instead** (§6.5 item 1: the body is built at
   `blockWidth(columns) = columns − 10`, so the uniform 5-cell `[ui] ` prefix fits with 5 cells to spare and the
   columns line up), which is a strictly better fix because it also fixes the TUI's 10-cell overflow (A6-15).
2. **`Engine.annotateBlock(head, rows, opts): boolean`** (contract, §8 item 2) emits one `notice ui` per row, head
   first, exactly as `--plain`'s loop does. `block()` calls it when a run is live and falls back to per-row local items
   when idle.

**The declared normaliser** (goes in `docs/TUI.md`'s identity section and, as `normaliseBlockRows(rows)`, in
`test/pty/helpers.ts` and `test/unit/tui/helpers.ts`, replacing the ad-hoc comparisons at `twins.pty.test.ts:98–130`):

> Drop the leading `[ui] ` of a `--plain` body row; drop the leading gutter spaces of a TUI body row; drop `gap` rows
> on both sides; join a TUI row's wrap continuations exactly as TD3 §5.3 joins an item's (strip the gutter, join with
> one space, honour the cuts of §2.4). The remainder is equal, row for row, in the same order.

*Edge cases.* (1) the run finishes between the head and the last row → `annotateBlock` is one `emit` loop **inside**
the engine, atomic with respect to `isFinished()`. (2) a 42-row `/config` while live → `BLOCK_LOG_MAX = 24` rows plus a
final `… +N more rows`; `transcript.log` is a support artefact, not a pager mirror. (3) `--json` gets N `ui` lines
instead of 1 — declared in `docs/COMMANDS.md`; checked consumers in §3.8. (4) an **idle** block still writes nothing to
`transcript.log`; that is the documented rule and it stays. (5) `--ascii` — compare within one glyph set.

### 3.6 The history: the D-M engine-item rewrite (D-V)

Every line below is the text of one `TranscriptItem`, produced by `itemsFromEvent` (`src/tui/plain.ts:300–412`) or
`stepSummaryText` (`:464`). **All three sinks change together because the formatter is shared.** Sentence case; no
`k=v`; no `|`; ` · ` is the only inline separator; run ids only where §3.1.4 allows.

| item | today (`plain.ts`) | round 4 |
| --- | --- | --- |
| `run:start` | `:310` `start <id> mode=jev-on resumed from step N task: <task>` | `started · jev+llm · <task>`; resumed: `started · jev+llm · resumed at step 7 · <task>`. The **id moves to the epilogue** and `/status` |
| `run:ready` | `:312` `ready <id> step 0/40` | **deleted as an item** (the kind stays for `--json` and `useEngine`; `itemsFromEvent` returns `[]`). Saves one row and one id per run |
| `intent` | `:314` `intent=edit p=0.82 c=0.71` | `intent · edit · 0.82 (confidence 0.71)`; the fallback clause becomes ` · Jev answered none_of_these` |
| `context` | `:316` `context 5 files 12kB of 30 candidates: a, b …` | `context · 5 of 30 files · 12 kB · a.py, b.py, c.py (+2)`; with zero files `context · nothing to read of 30 candidates` (the measured trailing `: ` with an empty list goes) |
| `synth` | `:319` `synth rank: top candidate …` | `synth · rank · top candidate \`return 2\` · 12 candidates, 3 tested` |
| `proposal` | `:321` `proposal edit a.py: <goal> \| plan done=1 remaining=2 open=0` | `proposal · edit a.py +12 −3 · "<goal>"` — the counts from §6.1's `editSummary`, the plan counts move to the `plan` item which already carries them |
| the proposal preview | `detail` drawn at column 0 | stays TUI-only, as a `rule` + indented body: `╶──── edit a.py` then the diff rows (§6.2) at the body column + 2 |
| `risk` | `:327` `risk=0.01 ok: <the whole audit reason>` — **8 terminal rows for an `ok` verdict** | **one row**: `risk 0.01 ok · destructive 0 · irreversible 0`; on `review`/`block` the dominant dimension and its level text clipped to 80 plus a pointer: `risk 0.62 review · destructive 2 "overwrites a tracked file" · /why s7.risk.destructive`. The audit string becomes the item's TUI-only `detail` |
| `confirm:resolved` | `:329` `confirm c-2 declined (note: …)` | `review declined · "<note>"` — the confirm id is machine-only (it is in `decisions.jsonl`) |
| `outcome` executed / noop | `:332` `outcome executed: <summary> (exit 0, 10ms) changed=1: a.py` | `done · <summary> · exit 0 · 10ms · 1 file (a.py)`; `read 1 file(s)` → `read 1 file` / `read 3 files`; the duplicated `exit 0 (exit 0, 10ms)` collapses |
| `outcome` **blocked / declined / failed** | `:206–214`, e.g. `case 'blocked': return { text: \`outcome blocked: ${o.reason}\` }` (`:207`) — interpolates the **whole** `RiskAssessment.reason`, which carries `matches_intent=0.08` and repeats, verbatim and 200 characters long, the `risk` row printed **one line above it** (measured: `docs/live/tui/round-2/typesafe-24x80-runs/*/transcript.log` lines 26 and 27) | a **summary** in the same one-row shape `risk` gets: `blocked · <dominant dimension> <level> · "<level text, clipped to 60>"`, with the **full reason as the item's TUI-only `detail`**. This is the row that removes the last `k=v` from the scrollback and the duplication D-V claims to fix; the epilogue, `decisions.jsonl` and `RunResult` keep the raw reason unchanged (edge 9) |
| `judge` | `:336` six `k=v` pairs | `judge 0.90 · no tests · 0 of 0 claims accepted · complete 0.05`; with tests `judge 0.90 · tests 41p/0f/0e pass · 2 of 3 claims accepted · complete 0.62` |
| `plan` | `:338` `plan done=0 remaining=3 unverified=0 problems=0` — identical on every step | emitted **only when a count changed** since the last plan item (the first plan of a run always emits): `plan · 1 done · 2 remaining`; with rejections ` · rejected "create the scratch module" (+2)` |
| `loop:tripped` | `:345` `loop tripped: <signature> x3` | `loop · the same step repeated 3 times · <signature>` |
| `replan` | `:347` `replan change_approach p=0.61 c=0.50 impossible=0.12: <text>` | `replan · change approach · 0.61 (confidence 0.50) · "<text>"`; the `impossible` figure only at ≥ 0.50: ` · task impossible 0.62` |
| the git banner | `gitBannerLine`, `src/workspace/gitstate.ts` (**not** `plain.ts:349`, which is `case 'transcript':`) — two clauses saying the same thing | `git · no repository — changes are not recoverable; /diff <step> compares pre-images` |
| `retry:settled` | `retrySettledText` `:261` | `warning · jev retried 3 times over 41s — gave up` |
| `pause:requested` | `:363` `pause requested: stopping after step 5` | `pausing · the run stops after step 5` |
| `steer:*` | `:356–362` | `steer queued · step 8 · "<text>" · 1 waiting` |
| the stop line | `src/loop/stop.ts:56` `stop: complete at step 5` | **deleted** — `[run] end` already says it |
| `run:end` | `:400` `end complete steps=5 wall=105ms cost=$0.001 (gen $0.000, jev $0.001) exit 0` | **one form, everywhere**: `finished · <reason> · <n> steps · <wall> · $<cost> (generator $<g> · jev $<j>) · exit <n>`. The parenthetical is **always present** (it is the split a user checks when a bill surprises them) and, being attached to the cost token, is what TD3 rule 3 wraps as a unit. F-H1 and F-H3 are drawn with it |
| the epilogue `[ui] stopped` | `epilogue.ts:75–82` | head unchanged; rows become kv rows at key 10 with `shortPath` (§3.4), and the `files` row lists only files that exist (§7.2) |
| `[step N]` summary | `:464` | **segment order unchanged** (`action · risk · outcome · tests · judge · wall · cost` — already the good row); §6.6 enriches the *outcome* segment to `3 files +18 −4` and appends ` · /diff <N>` as the **last** segment, so TD3 rule 3 drops it first |
| `budget:*`, `blocking:*`, `secret-ack`, `[sandbox]` | — | **unchanged** (already sentences; `[sandbox]` is round 3's) |

**The decided segment order for a step:** `action` first (what happened), then `risk`, `outcome`, `tests`, `judge`,
`wall`, `cost` — **cost is last of the always-present segments**, so it is the token that wraps and TD3 rule 3 keeps
` · $0.006` moving as a unit. The **optional** ` · /diff <N>` hint follows the cost and is **dropped first** when the
row runs out of width (it is a pointer, not information). "Cost last" and "`/diff` last" are not in conflict once
the two classes are named: the compact-run frame above and F-E2 both show `· $0.0002 · /diff 1`.

*Edge cases.* (1) `run:ready` stays an **event**; only its item disappears. (2) a resumed run must still say
`resumed at step N` (`engine-core.test.ts:148` pins it). (3) `interruptedAt` steps keep `interrupted at <stage>
(<reason>)` (`plain.ts:465`). (4) a `done` proposal has no goal → no empty quotes. (5) a step with no proposal →
`(no proposal)` as today. (6) the risk `detail` passes `clipDetail`. (7) `--json` consumers read the **events**, never
the item text. (8) every new text goes through `oneLine` + `clip(600)` as today. (9) **`RiskAssessment.reason` itself
is not touched** — it is stored in `decisions.jsonl`, returned in `RunResult` and fed back to the generator as
`recent[i].reason` (`src/loop/stages/risk.ts`), so changing it would change model behaviour and every bench baseline.
A test asserts `reason` still contains `dominant level`. **What changes is only where it is printed:** the
`outcome blocked/declined/failed` row above summarises it instead of interpolating it, and the raw string moves to
the TUI-only `detail`. (10) **two further `k=v` producers reach the scrollback from modules that are read-only this
round** (§0) and are therefore a **declared V13 allowlist**, not a silent pass: `src/loop/plan.ts:169, 210, 232`
puts `(p=0.70)` / `task_impossible=…` inside the quoted directive text of the `replan` item, and
`src/session/seed.ts:118` `seedNoticeText` emits `plan done=4 remaining=2 unverified=1`. Both go into
`polish-check.mjs` as two named exceptions, each with a one-line reason and a `TODO(round 5)`; round 5 removes the
allowlist. Without this the un-deferred V13 could not pass (§14.2 "Review log" item 29).

**What a compact run reads like afterwards (24×80, the round-3 gutter):** the **run frame** (`[run] started` …
`[run] finished`, excluding the epilogue and the `[you]` bubble) drops from 20 terminal rows to 18 — A3's measured
figure, unchanged; the 21-row excerpt below adds the `[you]` bubble, the blank rows and the 7-row epilogue. The
stop is stated **once** instead of three times; the run id in the epilogue and nowhere else; no `k=v`, no `|`; and the two rows
that used to break mid-token now break at a separator.

```

    [you] fix the failing test

    [run] started · jev+llm · fix the failing test
    [run] git · no repository — changes are not recoverable; /diff <step>
          compares pre-images
 [step 1] write scratch_0.py "Create scratch_0.py" · risk 0.01 ok · 1 file
          +3 −0 · judge 0.90 · 0.0s · $0.0002 · /diff 1
 [step 2] read scratch_0.py · risk 0.01 ok · judge 0.90 · 0.0s · $0.0002
 [step 3] run $ printf ok · risk 0.01 ok · 1 file · judge 0.90 · 0.0s ·
          $0.0002 · /diff 3
 [step 4] done scratch work complete · risk 0.01 ok · skipped · 0.0s · $0.0002

    [run] finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 ·
          jev $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run        20260922-035503-kntk2yw3
          files      ~/.jevcode/runs/20260922-035503-kntk2yw3/
                     transcript.log · state.json · jevcode.log
          resume     jevcode run --resume 20260922-035503-kntk2yw3
          report     jevcode report 20260922-035503-kntk2yw3
                     a redacted bundle is written locally; nothing is sent

```

### 3.7 The pin inventory (every literal and regex that moves with D-V) — **regenerated mechanically, 17 `.steps` + 46 source files**

Landed as **one commit per group**, each moving its own pins; **G1 carries the two `src/perf/pty.ts` constants**.

**This table is generated, not hand-written.** The first act of W4 is to re-run the generator against the working
tree and diff it against this table; a table that has drifted is the defect, not the tree:

```sh
# the run-frame anchors (G1) — 46 files at the time of writing
grep -rlnE '\[run\]\\? ?(start|end|ready)|expect end |END_PATTERN|RUN_STARTED_PATTERN|RUN_STARTED_STEP' test/ src/perf scripts/
# the stage / outcome literals (G2–G7)
grep -rlnE "intent=[a-z]|risk=0\.|judge succeeded=|plan done=|steer queued|outcome (executed|blocked|declined|failed)|context [0-9]+ files|pause requested:|confirm c-|synth rank:|stop: " test/ src/perf scripts/
# the `.steps` run sentinels — exactly 17 files carry `expect end `
grep -rln 'expect end ' test/pty/smoke/ | wc -l
```

**Pinned counts, so drift is visible:** 17 `.steps` files carry `expect end `; 46 files match the run-frame anchor
set. The second grep is deliberately over-broad (it also hits engine-event fixtures that are **not** item text), so
W4's first commit triages its output and records the triaged list here; a file that appears in the generator's
output and in neither the table below nor the triage list blocks the merge.

| group | items | source |
| --- | --- | --- |
| **G1** run frame | `run:start`, `run:ready` (deleted), `run:end`, the `stop:` line (deleted) | `plain.ts:310,312,400`; `src/loop/stop.ts:56` |
| **G2** stages | `intent`, `context`, `synth`, `proposal`, `judge`, `plan` | `plain.ts:314,316,319,321,336,338` |
| **G3** risk | the one-row item + the audit string as `detail` | `plain.ts:327` (the reason itself untouched) |
| **G4** outcome | `executed` / `noop` / `blocked` / `declined` / `failed` / `interrupted` | `plain.ts:189–214` `outcomeText`, `:444` `stepOutcomeText` |
| **G5** control | `replan`, `loop:tripped`, `pause:requested`, `steer:*`, `retry:settled`, `confirm:resolved` | `plain.ts:261,329,345,347,356–363` |
| **G6** workspace | the git banner's duplicated clause | `src/workspace/gitstate.ts` `gitBannerLine` |
| **G7** file edits | `describeAction` (`patch`/`edit`/`write` targets), the `[step N]` outcome segment, the patch-failure text | `plain.ts:157–172,444–457`; §6.1, §6.6, §6.7 |

| file:line | pin | group |
| --- | --- | --- |
| `test/unit/tui/plain.test.ts:93` | `[step 3] intent=edit p=0.82 c=0.71` | G2 |
| `:95` | `intent=investigate … (jev answered none_of_these)` | G2 |
| `:97` | `[step 2] risk=0.50 review: destructive: level 2 (0.50)` | G3 |
| `:100` | `[step 2] proposal edit src/a.py: … \| plan done=1 …` | G2, G7 |
| `:103`, `:527`, `:528` | `[run] end max_steps steps=2 wall=9s cost=$0.010 (gen …)` (+ ` exit 4`) | G1 |
| `:105`, `:521–523` | `confirm c-2 declined (note: …)` | G5 |
| `:301`, `:324`, `:325` | `synth …` | G2 |
| `:323` | `[run] start r1 mode=jev-only task: t` | G1 |
| `:446`, `:448`, `:449`, `:450` | `steer queued/applied/withdrawn` | G5 |
| `:451` | `pause requested: stopping after step 5` | G5 |
| `:477`, `:478` | `warning: <side> retry chain: …` | G5 |
| `:500` | the HEAD-drift warning | G6 |
| `test/unit/tui/height.test.tsx:139` | `[run] start r1 mode=jev-on` | G1 |
| `test/unit/tui/round2-transcript.test.tsx:69, 125, 131` | spacers around `[run] start/end`; `intent=edit p=0.9` | G1, G2 |
| `test/unit/tui/round2-app.test.tsx:233, 234` | `context 2 files`, `intent=` hidden in compact | G2 |
| `test/unit/tui/picker.test.tsx:98, 102` | `[step 7] judge succeeded=0.89`, `[run] end max_steps steps=7` — a **stored** transcript: the picker shows the last two lines verbatim and must keep rendering **old** logs | G1, G2 |
| `test/unit/loop/engine-core.test.ts:130, 134, 148` | `^\[run\] start `, `^\[run\] end complete steps=2 wall=`, `resumed from step 1` | G1 |
| `test/unit/loop/engine-loop-fixes.test.ts:63` | `^\[step 2\] risk=0\.36 ok: completion verified …` — **moves to asserting the clause is in the `Decision` reason**, not the transcript line | G3 |
| `test/unit/loop/engine-steer.test.ts:348` | `[step 2] steer queued (1) for step 2: …` | G5 |
| `test/unit/loop/engine-providers.test.ts:239` | `/steer queued .*look at the tests/` | G5 |
| `test/unit/session/export.test.ts:26, 27, 33, 34` | synthetic `[run] start` / `[run] end complete` fixtures | G1 |
| `test/unit/session/ten-run-seed.test.ts:188` | synthetic transcript fixture | G1 |
| `test/unit/cli/report.test.ts:41` | `[run] start R1 <SECRET>` fixture | G1 |
| `test/unit/perf/pty.test.ts:61` | `[step 1] intent=edit`, `[step 1] risk ok` frame fixture | G2, G3 |
| `test/pty/twins.pty.test.ts:50, 58, 59, 65, 110, 115, 116` | `expect \[run\] start`, `/\[run\] start \S+ mode=jev-on task: …/`, `end complete steps=4`, `^\[run\] end complete ` | G1 |
| `test/pty/chat.pty.test.ts:111, 118, 119, 130, 174, 191, 215` | `end human_abort`, `[run] start \S+ mode=jev-on task:`, `steer queued \(1\) for step \d+:`, `end complete` | G1, G5 |
| `test/pty/round2.pty.test.ts:119, 144, 153, 186, 244, 248, 266` | `\[run\] start`, `expect end (complete\|max_steps)` | G1 |
| `test/pty/review.pty.test.ts:28` | `expect end complete` | G1 |
| `test/pty/run-smoke.sh:203, 207, 212–219` | `end max_steps`, `^\[run\] start`, and the compact-transcript stage regex `^\[step [0-9]+\] (intent=\|context [0-9]+ files\|proposal … \|risk \|outcome \|judge succeeded=)` | G1–G4 |
| **all 17 `.steps` files carrying `expect end `** — `budgetfirst` · `chat-ambiguous-y:14` · `chat-task` · `commands-live:19` · `exitlast` · `oneshot-ctrlc` · `panel` · `polish:22` · `resize-live` · `review-d:18` · `review-y:17` · `s2-ctrlc-abort` · `s2-esc-pause` · `taskfile-header` · `theme-pink:2,13` · `wordmark-22-postrun:11` · `wordmark-handoff:1,11` | `expect \[run\] start `, `expect end (complete\|max_steps\|generator_done)` — **written `[·-]`, never `·`** | G1 |
| **`test/pty/round3.pty.test.ts:118, 122, 131, 168, 169, 199, 200, 231, 252–260, 400`** | `RUN_STARTED_STEP`, `'expect end (complete\|max_steps)'`, `'expect end human_abort'`, and the `{ name: 'ascii', ascii: true }` twin sweep that makes the **glyph-agnostic** form mandatory. **Untracked in `ec61170`** (`git ls-files --error-unmatch` fails) — it is part of the in-flight round 3 this document is written against, and it is the single largest omission a hand-written inventory makes | G1 |
| `test/pty/interrupts.pty.test.ts:92` | `expect(plain).toMatch(/\[run\] end complete steps=40/)` | G1 |
| `test/unit/perf/render-lag.test.ts:108` | the hard-coded frame fixture `'    [run] start 20260921-120000-ab12cd34 mode=jev-on task: t'` that `RUN_STARTED_PATTERN` must keep matching | G1 |
| `src/perf/static-append.ts:166` | `plan done=3 remaining=3 open=0` | G2 |
| **`test/unit/tui/app.test.tsx:158, 602`** | `expect(f).toContain('[run] ready 20260919-120000-ab12 step 0/40')` and `expect(all).toContain('[run] ready r1 step 0/40')` — **D-V deletes this item**, so both assertions must move. §9.1 forbids a slot from editing `app.test.tsx`; **this is the one declared carve-out**: in **W0**, before any D-V commit, S5 moves these two assertions verbatim into `test/unit/tui/round4-chat-app.test.tsx` and deletes them from `app.test.tsx`. No other line of `app.test.tsx` is touched by any slot | G1, **W0 carve-out** |
| `test/pty/helpers.ts:748, 758, 780` + `RUN_STARTED_STEP` | the documented `[run] start <id> mode=… task: …` sentinel and `labelStep('run', 'start ')` | G1 |
| **`src/perf/pty.ts:800`** | `END_PATTERN = 'end [a-z_]+ steps='` → **`'finished [·-] [a-z_]+ [·-] \\d+ steps'`** — **glyph-agnostic** | **G1, same commit** |
| **`src/perf/pty.ts:804`** | `RUN_STARTED_PATTERN = '\\[run\\]<SGR> start '` → **`'\\[run\\]<SGR> started [·-] '`** — **glyph-agnostic** | **G1, same commit** |
| **`test/pty/helpers.ts:780`** | `RUN_STARTED_STEP = labelStep('run', 'start ')` → `labelStep('run', 'started [·-] ')` — same reason | **G1, same commit** |
| **`scripts/pty/polish-check.mjs:397`** | V17's run-end anchor `/^ {0,9}\[run\] end /` → `/^ {0,9}\[run\] finished [·-] /`, as the **exported named constant** `RUN_END_RE` with a zero-match hard failure (see the R2 guard below) | **G1, same commit** |
| `src/perf/{composer-latency,render-lag,states,intake-latency}.ts` | every use of those two constants (they *are* constants, so the two edits cover them — but `render-lag.ts:386` also does `capture.search(new RegExp(END_PATTERN))`, and a silent non-match turns the lag window into the whole capture and the gate into a lie) | G1 |

**Why glyph-agnostic, and not `·`.** `END_PATTERN` (`src/perf/pty.ts:800`) contains no glyph today and therefore
matches in **both** glyph sets. `Transcript.tsx:90` renders every item as `glyphTwin(formatTranscriptItem(item), g)`
and `glyphs.ts:116` `dot: '·'` vs `:168` `dot: '-'`, so an `--ascii` capture carries `finished - complete - 4 steps`.
A hard-coded `·` would silently stop matching in every `--ascii` scenario — including the V21 twin sweep the round-3
gate depends on (`test/pty/round3.pty.test.ts:252` `{ name: 'ascii', args: ['--ascii'], ascii: true }` driving
`RUN_STARTED_STEP` and `'expect end (complete|max_steps)'` at `:260`). **Every `.steps` and test literal in the tables
above takes the same treatment**: a run-frame sentinel is written `[·-]`, never `·`.

**Guard against R2 (a stale or glyph-blind pattern reporting a better p95):** the R2 rule is extended from "the two
`pty.ts` constants" to **every `[run]` / `[step]` anchor in `src/perf/**`, `test/pty/**` and `scripts/pty/**`**:
each one is a **named exported constant**, each has a **self-test** in the pattern of `clearReSelfTest`
(`render-lag.ts:74`) asserting it matches a recorded round-4 fixture **in both glyph sets** (unicode and `--ascii`),
and **a zero-match anchor is a hard failure, never a vacuous pass** (today `polish-check.mjs:399` reports V17 as
success with the reason `no run ended in this capture` when its anchor misses — exactly the R2 failure mode).
`npm run perf` is re-run once after G1 to confirm both windows are non-empty.

### 3.8 `transcript.log` consumers, checked

| consumer | reads | affected by D-V / D-W? |
| --- | --- | --- |
| `src/cli/report.ts` (`jevcode report`) | copies `transcript.log` verbatim, redacting | no parsing — **safe** |
| the session picker preview (`picker.test.tsx:98`) | the **last two lines** of a stored log, verbatim | safe for new runs; **old** logs still render (it does not parse) |
| `src/cli/sessions.ts` / `export.ts` | concatenates run transcripts under a `==== run … ====` header | no parsing — safe |
| `src/bench/**` | reads `steps.jsonl` / `decisions.jsonl` / `run.json`, **not** `transcript.log` (verified by grep) | safe |
| `src/perf/pty.ts` `END_PATTERN`, `RUN_STARTED_PATTERN` | greps the **terminal capture** | **must change with G1** |
| `test/pty/run-smoke.sh` | greps the stripped capture | **must change with G1–G4** |
| a user's own `grep` | — | announce in `CHANGELOG.md`; `docs/TUI.md` gets the new item table |

---

## 4. The palette: Enter cycles, Tab goes deeper (D-X; request 6)

### 4.1 The model, in one sentence, and the safety theorem

> **Tab goes deeper. Enter runs what is written. Enter with nothing written yet walks the list.**

Three rules carry it:

1. **The draft is what runs.** Cycling never mutates the draft; the highlight is previewed as a dim ghost. This keeps
   `routeSubmit` (`src/tui/composer/submit.ts:176`), the `--plain` composer and the history record all routing on the
   same string they route on today, keeps Esc's documented "the draft is kept, the token is remembered" contract
   (`App.tsx:862–873`) honest, and makes the preview identity-neutral (a ghost is never committed).
2. **The ghost *is* the highlight.** One `paletteGhostFor(query, matches, selected)` — so "what will Tab give me" and
   "what is the marker on" are the same question. Today `paletteGhost` reads `matches[0]`
   (`src/tui/commands/palette.ts:267–276`) while the marker sits on `matches[selected]`, and A4 p5 captured both on
   screen at once (marker on `/llm`, ghost `/mode +5`).
3. **Enter runs iff the draft is exact *and* the marker is on the draft's own row** (`armed`). Moving the marker off is
   an explicit "still choosing"; moving it back, or Tab, re-arms.

**Theorem.** *No sequence consisting only of Enter presses can execute `/new`, `/exit`, `/abort` or `/history clear`.*
*Proof.* From `/`, the marker is on row 1 and the draft is `/` — not exact — so every Enter is a cycle, and a cycle does
not touch the draft; the draft therefore stays `/` forever and never becomes exact, so no Enter ever reaches `RUN`. The
one Enter that **does** mutate the draft is the zero-ambiguity accept (S-ONE), reachable only after the user typed
enough letters to leave exactly one candidate, at which point the command is visible in the draft for a full committed
frame — and the confirm-set commands then hit a one-row confirm whose Enter is inert (§4.5). The shortest path from `/`
to a destroyed session is `n`, `e`, Enter, Enter, `y`: three distinct keys, one of them a positive `y`. ∎

This is why round 4 takes A4's model over A5 P14's "Enter runs the highlighted row" (§14.1 row 1): in JevCode a
submitted line is money (TD §22 against A34), and three Enters from `/` land on `/resume`, `/rename`, `/steer` today
but on `/new` in a rewind menu (`REWIND_MENU`).

### 4.2 The state machine

Let `draft` be the composer text, `tok = commandToken(draft.trimStart())` (`src/tui/commands/parse.ts`),
`spec = findCommand(tok)` (`registry.ts`), `M` the ranked matches (`paletteMatches`, `palette.ts:202`), `i` the
marker index, `V` the value list of `spec.args[0].values` filtered by `rank(arg0, …)` with cursor `j`.

**`arg0` and `restTail`, defined exactly** (an earlier draft defined one quantity, `tail` = "the text after the first
run of whitespace", and it made `/budget spend-cap 5` unrunnable — §14.2 "Review log" item 27):

- `arg0` is the **first** whitespace-delimited token after the command. It is `null` when the draft contains no
  whitespace after the token, and `''` when the draft ends in whitespace with nothing after it.
- `restTail` is everything after `arg0` (possibly `''`). It is **never** part of the S-ARG / S-ARGDONE predicates.

So for `/budget spend-cap 5`: `arg0 = 'spend-cap'` (exactly a value of `args[0].values`), `restTail = '5'` →
**S-ARGDONE**, and Enter **runs**. Under the old single-`tail` definition the tail was the whole string
`spend-cap 5`, which is "not exactly one value" → S-ARG → Enter cycles forever, the ghost previews an unrelated arg-0
value appended after the user's amount, the palette never closes (E15 only closes on **zero** matches) and the only
exit is Esc. `registry.ts:315–333` makes this the common case: `/budget` `args[0]` is `kind: 'setting'` with
`values: BUDGET_SETTINGS` and `args[1]` is `{ name: 'value', kind: 'text' }`, and F-B2 tells the user to run exactly
`/budget spend-cap <usd>`.

**`paletteNavState` is an ordered if-chain, not a set of predicates.** The nine states are total and disjoint by
construction; the order is normative and `nav.test.ts` asserts both totality and disjointness as a property test:

```ts
export function paletteNavState(draft, matches, selected): PaletteNavState {
  if (matches.length === 0) return 'none';                                   // 1 S-NONE
  if (spec === null) return matches.length === 1 ? 'one' : 'browse';         // 2 S-ONE, 3 S-BROWSE
  if (arg0 === null) return matches[selected] === spec ? 'armed' : 'picked'; // 4 S-ARMED, 5 S-PICKED
  if (spec.args[0]?.values === undefined) return 'free';                     // 6 S-FREE  (rest/text/path/run/step/int/usd)
  if (spec.args[0].values.includes(arg0)) return 'argdone';                  // 7 S-ARGDONE
  if (arg0 === '' || isPrefixOfSomeValue(arg0)) return 'arg';                // 8 S-ARG
  return 'argbad';                                                           // 9 S-ARGBAD (a typo'd enum value)
}
```

| State | Predicate | **Enter** | **Tab / →** | Shift+Tab | ↑ / Ctrl-P | ↓ / Ctrl-N | PgUp/PgDn | Esc | printable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **S-BROWSE** | chain 3: `spec === null`, `\|M\| ≥ 2` | `i = (i+1) mod \|M\|` | accept `M[i]` → draft `/<name>` → S-ARMED | `i − 1` wrap | `i − 1` wrap | `i + 1` wrap | ±7, clamp | close, keep draft, remember token | insert, `i = 0` |
| **S-ONE** | chain 2: `spec === null`, `\|M\| === 1` | **accept** `M[0]` → S-ARMED | same | same | no-op | no-op | no-op | close | insert, `i = 0` |
| **S-NONE** | chain 1: `\|M\| === 0` | no-op + toast `nothing to pick — no command matches <tok>` | same toast | — | — | — | — | close **and clear the draft when the draft is only the token** | insert |
| **S-ARMED** | chain 4: `spec !== null`, `arg0 === null`, `M[i] === spec` | **RUN** (through the confirm gate) | `spec` has an enum/`setting` arg 0 → append `' '` → S-ARG; else no-op + toast `/<name> takes no arguments` | `i − 1` → S-PICKED | `i − 1` → S-PICKED | `i + 1` → S-PICKED | ±7 → S-PICKED | close | insert, re-evaluate |
| **S-PICKED** | chain 5: `spec !== null`, `arg0 === null`, `M[i] !== spec` | `i = (i+1) mod \|M\|` | accept `M[i]` → S-ARMED | cycle −1 | −1 | +1 | ±7 | close | insert, `i = 0` |
| **S-FREE** | chain 6: arg 0 has **no** `values` (`rest`/`text`/`path`/`run`/`step`/`int`/`usd`) — reached with `arg0` present, so `/rename` with no tail is **S-ARMED**, not S-FREE | **RUN** (`dispatchCommand` validates and reports) | no-op + toast `no completions for <arg>` (TD3 §4.3) | — | move over `M` → S-PICKED | same | ±7 | close | insert |
| **S-ARGDONE** | chain 7: arg 0 has `values` and `arg0` **is exactly one of them** — `restTail` is irrelevant, so `/budget spend-cap 5` is here | **RUN** | `spec.args[1]?.values` exists **and `restTail === ''`** → append `' '` → S-ARG on arg 1; else no-op + toast | −1 → S-ARG | −1 | +1 | ±7 | close | insert |
| **S-ARG** | chain 8: arg 0 has `values`, `arg0` is `''` or a **prefix of** some value | cycle `V` (wrap), ghost = `V[j]` | accept `V[j]` → draft `/<name> <value>` → S-ARGDONE | cycle −1 | −1 | +1 | ±7 | close | insert, `j = 0` |
| **S-ARGBAD** | chain 9: arg 0 has `values` and `arg0` matches **none** of them and is a prefix of none (`/mode jev-onx`) | **RUN** — `dispatchCommand` validates and reports, so the user gets an error instead of an inert key | no-op + toast `no value of /<name> matches <arg0>` | −1 → S-ARG | −1 | +1 | ±7 | close | insert, re-evaluate |

`RUN` is today's `onEnter()` → `routeSubmit` path with the palette branch unchanged (`submit.ts:188`) plus §4.5's
gate. **Cycling never calls `routeSubmit`, `parseCommand` or `dispatchCommand`** — that is what keeps it inside D-F.

**P-P1 — where this lands.** New pure `src/tui/commands/nav.ts` (no Ink, no I/O):

```ts
export type PaletteNavState = 'browse' | 'one' | 'none' | 'armed' | 'picked' | 'free' | 'argdone' | 'arg' | 'argbad';
export function paletteNavState(draft: string, matches: readonly PaletteMatch[], selected: number): PaletteNavState;
export function paletteStep(s: PaletteNavState, key: 'enter'|'tab'|'shifttab'|'up'|'down'|'pageup'|'pagedown', ctx: NavCtx): NavEffect;
// NavEffect = { move } | { accept } | { run } | { appendSpace } | { toast } | { none }
```

`src/tui/keys/resolve.ts:658` `if (isEnter(k)) return one({ type: 'palette', op: 'run' })` becomes
`op: 'enter'`; `App.tsx:1485–1512` dispatches the `NavEffect`, and `case 'complete'` (`App.tsx:1467`) becomes the
**single** `accept` implementation shared by Tab, `→` and S-ONE's Enter. Shift+Tab cycles backwards over the same list
(today `resolve.ts:680` maps it to `move -1`, which is right for BROWSE and wrong for ARG). Binding titles
(`keys/bindings.ts`) become `palette:run` → "run the armed draft; otherwise move to the next row" and `palette:accept`
→ "put the highlighted row in the draft"; `docs/KEYS.md` regenerates.

### 4.3 The ghost, the marker reset, and argument cycling

**P-P2 — the ghost union.** `paletteGhost(query, matches)` → `paletteGhostFor(query, matches, selected)`:

```ts
export type PaletteGhost =
  | { kind: 'rest';  rest: string;   more: number }   // the marked row extends the token: "/mo" ▸ "de +1"
  | { kind: 'arrow'; target: string; more: number }   // it does not (alias or fuzzy hit): "/q" ▸ " → /exit +2"
  | { kind: 'value'; rest: string;   more: number };  // an argument value: "/mode j" ▸ "ev-on +1"
```

`arrow` subsumes TD3 §4.1 rule 3, so the two rounds land **one** type, not two. Rendered at
`src/tui/composer/Composer.tsx` where `ghost.rest`/`ghost.arrow` are read today; `→` becomes `->` under `--ascii`; the
` +N` suffix rule is unchanged.

**P-P3 — the marker resets to the top on every query change** (fzf's documented `change:top` default). When
`commandToken(draft)` changes, `selected = 0`; when the **argument** token changes, only `j = 0`. Today nothing resets
it — `paletteRows` merely clamps (`palette.ts:294`) — which is the second half of the two-commands-on-screen defect.
Implementation: a `lastToken` ref compared in the composer-edit fall-through that already runs on every keystroke
(`App.tsx:1717–1719`); one string compare per key.

**P-P4 — argument sub-rows filter, mark and overflow.** `paletteRows` (`palette.ts:329–344`) already filters values
through `rank(argToken, …)` (round 3 landed that) and highlights the value equal to the token; round 4 adds: the
**value cursor** `▹` (ASCII `-`) so it is never confused with the command marker `▌` (`>`), ` (default)` on the row
equal to `arg0.defaultValue` (already there), and `… +N more` on the footer when the row budget cuts values. PROBED
defect that remains: with four values and a 6-row palette the fourth is dropped with no marker.

### 4.4 The footer says what Enter does, in every state

`PALETTE_FOOTER` (`palette.ts:60`, one constant in every state — so it says "Enter runs an exact match" while the draft
is `/` and Enter does not) is replaced by `paletteFooterText(state, ctx)`:

| state | footer, after `(i/N)  ` |
| --- | --- |
| S-BROWSE | `Enter next · Tab picks · Esc closes` |
| S-ONE | `Enter picks /budget · Esc closes` |
| S-ARMED, enum arg | `Enter runs /mode · Tab adds an argument · Esc closes` |
| S-ARMED, no args | `Enter runs /cost · Esc closes` |
| S-ARGBAD | `Enter runs /mode jev-onx · no such value · Esc closes` |
| S-ARMED, unavailable now | `Enter runs /undo · idle only · Esc closes` (the whole row dim) |
| S-PICKED | `Tab picks /model · Enter next · Esc closes` |
| S-ARG | `Enter next value · Tab picks · Esc closes` |
| S-ARGDONE | `Enter runs /mode jev-on · Esc closes` |
| S-FREE | `Enter runs /rename · type the title · Esc closes` |
| S-NONE | `Esc closes` |

`·` → ` - ` under `--ascii` (today's rule, `palette.ts:351`); the `▲`/`▼` scroll marks are unchanged. **The command
name in the footer is always the resolved owner**, so `/q` reads `Enter runs /exit` — the single best guard against an
alias surprise. The status-line ShortHelp becomes state-aware too: `⏎ next` in BROWSE/ARG, `Tab ⇥` in ARMED/ARGDONE
(TD §1035's drop order unchanged; `Enter next` under `--ascii`). At `n === 1` (`palette.ts:295`) only the footer
survives, and it must be the **state** footer — the one thing a one-row palette can still teach.

### 4.5 The confirm gate for destructive commands

`CommandSpec` gains `destructive?: true` on `new`, `abort`, `exit` and on `history` when `args[0] === 'clear'`.
`DispatchResult.ok` gains `confirm: 'new' | 'abort' | 'exit' | 'history-clear' | null`, set when
`spec.destructive === true` **and** the caller passed `fromPalette: true`.

**`fromPalette` is a provenance ref, NOT `overlay === 'palette'`.** This is the one definition; anything else is a
defect. `App.tsx` keeps `acceptedRef = useRef(false)`: it is set to `true` by an **accept** (Tab / `→` / S-ONE's
Enter) or a **cycle** (any `move` effect of §4.2), and cleared to `false` by **any** composer edit — an insert, a
backspace, a delete, a paste, a history recall (`↑`/`↓`), `closeOverlay`, a submit and a `/new`. `routeSubmit` passes
`fromPalette: acceptedRef.current`, never `i.overlay === 'palette'`. The distinction is load-bearing because the
palette is **open** while a hand-typed `/exit` is being written: `resolve.ts:416` opens it on `/` at an empty draft
(`return s.draftEmpty ? [{ type: 'insert', text: k.input }, { type: 'openPalette' }] : textActions(k)`) and
`App.tsx:1717` closes it only when the draft stops starting with `/`, so the obvious-looking `i.overlay === 'palette'`
test at `submit.ts:186` would put a confirm row in front of **every** hand-typed `/exit`.

*Why provenance-gated (D-X's ratify item).* The risk this closes is **mis-selection**, not mis-typing. A hand-typed
`/exit` + Enter must keep exiting at once (`docs/TUI.md`, muscle memory, `--plain`); a `/ex` + Tab + Enter is a
selection and gets one key of friction. **The regression that pins it is `EXIT_IDLE`**
(`test/pty/helpers.ts:789` — `['send /exit', echoStep('/exit'), 'send \\r', 'eof']`), which ends essentially every
pty scenario in the repo: `round2.pty.test.ts`, `round3.pty.test.ts`, `chat.pty.test.ts`, `review.pty.test.ts`,
`twins.pty.test.ts` and `interrupts.pty.test.ts` all import it, and a confirm row in front of it makes every one of
them time out at exit 124. (`test/pty/smoke/exitlast.steps` is **not** that regression — it never types `/exit`; it is
`make the tests pass` → `expect end max_steps` → Ctrl-C ×2.) `nav.test.ts` additionally asserts that typing
`/`,`e`,`x`,`i`,`t`,Enter with no Tab and no cycle yields `confirm: null`. The unconditional alternative is simpler to explain and to test and
costs one key for people who type `/new` deliberately; it is recorded here and **not** taken because §4.1's theorem
already closes the pure-Enter hazard, so the unconditional form buys nothing the theorem does not already give.

Three one-row overlays in the existing `exitConfirm` slot (`CAP.exitConfirm: 1`, `layout.ts:36`), Enter inert exactly
as TD §2149 already specifies for the exit confirm. **Each is a rung ladder through §2.6's `fitRung`, selected
against the card's inner width (`Overlay.tsx`: `const inner = Math.max(1, p.columns - 4)`, i.e. 76 at the default
80 columns), never a single literal** — the product already solved this once for the exit confirm
(`Overlay.tsx:31–39`: `EXIT_CONFIRM_ROW` 78 cells **and** `EXIT_CONFIRM_ROW_COMPACT` 67, chosen by
`exitConfirmRow(innerCells)`, whose comment reads "the `exit?` card's 76 inner cells at 80 columns would otherwise
cut `(Enter does nothing)`, the statement that justifies the inert Enter" — TD2 §4.7 finding 5). The single-literal
forms are 87 / **101** / 87 cells and all three overflow the card at 24×80; at 40 columns the abort row would read
`abort the run now? the step in flight i…`, a modal with no visible way out and a deliberately inert Enter. That is
the safety surface of the whole Enter-cycling model, so it gets a ladder (measured widths in brackets):

```
new    [76] end this session and start fresh? [y] yes  [n] keep it  (Enter does nothing)
       [55] start fresh? [y] yes  [n] keep it  (Enter does nothing)
       [28] start fresh? [y] yes  [n] no
abort  [79] abort the run now? the step in flight is discarded. [y] abort  [n] keep running
       [64] abort the run? [y] abort  [n] keep running  (Enter does nothing)
       [22] abort? [y] yes  [n] no
exit   [55] leave JevCode? [y] exit  [n] stay  (Enter does nothing)
       [30] leave JevCode? [y] yes  [n] no
       [22] leave? [y] yes  [n] no
```

The abort ladder's top rung drops `(Enter does nothing)` rather than the sentence that says what is lost, because
the abort card is the only one where the *consequence* is the safety information; the rung below restores the Enter
clause once the sentence no longer fits. `overlay.test.tsx` asserts that **for widths 20…200 the chosen rung fits the
card's inner width and still contains `[y]` and `[n]`**, and that every rung's measured width matches its label.

`/history clear` keeps its own `y/N` (`registry.ts`); `/undo` keeps its overlay; `/exit` while live keeps today's
confirm. Ctrl-C and Esc cancel; the rewind menu's `/new` is covered. `--plain`'s numbered picks **do** set
`fromPalette` (§4.6) — that surface is a selection surface, so the gate applies there too.

### 4.6 The command set is 41 after this round; `--plain` and the screen reader get the numbered list

Neither has a palette today (`src/tui/plain-composer.ts` has no completion at all; `Overlay.tsx:276` passes
`screenReader` only to the Wizard). Gemini CLI's numbered radio options are the precedent.
`paletteNumberedLines(query, state, columns): string[]` in `palette.ts` is **one formatter for both twins**:

```
commands (41) — type a number or a name, then Enter
  1  /help        keys by context, commands with one-liners, per-terminal notes
  2  /new         end the session; the next prompt starts a new one here
 …
 41  /exit        leave (exit 0; confirms first while a run is live)
```

- **`--plain`:** a submitted line that is exactly `/` prints the block as one `[ui]` item and sets a one-shot
  `pendingList`. Two rules make it safe, because this is a **selection** surface — exactly the mis-selection risk
  §4.5 exists to close:
  **(a) the pick is `fromPalette: true`**, so a destructive command reached by number gets the same confirm, here
  as a readline `y/N` prompt. Without it, `/` then a mistyped digit runs `/new`, `/exit` or `/abort` with no
  confirmation at all.
  **(b) `pendingList` is visible.** The readline prompt changes for that one turn to
  `pick 1-41, or type a message > ` and reverts on the next. An invisible one-shot would mean a user who typed `/`
  by accident (a stray key, a paste) and then typed a genuine numeric prompt (`12`) would execute command 12. The
  changed prompt also closes A4's open question 5 (whether the numbers need a `#3` prefix) **without** a prefix: it
  is present for exactly the one turn in which a bare integer is special, and it costs nothing to read.
  Anything that is not a bare integer in `1..N` clears `pendingList` and is handled normally, so a bare `12` is a
  prompt in every other turn.
- **TUI under `--screen-reader`:** `/` appends the same block, and each highlight change appends **one** line
  `palette: 3 of 37 · /resume · pick a session to continue · Enter next, Tab picks, Esc closes`, coalesced to at most
  one line per 400 ms so hammering Enter cannot flood. `--plain --screen-reader` and the TUI under SR emit
  byte-identical lines (the declared SR-only normaliser; precedent `SR_REVIEW_MENU`, `App.tsx:103–104`).

*Edge cases.* a bare integer outside `1..N` is a normal prompt; any other line clears `pendingList`; `--plain` under a
pipe uses `columns() === 80`; SR + `--ascii`; the block caps at 40 rows with `… 17 more — /help commands`.

### 4.7 The remaining edge cases that change code

| # | case | behaviour |
| --- | --- | --- |
| E1 | one candidate | S-ONE: Enter **accepts** (cycling is meaningless with one row); ↑/↓ no-ops; the footer names the command |
| E2 | zero candidates | S-NONE draws an inline row instead of today's blank card: `no command matches /zz — keep typing, or Esc to clear`, footer `(0/0)  Esc closes`; Enter is a toast and never an item |
| E3 | a typed alias (`/q`, `/s`, `/m`) | `isExactCommand` already accepts aliases → S-ARMED on the **owner**; the footer prints the owner; TD3 rule 2 pins the owner to row 1 so the marker agrees |
| E4 | an exact name that prefixes another (`/mode` vs `/model`) | S-ARMED: Enter runs `/mode`; ↓ → S-PICKED, the footer flips to `Tab picks /model · Enter next`, and Enter no longer runs |
| E5 | while a run is live | the palette opens; idle-only rows dim (`palette.ts:314–315`); Enter in S-ARMED runs the **command**, never a steer (`submit.ts` short-circuits); an **availability** error clears the draft and closes the palette (TD3 F21 `keepDraft: false`), a **fixable** one keeps both |
| E6 | a run starts while the palette is open | the grouping `PaletteState` is **frozen at open** (the pattern TD3 §4.1 rule 6 uses for `recent`); only the `live` flag refreshes, so rows re-tag `(idle only)` **in place** and never reorder under the user's fingers; `selected` is preserved |
| E7 | while the chat intake is thinking | cycling never reaches `routeSubmit`, so the `submitting` guard cannot swallow it; `RUN` follows TD3 F14 and an idle-only command answers `STILL_THINKING_TOAST` |
| E8 | history ↑/↓ | unchanged and correct: `resolve.ts:682` excludes `composer:historyPrev/Next/up/down` from the fall-through, and the palette only opens on an **empty** draft, so no recall is ever interrupted. A pty test pins it |
| E9 | a paste containing a slash | a **bracketed** paste never opens the palette (`resolve.ts:657` handles pastes first). A **non-paste** chunk that is exactly `/` + `[a-z0-9-]{0,8}` at column 0 of an empty draft **does** open it with the remainder as the query — this is the fix for the measured defect that `send /m` as one write produces `› /m` with **no palette at all** (A4 p2: Ink delivers one `useInput` with `input === '/m'`, which does not match the `/` binding). The length + charset bound keeps a 2 KB unbracketed burst as text |
| E10 | a mouse report | with no tracking enabled the terminal sends nothing or `ESC[A`/`ESC[B`, which move the marker — desirable. If SGR reporting is on from an outer program Ink delivers `[<64;10;5M` as text; `MOUSE_RE = /^\[(?:<[0-9;]+[Mm]\|M[\s\S]{3})$/` drops it **in every context** |
| E11 | the ghost at 40 columns | cut to `inner − cellWidth(lastDraftRow) − 1`; under 4 cells of room only ` +N`; under 3, nothing. The rows carry the information, so nothing is lost. Worst measured case `/budget ` + `max-generator-tokens` + ` +5` = 33 cells, fits at 40 |
| E12 | Ctrl-C with the palette open | today `CLOSE_OVERLAY` only (`keys/interrupts.ts:98–111`, **before** the `!draftEmpty → CLEAR_DRAFT` rule), which is half of the measured trap. New: `CLOSE_OVERLAY_AND_CLEAR` when the whole draft is the token (`draft.trim() === commandToken(draft.trim())`), else today's behaviour. Ctrl-C twice still exits 0 |
| E13 | Esc with the palette open | **unchanged** — close, keep the draft, remember the token (the Codex rule, `App.tsx:862–873`). The trap is undone instead by: `/` typed at the **end** of a draft that is exactly a `/token` **reopens** the palette rather than inserting a second slash. It cannot fire mid-prompt (a prompt has a space or does not start with `/`), and `//` at column 0 still escapes to a literal-slash prompt. **This is where round 4 takes A4 over A5 P14(b)** (§14.1 row 3) |
| E14 | Ctrl-D | unchanged (`interrupts.ts` → `CLOSE_OVERLAY`) |
| E15 | the palette closes | today only when the draft stops starting with `/` (`App.tsx:1717`), and `App.tsx`'s comment claims "a space follows the command", which the code does not test. New: also close when the token has **zero** matches **and** the draft contains a space (`/fix the bug` typed fast no longer leaves a dead card); the comment is corrected |
| E16 | flat tier < 16 rows | unchanged collapse; see §4.4's `n === 1` rule |
| E17 | the rewind menu (Esc Esc) | `rewindMenu` pre-filters to four commands (`palette.ts:204`); S-BROWSE applies unchanged, and because `/new` is in that set §4.5's gate covers it |
| E18 | Enter key-repeat, or a paste containing `\r` | a paste is handled before `isEnter`, so a pasted CR never cycles or runs; a held Enter cycles at the terminal's repeat rate and, by §4.1's theorem, can never run anything |
| E19 | width 0 / `NaN` columns | `paletteRows` already clamps (`palette.ts:287–289`); the new footer builder routes through the same `cut()` |

### 4.8 Frames

**F-P1. 24×80, S-BROWSE after `/` then two Enters** — marker, ghost and footer now agree (compare A4 p1, where the
composer still read `› /help +36` with the marker on `/resume`).

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│   /help       h  keys by context, commands with one-liners, per-terminal no… │
│   /new       nw  end the session; the next prompt starts a new one here      │
│ ▌ /resume     r  pick a session to continue, or continue <id|title>          │
│   /rename        set the session title (≤ 60 chars)                          │
│   /steer         queue a directive for the next step (…)         (live only) │
│   (3/37)  Enter next · Tab picks · Esc closes                              ▼ │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /resume +36                                                                │
```

**F-P2. 24×80, S-ARG after Tab then one Enter** — the sub-rows filter and carry their own cursor `▹`; the draft shows
`/mode ` and `jev-on` is the **ghost**, dim, until Tab.

```
│   /mode       m  engine mode: show, or set for the next run                  │
│ ▹ /mode jev-on                jev+llm: the code model writes, Jev decides e… │
│   /mode llm-jev               llm+jev · verified: candidate patches, tests … │
│   /mode jev-only (default)    no generating LLM; code proposes, Jev decides… │
│   /mode jev-off               the generator alone (bench condition)          │
│   (2/4)  Enter next value · Tab picks · Esc closes                           │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /mode jev-on                                                               │
```

**F-P3. 24×80, S-NONE** — replaces today's empty card with a `(0/0)` footer and a blank filler row.

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│   no command matches /zz — keep typing, or Esc to clear                      │
│   (0/0)  Esc closes                                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /zz                                                                        │
```

**F-P4. 12×60 flat tier, S-BROWSE** — 7 rows, no card edges, every row exactly 60 cells.

```
  /help       h  keys by context, commands with one-liners,…
▌ /new       nw  end the session; the next prompt starts a …
  /resume     r  pick a session to continue, or continue <i…
  /rename        set the session title (≤ 60 chars)
  /steer         queue a directive for the ne…  (live only)
  (2/37)  Enter next · Tab picks · Esc closes              ▼
› /new +36
jev+llm · palette       step 0/–  sess $0.00/1.25 ok  ⏎ next
```

---

## 5. The conversation: turns, separation and edge cases (D-Y; requests 5, 3)

> **Anchor note for this section: every `file:line` in §5 is `ec61170`, the last committed tree**, because A5's 13
> pty scenarios and every offline probe behind these proposals ran there. The preamble's default (the working tree)
> does **not** apply here. Three that differ and would otherwise send an implementer to unrelated code:
> `App.tsx:1039` is `/copy last`'s payload at `ec61170` and `bridge.notify();` in the working tree (the payload is
> at `:1113` there); `App.tsx:1058` is `const onEnter = (): void => {` at `ec61170` and `exit(0);` in the working
> tree (the still-thinking branch is near `:1146`, `STILL_THINKING_TOAST` at `:109`); `App.tsx:905–906` is the
> `droppedMentions` loop at `ec61170` and `composer.clear();` in the working tree. §7's anchors, by contrast, are
> working-tree-correct (`:961`/`:975` `submittingRef`, `:1962` `guard`) and stay that way.

A5 enumerated 47 cases against `ec61170` with 13 real-pty scenarios (committed under
`docs/research/tui/round-4/captures/a5/`): **19 defects, 9 cosmetic, 17 OK, 1 inconclusive, 1 already fixed by round
3**. This section takes the 19 and the 9.

### 5.1 The separation design: the unit is the **turn**, not the item

Define a **turn** as a maximal run of contiguous *visible* items sharing the same chat label (`[you]` or
`[jevcode]`); every other item is its own block. Consistent with TD3 §5.1 (the 10-cell gutter, rule 9 spacing, rule 11
"no box, no background, no rail glyph — the pink label *is* the bubble") and the §5.3 normaliser.

| element | rule | identity |
| --- | --- | --- |
| blank row | exactly one, above the **first** item of a turn / block — never between the lines of one turn; plus above `[run] start`, `[run] end` and (TD3 rule 9) a `[ui]` item carrying a `detail` | layout |
| label | full weight on the first item of a turn (`you` magenta bold / `assistant` pink bold); the **same text** at `dim` on continuation items — including the item that is a surviving blank line — so the gutter stays a column of labels, `stripAnsi` is unchanged and every TUI row still normalises to `formatTranscriptItem(item)`. `Transcript.tsx:200` renders `<Text {...lProps}>{gutterLabel(label)}</Text>` unconditionally today and **keeps doing so**; only `lProps` changes. F-C1 and F-C2 draw it | **colour only** |
| body column | column 10 for every row of the turn (TD3 rule 1) | layout |
| code rows | a row between an opening and a closing fence row **of the same turn** takes the `code` role for its whole body (today only the fence row does, `Transcript.tsx:186–189`) | colour |
| long turns | a turn whose source was clipped ends with one extra item `…(+N characters not shown — /copy last copies the whole message)` | **text** (§5.2) |
| block rule | **no** horizontal rule between turns; the existing rule row stays the scrollback/dynamic boundary and is never duplicated | layout |
| facts reply | each fact is a turn-internal item; the reply ends with one blank row before the next block | colour |
| timestamps | **none** in the scrollback (TD3 confirms; §14.1 row 8 records the alternative that was rejected). A turn's wall time is in `/why intake` and `--json` | — |

**P-C1 — one spacer per turn.** `Transcript.tsx:158–164` `spacerAbove` has `if (item.label === '[you]') return true;`
**unconditionally** while `[jevcode]` one line later is correctly conditioned on `prev.label !== item.label`. Change
both to `if (isChatLabel(item.label)) return prev.label !== item.label;`. Measured: a 3-line message goes from 6 rows
to 4; the 9-line paste of A5 §3.2 from 17 rows to 10 — a **1.7× extension** of a chat-heavy session's scrollback
before the `STATIC_SOFT_CAP` remount, for zero extra state.

*Edge cases.* (a) the first item after the header: `prev` is the header, the spacer fires (unchanged). (b) the first
item after a `<Static>` epoch remount: `prev === null`, no spacer, and the previous epoch's last row is already in
scrollback — accept and document. (c) two consecutive `[you]` turns with nothing between them would merge; only
reachable if a submission returns before `reply()`, which the controller cannot do today (`sessionMeter.exceeded()`
always says something). (d) under `compact` `prev` is the **visible** predecessor, so the rule is "same label ⇒ same
turn" — correct for every sequence the controller can produce; turn ids (§5.5) remove the ambiguity later. (e) a
`[jevcode]` reply right after a `[you]` turn: labels differ, the spacer fires.

**P-C2 — code rows inside a turn read as code.** A running "inside a fence" flag per turn, computed in the
`useMemo` at `Transcript.tsx:228` so the per-row render stays O(1). *Edge cases:* an unclosed fence resets at the end
of the turn and never leaks into the next speaker; the first closing fence closes; `--ascii` is colour-only;
`NO_COLOR` resolves to no attributes so the rows are byte-identical; `<Static>` is write-once, so the flag is computed
**before** the item is written and no row is ever re-coloured; an epoch remount mid-fence restarts false (accepted).

**P-C3 — the label gutter never eats the body.** Covered by §2.3's ladder: `TranscriptRow` drops the label box below
`FLUSH_MIN_COLUMNS` and prefixes the label into the body, so `columns ≤ 10` degrades to plain wrapped text instead of
a zero-width body (`Transcript.tsx:197` sets `width={columns}` with a `flexShrink=0` 9-cell label box).

### 5.2 `bubbleLines`: blank lines, tabs and the clip marker (text changes)

`src/chat/bubbles.ts:21–27` drops blank lines (`.filter(l => l.trim() !== '')`) and maps every `\t` to **one** space,
so pasted code is misrepresented; and a 2 000-character message stops at 600 with a bare `…` and no marker.

**P-C4.** `bubbleLines` keeps blank lines (they become empty items, rendered as an empty body row) and expands tabs to
the next **4**-column stop; a run of more than two consecutive blank lines collapses to two. `formatTranscriptItem`
(`plain.ts:487`) gains a `trimEnd()` so an empty item's stored row is `"[you]"` with **no trailing space**.

**P-C5.** A clipped chat line emits the clipped row **plus one trailing item**
`…(+N characters not shown — /copy last copies the whole message)`; the full text stays available to `/copy last`
(§5.5) and to the ledger (`src/chat/ledger.ts`, which already keeps it).

*Edge cases.* (a) a message that is only blank lines never reaches `converse` (`routeSubmit` → `ignore:'empty'`).
(b) leading blank lines of a paste are dropped (they would open the turn with a gap); (c) trailing blank lines are
dropped. (d) a 600-char line with a tab at position 599: expansion happens **before** `clip`, so the clip still bounds
the row. (e) `--ascii`: tabs are already spaces, no glyph twin. (f) `transcript.log` now carries empty `[you]` rows —
acceptable and **identical in both sinks**. (g) CRLF and a lone CR are already normalised (`bubbles.ts:23`).
(h) exactly 600 chars → no marker. (i) several clipped lines in one turn → **one** marker with the summed count,
after the last line. (j) the count is computed **after** `redact`, so a redaction that lengthens the text cannot leak
the original length. (k) a clipped line that is also a fence stays literal text (`FENCE_RE` requires an exact
`^```\w*$`) — correct.

### 5.3 Enter: bursts, thinking, and a command hidden on line 4

**P-C6 — a burst of Enters is N Enters, not N newlines.** `HARD_CONTROL_RE` (`App.tsx:503` `splitInputChunk`)
deliberately excludes `\r`/`\n` and the one-trailing-newline regex matches only **one**, so any chunk of two or more
CRs falls to the paste-like branch: PROBED, `\r\r\r` in one read produced three newlines and the toast `input arrived
in one chunk; Enter kept as a newline`, and the `/exit` typed on line 4 was then submitted **as chat** (driver exit
124). New rule: a chunk whose non-newline content is empty becomes **one `return` event per newline**; `text` +
several trailing newlines becomes the text then that many Enters; only a chunk with an **interior** newline *between
non-empty text runs* stays paste-like.

*Edge cases (the unit table).* `"\r"` → 1 Enter (unchanged) · `"\r\r"` → 2 Enters · `"hi\r"` → text + Enter
(unchanged) · `"hi\r\r"` → text + 2 Enters · `"a\rb\r"` → **paste-like**, `foldedEnter` toast (a real paste in a
terminal without bracketed paste) · `"\n\n\n"` from a bracketed paste never reaches this branch (`usePaste` handles it)
· a chunk mixing `\x03` with CRs already routes to the per-byte splitter · the second Enter of a burst lands while
`submittingRef.current` is true → `ignore:'submitting'`, no double submit · after the first Enter the composer is
empty → the rest are `ignore:'empty'`, so the net effect of Enter Enter Enter is **one** submission, which is what a
typist means.

**P-C7 — Enter while thinking queues instead of dropping.** `App.tsx:1058–1117` toasts `one moment — still thinking`,
keeps the draft and **drops** the submission; nothing resends it. New: a **one-slot** queue — the submission is
remembered, the composer clears, the status row shows `⠹ thinking · 1 queued`, and when `thinking` returns to `null`
the queued text is submitted. `Esc` cancels it and restores the text to the composer.

*Edge cases.* (a) a second Enter while one is queued keeps the toast and does **not** queue a second (cap 1, the
intake's one-request-at-a-time rule). (b) the in-flight request fails → the queue still flushes (the user asked for
it) but the error bubble lands first. (c) **Ctrl-C ×1 while thinking aborts the request *and* drops the queue** with
`queued message dropped` — never silently send after an abort; this is the money-adjacent case and is the test that
matters. (d) the secret gate runs at **queue** time, not flush time, so `addSecret` still precedes `createEngine`.
(e) `/exit` clears the queue (`finishSession`). (f) if a run started meanwhile, the queued text goes through the normal
`routeSend` path and becomes a steer. (g) a queued message that is empty after trimming is never queued.

**P-C8 — a multi-line draft says how to send it, and never hides a command.** (a) While the draft has an interior
newline the composer's right edge shows `N lines · ⏎ send` (a new right-aligned span on the last row, dropped below
`PLACEHOLDER_HINT_MIN_COLUMNS`). (b) `routeSubmit` scans a multi-line draft for a line that is exactly a known command
(`isExactCommand(commandToken(line))`) and, when the **first** line is not a command, returns a new
`confirm-multiline` decision that emits
`[ui] line N looks like /<cmd>; a submitted message is sent as text — remove it or press Enter again` and keeps the
draft; a second Enter within 3 s submits.

*Edge cases.* (a) a draft whose first line **is** a command — unchanged, the whole line goes to `dispatchCommand`.
(b) `//` at column 0 — unchanged literal-slash path. (c) a pasted code block containing `/usr/bin` — `commandToken`
only matches registry names, no false positive. (d) a pasted markdown list with `/` lines — same. (e) the arm expires
→ the next Enter warns again; it never silently submits after a long pause. (f) reduced motion / SR: the hint is
static text and the warning is an ordinary `[ui]` item. (g) `--plain` has no composer and readline submits one line at
a time, so neither half applies. (h) the flat tier drops the hint with the other right-hand spans.

### 5.4 Mentions: the denylist that is dead code in the TUI, and `@decorator`

**P-C9 — wire the denylist into the TUI.** `isMentionDenied('.env')` is `true`, but `App.tsx:856`'s `dispatchCtx()`
never supplies `isDeniedPath`, so `routeSend` computes `droppedMentions = []` and **both** the denylist notice and
`/export`'s refusal are dead code in the TUI while they are live in `--plain`. Fix: `dispatchCtx()` merges the host's
`dispatchContext()` (contract 1.3 item 7 already declares it), keeping the App's own `run`/`step`/`changedSteps` as
the authority and taking `sessions` and `isDeniedPath` from the host.

*Edge cases.* (a) `bridge.host === null` for the first ~10 ms — `routeSubmit` returns `hold` in that window anyway.
(b) the host's `dispatchContext()` is called once per Enter and once per palette open, **never per keystroke** —
verify with `composer-latency`. (c) `--allow-secret-mention` is honoured where the notice is emitted, not in the
predicate. (d) a symlinked workspace: `isMentionDenied` is lexical and both sides are canonical. (e) **`/export .env`
in the TUI is now refused exactly as in `--plain` — a behaviour change** that needs its `[ui]` line, not a silent
refusal, and at least one test that assumed the TUI accepted it.

**P-C10 — a mention must look like a path, and an unresolvable one says so.** `mentionedPaths`
(`src/tui/composer/submit.ts:75`) turns `@decorator` inside a pasted code block into a mention (verified offline), and
`@nope/missing.py` is accepted silently because `readWorkspaceFile` returns `null` on any failure while the path is
still sent to Jev. Fix: (a) a token is a mention only when it contains `/` or `.`, **or** matches a candidate in the
workspace listing (`bridge.host.workspaceCandidates()`, already fetched for the mention picker); (b) a mention that
survives (a) but does not resolve produces one `[ui]` line
`@<path> — no such file in the workspace; it was not attached` **after** the `[you]` bubble.

*Edge cases.* (a) a file created after the listing was taken: the listing is a candidate **set**, not a gate — an
unknown token containing `/` or `.` stays a mention and the read decides. (b) `@README` with no dot or slash in a repo
that has `README` — the candidate check catches it. (c) `@my\ file.py` (escaped space) unchanged. (d) `@` alone is
already skipped. (e) `@../outside` → `isMentionDenied` → the P-C9 notice. (f) more than 5 mentions: `MENTIONS_MAX`
clips what goes to Jev and the notice says `+N more mentions were not attached`. (g) the mention picker's own
insertions always resolve. (h) the candidate listing is a **promise** — if it has not resolved, fall back to the
lexical rule; **never block Enter on I/O** (the first-frame and composer gates forbid it).

**P-C11 — notices follow the message they annotate.** The truncation notice and the mention notices are emitted
**after** the `[you]` bubble (today `App.tsx:905–906` emits them before, and PROBED `long20k` shows
`[ui] notice: only the first 12,000 characters …` nine rows above its bubble). Preferred form: pass `notice` and
`droppedMentions` to `host.submit` so the **controller** emits them right after `say('you', …)` — that fixes the
`--plain` ordering too. *Edge cases:* a steer's notices follow the steer bubble (§5.5); a submission that fails before
the bubble is unchanged; the secret gate already resolves before `send`; `--json` order follows emission.

### 5.5 `/new`, `/copy`, the steer bubble, and persistence

**P-C12 — a steer is a `[you]` turn too.** When a steer is accepted while a run is live, the controller emits the
`[you]` bubble for the typed text **in addition to** the engine's `steer:queued` item, so the conversation reads the
same whether or not a run is live. Today text typed during a run becomes `[step N] steer queued (1) for step N: …` and
never a bubble — the conversation surface changes language mid-session. *Edge cases:* a refused steer (`full` /
`finished`) gets no bubble, only the toast; `/steer <text>` typed as a command gets the same bubble; a withdrawn steer
keeps its bubble (the user did say it); a steer while `pausing` is the same; secrets are redacted by `bubbleLines` and
the spans were `addSecret`ed one line earlier; in `--plain` the bubble is an `annotate()` notice while live so it also
reaches `transcript.log`. **Identity: text** — a new item in `transcript.log`; pins in `test/pty/*` and
`round2-transcript.test.tsx`.

**P-C13 — `/copy last` copies the turn.** `App.tsx:1039` copies `s.items.at(-1)` — the **last line** of the reply, not
the turn — and the toast still says `✓ copied`. New: copy every contiguous item sharing the last item's chat label,
joined by newlines, **unclipped** (from the ledger when available, else the item rows); plus a new
`/copy conversation` that copies the whole ledger as `you: …` / `jevcode: …` blocks. *Edge cases:* the last item is
not a chat item → copy that one row, as today; an empty transcript → `nothing to copy`; the ledger already stores
redacted text; the OSC 52 fallbacks are unchanged; a 200-turn conversation is capped at the existing clipboard cap
with `copied (truncated to N KB)`; `/copy` is already refused in `--plain` (`plainSupports`), unchanged.

**P-C14 — `/new` actually starts a new conversation.** `session.ts`'s `case 'new'` resets the id, runs, title, undo
and the meter but **not** `ledger`: the old turns still go to Jev as `conversation` and still count in `/jev` and
`/cost`, and an in-flight chat is not aborted. New: `abortChat()`, a fresh `createChatLedger()`, `chatIntakes = []`,
`chatThresholdsSeen.clear()`, `deferredChatLines = []`, and **one divider item**
`[ui] new conversation — earlier turns are no longer sent to Jev`. *Edge cases:* `/new` while a run is live must be
refused or deferred upstream (verify `EXCLUSIVE_COMMANDS` and the `live()` guard); `/new` while **thinking** aborts
first so the in-flight reply cannot land in the new conversation (today it can — `converse` has no `exiting`-style
check between `runIntake` and `reply`); `/cost` and `/jev` read `ledger.stats()` and are fixed by the reset; the
scrollback keeps the old bubbles (it is append-only) and the divider is what makes the break legible; `--plain` prints
the same divider.

**P-C15 — persist the conversation; replay it on resume.** A conversation-only session is **never written to disk**:
`sessionId` stays `null` until a run, so `meterChat` pushes to `deferredChatLines` and drops them, and the ledger has
no I/O — `/resume` restores spend and never conversation. New: (a) mint the session id at the **first chat turn**;
(b) append one line per turn to `~/.jevcode/sessions/<id>/chat.jsonl` (`{t, role, text, kind?, p?, costUsd?}`,
redacted, ≤ 4 KiB per line, ≤ `LEDGER_MAX_TURNS` lines with the rewrite-slack scheme of `composer/history.ts:56–58`);
(c) `/resume` and `-c` rehydrate the ledger and replay the last **N = 20** turns into the scrollback as dimmed items
under one heading `[ui] resumed conversation — N of M earlier turns`.

*N = 20, not 6* (§14.1 row 10): 6 is what Jev sees (`LEDGER_RECENT`), 20 is what a human wants to re-read; the ledger
carries both numbers so the heading can state them.

*Edge cases.* (a) no write permission / `JEVCODE_NO_HISTORY`: reads still work, writes report through the same
`onWriteError` channel and **never throw** (the `history.ts` precedent). (b) two processes in one session: `O_APPEND`
line writes, as history. (c) a 20 MB chat file: a tail-read cap like `HISTORY_MAX_READ_BYTES`. (d) replay must not
re-charge the meter — the replayed items are dim and `seedMeterFromIndex` stays the only money path. (e) replay must
not enter `<Static>` before the first frame: replay **after** `setHost`, in one batch, so the first-frame gate is
untouched, and the store is opened **lazily** exactly as `history.ts` is. (f) secrets: the text is already redacted at
push time. (g) a resumed conversation whose workspace moved: the file is keyed by session id and records `workspace`,
so a mismatch degrades to "not restored" with a `[ui]` line. (h) `--plain` prints the same replay lines. (i) `/new`
starts a new file.

**P-C16 — clearing a draft says so, and a long draft survives it.** Ctrl-C ×1 clears the draft **silently** today, and
`HISTORY_MAX_ENTRY_BYTES = 4096` means a longer cleared draft is unrecoverable. New: (a) Ctrl-C ×1 and Esc ×2 on a
non-empty draft toast `draft cleared — ↑ restores it`; (b) the App keeps the last cleared draft verbatim in a
`useRef` — never React state, never a file — and `↑` on an empty draft offers it first. *Edge cases:* the in-memory
copy is the raw draft, which already lives in the composer buffer, is never written and is dropped on unmount, while
the **history** copy stays masked (`maskDraft`); only the last clear is kept; once consumed, normal history; the slot
does not survive `/new` or a workspace change; `--plain` uses readline's own line editing, unchanged.

### 5.6 The intake card

**P-C17.** Three changes. (a) An `ambiguous` reading leaves an **orphan** `[you]` bubble on Esc, so one logical
message shows twice; the bubble must stay where it is (the `intake-latency` gate requires it to commit **before** the
Jev request), so on `keep` the controller appends one marker `[ui] (message kept in the composer, not sent)`.
(b) The card's body gains the escape route it already honours **without losing the clause that explains the inert
Enter**. Enter on the intake card does nothing; `src/chat/lines.ts:11` says so today
(`(Esc keeps the text; Enter does nothing)`), and `src/tui/Overlay.tsx:34–36` documents that phrase as "the
statement that justifies the inert Enter" — the same statement §4.5 puts on all three of its confirm rows. Dropping
it would leave a user who presses Enter — the most natural key on a two-choice prompt — with silence and no
explanation anywhere on screen. So the body is a **`fitRung` ladder** (§2.6), dropping `Ctrl-C cancels` **before**
`Enter does nothing` (measured widths in brackets):

```
[91] [y] run it   [n] just chatting   (Esc keeps the text · Enter does nothing · Ctrl-C cancels)
[73] [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)     ← today's, unchanged
[47] [y] run it   [n] just chatting   (Esc keeps it)
[20] [y] run it  [n] chat
```

(c) A `/`-leading line typed while the card is up is handled as specified below — the mechanism matters, because
**the card collapses the composer**, so there is nowhere to type the rest of the line.

**(c), specified.** The intake is a `COLLAPSING` overlay (`src/tui/layout.ts`), so `App.tsx:2268` passes
`EMPTY_BUFFER` and there is no draft to accumulate `/exit` into. Two options were weighed; **round 4 takes (ii)**:
*(i)* the first `/` re-opens the composer with the card still drawn above it and Enter dispatches the line — this
needs a new layout state (card + live composer), a rule for what `y`/`n` mean once the composer is live, and a
`CAP` change, all for a keystroke the user can reach one Esc earlier; *(ii)* **the TUI keeps today's swallow, and
Esc is the documented escape route** — the card's body now names it, and the restored draft no longer absorbs the
slash because Esc restores the text verbatim and the next `/` opens the palette normally. **§5.7(b) keeps the
`--plain` half**, where readline hands the controller a whole line and dispatching it costs nothing. The measured
defect (`the date parsing/exit`) is closed by the body text plus §5.7(b), not by a new TUI state.

*Edge cases.* the three flat tiers of `src/chat/lines.ts` measure **95 / 70 / 39** cells today
(`INTAKE_ROW_WIDE:23` / `INTAKE_ROW_MEDIUM:24` / `INTAKE_ROW_NARROW:25`) and are **unchanged** — the wide row keeps
today's `INTAKE_CARD_BODY` and therefore its 95 cells, so `INTAKE_ROW_WIDE_COLUMNS = 100` still covers it, and only
the **boxed card's** body gains the 91-cell top rung (shown when the card's inner width allows, i.e. from 95
columns). *(An earlier draft claimed the substitution made the tiers "96 / 70 / 39"; the substituted strings measure
**92 / 70 / 39** — the wide row **shrinks** by three cells. The fit check had not been run: §14.2 "Review log"
item 18.)* The `--plain` readline twin (`INTAKE_READLINE_PROMPT`) gains the same words and dispatches `/`-lines then
re-prompts (§5.7 b); five invalid answers still `keep` (`READLINE_MAX_PROMPTS`); the SR numbered form gains no new
option (Ctrl-C is not a numbered choice); Ctrl-C while the card is up already means `keep` and the body now says so;
`chat/lines.test.ts` pins all four rung widths and the three flat tiers by measurement.

### 5.7 The `--plain` conversation twin

**P-C18.** (a) After every item the plain renderer re-writes the readline prompt (readline's `prompt(true)`
equivalent) so items never land **on** the prompt line — PROBED, the real pty capture shows
`> [sandbox] seatbelt …`. (b) A line beginning with `/` typed at the **intake** readline prompt is dispatched as a
command and the prompt is re-asked (today it is eaten as an invalid answer, so `/exit` is not a command there).
(c) `jevcode chat --plain` with **piped** stdin reads one line at a time through the same intake path instead of
slurping stdin as one task — today `printf 'hello there\nthanks\n/exit\n' | jevcode chat --mock --plain` starts a paid
run whose task is all three lines.

*Edge cases.* a pipe with no trailing newline still yields the last line; `--json` has no prompt; `CI` / `TERM=dumb`
never write the prompt so (a) is a no-op there; `--no-input` unchanged; EOF mid-conversation exits 0 with the
epilogue; a piped line that is a command is dispatched, matching the TTY; the one-shot `jevcode run "<task>"` path is
untouched. **(c) is a user-visible behaviour change** for scripts that pipe a task into `jevcode chat --plain`; they
should use `jevcode run --task-file -` or `jevcode run "<task>"`, and it goes in `CHANGELOG.md` and
`docs/COMMANDS.md`.

### 5.8 The screen reader hears the conversation

**P-C19.** `createNotifier` fires only for `review` / `run-end` / `budget` (`App.tsx:703–713`), so a `[jevcode]` turn
and the `thinking` transitions make no sound and are never announced. New, **in SR mode only**: (a) one BEL plus the
existing `osc9`/`osc99` notification when a `[jevcode]` turn commits while the composer is idle; (b) the
`thinking → null` transition appends one `<Static>` line `reply ready` when the reply is longer than one item;
(c) the `thinking` start appends `working…` **once**, not per frame.

*Edge cases.* notifications are off by default and on in SR mode — only the `<Static>` announcement is SR-gated, the
BEL follows the existing `notify` setting; a reply arriving while the user is typing gets no BEL (the run-end timer
precedent: cancelled by a keystroke); a one-line reply needs no extra line (the label + text is already a row a reader
will read); at most one announcement per turn; `--plain` in SR mode is already sequential stdout; **the announcement
must never contain the message text** (it would be read twice). **Identity:** the two lines are SR-only `<Static>`
rows, declared as SR-only decoration (the `SR_REVIEW_MENU` / `SR_REVIEW_PROMPT` precedent, `App.tsx:103–104`).

### 5.9 Frames

**F-C1. A three-line message — today (6 rows) vs round 4 (4 rows).** *(A side-by-side comparison, not a frame at a
geometry: the two columns are two separate 24×80 renderings printed next to each other, so the combined line width
is not a product row width and `polish-check.mjs` does not read it.)*

The label is on **every** row — full weight on the turn's first item, `dim` on the continuations (it is drawn here
in lower case to stand for the dim span; the text is byte-identical, `stripAnsi` sees `[you]` on all three rows).

```
today                                    round 4
                                         
    [you] hello there                        [you] hello there
                                                 [you] indented second line   ← dim label
    [you] indented second line                   [you] third                  ← dim label
                                         
    [you] third                          [jevcode] Hi. I'm ready when you are —
                                             [jevcode] describe a change you want
[jevcode] Hi. I'm ready when you are —
```

*(Captured product frames confirm the rule is already the code's: `docs/live/tui/round-2/auto-24x80.txt:238` and
`:242` are two consecutive `[jevcode]` items, each printing its own label.)*

**F-C2. A nine-line pasted code block, 30×100 — 17 rows today, 9 item rows plus the one leading spacer = 10 after P-C1 + P-C4 + P-C2** (the blank line the
author wrote survives as an item whose body is empty **and whose gutter still carries the dim `[you]` label**; the
code rows take the `code` role). Every row below has a label in cells 0–8; the continuations' labels are dim.

```

    [you] here is the code:
    [you] ╶──── python
    [you] def f(x):
    [you]     if x:
    [you]
    [you]         return 1
    [you]     return 0
    [you] ╶────
    [you] what do you think?

```

**Identity note.** Because the label is on every row, the §5.3 normaliser is unchanged for chat turns: a TUI row
strips its gutter and equals `formatTranscriptItem(item)` exactly as it does today. Dropping the label on
continuation rows (drawn that way in an earlier draft of these two frames) would have made
`          indented second line` fail to normalise to `[you] indented second line` and broken the line-identity gate
for **every** multi-line message — see §14.2 "Review log" item 28.

**F-C3. Enter while thinking, 24×80** (P-C7) — the status row carries the queue; the draft is already cleared.

```
╭─ jev+llm ──────────────────────────────────────────────────────────── ws-a3 ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ thinking · 1 queued           step 0/–  sess $0.00/10.00 ok         ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

---

## 6. File edits: the surface a user approves (D-Z; request 4)

JevCode has **no diff renderer on the review path**. Measured against `ec61170`, re-verified in the working tree:

| # | defect | evidence |
| --- | --- | --- |
| A6-1 | a `patch` proposal **never names a file** — title, `[step N]` row, `transcript.log`, `--plain`, `/copy proposal` all read `patch 18 line unified diff` | `plain.ts:165–168` |
| A6-2 | the `edit` preview is **not a diff**: `--- old` / blob / `+++ new` / blob, no signs, no line numbers, no context | `plain.ts:163`; capture `file-edit-review-edit-diff-24x80.cap` frame 23 |
| A6-3 | **no diff colour exists.** `ColorRole` (`theme.ts:69`) has no added/removed/hunk member; `Review.tsx:136,183` paints every preview row `dim`; `Transcript.tsx:216` gives detail rows no props at all | read |
| A6-4 | `/diff`'s header is truncated to `columns` **before** the `[ui] ` label is prepended, so `0 skipped)` is provably destroyed at 80 columns (the string never appears in the capture) **and** the row still wraps | `undo/diff.ts:286` |
| A6-5 | `/diff --all`, documented as lifting the 40-row cap, is silently re-capped at **60** by `clipDetail` | `registry.ts`; `plain.ts:111,182–187` |
| A6-6 | the post-apply row says `1 file` and nothing else; the one item that names files (`outcome`) is in `COMPACT_HIDDEN_KINDS` | `plain.ts:444–457`; `useEngine.tsx:64` |
| A6-8 | the card burns 6–7 of its 8 preview rows on `diff --git` / `index` / `---` / `+++` / `@@` plumbing; a multi-file patch shows only file 1 | unit probe |
| A6-9 | a `write` preview **always** ends with a blank row (content ends `\n` → a trailing `''`), inside a card documented as "never a blank row inside a granted preview" | `plain.ts:538`; `review/lines.ts:295` |
| A6-10 | `e` (expand) is a **silent no-op** when `previewWant ≤ CAP.preview`: captured frames 14→17 are byte-identical | `layout.ts:183`; `App.tsx` |
| A6-11 | `…[k more preview lines · e expands]` counts only post-`clipDetail` lines: on a 5 000-line patch it promises 61 and 4 939 can never be reached from the card | `review/lines.ts:291,296` |
| A6-12 | tabs survive into fixed-width card rows (`cellWidth` treats `\t` as 1 cell, the terminal expands to the next 8-stop), so the card's right `│` shifts and the box breaks; trailing whitespace and a BOM are invisible, so a whitespace-only change looks like no change | `plain.ts` `CONTROL_RE` keeps `\t` |
| A6-15 | round 3's D-L moves detail rows to column 10 while `/diff` is still built at full terminal width: **every row overflows by exactly 10 cells** | `session.ts:827`; `Transcript.tsx:48` |
| A6-17 | `diffBar` scales to the largest row, so when every file has the same churn every bar is a full 10 cells — pure noise | `undo/diff.ts:203–219` |
| A6-21 | `mockTrajectory` emits only `write`/`read`/`run`/`edit` — **no `patch` anywhere in `--mock`**, so the patch card, the patch title and the patch failure text have **zero** pty coverage and no TUI unit test | `cli/mock-trajectory.ts` |
| A6-22 | the card title cuts the goal without its closing quote (`"Create scratch_0.… ─╮`) | `review/lines.ts:133` |

**Two things that are correct and must not be broken:** CRLF/CR is normalised by `clipDetail` (`plain.ts:183`), and a
failing patch is **atomic** — `git apply --check` runs first and `--reject` is never used
(`src/workspace/patch.ts`), so "partial apply" and "rejected hunks" are states the product **cannot** enter. No
proposal here may render a reject UI or word a message that suggests a half-applied tree.

### 6.1 `editSummary(action)` — one function that names the files of every edit action

```ts
// src/tui/diff/summary.ts (new, pure)
export interface FileTouch { path: string; from: string | null; letter: 'M'|'A'|'D'|'R'|'B'; added: number; deleted: number }
export interface EditSummary { files: FileTouch[]; added: number; deleted: number; truncatedFiles: number }
export function editSummary(a: Action): EditSummary | null;          // null for read / run / done
export function editTargetText(s: EditSummary, cells: number, g: GlyphSet): string;
```

`patch` parses the diff headers with the **existing** parser shape of `src/workspace/patch.ts` (`parsePatchFiles`,
already pure — moved to a shared ink-free module; today's file pulls in `node:fs/promises` only for the apply half)
and counts `+`/`-` body lines per file; `new file mode` / `deleted file mode` / `rename from|to` / `GIT binary patch` /
`Binary files … differ` set the letter. `edit` runs `lineDiffCounts(old, new)` (`undo/diff.ts:395`). `write` is `A`
(or `M` when the engine already knows the file existed) with `added = lines(content)`.

`describeAction('patch')` then produces `calc/ops.py +12 −3, README.md +2 −0`, or at ≥ 3 files
`3 files +14 −3 (calc/ops.py, README.md, …)`; `('edit')` and `('write')` gain ` +a −b`.

*Edge cases.* (1) an unparseable header → fall back to today's `"<N> line unified diff"`. (2) `/dev/null` sides →
`A` / `D`. (3) a 100 %-similarity rename with no hunks → `+0 −0`, `R old → new`. (4) `copy from` → `A`. (5) a
mode-only change → `M +0 −0 (mode)`. (6) `GIT binary patch` → `B`, counts suppressed, size from the `literal <n>`
header when present. (7) 200 files → the first 3 named plus `(+197)`, while the whole `EditSummary` still carries them
for the card. (8) quoted/UTF-8 paths → the existing `unquote`. (9) a path with a `·` or a newline → `oneLine` + cell
truncation. (10) a GNU-diff timestamp tab after `+++ b/x` → the existing `headerPath` strips it. (11) `---`/`+++`
disagreeing with `diff --git` → prefer the `+++` side, which is what `git apply` uses. (12) a 5 000-line diff →
counting is O(lines), done **once per proposal**, memoised in a `WeakMap<Action, EditSummary>`. (13) an empty diff →
`null`, the caller keeps today's text.

### 6.2 `diffRows()` — the one diff renderer, and four colour roles

```ts
// src/tui/diff/rows.ts (new, pure)
export type DiffRowKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'more';
export interface DiffRow { kind: DiffRowKind; text: string; oldNo: number | null; newNo: number | null }
export function diffRows(diff: string, o: { columns: number; maxRows: number; g: GlyphSet; lineNumbers: boolean }): DiffRow[];
```

Row shape at ≥ 60 columns (`lineNumbers: true`): **two number columns, `old` and `new`, each blank where that side
has no line** — the form A6 drew and annotated ("← new number in the right column when the sides differ"). One
column would leave every added line unnumbered, which is worst in the commonest case the brief names: a `write`
preview or any pure addition would render 3 000 rows with a blank number cell and the reviewer could not tell
where in the file the change lands. `│` is `|` under `--ascii`:

```
 old  new
  12   12  │ def add(a, b):
  13       │-     return a - b
       13  │+     return a + b
```

**Column widths.** Each number column is `max(2, digits(maxLineNo))` cells, right-aligned, one space between them
and one before the `│`; the text column takes the rest. At `columns < 60` the **old** column drops (the new side is
the one a reader navigates to) and the row is ` 13 │+ <text>`; at `columns < 20` both drop and the row is
`+ <text>` (edge 12). `DiffRow` keeps both `oldNo` and `newNo`, and **both are placed** — an earlier draft's
single-column shape left `newNo` in the interface with nowhere to render it (§14.2 "Review log" item 36).

`meta` rows (`diff --git`, `index`, `mode`, `similarity`) are **collapsed by default** into a single `file` row
`calc/ops.py  +12 −3` (letter and rename arrow from §6.1) — that alone gives the review card back 4 of its 8 rows.

**Theme.** `src/tui/theme.ts` gains four roles: `added` (green / `greenBright`, marker `+`), `removed` (red /
`redBright`, marker `-`), `hunk` (`accent`, marker `@@`), `diffMeta` (`dim`, marker `···`). `daltonized` swaps
`removed` to blue; `ansi` keeps the 16-colour names; `light` darkens both. **Every role's marker is already in the
text**, so `NO_COLOR` / `--no-color` / `TERM=dumb` lose nothing — TD §14.1's "a marker beside every colour" is
satisfied for free. Each new role takes a row in `COLOR_ROLES` (`theme.ts:71`) and in the four theme tables, and the
round-3 contrast and 256-cube checks apply unchanged.

*Edge cases.* (1) a tab is expanded to the next **4**-cell stop **inside the row builder**, never emitted raw, so no
fixed-width box can break (A6-12). (2) trailing whitespace on an `add`/`del` row renders as `·` cells in `diffMeta`
**only when** the counterpart differs solely by whitespace (otherwise it is noise). (3) a BOM at the start of an added
line shows as `<BOM>` in `diffMeta`. (4) other `Cf` code points map to `·` — `sanitizeStream` does not cover
`U+200B`/`U+202E`. (5) a line longer than the row is cut with `…` plus a `(+N chars)` tail in `diffMeta` when there is
room — **never wrapped**. (6) CRLF is already normalised upstream. (7) a lone `\r` inside a line → `·`. (8)
`\ No newline at end of file` is a `meta` row kept verbatim (git's own text). (9) a hunk header with a section name
(`@@ … @@ def add(`) puts the section in `diffMeta` after the range. (10) a malformed hunk (`@@` without ranges) is
`meta`, numbering suspends for that hunk, and nothing throws. (11) line numbers past 99 999 widen **both** number columns
and shrink the text column; the row never overflows. (12) `columns < 20` drops the numbers and the separator: sign,
one space, text. (13) a line inside a hunk body that itself starts with `diff --git` (a diff of a diff) — the body
sign (` `/`+`/`-`) is consumed **first**, so it is never mistaken for a header. (14) an empty diff → `[]`.
(15) `maxRows` reached → a final `more` row (§6.3 gives it its text).

### 6.3 The review card for a file edit

`reviewCardLines` (`src/tui/review/lines.ts:143–161`) gains a preview built by `diffRows`, in this order:

1. when the action touches **≥ 2 files**, a summary block first — one row per file, capped at 5 plus
   `  … +N more files`: `  M calc/ops.py   +12 −3` / `  A README.md     +2 −0` / `  R old.py → new.py  +0 −0`;
2. then the hunks of the **first** file, `lineNumbers` on, meta rows collapsed;
3. a tail row that tells the truth about `e`: **`…[+N rows · e expands to M]`** — `N` the rows hidden at this
   budget, `M` the rows `e` would grant. **There is no `/diff <n>` pointer on a pending card.** Two reasons, both
   fatal: the review overlay **swallows printable keys** (§2.7 edge 6), so `/diff 4` cannot be typed while the card
   is up — the user would have to decline first, which defeats the purpose; and at review time step 4 is
   *pre*-apply, so `/diff 4` has **no checkpoint image** and would be a dead command, which §6.6 edge 6 forbids
   ("conditional on checkpoint images existing for that step … so it is never a dead command"). The `/diff <n>`
   pointer lives where it is already conditioned correctly: the **post-apply** `[step N]` row (§6.6) and `/why`.

`previewWant` (`Review.tsx`) becomes `diffRows(...).length`, which for an `edit` drops from `old + new + 2` (a 200-line
edit asks the layout for **402** rows today) to the real hunk size. The title uses §6.1's target and **closes its
quote before truncating** (`"<goal…>"`, not `"<goal…`).

*Edge cases.* (1) a 200-file patch: the summary caps at 5 + `… +195 more files`, the hunk block shows file 1, the tail
names `/diff`. (2) a 5 000-line patch: `clipDetail`'s 60-line clip is **bypassed for the card** — the card builds from
the `Action` directly, not from the clipped detail — so the tail's `M` is the true total (closes A6-11). (3) a `write`
of a 3 000-line file is `A +3000 −0`, the preview shows the first `maxRows` lines with `+` signs and **no trailing
blank row** (closes A6-9 by dropping a single trailing `''`). (4) `e` with nothing more to show: today a silent
no-op → a toast `nothing more to expand — /diff <n> after the step`, and **no re-render**. (5) rows ≤ 8: the existing
card ladder is unchanged, the preview is simply 0 rows. (6) the 12×60 flat tier uses `reviewHeaderLines` with the same
builder at the flat width. (7) a binary file → one row `B assets/logo.png  binary (4.1 KiB → 5.0 KiB)`, never bytes.
(8) a file on the secret denylist (`isSecretPath`) → the row shows the path and `content withheld (secret path)`,
never a line of it. (9) a `d` note replaces row 1 and leaves the preview untouched. (10) declined/aborted mid-draw is
unchanged — the card is pure.

**Identity.** The card is a dynamic-region overlay and appears in no `transcript.log`. The only text that changes is
the **preview tail** (card-only) and the **title's target** (§6.1's, classified TEXT there). The `--plain` twin — the
readline confirmer's `printRequest` (`plain.ts:680–687`) — must render the **same** rows through the same builder
(indent 2, no colour); that is the declared normaliser for this surface and needs its `plain.test.ts` pin.

### 6.4 `<Static>` detail rows get structure

`TranscriptItem` gains `detailKind?: 'diff' | 'table' | 'text'` (optional, default `'text'` — a default-preserving
widening, so **no producer must change**). When it is `'diff'` the rows route through `diffRows` and take §6.2's
roles; otherwise today's behaviour is kept exactly. `itemsFromEvent('proposal')` sets it for `edit`/`write`/`patch`;
`block()` sets it for `/diff`.

*Edge cases.* (1) round 3's D-L indents detail rows to column 10, so the diff rows are built at
`blockWidth(columns)`. (2) `--plain` / `--json` / `transcript.log` ignore `detailKind` entirely (detail is already
dropped there). (3) an item whose `detail` is not a diff but starts with `---` → **only the declared kind routes,
never a sniff**. (4) `NO_COLOR` → the signs carry it. (5) `--ascii` → `glyphTwin` already applies to detail rows and
the row builder emits ASCII-safe separators. (6) the 20 000-item soft cap and the epoch remount are untouched; rows
are computed at append time and memoised per item key, so a remount costs one rebuild per item, bounded by the cap.

### 6.5 `/diff` as a real block

1. `diffStatBlock(input, columns)` takes `columns` meaning the **body** width; `session.ts` passes
   `blockWidth(columns())` (closes A6-15).
2. It **stops truncating `lines[0]`**. The header is produced **short** — `diff · run <id8> · N files · +a −b`
   (≤ 52 cells) with zero-valued clauses dropped; the non-zero ones (`c untracked`, `d binary`, `e skipped`) move to
   their own `meta` rows at the bottom of the block (closes A6-4 and A6-18 and satisfies TD3 rule 8's ≤ 60-cell heads).
3. `block()` gains `maxDetailLines?: number` which `note`/`localItem` honour instead of the fixed
   `TRANSCRIPT_DETAIL_MAX_LINES = 60`: `/diff` passes `DIFF_ROW_CAP + 8` normally and `Infinity` with `--all`, bounded
   only by `TRANSCRIPT_DETAIL_MAX_CHARS` raised to 200 000 for diff blocks (closes A6-5).
4. `diffBar` returns `''` when every row's total is equal (closes A6-17).
5. `/diff <step>` keeps its **git-shaped text** (so `/copy diff` and `--full` stay pasteable) and the TUI routes it
   through `detailKind: 'diff'` for colour only.
6. `--plain`: `block()`'s else-branch writes the head and **every body row** as `[ui] <row>` items through
   `Renderer.blockLines(lines)` (§3.5) — the same prefix on every row, unchanged from today. A6-16 is closed by
   item 1 of this list, not by dropping the prefix: once the body is built at `blockWidth(columns)` the 5-cell
   prefix no longer pushes a row past the terminal, and the block's own columns were never misaligned relative to
   each other (the prefix is uniform). §3.5 item 1 records why the bare-line variant is rejected.

*Edge cases.* (1) 0 files → `diff · run <id8> · no changes`. (2) an unborn repo → the existing `EMPTY_TREE_OID` path.
(3) not a git repo → today's `uiError`, unchanged. (4) `columns < 30` → the bar and the padded counts are already
dropped, now measured against the **body** width. (5) 2 000 changed files with `--all` → bounded by
`TRANSCRIPT_DETAIL_MAX_CHARS` and the 20 000-item cap, with a final
`… rendering stopped at N rows (/diff --full)`. (6) a path containing `†` → the dirty mark is appended **after**
truncation and `truncateLeftCells` already reserves its cell. (7) a submodule is `S` today; a symlink gets `L` and
`→ <target>` when `lstat` says so. (8) a non-UTF-8 file → `--no-index` numstat returns `-\t-` → `B`, never bytes.
(9) `/diff` while a run is live is already allowed; the block reflects the tree at that instant and the head gains
` (run live)`. (10) generated/vendored sorting is **out of scope** — `.gitattributes` is not free today (§14.1 row 11).

### 6.6 The post-apply row names the files and offers `/diff <n>`

`stepOutcomeText` (`plain.ts:444–457`) returns `"<n> file(s)"`. Round 4: for an outcome with `changedFiles`, the
**`outcome` item** reads `edited 3 files: calc/ops.py +12 −3, calc/io.py +4 −1, README.md +2 −0` (3 names plus
`(+N)`), and the visible `[step N]` row's outcome segment becomes `3 files +18 −4`, with a trailing ` · /diff <N>`
hint **only when** the step changed files and the terminal has room — it is the last segment, so TD3 rule 3 drops it
first. Counts come from §6.1's `editSummary` on the **proposal's** action, which is already in `StepRecord.proposal`:
no new engine field, no extra I/O.

*Edge cases.* (1) a `run` that changed files has no counts → `3 files`. (2) a patch whose `changedFiles` disagrees
with the header parse (a rename git resolved differently) → prefer `changedFiles` for names, `editSummary` for counts,
and **drop the counts** when the name sets differ. (3) 200 files → `200 files +9k −3k`. (4)
`declined`/`blocked`/`failed` are unchanged. (5) a failed patch → §6.7. (6) the `/diff <N>` hint is **conditional** on
checkpoint images existing for that step (the engine already knows through `StepRecord`), so it is never a dead
command.

### 6.7 A patch that does not apply gets a readable failure

`gitFirstError` keeps only the **first** `error:` line of git's stderr, and the full stderr held in `PatchError`'s
second argument is dropped at `src/loop/engine.ts` (`error: this.redact(err.message)`). git's diagnosis is normally
two lines (`error: patch failed: f:12` *and* `error: f: patch does not apply`); the second is lost.

`PatchError` gains a typed `hunks: { file: string; line: number | null; message: string }[]` parsed from git's
`error: patch failed: <file>:<line>` / `error: <file>: <message>` pairs; the engine puts the first **two** messages
into `outcome.error` and the whole list into the event's `detail`; the TUI renders it as a `detailKind: 'text'` block:

```
 [step 4] patch failed: calc/ops.py:12 — patch does not apply
          calc/ops.py:12   context did not match (the file changed after the
                           proposal was made)
          hint: /diff 3 shows what step 3 wrote to calc/ops.py
```

*Edge cases.* (1) the user edited the file meanwhile → the hint names the last step that wrote the same path (the
engine has `StepRecord.outcome.changedFiles`), or says `the file changed outside JevCode` when no step did.
(2) sandbox denial → `sandbox denied git apply (exit 71)` and the sandbox item, **never** a patch diagnosis.
(3) permission denied / (4) file vanished → git's own message with the path. (5) a path escape or a secret path →
`PathEscapeError` before git runs; the message names the path only. (6) a diff over `MAX_PATCH_BYTES` → today's
`diff exceeds 4194304 bytes`. (7) an empty diff → today's `empty diff`. (8) git's stderr locale is already pinned
(`GIT_ENV` sets `LC_ALL: 'C'`, `src/workspace/git.ts`), so the parse is stable and needs no change. (9) **partial
apply is impossible** — the wording must never suggest a half-applied tree. (10) 200 failing hunks → the first 3 rows
plus `… +197 more`.

### 6.8 `/undo` and `/rewind`

`undoSummaryLine` (`src/undo/plan.ts:315–323`) is one unbounded line
(`undo step N: restored 3 files (a, b, c), skipped 1 (d: reason)`) that wraps into a paragraph with no structure.
Round 4 makes it a block: head `undo · step 4 · 3 restored, 1 skipped`, then kv rows `restored` (the file list,
`LIST_MAX` + `(+N)`) and `skipped` (`d — <reason>`), through `renderBlock`. `rewindPickerRows` keeps its picker rows
but takes `blockWidth` for its **fallback block** (no prompter). *Edge cases:* nothing restored → the §3.1.7 sentence;
a skipped file whose reason is a path → `shortPath`; `--plain` prints the same rows through `blockLines`.

### 6.9 Make the patch path reachable in `--mock`, and pin it

`mockTrajectory` (`src/cli/mock-trajectory.ts`) gains a fifth turn kind — a `patch` that edits two files at once — and
a sixth that is deliberately unappliable, both **off by default behind `JEVCODE_MOCK_PATCH=1`** so every existing pty
smoke and perf number is byte-unchanged. `docs/TUI.md` and `src/perf/states.ts` list the new `review-patch` state.

*Edge cases.* (1) the default trajectory must stay identical — asserted by a unit test that `mockTrajectory(40)` with
the env unset equals a golden array. (2) the patch must apply inside `examples/demo-py` **and** in the scratch files
the trajectory itself created, so no external fixture is needed. (3) the unappliable patch must fail at `--check`,
leaving the tree clean — asserted with `git status` after the run.

### 6.10 Screen-reader and `--plain` twins of the change

`reviewScreenReaderLines` (`review/lines.ts:278–288`) omits the preview **entirely** — an SR user is never read a
single line of the change they are approving. Round 4 inserts, between the aria rows and the choices:

```
change: 3 files, 18 lines added, 4 removed
file 1 of 3, calc slash ops dot py, modified, 12 added, 3 removed
line 13 removed: return a minus b
line 13 added: return a plus b
… 14 more changed lines; press 3 then diff for the full text
```

Signs are spoken as words, paths with `slash` / `dot`, the row count bounded by `SR_DIFF_ROWS = 12` with the tail
sentence. The readline confirmer's `printRequest` renders the **same** `diffRows` output (indent 2, signs, no colour,
no line-number column below 60 columns) with the same truthful tail as §6.3.

*Edge cases.* `--screen-reader` + `--ascii` → ASCII separators; a binary file →
`binary file, 4.1 kibibytes before, 5.0 kibibytes after`; a 200-file patch → the summary sentence plus file 1; a
whitespace-only change → `line 13 changed: trailing whitespace removed` rather than two identical spoken lines; a
`read`/`run` proposal → today's output byte-for-byte. A pinned assertion: with `GLYPHS.sr` no bar and no box glyph
appears.

### 6.11 Frames

**F-E1. The review card for a two-file patch, 24×80** (compare the measured card, where 6 of 8 preview rows were
`diff --git` / `index` / `---` / `+++` / `@@` plumbing and the second file was invisible).

```
╭─ review · step 4 · risk 0.50 (exp) · patch 2 files +14 −3 "fix the off-by…" ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension        lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level        │
│ 1 destructive    L2  █████·····  0.50 exp  1.00  loses untracked pre-existi… │
│ 5 matches_intent     █████████·  0.90 noul 0.80~ the action is an instance … │
│   M calc/ops.py    +12 −3                                                    │
│   A README.md       +2 −0                                                    │
│   ╶──── calc/ops.py                                                          │
│   old  new                                                                   │
│    12   12  │ def add(a, b):                                                 │
│    13       │-     return a - b                                              │
│         13  │+     return a + b                                              │
│   …[+9 rows · e expands to 18]                                               │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-E2. The post-apply step row, 24×80** (compare `[step 1] write scratch_0.py "…" · risk 0.50 [review] · 1 file ·
judge 0.90 · 3.2s · $0.0002`, which never names the file).

```
 [step 1] write scratch_0.py "Create scratch_0.py" · risk 0.50 [review] ·
          1 file +3 −0 · judge 0.90 · 3.2s · $0.0002 · /diff 1
```

---

## 7. Production hardening (D-AA; request 3)

The bones are strong and must not be disturbed: `fatalExit`'s ordering is correct and every step individually guarded
(`src/cli/fatal.ts:121–169`); SIGTERM/SIGHUP/SIGINT give 143/129/130 with raw mode restored and **exactly one
`RESTORE` per exit in all 33 pty runs**; zero clears after the first frame at every geometry; the log's
strip-then-redact-then-clip order is right (`src/core/log.ts:166–173`); the Node < 22.12 guard and the git-absent
message are the standard the rest of this section aims at; and no collection leaks (RSS 138.7 MB peak → 117.2 MB after
1 200 mock steps). Every unbounded collection in the TUI is already capped.

### 7.1 P-D1 — latch `guard()` per pane (the only defect that can hang the product)

`guard(pane, fn, fallback)` (`App.tsx:1962–1978`) catches a throw, pushes a `PaneFailure`, and the dep-less effect at
`:1979–1982` calls `onPaneFail`, which dispatches a `local` item — appending to `<Static>` and re-rendering. On the
next render **the same builder throws again**. Unlike `PaneBoundary`, which latches in `getDerivedStateFromError`
(`PaneBoundary.tsx:87–89`) and never re-renders the failing child, `guard()` re-executes `fn` on **every** render. A
*persistent* cause — an unpaired surrogate reaching `stringWidth`, a `NaN` in a row count, a malformed `RetryCause` in
`retryLiveLines`, an `Intl.Segmenter` throw on an exotic locale — therefore gives throw → dispatch → render → throw,
forever, one `<Static>` item per iteration. Because a committed `<Static>` subtree takes Ink's **immediate** path
(TD §18) this is one unthrottled frame per iteration: the terminal floods, the event loop is pegged, no key is read,
and the only escape is `kill -9`. `RENDER_FAULTS_FIRED` latches only the **injected** fault (`:1964`), which is
exactly why this has never been seen.

Fix: a `failedPanes = useRef<Map<string, { name: string; count: number; at: number }>>` beside `renderFaults`;
`guard` returns `fallback` **without calling `fn`** while the pane is latched; on a throw the pane is latched and one
`PaneFailure` is queued; the latch clears on the same `resetKey` the React boundaries already use, plus the next
`run:start` and a new **`/ui reset`** action — spec
`{ name: 'ui', category: 'ui', usage: '/ui reset', args: [{ name: 'action', kind: 'setting', values: ['reset'] }], available: 'always' }`
in `registry.ts` (§9.2 routes it to S4), which clears every pane latch and answers
`ui reset — <n> panes unlatched` (or `nothing was latched`); `--plain` twin, `dispatch.test.ts` case, §12 entry, and
one of the 41 `round4-identity.test.ts` covers; `onPaneFail` becomes idempotent per `(pane, error.name)` — the first failure
appends the `[ui]` item, a repeat within the same latch only increments a counter and logs at `debug`, and the unlatch
appends `ui: <pane> pane recovered` at `info`. The `renderFaults` effect first filters out pairs already reported
under the current latch, so it can never dispatch on a render it caused.

*Edge cases.* (1) two panes throwing in the same render → two items, two latches, **one** commit. (2) a throw inside
`onPaneFail` itself (a broken `log`) → the body is wrapped in try/catch and the latch still holds. (3) a throw in the
`overlay` builder while a review is pending → the existing decline (`App.tsx:1950–1953`) must run **exactly once** per
pending id. (4) the latch must not survive an unmount/remount — it is a ref, so it does not. (5) **`resetKey` churn:**
the transcript boundary's `resetKey` is `visible.length` (`App.tsx:2159`), which changes on every item, so a
length-keyed latch would clear immediately and re-loop — the transcript latch keys on the **epoch**, and every retry
is rate-limited to **one attempt per 5 s per pane**. (6) reduced motion / SR: the recovery line is an ordinary `[ui]`
item. (7) `--plain` has no builders.

*Decision (A7 open question 1, §14.1 row 12):* **no auto-retry timer.** A timer risks re-entering the loop at 1/5 Hz;
the explicit `resetKey` / `run:start` / `/ui reset` unlatch plus the 5 s rate limit is the bounded form.

### 7.2 P-D2 — a failing checkpoint write degrades loudly, and the epilogue never lies

Measured twice: with `$JEVCODE_HOME/runs` removed (or `chmod 500`) 0.9 s into a 40-step run, the run reports
`[run] end complete steps=40 … exit 0`, **no** `checkpoint degraded` item appears, and stderr prints `files`,
`resume` and `report` rows for a directory that does not exist. Every mechanism is present and unused: the degraded
classifier (`src/checkpoint/store.ts:56–117`, `checkpoint degraded: <code> on <file>`), the degraded exit code 3
(`src/cli/epilogue.ts`, via `exitCodeFor`), and the `resumable` flag the `resume` row is gated on
(`epilogue.ts:25,79`).

1. Every write path of the store routes its existing classification to a new `onDegrade(info)` callback instead of
   only throwing; the engine emits `checkpoint:degraded` **once per `key`** (`<file>:<code>`), which the TUI already
   renders.
2. `degraded` is set from the first such event, so `exitCodeFor(reason, result, degraded, signal)` returns **3**.
3. `resumable` is computed from a **post-write `stat`** of `state.json`, not from the intent to write it:
   `resumable: statSync(join(runDir, 'state.json')).size > 0` inside a try/catch, passed by the caller.
4. The `files` row lists only files that **exist** — `(transcript.log, jevcode.log)` when `state.json` is absent — and
   the whole row is replaced when the directory is gone:
   `files      <dir> — gone (the run directory was removed or became unwritable during the run)`.

*Edge cases.* (1) the dir is deleted and re-created between two writes → the dedupe key is `<file>:<code>`, so a
different code degrades again. (2) **`EROFS` must be added** to `DEGRADED_CODES` beside ENOSPC/EACCES/ENOENT. (3) the
run completes successfully but the last write failed → the stop reason stays `complete` and the exit code becomes
**3**. (4) a degraded checkpoint **inside a session run**: the item appears, the composer reopens, later runs try
again — and the **process** exit code is the last run's (§14.1 row 13). (5) `--plain` and `--json` carry the same
`checkpoint:degraded` event. (6) the notice never prints the raw `open '<path>'` suffix:
`checkpoint degraded: EACCES on state.json — the run directory is not writable; this run cannot be resumed`.
(7) a read-only **parent** (the `$HOME` case of §7.4) takes the same path and must produce this item, not an
`[ui] error:`.

### 7.3 P-D3 — close the render-boundary holes

| # | hole | fix |
| --- | --- | --- |
| 1 | `App.tsx:2159` is the **only** `PaneBoundary` without `fault={fault}` and `log={logName}`, so `JEVCODE_FAULT=render:transcript` is a no-op (measured) and, if it does catch, its notice names `jevcode.log` instead of the real path | add both props |
| 2 | the wordmark branch (`App.tsx:2186–2192`) renders `mark.spans(loop.band)` and `<SplashRow>` **bare** — round 3 made it the idle tenant, i.e. the thing on screen for most of a session | `<PaneBoundary pane="wordmark" … resetKey={state.runId ?? ''}>` + `guard('wordmark', …, [])`; the fallback is **blank rows of the same height**, not a notice row (§1.2 P-H3) |
| 3 | `RuleRow`, the banner row and the queue rows are unprotected the same way (lower risk: pre-built strings) | boundaries named `rule`, `banner`, `queue`, each falling back to empty rows **of the same height** |
| 4 | the status line has a boundary **only when `layout.chrome === 0`** (`App.tsx:2272`); in the default boxed tier it is a `status={…}` prop of `<Console>` **inside the composer boundary**, so a `StatusLine` throw at 24×80 degrades the whole console (measured: the box disappears for the rest of the run) | `<Console status={<PaneBoundary pane="status" …><StatusLine …/></PaneBoundary>}>` — one row degrades, not the box |
| 5 | the composer's boxed fallback drops to bare rows | **keep the box**: render the same `╭─ … ─╮ │ › <draft> │ ├─┤ │ <status> │ ╰─╯` frame from the pure line builders, with only the interactive composer replaced by the masked one-line draft. This is "does not look weird" applied to the degraded state |
| 6 | `render:live` and `render:pane` never fire at 24×80 even during a 12-step run, because those slots stay closed with the shipped `--mock` trajectory — so `states.ts`'s two fault scenarios measure the **unfaulted** frame | drive them from a state where the slot is **open**: `--mock-steps 30` with the panel forced open and `JEVCODE_MOCK_REVIEW_AT=2`, and assert the notice is present |

*Edge cases.* (1) a fallback of "empty rows" must consume **exactly** `layout.<slot>` rows or the budget breaks —
assert `dynamicRegion(frame).length ≤ rows − 2` in every fault scenario. (2) nesting a boundary inside `<Console>`
must not re-order Ink's layout — measure the frame count before and after. (3) the wordmark boundary's `resetKey` must
**not** be the sweep frame counter, or it unlatches 4×/s. (4) `staticOnly` must not mount boundaries for slots it does
not render. (5) under a screen reader the fallbacks still emit their twins. (6) `--ascii` fallbacks use the ascii
glyph set. (7) `<PaneBoundary>` now wraps the rule and the wordmark that are present in **frame 1**, so first frame
< 300 ms and composer p95 < 16 ms are **re-measured**, not assumed (class components are cheap; the gate is the check).

### 7.4 P-D4 — `explainFsError`: errors that name the fix

A read-only `$HOME` gives `[ui] error: EACCES: permission denied, mkdir '<home>/runs'` on **stdout**, an empty stderr,
no epilogue and exit **1**. The codebase already contains the target standard twice —
`limits.maxSteps: "lots" (from file:<path>) is not an integer >= 1 (consulted: …)` and
`git none · git not found on PATH: /undo and /diff use step pre-images only` — both of which name the value, the
source, the constraint and the consequence.

`explainFsError(e, ctx): { line: string; fix: string[] }`, pure, in `src/errors.ts` (already in the eager bundle):

| condition | line | fix |
| --- | --- | --- |
| EACCES / EROFS mkdir on the runs dir | `cannot create the runs directory <dir>: permission denied` | `set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>` |
| ENOSPC under the run dir | `the disk holding <dir> is full` | `free space, or pass --runs-dir <dir> on another volume` |
| ENOENT on the run dir mid-run | `the run directory <dir> disappeared during the run` | `this run cannot be resumed; the transcript above is complete` |
| EACCES on the config file | `cannot read <path>: permission denied` | `chmod u+r <path>, or pass --config <path>` |
| EMFILE / ENFILE | `too many open files` | `raise the file-descriptor limit (ulimit -n)` |
| provider ETIMEDOUT / ENOTFOUND | already good (`src/tui/retry.ts:44–70` `retryCauseText`) | — |

Every launch-time failure routes through `fatalExit` so it gets the terminal restore, **stderr**, the epilogue and a
correct code (**2** for a configuration/permission problem, not 1). The `[ui] error: <raw errno>` fallback stays only
for genuinely unclassified errors, and then carries the full `describe(e)` plus `run with JEVCODE_DEBUG=1 for the
stack`.

*Edge cases.* (1) the path must pass `redact` **and** `terminalSafeLine` — a path can contain a token. (2) `~`
abbreviation through `shortPath` (§3.4). (3) a Windows errno must default gracefully (macOS/Linux only). (4) the fix
block is **at most 2 lines** so it fits the flat tier. (5) in `--json` the fix becomes a `fix: string[]` field, not
prose. (6) the same explanation must be reachable from the blocking pane (`src/tui/blocking/lines.ts`) so §7.2's
degraded pane shows it. (7) first frame < 300 ms must be measured before and after (`--perf-exit-after-first-frame`).

### 7.5 P-D5 — `jevcode config` validates

Measured: `{"generator":{"model":123,"temperature":"hot"},"ui":{"fps":-5,"theme":"nope"},"notASetting":1}` produces
**zero** bytes on stderr and a table of defaults; the one value that survives verbatim, `limits.maxSteps: "lots"`,
prints as a normal row and is only rejected later, at run start. `jevcode config` is the command a user reaches for
when something is wrong, and it is the one command that will not tell them their config is broken.

1. `resolveConfig` records per entry a
   `problem: { kind: 'unknown-key' | 'wrong-type' | 'out-of-range'; expected: string } | null`, filled where the file
   layer already discards the value.
2. `configTableLines` renders it as a row suffix `✗ expected an integer ≥ 1` (ascii `x expected …`, F-B3), and such a
   row is **never folded** (§3.3).
3. `--json` gains the same `problem` field per entry.
4. Unknown file keys become one warning row naming each with the nearest valid setting
   (`notASetting is not a setting (did you mean maxSteps?)`) through the palette's `rank`.
5. At session start the same problems are emitted **once** as `[setup]` items, so the TUI user sees them without
   running `config`.

**Exit code (A7 open question 5, §14.1 row 14): exit 2 for a `wrong-type` or `out-of-range` problem** — these will fail
the next run, so the command that reports them should fail too — and **exit 0 for an `unknown-key`**, which is a
warning row. *Edge cases:* a bad **flag** value already fails at parse — do not double-report; an env var names the
**variable**, not the file; a value that is valid but dangerous (`ui.fps: 240`) is clamped with a `⚠` row, not `✗`;
`--json` stays a single document (problems go in the entries, never on stderr); secrets are still masked in problem
rows; an unknown key beyond the fuzzy threshold gets **no** suggestion rather than a wrong one; the `[setup]` items
are emitted **after** `firstFrame()` resolves, which must be asserted because the problem list is computed inside
`resolveConfig`.

### 7.6 P-D6 — session-index health and a bounded fold

`jevcode sessions` over an index containing garbage, NUL bytes and an over-length line prints `no session in <ws>
yet` — identical to a fresh install — and the repair path (`jevcode sessions reindex`) is never suggested. The fold
also reads the whole file: 51 MB / 200 k lines took **581 ms**, once per session open, on the post-first-frame path.

1. `foldIndex` counts `skipped` lines by reason (`not-json`, `bad-shape`, `over-length`, `unknown-kind`).
2. `jevcode sessions` prints `<n> index lines were unreadable and skipped — run jevcode sessions reindex` when
   `skipped > 0`, and the picker shows the same as a one-row footer.
3. `readIndex` **streams** and stops after `INDEX_FOLD_MAX_BYTES = 8 MiB` read **from the end** (the index is
   append-only and time-ordered, so the tail is what the picker needs); older history stays on disk and is reachable
   through `reindex`.
4. On session open, an index over 8 MiB emits one `[ui]` notice offering `jevcode sessions prune`.

*Edge cases.* (1) a tail read must not start mid-line — scan forward to the first `\n`. (2) a single line longer than
the window is skipped and counted. (3) an index with only `rename`/`budget` lines for a session whose `run:start` is
outside the window → the session is shown with the fields it has, never a crash. (4) a concurrent `O_APPEND` write →
a torn last line is skipped and counted, never fatal. (5) an empty or absent index prints nothing. (6) the gate: the
581 ms fold must drop below **100 ms** at 200 k lines.

### 7.7 P-D7 — the support bundle a TUI bug actually needs

The measured bundle is 7 files with a 111-byte `versions.txt`. It omits `state.json` (which the epilogue calls the
important file), `jevcode.log.1` (the rotated half — after a rotation the bundle keeps only the newest 8 MiB and
**loses the crash**), `decisions.jsonl`, the effective `keybindings.json` and the resolved launch tier; `versions.txt`
carries `TERM`/`TERM_PROGRAM`/`rows×cols` but **not** `LANG`/`LC_ALL`/`TZ`, `COLORTERM`, `NO_COLOR`,
`SSH_TTY`/`TMUX`/`STY`, `stdout.isTTY`, or the resolved chrome tier / fps / reduced-motion / screen-reader / `--ascii`
/ `--plain` / theme — i.e. every variable that decides which of round 3's frames the user was looking at. And `put()`
does `redact(await readFile(whole file))`, so a multi-hour `transcript.log` of hundreds of MB is read into one string
and regex-redacted at exactly the moment the user is filing a bug.

1. Copy `state.json`, `jevcode.log.1`, `decisions.jsonl` (tail 200) and `keybindings.json` when present.
2. Cap every copied file at `REPORT_FILE_MAX = 2 MiB` **head + 2 MiB tail** with a
   `… <n> bytes elided (original <m> bytes) …` marker between them, streamed **line by line** through `redact`.
3. `versions.txt` gains the env list above (presence booleans for `SSH_TTY`/`TMUX`/`STY`, never values) plus a
   `launch` block with the resolved tier, fps, `renderMode`, `renderer`, `ascii`, `screenReader`, `reducedMotion`,
   `plain` and `theme` — recorded in `run.json` at run start so `report` can read it offline.
4. Write `README.txt` **first** with a `(bundle incomplete)` marker and rewrite it last, so a mid-way failure leaves a
   self-describing directory.
5. Print the total size and a one-line `tar -czf <id>.tgz -C <parent> <id>` suggestion.
6. **Drop the marketing tagline from the error path** of `commandReport` (`jevcode report <bad-id>` prints
   `JevCode: Jev decides, Claude writes.` after the error today).

*Edge cases.* a file exactly at the cap gets no marker; `--include-requests`' `jev.jsonl` takes the same cap and
redactor; an existing `out` is overwritten file by file, never deleted; ENOSPC leaves `(bundle incomplete)` and exits
3 with §7.4's explanation; a run dir on a stalled network mount bounds each read at 10 s and lists it under
`not available`.

### 7.8 P-D8 — a submission watchdog and a guaranteed second-Ctrl-C exit

`submittingRef.current` is set at `App.tsx:961` and cleared only in the `.finally()` at `:975`. The Ctrl-C path is
sound for a *thinking chat request* (measured: `⠋ thinking` → `! stopped thinking` → `idle`, exit 0 via `/exit`). The
residual risk is the window in which `run: 'starting'` is set by the App but the controller has **not yet** set
`thinkingPhase` and no engine exists: `host.abort()` falls through all three branches and returns having done nothing,
while `abortRun()` (`App.tsx:680–684`) has already dispatched `run:aborting` **unconditionally** — and the `.finally()`
only restores idle when the state is still `'starting'`, not `'aborting'`. The state is then stuck and the next Ctrl-C
maps to `EXIT_NOW_130`, which calls the same no-op `host.abort`.

1. `host.abort()` returns `{ acted: boolean }`; `abortRun()` dispatches `run:aborting` **only if** the host acted,
   otherwise `run:idle` + the toast `nothing to abort`.
2. The `.finally()` restores idle from `'starting'` **or** `'aborting'` when no `run:start` was seen for this
   submission (compare a submission token captured before the call).
3. `SUBMIT_WATCHDOG_MS = 45_000`: if `submittingRef` is still true and no `run:start`, no `thinking` phase change and
   no stream byte has arrived for that long, append
   `[ui] the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave` and enable an explicit
   `Esc` cancel that rejects the submission promise locally (the engine-side abort is best-effort).
4. `EXIT_NOW_130` becomes **guaranteed**: if `host.abort()` reports it did not act, call `p.onAbort('human_abort')`
   and, failing that, `exit(130)` directly. **A second Ctrl-C must always end the process.**

*Edge cases.* (1) the watchdog must not fire during a legitimately slow first token — reset it on any `live` byte, any
`thinking` phase change and any retry row. (2) it must not fire while a retry countdown is visible (that state has its
own copy). (3) reduced motion: the line is a plain item, no animation. (4) **the deadline comes from the monotonic `nowMs()` = `performance.now()` defined in §2.2 P-R1**, never
`App.tsx:561`'s `now()` (which is `Date.now`), so an NTP jump can neither fire it early nor suppress it. (5) `--plain`'s readline composer has the same window and needs the same line.

### 7.9 P-D9 — `run.json` forward-version refusal

Setting `run.json` `"v": 99` and resuming produces **no** version complaint: `isRunMeta` "checks v1 fields only, so
old files load unchanged" (`src/session/index.ts:60–62`) — right for *older* files, wrong for *newer* ones. New:
`v > CHECKPOINT_VERSION` → `ConfigError`
`run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with jevcode upgrade`, exit
2; `v < CHECKPOINT_VERSION` and an absent `v` keep loading. The same check guards `state.json`'s envelope
(`parseEnvelope`). *Edge cases:* `v` present but not a number → treat as corrupt, not as newer; the picker shows such
runs greyed with `newer version` rather than hiding them; **`jevcode report` must still bundle a newer run** (a
support bundle for an unreadable run is exactly what you want) — the refusal applies to *resume*, not to *report*;
`sessions reindex` skips and counts them (§7.6).

### 7.10 P-D10 — a TUI surface for the peer registry (stub-driven)

Two instances in one workspace ran to completion concurrently with **zero** mention of each other. The registry is
another design's (`docs/COORDINATION-DESIGN.md`); the **TUI side** does not exist and needs one so the registry has a
surface to drive. Three read-only surfaces behind a `PeerView | null` prop supplied by the controller, with a stub
provider that reports "unknown" until the registry lands:

1. a status-line segment `2 here` when another instance holds the same workspace — the **count only**, never a pid,
   never a path;
2. a `[ui]` item at session open:
   `another jevcode is working in this workspace (started 4m ago) — /peers lists them`. **`/peers` is a real
   command this round, not a pointer to nothing** — §6.6 edge 6's rule ("never a dead command") applies to shipped
   copy too. Spec: `{ name: 'peers', category: 'session', usage: '/peers', args: [], available: 'always' }` in
   `registry.ts` (§9.2 routes it to S4); output is a **block** (§3.1) with head `peers · <n> here, <m> stale` and
   one kv row per peer — `workspace`, `started <t> ago`, `<state>` — never a pid and never a path; with no peers,
   the §3.1.7 sentence `no other jevcode is working in this workspace`; with the registry absent (the stub), one
   row `the peer registry is not available in this build`. `--plain` twin through `blockLines`; a
   `dispatch.test.ts` case; listed in §12 and in `round4-identity.test.ts`'s 41;
3. a **blocking pane** (the existing `src/tui/blocking/lines.ts` machinery) when a peer holds an exclusive lease and
   this instance would write: `[w] wait for it   [r] read-only session   [q] quit`.

*Edge cases.* (1) a stale entry from a killed instance must never block: the TUI shows `1 stale` and offers
`[c] continue`. (2) the segment is the **first** thing dropped when the status line runs out of columns. (3) reduced
motion / SR: the item is announced once, the segment is static text. (4) `--plain` gets the item, not the segment.
(5) **the pane must be dismissible** — a peer problem must never wedge the composer (§7.1's lesson). (6) two instances
by the same user in one multiplexer is the common case: the copy is informational, never a warning colour.

### 7.11 The typed fault parser and thirteen scenarios

Today `JEVCODE_FAULT` is matched by string in three places (`App.tsx:1963`, `PaneBoundary.tsx:52`,
`Transcript.tsx:234`) and only `render:<pane>` / `render:<pane>:lines` exist, although TD §19.6 already *names*
`jev:429`, `jev:401` and `persist:ENOSPC` — so the three pty rows that would gate the retry row, the auth pane and the
degraded pane are dead. Round 4: **one** `parseFault(env): Fault | null` in a single dev-only module returning a
discriminated union, every consumer reading a typed field, and **the parser rejects an unknown value loudly on stderr
before Ink mounts**, so a typo'd fault in CI fails the test instead of silently passing.

| # | value | behaviour | catches |
| --- | --- | --- | --- |
| 1 | `render:<pane>:lines:sticky` | the builder throws on **every** render | §7.1 (the render loop) |
| 2 | `render:wordmark` | throws inside the idle tenant | §7.3 item 2 |
| 3 | `persist:<CODE>[:after=<n>]` | the store's write rejects with `CODE` (ENOSPC/EACCES/EROFS/ENOENT) from write `n` | §7.2 |
| 4 | `rundir:rm[:after=<n>]` | the run dir is removed after step `n` | §7.2 |
| 5 | `submit:hang` | `host.submit()` never settles | §7.8 |
| 6 | `jev:429[:<retryAfter>]`, `jev:401`, `jev:5xx:<n>` | the mock decider answers the status | the retry row, the auth pane, 429/5xx storms |
| 7 | `net:ENOTFOUND`, `net:ETIMEDOUT`, `net:ECONNRESET:mid-stream` | the transport fails at DNS, at connect, mid-SSE | `retryCauseText` (well written, never tested end to end) |
| 8 | `stdout:EPIPE[:after=<n>]` | `stdout.write` throws EPIPE after frame `n` | §2.8 P-R11 and the hang-up path |
| 9 | `clock:jump:<±s>[:at=<n>]` | the injected `now()` jumps | elapsed clocks, toast expiry, the retry countdown, §7.8's watchdog |
| 10 | `index:corrupt`, `index:huge:<n>` | the session-index fixture | §7.6 |
| 11 | `config:<kind>` | the config file is truncated / wrong-typed / unreadable | §7.5 |
| 12 | `loop:hog:<ms>` | a synchronous busy-wait inside one event handler | event-loop hogs vs the 16 ms / 5 ms gates |
| 13 | `peer:<n>` | `n` fake peers in the registry snapshot | §7.10 |

Plus `JEVCODE_ASSERT_HEIGHT=1` (§1.5) as a `Fault` field rather than a fourteenth string.

### 7.12 P-D11 — the degradation notice fits, and names a log that exists

`paneFailedLine` (`PaneBoundary.tsx:48`) is 76 characters and wraps to 2–3 rows below 64 columns — the very frame
where rows are scarcest — and with no log open it says `details in jevcode.log`, a file that was never created
(`App.tsx:1948` uses `log.file || 'jevcode.log'`). Round 4 makes it width-aware:

| room | text |
| --- | --- |
| ≥ 64 | `ui: <pane> failed (<Error.name>) — run continues; see <log>` |
| < 64 | `ui: <pane> failed (<Error.name>)`, with the log named in the item's `detail` |
| no log open | the headline drops the `see …` clause; the detail says `the run log (start with --log <file>)` |

*Edge cases.* (1) `Error.name` can be attacker-influenced (a thrown object): it is already normalised by `toError`
(`PaneBoundary.tsx:57–62`) and must additionally pass `terminalSafeLine` and be clipped to **32** chars. (2) the
fallback `<Text wrap="truncate">` keeps the full line available in `detail` for `transcript.log`. (3) `--ascii` twin.
**Identity: text** — `paneFailedLine` feeds both the TUI fallback **and** the `[ui]` item that reaches
`transcript.log` and `--plain`; one formatter, one change, pinned at `test/unit/tui/pane-boundary.test.tsx` and in the
fault pty captures.

### 7.13 The small ones

| # | defect | fix |
| --- | --- | --- |
| a | `appendItems`' comment says `UiState.items` keeps every item for `/export` while the code discards the array at the soft cap | correct the comment (`useEngine.tsx:519` vs `:524`) |
| b | `keepSteps` bounds *steps* to 3 but not the decisions **within** one step, so a steer storm in one step grows unbounded | cap decisions per step (`useEngine.tsx:533–539`) |
| c | `PasteStore` caps each body at 1 MiB but nothing caps the **number** of live chips; N pastes retain N MiB | cap the store's total bytes and evict oldest-first, keeping the chip label |
| d | `rotateIfNeeded` renames to `<file>.1` and never prunes it, so a run dir holds up to 16 MiB of log with no notice | prune `.1` on the third rotation and say so at `debug`; bundle it (§7.7) |
| e | nothing asserts that a stray `console.log` from a dependency cannot reach the frame, although `routeConsole` is installed | a pty scenario with an injected `console.log` under fault 12 |
| f | at 1 row the region emits frames with **0 rows** and nothing says the composer is alive | **withdrawn — the static-only contract stands.** `layout.ts:155–158` is `if (rows < 3) { z.degraded = 'static-only'; return z; }` with **every** slot 0: there is no dynamic row to allocate at `rows === 1`, and §2.5 edge 3 depends on exactly that branch ("rows < 3 (static-only): the wizard cannot be shown at all"). Changing it would need an owner (`layout.ts` is S1's, §7.13 is S6's), a §9.2 request row, a glossary string and a `layout.test.ts` case, for one row on a one-row terminal. Instead: **document it** — one sentence in `docs/TUI.md`'s terminal-hygiene section, "below 3 rows JevCode is scrollback-only; the composer is alive but has no row to draw in", and the existing one `<Static>` item per size drop (§2.5 edge 3) is what tells the user. No `layout.ts` change, no §9.2 row (§14.2 "Review log" item 16) |

---

## 8. Contract changes — contract 1.7 (additive, ordered; numbered 1.6 in the drafts — 1.4 coordination, 1.5 orchestration and 1.6 import are the peer session's blocks, so round 4's header is `// contract 1.7`, placed after them when they exist)

**A note on the number.** The brief asked for "contract 1.5"; `// contract 1.4` is already claimed by
`docs/COORDINATION-DESIGN.md` §12.0 and `// contract 1.5` by `docs/ORCHESTRATION-DESIGN.md` §4.1, and both land in
`src/core/types.ts`. Round 4 therefore takes **1.6**. If it merges first, renumber at merge time: the header line is
the only place the number appears, and the rule is "one header line per design, in merge order, appended below the
previous one; never edit above your own line".

Header comment for `src/core/types.ts`, after the existing `// contract 1.3` line:
`// contract 1.6 (2026-09-21): TUI round 4 — block rows, annotateBlock, diff detail kind, ui.renderer, peer view, per docs/TUI-DESIGN-4.md §8; every item is optional or a default-preserving widening; CheckpointEnvelope.version stays 1.`

```ts
// 1  TranscriptItem (src/tui/plain.ts:85) — pre-rendered block rows and the detail's kind (§3.1.3, §6.4).
//    `detail: string` STAYS (--plain, --json and clipDetail are unchanged); `detailRows` is the TUI's pre-split form.
readonly detailRows?: readonly { readonly text: string; readonly role: ColorRole }[];
readonly detailKind?: 'diff' | 'table' | 'text';
// 2  Engine (types.ts) — one `notice ui` per row, head first, so a live block is the same in all three sinks (D-W, §3.5).
//    Returns false when no run is live, exactly like `annotate`.
annotateBlock?(head: string, rows: readonly string[], opts?: { level?: TranscriptLevel; label?: UiLabel }): boolean;
// 3  Renderer (types.ts:1617) — the row-list form of a block body: `lines` are the ALREADY-RENDERED row texts that
//    `renderBlock` produced (not `BlockRow[]`), so the parameter type matches §3.5's call. The DEFAULT implementation
//    is today's per-line `note`, so no renderer breaks (§3.5).
blockLines?(lines: readonly string[], opts?: { label?: UiLabel; level?: TranscriptLevel }): void;
// 4  UiConfig (types.ts:1506) — `fullscreenDump` only. `renderer` is declared ONCE, on LaunchSettings (item 6), and
//    UiConfig inherits it (`UiConfig extends LaunchSettings`, types.ts:1506): a derived interface may NOT weaken a
//    required base member to optional (TS2430), and re-declaring it here is the mistake round 3 already documented
//    at types.ts:1500–1502 for `ssh`. OPTIONAL, like `wordmark` (App.tsx builds a complete literal in `case 'theme'`).
//    Reader: `ui?.fullscreenDump ?? true`.
fullscreenDump?: boolean;
// 5  SettingName (src/config/types.ts:31–42) gains 'ui.renderer' and 'ui.fullscreenDump'; src/config/ui.ts resolves them
//    (enumSetting / booleanSetting), `jevcode config` prints them, `jevcode config set ui.renderer fullscreen` persists.
// 6  LaunchSettings (src/core/types.ts:1483 — the interface lives in core/types.ts; src/config/launch.ts only RESOLVES it):
//    `renderer?: 'classic' | 'fullscreen'` beside `fps` / `renderMode` / `ssh` (it MUST be a launch member: Ink fixes
//    `alternateScreen` in its constructor, §1.3.1), and `rendererRefusal?: string` carrying the one note when
//    fullscreen was refused. OPTIONAL for exactly the reason round 3 wrote down for `ssh` at types.ts:1500–1502 —
//    `resolveLaunchSettings` always sets it, but a required new member breaks every LaunchSettings / UiConfig literal
//    outside S3's files in W0: test/unit/config/resolve.test.ts:367,464 · test/unit/config/ui.test.ts:11,23 ·
//    test/unit/config/launch.test.ts:9 · test/unit/tui/round3-wordmark-app.test.tsx:30 · test/unit/tui/height.test.tsx:31 ·
//    test/unit/tui/plain.test.ts:649,726 · test/unit/cli/helpers.ts:423.
//    THE READER IDIOM, stated once and used everywhere: `launch.renderer ?? 'classic'` (never `launch.renderer ===`).
renderer?: 'classic' | 'fullscreen';
rendererRefusal?: string;
// 7  ConfigRecordValue (src/config/resolve.ts) — the validation problem (§7.5):
readonly problem?: { readonly kind: 'unknown-key' | 'wrong-type' | 'out-of-range'; readonly expected: string } | null;
// 8  EngineEvent — `checkpoint:degraded` already exists as a notice shape; the engine now emits it (§7.2). No new member.
// 9  SessionHost (types.ts:1538) — the peer snapshot the TUI renders (§7.10); null until the registry lands.
peers?(): PeerView | null;
export interface PeerView { readonly live: number; readonly stale: number; readonly oldestStartedMsAgo: number | null; readonly exclusive: boolean }
// 10 PatchError (src/workspace/patch.ts) — git's whole diagnosis, typed (§6.7).
readonly hunks?: readonly { readonly file: string; readonly line: number | null; readonly message: string }[];
// 11 not core, by owner:
//    ColorRole gains 'added' | 'removed' | 'hunk' | 'diffMeta' (theme.ts, §6.2) and COLOR_ROLES the four strings.
//    BlockRow / blockWidth / renderBlock / detailRole / LABEL_GUTTER re-export (src/tui/block/lines.ts, new, §3.1).
//    EditSummary / FileTouch / editSummary / editTargetText (src/tui/diff/summary.ts, new, §6.1).
//    DiffRow / DiffRowKind / diffRows (src/tui/diff/rows.ts, new, §6.2).
//    PaletteGhost becomes the three-member union; PaletteNavState (NINE members, incl. 'argbad') / paletteNavState /
//      paletteStep / NavEffect (src/tui/commands/nav.ts, new, §4.2); CommandSpec.destructive?: true;
//      DispatchResult.confirm. fitRung (src/tui/fit.ts, new, §2.6) — the one cross-slot rung helper.
//    GutterMode / gutterMode / STACKED_MIN_COLUMNS / FLUSH_MIN_COLUMNS / STATIC_ITEM_MAX_ROWS / LABEL_GUTTER
//      (src/tui/gutter.ts, NEW and zero-import, re-exported by Transcript.tsx, §2.3).
//    WrappedBody / wrapBodyCut; joinWrapped(rows, cuts) (transcript/wrap.ts, §2.4).
//    WORDMARK_LIVE_MIN_ROWS (wordmark.ts, §1.2); guardStdout (scrollback-guard.ts, new, §1.4).
//    computeFullLayout / FullLayout / ViewportIndex / Scroll (src/tui/fullscreen/**, new, §1.3) — only under D-S.
//    UiState (useEngine.tsx): readonly scroll (fullscreen only), readonly queued: string | null (§5.3 P-C7).
//    Fault (the discriminated union) + parseFault (src/tui/faults.ts, new, §7.11).
//    shortPath (src/core/text.ts, §3.4); explainFsError (src/errors.ts, §7.4).
//    ProbeName | 'scroll-latency'; ComposerSeriesName | 'palette-cycle' | 'palette-arg' (src/perf).
```

Config rows added this round: `ui.renderer`, `ui.fullscreenDump`. No default changes.

---

## 9. Module map — six slots, exclusive files, waves

**The rule, unchanged from round 3:** every file has exactly one owner; a slot that needs a change in another slot's
file sends a **request**, and §9.2's rows are those requests written verbatim so the owner lands them without a second
design pass. A slot that needs an App-level test writes it in its **own** `round4-<slot>-app.test.tsx` over the shared
harness (`test/unit/tui/app-harness.tsx`, read-only this round) — never in `app.test.tsx` / `round2-app.test.tsx` /
`round3-*-app.test.tsx`.

### 9.1 Slots and the files each may edit

| Slot | Owns (edit unless marked **new**) | Sections |
| --- | --- | --- |
| **S1 header, layout, fullscreen** | **`src/tui/App.tsx`**, `src/tui/wordmark.ts`, `src/tui/splash.ts`, `src/tui/Pane.tsx`, `src/tui/pane/model.ts`, `src/tui/layout.ts`, `src/tui/terminal.ts`, `src/tui/scrollback-guard.ts` (**new**), `src/tui/index.ts`, `src/tui/fullscreen/**` (**new**: `layout.ts`, `viewport.ts`, `Viewport.tsx`, `FullApp.tsx`), `src/config/launch.ts`, `src/cli/args.ts`, `test/unit/tui/{wordmark,splash,layout,pane,scrollback-guard}.test.ts*`, `test/unit/tui/fullscreen/**` (new), `test/unit/tui/round4-header-app.test.tsx` (new) — **declared carve-out (integrator, 2026-09-22, finding 21):** the rule-row change re-pins seven lines outside this list, each carrying an explicit `DECLARED CARVE-OUT` comment: `test/unit/tui/app.test.tsx:106, :111, :127, :141` (the panel tab headers, forced by finding 5's `brand: i.ranBefore`), `test/unit/tui/round2-lines.test.ts`, `test/unit/tui/round2-app.test.tsx`, `test/unit/tui/round3-wordmark-app.test.tsx` and `test/unit/tui/height.test.tsx`. §1.2 edge 9 already enumerates the last four as "the rule-row fixtures that re-pin in the same commit"; this row is the §9.1 half of that grant, which §9.1 and §1.2 edge 9 contradicted each other about | §1, §2.2 P-R1 |
| **S2 resize, terminal, narrow ladder** | `src/tui/Transcript.tsx`, `src/tui/transcript/wrap.ts`, **`src/tui/Console.tsx`**, `src/tui/Overlay.tsx`, `src/tui/composer/filter.ts`, `src/tui/glyphs.ts`, `src/tui/fit.ts` (**new** — `fitRung`, §2.6), `src/tui/gutter.ts` (**new**, zero-import — the rung and `LABEL_GUTTER`, §2.3), `src/tui/console-lines.ts`, `src/tui/onboarding/lines.ts`, `src/cli/main.tsx`, `test/unit/tui/{transcript,console,overlay,glyphs,console-lines,fit,gutter}.test.ts*`, `test/unit/tui/transcript/wrap.test.ts`, `test/unit/tui/onboarding/lines.test.ts`, `test/unit/tui/round4-resize-app.test.tsx` (new) | §2, §5.1 P-C3 |
| **S3 command output, blocks, local items** | `src/tui/block/**` (**new**), **`src/cli/session.ts`**, `src/cli/config-table.ts`, `src/cli/epilogue.ts`, `src/tui/budget/lines.ts`, `src/tui/why.ts`, `src/tui/calibration.ts`, `src/core/text.ts`, `src/config/resolve.ts`, `src/config/{types,ui,defaults}.ts`, `test/unit/tui/block/**` (new), `test/unit/cli/{session,config-table,epilogue}.test.ts`, `test/unit/tui/{budget,why,calibration}*.test.ts`, `test/unit/config/**`, `test/unit/tui/round4-block-app.test.tsx` (new) | §3.1–§3.5, §7.5 |
| **S4 palette, keys, composer** | `src/tui/commands/**` (`nav.ts` **new**), `src/tui/keys/**`, `src/tui/composer/{submit,Composer.tsx,buffer,history,paste}`, `src/tui/plain-composer.ts`, `scripts/gen-docs.mjs`, generated `docs/{COMMANDS,KEYS}.md`, `man/jevcode.1`, `completions/*`, `test/unit/tui/commands/**`, `test/unit/tui/{submit,plain-composer,keys,interrupts}*.test.ts*`, `test/unit/tui/round4-palette-app.test.tsx` (new) | §4, §5.3 |
| **S5 conversation, file edits, the one item formatter** | **`src/tui/plain.ts`**, `src/tui/theme.ts`, `src/tui/Review.tsx`, `src/tui/review/lines.ts`, `src/tui/diff/**` (**new**), `src/chat/**` (`store.ts` **new**), `src/undo/{diff,plan,pager}.ts`, `src/workspace/patch.ts`, `src/cli/mock-trajectory.ts`, `src/loop/stop.ts` (**one line**, §3.6), `src/workspace/gitstate.ts`, `test/unit/tui/{plain,theme,review}*.test.ts*`, `test/unit/tui/diff/**` (new), `test/unit/chat/**`, `test/unit/undo/**`, `test/unit/workspace/patch.test.ts`, `test/unit/tui/round4-chat-app.test.tsx` (new) | §3.6, §3.7, §5.2, §5.4–§5.8, §6 |
| **S6 hardening, faults, perf, pty, docs** | `src/tui/PaneBoundary.tsx`, `src/tui/faults.ts` (**new**), `src/tui/useEngine.tsx`, `src/tui/notify.ts`, `src/tui/status/lines.ts`, `src/tui/blocking/lines.ts`, `src/cli/{fatal,report,sessions}.ts`, `src/errors.ts`, `src/checkpoint/store.ts`, `src/session/index.ts`, `src/loop/engine.ts` (**two named edits**: `annotateBlock`, the degrade emit), **`src/perf/**`**, **`test/pty/**`**, **`test/unit/perf/**`**, `scripts/pty/{polish-check.mjs,decstbm-probe.sh}`, `docs/**`, `README.md`, `CHANGELOG.md`, `docs/live/tui/round-4/**` | §7, §10, §11, §12, §13 |

`src/synth/**`, `src/bench/**`, `src/jev/**`, `src/provider/**` and the rest of `src/loop/**` are **read-only** this
round.

### 9.2 Shared files: the owner, and every change another slot needs

| File | Owner | For | Change (verbatim in the section named) | Wave |
| --- | --- | --- | --- | --- |
| `src/core/types.ts` | **S3** | S5 (items 1, 10 consumers), S6 (items 2, 8, 9), S1 (items 4, 6) | §8 items 1–10, **all in W0** | W0 |
| `src/tui/App.tsx` | **S1** | S2 (`wrapColumns` deletion §2.2 P-R2 call sites `:1703, :2228, :2268`), S3 (the four App-local `block()` twins `/help` `/why` `/decisions` `/plan`), S4 (`case 'palette'` → `NavEffect` `:1485–1512`; `case 'complete'` becomes the one `accept` `:1467`; the marker reset `:1717`; `dispatchCtx` merge §5.4 P-C9 `:856`; `/copy last` `:1039`), S5 (the queued-submission slot §5.3 P-C7 `:1058–1117`; the cleared-draft ref §5.5 P-C16; the SR announcements §5.8), S6 (the `guard` latch `:1962–1982`; the boundary catalogue §7.3; `abortRun` + the watchdog §7.8 `:680–684, :955–980`) | §1.2, §2.2, §3, §4, §5, §7 | W2 (S1's own), **W3** (everyone else's, one PR) |
| `src/cli/session.ts` | **S3** | S5 (the steer bubble §5.5 P-C12, `/new` §5.5 P-C14, the intake marker §5.6, the `--plain` prompt §5.7), S6 (the `resumable` stat and the `files` row §7.2, the index notice §7.6) | §5.5–§5.7, §7.2, §7.6 | **W3** (one PR) |
| `src/tui/plain.ts` | **S5** | S3 (`detailRows` / `detailKind` rendering contract, `localItem`'s `maxDetailLines` §6.5 item 3), S6 (`paneFailedLine`'s item §7.12; the `ui: <pane> pane recovered` line §7.1) | §3.1.3, §6.4, §6.5, §7.1, §7.12 | W2 |
| `src/tui/Transcript.tsx` | **S2** | S5 (`detailKind: 'diff'` routing to `diffRows`, the turn-spacer rule §5.1 P-C1, the fence-run colour §5.1 P-C2), S1 (`LABEL_GUTTER` re-export for `blockWidth`) | §2.3, §5.1, §6.4 | W2, then **W3** for S5's rows |
| `src/tui/theme.ts` | **S5** | S2 (nothing), S6 (nothing) | §6.2's four roles + the four theme tables | W1 |
| `src/tui/review/lines.ts` | **S5** | S2 (the `fitRung` keys ladder §2.6 P-R7 and the rungs derived from the effective bindings) | §2.6, §6.3, §6.10 | W1 (S5's own), W2 (S2's rung request) |
| `src/tui/useEngine.tsx` | **S6** | S1 (`scroll` state + its actions, fullscreen only), S5 (`queued` state §5.3 P-C7; the per-step decision cap §7.13 b) | §1.3.3, §5.3, §7.13 | W2 |
| `src/tui/status/lines.ts` | **S6** | S4 (the state-aware ShortHelp §4.4), S5 (`· 1 queued` §5.3 P-C7), S7 n/a | §4.4, §5.3, §7.10 | W2 |
| `src/tui/Console.tsx` | **S2** | S1 (drop `bodyColumns`, §2.2 P-R2), S6 (the `status` node becomes a React node so §7.3 item 4 can wrap it) | §2.2, §7.3 | W2 |
| `src/tui/Overlay.tsx` | **S2** | S4 (the palette value cursor `▹` and the S-NONE inline row §4.3–§4.4), S2's own: the minsize ladder §2.5 | §2.5, §4.3, §4.4 | W2 (own), W3 (S4's) |
| `src/tui/commands/registry.ts` | **S4** | S3 (the `--all` **flag specs** for `/config` and `/diff` — note `CommandSpec.category` **already exists** at `registry.ts:45, 62, 112…`, so §3.3's work is the *help grouping that consumes it*, not the field), S5 (`/copy conversation` §5.5 P-C13), S1 (**`/fullscreen`** §1.3.1 and **`/scrollback`** §1.3.4 specs, availability `classic`-answers-with-a-note), S6 (**`/peers`** §7.10 and **`/ui reset`** §7.1 specs) — **four new commands, 37 → 41** | §1.3.1, §1.3.4, §3.3, §4.5, §5.5, §7.1, §7.10 | W1 |
| `src/undo/diff.ts` | **S5** | S3 (`diffStatBlock` takes the **body** width and its head is built short §6.5) | §6.5 | W1 |
| `src/cli/fatal.ts` | **S6** | S1 (§1.3.1: `RESTORE` (`:24`) gains `\x1b[?1049l` **only when the alternate screen was entered**, from a module-level flag set by `createTuiRenderer`), S2 (§2.8 P-R11: one line to stderr before the EPIPE exit at `:29, :218–221`, guarded because stderr may also be closed; **keep 129**) | §1.3.1, §2.8 | W2 |
| `src/cli/session.ts` — S2's row | **S3** | S2 (§2.8 P-R10: `selectRenderer`'s `reason` reaches the usage error at `:325–327`) | §2.8 | W3 |
| `src/cli/epilogue.ts` | **S3** | S6 (§7.2 item 4: `epilogueRows` (`:75–81`) lists only files that exist and replaces the whole `files` row when the directory is gone; the `resume` row is `:79`, the `report` row `:80`) | §7.2 | W2 |
| `src/tui/fit.ts` (**new**) | **S2** | S5 (the review keys ladder and the intake row), S4 (§4.5's three confirm ladders) — `fitRung` is the one cross-slot helper and **this is its home module** | §2.6 | W1 |
| `src/tui/gutter.ts` (**new**, zero-import) | **S2** | S3 (`blockWidth` in the no-Ink `block/lines.ts` needs `gutterMode` + `LABEL_GUTTER` without importing `Transcript.tsx`), S1 (the same for `fullscreen/viewport.ts`) — `Transcript.tsx` re-exports every name so no existing importer changes | §2.3, §3.1.2 | W1 |
| `src/chat/lines.ts` | **S5** | S2 (§2.6 P-R7: the intake row goes through `fitRung`) | §2.6, §5.6 | W1 |
| `src/tui/blocking/lines.ts` | **S6** | S2 (§2.6 P-R7: the blocking card goes through `fitRung`), S6's own §7.4 item 6 and §7.10 item 3 | §2.6, §7.4, §7.10 | W1 |
| `src/tui/index.ts` | **S1** | S2 (§2.2 P-R2 retires `createResizeDebounce`, which is **public API** at `src/tui/index.ts:74` and tested at `test/unit/tui/terminal.test.ts:53–67`: the export is removed, the two tests are deleted with it, and `CHANGELOG.md` records the removal) | §2.2 | W2 |
| `src/tui/layout.ts` | **S1** | S2 (§2.5 P-R5's minsize ordering and P-R6's wizard refund). **No `rows < 3` change is requested** — §7.13 (f) is withdrawn (see §7.13) | §2.5 | W2 |
| `src/config/launch.ts`, `src/cli/args.ts` | **S1** | S3 (nothing), S6 (`rendererRefusal` printed with the other launch notes) | §1.3.1, §8 item 6 | W0 |
| `src/loop/engine.ts` | **S6** | S3 (`annotateBlock`, §3.5), S5 (the patch-failure `detail`, §6.7) | §3.5, §6.7, §7.2 | W2 |
| `test/pty/**`, `src/perf/**`, `test/unit/perf/**` | **S6** | S1 (the header/fullscreen scenarios), S2 (the resize matrix), S3 (`commands-width.steps`), S4 (`palette-*.steps`), S5 (**the §3.7 pin migration and the two `pty.ts` constants**) | §10, §11 | **W4** (with G1) and W5 |
| `docs/**`, `README.md`, `CHANGELOG.md`, `completions/*`, `man/jevcode.1` | **S6** (S4 owns the *generated* `COMMANDS.md`/`KEYS.md`) | every slot | §12, §13 | W5 |

### 9.3 Waves

**W0 — contract and launch (S3 + S1, half a day).** §8 items 1–10 in `src/core/types.ts` — note `renderer` is
declared **once**, `renderer?: 'classic' | 'fullscreen'` on `LaunchSettings` (`src/core/types.ts:1483`), and
`UiConfig` inherits it (item 4 declares only `fullscreenDump`); the `ui.renderer` / `ui.fullscreenDump` schema
rows; `--fullscreen` / `--renderer`; the `src/tui/block/**` API skeleton (types + a stub `renderBlock`) and the
`src/tui/fit.ts` signature so every slot compiles. **Plus the two `app.test.tsx` carve-outs** (§3.7, §1.2 edge 9),
which must precede every D-V and rule-row commit. `tsc --strict` green, every fake compiles.

**W1 — pure modules, all six slots in parallel, offline.** S1 `wordmark.ts` (`WORDMARK_LIVE_MIN_ROWS`),
`scrollback-guard.ts`, `pane/model.ts` (the brand segment), `fullscreen/layout.ts`; S2 `transcript/wrap.ts`
(`wrapBodyCut`), `Transcript.tsx`'s pure helpers (`gutterMode`, `bodyWidth`), `glyphs.ts`, `console-lines.ts`,
**`fit.ts` (`fitRung`) and `gutter.ts` (`gutterMode`, `LABEL_GUTTER`) — first, because four other slots' W1 work
consumes them**, `Overlay.tsx`'s `minsizeNotice` ladder, `composer/filter.ts`; S3 `block/lines.ts` + `block/render.ts`,
`config-table.ts`, `budget/lines.ts`, `why.ts`, `calibration.ts`, `epilogue.ts`, `core/text.ts` `shortPath`,
`config/resolve.ts` problems; S4 `commands/nav.ts`, `palette.ts`, `registry.ts`, `dispatch.ts`, `keys/*`; S5
`theme.ts`, `diff/summary.ts`, `diff/rows.ts`, `review/lines.ts`, `chat/bubbles.ts`, `chat/store.ts`,
`undo/diff.ts`, `workspace/patch.ts`; S6 `faults.ts`, `errors.ts`, `checkpoint/store.ts`, `session/index.ts`,
`report.ts`, `PaneBoundary.tsx`.

**W2 — renderer wiring, own files only.** S1 `App.tsx` (the brand rule, the live mark, the wordmark boundary, P-R1,
`guardStdout`) and `fullscreen/**`; S2 `Transcript.tsx` / `Console.tsx` / `Overlay.tsx`; S3 `session.ts`'s own 20
`block()` call sites; S4 `Composer.tsx` / `plain-composer.ts`; S5 `plain.ts` (`detailRows`, `detailKind`, `Review.tsx`);
S6 `useEngine.tsx`, `status/lines.ts`, `loop/engine.ts`.

**W3 — cross-slot requests, landed by the owner in one PR each.** S1 lands §9.2's `App.tsx` rows for S2/S3/S4/S5/S6;
S3 lands S5's and S6's `session.ts` rows; S2 lands S4's `Overlay.tsx` rows and S5's `Transcript.tsx` rows; S5 lands
S2's `review/lines.ts` rung request.

**W4 — the D-V commit series (S5, with S6 in the same PR).** G1 … G7 of §3.7, **one commit per group**, each moving
its own pins; **G1 carries `src/perf/pty.ts:800` and `:804` and the pattern self-test**; `npm run perf` is re-run once
after G1 to confirm both windows are non-empty. Nothing else lands in W4.

**W5 — gates, pty, perf, docs (S6).** The resize matrix suite, V22/V23 in `polish-check.mjs`, the new perf series and
probes, `docs/TUI.md` / `docs/KEYS.md` / `docs/COMMANDS.md` / `README.md` / `CHANGELOG.md` / `docs/DECISIONS.md`, and
the live captures into `docs/live/tui/round-4/` on both providers (paid, once). **No paid call in any unit or pty
test.**

**Ordering constraints that are not negotiable.** §6.9 (the mock patch path) lands **before** §6.3 and §6.7 so both
land against a failing pty test. §3.3's width plumbing (`blockWidth` at the six pane-derived call sites) lands in
**W1**, because round 3's D-L is already in flight and until it lands every pane-derived block overflows by exactly
10 cells. §7.1's latch lands before §7.3's new boundaries (a boundary that catches a persistent throw needs the latch
first). §4.2's `nav.ts` lands after §4.3's ghost union and marker reset. **`src/tui/fit.ts` (`fitRung`) and `src/tui/gutter.ts` (`gutterMode`) land
first in W1**: §2.5's minsize ladder, §2.6's review rungs, §4.5's three confirm ladders and §5.6's intake ladder all
consume `fitRung`, and §3.1.2's `blockWidth` consumes `gutterMode` — which is also why `gutter.ts` must be
zero-import (`block/lines.ts` is a no-Ink module and the first-frame path reaches it). **The two `app.test.tsx` carve-outs land in W0**, before any D-V or rule-row
commit: S5 moves `:158` and `:602` into `round4-chat-app.test.tsx` (§3.7) and S1 re-pins `:106` (§1.2 edge 9) —
these are the only lines of `app.test.tsx` any slot may touch this round.

---

## 10. Tests per slot (vitest `unit`, offline; pty `--mock`, hermetic; perf under a real pty; live paid once)

**S1 — header, layout, fullscreen.**
*unit* `wordmark.test.ts`: a 1 000-case property test over `WordmarkInput` for the new predicate, plus explicit cases
at rows 31/32 live and at 24/23 post-run. `pane.test.ts`: the brand prefix appears at ≥ 64 columns on **every**
post-run `panelStrip` row **including the frames where the 5-row mark is up** (F-H1, F-H2 — the mark sits under the
strip, TD3 §729), is dropped before any information segment below 64 columns, `brandSpan` finds it, the `--ascii`
twin, `NO_COLOR` text identity; plus the pre-run cases where the rule row is `plainRule` / `brandRow` and carries no
strip at all. `scrollback-guard.test.ts`: the exact sequence is rewritten; `\x1b[2J` alone, a `\x1b[3J`
in a non-clear context and `\x1b[2K` are untouched; Buffer chunks pass through; all three `write` overloads forward;
property forwarding for `isTTY/rows/columns/on/off`; a zero-length write forwards. `fullscreen/layout.test.ts`:
**exhaustive** — rows 0…120 × columns {0,1,39,40,63,64,79,80,119,120,199,200} × every `OverlayKind` × composer wants
1…8, asserting `total === rows` (or 0) and the yield order; plus a 1 000-case random property test.
*render* `fullscreen/render.test.tsx` with `ink-testing-library`: `frame.split('\n').length === rows` for the same
matrix and for 0 / 1 / 20 000 items — **the test that would have caught the 37-clears cliff**.
*pty* `wordmark-live.steps` at `PTY_ROWS=34` (the mark present in a frame captured while live; the run's busiest-second
frame count unchanged); `brand-strip` added to `panel.steps` (present after a run at 80 **whether or not the mark is up**, absent at
`resize 24 44`);
`shrink-no-3j.steps` (`/panel full`, `resize 10 60` → `\x1b[2J` present, **zero** `\x1b[3J`); `fullscreen-refuse.steps`
at `PTY_ROWS=14` (a classic frame + the note, **zero** `1049h`); `fullscreen-resize.steps`, `fullscreen-scroll.steps`,
`fullscreen-exit-dump.steps`.

**S2 — resize, terminal, the narrow ladder.**
*unit* `renderer-resize.test.tsx` (new): a fake `stdout` with settable `rows`/`columns` and a spy `rerender`; a
synchronous commit for each of ↓rows, ↓cols, ↔rows/↓cols, ↑rows/↓cols, and **none** for ↑rows/↑cols; the 8 ms storm
guard's rate. `console.test.tsx`: render at 80 with a 120-char draft, re-render at 44, assert every
`ConsoleRows.body[i]` is 44 cells **in the same commit** (today they disagree for ≤ 50 ms). `transcript.test.tsx`: the
`gutterMode` table and `bodyRows(item).length` at 8/10/12/16/20/24/34/40/80 against a bound table (today 258 at 10
columns; target ≤ 24 **for an engine item**); **an item carrying `detailRows` from a command block is exempt from
`STATIC_ITEM_MAX_ROWS`** — `/diff --all` at 10 columns keeps its full row count (§2.3); no empty row; no trailing
space. `transcript/wrap.test.ts`: a property test — for 500 generated
bodies (words 1…60 cells, with and without ` · `) at widths 4…120, `joinWrapped(rows, cuts) === body` **always**;
plus the two explicit TD3 §5.3 cases and the measured 53-cell-path case. `overlay.test.tsx`: the minsize rung ladder at
widths 10…80 × (short rows / short cols / both) × **three-digit dimensions** (`100×5`, `100×120`, `200×3`) asserting
`cellWidth(notice) ≤ columns` **always** and that the selected rung is the widest that fits the *formatted* string;
the boundary case `columns === 40 && rows === 8` is **not** minsize; **and §4.5's three confirm ladders: for widths
20…200 the chosen rung fits the card's inner width and contains `[y]` and `[n]`**. `layout.test.ts`: the minsize allocation at budgets 0…3, and
minsize + `overlay: 'wizard'` ⇒ `composer === 0, overlay ≥ 1`; plus A2's 829 600-case sweep folded in as a bounded
property test. `console-lines.test.ts`: every console row is exactly `columns` cells at widths 0…200, and
`consoleDivider(w, ascii) !== consoleBottom(w, ascii)` for w ≥ 4. `composer/filter.test.ts`: the six OSC shapes plus
20 "a human typed this" negatives. `onboarding/lines.test.ts`: `wizardMinsizeRow` for every step at 20/30/40 columns,
`cellWidth ≤ columns`, **and no masked byte appears** (the row carries at most a `•` count); a key pressed at
minsize produces the toast and **no state change** on the wizard reducer.
*pty* `resize.pty.test.ts` — the §2.1 eleven-state ladder + the storm; `resize-cols.steps` (24×120 → 24×40 → 24×120
with a 120-char draft) asserting **0** frames flagged by V22; `tiny-cols.steps` (boot at 2×10 and 5×16: < 40 stripped
rows, every row non-empty, no trailing spaces); `minsize.steps` (24×80 → 3×20 → 5×30 → 5×60 → 24×80: every minsize
frame's first row is a complete sentence with no trailing `…`); `osc-noise.steps` (Python-generated per §2.0 rule 3:
one OSC 11 answer, two, an OSC 52 answer, an answer inside a CSI burst — the draft stays empty and Ctrl-D ×2 exits 0,
where today two answers hang the session at exit 124); `r3-wizard-resize.steps` extended with 8×40 and 5×30 rungs
asserting `setup` is present and `Say hi` never is.

**S3 — command output.**
*unit* `block/lines.test.ts`: the five row kinds at widths 28/30/50/70/110/160; the `< 34` stacked tier; wide-grapheme
padding; **the frames F-B1…F-B7 read back from this document** with the `frameFKRows()` pattern
(`palette.test.ts:24–35`) so the doc and the renderer cannot drift. `block/bench.test.ts`: `renderBlock` of the
largest block (`/config`, 42 rows) at 200 columns **< 2 ms**. `config-table.test.ts`: three width cases (40/80/120)
asserting **every row ≤ width** (replacing today's "aligns the columns under a header"); the fold count; `--all`; the
left-elided path; the derived-suffix note row; **a problem row is never folded**. `core/text.test.ts`: `shortPath`,
12 cases. `epilogue.test.ts`: the `files` row at width 70 keeps the run id intact; `resumable: false` →
`state.json missing — not resumable`; the run dir absent → the `gone` row. `session.test.ts`: the new `/cost`,
`/jev`, `/status`, `/budget` heads and detail pins; `1 run`; the uncapped case; the §3.1.7 empty states; the error
shapes; `nothing to undo` is **not** prefixed `error:`. `round4-block-app.test.tsx`: an item with `detailRows`
renders one `<Text>` per row at the body column; a block with a `gap` renders a blank row.
`round4-identity.test.ts`: for **every** command in `COMMANDS` that produces a block, the §3.5 normaliser equates the
TUI rows and the `--plain` rows against one fake engine — offline, cheap, covers **all 41** (37 today plus
`/fullscreen`, `/scrollback`, `/peers`, `/ui reset`), and **fails on an unlisted command** so a 42nd cannot be added
without a twin.
*pty* `commands-width.steps` at **2×10, 5×16, 24×20, 24×24, 24×30, 24×34, 24×37, 24×40, 24×80 and 40×120** over
`/status /cost /jev /budget /config /diff /help`: **no static row produced by a command exceeds the terminal
width**. The three widths below 34 and the four in 34–40 are the whole point — the 40/80/120 sample cannot see a
width floor that exceeds the rendered body (§3.1.2, §14.2 "Review log" item 7). *unit* `block/lines.test.ts` adds the
sweep `for columns in 1…200: every renderBlock row's cellWidth ≤ blockWidth(columns) ≤ renderedBodyWidth(columns)`.

**S4 — palette and keys.**
*unit* `commands/nav.test.ts`: the full **9 states × 7 keys** table, one assertion per cell; a **totality and
disjointness** property test over the ordered chain (every `(draft, matches, selected)` triple resolves to exactly
one state); the four `arg0`/`restTail` cells `/budget spend-cap 5` → S-ARGDONE + `run`, `/budget spend-cap` →
S-ARGDONE, `/budget ` → S-ARG, `/mode jev-onx` → S-ARGBAD + `run`; `/rename` (no tail) → S-ARMED, not S-FREE;
typing `/`,`e`,`x`,`i`,`t`,Enter with no Tab and no cycle → `confirm: null`; **plus §4.1's theorem as
a property test** — for every `matches` list and every k ≤ 200, applying `enter` k times from
`paletteNavState('/', …)` never yields a `run` effect. `palette.test.ts`: `paletteGhostFor` for the three shapes and
the 40-column cut; `/mode j` yields exactly `jev-only|jev-on|jev-off` in rank order with `▹` on `j = 0`; `/mode `
yields four rows with ` (default)` on one; the S-NONE rows at 80 and 60; the footer table; the numbered block at 80
and 60. `keys/resolve.test.ts`: Enter emits `op: 'enter'`; one event `{input:'/mo'}` with `draftEmpty` → `insert` +
`openPalette`, and `{input:'/mo', paste:true}` → insert only; `{input:'[<64;10;5M'}` → no actions; the reopen rule.
`interrupts.test.ts`: palette + a token-only draft → `CLOSE_OVERLAY_AND_CLEAR`; palette + `/budget 5` →
`CLOSE_OVERLAY`; Ctrl-C twice still exits 0. `dispatch.test.ts`: `fromPalette: true` + `/new` → `confirm: 'new'`;
`fromPalette: false` → `null`; `/bogus` → `/budget`; `/xyzzy` → no clause; availability preference.
`submit.test.ts`: §5.3 P-C8's multi-line decision table. `plain-composer.test.ts`: `/` prints the list **and changes the prompt to
`pick 1-41, or type a message > `**, `3` runs `/resume`, `3` on the next turn is a prompt with the normal prompt
string; `/` then `2` (a destructive command) shows the `y/N` confirm; `/` then `hello` clears `pendingList` and is
sent as a message; `hello` then `12` is a prompt, never a command. `round4-palette-app.test.tsx`: `/` + Enter ×2 + Tab + Enter runs
`/resume`; `/` ↓ ↓ `m` → footer `(1/6)` and the marker on `/mode`; Enter on an accepted `/new` opens the confirm row,
Enter on the row does nothing, `y` ends the session, `n` keeps it.
*pty* `palette-enter.steps` (`/` · Enter · Enter → `(3/37)` and `› /resume +36` · Tab → `› /resume` with no ghost ·
Enter → the session picker); `palette-arg.steps`; `palette-arg2.steps` (`/budget spend-cap 5` from an open palette runs, in one Enter);
`palette-destructive.steps`; `palette-sr.steps` with
`JEVCODE_SCREEN_READER=1`; `palette-trap.steps` — **the exact sequence that trapped the audit**: `/zz` → the inline
row, Ctrl-C → the placeholder back, `/` → the card. Regression: **`EXIT_IDLE` (`test/pty/helpers.ts:789`) unchanged** — a hand-typed `/exit` still exits with no
confirm row, which is what every pty suite that imports it (`round2`, `round3`, `chat`, `review`, `twins`,
`interrupts`) depends on; `commands-idle.steps` re-pinned because `send /s` as one chunk now opens the palette (§4.7 E9).

**S5 — conversation, file edits, the item formatter.**
*unit* `chat/bubbles.test.ts`: `bubbleLines('a\n\n\tb\n')` → `['a','','    b']`; `'a\n\n\n\n\nb'` → `['a','','','b']`;
`formatTranscriptItem({text:''})` has no trailing space; a 2 000-char message yields 2 items and the marker says
`+1,401`; 600 chars exactly → no marker. `chat/store.test.ts`: round-trip, caps, rewrite, an unreadable file.
`diff/summary.test.ts`: the thirteen edge cases plus a property test that `editSummary(patch).added` equals the count
of `+` lines that are not `+++`. `diff/rows.test.ts`: the fifteen edge cases; **every returned row's
`cellWidth ≤ columns`**; no row contains `\t`; the `--ascii` twin differs only in glyphs; a golden multi-file diff at
40/60/80/120; **a pure-addition diff at 80 columns has a non-null `newNo` on every `add` row and the rendered row
prints it**; the two-column widths at 60 / 59 / 20 / 19 columns; `/diff --all` at 10 columns keeps its full row
count (the §2.3 source-keyed cap exemption). `theme.test.ts`: the four new roles exist in all four themes, carry markers, and pass round 3's
contrast and 256-cube checks. `review/lines.test.ts`: §6.3's ten cases, **including one asserting no `/diff` token appears in a pre-apply card
tail**; every row exactly `columns` cells; total rows
≤ n for n ∈ 3…20; the `--ascii` and `sr` twins; **for widths 20…160 the chosen keys rung fits the card's inner width and contains every one
of the six actions** (matched by the *effective binding*, not the literal letter); a case with approve rebound to
`ctrl+y`; and each of the five default renderings measures exactly its documented 113 / 76 / 55 / 42 / 15 cells. `plain.test.ts`: the §3.6 table item by item; `detailKind` is set for the
three edit kinds and unset for `read`/`run`; a `detailKind: 'text'` item is unchanged (the regression pin).
`undo/diff.test.ts`: the short header at 40/80/120; no truncation of the head; the bar suppressed on equal rows;
body-width rows; the `--all` bound. `workspace/patch.test.ts`: the stderr parser over recorded git outputs for "does
not apply", "already exists", "No such file", "Permission denied", a non-`error:` stderr and an empty stderr.
`round4-chat-app.test.tsx`: a 3-line `[you]` turn renders 4 rows not 6; the queue (queue, flush, cancel, cap 1,
Ctrl-C drop); `dispatchCtx()` carries `isDeniedPath` once the host is attached; `@.env` yields the notice and is
absent from `pinnedFiles`; a 3-line `[jevcode]` turn copies 3 lines and a clipped `[you]` turn copies the unclipped
source; the fence run colours 4 rows `code`.
*pty* `chat-paste-code.steps` (the 9-line fixture: the blank line survives, the row count is 10);
`chat-multiline-command.steps`; `chat-queue.steps` with `JEVCODE_MOCK_JEV_MS=1500`; `chat-new.steps` (the reply keys
on `conversation.length`, so the second `hi` answering `hello_first` is a direct observable of the ledger reset);
`chat-persist.steps` (two processes: say `hi`, `/exit`, then `--continue` asserts `resumed conversation` and
`hello_again`); `chat-sr.steps`; `mention.steps` extended (the denylist line **and** the not-found line);
`review-patch.steps` at 24×80 and 12×60; `patch-failed.steps`; `diff-block.steps` in a temp **git** workspace
(today's smoke workspaces are not repos, which is why `/diff` only ever showed the error path — `git init` is part of
the scenario).

**S6 — hardening, faults, gates.**
*unit* `app-guard.test.tsx`: mount `<App>` with a builder stubbed to throw **every** time; the component settles
within N renders, **exactly one** `[ui]` item is appended, `fn` is called **once**, and a `resetKey` change retries
once and re-latches; two panes throwing in one render → two items, one commit. `pane-boundary.test.tsx`: one case per
pane name (fault fires, the fallback height equals the slot height, siblings untouched); a `StatusLine` throw in the
boxed tier leaves the four border characters present; the §7.12 widths and the no-log case; a thrown object with a
10 000-char `name`. `checkpoint/degrade.test.ts`: an injected fs throwing EACCES/ENOSPC/ENOENT/EROFS → one
`checkpoint:degraded` per key; `exitCodeFor('complete', …, degraded = true)` → 3. `errors/explain.test.ts`: one case
per §7.4 row, including a path containing a canary secret (assert redacted). `cli/fatal.test.ts`: a thrown EACCES →
exit 2, stderr carries the epilogue **and** the fix block, stdout empty. `config/problems.test.ts`: one of each
problem kind → the exact rows and exit code; a clean config → zero problems, exit 0, the table byte-identical to
today. `session/index.test.ts`: one fixture per skip reason → exact counts; a torn final line; a 200 k-line file with
the window → the newest N sessions, **< 100 ms**. `cli/report.test.ts`: an 8 MiB `transcript.log` → the head/tail
marker and ≤ 4 MiB written; a canary secret inside the elided region is never written; a throw mid-bundle leaves
`(bundle incomplete)`; the `versionsText` snapshot. `submit-watchdog.test.tsx`: a promise that never settles → the
line at 45 s, `Esc` cancels, the composer accepts text again, `run` returns to `none`; `host.abort()` returning
`{ acted: false }` → `run` stays `none`, the toast appears, a second Ctrl-C exits. `faults.test.ts`: `parseFault`
over all thirteen values plus an unknown one (which must **reject loudly**).
*pty* `fault-persistent.steps` (fault 1, 10 s: frame count ≤ `maxFps × seconds + 2`, **exactly one**
`pane failed to render` line, exit 0 on Ctrl-C ×2, 0 clears, 1 `RESTORE`); eight `fault-<pane>` scenarios at 24×80 and
12×60 replacing today's two; `rundir-vanishes.steps` (fault 3, degraded within 2 s, `not resumable`, **exit 3**);
`stuck-submit.steps` (fault 5); `readonly-home.steps`; `narrow.steps`; `peers.steps` (two instances in two ptys
against one workspace). Plus a hermetic non-pty integration test that `rm -rf`s the runs dir 1 s into a 40-step
`--plain --mock` run and asserts exit 3 and `not resumable` — the probe that produced the defect.

---

## 11. Gates — every existing gate, plus nine new rows

The eighteen rows of TD3 §9 all stand. The "round 4" column says what changes; a blank means unchanged and the row is
re-run as a regression.

| Gate | Threshold | Round 4 | Evidence |
| --- | --- | --- | --- |
| **first frame** | cold p95 < 300 ms at 40×120 / 24×80 / 8×40; zero network; zero file I/O | **re-measured** (§7.3 wraps the rule and the wordmark that are in frame 1; §7.5's problem list is computed inside `resolveConfig`; §5.5's chat store must be **lazy**); `fullscreen` gains its own geometry | `perf/first-frame.ts`; `JEVCODE_ASSERT_NO_NETWORK` |
| **zero clears outside shrink resizes** | 0 | **strengthened**: the shrink allowance drops from 2 to **1 per driver `resize` step**, counted across that step's **whole two-SIGWINCH transition** — not per geometry segment, which would permit the 2 clears the gate exists to catch (§2.0 consequence (d)). Geometry segments stay keyed on the (rule-width, row-count) **pair** for every width predicate. Baseline: `24×80 → resize 12 60` is 2 today, **1** after §2.2; a grow step is 0 either way | `render-lag.ts` `CLEAR_RE`; `states.ts`; every `.steps` |
| **no `ESC[3J` ever** | 0 in every capture | **new** — `CLEAR_RE` gains a `NO_3J` assertion; a clear is `ESC[2J ESC[H` (§1.4) | `render-lag.ts`, `run-smoke.sh` |
| **no frame taller than the terminal** | `paintedRows ≤ rows` in classic, `=== rows` in fullscreen | **new** — asserted on **every** pty capture, per geometry segment, skipping the first frame after a `resize`; plus `JEVCODE_ASSERT_HEIGHT=1` in development (§1.5) | `perf/pty.ts`, `run-smoke.sh` |
| **lag p95 net < 5 ms** | at `JEVCODE_MOCK_STEP_MS=200` | **re-measured** after §2.2's synchronous commits and §7.8's watchdog timer; a `/config` during a live run must keep it (§3.5's N `emit`s) | `render-lag.ts` |
| **composer keystroke → frame** | p95 < 16 ms, max < 50 ms — idle / live / palette / review / `idle-loop` | **plus two series**: `palette-cycle` (200 **Enter** presses over a 37-row palette, gated) and `palette-arg` (200 Enters in S-ARG over `/mode `, **reported**). Today's gated `palette` series types `/Z…`, i.e. **zero matches and no ghost** — the cheap path; the 37-row + sub-row path has never been gated | `composer-latency.ts` |
| **dynamic fps during a run** | ≤ maxFps + 1 per 1-s bucket, plus the `run-start` bucket | **plus**: `dynamic ≤ maxFps + 1` **while a pane is latched** (§7.1 — today an unlatched persistent throw is unbounded) | `render-lag.ts` |
| **splash bucket** | ≤ 22 dynamic frames within 700 ms | | `render-lag.ts:57–66` |
| **idle animation** (`idle-frames`) | ≤ 4 frames/s peak, mean ≤ 2/s; ≤ 12 KB/s peak, ≤ 5 KB/s mean; 0 clears | **plus** a `live` case: with the mark up during a run (§1.2) the run's busiest second must be unchanged | `src/perf/idle-frames.ts` |
| **line identity** | `transcript.log` == `--plain` == TUI | **strengthened three ways, with two declared truncation clauses**: §2.4 makes the **in-process** normaliser unconditional (it fails today at 40 columns for any 31-cell token) and the **pty** leg row-exact (§2.4's table); §3.5's block normaliser is **declared and executable**, including its two truncation clauses (the `… +N rows (transcript.log)` cap marker and `transcript.log`'s `… +N more rows`, both **asserted**, never skipped); and the `stacked` rung and the SR/`fullscreen` twins each have a declared clause | `round2-transcript.test.tsx`, `round4-identity.test.ts`, `twins.pty.test.ts`, `plain.test.ts` |
| **block width** | no static row produced by a command exceeds the terminal width, at **24×20, 24×24, 24×30, 24×34, 24×37, 24×40, 24×80, 40×120 and 5×16 and 2×10** — the sub-40 widths are the ones the old 40/80/120 sample could not see and are exactly where a width floor overflows (§3.1.2) | **new** | `commands-width.steps` + `round4.pty.test.ts`; plus a unit sweep asserting `max(cellWidth(row)) ≤ blockWidth(columns)` for columns 1…200 |
| **block build time** | `renderBlock` of the largest block at 200 columns < 2 ms | **new** | `block/bench.test.ts` |
| **diff build time** | `diffRows` of 5 000 input lines ≤ 2 ms; `editSummary` of a 4 MiB patch ≤ 5 ms, memoised per `Action` | **new** | `diff/rows.test.ts`, `diff/summary.test.ts` |
| **V22 / V23** | every box row is exactly the frame's rule-row width and none ends in `…`; no continuation row over-indents | **new** (§2.9) | `scripts/pty/polish-check.mjs` |
| **resize matrix** | eleven states × the ladder + a storm: ≤ 1 clear per shrink, 0 per grow, region ≤ rows − 2, V22, V23, 0 forbidden sequences, exit 0 | **new** | `test/pty/resize.pty.test.ts` |
| **scroll latency** (fullscreen only) | scroll key → frame p95 < 16 ms and ≤ 6 KB per scroll frame at 40×120 with 20 000 items; a width-change rebuild < 50 ms | **new**, only under D-S | `src/perf/scroll-latency.ts` |
| **index fold** | < 100 ms at 200 000 index lines (today 581 ms at 51 MB) | **new** | `src/perf/` + `session/index.test.ts` |
| **report bundle** | a 1 GB `transcript.log` bundles in < 5 s and under 200 MB RSS (the current whole-file read cannot) | **new** | `cli/report.test.ts` |
| **rows − 2 at every geometry** | `total ≤ budget` | plus `computeFullLayout` post-condition `total === rows` **exactly** | `layout.test.ts`, `fullscreen/layout.test.ts`, `height.test.tsx` |
| **review invariants** | only `y` approves; Enter inert; no default | **plus**: §4.5's three confirm rows are Enter-inert too, and §4.1's theorem is a property test | `app.test.tsx:342–461`; `review-y/d.steps`; `nav.test.ts` |
| **keys never in logs or frames** | — | **plus** `wizardMinsizeRow` (§2.5) and the OSC 52 drop (§2.7) | onboarding tests; `assertNoKeyBytes` |
| **intake reply wall time** | p95 < 1.5 s live, ≤ 40 ms mock; `thinking seen` 20/20 | plus: the bubble still commits **before** the Jev request with §5.6's marker | `intake-latency.ts` |
| **no new runtime dependency** | `dependencies` = `ink` + `react` | | `pack:check` |
| **harness overhead** | unchanged | | `step-overhead.ts` |
| **hero-frame checklist V1–V23** | every V passes at both geometries and in the twins | V22/V23 added; V13 is **un-deferred** by D-V and becomes "no `k=v` pair and no `\|` separator in any scrollback row **outside the two-entry allowlist**" (`src/loop/plan.ts`'s directive text and `src/session/seed.ts:118`'s seed notice, both read-only this round — §3.6 edge 10). The third producer, `outcome blocked/declined/failed`'s interpolated reason, is **inside `plain.ts`** and is fixed by §3.6's new row, not allowlisted; V21's twin sweep (`--ascii`, `--no-color`, `--no-animation`, `--screen-reader`, 12×60) covers V6–V12 and V16–V18 as before | `scripts/pty/polish-check.mjs`; S6, W5 |

**One gate cannot be signed off from the audits alone** and is called out in §2.1 row 19: the round-3 wordmark under
the resize ladder was never probed, because `src/tui/wordmark.ts` is not in `ec61170`. `wordmarkWanted` depends on no
resize-derived state beyond `rows`/`columns`/`boxed`, and the static sweep shows it is true again at every geometry
≥ 21×64 after any excursion, so it *should* hold — but **it must be probed once round 3 is committed**, with the §2.1
ladder plus `rows-cycle`, asserting ≥ 5 `██` rows in the settled frame after every return to ≥ 21×64.

**Three measurement caveats to carry forward.** (a) A1's latency figures were taken on a machine with load average
5–9, so the absolute p95 of the real fullscreen tree must be **re-measured** before §1.3 is gated; the A-vs-B ratio
(4.5× at 60×200) is robust because both were measured in the same minute. (b) A7's memory result (no growth over
1 200 mock steps) is a 2-minute window in which most time is idle; a 30-minute storm against a **slow** provider
(`JEVCODE_MOCK_JEV_MS=2000`, ~900 steps) is still owed and should run **before** §7.1's latch lands, since the latch
changes the item-append rate under fault. (c) Emoji and ZWJ widths cannot pass through `drive.exp` and stay `manual`
until the driver gains a `sendbytes <hex>` step.

---

## 12. Glossary — every user-visible string this round adds or changes (once; `--ascii` substitutes per TD §14.1)

**Header and renderer.** rule-row brand prefix `◆ jevcode` (`* jevcode`) · the fullscreen position segment ladder
`<n>/<m> · <p> % · PgUp` → `<p> % · PgUp` → `<p> %` → dropped (§1.3.2) · `▲ <n> earlier rows · PgUp` · `▲ <n> earlier rows · see transcript.log` ·
refusals `fullscreen needs 18 rows (now <n>) — the classic renderer is used` ·
`fullscreen needs 40 columns (now <n>) — the classic renderer is used` ·
`fullscreen repaints the whole screen on every key; the classic renderer is used under a screen reader` ·
`fullscreen needs a terminal that supports the alternate screen (TERM=<v>) — the classic renderer is used` ·
`/scrollback is a fullscreen command; your terminal's scrollback already has the transcript`.

**Resize and terminal.** the minsize ladder (§2.5): `terminal <c>×<r> is below the 40×8 minimum — panes hidden,
transcript above` · `<c>×<r> < 40×8 minimum — panes hidden` · `too short: need 8 rows` · `too narrow: need 40 cols` ·
`too small: need 40×8` · `need 8 rows` · `need 40 cols` · `need 40×8` · `40×8 min` · the wizard minsize rows
`setup · key — terminal too small; ≥ 40×8 to type` and the numbered choice row ·
`setup needs a terminal of at least 40×8` · the read-only-wizard toast
`resize to at least 40×8 to continue setup` · the per-item tail `… +<n> rows (transcript.log)` · `TERM=dumb`:
`jevcode: chat needs an interactive terminal; this one reports TERM=dumb, so the plain renderer is used.` +
`· run 'jevcode chat --plain' for the line renderer` · `· or 'jevcode run "<task>"' for a one-shot run` ·
`· or set a real TERM (e.g. TERM=xterm-256color)` · EPIPE `jevcode: stdout closed; run checkpointed at <runs dir>`.

**Recorded by the integrator (2026-09-22), landed on the tree and pinned:**

| string | where | note |
| --- | --- | --- |
| `TERM=unset` | `src/tui/fullscreen/layout.ts`, the absent-`TERM` refusal | the `<v>` of §1.3.1's `TERM=<v>` template when the variable is absent, so the sentence never interpolates an empty string (finding 23) |
| `--fullscreen and --renderer <x> disagree: --fullscreen is the short form of --renderer fullscreen.` | `src/cli/args.ts` | a **usage error**, not a TUI string; §12 covers TUI strings, so it is recorded here rather than added to a row above (finding 14) |
| `-- end of transcript · press any key to return to jevcode --` | `src/tui/terminal.ts` `SCROLLBACK_RESUME_ROW` | §1.3.4: the row `/scrollback` prints under the dump while it waits for a key |
| `nothing to pick — no command matches <token>` | `src/tui/commands/nav.ts` `nothingToPickToast` | §4.2 S-NONE; the palette's Enter/Tab answer once §4.2 is wired (integrator), replacing round 3's `[ui] error: …` submit for that key |

**Review keys rungs (§2.6).** The **default-binding rendering** of the five templates, with their measured cell
widths — `fitRung` selects the first that fits the card's inner width, and a rebinding re-renders and re-measures
them (the letters come from `effectiveBindings()`, never from these literals):
`[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run` *(113)* ·
`[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline` *(76)* ·
`[y] ok [n] no [d] note [e] expand [w] why [esc] decline` *(55)* · `y ok · n no · d note · e exp · w why · esc` *(42)* ·
`y/n/d/e/w · esc` *(15)*.

**Command output (§3).** heads `status` · `cost` · `jev` · `budget` · `config · <n> set, <m> at their defaults`
(narrow: `config · <n> set, <m> default`) · `diff · <n> files · +<a> −<b>` · `diff · step <n> · <path>` ·
`undo · step <n> · <a> restored, <b> skipped` · kv keys `run` `session` `step` `workspace` `sandbox` `per step`
`generator` `jev` `chat` `raise it` `decider` `latency` `cost` `intake` `files` `resume` `report` `restored`
`skipped` · footers `… +<n> settings at their defaults (/config --all)` · `… +<n> default (/config --all)` ·
`… +<n> more files (/diff --all)` · `… +<n> more lines (/diff --full)` · `… rendering stopped at <n> rows (/diff --full)` ·
`… +<n> more rows` · empty states `no decisions yet — they appear from the first step` ·
`no plan yet — Jev writes one at the first step` · `nothing to report — no warnings or errors this session` ·
`nothing pending` · `decider not resolved yet — the first question resolves it` ·
`no runs yet — the session has spent $<a> of $<b>` · `nothing to undo — no run has finished in this session` ·
`nothing to undo — the last run changed no files` · `nothing to diff — no run in this session yet` ·
`nothing to report yet — a run has to finish first` · `history cleared — 0 entries kept` ·
`no settings resolved yet` · `diff · run <id8> · no changes` · the error shape
`error: /<command>[ <arg>] — <what went wrong> — <what to do instead>` · `error: /bogus — not a command. Did you mean
/budget? · type / to list commands` · `error: /undo 2 — step 2 changed no files; steps with changes: 1, 3` ·
`error: /export — <path> is outside the workspace; pass a path inside <ws> or omit it` ·
`error: /steer — needs a live run; type the text and press Enter once one is running` ·
config problem suffixes `✗ expected an integer ≥ 1` (`x expected …`) · `⚠ clamped to <v>` ·
`<key> is not a setting (did you mean <k>?)` · `<n> settings are invalid; run jevcode config --explain <setting> or fix <path>`.

**History (§3.6, engine items — the D-V set).** `started · <badge> · <task>` · `started · <badge> · resumed at step
<n> · <task>` · `intent · <kind> · <p> (confidence <c>)` · ` · Jev answered none_of_these` ·
`context · <n> of <m> files · <bytes> · <a>, <b>, <c> (+<k>)` · `context · nothing to read of <m> candidates` ·
`synth · <phase> · top candidate \`<x>\` · <n> candidates, <k> tested` · `proposal · <kind> <target> · "<goal>"` ·
`risk <p> <verdict> · destructive <l> · irreversible <l>` ·
`risk <p> review · destructive <l> "<level text>" · /why s<n>.risk.destructive` · `review declined · "<note>"` ·
`done · <summary> · exit <n> · <ms> · <n> file<s> (<paths>)` · `read <n> file` / `read <n> files` ·
`judge <p> · no tests · <a> of <b> claims accepted · complete <c>` · `judge <p> · tests <a>p/<b>f/<c>e pass · …` ·
`plan · <n> done · <m> remaining` · ` · rejected "<goal>" (+<k>)` ·
`loop · the same step repeated <n> times · <signature>` ·
`replan · change approach · <p> (confidence <c>) · "<text>"` · ` · task impossible <p>` ·
`git · no repository — changes are not recoverable; /diff <step> compares pre-images` ·
`warning · jev retried <n> times over <s> — gave up` · `pausing · the run stops after step <n>` ·
`steer queued · step <n> · "<text>" · <k> waiting` ·
`finished · <reason> · <n> steps · <wall> · $<cost> (generator $<g> · jev $<j>) · exit <n>` ·
the `[step N]` outcome segment `<n> files +<a> −<b>` and the trailing ` · /diff <n>` ·
`patch failed: <file>:<line> — <message>` · `the file changed outside JevCode`.

**Palette (§4).** the state footers of §4.4 (eleven strings, one per state) · the S-NONE row
`no command matches <tok> — keep typing, or Esc to clear` · toasts `nothing to pick — no command matches <tok>` ·
`/<name> takes no arguments` · `no completions for <arg>` · `no value of /<name> matches <arg0>` · the numbered header
`commands (<n>) — type a number or a name, then Enter` · the one-shot `--plain` prompt
`pick 1-<n>, or type a message > ` · the SR announcement
`palette: <i> of <n> · /<name> · <title> · Enter next, Tab picks, Esc closes` · the numbered tail
`… <n> more — /help commands` · the three confirm rows
`end this session and start fresh? [y] yes   [n] keep it` ·
`abort the run now? the step in flight is discarded. [y] abort  [n] keep running` ·
`leave JevCode? [y] exit  [n] stay  (Enter does nothing)` — **plus the two narrower rungs of each ladder**
(§4.5 lists all nine verbatim with their measured widths; `fitRung` selects against the card's inner width) ·
the status ShortHelp `⏎ next` / `Tab ⇥` (`Enter next` / `Tab` ascii).

**Conversation (§5).** `…(+<n> characters not shown — /copy last copies the whole message)` ·
`<n> lines · ⏎ send` · `line <n> looks like /<cmd>; a submitted message is sent as text — remove it or press Enter again` ·
the status word ` · <n> queued` · `queued message dropped` · `draft cleared — ↑ restores it` ·
`@<path> — no such file in the workspace; it was not attached` · `+<n> more mentions were not attached` ·
`new conversation — earlier turns are no longer sent to Jev` · `resumed conversation — <n> of <m> earlier turns` ·
`(message kept in the composer, not sent)` · the intake card body ladder (§5.6)
`[y] run it   [n] just chatting   (Esc keeps the text · Enter does nothing · Ctrl-C cancels)` ·
`[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)` *(today's, kept)* ·
`[y] run it   [n] just chatting   (Esc keeps it)` · `[y] run it  [n] chat` ·
`copied (truncated to <n> KB)` · SR `working…` and `reply ready`.

**File edits (§6).** the card preview tail `…[+<n> rows · e expands to <m>]` (pre-apply: **no `/diff` token** — §6.3 item 3) ·
`nothing more to expand — /diff <n> after the step` · the summary rows `M <path>  +<a> −<b>` / `A …` / `D …` /
`R <old> → <new>  +0 −0` / `B <path>  binary (<a> → <b>)` · `… +<n> more files` ·
`content withheld (secret path)` · `(deleted)` · `M <path> +0 −0 (mode)` · the SR diff sentences
`change: <n> files, <a> lines added, <b> removed` ·
`file <i> of <n>, <spoken path>, <letter word>, <a> added, <b> removed` · `line <n> removed: <spoken>` ·
`line <n> added: <spoken>` · `line <n> changed: trailing whitespace removed` ·
`… <n> more changed lines; press 3 then diff for the full text` ·
`binary file, <a> kibibytes before, <b> kibibytes after`.

**Hardening (§7).** `ui: <pane> failed (<Error.name>) — run continues; see <log>` · `ui: <pane> failed (<Error.name>)` ·
`the run log (start with --log <file>)` · `ui: <pane> pane recovered` ·
`checkpoint degraded: <code> on <file> — the run directory is not writable; this run cannot be resumed` ·
`files      <dir> — gone (the run directory was removed or became unwritable during the run)` ·
`state.json missing — not resumable` (kept) · the `explainFsError` lines and fixes of §7.4 ·
`run with JEVCODE_DEBUG=1 for the stack` ·
`<n> index lines were unreadable and skipped — run jevcode sessions reindex` ·
`the session index is <n> MB — jevcode sessions prune keeps the recent ones` ·
`run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with jevcode upgrade` ·
`(bundle incomplete)` · `… <n> bytes elided (original <m> bytes) …` · `tar -czf <id>.tgz -C <parent> <id>` ·
`the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave` · `nothing to abort` ·
`another jevcode is working in this workspace (started <t> ago) — /peers lists them` ·
the `/peers` head `peers · <n> here, <m> stale` and its empty state
`no other jevcode is working in this workspace` · `the peer registry is not available in this build` ·
`ui reset — <n> panes unlatched` / `nothing was latched` ·
the peer segment `<n> here` / `<n> stale` and the blocking row
`[w] wait for it   [r] read-only session   [q] quit` / `[c] continue`.

---

## 13. Decision-log entries (ready to append to `docs/DECISIONS.md`)

## 2026-09-21 The brand is pinned inside the hybrid; the literal full screen is an opt-in renderer

The classic renderer (`<Static>` scrollback + a bounded dynamic region) stays the default and gains three visibility
changes: `◆ jevcode` is prefixed to the rule row's strip whenever it fits and is the first segment dropped when it
does not, the 5-row wordmark stays up during a live run at ≥ 32 rows (`WORDMARK_LIVE_MIN_ROWS`) with the idle sweep
frozen, and the wordmark finally renders inside a `PaneBoundary`. The literal "ASCII art at physical row 1" ships as
`ui.renderer: fullscreen` / `--fullscreen`, which **forces** `alternateScreen: true` and `incrementalRendering: true`,
adds an exact-height allocator (`header + rule + viewport + console === rows`), a keyboard-scrolled viewport with
sticky-bottom, a position segment folded into the rule row, `/scrollback`, and an on-exit transcript dump produced by
the same `--plain` formatter; it refuses below 18 rows / 40 columns, under a screen reader, on `TERM=dumb` and on a
non-TTY, falling back to classic with one note. Reason: measured, full screen on the **primary** screen is
unshippable because Ink writes `ESC[2J ESC[3J` at unmount for every fullscreen session and `ESC[3J` deletes the
user's scrollback; on the alternate screen it costs 2.2× the bytes per keystroke at 24×80 and 6.7× at 60×200, misses
the 16 ms composer gate at 60×200 with the default renderer (17.15 ms p95 vs 3.81 ms), takes away wheel scrolling,
find-in-scrollback and whole-session copy, and has a cliff — a tree one row too tall produces a full clear on every
frame (37 clears for 36 frames). The classic changes are ≈ 200 lines and answer the user's sentence for every
terminal size; the renderer answers it literally for anyone who opts in. Consequences: two render trees, whose drift
is prevented by the standing rule that `<FullApp>` reuses every component and only swaps `<Static>` for `<Viewport>`
and the allocator; `RESTORE` gains `ESC[?1049l` when the alternate screen was entered; a new `scroll-latency` probe.

## 2026-09-21 A window resize stops deleting the terminal's history, and a frame is never two widths

Ink's `clearTerminal` is `ESC[2J ESC[3J ESC[H`, and `ESC[3J` erases the terminal's saved lines — the whole scrollback,
including the shell history from before jevcode started — on every shrink resize that overflows the previous frame.
A one-method write proxy (`guardStdout`) rewrites that sequence to `ESC[2J ESC[H`; the declared trade-off is that the
transcript is re-emitted below the old copy instead of replacing it. Separately, the early resize listener now commits
synchronously on **any** shrinking dimension and on **every** width change (with an 8 ms storm guard), and the
50 ms-debounced `wrapColumns` is deleted so the composer body and the box edges are always laid out at the same
width. Reason: measured, a driver `resize R C` on macOS is **two** SIGWINCHes, the rows-only fast path missed the
second, and 4 of 24 frames in a width-change capture carried a box row whose right border was the truncation
ellipsis; the same gap produced 2 clears per shrink whenever a tall overlay was up, against a design bound of 1.
Consequences: the shrink allowance drops to 1, the pty segment is keyed on the (rule-width, row-count) pair, two new
frame predicates (V22 self-consistent width, V23 no over-indented continuation) join the hero-frame checklist, and an
eleven-state resize matrix becomes a suite.

## 2026-09-21 One command-output grammar, and blocks are the same in all three sinks

`block(head, rows: BlockRow[])` replaces the string-array form at all 24 call sites (20 in `session.ts`, 4 App-local); `blockWidth(columns)` — the rung's body width, clamped to
`[1, 160]` — is the one width every body builder receives; five row kinds (kv, facts, table, rule,
note) plus an explicit `gap` (Ink measures an empty `<Text>` at height 0, so a blank separator silently vanished in
the TUI and printed as `[ui] ` with a trailing space in `--plain`); four width tiers at 28/34/60/100; `/config` folds
default-valued rows behind `… +N settings at their defaults (/config --all)` and never folds a row with a validation
problem; every path goes through one `shortPath`; an empty state is never an error and every error reads
`error: /<command> — <what> — <what to do>`. `Engine.annotateBlock` writes the block's rows to `transcript.log` from
the TUI exactly as `--plain` does, capped at 24 rows. Reason: measured, 58 of 109 command-output rows exceeded 80
cells, `/config` alone was 42 rows with a 182-cell widest row because the value column is padded to the longest
value (an absolute path), seven of twelve body builders took no width at all, and the same `/cost` during a run wrote
1 row to `transcript.log` from the TUI and 7 from `--plain`. Consequences: the `--plain` normaliser is written down
and executable; `--json` gains N `ui` lines per live block; `docs/COMMANDS.md` and `CHANGELOG.md` announce it.

## 2026-09-21 D-M is discharged: the history says what happened, in sentences

Every engine item is rewritten in its one formatter (`src/tui/plain.ts`, plus `src/loop/stop.ts`): `k=v` pairs and the
`|` separator are gone, ` · ` is the only inline separator, the run id appears in the epilogue and `/status` and
nowhere else, `run:ready` and the `stop:` line are deleted as items, the risk item drops from eight terminal rows to
one (the audit string moves to the TUI-only detail and `RiskAssessment.reason` itself is untouched, because it feeds
`decisions.jsonl` and the generator prompt), `plan` is emitted only when a count changed, and the `[step N]` row's
outcome segment names the files and their `+a −b`. Reason: the same stop was stated three times in three consecutive
rows; a compact run reads 18 rows instead of 20 and no row breaks mid-token. Consequences: the complete pin inventory
of TUI-DESIGN-4 §3.7 — 14 `plain.test.ts` literals, six loop tests, four session/CLI fixtures, seven pty suites, nine
`.steps` files, `run-smoke.sh`'s compact-transcript regex — and, in the **same commit** as the run-frame group,
`src/perf/pty.ts:800` `END_PATTERN` and `:804` `RUN_STARTED_PATTERN` plus a self-test asserting both still match a
recorded fixture: a silently non-matching `END_PATTERN` would turn the render-lag window into the whole capture and
the gate into a lie.

## 2026-09-21 Enter walks the list, Tab goes deeper, and no run of Enters can destroy anything

The palette model is "Tab goes deeper; Enter runs what is written; Enter with nothing written yet walks the list":
cycling never mutates the draft (the highlight is a dim ghost), the ghost **is** the highlight (one
`paletteGhostFor(query, matches, selected)` instead of a ghost reading `matches[0]` while the marker sits on
`matches[selected]`), the marker resets to the top on every query change (fzf's documented default), and Enter runs
only when the draft is exact **and** the marker is on the draft's own row. That last rule is a provable safety
property: no sequence consisting only of Enter presses can execute `/new`, `/exit`, `/abort` or `/history clear`.
Destructive commands reached **through the palette** additionally get a one-row confirm whose Enter is inert, while a
hand-typed `/exit` still exits at once. Reason: the user asked to "click enter button and toggle through options";
measured, ↓↓Enter on `/` yielded `[ui] error: unknown command /` and left the palette open, the next `/exit` typed
became `//exit` and was submitted as chat, and a `/`-prefixed multi-byte chunk never opened the palette at all.
Consequences: a new pure `src/tui/commands/nav.ts` with an 8×7 state table; ten state-dependent footer strings
replacing one constant; filtered, marked argument sub-rows; a numbered-list twin for `--plain` and the screen reader,
which had no palette at all; and a gated `palette-cycle` perf series, because today's gated series types a query with
zero matches.

## 2026-09-21 The conversation is turns, and it survives a restart

One blank row per **turn**, not per line (a three-line message was three `[you]` turns with a blank row between
every line; a nine-line paste was 17 rows and is now 10); `bubbleLines` keeps blank lines and expands tabs to four
columns so pasted code is not misrepresented; a clipped message says how many characters are missing; a burst of
Enters is N Enters rather than N newlines, so a `/exit` typed on line 4 is no longer submitted as chat; Enter while
thinking queues one submission instead of dropping it, and Ctrl-C drops the queue rather than sending after an abort;
a steer gets its `[you]` bubble so the conversation does not change language mid-session; the `@` denylist, dead code
in the TUI because `dispatchCtx()` never supplied `isDeniedPath`, is wired; and a conversation-only session is minted,
persisted to `sessions/<id>/chat.jsonl` and replayed (the last 20 turns, dimmed) on `/resume` — today it is never
written to disk at all. Consequences: three engine-item text changes ride the D-M commit series; the chat store must
be opened lazily so the 300 ms first-frame gate holds; `jevcode chat --plain` with piped stdin reads one line at a
time instead of slurping stdin as one task, which is a breaking change for scripts and is announced.

## 2026-09-21 File edits get a diff renderer, and four colour roles

`src/tui/diff/rows.ts` is the one place a diff becomes rows — the review card, the `<Static>` detail body and
`/diff <step>` all call it — with a gutter, signs, line numbers, collapsed `diff --git`/`index` plumbing, tabs
expanded inside the row builder so a fixed-width card can never be broken, and a truthful tail that says how many
rows `e` can actually reveal. `ColorRole` gains `added`, `removed`, `hunk` and `diffMeta`, each with its marker
already in the text so `NO_COLOR` loses nothing. `editSummary(action)` names the files and counts of every edit
action, so a `patch` proposal stops reading `18 line unified diff`, the post-apply row stops reading `1 file`, and a
failed patch shows git's whole diagnosis instead of its first `error:` line. Reason: measured, JevCode had no diff
renderer on the review path at all — an `edit` preview was two whole blobs labelled `--- old` / `+++ new`, every
preview and detail row was painted flat `dim` because no diff colour existed, and six of the card's eight preview
rows were spent on plumbing before the first changed line. Consequences: `--mock` gains a `patch` turn and an
unappliable one behind `JEVCODE_MOCK_PATCH=1` (the patch path had zero pty coverage); `/diff`'s head is built short
instead of truncated, which is why `0 skipped)` was provably destroyed at 80 columns; and `/diff --all` stops being
silently re-capped at 60 rows by `clipDetail`.

## 2026-09-21 A pane that keeps throwing degrades once, and a failing checkpoint says so

`guard()` gains a per-pane latch with `PaneBoundary`'s semantics: a deterministic builder throw used to be an
unbounded render-and-dispatch loop committing one `<Static>` item per iteration on Ink's immediate path — an
unkillable flood whose only escape was `kill -9`. Every remaining React-boundary hole is closed, including round 3's
wordmark, which is the idle tenant and was rendering outside every boundary. A failing checkpoint write now emits
`checkpoint:degraded`, sets exit code 3, and the epilogue computes `resumable` from a post-write `stat` and lists
only the files that exist — today deleting or chmod-ing the runs dir mid-run is completely silent and the epilogue
advertises a resume for a directory that no longer exists. A 45 s submission watchdog and an unconditional
second-Ctrl-C exit close the one window in which `host.abort()` does nothing while the App has already dispatched
`run:aborting`. `explainFsError` turns raw errnos into a sentence and a fix, `jevcode config` reports wrong-typed and
unknown settings instead of printing defaults silently, the session index is folded from the tail with a skip count,
and the support bundle carries `state.json`, the rotated log, the launch tier and the locale — streamed and capped
instead of read whole. Consequences: one typed `parseFault` with thirteen scenarios replaces string matching in three
files and rejects an unknown value loudly before Ink mounts, so a typo'd fault in CI fails the test instead of
silently passing.

---

## 14. The review record

### 14.1 Where the audits disagreed, and what this document takes

| # | Topic | A1 | A2 | A3 | A4 | A5 | A6 | A7 | Taken | Why |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | palette Enter | — | — | — | Enter **cycles**; Tab accepts; Enter runs only when armed; provenance-gated confirm | Enter **runs the highlighted row** (opencode / Claude Code) | — | — | **A4** (D-X) | the user's sentence 6 is literally "click enter button and toggle through options", and A4 proved the safety theorem. A5's model is the neighbours' convention, but in JevCode a submitted line is money and three Enters from a rewind menu land on `/new` |
| 2 | the block body width | — | — | `blockWidth(columns) = clamp(columns − 10, 28, 160)` | — | — | `columns() − LABEL_GUTTER`, unclamped | — | **A3's upper clamp with A6's arithmetic, made rung-aware** (§3.1.2) | the same arithmetic; A3 is right that an upper clamp is needed (the identity pty run drives 640 columns, where an unclamped block emits 630-cell rows) and A6 is right that there must be **no lower floor** — a floor of 28 exceeds the rendered body width at every terminal below 38 columns and overflows every row there. The shipped form takes the rung's body width, clamps above at 160 and below at 1 |
| 3 | undoing the palette trap | — | — | — | keep Esc's "keep the draft, remember the token"; fix it with Ctrl-C-clears + `/`-reopens | `closeOverlay` clears a token-only draft | — | — | **A4** | Esc's contract is documented (`App.tsx:862–873`, the Codex rule) and other flows depend on the remembered token; A4's two rules remove the trap without touching it |
| 4 | the narrow-terminal floor | — | stacked ladder below 24 **body cells** (keeps every character, many rows) | — | — | — | — | one **truncated row** below 24 **columns** (bounded, loses the text forever) | **a three-rung ladder plus a per-item cap** (D-AB) | both are right about half of it: A2 keeps the information, A7 bounds the damage. gutter ≥ 34 / stacked 24–33 / flush < 24, with `STATIC_ITEM_MAX_ROWS = 24` **on engine-produced items only** (a command block keeps its own §3.1.5 cap and footer — §2.3's source-keyed exemption, added by review item 26) and a tail naming `transcript.log`, is bounded **and** lossless up to 24 rows |
| 5 | the driver's two SIGWINCHes | — | reorder `stty` to cols-then-rows so the last event is the rows change | — | — | — | — | — | **do not reorder**; add `resize-rows` / `resize-cols`, document the two-event rule, re-key the segment on the pair | once §2.2 commits on both axes the reorder buys nothing and would re-baseline six scenarios' clear counts |
| 6 | block rows in `transcript.log` | — | — | `annotateBlock` (all three sinks match) **or** head-only (one line) | — | — | — | — | **`annotateBlock`** (D-W) | head-only makes `--plain`'s stdout and `--plain`'s `transcript.log` disagree, breaking the standing rule in a second place. `BLOCK_LOG_MAX = 24` bounds the cost |
| 7 | the percent form | — | — | `12 %` (today's `/cost`) vs `12%` (today's `/calibration`) | — | — | — | — | **`12 %`** | TD3 rule 6 already keeps the space for `/cost`; one form, and it is the one the money rows use |
| 8 | timestamps in the scrollback | — | — | — | — | offered a session-relative marker every N turns or after a 10-min gap | — | — | **none** | TD3 rule 5 ("one thought per row") and the round-3 decision; the wall time is in `/why intake` and `--json` |
| 9 | the EPIPE exit code | — | keep 129, add a stderr line | — | — | — | — | 141 or 0 would match shell convention | **keep 129 + the line** | 129 is load-bearing in `EXIT_CODE_TABLE` for SIGHUP; changing it is a compatibility break with no measured benefit, and the missing information was the **message**, not the code |
| 10 | how far `/resume` replays | — | — | — | — | N = 6 (what Jev sees) or N = 20 (what a human re-reads) | — | — | **N = 20** | the ledger carries both numbers, so the heading can say `20 of 137`; 6 is a model-context bound, not a reading bound |
| 11 | sorting generated/vendored files in `/diff` | — | — | — | — | — | out of scope: `.gitattributes` is not free today | — | **out of scope**, recorded | it would add a git call to a command that already spawns git once; revisit when `collectDiffStat` reads attributes for another reason |
| 12 | a latched pane auto-retrying | — | — | — | — | — | — | timer vs explicit unlatch | **no timer**; explicit `resetKey` / `run:start` / `/ui reset`, rate-limited to one attempt per 5 s per pane | a timer risks re-entering the loop at 1/5 Hz, which is the defect in slow motion |
| 13 | degraded exit 3 for a **session** | — | — | — | — | — | — | open | **the process exit code is the last run's**; the degraded item stays in the scrollback and the epilogue of the degraded run says `not resumable` | `EXIT_CODE_TABLE` is written for a one-shot; a session that recovered should not report failure |
| 14 | `jevcode config` exiting non-zero | — | — | — | — | — | — | exit 2 on any problem | **exit 2 on `wrong-type` / `out-of-range`, exit 0 on `unknown-key`** | the first two will fail the next run, so the command that reports them should fail too; an unknown key is a warning and completion scripts read `--json` |
| 15 | paste bodies in prompt history | — | — | — | — | store the body (≤ 4 KiB) or keep the chip label | — | — | **keep the label**; §5.5 P-C16's in-memory slot covers in-session recovery | a paste body in a file is a new secret surface (`maskDraft` masks detected spans only) for a cross-restart case no capture showed |
| 16 | the ambiguous-intake bubble | — | — | — | — | move `say('you', …)` after the intake **or** keep it and add a marker (A5's own edge case a reverses its proposal) | — | — | **keep it, add the marker** | the `intake-latency` gate requires the bubble to commit **before** the Jev request; moving it would break a measured gate to fix a cosmetic one |


---

### 14.2 Review log — every finding of the round-4 design review, and what changed

Thirty-five findings (7 blockers + 1 late blocker set of 6 + majors + minors) were raised against revision 1 of this
document. Every one is applied in place above; this log records **what changed and why**, or **why the finding was
rejected**, with the evidence that decided it. Nothing here is new design: it is the audit trail for the edits.

| # | Sev | Section | Finding | Disposition |
| ---: | --- | --- | --- | --- |
| 1 | blocker | §8 items 4 + 6 | The two `renderer` declarations do not compile together: item 4 put `renderer?` on `UiConfig` while item 6 put a **required** `renderer` on `LaunchSettings`, and `UiConfig extends LaunchSettings` (`src/core/types.ts:1506`) — TS2430, "a derived interface may not weaken a required base property to optional". A required new `LaunchSettings` member also breaks every literal that builds one | **Applied.** Item 6 is now `renderer?: 'classic' \| 'fullscreen'` with the reader idiom `launch.renderer ?? 'classic'` stated once; item 4's duplicate declaration is **deleted** (UiConfig inherits it) and keeps only `fullscreenDump`. Round 3's identical `ssh` precedent (`types.ts:1500–1502`) is cited, and the eight literal sites that would otherwise break in W0 are enumerated. Item 6's file citation corrected to `src/core/types.ts:1483` |
| 2 | blocker | §4.5, §10 S4 | `fromPalette` had two contradictory definitions, and the one an implementer reaches for (`overlay === 'palette'`, how `submit.ts:186` already branches) puts a confirm row in front of **every** hand-typed `/exit`, because `resolve.ts:416` opens the palette on `/` at an empty draft and `App.tsx:1717` leaves it open through `/exit`. That breaks `EXIT_IDLE`, which ends nearly every pty scenario. The cited regression (`exitlast.steps`) never types `/exit` | **Applied.** `fromPalette` is now defined as **a provenance ref set only by an accept or a cycle and cleared by any composer edit, backspace, paste or history recall**, with "NOT `overlay === 'palette'`" stated in bold and the reason given. The citation is replaced with `EXIT_IDLE` (`test/pty/helpers.ts:789`) and the six suites it gates are named; `nav.test.ts` gains the assertion that `/`,`e`,`x`,`i`,`t`,Enter yields `confirm: null` |
| 3 | blocker | §3.5 item 1 vs §6.5 item 6 | Opposite `--plain` block bodies (`[ui] <row>` per row vs bare lines), with the declared normaliser written for only one; §8 item 3's parameter type matched neither | **Applied — one form: `[ui] <row>` per row, today's behaviour, kept.** The bare-line variant is **rejected on the record** for exactly the property §14.1 row 6 rejects "head only" for: `--plain`'s stdout and its `transcript.log` would disagree. A6-16 ("the 5-cell prefix pushes the row out") is closed **by the width contract instead** (§6.5 item 1: the body is built at `blockWidth(columns)`), which is strictly better because it also closes A6-15. §8 item 3's parameter is `lines: readonly string[]` = the **rendered row texts**, and §3.5 now says so |
| 4 | blocker | §3.7 | "The complete pin inventory" omitted an entire pty suite (`test/pty/round3.pty.test.ts`, untracked, 11 anchors) and 8 of the 17 `.steps` files carrying `expect end `, plus `test/unit/perf/render-lag.test.ts:108` | **Applied.** §3.7 is retitled "**regenerated mechanically, 17 `.steps` + 46 source files**", carries the three `grep` commands that generate it, pins both counts in the header, and W4's first act is to re-run and diff them. All 17 `.steps` are named individually; `round3.pty.test.ts`, `interrupts.pty.test.ts:92`, `render-lag.test.ts:108` and `static-append.ts:166` are added as rows |
| 5 | blocker | §3.7 perf constants | The replacement patterns hard-coded `·`, which `--ascii` replaces with `-` (`glyphs.ts:116` vs `:168`, applied by `Transcript.tsx:90` `glyphTwin`), so the V21 twin sweep (`round3.pty.test.ts:252,260`) would stop matching — the R2 failure mode the document itself names | **Applied.** Both constants are **glyph-agnostic**: `'finished [·-] [a-z_]+ [·-] \d+ steps'` and `'\[run\]<SGR> started [·-] '`; `helpers.ts:780` `RUN_STARTED_STEP` and every `.steps` literal take the same treatment, stated as a rule. The R2 guard is extended from "the two `pty.ts` constants" to **every `[run]`/`[step]` anchor in `src/perf/**`, `test/pty/**` and `scripts/pty/**`**, each a named exported constant with a `clearReSelfTest`-style self-test **in both glyph sets** |
| 6 | blocker | §1.2 P-H1 vs F-H1/F-H2, §10 S1, §11 | `brand: !i.wordmark` contradicted the two frames that sell request 1 and the `brand-strip` gate, and its justification was factually wrong about round 3 (`TUI-DESIGN-3.md:729`: "the strip keeps its information; **the mark sits under it**"; `Pane.tsx:66` returns `plainRule` only while `!ranBefore`) | **Applied — they coexist.** P-H1 now passes `brand: true` on every `panelStrip` call; the `!i.wordmark` clause and the "would repeat it" justification are **deleted** and the false claim about TD3 is called out. §10 S1's pin and §11's `brand-strip` gate are reworded to "present after a run at 80 **whether or not the mark is up**" |
| 7 | blocker | §3.1.2 vs §2.3 (also raised as major "blockWidth vs the narrow ladder" and "colliding tier names") | `blockWidth`'s floor of 28 **exceeds** the rendered body width at every terminal below 38 columns, so every block row overflows at columns ∈ [34,37] ∪ [24,29] ∪ [1,23]; the gate sampled only 40/80/120; and "stacked" named two different things keyed on two different quantities | **Applied, all three.** `blockWidth` is **rung-derived** (`columns − 10` / `columns − 2` / `columns`, clamped `[1, 160]`, **no lower floor** — "a floor above the available width is the bug"). §3.1.2's tiers are renamed `tight` / `narrow` / `standard` / `wide` so only §2.3's rung is `stacked`, with one sentence saying `renderBlock` takes the *width* and `TranscriptRow` the *columns*; F-B4's caption is corrected. The `commands-width` gate gains **2×10, 5×16, 24×20, 24×24, 24×30, 24×34, 24×37** and a unit sweep over columns 1…200 |
| 8 | major | §2.0, §2.1, §11 | "≤ 1 clear per shrink segment" is not a tightening once segments are keyed on the pair: one driver `resize` becomes two segments, each allowed one clear — exactly the 2 A2 measured | **Applied.** The budget is restated as **per user resize**: ≤ 1 clear across the whole two-SIGWINCH transition of one driver `resize` step, with the segment still keyed on the pair for every *width* predicate. A falsifiable baseline is given (`24×80 → resize 12 60`: 2 today, 1 after; a grow step 0 either way). §2.0 gains consequence (d) with the `ink.js:278–291` evidence |
| 9 | major | §2.4, §11 | The cut-aware join cannot be computed on the pty side (the rows come from a capture, no `WrappedBody` in scope), and the new `normaliseRows` signature was never given | **Applied.** The signature is given (`normaliseRows(rows, cuts = [])`, default preserving today's behaviour) and the two legs are separated in a table: the **in-process** legs pass `cuts`; the **pty** leg does not join at all — it re-runs `wrapBodyCut` on the expected text and compares **row for row**, which needs no cut list and is strictly stronger. §11's wording now says which leg is unconditional |
| 10 | major | §2.6 P-R7 | Two of five declared thresholds did not match their strings (the `36+` rung is **42** cells, the `120+` rung **113**), so a literal `cells >= 36` truncates it at 36–41 — the defect P-R7 exists to fix | **Applied.** `fitRung(rungs, cells)` is specified as "the **first** rung whose `cellWidth(rung) <= cells`"; the thresholds are **deleted** and replaced by the measured widths 113 / 76 / 55 / 42 / 15 as labels, asserted in `review/lines.test.ts`. The `120+` rung becoming reachable from 113 inner cells (117 columns) is stated, with the two captures that re-baseline |
| 11 | major | §2.5 P-R4 | The top rung's threshold (71) is one cell short of its own string (**72**), and the string's width varies with the substituted dimensions (73 at `100×5`, 75 at `100×120`) | **Applied.** The rung is selected by measuring the **formatted** candidate through `fitRung`; the numeric thresholds are dropped and the widths kept as illustrative measurements of the `30×5` rendering. `overlay.test.tsx`'s sweep gains three-digit dimensions |
| 12 | major | §9.1 / §9.2 | Seven changes land in files owned by a slot other than the section's owner with no §9.2 request row; two new commands had no registry owner; `fitRung` had no home module; `src/tui/index.ts` was in no slot's list | **Applied.** Eight rows added to §9.2 — `src/cli/fatal.ts` (S1's `1049l`, S2's EPIPE line), `session.ts:325–327` (S2's P-R10), `src/cli/epilogue.ts` (S6's `files` row), `src/chat/lines.ts` and `src/tui/blocking/lines.ts` (S2's `fitRung` requests), `src/tui/index.ts` (the `createResizeDebounce` removal, with its public-API export at `:74` and its two tests at `terminal.test.ts:53–67`), `src/tui/layout.ts`. **`fitRung` gets a home: `src/tui/fit.ts` (new, S2).** The registry row now names all four new commands |
| 13 | major | §1.2 P-H1 edge (9) | A dangling cross-reference: six fixtures deferred to §3.7, which contains no rule-row entry | **Applied.** The fixtures are **enumerated in §1.2 itself** (13 sites across `round2-lines.test.ts`, `app.test.tsx:106`, `height.test.tsx:94`, `round3-wordmark-app.test.tsx`, `splash.test.ts:216`, `round2.pty.test.ts:557`, `round3.pty.test.ts:136`, `states.ts:278`) with a sentence saying why §3.7 does not list them (disjoint sets), and `app.test.tsx:106` is declared as a carve-out |
| 14 | major | §4.2 | The eight predicates were neither disjoint nor total and no precedence was given, yet §10 turns the table into one assertion per cell | **Applied.** `paletteNavState` is specified as an **ordered if-chain** (NONE → ONE/BROWSE → ARMED/PICKED → FREE → ARGDONE → ARG → ARGBAD) shown as code; every table row names its chain position; `arg0` is defined as `null` with no whitespace and `''` when the draft ends in one; `nav.test.ts` asserts **totality and disjointness** as a property test |
| 15 | major | §3.0, D-U, §13, §10 S3, §4.6 | Four different counts of two quantities (17 / "17 + 4" / 21 `block()` sites; 37 / 39 commands) | **Applied.** All replaced with the measured values: **20** `block()` sites in `session.ts` (each line listed; the definition at `:1364` excluded) + 4 App-local = **24**, in D-U, §3.0, §9.3 W2 and §13; **37 commands today, 41 after this round**, in §4.6's header and block, §10 S3, the `rank` cost and the glossary. The four new commands are added to §9.2's registry row |
| 16 | major | §7.13 (f) vs §2.5 edge (3) and `layout.ts` | Opposite behaviour at `rows === 1`; the change contradicts `layout.ts:155–158`'s static-only branch, which no slot is told to touch | **Applied — (f) is withdrawn.** The static-only contract stands; the row now says so, with the code cited and the cost of the alternative spelled out. Instead: one documented sentence in `docs/TUI.md` plus the existing one `<Static>` item per size drop. §9.2's `layout.ts` row records "**no `rows < 3` change is requested**" |
| 17 | major | §3.1.3 vs §5.2 P-C4 | "`formatTranscriptItem` never produces a label-only row" is falsified by P-C4's `trimEnd()` in the same document, leaving the normaliser unable to tell a block `gap` from an empty chat bubble line | **Applied.** §3.1.3 now reads "a **block** never emits a label-only row; an empty **chat** item does (§5.2), and the normaliser distinguishes them **by label**" — a row that is exactly a label is a chat blank line and is compared; a row that is empty with no label is a `gap` and is dropped. The Ink premise (`<Text>{''}</Text>` is height 0) is marked as verified |
| 18 | major | §5.6 P-C17 | The fit-check numbers were wrong in both direction and magnitude (claimed 96/70/39; the substitution gives **92**/70/39), and the new body dropped `(Enter does nothing)` — the statement `Overlay.tsx:34–36` documents as justifying the inert Enter | **Applied.** The numbers are corrected and the error called out. The intake body becomes a **`fitRung` ladder** whose top rung carries **both** clauses (91 cells) and whose second rung is today's 73-cell string unchanged, dropping `Ctrl-C cancels` **before** `Enter does nothing`. The three flat tiers stay 95 / 70 / 39 (unchanged — the wide row keeps today's body), pinned by measurement in `chat/lines.test.ts` |
| 19 | major | §5.6 P-C17(c) | "a `/`-leading line is dispatched as a command" has no mechanism: the intake collapses the composer (`App.tsx:2268` passes `EMPTY_BUFFER`), so there is nowhere to type the rest of the line | **Applied — option (ii) taken.** The TUI keeps today's swallow with **Esc as the documented escape route** (now named in the card body); option (i) (re-open the composer behind the card) is recorded and rejected with its cost. **§5.7(b) keeps the `--plain` half**, which works because readline hands over a whole line. The measured defect is closed by the body text plus §5.7(b) |
| 20 | minor | §1.4 | The clear sequence is **11** characters, not 9; old Windows' `clearTerminal` carries no `3J` at all | **Applied.** "the 11-character sequence", with `ansi-escapes/base.js:124–130` cited; edge (11) now asserts "**no `3J` appears in the capture**", never "the filter fired" |
| 21 | minor | §2.2 P-R1, §7.8 edge (4) | The patch calls an undefined `nowMs()`, and the clock it resolves to (`App.tsx:561` `Date.now`) is the one §7.8 forbids for a deadline | **Applied.** `nowMs()` is **defined once in §2.2** as `performance.now()` and both timing sites (P-R1's 8 ms storm guard, §7.8's 45 s watchdog) are pointed at it; §7.8 edge 4 now references that definition instead of restating the hazard |
| 22 | minor | preamble and §5 | §5's anchors are `ec61170` while §7's are the working tree, with no marker | **Applied.** §5 opens with a blockquote anchor note naming the three anchors that differ (`App.tsx:1039`, `:1058`, `:905–906`) with both trees' values, and confirming §7's are working-tree-correct |
| 23 | minor | §8, §3.6, §6 | Nine wrong file/line citations | **Applied.** `UiConfig` `:1506`, `SessionHost` `:1538`, `Renderer` `:1617`, `LaunchSettings` `src/core/types.ts:1483`, the git banner → `gitBannerLine` in `src/workspace/gitstate.ts`, `epilogue.ts:75–81` with `files:78` / `resume:79` / `report:80`, `CAP.exitConfirm` `layout.ts:36`, the preview allocation `layout.ts:183`, `Pane.tsx:66,71,72` |
| 24 | minor | §9.2, §3.3 | `CommandSpec.category` already exists (`registry.ts:45,62`) and `configTableLines`/`Rows` already take `{ all }` (`config-table.ts:70,104`) | **Applied.** Both rows now say what is actually missing: the `--all` **flag spec** and arg plumbing, and the **help grouping that consumes the existing `category`** |
| 25 | minor | §3.6 vs F-H1/F-H3 | Two different `[run] end` texts and a self-contradictory segment-order rule | **Applied.** **One form** — the generator/jev parenthetical is always present, with the reason (it is the split a user checks when a bill surprises them) — and F-H1, F-H3 and the compact-run frame are **redrawn** with it (all three re-validated for width and row count). The segment rule is reworded: "cost last **of the always-present segments**; the optional ` · /diff <N>` hint follows it and is dropped first" |
| 26 | blocker | §2.3 (D-AB) vs §3.3 edge 4, §3.1.5, §6.5 item 3 | The per-item row cap and the block caps contradict each other, and the cap silently destroys every "see the rest" escape hatch — `/diff --all`, raised to `Infinity` to close A6-5, would become *worse* than A6-5 | **Applied — the cap is keyed on the item's SOURCE.** `STATIC_ITEM_MAX_ROWS` applies only to **engine-produced** items; an item carrying `detailRows` from a command block is **exempt** (it has its own §3.1.5 cap and footer). A three-row table in §2.3 states it, §3.3 edge 4's contradictory sentence is rewritten to point at the exemption, and a unit case pins `/diff --all` at 10 columns keeping its full row count |
| 27 | blocker | §4.2 S-ARG / S-ARGDONE | A two-argument command could not be run from an open palette: `tail` = "the text after the first run of whitespace" makes `/budget spend-cap 5` S-ARG, where Enter cycles forever and the only exit is Esc. The same trap caught any mistyped enum value | **Applied.** `tail` is split into **`arg0`** (the *first* token) and **`restTail`** (the remainder, never part of a predicate), so `/budget spend-cap 5` is **S-ARGDONE** and Enter runs. A ninth state **S-ARGBAD** is added for an arg-0 token matching no value, whose Enter **runs** so `dispatchCommand` reports the error instead of the key being inert. `nav.test.ts` gains the four cells and a pty `palette-arg2.steps` is added |
| 28 | blocker | §5.1 vs F-C1 / F-C2 | The two frames dropped the label on every continuation row, contradicting §5.1's own rule, the code (`Transcript.tsx:200` renders it unconditionally) and the captured product (`auto-24x80.txt:238,242`) — and breaking line identity for every multi-line message | **Applied — the frames are redrawn.** F-C1 and F-C2 now show the dim label in the gutter on **every** continuation item, including the surviving blank line of a paste. §5.1's row gains "including the item that is a surviving blank line" and keeps the **colour only** classification, and F-C2 carries an identity note explaining why the labelless form would have failed the gate |
| 29 | blocker | §11 V13 vs §3.6 edge 9, §0 | V13 ("no `k=v` in any scrollback row") cannot pass: three `k=v` producers reach the scrollback and none was in scope — `outcome blocked`'s interpolated reason (which also *triplicates* the risk text, the defect D-V claims to remove), `src/loop/plan.ts`'s directive text and `seedNoticeText` | **Applied.** §3.6 gains a **new row** for `outcome blocked / declined / failed` that renders a one-row **summary** (dominant dimension + level + clipped level text) with the full reason as the TUI-only `detail`; the epilogue and `decisions.jsonl` keep the raw string. The other two live in modules that are **read-only this round**, so they become a **declared two-entry V13 allowlist** written into `polish-check.mjs` with a reason and a `TODO(round 5)` each, and §11's V13 wording says so |
| 30 | blocker | §3.7 vs §9.1's test-file rule | `test/unit/tui/app.test.tsx:158, 602` assert the exact `[run] ready … step 0/40` item D-V deletes, in a file §9.1 forbids every slot from editing | **Applied.** Both lines are added to §3.7 as a row and declared **the one carve-out**: in **W0**, before any D-V commit, S5 moves the two assertions verbatim into `round4-chat-app.test.tsx` and deletes them from `app.test.tsx`; no other line of that file is touched. (`app.test.tsx:106`, the rule-row pin, is a second carve-out, declared in §1.2) |
| 31 | blocker | §11 V17, `polish-check.mjs` | D-V turns V17 into a vacuous pass: the anchor `/^ {0,9}\[run\] end /` never matches after the rewrite, `endAt` is `-1`, and the gate reports success with "no run ended in this capture" | **Applied.** `polish-check.mjs:397` is added to §3.7 G1 with its exact replacement as a **named exported constant** `RUN_END_RE`, and the R2 rule is generalised: every `[run]`/`[step]` anchor in `src/perf/**`, `test/pty/**` and `scripts/pty/**` is a named constant with a two-glyph-set self-test, and **a zero-match anchor is a hard failure, never a vacuous pass** |
| 32 | blocker | §1.3.3 (D-S) | `Home`/`End` are **not** free in the composer context — `bindings.ts:92,93` bind `composer:lineStart` / `lineEnd` to them — so a fullscreen user would lose both while typing, or the resolver changes without being listed anywhere | **Applied.** The viewport takes **`Ctrl+Home` / `Ctrl+End`** instead; PgUp/PgDn and Shift+↑/↓ are kept and each is re-checked against `bindings.ts`. The resolver, `docs/KEYS.md`, `completions/*` and `man/jevcode.1` stay untouched, which is what §1.3.5's discipline requires |
| 33 | blocker | §4.5 | All three confirm rows (87 / **101** / 87 cells) overflow the card's 76 inner cells at 24×80, truncating away the keys and `(Enter does nothing)` on the *safety* surface of the whole Enter-cycling model — a defect the product already fixed once for the exit confirm (`Overlay.tsx:31–39`) | **Applied.** Each of the three becomes a **`fitRung` ladder** with three rungs and measured widths (76/55/28, 79/64/22, 55/30/22), selected against the card's inner width. The abort ladder's drop order is justified (the *consequence* is the safety information at the top rung; the Enter clause returns once the sentence no longer fits). `overlay.test.tsx` asserts for widths 20…200 that the chosen rung fits **and** still contains `[y]` and `[n]`; §9.2 routes `Overlay.tsx` as an S4→S2 request |
| 34 | major | §3.1.2 vs §2.3 | (Same defect as 7, raised from the other side: command output provably overflows on narrow terminals and the new gate cannot see it) | **Applied with 7.** The gate's geometry list now reaches 2×10 |
| 35 | major | §3.1.2 vs §2.3 | (Same as 7's third part: colliding tier names on different quantities, with the demonstration frame drawn in the overlap) | **Applied with 7.** Tiers renamed; F-B4's caption names both axes |
| 36 | major | §6.2 | An added line rendered with **no line number**, and `DiffRow.newNo` was a field the row shape never placed — worst in the commonest case (a `write` preview: 3 000 blank number cells) | **Applied.** A6's **two-column** form is restored (`old` and `new`, each blank where that side has no line), with the column widths given and the `< 60` / `< 20` degradations specified (old column drops first, then both). `diff/rows.test.ts` gains the pure-addition case and the width cases |
| 37 | major | §6.3 | The card's escape hatch pointed at `/diff 4`, which cannot be typed while the card swallows printable keys and has no checkpoint image pre-apply — a dead command, which §6.6 edge 6 forbids | **Applied.** The pending card's tail is **`…[+N rows · e expands to M]`** with no `/diff` token; F-E1 is redrawn and the glossary entry updated. The pointer stays where it is already conditioned correctly: the post-apply `[step N]` row and `/why`. `review/lines.test.ts` asserts no `/diff` token in a pre-apply tail |
| 38 | major | §4.6 vs §4.5 | `--plain` gained a brand-new *selection* surface and was then exempted from the confirm gate, and the one-shot `pendingList` was invisible, so `/` then a genuine numeric prompt would execute a command | **Applied.** The numbered pick is **`fromPalette: true`** (the confirm applies, as a readline `y/N`), and `pendingList` is made **visible** by changing the prompt for that one turn to `pick 1-41, or type a message > `. A4's open question 5 is answered explicitly (no `#3` prefix needed — the changed prompt is the disambiguator) instead of silently. Four `plain-composer.test.ts` cases added |
| 39 | major | §3.5, §2.3, §11 | §11 claimed identity was "strengthened three ways" while §3.5 and §2.3 each introduced a *new* exception the normaliser text did not mention, one of which **skipped** the gate for the longest items | **Applied.** Both exceptions are written **into the normaliser paragraph** as clauses (a) and (b), each an **assertion** (compare the rows before the marker; assert its `N` equals the number dropped), never a skip; §2.3's "the identity test skips items" sentence is replaced by a pointer to clause (a); §11's row reads "strengthened three ways, **with two declared truncation clauses**" |
| 40 | major | §1.4 edge 12 | The stated cost ("the transcript appears twice") understates an unbounded one: Ink writes `clearTerminal + fullStaticOutput + outputToRender` in one write and `fullStaticOutput` is append-only, so **N clearing frames leave N+1 copies**, and clearing frames fire continuously while dragging a window edge | **Applied.** The real bound is stated with the `ink.js:768, :354, :416, :279–286` evidence, and **a mitigation ships with the filter** (A1's alternative, answering its open question 2): `guardStdout` also elides the `fullStaticOutput` prefix that immediately follows a rewritten clear, so the copy count stays at 1 and the real history remains in the terminal's saved lines. Two new pty assertions bound **bytes per shrink step** and the number of `[run] started` occurrences |
| 41 | major | §7.1, §7.10 | `/peers` appears in shipped user-facing copy and `/ui reset` in the unlatch rule; neither existed, was specified or was owned — violating the product's own "never a dead command" | **Applied.** Both get full specs (registry entry with `category`, args, availability; block output; empty state; the stub's "not available in this build" row; a `--plain` twin; a `dispatch.test.ts` case), §12 glossary entries, §9.2 registry rows and a place in `round4-identity.test.ts`'s 41. The stale "`category` field" request is corrected (finding 24) |
| 42 | major | §5.6 P-C17(b) | (Same as 18, raised from the copy side: the rewritten body deletes the one sentence explaining the inert Enter) | **Applied with 18.** Both clauses are kept at the wide rung and the drop order is specified |
| 43 | major | §2.6 P-R7 | Edge 4 requires the letters to be derived from the effective bindings while the body gave five verbatim literals selected by fixed thresholds — the two cannot both hold, and either horn shows a reviewer a wrong key or picks a wrong rung | **Applied.** The rungs are **templates** with `{approve} … {abort}` slots filled from `effectiveBindings()`, and `fitRung` measures the **rendered** string. §12's five literals are pinned as the *default-binding rendering* with their measured widths; `review/lines.test.ts` gains a case with approve rebound to `ctrl+y` |
| 44 | major | §7.13 (f) | (Same as 16) | **Applied with 16.** (f) is withdrawn |
| 45 | major | §1.3.2, §12 | Two of the four fullscreen tiers had byte-identical rows, two had no text / frame / string, and the position segment had no ladder at the stated 40-column minimum — where it would eat the whole strip | **Applied.** `hero` and `tall` are **merged** into one `≥ 24` row; the `compact`/`narrow` header is identified as §1.2 P-H1's strip verbatim (no second string to specify); the position segment gets a **four-rung ladder** (`24 → 13 → 4 → dropped`) with its drop order relative to the brand; and **two new frames** are added and width-validated: **F-H4** (fullscreen compact, 20×80, exactly 20 rows) and **F-H5** (fullscreen narrow, 24×44, exactly 24 rows, every row ≤ 44) |
| 46 | major | §2.5 P-R6 | Whether key input still reaches the wizard at minsize was undefined, and edge 2 and §12's string implied opposite answers — with an invisible masked API-key field as the hazard | **Applied.** **One answer, stated once: at minsize the wizard is read-only.** Keys are consumed and produce the toast `resize to at least 40×8 to continue setup`; §12's string is normative; edge 2's `•` count is clarified as a **progress indicator for text already entered at a larger size**, never an invitation. Esc and Ctrl-C are unchanged, and growing back restores the wizard with the draft intact. `onboarding/lines.test.ts` asserts a key at minsize causes no reducer state change |

**Three things the review found that are *not* changes to this document, recorded so they are not re-litigated.**
(a) The Ink premise behind `gap` was independently verified (`<Text>{''}</Text>` is height 0, `<Box height={1}/>` is
one row) — §3.1.3 now says "verified". (b) §14.1 row 2's quotation of A3's original `clamp(columns − 10, 28, 160)` is
left verbatim: it is what A3 proposed, and the row now explains that the shipped form keeps A3's upper clamp and
drops its lower floor. (c) `test/pty/smoke/exitlast.steps` remains a valid scenario; it is simply not the regression
that pins a hand-typed `/exit` (that is `EXIT_IDLE`), and §4.5 now says which is which.
