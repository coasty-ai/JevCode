# Probe: candidate selection at scale on QuixBugs (2026-09-20)

Scripts: `experiments/probe-select/` (`mutators.ts` operator library, `candidates.ts` set construction, `quixbugs.ts` + `run_tests.py` loader and oracle, `run.mts` live driver, `report.mts` this file). Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. All 40 QuixBugs Python programs (36 one-line replacements, 4 missing-statement insertions: depth_first_search, reverse_linked_list, shunting_yard, wrap). Raw records: `experiments/results/probe-selection.raw.jsonl` (1470 Jev requests, total $0.6188, latency p50 228 ms, p95 519 ms). Verification records (2026-09-20, not part of the 1470): `probe-selection.noescape.jsonl` (160 requests, the real no-escape control, $0.0255) and `probe-selection.verify.jsonl` (16 live re-run requests, $0.0047); see "Verification" at the end.

## Summary

| method (one request each) | N=10 top-1 / top-3 | N=50 top-1 / top-3 | N=150 top-1 / top-3 | N=254 top-1 / top-3 | N=254 top-1 plausible | N=254 tokens / cost / p50 |
| --- | --- | --- | --- | --- | --- | --- |
| Choice over candidates + `none_of_these` | 36/40 / 40/40 | 31/40 / 40/40 | 29/40 / 38/40 | 26/40 / 37/40 | 28/40 | 7196 / $0.00030 / 253 ms |
| Batched Nouls, full criteria per Noul | 39/40 / 40/40 | 39/40 / 40/40 | 35/40 / 39/40 | 31/40 / 39/40 | 34/40 | 57482 / $0.0024 / 547 ms |
| Batched Nouls, compact (criteria once in state) | 39/40 / 40/40 | 37/40 / 40/40 | 32/40 / 38/40 | 32/40 / 36/40 | 35/40 | 18278 / $0.00077 / 331 ms |
| Two-stage: Nouls (254) then Choice over the Noul top-5 | - | - | - | 33/40 (fix shortlisted 39/40) | 36/40 | two requests, about $0.0025, about 0.8 s |

Fix absent (no-fix sets): with Choice the escape wins 39/40, 33/40, 30/40, 30/40 at N = 10/50/150/254; the best single-request detector is `P(escape) - p_max >= 0.10` (AUROC 0.916, 82% detection, 13% false alarms pooled over sizes). With Nouls, `max Noul < 0.5` detects 71-75% with 16-21% false alarms (AUROC 0.85-0.86). At N >= 150, 13-23% of the "no-fix" sets in fact contained a different line that passes every test (Jev picked it), so the true detector ceiling is lower than 100%. **[Corrected in verification]** Removing the escape option raises Choice top-1 by 2-3 programs at every size (38/33/31/29 vs 36/31/29/26 at N = 10/50/150/254, P(fix) mean +0.10) but does not remove the decay with N (95% -> 72%): the escape costs a little accuracy on borderline items, and the size degradation is intrinsic. (The original sentence, "identical at N = 10/50/150, 24 vs 26 at 254", was based on a phase that had been run with the escape still on; see the Control section.) Option order flipped the argmax on 1/10 programs (a 0.29 vs 0.30 tie) with P(fix) spread up to 0.33 on borderline items against a repeat noise of 0.03 mean / 1 flip in 40; Noul repeat noise 0.036 mean / 2 flips in 40.

## Setup

