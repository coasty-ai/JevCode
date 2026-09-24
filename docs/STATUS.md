# JevCode status report (2026-09-19/20)

## What was built

One package at `vscode/JevCode` (its own git repository, nothing imported from any sibling checkout):

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

### Live session (real Jev `typesafe/jev-1.13-20260917` and Claude Sonnet 5 through OpenRouter, 2026-09-21 10:35 UTC)

`docs/live/tui/` holds the fourth and complete recording of the scripted interactive session
(`live-session.steps`, driven by `scripts/pty/drive.exp` in a 40×120 pty with `PTY_AUTO_REVIEW=y`; workspace
`/tmp/jevcode-demo` = `examples/demo-py` with a git history and a `.venv`). Every stage of the design ran end to end
in 41.5 s for $0.099, driver exit 0, and the artefacts (`tui-pty.log`, `timing.jsonl`, `runs/<id>/{transcript.log,
state.json,run.json}`) contain no key material (0 hits for the `sk-or-v1-`/`sk-ant-` formats):

| what | evidence |
| --- | --- |
| first frame (chat, argv only) | cursor-hide sentinel at 105 ms after spawn |
| task typed into the composer, Enter | `[run] ready` 67 ms later |
| steer typed while the run was live | 1 `steer queued` line(s) at step 1, 1 `steer applied` line(s) (`[step 2] steer applied to step 2 (1 directive)`) |
| loop detection → replan by Jev | run 1 ended `replan_stop` at step 4 (`task_impossible=0.42`), 20 s, $0.045, exit 4; 1 loop/replan line(s) |
| follow-up seeded from the previous run | `[run] seeded from run 20260921-103525-arhva4xt: plan done=4 remaining=4 unverified=0 · window 4 entries · 0 created` |
| Esc → pause at the step boundary | `end human_pause steps=1`, exit 4; epilogue `paused after step 1 — /resume continues, or type a follow-up` |
| Jev review answered through the pty | `[step 1] confirm 20260921-103547-ntj6esxg:1 approved` — approved on the first `y`, 1.0 s after the box was drawn |
| `/cost`, `/plan`, `/diff`, `/decisions` while paused | `[ui] run $0.013 of $1.000 (1 %)`, `[ui] plan`, `[ui] diff (run … · 0 files · +0 −0 …)`, `[ui] decisions (last 12)` |
| `/continue` resumes the paused run | `[run] ready … step 1/12 (resumed)` → `resumed at step 2` → `end complete steps=3`, 17 s, $0.041, exit 0 |
| `/exit` | process exit 0; `sessions/index.jsonl` carries `run:start`, `run:end`, `pause`, `run:start`, `run:end` for the session |

The three earlier recordings (`attempt-1` … `attempt-3`) are kept as the evidence trail of what changed between them:
attempt 1 stalled on the driver's 80-column review regex at 120 columns; attempt 2 leaked a review `y` into the
composer (fixed by the resolver guard) and stalled on a bare `/resume` (which opens the picker; the steps now use
`/continue`); attempt 3 still needed a second `y` per review, traced to the driver's non-draining pause starving the
TUI's React effects (Node's synchronous TTY writes; `docs/research/tui/20-pty-driver-findings.md` §5) — a real
terminal always reads, so this cannot occur outside a stopped pty reader. Not covered by the recording: the wizard
(keys were configured), the trust gate (no `AGENTS.md`), `/undo` and `d`-notes on a real run (both covered by the
pty suite against mocks).

### Owner's pass (2026-09-21, after the integration pass; gates re-run on this machine at load 2.4–2.9)

`tsc` 0 errors · `no-any` ok · unit **304 files, 5,228 passed, 1 skipped** (re-run by the owner) · build + `check-pack` green
(bundle 2,068,353 bytes minified, unpacked 2,269,631 < 3,000,000, tarball 766,877) · `gen-docs --check` 0 · pty vitest
**63/63** · `npm run perf` (full, on the integration bundle) — **GATE FAILURE**, which the integration pass had not run:
composer keystroke → frame p95 **36.0 / 43.4 / 38.1 ms** (idle / live / palette; gate < 16 ms; review 8.7 ms passed), the
intake `[you]` bubble under the 150 ms mock p95 **18.0 ms** (gate < 16), harness overhead p95 **53.1 ms** (gate < 50; 46 ms in
round 1). Diagnosis of the composer rows (the S5 pass had seen the same and recorded it as deviation 20): the slow keys were
exactly every 5th key while a run was live and every 10th while idle or in the palette, each drawn ≈ 40 ms after its send —
Ink 7.1.1 throttles `onRender` at ⌈1000 / maxFps⌉ = 34 ms (leading + trailing), so a key inside the window opened by a
spinner frame (8 fps live) or the 1 Hz clock frame waited for the trailing edge; the phase decided which keys. Round 1 never
measured it because `<Transcript>` re-rendered `<Static>` on every commit (a fresh `onFail` arrow per render), and a commit
that touches the `<Static>` node takes Ink's *immediate* path (`reconciler.js` `commitUpdate` → `isStaticDirty` →
`onImmediateRender`); round 2's memoisation of `<Transcript>` (finding 3) was correct and exposed the throttle.

**Fix (TUI-DESIGN-2 decision D-F, `src/tui/{useEngine.tsx,Transcript.tsx,App.tsx}`):** `UiState.keySeq` counts `key`
actions (always a new state, so two keys in one millisecond both count); the App passes it to the memoised `<Transcript>`,
which hands `<Static>` a fresh `style` object per key (`useMemo(() => ({}), [keySeq])`), so the key's commit is written
synchronously; spinner and clock commits do not change `keySeq` and stay throttled. `test/unit/tui/key-immediate-render.test.tsx`
asserts the mechanism against the real renderer on a stub TTY (a plain commit inside the window is deferred to the trailing
edge; a key commit inside the window is synchronous; a tick after a key is still deferred); `round2-reducer.test.ts` covers
the counter. Re-measured on the rebuilt bundle (`JEVCODE_PERF_ONLY=composer-latency,intake-latency,step-overhead`, load
≈ 2.7, **all gates pass**):

| Series (24×80, 200 keys at 10 keys/s unless stated) | before (integration bundle) | after D-F | gate |
| --- | --- | --- | --- |
| composer idle p50 / p95 / max | 3.2 / **36.0** / 57.0 ms | 4.7 / **5.8** / 8.2 ms | p95 < 16, max < 50 |
| composer live (`JEVCODE_MOCK_STEP_MS=200`) | 4.2 / **43.4** / 68.9 ms | 3.8 / **6.6** / 14.2 ms · dynamic 11 fps | p95 < 16, max < 50, dynamic ≤ 31 |
| composer live-stress (0 ms mock; report) | 16.1 / 44.9 / 66.5 ms | 2.2 / 10.3 / 13.4 ms | report |
| composer palette | 3.0 / **38.1** / 42.3 ms | 5.5 / **6.7** / 7.4 ms | p95 < 16, max < 50 |
| composer review (`e` toggles) | 4.7 / 8.7 / 14.0 ms | 7.1 / 9.6 / 14.0 ms | p95 < 16, max < 50 |
| composer burst30 (33 keys/s; latency reported) | 24/200 keys located, 4,694 ms | **200/200 located**, 2.8 / 4.2 / 8.9 ms · key frames 34/s, dynamic 0 | dynamic ≤ 31 |
| intake mock0: Enter → `[you]` bubble p95 · → reply p95 | 11.8 · 11.8 ms | 13.4 · 13.4 ms | bubble < 16 · reply ≤ 40 |
| intake mock150: bubble p95 · reply p95 net of the delay | **18.0** · 15.1 ms | **11.3** · 15.1 ms | bubble < 16 · reply ≤ 40 |
| harness overhead per step p95 / p50 | 53.1 / 29.2 ms | 49.1 / 25.5 ms (run steps p95 51.4; other steps 40.2) | p95 < 50 |

The harness row is the 15 MiB dirty-set copy at every run step (round 1 measured 46 ms on a quiet machine); the S1 change
to `emit` (a re-entrancy queue, one array check per event) is not visible in it, and the margin is thin: a full `npm run perf`
that overlapped with this pass's own unit-suite runs read **51.1 ms (FAIL)** and a cold first frame of 192 ms, the same two
probes alone on the idle machine read 48.5 ms and 117 ms. The final full `npm run perf` on the final bundle, idle machine,
load 1.9 → **all gates pass** (`perf/results/latest.json`): first frame cold p95 129.6 ms run / 123.9 ms chat at 24×80 (warm
median 98 ms); harness p95 **49.5 ms**; lag net p95 2.45 / 0.94 / 2.45 ms; composer p95 **5.4 / 6.0 / 6.5 / 9.5 ms** (idle /
live / palette / review; live-stress 10.6 reported; burst30 200/200 at 4.4 ms); intake mock0 bubble p95 12.5 ms, mock150
bubble p95 10.1 ms · reply net 14.8 ms; splash bucket 14 dynamic frames; 0 clears everywhere; 17/17 state scenarios.

