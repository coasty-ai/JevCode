# JevCode

A coding-agent harness where **Jev makes every decision** and **Claude writes the code**.

JevCode runs a generator model (Claude Sonnet 5, through Anthropic or OpenRouter) behind one
`Provider` interface and hands every control-flow decision to Jev
(`typesafe/jev-1.13`, a calibrated decision model reached through OpenRouter's decisions
endpoint): what a step is for, which files the generator sees, whether a proposed action is
safe to run, whether its output succeeded, whether the task is done, and how to recover from
a loop. Code owns budgets, sandboxing, thresholds, arithmetic and checkpoints. One Ink TUI
shows the transcript, every Jev answer with its probability and confidence, and a status line
with step count, wall time, tokens and cost split by generator and Jev.

Design: [docs/DESIGN.md](docs/DESIGN.md). Research with sources and fetch dates:
[docs/RESEARCH.md](docs/RESEARCH.md). Decisions and deviations:
[docs/DECISIONS.md](docs/DECISIONS.md), DESIGN.md §16–§19.

## Install

Requires Node 22.12 or newer (pinned to 22.23.2 in `.nvmrc`; `engine-strict` is on), `git`,
and `/bin/sh`. Python 3 is needed only by the benchmarks.

```sh
git clone <this repo> && cd JevCode
npm install
npm run build          # bundles dist/jevcode.mjs and runs a first-frame smoke test
npm link               # optional: puts `jevcode` on PATH
```

Provide keys in `./.env` (see `.env.example`), in the environment, or as flags:

```sh
OPENROUTER_API_KEY=sk-or-v1-...     # generator via --provider openrouter, and Jev
ANTHROPIC_API_KEY=sk-ant-...        # generator via the default provider anthropic
```

## Run

```sh
jevcode run "Fix the failing tests in tests/test_core.py without changing the tests." \
  --workspace /path/to/repo --provider openrouter --model anthropic/claude-sonnet-5
jevcode run --resume 20260919-142301-k7q2m9xa     # continue a checkpointed run
jevcode config                                    # resolved config, secrets fingerprinted
echo "task text" | jevcode run --plain --workspace .   # non-TTY: plain line output
```

Exit codes: 0 complete · 2 configuration/usage · 3 corrupt checkpoint · 4 stopped by a
budget or directive · 5 API failure after retries · 6 sandbox/path failure · 130 Ctrl-C ·
143 SIGTERM (checkpoint written first in every case).

## Configuration

Precedence, highest first: **flag → environment variable → `./.env` → `<OPEN_ASSIST_PATH>/.env`
→ config file → default**. `.env` files are parsed with `node:util` `parseEnv` into an
isolated map, never into `process.env`. Validation happens at first use, not at launch, so
the first frame renders with zero network and zero file reads.

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Generator provider | `--provider` | `JEVCODE_PROVIDER` | `anthropic` (`anthropic` or `openrouter`) |
| Generator model | `--model` | `JEVCODE_MODEL` | `claude-sonnet-5` (`anthropic/claude-sonnet-5` on OpenRouter) |
| Generator key | `--api-key` | `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` by provider, or `JEVCODE_API_KEY` | none |
| Generator base URL | `--base-url` | `JEVCODE_BASE_URL` | `https://api.anthropic.com` / `https://openrouter.ai/api/v1` |
| Generator temperature | `--temperature` | `JEVCODE_TEMPERATURE` | unset: not sent (Sonnet 5 rejects non-default sampling parameters) |
| Generator max tokens | `--max-tokens` | `JEVCODE_MAX_TOKENS` | `4096` |
| Decider base URL | `--jev-base-url` | `JEV_BASE_URL` | `https://openrouter.ai/api/alpha/decisions` |
| Decider key | `--jev-api-key` | `JEV_API_KEY`, falling back to `OPENROUTER_API_KEY` | none |
| Decider model | `--jev-model` | `JEV_MODEL` | `typesafe/jev-1.13-20260917` (dated id; aliases are resolved and warned about) |
| Spend cap, USD, generator + Jev | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `2.00` |
| Max steps | `--max-steps` | `JEVCODE_MAX_STEPS` | `40` |
| Max wall time | `--max-wall` | `JEVCODE_MAX_WALL` | `30m` (e.g. `90s`, `7h30m`) |
| Max replans | `--max-replans` | `JEVCODE_MAX_REPLANS` | `5` |
| Completion threshold | `--complete-threshold` | `JEVCODE_COMPLETE_THRESHOLD` | `0.85` |
| Impossible threshold | `--impossible-threshold` | `JEVCODE_IMPOSSIBLE_THRESHOLD` | `0.85` |
| Workspace | `--workspace` | `JEVCODE_WORKSPACE` | current directory |
| Runs dir | `--runs-dir` | `JEVCODE_HOME` | `~/.jevcode/runs` |
| Open Assist path | `--open-assist-path` | `OPEN_ASSIST_PATH` | sibling `../open-assist` if it exists |
| Config file | `--config` | `JEVCODE_CONFIG` | `./jevcode.json`, else `~/.config/jevcode/config.json` |
| Sandbox profile | `--sandbox` | `JEVCODE_SANDBOX` | `auto` (`seatbelt` on macOS, `none` elsewhere) |
| Network for commands | `--no-network` | | allowed |
| Plain output | `--plain` | | automatic when stdout or stdin is not a TTY |
| Generator prices, USD per MTok | | `JEVCODE_PRICE_IN_PER_M`, `JEVCODE_PRICE_OUT_PER_M` | Sonnet 5: 2 / 10 (used when the API returns no cost) |

