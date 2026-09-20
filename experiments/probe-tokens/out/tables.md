### T1. Teacher-forced next-token accuracy by token class (n = 426 positions, 40 lines)

| Class | n | top-1 | top-3 | MRR | mean p(truth) | mean p(top) |
| --- | --- | --- | --- | --- | --- | --- |
| identifier | 133 | 120 (90%) | 132 (99%) | 0.95 | 0.69 | 0.71 |
| punct | 144 | 112 (78%) | 138 (96%) | 0.87 | 0.62 | 0.71 |
| keyword | 42 | 38 (90%) | 40 (95%) | 0.94 | 0.75 | 0.80 |
| operator | 41 | 27 (66%) | 35 (85%) | 0.77 | 0.51 | 0.63 |
| number | 24 | 23 (96%) | 24 (100%) | 0.98 | 0.75 | 0.76 |
| literal | 2 | 2 (100%) | 2 (100%) | 1.00 | 0.92 | 0.92 |
| end_of_line | 40 | 37 (92%) | 39 (98%) | 0.95 | 0.80 | 0.82 |
| **all** | 426 | 359 (84.3%) | 410 (96.2%) | 0.905 | 0.67 | 0.72 |

### T2. Teacher-forced: calibration of p(top) against top-1 correctness

| p(top) band | n | top-1 accuracy |
| --- | --- | --- |
| 0.2–0.3 | 3 | 67% |
| 0.3–0.4 | 24 | 42% |
| 0.4–0.5 | 42 | 60% |
| 0.5–0.6 | 47 | 60% |
| 0.6–0.7 | 59 | 90% |
| 0.7–0.8 | 65 | 92% |
| 0.8–0.9 | 85 | 95% |
| 0.9–1.0 | 101 | 99% |

### T3. Per-line results, all conditions (40 QuixBugs fix lines)

Columns: `tok` = tokens in the fix line; `TF top1/top3` = teacher-forced positions correct out of tok+1 (incl. end_of_line); `W1`, `W3`, `W3g` = beam search width 1, 3, 3 with grammar filter: `E` exact token match, `P` passes tests (different tokens), `.` fail, `-` no completed beam; `W3 any`, `W3g any` = any of the top-3 completed beams passes tests; `Tpl cov` = correct template in the pool (source); `Tpl rk` = rank of the correct template; `Slot seq/par` = slot filling on the true template exact; `Tpl e2e` = top template then sequential slots; `Edit any` = edit-beam: any visited state passes tests (36 replace-kind lines only).

