# Jev-only synthesizer, rungs 1a and 2: first live runs of the Ledger + Sieve engine

Date: 2026-09-20. Integrator's report for docs/JEV-ONLY-DESIGN.md §7 rungs 1a (QuixBugs 40) and 2
(ladder 12), `jev-only` condition, live Jev (`typesafe/jev-1.13`), no generating LLM (the bench
asserts `generatorCalls = 0` per record). Every number below is read from `bench/results/<dir>/
tasks.jsonl` and the run directories under `~/.jevcode/runs/<runId>/` (`steps.jsonl`, `decisions.jsonl`,
`transcript.log`, `model_patch.diff`) by the analysis script quoted in §7.

## 1. Rung 1a: QuixBugs 40, `jev-only`, live (final run `bench/results/jev-only-quixbugs-1`)

Settings: `--max-steps 12 --max-wall 6m --task-spend-cap 0.1 --concurrency 4`, Jev `typesafe/jev-1.13-20260917`,
generator calls 0 on every record (bench assertion). Oracle: the workspace's generated pytest module
(`python3 -m pytest -q`, 2 s per case), verified afterwards by the bench with `bench/data/quixbugs/run_tests.py`.

**Result: repaired 34/40 (evaluator), correct by inspection 31/40** = 25 patches identical to
`bench/data/quixbugs/correct/` (whole file, blank lines ignored) + 6 semantically equivalent fixes read by hand
(`breadth_first_search` `if not queue: return False` in place of `while queue`, `max_sublist_sum` `max(x, …)`,
`next_permutation` `perm[j] > perm[i]`, `lis`, `possible_change`, `powerset`); 3 passers are visible-test-only
(`detect_cycle` guards `tortoise.successor` instead of `hare`/`hare.successor`, `depth_first_search` turns the
recursion into a no-op generator expression — the design's measured all-overfit set — and `wrap` inserts a second
wrapping loop and drops `lines.append(text)`). Steps median 4.0 (23 runs ended by the engine's
`task_complete`, 16 by `max_steps` after the fix was applied, 1 by `replan_stop`); Jev cost total
$0.19 (mean $0.0048 per program, the engine's own intent/context/risk/judge requests included); test runs
total 15989 (median 128 per program); wall median 16.0 s, max 318 s (`sqrt`, timeout-dominated).
`ranking_missed` = 0 (the sieve ran every candidate wherever t_run ≤ 2 s), 0 regressions kept.

Misses (6): `bitcount`, `sqrt`, `mergesort`, `shunting_yard` — `budget`: the buggy program loops or recurses
without bound, so the suite costs 2 s per case (9–13 s baselines), `fitOracle` classifies the oracle
repository-class and the search runs in RANK mode with 16 runs per step; the depth-1 fix is in the candidate set
(`bitcount` 421 enumerated, 16 run). `shunting_yard`'s 1.9 s suite crossed the 2 s SIEVE threshold only under the
bench's CPU load (4 runs × 8 lanes). `reverse_linked_list` — `engine_rejected`: the passer (an inserted
`prevnode = node`, found in the WIDENED phase after 1,300 runs) was blocked/declined three times by the risk stage.
`topological_ordering` — `overfit`: one plausible candidate on a one-test goal, applied, fails the hidden third test.

### 1.1 The three preceding runs of the same 40 (same command, code as of each run)

| run | code state | repaired | gold-identical | steps median | `complete` endings | Jev $ | test runs | wall median s | misses |
|---|---|---|---|---|---|---|---|---|---|
| `-1-pre` | before the stale-`.pyc` fix (§4 row 11) and with claims on the `done` only | 32/40 | 22 | 12.0 | 12 | 0.241 | 17266 | 19.0 | gcd, bitcount, reverse_linked_list, mergesort, shunting_yard, topological_ordering, sqrt, to_base |
| `-1b` | + `PYTHONDONTWRITEBYTECODE` on lanes, claim on the post-patch run (no standing item) | 34/40 | 24 | 12.0 | 0 | 0.235 | 15817 | 19.5 | mergesort, bitcount, reverse_linked_list, shunting_yard, sqrt, topological_ordering |
| `-1c` | + standing verification item `verify the full test suite passes` | 34/40 | 25 | 4.0 | 26 | 0.178 | 15328 | 14.5 | depth_first_search, bitcount, mergesort, shunting_yard, topological_ordering, sqrt |
| `-1` (final) | + run's expectation text on green re-baselines, every trailing `read` counted | 34/40 | 25 | 4.0 | 23 | 0.19 | 15989 | 16.0 | bitcount, reverse_linked_list, mergesort, shunting_yard, topological_ordering, sqrt |

