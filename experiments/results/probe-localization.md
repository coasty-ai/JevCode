# Probe: fault localisation with Jev only (QuixBugs lines, SWE-bench files)

Date 2026-09-20. Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. No generating LLM
anywhere: code proposes the option sets, Jev ranks them, ground truth comes from the QuixBugs
correct programs and the SWE-bench gold patches. Scripts under `experiments/probe-localize/`:

| File | Purpose |
| --- | --- |
| `quixbugs_run.py` | runs every buggy QuixBugs program on its tests (JSON tests in a subprocess with a 2 s timeout; graph programs through their pytest files with a stub `pytest` module and a 2 s SIGALRM per test), writes `quixbugs-runs.json` |
| `quixbugs-localize.mts` | variants A–E on all 40 programs, writes `quixbugs-localize.rows[.repN].json` |
| `swebench-files.mts` | file-level Choice and Noul-per-file on the 30 instances, writes `swebench-files.rows.json` |
| `report.py` | builds every table below from the row files |

Run: `python3 experiments/probe-localize/quixbugs_run.py`, then
`env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-localize/quixbugs-localize.mts`
(set `RUN_SUFFIX=.rep2` for a repeat), then the same for `swebench-files.mts`, then `python3 experiments/probe-localize/report.py`.

**Total live spend for everything in this file: $0.071** (QuixBugs 3 × ~$0.0113, SWE-bench $0.0328,
smoke tests ~$0.005), from `usage.costUsd`. Concurrency 6 (QuixBugs) and 5 (SWE-bench) programs at a time.

## 1. Headline

| Question | Result |
| --- | --- |
| QuixBugs line localisation, best variant (D: Choice over lines with 3 tests **and the actual output of the buggy program on a failing test**) | top-1 **28/40 (70 %)**, top-3 36/40 (90 %), MRR 0.805; repeats 27, 27 |
| Anchor design (A: Choice over lines, 3 tests) on all 40 (anchor probe had 13/14 on the 14 easiest) | top-1 23/40 (58 %), top-3 33/40 (82 %) |
| Tests removed (B) | 22/40 top-1: the tests barely help a plain Choice; the *actual output* is what helps |
| Noul per line (C) | 24/40 top-1, 35/40 top-3, best MRR of the non-D variants; 3.3× the tokens of A |
| Hierarchical (E), only 4 programs > 15 lines | no gain overall (23/40); helped 2 of the 4, hurt 1 |
| Union of D top-3 and C top-3 | covers 38/40 programs: a beam of ≤ 6 lines for the test oracle |
| The 11 programs no variant gets top-1 | all 4 *insertion* bugs, plus 7 whose buggy line is syntactically innocent (see §5) |
| SWE-bench file localisation from the problem statement alone, Choice over ~219 candidates (gold always present) | top-1 **24/30 (80 %)**, top-5 30/30, MRR 0.892, $0.0004 per instance |
| Noul per file over 60 files | top-1 26/30 (87 %), top-5 30/30; calibrated: 23 of 26 files with p ≥ 0.7 are gold, base rate 2.1 % |
| Cost / latency | ~$0.00005 per QuixBugs Choice request, p50 176–227 ms; SWE Choice ~$0.0004, p50 256 ms |

## 2. Exact question wording and state shapes

### QuixBugs (all variants)

`program` is the buggy source with the trailing QuixBugs docstring stripped; blank lines and
comment-only lines removed; keys `L<k>` use the original 1-based line number. Option keys are
`line_<k>` with the line text as the option description; `choice()` from `src/jev/questions.ts`
appends the escape option `none_of_these`. Truth is the buggy line from the diff against
`correct_python_programs/`; for the 4 insertion bugs (`depth_first_search`, `reverse_linked_list`,
`shunting_yard`, `wrap`) both neighbours of the insertion point count as correct; `powerset` has
3 candidate truth lines (the diff touches a comment too). `possible_change` truth is the `if` line
(the other diff hunk deletes a `# Python 3` comment, which is filtered out).

