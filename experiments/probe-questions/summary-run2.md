| Variant | Axis | n | Top-1 | Top-1 passes tests | Top-3 | MRR | mean P(truth) | min P(truth) | mean P(top) | P(escape) mean | tokens/req | latency p50 ms | cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0_base | base | 20 | 18/20 | n/a | 18/20 | 0.92 | 0.61 | 0.00 | 0.69 | 0.07 | 832 | 232 | 0.0007 |
| La_nodesc | a criteria | 20 | 16/20 | n/a | 17/20 | 0.85 | 0.60 | 0.01 | 0.69 | 0.07 | 706 | 189 | 0.0006 |
| Lb_opaque | b keys | 19 (+1 err) | 15/19 | n/a | 17/19 | 0.85 | 0.55 | 0.00 | 0.65 | 0.09 | 826 | 203 | 0.0007 |
| Lb_opaque_nodesc | b keys | 20 | 5/20 | n/a | 12/20 | 0.45 | 0.06 | 0.00 | 0.09 | 0.67 | 699 | 231 | 0.0006 |
| Lb_rawkey | b keys | 20 | 15/20 | n/a | 18/20 | 0.84 | 0.53 | 0.01 | 0.63 | 0.06 | 735 | 181 | 0.0006 |
| Lc_string | c state | 20 | 15/20 | n/a | 18/20 | 0.84 | 0.56 | 0.01 | 0.64 | 0.08 | 736 | 166 | 0.0006 |
| Ld_actual | d actual | 20 | 17/20 | n/a | 19/20 | 0.90 | 0.67 | 0.02 | 0.73 | 0.07 | 901 | 185 | 0.0008 |
| Le_literal | e literal | 20 | 16/20 | n/a | 18/20 | 0.87 | 0.58 | 0.00 | 0.67 | 0.07 | 837 | 196 | 0.0007 |
| Lf_docstring | f docstring | 20 | 14/20 | n/a | 18/20 | 0.80 | 0.55 | 0.00 | 0.67 | 0.11 | 944 | 175 | 0.0008 |
| Lg_noul_crit | g noul | 20 | 16/20 | n/a | 18/20 | 0.87 | 0.61 | 0.11 | 0.65 | n/a | 3094 | 203 | 0.0026 |
| Lg_noul_nocrit | g noul / a criteria | 20 | 15/20 | n/a | 17/20 | 0.83 | 0.60 | 0.10 | 0.65 | n/a | 994 | 228 | 0.0008 |
| Lh_score5 | h score | 20 | 16/20 | n/a | 17/20 | 0.85 | 0.64 | 0.09 | 0.70 | n/a | 2054 | 187 | 0.0017 |
| L_combo | combo | 20 | 17/20 | n/a | 18/20 | 0.89 | 0.63 | 0.02 | 0.69 | 0.09 | 897 | 217 | 0.0008 |
| Lg_noul_crit_actual | g noul + d actual | 20 | 18/20 | n/a | 19/20 | 0.93 | 0.66 | 0.09 | 0.69 | n/a | 3163 | 207 | 0.0027 |
| S0_base | base | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.71 | 0.09 | 0.78 | 0.08 | 1261 | 182 | 0.0011 |
| Sa_desc | a criteria | 20 | 18/20 | 19/20 | 20/20 | 0.95 | 0.77 | 0.04 | 0.85 | 0.02 | 1638 | 183 | 0.0014 |
| Sa_desc_only | a criteria | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.81 | 0.04 | 0.91 | 0.03 | 1177 | 211 | 0.0010 |
| Sb_semantic | b keys | 20 | 16/20 | 17/20 | 19/20 | 0.89 | 0.64 | 0.02 | 0.73 | 0.12 | 1582 | 211 | 0.0013 |
| Sb_rawkey | b keys | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.77 | 0.03 | 0.85 | 0.03 | 1620 | 218 | 0.0014 |
| Sc_string | c state | 20 | 11/20 | 13/20 | 20/20 | 0.77 | 0.60 | 0.05 | 0.75 | 0.06 | 1040 | 200 | 0.0009 |
| Sd_actual | d actual | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.73 | 0.09 | 0.80 | 0.08 | 1331 | 194 | 0.0011 |
| Se_literal | e literal | 20 | 18/20 | 19/20 | 20/20 | 0.95 | 0.70 | 0.09 | 0.76 | 0.08 | 1266 | 192 | 0.0011 |
| Sf_docstring | f docstring | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.69 | 0.07 | 0.76 | 0.09 | 1373 | 192 | 0.0012 |
| S_combo | combo | 20 | 17/20 | 18/20 | 20/20 | 0.93 | 0.82 | 0.06 | 0.91 | 0.03 | 1182 | 175 | 0.0010 |
| Sg_noul_crit | g noul | 20 | 17/20 | 19/20 | 20/20 | 0.93 | 0.72 | 0.18 | 0.74 | n/a | 6448 | 209 | 0.0054 |
| Sg_noul_nocrit | g noul / a criteria | 20 | 18/20 | 19/20 | 20/20 | 0.95 | 0.70 | 0.16 | 0.73 | n/a | 2134 | 216 | 0.0018 |
| Sh_score5 | h score | 20 | 19/20 | 20/20 | 20/20 | 0.97 | 0.74 | 0.21 | 0.75 | n/a | 4314 | 220 | 0.0036 |

