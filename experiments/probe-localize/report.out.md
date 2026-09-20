## QUIXBUGS SUMMARY (run 1)

| Variant (run 1) | n | top-1 | top-3 | MRR | cost | Jev p50 | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A choice_3tests | 40 | 23/40 (58 %) | 33/40 (82 %) | 0.710 | $0.0018 | 189 ms | 42,169 |
| B choice_0tests | 40 | 22/40 (55 %) | 30/40 (75 %) | 0.691 | $0.0013 | 189 ms | 30,636 |
| C noul_per_line | 40 | 24/40 (60 %) | 35/40 (88 %) | 0.744 | $0.0059 | 172 ms | 139,883 |
| D choice_actual_output | 40 | 28/40 (70 %) | 36/40 (90 %) | 0.805 | $0.0020 | 176 ms | 47,890 |
| E hierarchical | 40 | 23/40 (58 %) | 33/40 (82 %) | 0.716 | $0.0004 | 227 ms | 9,293 |

## QUIXBUGS SUMMARY (pooled over 3 runs)

| Variant (3 runs pooled) | n | top-1 | top-3 | MRR | cost | Jev p50 | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A choice_3tests | 119 | 68/119 (57 %) | 98/119 (82 %) | 0.711 | $0.0053 | 198 ms | 125,359 |
| B choice_0tests | 119 | 66/119 (55 %) | 92/119 (77 %) | 0.698 | $0.0038 | 182 ms | 90,909 |
| C noul_per_line | 119 | 73/119 (61 %) | 104/119 (87 %) | 0.749 | $0.0174 | 205 ms | 415,060 |
| D choice_actual_output | 119 | 82/119 (69 %) | 106/119 (89 %) | 0.796 | $0.0060 | 183 ms | 142,442 |
| E hierarchical | 119 | 68/119 (57 %) | 97/119 (82 %) | 0.715 | $0.0012 | 190 ms | 28,379 |

## PER PROGRAM (run 1)