**Candidate sets.** For each program the buggy line (the gold diff's replaced line; for insertions, the line before the insertion point) is mutated by 20 string-level operators (relational, arithmetic and boolean swaps; off-by-one on integer literals and on atoms in index/argument positions; index flips; argument-order swaps; negation insertion/removal; constant substitution from literals in the program and the first three tests; identifier, call-name and attribute substitution from in-scope names; return tweaks; operand swap / condition inversion; guard extension `if X or not y:`; wrap/unwrap in max/min/`** 2`; slice tweaks; drop-index; method-call to assignment; `k` to `k - other`). Mutants that do not `compile()` in place are dropped. The pool is ordered: the unchanged buggy line, first-order mutants of the buggy line (seeded shuffle), then mutants of neighbouring lines by distance (re-indented), then second-order mutants; for insertions, every program line re-indented as a donor plus its mutants plus `a.add(b)`/`a.append(b)`/`a = b` templates over in-scope names. Sets are nested prefixes of the pool of size 10, 50, 150 and 254 (+ `none_of_these` = 255 options), with the gold fix line inserted at a seeded position for the with-fix sets and omitted (next pool entry used) for the no-fix sets.

**State shape** (identical for every condition; the `desc` variant carries candidate text in the option descriptions, the `state` variant puts them under `state.candidates` with null descriptions):

```json
{ "task": "The Python function `gcd` has a one-line bug. `buggy_line` (line `buggy_line_number` of `program`) is the faulty line. `tests` shows inputs, the expected output, and what the buggy program actually does.",
  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", ... },
  "buggy_line_number": "L5", "buggy_line": "        return gcd(a % b, b)",
  "tests": [ { "input": [13, 13], "expected": 13, "actual_with_bug": "RecursionError: maximum recursion depth exceeded (unbounded recursion)", "status_with_bug": "exception" }, ... up to 3, failing tests first ],
  "candidates": { "cand_aa": "...", ... }   // state variant and Nouls only
}
```

Node-based programs (the 9 graph programs) carry `test_source` (the pytest function text) instead of `input`, with `expected` = the assert lines and `actual_with_bug` = pass / AssertionError / exception / timeout. Tests: the first three tests with failing ones first; the oracle for "plausible" is every test the gold program passes within 2 s (QuixBugs' two slow tests excluded).

**Choice question** (options `cand_aa`..`cand_jt` = candidate text, plus `none_of_these` = "No option is a correct fix; every option leaves the tests failing or breaks the function."):

> Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix.

(insert mode: "Which option is the missing statement that, inserted immediately after `buggy_line`, makes every test in `tests` pass ...".)

**Noul per candidate** (one request, one Noul per candidate, candidates in `state.candidates`):

> Is `candidates.cand_xx` the corrected line: put in place of `buggy_line`, does it make every test in `tests` pass?

true: "The candidate repairs the exact mistake so the function returns `expected` for every test input, including the tests that currently fail, and stays correct on the tests that already pass." (examples: the operator, index or argument the bug got wrong is corrected and nothing else changes; a line equivalent to the reference implementation of this algorithm). false: "The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure." (examples: the faulty line unchanged; a mutation that changes the wrong operator or the wrong variable; a copy or mutation of another line of the program).

## Operator library: does it generate the gold fix? (offline, no Jev)

Gold fix produced as a first-order mutant of the buggy line (or, for insertions, a donor/template line): **38/40**; reachable with two operators: 2/40 (mergesort `== 0` to `<= 1`, shortest_paths `weight_by_edge[u, v]` to `weight_by_node[v]`); unreachable: 0/40. Pool sizes after the compile filter: first-order 36..642 (median 129), all pools padded to 254. The operator that produced each gold fix is in the table below (offline output of `coverage.mts`).

| program | mode | first-order mutants | compilable | gold fix generated | gold fix |
| --- | --- | --- | --- | --- | --- |
| bitcount | replace | 46 | 45 | yes (arithmetic_swap) | `n &= n - 1` |
| breadth_first_search | replace | 86 | 86 | yes (identifier_substitution) | `while queue:` |
| bucketsort | replace | 128 | 122 | yes (identifier_substitution) | `for i, count in enumerate(counts):` |
| depth_first_search | insert | 1011 | 523 | yes (statement_template) | `nodesvisited.add(node)` |
| detect_cycle | replace | 62 | 61 | yes (guard_extension) | `if hare is None or hare.successor is None:` |
| find_first_in_sorted | replace | 125 | 125 | yes (relational_swap) | `while lo < hi:` |
| find_in_sorted | replace | 160 | 160 | yes (off_by_one_atom) | `return binsearch(mid + 1, end)` |
| flatten | replace | 80 | 80 | yes (return_tweak) | `yield x` |
| gcd | replace | 112 | 112 | yes (argument_swap) | `return gcd(b, a % b)` |
| get_factors | replace | 36 | 36 | yes (constant_substitution) | `return [n]` |
| hanoi | replace | 93 | 92 | yes (identifier_substitution) | `steps.append((start, end))` |
| is_valid_parenthesization | replace | 41 | 41 | yes (return_tweak) | `return depth == 0` |
| kheapsort | replace | 42 | 40 | yes (slice_tweak) | `for x in arr[k:]:` |
| knapsack | replace | 161 | 161 | yes (relational_swap) | `if weight <= j:` |
| kth | replace | 177 | 177 | yes (binop_with_identifier) | `return kth(above, k - num_lessoreq)` |
| lcs_length | replace | 204 | 203 | yes (off_by_one_atom) | `dp[i, j] = dp[i - 1, j - 1] + 1` |
| levenshtein | replace | 93 | 93 | yes (return_tweak) | `return levenshtein(source[1:], target[1:])` |
| lis | replace | 78 | 77 | yes (wrap_unwrap) | `longest = max(longest, length + 1)` |
| longest_common_subsequence | replace | 117 | 117 | yes (slice_tweak) | `return a[0] + longest_common_subsequence(a[1:], b[1:])` |
| max_sublist_sum | replace | 82 | 81 | yes (wrap_unwrap) | `max_ending_here = max(0, max_ending_here + x)` |
| mergesort | replace | 205 | 205 | second-order (relational_swap+off_by_one_literal) | `if len(arr) <= 1:` |
| minimum_spanning_tree | replace | 129 | 129 | yes (method_to_assign) | `group_by_node[node] = group_by_node[u]` |
| next_palindrome | replace | 132 | 131 | yes (off_by_one_atom) | `return [1] + (len(digit_list) - 1) * [0] + [1]` |
| next_permutation | replace | 139 | 139 | yes (index_flip) | `if perm[i] < perm[j]:` |
| pascal | replace | 102 | 100 | yes (off_by_one_atom) | `for c in range(0, r + 1):` |
| possible_change | replace | 92 | 92 | yes (guard_extension) | `if total < 0 or not coins:` |
| powerset | replace | 184 | 169 | yes (return_tweak) | `return rest_subsets + [[first] + subset for subset in rest_subsets]` |
| quicksort | replace | 201 | 185 | yes (relational_swap) | `greater = quicksort([x for x in arr[1:] if x >= pivot])` |
| reverse_linked_list | insert | 398 | 295 | yes (identifier_substitution) | `prevnode = node` |
| rpn_eval | replace | 161 | 161 | yes (argument_swap) | `op(token, b, a)` |
| shortest_path_length | replace | 300 | 300 | yes (wrap_unwrap) | `distance + length_by_edge[node, nextnode]` |
| shortest_path_lengths | replace | 187 | 187 | yes (index_flip) | `length_by_path[i, k] + length_by_path[k, j]` |
| shortest_paths | replace | 144 | 115 | second-order (drop_index+identifier_substitution) | `weight_by_node[v] = min(` |
| shunting_yard | insert | 1136 | 491 | yes (identifier_substitution) | `opstack.append(token)` |
| sieve | replace | 215 | 202 | yes (boolean_swap) | `if all(n % p > 0 for p in primes):` |
| sqrt | replace | 159 | 159 | yes (wrap_unwrap) | `while abs(x - approx ** 2) > epsilon:` |
| subsequences | replace | 60 | 60 | yes (constant_substitution) | `return [[]]` |
| to_base | replace | 103 | 102 | yes (condition_inversion) | `result = alphabet[i] + result` |
| topological_ordering | replace | 183 | 181 | yes (attribute_substitution) | `if set(ordered_nodes).issuperset(nextnode.incoming_nodes) and nextnode not in ordered_nodes:` |
| wrap | insert | 1051 | 682 | yes (identifier_substitution) | `lines.append(text)` |

first-order coverage 38/40, first+second-order 40/40

## A/B: candidate text in option descriptions (`desc`) vs in `state.candidates` (`state`), Choice, 50 candidates + escape, fix present

| variant | n | top-1 = fix | top-1 plausible (passes all tests) | top-3 | MRR | P(fix) mean / min | P(escape) mean | escape wins | tokens mean | cost total | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desc | 40 | 28/40 (70%) | 29/40 (73%) | 40/40 (100%) | 0.829 | 0.66 / 0.02 | 0.21 | 10 | 2233 | $0.0038 | 190 |
| state | 40 | 29/40 (73%) | 30/40 (75%) | 39/40 (98%) | 0.840 | 0.57 / 0.02 | 0.27 | 8 | 2418 | $0.0041 | 206 |

Programs where the two shapes disagree on top-1: kth (desc fix, state miss); reverse_linked_list (desc miss, state fix); sieve (desc miss, state fix).

## Choice over N candidates + escape, fix present (variant `desc`)

| N candidates | n programs | top-1 = fix | top-1 plausible | top-3 = fix | top-3 plausible | MRR | P(fix) min / p25 / median / p75 / max | P(fix) >= 0.5 | P(escape) mean | escape wins | tokens mean | cost / request | cost total | latency p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 40 | 36/40 (90%) | 37/40 (93%) | 40/40 (100%) | 40/40 (100%) | 0.942 | 0.06 / 0.76 / 0.93 / 0.97 / 0.99 | 35 | 0.14 | 2 | 1259 | $0.00005 | $0.0021 | 215 | 336 |
| 50 | 40 | 31/40 (78%) | 32/40 (80%) | 40/40 (100%) | 40/40 (100%) | 0.875 | 0.02 / 0.43 / 0.82 / 0.92 / 0.99 | 28 | 0.21 | 7 | 2233 | $0.00009 | $0.0038 | 207 | 338 |
| 150 | 40 | 29/40 (73%) | 31/40 (78%) | 38/40 (95%) | 39/40 (98%) | 0.838 | 0.01 / 0.34 / 0.67 / 0.83 / 0.98 | 26 | 0.24 | 8 | 4664 | $0.00020 | $0.0078 | 222 | 354 |
| 254 | 40 | 26/40 (65%) | 28/40 (70%) | 37/40 (93%) | 38/40 (95%) | 0.792 | 0.02 / 0.31 / 0.55 / 0.80 / 0.99 | 21 | 0.28 | 9 | 7196 | $0.00030 | $0.0121 | 253 | 434 |

By bug kind:

| kind | N | n | top-1 = fix | top-1 plausible | MRR | P(fix) mean |
| --- | --- | --- | --- | --- | --- | --- |
| replace | 10 | 36 | 33/36 (92%) | 34/36 (94%) | 0.949 | 0.84 |
| replace | 50 | 36 | 28/36 (78%) | 29/36 (81%) | 0.875 | 0.68 |
| replace | 150 | 36 | 28/36 (78%) | 30/36 (83%) | 0.866 | 0.60 |
| replace | 254 | 36 | 24/36 (67%) | 26/36 (72%) | 0.797 | 0.53 |
| insert | 10 | 4 | 3/4 (75%) | 3/4 (75%) | 0.875 | 0.65 |
| insert | 50 | 4 | 3/4 (75%) | 3/4 (75%) | 0.875 | 0.58 |
| insert | 150 | 4 | 1/4 (25%) | 1/4 (25%) | 0.583 | 0.36 |
| insert | 254 | 4 | 2/4 (50%) | 2/4 (50%) | 0.750 | 0.45 |


## Choice, fix absent (variant `desc`): does `none_of_these` win, does the top probability stay low?

| N candidates | n | escape wins | P(escape) min / median / mean | max non-escape p median / mean / max | max non-escape p >= 0.5 | top-1 plausible (accidental fix in set) | tokens mean | cost / request | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 40 | 39/40 (98%) | 0.13 / 0.92 / 0.85 | 0.07 / 0.12 / 0.87 | 1 | 1/40 (3%) | 1260 | $0.00005 | 213 |
| 50 | 40 | 33/40 (83%) | 0.19 / 0.71 / 0.66 | 0.19 / 0.23 / 0.73 | 6 | 2/40 (5%) | 2233 | $0.00009 | 194 |
| 150 | 40 | 30/40 (75%) | 0.04 / 0.58 / 0.58 | 0.17 / 0.26 / 0.94 | 6 | 6/40 (15%) | 4665 | $0.00020 | 218 |
| 254 | 40 | 30/40 (75%) | 0.07 / 0.67 / 0.58 | 0.17 / 0.24 / 0.89 | 5 | 5/40 (13%) | 7196 | $0.00030 | 236 |


## "Fix not in set" detector (variant `desc`)

Signals per request: `P(escape)`, the top non-escape probability `p_max`, and their difference `P(escape) - p_max`. Positive class = fix absent. Thresholds swept on the pooled with-fix and no-fix requests over all sizes; per-size rows use the pooled best threshold.

| signal | AUROC | best threshold (flag "fix absent" when) | detection rate on no-fix sets | false alarms on with-fix sets | balanced accuracy |
| --- | --- | --- | --- | --- | --- |
| P(escape) | 0.909 | >= 0.46 | 0.79 (127/160) | 0.12 (19/160) | 0.84 |
| -p_max (low top probability) | 0.914 | p_max <= 0.33 | 0.81 (129/160) | 0.12 (19/160) | 0.84 |
| P(escape) - p_max | 0.916 | >= 0.10 | 0.82 (131/160) | 0.13 (20/160) | 0.85 |

Best signal: **P(escape) - p_max** at threshold >= 0.10. Per size:

| N | no-fix sets flagged (correct) | with-fix sets flagged (false alarm) | of the false alarms, top-1 was still the fix |
| --- | --- | --- | --- |
| 10 | 39/40 (98%) | 1/40 (3%) | 0/1 (0%) |
| 50 | 33/40 (83%) | 5/40 (13%) | 0/5 (0%) |
| 150 | 30/40 (75%) | 7/40 (18%) | 0/7 (0%) |
| 254 | 29/40 (73%) | 7/40 (18%) | 0/7 (0%) |

(Verification note: the pooled best threshold is the data value 0.0999... printed as 0.10; two N=254 items (mergesort no-fix 0.36-0.26, reverse_linked_list with-fix 0.50-0.40) sit exactly on it, so a strict `>= 0.10` in code gives 28/40 and 6/40 for this row. All other rows are unaffected.)

Operating points on `P(escape)` alone (pooled sizes):

| rule | no-fix flagged | with-fix flagged (false alarm) | precision of top-1 = fix among un-flagged with-fix sets |
| --- | --- | --- | --- |
| P(escape) >= 0.3 | 138/160 (86%) | 44/160 (28%) | 108/116 (93%) |
| P(escape) >= 0.4 | 129/160 (81%) | 24/160 (15%) | 120/136 (88%) |
| P(escape) >= 0.5 | 123/160 (77%) | 15/160 (9%) | 122/145 (84%) |
| P(escape) >= 0.6 | 103/160 (64%) | 8/160 (5%) | 122/152 (80%) |
| P(escape) >= 0.7 | 85/160 (53%) | 2/160 (1%) | 122/158 (77%) |


## Control: Choice without any escape option, fix present (violates the REPORT rule on purpose, to measure what the escape costs)

**Corrected in verification (2026-09-20).** The `noescape` phase in the original run was executed without `--escape off`, so every one of its 160 records carries the `none_of_these` option (`options` = N+1, variant `desc`, escape mass > 0 in 159/160, escape wins in 27) and it is in fact a second repeat of the with-fix Choice condition, not a control. The real control was re-run by the checker with `run.mts noescape --escape off` (variant `desc_noescape`, `options` = N, P(escape) = 0 on all 160 records, $0.0255; records in `experiments/results/probe-selection.noescape.jsonl`). Corrected table:

| N | n | top-1 = fix (no escape) | top-1 = fix (with escape) | top-1 plausible (no escape) | top-3 (no escape) | MRR (no escape) | MRR (with escape) | P(fix) min / median / mean (no escape) | P(fix) mean (with escape) | tokens mean | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 40 | 38/40 (95%) | 36/40 (90%) | 39/40 (98%) | 40/40 (100%) | 0.975 | 0.942 | 0.09 / 0.99 / 0.92 | 0.82 | 1212 | 201 |
| 50 | 40 | 33/40 (82%) | 31/40 (78%) | 34/40 (85%) | 40/40 (100%) | 0.908 | 0.875 | 0.03 / 0.91 / 0.73 | 0.67 | 2186 | 168 |
| 150 | 40 | 31/40 (78%) | 29/40 (73%) | 33/40 (83%) | 38/40 (95%) | 0.865 | 0.838 | 0.02 / 0.80 / 0.67 | 0.57 | 4617 | 202 |
| 254 | 40 | 29/40 (72%) | 26/40 (65%) | 31/40 (78%) | 37/40 (93%) | 0.829 | 0.792 | 0.02 / 0.72 / 0.62 | 0.52 | 7149 | 206 |

Programs that flip from miss to fix when the escape is removed: N=10 topological_ordering, wrap; N=50 shortest_paths, wrap; N=150 reverse_linked_list, shunting_yard, topological_ordering (lis goes the other way); N=254 levenshtein, lis, reverse_linked_list, shortest_paths, wrap (shortest_path_length and shunting_yard go the other way). These are exactly the borderline items where `none_of_these` had been winning with P(escape) 0.3-0.5. So the escape option costs 2-3/40 top-1 (5-8 points) at every size, and the decay with N (95% -> 72% without escape, 90% -> 65% with) is intrinsic. Without the escape there is of course no "fix absent" signal at all (no-fix sets were not run in this control since a Choice without escape always picks something). Even without an escape, Choice at N=50 (33/40) stays well below batched Nouls (39/40), so the Nouls recommendation is unaffected.

The original (mislabeled) table is kept below as what it really is, a per-size repeat of the with-fix Choice condition; it gives a per-size repeat-noise estimate: top-1 36/31/29/24 vs 36/31/29/26 in `main`, mean |dP(fix)| 0.019 / 0.029 / 0.029 / 0.032, max 0.09 / 0.13 / 0.10 / 0.13, argmax flips 0 / 1 / 0 / 2 at N = 10/50/150/254.

| N | n | top-1 = fix (repeat, escape on) | top-1 = fix (main, escape on) | top-1 plausible (repeat) | top-3 (repeat) | MRR (repeat) | MRR (main) | P(fix) min / median / mean (repeat) | P(fix) mean (main) | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 40 | 36/40 (90%) | 36/40 (90%) | 37/40 (93%) | 40/40 (100%) | 0.942 | 0.942 | 0.05 / 0.93 / 0.81 | 0.82 | 196 |
| 50 | 40 | 31/40 (78%) | 31/40 (78%) | 32/40 (80%) | 40/40 (100%) | 0.871 | 0.875 | 0.02 / 0.81 / 0.67 | 0.67 | 191 |
| 150 | 40 | 29/40 (73%) | 29/40 (73%) | 31/40 (78%) | 37/40 (93%) | 0.831 | 0.838 | 0.02 / 0.68 / 0.58 | 0.57 | 198 |
| 254 | 40 | 24/40 (60%) | 26/40 (65%) | 26/40 (65%) | 36/40 (90%) | 0.761 | 0.792 | 0.02 / 0.58 / 0.52 | 0.52 | 208 |


## Batched Nouls per candidate by set size: `full` (definition + examples criteria on every Noul) vs `compact` (criteria once in `state.correct_fix_criteria`, instructions-only Nouls)

| style | N | n | top-1 = fix | top-1 plausible | top-3 | MRR | P(fix) min / median / mean | P(fix) >= 0.5 | no-fix: max Noul median / mean | no-fix: sets with max >= 0.5 | no-fix: top-1 plausible | tokens mean | cost / request | latency p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | 10 | 40 | 39/40 (98%) | 40/40 (100%) | 40/40 (100%) | 0.988 | 0.31 / 0.82 / 0.77 | 37 | 0.12 / 0.15 | 1 | 1/40 (3%) | 3134 | $0.00013 | 209 | 358 |
| full | 50 | 40 | 39/40 (98%) | 40/40 (100%) | 40/40 (100%) | 0.988 | 0.20 / 0.79 / 0.70 | 30 | 0.22 / 0.31 | 9 | 4/40 (10%) | 12040 | $0.00051 | 257 | 456 |
| full | 150 | 40 | 35/40 (88%) | 38/40 (95%) | 39/40 (98%) | 0.927 | 0.14 / 0.75 / 0.68 | 32 | 0.48 / 0.46 | 17 | 9/40 (23%) | 34300 | $0.0014 | 374 | 539 |
| full | 254 | 40 | 31/40 (78%) | 34/40 (85%) | 39/40 (98%) | 0.860 | 0.15 / 0.77 / 0.65 | 30 | 0.47 / 0.48 | 17 | 8/40 (20%) | 57482 | $0.0024 | 547 | 785 |
| compact | 10 | 40 | 39/40 (98%) | 40/40 (100%) | 40/40 (100%) | 0.988 | 0.28 / 0.77 / 0.73 | 34 | 0.12 / 0.15 | 2 | 1/40 (3%) | 1750 | $0.00007 | 210 | 327 |
| compact | 50 | 40 | 37/40 (93%) | 38/40 (95%) | 40/40 (100%) | 0.958 | 0.17 / 0.68 / 0.63 | 29 | 0.23 / 0.30 | 8 | 3/40 (8%) | 4456 | $0.00019 | 207 | 307 |
| compact | 150 | 40 | 32/40 (80%) | 34/40 (85%) | 38/40 (95%) | 0.878 | 0.11 / 0.67 / 0.63 | 31 | 0.42 / 0.41 | 13 | 9/40 (23%) | 11216 | $0.00047 | 256 | 354 |
| compact | 254 | 40 | 32/40 (80%) | 35/40 (88%) | 36/40 (90%) | 0.863 | 0.08 / 0.68 / 0.59 | 25 | 0.43 / 0.43 | 17 | 9/40 (23%) | 18278 | $0.00077 | 331 | 539 |

| style | rule (flag "fix absent") | no-fix sets flagged | with-fix sets flagged (false alarm) | top-1 = fix among un-flagged with-fix sets | AUROC |
| --- | --- | --- | --- | --- | --- |
| full | max Noul < 0.3 | 85/160 (53%) | 13/160 (8%) | 135/147 (92%) | 0.856 |
| full | max Noul < 0.4 | 100/160 (63%) | 24/160 (15%) | 125/136 (92%) | 0.856 |
| full | max Noul < 0.5 | 116/160 (73%) | 28/160 (18%) | 122/132 (92%) | 0.856 |
| full | max Noul < 0.6 | 127/160 (79%) | 40/160 (25%) | 111/120 (93%) | 0.856 |
| full | best: max Noul <= 0.60 | 0.81 | 0.25 | - | 0.856 |
| compact | max Noul < 0.3 | 88/160 (55%) | 12/160 (8%) | 133/148 (90%) | 0.859 |
| compact | max Noul < 0.4 | 105/160 (66%) | 23/160 (14%) | 123/137 (90%) | 0.859 |
| compact | max Noul < 0.5 | 120/160 (75%) | 33/160 (21%) | 115/127 (91%) | 0.859 |
| compact | max Noul < 0.6 | 136/160 (85%) | 49/160 (31%) | 101/111 (91%) | 0.859 |
| compact | best: max Noul <= 0.46 | 0.75 | 0.17 | - | 0.859 |

Noul repeat noise (same 50-candidate request twice, fix present, n = 40): mean |dP(fix)| 0.036, max 0.19, argmax flips 2/40.

## Choice vs batched Nouls per candidate, 50 candidates

| method | n | top-1 = fix | top-1 plausible | top-3 | MRR | P(fix) min / median / mean | P(fix) >= 0.5 | tokens mean | cost / request | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Choice (50 + escape), fix present | 40 | 31/40 (78%) | 32/40 (80%) | 40/40 (100%) | 0.875 | 0.02 / 0.82 / 0.67 | 28 | 2233 | $0.00009 | 207 |
| Nouls (50 in one request), fix present | 40 | 39/40 (98%) | 40/40 (100%) | 40/40 (100%) | 0.988 | 0.20 / 0.79 / 0.70 | 30 | 12040 | $0.00051 | 257 |

| Nouls, 50 candidates | n | max Noul min / median / mean / max | sets with max >= 0.5 | sets with max >= 0.3 | mean #candidates >= 0.5 (of top 5) | top-1 plausible |
| --- | --- | --- | --- | --- | --- | --- |
| fix present | 40 | 0.20 / 0.79 / 0.70 / 0.96 | 31 | 36 | 0.93 | 40/40 (100%) |
| fix absent | 40 | 0.06 / 0.22 / 0.31 / 0.90 | 9 | 17 | 0.30 | 4/40 (10%) |

Noul detector "fix absent when max Noul <= 0.60": detection 0.88, false alarm 0.28, balanced accuracy 0.80, AUROC 0.875.

Programs where Choice and Nouls disagree on top-1 (fix present): lcs_length (Nouls fix), minimum_spanning_tree (Nouls fix), next_palindrome (Nouls fix), shortest_paths (Nouls fix), sieve (Nouls fix), sqrt (Nouls fix), topological_ordering (Nouls fix), wrap (Nouls fix).

## Option order: original vs reversed vs seeded shuffle (Choice, 50 + escape, fix present, 10 programs)

| program | top-1 (original / reversed / shuffled) | same pick | P(fix) original / reversed / shuffled | max |dP(fix)| | fix key (position) per order |
| --- | --- | --- | --- | --- | --- |
| depth_first_search | fix / fix / fix | same | 0.93 / 0.96 / 0.89 | 0.07 | cand_ag / cand_br / cand_au |
| find_first_in_sorted | fix / fix / fix | same | 0.83 / 0.51 / 0.54 | 0.32 | cand_am / cand_bl / cand_br |
| detect_cycle | escape / fix / fix | DIFFERENT | 0.29 / 0.62 / 0.59 | 0.33 | cand_bm / cand_al / cand_bb |
| breadth_first_search | fix / fix / fix | same | 0.99 / 0.99 / 0.99 | 0.00 | cand_ao / cand_bj / cand_br |
| bucketsort | fix / fix / fix | same | 0.98 / 0.96 / 0.98 | 0.02 | cand_av / cand_bc / cand_as |
| bitcount | fix / fix / fix | same | 0.93 / 0.89 / 0.86 | 0.07 | cand_am / cand_bl / cand_ak |
| find_in_sorted | fix / fix / fix | same | 0.90 / 0.94 / 0.94 | 0.04 | cand_aq / cand_bh / cand_br |
| gcd | fix / fix / fix | same | 0.90 / 0.88 / 0.83 | 0.07 | cand_aj / cand_bo / cand_bp |
| get_factors | fix / fix / fix | same | 0.87 / 0.95 / 0.86 | 0.09 | cand_bx / cand_aa / cand_bw |
| flatten | fix / fix / fix | same | 0.99 / 0.97 / 0.98 | 0.02 | cand_am / cand_bl / cand_bl |

Argmax changed with order on 1/10 programs; largest P(fix) spread 0.33.

## Repeat noise (same request twice, Choice 50 + escape, fix present)

n = 40 programs: mean |dP(fix)| 0.032, max 0.18, argmax flips 1/40.

## Per-program rows (variant `desc`): P(fix) and rank per set size with the fix present; P(escape) with the fix absent

| program | kind | fix generated | fix, N=10 | fix, N=50 | fix, N=150 | fix, N=254 | no fix, N=10: P(esc) | no fix, N=50: P(esc) | no fix, N=150: P(esc) | no fix, N=254: P(esc) | Nouls N=50: P(fix), rank, max | Nouls N=254: P(fix), rank, max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | replace | first | 0.99 r1 | 0.96 r1 | 0.85 r1 | 0.97 r1 | 0.87 | 0.71 | 0.68 | 0.86 | 0.95 r1 max 0.95 | 0.94 r1 max 0.94 |
| breadth_first_search | replace | first | 0.99 r1 | 0.99 r1 | 0.92 r1 | 0.93 r1 | 0.99 | 0.98 | 0.30 plaus | 0.19 plaus | 0.92 r1 max 0.92 | 0.96 r1 max 0.96 |
| bucketsort | replace | first | 0.98 r1 | 0.99 r1 | 0.92 r1 | 0.79 r1 | 1.00 | 0.86 | 0.67 | 0.74 | 0.90 r1 max 0.90 | 0.80 r1 max 0.80 |
| depth_first_search | insert | first | 0.95 r1 | 0.93 r1 | 0.74 r1 | 0.77 r1 | 0.98 | 0.98 | 0.77 | 0.79 | 0.84 r1 max 0.84 | 0.77 r1 max 0.77 |
| detect_cycle | replace | first | 0.77 r1 | 0.34 r1 | 0.53 r1 | 0.55 r1 | 0.74 | 0.35 | 0.50 | 0.43 | 0.78 r1 max 0.78 | 0.84 r1 max 0.84 |
| find_first_in_sorted | replace | first | 0.86 r1 | 0.80 r1 | 0.60 r1 | 0.51 r1 | 0.98 | 0.97 | 0.75 | 0.67 | 0.59 r1 max 0.59 | 0.56 r2 max 0.56 |
| find_in_sorted | replace | first | 0.97 r1 | 0.91 r1 | 0.90 r1 | 0.89 r1 | 0.97 | 0.87 | 0.83 | 0.31 (0.51) | 0.94 r1 max 0.94 | 0.74 r1 max 0.74 |
| flatten | replace | first | 0.98 r1 | 0.98 r1 | 0.97 r1 | 0.84 r1 | 1.00 | 0.82 | 0.93 | 0.92 | 0.96 r1 max 0.96 | 0.95 r1 max 0.95 |
| gcd | replace | first | 0.98 r1 | 0.85 r1 | 0.94 r1 | 0.55 r1 | 0.73 | 0.49 | 0.58 | 0.73 | 0.87 r1 max 0.87 | 0.79 r1 max 0.79 |
| get_factors | replace | first | 0.98 r1 | 0.88 r1 | 0.80 r1 | 0.80 r1 | 1.00 | 0.79 | 0.57 | 0.60 | 0.75 r1 max 0.75 | 0.78 r1 max 0.78 |
| hanoi | replace | first | 0.89 r1 | 0.69 r1 | 0.67 r1 | 0.68 r1 | 0.93 | 0.80 | 0.83 | 0.83 | 0.80 r1 max 0.80 | 0.80 r1 max 0.80 |
| is_valid_parenthesization | replace | first | 0.99 r1 | 0.96 r1 | 0.98 r1 | 0.99 r1 | 0.91 | 0.21 plaus | 0.16 plaus | 0.23 plaus | 0.95 r1 max 0.95 | 0.93 r1 max 0.93 |
| kheapsort | replace | first | 0.95 r1 | 0.84 r1 | 0.61 r1 | 0.59 r1 | 0.89 | 0.60 | 0.61 | 0.72 | 0.69 r1 max 0.69 | 0.62 r1 max 0.62 |
| knapsack | replace | first | 0.96 r1 | 0.86 r1 | 0.83 r1 | 0.82 r1 | 0.91 | 0.73 | 0.74 | 0.84 | 0.85 r1 max 0.85 | 0.88 r1 max 0.88 |
| kth | replace | first | 0.96 r1 | 0.82 r1 | 0.75 r1 | 0.56 r1 | 0.91 | 0.82 | 0.30 (0.60) | 0.38 | 0.39 r1 max 0.39 | 0.51 r2 max 0.63 |
| lcs_length | replace | first | 0.68 r1 | 0.22 r2 ESC | 0.07 r3 ESC | 0.09 r4 ESC | 0.81 | 0.73 | 0.81 | 0.62 | 0.46 r1 max 0.46 | 0.37 r3 max 0.48 |
| levenshtein | replace | first | 0.97 r1 | 0.95 r1 | 0.70 r1 | 0.28 r2 X | 0.89 | 0.86 | 0.23 plaus | 0.20 (0.50) | 0.84 r1 max 0.84 | 0.84 r1 max 0.84 |
| lis | replace | first | 0.84 r1 | 0.68 r1 | 0.41 r1 | 0.36 r2 ESC | 0.68 | 0.46 | 0.51 | 0.67 | 0.62 r1 max 0.62 | 0.64 r1 max 0.64 |
| longest_common_subsequence | replace | first | 0.96 r1 | 0.83 r1 | 0.80 r1 | 0.78 r1 | 0.86 | 0.64 | 0.73 | 0.78 | 0.83 r1 max 0.83 | 0.82 r1 max 0.82 |
| max_sublist_sum | replace | first | 0.95 r1 | 0.90 r1 | 0.13 r2 plaus | 0.31 r2 plaus | 0.97 | 0.52 | 0.04 plaus | 0.07 plaus | 0.94 r1 max 0.94 | 0.90 r1 max 0.90 |
| mergesort | replace | second | 0.96 r1 | 0.76 r1 | 0.57 r1 | 0.41 r1 | 0.74 | 0.19 (0.60) | 0.23 (0.40) | 0.36 | 0.79 r1 max 0.79 | 0.72 r1 max 0.72 |
| minimum_spanning_tree | replace | first | 0.74 r1 | 0.18 r2 ESC | 0.10 r3 ESC | 0.16 r2 ESC | 0.94 | 0.59 | 0.60 | 0.71 | 0.29 r1 max 0.29 | 0.17 r3 max 0.24 |
| next_palindrome | replace | first | 0.15 r3 X | 0.11 r3 X | 0.03 r4 ESC | 0.03 r3 ESC | 0.63 | 0.38 (0.55) | 0.48 | 0.72 | 0.31 r1 max 0.31 | 0.22 r2 max 0.24 |
| next_permutation | replace | first | 0.06 r3 plaus | 0.02 r3 plaus | 0.01 r4 plaus | 0.02 r4 plaus | 0.13 plaus | 0.29 plaus | 0.17 plaus | 0.25 plaus | 0.47 r2 max 0.79 | 0.26 r3 max 0.85 |
| pascal | replace | first | 0.93 r1 | 0.93 r1 | 0.89 r1 | 0.77 r1 | 0.97 | 0.85 | 0.75 | 0.86 | 0.71 r1 max 0.71 | 0.79 r1 max 0.79 |
| possible_change | replace | first | 0.85 r1 | 0.65 r1 | 0.40 r1 | 0.37 r1 | 0.60 | 0.22 (0.32) | 0.16 plaus | 0.16 plaus | 0.62 r1 max 0.62 | 0.60 r2 max 0.71 |
| powerset | replace | first | 0.99 r1 | 0.86 r1 | 0.78 r1 | 0.81 r1 | 0.92 | 0.55 | 0.50 | 0.26 (0.46) | 0.92 r1 max 0.92 | 0.86 r1 max 0.86 |
| quicksort | replace | first | 0.71 r1 | 0.43 r1 | 0.30 r2 X | 0.21 r3 X | 0.56 | 0.33 (0.54) | 0.28 (0.51) | 0.29 (0.43) | 0.76 r1 max 0.76 | 0.54 r1 max 0.54 |
| reverse_linked_list | insert | first | 0.62 r1 | 0.60 r1 | 0.24 r2 ESC | 0.40 r2 ESC | 1.00 | 0.95 | 0.94 | 0.84 | 0.80 r1 max 0.80 | 0.59 r1 max 0.59 |
| rpn_eval | replace | first | 0.93 r1 | 0.92 r1 | 0.78 r1 | 0.80 r1 | 0.96 | 0.87 | 0.89 | 0.83 | 0.84 r1 max 0.84 | 0.79 r1 max 0.79 |
| shortest_path_length | replace | first | 0.89 r1 | 0.77 r1 | 0.61 r1 | 0.43 r1 | 0.58 | 0.31 (0.55) | 0.53 | 0.53 | 0.81 r1 max 0.81 | 0.83 r1 max 0.83 |
| shortest_path_lengths | replace | first | 0.96 r1 | 0.84 r1 | 0.76 r1 | 0.71 r1 | 0.95 | 0.69 | 0.55 | 0.78 | 0.90 r1 max 0.90 | 0.83 r1 max 0.83 |
| shortest_paths | replace | second | 0.87 r1 | 0.43 r2 ESC | 0.70 r1 | 0.46 r2 ESC | 0.93 | 0.91 | 0.88 | 0.91 | 0.24 r1 max 0.24 | 0.28 r1 max 0.28 |
| shunting_yard | insert | first | 0.76 r1 | 0.53 r1 | 0.40 r2 ESC | 0.41 r1 | 0.99 | 0.96 | 0.96 | 0.54 | 0.39 r1 max 0.39 | 0.33 r1 max 0.33 |
| sieve | replace | first | 0.66 r1 | 0.21 r3 ESC | 0.34 r1 | 0.05 r5 X | 0.98 | 0.67 | 0.28 (0.31) | 0.26 (0.31) | 0.57 r1 max 0.57 | 0.53 r3 max 0.75 |
| sqrt | replace | first | 0.47 r1 | 0.21 r2 ESC | 0.14 r2 ESC | 0.15 r2 ESC | 0.53 | 0.43 | 0.46 | 0.61 | 0.20 r1 max 0.20 | 0.15 r12 max 0.34 |
| subsequences | replace | first | 0.90 r1 | 0.48 r1 | 0.84 r1 | 0.44 r1 | 0.77 | 0.56 | 0.55 | 0.69 | 0.76 r1 max 0.76 | 0.49 r1 max 0.49 |
| to_base | replace | first | 0.98 r1 | 0.95 r1 | 0.60 r1 | 0.82 r1 | 0.99 | 0.97 | 0.98 | 0.96 | 0.93 r1 max 0.93 | 0.90 r1 max 0.90 |
| topological_ordering | replace | first | 0.42 r2 ESC | 0.25 r2 ESC | 0.31 r2 ESC | 0.05 r3 ESC | 0.80 | 0.52 | 0.74 | 0.63 | 0.26 r1 max 0.26 | 0.18 r1 max 0.18 |
| wrap | insert | first | 0.26 r2 ESC | 0.27 r2 ESC | 0.08 r3 ESC | 0.22 r2 ESC | 0.96 | 0.82 | 0.54 | 0.54 | 0.36 r1 max 0.36 | 0.35 r1 max 0.35 |

Cell legend: with fix, `P(fix) r<rank>` and a flag when top-1 is not the fix (`ESC` escape won, `plaus` a different candidate that passes every test won, `X` a wrong candidate won). Without fix, `P(escape)` and, when escape did not win, the winning probability in parentheses (`plaus` = the set accidentally contained another correct fix and Jev picked it).

## Two-stage: batched Nouls over 254, then Choice (+ escape) over the five highest Nouls

| condition | n | fix in shortlist | top-1 = fix | top-1 plausible | escape wins | P(fix) median (when shortlisted) | cost / request | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fix present | 40 | 39/40 | 33/40 (83%) | 36/40 (90%) | 1 | 0.93 | $0.00005 | 167 |
| fix absent | 40 | - | - | 7/40 (18%) (accidental fix in shortlist) | 26 (65%) | - | $0.00005 | 173 |

Against the same 254-candidate sets: flat Nouls top-1 31/40, flat Choice 26/40, two-stage 33/40. Misses after the second stage: lcs_length, max_sublist_sum (plausible alternative), next_permutation (plausible alternative), possible_change (plausible alternative), sieve, wrap, sqrt (not shortlisted).

## What this means for the design

1. **Rank candidates with batched Nouls, not a flat Choice, once there are more than about 10 of them.** Choice top-1 falls 90% -> 65% from 10 to 254 candidates (95% -> 72% without an escape option, so the fall is intrinsic; **[corrected]** the escape itself costs a further 2-3/40 at every size, see the Control section). One request with one Noul per candidate holds 98% top-1 to 50 candidates and 78-88% at 150-254, with top-3 at 98%, because each Noul is an absolute judgment ("does this line make the tests pass") rather than a relative one over hundreds of near-duplicate lines. The whole 254-Noul request is one call, 0.55 s, $0.0024 (compact form: 0.33 s, $0.0008, same top-1 at 254, 2-5 points lower at 50-150).
2. **Use the tests as the oracle on the Noul top-k, and expect about three test runs per fix.** Top-3 by Nouls contains the gold fix on 39/40 programs at every size, and the top-1 that is not the gold line is often another correct fix (top-1 plausible 85-100%). The repair loop is: enumerate (code) -> compile-filter (code) -> Nouls over up to 254 (one Jev call) -> run tests on the top 3 in order -> stop at the first pass. **[Corrected in verification]** On QuixBugs that projects to roughly 34-36/40 repaired with the current operator library and a single 254-candidate pool (not 36-38 as first written): the gold fix was always injected here, but in an end-to-end run it must fall inside the 254-pool, which is guaranteed for only 33 programs (first-order compilable mutants <= 253); for depth_first_search, shunting_yard, wrap, reverse_linked_list and shortest_path_length (382-642 first-order candidates) the chance is 0.40-0.91, and for mergesort and shortest_paths (second-order fixes) it is ~0 unless second-order mutants are scored. Expected value with the observed Nouls-254 top-3 hits is ~35.4. Scoring the whole first-order pool in parallel 50-Noul batches would restore 38/40 coverage but that accuracy is unmeasured. Cost stays under $0.01 and a few seconds per program, against the brief's >= 60% target (docs/JEV-ONLY.md).
3. **A second Jev stage buys a little: Nouls (254) -> Choice over the Noul top-5 lifts top-1 from 31 to 33/40** at one extra $0.0001 request, and its escape option is a usable second-stage "none of the shortlisted" signal (escape wins 26/40 when the fix is absent, and 7 of the remaining 14 shortlists contained a different correct fix). Prefer spending the same 0.2 s on a test run of the next candidate unless tests are slow.
4. **"Fix not in set" is detectable but not sharp; treat it as a routing signal, not a verdict.** Best single-request rules: Choice `P(escape) - p_max >= 0.10` (82% detection, 13% false alarm, AUROC 0.92; detection 98% at N = 10 falling to 73% at 254) and Nouls `max Noul < 0.5` (71-75% detection, 16-21% false alarm). Do not threshold `P(escape)` at 0.5 alone at large N (77% / 9%); `P(escape) >= 0.7` is almost never a false alarm (1%) but only catches half. Since a false alarm costs one wasted round of "widen the candidate source" and a miss costs three failed test runs, bias toward flagging; both are cheap. Note that at N >= 150 the label itself is noisy: 13-23% of sets built without the gold line still held another correct fix.
5. **Keep the set small when you can.** Every method loses accuracy and P(fix) with N (Choice P(fix) median 0.93 -> 0.55; Nouls 0.82 -> 0.77 median but MRR 0.99 -> 0.86). Localisation to one line and operator priors (the gold fix is a first-order mutant on 38/40 programs, second-order on 40/40) should be used to stay near 50 candidates; when the pool is larger, batch it as several 50-Noul requests in parallel (Jev allows 128-way concurrency) rather than one 254-Choice.
6. **Order effects are real only at ties.** Reversing or shuffling 50 options flipped the argmax on 1/10 programs (0.29 vs 0.30) and moved P(fix) by up to 0.33 where the answer was borderline, against a repeat noise of 0.03 mean; on confident items order changed nothing. When the top-2 margin is under 0.1, re-ask with a shuffled order (or fall through to the tests) instead of trusting the pick.
7. **Missing-statement bugs need their own candidate source.** The four insertion programs are the weak spot for Choice (top-1 3/4, 3/4, 1/4, 2/4 across sizes) and Nouls at 254 (wrap 0.35, shunting_yard 0.33). Donor lines plus `a.add(b)` / `a.append(b)` / `a = b` templates did generate all four gold statements, but the sets are noisier; give insertions a smaller, template-first pool.
8. **The hard programs are consistent across methods and sizes**: next_palindrome, topological_ordering, sqrt, minimum_spanning_tree, lcs_length, wrap (P(fix) <= 0.35 nearly everywhere). They share long lines with several plausible single-token variants (`- 1` placements, attribute names, `** 2`), where the three tests in the state do not discriminate visually. These are the cases for the test oracle, not for a sharper prompt; adding a fourth failing test whose expected/actual pair differs on the exact quantity the fix changes is the next thing to measure.
9. **State shape**: candidate text in the option descriptions (`desc`) and in `state.candidates` with null descriptions (`state`) are equivalent (28 vs 29/40 at N = 50; 3 programs disagree in each direction); `desc` is 8% cheaper. For Nouls the candidates must live in the state and be referenced by path (`candidates.cand_xx`), which worked at 254 entries with no sign of reference drift.

## Verification (2026-09-20)

Adversarial check of this file against `experiments/results/probe-selection.raw.jsonl` (1470 records), the scripts in `experiments/probe-select/`, `/tmp/jevonly/pools.json`, and a live re-run. Checker spend: $0.0302 (16 re-run requests $0.0047 in `probe-selection.verify.jsonl`; 160 real no-escape control requests $0.0255 in `probe-selection.noescape.jsonl`). The raw log was backed up before the runs and restored byte-identical afterwards; the two new files are separate so `report.mts` still reproduces the original tables from the 1470 records.

**Recomputed from the raw log (independent Python, not `report.mts`).** Every count in the Summary, the Choice-by-N (with and without fix), by-kind, A/B, Nouls full/compact by N, Nouls detector, two-stage, repeat-noise and order tables reproduces exactly: n = 40 per condition, top-1 36/31/29/26 (Choice), 39/39/35/31 (Nouls full), 39/37/32/32 (Nouls compact), top-3 as stated, MRR to three decimals, escape wins 39/33/30/30 on no-fix sets, tokens and cost per request, total 1470 requests / $0.6188 / p50 228 ms / p95 519 ms. Detector AUROC 0.909 / 0.914 / 0.916 with best thresholds 0.46 / 0.33 / 0.10 and 127-131/160 detection, 19-20/160 false alarms reproduce; the P(escape) operating-point table reproduces to the count. Nouls detector AUROC 0.856 / 0.859 and every threshold row reproduce. Two-stage: 39/40 shortlisted, 33/40 top-1, 36/40 plausible, escape wins 26/40 on no-fix, 7 plausible; the miss list is correct. Repeat noise 0.032 / 1 flip (Choice) and 0.036 / 2 flips (Nouls); order study 1/10 flips (detect_cycle 0.30 vs 0.29), max spread 0.33. The disagreement list Choice-vs-Nouls at N=50 (8 programs, all Nouls-fix) is correct. Spot-checked per-program cells (sqrt Nouls-254 0.15 r12 max 0.34, kth no-fix-150 0.30 (0.60), levenshtein 254 0.28 r2 X) match the raw records.

**Errors found and corrected in the text above (marked `[Corrected in verification]`).**

1. *The "Choice without escape" control was not a control.* The `noescape` phase of `run.mts` only drops the escape when `--escape off` is passed, and the logged records show it was not: all 160 have `options` = N+1, variant `desc` (the code writes `desc_noescape` when the escape is off), nonzero escape mass in 159/160 and an escape win in 27. The original table therefore compared two repeats of the same with-fix Choice condition, and the claims "removing the escape does not change Choice top-1" (Summary), "the no-escape control is identical" (design point 1) and the key-number "the escape option costs nothing" were unsupported. The checker ran the real control (160 requests, P(escape) = 0 on every record): top-1 without escape is 38/33/31/29 vs 36/31/29/26 with escape, MRR 0.975/0.908/0.865/0.829 vs 0.942/0.875/0.838/0.792, P(fix) mean +0.10. Corrected reading: the escape costs 2-3/40 top-1 at every size (it wins on borderline items where the fix would otherwise be top-1), and the decay with N is intrinsic (95% -> 72% without escape). The Nouls recommendation is unaffected (Choice 33/40 without escape at N=50 vs Nouls 39/40). The mislabeled run is retained as what it is: a per-size repeat (top-1 36/31/29/24, mean |dP| 0.019-0.032, 0-2 argmax flips per size).
2. *The end-to-end projection "36-38/40" was overreaching.* The gold fix was always injected, and the pool construction (`candidates.ts`) explicitly excludes it, so no measurement covers whether the fix lands in the 254-pool in an un-injected run. From `pools.json`: 33 programs have <= 253 first-order compilable candidates (fix guaranteed in the pool), 5 have 279-642 (P(in pool) = 254/(first-order+1) = 0.40-0.91: wrap 0.40, shunting_yard 0.62, depth_first_search 0.66, shortest_path_length 0.84, reverse_linked_list 0.91), and 2 need second-order mutants that the padded 254-pool does not reach when neighbour mutants fill it. Expected repaired with the observed Nouls-254 top-3 per program: ~35.4; corrected to "roughly 34-36/40 with a single 254-pool", with 38/40 as the coverage ceiling only if the full first-order pool is scored in parallel batches (unmeasured).
3. *Detector per-size row at N=254*: the pooled best threshold is the data value 0.0999... (rendered "0.10"); two items sit exactly on it, so a strict `>= 0.10` in code gives 28/40 detection and 6/40 false alarms rather than 29/7. Annotated in place; the pooled numbers (131/160, 20/160) are unaffected.

**Small definitional notes (not changed in the tables).** `report.mts` computes quantiles as `sorted[floor(p*n)]`, i.e. the upper median for n = 40; interpolated medians of P(fix) for Choice with fix are 0.93 / 0.81 / 0.64 / 0.53 (file: 0.93 / 0.82 / 0.67 / 0.55) and similar +0.01-0.03 shifts apply to every "median" cell. "top-3" counts the escape as an option in the ranking (rank of the fix among all N+1 options), which is the conservative reading. "top-1 plausible" on with-fix sets counts an escape win as not plausible.

**Live re-run (16 requests, 4 programs: gcd, sqrt, sieve, lcs_length; Choice N=50 with and without fix; Nouls full N=50 with and without fix).** All 16 land within the reported repeat noise of the logged records and change no verdict: Choice P(fix) 0.89 / 0.18 / 0.17 / 0.18 (logged 0.85 / 0.21 / 0.21 / 0.22), same argmax class except sieve (escape 0.38 vs a wrong candidate 0.40, fix rank 3 both times); no-fix P(escape) 0.54 / 0.35 / 0.62 / 0.84 (logged 0.49 / 0.43 / 0.67 / 0.73), escape wins all 4 both times; Nouls P(fix) 0.89 / 0.17 / 0.68 / 0.42 (logged 0.87 / 0.20 / 0.57 / 0.46), top-1 = fix in all 4 both times; no-fix max Noul 0.42 / 0.16 / 0.48 / 0.12 (logged 0.38 / 0.16 / 0.53 / 0.09).

**Script fix.** `run.mts` now forces the escape off whenever `phase === 'noescape'` (one line), so re-running the phase reproduces the corrected control rather than the mislabeled repeat; no other script was changed.

**Scripts do what the tables claim.** `candidates.ts` builds nested seeded prefixes with the fix at a seeded position and excludes the fix and the buggy line from the distractor pool via `normLine`; no formatting leak of the injected fix was found (same indentation as the buggy line, no trailing whitespace, comments or tabs, no duplicate of the fix text in any pool). `quixbugs.ts` derives the hunk from the gold diff and the oracle from the gold program's passing tests; `passesOracle` is what "plausible" means. Latency is `r.latencyMs` from the client, cost is `usage.costUsd`.

**Question shape versus REPORT rules.** Choice requests go through `choice()` from `src/jev/questions.ts`, which enforces snake_case keys without name priors and a guaranteed `none_of_these` escape with a description; the full Nouls carry definition + examples on both `true` and `false`; nothing asks Jev to count or compute; content is referenced by backticked path (`candidates.cand_xx`, `buggy_line`, `tests`). Option keys `cand_aa..cand_jt` are opaque rather than descriptive (REPORT §11: opaque keys plus descriptions 0.96 vs semantic keys 0.98, so a minor cost that is unavoidable for 254 code lines). The two deliberate rule violations (Choice without escape; compact Nouls as instruction-only `contextNoul`) are labelled as controls. The `state` Choice variant (opaque keys with null descriptions, text in state) is a shape REPORT did not measure; the A/B here (29 vs 28/40) is its only evidence.

**Literature.** The file cites no external literature (no URLs), so nothing was re-fetched. Its two external claims were checked against local sources: "Jev allows 128-way concurrency" is supported by `/Users/prateekjannu/Documents/jev-research/REPORT.md` (bursts of 256 requests at 128 concurrent, 0 x HTTP 429; 166 requests/s); "the brief's >= 60% target" is `docs/JEV-ONLY.md` (QuixBugs >= 60% repaired end to end with tests as the only oracle).

**Verdict: corrected.** The measurements and their tables are sound and reproducible; one control was mis-run and its conclusion inverted (the escape does cost 2-3/40 top-1), and one projection was optimistic by about two programs. The design implications otherwise stand: batched Nouls beat a flat Choice above ~10 candidates (also against the real no-escape Choice), the Noul top-3 holds the gold fix on 39/40 at every size, and "fix not in set" is a soft routing signal.
