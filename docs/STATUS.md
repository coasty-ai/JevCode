# JevCode status report (2026-09-19/20)

## What was built

One package at `vscode/JevCode` (its own git repository, nothing imported from Open Assist):

- **Loop.** Intent Choice with an escape option and a paired Noul per option → context Nouls over
  path-keyed candidate files (one request) → one tool-call proposal from the generator
  (`edit | write | patch | run | read | done`, fenced-JSON fallback) → four 5-level risk Scores
  (destructive, out of scope, plan mismatch, irreversible; risk = max; ≥ 0.7 blocks with the
  reason returned to the generator, 0.3–0.7 asks a human inline in the TUI with no
  auto-approve, bench counts it as blocked) → sandboxed execution → judge Nouls with
  code-computed test counts in the criteria → completion Noul with a configurable stop
  threshold (0.85) and budgets (spend cap, max steps, max wall time, max replans), recording
  which fired. Persistent plan with evidence, bounded 4-step window (tokens per step stay flat:
  ~12k generator tokens per step at step 1 and at step 25 in the live bench), atomic
  checkpoints every step, `--resume <run-id>`, loop detection (same command+result, patch hash,
  failure, unresolved intent ×3) → replan Choice. No benchmark-specific heuristics.
- **Jev client** ported from `lab.mjs` to strict TypeScript: same wire protocol, headers,
  request hashing and redaction; jittered retry (500 ms doubling to 5 s, 25 % jitter,
  `Retry-After` ≤ 60 s, 408/429/5xx except 501), 10 s per-attempt timeout via a linked
  controller, abort-aware body reads, hand-written response validation, model-id pin
  (`typesafe/jev-1.13-20260917`) with alias resolution and drift detection, harness-computed
  confidence: Choice `(p_max − 1/n)/(1 − 1/n)`, Score `1 − E|k − argmax|/U_n`.
- **Generator providers** for Anthropic Messages and OpenRouter chat completions with fetch,
  SSE streaming, tool calling, usage/cost accounting (OpenRouter `usage.cost`; Anthropic from
  a pricing table incl. cache tokens), idle timeouts, jittered retries; `temperature` not sent
  (Sonnet 5 rejects it).
- **Sandbox.** `sh -c` in a detached process group with cwd = workspace, scrubbed env (`.venv/bin`
  on PATH when present), 120 s default / 600 s max timeout clamped to wall time, 200 KB output
  cap with a rolling tail (never kills), three-pass tree kill with orphan reporting, macOS
  `sandbox-exec` profile (writes confined to workspace + run dirs, `.git/config`/hooks
  write-denied for agent commands, harness secret files and other runs' checkpoints
  unreadable, `--no-network`), path confinement with symlink checks, `git apply --check`
  before `git apply`, harness git with hooks/fsmonitor/external diff disabled.
- **Checkpoints.** `run.json`, atomic `state.json` (+`state.prev.json`, checksum), `steps.jsonl`,
  `decisions.jsonl` (every Jev answer with probability and confidence), `jev.jsonl`,
  `generator.jsonl`, `transcript.log`; everything redacted; corrupt state falls back to the
  previous copy; `--resume` reconciles identity from `run.json` and limits from the invocation.
- **TUI.** One Ink 7 app: `<Static>` transcript, live streaming region, decisions pane (stage,
  id, answer, probability, confidence; review/block highlighted), status line (step, wall
  time, tokens and cost split by generator and Jev), inline confirmation that blocks the loop;
  plain line renderer when stdout is not a TTY; `transcript.log`, plain output and the TUI
  transcript agree line for line.
- **Bench.** 30-task SWE-bench Verified subset (checked in with specs and `eval.sh`), 10
  Terminal-Bench 4.0 tasks (checked in with a 66-task feasibility manifest), Jev on vs off,
  mocked end to end by default, `--live --spend-cap`, per-task JSONL, `summary.json`,
  `comparison.md` (solve curve, tokens-per-step curves split by generator/Jev/combined),
  official `predictions.<condition>.jsonl`, local-venv SWE-bench evaluator replicating
  `eval.sh`, path-shim Terminal-Bench runner, Harbor installed-agent adapter, `bench --resume`.
