# JevCode bench 20260920-232705-faa8ea

Generated 2026-09-20T23:42:29.548Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 8m | $0.0500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0500; spent generator $0.0000 + Jev $0.1343 = $0.1343. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 40 | 40 | 38 | 38/40 (n=40) 95.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| argument_swap | 5 | 5/5 100.0% |
| control_flow | 1 | 1/1 100.0% |
| missing_condition | 5 | 5/5 100.0% |
| off_by_one | 8 | 8/8 100.0% |
| operator | 2 | 2/2 100.0% |
| other | 9 | 9/9 100.0% |
| wrong_call | 3 | 3/3 100.0% |
| wrong_variable | 7 | 5/7 71.4% |

### Paired comparison (n = 40 tasks evaluated in every condition)

Paired tasks: `bitcount`, `breadth_first_search`, `bucketsort`, `depth_first_search`, `detect_cycle`, `find_first_in_sorted`, `find_in_sorted`, `flatten`, `gcd`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `kheapsort`, `knapsack`, `kth`, `lcs_length`, `levenshtein`, `lis`, `longest_common_subsequence`, `max_sublist_sum`, `mergesort`, `minimum_spanning_tree`, `next_palindrome`, `next_permutation`, `pascal`, `possible_change`, `powerset`, `quicksort`, `reverse_linked_list`, `rpn_eval`, `shortest_path_length`, `shortest_path_lengths`, `shortest_paths`, `shunting_yard`, `sieve`, `sqrt`, `subsequences`, `to_base`, `topological_ordering`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 38/40 (n=40) 95.0% |
| steps-to-solve mean (n passed) | 4.63 (n=38) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 5 (n=40) |
| steps used median | 4 |
| read actions total / mean per run | 50 / 1.25 |
| blocked / reviews / declined | 19 / 16 / 16 |
| loops / replans | 13 / 12 |
| Jev requests / questions | 1119 / 10207 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 189.69 / 330.34 (n=1119) |
| mean generator tokens/step (steps) | 0 (n=200) |
| mean Jev tokens/step (steps) | 17697 (n=200) |
| mean tokens/step, generator+Jev (steps) | 17697 (n=200) |
| wall time mean | 1m27s |
| cost generator / Jev / total | $0.0000 / $0.1343 / $0.1343 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 0/40 | 0.0% |  |
| 4 | 31/40 | 77.5% | ████████████████ |
| 5 | 33/40 | 82.5% | █████████████████ |
| 6 | 33/40 | 82.5% | █████████████████ |
| 7 | 35/40 | 87.5% | ██████████████████ |
| 8 | 37/40 | 92.5% | ███████████████████ |
| 9 | 37/40 | 92.5% | ███████████████████ |
| 10 | 37/40 | 92.5% | ███████████████████ |
| 11 | 37/40 | 92.5% | ███████████████████ |
| 12 | 38/40 | 95.0% | ███████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=40) |  |
| 5 | 0 (n=9) |  |
| 6 | 0 (n=7) |  |
| 7 | 0 (n=7) |  |
| 8 | 0 (n=5) |  |
| 9 | 0 (n=3) |  |
| 10 | 0 (n=3) |  |
| 11 | 0 (n=3) |  |
| 12 | 0 (n=3) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8530 (n=40) | ██ |
| 2 | 9019 (n=40) | ██ |
| 3 | 16694 (n=40) | ███ |
| 4 | 18143 (n=40) | ████ |
| 5 | 13391 (n=9) | ███ |
| 6 | 50708 (n=7) | ██████████ |
| 7 | 34721 (n=7) | ███████ |
| 8 | 65108 (n=5) | █████████████ |
| 9 | 8573 (n=3) | ██ |
| 10 | 102035 (n=3) | ████████████████████ |
| 11 | 10034 (n=3) | ██ |
| 12 | 12650 (n=3) | ██ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8530 (n=40) | ██ |
| 2 | 9019 (n=40) | ██ |
| 3 | 16694 (n=40) | ███ |
| 4 | 18143 (n=40) | ████ |
| 5 | 13391 (n=9) | ███ |
| 6 | 50708 (n=7) | ██████████ |
| 7 | 34721 (n=7) | ███████ |
| 8 | 65108 (n=5) | █████████████ |
| 9 | 8573 (n=3) | ██ |
| 10 | 102035 (n=3) | ████████████████████ |
| 11 | 10034 (n=3) | ██ |
| 12 | 12650 (n=3) | ██ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 38 | ████████████████████ |
| max_steps | 2 | █ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | pass | 7 | 2 | $0.0050 |
| breadth_first_search | pass | 4 | 1 | $0.0019 |
| bucketsort | pass | 4 | 1 | $0.0020 |
| depth_first_search | pass | 4 | 1 | $0.0018 |
| detect_cycle | pass | 4 | 1 | $0.0019 |
| find_first_in_sorted | pass | 4 | 1 | $0.0021 |
| find_in_sorted | pass | 4 | 1 | $0.0019 |
| flatten | pass | 4 | 1 | $0.0018 |
| gcd | pass | 4 | 1 | $0.0017 |
| get_factors | pass | 4 | 1 | $0.0018 |
| hanoi | pass | 5 | 2 | $0.0023 |
| is_valid_parenthesization | pass | 4 | 1 | $0.0018 |
| kheapsort | pass | 4 | 1 | $0.0019 |
| knapsack | pass | 4 | 1 | $0.0021 |
| kth | pass | 4 | 1 | $0.0019 |
| lcs_length | pass | 4 | 1 | $0.0018 |
| levenshtein | pass | 4 | 1 | $0.0025 |
| lis | pass | 8 | 1 | $0.0039 |
| longest_common_subsequence | fail | 12 | 3 | $0.0241 |
| max_sublist_sum | pass | 4 | 1 | $0.0019 |
| mergesort | pass | 12 | 2 | $0.0109 |
| minimum_spanning_tree | pass | 4 | 1 | $0.0018 |
| next_palindrome | pass | 4 | 1 | $0.0020 |
| next_permutation | pass | 4 | 1 | $0.0020 |
| pascal | pass | 4 | 1 | $0.0018 |
| possible_change | pass | 4 | 1 | $0.0019 |
| powerset | pass | 4 | 1 | $0.0018 |
| quicksort | pass | 4 | 1 | $0.0019 |
| reverse_linked_list | pass | 8 | 3 | $0.0074 |
| rpn_eval | pass | 4 | 1 | $0.0020 |
| shortest_path_length | fail | 12 | 2 | $0.0147 |
| shortest_path_lengths | pass | 4 | 1 | $0.0019 |
| shortest_paths | pass | 4 | 1 | $0.0019 |
| shunting_yard | pass | 4 | 1 | $0.0021 |
| sieve | pass | 4 | 1 | $0.0017 |
| sqrt | pass | 4 | 1 | $0.0024 |
| subsequences | pass | 4 | 1 | $0.0019 |
| to_base | pass | 4 | 1 | $0.0018 |
| topological_ordering | pass | 7 | 2 | $0.0040 |
| wrap | pass | 5 | 2 | $0.0023 |

