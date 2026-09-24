# Round 4 · Topic A4 — Enter as the primary palette key: the navigation model

*Measured 2026-09-21 against commit `ec61170` in a throw-away worktree (`/tmp/jevcode-r4-palette`, `npm run -s build`,
`scripts/pty/drive.exp` at 24×80 and 12×60, temp `JEVCODE_HOME`, temp `--workspace` copy of `examples/demo-py`,
`node bin/jevcode.js --workspace … --mock`). Every pause is a draining `sleep` (research 20 §5). No file in the main
checkout was edited or executed. Captures: `p1`–`p5` below; the raw `.cap`/`.jsonl` live in `/tmp/r4pal-out/` and the
frames quoted here are reproduced verbatim from them.*

The user's request for this topic, verbatim: *"Can you make sure when we are going through commands after typing / we
can click enter button and toggle through options in the best way"*.

---

## 1. What the product does today (measured, not assumed)

### 1.1 The code path, file:line

| Concern | Site (`ec61170`) |
| --- | --- |
| `/` opens the palette | `src/tui/keys/resolve.ts:406–407` `case 'composer:palette'` → `s.draftEmpty ? [insert, openPalette] : textActions(k)`; binding `src/tui/keys/bindings.ts:109` (`when: 'column 0 of an empty draft'`) |
| palette key context | `src/tui/keys/resolve.ts:643–682` `resolvePalette`; registered at `:785–786` |
| Enter in the palette | `resolve.ts:649` `if (isEnter(k)) return one({ type: 'palette', op: 'run' })` — **unconditional**, no state test |
| Tab / Shift+Tab | `resolve.ts:666–667` (`palette:accept`), `:671` (`k.key.tab && k.key.shift` → `move -1`) |
| ↑ ↓ Ctrl-P Ctrl-N PgUp PgDn | `resolve.ts:658–665`; bindings `bindings.ts:132–135` |
| the composer fall-through blocklist | `resolve.ts:673` — `composer:up/down/historyPrev/historyNext/complete/completeBack` are **excluded**, so history recall is unreachable while the palette is open (correct) |
| `op: 'run'` handler | `src/tui/App.tsx:1402–1409` → `onEnter()` → `routeSubmit` |
| `op: 'move' / 'page'` handler | `App.tsx:1392–1398` — `setPalette({ ...pal, selected: clamp(pal.selected + by) })`, nothing else |
| `op: 'accept'` handler | `App.tsx:1399–1401` → `execute({ type: 'complete', dir: 1 })` |
| `case 'complete'` | `App.tsx:1372–1387` — `composer.set(\`/${matches[pal.selected].spec.name} \`)`; **always the command name, never an argument** (round-3 F4) |
| Enter routing | `src/tui/composer/submit.ts:149–173`; the palette branch is `:152–157`: `isExactCommand(token)` or the unknown-command item |
| exactness | `src/tui/commands/registry.ts:546–549` `isExactCommand` (names **and** aliases, case-folded, `/`-optional) |
| ghost text | `src/tui/commands/palette.ts:175–181` `paletteGhost` — reads **`matches[0]`**, never `selected`; drawn `src/tui/composer/Composer.tsx:628–634` as `rest` + ` +N` |
| `→` accepts the ghost | `Composer.tsx:417` (`action.to === 'right' && cursor >= text.length` → `{ kind: 'ghost' }`) → `App.tsx:1609–1615` |
| rows / footer | `palette.ts:188–240`; footer constant `palette.ts:45` `PALETTE_FOOTER = 'Tab completes · Enter runs an exact match · Esc closes'` |
| argument sub-rows | `palette.ts:218–231` — the selected command's `args[0].values`, **unfiltered and never highlighted** |
| palette closes | `App.tsx:1616–1620` — only when the draft stops starting with `/`; `closeOverlay` remembers the token (`App.tsx:812–816`) |
| Esc / Ctrl-C / Ctrl-D | `src/tui/keys/interrupts.ts:122–126` (Esc → `CLOSE_OVERLAY`), `:98–111` (Ctrl-C → `CLOSE_OVERLAY`, **before** the `!draftEmpty → CLEAR_DRAFT` rule at `:112`), `:144–146` (Ctrl-D → `CLOSE_OVERLAY`) |
| row budget | `src/tui/layout.ts:34` `CAP.palette: 8`, `:41` `CAP.card: 2`; want computed `src/tui/Overlay.tsx:104–114` |
| `--plain` | `src/tui/plain-composer.ts` — **no palette, no completion at all** |
| screen reader | `src/tui/Overlay.tsx:276` passes `screenReader` **only to the Wizard**; `App.tsx:744–760` announces only the review menu — **the palette has no SR twin** |
| perf gate | `src/perf/composer-latency.ts:59` series `'palette'`, plan at `:173–175` — 200 keys, 100 ms apart, query `/Z…`, i.e. **zero matches and no ghost**, gated p95 < 16 ms / max < 50 ms |

### 1.2 The measured behaviour

**p1 — `/`, ↓, ↓, Enter at 24×80** (`/tmp/r4pal-out/p1.cap`). The three palette frames, verbatim:

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /help          keys by context, commands with one-liners, per-terminal no… │
│   /new           end the session; the next prompt starts a new one here      │
│   /resume        pick a session to continue, or continue <id|title>          │
│   /rename        set the session title (≤ 60 chars)                          │
│   /steer         queue a directive for the next step (…) (live only)         │
│   (1/37)  Tab completes · Enter runs an exact match · Esc closes ▼           │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /help +36                                                                  │
```
after ↓↓ the marker is on `/resume`, the footer reads `(3/37)` — **and the composer still reads `› /help +36`**.
Enter then appends:

```
[ui] error: unknown command /; type / to list commands
```

and the palette stays open on `(3/37)`. The draft is still `/`; the next thing typed (`/exit`) became `//exit`, the
literal-slash escape (`submit.ts:164`), and was **submitted as a chat message** — the session never exited and the
driver timed out (`p1.jsonl` step 22 `{"op":"timeout","arg":"eof"}`).

**p5 — the highlight and the ghost disagree** (`/tmp/r4pal-out/p5.cap`): `/`, ↓, ↓ (selected = 2), then `m`:

```
│   /mode          engine mode: show, or set for the next run                  │
│   /model         generator model for the next run only                       │
│ ▌ /llm           Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)     │
│   /theme         colour theme for new items and the dynamic region           │
│   /resume        pick a session to continue, or continue <id|title>          │
│   (3/6)  Tab completes · Enter runs an exact match · Esc closes ▼            │
│ › /mode +5                                                                   │
```
The marker is on `/llm`, the ghost says `/mode`, Enter would run neither. `selected` is never reset when the query
changes (`App.tsx` has no such reset; `paletteRows` only clamps, `palette.ts:196`).

**p3 — `/`, `m`, `o`, Tab, Tab, `j`, Enter** (`/tmp/r4pal-out/p3.cap`), composer rows with the ghost span marked `|`:

```
'› /|help +36|'      after /
'› /m|ode +5|'       after m
'› /mo|de +1|'       after o
'› /mode '           after Tab      ← the name, plus a space
'› /mode '           after Tab #2   ← idempotent, no cycling
'› /mode j'          after j
```
and the palette rows while the draft was `/mode j`:

```
│ ▌ /mode          engine mode: show, or set for the next run                  │
│   /model         generator model for the next run only                       │
│   /mode jev-only                                                             │
│   /mode jev-on                                                               │
│   /mode jev-off                                                              │
│   (1/2)  Tab completes · Enter runs an exact match · Esc closes              │
```
The three value sub-rows **carry no title** (`valueHints` exists for `/budget` only, `registry.ts:284–291`), the
fourth value `llm-jev` is dropped with no marker, and typing `j` filtered **nothing**. Enter appended
`[ui] error: /mode: expected one of jev-only|jev-on|jev-off|llm-jev, got "j"` and left the palette open.

**p4 — zero candidates** (`/tmp/r4pal-out/p4.cap`), `/zz`:

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│   (0/0)  Tab completes · Enter runs an exact match · Esc closes              │
╰──────────────────────────────────────────────────────────────────────────────╯
                                    ← one blank filler row, no explanation
```
Esc closed it and kept `/zz`; `/` then inserted a second slash (`› /zz/`) because the palette only opens on an empty
draft — the user is **trapped**: three Escs (close, arm, clear) are the only way back. The arm toast measured:
`! Esc again clears the draft`.

**p2 — a multi-byte chunk never opens the palette.** `send /m` as one write produced `› /m` with **no palette at all**
(`p2.cap` frame 1) — Ink delivered one `useInput` with `input === '/m'`, which does not match the `/` binding. A fast
typist, a `read`-loop paste and every non-bracketed burst hit this.

**p4 — one torn frame on a grow resize** (12×60 → 24×80): 1 of 22 box frames had mixed row widths —
`╭─ jev-only …─╮` at 80 cells over `│ › /zz/cost/m … │` at 60. Transient (the next frame is correct), reported here
for topic A3; it is not caused by the palette.

### 1.3 Defect table

| # | Sev | Defect | Evidence |
| --- | --- | --- | --- |
| D1 | **H** | Enter never runs the highlighted row. ↓↓ then Enter on `/` yields `error: unknown command /` | p1; `resolve.ts:649` + `submit.ts:152–157` |
| D2 | **H** | The ghost previews `matches[0]`, the marker sits on `matches[selected]` — two different commands on screen at once | p5; `palette.ts:175–181` reads `matches[0]` |
| D3 | **H** | `selected` is not reset when the query changes (fzf resets to the top on every query change) | p5 frame 4; no reset site in `App.tsx` |
| D4 | **M** | Zero candidates draw an empty card with a `(0/0)` footer and a blank row — no message, no next step | p4 |
| D5 | **M** | Esc leaves the failed token in the draft and `/` can never reopen the palette (the trap); Ctrl-C does not clear it either because the overlay branch short-circuits before the draft rule | p1, p4; `interrupts.ts:100–112` |
| D6 | **M** | Tab is idempotent — a second Tab does not cycle, although `bindings.ts:107` promises "accept **or cycle**" | p3 (Tab, Tab → `/mode ` twice) |
| D7 | **M** | Argument sub-rows do not filter on the typed argument, are never highlighted, and silently drop values past the row budget | p3 (`/mode j` still lists all three) |
| D8 | **M** | Argument sub-rows for every command except `/budget` have an empty title column | p3 |
| D9 | **M** | The footer is one constant in every state (`palette.ts:45`), so it says "Enter runs an exact match" while the draft is `/` and Enter does not | p1, p4 |
| D10 | **M** | An errored command keeps the palette open and keeps the draft, so the next `/x` typed concatenates | p1 (`//exit`), p4 (`/zz/cost`); round-3 F21 fixes half of this |
| D11 | **M** | A `/`-prefixed multi-byte input chunk (fast typing, unbracketed paste) never opens the palette | p2 |
| D12 | **L** | `App.tsx:1616` claims the palette closes when "a space follows the command"; the code only tests the leading `/` | p3 (`/mode j` keeps the card) |
| D13 | **L** | No screen-reader twin and no `--plain` list: the palette is invisible to both | `Overlay.tsx:276`, `plain-composer.ts` |
| D14 | **L** | The gated perf series types `/Z…` (zero matches) — the cheap path; the 37-row + sub-row path is never gated | `composer-latency.ts:173–175` |

---

## 2. How the neighbours do it

| Product | Navigate | Accept (no run) | Run | Notes |
| --- | --- | --- | --- | --- |
| **opencode / octet** | ↑ ↓ | **Tab** — "completion-only so users can compose/edit arguments without executing anything" | **Enter** — "Up/Down selection followed by one unmodified Enter invokes the **highlighted** valid slash command exactly once through the existing command dispatcher" | The exact bug we have is filed as octet #429; opencode #50132 files the argument twin ("the popup closes and nothing happens … the text just sits in the input"). Safeguard kept: "commands/templates/extensions with missing **required** arguments use their existing prompt/help/validation behaviour" |
| **Gemini CLI** | `suggest.focusPrevious` ↑ / Ctrl+P, `suggest.focusNext` ↓ / Ctrl+N | — | `suggest.accept` = **Tab *and* Enter** (both accept the inline suggestion; a second Enter is `input.submit`) | Selection dialogs: `nav.dialog.up/down` ↑↓ and `j`/`k`; **number keys 1–9 (multi-digit) jump to the numbered radio option and confirm** — the model to copy for `--plain` / screen reader |
| **Claude Code** | arrow keys in the menu | — | Enter on the highlighted row | `Esc` closes without inserting anything |
| **fzf** | ↑ ↓ / Ctrl-P Ctrl-N | Tab = multi-select | Enter = `accept` (`accept-non-empty` refuses to accept nothing) | `--cycle` wraps; the cursor **moves to the top whenever the query changes** (`change:top` names the default) — the precedent for D3 |

