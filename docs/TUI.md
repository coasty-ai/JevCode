# JevCode interactive TUI — user guide

The user-facing guide to `jevcode` on a terminal (TUI-DESIGN §21; round 2 TUI-DESIGN-2), describing the behaviour on
disk as of 2026-09-22: modes and the mode badge, the conversation (what happens when you press Enter), the composer and
its keys, reviews, the Jev panel and the console's status bar, the startup splash, sessions, follow-ups, steering and
pause, coordination (`/who`, the messaging verbs), the context meter (`/context`, `/compact`), money, secrets,
undo/rewind/diff, errors, logs, exit codes, and per-terminal setup notes.
The command table is generated into [`docs/COMMANDS.md`](COMMANDS.md) and the key table into
[`docs/KEYS.md`](KEYS.md) from the registries in `src/tui/commands/registry.ts` and `src/tui/keys/bindings.ts`;
`man jevcode` and the shell completions (`jevcode completion bash|zsh|fish`) come from the same tables, and a
unit test fails when any of them drifts (`node scripts/gen-docs.mjs --check`). Where this guide and the code
disagree, the code wins and the disagreement is a bug; where the code deviates from `docs/TUI-DESIGN.md` or
`docs/TUI-DESIGN-2.md`, the deviation is listed in `docs/STATUS.md` ("Interactive TUI", "Round 2").

**2026-09-23: the default mode is `agent`.** The next section is how a session looks and behaves in it. The
sections after it were written for the Jev-driven modes (`llm-jev`, `jev-on`, `jev-off`, `jev-only`), which keep
every behaviour they describe; where agent mode differs, the next section says so and wins.

## Agent mode, the default (2026-09-23)

The as-built contract is `docs/TUI-DESIGN.md` §7.8; the loop behind it is
[`docs/architecture/agent-loop.md`](architecture/agent-loop.md).

**One conversation.** Every line you submit that is not a `/command` is a `[you]` item and then the next turn of
one agent run that carries the whole session: earlier replies, earlier runs and their tool results. There is no
intake reading, no `On it — starting the run.` line, no ``Say `do it` `` offer and no catalogue reply — every
answer is the code model's own, streamed. A greeting or a question is answered in prose with no tool call: that
run stops `answered` and looks exactly like a chat reply (no `[run]` rows, no step rows, no stop line, no
`exit 0`), and it never becomes the session's title. A question the model answers after reading files (`read_file`,
`grep`, `glob`; no command, no change) is a reply too: only its prose shows, and the status row reads `reading` while
it reads. A request for a change gets tool calls, and from the first command or change the reply becomes a run (the
rows it held back, the reads included, land then in order). A provider error before that is ONE `[ui]` error row,
never text in the assistant's voice and never the stop epilogue; a transient one (a 5xx, a timeout) is retried once
automatically, and a 4xx such as a wrong model id ends the run at its first failed turn. A follow-up
prints no `[run] seeded from run …` line: the carry is the conversation, recorded in the run's own transcript — also
after a message that failed or was stopped before the model answered.

**Reply rendering.** The prose streams in place above the console's rule under `[jevcode]`, from the first token:
a line with no newline yet is drawn as text (wrapped, with a `▍` caret), never as a `streaming… N chars` counter.
A completed line moves into the scrollback without the frame jumping — the committed rows are the rows the live
block drew. All rows of one reply share the one `[jevcode]` label, so a reply is one contiguous block; blank rows
separate turns and tool rows only. Blank lines inside the prose are kept, bold, inline code, bullets, headings and
fenced code are rendered, and nothing is clipped at 600 characters or 24 rows. A dropped stream that the provider
retries leaves the dim row `reply restarted after a dropped stream`. Until the first tool call the composer keeps
its chat placeholder, the status row reads `thinking` then `replying`, and Esc or Ctrl-C stop the reply and keep
the session.

**Tool rows.** Each step leaves one `[step N]` row: `Read calc/core.py, tests/test_core.py · Grep "parse" in calc
(3 matches)` for a batch of reads (they ran in parallel), `Edit calc/core.py (+2 −2)`, `Write notes.md (+12 −0)`,
`Bash python -m pytest -q · 7 passed` (or `· exit 1`), `Verify npm test · 12 passed` when the harness ran your
tests itself, then the wall time and the step's cost. There is no `risk … ok` and no `judge …` segment.
Consecutive step rows form one block. The live region under the reply shows the command running now with the
last lines of its output, the reads in flight (`Read a.ts · Grep "x" in src…`), the call being written
(`writing edit_file src/a.ts… 1.2k chars`), or, while only reasoning has arrived, a dim
`thinking… 1.2k chars · <last line>`. `/transcript full` adds one row per read-only tool result
(`tool · read_file src/a.ts (lines 1-120) · 3 ms`).

**The mini indicator.** The 12-row 3D animation is gone. The status row's first cell holds a small braille
animation of what is running: a ring with a dark arc travelling round it (the donut) while the model thinks, a ring
with a sweeping meridian (the globe) while it reads, a box turning (the cube) while it edits, writes or runs a
command, a travelling sine (the wave) while your tests run. It is three cells wide when the row has room and the
old one-cell slot otherwise — the extra two cells are the first thing the row gives up, so nothing else is dropped
for it at 80 columns, and they come back once the row's drops have made room. Which segments fit is decided at the
widest status word, so the row does not jump sideways as a run switches between `thinking` and a tool, and a long
`ctx 41% · 6 files · 12 steps` steps down to `ctx 41%` before the cell is dropped. It steps on the spinner's own 125 ms tick (no timer of its own), animates only while
something runs, is a still frame over SSH and under `--no-animation`, a one-cell ASCII twin under `--ascii` or
`NO_COLOR`, and absent under `--screen-reader`, which keeps the status word.

