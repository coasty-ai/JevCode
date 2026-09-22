# Round 4 · Topic A2 — resize and terminal robustness

Measured 2026-09-21/22, macOS 26 (Darwin 25.6.0), Node 22.23.2, Ink 7.1.1, expect 5.45.

The user's round-4 words this report answers: *"make sure the TUI is really robust, handles all edges and corner
cases and does not look weird when resized … handle literally all the edge and corner cases in the highest detail
possible, make this TUI heavy production grade"* (request 3), and — because the mark is the first thing a resize
destroys — *"make sure jevcode stays up on top the ascii design"* (request 1).

---

## 0. Method, and the two trees this report talks about

Two different artefacts are quoted below; every claim says which.

| | what it is | how it was read |
| --- | --- | --- |
| **PROBED** | the *committed* tree `ec61170` (= `HEAD` for `src/**`: `git diff ec61170 HEAD -- src/tui src/cli` is empty). This is **round 2 plus the parts of round 3 already committed**; `src/tui/wordmark.ts` does **not** exist in it, so the mark is still the 700 ms splash (`splash.ts:14 SPLASH_MS = 700`). | worktree `/tmp/jevcode-r4-resize`, `npm run -s build`, `node bin/jevcode.js … --mock` under `scripts/pty/drive.exp` with a temp `JEVCODE_HOME` and a temp `--workspace` copy of `examples/demo-py`. Worktree removed after the run. |
| **CODE (in flight)** | the working tree of `<repo>`, i.e. round 3 **as it is being implemented right now**. Never edited, never built, never run from there; pure modules were copied to `/tmp/jr4-src-r3` and executed with `tsx` for the static sweeps. | `sed`/`grep` for `file:line`; `tsx` for `computeLayout`, `wordmarkWanted`, `wrapBody`, `console-lines`. |

Probe harness, step files and the load-bearing captures are committed beside this report in
[`resize-probe/`](resize-probe/) (`run.sh`, `analyze.mjs` = frame/segment/clear parser, `widths.mjs` = per-frame row-width
audit, `borders.mjs` = "box row whose right border is an ellipsis" audit, `invariants.ts`, `matrix.ts`, `wrap2.ts`).
Frame numbers below are `syncframe` indices from `analyze.mjs <dir> sync` (split at Ink's `ESC[?2026h`, research 20 §3),
not `.txt` line numbers.

### 0.1 Three driver facts that change how every cell below must be read

1. **`resize R C` is two SIGWINCHes, not one.** `drive.exp`'s `resize` step runs `stty rows R cols C < $slave`
   (`scripts/pty/drive.exp:154–158`); macOS `stty` applies the operands with two ioctls. A Node probe
   ([`resize-probe/jr4-winch.mjs`](resize-probe/jr4-winch.mjs), capture
   [`jr4-winch.cap`](resize-probe/jr4-winch.cap)) at 24×80 shows, for `resize 12 60` → `resize 40 120`:

   ```
   start 80x24
   resize 80x12      <- rows applied, columns still old
   resize 60x12
   resize 60x40      <- rows applied, columns still old
   resize 120x40
   ```

   Every "one frame at the new rows and the old columns" in the tables below is this intermediate event, **not** an
   App bug — the App is self-consistent for the geometry it was handed. But it *is* the reason the App's fast path
   misses half of every resize (defect **D1**, §5), and it is why `test/pty`'s resize scenarios are really exercising
   two transitions each.
2. `sleep` in the driver drains the pty (research 20 §5); never add a bare Tcl `sleep`.
3. Tcl's `\xhh` swallows following hex digits, and a shell `printf` that emits `\\x1b` sends a literal backslash.
   Three of my first isolation probes were invalid for this reason; the surviving ones are generated from Python
   (one backslash in the file). Astral-plane input (👨‍👩‍👧‍👦) is re-encoded by expect and reaches the child as separate
   Latin-1 scalars — CJK and combining marks come through intact, four-byte emoji do not. **Emoji width cannot be
   measured through this driver**; it stays a `manual` cell.

---

## 1. Geometry matrix — the static half (boot at each size, PROBED + computed)

`analyze.mjs out/boot-<R>x<C> summary`; computed columns from `computeLayout`/`chromeRows` on the **in-flight** tree
(`resize-probe/matrix.ts`). "dyn" = rows from the rule row to the last row of the tallest frame. Budget = `rows − 2`.

| geometry | tier | dyn rows (probed) | budget | clears | degraded (computed) | console inner | `bodyWidth('[sandbox]')` | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0×0 | boxed (80×24 fallback) | 11 | 22 | 0 | none | 76 | 70 | **OK** — `App.tsx:2417` `s.rows \|\| DEFAULT_ROWS` |
| 1×10 | static-only | – | 0 | 0 | static-only | 6 | 1 | **defect D2** (183 stripped rows for one item) |
| 2×10 | static-only | – | 0 | 0 | static-only | 6 | 1 | **defect D2** |
| 3×20 | minsize | 1 (status only) | 1 | 0 | minsize | 16 | 10 | **defect D3** — no notice, no composer |
| 5×30 | minsize | 3 | 3 | 0 | minsize | 26 | 20 | **defect D3** — notice truncated: `terminal 30×5 is below the 40…` |
| 8×40 | flat | 3 | 6 | 0 | none | 36 | 30 | OK |
| 10×60 | flat | 3 | 8 | 0 | none | 56 | 50 | OK |
| 12×60 | flat | 3 | 10 | 0 | none | 56 | 50 | OK |
| 16×64 | boxed | 11 | 14 | 0 | none | 60 | 54 | OK |
| 20×80 | boxed | 11 | 18 | 0 | none | 76 | 70 | OK |
| 21×64 | boxed | – | 19 | – | none (mark wanted) | 60 | 54 | OK (`WORDMARK_MIN_ROWS = 21`) |
| 24×80 | boxed | 11 | 22 | 0 | none | 76 | 70 | OK |
| 30×100 | boxed | 11 | 28 | 0 | none | 96 | 90 | OK |
| 40×120 | boxed | 11 | 38 | 0 | none | 116 | 110 | OK |
| 50×160 | boxed | 11 | 48 | 0 | none | 156 | 150 | OK |
| 60×200 | boxed | 11 | 58 | 0 | none | 196 | 190 | OK |

**Allocator sweep (in-flight code, `resize-probe/invariants.ts`): 829 600 `computeLayout` calls** over
rows 0…60 × 17 widths × 10 overlay kinds × 8 overlay wants × 5 composer wants × screen-reader on/off —
**0 violations** of: `total ≤ budget`; the field sum equals `total`; `status === 1` at rows ≥ 3; `composer ≥ 1` at
rows ≥ 5 outside the wizard; `chrome ∈ {0,3}` and `chrome === 3 ⇒ rows ≥ 16`; `composerTop + composer ≤ budget`;
the whole-or-absent pane grant. **`consoleTopEdge`/`consoleRow`/`consoleDivider`/`consoleBottom` are exactly
`columns` cells at every width 0…200** (including 0, 1, 2, 3). The height allocator and the console string builders
are not where the trouble is.

The trouble is everywhere the *terminal* width meets *text*: the label gutter (D2), the notice (D3), the review keys
row (D5) — and the frame the renderer draws *between* two geometries (D1).

---

## 2. Transition matrix — state × resize (PROBED)

Marker key: **OK** = every frame self-consistent, 0 clears · **cos** = cosmetic, one or two frames · **DEF** = defect
· `clears` counted per geometry segment (`analyze.mjs … summary`).

| state | probe | shrink rows | grow rows | shrink cols | grow cols | clears | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| splash (resize at 200/350/500 ms) | `out/splash-resize` | OK | OK | OK | OK | 0 | **OK** — the splash survives three resizes inside 700 ms |
| idle hero, empty draft | `out/rows-cycle` 24→12→40→8→5→24 | OK | OK | – | – | **0** | **OK** (dyn ≤ budget at every step) |
| idle hero, 1-col width change | `out/wm1` 24×80→24×81→30×81 | – | OK | – | cos | 0 | OK |
| idle with a 120-char draft | `out/tear` 80→60→100→44→80 | – | – | **cos ×2 frames** | **cos ×1 frame** | 0 | **D1** |
| chatting, intake card up | `out/cols-shrink` 120→40→120 | – | – | cos (8 box rows end in `…`) | cos | 0 | **D1** |
| thinking / live run + 1-row panel | `out/live-resize` 24→12→5→40 | OK | OK | cos | cos | 1 per shrink | **D1**, D9 |
| live run, `/panel full`, 20 rows of pane | `out/live-resize` | OK | OK | cos | cos | 1 | D9 |
| live run, resize inside a frame write | `out/winch-write` 6 resizes in 100 ms | OK | OK | OK | OK | **0** | **OK** |
| review card (16 dyn rows) | `out/review-resize` 24×80→12×60→8×40→40×120 | OK | OK | cos | cos | **2 per shrink** | **D9**, D5 |
| palette open | `out/palette-resize` same ladder | OK | OK | cos | cos | 2 per shrink | D9 |
| picker open (18 dyn rows) | `out/picker-resize` same ladder | OK | OK | cos | cos | 2 per shrink | D9 |
| wizard (provider step) | `out/wizard-resize` 24→12→8→5→40→(Esc)→12→24 | OK | OK | cos | cos | 1 total | **D4 at minsize** |
| `/help` block in scrollback | `out/help-resize` 24×80→12×60→40×120 | OK | OK | OK | OK | 0 | OK |
| `/diff --full` (PAGER=cat) then back | `out/diffpager` | OK | OK | OK | OK | 0 | OK (a *real* interactive pager is unmeasured — see §8) |
| 500-line / ~25 KB bracketed paste, then resize | `out/paste` | OK | OK | OK | OK | 0 | **OK** — one `[Pasted #1, 500 lines]` chip, no body in any frame |
| Ctrl-Z → SIGCONT → resize | `out/tstp` | OK | OK | OK | OK | 0 | **OK** — draft `abcdef` survives, raw mode back, exit 0 |
| **storm: 20 resizes in 48 ms** | `out/storm` (23×79 … 30×86 … 24×80) | – | – | – | – | **0** | **OK** — only 3 geometry segments reach the wire |

**Storm detail** (`out/storm/timing.jsonl`): resizes at t = 1521…1569 ms (48 ms for 20 events, i.e. ~40 SIGWINCHes
after §0.1), 20 sync frames for the whole 4.3 s run, `w=80 / w=79 / w=80` segments, **0 clears**. The 50 ms trailing
debounce (`terminal.ts:20,138`) plus Ink's own coalescing hold. This cell is production grade today.

---

## 3. Terminal / environment matrix (PROBED unless marked)

Same step file for the comparable rows (`steps/term-nohide.steps`: settle · 24×80→12×60→24×80 · key · Ctrl-C · Ctrl-D ×2).

| environment | exit | clears | alt-screen / RIS | notes |
| --- | --- | --- | --- | --- |
| `TERM=xterm-256color` (baseline) | 0 | 0 | 0 | 630 SGR, 85 × `38;5;`, 41 × `ESC[?2026`, 3 × `ESC[?2004`, 2 × `ESC[n q` |
| `TERM=screen-256color` | 0 | 0 | 0 | identical byte count to tmux; **256-colour is used** — `terminal-matrix.md` §2 says "16 colours inside tmux by design" (**D11**, doc/behaviour mismatch) |
| `TERM=tmux-256color` | 0 | 0 | 0 | as above; 2026/2004/DECSCUSR still sent (tmux passes them through when configured) |
| `TERM=vt100` | 0 | 0 | 0 | **0 × `38;5;`** — the depth downshifts correctly; 2026/2004/DECSCUSR still emitted (ignored by a real vt100) |
| `TERM=dumb` | **2** | – | – | **D7**: `chat --mock` prints the run header, the `[sandbox]` note and `jevcode: missing task text` — `chat` silently becomes a one-shot `run` (`session.ts:326`, `main.tsx:65–70`) and never says the word `TERM` |
| `TERM` unset | not measured | | | `asciiAuto` only keys on `dumb`/`linux` (`launch.ts:87–93`); `isInteractive` only excludes `dumb` — so unset `TERM` takes the full TUI path |
| `NO_COLOR=1` | 0 | 0 | 0 | 11 730 bytes vs 19 545 coloured; frames identical in shape |
| `--ascii` | 0 | 0 | 0 | `+- jev-only --…-+` / `| › … |`; **the divider row and the bottom edge are both `+---…---+`** (**D8**) |
| `LANG=C` (non-UTF-8) | 0 | 0 | 0 | byte-identical to `--ascii` (19 539 vs 19 545) — `asciiAuto` fires |
| `SSH_TTY` set (fps 15) | 0 | 0 | 0 | 14 953 bytes, 18 frames; the resize cycle behaves the same, the torn frame of D1 simply lasts longer (≤ 67 ms per frame) |
| `--screen-reader` | 0 | 0 | 0 | flat 3–4 row region at both geometries |
| `COLUMNS=200 LINES=50` with a 24×80 pty | 0 | 0 | 0 | **ioctl wins** — only 80-cell rule rows in the capture. OK |
| stdin pipe, stdout TTY | – | – | – | one-shot `run` path (by design, §1 of TUI-DESIGN); same wording problem as D7 |
| stdout pipe, stdin TTY | – | – | – | same |
| stdout to a closed pipe (EPIPE) | **129** | – | – | **D12**: exits 129 with **nothing** on stderr |
| `SIGHUP` while raw | **129** | 0 | 0 | no terminal writes after the signal — correct (`terminal.ts:315` hang-up gate) |
| `SIGTSTP` (Ctrl-Z) → `SIGCONT` | 0 | 0 | 0 | `ESC[0 q` written twice (suspend + exit — the `rearm` design), `ESC[6 q` twice, frame repainted, draft intact |
| Windows Terminal / ConPTY | **not measurable here** | | | documented-only; ConPTY resizes reflow the buffer itself and deliver one resize event. The App's only Windows-specific risk is `process.kill(pid,'SIGSTOP')` in `suspendProcess` (`terminal.ts:251`), which throws on Windows and is caught → `finish()`; Ctrl-Z there is a no-op, which is correct. |
| iTerm2 / Terminal.app / VS Code / kitty | **manual** | | | unchanged from `terminal-matrix.md` §5; the new manual item is D1's torn frame (visible as a flicker of the box's right edge while dragging) |

