### Per-program rows, donor selection (rank of the true fix line / P(true); "absent" column = what won when the fix line was removed from the pool)

| program | own: n / rank / p | own+3: n / rank / p | all-254: rank / p | truth absent: winner | p(escape) absent |
|---|---|---|---|---|---|
| bitcount | 7 / 1 / 0.99 | 38 / 1 / 0.96 | 1 / 0.95 | buggy line | 0.09 |
| breadth_first_search | 15 / 1 / 1.00 | 38 / 1 / 0.98 | 1 / 1.00 | buggy line | 0.29 |
| bucketsort | 9 / 1 / 1.00 | 39 / 1 / 0.99 | 1 / 0.99 | buggy line | 0.48 |
| detect_cycle | 10 / 1 / 0.98 | 37 / 1 / 0.99 | 1 / 0.90 | buggy line | 0.06 |
| find_first_in_sorted | 13 / 1 / 0.99 | 32 / 1 / 0.98 | 1 / 0.90 | escape | 0.55 |
| find_in_sorted | 13 / 1 / 0.88 | 29 / 1 / 0.94 | 1 / 0.98 | buggy line | 0.03 |
| flatten | 8 / 1 / 1.00 | 26 / 1 / 1.00 | 1 / 0.99 | escape | 0.59 |
| gcd | 6 / 1 / 0.99 | 29 / 1 / 0.98 | 1 / 0.99 | buggy line | 0.15 |
| get_factors | 7 / 1 / 1.00 | 33 / 1 / 0.95 | 1 / 0.97 | escape | 0.49 |
| hanoi | 9 / 1 / 0.93 | 40 / 1 / 0.98 | 1 / 0.99 | escape | 0.83 |
| is_valid_parenthesization | 11 / 1 / 0.99 | 43 / 1 / 0.99 | 1 / 1.00 | buggy line | 0.36 |
| kheapsort | 9 / 1 / 0.98 | 42 / 1 / 0.93 | 1 / 0.93 | buggy line | 0.09 |
| knapsack | 14 / 1 / 0.99 | 43 / 1 / 0.99 | 1 / 0.99 | buggy line | 0.12 |
| kth | 13 / 1 / 0.99 | 41 / 1 / 0.98 | 1 / 0.97 | escape | 0.53 |
| lcs_length | 9 / 1 / 0.61 | 39 / 1 / 0.49 | 1 / 0.77 | escape | 0.80 |
| levenshtein | 12 / 1 / 0.98 | 38 / 1 / 0.67 | 1 / 0.94 | other: `levenshtein(source[1:], target[1:]),` | 0.39 |
| lis | 11 / 1 / 0.91 | 48 / 1 / 0.76 | 1 / 0.65 | buggy line | 0.10 |
| longest_common_subsequence | 12 / 1 / 0.99 | 49 / 1 / 0.96 | 1 / 0.99 | buggy line | 0.20 |
| max_sublist_sum | 8 / 1 / 0.95 | 53 / 1 / 0.92 | 1 / 0.87 | buggy line | 0.05 |
| mergesort | 21 / 1 / 0.88 | 55 / 1 / 0.86 | 1 / 0.70 | buggy line | 0.19 |
| minimum_spanning_tree | 12 / 1 / 0.98 | 46 / 1 / 0.97 | 1 / 0.96 | buggy line | 0.14 |
| next_palindrome | 16 / 1 / 0.44 | 42 / 3 / 0.10 | 3 / 0.20 | buggy line | 0.27 |
| next_permutation | 10 / 1 / 0.90 | 34 / 1 / 0.75 | 1 / 0.57 | buggy line | 0.40 |
| pascal | 11 / 1 / 0.96 | 32 / 2 / 0.48 | 1 / 0.86 | buggy line | 0.02 |
| possible_change | 8 / 2 / 0.42 | 29 / 1 / 0.65 | 1 / 0.76 | buggy line | 0.01 |
| powerset | 8 / 1 / 0.98 | 40 / 1 / 1.00 | 1 / 0.98 | buggy line | 0.39 |
| quicksort | 8 / 1 / 0.98 | 67 / 1 / 0.89 | 1 / 0.73 | buggy line | 0.04 |
| rpn_eval | 20 / 1 / 0.55 | 76 / 1 / 0.86 | 2 / 0.30 | buggy line | 0.04 |
| shortest_path_length | 35 / 1 / 0.96 | 74 / 1 / 0.90 | 1 / 0.93 | buggy line | 0.22 |
| shortest_path_lengths | 14 / 1 / 1.00 | 47 / 1 / 0.98 | 1 / 1.00 | escape | 0.61 |
| shortest_paths | 13 / 1 / 0.99 | 40 / 1 / 0.99 | 1 / 0.96 | escape | 0.64 |
| sieve | 7 / 1 / 0.99 | 30 / 1 / 0.94 | 1 / 0.89 | buggy line | 0.03 |
| sqrt | 6 / 1 / 0.99 | 31 / 2 / 0.25 | 2 / 0.27 | buggy line | 0.07 |
| subsequences | 10 / 1 / 0.68 | 35 / 1 / 0.72 | 2 / 0.40 | buggy line | 0.10 |
| to_base | 10 / 1 / 0.95 | 32 / 1 / 0.92 | 1 / 0.91 | buggy line | 0.11 |
| topological_ordering | 8 / 1 / 0.95 | 37 / 1 / 0.79 | 1 / 0.83 | escape | 0.56 |

