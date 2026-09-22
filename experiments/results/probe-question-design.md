# Probe-question design sensitivity for code judgments (Jev only, live, 2026-09-20)

Scripts: `experiments/probe-questions/probe.mts` (variants, runner, per-run summary), `aggregate.mts`
(pools the runs), `actual_outputs.py` (runs the buggy programs for variant d), `eval_candidates.py`
(test oracle over every candidate). Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned.
Data: the first 20 QuixBugs Python programs (alphabetical) that have JSON test cases:
bitcount, bucketsort, find_first_in_sorted, find_in_sorted, flatten, gcd, get_factors, hanoi,
is_valid_parenthesization, kheapsort, knapsack, kth, lcs_length, levenshtein, lis,
longest_common_subsequence, max_sublist_sum, mergesort, next_palindrome, next_permutation. All 20
bugs are one-line replacements. 3 test cases in the state, 5 to 21 non-blank lines per program.

Every variant was run on all 20 programs in **4 independent full runs** (2 to 3 for the variants
added after run 2), so each aggregate below is a mean over 60 to 80 items and the run-to-run
swing of a 20-item top-1 count (±2 programs) is visible in the "Top-1 per run" column. Differences
of one or two programs between variants are noise; the effects called out below reproduced in
every run.

| Totals | |
| --- | --- |
| Requests recorded in `results-run{1..4}.jsonl` | 2,260 (1 rejected by JevCode's validator, see incidents) |
| Input tokens recorded | 3,553,334 |
| Cost recorded (`usage.costUsd`) | $0.1492 |
| Cost not recorded: smoke test $0.0024, plus three full runs (~$0.037 each) whose requests completed but whose summary stage crashed on a script bug before writing results | ≈ $0.11 |
| Total live spend, this topic | ≈ $0.26 (cap was $1.00) |
| Jev latency p50 / p95 (single request, 1 to 60 questions) | 197 ms / 346 ms |
| Cost per program, base localisation + base selection | $0.00009 |

## 1. The two questions and the base shapes

**Localisation, `L0_base`** (Choice over the non-blank lines):

```
state = {
  task: "The Python function `gcd` has a single-line bug. `tests` give the input and the expected output.",
  program: { L2: "def gcd(a, b):", L3: "    if b == 0:", L4: "        return a", L5: "    else:", L6: "        return gcd(a % b, b)" },
  tests: [ { input: [17, 0], expected: 17 }, { input: [13, 13], expected: 13 }, { input: [37, 600], expected: 1 } ]
}
questions.buggy_line = choice(
  "Which line of `program` contains the bug that makes `tests` fail? Pick the single line that must change.",
  { line_2: "def gcd(a, b):", line_3: "    if b == 0:", ..., line_6: "        return gcd(a % b, b)" })   // + none_of_these: null (builder)
```

**Selection, `S0_base`** (Choice over candidate replacements of the true buggy line; the anchor-probe
shape): candidates are code-generated mutants of the buggy line (operator swaps, `±1` on integer
literals, argument swap, `max`↔`min`, slice flips, and every identifier in the line replaced by every
other identifier in the program), thinned deterministically to at most 60, sorted, with the gold
fix and the unchanged buggy line always present. 2 to 60 candidates per program (median 23.5).

```
state = { ...L0 state, buggy_line: "        return gcd(a % b, b)",
          candidates: { candidate_aa: "        return gcd(a % b, a)", candidate_ab: "        return gcd(a % b, b)", ... } }
questions.fix = choice(
  "`buggy_line` is the faulty line. Which entry of `candidates` is the correct replacement that makes all `tests` pass?",
  { candidate_aa: null, candidate_ab: null, ... })   // + none_of_these: null
```

Scoring: rank of the gold line / gold candidate in the returned probabilities (escape excluded),
top-1, top-3, MRR, P(truth) (the probability on the gold option), P(top). For selection every
top pick was also run against the program's JSON tests (`eval_candidates.py`, all tests the gold
solves within 2 s), giving **"Top-1 passes tests"**, which is what the synthesizer's test oracle
will see. Two programs have a second, semantically equivalent passing candidate
(`if perm[j] > perm[i]:` for next_permutation, `return 0 + levenshtein(...)` for levenshtein).

## 2. Variants (one change each, relative to the base)

| Id | Axis | Change |
| --- | --- | --- |
| La_nodesc | a criteria | option descriptions `null`; instructions add "Option `line_N` refers to `program.LN`." |
| Lb_opaque | b keys | keys `opt_aa`, `opt_ab`, … with descriptions = line text |
| Lb_opaque_nodesc | b keys | keys `opt_aa`… and descriptions `null` ("Options are listed in the same order as the lines of `program`.") |
| Lb_rawkey | b keys | the raw line text (trimmed) is the option key, descriptions `null` (built without the `choice()` builder, which rejects such keys) |
| Lc_string | c state | the whole state is one string: `Task: …\n\nProgram (line number: code):\n2: def gcd(a, b):\n…\n\nTests:\n- input: [17, 0]; expected: 17 …`; instructions "Which numbered line of the program contains the bug that makes the tests fail? …" |
| Ld_actual | d actual | each test gains `actual_output_of_buggy_program` (repr, `raises IndexError: …`, or `TIMEOUT (no result after 4 s; …)`) |
| Le_literal | e literal | instructions + " Answer carefully and literally." |
| Lf_docstring | f docstring | state gains `description` = the QuixBugs docstring (prose spec with examples) |
| Lg_noul_crit | g noul | one Noul per line: "Does line `program.L6` (`return gcd(a % b, b)`) contain the bug that makes `tests` fail? Exactly one line of `program` does." with true/false criteria (definition + 3 examples each, generic, not from these programs); ranked by P(yes) |
| Lg_noul_nocrit | g / a | the same Nouls without criteria |
| Lh_score5 | h score | one 5-level Score per line, levels as situations ("Certainly not the buggy line: …" … "Certainly the buggy line: changing this one line is what makes the tests pass"); ranked by expected level / 4 |
| L_combo | combo | opaque keys + descriptions + actual output + literal |
| Lg_noul_crit_actual | g + d | Nouls with criteria, state with actual output |
| Sa_desc | a criteria | option description = candidate text (candidates also still in state) |
| Sa_desc_only | a criteria | description = candidate text, `candidates` removed from state; instructions "… Which option is the correct replacement line …" |
| Sb_semantic | b keys | keys `replace_with_<slug of candidate>` (e.g. `replace_with_return_gcd_b_a_b`), descriptions `null` |
| Sb_rawkey | b keys | raw candidate text as key, descriptions `null` |
| Sc_string | c state | one string state; candidates listed as `candidate_aa: <text>` lines |
| Sd_actual, Se_literal, Sf_docstring | d, e, f | as for localisation |
| S_combo | combo | descriptions only + literal |
| S_no_unchanged | candidate set | as base but the unchanged buggy line is **not** a candidate (only `none_of_these` can say "no fix here") |
| S_combo_no_unchanged | combo | descriptions only + literal + unchanged line removed |
| Sg_noul_crit / Sg_noul_nocrit | g | one Noul per candidate: "Is `candidates.candidate_aa` (`<text>`) the correct replacement for `buggy_line` that makes all `tests` pass?" with / without criteria |
| Sh_score5 | h | one 5-level Score per candidate ("Certainly wrong: …" … "Certainly the fix: with this line every test passes") |

## 3. Results, pooled over runs (20 programs per run)

"wrong at P(top)>=0.7" counts confident wrong top picks (test-passing equivalents not counted as wrong).
"mean #opts>=0.5" is how many options per program the variant puts at or above 0.5 (a Choice always
sums to 1; for Nouls/Scores this is the number of options that would pass a 0.5 threshold).