The stale-bytecode fix is worth +2 repaired (`gcd`, `to_base`) and turned five "everything unchanged" searches
into real sieves; the standing verification item took the `task_complete` endings from 0 to 23–26 of 40 (median
steps 12 → 4). Run-to-run flips at the margin: `reverse_linked_list` repaired in `-1b`/`-1c` (engine accepted the
patch) and rejected in `-1`; `depth_first_search` passes the visible tests in `-1` and was rejected in `-1c`.

### 1.2 Per program (final run)

| program | kind | repaired | correct by diff | steps | Jev requests (engine / synth) | test runs | plausible | patches applied / rejected | cost $ | wall s | stop | failure class |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bucketsort | wrong_variable | yes | yes | 3 | 14 / 2 | 67 | 1 | 1 / 0 | 0.0011 | 7 | complete | - |
| breadth_first_search | control_flow | yes | no | 4 | 25 / 9 | 310 | 3 | 1 / 0 | 0.0017 | 40 | complete | - |
| detect_cycle | missing_condition | yes | no | 12 | 52 / 8 | 261 | 1 | 1 / 0 | 0.0045 | 35 | max_steps | - |
| find_in_sorted | off_by_one | yes | yes | 3 | 14 / 2 | 160 | 1 | 1 / 0 | 0.0012 | 10 | complete | - |
| depth_first_search | other | yes | no | 12 | 51 / 9 | 989 | 6 | 1 / 0 | 0.0043 | 55 | max_steps | - |
| find_first_in_sorted | off_by_one | yes | yes | 3 | 19 / 6 | 9 | 4 | 1 / 0 | 0.0017 | 16 | complete | - |
| flatten | wrong_call | yes | yes | 3 | 14 / 2 | 81 | 1 | 1 / 0 | 0.0011 | 7 | complete | - |
| get_factors | other | yes | yes | 3 | 14 / 2 | 127 | 1 | 1 / 0 | 0.0011 | 10 | complete | - |
| hanoi | wrong_variable | yes | yes | 4 | 18 / 2 | 85 | 1 | 1 / 0 | 0.0015 | 9 | complete | - |
| is_valid_parenthesization | missing_condition | yes | yes | 3 | 15 / 3 | 46 | 2 | 1 / 0 | 0.0012 | 6 | complete | - |
| kheapsort | wrong_variable | yes | yes | 4 | 18 / 2 | 79 | 1 | 1 / 0 | 0.0017 | 14 | complete | - |
| gcd | argument_swap | yes | yes | 12 | 44 / 2 | 110 | 1 | 1 / 0 | 0.0040 | 30 | max_steps | - |
| knapsack | off_by_one | yes | yes | 12 | 45 / 3 | 117 | 3 | 1 / 0 | 0.0047 | 13 | max_steps | - |
| kth | other | yes | yes | 3 | 14 / 2 | 173 | 1 | 1 / 0 | 0.0012 | 11 | complete | - |
| lcs_length | off_by_one | yes | yes | 3 | 14 / 2 | 153 | 1 | 1 / 0 | 0.0011 | 12 | complete | - |
| levenshtein | off_by_one | yes | yes | 3 | 18 / 6 | 7 | 2 | 1 / 0 | 0.0017 | 16 | complete | - |
| max_sublist_sum | missing_condition | yes | no | 3 | 15 / 3 | 458 | 2 | 1 / 0 | 0.0012 | 34 | complete | - |
| longest_common_subsequence | wrong_variable | yes | yes | 4 | 19 / 3 | 338 | 1 | 1 / 0 | 0.0017 | 42 | complete | - |
| minimum_spanning_tree | wrong_call | yes | yes | 4 | 18 / 2 | 115 | 1 | 1 / 0 | 0.0016 | 10 | complete | - |
| next_palindrome | off_by_one | yes | yes | 3 | 15 / 3 | 135 | 4 | 1 / 0 | 0.0013 | 11 | complete | - |
| next_permutation | argument_swap | yes | no | 3 | 15 / 3 | 91 | 4 | 1 / 0 | 0.0012 | 8 | complete | - |
| lis | missing_condition | yes | no | 4 | 24 / 8 | 1293 | 1 | 1 / 0 | 0.0020 | 90 | complete | - |
| possible_change | missing_condition | yes | no | 12 | 46 / 2 | 123 | 1 | 1 / 0 | 0.0045 | 20 | max_steps | - |
| bitcount | operator | no | n/a | 11 | 52 / 12 | 32 | 0 | 0 / 0 | 0.0051 | 218 | replan_stop | budget (slow oracle: RANK mode) |
| powerset | other | yes | no | 12 | 46 / 2 | 127 | 1 | 1 / 0 | 0.0045 | 16 | max_steps | - |
| quicksort | operator | yes | yes | 3 | 15 / 3 | 167 | 3 | 1 / 0 | 0.0012 | 14 | complete | - |
| pascal | off_by_one | yes | yes | 12 | 59 / 15 | 1310 | 1 | 1 / 0 | 0.0056 | 65 | max_steps | - |
| rpn_eval | argument_swap | yes | yes | 12 | 45 / 2 | 128 | 1 | 1 / 0 | 0.0049 | 20 | max_steps | - |
| shortest_path_lengths | argument_swap | yes | yes | 12 | 48 / 2 | 176 | 1 | 1 / 0 | 0.0055 | 21 | max_steps | - |
| shortest_paths | wrong_variable | yes | yes | 12 | 47 / 2 | 41 | 1 | 1 / 0 | 0.0049 | 15 | max_steps | - |
| reverse_linked_list | other | no | n/a | 12 | 96 / 49 | 1408 | 1 | 0 / 3 | 0.0100 | 214 | max_steps | engine_rejected |
| shortest_path_length | wrong_variable | yes | yes | 6 | 82 / 57 | 3381 | 1 | 1 / 0 | 0.0139 | 209 | complete | - |
| sieve | wrong_call | yes | yes | 3 | 14 / 2 | 128 | 1 | 1 / 0 | 0.0010 | 9 | complete | - |
| mergesort | off_by_one | no | n/a | 12 | 237 / 82 | 63 | 0 | 0 / 0 | 0.0554 | 318 | max_steps | budget (slow oracle: RANK mode) |
| subsequences | other | yes | yes | 3 | 14 / 2 | 133 | 1 | 1 / 0 | 0.0011 | 11 | complete | - |
| to_base | argument_swap | yes | yes | 3 | 14 / 2 | 92 | 1 | 1 / 0 | 0.0011 | 7 | complete | - |
| shunting_yard | other | no | n/a | 12 | 87 / 46 | 2096 | 0 | 0 / 0 | 0.0117 | 196 | max_steps | budget (slow oracle: RANK mode) |
| topological_ordering | wrong_variable | no | no | 12 | 53 / 8 | 557 | 1 | 1 / 0 | 0.0049 | 75 | max_steps | overfit |
| wrap | other | yes | no | 12 | 45 / 2 | 779 | 1 | 1 / 0 | 0.0046 | 150 | max_steps | - |
| sqrt | other | no | n/a | 12 | 64 / 22 | 44 | 0 | 0 / 0 | 0.0078 | 204 | max_steps | budget (slow oracle: RANK mode) |