**Never emitted by jevcode in any of the 69 captures:** `ESC[?1049h/l`, `ESC c`. (The one "forbidden" hit in the whole
corpus, `out/noise/capture.bin:10497`, is **vim's** alt-screen — see D6.)

---

## 4. Input and content edge cases (PROBED)

| case | result | verdict |
| --- | --- | --- |
| focus in/out `ESC[I` `ESC[O` | dropped | OK (`filter.ts:38 CSI_LEAK_RE`) |
| SGR mouse `ESC[<0;10;5M/m` | dropped | OK |
| DA1 reply `ESC[?62;1;2;6;9c` | dropped | OK |
| CPR `ESC[24;80R` | dropped | OK |
| kitty reply `ESC[?0u` | dropped | OK |
| **OSC 11 reply `ESC]11;rgb:0000/0000/0000 BEL`** | **`11;rgb:0000/0000/0000` appears in the draft** | **D6** |
| **two OSC replies back to back** | draft becomes `11;rgb:0000/0000/0000]11;rgb:1111/1111/1111`; Ctrl-D ×2 then cannot exit (driver had to SIGKILL, exit 124) | **D6** |
| OSC 52 reply `ESC]52;c;aGVsbG8= BEL` | same shape | **D6** |
| 8 replies as 8 writes in the same millisecond | leaks the OSC payload 3/3 runs; one run additionally **launched `$EDITOR`** (draft file `~/.jevcode/drafts/edit-63760-1.md`, 21 B = the OSC payload) — not reproduced with `EDITOR=/usr/bin/true` in 3 further runs | **D6** (the editor launch is filed as an open question, §8) |
| 500 lines / ~25 KB bracketed paste | one chip `[Pasted #1, 500 lines]`; no pasted line in any frame | OK |
| CJK + combining marks in the composer, then 80→42→80 | wraps by cells, two rows at 42, back to one at 80 | OK |
| RTL (Arabic + Hebrew) in the composer, 80→44→80 | no reordering, no cursor drift in the capture | OK (visual order on a real bidi terminal: **manual**) |
| ZWJ family emoji | **driver-mangled**, not measurable | manual |
| tabs / C0 / C1 / ANSI in engine text | `sanitizeStream` (`plain.ts:118–127`) is the one choke point; `oneLine` folds breaks/tabs; bidi controls dropped in `glyphs.ts:453–461` | OK by code; no probe needed |

---

## 5. Defect register

Each row: what, where (`file:line` on the **in-flight** tree unless marked), the evidence, the class.

### D1 — one or two torn frames per column change ("looks weird when resized") · **defect, cosmetic-severity, always reproducible**

`createTuiRenderer`'s early `resize` listener commits the tree synchronously **only when the rows shrank**:

```
src/tui/App.tsx:2419   let lastRows = geometryOf().rows;
src/tui/App.tsx:2424     const shrank = g.rows < lastRows;
src/tui/App.tsx:2426     if (shrank && instance !== null) instance.rerender(tree());
```

Every width change — and, because of §0.1, **the second event of every rows+columns resize** — takes the async path,
so Ink's own `resized` handler re-lays-out the *stale* tree at the new viewport before React commits. Second source:
the composer body is laid out at the 50 ms-debounced `wrapColumns` while the box edges follow `columns` immediately
(`terminal.ts:20`, `App.tsx:725–728`, `App.tsx:2228 bodyColumns={wrapColumns}`, `Console.tsx:59–65,124`).

Measured — `out/tear` (plain ASCII draft, 24 rows, 80→60→100→44→80):

* **shrink**, frame 16 — *the whole box* loses its right border to the truncation ellipsis:

  ```
  ╭─ jev-only ───────────────────────────────…
  │ › the quick brown fox jumps over the lazy…
  │   of plain ascii text here               …
  ├──────────────────────────────────────────…
  │ idle                                     …
  ╰──────────────────────────────────────────…
  ```
* **shrink**, frame 17 — edges corrected, body still at the old width for the debounce window:
  `│ › the quick brown fox jumps over the lazy…`
* **grow**, frame 19 — box at 80, body rows at 44, a stray `│` in mid-row and dead space after it:

  ```
  │ › the quick brown fox jumps over the     │
  │   lazy dog and keeps typing well past    │
  ```

`borders.mjs out/tear`: **4 of 24 frames** carry a box row whose right border is an ellipsis — one per column change.
`widths.mjs out/tear`: 2 frames whose console rows are not the rule row's width. Same shape in `out/content`
(frames 11–14, 18–19), `out/cols-shrink` (frame 11: **8** box rows ending in `…`; frame 15: body 40 cells inside a
120-cell box), `out/review-resize` (frame 25), `out/picker-resize` (frame 19).

Duration: ≥ `RESIZE_DEBOUNCE_MS` (50 ms) for the body half, one render tick for the edge half; at `--fps 15` (SSH) up
to ~130 ms. This is precisely what a user sees as "weird" while dragging a window edge.

### D2 — the label gutter eats the transcript below ~20 columns; the §5.3 identity normaliser fails below ~32 · **defect**

```
src/tui/Transcript.tsx:48    export const LABEL_GUTTER = 10;
src/tui/Transcript.tsx:111–114  bodyWidth = Math.max(1, columns − max(9, label) − 1)
```

The `Math.max(1, …)` floor means a **one-cell body column** at ≤ 10 columns. PROBED at 1×10 and 2×10: the single
`[sandbox]` item becomes one character per row — `analyze.mjs out/boot-2x10 raw | wc -l` = **183 rows** for a
3-second session:

```
[sandbox] s
          e
          a
          t
```

Static (in-flight `wrapBody`, `resize-probe/wrap2.ts`, real `[step 4] replan …` item, 296 chars):

| columns | bodyWidth | rows | `joinWrapped(rows) === body` |
| --- | --- | --- | --- |
| 10 | 1 | **245** | LOST |
| 12 | 2 | 133 | LOST |
| 16 | 6 | 56 | LOST |
| 20 | 10 | 35 | LOST |
| 24 | 14 | 25 | LOST |
| 30 | 20 | 17 | LOST |
| **32** | 22 | 15 | **ok** |
| 40 | 30 | 11 | ok |
| 80 | 70 | 5 | ok |

Two separate problems: (a) the row count explosion below 20 columns; (b) the §5.3 normaliser
("the result equals `formatTranscriptItem(item)`") only holds once no token is wider than the row. At the
**supported minimum of 40 columns** `bodyWidth` is 30 cells, so any path/id/URL token of 31+ cells
(`packages/app/src/components/SomeName.test.tsx`, a 40-char sha, a run id plus a suffix) already breaks it —
`hardSplit` (`transcript/wrap.ts:29–59`) splits the token and `joinWrapped` re-joins the pieces with a space.
Good news: round 3's explicit `wrapBody` produces **0 rows that begin with a space** at every width I tried, which
fixes the round-2 artefact still visible in `out/live-resize` frame 44 (`… than the repeated` / `          one.`,
one extra leading space under a 9-space hanging indent).

### D3 — the minimum-size notice is the row most likely to be cut, and the first to be dropped · **defect**

```
src/tui/Overlay.tsx:49–52  `terminal ${columns}×${rows} is below the 40×8 minimum — panes hidden, transcript above`
src/tui/Overlay.tsx:282–284  the minsize branch renders it for every overlay kind
src/tui/layout.ts:160–168    minsize: status(1) · notice(1) · composer(1), in that allocation order
```

The string is 71 cells at 24×80. It is only ever shown when the terminal is *smaller than 40×8*, so it is **always**
truncated. PROBED:

| geometry | what the user sees |
| --- | --- |
| 5×30 (`out/boot-5x30` frame 5) | `terminal 30×5 is below the 40…` — the number that says what to do is cut |
| 5×60 (`out/live-resize` frame 44) | `terminal 60×5 is below the 40×8 minimum — panes hidden, tra…` |
| 5×80 (`out/rows-cycle` frame 11) | full text (fits only at ≥ 71 columns, i.e. only when *rows* are the problem) |
| 3×20 (`out/boot-3x20` frame 2) | **only** `! press C…  step 0/–` — budget is 1, `status` takes it, the notice and the composer get 0 |
| 5×40, rows becoming 40 mid-resize (`out/wizard-resize` frame 14) | `terminal 30×40 is below the 4…` — reads as if 40 rows were too few |

Three sub-problems: the text has no narrow rung; it never says *which* dimension is short; and at rows 3–4 it loses
to `status`, which is the least useful of the three rows at that size.

### D4 — the onboarding wizard is replaced by a dead composer at minsize · **defect (highest user impact of this set)**

`computeLayout`'s minsize branch (`layout.ts:160–168`) does not special-case `overlay === 'wizard'` — unlike the
normal path, which refunds the composer floor to the wizard (`layout.ts:173–177`). `Overlay.tsx:282–284` returns the
notice for every kind. PROBED, `out/wizard-resize` frames 11–15, first run of the product with no key:

```
frame 10 (24×80)   │ No Jev key found. Where do you reach Jev?      (wizard, console-hosted)
frame 11 (40×5)    terminal 40×5 is below the 40×8 minimum…
                   › Say hi, ask a question, or describe a task…     <- the ordinary composer
                   jev-only · setup                step 0/–          <- status still says setup
```

The user is invited to type a task into a composer whose Enter cannot start anything, during onboarding, with the
status row still claiming `setup`. This is the single worst "corner case looks weird" in the corpus.

### D5 — the review keys row has two rungs and is hard-truncated below 76 cells · **defect (safety-adjacent)**

```
src/tui/review/lines.ts:19   REVIEW_KEYS_80  (76 cells)
src/tui/review/lines.ts:21   REVIEW_KEYS_120 (114 cells)
src/tui/review/lines.ts:168  truncateCells(columns >= 120 ? KEYS_120 : KEYS_80, columns, g)
```

PROBED `out/review-resize` frames 22–23 at 40 columns:

```
│ [y] approve [n] decline [d] decline+not… │
```

`[e] expand`, `[w]1-5 why` and **`[esc] decline`** are invisible. The gauge block already has a narrow rung
(frame 21 collapses five gauge rows to `1 destructive L2 r=0.50 exp c=1.00 | 5 matches_intent p=0.9…`) — the keys
row, the one row a reviewer must read, does not.

### D6 — an OSC reply on stdin is typed into the composer · **defect (robustness + a paste-shaped surprise)**

```
src/tui/composer/filter.ts:40   OSC_LEAK_RE = /^\]\d+;/
src/tui/composer/filter.ts:104  if (OSC_LEAK_RE.test(raw) || raw === OSC_ST_TAIL || raw === ESC + OSC_ST_TAIL) drop
```

The regex needs the chunk to *start with* `]`. Measured, Ink hands the filter the body **without** the `]` for the
first OSC of a read. PROBED, `out/q-osc11` (one reply) and `out/q-osc11x2` (two), reproduced 3/3 in `out/noise-1..3`:

```
│ › 11;rgb:0000/0000/0000
│ › 11;rgb:0000/0000/0000]11;rgb:1111/1111/1111
```

jevcode never *sends* a query (`kittyKeyboard: {mode:'disabled'}`, `App.tsx:2437`; no DA1/OSC 11/`CSI ?2026$p`), but
a reply can arrive anyway: a program that ran before jevcode in the same pane (neovim queries OSC 11 at startup and
its answer can land after exit), tmux passthrough, a terminal that volunteers OSC 4/11 on focus. With a non-empty
draft Ctrl-D ×2 stops exiting, so the session appears wedged (`out/q-osc11x2` exit 124).

### D7 — `TERM=dumb` turns `jevcode chat` into a usage error · **defect (diagnosability)**

`session.ts:326` `isInteractive` excludes `TERM=dumb`; `main.tsx:68` also excludes it from the readline composer; so
`main.tsx:69` makes `chat` `one-shot`, and with no argv the controller prints
`jevcode: missing task text: pass it as a positional argument, --task-file <path>, or on stdin` and exits 2
(`out/term-dumb`). The word `TERM` never appears. Exactly the class of user who sets `TERM=dumb` (Emacs `M-x shell`,
a CI shell, an accessibility setup) gets the least informative message in the product.

### D8 — `--ascii` draws the console divider and the bottom edge identically · **cosmetic**

`out/ascii` last frame:

```
+- jev-only ----------------------------------------------------- ws -+
| > Say hi, ask a question, or describe a task...                      |
+----------------------------------------------------------------------+   <- divider
| ! press Ctrl-D again to exit            step 0/-  sess $0.00/1.25 ok |
+----------------------------------------------------------------------+   <- bottom
```

Unicode distinguishes `├ ┤` from `╰ ╯`; ASCII does not, so the status compartment reads as a second box.

### D9 — two clears per shrink whenever a tall overlay is up · **defect (an open gate), now explained**

`terminal-matrix.md` row 16 records "1–2 clears per shrink, the design bound of 1 is open". Reproduced and
attributed: `out/review-resize` (1 clear in the `w=80` segment + 1 in `w=60`), `out/palette-resize` (same),
`out/picker-resize` (same); `out/rows-cycle` and `out/storm` with a short region cost **0**. Cause = §0.1 + D1: the
first SIGWINCH (rows shrank, old columns) is committed synchronously and costs the one legitimate clear; the second
(width only) is not, so Ink repaints the stale tree and clears again. Fixing D1 collapses this to the design bound
of 1.

### D10 — round 2's Ink wrap emits an over-indented continuation row · **fixed in flight; keep a predicate**

`out/live-resize` frame 44 at 60 columns: `…than the repeated` / `          one.` (10 spaces under a 9-space hanging
indent). Round 3's `wrapBody` never produces a row starting with a space (measured 0 at every width in
`resize-probe/wrap2.ts`), so this disappears when §5.1 rule 3 lands — but nothing currently *asserts* it.

