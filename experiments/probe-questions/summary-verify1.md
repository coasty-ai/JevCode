| Variant | Axis | n | Top-1 | Top-1 passes tests | Top-3 | MRR | mean P(truth) | min P(truth) | mean P(top) | mean P(2nd) | mean #opts>=0.5 | P(escape) mean | tokens/req | latency p50 ms | cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0_base | base | 20 | 17/20 | n/a | 18/20 | 0.89 | 0.59 | 0.00 | 0.68 | 0.12 | 0.8 | 0.07 | 832 | 196 | 0.0007 |
| Ld_actual | d actual | 20 | 18/20 | n/a | 19/20 | 0.92 | 0.67 | 0.01 | 0.73 | 0.11 | 0.9 | 0.07 | 901 | 171 | 0.0008 |
| S0_base | base | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.69 | 0.06 | 0.75 | 0.13 | 0.9 | 0.09 | 1261 | 192 | 0.0011 |
| S_combo_no_unchanged | combo | 20 | 19/20 | 20/20 | 20/20 | 0.97 | 0.85 | 0.02 | 0.90 | 0.02 | 0.9 | 0.08 | 1160 | 204 | 0.0010 |

Per-program, localisation: cell = rank of the true line (P(truth)); "-" = request rejected

| program | lines | L0_base | Ld_actual |
| --- | --- | --- | --- |
| bitcount | 6 | 1 (0.20) | 1 (0.70) |
| bucketsort | 8 | 1 (0.94) | 1 (0.89) |
| find_first_in_sorted | 12 | 1 (0.72) | 1 (0.78) |
| find_in_sorted | 12 | 1 (0.35) | 1 (0.77) |
| flatten | 7 | 1 (1.00) | 1 (1.00) |
| gcd | 5 | 1 (0.88) | 1 (0.87) |
| get_factors | 7 | 1 (0.75) | 1 (0.70) |
| hanoi | 8 | 1 (0.87) | 1 (0.91) |
| is_valid_parenthesization | 10 | 1 (0.89) | 1 (0.94) |
| kheapsort | 8 | 1 (0.33) | 1 (0.57) |
| knapsack | 13 | 1 (0.82) | 1 (0.84) |
| kth | 12 | 1 (0.53) | 1 (0.65) |
| lcs_length | 8 | 1 (0.67) | 1 (0.62) |
| levenshtein | 11 | 1 (0.78) | 1 (0.91) |
| lis | 10 | 4 (0.02) | 7 (0.01) |
| longest_common_subsequence | 11 | 2 (0.21) | 1 (0.14) |
| max_sublist_sum | 7 | 1 (0.58) | 1 (0.77) |
| mergesort | 21 | 16 (0.00) | 3 (0.07) |
| next_palindrome | 15 | 1 (0.19) | 1 (0.20) |
| next_permutation | 9 | 1 (0.99) | 1 (0.99) |

Per-program, selection: cell = rank of the true candidate (P(truth)); "-" = request rejected

| program | cands | S0_base | S_combo_no_unchanged |
| --- | --- | --- | --- |
| bitcount | 9 | 1 (0.86) | 1 (0.98) |
| bucketsort | 37 | 1 (0.93) | 1 (1.00) |
| find_first_in_sorted | 14 | 1 (0.79) | 1 (0.95) |
| find_in_sorted | 24 | 1 (0.98) | 1 (0.99) |
| flatten | 12 | 1 (0.99) | 1 (1.00) |
| gcd | 10 | 2 (0.42) | 1 (0.98) |
| get_factors | 2 | 1 (1.00) | 1 (0.98) |
| hanoi | 34 | 1 (0.50) | 1 (0.81) |
| is_valid_parenthesization | 3 | 1 (1.00) | 1 (1.00) |
| kheapsort | 18 | 1 (0.75) | 1 (0.98) |
| knapsack | 29 | 1 (0.92) | 1 (0.99) |
| kth | 30 | 1 (0.73) | 1 (0.97) |
| lcs_length | 60 | 1 (0.57) | 1 (0.60) |
| levenshtein | 23 | 1 (0.60) | 1 (0.82) |
| lis | 27 | 1 (0.39) | 1 (0.86) |
| longest_common_subsequence | 29 | 1 (0.67) | 1 (0.91) |
| max_sublist_sum | 18 | 1 (0.95) | 1 (0.89) |
| mergesort | 26 | 1 (0.58) | 1 (0.93) |
| next_palindrome | 18 | 2 (0.10) | 1 (0.39) |
| next_permutation | 36 | 2* (0.06) | 2* (0.02) |

Wrong top-1 picks (rank != 1): variant, program, P(truth), top pick text, P(top), passes tests

- L0_base / longest_common_subsequence: P(truth)=0.21, top=`key=len` P=0.31
- L0_base / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.80
- L0_base / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.92
- Ld_actual / lis: P(truth)=0.01, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.70
- Ld_actual / mergesort: P(truth)=0.07, top=`result.extend(left[i:] or right[j:])` P=0.60
- S0_base / gcd: P(truth)=0.42, top=`return gcd(a % b, b)` P=0.45 fails
- S0_base / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.73 fails
- S0_base / next_permutation: P(truth)=0.06, top=`if perm[j] > perm[i]:` P=0.70 PASSES
- S_combo_no_unchanged / next_permutation: P(truth)=0.02, top=`if perm[j] > perm[i]:` P=0.87 PASSES

Repeat stability, L0_base, 5 repeats per program

| program | P(truth) samples | max spread P(truth) | max spread P(top) | argmax flips |
| --- | --- | --- | --- | --- |
| bitcount | 0.20, 0.19, 0.20, 0.28, 0.31 | 0.12 | 0.12 | 0 |
| bucketsort | 0.94, 0.94, 0.93, 0.92, 0.93 | 0.02 | 0.02 | 0 |
| find_first_in_sorted | 0.72, 0.74, 0.77, 0.74, 0.77 | 0.05 | 0.05 | 0 |
| find_in_sorted | 0.35, 0.50, 0.42, 0.61, 0.58 | 0.26 | 0.26 | 0 |
| flatten | 1.00, 1.00, 1.00, 1.00, 1.00 | 0.00 | 0.00 | 0 |

Total: 100 requests (0 rejected), 98283 input tokens, $0.0041, latency p50 185 ms