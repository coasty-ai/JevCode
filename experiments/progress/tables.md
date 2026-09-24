Run: 2026-09-20T15:25:51Z, model `typesafe/jev-1.13-20260917`, 40 programs, 240 candidates, 994 requests, cost $0.0668, Jev latency p50 190 ms, p95 319 ms.

### Candidate set

| kind | n | definition (ground truth computed from the test runs) |
| --- | --- | --- |
| fix | 40 | correct program; every test passes |
| partial | 10 | passes strictly more tests than `before`, breaks none, some still fail |
| partial_mixed | 3 | passes more tests than `before` but also breaks at least one that passed |
| regression | 76 | passes fewer tests than `before` |
| lateral | 6 | same pass count as `before` but a different set (broke one, fixed another) |
| no_change | 65 | a different program with the same set of passing tests as `before` (actual outputs may differ) |
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

Mean per-program Spearman(p, −input length) over programs with ≥ 3 failing tests and unequal lengths (n=29): neutral 0.32, explicit 0.62.

Counting ties as hits (argmax input length equals the minimum length): neutral 17/34 (0.50), explicit 25/34 (0.74). Programs where every input has the same length: 3. Random top-1 baseline when ties count as hits: 0.39.

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