**Totals**: repaired 34/40, correct by diff 25/40; steps median 4.0 (mean 7.0); test runs median 128.0 (total 15989); Jev cost total $0.190 (mean $0.0048); wall median 16.0 s, max 318 s.
Failure classes: {'budget (slow oracle: RANK mode)': 4, 'engine_rejected': 1, 'overfit': 1}
Stop reasons: {'complete': 23, 'max_steps': 16, 'replan_stop': 1}


## 2. Rung 2: ladder 12, `jev-only`, live (`bench/results/jev-only-ladder-1`)

Settings: `--max-steps 20 --max-wall 10m --task-spend-cap 0.25 --concurrency 3`; evaluator `pytest tests` in the
final workspace (exit 0) with `tests/` unchanged; generator calls 0 on every record.

**Result: solved 4/12** (`events`, `profiles`, `stats`, and `table` — the 3-hunk two-file task the design
rated 0–1, reached through the composite signature + call-site unit and committed as one patch). Hunks fixed
(ledger) across the 12 tasks: 13 of 21 goals-as-tests groups closed on the synthesizer's own baseline, but only
the commits the engine executed count: 7 patches applied in 12 runs, 35 test-passing patches rejected by the
risk stage (blocked or declined), 17 re-proposals, 6 parks (`shipping` 4, `tagcloud` 3 — sources exhausted;
`table` 2 before the composite unit passed). Jev cost total $0.277 (mean $0.0231 per task); test runs
total 36211 (median 3074); wall median 325 s, max 537 s; 10 of 12 runs ended by `max_steps`.
0 regressions kept (every applied patch passed the full suite on the lanes; the evaluator confirms no task
lost a passing test).

