# Progress judgment probe: can Jev steer a repair search from test results? (2026-09-20)

Live probe, model `typesafe/jev-1.13-20260917` via OpenRouter, no generating LLM anywhere. 40 QuixBugs
Python programs x 6 candidate patches = 240 (program, edit, before-run, after-run) items. Ground truth
for every question is computed in code from the test runs. Total spend for everything in this file
(main run + follow-up + one smoke run): **$0.089**, 1,298 requests, Jev latency p50 190-225 ms.

Scripts (all under `experiments/progress/`, reproducible end to end):

| file | role |
| --- | --- |
| `run_tests.py` | QuixBugs runner without pytest: `run_tests.py <candidate.py> <program>` runs each test in its own subprocess with a 2 s timeout and prints JSON `{total, passed, failed, first_failure, tests:[{id, input, expected, actual, status}]}`; status in `pass / fail / error / timeout`. JSON-tested programs run `f(*args) == expected` (generators are listed, `sqrt` uses the abs tolerance of its last argument as QuixBugs' own test does). The 9 graph/list programs (`breadth_first_search`, `depth_first_search`, `detect_cycle`, `minimum_spanning_tree`, `reverse_linked_list`, `shortest_path_length(s)`, `shortest_paths`, `topological_ordering`) run their `python_testcases/test_<p>.py` functions with a stub `pytest` module; `input` is the docstring case line. |
| `gen_candidates.py` | builds the 6 candidates per program (below) and runs the tests on each; writes `candidates.json` with per-candidate labels. |
| `probe.mts` | Parts 1-4 (994 requests, $0.0668). Writes `results.json`. |
| `probe2.mts` | follow-up: next-move Choice variant B and a 3x noise repeat on the partial candidates (279 requests, $0.0207). Writes `results2.json`. |
| `analyze.py` | produces every table below (`tables.md`). |

Run: `python3 experiments/progress/gen_candidates.py` (about 6 min, spawns test subprocesses), then
`env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/progress/probe.mts`,
`... probe2.mts`, `python3 experiments/progress/analyze.py`.

## Candidate construction

Per program: the **fix** (correct program), the **buggy original re-applied** (`buggy_noop`, an edit
whose after-run equals the before-run), and 4 single-line mutants of the buggy program chosen from a
budget of 24 evaluated mutants (mutation operators: comparison flips, `+/-1`, `and/or`, `+/-`,
`*//`, `True/False`, `not` removal, `[0]/[-1]`, `///`, `^=/&=/|=`, `range` bounds, `min/max`,
argument swap, identifier substitution with another in-program identifier; half the budget on the
buggy line, up to 4 per other line). Selection preferred one **partial** mutant (passes strictly more
tests than the buggy original, breaks none) when one existed, then one regression, one no-change and
one lateral mutant. 13 programs had a partial mutant within budget (10 clean, 3 that also broke a
test). Two tests the *correct* program does not finish in 2 s were excluded for that program
(`knapsack` test 9, the QuixBugs slow case; `levenshtein` test 3). The before-run of the buggy
original fails at least one test on all 40 programs; the fix passes all remaining tests on all 40.

Definitions of the ground-truth labels (all code-computed from the two runs):

- `correct` = after.passed == after.total
- `progress` = after.passed > before.passed
- `broke` = some test with status pass in before and not pass in after

## Exact state shapes and question wording

Three state variants for Parts 1 and 4, all **results only** (no code, no diff):

```
counts: { passed, failed, total, first_failure: {input, expected, actual} | null }
raw:    { failing_tests: [ {test: "test_3", input, expected, actual, status}, ... ] }   (no counts, no total)
both:   { passed, failed, total, failing_tests: [...] }
state = { task, before: <variant>, after: <variant> }
task = "A candidate edit was applied to the Python function `<name>`. `before` is the test result of
the program before the edit; `after` is the test result after the edit. Judge from the test results
only. A test counts as failing if its status is fail, error or timeout."
```

Nouls (each with true/false definition + examples, built with `noul()` from `src/jev/questions.ts`):

| id | instructions | true definition | false definition |
| --- | --- | --- | --- |
| `program_correct` | After the edit, does `after` show the program passing every test, so that the program is now correct? | every test passes in `after`; no failing, erroring or timed-out test remains (ex: "`after.failed` is 0 and `after.passed` equals `after.total`", "`after.failing_tests` is an empty list") | at least one test still fails, errors or times out in `after` (ex: "`after` lists two failing tests", "`after.passed` is 8 of 9", "one test times out after the edit") |
| `made_progress` | Compared with `before`, did this edit make progress: does the program pass strictly more tests in `after` than in `before`? | the number of passing tests in `after` is larger than in `before` (fewer tests fail after the edit than before it) (ex: "before passed 1 of 9, after passes 4 of 9", "a test listed under `before.failing_tests` is missing from `after.failing_tests` and no new failure appeared") | the same number or fewer tests pass after the edit; the results are unchanged or worse (ex: "before and after list the same failing tests", "after passes fewer tests than before", "the failing tests changed but their number did not shrink") |
| `broke_something` | Did the edit break something that worked: is there a test that passed in `before` but fails, errors or times out in `after`? | at least one test that was passing before the edit is failing after it (ex: "a test appears in `after.failing_tests` that is not in `before.failing_tests`", "before passed 5 of 6, after passes 0 of 6") | every test that passed before the edit still passes after it (ex: "the set of failing tests shrank or stayed exactly the same", "before passed 1 of 9, after passes 9 of 9") |

Score `closeness` (Part 4), asked in the same request: "Judging from `after` only, how close is the
program to correct?" with levels `nothing works: every test fails, errors or times out` /
`mostly broken: a small minority of the tests pass, most fail` / `half way: roughly as many tests
pass as fail` / `nearly correct: most tests pass, a few still fail` / `correct: every test passes,
no failures remain`.

Next-move Choice (Part 2), state `{task, edit: {line, old_line, new_line}, before: both, after: both,
search: {candidates_remaining_for_this_line, untried_suspicious_lines}}`, instructions "What should
the repair loop do next, given `edit`, `before`, `after` and `search`?", options (variant A):

| option | description |
| --- | --- |
| `keep_and_stop` | every test passes in `after`: keep the edit and finish the task |
| `keep_and_continue` | the edit made some previously failing tests pass without breaking any, and failures remain: keep the edit and work on the remaining failing tests |
| `revert_and_try_next_candidate` | the edit did not help or broke tests, and `search.candidates_remaining_for_this_line` is above zero: revert the edit and try the next candidate edit for the same line |
| `revert_and_relocalise` | the edit did not help or broke tests, no candidates remain for this line, and `search.untried_suspicious_lines` is above zero: revert and move to a different suspicious line |
| `widen_search` | the edit did not help or broke tests, no candidates remain for this line and no untried suspicious lines remain: revert and widen the search to more lines or another source of candidate edits |
| `none_of_these` | (escape, null) |

Expected move per case: fix -> `keep_and_stop`; partial -> `keep_and_continue`; partial_mixed ->
either `keep_and_continue` or `revert_and_try_next_candidate` accepted; every wrong candidate
(regression / lateral / no_change / buggy_noop) gets one of three code-assigned search contexts in
rotation: `(3 remaining, 2 untried lines)` -> `revert_and_try_next_candidate`; `(0, 2)` ->
`revert_and_relocalise`; `(0, 0)` -> `widen_search`.

Variant B (follow-up) adds two code-computed numbers to `after` (`newly_passing_tests`,
`newly_failing_tests`) and rewrites every option description in terms of those fields and
`after.failed` (e.g. `keep_and_continue`: "`after.newly_passing_tests` is above zero,
`after.newly_failing_tests` is 0 and `after.failed` is above zero: the edit is a step forward, keep
it and work on the remaining failing tests"). Full text in `probe2.mts`.

Attack-first Choice (Part 3), state `{task, failing_tests: {failing_test_<id>: {input, expected,
actual, status}}}` over the first 10 failing tests of the buggy original, two independent Choices
in one request: **neutral** "Which entry of `failing_tests` should the repair attack first?" and
**explicit** "Which entry of `failing_tests` has the smallest and simplest input, so that the
failure is easiest to understand and reproduce by hand?" (options keyed `failing_test_<id>` with
null descriptions plus `none_of_these`). "Simplest" ground truth = shortest JSON serialisation of
the input.

## Results

Run: 2026-09-20T15:25:51Z, model `typesafe/jev-1.13-20260917`, 40 programs, 240 candidates, 994 requests, cost $0.0668, Jev latency p50 190 ms, p95 319 ms.

### Candidate set

| kind | n | definition (ground truth computed from the test runs) |
| --- | --- | --- |
| fix | 40 | correct program; every test passes |
| partial | 10 | passes strictly more tests than `before`, breaks none, some still fail |
| partial_mixed | 3 | passes more tests than `before` but also breaks at least one that passed |
| regression | 76 | passes fewer tests than `before` |
| lateral | 6 | same pass count as `before` but a different set (broke one, fixed another) |
| no_change | 65 | a different program with the same set of passing tests as `before` (actual outputs may differ: 48/65 print different wrong values) |
| buggy_noop | 40 | the buggy original re-applied (no-op edit): results identical to `before` (counted under no_change in the label tables) |

### Part 1. Nouls from test results

| Noul | variant | n | positives | acc @0.5 | best thr (acc) | Brier | AUROC | wrong @0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| program_correct | counts | 240 | 40 | 1.000 | 0.95 (1.000) | 0.000 | 1.000 | 0 |
| program_correct | raw | 240 | 40 | 1.000 | 0.90 (1.000) | 0.000 | 1.000 | 0 |
| program_correct | both | 240 | 40 | 1.000 | 0.95 (1.000) | 0.000 | 1.000 | 0 |
| made_progress | counts | 240 | 53 | 1.000 | 0.95 (1.000) | 0.001 | 1.000 | 0 |
| made_progress | raw | 240 | 53 | 0.988 | 0.40 (1.000) | 0.009 | 1.000 | 3 |
| made_progress | both | 240 | 53 | 1.000 | 0.90 (1.000) | 0.001 | 1.000 | 0 |
| broke_something | counts | 240 | 85 | 0.983 | 0.30 (0.988) | 0.014 | 1.000 | 4 |
| broke_something | raw | 240 | 85 | 0.938 | 0.25 (0.992) | 0.042 | 1.000 | 15 |
| broke_something | both | 240 | 85 | 1.000 | 0.55 (1.000) | 0.008 | 1.000 | 0 |

Accuracy at 0.5 by candidate kind (counts / raw / both):

| kind | n | program_correct | made_progress | broke_something |
| --- | --- | --- | --- | --- |
| fix | 40 | 40/40 / 40/40 / 40/40 | 40/40 / 40/40 / 40/40 | 40/40 / 40/40 / 40/40 |
| partial | 10 | 10/10 / 10/10 / 10/10 | 10/10 / 7/10 / 10/10 | 10/10 / 10/10 / 10/10 |
| partial_mixed | 3 | 3/3 / 3/3 / 3/3 | 3/3 / 3/3 / 3/3 | 1/3 / 2/3 / 3/3 |
| regression | 76 | 76/76 / 76/76 / 76/76 | 76/76 / 76/76 / 76/76 | 76/76 / 62/76 / 76/76 |
| lateral | 6 | 6/6 / 6/6 / 6/6 | 6/6 / 6/6 / 6/6 | 4/6 / 6/6 / 6/6 |
| no_change | 105 | 105/105 / 105/105 / 105/105 | 105/105 / 105/105 / 105/105 | 105/105 / 105/105 / 105/105 |

Every answer wrong at 0.5:

| Noul | variant | program | candidate | kind | before | after | truth | p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| made_progress | raw | bitcount | mutant_1_partial | partial | 0/9 | 2/9 | True | 0.46 |
| made_progress | raw | bucketsort | mutant_1_partial | partial | 1/7 | 2/7 | True | 0.40 |
| made_progress | raw | sqrt | mutant_1_partial | partial | 1/7 | 2/7 | True | 0.45 |
| broke_something | counts | find_in_sorted | mutant_4_lateral | lateral | 5/7 | 5/7 | True | 0.43 |
| broke_something | counts | gcd | mutant_1_partial_mixed | partial_mixed | 1/6 | 3/6 | True | 0.34 |
| broke_something | counts | max_sublist_sum | mutant_3_lateral | lateral | 2/6 | 2/6 | True | 0.28 |
| broke_something | counts | mergesort | mutant_1_partial_mixed | partial_mixed | 1/14 | 13/14 | True | 0.38 |
| broke_something | raw | bucketsort | mutant_2_regression | regression | 1/7 | 0/7 | True | 0.36 |
| broke_something | raw | bucketsort | mutant_4_regression | regression | 1/7 | 0/7 | True | 0.24 |
| broke_something | raw | gcd | mutant_2_regression | regression | 1/6 | 0/6 | True | 0.45 |
| broke_something | raw | gcd | mutant_4_regression | regression | 1/6 | 0/6 | True | 0.34 |
| broke_something | raw | get_factors | mutant_2_regression | regression | 1/11 | 0/11 | True | 0.42 |
| broke_something | raw | hanoi | mutant_1_regression | regression | 1/8 | 0/8 | True | 0.36 |
| broke_something | raw | hanoi | mutant_3_regression | regression | 1/8 | 0/8 | True | 0.32 |
| broke_something | raw | mergesort | mutant_1_partial_mixed | partial_mixed | 1/14 | 13/14 | True | 0.26 |
| broke_something | raw | mergesort | mutant_2_regression | regression | 1/14 | 0/14 | True | 0.23 |
| broke_something | raw | mergesort | mutant_4_regression | regression | 1/14 | 0/14 | True | 0.32 |
| broke_something | raw | possible_change | mutant_1_regression | regression | 1/10 | 0/10 | True | 0.47 |
| broke_something | raw | possible_change | mutant_3_regression | regression | 1/10 | 0/10 | True | 0.38 |
| broke_something | raw | reverse_linked_list | mutant_3_regression | regression | 1/3 | 0/3 | True | 0.42 |
| broke_something | raw | sieve | mutant_2_regression | regression | 1/6 | 0/6 | True | 0.36 |
| broke_something | raw | sieve | mutant_4_regression | regression | 1/6 | 0/6 | True | 0.35 |

Distribution of p for the `made_progress` Noul on partial candidates (the hard positives), by variant:

| program | candidate | before | after | p counts | p raw | p both | broke: p counts / raw / both |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | mutant_1_partial | 0/9 | 2/9 | 0.98 | 0.46 | 0.97 | 0.05 / 0.09 / 0.06 |
| bucketsort | mutant_1_partial | 1/7 | 2/7 | 0.96 | 0.40 | 0.93 | 0.14 / 0.09 / 0.16 |
| find_in_sorted | mutant_1_partial_mixed | 5/7 | 6/7 | 0.97 | 0.82 | 0.97 | 0.62 / 0.87 / 0.88 |
| gcd | mutant_1_partial_mixed | 1/6 | 3/6 | 0.98 | 0.76 | 0.96 | 0.34 / 0.65 / 0.57 |
| get_factors | mutant_1_partial | 1/11 | 2/11 | 0.95 | 0.92 | 0.97 | 0.07 / 0.05 / 0.09 |
| kth | mutant_1_partial | 3/7 | 5/7 | 0.98 | 0.90 | 0.98 | 0.36 / 0.20 / 0.23 |
| lcs_length | mutant_1_partial | 1/9 | 2/9 | 0.97 | 0.55 | 0.95 | 0.10 / 0.11 / 0.21 |
| levenshtein | mutant_1_partial | 1/6 | 5/6 | 0.98 | 0.98 | 0.99 | 0.43 / 0.06 / 0.07 |
| mergesort | mutant_1_partial_mixed | 1/14 | 13/14 | 0.98 | 0.96 | 0.99 | 0.38 / 0.26 / 0.56 |
| minimum_spanning_tree | mutant_1_partial | 0/3 | 1/3 | 0.97 | 0.60 | 0.97 | 0.05 / 0.10 / 0.06 |
| pascal | mutant_1_partial | 1/5 | 2/5 | 0.96 | 0.92 | 0.97 | 0.23 / 0.05 / 0.09 |
| sieve | mutant_1_partial | 1/6 | 2/6 | 0.97 | 0.70 | 0.96 | 0.18 / 0.09 / 0.12 |
| sqrt | mutant_1_partial | 1/7 | 2/7 | 0.97 | 0.45 | 0.94 | 0.10 / 0.18 / 0.31 |

### Part 4. Score calibration: `closeness` (5 levels) vs true fraction of passing tests

Rows: true pass fraction bins (0 | (0,0.4) | [0.4,0.6] | (0.6,1) | 1). Cells: how often each level was the argmax; last columns: mean expected level (sum p·k, 0..4) and mean true fraction.

Variant `counts` (n=240):

| true bin | n | nothing_works | mostly_broken | half_way | nearly_correct | correct | mean E[level] | mean true fraction | argmax = bin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nothing_works | 89 | 89 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 89/89 |
| mostly_broken | 72 | 0 | 69 | 3 | 0 | 0 | 1.06 | 0.20 | 69/72 |
| half_way | 14 | 0 | 1 | 8 | 5 | 0 | 2.25 | 0.51 | 8/14 |
| nearly_correct | 25 | 0 | 0 | 0 | 25 | 0 | 2.99 | 0.78 | 25/25 |
| correct | 40 | 0 | 0 | 0 | 0 | 40 | 4.00 | 1.00 | 40/40 |

argmax level equals true bin: 231/240 (0.963); Spearman(E[level], true fraction) = 0.993; mean |E[level]/4 − true fraction| = 0.036

Variant `raw` (n=240):

| true bin | n | nothing_works | mostly_broken | half_way | nearly_correct | correct | mean E[level] | mean true fraction | argmax = bin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nothing_works | 89 | 89 | 0 | 0 | 0 | 0 | 0.01 | 0.00 | 89/89 |
| mostly_broken | 72 | 69 | 3 | 0 | 0 | 0 | 0.10 | 0.20 | 3/72 |
| half_way | 14 | 13 | 1 | 0 | 0 | 0 | 0.17 | 0.51 | 0/14 |
| nearly_correct | 25 | 18 | 1 | 0 | 6 | 0 | 1.13 | 0.78 | 6/25 |
| correct | 40 | 0 | 0 | 0 | 0 | 40 | 4.00 | 1.00 | 40/40 |

argmax level equals true bin: 138/240 (0.575); Spearman(E[level], true fraction) = 0.808; mean |E[level]/4 − true fraction| = 0.132

Variant `both` (n=240):

| true bin | n | nothing_works | mostly_broken | half_way | nearly_correct | correct | mean E[level] | mean true fraction | argmax = bin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nothing_works | 89 | 89 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 89/89 |
| mostly_broken | 72 | 2 | 64 | 6 | 0 | 0 | 0.97 | 0.20 | 64/72 |
| half_way | 14 | 0 | 1 | 12 | 1 | 0 | 2.00 | 0.51 | 12/14 |
| nearly_correct | 25 | 0 | 0 | 0 | 25 | 0 | 2.99 | 0.78 | 25/25 |
| correct | 40 | 0 | 0 | 0 | 0 | 40 | 4.00 | 1.00 | 40/40 |

argmax level equals true bin: 230/240 (0.958); Spearman(E[level], true fraction) = 0.985; mean |E[level]/4 − true fraction| = 0.032

### Part 2. Choice over the next move

n = 240; chosen matches the expected move: 234/240 (0.975); mean p on the expected move 0.97.

Confusion (rows: expected move for the case; columns: Jev's argmax):

| expected | n | keep_and_stop | keep_and_continue | revert_and_try_next_candidate | revert_and_relocalise | widen_search | none_of_these |
| --- | --- | --- | --- | --- | --- | --- | --- |
| keep_and_stop | 40 | 40 | 0 | 0 | 0 | 0 | 0 |
| keep_and_continue | 10 | 0 | 4 | 6 | 0 | 0 | 0 |
| revert_and_try_next_candidate | 63 | 0 | 0 | 63 | 0 | 0 | 0 |
| revert_and_relocalise | 62 | 0 | 0 | 0 | 62 | 0 | 0 |
| widen_search | 62 | 0 | 0 | 0 | 0 | 62 | 0 |
| partial_mixed (continue or try_next) | 3 | 0 | 1 | 2 | 0 | 0 | 0 |

By candidate kind:

| kind | n | correct | mean p(expected) |
| --- | --- | --- | --- |
| fix | 40 | 40/40 | 1.00 |
| partial | 10 | 4/10 | 0.43 |
| partial_mixed | 3 | 3/3 | 0.69 |
| regression | 76 | 76/76 | 1.00 |
| lateral | 6 | 6/6 | 0.98 |
| no_change | 105 | 105/105 | 1.00 |

Every miss:

| program | candidate | kind | before | after | search (remaining, untried lines) | expected | chosen | p(expected) | p(chosen) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | mutant_1_partial | partial | 0/9 | 2/9 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.28 | 0.70 |
| bucketsort | mutant_1_partial | partial | 1/7 | 2/7 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.17 | 0.81 |
| lcs_length | mutant_1_partial | partial | 1/9 | 2/9 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.19 | 0.79 |
| minimum_spanning_tree | mutant_1_partial | partial | 0/3 | 1/3 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.33 | 0.65 |
| sieve | mutant_1_partial | partial | 1/6 | 2/6 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.22 | 0.76 |
| sqrt | mutant_1_partial | partial | 1/7 | 2/7 | 3, 2 | keep_and_continue | revert_and_try_next_candidate | 0.19 | 0.80 |

Partial candidates, full distribution:

| program | candidate | before | after | keep_and_stop | keep_and_continue | revert_and_try_next_candidate | revert_and_relocalise | widen_search | none_of_these |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | mutant_1_partial | 0/9 | 2/9 | 0.00 | 0.28 | 0.70 | 0.01 | 0.00 | 0.01 |
| bucketsort | mutant_1_partial | 1/7 | 2/7 | 0.00 | 0.17 | 0.81 | 0.01 | 0.00 | 0.01 |
| find_in_sorted | mutant_1_partial_mixed | 5/7 | 6/7 | 0.00 | 0.27 | 0.71 | 0.01 | 0.00 | 0.01 |
| gcd | mutant_1_partial_mixed | 1/6 | 3/6 | 0.00 | 0.15 | 0.83 | 0.01 | 0.00 | 0.01 |
| get_factors | mutant_1_partial | 1/11 | 2/11 | 0.00 | 0.73 | 0.25 | 0.01 | 0.00 | 0.01 |
| kth | mutant_1_partial | 3/7 | 5/7 | 0.00 | 0.57 | 0.42 | 0.00 | 0.00 | 0.01 |
| lcs_length | mutant_1_partial | 1/9 | 2/9 | 0.00 | 0.19 | 0.79 | 0.01 | 0.00 | 0.01 |
| levenshtein | mutant_1_partial | 1/6 | 5/6 | 0.00 | 0.91 | 0.09 | 0.00 | 0.00 | 0.00 |
| mergesort | mutant_1_partial_mixed | 1/14 | 13/14 | 0.00 | 0.54 | 0.44 | 0.01 | 0.00 | 0.01 |
| minimum_spanning_tree | mutant_1_partial | 0/3 | 1/3 | 0.00 | 0.33 | 0.65 | 0.01 | 0.00 | 0.01 |
| pascal | mutant_1_partial | 1/5 | 2/5 | 0.00 | 0.74 | 0.26 | 0.00 | 0.00 | 0.00 |
| sieve | mutant_1_partial | 1/6 | 2/6 | 0.00 | 0.22 | 0.76 | 0.01 | 0.00 | 0.01 |
| sqrt | mutant_1_partial | 1/7 | 2/7 | 0.00 | 0.19 | 0.80 | 0.00 | 0.00 | 0.01 |

### Part 2b. Variant B: `after.newly_passing_tests` / `after.newly_failing_tests` computed by code, option descriptions name them

n = 240; chosen matches expected: 240/240 (1.000); mean p on the expected move 1.00; requests 279, cost $0.0207 (incl. the noise repeats), p50 225 ms.

| kind | n | variant A correct | variant A mean p(expected) | variant B correct | variant B mean p(expected) |
| --- | --- | --- | --- | --- | --- |
| fix | 40 | 40/40 | 1.00 | 40/40 | 1.00 |
| partial | 10 | 4/10 | 0.43 | 10/10 | 0.97 |
| partial_mixed | 3 | 3/3 | 0.69 | 3/3 | 0.95 |
| regression | 76 | 76/76 | 1.00 | 76/76 | 1.00 |
| lateral | 6 | 6/6 | 0.98 | 6/6 | 1.00 |
| no_change | 105 | 105/105 | 1.00 | 105/105 | 1.00 |

Partial candidates under variant B:

| program | candidate | before | after | newly passing / failing | p(keep_and_continue) | p(revert_and_try_next_candidate) |
| --- | --- | --- | --- | --- | --- | --- |
| bitcount | mutant_1_partial | 0/9 | 2/9 | 2 / 0 | 0.97 | 0.03 |
| bucketsort | mutant_1_partial | 1/7 | 2/7 | 1 / 0 | 0.93 | 0.07 |
| find_in_sorted | mutant_1_partial_mixed | 5/7 | 6/7 | 2 / 1 | 0.03 | 0.96 |
| gcd | mutant_1_partial_mixed | 1/6 | 3/6 | 3 / 1 | 0.02 | 0.97 |
| get_factors | mutant_1_partial | 1/11 | 2/11 | 1 / 0 | 0.99 | 0.01 |
| kth | mutant_1_partial | 3/7 | 5/7 | 2 / 0 | 0.99 | 0.01 |
| lcs_length | mutant_1_partial | 1/9 | 2/9 | 1 / 0 | 0.98 | 0.02 |
| levenshtein | mutant_1_partial | 1/6 | 5/6 | 4 / 0 | 0.99 | 0.01 |
| mergesort | mutant_1_partial_mixed | 1/14 | 13/14 | 13 / 1 | 0.07 | 0.92 |
| minimum_spanning_tree | mutant_1_partial | 0/3 | 1/3 | 1 / 0 | 0.98 | 0.02 |
| pascal | mutant_1_partial | 1/5 | 2/5 | 1 / 0 | 0.99 | 0.01 |
| sieve | mutant_1_partial | 1/6 | 2/6 | 1 / 0 | 0.96 | 0.04 |
| sqrt | mutant_1_partial | 1/7 | 2/7 | 1 / 0 | 0.93 | 0.07 |

Code-routed move (no Choice at all: the three Nouls of Part 1, variant `both`, thresholded at 0.5, then an if-chain over `search` in code):

| variant of the Nouls | n | routed move matches expected |
| --- | --- | --- |
| counts | 240 | 240/240 (1.000) |
| raw | 240 | 237/240 (0.988) |
| both | 240 | 240/240 (1.000) |

Noise: the 13 partial candidates asked 3 more times (state `both` + `edit` + `search`; Nouls and move variant A in one request). Spread = max − min over the 3 repeats.

| program | candidate | made_progress (3 repeats) | broke_something (3 repeats) | p(keep_and_continue) (3 repeats) | spread of p(keep_and_continue) |
| --- | --- | --- | --- | --- | --- |
| bitcount | mutant_1_partial | 0.96 / 0.96 / 0.96 | 0.10 / 0.10 / 0.10 | 0.23 / 0.30 / 0.29 | 0.07 |
| bucketsort | mutant_1_partial | 0.88 / 0.91 / 0.92 | 0.19 / 0.17 / 0.17 | 0.10 / 0.12 / 0.13 | 0.03 |
| find_in_sorted | mutant_1_partial_mixed | 0.97 / 0.97 / 0.97 | 0.89 / 0.95 / 0.90 | 0.26 / 0.28 / 0.26 | 0.02 |
| gcd | mutant_1_partial_mixed | 0.96 / 0.96 / 0.96 | 0.82 / 0.80 / 0.88 | 0.11 / 0.10 / 0.15 | 0.05 |
| get_factors | mutant_1_partial | 0.97 / 0.97 / 0.97 | 0.12 / 0.09 / 0.10 | 0.68 / 0.70 / 0.74 | 0.06 |
| kth | mutant_1_partial | 0.97 / 0.98 / 0.98 | 0.20 / 0.15 / 0.27 | 0.56 / 0.53 / 0.49 | 0.07 |
| lcs_length | mutant_1_partial | 0.94 / 0.92 / 0.94 | 0.18 / 0.15 / 0.29 | 0.18 / 0.16 / 0.15 | 0.03 |
| levenshtein | mutant_1_partial | 0.98 / 0.98 / 0.98 | 0.06 / 0.06 / 0.06 | 0.90 / 0.80 / 0.90 | 0.10 |
| mergesort | mutant_1_partial_mixed | 0.98 / 0.99 / 0.99 | 0.58 / 0.71 / 0.61 | 0.56 / 0.57 / 0.63 | 0.07 |
| minimum_spanning_tree | mutant_1_partial | 0.96 / 0.96 / 0.96 | 0.06 / 0.07 / 0.08 | 0.32 / 0.37 / 0.25 | 0.12 |
| pascal | mutant_1_partial | 0.96 / 0.96 / 0.96 | 0.11 / 0.10 / 0.11 | 0.70 / 0.75 / 0.74 | 0.05 |
| sieve | mutant_1_partial | 0.94 / 0.93 / 0.94 | 0.12 / 0.11 / 0.11 | 0.23 / 0.22 / 0.35 | 0.13 |
| sqrt | mutant_1_partial | 0.93 / 0.93 / 0.94 | 0.16 / 0.16 / 0.20 | 0.14 / 0.13 / 0.16 | 0.03 |

Mean spread of p(keep_and_continue) over repeats: 0.064; max 0.13. Noul spread: made_progress max 0.04, broke_something max 0.14.

### Part 3. Which failing test to attack first

n = 34 programs with ≥ 2 failing tests (up to 10 offered). 'Simplest' = shortest JSON serialisation of the input (ties broken by list order).

| question | top-1 = simplest | MRR of simplest | random top-1 baseline | mean p(argmax) | none_of_these mass |
| --- | --- | --- | --- | --- | --- |
| neutral | 16/34 (0.47) | 0.669 | 0.24 | 0.63 | 0.10 |
| explicit | 20/34 (0.59) | 0.762 | 0.24 | 0.78 | 0.02 |

Mean per-program Spearman(p, −input length) over programs with ≥ 3 failing tests and unequal lengths (n=29): neutral 0.32, explicit 0.62. *(Corrected 2026-09-20: the first version measured lengths with Python `json.dumps`, which inserts spaces, while the probe used `JSON.stringify`; the two disagree on 24/34 programs. Values here use the probe's lengths.)*

Counting ties as hits (argmax input length equals the minimum length): neutral 17/34 (0.50), explicit 25/34 (0.74) *(corrected from 26/34, same length-measure issue)*. Programs where every input has the same length: 3. The matching random baseline when ties count as hits is 0.39 (13/34), not 0.24: `hanoi` and `pascal` have all-equal lengths and `wrap` has 4 of 5 equal, so a random pick is a tie-hit there.

| program | failing offered | input lengths (chars) | neutral choice | rank of simplest (neutral) | explicit choice | rank of simplest (explicit) |
| --- | --- | --- | --- | --- | --- | --- |
| bitcount | 9 | 5,5,6,4,4,4,5,5,5 | failing_test_0 (0.41) | 2 | failing_test_3 (0.81) | 1 |
| bucketsort | 6 | 19,17,26,36,36,28 | failing_test_1 (0.57) | 4 | failing_test_2 (0.91) | 1 |
| find_first_in_sorted | 3 | 19,19,27 | failing_test_1 (0.86) | 1 | failing_test_2 (0.67) | 2 |
| find_in_sorted | 2 | 19,22 | failing_test_1 (0.91) | 1 | failing_test_1 (0.69) | 1 |
| flatten | 6 | 24,22,15,9,25,31 | failing_test_0 (0.51) | 2 | failing_test_4 (0.77) | 1 |
| gcd | 5 | 7,8,8,16,6 | failing_test_1 (0.77) | 3 | failing_test_1 (0.54) | 2 |
| get_factors | 10 | 5,5,5,3,3,4,4,4,4,6 | failing_test_2 (0.32) | 3 | failing_test_4 (0.97) | 1 |
| hanoi | 7 | 7,7,7,7,7,7,7 | failing_test_1 (0.84) | 1 | failing_test_1 (0.99) | 1 |
| kheapsort | 3 | 15,15,16 | failing_test_1 (0.78) | 1 | failing_test_1 (0.90) | 1 |
| knapsack | 6 | 37,43,57,54,67,87 | failing_test_1 (0.74) | 1 | failing_test_1 (0.94) | 1 |
| kth | 4 | 19,21,24,24 | failing_test_0 (0.76) | 1 | failing_test_0 (0.92) | 1 |
| lcs_length | 8 | 20,20,18,18,21,22,19,27 | failing_test_5 (0.62) | 6 | failing_test_0 (0.28) | 2 |
| levenshtein | 5 | 22,20,31,21,17 | failing_test_2 (0.58) | 4 | failing_test_6 (0.88) | 1 |
| lis | 4 | 17,29,18,18 | failing_test_10 (0.64) | 2 | failing_test_11 (0.41) | 3 |
| longest_common_subsequence | 4 | 35,20,19,20 | failing_test_6 (0.35) | 1 | failing_test_6 (0.71) | 1 |
| max_sublist_sum | 4 | 17,20,27,25 | failing_test_5 (0.52) | 2 | failing_test_0 (0.92) | 1 |
| mergesort | 10 | 19,35,13,13,48,45,69,39,17,13 | failing_test_1 (0.65) | 2 | failing_test_10 (0.45) | 2 |
| minimum_spanning_tree | 3 | 28,40,38 | failing_test_0 (0.86) | 1 | failing_test_0 (0.98) | 1 |
| next_permutation | 8 | 11,13,11,13,13,13,14,9 | failing_test_6 (0.40) | 4 | failing_test_7 (0.93) | 1 |
| pascal | 4 | 3,3,3,3 | failing_test_1 (0.53) | 1 | failing_test_1 (1.00) | 1 |
| possible_change | 9 | 16,16,16,13,17,20,24,19,17 | failing_test_1 (0.86) | 6 | failing_test_1 (0.92) | 2 |
| powerset | 4 | 15,11,7,20 | failing_test_2 (0.83) | 1 | failing_test_2 (1.00) | 1 |
| reverse_linked_list | 2 | 27,27 | failing_test_1 (0.53) | 2 | failing_test_1 (1.00) | 2 |
| rpn_eval | 3 | 17,17,29 | failing_test_0 (0.58) | 1 | failing_test_0 (0.72) | 1 |
| shortest_path_length | 2 | 18,23 | failing_test_0 (0.88) | 1 | failing_test_0 (0.99) | 1 |
| shortest_path_lengths | 4 | 28,29,36,41 | failing_test_0 (0.49) | 1 | failing_test_2 (0.49) | 4 |
| shortest_paths | 3 | 35,29,26 | failing_test_0 (0.46) | 3 | failing_test_1 (0.95) | 3 |
| shunting_yard | 4 | 18,19,31,31 | failing_test_2 (0.86) | 1 | failing_test_2 (0.99) | 1 |
| sieve | 5 | 3,3,3,4,4 | failing_test_1 (0.96) | 1 | failing_test_1 (1.00) | 1 |
| sqrt | 6 | 8,7,7,9,9,10 | failing_test_0 (0.63) | 3 | failing_test_3 (0.48) | 2 |
| subsequences | 10 | 7,8,8,8,8,8,8,8,8,7 | failing_test_10 (0.24) | 2 | failing_test_11 (0.38) | 4 |
| to_base | 7 | 7,6,6,7,7,9,9 | failing_test_3 (0.54) | 3 | failing_test_6 (0.58) | 4 |
| topological_ordering | 3 | 25,30,40 | failing_test_0 (0.43) | 1 | failing_test_1 (0.83) | 2 |
| wrap | 5 | 952,952,952,952,953 | none_of_these (0.38) | 2 | none_of_these (0.47) | 2 |


## What this means for the design

1. **Jev reads code-computed numbers perfectly; it should never be asked to derive them from
   lists.** With `passed/failed/total` **and the failure texts** in the state (`both`), all three
   progress Nouls are 100 % accurate on 240 items (Brier <= 0.008, AUROC 1.0); with counts alone,
   `program_correct` and `made_progress` are 240/240 but `broke_something` is 236/240 (Brier
   0.014), because the 4 misses (2 lateral, 2 partial_mixed) are undecidable from counts: the pass
   count did not drop, so the list is needed to see that the set changed. The 5-level Score
   matches the true pass-fraction bin 231/240 with Spearman 0.99 (counts). With only raw failure lists (no counts), `made_progress` hedges
   at 0.40-0.46 on every "1 more test passes" partial and `broke_something` misses 14/76
   regressions of the form "1/N -> 0/N" (the one previously passing test is now in a list of N
   failures; finding it is a set difference over 6-14 items, i.e. counting), and the Score
   collapses to `nothing_works` because the fraction is not in the state. The REPORT rule "never
   ask it to count" applies to list comparisons too. The progress stage must pass `passed`,
   `failed`, `total`, `newly_passing`, `newly_failing` as numbers, plus the failure texts for the
   qualitative questions.
2. **`is the program correct` is a solved question, but it is also redundant.** 40/40 positives
   and 200/200 negatives at p >= 0.90 / <= 0.05 in every variant. The loop should still read
   `after.failed == 0` in code (tests are the oracle, JEV-ONLY.md non-negotiable 2); the Noul is
   useful only as a consistency check on the summariser.
3. **Do not ask Jev to pick the next move as a free Choice over policy options when the policy
   is a function of numbers.** Variant A got 234/240 but was wrong on 6/10 clean partials: with
   1/7 -> 2/7 it put 0.65-0.81 on `revert_and_try_next_candidate` (reading "one more test" as
   "did not help"), and the noise repeat shows this is stable (p(keep_and_continue) spread <= 0.13
   over 3 repeats), so it is a judgment, not noise. Two fixes both reach 240/240: (a) put the
   deltas in the state and name them in the option descriptions (variant B, mean p on the expected
   move 1.00, partials 0.93-0.99); (b) skip the Choice and route in code from the three Nouls
   (`counts` or `both` variant, threshold 0.5) plus the search counters. (b) is one request
   cheaper and has no policy text to drift; the recommended loop is: code computes the run
   summary and deltas -> one request with the three Nouls + the Score -> code routes. Note the
   honest corollary (verification, 2026-09-20): when the two runs cover the same test set, all
   three Nouls are themselves pure functions of code-computed numbers (`after.failed == 0`,
   `after.passed > before.passed`, `newly_failing > 0`), so this probe shows Jev *reads* such
   numbers reliably, not that Jev adds information over code here. Jev earns its place in the
   progress stage only where the summary is not code-computable (different test sets between
   runs, flaky tests, judging error texts or partial-output closeness). Keep the
   Choice only for genuinely qualitative branches (which candidate source next, which failing test
   first), never for "compare these two numbers".
4. **Partial-but-broke edits are a policy decision the design has to make, not Jev.** The 3
   `partial_mixed` cases (more tests pass, one that passed now fails) went `keep_and_continue`
   under variant A wording (1/3) and `revert` under variant B wording (3/3) at 0.92-0.97: Jev
   follows whichever definition the option text gives. Write the rule down in code (suggested:
   revert unless the newly failing test is the one being attacked), and encode it once.
5. **"Which failing test to attack first" is a real preference, not a length heuristic.** Asked
   neutrally, Jev picks the shortest input 16/34 strict / 17/34 counting ties (random baseline 0.24
   strict = 8/34, 0.39 when ties count = 13/34; MRR 0.67; per-program Spearman with -length 0.32);
   asked explicitly for the simplest input, 20/34 strict / 25/34 with ties (MRR 0.76, Spearman
   0.62). The like-for-like lift over chance is therefore 2.0x strict (16 vs 8) but only 1.3x
   tie-aware (17 vs 13), so "2x chance" holds for the strict comparison only; on 34 programs the
   neutral preference is real but modest. Its neutral picks tend to be the smallest *informative* case (e.g. `bucketsort`: not the
   shortest list but the one whose actual output shows the failure pattern; `lcs_length`: the
   pair whose actual is `0` against expected `2`). Use the neutral wording for ordering the work
   queue and add a code tiebreak on input size; do not expect the escape option to fire (mass on
   `none_of_these` 0.10 neutral, 0.02 explicit; the only argmax escape was `wrap`, whose 5 inputs
   are 950-char strings, a case where "attack first" has no good answer).
6. **Score is a usable progress meter when `total` is present**: E[level]/4 tracks the true
   fraction with mean absolute error 0.03-0.04 (counts / both) and every confusion is between adjacent
   levels. They are not all at one boundary: under `counts`, 5 of 9 are `half_way` judged
   `nearly_correct` at true fractions 0.57-0.60 (4/7, 3/5), 3 are (0,0.4) vs [0.4,0.6] at 0.33,
   and 1 is a 0.40 partial judged `mostly_broken`; under `both`, 2 of 10 are `mostly_broken`
   (0.08, 0.14) judged `nothing_works`. All sit where the level wording ("roughly as many",
   "most", "a small minority") is genuinely fuzzy. It can drive a search
   heuristic (beam ordering by expected closeness) at zero marginal cost since it batches with
   the Nouls. It is a worse instrument than `passed/total` itself, so use it only where the
   fraction is not computable (e.g. comparing runs with different test sets).
7. **Cost and latency fit the inner loop**: 4 questions on one after-run cost ~$0.00007 and one
   round trip (~190 ms p50 at 8-way concurrency). A 200-iteration repair search would spend under
   $0.02 and under a minute on progress judgment; the test runs dominate.

Caveats: ground truth for `progress`/`broke` is derived from 2 s-timeout runs, and one `levenshtein`
test near the timeout boundary was excluded rather than risk flapping; the graph programs run each
test function in a fresh process (QuixBugs' `detect_cycle` tests share mutable nodes across
functions, so their semantics differ slightly in isolation, but the fix passes and the original
fails identically to the upstream runner). Only 13 partial candidates exist, so the "small
progress" finding rests on 10 clean + 3 mixed items (each re-asked 3 times). Part 3's "simplest"
ground truth is a proxy (serialised input length), which is why the explicit question is also
reported. Part 2's `search` counters (`candidates_remaining_for_this_line`,
`untried_suspicious_lines`) are synthetic, assigned in rotation, not from a real search trace, and
every correct/partial candidate got the same `(3, 2)` context. Part 3's options are keyed
`failing_test_<id>` with null descriptions and the content only in the state, the weakest key form
in REPORT §11 (semantic keys + null descriptions leaked 0.08 to a lookalike there); ids such as
`failing_test_1` / `failing_test_10` / `failing_test_11` coexist in `lis`, `mergesort` and
`subsequences`. The Part 2 "mean p(expected)" for `partial_mixed` (0.69 under A, 0.95 under B) is
the max over the two accepted options and is therefore inflated relative to the other rows. The
"smoke run" (25 requests, $0.0017) in the cost total left no saved output and is unverifiable;
the main and follow-up costs are read from `results.json` / `results2.json` meta.

## Verification (2026-09-20)

Adversarial check by a second agent. Method: read every script under `experiments/progress/`,
recomputed every table from the saved raw output (`results.json`, `results2.json`,
`candidates.json`) with an independent script, re-ran the test runner on 3 programs, and re-asked
Jev live on a 6-program sample (`verify_rerun.mts`, output `verify_rerun.json`, not overwriting the
author's files). Spend for the verification: 150 requests, **$0.0123**, Jev p50 198 ms.

**Verdict: corrected.** The numbers are reproducible and the scripts do what the tables say; four
statements in the prose overreached or were computed inconsistently and are fixed above (marked
*corrected* inline or rewritten in "What this means for the design" points 1, 3, 5, 6).

| check | result |
| --- | --- |
| n | 40 programs x 6 candidates = 240 items; 720 Noul rows (240 per variant), 240 move rows, 34 attack rows, 240 variant-B rows, 39 repeat rows (13 partials x 3): all match the file |
| Ground-truth labels | recomputed `correct` / `progress` / `broke` / `kind` / `newly_passing` / `newly_failing` from the stored per-test statuses for all 240 candidates: 0 mismatches; fix passes all included tests and buggy original fails >= 1 on all 40; `buggy_noop` after-run equals before-run on all 40; excluded tests are exactly `knapsack` [9] and `levenshtein` [3] |
| Runner reproducibility | `run_tests.py` re-run on `gcd`, `detect_cycle`, `sqrt` (buggy and fix): pass counts and per-test statuses identical to `candidates.json` |
| Part 1 | independently recomputed acc@0.5, Brier, AUROC, positives for all 9 (Noul, variant) cells: identical to the table (program_correct 240/240 x3; made_progress 240/237/240; broke_something 236/225/240) |
| Part 2 / 2b / code routing | 234/240 (A), 240/240 (B), routed 240/237/240: identical; the 3 raw-routing misses are the same 3 partials as the raw `made_progress` misses |
| Part 3 | top-1 16/34 and 20/34, MRR 0.669 / 0.762, escape mass 0.10 / 0.02, strict random baseline 0.24: identical. **Corrected**: tie-aware hits and Spearman were computed with Python `json.dumps` lengths (spaces) rather than the probe's `JSON.stringify` lengths (24/34 programs differ) -> explicit ties-as-hits 26 -> 25, Spearman 0.64 -> 0.62, neutral 0.31 -> 0.32; `analyze.py` fixed and `tables.md` regenerated. **Corrected**: the "2x chance" claim compared tie-inclusive hits with a strict baseline; the tie-aware baseline is 0.39 |
| Part 4 | argmax = bin 231/230/138, MAE 0.036/0.032/0.132: identical. **Corrected**: design point 6 said the only confusions are at the (0,0.4]/[0.4,0.6] boundary; in fact 5/9 (counts) are half_way -> nearly_correct at 0.57-0.60 and 2/10 (both) are mostly_broken -> nothing_works. All confusions are between adjacent levels |
| Cost | main $0.0668 (994 req) and follow-up $0.0207 (279 req) read from the saved meta; the smoke run ($0.0017, 25 req) has no artefact: **unverifiable**, total $0.089 taken on trust for that $0.0017 |
| Latency | p50 190 ms / p95 319 ms (main), 225 ms (follow-up) from saved meta; verification re-run p50 198 ms at 8-way concurrency: consistent |
| Live re-run (6 programs: bitcount, bucketsort, sqrt, gcd, mergesort, hanoi, chosen to include the hard partials) | 324 Noul answers: mean abs diff vs saved 0.006, max 0.17, one 0.5-threshold flip; 311/324 correct at 0.5 vs 310/324 in the saved run for the same items; Score argmax agrees 107/108; next-move argmax agrees 36/36 (33/36 correct, the same 3 partial misses); attack-first picks agree 6/6 neutral and 6/6 explicit. The reported effects are stable, not sampling noise |
| Question form (REPORT rules) | Nouls built with `noul()` (definition + >= 2 examples on both sides), Choices with `choice()` (escape `none_of_these` added automatically, snake_case keys, no name-prior keys), Score levels described as situations, targets referenced with backticked paths. The `made_progress` Noul does ask Jev to compare two numbers, which REPORT §14 says to do in code; the author acknowledges this and the design recommends code routing. Part 3 keys are index-like with null descriptions (weakest form in REPORT §11): noted in caveats |
| Literature | the file cites no external literature (only the internal `jev-research/REPORT.md` rule "do arithmetic, counting ... in code", confirmed in REPORT §14). Nothing to re-fetch. REPORT §10 also reports that counting list items up to 20 was perfect, so "list comparison behaves like counting" is the author's interpretation of the raw-variant misses, not a measured mechanism |
| Overreach | the strongest framing ("Jev steers a repair search essentially perfectly when code hands it the numbers") is true as measured but, with identical test sets, every quantity asked for is itself code-computable; added to design point 3. Design point 1's "100 % with counts" applied only to the `both` variant; corrected |

Files added by the verification: `experiments/progress/verify_rerun.mts`, `experiments/progress/verify_rerun.json`.
Files edited: this file, `experiments/progress/analyze.py` (length measure, tie-aware baseline, `no_change` wording), `experiments/progress/tables.md` (regenerated).
