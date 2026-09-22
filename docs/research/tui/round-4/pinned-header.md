# Round 4 · Topic A1 — "jevcode stays up on top": the pinned-header architectures

Measured 2026-09-21 on macOS 26 (Darwin 25.6.0), Node 22.23.2, Ink 7.1.1, React 19.3.0, `TERM=xterm-256color`,
load average 5–9 (other round-3 agents were running pty suites on the same machine — every latency figure below is
therefore an upper bound, and byte figures are exact).

**Method.** All running was done in a throw-away worktree of the last committed tree
(`git worktree add /tmp/jevcode-r4-header ec61170`, `npm run -s build` → `dist/jevcode.mjs` 2.24 MB, build smoke
"first frame ok (54 ms)"); nothing in the main checkout was built, run or edited. Two kinds of probe:

1. **Architecture prototypes** — two standalone Ink apps (`pinned-header-probe/proto.mjs`, `lib.mjs`) rendering the
   same content two ways: `PROTO_MODE=full` (option A: one `rows`-tall tree, header pinned at the physical top,
   scrolling viewport, no `<Static>`) and `PROTO_MODE=hybrid` (option B: `<Static>` scrollback + a bounded dynamic
   region, exactly what JevCode does). Driven through `scripts/pty/drive.exp` in a real pty (every pause is a
   draining sleep — research 20 §5), 60 printable keys 100 ms apart (`pinned-header-probe/keys.steps`).
   `process.stdout.write` is wrapped inside the prototype, so **bytes and key→write latency are measured on the real
   tty write path**, not inferred from the capture.
2. **Product probes** — the built `bin/jevcode.js` from the worktree, `chat --mock`, temp `JEVCODE_HOME`, temp
   `--workspace` copy of `examples/demo-py`.

Artefacts: `docs/research/tui/round-4/pinned-header-probe/` (`results.jsonl`, the prototypes, the step files, the
gzipped captures, `ink-mouse-input.log`, `mem-20000.json`).

---

## 1. Where the wordmark actually is today, in physical rows

The dynamic region is written by Ink's log-update **after** the `<Static>` output, so once the transcript has filled
the screen the region occupies the **last** `total` rows of the terminal. `computeLayout` (`src/tui/layout.ts:150`)
allocates, top to bottom, `rule · live · banner · pane · queue · overlay · preview · console`
(`src/tui/App.tsx:2157–2276` renders in that order). Round 3's idle frame with the mark is
`rule 1 + pane 5 + chrome 3 + composer 1 + status 1 = 11` rows (TUI-DESIGN-3 §3.2 table, "idle, no run yet": 11).

The mark therefore sits at physical rows `r−9 … r−5`:

| terminal rows `r` | dynamic rows | wordmark physical rows | top of the mark, as % down the screen |
| ---: | ---: | --- | ---: |
| 24 | 11 | 15–19 | 58 % |
| 30 | 11 | 21–25 | 70 % |
| 40 | 11 | 31–35 | 78 % |
| 60 | 11 | 51–55 | 85 % |

**The taller the terminal, the lower the mark sits.** That is the user's complaint in one table: the mark is not
"up top", it is bottom-anchored, and it is *more* bottom-anchored on a big screen. It is also absent in most states —
`wordmarkWanted` (`src/tui/wordmark.ts:77–94`) is false while a run is live, while a panel or picker owns the slot,
while a review is pending, below 21 rows (`WORDMARK_MIN_ROWS`, `:38`), below 64 columns
(`WORDMARK_MIN_COLUMNS`, `:36` / `layout.ts:17`) and under a screen reader.

The only state in which the mark *is* near the top is the first frame of an empty session, because there is no
scrollback yet (see `docs/live/tui/round-2/final-typesafe-24x80.txt:1–12`: the `[run]` header row, the rule, five mark rows and
the five console rows — physical rows 1–12 of a 24-row terminal, with rows 13–24 blank).

The rule row directly above it is the brand row `─── ◆ jevcode 0.3.0 ───` **only until the first `run:ready`**
(`src/tui/Pane.tsx:98–108`: `if (!i.ranBefore) return brandRow(...)`, otherwise `panelStrip(...)`). After the first
run the word "jevcode" disappears from the dynamic region entirely except inside the console's top-edge title
(`JevCode ─╮`, right-aligned).

---

## 2. Ink 7.1.1 facts that decide this question (read, not assumed)

| # | Fact | Where |
| --- | --- | --- |
| I1 | `alternateScreen` is a real mount option; it writes `ESC[?1049h` + hide-cursor in the constructor and `ESC[?1049l` + show-cursor at unmount; it requires `interactive && stdout.isTTY` | `node_modules/ink/build/ink.js:256, 699–712, 546–553` |
| I2 | Alternate-screen content is discarded on teardown **by design**: "leave it active until React cleanup finishes, then restore the primary buffer without replaying prior frames" | `ink.js:540–553` (comment), `:548–552` |
| I3 | `incrementalRendering` selects a per-line diffing log-update that rewrites only the rows that changed (`cursorTo(0) + line + eraseEndLine`) | `ink.js:218`; `node_modules/ink/build/log-update.js:104–207` (`createIncremental`) |
| I4 | Default is `incrementalRendering: false`, `alternateScreen: false`, `maxFps: 30` | `node_modules/ink/build/render.js:13–20` |
| I5 | JevCode already plumbs the choice: `--render-mode standard\|incremental`, default `standard` | `src/config/launch.ts:39, 104–106, 127–137`; `src/tui/App.tsx:2435` |
| I6 | A frame is "fullscreen" when `outputHeight >= viewportRows`; it then gets **no trailing newline** | `ink.js:748–755` |
| I7 | `clearTerminal` is written when `wasOverflowing ∨ (isOverflowing ∧ hadPreviousFrame) ∨ isLeavingFullscreen ∨ (isUnmounting ∧ wasFullscreen)`, where overflowing is `height > viewportRows` (strictly) | `ink.js:88–111`, used at `:756–776` |
| I8 | `clearTerminal` is `ESC[2J ESC[3J ESC[H` — **`ESC[3J` erases the terminal's *saved lines*, i.e. the scrollback** | `ansi-escapes` (printed: `"\u001b[2J\u001b[3J\u001b[H"`); written at `ink.js:768` |
| I9 | The clear write is `clearTerminal + fullStaticOutput + frame` — the **entire** accumulated `<Static>` output is re-emitted | `ink.js:768`; `fullStaticOutput` accumulates at `:416` and is only reset when the `<Static>` node identity changes (`:325–327`, `reconciler.js:100–105`) |
| I10 | Every cursor motion Ink emits is **relative** (`CUU ESC[nA`, `CUD ESC[nB`, `CNL ESC[E`, `CHA ESC[1G`, `eraseLines` = `ESC[2K ESC[1A …`); the only absolute motion is the `ESC[H` inside `clearTerminal` | `ansi-escapes` (printed), `log-update.js:44–52, 160–190` |
| I11 | `resized()` does **not** reset `lastOutputHeight`; only `endSuspend()` does (`lastOutput=''`, `lastOutputHeight=0`, `log.reset()`) | `ink.js:279–291` vs `:927–944` |
| I12 | Under a screen reader Ink bypasses log-update entirely and rewrites `eraseLines(lastOutputHeight) + wrapAnsi(whole frame)` on every change | `ink.js:370–412` |
| I13 | `suspendTerminal()` (Ctrl+Z, `$EDITOR`) leaves and re-enters the alternate screen and forces a full redraw | `ink.js:894–900, 925–944` |
| I14 | **Ink has no mouse parser.** An SGR mouse report reaches `useInput` as literal text | measured, see §3.7 |