| task | hunks | kinds | solved | steps | commits (patches applied) | patches rejected (rollbacks) | re-proposals | parks | final ledger | Jev requests engine / synth | test runs | Jev $ | wall s | stop | failure class |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| events | 1 | attribute | yes | 20 | 1 | 0 | 0 | 0 | fixed 1, open 0, parked 0 | 77 / 6 | 637 | 0.0080 | 59 | max_steps | - |
| calendar_utils | 3 | operator, off_by_one, call_args | no | 20 | 1 | 0 | 0 | 0 | fixed 2, open 3, parked 0 | 86 / 14 | 1426 | 0.0117 | 99 | max_steps | engine_rejected after 2 of 3 hunks fixed (the post-patch run was blocked; the remaining hunk never searched) |
| grades | 2 | operator, rename | no | 20 | 0 | 6 | 3 | 0 | fixed 0, open 3, parked 0 | 126 / 47 | 2053 | 0.0143 | 144 | max_steps | engine_rejected |
| profiles | 1 | guard | yes | 4 | 1 | 0 | 0 | 0 | fixed 1, open 0, parked 0 | 22 / 6 | 196 | 0.0017 | 19 | complete | - |
| account | 3 | operator, off_by_one, rename | no | 20 | 1 | 4 | 2 | 0 | fixed 1, open 1, parked 0 | 181 / 105 | 5753 | 0.0241 | 380 | max_steps | engine_rejected after 1 of 3 hunks fixed (post-patch run blocked) |
| stats | 1 | guard | yes | 7 | 1 | 2 | 1 | 0 | fixed 1, open 0, parked 0 | 39 / 13 | 296 | 0.0029 | 26 | complete | - |
| inventory | 2 | operator, off_by_one | no | 20 | 0 | 6 | 3 | 0 | fixed 0, open 4, parked 0 | 143 / 62 | 4964 | 0.0179 | 313 | max_steps | engine_rejected |
| shipping | 1 | constant | no | 20 | 0 | 4 | 2 | 2 | fixed 0, open 0, parked 4 | 358 / 252 | 5490 | 0.0720 | 506 | max_steps | engine_rejected |
| table | 3 | two_files, call_args | yes | 20 | 1 | 2 | 1 | 2 | fixed 4, open 0, parked 0 | 162 / 53 | 3869 | 0.0284 | 365 | max_steps | - |
| tagcloud | 1 | import | no | 20 | 0 | 0 | 0 | 1 | fixed 0, open 0, parked 3 | 287 / 214 | 5378 | 0.0560 | 537 | max_steps | fix_not_in_candidates (import insertion; every source exhausted, 3 goals parked) |
| units | 1 | new_branch, rename | no | 20 | 0 | 7 | 3 | 0 | fixed 0, open 3, parked 0 | 118 / 37 | 2372 | 0.0121 | 337 | max_steps | engine_rejected |
| textstats | 2 | call_args, off_by_one | no | 20 | 0 | 4 | 2 | 0 | fixed 0, open 3, parked 1 | 178 / 102 | 3777 | 0.0282 | 458 | max_steps | engine_rejected |

