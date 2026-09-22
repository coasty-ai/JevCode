# Round 4 — topic A5: the conversation / intake / history surface

*Measured 2026-09-21 against the last committed tree `ec61170` in a throw-away worktree
(`/tmp/jevcode-r4-conv`, `npm run -s build`, `node bin/jevcode.js chat --mock` driven by
`scripts/pty/drive.exp` with a temp `JEVCODE_HOME` and a temp copy of `examples/demo-py`). The main
checkout was never built, run or edited: round 3 is being implemented there. Every capture quoted
below is committed under `docs/research/tui/round-4/captures/a5/` (`<name>.txt` = the ANSI-stripped
pty log, `<name>.jsonl` = the driver's timing file, `steps/<name>.steps` = the step file, `p.sh` =
the harness). Line references are `path:line` at `ec61170`.*

---

## 1. The surface as built

| Stage | Module | Anchor |
| --- | --- | --- |
| Enter → routing | `src/tui/App.tsx` `onEnter` | `App.tsx:1058–1117` |
| chunk splitting (coalesced keys / paste) | `src/tui/App.tsx` `splitInputChunk` | `App.tsx:443–503` |
| pure routing | `src/tui/composer/submit.ts` `routeSubmit` / `routeSend` | `submit.ts:149–173`, `125–134` |
| mentions | `src/tui/composer/submit.ts` `mentionedPaths` | `submit.ts:57–66` |
| send / history | `src/tui/App.tsx` `send`, `appendHistory` | `App.tsx:879–930`, `833–839` |
| controller submit | `src/cli/session.ts` `host.submit` → `converse` | `session.ts:3342–3347`, `2930–3020` |
| bubbles | `src/chat/bubbles.ts` `bubbleLines` / `session.ts` `say` | `bubbles.ts:21–31`, `session.ts:2895–2897` |
| reply routes | `src/cli/session.ts` `reply` | `session.ts:3022–3075` |
| ledger | `src/chat/ledger.ts` `createChatLedger` (in memory only) | `ledger.ts:53–84`, `session.ts:1112` |
| item model / caps | `src/tui/plain.ts` `localItem`, `TRANSCRIPT_TEXT_MAX` | `plain.ts:496–508`, `plain.ts:110` |
| rows | `src/tui/Transcript.tsx` `TranscriptRow`, `spacerAbove`, `fenceRow` | `Transcript.tsx:108–134`, `96–101`, `88–93` |
| `--plain` twin | `src/tui/plain.ts` `createPlainRenderer`, `intakeKeptEcho` | `plain.ts:902–1001`, `870–872` |
| intake card | `src/chat/lines.ts` | `lines.ts:10–58` |
| prompt history | `src/tui/composer/history.ts` | `history.ts:56–68` |
| `<Static>` cap | `src/tui/useEngine.tsx` `STATIC_SOFT_CAP` / `appendItems` | `useEngine.tsx:53`, `502–510` |

Caps that shape everything below: `TRANSCRIPT_TEXT_MAX = 600` chars **per item** (`plain.ts:110`),
`clip()` replaces the last char with `…` (`core/text.ts:13–16`), `TASK_CHARS_LIMIT = 12_000`
(`submit.ts:19`), `MESSAGE_HEAD/TAIL = 1000/200` into Jev (`intake.ts`), `LEDGER_MAX_TURNS = 200` /
`LEDGER_RECENT = 6` (`ledger.ts:28–29`), `HISTORY_MAX_ENTRY_BYTES = 4096` (`history.ts:60`),
`STATIC_SOFT_CAP = 20_000` (`useEngine.tsx:53`).

---

## 2. The enumerated matrix — what was probed and what happened