### Per-program rows, identifier adaptation (holes = identifier positions in the fix line; "changed" = identifier absent from the buggy line)

| program | holes (changed) | in-scope options | with buggy line: top-1 all / changed | hole only: top-1 all / changed | misses (variant: template -> picked) |
|---|---|---|---|---|---|
| bitcount | 2 (0) | 26 | 2/2 / 0/0 | 2/2 / 0/0 |  |
| breadth_first_search | 1 (1) | 30 | 1/1 / 1/1 | 1/1 / 1/1 |  |
| bucketsort | 4 (1) | 31 | 3/4 / 1/1 | 3/4 / 1/1 | B: `for i, count in __HOLE__(counts):` -> `counts`; H: `for i, count in __HOLE__(counts):` -> `counts` |
| detect_cycle | 4 (0) | 27 | 4/4 / 0/0 | 4/4 / 0/0 |  |
| find_first_in_sorted | 2 (0) | 29 | 2/2 / 0/0 | 2/2 / 0/0 |  |
| find_in_sorted | 3 (0) | 30 | 2/3 / 0/0 | 3/3 / 0/0 | B: `return __HOLE__(mid + 1, end)` -> `mid` |
| flatten | 1 (0) | 28 | 1/1 / 0/0 | 1/1 / 0/0 |  |
| gcd | 4 (0) | 26 | 4/4 / 0/0 | 3/4 / 0/0 | H: `return gcd(__HOLE__, a % b)` -> `a` |
| get_factors | 1 (1) | 26 | 1/1 / 1/1 | 1/1 / 1/1 |  |
| hanoi | 3 (1) | 29 | 3/3 / 1/1 | 3/3 / 1/1 |  |
| is_valid_parenthesization | 1 (1) | 27 | 1/1 / 1/1 | 1/1 / 1/1 |  |
| kheapsort | 3 (1) | 29 | 2/3 / 1/1 | 3/3 / 1/1 | B: `for __HOLE__ in arr[k:]:` -> `k` |
| knapsack | 2 (0) | 32 | 2/2 / 0/0 | 2/2 / 0/0 |  |
| kth | 4 (1) | 32 | 4/4 / 1/1 | 4/4 / 1/1 |  |
| lcs_length | 6 (0) | 30 | 6/6 / 0/0 | 6/6 / 0/0 |  |
| levenshtein | 3 (0) | 26 | 3/3 / 0/0 | 3/3 / 0/0 |  |
| lis | 4 (1) | 32 | 3/4 / 1/1 | 2/4 / 0/1 | B: `longest = max(longest, __HOLE__ + 1)` -> `longest`; H: `longest = __HOLE__(longest, length + 1` -> `length`; H: `longest = max(longest, __HOLE__ + 1)` -> `longest` |
| longest_common_subsequence | 4 (0) | 26 | 4/4 / 0/0 | 4/4 / 0/0 |  |
| max_sublist_sum | 4 (1) | 28 | 4/4 / 1/1 | 4/4 / 1/1 |  |
| mergesort | 2 (0) | 32 | 2/2 / 0/0 | 2/2 / 0/0 |  |
| minimum_spanning_tree | 4 (0) | 31 | 4/4 / 0/0 | 3/4 / 0/0 | H: `group_by_node[node] = __HOLE__[u]` -> `u` |
| next_palindrome | 2 (0) | 27 | 2/2 / 0/0 | 1/2 / 0/0 | H: `return [1] + (__HOLE__(digit_list) - 1` -> `digit_list` |
| next_permutation | 4 (0) | 28 | 4/4 / 0/0 | 2/4 / 0/0 | H: `if perm[__HOLE__] < perm[j]:` -> `j`; H: `if perm[i] < perm[__HOLE__]:` -> `perm` |
| pascal | 3 (0) | 31 | 3/3 / 0/0 | 3/3 / 0/0 |  |
| possible_change | 2 (1) | 28 | 2/2 / 1/1 | 2/2 / 1/1 |  |
| powerset | 5 (0) | 29 | 5/5 / 0/0 | 4/5 / 0/0 | H: `return rest_subsets + [[first] + subse` -> `rest_subsets` |
| quicksort | 7 (0) | 29 | 7/7 / 0/0 | 6/7 / 0/0 | H: `greater = quicksort([x for x in arr[1:` -> `pivot` |
| rpn_eval | 4 (0) | 32 | 4/4 / 0/0 | 3/4 / 0/0 | H: `op(token, __HOLE__, a)` -> `a` |
| shortest_path_length | 4 (1) | 45 | 4/4 / 1/1 | 4/4 / 1/1 |  |
| shortest_path_lengths | 6 (0) | 31 | 6/6 / 0/0 | 4/6 / 0/0 | H: `length_by_path[i, k] + length_by_path[` -> `length_by_path`; H: `length_by_path[i, k] + length_by_path[` -> `length_by_path` |
| shortest_paths | 3 (1) | 31 | 3/3 / 1/1 | 3/3 / 1/1 |  |
| sieve | 5 (1) | 27 | 5/5 / 1/1 | 3/5 / 1/1 | H: `if all(n % __HOLE__ > 0 for p in prime` -> `n`; H: `if all(n % p > 0 for __HOLE__ in prime` -> `primes` |
| sqrt | 4 (0) | 27 | 4/4 / 0/0 | 3/4 / 0/0 | H: `while __HOLE__(x - approx ** 2) > epsi` -> `x` |
| to_base | 4 (0) | 30 | 4/4 / 0/0 | 4/4 / 0/0 |  |
| topological_ordering | 5 (0) | 28 | 5/5 / 0/0 | 5/5 / 0/0 |  |

