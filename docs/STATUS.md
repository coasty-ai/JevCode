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
  (`src/bench/swebench/loader.ts`); `experiments/inspect/quixbugs-verdicts.mts` and
  `experiments/inspect/ladder-verdicts.mts` (per-program / per-task correctness against gold);
  `experiments/reach/*` (reach at the gold site, $0).
- Unit tests at the last recorded gates: `test/unit/synth` 79 files / 1,315 tests (rungs file
  §20.3); `test/unit/loop` + `test/unit/core` 22 files / 180 tests (§17.5).

### Verified live (real Jev calls, 0 generator calls on every record)

| check | result | result dir |
| --- | --- | --- |
| QuixBugs 40, run 3 | 36/40 repaired; 34/40 correct by the verdict script (27 gold-identical + 7 equivalent), 2 overfit (`detect_cycle`, `wrap`), 0 unverified; $0.165 | `bench/results/jev-only-quixbugs-3` (+ `verdicts.md`) |
| QuixBugs 40, repeat 1 (clean worktree at `d610d75`) | 38/40; 35/40 correct (28 + 7), 3 overfit (`wrap`, `topological_ordering`, `detect_cycle`), 0 unverified; $0.134 | `bench/results/jev-only-quixbugs-6-repeat1` |
| QuixBugs 40, repeat 2 (same tree) | 38/40; 36/40 correct (28 + 8), 2 overfit (`topological_ordering`, `detect_cycle`), 0 unverified; $0.126 | `bench/results/jev-only-quixbugs-6-repeat2` |
| ladder short tier, rounds 1 → 2 → 4 → 5 | 4/12 → 10/12 → 11/12 → 11/12; round 4: 137 steps, 58 proposals refused, $0.137; round 5: 139 steps, 17 refused, $0.177; round 5 correct 7/12 by `ladder-verdicts.mts` (5 gold-identical + 2 equivalent; overfit strong `grades`, `textstats`, `units` — a literal `return 90` — and weak-only `stats`) | `bench/results/jev-only-ladder-{1,2,4,5}` (round 5 + `verdicts.md`) |
| ladder round 6 (`grades`, `shipping`, `table`) | 3/3 and 3/3; steps on the three 47 (round 5) → 20 → 19; loop replans 8 → 0 → 0; $0.037, $0.020 | `bench/results/jev-only-ladder-6-done`, `-6-done-item3` |
| ladder long tier (8 tasks) | run 1 2/8 ($0.246); run 1b 1/4 of the four re-authored tasks ($0.176; 3/8 distinct across runs 1 and 1b); run 2 on `d610d75` 2/8 ($0.266) | `bench/results/jev-only-ladder-long-{1,1b,2}` |
| SWE-bench Verified 30, first attempt | 0 solved: 20 records evaluated with empty patches, 2 unfinished; $0.60 | `bench/results/jev-only-swebench-1` |
| issue oracle over the 30 | valid on 9/30 (7 strong, 2 weak); $0.0096 | `experiments/results/oracle-from-issue.md` |
| SWE-bench, the nine oracle instances | 1/9: `sympy__sympy-19954` passes the local-venv evaluator (FAIL_TO_PASS and PASS_TO_PASS) after 8 steps and $0.024 — the first instance solved with no generating model; the first process died at a 4 GB heap on the Django instances | `bench/results/jev-only-swebench-2-oracle`, `-oracle-b` |
| SWE-bench 30, budget round | 1 pass (`sympy__sympy-19954`, 6 steps) of 8 records; the process died at an 8 GB heap | `bench/results/jev-only-swebench-2` |
| SWE-bench 30, wired tree (rung 3) | **1/30**: `django__django-15128` passes the local-venv evaluator (4 steps, $0.011); `sympy__sympy-19954` (solved in both earlier runs) missed under load; 9 no-oracle instances stopped on a wiring defect (history candidates at a foreign site), fixed before the final run; $1.16, 55 min, RSS peak 3.0 GB; run from the frozen worktree `.claude/worktrees/swe-clean` at `5486f7a` | `bench/results/jev-only-swebench-3` |
| QuixBugs 40, **final tree** `55404ba` (frozen worktree `.claude/worktrees/final-clean`; a single run on this tree) | **39/40** pass the evaluator's reference cases (the same cases the workspace exposes; no hidden suite); **37/40 correct** by the verdict script (30 gold-identical + 7 equivalent; `breadth_first_search` equivalent on 500 random graphs); **2 overfit**: `topological_ordering` (drops the `issuperset(incoming_nodes)` check and adds a `break`; wrong on 252/500 random DAGs, e.g. edges E->B, E->C → C dropped) and `detect_cycle` (a single edge input — the empty list: `AttributeError` vs `False`, 1/500); 0 unverified; miss `shortest_path_length` (a literal `return 4` committed; gold-identical in run 3, missed in the three later runs — a persistent regression); $0.185. Four-run series 36, 38, 38, 39 pass / 34, 35, 36, 37 correct; thresholds in-sample | `bench/results/jev-only-quixbugs-7-final` (+ `verdicts.md`); rungs file §25.1, §26.5, §27 |
| ladder 20, final tree | **14/20** solved on the exposed suite, **9/20 correct** by `experiments/inspect/ladder-verdicts.mts`. Short tier **12/12** solved (3–7 steps, 0 blocked / declined / loop / `read` events, $0.051), **8/12 correct** (5 gold-identical + 3 equivalent); 4 overfit — strong `grades` (`letter_grade` one letter too high at .5 scores: 89.5 → `'A'`, gold `'B'`) and `textstats` (`ngrams` raises on a tuple and mutates the caller's list), weak-only `stats` and `units` (only the exception class on `None` / empty input differs) — 10/12 counting weak-only as correct. Long tier **2/8** solved (`import_and_guard` 9 steps, `ledger5` 13), **1/8 correct** (`import_and_guard`); `ledger5` weak-only (`is_overdue` returns an int with the right truthiness where gold returns a bool); gold-identical hunks by strict `diff -U0`: `ledger5` 2/5, `import_and_guard` 2/4, `long_chain` 3/6, `regress_trap` 3/4, `six_hunks` 1/6 (2/6 counting the equivalent `t.due == None`), `masked` 0/3 (1/3 counting the equivalent `txt = text`; plus an overfit `return 0` insert), `crossfile` 0/4, `shared_frame` 0/2; $0.320 | `bench/results/jev-only-ladder-7-final` (+ `verdicts.md`); rungs file §25.2–25.3, §26.5, §27 |
| SWE-bench Verified 30, **final tree** `55404ba` (a single run) | **4/30** pass the local-venv evaluator (unofficial: replicates `eval.sh` without Docker): `sympy__sympy-15345` (4 steps), `sympy__sympy-17139` (4), `sympy__sympy-19954` (6), `django__django-15128` (4); FAIL_TO_PASS all success and the listed PASS_TO_PASS all success on each; none has the upstream fix's shape (15345 `_print_Expr = _print_Function` class-wide alias; 19954 an index guard before `del`; 17139 a `not rv.exp.is_comparable` guard; 15128 `alias += table_name`); $1.30 of Jev, 0 generator calls, 68 min, 348 steps, 228 blocked proposals, 88 loop trips; 0 history/foreign-site errors (the rung-3 defect is gone); `unstable` verdicts 3× on `django-15315`, `weak_network` 7× on `requests-2931`; `sympy-19954` has flipped across runs (load-sensitive); series 0/30 → 1/30 → 1/30 → 4/30; RSS peak 4.5 GiB (5-min samples) | `bench/results/jev-only-swebench-4-final`; rungs file §26 |
| reach at the gold site, 9 oracle instances ($0) | a test-passing patch in some source's set on 3/9, gold text 1/9; after the six added capabilities every target enters the set and passes FAIL_TO_PASS | `experiments/results/swebench-reach-oracle-9.md`; rungs file §16, §18 |
| heap after the re-baseline cache | one analysed Django corpus ≈ 149 MB; a re-baseline costs +3 MB with the cache instead of +148 MB without | rungs file §20.2 |

Provenance and gates for the final-tree rows (independent verification, 2026-09-21). Run records
carry no git sha, so the tree identity `55404ba` is inferred from `run.json`'s workspace path (the
frozen worktree `.claude/worktrees/final-clean`, clean at that commit) and timing (the QuixBugs bench
started 94 s after the commit); the SWE-bench launcher log also records `head 55404ba`. On that frozen
tree `tsc --noEmit`, `node scripts/no-any.mjs` and the full unit suite (221 files / 4,045 tests) pass,
and `npm run perf` meets every budget: first frame cold p95 104.2 ms (< 300 ms; cold median 101.2,
warm median 85.4), harness overhead per step p95 33.5 ms (< 50 ms; p50 22.1), event-loop lag p95
2.4 ms / 1.8 ms at rows 40 / 12 (< 5 ms), 0 / 0 terminal clears after the first frame. "Solved" and
"correct" are reported as separate numbers from here on (`docs/DECISIONS.md`, 2026-09-21).

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