| # | Case | Probe | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 1 | multi-line message via Ctrl-J (`\x0a`) | `multiline` | **defect** | 3 lines → 3 `[you]` items, each with its own blank spacer row: 6 rows for 3 lines (`multiline.txt`) |
| 2 | indentation inside a message | `paste-code` | OK (spaces) / **defect** (tabs) | `[you]     if x:` survives; `bubbleLines` maps `\t`→one space (`bubbles.ts:24`), verified offline |
| 3 | blank line inside a pasted block | `paste-code` | **defect** | the blank line between `if x:` and `return 1` is gone — `bubbles.ts:25` `.filter(l => l.trim() !== '')` |
| 4 | fenced code block | `paste-code` | cosmetic | fences become `[you] ╶──── python` rows; the code *inside* keeps the default body role, only the fence row gets `code` (`Transcript.tsx:110–113`) |
| 5 | 2,000-char message | `long2k` | **defect** | bubble stops at 600 chars with a bare `…`; no "+1,400 characters" marker (`long2k.txt`) |
| 6 | 20,000-char message | `long20k` | cosmetic | `[ui] notice: only the first 12,000 characters reach the generator …` fires, but **before** the `[you]` bubble (`long20k.txt:116` then `:125`) |
| 7 | wrapped-row left edge | `long2k` | cosmetic | continuation rows alternate 6 and 7 leading spaces (`wrap-ansi` `trim:false`): ragged gutter |
| 8 | empty Enter | `empty` | OK | nothing emitted (`routeSubmit` → `ignore:'empty'`, `submit.ts:165`) |
| 9 | whitespace-only Enter | `empty` | OK | same |
| 10 | rapid double / triple Enter | `empty` | **defect** | `\r\r\r` in one read is classified paste-like → **three newlines inserted**, toast `input arrived in one chunk; Enter kept as a newline` (`App.tsx:477–486`, `empty.txt`) |
| 11 | a `/command` on a later line of a multi-line draft | `empty` | **defect** | draft `hi\n\n\n/exit` submitted as chat → `[you] hi`, `[you] /exit`; the session never exited (driver `exit=124`, `empty.jsonl`) |
| 12 | Enter while thinking | `thinking` (`JEVCODE_MOCK_JEV_MS=2000`) | **defect** | toast `one moment — still thinking`, draft kept, submission **dropped** — nothing resends it when the reply lands (`App.tsx:1072–1077`, `thinking.txt:142`) |
| 13 | `/command` while thinking | `thinking` | OK by design | the guard exempts `text.trimStart().startsWith('/')` (`App.tsx:1074`) |
| 14 | Enter while live | code | OK | `routeSend` → `steer` (`submit.ts:131`) |
| 15 | Enter while a run is `aborting` | code | OK | `ignore:'run-ending'` (`submit.ts:132`) |
| 16 | Enter with the intake card up | `ambig` | OK | Enter is inert; printable keys toast `intake pending: y n · Esc keeps the text` (`ambig.txt:123`) |
| 17 | Esc on the intake card | `ambig` | cosmetic | card closes, `[jevcode] Okay — edit it and press Enter, or ask me something.`, draft restored — but the orphan `[you]` bubble stays, so one logical message shows twice (`ambig.txt:106` and `:146`) |
| 18 | typing `/exit` while the card is up | `ambig` | **defect** | printable keys are swallowed; after Esc the restored draft absorbs the slash (`the date parsing/exit`) — there is no keyboard route out of the card other than y/n/Esc/Ctrl-C |
| 19 | Esc ×1 / Esc ×2 mid-typing | `escctrlc` | OK | toast `Esc again clears the draft`, then cleared; the text lands in history and `↑` restores it (`escctrlc.txt:92,96,126`) |
| 20 | Ctrl-C ×1 mid-typing | `escctrlc` | cosmetic | draft cleared **silently** (no toast), recoverable only through `↑` |
| 21 | a cleared draft > 4 KiB | `history.ts:60` | **defect** | `clipBytes(text, 4096)` — a long cleared draft is unrecoverable |
| 22 | `↑` / `↓` prompt history | `histnav` | OK | `thanks` → `hi` → `thanks`; consecutive duplicates dropped (`histnav.txt:129–141`, `history.jsonl`) |
| 23 | `↑` inside a multi-row draft | code | OK | `cursorRow === 'first'` gates history vs. cursor move (`keys/resolve.ts:389–395`) |
| 24 | history recall of a paste | `long2k` home | **defect** | stored as the chip label `[Pasted #1: "please explain alpha …", 1 line]`, never the body; after a restart the label cannot expand (`routeSubmit` → `chip-missing`) |
| 25 | `@file` that exists | `mention` | OK | pinned, read through `readWorkspaceFile` (`session.ts:3220–3239`) |
| 26 | `@file` that does not exist | `mention` | **defect** | `@nope/missing.py` accepted silently; `readWorkspaceFile` returns `null` on any failure; the path is still sent to Jev as a `mentions` entry |
| 27 | `@.env` (denylisted) | `mention` | **defect** | `isMentionDenied('.env') === true` (verified offline) but **no** `[ui] … secret denylist` line appears: `App.tsx:802–807 dispatchCtx()` never sets `isDeniedPath`, so `routeSend` computes `droppedMentions = []` (`submit.ts:129`) and `App.tsx:893,905` is dead code in the TUI |
| 28 | `@` inside pasted code | offline | **defect** | `mentionedPaths('```\n@decorator\n…')` → `['decorator']`; `@scope/pkg` likewise |
| 29 | typed secret | `secret` | OK | gate opens, `y` sends, bubble reads `[you] use this token [REDACTED:composer#1] for the api` (`secret.txt:97`) |
| 30 | CJK bubble | `unicode` | OK | `日本語のテスト` measured correctly in composer and bubble (`unicode.txt`) |
| 31 | astral emoji | `unicode` | **inconclusive** | expect mangled the 4-byte sequence before it reached the pty; not a product finding |
| 32 | narrow terminal (34×20) | `narrow` | OK | bubbles re-wrap at the new width with the `[jevcode]` hanging indent; flat tier appears |
| 33 | very narrow (< label + 4) | code | **defect (theoretical)** | `Transcript.tsx:118` sets `width={columns}` with a `flexShrink=0` 9-cell label box; at `columns ≤ 10` the body box has ≤ 0 cells |
| 34 | turn grouping for `[jevcode]` | `secret` | cosmetic | one spacer above the first `[jevcode]` of a turn (`Transcript.tsx:99`), none between two *different* facts of one facts reply — two facts read as one paragraph (`secret.txt:99–103`) |
| 35 | text typed during a live run | code | **defect** | it becomes `[step N] steer queued (1) for step N: <text>` (`plain.ts:247–249`) — never a `[you]` bubble. The conversation surface changes language mid-session |
| 36 | `/copy last` | `mention` | **defect** | copies `s.items.at(-1)` — the **last line** of the reply, not the turn (`App.tsx:1039`); toast says `✓ copied` (`mention.txt:137`) |
| 37 | `/new` | code | **defect** | `session.ts:2690–2702` resets id, runs, title, undo and the meter but **not** `ledger`: the old turns still go to Jev as `conversation` (`session.ts:3114`) and still count in `/jev` / `/cost` (`session.ts:2490,2514`); an in-flight chat is not aborted |
| 38 | a reply arriving after `/exit` | code | OK | `finishSession` calls `abortChat()` (`session.ts:1282`) |
| 39 | resume of a conversation-only session | probe homes | **defect** | no `sessions/` directory is created at all: `sessionId` stays `null` until a run, so `meterChat` pushes to `deferredChatLines` and drops them (`session.ts:3309–3310`, comment at `:3294`); the ledger is never persisted (`ledger.ts` has no I/O). `/resume` restores spend, never conversation |
| 40 | hundreds of turns | code | cosmetic | `STATIC_SOFT_CAP = 20_000` items, each ≤ 600 chars → up to ≈ 12 MB of item text plus 20,000 React keys before the epoch remount (`useEngine.tsx:502–510`); the per-line/per-spacer inflation of #1 makes the cap arrive ~2× sooner for chat-heavy sessions |
| 41 | palette open + Enter | `palette` | **defect** | with `/help` highlighted and `› /help +36` shown in the composer, Enter printed `[ui] error: unknown command /; type / to list commands`. `palette:run` calls `onEnter()` (`App.tsx:1402–1409`) which re-reads the *buffer*, never `pal.selected` |
| 42 | Esc on the palette | `palette` | **defect** | the palette closes but the lone `/` stays in the draft, so the next words become `/hello @` → `[ui] error: unknown command /hello` |
| 43 | `--plain` chat twin (real pty) | `plainchat` | **defect** | items are written over the readline prompt (`> [sandbox] seatbelt …`); a line typed at the intake prompt is eaten as an invalid answer, so `/exit` is not a command there (`plainchat.txt`) |
| 44 | `--plain` with piped stdin | shell | **defect / divergence** | `printf 'hello there\nthanks\n/exit\n' \| jevcode chat --mock --plain` starts a paid run with `task: hello there ⏎ thanks ⏎ /exit` — the whole stdin is one task, no intake, no bubbles |
| 45 | screen-reader announcement of a reply | code | **defect** | `createNotifier` is only called for `review` / `run-end` / `budget` (`App.tsx:663`); a `[jevcode]` turn and the `thinking` transitions make no sound and are not re-announced |
| 46 | history `kind: 'chat'` | code | cosmetic | `HistoryKind` declares `'chat'` and documents "Up-arrow and Ctrl-R include it" (`history.ts:21–22`) but `appendHistory` is typed `'prompt' \| 'steer' \| 'command'` (`App.tsx:833`) — the kind is never written |
| 47 | chrome between Enter and the bubble | all captures | already being fixed | every capture shows one frame of `starting` + `Type to steer the next step…  Esc pauses` right after Enter — this is round 3's P7 (`TUI-DESIGN-3.md §5.2 P7`), in flight |

**Counts:** 19 defects, 9 cosmetic, 17 OK, 1 inconclusive, 1 already-in-flight.

---

## 3. The four frames that matter

### 3.1 A three-line message (`multiline.txt`, 24×80)

```
[you] hello there

[you] indented second line

[you] third

[jevcode] Hi. I'm ready when you are — describe a change you want in ws-g9R3bQ,
          or ask what I can do.
```

Six rows for three lines, and each line looks like its own turn. The rule is
`Transcript.tsx:98` — `if (item.label === '[you]') return true;` — unconditional, while `[jevcode]`
one line later is correctly conditioned on `prev.label !== '[jevcode]'`. `TUI-DESIGN-3.md §5.1`
rule 9 already says "above every `[you]` **turn**"; the code says *item*.

### 3.2 A nine-line pasted code block (`paste-code.txt`, 30×100)

```
[you] here is the code:

[you] ╶──── python

[you] def f(x):

[you]     if x:

[you]         return 1

[you]     return 0

[you] ╶────

[you] what do you think?
```