**Status words.** `thinking` (a model turn), `reading` (a read-only batch), `editing` or `running` (the mutating
call), `testing` (the harness's test run), named from the start of each step. The rule strip reads
`▸ s<N> · plan d/t · <k> tool calls` (`plan d/t` only when the model wrote a todo list); there is no Jev sparkline and no `jev …` token segment; the decisions tab of
a run that asked Jev nothing reads `a normal agent run makes no Jev decisions`; `/jev` and `/panel` still work but
left the Popular group. `[run] finished` of a run that used no Jev has no `jev $0.000` part.

**Autonomy.** Under the default `--autonomy full` nothing asks and nothing is refused — by the harness, and a command
you explicitly ask for is not refused by the model either: there is no review card,
and a command that matches a destructive rule runs like any other and leaves a warning row
`destructive · ran <command> (rule <id>) — <what /undo can do>`, ending in `this left the machine; /undo cannot
reverse it`, `/undo restores the workspace` or `/undo may not restore this`. A compound command is judged whole
(`git reset --hard && git push --force` names both rules and says it left the machine), and a machine-leaving command
that exited non-zero says `exit N — it may not have left the machine`. A read-only program pointed at a secret
(`cat .env`) is not read-only: it goes through the gate like any other command. Under `--autonomy review` the review
card appears before every destructive or unrecognised command; the card of a destructive command is titled with
its rule's sentence and has no dimension rows; `y` runs it once, `n` declines and the model reads the decline.

**Modes and commands.** The badge reads `agent`. `/mode` lists `agent` and `jev-only` (the default marked);
`/mode legacy` lists `llm-jev · jev-on · jev-off`, which stay accepted; `/llm on` is `/mode agent` and `/llm off`
is `/mode jev-only`. `/undo`, `/rewind`, `/diff N`, `/steer`, pause (Esc) and abort (Esc Esc) work per step as
in every mode; a steer reaches the model as a note before its next turn.

**`--plain`** prints each prose line under `[jevcode] ` as it arrives (every line exactly once, a new line per model
turn), holds the run rows until the first command or change and drops them for a reply (a look-up included), so a
greeting prints only `[you] …` and `[jevcode] …`. Each step is one `[step N]` row (its `tool ·`, `proposal ·`, `done ·`
and `plan ·` rows stay in transcript.log).
`--json` writes every event, including `assistant:text`, `assistant:reset`, `generator:reasoning`, `tool:call`
and `tool:result`.

## Modes

| You type | What runs | Composer | Leaves with |
| --- | --- | --- | --- |
| `jevcode`, `jevcode chat`, or `jevcode run` with no task on a terminal | an interactive **session** in the default mode (`agent`, the badge in the console's top edge; `jev-only` with `--mode jev-only` or a `mode` row): the composer opens first under the resting wordmark; nothing runs (and no money is spent) until you send a message — then every message gets a streamed model reply, and a task becomes a run in the same conversation (in the legacy modes, a run starts only when Jev reads the message as a task) | Ink composer | `/exit`, Ctrl-D ×2, Ctrl-C ×2 while idle → exit 0 (`--exit-code last-run` returns the last run's code instead) |
| `jevcode run "<task>"`, `--task-file <path>`, `--resume <id\|title>`, `-c` | **one-shot**: one run, started right after `run:ready`; the composer is mounted for steering only | Ink (Enter = steer while live) | the run's exit code (table at the end) |
| `jevcode [chat] --plain` on a terminal | the same session over a plain `> ` readline prompt: no panes, no colours, the same slash commands | `node:readline` | as a session; Ctrl-C and EOF follow the same matrix (below) |
| a pipe, `CI`, `TERM=dumb`, `--no-input` | one run with the plain line renderer, no composer; the task comes from argv, `--task-file` or stdin; every prompt takes its safe default (key wizard → the fix block and exit 2, trust → instruction files skipped, follow-up over the session cap → silent clamp, a secret in the task → refused with exit 2, a review → declined) | none | the run's exit code |
| `--json[=verbose]` | one run written as an NDJSON event stream on stdout (non-interactive; `=verbose` adds `status` events) | none | the run's exit code, also on `run:end.exitCode` |

`jevcode chat --no-input` is a usage error (`--no-input needs a task: use jevcode run`); `jevcode chat` on a pipe
reads its task like `run` and exits at `run:end`. The interactive rule is `stdin.isTTY && stdout.isTTY && !CI &&
TERM !== 'dumb' && !--plain && !--json && !--no-input` (`CI` / `CONTINUOUS_INTEGRATION` set and not `0`/`false`).

**Engine modes and the badge.** `agent` (the default since 2026-09-23, badge `agent`: the code model works through
tools, your tests verify, Jev makes a few quick routing calls — the section above). The rest of this paragraph
describes the modes as they were before that flip; they stay accepted as legacy modes, and `/mode legacy` lists
them. `llm-jev` (the default from 2026-09-22 to 2026-09-23, badge `llm+jev · verified`: the code model writes candidate patches inside the Jev-only search, tests verify, Jev arbitrates — docs/LLM-JEV-DESIGN.md), `jev-on` (badge `jev+llm`: the code model writes the code,
Jev decides every step; one OpenRouter key serves both; run cap $10.00, session cap $50.00), `jev-only` (badge `jev-only`:
no generating LLM — code proposes candidate fixes, Jev decides, tests verify; one Jev key; $1.00 / $5.00), `jev-off`
(`llm-only`: the generator alone, a bench condition) and `llm-jev` (`llm+jev · verified`: the jev-only search with the
generator writing candidate patches inside it — Jev localises, ranks and arbitrates, tests verify; the jev-on caps). The
mode is a setting — `--mode`, `JEVCODE_MODE`, `./.env`, the config file's `mode`, then the default (`DEFAULT_MODE` in
`src/config/defaults.ts`, the one constant every fallback reads; the badge words come from the one table
`MODE_BADGE_WORD`) — and the **session follows it**: a round-2 `mode: "jev-only"` row keeps its session in jev-only
after `applyConfig`, with the badge corrected within 100 ms of the first frame. The badge is in every frame: in the
console's top edge (`╭─ jev+llm ──── <dir> ─╮`), or leading the status left zone in the flat tier (`jev+llm · idle`).
`/mode` alone prints `mode jev+llm (default)` — or `mode <current> — next run: <next>[ (default)]` when a switch is
pending; `/mode jev-only` (alias `/llm off`, or `/m jev-only`) sets the **next** run's mode (`mode jev-only from the next
run — no generating LLM; code proposes, Jev decides, tests verify (persist: jevcode config set mode jev-only)`; the badge
reads `jev-only · next run` until the run starts and promotes it); `/mode jev-on` (`/llm on`) switches back and, when no
generator key is configured, opens the wizard's key step inside the console — Ctrl-C there closes the wizard and keeps
the mode (`mode stays jev-only — no generator key was saved`), it never exits. `jevcode config set mode <m>` persists a
choice. A keyed start whose mode resolves from the default and whose config file has no `mode` row prints
`[setup] mode jev+llm (default) — caps $10.00 per run · $50.00 per session; /mode jev-only runs on Jev alone at $1.00 /
$5.00; jevcode config set mode <m> keeps a choice` once (it writes `seen.defaultMode`, so a later flip of the default
shows it once more).

The first frame is drawn from the command line alone — before any configuration file, `.env`, the runs
directory or git is touched — and it is frame 0 of the startup splash: the header item, the rule, the `J` column of
the wordmark with its sweep head (`██ ▓▒░`, five rows, at ≥ 16 rows and ≥ 64 columns), and the complete console —
the top edge with the mode badge and the workspace name, the composer row with its placeholder, the divider and the
status compartment with the `step 0/–` sentinel: `jevcode session · <dir> | step 0/– starting`, `jevcode task: <task> |
step 0/– starting`, `jevcode task: task from <file> | …` for `--task-file` (the file is read after the frame) or
`jevcode task: resuming <id> | …`. The session meter (`sess $0.00/1.25 ok`) and the git zone arrive with the
configuration a few frames later (the design's `[config] decider: <provider> · <model> (pinned) · key <ENV> (<source>)`
startup item is not emitted by the tree checked on 2026-09-21). The
round-1 frame measured 82–87 ms on the child clock in the pty smoke and cold p95 110.4 ms in `jevcode perf` (gate
< 300 ms); the round-2 numbers are in `docs/STATUS.md`, "Round 2".

**The wordmark.** The mark (`JEVCODE` in seven 5-row block letters, `JEV` in TypeSafe pink, `CODE` dim) is revealed
left to right over 400 ms, shimmers once and is held from 550 ms on — with the caption `◆ 0.4.0` two cells after the
last `E` (at ≥ 73 columns) and the tagline `Decisions, not strings` on its first row at ≥ 104 columns. It **stays**: the
mark is the pane slot's idle tenant at ≥ 21 rows and ≥ 64 columns, shown while the session is idle and while Jev reads
a message, hidden while a run is live or a panel, picker or review owns the slot, back under the strip after `run:end`
(at once at ≥ 24 rows; at 21–23 rows on your first key after the end, so the epilogue stays on screen); `/panel off`,
Esc on an empty draft and Alt+J bring it back. Its sweep — the splash's own 6-cell band — loops left to right at 4 fps
(16 written frames per 4 s pass, 6 s of rest: one pass per 10 s while you are attentive, per 30 s after a minute without
a key, asleep after ten minutes; never within 3 s of a key, and a reply calms it rather than waking it). Colour only:
letter cells inside the band take the pale `sweep` tint; the caption and tagline never do. `ui.wordmark` (`jevcode config
set ui.wordmark sweep|static|off`, `JEVCODE_WORDMARK`) is the escape hatch — `static` keeps the mark without the sweep
(the default over SSH), `off` restores the round-2 brand row `─── ◆ jevcode 0.4.0 ───`. The reveal ticks through Ink's
own animation timer at 50 ms (≤ 15 frames, never above the frame-rate gate), never clears the screen or writes to the
scrollback, and a key **completes** it — the next frame shows the character and the whole resting mark — or
on a run start or any overlay. `--no-animation` / `JEVCODE_REDUCED_MOTION`, `--screen-reader` and `--plain` have no
splash (the brand row from the first frame); below 64 columns only the one-line brand row pulses.

**Startup order inside a session:** keybindings file and prompt history (read synchronously in the tick after
the first frame, before any key can be dispatched) → configuration → configuration warnings (`warning: …` items;
on a `--plain` terminal or a pipe they go to stderr as `jevcode: <warning>`) → the key wizard when a key is
missing → the workspace trust question when `AGENTS.md`/`CLAUDE.md`, `./.env` or `./jevcode.json` exist → the
`[sandbox] …` line → the `@` candidate list → the session index → the `[ui] recent: "<title>" · <ago>  (Enter
continues, /resume browses)` hint when this directory has an earlier session.

## The composer

The composer is a multi-line, readline-style editor behind the `› ` prompt (`> ` under `--ascii` and in `--plain`),
inside the rounded console at ≥ 16 rows and ≥ 40 columns (the **boxed** tier: `╭─ <badge> ──── <dir> ─╮` · `│ › … │`
· `├──┤` · the status row · `╰──╯`, every row exactly the terminal width, so the composer and the status bar run at
the terminal width minus 4) and as a bare `› ` row over the status row below that (the **flat** tier, also under
`--screen-reader`). Its placeholder tells you the state: `Say hi, ask a question, or describe a task…` before the
first turn (a run or a chat reply; a command alone is not a turn), `Follow-up, question, or /command…` after one,
`Type to steer the next step…  Esc pauses` while a run is live (the prompt turns yellow: steer mode), `(thinking…)`
while Jev reads your message (the draft stays editable; a second Enter is answered `one moment — still thinking`; the
first frame after Enter, which commits the `[you]` bubble, still shows the steer placeholder and `starting` — deviation
4 in `docs/STATUS.md`, "Round 2"),
`(review pending — keys in the card; d opens a note)` under a review; at ≥ 100 inner columns the first two append `/ commands · @ files` and `↑ history · Esc Esc menu`.
Enter submits; Ctrl+J, Alt+Enter,
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

On an empty composer only `[`, `]`, `/` (column 0), `@` and `?` are bound (`[` / `]` open a collapsed Jev panel and
cycle its tabs); `d`, `p`, `t`, `s` are never keys, so the first letter of a task is always text. `Alt+J` toggles the
Jev panel, `Alt+Shift+J` opens it fully, `Alt+D` / `Alt+P` / `Alt+T` / `Alt+S` pick a tab (a second press on the same
tab collapses the panel).

**Shortcut aliases (TUI-DESIGN-3 §4.1, D-K).** Every command keeps its name; 21 short forms join it — an exact alias runs
its owner on Enter and pins it to the top palette row, the palette shows an alias column and a dim ` → /owner` ghost
while you type, Tab completes arguments and never wipes one you typed, and an error you cannot fix by editing
(`needs a live run`, `runs when the run is idle`, `not available in --plain`) clears the draft while a fixable one keeps
it. No one-letter alias exists for a command whose Enter destroys state without a confirm (`/abort`, `/exit`, `/new`).

| Command | Aliases | Command | Aliases |
| --- | --- | --- | --- |
| `/help` | `h` | `/panel` | `p` |
| `/mode` | `m` | `/plan` | `pl` |
| `/model` | `ml` | `/diff` | `d` |
| `/cost` | `c` | `/undo` | `u` |
| `/status` | `s` | `/theme` | `t` |
| `/resume` | `r`, `sessions`, `continue` | `/login` | `l` |
| `/new` | `nw` | `/budget` | `b` |
| `/exit` | `q`, `quit` | `/jev` | `j` |
| `/transcript` | `tr` | `/copy` | `cp` |
| `/config` | `cf` | `/rewind` | `rw` |
| `/why` | `w` | `/decisions` | `dc` |

`docs/COMMANDS.md` and `man jevcode` list every command with its aliases (`node scripts/gen-docs.mjs` regenerates them).

## The conversation

*The Jev-driven modes. In agent mode there is no intake — see "Agent mode, the default" above.*

Every line you submit that is not a `/command` becomes a `[you] <text>` item in the transcript (one item per line,
your secrets masked), then **one Jev request** decides what it is — the intake: a Choice over five readings
(`greeting_or_smalltalk`, `question_about_this_tool`, `question_about_the_code`, `coding_task`, `ambiguous`), each
with a paired yes/no Noul, plus the reply catalogue and the harness-fact Nouls folded into the same request, so a
greeting or a question costs one round trip (≈ 1,650 input tokens, about $0.00007, charged to the session meter, 110–250
ms on the TypeSafe endpoint). While the request is in flight the status word is `⠹ thinking` (a spinner) and the
composer reads `(thinking…)`; the very first frame after Enter — the one that commits the `[you]` bubble — still shows
`starting` and the steer placeholder `Type to steer the next step…  Esc pauses`, so with a reply faster than one frame
(the 0 ms mock of the pty smoke) that is the only frame you see (checked 2026-09-21 on the 13:4xZ bundle: a 400 ms mock
delay shows `▓ thinking` with `(thinking…)` from the first frame after Enter — the `starting` word never shows beside a
steer placeholder (TUI-DESIGN-3 P7). What follows depends on Jev's
answer:

| Jev reads it as | You get | Money |
| --- | --- | --- |
| a greeting, thanks, goodbye, small talk | the code model's own reply, streamed (in `jev-only`: one `[jevcode]` reply from a 14-row catalogue — `hi` → `Hi. I'm ready when you are — describe a change you want in <dir>, or ask what I can do.`; `thanks` → `You're welcome. Anything else on <dir>?`; `bye` → `Bye for now. /exit closes the session; runs are saved under ~/.jevcode/runs.`; `ok` → `Okay. Whenever you're ready.` … | the intake only |
| a question about JevCode itself (what it can do, its mode, keys, cost, commands, the last run, the tests, the sandbox, undo, the Jev provider) | one `[jevcode]` item per selected fact, most relevant first (≤ 4): `JevCode is a coding agent where Jev, a decision model, makes every decision: …`, `Mode: jev+llm — the code model writes the code, Jev decides every step.`, `Switch with /mode jev-only (Jev alone, $1.00 run cap) or /mode jev-on (alias /llm on); it applies to the next run. Persist it with jevcode config set mode <m>.`, `Keys: Jev through openrouter (OPENROUTER_API_KEY, never printed); generator: openrouter …`, `Session spend: $0.00 of $50.00 (0 runs, 3 chat messages). /cost has the breakdown.` … | the intake only |
| a question about the code in the workspace | in `jev-only`: `▓ looking`, one more Jev request over up to 60 candidate files, then `[jevcode] In jev-only mode I can point at code but not explain it — Jev decides, it doesn't write. Likely places:` with up to three `path:line  text` rows per file and `Switch with /mode jev-on to get an explanation from the LLM, or describe the change and I'll make it.` (or `I couldn't find a file in <dir> that clearly answers that (looked at <n> candidates). …`); in `jev+llm` (the default): `▓ replying`, one generator turn with no tools, streamed into the live region, then one `[jevcode]` item per line | the lookup ≈ $0.00005; the LLM turn at the generator's price, refused before sending when it would pass the session cap or the model is unpriced |
| a task (`coding_task` at Jev's own p ≥ 0.6, paired Noul ≥ 0.5) | the reply, then `[jevcode] On it — starting the run.` and the run: `[run] start …`, one `[step N]` line per step | the reply + the run |
| anything weaker or `ambiguous` (`the date parsing`, `tests?`) | the reply, then one more line: ``Say `do it` and I'll make that a task.`` Nothing blocks the composer; `do it` (or `yes`, `go ahead`, `run it`) on the next message starts that run from the reading already in hand, and any other message drops the offer | the reply |

Every message is answered by the code model in JevCode's own voice; Jev reads it in the BACKGROUND (never a card, never
a blocked composer) and only decides whether a run also starts. No keyword list ever starts a run: only Jev's
`coding_task` at its own probability floor, or your `do it` on the offer. A
one-shot `jevcode run "<task>"` never passes the intake (`jevcode run "hi"` runs a task named `hi`); a follow-up after a
run does (`did it pass?` is answered from the last test run). Ctrl-C once while `⠹ thinking` aborts the request (toast
`stopped thinking`, no bubble, the draft is not restored; a second Ctrl-C within 1.5 s exits as always). When Jev cannot
be reached the reply is `[jevcode] I couldn't reach Jev to read that (<short>). Press Enter to send it again.`; at the
session cap it is `[jevcode] The session cap ($1.25) is reached, so I'm not sending anything to Jev. Raise it with
/budget session-spend-cap <usd>, or /new for a fresh session.`; a configuration error is a `[ui] error: config: …` item.
The intake's Noul answers appear in the Jev panel as `s0` rows — `/panel` after `hi` shows `s0 intent  about_provider
noul  █·········  0.10  c 0.80~` and the other `about_*` facts (`/panel full` lists all 14); the design's pinned Choice
row `s0 intake  intake  coding_task  ███████▊··  0.78  chosen` and `/why intake` are not on the tree checked on
2026-09-21 (`/why intake` answers `[ui] error: /why: no decision intake in the last 3 steps`, and a failed `/why` keeps
the command in the composer — deviation 16 in `docs/STATUS.md`, "Round 2"). `/jev` adds `intake: <n> messages · p50 <ms>
ms · $<usd> · last: <kind> <p>` and `/cost` a `chat $<usd> for <n> messages (~$<each> each, p50 <ms> ms)` line (both
checked in `test/pty/round2.pty.test.ts`). `--json` carries one `chat { intake, probability, route, provider, costUsd,
latencyMs, requestHash }` line per message — reachable only through a session with a composer: `jevcode chat --json` is a
one-shot stream (a pipe makes the piped text the task, a TTY without a task exits 2 with `missing task text`), so the line
is exercised by `test/unit/cli/session-chat.test.ts`, not in a pty.
Replies are never history; your messages are (`Up` and Ctrl+R include them). Under `--mock` the mock decider classifies
by shape (a ≥ 3-word imperative without `?` is a task; `hi`, `thanks`, `ok`, `bye` greetings; a `?` about `you`,
`mode`, `cost`, `key`, `command` or `run` a tool question) and `JEVCODE_MOCK_INTAKE=<kind>` forces its answer.

**Palette.** `/` opens up to 8 rows (a `╭─ commands` card in the boxed tier; `/name   title   arg hint`, matched characters bold, a *Suggested* group
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

*The Jev-driven modes under `--autonomy review`. In agent mode a card appears only under `--autonomy review`, for
destructive and unrecognised commands, titled with the rule's sentence — see "Agent mode, the default" above.*

When Jev's risk answer lands in the review band (0.3–0.7), the run pauses and, after about a second of composer
idleness with the input queue drained, the review card appears above a collapsed, inactive composer (a rounded card in
the boxed tier, whose edge is yellow for a review and red for a block; round 1's bare rows in the flat tier):

```
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
```

At 120 columns the title carries the full goal, `(tail on <dimension>)` and `· jev <ms>ms`, and the table gains the
`P(l) E[k] tail` columns. Short terminals drop the ruler, then `matches_intent`, then compact the rows; the card's cut
is a function of the rows available, never Ink clipping.

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

## The transcript, the Jev panel, the status bar and toasts

**The transcript** is a conversation, laid out with a 10-cell label gutter (TUI-DESIGN-3 §5.1, D-L): every label is
right-aligned in the nine cells before column 10 — `[jevcode]` and `[sandbox]` flush, `[you]`, `[run]`, `[ui]`, `[step 7]`
padded on the left (`[step 100]` touches the edge; steps beyond push the body by the excess) — so every body starts at
column 10 and its wrapped rows hang there. `[jevcode]` labels are the primary pink and `[you]` labels the secondary,
both bold; bodies stay the terminal's default colour (amber for warnings and `[review]`, red for errors and `[block]`,
dim only for the `[run] git …` row) — the label is the bubble (D-O). A body wraps at ` · ` before it wraps at spaces (a
continuation row leads with `· `), and a final token narrower than 4 cells never sits alone: `[run] end … (gen $0.000,
jev $0.025)` / `exit 4`. TUI-only detail rows (the epilogue's `run` / `files` / `resume` / `report` table, `/cost`, `/jev`)
indent under the body column and hang under their value; a blank row precedes a `[you]` turn, the first `[jevcode]` of a
turn, `[run] start` / `end` and a `[ui]` block. None of this changes an item's text — `transcript.log`, `--plain` and the
TUI still print the same line, and the round-3 identity check (`test/unit/tui/round2-transcript.test.tsx`,
`round3-polish-app.test.tsx`) re-joins the rows by stripping their leading spaces. By default the transcript shows
**one line per step**: `[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests
40p/1f/0e · judge 0.52 · 1.6s · $0.0006` (action and verdict first; `declined` / `failed` / `blocked` as the outcome;
`interrupted at <stage> (<reason>)` for a step an abort cut; `jev 1.4k` tokens when the step carries no cost). This
`compact` view hides the stage items (`intent`, `context`, `proposal`, `risk`, `outcome`, `judge`, `plan`) and
`[run] ready`; `/transcript full` shows them for new items, `/transcript compact` hides them again, and `/export`
keeps everything. `--plain` and `transcript.log` always carry the full form, so they stay identical to each other
while the TUI shows a declared subsequence of them (`docs/TUI-DESIGN-2.md` §9). Code fences inside an item are drawn as
`╶──── <lang>` rules. (The design's `[jevcode] Done — <summary>. /diff shows the change, /undo reverts it.` epilogue
bubble after a `complete` run is not emitted by the tree checked on 2026-09-21 — `docs/STATUS.md`, "Round 2".)

**The Jev panel** under the transcript shows Jev's decisions rather than a log. It is a one-row **strip** by default —
`─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 ──────── [d] [p] [t] [s] ──` (`─── ▸ jev · no decisions
yet ───` before the first answer; at ≥ 120 columns the long labels `[d]ecisions [p]lan [t]imeline [s]ynth` and a
`jev <ms>ms` segment; before any run the rule row is the brand row) — and opens to at most six rows with `/panel`,
`Alt+J`, `[` / `]` on an empty draft or `/panel d|p|t|s`, its header `─── ▾ decisions s7 · c~ derived |2p−1| ────
[d]ecisions [p]lan [t]ime [s]ynth ──` naming the tabs (the bracketed letters are labels, not keys); the sixth row reads
`… <n> more rows · /panel full expands` when the tab has more, and `/panel full` or `Alt+Shift+J` gives it round 1's
twelve rows (side by side at ≥ 120 columns and ≥ 40 rows). `/panel off`, `Alt+J` again or Esc on an empty idle draft
collapses it; a run start collapses it too. Its tabs:

- **decisions** — one row per Jev answer, newest rows shown when open: `s7 stage id label bar p c~ verdict`, where
  the bar is the probability over a `·` track, `~` marks a derived Noul confidence (`|2p−1|`), a `!` before `p` marks
  an answer within 0.03 of the threshold that consumed it, and the verdict is `ok | review | block | chosen |
  overridden | fallback`; the conversation's intake answers are the `s0 intake` rows (`intake  coding_task
  ███████▊··  0.78  c 0.72  chosen`, the last three intakes kept). At 120 columns the row adds the latency and the
  code rule that consumed the answer (`paired ≥ 0.5`, `band 0.3/0.7`, `≥ 0.85 → stop`, `resolveChoice → run floor 0.60 →
  coding_task`, …).
- **plan** — the ledger: `[x]` done (with the step and the `done_j` probability), `[?]` unverified, `[ ]` remaining,
  `[!]` harness problems (`replan`, `rejected_claim`, `stale_plan`, `human`).
- **timeline** — per step, stage timings (`intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s`)
  and a proportional letter strip (`I C P R X J`) with the total and the harness overhead.
- **synth** — in `--mode jev-only`, the synthesizer's phase and detail line (the default tab while a step's propose
  stage runs; `decisions` otherwise).

The open panel is the first thing to yield when the terminal is short; below 16 rows the console and the cards give way
to round 1's flat rows (the badge leading the status line), below 40×8 the panes are hidden (`terminal <W>×<H> is
below the 40×8 minimum — panes hidden, transcript above`) and only the transcript, composer and status line remain.
Nothing ever clears the screen: the transcript is scrollback, and the dynamic region never exceeds `rows − 2` (a
shrink that leaves the previous frame taller than the terminal costs the one clear Ink needs, a grow none).

`/why <ref>` (`s7.risk.plan_mismatch`, `risk.plan_mismatch` for the current step, `intake`, or a visible pane digit)
appends the worked block — every level or option with its bar and probability, the argmax, expected level and tail
mass, the confidence formula and the code rule that consumed the answer. `/decisions [n] [stage]`, `/plan`, `/jev`
(the provider line `<provider> · <host> · <model> (pinned|alias) → resolved <served>`, question count, latency p50/p95
and Jev cost, and the `intake: <n> messages · p50 <ms> ms · $<usd> · last: <kind> <p>` line; the design's cost-basis
suffix `(~ table-priced: $0.042/M input, output free)` for TypeSafe is not printed by the tree checked on 2026-09-21 —
`/cost` reports Jev as `provider usage.cost`) and `/calibration` (reliability bins, ECE, near-threshold counts and sharpness over
the newest 50 runs or 32 MB of this workspace's `decisions.jsonl` and `steps.jsonl`; intake answers are never
written there) are the other inspection blocks; `jevcode why <run> <step> <ref>` and `jevcode calibration` print the
same blocks from the shell.

**Status bar.** In the boxed tier it is the console's status compartment (`│ idle … step 0/–  sess $0.00/10.00 ok
? help │`, laid out at the terminal width minus 4, so the git zone and the sparkline appear from 104 terminal
columns); in the flat tier the round-1 status row with the badge in front (`jev+llm · idle …`). Colour goes to the
left word and the meter words only, never the whole row (D-P): the spinner glyph in the accent pink, `idle exit 0` green
and `idle exit 4` amber once a run ended, `high` amber and `critical` / `over` red on the meters, `⚠ secret?` amber, a
toast in its level's colour and dim for its last second. Left: the mode word
or spinner and stage (`idle`, `idle exit N` (also right after Enter, until Jev's phase word takes over — `starting`
never shows beside a steer placeholder), `▓ thinking` /
`▓ looking` / `▓ replying` while a message is read, looked up or answered (the shade pulse `░ ▒ ▓ █ ▓ ▒` at 8 fps; `◆ thinking` under reduced motion), `asking`
under the intake card, `▓ propose`,
`propose [synth]` in jev-only, `review`, `review pending…`, `setup` under the wizard, `pausing after step N`,
`paused: <reason>`, `retrying 2/3`, `offline`, `disk ×N`, `aborting`, `palette`, `picker`, `still waiting` after 45 s
in one stage) plus the badges `!n` (unacknowledged warnings — Ctrl+O or `/errors` clears it), `sandbox: none`,
`no-net`, `⚠ secret?`. Centre: the `/rename` title when the width allows — never the run id (it lives in `[run] start` and
the epilogue's `run` row). Right: `step 7/40 4m12s · run
$1.60/2.00 high · sess $4.11/10.00 ok`, the git zone `⎇ main ↑2 · 3~ 1?` and the Jev latency sparkline `jev
▂▃▂▅▂▂▇▃▂▁▂▃`, then a short help cell (`? help`, `Tab ⇥`, `Esc closes`; nothing under the intake card, whose row lists
its keys). Meter words: `ok` (< 50 %), `half`, `high` (≥ 80 %), `critical` (≥ 95 %), `over`, `uncapped` (session cap
`none`). Toasts (`! <text>` for 2 s, 4 s for errors; `✓ <text>`; `stopped thinking`, `one moment — still thinking`,
`intake pending: y n · Esc keeps the text`) replace the left zone and, except for the idle Ctrl-C/Ctrl-D/Esc hints and
the thinking toasts, also land in the transcript as `[ui]` items.

**Colour.** The default theme (`dark`) is TypeSafe's pink, measured on typesafe.ai on 2026-09-21 (TUI-DESIGN-3 §2,
D-H): the two pinks — `#f386a1` (cell 211) marks JevCode and Jev (the brand row, the wordmark letters, the badge, the
`[jevcode]` label, Jev's `[chosen]`, the idle `›`, the spinner), `#d45bb6` (cell 169) marks what is live or selected (the
console edges during a run, your `[you]` label, the palette cursor); red, amber and green keep their meanings and pink
is never a semantic colour, so every pink surface keeps its text marker. `light` darkens the pinks (`#be185d` / `#831843`)
and fixes the inherited red and green on white; `daltonized` keeps the red ↔ blue swap; `ansi` is the 16-colour twin
(`magentaBright` / `magenta`). A terminal that announces a white background through `COLORFGBG` (iTerm2, Konsole, rxvt,
mintty: background index 7 or 15) gets `light` by default unless `--theme`, `JEVCODE_THEME` or `ui.theme` says otherwise;
Terminal.app announces nothing, so its white Basic profile wants `jevcode config set ui.theme light` (or `/theme light`
for the session). Truecolor and 256-colour palettes are picked from `COLORTERM`, `TERM_PROGRAM` and `TERM` (`FORCE_COLOR`
overrides; never a terminal query) with the ANSI-16 names as the fallback; every coloured word keeps its
textual marker (`[you]`, the badge word, the box glyphs), so `--no-color`, `NO_COLOR`, `TERM=dumb` and `--theme ansi`
read the same. `--ascii` draws the console and cards with `+ - |`, the prompt as `> `, the panel chevrons as `> v`,
the wordmark in `#`.

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
- **Read-only blocks:** `/status`, `/cost` (with `chat $<usd> for <n> messages (~$<each> each, p50 <ms> ms)`), `/jev`,
  `/plan`, `/decisions`, `/why`, `/calibration`, `/errors`, `/config` (masked table with a source column). `/theme
  dark|light|daltonized|ansi`, `/panel [d|p|t|s|off|full]`, `/transcript [compact|full]` and `/copy
  [last|proposal|draft]` (redacted, native clipboard tool first, OSC 52 only with `--osc52`) are TUI-only (`/panel` and
  `/transcript` print their rows in `--plain`); `/copy diff` copies the most recent transcript item, so run `/diff`
  first. `/model`, `/provider` and `/mode` (alias `/llm on|off`) set a value for the **next** run only (kept in memory;
  `jevcode config set mode <m>` persists the mode).
