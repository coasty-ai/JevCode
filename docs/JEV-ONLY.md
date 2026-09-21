# JevCode, Jev-only: a coding agent with no generating LLM

Status: research brief and running log, started 2026-09-20. Everything here is a hypothesis
until a table in `experiments/` says otherwise.

## The constraint

Jev (`typesafe/jev-1.13`) evaluates a JSON state against typed questions and returns calibrated
probabilities. It answers three kinds of question: Noul (yes/no), Choice (one of ≤ 255 named
options), Score (position on a ≤ 10-level rubric). **It does not generate text** (REPORT §1).
Measured: ~170–250 ms per request regardless of question count, 1,000 Nouls in one request,
$0.042 per million input tokens, output free, 128-way concurrency without rate limiting,
calibrated and sharp on clear judgments, noisy (±0.02) in the 0.55–0.80 band, literal.

So a Jev-only coding agent cannot "write" code the way an LLM agent does. It has to **search**:
code (deterministic, cheap) proposes; Jev (fast, calibrated) decides; tests, the compiler and
the linter verify. The question this document answers by experiment is which decomposition of
"write a fix" into proposals-and-decisions works, and how far it reaches.

## Why this can work at all

1. **Program repair was search before it was generation.** GenProg, Prophet, TBar, SimFix and
   CapGen fixed real bugs by enumerating candidate edits from mutation operators, fix
   templates and "donor" code already present in the repository (the plastic-surgery
   hypothesis: most fix ingredients exist elsewhere in the same project). Their bottleneck was
   *ranking*: thousands of candidates, a handful correct, tests too slow to try them all.
   Prophet learned a ranker from past fixes and doubled the success rate. Jev is a fast,
   calibrated, general ranker that reads the failing test and the code.
2. **Jev is a strong selector.** REPORT §9–§11: 12-way Choice on topics 100 %; rerank of 218
   candidates top-1 5 % → 18 % with one Noul per pair; 255 informative options answered at
   confidence 1.0; entailment 0.98 accuracy. Selection over a few hundred concrete candidate
   edits is squarely what it is good at.
3. **Jev is fast and cheap enough to be the inner loop.** A beam search that asks Jev to rank
   200 candidates costs one request (~250 ms, ~$0.0003). Ten rounds of localise → rank → verify
   is seconds and cents. Tests, not Jev, are the ground truth; Jev's job is to make the number
   of test runs small.
4. **Generation can be reduced to a sequence of Choices.** A fix line can be built as a path
   through a grammar: statement kind → expression shape → identifiers from scope → literals
   from the test. Each decision is a Choice over a code-computed option set with the code, the
   failing test and the partial line in the state. Whether Jev's judgment survives 10–30 such
   decisions in a row is an empirical question, measured below.

## Candidate sources (code proposes)

| Source | What it enumerates | Cost | Where it comes from |
| --- | --- | --- | --- |
| Mutation operators | operator swaps (`<`↔`<=`, `+`↔`-`, `and`↔`or`, `==`↔`!=`), off-by-one (`±1`), index flips, argument swaps, negations, constant substitutions from literals in the test | thousands/line | GenProg, TBar |
| Fix templates | null/None guards, missing return, missing import, wrong attribute (Choice over attributes of the receiver), wrong call target (Choice over functions in scope), missing `else`, boundary condition | tens/site | TBar, Refactory |
| Donor code | lines/statements elsewhere in the repo that reference the same identifiers, adapted by identifier substitution (Choice over in-scope names) | hundreds/site | plastic-surgery hypothesis, SimFix |
| Test-derived values | expected literals, expected types, expected exceptions and messages parsed from the failing assertion | few | Agentless-style reproduction, program synthesis by example |
| Grammar-guided synthesis | new lines built by Jev Choices over grammar productions and in-scope identifiers, beam-searched, verified by tests | slow (10–30 requests per line) | this project |
| Repository history | past commits that touched the same function or symbol (`git log -S`), replayed as templates | tens | history-based repair |

## Decisions Jev makes (Jev decides)

- **Understanding**: Choice over the kind of change (fix a wrong value / add a guard / add a
  branch / change a call / add a function / change a signature / configuration / unknown),
  Nouls per file and per symbol named or implied by the task text, Choice over which failing
  test to attack first.
- **Localisation**: Nouls over candidate files (existing context stage); Choice/Nouls over
  functions; Choice over lines of the located function, combined in code with spectrum-based
  fault localisation (Ochiai over coverage of failing and passing tests) when tests exist.
- **Ranking**: Choice over ≤ 255 concrete candidate edits (with the buggy line, the failing
  test, expected vs actual in the state), or Nouls per candidate when "none of these" is
  likely; beam of k kept for verification.
- **Progress**: after a candidate is applied and tests run, Nouls "did the failing test pass",
  "did a previously passing test break", "is the output closer to the expectation"; Choice
  over the next move (keep and continue with the next failing test, revert and widen
  localisation, try the next candidate source, stop).
- **Everything already in the JevCode loop**: intent, context, risk, judge, completion, replan.

## Difficulty ladder (measured in this order)

1. QuixBugs Python (40 programs, one-line bugs, tests as JSON): localisation, selection,
   end-to-end repair rate, cost, time. The classic search-based-repair yardstick.