| Variant | runs | Top-1 per run | mean Top-1 | mean Top-1 passes tests | mean Top-3 | MRR | mean P(truth) | mean P(top) | mean P(2nd) | mean #opts>=0.5 | wrong at P(top)>=0.7 | tokens/req | latency p50 ms | cost $ (all runs) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0_base | 4 | 16 / 18 / 16 / 18 | 17.00/20 | n/a | 18.00/20 | 0.89 | 0.60 | 0.68 | 0.12 | 0.8 | 8/80 | 832 | 245 | 0.0028 |
| La_nodesc | 4 | 16 / 16 / 16 / 16 | 16.00/20 | n/a | 17.50/20 | 0.85 | 0.60 | 0.68 | 0.11 | 0.8 | 5/80 | 706 | 202 | 0.0024 |
| Lb_opaque | 4 | 17 / 15 / 16 / 16 | 16.00/20 | n/a | 18.25/20 | 0.87 | 0.55 | 0.64 | 0.12 | 0.7 | 8/79 | 824 | 207 | 0.0027 |
| Lb_opaque_nodesc | 4 | 5 / 5 / 5 / 4 | 4.75/20 | n/a | 11.50/20 | 0.44 | 0.06 | 0.08 | 0.05 | 0.0 | 0/80 | 699 | 222 | 0.0023 |
| Lb_rawkey | 4 | 16 / 15 / 15 / 16 | 15.50/20 | n/a | 18.25/20 | 0.86 | 0.54 | 0.63 | 0.14 | 0.7 | 6/80 | 735 | 216 | 0.0025 |
| Lc_string | 4 | 16 / 15 / 17 / 16 | 16.00/20 | n/a | 18.00/20 | 0.87 | 0.56 | 0.64 | 0.14 | 0.7 | 5/80 | 736 | 206 | 0.0025 |
| Ld_actual | 4 | 18 / 17 / 17 / 17 | 17.25/20 | n/a | 18.75/20 | 0.90 | 0.66 | 0.73 | 0.10 | 0.9 | 1/80 | 901 | 220 | 0.0030 |
| Le_literal | 4 | 18 / 16 / 17 / 16 | 16.75/20 | n/a | 18.25/20 | 0.89 | 0.59 | 0.67 | 0.12 | 0.8 | 8/80 | 837 | 175 | 0.0028 |
| Lf_docstring | 4 | 15 / 14 / 14 / 14 | 14.25/20 | n/a | 18.00/20 | 0.81 | 0.56 | 0.67 | 0.11 | 0.8 | 8/80 | 944 | 189 | 0.0032 |
| Lg_noul_crit | 4 | 16 / 16 / 16 / 16 | 16.00/20 | n/a | 18.50/20 | 0.88 | 0.61 | 0.65 | 0.29 | 0.9 | 0/80 | 3094 | 207 | 0.0104 |
| Lg_noul_nocrit | 4 | 14 / 15 / 15 / 16 | 15.00/20 | n/a | 17.75/20 | 0.83 | 0.60 | 0.66 | 0.37 | 1.1 | 0/80 | 994 | 203 | 0.0033 |
| Lh_score5 | 4 | 16 / 16 / 16 / 17 | 16.25/20 | n/a | 17.00/20 | 0.86 | 0.64 | 0.69 | 0.39 | 1.2 | 2/80 | 2054 | 196 | 0.0069 |
| S0_base | 4 | 18 / 17 / 18 / 18 | 17.75/20 | 18.67/20 (3 runs) | 20.00/20 | 0.94 | 0.71 | 0.77 | 0.12 | 0.9 | 5/80 | 1261 | 194 | 0.0042 |
| Sa_desc | 4 | 17 / 18 / 18 / 18 | 17.75/20 | 19.00/20 (3 runs) | 20.00/20 | 0.94 | 0.77 | 0.85 | 0.11 | 1.0 | 5/80 | 1638 | 182 | 0.0055 |
| Sa_desc_only | 4 | 17 / 17 / 17 / 17 | 17.00/20 | 18.00/20 (3 runs) | 20.00/20 | 0.93 | 0.81 | 0.91 | 0.06 | 1.0 | 5/80 | 1177 | 187 | 0.0040 |
| Sb_semantic | 4 | 17 / 16 / 17 / 17 | 16.75/20 | 17.67/20 (3 runs) | 19.75/20 | 0.91 | 0.65 | 0.74 | 0.12 | 0.9 | 5/80 | 1582 | 191 | 0.0053 |
| Sb_rawkey | 4 | 17 / 17 / 17 / 17 | 17.00/20 | 18.00/20 (3 runs) | 20.00/20 | 0.93 | 0.76 | 0.85 | 0.11 | 1.0 | 5/80 | 1620 | 188 | 0.0054 |
| Sc_string | 4 | 11 / 11 / 11 / 11 | 11.00/20 | 13.00/20 (3 runs) | 20.00/20 | 0.77 | 0.60 | 0.75 | 0.17 | 0.9 | 6/80 | 1040 | 184 | 0.0035 |
| Sd_actual | 4 | 17 / 17 / 17 / 17 | 17.00/20 | 18.00/20 (3 runs) | 20.00/20 | 0.93 | 0.72 | 0.79 | 0.10 | 0.9 | 3/80 | 1331 | 183 | 0.0045 |
| Se_literal | 4 | 18 / 18 / 17 / 17 | 17.50/20 | 18.33/20 (3 runs) | 20.00/20 | 0.94 | 0.70 | 0.75 | 0.15 | 0.9 | 2/80 | 1266 | 191 | 0.0043 |
| Sf_docstring | 4 | 15 / 17 / 17 / 17 | 16.50/20 | 18.00/20 (3 runs) | 20.00/20 | 0.91 | 0.68 | 0.76 | 0.13 | 0.8 | 4/80 | 1373 | 192 | 0.0046 |
| Sg_noul_crit | 4 | 19 / 17 / 19 / 19 | 18.50/20 | 19.67/20 (3 runs) | 20.00/20 | 0.96 | 0.72 | 0.74 | 0.25 | 1.0 | 1/80 | 6448 | 215 | 0.0217 |
| Sg_noul_nocrit | 4 | 18 / 18 / 18 / 17 | 17.75/20 | 19.00/20 (3 runs) | 20.00/20 | 0.94 | 0.70 | 0.73 | 0.27 | 0.9 | 1/80 | 2134 | 193 | 0.0072 |
| Sh_score5 | 4 | 19 / 19 / 19 / 18 | 18.75/20 | 20.00/20 (3 runs) | 20.00/20 | 0.97 | 0.75 | 0.76 | 0.20 | 1.0 | 1/80 | 4314 | 211 | 0.0145 |
| L_combo | 3 | 17 / 17 / 17 | 17.00/20 | n/a | 18.00/20 | 0.89 | 0.62 | 0.69 | 0.12 | 0.9 | 1/60 | 897 | 201 | 0.0023 |
| Lg_noul_crit_actual | 3 | 18 / 18 / 18 | 18.00/20 | n/a | 19.00/20 | 0.94 | 0.67 | 0.69 | 0.27 | 0.9 | 0/60 | 3163 | 203 | 0.0080 |
| S_combo | 3 | 17 / 18 / 17 | 17.33/20 | 18.33/20 (3 runs) | 20.00/20 | 0.93 | 0.82 | 0.91 | 0.06 | 1.0 | 3/60 | 1182 | 193 | 0.0030 |
| S_no_unchanged | 2 | 19 / 19 | 19.00/20 | 20.00/20 (2 runs) | 20.00/20 | 0.97 | 0.75 | 0.79 | 0.03 | 0.9 | 0/40 | 1236 | 201 | 0.0021 |
| S_combo_no_unchanged | 2 | 19 / 19 | 19.00/20 | 20.00/20 (2 runs) | 20.00/20 | 0.97 | 0.86 | 0.90 | 0.02 | 0.9 | 0/40 | 1160 | 202 | 0.0019 |

**Correction (verification 2026-09-20):** run 1 was recorded before the test oracle existed (its rows have no
`topText`/`topPasses`), so in run 1 the next_permutation top pick, which in runs 2 to 4 was always the
test-passing equivalent `if perm[j] > perm[i]:`, is counted in "wrong at P(top)>=0.7" whenever its P(top) was
≥ 0.7. Presuming the run-1 pick was the same line (its text was not recorded), the corrected selection counts are:
S0_base 4/80, Sa_desc 4/80, Sa_desc_only 4/80, Sb_semantic 4/80, Sb_rawkey 4/80, Sd_actual 2/80, Sg_noul_crit 0/80,
Sg_noul_nocrit 0/80, Sh_score5 0/80; Sc_string 6/80, Se_literal 2/80, Sf_docstring 4/80 and all no-unchanged / combo
rows are unaffected. The same run-1 items lower the selection precision cells at ≥ 0.7 / ≥ 0.9 in the threshold
table below by about 0.01 to 0.02 (e.g. Sa_desc at ≥ 0.9 is 1.00, not 0.98). Localisation rows are unaffected
(no oracle applies).