17 rows for a 9-line paste; the blank line the author wrote between `if x:` and `return 1` was
dropped by `bubbles.ts:25`; every fence and every statement carries the speaker label again.

### 3.3 Rapid Enter (`empty.txt`, `empty.jsonl` steps 14–16, three `\r` in one write)

```
│ › hi                                                                         │
│                                                                              │
│                                                                              │
│                                                                              │
│ ! input arrived in one chunk; Enter kept as a newline — press Ent…  step 0/– │
```

`HARD_CONTROL_RE` (`App.tsx:443`) deliberately excludes `\r`/`\n`, and
`ONE_LINE_TRAILING_NEWLINE_RE` (`:444`) only matches **one** trailing newline, so any chunk of two
or more CRs falls to the paste-like branch at `:486`. The subsequent `/exit` typed on line 4
submitted the whole four-line draft as chat.

### 3.4 Palette Enter (`palette.txt`)

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /help          keys by context, commands with one-liners, per-terminal no… │
│   /new           end the session; the next prompt starts a new one here      │
…
│   (1/37)  Tab completes · Enter runs an exact match · Esc closes ▼           │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /help +36                                                                  │
…
[ui] error: unknown command /; type / to list commands
```

The row is highlighted, the composer ghosts `/help +36`, and Enter errors on `/`. This is exactly
the user's request 6.

---

## 4. The separation design (turns and blocks)

Consistent with `TUI-DESIGN-3.md §5.1` (10-cell right-aligned label gutter, bodies at column 10,
rule 9 spacing, rule 11 "no box, no background, no rail glyph — the pink label *is* the bubble")
and the §5.3 identity normaliser.

**The unit is the turn, not the item.** Define a turn as a maximal run of contiguous visible items
sharing the same chat label (`[you]` or `[jevcode]`); every other item is its own block.

| Element | Rule | Identity |
| --- | --- | --- |
| Blank row | exactly one, above the **first** item of a turn / block (never between the lines of one turn); above `[run] start`, `[run] end`, and (round 3 rule 9) a `[ui]` item carrying a `detail` | layout |
| Label | printed on the first item of a turn at full weight (`you` magenta bold / `assistant` pink bold); on continuation items the same text at `dim` weight — the gutter stays a column of labels, so `stripAnsi` is unchanged | **colour only** |
| Body column | column 10 for every row of the turn (round 3 rule 1) | layout |
| Code rows | a row between an opening and a closing fence row of the same turn takes the `code` role for its whole body (today only the fence row does) | colour |
| Long turns | a turn whose source text was clipped ends with one extra item `[you] …(+N characters not shown — /copy last copies the whole message)` | **text** (§5 P3) |
| Block rule | no horizontal rule between turns. The one existing rule (`─── ◆ jevcode 0.3.0 ───`) stays the scrollback/dynamic boundary and is never duplicated | layout |
| Facts reply | each fact is a turn-internal item; the *first* word of each fact takes the `dim` label but the body stays default, and the reply ends with one blank row before the next block | colour |
| Timestamps | none in the scrollback (round 3 confirms). A turn's wall time is available through `/why intake` and `--json`; see open question Q3 | — |

Row budget for §3.1 under this design: 3 lines + 1 spacer = 4 rows (was 6); for §3.2: 9 + 1 = 10
rows (was 17). At the `STATIC_SOFT_CAP` this is a 1.7× extension of a chat-heavy session's
scrollback for zero extra state.

---

## 5. Proposals

Every proposal names its perf gate from `src/perf/` and its identity classification per
`TUI-DESIGN-3.md §5.3` ("text" = the row string changes and `--plain` / `transcript.log` /
pinned tests must follow; "layout/colour" = the row string is unchanged).

---

### P1 — One spacer per turn, not per line

**What.** `spacerAbove` treats `[you]` like `[jevcode]`: a spacer only when the previous visible
item is not the same chat label.

**Where.** `src/tui/Transcript.tsx:96–101`:
`if (isChatLabel(item.label)) return prev.label !== item.label;` replacing lines 98–99.

**Edge cases.** (a) first item after the header — `prev` is the header, spacer fires (unchanged);
(b) first item after a `<Static>` epoch remount — `prev === null`, no spacer, and the previous
epoch's last row is already in scrollback: accept (document it); (c) two consecutive `[you]` turns
with nothing between them (only reachable if a submission returns before `reply()`; today
`sessionMeter.exceeded()` always says something) — they would merge; guard by comparing
`item.seq - prev.seq === 1` **and** the labels, so a gap in `seq` (an item hidden by `compact`)
still separates; (d) `compact` view hides intervening stage items — `visibleItems` is what
`Transcript` receives, so `prev` is the visible predecessor and the `seq` guard above must use the
*visible* predecessor's seq, i.e. only require `prev.label === item.label`; keep (c) as a follow-up
once turn ids exist (P12); (e) a `[jevcode]` reply immediately after a `[you]` turn — labels
differ, spacer fires.

**Tests.** unit `test/unit/tui/round2-transcript.test.tsx`: a 3-line `[you]` turn renders 4 rows,
not 6; a `[you]` turn followed by a `[jevcode]` turn renders one blank row between them; the header
case. pty: extend `test/pty/smoke/chat-hi.steps` with a Ctrl-J multi-line message and assert the
capture contains no `\n\n\[you\]` after the first.

**Perf gate.** `perf/static-append.ts` (report; bytes/line must not rise) and
`perf/intake-latency.ts` bubble p95 < 16 ms.

**Identity.** Layout only — no row string changes; the §5.3 normaliser is unaffected.

---

### P2 — Keep blank lines and tabs inside a bubble

**What.** `bubbleLines` stops dropping blank lines and stops collapsing tabs: blank lines become
empty items (rendered as an empty body row), tabs expand to the next 4-column stop instead of one
space. A run of more than 2 consecutive blank lines collapses to 2.

**Where.** `src/chat/bubbles.ts:21–27`. `plain.ts`'s `localItem` already clips per item; an empty
`text` must be allowed through `note()` (`session.ts:2895–2897` passes it unchanged) and
`formatTranscriptItem` yields `"[you] "` — add a `trimEnd()` in `formatTranscriptItem`
(`plain.ts:487`) so the stored row is `"[you]"` with no trailing space.

**Edge cases.** (a) a message that is only blank lines — `converse` is never reached
(`routeSubmit` → `ignore:'empty'`); (b) leading blank lines of a paste — dropped (they carry no
information and would open the turn with a gap); (c) trailing blank lines — dropped; (d) a 600-char
line with a tab at position 599 — expansion happens before `clip`, so the clip still bounds the row;
(e) `--ascii` — tabs are already spaces, no glyph twin needed; (f) `transcript.log`: empty `[you]`
rows now appear there too — acceptable and identical in both sinks; (g) CRLF and lone CR already
normalised at `bubbles.ts:23`.

**Tests.** unit `test/unit/chat/bubbles.test.ts`: `bubbleLines('a\n\n\tb\n')` → `['a','','    b']`;
`'a\n\n\n\n\nb'` → `['a','','','b']`; `formatTranscriptItem({text:''})` has no trailing space. pty:
a new `chat-paste-code.steps` that brackets-pastes the 9-line fixture and asserts the blank line
survives and the row count is 10.

**Perf gate.** `perf/intake-latency.ts` (bubble p95 < 16 ms); `perf/static-append.ts` report.

**Identity.** **Text** — the item set changes (new empty items, different indentation).
Twins: `--plain` and `transcript.log` print the same rows through the same `bubbleLines`; update
`test/unit/chat/bubbles.test.ts`, `test/unit/tui/round2-transcript.test.tsx`, and any pinned
`chat-*.steps` that count rows.

---

### P3 — A message longer than one item says so

**What.** Instead of a silent `…` at 600 chars, a clipped chat line emits the clipped row plus one
trailing item `…(+N characters not shown — /copy last copies the whole message)`. The full text
stays available to `/copy last` (P10) and to the ledger.

**Where.** `src/chat/bubbles.ts` (new `bubbleLines` return carrying `clippedChars`),
`src/cli/session.ts:2895–2897` `say()` appends the marker item, new constant in
`src/tui/plain.ts` beside `TRANSCRIPT_TEXT_MAX`.

**Edge cases.** (a) exactly 600 chars — no marker; (b) several clipped lines in one turn — one
marker per turn with the summed count, emitted once after the last line; (c) the marker itself in
`--ascii` (plain ASCII, no glyph); (d) a clipped line that is also a fence — the fence rule
(`Transcript.tsx:88–93`) requires an exact `^```\w*$`, so a clipped fence stays literal text:
correct; (e) redaction — the count is computed **after** `redact`, so a redaction that lengthens the
text cannot leak the original length; (f) `/copy last` on a clipped turn must copy the unclipped
text, which means the controller keeps the turn's source (the ledger already does,
`session.ts:2987`, `:3073`).