2. `examples/demo-py` and hand-made multi-hunk tasks: two coordinated one-line fixes, a
   missing guard plus a test.
3. HumanEvalPack / HumanEval-fix style functions where the fix needs a new line.
4. SWE-bench Verified subset (the 30 already checked in) with the `jev-only` condition beside
   `jev-on` and `jev-off`: honest numbers, expected low.

## Success criteria for "surprisingly well"

- QuixBugs: ≥ 60 % repaired end to end with tests as the only oracle and Jev the only model,
  under $0.05 and 2 minutes per program (search-based systems without a learned ranker sit
  around 25–40 % here; the delta is the value of Jev as the ranker).
- Multi-hunk ladder tasks: solved by the outer loop decomposing per failing test.
- SWE-bench subset: any instance solved by a system with no generating model is a result;
  report it with the evidence and the failure taxonomy.

## Non-negotiables

- No generating LLM anywhere in the `jev-only` mode: the generator Provider is a
  `NullProvider` that throws if called, and the bench asserts zero generator tokens.
- Tests are the oracle; Jev never marks a fix correct on its own.
- Every candidate source is code with a unit test; every Jev question follows the REPORT rules
  (escape options, criteria, backticked paths, no counting).
- Every experiment writes a table under `experiments/results/` with the exact prompt shapes,
  n, accuracy, cost and latency, so the design is chosen by measurement.

## Log

- 2026-09-20: anchor probe on QuixBugs (localisation Choice over lines; selection Choice over
  mutation candidates) — see `experiments/results/anchor-probe.md`.
- 2026-09-20: **prototype baseline** (`experiments/results/prototype-baseline.md`, scripts in
  `experiments/prototype/`): localise (Choice over lines with tests and actual output) →
  first-order mutation candidates (15 operator families, cap 200) → one Choice per line → verify
  top-5 with the QuixBugs runner → adopt strict pass-count improvements, 3 rounds. **32/40
  repaired** (31 correct by inspection; 1 overfits), $0.035 total Jev, 62 s wall for all 40,
  mean 5.3 Jev requests and 10 test runs per program. Coverage ceiling 35/40 (4 insertion bugs
  and one two-edit bug are unreachable by single-line replacement). Failures: 4 coverage, 2
  localisation (true line rank 6 at p 0.02–0.03), 2 greedy-progress traps. Two runs of the same
  code agree on 30 repairs and 34 in at least one, so the flips sit in Jev's 0.03–0.30 band.
- 2026-09-20: measurement files landed (`experiments/results/*.md`, each with a verification
  section): localisation 28/40 top-1 with actual output, SWE-bench file localisation 24/30 top-1
  over ~219 paths and gold #1 on 23/30 over every repo file with plain Nouls; selection top-3
  37/40 even at 254 candidates, two-stage Nouls→Choice 33/40 top-1, fix-absent detector
  P(escape)−p_max ≥ 0.10 (AUROC 0.92); first-order mutations reach 38/40 gold fixes; donor line
  selection 35/36, identifier hole filling 13/13; token beam W=3 with a grammar filter rebuilds
  20/40 fix lines at $0.0037 per line, portfolio of routes 27–28/40; progress Nouls read
  code-computed counts perfectly but add nothing over code when counts exist; question-design:
  drop the unchanged line from options, include expected AND actual, thresholds 0.7 Choice /
  0.5 Noul.