- **Git awareness.** Each run starts with the `[run] git main ↑2 · 3 modified · 1 staged · 1 untracked` banner (or
  `git none · not a git repository: changes made by commands are not recoverable, /diff compares against step
  pre-images only`); the status zone follows `HEAD` without spawning git; a `--resume` on a different `HEAD` warns
  that the plan may not apply. Nothing is ever committed, stashed or checked out on your behalf.

## Coordination: `/who`, `/peers` and the messaging verbs (round 5)

Every `jevcode` on this machine writes a heartbeat into `~/.jevcode/coordination/` while a run is live, and reads
the other sessions' beats into one **fold**. Nothing about it ever blocks a step: the default claim mode is
`coordination.claims: advisory`, which records an overlap as a fact and a notice and never waits.

- **`/who`** — one row per session on this repo: liveness, `branch@head`, `step/max` and stage, mode, context
  percentage, spend, the files it is editing, its sub-work and how long ago it beat. The row is built **once**
  (`whoRowText`), so the TUI row, the `--plain` row and the `transcript.log` row are the same string; columns drop
  right to left as the terminal narrows and the 40-column form keeps `● mbp  step 7/40 propose  beat 2 s`.
  `/who --all` adds sessions gone more than ten minutes and ignored devices. `jevcode sessions who [--all]
  [--json]` is the machine twin — `--plain` with no TTY renders the 120-column form.