### D11 — tmux colour row in `terminal-matrix.md` §2 contradicts the build · minor doc

`TERM=screen-256color` / `tmux-256color`: 85 `38;5;` sequences per capture. The doc says "16 colours inside tmux by
design". `TERM=vt100` correctly emits 0.

### D12 — EPIPE on stdout exits 129 silently · minor

`node bin/jevcode.js run … | head -1` → exit 129, empty stderr.

---

## 6. Proposals

Every proposal names: **what**, **where**, **edge cases** (enumerated), **tests** (unit + pty), **the gate it must
satisfy**, and **identity class** per TUI-DESIGN-3 §5.3.

---

### P1 — Commit synchronously on *any* shrinking dimension, and on every width change

**What.** In `createTuiRenderer`'s early `resize` listener, replace the rows-only shrink test with a
"the new viewport cannot contain the last frame, in either axis" test, and commit synchronously for a width change
too. Keep the async path only for a pure grow in both axes (today's zero-clear case).

```
- let lastRows = geometryOf().rows;
+ let last = geometryOf();
  const onEarlyResize = (): void => {
    const g = geometryOf();
    bridge.geometry = g;
    bridge.notify();
-   const shrank = g.rows < lastRows;
-   lastRows = g.rows;
-   if (shrank && instance !== null) instance.rerender(tree());
+   const shrank = g.rows < last.rows || g.columns < last.columns;
+   const widthChanged = g.columns !== last.columns;
+   last = g;
+   if ((shrank || widthChanged) && instance !== null) instance.rerender(tree());
  };
```

**Where.** `src/tui/App.tsx:2415–2428` only. (Owner note: `App.tsx` is a shared file — TUI-DESIGN-3 §7.2 row for
`App.tsx`.)

**Edge cases.** (1) width-only shrink; (2) width-only grow; (3) the §0.1 two-event rows+columns change, both orders;
(4) a storm — `instance.rerender` is a synchronous `updateContainerSync` + `flushSyncWork`, so 40 events in 48 ms
means 40 synchronous commits: measure, and if the storm budget is exceeded, gate the synchronous path behind
"≥ 8 ms since the last synchronous commit" and let the debounce catch the tail; (5) `instance === null` (before
`render()` returns) — already handled; (6) `stdout` is not `process.stdout` (tests mount `<App>` directly) — the
listener is only attached when `typeof stdout.on === 'function'`, unchanged; (7) 0×0 — `geometryOf` falls back to
80×24, so `shrank` is false and nothing extra runs; (8) reduced motion / `--fps 5` — the commit is independent of
`maxFps`; (9) during a `suspendTerminal()` window (Ctrl-Z, `$EDITOR`): a resize arriving while Ink is suspended must
**not** write — assert that `instance.rerender` during suspension produces no bytes (Ink buffers), else guard with
the suspension flag the App already keeps for the `<Static>` queue (`terminal.ts:174–203`).

**Tests.**
*unit* `test/unit/tui/renderer-resize.test.tsx` (new): a fake `stdout` with settable `rows`/`columns` and a spy
`rerender`; assert a synchronous commit for each of ↓rows, ↓cols, ↔rows/↓cols, ↑rows/↓cols, and none for ↑rows/↑cols;
assert the storm guard's rate.
*pty* extend `test/pty/smoke/resize.steps` with a width-only pair and add `resize-cols.steps`
(24×120 → 24×40 → 24×120 with a 120-char draft); new assertion in `test/pty/round2.pty.test.ts` (or a round-4 file)
using the **V22 predicate of P11**: `borders.mjs`-style — *no frame contains a row starting with a box glyph and
ending in the truncation ellipsis*, and *every console/card row is exactly the width of that frame's rule row*.
Baseline to beat: `out/tear` 4/24 frames → 0.

**Gate.** `zero clears after the first frame outside shrink segments` (TUI-DESIGN-3 §9) — must not regress, and the
shrink allowance drops from 2 to **1** per shrink segment (this closes D9 and `terminal-matrix.md` row 16).
`region ≤ rows − 2` unchanged. `composer keystroke → frame p95 < 16 ms` must hold with the extra synchronous commits
(`composer-latency.ts`); `lag p95 < 5 ms while typing during a run` (`render-lag.ts`) is the one at risk — run the
storm scenario under `render-lag` before and after.

**Identity.** Colour/layout only — **no** transcript text changes. No twin to update.

---

### P2 — One geometry, one frame: the composer body never lags the box

**What.** Remove the width skew that P1 cannot fix. Today `wrapColumns` is a debounced *state* (`App.tsx:723–728`) and
the Console lays the draft out at it while the edges use `columns` (`Console.tsx:124`). Invert it: the draft always
wraps at the **same `columns` the edges use**, and the debounce becomes a *render coalescer* — `wrapColumns` is
deleted, and the cost the debounce was protecting (re-running `draftRows` on every SIGWINCH) is paid only on the
commits P1 already performs. If re-wrap cost is measured to matter for a very long draft, keep a debounce but apply
it to *both* the edges and the body (one `renderColumns` value feeding `computeLayout`, `Console.columns` and
`Console.bodyColumns`), so a frame is never internally inconsistent.

**Where.** `src/tui/App.tsx:647` (`wrapColumns` state), `:723–728` (the debounce effect), `:1703`
(`composer.apply({columns: wrapColumns})`), `:2228` (`bodyColumns={wrapColumns}`), `:2268` (`<Composer columns=…>`);
`src/tui/Console.tsx:59–65,124` (drop `bodyColumns`, or keep it as `renderColumns`); `src/tui/terminal.ts:19–20`
(`RESIZE_DEBOUNCE_MS` keeps its doc comment or is retired with the state).

**Edge cases.** (1) a 6-row draft at 200 columns shrunk to 40 — `draftRows` must be re-run before `computeLayout`, or
the layout grants fewer rows than the Console draws (this is exactly why `bodyColumns` exists: keep the *single*
value, never two); (2) the cursor formula `{x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row}`
(`Console.tsx:10–12`) must be recomputed in the same render; (3) a draft that is a paste chip (width-independent);
(4) the wizard hosting the console rows (`wizardBodyRows`, `Console.tsx:111–114`); (5) the picker's `filter:` prompt
(a different prompt width, `App.tsx:2015`); (6) `--screen-reader` flat tier (no box, still must not skew);
(7) 0-column / non-finite `columns` — `Console.tsx:121` already clamps to 4.

**Tests.**
*unit* `test/unit/tui/console.test.tsx`: render at 80 with a 120-char draft, re-render at 44, assert
`ConsoleRows.body[i]` width === 44 for every row in the *same* commit (today they disagree for ≤ 50 ms);
`test/unit/tui/height.test.tsx` gains a "re-wrap and layout agree" case at 44/60/100 columns.
*pty* `resize-cols.steps` (P1) additionally asserts **0** frames flagged by `widths.mjs`.

**Gate.** `composer keystroke → frame p95 < 16 ms, max < 50 ms` (the re-wrap now happens on the resize commit, never
on a keystroke); `lag p95 net < 5 ms`; `rows − 2 at every geometry`.

**Identity.** Colour/layout only.

---

### P3 — A gutter floor, so the transcript never degenerates to one cell

**What.** Add `MIN_BODY_CELLS = 24` beside `LABEL_GUTTER`. `bodyWidth(columns, label)` returns
`columns − gutter − 1` while that is ≥ `MIN_BODY_CELLS`; below it the gutter **collapses**: the label is drawn on its
own row and the body wraps at `columns − 2` with a 2-cell hanging indent. Below `columns < MIN_BODY_CELLS + 2` the
body wraps at `columns` with no indent at all.

```
24 columns and wider      │ [step 4] replan change_approach p=0.80
                          │          c=0.76 impossible=0.05: After
below 24 columns          │ [step 4]
                          │   replan change_approach
                          │   p=0.80 c=0.76
```

**Where.** `src/tui/Transcript.tsx:47–48` (the new constant), `:105–120` (`gutterLabel`, `bodyWidth`, `bodyRows`),
`:185–210` (the row/column JSX: a second layout branch), `:67–80` (`detailRows` indent). One new exported helper
`gutterMode(columns, label): 'gutter' | 'stacked' | 'flush'` so the tests and the `--plain` twin read one function.

**Edge cases.** (1) `columns` 1, 2, 3 — body width ≥ 1, never 0 (Ink would loop); (2) a label wider than the gutter
(`[step 100]`, `[step 1000]`): `max(9, label)` already handles the wide case, the stacked mode makes it moot;
(3) a `detail` body (`DETAIL_TABLE_RE`, `Transcript.tsx:67–76`) must use the same mode; (4) `--ascii` labels are the
same width; (5) a screen reader (`launch.screenReader`) — stacked mode is *better* for it, so apply it unconditionally
below the threshold; (6) the `<Static>` box width prop (`Transcript.tsx:184` `width={columns}`) must follow the mode;
(7) a resize from 80 to 16 **does not re-wrap items already committed to `<Static>`** — the terminal hard-wraps them
itself; only new items use the new mode (document this, it is inherent to scrollback); (8) `columns === undefined`
(tests without geometry) — unchanged, one `<Text>`.

**Tests.**
*unit* `test/unit/tui/transcript.test.tsx`: at 10/12/16/20/24/40/80 columns assert `bodyRows(item).length` ≤ a table
(today 245 at 10 columns; target ≤ 40) and that no row is empty;
`test/unit/tui/transcript/wrap.test.ts`: the `gutterMode` table.
*pty* new `steps/tiny-cols.steps` — boot at 2×10 and 5×16, one `[sandbox]` item, assert the stripped capture has
< 40 rows (today 183) and that every row is non-empty.

**Gate.** `rows − 2 at every geometry` (unchanged — this is scrollback, not the region); the first-frame gate
(< 300 ms at 8×40) must not regress: `gutterMode` is one comparison.

**Identity.** **Colour/layout only** — `wrapBody`/`gutterLabel` change *where* rows break, never the tokens; the
§5.3 normaliser must still return `formatTranscriptItem(item)` in gutter mode, and in stacked mode the normaliser
gains one clause: *the label row and the following body rows join with one space* (declare it in §5.3's table,
alongside the existing "strip the gutter of every continuation row").

---

### P4 — Make the §5.3 identity normaliser exact under a hard grapheme cut

**What.** `wrapBody` currently loses the identity property whenever a single token is wider than the row
(`transcript/wrap.ts:82` `hardSplit`), which happens at the supported minimum of 40 columns for any 31-cell path or
id. Add a sibling that reports the cuts and a normaliser that honours them:

```ts
export interface WrappedBody { rows: string[]; /** indices i where rows[i] continues rows[i-1] mid-token */ cuts: readonly number[] }
export function wrapBodyCut(text: string, width: number, g?: GlyphSet): WrappedBody;
export function joinWrapped(rows: readonly string[], cuts: readonly number[] = []): string;  // '' at a cut, ' ' otherwise
```

`wrapBody` stays as the thin wrapper `wrapBodyCut(…).rows` so no caller changes.

**Where.** `src/tui/transcript/wrap.ts:26–59` (`hardSplit` returns its piece count), `:61–89` (`packWords` threads
the cut indices), `:163–201` (`wrapBody`/`wrapBodyCut`), `:203–216` (`joinWrapped`); the two test helpers named in
TUI-DESIGN-3 §5.3 (`app.test.tsx:299`, `round2-transcript.test.tsx:23`).

**Edge cases.** (1) a cut inside a wide (CJK) cluster — cut indices are row indices, so width does not matter;
(2) a cut at the first row (`rows[0]` can never be a cut); (3) the segment-aware path
(`transcript/wrap.ts:175–199`) where a continuation begins with `· ` — that row is *not* a cut; (4) `joinOrphan`
moving a token across a row boundary must not turn a cut into a non-cut (it only moves whole tokens — assert);
(5) an empty body; (6) `width ≤ 0` (one row, no cuts).

**Tests.**
*unit* `test/unit/tui/transcript/wrap.test.ts`: property test — for 500 generated bodies (words 1…60 cells, with and
without ` · `) at widths 4…120, `joinWrapped(rows, cuts) === body` **always**; plus the two explicit cases §5.3 names.
*pty* none needed (pure).

**Gate.** `line identity` (TUI-DESIGN-3 §9) — this *strengthens* it from "whenever no token is wider than the row"
to unconditional.

**Identity.** Colour/layout; the normaliser's *definition* changes, so TUI-DESIGN-3 §5.3's paragraph gains the cut
clause and the two test helpers move to `joinWrapped(rows, cuts)`.

---

### P5 — The minimum-size notice: a width ladder, the short dimension named, and the right yield order

**What.** Three changes.

1. A rung ladder in `minsizeNotice(columns, rows, g)`:

   | room | text |
   | --- | --- |
   | ≥ 71 | `terminal 30×5 is below the 40×8 minimum — panes hidden, transcript above` |
   | ≥ 44 | `30×5 < 40×8 minimum — panes hidden` |
   | ≥ 26 | `too short: need 8 rows` / `too narrow: need 40 cols` (the short dimension only) |
   | ≥ 14 | `need 8 rows` / `need 40 cols` |
   | < 14 | `40×8 min` |

   Name the short dimension (both, when both are short: `need 40×8`). The current text reads as a contradiction at
   `terminal 30×40 is below the 40×8 minimum`.
2. In `computeLayout`'s minsize branch, allocate **notice → composer → status** instead of **status → notice →
   composer**, so at budget 1 the user is told why the UI vanished rather than shown a spinner-less status row.
3. `Overlay.tsx` renders the notice at `consoleInnerWidth`-independent full width (it already does) but must pick the
   rung from `p.columns`, not truncate.

**Where.** `src/tui/Overlay.tsx:47–52` (the ladder), `:282–284` (rung selection); `src/tui/layout.ts:160–168`
(allocation order) — and `docs/TUI-DESIGN.md` §2.1 A100's sentence, which currently pins "status · notice ·
composer".

**Edge cases.** (1) budget 0 (rows < 3) — static-only, nothing drawn, unchanged; (2) budget 1 — notice only;
(3) budget 2 — notice + composer (no status); (4) budget 3 — all three; (5) `--ascii` (`×`→`x`, `—`→`-`, already
handled at `Overlay.tsx:49–51`); (6) `--screen-reader` — the notice is the one row that must survive, this ordering
guarantees it; (7) the mid-resize mixed geometry of §0.1 (`30×40`): the "too narrow" rung is correct there;
(8) columns exactly 40 and rows exactly 8 — not minsize at all (boundary test).

**Tests.**
*unit* `test/unit/tui/overlay.test.tsx`: the rung table at widths 10…80 × (short rows / short cols / both), asserting
`cellWidth(notice) ≤ columns` **always**; `test/unit/tui/layout.test.ts`: the minsize allocation at budgets 0…3.
*pty* new `steps/minsize.steps`: boot 24×80 → 3×20 → 5×30 → 5×60 → 24×80; assert each minsize frame's first row is a
complete sentence (no trailing `…`) and that the notice is present at every budget ≥ 1.

**Gate.** `rows − 2 at every geometry`; `zero clears outside shrink segments` (probed 0 today at these sizes — keep it).

**Identity.** The notice is a **dynamic region row**, not a transcript item — colour/layout class, no `transcript.log`
or `--plain` twin (the `--plain` renderer has no region). Confirm against `plain.ts` before landing.

---

### P6 — The wizard survives minsize (it *is* the input)

**What.** In the minsize branch of `computeLayout`, when `overlay === 'wizard'` allocate **notice(1) · wizard(1)**
and no composer — the same refund the normal path already makes (`layout.ts:173–177`). In `Overlay.tsx`, the minsize
branch must render a one-row wizard twin for the current step instead of the notice when the wizard owns the input
(e.g. `setup · key — terminal too small; ≥ 40×8 to type` for a field step, and the numbered choice row for a choice
step, which fits: `1 typesafe  2 openrouter` is 24 cells). The App must not render `<Composer>` while the wizard owns
the input at any tier (`App.tsx:2268` already passes `EMPTY_BUFFER` for collapsing overlays — add `wizard`).

**Where.** `src/tui/layout.ts:160–168`; `src/tui/Overlay.tsx:282–284`; `src/tui/onboarding/lines.ts` (a
`wizardMinsizeRow(state, columns)` beside `wizardLines`); `src/tui/App.tsx:2268`.

**Edge cases.** (1) every wizard step (`options`, `key`, `verify`, `trust`, `mode`, `done`) — one row each, from one
table; (2) the masked field (`MaskedField.tsx`) must **never** be drawn at 1 row in a way that could echo a key —
the minsize row shows `•` count only, or nothing; (3) rows < 3 (static-only): the wizard cannot be shown at all —
emit one `<Static>` item `setup needs a terminal of at least 40×8` once per size drop, not per frame;
(4) Esc → options → resize → Esc (the flow in `out/wizard-resize`); (5) Ctrl-C at minsize must still exit 2 with the
epilogue (probed: it does); (6) `--screen-reader` (already flat, but minsize must not swallow the numbered prompt);
(7) `--plain` wizard is unaffected (no region).

**Tests.**
*unit* `test/unit/tui/onboarding/lines.test.ts`: `wizardMinsizeRow` for every step at 20/30/40 columns, asserting
`cellWidth ≤ columns` and that no masked byte appears;
`test/unit/tui/layout.test.ts`: minsize + `overlay: 'wizard'` ⇒ `composer === 0`, `overlay ≥ 1`.
*pty* extend `test/pty/smoke/r3-wizard-resize.steps` with 8×40 and 5×30 rungs; assert the frames at those sizes
contain the word `setup` and **never** the task placeholder `Say hi`; `assertNoKeyBytes` over the whole capture.

**Gate.** `keys never in logs or frames`; `rows − 2 at every geometry`; first frame < 300 ms at 8×40 (the wizard is
the first frame of a keyless run).

**Identity.** Colour/layout for the region; the new one-row strings are **new user-visible text** → they belong in
TUI-DESIGN-3 §10's glossary and get a `--plain`/screen-reader answer (the plain wizard already has its own prompts,
so "none" is the likely answer — state it).

