# Round 4 · A3 — command output style, and the history-text rewrite D-M deferred

Measured 2026-09-21 against the **last committed tree** `ec61170` in a throw-away worktree
(`/tmp/jevcode-r4-a3`, `npm run -s build`, driven through `scripts/pty/drive.exp` with a temp
`JEVCODE_HOME` and a temp `--workspace` copy of `examples/demo-py`). The round-3 implementation in the
main checkout is **not** in these captures: every frame below is what the product ships today, so each
round-3 fix that already covers a finding is named as such and not re-proposed.

Captures (raw `.cap` + SGR-stripped `.txt`, kept under `/tmp/probe-a3/out/` during the session; every
quotation below is verbatim from them):

| id | geometry | argv | what it holds |
| --- | --- | --- | --- |
| `idle1` | 24×80 | `chat --mode jev-on --mock` | `/status /cost /jev /budget /mode /errors /plan /decisions /config /why /undo /diff /report /rewind /calibration` at idle |
| `idle2` | 24×80 | same | `/help /new /rename /model /provider /mode /llm /theme /copy /transcript /panel /logout /trust /resume` |
| `idle3` | 24×80 | same | `/budget <set>` ×4, `/budget`, `/bogus` and the draft cascade |
| `idle4` | 24×80 | same | `/steer` availability error and the draft cascade |
| `idle6` | 24×80 | same | `/why 9 /decisions 3 risk /copy diff /history clear /mode jev-off /undo 2 /diff 7 /export <denied> /rename <72 chars>` |
| `postrun` | 24×80 | `… --mock-steps 4` | a whole run, then `/status /cost /jev /decisions /plan /why /diff /diff 1 /undo /budget /errors /export /report` |
| `full` | 24×80 | `… --mock-steps 5` | `/transcript full` then a whole run — every stage line D-M defers |
| `live` | 24×80 | `… --mock-steps 300` | `/cost /status /jev /undo` **while the run is live**, plus the run's `transcript.log` |
| `plain1` | 24×80 | `chat --plain --mode jev-on --mock` | the `--plain` twin of the idle blocks |
| `w40` / `w120` | 24×40 / 40×120 | same | the same blocks at 40 and 120 columns |

---

## 1. What a command prints today — the complete catalogue

### 1.1 The one plumbing path

Every multi-row command output goes through **one** six-line helper (`src/cli/session.ts:1215`):

```ts
function block(head: string, lines: readonly string[], opts: {...} = {}): void {
  if (o.rendererKind === 'tui') { note(head, { ...opts, ...(lines.length > 0 ? { detail: lines.join('\n') } : {}) }); return; }
  note(head, opts);
  for (const l of lines) note(l, opts);
}
```

- In the **TUI** the body is one `detail` string on one item; `Transcript.tsx:127–131` renders it as
  `detail.map(d => <Text {...textProps(theme,'dim',color)}>{d}</Text>)` — **at column 0, always `dim`, one
  `<Text>` per source line, Ink's default word wrap**.
- In **`--plain`** each body line is its own item, so each one is printed `[ui] <line>` (`plain.ts:565`
  `formatTranscriptItem`).
- While a run is **live**, `note()` routes to `engine.annotate()` (`session.ts:1201–1213` → `engine.ts:993`),
  which emits a `notice ui` event — so the block **head** enters `transcript.log`, and the `detail` never does.

There are **17 `block()` call sites** in `session.ts` (`:1524, 2249, 2306, 2328, 2333, 2378, 2493, 2526, 2539,
2553, 2559, 2577, 2584, 2660, 2688, 2798, 2840, 3405, 3510`) and **4 App-local twins**
(`App.tsx:941 /help`, `:970 /why`, `:976 /decisions`, `:982 /plan`, plus `:1311/:1318/:1320` for `?` and Ctrl+O).

### 1.2 Per-command inventory (39 registry rows + the App-local pair)

`W` = does the body builder receive `columns`? `rows` / `widest` measured from `plain1` (source rows, before
any terminal wrap).

| # | command | implemented in | head today | body builder | W | rows | widest | empty state | error state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/help` | **two** formatters: `session.ts:954` (plain) and `palette.ts:302` (TUI, via `App.tsx:941`) | `help` (plain) / `keys` (TUI) | see §1.3 | plain **no**, TUI **yes** | 46 | **605** | — | — |
| 2 | `/new` | `session.ts:2690` | — | — | — | 0 | — | **prints nothing** (`idle2`) | — |
| 3 | `/resume` | `session.ts:2652` picker / `:2626` | `pickerHeader(…)` | `pickerRows` | yes | ≤ rows | ≤ cols | `noSessionMessage` | `/continue: <no session>` |
| 4 | `/rename` | `session.ts:2712` | `renamed the session to "…"` | — | — | 1 | ≤ 80 | — | silently cuts at 60 |
| 5 | `/steer` | `session.ts:2719` | — | — | — | 0/1 | — | — | `error: /steer needs a live run` |
| 6 | `/unsteer` | `:2724` | — | — | — | 0/1 | — | `/unsteer: nothing queued` | availability |
| 7 | `/pause` | `:2727` | — | — | — | 0 | — | — | availability |
| 8 | `/abort` | `:2730` | — | — | — | 0 | — | — | availability |
| 9 | `/undo` | `:2194` | `undo step N: restored …` (`apply.ts:340`) | — | — | 1 + warnings | ≤ 80 | `no finished run in this session yet` | see §2.6 |
| 10 | `/rewind` | `:2232` | `rewind · steps with changes` | `rewindPickerRows` | yes | ≤ 40 | ≤ cols | `no step of the last run changed files` | `/rewind: step N: <msg>` |
| 11 | `/diff` | `:2279` | `r.lines[0]` = `diffStatHeader` | `diffStatBlock` (`undo/diff.ts:263`) | **yes** | ≤ 42 | ≤ cols | — | `not a git repository; …` |
| 12 | `/diff <step>` | `:2305` | `diff step N -- <path>` | `diffStepLines` (`diff.ts:522`) | **no** (only `maxLines`) | ≤ 40 | unbounded | `(no changes)` / `(no content recorded)` | `expected a step none yet …` |
| 13 | `/plan` | `:2556` + `App.tsx:982` | `plan` | `planRows` (`pane/plan.ts:103`) | yes (terminal cols) | ≤ 40 | ≤ cols | `(no plan yet)` | — |
| 14 | `/decisions` | `:2547` + `App.tsx:976` | `decisions (last N)` — **N differs by renderer** | `decisionRows` (`pane/decisions.ts:104`) | yes | ≤ n | ≤ cols | `(no decisions yet)` | — |
| 15 | `/why` | `:2562` + `App.tsx:952` | `whyBlock[0]` | `whyBlock` (`why.ts:227`) | **no** | ≤ 24 | unbounded | — | two different texts (F8) |
| 16 | `/calibration` | `:2580` | `calibration  N runs  …` | `calibrationBlock` (`calibration.ts:333`) | **no** | 19 | unbounded | zeros + `—` | — |
| 17 | `/jev` | `:2496` | `jev` | inline literal, 3 rows | **no** | 3 | 58 | `decider —` | — |
| 18 | `/cost` | `:2462` | **`run $x of $y (n %)`** (a data row) | `costBlock` (`budget/lines.ts:322`) | **no** | ≤ 12 | 74 | `session $0.00 of $10.00 (0 %, 0 runs)` | — |
| 19 | `/budget` (show) | `:2372` | `budget` | inline, 2 + pending | **no** | 4 | 54 | `pending: none` | — |
| 20 | `/budget <set>` | `:2382–2436` | `budget: <setting> …` | — | — | 1 | ≤ 80 | — | `spendCapRaiseError` |
| 21 | `/model` | `:2763` | `model <id> pending (next run)` | — | — | 1 | — | no show form (F15) | — |
| 22 | `/provider` | `:2767` | `provider <p> pending (next run)` | — | — | 1 | — | — | — |
| 23 | `/mode` | `:2771` | `mode X (next run: X)` (F1) | — | — | 1 | ≤ 80 | — | — |
| 24 | `/llm` | → `/mode` | as `/mode` | — | — | 1 | — | — | — |
| 25 | `/config` | `:2795` | `config` | `configTableLines` (`config-table.ts:97`) | **no** | **42** | **182** | — | — |
| 26 | `/login` | `:2801` | wizard, then `LOGIN_SAVED_TOAST` | — | — | overlay | — | — | — |
| 27 | `/logout` | `:2602` | `[setup] [setup] <key>: not in <path>` (F16) | — | — | 2 | > 80 | — | — |
| 28 | `/trust` | `:2807` | `workspace trusted (trust)` | — | — | 1 | — | — | F17 |
| 29 | `/theme` | App-local only (`App.tsx:986`) | **prints nothing** | — | — | 0 | — | — | F4 |
| 30 | `/panel` | App-local; **no `case` in `execute()`** | **prints nothing in `--plain`** | — | — | 0 | — | — | F3 |
| 31 | `/transcript` | App pre-router | `transcript compact` | — | — | 1 | — | — | `not available in --plain (n/a)` |
| 32 | `/copy` | `App.tsx:1020` + `:2819` | toast only | — | — | 0 | — | `nothing to copy for <what>` | F7 |
| 33 | `/export` | `:2338` | `exported N run(s) to <abs path>` | — | — | 1 | > 80 | — | `is on the secret denylist` |
| 34 | `/status` | `:2534` | `status` | inline, 4 rows | **no** | 5 | **106** | `run — · session —` | — |
| 35 | `/errors` | `:2839` | `errors` | the kept item texts | — | 2+ | ≤ 600 | `(no warnings or errors yet)` | — |
| 36 | `/report` | `:2587` | `report written to <abs dir> (N files; …)` | — | — | 1 | > 80 | — | `no finished run in this session yet` |
| 37 | `/history clear` | `:2845` | `history cleared` | — | — | 0/1 | — | — | — |
| 38 | `/editor` | App-local `startEditor()`; `:2852` in plain | — | — | — | 0 | — | — | `the external editor is Ctrl+G …` |
| 39 | `/exit` | `:2855` | — | — | — | 0 | — | — | — |
| A | epilogue (`[ui] stopped — …`) | `epilogue.ts:75–82` | `stopped — <reason> (exit N)` | `epilogueRows`, `padEnd(10)` | **no** | 4 | > 80 | — | — |
| B | key-missing block | `:1524, 3405, 3510` | `no key found — …:` | `fixBlockLines()` | **no** | n | ≤ 80 | — | — |

**53 % of command-output rows overflow 80 cells.** Measured on `plain1` (the source rows, unwrapped):
`109` `[ui]` rows, `58` of them wider than 80 cells. Per block:

| block | rows | widest row (cells) | rows > 80 |
| --- | ---: | ---: | ---: |
| `/status` | 5 | 106 | 1 |
| `/cost` | 3 | 74 | 0 |
| `/jev` | 3 | 58 | 0 |
| `/budget` | 4 | 54 | 0 |
| `/config` | 42 | **182** | **39** |
| `/errors` | 2 | 32 | 0 |
| `/plan` | 2 | 18 | 0 |
| `/decisions` | 2 | 23 | 0 |
| `/help` | 46 | **605** | 18 |

### 1.3 Width-awareness of every body builder (the root cause)

| builder | signature | width? | measured consequence |
| --- | --- | --- | --- |
| `configTableLines` | `(record, {sandboxLevel})` `config-table.ts:97` | **no** — `w1 = max(value.length)` | 182-cell rows at any width (§2.1) |
| `costBlock` | `(CostBlockInput)` `budget/lines.ts:322` | **no** | fine at 80, wraps at 40 |
| `whyBlock` | `(d, ctx, g)` `why.ts:227` | **no** | wraps at 80 (§2.3) |
| `calibrationBlock` | `(stats, g)` `calibration.ts:333` | **no** | wraps at 80 and 40 |
| `diffStepLines` | `(step, files, {context,maxLines})` `diff.ts:522` | **no** | a long source line wraps |
| `epilogueRows` | `(ctx)` `epilogue.ts:75` | **no** | the `files` row breaks a path mid-token (§2.2) |
| `/status` `/jev` `/budget` rows | inline template literals | **no** | the `workspace` row is 106 cells |
| `helpLines` (session) | `(topic, {live,ascii})` `session.ts:954` | **no** | a 605-cell row |
| `helpLines` (palette) | `(columns, opts)` `palette.ts:302` | **yes** | correct |
| `decisionRows` / `planRows` | `(state, rows, columns, g)` | yes — but the **terminal** width | will overflow by 10 once round 3 indents detail rows |
| `diffStatBlock` | `(input, columns)` `diff.ts:263` | **yes** | the one well-behaved block |
| `pickerRows` / `rewindPickerRows` | `(…, columns)` | yes | correct |

---

## 2. Captured frames (verbatim), with the defect each one shows

### 2.1 `/config` at 24×80 — the worst block in the product (`idle1`)

```
[ui] config
setting                     value                                               
                            source
mode                        jev-on                                              
                            flag
generator.provider          openrouter                                          
                            default
…
decider.baseUrl             https://openrouter.ai/api/alpha/decisions           
                            default (openrouter)
workspace                   
/var/folders/d2/w3fk08kj7jsffgr3g25rcks00000gn/T/a3-ws-eO2WYu                   
flag
runsDir                     
/var/folders/d2/w3fk08kj7jsffgr3g25rcks00000gn/T/a3-home-L5tIsG/runs            
env
…
session.spendCapUsd         $10.000 (default: 5 × limits.spendCapUsd)           
                            derived
sandbox level: seatbelt (writes confined to the workspace and run dirs; harness 
secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed 
unless --no-network)
session.spendCapUsd effective $10.00
```

Every one of the 40 rows becomes **two or three** terminal rows; the `source` column is never on the same
row as its setting. At 24×40 (`w40`) it is three rows plus a blank per setting — 120 terminal rows for one
command. `config-table.ts:99–101` pads `value` to the longest value in the record, which is an absolute path.

**The blank row between the table and the sandbox footer is gone in the TUI** (`config-table.ts:104`
`lines.push('', SANDBOX_FOOTER[...])`): Ink measures `<Text>{''}</Text>` at height 0, so the separator the
formatter emits is dropped. The same block in `--plain` prints it as **`[ui] ` with a trailing space**
(`plain1.txt`).

### 2.2 The run epilogue and `/status` (`postrun`)

```
[run] end complete steps=4 wall=124ms cost=$0.001 (gen $0.000, jev $0.001) exit
      0
[ui] stopped — complete (exit 0)
run       20260922-035503-kntk2yw3
files     /var/folders/d2/w3fk08kj7jsffgr3g25rcks00000gn/T/a3-home-zPCnCM/runs/2
0260922-035503-kntk2yw3/  (transcript.log, state.json, jevcode.log)
resume    jevcode run --resume 20260922-035503-kntk2yw3
report    jevcode report 20260922-035503-kntk2yw3   (redacted bundle written 
locally; nothing is sent)

[ui] status
run 20260922-035503-kntk2yw3 · session 20260922-035503-kntk2yw3
step 4/40 · stage idle · phase none
sandbox seatbelt · workspace 
/var/folders/d2/w3fk08kj7jsffgr3g25rcks00000gn/T/a3-ws-zPCnCM · git none
stop complete (exit 0) · lock released · runs 1
```

- `exit` / `0` — the orphan-token wrap round 3 rule 3 fixes.
- the epilogue's `files` row splits a run id **mid-token** (`…/runs/2` ⏎ `0260922-…`).
- the epilogue's `report` row's continuation (`locally; nothing is sent`) lands at column 0, under the key
  column, so it reads as a new key.
- `/status` puts the absolute workspace path inline and the row breaks after `workspace ` — the path then
  occupies a full row on its own, and `· git none` is orphaned onto it.

### 2.3 `/why` at 24×80 (`postrun`) — a structured block destroyed by wrap

```
[ui] why s4.risk.plan_mismatch  request 5d2d5d35  0ms  
     typesafe/jev-1.13-20260917
  How far is `proposal.action` from `plan` and `intent`?
  score, 5 levels; alignment dimension → tail bound
  L0 █████████▌  0.95  matches `intent` and the plan
  L1 ▌·········  0.05  matches the plan, different order
  L2 ··········  0.00  skips a planned verification step
  L3 ··········  0.00  ignores the plan's open problems, or claims completion 
(`done`) while `plan.remaining` is non-empty
  L4 ··········  0.00  contradicts the plan, repeats a step `recent` shows 
already failed the same way (a blocked or declined proposal in `recent` never 
ran, so it is not a step that…
  argmax L0 p=0.95  E[k]=0.05→0.01  P(k≥3)=0.00  bound=tail  risk=0.00 [ok]
  confidence = 1 − Σ p_k·|k−k*| / U_5 = 1 − 0.05/1.2 = 0.96
```

`whyBlock` has no `columns` (`why.ts:227`), so the `L3`/`L4` rows wrap to column 0 and the bar column
collapses. `argmax L0 p=0.95  E[k]=0.05→0.01  P(k≥3)=0.00  bound=tail` is model-internal notation in a
user-facing row. Everything is drawn `dim` — the bars, the `[ok]` verdict and the prose share one colour.

### 2.4 `/diff <step>` (`postrun`) and the diff colour problem

```
[ui] diff step 1 -- scratch_0.py
(no pre-image: file was not copied; after 12 B)
```

`--` is a git artefact in a user-facing head; every other block uses ` · `. A real unified diff (the
`diffStepLines` path) is emitted as plain text and rendered **entirely in `dim`** by
`Transcript.tsx:127–131`: `+` and `-` rows, `@@` hunks and `---`/`+++` headers are all the same grey. That
is the single largest gap against the user's request 4 ("file edits … look the cleanest").

### 2.5 The draft cascade after an errored command (`idle3`, `idle4`)

```
[ui] error: unknown command /bogus; type / to list commands
[ui] error: /bogus/steer: "bogus/steer" is not a command name (letters, digits 
     and - only)
[ui] error: /bogus/steer: "bogus/steer" is not a command name (letters, digits 
     and - only)
…  (12 identical rows)
```

and

```
[ui] error: /steer needs a live run
[ui] error: /steer needs a live run
…  (14 identical rows)
```

One bad command leaves the draft in the composer; every following line appends to it. Round 3 F21 clears
the draft for availability errors (the second cascade) but deliberately **keeps** it for an unknown command
(the first). Two things survive round 3: the error text never names the **whole** line it rejected, and
there is no "did you mean" although `fuzzy.rank` (`fuzzy.ts:236`) is one call away.

### 2.6 Error texts with a hole in them (`idle6`)

```
[ui] error: /undo: expected a step none yet with changed files, got "2"
[ui] error: /diff: expected a step none yet with changed files, got "7"
[ui] error: /export: /nope/dir/x.log is on the secret denylist; JevCode never 
     writes there
[ui] renamed the session to 
     "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

`expected a step none yet with changed files` is the `step` argument validator's "expected <set>" phrase
with an empty set substituted; `/export` reports a path *outside* the workspace as a *secret denylist* hit;
`/rename` cuts at 60 with no notice (round 3 F13 adds one).

### 2.7 `--plain` is not the TUI's twin (`plain1` vs `idle1`)

| fact | TUI | `--plain` |
| --- | --- | --- |
| `/help` head | `[ui] keys` | `[ui] help` |
| `/help` body | `palette.helpLines(columns,…)` — packed, column-aligned, ≤ columns | `session.helpLines(topic,…)` — one `keys · <ctx>: …` row per context, up to **605 cells** |
| `/decisions` head with 0 decisions | `decisions (last 1)` (`App.tsx:976` counts *rendered lines*) | `decisions (last 0)` |
| block body rows | no label, column 0 | `[ui] ` prefix on every row |
| the blank separator row in `/config` | dropped (Ink height 0) | `[ui] ` (trailing space) |
| `/panel` | changes the panel | **prints nothing at all** (no `case` in `execute()`) |
| `/transcript` | `transcript compact` | `error: /transcript: not available in --plain (n/a)` |

### 2.8 The same block is not the same in `transcript.log` (`live`)

`/cost` issued **while the run is live**, 24×80. The TUI printed seven rows; `transcript.log` of that run
holds exactly one:

```
$ grep -n '\[ui\]' <home>/runs/<id>/transcript.log
21:[ui] run $0.000 of $2.000 (0 %)
30:[ui] status
34:[ui] jev
43:[ui] error: /undo runs when the run is idle; Esc pauses first
```

Because the TUI passes the body as `detail` (never logged) while `--plain` passes it as N separate
`annotate()` calls (each logged), the *same command in the same run* writes **1 row** to `transcript.log`
from the TUI and **7** from `--plain`. This is a measured violation of the standing identity rule, and the
logged row (`run $0.000 of $2.000 (0 %)`) does not even name the command that produced it.

### 2.9 The history — every stage line, 24×80 (`full`, `/transcript full`)

```
[you] fix the failing test
[run] start 20260922-040637-x4zqn5kw mode=jev-on task: fix the failing test
[run] ready 20260922-040637-x4zqn5kw step 0/40
[run] git none · not a git repository: changes made by commands are not 
      recoverable, /diff compares against step pre-images only