**Tests.** unit: a 2,000-char message yields 2 items and the marker says `+1,401`; a 600-char one
yields 1 item and no marker. pty: `long2k.steps` (committed) asserts the marker row.

**Identity.** **Text** — new item. Twins: `--plain`, `transcript.log`, `--json` `ui` lines; update
`bubbles.test.ts` and `round2-transcript.test.tsx`.

---

### P4 — A burst of Enters is N Enters, not N newlines

**What.** In `splitInputChunk`, a chunk whose non-newline content is empty (only `\r`/`\n`) becomes
one `return` event per newline. A chunk of `text` + several trailing newlines becomes the text then
that many Enters. Only a chunk with an **interior** newline *between non-empty text runs* stays
paste-like.

**Where.** `src/tui/App.tsx:464–503` (`splitInputChunk`), the two regexes at `:443–444`.

**Edge cases.** (a) `"\r"` — unchanged, one Enter; (b) `"\r\r"` — two Enters (today: two newlines
+ toast); (c) `"hi\r"` — text + Enter (unchanged); (d) `"hi\r\r"` — text + two Enters; (e)
`"a\rb\r"` — interior newline between two text runs → paste-like, `foldedEnter` toast (unchanged,
this is a real paste in a terminal without bracketed paste); (f) `"\n\n\n"` from a bracketed paste
— `usePaste` handles bracketed pastes on a different path (`App.tsx:1757`), so this branch only
ever sees unbracketed input: still correct to treat as Enters; (g) a chunk mixing `\x03` with CRs —
`HARD_CONTROL_RE` already routes it to the per-byte splitter; (h) the second Enter of a burst lands
while `submittingRef.current` is true → `routeSubmit` returns `ignore:'submitting'`: no double
submit; (i) after the first Enter the composer is empty → the rest are `ignore:'empty'`: the net
effect of "Enter Enter Enter" is one submission, which is what a typist means.

**Tests.** unit `test/unit/tui/app.test.tsx` (`splitInputChunk` table): the nine rows above. pty:
extend `chat-hi.steps` to `send \r\r\r` after a message and assert exactly one `[you]` bubble and no
`input arrived in one chunk` toast.

**Perf gate.** `perf/composer-latency.ts` keystroke → frame p95 < 16 ms, max gate unchanged (the
function is pure and runs once per delivery).

**Identity.** Layout/behaviour — no row text changes.

---

### P5 — A multi-line draft always tells you how to send it, and never hides a command

**What.** Two parts. (a) While the draft has an interior newline, the composer's right edge shows a
persistent hint `N lines · ⏎ send` (the placeholder slot is free only when the draft is empty, so
this is a new right-aligned span on the composer's last row, dropped below
`PLACEHOLDER_HINT_MIN_COLUMNS`). (b) `routeSubmit` scans a multi-line draft for a line that is
exactly a known command (`isExactCommand(commandToken(line))`) and, when the *first* line is not a
command, returns a new `confirm-multiline` decision that emits
`[ui] line N looks like /<cmd>; a submitted message is sent as text — remove it or press Enter again`
and keeps the draft; the second Enter within 3 s submits.

**Where.** `src/tui/composer/Composer.tsx:92–120` (`placeholderParts`, the hint span),
`src/tui/composer/submit.ts:149–173` (`routeSubmit`), `src/tui/App.tsx:1058–1117` (the new case
and its 3 s arm ref).

**Edge cases.** (a) a draft whose first line *is* a command — unchanged, the whole line goes to
`dispatchCommand`; (b) `//` escape at column 0 — unchanged literal-slash path (`submit.ts:164`);
(c) a pasted code block containing a `/usr/bin` path — `commandToken` only matches registry names,
so no false positive; (d) a pasted markdown list with `/` lines — same; (e) the arm expires → the
next Enter warns again (never silently submits after a long pause); (f) reduced motion / screen
reader — the hint is static text, the warning is a `[ui]` item that a screen reader reads; (g)
`--plain` has no composer: part (a) does not apply, part (b) does not either (readline submits one
line at a time); (h) flat tier < 16 rows — the hint is dropped with the rest of the right-hand
spans.

**Tests.** unit `test/unit/tui/commands/submit.test.ts`: the decision table above. pty: a new
`chat-multiline-command.steps` that Ctrl-Js `hi`, `/exit`, presses Enter twice and asserts the first
Enter produced the `[ui]` line and the second the two bubbles.

**Perf gate.** `perf/composer-latency.ts` p95 < 16 ms (the scan is over ≤ 12,000 chars, once per
Enter, not per keystroke).

**Identity.** **Text** for the new `[ui]` item (local, never in `transcript.log`); layout for the
hint. Twin: the `[ui]` text lives in one exported constant used by both renderers.

---

### P6 — Enter while thinking queues the message instead of dropping it

**What.** Replace the toast-and-drop at `App.tsx:1072–1077` with a one-slot queue: the submission is
remembered, the composer clears, the status row shows `⠹ thinking · 1 queued`, and when
`thinking` returns to `null` the queued text is submitted. `Esc` on the queued state cancels it and
restores the text to the composer.

**Where.** `src/tui/App.tsx:1058–1117` and the `thinking` reducer branch in
`src/tui/useEngine.tsx`; the status word in `src/tui/status/lines.ts`.