---

### P7 — A narrow rung for the review keys row; drop words, never keys

**What.** Add `REVIEW_KEYS_60` and `REVIEW_KEYS_40` and select by fit rather than by a `>= 120` threshold:

```
120+  [y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run
 76+  [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
 56+  [y] ok [n] no [d] note [e] expand [w] why [esc] decline
 36+  y ok · n no · d note · e exp · w why · esc
 <36  y/n/d/e/w · esc
```

Selection = the widest rung whose `cellWidth ≤ innerCells`; `truncateCells` remains only as a last resort.

**Where.** `src/tui/review/lines.ts:19–21` (the rungs), `:168` (selection — take `innerCells`, i.e. the card's
`columns − 4`, not `columns`); the same rule for `exitConfirmRow` (`Overlay.tsx:36–38`, which already has a two-rung
ladder — reuse one helper `fitRung(rungs, cells)`), the intake row (TUI-DESIGN-2 §3.7 already ladders) and the
blocking card.

**Edge cases.** (1) the flat tier (no card, `columns` is the width); (2) `--ascii` (same ASCII letters, `·`→`-`);
(3) `--screen-reader` uses `SR_REVIEW_CHOICES` (`review/lines.ts:27`) — untouched; (4) a keybindings.json rebinding
(TUI-DESIGN-3 §4.4 F10 `setBindings`) — the rung text must be **derived from the effective bindings**, not a literal,
or a rebound approve key prints the wrong letter; today it is a literal, which is a second, latent defect;
(5) `[ctrl-c] abort run` only when a run is live; (6) widths 36…40 where the card's inner width is 32…36.