[step 1] intent=investigate p=0.80 c=0.76
[step 1] context 0 files 0B of 5 candidates: 
[step 1] proposal write scratch_0.py: Create scratch_0.py | plan done=0
         remaining=3 open=0
VALUE_0 = 0
[step 1] risk=0.01 ok: risk 0.01 (ok) from destructive: expected level 0.05 of 
         4; dominant level 0 "nothing existing is lost: reads, searches, lists, 
         or runs tests/builds; creates a file that did not exist 
         (`proposal.target.existsBefore` false); anything it changes the 
         workspace regenerates"; Jev confidence 0.96 | irreversible: expected 
         level 0.05 of 4; dominant level 0 "no lasting effect, or restorable 
         with one git command"; Jev confidence 0.96
[step 1] outcome executed: created scratch_0.py changed=1: scratch_0.py
[step 1] judge succeeded=0.90 error_present=0.10 new_info=0.10 tests=none 
         claims=0/0 completion=0.05
[step 1] plan done=0 remaining=3 unverified=0 problems=0
[step 1] write scratch_0.py "Create scratch_0.py" · risk 0.01 ok · 1 file · 
         judge 0.90 · 0.0s · $0.0002
…
[step 3] outcome executed: exit 0 (exit 0, 10ms) changed=1: scratch_0.py
…
[step 5] plan done=0 remaining=3 unverified=0 problems=3 rejected: "create the 
         scratch module"; "exercise it"; "verify with a command"
[step 5] done scratch work complete · risk 0.01 ok · skipped · 0.0s · $0.0002
[run] stop: complete at step 5
[run] end complete steps=5 wall=105ms cost=$0.001 (gen $0.000, jev $0.001) exit
      0
[ui] stopped — complete (exit 0)
```

Defects, in the order they appear:

| # | row | defect |
| --- | --- | --- |
| H1 | `[run] start <id> mode=jev-on task: …` | `mode=` is a machine token; the id leads before the task the human typed |
| H2 | `[run] ready <id> step 0/40` | restates the run id one row after `start`; `step 0/40` is the status row's job |
| H3 | `intent=investigate p=0.80 c=0.76` | three `k=v` pairs, no sentence |
| H4 | `context 0 files 0B of 5 candidates: ` | trailing `: ` with an empty list; `0B` has no space |
| H5 | `proposal write x.py: Create x.py \| plan done=0 remaining=3 open=0` | `\|` separator found nowhere else; four `k=v`; the goal duplicates the target |
| H6 | the raw action preview (`VALUE_0 = 0`, `--- old / +++ new`, `printf 'ok %s\n' 2`) | printed at column 0 as if it were a transcript row; TUI-only, so it is **absent** from `--plain` and `transcript.log` at the same position |
| H7 | `risk=0.01 ok: risk 0.01 (ok) from destructive: …` | **8 terminal rows for an `ok` verdict**; the number is printed twice; the text is `risk.ts:276–300`'s audit string, which also feeds `recent[i].reason` in the generator prompt |
| H8 | `outcome executed: exit 0 (exit 0, 10ms)` | `exit 0` twice |
| H9 | `outcome executed: read 1 file(s)` | `file(s)` |
| H10 | `judge succeeded=0.90 error_present=0.10 new_info=0.10 tests=none claims=0/0 completion=0.05` | six `k=v` pairs |
| H11 | `plan done=0 remaining=3 unverified=0 problems=0` | identical on every step; pure noise until it changes |
| H12 | the `[step N]` summary | already the good row (`plain.ts:464`), but it repeats `risk`, the outcome and `judge` that the four rows above just said |
| H13 | `[run] stop: complete at step 5` / `[run] end complete steps=5 …` / `[ui] stopped — complete (exit 0)` | **the same stop stated three times in three consecutive rows** (`stop.ts:56`, `plain.ts:400`, `epilogue.ts:68`) |
| H14 | `[run] end … exit` ⏎ `0` | orphan token (round 3 rule 3) |
| H15 | `[run] git none · not a git repository: …` | two clauses saying the same thing |

In **compact** (the default) only `[you]`, `[run] start`, `[run] git`, the `[step N]` rows, `[run] stop`,
`[run] end` and `[ui] stopped` are shown (`COMPACT_HIDDEN_KINDS`, `plain.ts:78`) — so H1, H2, H13, H14, H15
and H12 are what a normal user sees; H3–H11 are what `/transcript full`, `transcript.log`, `--plain` and
`jevcode report` always carry.

---

## 3. The COMMAND OUTPUT STYLE

One grammar, five row kinds, one width contract. Everything below is a **renderer/formatter** rule; the
text rules are §4.

### 3.1 The block frame

```
<blank row>
[ui] <head>                                    ← noun, sentence case, ≤ 40 cells, never a data row
     <row 1>                                   ← body rows start at the body column (10, round 3 rule 1)
     <row 2>
     …
     <footer>                                  ← dim, only when something was elided
<blank row>
```

- The blank row **above** is round 3 rule 9 (a `[ui]` item that carries a `detail`). Round 4 adds the blank
  row **below** the last body row, so two consecutive blocks never touch.
- A block is **always transcript rows**, never a card. The modal slot stays reserved for review, intake,
  the picker, the palette and the wizard (TUI-DESIGN §6, one modal slot). `/rewind` and `/resume` keep
  their overlays; their *fallback* (no prompter) stays a block.
- `head` may carry **one** right-hand meta field when it disambiguates the block: `cost · run 4 steps`,
  `diff · 3 files`, `decisions · last 12 of 83`. Never the run id (rule §4 "ids").

### 3.2 The width contract

```ts
export const LABEL_GUTTER = 10;                       // round 3 §5.1 rule 1, Transcript.tsx
export function blockWidth(columns: number): number { // the width every body builder is given
  return Math.max(28, Math.min(160, Math.floor(columns) - LABEL_GUTTER));
}
```

Every body builder takes `width = blockWidth(columns())` and **must** return rows of at most `width` cells.
Four breakpoints, all derived from `width` (so 40/60/80/120 columns give widths 30/50/70/110):

| width | tier | tables | kv rows | facts rows |
| --- | --- | --- | --- | --- |
| < 34 | **stacked** | one `key` row then the value indented 2 | key on its own dim row, value indented 2 | one segment per row, `· ` leading |
| 34–59 | **narrow** | 2 columns (drop the last), `… +N more` | `key(10) value`, value elided | segments packed, `· ` leading on continuations |
| 60–99 | **standard** | 3 columns | `key(10) value` | segments packed |
| ≥ 100 | **wide** | 3 columns + the extra column each builder declares (latency, evidence, source detail) | `key(10) value` | segments packed |

The `< 16 rows` flat tier and `--plain` use the same function; `--plain` on a pipe is `width = 80 - 10 = 70`
(`session.ts:1143` already falls back to 80).

### 3.3 The five row kinds

| kind | shape | example at width 70 | roles (≤ 3 per row) |
| --- | --- | --- | --- |
| **kv** | `key.padEnd(10)` + value | `session    $0.04 of $10.00 · 12 % · 3 runs` | `dim` key, default value, one accent on a meter word |
| **facts** | `a · b · c`, wrapped at ` · ` (round 3 rule 3) | `questions 83 · p50 0 ms · p95 2 ms · $0.001` | default, one accent |
| **table** | a dim header row, then aligned columns; numerics right-aligned | `bin        n  mean p  observed  bar` | `dim` header, default cells, one accent for the bar |
| **rule** | `╶──── <caption>` (`fenceRow`, `Transcript.tsx:88`, already implemented) | `╶──── pending` | `code` |
| **note / footer** | two leading spaces, `dim` | `  … +18 settings at their defaults (/config --all)` | `dim` |

A block mixes kinds freely but never changes the key column inside one block.

### 3.4 Numbers, units, ids (extends round 3 rule 6)

| quantity | format | source of truth |
| --- | --- | --- |
| money ≥ $0.001 | `$0.025` | `stepCostText` `plain.ts:423` |
| money < $0.001 | `$0.0002` | same |
| caps | `$2.00`, `$10.00` | `usd2` `budget/lines.ts:33` |
| per-unit money | `$0.000006` — **never** `9.9e-6` | round 3 rule 6 (`budget/lines.ts:341`) |
| percent | `12 %` (one space, no decimals) | `/cost` today; make it the only form |
| duration < 10 s | `4.9s` | `stepWallText` `plain.ts:429` |
| duration ≥ 10 s | `14s`, `1m02s`, `1h04m` | `formatDuration` `core/time.ts` |
| latency | `231 ms` (space, integer) | `/jev` today |
| bytes | `12 B`, `1.2 kB`, `4.0 MiB` | `formatBytes` `undo/diff.ts` |
| counts ≥ 10 000 | `12 480` (thin grouping) | `grouped` `budget/lines.ts:39` |
| probability / risk | `0.95` (two decimals) | `p2` `plain.ts:132` |
| token counts | `12.4k` | `kTokens` `plain.ts:139` |
| a run id | **only** in `[run] start`, the epilogue `run` row, and `/status`'s `run` row | round 3 rule 7 |
| a path | `shortPath()` — workspace-relative when inside, `~`-abbreviated, else left-elided `…/runs/2026…-kntk2yw3/` | new (§5 P8) |
| a missing value | `—` (em dash), never an empty cell, never `null` | today's `/jev` |

### 3.5 Truncation

| case | rule |
| --- | --- |
| a value longer than its column | prose elides **right** with `…`; a path elides **left** (`…/T/a3-ws/src/app.py`); an identifier is never elided (the row wraps instead) |
| a list | `a, b, c (+4)` — `LIST_MAX = 5` as `plain.ts:106` already does |
| rows beyond the cap | one dim footer `… +N more · <the command that shows them>` (today only `diffStatBlock:285` and `diffStepLines:551` do this) |
| a block beyond its own cap | the same footer; caps: `/config` 24 rows, `/help` 60 (`HELP_MAX_LINES`), `/decisions` n, `/plan` 40, `/diff` 42, `/why` 24 (`WHY_MAX_LINES`), `/calibration` 19, `/errors` 12 |

### 3.6 Colour roles inside a block (≤ 3 per row)

Round 3 rule 2 gives bodies the default role and takes `[ui]` out of `dim`. Round 4 extends it to the
**detail rows**, which today are unconditionally `dim` (`Transcript.tsx:129`):

| element | role |
| --- | --- |
| the block head | default (label `dim`) |
| a kv key, a table header, a footer, a `rule` caption | `dim` |
| a value, a fact, a table cell | default |
| a bar (`eighthBar`) | `accent2` |
| a verdict `[ok]` / `ok` | `ok`; `[review]` `warn`; `[block]` `error` |
| a diff `+` row | `ok`; a `-` row `error`; `@@` and `---`/`+++` `dim`; context rows default |
| a meter word `high` | `warn`; `critical`/`over` | `error` |
| a `pending:` row | `accent` |
| everything else | default |

A row never carries more than three distinct roles; a builder that would need a fourth drops the weakest.

### 3.7 Empty and error states (one table, one formatter)

Every empty state is a sentence in the body, never a head, and never a parenthesis-only fragment:

| block | today | round 4 |
| --- | --- | --- |
| `/decisions` | `(no decisions yet)` | `no decisions yet — they appear from the first step` |
| `/plan` | `(no plan yet)` | `no plan yet — Jev writes one at the first step` |
| `/errors` | `(no warnings or errors yet)` | `nothing to report — no warnings or errors this session` |
| `/budget` pending | `pending: none` | `nothing pending` |
| `/jev` before a run | `decider —` | `decider not resolved yet — the first question resolves it` |
| `/cost` before a run | `session $0.00 of $10.00 (0 %, 0 runs)` as the **head** | head `cost`, body row `no runs yet — the session has spent $0.00 of $10.00` |
| `/undo` no run | `error: /undo: no finished run in this session yet` | `nothing to undo — no run has finished in this session` (an **info** item, not an error) |
| `/undo` no changed step | `error: /undo: no step of the last run changed files` | `nothing to undo — the last run changed no files` |
| `/diff` no run | `error: /diff: no run in this session yet` | `nothing to diff — no run in this session yet` |
| `/report` no run | error | `nothing to report yet — a run has to finish first` |
| `/resume` no sessions | `noSessionMessage` | keep, plus `start one by typing a task` |
| `/history clear` | `history cleared` | `history cleared — 0 entries kept` |

Rule: **an empty state is never an error.** Only a *refused* or *malformed* request is
`[ui] error: …`. Errors keep a fixed shape:

```
error: /<command>: <what went wrong> — <what to do instead>
```

### 3.8 Frames of the new style

All frames are drawn with **round 3's 10-cell label gutter** (§5.1 rule 1): the label is right-aligned in
cells 0–8, every body row starts at column 10, so the body width at 80 columns is 70 and at 40 columns is 30.
Every row below was generated and width-checked (no row exceeds its terminal width).

**F-A1. `/status` after a run, 24×80** (kv rows, key column 10, `shortPath`, no wrap — the 106-cell row of §2.2 is gone):

```

     [ui] status
          run        20260922-035503-kntk2yw3 · complete (exit 0)
          session    20260922-035503-kntk2yw3 · 1 run · $0.001
          step       4 of 40 · idle
          workspace  ~/T/a3-ws-jC6j7y · no git repository
          sandbox    seatbelt · lock released

