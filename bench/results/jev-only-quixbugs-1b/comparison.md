# JevCode bench 20260920-190300-a33dd1

Generated 2026-09-20T19:13:12.592Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.2352 = $0.2352. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 12 (n=34) |
| steps-to-solve median | 12 |
| steps used mean (n runs) | 12 (n=40) |
| steps used median | 12 |
| read actions total / mean per run | 56 / 1.40 |
| blocked / reviews / declined | 351 / 30 / 30 |
| loops / replans | 86 / 75 |
| Jev requests / questions | 2049 / 20603 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 181.90 / 308.43 (n=2049) |
| mean generator tokens/step (steps) | 0 (n=480) |
| mean Jev tokens/step (steps) | 12661 (n=480) |
| mean tokens/step, generator+Jev (steps) | 12661 (n=480) |
| wall time mean | 54s |
| cost generator / Jev / total | $0.0000 / $0.2352 / $0.2352 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 0/40 | 0.0% |  |
| 4 | 0/40 | 0.0% |  |
| 5 | 0/40 | 0.0% |  |
| 6 | 0/40 | 0.0% |  |
| 7 | 0/40 | 0.0% |  |
| 8 | 0/40 | 0.0% |  |
| 9 | 0/40 | 0.0% |  |
| 10 | 0/40 | 0.0% |  |
| 11 | 0/40 | 0.0% |  |
| 12 | 34/40 | 85.0% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=40) |  |
| 5 | 0 (n=40) |  |
| 6 | 0 (n=40) |  |
| 7 | 0 (n=40) |  |
| 8 | 0 (n=40) |  |
| 9 | 0 (n=40) |  |
| 10 | 0 (n=40) |  |
| 11 | 0 (n=40) |  |
| 12 | 0 (n=40) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7037 (n=40) | ██████ |
| 2 | 10562 (n=40) | █████████ |
| 3 | 24842 (n=40) | ████████████████████ |
| 4 | 22155 (n=40) | ██████████████████ |
| 5 | 16769 (n=40) | ██████████████ |
| 6 | 8694 (n=40) | ███████ |
| 7 | 9082 (n=40) | ███████ |
| 8 | 15105 (n=40) | ████████████ |
| 9 | 8757 (n=40) | ███████ |
| 10 | 9424 (n=40) | ████████ |
| 11 | 10894 (n=40) | █████████ |
| 12 | 8615 (n=40) | ███████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7037 (n=40) | ██████ |
| 2 | 10562 (n=40) | █████████ |
| 3 | 24842 (n=40) | ████████████████████ |
| 4 | 22155 (n=40) | ██████████████████ |
| 5 | 16769 (n=40) | ██████████████ |
| 6 | 8694 (n=40) | ███████ |
| 7 | 9082 (n=40) | ███████ |
| 8 | 15105 (n=40) | ████████████ |
| 9 | 8757 (n=40) | ███████ |
| 10 | 9424 (n=40) | ████████ |
| 11 | 10894 (n=40) | █████████ |
| 12 | 8615 (n=40) | ███████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_steps | 40 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | fail | 12 | 3 | $0.0058 |
| breadth_first_search | pass | 12 | 1 | $0.0044 |
| bucketsort | pass | 12 | 1 | $0.0046 |
| depth_first_search | pass | 12 | 1 | $0.0044 |
| detect_cycle | pass | 12 | 1 | $0.0042 |
| find_first_in_sorted | pass | 12 | 1 | $0.0052 |
| find_in_sorted | pass | 12 | 1 | $0.0042 |
| flatten | pass | 12 | 1 | $0.0040 |
| gcd | pass | 12 | 1 | $0.0042 |
| get_factors | pass | 12 | 1 | $0.0043 |
| hanoi | pass | 12 | 1 | $0.0043 |
| is_valid_parenthesization | pass | 12 | 1 | $0.0044 |
| kheapsort | pass | 12 | 1 | $0.0045 |
| knapsack | pass | 12 | 1 | $0.0048 |
| kth | pass | 12 | 1 | $0.0045 |
| lcs_length | pass | 12 | 1 | $0.0041 |
| levenshtein | pass | 12 | 1 | $0.0043 |
| lis | pass | 12 | 1 | $0.0049 |
| longest_common_subsequence | pass | 12 | 1 | $0.0043 |
| max_sublist_sum | pass | 12 | 1 | $0.0045 |
| mergesort | fail | 12 | 4 | $0.0194 |
| minimum_spanning_tree | pass | 12 | 1 | $0.0042 |
| next_palindrome | pass | 12 | 1 | $0.0043 |
| next_permutation | pass | 12 | 1 | $0.0046 |
| pascal | pass | 12 | 1 | $0.0046 |
| possible_change | pass | 12 | 1 | $0.0044 |
| powerset | pass | 12 | 1 | $0.0044 |
| quicksort | pass | 12 | 1 | $0.0047 |
| reverse_linked_list | fail | 12 | 3 | $0.0105 |
| rpn_eval | pass | 12 | 1 | $0.0046 |
| shortest_path_length | pass | 12 | 3 | $0.0198 |
| shortest_path_lengths | pass | 12 | 1 | $0.0051 |
| shortest_paths | pass | 12 | 1 | $0.0047 |
| shunting_yard | fail | 12 | 3 | $0.0160 |
| sieve | pass | 12 | 1 | $0.0042 |
| sqrt | fail | 12 | 4 | $0.0076 |
| subsequences | pass | 12 | 1 | $0.0039 |
| to_base | pass | 12 | 1 | $0.0043 |
| topological_ordering | fail | 12 | 3 | $0.0097 |
| wrap | pass | 12 | 1 | $0.0045 |