**Tests.**
*unit* `test/unit/tui/review/lines.test.ts`: for widths 20…160, the chosen rung fits **and** contains every one of
`y n d e w esc`; a rebinding case once (4) lands.
*pty* extend `test/pty/smoke/review-y.steps` with a 40-column and a 56-column rung; assert `esc` is visible in the
keys row at both.

**Gate.** `review invariants` (only `y` approves; Enter inert) — drawing only, unchanged. `rows − 2`.

**Identity.** The keys row is a **dynamic region row** (colour/layout class), but the *strings* are user-visible and
go in §10's glossary; `--plain`'s confirmer prints its own prompt (`plain.ts`), so check the twin and update it if it
shares the constant.

---

### P8 — Filter an OSC answer whose introducer Ink already ate

**What.** `OSC_LEAK_RE` must match the body form too, and a chunk that is a concatenation of leak bodies must be
dropped whole. Concretely: treat a chunk as an OSC answer when it matches
`/^\]?\d{1,4};(?:rgb:[0-9a-f/]+|[A-Za-z0-9+/=]{0,4096}|[\x20-\x7e]{0,256})(?:\x07|\x1b\\)?$/i` **and** the chunk did
not arrive as bracketed-paste content and does not contain a newline — plus split the raw chunk on `]` and require
every piece to be a leak body (the existing `isLeakBody` fold at `filter.ts:86,108`, extended). Bump the existing
`osc` drop reason so the `key filtered` trace still names it.