- **`/peers`** — the counts view: `peers · 2 here, 1 stale`, the oldest start and whether one holds an exclusive
  lease. Never a pid, never a path, never a label; `/who` is the detailed view and the row says so.
- **`/tell <target> <text>`, `/headsup <text>`, `/request <target> pause|end|steer [<text>]`, `/inbox`** — the
  messaging verbs. A `request` raises a **persistent** row at the far end (it needs an answer); a `headsup` is a
  toast that expires. A body that looks like a key is held behind `that message looks like it contains a key —
  [y] send anyway  [n] edit  [Esc] cancel` before anything is written, and the body goes through the run's
  redactor either way.
- **`/pause [now] [<target>]` and `/end [now] [<target>]`** — both widened to take a target, so they reach another
  session as well as this one. `/end` is destructive: reached through the palette it takes a confirm row whose
  Enter is inert, and afterwards `/resume <id>` needs `--force`.
- **`jevcode sessions <verb>`** — seventeen verbs, each a thin wrapper that starts no engine:
  `list · reindex · prune · unlock <id> · who · pause · resume · end · tell · headsup · request · inbox · label ·
  pair · unpair · gc · sync`. **In this build the thirteen new verbs answer `the session ledger is not available
  in this build` and exit 2** — the verb surface parses and is documented, and the ledger it needs is not
  constructed in production yet (`docs/STATUS.md`, "Round 5").

