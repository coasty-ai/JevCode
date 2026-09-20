# JevCode bench 20260920-191351-2af058

Generated 2026-09-20T19:23:35.244Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.1779 = $0.1779. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 5.41 (n=34) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 6.38 (n=40) |
| steps used median | 4 |
| read actions total / mean per run | 69 / 1.73 |
| blocked / reviews / declined | 112 / 50 / 50 |
| loops / replans | 25 / 21 |
| Jev requests / questions | 1430 / 22355 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 183.99 / 339.57 (n=1430) |
| mean generator tokens/step (steps) | 0 (n=255) |
| mean Jev tokens/step (steps) | 18536 (n=255) |
| mean tokens/step, generator+Jev (steps) | 18536 (n=255) |
| wall time mean | 52s |
| cost generator / Jev / total | $0.0000 / $0.1779 / $0.1779 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 14/40 | 35.0% | ███████ |
| 4 | 24/40 | 60.0% | ████████████ |
| 5 | 24/40 | 60.0% | ████████████ |
| 6 | 27/40 | 67.5% | ██████████████ |
| 7 | 27/40 | 67.5% | ██████████████ |
| 8 | 27/40 | 67.5% | ██████████████ |
| 9 | 27/40 | 67.5% | ██████████████ |
| 10 | 27/40 | 67.5% | ██████████████ |
| 11 | 27/40 | 67.5% | ██████████████ |
| 12 | 34/40 | 85.0% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=26) |  |
| 5 | 0 (n=16) |  |
| 6 | 0 (n=16) |  |
| 7 | 0 (n=13) |  |
| 8 | 0 (n=13) |  |
| 9 | 0 (n=13) |  |
| 10 | 0 (n=13) |  |
| 11 | 0 (n=13) |  |
| 12 | 0 (n=12) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7024 (n=40) | ███ |
| 2 | 18047 (n=40) | ████████ |
| 3 | 22612 (n=40) | ██████████ |
| 4 | 16502 (n=26) | ███████ |
| 5 | 26283 (n=16) | ███████████ |
| 6 | 36444 (n=16) | ████████████████ |
| 7 | 9898 (n=13) | ████ |
| 8 | 10781 (n=13) | █████ |
| 9 | 46259 (n=13) | ████████████████████ |
| 10 | 9087 (n=13) | ████ |
| 11 | 10337 (n=13) | ████ |
| 12 | 21993 (n=12) | ██████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7024 (n=40) | ███ |
| 2 | 18047 (n=40) | ████████ |
| 3 | 22612 (n=40) | ██████████ |
| 4 | 16502 (n=26) | ███████ |
| 5 | 26283 (n=16) | ███████████ |
| 6 | 36444 (n=16) | ████████████████ |
| 7 | 9898 (n=13) | ████ |
| 8 | 10781 (n=13) | █████ |
| 9 | 46259 (n=13) | ████████████████████ |
| 10 | 9087 (n=13) | ████ |
| 11 | 10337 (n=13) | ████ |
| 12 | 21993 (n=12) | ██████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 26 | ████████████████████ |
| max_steps | 12 | █████████ |
| replan_stop | 2 | ██ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | fail | 11 | 4 | $0.0064 |
| breadth_first_search | pass | 4 | 2 | $0.0017 |
| bucketsort | pass | 12 | 1 | $0.0046 |
| depth_first_search | fail | 12 | 3 | $0.0042 |
| detect_cycle | pass | 12 | 2 | $0.0038 |
| find_first_in_sorted | pass | 12 | 1 | $0.0058 |
| find_in_sorted | pass | 3 | 1 | $0.0012 |
| flatten | pass | 3 | 1 | $0.0011 |
| gcd | pass | 4 | 2 | $0.0014 |
| get_factors | pass | 3 | 1 | $0.0011 |
| hanoi | pass | 4 | 2 | $0.0015 |
| is_valid_parenthesization | pass | 3 | 1 | $0.0012 |
| kheapsort | pass | 6 | 2 | $0.0023 |
| knapsack | pass | 3 | 1 | $0.0013 |
| kth | pass | 3 | 1 | $0.0012 |
| lcs_length | pass | 3 | 1 | $0.0011 |
| levenshtein | pass | 3 | 1 | $0.0012 |
| lis | pass | 4 | 2 | $0.0020 |
| longest_common_subsequence | pass | 4 | 2 | $0.0016 |
| max_sublist_sum | pass | 3 | 1 | $0.0012 |
| mergesort | fail | 12 | 5 | $0.0517 |
| minimum_spanning_tree | pass | 4 | 2 | $0.0016 |
| next_palindrome | pass | 3 | 1 | $0.0013 |
| next_permutation | pass | 3 | 1 | $0.0012 |
| pascal | pass | 4 | 2 | $0.0016 |
| possible_change | pass | 4 | 2 | $0.0015 |
| powerset | pass | 4 | 2 | $0.0015 |
| quicksort | pass | 12 | 1 | $0.0043 |
| reverse_linked_list | pass | 6 | 1 | $0.0087 |
| rpn_eval | pass | 4 | 1 | $0.0018 |
| shortest_path_length | pass | 6 | 2 | $0.0081 |
| shortest_path_lengths | pass | 12 | 1 | $0.0051 |
| shortest_paths | pass | 12 | 2 | $0.0046 |
| shunting_yard | fail | 12 | 3 | $0.0133 |
| sieve | pass | 3 | 1 | $0.0010 |
| sqrt | fail | 12 | 3 | $0.0136 |
| subsequences | pass | 3 | 1 | $0.0011 |
| to_base | pass | 3 | 1 | $0.0011 |
| topological_ordering | fail | 12 | 4 | $0.0048 |
| wrap | pass | 12 | 1 | $0.0044 |

