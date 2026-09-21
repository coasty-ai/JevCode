# JevCode bench 20260921-022420-3b3af3

Generated 2026-09-21T02:40:09.532Z. Generator model `none (jev-only)`. 40 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 8m | $0.0500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0500; spent generator $0.0000 + Jev $0.1850 = $0.1850. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 40 | 40 | 39 | 39/40 (n=40) 97.5% | — | — | — | — |

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
| wrong_variable | 7 | 6/7 85.7% |

### Paired comparison (n = 40 tasks evaluated in every condition)

Paired tasks: `bitcount`, `breadth_first_search`, `bucketsort`, `depth_first_search`, `detect_cycle`, `find_first_in_sorted`, `find_in_sorted`, `flatten`, `gcd`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `kheapsort`, `knapsack`, `kth`, `lcs_length`, `levenshtein`, `lis`, `longest_common_subsequence`, `max_sublist_sum`, `mergesort`, `minimum_spanning_tree`, `next_palindrome`, `next_permutation`, `pascal`, `possible_change`, `powerset`, `quicksort`, `reverse_linked_list`, `rpn_eval`, `shortest_path_length`, `shortest_path_lengths`, `shortest_paths`, `shunting_yard`, `sieve`, `sqrt`, `subsequences`, `to_base`, `topological_ordering`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 39/40 (n=40) 97.5% |
| steps-to-solve mean (n passed) | 3.54 (n=39) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 3.73 (n=40) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 4 / 0 / 0 |
| loops / replans | 13 / 13 |
| Jev requests / questions | 1225 / 28228 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 178.48 / 339.52 (n=1225) |
| mean generator tokens/step (steps) | 0 (n=149) |
| mean Jev tokens/step (steps) | 33655 (n=149) |
| mean tokens/step, generator+Jev (steps) | 33655 (n=149) |
| wall time mean | 1m18s |
| cost generator / Jev / total | $0.0000 / $0.1850 / $0.1850 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/40 | 0.0% |  |
| 2 | 0/40 | 0.0% |  |
| 3 | 36/40 | 90.0% | ██████████████████ |
| 4 | 36/40 | 90.0% | ██████████████████ |
| 5 | 36/40 | 90.0% | ██████████████████ |
| 6 | 36/40 | 90.0% | ██████████████████ |
| 7 | 36/40 | 90.0% | ██████████████████ |
| 8 | 36/40 | 90.0% | ██████████████████ |
| 9 | 36/40 | 90.0% | ██████████████████ |
| 10 | 39/40 | 97.5% | ████████████████████ |
| 11 | 39/40 | 97.5% | ████████████████████ |
| 12 | 39/40 | 97.5% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=40) |  |
| 2 | 0 (n=40) |  |
| 3 | 0 (n=40) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=4) |  |
| 8 | 0 (n=4) |  |
| 9 | 0 (n=4) |  |
| 10 | 0 (n=4) |  |
| 11 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8745 (n=40) | █ |
| 2 | 19981 (n=40) | █ |
| 3 | 11304 (n=40) | █ |
| 4 | 146283 (n=4) | ██████████ |
| 5 | 54650 (n=4) | ████ |
| 6 | 126715 (n=4) | ████████ |
| 7 | 72886 (n=4) | █████ |
| 8 | 130058 (n=4) | ████████ |
| 9 | 130831 (n=4) | █████████ |
| 10 | 115336 (n=4) | ████████ |
| 11 | 306300 (n=1) | ████████████████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8745 (n=40) | █ |
| 2 | 19981 (n=40) | █ |
| 3 | 11304 (n=40) | █ |
| 4 | 146283 (n=4) | ██████████ |
| 5 | 54650 (n=4) | ████ |
| 6 | 126715 (n=4) | ████████ |
| 7 | 72886 (n=4) | █████ |
| 8 | 130058 (n=4) | ████████ |
| 9 | 130831 (n=4) | █████████ |
| 10 | 115336 (n=4) | ████████ |
| 11 | 306300 (n=1) | ████████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 39 | ████████████████████ |
| spend_cap | 1 | █ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | pass | 3 | 0 | $0.0013 |
| breadth_first_search | pass | 3 | 0 | $0.0015 |
| bucketsort | pass | 3 | 0 | $0.0016 |
| depth_first_search | pass | 3 | 0 | $0.0014 |
| detect_cycle | pass | 3 | 0 | $0.0014 |
| find_first_in_sorted | pass | 3 | 0 | $0.0016 |
| find_in_sorted | pass | 3 | 0 | $0.0015 |
| flatten | pass | 3 | 0 | $0.0014 |
| gcd | pass | 3 | 0 | $0.0013 |
| get_factors | pass | 3 | 0 | $0.0013 |
| hanoi | pass | 3 | 0 | $0.0013 |
| is_valid_parenthesization | pass | 3 | 0 | $0.0014 |
| kheapsort | pass | 3 | 0 | $0.0014 |
| knapsack | pass | 3 | 0 | $0.0016 |
| kth | pass | 3 | 0 | $0.0014 |
| lcs_length | pass | 3 | 0 | $0.0013 |
| levenshtein | pass | 3 | 0 | $0.0020 |
| lis | pass | 10 | 0 | $0.0178 |
| longest_common_subsequence | pass | 3 | 0 | $0.0014 |
| max_sublist_sum | pass | 3 | 0 | $0.0015 |
| mergesort | pass | 10 | 0 | $0.0400 |
| minimum_spanning_tree | pass | 3 | 0 | $0.0014 |
| next_palindrome | pass | 3 | 0 | $0.0015 |
| next_permutation | pass | 3 | 0 | $0.0016 |
| pascal | pass | 3 | 0 | $0.0014 |
| possible_change | pass | 3 | 0 | $0.0015 |
| powerset | pass | 3 | 0 | $0.0014 |
| quicksort | pass | 3 | 0 | $0.0015 |
| reverse_linked_list | pass | 3 | 0 | $0.0037 |
| rpn_eval | pass | 3 | 0 | $0.0016 |
| shortest_path_length | fail | 11 | 0 | $0.0538 |
| shortest_path_lengths | pass | 3 | 0 | $0.0015 |
| shortest_paths | pass | 3 | 0 | $0.0015 |
| shunting_yard | pass | 3 | 0 | $0.0017 |
| sieve | pass | 3 | 0 | $0.0013 |
| sqrt | pass | 3 | 0 | $0.0013 |
| subsequences | pass | 3 | 0 | $0.0015 |
| to_base | pass | 3 | 0 | $0.0014 |
| topological_ordering | pass | 10 | 0 | $0.0183 |
| wrap | pass | 3 | 0 | $0.0016 |