Risk thresholds are fixed by design: risk ≥ 0.7 blocks the action and tells the generator
why; 0.3–0.7 pauses for human confirmation in the TUI with no auto-approve (in bench runs
this counts as blocked); below 0.3 executes.

Keys never appear in logs, results, checkpoints or subprocess environments. `jevcode config`
and `run.json` show a secret only as its source and the first 8 hex characters of its
SHA-256. Every artefact passes a redactor seeded with every configured secret, every
secret-looking value in every loaded `.env`, and the common key formats.

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

## Sandbox guarantees

Commands run through `/bin/sh -c` in a detached process group with `cwd` fixed to the
workspace, a scrubbed environment (`PATH`, `LANG`, `TERM`; `HOME` and `TMPDIR` remapped
into the run directory; no API keys), a timeout (default 120 s, max 600 s, clamped to the
remaining wall-time budget), an output cap (200 KB head plus a 16 KB rolling tail; passing
it never kills the command), and a three-pass tree kill (snapshot, SIGTERM, SIGKILL, orphan
report) on timeout, cancel, Ctrl-C or SIGTERM.

On macOS the command additionally runs under `sandbox-exec` with a generated profile: writes
are denied everywhere except the workspace, the run's temp and home dirs and `/dev`
devices; `.git/config` and `.git/hooks` are write-denied; reads of the harness's own `.env`
and config files, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc` and `~/.jevcode` are
denied; `--no-network` denies all network. `sandbox-exec` is deprecated by Apple but is the
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

## Performance

Budgets: first frame under 300 ms with zero network at launch; harness overhead under 50 ms
per step; rendering never blocks the loop. `npm run perf` measures all three (plus Jev
latency with `--live`) and writes `perf/results/latest.json`.

| Measurement | Result | Gate |
| --- | --- | --- |
| First frame, cold, p95 over 10 runs (pseudo-TTY via `script`) | _to be measured_ | < 300 ms |
| First frame, warm compile cache, median | _to be measured_ | |
| Harness overhead per step, p95 (mocked zero-latency, 50 steps) | _to be measured_ | < 50 ms |
| Event-loop lag under the TUI, p95 / max | _to be measured_ | < 5 ms / < 50 ms |
| Jev latency, p50 / p95 (live) | _to be measured_ | report only |

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

Results: _filled in after the live runs_.

## Dependencies and why

Runtime: `ink` (the TUI; the prompt requires Ink) and `react` (Ink's peer). Nothing else:
HTTP is `fetch`, SSE parsing is a small WebStreams reader, `.env` is `util.parseEnv`,
arguments are `util.parseArgs`, hashing is `node:crypto`, processes are `node:child_process`,
atomic writes are temp-file + `rename(2)`.

Dev: `typescript` 7.0.2 (`tsc --noEmit`, strict, no `any` enforced by `scripts/no-any.mjs`),
`vitest` 5 + `vite` (its non-optional peer) + `@vitest/coverage-v8`, `ink-testing-library`
(TUI frame tests), `esbuild` (one ESM bundle; measured 64–72 ms first frame vs 643 ms
unbundled), `tsx` (run TSX sources in development), `@types/node` 22 and `@types/react`.

## Development

```sh
npm run typecheck      # tsc --noEmit + no-any check
npm test               # offline unit tests
npm run test:live      # hits Jev and the generator; skips suites whose key is missing
npm run perf           # builds, then measures first frame, step overhead, render lag
```

## Status

See the final report in [docs/STATUS.md](docs/STATUS.md) for what was built, what was
verified live, what could not be verified on this machine, and open questions.