```

**F-A2. `/cost` after a run, 24×80** (noun head; no scientific notation; the last kv row wraps **under its
value column**, never to column 0):

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

**F-A3. `/config` at 24×80** (body width 70; `setting` 26 then the value; the **source is a dim
parenthetical and only on rows that are not at their default**, which is what makes three columns fit in 70
cells; rows at their default are folded behind the footer):

```

     [ui] config · 6 set, 34 at their defaults
          setting                     value
          mode                        jev-on  (flag)
          generator.model             z-ai/glm-5.3-flash
          decider.model               typesafe/jev-1.13-20260917
          limits.spendCapUsd          $2.000
          session.spendCapUsd         $10.000  (derived: 5 × limits.spendCapUsd)
          workspace                   ~/T/a3-ws-eO2WYu  (flag)
          runsDir                     …/a3-home-L5tIsG/runs  (env)
          … +34 settings at their defaults (/config --all)
          ╶──── sandbox
          seatbelt · writes only in the workspace and run dirs · secrets,
          ~/.ssh, ~/.aws unreadable · network on (--no-network)

```

At **≥ 100 columns** (body ≥ 90) the source gets its own aligned third column instead of the parenthetical.

**F-A4. `/config` at 24×40** (body width 30, *stacked* tier — the key on its own row, the value indented 2;
compare §2.1's three-rows-plus-a-blank per setting):

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

**F-A5. `/diff` after a run with changes, 24×80** (today's `diffStatBlock` grammar given the *body* width;
the `†` legend row folds into the head's meta):

```

     [ui] diff · 3 files · +42 −7 · 1 already dirty
          M  src/loop/engine.ts             +31 −4  ███████████▌
          A  tests/test_replan.py           +11 −0  ████
          D  scratch_0.py†                   +0 −3  ▌
          … +2 more files (/diff --all)

```

**F-A6. `/diff 1` with a real hunk, 24×80** — `+` rows `ok`, `-` rows `error`, `@@` and the file rule `dim`
(P3); the `---`/`+++` pair becomes one rule row:

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

**F-A7. an error, 24×80** (the fixed shape `error: /<command> — <what> — <what to do>`, wrapping under the
gutter):

```
     [ui] error: /undo 2 — step 2 changed no files; steps with
          changes: 1, 3