Per-program, localisation: cell = rank of the true line (P(truth)); "-" = request rejected

| program | lines | L0_base | La_nodesc | Lb_opaque | Lb_opaque_nodesc | Lb_rawkey | Lc_string | Ld_actual | Le_literal | Lf_docstring | Lg_noul_crit | Lg_noul_nocrit | Lh_score5 | L_combo | Lg_noul_crit_actual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | 6 | 1 (0.15) | 1 (0.28) | 1 (0.15) | 3 (0.02) | 1 (0.24) | 1 (0.20) | 1 (0.65) | 1 (0.18) | 1 (0.11) | 1 (0.27) | 1 (0.38) | 1 (0.31) | 1 (0.68) | 1 (0.57) |
| bucketsort | 8 | 1 (0.92) | 1 (0.94) | 1 (0.88) | 7 (0.03) | 1 (0.89) | 1 (0.87) | 1 (0.94) | 1 (0.94) | 1 (0.97) | 1 (0.88) | 1 (0.85) | 1 (0.93) | 1 (0.90) | 1 (0.88) |
| find_first_in_sorted | 12 | 1 (0.72) | 1 (0.76) | 1 (0.70) | 3 (0.02) | 1 (0.74) | 1 (0.83) | 1 (0.80) | 1 (0.74) | 1 (0.72) | 1 (0.62) | 1 (0.67) | 1 (0.62) | 1 (0.69) | 1 (0.76) |
| find_in_sorted | 12 | 1 (0.60) | 1 (0.63) | 1 (0.40) | 2 (0.04) | 1 (0.31) | 1 (0.51) | 1 (0.75) | 1 (0.52) | 3 (0.21) | 1 (0.57) | 1 (0.58) | 1 (0.79) | 1 (0.76) | 1 (0.87) |
| flatten | 7 | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.12) | 1 (0.99) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.96) | 1 (0.96) | 1 (1.00) | 1 (1.00) | 1 (0.96) |
| gcd | 5 | 1 (0.89) | 1 (0.87) | 1 (0.78) | 1 (0.36) | 1 (0.87) | 1 (0.78) | 1 (0.89) | 1 (0.89) | 1 (0.59) | 1 (0.57) | 1 (0.52) | 1 (0.56) | 1 (0.90) | 1 (0.79) |
| get_factors | 7 | 1 (0.77) | 1 (0.76) | 1 (0.71) | 6 (0.04) | 2 (0.23) | 1 (0.84) | 1 (0.69) | 1 (0.70) | 1 (0.88) | 1 (0.89) | 1 (0.83) | 1 (0.93) | 1 (0.60) | 1 (0.85) |
| hanoi | 8 | 1 (0.93) | 1 (0.92) | 1 (0.78) | 1 (0.20) | 1 (0.86) | 1 (0.85) | 1 (0.88) | 1 (0.91) | 1 (0.71) | 1 (0.90) | 1 (0.85) | 1 (0.93) | 1 (0.90) | 1 (0.93) |
| is_valid_parenthesization | 10 | 1 (0.90) | 1 (0.92) | 1 (0.91) | 1 (0.06) | 1 (0.91) | 1 (0.69) | 1 (0.95) | 1 (0.89) | 1 (0.91) | 1 (0.77) | 1 (0.80) | 1 (0.74) | 1 (0.93) | 1 (0.70) |
| kheapsort | 8 | 1 (0.34) | 2 (0.27) | - | 4 (0.05) | 1 (0.34) | 1 (0.51) | 1 (0.61) | 2 (0.30) | 2 (0.26) | 1 (0.56) | 2 (0.54) | 1 (0.69) | 1 (0.51) | 1 (0.67) |
| knapsack | 13 | 1 (0.81) | 1 (0.63) | 1 (0.80) | 12 (0.01) | 1 (0.84) | 1 (0.85) | 1 (0.85) | 1 (0.79) | 1 (0.86) | 1 (0.75) | 1 (0.61) | 1 (0.77) | 1 (0.86) | 1 (0.82) |
| kth | 12 | 1 (0.52) | 1 (0.61) | 2 (0.35) | 5 (0.03) | 1 (0.46) | 2 (0.41) | 1 (0.62) | 1 (0.54) | 1 (0.67) | 2 (0.63) | 2 (0.65) | 1 (0.72) | 1 (0.53) | 1 (0.67) |
| lcs_length | 8 | 1 (0.67) | 1 (0.76) | 1 (0.65) | 8 (0.02) | 1 (0.57) | 1 (0.77) | 1 (0.72) | 1 (0.63) | 1 (0.68) | 1 (0.59) | 1 (0.52) | 1 (0.58) | 1 (0.69) | 1 (0.63) |
| levenshtein | 11 | 1 (0.81) | 1 (0.85) | 1 (0.49) | 2 (0.04) | 1 (0.57) | 1 (0.47) | 1 (0.87) | 1 (0.71) | 1 (0.81) | 1 (0.89) | 1 (0.86) | 1 (0.89) | 1 (0.54) | 1 (0.88) |
| lis | 10 | 4 (0.02) | 5 (0.02) | 6 (0.02) | 2 (0.05) | 7 (0.01) | 6 (0.02) | 4 (0.02) | 4 (0.02) | 7 (0.01) | 5 (0.16) | 4 (0.20) | 5 (0.26) | 5 (0.02) | 5 (0.09) |
| longest_common_subsequence | 11 | 1 (0.26) | 1 (0.29) | 2 (0.20) | 1 (0.05) | 2 (0.21) | 2 (0.22) | 3 (0.05) | 2 (0.28) | 2 (0.20) | 1 (0.38) | 1 (0.42) | 2 (0.23) | 3 (0.06) | 1 (0.12) |
| max_sublist_sum | 7 | 1 (0.66) | 1 (0.47) | 1 (0.51) | 3 (0.05) | 1 (0.50) | 2 (0.24) | 1 (0.79) | 1 (0.53) | 2 (0.26) | 1 (0.47) | 1 (0.44) | 1 (0.58) | 1 (0.73) | 1 (0.74) |
| mergesort | 21 | 17 (0.00) | 4 (0.01) | 17 (0.00) | 20 (0.00) | 4 (0.01) | 5 (0.01) | 3 (0.08) | 17 (0.00) | 17 (0.00) | 2 (0.11) | 4 (0.10) | 5 (0.09) | 5 (0.04) | 2 (0.17) |
| next_palindrome | 15 | 1 (0.24) | 7 (0.07) | 1 (0.21) | 15 (0.02) | 3 (0.13) | 1 (0.17) | 1 (0.19) | 1 (0.14) | 1 (0.20) | 4 (0.24) | 8 (0.25) | 9 (0.24) | 1 (0.17) | 1 (0.17) |
| next_permutation | 9 | 1 (0.98) | 1 (1.00) | 1 (0.97) | 3 (0.04) | 1 (0.99) | 1 (0.94) | 1 (0.99) | 1 (0.98) | 1 (0.98) | 1 (0.93) | 1 (0.89) | 1 (0.93) | 1 (1.00) | 1 (0.94) |

