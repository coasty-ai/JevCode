# CLI reference

Every command and every flag. This page is cross-checked against the one flag table in
`src/cli/args.ts` and the generated manual page, not written from memory.

Two commands generate their own documentation from the same table, so they never drift:

```sh
jevcode --help              # the command list
jevcode <command> --help    # that command's flags
man jevcode                 # the full manual page
```

## Commands

| Command | What it does |
| --- | --- |
| `chat` | interactive session — the default when no command is given |
| `run` | run one task; `--resume` continues a stored run |
| `config` | print the resolved configuration with the source of every value |
| `bench` | run the benchmark suites |
| `perf` | run the performance gates |
| `login` | store an API key, from a masked prompt or from stdin |
| `logout` | remove a stored API key |
| `sessions` | list, reindex, prune or unlock sessions |
| `report` | write a redacted support bundle for a run |
| `why` | explain one Jev decision of a stored run |
| `calibration` | reliability report over this workspace's runs |
| `completion` | print the shell completion script |
| `upgrade` | upgrade through the detected package manager |

A bare `jevcode`, or a `jevcode` whose first argument is a flag, is `jevcode chat`.
`jevcode run` with no task on a terminal is `jevcode chat` too.

## Synopsis

```
jevcode [chat] [flags]
jevcode run <task text> | --task-file <path> | --resume <id|title> [flags]
jevcode config [set <setting> <value>] [--all] [flags]
jevcode bench [flags]
jevcode perf [flags]
jevcode login [flags]
jevcode logout [--generator] [--jev]
jevcode sessions [list|reindex|prune|unlock <id>]
jevcode report <id> [--include-requests] [--out <dir>]
jevcode why <id> <step> <ref>
jevcode calibration [flags]
jevcode completion bash|zsh|fish
jevcode upgrade [<version>|latest|next] [--check] [--method <manager>]
```

## Common flags

Accepted by `chat`, `run`, `config`, `bench` and `perf`. `config` accepts them so that it can
print what a run *would* resolve to.

| Flag | Argument | Meaning |
| --- | --- | --- |
| `--provider` | `anthropic\|openrouter` | generator provider (also accepted by `login`) |
| `--model` | `<id>` | generator model id |
| `--api-key` | `<key>` | generator API key — prefer the environment variable |
| `--base-url` | `<url>` | generator base URL |
| `--temperature` | `<t>` | generator temperature; unset means not sent |
| `--max-tokens` | `<n>` | generator max output tokens |
| `--jev-base-url` | `<url>` | decision model base URL |
| `--jev-api-key` | `<key>` | decision model API key — prefer the environment variable |
| `--jev-model` | `<id>` | decision model id; a dated id pins it |
| `--jev-provider` | `auto\|typesafe\|openrouter` | default `auto`: TypeSafe when `TYPESAFE_API_KEY` is set, else OpenRouter (also accepted by `login`, where the value must be `typesafe` or `openrouter`) |
| `--spend-cap` | `<usd>` | run spend cap; on `bench`, the total for the whole bench |
| `--max-steps` | `<n>` | max steps per run |
| `--max-wall` | `<dur>` | max wall time per run — `30m`, `7h30m`, `90s` |
| `--max-replans` | `<n>` | max replans per run |
| `--complete-threshold` | `<p>` | completion probability threshold |
| `--impossible-threshold` | `<p>` | task-impossible probability threshold |
| `--workspace` | `<dir>` | workspace directory; default the current directory |
| `--runs-dir` | `<dir>` | run directory root; default `~/.jevcode/runs` |
| `--extra-env-file` | `<dir>` | a checkout whose `.env` is read as an additional fallback layer |
| `--config` | `<file>` | config file; default `./jevcode.json`, else `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` |
| `--sandbox` | `auto\|seatbelt\|none` | sandbox profile |
| `--no-network` | | deny network access to sandboxed commands |
| `--plain` | | plain line renderer instead of the terminal UI |
| `-h`, `--help` | | show usage |
| `-v`, `--version` | | print the version; with `--json`, also node, ink, react and the bundle |

`--workspace`, `--runs-dir` and `--config` are also accepted by `login`, `logout`, `sessions`,
`report`, `why` and `calibration`, which need to locate files without running anything.

## Session flags

`chat` and `run` only.

| Flag | Argument | Meaning |
| --- | --- | --- |
| `-c`, `--continue` | | continue the most recently used session in this workspace |
| `--resume` | `<id\|title>` | continue a run by id, or a session by exact title or unique prefix; on `bench`, resume a bench id |
| `--force` | | with `--resume` or `--continue`: resume a run that already completed, instead of seeding a follow-up |
| `--list-sessions` | | print this workspace's sessions and exit |
| `--task-file` | `<path>` | `run` only: read the task text from a file |
| `--mode` | `jev-only\|jev-on\|jev-off\|llm-jev` | engine mode; the default is `llm-jev` |
| `--json` | | NDJSON event stream on stdout, non-interactive; `--json=verbose` adds status events |