Two of the four make Enter the runner; all four separate "move" from "commit"; all four reset to the top on a new
query; none of them runs a destructive command from a bare highlight.

JevCode differs from all four in one way that decides the design: **a submitted line is money** (`docs/TUI-DESIGN.md:2097`,
§22 against A34). `/new` ends the session (`registry.ts:96`, recoverable only through `/resume`), `/abort` discards the
step in flight, `/exit` leaves. So "Enter invokes the highlight" cannot be adopted unmodified: a user hammering Enter
to walk the list would, three presses in, be sitting on `/new`.

---

## 3. The recommended model

> **Tab goes deeper. Enter runs what is written. Enter with nothing written yet walks the list.**

Three rules carry the whole design:

1. **The draft is what runs.** Cycling never mutates the draft; the highlight is previewed as a dim ghost. This keeps
   `routeSubmit` (`submit.ts:149–173`), the `--plain` composer and the history record all routing on the same string
   they route on today, keeps Esc's "the draft is kept" contract (`App.tsx:814`) honest, and makes the preview
   identity-neutral (a ghost is never committed to `transcript.log`).
2. **The ghost *is* the highlight.** One source of truth — `paletteGhostFor(query, matches, selected)` — kills D2 and
   makes "what will Tab give me" and "what is the marker on" the same question.
3. **Enter runs iff the draft is exact *and* the marker is on the draft's own row** (`armed`). Moving the marker off is
   an explicit "still choosing"; moving it back, or Tab, re-arms.

Rule 3 is the safety theorem: **no sequence consisting only of Enter presses can execute `/new`, `/exit`, `/abort` or
`/history clear`.** Proof: from `/`, the marker is on row 1 and the draft is `/` (not exact) → every Enter is a cycle,
which does not touch the draft, so the draft stays `/` forever and never becomes exact. The one Enter that *does*
mutate the draft is the zero-ambiguity accept (S-ONE, §3.1) — reachable only after the user typed enough letters to
leave exactly one candidate, at which point the command is **visible in the draft** for a full committed frame; and the
confirm-set commands then hit a one-row confirm whose Enter is inert (§3.5). The shortest path from `/` to a destroyed
session is `n`, `e`, Enter, Enter, `y` — three distinct keys, one of them a positive `y`.

### 3.1 The state machine

Let `draft` be the composer text, `tok = commandToken(draft.trimStart())` (`parse.ts:41`), `spec = findCommand(tok)`
(`registry.ts:536`), `tail` the text after the first run of whitespace, `M` the ranked matches
(`paletteMatches`, `palette.ts:149`), `i` the marker index, `V` the value list of `spec.args[0].values` filtered by
`rank(tail, …)`.

| State | Predicate | **Enter** | **Tab / →** | Shift+Tab | ↑ / Ctrl-P | ↓ / Ctrl-N | PgUp/PgDn | Esc | printable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **S-BROWSE** | `spec === null`, `|M| ≥ 2` | `i = (i+1) mod |M|` | accept `M[i]` → draft `/<name>`, → S-ARMED | `i = (i−1+|M|) mod |M|` | `i−1` wrap | `i+1` wrap | ±7, clamp | close, keep draft, remember token | insert, `i = 0` |
| **S-ONE** | `spec === null`, `|M| === 1` | **accept** `M[0]` → S-ARMED | same | same | no-op | no-op | no-op | close | insert, `i = 0` |
| **S-NONE** | `|M| === 0` | no-op + toast `nothing to pick — no command matches <tok>` | same toast | — | — | — | — | close **and clear the draft when the draft is only the token** | insert |
| **S-ARMED** | `spec !== null`, no `tail`, `M[i] === spec` | **RUN** (`onEnter()`, via the confirm gate) | `spec` has an enum/`setting` arg 0 → append `' '`, → S-ARG; else no-op + toast `/<name> takes no arguments` | `i−1` → S-PICKED | `i−1` → S-PICKED | `i+1` → S-PICKED | ±7 → S-PICKED | close | insert, re-evaluate |
| **S-PICKED** | `spec !== null`, no `tail`, `M[i] !== spec` | `i = (i+1) mod |M|` (cycle) | accept `M[i]` → S-ARMED | cycle −1 | −1 | +1 | ±7 | close | insert, `i = 0` |
| **S-ARG** | `spec !== null`, arg 0 has `values`, `tail` is not exactly one of them | cycle `V` (wrap), ghost = `V[j]` | accept `V[j]` → draft `/<name> <value>`, → S-ARGDONE | cycle −1 | −1 | +1 | ±7 | close | insert, `j = 0` |
| **S-ARGDONE** | `spec !== null`, `tail` is exactly a value | **RUN** | `spec.args[1]?.values` exists → append `' '`, → S-ARG on arg 1; else no-op + toast | −1 → S-ARG | −1 | +1 | ±7 | close | insert |
| **S-FREE** | `spec !== null`, arg 0 has no `values` (`rest`/`text`/`path`/`run`/`step`/`int`/`usd`) | **RUN** (`dispatchCommand` validates and reports) | no-op + toast `no completions for <arg>` (round-3 §4.3) | — | move over `M` → S-PICKED | same | ±7 | close | insert |

`RUN` is the existing `onEnter()` → `routeSubmit` path with the palette branch unchanged (`submit.ts:152–157`) plus the
confirm gate of §3.5. Cycling **never** calls `routeSubmit`, `parseCommand` or `dispatchCommand`.

### 3.2 What the composer row and the palette rows show

`paletteGhostFor(query, matches, selected)` returns one of

```ts
export type PaletteGhost =
  | { kind: 'rest';  rest: string;   more: number }   // the marked row extends the typed token: "/mo" ▸ "de +1"
  | { kind: 'arrow'; target: string; more: number }   // it does not (alias or fuzzy hit): "/q" ▸ " → /exit +2"
  | { kind: 'value'; rest: string;   more: number };  // an argument value: "/mode j" ▸ "ev-on +1"
```