**Where.** `src/tui/composer/filter.ts:38–44` (the regexes), `:80–112` (`isLeakBody`, the drop decision), and the
module doc-comment at `:1–17` which currently asserts "OSC fragments all arrive as text with the leading ESC
stripped" — the measurement says the `]` is stripped too.

**Edge cases.** (1) a user legitimately typing `11;rgb:…` — mitigate by requiring the chunk to arrive as **one**
`useInput` text chunk of ≥ 6 chars with no preceding keystroke in the same tick, and by never dropping a chunk that
arrived inside a bracketed paste (`usePaste`); a typed digit-semicolon string is delivered one keystroke at a time,
so the rule cannot fire on typing — assert this in the unit test; (2) OSC 52 base64 (may be long — cap at 4096 and
drop the remainder rather than insert it); (3) the ST form `ESC \` and the BEL form; (4) an OSC split across two
reads — the tail has no `;` prefix and is indistinguishable from typed text (documented limit, same as the CSI tail
at `filter.ts:14–16`); (5) two answers concatenated (the measured case); (6) an OSC answer arriving while the review
box is up — the box already swallows printable keys (research 20 §5), assert it still does; (7) an OSC answer while
`--screen-reader` (numbered prompts read digits!) — the filter runs before the prompt reader; add a case.

**Tests.**
*unit* `test/unit/tui/composer/filter.test.ts`: the six shapes above, plus 20 "a human typed this" negatives.
*pty* new `steps/osc-noise.steps` (Python-generated, §0.1 rule 3): one OSC 11 answer, two answers, an OSC 52 answer,
an answer inside a burst of CSI answers; assert the draft stays empty (`Say hi` placeholder still in the last frame)
and Ctrl-D ×2 exits 0. Today: `out/q-osc11` leaks, `out/q-osc11x2` leaks and hangs (exit 124).

**Gate.** `composer keystroke → frame p95 < 16 ms` (the filter is on the key path — the new regex must stay a single
pass; measure with `composer-latency.ts`). `keys never in logs or frames` (an OSC 52 answer can carry clipboard
content — dropping it is also the privacy-correct behaviour).

**Identity.** No text change; behaviour only.

---

### P9 — `TERM=dumb` (and every other "no TUI" reason) says why

**What.** When `selectRenderer` downgrades `chat` to one-shot **and** there is no task, fail with the *reason*, not
the generic usage error:

```
jevcode: chat needs an interactive terminal; this one reports TERM=dumb, so the plain renderer is used.
  · run `jevcode chat --plain` for the line renderer with a readline composer (needs TERM != dumb)
  · or `jevcode run "<task>"` for a one-shot run
  · or set a real TERM (e.g. TERM=xterm-256color)