### Threshold behaviour (pooled): coverage = share of programs whose top pick has P(top) ≥ t; precision = share of those that are correct (gold or test-passing)

| Variant | n | P(top)>=0.3: cov / prec | >=0.5 | >=0.7 | >=0.9 | share with P(truth)>=0.5 |
| --- | --- | --- | --- | --- | --- | --- |
| L0_base | 80 | 0.89 / 0.86 | 0.79 / 0.87 | 0.59 / 0.83 | 0.29 / 0.83 | 0.69 |
| La_nodesc | 80 | 0.85 / 0.84 | 0.78 / 0.87 | 0.56 / 0.89 | 0.21 / 1.00 | 0.68 |
| Lb_opaque | 79 | 0.87 / 0.81 | 0.67 / 0.85 | 0.53 / 0.81 | 0.13 / 1.00 | 0.57 |
| Lb_rawkey | 80 | 0.89 / 0.79 | 0.68 / 0.80 | 0.47 / 0.84 | 0.20 / 0.94 | 0.54 |
| Lc_string | 80 | 0.85 / 0.78 | 0.72 / 0.86 | 0.55 / 0.89 | 0.10 / 1.00 | 0.62 |
| Ld_actual | 80 | 0.90 / 0.89 | 0.90 / 0.89 | 0.60 / 0.98 | 0.24 / 1.00 | 0.80 |
| Le_literal | 80 | 0.89 / 0.85 | 0.78 / 0.87 | 0.57 / 0.83 | 0.26 / 0.90 | 0.68 |
| Lf_docstring | 80 | 0.86 / 0.70 | 0.72 / 0.83 | 0.57 / 0.83 | 0.25 / 0.85 | 0.60 |
| L_combo | 60 | 0.90 / 0.89 | 0.88 / 0.89 | 0.48 / 0.97 | 0.25 / 1.00 | 0.78 |
| Lg_noul_crit | 80 | 0.95 / 0.80 | 0.76 / 0.85 | 0.38 / 1.00 | 0.17 / 1.00 | 0.70 |
| Lg_noul_nocrit | 80 | 0.99 / 0.75 | 0.81 / 0.77 | 0.38 / 1.00 | 0.05 / 1.00 | 0.71 |
| Lg_noul_crit_actual | 60 | 0.90 / 0.89 | 0.80 / 1.00 | 0.62 / 1.00 | 0.15 / 1.00 | 0.80 |
| Lh_score5 | 80 | 0.94 / 0.81 | 0.85 / 0.85 | 0.53 / 0.95 | 0.26 / 1.00 | 0.75 |
| S0_base | 80 | 1.00 / 0.93 | 0.94 / 0.93 | 0.69 / 0.91 | 0.39 / 1.00 | 0.84 |
| Sa_desc | 80 | 1.00 / 0.93 | 1.00 / 0.93 | 0.84 / 0.93 | 0.54 / 0.98 | 0.89 |
| Sa_desc_only | 80 | 1.00 / 0.89 | 1.00 / 0.89 | 0.91 / 0.93 | 0.69 / 1.00 | 0.85 |
| Sb_semantic | 80 | 1.00 / 0.88 | 0.82 / 0.88 | 0.61 / 0.90 | 0.25 / 1.00 | 0.69 |
| Sb_rawkey | 80 | 1.00 / 0.89 | 1.00 / 0.89 | 0.82 / 0.92 | 0.50 / 1.00 | 0.85 |
| Sc_string | 80 | 1.00 / 0.62 | 0.91 / 0.68 | 0.57 / 0.87 | 0.30 / 1.00 | 0.55 |
| Sd_actual | 80 | 1.00 / 0.89 | 0.91 / 0.89 | 0.68 / 0.94 | 0.42 / 1.00 | 0.78 |
| Se_literal | 80 | 1.00 / 0.91 | 0.91 / 0.93 | 0.56 / 0.96 | 0.39 / 1.00 | 0.81 |
| Sf_docstring | 80 | 1.00 / 0.86 | 0.84 / 0.88 | 0.64 / 0.92 | 0.39 / 1.00 | 0.70 |
| S_combo | 60 | 1.00 / 0.92 | 0.98 / 0.92 | 0.92 / 0.95 | 0.72 / 1.00 | 0.85 |
| S_no_unchanged | 40 | 0.95 / 1.00 | 0.93 / 1.00 | 0.80 / 1.00 | 0.35 / 1.00 | 0.88 |
| S_combo_no_unchanged | 40 | 1.00 / 1.00 | 0.95 / 1.00 | 0.90 / 1.00 | 0.72 / 1.00 | 0.90 |
| Sg_noul_crit | 80 | 0.95 / 0.99 | 0.89 / 0.99 | 0.74 / 0.98 | 0.17 / 1.00 | 0.85 |
| Sg_noul_nocrit | 80 | 1.00 / 0.94 | 0.85 / 0.99 | 0.68 / 0.98 | 0.20 / 1.00 | 0.80 |
| Sh_score5 | 80 | 0.95 / 0.99 | 0.85 / 0.99 | 0.76 / 0.98 | 0.30 / 1.00 | 0.85 |

Calibration of P(top) pooled over all Choice variants (excluding the broken `Lb_opaque_nodesc`):
localisation 0.0–0.2 → 73 % correct (n 51), 0.2–0.4 → 62 % (76), 0.4–0.6 → 80 % (105),
0.6–0.8 → 80 % (197), 0.8–1.0 → 89 % (270); selection 0.4–0.6 → 73 % (132), 0.6–0.8 → 80 % (228),
0.8–1.0 → 96 % (494). Ranking is monotone but a 0.9 on a Choice is not a 0.9 accuracy on this
task: the confident misses are concentrated in two programs (below).

## 4. Per-item rows (n = 20), run 4; cell = rank of the gold option (P(gold)); `*` = the top pick is a different candidate that passes all tests; `-` = request rejected

Per-program, localisation: cell = rank of the true line (P(truth)); "-" = request rejected