`--json` is also accepted by `config`, `sessions`, `why` and `calibration`, where it switches
the output to JSON.

## Interface flags

`chat`, `run` and `config`.

| Flag | Argument | Meaning |
| --- | --- | --- |
| `--theme` | `dark\|light\|daltonized\|ansi` | colour theme; there is no auto-detection |
| `--fps` | `<n>` | frames per second, 5 to 30; default 30, 15 over SSH; fixed at launch |
| `--render-mode` | | renderer mode; default standard; fixed at launch |
| `--renderer` | `classic\|fullscreen` | default `classic`; `fullscreen` pins the header on the alternate screen and needs 18 rows by 40 columns; fixed at launch |
| `--fullscreen` | | shorthand for `--renderer fullscreen` |
| `--ascii` | | ASCII glyphs; automatic on `TERM=dumb`, `TERM=linux` and a non-UTF-8 locale |
| `--title` | | set the terminal title |
| `--screen-reader` | | numbered prompts, no bars; implies `--plain` on a pipe |
| `--no-animation` | | reduced motion: static spinner, 1 Hz clock. Alias `--reduced-motion` |
| `--notify` | | a terminal notification when a review waits or a run ends |
| `--osc52` | | allow clipboard writes through the terminal; write only |
| `--no-history` | | do not persist composer history |
| `--no-input` | | no interactive renderer; every prompt takes its safe default. `run` only, and it needs a task |
| `--trust-workspace` | | trust the workspace's instruction files, `./.env` and `jevcode.json` without the prompt |
| `--no-budget-warnings` | | mute budget toasts and the bell; items and JSON events stay |
| `--allow-secret-mention` | | allow mentions of denylisted secret files after a per-mention confirmation |
| `--no-color` | | disable colour; same as `NO_COLOR` |
| `--exit-code` | `zero\|last-run` | session exit code: always 0, the default, or the last run's code |
| `--keybindings` | `<file>` | keybindings file |
| `--log` | `<file>` | log file; default `<runDir>/jevcode.log` |
| `--log-level` | `error\|warn\|info\|debug\|trace` | default `info`; file only, and keys never appear in logs |
| `--verbose` | | same as `--log-level debug` |
| `--session-spend-cap` | `<usd>\|none` | default 5× the run cap; `none` is uncapped |
| `--allow-unpriced` | | run an unpriced model under a token cap instead of refusing |
| `--max-generator-tokens` | `<n>` | the token cap under `--allow-unpriced`; default the spend cap divided by 15, times one million |
| `--update-notify` | | post-run update check |

## Benchmark flags

`bench` only, except `--live` and `--out`.

| Flag | Argument | Meaning |
| --- | --- | --- |
| `--suite` | `swebench\|terminal-bench\|quixbugs\|ladder\|all` | which suite |
| `--tasks` | `<n>` | number of tasks |
| `--task-id` | `<id>[,<id>…]` | specific task ids |
| `--conditions` | `<arm>[,<arm>…]` | which arms to run; when omitted, the `jev-on` and `jev-off` arms |
| `--concurrency` | `<n>` | parallel runs |
| `--task-spend-cap` | `<usd>` | per-run spend cap; default 2.00 |
| `--allow-model-alias` | | allow an undated decision-model id |
| `--archive-runs` | | copy each run's records, gzipped, into the results directory |
| `--quick` | | a small preset: five tasks, concurrency 3, replay, and a low spend cap — all as **defaults** that never override an explicit flag |
| `--live` | | use the real generator and the real decision model; requires `--spend-cap`. Also accepted by `perf` |
| `--out` | `<path>` | `bench`: results directory. `perf`: results file. `report`: bundle directory |

## Key flags

| Command | Flag | Meaning |
| --- | --- | --- |
| `login` | `--key-stdin` | read **one** OpenRouter key from the first stdin line; it serves both sides |
| `login` | `--generator-key-stdin` | read the generator key from the first stdin line |
| `login` | `--jev-key-stdin` | read the decision-model key from the next stdin line |
| `login` | `--status` | print which keys are set and where they come from — fingerprints only |
| `login` | `--verify` | one priced decision (~$0.00002), one 1-token completion (~$0.000002), and a free key-info call |
| `logout` | `--generator` | remove the saved generator key |
| `logout` | `--jev` | remove the saved decision-model key |
| `config` | `--all` | include the hidden bookkeeping rows |

`jevcode config set <setting> <value>` writes one setting. It **refuses secret settings**.

## Inspection flags

