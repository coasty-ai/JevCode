# JevCode interactive TUI — user guide

The user-facing guide to `jevcode` on a terminal (TUI-DESIGN §21), describing the behaviour on disk as of
2026-09-21: modes, the composer and its keys, reviews, the Jev pane and status line, sessions, follow-ups,
steering and pause, money, secrets, undo/rewind/diff, errors, logs, exit codes, and per-terminal setup notes.
The command table is generated into [`docs/COMMANDS.md`](COMMANDS.md) and the key table into
[`docs/KEYS.md`](KEYS.md) from the registries in `src/tui/commands/registry.ts` and `src/tui/keys/bindings.ts`;
`man jevcode` and the shell completions (`jevcode completion bash|zsh|fish`) come from the same tables, and a
unit test fails when any of them drifts (`node scripts/gen-docs.mjs --check`). Where this guide and the code
disagree, the code wins and the disagreement is a bug; where the code deviates from `docs/TUI-DESIGN.md`, the
deviation is listed in `docs/STATUS.md` ("Interactive TUI").

## Modes

| You type | What runs | Composer | Leaves with |
| --- | --- | --- | --- |
| `jevcode`, `jevcode chat`, or `jevcode run` with no task on a terminal | an interactive **session**: the composer opens first; nothing runs (and no money is spent) until you press Enter | Ink composer | `/exit`, Ctrl-D ×2, Ctrl-C ×2 while idle → exit 0 (`--exit-code last-run` returns the last run's code instead) |
| `jevcode run "<task>"`, `--task-file <path>`, `--resume <id\|title>`, `-c` | **one-shot**: one run, started right after `run:ready`; the composer is mounted for steering only | Ink (Enter = steer while live) | the run's exit code (table at the end) |
| `jevcode [chat] --plain` on a terminal | the same session over a plain `> ` readline prompt: no panes, no colours, the same slash commands | `node:readline` | as a session; Ctrl-C and EOF follow the same matrix (below) |
| a pipe, `CI`, `TERM=dumb`, `--no-input` | one run with the plain line renderer, no composer; the task comes from argv, `--task-file` or stdin; every prompt takes its safe default (key wizard → the fix block and exit 2, trust → instruction files skipped, follow-up over the session cap → silent clamp, a secret in the task → refused with exit 2, a review → declined) | none | the run's exit code |
| `--json[=verbose]` | one run written as an NDJSON event stream on stdout (non-interactive; `=verbose` adds `status` events) | none | the run's exit code, also on `run:end.exitCode` |

`jevcode chat --no-input` is a usage error (`--no-input needs a task: use jevcode run`); `jevcode chat` on a pipe
reads its task like `run` and exits at `run:end`. The interactive rule is `stdin.isTTY && stdout.isTTY && !CI &&
TERM !== 'dumb' && !--plain && !--json && !--no-input` (`CI` / `CONTINUOUS_INTEGRATION` set and not `0`/`false`).

The first frame is drawn from the command line alone — before any configuration file, `.env`, the runs
directory or git is touched — and shows the header item, the rule, the composer with its placeholder and the
status line with the `step 0/–` sentinel: `jevcode session · <dir> | step 0/– starting`, `jevcode task: <task> |
step 0/– starting`, `jevcode task: task from <file> | …` for `--task-file` (the file is read after the frame) or
`jevcode task: resuming <id> | …`. Measured on this machine (24×80 real pty, `test/pty/run-smoke.sh firstframe`,
child clock) the frame landed at `FIRST_FRAME_MS=` 87.2, 83.0, 82.0 and 83.0 ms in four runs on 2026-09-21 (85.5 and
82.1 ms in the reviewer's two); `jevcode perf` puts the `chat` 24×80 cold p95 at 110.4 ms (median 107.4 ms, warm
median 89.0 ms; the gate is < 300 ms) — `docs/STATUS.md`, "Measured numbers".

**Startup order inside a session:** keybindings file and prompt history (read synchronously in the tick after
the first frame, before any key can be dispatched) → configuration → configuration warnings (`warning: …` items;
on a `--plain` terminal or a pipe they go to stderr as `jevcode: <warning>`) → the key wizard when a key is
missing → the workspace trust question when `AGENTS.md`/`CLAUDE.md`, `./.env` or `./jevcode.json` exist → the
`[sandbox] …` line → the `@` candidate list → the session index → the `[ui] recent: "<title>" · <ago>  (Enter
continues, /resume browses)` hint when this directory has an earlier session.

## The composer

The composer is a multi-line, readline-style editor. Its placeholder tells you the state:
`Describe the task…   / commands · @ files · ? help · Enter runs` before the first run, `Follow-up or /command…
Enter runs · ↑ history · Esc Esc menu · ? help` after one, and `Type to steer the next step…   Esc pauses ·
Esc Esc aborts` while a run is live (the `>` prompt turns yellow: steer mode). Enter submits; Ctrl+J, Alt+Enter,
or a trailing `\` before Enter insert a newline (`Shift+Enter` is bound to `composer:newline` in
[`docs/KEYS.md`](KEYS.md), but its byte sequence only reaches the composer under a keyboard protocol JevCode never
requests, so treat it as inert — see the terminal notes). The full key list is [`docs/KEYS.md`](KEYS.md); `?` or F1 on an empty draft
appends the same help block to the transcript. The essentials:

| Key | Does |
| --- | --- |
| Ctrl+A / Ctrl+E, Home / End | start / end of the logical line |
| Ctrl+B / Ctrl+F, ← / → | one grapheme left / right; `→` at the end of the text accepts the ghost completion |
| Alt+B / Alt+F, Ctrl+← / Ctrl+→ | word left / right (`/ - _ .` separate words) |
| Ctrl+K, Ctrl+U | kill to the end / start of the line (kill ring, 16 entries) |
| Ctrl+W, Alt+Backspace; Alt+D, Alt+Del, Ctrl+Del | kill the word before / after the cursor |
| Ctrl+Y, Alt+Y | yank, yank-pop |
| Ctrl+T | transpose the two graphemes around the cursor |
| Ctrl+_ (Ctrl+-), Ctrl+^ | undo (100 snapshots), redo |
| ↑ / ↓ | move by visual row; on the first / last row: history previous / next; ↑ on the first row with an empty draft and steers queued takes the newest steer back |
| Ctrl+P / Ctrl+N | history previous / next, always |
| Ctrl+R | reverse-incremental history search in the composer row: Ctrl+R older, Ctrl+S newer, Tab or → accept and keep editing, Enter accept and submit, Esc restore the draft, Ctrl+A widen to all workspaces |
| Tab, Shift+Tab | completion: palette, `@` mention or argument — accept or cycle; Tab never moves focus |
| `/` at column 0 of an empty draft | open the command palette |
| `@` | open the file-mention popup over the workspace candidate list |
| `?`, F1 (empty draft) | append the help block (keys by context, commands with one-liners, per-terminal notes) |
| Ctrl+O | append the last step's decision details (probabilities and criteria) and recent warnings; acknowledges the `!n` badge |
| Ctrl+G, `/editor` | edit the draft in `$VISUAL` / `$EDITOR` (refused while the draft contains a secret) |
| Ctrl+L | repaint the dynamic region (erase and rewrite; never a screen clear) |
| Ctrl+Z | suspend to the shell; `fg` resumes and repaints |
| `[` / `]` (empty draft) | previous / next Jev pane tab |

On an empty composer only `[`, `]`, `/` (column 0), `@` and `?` are bound; `d`, `p`, `t`, `s` are never keys, so the
first letter of a task is always text.

**Palette.** `/` opens up to 8 rows (`/name   title   arg hint`, matched characters bold, a *Suggested* group
first — `/resume` after a stop, `/budget` after a budget stop, `/login` after a rejected key, `/undo` after a run
that changed files). Tab completes the highlighted row and keeps editing; Enter runs a command **only when the
token is exactly a name or an alias** — a `/` token that matches nothing keeps the draft and appends `[ui] error:
unknown command /foo; type / to list commands`, because a submitted line is a paid run. Esc closes and remembers
the token, so `/` stays closed while that token is unchanged. A `//` at column 0 submits a prompt that starts
with a literal slash. Idle-only commands while a run is live answer `[ui] error: /undo runs when the run is idle;
Esc pauses first`; live-only commands while idle answer `[ui] error: /pause needs a live run`. Arguments follow
`docs/COMMANDS.md`: bare words, `"double quotes"` with `\` escapes, `'single quotes'`, `--flag` / `--flag=value`;
commands whose one argument is free text (`/rename`, `/steer`, `/why`) take the raw rest of the line.

**`@` mentions.** `@` opens the same rows over the workspace's candidate paths (the walker lists up to 20,000
entries — `MAX_LIST_ENTRIES` in `src/workspace/candidates.ts`; the fuzzy ranking is gated in the unit test at p50 ≤ 16 ms
and p95 ≤ 48 ms per keystroke over 5,000 candidates, measured 0.57 / 1.00 ms on 2026-09-21); Enter or Tab inserts `@<path> ` (spaces escaped `\ `). At submit the paths become the new
run's pinned files (or ride in a steer while live): the context stage boosts them, still inside its 12-file /
60 KB cap. Paths on the secret denylist (`.env*`, `~/.ssh`, `*credential*`, `.npmrc`, `.pypirc`, `*.p12|pfx|jks`,
`.git/`) are never offered; typed in full they are dropped with `[ui] .env is on the secret denylist; JevCode
never reads it. Start with --allow-secret-mention to override.` Under `--allow-secret-mention` a per-mention
`Attach anyway? y/N` row asks first and every `KEY=value` line of the file is registered with the redactor.

**Paste.** Bracketed paste and paste-like chunks are normalised (`\r\n` → `\n`, control bytes and bidi controls
dropped). A paste longer than 3 lines or 800 characters becomes a chip `[Pasted #n, k lines]` whose body lives
only in memory (never in history, `ui.json`, logs or events) and is expanded at submit; a chip whose body is
gone (after `--resume`) cancels the submission with `[ui] remove [Pasted #N] or paste again`. Pastes over 1 MiB
are refused with a toast. A submission over 12,000 characters appends `[ui] notice: only the first 12,000
characters reach the generator; @-mention a file for more`.

**History.** `~/.jevcode/history.jsonl` holds the last 1,000 prompts, steers and commands (4 KiB each, redacted
before they are written, filtered to the current workspace; Ctrl+A in Ctrl+R widens). `/history clear` truncates
it after `y/N`; `--no-history` or `JEVCODE_NO_HISTORY=1` turns writes off (recall of what exists still works);
bench and perf runs never write it.

**Keybindings.** `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` (`--keybindings <file>`,
`JEVCODE_KEYBINDINGS`) maps action ids to keys: `{ "composer:externalEditor": "ctrl+g", "composer:killLine":
"none", "global:help": ["?", "f1"], "session:export": "ctrl+x ctrl+s" }`. Two space-separated keys are a chord
completed within 3 s; `"none"`/`null` unbinds; Ctrl+C, Ctrl+D, Ctrl+M (Enter), Ctrl+[ (Esc) and Ctrl+I (Tab)
are reserved and refused, as is stealing `y` from `review:approve`; unknown ids and collisions are warned about in
`jevcode.log`, never fatal. `/help reload` re-reads the file.

## Ctrl-C, Esc, Ctrl-D

Every interrupt key is resolved by one pure function over the state (`src/tui/keys/interrupts.ts`). Windows:
Ctrl-C ×2 within 1.5 s, Esc Esc within 2 s, Ctrl-D ×2 within 800 ms; a lone Esc waits 30 ms for an Alt chord.

| Key | idle, empty draft | idle, text in the draft | run live, empty draft | run live, text | review box armed |
| --- | --- | --- | --- | --- | --- |
| Ctrl-C | toast `press Ctrl-C again to exit`; a second within 1.5 s exits 0 and the scrollback keeps `[ui] exited on Ctrl-C ×2` | clears the draft into history (secrets masked) | session: aborts the run and stays (`end human_abort`, the composer reopens); one-shot: aborts and exits 130 | clears the draft; the run continues | empty draft: aborts the run (the rejected review *is* the decline — no `declined` step is recorded); with a draft: clears the draft, the box stays |
| Esc | arms Esc Esc; a second Esc opens the rewind / steer menu (the palette filtered to `/rewind /undo /resume /new`) | toast `Esc again clears the draft`; a second clears it | **pauses** at the next step boundary (`end human_pause`, then `paused after step N — /resume continues, or type a follow-up`); toast `Esc again aborts the run`; a second Esc aborts | arms Esc Esc (clear) | declines |
| Ctrl-D | toast `press Ctrl-D again to exit`; a second within 800 ms exits 0 (`[ui] exited on Ctrl-D ×2`) | delete forward | toast `run is live — Ctrl-D again to choose`; a second opens `a run is live: [y] abort and exit   [n] stay              (Enter does nothing)`; `y` aborts and exits 0 after `run:end` | delete forward | ignored |
| Enter | submits the task / follow-up | submits | nothing | queues a steer for the next step | never approves |

While the run is already aborting, any Ctrl-C exits immediately with 130 (the checkpoint is written first). A
run that is pausing still accepts steers; they are checkpointed and applied by `/resume` or folded into the
follow-up seed. Under an overlay: Esc closes the palette, mention popup or picker (the draft is kept); on the
secret gate Ctrl-C cancels the send **and** clears the draft; on the key wizard Ctrl-C prints the fix block and
exits 2 only when no run exists (during `/login` mid-run it just closes the wizard); on a blocking pane Ctrl-C is
that pane's `[q]`. `/exit` while a run is live opens the same `[y] abort and exit  [n] stay` row first.

In `--plain` on a terminal the tty stays in cooked mode, so Ctrl-C arrives as SIGINT and follows the same table
(live → abort and stay; idle → `press Ctrl-C again to exit` on stderr, a second within 1.5 s → exit 0), and EOF
(Ctrl-D) is final: idle → exit 0, live → abort, then exit 0 after `run:end`. `/pause` is the only pause path
there (no Esc in cooked mode).

## Reviews

When Jev's risk answer lands in the review band (0.3–0.7), the run pauses and, after about a second of composer
idleness with the input queue drained, the review box appears above a collapsed, inactive composer:

```
review  step 7  risk 0.44 (tail)  edit src/a.py "make the parser accept tz offsets"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
1 destructive   L1  ██▍·······  0.25  exp   0.93  …
2 out_of_scope  …
3 plan_mismatch …
4 irreversible  …
5 matches_intent  <bar>  <p> noul <c>~ <criteria>
```

`y` approves **once**; `n` or Esc declines; `d` turns the composer row into `note (≤ 600, Enter sends, Esc
cancels): ` and the note reaches Jev and the generator (`confirm <id> declined (note: <note>)` in the transcript);
`e` expands the preview; `w` then `1`–`5` within 1.5 s appends the `/why` block for that dimension (5 =
`matches_intent`). At 120 columns the keys row also lists `[ctrl-c] abort run`. Printable keys are ignored with the
toast `review pending: y n d e w · Esc declines`; a pasted string never matches a key. The box appears only after
about a second of composer idleness with the input queue drained, and its keys are armed on the frame **after** it
was drawn, so a key already in flight is text, never an approval (the Enter-opened rows — the secret gate, the
follow-up box, the undo prompt, the exit confirm — additionally ignore a `y` within 150 ms of that Enter). Below 8 rows the header drops the ruler, then `matches_intent`, then packs two dimensions per row
(the highest-risk first); the dimension digits are fixed so `w`+digit is stable across reviews.

**Never offered:** approve-always / approve-for-the-session, an Enter default, a timeout that approves, an
`a` approve alias, a steer key on the box, or an `--auto-decline` flag. A second review request while one is
pending declines the first. Without a terminal (a pipe, `--no-input`, `--json`, bench) a review is declined
after the confirmation timeout. In `--plain` the readline twin prints the same header lines with a `[step N]`
prefix and asks `[step N] [y] approve  [n] decline  [d] decline+note > ` (`yes`/`no` accepted, `d <note>` on the
same line); in screen-reader mode the choices are numbered `1 approve  2 decline  3 decline with a note` /
`Enter selection (1-3):` and only a line typed after the prompt appeared answers it.

## The Jev pane, status line and toasts

The pane under the transcript shows Jev's decisions rather than a log. Its rule row names the tabs — `───
decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──` (the bracketed letters are labels;
`[` and `]` on an empty draft cycle them):

- **decisions** — one row per Jev answer, newest last: `s7 stage id label bar p c~ verdict`, where the bar is the
  probability over a `·` track, `~` marks a derived Noul confidence (`|2p−1|`), a `!` before `p` marks an answer
  within 0.03 of the threshold that consumed it, and the verdict is `ok | review | block | chosen | overridden |
  fallback`. At 120 columns the row adds the latency and the code rule that consumed the answer (`paired ≥ 0.5`,
  `band 0.3/0.7`, `≥ 0.85 → stop`, …).
- **plan** — the ledger: `[x]` done (with the step and the `done_j` probability), `[?]` unverified, `[ ]` remaining,
  `[!]` harness problems (`replan`, `rejected_claim`, `stale_plan`, `human`).
- **timeline** — per step, stage timings (`intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s`)
  and a proportional letter strip (`I C P R X J`) with the total and the harness overhead.
- **synth** — in `--mode jev-only`, the synthesizer's phase and detail line (the default tab while a step's propose
  stage runs; `decisions` otherwise).

At ≥ 120 columns and ≥ 40 rows with no overlay open, the active tab and the next one render side by side. The
pane takes at most 12 rows and is the first thing to yield when the terminal is short; below 40×8 the panes are
hidden (`terminal <W>×<H> is below the 40×8 minimum — panes hidden, transcript above`) and only the transcript,
composer and status line remain. Nothing ever clears the screen: the transcript is scrollback, and the dynamic
region never exceeds `rows − 2`.

`/why <ref>` (`s7.risk.plan_mismatch`, `risk.plan_mismatch` for the current step, or a visible pane digit) appends
the worked block — every level or option with its bar and probability, the argmax, expected level and tail mass,
the confidence formula and the code rule that consumed the answer. `/decisions [n] [stage]`, `/plan`, `/jev`
(decider model, alias drift, question count, latency p50/p95, Jev cost) and `/calibration` (reliability bins,
ECE, near-threshold counts and sharpness over the newest 50 runs or 32 MB of this workspace's `decisions.jsonl`
and `steps.jsonl`) are the other inspection blocks; `jevcode why <run> <step> <ref>` and `jevcode calibration`
print the same blocks from the shell.

**Status line.** Left: the mode word or spinner and stage (`idle`, `idle exit N`, `starting`, `⠹ propose`,
`propose [synth]` in jev-only, `review`, `review pending…`, `pausing after step N`, `paused: <reason>`, `retrying
2/3`, `offline`, `disk ×N`, `aborting`, `palette`, `picker`, `still waiting` after 45 s in one stage) plus the badges
`!n` (unacknowledged warnings — Ctrl+O or `/errors` clears it), `sandbox: none`, `no-net`, `⚠ secret?`. Centre:
the session title or run id when the width allows. Right: `step 7/40 4m12s · run $1.60/2.00 high · sess
$4.11/10.00 ok`, the git zone `⎇ main ↑2 · 3~ 1?` and the Jev latency sparkline `jev ▂▃▂▅▂▂▇▃▂▁▂▃` (both from 100
columns), then a short help cell (`? help`, `Tab ⇥`, `Esc closes`). Meter words: `ok` (< 50 %), `half`, `high`
(≥ 80 %), `critical` (≥ 95 %), `over`, `uncapped` (session cap `none`). Toasts (`! <text>` for 2 s, 4 s for errors;
`✓ <text>`) replace the left zone and, except for the idle Ctrl-C/Ctrl-D/Esc hints, also land in the transcript as
`[ui]` items.

## Sessions, follow-ups, steering, pause

Every run of one `jevcode` process belongs to a **session** (the first run's id, per workspace). After a run
ends the composer reopens; the next Enter is a **follow-up**: a new run seeded from the previous run's plan, its
last four window entries, the files it created and its undo log, with the previous task quoted as the framing
(`[run] seeded from run <id>: plan done=4 remaining=2 unverified=1 · window 4 entries · 3 created files`). A
follow-up has its own run cap and shares the session cap.

- **Steering.** Type while a run is live and press Enter: the text is queued for the next step (`steer queued (1)
  for step 8: <text>`; the queue rows above the composer read `↑1 queued for step 8: …   [↑ takes back]`). Up to 8
  directives queue (`steer queue full (8)` after that); ↑ on the first row of an empty draft or `/unsteer` takes
  the newest back; at the next step start they become one instruction each for the generator and for every Jev
  stage (`steer applied to step 8 (N directives; superseded: …)`). A steer typed while the run is pausing or
  aborting is checkpointed and applied by `/resume`, or carried into the follow-up seed — never lost. `/steer
  <text>` is the same thing for `--plain`.
- **Pause and abort.** Esc (or `/pause`) stops after the step in flight commits: `end human_pause`, then `paused
  after step N — /resume continues, or type a follow-up`; the run exits with code 4 in the session item but is
  resumable without `--force`. Esc Esc (or `/abort`) aborts now; the in-flight step is discarded or committed as
  interrupted per the checkpoint rule.
- **`/resume`** opens the picker of this directory's sessions in the pane slot with the composer as its filter:
  `─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────`, rows `time ago │ steps │
  stop │ $cost │ title │ ● live`. ↑/↓ or Ctrl-P/N, PgUp/PgDn, Enter continues the row (a stopped run resumes; a
  completed run seeds a follow-up), Tab accepts and keeps filtering, Space previews (plan counts, spend, stop),
  Ctrl-A toggles all workspaces, Ctrl-R renames inline, `x` then `y` moves the run directory to
  `~/.jevcode/trash/` (never `rm -rf`), Esc closes. `/resume <id|title>` (exact title, or a unique prefix)
  continues without the picker; `--force` resumes a completed run instead of seeding a follow-up; `/continue` and
  `-c` pick the most recently used session here. `--resume <id|title>` and `--list-sessions` do the same from the
  shell; `jevcode sessions list|reindex|prune|unlock <id>` maintains the index (`~/.jevcode/sessions/index.jsonl`).
  A run held by a live process shows `● live` and refuses to resume (`run <id> is in use by pid <pid> since <t>
  (another jevcode?); run 'jevcode sessions unlock <id>' if that process is gone`).
- **`/new`** ends the session (`session <id> ended: N runs, $x total`); the next prompt starts a fresh one with its
  own session cap. **`/rename <title>`** (≤ 60 characters, through the secret gate) names it for the picker and the
  status centre. **`/export [file]`** writes every run's `transcript.log` under `==== run <id> · <t> · <task> ·
  <stop> · $<cost> ====` headers to `~/.jevcode/exports/<session>.log` (64 MiB cap).
- **Read-only blocks:** `/status`, `/cost`, `/jev`, `/plan`, `/decisions`, `/why`, `/calibration`, `/errors`,
  `/config` (masked table with a source column). `/theme dark|light|daltonized|ansi` and `/copy
  [last|proposal|draft]` (redacted, native clipboard tool first, OSC 52 only with `--osc52`) are TUI-only; `/copy
  diff` copies the most recent transcript item, so run `/diff` first. `/model`, `/provider` and `/mode` set a value
  for the **next** run only (kept in memory).
- **Git awareness.** Each run starts with the `[run] git main ↑2 · 3 modified · 1 staged · 1 untracked` banner (or
  `git none · not a git repository: changes made by commands are not recoverable, /diff compares against step
  pre-images only`); the status zone follows `HEAD` without spawning git; a `--resume` on a different `HEAD` warns
  that the plan may not apply. Nothing is ever committed, stashed or checked out on your behalf.

## Money

Two caps: the **run cap** (`--spend-cap`, `limits.spendCapUsd`, default $2.00; $0.25 under `--mode jev-only`) and
the **session cap** (`--session-spend-cap <usd|none>`, `session.spendCapUsd`, default 5 × the run cap, so $10.00
or $1.25). Every run's meter is a child of the session meter with cap `min(runCap, remaining)`. The status line
shows both (`run $1.60/2.00 high  sess $4.11/10.00 ok`); at 50, 80 and 95 % of either cap a `[run] budget: run
spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left at $0.040/step` item and a toast appear
(`--no-budget-warnings` / `JEVCODE_BUDGET_WARNINGS=0` mutes the toast and bell only; the item and the JSON event
stay).

- `/budget` prints both caps, both spends and every pending value; `/cost` prints the 12-row block (per-step
  p50 and last, steps left, generator vs Jev share, the pricing basis, pending values).
- `/budget session-spend-cap <usd|none>` applies **now** (`budget: session cap $10.00 → $15.00 (applies now)`),
  even before the first run, and is recorded in the session index; `none` lifts the cap (`uncapped` in red).
- `/budget spend-cap|max-steps|max-wall|max-replans|max-generator-tokens <v>` applies to whichever comes first
  — the next `/resume` of the stopped run or the next new run — never to the live run; `/cost` lists it as
  `pending` until then. A spend cap must exceed the target run's spend.
- A follow-up that would exceed the session cap asks first: `follow-up would exceed the session cap` / `[y]
  start, run cap clamped to $x.xx   [r] raise session cap   [n]/Esc cancel` (Enter does nothing; `r` prefills
  `/budget session-spend-cap …`). With nothing left: `session cap reached ($a of $b). Raise it with /budget
  session-spend-cap <usd>, or /new for a fresh session with its own cap.` On a pipe or under `--json` the clamp
  is silent and a refusal is `session:refused { reason: 'session-cap' }` with exit 4.
- A run that stops on its cap explains the next move: `stopped by the run spend cap: $1.532 of $1.500 (over by
  $0.032, one judge call). Session $4.11/$10.00 ok.` / `continue this run: /budget spend-cap 3.00 then /resume`
  / `or start a follow-up run with a fresh $1.500 cap`.
- **Unknown pricing fails closed.** An Anthropic model without a pricing entry refuses to start (exit 2) naming
  `JEVCODE_PRICE_IN_PER_M` / `JEVCODE_PRICE_OUT_PER_M` and `--allow-unpriced`; with `--allow-unpriced` the run
  is bounded by a token cap instead (`--max-generator-tokens`, default `spendCap / 15 × 1e6` ≈ 133k for $2.00;
  stop reason `token_cap`, exit 4; money figures show `$?`). Table-priced figures carry `~`.

## Secrets

Everything you type or paste passes `detectSecrets` before it is sent: a submission, a steer, a `/rename`
title, a review note, a slash command line, and the task text from argv, `--task-file` or stdin. The detector
knows the six redacting formats (`sk-or-v1-…`, `sk-ant-…`, `sk-…`/`sk-proj-…`, `AIza…`, `ghp_…`/`gh[ousr]_…`,
`github_pat_…`), every exact secret the configuration loaded (labelled `your OPENROUTER_API_KEY`), and nine
warn-only families (AWS access keys, Slack tokens and webhooks, PEM `PRIVATE KEY` blocks, JWTs, Stripe keys,
`npm_…`, `hf_…`, `glpat-…`). While the draft has a hit the status line shows `⚠ secret?` and the composer renders
the span as `•` cells; at Enter the gate row asks `Looks like this contains a secret (sk-ant-…). Send anyway?
y/N` (plural and `your <NAME>` forms exist). Only `y` sends, and only on a frame after the row was drawn and
at least 150 ms after the Enter; Enter, Esc, `n` or any other key dismisses it, keeps the draft and shows `Tip:
put it in .env and refer to it by name`; Ctrl-C cancels and clears the draft to history with the span masked
as `[REDACTED:draft]`.

On `y` every detected span (warn-only families included) is registered with the redactor **before** the text
reaches the engine, the generator receives the raw text, and the transcript records `[step n] sent 1 secret to
the generator on request` (`[run]` before step 1). From then on every artefact — `transcript.log`,
`steps.jsonl`, `state.json`, the Jev requests, the `--json` stream, prompt history, the session index, clipboard
payloads and `jevcode.log` — shows `[REDACTED:…]` in its place. The registration lives for this process only: a
later `--resume` of the run does not remember it (what was written to disk stays redacted; a new mention of the
same value would need the gate again). Without a terminal (a pipe, `--no-input`, `--json`) the send is refused:
`jevcode: the task contains a secret (<label>); refusing to start (exit 2)`. In `--plain` the readline twin asks
`jevcode: looks like this contains a secret (<label>); type y to send, anything else to cancel:`.

**The `--json` guarantee.** Every string on the stream is the engine event after the configured redactor:
configured secrets, `Send anyway`-confirmed values and recognised formats become `[REDACTED:<name>]` or
`[REDACTED:pattern]`; the stream never contains keystrokes, composer drafts, pasted payloads or key material; a
human turn is the `run:start` task line and the `steer:queued` lines holding the redacted submitted text;
`secret-ack` carries a count only. An unrecognised-format secret typed inline passes through, as in
`transcript.log`.

Keys are entered only through the masked wizard (`No API key found. Pick the generator provider:` → the masked
key fields → `[setup] saved <path> (mode 0600, dir 0700)` → an optional verification with one priced Jev call on an
explicit `y`) or `jevcode login` (masked prompt, or `--generator-key-stdin` / `--jev-key-stdin` on a pipe), never
as command-line arguments (`jevcode config set generator.apiKey …` is refused). A key pasted into the composer is
text under the gate above. The saved file is read-denied to sandboxed commands; an environment variable that
shadows the saved key is announced once per start (`[config] generator.apiKey: env ANTHROPIC_API_KEY (sha256:…)
overrides file … — unset the variable to use the saved key`). Keystroke traces log key classes only.

## Undo, rewind, diff

- **`/undo [step]`** restores the files a step changed from the run's pre-images after verifying each one: a
  file whose hash still matches the post-image is restored; one changed again by a later step is refused (`use
  /rewind 7 to undo steps 7–9 together`); one changed outside JevCode asks `<path> changed since step N (outside
  JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort` (Enter = no); symlinks, hard links, paths escaping the
  workspace and submodules are skipped; a clean tracked file that a command changed is restored with `git
  restore --source=HEAD --worktree` only while `HEAD` is the commit it ran under (`not recoverable — HEAD moved
  since step N` otherwise). The result is one item (`undo step 7: restored 3 files (…), skipped 1 (…)`), the
  step's `post/7.json` becomes `post/7.undone.json`, and the next run's seed carries `human reverted step 7: …`.
  There is no `/redo` and no restore-to-HEAD option.
- **`/rewind [step]`** opens a picker of the steps that changed files (`─── rewind · steps with changes ─ ↑↓ Enter
  Esc ───`), undoes every step back to the chosen one in reverse, then asks `files (done) · [p] plan+window · [b]
  both · Esc keep` — `plan+window` seeds the next run from that step's plan snapshot. Esc Esc on an empty idle
  composer opens the same menu.
- **`/diff`** appends the numstat block of the run's changes: `diff (run <id> · 12 files · +184 −37 · 2 untracked ·
  1 binary · 1 skipped)`, one row per file with the letter `M/A/D/R/?/B/S`, `+n −m`, a bar, and `†` for paths that
  were already modified before the run (`--all` lifts the 40-row cap). It is allowed while a run is live. `/diff
  <step>` shows a step's pre → post images; `/diff --full [step]` (idle only) opens the unified diff in
  `$GIT_PAGER` → `$PAGER` → `less`. Outside a git repository the block compares against step pre-images only.

`/undo`, `/rewind`, `/diff`, `/export`, `/report`, `/login`, `/logout`, `/resume`, `/new`, `/trust` and `/history
clear` run one at a time: a second one while the first is still working answers `error: /<cmd>: another command
is still running (/<other>)`.

## Errors, retries, blocking panes

| Severity | Where it shows |
| --- | --- |
| info | a dim transcript item |
| notice (self-healing) | the status word (`retrying 2/3`, `offline`) and the retry row, which disappears on heal; an item `warning: <side> retry chain: N attempts over <t> — recovered` / `— gave up` only when the chain failed or lasted > 10 s (`RETRY_SLOW_MS`); a failed chain also lands in `/errors` |
| warning | `!n` badge until Ctrl+O or `/errors`, a 2 s toast, a yellow `warning: …` item |
| error (run continues) | `!n`, a 4 s toast, a red `error <code>: …` item with the request id |
| blocking | `paused: <reason>` and a ≤ 4-row pane in the overlay slot |
| fatal | `[run] end error …`, the epilogue, the exit code |

The **retry row** (`jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now`, with
`last: HTTP 529 overloaded · request-id …` when the cause changed) counts down at 1 Hz; `r` skips the wait; Esc
during a retry pauses at the next boundary. Network causes read `offline: DNS lookup failed for <host>`,
`offline: cannot reach <host>` or `no response from <host> in 10 s` (host only, never the URL). Failed attempts
are not written to `jev.jsonl`.

**Blocking panes** (session mode; on a pipe the answer is always "stop"):

| Pane | Rows | Keys |
| --- | --- | --- |
| rejected key on the first call | `jev: key rejected (HTTP 401 — "…")` / `Set the decider key and retry. Consulted: <sources>` / `The key is never printed or logged.` | `[r] retry with the current key   [l] /login   [q] stop (exit 2)` |
| provider spend limit (Anthropic 429 spend limit, OpenRouter 402) | `provider: spend limit reached — "…" · this keeps failing until access resumes` | `[q] stop (exit 5)` |
| Jev unreachable after one exhausted chain with no action executed | `jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)` | `[r] now  [q] stop` |
| checkpoint could not be written (ENOSPC, EACCES, EROFS, …) | `checkpoint degraded: <code> on <file>` / `state.json could not be written since step N — the run cannot be resumed from here.` | `[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)` — after `[c]`, even a `complete` exits 3 |
| Jev model alias drift on the first call | `jev: model alias <configured> resolved to <served> on the first call` | `[p] pin --jev-model <served> for the next run   [q] stop (exit 2)` |
| `--sandbox seatbelt` requested but unavailable | `sandbox: seatbelt requested but sandbox-exec is unavailable` | `[q] stop (exit 6)` |

A pane that fails to render is replaced by one row (`ui: <pane> pane failed to render (<Error>) — run
continues; details in <log>`) and the run goes on; a failed review pane declines the review; a failed composer
falls back to a single-row input. Every run end and every fatal path prints the epilogue — `jevcode: stopped —
<code>: <msg> (exit N)` with the message redacted, then the `run`, `files`, `resume` and `report` rows — on stderr
in one-shot mode and as a `[ui]` item in a session.

## Logs and reports

A run's log is `<runDir>/jevcode.log` (levels `error | warn | info | debug | trace`, default `info`; `--verbose` or
`--log-level debug` adds decisions, request hashes, latencies and checkpoint timings **to the file only**;
`JEVCODE_LOG=<file>` redirects; `JEVCODE_TRACE=<file>` is the same at level `trace`). Session-level and pre-run
events, and any run whose directory is unwritable, go to `~/.jevcode/logs/jevcode-<pid>-<stamp>.log` (newest 10
kept). Every line passes the redactor; keystrokes appear as classes only; the log is capped at 8 MiB with one
rotation. `jevcode report <id>` and `/report` write a redacted bundle to `~/.jevcode/reports/<id>/` (`run.json`,
`transcript.log`, `jevcode.log` — the session log stands in when the run directory has none — the last 20
`steps.jsonl` rows, `config.json`, `versions.txt`, `README.txt`; `--include-requests` adds the redacted
`jev.jsonl` bodies). Nothing is sent anywhere.

## Exit codes

| Situation | `jevcode run` | session |
| --- | --- | --- |
| `complete` / `generator_done` | 0 | item `exit 0`; the composer reopens |
| a budget stop (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `replan_stop`, `impossible`, a pause (`human_pause`) | 4 | item `exit 4`; the composer reopens |
| configuration or usage error at launch (incl. an unreadable `--task-file`, a refused secret, an unpriced model) | 2 | 2 |
| a rejected key or Jev model drift on the first call | 2 | pane `[q]` → item `exit 2` |
| API failure after retries; a provider spend limit | 5 | item `exit 5` |
| checkpoint degraded and stopped (`complete` included); `--resume` unusable | 3 | item `exit 3` + not-resumable notice |
| sandbox / path violation | 6 | item `exit 6` |
| Ctrl-C ×2 while a run is live | 130 | item `exit 130`; the composer reopens |
| an external SIGINT | 130 | 130 (the process exits) |
| SIGTERM | 143 | 143 |
| SIGHUP / the terminal went away | 129 | 129 |
| an uncaught error or an escalated render fault | 1 | 1 |
| `/exit` (incl. `[y]` while live), Ctrl-D ×2, Ctrl-C ×2 idle | — | 0 (`--exit-code last-run`: the last run's code; an aborted run counts as 130) |

## Terminal setup notes

JevCode's terminal posture is deliberately conservative (TUI-DESIGN §14): no keyboard-protocol negotiation
(kitty or `modifyOtherKeys`), no terminal queries (`DA1`, `OSC 11`, `CSI ? u`, …), no mouse reporting, no
alternate screen, bracketed paste on, synchronized output (mode 2026) around every frame, a steady-bar cursor
(DECSCUSR 6) while mounted and a full reset string on every exit path. Colour is ANSI-16 with a textual marker
beside every coloured word, so `NO_COLOR`, `--no-color`, `TERM=dumb` and `--theme ansi` read the same.
Notifications (`--notify`, on by default in screen-reader mode) use BEL everywhere plus OSC 9 on iTerm2,
Ghostty, WezTerm and foot and OSC 99 on kitty; clipboard writes use a native tool first and OSC 52 only behind
`--osc52`. The consolidated capability matrix with test status is
[`docs/research/tui/terminal-matrix.md`](research/tui/terminal-matrix.md); the rows below are what to set up.

**None of the per-terminal rows below has been exercised on a real terminal application in this pass.** They come
from the 2026-09-20 research (`docs/research/tui/07-terminal-protocols-edge-cases.md`) and carry its `?` marks in the
matrix; the only terminal driven here is the `expect(1)` pseudo-terminal (`TERM=xterm-256color`) behind the pty
tests. The manual checklist at the end of the matrix is how a row gets verified.

| Terminal | Notes |
| --- | --- |
| Every terminal | Shift+Enter is not a newline (it needs a keyboard protocol JevCode does not enable): use **Ctrl+J**, **Alt+Enter**, or a trailing `\` before Enter. Alt-b / Alt-f / Alt-d / Alt-y need the Option or Alt key to send Esc-prefixed chords. |
| iTerm2 | *Profiles → Keys → Left Option key: Esc+* for the Alt chords. Notifications arrive through OSC 9 (BEL otherwise); OSC 52 clipboard writes need *General → Selection → Applications in terminal may access clipboard* and `--osc52` — `/copy` uses `pbcopy` first anyway. |
| Terminal.app (macOS) | *Profiles → Keyboard → Use Option as Meta key*. No OSC 52 or OSC 9: `/copy` goes through `pbcopy`, notifications are BEL. |
| VS Code integrated terminal | Alt chords work when `terminal.integrated.macOptionIsMeta` is on (macOS). OSC 52 works locally but not over Remote-SSH (native tool first). Without `TERM` the colour decision follows `FORCE_COLOR`. Huge pastes may drop characters in xterm.js: paste into a file and `@`-mention it instead. |
| Ghostty, kitty, WezTerm | The kitty keyboard protocol is never requested, so their Shift+Enter still needs Ctrl+J or `\`+Enter. kitty gets OSC 99 notifications, the other two OSC 9. |
| Alacritty, foot | Plain xterm-style keys; OSC 52 write supported; foot shows OSC 9 notifications, Alacritty falls back to BEL. |
| tmux 3.4+ | Colours are limited to the 16 ANSI names inside tmux by design. For notifications and `--osc52` through tmux set `set -g allow-passthrough on` (and `set -g set-clipboard on` for the clipboard). A lone Esc waits 30 ms for an Alt chord; tmux's own `escape-time` adds to it, so set it low (`set -sg escape-time 10`). |
| ssh / mosh | `SSH_TTY` or `SSH_CONNECTION` lowers the frame rate to 15 fps (`--fps` overrides). mosh does not pass OSC 52 or notifications; expect BEL only. |
| Linux console (`TERM=linux`), `TERM=dumb` | ASCII glyphs are selected automatically (`--ascii` / `JEVCODE_ASCII=0` override); `TERM=dumb` selects the plain renderer. |
| Windows | Not tested. The design is ConPTY terminals with `--sandbox none` and sandboxed runs under WSL 2; the credentials file prints `(Windows: protected by your user profile ACL)` instead of being chmod'ed. |

**Accessibility and rendering flags.** `--screen-reader` (`JEVCODE_SCREEN_READER`; `INK_SCREEN_READER`)
replaces bars and the spinner with text, numbers every prompt (`Enter selection (1-N):`), turns notifications and
reduced motion on, and implies `--plain` on a pipe (the design's opening item `[screen reader mode: on via …]` is not
emitted by this tree — `docs/STATUS.md`, "Interactive TUI" deviations).
`--no-animation` / `--reduced-motion` (`JEVCODE_REDUCED_MOTION`) uses a static `•` spinner with a 1 Hz clock.
`--ascii` swaps every glyph (`─` → `-`, `✓ ✗` → `+ x`, `⎇` → `br`, bars → `#`). `--theme
dark|light|daltonized|ansi` (`daltonized` swaps red and blue for review/block; `ansi` never dims); `/theme`
changes it for new items. `--fps 5..30` and `--render-mode standard|incremental` are fixed at launch (flag > env >
default; a value in the config file is reported as `ignored:launch` by `jevcode config`). `--title` /
`JEVCODE_TITLE` / `ui.title` resolve (`jevcode config` lists `ui.title`) but are opt-in OSC 2 title (set at session start, cleared on exit)
wired — see `docs/STATUS.md` ("Interactive TUI", deviations).

## Development notes

`--mock` runs a scripted generator and decider offline; `JEVCODE_MOCK_REVIEW_AT=<step>` puts that step in the
review band so the box can be exercised. `sh test/pty/run-smoke.sh [scenario…]` drives the built bundle
(`npm run build` first) through `scripts/pty/drive.exp` in a real pseudo-terminal across 19 scenarios and asserts
exit codes, the zero-clears rule per geometry segment and scenario-specific strings; `PTY_AUTO_REVIEW=y` makes the
driver answer review boxes; `npm run test:pty` runs the vitest project of the same kind (`test/pty/*.pty.test.ts`,
macOS, sequential, rebuilds a stale bundle first; 26 tests, all green in three runs on 2026-09-21 — the run log and
the live-resize clear counts are in `docs/STATUS.md`, "Interactive TUI" deviation 8). `JEVCODE_TRACE=<file>` records startup and run-lifecycle checkpoints (key classes
only, never a key or a draft); `JEVCODE_FAULT=render:<pane>` makes one pane throw once to exercise the render
boundary. `node scripts/gen-docs.mjs` regenerates `docs/KEYS.md`, `docs/COMMANDS.md`, the man page and the
completions; `--check` reports what is stale.