| program | lines | L0_base | La_nodesc | Lb_opaque | Lb_opaque_nodesc | Lb_rawkey | Lc_string | Ld_actual | Le_literal | Lf_docstring | Lg_noul_crit | Lg_noul_nocrit | Lh_score5 | L_combo | Lg_noul_crit_actual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | 6 | 1 (0.25) | 1 (0.20) | 1 (0.17) | 5 (0.01) | 1 (0.21) | 1 (0.17) | 1 (0.68) | 1 (0.19) | 1 (0.12) | 1 (0.26) | 1 (0.36) | 1 (0.24) | 1 (0.72) | 1 (0.75) |
| bucketsort | 8 | 1 (0.94) | 1 (0.93) | 1 (0.89) | 7 (0.03) | 1 (0.88) | 1 (0.89) | 1 (0.92) | 1 (0.92) | 1 (0.97) | 1 (0.89) | 1 (0.88) | 1 (0.94) | 1 (0.90) | 1 (0.85) |
| find_first_in_sorted | 12 | 1 (0.67) | 1 (0.77) | 1 (0.70) | 8 (0.01) | 1 (0.72) | 1 (0.79) | 1 (0.78) | 1 (0.70) | 1 (0.68) | 1 (0.64) | 1 (0.66) | 1 (0.61) | 1 (0.64) | 1 (0.77) |
| find_in_sorted | 12 | 1 (0.56) | 1 (0.51) | 1 (0.47) | 2 (0.05) | 1 (0.35) | 1 (0.55) | 1 (0.80) | 1 (0.54) | 3 (0.25) | 1 (0.66) | 1 (0.72) | 1 (0.74) | 1 (0.70) | 1 (0.85) |
| flatten | 7 | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.09) | 1 (0.99) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.96) | 1 (0.96) | 1 (0.99) | 1 (1.00) | 1 (0.97) |
| gcd | 5 | 1 (0.88) | 1 (0.87) | 1 (0.78) | 1 (0.28) | 1 (0.79) | 1 (0.81) | 1 (0.88) | 1 (0.82) | 1 (0.77) | 1 (0.59) | 1 (0.57) | 1 (0.66) | 1 (0.84) | 1 (0.84) |
| get_factors | 7 | 1 (0.74) | 1 (0.79) | 1 (0.64) | 7 (0.03) | 2 (0.27) | 1 (0.79) | 1 (0.75) | 1 (0.73) | 1 (0.89) | 1 (0.89) | 1 (0.84) | 1 (0.93) | 1 (0.63) | 1 (0.85) |
| hanoi | 8 | 1 (0.90) | 1 (0.87) | 1 (0.84) | 1 (0.15) | 1 (0.85) | 1 (0.78) | 1 (0.92) | 1 (0.89) | 1 (0.86) | 1 (0.88) | 1 (0.87) | 1 (0.93) | 1 (0.92) | 1 (0.93) |
| is_valid_parenthesization | 10 | 1 (0.90) | 1 (0.93) | 1 (0.89) | 2 (0.04) | 1 (0.90) | 1 (0.76) | 1 (0.95) | 1 (0.90) | 1 (0.87) | 1 (0.67) | 1 (0.76) | 1 (0.76) | 1 (0.95) | 1 (0.76) |
| kheapsort | 8 | 1 (0.38) | 2 (0.31) | 1 (0.33) | 3 (0.05) | 1 (0.39) | 1 (0.50) | 1 (0.58) | 1 (0.34) | 3 (0.25) | 1 (0.52) | 2 (0.54) | 1 (0.67) | 1 (0.56) | 1 (0.69) |
| knapsack | 13 | 1 (0.80) | 1 (0.58) | 1 (0.84) | 11 (0.01) | 1 (0.79) | 1 (0.85) | 1 (0.89) | 1 (0.76) | 1 (0.86) | 1 (0.73) | 1 (0.63) | 1 (0.79) | 1 (0.82) | 1 (0.82) |
| kth | 12 | 1 (0.58) | 1 (0.69) | 2 (0.39) | 1 (0.05) | 1 (0.49) | 2 (0.40) | 1 (0.67) | 1 (0.54) | 1 (0.66) | 2 (0.62) | 1 (0.66) | 1 (0.77) | 1 (0.55) | 1 (0.69) |
| lcs_length | 8 | 1 (0.65) | 1 (0.72) | 1 (0.67) | 8 (0.02) | 1 (0.54) | 1 (0.73) | 1 (0.70) | 1 (0.65) | 1 (0.70) | 1 (0.61) | 1 (0.58) | 1 (0.59) | 1 (0.65) | 1 (0.66) |
| levenshtein | 11 | 1 (0.79) | 1 (0.85) | 1 (0.48) | 2 (0.05) | 1 (0.50) | 1 (0.51) | 1 (0.87) | 1 (0.76) | 1 (0.83) | 1 (0.87) | 1 (0.86) | 1 (0.89) | 1 (0.44) | 1 (0.89) |
| lis | 10 | 4 (0.02) | 7 (0.01) | 7 (0.01) | 2 (0.05) | 7 (0.01) | 9 (0.01) | 4 (0.02) | 4 (0.03) | 9 (0.00) | 5 (0.14) | 3 (0.21) | 5 (0.26) | 5 (0.02) | 5 (0.10) |
| longest_common_subsequence | 11 | 1 (0.32) | 2 (0.16) | 2 (0.17) | 2 (0.04) | 2 (0.20) | 1 (0.23) | 3 (0.06) | 2 (0.22) | 2 (0.18) | 1 (0.44) | 1 (0.41) | 1 (0.23) | 3 (0.05) | 1 (0.12) |
| max_sublist_sum | 7 | 1 (0.59) | 1 (0.52) | 1 (0.54) | 3 (0.05) | 1 (0.53) | 2 (0.33) | 1 (0.75) | 1 (0.45) | 2 (0.21) | 1 (0.45) | 1 (0.45) | 1 (0.61) | 1 (0.64) | 1 (0.71) |
| mergesort | 21 | 16 (0.00) | 17 (0.00) | 4 (0.01) | 21 (0.00) | 4 (0.01) | 5 (0.01) | 3 (0.06) | 3 (0.01) | 17 (0.00) | 2 (0.10) | 3 (0.09) | 4 (0.08) | 4 (0.06) | 2 (0.18) |
| next_palindrome | 15 | 1 (0.17) | 1 (0.20) | 1 (0.17) | 15 (0.02) | 1 (0.22) | 1 (0.19) | 1 (0.17) | 4 (0.10) | 1 (0.19) | 3 (0.30) | 8 (0.26) | 10 (0.22) | 1 (0.18) | 1 (0.19) |
| next_permutation | 9 | 1 (0.99) | 1 (0.98) | 1 (0.96) | 3 (0.04) | 1 (0.99) | 1 (0.95) | 1 (0.99) | 1 (0.98) | 1 (0.99) | 1 (0.93) | 1 (0.89) | 1 (0.94) | 1 (0.99) | 1 (0.94) |

Per-program, selection: cell = rank of the true candidate (P(truth)); "-" = request rejected