### Per-program rows, fix-kind classification (top pick and P(top); * = lenient match, X = miss)

| program | truth (acceptable) | catalogue | + missing_statement | + faulty line |
|---|---|---|---|---|
| bitcount | operator_swap | operator_swap 0.53 | operator_swap 0.48 | operator_swap 0.98 |
| breadth_first_search | missing_condition_or_guard (control_flow_change) | missing_condition_or_guard 0.97 | missing_condition_or_guard 0.98 | missing_condition_or_guard 1.00 |
| bucketsort | wrong_variable | wrong_variable 1.00 | wrong_variable 1.00 | wrong_variable 1.00 |
| depth_first_search | none_of_these | none_of_these 0.36 | missing_statement 0.95 | none_of_these 0.37 |
| detect_cycle | missing_condition_or_guard | missing_condition_or_guard 1.00 | missing_condition_or_guard 1.00 | missing_condition_or_guard 0.98 |
| find_first_in_sorted | operator_swap (off_by_one) | operator_swap 0.79 | operator_swap 0.80 | operator_swap 0.99 |
| find_in_sorted | off_by_one | off_by_one 0.47 | off_by_one 0.50 | off_by_one 0.88 |
| flatten | wrong_function_call | wrong_function_call 1.00 | wrong_function_call 0.99 | wrong_function_call 0.99 |
| gcd | argument_order | argument_order 0.93 | argument_order 0.96 | argument_order 1.00 |
| get_factors | wrong_constant | wrong_constant 0.73 | wrong_constant 0.66 | wrong_constant 0.98 |
| hanoi | wrong_variable | wrong_variable 0.44 | missing_statement 0.41 X | wrong_variable 0.96 |
| is_valid_parenthesization | missing_condition_or_guard (wrong_constant) | missing_condition_or_guard 0.92 | missing_condition_or_guard 0.84 | missing_condition_or_guard 0.95 |
| kheapsort | wrong_variable (off_by_one) | wrong_function_call 0.28 X | wrong_function_call 0.33 X | wrong_variable 0.61 |
| knapsack | operator_swap (off_by_one) | operator_swap 0.87 | operator_swap 0.87 | operator_swap 1.00 |
| kth | wrong_variable (none_of_these, off_by_one) | off_by_one 0.38 * | off_by_one 0.45 * | off_by_one 0.67 * |
| lcs_length | off_by_one (wrong_variable) | off_by_one 0.74 | off_by_one 0.74 | off_by_one 0.66 |
| levenshtein | off_by_one (wrong_constant) | wrong_constant 0.45 * | wrong_constant 0.54 * | wrong_constant 0.83 * |
| lis | wrong_function_call (missing_condition_or_guard) | missing_condition_or_guard 0.48 * | missing_condition_or_guard 0.52 * | wrong_function_call 0.92 |
| longest_common_subsequence | wrong_variable (off_by_one) | none_of_these 0.31 X | none_of_these 0.22 X | wrong_variable 0.45 |
| max_sublist_sum | wrong_function_call (missing_condition_or_guard) | none_of_these 0.42 X | missing_statement 0.34 X | wrong_function_call 0.52 |
| mergesort | operator_swap (off_by_one) | operator_swap 0.33 | operator_swap 0.31 | missing_condition_or_guard 0.25 X |
| minimum_spanning_tree | wrong_function_call (operator_swap) | wrong_variable 0.42 X | missing_statement 0.41 X | wrong_variable 0.72 X |
| next_palindrome | off_by_one | operator_swap 0.32 X | operator_swap 0.29 X | off_by_one 0.37 |
| next_permutation | argument_order (operator_swap) | operator_swap 0.97 * | operator_swap 0.95 * | operator_swap 1.00 * |
| pascal | off_by_one | off_by_one 0.84 | off_by_one 0.87 | off_by_one 0.99 |
| possible_change | missing_condition_or_guard | missing_condition_or_guard 0.83 | missing_condition_or_guard 0.82 | operator_swap 0.54 X |
| powerset | none_of_these (wrong_variable) | none_of_these 0.44 | missing_statement 0.69 X | none_of_these 0.72 |
| quicksort | operator_swap (off_by_one) | operator_swap 0.47 | operator_swap 0.42 | operator_swap 0.59 |
| reverse_linked_list | none_of_these | none_of_these 0.53 | none_of_these 0.45 * | none_of_these 0.58 |
| rpn_eval | argument_order | argument_order 0.88 | argument_order 0.85 | argument_order 0.95 |
| shortest_path_length | wrong_variable (wrong_function_call) | wrong_constant 0.37 X | wrong_constant 0.37 X | wrong_variable 0.31 |
| shortest_path_lengths | argument_order (wrong_variable) | wrong_variable 0.52 * | argument_order 0.49 | wrong_variable 0.68 * |
| shortest_paths | wrong_variable | wrong_variable 0.89 | wrong_variable 0.87 | wrong_variable 0.97 |
| shunting_yard | none_of_these | operator_swap 0.74 X | operator_swap 0.66 X | operator_swap 0.71 X |
| sieve | wrong_function_call | wrong_function_call 0.62 | wrong_function_call 0.76 | wrong_function_call 0.75 |
| sqrt | wrong_variable (none_of_these) | wrong_variable 0.63 | wrong_variable 0.66 | wrong_variable 0.90 |
| subsequences | wrong_constant | missing_condition_or_guard 0.43 X | missing_condition_or_guard 0.41 X | wrong_constant 0.93 |
| to_base | argument_order | none_of_these 0.50 X | missing_statement 0.60 X | none_of_these 0.52 X |
| topological_ordering | wrong_variable | wrong_variable 0.59 | wrong_variable 0.53 | wrong_variable 0.37 |
| wrap | none_of_these | off_by_one 0.43 X | missing_statement 0.85 | off_by_one 0.41 X |

