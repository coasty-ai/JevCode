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
| topological_ordering | no (overfit), 12, max_steps, 1 / 0, 4, 0.0049 | **yes, 10, complete**, 2 / 1, 1, 0.0051 | two goals fixed in turn (0→2, then 2→3 of 3); passes the hidden test now; the first patch was declined once at level 2 (9.5b) and re-proposed |
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