| program | cands | S0_base | Sa_desc | Sa_desc_only | Sb_semantic | Sb_rawkey | Sc_string | Sd_actual | Se_literal | Sf_docstring | S_combo | S_no_unchanged | S_combo_no_unchanged | Sg_noul_crit | Sg_noul_nocrit | Sh_score5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | 9 | 1 (0.90) | 1 (0.94) | 1 (0.98) | 1 (0.70) | 1 (0.92) | 1 (0.96) | 1 (0.98) | 1 (0.89) | 1 (0.90) | 1 (0.97) | 1 (0.98) | 1 (0.99) | 1 (0.89) | 1 (0.84) | 1 (0.94) |
| bucketsort | 37 | 1 (0.92) | 1 (0.99) | 1 (1.00) | 1 (0.82) | 1 (0.97) | 1 (0.97) | 1 (0.93) | 1 (0.93) | 1 (0.96) | 1 (1.00) | 1 (0.98) | 1 (1.00) | 1 (0.96) | 1 (0.96) | 1 (0.96) |
| find_first_in_sorted | 14 | 1 (0.73) | 1 (0.83) | 1 (0.96) | 1 (0.54) | 1 (0.84) | 1 (0.63) | 1 (0.75) | 1 (0.79) | 1 (0.67) | 1 (0.98) | 1 (0.78) | 1 (0.93) | 1 (0.56) | 1 (0.48) | 1 (0.50) |
| find_in_sorted | 24 | 1 (0.97) | 1 (0.99) | 1 (1.00) | 1 (0.98) | 1 (0.99) | 1 (0.95) | 1 (0.98) | 1 (0.97) | 1 (0.97) | 1 (1.00) | 1 (0.98) | 1 (1.00) | 1 (0.88) | 1 (0.87) | 1 (0.92) |
| flatten | 12 | 1 (0.99) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.98) | 1 (0.98) | 1 (0.99) | 1 (0.99) | 1 (0.99) | 1 (1.00) | 1 (0.99) | 1 (1.00) | 1 (0.96) | 1 (0.97) | 1 (0.98) |
| gcd | 10 | 1 (0.53) | 1 (0.72) | 1 (0.97) | 1 (0.61) | 1 (0.75) | 2 (0.26) | 1 (0.66) | 2 (0.43) | 2 (0.31) | 1 (0.98) | 1 (0.83) | 1 (0.97) | 1 (0.76) | 1 (0.70) | 1 (0.83) |
| get_factors | 2 | 1 (1.00) | 1 (1.00) | 1 (0.99) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.99) | 1 (1.00) | 1 (0.99) | 1 (0.93) | 1 (0.94) | 1 (0.96) |
| hanoi | 34 | 1 (0.61) | 1 (0.77) | 1 (0.89) | 1 (0.58) | 1 (0.59) | 2 (0.34) | 1 (0.77) | 1 (0.53) | 1 (0.45) | 1 (0.91) | 1 (0.65) | 1 (0.79) | 1 (0.66) | 1 (0.80) | 1 (0.85) |
| is_valid_parenthesization | 3 | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (1.00) | 1 (0.90) | 1 (0.93) | 1 (0.94) |
| kheapsort | 18 | 1 (0.77) | 1 (0.91) | 1 (0.95) | 1 (0.85) | 1 (0.93) | 1 (0.74) | 1 (0.90) | 1 (0.80) | 1 (0.63) | 1 (0.93) | 1 (0.89) | 1 (0.96) | 1 (0.69) | 1 (0.75) | 1 (0.69) |
| knapsack | 29 | 1 (0.92) | 1 (0.97) | 1 (0.99) | 1 (0.85) | 1 (0.96) | 1 (0.89) | 1 (0.93) | 1 (0.94) | 1 (0.97) | 1 (0.98) | 1 (0.83) | 1 (0.99) | 1 (0.80) | 1 (0.67) | 1 (0.80) |
| kth | 30 | 1 (0.76) | 1 (0.96) | 1 (0.97) | 1 (0.88) | 1 (0.95) | 1 (0.82) | 1 (0.77) | 1 (0.67) | 1 (0.85) | 1 (0.95) | 1 (0.81) | 1 (0.96) | 1 (0.71) | 1 (0.71) | 1 (0.69) |
| lcs_length | 60 | 1 (0.55) | 1 (0.60) | 2 (0.26) | 2 (0.15) | 2 (0.35) | 2 (0.39) | 1 (0.47) | 1 (0.47) | 1 (0.42) | 2 (0.28) | 1 (0.57) | 1 (0.60) | 1 (0.54) | 1 (0.51) | 1 (0.68) |
| levenshtein | 23 | 1 (0.71) | 1 (0.75) | 1 (0.63) | 1 (0.83) | 1 (0.74) | 2* (0.39) | 1 (0.69) | 1 (0.62) | 1 (0.77) | 1 (0.73) | 1 (0.77) | 1 (0.89) | 1 (0.85) | 2* (0.71) | 2* (0.83) |
| lis | 27 | 1 (0.40) | 1 (0.65) | 1 (0.76) | 1 (0.48) | 1 (0.58) | 2 (0.33) | 1 (0.48) | 1 (0.41) | 1 (0.43) | 1 (0.78) | 1 (0.53) | 1 (0.83) | 1 (0.41) | 1 (0.35) | 1 (0.40) |
| longest_common_subsequence | 29 | 1 (0.67) | 1 (0.74) | 1 (0.97) | 1 (0.58) | 1 (0.73) | 2 (0.36) | 2 (0.28) | 1 (0.54) | 1 (0.77) | 1 (0.95) | 1 (0.40) | 1 (0.94) | 1 (0.80) | 1 (0.70) | 1 (0.76) |
| max_sublist_sum | 18 | 1 (0.94) | 1 (0.96) | 1 (0.93) | 1 (0.95) | 1 (0.96) | 1 (0.65) | 1 (0.99) | 1 (0.95) | 1 (0.93) | 1 (0.93) | 1 (0.94) | 1 (0.90) | 1 (0.78) | 1 (0.70) | 1 (0.80) |
| mergesort | 26 | 1 (0.54) | 1 (0.75) | 1 (0.84) | 1 (0.41) | 1 (0.86) | 2 (0.27) | 1 (0.64) | 1 (0.57) | 1 (0.51) | 1 (0.89) | 1 (0.70) | 1 (0.93) | 1 (0.74) | 1 (0.74) | 1 (0.74) |
| next_palindrome | 18 | 2 (0.10) | 2 (0.10) | 2 (0.10) | 2 (0.02) | 2 (0.08) | 2 (0.10) | 2 (0.11) | 2 (0.13) | 2 (0.12) | 2 (0.12) | 1 (0.13) | 1 (0.41) | 1 (0.23) | 2 (0.19) | 1 (0.23) |
| next_permutation | 36 | 2* (0.08) | 2* (0.03) | 2* (0.06) | 3* (0.02) | 2* (0.04) | 2* (0.15) | 2* (0.06) | 2* (0.15) | 2* (0.06) | 2* (0.06) | 2* (0.08) | 2* (0.02) | 2* (0.50) | 2* (0.43) | 2* (0.71) |

### Pooled per-program view of the two base questions (4 runs)

Per-program pooled, L0_base (localisation): top-1 hits over runs, P(truth) per run

| program | options | top-1 hits | P(truth) per run | top pick when wrong |
| --- | --- | --- | --- | --- |
| bitcount | 6 | 4/4 | 0.18, 0.15, 0.13, 0.25 |  |
| bucketsort | 8 | 4/4 | 0.93, 0.92, 0.93, 0.94 |  |
| find_first_in_sorted | 12 | 4/4 | 0.77, 0.72, 0.72, 0.67 |  |
| find_in_sorted | 12 | 4/4 | 0.56, 0.60, 0.52, 0.56 |  |
| flatten | 7 | 4/4 | 1.00, 1.00, 1.00, 1.00 |  |
| gcd | 5 | 4/4 | 0.85, 0.89, 0.87, 0.88 |  |
| get_factors | 7 | 4/4 | 0.70, 0.77, 0.73, 0.74 |  |
| hanoi | 8 | 4/4 | 0.88, 0.93, 0.91, 0.90 |  |
| is_valid_parenthesization | 10 | 4/4 | 0.92, 0.90, 0.90, 0.90 |  |
| kheapsort | 8 | 4/4 | 0.42, 0.34, 0.40, 0.38 |  |
| knapsack | 13 | 4/4 | 0.78, 0.81, 0.74, 0.80 |  |
| kth | 12 | 4/4 | 0.50, 0.52, 0.49, 0.58 |  |
| lcs_length | 8 | 4/4 | 0.65, 0.67, 0.62, 0.65 |  |
| levenshtein | 11 | 4/4 | 0.79, 0.81, 0.78, 0.79 |  |
| lis | 10 | 0/4 | 0.02, 0.02, 0.01, 0.02 | `if length == longest or val < arr[ends[length + 1]]:` (0.75) |
| longest_common_subsequence | 11 | 2/4 | 0.26, 0.26, 0.21, 0.32 | `key=len` (0.30) |
| max_sublist_sum | 7 | 4/4 | 0.54, 0.66, 0.55, 0.59 |  |
| mergesort | 21 | 0/4 | 0.00, 0.00, 0.00, 0.00 | `result.extend(left[i:] or right[j:])` (0.93) |
| next_palindrome | 15 | 2/4 | 0.17, 0.24, 0.13, 0.17 | `while high_mid < len(digit_list) and low_mid >= 0:` (0.15) |
| next_permutation | 9 | 4/4 | 0.99, 0.98, 0.99, 0.99 |  |

Per-program pooled, S0_base (selection): top-1 hits over runs, P(truth) per run

| program | options | top-1 hits | P(truth) per run | top pick when wrong |
| --- | --- | --- | --- | --- |
| bitcount | 9 | 4/4 | 0.91, 0.88, 0.93, 0.90 |  |
| bucketsort | 37 | 4/4 | 0.93, 0.92, 0.93, 0.92 |  |
| find_first_in_sorted | 14 | 4/4 | 0.73, 0.77, 0.74, 0.73 |  |
| find_in_sorted | 24 | 4/4 | 0.97, 0.96, 0.97, 0.97 |  |
| flatten | 12 | 4/4 | 0.99, 0.99, 0.99, 0.99 |  |
| gcd | 10 | 3/4 | 0.47, 0.41, 0.52, 0.53 | `return gcd(a % b, b)` (0.49) |
| get_factors | 2 | 4/4 | 1.00, 1.00, 1.00, 1.00 |  |
| hanoi | 34 | 4/4 | 0.54, 0.71, 0.63, 0.61 |  |
| is_valid_parenthesization | 3 | 4/4 | 1.00, 1.00, 1.00, 1.00 |  |
| kheapsort | 18 | 4/4 | 0.79, 0.82, 0.79, 0.77 |  |
| knapsack | 29 | 4/4 | 0.90, 0.91, 0.92, 0.92 |  |
| kth | 30 | 4/4 | 0.76, 0.71, 0.74, 0.76 |  |
| lcs_length | 60 | 4/4 | 0.56, 0.59, 0.62, 0.55 |  |
| levenshtein | 23 | 4/4 | 0.67, 0.74, 0.74, 0.71 |  |
| lis | 27 | 4/4 | 0.46, 0.54, 0.39, 0.40 |  |
| longest_common_subsequence | 29 | 4/4 | 0.59, 0.60, 0.68, 0.67 |  |
| max_sublist_sum | 18 | 4/4 | 0.94, 0.93, 0.95, 0.94 |  |
| mergesort | 26 | 4/4 | 0.55, 0.55, 0.54, 0.54 |  |
| next_palindrome | 18 | 0/4 | 0.12, 0.10, 0.11, 0.10 | `return [1] + (len(digit_list)) * [0] + [1]` (0.73) |
| next_permutation | 36 | 0/4 | 0.10, 0.09, 0.05, 0.08 | `if perm[j] > perm[i]:` (0.67, passes tests) |