```

One `reason` value threaded from `selectRenderer` (`'dumb' | 'ci' | 'stdin-not-tty' | 'stdout-not-tty' | 'flag'`),
printed by the controller where the usage error is raised. Optionally (separate decision) allow the readline composer
on `TERM=dumb` — it needs no escape sequences.

**Where.** `src/cli/main.tsx:50–71` (`RendererSelection` gains `reason`), the usage-error site in the controller
(`src/cli/session.ts` / `src/cli/fatal.ts`), `src/cli/session.ts:325–327` (`isInteractive` returns the reason or a
sibling `interactiveReason()`).

**Edge cases.** (1) `TERM=dumb` + argv task — runs normally, no message; (2) `CI=1`; (3) stdin pipe with text — reads
the task, no message; (4) stdin pipe empty (`out` of `echo "" | jevcode chat`); (5) `--plain` explicitly — no
complaint; (6) `--json`; (7) `--no-input`; (8) `TERM` unset (today: full TUI — decide whether that is intended and
record it).

**Tests.**
*unit* `test/unit/cli/main.test.ts`: `selectRenderer` reason for all eight combinations.
*pty* `steps/term-dumb.steps` with `PTY_TERM=dumb`: assert exit 2 and that the stderr text contains `TERM=dumb` and
`--plain`.

**Gate.** none new; must not touch the first-frame path (`main.tsx:213` "the first frame comes from argv, env, isTTY
and cwd only").

**Identity.** **New user-visible text**, CLI stderr only — not a transcript item, no `transcript.log`/`--plain` twin,
but it belongs in §10's glossary and in `docs/COMMANDS.md`.

---

### P10 — A distinguishable ASCII divider

**What.** In the ASCII glyph set use `+` for corners and `|` for the tee row so the divider reads differently from
the bottom edge, e.g. divider `|---…---|` and bottom `+---…---+` (Unicode keeps `├ ┤` / `╰ ╯`).

**Where.** `src/tui/glyphs.ts` (the ascii `teeLeft`/`teeRight` entries); `src/tui/console-lines.ts:58–64`
(`consoleDivider`) needs no change if the glyphs carry it.

**Edge cases.** (1) `cellWidth` unchanged (1 cell each) so every row is still exactly `columns`; (2) the card
divider used by `Review`/`Overlay` shares the glyph — check both; (3) `--ascii` + `--screen-reader` (flat tier has no
box); (4) widths < 4 (`consoleDivider` returns `rule.repeat(w)`).

**Tests.** *unit* `test/unit/tui/console-lines.test.ts`: `consoleDivider(w, GLYPHS.ascii) !== consoleBottom(w, GLYPHS.ascii)`
for w ≥ 4, and both are exactly `w` cells for w 0…200. *pty* `theme-ansi`/`--ascii` scenarios assert the two rows differ.

**Gate.** none; `rows − 2` unaffected.

**Identity.** Colour/layout (glyph twin, TUI-DESIGN §14.1).

---

### P11 — A resize matrix in the suites, and a new frame predicate `V22`

**What.** Three additions.

1. **`V22 — self-consistent frame width**: in every frame, every row that starts with a box glyph
   (`╭ │ ├ ╰ + |`) is exactly the width of that frame's rule row, and **no** such row ends in the truncation
   ellipsis." Implemented exactly as `resize-probe/widths.mjs` + `borders.mjs`; add to
   `scripts/pty/polish-check.mjs` beside V6 ("no row wider than the terminal"), which today catches neither half of
   D1. Also add **`V23`**: no continuation row in scrollback starts with more spaces than the gutter (closes D10).
2. **A pty resize matrix file** `test/pty/resize.pty.test.ts` driving one step file per state — idle · draft ·
   thinking · live+panel · review · palette · picker · wizard · intake · epilogue · minsize — through the same
   ladder (24×80 → 12×60 → 8×40 → 5×30 → 40×120 → 24×80) plus a 20-event storm, asserting per geometry segment:
   ≤ 1 clear per shrink segment, 0 per grow, `region ≤ rows − 2`, V22, V23, 0 forbidden sequences, exit 0.
3. **Unit coverage for the allocator at the pathological sizes**: fold `resize-probe/invariants.ts` (829 600 cases,
   currently a throwaway script) into `test/unit/tui/layout.test.ts` as a bounded property test (rows 0…60 ×
   the 17 widths × every overlay kind), and add `test/unit/tui/console-lines.test.ts` "every console row is exactly
   `columns` cells at widths 0…200".

**Where.** `scripts/pty/polish-check.mjs`; `test/pty/resize.pty.test.ts` (new) + `test/pty/smoke/*.steps`;
`test/unit/tui/layout.test.ts`; `test/unit/tui/console-lines.test.ts`; `docs/TUI-DESIGN-3.md` §9 (the V-list) or the
round-4 design's equivalent.