Per-program, selection: cell = rank of the true candidate (P(truth)); "-" = request rejected

| program | cands | S0_base | Sa_desc | Sa_desc_only | Sb_semantic | Sb_rawkey | Sc_string | Sd_actual | Se_literal | Sf_docstring | S_combo | Sg_noul_crit | Sg_noul_nocrit | Sh_score5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | 9 | 1 (0.88) | 1 (0.92) | 1 (0.99) | 1 (0.40) | 1 (0.92) | 1 (0.94) | 1 (0.99) | 1 (0.93) | 1 (0.87) | 1 (0.96) | 1 (0.89) | 1 (0.84) | 1 (0.94) |
| bucketsort | 37 | 1 (0.92) | 1 (0.99) | 1 (1.00) | 1 (0.79) | 1 (0.97) | 1 (0.97) | 1 (0.91) | 1 (0.92) | 1 (0.96) | 1 (1.00) | 1 (0.95) | 1 (0.96) | 1 (0.96) |
| find_first_in_sorted | 14 | 1 (0.77) | 1 (0.83) | 1 (0.96) | 1 (0.62) | 1 (0.85) | 1 (0.65) | 1 (0.81) | 1 (0.69) | 1 (0.70) | 1 (0.97) | 1 (0.54) | 1 (0.43) | 1 (0.47) |
| find_in_sorted | 24 | 1 (0.96) | 1 (0.99) | 1 (1.00) | 1 (0.98) | 1 (0.98) | 1 (0.95) | 1 (0.98) | 1 (0.98) | 1 (0.95) | 1 (1.00) | 1 (0.88) | 1 (0.89) | 1 (0.90) |
| flatten | 12 | 1 (0.99) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.99) | 1 (0.99) | 1 (0.99) | 1 (0.99) | 1 (0.99) | 1 (1.00) | 1 (0.96) | 1 (0.97) | 1 (0.98) |
| gcd | 10 | 2 (0.41) | 1 (0.62) | 1 (0.98) | 1 (0.59) | 1 (0.76) | 2 (0.30) | 1 (0.67) | 1 (0.50) | 2 (0.36) | 1 (0.98) | 1 (0.82) | 1 (0.69) | 1 (0.79) |
| get_factors | 2 | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.99) | 1 (0.94) | 1 (0.94) | 1 (0.95) |
| hanoi | 34 | 1 (0.71) | 1 (0.65) | 1 (0.91) | 2 (0.36) | 1 (0.66) | 2 (0.31) | 1 (0.77) | 1 (0.68) | 1 (0.56) | 1 (0.91) | 1 (0.74) | 1 (0.81) | 1 (0.92) |
| is_valid_parenthesization | 3 | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.87) | 1 (0.94) | 1 (0.91) |
| kheapsort | 18 | 1 (0.82) | 1 (0.92) | 1 (0.93) | 1 (0.85) | 1 (0.95) | 1 (0.77) | 1 (0.83) | 1 (0.73) | 1 (0.64) | 1 (0.93) | 1 (0.63) | 1 (0.75) | 1 (0.74) |
| knapsack | 29 | 1 (0.91) | 1 (0.97) | 1 (1.00) | 1 (0.88) | 1 (0.97) | 1 (0.89) | 1 (0.96) | 1 (0.93) | 1 (0.94) | 1 (0.99) | 1 (0.77) | 1 (0.67) | 1 (0.76) |
| kth | 30 | 1 (0.71) | 1 (0.96) | 1 (0.98) | 1 (0.88) | 1 (0.96) | 1 (0.73) | 1 (0.76) | 1 (0.70) | 1 (0.83) | 1 (0.95) | 1 (0.73) | 1 (0.75) | 1 (0.49) |
| lcs_length | 60 | 1 (0.59) | 1 (0.60) | 2 (0.24) | 2 (0.23) | 2 (0.42) | 2 (0.43) | 1 (0.46) | 1 (0.58) | 1 (0.44) | 2 (0.27) | 1 (0.53) | 1 (0.58) | 1 (0.72) |
| levenshtein | 23 | 1 (0.74) | 1 (0.74) | 1 (0.66) | 1 (0.84) | 1 (0.72) | 2* (0.43) | 1 (0.75) | 1 (0.57) | 1 (0.68) | 1 (0.69) | 2* (0.86) | 1 (0.78) | 1 (0.82) |
| lis | 27 | 1 (0.54) | 1 (0.61) | 1 (0.74) | 1 (0.44) | 1 (0.58) | 2 (0.31) | 1 (0.46) | 1 (0.41) | 1 (0.43) | 1 (0.77) | 1 (0.39) | 1 (0.30) | 1 (0.36) |
| longest_common_subsequence | 29 | 1 (0.60) | 1 (0.74) | 1 (0.97) | 1 (0.44) | 1 (0.72) | 2 (0.19) | 2 (0.33) | 1 (0.73) | 1 (0.75) | 1 (0.96) | 1 (0.70) | 1 (0.73) | 1 (0.71) |
| max_sublist_sum | 18 | 1 (0.93) | 1 (0.94) | 1 (0.90) | 1 (0.95) | 1 (0.93) | 1 (0.71) | 1 (0.99) | 1 (0.93) | 1 (0.95) | 1 (0.94) | 1 (0.81) | 1 (0.68) | 1 (0.82) |
| mergesort | 26 | 1 (0.55) | 1 (0.76) | 1 (0.88) | 1 (0.43) | 1 (0.81) | 2 (0.26) | 1 (0.65) | 1 (0.51) | 1 (0.55) | 1 (0.90) | 1 (0.79) | 1 (0.76) | 1 (0.78) |
| next_palindrome | 18 | 2 (0.10) | 2 (0.07) | 2 (0.07) | 2 (0.04) | 2 (0.09) | 2 (0.09) | 2 (0.10) | 2 (0.10) | 2 (0.13) | 2 (0.11) | 2 (0.18) | 2 (0.16) | 1 (0.21) |
| next_permutation | 36 | 2* (0.09) | 2* (0.04) | 2* (0.04) | 4* (0.02) | 2* (0.03) | 3* (0.05) | 2* (0.09) | 2* (0.09) | 2* (0.07) | 2* (0.06) | 2* (0.40) | 2* (0.47) | 2* (0.68) |