Repeat stability, L0_base: all samples across runs (rep 0..4 per run)

| program | samples | P(truth) min..max | max spread | argmax flips |
| --- | --- | --- | --- | --- |
| bitcount | 20 | 0.13..0.31 | 0.18 | 0 |
| bucketsort | 20 | 0.92..0.95 | 0.03 | 0 |
| find_first_in_sorted | 20 | 0.67..0.78 | 0.11 | 0 |
| find_in_sorted | 20 | 0.43..0.60 | 0.17 | 0 |
| flatten | 20 | 1.00..1.00 | 0.00 | 0 |


## 5. Reading the table: what moved and what did not

Robust effects (same direction in every run):

| Finding | Evidence |
| --- | --- |
| **The option must be tied to the code by key or by description; order alone is useless.** | `Lb_opaque_nodesc` (keys `opt_aa`…, no descriptions, "listed in the same order as the lines") collapses to 4–5/20 with 0.67 of the mass on `none_of_these`. Every other way of naming the line (`line_N` ↔ `program.LN`, opaque key + line text, raw line as key) lands in the same 15.5–17/20 band. Jev cannot count positions (REPORT §10, indirection), so the key must name the thing. |
| **Descriptions are the strongest lever for selection sharpness, not accuracy.** | Adding the candidate text as the option description raises mean P(gold) from 0.71 to 0.77 (`Sa_desc`) and 0.81–0.82 when the candidates are *only* in the descriptions (`Sa_desc_only`, `S_combo`), with P(top) 0.91 and the runner-up down to 0.06. Top-1 is unchanged (17–18/20) and the single loss is lcs_length (60 candidates): with text in descriptions Jev prefers `dp[i - 1, j] + 1` over the gold `dp[i - 1, j - 1] + 1` in 4 of 4 runs for `Sa_desc_only` and `Sb_rawkey`, 2 of 3 for `S_combo`, 1 of 4 for `Sa_desc`, and 0 of 2 once the unchanged line is removed (`S_combo_no_unchanged`). |
| **Actual output helps localisation confidence and removes confident misses.** | `Ld_actual`: mean P(gold) 0.60 → 0.66, top-3 18 → 18.75, confident wrong picks 8/80 → 1/80, precision at P(top) ≥ 0.7 0.83 → 0.98; bitcount goes 0.18 → 0.62–0.68 (the actual output is `TIMEOUT`, which points at the loop). For selection it does nothing (17/20, P 0.72). |
| **The unchanged buggy line must not be a candidate.** | It is a confident-wrong attractor: next_palindrome picks the unchanged line at 0.70–0.85 in every Choice variant that contains it (0/4 in base), gcd picks it at 0.49 in one run, and in the string state it took mergesort and lis too. Removing it (`S_no_unchanged`, `S_combo_no_unchanged`) gives 19/20 top-1 and **20/20 test-passing top picks** in both runs, 0 confident misses out of 40, with `none_of_these` at 0.17 / 0.07 absorbing the doubt. |
| **A single string state is fine for localisation and bad for selection.** | `Lc_string` 16/20 (same band as base). `Sc_string` 11/20 in all four runs: when the candidate list is text, Jev picks the unchanged line or a near-duplicate mutant far more often (9/20 wrong picks in run 2 versus 3 for the JSON state). Keep candidates as a JSON object whose keys are the option keys. |
| **The docstring hurts.** | `Lf_docstring` 14.25/20 (worst non-broken localisation variant, 4 runs); `Sf_docstring` 16.5/20. Extra prose about intended behaviour pulls attention to plausible-looking lines (`return -1`, `heap = arr[:k]`, `max_so_far = 0`) rather than to the discrepancy with the tests. |
| **Semantic slugs of code are worse keys than opaque keys.** | `Sb_semantic` (`replace_with_dp_i_j_dp_i_1_j_1_1`) P(gold) 0.65 vs 0.71 base, 16.75/20, escape mass 0.12. Snake-cased code loses the operators that distinguish the candidates. Raw code as a key is accepted by the API and performs like a description (0.76). |
| **Criteria on Nouls: +1 program (within the ±2 noise band) and calmer probabilities.** | `Lg_noul_crit` 16/20 in all four runs vs `Lg_noul_nocrit` 14–16; runner-up mean 0.29 vs 0.37, options ≥ 0.5 0.9 vs 1.1 per program. Selection: 18.5 vs 17.75 top-1, 19.67 vs 19.0 test-passing. Criteria cost 3× the tokens (3,094 vs 994 per request) because they are repeated per question. |
| **Per-option Noul/Score beats a Choice for selection, ties for localisation.** | Selection: `Sh_score5` 18.75/20 top-1 and 20/20 test-passing in all 3 oracle runs, `Sg_noul_crit` 18.5 / 19.67, versus 17.75 / 18.67 for the base Choice, and their confident-wrong rate is 0/80 vs 4/80 (after the run-1 oracle correction above; the table prints 1/80 vs 5/80). The +1 top-1 difference is inside this study's own ±2 noise band; the robust part is the 20/20 test-passing rate and the confident-miss count. Localisation: 16–16.25/20, same as the Choice, but with an absolute scale: the gold line's P(yes) is never below 0.08–0.09 (Choice: 0.00 for mergesort) and 0.38 of programs reach P(top) ≥ 0.7 with 100 % precision. Cost 2.5–5× the Choice. |
| **"Answer carefully and literally" is neutral.** | 16.75 vs 17.0 (loc), 17.5 vs 17.75 (sel); it shaved confident misses on selection (2/80 vs 4/80 corrected) but that is within noise. |

Persistent misses (all variants, all runs), which are properties of the task and not of the
question shape:

- **lis** localisation: gold `longest = length + 1` (missing `max(longest, …)`) gets 0.01–0.02;
  Jev puts 0.6–0.8 on the condition line `if length == longest or val < arr[ends[length + 1]]:`
  two lines above. Selection over candidates at the gold line is right at 0.4–0.5. A synthesizer
  that only tries the top-1 line never fixes lis; one that tries the top-3 lines does not either
  (rank 4–9 in every Choice/Score variant; one `Lg_noul_nocrit` run had it at rank 3, and the broken
  `Lb_opaque_nodesc` at rank 2 by accident). Only a coverage-based or "try every line that has a passing candidate" strategy
  reaches it.
- **mergesort** localisation: gold `if len(arr) == 0:` at 0.00; 0.9 goes to
  `result.extend(left[i:] or right[j:])`, a correct but unusual idiom. This is the clearest
  confident-wrong case (P(top) 0.92, rank 16–17 for the gold with `line_N` keys, 3–5 with opaque
  keys or actual output (one `Lb_opaque` run and three `La_nodesc` runs still at 17), 2 with Nouls + actual). Once the line is given, selection is right at 0.54–0.93.
- **next_palindrome** selection: the fix is `len(digit_list)` → `len(digit_list) - 1`, an
  off-by-one that requires counting the output length. Every Choice with the unchanged line
  present picks the unchanged line; removing it or asking per-option Nouls/Scores fixes it
  (P(gold) 0.13–0.41, still the weakest item).
- **next_permutation** selection: the "miss" is `if perm[j] > perm[i]:`, equivalent to the gold
  and passing all tests. Gold-line accuracy under-reports selection quality by one program; use
  the test oracle as the metric.