What the misses have in common: on 7 of 8 the synthesizer found a test-passing candidate for the attacked goal
(the evaluator's final counts equal the buggy baseline only because the patches were never applied); the
engine's risk stage reviewed or blocked them — mostly as "repeats a step `recent` shows already failed the same
way" once one proposal had been declined, and on the multi-hunk tasks the claiming post-patch `run` after the
first commit (`calendar_utils` 2 of 3 hunks, `account` 1 of 3). `tagcloud` is the one reach miss: the
`missing_import` template did not place `from collections import Counter` (3 goals parked, every source
exhausted). One-goal-per-test clustering shows on every task (inventory 4 goals for 2 hunks, `mostPassing`
merges them at commit time only).

## 3. Totals and budget

| item | value |
|---|---|
| Jev spend, rung 1a final run | $0.191 (mean $0.0048 per program) |
| Jev spend, the three preceding QuixBugs runs | $0.241 + $0.235 + $0.178 |
| Jev spend, rung 2 | $0.277 |
| Jev spend, the 11 live end-to-end runs on `inventory` during integration | $0.068 (completed runs; the interrupted ones ≈ $0.02) |
| **total live spend** | **≈ $1.21** of the $3 cap |
| generator spend / calls | $0 / 0 everywhere |
| unit tests | 128 files, 1770 tests green; `tsc --noEmit` clean for the whole project; `no-any` ok |



## 4. Integration defects found and fixed before the rungs (all confirmed live on ladder `inventory`)

Eleven end-to-end runs of `jevcode run --mode jev-only` on a git copy of `bench/data/ladder/tasks/inventory`
(`/tmp/jo-inv`, `--runs-dir /tmp/jo-runs`, `--spend-cap 0.5`, real Jev) exposed, in this order:

| # | defect | evidence | fix (file) |
|---|---|---|---|
| 1 | the detector's `pytest -q` is not on PATH in the sandbox | baseline "0/1 pass, 1 error in 15 ms", no goal formed | `normaliseTestCommand` → `python3 -m pytest` (search/index.ts); the engine's `isTestCommand` treats both as one runner |
| 2 | the sandbox redirects `HOME`, so the system `python3` has no pytest; the bench's shared venv was reachable only by the evaluator | "No module named pytest" through the sandbox | bench setup links `<workspace>/.venv` → `<runsDir>/ladder-venv` (the one dir the sandbox puts on PATH) for ladder and QuixBugs; the venv becomes a readable root of the agent sandbox; `.venv` (symlink form) excluded from git (bench/ladder/pyworkspace.ts `linkVenv`, ladder + quixbugs loaders, bench/runner.ts) |
| 3 | lanes under `<runDir>/synth` are not writable (seatbelt allows the workspace, `<runDir>/tmp`, `<runDir>/home`) | `mkdir: Operation not permitted` | lanes under `<runDir>/tmp/synth` (sieve/lanes.ts `LANES_SUBDIR`) |
| 4 | `-qq` pytest output (task `pytest.ini` already has `-q`) has no counts line; the synthesizer's parser read a 6-passed baseline as 0 passed, so no regression could ever fire | collection-error candidate classified `plausible` | progress-character fallback (verify/pytest.ts `countsFromProgress`) |
| 5 | a candidate that breaks collection (0 passed, 1 error, module id in `failing`) passed `goalPasses`/`isPlausible` | `if …:` / `return …` / `raise …` committed | `passed === 0` or more errors than the base is never a pass (sieve/runner.ts, search/guard.ts) |
| 6 | donor statement blocks numbered body lines `site.line + 1 + k` while `applyCandidate` numbers against the original file (bottom-up, list order at one line): the body interleaved with original lines | the same IndentationError candidate | all body lines at one original line (donor/source.ts) |
| 7 | an overfit that fixes only the attacked test is "plausible" under one-goal-per-test clustering | `insert_return` chosen over the real fix | among plausible candidates only those with the most full-suite passes stay (guard.ts `mostPassing`) |
| 8 | a `patch` the engine blocked or declined was still recorded as a commit ("fixed 4 of 4" with nothing applied) | ledger drifted from the workspace | rollback of every non-executed patch; the passer is re-proposed once (`REPROPOSE_MAX`), then abandoned (search/index.ts) |
| 9 | the runner cached the goal-subset baseline per `base.id` (`committed`) across re-baselines | 48 no-op mutants classified `partial` after a commit | caches cleared on re-baseline (search/index.ts) |
| 10 | the engine's window keeps 4 entries: a patch followed by a few declined runs and reads scrolled out, and the post-patch `run` stopped being proposed | later patches blocked as "no verifying test run in `recent`" | the synthesizer keeps its own record of the engine's last parsed run and last executed change (`observeWindow`, `engineNeedsRun`) |
| 11 | Python reused stale `__pycache__/*.pyc` on the lanes (same size, same mtime second; `git clean -fdq` keeps ignored paths): 105 mutations at the right line of `gcd`, the gold included, classified `unchanged` | first QuixBugs bench: `gcd` miss, "everything unchanged" batches on 4 more programs | `PYTHONDONTWRITEBYTECODE=1` on every lane run, copied caches purged (sieve/runner.ts `LANE_RUN_ENV`, sieve/lanes.ts) |

Engine-facing behaviour added so the risk stage (`plan_mismatch`, review at 0.3 / block at 0.7, `alwaysDecline`
confirmer in the bench) accepts the synthesizer's proposals; none of it touches src/loop:

- a `run` or `read` proposal carries the ledger as `plan.remaining` (an empty `remaining` is read as a completion claim);
- the engine's `verify` intent with no executed run yields the full-suite `run` first; `investigate` yields one or two `read`s of the source files the ledger points at, then the search proceeds (`INVESTIGATE_READS_MAX`);
- after every executed patch the full-suite `run` is a standing obligation until the engine has executed it; it claims the goals the fresh baseline shows fixed (§5.1 row 2) and its goal text states the measured expectation;
- the plan closes with a standing item `verify the full test suite passes` (`VERIFY_ITEM`): a claiming run then still has a non-empty `remaining`, and the final green `done` claims it with the executed green run in `recent` — the completion Noul's own true-example.

## 5. Failure taxonomy used in the tables

- `fix_not_in_candidates`: the true line (QuixBugs `index.json bugLine`) was offered by localisation but no enumerated candidate passed;
- `localisation_missed`: the true line never among Q5's top-3 (p ≥ 0.05) or a Q5n Noul ≥ 0.5 in any localisation answer;
- `ranking_missed`: a passer existed in the candidate set but was cut by a RANK-mode K (not observed: the sieve ran everything at t_run ≤ 2 s);
- `overfit`: a plausible candidate was applied and the hidden evaluator still fails;
- `budget`: no plausible candidate within the step budgets (all such programs here are timeout-dominated suites that forced RANK mode);
- `engine_rejected`: a test-passing candidate existed but every `patch` proposing it was blocked or declined by the engine's risk stage;
- `infra`: sandbox, lane, runner or evaluator failure.

## 6. The three highest-leverage improvements the data suggests

1. **Timeout-dominated suites force RANK mode and lose the sieve (`bitcount`, `sqrt`, `mergesort`: every miss
   of class `budget`).** A looping QuixBugs program costs 2 s per case in the generated pytest module
   (`CASE_TIMEOUT_S = 2`, no knob), so a 9-case suite is an 18 s oracle: `fitOracle` classifies it repository-class
   (16 runs per step, K = 3 ranking) and the depth-1 fix that the sieve would find in one batch is never reached
   (`bitcount`: 421 candidates, 16 run). Two cheap fixes, either of which restores SIEVE mode: run the goal
   subset with `-x` on the lanes (a wrong candidate stops at its first failing case, ≈ 2 s, a right one runs
   everything), and copy `bench/data/quixbugs/run_tests.py` into the QuixBugs workspace so the design's
   `candidate_file` fast path with its adaptive per-test timeout (clamp(3 × p50, 0.5 s, 2 s), cases in parallel)
   applies. Expected: +3 repaired on QuixBugs, and the same mechanism on any suite with a hanging test.

2. **The engine's risk stage against the synthesizer's `patch → run` alternation is the largest source of wasted
   steps and of the remaining `max_steps` endings.** The bench confirmer declines every `review` verdict
   (0.3 ≤ risk < 0.7), and the `plan_mismatch` Score sits in that band with Jev confidence 0.00 on two
   proposal kinds the design needs: the re-run of a command whose last execution "failed" (the tests failed
   before the patch, so re-running them reads as "repeats a step `recent` shows already failed the same way")
   and any proposal under a low-confidence `investigate` intent. The synthesizer already spends its levers
   (ledger in every plan draft, the standing verification item, the measured expectation in the run's goal
   text, intent compliance by `read`, one re-proposal of a rejected passer); what remains is engine-side and
   small: in `jev-only` mode treat a test `run` proposed after an executed change as verification (never a
   repeat), and route `review` on a `run` of the detected test command to `ok` (it is the least destructive
   action the engine has). Expected: median steps 4 → 3 on QuixBugs, and no `max_steps` ending on a repaired
   program.

3. **One goal per failing test on pytest workspaces, and the all-overfit set.** pytest tracebacks show only
   test frames, so `clusterFailures` forms one goal per test (inventory: 4 goals for 2 hunks; QuixBugs
   `reverse_linked_list`, `topological_ordering`: 2–3 goals for one line); a candidate that special-cases the
   attacked test is then "plausible", and `mostPassing` only helps when a sibling test distinguishes it.
   `depth_first_search` is the design's measured all-overfit set (6 plausible, the guard did not flag it, the
   committed `unwrap_call` is a no-op generator expression). Per-test coverage (`src/synth/sbfl` on the lanes,
   `opts.sbfl` of `clusterFailures`, one coverage run per failing test) would cluster the inventory pairs and
   the QuixBugs siblings into one goal each, and the behaviour probe of §2.6 (`perturbedInputs`, wired but not
   yet run on the pytest route) would separate the `depth_first_search` overfits by behaviour before Q15/Q16.
   Expected: fewer overfit commits (2/40 → 0–1) and one goal per hunk on the ladder's multi-bug tasks.