Wrong top-1 picks (rank != 1): variant, program, P(truth), top pick text, P(top), passes tests

- L0_base / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.75
- L0_base / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.93
- La_nodesc / kheapsort: P(truth)=0.27, top=`yield heapq.heappushpop(heap, x)` P=0.34
- La_nodesc / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.73
- La_nodesc / next_palindrome: P(truth)=0.07, top=`high_mid += 1` P=0.19
- La_nodesc / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.78
- Lb_opaque / kth: P(truth)=0.35, top=`elif k >= num_lessoreq:` P=0.46
- Lb_opaque / longest_common_subsequence: P(truth)=0.20, top=`key=len` P=0.28
- Lb_opaque / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.78
- Lb_opaque / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.88
- Lb_opaque_nodesc / bucketsort: P(truth)=0.03, top=`sorted_arr.extend([i] * count)` P=0.15
- Lb_opaque_nodesc / bitcount: P(truth)=0.02, top=`def bitcount(n):` P=0.02
- Lb_opaque_nodesc / find_in_sorted: P(truth)=0.04, top=`elif x > arr[mid]:` P=0.04
- Lb_opaque_nodesc / find_first_in_sorted: P(truth)=0.02, top=`mid = (lo + hi) // 2` P=0.03
- Lb_opaque_nodesc / lcs_length: P(truth)=0.02, top=`for j in range(len(t)):` P=0.05
- Lb_opaque_nodesc / kheapsort: P(truth)=0.05, top=`yield heapq.heappop(heap)` P=0.11
- Lb_opaque_nodesc / get_factors: P(truth)=0.04, top=`if n % i == 0:` P=0.13
- Lb_opaque_nodesc / kth: P(truth)=0.03, top=`num_less = len(below)` P=0.04
- Lb_opaque_nodesc / knapsack: P(truth)=0.01, top=`value + memo[i - 1, j - weight]` P=0.03
- Lb_opaque_nodesc / levenshtein: P(truth)=0.04, top=`if source == '' or target == '':` P=0.04
- Lb_opaque_nodesc / lis: P(truth)=0.05, top=`prefix_lengths = [j for j in range(1, longest + 1) if arr[ends[j]] < val]` P=0.05
- Lb_opaque_nodesc / mergesort: P(truth)=0.00, top=`i = 0` P=0.02
- Lb_opaque_nodesc / max_sublist_sum: P(truth)=0.05, top=`return max_so_far` P=0.06
- Lb_opaque_nodesc / next_palindrome: P(truth)=0.02, top=`high_mid += 1` P=0.06
- Lb_opaque_nodesc / next_permutation: P(truth)=0.04, top=`next_perm = list(perm)` P=0.16
- Lb_rawkey / get_factors: P(truth)=0.23, top=`return []` P=0.50
- Lb_rawkey / lis: P(truth)=0.01, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.71
- Lb_rawkey / longest_common_subsequence: P(truth)=0.21, top=`key=len` P=0.31
- Lb_rawkey / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.87
- Lb_rawkey / next_palindrome: P(truth)=0.13, top=`while high_mid < len(digit_list) and low_mid >= 0:` P=0.13
- Lc_string / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.62
- Lc_string / longest_common_subsequence: P(truth)=0.22, top=`return ''` P=0.27
- Lc_string / max_sublist_sum: P(truth)=0.24, top=`max_so_far = 0` P=0.36
- Lc_string / kth: P(truth)=0.41, top=`elif k >= num_lessoreq:` P=0.41
- Lc_string / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.89
- Ld_actual / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.66
- Ld_actual / longest_common_subsequence: P(truth)=0.05, top=`key=len` P=0.11
- Ld_actual / mergesort: P(truth)=0.08, top=`result.extend(left[i:] or right[j:])` P=0.59
- Le_literal / kheapsort: P(truth)=0.30, top=`yield heapq.heappushpop(heap, x)` P=0.31
- Le_literal / longest_common_subsequence: P(truth)=0.28, top=`key=len` P=0.32
- Le_literal / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.80
- Le_literal / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.91
- Lf_docstring / find_in_sorted: P(truth)=0.21, top=`return -1` P=0.41
- Lf_docstring / kheapsort: P(truth)=0.26, top=`heap = arr[:k]` P=0.42
- Lf_docstring / longest_common_subsequence: P(truth)=0.20, top=`key=len` P=0.21
- Lf_docstring / lis: P(truth)=0.01, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.82
- Lf_docstring / max_sublist_sum: P(truth)=0.26, top=`max_so_far = 0` P=0.44
- Lf_docstring / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.91
- Lg_noul_crit / kth: P(truth)=0.63, top=`elif k >= num_lessoreq:` P=0.63
- Lg_noul_crit / lis: P(truth)=0.16, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.61
- Lg_noul_crit / mergesort: P(truth)=0.11, top=`result.extend(left[i:] or right[j:])` P=0.48
- Lg_noul_crit / next_palindrome: P(truth)=0.24, top=`high_mid += 1` P=0.32
- Lg_noul_nocrit / kheapsort: P(truth)=0.54, top=`yield heapq.heappushpop(heap, x)` P=0.57
- Lg_noul_nocrit / lis: P(truth)=0.20, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.68
- Lg_noul_nocrit / kth: P(truth)=0.65, top=`elif k >= num_lessoreq:` P=0.66
- Lg_noul_nocrit / mergesort: P(truth)=0.10, top=`result.extend(left[i:] or right[j:])` P=0.51
- Lg_noul_nocrit / next_palindrome: P(truth)=0.25, top=`digit_list[low_mid] = 0` P=0.33
- Lh_score5 / lis: P(truth)=0.26, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.68
- Lh_score5 / longest_common_subsequence: P(truth)=0.23, top=`elif a[0] == b[0]:` P=0.24
- Lh_score5 / mergesort: P(truth)=0.09, top=`result.extend(left[i:] or right[j:])` P=0.61
- Lh_score5 / next_palindrome: P(truth)=0.24, top=`digit_list[low_mid] += 1` P=0.40
- L_combo / mergesort: P(truth)=0.04, top=`result.extend(left[i:] or right[j:])` P=0.60
- L_combo / longest_common_subsequence: P(truth)=0.06, top=`key=len` P=0.11
- L_combo / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.69
- Lg_noul_crit_actual / lis: P(truth)=0.09, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.41
- Lg_noul_crit_actual / mergesort: P(truth)=0.17, top=`result.extend(left[i:] or right[j:])` P=0.37
- S0_base / gcd: P(truth)=0.41, top=`return gcd(a % b, b)` P=0.49 fails
- S0_base / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.73 fails
- S0_base / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.67 PASSES
- Sa_desc / next_palindrome: P(truth)=0.07, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.83 fails
- Sa_desc / next_permutation: P(truth)=0.04, top=`if perm[j] > perm[i]:` P=0.89 PASSES
- Sa_desc_only / lcs_length: P(truth)=0.24, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.61 fails
- Sa_desc_only / next_palindrome: P(truth)=0.07, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- Sa_desc_only / next_permutation: P(truth)=0.04, top=`if perm[j] > perm[i]:` P=0.86 PASSES
- Sb_semantic / hanoi: P(truth)=0.36, top=`steps.append((start, helper))` P=0.54 fails
- Sb_semantic / lcs_length: P(truth)=0.23, top=`dp[i, j] = dp[i + 1, j] + 1` P=0.50 fails
- Sb_semantic / next_permutation: P(truth)=0.02, top=`if perm[j] > perm[i]:` P=0.73 PASSES
- Sb_semantic / next_palindrome: P(truth)=0.04, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.77 fails
- Sb_rawkey / lcs_length: P(truth)=0.42, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.54 fails
- Sb_rawkey / next_palindrome: P(truth)=0.09, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- Sb_rawkey / next_permutation: P(truth)=0.03, top=`if perm[j] > perm[i]:` P=0.87 PASSES
- Sc_string / hanoi: P(truth)=0.31, top=`steps.append((start, helper))` P=0.53 fails
- Sc_string / gcd: P(truth)=0.30, top=`return gcd(a % b, b)` P=0.61 fails
- Sc_string / lcs_length: P(truth)=0.43, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.47 fails
- Sc_string / lis: P(truth)=0.31, top=`longest = length + 1` P=0.42 fails
- Sc_string / levenshtein: P(truth)=0.43, top=`return 0 + levenshtein(source[1:], target[1:])` P=0.53 PASSES
- Sc_string / mergesort: P(truth)=0.26, top=`if len(arr) == 0:` P=0.62 fails
- Sc_string / next_palindrome: P(truth)=0.09, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.79 fails
- Sc_string / next_permutation: P(truth)=0.05, top=`if perm[j] > perm[i]:` P=0.73 PASSES
- Sc_string / longest_common_subsequence: P(truth)=0.19, top=`return a[0] + longest_common_subsequence(a[1:], b)` P=0.73 fails
- Sd_actual / longest_common_subsequence: P(truth)=0.33, top=`return a[0] + longest_common_subsequence(a[1:], b)` P=0.54 fails
- Sd_actual / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.69 fails
- Sd_actual / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.70 PASSES
- Se_literal / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.72 fails
- Se_literal / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.64 PASSES
- Sf_docstring / gcd: P(truth)=0.36, top=`return gcd(a % b, b)` P=0.50 fails
- Sf_docstring / next_palindrome: P(truth)=0.13, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.73 fails
- Sf_docstring / next_permutation: P(truth)=0.07, top=`if perm[j] > perm[i]:` P=0.76 PASSES
- S_combo / lcs_length: P(truth)=0.27, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.60 fails
- S_combo / next_palindrome: P(truth)=0.11, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- S_combo / next_permutation: P(truth)=0.06, top=`if perm[j] > perm[i]:` P=0.86 PASSES
- Sg_noul_crit / levenshtein: P(truth)=0.86, top=`return 0 + levenshtein(source[1:], target[1:])` P=0.86 PASSES
- Sg_noul_crit / next_palindrome: P(truth)=0.18, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.19 fails
- Sg_noul_crit / next_permutation: P(truth)=0.40, top=`if perm[j] > perm[i]:` P=0.81 PASSES
- Sg_noul_nocrit / next_permutation: P(truth)=0.47, top=`if perm[j] > perm[i]:` P=0.85 PASSES
- Sg_noul_nocrit / next_palindrome: P(truth)=0.16, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.38 fails
- Sh_score5 / next_permutation: P(truth)=0.68, top=`if perm[j] > perm[i]:` P=0.77 PASSES

