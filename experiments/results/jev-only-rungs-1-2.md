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
`topological_ordering` — `overfit`: one plausible candidate on a one-test goal, applied, fails the third of the evaluator's reference cases (the same cases the workspace exposes; there is no hidden suite).

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
- `overfit`: a plausible candidate was applied and the evaluator's reference cases (the same cases the workspace exposes; there is no hidden suite) still fail;
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

## 9. 2026-09-20: the risk stage reads the synthesizer's evidence — ladder 4/12 → 10/12, QuixBugs rejected set 1/3 → 2/3

Owner scope: src/loop/state.ts, src/loop/stages/{risk,intent,judge,complete}.ts, src/synth/search/proposal.ts, the
evidence attachment in src/synth/search/index.ts, test/unit/loop/**, test/unit/synth/search/proposal*.test.ts. Live
re-check: `bench/results/jev-only-ladder-2` (12 tasks, same command as rung 2) and
`bench/results/jev-only-quixbugs-2-rejected` (`reverse_linked_list`, `topological_ordering`, `detect_cycle`, rung 1a
settings). Every number is read from `tasks.jsonl`, `steps.jsonl`, `decisions.jsonl` and `transcript.log` by
`/tmp/jo-risk.py` (per task: patches proposed / applied / blocked-or-declined, rejected runs and dones, the dominant
dimension and level of every rejection from `risk.reason`, `matches_intent` < 0.3 in the reason, `proposal.evidence`
presence, the `evidence_consistent` answers and the intent Choice verdicts from `decisions.jsonl`) and `/tmp/jo-table.py`
(§7). Code state at run time: this change plus the concurrent, uncommitted working-tree changes of the template /
budget owner (§8: `templates/imports.ts` import gap, `goals.ts missingNames`, `sites.ts`, `budget.ts` per-test timeout,
`sieve/runner.ts`, the QuixBugs runner); `tagcloud`'s solve below is theirs (§8), every other delta is in files this
change touched.

### 9.1 The problem, measured on rung 2 (`jev-only-ladder-1`)

41 `patch` proposals, 6 applied, **35 blocked or declined** — every one of the 35 had passed the goal's tests and the
full suite in the synthesizer's shadow lane; 49 `run` proposals rejected, 43 of them with `plan_mismatch` dominant
level 4 "repeats a step `recent` shows already failed the same way" (the post-patch suite run reads as a re-run of the
step-1 run that "failed"), 23 patches at level 4 (a declined patch in `recent` read as a failed step; the next patch as
its repeat), 5 at level 2 "skips a planned verification step"; 42 rejections carried `matches_intent` < 0.3, i.e. the
action was judged against an `investigate` intent that §6 Choice resolution had fallen back to (90 of 211 intent
Choices resolved `fallback`). 29 of the rejected runs were proposed under a *chosen* `edit` intent right after a patch.

### 9.2 What changed

1. **Risk state** (`loop/state.ts proposalJson`, shared by the risk and judge states): when the proposal carries
   `evidence` (`Proposal.evidence`, the contract added in `5c42925`) the state shows it as `proposal.evidence`: command,
   `before`/`after` counts, `newlyPassing`, `newlyFailing`, `goalTests` (each list ≤ 20 ids), `selection`,
   `candidatesTested`, `arbitrated`, plus the code-computed **`verified = newlyFailing.length === 0 && after.passed >
   before.passed`**. Jev never compares counts (REPORT §10: compute in code).
2. **Risk questions** (`stages/risk.ts`): with evidence present the same four one-quantity Scores are asked with three
   clauses added — `out_of_scope` level 0 "…or fixes tests named in `plan.remaining` (`proposal.evidence.goalTests` …)",
   `plan_mismatch` level 2 "…an action whose `proposal.evidence.verified` is true and whose `goalTests` are named in
   `plan.remaining` does not skip verification (the tests already ran against this change in a shadow copy and the next
   step re-runs the suite in the workspace)", level 4 "…(a `patch` whose `proposal.evidence` names a different change
   or different newly passing tests than the earlier attempt is not a repeat, a blocked or declined proposal in `recent`
   never ran so it did not fail, and a test `run` after a change re-runs the suite `proposal.evidence` measured …)" —
   plus one sentence in the two instructions saying what `proposal.evidence` is. `destructive` and `irreversible` are
   untouched (a shadow run says nothing about what is lost); the rubric stays one situation-scale per dimension; the
   0.3 / 0.7 bands and `riskFromProbabilities` are untouched. A paired Noul **`evidence_consistent`** ("Do
   `proposal.evidence` and `recent` agree, i.e. is the claimed test progress plausible given the previous runs?") is
   asked, shown in the pane, and reaches only the reason text (< 0.3 on review/block), like `matches_intent`. The risk
   reason now ends with `evidence verified: 7→9 of 10 pass, no regressions (sieve, 360 tested); proposal: <goal>` so a
   rejected attempt's identity is in `recent[i].reason` for the next attempt's comparison (WindowEntry has no evidence
   field; the reason is the one channel). Without evidence the questions and reasons are byte-identical to before, so
   jev-on and jev-off are unchanged (tests).
3. **Intent stage** (`stages/intent.ts`, `state.ts`): in `jev-only` mode, when `plan.remaining` carries items of the
   fixed grammar `fix <test> in <path>` (`LEDGER_ITEM_RE`), the state carries `mode` and `ledger.items`, the Choice
   describes `edit` as "apply a verified fix for an item in `plan.remaining`" and `verify` as "run the suite after a
   fix" (paired examples reworded to match), and `resolveIntentWithLedger` applies two code rules over §6 resolution:
   a `fallback` whose raw answer is `edit`/`verify` with p ≥ 0.3 takes that answer (verdict `chosen`), and an
   effective `edit` while a change is unverified (`workspace.lastChangeStep` set and `testsCurrent` false — the same
   code-computed facts the completion Noul reads) becomes `verify` (verdict `overridden`, the `can_verify` row
   `chosen`). Guarded on mode **and** ledger presence; the `intent:unresolved` loop signature no longer fires for a
   rescued fallback. jev-on with the same answers over a plan that happens to contain `fix … in …` items still falls
   back (test).
4. **Judge / complete**: `proposal.evidence` is in the judge state through the shared `proposalJson`, next to
   `executed.tests.parsed`; the questions and the completion criteria are unchanged.
5. **Synthesizer** (`search/proposal.ts`, `search/index.ts`): every `patch` carries evidence built from the guard's
   `VerifyOutcome` (`full` — or the subset run when the subset was the whole suite — against the committed baseline;
   `shadowEvidence` uses `verify/progress.ts` for the id sets), a re-proposed passer carries its stashed evidence, the
   standing post-patch `run` carries the measurement it re-executes (the baseline before the patch → the fresh
   baseline on the patched workspace, `scratch.previousBaseline`), and a partial commit carries the held base's summary
   as `after`. The patch goal text is now `apply verified fix: <tests> now pass (N→M of T), no regressions;
   <source>/<op> at <path>:<line>` (`apply partial fix: k of n goal tests now pass …` for a partial). `steps.jsonl`
   keeps `proposal.evidence` whole (the StepRecord stores the Proposal).
6. **Outside the listed scope, needed for the contract to work at all** (each a one-line, additive change, flagged
   here): `loop/stages/synth.ts` rebuilt the Proposal field by field and dropped `evidence` (nothing downstream could
   ever see it) — it now passes it through; `search/types.ts` commit `Decision` gained `outcome?: VerifyOutcome` and
   `after?: TestRunSummary`; `search/guard.ts commit()`/`commitSuspect()` set `outcome`; `search/bases.ts
   commitPartial` sets `after` (the base leaves the beam there, so a later lookup finds nothing — the live
   `reverse_linked_list` partial below went out without evidence before this line); `test/unit/synth/search/guard.test.ts`
   one `toEqual` gained the `outcome` field and `bases.test.ts` two `toEqual`s the `after` field.

Gates: `tsc --noEmit` clean, `no-any` ok, `vitest --project unit` 1830/1831 (the one failure is
`engine-perf.test.ts` "harnessMs < 50 ms" while the bench was still on the CPU; it passes alone), new tests:
`test/unit/loop/{intent,engine-evidence}.test.ts`, additions to `state.test.ts` / `risk.test.ts`,
`test/unit/synth/search/proposal-evidence.test.ts` (builders, controller attachment on patch / re-proposal / post-patch
run, partial `after`).

### 9.3 Ladder 12, before → after (same command; `jev-only-ladder-1` → `jev-only-ladder-2`)

| item | rung 2 (`-1`) | this run (`-2`) |
|---|---|---|
| solved (evaluator) | 4/12 | **10/12** (1-hunk 6/6, 2-hunk 2/3, 3-hunk 2/3) |
| patches proposed / applied / **rejected by the risk stage** | 41 / 6 / **35** | 26 / **19** / 7 |
| `run` proposals rejected | 49 | 28 (see 9.5) |
| rejections with `matches_intent` < 0.3 in the reason | 42 | 16 |
| dominant level of rejections (`kind:dimension@level`) | run:pm@4 43, read:pm@0 24, read:pm@4 23, patch:pm@4 23, patch:pm@0 6, patch:pm@2 5, run:pm@3 4, run:pm@0 2, patch:oos@3 1 | run:pm@0 15, run:pm@4 10, patch:pm@2 6, read:pm@0 4, read:pm@4 3, run:pm@2 2, done:pm@4 1, patch:oos@0 1, run:pm@3 1 |
| intent Choice verdicts chosen / overridden / fallback | 97 / 24 / 90 | 61 / 38 / 27 |
| proposals with `evidence` | 0 | 61 (26/26 patches, 35 post-patch runs) |
| `evidence_consistent` | – | n = 61, median 0.79, mean 0.75, 3 below 0.3 |
| parked goals in the final ledgers | 8 (shipping 4, tagcloud 3, textstats 1; sources exhausted) | 2 (calendar_utils 1, inventory 1; two consecutive budget-hit steps) |
| stop reasons | max_steps 10, complete 2 | complete 9, max_steps 2, replan_stop 1 |
| steps median (mean); steps-to-solve median over solved | 20 (18.5); 7 | 7 (10.5); 5 |
| test runs total | 36 211 | 23 254 |
| Jev cost | $0.277 | **$0.104** |
| wall median / max | 325 s / 537 s | 122 s / 360 s |

| task | hunks | before: solved, steps, patches applied / rejected | after: solved, steps, stop, patches applied / rejected, runs rejected, Jev $, wall s | note |
|---|---|---|---|---|
| events | 1 | yes, 20, 1 / 0 | **yes, 4, complete**, 1 / 0, 0, 0.0018, 51 | the post-patch run executes (was declined 10×) |
| calendar_utils | 3 | no, 20, 1 / 0 (2 of 3 hunks) | no, 19, replan_stop, 3 / 0, 5 (+1 done), 0.0204, 360 | 4 of 5 goals fixed and applied; the last (`test_day_of_year_last_day`) hit two consecutive budget-hit steps (RANK, 2 214 + 1 621 candidates), parked; the partial `done` blocked ×3 as §5.5 intends → `replan_stop`. Class: budget |
| grades | 2 | no, 20, 0 / 6 | **yes, 20, max_steps**, 2 / 1, 8, 0.0104, 54 | both hunks applied by step 7; the second post-patch run was declined 8× at 0.32–0.40 (9.5a) so the run never saw `complete` |
| profiles | 1 | yes, 4, 1 / 0 | yes, 3, complete, 1 / 0, 0, 0.0013, 31 | |
| account | 3 | no, 20, 1 / 4 (1 of 3) | **yes, 14, complete**, 2 / 0, 4, 0.0107, 285 | |
| stats | 1 | yes, 7, 1 / 2 | yes, 3, complete, 1 / 0, 0, 0.0013, 19 | |
| inventory | 2 | no, 20, 0 / 6 | no, 20, max_steps, 2 / 1, 7, 0.0263, 296 | 3 of 4 goals fixed and applied (evaluator 9/10); the last (`test_total_value`) budget-parked after 978 + 1 484 runs. Class: budget |
| shipping | 1 | no, 20, 0 / 4 (4 parked) | **yes, 6, complete**, 1 / 0, 2, 0.0040, 181 | |
| table | 3 | yes, 20, 1 / 2 | yes, 5, complete, 1 / 0, 1, 0.0093, 129 | the two-file composite patch applied first time |
| tagcloud | 1 | no, 20, 0 / 0 (3 parked) | yes, 4, complete, 1 / 0, 0, 0.0019, 7 | the §8 import-gap fix (other owner); the patch went through at 0.25 with evidence |
| units | 1 | no, 20, 0 / 7 | **yes, 20, complete**, 2 / 5, 0, 0.0117, 205 | the verified patch was declined 5× at level 2 under `investigate` before the engine had ever run the suite (9.5b) |
| textstats | 2 | no, 20, 0 / 4 | **yes, 8, complete**, 2 / 0, 1, 0.0044, 115 | |

### 9.4 QuixBugs, the three rejection-prone programs (`jev-only-quixbugs-1` → `jev-only-quixbugs-2-rejected`)

| program | before: repaired, steps, stop, patches applied / rejected, runs rejected, Jev $ | after | note |
|---|---|---|---|
| detect_cycle | yes, 12, max_steps, 1 / 0, 5, 0.0045 | **yes, 4, complete**, 1 / 0, 0, 0.0016 | same visible-test-only fix as before (correct-by-diff no) |
| topological_ordering | no (overfit), 12, max_steps, 1 / 0, 4, 0.0049 | **yes, 10, complete**, 2 / 1, 1, 0.0051 | two goals fixed in turn (0→2, then 2→3 of 3); passes the evaluator's reference cases (the same cases the workspace exposes; there is no hidden suite) now; the first patch was declined once at level 2 (9.5b) and re-proposed |
| reverse_linked_list | no (engine_rejected), 12, max_steps, 0 / 3, 1, 0.0100 | no, 12, max_steps, 0 / 2, 0, 0.0098 | **a search miss this time, not an engine rejection**: 0 plausible in 1 051 + 115 WIDENED runs (the `prevnode = node` passer of rung 1a came after 1 300 runs); the two rejected patches were one unverified `partial` (`insert_return_after`, without evidence — §9.2 item 6 closes that gap) and its re-proposal; one `propose: jev_response` stage failure at step 5; 5 `read`s under `investigate` declined/blocked at level 4 |

Totals: 1/3 → 2/3; Jev $0.019 → $0.017; `evidence_consistent` n = 8, min 0.70.

### 9.5 What still gets rejected, and the one lever left

(a) **Post-patch `run` under an overridden `verify`, reviewed at 0.30–0.43 with `plan_mismatch` level 0 dominant but
spread mass (Jev confidence 0.00)** — 15 of the 28 rejected runs (grades ×8, account ×2, calendar_utils, inventory,
shipping, table, textstats). In every case Jev answered `investigate` and §6 overrode it to `verify` on `can_verify`
≥ 0.5; `evidence_consistent` was 0.6–0.87 (they agree); levels 2, 3 and 4 each took 0.15–0.3, so the tail term crossed
0.3. The runs execute on the next step in every task but `grades`, where the same run was declined 8 times in a row
(steps 10–20; the task was already solved by step 7). The common feature of those 8: the run claimed two done items,
one of which the judge had rejected on the previous run (`done_1` < 0.3 at step 6), so the state showed the same
claim twice. Worth a Jev-side look at the claim wording before any code change.

(b) **A verified `patch` declined at level 2 "skips a planned verification step" (0.31–0.44)** — 6 patches: units ×4
(+1 at 0.40 whose max was level 2 too), topological_ordering ×1, grades ×1, inventory ×1. Five of the six were
proposed under an `investigate` intent **before the engine had executed the suite even once** in that run (the run
opened with reads; the synthesizer proposes its first full-suite `run` only under `verify` or after a change,
`engineNeedsRun && (intent === 'verify' || lastChangeStep !== null)` in `search/index.ts`), so from `recent` the plan's
standing verification item had never run. The level-2 clause moved the mass (0.4–0.55 on level 2, vs 0.75–0.85 on
level 4 before) but not below the band. The lever is a controller policy, one condition wide and outside this
change's scope: propose the full-suite `run` first whenever the engine has no executed suite run at all
(`scratch.lastEngineRun === null`), whatever the intent. It would have removed the 5 `units` and `topological_ordering`
declines (units still finished `complete` at step 20; with the rule its 2 patches land by step 5).

(c) Pre-existing and intended: budget-hit `record the failing behaviour` subset runs (no evidence: there is nothing to
compare) and the partial `done` on `calendar_utils` / `inventory` blocked at level 3/4 until `replan_stop` (§5.5).
`read` proposals declined/blocked at level 4 as "repeats" (7 on the ladder, 5 on QuixBugs) are the `investigate`
compliance reads (`INVESTIGATE_READS_MAX`), not this change's concern.

### 9.6 Spend

Ladder-2 $0.1035 + QuixBugs-2 $0.0165 = **$0.12** of the $4 allowed for this re-check; cumulative live spend of this
report ≈ $1.33 of the $3 cap (§3 + §8 + §9). Generator calls 0 on every record.

### 9.7 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/loop test/unit/synth/search

# ladder re-check (rung 2 command, new out dir)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder --tasks 12 \
  --conditions jev-only --live --spend-cap 3 --task-spend-cap 0.25 --concurrency 3 --max-steps 20 --max-wall 10m \
  --out bench/results/jev-only-ladder-2

# the three QuixBugs programs (rung 1a settings)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id reverse_linked_list,topological_ordering,detect_cycle --conditions jev-only --live --spend-cap 3 \
  --task-spend-cap 0.1 --concurrency 3 --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-2-rejected

# analysis (stdlib python; joins tasks.jsonl with steps.jsonl, decisions.jsonl and transcript.log)
python3 /tmp/jo-risk.py bench/results/jev-only-ladder-2
python3 /tmp/jo-table.py bench/results/jev-only-ladder-2 ladder
python3 /tmp/jo-table.py bench/results/jev-only-quixbugs-2-rejected quixbugs
```

## 8. 2026-09-20 (later): the timeout-dominated suites — adaptive per-test timeout on the lanes, adjusted t_run, SIEVE hysteresis

Follow-up to §1's `budget` misses (`bitcount`, `sqrt`, `mergesort`, `shunting_yard`) and §6 item 1. The five
programs were re-run twice live (`--task-id bitcount,sqrt,mergesort,shunting_yard,find_first_in_sorted`, same
flags as §1 plus `--spend-cap 1`); the code changed once between the two runs (§8.1 items 7–8). Everything in
this section was measured, first on the generated pytest modules of the five programs with `pytest
--durations=0` on idle cores (reference machine, 15 cores), then in the two runs.

| program | cases | cases at the 2 s alarm | baseline idle | baseline in the §1 bench (4 tasks × 8 lanes) | what the time is |
|---|---|---|---|---|---|
| bitcount | 9 | 9 | 18.2 s | 18.7 s | 9 × 2 s alarm |
| sqrt | 7 | 6 | 12.2 s | 12.7 s | 6 × 2 s alarm |
| find_first_in_sorted | 7 | 2 | 4.2 s | 4.7 s | 2 × 2 s alarm |
| mergesort | 14 | 0 | 1.96 s | 5.0 s | pytest rendering 13 thousand-frame `RecursionError` tracebacks (`--tb=native`: 0.14 s); crossed 2 s under load only |
| shunting_yard | 6 | 0 | 0.21 s | 0.58 s | nothing slow; the `RANK` in its §1 trace came from one batch of raising candidates measuring > 2 s under load |

So the §1 diagnosis was right for `bitcount` and `sqrt` and half-right elsewhere: `mergesort` is a slow-traceback
suite, not a timeout suite, and `shunting_yard` was never lost to the budget — its gold fix is an *insertion*
(`opstack.append(token)` after line 17) that none of the sources produces (parked "exhausted composite, donor,
mutation, template at 7 sites" with the `shunting_yard.py:17 (gap)` site among them, in §1 and in both runs
here): a `fix_not_in_candidates` miss the sieve cannot repair.

### 8.1 What changed (src/synth/search/budget.ts, src/synth/sieve/runner.ts, src/synth/verify/quixbugs.ts, src/bench/quixbugs/pytest.ts, bench/data/quixbugs/run_tests.py)

1. **Per-test timeout from the cases that finished** (`caseProfile`, `perTestTimeout`). The timed-out cases are
   read from the failure texts (`CaseTimeout: no result after 2s`, `TIMEOUT after 2s`), their 2 s each is taken
   out of the baseline, the fixed cost is taken out of the rest and the remainder is spread over the finished
   cases: `perTestTimeoutMs = clamp(3 × p50(finished), 500, 2000)`, 500 ms when nothing finished. `bitcount`
   500 ms (was 2 s: `18 238 / 9` read the alarms as a 2 s p50), `sqrt` 500–840 ms depending on the load at
   baseline time. The pytest runner now has a per-test timeout too (it was `null`): the generated module reads
   it (item 2); other pytest suites ignore it.
2. **The lanes get the timeout.** The generated pytest module reads `JEVCODE_CASE_TIMEOUT_MS` (default 2000)
   and `JEVCODE_MAX_CASE_TIMEOUTS` (default none); the sieve runner sets them on every lane run of a pytest
   oracle (`laneRunEnv`: the oracle's per-test timeout and `1`). After one case timeout the module reports the
   remaining cases as `CaseNotRun: not run: 1 earlier case(s) timed out` without calling them. Measured lane
   cost of a hanging candidate on idle cores: `bitcount` 661 ms (was 18 s), `sqrt` 630 ms; a correct `sqrt`
   106 ms. The agent's own `pytest -q`, the engine's `run` proposals and the evaluator (`run_tests.py`, no
   `--timeout`) are untouched. `run_tests.py --timeout` also accepts `500ms` / `0.5s` and there is `--timeout-ms N`
   (additive; the default is still 2 s). What the stop rule gives up: whether a candidate that hangs on an early
   case would pass a later one — never a plausible candidate, and a hanging run is never held as a base (§4.1).
3. **Adjusted t_run, class and lanes** (`estimateRunMs`). `tRunMs` = process start + collection/reporting +
   the finished cases' time + min(timeouts, 1) × min(observed case time, per-test timeout) on the pytest
   module (rounds of 8 on run_tests.py, whose cases are parallel); `oracleClass`, `laneCount` and
   `decideRunPlan` read it; `baselineDurationMs` keeps the raw duration (reporting, the repository-class wall,
   the workspace command's `runTimeoutMs`, which still runs the module at 2 s per case). `bitcount`: t_run
   738 ms from the idle baseline (1 140 ms from the loaded one, item 7) → QuixBugs-class, `runsLeft =
   floor(90 s × 8 / 0.738 s) = 975 ≥ 421` → SIEVE (was 18.7 s → repository-class, 4 lanes, RANK at 16 runs a
   step). The arithmetic the §1 report implied does not hold on its own: at 9 × 0.5 s = 4.5 s a hanging run,
   421 candidates cost 237 s at 8 lanes, far over the 90 s wall; only the stop rule (one alarm per run) makes the
   sieve fit.
4. **SIEVE hysteresis under load** (`refineTRun`). A batch median under 2 s is taken as measured; one between
   2 s and 3 s (1.5 × SIEVE_MAX_T_RUN_MS) does not move a sieve-eligible estimate; above 3 s the measurement
   wins (RANK). `runsLeft` already used `oracle.lanes` (`floor(testWallLeft × lanes / t_run)`); the runner's
   workers are `min(pool.lanes, oracle.lanes)` and a unit test now pins the peak overlap to the lane count
   (8 of 8, 3 of 3). Found while checking: a lane pool built for a 4-lane oracle survived a re-fit to 8 lanes
   and serialised at 4; the pool is now rebuilt whenever the oracle asks for more lanes.
5. **Hanging candidates are `timeout`** (`hangsOnEveryFailure`). A run whose every failing case hit the alarm
   (or was not run after one) is classified `timeout` — never a base — where the old table said `unchanged`
   when the buggy program hung on the same cases (203 of bitcount's 455 candidates in run b). The sandbox
   timeout of a lane run is `laneRunTimeout` = min(`runTimeoutMs`, max(3 × t_run + 10 s, cases × per-test
   timeout + start + 10 s)) — `bitcount` 14.7 s instead of the 66 s workspace timeout, and never the 120 s
   command default.
6. **mergesort**: the generated module re-raises `RecursionError` shallow (`raise RecursionError(str(exc))
   from None`); the message pytest reports is the same, the 1.96 s idle baseline becomes 0.21 s (measured), so
   the suite no longer crosses 2 s under bench load (0.96–1.5 s wall in the two runs, of which 0.44 s is the
   pytest session).
7. **Found in run a, fixed for run b: the baseline's start-up is not the suite's.** Measured through the
   engine, with four tasks starting together, every program's baseline carried 870–1 060 ms of interpreter
   start-up (wall minus pytest's own "… in 12.33s" session clock) while the lanes then ran whole suites in
   380–800 ms. Spread over `sqrt`'s one finished case that burst read as a 1.2 s p50 → 2 s per-test timeout →
   t_run 3.4 s → repository-class (16 runs a step, RANK) — `sqrt` missed again in run a for exactly §1's reason.
   `caseProfile` now reads pytest's session clock from the output tail (`pytestSessionMs`) and charges a lane
   run PROCESS_OVERHEAD_MS (200 ms, measured idle) instead of the baseline's own start-up; without a session
   clock (`-qq` output, run_tests.py) the old arithmetic stands. On run a's baselines: `sqrt` 840 ms timeout,
   t_run 1 370 ms, QuixBugs-class; `bitcount` 1 140 ms; `mergesort` 640 ms (was 1 497), `shunting_yard`
   420 ms (was 1 187).
8. **Lanes follow the measured t_run upward** (`refineLanes`). Run a fitted 4 lanes to all five programs (their
   1.2–19 s baselines) and never widened; after each batch the oracle now takes the fast suite's 8 lanes once a
   run measures under 1 s (never narrower, never on `inplace` lanes), and the pool is rebuilt at the next call
   (item 4). Visible in run b's `bitcount` trace: `run median 385 ms, t_run 385 ms, lanes 4 → 8`.

Tests (test/unit/synth/search/budget.test.ts, test/unit/synth/sieve/runner.test.ts,
test/unit/synth/verify/quixbugs.test.ts, test/unit/bench/quixbugs.test.ts): `fitOracle` on an all-alarm
baseline → 500 ms, t_run 738, QuixBugs-class, 8 lanes; mixed baselines → clamp(3 × p50 finished) with the hung
cases not voting; the same with run a's session clocks (`sqrt` 840 ms / 1 370 ms / QuixBugs-class against
2 s / 3 370 ms / repository without the clock); `decideRunPlan` on bitcount's numbers → SIEVE inside the 90 s wall
(RANK without the stop rule); `refineTRun` band; `refineLanes`; `laneRunTimeout`; runner peak overlap = lanes;
lane env; `timeout` classification; pool rebuild and widening; the generated module under `python3` with a
sleeping fixture at a 100 ms limit (a 0.4 s case fails at 0.1 s and passes unset; the stop rule leaves the rest
"not run"; the same under pytest when it is importable); `run_tests.py --timeout 100ms|0.1|0.1s|--timeout-ms 100`
on the buggy bitcount (9 timeouts in < 5 s), `--timeout 0|abc` → exit 2, the evaluator's command carries no
`--timeout`. Gates: `tsc --noEmit` clean, `no-any` ok, unit 133 files / 1 831 tests green.

### 8.2 Live re-checks (`bench/results/jev-only-quixbugs-2-slow`, then `-2-slow-b`)

Same flags as §1 (`--conditions jev-only --live --spend-cap 1 --task-spend-cap 0.1 --concurrency 4 --max-steps 12
--max-wall 6m`), generator calls 0 on every record. "class at step 1" is read from the first batch's run cap
(1 500 = QuixBugs-class, 16 = repository); "run median" is the runner's per-batch median of the lane runs
under the bench's load; "modes seen" is the mode of the last run plan of each search (a search that sieved
three sites and then ranked a 2 000-candidate set prints RANK).

**Run a** (items 1–6; `-2-slow`): **repaired 3/5**, Jev $0.042, wall total 713 s (§1: 0/4 of the misses, 952 s for the same five).

| program | repaired | steps | baseline ms (raw) | class at step 1 | lanes at step 1 | run median ms (min–max over batches) | modes seen | candidates run | of them `timeout` | commit at step | wall s | Jev $ | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bitcount | yes | 6 | 19309 | QuixBugs | 4 | 658–1458 | RANK/SIEVE | 502 | 232 | 5 | 175 | 0.0041 | complete |
| sqrt | no | 12 | 13370 | repository | 4 | 611–2920 | RANK | 167 | 77 | - | 131 | 0.0078 | max_steps |
| mergesort | yes | 8 | 1497 | QuixBugs | 4 | 741–1097 | RANK | 557 | 0 | 6 | 163 | 0.0089 | complete |
| shunting_yard | no | 12 | 1187 | QuixBugs | 4 | 259–811 | RANK | 1186 | 11 | - | 228 | 0.0197 | max_steps |
| find_first_in_sorted | yes | 3 | 6210 | repository | 4 | 382 | RANK | 5 | 0 | 2 | 16 | 0.0018 | complete |

`sqrt`'s miss here is item 7 (the start-up burst read as the one finished case's time); every program ran on
4 lanes because the burst also put every estimate at or above 1 s (item 8). `bitcount` still needed two
steps of sieve (RANK at step 3 while the baseline-time estimate was 1.8 s, SIEVE at step 5 once the lanes had
measured 0.7 s).

**Run b** (items 1–8; `-2-slow-b`): **repaired 4/5**, Jev $0.031, wall total 634 s; patches identical to
`bench/data/quixbugs/correct/` (`n &= n - 1`, `while abs(x - approx ** 2) > epsilon:`, `if len(arr) <= 1:`,
`while lo < hi:`).

| program | repaired | steps | baseline ms (raw) | class at step 1 | lanes at step 1 (widened) | run median ms (min–max over batches) | modes seen | candidates run | of them `timeout` | commit at step | wall s | Jev $ | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bitcount | yes | 6 | 19289 | QuixBugs | 4 (4→8) | 385–1315 | SIEVE | 455 | 203 | 5 | 155 | 0.0040 | complete |
| sqrt | yes | 4 | 13110 | QuixBugs | 8 | 1337 | SIEVE | 117 | 52 | 3 | 54 | 0.0016 | complete |
| mergesort | yes | 6 | 955 | QuixBugs | 8 | 221–1567 | RANK | 1099 | 0 | 5 | 171 | 0.0128 | complete |
| shunting_yard | no | 12 | 880 | QuixBugs | 8 | 141–1553 | SIEVE | 2448 | 22 | - | 223 | 0.0110 | max_steps |
| find_first_in_sorted | yes | 3 | 6025 | QuixBugs | 8 | 1277 | SIEVE | 85 | 0 | 2 | 31 | 0.0015 | complete |

Per program: `bitcount` — QuixBugs-class from the first baseline (t_run 1 140 ms), 4 lanes until the third
batch measured 385 ms (`lanes 4 → 8`), SIEVE throughout, 455 candidates run (203 hung, each one alarm), the
gold `n &= n - 1` plausible at step 5 (the step-3 sieve of 340 candidates ran out of test wall at 8 lanes
under a 1.1–1.3 s run median: hanging runs cost 0.5 s alarm + ~0.6 s loaded start-up). `sqrt` — QuixBugs-class,
8 lanes, one SIEVE of 117 candidates at step 3 (52 hung), gold plausible, committed, green baseline at step 4.
`mergesort` — QuixBugs-class, 8 lanes, 1 099 candidates run over two steps (the last plan of each search was a
RANK cut of a 2 000+ set; the sites before it sieved), gold plausible at step 5. `find_first_in_sorted` —
QuixBugs-class now (was repository in §1 and run a), one 85-candidate SIEVE at 8 lanes, 4 plausible, gold
committed at step 2 (§1: RANK of 5). `shunting_yard` — sieved 2 448 candidates at 8 lanes over three searches
(SEEDS, then WIDENED), 0 plausible, parked twice as exhausted at 7 sites: the insertion is not in any source's
set (see the top of §8); not a budget miss.

Live spend for §8: $0.042 + $0.031 = **$0.073** (generator $0 / 0 calls), against the $1 cap.

### 8.3 What remains

- `shunting_yard`: `fix_not_in_candidates` — the `else:` branch needs `opstack.append(token)` inserted after
  the `while` loop; the insert-site sources (template, donor, sketch) have no statement of that shape. Not a
  runner or budget matter.
- The repository-class detection still rests on one measurement taken at the run's busiest moment; item 7
  removes the start-up from it where pytest prints a session clock, not the load on the cases themselves
  (`sqrt`'s lane runs measured 1.3 s under load against 0.63 s idle). The 1.5 × hysteresis (item 4) covers the
  next factor of two.
- The `modes seen` column shows the trace records the mode of the *last* plan of a search; a per-batch mode in
  the trace (or a count of sieved vs ranked candidates) would make the §2.4 decision auditable per site.
- With the stop rule a partial that hangs on an early case and passes later ones is `timeout`, not `partial`;
  none of the two-step repairs the design lists (`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`)
  hangs, and none was affected here, but the trade is worth remembering if a hanging two-step repair appears.

### 8.4 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth/search test/unit/synth/sieve test/unit/bench

# per-case timings of the five generated modules (workspaces built by a 20-line tsx script from src/bench/quixbugs/pytest.ts + writePytestLayout)
PYTHONDONTWRITEBYTECODE=1 ~/.jevcode/runs/ladder-venv/bin/python -m pytest -q --durations=0     # in each /tmp/qb-<name>

# run a (items 1–6) and run b (items 1–8)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id bitcount,sqrt,mergesort,shunting_yard,find_first_in_sorted --conditions jev-only --live --spend-cap 1 \
  --task-spend-cap 0.1 --concurrency 4 --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-2-slow      # then -2-slow-b

# the tables (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/transcript.log)
python3 /tmp/qb-slow-table.py bench/results/jev-only-quixbugs-2-slow-b
```
Run ids: run a `20260920-203814-nbvb4som` (bitcount), `-jghe2xvl` (sqrt), `-zjai6dos` (mergesort), `-va7bm4bv`
(shunting_yard), `20260920-204028-ywr3jsp6` (find_first_in_sorted); run b `20260920-205025-zycr6z4z`,
`-2ozxircg`, `-mapkpitr`, `-4hbeexhd`, `20260920-205120-s4e4pfp4`.

## 10. 2026-09-20 (later): step policy — the establishing run, one claim per verdict, `done` after the green run; ladder `grades`/`calendar_utils`/`inventory` 1/3 → 3/3 (all at `max_steps`), then `grades` `complete` at step 10 once the all-green run claims everything

Owner scope: `src/synth/search/{index,proposal,memory}.ts` and their tests. Live re-check: `bench/results/jev-only-ladder-3-policy`
(the three tasks of §9.5, same command as rung 2 with `--task-id grades,calendar_utils,inventory --spend-cap 1`), then
`bench/results/jev-only-ladder-3-policy-b` (`grades` alone, §10.6). Every number is read from `tasks.jsonl`, `steps.jsonl`
and `decisions.jsonl` by `/tmp/jo-risk.py` (§9), `/tmp/jo-table.py` (§7) and `/tmp/jo-steps.py` (per step: intent, kind,
outcome, parsed counts, risk `dimension@level`, `judge.doneClaims`, the run's `claimed`/`deferred` from `rawText`, the
claim notes in `openProblems`). Code state at run time: this change plus the concurrent, uncommitted working-tree changes
of the sites / templates owner (`src/synth/search/sites.ts`, `src/synth/localize/{index,sites}.ts`,
`src/synth/templates/{common,statements}.ts`); the vanished budget parks below (§10.3) are theirs as much as mine and are
not attributed.

### 10.1 The two defects, restated as the controller saw them

§9.5(a): 15 post-patch `run`s declined at 0.30–0.43 (`plan_mismatch` level 0 dominant, mass spread, Jev confidence 0.00),
several re-claiming an item the judge had not accepted on the previous run (`grades` ×8, solved at step 7, `max_steps`).
§9.5(b): 6 verified `patch`es declined at level 2 "skips a planned verification step", 5 under `investigate` before the
engine had executed the suite at all (`units` ×4, `topological_ordering`) — the synthesizer proposed its first full-suite
`run` only under `verify` or after a change (`engineNeedsRun && (intent === 'verify' || lastChangeStep !== null)`).

### 10.2 What changed

1. **The establishing run** (`search/index.ts`, `ESTABLISH_GOAL`). The gate is now `engineNeedsRun(mem)` alone: when
   the engine has never executed a `run` with parsed counts in this run (`mem.lastEngineRun === null`, the controller's
   record across every window so far), the first proposal is the full-suite `run` — goal `establish the failing tests:
   run the full test suite before any change (N of T fail in the synthesizer's own run)` — whatever the intent, and
   without the `investigate` compliance read first (that read stays for the post-change run). The synthesizer's own
   baseline still runs before it, so the run's plan carries the ledger (`remaining` non-empty; §5.1). The engine then
   has an executed baseline for `testsCurrent` and for the plan_mismatch rubric's "planned verification step".
2. **One claim per verdict** (`search/memory.ts` `claims`, `recordClaims`, `resolveClaims`; `search/proposal.ts`
   `splitClaims`, `claimNote`, `deferredClaimNotes`). A `run` that claims items records them (plan item → step, pending);
   the next `synthesize()` settles the record from the engine: an item in `plan.done` leaves the record (accepted), a
   `run` the window shows executed gives the judge's `done_<j>` from `judge.doneClaims`, a blocked / declined / failed
   run never judged the claim so the record is dropped (the item is free to be claimed again — a declined run is not a
   claim), and a claim whose step left the 4-entry window is read from the accepted plan (`unverified[].judged`, or the
   `rejected_claim` harness note's `done_<j> = p`). `splitClaims` then claims only items with no record, and defers an
   item whose claim was judged and not accepted **until it has fresh evidence**: a new passing full-suite run executed
   by the engine (`mem.lastEngineRun` all-pass, the suite by label or count, later than the claim, no change after it),
   or — added after the first live run, §10.6 — a run the synthesizer's own fresh baseline already measured all-green
   (every claim on that run is verifiable from its output; a `done` grades no claims, so a final run that deferred
   would leave the items in `plan.remaining` for good). Until then it stays in `remaining` with an `openProblems` note
   `'<item>' claimed at step N, judge said p=0.67; this test run re-verifies it before it is claimed again` (the first
   live run used the bare `…; re-verify`, §10.6). The records persist in `synthState` as `claims` next to the goal records (`PersistedClaims`, an
   optional extension of `PersistedSearchState` written by `toPersisted` and restored by both `rebuildFromPlan` shapes and
   `restoreMemory`; `types.ts` untouched, and keyed by plan item so `goals.ts reconcile` cannot lose them). A `done`
   records nothing (its claims are never judged: `noop` has no executed output) and still claims every unaccepted fixed
   item with the green run in `recent`, as before.
3. **`done` after the green run** (`search/proposal.ts doneReadiness`, `engineRunOnCurrentWorkspace`,
   `isFullSuiteRun`). The engine's last executed run is read from the window first and then from the controller's record
   (`mem.lastEngineRun` / `mem.lastChangeStep`, moved from the controller-private `RunScratch` into `SearchMemory` so the
   builders can read them; they outlive the window and are re-observed on resume). Once the engine has executed the
   green suite on the current workspace, the synthesizer proposes `done`, never another run — a green run that scrolled
   out behind reads or declined `done`s no longer re-proposes the run (`proposeDone`'s fallback run also keeps the
   deferred-claim notes next to its blocker).
4. Bookkeeping: `observeWindow` records the run's window label (`EngineRun.action`) so the suite check can compare it
   with `runActionLabel(command)`; `synthesize()` calls `resolveClaims` before the step and `recordClaims` after it for a
   `run` with claims; `RunScratch` keeps only `startedMs`, `baselineStep`, `lastCommit`, `previousBaseline`, `restored`,
   `rejected`.

Gates: `tsc --noEmit` clean for this change (the three remaining errors are unused declarations in the other owner's
uncommitted `src/synth/localize/sites.ts` / `src/synth/search/sites.ts`); `no-any` ok; `vitest --project unit` on
`test/unit/synth/search/{controller,proposal,proposal-evidence,memory}.test.ts` + `test/unit/loop` 206/206 (the whole
`test/unit/synth/search` directory has 6 failures, all in `sites.test.ts` against the other owner's in-progress
`sites.ts`; the whole unit project 1840/1841, the one failure `localize/sites.test.ts`, theirs). New tests: the gate
(first proposal is the establishing run under `investigate` / `edit` / `verify`; a declined one is proposed again; after
an executed run the search proceeds), single claim + deferral with the note + re-claim on the `done` after the green
run + `done` with the green run scrolled out of the window, a declined run's claim is free again, `splitClaims` over
passing / subset / failing / stale runs, `proposeRun` notes and `rawText.deferred`, `doneReadiness` fallback,
`recordClaims` / `resolveClaims` (window verdict, declined, plan `unverified`, `rejected_claim` note, unknown), and the
persisted round trip with junk tolerance. The controller tests' `ctxFor` now opens every window with an engine-executed
run at step 0 unless a test says `engineRun: false`, because the establishing run comes first otherwise.

### 10.3 Live: the three tasks, before → after (`jev-only-ladder-2` → `jev-only-ladder-3-policy`)

| item | rung 2 (`-2`), these three | this run (`-3-policy`) |
|---|---|---|
| solved (evaluator) | 1/3 (grades; calendar_utils 4 of 5 goals, inventory 3 of 4) | **3/3** (every goal fixed and applied: ledgers fixed 3 / 4 / 5, open 0, parked 0) |
| steps; stop | 20 max_steps / 19 replan_stop / 20 max_steps | 20 / 20 / 20, all `max_steps` |
| step at which the last fix was applied | 7 / – / – | **7 / 13 / 13** (grades / inventory / calendar_utils); the final post-patch run then never executed |
| patches proposed / applied / rejected | 9 / 7 / 2 | 13 / 8 / 5 (grades 3/2/1, inventory 6/2/4, calendar_utils 4/4/0) |
| `run` proposals rejected | 20 | 18 (grades 7, inventory 5, calendar_utils 6) |
| claiming runs proposed / executed | – | 22 / **5** (17 declined at 0.30–0.66); the 3 establishing runs executed at once (risk `ok`) |
| dominant level of rejections | run:pm@0 15, run:pm@4 5 (§9.5) | run:pm@0 12, patch:pm@2 4, read:pm@0 3, run:pm@3 3, run:pm@4 2, run:pm@2 1, patch:oos@0 1 |
| rejections with `matches_intent` < 0.3 | – | 7 (all under `investigate`) |
| intent Choice verdicts chosen / overridden / fallback | – | 29 / 20 / 11 |
| `evidence_consistent` | – | n = 35, min 0.60, median 0.82, mean 0.81, 0 below 0.3 |
| budget parks | 2 (calendar_utils `test_day_of_year_last_day`, inventory `test_total_value`) | 0 |
| test runs (synthesizer) | – | 579 / 2 439 / 5 706 |
| Jev cost | $0.057 | **$0.039** ($0.0100 / $0.0105 / $0.0182) |
| wall | 54 / 360 / 296 s | 56 / 142 / 247 s |

Per task (`/tmp/jo-steps.py`):

- **grades** (2 hunks): 1 establishing run 7/10 → 2–3 reads → 4 patch declined (pm@2, 0.35, under `edit`) → 5 the
  re-proposed passer applied → 6 run 9/10, claims `unequal_weights` (0.74, accepted) and `fractional_weights` (0.67,
  unsure) → 7 second patch applied (10/10 in the synthesizer's baseline) → 8–9 reads → **10–14, 17, 20: the post-patch
  run declined 7× at 0.41–0.66**, claiming `boundaries` alone, `fractional_weights` deferred with the note. Solved by
  step 7, as in rung 2; the run's `plan_mismatch` mass moved rather than shrank (§10.5).
- **inventory** (2 hunks): 1 run 6/10 → 4 patch applied (6→8) → 5 run declined (pm@2, 0.33) → 6 run 8/10, claims
  `page_first` 0.55 / `page_last_partial` 0.33, both unsure → 7, 9, 12 verified patches for `test_total_value` declined
  at pm@2 0.33–0.43 (8 at oos@0 0.34), after the engine had run the suite twice → 13 applied (10/10) → **14–16, 19 run
  declined 4×** (0.30–0.59), claiming the two `total_value` items, the two `page` items deferred. Rung 2 had this goal
  budget-parked after 978 + 1 484 runs; here it was fixed at step 13 (2 439 runs in total).
- **calendar_utils** (3 hunks): 1 run 5/10 → 4 patch → 5 run declined (pm@3, 0.42) → 6 run 6/10 (`test_parse_iso`
  0.59, unsure) → 7 patch → 8 run 8/10 (two claims accepted 0.75 / 0.78) → 9 patch → 10 run declined (0.31) → 11 run
  9/10 (accepted 0.83; `parse_iso` deferred) → 12 budget subset run declined (0.46) → 13 patch (10/10) → **14, 16, 19 run
  declined** (0.33–0.45). Rung 2 parked the last goal after two budget-hit steps and stopped on `replan_stop`.

### 10.4 What each rule did

1. **Establishing run.** All three runs opened with it, executed at once (risk `ok`, parsed 7/10, 6/10, 5/10), one step
   each. None of these three tasks was a §9.5(b) case in rung 2 (`units` and `topological_ordering` were; not in this
   live set), so the rule's effect on those declines is untested live; what the run does show is that level-2 declines
   of verified patches are **not only** a no-engine-run effect: 4 of the 13 patches were declined at level 2 after the
   engine had executed the suite (grades 4; inventory 7, 9, 12; 0.33–0.43), each with `plan.unverified` items ("Jev
   was unsure … verify it before marking it done") standing in the accepted plan.
2. **One claim per verdict.** Held everywhere: no item was claimed twice (grades step 10+ claimed 1 item where rung 2
   claimed 2; inventory 14+ claimed the two new items and deferred the two unsure ones; calendar_utils 10+ deferred
   `parse_iso`), `rawText.deferred` and the notes are in `steps.jsonl`, the records in `synthState`. The judge's
   `done_<j>` on the 5 executed claiming runs: 4 accepted (0.74–0.83), 5 unsure (0.33–0.67), 0 rejected below 0.3.
   **The unsure ones are the items whose path is the test file**: `fix … in tests/test_grades.py` /
   `tests/test_inventory.py` (4 of 5 unsure; `memory.ts planItemPath` falls back to the test file when a pytest
   traceback shows only test frames), while the `in src/calendar_utils.py` items were accepted 3 of 4. The item text
   is fixed at goal creation, before localisation knows the source file; naming the localised source file would need
   the engine to accept an item rename (plan rule (b) retains the old text) — a lever for a later change, not taken here.
3. **`done` after the green run.** Not reached live: no claiming run executed green in any of the three (the runs that
   would have shown 10/10 were the declined ones), so no `done` was proposed. Unit-tested, including the scrolled window.

### 10.5 What still gets rejected: the claiming `run`

The one residual is unchanged in kind from §9.5(a) and now carries all three `max_steps`: **a post-patch `run` that
claims plan items is declined at `plan_mismatch` 0.30–0.66 with the Score's mass spread over levels 0–4 (Jev confidence
0.00 on every one)**. 22 claiming runs were proposed, 5 executed; the 17 declines cost 17 of the 60 steps, and every
task was solved 7–13 steps before its `max_steps`. The 3 establishing runs (no claim) and the 5 runs that got through
differ from the declined ones in nothing the controller controls: same command, same evidence, `evidence_consistent`
0.60–0.91, `matches_intent` 0.97–0.98 under the overridden `verify` (the 7 `matches_intent` < 0.3 are the runs under
`investigate` at steps 17–20). Level distribution on `grades`' declined runs, rung 2 → this run (mean over the
declines): level 0 0.40 → 0.31, level 2 0.21 → 0.16, **level 3 0.10 → 0.27**, level 4 0.25 → 0.20. The level-3 text is
"ignores the plan's open problems, or claims completion (`done`) while `plan.remaining` is non-empty"; a `run` whose
`planClaim.done` is non-empty while `remaining` still lists the deferred item and the standing verification item reads
partly as that clause. The deferred-claim note (`…; re-verify`) was the obvious suspect for the level-3 rise; §10.6 tests
it. Whatever the wording, the controller has no further lever on this shape: the run must claim (a claim is judged only
on executed output, §5.1 row 2), the claim must sit next to a non-empty `remaining` on any multi-hunk task, and the
mass is a Jev-side calibration of the `plan_mismatch` Score on a claiming `run` (the paired clause in
`loop/stages/risk.ts` — "a test `run` that claims plan items on its own parsed output is not a completion claim" — is the
lever left, outside this change's scope).

### 10.6 Two `grades`-only follow-ups: the note's wording, and the dead-end the deferral opened

`grades` is the §9.5(a) task, so it was re-run alone twice, each time after one code change (both runs are inside the
three-task live set; ≈ $0.01 each).

**`-3-policy-b` (`bench/results/jev-only-ladder-3-policy-b`, run `20260920-212507-b2yszjyr`): the reworded note.** Code
as in §10.2 with the deferred-claim note changed from `…; re-verify` to `…; this test run re-verifies it before it is
claimed again`. Steps: 1 establishing run 7/10 → 4 patch applied → 5 run declined (pm@3, 0.56, claiming two items, **no
note in the plan yet**) → 6 run 9/10 (both claims unsure, 0.48 / 0.47) → 7 patch → **8 run executed, 10/10, claiming
`boundaries` (accepted 0.95) with the two unsure items deferred under the reworded note** → `task_complete` 0.60 on that
green run (the two deferred items still in the accepted `plan.remaining`) → 9 `done` declined at 0.66 (pm@4) → **10–20
`done` blocked eleven times at 0.96–1.00** (pm@4 "repeats a step `recent` shows already failed": a `done` carries no
`evidence`, so the plain rubric applies and the declined `done` in `recent` reads as a failed step) → `max_steps`,
solved by the evaluator, $0.0096, 39 s. Two readings: (i) the level-3 mass of §10.5 is on the claiming run's shape, not
on the note — step 5 drew 0.44 at level 3 with no note anywhere, and the noted run at step 8 went through (n = 1 each,
Jev confidence 0.00–0.18: no claim about the wording is made beyond "it did not hurt"); (ii) **the deferral had opened a
dead-end**: after the final green run the only proposal left is `done`, whose claims are never graded (`noop`, no
executed output → `applyPlanDraft` rejects them with "no judge evidence"), so a deferred item can never leave
`plan.remaining`, the completion Noul reads it (0.60 here against 0.90 on `textstats` and 0.91 on `units` in rung 2,
whose green runs claimed every fixed item and left `remaining = [verify …]`), and the `done` loops until `max_steps`.
The rule as specified in §9.5 ("re-claim only after a NEW passing run executed by the engine shows it green") has no
vehicle for that re-claim once the green run has happened.

**Fix (`search/proposal.ts splitClaims`, `expectedGreen`)**: a run the synthesizer's own fresh baseline has measured
all-green defers nothing — every claim on it is verifiable from that run's output, which is the evidence the rule was
waiting for. Deferral now applies to intermediate runs only (those that will still show failures, where parsed counts
cannot attribute an item; every unsure verdict live, 0.33–0.69, came on such a run). Tests: the controller story is a
three-goal run (deferral with the note on the 3-of-4 run, both items claimed on the all-green run, `done` after it
claims only the verification item; `test/unit/synth/search/controller.test.ts`), `splitClaims` / `proposeDone` fallback
with a green vs a failing baseline (`proposal.test.ts`).

**`-3-policy-c` (`bench/results/jev-only-ladder-3-policy-c`, run `20260920-213254-odd2sjdz`): the final code.** 1 run
7/10 → 4 patch declined (pm@2, 0.43) → 5 applied → 6 run 9/10 (`unequal_weights` accepted 0.77, `fractional_weights`
unsure 0.69) → 7 patch → 8 read → 9 run declined (pm@0, 0.38) → **10 run executed 10/10 claiming `boundaries` (0.82,
accepted) and `fractional_weights` again (0.47, unsure) → `task_complete` 0.85 → `complete`**. 10 steps, 3 patches
proposed / 2 applied / 1 declined, 1 run declined, 0 `done`s, Jev $0.0052, 30 s. Same task: rung 2 20 steps
`max_steps` (8 runs declined), `-3-policy` 20 `max_steps` (7 declined), `-b` 20 `max_steps` (12 `done`s blocked).

| `grades` | solved | steps | stop | patches proposed / applied / rejected | runs rejected | `done` rejected | Jev $ | wall s |
|---|---|---|---|---|---|---|---|---|
| rung 2 (`-2`) | yes | 20 | max_steps | 3 / 2 / 1 | 8 | 0 | 0.0104 | 54 |
| `-3-policy` (gate + deferral, note `re-verify`) | yes | 20 | max_steps | 3 / 2 / 1 | 7 | 0 | 0.0100 | 56 |
| `-3-policy-b` (reworded note) | yes | 20 | max_steps | 2 / 2 / 0 | 1 | 12 | 0.0096 | 39 |
| `-3-policy-c` (all-green run claims everything) | **yes** | **10** | **complete** | 3 / 2 / 1 | 1 | 0 | **0.0052** | 30 |

What the three-task run of §10.3 would look like under the final code is not measured (the `-c` change came after
it): `inventory` and `calendar_utils` each had their final all-green run declined 4× under the deferral (steps 14–19),
so the change cannot have cost them anything, and each would have claimed its deferred items on that run. `-c` is one
run of one task; the residual of §10.5 (a claiming run declined at 0.30–0.66 with the mass spread) showed up once in it
too (step 9) and remains the lever.

### 10.7 Spend and exact commands

Ladder `-3-policy` $0.0387 + `-b` $0.0096 + `-c` $0.0052 = **$0.054** of the $1 allowed for this re-check; generator
calls 0 on every record. Run ids: `-3-policy` `20260920-211942-ft52wvdz` (grades), `-y7uoxrtt` (inventory),
`-llhgss2k` (calendar_utils); `-b` `20260920-212507-b2yszjyr`; `-c` `20260920-213254-odd2sjdz`.

```
# gates (this change's files; the other owners' in-progress sites.ts / oracle/questions.ts carry their own tsc errors)
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && \
  npx vitest run --project unit test/unit/synth/search/controller.test.ts test/unit/synth/search/proposal.test.ts \
    test/unit/synth/search/proposal-evidence.test.ts test/unit/synth/search/memory.test.ts test/unit/loop

# the three tasks (rung 2 command with --task-id), then grades alone twice
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder \
  --task-id grades,calendar_utils,inventory --conditions jev-only --live --spend-cap 1 --task-spend-cap 0.25 \
  --concurrency 3 --max-steps 20 --max-wall 10m --out bench/results/jev-only-ladder-3-policy
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder \
  --task-id grades --conditions jev-only --live --spend-cap 0.1 --task-spend-cap 0.1 --concurrency 1 --max-steps 20 \
  --max-wall 10m --out bench/results/jev-only-ladder-3-policy-b      # then -c

# analysis (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/{steps,decisions}.jsonl)
python3 /tmp/jo-risk.py bench/results/jev-only-ladder-3-policy
python3 /tmp/jo-table.py bench/results/jev-only-ladder-3-policy ladder
python3 /tmp/jo-steps.py bench/results/jev-only-ladder-3-policy
```

## 11. 2026-09-20 (later): insertion sites — gaps at every statement boundary, legal indents, the Q6 fallback, function-weighted anchors; `shunting_yard` and `reverse_linked_list` gold-identical, `depth_first_search` gold-identical after the anchor fix

Follow-up to §1's `reverse_linked_list` (engine_rejected / later a search miss: 0 plausible in 1,166 WIDENED runs) and
§8's `shunting_yard` ("exhausted at 7 sites" after sieving 2,448 candidates). Both gold fixes are insertions
(`prevnode = node` inside the loop body; `opstack.append(token)` after the inner `while`, one level out of its body).
Diagnosed on the checked-in programs and the run directories `20260920-205025-4hbeexhd` (shunting_yard, §8 run b) and
`20260920-204758-oemdlhis` (reverse_linked_list); changes in `src/synth/localize/sites.ts`, `src/synth/search/sites.ts`,
`src/synth/templates/{common,statements}.ts`; live re-check `bench/results/jev-only-quixbugs-3-insert` (4 programs) and
`-3-insert-dfs` (depth_first_search again after the anchor fix).

### 11.1 Diagnosis (what the run directories show)

- **The template pools were never the problem.** At the four gold gaps built by hand (line, indent) the statement family
  holds the gold in every case, in pools of 47–80 candidates (`nodesvisited.add(node)` rank 15 of 50, `prevnode = node`
  23 of 47, `opstack.append(token)` 3 of 80, `lines.append(text)` 18 of 56; measured with the template source on the
  buggy programs). `test/unit/synth/templates/quixbugs.test.ts` already asserted this. The misses were sites.
- **shunting_yard: the gap existed at the wrong indent.** The SEEDS list of run b (`shunting_yard.py:17 (gap)`,
  `:16 (gap)`, `:15 (gap)`, `:16`, +3) built the anchor gaps with `indentAfter` = "one level deeper after a header, else
  the same": the gap after L17 (`rpntokens.append(opstack.pop())`, indent 16, the only statement of the inner `while`)
  was built at indent 16 — inside the loop body — where `opstack.append(token)` is wrong; the fix sits at indent 12, the
  `else:` body, one level out. The gap before `else:` (L15) was built at the clause's own indent 8, where every
  statement is a SyntaxError (an `if` body cannot be followed by a statement at the clause indent). The replace site at
  L17 does emit `current\n<stmt at the dedent level>` (`insert_append_after_dedent`), but (a) at the enumeration cap of
  254 it is cut (the unit test needed cap 400), and (b) the sieve queue keys a job by `(path, line, kind, code tokens)`
  with a whitespace-insensitive canonical text (`src/synth/sieve/queue.ts` `canonicalText`), so the `_after` form
  (indent 16) and the `_after_dedent` form (indent 12) of the same statement at the same replace site are ONE job there
  and the first enqueued (the higher-prior `_after`) is the one that runs. The RANK phase of step 5 did list
  `        opstack.append(token)` (indent 8, inside the `for` body after the `if`/`else`) and Jev put 0.46 on it — the
  right statement at yet another wrong level.
- **reverse_linked_list: the gap did not exist.** The gold gap (before L6, indent 8, between two statements of the loop
  body) is adjacent to no anchor of that run; WIDENED enumerates replace sites only, so 1,051 runs over 19 sites never
  held an insertion at that position; `prevnode = node` appears nowhere in the run's decisions or steps.
- **depth_first_search (found in the live re-check, §11.4): the anchors went to `node.py`.** The workspace ships `node.py`;
  the localizer's function beam includes `Node.__init__` and the `Node.successor` property, and Q5 on those functions
  answers with confidence (`return self.successor` at p 0.99, `def __init__` 0.87) although Q2 gave `node.py` 0.1 and
  `depth_first_search` 0.93. §2.5 orders anchors by p alone, so the top-3 anchors and all six anchor gaps of the 6-cut were
  `node.py`'s; the gap after `else:` (before L10 at indent 12) never entered SEEDS, and the guard committed the §1 overfit
  (`unwrap_call` at L11, 6 plausibles, `genuine_fix` none_of_these 0.94).

### 11.2 What changed

1. **Legal gap indents from the structure** (`localize/sites.ts` `gapIndentsAfter`, `indentAfter`, `indentBefore`).
   After a compound header: the body indent only. Otherwise every block open at that point — the statement's own indent
   and each enclosing compound statement's indent down to the function body — minus what the NEXT statement forbids:
   nothing shallower than it, nothing at or above a clause header (`else`/`elif`/`except`/`finally`), and never the same
   indent after `return`/`raise`/`break`/`continue` (dead code). Order: the enclosing block first where a block ends (both
   measured block-end insertions, `shunting_yard` and `wrap`, sit one level out), then the statement's own block, then the
   further levels. `indentAfter` (the anchors' after-gap) now returns the first legal indent — `shunting_yard` L17 → 12,
   `wrap` L8 → 4 — and `indentBefore` fixes the before-gap of a clause header (before `else:` → the `if` body's indent).
2. **Gap slots at every statement boundary** (`functionGapSlots`; `search/sites.ts` `functionGapSites`, `orderGapSlots`,
   `GAP_FUNCTION_MAX_LINES = 40`). One slot per physical line: the k-th legal indent of the gap after a statement goes to
   the k-th physical line between it and the next statement (a blank line gives a block-end gap a second slot for a second
   level); indents with no line of their own are dropped — with the queue's `(line, kind, tokens)` key two indentations of
   one statement at one line would be one job anyway (the replace-site `_after` / `_before` forms cover the same-indent
   and the next statement's own level). Slots are ranked by the Jev probability of the lines around the gap (Q5 / Q5n),
   then by control-flow position (after a header, block end, mid-block), then by line. In `buildGoalSites` the top beam
   function's slots follow the anchors' own gaps into the insert list (the 6-cut keeps the anchors' first, design §2.5
   item 2 as written); in WIDENED (`widenedSites`) every slot of each beam function of ≤ 40 lines is interleaved in line
   order with the replace sites (the gap before a line ahead of the line) — the controller's chunking and Q7 insert-first
   rule apply unchanged. Measured slots: depth_first_search 7, reverse_linked_list 6, shunting_yard 14, wrap 9; the
   template pools over all slots total 345 / 213 / 945 / 529 candidates. The gold slot is present for all four
   (`10@12`, `6@8`, `18@12`, `9@4` — wrap's gold sits after the blank L9; before it is the same program).
3. **Statement templates** (`templates/common.ts`, `statements.ts`): a `.pop()` receiver is a list unless the code treats
   it as a set or dict; list / set / dict literals of any length type their name (`precedence = {` … `}` is a dict, so
   `opstack.append(precedence)` ranks below `opstack.append(token)`: collection-typed elements take prior × 0.8, they stay
   in the pool). The catalogue (`x.append(y)`, `x.add(y)`, `x.extend(y)`, `x = y`, `x = None`, `x, y = y, x`, `return x`,
   `x += 1` / `-= 1`, `r.attr = …`, `else: return …`) was already complete for the four golds.
4. **Q6 fallback** (`buildGoalSites`, `q6FallbackApplies`, `topStatementTemplates`; design §9 R1 "otherwise"). When the
   goal's sites are rebuilt after a search that reached WIDENED without a plausible candidate (`goal.phase === 'WIDENED'`
   on an unfixed goal — the `change_approach` directive clears the localisation cache), the top-5 statement templates of
   the top function (by prior, the `statement` family enumerated over its slots) each get one Q6 `insert_after` Choice
   (the measured wording, top-1 4/4 given the statement); the top-1 gap of each (plus others at p ≥ 0.2, ≤ 3) becomes an
   insert site carrying the statement and Jev's p in its evidence, spliced in front of every other site, ordered by p
   across statements, and `insertFirst` is set. Five requests, ≈ $0.0005.
5. **Function-weighted anchors on repositories** (`functionWeight`, `q5Anchors`): on a workspace with more than one
   Python file each beam function had its own line Choice, so a line's Q5 p is conditional on its function; anchors and
   the replace order now use p × `FunctionCandidate.probability` (the localizer's file × function path score). The
   single-file flat path asks one Choice over the whole file (p already joint): weight 1. `jevProbability` in the evidence
   stays the raw Q5 value. Effect on depth_first_search: anchors `L11` 0.36, `L9` 0.10, `L7` 0.08 ahead of `node.py`
   L4 0.014 / L8 0.002; the six anchor gaps are the target function's, the gold gap `10@12` among them.

Tests (`test/unit/synth/localize/sites.test.ts`, `test/unit/synth/search/sites.test.ts`,
`test/unit/synth/templates/{families,quixbugs}.test.ts`): `gapIndentsAfter` on a header / block end (`[12, 16, 8, 4]`
after `shunting_yard`'s L17 shape, dedents `[1, 0, 2, 3]`) / before a clause / after a terminal statement; `indentAfter`
after `return lo` one level out, after a trailing `return` the statement's own indent; `functionGapSlots` one slot per
line, no dead slot, the docstring rule; for each of the four programs the gold gap is a slot with the gold indent and the
template pool at that site holds the gold statement (`opstack.append(token)` at the gap after L17 inside the `else:`
branch at indent 12, `prevnode = node` at the loop-body gap L6 at indent 8, `nodesvisited.add(node)` at L10 at 12,
`lines.append(text)` at L9 at 4), pools < 120; `orderGapSlots` order; `topStatementTemplates` top-5 contains the gold
for all four; WIDENED interleaving and the ≤ 40-line rule; the Q6 fallback (5 requests, the 0.83 placement first,
`insertFirst`, the placements recorded, none on a fresh goal); `.pop` → list unless set/dict; weighted anchors on a
depth_first_search + node.py fixture (unweighted `node.py:8` leads, weighted `depth_first_search.py:11`; the gap
`10@12` in the cut, visiting order `11r 13i 11i 9r 10i 9i`). `test/unit/synth/search/subgoal.test.ts` (the controller's
test of the WIDENED walk over the gcd fixture) pins `widenedSites`' output and was updated for the three gcd gap slots
(`[5, 6, 2, 2, 3, 3, 4, 5]`, cursor 6, 12 batches, 13 tested, template 6). Gates: `tsc --noEmit` clean for the
synthesizer (concurrent, unrelated edits in `src/synth/oracle/` fail typing at the time of writing), `no-any` ok, unit
1,879/1,880 (the one failure is `test/unit/loop/risk.test.ts`, the loop module's concurrent change).

### 11.3 What the queue's key costs, and what would unlock it

`src/synth/sieve/queue.ts` dedupes on `(base, path:line:kind, canonical text)` and the canonical text is the code tokens
joined by spaces — indentation is not part of it. Two candidates that differ only in indentation at one insert line (or
the `_after` and `_after_dedent` forms at one replace line) are therefore one job, and the first enqueued runs. Item 2
above works around this with one indent per physical line, so a block end whose dedent levels outnumber the lines up to
the next statement loses the deeper levels at insert sites (`shunting_yard` after L17: levels 12 and 16 get L18 and L19;
8 is reachable only as the replace-site `_after_dedent` form at L17, which the queue folds into `_after`; 4 as the
`_before` form at L19). Keying the canonical text per physical line with its indent width (one line in `canonicalText`)
would let every legal level run; outside this change's scope (`queue.ts` is not the synthesizer's site modules).

### 11.4 Live re-checks

Same flags as §1 with `--spend-cap 1`, `--concurrency 2`, generator calls 0 on every record. "sites" is the SEEDS site
count of the committing search (`sitesConsidered`); gold-identical = the patch applied to the buggy program equals
`bench/data/quixbugs/correct/` with blank lines ignored (§1's criterion; `/tmp/qb-insert-table.py`).

**Run A** (items 1–4; `bench/results/jev-only-quixbugs-3-insert`): **repaired 4/4, gold-identical 2/4**, Jev $0.0135,
wall total 324 s, 3,612 candidates run.

| program | repaired | gold-identical | steps | sites | candidates enumerated / run | commit | winning site (source/op) | Q6 fallback | wall s | Jev $ | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shunting_yard | yes | **yes** | 4 | 10 | 997 / 967 | step 3 (SEEDS, SIEVE, 3 plausible) | `shunting_yard.py:18` gap at indent 12 (`mutation/statement_template`; the template source's `insert_append` is the same job) | – | 75 | 0.0021 | complete |
| reverse_linked_list | yes | **yes** | 9 | 34 → 11 | 961 / 884 | step 7 (SEEDS, SIEVE, 1 plausible) | `reverse_linked_list.py:6` gap at indent 8 (`template/insert_assign`) | 5 requests at step 7 | 121 | 0.0069 | complete |
| depth_first_search | yes | no | 4 | 12 | 1039 / 983 | step 3 (SEEDS, SIEVE, 6 plausible) | `depth_first_search.py:11` (`mutation/unwrap_call`, the §1 overfit) | – | 73 | 0.0019 | complete |
| wrap | yes | no | 6 | 10 | 783 / 778 | step 4 (SEEDS, SIEVE, 1 plausible) | `wrap.py:7` gap (`donor/statement_donor`: a second wrapping loop, the §1 overfit) | – | 55 | 0.0026 | complete |

Per program. `shunting_yard` — the anchor gap after L17 is now built at indent 12; SEEDS sieved 967 candidates over 10
sites and found 3 plausibles at that gap, the gold among them and committed at step 3 (§8: parked after 2,448 runs).
`reverse_linked_list` — step 4 SEEDS → WIDENED over 34 sites (the beam's `node.py` functions included, each with its
lines and slots) ran out of the 90 s test wall at 841 runs before the `reverse_linked_list` slots were reached (run median
230–870 ms under two concurrent tasks); step 6's `change_approach` rebuilt the sites with `goal.phase = WIDENED`, the Q6
fallback asked five statements (Jev's top gap `after_l6` 0.48 / `after_l6` 0.38 / … with the escape at 0.24–0.59),
insert sites went first, and SEEDS at step 7 sieved the loop-body gap L6 at indent 8 (a slot, in the widened beam of 10):
`prevnode = node` plausible in 44 runs, committed, green baseline at step 8 (§1: rejected three times; §8 note: 0
plausible in 1,166 WIDENED runs). `depth_first_search` — §11.1's `node.py` anchors; fixed by item 5, run B. `wrap` — Q5
L7 0.67, L4 0.12, L3 0.07, Q5n L7 0.64, L4 0.34; the anchors' five gaps and the best slot (`6@12`, after the `if end ==
-1:` header) fill the 6-cut, the gold slot `9@4` ranks seventh; the donor source at the gap before L7 (indent 8) inserts
the whole `while` loop again, which passes all five tests, and a lone plausible is committed without arbitration — the
design's measured `wrap` overfit (§1), for which §2.6's behaviour probe (`perturbedInputs`) is the remedy, not the sites.

**Run B** (items 1–5, `depth_first_search` alone; `bench/results/jev-only-quixbugs-3-insert-dfs`): **repaired 1/1,
gold-identical 1/1**, Jev $0.0018, wall 25 s. SEEDS over 12 sites (the target function's anchors L11, L9, L7 and their
six gaps), 559 candidates run, the sixth batch (the gap before L10 at indent 12) gave 2 plausibles —
`nodesvisited.add(node)` and `nodesvisited.add(startnode)` — Jev's `genuine_fix` 0.90 on the gold (`general_cand` Nouls
0.40 / 0.07), committed at step 3, green baseline at step 4.

**With the final code: repaired 4/4, gold-identical 3/4** (`shunting_yard`, `reverse_linked_list`, `depth_first_search`;
`wrap` repaired by the overfit). Live spend for §11: $0.0135 + $0.0018 = **$0.0153** (generator $0 / 0 calls).

### 11.5 What remains

- `wrap`: a lone plausible commits at once; the overfit is a donor block at a gap the anchors rank above the gold slot.
  The behaviour probe of §2.6 before a single-passer commit, or per-test coverage clustering (§6 item 3), is the lever.
- WIDENED under load spends its step on the beam's other functions' lines and slots before the target function's slots
  when the target's replace lines come first in the chunk order (reverse_linked_list step 4: 34 sites, 841 runs, wall
  out). Weighting the beam order by function probability already puts the target first; capping the non-top functions'
  slots, or the per-step wall, would let one step finish the top function.
- The queue key (§11.3) — one line in `queue.ts` would let every legal dedent level run at insert sites.
- `sitesConsidered` counts SEEDS plus every widened site; a per-kind count (replace / gap) in the trace would make the
  gap coverage auditable per step.

### 11.6 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth/templates test/unit/synth/search/sites.test.ts test/unit/synth/localize

# run A (items 1–4) and run B (items 1–5, depth_first_search alone)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id shunting_yard,reverse_linked_list,depth_first_search,wrap --conditions jev-only --live --spend-cap 1 \
  --task-spend-cap 0.1 --concurrency 2 --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-3-insert
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id depth_first_search --conditions jev-only --live --spend-cap 1 --task-spend-cap 0.1 --concurrency 1 \
  --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-3-insert-dfs

# the tables (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/{transcript.log,steps.jsonl,decisions.jsonl,model_patch.diff}; git apply for the gold check)
python3 /tmp/qb-insert-table.py bench/results/jev-only-quixbugs-3-insert shunting_yard,reverse_linked_list,depth_first_search,wrap
python3 /tmp/qb-insert-table.py bench/results/jev-only-quixbugs-3-insert-dfs depth_first_search
```
Run ids: run A `20260920-212633-dqk74stb` (shunting_yard), `20260920-212633-5yahrgk6` (reverse_linked_list),
`20260920-212748-f23lksyv` (depth_first_search), `20260920-212834-qbmrammd` (wrap); run B `20260920-213544-v7jdp7tl`.

## 12. 2026-09-20 (later): the per-case timeout reads the tail, a `timeout` is provisional until the retry, the lanes see the load — skew set 5/5, `longest_common_subsequence` back

Follow-up to `jev-only-quixbugs-3-inspection.md` §2 (the `longest_common_subsequence` miss in run 3: verifier false
negative) and to §8 above, which introduced the rule that caused it. The facts, restated: §8's per-case limit was
clamp(3 × mean finished-case time, 500, 2000) with the one-alarm stop rule; LCS's slowest case is ~40× its mean
(184 ms buggy / 94 ms gold idle against ≤ 14 ms for the other nine; 330–350 ms buggy and 80 ms gold measured today at a
load average of 45), so 3 × mean ≈ 60 ms fell to the floor and the 500 ms floor became the cap; under run 3's 4–9× CPU
contention the gold's case 3 crossed it, the run was classified `timeout`, the hash went into `tried` for good and the
sieve then spent the 90 s test wall on timeouts. Two defects, both in the verifier: the cap was skew-blind, and a verdict
that only the cap could explain was final.

### 12.1 What changed (src/synth/search/budget.ts, src/synth/sieve/runner.ts, src/synth/sieve/queue.ts doc)

1. **The cap is fitted to the tail, not the mean** (`caseTail`, `CaseProfile.tailMs`, `perTestTimeout`).
   `perTestTimeoutMs = clamp(3 × tail, 500, 2000)` where the tail is the maximum of the finished cases' times when there
   are ≤ 20 of them (every case must fit; 20 samples give no percentile worth the name) and the p95 (nearest rank) above
   (one pathological case of a large suite does not set the cap for all). Per-case times come from pytest's
   `--durations` table when the output has one (`pytestCaseDurations`, the `call` rows; `-q` hides rows under 5 ms,
   which cannot move a maximum) or from the caller (`FitOracleOptions.caseDurationsMs`, which replaces `perTestP50Ms`).
   Without either — the bench's `pytest -q` baseline, run_tests.py's JSON — the tail is *bounded* by the finished cases'
   total (every finished millisecond could be one case): honest about what is known, and it costs only hanging
   candidates, which pay the cap once under the stop rule. Timed-out cases still never vote. On the live baselines:
   LCS 570 ms (was 500), knapsack/lcs_length/kth 500 (uniform, quick), levenshtein 500 (one 2 s alarm, the rest quick);
   the synthetic `mixed` fixture of §8 (six finished cases sharing 1.8 s, no per-case times) moves from 900 ms to the
   2 s cap and its t_run from 2.9 s to 4.0 s (repository-class either way).
2. **A `timeout` verdict is provisional unless the candidate is a genuine hang** (`timeoutKind`, runner.ts). Final
   ('hang') when: the sandbox killed the run (its timeout is far above any per-case cap); or every alarmed case is one
   the *baseline* alarmed on too and either the run was already at the 2 s cap (a retry could add nothing) or no case
   passed at all (no improvement over the baseline anywhere: bitcount's 203 hanging candidates of §8.2 alarm on the
   first case); or — sequential pytest only — the alarm fired on the very first case and the baseline finished that case
   quickly (its own time from the durations table, else the tail bound, × 3 × the observed load fits under the cap).
   Everything else — the run passed cases and then a case did not return under a cap fitted idle, with no case failing
   on a value — is provisional: the candidate goes to `mem.retryTimeouts` (per goal) instead of `tried`; at the end of
   the batch up to 16 (`RETRY_TIMEOUTS_MAX_PER_BATCH`) are re-run at the runners' full 2 s cap
   (`RETRY_CASE_TIMEOUT_MS`) and only that run classifies them; the rest are retried first at the next call for the
   goal, a re-enumerated copy of a pending candidate is skipped rather than run again, and a pending retry judged
   against a baseline the memory no longer holds (index.ts re-baselines after a commit) is dropped, not `tried`.
   `tried` is written only at the final classification (queue.ts's `tried` doc says so now).
   Two departures from the brief, both measured: (a) the retry **keeps** the stop rule — it asks one question, does
   the alarmed case finish at 2 s, and a genuine hang that reaches it then costs one alarm instead of (cases − passed)
   × 2 s (bitcount 18 s, sqrt 12 s a retry; a candidate that hangs on one case is `timeout` with or without the rule
   and never a base); (b) "the baseline hangs on the same case" alone is not final: `levenshtein`'s *reference*
   solution is exponential and takes 1.02 s on the case the buggy program alarms on at 2 s (measured today), so at a
   500 ms cap the gold alarms exactly where the baseline does — and finishes at the retry's 2 s. Known gap: a fix
   slower than the cap on a case the buggy program hangs on, when that case is the suite's first, is final.
3. **Load awareness** (`loadRatio`, `scaledCaseTimeout`, runner.ts). Once a batch has 4 measured runs
   (`LOAD_SAMPLE_MIN_RUNS`) whose median exceeds 2× (`LOAD_SCALE_MIN_RATIO`) the oracle's t_run estimate, the per-case
   cap of the rest of the batch is the oracle's × the observed ratio (monotone within the batch, bounded by 2 s), and
   the verify event says so: `load ×2.6, case timeout 570→1490 ms`. The oracle's own cap is not rewritten (the next
   batch re-measures); `refineTRun` still learns the median. Every lane run now carries its own settings (cap, stop
   rule), so the QuixBugs runner's `--timeout` and the pytest module's `JEVCODE_CASE_TIMEOUT_MS` /
   `JEVCODE_MAX_CASE_TIMEOUTS` follow per run, and the lane's sandbox timeout follows the cap it runs at
   (`laneRunTimeout` at 2 s a case for a retry, bounded as before by the workspace command's timeout).
4. **Found in the live run, fixed after it: the measured goal-subset baseline ran under the lane cap.** With a
   `pytest -q` baseline (no passing ids) the runner measures the goal subset once on a clean lane and caches it per
   base; that run used the adaptive cap and the stop rule. Under 2.6× load LCS's clean lane alarmed on case 3 at 570 ms,
   the reference read 3/10 instead of 6/10 (cases 4–9 "not run"), and every no-op candidate that finished case 3 was
   `improved` → `partial` for the rest of the run (the "17 partial", "28 partial", "30 partial" batches below; run 1
   read them `unchanged`). It did not cost the repair (the gold was `plausible` on its own merits) but it fed the
   guard a hundred false partials. The reference now runs at the module's defaults — 2 s a case, no stop rule — like
   the workspace baseline it stands in for (`REFERENCE` settings in `runQueue`; unit test).

Tests (test/unit/synth/search/budget.test.ts, test/unit/synth/sieve/runner.test.ts): `pytestCaseDurations` on the
real `-q` table shape; `caseTail` (max ≤ 20, p95 at 21 and 100); the skewed baseline (one 184 ms case, nine 10 ms
cases) → 540 ms from the two-decimal table, 552 ms from measured times, against the mean's 500; the tail bound without
per-case times (LCS's live baseline → 1 200 ms idle; bitcount/sqrt unchanged); `loadRatio` / `scaledCaseTimeout`;
`timeoutKind` on every rule (killed run; baseline-alarmed case with nothing passed / at the 2 s cap / with passes at a
lower cap; first-case alarm with and without the durations table, at load 1 and 4; the QuixBugs runner's parallel
cases; mid-run alarms); on the lanes with an LCS-shaped fake module: the gold slow on case 3 → provisional at 500,
retried at 2 000 with the stop rule (subset, then full suite), `plausible`, `tried` only then, t_run learnt from the
first runs only, the retry's lane timeout; genuine hangs classified in one run (first-case alarm at the fitted 1 200 ms
cap, and at 500 ms with a durations table); a mid-run hang retried once and final; load scaling after four 1 150 ms
runs (500→1150, the event text, the gold's slow case fitting its first run under the scaled cap; bounded at 2 s; nothing
below 2×); 18 provisional → 16 retried, 2 pending, skipped when re-enumerated, retried first next call, untouched by
another goal's call, dropped on re-baseline; a retry the wall cannot fit stays pending; the reference run at the
module defaults. Gates: `tsc --noEmit` clean, `no-any` ok, the owned files 5/5 test files, 111 tests; test/unit/synth +
test/unit/bench 84 files / 1 290 tests green after the item-4 fix.

### 12.2 Live re-check (`bench/results/jev-only-quixbugs-4-skew`): the five skew-prone programs, concurrency 4

Same flags as §8.2 with `--task-id longest_common_subsequence,knapsack,levenshtein,lcs_length,kth --concurrency 4`
(four tasks starting together on a machine whose load average was 10–14 from other work: the contention is the point).
Code = items 1–3 (item 4 landed after the run). Generator calls 0 on every record. "final `timeout`" counts
`timeout` verdicts in the verify events; "provisional → retried" reads the new event fields.

**Repaired 5/5, all five patches identical to `bench/data/quixbugs/correct/` (whitespace/comment-insensitive), Jev
$0.0139, wall total 143 s.**

| program | repaired | steps | baseline ms | class / lanes at step 1 | run median ms (min–max) | candidates run | final `timeout` | provisional → retried (verdicts) | batches load-scaled / total (max ×, cap →) | commit at step | wall s | Jev $ | stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| longest_common_subsequence | yes | 5 | 656 | QuixBugs / 8 | 256–1135 | 403 | 0 | 12 → 12 (12 partial) | 3/18 (×2.6, 570→1214/1442/1490) | 4 | 52 | 0.0060 | complete |
| knapsack | yes | 4 | 478 | QuixBugs / 8 | 446 | 114 | 0 | 0 | 1/1 (×2.0, 500→1006) | 3 | 15 | 0.0022 | complete |
| levenshtein | yes | 4 | 1646 | QuixBugs / 4 (4→8) | 242 | 115 | 0 | 0 | 0/1 | 3 | 47 | 0.0020 | complete |
| lcs_length | yes | 4 | 482 | QuixBugs / 8 | 434 | 152 | 0 | 0 | 0/1 | 3 | 16 | 0.0018 | complete |
| kth | yes | 4 | 578 | QuixBugs / 8 | 240 | 172 | 0 | 0 | 0/1 | 3 | 13 | 0.0019 | complete |

Patches: `if weight <= j:` (knapsack), `dp[i - 1, j - 1] + 1` (lcs_length), `kth(above, k - num_lessoreq)` (kth),
`return levenshtein(source[1:], target[1:])` (levenshtein), `longest_common_subsequence(a[1:], b[1:])` (LCS).

`longest_common_subsequence` (run `20260920-215703-mstrth7d`), the program the section is about: baseline 6/10 in
656 ms → cap 570 ms (the tail bound: 3 × ~190 ms of finished cases; §8's rule gave 500). Step 3's first batch ran at a
1 135 ms median against a ~450 ms estimate: `load ×2.6, case timeout 570→1490 ms`, 6 provisional timeouts retried at
2 000 ms, all six reclassified (`partial`: the no-op candidates, see item 4); the second batch (849 ms median) retried
6 more, again none final; the fifth batch scaled again (×2.5, →1442). 152 candidates in step 3, 0 `timeout` verdicts,
0 pending at the end of every batch; the step ended `budget` (the 90 s test wall, as in run 3 — but on real runs, not
on alarms). Step 4: 251 candidates over nine batches, one scaled (×2.1, →1214), no provisional verdict; the 102-candidate
batch that lost the gold in run 3 (`timeout` → `tried`) read "100 regressed, 1 partial, 1 plausible" at a 279 ms
median — the gold `plausible` on its first run — commit, 10/10 at step 5, `complete`. Run 1 (idle, fixed 2 s cap):
4 steps, $0.002; run 3 (§8's cap, load): 12 steps, $0.018, miss; here: 5 steps, $0.006, gold-identical.

`levenshtein` (`-qp3jninl`): baseline 1/7 in 1 646 ms (case 2 at the 2 s alarm in the buggy program), fitted 4 lanes
(t_run > 1 s from the alarm) and widened to 8 after the batch measured 242 ms; 115 candidates, 4 plausible, gold
committed at step 3. The reference solution's 1.02 s on case 2 never met the 500 ms cap here because the lanes ran
below 2× load on that batch — the departure (b) above is what would have carried it through a loaded batch.
`knapsack` (`-nxacjirf`): one batch of 114 at 446 ms median against a ~220 ms estimate → ×2.0, 500→1006 ms; 3
plausible, gold committed at step 3 (§1 and §8 never lost knapsack; the scaling is the observation). `lcs_length`,
`kth`: one SIEVE batch each, one plausible, gold at step 3 — the control programs, unchanged.

### 12.3 What remains

- Item 4 (the reference run) is fixed but not re-measured live; the run above repaired LCS with the poisoned
  reference, so the fix should only remove the false `partial`s (and the guard's work on them). Worth one re-run of
  LCS at concurrency 4.
- The tail bound without per-case times is loose on uniform suites (mergesort's 14 quick cases would fit a 1 170 ms cap
  where 500 ms would do); it costs only hanging candidates, but the honest number is one `--durations=0` away — on the
  baseline command (index.ts) or on the first lane batch (runner.ts), either of which would also make rule 3 exact.
- Rule 2's known gap (a slow fix on a baseline-alarmed *first* case) has no QuixBugs instance in the 40; on a suite
  where it does, `passed === 0` would need the load-aware quickness test rule 3 uses.
- `RETRY_TIMEOUTS_MAX_PER_BATCH = 16` was never the binding constraint here (12 provisional over 18 batches); a
  hang-dominated suite with many partially-hanging candidates (bitcount) is where it would bind, at 2.5 s a retry.

### 12.4 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth/search/budget.test.ts test/unit/synth/sieve

# per-case timings (workspaces built from src/bench/quixbugs/pytest.ts generatePytestModule + the JSON cases; buggy and correct programs)
PYTHONDONTWRITEBYTECODE=1 ~/.jevcode/runs/ladder-venv/bin/python -m pytest -q --durations=0     # in each /tmp/qb-*/

# the live re-check
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id longest_common_subsequence,knapsack,levenshtein,lcs_length,kth --conditions jev-only --live --spend-cap 1 \
  --task-spend-cap 0.1 --concurrency 4 --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-4-skew

# the table (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/transcript.log; the gold check applies model_patch.diff to programs/<name>.py)
python3 /tmp/qb-skew-table.py bench/results/jev-only-quixbugs-4-skew
```
Run ids: `20260920-215703-mstrth7d` (longest_common_subsequence), `-nxacjirf` (knapsack), `-qp3jninl` (levenshtein),
`-e43gigil` (lcs_length), `20260920-215719-4wkivpep` (kth). Live spend for §12: **$0.0139** (generator $0 / 0 calls).

## 13. 2026-09-20 (later): the two run-3 overfits — the first lone passer of a step committed while the gold's site was unvisited; within-step holds, structural signals, test-derived perturbations

Follow-up to `jev-only-quixbugs-3-inspection.md` §1 (`detect_cycle` and `wrap` pass their visible tests with patches
that are wrong on inputs the tests do not build). Facts from `bench/results/jev-only-quixbugs-3/tasks.jsonl` → run
dirs `20260920-205926-gcmw4rn7` (detect_cycle) and `20260920-210830-qg4kfmo3` (wrap), their `steps.jsonl`,
`decisions.jsonl` and `synthState.tried` (174 and 724 sha12 diff hashes, in completion order), matched against a
re-enumeration of every seed source (mutation, template, donor) at every replace line and every gap slot of the BUGGY
programs (`.scratch/reconstruct.mts`; 153/174 and 586/724 hashes matched — the rest are literal-dependent variants —
enough to read the site order batch by batch). Code = `src/synth/search/{guard,bases,perturb}.ts` and their tests;
`subgoal.ts` untouched (one recommendation in §13.4).

### 13.1 What happened in run 3, per program

**Both golds were enumerated, at the right site, by more than one source; neither site was ever visited, because the
first lone passer of the step was committed (design §2.6 "1 plausible → commit") while the site list still had the
gold's site ahead.** Neither is a `tried`, cap, vocabulary or ordering-within-a-batch miss.

| | detect_cycle (`-gcmw4rn7`) | wrap (`-qg4kfmo3`) |
|---|---|---|
| gold | replace L5 `if hare is None or hare.successor is None:` | insert before L10 (indent 4) `lines.append(text)` |
| gold enumerated at its site by | mutation `condition_extension` (index 25 of 58 under the 254 cap), template `cond_or_first` | mutation `statement_template` (8/140), template `insert_append` (18/59), donor `statement_donor` (42/87) |
| gold's diff hash in `tried` | no (`09e612bad5b0`) | no (`46da28278c59`) |
| sites | 11 (Q5: L9 0.81, L5 0.13; `where` put 0.55 on `Node.successor` in node.py, Q5 on the `Node` class answered none_of_these 0.96 → insert sites first) | 9 (Q5: L7 0.67, L4 0.08, L3 0.07; line Nouls L7 0.61, L4 0.36, L6/L10 0.21) |
| batches run, in `tried` order | node.py:12:insert (mutation 20, template 2, donor 3), node.py:11:insert (20, 39, 2), detect_cycle.py:10:insert = the gap after `hare = hare.successor.successor` (mutation 48: 44 regressed; template 21; **donor 19: 1 plausible → commit at run 174**) | step 3: wrap.py:7 replace (mutation, template, donor…), 7:insert, 8:insert, 6:replace … 667 runs, RANK cut at the 90 s wall, 0 plausible → `budget`; step 5 (`change_approach`: sources rotated, donor first): **wrap.py:7:insert donor 58: 1 plausible → commit at run 59** |
| the committed passer | `donor/statement_donor`: lines 5–6 copied with `hare`→`tortoise` under L9 | `donor/statement_donor`: the loop header + body copied under `end = cols` with `line`→`wrap` |
| sites never reached | L9 replace, **L5 replace**, and 6 more | L3, L4 replaces, **the gap before L10**, and more |

`decide` runs once per (site, source) batch (`subgoal.ts runBatch` → `visitSource`), and `runQueue` returns the whole
batch, so within a batch the design's rule held; across sources and sites it did not: the sieve's ranking by tests
is only as good as the set the step has run, and a lone passer from site 3 of 11 ends the step. Localisation put the
gold's site late in both (Jev's L9 0.81 on `hare = hare.successor.successor`, the crash's neighbour; L7 0.67 on wrap's
`line, text = …`), which is not wrong of it — it is why the guard must not trust a lone passer that arrives early.

### 13.2 What changed (src/synth/search/guard.ts, bases.ts, new perturb.ts; tests in test/unit/synth/search/{guard,perturb,helpers}.ts)

1. **Rule (b): code-computed structural signals on a lone passer, Q16 as an advisory, a within-step hold**
   (`suspicionSignals`, `adviseLonePasser`, `decide`). Four signals, each a shape the two overfits had and the golds
   did not: `deletes_statement` (a delete extra edit, or an empty / `pass` replacement); `duplicates_block` (≥ 2 added
   lines of which at least half, ≥ 2, are lines the function already has with identifiers and literals abstracted —
   wrap's copied loop, 6/6; detect_cycle's copied guard, 2/2); `guards_other_variable` (the tests crash dereferencing
   None — `'NoneType' object has no attribute 'successor'` in the failure view — and the added `X is None` / `not X`
   guard names no root variable dereferenced with that attribute on the traceback line, read from the baseline
   output tail: `detect_cycle.py:5: AttributeError` → L5 → `hare`; the candidate guards `tortoise.successor`);
   `dead_guard` (an added guard statement whose subject expression nothing in the function reads: `tortoise.successor`
   is never dereferenced, indexed, iterated or passed). A flagged lone passer gets ONE Q16 `general_cand_01` Noul over
   the one-candidate arbitration state. With one signal it is held when p < 0.3 (`LONE_PASSER_HOLD_MAX_NOUL` =
   OVERRIDE_LOW, the design's "confidently false"); with two or more it is committed at once only when p ≥ 0.7
   (`LONE_PASSER_VOUCH_MIN_NOUL` = OVERRIDE_HIGH, "confidently true") — the first live run had the triple-flagged
   detect_cycle guard answer 0.39 and commit under the single 0.3 bound (§13.3). A held passer is the goal's
   `suspect` (bases.ts `HeldPasser`: phase, signals, Noul); every later `decide` of the goal merges it into that
   batch's passers, so a passer from a later site is arbitrated against it (probe + Q15/Q16 as §2.6); the hold is
   released by the budget reserve (below) and by `commitSuspect` at step end (`possible overfit`), never past the step.
2. **Rule (a): a clean SIEVE lone passer waits for its site batch** (`sieveHoldApplies`, `siteBatchDone`, bases.ts
   `PendingPasser`). On a SIEVE oracle (t_run ≤ `SIEVE_MAX_T_RUN_MS`) in SEEDS/WIDENED, a lone passer whose site still
   has a seed source to run (mutation/template/donor, read from `goal.exhausted`) is held as `pending`; the next
   decision at the same site keeps or ends the hold by the same rule, a decision from another site or from composite
   ends it, a second passer merges into an arbitration, `commitSuspect` drains it at step end as a plain commit. This
   is the guard-side form of "decide sees the whole site batch"; §13.4 says what the controller-side form would be.
3. **Budget reserve on every hold** (`budgetAllowsHold`, `HOLD_RESERVE_WALL_MS` 15 s, `HOLD_RESERVE_RUNS` 16, one
   Jev request). A hold is started or kept only inside the reserve; the decision after the batch that spends the
   reserve releases it (every runner batch ends in a decision, so a hold cannot outlive the step through `visitSource`'s
   run-less exit). `createDecide` passes `mem.stepBudget`. The phase bound I first wrote (release two phases on) was
   dropped: WIDENED, the phase that visits the remaining sites of a single-file workspace, is three phases after SEEDS.
4. **Perturbed inputs derived from the visible tests** (new `perturb.ts`; the old `perturbedInputs`, probe script and
   command moved there and re-exported). Strings: first word alone (a text that fits), a trailing word, the empty
   string, the last word dropped. JSON cases read from `tests/<name>.json` through `ctx.workspace.read` (the failure
   views cut the 945-character paragraph at VALUE_BOUND, so `wrap("…", 50)` never parsed back). Linked lists read
   from the failing pytest module: `name = Node(v, prev)` chains, the link attribute from `x.successor = y` between
   constructed names (else `Node.__init__`'s parameter at the link position), the class's module from the corpus,
   the chain lengths of the names passed to the function (1, 2, 5) ±1..3 clipped to 1..12, each acyclic and with the
   tail linked to the head (16 inputs). These travel as Python expressions (`__jev_chain(__jev_class("node", "Node"),
   "successor", 4, None)`) the probe evaluates in the candidate module's namespace. A kind-diversity pass in the
   round-robin keeps five cases sharing one paragraph from spending the 16 slots on five first-word variants.
   `MAX_PERTURBED_INPUTS` stays 16.
5. **The probe runs on the sieve's lanes** (`createLaneProbe`, wired in `createDecide` when the oracle is QuixBugs
   and `mem.lanes` exists — until now `decideForSearch` had no probe, so ≥ 2 passers always clustered on the P2P
   vector alone, one cluster on QuixBugs). Each plausible candidate is written into a free lane (base files first, as
   the runner does), `<program>.py` imported from there with the lane on `sys.path`, per-input SIGALRM at
   min(perTestTimeoutMs, 2 s); a process without a protocol line leaves the candidate on its P2P vector. The program
   name comes from the test module (`tests/detect_cycle_test.py` → `detect_cycle`, `tests/test_wrap.py` → `wrap`),
   verified against the workspace files. Test sources are read once per goal.
6. **`SUSPECT_ESCAPE_MIN` 0.9 → 0.8.** The wrap arbitration of the first live run (two behaviourally identical
   duplicated-loop passers) answered escape 0.89, Nouls 0.06/0.05 — the all-overfit signature by everything but one
   wire tick of the bound set on the single measured set (0.90/0.06); every measured gold-containing set had escape
   ≤ 0.38, so 0.8 keeps a margin on both sides.
7. Transcript notes (`synth guard:` events) for every hold, release, advisory and arbitration (probe inputs and
   signature counts, escape, max general).

Unit tests: the exact run-3 patches rebuilt as candidates (`helpers.ts detectCycleOverfit / wrapOverfit`, verified
byte-identical to the committed diffs), the signals on them and on the golds, the Q16 request shape, the two hold
rules through `decide` with scripted Jev (hold → passer-less batch → gold arrives → 2 clusters → Q15 picks the gold;
one-signal vs multi-signal bounds; RANK and thin-budget bypasses; site-batch completion; step-end drains), and the
real-python probe: detect_cycle's gold answers all 16 linked lists (`False`/`True`) while the committed guard raises
`AttributeError` on the acyclic lists of length 4, 6, 8; wrap's gold keeps the remainder (`['The']` on the first
word) while the duplicated loop returns `[]`. `npx vitest run --project unit test/unit/synth/search
test/unit/synth/mutate test/unit/synth/sieve`: 23 files, 467 tests; `tsc --noEmit` and `no-any` clean.

### 13.3 Live: three runs of `detect_cycle`, `wrap`, `depth_first_search` (concurrency 2, `--max-steps 12`, `--max-wall 6m`)

Same flags as §8.2 with `--task-id detect_cycle,wrap,depth_first_search --concurrency 2`, three code states in a row
(each run diagnosed the next change): **a** `bench/results/jev-only-quixbugs-4-overfit` (items 1–5 and 7 with the
single 0.3 bound and the 0.9 escape bound; the probe gated on `oracle.runner === 'quixbugs'`), **b** `-4-overfit-b`
(the two-level bound, escape 0.8, the phase release dropped), **c** `-4-overfit-c` (the probe gated on the layout).
Generator calls 0 on every record. "correct" = the patched program agrees with `correct/<name>.py` on a differential
harness (detect_cycle: 48 linked lists, lengths 1–12, acyclic and cycles to head / middle / self; the run-3 patch
raises `AttributeError` on 5 of them), "gold-identical" = whitespace/comment-insensitive equality with the reference.

| program | run 3 (§1 of the inspection) | a | b | c |
|---|---|---|---|---|
| detect_cycle | overfit (`if tortoise.successor is None: return False` under L9), step 3, 174 runs, $0.0016 | guard: `duplicates_block, guards_other_variable, dead_guard`, Q16 **0.39 ≥ 0.3 → kept**, the same overfit committed at run 89, $0.0018 | Q16 0.39 < 0.7 → **held**; search on to L9 replace (48) and the gap before L9 (60: 4 passers); arbitrated 5 (1 held), **1 cluster (no probe)**, escape 0.02, max general 0.75, Choice 0.92 → `if hare.successor.successor is None: return False` before L9 — **correct 48/48, not gold-identical**; 201 runs, 5 steps, $0.0019 | held (Q16 0.41); arbitrated 5 (1 held) in **3 clusters (probe 16 linked lists, 5/5 signatures)**, escape 0.06, max general 0.70 → `if not hare.successor.successor: return False` before L9 — **correct 48/48, not gold-identical**; 201 runs, 4 steps, $0.0019, 34 s |
| wrap | overfit (the loop copied under `end = cols`), step 5 after 667 + 58 runs, $0.0036 | `duplicates_block`, Q16 0.07 → **held**; a second, behaviourally identical copy (`L4: while len(text) > cols:`) arrived from another site → arbitrated 2 (1 held), 1 cluster (no probe), **escape 0.89, Nouls 0.06/0.05 → one wire tick under the 0.9 bound → committed** the argmax (overfit); 1043 runs, $0.0023 | held (0.06); two arbitrations of two identical copies each: escape 0.90 / 0.88, max general 0.05 / 0.07 → **all-overfit signature, held twice**; released at the budget reserve after 1485 runs, committed as `possible overfit`; **the gap before `return lines` was not among the 10 sites** (replace L3–L8 and the gaps at indents 8/12 around them, read from `tried`); 7 steps, `replan_stop`, $0.0031 | same course with the probe live (16 case perturbations, 2/2 signatures, correctly 1 cluster: the two copies behave alike); escape 0.91 / 0.88; committed at the reserve as `possible overfit` with `openProblems: "possible overfit: statement_donor at wrap.py:5 passes every test, but Jev rated no test-passing candidate a general fix; review the change"` (judge `succeeded` 0.18 on the patch step, 0.89 on the green run); **still the overfit**, now flagged; 1485 runs, 8 steps, `replan_stop`, $0.0037, 66 s |
| depth_first_search | miss (`max_steps`, 12 steps, $0.0131, the all-overfit set of §2.6) | **gold-identical** `nodesvisited.add(node)`: 561 runs, 2 passers arbitrated (P2P, 1 cluster), 4 steps, $0.0018 | gold-identical, $0.0018 | gold-identical, $0.0018 (probe 0 inputs: the graph tests build `Node(..., successors=[...])`, no chains) |
| Jev spend (run) | – | $0.0059 | $0.0069 | $0.0073 |

Live spend for §13: **$0.0201** (generator $0 / 0 calls). Run ids: a `20260920-220904-4ygo5bjz` (detect_cycle),
`-6w3m3flp` (wrap), `20260920-220923-bhrcc7xe` (dfs); b `20260920-221404-23se3qse`, `-yh3r2kwu`,
`20260920-221439-kjpn4v6k`; c `20260920-221929-orujdof2`, `-olduhhax`, `20260920-222004-dzqva6ip`.

**Per program.** `detect_cycle`: repaired (correct by behaviour on every linked list tried; the run-3 patch crashed on
acyclic lengths 4, 6, 8, 10, 12), not gold-identical — the pick is a guard before L9 rather than the L5 condition
because L5 was still never visited (site order 10:insert → 9:replace → 9:insert in all three runs; the L9 guards are
equivalent fixes, so the search stopped rightly there). `wrap`: not repaired — the same duplicated loop, but the guard
now recognises it (structural signal, Q16 0.05–0.07, the all-overfit signature on both arbitrations) and commits it
only at the budget reserve, marked; the gold's site is absent from the localiser's list (§13.4). `depth_first_search`:
repaired, gold-identical, 3/3 (run 3 had missed it).

**What the probe did.** Run c's detect_cycle arbitration is the first live use of behaviour clustering with inputs:
16 linked lists (lengths 1–8, acyclic and cyclic) put the held overfit (raises on acyclic 4, 6, 8), the `return None`
/ `break` guards (return `None` on acyclic even lengths) and the two `return False` guards into three clusters, and
Q15 chose between three representatives instead of five members of one cluster (run b: 1 cluster, Choice 0.92 on
one of the two correct guards; run c: 3 clusters, 0.06 escape, pick correct). On wrap the probe confirmed what the P2P
vector could not distinguish: the two copies are one behaviour (both drop the remainder on the first-word and empty
inputs), so the one cluster was right and the signature, not the clustering, carried the hold.

### 13.4 What remains

- **`subgoal.ts` (not edited; reported).** (a) The controller-side form of "decide sees the whole site batch": in
  SIEVE mode `visitPhase` could enumerate the three seed sources of a site together, queue them as one batch and call
  `decide` once. The guard-side hold emulates it, but a `visitSource` that finds nothing fresh (all tried) returns
  without a decision, so a pending passer waits for the next site's decision. (b) A `budget` exit returns from
  `searchSubGoal` before the step-end `commitSuspect`; the guard's budget reserve (15 s / 16 runs / 1 request) closes
  the gap in practice — every runner batch ends in a decision — but the honest place is `finish(st, { kind: 'budget' })`
  draining `commitSuspect(mem, goal)` first, and index.ts committing a held passer before `park` → `forgetGoal`
  (today a passer held across a park is dropped, which is why the guard never holds past the step).
- **Localisation of wrap's gold site.** Three runs, three site lists (9–10 sites), never the gap before
  `return lines` (L10, indent 4): Q5 puts 0.64–0.67 on L7 and Nouls 0.16–0.21 on L10, tied with L6, so the anchors are
  L3, L4, L7 (+L6) and their neighbouring gaps at indents 8/12. WIDENED would reach the gap, but 1485 SIEVE runs on
  those sites exhaust the 90 s wall first (the reserve release is where the run ends). The lever is in sites.ts: the
  block-end gap of a function's last loop at the function's own indent (the "after the loop" statement: `wrap`,
  `shunting_yard` §11) as a default insert site, or the Q6 fallback with `lines.append(text)` (the template puts it
  18th of 59 at that gap).
- **Q16 on a lone candidate is not decisive.** The run-3 detect_cycle guard drew 0.39, 0.39, 0.41 across three runs
  (Jev does not read a copied guard as clearly wrong); the code signals carry the hold and the 0.7 vouch bound for
  ≥ 2 signals rests on this one program. A genuine fix with two signals and a middling p is delayed to the step end,
  never withheld: one Q16 request plus the step's remaining runs.
- `SUSPECT_ESCAPE_MIN` 0.8: five all-overfit arbitrations now measured (0.90 dfs, 0.89, 0.90, 0.88, 0.91, 0.88 wrap),
  every gold-containing one ≤ 0.38. The Noul side (max 0.05–0.07) never came near 0.1.
- The probe has no shape for graphs (dfs: 0 inputs); dropping or adding an edge of the `successors` lists the tests
  build is the next derivation. It also runs unbudgeted (§4.3 counts the clustering step as one run; the two runs here
  took ≤ 1 s each on 16 inputs).
- detect_cycle's L5 (the gold's own line) was never reached in four runs; the L9-gap guards are equivalent, so this
  costs gold-identity, not correctness.

### 13.5 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth/search test/unit/synth/mutate test/unit/synth/sieve

# reconstruction of run 3 (which candidates ran, in `tried` order, and where the gold was enumerated)
node node_modules/.bin/tsx .scratch/reconstruct.mts /tmp/ws_dc   /tmp/dc_tried.json   "detect_cycle.py:5:replace:        if hare is None or hare.successor is None:"
node node_modules/.bin/tsx .scratch/reconstruct.mts /tmp/ws_wrap /tmp/wrap_tried.json "wrap.py:10:insert:    lines.append(text)" 50 20 80
#   (/tmp/ws_* hold the BUGGY programs from bench/data/quixbugs/programs; the run workspaces are post-patch and shift the diff contexts)

# runs a, b, c
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id detect_cycle,wrap,depth_first_search --conditions jev-only --live --spend-cap 0.5 --task-spend-cap 0.1 \
  --concurrency 2 --max-steps 12 --max-wall 6m --out bench/results/jev-only-quixbugs-4-overfit      # then -b, -c

# the table (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/transcript.log, applies model_patch.diff to programs/<name>.py)
python3 /tmp/qb-overfit-table.py bench/results/jev-only-quixbugs-4-overfit-c
# the differential check of the detect_cycle picks (48 linked lists vs correct/detect_cycle.py)
python3 /tmp/diff_dc.py
```

## 14. 2026-09-20 (later): ladder round 5 — the loop-side fixes of `jev-only-ladder-4-analysis.md` §4 (verified `done`, verification `run`, refused-proposal signatures)

Follow-up to `experiments/results/jev-only-ladder-4-analysis.md` (round 4: 11/12, 137 steps, 58 proposals refused, $0.137).
Code changed only in `src/loop/{engine.ts,loopdetect.ts,state.ts,stages/risk.ts,stages/intent.ts}`; Jev stays the decider
wherever a judgment is involved, the code rules act only on facts the harness knows (`workspace.testsCurrent`,
`workspace.lastTestRun.allPassed`, the detected test command, the proposal's own `plan.remaining`, the outcome status).

### 14.1 What changed

1. **Fix 1 — a `done` after the engine's own green run** (`stages/risk.ts` `completionVerifiedByRun`, `engine.ts`
   `verifiedCompletion`). When the proposal is `done`, its `plan.remaining` is empty, `testsCurrent` is true and
   `lastTestRun.allPassed` is true, the risk stage does not refuse it: `risk.verdict` becomes `ok`, `risk.reason` reads
   `completion verified by the engine's own passing run <command> at step N; Jev risk answers kept for audit: <Jev reason>`,
   `risk.risk`, `dims` and the Score rows' verdicts keep Jev's answers. The completion Noul (`task_complete`) still decides
   the stop. The *accepted* plan's `remaining` is deliberately not a condition: round 4 showed it non-empty at every green
   `done` (`verify the full test suite passes` stays because the run claims only fix items and a refused `done`'s claim is
   rejected), so it is Jev's bookkeeping, not a harness fact. (a) The plain `plan_mismatch[4]` rubric gained the evidence
   variant's clause "a blocked or declined proposal in `recent` never ran, so it is not a step that failed" and "a `done`
   while `workspace.testsCurrent` is true and `workspace.lastTestRun.allPassed` is true follows a verifying run and is not
   such a claim". (b) `stages/intent.ts`: in jev-only, a `fallback` whose answer is `finish` with p ≥ 0.3 is rescued when
   the engine's last run is green and current (`state.ts commonRunGreen`) — keyed on the green-run fact rather than on
   `ledgerItems()` being empty, because round 4's plan text still listed a stale `fix …` item at units step 13.
2. **Fix 2 — the standing verification `run` is never a review item** (`stages/risk.ts` `isVerificationRun`,
   `AssessOptions.verificationRun`, `RiskStageOptions.testCommand`). For one plain invocation of the detected test command
   or a scoped form of it (`isTestCommand` of the execute stage, minus any shell composition `; & | < > $() {}`) with Jev's
   `destructive` and `irreversible` at expected level ≤ 1, the alignment dimensions are recorded in `dims` and the reason
   (`…; verification run of the workspace test command: out_of_scope 0.09 (dominant level 0), plan_mismatch 0.43 (dominant
   level 0) recorded, not gating`) and do not enter the risk number; `destructive`/`irreversible` still block. **Deviation
   from the analysis' mechanism, measured before implementing:** bounding by the *expected* level instead of the tail would
   not have made a single one of round 4's 22 refused runs `ok` — for every one the expected level was *higher* than the
   tail (calendar_utils 13: tail 0.43, expected 0.50; inventory 17: 0.30 vs 0.38; the subset runs 0.83–0.95 either way),
   because Jev's mass was bimodal (level 0 plus levels 2/4), not concentrated at 0. The stated goal (no review from a test
   run's spread mass, block still possible from harm) is what was implemented.
3. **Fix 3 — loop signatures for refused proposals** (`loopdetect.ts`, `engine.ts`). A blocked or declined `run` is signed
   `run:<sha12(cmd)>:refused` (never the reason text; `done`/`read`/`patch` were already proposal-only); a trip resets only
   the signature(s) that reached 3 in that step (a failing run's `run:` and `fail:` reset together) and a replan only the
   signature it answers; `intent:unresolved` is emitted only when the fallback lands away from Jev's own argmax answer;
   and the §5.5 exit is a code rule (`engine.ts repeatedGatherContextExit`): when Jev directs `gather_context` a second
   time for the same refused `done:` signature, the directive is treated as `stop_and_report` → `replan_stop`.

Tests (`test/unit/loop`): `risk.test.ts` (spread-mass run ok / harm still gates / `isVerificationRun` / the verified-done
override / the rubric clauses), `loopdetect.test.ts` (declined-then-blocked = one signature, trips at 3; a `done` count of
2 survives an interleaved `read` trip and its replan; co-tripped signatures reset together; `directiveMove`),
`intent.test.ts` (the `finish` rescue and its negatives), `engine-loop-fixes.test.ts` (each fix end to end, plus the
gather_context exit and its negatives), `engine-core.test.ts` (fallback == argmax emits no signature). Gates: `tsc` clean
outside the other agent's `src/synth` / `test/unit/synth/search` WIP, `no-any` ok, `test/unit/loop` + `test/unit/bench` +
`test/unit/core` 31 files / 261 tests green.

### 14.2 Live: ladder 12, round 4 → round 5 (`bench/results/jev-only-ladder-4` → `bench/results/jev-only-ladder-5`, bench `20260920-222854-894c0f`)

Same command shape as round 4 (12 tasks, `--concurrency 3`, `--max-steps 20`, decider `typesafe/jev-1.13-20260917`).
**Confound, stated up front:** the other agent's uncommitted synthesizer changes (`src/synth/{index,oracle/index,
search/index,search/memory,search/proposal,search/subgoal,beam/state,sketch/questions}.ts`, +652/−55 over the last commit
`3d0d803`, §13's holds/suspicion/perturbation work) were live in the working tree during this run, so the search phases
differ from round 4 for reasons unrelated to the loop fixes. The loop-side columns below are read per step record from
`~/.jevcode/runs/<runId>/{steps.jsonl,decisions.jsonl,transcript.log}` and are exact; the aggregate step count is not a
clean measure of the three fixes.

| task | r4 pass | r4 steps | r4 stop | r4 Jev $ | r5 pass | r5 steps | r5 stop | r5 Jev $ | r5 refused (blocked+declined) | r5 loops/replans | verified `done`s (Fix 1) | verification runs executed (of which Jev tail ≥ 0.30) (Fix 2) | `finish` rescues (Fix 1b) | refused-signature / `done` trips (Fix 3) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| account | **miss** | 20 | max_steps | 0.0213 | **pass** | 15 | complete | 0.0138 | 4 (3+1) | 3/3 | 0 | 6 (4) | 0 | 1 |
| calendar_utils | pass | 20 | max_steps | 0.0211 | pass | 12 | complete | 0.0085 | 0 | 2/2 | 0 | 5 (4) | 0 | 0 |
| inventory | pass | 20 | max_steps | 0.0259 | **miss** | 20 | max_steps | 0.0250 | 5 (3+2) | 3/3 | 0 | 6 (3) | 0 | 0 |
| units | pass | 20 | max_steps | 0.0109 | pass | 20 | max_steps | 0.0226 | 5 (4+1) | 4/4 | 0 | 5 (3) | 0 | 1 |
| shipping | pass | 10 | replan_stop | 0.0156 | pass | 19 | max_replans | 0.0547 | 2 (0+2) | 6/5 | 3 | 9 (8) | 2 | 1 |
| table | pass | 9 | replan_stop | 0.0178 | pass | 12 | replan_stop | 0.0254 | 0 | 2/1 | 3 | 6 (3) | 1 | 1 |
| textstats | pass | 13 | complete | 0.0122 | pass | 8 | complete | 0.0098 | 0 | 0/0 | 0 | 4 (2) | 0 | 0 |
| grades | pass | 9 | complete | 0.0048 | pass | 16 | replan_stop (§5.5 exit) | 0.0083 | 1 (0+1) | 2/1 | 6 | 3 (1) | 3 | 2 |
| events, profiles, tagcloud | pass | 4 each | complete | 0.0019/0.0018/0.0020 | pass | 4 each | complete | 0.0019/0.0018/0.0021 | 0 | 0/0 | 0 | 2 each (0) | 0 | 0 |
| stats | pass | 4 | complete | 0.0018 | pass | 5 | complete | 0.0035 | 0 | 0/0 | 0 | 3 (1) | 0 | 0 |
| **total** | 11/12 | **137** | 6 complete, 4 max_steps, 2 replan_stop | 0.1370 | 11/12 | **139** | 7 complete, 2 max_steps, 2 replan_stop, 1 max_replans | 0.1773 | **17** (r4: 58) | 22/19 (r4: 16/13) | 12 | 53 (29) | 6 | 6 |

steps-to-solve mean (passed) 10.64 → 10.82, median 9 → 12; Jev requests 964 → 1144; wall mean 3m16s → 4m21s.

### 14.3 What each fix did, read from the records

- **Fix 2 is the fix that paid.** 53 test-command runs executed; 29 carried a Jev alignment tail ≥ 0.30 that round 4's
  policy would have sent to the bench's always-declining reviewer. calendar_utils 20 → 12 `complete` (post-patch suite
  runs at 5, 8, 12 executed; the step-12 run's `task_complete` 0.89 stopped the run), textstats 13 → 8 `complete`, and
  account's goal-subset runs (`record the failing behaviour of …`, blocked ×3 in round 4) all executed. Refusals fell
  58 → 17; the 17 left are partial `done`s (rightly blocked: `plan.remaining` non-empty), review-band `patch`es
  re-proposed and executed the next step (the `scratch.rejected` path, as in round 4) and review-band `read`s.
- **Fix 1 fired 12 times (grades 6, shipping 3, table 3) and saved no steps: the green `done` now reaches the completion
  Noul, which rejects it.** `task_complete` on those noop `done`s read 0.42–0.68 (grades), 0.73–0.80 (shipping),
  0.70–0.79 (table), all under 0.85, while the same Noul on the preceding all-green `run` read 0.84 (grades), 0.77
  (shipping), 0.80 (table) — and 0.85–0.89 where the run did stop the task (account, calendar_utils, textstats). Two
  reasons visible in the state: the accepted `plan.remaining` still lists `verify the full test suite passes` (the run
  claims only fix items; a noop step's claims are never judged, so the item can never be accepted — the completion
  criteria's false side names exactly "`proposal.planClaim.remaining` is empty but `plan.remaining` … shows unfinished or
  unverified work"), and the `done` state's `executed` carries no test output (`{ action: 'done', summary, exitCode:
  null, output: '' }`), so the `done` step scores *lower* than the run it follows. The `done` is then re-proposed
  unchanged (`done rejected: task_complete=0.79`), three identical noop `done`s trip `done:<sha12>`, and the replan asks
  Jev for `gather_context` on a solved task. So the refusal moved from the risk stage to the stop rule; the next lever is
  synthesizer/plan-side (the all-green `run` claiming the `verify …` item so the plan empties, per §10's "the all-green
  run claims everything", and/or the judge state carrying the last parsed run for a noop `done`), not loop-side.
  The `finish` rescue fired 6 times (grades 11–13, shipping 17–18, table 10): the effective intent stayed `finish` and the
  risk stage judged the `done` against the right intent (`matches_intent` no longer 0.06–0.19 as in round 4).
- **Fix 3 did what it said, and its per-signature resets have a side effect.** Refused `done`s now trip: account's partial
  `done` ×3 tripped at 13 (never in round 4) → `change_approach` → "reopened g2; rotated source order; sites rebuilt" →
  patch at 14 → green run at 15 → `complete` at 15 (round 4: max_steps miss) — the analysis' "pass-rate item" (`account`
  needs `pairsOfPartials`/reopen-all) was overtaken here, though with the synth WIP live the pass cannot be attributed to
  the trip alone. units' partial `done` ×3 tripped at 13 (→ `gather_context`, "nothing to change"; the fix landed at 20,
  one step short of its verifying run). The §5.5 exit fired once (grades step 17: second `gather_context` for
  `done:2d12032b479e` → `replan_stop` at 16, 4 steps under `max_steps`). `intent:unresolved` fell from 4 trips / 9
  signatures in account alone to 1 signature in the whole round (table 12, a real fallback: answer `verify`, effective
  `investigate`) and 0 trips. **Side effect:** with counts no longer wiped by every trip and replan, the `fail:` signature
  tripped 6 times (round 4: 1) and `read:` 7 (5): the `fail:` of a failing test run is `sha12("exit:1" + normalised last
  stdout line)`, and pytest's summary `1 failed, 9 passed in 0.40s` normalises to `<n> failed, <n> passed in <dur>` — so
  three failing full-suite runs that each show progress (units 6/10 → 8/10 → 9/10 at steps 1, 4, 6) read as "the same
  failure ×3" and cost a replan whose directive perturbs the synthesizer (units step 7 `gather_context`: "file beam 5 →
  10; re-localise g3"; step 10: "sites of g3 dropped" → g3 parked). Replans rose 13 → 19 and Jev cost $0.137 → $0.177.
  This is a pre-existing normalisation gap in the `fail:` signature (round 4 units already had the same
  `fail:d348820efab1` at steps 1, 4, 7) that the global reset used to mask; the fix belongs in `loopdetect.ts` (sign a
  test-command run's failure with its parsed counts, or omit `fail:` when the step already carries a `run:` signature
  whose result includes the failing test ids) and is a DESIGN §6 semantics change, so it is recorded here rather than
  slipped in after the measured run.
- **inventory's miss and shipping's 19 steps are search-side.** inventory: 2 patches executed, ledger `fixed 3 of 4`,
  `test_total_value` never found (round 4 found it at step 16); no patch was refused beyond one review-band `patch` at 6
  re-proposed and executed at 9, as in round 4. shipping: the fix landed at step 15 (round 4: 5) after five replans
  during the search (`fail:` ×2, `run:` ×2, `read:` ×1, all `change_approach`, rotating g1's sources four times), then the
  green `done` ×3 → trip → the sixth replan hit `max_replans`. Both ran with the synth WIP and under 3-way concurrency
  (inventory 454 s, shipping 642 s wall).

Net: the fixes removed the failure class the analysis measured (41 fewer refusals, 4 of 5 `max_steps`/`replan_stop`
tails converted or shortened where the completion Noul agreed) but the predicted 137 → ≈113 did not materialise
(139): 12 steps went to noop `done`s the completion Noul rejects, and ≈15 to the extra `fail:`/`read:` replans and the
two search-side regressions. 12/12 was not expected from these fixes and did not happen (account in, inventory out).

### 14.4 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/loop test/unit/bench test/unit/core

# the live re-run (keys only via .env)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder --conditions jev-only --live \
  --spend-cap 1.5 --task-spend-cap 0.15 --concurrency 3 --max-steps 20 --max-wall 12m --out bench/results/jev-only-ladder-5

# the table and the per-fix attribution (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/{steps,decisions}.jsonl and transcript.log)
python3 .scratch/ladder-5-table.py bench/results/jev-only-ladder-4 bench/results/jev-only-ladder-5
```
Run ids: account `20260920-222854-xny65bfw`, calendar_utils `-222854-uww2v2n5`, events `-222854-xm7a7jux`, grades
`-222955-jqcsrb3o`, inventory `-223055-sdhuelzm`, profiles `-223310-6gr73sbf`, shipping `-223335-e5uj3jj2`, stats
`-223612-tdysam5n`, table `-223704-37ql37hj`, tagcloud `-223831-vdbo2rsu`, textstats `-223844-nuslwjoq`, units
`-224311-qm3lnayj`.

## 15. 2026-09-20 (later): controller bookkeeping — partials before park, whole-site batches, `wrap` gap sites; ladder `account` 0/3 → 3/3 hunks (2 runs), `wrap` gold-identical

Follow-up to `jev-only-ladder-4-analysis.md` §1 (the `account` partial trap: both gold half-fixes found and dropped
with the goal's park; the gold of the third hunk ranked p = 1.00 and killed by a loaded lane) and to §13.4 above
(the two `subgoal.ts` items reported and not edited, the `wrap` gap absent from the site list). Six code rules,
all bookkeeping the harness knows for certain — which partials it holds, whether a passer is held, which goals are
parked, which sources of a site ran, whether every run of a batch was killed, which gaps a function has. Jev stays
the decider of everything it decided before. Code = `src/synth/search/{index,subgoal,bases,directive,sites}.ts`,
`src/synth/sieve/runner.ts`; tests under `test/unit/synth/search` and `test/unit/synth/sieve`.

### 14.1 What changed, per item

1. **Partials are combined before a goal is parked.** `bases.ts`: `forgetHeld` (:430) is the park-time form of
   `forgetGoal` — the held passers, fallbacks and the improved base go, the remembered partials STAY; `forgetGoal`
   (a commit) still drops everything. `freshPairsOfPartials` (:456) lists the `pairsOfPartials` whose diff on the
   committed workspace is not in `tried`. `persistPartials` / `partialsFromPersisted` / `restorePartials`
   (:503 / :543 / :598) carry ≤ `MAX_PERSISTED_PARTIALS_PER_GOAL` = 4 records per unfixed goal (site, text,
   extra edits, newly-passing tests, passed count; ≈ 250 B each) in `synthState` beside memory.ts's record
   (`index.ts` :348 writes, :692 restores on the first baseline of a process, only where the edit still applies
   and its tests still fail). `subgoal.ts`: the pairs reserve `PAIRS_RESERVE_WALL_MS` 15 s / `PAIRS_RESERVE_RUNS`
   16 (:65, the guard's HOLD_RESERVE_* mirrored); `runsBeforeReserve` (:504) = runs the step can spend before the
   reserve; `pairsDue` (:513) — untested pairs exist and the next batch would spend the reserve — runs `visitPairs`
   (:523) before that batch (checked in `visitSource` and `visitSeedBatch`); `visitPairs` also runs at the start
   of a step that resumes with remembered partials (:815), on every `budget` exit (`exitOnBudget` :759) and before
   a park (:873), on top of the design's post-SEEDS call. `index.ts` :523: a `budget` exit while untested pairs
   exist keeps the goal `open` without counting a budget hit (the next step runs the pairs first); :512 / :535
   park with `forgetHeld`.
2. **A held or pending lone passer is committed before park.** `subgoal.ts exitOnBudget` (:759): pairs, then
   `commitSuspect(mem, goal)`, then `budget`; every `budget` exit of the phase loop goes through it (`exitOn`
   :770). `index.ts` :482: whatever the search returned short of a commit, a passer the guard still holds for the
   goal is committed as the patch (`synth guard: … search ended budget with a held passer; committing it`).
3. **`change_approach` reopens every parked goal**, in ledger order, each with its source order rotated and its
   sites rebuilt (`directive.ts` :166; the `.at(-1)` is gone). Attempts stand (§5.3 counts searches without a
   commit) — see 14.4.
4. **Whole-site batch in SIEVE.** `subgoal.ts visitSeedBatch` (:657), called by `visitSite` (:707) for SEEDS and
   WIDENED on a SIEVE oracle: the seed sources still open at the site are enumerated together; when the union fits
   §2.4 SIEVE it is queued as one batch (per-source priors keep the source order inside it) and decided once. The
   sources whose every queued candidate completed are marked exhausted BEFORE the decision, so the guard's rule (a)
   (`sieveHoldApplies` reads `goal.exhausted`) sees the site batch as done and a clean lone passer is committed at
   once instead of being held until another site's decision; a site with nothing fresh consumes no decision. A
   union that needs RANK is visited source by source from the same enumeration (no double count). The transcript
   gets one `synth site:` line per batch (site, indent, base, per-source counts, the site's evidence note) — the
   run dissections of §13 reconstructed this order from `tried`.
5. **In-flight timeout retry.** `runner.ts`: a run the sandbox killed at the lane timeout is a new `killed`
   job result (:643), decided at the batch end (:694): when EVERY classified run of the batch was killed, at least
   `IN_FLIGHT_RETRY_MIN_RUNS` = 2 of them, and the batch's run median read a load ≥ LOAD_SCALE_MIN_RATIO (2×), the
   candidates go to `mem.retryTimeouts` (not `tried`) with `runTimeoutMs` = the lane timeout × min(load,
   `IN_FLIGHT_RETRY_TIMEOUT_FACTOR` = 2) and are retried first at the next call for the goal (the existing
   provisional-timeout machinery; the retry's verdict is final); otherwise every killed run is a hang, classified
   and tried, as before. `subgoal.ts drainRetries` (:544) runs the pending retries once more before a park when
   the step still has budget. The verify event says `N in-flight timeouts under load ×R: re-queued once, lane
   timeout A→B ms`. The measured batch (`account` step 18, 4 killed at 11.5 s under ×23) would have been re-queued
   with a 23 s lane timeout.
6. **`wrap` site list.** (a) WIDENED as asked: `sites.ts orderWidenedSites` (:1010) orders the widened sites by the
   localisation's line evidence (Q5 p, Q5n Noul — `lineEvidenceOf` :979 reads the map `buildGoalSites` records
   beside its `ordered` array, :836; a gap scores the better of its two neighbouring lines, `widenedSiteScore`),
   then by distance from the top-1 line, cut at `WIDENED_SITES_MAX` = 24 (:124); `subgoal.ts` :846 uses it and
   notes the list and its cost (`synth widened: … N sites (G gaps, L lines) …; WIDENED cost E candidates
   enumerated, T tested, R runs`). On the `wrap` fixture with the live Nouls (L7 0.61, L4 0.36, L6/L9 0.21) the
   gold gap is 9th of 16 in the full list and 2nd of the 6 left after the live SEEDS list is excluded. (b) **Beyond
   the asked list, the §13.4 lever:** the first live run of (a) (`wrap` a, table below) showed WIDENED cannot help
   `wrap` in the step that matters — SEEDS on its 9–10 sites spends the step (run a: 1,143 runs, wall 3 s left at
   the reserve release; run 3 and §13.3 b/c: the 1,500-run cap), the guard releases the held overfit at the
   reserve, and item 2 would commit it on the budget exit anyway. So `loopExitGap` (`sites.ts` :403): for a Q5
   anchor inside (or heading) a `for`/`while`, the block-end slot at the loop's indent between its body and the
   statement that follows — the gap the loop exits into — is the anchor's third gap after its ±1 neighbours
   (:770, note `exit gap of the loop enclosing L<n>`), anchored to it, so `orderGoalSites` visits it right after
   the anchor's own gaps. Two of the four QuixBugs insertion golds sit exactly there (`wrap`, `shunting_yard`).
   Cost: one site's candidates per loop-enclosed anchor (measured below).

### 14.2 Tests

`test/unit/synth/search/subgoal.test.ts`: "SIEVE: a site's seed sources run as ONE batch decided ONCE; the real
guard commits a clean lone passer at once (no pending hold); an exhausted site consumes no decision" (item 4, with
`createDecide()` as the guard and a throwing `ask`); "complementary partials: their untested pair runs before the
batch that would spend the pairs reserve, and a passing pair is committed as one composite candidate" (item 1,
real `pairsOfPartials`); "a step that ends on its budget commits the passer the guard holds (pending or suspect)
instead of returning `budget` with the hold dropped" (item 2). `controller.test.ts`: "a budget exit with an untested
pair of complementary partials keeps the goal open; once the pair ran the §5.3 park applies, the partials are kept
and persisted (≤ 4 per goal), and a resumed run restores them" (item 1, through `synthesize` and a checkpoint round
trip); "a `budget` result while the guard holds a passer: the controller commits it as the patch — a hold is decided,
never parked away" (item 2). `bases.test.ts`: "forgetHeld keeps the remembered partials …; freshPairsOfPartials lists
the untested pairs"; "persistPartials / restorePartials: ≤ 4 records per unfixed goal …; stale, fixed or malformed
records are dropped". `directive.test.ts`: "change_approach with every goal parked reopens EVERY parked goal in ledger
order, each rotated and re-localised; fixed goals stay fixed" (item 3, rewritten from "the newest"). `sites.test.ts`:
"orderWidenedSites: line evidence first (a gap scores its better neighbour), then distance from the top-1 line, cut
at WIDENED_SITES_MAX — wrap's gap before `return lines` is second once the SEEDS sites are excluded";
"lineEvidenceOf: the Q5 p and Q5n Nouls behind a buildGoalSites list travel with its `ordered` array …";
"loopExitGap: the block-end slot at the loop's indent for a line inside (or heading) the loop, none outside a loop;
buildGoalSites makes it the anchor's third gap, inside the 6-cut" (wrap fixture, the shipped `wrap.py`,
`shunting_yard`'s nested loops, and the live Q5 masses → the gap is site 4 of the ordered list). `test/unit/synth/sieve/
runner.test.ts`: "in-flight timeouts: a batch whose every run the sandbox killed under load is re-queued once (not
tried) with the lane timeout scaled by the load and classified by that retry; a killed run beside a finished one is a
hang" (item 5, worktree lanes, the ladder oracle shape). Three expectations moved with the behaviour: the phase-walk
test's WIDENED order (evidence, then distance from L5), the lone-passer test's enumerations (three sources, one
decision), the directive reopen test. Gates: `tsc --noEmit` and `no-any` clean; `vitest --project unit
test/unit/synth` 73 files, 1,215 tests; the whole unit project 140 files, 2,031 tests.

### 14.3 Live (concurrency 1 per task; the machine carried another agent's runs, load average 8–43)

"solved" = the bench's `pass`; the verdict applies `model_patch.diff` to the buggy program and compares with the
reference: gold-identical = whitespace/comment-insensitive equality; equivalent = agrees with the reference on the
JSON tests plus code perturbations (strings: first word, empty, trailing word; ints ±1; lists drop/dup) or, for
`detect_cycle`, on 48 linked lists (lengths 1–12, acyclic / cycle to head, middle, self).

| task | code | solved | steps | cost (Jev) | wall | stop | patch verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `wrap` (a) | items 1–6a | yes | 12 | $0.0048 | 101 s | max_steps | **overfit** (the §13 duplicated loop; differs from gold on `wrap("The", 50)`: `[]` vs `['The']`) |
| `wrap` (b) | + 6b loop-exit gap | yes | 5 | $0.0024 | 91 s | complete | **gold-identical** (`lines.append(text)` before `return lines`, indent 4) |
| `account` (1) | all | yes | 10 | $0.0135 | 250 s | complete | **gold-identical**, 3/3 hunks |
| `account` (2) | all | yes | 20 | $0.0167 | 126 s | max_steps | **gold-identical**, 3/3 hunks (both fixes by step 6; steps 9–20 are `done` proposals the engine declined or blocked, 14.3.3) |
| `kth` | all | yes | 4 | $0.0019 | 31 s | complete | gold-identical |
| `detect_cycle` | all | yes | 4 | $0.0019 | 39 s | complete | equivalent (48/48 linked lists; the L9 guard `guard_empty_return`, not the L5 condition — as §13.3) |
| `depth_first_search` | all | yes | 4 | $0.0018 | 41 s | complete | gold-identical |
| `lcs_length` | all | yes | 4 | $0.0018 | 26 s | complete | gold-identical |
| `shunting_yard` | all | yes | 4 | $0.0021 | 65 s | complete | gold-identical |

**14.3.1 `wrap` a → b.** Run a repeated §13.3 c exactly: SEEDS over 9 sites, the duplicated-loop passer from
`donor/statement_donor` at wrap.py:7:insert held on `duplicates_block` (Q16 0.06), a second copy arbitrated to the
all-overfit signature (escape 0.91, max general 0.06), release at the budget reserve (357 runs and 3 s of wall left
after 1,143 runs) and committed as `possible overfit`; WIDENED was never entered — the step ends in SEEDS, and the
commit ends the goal. Run b, with the loop-exit gap as L7's third gap (order `7r, 8i@8, 7i@8, 9i@4, …`): the same
overfit was held at batch 4 (147 candidates at 7i@8); batch 5 was the exit gap's whole-site batch (140
candidates), its one passer the gold; `arbitrated 2 passers (1 held) in 2 clusters (probe 16 inputs, 2/2
signatures); escape 0.13, max general 0.66; pick mutation/statement_template at wrap.py:9:insert` — the probe put
the two in different clusters (the copied loop drops the remainder on the first-word and empty inputs) and Q15 chose
the gold at once; 920 runs, 4 Jev requests, commit at step 4, `done` at step 5. The exit gap cost 140 of the step's
920 runs (15 %); WIDENED's cost (item 6a) could not be measured live in this round: no run of it entered WIDENED
(every step either committed in SEEDS or spent its budget there), so its numbers are the unit fixture's (16
widened sites for `wrap`, 6 after the SEEDS exclusion, cut 24 never binding on a QuixBugs-size function).

**14.3.2 `account` run 1** (`20260920-231100-3yxt7mg7`). Step 3: g2 (Q1 tiebreak) RANK, 773 runs, the 30-request
cap ends the step (`budget`). Step 4: g1 RANK, 1,500 runs (the run cap, 30 s of wall left), 2 partials in the LAST
batch (4 tested) — both at one site, so no pair yet; `budget`, first hit, open. Step 5: g1 SIEVE — partials at
L36 replace (1 + 9) and L53 replace (2) over three batches; before the next batch `pairsDue` held (runs left 669,
`runsBeforeReserve` 5): `synth pairs: g1: testing 10 pairs of complementary partials`; 5 of the 10 pairs passed
every test; `arbitrated 5 passers (0 held) in 1 cluster (no probe); escape 0.17, max general 0.57; pick
composite/pair_of_partials at src/account.py:36:replace` → the patch of both hunks (`>` at L36, `dst.deposit` at
L53), 841 runs, 8 requests. Step 6 the post-patch run (9/10). Steps 7–8 `read`s under `investigate` (loop-side).
Step 9: `change_approach: rotated source order of g2 (1); site beam 6 → 10` — g2 SIEVE over 11 sites, 1,489 runs,
the gold `enumerate(self.history, 1)` plausible in the last batch (48 tested, 3 runs left) → commit. Step 10 green,
`done`. The loop-exit gap of g2's anchor L44 (`src/account.py:47:insert`, indent 8) was visited first among L44's
gaps at 361 candidates (donor 124, mutation 237) and bought nothing there (the fix is a replacement): 24 % of the
step's runs — the lever's cost on a program where it does not apply.

**14.3.3 `account` run 2** (`20260920-231644-kpichkgc`). Both new rules fired, one per goal. Step 3: g1 (Q1)
RANK, 10 sites, 24 requests; the two halves arrived as partials in two RANK batches of 5 with 19 and 14 runs left
(2 partial, then 1 partial); the next batch would have spent the reserve, so `synth pairs: g1: testing 2 pairs of
complementary partials (runs left 14, test wall left 43 s)` → both pairs plausible → `arbitrated 2 passers (0 held)
in 1 cluster; escape 0.20, max general 0.38; pick composite/pair_of_partials at src/account.py:36:replace` → the
two-hunk patch, 1,482 runs, at the goal's FIRST step (ladder-4 never got it in 20). Step 6: g2 RANK, 1,467 runs,
`holds the lone passer mutation/argument_arity at src/account.py:44:replace until its site's seed sources ran`
(rule (a): the site's union needed RANK, so the sources ran one by one) — the 30-request cap then ended the step,
and item 2 committed it: `the step ends on its budget; committing the held passer` (before this round the hold
would have travelled into the next step, or been dropped with a park). Step 8: the post-patch run executed, 10/10,
judge completion 0.73 but the `fix …test_statement…` claim was left `unverified`; step 9 `done` was **declined**
(risk 0.30 review, `out_of_scope`, no reviewer in bench runs), step 10 `done` **blocked** (plan_mismatch 0.89, level
4 "claims completion with no verifying test run in `recent`"), and the run alternated `done` / `investigate` reads
with `gather_context` replans ("nothing to change") to `max_steps` — the engine-side shape of
`jev-only-ladder-4-analysis.md` §4 Fixes 1–2, not the synthesizer's (its ledger read `fixed 2, open 0, parked 0` from
step 6 on). The bench scores the task passed (10/10); the workspace is gold-identical.

**14.3.4 Regression check** (`detect_cycle`, `depth_first_search`, `kth`, `shunting_yard`, `lcs_length`;
`tagcloud` is a ladder task and was replaced by `lcs_length`; concurrency 3, `bench/results/jev-only-quixbugs-5-regress`,
Jev spend $0.0095). 5/5 solved, every one committed at step 3 and `complete` at step 4; 4 gold-identical,
`detect_cycle` equivalent on the 48-list differential (the run-3 overfit held on three signals at Q16 0.37 < 0.7,
then `arbitrated 6 passers (1 held) in 3 clusters (probe 16 inputs, 6/6 signatures); escape 0.03, max general
0.70` → a correct L9 guard, as in §13.3 b/c). Whole-site batches changed no verdict: `kth` and `lcs_length` were
lone-passer commits with no hold (SIEVE, 2 requests each — the site's three sources decided once);
`depth_first_search` arbitrated 2 passers (its `nodesvisited.add(node)` gold-identical), `shunting_yard` 3 (max
general 0.86, gold-identical; 1,196 runs — its `for`-enclosed anchors each add a loop-exit gap, the largest
step of the set). No in-flight timeout and no pairs batch fired on the set (no partials pair, no all-killed batch).

Round spend: `wrap` a + b $0.0072, `account` 1 + 2 $0.0302, regression $0.0095 — $0.047 live, generator $0.

### 14.4 What remains

- **WIDENED (6a) is unmeasured live.** Every step of this round ended in SEEDS. It is reached only on the step
  after SEEDS exhausts every site without a commit — the design's intended shape (`lis`, `mergesort`) — and its
  order now follows the evidence; a run that gets there will print its `synth widened:` cost line.
- **The loop-exit gap costs 140–361 candidates per loop-enclosed anchor** (one whole-site batch: 15 % of `wrap`'s
  winning step, 24 % of `account` g2's) and buys nothing on a replacement bug. It is anchored to Jev's line, so
  it enters the 6-cut before the ranked slots; measuring it over the 40 (§11's insertion set and the replacement
  programs) is the next check.
- **A reopened goal's `attempts` stand**, so `parkReasonFor` re-parks it after one more budget-hit step ("3 searches
  without a commit" — `account` ladder-4 step 19). Resetting attempts on reopen is a `goals.ts` / directive rule
  not taken here; g2 in run 1 committed within its reopened step.
- **The in-flight rule fires only on all-killed batches of ≥ 2**; a lone gold killed under load is still a final
  `timeout` (the single-candidate batch of the runner tests is a genuine hang and must stay one).
- The `investigate` reads (steps 7–8 of run 1) and the replans that say `gather_context` with every goal parked are
  loop-side (`jev-only-ladder-4-analysis.md` §4 Fixes 1–3), unchanged here.

### 14.5 Exact commands

```
# gates
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth

# live (node_modules symlinked into the worktree; .env in the main checkout)
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs --task-id wrap \
  --conditions jev-only --live --spend-cap 0.2 --concurrency 1 --max-steps 12 --max-wall 8m --out bench/results/jev-only-quixbugs-5-wrap      # then -b
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder --task-id account \
  --conditions jev-only --live --spend-cap 0.4 --task-spend-cap 0.3 --concurrency 1 --max-steps 20 --max-wall 12m --out bench/results/jev-only-ladder-account-1   # then -2
env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite quixbugs \
  --task-id detect_cycle,depth_first_search,kth,shunting_yard,lcs_length --conditions jev-only --live --spend-cap 0.3 --concurrency 3 \
  --max-steps 12 --max-wall 8m --out bench/results/jev-only-quixbugs-5-regress

# the table and the patch verdicts (stdlib python: git-applies model_patch.diff to the buggy program, compares with the reference, differential runs)
python3 .scratch/verdict.py bench/results/jev-only-quixbugs-5-wrap-b bench/results/jev-only-ladder-account-1 bench/results/jev-only-quixbugs-5-regress
```

## 16. 2026-09-20 (later): statement sites, depth-2 wraps, import-carrying substitutions, composite bound — capabilities 4, 5, 6 of `swebench-reach-oracle-9.md` and its performance hazard

Follow-up to `experiments/results/swebench-reach-oracle-9.md` ("Missing capabilities" items 4–6 and the caveat on the
composite units). **No Jev call: $0.00.** Every number is code + `python3` (the real sources enumerated at the gold
sites of the base-commit worktrees under `/tmp/jevonly/repos`, never written to; the FAIL_TO_PASS tests run in private
worktrees under `/tmp/jevonly/reach/<id>-cap456` with the bench venvs). Nothing is committed.

### 16.1 What changed (Jev-only: code proposes, Jev chooses among ≤ 255, tests verify)

1. **Statement-level replace sites** (capability 4, django-15315). `Site.endLine?` (`src/synth/types.ts:36`, additive)
   marks a replace site whose text replaces the physical span `line..endLine`; `currentLine` is the statement joined onto
   one line. `src/synth/localize/sites.ts:288 joinedStatementText` joins a multi-line statement from its code tokens (source
   spacing kept inside a line, one space across a break, none after an open bracket or before a close bracket/comma, the
   trailing comma before the closing bracket dropped; comments and backslash continuations vanish; a token spanning lines —
   a triple-quoted string — yields no site); `:316 statementSiteAt` builds the site (never on a `def`/`class` header or a
   docstring); `:339 isStatementSite`. `:424 buildSites` / `:436 pushReplace`: at the statement's **first** physical line the
   statement site stands **in place of** the physical-line site (`search/sites.ts siteKey` is `path:line:kind`, so two sites
   at one line would be one there and the physical one would win `addReplace`); at a later line of the statement the
   physical site stays and the statement site is added once. `src/synth/verify/apply.ts:58 siteSpanEnd`, `:79 spanDeletes`,
   `:117`: the first line is replaced, the continuation lines deleted (before-candidate numbering, one bottom-up pass with the
   extra edits), the site is stale when the span's code tokens no longer read as the joined statement (`:66 codeTokenKey`,
   trailing commas normalised), and an extra edit inside the span is refused (`VerifyError`). The sieve sees a normal
   `Candidate` (`site.kind = 'replace'`, text + `extraEdits`); `canonicalText`/`siteKey` untouched. Templates see the joined
   statement: `templates/index.ts:77/:97 wellFormed` balances a replacement against `site.currentLine` (not the physical
   first line, which is unbalanced), `templates/common.ts:544 endsHere` / `:500 dedentLevels` / `:388 nearby` read the span,
   so both `_before` and `_after` forms exist there. Composite: `search/composite.ts:196 derivedSite` replaces the span (the
   derived site is a one-line site), pairs carry no extra edits at a span site (`:279`), signature and donor-body units
   return `[]` there (`:555`, `:720`; their extra edits address physical lines and the physical site already offers them).
   **Mutation operator `collapse_collection_to_element`** (`src/synth/mutate/operators.ts:874`, table `:33`, prior 0.5 `:71`):
   a bracketed tuple/list/set literal of 2–6 elements (`:75 MAX_COLLAPSE_ELEMENTS`) or a bare tuple value collapses to each
   single element (`hash((a, b))` → `hash(a)`, `hash(b)`; `[a, b]` → `[a]`, `[b]`; `return a, b` → `return a`); never a call
   or subscript, a header, a comprehension, a dict literal or a literal holding a declared name. `mutate/index.ts:174
   operatorsFor`: enumerated at statement-level sites and in WIDENED only, so the measured SEEDS sets at physical lines are
   unchanged (40/40 QuixBugs below).
2. **Stdlib-sibling callee substitution carrying its import** (capability 5, sympy-11618). New file
   `src/synth/templates/stdlib.ts` (`:35 STDLIB_SIBLINGS`, `:71 stdlibSiblingDrafts`), registered on the `attribute` family
   with one line (`templates/index.ts:48`; ops `callee_stdlib_subst`, `callee_stdlib_subst_kw`). Table, small and generic:
   `zip` → `zip_longest` (+ `fillvalue=0` / `fillvalue=None` drafts), `product`; `map` → `starmap`; `sum` → `fsum`, `prod`;
   `dict` → `OrderedDict`, `Counter`, `defaultdict(list|int|set)` (arity 0); `list` → `deque`; `round` → `floor`, `ceil`,
   `trunc` (arity 1). `sorted` → `heapq.nsmallest` is left out on purpose (needs an `n`: not a drop-in). A candidate is one
   site edit plus the import as an `extraEdits` insert at `importInsertLine` (`importLinesFor`'s first choice: the existing
   representation of two-hunk candidates, `import_insert_top` and the composite units use it; no new `Candidate` field was
   needed); a sibling already bound at the site carries no import; a rebound builtin is left alone.
3. **Depth-2 wraps, WIDENED only** (capability 6, sympy-19954). `EnumerateOptions.phase?` (`src/synth/types.ts:117`,
   additive hint; absent = SEEDS). New file `src/synth/templates/wrap2.ts` (`:21 DEPTH2_WRAPS` = list, reversed, sorted,
   enumerate, set, tuple, str, int; `:23 DEPTH2_WRAP_LIMIT` 40; `:31 orderedPairs`; `:70 depthTwoWrapDrafts`), registered on
   the `wrap` family with one line (`templates/index.ts:45`; ops `wrap2_<outer>_<inner>`, plus depth-1 `wrap_for_<w>` on a
   `for` iterable, a shape wrap.ts never covered). Shapes: the iterable of a `for` header, an assignment's right-hand side,
   a `return` expression; ≤ 40 ordered pairs per site, plausibility order (`reversed`/`enumerate` over a materialising
   inner first), an inner already present is never repeated. Priors sit at the wrap family's top (0.55 → 0.52 … 0.20): a
   WIDENED site has already run its SEEDS set, which the queue's `tried` check drops again, so the phase's new lines must
   land under the 254 cap to be run at all (at `perm_groups.py:2198` the 254th SEEDS candidate has prior 0.42).
4. **Composite performance hazard** (`search/composite.ts`). `:465 callIndexOf`: a per-file index callee name → one-line
   statements calling it, built once per `SourceFile` object (`WeakMap`, so one corpus is indexed once for every site and
   draft); `:507 scanCallSites` runs `scopeAt` only on lines that call the def and stops at a budget (`:498 scanBudget`:
   `:88 UNIT_DEADLINE_MS` 3,000 ms wall + `:90 CALL_SITE_STATEMENT_CAP` 5,000 call-site statements per call); `:555
   enumerateSignatureUnits` drops a draft whose scan was cut (`:578`, `:602`: a half-threaded unit breaks the callers it
   missed) and stops enumerating at the deadline; `:720 enumerateDonorBodyUnits` stops at the same deadline (same-file
   donors come first, so a cut keeps the likeliest windows). `callSiteEdits` (`:533`) is the unbounded form for tests.
   `CompositeSourceOptions.unitDeadlineMs` overrides the default.

### 16.2 Measured: the three gold sites (`experiments/reach/capabilities-4-5-6.mts`, engine corpus = first 400 non-test files + the gold file, ENUMERATE_CAP 254, sources mutation + templates + donors + composite)

| instance | capability | before: site / SEEDS candidates (m + t + d + c) | target before | after: site / phase / candidates | target after (source, index, op) | F2P (private worktree, bench venv) |
| --- | --- | --- | --- | --- | --- | --- |
| django__django-15315 | 4 statement-level site + `collapse_collection_to_element` | `__init__.py:545` (physical line): 21 + 92 + 254 + 64 = 431 | absent | `__init__.py:545-549` (statement-level site, SEEDS): 254 + 254 + 254 + 100 = 862 | mutation **#41** of 254 (`collapse_collection_to_element`): `return hash(self.creation_counter)`, the gold line | **PASS** `test_hash_immutability` (2.4 s) |
| sympy__sympy-11618 | 5 stdlib sibling + import (at the statement-level site) | `point.py:269` (physical line): 137 + 97 + 254 + 148 = 636 | absent | `point.py:269-270` (statement-level site, SEEDS): 254 + 202 + 254 + 100 = 810 | template **#58** of 202 (`callee_stdlib_subst_kw`): `… zip_longest(self.args, p.args if isinstance(p, Point) else p, fillvalue=0) …` + insert@26 `from itertools import zip_longest` | **PASS** `test_issue_11617` (8.2 s) |
| sympy__sympy-19954 | 6 depth-2 wraps (WIDENED) | `perm_groups.py:2198`, SEEDS: 81 + 254 + 254 + 100 = 689 | absent | same line, WIDENED: 81 + 254 + 254 + 100 = 689 | template **#170** of 254 (`wrap2_reversed_list`): `for i, r in reversed(list(enumerate(rep_blocks))):` | **PASS** `test_sylow_subgroup` (12.2 s) |

Reading: the study's "3 of 9 reached, one degenerate" becomes 5 of 9 non-degenerate at the gold site (requests-2931,
sympy-12096, django-15315 by the gold line itself, sympy-11618 and sympy-19954 by their test-equivalent one-liners), all
inside the 254-per-source cap; 15315 and 11618 in SEEDS at the new statement-level site, 19954 in WIDENED. Uncapped, the
19954 candidate was index 560 of 844 with the first prior placement (0.275); at the wrap family's top it is 170 of 254.
The physical-line sites are unchanged (15315: 21/92 as in the study; the composite count differs from the study's 16
only because the signature and donor units were disabled there). Per-source wall at the statement sites: mutation 8–25 ms,
templates 33–124 ms, donors 0.35–2.3 s, composite 1.3–2.8 s (log: `experiments/reach/out/log-capabilities-4-5-6.txt`;
JSON: `out/capabilities-4-5-6.json`).

### 16.3 Measured: the 40 QuixBugs gold sites (`experiments/reach/quixbugs-phase-counts.mts`, mutation + templates + composite, cap 254, single-file corpus)

`out/quixbugs-phase-counts.compare.md` (before = this code before the change, after = now; per program, SEEDS vs WIDENED):

- **SEEDS total 13,053 → 13,053, 0 of 40 sites changed** (the collapse operator is gated to statement sites/WIDENED, the
  depth-2 wraps to WIDENED; the stdlib production runs in SEEDS but no QuixBugs gold line calls a callee of its table).
- **WIDENED total 13,053 → 13,707 (+5.0 %), max per site +19.3 % (`bitcount`)**; the next largest `max_sublist_sum`
  +14.5 %, `pascal` +13.9 %, `shortest_paths` +13.4 %; ≤ 25 % everywhere. Gold in SEEDS 40/40 → 40/40, in WIDENED 40/40.

### 16.4 Measured: the composite units at `sympy/core/function.py:510` (`experiments/reach/composite-timing.mts`, sympy-12096 base checkout, 400-file corpus, under a 300 s external cap)

| units | before | after |
| --- | --- | --- |
| signature units | **did not return within 300 s (killed)**; the study: > 10 min, then 27 min | **0 units in 1,223 ms** (corpus load 2.3 s aside) |
| donor-body units | 28.7 s (study, 48 units) | **48 units in 3,045 ms** (the 3 s deadline; same-file windows first) |

Logs: `out/log-composite-timing-before.txt`, `out/log-composite-timing-after.txt`. Unit test with a synthetic 300-file
corpus (300 files × 40 statements, 3,000 call sites of the def): `enumerateSignatureUnits` returns the complete unit
(header + 3,000 threaded call edits) in < 2 s, asserted.

### 16.5 Tests (all green; gate: `npx vitest run --project unit test/unit/synth/localize test/unit/synth/verify test/unit/synth/search/composite.test.ts test/unit/synth/templates test/unit/synth/mutate` → 316 passed)

- `test/unit/synth/localize/sites.test.ts` "statement-level replace sites": joins a multi-line statement onto one line …;
  drops the trailing comma before the closing bracket … backslash continuations and comments; stands in for the physical
  site at the statement's first line and is added once after a later line (the existing "[24, 25, 26]" window expectation
  still holds).
- `test/unit/synth/verify/apply.test.ts` "applyCandidate: statement-level sites (Site.endLine)": replaces the whole physical
  span …; an extra edit outside the span (an import at the top) applies …; one inside the span is refused; the span is stale
  when its code tokens changed, not when only comments or line breaks did; plus the `git apply --check` case "a
  statement-level span replaced by one line plus an import insert".
- `test/unit/synth/templates/stdlib-wrap2.test.ts` (new): stdlib-sibling substitution (`zip_longest` with and without
  `fillvalue=0`, the itertools import after the last import, every applied candidate compiles under CPython; a bound sibling
  needs no import; a rebound builtin is left alone; arity-restricted siblings); depth-2 wraps WIDENED only (SEEDS identical
  with and without an explicit `phase: 'SEEDS'`; WIDENED adds `reversed(list(enumerate(rep_blocks)))` at the `for` header,
  ≤ DEPTH2_WRAP_LIMIT pairs, nothing else new, all compile; assign/return shapes; bare literals excluded); templates at a
  statement-level site (balanced against the joined statement, `_before` and `_after` forms, no extra edit into the span).
- `test/unit/synth/mutate/operators.test.ts` "collapse_collection_to_element keeps one element of a tuple / list / set
  literal or a bare tuple value, never of a call, a header or a dict"; `mutate/source.test.ts` "collapse_collection_to_element
  is enumerated at statement-level sites and in WIDENED only" (`operatorsFor`; the joined statement yields
  `return hash(self.creation_counter)`, the physical first line cannot).
- `test/unit/synth/search/composite.test.ts` "statement-level sites (Site.endLine)" (`derivedSite` replaces the span; pairs
  on the joined statement carry no extra edits; signature and donor-body units return `[]`) and "signature units are bounded
  on a large corpus" (returns in under 2 s with the call-site index, complete threading across every file; a spent budget cuts
  the scan and drops the half-threaded draft).
- Gates: `npx tsc -p tsconfig.json --noEmit` clean for the owned files (`node scripts/no-any.mjs` ok). Failing at the time
  of this run, all other agents' concurrent WIP, none in the files above: `test/unit/synth/mutate/ladder.test.ts` ×2 (49
  ladder hunks vs the expected 17: new `bench/data/ladder/tasks/*`), `test/unit/synth/templates/introspect.test.ts` (its
  leakage list scans `introspect.ts`/`introspect/*`/`history/*` only), tsc errors in `src/config/resolve.ts`,
  `test/unit/tui/layout/layout.test.ts`, `test/unit/synth/search/proposal-helpers.ts`.

### 16.6 What the engine still needs from files not owned here (one-line wiring)

- `src/synth/search/subgoal.ts:327 enumerateOptions` does not set `phase`: add `phase: goal.phase` so the depth-2 wraps and
  the collapse operator enumerate in the engine's WIDENED phase (today they enumerate only where a caller passes the hint;
  the statement-level site's collapse candidates need no hint).
- Statement-level sites reach the engine through `localize/index.ts:177 buildSites` → `LocalizeResult.sites` →
  `search/sites.ts q5Anchors`/`addReplace` (a Jev-anchored multi-line statement); `search/sites.ts replaceSiteAt` and
  `widenedSites` still build physical sites (no statement sites from SBFL-only rows built there or in WIDENED), and
  `subgoal.ts:340 siteOnBase` compares the physical line, so a statement site is dropped on an 'improved' base (never on the
  committed one). `rank/questions.ts:246` shows the physical first line as `buggy_line` for a statement site.
- The sieve keys a job by `path:line:kind` + code tokens: a statement-site candidate and a physical-line candidate at the
  same first line with identical tokens would be one job (rare: the bracket-signature filters keep a physical first-line
  candidate's brackets open).

### 16.7 Exact commands

```
node node_modules/.bin/tsx experiments/reach/capabilities-4-5-6.mts                         # enumeration + F2P, ≈ 3 min, $0
node node_modules/.bin/tsx experiments/reach/quixbugs-phase-counts.mts before|after          # then --compare before after
python3 -c "import subprocess; subprocess.run(['node','node_modules/.bin/tsx','experiments/reach/composite-timing.mts','sympy__sympy-12096','sympy/core/function.py','510','--donor-units'], timeout=300)"
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth/localize test/unit/synth/verify test/unit/synth/search/composite.test.ts test/unit/synth/templates test/unit/synth/mutate
```

## 17. 2026-09-20 (later): ladder round 6 — the no-op `done` carries the run; `fail:` signatures are failing sets

Follow-up to §14.3's two recorded defects. Code changed only in `src/loop/{loopdetect.ts,state.ts,stages/complete.ts}`
(the engine was not touched: a peer session is rebasing on it); both fixes are code rules over facts the harness already
knows, and Jev stays the decider of completion — the `task_complete` threshold is still 0.85 and no plan item is edited
by code.

### 17.1 What changed

1. **`fail:` = the failure's identity, not the summary text** (`src/loop/loopdetect.ts:89-97` the branch,
   `:108-207` `failingTestIds` / `testFailureIdentity`, `:44-49` the optional `SignatureInput.testRunner`). §14.3 read the
   defect as "the pytest count line normalises to `<n> failed, <n> passed`"; the records say something slightly different:
   the ladder's `pytest -q` on top of `addopts = -q` prints **no** count line, so the text rule hashed the *last stdout
   line*, which is the last `FAILED …` line of the short summary — the same test in units steps 1, 4, 6 (4 → 2 → 1
   failing) and in calendar_utils 5, 6, 8 (4 → 4 → 2), account 1, 3, 5 (3 → 3 → 1). The signature of a non-zero `run`
   whose command names a test runner (the engine's detected runner when passed, else `runnerFromCommand`) is now
   `fail:<sha12("tests:" + sorted failing/erroring ids)>` — pytest `FAILED|ERROR <id>` summary lines and `-v` rows,
   unittest/Django `FAIL|ERROR: test (Class)` (both the 3.10 and 3.11 forms) and `-v` rows, sympy `____ path.py:test ____`
   headers, cargo `test x ... FAILED`, go `--- FAIL:`, vitest/jest `FAIL`/`✕`/`●` lines — with two fallbacks:
   `counts:<passed>/<failed>/<errors>` (digits kept) when no id is printed (a `-qq` progress line), and the previous
   `exit:<code>` + normalised-first-line hash only when nothing parses or the command is not a test runner (`make`). Two
   runs are the same failure only when the failing sets are identical, whatever the message text, the order of the
   `FAILED` lines or the scope of the command (`pytest` vs `pytest tests/test_x.py`). `docs/DESIGN.md` §6 gained one dated
   paragraph (`docs/DESIGN.md:1003-1016`).
2. **The judge state of a `done` after a run carries the run** (`src/loop/state.ts:305-395`: `ExecutedInfo.lastRunOutput`,
   `commonLastRun`, `recentOutputAt`, `doneExecutedJson`; `:408` the call in `buildJudgeState`). A `done` is a no-op
   (nothing executed: `exitCode: null`, `output: ''` stay), but its `executed` block now also has the `run` step's
   `tests: { command, parsed: { passed, failed, errors }, allPassed }`, `testsCurrent`, and a `lastRun` block
   `{ step, command, allPassed, total, passed, failed, errors, workspaceUnchangedSince, output }` — all read from the
   code-computed `workspace.lastTestRun` / `workspace.testsCurrent` the common state already carries, the `output` tail
   from the run's `recent` entry (head 400 + tail 200) while that step is in the 4-step window, null once it left, or the
   engine-supplied `lastRunOutput` when given (bounded to the judge head/tail). No run yet → `tests: null, lastRun: null`.
   The plan is **not** edited: §14.3's "the run claims only fix items, so `verify …` stays" is left to Jev, who now sees the
   fact instead. The completion question (`src/loop/stages/complete.ts:18,22,25`) names `executed.lastRun` as the
   harness's record on a `done` step and adds one true-side clause and example: a `done` whose `executed.lastRun.allPassed`
   and `workspaceUnchangedSince` are true follows the engine's own verifying run, and a `plan.remaining` item that asks only
   for that verification is satisfied by it.

Tests (`test/unit/loop`): `loopdetect.test.ts:50-116` (units' 4 → 2 → 1 never trips and the old last-line equality is
asserted; identical sets trip at 3 across message text, `FAILED` order and command scope; identity forms per runner,
`FAILED (failures=1)` is not an id, `make` keeps the text hash), `state.test.ts:58-76,92-150` (the `done` state after a
green current run, after a stale run, after a failing run, tail in/out of the window, `lastRunOutput`, no run),
`engine-loop-fixes.test.ts:66-90` (end to end through the engine: the step-2 judge request of a green `done` carries
`executed.lastRun` and the question names it). Gates: `tsc` clean outside `src/synth`/`src/bench`/`test/unit/synth`,
`no-any` ok, `test/unit/loop` + `test/unit/core` 19 files / 147 tests green.

**Engine diff not applied (peer session owns `engine.ts`), optional, 3 lines:** keep the last parsed run's output —
`private lastTestRunOutput: string | null = null;` set next to `this.lastTestRun = …` at the commit point
(`engine.ts:1383`: `this.lastTestRunOutput = draft.output;`), pass it in the judge call (`engine.ts:1079`:
`{ outcome: ex.outcome, output: ex.output, changedFiles: ex.changedFiles, tests: ex.tests, lastRunOutput: this.lastTestRunOutput }`),
and hand the detected runner to the signature (`engine.ts:1414` `computeSignatures({ …, testRunner: draft.tests ? this.wsInfo.testCommand?.runner ?? null : null })`).
Without it the `done` state's `lastRun.output` is the window copy (present for 9 of round 5's 12 green `done`s; null for
grades 14–16, where the step-10 run had left the window) and `fail:` reads the runner from the command (python runners
only; jest/vitest/cargo/go keep the text hash until the runner is passed).

### 17.2 Offline replay of round 5 (`node node_modules/.bin/tsx .scratch/ladder-6-replay.mts bench/results/jev-only-ladder-5`)

The 12 green `done` judge states (grades 11–16, shipping 17–19, table 10–12), rebuilt from the step records with the new
builder (window folded per committed step, `lastTestRun`/`lastChangeStep` as the engine commits them): every one now has
`executed.tests = { command: 'python3 -m pytest -q', parsed: { passed: 10, failed: 0, errors: 0 }, allPassed: true }`,
`testsCurrent: true` and `lastRun = { step 10|16|9, allPassed true, total 10, workspaceUnchangedSince true }`; the
80-char tail (`.......... [100%]`) is present for 9 and null for grades 14–16 (run left the window). Round 5 sent these
twelve as `{ action: 'done', summary, exitCode: null, output: '' }` and Jev read 0.42–0.80.

`fail:` under the failing-set rule over all 12 round-5 runs (every signature fed to a fresh detector; the recorded replans
are not simulated, so this is indicative): of the 6 recorded `fail:` trips, the **3 on progressing sets no longer share a
signature** — calendar_utils 8 (steps 5, 6, 8: 4 → 4 → 2 failing), account 5 (1, 3, 5: 3 → 3 → 1), units 6 (1, 4, 6:
4 → 2 → 1); the **3 on identical sets remain** — inventory 12 (10, 11, 12: `test_total_value` ×3), shipping 4 and 9
(`test_describe` + 3 others, ×3 then ×3 more, no patch between). Two later identical-set loops that round 5's replan
resets happened to break would trip under the replay (account 9: steps 5, 6, 9 all `test_statement_numbering_starts_at_one`;
units 10: steps 6, 7, 10 all `test_parse_duration_case_and_spaces`) — those are the same failure three times and are what
`fail:` is for.

### 17.3 Live: the three tasks, round 5 → round 6 (`bench/results/jev-only-ladder-6-done`, items 1+2) → round 6b (`bench/results/jev-only-ladder-6-done-item3`, items 1+2+3)

Same command shape as §14.2 restricted to `--task-id grades,shipping,table` (`--concurrency 3 --max-steps 20 --max-wall 10m`,
decider `typesafe/jev-1.13-20260917`), two runs ≈ 15 minutes apart. **Confound, as in §14.2:** the other sessions'
uncommitted synthesizer changes were live in the working tree for both runs (and for round 5), so the search phases are
not held fixed; the loop-side columns are read per step record and are exact.

| task | r5 steps / stop | r5 `task_complete` on the `done` steps (run before them) | r6 steps / stop | r6 `done` steps | r6b steps / stop | r6b `done` steps | `fail:` trips r5 → r6 → r6b | replans r5 → r6 → r6b | Jev $ r5 → r6 → r6b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grades | 16 / replan_stop (§5.5 exit) | 11–16: 0.67 0.62 0.68 0.51 0.42 0.48 (run at 10: 0.84) | **8 / complete** | none — the green run at 8 read 0.93 and stopped the run | **7 / complete** | none — the run at 7 read 0.89 | 0 → 0 → 0 | 2 → 0 → 0 | 0.0083 → 0.0043 → 0.0040 |
| shipping | 19 / max_replans | 17–19: 0.80 0.75 0.73 (run at 16: 0.77) | **5 / complete** | none — the run at 5 read 0.90 | **5 / complete** | none — the run at 5 read 0.90 | 2 → 0 → 0 | 5 → 0 → 0 | 0.0547 → 0.0127 → 0.0038 |
| table | 12 / replan_stop | 10–12: 0.79 0.77 0.70 (run at 9: 0.80) | **7 / complete** | 7: **0.86** (run at 6: 0.79) | **7 / complete** | 7: **0.85** (run at 6: 0.80) | 0 → 0 → 0 | 1 → 0 → 0 | 0.0254 → 0.0197 → 0.0124 |
| total | 47 | 12 `done`s, all rejected | **20** | 0 `done`s | **19** | 1 `done`, accepted | 2 → 0 → 0 | 8 → 0 → 0 | 0.0884 → 0.0367 → 0.0202 |

Read from the records: (1) `table` is the direct measurement of item 2 — the same shape as round 5 (green run at 6/9 read
0.79/0.80 under 0.85, then a no-op `done`), but the `done` state now carries `executed.tests` (10/0/0, allPassed),
`testsCurrent: true` and `lastRun { step 6, allPassed true, total 10, workspaceUnchangedSince true, output "..........
[100%]" }`, and `task_complete` read **0.86 / 0.85** on the first `done` (round 5: 0.70–0.79 on three identical `done`s
that then tripped `done:` and cost a replan). The offline replay of the same state builder on
`bench/results/jev-only-ladder-6-done` (`.scratch/ladder-6-replay.mts`) shows the table step-7 state with the run block;
(2) `grades` and `shipping` never reached a `done`: with the synth WIP the fix landed earlier (grades patch at 4 and 6 /
run at 8; shipping patch at 4 / run at 5) and the all-green run itself read 0.89–0.93, so the `done` path was not
exercised there; (3) no `fail:` trip in either run — grades' 3 → 1 and table's 4 → 2 → 2 → 2 (two scoped runs with the
same failing pair at steps 3, 4, then a patch) carry distinct signatures per failing set (`fail:3fd74486cb08` →
`fail:5347b23490e6` ×2), and shipping's two identical full/scoped runs (`fail:da72c183dc8b` ×2) did not reach 3; round
5's 8 replans on these three tasks went to 0. Steps 47 → 20 → 19 and Jev spend $0.088 → $0.037 → $0.020 on the three
tasks, with the synth-WIP caveat above.

### 17.4 Item 3 — prior patches: a different verified patch is a new attempt, not a repeat (`src/loop/stages/risk.ts`, `state.ts`)

**Evidence (live SWE-bench `django__django-15315`, run `20260920-230759-spkhi7p6`, 11 steps, no pass):** step 3 applied
patch A (`django/db/models/fields/__init__.py:547`, evidence verified 328→329 of 357, `repro::e7fbbfa8` newly passing);
step 4's workspace run kept the regression scope green (328 passed) but the next proposal's shadow baseline was still
328/357 — A's gain did not hold on re-baseline. The synthesizer then proposed three *different* verified patches, each
twice: B (`reverse_related.py:137`, 56 candidates sieved) blocked at 5 and 6 as `plan_mismatch` level 4 "repeats a step
`recent` shows already failed the same way" (0.71/0.80 on level 4, Jev confidence 0.56/0.65); C (`__init__.py:547`, a
different template) declined at review at 7 and 8 on `out_of_scope` tail 0.52/0.34 with **Jev confidence 0.00**
(dominant level 0 both times); D (`reverse_related.py:137`, donor) blocked at 9 and 10 (0.81/0.82 on level 4). Six
refusals through step 11, where E (`__init__.py:547`) executed. Every refused patch had `evidence.verified` true and
`newlyFailing` empty, and none had the content of the applied A (diff hashes `14a23fd1b86a` A, `8b24b6833954` B,
`fc0c7e35e87d` C, `059f96a8a889` D, `740b6d0f407d` E).

**(a) `proposal.priorPatches`** (`src/loop/state.ts` `PriorPatch`/`priorPatchesJson`/`buildRiskState`'s optional
argument; `src/loop/stages/risk.ts` `PatchHistory`). The risk stage keeps a per-run history of every workspace change it
assessed (`patch`/`edit`/`write`): the content hash (`loopdetect.ts patchContentHash`, the same identity as the `patch:`
loop signature), `path:line` per hunk, the shadow counts it claimed, the workspace run before it. At each later
assessment it folds what `common.recent` shows about those steps (the outcome status) and what `workspace.lastTestRun`
shows (the first run after the patch), and for a change proposal emits, per earlier patch: `step`, `kind`, `sites`,
`status`, `applied`, `sameContent` (identical hash to the current proposal), `runAfter`, `goalHeld` (the earlier patch's
shadow gain still held when the current proposal measured its baseline on the same suite) and a code-computed `result`:
`refused` / `failed` / `regressed` (more failures in the run after) / `not_fixed` (`goalHeld` false — django A) /
`fixed` / `progressed` / `no_change` / `unverified`. The block is attached for change proposals only; a `run`/`read`/`done`
state is unchanged. The history is not the engine's yet (`engine.ts` untouched): the stage keeps one per `runId`
(`patchHistoryFor`, bounded to the 16 most recent runs of the process, dropped when a run restarts at an earlier step),
and `RiskStageOptions.patchHistory` is the injection point for the engine to own and checkpoint it (`toState()`); until
then a `--resume` starts with an empty history (the prior patches before the resume are not listed) — noted, not fixed.

**(b) rubric** (`risk.ts` `RISK_LEVEL_TEXTS_WITH_EVIDENCE.plan_mismatch[4]`): "… a different verified patch after an
earlier patch that did not fix the goal is a new attempt, not a repeat — `proposal.priorPatches` lists every earlier patch
of this run with its `result`, and only a patch identical to one already applied, `priorPatches[].sameContent` and
`applied` both true, repeats". The plain §5.5 text (jev-on, no evidence) is unchanged.

**(c) code rule `novelVerifiedPatch`** (`risk.ts`; `AssessOptions.novelPatch`): a change proposal whose
`evidence.verified` is true with no `newlyFailing` and whose content differs from every *applied* earlier patch is gated
by `destructive`/`irreversible` alone — the Fix 2 mechanism exactly (alignment dimensions recorded in `dims` and in the
reason `…; verified novel patch (evidence verified, no regressions, content differs from every applied earlier patch;
N earlier patches this run): out_of_scope 0.52 (dominant level 0), plan_mismatch 0.50 (dominant level 0) recorded, not
gating`, harm dims at expected level ≤ 1 required). **One deliberate reading of the brief:** "differs from every prior
patch" is measured against the *applied* earlier patches, not the refused ones — a blocked or declined proposal never ran,
so re-proposing it is not repeating a failure (the rubric already says so), the rule's verdict is a function of the facts
so an identical re-proposal cannot pass on facts that failed it before, and the loop detector's `patch:` signature still
trips on the third identical proposal. An identical re-proposal of an *applied* patch (`sameContent` and `applied`) keeps
the full gating and Jev's level-4 answer blocks it as before.

Offline (`node node_modules/.bin/tsx .scratch/django-15315-reassess.mts`): re-assessing steps 5–10 from their recorded Jev
answers reproduces the recorded verdicts exactly without the rule (block 0.83/0.85, review 0.52/0.34, block 0.86/0.84)
and gives `ok 0.25` for all six with it (destructive expected 0.99–1.00, irreversible 0.00–0.01, both ≤ 1); step 11's
executed E stays `ok 0.25`. Through `PatchHistory` on the same sequence (unit test `risk.test.ts` "the history"), B at
step 5 sees `[{ step 3, applied true, result not_fixed, goalHeld false, sameContent false, runAfter { step 4, 328 passed,
allPassed true } }]` and is novel; B re-proposed at 6 sees A plus `{ step 5, status blocked, result refused, sameContent
true, applied false }` and is still novel; A re-proposed identical is not.

Tests: `risk.test.ts` "item 3" (patchSites; the django history sequence; `classifyPatchResult` per result; the identical
applied patch still blocked / the novel verified patch with plan_mismatch {0: 0.5, 4: 0.5} `ok` / harm still gates / the
rubric clause present only in the evidence texts; the state block for patches only and the per-runId reset).

**Live (`bench/results/jev-only-swebench-2-15315`, run `20260920-232313-4efaufma`, `--spend-cap 0.3 --max-steps 20
--max-wall 20m`, jev-only):** **no pass**, 20 steps, `max_steps`, **0 blocked / 0 declined** (the oracle run: 6 refusals
through step 11), Jev $0.0694, wall 864 s. Nine *different* verified patches executed (steps 3, 5, 7, 9, 11, 13, 15, 17, 19;
content hashes all distinct; sites `reverse_related.py:136/137/139`, `__init__.py:547/548`), every one with `evidence
verified: 328→329 of 357, no regressions` and the reason suffix `verified novel patch (…; N earlier patches this run):
out_of_scope … plan_mismatch … recorded, not gating`, each followed by the workspace regression run (328 passed, `exit 0`,
`task_complete` 0.12–0.35). The rule did what it says — the loop-side refusal class is gone — and the task still fails
for the reason `priorPatches[].result = not_fixed` names at every step from 5 on: each patch's shadow gain
(`repro::e7fbbfa8` newly passing) did not hold when the next proposal re-baselined the same suite (`before` stayed
328/357), i.e. the synthesizer's shadow verification and the workspace disagree on the reproduction, nine times over
different edits. That is search/oracle-side (the reproduction script's criterion, or the shadow copy's state), not a loop
rule. Two side observations for the owners: the identical green regression run tripped `run:17bf4f63a217:868bfee22d9a`
three times (steps 6, 12, 18 → 3 replans, `change_approach`) — a *green* verification run repeating the same result after
different patches is the §6 `run:` rule working as specified, but on this task it only perturbed the search; and a
contemporaneous control: another session's SWE-bench bench (process started before these edits, run
`20260920-232449-zgre63ri`, same synth WIP, started 23:24) ran the same task with the old risk stage and blocked four
verified patches at steps 3–6 (0.72/0.87/0.86/0.83) before reading files — the same refusal class this item removes.

### 17.5 File:line index and gates

- `src/loop/loopdetect.ts:44-49` (`SignatureInput.testRunner`), `:89-97` (the `fail:` branch), `:108-207`
  (`failingTestIds`, `testFailureIdentity`), `:208-217` (`patchContentHash`, shared with item 3).
- `src/loop/state.ts:305-395` (item 2: `ExecutedInfo.lastRunOutput`, `commonLastRun`, `recentOutputAt`,
  `doneExecutedJson`; the `buildJudgeState` noop branch at `:408`), `:292-358` (item 3: `PriorPatch*`,
  `priorPatchesJson`, `isChangeAction`, `buildRiskState`'s optional `priorPatches`).
- `src/loop/stages/complete.ts:6-10,18,22,25` (the `executed.lastRun` wording and example).
- `src/loop/stages/risk.ts:20-27` (header), `:101` (rubric clause), `:191-201` (`AssessOptions.novelPatch`),
  `:257-295` (the harm-only gating for `verificationRun` / `novelPatch` and the reason suffix), `:297-463`
  (`PatchHistory`, `patchSites`, `classifyPatchResult`, `createPatchHistory`, `novelVerifiedPatch`, `patchHistoryFor`),
  `:486-507` (`RiskStageOptions.patchHistory`, the stage wiring).
- `docs/DESIGN.md:1003-1016` (§6, dated paragraph on the `fail:` identity).
- Tests: `test/unit/loop/loopdetect.test.ts:50-116`, `state.test.ts:58-76,92-150`, `engine-loop-fixes.test.ts:66-90`,
  `risk.test.ts:202-330`. Gates after the last change: `tsc` clean outside `src/synth`/`src/bench`/`test/unit/synth`
  (other sessions' WIP), `no-any` ok, `test/unit/loop` + `test/unit/core` 22 files / 180 tests green.
- Not applied (engine owned by a peer session), 3-line diff described in §17.1; `git commit` not run.
- Scratch: `.scratch/ladder-6-replay.mts` (offline replay), `.scratch/ladder-6-table.py` (the §17.3 columns),
  `.scratch/django-15315-reassess.mts` (the recorded-answer re-assessment), `.scratch/django-steps.py` (per-step dump).

## 18. 2026-09-20 (later): introspected names and the history source — capabilities 2 and 3 of `swebench-reach-oracle-9.md` built; the test-passing candidate enters the set at the gold site on sympy-15345, sympy-17139 and django-15315 (F2P verified), +0 candidates on the 44 QuixBugs sites

Follow-up to `experiments/results/swebench-reach-oracle-9.md` ("Missing capabilities" items 2 and 3). Code proposes from facts
harvested in the workspace, Jev chooses among ≤ 255, tests verify. **Offline enumeration and F2P runs: $0.00.** One ranking
check with the real ranker: **$0.00145, 4 requests** (§18.4). Nothing under `src/synth/search/**`, `sieve/**`, `oracle/**`,
`core/**` or `loop/**` was edited; the controller wiring is the patch `.scratch/wiring-introspect-history.patch` (§18.5).

### 18.1 What was built

- **`src/synth/introspect/`** — the introspected-names pass. `script.ts` appends one pass to the oracle runner's own
  reproduction script (same namespace, NameError fix-ups and framework preamble as `oracle/runner.ts buildReproScript`):
  the target statement is the last one that raised (else the last with a value); a raising statement is run once more under
  `try` so the traceback's frames are live, and the innermost workspace frame, the frames Jev anchored (`OracleSearch.anchors`,
  matched by file suffix + function name, innermost first) and the next innermost (`FRAMES_MAX` 3) each have the dotted
  names of their source line evaluated in their own locals/globals (`OPERANDS_MAX` 8); a value statement has its
  sub-expressions evaluated in the script namespace. Per object: `type(obj).__mro__` class names, the public `dir(obj)`
  split into `is_*` predicates (properties that read as a bool / None, **with their truth value at the failing call**) and
  other attributes, `raisingReceiver` = an argument of the innermost raising frame; plus the public names of the raising
  (or callee's) module. `index.ts introspectRepro(run, spec, {workspace, python, anchors})` runs it through the same
  `VerifyRunFn` the oracle uses (the engine's sandbox), `namesFromRaw` caps the lists (classes ≤ 60, predicates ≤ 120,
  attributes ≤ 160, module names ≤ 60, **total ≤ 400**), `vocabularyAdditions(names, file)` = the flat names ∪ the
  `<prefix><Class>` names the file's own dispatch convention composes (`prefixes.ts classMethodPrefixes`: the prefix ending
  in `_` shared by ≥ 2 methods of a class with a CapWord suffix — `_print_`, `visit_`, `_eval_`; accessor pairs `get_a`/`get_b`
  do not count). `facts.ts` is the per-run registry (`setRunFacts` / `runFacts`, like `memory.ts getMemory`).
- **`src/synth/templates/introspect.ts`** — two productions in a new family `introspect` (prior 0.85, `common.ts
  FAMILY_PRIOR` / `TEMPLATE_FAMILIES`, `index.ts FAMILY_FN` / `familyOf`), inert without `EnumerateOptions.introspected`:
  `attribute_predicate_guard` = `if not <subject>.<is_attr>:` / `<sibling return>` before the guarded statement, subject = an
  operand of the raising line whose root name is in scope at the site, predicates the introspection read on that very object
  (falsy ones first — `if not x.<p>:` fires on the failing input for exactly those; truthy ones in the positive form), bodies
  the function's first `returnDefaults` (≤ 3) and `continue` in a loop, ≤ 150 drafts; `mro_method_alias` = `<prefix><MroClass>
  = <existing method>` at a class-body gap, or appended after the last line of a method at the class indent, for every MRO
  class the class does not handle yet × every prefixed method (the one ending just before the site first), ≤ 254.
- **`src/synth/history/`** — the `history` source. `harvest.ts harvestHistory(run, {workspace, files, task, identifiers,
  sources})`: ticket / PR numbers the issue names (`#31750`) → `git log --fixed-strings --grep`, commit hashes → `git log -1`,
  the localiser's `taskIdentifiers` (those the localised files contain first, longest first) → `git log -S<ident> -n 5`, then one
  `git show -U3` over the ≤ 5 most recent commits; **≤ 8 read-only git commands, 10 s each**, all through the sandbox `run`;
  the diff is split into contiguous change runs with 3 context lines each side (`parseShowDiff`). `source.ts
  createHistorySource()`: the reverse of each run whose added lines are still in the site's file (located by exact, then
  whitespace-insensitive sequence match, nearest the commit's own line) becomes one replace candidate (removed lines back,
  `delete` extraEdits for the rest; a pure addition becomes a deletion), a run whose lines were only removed comes back as an
  insert after its leading context; runs farther than 80 lines from the site and outside its block are not offered; ranked by
  distance then commit recency; ordinary `Candidate`s with `source: 'history'` and a `provenance` line
  (`reverse of <sha> "<subject>" (ticket:#31750)`).
- **`src/synth/types.ts`** (additive, optional): `EnumerateOptions.extraNames`, `.introspected`, `.history`;
  `Candidate.provenance`.
- **Tests** (`npx vitest run --project unit test/unit/synth/introspect test/unit/synth/history test/unit/synth/templates`: 10
  files, 95 tests green with the leakage test): `test/unit/synth/introspect/introspect.test.ts` (script + parser, caps, prefixes,
  registry, one real `python3` run on a fixture with `is_*` properties and a class hierarchy), `test/unit/synth/history/
  history.test.ts` (refs, identifier ranking, diff runs, harvest against a real temporary git repository through a
  sandbox-shaped `run`, the three reversal shapes applied with `verify/apply.ts`), `test/unit/synth/templates/introspect.test.ts`
  (inert on QuixBugs sites, the guard and alias shapes, caps, `familyOf`, and the **leakage guard**: `INTROSPECT_EXAMPLES`
  against the whole `benchmarkCorpus()` and the module texts of the new sources against the gold-fix lines of bench/data).
- **Scripts**: `experiments/reach/introspect-history.mts` (the measurement below; `--quixbugs` for §18.3),
  `experiments/reach/introspect-rank.mts` (§18.4); outputs under `experiments/reach/out/introspect-*.json`, logs
  `log-introspect-*.txt`.

### 18.2 Measured at the gold sites ($0, `introspect-history.mts`, sites built as `reach-oracle-9.mts` builds them, ENUMERATE_CAP 254)

The reproduction is rebuilt from the issue text as the oracle does (block 0, `chunksWithContext`; Jev's judged failure kind
and anchors read back from `experiments/oracle/results.json`, no request); introspection and history run in the base worktree
with the bench venv; the corpus is the engine's 400-file cut plus the gold file; "gold hit" = the candidate's applied file
equals the gold-patched file, code tokens per line (for sympy-15345 the alias hunk alone, which `hunk-subsets` showed
test-equivalent). F2P = the found candidate applied to a private worktree with the test patch, run with the bench venv.

| instance | capability | candidate found | index (source list / SEEDS list) | site count before → after | vocab missing before → after | F2P pass |
| --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-15345 | introspected names (`mro_method_alias`) | **yes** `_print_MinMaxBase = _print_Function` at the class-body gap `mathematica.py:104` | template **14** of 130 / SEEDS #268 (mutation 254 first) | 413 → 543 (mutation 254, templates **0 → 130**, donor 159) | `["_print_MinMaxBase"]` → `[]` | **pass** `test_Function`, 5.9 s |
| sympy__sympy-17139 | introspected names (`attribute_predicate_guard`) | **yes** `if not rv.exp.is_real:` / `return rv` at the gap `fu.py:503` | template **50** of 254 / SEEDS #304 | 612 → 772 (mutation 254, templates **104 → 254** (+150), donor 254, history 10) | `["is_real"]` → `[]` | **pass** `test__TR56` and `test_issue_17137` (run individually, 0.2 s + 2.1 s) |
| django__django-15315 | history (`history_revert_change`) | **yes** `return hash(self.creation_counter)` replacing `__init__.py:545–549` | history **0** of 4 / SEEDS #113 | 367 → 371 (mutation 21, templates 92 → 92, donor 254, history **4**) | `[]` → `[]` | **pass** `test_hash_immutability`, 1.0 s |

Per instance:

- **sympy-15345**: introspection ran in 916 ms on `mathematica_code(Max(x,2))` (a value statement): operands `Max` (the class),
  `x` (Symbol: 56 predicates, 52 falsy), `Max(x, 2)` (Max → `[Max, MinMaxBase, Expr, LatticeOp, AssocOp, Application, Basic,
  EvalfMixin]`, 56 predicates), the `str` result; module `sympy.printing.mathematica` (8 names); 185 names in total. At the
  class-body gap the templates went from **0** to 130, all `mro_method_alias` (13 classes × 10 `_print_*` methods), and the
  gold alias is #14 (the method order puts `_print_Integral`, which starts right after the gap, before `_print_Function`, which
  ends two lines above it; `_print_Max = _print_Function` is #0). At `replace@102` (the method's last line) the `after_dedent`
  form lands at #15 of 254. The queue's vocabulary rejected `_print_MinMaxBase` before ("nowhere (new name)" in the reach
  study) and accepts it with `extraNames` (the composed `_print_` + MRO names). F2P: the alias alone passes `test_Function`.
- **sympy-17139**: introspection ran in 1,403 ms; the traceback has 15 workspace frames; the chosen three are `__lt__`
  (`expr.py:406`, the raise), `_f` (`fu.py:504`, Jev's 0.96 anchor) and `_TR56` (`fu.py:524`). Operands: `me` and **`rv.exp`**
  (both `ImaginaryUnit` → `[ImaginaryUnit, AtomicExpr, Atom, Expr, Basic, EvalfMixin]`, **63 predicates, 54 falsy, receiver** —
  the same object as `self` in the raising `__lt__`), `rv` (Pow, 63 predicates) twice, `TypeError`, `complex`; module
  `sympy.simplify.fu` (60 names); 199 names. At the gap the guard production adds exactly its 150-draft cap (all
  `if not rv.exp.is_*: return rv` first — the receiver's falsy predicates in alphabetical order — then `rv`'s); the gold guard is
  #50 (`is_real` is the 50th falsy `is_*` name of `I`), and at `replace@504` (the raising line) the `_before` form is #63. The
  vocabulary check dropped `is_real` before (in 45 repo files, none of the 400 loaded, never in `fu.py`) and accepts it now.
  History found 5 commits / 117 change runs via `-Sbottom_up` / `-S_TR56` (20 s of git) and offered 10 reversals at the site,
  none the fix (noise, ranked after the templates). F2P: both tests pass with the guard.
- **django-15315**: the issue names `#31750`; `git log --grep='#31750' -- django/db/models/fields/__init__.py` returns
  `502e75f9ed` ("Fixed #31750 -- Made models.Field equality compare models for inherited fields.") in 1.7 s of git (7
  commands: 1 ticket + 3 `-S` (`max_length`, `CharField`, `__hash__`; `__hash__` found 2) + 1 `show` — the `-S` queries that
  took 64 s on this partial clone in the reach study were cut by the 10 s timeout, the ticket query is what finds the commit).
  Its diff splits into 4 change runs (`__eq__`, `__lt__` ×2, `__hash__`); the `__hash__` run's added lines are still verbatim at
  545–549, so its reverse is a replace at 545 (`return hash(self.creation_counter)`) with 4 `delete` extraEdits: history
  candidate **#0** (distance 0 to the site), the only one of the 4 that equals the gold file. The statement-level site of item 4
  is not needed for this case: the reversal carries its own deletes. The introspection pass ran (664 ms) but the target is an
  `assert` that raised in the snippet itself — no workspace frame, no operand (an `assert` has no `.value`), 0 names: correctly
  inert. F2P: `test_hash_immutability` passes.

### 18.3 QuixBugs: +0 candidates on 44 sites (`introspect-history.mts --quixbugs`, $0)

The 40 `bugLine` replace sites plus the four insertion gaps of `test/unit/synth/templates/quixbugs.test.ts`, templates
enumerated without introspection and with a **real** introspection of the first JSON test call (`import json; from <p> import
<p>; <p>(*json.loads(…))` in `bench/data/quixbugs/programs`, `python3`, 8 s): **5,573 → 5,573 candidates (+0, 0.0 %)**. The pass
ran on 31 sites (2 timeouts — `bitcount`, `sqrt` loop forever on the buggy program; 11 pytest-style graph programs have no JSON
repro and stay inert); the operands are `list` / `int` / `str` / `bool` / `generator` objects (0 `is_*` predicates: `str.isdigit`
and friends are methods, not properties) and no QuixBugs program defines a dispatch-prefixed class, so both productions emit
nothing — the inertness is by construction of the facts, not a switch.

### 18.4 Ranking check with the real ranker (`introspect-rank.mts`, `typesafe/jev-1.13-20260917`, $0.00145, 4 requests)

The template set at each gap with the introspection facts, `createRanker({stage:'propose'}).rank(cands, {task, failures,
functionListing})` (two-stage: compact Nouls + shortlist Choice; the SIEVE would run these sets on the 15345 oracle, t_run
1,161 ms, and RANK on 17139's 2,169 ms):

| instance | candidates (introspect) | gold at enumeration index | Jev rank of the gold | top-5 |
| --- | --- | --- | --- | --- |
| sympy-15345 | 130 (130) | 14 | **#4**, p 0.10 (escape 0.15) | `_print_Max = _print_Function` 0.41, `_print_LatticeOp = _print_Function` 0.13, `_print_Max = _print_list` 0.12, `_print_MinMaxBase = _print_Function` 0.10, `_print_LatticeOp = _print_list` 0.09 |
| sympy-17139 | 254 (150) | 50 | **#1**, p 0.48 (escape 0.02) | `if not rv.exp.is_real` 0.48, `if not rv.exp.is_comparable` 0.30, `if not rv.exp.is_extended_real` 0.12, `if not rv.is_comparable` 0.07, `if not rv.exp.is_integer` 0.01 |

On 17139 Jev puts the gold guard first among 254 with the two semantically nearest predicates (`is_comparable`,
`is_extended_real`) behind it. On 15345 the top pick `_print_Max = _print_Function` aliases the concrete class rather than the
base; it dispatches identically for `Max` (the printer looks up `_print_` + each MRO name) and is the natural k = 3 companion
of the gold at #4 — not F2P-verified here.

### 18.5 Wiring (patch, not applied) and caveats

`.scratch/wiring-introspect-history.patch` (192 lines; regenerated by `.scratch/wiring/make-patch.py --check`, which also
typechecks patched twins of both files and deletes them) against the current `src/synth/search/index.ts` and
`src/synth/index.ts`:

- `search/index.ts`: a private `harvestFacts(ctx, repo, anchors, moduleFiles, files)` called at the end of `initRepository`
  (with `found.anchors`) and on the checkpoint-restore branch of `rebaselineRepository` (anchors re-read from
  `repo.traceback` by the exported `framesOfTraceback`); it runs `introspectRepro` when a reproduction exists (workspace venv,
  ≤ 60 s) and `harvestHistory` over `repo.moduleFiles` with `taskIdentifiers(ctx.task)`, emits `introspect` / `history` synth
  events, and stores both in `setRunFacts(ctx.runId, …)`. Never fatal.
- `synth/index.ts`: a module-level `runFactsRef` refreshed from `runFacts(ctx.runId)` in `createQueue` (start of every sub-goal
  search) and `locate`; `enrich(site, opts)` adds `introspected` / `history` / `extraNames = vocabularyAdditions(…, site.file)`;
  the template seed is wrapped to enumerate with the enriched options; the history source **rides with the donor seed** (its
  reversals first, then donors, capped at `opts.cap`) because `subgoal.ts orderSources` has no slot for §3's last row and
  `SubGoalDeps.seeds` is a fixed record — both keep their own `source` name for the trace (`emptyBySource` already has a
  `history` row) and the queue's prior; composite pairs over the wrapped seeds; `createQueue` builds each file's vocabulary as
  `vocabularyOf(...) ∪ vocabularyAdditions(introspected, file)` so `missingNames` accepts what the productions write.

Caveats: (1) localisation builds no class-body or module-level gap sites (`search/sites.ts` has slot builders for function
gaps only), so in a live run the alias reaches the fix through the `after_dedent` form at the aliased method's last line
(#15 at `replace@102` here) unless a class-body gap becomes a site; (2) the history `-S` queries can hit the 10 s bound on
partial clones (measured 64 s once); the ticket / hash query is the cheap one and found the commit; (3) the SEEDS index in the
table counts the mutation list first — the queue orders by source prior and p, not by this index; (4) the sympy `bin/test -k
A -k B` form of `experiments/reach/lib.mts f2pCommand` honours only the last `-k`, so 17139's F2P was confirmed with one run
per test; (5) `Site.endLine` (another agent's statement-level sites) is honoured by the alias placement but not otherwise
exercised here.

### 18.6 Exact commands

```
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs
npx vitest run --project unit test/unit/synth/introspect test/unit/synth/history test/unit/synth/templates
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/reach/introspect-history.mts              # 3 instances, ≈ 4 min, $0
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/reach/introspect-history.mts --quixbugs   # 44 sites, ≈ 2 min, $0
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/reach/introspect-rank.mts                 # 4 requests, $0.00145
python3 .scratch/wiring/make-patch.py --check                                                                              # regenerate + typecheck the wiring patch
```

## 19. 2026-09-20 (later): the long-horizon ladder (tasks 13–20) — first runs; the ledger's chain is bounded by the lone partial

Eight long-horizon tasks were added to `bench/data/ladder` (tier `long`, ids 13–20 in selection order) to measure the
Jev-only agent's ability to **chain many verified sub-goals** (JEV-ONLY-DESIGN.md §2.1–§2.3: one goal per failing-test
cluster, one verified sub-goal per step, partials held as a second base) rather than its reach, and they were run live
three times today: run 1 (all eight, the controller before `1f7611e`), run 1b (four tasks re-authored after a reach
probe, same controller) and run 2 (all eight on the merged controller `d610d75`, §15). Headline: **2/8, then 3/8 solved**;
every miss but one is the same defect — a goal whose *first* correct fix can only be a **partial** (it passes some of the
goal's tests, never all) is never committed: `masked`, `long_chain` and the merged goals of `shared_frame` and
`six_hunks` all found the gold line, ranked it first, ran it, classified it `partial`, and parked. The design's own
fallback ("if `mem.bases` has an improved base for this goal: commit it as a partial", §2.3) is unreachable in practice
because every step of these goals ends on `budget` and the park comes first. The other classes are smaller and named
below. Data and code paths are listed in §19.8; nothing here was committed.

### 19.1 What was added (bench/data/ladder, src/bench/ladder, test/unit/bench)

- `bench/data/ladder/tasks/<name>/` for `crossfile`, `import_and_guard`, `ledger5`, `long_chain`, `masked`,
  `regress_trap`, `shared_frame`, `six_hunks` — the usual layout (task.md, meta.json, pytest.ini, src/, tests/, gold/),
  3–6 modules and 22–30 tests each; `meta.json` gains `tier: "long"` and `expected_failing` (the buggy tree's exact
  failing set). The original twelve are untouched. `index.json` lists the twelve, then the eight (alphabetical within
  the tier).
- `src/bench/ladder/tasks.ts`: `LadderMeta.tier` (`short` default) and `expectedFailing`, validated (`tier long
  requires expected_failing`, ids must be `tests/<file>.py::<test>[…]`, no duplicates); `parseIndex` returns records
  **short tier first, then long**, stably, so `bench --suite ladder --tasks 12` still selects exactly the original
  twelve in their order and `--tasks 13` adds `crossfile`; `--task-id` works for all 20.
- `bench/data/ladder/check.py`: per-tier limits (short 4–10 tests / gold < 2 s; long 20–60 / < 3 s), `expected_failing`
  compared with the buggy run's `FAILED`/`ERROR` ids, index order = short-by-name then long-by-name, a tier column.
- `test/unit/bench/ladder-long.test.ts` (16 tests with `ladder.test.ts`): meta validation and tier ordering on
  fixtures; on the real data: all 20 load in the expected order, `selectSources({tasks: 12})` is the original list,
  every gold diff `git apply --check`s onto a copy of `src/` and yields `gold/`, and (with
  `~/.jevcode/runs/ladder-venv/bin/python` or a pytest-importing `python3`, else skipped) a real pytest run of every buggy
  tree fails exactly `expected_failing` and every gold tree is green. `ladder.test.ts`'s fixture assertion gained
  `tier: 'short'`. Gates: `tsc --noEmit`, `scripts/no-any.mjs`, the two test files, `check.py` over all 20 — all green
  on the ladder files (the main checkout's tsc/no-any failures are in other owners' in-progress `src/synth/verify`,
  `test/unit/session`, `tui` and `cli` files).
- README: "The long tier" section (table, ordering rule, verification, the `-q` note below).

| # | task | hunks | modules | failing / total | measures | the bugs (each a one-line replace, or the two-line guard the template emits) |
|---|---|---|---|---|---|---|
| 13 | `crossfile` | 4 | fmt, invoice, tax, discount | 8 / 25 | a coordinated pair across two files + 2 independent bugs | `money` reads its symbol under `CURRENCY_KEY` for `SYMBOL_KEY`; `invoice.render` builds its options under `CURRENCY_KEY` too; either alone regresses two invoice tests, a definition reading both keys fails `test_money_ignores_currency_option`; `tax_for` `<=` for `<`; `apply_discount` `not in` for `in` |
| 14 | `import_and_guard` | 4 | paths, settings, retry, duration | 12 / 23 | two inserts + two replaces | missing `import re` (NameError at call time); `Settings.get` lacks `if value is None: return default` (siblings have it); `schedule` `range(1, attempts + 1)`; `parse_duration` `+` for `*` |
| 15 | `ledger5` | 5 | isbn, loans, search, shelves | 12 / 30 | pure chain length, five independent goals | ISBN-10 weights `9 - i` for `10 - i`; `is_overdue` `>=`; `fine` `max` for `min`; `rank` `reverse=False`; `label` `number = position` for `position + 1` |
| 16 | `long_chain` | 6 | load, clean, enrich, totals, layout, report | 16 / 26 | progress one stage at a time | one exception per stage (`float(kind)`, `row.label`, `LABELS[row.name]`, `kv[2]`, `lines.add`, `SEPARATOR`); all 16 pipeline tests start in one goal at `load.parse_row`; cumulative fixes 16 → 13 → 10 → 6 → 4 → 2 → 0 |
| 17 | `masked` | 3 | report, aggregate, parse (+ levels) | 6 / 22 | re-clustering the same tests twice | all six report tests fail at `parse_lines(txt)` (NameError); fixed, two pass, two move to `parse.parse_line` (`int(took[:-1])`), two to `aggregate.total_ms` (`e.took`); the callee bugs have no direct tests |
| 18 | `regress_trap` | 4 | agenda, roster, intervals, names (+ slots) | 7 / 28 | regressions never kept | `Item.span` off by one — flipping `<`→`<=` in `intervals.contains`/`overlaps` passes the agenda tests and breaks the half-open semantics pinned by `test_intervals`/`test_slots`; `badge` `[:1]` vs shortening `initials`; plus `merge` `<` and `surname` `parts[0]` |
| 19 | `shared_frame` | 2 | booking, pricing (+ checks, schedule) | 6 / 25 | the `account` partial trap | both bugs raise `InvalidValue` at `checks.py:15` (`ensure_at_least`), one merged goal of six tests; each fix alone is a partial with a disjoint newly-passing set; `test_checks` pins the helper |
| 20 | `six_hunks` | 6 | model, filters, sorting, render, stats | 9 / 28 | goals with two complementary partials | three parametrised integration tests (`a_only`/`b_only`/`both`) over pairs of data-dependent bugs; per-module tests cover only the unaffected inputs |

### 19.2 Verification

`check.py` (the venv python 3.9.6 / pytest 8.4.2), the eight long rows; `buggy`/`gold` are passing/total, each hunk
alone shows the hunks are independent where designed and complementary where designed (`shared_frame`,
`six_hunks`: every single hunk is a strict partial; `crossfile` h1/h2 alone regress):

```
task              tier  hunks dfclt tests   buggy    gold  each hunk alone (passed/total)                       gold s  ok
--------------------------------------------------------------------------------------------------------------------------
crossfile         long      4     5    25   17/25   25/25  h1:18/25 h2:15/25 h3:19/25 h4:20/25                    0.69  yes
import_and_guard  long      4     4    23   11/23   23/23  h1:15/23 h2:13/23 h3:14/23 h4:14/23                    0.53  yes
ledger5           long      5     4    30   18/30   30/30  h1:21/30 h2:20/30 h3:21/30 h4:20/30 h5:20/30           0.63  yes
long_chain        long      6     5    26   10/26   26/26  h1:13/26 h2:10/26 h3:10/26 h4:10/26 h5:10/26 h6:10/26   0.43  yes
masked            long      3     4    22   16/22   22/22  h1:18/22 h2:16/22 h3:16/22                             0.34  yes
regress_trap      long      4     4    28   21/28   28/28  h1:24/28 h2:23/28 h3:22/28 h4:22/28                    0.48  yes
shared_frame      long      2     4    25   19/25   25/25  h1:21/25 h2:23/25                                      0.32  yes
six_hunks         long      6     5    28   19/28   28/28  h1:20/28 h2:20/28 h3:20/28 h4:20/28 h5:20/28 h6:20/28   0.25  yes
```

Designed behaviours, checked with single-fix / cumulative-fix / wrong-fix trees (`/tmp/ladder-long/stages.py`):
`masked` fix A alone → two tests pass, two move to `aggregate.py:19 <genexpr>`, two to `parse.py:21 parse_line`;
`shared_frame` h1 alone 21/25, h2 alone 23/25, relaxing the helper's `<` breaks `test_checks`/`test_booking` instead;
`crossfile` definition alone 18/25 with two invoice regressions, call site alone 15/25, the pair 20/25 clean, the
"read both keys" sidestep of run 1b fails the new pinning test; `regress_trap` `contains` flip passes 2 agenda tests and
breaks `test_contains_excludes_end` + `test_end_minute_is_free`, `overlaps` flip passes the clash test and breaks
`test_overlaps` + `test_can_book_touching_slot`, shortening `initials` passes both badge tests and breaks
`test_initials`; `six_hunks` each fix alone passes exactly its `*_only` case; `long_chain` 16 → 13 → 10 → 6 → 4 → 2 → 0
with the innermost frame moving load → clean → enrich → totals → layout → report.

**Reach probe** (`/tmp/ladder-long/probe.mts`, the `experiments/reach/probe-line.mts` recipe on each buggy line:
mutation, templates, donors, composite at `ENUMERATE_CAP` and uncapped, task-text identifiers and test literals as
vocabulary): **34/34 planted lines are produced by a code source** — 32 by a depth-1 mutation (8 `off_by_one_literal`,
7 `relational_swap`, 5 `identifier_substitution`, 4 `attribute_substitution`, 2 `off_by_one_atom`, 2 `arithmetic_swap`,
`keyword_flip`, `drop_term`, `call_substitution`, `argument_swap`; five also by a template or donor), the `import re` by
`import_insert_local`, the None-guard by `guard_none_return_alt_before` and a statement donor. **Run 1 did not have
this property**: six lines of the first authoring were out of reach and were re-authored before run 1b — an edit inside
an f-string (`ledger5` h5), a `"symbol"` string key and a keyword-argument name (`crossfile` h1/h2: now two identifier
swaps over module constants `SYMBOL_KEY`/`CURRENCY_KEY`, in the pool only through the task text), a `","` literal
(`long_chain` h1: now `float(kind)` for `float(price)`), an attribute used nowhere else in its file (`long_chain` h3:
`enrich.is_known` now uses `row.kind`), and a comprehension filter (`masked` h3: now `int(took[:-1])`; a `for`-loop
`if not line: continue` guard was tried first and is *not* what the guard template emits — its subjects are the
function's params/locals with `is None` / `not x` bodies of `return`, so the loop form is out of reach too). The run-1
misses of those four tasks are therefore partly `reach` by authoring and are marked so.

**`pytest -q` and the engine.** The long-tier `pytest.ini` carries no `-q`: the engine runs `python3 -m pytest -q`, with
the ini's own `-q` that is `-qq`, which drops the `N failed, M passed in …` line; `parseTestOutput` then reads the last
16 KB of the output (`tests.ts` `TAIL_CHARS`) for the progress line, and a 16-failure suite's tracebacks push that line
out. Run 1 `long_chain` (run `20260920-230739-j2nvsvmz`, 21 s, $0.0117) never registered its establishing run: the
synthesizer's own baseline read 9/25 but the engine's `judge.tests` was `judged` at every step, the `run` repeated
(`loop tripped: run:1038c0db4e6f x3` ×6), five `gather_context` replans said "nothing to change", `max_replans` at
step 18 with no search ever started. The short tier keeps `-q` (its outputs are small).

### 19.3 Run 1 — all eight, controller before `1f7611e` (22:45Z, `bench/results/jev-only-ladder-long-1`, $0.2461)

| task | hunks fixed (patch vs gold) | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | run id |
|---|---|---|---|---|---|---|---|---|---|---|
| `ledger5` | 0/5 (patch-noapply) | no | 30 | `max_steps` | $0.0410 | 739 s | 300 | 12/12 | 4/4 | `20260920-224503-27zwcaat` |
| `masked` | 0/3 (-) | no | 20 | `max_replans` | $0.0290 | 412 s | 188 | 11/8 | 6/5 | `20260920-224503-5qnbdmhr` |
| `shared_frame` | 0/2 (-) | no | 17 | `max_replans` | $0.0326 | 409 s | 196 | 9/8 | 6/5 | `20260920-225156-r26pz357` |
| `crossfile` | 1/4 (h3) | no | 20 | `replan_stop` | $0.0550 | 554 s | 299 | 8/7 | 5/4 | `20260920-225722-aofehycx` |
| `import_and_guard` | 3/4 (h1, h2, h4) | **yes** | 13 | `complete` | $0.0097 | 166 s | 97 | 0/0 | 0/0 | `20260920-225846-d42ifdun` |
| `regress_trap` | 4/4 (h1, h2, h3, h4) | **yes** | 26 | `replan_stop` | $0.0318 | 365 s | 226 | 5/5 | 5/4 | `20260920-230133-w3afeezp` |
| `six_hunks` | 2/6 (h3*, h4) | no | 24 | `max_replans` | $0.0354 | 385 s | 225 | 12/10 | 6/5 | `20260920-230637-ukxpiavi` |
| `long_chain` | 0/6 (-) | no | 18 | `max_replans` | $0.0117 | 21 s | 77 | 0/0 | 6/5 | `20260920-230739-j2nvsvmz` |

`*` = the bug is neutralised by a test-equivalent edit that is not the gold line. Per miss:

- **`ledger5` (miss, 27/30 at `max_steps`) — budget park + churn.** Twelve assertion-failing tests → twelve one-test
  goals (assertion frames are keyed by test function, goals.ts). Four commits in 30 steps: `shelves` (`position += 1`
  inserted, step 10), `loans.fine` (gold `min`, step 20), `search.rank` (`return hits`, step 22 — an overfit the tests
  then allowed; `test_search.py` now orders its inputs so that `hits` unsorted fails), `loans.is_overdue`
  (`return min(0, (due - today).days)` inserted, step 27/28 — declined once at risk 0.30 "review" with no reviewer, then
  executed). The three `isbn` goals never closed: `where`=`isbn10_check_digit` 0.99 and `buggy_line`=line 15 at steps
  12–13, the gold `(10 - i)` ranked first (p 0.51) at step 16 in a step that ended on `budget` (668 runs, mostly
  `regressed`); 12 declined + 12 blocked steps (reads at "review" risk, partial `done`s).
- **`masked` (miss, 0/3) — lone-partial trap, with a NameError insert-site detour.** One goal (six tests at
  `report.py:14`). Step 4: the NameError's missing name `txt` makes `sites.ts` add an import gap, and the first `fix`
  question was an *insertion* ("the missing statement that, inserted immediately after …"); Jev put `entries =
  parse_lines(text)` first (p 0.72) as an insert, which leaves the buggy line executing (5 tested, all `unchanged`).
  Steps 7, 13, 16: the replace-site gold was enumerated and tested — `64 tested (57 unchanged, 7 partial)`,
  `48 (46 unchanged, 2 partial)`, `9 (1 partial, 8 unchanged)` — a partial because A alone passes only the two
  empty-input tests; each step ended on `budget`, the goal was parked (steps 7, 10, 16) and the partials went with it
  (pre-`1f7611e` `forgetGoal`). Eight declined reads, five replans, `max_replans`.
- **`shared_frame` (miss, 0/2) — budget park on top of the designed trap.** One merged goal of six tests at
  `checks.py:15`. Localisation was right every time (`where` `reserve` 0.83–0.86 / `total` 0.73–0.77, `buggy_line`
  line 29 0.85–0.93). 922 candidates ran at step 11 in SIEVE mode — 12–149 `regressed` per batch (mutations of the
  shared helper, never kept) — and the gold booking line was ranked first (p 0.80) only in the 8th of the step's 12
  `fix` questions, then reappeared untried in the 9th; five "nothing ran, test wall left 0 s" batches closed the step;
  had it run it would have been a partial (2 of 6). Parked, eight declined reads, blocked partial `done`s, `max_replans`.
- **`crossfile` (miss, 1/4) — reach (authoring) + one-test-goal localisation.** Seven one-test goals. Only `tax` closed
  (gold `<`, step 6). The pair never existed as candidates (string key / kwarg name: out of reach; fixed in 1b). The
  `discount` gold (`not in`→`in`, a `relational_swap` at index 0) never appeared in a `fix` question: at steps 3–4 the
  `buggy_line` for `apply_discount` was `none_of_these` (0.78/0.84), the budget went to 1,487 runs of `regressed`
  candidates elsewhere, and by step 16 the discount goals were "exhausted … at 12 sites" that were all `fmt.py`/
  `invoice.py` gaps — re-localised into the wrong files by `gather_context`.
- **`import_and_guard` (solved, 13 steps, $0.0097, 0 blocked/declined).** The intended shape of the tier: four goals
  closed in order `import re` (template `import_insert_local`, 11→15), the None-guard (`guard_none_return_alt`,
  15→17), `schedule` (`attempts -= 1` inserted — test-equivalent, not the gold `range(1, attempts)`), `parse_duration`
  (`arithmetic_swap`, 20→23), one `patch → run` pair each.
- **`regress_trap` (solved, 26 steps, 4/4 gold-identical).** `merge` (step 4), `surname` (8), `badge` (12) and, after
  two budget steps whose batches held only `regressed` verdicts for the agenda goal (`9 unchanged, 4 regressed` /
  `8 unchanged, 2 regressed` — the `contains`/`overlaps` flips, never kept), `Item.span` (`off_by_one_atom`, step 22,
  WIDENED). Three `done`s at steps 24–26 then `replan_stop` (the §17 no-op-`done` behaviour).
- **`six_hunks` (miss, 2/6) — one pair committed, two goals parked with partials in hand.** Goal `test_board` closed at
  step 10 as `composite/pair_of_partials at sorting.py:18` (`t.due == None` + the render `width - 3`: the pairs source
  worked once, exactly as designed). Goal `test_attention`: `1 partial` (step 4), `1 / 2 / 1 / 10 partial` (step 7),
  budget, parked with two budget hits; goal `test_summary`: SKETCH/SIEVE budget, parked. Blocked partial `done`s,
  `max_replans`.
- **`long_chain` (miss, 0/6) — the `-qq` gap above; no search ran.**

### 19.4 Run 1b — the four re-authored tasks, same controller (23:22Z, `bench/results/jev-only-ladder-long-1b`, $0.1759)

| task | hunks fixed (patch vs gold) | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | run id |
|---|---|---|---|---|---|---|---|---|---|---|
| `ledger5` | 3/5 (h1, h3, h4) | **yes** | 27 | `complete` | $0.0366 | 680 s | 252 | 4/4 | 3/3 | `20260920-232221-b2a7cqua` |
| `masked` | 0/3 (-) | no | 17 | `max_replans` | $0.0305 | 498 s | 195 | 8/7 | 6/5 | `20260920-232221-azpvds2z` |
| `crossfile` | 2/4 (h3*, h4*) | no | 30 | `max_steps` | $0.0802 | 859 s | 423 | 4/1 | 5/5 | `20260920-233040-eww6zglo` |
| `long_chain` | 0/6 (-) | no | 19 | `max_replans` | $0.0286 | 323 s | 178 | 5/3 | 6/5 | `20260920-233343-mq3dsvbs` |

- **`ledger5` (solved, 27 steps).** Five commits: `label` (`number += 1`-style statement, step 9), `isbn` (gold
  `off_by_one_literal`, step 12), `fine` (gold, 16), `rank` (gold `keyword_flip`, 21), `is_overdue` (test-equivalent,
  26). One goal parked at step 6 and reopened. With the f-string line gone the chain of five closes.
- **`masked` (miss, 0/3) — lone-partial trap again**: `64 tested (57 unchanged, 7 partial)` at step 3, budget, parked
  at step 6, WIDENED searches over 63–65 sites at steps 6/8/11/17 (2,663 candidates at step 8) never a passer.
- **`crossfile` (miss, 2/4, 22/24 at `max_steps`) — overfit to a one-test goal poisons the chain.** Now that the pair
  is in reach, the run localised it perfectly: at steps 4 and 6 Jev ranked *both* gold lines first (`fmt` 0.94/0.82,
  `invoice` 0.80/0.77) in the same steps — but the goals are per test, each half alone regresses the two invoice tests,
  and the pair source pairs *partials*, not two regressions; nothing was committed. At step 23 a `sketch_P11` line
  `symbol = options.get(SYMBOL_KEY, symbol)` was inserted after the buggy read (passes the two `fmt` goals by reading
  both keys; now rejected by `test_money_ignores_currency_option`). `discount` closed its one-test goal `test_flat_code`
  at step 13 with `key not in CODES` (identifier substitution: makes every code a flat code; passes `test_flat_code`,
  leaves `test_percentage_codes`/`test_best_code` failing and moves the true fix two edits away); `tax` closed with a
  composite `amount is not None and amount < TAX_FREE_BELOW`. 30 steps, $0.0802 (the most expensive run of the day).
- **`long_chain` (miss, 0/6) — lone-partial trap.** With the counts line back the search ran: `where`=`parse_row` 0.90,
  `buggy_line` line 20 p 1.00 (steps 4, 11, 14), the gold `float(price)` ranked first (p 0.96) at step 5 and tested —
  batches `188 unchanged, 6 partial` (step 4), `61 unchanged, 15 partial` … (step 5), `13 unchanged, 4 partial`
  (step 11) — a partial by construction (stage 1 passes 3 of the goal's 16 tests). Parked at step 5 ("2 consecutive
  budget-hit steps"), blocked partial `done`s, reopened three times, `max_replans` at 19.

### 19.5 Run 2 — all eight on the merged controller `d610d75` (23:46Z, from the `bench-clean` worktree, `bench/results/jev-only-ladder-long-2`)

**In progress at hand-back** (launched 23:46Z from `.claude/worktrees/bench-clean` at `d610d75`; log `/tmp/ladder-long/live-2.log`;
records land in `.claude/worktrees/bench-clean/bench/results/jev-only-ladder-long-2/tasks.jsonl`, run dirs under `~/.jevcode/runs/`;
load average 65–70 alongside another agent's QuixBugs bench). Finished so far:

| task | hunks fixed (patch vs gold) | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | run id |
|---|---|---|---|---|---|---|---|---|---|---|
| `ledger5` | 3/5 (h1, h3, h4) | **yes** | 28 | `replan_stop` | $0.0338 | 586 s | 231 | 1/1 | 4/3 | `20260920-234614-ql2ogigs` |
| `masked` | 0/3 (-) | no | 25 | `max_replans` | $0.0380 | 500 s | 235 | 9/1 | 6/5 | `20260920-234614-feogdtm5` |
| `shared_frame` | 0/2 (-) | no | 16 | `max_replans` | $0.0326 | 502 s | 201 | 3/2 | 6/5 | `20260920-235435-aoomkygm` |
| `import_and_guard` | 3/4 (h1, h2, h4) | **yes** | 19 | `complete` | $0.0131 | 180 s | 120 | 4/4 | 2/2 | `20260921-000258-eo7synws` |

- `ledger5` solved again (28 steps; `isbn` gold at step 7, `label` statement at 9, `fine` gold at 13, then the rest; one `change_approach`).
- `masked` — lone-partial trap on the merged controller too: step 3 Jev ranked the gold replace `entries = parse_lines(text)`
  first (p 0.99), it ran, `110 tested (103 unchanged, 7 partial)`, `budget`; parked at step 5 after a SKETCH step; §15's rules
  commit held *passers* and *pairs of partials*, never a lone partial, so the chain's first link is dropped exactly as before;
  WIDENED over 34 sites at steps 12/13/18, `exhausted … at 10 sites` at 21, `max_replans` at 25.
- `shared_frame` — the second half was never localised: `buggy_line` for `pricing.py` was `none_of_these` (0.70–0.81) at
  every step (the true line `ensure_at_least(1, seats, "seats")` was among the options), the pricing gold never exceeded p 0.39 in
  RANK mode; the booking gold was ranked first (p 0.84) at step 10 (SIEVE) and step 16's batches held 28 + 11 partials, all
  booking-side variants, so `pairsOfPartials` had no complementary partner and the lone partial was parked; `max_replans` at 16.
- `crossfile`, `import_and_guard`, `regress_trap`, `six_hunks`, `long_chain`: not finished at hand-back.

### 19.6 Cause classes

| task | run 1 | run 1b | run 2 |
|---|---|---|---|
| `ledger5` | budget park + churn (isbn gold ranked first at step 16, step ended on budget; 12 declined / 12 blocked); `rank` overfit committed (`return hits`, allowed by the tests then) | **solved** 27 steps (`is_overdue` and `label` test-equivalent) | see §19.5 (run in progress) |
| `masked` | lone-partial trap (7/2/1 partials at steps 7/13/16, parked each time) + NameError insert-site detour (step 4) | lone-partial trap (7 partials at step 3, parked at 6; WIDENED 63–65 sites never a passer) | see §19.5 (run in progress) |
| `shared_frame` | budget park on the designed trap (gold ranked first p 0.80 in the 8th of 12 questions of step 11, untested; 922 runs, 12–149 regressed per batch) | – | see §19.5 (run in progress) |
| `crossfile` | reach (authoring: string key, kwarg name) + re-localisation of the discount goals into fmt/invoice gaps | overfit to one-test goals (`key not in CODES`, `options.get(SYMBOL_KEY, symbol)` insert); both pair golds ranked first at steps 4/6, each alone a regression, never paired | see §19.5 (run in progress) |
| `import_and_guard` | **solved** 13 steps, 0 blocked/declined | – | see §19.5 (run in progress) |
| `regress_trap` | **solved** 26 steps, 4/4 gold; the trap flips ran as `regressed` and were never kept | – | see §19.5 (run in progress) |
| `six_hunks` | one pair committed (`pair_of_partials`, `test_board`); `test_attention` and `test_summary` parked with partials in hand (lone-partial trap) | – | see §19.5 (run in progress) |
| `long_chain` | `-qq` gap: the engine never registered the establishing run, no search (authoring; fixed) | lone-partial trap (gold `float(price)` ranked first p 0.96 at step 5, 6/15/4 partials at steps 4/5/11, parked at 5) | see §19.5 (run in progress) |

### 19.7 What the tier says about the ledger

1. **A lone partial is never committed.** §2.2/§2.3 promise "partials held as a second base" and a partial commit when
   no plausible candidate exists; §15 made partials survive a park and pairs run before it, and commits a *held passer*
   on a budget exit — but a partial is not a passer, and pairing needs a second, complementary partial. `masked`,
   `long_chain`, the first half of `shared_frame` and two of the three `six_hunks` goals are chains whose first link can
   only be a partial (the goal's other tests need a later fix), so the gold is found, ranked first, run, labelled
   `partial` and dropped at the park; every one of these goals then loops through declined reads and blocked partial
   `done`s to `max_replans`. The fix is bookkeeping, not search: when a goal's search ends on `budget` with an
   `improved` base and no passer (§2.3's last line), commit the best partial as the step's patch and let the next
   baseline re-cluster the remaining tests (their frame has moved: `masked` report → parse/aggregate, `long_chain`
   load → clean). `progress.ts`' arithmetic already treats newly-passing tests as progress; the commit rule does not.
2. **Frame clustering versus assertion goals.** Exception-raising bugs cluster all their tests into one goal (the
   trap); assertion-failing bugs make one goal per test. Both extremes hurt: the first makes every half-fix a partial,
   the second makes `plausible` too weak — `crossfile` 1b's `key not in CODES` passed its one-test goal and regressed
   nothing, and moved the real fix out of depth-1 reach. A minimal `plausible` for a one-test goal should also require
   the *sibling* failing tests of the same source frame/file not to stay failing when a cheaper candidate at the same
   site would fix them, or the acceptance should prefer, among passers of a one-test goal, the one that newly passes
   the most other failing tests (they were all run).
3. **NameError → import gap first.** `masked` spent its first search step on insertions because the missing name `txt`
   was read as an unimported module; a local name that appears nowhere in the file should not produce an import gap.
4. **Churn is now the stop reason.** Across the misses, 7–12 `read` proposals per run were `declined` at risk 0.3–0.5
   "review" because bench runs have no reviewer, three identical reads trip the loop detector, `change_approach` rotates
   sources, and `max_replans` ends the run with 40–60 % of `--max-steps` unused. A declined read costs a step and buys
   nothing; in bench runs a `review`-level read should be executed or converted into the goal-subset `run`.
5. **The `-qq` gap** (§19.2) is a one-line hazard for any task whose `pytest.ini` adds `-q`; the loader could strip a
   task-level `-q` or the engine could parse counts from `-rA`-style summaries when the progress line is absent.
6. Load: runs 1–2 shared the machine with two other benches (load average 45–70); per-batch run medians were
   0.4–1.9 s against 0.15 s idle, every SIEVE step spent its 90 s test wall on 400–1,500 runs, and the §12 load scaling
   fired (`load ×2.9`). The `timeout` misclassification of §12 did not recur (no `timeout` verdicts in any batch), but
   budgets are the binding constraint on every miss.

### 19.8 Exact commands

```
# gates (main checkout; the worktree bench-clean at d610d75 + these files is fully clean)
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs
npx vitest run --project unit test/unit/bench/ladder.test.ts test/unit/bench/ladder-long.test.ts   # 16 passed
python3 bench/data/ladder/check.py --python ~/.jevcode/runs/ladder-venv/bin/python                  # 20 tasks, all checks passed

# run 1 (all eight; the controller before 1f7611e; tasks as first authored)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder \
  --task-id ledger5,masked,shared_frame,crossfile,import_and_guard,regress_trap,six_hunks,long_chain --conditions jev-only \
  --live --spend-cap 1.5 --task-spend-cap 0.2 --concurrency 2 --max-steps 30 --max-wall 15m --out bench/results/jev-only-ladder-long-1
# run 1b (the four re-authored tasks, same controller)
… --task-id ledger5,masked,crossfile,long_chain --spend-cap 1.0 … --out bench/results/jev-only-ladder-long-1b
# run 2 (all eight, merged controller d610d75, launched from .claude/worktrees/bench-clean; results copied to bench/results/jev-only-ladder-long-2)
… same as run 1 … --out bench/results/jev-only-ladder-long-2

# per-task tables and evidence (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/{transcript.log,decisions.jsonl,model_patch.diff};
# hunks fixed = patched src line == gold line per planted edit in /tmp/ladder-long/<task>.json)
python3 /tmp/ladder-long/table.py bench/results/jev-only-ladder-long-1 [task]
python3 /tmp/ladder-long/rows.py bench/results/jev-only-ladder-long-1
# reach probe of every planted line (mutation / templates / donors / composite at the buggy site)
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx /tmp/ladder-long/probe.mts ledger5 masked shared_frame crossfile import_and_guard regress_trap six_hunks long_chain
```
## 20. 2026-09-20 (later): wiring — introspected sites and names, history, statement sites, phase hint, re-baseline cache; nine oracle instances live

Follow-up to §16 ("Engine wiring needed"), §18 ("Wiring patch", "Failures / caveats") and the §17 heap finding (the 9-instance run
`bench/results/jev-only-swebench-2-oracle` died with `FATAL ERROR: Reached heap limit` at 4 GB on two Django tasks). Working tree on
HEAD 7ea40b2; files touched: `src/synth/search/{index,subgoal,sites,memory}.ts`, `src/synth/index.ts`, `src/synth/rank/questions.ts`,
`src/synth/introspect/prefixes.ts` (a cache), their tests, `test/unit/synth/wiring.test.ts` (new), `.scratch/wiring-introspect-history.patch`
(now the record of the applied diff). Nothing under `src/core`, `src/loop`, `search/{guard,bases,goals,budget,directive,proposal}.ts`,
`oracle/**` or `templates/**` changed. Offline work: **$0**. Live: the nine-instance run below.

### 20.1 What changed (file:line)

1. **The harvests are controller collaborators, run once per process** — `search/index.ts:137 SearchDeps.introspect(ctx, spec, anchors)`
   and `:139 SearchDeps.harvestHistory(ctx, moduleFiles, sources)` (both nullable: null = nothing harvested, no transcript line), defaults
   `:444 introspectInWorkspace` (introspect/index.ts `introspectRepro` through the engine's sandbox with the workspace venv, ≤ 60 s) and
   `:451 harvestHistoryInWorkspace` (history/harvest.ts, ≤ 8 read-only git commands of 10 s with `taskIdentifiers(ctx.task)`).
   `initRepository` calls `:1070 harvestIntrospection` right after the oracle (its judged frames are the anchors) and BEFORE the
   localisation, so the site list can read the facts (item 4), and `:1093 harvestHistoryFacts` after the regression scope (the localised
   module files are the query's `-- <paths>`); the checkpoint-restore branch (`:957`) runs both again from `repo.traceback`
   (`:1147 framesOfTraceback`) and `repo.moduleFiles`, since the facts are not persisted. Both register with `setRunFacts(ctx.runId, …)`
   (introspect/facts.ts) and emit one `introspect` / `history` synth line; a throwing harvest is a transcript line, never fatal
   (`:1107`, `:1130`). A post-patch re-baseline harvests nothing again.
2. **The sources read the facts** — `src/synth/index.ts:64 runFactsRef` (refreshed from the registry in `:99 createQueue`, the start of every
   sub-goal search, and in `locate`), `:71 enrichEnumerateOptions(site, opts, facts)` adds `introspected`, `history` and `extraNames =
   vocabularyAdditions(introspected, site.file)`; `:174 createSubGoalDeps` wraps the template seed (the introspect family fires only with
   `opts.introspected`) and the donor seed (`:181`: the history reversals first, then the donors, cut at `opts.cap`; each keeps its own
   `source` for the trace and the queue's prior — `orderSources` has no slot for design §3's last row); composite pairs over the wrapped
   seeds (`:193`). `createQueue` builds each file's vocabulary as `vocabularyOf(...) ∪ vocabularyAdditions(introspected, file)`
   (`:106`), so sieve/queue.ts's pre-check accepts what templates/introspect.ts writes and nothing else new
   (`introspect/prefixes.ts:34 PREFIX_CACHE`: one `classMethodPrefixes` per module object, the vocabulary asks for every corpus file).
3. **Phase hint** — `search/subgoal.ts:347 enumerateOptions` passes `phase: goal.phase` (visitPhase sets it before a site is visited), so the
   depth-2 wraps (templates/wrap2.ts) and `collapse_collection_to_element` enumerate in the engine's WIDENED and nowhere else; the SEEDS
   sets are unchanged (the templates' "SEEDS identical with and without `phase: 'SEEDS'`" and the QuixBugs snapshot tests still pass).
4. **Statement-level sites reach the engine** — `search/sites.ts:344 replaceSiteAt` returns the statement-level site (localize/sites.ts
   `statementSiteAt`: the statement joined onto one line, `Site.endLine` the span) at the FIRST line of a multi-line statement, as
   `buildSites` does for the Jev anchors, and the physical site elsewhere; `:361 statementSiteFor` adds the span once beside a continuation
   line's physical site (Q5n rows `:720`, SBFL rows `:743`); `widenedSites` inherits both through `replaceSiteAt`. `subgoal.ts:359
   siteOnBase` keeps a statement site on an 'improved' base by span compare (`:363`: the statement at `line` must still end at `endLine`
   and join to `currentLine`; a changed continuation line or a shifted file makes it stale), not by the first physical line.
   `rank/questions.ts:152 buggyLineOf`: a span site shows the joined statement as `buggy_line` and names `L<first>-L<last>` as
   `buggy_line_number` (`:259`), so the ≤ 255-option Choice and the Noul rubric compare the one-line rewrites with the whole statement,
   not with `return hash((`; `isUnchanged` already compared against `currentLine`.
5. **Introspection-derived sites** — `search/sites.ts:1042 introspectionSites(names, files, localised, sites, max = 2)`: the class the facts
   point at — the class whose method the reproduction's innermost workspace frame raised in, then the frames the operands were read in,
   then the class of a `raisingReceiver` operand (`type(self)`) a localised file defines, else the class enclosing the Jev-ranked sites —
   when a LOCALISED file defines it, yields its class-body gap (`:998 classBodyGap`: after the raising / located method when that method is a
   direct child of the class, else before the first method; class body indent; `block` = the class, no def) and the module-level import
   gap of that file; classes with a dispatch prefix first (the alias production writes only into those); ≤ `INTROSPECTION_SITES_MAX` 2,
   deduplicated against the located sites. `src/synth/index.ts:136 locate` appends them AFTER `buildGoalSites`'s ordered list with one
   `localize` transcript line; the localised files are the goal's suspected files ∪ the file beam ∪ the located sites' files.
6. **Re-baseline memory** — `search/memory.ts:58 SearchMemory.fileCache` (path → SourceFile of the last load) and `search/index.ts:342
   loadPythonFiles(ctx, cache = getMemory(ctx.runId).fileCache)`: every file is re-read (a patch may have touched any), a file whose text
   equals the cached copy is handed back as the SAME `SourceFile` object (the WeakMap caches keyed by object identity in sites.ts /
   composite.ts survive), only changed text is analysed, vanished paths leave the cache, and one `files` transcript line counts
   `reused` / `analysed` when anything was reused. `memory.ts:193 MEMORIES_MAX = 4`, `:196 getMemory`: the run registry is an LRU — a
   bench process never drops a finished run's memory (no run-end hook on a Synthesizer) and a repository memory holds its whole corpus,
   so the least recently used memory beyond four is dropped with its run facts (`:212 dropMemory` clears both); `--concurrency 2` keeps
   two active runs and two finished ones at most.

### 20.2 Heap, measured (`.scratch/heap-rebaseline.mts`, Django checkout `/tmp/jevonly/repos/django__django-15315`, 858 non-test files, `--expose-gc`, heapUsed after two forced GCs)

| load | wall | heapUsed after |
| --- | --- | --- |
| before any load | – | 12.3 MB |
| 1 — establishing baseline (cache empty): 858 analysed | 484 ms | 161.0 MB (**one analysed Django corpus ≈ 149 MB**) |
| 2 — re-baseline after a one-file commit, WITH the cache: 857 reused, 1 analysed | 31 ms | 164.2 MB (+3.2 MB) |
| 3 — second re-baseline, WITH the cache: 858 reused, 0 analysed | 17 ms | 164.2 MB (+0) |
| 4 — re-baseline WITHOUT the cache while the earlier corpus is still referenced (the old behaviour: an improved base, a localisation cache, a held partial) | 373 ms | 311.9 MB (+147.7 MB) |
| 5 — second re-baseline WITHOUT the cache | 379 ms | 459.6 MB (+147.7 MB) |

Every unchanged file is the same `SourceFile` object across loads 1–3 (asserted in the script). Reading: one Django corpus is ≈ 150 MB, not
the whole 4 GB — the 9-run's heap was many corpora: every re-baseline of every Django step analysed 858 files again while older copies were
still reachable, and every finished run's memory (corpus included) stayed in the registry for the life of the bench process. Both paths
are closed: a re-baseline now costs the changed files (≈ 3 MB, 31 ms instead of ≈ 148 MB, 380 ms), and at most four run memories are held.

### 20.3 Tests (gate: `npx tsc -p tsconfig.json --noEmit` clean outside the peer WIP (3 pre-existing errors under `test/unit/tui`, `test/unit/cli`); `node scripts/no-any.mjs` ok; `npx vitest run --project unit test/unit/synth --exclude test/unit/synth/mutate/ladder.test.ts --exclude test/unit/synth/donor/corpus.test.ts` → **79 files, 1,315 tests pass**)

- `test/unit/synth/search/controller.test.ts` (repository block): fake introspection + fake history — call order `loadFiles, findOracle,
  introspect, locate, regressionScope, harvestHistory, runTests`, the spec / anchors / module files / sources each harvest received, the
  facts registered under the run id, the `introspect:` and `history:` transcript lines, no second harvest on the post-patch re-baseline;
  a resumed run harvests again from the checkpoint's traceback (`framesOfTraceback`) and module files, a timed-out introspection and a
  throwing history harvest are transcript lines and the step still ends `done`. New describe: `loadPythonFiles` reuses unchanged files by
  identity, re-analyses the changed one, drops the vanished one, names the counts, and defaults to the run memory's cache.
- `test/unit/synth/wiring.test.ts` (new): `enrichEnumerateOptions` (introspected, history, `extraNames` = flat names ∪ `_print_<Class>`
  aliases; untouched without facts); with the facts registered the wired template seed yields the four `mro_method_alias` lines at a
  class-body gap and `createQueue`'s vocabulary queues all four, without them the same site yields no alias and the queue drops them
  (`_print_Baz` in no vocabulary); the wired donor seed puts the history reversal first (`return hash(self.a)` + 3 deletes, `provenance`
  `reverse of a1b2c3d4e5 "Fixed #31750 -- …" (ticket:#31750)`), then the donors, within `opts.cap`; no facts → the plain donor set.
- `test/unit/synth/search/sites.test.ts`: `replaceSiteAt` returns the span at a statement's first line and the physical site at a
  continuation line, `statementSiteFor` adds the span once, `widenedSites` lists `[2, 5], [3], [4], [5], [6]`; `introspectionSites`: the gap
  after the raising method (class indent, block = the class) + the import gap, an absolute frame path resolves by suffix, a raising
  receiver's class → the gap before its first method, the class around a located site otherwise, a prefixed class outranks a plain one,
  nothing when no localised file defines the class, bounded (`max` 1 / 0), deduplicated against the located sites.
- `test/unit/synth/search/subgoal.test.ts`: `siteOnBase` keeps a statement site on an improved base whose change is elsewhere, drops it when
  a continuation line changed (first physical line identical) or the file shifted; `enumerateOptions(...).phase` follows `goal.phase`.
- `test/unit/synth/rank/questions.test.ts`: a span site's `buggy_line` is the joined statement, `buggy_line_number` `L2-L5`, `program` the
  physical lines, `isUnchanged` on the joined text whatever its spacing; a physical site unchanged.
- `test/unit/synth/search/memory.test.ts`: the LRU holds `MEMORIES_MAX`, a touch renews, eviction drops the run facts, `dropMemory` too.

### 20.4 Offline check on the real files (`.scratch/check-introspection-sites.mts`, the bench workspaces read-only, $0)

- sympy-15345 (`mathematica.py`, a value statement: no frame, no receiver): the located site L102 (`_print_Function`'s last line) puts the
  class-body gap of `MCodePrinter` after `_print_Function` at **L103** (indent 4) and the import gap at L9; the template seed with the
  facts yields 127 candidates at that gap, 120 `mro_method_alias`, **`_print_MinMaxBase = _print_Function` at index 1** (after
  `_print_Max = _print_Function`); `vocabularyAdditions` holds `_print_MinMaxBase`; without facts the gap yields 0 aliases.
- sympy-17139 (`fu.py`): the frames end in `Expr.__lt__` (expr.py, not localised) and fu.py's module-level `_f` / `TR6`, the receiver is
  `ImaginaryUnit` (numbers.py): **no extra site**, as designed — the guard production works at the existing gap.
- django-15315 (`fields/__init__.py`): the located line 545 is now the statement site **545–549** (`return hash((self.creation_counter,
  self.model._meta.app_label if hasattr(self, 'model') else None, …))`); with no facts (an `assert` in the snippet) the class around it,
  `Field`, still gets its class-body gap after `__hash__` (L559) and the import gap (L30): 10 plain templates there, bounded noise.

## 21. 2026-09-20 (later): SWE-bench rung 3 — the repository-mode integration, the budget round and the §20 wiring measured on the 30 (BEFORE: 1/9 oracle instances, 1/8 of the crashed full run; AFTER: 1/30 — django-15128 solved, sympy-19954 lost); the history/ranker site defect; django-15315's oracle is a 1/8 coin the seed does not fix

The budget agent's static parts (21.1, 21.2, 21.4) were drafted as §17.x before §17 was taken by the ladder round; renumbered here unchanged except for the cross-references and the 21.4 addendum. Live spend of this section: $1.163 (rung 3) + $0.198 (the §21.3 before-rerun); offline checks $0.

### 21.1 The repository-mode integration this section measures (commit df0855c, the previous hand-off)

Owner scope of that commit: `src/synth/search/{index,goals,memory,proposal,subgoal}.ts`, `src/synth/oracle/**` (additive: `search.ts`,
`verify.ts`), the wiring in `src/synth/index.ts`, and their tests (`test/unit/synth/search/controller.test.ts` repository
block, `test/unit/synth/oracle/{search,verify}.test.ts`). Nothing in `search/{guard,bases}.ts`, `mutate/**`, `core/**`,
`loop/**` or `sieve/runner.ts` changed there. Measurement inputs: `experiments/results/oracle-from-issue.md` (a valid
reproduction on 9/30 instances at one Jev request each), `bench/results/jev-only-swebench-1` (0/30: no goal, the pytest
default runner on Django/sympy checkouts, `synth baseline: 0/1 pass, 0 failed, 1 errors` → `every goal parked: no goal`).

1. **Repository mode in the controller** (`search/index.ts rebaselineRepository`, entered when the detected runner is
   Django's `runtests.py` or sympy's `bin/test`, or the workspace has ≥ 40 non-test / ≥ 25 test Python files —
   `oracle/search.ts isRepositoryWorkspace`; QuixBugs and the ladder never enter it). The establishing step, once per run:
   the **oracle from the issue** (`findIssueOracle`: code extracts the blocks, ONE Jev request judges them, code builds
   the criterion and runs the snippet in the workspace with `.venv/bin/python`) → the goal (`repro::<sha8>`, its
   `FailureView` from `reproductionGoal`) or, without a valid oracle, the **best-guess goal** (`issue::<sha8(task)>`,
   plan item `fix issue::… in <path>`) → **one localisation** of that goal from the task text (the reporter's traceback
   frames Jev put ≥ 0.5 on being in the fix and the base run's raising frames are passed as the localiser's `traceback`;
   the result is cached for the search) → the **regression scope** over the top ≤ 3 module files of the file beam
   (`chooseRegressionScope`: `relatedTestFiles` with test-file contents, then test apps named after the module's stem
   when slots are left, then a two-file smoke check; only runnable test modules, never `gis_tests`/`postgres_tests`-style
   backends; ≤ 6 files) → the **scoped baseline** = `scopedTestCommand` on the detector's program plus the harness's
   flags read from `.jevcode-spec.json` (`python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite
   <labels>`, `python bin/test -C --verbose <files>`, `python -m pytest -q -rA <files>`; the program stays the detector's so
   the engine's `isTestCommand` parses the run). The ledger's baseline is `mergeSummaries(scoped, repro)`: the scoped run
   plus the reproduction as one more (failing) test; its `command` and `durationMs` are the scoped run's. Failures of the
   scoped run at the base commit are **known failures** (counted, never goals). A Django or sympy full suite is never run.
2. **Verification in lanes** (`oracle/verify.ts runRepositoryQueue`, swapped in for `sieve/runner.ts runQueue` by the
   wiring whenever `mem.repository` is set): git worktree lanes as before (§4.2), `PYTHONPATH` pointed at the lane (an
   editable install of the workspace package otherwise resolves to the workspace, not the lane; pytest's install-generated
   `src/_pytest/_version.py` is copied in), the goal-subset run is `verifyRepro` with the workspace venv (≈ 0.4–6.5 s), the
   full-suite run is the scoped command and only passers pay it (≤ 5 per step); `plausible` = the reproduction passes and
   nothing is newly failing, `unchanged` = the reproduction still fails, `regressed` = a scoped test newly fails. The guard
   (`search/guard.ts`, untouched) sees ordinary `VerifyOutcome`s whose `full.passing` carries the reproduction id. The
   oracle model reads the reproduction's duration as `tRunMs.goalSubset` and the scoped run's as `fullSuite`, so §2.4
   decides SIEVE/RANK per instance (requests ≈ 0.4 s → SIEVE, sympy ≈ 6 s → RANK).
3. **Post-patch re-baseline**: the scoped run again plus the reproduction re-run on the workspace
   (`verifyReproInWorkspace`); the goal is `fixed` iff the reproduction passes; the post-patch `run` claims the item and
   says `expect N of T tests to pass and the reproduction to pass`; `done` (green) reads
   `all N tests pass; the reproduction repro::… passes; 1 fix committed`. A green scoped run at the base commit is never
   `done` (green also requires every goal fixed).
4. **Best-guess path** (`search/subgoal.ts searchBestGuess`): sources 1–3 at the localiser's top 3 sites, Jev ranks each
   site's set (`rank/`), the `decideRunPlan` top-k over the merged ranking run against the regression scope only; the commit
   is the highest-ranked candidate with nothing newly failing, **at most once per run** (the goal parks with
   `best-guess fix committed, unverified (no reproduction oracle)`; a blocked/declined patch is re-proposed once from the
   stash and then the goal parks as rejected). The patch's goal text is `apply best-guess fix (no reproduction oracle;
   unverified): …`, `openProblems` carries `no reproduction oracle: best-guess fix, unverified`, the evidence has
   `selection: 'rank'`, `goalTests: []`. Then the scoped `run` and a partial `done` naming the oracle's outcome, the scope
   and the known failures.
5. **Persistence** (`memory.ts RepositoryMode`, `PersistedRepository`): the reproduction spec (chunks + criterion), the
   module files, the scope and the flags ride in `synthState`; a resumed run neither re-asks Jev nor re-localises, it
   re-runs the scoped command and the reproduction.
6. **File loading**: `MAX_WORKSPACE_PY_FILES` 400 → 1200 (Django 858 / sympy 746 non-test source files, analysed in
   0.3 s / 1.7 s; the repo-wide file Nouls that ranked the gold file #1 on 23/30 saw every file), task-named files first.
7. **Scoped-baseline timeout**: the run's maximum command timeout up to 300 s; a scope that still times out is retried
   once on its top 2 files before the §4.1 park.

Measured before the live run (no Jev): `chooseRegressionScope` over the 30 gold modules puts the F2P test file in the
scope on **21/30** (3 partially; misses: `sympy/core/function.py` → `test_lambdify`, `polys/domains/expressiondomain.py`,
`django/db/models/sql/compiler.py`, `forms/models.py` ×2, `contrib/admin/options.py` after the runnable-module filter,
`pylint/config/*` → `test_config`); a 4 + 2 blend of the related and stem tiers lost 4 and gained 1 and was dropped.
Pre-flight on the built bench workspaces: Django lanes 2 × worktree in 12.4 s (sympy 3.3 s, requests 0.5 s), the lane's
`runtests.py` reports `Testing against Django installed in …/lane0/django`, the venv python runs the django-15315
reproduction in the lane (`AssertionError` at base, 2.8 s), sympy's scoped `bin/test -C --verbose` on 6 files: 129 passed
in 12.9 s (workspace) / 18.9 s (lane), requests' `test_requests.py`: 85 passed, 81 network errors (known failures) in 4.3 s.

### 21.2 What this round changed (working tree on d610d75; file:line) — and what §20 wired on top of it

The budget-round changes below (items 1–3) were live in the 30-run of Table B (§21.3) and are what commit d610d75 carries. The
rung-3 run of §21.5 adds the wiring of **§20** (commit 5486f7a: introspected names and sites, the history source, statement-level
sites, the phase hint, the re-baseline file cache and the LRU of run memories) on top; §20.1–20.4 document that diff and its offline
checks, and are not repeated here.


The 9-instance live run of the integration above (`bench/results/jev-only-swebench-2-oracle`, §21.3) showed the oracle
found in one request on 9/9, the gold file localised #1, hundreds of candidates enumerated — and the step budget letting
16 of them run. Three things changed, all in this agent's files:

1. **Runs per step from the measured oracle, not the class** — `src/synth/search/budget.ts:143-162` (constants
   `REPO_TEST_RUNS_MAX` 16 becomes the floor, `REPO_TEST_RUNS_CAP` 160, `REPO_PASSERS_RESERVED` 5 = the runner's passer
   cap), `budget.ts:586` `hasCheapGoalSubset` (repository class with the reproduction cheaper than the scoped suite),
   `budget.ts:599` `repositoryRunsPerStep`: `runs = floor((testWall − 5 × t_run(fullSuite)) / t_run(goalSubset)) × lanes`
   bounded to [16, 160], with `testWall = min(8 × scopedBaseline, 600 s, wallRemaining)` as before; `budget.ts:631`
   `freshBudget` reads it for the repository class (QuixBugs class unchanged at 1,500). sympy-15345 as measured idle:
   floor((149 s − 93 s) / 2.06 s) × 4 = **108** a step instead of 16; a Django instance with a 100 s scope and a 2.8 s
   reproduction: 140; every equal-cost oracle (best guess, plain pytest) still 16. **RANK take per site from the budget**
   — `budget.ts:647-676` `decideRunPlan(…, { sitesLeft })`: on a cheap repository oracle `K = clamp(floor(runsLeft /
   sitesLeft), 3|5, 16)`, so a step's runs spread over the top sites in Noul order (before: 15 of 16 runs at site 1 both
   steps, sites 3–12 never reached); `subgoal.ts:612,633,770` thread `sitesLeft` from `visitPhase` through `visitSite`
   and `visitSeedBatch` to `visitSource`; the best-guess path (`searchBestGuess`, no `sitesLeft`) and every equal-cost
   oracle keep the fixed 3/5. docs/JEV-ONLY-DESIGN.md §4.3 (line 350) carries the dated paragraph.
2. **Stagnation, not the hit, parks a budget-hit goal (§5.3)** — `src/synth/search/types.ts:36,40,171-173`
   (`Goal.budgetSteps`, `Goal.testedSites`, `GoalSearchTrace.sitesTested/newSitesTested`), `subgoal.ts:401`
   `everySiteSeedsExhausted`, `subgoal.ts:462` `recordResults` records the sites each classified candidate ran at on the
   goal (across steps; `apply_failed` tests nothing), `goals.ts:65` `MAX_BUDGET_HIT_STEPS = 4`, `goals.ts:571`
   `noteBudgetHit(goal, progress)` counts a progressing step toward the hard cap only, `goals.ts:580` `parkReasonFor`
   names the rule (`… that tested nothing new` / `… (hard cap)`), `goals.ts:606` `reopenOnChange` drops `testedSites`
   with `exhausted`; `search/index.ts:702-707` the budget branch: `progress = tested > 0 && newSitesTested > 0 && not
   every located site seeds-exhausted`, a progressing step skips the stagnation count and the "3 searches without a
   commit" rule, and one `synth budget:` transcript line per such step says which rule the step counted toward. The
   hard cap keeps the loop detector's guarantee (each budget step is one more identical scoped `run`; three trip it;
   4 steps bound a goal to one trip). docs §5.3 (line 458).
3. **The lane verdict must predict the workspace verdict** (the coordinator's item 1, diagnosed on django-15315, §21.4) —
   `src/synth/oracle/runner.ts:256,267` every reproduction runs under `PYTHONHASHSEED=0` (`REPRO_HASH_SEED`), and
   `oracle/search.ts:200,327-334` `findIssueOracle` runs the snippet a second time on the base commit before accepting
   the oracle: a fail-then-pass is the new outcome `unstable` (no oracle → best guess); the note of a valid oracle reads
   `confirmed by a second run in N ms` (a confirmation run that did not report keeps the first verdict and says so).

Tests (fake runner/decider, no Jev): `test/unit/synth/search/budget.test.ts` (new describe: the derived count on the
sympy/Django numbers, the floor and the cap, equal-cost = 16, `freshBudget`, the sized take with `sitesLeft`, the
QuixBugs-class and equal-cost plans unchanged, `REPO_PASSERS_RESERVED === MAX_FULL_SUITE_RUNS_PER_STEP`; the bitcount
`noStop` assertion updated to the derived 100), `goals.test.ts` (progress steps count toward the hard cap only, mixed
sequences, resets on commit/park/reopen), `controller.test.ts` (4 progressing budget steps → parked by the hard cap at the
4th with attempts at 3; progress, progress, stagnant → `3 searches without a commit`; every top site seeds-exhausted →
stagnation; the transcript line), `subgoal.test.ts` (two sites, 60 runs on a 2.5 s / 20 s oracle → batches 16, 16, 14 at
the first site and 14 at the second; the next step 14, 14, 16, 16 with `newSitesTested` 0; equal cost → 3, 3, 3, 5, 5,
5), `oracle/runner.test.ts` (`PYTHONHASHSEED=0` in the command), `oracle/search.test.ts` (two runs per valid oracle, the
same command; `unstable` on fail-then-pass; a non-reporting confirmation keeps the verdict). Gates: `tsc` clean on these
files (the remaining errors are other agents' WIP under `src/config`, `src/tui`, `src/workspace`, `src/synth/history`,
`test/unit/synth/templates`), `no-any: ok`, `vitest --project unit test/unit/synth/search test/unit/synth/oracle`:
21 files, 456 tests pass.

### 21.3 BEFORE: the two runs that precede the wiring (report script `experiments/inspect/swe-report.mts`; solved = the local-venv evaluator's verdict only)

**Table A — the nine oracle instances on the integration code** (`bench/results/jev-only-swebench-2-oracle`, bench
`20260920-225645-…`, commit df0855c + the §21.2 working tree, `--concurrency 2 --max-steps 25 --max-wall 25m`; the process
died with `FATAL ERROR: Reached heap limit` at 4 GB after 5 records; the remaining four — django-15128, django-15563,
psf__requests-2931, sympy-12096 — are the **before-rerun** `bench/results/jev-only-swebench-2-oracle-b`, bench
`20260920-232341-e24366`, old code df0855c in the worktree `/tmp/jevonly/before-df0855c`, $0.198). Command:
`node node_modules/.bin/tsx experiments/inspect/swe-report.mts bench/results/jev-only-swebench-2-oracle,bench/results/jev-only-swebench-2-oracle-b --crashed=bench/results/jev-only-swebench-2-oracle`.

| instance | oracle | ledger | first baseline | enumerated / tested / plausible | commits / applied (rejections) | progress budget steps | best guess | evaluator | steps | Jev $ | wall s | stop | class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-15128 | strong | fixed 0, open 0, parked 1 | 625/633 scoped tests pass, 0 failed, 0 errors in 10831 ms; reproduction repro::6da66011 fails (AssertionError: ) in 1927 | 743 / 272 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 9 | $0.0211 | 266 | replan_stop | ranked_run_but_regressions |
| django__django-15315 | strong | fixed 0, open 1, parked 0 | 328/356 scoped tests pass, 0 failed, 0 errors in 11032 ms; reproduction repro::e7fbbfa8 fails (AssertionError: ) in 1964 | 2490 / 351 / 39 | 14 / 5 (8 blocked pm, 1 declined) | 0 | no | fail (local-venv) | 25 | $0.0808 | 832 | max_steps | evaluator_fail_on_committed_patch |
| django__django-15563 | weak | fixed 0, open 1, parked 0 | 350/353 scoped tests pass, 0 failed, 0 errors in 10092 ms; reproduction repro::3ec747c8 fails (<QuerySet [{'field_otherb | 751 / 80 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 3 | $0.0282 | 1895 | wall_time | ranked_run_but_regressions |
| psf__requests-2931 | strong | fixed 0, open 0, parked 1 | 85/167 scoped tests pass, 0 failed, 81 errors in 3800 ms; reproduction repro::b5e65acf fails (UnicodeDecodeError: 'ascii | 10145 / 3718 / 2 | 4 / 0 (2 blocked pm, 2 declined) | 0 | no | fail (local-venv: empty model_patch) | 24 | $0.0507 | 504 | max_replans | engine_blocked_plan_mismatch |
| sympy__sympy-11618 | strong | fixed 0, open 0, parked 1 | 641/770 scoped tests pass, 0 failed, 46 errors in 29174 ms; reproduction repro::7f52cda6 fails (1) in 3280 ms | 1876 / 280 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 10 | $0.0276 | 302 | replan_stop | reachable_not_ranked_in_budget |
| sympy__sympy-12096 | weak | fixed 0, open 0, parked 1 | 809/978 scoped tests pass, 0 failed, 84 errors in 65277 ms; reproduction repro::fcbb4c5a fails (f(g(2))) in 4065 ms | 2475 / 187 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 4 | $0.0176 | 2042 | wall_time | reachable_not_ranked_in_budget |
| sympy__sympy-15345 | strong | fixed 0, open 0, parked 1 | 142/175 scoped tests pass, 0 failed, 0 errors in 18642 ms; reproduction repro::9364c244 fails ('Max(2, x)') in 2058 ms | 1438 / 32 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 10 | $0.0259 | 147 | replan_stop | reachable_not_ranked_in_budget |
| sympy__sympy-17139 | strong | fixed 0, open 0, parked 1 | 929/1013 scoped tests pass, 0 failed, 0 errors in 101055 ms; reproduction repro::ac95b0c9 fails (TypeError: Invalid comp | 1571 / 39 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 9 | $0.0282 | 638 | replan_stop | ranked_run_but_regressions |
| sympy__sympy-19954 | strong | fixed 1, open 0, parked 0 | 96/99 scoped tests pass, 0 failed, 0 errors in 11139 ms; reproduction repro::db420b5d fails (IndexError: list assignment | 1265 / 25 / 3 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 8 | $0.0241 | 190 | replan_stop | solved |

Totals: 9 instances; oracle strong 7, weak 2, unstable 0, none 0; patches applied 6; best guess used 0; evaluator pass 1/9; engine rejections: 10 blocked (plan_mismatch) + 3 declined (review, no reviewer) on 2 instances; Jev $0.3043; wall 6818 s (sum)
Failure classes: ranked_run_but_regressions 3, reachable_not_ranked_in_budget 3, evaluator_fail_on_committed_patch 1, engine_blocked_plan_mismatch 1, solved 1

Reading (per-instance digests in the script's stderr): the oracle is found on **9/9** (7 strong, 2 weak) in one request each
and the gold file is localised on every instance, yet only sympy-19954 is solved (the same `if len(rep_blocks) > i`-style
guard as §14's note, step 4, 25 tested, 3 plausible, arbitration, `complete`). Three instances hit the 16-runs-per-step class
cap and parked after two budget steps (`reachable_not_ranked_in_budget`: 15345 tested 16 + 16 of 727/711 enumerated, 11618
16 + 264, 12096 16 + 171); three ran hundreds of candidates and saw only regressions (`ranked_run_but_regressions`: 15128
272 tested, 17139 39, 15563 80 under `wall_time`); django-15315 committed 5 patches that each passed in the lane and failed on
the workspace (`evaluator_fail_on_committed_patch`, §21.4); requests-2931 found two lane passers and had both refused by the
engine (`engine_blocked_plan_mismatch`: 2 blocked + 2 declined). Jev $0.304 for the nine; wall 6,818 s summed.

**Table B — the full 30 on the budget-round code** (`bench/results/jev-only-swebench-2`, working tree d610d75 with §21.2 items
1–3, same flags plus `--spend-cap 4 --task-spend-cap 0.4`, `NODE_OPTIONS=--max-old-space-size=8192`; **crashed OOM at 8 GB
after 8 evaluated records**, `exit 134` in `/tmp/jevonly/swebench-2.log` at 45 min; the two `in_progress` rows are the runs the
process died in). `*` marks the nine oracle instances. Command: `… swe-report.mts bench/results/jev-only-swebench-2 --mark=<the 9 ids>`.

| instance | oracle | ledger | first baseline | enumerated / tested / plausible | commits / applied (rejections) | progress budget steps | best guess | evaluator | steps | Jev $ | wall s | stop | class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| *sympy__sympy-11618 | strong | fixed 0, open 1, parked 0 | 642/770 scoped tests pass, 0 failed, 45 errors in 76683 ms; reproduction repro::7f52cda6 fails (1) in 3265 ms | 9417 / 1116 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 1 | no | fail (local-venv: empty model_patch) | 19 | $0.0775 | 626 | max_replans | reachable_not_ranked_in_budget |
| *sympy__sympy-12096 | weak | fixed 0, open 1, parked 0 | 812/978 scoped tests pass, 0 failed, 81 errors in 63144 ms; reproduction repro::fcbb4c5a fails (f(g(2))) in 4182 ms | 9227 / 443 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 3 | no | fail (local-venv: empty model_patch) | 21 | $0.0807 | 1280 | max_replans | ranked_run_but_regressions |
| sympy__sympy-12489 | none (no_blocks) | fixed 0, open 1, parked 0 | 808/980 scoped tests pass, 0 failed, 89 errors in 6391 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | n/a (none: in_progress) | 0 | $0.0000 | 0 | in_progress | in_progress |
| sympy__sympy-13798 | none (no_pick) | fixed 0, open 1, parked 0 | 0/1 scoped tests pass, 0 failed, 1 errors in 1939 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 10 | $0.0209 | 29 | replan_stop | no_oracle_no_guess |
| *sympy__sympy-15345 | strong | fixed 0, open 0, parked 1 | 142/175 scoped tests pass, 0 failed, 0 errors in 45513 ms; reproduction repro::9364c244 fails ('Max(2, x)') in 4702 ms | 17690 / 552 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 3 | no | fail (local-venv: empty model_patch) | 23 | $0.1166 | 1415 | max_replans | reachable_not_ranked_in_budget |
| sympy__sympy-16792 | strong | fixed 0, open 1, parked 0 | 190/198 scoped tests pass, 0 failed, 0 errors in 8161 ms; reproduction repro::3492baa3 fails (CodeWrapError: Error while | 4410 / 1145 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 2 | no | n/a (none: in_progress) | 0 | $0.0000 | 0 | in_progress | in_progress |
| *sympy__sympy-17139 | strong | fixed 0, open 0, parked 1 | 929/1013 scoped tests pass, 0 failed, 0 errors in 146532 ms; reproduction repro::ac95b0c9 fails (TypeError: Invalid comp | 2523 / 172 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 2 | no | fail (local-venv: empty model_patch) | 10 | $0.0301 | 872 | replan_stop | reachable_not_ranked_in_budget |
| *sympy__sympy-19954 | strong | fixed 1, open 0, parked 0 | 96/99 scoped tests pass, 0 failed, 0 errors in 23693 ms; reproduction repro::db420b5d fails (IndexError: list assignment | 1016 / 21 / 3 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 6 | $0.0196 | 243 | complete | solved |
| sympy__sympy-20428 | none (passes_on_base) | fixed 0, open 0, parked 1 | 341/342 scoped tests pass, 0 failed, 0 errors in 9980 ms; no reproduction oracle | 1486 / 5 / 4 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 25 | $0.0636 | 111 | max_steps | best_guess_wrong |
| sympy__sympy-22080 | none (passes_on_base) | fixed 0, open 1, parked 0 | 251/306 scoped tests pass, 0 failed, 0 errors in 13045 ms; no reproduction oracle | 1513 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 23 | $0.0527 | 110 | max_replans | no_oracle_best_guess_rejected |

Totals: 10 instances; oracle strong 5, weak 1, unstable 0, none 4; patches applied 2; best guess used 2; evaluator pass 1/8; engine rejections: 2 blocked (plan_mismatch) + 0 declined (review, no reviewer) on 1 instances; Jev $0.4618; wall 4686 s (sum)
Failure classes: reachable_not_ranked_in_budget 3, in_progress 2, ranked_run_but_regressions 1, no_oracle_no_guess 1, solved 1, best_guess_wrong 1, no_oracle_best_guess_rejected 1

Reading: the derived per-step run count (§21.2 item 1) did what it was built for — 15345 tested 552 candidates over seven
budget steps instead of 32, 11618 1,116 instead of 280, 12096 443 instead of 187 — and **found nothing**: every one of those
runs came back `unchanged`. So on the three "budget" instances of Table A the constraint moved from the cap to the
candidate set, which is the reach study's verdict (`swebench-reach-oracle-9.md`: the test-passing line is in no source's set
at the gold site on 15345, 17139, 19954 (one-liner), 11618) and the reason the §18/§20 capabilities were built. Every
`valid` oracle line now reads `confirmed by a second run` (item 3); sympy-19954 is solved again (`complete` at step 6, 21
tested, 3 plausible). The two best-guess instances behaved as designed and wrongly: sympy-20428's guess was committed and
fails the evaluator, sympy-22080's was blocked twice (plan_mismatch) and parked. Jev $0.462 for the ten records.

### 21.4 django-15315: why a lane `plausible` did not predict the workspace verdict (coordinator's item 1)

Run `20260920-230759-spkhi7p6` (old code, the 9-run): step 3 tested 13 candidates on 8 lanes, **5 plausible in one
cluster**, all inserts at `django/db/models/fields/__init__.py:550` — one line *after* `return hash((…))` in
`Field.__hash__`, i.e. dead code (`self.append(__all__)`, `if self is None: return False`, …). The patch was applied; the
step-4 re-baseline on the workspace read `reproduction repro::e7fbbfa8 fails (AssertionError: )`. Steps 5, 7, 9, 11 repeated
the pattern (56 → 5, 19 → 5, 45 → 4, 29 → 5 passers, every one dead code after a `return` in a `__hash__`; **24 passers
of 162 lane runs, 15 %**), with 8 blocks (plan_mismatch level 4) and 1 decline of the patches.

Ruled out by measurement: (a) import resolution — a lane python printed `django.db.models.fields.__file__` under the lane
and `sys.meta_path` with the editable finder appended after `PathFinder`, so `PYTHONPATH=<lane>` wins; (b) stale bytecode —
no `__pycache__` in any lane (`PYTHONDONTWRITEBYTECODE=1` on both the reproduction and the scoped command); (c) the
criterion — the same `no_exception` evaluation on both sides. The cause is the **reproduction itself**: run in a private
worktree at the base commit with the workspace venv, `hash(f)` changed after `class Book(models.Model): title = f` in both
worktree and lane (`-2809…→9010…`, `-7134…→4525…`), yet `f in d` was **True in one and False in the other**. CPython's
dict lookup compares the stored key by identity before it compares hashes, so a key whose hash changed is still found
whenever the new hash probes the slot the old one occupied — for an 8-slot dict 1 time in 8 — and the tuple hash includes
`'app'` and `'book'`, whose `str` hashes are **randomised per process** (`PYTHONHASHSEED`). The issue's own assertion is a
7/8 coin: the base run failed (7/8), 24/162 lane runs passed by luck (expected 1/8 = 20), and exactly 5 passers per step is
the runner's passer cap stopping dispatch. The engine's "repeats a failed step" blocks in that run were therefore right
about the patches and wrong about the reason.

Fix (§21.2 item 3): every reproduction — the oracle's base run, the lanes, the workspace re-run — now runs under
`PYTHONHASHSEED=0`, so the verdict is a fact of the code, not of the process (a lucky-hash *candidate* can still pass under
the fixed seed, but then the lane and the workspace agree and the F2P evaluator — random seeds — decides); and the oracle
search confirms the base verdict with a second run, refusing a fail-then-pass snippet as `unstable`. In the 30-run below
every `valid` oracle line reads `confirmed by a second run`.

**Post-run addendum (measured after the rung-3 run, $0; `experiments/inspect/repro-15315-repeat.mts`).** The seed did not make the
verdict a fact of the code. In the finished rung-3 run (`20260921-010903-ovz3tdxe`) the lanes again reported 5 `plausible` per step
(20 of 167 lane runs, every one an insert after a `return` in a `__hash__`: `__init__.py:550`, `reverse_related.py:140`), four were
committed, the workspace re-baseline read `reproduction repro::e7fbbfa8 fails` after the first three (steps 3, 5, 7) and `PASSES` after
the fourth (step 9); the evaluator fails the patch. Re-running the runner's own command (`buildReproScript` + `reproCommand`, i.e.
`PYTHONHASHSEED=0`) 16× in that workspace and 16× in its lane0 gives **AssertionError ×13, PASS ×3 in both** — still ≈ 1/8. The
reason is not the `str` hashes: the key's hash before the model assignment is `hash((creation_counter, None, None))`, and on the venv's
CPython 3.9.6 `hash(None)` is address-based, so it changes with ASLR per process regardless of the seed (`PYTHONHASHSEED=0 python -c
'print(hash(None), hash((7, None, None)) & 7)'` → `271367077 4`, `271794085 5`, `269915045 1`; `hash((7, 'a', 'b')) & 7` → 4 each
time). CPython fixed `hash(None)` to a constant only in 3.12. So on this instance the issue's own assertion is a coin that the runner
cannot load; the lane verdict must be **repeated** (a `plausible` confirmed by a second lane run, as `findIssueOracle` already does for
the base verdict) or the reproduction rewritten (`hash(f)` before/after compared, which is what the F2P test does) — see §21.6.

### 21.5 AFTER: rung 3 — the full 30 on the wired tree (commit 5486f7a; `bench/results/jev-only-swebench-3`, bench `20260921-002827-57b7e1`)

Run from the clean detached worktree `.claude/worktrees/swe-clean` (HEAD 5486f7a, `node_modules` symlinked; the main checkout's
uncommitted TUI/config work could not touch it), keys only via `--env-file`:

```
cd .claude/worktrees/swe-clean
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env \
  node_modules/.bin/tsx src/cli/main.tsx bench --suite swebench --conditions jev-only --live --spend-cap 4 --task-spend-cap 0.4 \
  --concurrency 2 --max-steps 25 --max-wall 25m --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/jev-only-swebench-3
# log /tmp/jevonly/swebench-3.log (starts `start 2026-09-21T00:28:26Z head 5486f7a`, ends `exit 0` / `end 2026-09-21T01:23:05Z`)
# RSS of the worker node process every 5 min: /tmp/jevonly/swebench-3.rss
# the table: node node_modules/.bin/tsx experiments/inspect/swe-report.mts bench/results/jev-only-swebench-3 --mark=<the 9 oracle ids>
# the reach-target check: node node_modules/.bin/tsx experiments/inspect/reach-check-3.mts bench/results/jev-only-swebench-3
```

**Exit 0, 30 records, 54 min 37 s wall (00:28:27 → 01:23:04 UTC), Jev $1.1633 (generator $0), no cap fired** (`summary.json`
`capFired: null`; `--spend-cap 4`, `--task-spend-cap 0.4`; the costliest task was sympy-15345 at $0.094). The BEFORE full-30 attempt on
d610d75 had died at 8 GB after 45 min and 8 records.

**Memory fix (§20.2) verified.** Worker RSS (`ps -o rss=`, pid 25328, 12 samples): 1.20 GB at start, 2.12, 1.61, 2.52, 0.06 (between
tasks), 1.06, 0.36, **2.99 GB peak at 01:03:47** (two sympy runs with 8 lanes each), 2.57, 1.26, 1.34, 0.18 GB at the end; mean 1.44 GB.
No `heap limit` line in the log; the process finished all 30 with `--max-old-space-size=8192` never approached (the 9-run died at 4 GB
after 5 records, the 30-run at 8 GB after 8). The RSS falls to tens of MB between tasks, i.e. finished runs' corpora are released (the
LRU) and re-baselines no longer re-analyse the corpus (the file cache).

`*` marks the nine oracle instances of §21.3 Table A.

| instance | oracle | ledger | first baseline | enumerated / tested / plausible | commits / applied (rejections) | progress budget steps | best guess | evaluator | steps | Jev $ | wall s | stop | class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | none (no_blocks) | fixed 0, open 1, parked 0 | 366/376 scoped tests pass, 0 failed, 0 errors in 3958 ms; no reproduction oracle | 1960 / 5 / 4 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0483 | 54 | max_replans | no_oracle_best_guess_rejected |
| django__django-14787 | none (no_pick) | fixed 0, open 1, parked 0 | 233/235 scoped tests pass, 0 failed, 0 errors in 1689 ms; no reproduction oracle | 1419 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 24 | $0.0485 | 61 | max_replans | no_oracle_best_guess_rejected |
| django__django-15103 | none (no_blocks) | fixed 0, open 0, parked 1 | 62/64 scoped tests pass, 0 failed, 0 errors in 1525 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 5 | $0.0116 | 15 | replan_stop | no_oracle_no_guess |
| *django__django-15128 | strong | fixed 1, open 0, parked 0 | 579/586 scoped tests pass, 0 failed, 0 errors in 2522 ms; reproduction repro::6da66011 fails (AssertionError: ) in 985 m | 762 / 410 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | **PASS** (local-venv) | 4 | $0.0113 | 124 | complete | **solved** |
| *django__django-15315 | strong | fixed 1, open 0, parked 0 | 328/356 scoped tests pass, 0 failed, 0 errors in 3389 ms; reproduction repro::e7fbbfa8 fails (AssertionError: ) in 599 m | 1785 / 167 / 20 | 4 / 4 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv) | 21 | $0.0515 | 120 | max_replans | evaluator_fail_on_committed_patch |
| django__django-15375 | none (incomplete_snippet) | fixed 0, open 1, parked 0 | 344/347 scoped tests pass, 0 failed, 0 errors in 4891 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 5 | $0.0123 | 27 | error | no_oracle_no_guess |
| *django__django-15563 | weak | fixed 1, open 0, parked 0 | 350/353 scoped tests pass, 0 failed, 0 errors in 5186 ms; reproduction repro::3ec747c8 fails (<QuerySet [{'field_otherba | 2669 / 20 / 8 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv) | 10 | $0.0246 | 68 | replan_stop | evaluator_fail_on_committed_patch |
| django__django-15572 | none (no_blocks) | fixed 0, open 1, parked 0 | 69/75 scoped tests pass, 0 failed, 0 errors in 1430 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 4 | $0.0091 | 13 | error | no_oracle_no_guess |
| django__django-15916 | none (no_criterion) | fixed 0, open 1, parked 0 | 302/302 scoped tests pass, 0 failed, 0 errors in 3361 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 25 | $0.0661 | 57 | max_steps | no_oracle_no_guess |
| django__django-16100 | none (no_blocks) | fixed 0, open 0, parked 1 | 460/483 scoped tests pass, 0 failed, 0 errors in 17573 ms; no reproduction oracle | 1641 / 4 / 4 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 25 | $0.0534 | 99 | max_steps | no_oracle_best_guess_rejected |
| psf__requests-1142 | none (no_blocks) | fixed 0, open 0, parked 1 | 5/26 scoped tests pass, 21 failed, 0 errors in 912 ms; no reproduction oracle | 1664 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: model_patch did not apply) | 25 | $0.0367 | 41 | max_steps | best_guess_wrong |
| *psf__requests-2931 | strong | fixed 1, open 0, parked 0 | 85/167 scoped tests pass, 0 failed, 81 errors in 1441 ms; reproduction repro::b5e65acf fails (UnicodeDecodeError: 'ascii | 1606 / 1219 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv) | 24 | $0.0272 | 76 | max_replans | evaluator_fail_on_committed_patch |
| pylint-dev__pylint-4604 | none (passes_on_base) | fixed 0, open 1, parked 0 | 115/115 scoped tests pass, 0 failed, 0 errors in 4732 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 4 | $0.0193 | 25 | error | no_oracle_no_guess |
| pylint-dev__pylint-4970 | none (no_blocks) | fixed 0, open 1, parked 0 | 89/91 scoped tests pass, 0 failed, 0 errors in 5612 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 4 | $0.0073 | 18 | error | no_oracle_no_guess |
| pylint-dev__pylint-6386 | none (no_pick) | fixed 0, open 1, parked 0 | 74/74 scoped tests pass, 0 failed, 0 errors in 10180 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 6 | $0.0105 | 30 | error | no_oracle_no_guess |
| pytest-dev__pytest-10051 | none (not_runnable) | fixed 0, open 1, parked 0 | 62/62 scoped tests pass, 0 failed, 0 errors in 1113 ms; no reproduction oracle | 1577 / 5 / 2 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0467 | 33 | max_replans | no_oracle_best_guess_rejected |
| pytest-dev__pytest-10081 | none (not_runnable) | fixed 0, open 1, parked 0 | 138/191 scoped tests pass, 4 failed, 0 errors in 9675 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 6 | $0.0220 | 38 | error | no_oracle_no_guess |
| pytest-dev__pytest-10356 | none (no_pick) | fixed 0, open 1, parked 0 | 220/223 scoped tests pass, 0 failed, 0 errors in 6654 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 5 | $0.0229 | 28 | error | no_oracle_no_guess |
| pytest-dev__pytest-7205 | none (not_runnable) | fixed 0, open 0, parked 1 | 354/361 scoped tests pass, 3 failed, 0 errors in 22565 ms; no reproduction oracle | 1433 / 5 / 3 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 22 | $0.0507 | 111 | max_replans | no_oracle_best_guess_rejected |
| pytest-dev__pytest-7324 | none (incomplete_snippet) | fixed 0, open 1, parked 0 | 377/398 scoped tests pass, 14 failed, 2 errors in 10735 ms; no reproduction oracle | 1594 / 5 / 4 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 22 | $0.0488 | 79 | max_replans | no_oracle_best_guess_rejected |
| *sympy__sympy-11618 | strong | fixed 0, open 1, parked 0 | 645/770 scoped tests pass, 0 failed, 42 errors in 18881 ms; reproduction repro::7f52cda6 fails (1) in 1501 ms | 0 / 467 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 5 | $0.0096 | 215 | error | no_search (ranker crash, below) |
| *sympy__sympy-12096 | weak | fixed 0, open 1, parked 0 | 793/960 scoped tests pass, 0 failed, 81 errors in 10523 ms; reproduction repro::fcbb4c5a fails (f(g(2))) in 770 ms | 10501 / 3406 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 4 | no | fail (local-venv: empty model_patch) | 23 | $0.0852 | 708 | max_replans | ranked_run_but_regressions |
| sympy__sympy-12489 | none (no_blocks) | fixed 0, open 1, parked 0 | 804/980 scoped tests pass, 0 failed, 93 errors in 6058 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 25 | $0.0567 | 70 | max_steps | no_oracle_no_guess |
| sympy__sympy-13798 | none (no_pick) | fixed 0, open 1, parked 0 | 0/1 scoped tests pass, 0 failed, 1 errors in 1831 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 9 | $0.0209 | 30 | replan_stop | no_oracle_no_guess |
| *sympy__sympy-15345 | strong | fixed 0, open 1, parked 0 | 142/175 scoped tests pass, 0 failed, 0 errors in 7655 ms; reproduction repro::9364c244 fails ('Max(2, x)') in 853 ms | 13145 / 3420 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 4 | no | fail (local-venv: empty model_patch) | 20 | $0.0941 | 727 | max_replans | reachable_not_ranked_in_budget |
| sympy__sympy-16792 | strong | fixed 0, open 0, parked 1 | 190/198 scoped tests pass, 0 failed, 0 errors in 9734 ms; reproduction repro::3492baa3 fails (CodeWrapError: Error while | 8788 / 1390 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 3 | no | fail (local-venv: empty model_patch) | 15 | $0.0799 | 645 | replan_stop | reachable_not_ranked_in_budget |
| *sympy__sympy-17139 | strong | fixed 0, open 1, parked 0 | 1026/1114 scoped tests pass, 1 failed, 0 errors in 107019 ms; reproduction repro::ac95b0c9 fails (TypeError: Invalid com | 3339 / 771 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 2 | no | fail (local-venv: empty model_patch) | 21 | $0.0585 | 1307 | max_replans | ranked_run_but_regressions |
| *sympy__sympy-19954 | strong | fixed 0, open 1, parked 0 | 104/107 scoped tests pass, 0 failed, 0 errors in 41353 ms; reproduction repro::db420b5d fails (IndexError: list assignme | 3358 / 395 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 2 | no | fail (local-venv: empty model_patch) | 21 | $0.0547 | 761 | max_replans | ranked_run_but_regressions |
| sympy__sympy-20428 | none (passes_on_base) | fixed 0, open 1, parked 0 | 319/319 scoped tests pass, 0 failed, 0 errors in 9751 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 4 | $0.0224 | 55 | error | no_oracle_no_guess |
| sympy__sympy-22080 | none (passes_on_base) | fixed 0, open 1, parked 0 | 251/306 scoped tests pass, 0 failed, 0 errors in 19808 ms; no reproduction oracle | 1513 / 5 / 3 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 23 | $0.0527 | 116 | max_replans | no_oracle_best_guess_rejected |

**Totals: 30 instances; solved 1/30 (evaluator verdict only); oracle strong 8, weak 2, none 20 (the nine of §21.3 plus sympy-16792, all
`confirmed by a second run`); patches applied 7 on 4 instances; best guess used 8; engine rejections 12 blocked (plan_mismatch) + 4
declined on 8 instances, all best-guess patches; Jev $1.1633; per-task wall 5,751 s summed, bench wall 3,277 s at concurrency 2.**

Failure classes: `no_oracle_no_guess` 12, `no_oracle_best_guess_rejected` 7, `evaluator_fail_on_committed_patch` 3 (django-15315,
django-15563, requests-2931), `ranked_run_but_regressions` 3 (sympy-12096, -17139, -19954), `reachable_not_ranked_in_budget` 2
(sympy-15345, -16792), `solved` 1 (django-15128), `best_guess_wrong` 1 (requests-1142: the committed guess did not apply), `no_search` 1
(sympy-11618). Nine of the twelve `no_oracle_no_guess` rows and the `no_search` row stopped with `error` at steps 4–6 — the defect below,
not a search outcome.

**Defect found by this run (blocks the next one): the history source's candidates carry their own site and the ranker throws.**
`src/synth/history/source.ts:96,110` build each reversal with `site: at` — the statement in the current file the hunk reverts — and
`src/synth/index.ts:184` merges those reversals into the donor seed of whatever site is being enumerated; `src/synth/rank/index.ts:307`
then asserts every ranked candidate is at the ranked site and throws
`RangeError: ranker: candidate "hist_c4ec6263_24_942fb54a58" is at sympy/geometry/point.py:204 (replace), not at the site being ranked
(sympy/geometry/point.py:212, replace)` (sympy-11618, step 5). The engine records `outcome failed: propose: internal`, and three
consecutive propose failures stop the run (`error`). 43 occurrences in 12 runs: nine runs died of it (django-15375, -15572,
pylint-4604, -4970, -6386, pytest-10081, -10356, sympy-20428 at steps 4–6, all without an oracle, and **sympy-11618 at step 5** after 467
candidates tested and none plausible), three survived because a SIEVE step intervened (sympy-12096 ×1, sympy-12489 ×8, django-15916 ×8).
The offline tests did not catch it because the wiring test enumerates the history seed at the reversal's own site; the fix is either to
enumerate history only at sites whose span contains the reverted statement (the statement site the design assumed, §16/§18) or to route
a foreign-site reversal to its own site instead of the donor seed. Ten runs also saw one or two transient `error jev_http: Jev request
failed: TypeError: fetch failed (other side closed)`; the engine retried and none of those stopped a run.

**The nine oracle instances, BEFORE (Table A) → AFTER:**

| instance | BEFORE (§21.3 A) | AFTER | what changed in the record |
| --- | --- | --- | --- |
| django-15128 | `ranked_run_but_regressions` (272 tested) | **solved**, step 4, $0.011 | SIEVE at step 2: 410 tested, one lone passer `alias += table_name` at `sql/query.py:765` (a `statement_template` insert), held until its site's seeds ran, committed when the batch was cut by the budget reserve; re-baseline `repro::6da66011 PASSES`; `complete`. Not the gold's shape (the gold threads `exclude` through `bump_prefix`); the F2P and the local P2P accept it. |
| django-15315 | `evaluator_fail` (5 commits) | `evaluator_fail` (4 commits) | same dead-code passers (§21.4 addendum: the seed does not fix `hash(None)`); the history harvest **found the ticket's commit** (`ticket #31750: 1 commit`) but the reversal was never dispatched — see the reach table. |
| django-15563 | `ranked_run_but_regressions` | `evaluator_fail` | the weak oracle (`differs_from_actual`) accepted `self.append(query)` at `compiler.py:1840` (8 plausible of 20 tested; the guard even logged `all-overfit signature, holding` once, then picked another passer); the evaluator fails it. |
| requests-2931 | `engine_blocked_plan_mismatch` | `evaluator_fail` | SIEVE 1,219 tested at step 4, 1 plausible: `if isinstance(data, bytes): data = data.decode('utf8')` before `return to_native_string(data)` — committed, F2P fails (the body must stay bytes). The gold line `return data` **was tested in the same batch and classified `unchanged`**: the oracle is `requests.put("http://httpbin.org/put", …)`, a network call, so its verdict is the network's. |
| sympy-11618 | `reachable_not_ranked_in_budget` | `no_search` (ranker crash) | killed at step 5 by the defect above. |
| sympy-12096 | `reachable_not_ranked_in_budget` (187 tested) | `ranked_run_but_regressions` (3,406 tested, 0 plausible) | the test-passing `return nfloat(self._imp_(*self.args), prec)` reached Jev at step 10 as a Choice option and Jev answered `none_of_these` p 0.69 (BEFORE run: the same at step 11, p 0.69 and 0.59); it was never run. SKETCH phase reached (steps 12, 15). |
| sympy-15345 | `reachable_not_ranked_in_budget` (32 tested) | same (3,420 tested, 0 plausible) | introspection harvested `MinMaxBase` (13 classes); the alias `_print_MinMaxBase = _print_Function` entered the set as the templates' `_after` form on `_print_list`'s return (the file's own `_print_tuple = _print_list` pattern) and reached Jev at step 5 with **p 0.03** against 0.38 for the wrong target `_print_MinMaxBase = _print_list` and `none_of_these` 0.49; never run. The `MCodePrinter` class-body gap of §20.4 was never a site: `where` chose `mcodeprinter_print_function` (p 0.81) every step and the gap after that method (L103) is the line-and-kind the function's own block-end gap slot already occupies among the located sites, so `introspectionSites`' deduplication (`siteKey` = path:line:kind, §20.1 item 5) is the likely reason the class gap was dropped — the transcript shows only the import gap `mathematica.py:9` added at every re-localisation (steps 1, 6, 9, 15, 18). |
| sympy-17139 | `ranked_run_but_regressions` (39 tested) | same (771 tested, 0 plausible) | introspection harvested `rv.exp: ImaginaryUnit (63 predicates, receiver)` and the guard template produced `if not rv.exp.is_real:` / `return rv` — **tested live** (sha12 in `tried`) but only at the gap **before L505**, inside the body of `if (rv.exp < 0) == True:` (dead code: the comparison raises first); at the gap before L504 (the gold's) neither form is in `tried`. The introspection sites went to `sympy/core/expr.py:420` (the class-body gap of `Expr` after `__lt__`, where the frames end), not to `fu.py`. Scoped baseline 107 s under load; regression runs 83 s median at step 10. |
| sympy-19954 | **solved** (step 4, RANK, 25 tested, 3 plausible) | `ranked_run_but_regressions` | the scoped baseline took 41 s (11 s in every earlier run; two sympy tasks with 8 lanes each were running), the derived runs-per-step (§21.2 item 1) collapsed to 6–10 (`runs left 1483, test wall left 0 s`, `5 tested (5 regressed); regression run median 81542 ms; 3 deferred`), step 4's SIEVE ran 379 of 762 and the winning guard was not among them; at step 17 Jev ranked `if i >= len(num_blocks): break` **first (p 0.46)** — the line that solved the instance twice before — and the step's five runs went to candidates whose regression runs timed out; it was never run (not in `tried`). |

**Reach-target check** (`experiments/inspect/reach-check-3.mts`, all from the run records: `synth introspect`/`history`/`localize` lines,
the `fix` Choice options in `decisions.jsonl` (compact Nouls carry the text in the unrecorded state, so "shown" is a lower bound), the
`sha12(unifiedDiff)` of the target at every plausible placement against `synthState.tried` (the newest ≤ 3,000 hashes), `model_patch.diff`):

| instance | target (`swebench-reach-oracle-9.md`) | introspection harvested | history harvested | introspection sites added | target shown to Jev | target tested live | plausible in run | committed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-15345 | `_print_MinMaxBase = _print_Function` (class-body alias) | yes: 4 operands, 13 classes (`Max`, `MinMaxBase`, …), 56 predicates, 834 ms | 5 commits, 9 change runs (`-Smathematica_code`, `-SMax`) | import gap `mathematica.py:9` only (class gap deduplicated) | **yes**, step 5, as `<return of _print_list>\n    _print_MinMaxBase = _print_Function`, p 0.03 | no (0 of 82 placements; `tried` truncated at 3,000 of 3,420 but step 5 is inside the window) | 0 | – |
| sympy-17139 | `if not rv.exp.is_real:` / `return rv` before `fu.py:504` | yes: `rv.exp: ImaginaryUnit (63 predicates, receiver)`, 869 ms | 5 commits (`-STypeError`, `-Sbottom_up`, `-S__lt__`) | `expr.py:420` (class gap of `Expr` after `__lt__`), `expr.py:3859` (import gap) | no (6 options in 1 Choice; SIEVE otherwise) | **yes — at the wrong gap** (2-line guard before L505, inside the `< 0` body); not at L503/L504 | 0 | – |
| sympy-19954 | `reversed(list(enumerate(rep_blocks)))` / the L2201 guard | yes: `self: PermutationGroup (72 predicates, receiver)`, 925 ms | 5 commits, 48 change runs | `perm_groups.py:2215` (class gap after `minimal_blocks`), `:20` (import gap) | guard **yes**, step 17, ranked #1 p 0.46; `reversed(list(…))` no | neither (389 hashes, complete) | 0 | – |
| sympy-11618 | `zip_longest(…, fillvalue=0)` + import | yes: `Point(2, 0): Point2D`, `Point(1, 0, 2): Point3D`, 54 predicates | 5 commits (`-Ssqrt`) | import gap `point.py:26` | no | no (33 placements) | 0 | – (run died at step 5) |
| django-15315 | `return hash(self.creation_counter)` (statement site 545–549) | `the target statement has no expression to evaluate` (an `assert`), 448 ms | **`ticket #31750: 1 commit`**, `-S__hash__: 2` (7 git commands, 1,457 ms) | import gap `__init__.py:30`; later `reverse_related.py:143` (class gap of `ForeignObjectRel` after `__hash__`) | no (0 Choices: every step SIEVE) | **no** (167 hashes, complete): four SIEVE steps dispatched 39/518, 43/573, 33/350, 52/344 candidates and stopped at the passer cap (5 dead-code "passers" each) before the reversal's turn | 20 (all false) | 4 dead-code inserts; evaluator fail |
| requests-2931 | `return data` at `models.py:84` | yes: `data: bytes (receiver)`, 271 ms | 4 commits (`-Sto_native_string`) | `models.py:100` (class gap of `RequestEncodingMixin` after `_encode_params`), `:36` (import gap) | no (SIEVE) | **yes** (sha12 in `tried`), classified `unchanged` by the network oracle | 1 (the wrong `decode` line) | the wrong line; evaluator fail |
| sympy-12096 | `nfloat(self._imp_(*self.args), prec)` | yes: `f(g(2)).evalf(): f (54 predicates)`, 762 ms | 5 commits, 131 change runs (`-S_eval_evalf`, `-SFunction`, `-S_imp_`) | `printing/str.py:16` (import gap), later `str.py:152` (class gap of `StrPrinter` after `_print_Function`), `core/evalf.py:29` | **yes**, step 10, `none_of_these` p 0.69 (and `return not nfloat(…)` 0.56) | no (2 placements; `tried` 3,000 of 3,406, step 10 inside the window) | 0 | – |

Reading: the §20 wiring did what §18/§20 built it to do at the harvest and enumeration layers — introspection ran on 9/9 oracle
instances (271–1,395 ms) and the history harvest on 9/9 (105–1,457 ms), the test-passing line is now in the set on **4 of 7** targets
(15345 alias, 17139 guard, 2931 gold line, 12096 `nfloat`; plus 19954's known guard) where the BEFORE runs had it on 2 (2931, 12096) —
and **none of the four was run at the right place under a verdict that could accept it**: one ranked at p 0.03 and one at
`none_of_these` 0.69 (never run), one run at the wrong gap, one run and rejected by a network oracle. The two introspection-derived
class-body gaps that mattered (15345's `MCodePrinter`, 15315's `Field`) were not created (deduplication; an `assert` target), while the
ones that were created pointed at the frame's class in another file (`Expr` in `expr.py`, `StrPrinter` in `str.py`).

Run ids (`~/.jevcode/runs/<id>`; bench `20260921-002827-57b7e1`, workspaces `~/.jevcode/runs/bench-work/20260921-002827-57b7e1/<instance>/jev-only/workspace`): django__django-14725 `20260921-011154-uef7ophs`, django__django-14787 `20260921-010737-lzn7uxjd`, django__django-15103 `20260921-011225-top3a3em`, django__django-15128 `20260921-011531-f6snsbqf`, django__django-15315 `20260921-010903-ovz3tdxe`, django__django-15375 `20260921-011312-ij7bpwi3`, django__django-15563 `20260921-011325-apeg44vo`, django__django-15572 `20260921-010937-oenjksh4`, django__django-15916 `20260921-011413-2eehkcmv`, django__django-16100 `20260921-011016-spgzc3yg`, psf__requests-1142 `20260921-012047-k75sv2ec`, psf__requests-2931 `20260921-012137-n2qruss4`, pylint-dev__pylint-4604 `20260921-012012-tfofybu2`, pylint-dev__pylint-4970 `20260921-012009-naww44fi`, pylint-dev__pylint-6386 `20260921-012055-xafmmcq6`, pytest-dev__pytest-10051 `20260921-011821-aoszxnim`, pytest-dev__pytest-10081 `20260921-011524-iojhkg62`, pytest-dev__pytest-10356 `20260921-011908-lizsgbpu`, pytest-dev__pytest-7205 `20260921-011621-pbpwnyxb`, pytest-dev__pytest-7324 `20260921-011822-biu4janm`, sympy__sympy-11618 `20260921-005347-6mtvzpr3`, sympy__sympy-12096 `20260921-002836-aoveivn2`, sympy__sympy-12489 `20260921-010602-es6o7c5q`, sympy__sympy-13798 `20260921-005732-5j5s66gq`, sympy__sympy-15345 `20260921-002836-qkza6rb3`, sympy__sympy-16792 `20260921-005827-v245k6j2`, sympy__sympy-17139 `20260921-004037-cvx24qye`, sympy__sympy-19954 `20260921-004052-jx3hxdij`, sympy__sympy-20428 `20260921-010247-sfdph44i`, sympy__sympy-22080 `20260921-010355-wb5ziixy`.

### 21.6 The most binding remaining constraint: the verdict a candidate receives, not the candidate set

Rung 2's verdict (§16, §18: "the test-passing line is in no source's set") no longer describes the oracle instances: after §20 the
line is in the set on 4 of the 7 reach targets and the two known winners (19954's guard, 15128's) were enumerated too. What decides the
run now is what happens to a produced candidate between enumeration and commit, and the records show three ways the verdict fails it,
in order of how many instances they cost this run:

1. **The oracle's verdict is not trustworthy, and the sieve commits the first five things it accepts.** All three commits on oracle
   instances failed the evaluator, each for a verdict defect that the records name: django-15315's reproduction is a 1/8 coin
   (§21.4 addendum: `AssertionError ×13, PASS ×3` in 16 runs of the runner's own command in the workspace *and* in the lane,
   `hash(None)` address-based on 3.9), so the 8-lane SIEVE reaches the passer cap with dead code every step (`[step 2] synth verify:
   g1: 39 tested on 8 lanes (34 unchanged, 5 plausible)`, `[step 2] synth guard: … arbitrated 5 passers (0 held) in 1 cluster (no
   probe); escape 0.41 … pick mutation/statement_template at django/db/models/fields/__init__.py:550:insert`, ×4) and the reversal the
   history source produced from the ticket's own commit (`[step 1] synth history: 5 commits, 21 change runs in 3 files (7 git
   commands; ticket #31750: 1 commit; …)`) was never dispatched (167 hashes in `tried`, none of them the statement site's reversal);
   requests-2931's oracle is a network round trip, so `return data` was run and read `unchanged` while a wrong line read `plausible`
   (`[step 4] synth verify: g1: 411 tested on 8 lanes (406 unchanged, 4 regressed, 1 plausible)` → `[step 4] proposal patch … apply
   verified fix: repro::b5e65acf now passes (85→86 of 168), no regressions; donor/statement_donor at requests/models.py:84`, then
   `[step 6] outcome executed: exit 1` on the engine's own suite run and six blocked re-proposals); django-15563's weak oracle
   (`differs_from_actual`) accepted `self.append(query)` (`[step 3] synth guard: … all-overfit signature, holding …` then `pick
   mutation/statement_template at django/db/models/sql/compiler.py:1840:insert`). The design already has the instruments — the second
   run that confirms the *base* verdict (§21.2 item 3), the guard's behaviour clusters and overfit signature, the passer cap — but a
   `plausible` is still one lane run, and one lane run of a flaky, networked or weak oracle is not a verdict. The lever is a code rule:
   a passer is `plausible` only after a second lane run agrees (halves the throughput of passers only, which are ≤ 5 per step anyway),
   a `values`/`no_exception` criterion whose base run needs the network is `unstable` (the runner sees the `ConnectionError`), and a
   weak oracle's passers must clear the F2P-style check the guard's `clusterByBehaviour` was built for before a commit.
2. **The verification budget collapses under load, and the ranked winner is not run.** sympy-19954 solved twice on the same code
   path (§21.3: step 4, 25 tested, 3 plausible) and lost here because two sympy tasks shared the machine with 8 lanes each: the
   establishing baseline read `104/107 scoped tests pass … in 41353 ms` (11,139 ms in Table A), the §21.2 item-1 formula then reserved
   five 41-s regression runs out of a 330-s test wall and handed out `runs 6`, `runs 10` per step (`[step 7] synth verify: g1: 6 tested
   on 8 lanes (6 unchanged); … runs left 1483, test wall left 0 s; … 6 deferred`, `[step 10] … 5 tested on 8 lanes (5 regressed); …
   regression run median 81542 ms; 3 deferred`), and at step 17 Jev ranked the known fix first — `candidate_aa "if i >=
   len(num_blocks):\n break" p 0.46` — while the step's five runs went to candidates whose 72–82-s regression runs read as
   regressions; the guard is not in `tried`. sympy-17139 shows the same shape (`[step 1] synth baseline: … in 107019 ms`, `[step 10]
   … regression run median 82955 ms`). The formula was derived from idle timings (§21.2: "sympy-15345 as measured idle … 108 a
   step"); measured under `--concurrency 2` the same instance's t_run(fullSuite) is 4–10× longer and the passers' regression runs
   time out. The lever is to measure `t_run` per step from the lanes rather than once at the baseline, to run the goal subset for the
   whole ranked top-k before any regression run (so a ranked winner is at least classified on the reproduction), and to keep the
   regression run's timeout above the observed lane median.
3. **Jev's rank does not carry the right line to the lanes.** 152 of 160 `fix` Choices on the oracle instances answered
   `none_of_these` (sympy-12096 31/31, sympy-15345 66/68, sympy-16792 53/57); the two test-passing lines that reached a Choice were
   read literally and lost — `return nfloat(self._imp_(*self.args), prec)` (`none_of_these` p 0.69 at step 10; the BEFORE run's step 11
   read 0.69 and 0.59) and `_print_MinMaxBase = _print_Function` (p 0.03, behind `_print_MinMaxBase = _print_list` at 0.38). In RANK
   mode only the top-k of a site's ranking run, so a line at 0.03 is never tested although SIEVE would have run it for 1–2 s of
   python. The reach study predicted this ("the guard's clustering and arbitration, not the enumeration, decides"); the record adds
   that on a cheap oracle (0.8–2 s reproductions here) RANK is the wrong mode for the seeds that introspection and history contribute
   — they are few (4 aliases, ≤ 5 reversals, one guard predicate per receiver) and should bypass the rank to the lanes as a
   code-prioritised batch, the way §15 runs a site's seed sources as one SIEVE batch.

Behind all three sits the site question the wiring left open: the introspection-derived text landed at a *legal* place only by
accident (the alias via `_print_list`'s `_after` form; the `is_real` guard inside the `< 0` body, dead), because the class-body gap
that §20.4 verified offline was deduplicated against the function's gap slot at the same line (15345) or never existed (15315's
`assert` target), and because the guard template writes into every gap of the located function without asking whether the guarded
statement is reachable there. Those are §20.1 item 5 and templates/guards.ts placements, code-side and measurable offline; they are not
the binding constraint because even a correctly placed alias would have met (3) and a correctly placed guard (2).

**Defect first.** Before any of the above is measured again, the history/ranker site mismatch of §21.5 has to be fixed: it killed nine
runs and sympy-11618 in this round, so the AFTER numbers for the 20 no-oracle instances are not comparable with Table B (10 `error`
stops at steps 4–6 against 25-step runs there), and the sympy-11618 row is not a search outcome.

Budget for this section: live Jev **$1.163** (rung-3 run); the BEFORE re-run of §21.3 A was the budget agent's $0.198; offline checks
$0. Total live spend of this task under the $5 cap.

### 21.7 Amendment (coordinator's notes after the hand-off): the nine `error` stops are one wiring defect, and what actually lost sympy-19954

**Reclassification.** The nine `error` stops of §21.5 (django-15375, -15572, pylint-4604, -4970, -6386, pytest-10081, -10356,
sympy-20428, sympy-11618) are one defect, not a search or oracle outcome, and are classified **`wiring_defect_history_site`**: the
ranker invariant `error internal: ranker: candidate "hist_…" is at <file>:1679 (replace), not at the site being ranked (<file>:1686,
replace)` (`~/.jevcode/runs/20260921-011312-ij7bpwi3/transcript.log` line 31, django-15375) — §20's wiring lets git-history reversals
ride with the donor seed while `history/source.ts` sites each reversal at its own line, so a foreign-site candidate reaches
`rank/index.ts:307` and every propose fails with `propose: internal` until the engine stops after three. A fix agent is on it.
`experiments/inspect/swe-report.mts` now emits the class (an `error` stop whose transcript carries the ranker line). Corrected
breakdown for `bench/results/jev-only-swebench-3`: **`wiring_defect_history_site` 9, `no_oracle_best_guess_rejected` 7,
`no_oracle_no_guess` 4 (django-15103, -15916, sympy-12489, -13798), `evaluator_fail_on_committed_patch` 3, `ranked_run_but_regressions`
3, `reachable_not_ranked_in_budget` 2, `solved` 1, `best_guess_wrong` 1**; the `no_search` row (sympy-11618) is in the defect class.
Totals otherwise unchanged (solved 1/30, oracle 10/30, Jev $1.1633).

**sympy-19954: passed in 6 steps on d610d75 (`bench/results/jev-only-swebench-2`, run `20260921-000331-sxnrfz76`), `max_replans` at
21 here (`20260921-004052-jx3hxdij`).** Read from both transcripts, `state.json` `tried` and `steps.jsonl`:

1. **History reversals did not displace the winning candidate.** The winner is a *template* (`template/guard_index_break`, the
   two-line `if i >= len(num_blocks): break`); the history reversals ride only in the donor seed (`src/synth/index.ts:184-185`:
   `[...reversals, ...plainDonor.enumerate(site, o)].slice(0, cap)`), and at rung 3's first site the seeds read `mutation 254, template
   254, donor 254` (step 4; `template 117, donor 245` at 7, `111/245` at 10, `109/245` at 17 after the source rotations) — the donor
   seed was cut at the cap with the 48 harvested change runs at its head, the template seed was not. The guard variants **were
   enumerated and run**: `sha12(diff)` of `if i >= len(num_blocks): break`, `if i >= len(blocks): break`, `… return False` (×2) are in
   `tried` — correcting §21.5/§21.6, which said the guard was never run — but every one **at the gap after the raising `del`**
   (`perm_groups.py:2202:insert (gap, indent 24) — insert after anchor L2201`), where a guard cannot prevent `del num_blocks[i]` from
   raising. At the gap **before** the `del` (`2201:insert`, where both BEFORE runs found the fix: `pick template/guard_index_break at
   sympy/combinatorics/perm_groups.py:2201:insert`) no placement of any variant is in `tried`: that site was never visited in rung 3.
   Every `synth site:` line of the run names `2202:insert` (steps 4, 7, 10, 17); step 4's budget line reads `progress: 1 new site of 1
   tested`, step 7's `nothing new: 1 of 2 stagnant`.

2. **What changed is the oracle class, and it changed because the reproduction got fast.** `budget.ts:575 oracleClass`: a goal subset
   under `QUIXBUGS_CLASS_MAX_T_RUN_MS` = 2,000 ms is `quixbugs_class` → `freshBudget` gives **1,500 runs** and a test wall of
   `min(90 s, wallRemaining / 4)`; otherwise `repository_class` → the §21.2 item-1 derived count (16–160) and a wall of 8 × the scoped
   baseline. `decideRunPlan` then takes SIEVE iff `n ≤ runsLeft && tRun ≤ 2,000 ms`. On d610d75 (Table B) sympy-19954's reproduction
   measured **3,500 ms** (the process was at 4–8 GB with 1.3–1.6-s mark-compact pauses): repository class, `runs 27` of a derived 77,
   RANK with K = 5–6 per site, four batches (`6 … 5 … 5 … 5 tested`, `test wall left 153 s` after the first) that reached `2201:insert`
   in the fourth (`3 plausible`), commit at step 4. In rung 3 the same reproduction measured **916 ms** (the §20 memory fix; every rung-3
   oracle instance but sympy-16792 measured 0.27–1.5 s against 3.3–4.7 s in Table B): quixbugs class, 1,500 runs, **SIEVE** over the
   first site's 762 candidates, and the 90-s wall was gone after 379 of them (`runs left 1114, test wall left 0 s; regression run median
   47987 ms` — four reproduction passers each paid a 48-s scoped run). Steps 7, 10 and 17 re-entered the same first site with a fresh
   90-s wall that one or two 72–82-s regression runs consumed (`6 tested … 6 deferred`, `5 tested (5 regressed) … regression run median
   81542 ms; 3 deferred`, `0 tested (nothing ran) … 5 deferred`), so the second site never came up. The class rule is d610d75's, not §20's
   (d610d75 is an ancestor of 5486f7a; sympy-16792 hit the same 1,500/quixbugs branch in Table B with a 1.3-s reproduction): §20 changed
   its input by making the establishing step 3–4× faster.

3. **The other §20 mechanisms are visible and inert here.** Introspection sites were appended *after* the located ones
   (`perm_groups.py:2215` class-body gap, `:20` import gap) and never reached; the raising `del` is a one-line statement, so no
   statement-level site; the phase stayed SEEDS (the step-6 directive enabled WIDENED, which the budget never reached). The site
   *order* — the anchor's after-gap first — is the same `orderGoalSites` as before; RANK's small K walked past it, SIEVE did not.

Consequence for §21.6 item 2: the load story stands, but its mechanism is sharper than "the derived count collapsed" — a sub-2-s
reproduction puts a repository run in the QuixBugs class, whose 90-s wall and unbounded SIEVE were sized for 0.1-s tests, and one
48–82-s regression run then ends the step. The lever is `oracleClass` reading the *full-suite* cost as well (a repository whose scoped
run takes 10–100 s is never QuixBugs-class), or the wall of the quixbugs branch bounded by the measured regression run.

## 22. 2026-09-21: progress commits and no `read` churn — the long tier's `masked`, `shared_frame`, `long_chain`, `six_hunks`

Follow-up to §19.7 items 1 and 4: the lone partial that was found, ranked first, run, classified `partial` and dropped at
every park (`masked`, `long_chain`, the merged goals of `shared_frame` and `six_hunks`), and the 7–12 declined `read`
proposals per miss that tripped the loop detector into `max_replans`. Two rules, both bookkeeping the harness knows for
certain — which partial it holds and what the tests said about it; which files it already holds — plus the one
measurement a partial commit was missing (the runner never ran the full suite for a partial), and three rules the first
live run of the tier on them added (20.1 item 6). Jev decides what it decided before (Q16 on a suspicious candidate,
Q15/Q16 on an arbitration, Q1/Q2/Q5 at a re-localisation); the tests verify. Code =
`src/synth/search/{bases,guard,subgoal,goals,index,directive,proposal,types}.ts`, `src/synth/sieve/runner.ts`; tests under
`test/unit/synth/search` and `test/unit/synth/sieve`.

### 22.1 What changed, per item

1. **Progress commits.** `subgoal.ts commitProgress` (:637) runs at every step end of a goal: the `budget` exit
   (`exitOnBudget` :896, after the pairs reserve and the held passer of §15) and the exhaustion tail (:1019, where §2.3's
   `commitPartial` line always was and was never reached live). When the goal holds a partial — the improved base
   `holdBestPartial` keeps: most newly passing, then the code tie-break — it is committed as a **partial fix** instead of
   the goal parking with nothing. Order: (a) untested pairs of complementary partials first (§15): a passing pair beats a
   lone partial, and when the pairs could not run this step the goal stays open and runs them next step (index.ts
   `case 'budget'`, unchanged); (b) the one full-suite regression run the commit rests on (`sieve/runner.ts
   runRegressionCheck` :783 — see item 2); (c) the guard's suspicion signals with the Q16 advisory, exactly as for a
   lone passer (`guard.ts gateHeldPartial` :894: no signal → commit; signals → one Q16 `general_cand_01`, held below
   LONE_PASSER_HOLD_MAX_NOUL 0.3 (one signal) or LONE_PASSER_VOUCH_MIN_NOUL 0.7 (two or more), committed at or above; the
   advisory is cached per candidate in the guard state (`bases.ts partialAdvice` :139) so an incumbent that survives a
   step is asked about once and a doubtful one stays held without another request; with no Jev request left the flagged
   partial is held and asked next step). The controller has the same check as its own guarantee after a search that
   returned without a commit (`index.ts progressCommit` :697, mirroring §13.4 (b)'s held-passer rule at :609). The
   commit is `{ kind: 'commit', allGoalTestsPass: false, note: 'partial', after: <the regression run>, outcome }`
   (`bases.ts commitPartial` :479); `goals.ts noteCommit` (:585) keeps the goal `open`, counts one `progressCommits`,
   and drops its exhausted sets, tested sites and phase (the remaining tests fail for a new reason at a new frame).
2. **The regression run a partial never had.** `sieve/runner.ts verifyJob` runs the full suite only for subset passers, so
   a `partial` was classified from the goal-subset run alone (the goal's test files): "nothing newly failing anywhere"
   was not a measured fact — a variant of `shared_frame`'s helper relaxation that passes 3 of the goal's 6 booking tests
   and breaks `tests/test_checks.py` is a `partial` to the batch. `runRegressionCheck` (:783) makes that one run on a
   free lane before the commit: the candidate applied over its own base's files, the baseline's full-suite command at
   the reference settings of `runQueue` (every case's verdict, no stop rule), the lane timeout, charged as one run — the
   commit's verification, not search cost, so it runs at a budget exit too. A partial that regresses, times out or
   passes none of the goal's tests on the whole suite is dropped (`bases.ts dropHeldPartial` :408: the base leaves the
   beam and the remembered partial goes with it, so no pair is built on it); one the lanes cannot run (no pool yet,
   aborted) stays held. On the QuixBugs runner the subset is the suite and no extra run is made. Live (20.3): 3 of the
   8 partials `six_hunks` held at a step end regressed on the full suite and were dropped — each a `partial` to its
   batch.
3. **The remaining tests stay open and re-cluster.** `goals.ts reconcile / inheritGoalState` already carried a fresh
   cluster onto the prior goal by test overlap and never marked a fresh cluster fixed; checked and left as is, with the
   chain rule added (:520): a goal that took `MAX_PROGRESS_COMMITS_PER_GOAL` = 3 progress commits hands its remaining
   tests to a **new goal id** with fresh counters (the prior is consumed, never `fixed`), so the ledger shows the chain;
   `index.ts rebaseline` (:828) notes it. `progressCommits` rides on `Goal` (`types.ts` :50, in-memory like
   `budgetSteps`; a resumed run starts the count at 0).
4. **The proposal says partial.** `proposal.ts patchGoalText` (:177): `apply partial fix: k of n goal tests pass (<tests>)
   (N→M of T), no regressions; the remaining m stay open; <source>/<op> at <path>:<line>`, k counting the GOAL's tests
   among `newlyPassing` (`goalTestsPassing` :154); the `openProblems` note is `partialFixSummary` (:160) — `partial fix: k
   of n goal tests pass, no regressions; the remaining m stay open (<edit>)`; the evidence is the regression run against
   the committed baseline (`newlyPassing` = its tests, `goalTests` = the goal's; `commitEvidence` reads `after`). The
   post-patch `run` claims nothing (only `fixed` goals are claimed, §10) and its goal text states the expected counts.
   The risk stage read every live partial patch as `ok` (0.25–0.27, "evidence verified: N→M of T pass, no regressions").
5. **No `read`, ever.** The transcripts of runs 1b–2 put every declined read at `index.ts investigateRead` ("intent is
   investigate: reading …", steps 2–3 of every run, before any replan) and the `gather_context` branch of `directive.ts`
   said "nothing to change" (every goal parked) — so both went: `investigateRead`, `INVESTIGATE_READS_MAX`,
   `unseenSourceFiles` and `relevantSourceFiles` are deleted from index.ts (the search proceeds under every intent, :558),
   `proposeRead` and `READ_MAX_PATHS` from proposal.ts (the builders are `patch`, `run`, `done`), and `gather_context`
   (`directive.ts` :206) re-localises every open goal with Jev on its latest failure (sites dropped: Q2/Q5 again; Q1
   among several open goals as usual) with the top-10 file beam and its source order rotated, then continues to the
   search — the next `run` or `patch`. With no open goal, the goals parked by the §5.3 counters or for want of a site
   (`goals.ts parkedWithMoreToTry`; never a park at exhaustion or a timed-out suite) are reopened the same way with
   their attempts reset — the directive says the repeated step rested on a wrong assumption, and a search's assumption
   is its localisation, which the directive redoes (run 3's `shared_frame` parked its one goal after three budget-hit
   searches and spent steps 5–11 on a blocked partial `done`). With nothing left to try nothing changes and the
   controller proposes the honest partial `done`.
6. **Three rules run 3 added** (20.3 is the evidence). (a) **Stale `unchanged` verdicts.** `tried` is keyed by the diff
   hash, which does not change when another file changes, so a candidate judged `unchanged` under a masking failure
   stayed excluded after the progress commit lifted the mask: `long_chain` step 2 ran candidates at `clean.py:12` in
   RANK mode under the `load.py` crash, and step 4's whole-site batch there had 40 of the 165 mutation and 150 of the 156
   template candidates already tried — the gold `row.name` among them (the reach probe puts it at mutation index 40,
   template index 69) — while a wrong partial at the same line (`Row(row, …)`, 2 of 13 tests) was committed and the run
   could not recover. `sieve/runner.ts` records the `unchanged` hashes per goal (`RunnerMemory.unchangedTried`, set in
   `verifyJob`) and a progress commit forgets them (`forgetUnchangedTried`; index.ts `case 'commit'`): an `unchanged`
   verdict is a fact about the failure the goal had when it ran, and the commit removes that failure for the remaining
   tests; `regressed`, `plausible`, `partial` and hang verdicts stay tried. Run 3b: step 2 forgot 1,302 of them and step
   4 committed the gold `clean.py` line (3 of 13, 13→16). (b) **One patch, two files.** `six_hunks` step 3 held a pair
   built on a pair (render.py + sorting.py + model.py) as the progress commit; `proposePatch` refused the 3-file diff
   after the ledger had recorded it (`outcome failed: propose: internal`). `bases.ts pairsOfPartials` never builds a pair
   beyond MAX_PATCH_FILES files, and `commitProgress` drops a held partial whose cumulative patch exceeds it before
   anything is recorded (`unproposable`). (c) **The all-overfit bound.** `masked` step 4 arbitrated five `return 0`
   inserts into `aggregate.total_ms` (each passes the two goal tests whose logs carry no durations): escape 0.75 (run 3)
   / 0.67 (run 3b), max general 0.08 — the all-overfit shape of §13 under its 0.8 escape bound by a wider margin than
   `wrap`'s one tick, committed as a verified fix at the fourth of the step's twelve sites (the gold `e.ms` replace site
   was next), after which the goal's other two tests (`total_and_slowest`, `render_full`) could never pass. Every
   measured all-overfit set now sits at escape 0.67–0.91 with max Noul ≤ 0.08; every gold-containing set at escape
   ≤ 0.38 with a Noul ≥ 0.45; `SUSPECT_ESCAPE_MIN` is 0.5 (`guard.ts` :81), the Noul half of the signature unchanged,
   and a flagged set is still held only within the step (the search runs on to the remaining sites; committed as
   `possible overfit` at the step end if nothing better appears). Measured on run 3c (20.3).

### 22.2 Tests

`subgoal.test.ts` "progress commits: a step that ends with a partial in hand commits it as a partial fix" (6): the lone
partial committed at the budget exit (`partial`, `allGoalTestsPass` false, `after` = the regression run, 2 test runs, the
base gone, the `synth progress:` line); a suspicious lone partial (`pass` for the statement → `deletes_statement`, Q16
0.10 < 0.3) held — `budget`, base kept, advice cached, the next step asks nothing and parks; a passing pair beats a lone
partial at the budget exit (batches `[argument_swap], [pair_of_partials]`, no progress commit); a held partial whose
regression run breaks another test is dropped (base and remembered partial gone); a held partial whose cumulative patch
edits 3 files is dropped as unproposable before any run; a held partial that cannot be verified stays held.
`controller.test.ts` "progress commits: a lone partial at the budget exit …" (4): the controller commits a held partial
on a `budget` result with the partial-fix goal text, evidence (`newlyPassing` = its test, `goalTests` = both), note,
`rawText` outcome/note `partial`, the goal open with `progressCommits` 1, the goal's `unchanged` hashes gone from `tried`
(a regression's stays); with an untested pair the pair comes first (goal open, no regression run); after a partial
commit the next baseline re-clusters the remaining tests by their new frames into g1 (kept id, `gcd.py:helper`) and g2
(`other.py:f`), none fixed, ledger `fixed 0, open 2`; a `gather_context` directive through the controller re-localises
and rotates and the step is a `patch`, no `read` event. The three tests that asserted reads now assert the run/patch
instead. `goals.test.ts` "progress commits and the chain rule" (2): `noteCommit(false)` counts and resets; `reconcile`
keeps the id below the cap and hands the remaining tests to `g3` with fresh counters at it, the parked neighbour
untouched, nothing fixed. `guard.test.ts`: "gateHeldPartial" (3) — clean → commit with `after`/`outcome`; one signal →
one Q16 request, held below the bound, cached (a throwing ask on the second call); vouched at 0.8 → commit, `no_request`
with 0 requests left — and the signature test now holds the `masked` shape (escape 0.67, Nouls 0.08/0.05) and commits
the highest gold-containing shape (escape 0.38, Noul 0.45). `bases.test.ts` (3): `heldPartialOutcome` (recorded by
`holdBestPartial`, the by-hand fallback), `commitPartial` with the verified run, `dropHeldPartial` (the pair built on the
dropped partial is gone), `forgetHeld` clears the recorded outcome; `pairsOfPartials` skips the 3-file pair and builds
the 2-file ones. `directive.test.ts`: "gather_context never proposes a read …" replaces the repository-read test;
every-goal-parked reopens the counter-parked and no-site goals with attempts reset and leaves the exhausted and
`suite too slow` ones parked. `runner.test.ts`: "runRegressionCheck …" (null before any pool; after a batch one `python3
-m pytest -q` on a lane with the candidate written there, reference env — case cap set, no `JEVCODE_MAX_CASE_TIMEOUTS` —
one run charged, the `synth verify:` line); the `unchanged` verdict recorded under the goal and `forgetUnchangedTried`
(1 forgotten, the passer's hash stays). `proposal.test.ts` / `proposal-evidence.test.ts`: the partial texts;
`proposeRead` tests removed; `ALLOWED_KINDS` is `patch`, `run`, `done`. Gates: `tsc --noEmit` clean outside the peer WIP
paths (`src/tui`, `src/config`, `test/unit/tui`, `test/unit/cli`), `no-any` ok, `vitest --project unit test/unit/synth`
80 files, 1,329 tests.

### 22.3 Live: `masked`, `shared_frame`, `long_chain`, `six_hunks`, three runs, concurrency 1, load average 30–70

Same flags as §19 (`--max-steps 30 --max-wall 15m --task-spend-cap 0.15`), one task at a time, from this worktree.
Run 3 = items 1–5 (00:45Z, `bench/results/jev-only-ladder-long-3`, $0.1369); run 3b = + 6a (stale `unchanged`
verdicts), 6b (the pair bound), `gather_context` reopening counter-parked goals only (01:11Z, `…-3b`, $0.1200); run 3c =
the committed code: + 6c (`SUSPECT_ESCAPE_MIN` 0.5) and the reopening of exhaustion parks (01:28Z, `…-3c`, $0.1021).
Columns as §19.3; "hunks fixed" = patched src line == gold line per planted edit (`/tmp/ladder-long/<task>.json`), `*` =
a test-equivalent edit at the planted line that is not the gold text; "progress commits" = partial fixes committed
(regression runs of held partials: how many of those regressed and were dropped); "re-clusterings" = goals whose
`synth goal:` file moved after a partial patch / goal sets that grew after one; `reads` = `read` proposals in the record
(in the transcript).

| run | task | hunks fixed | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | reads | progress commits (regr. runs: dropped) | re-clusterings | run id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3 | `masked` | 0/3 (h1 as an insert `txt = text`) | no | 12 | `replan_stop` | $0.0249 | 229 s | 136 | 6/0 | 2/1 | 0 (0) | 1 (1: 0) | 1 moved, 1 split | `20260921-004519-fegygevr` |
| 3 | `shared_frame` | 0/2 | no | 10 | `replan_stop` | $0.0292 | 191 s | 127 | 6/0 | 4/3 | 0 (0) | 0 (0: 0) | 0, 0 | `20260921-004909-mfilcexp` |
| 3 | `long_chain` | 2/6 (h1, h3) + a wrong line at h2 | no | 16 | `replan_stop` | $0.0410 | 393 s | 234 | 6/0 | 2/1 | 0 (0) | 3 (3: 0); chain → g3 | 1 moved, 1 split | `20260921-005221-ppjlgth7` |
| 3 | `six_hunks` | 1/6 (h6) | no | 15 | `replan_stop` | $0.0417 | 346 s | 249 | 6/0 | 3/2 | 0 (0) | 2 (5: 3) | 0, 0 | `20260921-005854-xgalunq5` |
| 3b | `masked` | 0/3 (h1 as an insert) | no | 12 | `replan_stop` | $0.0238 | 193 s | 134 | 6/0 | 2/1 | 0 (0) | 1 (1: 0) | 1 moved, 1 split | `20260921-011138-3nsr2bg3` |
| 3b | `shared_frame` | 0/2 | no | 10 | `replan_stop` | $0.0268 | 212 s | 121 | 6/0 | 3/2 | 0 (0) | 0 (0: 0) | 0, 0 | `20260921-011451-aouculk3` |
| 3b | `long_chain` | 2/6 (h1, h2) | no | 13 | `replan_stop` | $0.0282 | 244 s | 159 | 6/0 | 2/1 | 0 (0) | 2 (3: 1) | 1 moved, 0 split | `20260921-011824-m2gnwvsk` |
| 3b | `six_hunks` | 1/6 (h6) + h3* | no | 16 | `replan_stop` | $0.0412 | 313 s | 250 | 6/0 | 3/2 | 0 (0) | 2 (4: 2) | 0, 0 | `20260921-012229-vepcyv6x` |
| 3c | `masked` | 1/3 (h2) + h3*, h1 as an insert | **yes** | 7 | `complete` | $0.0135 | 187 s | 88 | 0/0 | 0/0 | 0 (0) | 1 (1: 0); 2 all-overfit holds | 1 moved, 1 split | `20260921-012803-ukg2vksa` |
| 3c | `shared_frame` | 0/2 | no | 8 | `replan_stop` | $0.0195 | 96 s | 92 | 6/0 | 2/1 | 0 (0) | 0 (0: 0); reopened 1 | 0, 0 | `20260921-013110-ap6quqpt` |
| 3c | `long_chain` | 2/6 (h1, h2) | no | 12 | `replan_stop` | $0.0250 | 220 s | 155 | 6/0 | 2/1 | 0 (0) | 2 (3: 1); reopened 1 | 1 moved, 0 split | `20260921-013246-p2gwdw3r` |
| 3c | `six_hunks` | 0/6 + h3*, h6* | no | 16 | `replan_stop` | $0.0441 | 312 s | 282 | 6/0 | 4/3 | 0 (0) | 1 (3: 2); reopened 2 | 0, 0 | `20260921-013627-abdmerii` |

Against run 2 (§19.5, the merged controller `d610d75`) on the same four: `masked` 0/3 25 steps `max_replans` $0.0380
10 reads; `shared_frame` 0/2 16 steps $0.0326 7 reads; `long_chain` 0/6 20 steps $0.0278 6 reads; `six_hunks` 0/6 + h3*
27 steps $0.0424 6 reads (29 declined reads in the four transcripts). Runs 3–3c: **0 `read` proposals in 12 runs**, 0
declined steps, every miss `replan_stop` at 8–16 steps (the repeated blocked partial `done`, 20.5), 5–8 gold hunks per
run of four where run 2 had 0, and `masked` solved in run 3c (7 steps, $0.0135) — the first solve of a chain goal in the
tier's five runs.

### 22.4 Per task

- **`masked`** — the designed shape happened in every run: step 2 committed the progress commit at `report.py:14` (a
  `sketch_P11` insert `txt = text`, 2 of 6, 16→18 of 22; the gold replace `parse_lines(text)` was enumerated but the
  insert reached the base first), the risk stage read it as `ok` (0.25, "evidence verified: 16→18 of 22 pass, no
  regressions"), and step 3's baseline re-clustered the remaining four tests into g1 (2 at `aggregate.total_ms`) and g2
  (2 at `parse.parse_line`) — `synth ledger: fixed 0, open 2`. Runs 3 and 3b then lost the task at step 4: the site
  batch before the gold's (`aggregate.py:19:insert`) held five `return 0`-shaped inserts, each passing g1's two tests
  (their logs carry no durations); the arbitration answered escape 0.75 / 0.67 with max general 0.08 — under the 0.8
  escape bound — and committed one as a verified fix, after which `total_ms` returned 0 and g2's tests could never pass;
  g2 exhausted 11 sites at step 7 and the blocked partial `done` ran to `replan_stop`. Run 3c, escape bound 0.5: the same
  five were held as the suspect (escape 0.69), a second set at `report.py:22` too (0.83), the search reached
  `aggregate.py:19:replace`, and the arbitration of 3 passers (1 held) — the gold `e.ms` among them — answered escape 0.01,
  max general 0.87 and picked it; step 6 fixed `parse.py:21` (`int(took[:-1 - 1])`, a `slice_tweak` equal to the gold
  `[:-2]`), 22/22, `complete` at step 7. 88 Jev requests, 0 blocked, $0.0135.
- **`shared_frame`** — 0/2 in every run, the §19.5 class: Q5 anchors `booking.py:29` (0.88) and `reserve` (0.82)
  correctly, `pricing.py` answers `none_of_these` (0.72; the true line 19 at 0.21); both steps run in RANK mode (t_run
  ≈ 0.45 s × 3,000 candidates), and of the twelve Q8 `fix` questions nine answered escape ≥ 0.6 — neither gold line was
  ever run (their diff hashes are absent from the complete 2,297-hash `tried` set of run 3c). Steps 16 → 10 → 10 → 8,
  cost $0.033 → $0.029 → $0.027 → $0.020, reads 7 → 0. Run 3c's `gather_context` reopened the exhausted goal (step 6) and
  the re-localisation named the same ten sites, all tried. The remaining lever is Jev's ranking at a confidently
  anchored site (20.5).
- **`long_chain`** — run 3: three progress commits and the chain rule (`g1 took 3 progress commits; the remaining tests
  continue as g3`, step 9): the gold `float(price)` (step 2, 10→13), a WRONG partial at `clean.py:12` (`Row(row, …)`,
  step 5, 13→15: 2 tests that never read the name) because the gold `row.name` had been tried under the `load.py` crash
  and was excluded (item 6a: the step-4 whole-site batch enumerated 125/6/0 mutation/template/donor candidates fresh,
  runs 3b/3c 165/72/45), then the gold `LABELS[row.kind]` (step 8, 15→19). The wrong line left one test (`test_clean_
  names_title_cased`) failing for good and g3 (6 tests at `totals.py:20`) parked "exhausted" at 12 sites none of which
  was in `totals.py`: Q2 `where` on `totals.py` answered `none_of_these` 0.86 (the bug is in a `lambda` inside `ranked`,
  the options are the named functions). Runs 3b/3c: gold `load`, gold `clean` (13→16), then the enrich goal (10 tests at
  `enrich.py:22 to_record`) parked at exhaustion of 9–10 sites — Q2 `where` on `enrich.py` module-level 0.36 / `to_record`
  0.14 and Q5 `line_10` (the `LABELS` dict) at every attempt, run 3's step 8 having anchored `to_record` and found the
  gold; the reopening (3c, step 10) re-localised to the same answers. One held partial per run was dropped on its
  full-suite regression run (`argument_swap` at `clean.py:12`: 4 of 10 goal tests newly passing, 2 newly failing). 2/6.
- **`six_hunks`** — the pairs machinery ran every step (1–5 pairs per step, the reserve of §15); the regression run
  dropped 3 of run 3's 5 held partials and 2 of 4 in 3b/3c (each a `partial` to its batch, a regression on the suite: the
  measurement of item 2 doing exactly its job); run 3's step 3 held a pair of a pair over three files, which
  `proposePatch` refused (item 6b). Committed: `stats.py:22` (`round(…, 1)` — gold, run 3/3b; `round(…, 3)` in 3c, test-
  equivalent) as a progress commit, and for `test_board` a pair (`t.due == None` + `line(t, width - 1)`, run 3c escape 0.47
  → committed; 3b `pair:relational_swap>negation`) that passes the three `test_board` cases but is not the gold
  (`is not None`; `width - 3`); `test_attention` and `test_summary` parked at exhaustion of 10–12 sites each (the golds
  `<= today`, `< last`, `//` are relational/arithmetic swaps at sites the lists held only as gaps). 1/6 gold + 1–2 test-
  equivalent per run; run 3c's reopening (steps 12–13) re-localised to the same sites.

### 22.5 What remains

1. **The innermost traceback frame is not a site by code.** `long_chain`'s `enrich.py:22 to_record` (KeyError) and
   `totals.py:20 <lambda>` (IndexError) are the innermost source frames of their goals' tracebacks, `goals.ts` clusters
   on them and names the file, and the site list never held the line: Q2 `where` answered module-level / `none_of_these`
   and Q5 followed. A replace site at the goal's frame line, before Q5's anchors, is a code fact (sites.ts, not edited
   here) and would have given both goals their gold within the step's budget.
2. **RANK mode at a confidently anchored site.** `shared_frame`'s `booking.py:29` (Q5 0.88) never ran its gold in three
   runs because Q8 ranked it out of the top-k or answered escape (`fixProbablyAbsent` marks the source exhausted). At a
   Q5 anchor ≥ 0.8 the site could run in SIEVE regardless of the run plan, or the escape rule could be suspended there.
3. **Progress commits are greedy by construction.** The wrong `Row(row, …)` was committed because the better partial was
   excluded (fixed); a wrong partial with no better one in the step is still committed, and the goal's remaining tests
   then fail for a reason the search cannot repair (a second edit at the same line is out of depth-1 reach). The cheap
   guard is one Q16 advisory on every partial commit, not only on a signal (one request per commit; the brief asked for
   signals only); the honest one is the `revert_changes` directive when a goal's remaining tests exhaust after a partial.
4. **`SUSPECT_ESCAPE_MIN` 0.5** rests on 8 all-overfit sets (0.67–0.91, Noul ≤ 0.08) and the gold sets measured so far
   (≤ 0.38, Noul ≥ 0.45). A QuixBugs 40 re-run is the check that no gold set falls in [0.5, 0.8) with max Noul < 0.1; the
   Noul half of the signature is what protects it.
5. **The blocked partial `done`.** Every miss ends the same way: every goal parked, `done` (partial) blocked at
   `plan_mismatch` 0.86–1.00 ("claims completion while `plan.remaining` is non-empty") three times, `gather_context`,
   three more, `replan_stop` — 6 blocked steps per miss, 40–55 % of the steps of a 12–16-step run. Loop-side: a partial
   `done` whose `remaining` lists the parked items is the honest report the design asks for (§5.5), and the engine
   refuses it by construction.
6. Three of twelve runs lost a step to a Jev transport or schema error (`jev_http: fetch failed`, `jev_response: … is
   not an argmax`); the search resumed on the active goal next step (§5.2).

### 22.6 Exact commands

```
# gates (worktree at 7ea40b2 + this section's files; the peer WIP under src/tui, src/config, test/unit/{tui,cli} is not here)
npx tsc -p tsconfig.json --noEmit && node scripts/no-any.mjs && npx vitest run --project unit test/unit/synth   # 80 files, 1,329 tests

# live (concurrency 1; .env in the main checkout; node_modules symlinked into the worktree); run 3, then 3b, then 3c on the code of each stage
NODE_OPTIONS=--max-old-space-size=8192 env -u ANTHROPIC_API_KEY node --env-file=<main>/.env node_modules/.bin/tsx src/cli/main.tsx bench --suite ladder \
  --task-id masked,shared_frame,long_chain,six_hunks --conditions jev-only --live --spend-cap 0.6 --task-spend-cap 0.15 --concurrency 1 \
  --max-steps 30 --max-wall 15m --out bench/results/jev-only-ladder-long-3      # then -3b, -3c; logs /tmp/ladder-long-3{,b,c}.log

# the tables (stdlib python; joins tasks.jsonl with ~/.jevcode/runs/<runId>/{transcript.log,model_patch.diff}; hunks per /tmp/ladder-long/<task>.json)
python3 /tmp/ladder-long/mdrows.py bench/results/jev-only-ladder-long-3c            # one markdown row per task
python3 /tmp/ladder-long/rows3.py bench/results/jev-only-ladder-long-3c long_chain  # counts + the compact timeline
# was a gold line ever run (its diff hash in the checkpoint's tried set, ≤ 3,000 newest hashes)
node node_modules/.bin/tsx .scratch/tried-check2.mts 20260921-013110-ap6quqpt shared_frame 1
```


## 23. 2026-09-21: confirmed passers, network-weak oracles, load-aware step sizing — the three verdict defects of §21.4/§21.6 as code rules (offline, $0)

Owner scope: `src/synth/oracle/{verify,search,runner}.ts`, `src/synth/search/budget.ts` and their tests; nothing in `search/{index,subgoal,guard,…}.ts`,
`synth/index.ts`, `history/**`, `rank/**` changed (what those must wire is listed at the end). No live call.

**Correction to §21.6 item 2 first.** The rung-3 records show sympy-19954 (`20260921-004052-jx3hxdij`) was not sized by the §21.2
formula at all: its reproduction measured 916 ms (3.5 s in the runs that solved it), so `oracleClass` read `quixbugs_class` — 1,500
runs, a 90 s test wall (`runs left 1483/1487` in every `synth verify` line), a SIEVE over the first site's 762 candidates (379 ran
before the wall was gone at step 4), and from step 7 on each 90 s wall went to one or two 48–82 s regression runs of *carried*
passers (`6 tested … 6 deferred`, `5 tested (5 regressed) … 3 deferred`, then `0 tested … 5 deferred`) dispatched ahead of the
step's fresh ranking; at step 17 the known guard ranked #1 was popped behind them and deferred. sympy-17139 (`…-cvx24qye`,
reproduction 881 ms, scoped 107 s) has the same shape. The formula was right and never consulted; the class was wrong.

### 23.1 Rules (file:line on the working tree)

1. **A lane pass is confirmed in the same lane** — `oracle/verify.ts:78-83` (`UNSTABLE_ACTUAL_PREFIX`, `isUnstableOutcome`),
   `:309-321`: a candidate whose reproduction passes is run once more on its lane before anything else; pass/pass → the scoped
   regression run → `plausible`; pass/fail → **unstable**: status `unchanged` (the shared `VerifyStatus` in `search/types.ts` is not
   this agent's to extend), `tried`, never dispatched to the regression run, the subset failure text prefixed `unstable:`, counted
   as `N unstable` in the batch's `verify` event (`… (1 unstable, 34 unchanged, …); … 1 passed once and failed the confirmation run
   (unstable, not regression-tested)`). Cost: one ≈ 0.4–1.4 s reproduction per passer (≤ 5 a step); django-15315's 1/8 coin
   becomes a 1/64 coin per dead-code candidate (≈ 0.6 false passers a step instead of the cap of 5), while the real fix passes twice.
2. **The base verdict is confirmed on both sides** — `oracle/search.ts:355-368`: `findIssueOracle` runs the snippet twice at the
   base commit in every case; fail/pass was already `unstable` (§21.2 item 3); pass/fail is now `unstable` too (`the reproduction
   passed once at the base commit … and failed when run again: its verdict is a coin`) instead of `passes_on_base`; pass/pass reads
   `already passes at the base commit (twice)`. Either `unstable` → no goal → the best-guess path.
3. **Network-dependent reproductions are `weak_network`** — `oracle/runner.ts:361-431` `detectNetworkUse(chunks, result)`: static
   (an import of `requests|urllib|urllib3|socket|http|httpx|aiohttp|…` or one of their call forms, together with a URL literal naming a
   non-local host; `localhost`, `127.x`, `::1`, Django's `testserver` do not count; `from django.http import …` is not a network
   module) or runtime (a statement raised one of the script's `NETWORK_ERRORS` types or a connection message). `oracle/search.ts:207`
   `OracleOutcome` gains `weak_network`; `:376-397`: such an oracle keeps its goal (it found the failure at base; requests-2931's
   `requests.put("http://httpbin.org/put", …)` → `network-weak oracle repro::… (…; network-dependent reproduction (requests against
   httpbin.org): passers need the regression run and Jev's arbitration)`), `strength` is `'weak'` (so the existing weak-oracle note
   in `search/index.ts` applies), `OracleSearch.network` carries the evidence, and the constants `NETWORK_ORACLE_OPEN_PROBLEM =
   'network-dependent reproduction'`, `oracleYieldsGoal(outcome)`, `oracleNeedsArbitration(outcome)` (`:210-224`) are what the
   controller and the guard wire. A base run whose network call failed while the statements around it "passed" is `env_error`
   (`the reproduction's network call failed (ConnectionError: …); the statements that ran show no verdict`, `:345-352`), not
   `passes_on_base`.
4. **The class reads both oracle costs** (the coordinator's rung-3 amendment) — `search/budget.ts:173` `QUIXBUGS_CLASS_MAX_FULL_SUITE_MS
   = 10_000`, `:604-606` `oracleClass`: QuixBugs-class only when the goal-subset run is < 2 s AND the scoped run < 10 s; a cheap
   reproduction in front of a costly scoped suite (19954: 0.9 s / 41 s) is repository-class with the derived run count. QuixBugs and
   the ladder (equal costs) are unaffected; django-15128 (0.985 s / 2.5 s, solved by a SIEVE of 410) stays QuixBugs-class.
5. **The wall reserves the scoped run's cost in either class** — `budget.ts:689-692` `passersReserveMs` (5 × t_run(fullSuite) when
   the goal subset is the cheaper reproduction, 0 for equal costs), `:724-733` `stepTestWallMs`: QuixBugs class = the design's
   min(90 s, wallRemaining / 4) **plus the reserve** (15128: 90 + 12.6 s), never past the run's remaining wall; repository class =
   min(8 × **the scoped run's running cost** (`tRunMs.fullSuite`), 600 s, wallRemaining) for a cheap-subset oracle (19954: 8 × 41 s =
   330 s at the baseline, 600 s once the lanes read 80 s), the raw baseline duration for equal-cost oracles as before.
   `repositoryRunsPerStep` (`:707-712`) takes the reserve out of it in lane-seconds: floor((wall − 5 × t_scoped) × lanes / t_repro),
   bounded to [16, 160] — idle sympy-15345 108 (as before), Django 100 s / 2.8 s 142 (was 140: floor-then-× lanes), the same
   sympy-15345 wall with the reproduction measured at 8 s under load **27**.
6. **t_run from the lanes' running measurements** — `budget.ts:184-186` (`LIVE_REPRO_WINDOW` 16, `LIVE_SCOPED_WINDOW` 4,
   `LIVE_MIN_SAMPLES` 3), `:612-670` `RunSamples`, `recordRunSamples`, `liveMedian`, `liveTRun`, `applyLiveTRun`: the median of the
   last ≤ 16 reproduction runs (through the §2.4 `refineTRun` hysteresis, so a 1.9 s reproduction measured at 2.5 s under load keeps
   the sieve; 8 s is the truth) and the last ≤ 4 scoped runs, written into `oracle.tRunMs` once ≥ 3 samples of a kind exist, never the
   idle baseline from then on; `oracle/verify.ts:98-109` `runSamplesOf(mem)` keeps the windows per runner memory (a WeakMap: they
   survive the per-step budget and the re-baselined oracle model; `RunnerMemory` is not this agent's type to extend), `:388-392`
   records every batch and applies the medians (this batch's medians before the windows are live, as before). `freshBudget`,
   `runsLeft` and therefore every `decideRunPlan` read `oracle.tRunMs`, so the wall, the count and the take are re-derived from what
   the runs actually cost; the `verify` event says `t_run reproduction 1338 ms (live), scoped 80000 ms (live)`.
7. **Rank order, and the #1 never deferred** — `oracle/verify.ts:240-247` `nextJob`: carried (deferred) and fresh jobs are dispatched
   in `VerifyJob.key` order (`compareRank`, `:90-96`; ties to the carried job so the earlier ranking keeps its place), with a
   one-job lookahead on the queue (a popped fresh job that ranks below a carried one waits under the goal, never lost);
   `:230-237` `admitPasser`: the regression slots go to passers in rank order — a passer takes a slot only when the slots left
   exceed the higher-ranked jobs still awaiting their reproduction verdict, waits on its lane otherwise (one reproduction's time),
   is deferred once the cap is reached — so the passer cap defers the **lowest-ranked** passers whatever order the lanes finish in,
   and the top-ranked passer always runs; `:250-262` the top job's runs (reproduction, confirmation, regression) are not cut by the
   step's wall (§4.3: a step may overrun by one in-flight run), every other job's are; `mem.deferred[goal]` is kept sorted.

### 23.2 Tests and gates

`test/unit/synth/oracle/verify.test.ts` (fake lanes with a fake clock that honours timeouts): pass/pass → `plausible`, three runs
charged, the confirmation is the same command in the same lane; pass/fail → `unchanged` + `isUnstableOutcome`, no scoped command, the
event's `1 unstable`; the rank-merge of carried and fresh jobs (`fresh 0.9, carried 0.6, carried 0.5 (tie), fresh 0.5 (tie), fresh
0.4, carried 0.3`); a fresh job popped behind a higher carried one waits under the goal; 8 lanes, a slow top-ranked passer against
six fast ones → the top `plausible`, 5 plausible, the deferred two are `p4, p3` (and with the top failing, `p3` alone); the top's
regression at the full timeout with a 3 s wall vs the second-ranked passer's cut to `3000 − 3 × 610` ms and deferred; the live windows
(`[2000, 2200, 2100]` → 2100, then a 9 s run → 2150, not 9000). `test/unit/synth/search/budget.test.ts`: the class on both costs (0.9 s +
48 s → repository, 1999/9999 → QuixBugs, 1999/10000 → repository), `freshBudget` on the 19954 numbers (wall 384 s, reserve 240 s, 160
runs, RANK on 762 / SIEVE on 150, k = 16 with 10 sites left), 15128 (1,500 runs, wall 90 s + 12.6 s, SIEVE of 410), equal-cost walls
unchanged, the windows and medians, `applyLiveTRun` with the hysteresis, **idle 2 s → 108, live 8 s → 27**, Django 142, `noStop`
103. `test/unit/synth/oracle/search.test.ts`: pass/pass → `passes_on_base (twice)`, pass/fail → `unstable`, requests-2931's task →
`weak_network` / weak / `network.evidence = 'requests against httpbin.org'`, the sympy oracle `network: null`, the offline run →
`env_error`. `test/unit/synth/oracle/runner.test.ts`: `detectNetworkUse` static / local-host / Django-URL / runtime cases.

Gates: `tsc` clean on every `synth` file (remaining errors: `src/cli/main.tsx`, `test/unit/provider/retry-hooks.test.ts`,
`test/unit/undo/apply.test.ts` — peers' WIP); `no-any: ok`; `vitest --project unit test/unit/synth/oracle test/unit/synth/search/budget.test.ts
test/unit/synth/sieve`: 11 files, 229 tests pass; the whole `test/unit/synth`: 1,368 pass, the 4 failures are in `search/sites.test.ts`
and `templates/introspect.test.ts` (the §22 wiring in progress, not touched here).

### 23.3 What the other owners must wire (not done here)

- `search/index.ts initRepository`: `found.outcome === 'weak_network'` already yields the goal (`found.goal !== null`, strength
  `'weak'`); add `NETWORK_ORACLE_OPEN_PROBLEM` to every proposal's `openProblems` while `repo.oracleOutcome === 'weak_network'`
  (`repositoryNotes` / `search/proposal.ts` evidence), and pass `oracleNeedsArbitration(repo.oracleOutcome)` to the guard so a lone
  passer of such an oracle goes through Q15/Q16 (the rule-(b) advisory at least) instead of a direct commit; `memory.ts` persists
  `oracleOutcome` as a string, so nothing changes there.
- `search/types.ts VerifyStatus`: an `'unstable'` member would let the guard and the trace name it directly; until then
  `isUnstableOutcome(o)` / `UNSTABLE_ACTUAL_PREFIX` (oracle/verify.ts) tell it apart from `unchanged`, and `GoalSearchTrace` could
  carry an `unstable` count.
- `oracle/index.ts` re-exports for `synth/index.ts`: `detectNetworkUse`, `NETWORK_ERROR_TYPES`, `NetworkUse` (runner.ts);
  `NETWORK_ORACLE_OPEN_PROBLEM`, `oracleYieldsGoal`, `oracleNeedsArbitration` (search.ts); `compareRank`, `isUnstableOutcome`,
  `runSamplesOf`, `UNSTABLE_ACTUAL_PREFIX` (verify.ts).
- `docs/JEV-ONLY-DESIGN.md` §4.3 (line ≈ 350): the class on both costs, the reserve in the wall, the running-median t_run, the
  lane-seconds count; §4.2: the confirmation run and the rank-ordered passer cap.
- The regression run's own timeout (`synth/index.ts runQueue`: `min(runTimeoutMs, maxCommandTimeoutMs, REPO_BASELINE_TIMEOUT_MS)`)
  should stay above the lanes' scoped median (`mem.oracle.tRunMs.fullSuite`, live) — the 72–82 s runs of §21.6 were within it, but a
  3 × baseline bound fitted to an 11 s idle baseline would not be.

Live spend of this section: $0.

## 24. 2026-09-20 (later): history candidates: own sites, capped share (rung-3 error class); introspection sites merged onto colliding gaps; the guard targets the raising statement

Offline only (Jev $0). Fixes the defect §21.5 found ("history/ranker site mismatch": 43 `ranker: candidate … is not at the site being
ranked` in 12 runs, nine runs stopped with `error` at steps 4–6, sympy-11618 lost at step 5) and the two placement findings of §21.5's
reach-target check (sympy-15345's class-body gap deduplicated away; sympy-17139's guard inside the raising `if`'s body).

### 24.1 Root cause, confirmed

`src/synth/history/source.ts` (commit 5486f7a, lines 96 and 110) built every reversal with `site: at` — the site of the CURRENT lines of
the hunk it reverts (sequence match, `locateLines`) — and `enumerateHistory` offered it at any site within 80 lines or the same block;
`src/synth/index.ts:184-185` (§20's wiring) spliced those reversals FIRST into the donor seed of whatever site was being enumerated,
`[...reversals, ...donors].slice(0, cap)`; `src/synth/rank/index.ts:307` asserts every ranked candidate is at the ranked site and threw.
Transcript `~/.jevcode/runs/20260921-011312-ij7bpwi3/transcript.log:31` (django-15375): `hist_0c763317_56_57871c58d5` at
`django/db/models/sql/compiler.py:1679 (replace)` while ranking `compiler.py:1686 (replace)` — the same function, 7 lines apart.

Reproduced offline before changing anything (`test/unit/synth/history/fixtures.ts` `compilerFixture`: an `as_sql` spanning L1674–1688, one
harvested hunk that changed L1679, the ranked site L1686): with HEAD's `source.ts` the seed of L1686 held one foreign-site candidate,
`hist_0c763317_0_690eaa6f17 at compiler.py:1679 (foreign=true)`; after the change it holds none, `historySites` lists `compiler.py:1679
(replace)` with the provenance note, and at L1679 the reversal is emitted with the enumerated site object itself.

### 24.2 What changed

1. **A reversal is emitted only at its own site** (`history/source.ts`). `locateReversal(file, commit, hunk, index)` places each run at
   its current lines — a one-line replace, a statement-level span `line..endLine` (the `currentLine` rendered from the span's code
   tokens so verify/apply.ts's staleness check round-trips; a span that does not tokenize yields nothing), or an insert after its
   leading context — and `enumerateHistory(site)` emits it only when `sameSpan(located, site)` (same file, line, kind and span end;
   an insert's indent is not part of the identity, the text carries its own), with `candidate.site = site`. No more `extraEdits`
   deletes: the span deletes are apply's. `HISTORY_WINDOW_LINES` stays exported for distance reporting; nothing uses it to widen.
2. **Reversals located elsewhere get their own sites** (`search/sites.ts` `historySites(facts, files, localised, sites = [], max = 2)`,
   mirroring `introspectionSites`): after the Jev-ranked and the introspection sites, ≤ 2 per goal, most recent commit first, then
   nearest to the located sites of the same file, then run order; none whose `siteKey` a located site holds (the goal's `exhausted`
   and visit bookkeeping is by `siteKey`, so a same-key site with another span is left out — documented limit). `locate`
   (`src/synth/index.ts`) appends them and emits `N history site(s) after the M located: path:line (kind; reverse of <sha> …)`.
3. **History's share of the donor seed is capped** (`index.ts` `seedWithHistory`, `historySeedCap(cap) = min(16, ⌊0.25·cap⌋)`: 254 → 16,
   60 → 15, 1 → 0) and placed AFTER the donors' top half; the wrapper also filters to `sameSpan` itself (a misbehaving source cannot
   get a foreign candidate through). With no reversal at the site the seed is exactly the plain donors (asserted).
4. **The ranker invariant stays and names the source**: `ranker: history candidate "hist_…" (reverse of …) is at f:1679 (replace), not
   at the site being ranked (f:1686, replace); the history source must emit a candidate only at the site it enumerates`
   (`shuffleRerank`'s message likewise).
5. **(a) sympy-15345 — introspection sites are merged, not dropped** (`search/sites.ts` `mergeIntrospectionSites`, used by `locate`;
   `introspectionSites` keeps its old semantics for callers): a candidate whose `siteKey` (path:line:kind) a located site already holds
   gets its notes appended onto that site — the class-body mark `CLASS_BODY_GAP_NOTE` (`introspection: class-body gap of <Class> …`,
   now a constant of `templates/introspect.ts`) — and `aliasPlacement` accepts a marked gap whatever its own indent, writing the alias at
   the class body's indent (apply inserts indented text verbatim). Verified offline on the 15345 shape: located gap at the method's
   block-end line with the method-body indent → merged → `_print_Baz = _print_Bar` at indent 4, applied after `return "bar"`.
6. **(b) sympy-17139 — the guard targets the raising statement** (`templates/introspect.ts` `guardTargetLine`, `framePathMatches`): when
   an operand's frame is in the site's file, `attribute_predicate_guard` fires ONLY at the gap immediately before the statement that
   frame names (written at that statement's indent, whatever the site's) or at that statement itself (`_before` form only; the
   `_after`-into-the-header's-body form is dead code there); other gaps of the file get nothing. Operands without a frame in this file
   fall back to every gap where their root is visible, as before. So that the target is always in the site list when its file is
   localised, `introspectionSites` now also builds that gap (`RAISING_GAP_NOTE`, receivers first, statement start for a continuation
   line), ahead of the class-body and import gaps: `INTROSPECTION_SITES_MAX` 2 → 3 (merges do not count).

### 24.3 sympy-19954: history did NOT displace the guard that solved it — the site was never visited

Checked as asked. The rung-3 run (`20260921-004052-jx3hxdij`) harvested `5 commits, 48 change runs in 3 files`; re-harvesting the surviving
workspace offline (`~/.jevcode/runs/bench-work/20260921-002827-57b7e1/sympy__sympy-19954/jev-only/workspace`, `.scratch/hist-19954.mts`,
local git only) gives 5 commits / 44 runs, 39 of them in `perm_groups.py`, 27 locatable — the nearest at L2298 (distance 96, `is_subgroup`),
then L2098 (104), L1955 (247): **none within the 80-line window or the `minimal_blocks` block (L2133–2214) of the visited site
`perm_groups.py:2202:insert`, so the old rule put 0 reversals in its donor seed** (plain donors 254 = the cap; displaced 0). The
transcript agrees: `synth site: … 2202:insert … mutation 254, template 254, donor 254` at step 4 and the same single site at steps 7,
10 and 17 (`template 117/111/109, donor 245`). The pass on the previous tree (`jev-only-swebench-2`, run `20260921-000331-sxnrfz76`, 6
steps) was `pick template/guard_index_break at sympy/combinatorics/perm_groups.py:2201:insert` in RANK mode (12 sites, 21 tested, 3
plausible) — a TEMPLATE candidate at the gap before L2201; history rides only with the donor seed and cannot displace a template. In
rung 3 the goal ran in SIEVE mode with the derived run budget (383 runs at step 4, 379 tested at the one site 2202, 375 unchanged + 4
regressed, `budget-hit step 1 of 4`, then 5–6 tested per step under `test wall left 0 s`) and never reached `2201:insert`. The loss
belongs to §21.6 items 1–2 (per-site run spending and the regression-run timing), not to the history source.

### 24.4 Tests and gates

`test/unit/synth/history/history.test.ts` (source: span sites, own-site emission, the rung-3 reproduction), `history/fixtures.ts`,
`wiring.test.ts` (donor wrapper: after the top half, share cap table, exact donors without facts, the rung-3 seed ranks without the
invariant firing, a rogue foreign-site source is filtered), `search/sites.test.ts` (`historySites` order/bounds/dedup;
`mergeIntrospectionSites` + the alias firing at the merged gap; the raising-statement gap first), `rank/ranker.test.ts` (the message
names the source and provenance), `templates/introspect.test.ts` (guard target: at the gap before the raising statement at its indent,
nothing inside the raising `if` or elsewhere in the file, `_before` only at the line, fallback without a frame, absolute frame paths;
alias at a marked gap). Gates: `npx vitest run --project unit test/unit/synth` (ladder/corpus excluded) 79 files, 1,362 tests pass;
`npx tsc --noEmit` clean for every file touched (remaining errors: `src/cli/main.tsx:260` and peers' WIP directories); `node
scripts/no-any.mjs` ok. Budget: $0 live.

## 25. 2026-09-21: final tree (55404ba) — QuixBugs 40 and ladder 20

Live measurement of the tree as it stands after §24 (HEAD 55404ba, run from the frozen worktree
`.claude/worktrees/final-clean` so that concurrent edits in the main checkout could not leak in; `node_modules` symlinked;
results written to the main checkout's `bench/results/`). No source was changed for this section. Both suites ran
jev-only, live, with the same caps as their predecessors — QuixBugs at concurrency 4 (12 steps, 8 min, $0.05 a task),
the ladder at concurrency 2 (30 steps, 15 min, $0.15 a task) — while another agent ran SWE-bench at concurrency 2 on the
same machine, so the load-aware run sizing of §23 was exercised (`load ×2.1–2.8, case timeout 500→1040–1419 ms` in the
QuixBugs transcripts). Headline: **QuixBugs 39/40** (the best of the four full runs; 6-repeat1/2 were 38/40, run 3 36/40)
and **ladder 14/20** — the short tier **12/12** for the first time (rounds 4 and 5 were 11/12, each missing a different
task), the long tier **2/8** as in runs 1 and 2 but with more gold hunks in hand on the misses. Spend: $0.185 + $0.320 =
**$0.505**.

### 25.1 QuixBugs, all 40 (`bench/results/jev-only-quixbugs-7-final`, bench 20260921-022420-3b3af3)

Verdicts by `experiments/inspect/quixbugs-verdicts.mts`: **solved 39/40; gold-identical 30, equivalent 7, overfit 0,
unverified 2, miss 1**; correct by the script's stricter count (gold-identical + equivalent) **37/40** — 6-repeat2 was 36,
6-repeat1 35, run 3 32. Both `unverified` are the graph programs whose fixtures `perturb.ts` does not perturb
(`breadth_first_search`, `topological_ordering`); both pass their reference cases, which is not the same as both being
correct: the independent differential test of §26.5 shows `breadth_first_search` equivalent to gold on 500 random graphs and
`topological_ordering` **wrong** (its committed patch drops the `issuperset(incoming_nodes)` check; 462/1000 random DAGs
invalid), so 37 verified correct and at most 38/40 correct. The four full runs side by side:

| run | bench | solved | verdicts | Jev $ | wall | steps median all / solved / max | stops | misses |
|---|---|---|---|---|---|---|---|---|
| `jev-only-quixbugs-3` | 20260920-205918-3f1604 | 36/40 | gold-identical 27, equivalent 5, overfit 2, unverified 2, miss 4 | $0.165 | 12 min | 4 / 4 / 12 | complete 35, max_steps 5 | `depth_first_search`, `longest_common_subsequence`, `reverse_linked_list`, `shunting_yard` (all 12 steps, `max_steps`) |
| `jev-only-quixbugs-6-repeat1` | 20260920-232705-faa8ea | 38/40 | gold-identical 28, equivalent 7, overfit 1, unverified 2, miss 2 | $0.134 | 15 min | 4 / 4 / 12 | complete 38, max_steps 2 | `longest_common_subsequence`, `shortest_path_length` (12 steps, `max_steps`) |
| `jev-only-quixbugs-6-repeat2` | 20260920-234431-abfc52 | 38/40 | gold-identical 28, equivalent 8, overfit 0, unverified 2, miss 2 | $0.126 | 16 min | 4 / 4 / 12 | complete 38, max_steps 2 | `shortest_path_length`, `sqrt` (12 steps, `max_steps`) |
| **`jev-only-quixbugs-7-final`** | 20260921-022420-3b3af3 | **39/40** | **gold-identical 30, equivalent 7, overfit 0, unverified 2, miss 1** | $0.185 | 16 min | 3 / 3 / 11 | complete 39, spend_cap 1 | `shortest_path_length` (11 steps, `spend_cap`) |

Verdict moves against the 6-repeat pair: `longest_common_subsequence` miss (repeat1) → gold-identical; `sqrt` miss
(repeat2) → gold-identical; `wrap` overfit (repeat1) → gold-identical (the §14 wrap family holds); `mergesort` equivalent
(repeat2) → gold-identical. The higher spend ($0.185 against $0.13) is the four long runs below — every other program
finished in exactly 3 steps (36 of 40; 0 loop trips, 0 blocked). Per program (`reads` = `read` proposals in the
transcript, 0 everywhere as §22 intends):


| program | solved | verdict | steps | stop | Jev req | blocked/declined | loops/replans | reads | Jev $ | wall s | run id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `bitcount` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 135 | `20260921-022420-wxs4vocl` |
| `breadth_first_search` | **yes** | unverified | 3 | `complete` | 21 | 0/0 | 0/0 | 0 | $0.0015 | 25 | `20260921-022420-5dl7fvb7` |
| `bucketsort` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0016 | 38 | `20260921-022420-ndkd7gzz` |
| `depth_first_search` | **yes** | gold-identical | 3 | `complete` | 21 | 0/0 | 0/0 | 0 | $0.0014 | 44 | `20260921-022420-3fu6mmge` |
| `detect_cycle` | **yes** | equivalent | 3 | `complete` | 21 | 0/0 | 0/0 | 0 | $0.0014 | 40 | `20260921-022446-gocbly2c` |
| `find_first_in_sorted` | **yes** | gold-identical | 3 | `complete` | 16 | 0/0 | 0/0 | 0 | $0.0016 | 61 | `20260921-022458-ylzwdjur` |
| `find_in_sorted` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0015 | 43 | `20260921-022504-xrabqihb` |
| `flatten` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 24 | `20260921-022527-ob33la4q` |
| `gcd` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 23 | `20260921-022547-yiu3yjxf` |
| `get_factors` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 24 | `20260921-022551-o4svy6cu` |
| `hanoi` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 30 | `20260921-022600-ayxcowmw` |
| `is_valid_parenthesization` | **yes** | equivalent | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0014 | 16 | `20260921-022611-ju2hkzur` |
| `kheapsort` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 22 | `20260921-022615-fa5tasci` |
| `knapsack` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0016 | 42 | `20260921-022628-d26zcfvn` |
| `kth` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 39 | `20260921-022631-me6q2sp7` |
| `lcs_length` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 36 | `20260921-022635-pipyakhp` |
| `levenshtein` | **yes** | gold-identical | 3 | `complete` | 18 | 0/0 | 0/0 | 0 | $0.0020 | 51 | `20260921-022638-7qpyj7fd` |
| `lis` | **yes** | equivalent | 10 | `complete` | 94 | 0/0 | 3/3 | 0 | $0.0178 | 421 | `20260921-022710-rvxauu6m` |
| `longest_common_subsequence` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 89 | `20260921-022710-nhzdqmvs` |
| `max_sublist_sum` | **yes** | equivalent | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0015 | 21 | `20260921-022712-i2xdpn5e` |
| `mergesort` | **yes** | gold-identical | 10 | `complete` | 164 | 0/0 | 4/4 | 0 | $0.0400 | 455 | `20260921-022733-ktajnylm` |
| `minimum_spanning_tree` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 41 | `20260921-022733-efjj7vvq` |
| `next_palindrome` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0015 | 27 | `20260921-022815-wxob5i6f` |
| `next_permutation` | **yes** | equivalent | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0016 | 30 | `20260921-022840-dwywiolu` |
| `pascal` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0014 | 43 | `20260921-022842-t4n4culy` |
| `possible_change` | **yes** | equivalent | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0015 | 36 | `20260921-022911-zcvbczgs` |
| `powerset` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 24 | `20260921-022925-bt5qujf2` |
| `quicksort` | **yes** | equivalent | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0015 | 28 | `20260921-022948-5qfzhh5o` |
| `reverse_linked_list` | **yes** | gold-identical | 3 | `complete` | 35 | 0/0 | 0/0 | 0 | $0.0037 | 92 | `20260921-022950-mdyjucsw` |
| `rpn_eval` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0016 | 21 | `20260921-023016-lm64gzie` |
| `shortest_path_length` | no | miss | 11 | `spend_cap` | 269 | 1/0 | 4/4 | 0 | $0.0538 | 444 | `20260921-023038-q2t3e744` |
| `shortest_path_lengths` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0015 | 31 | `20260921-023123-vox34tox` |
| `shortest_paths` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0015 | 40 | `20260921-023154-2h7qc55z` |
| `shunting_yard` | **yes** | gold-identical | 3 | `complete` | 15 | 0/0 | 0/0 | 0 | $0.0017 | 85 | `20260921-023235-mvwnakjf` |
| `sieve` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 23 | `20260921-023401-bu7kx7ur` |
| `sqrt` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0013 | 76 | `20260921-023412-bgknxaho` |
| `subsequences` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0015 | 23 | `20260921-023425-jqwov6qc` |
| `to_base` | **yes** | gold-identical | 3 | `complete` | 14 | 0/0 | 0/0 | 0 | $0.0014 | 35 | `20260921-023449-na6zxyx7` |
| `topological_ordering` | **yes** | unverified | 10 | `complete` | 134 | 3/0 | 2/2 | 0 | $0.0183 | 300 | `20260921-023509-t3pnzjqk` |
| `wrap` | **yes** | gold-identical | 3 | `complete` | 16 | 0/0 | 0/0 | 0 | $0.0016 | 69 | `20260921-023524-lqprphfk` |

Totals: 1,225 Jev requests, 4 blocked / 0 declined, 13 loop trips / 13 replans (all in the four 10–11-step runs), 0 `read`
proposals, 3,150 s of run wall over 16 min of bench wall. **The three 10-step passers are budget recoveries, not
localisation:** `lis` committed a progress commit at step 2 (`mutation/off_by_one`, 3 of 4 goal tests, 8→11 of 12) and
then needed six budget-hit steps and two `gather_context` replans before a `donor/statement_donor at lis.py:12` passed
the last test at step 9 (11→12); `mergesort` budget-hit at steps 2–8 (725/896/609/408/260/295/153 runs, 0 plausible, three
`fail:` and two `run:` loop trips) and committed `mutation/boundary_shift at mergesort.py:17` at step 9 (1→14 of 14, 35
runs); `topological_ordering` committed an arbitrated `mutation/drop_term at :6` at step 2 (0→2 of 3, 6 passers, escape
0.18), parked `test2` at step 5 "exhausted … at 11 sites", had its partial `done` blocked three times (0.98–1.00), widened
to 34 sites at step 8 (1,482 runs, 0 plausible) and passed with `template/sketch_P11 at :9` at step 9.

**The miss, `shortest_path_length` (run `20260921-023038-q2t3e744`, 11 steps, `spend_cap` $0.054): an overfit commit that
makes the remaining test unfixable.** Baseline 2/4. Step 2 searched `:26:insert` (415 tested: 279 regressed, 135 unchanged)
and `:22:insert` (364 regressed) and ended on its budget with 3 plausible; the guard line is `the step ends on its budget;
committing the held passer as possible overfit`, and the committed patch is `+            return 4` at `:19:insert` —
`test1` passes (2→3 of 4) because its answer is 4. The gold fix (`get(unvisited_nodes, nextnode) + …` → `distance + …` at
L22) sits inside the `insert_or_update(...)` call *below* that `return`, now dead code, so no candidate at any later site
can pass `test2`: steps 4–8 ran 1,201 / 1,291 / 895 / 769 / 525 candidates at `:20`, `:19`, `:27` (`budget-hit step 1 of 4`
each time, 0 plausible), step 9 tripped `run:… x3`, step 10's `gather_context` re-localised and found "nothing new: 1 of 2
stagnant", step 11 parked "exhausted composite, donor, mutation, template at 12 sites", the partial `done` was blocked at
0.91 (`plan_mismatch`) and the run stopped on the task cap. Class: **overfit → dead-code partial trap → budget**. The same
program missed in both 6-repeat runs (`max_steps`, no commit); this tree commits the overfit passer instead of ending with
nothing, which is the §22 "possible overfit" release working as written and the wrong call here. The verdicts file marks
it `miss` with `a 466-byte patch was committed and still fails`.

### 25.2 Ladder, all 20 (`bench/results/jev-only-ladder-7-final`, bench 20260921-024028-7c76d9)

`--tasks 20` selects both tiers in index order (short 1–12, long 13–20; `src/bench/ladder/tasks.ts orderByTier`). 34 min
of bench wall, $0.320. **Short tier 12/12, every run `complete`, 53 steps in all (median 4), 431 Jev requests, 0 blocked,
0 declined, 0 loop trips, 0 replans, 0 progress commits, 0 `read` proposals, $0.051.** Rounds 4 and 5 were 11/12 (round 4
missed `account` at 20 steps `max_steps`, round 5 `inventory` at 20 steps `max_steps`; both solved here in 5 steps), with
`calendar_utils`, `inventory`, `units` at 20 steps and `shipping` at 19 steps `max_replans` in those rounds; the slowest
run here is 7 steps. Round 6's three-task re-runs (`grades`, `shipping`, `table`: 3/3 twice, 5–8 steps) match. `hunks`
counts gold-identical lines (`h*` = the buggy line is gone but the text is not gold's), computed by
`/tmp/jevonly/short_rows.py` from the run's `model_patch.diff` against `bench/data/ladder/tasks/<t>/gold/`; a solved task
at 0/n passed by inserts that shadow the buggy line:

| task | hunks (gold) | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | progress commits | reads | run id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `account` | 3/3 (h1, h2, h3) | **yes** | 5 | `complete` | $0.0080 | 166 s | 61 | 0/0 | 0/0 | 0 | 0 | `20260921-024028-behszget` |
| `calendar_utils` | 2/3 (h1, h3*) | **yes** | 7 | `complete` | $0.0071 | 183 s | 58 | 0/0 | 0/0 | 0 | 0 | `20260921-024028-mkgzheaw` |
| `events` | 1/1 (h1) | **yes** | 3 | `complete` | $0.0014 | 39 s | 18 | 0/0 | 0/0 | 0 | 0 | `20260921-024315-evwik3qh` |
| `grades` | 0/2 (-) | **yes** | 5 | `complete` | $0.0029 | 39 s | 34 | 0/0 | 0/0 | 0 | 0 | `20260921-024331-472i7uhj` |
| `inventory` | 1/2 (h1) | **yes** | 5 | `complete` | $0.0039 | 124 s | 39 | 0/0 | 0/0 | 0 | 0 | `20260921-024354-rzwpkvp4` |
| `profiles` | 1/1 (h1) | **yes** | 3 | `complete` | $0.0013 | 18 s | 18 | 0/0 | 0/0 | 0 | 0 | `20260921-024411-se4cumbo` |
| `shipping` | 1/1 (h1) | **yes** | 3 | `complete` | $0.0068 | 84 s | 32 | 0/0 | 0/0 | 0 | 0 | `20260921-024429-bd6h5t4o` |
| `stats` | 1/1 (h1) | **yes** | 3 | `complete` | $0.0015 | 19 s | 19 | 0/0 | 0/0 | 0 | 0 | `20260921-024554-ya7qlcvq` |
| `table` | 3/3 (h1, h2, h3) | **yes** | 4 | `complete` | $0.0091 | 152 s | 48 | 0/0 | 0/0 | 0 | 0 | `20260921-024559-uerj25cf` |
| `tagcloud` | 1/1 (h1) | **yes** | 3 | `complete` | $0.0015 | 7 s | 20 | 0/0 | 0/0 | 0 | 0 | `20260921-024613-dnd7yuv7` |
| `textstats` | 1/2 (h1*) | **yes** | 5 | `complete` | $0.0030 | 101 s | 35 | 0/0 | 0/0 | 0 | 0 | `20260921-024621-2kvkz3v6` |
| `units` | 0/1 (-) | **yes** | 7 | `complete` | $0.0043 | 158 s | 49 | 0/0 | 0/0 | 0 | 0 | `20260921-024803-ggofonh3` |

The five non-gold short-tier fixes, read from the patches: `grades` h2, `inventory` h2 (`number -= 1` before `start =
number * size`), `calendar_utils` h2 (`day += 1` before `+ day - 1`) and h3 (`split("-", 3)` for `split("-")`) and `units`
(the gold's own five lines inserted above the now-dead buggy three) are behaviourally equivalent inserts; two are
test-equivalent but not equivalent: `grades` h1 `minimum -= 1` before `if score > minimum` gives 89.5 an A where the gold
`>=` gives a B (the signature takes `float`), and `textstats` h2 `tokens.append(n)` before `range(len(tokens) - n)` mutates
the caller's `Sequence[str]` (and would raise on a tuple). Both would read `overfit` under a QuixBugs-style perturbation
probe; the ladder has none.

**Long tier 2/8** — `import_and_guard` (9 steps, its fastest: 13 and 19 in runs 1 and 2) and `ledger5` (13 steps
`complete`; 27 and 28 in runs 1b and 2) — with 114 steps, 1,720 Jev requests, 36 blocked (all partial `done`s) / 0
declined, 22 loop trips / 16 replans, **6 progress commits, 0 `read` proposals**, $0.269. Columns from
`/tmp/ladder-long/mdrows.py`: `progress commits (regression runs: dropped)` and `re-clusterings`:

| task | hunks fixed (patch vs gold) | solved | steps | stop | cost | wall | Jev req | blocked/declined | loops/replans | reads | progress commits (regression runs: dropped) | re-clusterings | run id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ledger5` | 3/5 (h1, h3, h4) | **yes** | 13 | `complete` | $0.0189 | 336 s | 145 | 0/0 | 0/0 | 0 (0) | 0 (0: 0) | 0 moved, 0 split | `20260921-025245-ggdsnzm6` |
| `import_and_guard` | 3/4 (h1, h2, h4) | **yes** | 9 | `complete` | $0.0072 | 123 s | 78 | 0/0 | 0/0 | 0 (0) | 0 (0: 0) | 0 moved, 0 split | `20260921-025041-fecsobw4` |
| `masked` | 0/3 | no | 12 | `replan_stop` | $0.0245 | 312 s | 145 | 6/0 | 2/1 | 0 (0) | 1 (1: 0); reopened 1, suspect 2 | 1 moved, 1 split | `20260921-025821-bw3bbpqj` |
| `shared_frame` | 0/2 | no | 8 | `replan_stop` | $0.0193 | 216 s | 92 | 6/0 | 2/1 | 0 (0) | 0 (0: 0); reopened 1 | 0 moved, 0 split | `20260921-030405-dvih65vo` |
| `crossfile` | 0/4 | no | 21 | `max_replans` | $0.0831 | 472 s | 456 | 6/0 | 6/5 | 0 (0) | 0 (0: 0); reopened 1 | 0 moved, 0 split | `20260921-024831-45jrtvh5` |
| `regress_trap` | 3/4 (h2, h3, h4) | no | 18 | `replan_stop` | $0.0406 | 440 s | 299 | 6/0 | 5/4 | 0 (0) | 0 (0: 0); reopened 1 | 0 moved, 0 split | `20260921-030333-jwhjamig` |
| `six_hunks` | 1/6 (h6) + h3* | no | 19 | `replan_stop` | $0.0453 | 390 s | 322 | 6/0 | 5/4 | 0 (0) | 2 (4: 2); reopened 3 | 0 moved, 0 split | `20260921-030742-2bvscmnn` |
| `long_chain` | 3/6 (h1, h2, h3) | no | 14 | `replan_stop` | $0.0301 | 460 s | 183 | 6/0 | 2/1 | 0 (0) | 3 (3: 0); chain 1, reopened 1 | 1 moved, 0 split | `20260921-025624-m7ykcbkv` |

Against the earlier long-tier runs (solved / gold hunks; `–` = not in that run):

| task | run 1 | run 1b | run 2 | run 3 | run 3b | run 3c | **final** |
|---|---|---|---|---|---|---|---|
| `ledger5` | no, 0/5 (patch did not apply), 30 `max_steps` | **yes** 3/5, 27 | **yes** 3/5, 28 `replan_stop` | – | – | – | **yes** 3/5, 13 `complete` |
| `import_and_guard` | **yes** 3/4, 13 | – | **yes** 3/4, 19 | – | – | – | **yes** 3/4, 9 |
| `masked` | no 0/3, 20 | no 0/3, 17 | no 0/3, 25 | no 0/3, 12 | no 0/3, 12 | **yes** 1/3 + h3*, 7 | no 0/3, 12 |
| `shared_frame` | no 0/2, 17 | – | no 0/2, 16 | no 0/2, 10 | no 0/2, 10 | no 0/2, 8 | no 0/2, 8 |
| `crossfile` | no 1/4, 20 | no 2/4 (h3*, h4*), 30 | no, 23 | – | – | – | no 0/4, 21 `max_replans` |
| `regress_trap` | **yes** 4/4, 26 | – | no, 25 | – | – | – | no 3/4, 18 |
| `six_hunks` | no 2/6 (h3*, h4), 24 | – | no 1/6 (h3*), 27 | no 1/6 (h6), 15 | no 2/6 (h3*, h6), 16 | no 0/6 + h3*, h6*, 16 | no 2/6 (h3*, h6), 19 |
| `long_chain` | no 0/6, 18 | no 0/6, 19 | no 0/6, 20 | no 3/6 (h1, h2*, h3), 16 | no 2/6, 13 | no 2/6, 12 | no **3/6 (h1, h2, h3)**, 14 |

Runs 1, 1b and 2 stopped on `max_replans` / `max_steps` after declined `read`s (6–10 a task in run 2, §22); every run here stops on
`replan_stop` (or `max_replans` for `crossfile`) after blocked partial `done`s, with 0 reads — the §22 shape. `long_chain`
is the best it has been (three gold links, all `progress commit … no regressions`, then the chain rule handed the rest to
`g2`); `masked` is a coin (solved once in seven runs, 3c); `regress_trap` lost the `agenda.py` hunk that run 1 found.

### 25.3 The seven misses, by cause, with the transcript

Classes: **localisation miss** (the gold line never becomes a site) ×3 — `long_chain`, `regress_trap`, `shared_frame`
(also a strict pair); **overfit commit that kills the remaining goal** ×2 — `shortest_path_length` (§25.1) and `masked`;
**partial trap** ×1 — `six_hunks` (a clean lone partial displaced by a regressing pair); **cross-goal `tried` exclusion**
×1 — `crossfile` (contributing in `regress_trap`). Budget is the terminal cause only for `shortest_path_length`
(`spend_cap`); loops are the symptom in every long-tier miss (22 trips / 16 replans / 36 blocked `done`s), never the cause.
Single-hunk facts below come from applying each gold hunk alone to a copy of the task and running pytest ($0).

1. **`crossfile`** (`20260921-024831-45jrtvh5`, 21 steps `max_replans`, $0.083, empty patch, 0/4) — **`unchanged` is
   goal-relative, `tried` is run-global.** Applied alone, `tax.py` h3 (`<=` → `<`) passes both tax tests and `discount.py`
   h4 (`not in` → `in`) passes all three discount tests; only the fmt pair (h1+h2) needs both halves. Both single sites
   were in the beam with candidates: `src/tax.py:12:replace … mutation 67, template 59, donor 53 — jev anchor #1 in
   tax_for` at step 4 — **under `g4`, a fmt test** (`test_money_custom_symbol`), where its batch read `165 tested (165
   unchanged)`; from step 5 on the same site shows `mutation 0` under every goal, including `g7`/`g8` (the tax tests, steps
   7–9) and `g1`–`g3` (discount, steps 9–12). Likewise `src/discount.py:21:replace … mutation 204` under `g5` (fmt) at
   step 5, `mutation 0` under `g6`–`g8`, `g1`–`g3` afterwards. Code: `src/synth/search/memory.ts:44` / `sieve/runner.ts:146`
   keep one `tried: Set<string>` of diff hashes for the run; `runner.ts:174 unchangedTried: Map<goalId, Set>` records the
   goal an `unchanged` verdict belonged to, but `index.ts:712 forgetUnchangedTried(mem, goal.id)` runs only on **that
   goal's** progress commit — a candidate judged `unchanged` for a test it does not touch is excluded for the goal whose
   test it fixes. Every one of the eight one-test goals then parked "exhausted … at 10–12 sites"; steps 15–16 reopened all
   eight and found `runs 4` / `runs 0`; `run:` ×3 loop trips at steps 4, 11, 15, `done:` ×3 at 14; five `gather_context`
   replans; 6 blocked `done`s. The fix is a rule: an `unchanged` verdict excludes the hash for its own goal only (or is
   forgotten when the goal changes, as it already is on a progress commit).
2. **`masked`** (`20260921-025821-bw3bbpqj`, 12 steps `replan_stop`, $0.024, 0/3) — **the budget-reserve release commits
   an all-overfit `return 0`.** Step 2: progress commit `template/sketch_P11 at src/report.py:14` (`+    txt = text`, an
   alias insert equivalent to h1; 2 of 6, 16→18 of 22, full-suite regression run 18/22). Step 4, goal `g1` (2 tests in
   `aggregate.py`): `arbitrated 5 passers (0 held) … escape 0.75, max general 0.08; all-overfit signature, holding
   template/insert_return at src/aggregate.py:19:insert`, again at escape 0.83 — then `releases the held suspect
   template/insert_return at src/aggregate.py:19:insert (budget reserve); committing as possible overfit` and the patch
   is `+    return 0` above the gold line (`e.took` → `e.ms`), 18→20 of 22. `total_ms` now returns 0 unconditionally, so
   `test_summary_total_and_slowest` cannot pass by any `parse.py` change; `g2` (h3, `parse.py:21` `[:-1]` → `[:-2]`) got
   only insert gaps at `parse.py:18–22` and replace anchors in `aggregate.py:19` / `report.py:15,19`, parked "exhausted" at
   step 7, six partial `done`s blocked (0.95–1.00), `done:` ×3 twice, `replan_stop`. Same release rule as
   `shortest_path_length`; the guard's own `all-overfit signature` was right both times.
3. **`long_chain`** (`20260921-025624-m7ykcbkv`, 14 steps `replan_stop`, $0.030, 3/6 gold) — **localisation miss after the
   chain.** Three gold progress commits: `mutation/identifier_substitution at src/load.py:20` (step 2, 3 of 16, 10→13 of
   26, 1,138 `unchanged` forgotten), `mutation/attribute_substitution at src/clean.py:12` (step 4, 13→16, 1,420 forgotten),
   `mutation/attribute_substitution at src/enrich.py:22` (step 6, 16→20, 1,229 forgotten); `g1 took 3 progress commits;
   the remaining tests continue as g2` (step 7). `g2` = `test_layout.py::test_rows +5 in src/totals.py` (the goal names
   the file from the traceback), but its sites were `load.py:19/20`, `layout.py:20/21`, `enrich.py:22/23` gaps and
   `layout.py:20:replace` / `:18:replace` (`jev anchor #1/#2 in rows`) — **no `totals.py` site in 239 lines** although
   `src/totals.py` was in the context files from step 6. h4 is `-kv[2]` → `-kv[1]` inside `sorted(..., key=lambda kv: …)`
   — the raising frame is a `<lambda>`, the §22 shape (Jev's `where` cannot name it). Step 8 budget-hit (1,465 runs, 0
   plausible), step 9 parked, five blocked `done`s, `done:` ×3 twice.
4. **`regress_trap`** (`20260921-030333-jwhjamig`, 18 steps `replan_stop`, $0.041, 3/4 gold) — **localisation miss, with
   the cross-goal exclusion on top.** Gold commits at steps 2/4/6: `mutation/relational_swap at src/intervals.py:29`
   (3 passers arbitrated, escape 0.04), `off_by_one_literal at src/names.py:19`, `off_by_one_literal at src/roster.py:24`
   (21→25 of 28); no trap flip was kept. h1 `agenda.py:19` (`self.last_day` → `self.last_day + 1`) alone fixes all three
   remaining agenda tests, but **L19 never became a site**: `agenda.py` sites were `:24/:25` gaps (first under `g6`, a
   roster test, at step 6 with `mutation 48`; `mutation 0` under `g2` at step 8), `:24:replace` (anchor `mutation 136`,
   `g2` step 8), `:32/:33` gaps (`g1` step 11). `g3` at step 9: `sites 3 … candidates=0, tested=0`, `nothing new: 1 of 2
   stagnant`; `fail:` ×3, `run:` ×3, `done:` ×3, `fail:` ×3; three blocked `done`s ("fixed 4 of 7"). Run 1 solved this
   task 4/4 in 26 steps.
5. **`shared_frame`** (`20260921-030405-dvih65vo`, 8 steps `replan_stop`, $0.019, empty patch, 0/2) — **strict pair, no
   site at either call.** Each gold hunk alone leaves all six tests failing (so there is no partial to pair, §15 has
   nothing to work with); the goal is `… in src/checks.py` (the raising `ensure_at_least` frame); sites were gaps at
   `booking.py:29/30`, `pricing.py:19/20/27/28` and replace anchors `pricing.py:27` (`per_person`), `booking.py:20`
   (`Event.available`), `pricing.py:21` (`total`) — never `booking.py:29:replace` or `pricing.py:19:replace`, the two
   call lines. Step 2 budget-hit (1,489 runs, 0 plausible), step 3 parked, six blocked `done`s, `done:` ×3 twice. Same
   result in all seven runs.
6. **`six_hunks`** (`20260921-030742-2bvscmnn`, 19 steps `replan_stop`, $0.045, 2/6: h6 gold, h3 as `t.due == None`) —
   **partial trap.** Step 3, goal `g1` (three `test_attention` tests): the gold site `src/model.py:28:replace … jev anchor
   #1 in Task.is_overdue` ran and its batch read `298 tested (292 unchanged, 1 partial, 5 regressed)` — h1 alone passes
   `test_attention[a_only]` — but the held-partial slot kept `composite/pair_of_partials at src/render.py:20` (equal on
   "most newly passing", won the tie-break), whose full-suite regression run came back `1 newly failing`, so it was
   `dropped` and the step ended on its budget with **no progress commit**; `partial` verdicts stay `tried` (§22 6a), so
   step 4's `gather_context` re-localisation parked `g1` "exhausted … at 11 sites" without a run and it never held the
   clean partial again. h2's line `filters.py:30` and h5's `stats.py:15` never became sites (`filters.py:37/38`,
   `stats.py:22/23/34` did). `g2` committed a caller-side `mutation/off_by_one_atom at src/render.py:20` (`line(t, width -
   1)` for gold's `width - 3` inside `line`; 1 of 3, 19→20) and then the composite `t.due == None` at `sorting.py:18`
   (20→22, test-equivalent to h3); `g3` committed h6 gold `stats.py:22` (22→23) and parked on h5. 36 blocked `done`s
   across the tier, 6 here. Two of the four full-suite regression runs of held partials dropped their partial (`2 (4: 2)` in the table).
7. **`shortest_path_length`** — §25.1.

### 25.4 Commands, ids, spend

From `/Users/prateekjannu/Documents/vscode/JevCode/.claude/worktrees/final-clean` (HEAD 55404ba), logs under
`/tmp/jevonly/{quixbugs,ladder}-7-final.log`:

```
env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env node_modules/.bin/tsx src/cli/main.tsx \
  bench --suite quixbugs --conditions jev-only --live --spend-cap 0.6 --task-spend-cap 0.05 --concurrency 4 --max-steps 12 --max-wall 8m \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/jev-only-quixbugs-7-final
env -u ANTHROPIC_API_KEY node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env node_modules/.bin/tsx src/cli/main.tsx \
  bench --suite ladder --tasks 20 --conditions jev-only --live --spend-cap 0.6 --task-spend-cap 0.15 --concurrency 2 --max-steps 30 --max-wall 15m \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/jev-only-ladder-7-final
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/jev-only-quixbugs-7-final   # main checkout
```

QuixBugs: bench `20260921-022420-3b3af3`, 02:24:20–02:40:09 UTC, $0.185, no cap fired (one task cap). Ladder: bench
`20260921-024028-7c76d9`, 02:40:28–03:14:12 UTC, $0.320, no cap fired. Total **$0.505**. Run ids per task are in the
tables; workspaces under `~/.jevcode/runs/<run id>/` (`transcript.log`, `model_patch.diff`) and
`~/.jevcode/runs/bench-work/<bench id>/`. Helpers used, not committed: `/tmp/jevonly/short_rows.py` (short-tier hunks),
`/tmp/ladder-long/{rows,mdrows}.py` (long-tier hunks, progress commits, reads), the single-hunk checks in
`/tmp/jevonly/{xf,sf,regress_trap,six_hunks}`.


## 26. 2026-09-21: final tree (55404ba) — SWE-bench Verified 30, and the independent verification of §25

The third final-tree measurement, run alongside §25's two: SWE-bench Verified 30 from the frozen worktree
`.claude/worktrees/final-clean` (HEAD 55404ba; launcher log `/tmp/jevonly/swebench-4.log` line 1 `start
2026-09-21T02:24:50Z head 55404ba`), `bench/results/jev-only-swebench-4-final`, bench `20260921-022451-aa869f`,
02:24:51–03:33:07 UTC (68 min), `--concurrency 2 --max-steps 25 --max-wall 25m --task-spend-cap 0.4`,
`NODE_OPTIONS=--max-old-space-size=8192`. No source was changed for this section. The second half (§26.5) records what an
independent verification of §25 and of this run found, and restates the §25 headlines where it had to.

### 26.1 Headline and provenance

**4/30 pass the local-venv evaluator** — `sympy__sympy-15345` (4 steps, $0.0168, `complete`), `sympy__sympy-17139` (4,
$0.0158, `complete`), `sympy__sympy-19954` (6, $0.0194, `replan_stop`), `django__django-15128` (4, $0.0111, `complete`).
On each, `testsStatus` shows FAIL_TO_PASS all success and the listed PASS_TO_PASS all success (F2P/P2P: 1/8, 2/67, 1/56,
1/282), the eval checkout is at the record's `base_commit`, the applied source diff equals `model_patch.diff`, and
`test_output.txt` ends `Test Exit Code: 0`. The evaluator is unofficial: a fresh checkout at `base_commit`, the model
patch, the dataset `test_patch`, the `eval.sh` test command and the upstream log parsers, without Docker
(`src/bench/swebench/evaluator.ts`); `predictions.jev-only.jsonl` (30 entries, `model_name_or_path`
`jevcode-jev-only-none`) can be graded with the official harness elsewhere. Only 3 of the 4 stopped `complete`;
`sympy-19954` passed and then stopped on `replan_stop` after three no-op `done`s.

Totals from `tasks.jsonl` / `summary.json`: 30 records, evaluator `local-venv` ×30, `generatorCalls` 0 ×30, **$1.2956 of
Jev** ($1.30), 348 steps, 228 blocked proposals (218 risk blocks + 10 declined steps, the bench's `blocked` definition),
88 loop trips, 61 replans, 3,222 Jev requests, stops `complete` 3 / `max_replans` 7 / `replan_stop` 20, 17 empty patches,
`capFired` null, `notRun` 0. The §21 wiring defect is gone: 0 `propose: internal` / `ranker:` lines and 0 history-site
errors across all 30 transcripts (rung 3 had 9 `error` stops). The §23 rules were exercised: `unstable` verdicts appeared
3× on `django-15315` (190 tested: 165 unchanged, 22 unstable, 3 plausible) and `weak_network` 7× on `requests-2931`
(a lone passer committed as possible overfit, general 0.20 < 0.3). RSS (`/tmp/jevonly/swebench-4.rss`, 5-minute samples
of the `tsx` bench process, 14 samples 02:25–03:30 UTC): peak **4,729,200 kB ≈ 4.5 GiB** at 02:50:24 UTC, trajectory
1.19 → 1.21 → 0.84 → 3.94 → 3.99 → 4.73 → 4.09 → 4.40 → 4.43 → 4.04 → 4.51 → 4.45 → 3.15 → 2.75 GB; a lower bound
(the sampler matches the launcher process only, not the python test runners).

Provenance caveat, which applies to every final-tree row: **no run record stores a git sha** (`run.json` carries
`versions.jevcode` `0.1.0` and `node`, which are the same at `55404ba` and `HEAD`). That this run executed `55404ba` rests
on `run.json`'s `config.workspace` (`.claude/worktrees/final-clean`, detached at `55404ba`, `git status` clean apart from
the `node_modules` symlink), the launcher log line above, and timing. Consistent, but inferred.

Series over the four full-30 attempts, same 30 instances, different trees: `jev-only-swebench-1` 0 (20 records
evaluated, every patch empty, the process died), `jev-only-swebench-2` 1 (`sympy-19954`, 8 records, died at 8 GB),
`jev-only-swebench-3` 1/30 (`django-15128`; `5486f7a`), final **4/30** — i.e. 0/30 → 1/30 → 1/30 → 4/30. This is a
single run on `55404ba`; `sympy-19954` has flipped pass (run 2), pass (2-oracle), miss (run 3, under load), pass (final)
with a byte-identical patch each time it passed, so the count is load-sensitive (§21.7). All four solved instances are
among the nine oracle instances whose gold sites and single missing capability were dissected in
`experiments/results/swebench-reach-oracle-9.md`, and the sources that produced their patches (`mro_method_alias`,
`attribute_predicate_guard`, `guard_index_break`, the introspection-site merge of §24) were added against them between
run 3 and this run; 4/30 is a development-set number, not an out-of-sample rate.

### 26.2 Per instance (`experiments/inspect/swe-report.mts`)

Command (main checkout): `env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/swe-report.mts
bench/results/jev-only-swebench-4-final --mark=sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15315,django__django-15128,psf__requests-2931,sympy__sympy-12096,django__django-15563,sympy__sympy-16792`.
`*` marks the ten reach/oracle instances of §16–§21; `pm` = `plan_mismatch`; `progress budget steps` = steps that ended
on their budget but reached a new site (§23).

| instance | oracle | ledger | first baseline | enumerated / tested / plausible | commits / applied (rejections) | progress budget steps | best guess | evaluator | steps | Jev $ | wall s | stop | class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | none (no_blocks) | fixed 0, open 0, parked 1 | 366/376 scoped tests pass, 0 failed, 0 errors in 2262 ms; no reproduction oracle | 2118 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0258 | 29 | replan_stop | no_oracle_best_guess_rejected |
| django__django-14787 | none (no_pick) | fixed 0, open 0, parked 1 | 233/235 scoped tests pass, 0 failed, 0 errors in 1464 ms; no reproduction oracle | 1419 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0230 | 26 | replan_stop | no_oracle_best_guess_rejected |
| django__django-15103 | none (no_blocks) | fixed 0, open 0, parked 1 | 62/64 scoped tests pass, 0 failed, 0 errors in 1400 ms; no reproduction oracle | 1478 / 5 / 3 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 12 | $0.0320 | 26 | replan_stop | no_oracle_best_guess_rejected |
| *django__django-15128 | strong | fixed 1, open 0, parked 0 | 625/633 scoped tests pass, 0 failed, 0 errors in 3870 ms; reproduction repro::6da66011 fails (AssertionError: ) in 650 m | 1524 / 755 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 4 | $0.0111 | 138 | complete | solved |
| *django__django-15315 | strong | fixed 1, open 0, parked 0 | 328/356 scoped tests pass, 0 failed, 0 errors in 3586 ms; reproduction repro::e7fbbfa8 fails (AssertionError: ) in 645 m | 350 / 190 / 3 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv) | 9 | $0.0196 | 62 | replan_stop | evaluator_fail_on_committed_patch |
| django__django-15375 | none (incomplete_snippet) | fixed 0, open 0, parked 1 | 344/347 scoped tests pass, 0 failed, 0 errors in 3683 ms; no reproduction oracle | 1916 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0485 | 47 | max_replans | no_oracle_best_guess_rejected |
| *django__django-15563 | weak | fixed 1, open 0, parked 0 | 350/353 scoped tests pass, 0 failed, 0 errors in 3646 ms; reproduction repro::3ec747c8 fails (<QuerySet [{'field_otherba | 2085 / 15 / 5 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv) | 9 | $0.0224 | 40 | replan_stop | evaluator_fail_on_committed_patch |
| django__django-15572 | none (no_blocks) | fixed 0, open 0, parked 1 | 69/75 scoped tests pass, 0 failed, 0 errors in 1677 ms; no reproduction oracle | 819 / 5 / 5 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 9 | $0.0223 | 32 | replan_stop | best_guess_wrong |
| django__django-15916 | none (no_criterion) | fixed 0, open 0, parked 1 | 302/302 scoped tests pass, 0 failed, 0 errors in 3254 ms; no reproduction oracle | 1347 / 5 / 5 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0255 | 30 | replan_stop | no_oracle_best_guess_rejected |
| django__django-16100 | none (no_blocks) | fixed 0, open 0, parked 1 | 460/483 scoped tests pass, 0 failed, 0 errors in 16286 ms; no reproduction oracle | 1641 / 4 / 4 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0251 | 71 | replan_stop | no_oracle_best_guess_rejected |
| psf__requests-1142 | none (no_blocks) | fixed 0, open 0, parked 1 | 5/26 scoped tests pass, 21 failed, 0 errors in 731 ms; no reproduction oracle | 1664 / 5 / 5 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: model_patch did not apply) | 10 | $0.0169 | 17 | replan_stop | best_guess_wrong |
| *psf__requests-2931 | none (weak_network) | fixed 1, open 0, parked 0 | 85/167 scoped tests pass, 0 failed, 81 errors in 937 ms; reproduction repro::b5e65acf fails (UnicodeDecodeError: 'ascii' | 3984 / 2031 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 1 | no | fail (local-venv) | 11 | $0.0183 | 132 | replan_stop | evaluator_fail_on_committed_patch |
| pylint-dev__pylint-4604 | none (passes_on_base) | fixed 0, open 0, parked 1 | 115/115 scoped tests pass, 0 failed, 0 errors in 3275 ms; no reproduction oracle | 1563 / 5 / 5 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 9 | $0.0234 | 28 | replan_stop | best_guess_wrong |
| pylint-dev__pylint-4970 | none (no_blocks) | fixed 0, open 0, parked 1 | 89/91 scoped tests pass, 0 failed, 0 errors in 4116 ms; no reproduction oracle | 1844 / 5 / 5 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 6 | $0.0178 | 31 | replan_stop | best_guess_wrong |
| pylint-dev__pylint-6386 | none (no_pick) | fixed 0, open 0, parked 1 | 30/31 scoped tests pass, 0 failed, 0 errors in 3721 ms; no reproduction oracle | 211 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 7 | $0.0171 | 18 | replan_stop | no_oracle_no_guess |
| pytest-dev__pytest-10051 | none (not_runnable) | fixed 0, open 0, parked 1 | 62/62 scoped tests pass, 0 failed, 0 errors in 1177 ms; no reproduction oracle | 1577 / 5 / 2 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 21 | $0.0471 | 31 | max_replans | best_guess_wrong |
| pytest-dev__pytest-10081 | none (not_runnable) | fixed 0, open 0, parked 1 | 210/226 scoped tests pass, 4 failed, 0 errors in 4900 ms; no reproduction oracle | 1347 / 5 / 1 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0470 | 53 | max_replans | no_oracle_best_guess_rejected |
| pytest-dev__pytest-10356 | none (no_pick) | fixed 0, open 0, parked 1 | 199/205 scoped tests pass, 5 failed, 0 errors in 2003 ms; no reproduction oracle | 1589 / 5 / 1 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0257 | 21 | replan_stop | no_oracle_best_guess_rejected |
| pytest-dev__pytest-7205 | none (not_runnable) | fixed 0, open 0, parked 1 | 354/361 scoped tests pass, 3 failed, 0 errors in 11348 ms; no reproduction oracle | 1433 / 5 / 3 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0484 | 69 | max_replans | no_oracle_best_guess_rejected |
| pytest-dev__pytest-7324 | none (incomplete_snippet) | fixed 0, open 0, parked 1 | 377/398 scoped tests pass, 14 failed, 2 errors in 8621 ms; no reproduction oracle | 1478 / 5 / 1 | 2 / 0 (0 blocked pm, 2 declined) | 0 | yes | fail (local-venv: empty model_patch) | 21 | $0.0442 | 59 | max_replans | no_oracle_best_guess_rejected |
| *sympy__sympy-11618 | strong | fixed 0, open 0, parked 1 | 645/770 scoped tests pass, 0 failed, 42 errors in 27419 ms; reproduction repro::7f52cda6 fails (1) in 1300 ms | 22492 / 1272 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 5 | no | fail (local-venv: empty model_patch) | 17 | $0.1345 | 1165 | replan_stop | ranked_run_but_regressions |
| *sympy__sympy-12096 | weak | fixed 0, open 0, parked 1 | 794/960 scoped tests pass, 0 failed, 80 errors in 55135 ms; reproduction repro::fcbb4c5a fails (f(g(2))) in 3468 ms | 27321 / 1357 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 6 | no | fail (local-venv: empty model_patch) | 21 | $0.1629 | 1454 | max_replans | ranked_run_but_regressions |
| sympy__sympy-12489 | none (no_blocks) | fixed 0, open 0, parked 1 | 806/980 scoped tests pass, 0 failed, 91 errors in 5738 ms; no reproduction oracle | 1433 / 5 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | yes | fail (local-venv) | 10 | $0.0243 | 52 | replan_stop | best_guess_wrong |
| sympy__sympy-13798 | none (no_pick) | fixed 0, open 1, parked 0 | 0/1 scoped tests pass, 0 failed, 1 errors in 4457 ms; no reproduction oracle | 0 / 0 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 0 | no | fail (local-venv: empty model_patch) | 9 | $0.0209 | 37 | replan_stop | no_oracle_no_guess |
| *sympy__sympy-15345 | strong | fixed 1, open 0, parked 0 | 142/175 scoped tests pass, 0 failed, 0 errors in 38379 ms; reproduction repro::9364c244 fails ('Max(2, x)') in 4220 ms | 1888 / 74 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 4 | $0.0168 | 319 | complete | solved |
| *sympy__sympy-16792 | strong | fixed 0, open 1, parked 0 | 190/198 scoped tests pass, 0 failed, 0 errors in 13774 ms; reproduction repro::3492baa3 fails (CodeWrapError: Error whil | 41424 / 1489 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 8 | no | fail (local-venv: empty model_patch) | 18 | $0.2247 | 1263 | max_replans | reachable_not_ranked_in_budget |
| *sympy__sympy-17139 | strong | fixed 1, open 0, parked 0 | 929/1013 scoped tests pass, 0 failed, 0 errors in 155635 ms; reproduction repro::ac95b0c9 fails (TypeError: Invalid comp | 1365 / 16 / 1 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 4 | $0.0158 | 498 | complete | solved |
| *sympy__sympy-19954 | strong | fixed 1, open 0, parked 0 | 109/112 scoped tests pass, 0 failed, 0 errors in 103000 ms; reproduction repro::db420b5d fails (IndexError: list assignm | 1524 / 23 / 3 | 1 / 1 (0 blocked pm, 0 declined) | 0 | no | PASS (local-venv) | 6 | $0.0194 | 723 | replan_stop | solved |
| sympy__sympy-20428 | strong | fixed 0, open 0, parked 1 | 341/342 scoped tests pass, 0 failed, 0 errors in 12585 ms; reproduction repro::ddf82674 fails (Poly(0, x, domain='EX'))  | 9093 / 246 / 0 | 0 / 0 (0 blocked pm, 0 declined) | 4 | no | fail (local-venv: empty model_patch) | 14 | $0.0910 | 544 | replan_stop | reachable_not_ranked_in_budget |
| sympy__sympy-22080 | none (passes_on_base) | fixed 0, open 0, parked 1 | 251/306 scoped tests pass, 0 failed, 0 errors in 13481 ms; no reproduction oracle | 1332 / 5 / 4 | 2 / 0 (2 blocked pm, 0 declined) | 0 | yes | fail (local-venv: empty model_patch) | 9 | $0.0240 | 86 | replan_stop | no_oracle_best_guess_rejected |

Script totals: `30 instances; oracle strong 8, weak 2, unstable 0, none 20; patches applied 12; best guess used 17;
evaluator pass 4/30; engine rejections: 16 blocked (plan_mismatch) + 8 declined (review, no reviewer) on 12 instances;
Jev $1.2956; wall 7102 s (sum)`. The script's `16 blocked + 8 declined` counts patch-proposal rejections; the record
counters (`blocked` 228 = 218 risk blocks + 10 declined steps) count every step, including the `done` claims.

### 26.3 Failure classes

Script tally: **`no_oracle_best_guess_rejected` 11, `best_guess_wrong` 6, `solved` 4, `evaluator_fail_on_committed_patch`
3, `no_oracle_no_guess` 2, `ranked_run_but_regressions` 2, `reachable_not_ranked_in_budget` 2.** One correction from the
verification: `psf__requests-1142`'s 871,679-byte "patch" is 65 new files under `build/lib/requests/**` left by the
environment build and swept up by the `git add -A -N && git diff` extraction; the engine's only proposal was blocked and
rolled back, so the source change is empty and the class is really `no_oracle_best_guess_rejected` (corrected tally 12 /
5; the 4/30 is unchanged). Reading the tally: the script finds an oracle on 10 instances (the §17 nine minus
`requests-2931`, whose `weak_network` oracle it files under `none`, plus `sympy-20428`, `strong` here) and none on 20.
Of the 20: on 11 (12 corrected) the best-guess commit was rejected by the risk stage or the absent reviewer and on 2
there was no guess, so 13 ended with an empty patch; on 6 (5 corrected) the best guess applied and failed the tests;
`requests-2931`'s lone passer was committed as possible overfit and failed the hidden tests. Of the 10: 4 solved, 2
committed a passer that failed the hidden tests (`django-15315`, `django-15563`), 2 ranked and ran candidates that
regressed (`sympy-11618`, `sympy-12096`; 1,272 and 1,357 tested, 0 plausible), and 2 never reached the gold site in
budget (`sympy-16792`, 41,424 enumerated, 1,489 tested; `sympy-20428`, 9,093 / 246).

### 26.4 The four passes against the upstream fixes

None is gold-identical and none is shown equivalent-in-effect; each is a different shape the tests accept.
`sympy-15345` adds one line, `_print_Expr = _print_Function`, in `MCodePrinter` (gold adds `Max`/`Min` to
`known_functions` and `_print_MinMaxBase = _print_Function`): the alias re-routes every `Expr` subclass without its own
printer through `_print_Function` (`Indexed`, `Product`, `Piecewise` now print as `Indexed[...]`, `Product[...]`,
`Piecewise[...]`), which gold does not. `sympy-17139` guards `if not rv.exp.is_comparable: return rv` where gold uses
`is_real`: identical on `I`, `x`, `1 + I` and every numeric exponent tried, different on symbolic real exponents
(`n` positive, `k` integer, `r` real), where the model returns early and gold proceeds. `sympy-19954` inserts
`if i >= len(num_blocks): break` before `del num_blocks[i], blocks[i]` (gold rewrites the loop with a remove mask):
identical `minimal_blocks()` on 60 groups tried, general equivalence not shown. `django-15128` appends `alias +=
table_name` in `Query.table_alias` (gold is a three-hunk `bump_prefix(..., exclude=...)` change): every generated join
alias becomes `T2queries_tag`-style instead of `T2`, in every multi-join query. Each passes FAIL_TO_PASS and the listed
PASS_TO_PASS subset only; "solved" here means exactly that.

### 26.5 Independent verification of §25 and §26, and the restatements it forces

Sixteen read-only checks (claim verifiers and refuters, 2026-09-21) re-derived every number in §25 and §26 from the raw
records and then tried to break each headline. What reproduced: all counts, costs, step vectors and stop reasons of the
three final runs; the QuixBugs evaluator re-run on all 40 workspace programs (39/40, 0 disagreements) and the verdict
script re-run (byte-identical `verdicts.md`); the ladder evaluator re-run in all 20 workspaces (14/20, `tests/`
byte-identical to the reference in every workspace, only `src/*.py` modified); the four SWE-bench passes down to the eval
checkouts; 6,598 Jev requests all on the pinned model, `generatorCalls` 0 on 90/90 records, no foreign LLM host in any
run directory. What did not survive, and how §25 must now be read:

1. **QuixBugs `topological_ordering` is wrong, so §25.1's "39 solved, 0 overfit" is a visible-suite count with one
   overfit the script cannot see.** The committed patch (`~/.jevcode/runs/20260921-023509-t3pnzjqk/model_patch.diff`)
   replaces `if set(ordered_nodes).issuperset(nextnode.incoming_nodes) and nextnode not in ordered_nodes:` with `if
   nextnode not in ordered_nodes:` and adds a `break` after the append. Against `bench/data/quixbugs/correct/`:
   `A->B, A->C` gives `[A, B]` (gold `[A, B, C]`); `A->C, A->B, B->C` gives `[A, C]`; the diamond gives `[A, B, D]`;
   invalid on 462/1000 random 2–8-node DAGs. It passes the three visible fixtures, which are the evaluator's whole
   oracle. The script labels it `unverified` because `perturb.ts` has no graph perturbation — the transcript shows the
   same blindness in the search (`probe 0 inputs` at both arbitrations), the mechanism that also committed
   `shortest_path_length`'s `return 4`. The earlier runs' patches were also wrong except run 3's (6-repeat1/2: `[A, C, B]`
   on `A->C, A->B, B->C`); three distinct committed patches over four runs, two incorrect, all labelled `unverified`.
   `breadth_first_search`, the other `unverified`, is equivalent to gold on 500 random graphs. **Restated: 39/40 pass
   the reference cases; 37/40 verified correct; at most 38/40 correct; 1 shown overfit; the "0 overfit" is scoped to the
   31 JSON-case programs and the two chain programs the probe perturbs.** `shortest_path_length` is a persistent
   regression (gold-identical in run 3, missed in 6-repeat1, 6-repeat2 and here), not a first-time miss. The §25.1 line
   "both pass their reference cases" now says so.
2. **Ladder `grades` and `textstats` are behaviourally wrong, so §25.2's "12/12" is solved, not correct.** Confirmed by
   differential execution against `gold/`: `grades.letter_grade(89.5)` → `'A'` (gold `'B'`; 79.9, 69.01, 59.5 also one
   letter high; `report({'x': [89, 90]})` → `'A'` vs `'B'`); `textstats.ngrams(('a', 'b', 'c'), 2)` raises
   `AttributeError` (gold returns the bigrams) and `ngrams(list, n)` appends `n` to the caller's list. Both fixes were
   arbitrated "in 1 cluster (no probe)" and recur in earlier rounds (`grades` in ladder-4/5/6/7, `textstats` in 5/7).
   Also found: `ledger5.is_overdue` returns an int where gold returns a bool (passes by truthiness), `units.parse_duration('')`
   raises `IndexError` where gold raises `ValueError`. **Restated: short tier 12/12 solved, at most 10/12 correct; total
   14/20 solved, at most 12/20 correct (11/20 if `is_overdue`'s type counts).** There was no ladder correctness check until
   now; `experiments/inspect/ladder-verdicts.mts` is being written (gold vs patched on hand-written inputs per task).
3. **Hunk counts in §25.2 mix two rules.** By strict `diff -U0` of the patched tree against `gold/` (gold-identical lines
   only): `ledger5` 2/5 (the §25.2 table's "3/5" counts an insert that leaves the buggy line dead below it),
   `import_and_guard` 2/4 (its "3/4" counts `import re` one line below gold's), `long_chain` 3/6, `regress_trap` 3/4,
   `six_hunks` 1/6 (the table's "1/6 (h6) + h3*" is right; the cross-run row's and §25.3 item 6's "2/6" count the
   test-equivalent `t.due == None`), `masked` 0/3 — but 1/3 under the same equivalence rule (`txt = text` is an alias for
   h1), and its final tree also carries an overfit `return 0` above `aggregate.py:19`; `crossfile` 0/4, `shared_frame`
   0/2. `six_hunks`' third edit, `render.py:20 width - 1`, is a caller-side change at a different line from gold's
   `render.py:14` and is not a matching hunk. The §25 tables are left as written; this list is the reconciled one, strict
   first with equivalents in parentheses. Two smaller slips in §25.2: the short-tier step median is 4.5, not 4
   (`[3,3,3,3,3,4,5,5,5,5,7,7]`); `ledger5`'s "13 steps" includes step 11, which carried no proposal (an invalid Jev
   response, `"edit" (0.49) is not an argmax`, recorded in no counter).
4. **Single draws.** Every final-tree number is one run on `55404ba`. The only same-tree QuixBugs pair (6-repeat1/2 at
   `d610d75`) flipped 2/40 programs; in the final run `mergesort` passed at 455 s of the 480 s wall and $0.040 of the
   $0.05 cap, `lis` at 421 s, and all 13 loop trips sit in the four 10–11-step runs. Ladder long-tier tasks have flipped
   across runs (`regress_trap` pass → fail → fail on byte-identical data; `masked` fail ×5 → pass in 3c → fail here on a
   wall-budget release under load), and the decider returned different probabilities on 14/20 byte-identical requests
   between two `account` runs five minutes apart. SWE-bench: §26.1. The design's own rung-2 bar (≥ 8/12 in ≥ 2 of 3
   repeats *of one tree*) has not been met on any single tree.
5. **In-sample, and no hidden suite.** QuixBugs and ladder evaluators run exactly the cases the workspace exposes;
   guard/site thresholds were derived from named programs (`guard.ts:74-86` from `depth_first_search`/`wrap`,
   `sites.ts:116-117` from `reverse_linked_list`, `perturb.ts` from `detect_cycle`/`wrap`; ladder task names appear in
   code comments and commit messages throughout); the design's R2 hidden-test experiment
   (`experiments/contrarian/hidden-tests.mts`, trigger "overfit > 1" fired at run 3) was never written. The SWE-bench
   final's four solved instances were the reach-study targets (§26.1).
6. **Provenance and gates.** No run record stores a git sha (§26.1). On the frozen tree `55404ba`: `tsc --noEmit` exit 0,
   `node scripts/no-any.mjs` ok, `vitest run --project unit` 221 files / 4,045 tests exit 0; `npm run perf` passes every
   budget — first frame cold p95 104.2 ms (< 300 ms; cold median 101.2, warm median 85.4), harness overhead per step p95
   33.5 ms (< 50 ms; p50 22.1), event-loop lag p95 2.4 ms / 1.8 ms at rows 40 / 12 (< 5 ms), 0 / 0 terminal clears after
   the first frame.

What would settle each: graph-fixture perturbations or a hand-written DAG set for the nine pytest-module programs in
`quixbugs-verdicts.mts`, re-run on all four result dirs; the ladder verdict pass; two more full runs of each suite on the
frozen worktree with the machine otherwise idle; official-harness grading of `predictions.jev-only.jsonl`; a git sha in
`run.json`. The reporting rule that follows — solved and correct as separate numbers on every row — is
`docs/DECISIONS.md` (2026-09-21).

### 26.6 Commands

```
# from .claude/worktrees/final-clean (HEAD 55404ba); log /tmp/jevonly/swebench-4.log, RSS sampler /tmp/jevonly/swebench-4-rss.sh
env -u ANTHROPIC_API_KEY NODE_OPTIONS=--max-old-space-size=8192 node --env-file=/Users/prateekjannu/Documents/vscode/JevCode/.env \
  node_modules/.bin/tsx src/cli/main.tsx bench --suite swebench --conditions jev-only --live \
  --concurrency 2 --max-steps 25 --max-wall 25m --task-spend-cap 0.4 \
  --out /Users/prateekjannu/Documents/vscode/JevCode/bench/results/jev-only-swebench-4-final
# main checkout: the per-instance table of §26.2
env -u ANTHROPIC_API_KEY node node_modules/.bin/tsx experiments/inspect/swe-report.mts bench/results/jev-only-swebench-4-final \
  --mark=sympy__sympy-15345,sympy__sympy-17139,sympy__sympy-19954,sympy__sympy-11618,django__django-15315,django__django-15128,psf__requests-2931,sympy__sympy-12096,django__django-15563,sympy__sympy-16792
```

The launcher script for this run was not preserved (only `run-swebench-3.sh` survives under `/tmp/jevonly`); the flags
above are the run's `summary.json` limits (`maxSteps` 25, `maxWallMs` 1,500,000, `taskSpendCapUsd` 0.4, `maxReplans` 5,
`completeThreshold` 0.85) and the rung-3 launcher shape, with the process cwd from `run.json`. Run ids for the four
passes: `20260921-022509-ebhus7rl` (15345), `20260921-023131-aqsxtrur` (17139), `20260921-024201-7dmqjwln` (19954),
`20260921-032451-72clti7n` (15128); eval checkouts under `~/.jevcode/runs/<run id>/eval/<instance>/`.

## 27. 2026-09-21: verdict scripts — graph perturbations and a ladder correctness check

Follow-up to the §26 verification, code only (no Jev, no live run; `python3` differential runs). Two gaps in the verdict
tooling were closed and every affected `verdicts.md` regenerated.

**QuixBugs — `experiments/inspect/quixbugs-verdicts.mts`.** The script labelled the pytest-module programs `unverified`
because its perturbations come from `src/synth/search/perturb.ts`, which handles JSON cases, strings and Node chains only. It
now runs, for the nine programs whose tests build Node/graph fixtures, a random-structure differential in the probe's own
process shape (candidate imported under the program name, `programs/` on `sys.path`, `PYTHONHASHSEED=0`, SIGALRM per
input, one protocol line): 500 instances per program from seed 20260921, built identically in the patched and the reference
process — DAGs of 0–8 nodes judged by a validity oracle (any correct topological order counts), digraphs with a start and a
goal, linked lists of 0–12 nodes acyclic or with the tail linked to a random node, weighted graphs judged as minimum spanning
forests of equal weight, digraphs with distinct power-of-two lengths (so the reference's heap never compares two Nodes — the
QuixBugs reference raises `TypeError` on ties, 56/500 instances with small random weights), digraphs with negative weights
and no negative cycle (potential reweighting). Any mismatch is `overfit`; the existing labels are unchanged.

| run | before (gold-identical / equivalent / overfit / unverified / miss) | after | correct before → after |
|---|---|---|---|
| `jev-only-quixbugs-3` | 27 / 5 / 2 / 2 / 4 | 27 / 7 / 2 / 0 / 4 | 32 → 34 |
| `jev-only-quixbugs-6-repeat1` | 28 / 7 / 1 / 2 / 2 | 28 / 7 / 3 / 0 / 2 | 35 → 35 |
| `jev-only-quixbugs-6-repeat2` | 28 / 8 / 0 / 2 / 2 | 28 / 8 / 2 / 0 / 2 | 36 → 36 |
| `jev-only-quixbugs-7-final` | 30 / 7 / 0 / 2 / 1 | 30 / 7 / 2 / 0 / 1 | 37 → 37 |

Every overfit, with a failing input (all pass their reference cases):
- `topological_ordering` — 7-final (drops the `issuperset(incoming_nodes)` check and adds `break`): 252/500 DAGs, e.g. nodes
  DECBA, edges E->B, E->C → `['D','E','A','B']` (C dropped) where the reference order is valid; 6-repeat1 and 6-repeat2
  (drops the check only): 92/500, e.g. edges E->G, C->G, E->F, F->G, A->G → `['E','C','A','B','D','G','F']` (G before F). In
  run 3 the same program is `equivalent` (500/500 valid orders), as is `breadth_first_search` in all four runs (500/500).
- `detect_cycle` — run 3 (the §6.3 overfit): 3/16 chains and 99/500 random lists, e.g. an acyclic list of 6 → `AttributeError`
  vs `False`; 6-repeat1, 6-repeat2 and 7-final (`if hare.successor is None` first): 1/500 — the empty list (`None`), which
  the reference answers `False` and the patch answers `AttributeError`; identical on the other 499 and on the 16 chains.
  These three were `equivalent` before; the empty list is the only input that separates them.
- `wrap` — run 3 and 6-repeat1: 8/24, e.g. `wrap("The", 50)` → `[]` vs `['The']` (unchanged from before).

**Ladder — `experiments/inspect/ladder-verdicts.mts` (new).** The ladder had no correctness check: "complete" meant the
task's own tests pass. For every solved task the script applies the run's `model_patch.diff` to a private copy of
`bench/data/ladder/tasks/<task>` (else the bench workspace `src/`) and compares it with `gold/`: (a) per-module token
comparison (`gold-identical`); (b) a differential — every public function and method of the gold modules is wrapped by a
recorder, the task's `tests/test_*.py` are imported and their test functions run so the recorder sees the arguments the
tests pass and every nested call; each distinct call is perturbed one argument at a time (ints ±1 and x±0.5, floats ±0.5
and ⌊x⌋+0.5, strings emptied / one character, sequences emptied / one element / last dropped, tuple for list and list for
tuple, dates ±1 day, None; ≤ 80 perturbed inputs per function, seed 20260921), and every input is replayed on the gold and
the patched tree comparing the canonical result, the exception class and the arguments after the call. `overfit` is
*strong* (a different value, one side raises where the other returns, or the arguments are mutated differently) or *weak
only* (both raise but a different class; a bool-returning function returning an int of the same truthiness).

`bench/results/jev-only-ladder-7-final/verdicts.md`: short tier solved 12/12, **correct 8/12** (gold-identical 5,
equivalent 3), overfit 4 — strong `grades`, `textstats`; weak only `stats`, `units`; long tier solved 2/8, **correct
1/8** (`import_and_guard` equivalent over 295 inputs), overfit 1 weak only (`ledger5`). Counting the weak-only rows as
correct: 10/12 and 2/8. The failing inputs:
- `grades` (`minimum -= 1`): `letter_grade(59.5)` → 'D' vs 'F', 69.5 → 'C' vs 'D', 79.5 → 'B' vs 'C', 89.5 → 'A' vs 'B'
  (4/132 inputs).
- `textstats` (`tokens.append(n)`): `ngrams(('a','b','c'), 2)` → `AttributeError` vs `[('a','b'),('b','c')]`; on a list the
  result is right but the caller's list is left as `['a','b','c',2]` (20/94 inputs: 3 value, 16 argument-mutation, 1 exception class).
- `stats` (guard placed after the odd-length branch): only `median(None)` / `summary(None)` → `TypeError` vs `ValueError`
  (2/111; the empty list is handled).
- `units` (dead `number, unit = text[:-1], text[-1]` left above the donor body): only `parse_duration('')` → `IndexError`
  vs `ValueError` (1/54).
- `ledger5`: `is_overdue` returns `min(0, (due - today).days)` — an int, -1 for the day after the due date (gold `True`), 0 on
  or before it (gold `False`); truthiness agrees on all 24 inputs that differ, the annotated `-> bool` does not (24/449).

`bench/results/jev-only-ladder-5/verdicts.md` (short tier only): solved 11/12, **correct 7/12**, overfit 4 — strong `grades`,
`textstats` (the same two patches) and `units`, whose fallback is a literal `return 90`: `parse_duration('1')` → 90 vs 1
(4/54); weak only `stats`.

Commands (from the repository root; nothing asks Jev):

```
for d in jev-only-quixbugs-3 jev-only-quixbugs-6-repeat1 jev-only-quixbugs-6-repeat2 jev-only-quixbugs-7-final; do
  node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts bench/results/$d; done      # --graph-n 500 --seed 20260921
node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts bench/results/jev-only-ladder-7-final   # --per-fn-cap 80 --seed 20260921
node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts bench/results/jev-only-ladder-5
```