- **Jev-only, repeats.** QuixBugs has four full runs (36, 38, 38, 39 of 40; correct
  34, 35, 36, 37), but only one on the final tree `55404ba`; the only same-tree pair (the two
  6-repeat runs at `d610d75`) flipped 2/40 programs between them, and in the final run `mergesort`
  passed at 455 s of the 480 s wall. The ladder short tier reached ≥ 8/12 in rounds 2, 4, 5 and
  the final run, but each ran a different code state (the loop-side and search-side fixes landed
  between them), so they are not repeats of one tree. The long tier has not exceeded 2/8 over
  seven runs (2/8, 1/4, 2/8, 0/4, 0/4, 1/4, 2/8). SWE-bench: rung 3 1/30, final tree 4/30, each a
  single run; `sympy__sympy-19954` has flipped across runs (pass, pass, miss, pass) with a
  byte-identical patch each time it passed, so the count is load-sensitive.
- **Jev-only, no hidden suite.** The QuixBugs and ladder evaluators run exactly the cases the
  workspace exposes (`bench/data/quixbugs/tests`, the ladder's `tests/`), so "repaired" means
  "passes the reference cases". Correctness is the separate verdict scripts
  (`experiments/inspect/quixbugs-verdicts.mts`: gold-identical, or equivalent on the reference
  cases, on perturbed inputs and — for the nine programs with pytest graph fixtures — on 500 random
  graph / list / DAG structures per program; `experiments/inspect/ladder-verdicts.mts`: gold-identical,
  or equivalent to gold on the inputs the task's tests pass and their perturbations, overfit
  annotated strong / weak-only). Two QuixBugs programs that pass every run (`breadth_first_search`,
  `topological_ordering`) differ from the reference: `breadth_first_search` is equivalent on 500
  random graphs in all four runs; `topological_ordering` is **wrong** in every run's committed patch
  except run 3's — the final run's drops the `issuperset(incoming_nodes)` check and adds a `break`
  and is wrong on 252/500 random DAGs (e.g. edges E->B, E->C → C dropped) — and `detect_cycle`
  fails only the empty list (1/500). "Passes every run" therefore does not mean correct; since the
  random-structure differentials landed (rungs file §27) `unverified` is 0 on every run, so the
  overfit counts cover all 40 programs. The ladder check finds 4 overfit of 12 solved in the
  short tier (`grades`, `textstats` strong; `stats`, `units` weak-only) and `ledger5` weak-only in
  the long tier.
- **Jev-only, in-sample constants.** Several thresholds were set after a live run on a named
  QuixBugs program (`docs/JEV-ONLY-DESIGN.md` §7); no run without them has been repeated, so the
  QuixBugs numbers are in-sample for those programs.
- **Jev-only, SWE-bench grading.** Every SWE-bench pass is the unofficial local-venv evaluator
  (a fresh checkout at `base_commit`, the model patch, the dataset `test_patch`, the `eval.sh`
  test command, the upstream log parsers; no Docker). None of the four final-tree passes has the
  upstream fix's shape: `sympy__sympy-15345` aliases `_print_Expr = _print_Function` class-wide,
  `sympy__sympy-19954` inserts an index guard before the faulty `del`, `sympy__sympy-17139` adds a
  `not rv.exp.is_comparable` guard, `django__django-15128` appends `alias += table_name`; each
  passes FAIL_TO_PASS and the listed PASS_TO_PASS only. `predictions.jev-only.jsonl` can be graded
  with the official harness elsewhere.

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
  held passers commit; a lone partial does not. Fixed as progress commits (`docs/JEV-ONLY.md`,
  2026-09-21 entry) and measured in `jev-only-ladder-long-3{,b,c}` and the final tree: `long_chain`
  reached 3/6 through three progress commits; `masked` now fails on the budget-reserve release of
  an all-overfit `return 0` instead (rungs file §25.3).
- **Jev-only: within-file site ordering on repositories.** A repository goal has ~700
  candidates over ~12 sites; under the fixed 16-run cap `sympy__sympy-15345` ran 16 of 727
  candidates per step, 15 of them at the first site, and parked with sites 3–12 unvisited. The
  oracle-derived run cap and the progress-aware park rule address this; rung 3 (1/30) still
  missed `sympy__sympy-15345`, and the final tree solved it in 4 steps (`jev-only-swebench-4-final`,
  a single run).
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

## Interactive TUI (2026-09-21)

The interactive session of `docs/TUI-DESIGN.md` (waves 0–4: commits `45efae5` wave 1 pure modules, `a124445` wave 2
engine wiring and I/O, `814f9fb` wave 3 Ink App and session controller, `cb33cca`/`9002d37` packaging, `9f96f70` pty
driver auto-review; the wave-4 pty, perf, polish and documentation slots ran concurrently on 2026-09-21 and their
files may still be landing when this is read). This section records what the docs slot checked against the tree on
disk; where the implementation deviates from the design the docs describe the behaviour and the deviation is listed
below.

### What was built

- **Entry points and renderers** (`src/cli/main.tsx`, `src/cli/args.ts`, `src/cli/session.ts`): a bare `jevcode` /
  `jevcode chat` / `jevcode run` with no task on a TTY is a session; `jevcode run "<task>"`, `--task-file`,
  `--resume <id|title>`, `-c` are one-shot; `--plain` on a TTY gets a `node:readline` composer over the same
  `dispatchCommand()`; a pipe, `CI`, `TERM=dumb`, `--no-input` get the plain renderer with safe defaults; `--json[=verbose]`
  the NDJSON stream (`cli/json-stream.ts`, `jevcode.events/1`). The first frame is argv-only; SIGINT/SIGTERM are
  handled before it. New commands: `login`, `logout`, `config set`, `sessions list|reindex|prune|unlock`, `report`,
  `why`, `calibration`, `completion`, `upgrade`; `--version --json`.
- **Composer** (`src/tui/composer/*`): `TextBuffer` reducer, `string-width`-identical `cellWidth` (generated EAW table),
  `layoutRows`, input filter, paste store with chips, file-backed history (1,000 entries), kill ring, undo/redo,
  external editor, submit routing (`routeSubmit`: a `/` line runs only on an exact name/alias match).
- **Keys** (`src/tui/keys/*`): `KEY_ACTIONS` registry (63 actions in 5 contexts), `resolveKey` over `KeyState`,
  `reduceInterrupts` (S0–S7 matrix, windows 1.5 s / 2 s / 800 ms, 30 ms Esc re-buffer), keybindings file with chords
  and reserved keys.
- **Commands** (`src/tui/commands/*`): 34 slash commands + 4 aliases in one typed table, grammar, dispatcher,
  palette, fuzzy scorer; `scripts/gen-docs.mjs` renders `docs/KEYS.md`, `docs/COMMANDS.md`, `man/jevcode.1` and the
  completions from the registries with a `--check` sync test.
- **Layout and panes** (`src/tui/layout.ts`, `Pane.tsx`, `Overlay.tsx`, `Review.tsx`, `Picker.tsx`, `StatusLine.tsx`,
  `PaneBoundary.tsx`, `src/tui/{review,pane,status,blocking,budget,onboarding}/lines.ts`): one `computeLayout`,
  one modal slot, the A109 caps, review header with the truncation ladder, `DecisionRow`s with `consumedBy` and
  `near`, plan/timeline/synth tabs, three-zone status line with meters, git zone and sparkline, toasts, `/why` and
  `/calibration` blocks, blocking panes, follow-up box, wizard rows.
- **Sessions and money** (`src/session/*`, `src/spend/meter.ts`, `src/tui/budget/lines.ts`): `index.jsonl`, `run.lock`,
  `buildSeed`, `/export`, picker rows; parent session meter with `setCap` and `SpendSnapshot.parent`, thresholds,
  clamp/refusal, `/budget`, `/cost`, unpriced-fails-closed with `token_cap`.
- **Secrets and onboarding** (`src/core/redact.ts` `detectSecrets`, `src/tui/secrets/*`, `src/tui/onboarding/*`,
  `src/config/{credentials,trust,instructions}.ts`, `src/cli/login.ts`): the gate at every entry point, `addSecret`
  of every hit span, masked composer spans, `[REDACTED:draft]`, the wizard, `jevcode login/logout/config set`,
  `trust.json`, `AGENTS.md` loading.
- **Git, undo, diff** (`src/workspace/gitstate.ts`, `src/tui/useGitHead.ts`, `src/checkpoint/images.ts`,
  `src/undo/*`): two unsandboxed probes, banner and HEAD-following zone, pre/post images with streamed hashing,
  `/undo` decision table and apply, `/rewind`, `/diff` (numstat, step, `--full` pager).
- **Errors and exit** (`src/tui/retry.ts`, `src/tui/blocking/lines.ts`, `src/cli/{epilogue,fatal}.ts`,
  `src/core/log.ts`, `src/cli/report.ts`): retry row with `[r]`, blocking panes through `EngineOptions.blocker`,
  `PaneBoundary`, `fatalExit`, the exit-code table, per-run `jevcode.log`, `jevcode report`.
- **Engine contract** (`src/core/types.ts`, `src/loop/engine.ts`): additive contract 1.1 — `steer`/`unsteer`/`pause`/
  `retryNow`/`annotate`, widened `abort`, `confirmDetailed?`, the new events, `human_pause`/`token_cap`, seeds,
  pending directives, images, `run.lock`.
- **Packaging** (`package.json`, `bin/jevcode.js`, `scripts/{build,licenses,check-pack,gen-docs}.mjs`,
  `Formula/jevcode.rb`, `.github/workflows/release.yml`, `docs/RELEASE.md`): zero runtime dependencies, minified
  bundle (1,873,675 bytes on the 07:36Z build; 1,898,200 bytes on the 08:36Z rebuild in the fix pass — other slots
  landed code in between), `THIRD_PARTY_LICENSES.txt` (35 packages), man page, completions, tap formula, trusted
  publishing workflow. Not published.
- **Docs** (this wave): `README.md` (Install, Run, Interactive session, Money, Secrets, Configuration, Exit codes,
  Windows, Dependencies, Development rewritten; Performance, Bench, Jev-only, How a step works and Status kept byte
  for byte), `docs/TUI.md` (user guide), `docs/KEYS.md` / `docs/COMMANDS.md` (regenerated; unchanged, already in
  sync), `docs/DESIGN.md` §4 / §9.2 / §10 / §11 / §12 amendments, `docs/research/tui/terminal-matrix.md`,
  `CHANGELOG.md`, this section.

### Verified (commands run on 2026-09-21 on this machine — Apple Silicon Mac, macOS 26, Node 22.23.2; load average ≈ 1 in the first pass, 1.6–2.6 in the fix pass, with five `drive.exp` processes of other slots alive throughout the fix pass)

| Check | Command | Result |
| --- | --- | --- |
| Types and `any` | `npm run typecheck` | clean at 07:55Z (`tsc` strict + `no-any: ok (src, test, perf, scripts)`). Re-runs while the other wave-4 slots were landing: 08:00Z failed with 3 errors in `test/unit/cli/tui-prompter.test.ts` (polish slot mid-edit; gone by 08:05Z); 08:05Z failed with 4 errors in `src/perf/main.ts` (`root` missing, `cold`/`warm` gone from `FirstFrameResult` — the perf slot's new `first-frame.ts` shape, `main.ts` not yet updated). Fix pass 08:36Z: clean again |
| Unit suite | `npx vitest run --project unit` | 07:43Z: 263 files, 4,702 passed, 1 skipped, 36.9 s. Fix pass 08:36Z: **264 files, 4,712 passed, 1 skipped**, 38.3 s — the skip is `fish -n accepts the fish completion` (`fish` is not installed here) |
| Generated docs in sync | `node scripts/gen-docs.mjs --check` | exit 0 (nothing stale); `node scripts/gen-docs.mjs` wrote nothing |
| Registry ↔ docs sync tests | `npx vitest run --project unit test/unit/tui/commands/registry.test.ts test/unit/tui/keys/bindings.test.ts --reporter verbose` | 2 files, 31 passed, 1 skipped (07:4xZ and 08:36Z); the skip is `fish -n accepts the fish completion` (no `fish` binary); `KEY_ACTIONS ↔ docs/KEYS.md`, `registry ↔ docs/COMMANDS.md`, `gen-docs.mjs --check exits 0`, `mandoc -T lint`, `bash -n` and `zsh -n` all pass |
| Build | `npm run build` | 07:36Z: `dist/jevcode.mjs` 3,352,941 → 1,873,675 bytes minified (keepNames) in 123 ms; build smoke first frame ok (42 ms), `--version` ok; `THIRD_PARTY_LICENSES.txt` 35 packages. Fix pass 08:36Z: 3,390,189 → **1,898,200 bytes** in 125 ms; build smoke first frame ok (22 ms); `THIRD_PARTY_LICENSES.txt` 35 packages, 49,141 bytes |
| Release tarball gates | `npm run pack:check` (08:36Z) | all gates pass: `private` absent, `LICENSE` (MIT, 1,070 bytes), `THIRD_PARTY_LICENSES.txt`, `dependencies` empty, tarball = the 10-file allowlist, unpacked 2,065,424 bytes (< 3,000,000), tarball 696,349 bytes (< 1,500,000), `--version` smoke |
| Real-pty smoke, run 1 (07:5xZ, bundle built 07:36Z) | `sh test/pty/run-smoke.sh` (copied to `.scratch/docs-slot/` with its own output dir so as not to collide with the pty slot) | **19/19 PASS**, 0 expect timeouts, 0 clears after the first frame in every scenario (1 allowed and ≤ 1 seen in the shrink segment of `resize`); `FIRST_FRAME_MS=87.2`; the exit string `CSI 0 SP q` appeared **twice** per exit in 17 scenarios (once in `firstframe`, `plainwarn`) |
| Real-pty smoke, run 2 (bundle rebuilt 08:00Z after the polish slot's restore change) | same | **19/19 PASS**, 0 timeouts, clears as above; `FIRST_FRAME_MS=83.0`; the exit string appeared **exactly once** in all 19 captures; `--version --json` → `{"name","version":"0.1.0","node":"v22.23.2","ink":"7.1.1","react":"19.3.0","bundle":…}` |
| `jevcode perf` (fix pass) | `node bin/jevcode.js perf --out /tmp/jevcode-docs-fix/perf.json` (08:38Z–08:43Z, load 2.56 → 2.47, five other `drive.exp` alive) | **GATE FAILURE** — the table under "Measured numbers": first frame, harness, composer, fps/region/cursor and 13 of 14 state scenarios pass; render lag (rows 40 p95 99.6 ms; rows 12 max 503 ms, driver exit 124) and the live-pane shrink clears (2, allowed 1) fail; `imagesMs` p95 19.3 ms is above its 15 ms report bound |
| Real-pty smoke, run 3 (fix pass, 08:38Z, bundle built 08:36Z, load 2.2) | `sh .scratch/docs-slot/run-smoke-fix.sh` (the working-tree `test/pty/run-smoke.sh` with its output dir moved so it cannot collide with the pty slot; `diff` shows only those two lines) | **19/19 PASS** in 21 s, 0 timeouts, `clears_after_first_frame=0` in all 19 (`resize`: ≤ 1 in the shrink segment, 0 seen), `restores=1` in all 19 (`plainwarn` and `taskfile-missing` included); `FIRST_FRAME_MS=82.0` |
| pty vitest project (fix pass) | `env -u CI -u CONTINUOUS_INTEGRATION npx vitest run --project pty` at 08:43:26Z and 08:43:42Z; `… --reporter verbose` at 08:47:40Z | **4 files, 26 tests, 26 passed** in 15.2 s / 15.3 s / 14.8 s (loads 2.5 / 2.5 / 1.2); the verbose run's console lines: `resize storm: 30 resizes in 136 ms, 33 frames, 0 ESC[2J total (15 shrinks)`; `live resize storm: 30 resizes in 137 ms, 53 frames, 5 ESC[2J in the storm (15 shrinks); slow cycles shrink/grow clears 1/0/1/0/1/0` |
| Real-pty smoke, run 4 (fix pass, 08:44Z, bundle rebuilt 08:43Z by another slot, load 2.9) | same | **19/19 PASS** in 22 s, 0 timeouts, 0 clears in all 19 (shrink segment 0 of 1 allowed), `restores=1` in all 19; `FIRST_FRAME_MS=83.0` |
| Scenarios covered by the smoke | `test/pty/smoke/*.steps` | `firstframe`, `chat-run-exit`, `s0-ctrlc` (`[ui] exited on Ctrl-C ×2`), `ctrld2`, `s1-clear`, `s2-ctrlc-abort` (`end human_abort`, composer reopens), `s2-esc-pause` (`end human_pause`, `paused after step`), `review-y` (`confirm … approved`), `review-d` (`declined (note: skip the tests)`), `resize` 24×80→12×60→24×80, `resize-grow`, `exitlast` (`--exit-code last-run` → 4), `budgetfirst` (`/budget session-spend-cap 15` before the first run → index `budget` line, `sess $0.00/15.00`), `sigmid-trust`/`sigmid-early` (SIGINT during startup → epilogue, 130), `plainwarn` (`jevcode: <warning>` on stderr under `--plain`), `taskfile-missing` (usage line, 2), `taskfile-header` (`task from todo.md`), `oneshot-ctrlc` (130 + epilogue) |
| CLI probes | `node bin/jevcode.js --help`, `chat --help`, `config` in an empty `JEVCODE_HOME`, `--version [--json]` | the flag list in README Configuration and the `jevcode config` rows (`ui.*`, `log.level`, `update.notify`, `session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)  derived`) were copied from this output |
| Doc ↔ source literals | first pass: ad-hoc sweep of 40 §24 strings; fix pass: `/tmp/jevcode-docs-fix/sweep.py` — every backtick span ≥ 14 chars containing a space in `docs/TUI.md` and README's TUI sections (122 spans), split at placeholders, each fragment grepped over `src/**/*.ts*` | the first pass's "all 40 exist" claim was wrong for one string; the re-sweep found **two** documented strings the tree does not emit and both were corrected: `[screen reader mode: on via …]` (deviation 10) and the `✓ jev back` / `✓ network back` heal toasts (the code has no heal toast — `retrySettledText` emits `warning: <side> retry chain: N attempts over <t> — recovered` / `— gave up` only when the chain failed or lasted > `RETRY_SLOW_MS` = 10 s, and a failed chain is added to `/errors`). Every other flagged span was prose between two literals or a template whose fixed fragments exist (`remove [Pasted #`, `exited on Ctrl-D`, `is below the 40`, `key rejected (`, `Set the ${which} key and retry. Consulted:`, `retry the write   [c] continue without checkpoints   [q] stop now`, `unknown command`, `to the generator on request`, …); every `/command` named in README and TUI.md is in `COMMANDS` (34 + 4 aliases) |

### Measured numbers

**`jevcode perf` on the 2026-09-21 tree (fix pass): GATE FAILURE.** Command: `node bin/jevcode.js perf --out
/tmp/jevcode-docs-fix/perf.json`, 08:38:33Z–08:43:26Z, against the bundle built 08:36Z (Apple M5 Pro, 15 cores, 24 GiB,
darwin 25.6.0, Node v22.23.2; load 2.56 at start / 2.47 at end, limit 8, no wait; five `drive.exp` processes of other
slots were alive throughout, so the render-lag figures may include contention — the reviewer's run under load 1.6–2.0
with other perf probes alive failed the render-lag and shrink-clears gates as well, plus the harness gate at 50.1 ms,
which passed here at 45.7 ms). `perf/results/latest.json` was **not** regenerated by this
run: it is still the 2026-09-20 file, and the probes that produced it have changed shape since (the render-lag probe
now types at 10 keys/s during a live run and gates fps, region and cursor hygiene; the `chat` first-frame series, the
`<Static>` append, composer-latency and per-state probes are new — `git diff --stat HEAD -- src/perf/render-lag.ts` →
171 insertions / 37 deletions). Re-measure on a quiet machine before merge; the perf slot owns `latest.json` and the
README Performance table.

| Gate (TUI-DESIGN §18 / DESIGN §12) | Measured 2026-09-21 08:38Z | Gate | Result |
| --- | --- | --- | --- |
| First frame cold p95 / median / warm median — `run` 40×120 · 24×80 · 8×40 (10 cold + 10 warm each, zero network asserted) | 111.5 / 108.5 / 89.8 · 115.7 / 108.9 / 92.8 · 110.7 / 107.8 / 88.8 ms | < 300 ms | pass |
| First frame cold p95 / median / warm median — `chat` 40×120 · 24×80 · 8×40 | 115.1 / 107.3 / 89.1 · 110.4 / 107.4 / 89.0 · 109.5 / 107.3 / 89.4 ms | < 300 ms | pass |
| First frame breakdown at 24×80 (child clock): bare node → mounted → flushed · harness clock | `run` 22.7 → 96.0 → 99.8 · 106.9 ms; `chat` 22.5 → 97.6 → 101.4 · 108.5 ms | report | — |
| Harness overhead per step p95 / p50 (50 mocked steps, 5,000-file fixture, 50 dirty files / 15 MiB, one 60 MiB artefact) | 45.7 / 24.5 ms | p95 < 50 ms | pass here; **50.1 ms FAIL** in the reviewer's run (01:19 local) — the margin is thin |
| `imagesMs` p95 / p50 (steps with images) · run-step p95 | 19.3 / 1.2 ms · 21.4 ms | report (< 15 ms) | above |
| 60 MiB artefact post image `hashSkipped` | true (step 11) | true | pass |
| `<Static>` append bytes per committed line, append-frame median (live22 · review22 · idle15) | 2,015 · 1,606 · 1,475 B | report | in budget |
| Event-loop lag p95 while typing at 10 keys/s during a live mocked run, rows 40 / rows 12 (120 columns) | **99.6 ms** / 2.10 ms | < 5 ms | **FAIL** at rows 40 (p50 57.2 ms over 284 samples; composer typing p95 stayed 10 ms, 150/150 keys while live) |
| Event-loop lag max, rows 40 / rows 12 | 123.6 ms / **503.5 ms** | < 50 ms | **FAIL** (rows 12: 10,693 samples, then the driver exited 124 — expect timeout) |
| Terminal clears after the first frame, rows 40 / 12 | 0 / 0 | 0 | pass |
| Frames per second, max one-second bucket, rows 40 / 12 | 26.3 / 32.2 | ≤ 30 (+1) | pass |
| Dynamic region max rows, rows 40 / 12 | 18 / 10 | ≤ rows − 2 | pass |
| Cursor hides per frame max / cursor shown at exit | 1 / true at both geometries | ≤ 1 / true | pass |
| Composer keystroke → frame p95 / max — idle · live (A109 region) · palette (200 keys, ≥ 100 ms apart, 24×80) | 4 / 10 · 11 / 15 · 4 / 5 ms | < 16 / < 50 ms | pass |
| Composer keystroke → frame p95 / max — paced30 (34 ms spacing) | 3 / 8 ms | report | — |
| Zero clears across 14 state scenarios (review, palette, wizard, secret row, picker, two render faults, Ctrl+L at 24×80 and 12×60; `resize-idle` 24×80) | 0 clears in every non-shrink segment; `resize-idle` shrink 0 (allowed 1); `ESC c` / alt-screen 0 | 0 outside shrink, ≤ 1 per shrink | pass for 13 of 14 |
| `resize 40x120` with a live pane open: clear events per segment (allowed) | 0 (0) · **2 (1)** · 0 (0) · 0 (0) | ≤ 1 per shrink | **FAIL** (deviation 11) |

**2026-09-20 probes (retired shapes).** `perf/results/latest.json` as on disk (`measuredAt` 2026-09-20T05:24:52.153Z,
Node v22.23.2) — the file the README Performance table still quotes. Its render-lag probe measured the idle TUI under a
mocked run at 40 and 12 rows **without typing**, so 3.2 ms is not the interactive TUI's lag while typing; none of these
rows is reproducible on the current tree:

| Measurement (2026-09-20 shapes) | Value | Gate |
| --- | --- | --- |
| First frame (`run`, `script` pty 40×120), cold compile cache, p95 / median over 10 | 89.9 ms / 89.0 ms | < 300 ms (pass) |
| First frame, warm cache, median / p95 | 80.1 ms / 88.2 ms | — |
| Harness overhead per step, p50 / p95 (50 mocked steps, no images) | 21.7 ms / 31.2 ms | p95 < 50 ms (pass) |
| Event-loop lag under the idle TUI, rows 40: p50 / p95 / max | 1.18 / 3.24 / 3.26 ms | p95 < 5, max < 50 |
| Event-loop lag, rows 12: p50 / p95 / max | 0.89 / 2.14 / 2.32 ms | p95 < 5, max < 50 |
| Terminal clears after the first frame, rows 40 / rows 12 | 0 / 0 | 0 |

**Other numbers measured in this pass:**

| Measurement | Value | Gate / bound |
| --- | --- | --- |
| First frame of the interactive `chat` mode in the pty smoke (`FIRST_FRAME_MS`, child clock, 24×80) | 87.2, 83.0 ms (first pass, 07:5xZ and 08:00Z bundles); 85.5, 82.1 ms (reviewer, 01:2x local); 82.0, 83.0 ms (fix pass, 08:38Z and 08:44Z) | the smoke only reports; the `perf` gate is cold p95 < 300 ms |
| Bundled vs unbundled first frame — `chat --mock --perf-exit-after-first-frame` at 24×80 through `scripts/pty/drive.exp`, three runs each (08:44Z, load 2.5) | `node bin/jevcode.js` (the esbuild bundle): 84.8 / 80.8 / 81.7 ms; `node node_modules/.bin/tsx src/cli/main.tsx` (the TypeScript sources through `tsx`): 307.5 / 252.8 / 253.5 ms | report (README "Dependencies"; the earlier "64–72 vs 643 ms" figure is retired) |
| Unit micro-gates (`[measured]` lines of the 08:36Z unit run) | `computeLayout` median 0.078 µs per call (bound 5), mean 0.077 µs (bound 15); fuzzy `rank()` over 5,000 candidates p50 0.57 ms (bound 16), p95 1.00 ms (bound 48); `layoutRows` of a 12,000-char realistic draft cold best 2.065 ms, fuzz-pool draft 2.138 ms; `detectSecrets` 256 KB patterns 1.03 ms / with exact 1.12 ms; history construct over a 3.90 MiB tail best of 5 0.34 ms; `statusPorcelainV2` 20,000 entries 8.1 ms | as asserted by the tests |

### Deviations from `docs/TUI-DESIGN.md` found while checking the docs (the docs describe the behaviour)

1. **`/calibration` scope.** The registry's semantics text (`src/tui/commands/registry.ts`, rendered into
   `docs/COMMANDS.md`) says "≤ 200 runs, streamed"; the implementation (`src/tui/calibration.ts`) and §7.6 scan the
   newest **50 runs or 32 MB**. The user guide states 50 / 32 MB. Request to the polish slot (owner of
   `src/tui/commands/registry.ts`): change the string and regenerate.
2. **`/copy diff`.** §10.5 lists `diff` as a payload; the App copies the most recent transcript item for anything but
   `proposal`/`draft` (`src/tui/App.tsx` `case 'copy'`), so `/copy diff` copies the last item — the diff block only
   when `/diff` ran last. Documented as such.
3. **`--title` (OSC 2).** Wired on 2026-09-21 after the documentation pass: `createTuiRenderer.setUi()` writes one `ESC ] 2 ; jevcode · <task> BEL` when `ui.title` is true (stdout a TTY), `unmount()` resets the title, `terminalTitle()` strips control characters and clips to 80 cells (`test/unit/tui/title.test.ts`). The earlier sentence that the flag was inert no longer applies.
4. **`/resume` in `--plain`.** The registry's `plain` column says `` `/resume <id>` only ``; the readline composer
   also accepts a session title — it refuses only the picker form (`plainSupports`). Documented as `/resume <id|title>`.
5. **Exit string written twice** (`CSI 0 SP q` twice per exit in 17 of 19 pty scenarios on the 07:36Z bundle) against
   §14.2's "once". Fixed by the polish slot during this wave: once in all 19 scenarios after the 08:00Z rebuild.
6. **`--version --json`** printed `{ name, version, node, ink, bundle }` (the §17.3 shape) on the 07:36Z bundle; the
   polish slot added `react`; the `--version` help text in `src/cli/args.ts` still says `name, version, node, ink,
   bundle` (request to the polish slot).
7. **Perf gates of §18: the current tree fails three of them.** The perf slot's `src/perf/composer-latency.ts`,
   `src/perf/states.ts`, `src/perf/static-append.ts` and `src/perf/pty.ts` appeared at ~08:00Z while the first pass ran
   (`src/perf/main.ts` did not compile then); by the fix pass (08:36Z) `jevcode perf` ran all six probes and ended in
   `GATE FAILURE` (table above): render lag rows 40 p95 99.6 ms (< 5) and rows 12 max 503 ms with a driver timeout
   (< 50), the live-pane shrink resize clearing twice (allowed 1), `imagesMs` p95 19.3 ms above its 15 ms report bound;
   harness p95 45.7 ms passed here and measured 50.1 ms (FAIL) in the reviewer's run. `perf/results/latest.json` is
   still the 2026-09-20 file and the README Performance table still quotes it. Whether the rows-40 lag is contention
   (load 2.5, other slots' pty drivers alive) or the tree is for the perf slot to settle on a quiet machine.
8. **pty vitest project** (§19.5), landed during the first pass: `test/pty/{chat,interrupts,review,twins}.pty.test.ts`,
   `test/pty/helpers.ts`, `test/pty/global-setup.ts` (rebuilds a stale bundle, warms the compile cache), the `pty`
   project in `vitest.config.ts` (`fileParallelism: false`, 180 s timeouts) and `"test:pty": "vitest run --project
   pty"` in `package.json`; `test/pty/run-smoke.sh` gained a `restores=` column asserting the exit string exactly once
   per exit in every scenario (1 in all 19, the `--plain` TTY `plainwarn` and the usage-error `taskfile-missing` included).
   **Current state (fix pass): 26 tests, 26 pass** — `env -u CI -u CONTINUOUS_INTEGRATION npx vitest run --project pty`
   at 08:43:26Z (15.2 s, load 2.5) and 08:43:42Z (15.3 s), and once more with `--reporter verbose` at 08:47:40Z (14.8 s,
   load 1.2): every test green, 0 skipped. History, for the record: the first pass ran the suite twice while it was
   still being written and the machine was contended (08:04:56Z: 25 tests, 12 passed / 13 failed, 269 s, load 8.5;
   08:09:44Z: 10 passed / 15 failed, 229 s — `expect`-step timeouts and two helper mismatches, `registerScratch is not a
   function` / `CHAT_OPEN_NARROW is not iterable`, since resolved: both exist in `test/pty/helpers.ts`); the reviewer's
   two runs at 01:24/01:25 local saw 27 tests with 25 passing and the `resize storm during a live run` block failing
   on an `expect` timeout (driver exit 124) both times. That block passes in all three fix-pass runs; its measured
   clears are `slow cycles shrink/grow clears 1/0/1/0/1/0` and `5 ESC[2J in the storm (15 shrinks)` in the verbose run
   (the reviewer's run logged `2/0/2/0/1/0`), against the test's gate of ≤ 2 per shrink and ≤ 30 in the storm (deviation
   11); the idle storm logged `0 ESC[2J total (15 shrinks)`.
9. **`docs/DESIGN.md` carried a duplicated, stale copy of §1–§9** (HEAD lines 1414–2799, 1,386 lines) since commit
   `84a9612` (2026-09-19, a `$\`` inside the run-id regex expanded as a `String.replace` pattern, which inserts the
   text preceding the match — the whole file up to that sentence). Every later edit to §1–§9 had landed in the
   first copy, so the inserted copy was removed and the regex sentence restored. Verified in the fix pass by a
   token-level `difflib` comparison of the inserted copy (HEAD lines 1414–2799, split at the two junctions inside
   the regex sentence) against the kept prefix (HEAD lines 1–1414): 7 token runs / 25 tokens exist only in the
   removed copy, all fragments of sentences reworded later (the `risk_dim` formula sentence, the jittered-retry
   sentence, the SSE `delta arrives` sentence); 11 runs / 404 tokens exist only in the kept copy (the split token
   series, the harm/alignment risk rule, the `fail:` identity paragraph, the provider retry constants); `### 9.1`
   and the §9 resume paragraphs occur once in the working tree. 3,970 → 2,751 lines before the amendments.
10. **§24 `[screen reader mode: on via flag|env|config]` is not emitted by the tree.** `grep -rni 'reader mode: on\|via flag\|via env' src/`
    → 0 hits (2026-09-21); the first-pass `docs/TUI.md` had copied the §24 line as behaviour and the fix pass removed
    it. What `--screen-reader` does do is wired: numbered prompts (`Enter selection (1-N):`, `src/tui/review/lines.ts`,
    `src/tui/onboarding/lines.ts`), bar-less review rows, `ui.notify` and `ui.reducedMotion` defaulting to on
    (`src/config/ui.ts`), `--plain` implied on a pipe (`src/cli/args.ts` help text and `src/cli/main.tsx`).
11. **Shrink-resize clears with a live pane open: 1–2, not ≤ 1.** The design bound (§18; research 20 §1) is one
    `ESC[2J` per shrink segment. Measured 2026-09-21 by the pty slot's `test/pty/chat.pty.test.ts` (`slow cycles
    shrink/grow clears 2/0/2/0/1/0` in the reviewer's run, `1/0/1/0/1/0` in the fix pass's 08:47Z run; the test's comment: Ink 7.1.1's `resized` handler renders
    the stale tree at the new viewport before the App's rows state updates — clear 1 — and the App's re-render clears
    again because the previous frame overflowed — clear 2; the test therefore gates at 2) and by the perf `states`
    probe (`resize 40x120 … 2 (1) FAIL`, `allowed: 1` in `src/perf/states.ts`). The idle `resize` smoke scenario (no
    pane open) shows ≤ 1 in all four smoke runs. The docs (README, TUI.md, terminal matrix row 16, DESIGN.md §12)
    now state the measured behaviour; the bound of 1 is an open item below.
12. **`Shift+Enter` in `docs/KEYS.md`.** `composer:newline` is bound to `ctrl+j`, `meta+return`, `shift+return`
    (`src/tui/keys/bindings.ts`), so the generated table lists `Shift+Enter` as a newline key, while the user guide and
    the terminal matrix say Shift+Enter is not a newline — both are literally true: without the kitty keyboard protocol
    or `modifyOtherKeys` (never requested, §14) a terminal sends plain `\r` for Shift+Enter, so the binding never
    fires. `docs/TUI.md` and README now say "bound but inert". Request to the polish slot (owner of the registry): add a
    `note` to the `composer:newline` row so the generated `docs/KEYS.md` carries the caveat.

### Not verified here

- Any real terminal application beyond the `expect(1)` pseudo-terminal (`TERM=xterm-256color`): the per-terminal
  rows of `docs/TUI.md` and `docs/research/tui/terminal-matrix.md` (iTerm2, Terminal.app, VS Code, Ghostty, kitty,
  WezTerm, Alacritty, foot, tmux, mosh) come from the 2026-09-20 research and carry its `?` marks; the manual
  checklist at the end of the matrix has not been run.
- Windows / ConPTY / WSL 2 (the design's posture only), screen readers (NVDA / VoiceOver), IME input, Ctrl+Z through a
  real job-control shell, `--notify` and `--osc52` on a real terminal, `--title` (now wired, see deviation 3; not exercised on a real terminal).
- Publishing: `npm publish`, the `next`/`latest` dist-tags, provenance and the Homebrew tap install (`Formula/jevcode.rb`
  still has placeholder `url`/`sha256`; `package.json` is 0.1.0). `jevcode upgrade` was unit-tested only.
- A live (real Jev + generator) interactive session: another slot recorded `docs/live/tui/live-session.steps`
  while this was written (`tui-pty.log` 1,831,024 bytes; `timing.jsonl` reaches step 31 `/resume`, then step 32's
  `expect` for a run end times out after 600 s and the driver's `kill-on-timeout` sends SIGKILL → `exit 137`;
  `attempt-1/` holds an earlier 2.5 MB capture); not evaluated here beyond a pattern grep of the captures for
  `sk-or-v1-` / `sk-ant-` (0 hits).
- A `jevcode perf` run on a quiet machine: the 08:38Z run ("Measured numbers") had load 2.5 and five `drive.exp`
  processes of other slots alive, so its rows-40 lag p95 of 99.6 ms is not separated from contention; the
  live-pane shrink double clear (2 vs 1) and the `imagesMs` p95 (19.3 vs 15 ms) are less load-sensitive but were
  taken under the same conditions. `perf/results/latest.json` is still the 2026-09-20 file (perf slot).
- Windows, screen readers and real terminals aside, the remaining unverified TUI claims are the ones only a
  human at a terminal can check (the manual checklist at the end of `docs/research/tui/terminal-matrix.md`).

### Open questions

- `--title` is now wired (one `OSC 2` write at `setUi`, reset at unmount); whether the title should also carry the run's
  step count live (design §14.1 leaves it as one write) is open.
- Shrink resize with a live pane open clears twice (deviation 11). Either the App must render the new geometry in
  the same frame Ink's `resized` handler uses (so the stale tree is never drawn at the new viewport), or the design
  bound moves to 2 and the perf `states` probe's `allowed` follows the pty test; today the two gates disagree.
- The `[screen reader mode: on via …]` first item of §24 (deviation 10): wire it, or drop it from the design.
- `/copy diff`: keep the "last item" semantics and drop `diff` from the enum, or store the last diff block separately?
- The `--plain` `y/N` gate and the review prompt share one readline: the design's §6.5 stash-the-draft rule is
  implemented for screen-reader mode; whether the cooked-mode readline composer needs the same guard against a line
  begun before the prompt appeared has not been examined.
- Whether the 50-run / 32 MB `/calibration` cap should be a setting (the design fixed it after measuring a 166 MB
  `steps.jsonl` corpus).