## 7. Exact commands

All from `/Users/prateekjannu/Documents/vscode/JevCode`, keys from `.env` (never printed), no generator key
in the environment:

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit

# step 2: one live end-to-end run through the real engine on a git copy of the inventory task
rm -rf /tmp/jo-inv /tmp/jo-runs && mkdir -p /tmp/jo-inv \
  && cp -R bench/data/ladder/tasks/inventory/{src,tests,pytest.ini} /tmp/jo-inv/ \
  && (cd /tmp/jo-inv && git init -q && printf '.venv\n.venv/\n.jevcode*\n__pycache__/\n' >> .git/info/exclude && git add -A && git -c user.email=t@t -c user.name=t commit -qm init) \
  && mkdir -p /tmp/jo-runs && cp -R ~/.jevcode/runs/ladder-venv /tmp/jo-runs/ladder-venv && ln -sfn /tmp/jo-runs/ladder-venv /tmp/jo-inv/.venv
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx run "Fix the failing tests" \
  --mode jev-only --workspace /tmp/jo-inv --runs-dir /tmp/jo-runs --plain --sandbox auto --max-steps 12 --spend-cap 0.5

# rung 1a (three runs: -1-pre before the stale-.pyc fix, -1b before the standing verification item, -1 final)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs --tasks 40 \
  --conditions jev-only --live --spend-cap 3 --task-spend-cap 0.1 --concurrency 4 --max-steps 12 --max-wall 6m \
  --out bench/results/jev-only-quixbugs-1