State A (3 tests; graph programs get the test function's name, docstring and source instead of input/expected):

```json
{ "task": "The Python function `gcd` has a single-line bug. `tests` give inputs and the expected output (or, for graph programs, the test source); at least one of them fails on the buggy program. Exactly one line of `program` must change to fix it.",
  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", "L3": "        return a", "L4": "    else:", "L5": "        return gcd(a % b, b)" },
  "tests": [ { "input": [17, 0], "expected": 17 }, { "input": [13, 13], "expected": 13 }, { "input": [37, 600], "expected": 1 } ] }
```

Graph test entry, as used in the state: `{ "name": "test3", "description": "Case 3: Two unconnected nodes in graph\nOutput: Path not found", "source": "def test3():\n ... assert not path_found\n" }`.

Question A/B/D (one Choice, `buggy_line`):

> Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty.

- **B**: state without `tests`; task text "The Python function `gcd` has a single-line bug. Exactly one line of `program` must change to fix it."
- **D**: state A plus `"failing_test_run"`, and the task text gains " `failing_test_run` shows what the buggy program actually did on one failing test." The failing run is the first failing test case, executed live with a 2 s timeout:
  `{ "input": [13, 13], "expected": 13, "actual": "RecursionError: maximum recursion depth exceeded" }` (gcd);
  `{ "input": [2, 0.01], "expected": 1.4166666666666665, "actual": "Timeout: the program did not finish within 2 seconds (probable infinite loop)" }` (sqrt);
  `{ "input": [...], "expected": ..., "actual": { "actual_output": [0, 0, 1, ...] } }` for wrong output; for graph programs `{ "name", "description", "source", "outcome": "IndexError: pop from an empty deque" | "assertion failed" | ... }`.
- **C**: state A, one Noul per line in a single request, id `line_<k>`:

  > Is line `program.L<k>` the line that must change to fix the bug in `gcd`? Judge this line only; other lines are judged separately.

  criteria.true: definition "This line contains the defect: changing this line, and only this line, makes every test pass. The wrong operator, bound, argument, index, condition or return value is on this line." with 4 examples (a `while` condition that never becomes false and the test times out; a recursive call whose arguments are swapped; a `return` of the wrong value or shape; an `if` bound using `<` where `<=` is needed). criteria.false: "This line is correct as written. It may compute a value the faulty line misuses, be a `def` line, or an unrelated statement." with 3 examples. Ranked by `noul` probability.
- **E** (programs > 15 lines, otherwise A's answer is reused with no request): coarse Choice `buggy_unit` over units, where a unit is the innermost enclosing `def` when the file has several functions, else each top-level statement block of the single function's body (option description = the unit's source):

  > Which part of `program` (a function or a top-level statement block, given as its source) contains the bug that makes `tests` fail? Choose `none_of_these` only if no listed part is faulty.

  then a fine Choice over the picked unit's lines with `suspected_part` added to the state:

  > `suspected_part` is the part of `program` believed to contain the bug. Which of its lines (the options) is the single line that must change? Choose `none_of_these` only if no listed line is faulty.

  Lines outside the picked unit are ranked after it in A's order.

### SWE-bench

Candidates per instance: gold `.py` files ∪ up to 54 other `.py` files under the gold files'
directories (recursive, seeded sample) ∪ 200 seeded-random other `.py` files from `git ls-files`,
shuffled; 58–254 options (+ `none_of_these`). Option key = path in snake_case (≤ 60 chars),
option description = the path. State:

```json
{ "problem_statement": "<verbatim>", "repository": "django/django", "candidate_files": ["django/utils/decorators.py", "..."] }
```

Choice `fix_file`:

> Which file in `candidate_files` must be edited to fix the problem described in `problem_statement`? Pick the file where the code change belongs, judging from the file path and the problem text. Choose `none_of_these` only if none of the listed files is the one to change.

Noul variant: 60 files = gold ∪ up to 19 same-directory ∪ random fill (different seed), one request with 60 Nouls:

> Must the file `<path>` be edited to fix the problem described in `problem_statement`? Judge this file on its own; other files are judged separately.

criteria.true "The fix for the problem requires changing code in this file: it is where the misbehaving function, class, method or setting named or implied by the problem lives, or where a fix for it must be added." (3 examples); criteria.false "This file does not need to change: it is a test, a documentation or build file, an unrelated module or package, or it only calls the code that must change." (3 examples). A hit means any gold file is at that rank.

## 3. QuixBugs results

### 3.1 Summary, run 1 (n = 40 programs per variant)

| Variant (run 1) | n | top-1 | top-3 | MRR | cost | Jev p50 | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A choice_3tests | 40 | 23/40 (58 %) | 33/40 (82 %) | 0.710 | $0.0018 | 189 ms | 42,169 |
| B choice_0tests | 40 | 22/40 (55 %) | 30/40 (75 %) | 0.691 | $0.0013 | 189 ms | 30,636 |
| C noul_per_line | 40 | 24/40 (60 %) | 35/40 (88 %) | 0.744 | $0.0059 | 172 ms | 139,883 |
| D choice_actual_output | 40 | 28/40 (70 %) | 36/40 (90 %) | 0.805 | $0.0020 | 176 ms | 47,890 |
| E hierarchical | 40 | 23/40 (58 %) | 33/40 (82 %) | 0.716 | $0.0004 | 227 ms | 9,293 |

Cost is per variant over all 40 programs. E's cost and tokens cover only the 4 programs that
triggered the two-level path (36 reuse A). C sends 5–35 Nouls with criteria per program, hence
3.3× A's tokens; latency is unchanged because Jev prices questions in tokens, not round trips.

### 3.2 Pooled over three independent runs (n = 119; one `next_palindrome` row lost in run 3, see §7)

| Variant (3 runs pooled) | n | top-1 | top-3 | MRR | cost | Jev p50 | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A choice_3tests | 119 | 68/119 (57 %) | 98/119 (82 %) | 0.711 | $0.0053 | 198 ms | 125,359 |
| B choice_0tests | 119 | 66/119 (55 %) | 92/119 (77 %) | 0.698 | $0.0038 | 182 ms | 90,909 |
| C noul_per_line | 119 | 73/119 (61 %) | 104/119 (87 %) | 0.749 | $0.0174 | 205 ms | 415,060 |
| D choice_actual_output | 119 | 82/119 (69 %) | 106/119 (89 %) | 0.796 | $0.0060 | 183 ms | 142,442 |
| E hierarchical | 119 | 68/119 (57 %) | 97/119 (82 %) | 0.715 | $0.0012 | 190 ms | 28,379 |

### 3.3 Run-to-run stability (39 programs present in all 3 runs)

| Variant | top-1 per run | programs with same top-1 in all runs | programs correct in all runs | correct in some runs only |
| --- | --- | --- | --- | --- |
| A | 23 / 22 / 23 | 35/39 | 22 | 1 |
| B | 22 / 22 / 21 | 36/39 | 21 | 2 |
| C | 24 / 23 / 26 | 35/39 | 22 | 4 |
| D | 27 / 26 / 27 | 35/39 | 25 | 3 |
| E | 23 / 22 / 23 | 36/39 | 22 | 1 |

Top-1 counts move by ±1–2 between runs; 35–36 of 39 programs get the same top-1 every run.
The programs that flip (top-1 in some runs only) are `find_in_sorted`, `longest_common_subsequence`,
`minimum_spanning_tree`, `pascal`, `quicksort`, `rpn_eval` and `to_base`; their P(top-1) sits at
0.29–0.77 (all but one below 0.65), where REPORT §6 measured sd 0.008–0.026 noise. *(Corrected
2026-09-20: the original list named `kheapsort` and `max_sublist_sum`, which do not flip in any variant.)*

### 3.4 Per-program rows, run 1 (rank of the truth line, P(truth) in brackets; **1** = top-1)

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

## 4. Calibration

P(top-1) is the probability Jev put on its own top pick (for C, the largest Noul p). Pooled over 3 runs.

| P(top-1) bin (Choice A/B/D) | n | top-1 correct | accuracy | mean P |
| --- | --- | --- | --- | --- |
| [0.0, 0.3) | 11 | 2 | 0.18 | 0.24 |
| [0.3, 0.5) | 67 | 25 | 0.37 | 0.41 |
| [0.5, 0.7) | 102 | 60 | 0.59 | 0.59 |
| [0.7, 0.9) | 114 | 71 | 0.62 | 0.79 |
| [0.9, 1.0) | 63 | 58 | 0.92 | 0.96 |

Brier score of P(top-1) against top-1 correctness: 0.207 (n=357).

| P(top-1) bin (Noul max-p, C) | n | top-1 correct | accuracy | mean P |
| --- | --- | --- | --- | --- |
| [0.0, 0.3) | 3 | 2 | 0.67 | 0.24 |
| [0.3, 0.5) | 9 | 5 | 0.56 | 0.41 |
| [0.5, 0.7) | 33 | 9 | 0.27 | 0.62 |
| [0.7, 0.9) | 57 | 40 | 0.70 | 0.79 |
| [0.9, 1.0) | 17 | 17 | 1.00 | 0.92 |

Brier score of P(top-1) against top-1 correctness: 0.222 (n=119).

Reading: the Choice variants are well calibrated at the ends (0.92 accuracy at p ≥ 0.9, 0.18 at
p < 0.3) and honest in the middle; the 0.7–0.9 bin is over-confident (0.62 accuracy at mean p 0.79),
which is where `possible_change` (A/B/D, 0.76–0.81 on `line_9`/`line_8`), `lis` (A/B/D, 0.67–0.76 on
`line_12`), `detect_cycle` (D only, 0.81–0.84 on `line_9`) and `subsequences` (B, 0.70–0.72) put 0.7–0.9
on a wrong line every run; `mergesort` is the confident miss above 0.9 (A/B 0.88–0.93 on `line_14`).
`longest_common_subsequence` is different: all three Choice variants pick `none_of_these` at 0.30–0.47
in every run, so the escape option fires on a genuine one-line bug. *(Corrected 2026-09-20: the original
text named `detect_cycle` and `longest_common_subsequence` as 0.7–0.9 misses; only D's `detect_cycle`
is, and `longest_common_subsequence` never exceeds 0.47.)* The Noul variant is worse in the 0.5–0.7
band (0.27) and very good above 0.9 (17/17). Per program in run 1, C put p ≥ 0.5 on exactly one line in
28/40 cases, on none in 5 and on 2–3 in 7 (runs 2 and 3: 27/4/9 and 30/3/6); when exactly one line is
lit it is the truth line 19/28 times (68 %; 18/27 and 20/30 in runs 2 and 3). *(Corrected 2026-09-20 from
"30/40, none in 6, 2–3 in 4, right 22 times", which matches no run.)* "How many lines the Nouls light
up" is still a usable signal (0 lit → widen; ≥ 2 lit → send both to tests), but at the 0.5 cut the
single-lit case is right about two times in three, not three in four.

## 5. Where localisation fails, and why

11 programs are missed at top-1 by every variant in run 1: `depth_first_search`, `detect_cycle`,
`lis`, `longest_common_subsequence`, `mergesort`, `possible_change`, `reverse_linked_list`,
`shortest_path_length`, `shunting_yard`, `subsequences`, `wrap`.

| Failure class | Programs | Evidence |
| --- | --- | --- |
| **Insertion bugs** (the fix adds a line; no existing line is "wrong") | `depth_first_search`, `reverse_linked_list`, `shunting_yard`, `wrap` | best ranks over A–E: 3–16; P(truth neighbour) ≤ 0.19 in every variant. "Which line must change" is the wrong question; the right one is "after which line is a statement missing", with the missing statement as a candidate |
| **Innocent-looking line, effect elsewhere** (`return []` vs `return [[]]`, `longest = length + 1` vs `max(...)`, `if len(arr) == 0` vs `<= 1`, `a[1:], b` vs `a[1:], b[1:]`) | `subsequences`, `lis`, `mergesort`, `longest_common_subsequence`, `possible_change` | Jev puts 0.7–0.9 on a more "suspicious" line (a loop bound or the recursive call) every run |
| **Guard missing on an existing condition** (`if hare.successor is None` needs `hare is None or`) | `detect_cycle` | rank 2 in A/B/D/E and 3 in C, p 0.13–0.27; Jev prefers the `hare = hare.successor.successor` line, which is where the exception is *raised* |
| **Long program, wrong function picked** | `shortest_path_length` (35 lines, 3 functions), `mergesort` (21 lines) | E's coarse step picked `get`/`merge` with p 0.45/0.83; unit miss ⇒ fine step cannot recover |

The actual output (D) fixes a different class: `bitcount` (timeout ⇒ the `while n:` loop body),
`breadth_first_search` (`IndexError: pop from an empty deque` ⇒ `while True:`), `next_palindrome`,
`to_base`, `kheapsort`, `rpn_eval` (6 gained); D loses `minimum_spanning_tree` (A top-1 at 0.49, D rank 2),
net +5. *(Corrected 2026-09-20: `max_sublist_sum` was listed as a D gain but A already had it top-1.)*
By failing-test kind, D vs A top-1: wrong
output 17 vs 13 of 22, timeout 2 vs 1 of 2, exception 5 vs 5 of 7, graph 4 vs 4 of 9. The graph
programs are the weakest group (4/9 in every variant) because their state carries test *source*
rather than concrete values.

## 6. SWE-bench file-level localisation (30 instances, problem statement + paths only)

| Variant | n | top-1 | top-5 | MRR | cost | Jev p50 | input tokens | mean candidates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Choice over candidate files | 30 | 24/30 (80 %) | 30/30 (100 %) | 0.892 | $0.0125 | 256 ms | 298,489 | 219 |
| Noul per file, 60 files | 30 | 26/30 (87 %) | 30/30 (100 %) | 0.933 | $0.0203 | 286 ms | 482,714 | 58 |

Candidates always contain the gold file(s); the set is a subset of the repository (219 of
70–2,750 `.py` files on average), so these are *ranking* numbers, not end-to-end recall over the
repository. Choice failures: 3 of 6 misses pick a sibling in the same directory
(`forms/formsets.py` for `forms/models.py`, `admin/views/main.py` for `admin/options.py`,
`sql/query.py` for `sql/compiler.py`); 2 pick `none_of_these` at 0.60–0.82 (`django-15103` two gold
files, `sympy-20428` a `polys/domains` file); 1 (`sympy-22080`) picks `printing/python.py` at 0.42
over `printing/codeprinter.py`. P(top) when correct: 0.40–1.00, median 0.96; when wrong 0.42–0.95:
two confident misses (0.95, both Django siblings).

### 6.1 Per instance

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

### 6.2 Noul-per-file calibration (1,728 file judgments, 37 gold)

| Noul p bin | files | gold files | fraction gold | mean p |
| --- | --- | --- | --- | --- |
| [0.0, 0.1) | 1587 | 3 | 0.002 | 0.027 |
| [0.1, 0.3) | 88 | 3 | 0.034 | 0.157 |
| [0.3, 0.5) | 20 | 5 | 0.250 | 0.376 |
| [0.5, 0.7) | 7 | 3 | 0.429 | 0.603 |
| [0.7, 0.9) | 14 | 12 | 0.857 | 0.799 |
| [0.9, 1.0) | 12 | 11 | 0.917 | 0.943 |

Base rate of gold among the 1728 Noul-judged files: 37/1728 = 0.021. Brier of Noul p against is-gold: 0.010; a constant prediction at the base rate scores 0.021.

On average 1.1 files per instance score p ≥ 0.5 (1 in 27 instances, 2 in 3), and the gold file is
among them in 26/30. Choice and Noul agree on the same wrong sibling in the 3 Django misses, so the
error is in the judgment, not the question form.

## 7. Cost, latency, and one client-side edge

- QuixBugs, one full pass of all 5 variants on 40 programs: **$0.0113**, 270k input tokens, ~40 s
  wall-clock at concurrency 6. A single line Choice is ~1,050 tokens = $0.00004; D adds ~150 tokens;
  C costs ~3,500 tokens per program because each Noul repeats the criteria.
- SWE-bench, 30 instances × (1 Choice + 1 Noul-60 request): **$0.0328**, 781k tokens; Choice
  requests are 2.7–12.3k tokens (problem statement + up to 254 paths), p50 256 ms, max 407 ms; the
  Noul-60 requests max 368 ms. The slowest request in the whole probe was a QuixBugs one at 1.74 s.
  *(Corrected 2026-09-20 from "5–15k tokens" and "max observed 1.9 s", which the row files do not support.)*
- Jev p50 per request 172–227 ms (QuixBugs), 256–286 ms (SWE); the number of questions in a
  request does not move it (C with 35 Nouls: 172 ms p50).
- One request in run 3 (`next_palindrome`, variant A) was rejected by `src/jev/validate.ts`:
  "`line_15` (0.15) is not an argmax of probabilities (max 0.16)". Jev's `choice` field and its
  two-decimal `probabilities` can disagree by one rounding step on a flat distribution; the client
  treats that as an invalid response and (after retries) throws. For a ranker that reads
  `probabilities` anyway this should be a warning, not an error (not changed here: `src/` is out of scope).

## 8. What this means for the design

1. **Always run the failing test and put the actual outcome in the state.** D is the only
   variant that moves top-1 materially (58 % → 70 %, top-3 82 % → 90 %) and it costs 150 tokens and
   one 2 s subprocess. Describe exceptions and timeouts in words ("did not finish within 2 seconds
   (probable infinite loop)"); Jev used them correctly for `bitcount`, `sqrt`, `breadth_first_search`.
   Input/expected pairs *without* the actual output add nothing (B ≈ A), even though in 34/40 programs at
   least one of A's three tests is a failing one; what moves Jev is seeing what the buggy program did,
   so spend the state budget on executed failing tests. *(Reworded 2026-09-20: the original said
   "tests that pass", but A's tests are the first three, failing or not.)*
2. **Localisation is a beam, not a pick.** Top-1 tops out near 70 % on one-line bugs, but the
   union of D's and C's top-3 covers 38/40. With tests as the oracle (JEV-ONLY.md non-negotiable 2),
   the loop should take the top-3 of D, add C's top-3 when they differ, and let candidate
   generation + tests decide; that is ≤ 6 lines × candidates per line, a few requests and cents.
3. **Use C's "lit line count" as the control signal.** 0 lines at p ≥ 0.5 (5/40 in run 1) means "widen or
   ask for an insertion"; ≥ 2 lines (7/40) means "verify both"; exactly 1 (28/40) is right 19 times (68 %).
   *(Corrected 2026-09-20 from 6/4/30 and 22.)* Note that the 0.5 cut sits inside C's worst-calibrated band
   (0.27 accuracy at 0.5–0.7, §4), so a "single lit line" should only short-circuit the beam at p ≥ 0.9,
   where C is 17/17. Cost is 3× A but still $0.00015 per program.
4. **Insertion bugs need their own question.** 4/40 QuixBugs fixes add a statement; every
   line-level variant fails on all 4. Add a second Choice over *gaps* ("after which line is a
   statement missing?") and, in the candidate stage, templates that insert (`visited.add(node)`,
   `prev = node`, `stack.append(token)`, `lines.append(text)` are all donor-style: identifiers
   already in scope).
5. **Do not trust P(top-1) in the 0.7–0.9 band; trust it at ≥ 0.9 and < 0.3.** Threshold rules for
   the loop: p ≥ 0.9 → try the single line first (92 % right); 0.3–0.9 → beam; the 0.7–0.9 bin is
   over-confident (62 %) and holds the "innocent line" failures (`possible_change`, `lis`, `subsequences`),
   which no amount of re-asking fixes; `mergesort` is wrong above 0.9 in A/B and `longest_common_subsequence`
   sits on `none_of_these` at 0.3–0.5, so the escape option can also fire on a genuine one-line bug and must
   fall through to the ranking rather than stop (the same rule as SWE-bench item 7).
6. **Hierarchical (function → line) is not worth it on small files.** On the 4 programs > 15 lines
   E helped 2 and hurt 1; a wrong unit pick is unrecoverable. Prefer flat Choice up to the 255-option
   cap and use function-level only as a pre-filter when a file has > 255 lines; there, combine with
   Ochiai/coverage rather than Jev alone.
7. **File-level localisation on SWE-bench works from the problem statement alone**: 80 % top-1,
   100 % top-5 among ~219 candidates, and Noul-per-file is *calibrated* (p ≥ 0.7 → 88 % gold, base
   rate 2 %). The design can afford Nouls over every `.py` file of a repository (2,750 Django files
   = 3 requests of ≤ 1,000 Nouls, roughly 250k tokens ≈ $0.01) as the first stage, then a Choice over
   the survivors; the same-directory sibling confusions (3/30) are what the next stage (symbol-level,
   with file contents) has to resolve. The 2 `none_of_these` picks at 0.6–0.8 argue for keeping the
   escape option but not stopping on it: fall through to the Noul ranking.
8. **Graph programs are the weak spot (4/9)**: tests given as source instead of values. Any
   Jev-only loop should materialise concrete values (call arguments, return value, exception) from
   test execution rather than pass test code through.

## 9. Caveats

- Ground truth counts the buggy line only; a program can be fixed at another line in principle,
  and the insertion-bug scoring (either neighbour) is a convention.
- SWE-bench candidates always include the gold files and are ≤ 254 of the repo's files; end-to-end
  recall over the whole repository was not measured here (see §8 item 7 for the proposed shape).
- 40 and 30 items: a ±2 change in top-1 is within run-to-run noise (§3.3), so A ≈ B ≈ E ≈ C
  should be read as "no measurable difference"; only D's gain (+5 in every run) and the SWE-bench
  numbers are outside it.
- Python 3.9.6 from `/usr/bin/python3` (no pytest installed; graph tests run through a stub).
- The "smoke tests ~$0.005" component of the $0.071 total is not backed by a row file (unverifiable); the
  three QuixBugs runs ($0.0113 + $0.0114 + $0.0110) and the SWE-bench run ($0.0328) sum to $0.0665 from
  `usage.costUsd`.

## Verification (2026-09-20)

Adversarial check by a second agent. Method: independent recomputation of every table from the row
files (`quixbugs-localize.rows[.rep2|.rep3].json`, `swebench-files.rows.json`, `quixbugs-runs.json`) with a
fresh script; reading of `quixbugs-localize.mts`, `swebench-files.mts`, `quixbugs_run.py`, `report.py`
and the run logs; diffing buggy vs correct programs for the edge-case truths; and a live re-run of a
sample. Live spend for verification: **$0.0046** (QuixBugs 6 programs × 5 variants $0.0013,
`quixbugs-localize.rows.verify.json`; SWE-bench 3 instances × 2 variants $0.0033,
`swebench-files.verify.rows.json`, produced by `swebench-files-verify.mts`, a copy of the script that
writes to a separate file). Neither verify file is read by `report.py`.

### Recomputed and confirmed

| Claim | Recomputed | Status |
| --- | --- | --- |
| §3.1 run-1 top-1/top-3/MRR/cost/tokens for A–E | 23/33/0.710, 22/30/0.691, 24/35/0.744, 28/36/0.805, 23/33/0.716; costs $0.0018/0.0013/0.0059/0.0020/0.0004; tokens 42,169/30,636/139,883/47,890/9,293 | exact match |
| §3.2 pooled n = 119 per variant, top-1 68/66/73/82/68, top-3 98/92/104/106/97 | same; pooled cost $0.0337 | exact match |
| §3.3 top-1 per run, same-top-1 35–36/39, correct-in-all 22/21/22/25/22 | same | exact match; the *named* flip programs were wrong (fixed) |
| §3.4 per-program ranks and P(truth) | all 200 cells match the row file and the run log | exact match |
| §4 Choice calibration bins (11/67/102/114/63; 2/25/60/71/58), Brier 0.207 (n = 357); C bins (3/9/33/57/17; 2/5/9/40/17), Brier 0.222 | same | exact match |
| §5 the 11 programs missed by every variant, the 4 insertion bugs | same 11 in run 1, and 11 in runs 2 and 3 as well | confirmed |
| §5 D vs A by failing-test kind: 17 vs 13 of 22, 2 vs 1 of 2, 5 vs 5 of 7, 4 vs 4 of 9 | same (kind taken from `quixbugs-runs.json` `first_failing`) | exact match |
| §1 union of D top-3 and C top-3 = 38/40 | 38 (D alone 36) | confirmed |
| §5 E helped 2 (`rpn_eval` 4→2, `shunting_yard` 16→4), hurt 1 (`shortest_path_length` 3→7), `mergesort` unchanged (16) | same; unit picks `function_merge` p 0.83 and `function_get` p 0.45 as stated | confirmed |
| §6 SWE Choice 24/30, top-5 30/30, MRR 0.892, $0.0125, p50 256 ms, 298,489 tokens, mean 219 candidates; Noul 26/30, 30/30, 0.933, $0.0203, 286 ms, 482,714 tokens | same; gold present in every candidate set (all ranks finite); candidates 58–254 | exact match |
| §6 P(top) when correct median 0.96 (range 0.40–1.00); wrong 0.42–0.95 with two 0.95 Django siblings | same | confirmed |
| §6.1 per-instance rows | all 30 rows match the row file and the log | exact match |
| §6.2 Noul calibration 1,728 files / 37 gold, bins 1587/88/20/7/14/12 with 3/3/5/3/12/11 gold, Brier 0.010 vs 0.021 | same; p ≥ 0.7 → 23/26 gold (88 %); mean 1.1 files at p ≥ 0.5, gold among them 26/30 | exact match |
| §7 tokens per request: A ~1,050, D +~150, C ~3,500 | 1,054; +143; 3,497 | confirmed |
| Ground truth for `powerset` (3 lines because the diff also strips a comment on L4) and `possible_change` (L5; the `# Python 3` hunk is a filtered comment) | diffs confirm; every variant's top-1 for `powerset` is `line_6`, the real bug, so the 3-line convention did not inflate any hit | confirmed |
| Run-3 loss of `next_palindrome` A to the argmax validator | `rep3.log` line 20: `"line_15" (0.15) is not an argmax of probabilities (max 0.16)`; `src/jev/validate.ts:104` | confirmed |
| Total spend $0.071 | $0.0113 + $0.0114 + $0.0110 + $0.0328 = $0.0665 from rows; the "~$0.005 smoke tests" has no artefact | mostly verified; smoke component **unverifiable** |

### Errors found and fixed in the text above

1. **§4 / §8 item 3, Noul lit-line counts.** Original: "exactly one line in 30/40, none in 6, 2–3 in 4;
   exactly 1 is right 22 times". Row file (run 1, `note` field `lines_p>=0.5=k`): 28 / 5 / 7, and the
   single lit line is the truth 19/28 (68 %). Runs 2 and 3 give 27/4/9 (18/27) and 30/3/6 (20/30). No run
   produces the original figures. The design implication was softened accordingly (short-circuit only at p ≥ 0.9).
2. **§3.3 flip programs.** `kheapsort` and `max_sublist_sum` never flip; the flipping set is `find_in_sorted`,
   `longest_common_subsequence`, `minimum_spanning_tree`, `pascal`, `quicksort`, `rpn_eval`, `to_base`.
3. **§4 over-confidence examples.** `longest_common_subsequence` never puts more than 0.47 on its top pick
   (it picks `none_of_these` in every Choice variant, every run); `detect_cycle` is only in the 0.7–0.9 band in D.
   Replaced with the programs that actually sit there (`possible_change`, `lis`, `subsequences`, D's `detect_cycle`)
   and noted `mergesort` as the above-0.9 miss. The `none_of_these` finding is new and was added to §8 item 5.
4. **§5 D-gain list.** `max_sublist_sum` was A top-1 already (0.50); D gained 6 and lost `minimum_spanning_tree`.
5. **§5 `detect_cycle`** is rank 3, not 2, in C.
6. **§7 SWE request size and latency.** Choice requests are 2,742–12,300 tokens, not 5–15k; the SWE maximum
   latency in the row file is 407 ms (Noul 368 ms), not 1.9 s; the slowest request anywhere was a QuixBugs one at 1,739 ms.
7. **§8 item 1 wording.** A's three tests are the first three, and in 34/40 programs at least one of them fails,
   so "tests that pass add nothing" was the wrong reading; the supported statement is "input/expected without
   the actual output adds nothing".

### Question form against REPORT.md rules

- Escape option: every Choice goes through `choice()`, which appends `none_of_these` (confirmed in
  `src/jev/questions.ts`). Semantic keys: SWE keys are the snake_cased path; QuixBugs keys are positional
  (`line_<k>`) but carry the line text as the description, which REPORT §10 measured as the part that
  matters more. No question asks Jev to count, compute or compare numbers; the failing-test kind and the
  lit-line count are computed in code. Targets are backticked paths (`program.L<k>`, `candidate_files`,
  `failing_test_run`). Noul criteria have definition + examples on both sides (4/3 and 3/3 examples).
- Two caveats the report did not state: (a) the task text asserts "single-line bug… exactly one line must
  change", which is true by construction on QuixBugs but is a premise a real loop does not have (and is
  false for the 4 insertion bugs); (b) REPORT §7 found duplicate option descriptions split the mass. None
  of the 40 stripped QuixBugs programs contains two identical code lines, so this did not bite here, but real
  files (repeated `else:`, `return None`, `pass`) will need disambiguated descriptions (e.g. line text plus
  the enclosing `def`).
- The report thresholds the lit-line signal at 0.5, which REPORT §14 advises against for borderline
  answers; the correction above moves the actionable cut to 0.9.

### Live re-run (sample)

QuixBugs, 6 programs (`gcd`, `bitcount`, `detect_cycle`, `possible_change`, `next_palindrome`,
`longest_common_subsequence`), all five variants, $0.0013: `gcd` top-1 everywhere (A 0.84, D 0.84);
`bitcount` A rank 2 (0.09) → D top-1 (0.59) and C top-1 (0.32), as recorded; `detect_cycle` rank 2/2/3/2/2
as recorded; `possible_change` ranks 4/5/3/5/4 (recorded 5/5/3/6/5); `next_palindrome` A rank 2, D top-1
(0.63), and this time the A request validated (the run-3 failure was a flat-distribution rounding edge, not
a systematic one); `longest_common_subsequence` A/B/D miss (ranks 2/3/3) and C got it top-1 at 0.23, matching
its run-2/run-3 flips. SWE-bench, 3 instances, $0.0033: `django__django-14725` again picks
`django/forms/formsets.py` at 0.95 (Noul rank 2, P(gold) 0.45); `sympy__sympy-22080` again picks
`sympy/printing/python.py` (Choice rank 3, Noul top-1 at 0.56); `pytest-dev__pytest-7324` top-1 at 0.39
(Noul 0.83). Every re-run outcome is within the run-to-run variation the report describes.

### Literature claims

The file makes no external literature claims (no URLs, papers or dates to re-fetch); its only external
references are the pinned model id and the OpenRouter endpoint, and the internal cross-reference to
REPORT §6 ("±0.02 noise") is consistent with REPORT's measured sd 0.008–0.026 in the 0.48–0.78 band.
"Ochiai" in §8 item 6 is named as a known spectrum-based technique, not as a result, and is uncited.

### Verdict

**Corrected.** Every table recomputes exactly from the saved rows and the live sample reproduces the
recorded behaviour, so the headline numbers (D 28/40 → +5 in each run, 38/40 union coverage, SWE 24/30 and
26/30, calibrated Noul-per-file) stand. Seven prose errors were fixed, the largest being the Noul lit-line
counts (30/6/4 and 22 → 28/5/7 and 19/28) that fed design implication 3. The unverifiable item is the
~$0.005 smoke-test component of the total spend. A `RUN_SUFFIX`-style guard would be worth adding to
`swebench-files.mts`, which otherwise overwrites its row file on any partial re-run.
