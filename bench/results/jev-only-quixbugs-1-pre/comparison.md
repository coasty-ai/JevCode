# JevCode bench 20260920-184954-317a49

Generated 2026-09-20T19:01:36.729Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.2413 = $0.2413. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 40 | 40 | 32 | 32/40 (n=40) 80.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| argument_swap | 5 | 3/5 60.0% |
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
| pass rate (passed/evaluated) | 32/40 (n=40) 80.0% |
| steps-to-solve mean (n passed) | 9.22 (n=32) |
| steps-to-solve median | 12 |
| steps used mean (n runs) | 9.78 (n=40) |
| steps used median | 12 |
| read actions total / mean per run | 59 / 1.48 |
| blocked / reviews / declined | 229 / 95 / 95 |
| loops / replans | 46 / 41 |
| Jev requests / questions | 1956 / 27499 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 190.26 / 346.64 (n=1956) |
| mean generator tokens/step (steps) | 0 (n=391) |
| mean Jev tokens/step (steps) | 16421 (n=391) |
| mean tokens/step, generator+Jev (steps) | 16421 (n=391) |
| wall time mean | 1m4s |
| cost generator / Jev / total | $0.0000 / $0.2413 / $0.2413 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 1/40 | 2.5% | █ |
| 4 | 7/40 | 17.5% | ████ |
| 5 | 10/40 | 25.0% | █████ |
| 6 | 11/40 | 27.5% | ██████ |
| 7 | 12/40 | 30.0% | ██████ |
| 8 | 12/40 | 30.0% | ██████ |
| 9 | 12/40 | 30.0% | ██████ |
| 10 | 12/40 | 30.0% | ██████ |
| 11 | 12/40 | 30.0% | ██████ |
| 12 | 32/40 | 80.0% | ████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=39) |  |
| 5 | 0 (n=33) |  |
| 6 | 0 (n=30) |  |
| 7 | 0 (n=29) |  |
| 8 | 0 (n=28) |  |
| 9 | 0 (n=28) |  |
| 10 | 0 (n=28) |  |
| 11 | 0 (n=28) |  |
| 12 | 0 (n=28) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7079 (n=40) | ███ |
| 2 | 10636 (n=40) | █████ |
| 3 | 26842 (n=40) | █████████████ |
| 4 | 20530 (n=39) | ██████████ |
| 5 | 21746 (n=33) | ███████████ |
| 6 | 8951 (n=30) | ████ |
| 7 | 11004 (n=29) | █████ |
| 8 | 40563 (n=28) | ████████████████████ |
| 9 | 10842 (n=28) | █████ |
| 10 | 13868 (n=28) | ███████ |
| 11 | 11090 (n=28) | █████ |
| 12 | 14084 (n=28) | ███████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7079 (n=40) | ███ |
| 2 | 10636 (n=40) | █████ |
| 3 | 26842 (n=40) | █████████████ |
| 4 | 20530 (n=39) | ██████████ |
| 5 | 21746 (n=33) | ███████████ |
| 6 | 8951 (n=30) | ████ |
| 7 | 11004 (n=29) | █████ |
| 8 | 40563 (n=28) | ████████████████████ |
| 9 | 10842 (n=28) | █████ |
| 10 | 13868 (n=28) | ███████ |
| 11 | 11090 (n=28) | █████ |
| 12 | 14084 (n=28) | ███████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 12 | █████████ |
| max_steps | 28 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | fail | 12 | 3 | $0.0069 |
| breadth_first_search | pass | 4 | 1 | $0.0017 |
| bucketsort | pass | 4 | 1 | $0.0015 |
| depth_first_search | pass | 12 | 1 | $0.0042 |
| detect_cycle | pass | 6 | 1 | $0.0022 |
| find_first_in_sorted | pass | 12 | 1 | $0.0060 |
| find_in_sorted | pass | 12 | 1 | $0.0046 |
| flatten | pass | 3 | 1 | $0.0010 |
| gcd | fail | 12 | 4 | $0.0121 |
| get_factors | pass | 12 | 1 | $0.0039 |
| hanoi | pass | 12 | 1 | $0.0041 |
| is_valid_parenthesization | pass | 4 | 1 | $0.0015 |
| kheapsort | pass | 12 | 1 | $0.0045 |
| knapsack | pass | 12 | 1 | $0.0042 |
| kth | pass | 7 | 1 | $0.0027 |
| lcs_length | pass | 12 | 1 | $0.0038 |
| levenshtein | pass | 12 | 1 | $0.0047 |
| lis | pass | 4 | 1 | $0.0019 |
| longest_common_subsequence | pass | 12 | 1 | $0.0042 |
| max_sublist_sum | pass | 12 | 1 | $0.0046 |
| mergesort | fail | 12 | 3 | $0.0604 |
| minimum_spanning_tree | pass | 12 | 1 | $0.0040 |
| next_palindrome | pass | 4 | 1 | $0.0017 |
| next_permutation | pass | 12 | 1 | $0.0046 |
| pascal | pass | 12 | 1 | $0.0046 |
| possible_change | pass | 12 | 1 | $0.0039 |
| powerset | pass | 5 | 1 | $0.0019 |
| quicksort | pass | 4 | 1 | $0.0017 |
| reverse_linked_list | fail | 12 | 4 | $0.0164 |
| rpn_eval | pass | 12 | 1 | $0.0042 |
| shortest_path_length | pass | 5 | 1 | $0.0073 |
| shortest_path_lengths | pass | 12 | 1 | $0.0041 |
| shortest_paths | pass | 12 | 1 | $0.0040 |
| shunting_yard | fail | 12 | 3 | $0.0083 |
| sieve | pass | 12 | 1 | $0.0040 |
| sqrt | fail | 12 | 3 | $0.0093 |
| subsequences | pass | 12 | 1 | $0.0040 |
| to_base | fail | 12 | 3 | $0.0094 |
| topological_ordering | fail | 12 | 4 | $0.0048 |
| wrap | pass | 5 | 1 | $0.0023 |