The status line carries the zone `⇄ 2 live · 1 heads-up · ✉ 1` at 80 columns and above (the heads-up clause needs
100). It is a status **line**, never a transcript item; the same facts reach `transcript.log` through `/who`'s
block or a `[session]` item.

## The context meter: `/context` and `/compact` (round 5)

Under the relaxed context view the status line carries a `ctx` cell from 80 columns (`ctx 41%`) and its full form
from 100 (`ctx 41% · 6 files · 12 steps`); at or past the amber and red thresholds the percentage is replaced by
the word, with `/compact now` named as the action. Below 80 columns the cell is **absent**, never a placeholder.

- **`/context`** prints one block from three reads that already exist: the prompt budget against the model's
  window and the estimated cost per step, the recent-step split (`2 whole, 4 clipped, 6 one-line`), prompt-build
  and file-refresh milliseconds, the rolling summary and its age, and the files in view with **why** each is there
  (`read at step 4 · edited step 6`, `pinned by you`). It has three distinct empty states, not one: no live run,
  a mode that builds no relaxed context (the sentence names the escape), and no prompt built yet. There is no
  `jevcode context` verb, so `/context` has no `--json` of its own — the machine-readable form is the
  `ContextUsage` object `--json=verbose`'s `status` event already carries.
- **`/compact`** folds the history into the rolling summary at once, and it is **live-only**: folding history so
  the *next* prompt fits is meaningless with no next prompt. When the fold happens the engine's own
  `compaction: 41230 → 12840 prompt chars (code); 4 steps folded …` notice reports it in all three sinks and the
  command says nothing more. Otherwise it answers one of three sentences — `compaction is off for this run
  (context.compaction) — jevcode config set context.compaction code turns it on`, `nothing to compact — only the
  newest step is in history`, or `the run is no longer live — /compact needs a live run`.