`--ascii`: `→` becomes `->`. The `+N` suffix stays `more > 0 ? \` +${more}\` : ''` as today (`Composer.tsx:634`).

**24×80, boxed, S-BROWSE after `/` then two Enters** (marker, ghost and footer now agree):

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
(the alias column is round-3 §4.1 rule 4; this design does not change it.)

**24×80, S-ARMED on `/mode`** (typed in full, or Tab-accepted):

```
│ ▌ /mode       m  engine mode: show, or set for the next run                  │
│   /model     ml  generator model for the next run only                       │
│   /mode jev-on                    jev+llm: the code model writes, Jev decid… │
│   /mode llm-jev                   llm+jev · verified: candidate patches, te… │
│   /mode jev-only                  no generating LLM; code proposes, Jev dec… │
│   (1/2)  Enter runs /mode · Tab adds an argument · Esc closes                │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /mode                                                                      │
```

**24×80, S-ARG after Tab then one Enter** (the sub-rows now filter and carry a marker):

```
│   /mode       m  engine mode: show, or set for the next run                  │
│ ▹ /mode jev-on                    jev+llm: the code model writes, Jev decid… │
│   /mode llm-jev                   llm+jev · verified: candidate patches, te… │
│   /mode jev-only (default)        no generating LLM; code proposes, Jev dec… │
│   /mode jev-off                   the generator alone (bench condition)      │
│   (2/4)  Enter next value · Tab picks · Esc closes                           │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /mode jev-on                                                               │
```
`▹` (ASCII `-`) marks the value cursor so it is never confused with the command marker `▌` (`>`).
The draft shows `/mode ` and `jev-on` is the **ghost** — dim — until Tab.

**24×80, S-NONE** (replaces the empty card of D4):

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│   no command matches /zz — keep typing, or Esc to clear                      │
│   (0/0)  Esc closes                                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /zz                                                                        │
```

**12×60 flat tier, S-BROWSE** (7 rows for the palette, no card edges; every row exactly 60 cells):

```
  /help       h  keys by context, commands with one-liners,…
▌ /new       nw  end the session; the next prompt starts a …
  /resume     r  pick a session to continue, or continue <i…
  /rename        set the session title (≤ 60 chars)         
  /steer         queue a directive for the ne…  (live only) 
  (2/37)  Enter next · Tab picks · Esc closes              ▼
› /new +36                                                  
jev+llm · palette        step 0/–  sess $0.00/1.25 ok  ⏎ next
```
The status-line ShortHelp becomes state-aware too: `⏎ next` in S-BROWSE/S-ARG, `Tab ⇥` in S-ARMED/S-ARGDONE
(`docs/TUI-DESIGN.md:1035` drop order unchanged; ASCII `Enter next`).

### 3.3 The footer strings (verbatim, §24 additions)

`PALETTE_FOOTER` (`palette.ts:45`) is replaced by `paletteFooterText(state)`:

| State | Footer after `(i/N)  ` |
| --- | --- |
| S-BROWSE | `Enter next · Tab picks · Esc closes` |
| S-ONE | `Enter picks /budget · Esc closes` |
| S-ARMED, spec has an enum arg | `Enter runs /mode · Tab adds an argument · Esc closes` |
| S-ARMED, no args | `Enter runs /cost · Esc closes` |
| S-ARMED, unavailable now | `Enter runs /undo · idle only · Esc closes` (the whole row dim) |
| S-PICKED | `Tab picks /model · Enter next · Esc closes` |
| S-ARG | `Enter next value · Tab picks · Esc closes` |
| S-ARGDONE | `Enter runs /mode jev-on · Esc closes` |
| S-FREE | `Enter runs /rename · type the title · Esc closes` |
| S-NONE | `Esc closes` |

`·` → ` - ` under `--ascii` (today's rule, `palette.ts:238`). `▲`/`▼` scroll marks unchanged. The command name in the
footer is always the **resolved owner**, so `/q` reads `Enter runs /exit` — the single best guard against an alias
surprise.

Inline row (S-NONE): `no command matches <tok> — keep typing, or Esc to clear`.

Toasts: `nothing to pick — no command matches <tok>` · `/<name> takes no arguments` · `no completions for <arg>`
(round-3 §4.3, reused verbatim).

### 3.4 `--plain` and screen reader: the numbered list

Neither has a palette today (D13). Gemini CLI's numbered radio options are the precedent.

`paletteNumberedLines(query, state, columns): string[]` in `palette.ts` — **one formatter, both twins**:

```
commands (37) — type a number or a name, then Enter
  1  /help        keys by context, commands with one-liners, per-terminal notes
  2  /new         end the session; the next prompt starts a new one here
 …
 37  /exit        leave (exit 0; confirms first while a run is live)