| Program | lines | truth (L#) | kind | A | B | C | D | E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | 6 | 5 | replace | 2 (0.16) | 2 (0.08) | **1** (0.33) | **1** (0.51) | 2 (0.16) |
| breadth_first_search | 14 | 11 | replace | 3 (0.15) | 4 (0.10) | 2 (0.62) | **1** (0.76) | 3 (0.15) |
| bucketsort | 8 | 7 | replace | **1** (0.97) | **1** (0.97) | **1** (0.90) | **1** (0.96) | **1** (0.97) |
| depth_first_search | 12 | 9/10 | insert | 7 (0.02) | 5 (0.04) | 6 (0.10) | 3 (0.14) | 7 (0.02) |
| detect_cycle | 9 | 5 | replace | 2 (0.18) | 2 (0.26) | 3 (0.15) | 2 (0.13) | 2 (0.18) |
| find_first_in_sorted | 12 | 5 | replace | **1** (0.80) | **1** (0.78) | **1** (0.83) | **1** (0.87) | **1** (0.80) |
| find_in_sorted | 12 | 9 | replace | **1** (0.49) | **1** (0.58) | **1** (0.73) | **1** (0.64) | **1** (0.49) |
| flatten | 7 | 7 | replace | **1** (1.00) | **1** (1.00) | **1** (0.97) | **1** (1.00) | **1** (1.00) |
| gcd | 5 | 5 | replace | **1** (0.69) | **1** (0.72) | **1** (0.84) | **1** (0.86) | **1** (0.69) |
| get_factors | 7 | 10 | replace | **1** (0.77) | 2 (0.23) | **1** (0.90) | **1** (0.58) | **1** (0.77) |
| hanoi | 8 | 6 | replace | **1** (0.78) | **1** (0.59) | **1** (0.77) | **1** (0.90) | **1** (0.78) |
| is_valid_parenthesization | 10 | 12 | replace | **1** (0.87) | **1** (0.44) | **1** (0.88) | **1** (0.96) | **1** (0.87) |
| kheapsort | 8 | 7 | replace | 2 (0.29) | **1** (0.35) | 2 (0.51) | **1** (0.50) | 2 (0.29) |
| knapsack | 13 | 12 | replace | **1** (0.83) | **1** (0.83) | **1** (0.87) | **1** (0.92) | **1** (0.83) |
| kth | 12 | 12 | replace | **1** (0.56) | **1** (0.47) | **1** (0.75) | **1** (0.72) | **1** (0.56) |
| lcs_length | 8 | 9 | replace | **1** (0.71) | **1** (0.64) | **1** (0.67) | **1** (0.73) | **1** (0.71) |
| levenshtein | 11 | 6 | replace | **1** (0.69) | **1** (0.55) | **1** (0.90) | **1** (0.67) | **1** (0.69) |
| lis | 10 | 14 | replace | 4 (0.06) | 4 (0.04) | 3 (0.21) | 3 (0.06) | 4 (0.06) |
| longest_common_subsequence | 11 | 6 | replace | 2 (0.26) | 3 (0.18) | 2 (0.17) | 3 (0.13) | 2 (0.26) |
| max_sublist_sum | 7 | 7 | replace | **1** (0.50) | 2 (0.24) | **1** (0.47) | **1** (0.77) | **1** (0.50) |
| mergesort | 21 | 17 | replace | 16 (0.00) | 16 (0.00) | 4 (0.06) | 4 (0.08) | 16 (0.00) |
| minimum_spanning_tree | 11 | 12 | replace | **1** (0.49) | **1** (0.57) | **1** (0.70) | 2 (0.36) | **1** (0.49) |
| next_palindrome | 15 | 15 | replace | 3 (0.14) | 3 (0.15) | 2 (0.36) | **1** (0.61) | 3 (0.14) |
| next_permutation | 9 | 6 | replace | **1** (0.99) | **1** (0.96) | **1** (0.93) | **1** (0.99) | **1** (0.99) |
| pascal | 10 | 6 | replace | **1** (0.40) | 2 (0.38) | **1** (0.67) | **1** (0.59) | **1** (0.40) |
| possible_change | 7 | 5 | replace | 5 (0.01) | 5 (0.01) | 3 (0.11) | 6 (0.01) | 5 (0.01) |
| powerset | 7 | 4/5/6 | replace | **1** (0.87) | **1** (0.83) | **1** (0.77) | **1** (0.91) | **1** (0.87) |
| quicksort | 7 | 7 | replace | **1** (0.42) | **1** (0.45) | 2 (0.57) | **1** (0.49) | **1** (0.42) |
| reverse_linked_list | 7 | 5/6 | insert | 4 (0.02) | 4 (0.02) | 3 (0.08) | 4 (0.03) | 4 (0.02) |
| rpn_eval | 19 | 20 | replace | 4 (0.15) | 4 (0.17) | **1** (0.64) | **1** (0.29) | 2 (0.22) |
| shortest_path_length | 35 | 22 | replace | 3 (0.07) | 4 (0.16) | 4 (0.34) | 3 (0.14) | 7 (0.00) |
| shortest_path_lengths | 13 | 13 | replace | **1** (0.98) | **1** (0.98) | **1** (0.93) | **1** (0.97) | **1** (0.98) |
| shortest_paths | 12 | 10 | replace | **1** (0.72) | **1** (0.85) | **1** (0.81) | **1** (0.74) | **1** (0.72) |
| shunting_yard | 18 | 17/19 | insert | 16 (0.00) | 16 (0.00) | 6 (0.10) | 5 (0.03) | 4 (0.01) |
| sieve | 6 | 4 | replace | **1** (0.97) | **1** (0.97) | **1** (0.92) | **1** (0.95) | **1** (0.97) |
| sqrt | 5 | 4 | replace | **1** (0.56) | **1** (0.73) | **1** (0.58) | **1** (0.83) | **1** (0.56) |
| subsequences | 9 | 3 | replace | 3 (0.14) | 2 (0.10) | 3 (0.45) | 2 (0.11) | 3 (0.14) |
| to_base | 9 | 9 | replace | 2 (0.35) | **1** (0.43) | 2 (0.41) | **1** (0.77) | 2 (0.35) |
| topological_ordering | 7 | 6 | replace | **1** (0.80) | **1** (0.86) | **1** (0.77) | **1** (0.79) | **1** (0.80) |
| wrap | 9 | 8/10 | insert | 3 (0.05) | 5 (0.03) | 4 (0.18) | 2 (0.19) | 3 (0.05) |

## CALIBRATION choice variants A,B,D (pooled)

| P(top-1) bin (Choice A/B/D) | n | top-1 correct | accuracy | mean P |
| --- | --- | --- | --- | --- |
| [0.0, 0.3) | 11 | 2 | 0.18 | 0.24 |
| [0.3, 0.5) | 67 | 25 | 0.37 | 0.41 |
| [0.5, 0.7) | 102 | 60 | 0.59 | 0.59 |
| [0.7, 0.9) | 114 | 71 | 0.62 | 0.79 |
| [0.9, 1.0) | 63 | 58 | 0.92 | 0.96 |

Brier score of P(top-1) against top-1 correctness: 0.207 (n=357).

## CALIBRATION C (pooled)

| P(top-1) bin (Noul max-p, C) | n | top-1 correct | accuracy | mean P |
| --- | --- | --- | --- | --- |
| [0.0, 0.3) | 3 | 2 | 0.67 | 0.24 |
| [0.3, 0.5) | 9 | 5 | 0.56 | 0.41 |
| [0.5, 0.7) | 33 | 9 | 0.27 | 0.62 |
| [0.7, 0.9) | 57 | 40 | 0.70 | 0.79 |
| [0.9, 1.0) | 17 | 17 | 1.00 | 0.92 |

Brier score of P(top-1) against top-1 correctness: 0.222 (n=119).

## REPEATS

| Variant | top-1 per run | programs with same top-1 in all runs | programs correct in all runs | correct in some runs only |
| --- | --- | --- | --- | --- |
| A | 23 / 22 / 23 | 35/39 | 22 | 1 |
| B | 22 / 22 / 21 | 36/39 | 21 | 2 |
| C | 24 / 23 / 26 | 35/39 | 22 | 4 |
| D | 27 / 26 / 27 | 35/39 | 25 | 3 |
| E | 23 / 22 / 23 | 36/39 | 22 | 1 |

## SWE SUMMARY

| Variant | n | top-1 | top-5 | MRR | cost | Jev p50 | input tokens | mean candidates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Choice over candidate files | 30 | 24/30 (80 %) | 30/30 (100 %) | 0.892 | $0.0125 | 256 ms | 298,489 | 219 |
| Noul per file, 60 files | 30 | 26/30 (87 %) | 30/30 (100 %) | 0.933 | $0.0203 | 286 ms | 482,714 | 58 |

## SWE PER INSTANCE

| Instance | candidates (same-dir) | gold file(s) | Choice rank | P(top) | P(gold) | Choice top-1 | Noul-60 rank | P(gold) | files p>=0.5 | Noul top-1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | 209 (8) | models.py | 2 | 0.95 | 0.04 | `django/forms/formsets.py` | 2 | 0.43 | 1 | `django/forms/formsets.py` |
| django__django-14787 | 248 (47) | decorators.py | **1** | 0.90 | 0.90 | `django/utils/decorators.py` | **1** | 0.84 | 1 | `django/utils/decorators.py` |
| django__django-15103 | 254 (52) | defaultfilters.py, html.py | 2 | 0.82 | 0.06 | `none_of_these` | **1** | 0.75 | 1 | `django/utils/html.py` |
| django__django-15128 | 207 (6) | query.py | **1** | 1.00 | 1.00 | `django/db/models/sql/query.py` | **1** | 0.97 | 1 | `django/db/models/sql/query.py` |
| django__django-15315 | 209 (8) | __init__.py | **1** | 0.93 | 0.93 | `django/db/models/fields/__init__.py` | **1** | 0.89 | 1 | `django/db/models/fields/__init__.py` |
| django__django-15375 | 239 (38) | aggregates.py | **1** | 0.84 | 0.84 | `django/db/models/aggregates.py` | **1** | 0.76 | 1 | `django/db/models/aggregates.py` |
| django__django-15563 | 207 (5) | compiler.py, subqueries.py | 2 | 0.69 | 0.16 | `django/db/models/sql/query.py` | 2 | 0.49 | 1 | `django/db/models/sql/query.py` |
| django__django-15572 | 227 (26) | autoreload.py | **1** | 0.97 | 0.97 | `django/template/autoreload.py` | **1** | 0.67 | 1 | `django/template/autoreload.py` |
| django__django-15916 | 209 (8) | models.py | **1** | 0.98 | 0.98 | `django/forms/models.py` | **1** | 0.94 | 1 | `django/forms/models.py` |
| django__django-16100 | 229 (28) | options.py | 2 | 0.95 | 0.04 | `django/contrib/admin/views/main.py` | 2 | 0.36 | 1 | `django/contrib/admin/views/main.py` |
| psf__requests-1142 | 58 (53) | models.py | **1** | 0.84 | 0.84 | `requests/models.py` | **1** | 0.64 | 2 | `requests/models.py` |
| psf__requests-2931 | 58 (53) | models.py | **1** | 0.41 | 0.41 | `requests/models.py` | **1** | 0.72 | 2 | `requests/models.py` |
| pylint-dev__pylint-4604 | 254 (52) | variables.py, constants.py | **1** | 0.52 | 0.52 | `pylint/checkers/variables.py` | **1** | 0.85 | 1 | `pylint/checkers/variables.py` |
| pylint-dev__pylint-4970 | 227 (26) | similar.py | **1** | 0.96 | 0.96 | `pylint/checkers/similar.py` | **1** | 0.91 | 1 | `pylint/checkers/similar.py` |
| pylint-dev__pylint-6386 | 226 (22) | argument.py, arguments_manager.py, utils.py, base_options.py | **1** | 0.80 | 0.80 | `pylint/lint/base_options.py` | **1** | 0.72 | 2 | `pylint/lint/base_options.py` |
| pytest-dev__pytest-10051 | 235 (53) | logging.py | **1** | 1.00 | 1.00 | `src/_pytest/logging.py` | **1** | 0.97 | 1 | `src/_pytest/logging.py` |
| pytest-dev__pytest-10081 | 235 (53) | unittest.py | **1** | 0.80 | 0.80 | `src/_pytest/unittest.py` | **1** | 0.81 | 1 | `src/_pytest/unittest.py` |
| pytest-dev__pytest-10356 | 203 (2) | structures.py | **1** | 0.87 | 0.87 | `src/_pytest/mark/structures.py` | **1** | 0.78 | 1 | `src/_pytest/mark/structures.py` |
| pytest-dev__pytest-7205 | 206 (53) | setuponly.py | **1** | 0.99 | 0.99 | `src/_pytest/setuponly.py` | **1** | 0.95 | 1 | `src/_pytest/setuponly.py` |
| pytest-dev__pytest-7324 | 204 (3) | expression.py | **1** | 0.40 | 0.40 | `src/_pytest/mark/expression.py` | **1** | 0.80 | 1 | `src/_pytest/mark/expression.py` |
| sympy__sympy-11618 | 223 (22) | point.py | **1** | 0.99 | 0.99 | `sympy/geometry/point.py` | **1** | 0.93 | 1 | `sympy/geometry/point.py` |
| sympy__sympy-12096 | 254 (53) | function.py | **1** | 0.96 | 0.96 | `sympy/core/function.py` | **1** | 0.95 | 1 | `sympy/core/function.py` |
| sympy__sympy-12489 | 232 (31) | permutations.py | **1** | 0.99 | 0.99 | `sympy/combinatorics/permutations.py` | **1** | 0.96 | 1 | `sympy/combinatorics/permutations.py` |
| sympy__sympy-13798 | 254 (53) | latex.py | **1** | 0.97 | 0.97 | `sympy/printing/latex.py` | **1** | 0.94 | 1 | `sympy/printing/latex.py` |
| sympy__sympy-15345 | 254 (53) | mathematica.py | **1** | 0.98 | 0.98 | `sympy/printing/mathematica.py` | **1** | 0.81 | 1 | `sympy/printing/mathematica.py` |
| sympy__sympy-16792 | 247 (46) | codegen.py | **1** | 0.74 | 0.74 | `sympy/utilities/codegen.py` | **1** | 0.85 | 1 | `sympy/utilities/codegen.py` |
| sympy__sympy-17139 | 232 (31) | fu.py | **1** | 0.99 | 0.99 | `sympy/simplify/fu.py` | **1** | 0.94 | 1 | `sympy/simplify/fu.py` |
| sympy__sympy-19954 | 243 (42) | perm_groups.py | **1** | 1.00 | 1.00 | `sympy/combinatorics/perm_groups.py` | **1** | 0.95 | 1 | `sympy/combinatorics/perm_groups.py` |
| sympy__sympy-20428 | 235 (34) | expressiondomain.py | 2 | 0.60 | 0.28 | `none_of_these` | 2 | 0.36 | 1 | `sympy/polys/polyclasses.py` |
| sympy__sympy-22080 | 254 (52) | codeprinter.py, precedence.py | 4 | 0.42 | 0.11 | `sympy/printing/python.py` | **1** | 0.57 | 1 | `sympy/printing/codeprinter.py` |

## SWE NOUL CALIBRATION

| Noul p bin | files | gold files | fraction gold | mean p |
| --- | --- | --- | --- | --- |
| [0.0, 0.1) | 1587 | 3 | 0.002 | 0.027 |
| [0.1, 0.3) | 88 | 3 | 0.034 | 0.157 |
| [0.3, 0.5) | 20 | 5 | 0.250 | 0.376 |
| [0.5, 0.7) | 7 | 3 | 0.429 | 0.603 |
| [0.7, 0.9) | 14 | 12 | 0.857 | 0.799 |
| [0.9, 1.0) | 12 | 11 | 0.917 | 0.943 |

Base rate of gold among the 1728 Noul-judged files: 37/1728 = 0.021. Brier of Noul p against is-gold: 0.010; a constant prediction at the base rate scores 0.021.
