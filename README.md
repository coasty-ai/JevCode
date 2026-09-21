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
devices; `.git/config` and `.git/hooks` are write-denied; reads of the harness's own `.env`
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

## Performance

Budgets: first frame under 300 ms with zero network at launch; harness overhead under 50 ms
per step; rendering never blocks the loop. `npm run perf` measures all three (plus Jev
latency with `--live`) and writes `perf/results/latest.json`.

| Measurement | Result | Gate |
| --- | --- | --- |
| First frame, cold compile cache, p95 over 10 runs (pseudo-TTY via `script`, zero network asserted) | 89.9 ms | < 300 ms |
| First frame, cold, median | 89.0 ms | |
| First frame, warm compile cache, median | 80.1 ms | |
| Harness overhead per step, p95 (mocked zero-latency run, 50 steps, 5,000-file git fixture plus 5,000 ignored files) | 31.2 ms | < 50 ms |
| Harness overhead per step, p50 | 21.7 ms | |
| Event-loop lag under the TUI, p95 (rows 40 / rows 12) | 3.2 ms / 2.1 ms | < 5 ms |
| Event-loop lag under the TUI, max (rows 40 / rows 12) | 3.3 ms / 2.3 ms | < 50 ms |
| Terminal clears after the first frame (rows 40 / rows 12) | 0 / 0 | 0 |

Measured 2026-09-19 on an Apple Silicon Mac (15 cores, 24 GB), Node 22.23.2, macOS 26;
raw values in `perf/results/latest.json`. Bare `node -e` starts in about 17 ms on this
machine, so the TUI's first frame costs roughly 70 ms of module loading and layout. The
harness budget was met after folding the per-step `git status` spawns into one cached call per
command run (see `docs/DECISIONS.md`).

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
JEVCODE_TRACE=/tmp/t.log jevcode run …   # opt-in shutdown trace: keystrokes, abort, loop boundaries, finish
```

## Status

See the final report in [docs/STATUS.md](docs/STATUS.md) for what was built, what was
verified live, what could not be verified on this machine, and open questions.