```

### 3.9 The `--plain` twin and the identity rule

Today a block is **not** identical across the three sinks (§2.7, §2.8). Round 4 makes the difference a
single declared normaliser instead of three accidents:

- the **rows** of a block are the same strings in all three sinks;
- the TUI prints them without a label under the head, `--plain` prints each with the item's label, and
  `transcript.log` gets them only when a run is live;
- the normaliser (for the identity tests) is: *drop the leading `[ui] ` of a `--plain` body row; drop the
  leading gutter spaces of a TUI body row; the remainder is equal, row for row, in the same order.*

Two mechanical changes make that true (§5 P11, P12): `block()` gains an explicit row list that both
renderers walk, and `engine.annotateBlock(head, rows, opts)` writes head **and** rows to `transcript.log`
from the TUI exactly as `--plain` does.

---

## 4. The history text (D-M): the rewrite

Every line below is the text of one `TranscriptItem`, produced by `itemsFromEvent` (`plain.ts:300–412`) or
by `stepSummaryText` (`plain.ts:464`). All three sinks change together because the formatter is shared.
Sentence case; no `k=v`; no `|`; ` · ` is the only inline separator; run ids only where §3.4 allows.

| item | today (`plain.ts`) | round 4 |
| --- | --- | --- |
| `run:start` | `:310` `start <id> mode=jev-on resumed from step N task: <task>` | `started · jev+llm · <task>` — and, when resumed, `started · jev+llm · resumed at step 7 · <task>`. The **id moves to the epilogue** and `/status`. |
| `run:ready` | `:312` `ready <id> step 0/40` | **deleted as an item** (kind stays for `--json`); the same facts are the status row and `/status`. Saves one row and one id per run. |
| `intent` | `:314` `intent=edit p=0.82 c=0.71` | `intent · edit · 0.82 (confidence 0.71)`; the fallback clause becomes ` · Jev answered none_of_these` |
| `context` | `:316` `context 5 files 12kB of 30 candidates: a, b …` | `context · 5 of 30 files · 12 kB · a.py, b.py, c.py (+2)`; with zero files `context · nothing to read of 30 candidates` (fixes H4) |
| `synth` | `:319` `synth rank: top candidate …` | `synth · rank · top candidate \`return 2\` · 12 candidates, 3 tested` |
| `proposal` | `:321` `proposal edit a.py: goal \| plan done=1 remaining=2 open=0` | `proposal · edit a.py · "<goal>"` — the plan counts move to the `plan` item, which already carries them (fixes H5, H11's duplication) |
| the proposal preview | `detail`, drawn at column 0 | stays TUI-only, but as a `rule` + indented body: `╶──── edit a.py` then the preview rows at the body column + 2 (fixes H6's "looks like a transcript row") |
| `risk` | `:327` `risk=0.01 ok: <the whole audit reason>` | **one row**: `risk 0.01 ok · destructive 0 · irreversible 0`; on `review`/`block`, the dominant dimension and its level text clipped to 80: `risk 0.62 review · destructive 2 "overwrites a tracked file" · /why s7.risk.destructive`. The audit string stays untouched in `Decision.reason`, `decisions.jsonl` and `recent[i].reason` (`risk.ts:276–300` is **not** edited) and becomes the item's TUI-only `detail` (fixes H7: 8 rows → 1) |
| `confirm:resolved` | `:329` `confirm c-2 declined (note: …)` | `review declined · "<note>"` — the confirm id is machine-only (it is in `decisions.jsonl`) |
| `outcome` | `:332` `outcome executed: <summary> (exit 0, 10ms) changed=1: a.py` | `done · <summary> · exit 0 · 10ms · 1 file (a.py)`; `read 1 file(s)` → `read 1 file` / `read 3 files` (fixes H8, H9) |
| `judge` | `:336` `judge succeeded=0.90 error_present=0.10 new_info=0.10 tests=none claims=0/0 completion=0.05` | `judge 0.90 · no tests · 0 of 0 claims accepted · complete 0.05`; with tests `judge 0.90 · tests 41p/0f/0e pass · 2 of 3 claims accepted · complete 0.62` (fixes H10) |
| `plan` | `:338` `plan done=0 remaining=3 unverified=0 problems=0` | emitted **only when a count changed since the last plan item** (the engine already carries the previous plan): `plan · 1 done · 2 remaining`; with rejections `plan · 1 done · 2 remaining · rejected "create the scratch module" (+2)` (fixes H11) |
| `loop:tripped` | `:345` `loop tripped: <signature> x3` | `loop · the same step repeated 3 times · <signature>` |
| `replan` | `:347` `replan change_approach p=0.61 c=0.50 impossible=0.12: <text>` | `replan · change approach · 0.61 (confidence 0.50) · "<text>"`; the `impossible` figure only when ≥ 0.50: ` · task impossible 0.62` |
| `transcript` (engine `warn`) | `:349` `warning: <text>` / `<text>` | unchanged shape; but the two duplicated git clauses collapse (`gitBannerLine`): `git · no repository — changes are not recoverable; /diff <step> compares pre-images` (fixes H15) |
| `retry:settled` | `retrySettledText` `:261` | `warning · jev retried 3 times over 41s — gave up` |
| `budget:*` | `budgetItems` | unchanged (already sentences) |
| `blocking:*` | `:277`/`:282` | unchanged |
| `secret-ack` | `:395` `sent 2 secrets to the generator on request` | unchanged |
| `pause:requested` | `:363` `pause requested: stopping after step 5` | `pausing · the run stops after step 5` |
| `steer:*` | `:356–362` | `steer queued (1) for step 8: <text>` → `steer queued · step 8 · "<text>" · 1 waiting` |
| the stop line | `stop.ts:56` `stop: complete at step 5` | **deleted** — `[run] end` says it (fixes H13, saves a row) |
| `run:end` | `:400` `end complete steps=5 wall=105ms cost=$0.001 (gen $0.000, jev $0.001) exit 0` | `finished · complete · 5 steps · 0.1s · $0.001 (generator $0.000 · jev $0.001) · exit 0` |
| the epilogue `[ui] stopped` | `epilogue.ts:68` | unchanged head; the rows become kv rows at key 10 with `shortPath()` (fixes the mid-path break) |
| `[step N]` summary | `:464` | unchanged **segment order** (`action · risk · outcome · tests · judge · wall · cost`, already the good row) — only the two items it duplicates are trimmed by this table, so compact reads as one row per step |
| `[sandbox]` | round 3 rule 13 already rewrites it | no change in round 4 |

**Segment order for a step, decided:** `action` first (what happened), then `risk`, then `outcome`, then
`tests`, `judge`, `wall`, `cost` — cost last so it is the token that wraps (round 3 rule 3 keeps the
` · ` break, so `· 4.9s · $0.006` moves as a unit).

**What a compact run reads like after the rewrite (24×80, the round-3 gutter):**

```

    [you] fix the failing test

    [run] started · jev+llm · fix the failing test
    [run] git · no repository — changes are not recoverable; /diff <step>
          compares pre-images
 [step 1] write scratch_0.py "Create scratch_0.py" · risk 0.01 ok · 1 file ·
          judge 0.90 · 0.0s · $0.0002
 [step 2] read scratch_0.py · risk 0.01 ok · judge 0.90 · 0.0s · $0.0002
 [step 3] run $ printf ok · risk 0.01 ok · 1 file · judge 0.90 · 0.0s · $0.0002
 [step 4] done scratch work complete · risk 0.01 ok · skipped · 0.0s · $0.0002

    [run] finished · complete · 4 steps · 0.1s · $0.001 (generator $0.000 · jev
          $0.001) · exit 0
     [ui] stopped — complete (exit 0)
          run       20260922-035503-kntk2yw3
          files     ~/.jevcode/runs/20260922-035503-kntk2yw3/
                    transcript.log · state.json · jevcode.log
          resume    jevcode run --resume 20260922-035503-kntk2yw3
          report    jevcode report 20260922-035503-kntk2yw3
                    a redacted bundle is written locally; nothing is sent

```

Counted against the `postrun` capture row for row (both at 24×80, blank spacers excluded): **18 terminal
rows instead of 20**; the stop is stated **once** instead of three times (`[run] stop:` / `[run] end` /
`[ui] stopped`); the run id appears in the epilogue and nowhere else in the run frame (it was in
`[run] start` too); no `k=v` and no `|` survive; and the two rows that used to break mid-token
(`exit` / `0`, and the `files` path split inside the run id) now break at a separator.

---

## 5. Proposals

Each one states: **what** · **where** · **edge cases** · **tests** · **perf gate** · **identity**.
Identity classes: **L** = local `[ui]`/`[setup]`/`[config]` item text (TUI + `--plain`, never
`transcript.log`); **E** = engine item text (all three sinks); **C** = colour / layout / wrap only (no text
changes anywhere).

### P1 — One block API with a width contract (`BlockRow[]`, `blockWidth(columns)`)

**What.** Replace `block(head, string[])` with `block(head, rows: BlockRow[], opts)` where

```ts
export type BlockRow =
  | { kind: 'kv'; key: string; value: string; role?: ColorRole }
  | { kind: 'facts'; segments: string[]; role?: ColorRole }
  | { kind: 'table'; cells: string[]; header?: true; align?: ('l' | 'r')[] }
  | { kind: 'rule'; caption?: string }
  | { kind: 'note'; text: string }
  | { kind: 'gap' };
export const LABEL_GUTTER = 10;
export function blockWidth(columns: number): number;      // §3.2
export function renderBlock(rows: readonly BlockRow[], width: number, g: GlyphSet): { text: string; role: ColorRole }[];
```

`renderBlock` is pure, does the column arithmetic of §3.2–§3.3, the ` · ` / hanging-indent wrap of §3.3 and
the truncation of §3.5, and returns **pre-split rows** — one `<Text>` per row, which also removes Ink's
trailing-space artefact (round 3 rule 3 already does this for item bodies via `transcript/wrap.ts`; this is
the same function applied to detail rows).

**Where.** New `src/tui/block/lines.ts` (pure, no ink) + `src/tui/block/render.ts` consumed by
`Transcript.tsx`. Call sites: `session.ts:1215` (`block`), the 17 `block(...)` sites listed in §1.1, and
`App.tsx:941/970/976/982/1311/1318/1320`. `TranscriptItem` gains
`detailRows?: readonly { text: string; role: ColorRole }[]` beside today's `detail: string` (the string
stays, so `--plain`, `--json` and `clipDetail` are unchanged).

**Edge cases (enumerated).** (1) `columns` unknown / 0 → `blockWidth` floors at 28. (2) `columns` = 640
(the `twins.pty.test.ts:98` identity run) → ceiling 160, so a block never becomes a 630-cell row. (3) a key
longer than 10 → the value moves to the next row indented 2, the key keeps its own row. (4) a value with a
zero-width or wide (CJK/emoji) grapheme → all arithmetic through `glyphs.ts` `cellWidth`/`padEndCells`
(never `String.length`). (5) a value containing `\n` or a control byte → `oneLine`/`sanitizeStream` as
today. (6) a row that is exactly `width` → no wrap, no trailing space. (7) `rows.length === 0` → the head
alone, no gap rows. (8) `--ascii` → ` - ` for ` · `, `-` for the rule, per `glyphs.ts:159,168`. (9) screen
reader (`g.mode === 'sr'`) → tables drop bars and emit `aria`-style cells as the pane builders already do.
(10) `NO_COLOR` / depth 1 → `role` is ignored by `textProps`, rows unchanged. (11) a resize between the
command and the next frame → `<Static>` rows are already committed at the old width; that is today's
behaviour for every item and stays (the block is scrollback).

**Tests.** unit `test/unit/tui/block/lines.test.ts`: the five row kinds at widths 28/30/50/70/110/160; the
`< 34` stacked tier; wide-grapheme padding; the exact frames F-A1…F-A7 read back from **this document** with
the `frameFKRows()` pattern (`palette.test.ts:24–35`) so the doc and the renderer cannot drift. unit
`round4-transcript.test.tsx`: an item with `detailRows` renders one `<Text>` per row at the body column.
pty `commands-width.steps` at 24×40, 24×80, 40×120: `/status /cost /jev /budget /config /diff` — **no
scrollback row of a block exceeds the terminal width** (assert on the frame's static rows, which
`helpers.ts` already extracts).

**Perf gate.** Not on the first-frame path (a block is only built inside a command handler). Composer
keystroke → frame p95 < 16 ms is untouched (no work per key). While live, a block is built once per
command: add a unit bench asserting `renderBlock` of the largest block (`/config`, 42 rows) at 200 columns
is **< 2 ms**, so a command during a run cannot breach the render-lag p95 < 5 ms budget.

**Identity: C** (layout/wrap/colour) for everything except the head-noun changes, which are carried by P5.

---

### P2 — `/config` becomes a real table (the single worst block)

**What.** `configTableLines(record, { sandboxLevel, width, all })`:

- three columns sized to `width`: `setting` = `min(28, longest setting)`, `source` = `min(20, longest
  source)`, `value` = the remainder (min 12); a `derived (…)` / `default (openrouter)` suffix that does not
  fit moves to its own indented `note` row (F-A3);
- values elided by §3.5 (paths **left**, prose right);
- rows whose source is `default` **and** whose value equals the default are folded behind
  `… +N settings at their defaults (/config --all)`; `--all` (a new `FlagSpec` on the `/config` row) shows
  them. Today's 40-row dump becomes ~8 rows in a normal session;
- the head carries the meta `config · 6 set, 34 at their defaults`;
- the sandbox footer becomes `{kind:'rule',caption:'sandbox'}` + the round-3 rule-13 sentence as a `facts`
  row (so it wraps at ` · `);
- the `session.spendCapUsd effective …` row appended at `session.ts:2798` becomes a kv row inside the table.

**Where.** `src/cli/config-table.ts:97–105` (signature + body), `src/cli/session.ts:2795–2799`,
`src/cli/main.tsx` `commandConfig` (the `jevcode config` CLI twin — same function, `width = 80` on a pipe),
`src/tui/commands/registry.ts` (the `--all` flag + `docs/COMMANDS.md` regeneration).

**Edge cases.** (1) an empty record → the header row + `no settings resolved yet`. (2) a value that is a
masked secret (`<dotenv:/x/.env> (sha256:3f9a2c1d)`) → never elided in the middle of the fingerprint; elide
the source path instead. (3) an `.ignored` row → stays directly under its effective row (today's
`configTableRows` ordering is kept) and is **never** folded away. (4) `--all` with 60 rows at 24 rows of
terminal → the block is scrollback, so it simply scrolls; the 24-row cap does not apply to `<Static>`. (5)
`width < 34` → the stacked tier of F-A4. (6) a setting name longer than 28 (none today, but a future one) →
the name keeps its own row. (7) `jevcode config --json` untouched.

**Tests.** unit `config-table.test.ts`: replace `:54` ("aligns the columns under a header") with three
width cases (40/80/120) asserting **every row ≤ width**; keep `:25/:40/:76/:91/:109/:123` (they assert
content, not padding) but update the expected strings for the new column widths; new: the fold count, the
`--all` expansion, the left-elided path, the derived-suffix note row. unit `session.test.ts:557` (`/config`
detail contains `limits.spendCapUsd`) still passes. pty `commands-idle.steps`: `/config` at 24×40 produces
**no** row wider than 40.

**Perf gate.** `renderBlock` bench < 2 ms (P1). No first-frame impact.

**Identity: L** — `/config` is a local `[ui]` item (`session.ts:2798` → `note`), never in `transcript.log`
when idle. Both renderers print the same rows through the same function; the `jevcode config` CLI twin
changes with it. **No `--plain`/TUI divergence is introduced** because both call `configTableLines`.

---

### P3 — Detail rows get roles (the diff, the bars, the verdicts stop being grey)

**What.** `Transcript.tsx:127–131` renders every detail row `dim`. Give each rendered row a role, from
`BlockRow.role` when the block builder set one (P1) and otherwise from a pure classifier
`detailRole(text): ColorRole | null` for the rows that arrive as raw strings (`/why`, `/plan`,
`/decisions`, `/calibration`, `/diff`): `+…` → `ok`, `-…` → `error`, `@@`/`---`/`+++` → `dim`, `[ok]`→`ok`,
`[review]`→`warn`, `[block]`→`error`, `[!]`→`warn`, a header row (`/^\S+ {2,}\S/` first row of a table) →
`dim`, everything else → default. Cap: **≤ 3 roles per rendered row** (§3.6).

**Where.** `src/tui/Transcript.tsx:127–131`, new `detailRole` in `src/tui/block/lines.ts`,
`src/tui/theme.ts` (no new roles needed — `ok`, `warn`, `error`, `accent2`, `code`, `dim` all exist).

**Edge cases.** (1) `NO_COLOR` / `--plain` / depth 1 → `textProps` already collapses roles; the rows are
byte-identical. (2) a diff line that starts with `+` but is prose (`+ the fix`) inside a `/why` block → the
classifier only runs on rows of blocks that declare `syntax: 'diff'` (a `BlockRow` flag), never globally.
(3) `--ascii` → unaffected (colour only). (4) daltonized / ansi themes → the roles already have twins
(`theme.ts:136–161`). (5) a reduced-motion or screen-reader session → colour is orthogonal.

**Tests.** unit `round4-transcript.test.tsx`: a `/diff` block renders `+` rows in `ok` and `-` rows in
`error`; the same block under `NO_COLOR` renders the same text with no SGR. unit `detailRole` table test
(12 inputs). pty: none needed (colour is asserted in unit).

**Perf gate.** One extra pure call per detail row at commit time; `<Static>` writes each row once. Assert
in the existing `render-lag` gate that a `/diff` during a live run does not move lag p95 above 5 ms.

**Identity: C.**

---

### P4 — A blank row inside a block must survive (and not print as `[ui] `)

**What.** Ink measures `<Text>{''}</Text>` at height 0, so `config-table.ts:104`'s separator is **dropped in
the TUI** while `--plain` prints `[ui] ` with a trailing space (§2.1). Introduce
`{kind:'gap'}` (P1), rendered as a `<Box height={1}/>` in the TUI and as a bare empty line (no label, no
trailing space) in `--plain`; `formatTranscriptItem` never produces a label-only row.

**Where.** `src/tui/Transcript.tsx` (the detail map), `src/tui/plain.ts` (`renderer.note` for a gap row),
`src/cli/config-table.ts:104` (`''` → the gap row), and the generic `block()`.

**Edge cases.** (1) a gap as the first or last row of a block → dropped (the block already has its own
blanks above and below, §3.1). (2) two consecutive gaps → collapsed to one. (3) `--json` → a gap emits no
`ui` line. (4) `transcript.log` → a gap is never written (it carries no information).

**Tests.** unit `plain.test.ts`: a block with a gap prints `''`, not `'[ui] '`. unit
`round4-transcript.test.tsx`: the rendered frame has a blank row between the table and the footer. pty
`commands-idle.steps`: the `/config` frame contains a blank row before `sandbox`.

**Identity: C** for the TUI; **L** for `--plain` (a `[ui] ` row with a trailing space disappears — update
any test that counts `[ui]` rows of `/config`: `session.test.ts:557` counts none, so nothing breaks).

---

### P5 — `/status` `/cost` `/jev` `/budget` become kv blocks with noun heads

**What.** Frames F-A1, F-A2. Concretely:

- `/cost` head `cost` (round 3 rule 5 already requires this; round 4 gives the body the kv shape and the
  `raise it` row a key); `~$9.9e-6 each` → `$0.000006 each` (round 3 rule 6).
- `/status` rows become `run`, `session`, `step`, `workspace`, `sandbox` with `shortPath()` (P6) — the
  106-cell row disappears.
- `/jev` rows become `decider`, `latency`, `cost`, `intake`; the empty state is §3.7's sentence, not `—`.
- `/budget` show: `run`, `session`, then a `rule` caption `pending` and one kv row per pending value —
  today's `pending: <setting> <value> (next /resume or run)` repeats the parenthetical on every row; the
  caption carries it once (`pending · next /resume or run`).
- `/budget <set>` echo and the `/budget` show rows use the **same** key and order (today they differ:
  `budget: spend-cap 3.00 pending (next …)` vs `pending: spend-cap 3.00 (next …)`, `idle3`).
- `(1 runs)` → `1 run` — a real pluralisation bug at `session.ts:2376` (`costBlock:330` gets it right).

**Where.** `session.ts:2372–2380` (`/budget`), `:2462–2494` (`/cost`), `:2496–2532` (`/jev`),
`:2534–2545` (`/status`), `src/tui/budget/lines.ts:322–352` (`costBlock` gains `width`), `:341` (the
exponential), `:245` (`pendingBudgetLine`).

**Edge cases.** (1) no run yet → §3.7 sentences, never `—` alone. (2) an uncapped session
(`Number.POSITIVE_INFINITY`) → `session $0.04 · no cap` (today `budgetPct` returns null and the text reads
`uncapped`, keep the word). (3) `--allow-unpriced` → `$?` as today, and the `per step` row is omitted
rather than showing `$?` three times. (4) a 60-char `/rename` title in `/status`'s `session` row → elided
right at the column. (5) `runs = 1` → `1 run`. (6) a run id of 24 chars at width 30 (stacked tier) → the id
gets its own row, never elided. (7) `/cost` while live → the run row uses `lastStatus.spend` as today.

**Tests.** unit `session.test.ts:540–570`: update `/cost`'s head pin (`/^run \$0\.115 of \$0\.250/` →
`'cost'` + a `detail` containing `run        $0.115 of $0.25`), `/jev`'s and `/status`'s detail pins; add
the `1 run` pin and the uncapped case. unit `budget/lines.test.ts`: `$0.000006 each`; `costBlock` at widths
30/70/110. pty `round2.pty.test.ts:312–318` — `expect chat \$` still matches; `expect intake: 1 message`
becomes `expect intake +1 message` (the kv key is padded).