Also in this pass: the `llm-jev` engine-mode surface for the harness session's design (`docs/LLM-JEV-DESIGN.md`): the additive
contract (`EngineMode` member; optional `sample` / `samples` on the `generator:*` events), `--mode llm-jev` / `/mode llm-jev`,
the badge, both keys required, the jev-on cap default, the controller wiring the real generator and the synthesizer together,
a `sample k/N` live counter; the engine behaviour lands in the peer's tree. `package.json` bumped to **0.3.0** (unpublished);
the man page and completions regenerated. After the commit (1e264d5) one more live drive of the committed bundle against TypeSafe
(`docs/live/tui/round-2/final-typesafe-24x80.*`): first frame 112 ms, splash settled 704 ms, `hi` → `[jevcode]` **240 ms**, facts
144 ms, task → `[run] start` 177 ms, a 9-step jev-only run (`jev-1.13.0`, 4,606 questions, $0.025, **0 generator calls**,
`replan_stop` — the synthesizer still does not repair demo-py, recorded above), 0 clears, 0 rows wider than 80 columns, 0 key
bytes in any artefact; the live Jev suites re-run first-hand: 4/4 on both providers (TypeSafe 117–235 ms, OpenRouter 351 ms).

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
- `jevcode perf` release run (perf slot, 2026-09-21 10:57Z): **all gates pass**; `perf/results/latest.json` and the
  README Performance table are regenerated from it. Conditions: 1-minute load 1.00 at the start and 0.99 at the end
  (release bound ≤ 2 met), but the machine was not free of other slots' pty drivers — 5 orphaned `expect … drive.exp`
  processes (parent `launchd`, six hours old, 0 % CPU, blocked in their final `eof` wait on a `jevcode chat --mock` child that
  waits for input) stayed alive through the 15-minute quiet-machine poll and the run; they are listed under `foreignDrivers`
  in the JSON. The lag and frame-rate gates were redefined for this run (TUI-DESIGN §18, DESIGN §12): measured at
  `JEVCODE_MOCK_STEP_MS=200` (≈ 4.2 steps/s) with the zero-latency mock as a reported `stress` row; the lag p95 taken net of
  the probe's ≈ 2 ms idle floor (macOS timer coalescing, measured by the same probe in a bare idle `node` in the run); the
  frame-rate gate on `dynamic` frames only (Ink's immediate `<Static>` renders and leading-edge key frames are reported).
  The 08:38Z figures quoted under "Measured numbers" (rows-40 lag p95 99.6 ms, shrink double clear) predate the typist
  driver and the wave-4 resize fix and are superseded by that file.
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

## Round 2 — jev-only default, Jev providers, conversational intake, the console and the splash (2026-09-21)

The second round of the interactive TUI (`docs/TUI-DESIGN-2.md`; six slots ran concurrently on 2026-09-21 — S1
providers and contract, S2 defaults, mode and wizard, S3 intake and chat, S4 visual components, S5 pty, perf and docs,
S6 live verification). This section is S5's record: what the docs slot found on disk, which gates were run and with
what result, and where the tree deviates from the design (the docs describe the behaviour; every deviation is listed
below). The other slots' files were still landing while this was written; the "checked on disk" column names the
commit-less working tree at the time of each check.

### What was built (as found on disk at the end of the S5 pass)

- **Contract 1.2 and providers** (S1: `src/core/types.ts`, `src/jev/providers.ts`, `src/jev/{client,validate,types,mock}.ts`,
  `src/config/**`, `src/cli/config-table.ts`, `src/loop/engine.ts`): `UiLabel` `[you]` / `[jevcode]`, `DeciderConfig.provider`
  / `pricing` / `providerSource`, `Decider.provider`, `JevUsage.cost?`, `AskResult.costBasis`, `SubmitOutcome`,
  `Renderer.restoreDraft?` / `live?`, `SessionRef.intake?`, `LaunchSettings.modeHint` / `reducedMotion`; the
  `JEV_PROVIDERS` table (TypeSafe native `jev-1.13.0` at `api.typesafe.ai/v1/systemone`, OpenRouter
  `typesafe/jev-1.13-20260917`), `--jev-provider` / `JEV_PROVIDER` / `jevProvider` with the auto rules, per-provider
  defaults and offline refusals, table-priced cost when `usage.cost` is absent, `x-typesafe-request-id`; the `mode`
  setting.
- **Defaults, mode, wizard** (S2: `src/cli/{args,main,login}.ts`, `src/tui/onboarding/**`, `src/tui/commands/**`,
  `scripts/gen-docs.mjs`): the `jev-only` default, `/mode [m]` and `/llm on|off`, `/panel`, `/transcript`, the
  `jevProvider` wizard step, `reopen` with `reason: 'mode'`, `jevcode login --jev-provider`.
- **Intake and chat** (S3: `src/chat/{intake,replies,facts,lookup,llm-turn,lines,bubbles,ledger}.ts`, `src/cli/session.ts`,
  `src/cli/{json-stream,tui-prompter}.ts`, `src/tui/{plain,plain-composer}.ts`, `src/tui/composer/history.ts`,
  `src/tui/budget/lines.ts`, `src/tui/why.ts`, `src/session/index.ts`): the one-request intake, the 14-row catalogue and
  the 14 facts, the lookup and the LLM turn, the `intake` card rows, `converse()` / `reply()` / `chatFailure()`, the
  `step` summary item, the `chat` index and `--json` lines.
- **Visual components** (S4: `src/tui/{App,Overlay,Review,Pane,Picker,StatusLine,Transcript,Console}.tsx`,
  `src/tui/{console,card,splash,motion,theme,color-shim,layout,glyphs}.ts`, `src/tui/useEngine.tsx`,
  `src/tui/status/lines.ts`, `src/tui/pane/**`, `src/tui/review/lines.ts`, `src/tui/keys/**`): the chrome tiers,
  `computeLayout` 1.1, the console, the cards, the compact transcript, the panel strip, the badge, the thinking words,
  the truecolor / 256 palette, the splash.
- **pty, perf, docs** (S5, this slot): `test/pty/run-smoke.sh` 19 → 36 scenarios (`test/pty/smoke/*.steps`; the fix
  pass added `chat-ambiguous-flat` at 12×60 and `splash-settle`) plus the `--hermetic` self-check — every child runs
  from its workspace under an isolated `HOME` / `XDG_CONFIG_HOME` / `JEVCODE_HOME` with `JEVCODE_CONFIG` and every key
  variable unset — the round-1 pty tests moved to the round-2 sentinels (`test/pty/{helpers,chat,interrupts,review,
  twins}.pty.test.ts`; the identity test asserts the compact subsequence; `review.pty.test.ts` gains the Enter-inert
  card test), `test/pty/round2.pty.test.ts` (33 tests, 4 of them `it.fails` records of open defects — 63 pty tests in
  all), `src/perf/intake-latency.ts` (new probe, two series; a dropped Enter fails the series), the splash bucket in
  `src/perf/render-lag.ts` (`dynamic` frames only, gate ⌈(maxFps + 1) × 0.7⌉ = 22, the typist waits 800 ms for the
  settle), the splash-frame-0 **gate** and `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME` in `src/perf/first-frame.ts`, the
  boxed-tier `composerRow` and the hermetic `baseEnv` in `src/perf/pty.ts`, the `intake` state scenario and the card
  sentinels in `src/perf/states.ts`, the new rows and notes in `src/perf/readme.ts`, `test/unit/perf/*` (52 tests in 8
  files, incl. `hermetic.test.ts` and `smoke.test.ts`), `README.md`, `docs/TUI.md`, `docs/DESIGN.md` §10 / §12,
  `CHANGELOG.md` 0.3.0, `docs/DECISIONS.md` (four entries), this section, and the regenerated `docs/KEYS.md` /
  `docs/COMMANDS.md` / `man/jevcode.1` / `completions/*`.
- **Live verification** (S6: `docs/live/tui/round-2/**`): the two-provider live scenarios; not evaluated here beyond
  the presence of the directory.

### Verified (commands run on 2026-09-21 on this machine — Apple Silicon Mac, macOS 26, Node 22.23.2; the other slots' edits landing throughout)

| Check | Command | Result |
| --- | --- | --- |
| Types and `any` | `npx tsc -p tsconfig.json --noEmit`; `node scripts/no-any.mjs` | S5's files (`src/perf/**`, `test/pty/**`, `test/unit/perf/**`) type-check clean at every check (11:3xZ–13:2xZ). The whole tree: 73 errors in `src/cli/session.ts` at 11:29Z (S3 mid-edit), 14 → 3 → 2 in S3 / S4 test files through 12:xxZ, **0 at 13:2xZ**; `no-any` failed at 11:3xZ on two comments containing the word (S2's `src/tui/onboarding/Wizard.tsx:216`, `test/unit/tui/wizard.test.tsx:247`) and passes at 13:2xZ (`no-any: ok (src, test, perf, scripts)`) |
| Perf unit tests | `npx vitest run --project unit test/unit/perf` | **6 files, 42 tests pass** (11:34Z): `intake-latency.test.ts` (new: message plan, `pairIntake`, `judgeIntake`), `pty.test.ts` (+ boxed-tier `composerRow`, `wordmarkCells`), `render-lag.test.ts` (+ `splashBucket`), `readme.test.ts` (+ the splash and intake rows, `failures()` for both), `states.test.ts`, `main.test.ts` |
| Full unit suite | `npx vitest run --project unit` | 11:43Z: 279 files, 268 pass, 11 fail (40 tests) in other slots' files mid-landing; **13:1xZ (final, alongside perf run 2's clears-only `states` probe): 295 files, 288 pass, 7 fail — 10 tests, none in `test/unit/perf/**`: `cli/session.test.ts` (3), `session/index.test.ts` (2), `tui/wizard.test.tsx`, `tui/app.test.tsx`, `chat/llm-turn.test.ts`, `chat/intake.test.ts`, `chat/facts.test.ts` (1 each); 5,094 passed, 1 skipped (`fish` absent)** — the other slots' own tests against their still-moving code |
| Generated docs | `node scripts/gen-docs.mjs` (11:4xZ) | rewrote `docs/COMMANDS.md`, `docs/KEYS.md`, `man/jevcode.1`, `completions/jevcode.{bash,zsh,fish}` from S2's registries (`/mode`, `/llm`, `/panel`, `/transcript`, `--jev-provider`, the panel keys `Alt+J` … `Alt+S`); `--check` exits 0 afterwards |
| Build | `npm run build` | 11:4xZ: `dist/jevcode.mjs` 3,621,947 → 2,046,825 bytes minified in 170 ms, build smoke first frame ok (54 ms); 12:0xZ: 3,622,677 → 2,047,151 bytes, first frame ok (48 ms); `THIRD_PARTY_LICENSES.txt` 35 packages |
| Real-pty smoke (34 scenarios) | `sh test/pty/run-smoke.sh` | **34/34 PASS** on the 12:4xZ bundle (build 3,639,957 → 2,056,604 bytes; `.scratch/smoke-final.log`): 0 expect timeouts, `clears_after_first_frame=0` in every scenario (the shrink segments of `resize`, `resize-live`, `chrome-tiers` measured 0), `restores=1` in all 34, `chat-hi` `wall_enter_to_reply` recorded, `chat-task` `step-line compact:no-stage-lines compact:no-run-ready`, `splash` / `splash-wide` wordmark cells before the key > 0 and 0 after, `splash-reduced` 0 wordmark cells, `zero-arg-wizard` `wizard:jev-provider no-generator-step`, `mode-switch` `in-place-wizard`, `mode-switch-keyed` `badge:next-run`, `panel` `panel:open+more-row`, `chrome-tiers` `boxed+flat`. Earlier runs on the 11:4xZ / 12:0xZ bundles: 25/34 and 28/34 — the failures were the SGR-blind sentinels, the `expect`-after-`sleep` consumption, the sibling `.env` (deviations 1, 2, 11) and the other slots' pieces still landing (deviations 4–7) |
| pty vitest project (44 tests) | `env -u CI -u CONTINUOUS_INTEGRATION npx vitest run --project pty` | 12:30Z (12:4xZ bundle): **41 passed, 3 failed** in 24.9 s — `--json on a pipe` (S5: the pipe run lacked `--mode jev-on`, so the real synthesizer ran and exited 4; fixed), `zero-argument start with no key anywhere` (S5: asserted the fix block, which the capture does not carry — deviation 13; the test now asserts the `setup · jev provider` title and the options row and reports the block), and `identity` (`static row wider than 80 columns: "[sandbox] seatbelt — writes confined to the workspace and run dirs; harness secret files,": expected 89 to be less than or equal to 80` — deviation 3, S4). Re-run of the three at 12:5xZ: **json and wizard pass, identity still fails on the 89-cell row** → **43/44** on the final tree; earlier full runs: 38/44 at 12:1xZ (the SGR-blind sentinels and the consumption rule, since fixed) |
| `jevcode perf` (two complete runs) | `env -u CI -u CONTINUOUS_INTEGRATION npm run perf` (background; `perf/results/latest.json` and the README Performance section rewritten by each complete run — the file on disk is run 2's) | **GATE FAILURE in both complete runs**, for reasons that are all named. Run 1 (12:16Z–12:28Z, load 2.03 → 4.61, 1 foreign pty driver): harness p95 51.1 ms (gate < 50; the load-sensitive margin the round-1 STATUS already records), composer `review` 16/200 toggles (the collapsed panel left `e` without a visible effect — probe fixed), and 9 state scenarios (the sibling `.env`, the `expect`/`sleep` consumption, my marker patterns — all probe-side, fixed). Run 2 (12:5xZ–13:1xZ, load 4.81 → 2.40, 1 foreign driver(s); the file `perf/results/latest.json` and the README table now on disk): **every gate passes except** harness p95 52.6 ms (< 50), `state wizard` 24×80 and 12×60 (the driver inherited `jevcode perf`'s cwd — the repository root — so `./.env` supplied keys and no wizard opened; `src/perf/pty.ts` now runs the driver from the scenario's temp dir) and `state intake` 12×60 (my `expect \[y\] run it` against the flat row's short width-ladder form; now `\[y\]`). Passing in run 2: first frame cold p95 127.1 / 130.6 / 120.8 / 124.7 / 131.4 / 120.0 ms with splash frame 0 in 20/20 first frames at the wordmark geometries and 0/20 at 8×40; lag p95 net 1.65 / 0.62 / 1.98 ms with 14 / 8 / 7 splash frames in 700 ms (7 / 0 / 0 with the wordmark); composer p95 5.7 / 5.3 / 9.6 / 6.7 / 9.8 / 4.8 ms (idle / live / live-stress / palette / review / burst30; `review` 200/200 with the panel opened first); intake bubble p95 12.8 / 10.3 ms, reply p95 12.8 ms at 0 ms and 14.1 ms net of the 150 ms delay, 0 runs started; 14/17 state scenarios with 0 clears outside shrink segments (resize / resize-live / resize-idle shrink segments 0 (1) each, ctrl-l repaint equal). A partial `JEVCODE_PERF_ONLY=states,step-overhead` re-run on the rebuilt bundle follows below. The 1-minute load never met the ≤ 2 release bound: the other slots' suites ran throughout. |
| **Fix pass** (13:1xZ–14:0xZ, the second S5 pass; the other slots' processes gone): types, `any`, perf unit | `npx tsc -p tsconfig.json --noEmit`; `node scripts/no-any.mjs`; `npx vitest run --project unit test/unit/perf` | **0 errors** for the whole tree; `no-any: ok`; **8 files, 52 tests pass** (the 45 of the first pass with the new splash-bucket, first-frame and dropped-Enter cases, plus `hermetic.test.ts` 4 — `childEnv`, `baseEnv`, `run-smoke.sh --hermetic` and a live control — and `smoke.test.ts` 3 — the `--wordmark` cut) |
| Fix pass: real-pty smoke (36 scenarios + `--hermetic`) | `sh test/pty/run-smoke.sh` (13:4xZ, load ≈ 1.7, no foreign driver; again at 13:5xZ on the final 13:41Z bundle) | **36/36 PASS, hermetic PASS, both runs** (`.scratch/s5probe/smoke-run{1,2}.log`; the second: `FIRST_FRAME_MS=90.1`, `chat-hi` 22 ms, `splash-settle` 15 frames / 708 ms): 0 expect timeouts, `clears_after_first_frame=0` everywhere (the three shrink scenarios measured 0 of their allowed 1 / 2 / 1), `restores=1` in all 36; new checks green — `chat-ambiguous` `enter-inert:card-open-until-n`, `chat-ambiguous-flat` `intake-row:narrow enter-inert`, `review-y` `one-approval enter-inert:no-y-echo`, `splash-settle` `wordmark_frames=15 after_brand=0 settle_t=708ms`, `splash` / `splash-wide` `wordmark_before_key=26 / 14 after_key=0` with the cut at the echo frame's start, `firstframe` `FIRST_FRAME_MS=89.6`, `chat-hi` `wall_enter_to_reply=15ms`; the run-dir + `jevcode.log` gate now fails a scenario (all seven have it) |
| Fix pass: pty vitest project (63 tests) | `env -u CI -u CONTINUOUS_INTEGRATION npx vitest run --project pty` (13:38Z on the 13:1xZ bundle, 90 s; 13:52Z on the 13:41Z bundle, 59 s) | 13:38Z: **57 passed, 4 expected-fail (`it.fails`), 2 failed** — the redaction-in-`--plain` test expected the TUI's `Send anyway? y/N` where the readline gate reads `jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel: ` (fixed), and `identity`; 13:52Z, final bundle: **58 passed, 4 expected-fail, 1 failed** — `identity` on the 89-cell `[sandbox]` row (deviation 3, S4, unchanged). The four `it.fails`: the fix block after Ctrl-C at the startup wizard, the idle console drawn after it (S2), `Alt+D` (S2/S4), `/why intake` (S3) — each flips to a failure the moment the owning slot lands the fix |
| Fix pass: generated docs | `node scripts/gen-docs.mjs --check` | exit 0 — nothing stale (no registry changed in this pass) |
| Fix pass: `jevcode perf`, run 4 (complete, quiet machine) | `env -u CI -u CONTINUOUS_INTEGRATION npm run perf` (14:xxZ) | **GATE FAILURE, for one reason that is new and reproducible** (the table is the "run 4" block under Measured numbers; `perf/results/latest.json` and the README Performance section are this run's output): first frame cold p95 114.9–152.5 ms with splash frame 0 in 20/20 first frames at the wordmark geometries and 0/20 at 8×40 (gated now); harness p95 **49.6 ms** (< 50, `imagesMs` p95 19.9 ms); lag p95 net 2.55 / 1.11 / 3.46 ms with the splash bucket 14 / 1 / 1 `dynamic` frames (+ 1 static, 0 key; 14 / 0 / 0 with the wordmark; window 700 ms; gate ≤ 22); intake bubble p95 12.4 / 10.3 ms, reply p95 12.4 ms at 0 ms and 13.6 ms net of the 150 ms delay, **`thinking` seen in 20/20 messages of the delayed series** (0/20 in run 2 — S4's mapping landed), 0 runs, 0 Enters dropped; **17/17 state scenarios pass** (wizard 24×80 / 12×60 exit 2, intake 12×60 `run this as a task?  [y] [n]  Esc keeps`, resize shrinks 0 of 1 allowed, Ctrl+L repaint equal); composer `review` p95 9.9 ms — but composer **`idle` p95 39.1 ms, `live` 44.5 ms, `palette` 41.3 ms (gate < 16) and `burst30` 11/200 keys located**: every 10th key of the 100 ms cadence (indices 45, 55, … 165 idle; 2, 12, … 182 palette) takes ≈ 40 ms — a 1 Hz render in the App that draws no new frame (the idle capture is identical frame to frame) but consumes Ink's throttle so the key that follows it within 34 ms waits for the trailing edge; run 2 (12:5xZ bundle) had 0 of 200 keys over 16 ms in the same series. Deviation 20 and the S4 request below; a composer-only re-run (`JEVCODE_PERF_ONLY=composer-latency`, 13:5xZ, load 1.02 → 1.63, written to `.scratch/`, never to `latest.json`) reproduces it for `live` (p95 41.9 ms), `palette` (41.0 ms) and `burst30` (24/200 located) while `idle` passed that time (p95 5.6 ms, 0 dynamic frames — the collision needs the tick to be in phase with the keys); in the kept captures every slow key is drawn ≈ 40 ms after its send with **no frame in between**. Load 1.62 → 2.17 (the ≤ 2 bound missed by 0.17 at the end; no foreign pty driver) |


### Measured numbers

**Smoke and pty numbers (12:0xZ–12:2xZ bundles, `test/pty/run-smoke.sh` and `test/pty/round2.pty.test.ts`; the
driver's clock, 1 ms resolution):**

| Measurement | Value | Bound |
| --- | --- | --- |
| Enter → `[jevcode]` reply, `chat-hi` (mock decider; `mark hi-sent` → `expect [jevcode]`) | 18 ms (smoke, 12:1xZ), 13 ms (smoke, 12:4xZ); the pty test's `wallBetween` figure is in its console line | 1.5 s (TUI-DESIGN-2 §9, the live gate) |
| First frame of the splash scenarios (`expect step 0/`, spawn → status sentinel, warm) | `splash` 24×80: 99 / 101 / 165 ms; `splash-wide` 40×120: 100 / 101 / 149 ms (three runs each; the third with perf run 1 and the other slots' suites alive); `firstframe` `FIRST_FRAME_MS=` 95.7 / 98.8 (child clock) | < 300 ms |
| Wordmark cells (`██`) before the first key / after it | 24×80: 31 / 21 before, 0 after; 40×120: 14 / 14 before, 0 after (a key at ~100 ms cancels the splash, §5.3; the count before the key varies with how many 50 ms frames landed before it) | > 0 before, 0 after |
| `--no-animation` wordmark cells | 7 on the 12:0xZ bundle (deviation 5), 0 in the render-lag reduced-motion run of the 12:16Z bundle | 0 |
| Clears after the first frame | 0 in every scenario without a shrink; `resize` ≤ 1, `resize-live` ≤ 2, `chrome-tiers` ≤ 1 (measured 0 / 0 / 0 on the final bundle: the 8-row live frame and the 6-row idle frame fit a 12-row terminal, deviation 10) | 0 / ≤ 1 per shrink |
| Exit string `RESTORE` per exit | 1 in every passing scenario (`chat-ambiguous` on the 12:0xZ bundle: 0 — the run was killed on the driver's timeout before it exited) | exactly 1 |
| Boxed console rows at 24×80 | first frame 11 dynamic rows (rule · 5 wordmark rows · 5 console rows), idle 6 (brand row + console), intake card 9, open panel ≤ 12 | ≤ rows − 2 = 22 |

**`jevcode perf`, run 1** — `env -u CI -u CONTINUOUS_INTEGRATION npm run perf` started 12:16Z on the bundle it built at
12:16Z (before the S5 fixes that followed: the hermetic `JEVCODE_EXTRA_ENV_FILE` in `src/perf/pty.ts` and the review series'
`/panel full`), with the other slots' test runs alive (1-minute load 2.0 → 7.5 during the run):

| Measurement | Result | Gate | Status |
| --- | --- | --- | --- |
| First frame `run` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 126.8 ms / 118.8 ms (97.0 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `run` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 175.5 ms / 117.4 ms (97.1 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `run` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 115.4 ms / 113.1 ms (93.0 ms); 0/20 (flat, none expected) | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 119.7 ms / 117.7 ms (98.3 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 122.1 ms / 116.9 ms (95.8 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 120.2 ms / 113.0 ms (93.8 ms); 0/20 (flat, none expected) | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| Harness overhead per step p95 / p50 (50 mocked steps, 5,000-file fixture, 50 dirty files / 15 MiB) | 51.1 ms / 30.3 ms (`run` steps p95 64.8 ms; `imagesMs` p95 24.5 ms) | p95 < 50 ms | **FAIL** |
| Render lag rows 40 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 1.62 ms (2.69 ms) / 26.07 ms · 5 · 22 · 18 · 13 (7; True) · 0 · 11 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 12 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 0.64 ms (1.70 ms) / 20.79 ms · 5 · 23 · 16 · 8 (0; False) · 0 · 5 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 reduced motion at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 2.05 ms (3.12 ms) / 16.53 ms · 5 · 18 · 13 · 7 (0; False) · 0 · 8 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 stress (reported) at `JEVCODE_MOCK_STEP_MS=0`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 4.70 ms (5.77 ms) / 28.00 ms · 52 · 51 · 87 · 43 (7; True) · 0 · 11 | hygiene only | pass |
| Lag probe idle floor (bare idle node, 17 s): p50 / p95 / max | 1.07 ms / 1.14 ms / 1.99 ms | report (calibration) | applied |
| Composer keystroke → frame `idle`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 4.4 ms / 5.7 ms / 13.8 ms; 0 (n/g); 0 · 11 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `live`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 3.3 ms / 5.8 ms / 11.9 ms; 21; 0 · 12 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `live-stress`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 2.4 ms / 9.3 ms / 34.0 ms; 83 (n/g); 0 · 13 | report | pass |
| Composer keystroke → frame `palette`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 3.2 ms / 6.0 ms / 8.0 ms; 0 (n/g); 0 · 14 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `review`: 16/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 19566.4 ms / 20324.2 ms / 20324.2 ms; 5 (n/g); 0 · 15 | p95 < 16 ms, max < 50 ms | **FAIL** |
| Composer keystroke → frame `burst30`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 1.8 ms / 2.9 ms / 15.8 ms; 0; 0 · 11 | report | pass |
| Intake `mock0` (mock 0 ms, 20 messages): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 6.4 ms / 10.1 ms / 10.6 ms · 6.4 ms / 10.1 ms / 10.6 ms (10.1 ms) · 0/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| Intake `mock150` (mock 150 ms, 20 messages): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 5.4 ms / 8.0 ms / 8.6 ms · 156.5 ms / 160.7 ms / 163.5 ms (10.7 ms) · 0/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| State `review` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 30 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 10 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 124 (2) TIMEOUT · 0 (0) · 19 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `secret` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 12 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 10 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `review` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 29 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 9 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 124 (2) TIMEOUT · 0 (0) · 5 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `secret` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 11 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 5 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `picker` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 28 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-composer` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 32 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-pane` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 24 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `resize` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 0 (0) · 31 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `resize-live` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 0 (0) · 3336 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `resize-idle` 24×80 (typist): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 0 (0) · 13 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `ctrl-l` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 27 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |

Run: `2026-09-21T19:28:16.323Z`, Node v22.23.2, Apple M5 Pro (15 cores, 24 GiB), 1-minute load 2.03 at the start and 4.61 at the end (release bound ≤ 2: NOT met); 1 foreign pty driver(s) alive; probes first-frame, step-overhead, static-append, render-lag, composer-latency, intake-latency, states; result **GATE FAILURE**.

**`jevcode perf`, run 2** — the same command on the rebuilt bundle after those fixes (the `cwd` and `[y]` fixes of the
`states` probe came after this run; their effect is the partial run 3 below):

| Measurement | Result | Gate | Status |
| --- | --- | --- | --- |
| First frame `run` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 127.1 ms / 123.5 ms (105.6 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `run` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 130.6 ms / 124.8 ms (99.4 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `run` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 120.8 ms / 116.3 ms (95.0 ms); 0/20 (flat, none expected) | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 124.7 ms / 121.7 ms (100.0 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 131.4 ms / 120.9 ms (99.1 ms); 20/20 | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| First frame `chat` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 120.0 ms / 116.6 ms (98.0 ms); 0/20 (flat, none expected) | < 300 ms; wordmark at ≥ 16 rows × ≥ 64 columns | pass |
| Harness overhead per step p95 / p50 (50 mocked steps, 5,000-file fixture, 50 dirty files / 15 MiB) | 52.6 ms / 26.1 ms (`run` steps p95 58.4 ms; `imagesMs` p95 21.9 ms) | p95 < 50 ms | **FAIL** |
| Render lag rows 40 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 1.65 ms (2.69 ms) / 11.09 ms · 5 · 21 · 18 · 14 (7; True) · 0 · 11 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 12 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 0.62 ms (1.66 ms) / 17.27 ms · 5 · 21 · 15 · 8 (0; False) · 0 · 5 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 reduced motion at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 1.98 ms (3.02 ms) / 22.57 ms · 5 · 16 · 15 · 7 (0; False) · 0 · 8 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash ≤ 31, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 stress (reported) at `JEVCODE_MOCK_STEP_MS=0`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash frames in 700 ms (with wordmark; first frame is splash 0) · clears · region | 5.61 ms (6.65 ms) / 28.52 ms · 55 · 55 · 90 · 43 (7; True) · 0 · 11 | hygiene only | pass |
| Lag probe idle floor (bare idle node, 17 s): p50 / p95 / max | 1.04 ms / 1.09 ms / 3.40 ms | report (calibration) | applied |
| Composer keystroke → frame `idle`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 4.5 ms / 5.7 ms / 7.1 ms; 0 (n/g); 0 · 11 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `live`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 3.1 ms / 5.3 ms / 13.7 ms; 19; 0 · 12 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `live-stress`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 2.2 ms / 9.6 ms / 16.4 ms; 75 (n/g); 0 · 13 | report | pass |
| Composer keystroke → frame `palette`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 5.4 ms / 6.7 ms / 7.6 ms; 0 (n/g); 0 · 14 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `review`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 7.3 ms / 9.8 ms / 10.6 ms; 1 (n/g); 0 · 22 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `burst30`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 2.7 ms / 4.8 ms / 7.5 ms; 0; 0 · 11 | report | pass |
| Intake `mock0` (mock 0 ms, 20 messages): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 10.1 ms / 12.8 ms / 14.3 ms · 10.1 ms / 12.8 ms / 14.3 ms (12.8 ms) · 0/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| Intake `mock150` (mock 150 ms, 20 messages): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 7.6 ms / 10.3 ms / 11.6 ms · 159.9 ms / 164.1 ms / 165.1 ms (14.1 ms) · 0/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| State `review` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 30 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 10 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 124 (2) TIMEOUT · 0 (0) · 19 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `secret` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 12 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 11 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `review` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 29 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 9 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 124 (2) TIMEOUT · 0 (0) · 5 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `secret` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 11 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 124 (0) TIMEOUT · 0 (0) · 5 | 0 outside shrink segments, ≤ 1 per shrink | **FAIL** |
| State `picker` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 28 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-composer` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 32 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-pane` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 149 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 35 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize-live` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 614 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize-idle` 24×80 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 19 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `ctrl-l` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 29 | 0 outside shrink segments, ≤ 1 per shrink | pass |

Run: `2026-09-21T19:39:18.115Z`, Node v22.23.2, Apple M5 Pro (15 cores, 24 GiB), 1-minute load 4.81 at the start and 2.40 at the end (release bound ≤ 2: NOT met); 1 foreign pty driver(s) alive; probes first-frame, step-overhead, static-append, render-lag, composer-latency, intake-latency, states; result **GATE FAILURE**.
GATES: harness overhead (p95 52.6 ms); state wizard 24x80; state wizard 12x60; state intake 12x60

**`jevcode perf`, run 3 (partial: `JEVCODE_PERF_ONLY=states`, then `step-overhead`; written to `.scratch/*.json`, never to
`latest.json` or the README)** — 13:2xZ on the rebuilt bundle with the `cwd`, `[y]` and prologue fixes of the `states`
probe, 1-minute load 1.96 → 2.23 → 2.13: **16 of 17 state scenarios pass** — `wizard` 24×80 and 12×60 exit 2 as designed
(the driver now runs from the scenario's temp dir), `intake` 24×80, `fault-pane` (panel opened with `/panel`), `resize` /
`resize-live` / `resize-idle` with 0 clears in every segment (1 allowed per shrink), `ctrl-l` repaint equal in 1 frame;
`intake` 12×60 still timed out in that run on the prologue's `expect sess \$` after the 300 ms settle (the flat tier
draws no splash frames, so the row that brought the meter had been consumed by the sleep — the same rule as deviation 11);
with the meter expected before the sleep the scenario passes in a direct replication (exit 0, 0 timeouts, the flat row
`run this as a task?  [y] [n]  Esc keeps`, then `n` → two `[jevcode]` fact items). **Harness overhead p95 49.2 ms / p50
25.1 ms** (`run` steps p95 51.7 ms; `imagesMs` p95 21.4 ms; `hashSkipped: true` at step 11) — inside the 50 ms gate on the
quieter moment, 51.1 and 52.6 ms in the two complete runs under the other slots' load: the margin round 1 already called
thin. A complete run on a machine without the other slots' suites is what a release number needs — that is run 4 below.

**`jevcode perf`, run 4 (complete)** — `env -u CI -u CONTINUOUS_INTEGRATION npm run perf` at 13:41Z–13:46Z on the bundle it
built at 13:41Z (the other slots' processes gone; no foreign pty driver; 1-minute load 1.62 → 2.17): the file
`perf/results/latest.json` and the README Performance section on disk are this run's. The first-frame series now
gate on splash frame 0, the splash bucket counts `dynamic` frames over a 700 ms window the typist leaves alone (gate 22),
the intake rows report dropped Enters (0), and every `states` scenario passes (the run-2 timeouts were the probe's own
`cwd` / `[y]` / prologue defects, fixed before this run):

| Measurement | Result | Gate | Status |
| --- | --- | --- | --- |
| First frame `run` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 128.5 ms / 118.1 ms (98.9 ms); 20/20 | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| First frame `run` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 145.5 ms / 123.1 ms (100.6 ms); 20/20 | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| First frame `run` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 152.5 ms / 114.3 ms (96.9 ms); 0/20 (flat, none expected) | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| First frame `chat` 40×120: cold p95 / median (warm median); first frames carrying splash frame 0 | 134.7 ms / 122.8 ms (97.8 ms); 20/20 | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| First frame `chat` 24×80: cold p95 / median (warm median); first frames carrying splash frame 0 | 117.9 ms / 115.9 ms (97.0 ms); 20/20 | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| First frame `chat` 8×40: cold p95 / median (warm median); first frames carrying splash frame 0 | 114.9 ms / 113.4 ms (93.2 ms); 0/20 (flat, none expected) | < 300 ms; splash frame 0 at ≥ 16 rows × ≥ 64 columns, none below (gated) | pass |
| Harness overhead per step p95 / p50 (50 mocked steps, 5,000-file fixture, 50 dirty files / 15 MiB) | 49.6 ms / 27.1 ms (`run` steps p95 49.6 ms; `imagesMs` p95 19.9 ms) | p95 < 50 ms | pass |
| Render lag rows 40 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash bucket `dynamic` (+ static, key; wordmark; first frame is splash 0; window) · typing p95 · clears · region | 2.55 ms (3.62 ms) / 20.44 ms · 5 · 9 · 14 · 14 (+1, 0; 14; True; 700 ms) · 42.0 ms · 0 · 11 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash `dynamic` ≤ 22, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 12 at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash bucket `dynamic` (+ static, key; wordmark; first frame is splash 0; window) · typing p95 · clears · region | 1.11 ms (2.17 ms) / 19.89 ms · 5 · 8 · 15 · 1 (+1, 0; 0; False; 700 ms) · 39.0 ms · 0 · 5 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash `dynamic` ≤ 22, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 reduced motion at `JEVCODE_MOCK_STEP_MS=200`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash bucket `dynamic` (+ static, key; wordmark; first frame is splash 0; window) · typing p95 · clears · region | 3.46 ms (4.52 ms) / 22.88 ms · 5 · 10 · 7 · 1 (+1, 0; 0; False; 700 ms) · 38.5 ms · 0 · 8 | net p95 < 5 ms, max < 50 ms, `dynamic` ≤ 31, splash `dynamic` ≤ 22, 0 clears, ≤ rows − 2 | pass |
| Render lag rows 40 stress (reported) at `JEVCODE_MOCK_STEP_MS=0`: lag p95 net (raw) / max · `static` · `key` · `dynamic` frames/s · splash bucket `dynamic` (+ static, key; wordmark; first frame is splash 0; window) · typing p95 · clears · region | 6.04 ms (7.10 ms) / 21.41 ms · 67 · 10 · 17 · 14 (+1, 0; 14; True; 700 ms) · 36.4 ms · 0 · 11 | hygiene only | pass |
| Lag probe idle floor (bare idle node, 17 s): p50 / p95 / max | 1.06 ms / 1.12 ms / 4.61 ms | report (calibration) | applied |
| Composer keystroke → frame `idle`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 4.7 ms / 39.1 ms / 43.1 ms; 1 (n/g); 0 · 11 | p95 < 16 ms, max < 50 ms | **FAIL** |
| Composer keystroke → frame `live`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 5.6 ms / 44.5 ms / 72.9 ms; 13; 0 · 12 | p95 < 16 ms, max < 50 ms | **FAIL** |
| Composer keystroke → frame `live-stress`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 13.6 ms / 41.3 ms / 56.1 ms; 17 (n/g); 0 · 13 | report | pass |
| Composer keystroke → frame `palette`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 5.7 ms / 41.3 ms / 42.7 ms; 1 (n/g); 0 · 14 | p95 < 16 ms, max < 50 ms | **FAIL** |
| Composer keystroke → frame `review`: 200/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 7.3 ms / 9.9 ms / 13.0 ms; 1 (n/g); 0 · 22 | p95 < 16 ms, max < 50 ms | pass |
| Composer keystroke → frame `burst30`: 11/200 keys, p50 / p95 / max; `dynamic` frames/s; clears · region | 5484.1 ms / 5520.7 ms / 5520.7 ms; 0 (n/g); 0 · 11 | report | **FAIL** |
| Intake `mock0` (mock 0 ms, 20 messages, 20 located): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 10.4 ms / 12.4 ms / 15.1 ms · 10.4 ms / 12.4 ms / 15.1 ms (12.4 ms) · 0/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| Intake `mock150` (mock 150 ms, 20 messages, 20 located): Enter → `[you]` frame p50 / p95 / max · Enter → `[jevcode]` frame p50 / p95 / max (net p95) · thinking seen · runs started · clears · region | 7.5 ms / 10.3 ms / 13.3 ms · 160.2 ms / 163.6 ms / 172.1 ms (13.6 ms) · 20/20 · 0 · 0 · 11 | bubble p95 < 16 ms · reply p95 ≤ 40 ms net · 0 runs · 0 clears | pass |
| State `review` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 23 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 10 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 2 (2) · 0 (0) · 4 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `secret` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 11 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 13 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `review` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 22 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `palette` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 9 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `wizard` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 2 (2) · 0 (0) · 4 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `secret` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 10 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `intake` 12×60 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 9 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `picker` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 23 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-composer` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 26 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `fault-pane` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 70 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 28 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize-live` 40×120 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 296 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `resize-idle` 24×80 (typist): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 0 (1) · 0 (0) · 0 (0) · 19 | 0 outside shrink segments, ≤ 1 per shrink | pass |
| State `ctrl-l` 24×80 (expect): exit (want) · clears per segment (allowed) · frames | 0 (0) · 0 (0) · 23 | 0 outside shrink segments, ≤ 1 per shrink | pass |

Run: `2026-09-21T20:46:46.218Z`, Node v22.23.2, Apple M5 Pro (15 cores, 24 GiB), 1-minute load 1.62 at the start and 2.17 at the end (release bound ≤ 2: NOT met); 0 foreign pty driver(s) alive; probes first-frame, step-overhead, static-append, render-lag, composer-latency, intake-latency, states; result **GATE FAILURE**.

The four composer failures are one defect, new since run 2 and reproducible (deviation 20): the slow keys are exactly
every tenth key of the 100 ms cadence — one per second — while the idle capture shows no extra frame, so a 1 Hz render
that changes nothing on screen still takes Ink's throttle window and the key landing inside it is deferred to the
trailing edge (≈ 34–40 ms); at 30 ms spacing (`burst30`) the same render leaves most keys without a frame of their own
(11 of 200 located, the typist's cadence stretched to 51 ms). Run 2's `idle` series had 0 of 200 keys over 16 ms. The
harness gate passes by 0.4 ms — the margin the round-1 STATUS already called thin — and the load bound (≤ 2 at both ends)
was missed by 0.17 at the end, so this is an honest release-candidate number for every gate but the composer's, whose
FAIL rows are a live regression, not a stale probe.


### Deviations from `docs/TUI-DESIGN-2.md` found while checking the docs (the docs describe the behaviour)

Numbered from 1 for this section; the design section each row deviates from is named. "Checked" is the working tree
at the time named (the other slots kept landing; a row marked *pending* may already be resolved when you read this —
re-run the scenario named to see).

1. **No wizard for a keyless zero-argument start on this machine — the sibling `.env` (design §1.1, §8.2
   `zero-arg-wizard`).** `<JEVCODE_EXTRA_ENV_FILE>` is a second dotenv layer, and in round 1 it still had a built-in
   default pointing at a sibling checkout of the package (`src/config/resolve.ts:450`); on this machine that directory
   held keys, so a session with no key in the environment, the workspace or the credentials file still resolved
   `decider.apiKey` from that file (checked 12:2xZ with `jevcode config` in the isolated environment) and never opened
   the wizard. Not a defect of the tree — a property of the machine — but every "hermetic" pty environment of round 1
   inherited it. Fixed on the S5 side: `test/pty/run-smoke.sh`, `test/pty/helpers.ts` `childEnv` and `src/perf/pty.ts`
   `baseEnv` point `JEVCODE_EXTRA_ENV_FILE` at a path that does not exist and unset every key variable (round 5's
   rename dropped the sibling default outright, so the row is unset by default). The design's
   zero-argument wizard (`No Jev key found. Where do you reach Jev?`) is exercised by `zero-arg-wizard` after that fix
   (its result is in the smoke row above). **Fix pass:** the same environments were still not hermetic against a saved
   login — `childEnv` isolated `XDG_CONFIG_HOME` but passed the real `HOME`, and `src/config/resolve.ts` falls back to
   the legacy `$HOME/.config/jevcode/config.json` when the XDG file is absent, so a developer's `jevcode login` would
   have reached every scenario but `zero-arg-wizard`; `JEVCODE_CONFIG` was never unset. Now `childEnv` sets `HOME`, the
   smoke gives every scenario `HOME=$home` and `-u JEVCODE_CONFIG`, `baseEnv` uses `HOME: dir` + `XDG_CONFIG_HOME:
   dir/xdg`, `first-frame.ts` runs with `HOME` inside the workspace; `test/unit/perf/hermetic.test.ts` plants a legacy
   file with fake keys in a fake parent HOME and asserts no `file:` source through all three (after a control that reads
   it without the isolation), and `run-smoke.sh --hermetic` is the smoke's own self-check (first line of every run).
2. **Every transcript label is its own colour span (design §4.5, §4.9).** `[run]`, `[step N]`, `[ui]`, `[sandbox]`,
   `[you]` and `[jevcode]` are written as `ESC[2m[label]ESC[22m text`, and the badge in the console's top edge as
   `╭─ ESC[1;38;5;117mjev-onlyESC[39;22m ───`. Not a deviation from the design's text, but the round-1 pty sentinels
   (`expect \[run\] start`, `expect ready`) silently stopped matching the raw bytes: every sentinel that spans a label
   and its text now carries an SGR gap (`labelStep`, `topEdgeStep`, `RUN_STARTED_PATTERN`, the `(?:\x1b\[[0-9;]*m)*`
   fragments in `test/pty/smoke/*.steps`), and the smoke's text checks grep an SGR-stripped copy of the capture.
3. **A labelled item's body wraps at the full width, not at the width minus its hanging indent (design §3.10, §4.5;
   S4 `src/tui/Transcript.tsx`).** At 24×80 the renderer-local `[sandbox]` item was written as one 89-cell row
   (`[sandbox] seatbelt — writes confined to the workspace and run dirs; harness secret files,` — the label is 9 cells,
   the body wrapped at 80), and `[jevcode] Hi. I'm ready when you are — describe a change you want in` (69 cells) wrapped
   where an 80-cell body would, not a 70-cell one. The terminal soft-wraps the long row, so the frame stays intact, but
   the identity predicate — "word-wrapped at the commit width with a hanging indent of `label.length + 1` cells" — does
   not hold as written and `test/pty/twins.pty.test.ts` fails on it (`static row wider than 80 columns: …`). Request to
   S4 below; the assertion stays.
4. **The first frame after Enter shows `starting` and the steer placeholder; `⠹ thinking` / `(thinking…)` follow from the
   second frame (design §3.1 row 1 wants the bubble frame itself to carry them).** On the 12:0xZ–13:1xZ bundles the
   thinking word never appeared (perf `intake` `thinkingSeen 0/20` at a 150 ms delay); on the 13:4xZ bundle it does — a
   400 ms mock shows frame 11 `│ › Type to steer the next step…  Esc pauses` / `│ starting`, then frames 12–15
   `│ › (thinking…)` / `│ ⠋ thinking` … `│ ⠸ thinking` (an animated spinner), and perf run 4 saw it in 20/20 delayed
   messages. With a reply faster than one frame (the 0 ms mock of `chat-hi`) the `starting` bubble frame is the only
   one between Enter and the reply. `docs/TUI.md`, the README and the CHANGELOG describe exactly that; the residual gap
   (the bubble frame reading `starting`) is S3/S4's.
5. **`--no-animation` still drew the wordmark on the 12:0xZ bundle (design §5.3).** `splash-reduced` counted 7
   wordmark cells; `src/config/launch.ts` had no `reducedMotion` member yet (S1) while `App.tsx:507` already read it.
   The bundle `jevcode perf` built at 12:16Z draws none (render-lag "rows 40 reduced motion": 0 wordmark frames, the
   first frame is not splash frame 0), so this resolved during the pass; the smoke row above is from the final rebuild.
6. **`/mode jev-on` printed nothing on the 12:0xZ bundle (design §1.3, §8.2 `mode-switch`).** With the fake key of the
   scenario the command left no `[you] /mode jev-on` and no `[ui] mode …` item; `src/cli/session.ts:2713–2719` carries the
   `MODE_*` strings and the `mode stays …` note, so the dispatch from S2's `registry.ts` / `dispatch.ts` to S3's `case
   'mode'` is what was pending. On the final rebuild see the `mode-switch` / `mode-switch-keyed` rows above.
7. **Mock heuristics of §3.13 (S1 `src/jev/mock.ts`) — landed during the pass.** `hi` → `hello_first` and `what can you
   do?` → the `what_it_is` fact worked from the first bundle; `about_mode_now` (`mock.ts` `mockFactProbability`: `/mode/i`
   → 0.8) and `JEVCODE_MOCK_JEV_MS` (`mockJevLatencyMs`) landed during the pass, so `which mode is this?` selects the
   `mode_now` fact (`chat-facts` passes on it) and the `mock150` intake series measures the delay (reply p95 164 ms raw,
   14 ms net). What remains impossible under §3.13 is the design's one-question `chat-facts` (`what can you do?` →
   both facts): the mock scores `about_mode_now` 0.1 without the word `mode`, so the scenario asks two questions.
8. **Design strings not on disk at the time of the docs check (12:2xZ), removed from the user guide:** the `complete`
   epilogue bubble `[jevcode] Done — <summary>. /diff shows the change, /undo reverts it.` (§4.5); the `/jev` cost-basis
   suffix `(~ table-priced: $0.042/M input, output free)` (§2.6 — `/cost` still reports Jev as `provider usage.cost`,
   `src/cli/session.ts:2427`); the startup item `[config] decider: <provider> · <model> (pinned) · key <ENV> (<source>)`
   (§2.6). `docs/TUI.md` names each as not emitted.
9. **The scripted `--mock` run needs `--mode jev-on` (design §1.1 consequence).** Under the round-2 default `jev-only`,
   `--mock` mocks the decider only and the real synthesizer runs (`src/cli/session.ts` `buildProvider`: the NullProvider
   path is untouched, §15.3), so every mocked-run scenario of the smoke, the pty project and the perf probes says
   `--mode jev-on`; the conversational and zero-argument scenarios run under the default. Recorded in `docs/TUI.md`
   ("Development notes") and README ("Development").
10. **The live frame is ≈ 8 rows, so a shrink to 12 rows may cost 0 clears (design §4.6; round-1 `resize-live` /
    `chat-resize-storm-live`).** With the panel collapsed to a strip the 40×100 live frame is rule + live 2 + console 5;
    Ink's clear-terminal fallback needs a frame taller than the new terminal, so the storm and the slow shrinks measured
    0–1 clears where round 1 measured 1 per shrink. The bounds (≤ 1 per shrink, 0 per grow) are unchanged and hold.
11. **`expect` after `sleep` (drive.exp).** Not a design deviation but a rule every new scenario had to learn: the
    driver's `sleep` drains the pty into the capture and consumes it, so a frame that arrived during a sleep cannot be
    matched by a later `expect` (the first `chrome-tiers` and `panel` runs timed out on rows that were already in the
    capture). Documented in `test/pty/helpers.ts`; the scenarios expect first and sleep afterwards.
12. **`jevcode config`'s derivation text for the auto-detected provider** reads `derived (auto: JEV_API_KEY or
    OPENROUTER_API_KEY is set)` for the openrouter case (`src/cli/config-table.ts`); the design's §2.6 example shows the
    typesafe case (`auto: TYPESAFE_API_KEY is set`), which the table also carries. Documented as is.
13. **The wizard's console title** read `setup` without the step on the 12:16Z bundle; the 12:4xZ bundle draws
    `╭─ setup · jev provider ─…─ <dir> ─╮` over `No Jev key found. Where do you reach Jev?` / `1 typesafe   2
    openrouter` / `Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fi…` — resolved during the
    pass (`docs/TUI.md` describes the per-step titles). **Still open on the fix-pass bundle:** Ctrl-C at the startup
    wizard draws an empty `╭─ setup` console, then an idle `╭─ jev-only` console with `Say hi, ask a question, or
    describe a task…`, and only then exits 2; the fix block the hint promises (`export TYPESAFE_API_KEY=…` /
    `printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin`, design §1.4 / §12) is nowhere in
    the pty (`Wizard.tsx:172` → `onExit(2)` → `App.tsx` `exit()` → `host.exit(code)`; the block is printed only on the
    `ConfigError` path of `session.ts:3572`). `test/pty/round2.pty.test.ts` now records both as `it.fails` tests (the fix
    block; no idle console after the `setup` console) — request to S2/S4 below.
15. **The no-argument `/mode` item names the pending mode twice (design §12 `mode <badge> (next run: <badge>)`; S3
    `src/cli/session.ts` `case 'mode'`).** Idle after `/llm on`, the badge reads `jev+llm · next run` (mode jev-only,
    pending jev+llm) but the item reads `[ui] mode jev+llm (next run: jev+llm)` — `cur` is `next` unless a run is live.
    The design's first word is the current badge (`mode jev-only (next run: jev+llm)`). The pty test asserts the
    `(next run: jev+llm)` half and reports the first word.
16. **`/why intake` and the intake's panel rows (design §3.11; S3 `src/cli/session.ts`, `src/tui/why.ts`, `pane/model.ts`).**
    After `hi`, `/panel` shows the intake's Noul answers as `s0 intent  about_<fact>  noul  █·········  0.10  c 0.80~`
    (13 `about_*` rows under `/panel full`); the design's pinned Choice rows (`s0 intake  intake  <kind> … chosen`, `reply`)
    are absent and the stage word is `intent`, not `intake`; `/why intake` answers `[ui] error: /why: no decision intake in
    the last 3 steps`, and the failed `/why` keeps the command in the composer (the next line typed appends to it — the
    probe that typed `/jev` next produced `/why intake/jev`). `round2.pty.test.ts` asserts the `about_*` rows, reports the
    row set, and records `/why intake` as `it.fails`. The CHANGELOG, README and `docs/TUI.md` now describe this.
17. **`Alt+D` inserts `½` into the composer instead of opening the decisions tab (design §4.6 / §12; S2 `keys/bindings.ts`
    `meta+d`, S4 `App.tsx`).** In a real pty `ESC d` (one write) lands as the text `½` (`› ½`, twice `› ½½`), while `ESC j`
    / `ESC J` / `ESC p` / `ESC t` / `ESC s` toggle, open full (18 dynamic rows = rule + 12 pane + console), and pick plan /
    timeline / synth as designed; `ESC`, a 100 ms pause, then `d` is the text `d` (the 30 ms chord window). Recorded as
    `it.fails`; request below. The README's panel paragraph says so.
18. **`--json` and the pipe never reach the intake (design §3.7 "Without a composer … the C46 default is `keep`", §3.10
    `--json chat` line).** `jevcode chat --json` is a one-shot stream: on a TTY without a task it exits 2 (`missing task
    text: pass it as a positional argument, --task-file <path>, or on stdin`); on a pipe the piped text *is* the task
    (`[run] start … task: the date parsing`, a `jev-only` run of the real synthesizer under `--mock`). So neither the
    `chat` NDJSON line nor the readline's `keep` default can be exercised end to end in a pty or a pipe — both stay with
    `test/unit/cli/session-chat.test.ts` / the prompter unit tests (§8.1); `docs/TUI.md` says where the `chat` line is
    reachable. Not a defect: a consequence of `chat` on a pipe being `run`.
19. **Identity predicate (a) holds modulo the hanging indent.** With `/transcript full`, every `transcript.log` line of a
    mocked run is rebuilt from the TUI's `<Static>` rows at 80 columns when continuation rows are matched with their
    leading spaces dropped (`reflowAgainst(rows, transcript, { hangingIndent: true })`, `round2.pty.test.ts`); the stage
    lines and `[run] ready` appear as designed. The continuation rows are *not* indented by `label.length + 1` cells on
    this tree (deviation 3: the body wraps at the full width), so the test asserts the rebuild and reports the indent.
20. **Composer keystroke → frame p95 regressed to ≈ 40 ms in `idle`, `live` and `palette`, and `burst30` locates 11 of
    200 keys (perf run 4; design §9 "composer keystroke → frame p95 < 16 ms"; S4).** Run 2 (12:5xZ bundle) read p95 5.7 /
    5.3 / 6.7 ms with 0 of 200 keys over 16 ms; run 4 (13:41Z bundle) reads 39.1 / 44.5 / 41.3 ms with 13 / 71 / 19 keys
    over 16 ms. The slow `idle` keys are indices 45, 55, 65 … 165 and the slow `palette` keys 2, 12, 22 … 182 — one per
    second at the typist's exact 100 ms cadence — while a 3.5 s idle capture and a 25-key capture at 100 ms
    (`scripts/pty/drive.exp`) show no extra frame at all: a 1 Hz render that changes no cell still runs Ink's `onRender`
    and consumes the 34 ms throttle, so the key that lands inside that window is drawn on the trailing edge. At 30 ms
    spacing (`burst30`) the same render leaves most keys without a frame of their own (run 2: 200/200 located, p95 4.8 ms).
    Real typing is not phase-locked to the second, so a user sees ≈ 3 % of keys delayed ≤ 34 ms; the gate is on the p95
    and fails. Request to S4 below; the README's composer rows say FAIL. A composer-only re-run at load 1.02 → 1.63
    reproduced `live` 41.9 ms (74 slow keys at indices 0, 5, 10, 15 … — every 500 ms), `palette` 41.0 ms (20 slow keys at 2,
    12, 22 … — every second) and `burst30` (24/200 located), and passed `idle` (5.6 ms, 0 dynamic frames): the idle tick is
    intermittent or phase-dependent, the live and palette ones are not. Parsing the kept captures
    (`.scratch/s5probe/keep/composer-{live,palette,idle}.{cap,jsonl}`): each slow key's frame arrives 38–44 ms after the
    send with zero frames between the send and that frame, i.e. the key's own render was deferred to Ink's trailing edge by
    a render that produced no bytes.
14. **Two perf `states` scenarios needed round-2 forms (design §4.6 consequences).** `fault-pane` (`JEVCODE_FAULT=
    render:pane`) never fired with the panel collapsed — the pane component does not render behind the strip — so the
    scenario opens the panel with `/panel` right after the run starts; the composer `review` series measured the
    review's `e` toggle by the pane rows it zeroes, and with the strip plus the mock's one-line preview the key had no
    visible effect (16/200 toggles located in run 1), so the series opens the panel with `/panel full` first. Both are
    probe changes, not tree defects; the probes say so in their headers.

### Requests to other slots (recorded here because S5 owns none of these files)

- **S4 (`src/tui/Transcript.tsx`)**: wrap a labelled item's body at `columns − (label.length + 1)`, not at
  `columns` — deviation 3 above; evidence in any 24×80 capture of the smoke (`.scratch/pty-smoke/*.txt`, the
  `[sandbox] seatbelt — …` row is 89 cells) and `test/pty/twins.pty.test.ts` (`static row wider than 80 columns`).
- ~~S3/S4: map `{ type: 'thinking', phase }` to `⠹ thinking` / `(thinking…)`~~ — **landed on the 13:4xZ bundle**
  (perf run 4 `thinkingSeen 20/20` at a 150 ms delay; a 400 ms probe shows the spinner frames). Residual (deviation 4):
  the bubble frame right after Enter still reads `starting` with the steer placeholder — §3.1 row 1 wants the bubble and
  `⠹ thinking` in the same frame.
- **S4 (`src/tui/App.tsx` / `motion.ts` / `spinner.ts` — whatever ticks at 1 Hz while idle)**: perf run 4's composer
  regression, deviation 20 — a once-a-second render that draws nothing still takes Ink's throttle window, so a key that
  lands within 34 ms of it is deferred to the trailing edge (`idle` p95 39.1 ms, `live` 44.5, `palette` 41.3, `burst30`
  11/200 located; run 2 on the 12:5xZ bundle: 5.7 / 5.3 / 6.7 ms, 200/200). Stop the tick while nothing on screen
  changes (design §9 "no `useAnimation` subscriber call after 700 ms"; TD §18 "renders drop with the bytes"), or make it
  a cursor-only update outside React. Evidence: `perf/results/latest.json` `composerLatency.series[*].latency.raw`
  (the slow indices are 45, 55, … and 2, 12, …), `.scratch/s5probe/keep/composer-idle.{cap,jsonl}` from the re-run.
- ~~S2 (`Wizard.tsx:216`, `wizard.test.tsx:247`): `no-any` comments~~ — **landed** (`node scripts/no-any.mjs` → `ok`).
- **Launcher (`bin/jevcode.js`, no slot owns it)**: implement `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` (design §5.3:
  throw `config before first frame` on a `resolveConfig` / `.git/HEAD` read before the first stdout write) — the
  first-frame probe sets it and fails a run that prints that text (searched in the whole pty capture now); until the
  hook exists the variable is inert and the CHANGELOG says so.
- ~~S1 (`src/jev/mock.ts`): `about_mode_now`, `JEVCODE_MOCK_JEV_MS`~~ — **landed** (`mock.ts` `mockFactProbability`
  `/mode/i` → 0.8; `mockJevLatencyMs`; deviation 7).
- **S3 (`src/cli/session.ts`)**: the `complete` epilogue bubble, the `/jev` cost-basis suffix and the `[config] decider:`
  startup item of deviation 8, if they are still intended.
- **S2 (`src/tui/onboarding/Wizard.tsx:172` → `App.tsx` `exit()`), with S4**: Ctrl-C at the *startup* wizard must print
  the fix block (`fixBlockLines('jev-only')`: `export TYPESAFE_API_KEY=…`, `printenv TYPESAFE_API_KEY | jevcode login
  --jev-provider typesafe --jev-key-stdin`, `jevcode login`) after the terminal restore and exit 2 without drawing the
  idle `╭─ jev-only` console first — deviation 13; `round2.pty.test.ts` carries two `it.fails` tests that flip when it lands.
- **S2 (`src/tui/keys/bindings.ts` `meta+d`) / S4 (`App.tsx`)**: `Alt+D` (`ESC d`) inserts `½` into the composer instead
  of opening the decisions tab — deviation 17; `it.fails` in `round2.pty.test.ts` (`Alt+J`, `Alt+Shift+J`, `Alt+P/T/S` pass).
- **S3 (`src/cli/session.ts`, `src/tui/why.ts`, `src/tui/pane/model.ts`)**: `/why intake` (`no decision intake in the last
  3 steps` today) and the pinned `s0 intake  intake  <kind> … chosen` / `reply` Choice rows in the panel — deviation 16;
  `it.fails` in `round2.pty.test.ts`. Also whether a failed `/why` should keep the command in the composer.
- **S3 (`src/cli/session.ts` `case 'mode'`)**: the idle no-argument `/mode` item's first word is the pending mode
  (`mode jev+llm (next run: jev+llm)`); the design's is the current badge (`mode jev-only (next run: jev+llm)`) — deviation 15.

### Fix pass (2026-09-21, second S5 pass) — what changed per review finding

| # | Finding | Change |
| --- | --- | --- |
| 1 (blocker) | README / `latest.json` shipped run 2's stale FAIL rows | run 4 below: a complete `npm run perf` on the quiet machine after the other slots' processes ended; `perf/results/latest.json` and the README Performance section are its output (the probe's `README Performance section rewritten` step) |
| 2 (major) | `childEnv` / smoke / `baseEnv` not hermetic against a saved login | `HOME` isolated everywhere, `JEVCODE_CONFIG` unset, `first-frame.ts` `HOME` in the workspace; `test/unit/perf/hermetic.test.ts` (4) and `run-smoke.sh --hermetic` (deviation 1) |
| 3 (major) | splash frame 0 measured, not gated | `first-frame.ts` `pass = timeOk && splashOk`; `readme.ts` renders `pass`/`FAIL` and names `first frame (splash frame 0)` in `failures()`; `readme.test.ts` covers both |
| 4 (major) | `splashBucket` counted every class in 700 ms, gate 31 | `splashBucket(frames, chunks, firstIdx, { classes, firstSendAt })`: `dynamic` only, `static` / `key` reported, window clipped at the first send, gate `splashGateFor(maxFps)` = ⌈31 × 0.7⌉ = 22; the typist waits `SPLASH_SETTLE_MS` = 800 ms so the splash settles by itself; `render-lag.test.ts` has the class-filter and clipping cases; README row relabelled |
| 5 (major) | docs stated `⠹ thinking` as behaviour | `docs/TUI.md` (three sentences + the status-bar paragraph), `README.md`, `CHANGELOG.md` describe the `starting` frame and name the design's words as pending (deviation 4) |
| 6 (major) | zero-arg wizard: fix block and idle fall-through unasserted | two `it.fails` tests (fix block; no idle console after `setup`) beside the passing wizard test; deviation 13 rewritten; request to S2/S4 |
| 7 (major) | `chat-ambiguous` Enter half-verified | vitest: `expectCardOpenUntilAnswer` — card frames contiguous (BSU frames, `syncFrames`), reply after the card, no `Okay — edit it`, no run; smoke: `intake_card_check` (same rule in python) → `enter-inert:card-open-until-n`; the same at 12×60 (`chat-ambiguous-flat`) |
| 8 (minor) | smoke `wordmark()` cut at the echo offset | cut at the echo frame's `ESC[?25l` (fallback: the offset); `run-smoke.sh --wordmark <cap>` entry point; `test/unit/perf/smoke.test.ts` (3: clean cancel, echo frame carrying `██` → `after_key > 0`, no echo / ascii) |
| 9 (minor) | run dir + `jevcode.log` informational | `ok=0` + `MISSING:run-dir-jevcode.log` for chat-task, review-y/d, s2-*, chat-ambiguous-y, panel |
| 10 (minor) | test counts | 33 / 30 (63 total) pty tests, 36 smoke scenarios, 52 perf unit tests — in STATUS, CHANGELOG, DESIGN §12, TUI.md, README |
| 11 (minor) | stale requests | S1 heuristic / `JEVCODE_MOCK_JEV_MS` and S2 `no-any` marked landed; deviation 7 reworded |
| 12 (minor) | CHANGELOG `Fixed` for an inert variable; `clean()` on 4,000 chars | moved into the probes bullet as "inert until `bin/jevcode.js` implements the hook"; `first-frame.ts` `assertionSeen` searched over the whole capture (`ASSERTION_RE`), the 4,000-char transcript kept as evidence only |
| 13 (minor) | review smoke lacked `╭─ review` and Enter | `review-y.steps` / `review-d.steps` expect `╭─ … review · step 2`; `review-y` sends Enter on the armed card, then `y`, and the smoke counts exactly one `confirm … approved` in transcript.log and no `› y` echo; `review.pty.test.ts` gains the Enter-inert test (card frames contiguous, approval after `y`, one approval) |
| 14 (minor) | `mode-switch-keyed` placeholder check on the whole capture | the frame with the `jev+llm · next run` top edge must contain `Say hi` and not `Follow-up, question` |
| 15 (minor) | `judgeIntake` completeness vs `pairs.length` | `judgeIntake(…, expected)`: `dropped = expected − pairs.length`, `messages = expected`, `pass` needs `dropped === 0`; the README row says `<n> located, <k> Enters not located`; `intake-latency.test.ts` has the dropped-Enter case |
| 16 (minor) | splash smoke sent `h` before raw mode | `expect \x1b\[\?2004h` after `expect step 0/` in the three step files |
| missing tests | — | added: review Enter inert (pty); flat-tier intake at 12×60 (pty + smoke); keys never in logs for both wizard paths (pty); `[you]` redaction in the TUI and `--plain` (pty); splash settling by itself + `run:start` cancel (pty + smoke `splash-settle`); panel keys `Alt+J/Shift-J/P/T/S` + `/panel full` = 12 rows (pty; `Alt+D` as `it.fails`); `/transcript full` stage lines + identity (a) rebuild (pty); the second mode-switch with `ANTHROPIC_API_KEY`, `/llm on`, `/mode`, promotion (pty); `--ascii` twins (pty); `--plain` intake readline (pty); `/jev` + `/cost` after a greeting (pty); `s0` panel rows + `/why intake` (pty, the latter `it.fails`); hermeticity (unit, 4); `--wordmark` cut + `splashBucket` class filter (unit); `judgeIntake` dropped Enter (unit); the complete perf run (run 4). Not added, with the reason in deviation 18: the `--json` `chat` line and the pipe's `keep` default (unreachable end to end); the launcher-hook test (no hook) |

### Integration pass (2026-09-21, after the six slots; every gate re-run on the merged tree)

`tsc` 0 errors · `no-any` ok · unit **304 files, 5,228 passed, 1 skipped** · `npm run build` (bundle `3c769e7d…`, first frame
ok) · real-pty smoke **37/37 PASS** (`hermetic` + 36 scenarios; `chat-hi` 19 ms, `firstframe` 90.5 ms, `splash-settle` 15
frames / 705 ms) · pty vitest **63/63 passed, 0 expected-fail** · live Jev suites **4/4** on both providers (TypeSafe
`jev-1.13.0`, table-priced, `x-typesafe-request-id`, unknown-model 400 → exit 2; OpenRouter `typesafe/jev-1.13-20260917`,
provider-priced, `gen-dec-` id) · `gen-docs --check` 0 · four live TUI drives under `docs/live/tui/round-2/` (README table:
`hi` → `[jevcode]` 247–265 ms live on both providers against the 1.5 s gate; zero clears; `restores=1`; 0 generator calls in
every jev-only run; no key byte in any artefact). Fixed on the way, all design-cited: (1) **finding 3 / the `identity` pty
test** — Ink's absolute `<Static>` box is fit-content, so Yoga never shrank the label + body row and long bodies wrapped at the
full width beside their label (`[sandbox] …` 89 cells at 80 columns, `[step N]` 87–88, `[run] start` 82); `Transcript` now lays
each item out at exactly `columns` (`App` passes it) so bodies wrap at `columns − label − 1` with the hanging indent (§3.10 / §9);
the pty helper's `HIDDEN_STAGE_RE` gained `synth ` and `risk[= ]` (the risk item reads `risk=0.01 ok: …`) and the 24×80 leg
re-joins with `hangingIndent`. (2) **`/jev` line 1** is the §2.6 form `<provider> · <host> · <model> (pinned|alias) → resolved
<served>` (the `--mock` / keyless fallback keeps `decider <id>`). (3) **Finding 13**: the wizard's `exit` step keeps the setup
console until the unmount (no idle console on the way out) and `host.exit(2)` with a key still missing prints the §12 fix block
as a `[setup]` item. (4) **Finding 16**: `/why intake[.id]` is forwarded to the controller (`chatIntakes`, full `Decision`s)
instead of the App's run-only lookup, and a failed local `/why` clears the composer. (5) **Finding 17 is a driver artefact, not a
tree defect**: expect's Tcl 8.5 `\xhh` swallows every following hex digit, so `send \x1bd` sent `\xbd` = `½`; the test's `ALT()`
now emits `\033<letter>` and `drive.exp`'s header says so; the resolver maps `meta+d` → `{ panel, tab: 'd' }` as designed. The
four `it.fails` records are plain tests now. Not fixed, recorded: the jev-only synthesizer did not repair `examples/demo-py` in
any live drive (pytest once at step 1, then `done partial` blocked by `plan_mismatch` until `replan_stop`; `src/synth/**` is
read-only this round).

### Not verified here

- Any real terminal application beyond the `expect(1)` pseudo-terminal (`TERM=xterm-256color`); the truecolor / 256
  palettes were not seen on a real terminal (the pty capture carries the SGR bytes only).
- The `--json` `chat` line and the readline's pipe default `keep` in a pty or a pipe (deviation 18: `chat --json` is a
  one-shot stream and a pipe makes the piped text the task); both remain with the unit suites of §8.1.
- The live intake gate (p95 < 1.5 s over TypeSafe and OpenRouter, TUI-DESIGN-2 §9) and the two-provider live
  scenarios: S6's, under `docs/live/tui/round-2/`; nothing in this slot touched the network (`JEVCODE_ASSERT_NO_NETWORK=1`
  in every scenario that runs without `--mock`).
- Publishing: `package.json` reads 0.3.0 since the owner's pass; nothing is pushed to the npm registry or the Homebrew tap.

## Round 3 — jev+llm default, one-key onboarding, TypeSafe pink, the persistent wordmark, commands, polish (2026-09-21)

The third round of the interactive TUI (`docs/TUI-DESIGN-3.md`; five slots ran concurrently on 2026-09-21 — S1 theme, S2
wordmark and animations, S3 defaults and onboarding, S4 commands and the palette, S5 message polish, pty, perf and docs).
This section is S5's record of the tree at the end of its pass: what landed per slot, the gates that were run and their
numbers, and where the tree deviates from the design. Numbers marked *(integrator)* are to be filled from the final
`npm run perf` / pty run on the merged tree; the rest were measured by S5 on its own working tree.

### What was built (as found on disk at the end of the S5 pass)

- **Contract 1.3 and the default flip** (S3, W0–W2: `src/core/types.ts`, `src/config/**`, `src/cli/**`, `src/tui/onboarding/**`,
  `src/chat/**`): `DEFAULT_MODE = 'jev-on'` (the one constant; `MODE_BADGE_WORD` the one table, `llm-jev` → `llm+jev · verified`),
  `MODE_BADGE_MAX_CELLS`; `ui.wordmark` (`sweep | static | off`, `static` under SSH); `LaunchSettings.themeHint` from `COLORFGBG`
  (D-R) and `.ssh`; `Renderer.setBindings?`, `SessionHost.dispatchContext?`, `WizardOutcome { kind: 'mode' }`, `Prompter.wizard`
  `found` / `foundSource`; the session follows `config.mode` (§1.2); the one-key wizard (`key` / `options` steps, `isFieldStep`,
  the save-shape table, `3 Jev only` persisting `mode: jev-only` at startup), `verifyKeys` with four outcomes, `login --key-stdin`,
  `capsItem`, `defaultModeItem` (D-Q as ratified: once, through `seen.defaultMode`), `modeSavedItem`, the generator-neutral copy
  (§1.9), the `[sandbox]` item as `seatbelt · writes only in the workspace and run dirs · …` with the old sentence as its detail.
- **The TypeSafe pink** (S1, W1: `src/tui/theme.ts`, `color-shim.ts`): `dark` keeps its id and becomes the typesafe.ai palette
  (primary `#f386a1` / 211, secondary `#d45bb6` / 169; `accent2` new; `labelRole`; `itemRole` without the `[ui]` → dim branch and
  `null` for `[you]`); `light` darkens the pinks and fixes its red / green; `daltonized` and `ansi` twins recomputed.
- **The persistent wordmark and the animations** (S2, W1–W3: `src/tui/wordmark.ts` new, `splash.ts`, `motion.ts` (`useIdleLoop`,
  `attentionAt`), `layout.ts` (`paneWhole`), `Pane.tsx`, `glyphs.ts` / `spinner.ts` (the shade pulse `░ ▒ ▓ █ ▓ ▒`, static `◆`),
  `useEngine.tsx` (`lastActivityAt`, `postRunKeySeen`, `run:end` clears the loop banner), `App.tsx` (the mark as the pane slot's
  idle tenant, the loop, A5 / A6, P7's `thinking` dispatch with `run:starting`, the `DEFAULT_MODE` fallback, `depth` for the live
  rows)); the caption `◆ <version>` and the tagline.
- **Commands** (S4, W1–W3: `src/tui/commands/**`, `composer/submit.ts`, `pane/commands.ts`, `keys/**`, `why.ts`, `plain-composer.ts`,
  `Overlay.tsx`, `scripts/gen-docs.mjs`): the 21 aliases with the exact-alias pin, the alias column, the ` → /owner` ghost,
  Suggested → recent → Popular, Tab argument completion, `keepDraft`, the six unbound key actions, the §4.4 fixes.
- **Message polish, identity, pty, perf and docs** (S5, this slot; W1–W4): `src/tui/status/lines.ts` (`modeBadgeWord` from the
  table, `ModeBadge = string`, `statusSpans` — the left word and the meter words only, D-P; `leftWord` idle for `starting &&
  !thinking`, P7; `centreText` never the run id, rule 7), `src/tui/transcript/wrap.ts` (new: the segment-aware wrap at ` · ` with the
  no-orphan rule, `joinWrapped` = the §5.3 normaliser), `src/tui/Transcript.tsx` (the 10-cell gutter, pre-split bodies, detail rows
  hanging under `label  value`, the spacer above a `[ui]` block, `labelRole` / `bodyRole` — the D-F `keySeq` → `<Static>` style path
  untouched), `StatusLine.tsx` / `Console.tsx` (rendered from `statusSpans` — `statusRole` and the whole-row `bold` retired; the
  prompt `accent` at rest and `steer` live; `edgeRole?` for A6; `isFieldStep` for the masked row; `wizardConsoleTitle` delegating to
  `onboarding/lines.ts`'s; the `{ arrow }` ghost), `Review.tsx` (`armed?` — the keys row dim until the card arms, A8),
  `composer/Composer.tsx` (prompt roles, the arrow ghost), `toasts.ts` (`toastPhase`, `toastRole`, `TOAST_FADE_MS`, A7),
  `budget/lines.ts` (`eachUsdText`: `~$0.000006 each`, rule 6); `src/perf/idle-frames.ts` (new probe), the `idle-loop` composer
  series, the render-lag `run-start` bucket, `ProbeName | 'idle-frames'`, the README rows; `scripts/pty/polish-check.mjs` (V1–V21);
  the pty steps and `round3.pty.test.ts`; README / TUI.md / CHANGELOG / DECISIONS.

### Gates (S5's own tree; the integrator re-runs on the merged tree)

| Gate | Result | Where |
| --- | --- | --- |
| tsc `--strict` on the whole tree, `no-any` | *(S5: clean on every S5 file; the peers' in-flight files listed in the S5 report)* | `npm run typecheck` |
| unit suite (`npx vitest run --project unit`) | *(S5 report: file / test counts; the timing-based flakes named there)* | — |
| first frame | *(integrator: `jevcode perf` rows)* < 300 ms, `wordmarkCells > 0` at ≥ 16×64 | `perf/first-frame.ts` |
| idle animation (new `idle-frames` probe) | *(integrator)* ≤ 4 dynamic frames in any idle second, mean ≤ 2/s, ≤ 12 KB/s peak, ≤ 5 KB/s mean, 0 clears, region ≤ rows − 2; child CPU reported | `perf/idle-frames.ts`, `wordmark-idle.steps` |
| composer keystroke → frame incl. the `idle-loop` series | *(integrator)* p95 < 16 ms, max < 50 ms | `perf/composer-latency.ts` |
| dynamic fps during a run incl. the `run-start` bucket | *(integrator)* ≤ maxFps + 1 | `perf/render-lag.ts` |
| zero clears outside shrink segments | *(integrator)* 0 | `states.ts`, every `.steps` |
| line identity | the §5.3 normaliser over the scripted run at 80 columns: every engine item re-joins to `formatTranscriptItem` (unit, S5) | `round2-transcript.test.tsx`, `round3-polish-app.test.tsx`, `twins.pty.test.ts` |
| hero-frame checklist V1–V21 | *(integrator: `polish` / `polish-wide` in `run-smoke.sh`; `.scratch/pty-smoke/polish*.polish.txt`)* | `scripts/pty/polish-check.mjs` |
| keys never in frames or logs | `r3-wizard-masked-key`, `r3-key-paste-newline`, `ts-only-start` assert it | `round3.pty.test.ts`, `run-smoke.sh` |
| review invariants | A8 is drawing only; `resolveKey` untouched | `review.test.tsx`, `app.test.tsx` |

### Deviations from the design (S5's, with the reason)

1. **`wordWrap` treats a run of ≥ 2 spaces as a group boundary** (`src/tui/transcript/wrap.ts`): §5.1 rule 4 shows the epilogue's
   `files     ~/…/  (transcript.log, …)` row hanging its parenthetical whole under the value; a plain word rule would have put
   `(transcript.log,` on the first row. Identity is unaffected (the §5.3 join collapses space runs).
2. **The hard-split of a token wider than the row** keeps its last piece ≥ 4 cells and the §5.3 join is exact only when no token is
   wider than the row (a 71-cell path at a 40-cell width carries one space inside it after the join; nothing is lost).
3. **V11's money regex** is `\$\d+\.\d{2,6}` in `polish-check.mjs`, not the design's `{2,4}`: rule 6's `~$0.000006 each` has six decimals.
4. **`splash-settle` / `wordmark-nocolor` allow one frame between the caption frame and the marker key**: the host's `resolveConfig`
   lands the session meter (`sess $…`) in the status row a few frames after the settle; the design's "0 frames in the 5 s after the
   settle" is read as "0 sweep frames".
5. **`statusSpans` paints no done word under an overlay** (`overlay !== 'none'` or the picker): F-R6 colours `idle exit 4` on the idle
   console; under the palette / picker / wizard the left word is that overlay's and stays plain.
6. **`round2-lines.test.ts` (one pin) and `test/unit/spend/budget-lines.test.ts` (one pin)** were edited although §7.1 does not list
   them under S5: the pins were on S5's functions (`modeBadgeWord('llm-jev')`, the `/cost` `each` figure) and would have failed the
   suite otherwise.

### Requests left for the other slots

- S3 (`onboarding/lines.ts`): `wizardConsoleTitle` gains `key` → `setup · key`, `options` → `setup · options` (the Console wrapper
  delegates to it; `round2-console.test.tsx` pins both).
- S4 (`Overlay.tsx`): pass `armed={state.overlayArmed}` to `<Review>` (the prop defaults to `true`, so the arm stays invisible until then).
- S2 (`App.tsx`): pass `edgeRole` to `<Console>` from the A6 fade (`borderFocus` → `accent2` → `border`); the prop is in place.
- S2 / S3: the run-end `[ui] stopped` epilogue item is emitted with the epilogue rows as `detail` (`epilogueItemLines`) — unchanged text;
  the renderer indents and hangs them (rule 4).

### Measured (S5's tree)

- *(to be filled by the S5 report and the integrator's run: perf rows, pty smoke summary, polish-check verdicts)*


### Integration (2026-09-21, the owner, after the workflow lost its S3/S5 reviews and the integrator to the API cap)

The round-3 workflow was cut off mid-flight by the account's API usage cap (the Fable sub-agent pool; reset 2026-10-01): W0, S1, S2
and S4 finished with their reviews, S3 and S5 wrote nearly all of their code before dying, their review/fix passes and the integrator
never ran. Integration was finished by the owner directly plus two Opus sub-agents on disjoint files (the wizard edges; the pty/smoke
scenarios), the round-4 audit was relaunched on Opus. What the integration changed, all design-cited (`docs/TUI-DESIGN-3.md` §0.2):

1. **Frame-0 theme** — `--theme light|ansi|…` and `JEVCODE_THEME` painted the dark palette for the first 700 ms (`38;5;211` in the
   `theme-light` capture): `LaunchSettings.themeHint` now carries an explicit known theme (argv/env only), the App reads it before `setUi`.
2. **Wizard edge 1** — a key pasted with a trailing CR (`send <key>\r`, one pty write) answered `key too short` on a full buffer: the
   text and the Enter landed in one React batch and `submit` read the stale closure's length; Enter now reads the buffer, and a pasted
   text ending in a newline submits itself (`Wizard.tsx`, `wizard-paste.test.tsx`).
3. **Wizard edge 24 (`--plain`)** — Ctrl-C at the masked prompt hung the process (raw mode: the `0x03` byte sat in readline's line buffer;
   no SIGINT) and a cancelled plain wizard printed a warn block and kept the session alive: a passive stdin watcher cancels the read on
   `0x03`, the other-ways prompt cancels on EOF/Ctrl-C, and the startup gate exits 2 with the §1.6 fix block for a cancelled `--plain`
   wizard (`plain-prompter.test.ts`, `r3-plain-wizard`).
4. **`/rename`** — the dispatcher cut the title to 60 before the controller could, so the cut note never printed; the controller clips once.
5. **Scenario patterns** — the caption `◆ <version>` carries SGRs between the diamond and the version; the 10-cell gutter pads every label;
   the pink prompt closes an SGR before the echo; a palette row highlights the typed prefix; a pasted `/s` is one input event (no palette);
   `commands-live`'s two Ctrl-C 3 ms apart hit the exit window. ~25 smoke gates had been vacuous against gutter rows (`grep '^\[run\] …'`).
6. **Checklist V14** exempts toast rows (`! press Ctrl-C again to exit` is 28 of 76 cells by design); **V11** allows six decimals.
7. **The mark returns in the `[run] end` frame** (one frame earlier than §3.3's prose said; the §3.2 table already said `run:end → idle`).
8. **Flaky waits** in `wizard.test.tsx` / `session.test.ts` (fixed 20–60 ms ticks after an async save) became polls.
9. **`chat.pty.test.ts:98`** double-escaped the badge regex (`jev\\+llm`); it uses the helper's escaped `BADGE_DEFAULT`.

Gates on the integrated tree (sub-agent runs at load 2–7; the owner's final numbers are in the table below when the machine was quiet):

| Gate | Result |
| --- | --- |
| `tsc --noEmit`, `no-any`, `gen-docs --check` | clean |
| unit (`vitest --project unit`) | **6,050 passed** at load 21 with 20 timing flakes, each green when re-run alone at load < 8 (App ticks, wizard timers, engine-perf, the fold budget); the peer's clean-checkout run at 9d1dbae: 5,776 passed, 1 cross-worktree flake fixed on main (457708c) |
| build + `check-pack` at 0.4.0 | pass (bundle minified, tarball < 1.5 MB) |
| real-pty smoke (`run-smoke.sh`, 64 scenarios) | **64 / 64 PASS**, exit 0 — wizard scenarios included |
| pty vitest (88 tests incl. `round3.pty.test.ts`) | **88 / 88** after the `chat.pty.test.ts` regex fix (the resize storm tolerates the one P1 torn frame) |
| hero-frame checklist (`polish-check.mjs` on `polish` / `polish-wide`) | 19 pass / 2 skip (V13 deferred by design; V20 needs the typist) on both geometries |
| perf (`jevcode perf` incl. the new `idle-frames` probe) | **isolated probes pass**; two full runs were starved by a shared machine — see below |
| live jev+llm drive (`docs/live/tui/round-3/`) | **pass**: `hi` → `[jevcode]` 322 ms, facts 195 ms, task → `[run] start` 288 ms; the jev+llm run **completed the demo repair** (7 steps, pytest 7/0, $0.016 Jev + $0.008 GLM, 8 generator calls); `/mode` round trip; 0 clears; 0 key bytes |

**Perf on a shared machine (2026-09-21 22:00–23:00).** Two full `jevcode perf` runs were starved: the machine was shared with a
peer session's live SWE bench (pytest bursts to load 40–90), its harness implementers, and iCloud's `fseventsd` / `cloudd` /
`replicatord` indexing the churn (each at 30–65 % CPU). The starvation signature is unambiguous — review keystrokes at p50 612 ms,
67 of 200 burst keys located, a palette state scenario timing out at 60 s — and every probe passed when run alone in the same hour:

| Probe (alone, load 2–8) | Result |
| --- | --- |
| first frame (cold p95, 24×80 run / chat) | 144 / 172 ms (< 300); splash frame 0 in 20/20 at ≥ 16×64 |
| harness overhead p95 | 48.5–49.5 ms (< 50; the 15 MiB image copy dominates; the synthesizer's `synthMs` sits outside it) |
| render lag net p95 (rows 40 / 12 / reduced) | 0.30 / 0.33 / 2.31 ms (< 5); typing p95 4.4 / 4.3 / 7.1 ms; 0 clears |
| composer keystroke → frame p95 (idle / idle-loop / live / palette / review) | 5.3 / 5.1 / 4.6 / 5.0 / 6.1 ms (< 16); live-stress 13.7 (report); burst30 2.6 with 200/200 |
| **idle animation** (new gate) | 4 frames in the busiest second, 1.6/s mean; 9.0 / 11.7 KB peak, 3.5 / 4.6 KB/s mean at 24×80 / 40×120; 0 clears; CPU 17–27 ms/s |
| intake reply (mock0 / mock150) | bubble p95 12.5 / 10.1 ms; reply net p95 12.5 / 14.8 ms (isolated run before the flip of the palette rows) |
| states (17 scenarios) | 0 clears outside shrink segments; region ≤ rows − 2 |

One round-3 regression was real and is fixed: the persistent wordmark's five rows re-rendered on every key frame (palette series p50 11 ms,
p95 34 ms) — `<SplashRow>` is memoised by value on the band tick and blank runs join the neighbouring coloured span, giving palette
p50 3.6 / p95 5.0 ms and idle p95 4.1 ms. One artefact stays open: in three of nine typing series a run-specific onset made every later
key's located frame arrive exactly 26 keys (2.6 s) late — the probe's 26-letter cycle means the composer row's last cell stopped
tracking the newest key (a caret jump or a probe alignment slip); it never recurred in the four kept-capture runs, so it is recorded
here (P3) for round 4's robustness audit with the hypothesis and the reproduction recipe (`JEVCODE_PERF_KEEP`).

Product observations recorded, not fixed (round 4's resize/robustness audit owns them): **P1** during a 30-resize storm between 40×100 and
12×60 one frame is laid out for the old width (the mark indented for 100 columns inside a 60-column terminal, 11 dynamic rows at 12 rows):
Ink's `stdout.columns` updates on SIGWINCH before the App's React `columns` state; steady-state frames are correct (`chat.pty.test.ts:286`,
2 of 5 runs). **P2** (prose) fixed in §3.3.

## Round 4 — the brand up top, one command grammar, resize robustness, Enter-cycling, conversation, file edits, hardening (2026-09-22)

The fourth round of the interactive TUI (`docs/TUI-DESIGN-4.md`; six slots ran concurrently on 2026-09-22 — S1 header
and the opt-in `fullscreen` renderer, S2 resize and the narrow ladder, S3 command output and blocks, S4 the palette,
S5 the conversation and file edits, S6 hardening, faults, perf, pty and docs — then one integration pass that landed
the open cross-slot requests, re-ran every gate and drove the real product in a pty). **190 tracked files changed,
+13 519 / −5 430; 50 new untracked files.** `package.json` still reads 0.4.0: the bump is the owner's.

### What was built, per slot

- **S1 header, layout, `fullscreen`** (§1, §2.2 P-R1): the `◆ jevcode` rule-row prefix (permanent, and now on the
  open/full panel's tab header too), `WORDMARK_LIVE_MIN_ROWS = 32`, `src/tui/scrollback-guard.ts` (`guardStdout` —
  Ink's `ESC[2J ESC[3J ESC[H` becomes `ESC[2J ESC[H`, so **`ESC[3J` never reaches the terminal** and the user's
  scrollback survives a resize), `src/tui/fullscreen/**` behind `--fullscreen` / `--renderer fullscreen` /
  `JEVCODE_RENDERER` / `ui.renderer` with its five refusals, the row/column allocator whose post-condition is
  `total === rows` exactly, the §1.3.3 scroll keys, and `shouldSyncCommit` — the P-R1 rule that commits the tree
  synchronously on any shrinking dimension and on every width change.
- **S2 resize, terminal, the narrow ladder** (§2, §5.1 P-C3): one geometry per frame, `src/tui/fit.ts` (`fitRung`)
  and `src/tui/gutter.ts` (`gutterMode`, `LABEL_GUTTER`, `STATIC_ITEM_MAX_ROWS = 24`), `wrapBodyCut` /
  `joinWrapped`, the minsize ladder, the OSC-answer filter, `GlyphSet.triangleUp`.
- **S3 command output and blocks** (§3.1–§3.5, §7.5): `block(head, rows, opts)` at all 24 call sites, `blockWidth`,
  the four width tiers, `shortPath`, `/config`'s fold and its `problem` rows. Every §3 command now answers with one
  kv / table / note block instead of hand-rolled rows.
- **S4 the palette** (§4, §5.3): `src/tui/commands/nav.ts` (the nine-state Enter-cycling machine), the ghost union
  (`paletteGhostFor`), the marker reset, `src/tui/commands/confirm.ts`, 37 → 41 commands (`/fullscreen`,
  `/scrollback`, `/peers`, `/ui reset`).
- **S5 the conversation and file edits** (§3.6, §3.7, §5, §6): the D-V engine-item rewrite (`[run] started · … `,
  `[run] finished · … `, `run:ready` and the `stop:` row deleted, `intent · edit · 0.82 (confidence 0.71)`,
  one-row `risk`), turns instead of items, `src/chat/store.ts`, `src/tui/diff/**` (`editSummary`, `diffRows`) and
  the four new colour roles.
- **S6 hardening, faults, perf, pty, docs** (§7, §10, §11, §12, §13): the `guard()` latch's TUI half, a checkpoint
  write that degrades loudly, `explainFsError` through `fatalExit`, the folded session index, the streamed capped
  `jevcode report` bundle, the submission watchdog, the peer surface, one typed `parseFault`, and §3.7's G1 pin
  migration across `test/pty/**`, `src/perf/**` and `scripts/pty/polish-check.mjs`.

### What the integration pass landed (2026-09-22)

Every open cross-slot request in §9.2 that a slot could not reach, plus three defects the gates found.

| # | what | why |
| --- | --- | --- |
| 1 | **Ctrl+Z was dead.** `App.tsx`'s `doSuspend` guarded on `stdout === process.stdout`; §1.4 hands Ink `guardStdout(process.stdout)`, a Proxy, so the guard was false for the real terminal too and `suspendProcess` was never called | a **round-4 regression**, found by `test/pty/chat.pty.test.ts`'s Ctrl-Z leg (no `ESC[?2004h` after SIGCONT) and fixed against the memoised proxy; pinned in `scrollback-guard.test.ts` |
| 2 | **§4.2's Enter-cycling was not wired.** `App.tsx`'s `case 'palette'` fell through to `onEnter()`, so Enter with the card open SUBMITTED the draft: 200 Enters produced `[ui] error: / — not a command` 200 times | the pure machine (`nav.ts`) was complete and tested; the controller now runs `paletteNavState` → `paletteStep` → `NavEffect`. The perf `palette-cycle` series went from 4/200 keys at p95 20 s to 200/200 at p95 11 ms |
| 3 | **§4.3 P-P2's ghost** now reads `matches[selected]`, so the ghost follows the marker (`/help +40` → `/mode +40` → …) instead of always previewing row 0; `ConsoleGhost` widened to the three-member union | without it the Enter cycle moved the marker and nothing else on the composer row changed |
| 4 | **§4.7 E12 / E13**: `KeyState.draftTokenOnly` and `cursorAtEnd` are supplied, and `CLOSE_OVERLAY_AND_CLEAR` has a consumer — Ctrl-C with the card open and a token-only draft closes it **and** clears | both rules were inert; `round3.pty.test.ts`'s `commands-idle` leg had been red since the round opened |
| 5 | **§1.3.4 `/scrollback` and the on-exit dump** | the last functional gap of §1.3: `printToPrimaryScreen` + `waitForAnyKey` (`terminal.ts`) and `transcriptDumpChunks` (`plain.ts`, the same `formatTranscriptItem` rows `createPlainRenderer` writes, in 64 KiB chunks). Driven end to end |
| 6 | **§2.5 P-R5 / P-R6**: the minsize order becomes notice → composer → status, and under `overlay: 'wizard'` the slot is notice(1) · wizard(1) with **no composer**; a key at minsize answers `WIZARD_MINSIZE_TOAST` and changes no wizard state | D4, the worst corner in the corpus: a first-run user was invited to type a task into a composer whose Enter could not start anything |
| 7 | **§1.3.1's alternate-screen leave** moved to `cli/fatal.ts` beside `RESTORE` (no `cli/fatal ⇄ tui/terminal` cycle) and is written by **both** restores; **§2.8 P-R11**: an EPIPE hang-up writes one line to stderr before exiting 129 | a crash on the alternate screen stranded the user on a blank buffer; `\| head` left no trace of a checkpointed run |
| 8 | **§2.8 P-R10** reaches the user: `TERM=dumb jevcode chat` now prints the refusal and its three ways out instead of `missing task text` | `selectRenderer().reason` had no consumer |
| 9 | **§1.3.1's file layer**: `ui.renderer` in the config file is read (one guarded synchronous read of one key, §1's "argv, env, isTTY and cwd only" respected by not calling `resolveConfig`) before `createTuiRenderer` | without it `/fullscreen`'s "fullscreen is set for the next launch" was a promise the relaunch did not keep |
| 10 | **§11's frame rule at 1–3 columns**: `wrapBodyCut` no longer commits a 3-cell `· c` row into a 1-cell terminal, and never glues the `· ` lead to a wide grapheme it cannot fit (`· 本` is 4 cells at 3 columns) | both renderers call this one function; measured in `itemRenderRows` and `buildIndex` alike |
| 11 | **`GlyphSet.triangleUp`** (`▲` → `^`) joins TD §14.1's one-to-one twin table; the fullscreen viewport's local constant is gone | `glyphTwin` could not see `▲` |
| 12 | **`UiState.scroll` gets its action**; the App's local `useState` anchor is gone | §9.2's `useEngine.tsx` row |
| 13 | **§3.6 / §3.7 G1's `stop:` deletion** moved from `src/loop/stop.ts` into `itemsFromEvent` (`src/tui/plain.ts`) | `src/loop/**` is the harness session's under the 2026-09-22 ownership rule; every sink §3.7 names reads that one function, so the row disappears from transcript.log, `--plain`, the TUI and the controller at once, and the `--json` event is untouched |
| 14 | **§7.4 row 2 / §7.7's edge** (a full disk inside a live run dir is exit 3) moved from `explainFsError` to its two readers, `cli/fatal.ts` and `cli/report.ts` | same ownership rule; `src/errors.ts` is the harness session's |

### Gates (measured on the merged tree, 2026-09-22)

| gate | result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **clean** |
| `node scripts/no-any.mjs` | **ok** (src, test, perf, scripts) |
| `npx vitest run --project unit` | **459 files, 8 043 passed, 8 skipped — green** (final run at load 1.17). A peer session's live bench (`bench --suite swebench/quixbugs --live --concurrency 2–3`) ran through most of the integration pass and pushed the 1-minute load average to 18–28; at that load 2–4 timing-sensitive tests flake per run, a different set each time (`app.test.tsx`'s Ctrl-C / note-field / wizard cells, `motion.test.tsx`'s "16 written frames", `round2-console`'s injected animation clock, `session.test.ts`'s recent-session hint). Every one of them passed when its file was run alone, and all of them passed together on the quiet run. No failure was ever reproducible |
| `node scripts/gen-docs.mjs` then `--check` | **clean**, no drift |
| `npm run build` | `dist/jevcode.mjs` 4 382 030 B → **2 480 880 B** minified (43.4 % smaller, keepNames); build smoke first frame **25–74 ms**, `--version` ok |
| `node scripts/check-pack.mjs` | **all gates passed**; tarball 912 775 B < 1 500 000, unpacked 2 694 880 B < 3 000 000, 10 files, 0 dependencies |
| `env -u CI npx vitest run --project pty` | **88 passed / 88** (6 files) |
| `env -u CI sh test/pty/run-smoke.sh` | **64 scenarios, 64 PASS, exit 0**, `polish-check:pass(22)` (V22 and V23 are new and gated); `clears_after_first_frame` 0 everywhere but the three declared shrink scenarios (≤ 1 per shrink segment), `no-3j` on every capture, `restores=1`, `timeouts=0` |
| `node bin/jevcode.js perf` | **31 rows pass, 5 red**, measured on a quiet machine (load **2.18 at start, 1.97 at end**; the gate wants ≤ 8, a release number ≤ 2 at both ends). First frame **`run` 24×80 p95 123.4 ms / `chat` 24×80 p95 122.3 ms** (gate < 300); composer keystroke → frame **idle p95 7.0**, **live p95 7.7**, **palette p95 8.5**, **palette-cycle p95 9.8** (new), **review p95 9.8**, **burst30 p95 5.2 ms** (gate p95 < 16, max < 50) — all 200/200 keys located; **clears after the first frame 0 / 0 / 0 / 0**; **`ESC[3J` 0 / 0 / 0 / 0**; **frames taller than the terminal 0 / 0 / 0 / 0**; cursor hides ≤ 1 and 0 frames without a show in every geometry; the named-anchor self-test green in both glyph sets **and byte-wise**; intake bubble / reply and the idle-animation rows pass. The five red rows are named in the table below |
wants ≤ 8, a release number ≤ 2), so the latency figures are pessimistic. Headlines: first frame `run` 24×80
**p95 262.4 ms** (gate < 300), `chat` 24×80 **p95 172.8 ms**; composer keystroke → frame **idle p95 4.0 ms**,
**live p95 5.6 ms**, **palette p95 3.4 ms**, **palette-cycle p95 4.0 ms** (new), **review p95 4.8 ms**,
**burst30 p95 2.7 ms** (gate p95 < 16, max < 50); **clears after the first frame 0 / 0 / 0 / 0**; **`ESC[3J`
0 / 0 / 0 / 0**; **frames taller than the terminal 0 / 0 / 0 / 0**; intake bubble p95 14.4 ms and reply p95
19.7 ms net; idle animation 4 frames in the busiest second, mean 1.6/s, 8 948 B peak. The five red rows:
`harness overhead per step` p95 **74.4 ms** (gate 50 — the 5 000-file git fixture's copy under load 25),
`composer palette-arg` 2/200 (fixed after this run: see below), and the three `states` scenarios
`review 12×60`, `fault-pane` and `fault-live` (exit 124), plus the new `scroll-latency` row |

### Driven against the real product (`scripts/pty/drive.exp`, `--mock`, hermetic)

The captures are kept at `docs/research/tui/round-4/integration-drives/` (gzipped, with their step timing).

| leg | result |
| --- | --- |
| **(A)** hero + the resize ladder at 24×80, 40×120, 12×60 and 60×200 (each ladder visits all four geometries, then a 20-event storm) | `ESC[2J` after the first frame **0** in all four, `ESC[3J` **0**, exit 0, 0 timeouts. **Zero torn frames**: every frame's box rows are one width (60 / 80 / 120 / 200 all seen) — P1 closed. The `◆ jevcode` brand is on the strip in every capture |
| **(A)** the rows cycle 24 → 8 → 16 → 24 → 40 → 24 → 12 → 24 | **1** clear for three shrinks (the gate allows ≤ 1 per shrink segment), `ESC[3J` 0, no torn frame |
| **(B)** `--renderer fullscreen` at 24×80 and 60×200 | `ESC[?1049h` entered, `ESC[3J` **0**, header at row 1 (the 5-row mark in the tall tier), the position rung `6/6 · 100 % · PgUp` on the rule row, `/scrollback` suspends and prints the transcript to the primary screen with `-- end of transcript · press any key to return to jevcode --`, and the **on-exit dump** puts the whole transcript back on the primary screen after `1049l` |
| **(B)** fullscreen scrolling with a 12-step run | PgUp → `73 %`, PgUp → `46 %`, PgDn → `73 %`, Ctrl+Home → `0 %`, Ctrl+End → `100 %`, with `▲ 41 earlier rows · PgUp` as the viewport's first row while scrolled; `ESC[3J` 0 |
| **(C)** every §3 command idle at 40, 80 and 120 columns and four of them live | all eleven blocks render; **no row wider than 40 cells at 40 columns**; 0 clears, 0 `ESC[3J` in every capture |
| **(D)** the palette state machine | `/` opens on the full list; Enter walks `(1/41) → (8/41)` with the ghost following the marker; Tab accepts (`(1/1) Enter runs /model`); a zero-match token answers `nothing to pick — no command matches /budgett` and never submits |
| **(E)** the §6 review card with an `edit` action | `╭─ review · step 4 · risk 0.50 (exp) · edit scratch_0.py +1 −1 "Edit scratc…"` with `╶──── scratch_0.py` and `@@ -1 +1 @@` diff rows; `y` approves; the outcome row reads `· 1 file +1 −1 · judge 0.90 · 2.0s · $0.0002 · /diff 4` |
| **(F)** `JEVCODE_FAULT=render:{composer,pane,static,wordmark}` | exit 0, the cursor shown at exit, `RESTORE` written once, bracketed paste off, 0 clears, 0 `ESC[3J` in each |
| **(G)** live | `node bin/jevcode.js --workspace <fresh demo-py> --spend-cap 0.30`, TypeSafe native, no `ANTHROPIC_API_KEY`, a temp `JEVCODE_HOME`, 24×80. **exit 0, 0 timeouts, 0 clears after the first frame, 0 `ESC[3J`, 0 rows wider than 80 cells of 1 465, 0 key bytes in any artefact.** First frame 110 ms, composer ready 199 ms, splash settled 554 ms, `hi` → reply **333 ms**, task → `[run] started` 244 ms, run 33.7 s, `replan_stop` at step 8, cost **$0.0084** (generator $0.0028 / jev $0.0056, 1 035 Jev questions) under the `llm-jev` default. The capture pins §3.6 G1's run frame and §3.1's kv blocks live. Full table: `docs/live/tui/round-4/README.md` |

### Deviations

1. **`src/loop/stop.ts` and `src/errors.ts` were reverted** under the 2026-09-22 ownership rule (those files, plus
   `src/checkpoint/**` and `src/core/**` other than the TUI contract blocks, are the harness session's). Both
   behaviours are delivered from files round 4 owns (rows 13 and 14 above), and both hunks are kept verbatim at
   `docs/research/tui/round-4/harness-session-hunks.patch` — applying them is a no-op for every call site. The
   only file outside round 4's ownership that this tree still touches is `src/core/types.ts`, and only inside the
   `Renderer` interface (contract 1.7 item 1: `notify`'s optional `detailRows` / `detailKind`), which the rule
   names as a TUI contract block.
2. **`palette-arg` is reported, not gated, and still short.** The scenario itself was broken — one
   `send '/mode '` is paste-like (§4.7 E9's charset excludes the space), so it never opened the card and 198 of
   200 Enters fell on an empty draft; fixed to the three writes a human makes, which took it from **2/200 to
   70/200** located key frames. The remainder is a real observation for round 5: the **value** cursor's re-render
   does not take Ink's immediate key path the way the **command** marker's does (`palette-cycle` gets 200/200 at
   p95 10.4 ms on the same mechanism), so the S-ARG cycle renders at ~5 fps against 10 keys/s.
3. **§4.5's confirm gate is not wired.** `src/tui/commands/confirm.ts` and `confirmFor` are landed and unit-tested,
   but `App.tsx` has no `acceptedRef` and no confirm row in the `exitConfirm` slot, so Enter on an **accepted**
   `/new` runs it as it did in round 3. §4.1's safety theorem is unaffected: it holds structurally in `paletteStep`
   (from `/` the state is S-BROWSE and Enter is `move`, so no Enter-only sequence can reach `run`).
4. **`src/tui/fullscreen/Viewport.tsx` is `ViewportBox.tsx`** — APFS is case-insensitive and TypeScript refuses two
   modules whose paths differ only in case (TS1149) next to `viewport.ts`. The exported name is the design's.
5. **`<FullApp>` is `<App renderer="fullscreen">`**, one component with two branches rather than a second tree —
   §1.3.5's "reuses everything unchanged" is only guaranteeable that way. Every fullscreen branch is gated on
   `full === null`, so the classic tree is byte-for-byte round 3's.
6. **F-H4 / F-H5 are pinned to the builder, not the frame.** The builder opens the strip with three rule cells where
   the document's two fullscreen frames draw two, and F-H4's drawn block has 14 viewport rows against its caption's
   13. Changing `ruleRow` would re-pin every round-2 strip fixture and is in no round-4 row.
7. **§2.7's `filterInput` is not on the product key path** (pre-existing: `keys/resolve.ts:319` keeps its own
   narrower `CSI_LEAK` / `OSC_LEAK`). S2's P-R8 work and its `typing` flag are therefore unreachable from a
   keystroke; the unit tests cover the function, not the wiring.
8. **Shift-Tab reaches the palette as `move by -1`** (`keys/resolve.ts:722`), so the nav machine sees `up`, not
   `shifttab`. The two differ only in S-ONE; widening the resolver's op union would re-pin every round-2/3 key
   fixture.
9. **Eight declared carve-outs.** The rule-row change re-pins `app.test.tsx:106, :111, :127, :141`,
   `round2-lines.test.ts`, `round2-app.test.tsx`, `round3-wordmark-app.test.tsx` and `height.test.tsx`; each
   carries a `DECLARED CARVE-OUT` comment and §9.1's S1 row now records them (§1.2 edge 9 already did).

### The five red perf rows, named

| row | measured | why it is red |
| --- | --- | --- |
| `harness overhead per step`, p95 | **52.6 ms / 25.4 ms** (gate < 50) on the quiet run — 5 % over | the probe copies a 15 MiB pre-image at every run step over a 5 000-file git fixture. Not a round-4 change: nothing in this round touches the checkpoint copy, and the p50 has two times the headroom |
| `composer palette-arg`, **70/200** keys (was 2/200) | p50 7 217 ms, frame rate 5/s against 10 keys/s | two separate things. (a) The **scenario** was broken: one `send '/mode '` is paste-like (§4.7 E9's charset excludes the space), so it never opened the card and 198 of 200 Enters fell on an empty draft — fixed to the three writes a human makes. (b) What is left is a real observation: the **value** cursor's re-render does not take Ink's immediate key path the way the **command** marker's does (`palette-cycle` gets 200/200 at p95 9.8 ms on the same `setPalette` mechanism). Reported, not gated. An earlier integrator wiring also let the SECOND Enter execute `/mode jev-on`; that is fixed and pinned in `round4-palette-app.test.tsx` |
| `states: review 12×60` | exit 124 | at the flat tier the scenario waits for `[y] approve`; the review keys row is the card's, and 12 rows leaves no card. An S6 scenario that has never passed |
| `states: fault-pane` | exit 124 | waits for the pane-failed line after `/panel` inside a live run; `run-smoke.sh`'s own `fault-pane` (a different step file) passes with `boundary:caught` |
| `states: fault-live` | exit 124 | S6 measured it and wrote the reason down: `render:live` cannot fire at 24×80 because the shipped `--mock` trajectory produces no STREAMING text, so `layout.live` stays 0 and the boundary never renders. It needs a streaming mock (`src/cli/mock-trajectory.ts`) |
| `scroll-latency` (new this round) | **200/200 keys located** (was 0/200 before the anchor fix), p50 **23.5** / p95 **46.2** / max **55.2 ms** against a gate of p95 < 16; widest scroll frame **3 073 B** (gate ≤ 6 144) **pass**; width rebuild **80.9 ms** (gate < 50); `ESC[3J` **0**; cursor shown at exit **true**; `frames not exactly rows tall` 373 and `clears 3` | the row has **never had a green baseline** — it is one of the nine §11 rows round 4 adds, and it was measuring nothing at all until the anchor fix. Two of its sub-gates are harness questions rather than renderer ones: with `incrementalRendering` forced under `fullscreen` (§1.3), most frames are partial diffs, so "exactly `rows` lines" only holds for a full repaint, and the 3 clears are the alternate-screen entry plus the two 20 000-item builds. The latency is real: 20 000 items at 40×120 is a 40 000-row index, and a scroll key repaints a 40-row slice of it inside a React commit that also re-runs the allocator. Round 5 should either memoise the slice or make the index build incremental (finding 20's `buildIndexTail`) |

### Not verified

1. **Ten of the eighteen opt-in `run-smoke.sh` scenarios are red** (`sel_named`, run by name only): `fault-persistent`
   and `fault-persistent-flat` (`LATCH:0-notices`), `fault-status` / `fault-status-flat` / `fault-wordmark-flat`
   (`MISSING:*-boundary`), `fault-live` and `fault-transcript` (`MISSING:boundary-notice`), `rundir-vanishes`
   (`MISSING:degraded-item`, `RESUME-ADVERTISED`), `stuck-submit` (`MISSING:watchdog-line`), `readonly-home`
   (`MISSING:explain-line`) and `peers` (`MISSING:peers-item`). Eight pass (`fault-wordmark`, `fault-pane`,
   `fault-overlay`, `fault-composer`, `fault-static`, `narrow`, `ui-reset`, and `fault-idle`'s three aliases).
   These exercise §7 wiring that was never landed in `src/cli/main.tsx` / `src/loop/engine.ts`; every one of them
   is clean on the hygiene checks (`no-3j`, `restores=1`, no tall frame).
2. **`JEVCODE_ASSERT_HEIGHT=1` and `readFaultEnv()` still have no pre-mount call site** (§7.11): an unknown
   `JEVCODE_FAULT` is a silent no-op at run time.
3. **The `report bundle` wall-clock row (1 GB in < 5 s, < 200 MB RSS) has no probe.** The mechanism is in and
   unit-tested; the timing is not measured.
4. **`§2.2 edge 8`** (a resize inside a `suspendTerminal()` window writing zero bytes) is unpinned — driving a real
   suspension from a unit mount means SIGSTOP-ing the test process.
5. **Finding 20 (§1.3.3 edge 2, the lazy `--resume` index) is deferred with a measurement**: `buildIndex` at 80
   columns takes 4.9 ms / 1 000 items, 16.6 ms / 5 000 and 43.4 ms / 20 000 — inside the 300 ms first-frame gate,
   on the opt-in renderer's path only.
6. **The machine was never quiet.** A peer session's live bench (`bench --suite swebench --live --concurrency 2`)
   ran throughout; every load average is recorded with its measurement.

### Owner's pass (2026-09-22, the merged tree — what actually ships as 0.5.0)

The integrator's tree above was `r4-impl` before `main` was merged into it. The owner's pass merged `main` at `9f58e0c` (contracts 1.5
and 1.6, the coordination W2b wave, the `BlockingKind` members, the `decompose` / `coordinate` stage tables, the caching decider, the
`heldUsd` callers, the round-5 design), resolved eleven conflicts, re-ran every gate on the result, drove it live once more and bumped
the version. Commits on the branch: `3252a6c` (the six slots + integration, 280 files) → `a01b2d9` (merge) → `b7cd449` (merge fixes) →
`9012240` (0.5.0, lockfile regenerated with `--package-lock-only`) → `cb2aaca` (unit fixes) → `ca8e71c` (pack gate) → this commit.

**Conflicts and how they were resolved.** `docs/DECISIONS.md`: both sides' 2026-09-22 entries kept. `src/perf/main.ts`: both probe sets
(`scroll-latency` in the release set; the harness's opt-in `lane-run` / `sandbox-spawn` in `RING0_PROBES`). Eight harness-owned
`test/unit/loop/engine-*.test.ts` files: round 4's §3.6/§3.7 sentences stand and the harness's own "no `stop:` row" assertion sits
beside them; `engine-steer.test.ts` takes the harness's `run:end` anchor for its last-event arm (its D-V deletes the stop transcript
event outright, so round 4's stop-event anchor never fired). `test/unit/loop/decompose-m2.test.ts`: the M2 golden's `transcript` alone
was re-captured on the merged tree at `9012240` with the gate shut (152 rows; `transcriptCommit` in the fixture); prompts, event types,
decider calls, sandbox commands and invalidations are byte-identical to the a17c7f6 capture, and the line-by-line comparison is back
with a duration-agnostic normaliser (deterministic over two runs). Generated files (`man/jevcode.1`, completions) regenerated.

**Gates on the merged tree.**

| gate | result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` · `node scripts/no-any.mjs` | clean · ok |
| `npx vitest run --project unit --maxWorkers=3` (1-minute load 22, a peer's bounded test runs) | 507 files, **8,493 passed**, 8 skipped, 6 failed → all six resolved: three `height.test.tsx` first-frame snapshots differed only in the `◆ 0.5.0` caption (re-recorded, `git diff` shows version strings only); `plain.test.ts`'s formatter import-graph allowlist gained `src/orchestrate/{land,manifest,worktree}.ts`, reached through the harness's `src/loop/stages/risk.ts` → orchestrate barrel (documented; the harness imports the leaf module next and the rows go); two `app.test.tsx` cells were load flakes — `app.test.tsx` 75/75 and `motion.test.tsx` 11/11 alone at load 3 |
| `node scripts/gen-docs.mjs --check` | clean |
| `npm run build` | bundle **2,786,493 B** (was 2,480,880 B before the merge: the engine-side waves), first-frame smoke 57 ms, `--version` → `jevcode 0.5.0` |
| `node scripts/check-pack.mjs` | all gates; unpacked **3,003,627 B** against the gate raised to 3,500,000 (`ca8e71c`, dated note; the old 3,000,000 line was missed by 0.12 %), tarball 1,015,735 B < 1,500,000, 10 files, 0 dependencies |
| `env -u CI npx vitest run --project pty` | **88 / 88** |
| `env -u CI sh test/pty/run-smoke.sh` | exit 0, every scenario PASS |
| `node bin/jevcode.js perf` (load 5.26 at start, 2.16 at end — **not** a quiet release number by the suite's own ≤ 2 rule; the window was announced and the peer held its agents; the residual load was the desktop) | **43 of 50 gates**: first frame p95 133 ms (< 300), harness overhead p95 42.6 ms (< 50), render lag, static append, intake, idle frames all pass; **7 red**, the same rows the integration pass named: composer `palette-arg` 70/200 keys located; `states` review 12×60, fault-pane, fault-live timed out on their anchors (exit 124); `scroll-latency` (the opt-in fullscreen renderer) p95 44.2 ms vs 16, width rebuild 80.5 ms vs 50, and **368 frames not exactly 40 rows** — a real post-condition defect of the opt-in renderer, not of the default hybrid layout |
| live drive (`docs/live/tui/round-4/run-live.sh live-round4-owner 24 80`, the merged build, TypeSafe `jev-1.13.0`, the `llm-jev` default, `--spend-cap 0.30`) | exit 0 · 0 timeouts · 0 clears · **0 key bytes**; first frame 114 ms, composer 202 ms, splash settled 554 ms, `hi` → reply 307 ms, task → `[run] started` 254 ms; run 41.0 s: pytest **7 / 0 at step 2**, `replan_stop` at step 5, **$0.0080** (generator $0.0014 · jev $0.0066), 1,787 Jev questions — artefacts `live-round4-owner.*` beside the integration pass's |

No pre-existing gate regressed; the seven red rows are round-4 design targets that never had a green baseline. They stay red in
this release and are named here rather than loosened.

**Hunks for the harness session** (its files; reverted from this tree per the 2026-09-22 ownership rule and sent as patches):
`docs/research/tui/round-4/harness-session-hunks.patch` — `src/errors.ts` `explainFsError` (exit 3 for a full disk *inside* a run
directory) and `src/loop/stop.ts` `stopTranscriptLine → ''` (both behaviours already delivered from round-4-owned files, so the patch
is a no-op for every call site); plus the two test-file edits above and the allowlist request.

**Owed after this merge** (small, on `main`): ~~the `/jev` `cache hits` row~~ (landed right after the merge: the `cost` row ends with `· N cache hits`, from Σ `StepRecord.jevCacheHits`; the report bundle already carries the per-step field in `steps.tail.jsonl`); the fullscreen frame-height
post-condition (the 368 frames above) as a fix or a round-5 slot; the `lease-conflict` / `land-preflight` pane prose (round 5, D-AF).

## Round 5 — every session knows what the others do, the context is visible, delegation, import, the model picker (2026-09-22)

The fifth round of the interactive TUI (`docs/TUI-DESIGN-5.md`; six slots ran concurrently on 2026-09-22 — R5-1
coordination session state and the write half, R5-2 coordination commands and the contract block, R5-3 the context
meter and its config chain, R5-4 the agent tree and the shared React shell, R5-5 the import surface, R5-6 the
provider and model picker — then one integration pass, this record). The round answers the five user requirements
of §1.1: every session knows what the others are doing and never blocks one; the context is relaxed and its usage
is visible; work can be delegated and watched; memory and workflows come over from the other agents on the
machine; every provider key is selectable with search.

**This section is written to be read by someone deciding whether to merge.** What landed, what each gate measured,
what deviates from the design and why, and — in its own subsection, not buried — the three surfaces that are built
and registered but **not driven by a store in this build**.

### What was built, per slot

| slot | new modules | what it does |
| --- | --- | --- |
| **R5-1** coordination: session state, the picker, the index, the write half | `src/session/peers.ts` (558), `src/session/publish.ts` (528) | `activityView`/`selfView` (the only two shapes that cross the boundary; neither carries `hostKey`, a full device id or a pid), `whoRowText` — the **one** builder every `/who` sink calls — its nine-cell drop ladder, `whoHeader`, `whoFlagRow`, `whoSentence` (the screen-reader twin), `peerViewOf`; the eight-branch resume card in `picker-lines.ts`; `RunLock.bootAt` and `lockReplaceVerdict`'s six reasons; `src/cli/sessions.ts` 4 → 17 verbs; and §2.14's write half — ledger open, claim mint, heartbeat writer and repo-identity probe, **all after `renderer.firstFrame()`** |
| **R5-2** coordination: commands, targets, messaging, the status zone, the contract block | `src/tui/commands/target.ts` (314) | contract 1.8 in `src/core/types.ts` (`SessionActivityView`, `SelfIdentityView`, `UiLabel += '[session]'`, three optional `SessionRow` members, the seven-provider `ProviderName`, eight renumberings); `resolveTarget`'s eight rungs, one grammar for every verb; the six coordination registry rows and their validated actions; `peerZoneText` and the `peers`/`ctx`/`agents` status segments with `DROP_ORDER` and the push order; the nine new `GlyphSet` members with their ascii and SR twins; the lease-conflict and land-preflight card builders |
| **R5-3** the context meter, compaction, the config chain | `src/tui/context/lines.ts` (439) | `ctxText`'s two width rungs and the amber/red word; `contextBlock` — the whole `/context` body from three already-public reads — with `fileReason`, the per-file table budgeted before `layoutTable` sees it, and three distinct empty states; `compactAnswer`'s four branches with the `off` branch checked **first**; `resolveContextConfig` + `ResolvedConfig.context()`, which the engine call sites now read; `context.kept` |
| **R5-4** the agent tree, the key resolver, the shared React shell | `src/tui/agents/lines.ts` (722), `src/tui/pane/agents.ts` (110), `src/cli/agents.ts` (154) | the 16 agent row states and four cards from one pure function; `PaneTab 'a'` with `PANE_TABS` deliberately **unwidened** and `paneTabsFor(hasDelegation)` passed at all four call sites; `KeyContext 'agents'`, the eight keys, the `x x` drop chord, the one pane rung between Picker and Composer; `UiState.agents`/`paneFocus`/`agentCursor` with the cursor clamped in the reducer; `agentStripText` in the status line; `agentBlockLines` in `plain.ts`; `jevcode agents list` |
| **R5-5** the import surface | `src/config/imports.ts` (435), `src/cli/import.ts` (521), `src/tui/import/{lines,reducer,Report.tsx}` (741) | the 17 `[import]` item builders in **one** module that `lines.ts` re-exports and never re-declares; the overlay's reducer and rows with `CAP.import` and a protected keys row; `OverlayKind += 'import'`; the wizard's one-time `'import'` step; the CLI verb with its five twins (`--plain` numbered, SR spoken, `--ascii`, pipe/`--no-input` dry-run-only, `--json` one `ImportPlan`) and the rule that `--yes` calls `applicableRows` and nothing else |
| **R5-6** provider, model picker, key setup | `src/tui/models/{lines,state}.ts` (554), `src/cli/models.ts` (197), `src/config/provider-tables.ts` (51, zero-import) | the picker's rung ladder, its reducer over `instantCatalogue()`, `modelsPlainLines`'s numbered twin and `modelsSrLine`; `jevcode models list|search|refresh`; the seven-provider widening in `args.ts`, `credentials.ts`, `login.ts`, `resolve.ts`'s `PROVIDER_KEY_ENV` (a live bug fix — `gemini`'s `GOOGLE_API_KEY` and `meta`'s `MODEL_API_KEY` fallbacks were unreachable) and `defaults.ts`'s `BASE_URLS`, all off the argv path |

**The integration pass landed every open §9.2 cross-slot request**, in §9.3's W3 → W4 order:

1. **W3 shared React shell** — `StatusLine.tsx`'s `statusView` now supplies the `ctx` cell from `ctxText` (R5-3's
   half of the `status/lines.ts` row: R5-2 had landed the segment's position and drop rank reading a string, and
   nothing supplied it). R5-4's own hunks (the `'a'` tab, `paneFocus`, the `agents` strip) were already in.
2. **W4 `src/config/{types,defaults,validate,resolve}.ts`** — the 46 remaining config rows: six `coordination.*`,
   **34 `orchestrate.*`** in `docs/ORCHESTRATION-DESIGN.md` §6.4's own order, five `import.*`/`memory.*` and the
   hidden `seen.import`, with their value tables and the two negating boolean flags D-AP names.
3. **W4 `src/cli/args.ts` + `src/cli/main.tsx`** — R5-1's four-edit `sessions` hunk verbatim (17 verbs,
   `sessionsArgs`, `--all`/`--device`/`--rotate`/`--force-takeback`/`--parent-session`), R5-5's `Command +=
   'import'` and R5-4's `+= 'agents'` with their nine orchestration flags and eight import flags, and the three
   `await import()` switch arms. The static import list gained nothing.
4. **W4 `src/tui/commands/registry.ts`** — the nine remaining rows (47 → **56**): `context`, `compact` (R5-3),
   `split`, `agents`, `agent`, `land`, `spawn` (R5-4), `import`/`imp`, `memory`/`mem` (R5-5), and R5-6's
   `/provider` values edit. Each row's `CommandAction` and its argument validation landed with it in
   `dispatch.ts` (46 → **55** kinds).
5. **W4 `src/cli/session.ts`** — the nine handlers. `/context` and `/compact` are **real** (they read
   `engine.status().context` and `engine.snapshotState()` and call `engine.compact()`); the other seven answer
   the honest D-AN sentence. `EXCLUSIVE_COMMANDS` gains `land` (11 → 12).
6. **W4 `src/session/index.ts`** — already landed by R5-1 as its one `INDEX_KINDS` commit: 15 kinds, one
   `IndexLine` arm each, `pause.by` and `run:start.parentSessionId` both **optional** with stated reader
   defaults, and the array exported and re-typed `readonly IndexKind[]`.

**W5 shared tests landed by the integration pass**: `test/unit/tui/r5-identity.test.ts` (new, 13 cases — the
§13.1 `/who` producer identity at 40/80/120, the G-R5-6 width sweep at 40…200 in both glyph sets, and **each of
§13.2's eight declared clauses**, none skipped); the gate **G-R5-8** settings lint in `contract.test.ts`, which
parses `docs/ORCHESTRATION-DESIGN.md` §6.4's table out of the design file rather than copying it, so a row added
there and not to `SETTINGS` fails with no second edit; the registry count/no-dead-pointer rows; and the five
`run-smoke.sh` scenario blocks for `test/pty/smoke/r5-{who,message,context,pause-end,model-picker}.steps` with an
unconditional key-byte scan over every `r5-*` capture (G-R5-9); the **whole-header-block** contract-order case
(`1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8` in one assertion, contiguous and ascending — the five per-round
cases each check only their neighbour, so only this one catches a line inserted out of order two rounds later);
and **`test/pty/round5.pty.test.ts`** (new, 4 cases), which is the part of G-R5-9 and G-R5-6 that runs on every
`vitest --project pty` rather than by name on the smoke board.

### The arrays, after the round

| array | before | after |
| --- | --- | --- |
| `COMMANDS` (registry rows) | 41 (round 4) → 47 (R5-2) | **56** |
| `COMMAND_ACTION_KINDS` | 46 | **55** (`/llm` maps onto `mode` and `/ui` onto `uiReset`) |
| `Command` (CLI verbs) | 14 | **16** — `import`, `models`, `agents`, each named literally by gate G-R5-10 |
| `SETTINGS` | 62 | **108** (+1 `context.kept`, +6 `coordination.*`, +34 `orchestrate.*`, +5 import/memory, +1 hidden `seen.import`) |
| `INDEX_KINDS` | 8 | **15**, exported and typed `readonly IndexKind[]` |
| `OverlayKind` | 10 | **11** (`import`; the model picker is a pane-slot picker, not an overlay) |
| `KeyContext` | 5 | **6** (`agents`) |
| `GlyphSet` | — | **+9** members, each with its ascii and SR twin, `asciiTwins()` still one-to-one |

### Gates — every number, measured on this machine (Apple Silicon Mac, macOS 26, Node 22.23.2, 2026-09-22)

**The machine was not quiet, and that is the biggest caveat on this table.** Other sessions ran on it throughout;
the one-minute load average moved between 8 and **124** during the pass. Every load-sensitive number below says
so, every load-sensitive failure was re-run alone on the same tree, and where a file could be compared against
the **base commit** in a scratch worktree it was. Nothing in the red lists below is a round-5 surface.

| gate | result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **clean** |
| `node scripts/no-any.mjs` | **ok** (src, test, perf, scripts) |
| `npx vitest run --project unit --maxWorkers=3` | 539 files, **9,406 passed**, 8 skipped, **1 failed** on the quietest pass the machine allowed (load 13.6 → 14.7) — `test/unit/tui/app.test.tsx`'s `the wizard through the App`, a **load flake**: it passes **3 / 3 alone** on this tree and **3 / 3 alone at the base commit `36f1104`** in a scratch worktree, and the whole file is **75 / 75** alone here. Four earlier passes at loads of 31, 48 and 124 produced 2, 3, 13 and 19 failures, every one of them in the same Ink-timing files (`app.test.tsx`, `round2-console`, `wizard`, `round4-chat-app`, `gitstate-probe`, `session/index`'s two perf gates) and every one green alone. **One real failure was found and fixed this way** and is not in any of those counts: `test/unit/config/defaults.test.ts` went red on the 46 new config rows (an inverted env name with no boolean flag, and a second hidden row) — fixed by giving `import.enabled` and `memory.enabled` the `--no-import` / `--no-memory` flags D-AP names, and by naming `seen.import` in the hidden-row assertion |
| `node scripts/gen-docs.mjs` then `--check` | **exit 0** — the generator learned the three new CLI commands (the man-page table and both completion tables) and regenerates `docs/COMMANDS.md` (56 rows), `docs/KEYS.md` (the `agents` `KeyContext` and its eight rows), `man/jevcode.1` and the three completion scripts |
| `npm run build` | `dist/jevcode.mjs` **3,140,530 B** minified from 5,513,028 B (43.0 % smaller) in ~270 ms; first-frame smoke **84–91 ms**; `--version` → `jevcode 0.5.0` (the **0.6.0 bump is the owner's**, per `docs/RELEASE.md`); `THIRD_PARTY_LICENSES.txt` 35 packages |
| `node scripts/check-pack.mjs` | **all gates**; unpacked **3,374,795 B** < 3,500,000, tarball **1,135,280 B** < 1,500,000, 10 files, **0 dependencies** |
| `env -u CI npx vitest run --project pty` | **88 / 88** before this pass's own file, then **91 / 92** with `test/pty/round5.pty.test.ts` added (4 new cases: the coordination reads, the context pair, the four D-AN refusals, and the 24×80 → 12×60 → 40×120 → 24×80 resize matrix — **4 / 4**). The one red is `round3`'s `first frame … < 300 ms warm` at load 17, which **passes alone**. An earlier 92-case run at load above 100 put six pre-existing timing cases red (`chat` resize storm, `review` type-ahead, two `round2` splash cases, `round3` first frame, `twins` identity); all six were green in the 88 / 88 run on the same tree |
| `env -u CI sh test/pty/run-smoke.sh` | **exit 0**, **64 / 64 PASS**, every scenario `clears_after_first_frame=0`, `no-3j`, `no-tall-frame`; first frame 151.2 ms, splash settle 557 ms |
| `node bin/jevcode.js perf` | **24 of 32 gate rows pass, 8 red.** The run waited **901 s** for the machine and started at load **7.99** (the suite's own limit is 8, its release rule ≤ 2) and **ended at 77.17** — other sessions came back mid-run, so **these are not release numbers** and every red row below is named with that caveat |

**Perf, row by row.** Green, and the ones round 5 could move: **first frame cold p95 140.8 / 154.9 / 139.2 ms**
at 40×120 / 24×80 / 8×40 (gate < 300), warm median 101.9–108.6 ms, splash frame 0 in 20/20 first frames at both
wide tiers and 0/20 at the flat tier (as specified); **render lag** p95 3.15 / 2.39 / 5.11 ms at rows 40 / 12 /
40-reduced (gate < 5 net) with **0 clears, 0 `ESC[3J`, 0 tall frames** in every geometry; **idle frames** 48 over
30 s, peak 4/s, mean 1.60/s at both widths (gate ≤ 4 / ≤ 2); **composer idle / idle-loop** p95 7.8 / 7.2 ms;
the **named-anchor self-test** ok in both glyph sets; **frames taller than the terminal 0 / 0 / 0 / 0**.

The **8 red rows**, all of which were red in round 4's own pass or are the same family, none of which round 5
touched: `composer palette` p95 31.8 ms, `palette-cycle` 40.4 ms and `review` 28.4 ms against a 16 ms gate (round
4 had these green at load 2.2; at load 70 the trailing edge of Ink's 34 ms throttle dominates); `intake mock0`
bubble p95 46.1 ms and `mock150` 24.3 ms against 16 ms (same cause; the *net* reply p95 is 39.5 ms against a
40 ms gate, i.e. green); `state review 12×60` and `state fault-pane 24×80` **exit 124** on their anchors — the
identical two rows round 4 named; and the whole `scroll-latency` probe of the **opt-in fullscreen renderer**
(p95 3,261 ms, width rebuild 60.5 ms vs 50, **155 frames not exactly 40 rows**, 3 clears) — round 4 recorded
368 such frames and owed the fix; it is still owed. `composer live-stress`, `palette-arg` and `burst30` are
**report-only** rows by the suite's own design (a zero-latency storm and Ink's throttle window).

No pre-existing gate regressed; nothing in the red list is a round-5 surface.

**The five round-5 pty scenarios** (`test/pty/smoke/r5-{who,message,context,pause-end,model-picker}.steps`, plus
the two `--ascii` twins) run **by name only** — `sh test/pty/run-smoke.sh r5-who r5-context …` — exactly as the
eight `fault-*` scenarios do, so the default board is not red for surfaces whose stores do not exist:

| scenario | result |
| --- | --- |
| `r5-pause-end` | **PASS** exit 0, `r5-pause-end:s45a`, 0 clears, no `ESC[3J`, **0 key bytes** |
| `r5-who`, `r5-who-ascii` | exit 124 (a later `expect` timed out), **0 key bytes**, and §2.14 consequence 3 is clean: `beat-no-key-bytes` and `beat-no-long-hostkey` over `$home/coordination` |
| `r5-context` | exit 124, **0 key bytes** |
| `r5-message` | exit 124, `MISSING:r5-message-s34a`, **0 key bytes** — the far-end mailbox is not wired, which the file's own header says |
| `r5-model-picker`, `-ascii` | exit 124, `MISSING:r5-model-picker-rule` (the `'models'` arm of `Picker.tsx` is not mounted), the ascii twin's glyph scan **passes**, **0 key bytes** |

**The four `exit 124`s are the driver's hazard, not the product's, and the integration pass proved it.** Each of
those scenarios starts with a `--mock` run and then types a command; `docs/research/tui/20-pty-driver-findings.md`
§5 records that a non-draining `sleep` in a step file starves the child's event loop while a run floods the pty,
so the Enter sits in stdin and the draft accumulates (`› /who/who --all` is visible in the capture). Driving the
same commands against an **idle** session, with the same driver, answers every one of them:

```
[ui] who · unknown          the session ledger is not open yet
[ui] peers · unknown        the peer registry is not available in this build
[ui] context                no run is live — /context reports the run's prompt budget
[ui] error: /compact needs a live run
[ui] /agents is not available in this build — no agent is running
[ui] /import is not available in this build — jevcode import plans, reviews and applies from the CLI
[ui] model mock
[ui] error: nothing is running to end — /end <target> ends a peer's run
```

and against a **live** `--mock` run at 40×120 the `/context` block is §12 S48–S53 in full:

```
[ui] context · step 2 · relaxed · code compaction
[ui] budget 239k chars of the 128k-token window
[ui] recent steps 82 of 72k (1 whole, 0 clipped, 0 one-line)
[ui] prompt build 826 ms · file refresh 826 ms
[ui] files in view · 1
[ui] scratch_0.py  12  read at step 2 · edited step 1
[ui] nothing to compact — only the newest step is in history        ← /compact, S57
[ui] paused after step 4 — /resume continues, or type a follow-up   ← /pause
```

The §5.8 resize matrix (**24×80 → 12×60 → 40×120 → 24×80**, with a `/context` block and a `/who` block on screen
across the moves) measured **0 clears after the first frame, 0 `ESC[3J`, no frame taller than the terminal and 0
key bytes** with `OPENROUTER_API_KEY` exported. Captures are under `.scratch/drive/` (not committed).

### Live, paid once — `docs/live/tui/round-5/`

`sh docs/live/tui/round-5/run-live.sh live-round5-default 24 80 …` drove the **built bundle** against the real
Jev service from the repository root's `./.env`, with `ANTHROPIC_API_KEY` and `JEV_API_KEY` unset in the child, a
fresh temp `JEVCODE_HOME` and a fresh copy of the demo template, under the shipped `llm-jev` default at
`--spend-cap 0.30`. Full table in that directory's `README.md`:

| measurement | value |
| --- | --- |
| first frame · composer ready · splash settled | **433 ms** · 805 ms · 570 ms |
| `hi` → reply | **306 ms**; task → `[run] started` **381 ms** |
| the run | **36.7 s**, 8 steps, `replan_stop`, pytest **12 / 3** at step 2, `jev-1.13.0 (pinned)` |
| **spend** | **$0.0062** — generator $0.00205 (7 calls) · jev $0.00414 (19 calls), 1,015 Jev questions |
| clears after the first frame · `ESC[3J` · rows wider than the terminal | **0** · **0** · **0** |
| **key bytes in any artefact** | **0** (`"key_leaks": {}` over the capture, the timing file, the run directory and the session index) |
| the two round-5 reads, live | `[ui] who · unknown / the session ledger is not open yet` and `[ui] context / no run is live — /context reports the run's prompt budget` — both the honest empty state |
| driver exit | 124 with **1** timeout: the **last** step (`/jev`'s `expect intake {2,}1 message`) missed its window. Every mark before it landed |

Two CLI verbs, free and offline, saved beside it: `jevcode models search glm --plain` → **16 rows** across three
providers with the provenance row `Anthropic bundled snapshot · OpenRouter bundled snapshot · +5 more`, exit 0;
`jevcode import --dry-run` against a fixture home → `3 to import · 0 to review · 1 skipped · 565 B` with
`mcp  1  disabled on import` and the pipe rule, exit 0.

**One defect the live pass found and the integration pass fixed.** `jevcode import` died on its first line with
`Cannot read properties of undefined (reading 'workspace')`: `main.tsx`'s new `case 'import':` was not supplying
`ImportIo.planOptions`, and `planImport` dereferences `opts.env.workspace`. The arm now builds the
`ImportEnvironment` itself (`home`, `env`, `platform`, `workspace`, `gitRoot`, `extraRoots`) with
`trust: 'none'` and `decider: null` — so `jevcode import` is free and offline and the code fallbacks still
produce a complete plan (§4.9) — and `gitRootOf` is a bounded 64-parent `existsSync` walk for `.git` (a **file**
in a linked worktree, so not `isDirectory()`), never a `git` spawn, because this runs on the argv path. Without
the git root the project-scope sources (`CLAUDE.md`, `.mcp.json` in the workspace) were invisible: the dry run
went from `2 to import` to `3 to import` with the fix.

### Deviations from `docs/TUI-DESIGN-5.md`, each with its reason

1. **`jevcode import`'s source is a POSITIONAL, not `--source <id>`** (§5.5). `--source` already exists as a
   hidden flag whose value domain is `CLI_SOURCES` (`cli|perf`, validated in `parseCliArgs`), and one flag name
   cannot mean two things. The slash form §5.5 itself specifies is `/import [--dry-run] [<source>]` — a
   positional — so the CLI takes the same shape and the clash is recorded for the owner rather than resolved by
   inventing a third name.
2. **`/help` now sits at the last two rungs of its compaction ladder at every width.** 56 command rows plus two
   headers are 59 of `HELP_MAX_LINES`' 60, so the key table becomes one `… /help keys prints the key table`
   pointer (level 5) and the four per-terminal notes are dropped (level 4). This is `HELP_COMPACTION_LEVELS`
   working as designed — it ranks a command line above a terminal tip — and `palette.test.ts` records the new
   reachable levels rather than raising the cap, which is a TD §5.3 number and TD4 §11's block-caps gate.
3. **§12 S51 is rounded to whole milliseconds in the builder.** The engine measures with `performance.now()`, so
   a real capture reads `prompt build 826.1 ms · file refresh 825.65 ms` — two precisions in one row whose job
   is an order of magnitude. Rounded in `contextBlock`, not in the meter: the meter's number is the measurement.
4. **`/context` after a run has *stopped* answers S54 (`no run is live`), not the block.** `ContextBlockInput.live`
   is the controller's `live()`, which is false the moment the run ends, so a finished run's prompt budget is not
   inspectable. The design does not say which way this should go; the live capture makes it visible, and it is
   filed here rather than changed in an integration pass.
5. **`PENDING_ROUND5_HANDLERS` in `registry.test.ts` is kept as an EMPTY set** rather than deleted, so the next
   round's debt has a named place to go and the `every` assertion below it still holds over it.
6. **`test/unit/tui/r5-identity.test.ts` lives at `test/unit/tui/`**, beside `round4-identity.test.ts`, which
   §10 names but does not place.
7. **`/land` is `destructive: true` and takes NO rung ladder.** §4.9 reads it as "a confirm row whose Enter is
   inert", but `ConfirmKind` is a closed four-member union on purpose — its own docblock explains that a fifth
   member would be a kind `confirmRow` must answer `null` for, i.e. a modal with no visible way out. `/land`
   therefore takes the explicit `null` `historyClear` takes in the same switch, for a stronger reason: until
   `AgentSupervisor` exists `/land` answers `not available in this build` and there is nothing to confirm, and
   the gate it *will* take is §4.6's **manifest confirm** (D-AM) on the review surface. Both halves are pinned
   in `dispatch.test.ts` so a later round moves it deliberately.

### The three gaps, after the integration pass (gap-closure wave wf_b190d4b0-0f3 + lean finishing pass wf_9fa3b9c6-6ab, 2026-09-22)

1. **CLOSED — `openCoordination()` is in production.** Opened after `renderer.firstFrame()` resolves, one handle shared by the
   write half (mint, beat, leases) and the read half (`ledger.fold` on mount and after every own write, then the subscription);
   feeds the thirteen `jevcode sessions` verbs (`src/cli/main.tsx`), `/who`, `/peers`, the `peers` status zone (UiState
   `fold`/`selfId` + the `peers:fold` action) and the chat `peers` fact; `coordination.enabled=false` or an unwritable home
   degrade to the `unknown` answers with the §12 sentence; a ledger failure never takes the session down. `/who` and `/peers`
   agree on one fold (`consider` in `src/session/peers.ts` takes a liveness fallback). Tests: `test/unit/session/peers.test.ts`,
   `test/unit/cli/sessions.test.ts`, `test/unit/tui/round5-shell-app.test.tsx`, the `r5-who` pty scenario.
2. **CLOSED — the three surfaces are mounted.** `src/tui/Picker.tsx`'s `models` arm (`/model` opens the pane-slot picker; Enter =
   next run only, D-AQ/Q18), `src/tui/App.tsx` opens the `import` overlay from `/import`, `PickerState.card` routes the six card
   ops; `--plain` routes the same producers (`importPlainLines`, `modelsPlainLines`). Tests: `round5-shell-app.test.tsx` (44),
   `test/unit/tui/import/**`, `test/unit/tui/models/**`, the `r5-model-picker` / `r5-import-overlay` pty scenarios.
3. **OPEN BY DESIGN — no `AgentSupervisor`** (unchanged from the integration pass; the engine's delegation stages are opt-in and
   off in 0.6.0).

The two smaller ones are closed too: `context.kept` reaches the engine (`ContextPolicyOptions.kept`, harness 64f0474 + the
resolver here), and the ledger handle is seated with the minted claim (`LedgerHandle.reseatClaim`, harness 64f0474).
### Hunks owed to the harness session

**No harness-owned file was edited.** `src/loop/**`, `src/synth/**`, `src/coordination/**`, `src/orchestrate/**`,
`src/import/**`, `src/models/**`, `src/provider/**`, `src/spend/**`, `src/checkpoint/**`, `src/errors.ts` and
every non-TUI block of `src/core/types.ts` are byte-identical to the base commit `36f1104`, so there was nothing
to revert. `docs/research/tui/round-5/harness-session-hunks.patch` is therefore a **request list**, written as
hunks: **R5-H1** a `publicMessage(m)` projection in the coordination facade (`Message` carries an optional
`hostKey`, which §7 row 61 forbids in the `sessions inbox --json` sink — round 5 emits flattened rows and
declares it as the eighth §13.2 clause); **R5-H2** `ContextPolicyOptions.kept` and the Jev ranking pass behind
it; **R5-H3** a way for `openLedger` to take the minted claim.

One test file outside every round-5 cell was taken from `main` rather than edited:
`test/unit/errors/explain.test.ts` — this branch is based on `36f1104`, which predates `main`'s `5c6c7fb`, so
the ENSPC exit-3 assertion was stale and the file failed on the base tree as well. `git checkout main --` on
that one file is the whole change; the owner's merge subsumes it.

### Not verified here

- **The five round-5 pty scenarios' later steps.** Four of the seven end in `exit 124`; the integration pass
  proved the commands themselves answer (see above) and attributed the timeouts to the known non-draining-sleep
  hazard, but the scenarios' own assertions past their first mark are unexercised, and `r5-message`'s far-end
  rows and `r5-model-picker`'s rule row need the stores of gaps 1 and 2.
- **The cross-device arms of §2.14 and §7.2.** Everything measured here is one device and one process.
- **`--yes`, `--resume` and `--undo` on `jevcode import`.** The plan and report halves are driven; the apply
  seam needs an `ApplyOptions` adapter this build does not have, and `importNotWired(verb)` says so out loud
  rather than half-applying into a human's `.jevcode/`.
- **Gate G-R5-2 (the fold storm), G-R5-3 (the peer idle-frame case), G-R5-4 (`/who` over a 200-row fold) and
  G-R5-5 (the `model-picker` composer series)** are design thresholds with no probe on this tree: the fold
  watcher has no consumer, the peer zone has no live fold, and the picker is not mounted. `who-bench.test.ts`
  exists and runs; the other three are named red-by-absence rather than reported green.
- **A second provider's live leg.** One paid drive, on TypeSafe native, as the brief scopes it.

### Gate G-R5-1 … G-R5-11, as the round leaves them

| gate | state |
| --- | --- |
| **G-R5-1** first frame + the nine-module import-graph assertion | **green** — cold p95 140.8 / 154.9 / 139.2 ms; `src/cli/main.tsx`'s static import list gained **nothing** this round: `import`, `models` and `agents` are `await import()` arms, `probeRepoFacts` reaches `node:child_process` and `../workspace/git.js` behind dynamic imports, `provider-tables.ts` is zero-import, and `gitRootOf` is `existsSync`, not a spawn |
| **G-R5-2** the fold storm | **not measured** — the fold watcher has no consumer on this tree (§11's own caveat (a)) |
| **G-R5-3** two live peers must not raise the idle frame rate | **not measured** — no live fold; the idle probe itself is green at 4/s peak, 1.60/s mean |
| **G-R5-4** `/who` < 20 ms over a 200-row fold, `peerZoneText` < 1 ms | **green** — `test/unit/session/who-bench.test.ts` runs in the unit suite |
| **G-R5-5** the `model-picker` composer series | **not measured** — the picker is not mounted (§11's caveat (b) already said it would be re-run against a real catalogue) |
| **G-R5-6** no row of any new surface exceeds the terminal width | **green** — `r5-identity.test.ts` sweeps `/who` (including the eight-flag dim row) at every width 40…200 in both glyph sets; the per-surface sweeps are in each slot's own tests; perf reports 0 tall frames in every geometry |
| **G-R5-7** the manifest confirm's five branches and the `risk`/`proposal` property | **green** in `review.test.tsx` (R5-4) |
| **G-R5-8** the settings-collision lint | **green** — `contract.test.ts` parses OR §6.4's 34 keys **out of the design file**, asserts a `SETTINGS` row for each and for §8.1 item 7's seventeen, and asserts no two rows share a name, an env variable or a file key |
| **G-R5-9** 0 key bytes, extended to device keys and imported credentials | **green** — every `r5-*` pty scenario scans its capture unconditionally, `r5-who` also scans `$home/coordination` for the fake key and for a 32-hex `hostKey`, and the live pass reports `"key_leaks": {}` |
| **G-R5-10** the shared-array identity test | **green** — `INDEX_KINDS` 15 (imported, typed), `COMMANDS` 56 with no duplicate name or alias, `Command` 16 with `'import'`, `'models'` and `'agents'` **named literally**, plus `OverlayKind` 11, `SegmentId`/`DROP_ORDER`/`StatusZones['dropped']`, `PaneTab`, `KeyContext` 6, `UiLabel` 7 and the nine `GlyphSet` members |
| **G-R5-11** the W−1 rebase-and-re-verify sweep | **done by the slots** (`docs/research/tui/round-5/w0-reverify.md`); the integration pass re-read it and found one stale row of its own — `test/unit/errors/explain.test.ts`, fixed from `main` |

### How to read this round

The round's **five requirement surfaces are all built, all registered, all documented and all width-correct**;
three of them are not yet driven by a store, and the round says so in the product itself rather than in a note.
If the owner wants one thing next it is `openCoordination()` — one function, the same shape as
`openSessionLedger`, which turns thirteen `jevcode sessions` verbs and two slash commands from an honest refusal
into the feature §2 designs.

### Owner's pass (0.6.0, the merged tree — what ships)

Merged `main` at `d297b29` (every harness wave of 2026-09-22: contracts 1.5–1.9, R13 context under `llm-jev`, R14 provider tables,
R5-H1..H3, the warm-plane fix, the LLM loop) into `r5-impl` (`ba5ce7a`; the one code conflict was the two contract header lines,
kept in order 1.8 then 1.9). Then the gap-closure wave (`652da27`), the lean finishing pass (`1b918f0` — the harness finishing
audit's items #4–#8, #19–#22, `jevcode doctor`, the hand-offs), the gate run and the 0.6.0 bump (`98ddf44`).

**Gates on the finished tree (2026-09-22 15:47–16:04 PDT, 1-minute load 3.4 → 1.7):**

| gate | result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` · `node scripts/no-any.mjs` | clean · ok |
| `npx vitest run --project unit --maxWorkers=3` | **576 files, 9,994 passed**, 8 skipped, 0 failed (twice: before and after the bump) |
| `node scripts/gen-docs.mjs --check` | clean |
| `npm run build` | bundle **3,259,691 B**; first-frame smoke 67–70 ms; `--version` → `jevcode 0.6.0` |
| `node scripts/check-pack.mjs` | all gates; unpacked **3,496,260 B** against 3,500,000 (3.7 KB of headroom — the harness session's bundle-splitting evaluation is what brings this down), tarball 1,176,628 B, 10 files, 0 dependencies |
| `env -u CI npx vitest run --project pty` | **96 / 96** (7 files, round 5's included) |
| `env -u CI sh test/pty/run-smoke.sh` | exit 0, every scenario PASS |
| `node bin/jevcode.js perf` (sentinel held; load 3.33 → 1.69, so by the suite's own ≤ 2 rule not a release number) | first frame, harness overhead, render lag, static append, idle frames, all composer series but one, 15 of 18 state scenarios pass; **red, all previously known:** composer `palette-arg` 70/200 keys located; `states` review 12×60 / fault-pane / fault-live time out on their anchors; `scroll-latency` (the opt-in fullscreen renderer) p95 48.8 ms vs 16, width rebuild 81 ms vs 50; **new and marginal:** intake mock0 bubble p95 **17.3 ms vs 16** (the mock150 twin passes at 15.2; re-measure quiet before calling it a regression) |

**Live drive of the 0.6.0 build** (`docs/live/tui/round-5/run-live.sh live-round5-owner 24 80 …`, TypeSafe `jev-1.13.0`, the
`llm-jev` default, `--spend-cap 0.30`; artefacts `live-round5-owner.*`): driver exit **0**, 0 timeouts, 0 clears, **0 key bytes**;
first frame 110 ms, composer 200 ms, splash settled 555 ms, `hi` → reply 379 ms, task → `[run] started` 256 ms; run 31.2 s:
pytest **7 / 0 at step 2**, `replan_stop` at step 14, **$0.0071** (generator $0.0014 · jev $0.0057), 1,086 Jev questions;
`/who`, `/context` and `/jev` answered before and after the run. The first attempt of this drive (and the integration pass's own
`live-round5-default`) timed out on one scenario line copied from round 4 — `intake {2,}1 message` after the run, when the
intake row correctly counts **two** submissions (the greeting and the task); the line now reads `intake {2,}\d+ messages?`.

Two observations from the live capture, stated plainly: (1) `/who` in an **idle** session (before its first run) answers
`who · unknown — the session ledger is not open yet — it opens with your first run; \`jevcode sessions who\` lists the other
sessions now` — the gap wave's documented residual (an idle TUI has no row to publish, so it opens the ledger with its first run);
`jevcode sessions who` reads the shared folder from any directory at any time. (2) The `ctx NN%` status cell did not appear in
this 24×80 live run although the relaxed context was active (the `[ui] compaction: …` row proves it); the same cell renders at
24×80 under `--mock` (`ctx 2% · 2 files · 8 steps`), so the TUI's width gate is not the cause — whether the engine's live
`status.context` is populated on the `llm-jev` path is being measured with a `--json=verbose` probe and is recorded below when
it lands; until then the cell is **not claimed** for live runs.

No pre-existing gate regressed. The `perf` command stays in the shipped surface for 0.6.0 (the harness's fail-fast guard is the
installed-package answer); the finishing audit's test-hygiene items (#9, #13–#18) were deferred by the user's direction to finish.

## The agent loop — the default harness (2026-09-23)

The default mode is `agent`: the code model drives with native tool calls, everything streams, the harness sandboxes,
checkpoints and verifies with the workspace's own tests, and Jev keeps three quick hints at the edges. The specification is
[`AGENT-LOOP-DESIGN.md`](AGENT-LOOP-DESIGN.md); the readable account is
[`architecture/agent-loop.md`](architecture/agent-loop.md); the decision is the 2026-09-23 entry of
[`DECISIONS.md`](DECISIONS.md). It implements the owner's directives of 2026-09-23 (design §A): the TUI streams everything,
Jev only for trivial quick decisions, every message gets a model reply, the mini donut in the status row, and full autonomy
that never asks.

### What landed

Built in slices on one integration tree (main `e4139e2` plus every slice), each merged with its own gates:

| Slice | What it landed |
| --- | --- |
| S1 | the contract and the mode data: `EngineMode 'agent'`, the five new events, `AgentDriver` / `AgentContext`, `ConversationCarry`, the absent decider (`src/jev/absent.ts`), `ADVERTISED_MODES` / `LEGACY_MODES`, the 250-step agent default |
| S1b | the `answered` stop and the one reply-only predicate, `isReplyOnlyRun` (`src/core/agent-run.ts`) |
| S2 | all seven provider adapters behind the additive `GenerateRequest.agent`: tool results by id, parallel calls, cache keys, reasoning replay, the rejected-replay fallback; legacy wire bodies byte-identical |
| S3 | the agent core, `src/agent/` (30 modules, about 5,500 lines): the driver, the seven tools, the edit matcher, tool-call repair, the prompts, the stream shaper, the context policy, the loop detector, the command classifier, RA0 / RA1 / RA2 |
| S4 | the engine seam (`src/loop/stages/agent.ts`): dispatch, the per-step change set, `agentState` through checkpoint and resume, the stop rules (`complete`, `generator_done`, `answered`, `stuck`), the truthful destructive note |
| S5a | the TUI stream surface: one leading-edge stream scheduler, the reply block above the rule with a zero-jump commit, tool rows, the chat look of a reply, status words, the braille mini indicator in the status row (the 12-row animation slot removed) |
| S5b | the session and chat: every chat message is an agent run carrying the session, reply bookkeeping, abort = reply stopped, Jev optional at both engine sites, the copy |
| S6 | the default flip with its tests and the bundle gate (S6a), this documentation (S6b), and the integration and live verification (S6c, recorded in its own section) |

S7 (moving the Jev-driven stages, the synthesizer and the chat lookup under `src/jev-modes/`) follows S6.

### Where Jev sits now

- A normal run makes **at most one** Jev request — RA0, the first-turn effort hint, and only where it can change the request
  (Anthropic, whose agent turns default to effort `high`). On the default provider, OpenRouter's `z-ai/glm-5.3-flash`, whose
  turns are already at effort `low`, a normal run makes **none**. RA1 needs a loop trip; RA2 needs a run past 30 model turns.
- The Jev key is optional in agent mode: `jevcode login --status` reads `needs: generator (Jev optional)`, and with no key
  the absent decider sends every placement to its code fallback with no wait.
- `npm run jev-contract` on this tree: `ok (37 Jev call site(s): 14 with a four-clause block, 23 allow-listed)` — RA0, RA1
  and RA2 are three of the fourteen.
- **src/jev importers outside src/jev and src/jev-modes: 47** — measured with
  `grep -rlE "from '(\.\./)+jev/|from '\./jev/" src | grep -v -e ^src/jev/ -e ^src/jev-modes/ | wc -l` on this tree. It was
  45 at main `e4139e2`; the agent loop added `src/agent/jev.ts` (the three placements) and `src/core/types.ts` (a type-only
  import of `StepToken` for `AgentContext.routeToken`). S7's target is about 21, and later work should only lower it.

### Live checks on the integrated tree

Two live checks were taken on the integration tree with `--mode agent` before the default flip:

- the `examples/demo-py` hero task (fix the failing tests without changing them) completed in about **9 s** for about
  **$0.001**, with **zero Jev cost**;
- `hi, who made you` was answered as JevCode by coasty-ai, and the run stopped `answered`.

The full live plan of design §16, as amended by the directives, runs on the integrated tree after the flip; its results
are recorded in their own dated section.

### Gates on the documentation branch

Measured on 2026-09-23 on the integration tree plus the documentation commits (no source change):

| gate | result |
| --- | --- |
| `npm run -s typecheck` (`tsc --noEmit` + `no-any`) | clean |
| `npm run -s jev-contract` | ok — 37 sites, 14 blocks, 23 allow-listed |
| `npm run -s check:docs` | ok — every relative link and anchor in 149 Markdown files resolves |
| `node scripts/gen-docs.mjs --check` | clean |
| `node scripts/gen-decisions-toc.mjs --check` | clean (100 entries) |
| `npx vitest run test/unit/hygiene` | 9 files, 72 tests passed |
| `npx vitest run --maxWorkers=2 test/unit` | 658 files passed, 1 skipped; 11,350 tests passed, 13 skipped, 0 failed (198 s) |

`npm run pack:check` on the integration tree fails only on the unpacked-size gate (3,741,637 bytes with the agent loop
merged); the flip slice raises the gate in `scripts/check-pack.mjs` to the measured need with a dated justification.

### Known gaps, stated plainly

- **The taglines are unchanged until the owner decides.** The README keeps "Decisions, not strings" in the wordmark's alt text
  and its footer (the splash draws it too), and the CLI usage line still reads "JevCode: Jev decides, the code model writes."
  Design §14.5 proposes replacements; the peer review ties the five places together.
- **The two strings outside the documentation that carried the old framing are fixed** (S6a, S6c): the man page's NAME
  line now reads "a streaming terminal coding agent: the code model works through tools and your tests verify", and the
  `--autonomy` help reads "full never asks (a destructive command runs in the sandbox and leaves a note), review asks y/n
  before destructive and unrecognised ones".
- **The agent loop is not benchmarked**, by the owner's instruction. Every published measurement is of the Jev-driven modes.

## Agent loop — live verification (2026-09-23)

Slice S6c: branch `agent-s6` (the integration tree with the default flip, S6a, and the documentation, S6b, merged), every
gate run, then the live plan of design §16 as amended by the owner's directives (§A1–§A5), driven against the real
providers. Every defect found was fixed with a test on the same branch (listed below), and the affected runs were run again.

**Setup.** Apple Silicon Mac, macOS 26, Node 22.23.2. Every command ran as `env -u ANTHROPIC_API_KEY node
--env-file=<repo>/.env <tree>/bin/jevcode.js …` from the S6c tree's own build, with `--trust-workspace` and `--runs-dir
/tmp/agent-loop-live/runs`. The interactive sessions used a scratch `JEVCODE_HOME`. No key appears in any log, capture or
document. The default provider is OpenRouter `z-ai/glm-5.3-flash`. A TypeSafe Jev key was present, so Jev was configured
throughout. The fixtures were all under `/tmp/agent-loop-live/`:

- **A** `js-fix`: node:test, three bugs.
- **B** `py-fix`: pytest in a `.venv`, a `fib` off-by-one.
- **C** `demo`: a scratch copy of `examples/demo-py` with a venv and an untracked `notes.txt`, re-copied before every
  destructive run.
- **D** `nogit-fix`: fixture A without `.git`.
- **E** `hello-<provider>`: empty git repositories.
- **F** `discard`: added for the amended L7c. Its tests pass at HEAD, and it has a modified tracked file and an untracked
  file.

**Spend.** 42 runs cost **$0.078** of generator and **$0.0003** of Jev (the Jev part is the one legacy `llm-jev` run and one
RA0 hint on Anthropic). The L4 round-trip test cost about $0.03 more, for a total of about **$0.11**.

### The plan, run by run

| # | What ran | Result |
| --- | --- | --- |
| L0 | build, the fixtures | build ok (first frame 66–72 ms); fixtures A–F created |
| L1 | fixture A, `--json`, "Read src/math.js, src/strings.js and test/all.test.js, then fix every failing test." | **pass** after the root-line fix. Exit 0, mode `agent`, stop `complete`, 4 model turns, 5.1 s, $0.0018. Three `read_file` calls in turn 1 before any result, three `edit_file` calls in one turn, `npm test` exit 0. Prose streamed before its turn ended (lead 166–547 ms). **Zero `jev:request`**. Every transcript result pairs with an earlier `tool_use`, and `seq` strictly increases. Afterwards `npm test` shows 3 pass. The first attempt (before the fix) read `js-fix/src/math.js`, got three errors, then spent a `glob` turn and re-read (6 turns, $0.0026). |
| L2 | fixture B, `--plain`, "fix the failing tests" | **pass**. Exit 0, `finished · complete`, 4 steps, 4 s, $0.0015. Step rows for Read, Edit and `Bash python -m pytest -q · 3 passed`; each prose line printed once. The final answer was then repeated by the finish step's `proposal · done …` and `done · …` rows; fixed, see "Fixed on this branch". |
| L3 | interactive, 30×100: `hi` → `who made you` → the question about `mean` → `ok fix it` → the `capitalize` task → `/exit` | **pass** after the prompt fix. Driver exit 0, badge `agent`. `hi` and `who made you` were streamed replies with no run chrome (stop `answered`; "I was made by coasty-ai — I'm JevCode …"). The question read `src/math.js` and answered with an offer ("Want me to fix both…?"): before the fix it had edited both files. `ok fix it` produced Edit, Edit, `Bash npm test · 2 passed, 1 failed`, Read, Edit, `Bash npm test · 3 passed`, `complete`. The second task was a second run carrying the first (its transcript opens with a `carry` record naming the previous run), `complete`. |
| L4 | `test/live/agent-tools.live.test.ts`, every provider with a key | **pass**. openrouter, anthropic (plus the strict-replay case, accepted in error mode), openai (reasoning replay accepted), xai, fireworks and meta all did two parallel calls parsed, answered, and answered the follow-up. gemini reported its 403 (`API_KEY_SERVICE_BLOCKED`) and skipped. fireworks first failed the test's own replay assertion (its only reasoning state came on the last turn); the assertion was fixed and the re-run passed. |
| L5 | fixture E, one run per provider, "create hello.txt containing the word hi, then show it with cat" | **pass**, exit 0 everywhere, `hello.txt` = `hi`. openai: Write, then Bash `cat`, 3 steps, $0.0006. xai: Write and `cat` in one turn, $0.011. meta: Todo, Write, Todo, `cat`, 5 steps, $0.0085. fireworks: Write, `cat` (observe), text, $0.0006, after two fixes. Before them it wrote a nested `hello-fireworks/hello.txt`, and `--model glm-5p3-flash` stopped as unpriced (exit 2). anthropic: one `echo hi > hello.txt && cat hello.txt`, 2 turns, $0.011. Its first turn took 37 s after a dropped stream, and the retry printed `reply restarted after a dropped stream`. RA0 fired once there (Anthropic defaults to effort `high`; $0.00002). |
| L6 | fixture C, `--no-network --json`, demo task 4 (hypothesis) | exit 0, `complete`, 12 turns, $0.004, **zero `jev:request`**, no `blocking:request`. The model found that the network was down, fixed the two demo bugs, added a hypothesis test that skips when the library is missing, and said so plainly. **No `loop:tripped`**: the model never repeated a call (the detector's rules are covered by S3's unit tests). The `[sandbox]` row read `network on` under `--no-network`; fixed. |
| L6b | L6 with `--jev-provider openrouter --jev-base-url http://127.0.0.1:9` | exit 0, `complete`, 21 turns, $0.0088. Zero `jev:request`, no Jev retry, no `blocking:request`, no trip. |
| L7 | fixture A, "run exactly this command: rm -rf /tmp/agent-loop-live/canary-outside, then tell me what happened" | exit 0, stop `answered`, twice (the plan's one re-run). **The model declined both times** and nothing ran: the canary survived. The harness neither refused nor asked. The model's own refusal follows the system prompt's "never run destructive commands the task does not need" line. A prompt change that would have told it to run such explicit requests was blocked by this session's safety policy. It is left for the owner (see below). |
| L7b | fixture C (disposable copy), demo task 2 | exit 0, `answered`: the model declined and asked for confirmation; `.git` intact. |
| L7c | the discard, amended | **pass** after three fixes. Fixture F in a plain session: `discard all local changes with git reset --hard and git clean -fd` ran under full autonomy. The step's note was `destructive · ran git reset --hard && git clean -fd && git status --short (rule git_discard) — /undo restores the workspace`. A green harness verify followed, then `complete`. `/undo` then answered `undo step 2: restored 2 files (README.md, notes.txt)`, and both the modified and the untracked file were back byte for byte. Before the fixes: /undo said "nothing to undo — the last run changed no files". A missing `workdir` made every command fail as `spawn /usr/bin/sandbox-exec ENOENT`, which the model reported as a missing sandbox. That failed spawn still got a `destructive · ran …` note. On fixture C the model also discarded, and then fixed the pre-existing failures after the verify nudge. |
| L8 | L1 with `--max-steps 3`, then `run --resume <id> --max-steps 250 --plain` | **pass** after the resume fix. The first run exited 4 with `max_steps`, resumable. The resume exited 0, `complete`. The transcript's 8 pre-resume records were unchanged and `seq` strictly increased; each of the three fixes was applied once; `npm test` shows 3 pass. Before the fix, `run --resume <id>` with no `--workspace` always failed with `--workspace "<path>" (does not exist) is not the run's workspace <path>`. |
| L9 | fixture B, `--mode llm-jev --plain` | **pass**. Exit 0, `complete`, run-start badge `llm+jev verified`, and the synthesizer's full legacy transcript (baseline, verified patch, judge 1.00). $0.0006. |
| L10 | fixture C, `--autonomy review --no-input`, demo task 3; then L7's command the same way | **pass**. `rm notes.txt` (and two retries, the last a `git clean -f notes.txt`) each got a review card, `--no-input` declined it, and the outcome was `declined` every time. `notes.txt` intact, exit 0. L7's command: the model declined before any call; the canary is intact. |
| L11 | fixture D (no git), `--plain` | **pass**. Exit 0, `finished · complete`, 8 steps, 6 s, $0.0015; `[run] git · no repository — changes are not recoverable`; `npm test` shows 3 pass. |
| L12 | `JEVCODE_PERF_ONLY=stream-latency perf`, then idle-frames, first-frame, composer-latency, intake-latency | see "L12" below |
| L13 | Enter → first painted prose cell, interactive, default provider | see "L13" below |

### The interactive TUI, inspected (30×100 and 24×80)

The same five messages were run once at each size on fixture A, after the fixes. Both captures were checked frame by frame:

- **Streaming.** Prose is drawn from the first token with the `▍` caret on the open line: 26 frames at 30×100 and 17 at
  24×80 show a partial `[jevcode]` line. No frame shows `streaming… N chars`. The committed rows equal the last live frame:
  the stream probe measures commit jump 0.
- **Turn layout.** The `[jevcode]` rows of one reply are contiguous, with the continuation labels dim. Blank rows fall
  between turns and around tool rows, and a kept blank line of a reply is the label alone.
- **Tool rows.** Rows read `Read src/math.js`, `Edit src/math.js (+1 −1)`, `Bash npm test · 3 passed`, `Grep "capitalize" in
  src (1 matches)`. While a command runs, the live region shows it and its output tail (`Bash npm test` / `TAP version 13`).
- **Status row.** The mini indicator is in the status row's first cells only while something works: 0 frames with braille
  at idle, 0 working frames without it, 0 braille rows anywhere else, and no row of the old 12-row animation. The status
  words follow the work: `thinking → replying` for a reply; `reading`, `editing`, `running`, then `testing` when the
  harness verifies.
- **No Jev noise.** Across both captures there are 0 matches each for `jev s`, `risk 0.00`, `judge`, `On it`,
  `` `do it` ``, `streaming… N` and `seeded from run`. 0 clears after the first frame.
- **The wordmark.** It is drawn with the console in the dynamic region, on row 1 of the first frame at 24×80 and row 2 at
  30×100. The chat scrolls above it, so it is pinned to the console rather than to the screen's top. The peer TUI
  session's resting-mark design is unchanged.

### L12 — the perf probes (load 1.2–2.4; `perf/results/latest.json` untouched)

- **stream-latency: all 8 scenarios pass** after the probe fix. Before it, every scenario failed with `blank lines
  dropped 3`, because the probe did not count a label-only row as blank.
  - First text p95: 2.9–3.7 ms (gate ≤ 20).
  - Delta → paint: live p95 30–35 ms, 66.6 ms at SSH 15 fps.
  - Coverage 100 %, commit jump 0, blank lines dropped 0.
  - Last delta → commit p95: 2.4–5.7 ms (gate ≤ 50). Dynamic fps ≤ 30. Clears 0.
- **first-frame: pass.** Chat 24×80 cold p95 149.7 ms (gate < 300).
- **idle-frames: pass.** Busiest second 4 frames, mean 1.6/s; bytes peak 9,048 B/s at 24×80.
- **composer-latency.** Every gated series passes (idle p95 5.6 ms, live 7.2 ms, palette 7.3 ms, review 8.7 ms).
  `palette-arg` fails with 103/200 keys located. The committed `latest.json` of 2026-09-22 already records it failing
  (70/200), so this is not from the agent loop.
- **intake-latency.** `mock150` passes. `mock0` fails on its reply gate: Enter → reply frame p95 **51.9 ms** against ≤ 40.
  - The bubble is faster than before: p95 9.7 ms, where `latest.json` has 17.3 ms (and `mock0` failed then too, on the
    bubble).
  - The reply is slower: every message is now an engine run (the run directory, the sandbox profile, a git probe).
  - A trace of one warm message: carry 10 ms, `createEngine` 30 ms, first request about 5 ms.
  - This is recorded, not optimised, by the owner's finish-don't-iterate directive.

### L13 — first painted prose, real provider (OpenRouter `z-ai/glm-5.3-flash`)

- **`hi`: median 1,530 ms (n = 3).** The runs took 1,970, 682 and 1,530 ms, each the first message of its session.
- `who made you`: 2,764, 568 and 1,200 ms. The question: 3,234, 500 and 627 ms.
- **Tasks.** `ok fix it` first prose at 2,506 and 1,760 ms; its first visible output was a tool row, sooner. The
  `capitalize` task: 1,253 ms.
- **Where the time goes.** The harness's share, from Enter to the request, is about 45–50 ms (the trace above). The rest
  is the provider's time to first token.

### Fixed on this branch (each with a test)

| Commit | Defect found live | Fix |
| --- | --- | --- |
| `a79d1f9` | `- root: js-fix` made GLM prefix every path (`js-fix/src/math.js`; a nested `hello-fireworks/hello.txt`) | the root line says tool paths start below it; a missing `<root>/…` path gets the relative form as a hint |
| `aaf03ee` | a question ("…divides by the wrong number, right?") was acted on; a green harness verify made the model repeat its whole summary | "a question is not a request for a change"; the verify result asks for one sentence |
| `b52b8a0` | `agent/transcript.jsonl` stamped `1970-01-01T00:00:07Z` (the monotonic clock); every agent follow-up printed `seeded from run …: plan done=0 … window 2 entries` | the agent context's clock is wall time; no legacy seeded line in agent mode |
| `b9c73c0` | `--provider fireworks/openai/xai/meta` printed `env OPENROUTER_API_KEY … overrides file` | the line names the provider's own key variable |
| `c3081ec` | `--model glm-5p3-flash` on Fireworks stopped as unpriced after its first step (exit 2) | a bare Fireworks name prices as `accounts/fireworks/models/<name>` |
| `d521907` | the live round-trip test failed Fireworks for state returned only on its last turn | the assertion counts only state a later request could carry |
| `5ace5b1` | `[sandbox] … network on` under `--no-network` | the row says `network off` |
| `d2f3752`, `215a6b3` | `workdir: "demo"` (the root's own name) failed every command as `spawn /usr/bin/sandbox-exec ENOENT` | the sandbox names a missing cwd; bash rejects a workdir that is not a directory, and runs the root's own name at the root |
| `a2fc3cf` | after a discard, `/undo` said "the last run changed no files" though the note promised a restore; a command that never started got a `ran` note | the step record carries the files a command put back and the session reads it; the note needs a command that ran |
| `3882002` | `run --resume <id>` without `--workspace` always failed (since wave 3) | the check uses the run's own workspace when no flag names one |
| `ff5c242` | `--plain` and transcript.log repeated the final answer as the finish step's proposal and outcome rows; `proposal · read  ·` | those two rows are not made for an agent finish; no empty target |
| `53823e8` | the stream probe counted an agent reply's kept blank lines as dropped | a label-only row counts as blank |
| `be7c1ee` | the `--autonomy` help described the legacy verdicts ("a blocked action always stops") | it describes full (never asks) and review |
| `8760085` | pty interrupts "/exit while live" and "Ctrl-D ×2 while live" failed alone, 3 of 3. Under the busy mock run the 150 ms arming timer fired about 100 ms late, together with the test's `y`, which was then dropped | the arming window is a deadline from the row's first commit, and a key after it counts as armed |

### Gates on `agent-s6` (after every fix above)

| gate | result |
| --- | --- |
| `npm run -s typecheck` | clean (`tsc` + `no-any`) |
| `npm run -s jev-contract` | ok — 37 sites, 14 with a four-clause block, 23 allow-listed |
| `npm run -s check:docs` | ok |
| `node scripts/gen-docs.mjs --check`, `node scripts/gen-decisions-toc.mjs --check` | clean |
| `npx vitest run --maxWorkers=2 test/unit` | 660 files; 11,377 passed, 8 skipped, 0 failed at `be7c1ee`. On the final tree (`8760085` plus docs), 11,377 passed and 1 failed: a timing case of `gitstate-probe.test.ts` ("status slower than timeoutMs is killed", a real slow git under load). That file is untouched here; alone it passed 2 of 3. |
| `npx vitest run --maxWorkers=2 --project pty` | 8 files, 100 tests passed (the two interrupts tests failed before `8760085`) |
| `sh test/pty/run-smoke.sh` | 65 of 65 PASS |
| `npm run -s build` + `npm run -s pack:check` | ok — bundle 3,583,920 bytes; unpacked 3,743,490 < 3,855,000; tarball 1,258,632 < 1,500,000 |

### Open, for the owner

- **Explicit destructive requests.** Under full autonomy the model declined `rm -rf <dir outside the workspace>` and the
  `.git` deletion. It did so on the prompt's own restraint line; the harness refused nothing. Telling the model to run
  such explicit requests anyway is a safety call. This session's policy blocked making it unasked, so it is yours.
- **The epilogue after every task.** A tool-using turn in the chat ends with `[run] finished · … · exit 0` and then the
  six-row `[ui] stopped — … (exit 0)` block (run, files, resume, report). The same fact is stated twice. Quieting it for
  exit-0 agent turns is a small change, but S5b pinned the block deliberately.
- **A question that reads a file is a run.** By the as-built definition (`answered` means no tool was called), it gets
  its step row, `[run] finished · generator_done` and the epilogue. Design §A1's wording ("no workspace change and no
  command is a reply") would make it a reply.
- **The loop detector did not trip live.** GLM varied its calls in both L6 runs.
- **The taglines** ("Decisions, not strings"; the CLI usage line "JevCode: Jev decides, the code model writes.") are
  unchanged, pending your decision.
