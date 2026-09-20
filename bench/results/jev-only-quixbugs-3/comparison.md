# JevCode bench 20260920-205918-3f1604

Generated 2026-09-20T21:11:07.370Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.1654 = $0.1654. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 40 | 40 | 36 | 36/40 (n=40) 90.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| argument_swap | 5 | 5/5 100.0% |
| control_flow | 1 | 1/1 100.0% |
| missing_condition | 5 | 5/5 100.0% |
| off_by_one | 8 | 8/8 100.0% |
| operator | 2 | 2/2 100.0% |
| other | 9 | 6/9 66.7% |
| wrong_call | 3 | 3/3 100.0% |
| wrong_variable | 7 | 6/7 85.7% |

### Paired comparison (n = 40 tasks evaluated in every condition)

Paired tasks: `bitcount`, `breadth_first_search`, `bucketsort`, `depth_first_search`, `detect_cycle`, `find_first_in_sorted`, `find_in_sorted`, `flatten`, `gcd`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `kheapsort`, `knapsack`, `kth`, `lcs_length`, `levenshtein`, `lis`, `longest_common_subsequence`, `max_sublist_sum`, `mergesort`, `minimum_spanning_tree`, `next_palindrome`, `next_permutation`, `pascal`, `possible_change`, `powerset`, `quicksort`, `reverse_linked_list`, `rpn_eval`, `shortest_path_length`, `shortest_path_lengths`, `shortest_paths`, `shunting_yard`, `sieve`, `sqrt`, `subsequences`, `to_base`, `topological_ordering`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 36/40 (n=40) 90.0% |
| steps-to-solve mean (n passed) | 4.22 (n=36) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 5 (n=40) |
| steps used median | 4 |
| read actions total / mean per run | 70 / 1.75 |
| blocked / reviews / declined | 42 / 16 / 16 |
| loops / replans | 12 / 11 |
| Jev requests / questions | 1309 / 16842 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 193.27 / 325.15 (n=1309) |
| mean generator tokens/step (steps) | 0 (n=200) |
| mean Jev tokens/step (steps) | 22358 (n=200) |
| mean tokens/step, generator+Jev (steps) | 22358 (n=200) |
| wall time mean | 1m4s |
| cost generator / Jev / total | $0.0000 / $0.1654 / $0.1654 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 14/40 | 35.0% | ███████ |
| 4 | 31/40 | 77.5% | ████████████████ |
| 5 | 32/40 | 80.0% | ████████████████ |
| 6 | 33/40 | 82.5% | █████████████████ |
| 7 | 33/40 | 82.5% | █████████████████ |
| 8 | 33/40 | 82.5% | █████████████████ |
| 9 | 34/40 | 85.0% | █████████████████ |
| 10 | 35/40 | 87.5% | ██████████████████ |
| 11 | 35/40 | 87.5% | ██████████████████ |
| 12 | 36/40 | 90.0% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=26) |  |
| 5 | 0 (n=9) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=7) |  |
| 8 | 0 (n=7) |  |
| 9 | 0 (n=7) |  |
| 10 | 0 (n=6) |  |
| 11 | 0 (n=5) |  |
| 12 | 0 (n=5) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6953 (n=40) | ███ |
| 2 | 11129 (n=40) | ████ |
| 3 | 42809 (n=40) | █████████████████ |
| 4 | 25634 (n=26) | ██████████ |
| 5 | 24995 (n=9) | ██████████ |
| 6 | 40442 (n=8) | ████████████████ |
| 7 | 10962 (n=7) | ████ |
| 8 | 26526 (n=7) | ███████████ |
| 9 | 49986 (n=7) | ████████████████████ |
| 10 | 9071 (n=6) | ████ |
| 11 | 10364 (n=5) | ████ |
| 12 | 20493 (n=5) | ████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6953 (n=40) | ███ |
| 2 | 11129 (n=40) | ████ |
| 3 | 42809 (n=40) | █████████████████ |
| 4 | 25634 (n=26) | ██████████ |
| 5 | 24995 (n=9) | ██████████ |
| 6 | 40442 (n=8) | ████████████████ |
| 7 | 10962 (n=7) | ████ |
| 8 | 26526 (n=7) | ███████████ |
| 9 | 49986 (n=7) | ████████████████████ |
| 10 | 9071 (n=6) | ████ |
| 11 | 10364 (n=5) | ████ |
| 12 | 20493 (n=5) | ████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 35 | ████████████████████ |
| max_steps | 5 | ███ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | pass | 4 | 2 | $0.0025 |
| breadth_first_search | pass | 4 | 2 | $0.0018 |
| bucketsort | pass | 3 | 1 | $0.0013 |
| depth_first_search | fail | 12 | 4 | $0.0131 |
| detect_cycle | pass | 4 | 2 | $0.0016 |
| find_first_in_sorted | pass | 3 | 1 | $0.0015 |
| find_in_sorted | pass | 3 | 1 | $0.0013 |
| flatten | pass | 3 | 1 | $0.0012 |
| gcd | pass | 4 | 2 | $0.0015 |
| get_factors | pass | 3 | 1 | $0.0012 |
| hanoi | pass | 4 | 2 | $0.0017 |
| is_valid_parenthesization | pass | 4 | 2 | $0.0017 |
| kheapsort | pass | 4 | 1 | $0.0018 |
| knapsack | pass | 5 | 2 | $0.0024 |
| kth | pass | 3 | 1 | $0.0013 |
| lcs_length | pass | 3 | 1 | $0.0013 |
| levenshtein | pass | 3 | 1 | $0.0019 |
| lis | pass | 4 | 2 | $0.0044 |
| longest_common_subsequence | fail | 12 | 4 | $0.0184 |
| max_sublist_sum | pass | 3 | 1 | $0.0013 |
| mergesort | pass | 12 | 2 | $0.0137 |
| minimum_spanning_tree | pass | 4 | 1 | $0.0018 |
| next_palindrome | pass | 3 | 1 | $0.0014 |
| next_permutation | pass | 3 | 1 | $0.0014 |
| pascal | pass | 4 | 2 | $0.0017 |
| possible_change | pass | 4 | 2 | $0.0017 |
| powerset | pass | 4 | 2 | $0.0016 |
| quicksort | pass | 4 | 2 | $0.0017 |
| reverse_linked_list | fail | 12 | 3 | $0.0168 |
| rpn_eval | pass | 3 | 1 | $0.0014 |
| shortest_path_length | pass | 10 | 2 | $0.0196 |
| shortest_path_lengths | pass | 4 | 2 | $0.0018 |
| shortest_paths | pass | 4 | 2 | $0.0017 |
| shunting_yard | fail | 12 | 2 | $0.0215 |
| sieve | pass | 3 | 1 | $0.0012 |
| sqrt | pass | 4 | 2 | $0.0015 |
| subsequences | pass | 3 | 1 | $0.0013 |
| to_base | pass | 4 | 2 | $0.0016 |
| topological_ordering | pass | 9 | 3 | $0.0050 |
| wrap | pass | 6 | 2 | $0.0036 |

