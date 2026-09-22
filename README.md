# JevCode

A coding-agent harness where **Jev makes every decision** and **Claude writes the code**.

JevCode hands every control-flow decision to Jev (`jev-1.13`, a calibrated decision model,
reached natively at TypeSafe — `jev-1.13.0` — or through OpenRouter's decisions endpoint —
`typesafe/jev-1.13-20260917`): what a step is for, which files matter, whether a proposed action
is safe to run, whether its output succeeded, whether the task is done, how to recover from a
loop — and, in a session, what you meant by what you typed. By default (`jev-on`, badge `jev+llm`)
the code model writes the code and Jev decides every step: one OpenRouter key serves Jev
(`openrouter.ai/api/alpha/decisions`) and the default generator (GLM 5.3 Flash; Claude Sonnet 5
through Anthropic or OpenRouter with `--provider` / `--model`). `--mode jev-only` runs with no
generating LLM at all — code proposes candidate fixes, Jev decides, tests verify. Either way the generator
behind one `Provider` interface while Jev still decides every step. Code owns budgets,
sandboxing, thresholds, arithmetic and checkpoints. One Ink TUI is an interactive session: a
conversation-shaped transcript (`[you]` / `[jevcode]` bubbles, one line per step), a rounded
console holding the composer and a three-zone status bar with the mode badge, a collapsed Jev
panel that opens to every answer's probability, confidence and the code rule that consumed it,
and a ≤ 700 ms startup splash whose first frame is the first frame.

Design: [docs/DESIGN.md](docs/DESIGN.md); the interactive TUI: [docs/TUI-DESIGN.md](docs/TUI-DESIGN.md)
(round 1) and [docs/TUI-DESIGN-2.md](docs/TUI-DESIGN-2.md) (round 2: defaults, providers,
conversation, visual redesign, splash), [docs/TUI.md](docs/TUI.md) (user guide), with the generated
[key](docs/KEYS.md) and [command](docs/COMMANDS.md) tables. Research with sources and fetch dates:
[docs/RESEARCH.md](docs/RESEARCH.md), [docs/research/tui/](docs/research/tui/). Decisions and deviations:
[docs/DECISIONS.md](docs/DECISIONS.md), DESIGN.md §16–§19, TUI-DESIGN.md §22, TUI-DESIGN-2.md §10.

## Install

Requires Node 22.12 or newer (the repository pins 22.23.2 in `.nvmrc`; `engine-strict` is on),
`git` and `/bin/sh`. Python 3 is needed only by the benchmarks. The package has **zero runtime
dependencies**: `ink` and `react` are inlined into the single bundle `dist/jevcode.mjs` at build
time, so an install adds one package and nothing else (`THIRD_PARTY_LICENSES.txt` carries the
bundled attributions).

From this repository (the path that works today):

```sh
git clone <this repo> && cd JevCode
npm install
npm run build          # bundles dist/jevcode.mjs, runs a first-frame smoke test, writes THIRD_PARTY_LICENSES.txt
npm link               # optional: puts `jevcode` on PATH
jevcode --version      # jevcode 0.1.0
```

From the registry and the Homebrew tap, once 0.4.0 is published (the release procedure is
[docs/RELEASE.md](docs/RELEASE.md); as of 2026-09-21 the package is prepared, not published,
and `Formula/jevcode.rb` still carries its placeholder `url`/`sha256`):

```sh
npx jevcode                      # one-off, no install
npm install -g jevcode           # installs exactly one package
brew install <owner>/jevcode/jevcode   # the tap formula: man page and completions included
jevcode upgrade [--check]        # later: delegates to the manager it was installed with (npm, brew, bun, pnpm, yarn)
jevcode completion bash|zsh|fish # static completion scripts; `man jevcode` ships in the package
```