- 2026-09-20 (evening): **design decision.** Four competing designs written from the measurements
  (`experiments/designs/`: test-driven-decomposition, contrarian/Sieve, repair-search, grammar-synthesis),
  three judges (reach, reliability-and-cost, integration) ranked test-driven decomposition first (8/10 each)
  and named the ideas to graft. The single architecture to implement is `docs/JEV-ONLY-DESIGN.md`
  ("Ledger + Sieve"): the test-driven goal ledger as the spine (one verified failing-test cluster per step,
  park-not-retry, partials held as a second base, `patch → run` alternation, fixed-form plan items), with the
  contrarian run-cost budget as the inner rule (run every candidate at a site when
  `|cands| ≤ floor(testWall × lanes / t_run)` and `t_run ≤ 2 s`; Jev orders the queue otherwise), behaviour
  clustering + `Q_arbitrate`/paired Nouls as the measured overfit guard (never withholding a lone passer),
  insert gaps as first-class sites, SBFL top-5 unioned, the `widened` all-lines phase as a later step on
  single files, the sketch Choice as a reach round before the token beam, and `hunk-subsets.py` ($0) plus
  `rank-at-scale.mts` ($0.15) before any live SWE condition. Predictions: QuixBugs 37–39/40 test-passing
  (35–37 correct), ladder 9–10/12, SWE 3–5/30. Measurements the decision rests on, one line per results file:
  - `anchor-probe.md`: line localisation top-1 13/14, fix selection 14/14 among tiny sets, $0.0009.
  - `prototype-baseline.md` (+ `prototype-baseline.jsonl`, `-run1.jsonl`): 32/40 repaired end to end (31 correct), $0.035, 62 s; failures 4 coverage / 2 localisation / 2 greedy-trap; all 8 hit the 40-test-run cap.
  - `probe-localization.md`: variant D (actual output in state) top-1 28/40, top-3 36/40; D ∪ C top-3 covers 38/40; SWE file Choice top-1 24/30, Nouls 26/30.
  - `probe-selection.md` (+ `.raw.jsonl`, `.noescape.jsonl`, `.verify.jsonl`): compact Nouls top-1 32/40 / top-3 36/40 at N = 254 ($0.00077, 331 ms); full-criteria top-3 39/40 at N = 150–254; two-stage 33/40 with the fix shortlisted 39/40; fix-absent detector `P(escape) − p_max ≥ 0.10` AUROC 0.916.
  - `probe-question-design.md`: dropping the unchanged line → 20/20 test-passing top picks, 0 confident misses; actual output removes 7/80 confident localisation misses; thresholds 0.7 Choice / 0.5 Noul.
  - `probe-progress-judgment.md`: progress Nouls 240/240 as pure functions of code-computed counts; code routing 240/240; `attack_first` simplest-first 16/34 vs 8/34 random, MRR 0.67.
  - `probe-donor-and-templates.md`: donor line 35/36 own-program, 32/36 at 254 options; identifier holes 13/13; insertion point 4/4 given the statement, 2/4 without; fix-kind Choice 62–75 % (never a gate).
  - `probe-token-synthesis.md`: teacher-forced 84 % / 96 %; W = 3 + grammar rebuilds 20/40 lines at $0.0037 and 3.3 s per line; portfolio 27–28/40.
  - `probe-swebench-understanding.md`: gold file #1 on 23/30 with Nouls over every repo file (≤ 5 on 28/30), function top-5 35/37, line ±3 top-5 94 %, chained 21/30; change-kind Choice 53 %.
  - `coverage-study.md` (+ `.json`): QuixBugs 40/40 reachable by the union of sources; SWE 6/30 strict, 9/30 with 2-sub donors, vocabulary ceiling 15/30; median 1,641 depth-1 mutants per SWE line (3 % ≤ 255) vs 225 on QuixBugs.
  - `lit-search-based-repair.md`: Ochiai top-5 34/38 on QuixBugs (top-1 7/38); Noul ranking of the developer fix 26/34 top-1 over a mean of 295 candidates; a reshuffle moved `kth` 0.48 → 0.14.
  - `lit-guided-synthesis.md`: slot Choices 90–93 % top-1; S2 diff-fill 23/25 (92 %) at B = 3, S1 full-fill 22/29 (76 %).
  - `contrarian-exhaustive.truth.jsonl`: every first-order mutant at the true line run through the suite: 4,892 runs, 260 s at 8-way, median 3.8 s per program; gold passes 35/36, gold is the only passer 25/36.
  - `contrarian-exhaustive.all.jsonl`: brute force over every code line: 37,243 runs, 1,181 s at 12-way, median 23.8 s / max 119 s per program; 0.5 s timeout rejected no gold; gold the only passer 21/40; passers on ≥ 2 lines 6/40.
  - `contrarian-arbitrate.truth.jsonl`: Jev among ≥ 2 test-passing candidates at the true line: Choice = gold 8/10, gold-or-equivalent 10/10, $0.0008, 189 ms p50; gold Noul 0.15 on `quicksort`.
  - `contrarian-arbitrate.all.jsonl`: cross-line plausible sets: 10/14 gold, 13/14 gold-or-equivalent; the all-overfit `depth_first_search` set rejected at escape 0.90 / max Noul 0.06.
  - `judge-1-reach.md`: test-driven 8.0, contrarian 7.5, repair-search 7.0, grammar-synthesis 5.0; flagged `pytest-7205` mis-cited as reachable and the sieve's unmeasured insertions.
  - `judge2-reliability-cost.md`: test-driven 8.0, repair-search 7.5, grammar-synthesis 6.0, contrarian 5.0; recomputed contrarian test CPU at 9.9× (true line) / 75.5× (widened) the prototype; the K = 3 justification cites full-criteria Nouls while the designs use compact.
  - `experiments/grammar-synthesis/out/sketch-*.json` (Appendix A of the grammar design; not under results/): sketch pool covers 39/40 gold shapes, Choice top-1 23–26/40, top-3 29–31/40, edit-class top-2 35–36/40, $0.00019 per program.
- 2026-09-20: **Ledger + Sieve engine, first live rungs** (`experiments/results/jev-only-rungs-1-2.md`,
  `bench/results/jev-only-quixbugs-1`, `jev-only-ladder-1`; `--conditions jev-only`, zero
  generator calls asserted per record). QuixBugs **34/40 repaired, 31 correct by inspection**
  (25 identical to the reference fix, 6 equivalent; 3 passers overfit the visible tests), median
  4 steps and 16 s, $0.19 total Jev for all 40, ranking misses 0, regressions kept 0. Misses: 4
  budget (hanging programs make every test case a 2 s timeout, so the oracle looked expensive
  and the search fell into RANK mode with 16 runs per step), 1 engine-rejected, 1 overfit.
  Ladder **4/12**: the synthesizer found test-passing patches for most tasks but the outer
  loop's risk stage put 35 of them in the review band (`plan_mismatch`, `matches_intent` under a
  fallback `investigate` intent), which the bench declines; the two-file `table` task was solved
  by the composite source as one unit. Eleven integration defects were fixed on the way (stale
  `.pyc` in shadow lanes, `-qq` pytest output, pytest not on PATH, lanes outside writable roots,
  collection errors counted as plausible, …). Next round: give the risk/intent/judge stages the
  synthesizer's verification evidence, size the per-test timeout from tests that finish, and add
  module-level import sites.