# rung 2
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder --tasks 12 \
  --conditions jev-only --live --spend-cap 3 --task-spend-cap 0.25 --concurrency 3 --max-steps 20 --max-wall 10m \
  --out bench/results/jev-only-ladder-1

# per-task tables (stdlib python; joins tasks.jsonl with the run dirs and model_patch.diff vs bench/data/quixbugs/correct/)
python3 /tmp/jo-table.py bench/results/jev-only-quixbugs-1 quixbugs
python3 /tmp/jo-table.py bench/results/jev-only-ladder-1 ladder
```

The bench uses the default runs dir (`~/.jevcode/runs`): the shared pytest venv it builds there
(`ladder-venv`) is what the agent's `python3 -m pytest` resolves to through `<workspace>/.venv`.


## 8. Note, 2026-09-20: `tagcloud` (rung 2 reach miss) diagnosed and re-run — solved in 4 steps

Owner scope: src/synth/templates/**, search/sites.ts (module-level insert sites), search/goals.ts (traceback-derived
hints). Evidence: `~/.jevcode/runs/20260920-195128-bampnvxz` (the rung-2 miss), an offline reproduction through the real
template source and queue vocabulary, and the re-run `bench/results/jev-only-ladder-2-tagcloud` (`20260920-203524-wce4jq5w`).

**Diagnosis.** None of the three suspected causes was the blocker.
(a) No module-level insert site existed (true: sites are the ±3 gaps around function anchors and the frames point at
L28/L36/L54 inside the functions), but the import template already carried the fix from a replace site as an
`extraEdits` insert at L8 (`import_insert_top`, prior 0.7, **first** in the template order at L28); (b) the ranker keeps
extra-edit candidates (`rank/questions.ts isUnchanged` returns false when `extraEdits` is non-empty) and the rung-2
decisions show `"    from collections import Counter\n    return dict(counts)"`-style `import_insert_local` options in
Jev's Choice batches at every site; (c) `verify/apply.ts` applies the L8 insert correctly (the unit test compiles and
`git apply --check`s it). The actual cause is the free vocabulary pre-check of `sieve/queue.ts` (design §3): a candidate
whose NAME tokens are not in file ∪ tests ∪ task vocabulary is dropped, and **`collections` is nowhere in `tagcloud.py`, the
tests or the task text** — `missingFromVocabByPath` returns `['collections']` for both `import_insert_top` and
`import_insert_local`, so every `from collections import Counter` candidate was dropped as `vocab` after enumeration
(and after Jev had ranked it): 1,607 candidates enumerated in step 2, 1,394 tested, the fix never among them. The
transcript has no `collections` at all; `decisions.jsonl` has 18 mentions, all as unranked-then-dropped options.

**Fix (general, no task rule).**
- `goals.ts`: `missingNamesIn` reads CPython's own wording — `NameError: name 'X' is not defined`, `ImportError: cannot
  import name 'X'`, `ModuleNotFoundError: No module named 'X'` — from each test's traceback section and its
  `FailureView.actual`; the goal records `missingNames` (new optional field on `Goal`, search/types.ts).
- `sites.ts`: `importGapSite(file, names)` = the gap before `importInsertLine` (after the last top-level import, else after
  the docstring, else L1), module indentation, no block, for every suspected / beam file that uses one of the names
  unbound (`templates/imports.ts unboundNames`); pushed first among inserts, `orderGoalSites` visits it first, note
  `module-level import gap for X`.
- `templates/imports.ts`: at the import gap every resolved name gets full locality (the use site is elsewhere by
  construction) and the most-used unbound name comes first (`from collections import Counter` at prior 0.70, the family
  prior, index 0); the stdlib table grew to the modules named in the task (~180 names) plus `STDLIB_NAMES_ALT`, a
  second-choice module where two export the name (`sleep`: time then asyncio; `Counter`/`OrderedDict`/`ChainMap`:
  collections then typing; the `collections.abc` twins of the typing ABCs) at p 0.8; `importLinesFor` keeps the best
  prior per text (a corpus file's verbatim import no longer loses to the derived dotted path). Function-level gaps keep
  the indented import at ×0.6.

**Re-run** (`--max-steps 12 --max-wall 8m --task-spend-cap 0.25`): **solved**, 4 steps (`run`, `read`, `patch`, `run`),
stop `complete`, Jev $0.0019 (23 requests), wall 6.4 s, test runs 2. Transcript:
`[step 3] synth verify: g3: 1 tested on 8 lanes (1 plausible) … (candidates=1, tested=1)` /
`[step 3] synth search: g3 commit (phase SEEDS, SIEVE, sites 10, requests 6, runs 2, plausible 1) (candidates=2, tested=1)` /
`[step 3] proposal patch 12 line unified diff: apply verified fix: tests/test_tagcloud.py::test_top_tags now passes (5→9 of 9),
no regressions; template/import_insert at src/tagcloud.py:8`. The localiser agreed with the site: Q3 `where` =
`module_level_code_outside_any_function` 0.73, Q5 `buggy_line` = `none_of_these` 0.97. The committed line is
**`from typing import Counter`** — the second-choice module, because `typing` is in the file's vocabulary and
`collections` still is not: the gap enumerated 2 candidates, the queue dropped the gold one (`vocab`), the other ran and
passed 9/9. Semantically valid (`typing.Counter` is the typing alias of `collections.Counter`; calling it returns a
`collections.Counter`, checked on the venv's 3.9.6), test-passing, not gold-identical.

**Still open, outside this scope (`sieve/queue.ts`, one rule):** the module path of an import statement is resolved by the
interpreter, not by the file's names, so `missingNames` in `queue.ts` should skip the dotted path between `from` and
`import` (and after a bare `import`) while still requiring the bound name (`Counter`) to be in the vocabulary. With that,
`from collections import Counter` (prior 0.70) runs first and the patch is gold-identical; without it every stdlib import
of a module the file does not already name is unreachable, whatever the template proposes. A second, smaller point: at a
module-level gap directly before a `def` (a module with no docstring and no imports, e.g. QuixBugs programs) the guard
family still fires from the def's parameters — pre-existing, harmless (the tests reject them), noted for the template
owner. Unit gates: `tsc --noEmit` clean, `no-any` ok, `vitest --project unit` 1803/1806 — the 3 failures are in
concurrent working-tree changes by others (`budget.test.ts` ×2 against the in-progress `budget.ts`, `engine-evidence.test.ts`).