Wrong top-1 picks (rank != 1): variant, program, P(truth), top pick text, P(top), passes tests

- L0_base / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.75
- L0_base / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.93
- La_nodesc / kheapsort: P(truth)=0.27, top=`yield heapq.heappushpop(heap, x)` P=0.34
- La_nodesc / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.73
- La_nodesc / next_palindrome: P(truth)=0.07, top=`high_mid += 1` P=0.19
- La_nodesc / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.78
- Lb_opaque / kth: P(truth)=0.35, top=`elif k >= num_lessoreq:` P=0.46
- Lb_opaque / longest_common_subsequence: P(truth)=0.20, top=`key=len` P=0.28
- Lb_opaque / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.78
- Lb_opaque / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.88
- Lb_opaque_nodesc / bucketsort: P(truth)=0.03, top=`sorted_arr.extend([i] * count)` P=0.15
- Lb_opaque_nodesc / bitcount: P(truth)=0.02, top=`def bitcount(n):` P=0.02
- Lb_opaque_nodesc / find_in_sorted: P(truth)=0.04, top=`elif x > arr[mid]:` P=0.04
- Lb_opaque_nodesc / find_first_in_sorted: P(truth)=0.02, top=`mid = (lo + hi) // 2` P=0.03
- Lb_opaque_nodesc / lcs_length: P(truth)=0.02, top=`for j in range(len(t)):` P=0.05
- Lb_opaque_nodesc / kheapsort: P(truth)=0.05, top=`yield heapq.heappop(heap)` P=0.11
- Lb_opaque_nodesc / get_factors: P(truth)=0.04, top=`if n % i == 0:` P=0.13
- Lb_opaque_nodesc / kth: P(truth)=0.03, top=`num_less = len(below)` P=0.04
- Lb_opaque_nodesc / knapsack: P(truth)=0.01, top=`value + memo[i - 1, j - weight]` P=0.03
- Lb_opaque_nodesc / levenshtein: P(truth)=0.04, top=`if source == '' or target == '':` P=0.04
- Lb_opaque_nodesc / lis: P(truth)=0.05, top=`prefix_lengths = [j for j in range(1, longest + 1) if arr[ends[j]] < val]` P=0.05
- Lb_opaque_nodesc / mergesort: P(truth)=0.00, top=`i = 0` P=0.02
- Lb_opaque_nodesc / max_sublist_sum: P(truth)=0.05, top=`return max_so_far` P=0.06
- Lb_opaque_nodesc / next_palindrome: P(truth)=0.02, top=`high_mid += 1` P=0.06
- Lb_opaque_nodesc / next_permutation: P(truth)=0.04, top=`next_perm = list(perm)` P=0.16
- Lb_rawkey / get_factors: P(truth)=0.23, top=`return []` P=0.50
- Lb_rawkey / lis: P(truth)=0.01, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.71
- Lb_rawkey / longest_common_subsequence: P(truth)=0.21, top=`key=len` P=0.31
- Lb_rawkey / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.87
- Lb_rawkey / next_palindrome: P(truth)=0.13, top=`while high_mid < len(digit_list) and low_mid >= 0:` P=0.13
- Lc_string / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.62
- Lc_string / longest_common_subsequence: P(truth)=0.22, top=`return ''` P=0.27
- Lc_string / max_sublist_sum: P(truth)=0.24, top=`max_so_far = 0` P=0.36
- Lc_string / kth: P(truth)=0.41, top=`elif k >= num_lessoreq:` P=0.41
- Lc_string / mergesort: P(truth)=0.01, top=`result.extend(left[i:] or right[j:])` P=0.89
- Ld_actual / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.66
- Ld_actual / longest_common_subsequence: P(truth)=0.05, top=`key=len` P=0.11
- Ld_actual / mergesort: P(truth)=0.08, top=`result.extend(left[i:] or right[j:])` P=0.59
- Le_literal / kheapsort: P(truth)=0.30, top=`yield heapq.heappushpop(heap, x)` P=0.31
- Le_literal / longest_common_subsequence: P(truth)=0.28, top=`key=len` P=0.32
- Le_literal / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.80
- Le_literal / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.91
- Lf_docstring / find_in_sorted: P(truth)=0.21, top=`return -1` P=0.41
- Lf_docstring / kheapsort: P(truth)=0.26, top=`heap = arr[:k]` P=0.42
- Lf_docstring / longest_common_subsequence: P(truth)=0.20, top=`key=len` P=0.21
- Lf_docstring / lis: P(truth)=0.01, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.82
- Lf_docstring / max_sublist_sum: P(truth)=0.26, top=`max_so_far = 0` P=0.44
- Lf_docstring / mergesort: P(truth)=0.00, top=`result.extend(left[i:] or right[j:])` P=0.91
- Lg_noul_crit / kth: P(truth)=0.63, top=`elif k >= num_lessoreq:` P=0.63
- Lg_noul_crit / lis: P(truth)=0.16, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.61
- Lg_noul_crit / mergesort: P(truth)=0.11, top=`result.extend(left[i:] or right[j:])` P=0.48
- Lg_noul_crit / next_palindrome: P(truth)=0.24, top=`high_mid += 1` P=0.32
- Lg_noul_nocrit / kheapsort: P(truth)=0.54, top=`yield heapq.heappushpop(heap, x)` P=0.57
- Lg_noul_nocrit / lis: P(truth)=0.20, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.68
- Lg_noul_nocrit / kth: P(truth)=0.65, top=`elif k >= num_lessoreq:` P=0.66
- Lg_noul_nocrit / mergesort: P(truth)=0.10, top=`result.extend(left[i:] or right[j:])` P=0.51
- Lg_noul_nocrit / next_palindrome: P(truth)=0.25, top=`digit_list[low_mid] = 0` P=0.33
- Lh_score5 / lis: P(truth)=0.26, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.68
- Lh_score5 / longest_common_subsequence: P(truth)=0.23, top=`elif a[0] == b[0]:` P=0.24
- Lh_score5 / mergesort: P(truth)=0.09, top=`result.extend(left[i:] or right[j:])` P=0.61
- Lh_score5 / next_palindrome: P(truth)=0.24, top=`digit_list[low_mid] += 1` P=0.40
- L_combo / mergesort: P(truth)=0.04, top=`result.extend(left[i:] or right[j:])` P=0.60
- L_combo / longest_common_subsequence: P(truth)=0.06, top=`key=len` P=0.11
- L_combo / lis: P(truth)=0.02, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.69
- Lg_noul_crit_actual / lis: P(truth)=0.09, top=`if length == longest or val < arr[ends[length + 1]]:` P=0.41
- Lg_noul_crit_actual / mergesort: P(truth)=0.17, top=`result.extend(left[i:] or right[j:])` P=0.37
- S0_base / gcd: P(truth)=0.41, top=`return gcd(a % b, b)` P=0.49 fails
- S0_base / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.73 fails
- S0_base / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.67 PASSES
- Sa_desc / next_palindrome: P(truth)=0.07, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.83 fails
- Sa_desc / next_permutation: P(truth)=0.04, top=`if perm[j] > perm[i]:` P=0.89 PASSES
- Sa_desc_only / lcs_length: P(truth)=0.24, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.61 fails
- Sa_desc_only / next_palindrome: P(truth)=0.07, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- Sa_desc_only / next_permutation: P(truth)=0.04, top=`if perm[j] > perm[i]:` P=0.86 PASSES
- Sb_semantic / hanoi: P(truth)=0.36, top=`steps.append((start, helper))` P=0.54 fails
- Sb_semantic / lcs_length: P(truth)=0.23, top=`dp[i, j] = dp[i + 1, j] + 1` P=0.50 fails
- Sb_semantic / next_permutation: P(truth)=0.02, top=`if perm[j] > perm[i]:` P=0.73 PASSES
- Sb_semantic / next_palindrome: P(truth)=0.04, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.77 fails
- Sb_rawkey / lcs_length: P(truth)=0.42, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.54 fails
- Sb_rawkey / next_palindrome: P(truth)=0.09, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- Sb_rawkey / next_permutation: P(truth)=0.03, top=`if perm[j] > perm[i]:` P=0.87 PASSES
- Sc_string / hanoi: P(truth)=0.31, top=`steps.append((start, helper))` P=0.53 fails
- Sc_string / gcd: P(truth)=0.30, top=`return gcd(a % b, b)` P=0.61 fails
- Sc_string / lcs_length: P(truth)=0.43, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.47 fails
- Sc_string / lis: P(truth)=0.31, top=`longest = length + 1` P=0.42 fails
- Sc_string / levenshtein: P(truth)=0.43, top=`return 0 + levenshtein(source[1:], target[1:])` P=0.53 PASSES
- Sc_string / mergesort: P(truth)=0.26, top=`if len(arr) == 0:` P=0.62 fails
- Sc_string / next_palindrome: P(truth)=0.09, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.79 fails
- Sc_string / next_permutation: P(truth)=0.05, top=`if perm[j] > perm[i]:` P=0.73 PASSES
- Sc_string / longest_common_subsequence: P(truth)=0.19, top=`return a[0] + longest_common_subsequence(a[1:], b)` P=0.73 fails
- Sd_actual / longest_common_subsequence: P(truth)=0.33, top=`return a[0] + longest_common_subsequence(a[1:], b)` P=0.54 fails
- Sd_actual / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.69 fails
- Sd_actual / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.70 PASSES
- Se_literal / next_palindrome: P(truth)=0.10, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.72 fails
- Se_literal / next_permutation: P(truth)=0.09, top=`if perm[j] > perm[i]:` P=0.64 PASSES
- Sf_docstring / gcd: P(truth)=0.36, top=`return gcd(a % b, b)` P=0.50 fails
- Sf_docstring / next_palindrome: P(truth)=0.13, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.73 fails
- Sf_docstring / next_permutation: P(truth)=0.07, top=`if perm[j] > perm[i]:` P=0.76 PASSES
- S_combo / lcs_length: P(truth)=0.27, top=`dp[i, j] = dp[i - 1, j] + 1` P=0.60 fails
- S_combo / next_palindrome: P(truth)=0.11, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.85 fails
- S_combo / next_permutation: P(truth)=0.06, top=`if perm[j] > perm[i]:` P=0.86 PASSES
- Sg_noul_crit / levenshtein: P(truth)=0.86, top=`return 0 + levenshtein(source[1:], target[1:])` P=0.86 PASSES
- Sg_noul_crit / next_palindrome: P(truth)=0.18, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.19 fails
- Sg_noul_crit / next_permutation: P(truth)=0.40, top=`if perm[j] > perm[i]:` P=0.81 PASSES
- Sg_noul_nocrit / next_permutation: P(truth)=0.47, top=`if perm[j] > perm[i]:` P=0.85 PASSES
- Sg_noul_nocrit / next_palindrome: P(truth)=0.16, top=`return [1] + (len(digit_list)) * [0] + [1]` P=0.38 fails
- Sh_score5 / next_permutation: P(truth)=0.68, top=`if perm[j] > perm[i]:` P=0.77 PASSES

Repeat stability, L0_base, 5 repeats per program

| program | P(truth) samples | max spread P(truth) | max spread P(top) | argmax flips |
| --- | --- | --- | --- | --- |
| bitcount | 0.15, 0.24, 0.23, 0.31, 0.27 | 0.16 | 0.16 | 0 |
| bucketsort | 0.92, 0.93, 0.93, 0.93, 0.95 | 0.03 | 0.03 | 0 |
| find_first_in_sorted | 0.72, 0.74, 0.75, 0.71, 0.70 | 0.05 | 0.05 | 0 |
| find_in_sorted | 0.60, 0.54, 0.54, 0.58, 0.46 | 0.14 | 0.14 | 0 |
| flatten | 1.00, 1.00, 1.00, 1.00, 1.00 | 0.00 | 0.00 | 0 |

Total: 560 requests (1 rejected), 890013 input tokens, $0.0374, latency p50 195 ms