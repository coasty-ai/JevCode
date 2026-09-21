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

## Jev-only mode (2026-09-20)

A second mode with **no generating LLM**: code proposes candidate edits, Jev decides, tests
verify. Design: `docs/JEV-ONLY-DESIGN.md`. Dated log of every round: `docs/JEV-ONLY.md`.
Per-round tables: `experiments/results/jev-only-rungs-1-2.md`. Audit of the claim "Jev and no
other model": `experiments/results/jev-only-audit.md` (the only reachable LLM endpoint in this
mode is the pinned Jev decisions endpoint; every checked-in jev-only record carries
`generatorCalls: 0`).

### What was built

- **Contract and engine plumbing.** `EngineMode 'jev-only'`; a `Synthesizer`
  (`synthesize(ctx) → Proposal`) replaces the propose stage; `Proposal.evidence` carries
  code-computed shadow test-run evidence; `SynthesisContext.runDir` and a persisted, bounded,
  redacted `synthState` (`src/core/types.ts`). `src/provider/null.ts` throws if `generate()` is
  reached and `src/loop/engine.ts` refuses to call it in this mode. Bench: `--conditions jev-only`,
  `generatorCalls` per record, `invalid` on a non-zero count (`src/bench/runner.ts`,
  `src/bench/conditions.ts`); every `tasks.jsonl` line passes through the redactor.
- **Search controller ("Ledger + Sieve"), `src/synth/search/`.** `goals.ts` (one goal per
  failing-test cluster, the attack-first Choice, park rules), `index.ts` (the outer step,
  repository-mode initialisation and re-baseline, the introspection and history harvests),
  `subgoal.ts` (phases SEEDS → SKETCH → BEAM → WIDENED, whole-site SIEVE batches, pairs of
  partials), `budget.ts` (oracle model, per-step caps, `repositoryRunsPerStep`), `bases.ts`
  (held passers; partials that survive a park, persisted ≤ 4 per goal), `guard.ts` and
  `perturb.ts` (behaviour clustering on perturbed inputs, suspicion signals, Q15/Q16
  arbitration), `sites.ts` (Jev line anchors, gap slots, the loop-exit gap, statement-level
  sites, introspection-derived class-body and import gaps), `directive.ts` (replan directives;
  `change_approach` reopens every parked goal), `composite.ts` (pairs, signature and donor-body
  units, bounded), `memory.ts` (run memories, re-baseline file cache, LRU of four),
  `proposal.ts` (patch / run / read / done proposals with evidence).
- **Verification.** `src/synth/sieve/` (queue with a vocabulary pre-check, worktree or `cp -R`
  lanes, a runner with tail-based per-case timeouts, load scaling and a one-time in-flight
  retry), `src/synth/verify/` (candidate application including statement spans; pytest,
  QuixBugs, unittest, Django and sympy output parsers; progress arithmetic),
  `src/workspace/tests.ts` (native runner detection: `tests/runtests.py`, `bin/test`,
  `unittest discover`, scoped commands).
- **Issue oracle and repository mode, `src/synth/oracle/`.** `extract.ts` (fenced, REPL,
  traceback and expectation blocks from the issue text), `questions.ts` (one Jev batch per
  instance: `is_reproduction_i`, `shows_expected_i`, `shows_actual_i`, Choice `failure_kind`),
  `runner.ts` (a runnable script with a code-computed pass criterion under
  `PYTHONHASHSEED=0`), `verify.ts` (lanes verify the reproduction, then the scoped regression
  suite), `search.ts` (regression scope ≤ 6 related test files, the confirmation run, the
  best-guess goal that commits once per run labelled unverified), `goal.ts`.
- **Candidate sources.** `src/synth/mutate/` (operator families, including
  `collapse_collection_to_element` at statement sites), `src/synth/templates/` (guards,
  conditions, branches, imports, statements, signatures, attribute and callee substitution,
  `stdlib.ts` stdlib-sibling substitution carrying its import, `wrap.ts`, `wrap2.ts` depth-2
  wraps, `introspect.ts` attribute-predicate guard and MRO method alias), `src/synth/donor/`
  (donor lines with identifiers re-bound), `src/synth/sketch/` + `fill/` + `beam/` (sketch
  productions, slot filling, grammar-guided token beam), `src/synth/introspect/` (names
  harvested from the failing call: MRO class names, `is_*` predicates, module names),
  `src/synth/history/` (git-history reversals as candidates), `src/synth/localize/` with
  `src/synth/sbfl/` (file, function and line stages; Ochiai top-5 unioned), `src/synth/rank/`.