### Confusion matrix, variant `catalogue` (rows = hand-labelled primary kind, columns = Jev top pick), n=40

| truth \ pick | op_swap | off1 | arg_ord | miss_cond | wr_var | wr_call | ctl_flow | wr_const | none | n |
|---|---|---|---|---|---|---|---|---|---|---|
| operator_swap | 5 | . | . | . | . | . | . | . | . | 5 |
| off_by_one | 1 | 3 | . | . | . | . | . | 1 | . | 5 |
| argument_order | 1 | . | 2 | . | 1 | . | . | . | 1 | 5 |
| missing_condition_or_guard | . | . | . | 4 | . | . | . | . | . | 4 |
| wrong_variable | . | 1 | . | . | 5 | 1 | . | 1 | 1 | 9 |
| wrong_function_call | . | . | . | 1 | 1 | 2 | . | . | 1 | 5 |
| wrong_constant | . | . | . | 1 | . | . | . | 1 | . | 2 |
| none_of_these | 1 | 1 | . | . | . | . | . | . | 3 | 5 |

### Confusion matrix, variant `catalogue_with_faulty_line` (rows = hand-labelled primary kind, columns = Jev top pick), n=40

| truth \ pick | op_swap | off1 | arg_ord | miss_cond | wr_var | wr_call | ctl_flow | wr_const | none | n |
|---|---|---|---|---|---|---|---|---|---|---|
| operator_swap | 4 | . | . | 1 | . | . | . | . | . | 5 |
| off_by_one | . | 4 | . | . | . | . | . | 1 | . | 5 |
| argument_order | 1 | . | 2 | . | 1 | . | . | . | 1 | 5 |
| missing_condition_or_guard | 1 | . | . | 3 | . | . | . | . | . | 4 |
| wrong_variable | . | 1 | . | . | 8 | . | . | . | . | 9 |
| wrong_function_call | . | . | . | . | 1 | 4 | . | . | . | 5 |
| wrong_constant | . | . | . | . | . | . | . | 2 | . | 2 |
| none_of_these | 1 | 1 | . | . | . | . | . | . | 3 | 5 |