- 2026-09-20: **evidence round** (`experiments/results/jev-only-rungs-1-2.md` §8–§9). The
  synthesizer now attaches code-computed shadow test-run evidence to every patch and post-patch
  run (`Proposal.evidence`), the risk and judge stages put it in the Jev state with rubric
  clauses that distinguish a verified fix from "skipping verification", and the intent stage is
  ledger-aware in jev-only mode. Ladder **4/12 → 10/12** (1-hunk 6/6, 2-hunk 2/3, 3-hunk 2/3),
  patches rejected by the risk stage 35 → 7, Jev $0.28 → $0.10, wall median 325 s → 122 s; the
  two remaining misses are budget parks. Slow-oracle fix (per-test timeout from finished cases,
  one-alarm stop rule): 4 of the 4 hanging QuixBugs misses repaired, gold-identical; the
  vocabulary pre-check no longer drops import module paths (ladder `tagcloud` solved). Open:
  `shunting_yard`/`reverse_linked_list` insertion coverage, step policy (suite-first, single
  done-claims), SWE-bench rung 3.
- 2026-09-20: **SWE-bench rung 3, first attempt: 0/30** (`bench/results/jev-only-swebench-1`,
  $0.83 Jev, 11–52 s per instance, every patch empty). Diagnosis from the transcripts: the
  detected test command (`python3 -m pytest -q`) is wrong for Django (`tests/runtests.py`) and
  sympy (`bin/test`) so the baseline errors immediately, and, more fundamentally, SWE-bench
  gives an issue text with no failing test in the workspace (FAIL_TO_PASS is applied only by
  the evaluator), so a search whose goals are failing tests has no goals; the controller then
  re-proposed the same run until the loop blocked it. Direction (in flight): an oracle
  extracted from the issue itself (17/30 statements carry a reproduction snippet, 12 state
  expected vs actual, 8 a traceback): code extracts blocks, Jev decides which block reproduces
  the bug and which lines show the expected and observed behaviour, code builds a runnable
  script with a code-computed pass criterion and verifies it fails on the base commit; plus
  native test-runner detection and test scoping for large repositories; and a regression-only
  best-guess commit when no oracle can be extracted.
- 2026-09-20: **ladder rung 2, third pass** (`bench/results/jev-only-ladder-4`, after the controller step
  policy and the claiming-run rubric clause): **11/12 solved**, $0.137, generator calls 0. Only the
  3-hunk `account` misses; four solved tasks still ran to the step budget with 6–14 blocked proposals,
  so the outer loop still spends steps it does not need. The QuixBugs insertion round repaired all four
  insertion bugs live (3 gold-identical); the skew-timeout and overfit rounds are in flight.
- 2026-09-20: **issue oracle, measured** (`src/synth/oracle/`, `experiments/results/oracle-from-issue.md`,
  69 unit tests). Code extracts fenced/REPL/traceback/expectation blocks from the issue text; one Jev
  batch per instance judges which block reproduces the bug and which lines show the expected and
  observed behaviour (Nouls `is_reproduction_i`, `shows_expected_i`, `shows_actual_i`, Choice
  `failure_kind`); code builds a runnable script with a code-computed pass criterion. On the 30
  SWE-bench Verified instances: 23 have an extractable snippet, Jev's picks agree with hand labels
  18/23, 13 reach the runner, and **9/30 give a valid oracle** (fails at the base commit, passes with
  the gold patch: 7 strong, 2 weak), for $0.0096 of Jev in total. Only two of the nine overlap the
  set whose gold line is reachable by the candidate sources, so the integration (in flight) pairs the
  oracle path with a regression-only best-guess commit for the other 21 and scopes the regression
  suite to the localised modules (a Django full suite is hours).
- 2026-09-20: **ladder round 4 dissected** (`experiments/results/jev-only-ladder-4-analysis.md`).
  The one miss (`account`, 3 hunks) is a bookkeeping loss, not a reach loss: Jev localised all three
  gold lines and ranked the gold fix first at each (p 0.97–1.00), but two of the bugs share a
  traceback frame and were merged into one goal whose tests need both fixes, so each fix alone was a
  `partial`; the pair-of-partials combination never ran before the budget parked the goal, and
  parking forgot the partials. The 38 refused proposals across the five solved-at-`max_steps` tasks
  come from two mechanisms: the engine's own green verification `run`s and the `done` after them
  land in the review band on spread probability mass (bench has no reviewer, so review = decline),
  and a declined proposal is then read back from `recent` as "a step that already failed". Ranked
  fixes (loop side, in flight): completion after the engine's own passing run is a fact and skips
  block/review; the standing test run is never a review item; loop signatures for refused proposals
  ignore the outcome text and only the tripped signature resets. Predicted: 137 → ≈113 steps.
  Synthesizer side (after the oracle integration lands): combine partials before parking, reopen
  every parked goal on `change_approach`.