- **Loop-side rules for jev-only.** `src/loop/stages/risk.ts` (`completionVerifiedByRun`,
  `isVerificationRun`, `novelVerifiedPatch`, `PatchHistory`), `src/loop/loopdetect.ts`
  (refused-proposal signatures; `fail:` is the failing-test set), `src/loop/state.ts`
  (`doneExecutedJson`, `commonRunGreen`), `src/loop/stages/intent.ts` (ledger-aware intent, the
  `finish` rescue on a green run), `src/loop/stages/complete.ts` (`executed.lastRun` in the
  completion criteria), `src/loop/engine.ts` (`verifiedCompletion`, `repeatedGatherContextExit`).
- **Bench data and tooling.** `bench/data/quixbugs` (40 programs), `bench/data/ladder` (12
  short-tier and 8 long-tier tasks, `check.py`), the SWE-bench 30 with their native runners
  (`src/bench/swebench/loader.ts`); `experiments/inspect/quixbugs-verdicts.mts` (per-program
  correctness); `experiments/reach/*` (reach at the gold site, $0).
- Unit tests at the last recorded gates: `test/unit/synth` 79 files / 1,315 tests (rungs file
  §20.3); `test/unit/loop` + `test/unit/core` 22 files / 180 tests (§17.5).

### Verified live (real Jev calls, 0 generator calls on every record)

| check | result | result dir |
| --- | --- | --- |
| QuixBugs 40, run 3 | 36/40 repaired; 32/40 correct by the verdict script (27 gold-identical + 5 equivalent), 2 overfit, 2 unverified; $0.165 | `bench/results/jev-only-quixbugs-3` (+ `verdicts.md`) |
| QuixBugs 40, repeat 1 (clean worktree at `d610d75`) | 38/40; 35/40 correct (28 + 7), 1 overfit, 2 unverified; $0.134 | `bench/results/jev-only-quixbugs-6-repeat1` |
| QuixBugs 40, repeat 2 (same tree) | 38/40; 36/40 correct (28 + 8), 0 overfit, 2 unverified; $0.126 | `bench/results/jev-only-quixbugs-6-repeat2` |
| ladder short tier, rounds 1 → 2 → 4 → 5 | 4/12 → 10/12 → 11/12 → 11/12; round 4: 137 steps, 58 proposals refused, $0.137; round 5: 139 steps, 17 refused, $0.177 | `bench/results/jev-only-ladder-{1,2,4,5}` |
| ladder round 6 (`grades`, `shipping`, `table`) | 3/3 and 3/3; steps on the three 47 (round 5) → 20 → 19; loop replans 8 → 0 → 0; $0.037, $0.020 | `bench/results/jev-only-ladder-6-done`, `-6-done-item3` |
| ladder long tier (8 tasks) | run 1 2/8 ($0.246); run 1b 1/4 of the four re-authored tasks ($0.176; 3/8 distinct across runs 1 and 1b); run 2 on `d610d75` 2/8 ($0.266) | `bench/results/jev-only-ladder-long-{1,1b,2}` |
| SWE-bench Verified 30, first attempt | 0 solved: 20 records evaluated with empty patches, 2 unfinished; $0.60 | `bench/results/jev-only-swebench-1` |
| issue oracle over the 30 | valid on 9/30 (7 strong, 2 weak); $0.0096 | `experiments/results/oracle-from-issue.md` |
| SWE-bench, the nine oracle instances | 1/9: `sympy__sympy-19954` passes the local-venv evaluator (FAIL_TO_PASS and PASS_TO_PASS) after 8 steps and $0.024 — the first instance solved with no generating model; the first process died at a 4 GB heap on the Django instances | `bench/results/jev-only-swebench-2-oracle`, `-oracle-b` |
| SWE-bench 30, budget round | 1 pass (`sympy__sympy-19954`, 6 steps) of 8 records; the process died at an 8 GB heap | `bench/results/jev-only-swebench-2` |
| SWE-bench 30, wired tree (rung 3) | in progress from the frozen worktree `.claude/worktrees/swe-clean` at `5486f7a` | `bench/results/jev-only-swebench-3` |
| reach at the gold site, 9 oracle instances ($0) | a test-passing patch in some source's set on 3/9, gold text 1/9; after the six added capabilities every target enters the set and passes FAIL_TO_PASS | `experiments/results/swebench-reach-oracle-9.md`; rungs file §16, §18 |
| heap after the re-baseline cache | one analysed Django corpus ≈ 149 MB; a re-baseline costs +3 MB with the cache instead of +148 MB without | rungs file §20.2 |

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