Repeat stability (base localisation, 5 samples per run × 4 runs = 20 samples per program):
max spread of P(gold) 0.00 (flatten, at 1.00), 0.03 (bucketsort), 0.11 (find_first_in_sorted),
0.17 (find_in_sorted, 0.43–0.60), 0.18 (bitcount, 0.13–0.31); **0 argmax flips in 100 samples**.
REPORT §6 measured sd 0.000 at the extremes and up to 0.026 in the 0.55–0.80 band (and a flat Choice whose
top option ranged 0.49–0.60 over 30 repeats); here, in the 0.15–0.6 band the same request varies by up to
0.18 between calls (0.26 for find_in_sorted in the 5 extra verification repeats), so any threshold placed there is a coin flip on
individual items. Aggregate top-1 over 20 programs moves by up to 2 between runs of the same variant.

## 6. Recommendation per question the jev-only synthesizer asks

| Question | Recommended shape | Measured | Cost / latency per program |
| --- | --- | --- | --- |
| **Which line is buggy** (localisation over ≤ 255 lines of a function; note that top-1/top-3 here rank the line options with `none_of_these` excluded: in `Ld_actual` the escape out-scored every line on 8/80 items (longest_common_subsequence and next_palindrome in all 4 runs), so a loop that honours the escape as the argmax covers 2 fewer programs) | JSON state `{task, program: {L<n>: text}, tests: [{input, expected, actual_output_of_buggy_program}]}`; Choice with keys `line_<n>` and the line text as description; `none_of_these` escape; no docstring. Take the **top-3** (or every line whose P ≥ 0.10) into the candidate stage; treat P(top) ≥ 0.7 as "trust" (precision 0.98 with actual output). | `Ld_actual`: 17.25/20 top-1, 18.75/20 top-3, P(gold) 0.66, 1/80 confident misses | ~900 tokens, $0.00004, 1 request, ~220 ms |
| Same, when an absolute score per line is needed (to decide "no line here, widen the search") | Noul per line with definition+examples criteria and actual output (`Lg_noul_crit_actual`): P(yes) is on an absolute scale, the gold is never below 0.09, and P(top) ≥ 0.5 was correct 100 % of the time (48/48). | 18/20 top-1 (3 runs), 19/20 top-3, P(gold) 0.67 | ~3,200 tokens, $0.00013, 1 request, ~200 ms |
| **Which candidate replacement is the fix** (selection over ≤ 255 candidates) | Drop the unchanged line from the candidate set. JSON state with `buggy_line`, candidates only as option descriptions (`candidate_<xx>` keys, text as description), "Answer carefully and literally.", `none_of_these` escape (`S_combo_no_unchanged`). Verify the top pick with the tests; if it fails, try the next candidates in probability order until P < 0.05. | 19/20 top-1, **20/20 test-passing top pick**, P(gold) 0.86, P(top) 0.90, 0/40 confident misses (with the escape excluded from the ranking; on next_palindrome `none_of_these` at 0.41–0.45 out-scored the gold in both runs, so an escape-honouring loop sees 19/20 and one "no fix here") | ~1,160 tokens, $0.00005, 1 request, ~200 ms |
| Same, when candidates > 30 or the beam needs absolute scores | 5-level Score per candidate (`Sh_score5`) or Noul per candidate with criteria (`Sg_noul_crit`); both 20/20 test-passing top picks and 0/80 confident misses (1/80 in the table before the run-1 oracle correction), and they give a per-candidate score usable for a beam and a "none passes" verdict. Use Score when tokens matter (4,300 vs 6,450). | Sh_score5 18.75/20 top-1, 20/20 passing | ~4,300 tokens, $0.00018, ~210 ms |
| **Is `buggy_line` actually wrong** (the escape the unchanged line used to provide) | Do not model it as a candidate. Ask a separate Noul ("Is `buggy_line` the line that must change…") or read `none_of_these` on the selection Choice (0.07 mean when candidates are correct, 0.17 in the plain variant). Not measured beyond that here. | — | — |
| Any question about the code | Never a single string state when the question has options that must be matched to text (`Sc_string` 11/20); a string state is acceptable for a pure line-localisation question. Do not add the problem docstring. Add expected **and** actual output. Prefer criteria on every Noul (+1–2 programs, calmer distributions). | — | — |

## 7. What this means for the design

1. **The candidate-set shape matters more than the question wording.** Removing the unchanged
   line (+1.25 top-1, 0 confident misses) and adding the buggy program's actual output (−7 confident
   misses out of 80 on localisation) are the two largest effects. Wording changes (literal,
   docstring, key style) move things by at most one program, except that the key must name the
   code (`Lb_opaque_nodesc`) and candidates must be JSON not prose (`Sc_string`).
2. **Jev is a ranker with a test oracle behind it, so optimise the ordering, not the argmax.**
   Selection top-3 contains the gold or a test-passing fix in every run of every escape variant (gold
   itself was rank 4 once: `Sb_semantic` run 2, next_permutation, where the top pick passes); the synthesizer should walk
   candidates in probability order and let the tests decide. Localisation top-3 is 18–19/20; the
   two misses (lis, mergesort) need coverage-based localisation or an exhaustive fallback, both
   cheap at $0.00005 per line-set request.
3. **Thresholds: 0.7 on a Choice with actual output, 0.5 on a Noul with criteria.** With those
   settings precision is 0.98–1.00 and coverage 0.6–0.8 of programs. Below them, fall back to
   more candidates or more tests, not to a human: the 0.15–0.6 band moves by up to 0.18 between
   repeat calls, so no fixed cut there is stable on individual items.
4. **Per-option Nouls/Scores are worth 3–5× the tokens when an absolute scale is needed**
   (beam scoring, "none of these", deciding to widen the search); a Choice is enough when a
   verified argmax is all that is needed. Both fit in one request under 7k tokens for 60 options.
5. **Descriptions raise sharpness, not accuracy, and can over-commit** on near-duplicate
   candidates (lcs_length: 60 candidates differing by one index). Pair descriptions with the
   test-driven walk, or fall back to Score-per-candidate when the candidate set exceeds ~30.