### Per-item rows, insertion point / condition line

| program | question kind | variant | options | truth | rank | P(truth) | top |
|---|---|---|---|---|---|---|---|
| depth_first_search | insert | given_line | 14 | after_l8 | 1 | 0.93 | after_l8 |
| depth_first_search | insert | line_unknown | 14 | after_l8 | 1 | 0.50 | after_l8 |
| reverse_linked_list | insert | given_line | 9 | after_l5 | 1 | 0.43 | after_l5 |
| reverse_linked_list | insert | line_unknown | 9 | after_l5 | 4 | 0.09 | none_of_these |
| shunting_yard | insert | given_line | 20 | after_l15 | 1 | 0.83 | after_l15 |
| shunting_yard | insert | line_unknown | 20 | after_l15 | 1 | 0.53 | after_l15 |
| wrap | insert | given_line | 11 | after_l8 | 1 | 0.90 | after_l8 |
| wrap | insert | line_unknown | 11 | after_l8 | 2 | 0.38 | after_l9 |
| breadth_first_search | condition | given_condition | 15 | line_7 | 1 | 0.96 | line_7 |
| breadth_first_search | condition | condition_unknown | 15 | line_7 | 3 | 0.21 | line_13 |
| detect_cycle | condition | given_condition | 10 | line_4 | 1 | 0.60 | line_4 |
| detect_cycle | condition | condition_unknown | 10 | line_4 | 1 | 0.66 | line_4 |
| is_valid_parenthesization | condition | given_condition | 11 | line_10 | 1 | 0.91 | line_10 |
| is_valid_parenthesization | condition | condition_unknown | 11 | line_10 | 1 | 0.88 | line_10 |
| possible_change | condition | given_condition | 8 | line_4 | 1 | 0.37 | line_4 |
| possible_change | condition | condition_unknown | 8 | line_4 | 2 | 0.24 | line_6 |