One key is enough. In the default `jev+llm` mode one OpenRouter key runs Jev and the code model:
the first-run wizard (a bare `jevcode` opens on one masked `OpenRouter API key` field under the
wordmark and writes the four file keys from one paste into `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`
with mode 0600; Esc on the empty field lists the other ways to start — `1 OpenRouter · 2 TypeSafe ·
3 Jev only · 4 Anthropic`, where `3` persists `mode: jev-only`; a resolving TypeSafe, Jev or Anthropic
key gives the field a found-title and saves only the missing half), `jevcode login [--key-stdin]`
(masked prompt on a terminal; the one-key stdin form on a pipe; `--jev-provider typesafe|openrouter
--jev-key-stdin --generator-key-stdin` for the two-key forms), `./.env` (see `.env.example`), or the
environment. Verification (`y` at the wizard's prompt, or `jevcode login --verify`) sends one priced
Jev decision (~$0.00002), one 1-token completion and `GET /api/v1/key`, and names one of four outcomes
(ok · rejected · no credits · unreachable · unknown model). Keys are never accepted as command-line
arguments in the interactive flow and `jevcode config set` refuses secret settings.

```sh
OPENROUTER_API_KEY=sk-or-v1-...     # one key: Jev through OpenRouter's decisions endpoint AND the code model (the default)
TYPESAFE_API_KEY=...                # Jev, natively at api.typesafe.ai (preferred for Jev whenever set; add OPENROUTER_API_KEY for the code model)
OPENAI_API_KEY / GEMINI_API_KEY (or GOOGLE_API_KEY) / FIREWORKS_API_KEY / META_API_KEY (or MODEL_API_KEY) / XAI_API_KEY
                                    # other code-model providers; the model picker lists a provider once its key is present
JEV_API_KEY=...                     # Jev through OpenRouter when it is not the OpenRouter key (keeps the openrouter provider)
ANTHROPIC_API_KEY=sk-ant-...        # the code model via --provider anthropic
```

## Run

```sh
jevcode                                           # interactive session in the current directory (= jevcode chat), jev+llm: one OpenRouter key, nothing runs until Jev reads a task
jevcode --mode jev-only                           # the same session with no generating LLM (Jev alone, $0.25 cap); /mode jev-only switches inside a session
jevcode run "Fix the failing tests in tests/test_core.py without changing the tests." \
  --workspace /path/to/repo --provider openrouter --model anthropic/claude-sonnet-5
jevcode run --task-file todo.md                   # the task from a file
jevcode run --resume 20260920-191506-5gnampki     # continue a checkpointed run (or --resume "<session title>")
jevcode -c                                        # continue the most recent session of this directory
jevcode --list-sessions                           # print this directory's sessions and exit
jevcode chat --plain                              # the same session over a plain readline prompt
echo "task text" | jevcode run --plain --workspace .   # a pipe: plain line output, prompts take their safe default
jevcode run "…" --json                            # NDJSON event stream on stdout (schema jevcode.events/1)
jevcode config                                    # resolved config with the source of every value, secrets fingerprinted
jevcode sessions list|reindex|prune|unlock <id>   # the session index
jevcode sessions who [--all] [--json]             # every jevcode session on this repo and what each is doing
jevcode models list|search <query>|refresh        # the model catalogue (list/search are offline; refresh fetches)
jevcode import [<source>] [--dry-run]             # memory, commands and MCP from the other agents on this machine
jevcode agents list [--json]                      # the agents of a run, from its manifest
jevcode report <id>                               # redacted support bundle under ~/.jevcode/reports/<id>/ (nothing is sent)
                                                  #   run.json, state.json, transcript.log, jevcode.log(+.1), ui.json,
                                                  #   decisions.jsonl (tail 200), keybindings.json, versions.txt — every
                                                  #   file redacted line by line and capped at 2 MiB head + 2 MiB tail
jevcode why <id> <step> <ref>                     # explain one Jev decision of a stored run
```

`jevcode --help` lists every command; `jevcode <command> --help` its flags. A bare `jevcode`,
or a leading flag, is `jevcode chat`; `jevcode run` with no task on a terminal opens the session
too — both in the default `jev+llm` mode, with the mode badge in the first frame. Exit codes are tabled below (the
checkpoint is written first in every case).

## Interactive session

A bare `jevcode` draws its first frame from the command line alone — the header, the rule, the
first frame of the startup splash (the `J` of the wordmark and its sweep head; the whole ≤ 700 ms
reveal follows and settles into the resting mark — `JEV` in TypeSafe pink, `CODE` dim, the caption
`◆ 0.4.0` on its last row and, at ≥ 104 columns, the tagline `Decisions, not strings` — which stays
on screen whenever the session is idle and gives way to the run's panel while a run is live; a key
completes the reveal instead of killing it) and the rounded console: `╭─ jev+llm ──── <dir> ─╮` with
the mode badge, the composer row `› Say hi, ask a question, or describe a task…`, a divider and the
status compartment `idle … step 0/–  ? help`
— before any configuration file, `.env`, the runs directory or git is touched (the round-1 frame
measured 82–87 ms in the pty smoke and cold p95 110.4 ms in `jevcode perf`; the gate is < 300 ms and
the round-2 numbers are in [docs/STATUS.md](docs/STATUS.md), "Round 2"). Nothing runs, and no money
is spent, until Jev has read what you typed as a task. [docs/TUI.md](docs/TUI.md) is the full guide;
the short version:

- **Conversation.** Every line you submit is a `[you]` bubble first, then one Jev request decides
  what it is: a greeting or small talk (`hi` → `[jevcode] Hi. I'm ready when you are — describe a
  change you want in <dir>, or ask what I can do.`), a question about JevCode itself (answered from
  the session's own facts — mode, keys, cost, the last run, the last tests, the sandbox, the commands,
  the Jev provider), a question about the code (in `jev+llm` one generator turn, streamed; in
  `jev-only` a Jev-selected lookup of likely places), or a task — and only a task Jev is sure of (its own
  p ≥ 0.6) starts a paid run. Anything weaker asks `run this as a task?` with `[y] run it   [n] just
  chatting   (Esc keeps the text; Enter does nothing)`. While Jev reads it the status word is `▓ thinking`
  (the pink shade pulse; `◆ thinking` under reduced motion) and the composer reads `(thinking…)` from the
  first frame after Enter; Ctrl-C once stops the request. The intake costs about $0.00007 per message and is charged to the
  session meter. No keyword list ever starts a run.
- **Other sessions.** `/who` lists every `jevcode` on this repo with its branch, step, stage, mode, context and
  spend, one row each, at 40, 80 and 120 columns; `/peers` is the counts view; `/tell`, `/headsup`, `/request`
  and `/inbox` are the messaging verbs, and `/pause` and `/end` take a target. The status line carries
  `⇄ 2 live · 1 heads-up · ✉ 1` from 80 columns. Nothing ever blocks a step: `coordination.claims` is `advisory`
  by default, so an overlap is a fact and a notice, never a wait. In this build the thirteen new
  `jevcode sessions <verb>` verbs parse and answer `the session ledger is not available in this build`.
- **Context.** `/context` prints the prompt budget against the model's window, the recent-step split, the rolling
  summary and the files in view with why each is there; `/compact` folds the history now. The status line carries
  `ctx 41%` from 80 columns and `ctx 41% · 6 files · 12 steps` from 100, with the amber and red words replacing
  the percentage. See [docs/TUI.md](docs/TUI.md).
- **Import.** `jevcode import` brings your memory, rules, slash commands and MCP servers over from claude-code,
  codex, cursor and eight other tools — a plan, a review, then only what you accept; an MCP server is always
  imported **disabled** and a credential row always needs a terminal. See [docs/IMPORT.md](docs/IMPORT.md).
- **Mode.** `llm-jev` by default (badge `llm+jev · verified`): the code model writes candidate patches inside
  the Jev-only search, tests verify them and Jev localises, ranks and arbitrates — no candidate lands without a
  passing test. `/mode jev-on` (badge `jev+llm`: the code model writes the code, Jev decides every step),
  `/mode jev-only` (Jev alone, $0.25 / $1.25 caps) and `/mode jev-off` switch the next run; when no code-model
  key is configured the wizard's provider and generator-key steps open inside the console; `jevcode config set
  mode <m>` persists it; `/mode` alone shows the current and next mode. A keyed start prints the `[setup] mode
  llm+jev · verified (default) — caps $2.00 per run · $10.00 per session; …` item once. Why this default (same
  28 tasks — QuixBugs 10, ladder short tier 12, SWE-bench Verified 6 — same code model, one run per arm):

| arm (tree) | pass | correct (22 cheap) + SWE | wall median / mean | $ total (gen + Jev) | $/solved | steps mean |
|---|---|---|---|---|---|---|
| jev-off, generator-only (2a92d0b) | 19/28 | 16/22 (0 overfit) + 3/6 | 391 s / 480 s | $0.506 ($0.506 + $0) | $0.027 | 10.8 |
| jev-off-tuned, generator-only (066816f) | 22/28 | 16/22 (2 overfit) + 4/6 | 111 s / 128 s | $0.243 ($0.243 + $0) | $0.011 | 13.6 |
| llm-jev v1 (626fc40, outage runs re-run) | 23/28 | 17/22 (5 overfit) + 1/6 | 80 s / 114 s | $0.302 ($0.072 + $0.231) | $0.013 | 3.6 |
| **llm-jev v2 (066816f)** | **28/28** | **20/22 (2 overfit) + 6/6** | **62 s / 77 s** | **$0.144 ($0.046 + $0.099)** | **$0.005** | **3.1** |

  Discordant pairs on pass: v2 vs baseline 9–0, v2 vs tuned 6–0 — 0 discordant losses on pass; 2 on correctness (`detect_cycle`, `stats`), both fixed since. Wilson 95 % for 28/28 is [88 %, 100 %]. Footnotes: (a) wall — the pooled medians include ten baseline runs that hit the hard cap; on the 19 tasks both arms solved the median is 35 s vs 112 s (0.31×), and against the tuned arm the per-task median ratio is 0.84 (v2 slower on 9 of 22); (b) cost — 37 of v2's 100 generator rows are estimated (30 % of its generator cost) and Jev's $0.099 is table-rated (the TypeSafe endpoint returns no cost). Caveats: one run per arm; guard thresholds were tuned on some of these programs (LLM-JEV-DESIGN §7 disclosure); the SWE evaluator is unofficial. Verification: experiments/results/llm-jev-headtohead-v2.verification.md (every number reproduces). Re-run on the same build (experiments/results/llm-jev-headtohead-v2.oos.md, 2026-09-22): a second run of the plain baseline arm scored 21/28 — six tasks flip between two runs of the same arm, so baseline noise is about ±2; against it v2 is 7–0 on discordant pairs (p = 0.0078), 26 vs 20 correct, 0.225× wall and 0.245× cost on the tasks both solved. **Out of sample:** the first untuned slice (22 tasks, experiments/results/llm-jev-headtohead-v2.oos.md) was a tie on pass at 2.7× the cost; two harness iterations driven by that analysis (experiments/results/llm-jev-iter1.md, experiments/results/llm-jev-iter2.md, both 2026-09-22) then read, on a fresh untuned slice of 18 tasks, **llm-jev 14/18 vs the tuned generator-only arm 9/18** (5–0 discordant, exact sign p = 0.031), SWE-bench 2/4 where iteration 1 had 0/4, the in-sample 28 back at 27/28, cost flat; on QuixBugs the mode is still about 1.16× slower per task at 0.28× the cost. The `verified` badge refers to the same-build claim above, not to out-of-sample correctness. The harness-overhead perf probe stays pinned to `--mode jev-on` (its gate is defined on that loop); an llm-jev `--mock` row is reported until a measured budget exists.
- **Composer.** A multi-line, readline-style editor: Ctrl+A/E, Alt+B/F, Ctrl+K/U/W/Y, Ctrl+T,
  100-step undo (Ctrl+_), Up/Down through history on the first/last row, Ctrl+R incremental
  history search, Tab completion (never focus). Ctrl+J, Alt+Enter or a trailing `\` insert a
  newline (`Shift+Enter` is listed in [docs/KEYS.md](docs/KEYS.md) but needs a keyboard protocol JevCode never
  requests, so treat it as inert). Ctrl+G edits the draft in
  `$VISUAL`/`$EDITOR`; Ctrl+L repaints; Ctrl+Z suspends; Ctrl+O appends the last step's decision
  details; `?` or F1 appends the help block. Pastes over 3 lines or 800 characters become chips
  (`[Pasted #1, 541 lines]`) whose bodies never touch disk. The whole table is
  [docs/KEYS.md](docs/KEYS.md); `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` rebinds
  anything except Ctrl+C, Ctrl+D, Enter, Esc, Tab and the review's `y`.
- **Slash commands.** `/` at the start of an empty draft opens the palette (a `╭─ commands` card in
  the boxed tier); Tab completes; Enter runs a command **only on an exact name or alias** — an
  unknown `/foo` keeps the draft and prints `[ui] error: unknown command /foo; type / to list
  commands`, because a submitted line goes to Jev (and may become a paid run). `@` mentions
  workspace files (the secret denylist is never offered). The table is
  [docs/COMMANDS.md](docs/COMMANDS.md): `/help`, `/new`, `/resume`, `/rename`, `/steer`, `/unsteer`,
  `/pause`, `/abort`, `/undo`, `/rewind`, `/diff`, `/plan`, `/decisions`, `/panel`, `/transcript`,
  `/why`, `/calibration`, `/jev`, `/cost`, `/budget`, `/model`, `/provider`, `/mode`, `/llm`,
  `/config`, `/login`, `/logout`, `/trust`, `/theme`, `/copy`, `/export`, `/status`, `/errors`,
  `/report`, `/history clear`, `/editor`, `/exit`.
- **Sessions, follow-ups, steering, pause.** Every run of one process belongs to a session; after a
  run ends the next Enter is a follow-up seeded from the previous plan, window, created files and
  undo log (`[run] seeded from run <id>: …`). Typing while a run is live and pressing Enter queues a
  steer for the next step (up to 8; `↑` on the first row or `/unsteer` takes the newest back); the
  directives reach the generator and every Jev stage at the next step start. Esc pauses at the
  step boundary (`paused after step N — /resume continues, or type a follow-up`; resumable without
  `--force`), Esc Esc aborts. Ctrl-C with text clears the draft; with an empty draft it aborts a live
  run and stays; twice while idle it exits 0 (Ctrl-D twice too; `/exit` confirms first while live).
- **Picker.** A bare `/resume` opens this directory's sessions in the pane slot: ↑/↓, Enter continues,
  Space previews, Ctrl-A shows all workspaces, Ctrl-R renames, `x` then `y` moves a run directory to
  `~/.jevcode/trash/` (never `rm -rf`), Esc closes; a run held by a live process shows `● live`.
  `/resume <id|title>`, `-c` and `--resume <id|title>` continue directly without it (`-c` takes the most
  recent session here and is a usage error when there is none).
- **Reviews.** When Jev's risk lands in the review band the run pauses under a rounded card
  `╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "…" ─╮` with the four risk gauges,
  `matches_intent` and a preview: `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why
  [esc] decline`. `y` approves **once**; `d` sends a note that reaches Jev and the generator. Never
  offered: approve-always or per-session approval, an Enter default, a timeout that approves, an
  `--auto-decline` flag. The card arms only on the frame after it is drawn, after a second of
  composer idleness, so a key already in flight is text — and the composer is inactive under it.
- **Transcript and Jev panel.** One `[step N] <action> · risk <r> <verdict> · <outcome> · tests
  <p>p/<f>f/<e>e · judge <p> · <wall> · <cost>` line per step by default (`/transcript full` shows
  every stage line for new items; `--plain` and `transcript.log` always carry the full form). The
  Jev panel is a one-row strip under the transcript — `─── ▸ jev s7 · 12 decisions · risk 0.44
  [review] · plan 2/5 ── [d] [p] [t] [s] ──` — and opens to 6 rows with `/panel` or `Alt+J`
  (`/panel full`, `Alt+Shift+J`: 12 — measured 18 dynamic rows at 24×80), tabs `[d]ecisions [p]lan
  [t]imeline [s]ynth` (`Alt+P/T/S`, `/panel d`, or `[` / `]` on an empty draft; `Alt+D` inserts `½`
  into the composer on the tree checked on 2026-09-21 — [docs/STATUS.md](docs/STATUS.md), "Round 2"):
  every answer with its probability bar, derived-confidence marker `~`, near-threshold marker `!`,
  verdict and the code rule that consumed it — the intake's Noul answers included, as `s0 intent
  about_<fact>` rows; the plan ledger (`[x] [?] [ ] [!]`); per-step stage timings; the synthesizer
  strip in `jev-only`. `/why s7.risk.plan_mismatch` (or `w`+digit on a review) prints the worked
  block; the design's `/why intake` answers `no decision intake in the last 3 steps` today (STATUS,
  "Round 2", deviation 16). The screen is never cleared: the transcript is
  your scrollback and the dynamic region never exceeds `rows − 2`; below 16 rows the boxes give way
  to round 1's flat rows with the badge leading the status line (`jev+llm · idle`). The transcript reads as
  a conversation: every label sits right-aligned in a 10-cell gutter (`[jevcode]` and `[sandbox]` flush,
  `[you]`, `[run]`, `[step 7]` padded), every body starts at column 10 and wraps there — at ` · ` before
  spaces, so a step row breaks as `… · risk 0.00 ok` / `· tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006` and
  `exit` / `4` never split; `[jevcode]` labels are pink, `[you]` labels magenta, bodies stay the terminal's
  default colour.

`--plain` on a terminal runs the same session and commands over a `> ` readline prompt; a pipe,
`CI`, `TERM=dumb`, `--no-input` or `--json` runs one task without prompts (every question takes its
safe default: keys missing → the fix block and exit 2, a secret in the task → refused with exit 2,
a review → declined). `--screen-reader` numbers every prompt and replaces bars with text;
`--ascii`, `--no-color`/`NO_COLOR` and `--theme dark|light|daltonized|ansi` are the other twins (`dark` is
TypeSafe's pink — `#f386a1` for what is JevCode or Jev, `#d45bb6` for what is live or selected; a white
terminal announced through `COLORFGBG` gets `light` by default, and Terminal.app's Basic profile, which
announces nothing, wants `jevcode config set ui.theme light` or `/theme light` once). The wordmark's idle
sweep (4 fps peak, 1.6 fps mean, one pass per 10 s while you are attentive, per 30 s after a quiet minute,
asleep after ten) is `ui.wordmark: sweep | static | off` (`JEVCODE_WORDMARK`; `static` by default over
SSH), and off under `--no-animation`, `NO_COLOR` and below 21 rows or 64 columns.

## Money

Two caps: the **run cap** (`--spend-cap`, default $2.00 under the default `jev-on`, $0.25 under
`jev-only`) and the **session cap** (`--session-spend-cap <usd|none>`, default 5 × the run cap: $10.00
or $1.25). Every chat message's intake request is charged to the session meter from the first
one (`sess $0.00/1.25 ok` moves by about $0.00007 per greeting), and at the session cap chat
refuses too (`The session cap ($1.25) is reached, so I'm not sending anything to Jev. …`). The
status line shows both (`run $1.60/2.00 high  sess $4.11/10.00 ok`); at 50, 80 and 95 % of either
an item and a toast warn (`--no-budget-warnings` mutes the toast and bell only). `/budget session-spend-cap <usd|none>`
applies now; `/budget spend-cap|max-steps|max-wall|max-replans|max-generator-tokens <v>` applies to
the next `/resume` or the next run, never the live one; `/cost` and `/budget` show every pending
value. A follow-up that would exceed the session cap asks (`[y] start, run cap clamped to $x.xx
[r] raise session cap   [n]/Esc cancel`; Enter does nothing), and with nothing left refuses (`session
cap reached ($a of $b). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session
with its own cap.`). A run stopped by its cap says how to continue (`continue this run: /budget
spend-cap 3.00 then /resume`). A generator model without a pricing entry fails closed with exit 2
unless `--allow-unpriced` runs it under a token cap (`--max-generator-tokens`, default spend cap /
15 × 1e6; stop reason `token_cap`, exit 4).

## Secrets

Keys never appear in logs, results, checkpoints, prompt history, clipboard payloads, the `--json`
stream or subprocess environments. `jevcode config` and `run.json` show a secret only as its source
and the first 8 hex characters of its SHA-256. Every artefact passes a redactor seeded with every
configured secret, every secret-looking value in every loaded `.env`, and the recognised key formats.

Everything typed or pasted — a submission, a steer, a `/rename` title, a review note, a command
line, and the task from argv, `--task-file` or stdin — passes `detectSecrets` first: the six
redacting formats (`sk-or-v1-`, `sk-ant-`, `sk-`/`sk-proj-`, `AIza`, `ghp_`/`gh[ousr]_`,
`github_pat_`), the exact configured secrets, and nine warn-only families (AWS, Slack tokens and
webhooks, PEM private keys, JWT, Stripe, `npm_`, `hf_`, `glpat-`). A hit shows `⚠ secret?` in the
status line, masks the span as `•` in the composer and asks at Enter: `Looks like this contains a
secret (sk-ant-…). Send anyway? y/N`. Only `y` sends — on a frame after the row was drawn and at
least 150 ms after the Enter — and then every detected span is registered with the redactor
**before** the text reaches the engine, the generator receives the raw text, and the transcript
records `[step n] sent 1 secret to the generator on request`; from then on `transcript.log`,
`steps.jsonl`, `state.json`, the Jev requests, `--json`, history, the session index and
`jevcode.log` read `[REDACTED:…]`. **Caveat:** the registration is per process — a later `--resume`
does not remember it (what is on disk stays redacted). Without a terminal the send is refused:
`jevcode: the task contains a secret (<label>); refusing to start (exit 2)`.

The `--json` guarantee (TUI-DESIGN §8.9): every string on the stream is the engine event after the
configured redactor — configured secrets, `Send anyway`-confirmed values and recognised formats become
`[REDACTED:<name>]` / `[REDACTED:pattern]`; the stream never contains keystrokes, composer drafts,
pasted payloads or key material; a human turn is the `run:start` task line and the `steer:queued`
lines holding the redacted submitted text; `secret-ack` carries a count only. An unrecognised-format
secret typed inline passes through, as in `transcript.log`. Cleared drafts reach history, and the
composer's `ui.json`, only with detected spans replaced by `[REDACTED:draft]`.

## Configuration

Precedence, highest first: **flag → environment variable → `./.env` → `<OPEN_ASSIST_PATH>/.env`
→ config file → default**. `.env` files are parsed with `node:util` `parseEnv` into an
isolated map, never into `process.env`. Validation happens at first use, not at launch, so
the first frame renders with zero network and zero file reads. `jevcode config` prints every
value with its source (`flag`, `env`, `dotenv:<path>`, `file:<path>`, `default`, `derived`);
`jevcode config set <setting> <value>` writes a non-secret key to the XDG config file atomically.
The four **launch settings** (`ui.fps`, `ui.renderMode`, `ui.screenReader`, `ui.ascii`) resolve
flag → env → default only and are fixed when the TUI mounts; a config-file value for them is
reported as `ignored:launch`.

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Generator provider | `--provider` | `JEVCODE_PROVIDER` | `openrouter` (`anthropic` or `openrouter`) |
| Generator model | `--model` | `JEVCODE_MODEL` | `z-ai/glm-5.3-flash` (priced siblings: `z-ai/glm-5.3-flashx`, `z-ai/glm-5.3`; `claude-sonnet-5` with `--provider anthropic`, `anthropic/claude-sonnet-5` on OpenRouter) |
| Generator key | `--api-key` | `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` by provider, or `JEVCODE_API_KEY` | none (wizard / `jevcode login`) |
| Generator base URL | `--base-url` | `JEVCODE_BASE_URL` | `https://api.anthropic.com` / `https://openrouter.ai/api/v1` |
| Generator temperature | `--temperature` | `JEVCODE_TEMPERATURE` | unset: not sent (Sonnet 5 rejects non-default sampling parameters) |
| Generator max tokens | `--max-tokens` | `JEVCODE_MAX_TOKENS` | `4096` |
| Decider provider | `--jev-provider` | `JEV_PROVIDER` | `auto`: `typesafe` when `TYPESAFE_API_KEY` is set (a configured `JEV_API_KEY` keeps `openrouter`), else `openrouter`; a configured `--jev-base-url` of a known host wins |
| Decider base URL | `--jev-base-url` | `JEV_BASE_URL` | by provider: `https://api.typesafe.ai/v1/systemone` / `https://openrouter.ai/api/alpha/decisions` (the other provider's host is refused offline) |
| Decider key | `--jev-api-key` | `TYPESAFE_API_KEY` first under `typesafe`; `JEV_API_KEY`, falling back to `OPENROUTER_API_KEY` | none (wizard / `jevcode login`) |
| Decider model | `--jev-model` | `JEV_MODEL` | by provider: `jev-1.13.0` (the only pinned id TypeSafe serves; `jev-latest` is its alias) / `typesafe/jev-1.13-20260917` (dated id; aliases are resolved and warned about); the other provider's id is refused offline |
| Run spend cap, USD, generator + Jev | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `2.00` under the default `llm-jev` (and `jev-on`, `jev-off`), `0.25` under `jev-only` |
| Session spend cap | `--session-spend-cap <usd\|none>` | `JEVCODE_SESSION_SPEND_CAP_USD` | 5 × the run cap (`derived`); `none` = uncapped |
| Unpriced model allowed | `--allow-unpriced` | `JEVCODE_ALLOW_UNPRICED` | `false` (refuse with exit 2) |
| Generator token cap | `--max-generator-tokens` | `JEVCODE_MAX_GENERATOR_TOKENS` | spend cap / 15 × 1e6 (only under `--allow-unpriced`) |
| Max steps | `--max-steps` | `JEVCODE_MAX_STEPS` | `40` |
| Max wall time | `--max-wall` | `JEVCODE_MAX_WALL` | `30m` (e.g. `90s`, `7h30m`) |
| Max replans | `--max-replans` | `JEVCODE_MAX_REPLANS` | `5` |
| Completion threshold | `--complete-threshold` | `JEVCODE_COMPLETE_THRESHOLD` | `0.85` |
| Impossible threshold | `--impossible-threshold` | `JEVCODE_IMPOSSIBLE_THRESHOLD` | `0.85` |
| Engine mode | `--mode` | `JEVCODE_MODE` (also the config key `mode`; `jevcode config set mode <m>`) | `llm-jev` (candidate patches inside the Jev search, tests verify; badge `llm+jev · verified`) — the default; `jev-only` (no generating LLM; one Jev key); `jev-off` (generator only); `llm-jev` (badge `llm+jev · verified`). `/mode` / `/llm on\|off` set it for the next run |
| Session selection | `-c`/`--continue`, `--resume <id\|title>` [`--force`], `--list-sessions` | — | — |
| Workspace | `--workspace` | `JEVCODE_WORKSPACE` | current directory |
| Runs dir | `--runs-dir` | `JEVCODE_HOME` (runs live in `<home>/runs`) | `~/.jevcode/runs` |
| Open Assist path | `--open-assist-path` | `OPEN_ASSIST_PATH` | sibling `../open-assist` if it exists |
| Config file | `--config` | `JEVCODE_CONFIG` | `./jevcode.json`, else `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` (legacy `~/.config/jevcode/config.json` still read; both present → one warning) |
| Sandbox profile | `--sandbox` | `JEVCODE_SANDBOX` | `auto` (`seatbelt` on macOS, `none` elsewhere) |
| Network for commands | `--no-network` | | allowed |
| Renderer | `--plain`, `--json[=verbose]`, `--no-input` | `JEVCODE_NO_INPUT`; `CI`, `TERM=dumb` select plain | Ink when stdin and stdout are TTYs |
| Theme | `--theme dark\|light\|daltonized\|ansi` | `JEVCODE_THEME` | `dark` (no auto-detect; `/theme` for new items) |
| Wordmark idle animation | — (`jevcode config set ui.wordmark <v>`) | `JEVCODE_WORDMARK` | `sweep` (`static` over SSH); `static` keeps the mark without the sweep, `off` restores the round-2 brand row |
| Frames per second (launch) | `--fps 5..30` | `JEVCODE_FPS` | `30`; `15` under `SSH_TTY`/`SSH_CONNECTION` |
| Render mode (launch) | `--render-mode standard\|incremental` | `JEVCODE_RENDER_MODE` | `standard` |
| ASCII glyphs (launch) | `--ascii` | `JEVCODE_ASCII` (`=0` forces Unicode) | auto on `TERM=dumb`, `TERM=linux`, non-UTF-8 locale |
| Screen reader (launch) | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | `false` |
| Colour | `--no-color` | `NO_COLOR` (mapped to `FORCE_COLOR=0` by the launcher), `FORCE_COLOR` | terminal |
| Reduced motion | `--no-animation` (`--reduced-motion`) | `JEVCODE_REDUCED_MOTION` | `false`; `true` with `--screen-reader` (a static `•` spinner, no startup splash — the brand row from the first frame) |
| Notifications | `--notify` | `JEVCODE_NOTIFY` | `false`; `true` with `--screen-reader` (BEL; OSC 9 / OSC 99 by terminal) |
| Clipboard over OSC 52 | `--osc52` | `JEVCODE_OSC52` | `false` (native tool first; write only) |
| Terminal title (OSC 2) | `--title` | `JEVCODE_TITLE` | `false` (opt-in: one `OSC 2` write `jevcode · <task>` when the session config lands, cleared on exit; control characters stripped, 80 cells) |
| Prompt history | `--no-history` | `JEVCODE_NO_HISTORY=1` | on (`~/.jevcode/history.jsonl`, 1,000 entries) |
| Workspace trust for scripts | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | ask on a terminal; skip instruction files otherwise |
| Budget warnings | `--no-budget-warnings` | `JEVCODE_BUDGET_WARNINGS=0` | on (mutes toast and bell only) |
| `@` mentions of denylisted files | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | `false` (per-mention `y/N` when on) |
| Session exit code | `--exit-code zero\|last-run` | `JEVCODE_EXIT_CODE` | `zero` |
| Keybindings file | `--keybindings <file>` | `JEVCODE_KEYBINDINGS` | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` |
| Log file | `--log <file>` | `JEVCODE_LOG`; `JEVCODE_TRACE=<file>` = the same at level `trace` | `<runDir>/jevcode.log` (fallback `~/.jevcode/logs/`) |
| Log level | `--log-level error\|warn\|info\|debug\|trace`, `--verbose` (= `debug`) | `JEVCODE_LOG_LEVEL` | `info` (file only) |
| Update check | `--update-notify` | `JEVCODE_UPDATE_NOTIFY` | `false` (post-run `jevcode upgrade --check`, detached) |
| Generator prices, USD per MTok | | `JEVCODE_PRICE_IN_PER_M`, `JEVCODE_PRICE_OUT_PER_M` (cache: `JEVCODE_PRICE_CACHE_READ_PER_M`, `_WRITE_PER_M`, derived 0.1 × / 1.25 × input) | table: GLM 5.3 Flash 0.09 / 0.30 (cache read 0.018), GLM 5.3 FlashX 0.37 / 1.25, GLM 5.3 0.91 / 2.86, Sonnet 5 2 / 10 (OpenRouter models API 2026-09-21; used when the API returns no cost) |

Risk thresholds are fixed by design: risk ≥ 0.7 blocks the action and tells the generator
why; 0.3–0.7 pauses for human confirmation in the TUI with no auto-approve (in bench runs
this counts as blocked); below 0.3 executes.

Workspace trust: the first interactive run in a repository that has an `AGENTS.md`/`CLAUDE.md`,
a `./.env` or a `./jevcode.json` asks `Do you trust the files in <root>?` (`1 trust · 2 this session
only · 3 don't trust`; the decision is stored in `~/.jevcode/trust.json` keyed by git root and
re-asked when `AGENTS.md` changes). A trusted `AGENTS.md` (32 KiB cap) is injected into the
generator's system prompt only, never into Jev's state; every action still goes through the risk
stage. `./.env` is read for keys either way.

## How a step works

```
intent Choice (+ paired Nouls) → context Nouls over candidate files, one request
→ generator proposes ONE action (tool call; edit | write | patch | run | read | done)
→ Jev scores it: destructive, out of scope, plan mismatch, irreversible → risk = max
→ execute in the sandbox (or block / ask / fail)
→ Jev judges the output (test results in the criteria when the workspace has tests)
   and answers the completion Noul → stop at the configured confidence or a budget
```

The generator receives a persistent plan (done with evidence, remaining, open problems) and a
bounded window of the last four steps, never the full transcript, so tokens per step stay
flat. Every step is checkpointed atomically; `--resume <run-id>` continues. The same
command, patch hash, or failure three times routes to a replan Choice.

## Jev-only mode: no generating LLM at all

`jevcode run "…" --mode jev-only` runs the same loop with **no generator model**. The generator
slot holds a null provider that throws if it is ever called; the bench asserts zero generator
calls per record and marks a record `invalid` otherwise. In place of "ask a model for a patch"
a synthesizer searches: **code proposes** candidate edits, **Jev decides** (where to look, which
failing behaviour to attack first, which candidates to run when tests are expensive, which of
several test-passing patches is the genuine fix, and every existing loop decision), and
**tests verify** (a candidate is committed only when the goal's failing tests pass and the
regression suite shows nothing newly failing). Jev never marks a fix correct on its own.

### Running it

```sh
# keys come from .env only; the session's own Anthropic key is never used
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx \
  bench --suite quixbugs --conditions jev-only --live \
  --spend-cap 0.6 --task-spend-cap 0.05 --max-steps 12 --max-wall 8m --out bench/results/<dir>

# ladder: the 12-task short tier, then the 8-task long tier (positions 13–20, or --task-id <name>,…)
… bench --suite ladder --tasks 12 --conditions jev-only --live --max-steps 20 --max-wall 12m --out …
… bench --suite ladder --task-id ledger5,masked,shared_frame,crossfile,import_and_guard,regress_trap,six_hunks,long_chain \
  --conditions jev-only --live --max-steps 30 --max-wall 15m --out …

# repository suites (SWE-bench) need a larger heap and low concurrency
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx \
  bench --suite swebench --conditions jev-only --live --concurrency 2 --max-steps 25 --max-wall 25m --out …

# per-program correctness of a QuixBugs result directory (code only, no Jev; writes <dir>/verdicts.md)
node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/<dir>
```

The `NODE_OPTIONS` line matters on repository suites: one analysed Django corpus is about 150 MB
of heap, a nine-instance run died at a 4 GB heap limit and a full-30 run at 8 GB after eight
records before the re-baseline file cache and the four-entry LRU of run memories landed
(`experiments/results/jev-only-rungs-1-2.md` §20.2). The `--live` flag needs no generator key
when only `jev-only` is selected.

### Architecture in one paragraph

The design is "Ledger + Sieve" (`docs/JEV-ONLY-DESIGN.md`). A **ledger** of goals, one per
cluster of failing tests (`src/synth/search/goals.ts`), is attacked one goal per outer step
(`src/synth/search/index.ts`, `subgoal.ts`); partials are held as a second base and survive a
park (`bases.ts`); regressions are never kept. The **sieve** runs every candidate at a site
through the goal's tests when one run is cheap (≤ 2 s) and asks Jev to rank only when it is not
(`budget.ts`, `src/synth/sieve/`). On a repository task with no failing test in the workspace,
the **issue oracle** (`src/synth/oracle/`) extracts reproduction blocks from the issue text, Jev
judges which block reproduces the bug and which lines show the expected and observed behaviour,
and code builds a runnable script with a code-computed pass criterion that must fail on the base
commit; **repository mode** (`search/index.ts`) makes that script the goal, localises once from
the traceback, scopes the regression suite to at most six related test files, detects the native
runner (`src/workspace/tests.ts`, `src/synth/verify/runners.ts`) and, when no oracle exists,
commits at most one best guess per run labelled unverified. The **candidate sources**
(`docs/JEV-ONLY-DESIGN.md` §3) are first-order mutations (`src/synth/mutate/`), fix templates
including stdlib-sibling callee substitution carrying its import and depth-2 wraps
(`src/synth/templates/`), donor lines with identifiers re-bound (`src/synth/donor/`), composite
pairs and units (`search/composite.ts`), sketch productions with slot filling and a token beam
(`sketch/`, `fill/`, `beam/`), and the two added for repositories on 2026-09-20: names
introspected from the failing call (`src/synth/introspect/`, `templates/introspect.ts`) and
reversals from git history (`src/synth/history/`). Sites are physical lines, insert gaps and
whole multi-line statements (`localize/sites.ts`, `search/sites.ts`). The **guard**
(`search/guard.ts`, `perturb.ts`) clusters test-passing candidates by behaviour on inputs
perturbed from the visible tests, holds a lone passer that carries a structural suspicion signal
until its site's sources have run, and asks Jev to arbitrate between clusters. On the loop side
the risk, judge, intent and loop-detector stages read the synthesizer's code-computed test
evidence (`src/loop/stages/risk.ts`, `src/loop/loopdetect.ts`, `src/loop/state.ts`).

### Results (2026-09-20/21)

Every number traces to the run directory named; "correct" is the code verdict of
`experiments/inspect/quixbugs-verdicts.mts` and `experiments/inspect/ladder-verdicts.mts` (gold-identical,
or equivalent to gold on the reference cases, on perturbed inputs and — for the graph programs — on 500
random structures per program). There is no hidden test suite: the QuixBugs and ladder evaluators run
the cases the workspace exposes, so "repaired" means "passes the reference cases" and
correctness is the separate check. The thresholds tuned on named QuixBugs programs are
disclosed in `docs/JEV-ONLY-DESIGN.md` §7; the QuixBugs numbers are in-sample for them. "Repaired"
(solved) and "correct" are reported separately on every row (`docs/DECISIONS.md`, 2026-09-21): a program
can pass its whole visible suite and still be wrong, and the final-tree rows show such cases in both suites.

| suite | run | repaired | correct (verdict script) | Jev cost | notes |
| --- | --- | --- | --- | --- | --- |
| QuixBugs 40, run 3 | `bench/results/jev-only-quixbugs-3` | 36/40 | 34/40 (27 gold-identical + 7 equivalent); 2 overfit (`detect_cycle`, `wrap`), 0 unverified | $0.165 | misses `depth_first_search`, `longest_common_subsequence`, `reverse_linked_list`, `shunting_yard` |
| QuixBugs 40, repeat 1 | `bench/results/jev-only-quixbugs-6-repeat1` (clean worktree at `d610d75`) | 38/40 | 35/40 (28 + 7); 3 overfit (`wrap`, `topological_ordering`, `detect_cycle`), 0 unverified | $0.134 | misses `longest_common_subsequence`, `shortest_path_length` |
| QuixBugs 40, repeat 2 | `bench/results/jev-only-quixbugs-6-repeat2` (same tree) | 38/40 | 36/40 (28 + 8); 2 overfit (`topological_ordering`, `detect_cycle`), 0 unverified | $0.126 | misses `shortest_path_length`, `sqrt` |
| ladder short tier (12), round 4 | `bench/results/jev-only-ladder-4` | 11/12 | – | $0.137 | 137 steps, 58 proposals refused; miss `account` (3 hunks) |
| ladder short tier, round 5 (loop-side fixes) | `bench/results/jev-only-ladder-5` | 11/12 | 7/12 (5 gold-identical + 2 equivalent); 4 overfit — strong `grades`, `textstats`, `units` (its fallback a literal `return 90`), weak-only `stats` | $0.177 | 139 steps, 17 refused; `account` solved, `inventory` missed |
| ladder round 6, `grades`/`shipping`/`table` | `bench/results/jev-only-ladder-6-done`, `-6-done-item3` | 3/3, 3/3 | – | $0.037, $0.020 | steps on these three tasks 47 (round 5) → 20 → 19; loop replans 8 → 0 → 0 |
| ladder long tier (8) | `bench/results/jev-only-ladder-long-1`, `-1b`, `-2` | 2/8; then 1/4 of the four re-authored tasks (3/8 distinct across runs 1 and 1b); 2/8 on `d610d75` | – | $0.246, $0.176, $0.266 | dominant defect: a lone partial is never committed (fixed by progress commits before the final-tree rows below; runs 3, 3b, 3c on the four affected tasks: 0/4, 0/4, 1/4 — `masked` solved once in 7 steps — $0.137, $0.120, $0.102, `bench/results/jev-only-ladder-long-3{,b,c}`) |
| SWE-bench Verified 30, first attempt | `bench/results/jev-only-swebench-1` | 0 (20 records evaluated, every patch empty; 2 unfinished) | – | $0.60 | no failing test in the workspace; wrong runner for Django and sympy |
| issue oracle over the 30 | `experiments/results/oracle-from-issue.md` | valid on 9/30 (7 strong, 2 weak) | – | $0.0096 | fails on the base commit, passes with the gold patch |
| SWE-bench, the nine oracle instances | `bench/results/jev-only-swebench-2-oracle`, `-oracle-b` | 1/9: `sympy__sympy-19954` passes the local-venv evaluator (8 steps, $0.024, 0 generator calls) | – | $0.106, $0.198 | the first instance solved with no generating model; not the upstream fix's shape; the first process died at a 4 GB heap on the Django instances |
| SWE-bench 30, budget round | `bench/results/jev-only-swebench-2` | 1 pass (`sympy__sympy-19954`, 6 steps) of 8 records | – | $0.462 | process died at an 8 GB heap after eight records |
| SWE-bench 30, wired tree (rung 3) | `bench/results/jev-only-swebench-3` | **1/30**: `django__django-15128` passes the local-venv evaluator (4 steps, $0.011); `sympy__sympy-19954` (solved in both earlier runs) missed under load | – | $1.16, 55 min, RSS peak 3.0 GB | oracle found 10/30; 9 no-oracle instances died on a wiring defect (history candidates at a foreign site) and were re-run after the fix as `jev-only-swebench-4-final` (final-tree row below); all three oracle commits failed the evaluator (flaky or network oracles); §21 of the rungs report |
| QuixBugs 40, **final tree** `55404ba` | `bench/results/jev-only-quixbugs-7-final` (frozen worktree `.claude/worktrees/final-clean`; a single run on this tree) | **39/40** pass the evaluator's reference cases (the same cases the workspace exposes; no hidden suite) | **37/40 correct** (30 gold-identical + 7 equivalent; `breadth_first_search` equivalent on 500 random graphs); **2 overfit**: `topological_ordering` (drops the `issuperset(incoming_nodes)` check and adds a `break`; wrong on 252/500 random DAGs, e.g. edges E->B, E->C → C dropped) and `detect_cycle` (a single edge input — the empty list: `AttributeError` vs `False`, 1/500); 0 unverified | $0.185 | miss `shortest_path_length`: a literal `return 4` was committed as a "possible overfit" release (`spend_cap`, $0.0538 > $0.05); gold-identical in run 3, missed in the three later runs — a persistent regression. Four-run series 36, 38, 38, 39 pass; 34, 35, 36, 37 correct. Thresholds in-sample (design §7) |
| ladder short tier (12), final tree | `bench/results/jev-only-ladder-7-final` | **12/12** solved on the exposed suite; every run `complete` in 3–7 steps; 0 blocked / declined / loop / `read` events | **8/12 correct** (5 gold-identical + 3 equivalent) by `experiments/inspect/ladder-verdicts.mts`; 4 overfit — strong `grades` (`letter_grade` one letter too high at .5 scores: 89.5 → `'A'`, gold `'B'`) and `textstats` (`ngrams` raises on a tuple and mutates the caller's list), weak-only `stats` and `units` (only the exception class on `None` / empty input differs) — 10/12 counting weak-only as correct | $0.051 | rounds 4 and 5 were 11/12 (round 5: 7/12 correct); one run on this tree |
| ladder long tier (8), final tree | same run | **2/8**: `import_and_guard` (9 steps), `ledger5` (13) | **1/8 correct** (`import_and_guard`, equivalent on 295 inputs); `ledger5` weak-only overfit (`is_overdue` returns an int with the right truthiness where gold returns a bool) | $0.269 (run total $0.320) | gold-identical hunks by strict `diff -U0` against `gold/`: `ledger5` 2/5, `import_and_guard` 2/4, `long_chain` 3/6 (three progress commits), `regress_trap` 3/4, `six_hunks` 1/6 (2/6 counting the test-equivalent `t.due == None`), `masked` 0/3 (1/3 counting the equivalent `txt = text` alias; its tree also carries an overfit `return 0` insert), `crossfile` 0/4, `shared_frame` 0/2; §25.3 of the rungs report has the misses by cause |
| SWE-bench Verified 30, **final tree** `55404ba` | `bench/results/jev-only-swebench-4-final` (a single run) | **4/30** pass the local-venv evaluator (unofficial: replicates `eval.sh` without Docker): `sympy__sympy-15345` (4 steps), `sympy__sympy-17139` (4), `sympy__sympy-19954` (6), `django__django-15128` (4); FAIL_TO_PASS all success and the listed PASS_TO_PASS all success on each | none has the upstream fix's shape (15345 `_print_Expr = _print_Function`, a class-wide alias; 19954 an index guard before `del`; 17139 a `not rv.exp.is_comparable` guard; 15128 `alias += table_name`) — accepted by the tests, not shown equivalent | $1.30, 0 generator calls, 68 min, RSS peak 4.5 GiB (5-min samples) | 348 steps, 228 blocked proposals, 88 loop trips; 0 history/foreign-site errors (the rung-3 defect is gone); `unstable` verdicts 3× on `django-15315`, `weak_network` 7× on `requests-2931`; `sympy-19954` has flipped across runs (load-sensitive); series 0/30 → 1/30 → 1/30 → 4/30 (runs 1 and 2 died early: 20 and 8 records evaluated); the four solved instances were among the nine reach-study targets the final sources were written against; §26 of the rungs report |


A full QuixBugs run costs $0.13–0.19 of Jev and 12–16 minutes of wall for the 40 programs
(median 3–4 steps per program; the final run's $0.185 is four 10–11-step recoveries); every record
carries `generatorCalls: 0`. Tree identity for the final-tree rows is inferred, not recorded: run
records carry no git sha, so `55404ba` rests on `run.json`'s workspace path (the frozen worktree,
clean at that commit) and timing (the QuixBugs bench started 94 s after the commit). Gates on that
frozen tree: typecheck, `no-any` and the full unit suite (221 files / 4,045 tests) pass, and
`npm run perf` meets every budget — first frame cold p95 104.2 ms (< 300 ms; cold median 101.2,
warm median 85.4), harness overhead per step p95 33.5 ms (< 50 ms; p50 22.1), event-loop lag p95
2.4 ms / 1.8 ms at rows 40 / 12 (< 5 ms), 0 / 0 terminal clears after the first frame. The
independent verification these rows follow is summarised in `docs/JEV-ONLY.md` (2026-09-21) and
§26 of the rungs report; §27 has the two verdict scripts that define "correct" above. The dated log of every
round is `docs/JEV-ONLY.md`; the per-round tables are `experiments/results/jev-only-rungs-1-2.md`;
the audit of the "Jev and no other model" claim is `experiments/results/jev-only-audit.md`.

## Sandbox guarantees

Commands run through `/bin/sh -c` in a detached process group with `cwd` fixed to the
workspace, a scrubbed environment (`PATH`, `LANG`, `TERM`; `HOME` and `TMPDIR` remapped
into the run directory; no API keys), a timeout (default 120 s, max 600 s, clamped to the
remaining wall-time budget), an output cap (200 KB head plus a 16 KB rolling tail; passing
it never kills the command), and a three-pass tree kill (snapshot, SIGTERM, SIGKILL, orphan
report) on timeout, cancel, Ctrl-C or SIGTERM.

On macOS the command additionally runs under `sandbox-exec` with a generated profile: writes
are denied everywhere except the workspace, the run's temp and home dirs and `/dev`
devices — and, for a linked worktree or a subdirectory workspace, the repository's `.git` directory outside it;
`.git/config`, `.git/hooks` and `.git/config.worktree` are write-denied; reads of the harness's own `.env`
and config files, `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.netrc` are denied; under
`~/.jevcode` (every run's checkpoints and the bench work areas) file contents are unreadable
except inside the run's own temp and home dirs, while directory metadata stays readable so
tools can traverse into them; `--no-network` denies all network. `sandbox-exec` is deprecated by Apple but is the
same mechanism Codex CLI, Gemini CLI and Claude Code use; its known limits are: reads
elsewhere are allowed, `ssh`-based git remotes fail inside the profile (use https), a few
Apple platform binaries refuse to exec under any profile (reported as
`sandboxExecDenied`), and processes that double-fork before the kill snapshot can escape
the tree kill. Where `sandbox-exec` is unavailable the level degrades to `none` (cwd, env
scrubbing, timeout, cap, tree kill) and `jevcode config` says so.

File actions never touch the sandbox: every path is resolved inside the real workspace
(symlinks followed and re-checked, `..` and absolute escapes rejected, `.git/**` never
written, secret files never read), edits must match exactly once, writes are atomic, and
unified diffs go through `git apply --check` before `git apply` (never `--unsafe-paths`).
The harness's own git commands run with a scrubbed environment and hooks, fsmonitor,
external diff and credential helpers disabled, so repository config planted by a command
cannot run code in the harness.

## Exit codes

`exitCodeFor(reason, error, degraded, signal)` in `src/loop/stop.ts` is the one function the CLI and
the engine use (TUI-DESIGN §13.5). The checkpoint is written before every exit.

| Situation | `jevcode run` | session (`run:end` item carries the code) |
| --- | --- | --- |
| `complete` / `generator_done` | 0 | item `exit 0`; the composer reopens |
| a budget stop (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `replan_stop`, `impossible`, `human_pause` | 4 | item `exit 4`; the composer reopens |
| configuration or usage error at launch; an unpriced model without `--allow-unpriced`; a refused secret | 2 | 2 (the process exits) |
| a rejected key (401/403) or Jev model drift on the first call | 2 | pane `[q]` → item `exit 2` |
| API failure after retries; a provider spend limit | 5 | item `exit 5` |
| checkpoint degraded and stopped (`complete` included); `--resume` unusable | 3 | item `exit 3` + not-resumable notice |
| sandbox / path abort | 6 | item `exit 6` |
| Ctrl-C ×2 while a run is live | 130 | item `exit 130`; the composer reopens |
| an external SIGINT | 130 | 130 (the process exits) |
| SIGTERM | 143 | 143 |
| SIGHUP / the terminal went away | 129 | 129 |
| an uncaught error or an escalated render fault | 1 | 1 |
| `/exit` (incl. `[y]` while live), Ctrl-D ×2, Ctrl-C ×2 idle | — | 0 — leaving is not a failure (`--exit-code last-run` returns the last run's code) |

Every exit prints one epilogue line on stderr (or a `[ui]` item in a session) — `jevcode: stopped —
<code>: <msg> (exit N)` with the message redacted — followed by the `run`, `files`, `resume` and `report`
rows when a run exists.

## Windows

Not tested on Windows. The intended posture (TUI-DESIGN §17): the TUI runs in ConPTY terminals
(Windows Terminal, VS Code) with `--sandbox none` — there is no `sandbox-exec`, so commands get cwd
confinement, environment scrubbing, timeout, output cap and tree kill only, and `jevcode config` says
so — and sandboxed runs go through WSL 2. The credentials file cannot be chmod'ed there; the wizard
prints `(Windows: protected by your user profile ACL)` instead.

## Performance

Budgets (docs/DESIGN.md §12, docs/TUI-DESIGN.md §18, docs/TUI-DESIGN-2.md §9): first frame under 300 ms with zero network at launch, for both
entry points and every geometry (the first frame is the startup splash's frame 0); harness overhead under 50 ms per step with pre/post images; rendering never blocks the
loop (event-loop lag p95 < 5 ms net of the probe's idle floor, max < 50 ms while typing during a live mocked run at a realistic step rate —
`JEVCODE_MOCK_STEP_MS=200`, about 5 steps/s, still ten times faster than a real run; the zero-latency storm is measured
as a stress row and reported); composer keystroke → frame p95 < 16 ms in a real pty; zero terminal clears outside a
shrink segment; `dynamic` frames per second ≤ `maxFps` + 1 (frames carrying new `<Static>` rows and the leading-edge
frame of a keystroke are counted separately: Ink renders both outside its throttle by design), the splash's frames in its
700 ms included; an intake reply (Enter → `[jevcode]`) within 40 ms p95 against the mock decider; the idle wordmark sweep
(TUI-DESIGN-3 §3.9) at most 4 `dynamic` frames in any idle second and 2/s on average, 12 KB/s peak and 5 KB/s mean. `npm run perf` measures
all of it, writes `perf/results/latest.json` (raw values, per-series arrays, machine and load), rewrites this section
from that file (`src/perf/readme.ts`; the table cannot drift from the JSON) and exits 1 when any gate fails.
`JEVCODE_PERF_KEEP=<dir>` keeps every pty capture and timing file; `JEVCODE_PERF_ONLY=<probe,…>` runs a subset (written
as `partial`, never a release number, and never written into this section).

| Measurement | Result | Gate | Status |
| --- | --- | --- | --- |
| First frame `run` 40×120, cold compile cache: p95 / median over 10 runs (warm median) | 140.8 ms / 139.4 ms (107.8 ms) | < 300 ms | pass |
| First frame `run` 24×80, cold compile cache: p95 / median over 10 runs (warm median) | 154.9 ms / 140.0 ms (107.8 ms) | < 300 ms | pass |
| First frame `run` 8×40, cold compile cache: p95 / median over 10 runs (warm median) | 139.2 ms / 133.7 ms (101.9 ms) | < 300 ms | pass |
| First frame `chat` 40×120, cold compile cache: p95 / median over 10 runs (warm median) | 143.4 ms / 138.7 ms (108.6 ms) | < 300 ms | pass |
| First frame `chat` 24×80, cold compile cache: p95 / median over 10 runs (warm median) | 142.8 ms / 137.6 ms (105.8 ms) | < 300 ms | pass |
| First frame `chat` 8×40, cold compile cache: p95 / median over 10 runs (warm median) | 135.7 ms / 133.8 ms (102.7 ms) | < 300 ms | pass |
| First frame `run` 24×80 breakdown, child clock: bare `node -e ''` → `render()` returned → frame flushed (harness spawn → sentinel) | 23.8 ms → 129.8 ms → 138.8 ms (137.9 ms) | report |  |
| First frame `chat` 24×80 breakdown, child clock: bare `node -e ''` → `render()` returned → frame flushed (harness spawn → sentinel) | 26.7 ms → 131.3 ms → 140.0 ms (140.1 ms) | report |  |
| Splash frame 0 is the first frame: runs whose first frame (the `step 0/` frame) already carried wordmark cells (`run` 40×120 · `run` 24×80 · `run` 8×40 · `chat` 40×120 · `chat` 24×80 · `chat` 8×40) | 20/20 · 20/20 · 0/20 (flat, none expected) · 20/20 · 20/20 · 0/20 (flat, none expected) | every run at ≥ 16 rows × ≥ 64 columns, none below (TUI-DESIGN-2 §9 row 1) | pass |
| Harness overhead per step, p95 / p50 (mocked zero-latency run, 50 steps, 5,000-file git fixture + 5,000 ignored files, 50 dirty files / 15 MiB copied at every `run` step) | 32.0 ms / 16.1 ms | < 50 ms | pass |
| Harness overhead of the `run` steps alone, p95 / p50 (12 steps; they copy the pre-image and carry the p95 above) · every other step p95 | 32.8 ms / 30.6 ms · 24.5 ms | report (margin under 50 ms) | 17.2 ms margin |
| `imagesMs` p95 / p50 over steps with images · `run`-step p95 (the 15 MiB dirty-set copy) | 22.3 ms / 1.3 ms · 23.9 ms | report only, not a gate (§18 target < 15 ms; the copy is inside `harnessMs`, which is gated) | above target (reported) |
| 60 MiB `run` artefact: post image written with `hashSkipped: true`, nothing hashed (step 11) | true | true | pass |
| `promptBuildMs` p95 / p50, warm (the file refresh, the §8.2(a) tier plan and the assembly of one relaxed prompt — last build 2 whole, 1 clipped, 9 one-line, 0 output file(s) opened) | 1.2 ms / 0.2 ms | p95 < 5 ms (§8.9) | pass |
| `promptBuildMs` cold — the first prompt after `--resume`, when none of the ≤ 6 `outputs/step-n.txt` has been read yet (§8.3) | 0.8 ms | < 25 ms | pass |
| Static append, bytes per committed line — the append frame, median / mean (`live22`, 13-row region at 24×80) | 1814 / 1816 B | report | in budget |
| Static append, bytes per committed line — the append frame, median / mean (`review22`, 19-row region at 24×80) | 2613 / 2616 B | report | in budget |
| Static append, bytes per committed line — the append frame, median / mean (`idle15`, 11-row region at 24×80) | 1865 / 1868 B | report | in budget |
| Event-loop lag while typing 10 keys/s during a live mocked run at the realistic step rate (`JEVCODE_MOCK_STEP_MS=200`, about 5 steps/s), p95 net of the probe's idle floor (raw p95 in parentheses; rows 40 / rows 12 / rows 40 reduced motion; 120 columns) | 1.10 ms (3.15 ms) / 0.34 ms (2.39 ms) / 3.06 ms (5.11 ms) | < 5 ms net | pass |
| Lag probe idle floor, measured in this run — the same 10 ms `setInterval` probe in a bare idle `node` process for 17 s: p50 / p95 / max (macOS coalesces the kevent timeout libuv waits with; the p50 is what the row above subtracts) | 2.05 ms / 2.11 ms / 7.25 ms | report (calibration; applies while the floor p95 is < 5 ms) | applied |
| Event-loop lag, max, raw (rows 40 / rows 12 / rows 40 reduced motion) | 17.76 ms / 11.91 ms / 37.53 ms | < 50 ms | pass |
| Mocked run rate under the typist: steps per second · `<Static>` rows committed per second over the typing window (rows 40 / rows 12 / rows 40 reduced motion) | 4.5 · 9 / 4.4 · 9 / 4.2 · 8 | report (the load profile the gates apply to; a real run commits a few rows per second) |  |
| Frames per second while typing, busiest one-second bucket, split into `static` · `key` · `dynamic` (rows 40 / rows 12 / rows 40 reduced motion): `static` frames carry new `<Static>` rows and are rendered immediately by Ink, unthrottled (`reconciler.js` `isStaticDirty` → `onImmediateRender`), so their rate is the item commit rate by design; `key` frames arrive within one throttle period (34 ms) of a keystroke — the leading-edge render, which follows the offered key rate by design; `dynamic` is the rest, the frames the `maxFps` throttle governs | 5 · 16 · 10 / 5 · 16 · 11 / 5 · 14 · 6 | `dynamic` ≤ maxFps + 1 = 31 (every geometry, reduced motion included); `static` and `key` reported | pass |
| Stress row — the same run at `JEVCODE_MOCK_STEP_MS=0` (rows 40; 33.8 steps/s, 76 `<Static>` rows/s, 50–100× any real run): lag p95 net (raw) / max · frames `static` · `key` · `dynamic` | 6.12 ms (8.17 ms) / 20.98 ms · 42 · 19 · 17 | report (lag and frame rate not gated under the storm; hygiene below is) | over the realistic-rate gates (expected) |
| Splash bucket — `dynamic` frames within 700 ms of the first frame (no key is sent before 800 ms, so the splash settles by itself) · `static` · `key` frames of the same window · frames of any class carrying the wordmark · first frame is splash frame 0 (rows 40 / rows 12 / rows 40 reduced motion / stress; the splash ticks through Ink's `useAnimation` at 50 ms, ≤ 15 frames by construction; rows 12 is the flat tier and reduced motion mounts settled, so they draw no wordmark) | 11 · 1 · 0 · 12 · true / 1 · 1 · 0 · 0 · false / 1 · 1 · 0 · 2 · true / 11 · 1 · 0 · 12 · true | `dynamic` ≤ ⌈(maxFps + 1) × 0.7⌉ = 22 (realistic geometries; stress reported) | pass |
| Run-start bucket — `dynamic` frames within 1 s of the `[run] start` frame (the rule sweep's ≤ 6 frames + the spinner + the live flush; rows 40 / rows 12 / rows 40 reduced motion / stress) | – / – / – / – | ≤ maxFps + 1 = 31 (realistic geometries; stress reported) | pass |
| Terminal clears after the first frame during the live run (rows 40 / rows 12 / rows 40 reduced motion / stress) | 0 / 0 / 0 / 0 | 0 | pass |
| Dynamic region, tallest painted (rows 40 / rows 12 / rows 40 reduced motion / stress) | 15 rows / 5 rows / 15 rows / 15 rows | ≤ rows − 2 | pass |
| Cursor hides per frame, max · frames not ending with `ESC[?25h` · cursor shown at exit (rows 40 / rows 12 / rows 40 reduced motion / stress) | 1 · 0 · true / 1 · 0 · true / 1 · 0 · true / 1 · 0 · true | ≤ 1 · 0 · true | pass |
| `ESC[3J` sequences in the capture (rows 40 / rows 12 / rows 40 reduced motion / stress) — the user's scrollback is theirs (TUI-DESIGN-4 §11, §1.4) | 0 / 0 / 0 / 0 | 0, every geometry | pass |
| Frames taller than the terminal (rows 40 / rows 12 / rows 40 reduced motion / stress) — `paintedRows ≤ rows`, every frame after the first (TUI-DESIGN-4 §11) | 0 / 0 / 0 / 0 | 0, every geometry | pass |
| `CLEAR_RE` self-test (matches `ESC[2J`, `ESC[3J`, `ESC c`, `ESC[?1049h`; not `ESC[2K`) | true | true | pass |
| `NO_3J` self-test — the `ESC[3J` detector matches the bare and parameterised forms and neither `ESC[2J` nor `ESC[2K`/`ESC[3K` (TUI-DESIGN-4 §11, §1.4: `ESC[3J` deletes the user's scrollback) | true | true | pass |
| Named-anchor self-test — every measured window's anchor matches **both** glyph sets and none of its negatives, and a zero match is a hard failure, never a silent whole-capture window (TUI-DESIGN-4 §11, D-V; `run-started` · `run-end`) | ok | every anchor, both glyph sets | pass |
| Composer keystroke → frame, p50 / p95 / max (`idle`: 200/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 6.1 ms / 7.8 ms / 11.5 ms | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame, p50 / p95 / max (`idle-loop`: 200/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 4.0 ms / 7.2 ms / 15.4 ms | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame, p50 / p95 / max (`live`: 200/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80, live run at `JEVCODE_MOCK_STEP_MS=200`) | 4.9 ms / 13.8 ms / 26.7 ms | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame, p50 / p95 / max (`live-stress`: 175/200 keys located, 100 ms apart → 8.7 keys/s achieved, 24×80, live run at `JEVCODE_MOCK_STEP_MS=0`) | 9.3 ms / 2641.3 ms / 2704.0 ms | latency report only (the zero-latency storm); hygiene gated | FAIL |
| Composer keystroke → frame, p50 / p95 / max (`palette`: 200/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 11.0 ms / 31.8 ms / 82.0 ms | p95 < 16 ms, max < 50 ms | FAIL |
| Composer keystroke → frame, p50 / p95 / max (`palette-cycle`: 200/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 12.1 ms / 40.4 ms / 64.1 ms | p95 < 16 ms, max < 50 ms | FAIL |
| Composer keystroke → frame, p50 / p95 / max (`palette-arg`: 70/200 keys located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 7224.9 ms / 13596.6 ms / 13713.8 ms | latency report only (§18: a key inside Ink's 34 ms throttle window waits for the trailing edge); `dynamic` frame rate ≤ 31 gated | FAIL |
| Composer keystroke → frame, p50 / p95 / max (`review`: 200/200 `e` toggles located, 100 ms apart → 10.0 keys/s achieved, 24×80) | 8.7 ms / 28.4 ms / 61.9 ms | p95 < 16 ms, max < 50 ms | FAIL |
| Composer keystroke → frame, p50 / p95 / max (`burst30`: 148/200 keys located, 30 ms apart → 32.8 keys/s achieved, 24×80) | 1599.9 ms / 1637.9 ms / 1663.0 ms | latency report only (§18: a key inside Ink's 34 ms throttle window waits for the trailing edge); `dynamic` frame rate ≤ 31 gated | FAIL |
| Frames per second while typing, busiest bucket, `static` · `key` · `dynamic` (`idle` · `idle-loop` · `live` · `live-stress` · `palette` · `palette-cycle` · `palette-arg` · `review` · `burst30`; "n/e" = not exercised: neither a live run nor more than 30 keys/s offered; "report" = the stress series) | 0 · 10 · 0 n/e / 0 · 12 · 2 n/e / 4 · 15 · 14 / 30 · 18 · 15 (report) / 0 · 10 · 5 n/e / 0 · 11 · 3 n/e / 0 · 6 · 3 n/e / 0 · 11 · 3 n/e / 0 · 33 · 0 | `dynamic` ≤ maxFps + 1 = 31 where exercised (`live`, `burst30`); `static` and `key` reported | pass |
| Composer series hygiene: clears after the first frame · tallest painted region · frames not ending with `ESC[?25h` (`idle` · `idle-loop` · `live` · `live-stress` · `palette` · `palette-cycle` · `palette-arg` · `review` · `burst30`; the review series has no cursor while the composer is collapsed, reported only) | 0 · 15 · 0 / 0 · 15 · 0 / 0 · 15 · 0 / 0 · 15 · 0 / 0 · 19 · 0 / 0 · 19 · 0 / 0 · 19 · 0 / 0 · 22 · 223 (report) / 0 · 15 · 0 | 0 · ≤ 22 · 0 where the composer is active | pass |
| Intake reply latency, `mock0`: Enter → `[you]` bubble frame p50 / p95 / max · Enter → `[jevcode]` reply frame p50 / p95 / max (20 greetings and tool questions, 20 located, 24×80, mock decider at 0 ms; `thinking` seen for 20/20) | 14.5 ms / 46.1 ms / 68.5 ms · 14.5 ms / 46.1 ms / 68.5 ms | bubble p95 < 16 ms · reply p95 ≤ 40 ms (TUI-DESIGN-2 §3.12, §9; the live 1.5 s gate is the S6 scenario's) | FAIL |
| Intake reply latency, `mock150`: Enter → `[you]` bubble frame p50 / p95 / max · Enter → `[jevcode]` reply frame p50 / p95 / max (20 greetings and tool questions, 20 located, 24×80, mock decider at 150 ms (`JEVCODE_MOCK_JEV_MS=150`; the reply figure is gated net of the delay); `thinking` seen for 20/20) | 10.8 ms / 24.3 ms / 59.5 ms · 167.6 ms / 189.5 ms / 232.0 ms (net p95 39.5 ms) | bubble p95 < 16 ms · reply p95 ≤ 40 ms net of the delay (TUI-DESIGN-2 §3.12, §9; the live 1.5 s gate is the S6 scenario's) | FAIL |
| Intake hygiene: runs started by a greeting or a tool question · clears after the first frame · tallest painted region (`mock0` · `mock150`) | 0 · 0 · 15 / 0 · 0 · 15 | 0 · 0 · ≤ 22 | pass |
| Idle animation — `dynamic` frames per second over the 30 s after the wordmark settles (busiest second · mean; 24×80 · 40×120; `chat --mock` left alone, no key: the sweep's 16 frames per 10 s pass are the only writer) | 4 · 1.6 / 4 · 1.6 | ≤ 4 in every second · mean ≤ 2/s (TUI-DESIGN-3 §3.9) | pass |
| Idle animation bytes — busiest second · mean per second · widest frame (24×80 · 40×120) | 8948 · 3511 · 2237 B / 11652 · 4595 · 2913 B | ≤ 12288 B/s peak · ≤ 5120 B/s mean | pass |
| Idle animation hygiene — clears after the first frame · tallest painted region · frames carrying the wordmark in the window · child CPU over the window (`ps -o time`, reported) (24×80 · 40×120) | 0 · 15 · 48 · 460 ms (15.3 ms/s) / 0 · 15 · 48 · 510 ms (17.0 ms/s) | 0 · ≤ rows − 2 · report · report | pass |
| Zero clears per state and geometry segment across 18 pty scenarios (review card, palette card, jev-only wizard, secret row and intake card at 24×80 — boxed — and 12×60 — flat; picker; `render:composer` / `render:pane` faults; Ctrl+L; three resize sequences): clear events total · in shrink segments · `ESC c` + alt-screen | 0 · 0 · 0 | 0 outside shrink segments, ≤ 1 per shrink; never `ESC c` / `ESC[?1049h` | FAIL |
| `resize` 40×120 (typist): clear events per segment (allowed) · stale paints at or after the TUI's reaction to a shrink · frames in flight at the shrink (ms after the ioctl) · dynamic rows painted by the clear frame | 0 (0) · 0 (1) · 0 (0) · 0 (0) · 0 · 0 · – | ≤ allowed · 0 · report · ≤ 10 | pass |
| `resize-live` 40×120 (typist): clear events per segment (allowed) · stale paints at or after the TUI's reaction to a shrink · frames in flight at the shrink (ms after the ioctl) · dynamic rows painted by the clear frame | 0 (0) · 0 (1) · 0 (0) · 0 (0) · 0 · 0 · – | ≤ allowed · 0 · report · ≤ 10 | pass |
| `resize-idle` 24×80 (typist): clear events per segment (allowed) · stale paints at or after the TUI's reaction to a shrink · frames in flight at the shrink (ms after the ioctl) · dynamic rows painted by the clear frame | 0 (0) · 0 (1) · 0 (0) · 0 (0) · 0 · 0 · – | ≤ allowed · 0 · report · ≤ 10 | pass |
| Ctrl+L repaint (3-row draft, pane open, 24×80): visible frame content equals the frame before it, in one BSU/ESU pair | true (1 frame) | true | pass |
| state `review` 12×60 | exit 124 (want 0) timeout; clears 0/0 |  | FAIL |
| state `fault-pane` 24×80 | exit 124 (want 0) timeout; clears 0/0 |  | FAIL |
| Scroll key → frame, p50 / p95 / max (fullscreen, 175/200 PgUp/PgDn located, 40×120, 20000 items) | 1702.2 ms / 3261.0 ms / 3637.6 ms | p95 < 16 ms, max < 50 ms | FAIL |
| Bytes in the widest scroll frame · width-change rebuild · frames not exactly `rows` tall (fullscreen post-condition) | 4173 B · 60.5 ms · 155 | ≤ 6144 B · < 50 ms · 0 | FAIL |
| Scroll hygiene: clears after the first frame · `ESC[3J` · cursor shown at exit | 3 · 0 · true | 0 · 0 · true | FAIL |

Measured 2026-09-22 (19:17Z) on an Apple Silicon Mac (15 cores, 24 GB, Apple M5 Pro), Node 22.23.2,
darwin 25.6.0; 1-minute load average 7.99 at the start and 77.17 at the end of the run (the suite waits while it is above 8;
a release number needs ≤ 2 at both ends — NOT met here); no other pty driver process was alive at the start. Result of the run: **10 gates fail: intake latency (mock0); intake latency (mock150); composer live-stress (keys not located); composer palette (latency); composer palette-cycle (latency); composer palette-arg (keys not located); composer review (latency); composer burst30 (keys not located); state review 12×60; state fault-pane 24×80**.
Raw values in `perf/results/latest.json`.

How it is measured:

1. First frame: `script -q /dev/null sh -c 'stty rows R cols C; exec node bin/jevcode.js <run "…"|chat> --config <unreadable>
   --perf-exit-after-first-frame'` with `JEVCODE_ASSERT_NO_NETWORK=1`, `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` (inert until `bin/jevcode.js` implements the hook), a non-existent `JEVCODE_HOME` and `XDG_CONFIG_HOME`, `HOME` inside the workspace;
   the time is spawn → the status sentinel `step 0/` in the pty bytes; cold runs use a fresh `NODE_COMPILE_CACHE`. The
   breakdown (three traced runs, `JEVCODE_TRACE`) splits the child's own clock: about 25 ms of Node boot, about 105 ms of
   bundle evaluation plus the first synchronous render, about 9 ms until Ink has flushed the frame. Round 2 (TUI-DESIGN-2 §5): that frame is
   the startup splash's frame 0 — the wordmark's `J` column and sweep head land in it with the console and `step 0/–`; 20/20, 20/20, 20/20, 20/20 first frames at the
   wordmark geometries carried it (the 8×40 series is the flat tier and draws none) — gated per series (TUI-DESIGN-2 §9 row 1): every series as designed.
2. Event-loop lag and composer latency run in a real pty through `perf/drivers/pty_type.py`, a `pty.fork` typist that
   reads the master continuously and timestamps every chunk (drive.exp's `sleep` polls the pty every 25 ms, and a Node
   child writes to its TTY synchronously, so the child blocked in `write()`: measured 11 steps in 12 s and lag p50 114 ms
   under a drive.exp `sleep` against 399 steps in 11 s and lag p50 1.1 ms with continuous reads). The lag probe is the
   child's 10 ms `setInterval` (`--perf-lag-probe`), started before `controller.run()` and stopped at exit, so the
   distribution covers the whole session after a 500 ms warm-up — about 1.2 s of idle prologue (the typist lets the splash settle for 800 ms before its first key) and 1 s of abort/exit tail
   around the 15 s of typing; it is not windowed to the keystrokes (the probe emits percentiles only). The gated load
   profile is the `--mock` run paced by `JEVCODE_MOCK_STEP_MS=200` (`src/cli/mock-trajectory.ts`: every mocked generator turn
   takes that long, the mock decider answers at once): 4.5 / 4.4 / 4.2 mocked steps/s and 9 / 9 / 8 committed
   `<Static>` rows/s at rows 40 / 12 / 40 reduced motion — still ten times faster than a real run, whose steps take 2–10 s.
   The probe has a floor: in an idle Node process on macOS the same 10 ms `setInterval` reads about 2 ms per tick with nothing
   blocking (the kernel coalesces the kevent timeout libuv waits with, `kern.timer.coalescing_enabled`; a loop kept spinning by a
   1 ms interval reads 0.3 ms). A run paced at 5 steps/s idles between steps, so its raw p95 carries the floor; the storm never idles.
   Each run therefore measures the floor first — the identical probe in a bare idle `node` for 17 s: p50 2.05 ms, p95 2.11 ms, max 7.25 ms here —
   and the gate applies to the p95 net of that median; raw and net are both in the table. In this run the lag p95 read
   1.10 ms / 0.34 ms / 3.06 ms net (3.15 ms / 2.39 ms / 5.11 ms raw; max 17.76 ms / 11.91 ms / 37.53 ms) — inside the gate.
   The stress row repeats rows 40 at `JEVCODE_MOCK_STEP_MS=0`: 33.8 steps/s and 76 `<Static>` rows/s, 50–100× any real run, where the lag p95 read
   6.12 ms net (8.17 ms raw; max 20.98 ms) — reported, not gated: the storm is the diagnosis of what a transcript commit costs, not a budget a real run meets.
3. Frame rate: every frame of the typing window is classified (`src/perf/pty.ts` `classifyFrame`). `static` frames carry
   new `<Static>` rows — Ink 7.1.1 renders a commit that changed the `<Static>` subtree at once (`ink/build/reconciler.js`
   `resetAfterCommit`: `isStaticDirty` → `onImmediateRender`, which `ink.js` binds to the unthrottled `onRender`), so a
   committed transcript item costs a frame by design and their rate is the item commit rate. `key` frames arrive within one
   throttle period (`ceil(1000 / maxFps)` = 34 ms) of a keystroke: the leading edge of `throttle(onRender, …, { leading: true,
   trailing: true })`, which follows the offered key rate by design. `dynamic` is the rest — spinner, 1 Hz clock, live
   flush, status-line and pane changes — the frames the `maxFps` throttle governs, and the class the gate applies to (≤ 31).
   At the realistic rate the busiest one-second bucket held 5 · 16 · 10 / 5 · 16 · 11 / 5 · 14 · 6 static · key · dynamic
   frames at rows 40 / 12 / 40 reduced motion — inside the gate; under the stress row 42 · 19 · 17 (reported). Reduced motion is gated
   the same way: its "≤ 4/s" figure in §18 is the 250 ms live-flush cadence, asserted in unit tests, which a live run
   cannot separate from the state-change repaints of 5 steps/s. The same split is applied in the composer series (next note).
4. Composer latency: 200 uppercase keys per series (the wave-4 brief's count; §18 names 500 printable bytes) at an exact
   cadence (the typist lands each pause within 0.1 ms; a plain 30 ms `select` overshoots to 37 ms on macOS, which an earlier
   run mistook for a 30 ms burst). A key's frame is the first frame after the send whose **composer row** — the row
   directly above the status line — ends with that key; matching the key anywhere in the frame paired 23 of 200 `live`
   keys of the 2026-09-21 08:54Z run with a frame that predated them (a wrapped draft row above the cursor row ended with
   the same letter). `live` is the A109 region (pane 12 + live rows + a composer at its 6-row cap over a 2,000-char draft)
   during a live mocked run at `JEVCODE_MOCK_STEP_MS=200` (p95 13.8 ms, 4 · 15 · 14 static · key · dynamic frames/s); `live-stress` repeats it over the
   zero-latency mock (p95 2641.3 ms, 30 · 18 · 15 frames/s) and is reported. `review` measures the review's `e` toggle (the composer is
   collapsed while a review is pending, so its frame is recognised by the painted-row change; the Jev panel is opened with `/panel full` first, since round 2 collapses it to a strip and the toggle zeroes the pane rows).
   `burst30` offers 32.8 keys/s, above `maxFps` 30: Ink's throttle is `leading: true`, so a key landing after the previous 34 ms
   window renders at once and one inside it waits for the trailing edge — its latency (p95 1637.9 ms) is reported, not gated, and its
   33 `key` frames/s follow the offered key rate by design; the gate applies to its `dynamic` frames (0). At 10 keys/s without a
   live run the frame rate is reported as not exercised.
5. Harness overhead: `StepRecord.timing.harnessMs` from `step:end` with the engine in-process (mock provider and decider
   at zero latency, no TUI). The fixture holds 50 tracked files modified after the commit (300 KiB each), so every `run`
   step copies 15 MiB of pre-images — the worst case inside the 200-file / 16 MiB cap — which is why `imagesMs` p95
   (22.3 ms) sits above the 15 ms target — a report row, not a gate: the copy is awaited inside `runStep()` (D8), so it is already inside the gated `harnessMs` and the `run` steps carry the p95 of `harnessMs` (32.8 ms against
   32.0 ms overall; every other step p95 24.5 ms). The margin under the gate is 17.2 ms and load-sensitive, which is why a release number requires a 1-minute load ≤ 2.
6. Zero clears: 18 scenarios; the resize sequences run through the typist (its `resize` record carries the capture byte
   offset, so every frame is held to the budget of the geometry it was painted in), the rest through `scripts/pty/drive.exp`.
   Clears are counted as events (Ink's `clearTerminal` is `ESC[2J ESC[3J ESC[H`, two regex matches for one clear) with
   the §18 regex self-tested first. A shrink segment is allowed one clear (research 20 §1: Ink cannot erase a frame taller
   than the new terminal line by line); clear events per segment in this run — `resize` 0/0/0/0, `resize-live` 0/0/0/0, `resize-idle` 0/0/0/0; frames painted taller than the new
   geometry at or after the TUI's reaction to a shrink (the stale-tree race DESIGN §12 describes): 0; frames already in flight when
   SIGWINCH landed (written after the ioctl, before the TUI's first reaction, still laid out for the old geometry): 0 — reported, a
   terminal receives them whatever the renderer does. The retry row and blocking panes are not driven:
   `JEVCODE_FAULT=jev:429` / `jev:401` / `persist:ENOSPC` are not implemented in this tree (only `render:<pane>` is).
7. Intake reply latency (TUI-DESIGN-2 §3.12): 20 greetings and questions about the tool typed into `chat --mock` at 24×80 through the
   typist; every one passes the mock decider's intake (§3.13) and ends in a `[jevcode]` reply, none in a run. Enter → the frame carrying
   the `[you]` bubble read p95 46.1 ms at 0 ms and 24.3 ms with the mock delayed 150 ms (gate < 16 ms, the composer gate); Enter → the
   `[jevcode]` reply frame read p95 46.1 ms at 0 ms and 39.5 ms net of the delay (gate ≤ 40 ms). The live gate — p95 < 1.5 s over a real
   provider — is the S6 live scenario's (`docs/live/tui/round-2/`), not this probe's.
8. Idle animation (TUI-DESIGN-3 §3.4, §3.9): `chat --mock` at 24×80 and 40×120 is left alone for 33 s; the window is
   [settle + 1 s, settle + 31 s), the settle being the caption frame `◆ <version>`. The wordmark's sweep (16 frames per 4 s pass, 6 s rest, period 10 s while
   attentive) is the only idle writer, so every frame of the window is counted: 4 peak · 1.6 mean frames/s and 8948 B peak · 3511 B mean per second; 4 peak · 1.6 mean frames/s and 11652 B peak · 4595 B mean per second — inside the §3.9 budget.
   The child's CPU over the window (`ps -o time=`, centiseconds) read 460 ms (15.3 ms/s) / 510 ms (17.0 ms/s) — reported, not gated (the owner lowers `LOOP_INTERVAL_MS` above 30 ms/s).
9. `renderTime` (Ink's `onRender` metric) is not measured: the App registers no `onRender` callback.

Declared deviations from docs/TUI-DESIGN.md §18 and docs/TUI-DESIGN-2.md §9 (also listed in `perf/results/latest.json`):

- 200 keys per series (the wave-4 brief) rather than §18's 500 printable bytes; the live draft is the 2,000 chars §18 names
- review series: the composer is collapsed to one inactive row while a review is pending (D1), so the measured key is the review's `e` toggle and a frame is recognised by its painted-row change, not by the composer row; the per-frame `ESC[?25h` rule is reported there (no cursor while the composer is inactive); round 2 opens the Jev panel with `/panel full` before the review so the toggle has pane rows to zero (the default strip and the one-line mock preview would leave `e` without a visible effect)
- the frame-rate gate applies to dynamic frames only and only where it is exercised (a live run at the realistic step rate, or an achieved key rate above maxFps); at 10 keys/s without a run it is reported as not exercised, and the live-stress series reports it
- the lag distribution covers the whole session after the 500 ms warm-up (≈ 0.9 s of idle prologue while the splash settles, ≈ 1 s of abort/exit tail, around ≈ 15 s of typing): the child probe emits percentiles only, so it cannot be windowed to [first key, last key] from here
- the gated load profile is the --mock run paced by JEVCODE_MOCK_STEP_MS=200 (about 5 steps/s, one delta per turn), not §18's "500 delta/s mock"; the zero-latency stress profile is reported alongside
- the frame-rate gate applies to dynamic frames only: Ink renders <Static> changes immediately (reconciler.js isStaticDirty → onImmediateRender) and a keystroke on the throttle's leading edge, so static and key frames are reported, not gated
- reduced motion is gated at dynamic ≤ maxFps + 1 like the other geometries: §18's "≤ 4/s" is the 250 ms live-flush cadence, which a live run cannot separate from state-change repaints
- the lag gate applies to the p95 net of the probe's idle floor (the same 10 ms setInterval in a bare idle node process, measured in the run: ≈ 2 ms of macOS timer coalescing per tick, not blocking); raw p95, floor and net are all reported, and the raw p95 is gated when the floor itself is ≥ 5 ms
- renderTime (Ink onRender) is not measured: the App registers no onRender callback
- the live gate of TUI-DESIGN-2 §9 (intake reply wall time p95 < 1.5 s over a real provider) is measured by the S6 live scenario and test/live/intake.live.test.ts, not here: this probe never touches the network and gates the harness share against the mock decider (≤ 40 ms p95 at 0 ms, and net of the delay at JEVCODE_MOCK_JEV_MS=150)
- the bubble figure is the frame carrying the `[you]` item, not the composer echo of Enter: at 0 ms the bubble and the reply usually land in one immediate <Static> render, so the two figures coincide there and come apart only in the delayed series
- the CPU figure is the child's cumulative `ps -o time=` sampled from the harness at ≈ 2 s and ≈ 32 s after the spawn (centisecond resolution, the whole process incl. the 1 Hz tick), reported and not gated (TUI-DESIGN-3 §3.9: above 30 ms/s mean the owner lowers LOOP_INTERVAL_MS by one constant)
- frames are classed `dynamic` unless they carry new `<Static>` rows; with no key sent the `key` class is empty, so the bucket counts are the whole idle traffic

## Bench

```sh
jevcode bench --suite all --tasks 3                       # mocked end to end, no network
jevcode bench --suite swebench --tasks 3 --live --spend-cap 5 --conditions jev-on,jev-off
jevcode bench --suite all --live --spend-cap 40 --concurrency 3 --out bench/results/full
jevcode bench --resume <bench-id>
```

Tasks: a checked-in 30-task SWE-bench Verified subset (`bench/data/swebench-verified-30.json`,
selection procedure in `bench/data/README.md`) and 10 Terminal-Bench 4.0 tasks
(`bench/data/terminal-bench/`, feasibility profile of all 66 in `manifest.json`). Two
conditions per task: `jev-on` (the full loop) and `jev-off` (the same generator, prompt,
sandbox and budgets, no Jev decisions, no verification). Per task the bench records pass,
steps, wall time, tokens per step, cost split, Jev latency (raw, p50, p95), the timing
breakdown and which budget stopped the run, as `tasks.jsonl`, `summary.json`, a
`comparison.md` with steps-to-solve and tokens-per-step curves, and official-format
`predictions.<condition>.jsonl`.

Docker is not available on the development machine, so `pass` comes from a local evaluator:
for SWE-bench a fresh clone at `base_commit`, a venv with the instance's install spec, the
model patch and `test_patch` applied, `test_cmd` run on the test files and graded with ported
log parsers under the official FULL rule (`evaluator: local-venv`, labelled unofficial);
for Terminal-Bench a path-rewritten copy of the task's `tests/` run against a fresh verifier
dir holding only the declared artifacts (`evaluator: local`, non-comparable to the
leaderboard). The prediction files can be graded officially with `sb-cli` or `swebench
eval --modal`, and `bench/harbor/jevcode_agent.py` runs JevCode under Harbor where
containers exist.

Results of the live 30-task run (2026-09-20, `bench/results/live-swebench-30`, 29 tasks paired,
$46.25 total, unofficial local evaluator):

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate | 9/29 (31.0 %) | 10/29 (34.5 %) |
| steps-to-solve mean / median | 23 / 25 | 22 / 25 |
| generator tokens per step | 5,519 | 6,767 |
| Jev tokens per step (at $0.042/M) | 28,351 | 0 |
| `read` actions per run | 2.9 | 4.3 |
| blocked / declined reviews (total) | 208 / 170 | 0 / 0 |
| Jev latency p50 / p95 | 237 ms / 547 ms | – |
| cost per condition | $24.21 | $20.44 |

Interpretation and caveats are in [docs/STATUS.md](docs/STATUS.md); the mocked pipeline and the
3-task slices are in `bench/results/live-slice-3b` and DECISIONS.md.

## Dependencies and why

Runtime: **none**. `ink` 7.1.1 (the TUI; the prompt requires Ink) and `react` 19.3.0 (Ink's
peer) are devDependencies inlined into `dist/jevcode.mjs` by esbuild (`minify` + `keepNames`), so
`npm install -g jevcode` installs one package. Everything else is Node: HTTP is `fetch`, SSE
parsing is a small WebStreams reader, `.env` is `util.parseEnv`, arguments are `util.parseArgs`,
hashing is `node:crypto`, processes are `node:child_process`, atomic writes are temp-file +
`rename(2)`, the pty tests use `/usr/bin/expect`.

Dev: `typescript` 7.0.2 (`tsc --noEmit`, strict, no `any` enforced by `scripts/no-any.mjs`),
`vitest` 5 + `vite` (its non-optional peer) + `@vitest/coverage-v8`, `ink-testing-library`
(TUI frame tests), `esbuild` (one ESM bundle; measured 2026-09-21 at 24×80 in a real pty, three runs each:
80.8–84.8 ms first frame from the bundle vs 252.8–307.5 ms running the TypeScript sources through `tsx`), `tsx` (run TSX sources in development; also loads the registries for
`scripts/gen-docs.mjs`), `@types/node` 22 and `@types/react`.

## Development

```sh
npm run typecheck      # tsc --noEmit + no-any check
npm test               # offline unit tests (vitest project `unit`)
npm run test:live      # hits Jev and the generator; skips suites whose key is missing
npm run perf           # builds, then measures first frame (= splash frame 0), step overhead, render lag (+ splash frames), composer and intake latency, per-state clears
npm run build && sh test/pty/run-smoke.sh   # 34 real-pty scenarios over the built bundle (expect(1), macOS); every child runs from its workspace with every key variable unset
npm run test:pty       # the pty vitest project (63 real-pseudo-terminal tests incl. the 33 of test/pty/round2.pty.test.ts; rebuilds a stale bundle first; run results in docs/STATUS.md)
node scripts/gen-docs.mjs [--check]         # regenerate docs/KEYS.md, docs/COMMANDS.md, man/jevcode.1, completions/*
npm run pack:check     # the release tarball gates (allowlist, size, --version smoke)
JEVCODE_TRACE=/tmp/t.log jevcode run …   # opt-in trace: key classes, abort, loop boundaries, finish (never a key or a draft)
jevcode run "…" --mode jev-on --mock --mock-steps 5    # scripted generator and decider, no network (the scripted trajectory is a generator trajectory: say --mode jev-on); JEVCODE_MOCK_REVIEW_AT=2 adds a review
jevcode chat --mock                      # the mock decider classifies your messages too: `hi` → a reply, `fix the failing test` → a run; JEVCODE_MOCK_INTAKE=ambiguous forces the `run this as a task?` card, JEVCODE_MOCK_JEV_MS=150 delays it
```

## Status

See the final report in [docs/STATUS.md](docs/STATUS.md) for what was built, what was
verified live, what could not be verified on this machine, and open questions.