**Edge cases.** (a) a second Enter while one is queued — keep the toast `one moment — still
thinking` and do not queue a second (cap 1, like the intake's one-request-at-a-time rule); (b) the
in-flight request fails (`chatFailure`) — the queue still flushes (the user asked for it) but the
error bubble lands first; (c) Ctrl-C ×1 while thinking aborts the request *and* drops the queue with
a toast `queued message dropped` — never silently sends after an abort; (d) the queued submission
contains a secret — the gate runs at *queue* time, not at flush time, so `addSecret` still precedes
`createEngine` (`session.ts:3344–3345`); (e) `/exit` while queued — `finishSession` clears the
queue; (f) the run starts from the first message (`coding_task`) — the queued text becomes a steer
through the normal `routeSend` path because `run` is now `live`; (g) the queued message is empty
after trimming — never queued.

**Tests.** unit `app.test.tsx`: queue, flush, cancel, cap-1, Ctrl-C drop. pty: a new
`chat-queue.steps` with `JEVCODE_MOCK_JEV_MS=1500` that sends two messages 300 ms apart and asserts
two `[you]` bubbles and two `[jevcode]` replies in order.

**Perf gate.** `perf/intake-latency.ts` (`mock150` series: the `thinking` frame count must not
change) and `perf/composer-latency.ts` p95 < 16 ms.

**Identity.** Layout + status text (dynamic row, never transcript) — no item text changes.

---

### P7 — A steer is a `[you]` turn too

**What.** When a steer is accepted while a run is live, the controller emits the `[you]` bubble for
the typed text in addition to the engine's `steer:queued` item, so the conversation reads the same
whether or not a run is live. The engine item stays (it carries the queue index and step).

**Where.** `src/cli/session.ts` `host.steer` (`:3352–3363`) → `say('you', bubbleLines(text, redact))`
before `engine.steer(...)`; `src/tui/App.tsx:881–898` for the `starting`-phase queue.

**Edge cases.** (a) a refused steer (`full` / `finished`) — no bubble, only the toast (today's
behaviour); (b) `/steer <text>` typed as a command — same bubble (the command path already goes
through `routeSend`, `App.tsx:1035`); (c) a steer that is withdrawn (`↑ takes back`) — the bubble
stays, the engine emits `steer:withdrawn`: acceptable, the user did say it; (d) a steer while
`pausing` — same; (e) secrets — `bubbleLines` redacts, and the spans were `addSecret`ed at
`session.ts:3353`; (f) `--plain` — identical, the bubble is an `annotate()` notice while live so it
also reaches `transcript.log`.

**Tests.** unit `test/unit/cli/session-*.test.ts`: a steer produces one `chat` item with label
`[you]`. pty: `test/pty/smoke/s2-esc-pause.steps` or a new `steer-bubble.steps` asserts
`[you] <text>` precedes `steer queued`.

**Identity.** **Text** — a new item in `transcript.log` while live. Twins: `--plain`,
`transcript.log`, `--json`; pinned steer assertions in `test/pty/*` and
`test/unit/tui/round2-transcript.test.tsx`.

---

### P8 — Wire the `@` denylist into the TUI

**What.** `dispatchCtx()` merges the host's `dispatchContext()` so `isDeniedPath` reaches
`routeSubmit` / `routeSend` and `dispatchCommand`.

**Where.** `src/tui/App.tsx:802–807`:
`const h = bridge.host?.dispatchContext(); return { ...h, run, step, changedSteps, ...(h?.sessions ? {} : {}) }` —
keeping the App's own `run`/`step`/`changedSteps` as the authority and taking `sessions` and
`isDeniedPath` from the host.

**Edge cases.** (a) `bridge.host === null` (the first ~10 ms before `setHost`) — no `isDeniedPath`,
and `routeSubmit` returns `hold` in that window anyway (`submit.ts:169`); (b) the host's
`dispatchContext()` computes `sessions` from `index` on every keystroke — it is called once per
Enter and once per palette open, not per keystroke: verify with `perf/composer-latency.ts`; (c)
`--allow-secret-mention` — `cfg.secretPaths` is unchanged by the flag, so the flag must be honoured
where the notice is emitted, not in the predicate (today `deniedMentionNotice` names the flag);
(d) a symlinked workspace — `isMentionDenied` is lexical and both sides are canonical
(`paths.ts:161–169`); (e) `/export .env` in the TUI is now refused exactly as in `--plain`
(`dispatch.ts:437`) — this is a **behaviour change** and needs a `[ui]` line, not a silent refusal.

**Tests.** unit `test/unit/tui/app.test.tsx`: `dispatchCtx()` carries `isDeniedPath` once the host
is attached; `@.env` in a submission yields the notice and is absent from `pinnedFiles`;
`/export .env` errors. pty: extend the `mention.steps` fixture (committed) to assert
`is on the secret denylist`.

**Perf gate.** `perf/composer-latency.ts` p95 < 16 ms (proves the per-Enter host call is free).

**Identity.** Layout/behaviour — the `[ui]` notice text already exists (`submit.ts:28–30`), it is
simply reachable now.

---

### P9 — Mentions are validated, and code is not a mention

**What.** (a) `mentionedPaths` requires the token to look like a path (contains `/` or `.`, or
matches a candidate in the workspace listing) — `@decorator`, `@scope`, `@staticmethod` stop being
mentions; a `@scope/pkg` that is not in the listing is likewise not a mention. (b) A mention that
survives (a) but does not resolve to a readable file produces one `[ui]` line
`@<path> — no such file in the workspace; it was not attached` after the `[you]` bubble.

**Where.** `src/tui/composer/submit.ts:57–66` (`mentionedPaths` gains an optional
`isKnownPath?: (rel: string) => boolean`, supplied from `bridge.host.workspaceCandidates()` which
the App already fetches for the mention picker, `App.tsx:830`), `src/cli/session.ts:3220–3239`
(`readWorkspaceFile` returns a reason, and `llmInput`/`lookupInput` report it once).

**Edge cases.** (a) a file created *after* the listing was taken — the listing is a candidate set,
not a gate: an unknown token that still contains `/` or `.` stays a mention and the read decides;
(b) `@README` (no dot, no slash) in a repo that has `README` — the candidate check catches it;
(c) a path with an escaped space `@my\ file.py` — unchanged (`submit.ts:61`); (d) `@` alone —
already skipped; (e) `@../outside` — `isMentionDenied` returns true (`paths.ts:174`) → the denylist
notice from P8; (f) more than 5 mentions — `MENTIONS_MAX = 5` clips what goes to Jev, and the
notice must say `+N more mentions were not attached`; (g) the mention picker's own insertions always
resolve; (h) the candidate listing is a promise (`session.ts:3241`) — if it has not resolved, fall
back to the lexical rule (never block Enter on I/O: the first-frame and composer gates forbid it).

**Tests.** unit `submit.test.ts`: the eight rows above, including
`mentionedPaths('```\n@decorator\n```')` → `[]`. unit `session` test: an unreadable mention yields
one `[ui]` line. pty: `mention.steps` asserts both the denylist line and the not-found line.

**Perf gate.** `perf/composer-latency.ts` p95 < 16 ms; the candidate set is a `Set<string>` built
once (`workspaceCandidates` is already memoised as a promise).

**Identity.** **Text** for the two new `[ui]` lines (local items); one exported formatter shared by
both renderers.

---

### P10 — `/copy last` copies the turn; `/copy conversation` exists

**What.** `/copy last` copies every contiguous item sharing the last item's chat label, joined by
newlines, **unclipped** (from the ledger when available, else the item rows). A new
`/copy conversation` copies the whole ledger as `you: …` / `jevcode: …` blocks.

**Where.** `src/tui/App.tsx:1039` (the `last` branch), `src/tui/commands/registry.ts:428–431`
(a new enum value), `src/cli/session.ts` (a host accessor for the ledger text).

**Edge cases.** (a) the last item is not a chat item (a `[step]` row) — copy that one row, as today;
(b) an empty transcript — toast `nothing to copy`; (c) redaction — the ledger already stores
redacted text (`session.ts:3327`, `:3073`); (d) OSC 52 disabled / no clipboard — the existing
`copyRedacted` fallbacks (`App.tsx:1040`); (e) a 200-turn conversation through OSC 52 — cap the
payload at the existing clipboard cap and toast `copied (truncated to N KB)`; (f) `--plain` —
`/copy` is already refused there by `plainSupports` (`session.ts:2868`): unchanged.

**Tests.** unit `app.test.tsx`: a 3-line `[jevcode]` turn copies 3 lines; a clipped `[you]` turn
copies the unclipped source. pty: `mention.steps` extended to assert the toast and, with
`--osc52`, the emitted payload length.

**Identity.** Layout/behaviour; `/copy conversation` adds a registry row (a help-text change, not a
transcript-text change) — update `docs/COMMANDS.md` via `scripts/gen-docs.mjs` and the completions.

---

### P11 — `/new` actually starts a new conversation

**What.** `case 'new'` also: `abortChat()`, `ledger` reset (a fresh `createChatLedger()`),
`chatIntakes = []`, `chatThresholdsSeen.clear()`, `deferredChatLines = []`, and emits one divider
item `[ui] new conversation — earlier turns are no longer sent to Jev`.

**Where.** `src/cli/session.ts:2690–2702`; the ledger binding at `:1112` becomes `let`.

**Edge cases.** (a) `/new` while a run is live — already refused upstream? verify: `EXCLUSIVE_COMMANDS`
and the `live()` guard must reject or defer it; (b) `/new` while thinking — abort first, then reset,
so the in-flight reply cannot land in the new conversation (today it can: `converse` has no
`exiting`-style check between `runIntake` and `reply`); (c) `/cost` and `/jev` after `/new` must show
the new session's numbers — they read `ledger.stats()` (`session.ts:2490`, `:2514`), fixed by the
reset; (d) the scrollback keeps the old bubbles (it is append-only) — the divider item is what makes
the break legible; (e) `--plain` prints the same divider.

**Tests.** unit: `/new` clears `ledger.turns`, `stats().messages === 0`, and a pending chat promise
rejects with `AbortError`. pty: a new `chat-new.steps` that says `hi`, runs `/new`, says `hi` again
and asserts the second reply is `hello_first` (not `hello_again` — the mock's `replyOf` keys on
`conversation.length`, `session.ts:628–634`), which is a direct observable of the reset.

**Identity.** **Text** for the divider (a local `[ui]` item); one formatter, both renderers.

---

### P12 — Persist the conversation; restore it on resume

**What.** (a) A session id is minted at the **first chat turn**, not at the first run, so a
conversation-only session exists on disk. (b) Each turn appends one line to
`~/.jevcode/sessions/<id>/chat.jsonl` (`{t, role, text, kind?, p?, costUsd?}`, redacted, ≤ 4 KiB per
line, ≤ `LEDGER_MAX_TURNS` lines with the same rewrite-slack scheme as `history.ts:56–58`).
(c) `/resume` (and `-c`) rehydrates the ledger and replays the last `N` turns into the scrollback as
dimmed items under one `[ui] resumed conversation — N earlier turns` heading.

**Where.** new `src/chat/store.ts` (file I/O, mirroring `composer/history.ts`'s shape),
`src/cli/session.ts:1112` (ledger construction), `:3296–3311` (`meterChat`'s `sessionId === null`
branch disappears), `:2703–2711` (`resume`), `:1610` (`seedMeterFromIndex`).

**Edge cases.** (a) no write permission / `JEVCODE_NO_HISTORY` — reads still work, writes report
through the same `onWriteError` channel and never throw (`history.ts:12–13` precedent); (b) two
processes in the same session — `O_APPEND` line writes, same as history; (c) a 20 MB chat file —
tail-read cap like `HISTORY_MAX_READ_BYTES`; (d) replay must not re-charge the meter — the replayed
items are `[ui]`-dim, and `seedMeterFromIndex` remains the only money path; (e) replay must not
re-enter `<Static>` before the first frame — replay after `setHost`, in one batch, so the
first-frame gate is untouched; (f) secrets — the text is already redacted at push time
(`session.ts:3327`); (g) a resumed conversation whose workspace moved — the file is keyed by session
id, and the `workspace` field is recorded so a mismatch degrades to "not restored" with a `[ui]`
line; (h) `--plain` prints the same replay lines; (i) `/new` starts a new file (P11).

**Tests.** unit `test/unit/chat/store.test.ts` (round-trip, caps, rewrite, unreadable file);
`session` test: a chat-only session writes `index.jsonl` `kind:'chat'` lines. pty: a two-process
scenario — `chat-persist.steps` says `hi`, `/exit`, then a second run with `--continue` asserts
`resumed conversation` and that the reply is `hello_again`.

**Perf gate.** `perf/first-frame.ts` < 300 ms **unchanged** — the store must be opened lazily, after
the first frame, exactly as `history.ts` is loaded on first access. `perf/intake-latency.ts` bubble
p95 < 16 ms (the append is an `O_APPEND` write off the render path).

**Identity.** **Text** for the replay heading and the dim replay rows; both renderers share the
formatter. The replayed rows carry their original labels, so the §5.3 normaliser holds per row.

---

### P13 — The intake card stops orphaning a bubble and stops trapping the keyboard

**What.** Three changes. (a) The `[you]` bubble for an `ambiguous` reading is emitted *after* the
card is answered, not before (`converse` currently says it at `session.ts:2946`, before the intake
even runs) — on `keep`, no bubble is committed at all and the text simply returns to the composer.
(b) The card's body gains the escape route it already honours:
`[y] run it   [n] just chatting   (Esc keeps the text · Ctrl-C cancels)`.
(c) A `/`-leading line typed while the card is up is dispatched as a command (the card stays open
behind it) instead of being swallowed with the pending toast.

**Where.** `src/cli/session.ts:2946` (move `say('you', …)` past the `ambiguous` branch — note the
non-ambiguous paths must still emit it *before* the request, for the < 16 ms bubble gate), 
`src/chat/lines.ts:11,23–25` (the three width tiers of the body), `src/tui/App.tsx` intake-overlay
key handling (`:1351`).

**Edge cases.** (a) the bubble must still be committed before the Jev request for every non-ambiguous
reading — the reading is not known until the request returns, so the fix is: emit the bubble
immediately as today, and on `keep` append one `[ui] (message kept in the composer, not sent)`
marker so the orphan is labelled rather than silent. Prefer this over (a) as written; it preserves
`perf/intake-latency.ts`'s bubble gate. (b) Ctrl-C while the card is up already means `keep`
(`App.tsx:1351`) — the body now says so; (c) the three flat tiers (95 / 70 / 39 cells,
`lines.ts:23–25`) must each still fit — the new wording is 96 / 70 / 39 cells, so only the wide row
grows by one cell and `INTAKE_ROW_WIDE_COLUMNS = 100` still covers it; (d) the `--plain` readline
twin (`INTAKE_READLINE_PROMPT`, `lines.ts:36`) gains the same words and accepts `/`-lines by
dispatching them and re-prompting; (e) five invalid answers still keep (`READLINE_MAX_PROMPTS`);
(f) the screen-reader numbered form (`INTAKE_SR_LINES`, `lines.ts:38`) gains no new option (Ctrl-C
is not a numbered choice).

**Tests.** unit `test/unit/chat/lines.test.ts`: the three tiers' cell widths; `parseIntakeAnswer`
unchanged. pty: `chat-ambiguous.steps` extended — after Esc, assert the `[ui] (message kept…)`
marker; a new `chat-ambiguous-slash.steps` types `/cost` while the card is up and asserts the cost
block and that the card is still drawn.

**Identity.** **Text** for the card body, the readline prompt and the new marker. Twins:
`src/chat/lines.ts` is already the single source for Ink, `--plain` and SR; update
`test/pty/smoke/chat-ambiguous*.steps` and the `lines` unit test.

---

### P14 — The palette: Enter runs the highlighted row; Esc cleans up the `/`

**What.** (a) `palette:run` in `command` mode resolves `pal.selected` against
`paletteMatches(...)` and dispatches **that** row (falling back to the typed text only when the
match list is empty). (b) `closeOverlay('palette')` removes a draft that is exactly the
palette-opening token (`/` or the remembered prefix) so the next words are chat, not a bogus
command. (c) The footer becomes `↑↓ move · Tab completes · ⏎ runs · Esc closes`.

**Where.** `src/tui/App.tsx:1388–1414` (the `run` case), `:812–823` (`closeOverlay`),
`src/tui/commands/palette.ts` (the footer string).

**Edge cases.** (a) an exact typed command that is *not* the highlighted row (`/co` highlighted
`/cost` while the user typed `/copy`) — the typed exact match wins (today's rule) and only a
non-exact token falls through to the selection; (b) a command with required arguments
(`/rename <title>`) — running it from the palette must complete the name into the composer and keep
the palette open rather than erroring, i.e. selection + required args ⇒ `accept` semantics; (c) zero
matches — Enter keeps today's `unknown command` item; (d) `mention` mode — unchanged
(`App.tsx:1403–1406`); (e) the draft the user typed before `/` (`rememberedToken`, `App.tsx:814`) —
only a draft equal to the remembered token is cleared, never real text; (f) `--plain` has no palette;
(g) a live run — `paletteState().live` already filters idle-only rows.

**Tests.** unit `test/unit/tui/commands/palette.test.ts` + `app.test.tsx`: `/` + `↓` + Enter runs
`/new`; `/` + Enter runs `/help`; `/rename` + Enter completes instead of erroring; `/` + Esc leaves
an empty draft. pty: `palette.steps` (committed) — replace the error assertion with the help block.

**Perf gate.** `perf/composer-latency.ts` `palette` series p95 < 16 ms.

**Identity.** Layout/behaviour + the footer string (a dynamic overlay row, never a transcript item).

---

### P15 — Clearing a draft says so, and a long draft survives it

**What.** (a) Ctrl-C ×1 and Esc ×2 on a non-empty draft toast `draft cleared — ↑ restores it`.
(b) The App keeps the last cleared draft verbatim in a `useRef` (never React state, never a file),
and `↑` on an empty draft offers it first, so a draft larger than the 4 KiB history entry cap is
still recoverable in-session.

**Where.** `src/tui/App.tsx:840–855` (`clearDraftToHistory`), `src/tui/composer/Composer.tsx`
(`history` navigation start).

**Edge cases.** (a) the cleared draft contains a secret — the in-memory copy is the raw draft, which
already lives in the composer buffer; it is never written and is dropped on unmount, and the history
copy stays masked (`maskDraft`, `history.ts:87–104`); (b) two clears in a row — only the last is
kept; (c) `↑` after the in-memory slot was consumed — normal history; (d) the slot must not survive
`/new` or a workspace change; (e) screen reader — the toast is also an announcement candidate (P16);
(f) `--plain` — readline's own line editing applies, no change.

**Tests.** unit `app.test.tsx`: clear → toast → `↑` restores the full 8 KiB text; the history entry
is still clipped to 4 KiB. pty: `escctrlc.steps` (committed) asserts the toast.

**Identity.** Layout only (toast = dynamic row).

---

### P16 — The screen reader hears the conversation

**What.** In screen-reader mode: (a) one BEL plus an `osc9`/`osc99` notification when a `[jevcode]`
turn commits while the composer is idle; (b) the `thinking` → `null` transition appends one
`[ui]`-free announcement line (`<Static>` is the only reliably-read region) reading
`reply ready` when the reply is longer than one item; (c) the `thinking` start appends
`working…` once (not per frame).

**Where.** `src/tui/App.tsx:657` (the notifier), `:663` (add the `reply` kind),
`src/tui/useEngine.tsx` (the `thinking` reducer) and `src/tui/notify.ts` (a new kind).

**Edge cases.** (a) notifications are off by default and on in SR mode (`App.tsx:657`) — only the
`<Static>` announcement is SR-gated, the BEL follows the existing `notify` setting; (b) a reply that
arrives while the user is typing — no BEL (the existing run-end timer precedent: cancelled by a
keystroke); (c) a one-line reply — the label + text is already a `<Static>` row a reader will read;
only multi-item replies get the extra line; (d) rapid replies — at most one announcement per turn;
(e) `--plain` in SR mode — the rows are already sequential stdout, no change; (f) the announcement
must never contain the message text (it would be read twice).

**Tests.** unit `test/unit/tui/notify.test.ts` + `app.test.tsx`: the announcement fires once per
multi-item turn and never while typing. pty: `r3-wizard-sr.steps`'s sibling — a new `chat-sr.steps`
with `--screen-reader` asserting one `working…` and one `reply ready`.

**Identity.** **Text** for the two announcement lines, but they are SR-mode-only `<Static>` rows —
declare them in the normaliser as SR-only decoration (the existing `SR_REVIEW_MENU` /
`SR_REVIEW_PROMPT` precedent, `App.tsx:103–104`).

---

### P17 — The label gutter never eats the body

**What.** `TranscriptRow` clamps: when `columns` is smaller than `LABEL_GUTTER + 8`, the label box is
dropped for the row and the label is prefixed into the body as `label + ' '` with `wrap="wrap"`, so
the row degrades to plain wrapped text instead of a zero-width body.

**Where.** `src/tui/Transcript.tsx:108–134`.

**Edge cases.** (a) `columns === undefined` (the prop is optional) — unchanged; (b) `columns` 1–10 —
the row is one hard-wrapped column of characters, ugly but never an Ink layout error; (c) a
`[step 100]` label (10 cells, round 3 rule 1) at 20 columns — the clamp fires at 18; (d) `--ascii`
labels are the same width; (e) the identity normaliser: with the label inlined the row string is
still `formatTranscriptItem(item)` wrapped, so the predicate is *more* directly satisfied.

**Tests.** unit `round2-transcript.test.tsx`: render at columns 8, 10, 18, 20 and assert no row
exceeds `columns` and every row is non-empty. pty: extend `resize.steps` with a `resize 20 12`.

**Perf gate.** `perf/static-append.ts` report; `perf/render-lag.ts` p95 < 5 ms.

**Identity.** Layout only.

---

### P18 — Notices follow the message they annotate

**What.** The truncation notice and the denied/unknown-mention notices are emitted **after** the
`[you]` bubble, not before it.

**Where.** `src/tui/App.tsx:905–906` — move the two `noteLine` loops into the `.then()` of
`h.submit(...)` (or, better, pass `notice` and `droppedMentions` to `host.submit` so the controller
emits them in `converse` right after `say('you', …)` at `session.ts:2946`). The controller form is
preferred: it also fixes the `--plain` ordering.

**Edge cases.** (a) the submission is a steer — the notices follow the `[you]` steer bubble (P7);
(b) the submission fails before the bubble (no host) — unchanged; (c) ordering with the secret gate
— the gate already resolves before `send`; (d) `--json` ordering is by emission, so it follows.

**Tests.** unit: the item order in a fake host. pty: `long20k.steps` (committed) asserts
`[you]` precedes `[ui] notice:`.

**Identity.** Layout/ordering — no text changes.

---

### P19 — The `--plain` conversation twin is repaired

**What.** (a) After every item the plain renderer re-writes the readline prompt (readline's
`prompt(true)` equivalent: write `\n` + the current prompt) so items never land on the prompt line.
(b) A line beginning with `/` typed at the intake readline prompt is dispatched as a command and the
prompt is re-asked. (c) `jevcode chat --plain` with **piped** stdin reads one line at a time through
the same intake path instead of slurping stdin as one task.

**Where.** `src/tui/plain.ts:933–955` (`handle`, `endStream`), `:980–991` (`notify`,
`restoreDraft`), `src/cli/session.ts:753–925` (`createPlainPrompter`) and the non-interactive branch
of `isInteractive` (`session.ts:286`).

**Edge cases.** (a) a pipe with no trailing newline — the last line is still a message; (b) `--json`
— unchanged (no prompt); (c) `CI` / `TERM=dumb` — the prompt is not written at all, so (a) is a
no-op there; (d) `--no-input` — unchanged one-shot; (e) EOF mid-conversation — exits 0 with the
epilogue; (f) a piped line that is a command — dispatched, matching the TTY behaviour; (g) the
one-shot `jevcode run "<task>"` path is untouched — only `chat` changes, and only when stdin is a
pipe; (h) this is a **user-visible behaviour change** for scripts that pipe a task into
`jevcode chat --plain`: they should use `jevcode run --task-file -` / `jevcode run "<task>"`; note
it in `CHANGELOG.md` and `docs/COMMANDS.md`.

**Tests.** unit `test/unit/tui/plain.test.ts`: an item after a prompt writes a newline first. pty:
`plainchat.steps` (committed) asserts no `> [sandbox]` and that `/exit` at the intake prompt exits 0.
A shell test for the piped case.

**Identity.** Layout for (a); **behaviour** for (b) and (c). No transcript text changes.

---

### P20 — Code rows inside a turn read as code

**What.** A body row between an opening `^```\w*$` item and the matching closing fence item of the
**same turn** takes the `code` role (today only the fence rows do, `Transcript.tsx:110–113`).

**Where.** `src/tui/Transcript.tsx:108–134`, computed from the item's position in the `all` array
(a running "inside a fence" flag per turn, recomputed in the `useMemo` at `:141` so the per-row
render stays O(1)).

**Edge cases.** (a) an unclosed fence — the flag resets at the end of the turn, never leaks into the
next speaker; (b) nested fences — the first closing fence closes; (c) `--ascii` — colour only, no
glyph change; (d) `NO_COLOR` / `colorDepth() === false` — the role resolves to no attributes, so the
rows are identical; (e) `<Static>` write-once — the flag is computed before the item is written, so
no row is ever re-coloured; (f) an epoch remount mid-fence — the flag restarts false: acceptable.

**Tests.** unit `round2-transcript.test.tsx`: the 9-line fixture colours 4 rows `code`. pty:
`paste-code.steps` (committed) with colour retained asserts the SGR run.

**Perf gate.** `perf/static-append.ts` report; `perf/render-lag.ts` p95 < 5 ms.

**Identity.** Colour only.

---

## 6. Ordering, ownership and cost

| Wave | Proposals | Rationale |
| --- | --- | --- |
| 1 (pure, no identity cost) | P1, P4, P8, P14, P17, P18, P20 | layout/behaviour only; each is a few lines and a unit test |
| 2 (local text, one formatter) | P5, P6, P10, P11, P13, P15, P16 | new `[ui]` strings, no `transcript.log` change |
| 3 (transcript text — needs the D-M budget) | P2, P3, P7 | `bubbleLines`, the clip marker and the steer bubble change `transcript.log`; land them with the round-3 §5.3 normaliser rewrite so the pinned tests move once |
| 4 (new state) | P9, P12, P19 | the candidate-backed mention rule, the chat store, the `--plain` rework |

P1, P2 and P3 together are what the user's "clearest separations / nothing missing" asks for; P4,
P6 and P14 are what "handle all the edge cases" and "toggle through options" ask for; P8 and P9 are
the ones with a safety edge.

---

## 7. Risks

1. **P2/P3/P7 move `transcript.log`.** Round 3 deferred exactly this class (D-M). Landing three text
   changes in one commit with the §5.3 normaliser is cheaper than three commits, but it makes one
   large pinned-test diff (`test/pty/smoke/chat-*.steps`, `test/unit/tui/round2-transcript.test.tsx`,
   `test/unit/chat/bubbles.test.ts`, `src/perf/pty.ts`).
2. **P12 adds file I/O to the session.** The first-frame gate (< 300 ms, zero I/O before the frame)
   is the binding constraint: the store must be lazy exactly as `composer/history.ts` is.
3. **P19(c) is a breaking change** for anyone piping a task into `jevcode chat --plain`.
4. **P6 (the queue) interacts with money.** A queued message that flushes after an abort must not
   send; the abort path has to clear the queue, and the test for it is the one that matters.
5. **P1's `prev` is the visible predecessor.** Under `compact`, two `[you]` turns separated only by
   hidden stage items would merge. Turn ids (P12's ledger) remove the ambiguity; until then the rule
   is "same label ⇒ same turn", which is correct for every sequence the controller can produce today.
6. **P8 turns on a refusal path that has never run in the TUI** (`/export` onto a denylisted path).
   Expect at least one test that assumed the TUI accepted it.

---

## 8. Open questions for the owner

1. **Q1 — Does a `keep`-ed ambiguous message leave a bubble?** P13 proposes a `[ui] (message kept…)`
   marker rather than suppressing the bubble, because suppressing it would delay the bubble past the
   Jev request and break `perf/intake-latency.ts`'s "bubble committed before the request" property.
   Confirm the marker is the wanted behaviour.
2. **Q2 — How far should `/resume` replay?** P12 replays the last N turns dimmed. N = 6 (what Jev
   sees) or N = 20 (what a human wants to re-read)?
3. **Q3 — Timestamps.** Round 3 says no timestamps in the scrollback. For a long conversation, is a
   *session-relative* marker (`[ui] — 14:32, 12 turns —` every N turns or on the first turn after an
   idle gap > 10 min) acceptable, or does that violate rule 5 ("one thought per row")?
4. **Q4 — Should a `[you]` bubble ever be suppressed for a steer** (P7), e.g. for `/steer` issued by
   a script through `--json`?
5. **Q5 — `HistoryKind: 'chat'`** is declared and never written (finding 46). Delete the kind, or
   start writing it so `Ctrl-R` can filter chat from tasks?
6. **Q6 — Paste bodies in history** (finding 24): store the body (up to 4 KiB) instead of the chip
   label, or keep the label and make an unresolvable chip re-openable from a per-session paste file?