```

* `--plain`: a submitted line that is exactly `/` prints the block as one `[ui]` item and sets a one-shot
  `pendingList` on the composer; the **next** line, if it is a bare integer in `1..N`, runs that command; anything else
  clears `pendingList` and is handled normally (so a bare `12` is still a prompt in every other turn).
* TUI under `--screen-reader`: `/` appends the same block, and each highlight change appends **one** line
  `palette: 3 of 37 · /resume · pick a session to continue · Enter next, Tab picks, Esc closes`, coalesced to at most
  one line per 400 ms so hammering Enter cannot flood. The block and the announcement go through
  `paletteNumberedLines` / `paletteAnnounce`, so `--plain --screen-reader` prints byte-identical lines.

### 3.5 The confirm gate (destructive commands)

`CommandSpec` gains `destructive?: true` on `new`, `abort`, `exit` and on `history` when `args[0] === 'clear'`.
`DispatchResult.ok` gains `confirm: 'new' | 'abort' | 'exit' | 'history-clear' | null`, set when
`spec.destructive === true` **and** the caller passed `fromPalette: true` — i.e. the line reached Enter through an
accept or a cycle, not through a line the user typed end-to-end and submitted from a closed palette.

*Why provenance-gated:* the risk this closes is **mis-selection**, not mis-typing. A hand-typed `/exit` + Enter must
keep exiting at once (no regression for `exitlast.steps`, `docs/TUI.md`, muscle memory, `--plain`). A `/ex` + Tab +
Enter is a selection and gets one key of friction.

One-row overlays (the existing `exitConfirm` slot, `CAP.exitConfirm: 1`, `layout.ts:36`; Enter inert exactly as
`docs/TUI-DESIGN.md:2149` already specifies for the exit confirm):

```
end this session and start fresh? [y] yes   [n] keep it            (Enter does nothing)
abort the run now? the step in flight is discarded. [y] abort  [n] keep running  (Enter does nothing)
leave JevCode? [y] exit   [n] stay                                 (Enter does nothing)
```

`/history clear` already prompts `y/N` (`registry.ts:488–490`) and `/undo` already opens the undo overlay
(`App.tsx:1793`) — neither changes. `/exit` while live already confirms (`registry.ts:510`); the palette-sourced idle
`/exit` now does too.

### 3.6 Enumerated edge cases

| # | Case | Behaviour |
| --- | --- | --- |
| E1 | single candidate | S-ONE: Enter **accepts** (zero ambiguity, cycling is meaningless); ↑/↓ are no-ops; the footer names the command |
| E2 | zero candidates | S-NONE: the inline row, the `(0/0)  Esc closes` footer, Enter is a toast and never an item (an item for a keystroke the user did not commit is noise) |
| E3 | typed alias (`/q`, `/s`, `/m`) | `isExactCommand` already accepts aliases (`registry.ts:547`) → S-ARMED on the **owner**; the footer prints the owner (`Enter runs /exit`); round-3 rule 2 pins the owner to row 1 so the marker agrees |
| E4 | exact name that prefixes another (`/mode` vs `/model`) | S-ARMED: Enter runs `/mode`; `/model` stays visible one row down; ↓ moves to `/model` → S-PICKED, the footer flips to `Tab picks /model · Enter next`, and Enter no longer runs |
| E5 | while a run is live | the palette opens; `paletteState.live` dims idle-only rows (`palette.ts:208–209`); Enter in S-ARMED runs the **command**, never a steer (`submit.ts:152` short-circuits before `routeSend`) — unchanged; an availability error now **clears the draft and closes the palette** (nothing is fixable by editing; round-3 F21 supplies `keepDraft: false`) |
| E6 | a run starts while the palette is open | `PaletteState` for **grouping** is frozen at open (the same pattern round-3 §4.1 rule 6 uses for `recent`); only the `live` flag refreshes, so rows re-tag `(idle only)` in place and **never reorder under the user's fingers**; `selected` is preserved |
| E7 | while the chat intake is thinking (F14) | cycling never reaches `routeSubmit`, so the `submitting` guard (`submit.ts:150`) cannot swallow it — Enter-cycling works while thinking with no change to `submit.ts`; `RUN` follows round-3 F14 (`allowCommandsWhileSubmitting` for `isCommandLine`), and an idle-only command answers `STILL_THINKING_TOAST` |
| E8 | history ↑/↓ conflict | unchanged and correct: `resolve.ts:673` excludes `composer:historyPrev/Next/up/down` from the palette fall-through, and the palette only opens on an **empty** draft, so no recall is ever interrupted. A pty test pins it |
| E9 | paste containing a slash | a **bracketed** paste (`k.paste === true`) never opens the palette (`resolve.ts:648` handles pastes first) — a pasted prompt starting with `/` stays text. A **non-paste** chunk that is exactly `/` + `[a-z0-9-]{0,8}` at column 0 of an empty draft *does* open it with the remainder as the query (fixes D11); the length + charset bound keeps a 2 KB unbracketed burst as text |
| E10 | mouse wheel | with no mouse tracking enabled the terminal either sends nothing or `ESC[A`/`ESC[B`, which move the marker — desirable. If SGR reporting is on from an outer program, Ink delivers `input` like `[<64;10;5M`; a `MOUSE_RE = /^\[(?:<[0-9;]+[Mm]|M[\s\S]{3})$/` guard **drops** it in every context instead of inserting it into the draft |
| E11 | ghost width at 40 columns | the ghost is cut with `cut()` to `inner − cellWidth(lastDraftRow) − 1`; under 4 cells of room only ` +N` is drawn; under 3, nothing. The rows already carry the information, so nothing is lost. Worst measured case `/budget ` + `max-generator-tokens` + ` +5` = 33 cells, fits at 40 |
| E12 | Ctrl-C with the palette open | today `CLOSE_OVERLAY` only (`interrupts.ts:100–110`), which leaves the trap of D5. New: `CLOSE_OVERLAY_AND_CLEAR` when the whole draft is the token (`draft.trim() === commandToken(draft.trim())`), else today's behaviour. Ctrl-C twice still exits 0 |
| E13 | Esc with the palette open | **unchanged**: close, keep the draft, remember the token (`App.tsx:812–816`, the Codex rule). To undo the trap without touching Esc, `/` typed at the end of a draft that is exactly a `/token` **reopens** the palette instead of inserting a second slash (it cannot fire mid-prompt: a prompt has a space or does not start with `/`) |
| E14 | Ctrl-D with the palette open | unchanged (`interrupts.ts:145` → `CLOSE_OVERLAY`) |
| E15 | `--plain` | §3.4; the state machine does not exist there — the numbered list is the whole model |
| E16 | screen reader | §3.4; the visual marker is replaced by the announcement line; the row budget and the card are unchanged (`chromeRows` already returns 0 under SR, `layout.ts:72`) |
| E17 | reduced motion / `NO_COLOR` / SSH 15 fps | nothing in this design animates or adds a timer; the dim ghost degrades to plain text under `NO_COLOR` and stays legible because the footer names the target |
| E18 | flat tier < 16 rows | the palette already collapses to `rows` lines with the footer last (`palette.ts:197`); at `n === 1` only the footer survives — it must then be the **state** footer (`Enter next`), which is the one thing a one-row palette can still teach |
| E19 | rewind menu (Esc Esc) | `rewindMenu` pre-filters to four commands (`palette.ts:52, 151`); S-BROWSE applies unchanged, and because `/new` is in that set the confirm gate of §3.5 covers it |
| E20 | `/budget spend-cap` with a second free argument | S-ARGDONE → Tab has no candidate list for `value` (`kind: 'text'`) → toast `no completions for <v>`; Enter runs and `dispatchCommand` reports the missing value |
| E21 | Enter key-repeat / a paste containing `\r` | a paste is handled at `resolve.ts:648` before `isEnter`, so a pasted CR never cycles or runs; a held Enter cycles at the terminal's repeat rate and, by the §3 theorem, can never run anything |
| E22 | width 0 / `NaN` columns | `paletteRows` already clamps (`palette.ts:189–191`); the new footer builder must route through the same `cut()` |

---

## 4. Proposals

Each item gives: what changes · where · edge cases · tests · the perf gate · the identity classification
(**text** = a string that reaches `transcript.log` / `--plain` and therefore needs the one formatter plus every pinned
test; **chrome** = colour/layout/ephemeral only, no identity obligation).

### P1 — Enter cycles, Tab/→ accepts, Enter runs the armed draft (fixes D1, D6, D9)

**What.** Replace `resolve.ts:649`'s unconditional `{ palette: 'run' }` with a state-carrying action
`{ type: 'palette', op: 'enter' }`, and resolve the state in one pure function

```ts
// src/tui/commands/nav.ts (new, pure, no Ink, no I/O)
export type PaletteNavState = 'browse' | 'one' | 'none' | 'armed' | 'picked' | 'arg' | 'argdone' | 'free';
export function paletteNavState(draft: string, matches: readonly PaletteMatch[], selected: number): PaletteNavState;
export function paletteStep(s: PaletteNavState, key: 'enter'|'tab'|'shifttab'|'up'|'down'|'pageup'|'pagedown',
                            ctx: NavCtx): NavEffect;   // NavEffect = move | accept | run | append-space | toast | none
```
`App.tsx` `case 'palette'` (`:1388–1415`) dispatches `NavEffect`; `case 'complete'` (`:1372–1387`) becomes the single
`accept` implementation shared by Tab, `→` and the S-ONE Enter. `Tab` on S-ARMED appends the space (today's
`composer.set('/name ')` already does, `:1385`) and Shift+Tab cycles backwards over the same list (fixes D6).

**Where.** `src/tui/commands/nav.ts` (new) · `src/tui/keys/resolve.ts:643–682` · `src/tui/App.tsx:1372–1415` ·
`src/tui/keys/bindings.ts:136–138` (titles: `palette:run` → "run the armed draft; otherwise move to the next row";
`palette:accept` → "put the highlighted row in the draft") · `docs/KEYS.md:101–107` regenerated.

**Edge cases.** E1, E2, E3, E4, E5, E7, E8, E18, E21, E22.

**Tests.** Unit `test/unit/tui/commands/nav.test.ts` — the full 8 states × 7 keys table, one assertion per cell, plus
the theorem as a property test: *for every `matches` list and every k ≤ 200, applying `enter` k times from
`paletteNavState('/', …)` never yields a `run` effect.* Unit `test/unit/tui/keys/resolve.test.ts` (Enter in the palette
now emits `op: 'enter'`). Unit `test/unit/tui/round4-palette-app.test.tsx` (`/` + Enter×2 + Tab + Enter runs
`/resume`). pty `test/pty/smoke/palette-enter.steps`: `/` · Enter · Enter · expect `(3/37)` and `› /resume +36` · Tab ·
expect `› /resume` with no ghost · Enter · expect the session picker.

**Perf gate.** Composer keystroke → frame p95 < 16 ms (D-F), measured by the `palette` series
(`src/perf/composer-latency.ts:59`). The cycle path must not call `parseCommand`/`dispatchCommand`; `paletteMatches` is
memoised on `(token, frozenStateKey)` in `paletteRef` so an Enter press is `setPalette({selected})` + one render.

**Identity.** **chrome** for the cycling itself (no item, no transcript line). The footer text is **text-adjacent**:
it is an overlay row, not a `<Static>` item, so it never reaches `transcript.log` — but it *is* pinned in
`docs/TUI-DESIGN.md:420,662,952,2149`, `docs/TUI-DESIGN-3.md:1150,1167,1182`, `docs/COMMANDS.md:5`, `docs/TUI.md:201`,
`docs/research/tui/round-3/commands.md:229,247,262,276,290` and read back by `test/unit/tui/commands/palette.test.ts`
(the `frameFKRows()` pattern). P1 must update all of them in the same commit.

### P2 — the ghost is the highlight (fixes D2)

**What.** `paletteGhost(query, matches)` → `paletteGhostFor(query, matches, selected)` returning the §3.2 union
(`rest` | `arrow` | `value`). `arrow` subsumes round-3 §4.1 rule 3, so the two rounds land one type, not two.

**Where.** `src/tui/commands/palette.ts:175–181` · `src/tui/composer/Composer.tsx:583–584, 628–634` (render the three
shapes; `→`/`->`) · `src/tui/App.tsx:1609–1615` (the `→` accept reads the union) and `:2008` (pass `palette.selected`).

**Edge cases.** E3 (alias arrow), E11 (40-column cut), E17 (`NO_COLOR`: the ghost is still distinguishable because the
footer names the target), a ghost while the cursor is not at the end (`Composer.tsx:628` already suppresses it).

**Tests.** Unit `palette.test.ts`: `paletteGhostFor('/m', M, 0) === {kind:'rest',rest:'ode',more:5}`,
`…(…, 2) === {kind:'arrow',target:'/llm',more:5}`; the 40-column cut. Unit `composer.test.tsx` snapshot of all three
shapes at 40/80. pty `palette-enter.steps` asserts the composer row changes with every Enter.

**Perf gate.** Same 16 ms series; one extra array index per render.

**Identity.** **chrome** (the ghost is never committed).

### P3 — reset the marker to the top on every query change (fixes D3)

**What.** When `commandToken(draft)` changes, `selected = 0` (and the value cursor `j = 0` when the argument token
changes) — fzf's documented default.

**Where.** `src/tui/App.tsx:1616–1621` (the composer-edit fall-through already runs on every keystroke; add a
`lastToken` ref compare) and `openPalette` (`:824–832`, already `selected: 0`).

**Edge cases.** backspace back to a token that used to have a marker (still resets — no hidden memory); a paste that
rewrites the token; an argument token change while in S-ARG resets only `j`, not `i`.

**Tests.** Unit `round4-palette-app.test.tsx` (`/` ↓ ↓ `m` → footer `(1/6)` and the marker on `/mode`).
pty `palette-enter.steps` extends p5's sequence and expects `(1/6)`.

**Perf gate.** One string compare per keystroke — inside the 16 ms gate.

**Identity.** **chrome**.

### P4 — argument mode: filtered, marked sub-rows with titles (fixes D7, D8; completes round-3 §4.3)

**What.** `paletteRows` filters `args[k].values` through `rank(tail, values)`, marks the value cursor with `▹` (ASCII
`-`), appends ` (default)` to the row equal to `DEFAULT_MODE` (round-3 §4.1 rule 8 / D-N), and shows `… +N more` on the
footer when values are cut by the row budget. `valueHints` are filled for `/mode`, `/panel`, `/transcript`, `/theme`,
`/copy`, `/logout`, `/help`, `/decisions` (round-3 §4.1 rule 8 — this proposal depends on it and adds nothing new).

**Where.** `src/tui/commands/palette.ts:218–231` (filter + marker + overflow) · `src/tui/Overlay.tsx:195–216`
(`PaletteRowText` paints `▹`) · `src/tui/commands/registry.ts` (`valueHints`, round-3 work).

**Edge cases.** E20, a value list longer than the spare rows (footer `+N more`), two enum arguments (`/decisions 5 ri`
→ arg 1), `--flags` skipped when counting `argIndex` (round-3 §4.3), a `run` candidate containing spaces (quoted on
accept, round-3 §4.3), an empty `tail` (no filter, `j = 0`).

**Tests.** Unit `palette.test.ts`: `/mode j` yields exactly `jev-only|jev-on|jev-off` in rank order with `▹` on `j = 0`;
`/mode ` yields four rows with ` (default)` on one. pty `test/pty/smoke/palette-arg.steps`: `/mode` Tab Enter Enter Tab
Enter → `[ui] mode …`.

**Perf gate.** 16 ms; `rank` over ≤ 8 values is < 0.05 ms (`fuzzy.test.ts`).

**Identity.** **chrome** for the rows. The `valueHints` titles are **text** only where they also feed
`docs/COMMANDS.md` / `man/jevcode.1` (`scripts/gen-docs.mjs`) — `gen-docs --check` must be re-run
(`registry.test.ts:186`).

### P5 — the empty state and the trap (fixes D4, D5, D10, D12)

**What.** (a) S-NONE draws the inline row of §3.2 instead of a blank card. (b) Ctrl-C with the palette open clears the
draft when the draft is only the token (E12). (c) `/` typed at the end of a draft that is exactly a `/token` reopens
the palette instead of inserting (E13). (d) An **availability** error closes the palette and clears the draft
(round-3 F21 `keepDraft: false`); a **fixable** error keeps both. (e) The palette also closes when the token has zero
matches and the draft contains a space (`/fix the bug` typed fast through E9 no longer leaves a dead card) — and
`App.tsx:1616`'s comment is corrected to match the code (D12).

**Where.** `src/tui/commands/palette.ts:232–240` (the `kind: 'empty'` row and the S-NONE footer) ·
`src/tui/keys/interrupts.ts:98–111` (the new `CLOSE_OVERLAY_AND_CLEAR` result) · `src/tui/keys/resolve.ts:406–407`
(the reopen rule) · `src/tui/App.tsx:1096–1102, 1616–1621`.

**Edge cases.** E2, E9, E12, E13; Ctrl-C twice still exits 0 (`interrupts.ts:118`); the remembered-token rule is
untouched for Esc; `//` at column 0 still escapes to a literal-slash prompt (`submit.ts:164`) because it is two
characters typed into a non-empty draft.

**Tests.** Unit `interrupts.test.ts` (palette + non-empty token → `CLOSE_OVERLAY_AND_CLEAR`; palette + `/budget 5` →
`CLOSE_OVERLAY`). Unit `palette.test.ts` (the S-NONE rows at 80 and 60). Unit `resolve.test.ts` (the reopen rule; a
paste of `/x` does **not** reopen). pty `palette-enter.steps`: `/zz` · expect `no command matches /zz` · Ctrl-C ·
expect the placeholder `Say hi` · `/` · expect the card — **the exact sequence that trapped p1 and p4**.

**Perf gate.** 16 ms; no new work per keystroke beyond the existing match count.

**Identity.** the inline row is **chrome**. (d) changes when an `[ui] error:` item is followed by a cleared draft —
the item **text** is unchanged, so no formatter change; the pinned tests are `submit.test.ts:32`,
`round3-commands-app.test.tsx` and `test/pty/smoke/commands-idle.steps` (which today asserts
`expect (?:›|>) …/budgett` — still true, it is a fixable error).

### P6 — the confirm gate for destructive commands (§3.5)

**What.** `destructive?: true` in `CommandSpec`; `confirm` on `DispatchResult`; three one-row overlays with an inert
Enter; `fromPalette` provenance.

**Where.** `src/tui/commands/registry.ts` (4 rows) · `src/tui/commands/dispatch.ts:76–93` · `src/tui/composer/submit.ts:94`
(`SubmitDecision.command` carries `confirm`) · `src/tui/App.tsx` (`case 'command'` routes to the existing
`exitConfirm` overlay machinery) · `src/tui/layout.ts` (no change — `CAP.exitConfirm: 1` suffices) ·
`docs/TUI-DESIGN.md:2149` gains the three strings.

**Edge cases.** a hand-typed `/exit` + Enter must still exit with no confirm (`exitlast.steps`, `docs/TUI.md`);
`/exit` while live keeps today's confirm (`registry.ts:510`); `/history clear` keeps its own `y/N`;
Ctrl-C on the confirm cancels (`interrupts.ts:100–110` → `CLOSE_OVERLAY`); Esc cancels; **Enter is inert** (the rule
`docs/TUI-DESIGN.md:2149` already states for the exit confirm); `--plain` never sees `fromPalette` (no palette) so its
behaviour is unchanged; the rewind menu's `/new` is covered (E19).

**Tests.** Unit `dispatch.test.ts` (`fromPalette: true` + `/new` → `confirm: 'new'`; `fromPalette: false` → `null`).
Unit `round4-palette-app.test.tsx` (Enter on an accepted `/new` opens the row; Enter on the row does nothing; `y` ends
the session; `n` keeps it). pty `test/pty/smoke/palette-destructive.steps`: `/` · `n` · `e` · Enter (accept) · Enter ·
expect `end this session and start fresh?` · Enter · expect the row still there · `n` · expect the composer back.
Regression pty: `exitlast.steps` unchanged (a hand-typed `/exit` still exits).

**Perf gate.** n/a (no per-keystroke work); the overlay is one row inside `CAP`, so the zero-clears gate is unaffected.

**Identity.** **text** — three new overlay strings. They are overlay rows, not `<Static>` items, so they do not reach
`transcript.log`; §24 (`docs/TUI-DESIGN.md:2149`) is the pinned copy and `test/unit/tui/overlay.test.tsx` the assertion.
The **session-ending item** printed after `y` is unchanged.

### P7 — `--plain` and screen-reader twins (fixes D13)

**What.** `paletteNumberedLines()` and `paletteAnnounce()` in `palette.ts`; the `--plain` `pendingList`; the SR
announcement with a 400 ms coalescing window.

**Where.** `src/tui/commands/palette.ts` (both formatters) · `src/tui/plain-composer.ts:226–247` (the `/` line and the
one-shot number) · `src/tui/App.tsx:744–760` (extend the SR effect; no new timer — the deadline is a ref checked inside
the existing effect).

**Edge cases.** a bare integer outside `1..N` (normal prompt); `pendingList` cleared by any other line; `--plain` under
a pipe (`columns() === 80`); SR + `--ascii`; the block respects `HELP_MAX_LINES`-style capping at 40 rows with
`… 17 more — /help commands` as the tail; hammering Enter under SR (coalesced).

**Tests.** Unit `plain-composer.test.ts` (`/` prints the list; `3` runs `/resume`; `3` on the next turn is a prompt).
Unit `palette.test.ts` (the numbered block at 80 and 60). pty `test/pty/smoke/palette-sr.steps` with
`JEVCODE_SCREEN_READER=1`. **Identity test:** `--plain --screen-reader` and the TUI under SR emit byte-identical
announcement lines (the declared normaliser: these lines are SR-only and absent from both twins without SR).

**Perf gate.** First frame < 300 ms untouched (nothing runs before `/`); lag p95 < 5 ms (no timer added).

**Identity.** **text**, through one formatter, with a declared SR-only normaliser. Precedent: the SR review menu
(`App.tsx:752–753`) is already an SR-only `[ui]` line.

### P8 — gate the real palette hot path (fixes D14)

**What.** Add a `palette-cycle` series to `src/perf/composer-latency.ts`: open the palette on `/` (37 rows + the
selected command's sub-rows, the alias column on), then send 200 **Enter** presses 100 ms apart; gate p95 < 16 ms and
max < 50 ms like the others. Keep the existing `/Z…` series as `palette` (the zero-match path) and add
`palette-arg` (200 Enters in S-ARG over `/mode `) as **reported**.

**Where.** `src/perf/composer-latency.ts:59, 173–175, 209–222` · `src/perf/states.ts:181` re-records the palette state
at 24×80 and 12×60 (0 clears) with the new rows · `src/perf/readme.ts`.

**Edge cases.** the driver must locate a frame per Enter — the marker row changes every press, so the existing
"frame contains the grapheme" locator is replaced by "the frame's `(i/N)` differs from the previous frame's".

**Tests.** the perf harness itself; `test/pty/smoke/palette-enter.steps` proves 0 clears with the palette open.

**Perf gate.** this *is* the gate.

**Identity.** **chrome** (perf only).

### P9 — the multi-byte `/` chunk and the mouse guard (fixes D11, E10)

**What.** (a) In `resolveComposer`, a non-paste chunk matching `/^\/[a-z0-9-]{0,8}$/i` at column 0 of an empty draft
emits `[{insert}, {openPalette}]`. (b) A `MOUSE_RE` guard drops SGR/X10 mouse reports in every context instead of
inserting them into the draft.

**Where.** `src/tui/keys/resolve.ts:402–407` and the `isPrintable` guard (`resolve.ts` helpers).

**Edge cases.** a bracketed paste is unaffected (handled first, `resolve.ts:648`); a 2 KB burst is still text (length
bound); `/Ab-c` opens (case-folded by `paletteMatches` anyway); a chunk with a space (`/m x`) does not open —
it falls through to text and `routeSubmit`'s `isCommandLine` path handles Enter identically.

**Tests.** Unit `resolve.test.ts` (one event `{input:'/mo'}` with `draftEmpty` → `insert` + `openPalette`;
`{input:'/mo', paste:true}` → insert only; `{input:'[<64;10;5M'}` → no actions). pty: the existing
`test/pty/smoke/commands-idle.steps` already sends `send /s` as one chunk and passes **only because** it never needed
the palette; after P9 it opens the palette, so that scenario's expectations must be re-pinned in the same commit.

**Perf gate.** one regex per keystroke on an empty draft only — inside 16 ms.

**Identity.** **chrome**.

### Landing order

P2 → P3 → P1 (P1 depends on the ghost union and the reset) → P4 → P5 → P9 → P6 → P7 → P8. P1–P4 are pure-module work
(`palette.ts`, `nav.ts`, `resolve.ts`) with the App call sites swapped in one commit; P6 needs the owner's ratification
of the provenance rule (it changes a §4.9 sentence, like round-3 F21).

---

## 5. Open questions for the owner

1. **Provenance-gated confirm (P6)** — is "typed in full = no confirm, selected from the palette = one `y`" the right
   split, or should `/new` and `/abort` confirm unconditionally? Unconditional is simpler to explain and to test, at
   the cost of one key for people who type `/new` deliberately.
2. **S-ONE's Enter accepts rather than runs.** The alternative (Enter runs when there is exactly one candidate) saves a
   keystroke on `/bud`+Enter but makes `/ne`+Enter end the session in one press without the command ever being visible
   in the draft. Recommendation: keep accept.
3. **S-PICKED** (the marker moved off an exact draft, E4) makes Enter change meaning after an arrow press. The
   alternative is "Enter always runs the draft, arrows only preview" — simpler, but then ↓ to `/model` + Enter runs
   `/mode`, which is the surprise we are trying to remove. Recommendation: keep S-PICKED with the explicit footer.
4. **Should Esc also clear a token-only draft?** It would remove the trap without P5(b)(c), at the cost of the
   documented "Esc keeps the draft / remembers the token" (Codex) rule.
5. **`--plain` numbered list (P7)** — is the one-shot `pendingList` acceptable, or should the numbers require a prefix
   (`#3`) so a bare integer is never ambiguous?