6. **Use the test oracle as the metric everywhere.** Gold-line accuracy under-reports by one
   program (next_permutation's equivalent fix); "test-passing top pick" is what the loop will
   observe.

## 8. Incidents and caveats

- **JevCode validator rejected a valid answer on a near-tie** (`Lb_opaque` / kheapsort, run 2):
  the wire said `choice: "opt_af"` with `opt_af` printed as 0.32 and another option as 0.33 after
  two-decimal rounding; `validateJevResponse` threw "not an argmax of probabilities". The request
  was paid for and dropped from that run's mean (n = 19). The validator should tolerate a
  one-unit rounding difference in the last decimal (1 in 2,260 requests here; more likely on
  flat distributions).
- **Test oracle pitfall**: the first oracle imported the patched module and Python's
  `__pycache__` served a stale `.pyc` for same-length candidates written in the same second, so
  the gold "failed" on 5 programs. The shipped `eval_candidates.py` execs source (no bytecode
  cache) and uses only the tests the gold solves within 2 s (levenshtein drops one exponential
  case, knapsack one). Anything in the synthesizer that writes a candidate and imports it needs
  the same care (`PYTHONDONTWRITEBYTECODE=1` or a fresh directory per candidate).
- Candidate sets are code-generated mutants with the gold always inserted, so **coverage of the
  candidate source is not measured here** (that is the next experiment); selection numbers are
  conditional on the fix being present. Candidate count varies 2–60, and the hard items are the
  large sets (lcs_length 60, next_permutation 36, hanoi 34).
- 20 programs, one language, one-line bugs, 3 tests in the state: enough to rank the variants
  (effects that reproduced 4/4 runs) but not to estimate absolute rates to better than ±10 points.
- Three full runs (~$0.11) were lost to a script bug that crashed after the requests completed
  (a summary block placed before its `const`); their answers are not in the JSONL and are not
  counted anywhere above.

## 9. Reproduce

```
git clone --depth 1 https://github.com/jkoppel/QuixBugs /tmp/quixbugs
cd <repo>
python3 experiments/probe-questions/actual_outputs.py                       # actual-outputs.json
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-questions/probe.mts - run0 --dump   # candidates.json, no requests
python3 experiments/probe-questions/eval_candidates.py                      # candidate-pass.json
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-questions/probe.mts - run5         # ~600 requests, ~$0.04
node_modules/.bin/tsx experiments/probe-questions/aggregate.mts             # pools results-run*.jsonl -> aggregate.md
```

`probe.mts <regex> <run>` runs a subset of variants (e.g. `'^(L0_base|S_combo_no_unchanged)$'`).
Raw rows: `experiments/probe-questions/results-run{1..4}.jsonl` (variant, program, rank, P(gold),
P(top), top pick text, test-oracle verdict, tokens, cost, latency per request).

## Verification (2026-09-20)

Adversarial check of this file against the scripts and the saved raw output. Verdict: **corrected** (the
measurements and the main conclusions hold; several counts and range statements were fixed, see below).

**What was recomputed from `results-run{1..4}.jsonl` (2,260 rows) and matched the file exactly:** the totals
(2,260 requests, 1 rejected, 3,553,334 input tokens, $0.1492 from `usage.costUsd`, latency p50 197 ms / p95
346 ms); every cell of the section 3 main table (re-running `aggregate.mts` gives a byte-identical table); every
cell of the threshold table and the pooled calibration bins (recomputed independently in Python, escape
excluded, "correct" = gold or test-passing); all 20 × 29 cells of the run-4 per-item matrices; the repeat-stability
rows (100 L0_base samples on 5 programs, 0 argmax flips, max spread 0.18); the one validator rejection
(`Lb_opaque`/kheapsort, run 2: choice 0.32 vs max 0.33; `src/jev/validate.ts` has `ARGMAX_TOLERANCE = 1e-6`, so
the claim that a one-unit rounding tie is rejected is correct); the escape masses quoted (0.67 for
`Lb_opaque_nodesc`, 0.18 / 0.07 for the no-unchanged variants); bitcount 0.18 → 0.62–0.68 with actual output;
Sc_string 9 wrong picks per run vs 2–3 for S0_base, with the unchanged line taken on gcd, lis and mergesort;
`Lg_noul_crit_actual` P(top) ≥ 0.5 correct 48/48; per-run cost $0.033–0.039 (so "~$0.037 per lost run" is
plausible).

**Data and oracle checks:** the 20 programs are the first 20 alphabetical `json_testcases/*.json` (pascal and
possible_change are 21st/22nd); each buggy/correct pair differs in exactly one non-blank line with equal line
counts, so the `truthIdx` logic in `probe.mts` is sound; `candidate-pass-meta.json` shows the gold passing on
all 20 programs, tests used 3–14 (knapsack 9/10, levenshtein 6/7 dropped as gold-slow), and exactly two programs
with a second passing candidate (levenshtein, next_permutation) as stated. Candidate counts 2–60, median 23.5
(the file said 23; fixed).

**Question well-formedness (REPORT rules):** every Choice is built with `choice()` or `rawChoice()`, both of
which append `none_of_these`; keys are `line_N` / `candidate_xx` / `opt_xx` with the code as description
except in the two deliberately degraded A/B variants (`La_nodesc`, `Lb_opaque_nodesc`); targets are named by
backticked path (`program.L6`, `candidates.candidate_aa`, `buggy_line`, `tests`); Score levels are situations;
no question asks Jev to count or compute. The Nouls "without criteria" bypass the builder on purpose as the
control arm. No rule violations beyond the intended ones.

**Live re-run (`results-verify1.jsonl`, 100 requests, 98,283 tokens, $0.0041, p50 185 ms / p95 341 ms):**

| Variant | Top-1 | Top-3 | Top-1 passes tests | MRR | P(gold) | P(top) | wrong at P(top)≥0.7 | misses |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0_base | 17/20 | 18/20 | n/a | 0.89 | 0.59 | 0.68 | 2 | lis (rank 4, 0.80 on the `or`-condition line), mergesort (rank 16, 0.92 on `left[i:] or right[j:]`), longest_common_subsequence (rank 2) |
| Ld_actual | 18/20 | 19/20 | n/a | 0.92 | 0.67 | 0.73 | 1 | lis (rank 7), mergesort (rank 3, 0.60) |
| S0_base | 17/20 | 20/20 | 18/20 | 0.93 | 0.69 | 0.75 | 1 | gcd (unchanged line, 0.45), next_palindrome (unchanged line, 0.73), next_permutation (equivalent fix, passes) |
| S_combo_no_unchanged | 19/20 | 20/20 | **20/20** | 0.97 | 0.85 | 0.90 | 0 | next_permutation (equivalent fix, 0.87, passes) |

Repeat stability on the 5 extra L0_base samples per program: 0 argmax flips; P(gold) spreads bitcount 0.19–0.31,
bucketsort 0.92–0.94, find_first_in_sorted 0.72–0.77, flatten 1.00, **find_in_sorted 0.35–0.61 (0.26, wider than the
0.18 maximum reported above)**. Every headline number reproduced within one program.

**Corrections made in the text above:**

1. Run 1 predates the test oracle, so its next_permutation top pick (the passing `if perm[j] > perm[i]:` in
   every later run) was counted as a confident wrong pick. Corrected "wrong at P(top)≥0.7" for selection:
   S0_base, Sa_desc, Sa_desc_only, Sb_semantic, Sb_rawkey 5 → 4/80; Sd_actual 3 → 2/80; Sg_noul_crit,
   Sg_noul_nocrit, Sh_score5 1 → 0/80. The table itself is left as `aggregate.mts` prints it, with a note under
   it; the narrative (section 5 rows, section 6, section 7) now quotes the corrected counts. The run-1 pick text
   was not recorded, so this rests on the runs 2–4 pattern.
2. "Selection top-3 20/20 in every escape variant": gold was rank 4 once (Sb_semantic run 2, next_permutation,
   top pick passes). Reworded to "gold or a passing fix in the top-3 in every run".
3. lis "rank 4–9 everywhere" → one Lg_noul_nocrit run at rank 3; mergesort "3–5 with opaque keys" → one
   Lb_opaque run and three La_nodesc runs still at rank 17; lcs_length "3 of 4 runs" → per-variant counts.
4. Median candidates 23 → 23.5; escape mass 0.66 → 0.67; Noul gold minimum 0.09 → 0.08–0.09.
5. The REPORT §6 citation was misread ("±0.02 at the extremes"): REPORT §6 gives sd 0.000 at the extremes and up
   to 0.026 in the 0.55–0.80 band, and had already seen a 0.11 range on a flat Choice.
6. Added, in section 6, that top-1/top-3 rank the code options with `none_of_these` excluded. In `Ld_actual`
   the escape out-scored every line on 8/80 items (longest_common_subsequence, next_palindrome, all runs), in
   `L0_base` on 4/80 (bitcount, all runs), in `S_combo_no_unchanged` on next_palindrome in both runs (escape
   0.41–0.45). A loop that treats the escape as the argmax covers 1–2 fewer programs than the top-1 column
   implies; a loop that walks candidates in order is unaffected.
7. The "+1 program" effects (criteria on Nouls, per-option Noul/Score over Choice) are inside the file's own
   ±2 noise statement; labelled as such. The robust parts of those rows (0 confident misses, 20/20 test-passing,
   calmer runner-up mass) stand.

**Unverifiable (author's statement only):** the $0.0024 smoke test and the ≈$0.11 for three runs lost to the
summary-stage crash (no raw rows exist); the total ≈$0.26 therefore cannot be reconciled beyond the $0.1492 in
the JSONL plus $0.0041 for this verification. **Literature:** the file cites no external papers or URLs, only
`<research-notes>/REPORT.md` (§6, §10) and the in-repo anchor probe; both were re-read
and the §10 citation (positional indirection fails, semantic hops work) supports the "keys must name the code"
claim. Nothing to re-fetch.

**Conclusions:** supported by the numbers with the qualifications above. The strongest claims (remove the
unchanged line → 20/20 test-passing; actual output → fewer confident localisation misses; order-only keys
collapse; string state hurts selection) reproduced in every recorded run and in the live re-run. Absolute rates
remain ±10 points (n = 20 programs), as the file already says.
