# JevCode interactive TUI — user guide

This is the user-facing guide to `jevcode` on a terminal (TUI-DESIGN §21). It covers the modes, the keys, sessions and
follow-ups, money, secrets, undo/diff, logs and the exit codes. The command table is generated into
[`docs/COMMANDS.md`](COMMANDS.md) and the key table into [`docs/KEYS.md`](KEYS.md); `man jevcode` and the shell
completions (`jevcode completion bash|zsh|fish`) come from the same registries.

## Modes

| You type | What runs | Composer | Leaves with |
| --- | --- | --- | --- |
| `jevcode`, `jevcode chat` | an interactive **session**: the composer opens first, nothing runs until you press Enter | Ink composer | `/exit`, Ctrl-D ×2, Ctrl-C ×2 while idle → exit 0 (`--exit-code last-run` returns the last run's code instead) |
| `jevcode run "<task>"`, `--task-file <path>`, `--resume <id\|title>` | one run, started right away; the composer is mounted for steering only | Ink (steer with Enter) | the run's exit code (table below) |
| `jevcode [chat] --plain` | the same session over a plain `> ` readline prompt (no panes, no colours) | readline | as a session |
| a pipe, `CI`, `TERM=dumb`, `--no-input`, `--json` | one run, no prompts; every question takes its safe default | none | the run's exit code |

The first frame (`jevcode session · <dir> \| step 0/– starting` or `jevcode task: <task> \| step 0/– starting`) is drawn
from the command line alone, before any configuration file is read; `--task-file` shows `task from <file>` in the header
because the file is read only after the frame is up. `jevcode run` with no task on a terminal opens a session.

Startup order inside a session: keybindings and prompt history → configuration → warnings (`warning: …` items; on a
`--plain` terminal or a pipe they go to stderr as `jevcode: <warning>`) → the key wizard when a key is missing → the
workspace trust question when `AGENTS.md`, `./.env` or `jevcode.json` are present → the `[sandbox] …` line → the
`recent: "<title>" · <ago>  (Enter continues, /resume browses)` hint when this directory has an earlier session.

## Keys

`?` or `/help` prints the full key and command list. The interrupt keys depend on the state:

| Key | idle, empty draft | idle, text in the draft | run live, empty draft | run live, text in the draft | review box open |
| --- | --- | --- | --- | --- | --- |
| Ctrl-C | toast `press Ctrl-C again to exit`; a second press within 1.5 s exits 0 (the scrollback keeps `[ui] exited on Ctrl-C ×2`) | clears the draft (into history) | aborts the run and stays in the session | clears the draft, the run continues | with an empty draft aborts the run; with a draft clears the draft and keeps the box |
| Esc | arms Esc Esc (menu) | Esc again clears the draft | **pauses** at the step boundary (`paused after step N — /resume continues, or type a follow-up`); Esc again aborts | arms Esc Esc | declines |
| Ctrl-D | `press Ctrl-D again to exit`; second press exits 0 | delete forward | `run is live — Ctrl-D again to choose` → `a run is live: [y] abort and exit   [n] stay` | delete forward | ignored |
| Enter | submits the task / follow-up | submits | nothing | queues a steer for the next step (`↑1 queued for step N: …`) | never approves |

A second Ctrl-C while a run is already aborting exits immediately with code 130 (the checkpoint is written first).
Shift+Enter needs a keyboard protocol: use Ctrl+J or `\` then Enter for a newline. On macOS turn on "Option as Meta"
for Alt-b / Alt-f.

## Reviews

When Jev's risk answer lands in the review band the run pauses with a review box: `[y] approve [n] decline
[d] decline+note [e] expand [w]1-5 why [esc] decline`. `y` approves once; `d` opens `note (≤ 600, Enter sends, Esc
cancels): ` and the note reaches Jev and the generator (`confirm <id> declined (note: <note>)` in the transcript).
Printable keys are ignored while the box is armed (toast `review pending: y n d e w · Esc declines`); the box arms one
frame after it is drawn and never from the same input chunk as the Enter that preceded it, so a queued `y` cannot
approve by accident.

## Sessions and follow-ups

Every run of one `jevcode` process belongs to a session (the first run's id). A second Enter is a **follow-up**: the new
run is seeded from the previous run's plan and window, and the transcript says `[run] seeded from run <id>: …`.

- `/resume` opens the picker of this directory's sessions (Ctrl-A: all workspaces; Space previews; `x` then `y` deletes);
  `/resume <id|title>` continues a stopped run, or adopts a completed run's session for a follow-up (`--force` resumes
  a completed run anyway). `-c` / `--continue` picks the most recent session.
- `/new` ends the session (`session <id> ended: N runs, $x total`) and starts a fresh one with its own spend cap.
- `/rename <title>` names the session for the picker; `/export [file]` writes every run's transcript to
  `~/.jevcode/exports/<session>.log` with one `==== run <id> · <t> · <task> · <stop> · $<cost> ====` header per run.
- `/status`, `/cost`, `/jev`, `/plan`, `/decisions [n]`, `/why <ref>`, `/calibration`, `/errors`, `/config` are read-only
  inspection blocks; `/theme dark|light|daltonized|ansi` applies to new items for the rest of the session.
- Steering: type while a run is live and press Enter; up to 8 directives queue (`steer queue full (8)` after that),
  `/unsteer` takes the last one back, and a directive typed while the run is still starting is queued too.

Sessions are indexed in `~/.jevcode/sessions/index.jsonl`; `jevcode sessions list|reindex|prune|unlock <id>` maintains it.

## Money

Two caps: the **run cap** (`limits.spendCapUsd`, default $2.00) and the **session cap** (`session.spendCapUsd`, default
5 × the run cap). The status line shows both: `run $x.xx/y.yy <word>  sess $x.xx/y.yy <word>`.

- `/budget` prints both caps, both spends and every pending value.
- `/budget session-spend-cap <usd|none>` applies **now** (`budget: session cap $10.00 → $15.00 (applies now)`), even
  before the first run, and is recorded in the session index.
- `/budget spend-cap|max-steps|max-wall|max-replans|max-generator-tokens <v>` applies to whichever comes first — the
  next `/resume` of the stopped run or the next new run — and is then spent (`/cost` lists it as `pending` until then).
- A follow-up that would exceed the session cap asks first: `follow-up would exceed the session cap` / `[y] start, run
  cap clamped to $x.xx   [r] raise session cap   [n]/Esc cancel`. With nothing left the item reads `session cap reached
  ($a of $b). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.`
- A run that stops on its cap explains the next move: `continue this run: /budget spend-cap 3.00 then /resume` or
  `or start a follow-up run with a fresh $2.000 cap`.

Unknown model pricing fails closed (exit 2) unless `--allow-unpriced` runs under a token cap instead.

## Secrets

Everything you type or paste passes a detector before it is sent: a submission, a steer, a `/rename` title, a review
note and the task text from argv, `--task-file` or stdin. A hit shows `Looks like this contains a secret (<label>). Send
anyway? y/N`; `y` sends the raw text to the generator (`[run] sent 1 secret to the generator on request`) and registers
the exact value with the redactor, so every artefact — `transcript.log`, `steps.jsonl`, `state.json`, the Jev requests,
`--json`, history, the session index and `jevcode.log` — reads `[REDACTED:…]` from then on (for this process only; a
later `--resume` does not remember it). Without a terminal the send is refused: `jevcode: the task contains a secret
(<label>); refusing to start (exit 2)`.

Pastes over a few lines become chips (`[Pasted #1, 541 lines]`); the body never touches disk. Keys are entered only
through the masked wizard or `jevcode login` (stdin or a masked prompt), never as command-line arguments. `@`-mentions
skip the secret denylist (`.env`, `~/.ssh`, …) unless `--allow-secret-mention` is set.

## Undo, rewind, diff

`/undo [step]` restores the files a step changed from the run's pre-images (a file changed since then outside JevCode
asks `<path> changed since step N (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort`); `/rewind [step]`
undoes every changed step back to one and can seed the next run from that step's plan (`files (done) · [p] plan+window
· [b] both · Esc keep`). `/diff` shows the git stat of the run's files, `/diff <step>` the step's pre/post images and
`/diff --full` the whole patch in your pager. These commands run one at a time: a second one while the first is still
working answers `error: /<cmd>: another command is still running (/<other>)`.

## Logs and reports

The controller's log of a run is `<runDir>/jevcode.log`; session-level and pre-run events go to
`~/.jevcode/logs/jevcode-<pid>-<stamp>.log` (newest 10 kept). `JEVCODE_LOG=<file>` redirects, `--verbose` /
`JEVCODE_LOG_LEVEL=debug` adds detail to the file only. `jevcode report <id>` and `/report` write a redacted bundle to
`~/.jevcode/reports/<id>/` (`run.json`, `transcript.log`, `jevcode.log` — the session log stands in when the run
directory has none — the last 20 `steps.jsonl` rows, `config.json`, `versions.txt`, `README.txt`); nothing is sent
anywhere.

## Exit codes

| Situation | `jevcode run` | session |
| --- | --- | --- |
| complete | 0 | item `exit 0`, the composer reopens |
| a budget stop (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `impossible`, a pause | 4 | item `exit 4`, the composer reopens |
| configuration or usage error (incl. an unreadable `--task-file`, a refused secret) | 2 | 2 |
| a rejected key or model drift on the first call | 2 | pane `[q]` → item `exit 2` |
| API failure after retries | 5 | item `exit 5` |
| checkpoint degraded and stopped | 3 | item `exit 3` |
| sandbox / path violation | 6 | item `exit 6` |
| Ctrl-C while live, external SIGINT | 130 | 130 for an external SIGINT; a Ctrl-C in the TUI aborts the run and stays |
| SIGTERM | 143 | 143 |
| SIGHUP / terminal gone | 129 | 129 |
| `/exit`, Ctrl-D ×2, Ctrl-C ×2 idle | — | 0 (`--exit-code last-run`: the last run's code; an aborted run counts as 130) |

Every exit prints one epilogue line on stderr — `jevcode: stopped — <code>: <msg> (exit N)` — followed by the `run`,
`files`, `resume` and `report` rows when a run exists.

## Development notes

`--mock` runs a scripted generator and decider offline. `JEVCODE_MOCK_REVIEW_AT=<step>` makes the mock decider put
that step in the review band so the review box can be exercised (used by `test/pty/run-smoke.sh`, which drives the
built bundle in a real pseudo-terminal through `scripts/pty/drive.exp`). `JEVCODE_TRACE=<file>` records startup and
run-lifecycle checkpoints (key classes only, never a key or a draft).