- 2026-09-20: **audit and remediation** (`experiments/results/jev-only-audit.md`). An adversarial audit
  of the claim "Jev and no other model" PASSES on the core: in `jev-only` mode the only reachable
  network call is the pinned Jev decisions endpoint, the generator is the null provider on every
  path, every checked-in jev-only record carries zero generator calls, no fix table or benchmark
  identity is keyed anywhere in the synthesizer, and no key prefix appears in any artefact. Four
  defects found and fixed: (1) the Q7 edit-class and beam question wordings quoted ten QuixBugs
  gold fixes verbatim as examples — replaced with invented generic snippets and guarded by a test
  that builds the leakage corpus from every benchmark's gold at test time; re-measured, Q7 top-1
  drops 28–29/40 → 24/40 (top-2 35–36 → 34–35), the whole drop on the ten quoted programs, so the
  earlier Q7 number was contaminated and the clean one is now the one cited; (2) the bench task log
  was written unredacted — every record now passes through the redactor, end-to-end tested; (3) the
  Q17 progress questions are dead in practice (0 live requests; only a tie-break path) and are
  deleted on 2026-09-20 in favour of a code tie-break (fewer regressions, then the smaller diff, then the earlier candidate); (4) every threshold retuned after a live
  run on a named QuixBugs program is disclosed in the design's §7, and the rung-1a claim is stated
  as in-sample. The "34 correct" claim is corrected by a per-program verdict script
  (`experiments/inspect/quixbugs-verdicts.mts`, `bench/results/jev-only-quixbugs-3/verdicts.md`):
  36/40 repaired = 27 gold-identical + 5 equivalent on reference and perturbed inputs + 2 overfit
  (`detect_cycle`, `wrap`, both since addressed) + 2 unverified graph programs; **32/40 verified
  correct by code**, 34 only if the two unverified are counted on hand inspection.
- 2026-09-20: **SWE-bench rung 3, second attempt (in flight): first instance solved with no generating
  model.** Repository mode landed (issue oracle as the goal, one traceback-anchored localisation, a
  regression suite scoped to ≤ 6 related test files, worktree lanes verifying the reproduction, a
  best-guess regression-only commit at most once per run when no oracle exists). On the nine
  instances with a valid oracle: `sympy__sympy-19954` **passes the local-venv evaluator** (FAIL_TO_PASS
  and PASS_TO_PASS) after 8 steps and $0.024 of Jev, zero generator calls — a two-line guard inserted
  before the faulty `del` in `perm_groups.py`, found in one Jev request for the oracle, fifteen for
  localisation (gold file #1), one ranked batch of 25 candidates of which 3 passed the reproduction and
  the scoped regression run, one arbitration; it is not the upstream fix's shape but the evaluator
  accepts it. `sympy__sympy-15345` found its oracle and file in the same way but parked after two
  budget-hit steps: the repository-class cap of 16 runs per step was designed for a full-suite oracle,
  while the reproduction costs 2 s — so the cap is being re-derived from the measured oracle (runs =
  test wall / t_run, bounded) with the park rule counting only steps that visited nothing new. The
  full 30 re-run follows with that change.
- 2026-09-20: **reach study at the gold site, nine oracle instances** (`experiments/results/swebench-reach-oracle-9.md`,
  scripts under `experiments/reach/`, $0 of Jev). With the gold site given, a test-passing patch is in
  some source's set on **3/9** (requests-2931 the gold line itself; sympy-12096 a callee substitution
  that passes the failing test; django-15315 only degenerate constant-hash passers); the gold text is
  reached on 1/9. Two facts precede the sources: the workspace loader kept the first 400 files in path
  order, which left 5/9 gold files outside the localiser's and every source's corpus (raised to 1200
  with task-named files first in the repository-mode commit), and replace sites are physical lines so a
  five-line statement cannot be rewritten. Ranked missing capabilities, each Jev-only (code proposes
  from facts in the workspace, Jev chooses, tests verify): introspected names from the failing call
  (`__mro__` class names, `is_*` predicates) feeding the vocabulary plus an attribute-predicate guard
  and a method-alias production (2/9); a git-history source (1/9); statement-level replace sites (1/9);
  stdlib-sibling callee substitution carrying its import (1/9); depth-2 wraps (1/9); parameter threading
  (1/9). Also found: the composite signature-unit enumerator did not return in 27 min at one sympy site
  (unbounded scan of every statement of every file) — being bounded. Two agents are implementing
  capabilities 2–6 now; wiring into the controller follows once the search files are free.