The existing design already rejects the alternate screen three times on the record: `docs/TUI-DESIGN.md:66` (F2),
`docs/research/tui/07-terminal-protocols-edge-cases.md:29, 383, 815`, `docs/research/tui/01-opencode.md:637`
("opencode's own `--mini` mode had to invent split-footer + capture-stdout to give it back"),
`docs/RESEARCH.md:243` item 6. And the zero-clear gate's regex already counts `ESC[?1049h/l` as a clear:
`CLEAR_RE = /\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049[hl]/g` (`docs/TUI-DESIGN.md:1903`).

---

## 3. Measurements

### 3.1 Keystroke cost — bytes on the wire and key→write latency

60 keys, 100 ms apart, 200 transcript items. `bytes/key` is the byte total of every `stdout.write` in the window
between one key and the next. `frames/60` counts keys that produced their own write; a number below 60 means frames
were coalesced (a write bigger than the ~1 KB macOS pty buffer blocks the child synchronously until the reader
drains — research 20 §5 — so the *larger* frame also costs *more* coalescing).

| # | architecture | geometry | render mode | bytes/key | key→write p50 | **p95** | max | frames/60 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | **B hybrid** (today) | 24×80 | standard | **1 695** | 1.84 | **3.31** | 3.91 | 56 |
| 2 | B hybrid | 24×80 | incremental | 145 | 1.83 | 2.62 | 4.83 | 57 |
| 3 | B hybrid | 40×120 | standard | 2 355 | 2.54 | 4.27 | 4.55 | 30/30 |
| 4 | B hybrid | 60×200 | standard | 3 675 | 2.70 | 3.81 | 4.56 | 27 |
| 5 | **A full-screen** | 24×80 | standard | **2 855** | 6.16 | **9.76** | 12.50 | 35 |
| 6 | A full-screen | 24×80 | incremental | 181 | 3.23 | 7.45 | 11.15 | 60 |
| 7 | A full-screen | 40×120 | standard | 5 241 | 7.88 | **15.72** | 18.38 | 23/30 |
| 8 | A full-screen | 60×200 | standard | **8 585** | 9.96 | **17.15 ✗** | 17.15 | 12 |
| 9 | A full-screen | 60×200 | incremental | 409 | 9.15 | 12.48 | 16.41 | 60 |
| 10 | A full-screen **+ alt screen** | 24×80 | standard | 2 855 | 4.37 | 7.21 | 7.98 | 34 |
| 11 | **A with a tree one row too tall** (`height = rows + 1`) | 24×80 | standard | 2 760 | 4.67 | 7.35 | 8.10 | 36 |

