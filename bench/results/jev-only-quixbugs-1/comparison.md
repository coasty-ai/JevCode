# JevCode bench 20260920-193226-14e853

Generated 2026-09-20T19:43:19.572Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.1906 = $0.1906. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 40 | 40 | 34 | 34/40 (n=40) 85.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| argument_swap | 5 | 5/5 100.0% |
| control_flow | 1 | 1/1 100.0% |
| missing_condition | 5 | 5/5 100.0% |
| off_by_one | 8 | 7/8 87.5% |
| operator | 2 | 1/2 50.0% |
| other | 9 | 6/9 66.7% |
| wrong_call | 3 | 3/3 100.0% |
| wrong_variable | 7 | 6/7 85.7% |

### Paired comparison (n = 40 tasks evaluated in every condition)

Paired tasks: `bitcount`, `breadth_first_search`, `bucketsort`, `depth_first_search`, `detect_cycle`, `find_first_in_sorted`, `find_in_sorted`, `flatten`, `gcd`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `kheapsort`, `knapsack`, `kth`, `lcs_length`, `levenshtein`, `lis`, `longest_common_subsequence`, `max_sublist_sum`, `mergesort`, `minimum_spanning_tree`, `next_palindrome`, `next_permutation`, `pascal`, `possible_change`, `powerset`, `quicksort`, `reverse_linked_list`, `rpn_eval`, `shortest_path_length`, `shortest_path_lengths`, `shortest_paths`, `shunting_yard`, `sieve`, `sqrt`, `subsequences`, `to_base`, `topological_ordering`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 34/40 (n=40) 85.0% |
| steps-to-solve mean (n passed) | 6.18 (n=34) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 7.03 (n=40) |
| steps used median | 4 |
| read actions total / mean per run | 100 / 2.50 |
| blocked / reviews / declined | 111 / 47 / 47 |
| loops / replans | 32 / 29 |
| Jev requests / questions | 1559 / 22762 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 184.59 / 344.99 (n=1559) |
| mean generator tokens/step (steps) | 0 (n=281) |
| mean Jev tokens/step (steps) | 17954 (n=281) |
| mean tokens/step, generator+Jev (steps) | 17954 (n=281) |
| wall time mean | 56s |
| cost generator / Jev / total | $0.0000 / $0.1906 / $0.1906 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 16/40 | 40.0% | ████████ |
| 4 | 22/40 | 55.0% | ███████████ |
| 5 | 22/40 | 55.0% | ███████████ |
| 6 | 23/40 | 57.5% | ████████████ |
| 7 | 23/40 | 57.5% | ████████████ |
| 8 | 23/40 | 57.5% | ████████████ |
| 9 | 23/40 | 57.5% | ████████████ |
| 10 | 23/40 | 57.5% | ████████████ |
| 11 | 23/40 | 57.5% | ████████████ |
| 12 | 34/40 | 85.0% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=24) |  |
| 5 | 0 (n=18) |  |
| 6 | 0 (n=18) |  |
| 7 | 0 (n=17) |  |
| 8 | 0 (n=17) |  |
| 9 | 0 (n=17) |  |
| 10 | 0 (n=17) |  |
| 11 | 0 (n=17) |  |
| 12 | 0 (n=16) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7019 (n=40) | ████ |
| 2 | 16165 (n=40) | █████████ |
| 3 | 20428 (n=40) | ███████████ |
| 4 | 16884 (n=24) | █████████ |
| 5 | 15908 (n=18) | ████████ |
| 6 | 13813 (n=18) | ███████ |
| 7 | 31144 (n=17) | █████████████████ |
| 8 | 21419 (n=17) | ███████████ |
| 9 | 37735 (n=17) | ████████████████████ |
| 10 | 9348 (n=17) | █████ |
| 11 | 20535 (n=17) | ███████████ |
| 12 | 19832 (n=16) | ███████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7019 (n=40) | ████ |
| 2 | 16165 (n=40) | █████████ |
| 3 | 20428 (n=40) | ███████████ |
| 4 | 16884 (n=24) | █████████ |
| 5 | 15908 (n=18) | ████████ |
| 6 | 13813 (n=18) | ███████ |
| 7 | 31144 (n=17) | █████████████████ |
| 8 | 21419 (n=17) | ███████████ |
| 9 | 37735 (n=17) | ████████████████████ |
| 10 | 9348 (n=17) | █████ |
| 11 | 20535 (n=17) | ███████████ |
| 12 | 19832 (n=16) | ███████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 23 | ████████████████████ |
| max_steps | 16 | ██████████████ |
| replan_stop | 1 | █ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | fail | 11 | 4 | $0.0051 |
| breadth_first_search | pass | 4 | 2 | $0.0017 |
| bucketsort | pass | 3 | 1 | $0.0011 |
| depth_first_search | pass | 12 | 3 | $0.0043 |
| detect_cycle | pass | 12 | 5 | $0.0045 |
| find_first_in_sorted | pass | 3 | 1 | $0.0017 |
| find_in_sorted | pass | 3 | 1 | $0.0012 |
| flatten | pass | 3 | 1 | $0.0011 |
| gcd | pass | 12 | 4 | $0.0040 |
| get_factors | pass | 3 | 1 | $0.0011 |
| hanoi | pass | 4 | 2 | $0.0015 |
| is_valid_parenthesization | pass | 3 | 1 | $0.0012 |
| kheapsort | pass | 4 | 1 | $0.0017 |
| knapsack | pass | 12 | 4 | $0.0047 |
| kth | pass | 3 | 1 | $0.0012 |
| lcs_length | pass | 3 | 1 | $0.0011 |
| levenshtein | pass | 3 | 1 | $0.0017 |
| lis | pass | 4 | 2 | $0.0020 |
| longest_common_subsequence | pass | 4 | 2 | $0.0017 |
| max_sublist_sum | pass | 3 | 1 | $0.0012 |
| mergesort | fail | 12 | 4 | $0.0554 |
| minimum_spanning_tree | pass | 4 | 2 | $0.0016 |
| next_palindrome | pass | 3 | 1 | $0.0013 |
| next_permutation | pass | 3 | 1 | $0.0012 |
| pascal | pass | 12 | 4 | $0.0056 |
| possible_change | pass | 12 | 5 | $0.0045 |
| powerset | pass | 12 | 5 | $0.0045 |
| quicksort | pass | 3 | 1 | $0.0012 |
| reverse_linked_list | fail | 12 | 5 | $0.0100 |
| rpn_eval | pass | 12 | 4 | $0.0049 |
| shortest_path_length | pass | 6 | 2 | $0.0139 |
| shortest_path_lengths | pass | 12 | 5 | $0.0055 |
| shortest_paths | pass | 12 | 5 | $0.0049 |
| shunting_yard | fail | 12 | 2 | $0.0117 |
| sieve | pass | 3 | 1 | $0.0010 |
| sqrt | fail | 12 | 3 | $0.0078 |
| subsequences | pass | 3 | 1 | $0.0011 |
| to_base | pass | 3 | 1 | $0.0011 |
| topological_ordering | fail | 12 | 5 | $0.0049 |
| wrap | pass | 12 | 4 | $0.0046 |