### SWE-bench donor coverage per instance (hits / added lines; parentheses = excluding the patched file itself)

| instance | difficulty | .py files | added lines | exact | identifier-normalised | Jaccard >= 0.7 |
|---|---|---|---|---|---|---|
| sympy__sympy-12096 | <15 min fix | 1046 | 1 | 0 (0) | 0 (0) | 1 (1) |
| sympy__sympy-15345 | <15 min fix | 1221 | 3 | 0 (0) | 1 (1) | 0 (0) |
| sympy__sympy-19954 | <15 min fix | 1349 | 5 | 0 (0) | 2 (2) | 1 (1) |
| django__django-14787 | <15 min fix | 2124 | 1 | 0 (0) | 0 (0) | 1 (0) |
| django__django-15315 | <15 min fix | 2137 | 1 | 0 (0) | 1 (1) | 1 (1) |
| django__django-16100 | <15 min fix | 2153 | 10 | 8 (2) | 10 (8) | 9 (4) |
| pytest-dev__pytest-10081 | <15 min fix | 236 | 3 | 0 (0) | 0 (0) | 1 (0) |
| pytest-dev__pytest-7205 | <15 min fix | 202 | 2 | 1 (1) | 1 (1) | 1 (1) |
| pylint-dev__pylint-4970 | <15 min fix | 837 | 1 | 0 (0) | 1 (1) | 0 (0) |
| psf__requests-1142 | <15 min fix | 69 | 2 | 1 (0) | 1 (0) | 1 (0) |
| **total** | | | **29** | **10 (3)** | **17 (14)** | **16 (8)** |
| total excl. django-16100 | | | 19 | 2 (1) | 7 (6) | 7 (4) |

### SWE-bench per added line (ex / nm / jac: any file, then excluding the patched file)