- 2026-09-20: **controller bookkeeping + loop round 6; QuixBugs rung 1a repeat 1: 38/40.** Search side
  (`experiments/results/jev-only-rungs-1-2.md` §15): partials are paired before a goal is parked and
  survive the park in `synthState`; a held passer is committed on a budget exit; `change_approach`
  reopens every parked goal; a site's seed sources run as one SIEVE batch decided once; all-killed
  batches under load are re-queued once; WIDENED sites are evidence-ordered and a loop's exit gap is
  an anchor's third gap. Ladder `account` 3/3 hunks gold-identical in 2/2 runs; `wrap` gold-identical;
  five regression programs gold-identical or equivalent. Loop side (§14, §17): completion after the
  engine's own passing run is a fact; the standing verification run and a novel verified patch never
  land in the review band on spread mass; `fail:` loop signatures are failing-test sets, not the last
  output line; a no-op `done` carries the engine's last run — ladder grades/shipping/table 47 → 19
  steps, loop replans 8 → 0. **Rung 1a repeat 1** on the merged tree (`bench/results/jev-only-quixbugs-6-repeat1`,
  clean worktree at d610d75): **38/40 repaired**, $0.134, 0 generator calls; by the verdict script 28
  gold-identical + 7 equivalent = **35 verified correct**, 2 unverified (graph fixtures the probe does
  not perturb), 1 overfit (`wrap` again: the exit-gap batch was not the winner this time), 2 misses
  (`longest_common_subsequence`, `shortest_path_length`, both `max_steps`). Repeat 2 is running.
- 2026-09-20: **rung 1a repeat 2: 38/40, 36 verified correct, 0 overfit** (`bench/results/jev-only-quixbugs-6-repeat2`,
  same clean worktree at d610d75, $0.126, 0 generator calls; misses `shortest_path_length` and `sqrt`,
  both `max_steps`). With run 3 (36/40, 32 verified) and repeat 1 (38/40, 35 verified) this meets the
  design's rung-1a bar of ≥ 36/40 in every repeat and ≥ 34 correct in the last two; the in-sample
  disclosure in the design's §7 applies to all three.
- 2026-09-20: **long-horizon ladder tier (tasks 13–20)** (`bench/data/ladder`, tier `long`; `experiments/results/jev-only-rungs-1-2.md`
  §19). Eight tasks that measure the horizon rather than the reach — every planted line is a one-line
  replace or the guard template's insert, and a probe confirms 34/34 lines are enumerated by a code
  source: five independent bugs (`ledger5`), masked failures that re-cluster to a callee (`masked`),
  two bugs raising at the same helper line (`shared_frame`), a coordinated two-file rename plus two
  bugs (`crossfile`), a missing import and a missing None-guard (`import_and_guard`), an obvious flip
  that passes the failing tests but breaks pinned ones (`regress_trap`), six bugs with complementary
  partials (`six_hunks`), and a six-stage pipeline whose later stages only fail meaningfully once the
  earlier ones are fixed (`long_chain`). Three live runs: 2/8, then 3/8 after re-authoring six
  out-of-reach lines, then 2/8 on the merged tree (`jev-only-ladder-long-{1,1b,2}`, ≈ $0.27 each).
  One defect dominates: **a lone partial is never committed** — in `masked`, `long_chain`,
  `shared_frame` and `six_hunks` the gold line was enumerated, ranked first by Jev (p 0.80–0.99), run,
  classified partial because the merged goal's tests need two fixes, and dropped at the park. Fix in
  flight: progress commits (the best regression-free partial is committed with partial-fix evidence,
  the remaining tests stay open and re-cluster), plus no `read` proposals after a `gather_context`
  replan (7–12 declined reads per miss fed the loop detector). `regress_trap` confirmed that
  regressions are never kept. Also this round: Q17 deleted (0 live requests; a code tie-break).
