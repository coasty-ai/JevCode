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