`context.mode · context.compaction · context.kept · context.compactEvery · context.historySteps ·
context.fileCacheBytes · context.budgetChars` are config rows (`jevcode config`, `JEVCODE_CONTEXT_*`).
`context.kept: jev` is **accepted and printed but not wired in this build**, and its description says so.

## The agent tree, import and the model picker (round 5, honest state)

Three round-5 surfaces are **built and registered but not driven by a store in this build**, which is a deliberate
state rather than a hidden one — every command answers out loud instead of doing nothing:

- **`/agents` (Alt+A), `/agent <slug> <verb>`, `/split`, `/land`, `/spawn`** answer
  `<verb> is not available in this build — no agent is running` until an agent supervisor exists. The `'a'` pane
  tab, its eight keys and the collapsed `agents` status strip appear the moment rows do, and are invisible until
  then. `jevcode agents list [--json]` reads a run's manifest and prints one `planned` row per agent.
- **`/import` (`/imp`) and `/memory` (`/mem`)** are registered and point at the surface that works:
  `jevcode import [<source>] [--dry-run | --yes] [--scope user|project|both] [--resume <id>] [--undo <id>]`
  plans, reviews and applies from the CLI. See [`docs/IMPORT.md`](IMPORT.md).
- **`/model`** with no argument still shows the current and pending model; the dedicated pane-slot picker is
  built (`src/tui/models/**`) and not yet mounted in the shell. `jevcode models [list|search <query>|refresh]
  [--provider <id>] [--json|--plain]` is the CLI twin and works today — `list` and `search` read the disk cache
  and the bundled snapshot, `refresh` is the only verb that goes to the network.

`--provider` now accepts all seven ids (`anthropic`, `openrouter`, `openai`, `gemini`, `xai`, `fireworks`,
`meta`) everywhere it appears — the two-name wall is gone from `/provider`, `jevcode login --provider` and the
argv validator alike.

## Money