| instance | added line | exact | normalised | best Jaccard | best donor file |
|---|---|---|---|---|---|
| sympy-12096 | `return Float(self._imp_(*[i.evalf(prec) for i in self.args]), prec)` | 0 / 0 | 0 / 0 | 0.70 / 0.70 | sympy/functions/elementary/piecewise.py |
| sympy-15345 | `"Max": [(lambda *x: True, "Max")],` | 0 / 0 | 0 / 0 | 0.69 / 0.57 | sympy/printing/mathematica.py |
| sympy-15345 | `"Min": [(lambda *x: True, "Min")],` | 0 / 0 | 0 / 0 | 0.69 / 0.57 | sympy/printing/mathematica.py |
| sympy-15345 | `_print_MinMaxBase = _print_Function` | 0 / 0 | 1 / 1 | 0.50 / 0.50 | sympy/printing/codeprinter.py |
| sympy-19954 | `blocks_remove_mask = [False] * len(blocks)` | 0 / 0 | 1 / 1 | 0.67 / 0.67 | sympy/simplify/simplify.py |
| sympy-19954 | `blocks_remove_mask[i] = True` | 0 / 0 | 1 / 1 | 0.71 / 0.71 | sympy/matrices/determinant.py |
| sympy-19954 | `blocks = [b for i, b in enumerate(blocks) if not blocks_remove_mask[i]]` | 0 / 0 | 0 / 0 | 0.67 / 0.67 | sympy/solvers/ode/systems.py |
| sympy-19954 | `num_blocks = [n for i, n in enumerate(num_blocks) if not blocks_remove_mask[i]]` | 0 / 0 | 0 / 0 | 0.67 / 0.67 | sympy/solvers/ode/systems.py |
| sympy-19954 | `rep_blocks = [r for i, r in enumerate(rep_blocks) if not blocks_remove_mask[i]]` | 0 / 0 | 0 / 0 | 0.67 / 0.67 | sympy/solvers/ode/systems.py |
| django-14787 | `bound_method = wraps(method)(partial(method.__get__(self, type(self))))` | 0 / 0 | 0 / 0 | 0.92 / 0.47 | django/utils/decorators.py |
| django-15315 | `return hash(self.creation_counter)` | 0 / 0 | 1 / 1 | 0.75 / 0.75 | django/forms/models.py |
| django-16100 | `with transaction.atomic(using=router.db_for_write(self.model)):` | 1 / 1 | 1 / 1 | 1.00 / 1.00 | django/contrib/auth/admin.py |
| django-16100 | `for form in formset.forms:` | 1 / 1 | 1 / 1 | 1.00 / 1.00 | tests/model_formsets_regress/tests.py |
| django-16100 | `if form.has_changed():` | 1 / 0 | 1 / 1 | 1.00 / 0.88 | django/contrib/admin/options.py |
| django-16100 | `obj = self.save_form(request, form, change=True)` | 1 / 0 | 1 / 1 | 1.00 / 0.67 | django/contrib/admin/options.py |
| django-16100 | `self.save_model(request, obj, form, change=True)` | 1 / 0 | 1 / 0 | 1.00 / 0.79 | django/contrib/admin/options.py |
| django-16100 | `self.save_related(request, form, formsets=[], change=True)` | 1 / 0 | 1 / 0 | 1.00 / 0.60 | django/contrib/admin/options.py |
| django-16100 | `change_msg = self.construct_change_message(` | 0 / 0 | 1 / 1 | 0.71 / 0.57 | django/contrib/admin/options.py |
| django-16100 | `request, form, None` | 0 / 0 | 1 / 1 | 0.60 / 0.60 | django/utils/log.py |
| django-16100 | `self.log_change(request, obj, change_msg)` | 1 / 0 | 1 / 1 | 1.00 / 0.64 | django/contrib/admin/options.py |
| django-16100 | `changecount += 1` | 1 / 0 | 1 / 1 | 1.00 / 0.50 | django/contrib/admin/options.py |
| pytest-10081 | `assert isinstance(self.parent, UnitTestCase)` | 0 / 0 | 0 / 0 | 0.60 / 0.60 | testing/python/fixtures.py |
| pytest-10081 | `skipped = _is_skipped(self.obj) or _is_skipped(self.parent.obj)` | 0 / 0 | 0 / 0 | 0.58 / 0.50 | src/_pytest/unittest.py |
| pytest-10081 | `if self.config.getoption("usepdb") and not skipped:` | 0 / 0 | 0 / 0 | 0.79 / 0.61 | src/_pytest/unittest.py |
| pytest-7205 | `from _pytest._io.saferepr import saferepr` | 1 / 1 | 1 / 1 | 1.00 / 1.00 | testing/io/test_saferepr.py |
| pytest-7205 | `tw.write("[{}]".format(saferepr(fixturedef.cached_param, maxsize=42)))` | 0 / 0 | 0 / 0 | 0.64 / 0.42 | src/_pytest/setuponly.py |
| pylint-4970 | `if self.min_lines == 0:` | 0 / 0 | 1 / 1 | 0.56 / 0.56 | pylint/checkers/logging.py |
| requests-1142 | `elif self.method not in ('GET', 'HEAD'):` | 0 / 0 | 0 / 0 | 0.43 / 0.43 | requests/models.py |
| requests-1142 | `self.headers['Content-Length'] = '0'` | 1 / 0 | 1 / 0 | 1.00 / 0.60 | requests/models.py |

### QuixBugs fix-line donor coverage, code only (n=40)

| criterion | same program (minus the buggy line) | other 39 programs |
|---|---|---|
| exact | 0/40 | 1/40 |
| identifier-normalised | 4/40 | 8/40 |
| token-set Jaccard >= 0.7 | 8/40 | 5/40 |
| any of the above (either source) | 16/40 | |
| fix has the same normalised shape as the buggy line (identifier substitution alone reaches it) | 7/36 replace bugs | |
| Jaccard(fix, buggy line) >= 0.7 | 22/36 | |
| Jaccard(fix, buggy line) >= 0.5 | 33/36 | |
| inserted statements (4) with a normalised donor | 3/4 | 4/4 |