**Perf gate.** P1's 2 ms bench.

**Identity: L** (all four are local `[ui]` items). While a run is live they also reach `transcript.log`
through `annotate` — P11 makes that consistent; until then note in the commit that the logged row changes
from `run $0.001 of $2.000 (0 %)` to `cost`.

---

### P6 — `shortPath()` everywhere a path is printed

**What.** One pure function used by `/status`, `/config`, `/export`, `/report`, the epilogue, `/diff`,
`[sandbox]` and every error that names a file:

```ts
shortPath(abs: string, o: { root: string; home?: string; width: number }): string
```
workspace-relative when inside `root` (`src/app.py`), `~`-abbreviated when inside `$HOME`, otherwise
left-elided to `width` keeping the last two segments (`…/runs/20260922-035503-kntk2yw3/`). Never breaks a
run id: if the last segment alone exceeds `width`, the row wraps instead of eliding (§3.5).

**Where.** New in `src/core/text.ts` (already holds `clip`/`firstLine`); consumers `session.ts:2543`
(`/status`), `:2362` (`/export`), `:2595` (`/report`), `config-table.ts`, `epilogue.ts:77`
(`abbreviateDir` becomes a thin wrapper), `undo/diff.ts` heads.

**Edge cases.** (1) `root === home` → `~` wins. (2) a path with a `~` in a real directory name → only a
literal `$HOME` prefix is substituted (today's `abbreviateDir` rule). (3) a relative path handed in → returned
unchanged. (4) a UNC / Windows path → no substitution (out of scope, Node 22 on macOS/Linux). (5) a path
containing wide graphemes → cell arithmetic. (6) a denied/secret path → still passes `redact` first.

**Tests.** unit `core/text.test.ts` (12 cases). unit `epilogue.test.ts`: the `files` row at width 70 keeps
the run id intact. pty: the `postrun` epilogue frame has no mid-token break.

**Identity: L + E.** `/status` `/export` `/report` are **L**. The epilogue's rows are **L** (the `[ui]
stopped` item is renderer-local, `epilogue.ts:88`). `[sandbox]` is **L** (round 3 rule 13). No engine item
prints a path today except `workspace`/`instructions` (`plain.ts:384–392`), which becomes **E** — listed in
P13's table.

---

### P7 — Give every remaining body builder its width

**What.** Add a `width` parameter (defaulting to 70 so no caller breaks) to `whyBlock`,
`calibrationBlock`, `diffStepLines`, `epilogueRows`, `costBlock`, and change the call sites to pass
`blockWidth(columns())`. Change `decisionRows`/`planRows` call sites from `columns()` to
`blockWidth(columns())` — **required by round 3 rule 4**, which moves detail rows to column 10 and would
otherwise make every pane-derived block overflow by exactly 10 cells.

**Where.** `src/tui/why.ts:227`, `src/tui/calibration.ts:333`, `src/undo/diff.ts:522`,
`src/cli/epilogue.ts:75`, `src/tui/budget/lines.ts:322`; call sites `session.ts:2306, 2493, 2553, 2559,
2577, 2584` and `App.tsx:970, 976, 982, 1318`.

**Edge cases.** (1) `/why`'s `L3`/`L4` level texts are long prose → wrap with a hanging indent under the
probability column, never to column 0 (F-A frames). (2) `/calibration`'s bin table at width 30 → drop the
`bar` column first, then `observed`. (3) a `/diff <step>` source line longer than the width → **never
wrapped** (a wrapped diff line is a lie); elide right with `…` and add the footer `… lines elided
(/diff --full)`. (4) `/why`'s `argmax …` row is model notation — P13 covers the wording; the width change
alone must not reflow it into nonsense. (5) `epilogueRows` is also used on **stderr** by
`epilogueLines` (`epilogue.ts:88`) where there is no TUI gutter — width there is `columns - 2` for the
two-space indent.

**Tests.** unit `why.test.ts` / `pane/why.test.ts`: the existing pinned rows (`why.test.ts:107`,
`pane/why.test.ts:22,32,35`) keep their text at the default width; new cases at 30 and 110. unit
`calibration.test.ts`, `undo/diff.test.ts`, `epilogue.test.ts` likewise. pty `commands-width.steps` (P1).

**Identity: C** (wrapping only) for `/why`, `/calibration`, `/decisions`, `/plan`; **L** for the epilogue
rows if the elision changes their text (it does for long paths — covered by P6's test list).

---

### P8 — `/diff` and file edits: heads, colour, and a hunk that reads

**What.** F-A5, F-A6. (a) head `diff · 3 files · +42 −7` / `diff · step 1 · scratch_0.py` (the `--`
separator goes). (b) `syntax: 'diff'` on the rows so P3 colours them. (c) a `rule` row per file
(`╶──── a/x → b/x`) instead of the raw `---`/`+++` pair. (d) the `(no pre-image: …)` / `(no changes)` /
`(no content recorded)` states become §3.7 sentences. (e) `diffStatBlock`'s `†` legend row moves into the
head's meta (`· 1 file was already dirty`).

**Where.** `src/undo/diff.ts:263–287` (`diffStatBlock`), `:522–556` (`diffStepLines`),
`src/cli/session.ts:2279–2336`.

**Edge cases.** (1) a binary file → `Binary · before 1.2 kB · after 1.4 kB`. (2) a file > 1 MiB → sizes
only, as today. (3) a rename → `from → to` with the arrow, left-elided on the **left** side first. (4) a
deleted file → `/dev/null` becomes the word `(deleted)`. (5) `--full` with no pager → the inline block
keeps the `… +N more lines` footer. (6) a diff containing an escape sequence → `sanitizeStream` as today.
(7) a diff of a secret-denylisted path → listed, never diffed (today's `isDenied`). (8) `--ascii` → the
rule glyph twin, `->` for `→`.

**Tests.** unit `undo/diff.test.ts`: the new heads, the rule rows, the empty states, widths 30/70/110.
unit `round4-transcript.test.tsx`: `+`/`-` roles. pty `commands-diff.steps` in a temp **git** workspace
(today's smoke workspaces are not repos, which is why `/diff` at `postrun` only showed the error path —
add `git init` to the scenario).

**Identity: L** (the `/diff` block is a local item).

---

### P9 — Empty states are not errors; error texts get one shape

**What.** §3.7's table, plus the error shape `error: /<command>: <what> — <what to do>`. Specific rewrites
measured in `idle6`:

| today | round 4 |
| --- | --- |
| `error: /undo: expected a step none yet with changed files, got "2"` | `error: /undo 2 — no run has finished in this session yet` (no run) / `error: /undo 2 — step 2 changed no files; steps with changes: 1, 3` |
| `error: /diff: expected a step none yet with changed files, got "7"` | same shape |
| `error: /export: /nope/dir/x.log is on the secret denylist; JevCode never writes there` | `error: /export — /nope/dir/x.log is outside the workspace; pass a path inside ~/T/a3-ws or omit it` (keep the denylist wording only for a real denylist hit) |
| `error: /why: no decision 9 in the last 3 steps` (App) / `error: /why: no decision matches 9` (host) | one text from `whyErrorText` (round 3 F8) |
| `error: /steer needs a live run` | `error: /steer — needs a live run; type the text and press Enter once one is running` |

**Where.** the `step`/`path` argument validators in `src/tui/commands/parse.ts` and
`src/tui/commands/dispatch.ts` (the "expected <set>" phrase), `session.ts:2194–2206, 2279–2288, 2338–2370`,
`src/tui/why.ts` (round 3 F8's `whyErrorText`), `session.ts:1224` (`uiError` gains the ` — ` clause).

**Edge cases.** (1) the "steps with changes" list longer than 5 → `1, 3, 5, 7, 9 (+4)`. (2) no steps at all
→ the no-run sentence, not an empty list. (3) a path error must pass `redact` (it may contain a token).
(4) an empty state raised **while live** becomes an engine `notice` — keep it level `info` so it is not
coloured red in `transcript.log` consumers. (5) `--plain` prints the identical sentence.

**Tests.** unit `session.test.ts` (`/undo`, `/diff`, `/export` error texts), `dispatch.test.ts` (the
validator phrase), `why.test.ts` (one text). pty `commands-idle.steps` asserting `nothing to undo` is
**not** prefixed `error:`.

**Identity: L** (every one of these is a local item; while live they ride `annotate` and become **E** —
P11).

---

### P10 — "Did you mean" and the whole rejected line

**What.** `unknown command /bogus; type / to list commands` becomes
`error: /bogus — not a command. Did you mean /budget? · type / to list commands`, using
`rank(token, commandNames())` (`fuzzy.ts:236`) and showing the top match when its score ≥ the word-prefix
band (700). The tokeniser error quotes the **whole** line, not just the first token, so the `/bogus/steer`
cascade of §2.5 is legible on the first repeat.

**Where.** `src/tui/commands/dispatch.ts` (the unknown-command and tokeniser branches),
`src/tui/commands/fuzzy.ts` (no change, reused).

**Edge cases.** (1) no match above the band → no suggestion clause. (2) the token *is* a valid alias → never
reached (round 3 rule 1). (3) a 600-char pasted line → the quoted line is clipped at 80 with `…`. (4) the
suggestion must not be an idle-only command while live (prefer the best *available* match, fall back to the
best overall with the availability note). (5) `rank` over 37 names + 21 aliases is O(58) — inside the
composer p95 budget.

**Tests.** unit `dispatch.test.ts` (`/bogus` → `/budget`; `/xyzzy` → no clause; availability preference).
pty `commands-idle.steps`.

**Perf gate.** composer keystroke p95 < 16 ms — `rank` runs on Enter, not per key.

**Identity: L.**

---

### P11 — A block is the same in the TUI, `--plain` and `transcript.log`

**What.** Today (§2.8) the TUI logs 1 row and `--plain` logs 7 for the same `/cost` during a run. Add

```ts
// Engine (contract 1.4, additive)
annotateBlock(head: string, rows: readonly string[], opts?: {...}): boolean;
```

which emits **one `notice ui` per row** (head first), exactly as `--plain`'s loop does, so all three sinks
carry the same rows in the same order. `session.ts`'s `block()` calls `annotateBlock` when live and falls
back to per-row local items when idle. The TUI keeps rendering the rows as one item's `detailRows` by
grouping the consecutive `ui` notices of one block (a `blockId` field on the notice, or — simpler — the
TUI keeps building its own item and the engine call is log-only).

**Where.** `src/core/types.ts` (the `Engine` interface), `src/loop/engine.ts:993` (beside `annotate`),
`src/cli/session.ts:1215`, `docs/TUI-DESIGN-3.md §6` contract list (an additive item).

**Edge cases.** (1) the run finishes between the head and the last row → `annotateBlock` is one `emit`
loop inside the engine, so it is atomic with respect to `isFinished()`. (2) a 42-row `/config` during a run
→ cap the logged rows at `BLOCK_LOG_MAX = 24` with a final `… +N more rows` (transcript.log is a
support artefact, not a mirror of the pager). (3) `--json` gets N `ui` lines instead of 1 — declare it in
`docs/COMMANDS.md`; `jevcode report` (`src/cli/report.ts`) and the bench readers only grep `[run]`/`[step`
prefixes, so they are unaffected (verified: `report.test.ts:41` uses `[run] start R1 …` only). (4) an
idle block still writes nothing to `transcript.log` — that is the documented rule and stays.

**Tests.** unit `plain.test.ts` (the `annotateBlock` items), `engine-core.test.ts` (atomicity), and a new
identity test: run the same command in both renderers against the same fake engine and assert the
normaliser of §3.9 holds row for row. pty `twins.pty.test.ts` gains a `/cost`-while-live case comparing
`transcript.log` from a TUI run and a `--plain` run.

**Perf gate.** N `emit` calls instead of 1 per command, only while live and only on a command; assert in
`render-lag` that `/config` during a run keeps lag p95 < 5 ms (42 emits ≈ 42 appends to an in-memory array
plus one buffered file write).

**Identity: E** — the block rows enter `transcript.log`. This is the one proposal that changes what a
`transcript.log` consumer sees; §6 lists every consumer checked.

---

### P12 — The declared `--plain` normaliser, written down

**What.** Put §3.9's normaliser in `docs/TUI.md` and implement it once as
`normaliseBlockRows(rows: string[]): string[]` in the test helpers, replacing the ad-hoc comparisons in
`twins.pty.test.ts:98–130`. Without it, P1/P4 would have no executable definition of "the same".

**Where.** `docs/TUI.md` (the identity section), `test/pty/helpers.ts`, `test/unit/tui/helpers.ts`.

**Edge cases.** (1) a gap row (P4) → dropped by the normaliser on both sides. (2) a TUI row wrapped by
`renderBlock` → the normaliser joins continuation rows exactly as round 3 §5.3's item normaliser does
(strip the gutter, join with one space, collapse spaces). (3) `--ascii` → compare within one glyph set.

**Tests.** the normaliser's own unit test with the F-A frames; every identity test re-expressed through it.

**Identity: C** (a test-only definition).

---

### P13 — The history rewrite (D-M), with every pin

**What.** §4's table, landed as **one commit per item group** so each moves its own pins:

| group | items | file:line |
| --- | --- | --- |
| G1 run frame | `run:start`, `run:ready` (deleted), `run:end`, the `stop:` line (deleted) | `plain.ts:310, 312, 400`; `loop/stop.ts:56`; `loop/engine.ts:2976` |
| G2 stages | `intent`, `context`, `proposal`, `judge`, `plan` | `plain.ts:314, 316, 321, 336, 338` |
| G3 risk | the one-row risk item + the audit string as `detail` | `plain.ts:327` (the **reason itself**, `risk.ts:276–300`, is not touched) |
| G4 outcome | `outcome executed/noop/blocked/declined/failed/interrupted` | `plain.ts:196–214` (`outcomeText`) |
| G5 control | `replan`, `loop:tripped`, `pause:requested`, `steer:*`, `retry:settled` | `plain.ts:345, 347, 363, 356–362, 261` |
| G6 workspace | the git banner's duplicated clause | `workspace/gitstate.ts` `gitBannerLine` |

**Edge cases.** (1) `run:ready` stays an **event** (the `--json` stream and `useEngine` read it); only its
*item* disappears — `itemsFromEvent` returns `[]`. (2) resumed runs: `run:start` must still say `resumed at
step N` (`engine-core.test.ts:148` pins it). (3) `interruptedAt` steps keep today's `interrupted at <stage>
(<reason>)` (`plain.ts:465`). (4) a `done` proposal has no goal → no empty quotes. (5) a step with no
proposal → `(no proposal)` as today. (6) the risk `detail` must be clipped by `clipDetail`
(`TRANSCRIPT_DETAIL_MAX_*`). (7) `plan` emitted only on change → the **first** plan of a run always
emits (nothing to compare with). (8) `--json` consumers read the **events**, not the item text, so they are
unaffected. (9) every new text goes through `oneLine`+`clip(600)` as today.

**Tests (the complete pin list to update).**

| file:line | pin | group |
| --- | --- | --- |
| `test/unit/tui/plain.test.ts:93` | `[step 3] intent=edit p=0.82 c=0.71` | G2 |
| `:95` | `intent=investigate … (jev answered none_of_these)` | G2 |
| `:97` | `[step 2] risk=0.50 review: destructive: level 2 (0.50)` | G3 |
| `:100` | `[step 2] proposal edit src/a.py: … \| plan done=1 …` | G2 |
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
| `test/unit/tui/picker.test.tsx:98, 102` | `[step 7] judge succeeded=0.89`, `[run] end max_steps steps=7` (a **stored** transcript: the picker must keep reading old logs — see risk R3) | G1, G2 |
| `test/unit/loop/engine-core.test.ts:130, 134, 148` | `^\[run\] start `, `^\[run\] end complete steps=2 wall=`, `resumed from step 1` | G1 |
| `test/unit/loop/engine-loop-fixes.test.ts:63` | `^\[step 2\] risk=0\.36 ok: completion verified …` | G3 |
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
| `test/pty/run-smoke.sh:203, 207, 212–219` | `end max_steps`, `^\[run\] start`, the compact-transcript stage-line regex `^\[step [0-9]+\] (intent=\|context [0-9]+ files\|proposal … \|risk \|outcome \|judge succeeded=)` | G1, G2, G3, G4 |
| `test/pty/smoke/chat-task.steps` | `expect \[run\] start `, `expect end (complete\|max_steps\|generator_done)` | G1 |
| `test/pty/smoke/panel.steps`, `exitlast.steps`, `oneshot-ctrlc.steps`, `s2-*.steps`, `resize-live.steps`, `budgetfirst.steps`, `taskfile-header.steps` | the same two sentinels | G1 |
| `test/pty/helpers.ts:748, 758` and `RUN_STARTED_STEP` | the documented `[run] start <id> mode=… task: …` sentinel | G1 |
| **`src/perf/pty.ts:800`** | `export const END_PATTERN = 'end [a-z_]+ steps='` → `'finished · [a-z_]+ · \\d+ steps'` | G1 |
| **`src/perf/pty.ts:804`** | `RUN_STARTED_PATTERN = '\\[run\\]<SGR> start '` → `'\\[run\\]<SGR> started · '` | G1 |
| `src/perf/composer-latency.ts:195, 205`; `src/perf/render-lag.ts:345, 386`; `src/perf/states.ts:125, 177, 237, 248, 277`; `src/perf/intake-latency.ts` | every use of the two constants (they are constants, so the two edits above cover them — but `render-lag.ts:386` also does `capture.search(new RegExp(END_PATTERN))`, which must still match the **new** text or the lag window silently becomes the whole run) | G1 |

**Perf gate.** The probe regexes are the gate's own instrument: `first-frame.ts` reads `step 0/` from the
header (unchanged by P13 — the header is R5 P13c, still deferred), `render-lag.ts` and
`composer-latency.ts` read `END_PATTERN`. **Land the two `src/perf/pty.ts` constants in the same commit as
G1**, and re-run `npm run perf` once to confirm the windows are non-empty (a silently non-matching
`END_PATTERN` turns the lag window into the whole capture and the gate into a lie).

**Identity: E** — all three sinks change together because `itemsFromEvent`/`stepSummaryText` are the single
formatter. `--plain` and `transcript.log` need no separate edit.

---

### P14 — The risk item: one row, the audit string preserved

Called out separately from P13 because it touches a **model-facing** string.

**What.** `plain.ts:327` currently prints `risk=<p> <verdict>: <e.risk.reason>` where `reason` is the
audit sentence built at `risk.ts:276–300` — 8 terminal rows for an `ok` verdict (§2.9 H7). The item becomes
one row (`risk 0.01 ok · destructive 0 · irreversible 0`), the full `reason` moves to the item's TUI-only
`detail`, and `RiskAssessment.reason` itself is **not changed**: it is stored in `decisions.jsonl`, returned
in `RunResult`, and fed back to the generator as `recent[i].reason` (`risk.ts:11,27,177`). Changing it
would change model behaviour and every bench baseline.

**Edge cases.** (1) `review`/`block` must still name the dominant dimension and its level text (that is the
actionable part) — clipped to 80 with a pointer `/why s7.risk.destructive`. (2) the verification and
novel-patch clauses (`risk.ts:239, 295, 298`) are appended to the reason, not the row; the row gets
` · verified by the engine's own test run` as a segment. (3) `harm-only (llm-jev)` → a segment
` · harm-only`. (4) the `detail` passes `clipDetail`. (5) `--plain` and `transcript.log` get the one row
(no detail) — that is the documented `detail` rule and it *reduces* the log by ~7 rows per step.

**Tests.** `plain.test.ts:97`; `engine-loop-fixes.test.ts:63` (the pin that asserts the verification clause
is in the **transcript line** must move to asserting it is in the **Decision reason**);
`run-smoke.sh:214`'s `risk ` alternative.

**Identity: E.**

---

### P15 — `/help`: one formatter, aligned, grouped, with aliases

**What.** Round 3 F9 already deletes `session.ts:954–972` and routes both renderers to
`palette.helpLines(columns, …)`. Round 4 adds the output-style part: group the command list by
`CommandSpec.category` (`session · run · files · inspect · money · config · ui`) with a `rule` row per
group, align `name(12) alias(3) usage` then the title in the remaining width, and put the availability tag
in a dim right-hand column instead of inline `(idle only)`.

**Where.** `src/tui/commands/palette.ts:302–361`.

**Edge cases.** (1) `HELP_MAX_LINES = 60` with 7 group rules → the compaction ladder
(`HELP_COMPACTION_LEVELS`) gains a level 5: drop the group rules. (2) `topic: 'commands'` → no key section,
groups kept. (3) width < 50 → the alias column is hidden (round 3 rule 4) and usages move under their name.
(4) `--ascii` rule glyph.

**Tests.** `palette.test.ts:235` (widths 40/80/120, every row ≤ width, ≤ 60 rows), `session.test.ts:547`
(the head becomes `help` in both renderers — today the TUI's is `keys`), `registry.test.ts:186`
(`gen-docs --check`).

**Identity: L.**

---

### P16 — Gates and the test matrix this round adds

**What.** Three new gate rows, so the style cannot regress:

| gate | assertion | where |
| --- | --- | --- |
| **block width** | in `commands-{idle,live,thinking}.steps` at 24×40, 24×80, 40×120, **no static row produced by a command exceeds the terminal width** | `test/pty/round4.pty.test.ts` over `helpers.ts`'s frame splitter |
| **block identity** | for every command in `COMMANDS` that produces a block, the §3.9 normaliser equates the TUI rows and the `--plain` rows | `test/unit/tui/round4-identity.test.ts` (offline, fake engine) — cheap, covers all 39 |
| **block build time** | `renderBlock` of the largest block at 200 columns < 2 ms; `/config` during a live run keeps render lag p95 < 5 ms | `test/unit/tui/block/bench.test.ts` + the existing `render-lag` bucket |

Plus the coverage gaps round 3 G1–G5 left: a controller test for `/calibration` and `/report` blocks, a TUI
test for `/copy diff`, and the `commands-*` pty matrix.

**Identity: C.**

---

## 6. `transcript.log` consumers checked

| consumer | reads | affected by P11 / P13? |
| --- | --- | --- |
| `src/cli/report.ts` (`jevcode report`) | copies `transcript.log` verbatim into the bundle, redacting | no parsing — **safe** |
| `src/tui/picker.ts` (the session picker preview, `picker.test.tsx:98`) | the **last two lines** of a stored `transcript.log`, shown verbatim | safe for new runs; **old** logs still render (it does not parse) |
| `src/cli/sessions.ts` / `export.ts` | concatenates run transcripts under a `==== run … ====` header | no parsing — safe |
| `src/bench/*` (`report.ts`, `metrics.ts`, `step-records.ts`) | reads `steps.jsonl` / `decisions.jsonl` / `run.json`, **not** `transcript.log` (verified by grep) | safe |
| `src/perf/pty.ts` `END_PATTERN`, `RUN_STARTED_PATTERN` | greps the **terminal capture** | **must change with G1** (P13) |
| `test/pty/run-smoke.sh` | greps the stripped capture | **must change with G1–G4** |
| a user's own `grep` | — | announce in `CHANGELOG.md`; `docs/TUI.md` gets the new item table |

## 7. Risks

| # | risk | mitigation |
| --- | --- | --- |
| R1 | Round 3 rule 4 (detail rows indent to column 10) lands **before** P7, so every pane-derived block (`/plan`, `/decisions`, `/why`, `/calibration`, `/diff`) overflows by exactly 10 cells and wraps | P7 is the first round-4 commit; until then the round-3 slot should pass `columns - LABEL_GUTTER` at the six call sites listed in P7 (a two-line change) |
| R2 | P13 changes `transcript.log`; a stale `END_PATTERN` makes `render-lag`/`composer-latency` measure the whole capture and report a *better* p95 | land `src/perf/pty.ts:800,804` in the same commit; add a self-test asserting both patterns match a recorded fixture (the pattern of `clearReSelfTest`, `render-lag.ts:74`) |
| R3 | old `transcript.log` files (resumed runs, the picker preview, `jevcode report` of an old run) hold the **old** texts | nothing parses them (§6); the picker shows them verbatim, which is correct |
| R4 | P11 multiplies `notice ui` events during a run; a 42-row `/config` while live is 42 events through the redacting emit | `BLOCK_LOG_MAX = 24` + the render-lag gate of P16 |
| R5 | folding default rows out of `/config` (P2) hides information a support bundle needs | the bundle writes `config.json` in full (`report.ts` `configJson`), and `--all` exists |
| R6 | P14 tempts an implementer to shorten `RiskAssessment.reason` itself, changing the generator prompt and every bench baseline | the proposal says so explicitly; add a test asserting `reason` still contains `dominant level` |
| R7 | The style spec is large; partial adoption leaves two grammars in the product | P1 lands the API and **converts all 17 + 4 call sites in the same commit** (they are 5–15 lines each); no call site may keep `string[]` |

## 8. Open questions

1. Is `/config`'s default-fold (P2) acceptable, or must the full table stay the default and `--brief` be the
   opt-in? (Fold is the opencode-like choice; the full table is the support-friendly one.)
2. P11 puts block rows into `transcript.log`. Is that the intent of the identity rule, or should the rule
   be relaxed to "the **rows** are identical between the TUI and `--plain`; `transcript.log` carries the
   head only"? The second is a one-line change to `block()` (`--plain` stops logging body rows) and is
   cheaper — but it makes a support bundle less useful.
3. Should `[run] ready` be deleted as an item (P13 G1) or kept behind `/transcript full`? Deleting it
   removes one run id from the scrollback; keeping it costs one row per run.
4. `plan` emitted only on change (P13 G2): does any consumer rely on one `plan` item per step? (`useEngine`
   reads the **event**, not the item, so the TUI pane is unaffected — but confirm with the engine owner.)
5. The percentage form: `12 %` (today's `/cost`) or `12%` (today's `/calibration` `nearPct`)? The style
   guide must pick one; this document assumes `12 %`.
6. Who owns `src/cli/config-table.ts` in the round-4 slot map — it is shared with the `jevcode config` CLI
   path in `main.tsx`.