- **Quality.** Strict TypeScript 7 (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`), no `any` (enforced), ESM, Node 22.23.2 pinned, runtime deps `ink` +
  `react` only; 59 unit-test files / 739 offline tests; live suites for Jev and both providers;
  `perf` script with gates.

## Verified live (real API calls, user's OpenRouter key; the session's Anthropic key was not used)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (tsc 7.0.2 + no-`any` check) |
| `npm test` | 59 files, 739 tests pass |
| `npm run test:live` | Jev: dated id served, confidence formulas within 0.02, cost = tokens × 4.2e-8; OpenRouter Sonnet 5 tool call; Anthropic suite skipped (no project key; it passed once earlier with the session key, see DECISIONS.md) |
| `npm run perf` | first frame cold p95 89.9 ms (< 300), harness overhead p95 31.2 ms (< 50), event-loop lag p95 3.2 ms, zero terminal clears |
| Live TUI demos (`docs/live/`) | complete fix with two approved reviews and a loop trip → replan (`01-fix`, 9 steps, $0.115); blocked `rm -rf tests` at risk 0.92 (`02b-blocked`); declined review on an untracked-file removal then a repeat blocked (`03`); `--no-network` denial, `fix_environment` intent and a live command timeout (`04`); Ctrl-C mid Jev request → rule-1 discard → checkpoint → `--resume` continues from the next step (`05c`) |
| Mocked bench | SWE-bench 3/3 both conditions; Terminal-Bench 2/10 pass locally (the rest need tools absent here) |
| Live SWE-bench | 3-task slice: jev-on 3/3, jev-off 2/3 (`live-slice-3b`); full 30: jev-on 9/29, jev-off 10/29 paired (table below) |

## Live 30-task SWE-bench Verified run (`bench/results/live-swebench-30`)

Paired over the 29 tasks evaluated in both conditions (`pytest-dev__pytest-10051` jev-off was
`invalid`: the test command produced no parsable results); 60 runs, $46.25 total across the
first pass and the resume, cap not hit, no `not_run` pairs. Evaluator: local venv replicating
`eval.sh` (unofficial). Both conditions: Claude Sonnet 5 via OpenRouter, 25 steps max, 20 min
wall, $1.50 per run, seatbelt sandbox, reviews declined in bench by design.

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate (passed / evaluated) | 9/29 (31.0 %) | 10/29 (34.5 %) |
| steps-to-solve, mean (median) over passed | 23 (25) | 22 (25) |
| steps used, mean over runs | 24.2 | 23.9 |
| runs stopped by the step budget | 24 | 24 |
| `read` actions, total / per run | 83 / 2.9 | 124 / 4.3 |
| blocked / reviews (all declined) | 208 / 170 | 0 / 0 |
| loop trips / replans | 46 / 40 | 28 / 0 |
| Jev requests / questions | 2,631 / 212,508 | 0 |
| Jev latency p50 / p95 | 237 ms / 547 ms | – |
| generator tokens per step, mean | 5,519 | 6,767 |
| Jev tokens per step, mean | 28,351 | 0 |
| wall time per run, mean | 3 m 05 s | 2 m 21 s |
| cost, generator / Jev / total | $22.71 / $1.49 / $24.21 | $20.44 / $0 / $20.44 |

Reading: on this subset Jev did not raise the pass rate (9 vs 10, within noise at n = 29) but
changed how the runs behaved: 18 % fewer generator tokens per step (Jev-selected context
replaced `read` steps: 83 vs 124), 10 of 30 jev-on runs ended with an empty patch after
repeated blocks and declined reviews (~13 non-executing actions per run), and jev-on almost
never declared completion (its solved tasks ran to the 25-step budget with a correct patch
on disk while jev-off stopped on `done` at 15–20 steps in several tasks). Jev itself cost
$1.49 for 212k questions at p50 237 ms. The per-step generator tokens stay flat across the
run in both conditions (4.7k at step 1, ~5–6k at step 25), which was the long-horizon goal.
Raw data: `tasks.jsonl`, `summary.json`, `comparison.md` (solve curve and three tokens-per-step
curves), `predictions.jev-on.jsonl` / `predictions.jev-off.jsonl` (official shape).

## What could not be verified here

- **Official SWE-bench / Terminal-Bench grading.** No Docker (or Apple `container`) on this
  machine; `swebench`, `sb-cli` and `harbor` need Python ≥ 3.10/3.12. SWE-bench `pass` comes
  from the local-venv evaluator that replicates `eval.sh` with the official log-parser rules
  and is labelled unofficial; the prediction files can be graded with `sb-cli` elsewhere.
  Terminal-Bench was only run mocked locally (2/10 pass with upstream solutions); its live run
  needs containers (`bench/harbor/jevcode_agent.py` is shipped but untested).
- **Anthropic-direct provider in a full run.** Exercised by its live test with a session key
  once and by SSE fixtures; every run and bench used `--provider openrouter`.
- **Process-tree kill of daemons that re-parent to launchd before the snapshot**, documented
  as a limit; the three-pass kill handles new sessions/process groups.
- **Linux sandboxing.** Only cwd confinement, env scrubbing, timeout, output cap and tree kill
  outside macOS (level `none`), as designed and printed by `jevcode config`.

## Open questions

- Completion calibration: jev-on solved tasks in the live bench but rarely reached
  `task_complete ≥ 0.85`, running to the step budget while jev-off stopped on `done`
  (15–20 steps). The criteria require a current passing run of the detected test command;
  agents mostly ran targeted tests. Lowering the threshold or accepting a targeted run as
  evidence is a calibration choice to make from the recorded decisions.
- Reviews in bench are declines by design; jev-on spent ~6 blocked/declined actions per run
  in the first pass, mostly on `plan_mismatch` (now tail-mass bound) and repeated failed
  edits (level 4). Whether a "repeat of a failed edit" should block or merely warn is open.
- Plan retention bloat (§17 of DESIGN.md), intent-override frequency (paired-Noul floor 0.5),
  and the pytest `-qq` case are recorded with evidence for tuning.
- Jev context Nouls over up to 300 files cost ~60k Jev tokens per step ($0.0025); cheap, but
  the candidate pre-filter could be tightened without changing the design.