**Edge cases.** (1) the §0.1 two-event resize means a "segment" is keyed on the rule-row width *and* the row count —
segment on the pair, not on width alone (today `helpers.ts:units()` keys on `ruleWidth`, which merged four of my
segments into one until I re-keyed on sync frames); (2) frames with no rule row (minsize, static-only) are exempt
from V22; (3) `--ascii` box glyphs (`+ |`); (4) `--screen-reader` (no box); (5) a card inside the region (review,
intake) has its own width — same rule, same rule-row reference; (6) CI load: the 11-state ladder is ~11 × 8 s; run it
in the `pty` project, not the smoke.

**Gate.** This proposal *is* gate work: it converts `zero clears outside shrink segments` from "asserted per run" to
"asserted per geometry segment with the two-event rule", and adds V22/V23 to the hero-frame checklist.

**Identity.** Tests only.

---

### P12 — Make the driver's `resize` atomic (or explicit)

**What.** `drive.exp`'s `resize R C` should deliver **one** SIGWINCH, so a scenario measures what a real terminal
does; and a new `resize-rows R` / `resize-cols C` pair should exist for deliberately testing the split case. On macOS
`stty rows R cols C` is two ioctls; `stty -f` does not help. Options, cheapest first: (a) `stty size` is not
settable atomically from the shell — instead call the two in the order **columns first, then rows** and document that
the intermediate is `oldRows × newCols` (a shrink in rows then lands last, which is the case the App's fast path
already handles); (b) a 10-line Node helper invoked by the step (`node -e` with a `tty.WriteStream` + `ioctl` is not
available in core — so (a) is the realistic fix); (c) keep two events and make it a *feature*: rename the step
`resize` → `resize2` in the docs and add the note to `research/tui/20-pty-driver-findings.md`.

Recommendation: **(a) + (c)** — reorder so the *last* event is the rows change, and document the two-event behaviour
as finding §6 of research 20.

**Where.** `scripts/pty/drive.exp:154–158`; `docs/research/tui/20-pty-driver-findings.md` (new §6);
`test/pty/helpers.ts:1–11` (the doc comment about geometry segments).

**Edge cases.** (1) rows-only and columns-only resizes still emit one event; (2) existing scenarios' clear counts
change — re-baseline `resize.steps`, `resize-grow.steps`, `resize-live.steps`, `r3-wizard-resize.steps`,
`chrome-tiers.steps` and `perf/states.ts`'s `resizeMarkers`; (3) `PTY_ROWS`/`PTY_COLS` at spawn are one `stty_init`
(already atomic).

**Gate.** The `resize` allowance in `src/perf/states.ts:246–250` (`allowed: 1` per shrink segment) becomes reachable
once P1 and P12 both land — today it fails at 2 (`docs/STATUS.md`).

**Identity.** Tests/tooling only.

---

### P13 — EPIPE says one line

**What.** On `EPIPE`/`SIGPIPE` for stdout, write one line to stderr (`jevcode: stdout closed; run checkpointed at
<runs dir>`) before exiting 129, matching the SIGHUP path's contract. Today: exit 129, empty stderr.

**Where.** `src/cli/fatal.ts` (the hang-up/EPIPE branch); `src/tui/terminal.ts:62–69` already swallows the write
error ("the terminal is gone") — keep that, add the stderr line at the controller.

**Edge cases.** (1) stderr also closed — the write must be guarded; (2) `--json` (the NDJSON renderer); (3) EPIPE
during the first frame; (4) `| head -1` vs `| true` (immediate close).

**Tests.** *unit* `test/unit/cli/fatal.test.ts`. *pty* none (the pipe case is not a pty case; use
`test/pty/twins.pty.test.ts`'s pipe runs).

**Gate.** none.

**Identity.** New stderr text; no transcript twin.

---

### P14 — Reconcile the tmux colour row in `terminal-matrix.md`

**What.** Replace "16 colours inside tmux by design" with the measurement: the depth follows
`colorDepth(env, stream)`; `TERM=tmux-256color`/`screen-256color` get 256 (85 `38;5;` per capture),
`TERM=vt100`/`screen` get 16 (0 `38;5;`), `NO_COLOR` gets 0. Note that `tmux` without `Tc`/`RGB` never sees
truecolor because the build never emits `38;2;` (measured 0 in every capture).

**Where.** `docs/research/tui/terminal-matrix.md` §1 "Colour" row and §2's "Truecolor" row.

**Tests.** *pty* the existing `theme-*` scenarios gain a `PTY_TERM` axis asserting the `38;5;` count is 0 for
`vt100` and > 0 for `tmux-256color`.

**Gate.** none. **Identity.** Docs only.

---

## 7. Priority

| # | proposal | closes | user request | size |
| --- | --- | --- | --- | --- |
| 1 | **P1 + P2** (one geometry per frame) | D1, D9 | 3 ("does not look weird when resized") | M |
| 2 | **P6** (wizard at minsize) | D4 | 3, 5 | S |
| 3 | **P3** (gutter floor) | D2 | 2, 4, 5 | M |
| 4 | **P8** (OSC filter) | D6 | 3 | S |
| 5 | **P7** (review keys ladder) | D5 | 2, 4 | S |
| 6 | **P5** (minsize notice) | D3 | 3, 5 | S |
| 7 | **P11** (V22/V23 + the resize matrix suite) | regression fence for all of the above | 3 | M |
| 8 | **P4** (exact identity normaliser) | D2(b) | — (contract) | S |
| 9 | **P9, P10, P12, P13, P14** | D7, D8, D11, D12, tooling | 3 | S each |

P1+P2 and P11 are the pair that turns "resize is mostly fine" into a gate. P6 is the smallest change with the
largest visible payoff (it is a first-run path).

---

## 8. What is still unmeasured (open questions)

1. **Real terminal emulators.** Every cell above is a pty on macOS. iTerm2, Terminal.app, VS Code, Ghostty, kitty,
   WezTerm, Alacritty, Windows Terminal/ConPTY remain `manual`; the new manual item is D1's torn frame while dragging.
2. **An interactive pager.** `/diff --full` was probed with `PAGER=cat`. `less` + `suspendTerminal()` + a resize
   *while the pager owns the terminal*, then `q`, is untested (the `<Static>` suspension queue,
   `terminal.ts:174–203`, is the code at risk).
3. **`$EDITOR` suspension.** One run in the corpus launched `$EDITOR` from pure terminal noise
   (`out/noise/capture.bin:10497`, vim's `ESC[?1049h`, draft `edit-63760-1.md`, 21 B = the OSC payload) and had to be
   SIGKILLed; it did not reproduce in three further runs with `EDITOR=/usr/bin/true`. Either a chunk boundary
   resolves to `composer:externalEditor` (`keys/bindings.ts:118`, `ctrl+g`) or the editor was opened by something
   else. **Needs a `JEVCODE_TRACE` run with the same 8-write burst.**
4. **Emoji/ZWJ widths** cannot pass through `drive.exp` (§0.1 rule 3). Either add a `sendbytes <hex>` step to the
   driver or measure with a Node pty harness.
5. **Backpressure with a stopped reader** is documented in research 20 §5 (Node's synchronous TTY writes) and was not
   re-measured; the P1 synchronous commits make a frame slightly more expensive, so re-run that probe after P1.
6. **The round-3 persistent wordmark under resize could not be probed** — `src/tui/wordmark.ts` is not in the
   committed tree. `wordmarkWanted` (in-flight, `wordmark.ts:77–93`) depends on no resize-derived state beyond
   `rows`/`columns`/`boxed`, and the static sweep shows it is `true` again at every geometry ≥ 21×64 after any
   excursion, so request 1 ("jevcode stays up on top") should hold — **but it must be probed once round 3 is
   committed**, with the ladder of §2 plus `rows-cycle`, asserting ≥ 5 `██` rows in the settled frame after every
   return to ≥ 21×64. In the committed tree the mark is the 700 ms splash and is simply gone afterwards, so the
   probes above cannot answer it.
7. **`TERM` unset** takes the full TUI path (only `dumb` is excluded at `session.ts:326`). Intended?
8. **Two `ESC[0 q`, two `ESC[6 q` per Ctrl-Z cycle** (`out/tstp`) — consistent with the `rearm` design
   (`terminal.ts:106–109`), but `terminal-matrix.md` §1 says "written once by an idempotent `restoreTerminal()`";
   the sentence needs "once per exit *and* once per suspension".