| Program | kind | tok | TF top1 | TF top3 | W1 | W3 | W3 any | W3g | W3g any | Tpl cov | Tpl rk | Slot seq | Slot par | Tpl e2e | Edit any | Any method |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | replace | 5 | 4/6 | 4/6 | . | . | . | . | . | mutant_of_buggy_line | 1 | Y | Y | E | E | Y |
| breadth_first_search | replace | 3 | 4/4 | 4/4 | E | E | E | E | E | buggy_line | 1 | Y | Y | E | E | Y |
| bucketsort | replace | 10 | 10/11 | 11/11 | . | E | E | E | E | buggy_line | 1 | Y | Y | E | E | Y |
| depth_first_search | insert | 6 | 6/7 | 7/7 | . | . | E | E | E | no | none_of_these | Y | Y | . | n/a | Y |
| detect_cycle | replace | 11 | 10/12 | 12/12 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| find_first_in_sorted | replace | 5 | 6/6 | 6/6 | E | E | E | E | E | mutant_of_buggy_line | 1 | Y | Y | E | E | Y |
| find_in_sorted | replace | 9 | 9/10 | 10/10 | . | . | . | E | E | no | n/a | Y | Y | . | . | Y |
| flatten | replace | 2 | 3/3 | 3/3 | E | E | E | E | E | line_5 | 1 | Y | Y | E | E | Y |
| gcd | replace | 9 | 10/10 | 10/10 | E | E | E | E | E | mutant_of_buggy_line | 1 | Y | . | E | . | Y |
| get_factors | replace | 4 | 5/5 | 5/5 | E | E | E | E | E | no | none_of_these | Y | Y | . | . | Y |
| hanoi | replace | 10 | 9/11 | 10/11 | . | . | . | . | . | buggy_line | 1 | Y | Y | E | E | Y |
| is_valid_parenthesization | replace | 4 | 5/5 | 5/5 | E | E | E | E | E | no | none_of_these | Y | Y | . | . | Y |
| kheapsort | replace | 9 | 7/10 | 9/10 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| knapsack | replace | 5 | 6/6 | 6/6 | E | E | E | E | E | mutant_of_buggy_line | 1 | Y | Y | E | E | Y |
| kth | replace | 9 | 9/10 | 10/10 | P | E | E | E | E | no | n/a | Y | . | . | . | Y |
| lcs_length | replace | 19 | 18/20 | 19/20 | . | - | . | . | . | no | n/a | Y | Y | . | . | . |
| levenshtein | replace | 15 | 12/16 | 16/16 | . | . | . | . | . | no | none_of_these | Y | Y | . | E | Y |
| lis | replace | 10 | 8/11 | 11/11 | . | . | . | . | . | no | none_of_these | . | . | . | . | . |
| longest_common_subsequence | replace | 20 | 16/21 | 21/21 | - | . | . | E | E | no | n/a | Y | Y | . | . | Y |
| max_sublist_sum | replace | 10 | 11/11 | 11/11 | E | E | E | E | E | no | n/a | Y | . | . | . | Y |
| mergesort | replace | 8 | 8/9 | 9/9 | E | E | E | E | E | no | n/a | Y | Y | . | . | Y |
| minimum_spanning_tree | replace | 9 | 9/10 | 9/10 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| next_palindrome | replace | 21 | 15/22 | 20/22 | - | . | . | . | . | no | n/a | Y | Y | . | . | . |
| next_permutation | replace | 11 | 9/12 | 10/12 | - | . | . | . | . | buggy_line | 1 | . | . | . | P | Y |
| pascal | replace | 12 | 12/13 | 13/13 | . | . | E | . | E | no | n/a | Y | Y | . | . | Y |
| possible_change | replace | 8 | 7/9 | 7/9 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| powerset | replace | 14 | 11/15 | 15/15 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| quicksort | replace | 20 | 18/21 | 21/21 | . | . | . | . | . | mutant_of_buggy_line | 1 | Y | Y | E | E | Y |
| reverse_linked_list | insert | 3 | 3/4 | 4/4 | E | E | E | E | E | line_2 | 1 | Y | . | E | n/a | Y |
| rpn_eval | replace | 8 | 8/9 | 9/9 | . | . | . | . | E | buggy_line | 1 | . | . | . | . | Y |
| shortest_path_length | replace | 8 | 9/9 | 9/9 | E | E | E | E | E | no | n/a | Y | Y | . | . | Y |
| shortest_path_lengths | replace | 13 | 11/14 | 14/14 | - | E | E | . | . | buggy_line | 1 | . | Y | . | . | Y |
| shortest_paths | replace | 7 | 6/8 | 7/8 | - | . | . | . | . | no | n/a | Y | Y | . | . | . |
| shunting_yard | insert | 6 | 6/7 | 7/7 | . | . | . | . | . | line_14 | 1 | Y | Y | E | n/a | Y |
| sieve | replace | 14 | 13/15 | 14/15 | . | . | . | P | P | buggy_line | 2 | . | Y | . | E | Y |
| sqrt | replace | 12 | 11/13 | 12/13 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| subsequences | replace | 5 | 5/6 | 5/6 | . | . | . | . | . | no | n/a | Y | Y | . | . | . |
| to_base | replace | 8 | 8/9 | 9/9 | . | . | . | . | E | no | n/a | Y | Y | . | . | Y |
| topological_ordering | replace | 18 | 17/19 | 19/19 | . | . | . | . | . | buggy_line | 1 | Y | . | E | . | Y |
| wrap | insert | 6 | 5/7 | 7/7 | . | . | . | . | . | line_8 | 2 | Y | Y | . | n/a | . |

Lines solved (tests pass) by at least one condition: **28/40**.

### T4. Condition summary

| Condition | n lines | top-scored exact | top-scored passes tests | any of top-3 passes tests | requests/line | cost/line | cost total | Jev p50 | wall p50/line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Beam W=1 (greedy) | 40 | 11 | 12 | 12 | 10.3 | $0.0022 | $0.0900 | 207 ms | 2.0 s |
| Beam W=3 | 40 | 14 | 14 | 16 | 30.4 | $0.0065 | $0.2619 | 215 ms | 3.1 s |
| Beam W=3 + grammar filter | 40 | 16 | 17 | 20 | 31.1 | $0.0037 | $0.1476 | 207 ms | 3.3 s |
| Templates → sequential slots (e2e) | 40 | 12 | 12 | n/a | 7.7 | $0.0010 | $0.0391 | 203 ms | 1.6 s |
| Edit-beam W=3 depth 3 (36 replace lines) | 36 | 5 | 7 | 11 (stopped) / 11 (any visited state) | 18.6 | $0.0020 | $0.0734 | 250 ms | 3.0 s |
| Teacher-forced (426 positions) | 40 | – | – | – | 10.7 | $0.0023 | $0.0913 | 227 ms | – |

Total live spend: **$0.7032** over 4277 requests (all costs from `usage.costUsd`). Mean input tokens per request: teacher-forced 5102, beam W=3 5131, beam W=3+grammar 2822, templates 3031, edit-beam 2609.

### T5. Template experiment summary

| Measurement | Result |
| --- | --- |
| Pool size (buggy line + donor lines + mutants of the buggy line), mean / max | 9.3 / 27 |
| Correct template in pool (coverage) | 17/40 (from buggy line 8, mutant 5, donor line 4) |
| Template Choice top-1 / top-3 when covered | 15/17 / 17/17 (mean p(truth) 0.65) |
| When not covered: picked `none_of_these` / picked the buggy line's template | 5/23 / 18/23 |
| Slot filling on the true template, sequential (one Choice per slot, earlier slots filled) | 35/40 exact |
| Slot filling on the true template, parallel (all slots as independent Choices in one request) | 32/40 exact |
| End to end (top-1 template, then sequential slots) exact / passes tests | 12/40 / 12/40 |
| Slots per line, mean / max | 4.0 / 9 |