Two caps: the **run cap** (`--spend-cap`, `limits.spendCapUsd`, default $10.00 under the default `jev-on` and $1.00
under `jev-only`) and the **session cap** (`--session-spend-cap <usd|none>`, `session.spendCapUsd`, default 5 × the run
cap, so $50.00 or $5.00). The session meter exists from startup and every chat message's intake request is charged to
it (`sess $0.00/1.25 ok` moves by about $0.00007 per greeting; a jev-only lookup ≈ $0.00005; an LLM turn at the
generator's price); every run's meter is a child of it with cap `min(runCap, remaining)`, and the accumulated chat
spend carries into the first run's totals. The status line shows both (`run $1.60/2.00 high  sess $4.11/10.00 ok`);
at 50, 80 and 95 % of either cap a `[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps
left at $0.040/step` item and a toast appear (`--no-budget-warnings` / `JEVCODE_BUDGET_WARNINGS=0` mutes the toast and
bell only; the item and the JSON event stay). At the session cap a chat message is refused before any request
(`[jevcode] The session cap ($1.25) is reached, so I'm not sending anything to Jev. Raise it with /budget
session-spend-cap <usd>, or /new for a fresh session.`), and an LLM answer that would pass it is refused too.

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
  is bounded by a token cap instead (`--max-generator-tokens`, default `spendCap / 15 × 1e6` ≈ 667k for $10.00;
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

Keys are entered only through the masked wizard — inside the console in the boxed tier under `setup · jev provider` /
`setup · jev key` / `setup · provider` / `setup · generator key` / `setup · verify` / `setup · trust` (the step name is
the console's title while the wizard is up) — or `jevcode login`, never as command-line arguments (`jevcode config set
generator.apiKey …` is refused). A jev-only first run
asks for the Jev key only: `No Jev key found. Where do you reach Jev?` / `1 typesafe (TYPESAFE_API_KEY,
api.typesafe.ai)   2 openrouter (OPENROUTER_API_KEY, also the generator)` (skipped when a provider is already
inferred) → `Jev API key (TYPESAFE_API_KEY)  1/1` on a masked `› •••••` row → `[setup] saved <path> (mode 0600, dir
0700)` → an optional verification with one priced Jev decision (`one Jev decision at api.typesafe.ai ~$0.00002
(jev-1.13.0)`) on an explicit `y`; a `jev-on` start, or `/mode jev-on` without a generator key, adds the generator
steps (`jev+llm needs a generator. Pick the provider:` → the masked generator key). Ctrl-C in a wizard opened at
startup prints the fix block (`export TYPESAFE_API_KEY=…` / `export OPENROUTER_API_KEY=…` / `printenv TYPESAFE_API_KEY |
jevcode login --jev-provider typesafe --jev-key-stdin` / `jevcode login`, plus `export ANTHROPIC_API_KEY=…` only when
the mode needs a generator) and exits 2; in one opened by `/mode` or `/login` it just closes (`Keys are never shown,
logged or echoed · Esc back · Ctrl-C keeps jev-only`). `jevcode login [--jev-provider typesafe|openrouter]
[--jev-key-stdin] [--generator-key-stdin]` is the shell twin (a piped Jev key with no provider and nothing to infer it
exits 2 with `jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin`); the provider is written
next to the key (`jevProvider` in the config file), so a TypeSafe key never reaches openrouter.ai. A key pasted into
the composer is text under the gate above. The saved file is read-denied to sandboxed commands; an environment
variable that shadows the saved key is announced once per start (`[config] generator.apiKey: env ANTHROPIC_API_KEY
(sha256:…) overrides file … — unset the variable to use the saved key`), and every known key variable
(`JEV_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) present in the environment is swept by
the redactor whatever the selected provider. Keystroke traces log key classes only.

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

A pane that fails to render is replaced by one row and the run goes on; a failed review pane declines the
review; a failed composer keeps its box and swaps only the interactive input for a masked one-line draft. The
notice is width-aware (TUI-DESIGN-4 §7.12): at ≥ 64 columns `ui: <pane> failed (<Error>) — run continues; see
<log>`, below 64 `ui: <pane> failed (<Error>)` with the log in the item's detail, and with no log open the
`see …` clause is dropped and the detail reads `the run log (start with --log <file>)`. A pane that keeps
throwing is **latched**: the builder is not called again, one item is appended, and it is retried only on the
next run, on `/ui reset`, or when the slot remounts — `ui reset — <n> panes unlatched`, then
`ui: <pane> pane recovered` when it renders again.

A failing checkpoint write is never silent (TUI-DESIGN-4 §7.2): the store reports `ENOSPC`, `EACCES`, `EROFS`,
`EDQUOT`, `EIO` and `ENOENT` once per `<file>:<code>` as
`checkpoint degraded: <code> on <file> — <what it means>; this run cannot be resumed`, the run's exit code
becomes **3** even when the stop reason is `complete`, and the epilogue lists only files that still exist —
with the run directory gone the whole row is replaced by
`files      <dir> — gone (the run directory was removed or became unwritable during the run)`.

A file-system failure at launch names the fix rather than the errno (TUI-DESIGN-4 §7.4): `cannot create the
runs directory <dir>: permission denied` with `set JEVCODE_HOME to a writable directory, or pass --runs-dir
<dir>`; `the disk holding <dir> is full`; `cannot read <path>: permission denied`; `too many open files`. Every
one of them goes through the one fatal path, so it reaches **stderr** with the epilogue and exit **2** (exit 3
for a run directory that disappeared mid-run, and for a disk that filled while writing inside one), never
stdout with exit 1. Which sentence an errno gets is decided by **where** its path is — the config file, the
live run directory, the runs directory — and an errno that is none of those (a workspace file) stays
unclassified and keeps exit 1 rather than being relabelled. An unclassified error keeps the raw message; the
`run with JEVCODE_DEBUG=1 for the stack` row belongs to the renderer's `[ui] error:` fallback and **is not
appended yet** (`DEBUG_STACK_HINT` is exported from `src/cli/fatal.ts` for the App-level site, which is another
slot's file this round).

A submission that has produced no `run:start`, no `thinking` phase change and no stream byte for 45 s appends
`the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave`; the deadline is
monotonic, so an NTP jump can neither fire it early nor suppress it. A second Ctrl-C always ends the process,
and `Ctrl-C` with nothing to abort says `nothing to abort` instead of wedging the state.

Every run end and every fatal path prints the epilogue — `jevcode: stopped — <code>: <msg> (exit N)` with the
message redacted, then the `run`, `files`, `resume` and `report` rows — on stderr in one-shot mode and as a
`[ui]` item in a session.

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

Round 4 (TUI-DESIGN-4 §7.7) makes the bundle the one a TUI bug actually needs. It also copies `state.json`
(the file the epilogue calls the important one), `jevcode.log.1` (the rotated half — before this, a rotation
lost the crash), `ui.json`, the last 200 `decisions.jsonl` rows and the effective `keybindings.json`. Every
copied file is capped at **2 MiB head + 2 MiB tail** with a `… <n> bytes elided (original <m> bytes) …` marker
between them and is redacted **line by line**, so a multi-hour `transcript.log` of hundreds of megabytes no
longer becomes one string at the moment you are filing a bug. `versions.txt` adds `isTTY`, `LANG`, `LC_ALL`,
`TZ`, `COLORTERM`, `NO_COLOR`, presence booleans (never values) for `SSH_TTY` / `TMUX` / `STY`, and a `launch`
block with the resolved tier, fps, `renderMode`, `renderer`, `ascii`, `screenReader`, `reducedMotion`, `plain`
and `theme` — the variables that decide which frame you were looking at. `README.txt` is written **first**
carrying `(bundle incomplete)` and rewritten last without it, so a bundle interrupted by a full disk is
self-describing (and exits 3 with the §7.4 explanation). The command prints the total size and the one-line
`tar -czf <id>.tgz -C <parent> <id>` that turns the directory into an attachment.

The session index has its own health (TUI-DESIGN-4 §7.6). `jevcode sessions` folds only the last **8 MiB** of
`~/.jevcode/sessions/index.jsonl`, read from the end and starting at the first complete line — the index is
append-only and time-ordered, so its tail is what the picker needs, and a 200 000-line index now folds in
under 100 ms instead of 581. Lines it could not read are counted by reason and reported:
`<n> index lines were unreadable and skipped — run jevcode sessions reindex`; an index past 8 MiB adds
`the session index is <n> MB — jevcode sessions prune keeps the recent ones`. An index full of garbage no
longer looks like a fresh install. A run written by a newer JevCode is refused by name rather than read as
corrupt — `run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with
jevcode upgrade` — and `jevcode sessions reindex` counts it separately; `jevcode report` still bundles it,
because a support bundle for an unreadable run is exactly what you want.

Two instances in one workspace now know about each other (TUI-DESIGN-4 §7.10). The status line carries
`<n> here` (and `· <n> stale` beside it) — the **count only**, never a pid and never a path, and the first
segment dropped when the row runs short. The segment appears only when another instance is **live** in this
workspace: dead registry rows do not make a workspace shared, so a `1 here · 2 stale` snapshot shows nothing on
the status line and the stale count is reported by `/peers` and by the blocking pane, which is where
`[c] continue` is. A session that opens beside another gets one item, `another jevcode is working in this
workspace (started 4m ago) — /peers lists them`; and `/peers` prints a block with one row per peer. With the
registry absent this build says so in one row rather than pretending.

## Exit codes

| Situation | `jevcode run` | session |
| --- | --- | --- |
| `complete` / `generator_done` / `answered` | 0 | item `exit 0` (an `answered` reply shows only its prose); the composer reopens |
| a budget stop (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `replan_stop`, `impossible`, a pause (`human_pause`), `stuck` (the agent's loop detector tripped a sixth time) | 4 | item `exit 4`; the composer reopens |
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

**Below 3 rows JevCode is scrollback-only**: there is no dynamic row to allocate, so the composer is alive but
has no row to draw in (`layout.ts`'s `static-only` tier). The one `<Static>` item written at the size drop is
what tells you; grow the terminal and the composer reappears with your draft intact.

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
| Terminal.app (macOS) | *Profiles → Keyboard → Use Option as Meta key*. No OSC 52 or OSC 9: `/copy` goes through `pbcopy`, notifications are BEL. The default Basic profile is black on white and Terminal.app sets no `COLORFGBG`, so the pink theme cannot detect it: `jevcode config set ui.theme light` once (or `/theme light` for a session). |
| VS Code integrated terminal | Alt chords work when `terminal.integrated.macOptionIsMeta` is on (macOS). OSC 52 works locally but not over Remote-SSH (native tool first). Without `TERM` the colour decision follows `FORCE_COLOR`. Huge pastes may drop characters in xterm.js: paste into a file and `@`-mention it instead. |
| Ghostty, kitty, WezTerm | The kitty keyboard protocol is never requested, so their Shift+Enter still needs Ctrl+J or `\`+Enter. kitty gets OSC 99 notifications, the other two OSC 9. |
| Alacritty, foot | Plain xterm-style keys; OSC 52 write supported; foot shows OSC 9 notifications, Alacritty falls back to BEL. |
| tmux 3.4+ | Colours are limited to the 16 ANSI names inside tmux by design. For notifications and `--osc52` through tmux set `set -g allow-passthrough on` (and `set -g set-clipboard on` for the clipboard). A lone Esc waits 30 ms for an Alt chord; tmux's own `escape-time` adds to it, so set it low (`set -sg escape-time 10`). |
| ssh / mosh | `SSH_TTY` or `SSH_CONNECTION` lowers the frame rate to 15 fps (`--fps` overrides) and sets `ui.wordmark` to `static` (the resting mark without the sweep; `jevcode config set ui.wordmark sweep` overrides). mosh does not pass OSC 52 or notifications; expect BEL only. |
| Linux console (`TERM=linux`), `TERM=dumb` | ASCII glyphs are selected automatically (`--ascii` / `JEVCODE_ASCII=0` override); `TERM=dumb` selects the plain renderer. |
| Windows | Not tested. The design is ConPTY terminals with `--sandbox none` and sandboxed runs under WSL 2; the credentials file prints `(Windows: protected by your user profile ACL)` instead of being chmod'ed. |

**Accessibility and rendering flags.** `--screen-reader` (`JEVCODE_SCREEN_READER`; `INK_SCREEN_READER`)
replaces bars and the spinner with text, numbers every prompt (`Enter selection (1-N):`), turns notifications and
reduced motion on, and implies `--plain` on a pipe (the design's opening item `[screen reader mode: on via …]` is not
emitted by this tree — `docs/STATUS.md`, "Interactive TUI" deviations).
`--no-animation` / `--reduced-motion` (`JEVCODE_REDUCED_MOTION`) uses a static `◆` spinner with a 1 Hz clock, mounts the
resting wordmark from frame 0 and runs no idle sweep.
`--ascii` swaps every glyph (`─` → `-`, `✓ ✗` → `+ x`, `⎇` → `br`, bars → `#`). `--theme
dark|light|daltonized|ansi` (`daltonized` swaps red and blue for review/block; `ansi` never dims); `/theme`
changes it for new items. `--fps 5..30` and `--render-mode standard|incremental` are fixed at launch (flag > env >
default; a value in the config file is reported as `ignored:launch` by `jevcode config`). `--title` /
`JEVCODE_TITLE` / `ui.title` resolve (`jevcode config` lists `ui.title`) but are opt-in OSC 2 title (set at session start, cleared on exit)
wired — see `docs/STATUS.md` ("Interactive TUI", deviations).

## Development notes

`--mock` runs a scripted generator and decider offline: the mock decider classifies chat messages by shape
(`JEVCODE_MOCK_INTAKE=<kind>` forces the intake's answer, `JEVCODE_MOCK_JEV_MS=<ms>` delays it), and the scripted
run trajectory is a generator trajectory, so a mocked *run* says `--mode jev-on` explicitly, whatever the default is (under
`jev-only` the real synthesizer runs instead); `JEVCODE_MOCK_REVIEW_AT=<step>` puts that step in the review band so the card can be
exercised. `sh test/pty/run-smoke.sh [scenario…]` drives the built bundle (`npm run build` first) through
`scripts/pty/drive.exp` in a real pseudo-terminal across 36 scenarios — every child runs from its own workspace under
an isolated `HOME` / `XDG_CONFIG_HOME` / `JEVCODE_HOME` with `JEVCODE_CONFIG` and every key variable unset, so neither
the repository's `.env` nor a saved login in `~/.config/jevcode/config.json` is ever read (`run-smoke.sh --hermetic`
proves it against a planted legacy file) — and asserts exit codes, the zero-clears rule per
geometry segment (`resize`, `resize-live`, `chrome-tiers` may clear once per shrink), the exit string exactly once,
and scenario-specific checks: `chat-hi` records the Enter → `[jevcode]` wall time from the driver's timing file and
gates it at 1.5 s, `chat-task` asserts the compact transcript (a `[step 1]` line, no stage lines, no `[run] ready`),
`splash` / `splash-wide` / `splash-reduced` count wordmark cells before and after the first key's frame,
`splash-settle` lets the splash settle by itself (≤ 15 wordmark frames, none at or after the brand row),
`chat-ambiguous` / `chat-ambiguous-flat` (12×60) check that the intake card stays open through a pre-arm Enter until
`n`, `review-y` sends Enter on the armed review card before `y` and counts exactly one approval, `mode-switch` /
`mode-switch-keyed` run without `--mock` under a fake key and `JEVCODE_ASSERT_NO_NETWORK=1`, `zero-arg-wizard` runs
with no key at all. `PTY_AUTO_REVIEW=y` makes the driver answer review cards; `npm run test:pty` runs the vitest
project of the same kind (`test/pty/*.pty.test.ts`, macOS, sequential, rebuilds a stale bundle first; 30 round-1
tests moved to the round-2 sentinels plus the 33 of `test/pty/round2.pty.test.ts`, 4 of which are `it.fails` records
of open defects — run results in `docs/STATUS.md`, "Round 2"). `JEVCODE_TRACE=<file>` records startup and run-lifecycle checkpoints (key classes only, never a key or a
draft); `JEVCODE_FAULT` injects one typed fault (TUI-DESIGN-4 §7.11) — `render:<pane>[:lines][:sticky]` ·
`persist:<ENOSPC|EACCES|EROFS|ENOENT>[:after=<n>]` · `rundir:rm[:after=<n>]` · `submit:hang` ·
`jev:429[:<s>]|jev:401|jev:5xx:<n>` · `net:ENOTFOUND|ETIMEDOUT|ECONNRESET[:mid-stream]` ·
`stdout:EPIPE[:after=<n>]` · `clock:jump:<±s>[:at=<n>]` · `index:corrupt|index:huge:<n>` ·
`config:<truncated|wrong-type|unreadable>` · `loop:hog:<ms>` · `peer:<n>`. The `:sticky` variant of
`render:` throws on **every** render, which is what the per-pane latch has to survive. The parser and its loud
rejection — the value, then the twelve-row grammar, written to stderr **before Ink mounts** so a typo in CI
fails the test instead of silently measuring the unfaulted frame — are `readFaultEnv()` in `src/tui/faults.ts`;
**the pre-mount call site is not wired yet** (it belongs in `src/cli/main.tsx`, another slot's file this round),
so today an unknown value is still a silent no-op at run time and only the unit test enforces the grammar. Of
the thirteen scenarios only the `render:<pane>` family has a consumer in the tree; the rest parse and are
reported as "not driven" by `npm run perf`. `JEVCODE_ASSERT_HEIGHT=1` is likewise read by `readFaultEnv` and
**has no consumer yet**; the frame-height gate is enforced by `src/perf/render-lag.ts` and `run-smoke.sh`
instead, on every capture. `node
scripts/gen-docs.mjs` regenerates `docs/KEYS.md`, `docs/COMMANDS.md`, the man page and the completions; `--check`
reports what is stale.