Product baseline for calibration (`bin/jevcode.js chat --mock`, 24×80, 60 keys, `product-base-24x80.cap.gz`,
`product-type60.steps`): **1 286 bytes/key** over the typing window, 79 frames, **0 clears** — consistent with row 1
(the prototype's dynamic region is two rows taller than the shipped round-2 idle region).

**Reading of the table.**
- Going full-screen multiplies the per-keystroke byte cost by **2.2× at 24×80 and 6.7× at 60×200** with the default
  `standard` renderer, because every frame rewrites `rows` lines instead of 11.
- **Row 8 misses the D-F gate**: composer keystroke → frame p95 must be < 16 ms; measured 17.15 ms at 60×200 with
  the default renderer (and 15.72 ms p95 / 18.38 ms max already at 40×120). The machine was loaded, so this is an
  upper bound — but the hybrid measured 3.8 ms on the *same* machine in the *same* minute, so the 4.5× ratio is real.
- **`incrementalRendering` is not optional for a full-screen layout**: it takes 8 585 → 409 bytes and 17.15 → 12.48 ms
  p95. The hybrid does not need it (3.8 ms, 3.7 KB) but benefits from it too (145 bytes/key).

### 3.2 Clears — the zero-clear gate

`CLEAR_RE` matches per capture (one `clearTerminal` = 2 matches, `2J`+`3J`; one alt-screen session = 2 more):

| capture | CLEAR_RE | `clearTerminal` writes | where |
| --- | ---: | ---: | --- |
| `B-hyb-24x80-std.cap.gz` (60 keys) | 0 | 0 | — |
| `A-full-24x80-std.cap.gz` (60 keys) | 2 | 1 | offset 103 433 / 106 141 — **at unmount** (`ink.js:96–99`) |
| `A-full-24x80-alt.cap.gz` (60 keys) | 4 | 1 | `?1049h` at 0, `2J 3J` at 100 569, `?1049l` at 103 265 — **the clear lands inside the alternate buffer** |
| `A-full-over1.cap.gz` (60 keys, tree = `rows + 1`) | **74** | **37** | one per frame, offsets 2 787, 5 571, 8 355, … |

Isolated resizes from 24×80 (`rs-*.steps`, prototype killed before unmount so only the resize's own clears count):

| resize | A full-screen | B hybrid |
| --- | ---: | ---: |
| none | 0 | 0 |
| shrink → 12×60 | **2 `clearTerminal`** | 0 |
| grow → 40×120 | 0 | 0 |
| width only → 24×60 | 0 | 0 |

**The off-by-one cliff (row 11 / 74 clears) is the single most important robustness fact in this report.** A
full-screen layout is correct only when the rendered tree is **exactly** `rows` tall. One row too tall makes
`isOverflowing` true (`ink.js:95`: `nextOutputHeight > viewportRows`, strict) and Ink writes
`ESC[2J ESC[3J ESC[H` + the whole frame **on every keystroke**. One row too short is merely a wasted row. There is
no warning and no partial degradation: a wide CJK grapheme that Ink wraps, a stale `rows` during the SIGWINCH race,
a `\n` inside an item body, or an overlay that wants one more row than the layout gave it all produce the same
storm. Today's architecture has no such cliff — the budget is `rows − 2` (`layout.ts:154`) and is checked by the
`paintedRows ≤ rows − 2` perf assertion.

### 3.3 The shipped product deletes the user's scrollback on a shrink resize

`product-shrink-panelfull-40x100-to-10x60.cap` — `chat --mock` at 40×100, `/panel full`, then `resize 10 60`:

```
clear at 19960  b'\x1b[2J'
clear at 19964  b'\x1b[3J'
```

One `clearTerminal` per shrink is the documented, accepted behaviour (research 20 §1; `docs/TUI-DESIGN.md:1891`).
What the gate does *not* say is that the clear Ink writes is `ESC[2J **ESC[3J** ESC[H`, and **`ESC[3J` erases the
terminal's saved-lines buffer** — everything the user had scrolled through, including the shell history from before
`jevcode` started. `docs/research/tui/07-terminal-protocols-edge-cases.md:818` already names this ("`ESC[2J`/`ESC[3J`
on Ctrl+L or resize … destroys scrollback") but it was written about *our* code, and the same sequence is arriving
from inside Ink.

The same write also re-emits `fullStaticOutput` (I9): measured **4 616 bytes** of repaint payload after a 40-step
mocked run (`big3` probe, ≈60 static rows). It is linear in the transcript, so a session near the 20 000-item soft
cap (`src/tui/useEngine.tsx:53`) re-emits on the order of 2 MB in one synchronous TTY write on every shrink.

This is a **current-product defect**, independent of which header architecture wins (proposal **P1**).

### 3.4 Scrolling a viewport is not free; native scrolling is

Option A, 20 000 items, 40×120, 30 × PgUp then 20 × PgDn (`scroll.steps`):

| render mode | bytes per scroll frame | p50 | p95 |
| --- | ---: | ---: | ---: |
| standard | 5 303 | 5.88 ms | 9.43 ms |
| incremental | 3 352 | 5.42 ms | 7.47 ms |

Incremental rendering barely helps here because **every viewport row changes** on a scroll. Holding PgDn at 30 fps
is ≈ 100 KB/s; at the SSH default of 15 fps it is ≈ 50 KB/s of pure decoration traffic. The hybrid's equivalent
gesture — the terminal's own wheel or Shift+PgUp — costs **0 bytes and 0 ms** in the child, and keeps the terminal's
find-in-scrollback and click-drag selection.

### 3.5 Memory and the resize rewrap for a 20 000-item transcript (option A only)

`mem.mjs` (`node --expose-gc`, `mem-20000.json`). A viewport needs a *wrapped-row index* (each item is 1..n screen
rows) to scroll by row and to know the total height:

| items | wrapped rows @ 71 cells | items heap | index heap | rebuild @ 80 cols | rebuild @ 200 cols | slice per frame |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 000 | 10 000 | 0.3 MB | +3.8 MB | 4.7 ms | 3.5 ms | 0.0003 ms |
| **20 000** | **40 000** | 2.4 MB | **+15.7 MB** | **16.3 ms** | 12.4 ms | 0.0002 ms |

So option A costs a second, larger copy of the transcript in memory, and **every width change is a 16 ms full
rewrap** at the soft cap. Slicing is free (0.2 µs), so the scroll itself is cheap once the index exists. Option B
pays none of this: `<Static>` items are written once and Ink never lays them out again
(`src/tui/Transcript.tsx:1–25`); the only Ink-side growth is `fullStaticOutput` (I9).

### 3.6 Screen reader

`INK_SCREEN_READER=true`, 40×120, 30 keys: option A **5 123 bytes/key**, option B **2 228 bytes/key**. Under a
screen reader Ink re-emits the whole frame on every change (I12), so a `rows`-tall frame re-announces the entire
screen — including the five decorative header rows — on every keystroke. Full-screen must be refused under
`--screen-reader`.

### 3.7 Ink hands mouse reports to the composer as text (measured)

`input.mjs` turns on `ESC[?1000h ESC[?1002h ESC[?1006h` and logs what `useInput` receives
(`ink-mouse-input.log`):

```
{"n":1,"input":"[<64;10;5M","key":{}}     ← wheel up (SGR)
{"n":2,"input":"[<65;10;5M","key":{}}     ← wheel down
{"n":3,"input":"[<0;12;7M","key":{}}      ← left press
{"n":4,"input":"[<0;12;7m","key":{}}      ← left release
{"n":5,"input":"","key":{"pageUp":true}}
{"n":6,"input":"","key":{"pageDown":true}}
```

Two consequences. (a) **Mouse-wheel scrolling is not "just an option" for option A**: enabling mouse reporting
without first writing an SGR/X10 mouse decoder types `[<64;10;5M` into the composer on every wheel tick, and it
breaks click-drag selection and the terminal's own wheel scrollback in every emulator
(`docs/research/tui/07-terminal-protocols-edge-cases.md:370, 816`; `01-opencode.md:638` — opencode had to add
`mouse: false` and `OPENCODE_DISABLE_MOUSE`). (b) **Keyboard paging is free**: `PgUp`/`PgDn` already arrive as
`key.pageUp` / `key.pageDown` with empty `input`, and the composer context has no binding for them today
(`src/tui/keys/bindings.ts:129–130, 141–142` bind them only in `picker` and `palette`).

---

## 4. Option B′ — a fixed header outside Ink with a DECSTBM scroll region

The idea: write the five mark rows at physical rows 1–5 ourselves, set the scroll region to `ESC[6;<rows>r`, and let
Ink keep its `<Static>` + bounded-region model inside rows 6…`rows`.

What the code says (no emulator was available on the reference machine to test scrollback semantics, so this is a
mechanism analysis from I8/I10 plus the DEC/xterm specification — see the falsifiable probe below):

| aspect | verdict | why |
| --- | --- | --- |
| Ink's relative cursor motion | **compatible** | every motion Ink emits is `CUU`/`CUD`/`CNL`/`CHA`/`LF` (I10); inside a region `CUU` clamps at the top margin and `LF` at the bottom margin scrolls only the region — Ink physically *cannot* walk into the header |
| `<Static>` appends | **compatible mechanically** | they are ordinary writes that scroll the region |
| native scrollback | **fatal** | lines scrolled out of a DECSTBM region are not appended to the saved-lines buffer in xterm-family terminals (saved lines are only captured when the margins are the full screen). Option B exists *only* to keep native scrollback; B′ spends it |
| `clearTerminal` on shrink | **fatal without a stream filter** | `ESC[2J` blanks the header rows and `ESC[H` homes the cursor to row 1, **outside** the region; Ink then paints from physical row 1 and the header is gone for the rest of the session. This fires on every shrink resize (§3.2/§3.3) |
| child processes | **fragile** | `$EDITOR` / Ctrl+Z (I13), `git` pagers, and anything that emits `RIS` or `DECSTBM` of its own resets or repurposes the margins; `suspendTerminal` has no margin hook |
| tmux / screen | **fragile** | margins are per-pane state that the multiplexer re-derives on split/resize |
| resize | **manual** | the bottom margin must be rewritten on every SIGWINCH before Ink's own repaint, from a Node listener that already races Ink's (`src/tui/App.tsx:2407–2428`) |

**Verdict: reject.** B′ buys a pinned header at exactly the price option A charges (no native scrollback), while
adding out-of-band terminal state that nothing in the codebase currently owns.

**Falsifiable probe if anyone wants to re-open it** (proposal P8): in the terminal matrix
(`docs/research/tui/terminal-matrix.md`) run, per terminal: `printf '\e[6;24r'`, `seq 1 200`, then scroll the
terminal back and report whether lines 1–176 are in the scrollback; then `printf '\e[2J\e[3J\e[H'` and report
whether the region survives. Two observations per terminal, five minutes total.

---

## 5. Decision table

`H` = header always visible at the physical top. Scores are from §3 unless noted.

| criterion | **A** full-screen (alt) | **A′** full-screen (primary screen) | **B** hybrid, today | **B′** DECSTBM header | **C** one-row brand strip in B |
| --- | --- | --- | --- | --- | --- |
| jevcode art at physical row 1, always | **yes** (5 rows) | yes | no (row `r−9`, §1) | yes | no — but the *word* `◆ jevcode` is on screen in every state |
| jevcode visible at all during a run | yes | yes | **no** today (`wordmarkWanted` false while live) | yes | **yes** (1 row) |
| native scrollback (wheel, Shift+PgUp) | **lost** | lost | **kept** | lost | kept |
| terminal find-in-scrollback | **lost** | lost | **kept** | lost | kept |
| click-drag copy of history | visible rows only | visible rows only | **whole session** | visible rows only | whole session |
| in-app scrolling | must be built (viewport + index + keys) | same | terminal does it | must be built | terminal does it |
| bytes per keystroke, 24×80 | 2 855 std / 181 inc | same | **1 695 std / 145 inc** | ≈ B | = B + 0 |
| bytes per keystroke, 60×200 | 8 585 std / 409 inc | same | **3 675 std** | ≈ B | = B |
| composer p95, 60×200 | 17.2 ms std ✗ / 12.5 ms inc | same | **3.8 ms** | ≈ B | = B |
| bytes per scroll step | 3.4–5.3 KB | same | **0** | 0 | 0 |
| clears | 1 per shrink + 1 at unmount, **all inside the alt buffer** | 1 per shrink + **1 at unmount on the user's screen**, each `2J`+`3J` | 1 per shrink (`3J` — see P1) | ≥ 1 per shrink, header destroyed | = B |
| off-by-one failure mode | **37 clears / 36 frames** (§3.2) | same | none (budget `rows − 2`) | same as A | none |
| exit leaves the transcript on screen | **no** (I2) unless we dump it | yes | **yes** | yes | yes |
| crash / SIGKILL | user stranded on the alt screen unless RESTORE writes `1049l` | screen wiped by the unmount clear | **safe** | margins left set | safe |
| screen reader | must refuse (5.1 KB/key) | must refuse | **works** (flat tier) | n/a | works |
| SSH (fps 15) | needs `incremental` (409 B) else 8.6 KB × 15/s | same | **fine** (3.7 KB × 15/s today) | ≈ B | = B |
| new mechanism to own | viewport, wrapped index, scroll keys, sticky-bottom, position indicator, exit dump, alt-screen teardown in `RESTORE` | + scrollback destruction | none | margins, header painter, clear filter | one string |
| identity rule | preserved by construction (same `plain.ts` rows) | same | preserved today | preserved | preserved |
| lines of new surface (estimate) | ≈ 900 | ≈ 900 | 0 | ≈ 300 + terminal risk | ≈ 40 |

---

## 6. Recommendation

**Keep the hybrid (B) as the default; make the brand permanent inside it (C + a visibility change); and ship the
full-screen layout as an explicit opt-in renderer (A) that is only ever entered with the alternate screen and
incremental rendering both on.**

Reasons, in order of weight:

1. **A′ (full-screen on the primary screen) is not shippable at all.** Ink writes `ESC[2J ESC[3J` at unmount for
   every fullscreen session (§3.2) and the `3J` deletes the user's scrollback — a full-screen default would wipe the
   terminal every time jevcode exits. If we go full-screen, `alternateScreen: true` is mandatory, and the measured
   capture confirms the clear then lands *inside* the alternate buffer where it is harmless
   (`A-full-24x80-alt.cap.gz`: `2J` at 100 569 < `1049l` at 103 265).
2. **A as a default fails the D-F perf gate on large terminals with today's renderer** (17.15 ms p95 at 60×200 vs
   3.81 ms for B) and only passes with `incrementalRendering`, which is currently a documented opt-in
   (`src/config/launch.ts:127`) precisely because per-line diffing has its own edge cases (the Windows-console
   caveat is baked into Ink at `ink.js:85–100`).
3. **A has a cliff, B has a slope.** One row of layout error in A costs a full-screen clear per keystroke (§3.2);
   the same error in B costs one truncated row. For a request whose headline is "handle literally all the edge and
   corner cases … heavy production grade", that asymmetry decides it.
4. **A takes away three things the user never asked to lose** — wheel scrolling, find-in-scrollback and copying the
   whole conversation — and charges 3.4 KB per scroll step to give one of them back.
5. **The user's literal ask is satisfiable inside B for ~40 lines.** "jevcode stays up on top" is, operationally,
   "I always want to see the brand". Today it vanishes after the first `run:ready` (`Pane.tsx:98–108`) and during
   every run (`wordmark.ts:77–94`). Fixing *that* is the high-value, zero-risk change; pinning at physical row 1 is
   the low-value, high-risk one.
6. **Claude Code shipped exactly this split** — classic renderer by default, `/tui fullscreen` opt-in that
   "relaunches into fullscreen with your conversation intact", with a documented fallback when the fullscreen
   renderer fails to start (`docs/research/tui/02-claude-code.md:205–215, 426, 727`). Offering the same choice is
   both the safe engineering answer and the one that reads as a feature.

---

## 7. Full design of the recommendation

### 7.1 Default renderer (`classic`, today's hybrid) — what changes

Nothing architectural. Three visibility changes so the brand is on screen in every state, and the mark is as high as
the architecture allows:

**Layout rows per tier (unchanged arithmetic, new occupancy).** `computeLayout` and `CAP` are untouched.

| tier | rows | columns | rule row (row 1 of the region) | pane slot | dynamic rows |
| --- | --- | --- | --- | --- | ---: |
| boxed + mark | ≥ 21 | ≥ 64 | **plain rule before the first run; `◆ jevcode` + strip after it (P2)** | 5-row mark (idle, thinking **and live** — P3) | 11 |
| boxed, no mark | 16–20 | ≥ 40 | **brand-prefixed strip in every state (P2)** | 0 | 6 |
| boxed, narrow | 16+ | 40–63 | brand row / brand-prefixed strip | 0 | 6 |
| flat | 8–15 | ≥ 40 | static brand row | 0 | 3 |
| minsize | < 8 or < 40 | — | — | — | status · notice · composer |

### 7.2 Opt-in renderer (`fullscreen`) — the pinned-header layout

`ui.renderer: classic | fullscreen` (default `classic`), `--fullscreen` / `--renderer`, `/fullscreen` toggles it for
the *next* launch and offers an in-place relaunch. When it is on, three settings are **forced, not defaulted**:
`alternateScreen: true`, `incrementalRendering: true`, mouse reporting off.

**Rows per tier — the invariant is `header + rule + viewport + console === rows`, exactly.**

| tier | rows | header | rule / position row | viewport | console | invariant |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| hero | ≥ 30 | 5 (mark) | 1 | `rows − 11` | 5 | ✓ |
| tall | 24–29 | 5 (mark) | 1 | `rows − 11` | 5 | ✓ |
| compact | 18–23 | **1** (brand strip) | 1 | `rows − 7` | 5 | ✓ |
| narrow (< 64 cols) | ≥ 18 | 1 (brand strip) | 1 | `rows − 7` | 5 | ✓ |
| below 18 rows / below 40 cols / screen reader / `TERM=dumb` | — | — | — | — | — | **refuse fullscreen, fall back to `classic`** and say so once in the transcript |

An overlay (review, palette, wizard, blocking, intake) takes its rows from the **viewport**, in the same yield order
as today, and the header yields from 5 → 1 before the viewport drops below 3 rows. The composer grows inside the
console exactly as today (cap 6, or 8 at rows ≥ 40).

**Scrolling model.**
- State: `scroll: { anchor: 'bottom' } | { anchor: 'row', top: number }` in `UiState`. Default sticky-to-bottom
  (opencode's `stickyScroll` / `stickyStart: "bottom"`, `docs/research/tui/01-opencode.md:134`): appends keep the
  view pinned; the user's position is preserved when detached.
- Keys (composer context; all currently free there): `PgUp`/`PgDn` = one viewport minus two rows; `Shift+↑`/`Shift+↓`
  = one row; `Home`/`End` = top / bottom-and-reattach. Submitting, `Esc` on an empty draft, and any `run:start`
  reattach to the bottom. Mouse: none.
- Position indicator: folded into the existing rule row, right-aligned —
  `── ▸ jev s7 · 12 decisions ─────────── 1 240/3 512 · 35 % ──` — so it costs **zero extra rows** and reuses
  `panelStrip`'s right-segment slot (`src/tui/pane/model.ts:375–395`).
- A `▲ 1 240 earlier rows · PgUp` hint replaces the top viewport row for 2 s after the first append while detached.

**Restoring what the alternate screen takes away.**
- `/scrollback` — `suspendTerminal()` (which already leaves the alt screen, I13), print the whole transcript to the
  primary screen through `src/tui/plain.ts`, wait for a key, resume. Native copy and find are available for as long
  as the user wants.
- On exit — after `1049l`, write the whole transcript to the primary screen (`ui.fullscreenDump`, default on,
  skipped when the transcript is empty or when the session ended with `--json`). This is byte-identical to
  `--plain`, so the session ends with the same scrollback the classic renderer would have left.

**Transition from the current design.** Nothing in `computeLayout`, `Transcript`, `Console`, `Overlay`, `Review`,
`Composer`, `StatusLine`, the key resolver or `plain.ts` changes. `App.tsx` gains a second render branch
(`<FullApp>`) that reuses every one of those components and swaps `<Static>` for `<Viewport>`; `createTuiRenderer`
passes the two forced Ink options. If `ui.renderer` is `classic` (the default) the tree is byte-for-byte today's.

**How the identity rule survives.** The viewport renders the *same* rows `<Transcript>` renders — `itemLines()` →
`bodyRows()` → `wrapBody()` (`src/tui/Transcript.tsx:88–120`) — just sliced. `normaliseRows(viewportRows(item))`
must equal `formatTranscriptItem(item)` (`src/tui/plain.ts:487–489`) by the same test that guards `<Transcript>`
today, run over the viewport builder as well. The on-exit dump and `/scrollback` both go through
`createPlainRenderer`, so `transcript.log == --plain == TUI rows` is preserved verbatim. **No engine-item text
changes anywhere in this topic** — every proposal below is colour/layout only, and D-M's deferred text rewrites are
untouched.

---

## 8. Proposals

Each: what · where · edge cases · tests · perf gate · identity class.

---

### P1 — Stop deleting the user's scrollback: filter `ESC[3J` out of Ink's `clearTerminal` (ship in round 4, independent of everything else)

**What.** Today every shrink resize that overflows the previous frame writes `ESC[2J ESC[3J ESC[H` (§3.3, measured
on the shipped build), and `ESC[3J` erases the terminal's saved lines — the user's whole scrollback, including the
shell history from before jevcode started. Ink offers no hook (I11: `resized()` does not reset `lastOutputHeight`,
and the public `clear()` does not either — `ink.js:655–662`), so the fix is a one-method write filter on the stream
handed to `render()`: rewrite a chunk that *starts with* `\x1b[2J\x1b[3J\x1b[H` to `\x1b[2J\x1b[H`, pass everything
else through untouched.

**Where.** New `src/tui/scrollback-guard.ts` (`guardStdout(stream): NodeJS.WriteStream` — a `Proxy` whose only trap
is `write`); wired at `src/tui/App.tsx:2382–2440` (`createTuiRenderer`: `const out = guardStdout(stdout)`, used for
`render({ stdout: out })`, `stdout.on('resize')`, the title and cursor-shape writes). Export from
`src/tui/index.ts`. Documented in `docs/TUI.md` (the "Terminal hygiene" section) and `docs/TUI-DESIGN.md:1891`
(the zero-clear gate gains: "a clear is `ESC[2J ESC[H`; `ESC[3J` is never written").

**Edge cases (enumerated).**
1. The chunk is a `Buffer`, not a string (Ink always writes strings, but `patchConsole` and third-party writes may
   not) — only inspect when `typeof chunk === 'string'`.
2. The clear is not at offset 0 of a chunk (it is today — `ink.js:768` builds one string starting with it) — match
   at the head *and* with `indexOf`, replacing only the exact 9-byte sequence, at most once per chunk.
3. `write(chunk, encoding, cb)` and `write(chunk, cb)` overloads must both forward and return the original boolean.
4. Back-pressure: return the underlying `write`'s return value unchanged; never buffer.
5. `stdout.isTTY`, `.rows`, `.columns`, `.on/off/once`, `.destroyed`, `.writableEnded`, `._writableState` must all
   forward — Ink reads every one of them (`ink.js:113–122`, `getWindowSize`).
6. Ink keys its instance map by the stream object (`render.js:45–58`) — the same proxy object must be passed
   everywhere, never mixed with the raw `process.stdout`.
7. `waitUntilRenderFlush()` queues an empty write as a barrier — the proxy must forward a zero-length write.
8. The fatal path (`src/cli/fatal.ts` `RESTORE`) and `installTerminalHygiene` write to the raw stream at exit — they
   never write `3J`, so they can keep using `process.stdout`.
9. `--plain` and piped output never construct the renderer — unaffected.
10. Non-TTY / CI (`interactive === false`): Ink never takes the clear branch; the proxy is inert.
11. Windows console (`ink.js:87–99` forces a clear on every fullscreen frame): the filter makes that path *more*
    important, not less; assert the same zero-`3J` property there in the matrix.
12. Trade-off to declare: with `3J` gone, the repaint re-emits `fullStaticOutput` (I9) *below* the old copy, so the
    transcript appears twice in the scrollback after a shrink. That is strictly better than deleting the user's
    history, and §7 of `docs/TUI-DESIGN.md`'s duplication note should say so.

**Tests.** Unit (`test/tui/scrollback-guard.test.ts`): the exact sequence is rewritten; `\x1b[2J` alone,
`\x1b[3J` alone in a non-clear context and `\x1b[2K` are untouched; Buffer chunks pass through; the three `write`
overloads forward; property forwarding for `isTTY/rows/columns/on/off`. PTY (`test/pty/smoke/shrink-no-3j.steps`,
new): `chat --mock`, `/panel full`, `resize 10 60` — the capture contains `\x1b[2J` and **zero** `\x1b[3J`; the
existing per-segment clear count (≤ 1 per shrink) is unchanged. Extend `src/perf/render-lag.ts`'s hygiene assertions
with a `NO_3J` check on every capture.

**Perf gate.** No change to any gate; the proxy adds one `startsWith` per write (measured cost of a `write` today:
1 286 bytes / keystroke, so one string compare is < 0.01 % of the frame). First frame < 300 ms, composer p95 < 16 ms,
lag p95 < 5 ms all unaffected — re-run `perf composer` and `perf first-frame` to confirm no regression.

**Identity class.** Neither — a terminal-control change. No transcript text, no colour, no layout.

---

### P2 — The brand never leaves the rule row (`◆ jevcode` pinned in every state)

**What.** `ruleRowText` (`src/tui/Pane.tsx:88–108`) returns the brand row only while `!ranBefore`; after the first
`run:ready` it returns `panelStrip(...)` and the word "jevcode" disappears from the dynamic region. Change: the
strip gains a **brand prefix** — `── ◆ jevcode ─ ▸ jev s7 · 12 decisions · risk 0.20 ok ──── [d] [p] [t] [s] ──` —
drawn whenever it fits, dropped first when the strip's fill falls under `STRIP_MIN_FILL`. The brand text is
`◆ jevcode` (no version after the first run; the version stays in the caption under the mark and in the console
title), in `accent`. `brandSpan` (`src/tui/splash.ts:259–268`) finds `<glyph> jevcode ` and then ends the span at
the **next space**, i.e. it assumes a version token follows; with a versionless prefix it would colour
`◆ jevcode ─`. It needs a one-line generalisation (end the span at `jevcode` when the following token is not a
version) — that is the only colouring change.

**Where.** `src/tui/pane/model.ts:375–395` (`panelStrip` gains an optional `brand: boolean`, prepending the segment
and including it in the existing shrink loop), `src/tui/Pane.tsx:88–108` (`ruleRowText` passes it),
`src/tui/splash.ts` (`BRAND_SEGMENT` constant, reusing `g.brand`), `docs/TUI.md` §"Rule row", `docs/TUI-DESIGN-3.md`
§3.3 (the hand-off table row for the strip).

**Edge cases.**
1. Narrow terminals: the brand is the **first** segment dropped by the existing `while (segments.length > 1)` loop
   at `model.ts:388–393`, so a 40-column strip is byte-for-byte today's.
2. `--ascii`: `g.brand` is already the ASCII twin (`*`), and `brandSpan` accepts all four glyphs.
3. `NO_COLOR` / depth 0: the text is identical, only the SGR disappears — the word still reads.
4. Picker open: `pickerHeader` wins, unchanged (`Pane.tsx:92`).
5. Panel open/full: `paneRuleRow` wins, unchanged — but the tab header should carry the same prefix when it fits
   (same helper, same drop order).
6. Splash running below 64 columns: `brandRow` already carries the brand; no double brand (guard on the
   `wordmark`/`splash` branches at `Pane.tsx:96–97`).
7. Wordmark shown: `ruleRowText` returns `plainRule` while `wordmark && !ranBefore` (`Pane.tsx:97`) — after a run
   the strip is shown *under* the mark (F-W5), and the brand prefix would then repeat the mark. Rule: **no brand
   prefix on the rule row in any frame where the 5-row mark has rows** (`i.wordmark === true`).
8. Rule width cap `RULE_MAX_CELLS = 400` (`Pane.tsx:23`) unchanged.
9. `brandSpan`'s span end (see above) must be generalised, and its existing four-glyph pulse cases must keep
   passing (`round2-splash.test.ts`).
10. The `◆ jevcode` string must never be mistaken for a transcript row by the pty helpers — `pty.ts`'s
   `composerRow`/`paintedRows` key off the console box, not the rule row.

**Tests.** Unit (`test/tui/round2-pane.test.ts` + a new `brand-strip` block): the prefix appears at ≥ 64 columns,
is dropped before any information segment below it, never appears when `wordmark` is true, `brandSpan` finds it,
`--ascii` twin, `NO_COLOR` text identity. PTY: extend `test/pty/smoke/panel.steps` — after a mocked run the rule row
matches `◆ jevcode`; at `resize 24 44` it does not.

**Perf gate.** None affected: the rule row is one row of an already-rendered frame; `panelStrip` is pure and runs
once per frame. Re-run `perf render-lag` to confirm the dynamic-frame rate is unchanged.

**Identity class.** **Colour/layout.** The rule row is chrome, not a transcript item — `createPlainRenderer`
(`src/tui/plain.ts`) prints items only and has no rule row, so `--plain` and `transcript.log` are untouched.

---

### P3 — The mark stays up during a run (remove the `runIsLive` hide) at heights where it costs nothing

**What.** `wordmarkWanted` hides the mark whenever `run === 'live' | 'aborting' | 'pausing'`
(`src/tui/wordmark.ts:71–94`). At 24 rows that is right — the run needs the pane's 5 rows for live output and the
panel. At **≥ 32 rows** it is not: the live region is `rule 1 + live 2 + queue 2 + console 5` = 10 rows of a 30-row
budget (`rows − 2`), so adding the mark's 5 makes 15 and still leaves 15 rows of visible conversation. Change: replace the `¬runIsLive` clause with
`¬runIsLive ∨ rows ≥ WORDMARK_LIVE_MIN_ROWS (32)`, and freeze the idle sweep while a run is live (the loop's
`shown` input already gates it, `App.tsx:2069`) so a run still writes **zero** decoration frames.

**Where.** `src/tui/wordmark.ts:38–94` (new constant + one clause), `src/tui/App.tsx:2061–2069` (`paneWhole` and the
loop's `enabled` are already correct), `docs/TUI-DESIGN-3.md` §3.1/§3.2 tables, `docs/TUI.md`.

**Edge cases.**
1. A panel opening mid-run (`panel !== 'collapsed'`) still wins the slot — unchanged clause.
2. A review arming mid-run still hides the mark (`overlay === 'review'`, TD A42) — unchanged.
3. The pane's live rows can grow to `CAP.live = 2` plus `CAP.queue = 2`; at exactly 32 rows the whole-or-absent
   grant (`layout.ts:184`, `paneWhole`) drops the mark rather than cutting it — the safety net stays.
4. Shrinking from 40 to 30 rows mid-run: the mark disappears in one frame (no partial mark), one shrink clear as
   today.
5. `run:end` at ≥ 32 rows: the mark was already up, so the `postRun` rule (`WORDMARK_POST_RUN_MIN_ROWS`, `:40`)
   becomes a no-op there — assert it, do not delete it (21–31 rows still need it).
6. `--fps 15` / SSH: no new frames (the loop stays off while live).
7. Reduced motion / `ui.wordmark: static`: the static mark is shown, still zero frames.
8. Screen reader: unchanged (flat tier).

**Tests.** Unit: property test over 1 000 random `WordmarkInput`s asserting the new predicate; explicit cases at
rows 31/32 live. PTY (`test/pty/smoke/wordmark-live.steps`, new, at `PTY_ROWS=34`): the mark rows are present in a
frame captured while `run` is live, and the dynamic frame count in the run's busiest second is unchanged.

**Perf gate.** `src/perf/render-lag.ts`'s run-start bucket (dynamic frames in 1 s) and the splash gate must be
unchanged; composer p95 < 16 ms in the `live` series of `src/perf/composer-latency.ts` at 34 rows (a new geometry to
add there, reported not gated on the first run).

**Identity class.** **Layout.** No text, no `--plain` twin.

---

### P4 — `ui.renderer: classic | fullscreen` and the forced Ink options

**What.** A launch setting and a flag that switch `createTuiRenderer` between today's tree and `<FullApp>`.
`fullscreen` forces `alternateScreen: true` and `incrementalRendering: true` and refuses (falling back to `classic`
with one `[ui]` note) when any of: `rows < 18`, `columns < 40`, `screenReader`, `TERM` is `dumb`/absent,
`stdout.isTTY !== true`, `--plain`.

**Where.** `src/config/launch.ts` (a third launch member beside `fps` and `renderMode`; it must be a *launch*
setting because Ink fixes `alternateScreen` in its constructor — `ink.js:256`), `src/cli/args.ts` (`--fullscreen`,
`--renderer`), `src/config/defaults.ts` + `types.ts` + `ui.ts` + `config-table.ts` (`ui.renderer`),
`src/tui/App.tsx:2430–2441`, `src/cli/fatal.ts` (`RESTORE` gains `ESC[?1049l` **only when the alt screen was
entered** — a module-level flag set by `createTuiRenderer`), `docs/TUI.md`, `docs/KEYS.md`, `docs/COMMANDS.md`,
`completions/*`, `man/jevcode.1`, `.env.example` (`JEVCODE_RENDERER`).

**Edge cases.**
1. **Crash / SIGKILL / SIGHUP while in the alt screen**: `RESTORE` must emit `1049l` or the user's shell is left on
   a blank alternate buffer. `SIGKILL` cannot be caught — document `reset` as the recovery, and prefer the shell's
   own `1049l` on child exit where the terminal does it.
2. `exitOnCtrlC: false` is already set; Ctrl+C twice must still reach the epilogue *after* leaving the alt screen,
   or the epilogue is invisible (the exit dump of P6 covers it).
3. A terminal that ignores `1049h` (very old, `TERM=dumb`): refuse by `TERM` check, because Ink's own guard only
   checks `isTTY` (I1).
4. `tmux` / `screen`: alt screen works, but `tmux -CC` (iTerm control mode) does not — document, do not detect.
5. `render()` is called once per stdout (`render.js:45–58`); the renderer choice must be made before the first
   `render()`, never toggled in-place. `/fullscreen` therefore persists the setting and offers a relaunch.
6. The setting must be readable **before** the first frame with no file I/O (F1) — so the flag/env path is
   authoritative for frame 0 and the config file only applies from the next launch, exactly like `fps`.
7. `--screen-reader` + `--fullscreen` together: screen reader wins, one note.
8. CI (`isInCi`): `interactive` is false, Ink refuses the alt screen itself (`ink.js:709–712`) — make the fallback
   explicit so the layout does not go full-screen without the alt buffer (that is A′, §6 reason 1).

**Tests.** Unit: `resolveLaunchSettings` precedence (flag > env > default) and every refusal reason; `config` table
shows the value and its source. PTY (`test/pty/smoke/fullscreen-refuse.steps`): `--fullscreen` at `PTY_ROWS=14`
produces a classic frame plus the note, and **zero** `1049h` in the capture.

**Perf gate.** First frame < 300 ms in `fullscreen` (`src/perf/first-frame.ts` gains a `--fullscreen` geometry): the
extra work is one 8-byte write plus a `rows`-tall first frame (≈ 12 KB at 60×200). Zero file I/O before frame 0 is
preserved because the setting is a launch member.

**Identity class.** Neither (a mode switch). No text, and the classic path is byte-for-byte unchanged.

---

### P5 — `computeFullLayout`: the exact-height allocator (the anti-cliff)

**What.** A pure allocator for the fullscreen renderer whose post-condition is
`header + rule + viewport + console === rows` — **exactly**, for every input, with a returned
`degraded: 'none' | 'compact' | 'minsize'`. Priority: status/console floor → rule → console growth → overlay →
header (5 → 1 → 0) → viewport. It is the fullscreen twin of `computeLayout` and must never be allowed to return a
total of `rows + 1` (§3.2: 37 clears / 36 frames).

**Where.** New `src/tui/fullscreen/layout.ts`; consumed by `src/tui/fullscreen/FullApp.tsx`. Documented in a new
`docs/TUI-DESIGN-4.md` §"fullscreen".

**Edge cases.**
1. Non-finite / negative `rows`/`columns` → treated as 0, `degraded: 'minsize'` (same normalisation as
   `layout.ts:145`).
2. `rows` 1 and 2 → console only, header 0, viewport 0.
3. An overlay wanting more rows than the viewport has → the overlay is capped, never the total.
4. A composer at its 6/8-row cap plus a 9-row review card plus a 5-row header at 24 rows → header yields to 1.
5. The **rendered** height must equal the allocated height: every slot is a fixed-height `overflow: hidden` Box, and
   every row is `<Text wrap="truncate">` — a single wrapped row breaks the invariant.
6. Wide graphemes: a row whose cell width exceeds `columns` must be truncated by cells, not code units
   (`src/tui/composer/width.ts` `stringWidth` already exists).
7. A transcript item with an embedded `\n` contributes one viewport row per line.
8. Zero-height viewport (tiny terminal mid-resize) must render nothing, not a negative slice.

**Tests.** Unit, exhaustive: for `rows` 0…120 × `columns` {0, 1, 39, 40, 63, 64, 79, 80, 119, 120, 199, 200} ×
every `OverlayKind` × composer wants 1…8, assert `total === rows` (or `rows` clamped at 0) and the yield order; a
1 000-case property test with random inputs. A **render-level** test with `ink-testing-library` asserting
`frame.split('\n').length === rows` for the same matrix — that is the test that would have caught the cliff.
PTY: `fullscreen-resize.steps` — 24×80 → 12×60 → 40×120 → 24×80 with a review pending, asserting ≤ 1
`clearTerminal` per shrink segment and 0 otherwise, all inside the alt buffer.

**Perf gate.** `computeFullLayout` ≤ 5 µs per call (the same bench as `computeLayout`). Composer p95 < 16 ms at
24×80 and 60×200 in fullscreen (measured on the prototype with incremental: 7.45 ms and 12.48 ms — both under, with
3.5 ms of headroom at 60×200 that the real tree will consume, so this gate must be re-measured, not assumed).

**Identity class.** **Layout.**

---

### P6 — `<Viewport>`: the scrolling transcript, the wrapped-row index, and the identity guarantee

**What.** A pure index (`src/tui/fullscreen/viewport.ts`) that turns `TranscriptItem[]` into wrapped screen rows
using the **same** builders `<Transcript>` uses (`itemLines` → `bodyRows` → `wrapBody`,
`src/tui/Transcript.tsx:88–120`), with (a) incremental append — only new items are wrapped; (b) full rebuild on a
width change, behind the existing 50 ms resize debounce (`src/tui/terminal.ts:20`), keeping the old index until the
new one is ready; (c) `slice(top, n)`; (d) sticky-to-bottom anchoring. Plus `<Viewport>`, a fixed-height
`overflow: hidden` Box of `<Text wrap="truncate">` rows.

**Where.** `src/tui/fullscreen/viewport.ts`, `src/tui/fullscreen/Viewport.tsx`, `src/tui/useEngine.tsx` (a `scroll`
field and its reducer actions), `src/tui/keys/bindings.ts` (four new `composer` bindings, §7.2),
`src/tui/keys/resolve.ts` (four cases), `src/tui/pane/model.ts` (the position segment on the strip).

**Edge cases.**
1. **20 000 items**: 40 000 rows, +15.7 MB, 16.3 ms rebuild (§3.5). Cap the index at the existing
   `STATIC_SOFT_CAP = 20 000` items (`useEngine.tsx:53`); past it, drop the oldest and show
   `▲ n earlier rows · see transcript.log` as row 0.
2. **Resume** (`--resume`) seeds thousands of items before the first frame — index lazily: frame 0 wraps only the
   last `viewport` rows, the rest on an idle callback, so first frame < 300 ms holds.
3. A single 10 000-character line wraps to ~125 rows — taller than the viewport; scrolling must work *within* one
   item (the index is rows, not items, so this falls out).
4. Width change during a run while items are arriving: append into the *new* index only after the rebuild
   completes; never interleave two widths.
5. Zero items: the viewport is blank; the header and console still fill the screen exactly (P5).
6. Hidden items (`visibleItems`, `useEngine.tsx:75–92`) are excluded from the index, and a hidden-only batch must
   not invalidate it (the same stable-reference trick as `useVisibleItems`).
7. `--ascii` / theme change: `glyphTwin` and colours are applied at render, not in the index, so a `/theme` change
   does not rebuild it.
8. Sticky-bottom vs. a detached user: an append while detached must **not** move the view; the position indicator
   must update.
9. `PgUp` past the top / `PgDn` past the bottom clamps and reattaches respectively.
10. A pending review collapses the composer and takes viewport rows — the scroll position (a row index) survives a
    viewport height change; the anchor is the **top** row, not a percentage.
11. Terminal selection inside the viewport works for visible rows only; `/scrollback` and the exit dump are the
    documented escape hatches.

**Tests.** Unit: index append equals a full rebuild; rebuild at 80 vs 200 columns matches `wrapBody`;
**identity — `normaliseRows(index.rowsFor(item)) === formatTranscriptItem(item)` for every fixture in the existing
transcript identity suite**, run against the viewport builder as well as `<Transcript>`; scroll clamp/sticky
property tests. Render: `frame.split('\n').length === rows` with 0, 1, 20 000 items. PTY
(`test/pty/smoke/fullscreen-scroll.steps`): PgUp ×30 / PgDn ×20 / End, asserting the position segment changes, the
header rows are present in **every** frame, and no frame exceeds `rows`.

**Perf gate.** A new probe `src/perf/scroll-latency.ts`: scroll-key → frame p95 < 16 ms and ≤ 6 KB per scroll frame
at 40×120 with 20 000 items (prototype: 7.47 ms / 3 352 B with incremental). Plus the width-change rebuild must stay
under one debounce window (16.3 ms measured at 20 000 items; gate < 50 ms).

**Identity class.** **Layout.** The rows are the same `formatTranscriptItem` rows; `--plain` and `transcript.log`
are untouched, and the identity test is extended to cover the new renderer rather than relaxed.

---

### P7 — `/scrollback` and the on-exit transcript dump (what gives the alternate screen back)

**What.** (a) `/scrollback` suspends the renderer (`suspendTerminal`, which leaves the alt screen — I13), prints the
whole transcript to the primary screen through `createPlainRenderer`, waits for a key, and resumes. (b) On exit in
`fullscreen`, after `1049l`, write the same rows to the primary screen (`ui.fullscreenDump`, default on).

**Where.** `src/tui/commands/registry.ts` + `dispatch.ts` (one command, `fullscreen`-only, with a "not in classic"
message), `src/tui/App.tsx` `createTuiRenderer.unmount()`, `src/config/*` (`ui.fullscreenDump`), `docs/COMMANDS.md`,
completions, man page.

**Edge cases.**
1. Empty transcript → dump nothing.
2. `--json` / non-TTY → no dump.
3. A very long transcript → the dump is one large synchronous write; chunk it (64 KB) so a slow link does not block
   the exit path past `UNMOUNT_TIMEOUT_MS`.
4. A crash before `unmount()` → no dump; `RESTORE`'s `1049l` still runs (P4 edge 1). Document that
   `transcript.log` is the source of truth.
5. `/scrollback` while a run is live → allowed (the engine keeps running; items queue through the existing
   `createSuspensionQueue`, `src/tui/terminal.ts`), but the review box must not arm while suspended — reuse the
   existing suspension gate.
6. `/scrollback` under `classic` → `[ui] /scrollback is a fullscreen command; your terminal's scrollback already
   has the transcript`.
7. Ctrl+C during the dump → stop writing, exit 130.

**Tests.** Unit: the dump equals `createPlainRenderer`'s output for the same items, byte for byte (this is the
identity test for P6's architecture). PTY (`fullscreen-exit-dump.steps`): after `1049l` the capture ends with the
same rows a `--plain` run of the same script produces.

**Perf gate.** The dump happens after the last frame; it must not extend unmount past `UNMOUNT_TIMEOUT_MS`
(chunked write, measured in the pty test).

**Identity class.** **Text-adjacent but identity-preserving**: the dump *is* the `--plain` twin, produced by the
same formatter (`src/tui/plain.ts`). No engine-item text changes; no pinned test changes.

---

### P8 — Decide DECSTBM on evidence, not on argument (a 10-minute terminal-matrix probe)

**What.** Before B′ is ever revisited, add two observations per terminal to
`docs/research/tui/terminal-matrix.md`: (1) with `printf '\e[6;24r'; seq 1 200`, are the scrolled-out lines in the
terminal's scrollback? (2) after `printf '\e[2J\e[3J\e[H'`, is the scroll region still set? Terminals: Terminal.app,
iTerm2, Ghostty, WezTerm, Alacritty, kitty, tmux, GNU screen, VS Code integrated, Windows Terminal, ConPTY.

**Where.** `docs/research/tui/terminal-matrix.md` (two new columns), a `scripts/pty/decstbm-probe.sh` the tester
pastes.

**Edge cases.** None (a research task). The probe must be run *by hand in a real terminal* — a pty capture cannot
answer it, which is why this report could not.

**Tests / perf gate.** None.

**Identity class.** Neither.

---

### P9 — Make the off-by-one cliff impossible to re-introduce (a guard for both renderers)

**What.** A dev-only assertion plus a permanent pty assertion that no frame is taller than the terminal. In
`classic` the budget is `rows − 2` and `src/perf/pty.ts` already measures `paintedRows`; extend it to fail on
`paintedRows > rows` for **every** capture in the pty suite (today the region assertion is `≤ rows − 2` only in the
perf probes), and add a `JEVCODE_ASSERT_HEIGHT=1` development flag that throws when the rendered frame's line count
exceeds `rows`.

**Where.** `src/perf/pty.ts` (`paintedMax` → a hard assertion helper), `test/pty/run-smoke.sh` (run the assertion on
every `.steps` capture), `src/tui/App.tsx` (the dev assertion behind an env flag, compiled out of the default path
by an early `return` — no cost when unset).

**Edge cases.**
1. A shrink segment legitimately paints a taller frame for one frame before the rerender — assert per geometry
   segment, skipping the first frame after a `resize` step (the existing segment machinery, `docs/TUI-DESIGN.md:1891`).
2. `<Static>` rows are not part of the frame height — count only the dynamic block.
3. Screen-reader mode has no log-update frame structure — skip.

**Tests.** The assertion *is* the test; add one deliberately-too-tall fixture (`JEVCODE_FAULT=render:overheight`)
proving it fires.

**Perf gate.** Zero cost when the env flag is unset; the pty assertion runs on captures, not in the product.

**Identity class.** Neither.

---

## 9. What I would ship in round 4, in order

| order | proposal | size | user-visible effect |
| --- | --- | --- | --- |
| 1 | **P1** `ESC[3J` filter | ~60 lines + 2 tests | a window resize stops deleting the terminal's history |
| 2 | **P2** brand pinned on the rule row | ~40 lines | the word `jevcode` is on screen in every state, at the top of the dynamic region |
| 3 | **P3** mark stays up during a run at ≥ 32 rows | ~15 lines | on a normal-size terminal the art never disappears |
| 4 | **P9** height guard | ~80 lines | the cliff cannot be re-introduced |
| 5 | **P4–P7** the opt-in `fullscreen` renderer | ~900 lines | `/fullscreen` gives the literal pinned header, with `/scrollback` and an exit dump to pay back what the alternate screen takes |
| 6 | **P8** DECSTBM matrix probe | research | closes B′ with data |

P1–P3 and P9 together are less than 200 lines, touch no perf gate, change no transcript text, and answer the user's
sentence 1 for every terminal size. P4–P7 answer it *literally* for anyone who opts in, and are the only way to do
so that survives §3's measurements.

---

## 10. Risks

1. **`fullscreen` doubles the render surface.** Two App trees means two places every future overlay, card and key
   must be wired. Mitigation: `<FullApp>` reuses `Console`, `Overlay`, `Review`, `Composer`, `StatusLine`,
   `Transcript`'s builders and the key resolver unchanged — only `<Static>` → `<Viewport>` and the allocator differ.
   If that discipline slips, the two renderers drift and the identity rule becomes two rules.
2. **`incrementalRendering` is less exercised than `standard`.** It is a documented opt-in today
   (`src/config/launch.ts:127`) and forcing it on in `fullscreen` makes it load-bearing. Its Windows-console caveat
   is already in Ink (`ink.js:85–100`).
3. **P1's proxy sits on the hottest path in the program.** Every measurement in this report went through
   `stdout.write`; a bug there is a bug in everything. The trap must be `write` and nothing else.
4. **P2 changes a row that six pty fixtures match on.** The drop-order rule keeps narrow terminals byte-identical,
   but the ≥ 64-column fixtures will need re-pinning.
5. **The alternate screen strands users on crash.** P4 edge case 1 is the one that will generate support reports;
   `RESTORE` must be verified with `JEVCODE_FAULT` in the pty suite, not only by inspection.
6. **My latency numbers were taken on a loaded machine.** The A-vs-B *ratio* (4.5× at 60×200) is robust because both
   were measured in the same minute; the absolute p95 for the real fullscreen tree must be re-measured before P4–P7
   are gated.

## 11. Open questions for the owner

1. Should `/fullscreen` relaunch in place (Claude Code's `/tui fullscreen` "relaunches … with your conversation
   intact") or only take effect next launch? Relaunching means re-attaching the engine — a session-controller
   change outside this topic.
2. Is the duplicated transcript in the scrollback after a shrink (P1 edge case 12) acceptable, or should the filter
   also drop the re-emitted `fullStaticOutput` (cleaner screen, blank history above the frame until new items
   arrive)?
3. Should `ui.wordmark` gain a `header` value that pins the mark in `fullscreen` only, or is the renderer setting
   enough?
4. `WORDMARK_LIVE_MIN_ROWS = 32` (P3) is derived from the 11-row live region plus the mark's 5 plus a 16-row floor
   of visible scrollback. Is 16 rows of visible conversation the right floor, or should it be 20?