- 2026-09-20 (later): **SWE-bench rung 3 on the wired tree (5486f7a): 1/30** (`bench/results/jev-only-swebench-3`,
  `experiments/results/jev-only-rungs-1-2.md` §21; the full 30, `--concurrency 2 --max-steps 25 --max-wall 25m`,
  exit 0 in 54 min, Jev $1.163, no cap fired). The §20 memory fix held: worker RSS peaked at 2.99 GB and fell
  to tens of MB between tasks where the previous full run died at 8 GB after 8 records. BEFORE tables
  (§21.3): the integration code on the 9 oracle instances 1/9 (sympy-19954), the budget-round code on the
  crashed full run 1/8. AFTER: **django-15128 solved** (SIEVE lone passer `alias += table_name` at step 2,
  `complete` at step 4, $0.011; not the gold's shape, F2P and local P2P accept it), sympy-19954 lost to load
  (§21.7: its reproduction measured 0.9 s instead of 3.5 s once the heap stopped thrashing, which put the run in
  the QuixBugs oracle class — 1,500 runs, SIEVE, a 90-s wall — so the first site's 762 candidates took every step
  and the gap before the raising `del`, where the guard won twice, was never visited; the guard was run only at the
  gap after it. History reversals did not displace it: the guard is a template candidate). Oracle found 10/30 (8 strong, 2 weak, every one
  confirmed by a second run); introspection ran on 9/9 oracle instances, the history harvest on 9/9 and found
  django-15315's ticket #31750 commit. Reach check from the records (`experiments/inspect/reach-check-3.mts`):
  the test-passing line is now in the set on 4/7 reach targets (15345 alias, 17139 `is_real` guard, 2931
  `return data`, 12096 `nfloat`) and none was run at the right place under a verdict that could accept it —
  ranked p 0.03 / `none_of_these` 0.69 (never run), run at the wrong gap (inside the `< 0` body), run and
  rejected by the httpbin oracle. Three commits on oracle instances all failed the evaluator (15315 dead code
  ×4, 15563 weak-oracle overfit, 2931 wrong passer). **Defect:** the history source's reversals carry their own
  site and the ranker throws `ranker: candidate "hist_…" is at <file>:<line>, not at the site being ranked`
  (`src/synth/rank/index.ts:307`) — 43 occurrences in 12 runs; the nine `error` stops (8 without an oracle + sympy-11618, steps 4–6) are
  classified `wiring_defect_history_site`, not a search or oracle class (§21.7). **django-15315's oracle is a 1/8 coin that `PYTHONHASHSEED=0` does not fix**: 16 runs
  of the runner's own command give AssertionError ×13 / PASS ×3 in both workspace and lane, because
  `hash(None)` is address-based on CPython 3.9 (fixed in 3.12) — a lane `plausible` needs a confirming
  second run (§21.4 addendum, `experiments/inspect/repro-15315-repeat.mts`). Binding constraint (§21.6): the
  verdict a produced candidate receives — flaky/networked/weak oracles feeding a 5-passer cap, the run budget
  derived from idle timings collapsing under load, and RANK mode dropping the right line at p 0.03 — not the
  candidate set. Report script kept as `experiments/inspect/swe-report.mts`.
- 2026-09-21: **progress commits, and no `read` churn** (merged as c9badd0; `experiments/results/jev-only-rungs-1-2.md`
  §22). A step that ends with a regression-free partial in hand now commits it as a *partial fix* — pairs
  of complementary partials first, then one full-suite regression run, then the guard's suspicion signals
  and Q16 advisory — with evidence that says so ("k of n goal tests pass, the remaining m stay open");
  the goal stays open, its remaining tests re-cluster by frame, and a goal may chain at most three
  progress commits before its remainder becomes a new goal. A progress commit also forgets the goal's
  `unchanged` verdicts (a line rejected under an earlier failure can be the fix under the new one). The
  jev-only synthesizer no longer proposes `read` at all: `gather_context` re-localises every open goal
  and reopens goals the search parked. The arbitration escape threshold moved 0.8 → 0.5 after `masked`
  committed five all-overfit `return 0` inserts at escape 0.67–0.75. Live on the four long-tier tasks
  that exposed the defect (`jev-only-ladder-long-3{,b,c}`, $0.36): `masked` solved once (7 steps,
  `complete`), `long_chain` 2/6 hunks gold with a three-link chain, `six_hunks` 1/6, `shared_frame` 0/2;
  0 `read` proposals in 12 runs (run 2 had 6–10 declined reads per task); every remaining miss is a
  localisation miss (Jev's Q2 `where` says `none_of_these` for the frame's function, so the innermost
  traceback line never becomes a site) followed by six blocked partial `done`s. **SWE-bench rung 3** on
  the wired tree (§21, `jev-only-swebench-3`): **1/30** — `django__django-15128` newly solved (4 steps,
  $0.011), `sympy__sympy-19954` lost under load; oracle found 10/30; memory fix held (RSS peak 3.0 GB,
  55 min, $1.16); nine no-oracle instances died on a wiring defect (git-history reversals ranked at a
  foreign site) — fix in flight, with two more from the same report: a lane passer must pass its
  reproduction twice (django-15315's oracle is a 1/8 coin because `hash(None)` is address-based on
  CPython 3.9), and the per-step run count must come from the running measurements, not the idle
  baseline (under two-way concurrency the runs collapsed to 6–10 per step and the #1-ranked candidate
  was deferred and never run).
- 2026-09-21: **final tree measured — QuixBugs 39/40, ladder 14/20** (55404ba, run from a frozen worktree while SWE-bench
  ran alongside; `experiments/results/jev-only-rungs-1-2.md` §25; `bench/results/jev-only-{quixbugs,ladder}-7-final`,
  $0.505). QuixBugs: 39/40 solved — gold-identical 30, equivalent 7, overfit 0 *by the script*, unverified 2 (the two graph
  programs the probe cannot perturb; the next entry's differential test shows `topological_ordering` **wrong** and
  `breadth_first_search` equivalent, so 37 verified correct and at most 38/40 correct), miss 1; 36 programs in 3 steps, 0 `read`s, 13 loop trips all in the four 10–11-step runs; the
  miss (`shortest_path_length`, both 6-repeat runs missed it too) is the budget-end release of a held "possible overfit"
  passer — `return 4` inserted above the gold line — which makes the remaining test unfixable (`spend_cap` at step 11).
  Ladder: the short tier **12/12 solved** for the first time (all `complete`, 3–7 steps, 0 blocked / declined / loops, $0.051;
  rounds 4–5 were 11/12; `grades` and `textstats` are test-equivalent but behaviourally wrong fixes, so at most 10/12
  correct — next entry), the long tier 2/8 (`import_and_guard` 9 steps, `ledger5` 13 — both their fastest) with 6
  progress commits and 0 reads; `long_chain` reached three gold links (3/6) before its remaining frame, a `<lambda>` in
  `totals.py`, never became a site. The seven misses by class: localisation miss ×3 (`long_chain`; `regress_trap`,
  where `agenda.py:19` never became a site although that hunk alone fixes all three remaining tests; `shared_frame`, a
  strict pair with no replace site at either call), overfit release ×2 (`shortest_path_length`; `masked`, where the
  guard's own all-overfit signature held `return 0` twice before the budget reserve committed it), partial trap ×1
  (`six_hunks`: the gold `model.py:28` partial was displaced in the single held slot by a regressing pair and, being
  `tried`, never returned), and one code defect the transcripts pin: **`unchanged` verdicts are goal-relative but
  `tried` is run-global** — `crossfile`'s `tax.py:12:replace` had 165 candidates under a fmt goal (165 `unchanged`) and
  `mutation 0` under the tax goal it fixes outright, likewise `discount.py:21` (`memory.ts:44`, `runner.ts:174`;
  `index.ts:712` forgets them only on that goal's own progress commit). Open, from this measurement: exclude an
  `unchanged` hash for its own goal only; do not release an all-overfit-signature passer at the budget reserve.
- 2026-09-21: **SWE-bench final tree 4/30; independent verification of the final-tree numbers; solved and correct now
  reported separately.** SWE-bench Verified 30 on `55404ba` (`bench/results/jev-only-swebench-4-final`, launched from the
  frozen worktree while the QuixBugs and ladder finals ran alongside; rungs report §26): **4/30** pass the local-venv
  evaluator (unofficial: it replicates `eval.sh` without Docker) — `sympy__sympy-15345` (4 steps), `sympy__sympy-17139`
  (4), `sympy__sympy-19954` (6), `django__django-15128` (4) — with FAIL_TO_PASS all success and the listed PASS_TO_PASS
  all success on each; none has the upstream fix's shape (15345 `_print_Expr = _print_Function`, a class-wide alias;
  19954 an index guard before `del`; 17139 a `not rv.exp.is_comparable` guard; 15128 `alias += table_name`). $1.30 of
  Jev, 0 generator calls, 68 min, 348 steps, 228 blocked proposals, 88 loop trips; 0 history/foreign-site errors (the
  rung-3 defect is gone); `unstable` verdicts appeared 3× on `django-15315` and `weak_network` 7× on `requests-2931`;
  RSS peak 4.5 GiB on 5-minute samples. A single run; `sympy-19954` has flipped across runs (pass, pass, miss, pass;
  load-sensitive); the series over the four full-30 attempts is 0/30 → 1/30 → 1/30 → 4/30, and the four solved
  instances were among the nine reach-study targets whose missing capabilities were added before this run.
  **Verification** (sixteen independent read-only checks of the raw records, 2026-09-21): every headline count
  re-derives from `tasks.jsonl` / `summary.json` / `verdicts.md`, the evaluator re-runs agree 40/40 and 20/20, all
  6,598 Jev requests carry the pinned model and no generator was called; three restatements follow. (1) QuixBugs: 39/40
  pass the reference cases, 37 verified correct, but the unverified `topological_ordering` is **wrong** (the committed
  patch drops the `issuperset(incoming_nodes)` check and adds a `break`; `[A, C]` for `A->B, A->C, B->C`; 462/1000
  random DAGs invalid) while `breadth_first_search` is equivalent on 500 random graphs — so at most 38/40 correct, and
  the script's "0 overfit" is a blind spot for the nine pytest-fixture programs, not a finding; `shortest_path_length`
  (a literal `return 4` committed) was gold-identical in run 3 and missed in all three later runs, a persistent
  regression. (2) Ladder: 14/20 solved on the exposed suite, but the short tier's `grades` (`letter_grade(89.5)` →
  `'A'`, gold `'B'`) and `textstats` (`ngrams` raises on a tuple and mutates the caller's list) are behaviourally wrong
  fixes — at most 10/12 correct — and there was no ladder correctness check at all (`experiments/inspect/ladder-verdicts.mts`
  is being written); hunk counts by strict `diff -U0` are `ledger5` 2/5, `import_and_guard` 2/4, `long_chain` 3/6,
  `regress_trap` 3/4, `six_hunks` 1/6 (2/6 with the equivalent `t.due == None`), `masked` 0/3 (1/3 with the equivalent
  `txt = text`; plus an overfit `return 0` insert), `crossfile` 0/4, `shared_frame` 0/2. (3) Provenance: no run record
  stores a git sha; `55404ba` is inferred from `run.json`'s workspace path (the frozen worktree, clean) and timing (the
  first bench started 94 s after the commit), and the SWE-bench launcher log's `head 55404ba` line. Gates on the frozen
  tree: typecheck, `no-any` and the full unit suite (221 files / 4,045 tests) pass; `npm run perf` meets every budget
  (first frame cold p95 104.2 ms of < 300; harness overhead per step p95 33.5 ms of < 50; event-loop lag p95 2.4 / 1.8 ms
  at rows 40 / 12 of < 5; 0 / 0 terminal clears). Decision recorded in `docs/DECISIONS.md` (2026-09-21): every headline
  carries "solved" (the exposed / evaluator suite) and "correct" (verdict script or differential test against gold) as
  separate numbers; README, STATUS and design §7 carry the final-tree rows in that form.