- **Jev-only, repeats.** Only QuixBugs has three full repeats (36, 38, 38 of 40). The ladder
  short tier reached ≥ 8/12 in rounds 2, 4 and 5, but each round ran a different code state (the
  loop-side and search-side fixes landed between them), so they are not three repeats of one
  tree. The long tier stands at 2–3/8 over three runs. SWE-bench numbers beyond the single
  `sympy__sympy-19954` pass are pending the rung-3 run (`bench/results/jev-only-swebench-3`).
- **Jev-only, no hidden suite.** The QuixBugs and ladder evaluators run exactly the cases the
  workspace exposes (`bench/data/quixbugs/tests`, the ladder's `tests/`), so "repaired" means
  "passes the reference cases". Correctness is the separate verdict script
  (`experiments/inspect/quixbugs-verdicts.mts`: gold-identical, or equivalent on the reference
  cases and on perturbed inputs). Two QuixBugs programs that pass every run
  (`breadth_first_search`, `topological_ordering`) differ from the reference and cannot be
  verified by it: their pytest graph fixtures are not perturbed by `src/synth/search/perturb.ts`.
- **Jev-only, in-sample constants.** Several thresholds were set after a live run on a named
  QuixBugs program (`docs/JEV-ONLY-DESIGN.md` §7); no run without them has been repeated, so the
  QuixBugs numbers are in-sample for those programs.
- **Jev-only, SWE-bench grading.** The `sympy__sympy-19954` pass is the unofficial local-venv
  evaluator; the patch (a two-line guard before the faulty `del`) is not the upstream fix's
  shape.

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
- **Jev-only: the lone partial.** A goal whose first correct fix passes only some of its tests
  is found, ranked first, run, classified `partial` and dropped at the park (`masked`,
  `long_chain`, `shared_frame`, two `six_hunks` goals in the long tier). Pairs of partials and
  held passers commit; a lone partial does not. Fix in flight: commit the best regression-free
  partial with partial-fix evidence and let the next baseline re-cluster the remaining tests.
- **Jev-only: within-file site ordering on repositories.** A repository goal has ~700
  candidates over ~12 sites; under the fixed 16-run cap `sympy__sympy-15345` ran 16 of 727
  candidates per step, 15 of them at the first site, and parked with sites 3–12 unvisited. The
  oracle-derived run cap and the progress-aware park rule address this; rung 3 has not yet
  measured them.
- **Jev-only: overfit on one-test goals.** Assertion failures make one goal per test, and a
  passer of a one-test goal can regress nothing while moving the true fix out of reach
  (`crossfile` 1b: `key not in CODES`; `ledger5` run 1: `return hits`). Acceptance for a one-test
  goal could prefer, among passers, the one that newly passes the most other failing tests.
- **Jev-only: load-dependent timeouts.** Every long-tier run shared the machine with other
  benches (load average 45–70); per-batch run medians were 0.4–1.9 s against 0.15 s idle and
  every SIEVE step spent its 90 s test wall, so budgets were the binding constraint on every
  miss. The tail-based per-case timeout, load scaling and the in-flight retry removed the
  `timeout` misclassifications; the wall itself remains the limit under contention.
- **Jev-only: declined reads.** In bench runs a review is a decline, so 7–12 `read` proposals
  per long-tier miss cost a step each and fed the loop detector; a review-level read could be
  executed or turned into the goal-subset `run`.