| Command | Flag | Meaning |
| --- | --- | --- |
| `report` | `--include-requests` | include the redacted request bodies in the bundle |
| `upgrade` | `--check` | only report whether a newer version exists, with a 2 s registry timeout |
| `upgrade` | `--method <manager>` | `npm\|brew\|bun\|pnpm\|yarn`; default is detected from the install path |

`jevcode report` writes to `~/.jevcode/reports/<id>/` by default. **Nothing is sent anywhere.**
Every file is redacted line by line and capped.

A handful of further flags exist for the performance drivers and for debugging. They are hidden
from `--help` on purpose and are not part of the supported surface.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | complete, or the generator finished; also `/exit`, Ctrl-D twice, Ctrl-C twice while idle |
| 1 | an uncaught error, or an escalated render fault |
| 2 | a configuration or usage error at launch; a 401 or 403 on the first call; an unpriced model without `--allow-unpriced` |
| 3 | the checkpoint degraded and the run stopped — `state.json` is not resumable |
| 4 | a budget stop: max steps, wall time, spend cap, max replans, token cap; also a replan stop, an impossible verdict, or a human pause |
| 5 | an API failure after retries, or a provider spend limit |
| 6 | a sandbox or path abort |
| 129 | `SIGHUP` |
| 130 | Ctrl-C twice while a run is live, or an external `SIGINT` |
| 143 | `SIGTERM` |

`--exit-code zero` — the default for a session — always exits 0, because leaving is not a
failure. `--exit-code last-run` returns the last run's code instead.

## Environment

| Variable | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `JEV_API_KEY`, `ANTHROPIC_API_KEY` | decision-model and generator keys — see [Keys](../getting-started/keys-and-providers.md) |
| `JEVCODE_MODE` | `jev-only \| jev-on \| jev-off \| llm-jev`; default `llm-jev` |
| `JEVCODE_PROVIDER`, `JEVCODE_MODEL`, `JEVCODE_API_KEY` | the generator's provider, model and key |
| `JEV_PROVIDER`, `JEV_BASE_URL`, `JEV_MODEL` | the decision model's provider, endpoint and model id |
| `JEVCODE_HOME` | root of `runs/`, `sessions/` and history; default `~/.jevcode` |
| `JEVCODE_CONFIG`, `JEVCODE_KEYBINDINGS` | file paths |
| `JEVCODE_EXTRA_ENV_FILE` | a checkout whose `.env` is read as an additional fallback layer |
| `JEVCODE_SPEND_CAP_USD`, `JEVCODE_SESSION_SPEND_CAP_USD` | spend caps |
| `JEVCODE_THEME`, `JEVCODE_FPS`, `JEVCODE_ASCII`, `JEVCODE_SCREEN_READER`, `JEVCODE_REDUCED_MOTION`, `JEVCODE_RENDERER`, `JEVCODE_WORDMARK` | interface settings |
| `JEVCODE_LOG`, `JEVCODE_LOG_LEVEL`, `JEVCODE_TRACE` | log file and level; keys never appear in logs |
| `JEVCODE_ROUTERS=on`, `JEVCODE_WARM=on` | arm the two default-off mechanisms — see [Status](../status/README.md) |
| `JEVCODE_FASTPATH=off\|auto` | the bounded fast path, which is `auto` under `--mode jev-on` and off in every other mode |
| `JEVCODE_JEV=off\|escape\|unreachable` | replace the decision model with a deterministic double; unset means Jev is on |
| `NO_COLOR`, `FORCE_COLOR` | colour control |
| `CI`, `TERM=dumb` | select the plain renderer |

Resolution order for every setting, highest first: **flag, then the process environment, then
`./.env`, then the extra `.env` file, then the config file, then the built-in default.** The
interface settings that are fixed at launch — frame rate, render mode, glyphs, screen reader,
colour — never read the config file, and a file value for one of them is recorded as ignored.

## Files

| Path | What it is |
| --- | --- |
| `~/.jevcode/runs/<run-id>/` | the run directory: `run.json`, `state.json`, `steps.jsonl`, `decisions.jsonl`, `jev.jsonl`, `transcript.log`, `jevcode.log`, before and after images |
| `~/.jevcode/sessions/index.jsonl` | the session index |
| `~/.jevcode/history.jsonl` | composer history, redacted |
| `~/.jevcode/trust.json` | workspace trust decisions |
| `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` | configuration and stored keys, mode `0600` |
| `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` | key rebindings |
| `./jevcode.json`, `./.env` | per-workspace configuration and environment fallback |

## Inside a session

Slash commands and keys are their own tables, generated from the registries in the source:
[`../COMMANDS.md`](../COMMANDS.md) and [`../KEYS.md`](../KEYS.md). `/` lists the commands and
`?` shows the keys while you are in a session.

## Next

- [Install](../getting-started/install.md)
- [Keys](../getting-started/keys-and-providers.md)
- [The four modes](../getting-started/modes.md)
- [Status](../status/README.md)
