# Probe: can Jev BUILD a fix line by a sequence of Choices? (probe-tokens, 2026-09-20)

Scripts: `experiments/probe-tokens/` (`build_corpus.py`, `run_tests.py`, `common.mts`, `teacher-forced.mts`,
`beam.mts`, `templates.mts`, `edit-beam.mts`, `make_tables.py`); raw per-request/per-line JSON and logs in
`experiments/probe-tokens/out/`. Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. Jev is the
only model; python3 running the QuixBugs tests is the only oracle. Total live spend **$0.7032** over
4,277 requests (every figure from `usage.costUsd`).

## 1. Setup

**Corpus.** All 40 QuixBugs Python programs (excluding `node.py`). `build_corpus.py` diffs
`python_programs/<p>.py` against `correct_python_programs/<p>.py` (docstrings stripped, blank-line and
comment-only diffs ignored) and finds exactly one changed line per program: 36 replacements and 4
insertions (`depth_first_search`, `reverse_linked_list`, `shunting_yard`, `wrap`). The fix line's position is
**given** (the probe is about synthesis, not localisation; the anchor probe measured localisation at 13/14
top-1). One fix line, `shortest_paths` (`weight_by_node[v] = min(`), is a fragment of a multi-line expression.
Tests: first 3 JSON cases for the 31 programs with `json_testcases/`; for the 9 graph programs the source of
the first 3 `def test…` functions from `python_testcases/`. Functional checks run **all** upstream tests
(`run_tests.py` is a pytest-free runner with a stub `pytest` module: `use_correct=False`, `run_slow=False`,
`approx`, `skip`; 3 s alarm per case). It passes all 40 correct programs and fails all 40 buggy ones.

**Tokenizer.** `tokenize()` in `common.mts`: strings, numbers, identifiers vs 28 keywords vs `True/False/None`
(class `literal`), 34 operators longest-first, 10 punctuation marks; comments dropped. `detokenize()` joins with
minimal spacing (valid Python; equality is checked on token sequences, so spacing never matters). Round trip
40/40; detokenised fix lines pass tests 40/40. Fix lines have 2–21 tokens (mean 9.7); 426 positions including
`end_of_line`.

**Candidate token set** (code proposes, per program): identifiers appearing in the buggy program (18–60), 24
builtins (`len`, `max`, `range`, …), 15 common method names (`add`, `append`, `pop`, …; added after finding
`.add` in `depth_first_search` was the one uncovered token), 28 keywords, `True/False/None`, 34 operators, 10
punctuation marks, up to 40 number/string literals from the program and the tests, plus `end_of_line`; the
`choice()` builder adds `none_of_these`. 121–159 options per program excluding `none_of_these` (mean 133; the
range was misreported as 106–146 before verification). Coverage of target tokens:
**386/386** after the method-name list (385/386 before).

**Option keys** (REPORT §10: keys carry a prior, so semantic snake_case with the token as the description):
`name_counts`, `name_len`, `keyword_return`, `literal_none`, `number_1`, `string_empty`, `op_less_equal`,
`punct_open_bracket`, `end_of_line`. Descriptions are objects, e.g. `{"kind":"identifier","token":"counts"}`,
`{"kind":"operator","token":"<=","meaning":"less than or equal"}`,
`{"kind":"end","meaning":"the partial line is already the complete correct line; nothing more to add"}`.

**State shape (experiments 1 and 2):**

```json
{
  "task": "The Python function `gcd` has a one-line bug. In `program` the faulty position is marked `<<<FIX THIS LINE>>>` (the marker keeps the correct indentation). The original wrong line at that position is `buggy_line`; the correct line is usually a small edit of it. The corrected program must make every entry of `tests` pass.",
  "program": "def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        <<<FIX THIS LINE>>>",
  "buggy_line": "return gcd(a % b, b)",            // null for the 4 insertions (task text says so)
  "tests": [{"input": [17, 0], "expected": 17}, ...],  // 3 cases, or 3 pytest function sources
  "partial_line": "return gcd(b,",
  "partial_tokens": ["return", "gcd", "(", "b", ","]
}
```

**Question (experiments 1 and 2), one Choice per request:**

> `partial_line` is the beginning of the correct replacement line for the `<<<FIX THIS LINE>>>` marker in
> `program` (its tokens so far, left to right, are `partial_tokens`). Which single Python token comes
> immediately next in the correct line? Choose `end_of_line` if `partial_line` is already the complete correct
> line. Choose `none_of_these` if the next token is not offered. Answer literally: exactly one token, not a
> whole expression.

Mean 5,102 input tokens per request ($0.00021); the grammar-filtered variant 2,822 ($0.00012).

## 2. Experiment 1: teacher-forced next-token accuracy

Every one of the 426 positions asked independently with the true prefix (16 concurrent requests, 426 calls,
$0.0913, Jev p50 227 ms).

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

Per line: 9/40 lines have every position top-1 (the greedy ceiling; misreported as 11 before verification, 11 is
the W=1 beam's exact count), 28/40 have every position within top-3
(the width-3 ceiling under teacher forcing). First token top-1 38/40.

**Error analysis of the 67 misses.** 58 are *skip-ahead*: the top-1 token is a token that occurs later in the
correct line (`nodesvisited` → `add` instead of `.`; `for i, count` → `enumerate` instead of `in`; `n &= n` →
`end_of_line` instead of `-`). 1 is the buggy line's token at the same position, 3 are buggy-line tokens from
elsewhere, 0 are `none_of_these`, 5 other. Jev knows *what* is in the line; it does not track *where* the
cursor is (REPORT §10: positional arithmetic is its weak spot). Operators are the weakest class (66 %); the
misses are mostly the small connective operators (`+`, `-`, `**`), not comparisons.

## 3. Experiment 2: free-running beam search

Beam over the same Choice, width W ∈ {1, 3}, ≤ 25 tokens, score = Σ log p, `none_of_these` never expanded,
`end_of_line` moves a beam to the completed set; standard pruning (stop when W completed beams beat every live
beam). Top-3 distinct completed lines are verified by running all upstream tests (`any of top-3 passes` is the
design-relevant number: tests are cheap, Jev only has to put a correct line in a small set). A third condition
adds a **grammar filter** written in code (`legalNext()` in `common.mts`, ~40 lines): given the prefix, only
syntactically possible next tokens are offered (identifier cannot follow identifier, `.` must be followed by
an identifier, `end_of_line` only when brackets are balanced and the line can end, closers must match, …).
It was checked offline to admit the true next token at 425/426 positions; the one exclusion is the
`shortest_paths` fragment ending in `min(`. It cuts the option set from 133 to 60 on average.

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

Observations:

- Width 3 beats greedy by 4 lines (16 vs 12 any-pass); the grammar filter adds 4 more (20/40) **and halves the
  cost** ($0.0037 vs $0.0065 per line) because the option list is shorter; it also removed all truncations
  (4 lines ran to 25 tokens without a filter, 0 with).
- Σ log p favours short completions: the W=3 top beam was `return 1` and `return rest_subsets` (unfiltered) and
  `return 1`, `greater`, `break`, `line` (with grammar filter) on lines whose correct completion is 6–21 tokens. Length-normalised ranking
  (mean log p) gave 17 vs 16 exact top beams (column `mean_rank_top_exact` in the JSON) but the real answer is
  the oracle: verifying the top-3 completions with tests turned 17 top-pass into 20 any-pass.
- Functionally equivalent lines were found twice: `kth` `return kth(above, - num_lessoreq + k)` (W=1) and
  `sieve` `if all(n % p for p in primes):` (W=3+grammar), both pass every test.
- Long lines (≥ 14 tokens) fail almost always except `longest_common_subsequence` (20 tokens, W=3+grammar
  exact) and `quicksort`/`topological_ordering` (which only the template or edit routes solve). Fixes that
  *add* structure to the buggy line (`max(0, …)`, `or not coins`, `[k:]`, `** 2`, `[[]]`) are where the token
  route fails: Jev stays anchored to the buggy line and closes the line early (`if total < 0:` p(end) beats
  p(`or`)).
- Wall time p50 3.3 s per line for W=3 (Jev requests are ~210 ms and run 3 in parallel per step); the 40 s
  outliers in the logs are test verification of beams that produced infinite loops (3 s alarm × cases).

## 4. Experiment 3: line templates, then slot filling

Template = fix-line tokens with every identifier/number/string/`True|False|None` replaced by `_` (one slot
kind; `while _:` covers both `while True:` and `while queue:`). Pool per program: template of the buggy line,
of every other non-`def` line of the program (donor lines), and of mutants of the buggy line (the 20-regex
operator/±1/`any↔all`/argument-swap list from the anchor probe), deduplicated; keys are the shape spelled out,
e.g. `shape_return_x_open_paren_x_comma_x_modulo_x_close_paren`, descriptions
`{"shape":"return _(_, _ % _)","from":"mutant_of_buggy_line"}`. State: `task`, `program`, `buggy_line`, `tests`.

> Template Choice: "Each option is a line shape where `_` stands for any single identifier or literal (names,
> numbers, strings, True/False/None); keywords, operators and punctuation are shown literally. Which shape does
> the correct replacement line for the `<<<FIX THIS LINE>>>` marker in `program` have? Choose `none_of_these`
> if no listed shape fits the correct line."

> Slot Choice (sequential; state adds `line_shape`, `line_with_slots` with earlier slots filled and the rest as
> `<SLOT_n>`, `slot_to_fill`): "`line_with_slots` is the correct replacement line for the `<<<FIX THIS LINE>>>`
> marker in `program`, with earlier slots already filled and the remaining slots shown as `<SLOT_n>`. Which
> identifier or literal belongs at `slot_to_fill`? Choose `none_of_these` if the right token is not offered."
> Options: the identifier/literal subset of the candidate set (~60–100).
>
> Parallel variant: one request, one Choice per slot ("Which identifier or literal belongs at `<SLOT_k>`?"),
> all slots shown unfilled (REPORT §7: questions are independent, so slots cannot see each other).

### T5. Template experiment summary

| Measurement | Result |
| --- | --- |
| Pool size (buggy line + donor lines + mutants of the buggy line), mean / max | 9.3 / 27 |
| Correct template in pool (coverage) | 17/40 (from buggy line 8, mutant 5, donor line 4) |
| Template Choice top-1 / top-3 when covered | 15/17 / 17/17 (mean p(truth) 0.65) |
| When not covered: picked `none_of_these` / picked some listed template (of which the buggy line's template) | 5/23 / 18/23 (16/23) |
| Slot filling on the true template, sequential (one Choice per slot, earlier slots filled) | 35/40 exact |
| Slot filling on the true template, parallel (all slots as independent Choices in one request) | 32/40 exact |
| End to end (top-1 template, then sequential slots) exact / passes tests | 12/40 / 12/40 |
| Slots per line, mean / max | 4.0 / 9 |

Observations:

- Selection is excellent when the pool contains the answer (15/17 top-1, 17/17 top-3), and slot filling on the
  right template is 35/40 sequential; the 5 sequential failures are `lis`, `next_permutation`, `rpn_eval`,
  `shortest_path_lengths`, `sieve`, three of them argument order (`rpn_eval`, `next_permutation`,
  `shortest_path_lengths`: swapping two identifiers of the same type is a position judgement again). `gcd`
  failed only in the parallel variant (8 parallel failures: `gcd`, `kth`, `lis`, `max_sublist_sum`,
  `next_permutation`, `reverse_linked_list`, `rpn_eval`, `topological_ordering`). Sequential beats parallel by
  3 lines, at k requests instead of 1.
- **Coverage is the bottleneck: 17/40.** Fixes that add tokens (`+ 1`, `[k:]`, `or not coins`, `max(0, …)`,
  `** 2`) have no donor of the same shape in a 10-line program.
- When the pool is wrong, Jev picks `none_of_these` only 5/23 times and a listed template 18/23 times, 16 of
  those the *buggy line's* template (the other two: `max_sublist_sum`, `shortest_paths`): the escape option
  does not protect against a strong prior (the buggy line is right there in the state). A paired Noul ("is `buggy_line` already correct?") would be needed to detect this, per REPORT §10.

## 5. Follow-up: edit-based beam (36 replace-kind lines, $0.0734)

Because 36/40 fixes are 1–3 token edits of the buggy line, a fourth route was tried: start from the buggy
line; per step one Choice over edit sites (for each token `replace_<tok>_at_<i>` / `delete_<tok>_at_<i>`, for
each gap `insert_before_position_<g>`, plus `line_is_already_correct`; each description shows the site as
`[[tok]]` or `+++` in the line), then for replace/insert one grammar-filtered Choice over tokens; W=3 sites ×
top-2 tokens, depth 3, Σ log p; tests over the ≤ 3 Jev-stopped lines and over every visited state.

Result: Jev-stopped top 7/36 pass; any visited state 11/36 pass (`bitcount`, `breadth_first_search`,
`bucketsort`, `find_first_in_sorted`, `flatten`, `hanoi`, `knapsack`, `levenshtein`, `next_permutation`,
`quicksort`, `sieve`). Site selection is the weak Choice: 30–60 options that differ only by position, and the
stop option is chosen on wrong lines: Jev stopped within depth 3 on 35/36 lines, but the top stopped line was
the exact fix on only 5/36. Note the site keys (`replace_<tok>_at_<i>`, `insert_before_position_<g>`) put a
position index in the key, which REPORT §10 identifies as Jev's weak spot; the marked-line descriptions
mitigate this but the route remains the weakest on this corpus. It is the cheapest route ($0.0020/line) and the only one to
solve `levenshtein` (delete `1 +`) but it is dominated by the token beam on this corpus. Two-token edits
(`+ 1`, `[k:]`) were not reached within depth 3 because the first edit alone scores low.

## 6. Per-line rows (n = 40)


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

## 7. What this means for the design

1. **Jev can build a line, but as a proposer inside a search, not as a decoder.** Per-position accuracy is
   84 % top-1 / 96 % top-3 with the true prefix; free-running, width-3 beam + a code-side grammar filter +
   tests over the top-3 completions reconstructs **20/40** QuixBugs fix lines (17 exact top beam) for
   $0.0037 and 3.3 s per line. The success criterion in `JEV-ONLY.md` (≥ 60 % end to end, < $0.05 and 2 min
   per program) is within reach on cost and time; accuracy needs the portfolio below.
2. **Portfolio + oracle: 28/40 (70 %) lines get a test-passing line from at least one of the five runs**
   (beam W=1, W=3, W=3+grammar, template route, edit beam). The cheap portfolio actually proposed
   (templates + W=3+grammar + edit beam, ≈ $0.0067 per line) covers **27/40**; the 28th line
   (`shortest_path_lengths`) was solved only by the unfiltered W=3 run (+$0.0065 per line). The union over
   five single-shot runs is an optimistic estimate (each run is one more draw at Jev noise ±0.02); a
   confirmatory run of the fixed portfolio is needed before quoting 27/40 as the pipeline's rate. The routes
   fail on different lines: the template route solves `bitcount`, `hanoi`, `quicksort`, `topological_ordering`,
   `shunting_yard` where the token beam fails; the edit beam alone solves `levenshtein` and `next_permutation`.
   The right architecture is *generate candidates from every source, verify with tests, only then ask Jev to
   rank what survived*; every route here is cheap enough to always run. Remaining 12 failures are additive
   fixes (`max(0, …)`, `or not coins`, `[k:]`, `** 2`, `[[]]`, `hare is None or …`) and long comprehensions: a
   "wrap the expression" / "add a guard clause" template family from fix-template literature (TBar: Liu,
   Koyuncu, Kim, Bissyandé, "TBar: Revisiting Template-based Automated Program Repair", ISSTA 2019,
   https://arxiv.org/abs/1903.08409, fetched 2026-09-20) is the obvious next candidate source.
3. **Code must own syntax and position; Jev owns content.** 58/67 teacher-forced misses were skip-ahead
   (right token, wrong position). The grammar filter, a 40-line function, added +4 lines and −43 % cost.
   Push further: offer only tokens legal for the prefix *and* consistent with a parse of the buggy line
   (bracket depth, statement kind), let code enforce `end_of_line` legality, and never ask Jev where the
   cursor is or which of two same-type identifiers comes first. Argument order was the failure mode of the
   *slot-filling* and *edit* routes on `rpn_eval`, `next_permutation`, `shortest_path_lengths` (and of parallel
   slot filling on `gcd`); it did **not** fail in every route: the token beam solved `gcd` (all widths),
   `rpn_eval` (W=3+grammar) and `shortest_path_lengths` (W=3), and the edit beam solved `next_permutation`
   (the pre-verification text claimed "failed in all four routes", which the per-line table contradicts).
   Argument order should still be a separate Choice over permutations with the test's expected value in the
   state, because the routes that got it right did so at W=3 rather than top-1.
4. **Do not trust Σ log p or Jev's stop signal to rank whole lines; verify.** Σ log p prefers short
   completions; `end_of_line` wins early on additive fixes (buggy-line anchoring). Keep W ≥ 3 distinct
   completions and run tests on all of them. The anchor probe's "selection Choice over verified survivors" is
   the right final step, not the beam score.
5. **Calibration is usable for routing.** Positions with p(top) ≥ 0.9 were right 99 % (101 of them); 0.6–0.9
   90–95 %; below 0.6 only 42–60 %. A beam can expand 1 option when p(top) ≥ 0.9 and 3–5 when below 0.6,
   saving roughly half the requests without losing the correct prefix (REPORT §14: thresholds from your own
   plot, not 0.5).
6. **Templates are the cheapest route when they cover** (7.7 requests, $0.0010 per line; 15/17 selection,
   35/40 slot filling), so run them first and fall back to the token beam. Slot filling should be sequential
   (35 vs 32; a 3-line difference is within single-run noise, so treat this as a lean, not a result).
   Coverage (17/40) must come from more template sources (mutation templates already gave 5 of the 17;
   TBar-style insertion templates and donor lines from the whole repository would add more).
7. **The escape option does not detect "the pool is wrong" when the buggy line is in the state** (5/23);
   pair every template/candidate Choice with a Noul "does `buggy_line` already make `tests` pass?" and a Noul
   per shortlisted candidate, as REPORT §10 recommends.
8. **Budget for the QuixBugs ladder step.** Full pipeline estimate per program: localisation 1 request,
   templates ~8, token beam ~31, edit beam ~19, ≤ 10 test runs: ≈ 60 requests, ≈ $0.01, ≈ 10–15 s wall
   with 3-way parallel steps. Well under the $0.05 / 2 min criterion.

## 8. Caveats

- The fix position (and, for the 4 insertions, the insertion point) was given. End-to-end QuixBugs numbers
  must multiply by localisation (13/14 top-1 in the anchor probe, top-3 14/14, so a beam over the top-3
  lines would cost 3×).
- Tests in the state were 3 cases; verification used all upstream cases. `possible_change`'s buggy program
  also contained a `# Python 3` comment line that the corpus keeps.
- `shortest_paths`' fix line is a multi-line fragment (`… = min(`); no route can produce it under the grammar
  filter (a line cannot end in `(`), and none did without it.
- n = 40 lines / 426 positions; differences of 1–3 lines between conditions are within noise. Jev noise
  itself is ±0.02 (REPORT §6); no run was repeated.
- Wall times include test verification; Jev p50 was 203–250 ms in every run, 16–18 concurrent requests.

## 9. Reproduce

```
git clone --depth 1 https://github.com/jkoppel/QuixBugs /tmp/quixbugs && mkdir -p /tmp/jevonly/work
cd experiments/probe-tokens && python3 build_corpus.py /tmp/quixbugs out/corpus.json
R='env -u ANTHROPIC_API_KEY node --env-file=../../.env ../../node_modules/.bin/tsx'
$R teacher-forced.mts            # $0.09
$R beam.mts 1; $R beam.mts 3; $R beam.mts 3 grammar   # $0.09, $0.26, $0.15
$R templates.mts                 # $0.04
$R edit-beam.mts 3               # $0.07
python3 make_tables.py           # -> out/tables.md
```
`JEV_CAP_USD` (default 0.9) aborts a script when its own spend passes the cap.

## Verification (2026-09-20)

Adversarial check by a second agent. Scripts added under `experiments/probe-tokens/`: `verify_recompute.py`
(recomputes every table from `out/*.json`), `verify_offline.mts` (tokenizer, candidate set, grammar filter and
test runner, no Jev calls), `verify_sample.mts` (live re-run of a 4-program sample; raw output in
`out/verify-sample.json`). Verification spend: **$0.0215** over 158 requests (from `usage.costUsd`), Jev p50 205 ms.

**Recomputed from raw output, all match the report:** 426 positions / 40 lines; top-1 359, top-3 410,
MRR 0.905 and every per-class row of T1; every calibration band of T2 (p(top) ≥ 0.9: 100/101); 58 skip-ahead /
0 `none_of_these` / 1 same-position buggy token / 3 buggy tokens from elsewhere / 5 other among the 67 misses;
first-token top-1 38/40; 28/40 lines within top-3 at every position; beam W=1/W=3/W=3g top-exact 11/14/16,
top-pass 12/14/17, any-pass 12/16/20, truncated lines 5/4/0; template coverage 17 (8 buggy, 5 mutant, 4 donor),
selection 15/17 and 17/17, slot filling 35 sequential / 32 parallel, e2e 12/12; edit beam 5/7 stopped-top,
11 any-stopped and 11 any-visited; union 28/40; total cost $0.7032 over 4,277 requests, with `usage.cost`
equal to the sum of per-row costs in every file; latency p50 and input-tokens-per-request as stated.

**Verified offline with the real code:** tokenizer round trip 40/40; fix lines 2–21 tokens, mean 9.7;
candidate coverage 386/386 target tokens; grammar filter admits the true next token at 425/426 (the exclusion is
`shortest_paths` end-of-line after `min(`) and cuts mean options 132.8 → 60.3; detokenised fix lines pass tests
40/40; `run_tests.py` passes all 40 correct programs and fails all 40 buggy programs; the `choice()` builder in
`src/jev/questions.ts` appends `none_of_these` to every Choice, so every question had an escape option.

**Live sample re-run** (`gcd`, `kth`, `possible_change`, `bucketsort`): teacher-forced 40 positions, top-1
36/40 and top-3 38/40 both identical to the saved rows, same top-1 key at 40/40 positions, mean |Δ p(top)| 0.023;
beam W=3+grammar reproduced the same top line and pass/fail on all 4 lines (3/4 pass, as saved) with 16–46
requests per line (saved 19–46). The scripts do what the tables claim.

**Corrections made in the text above (numbers in the tables were right; prose around them was not):**

1. §1 option range 106–146 → **121–159** per program (mean 133 was right).
2. §2 "11/40 lines have every position top-1" → **9/40** (11 is the W=1 beam's exact count).
3. §3 the five short top completions were split across the unfiltered and grammar-filtered W=3 runs, not all
   from the unfiltered run.
4. §4 T5 and observation: "picked the buggy line's template 18/23" was computed as "did not pick
   `none_of_these`"; the buggy line's template was chosen **16/23** times (two others: `max_sublist_sum`,
   `shortest_paths`).
5. §4 "two failures ... argument order (`gcd`, ...)" → there were 5 sequential slot failures, 3 of them
   argument order; `gcd` failed only in the parallel variant.
6. §5 "stop option rarely chosen (5/36)" → Jev stopped on 35/36 lines; the stopped line was exact on 5/36.
7. §7.2 the 28/40 union needs all five runs including unfiltered W=3; the proposed cheap portfolio
   (templates + W=3g + edit) covers 27/40 at ≈ $0.0067 per line, and the union over independent single runs is
   an optimistic estimate. The edit beam is the sole solver of `next_permutation` as well as `levenshtein`.
8. §7.3 "argument order failed in all four routes" was contradicted by the per-line table: `gcd`, `rpn_eval`
   and `shortest_path_lengths` were solved by the token beam and `next_permutation` by the edit beam. Rewritten.
9. Literature: the file cited no URLs or dates. The two external references it relies on were fetched on
   2026-09-20: TBar (Liu et al., ISSTA 2019, https://arxiv.org/abs/1903.08409, confirmed to be the
   template-based APR paper) and QuixBugs (https://github.com/jkoppel/QuixBugs, confirmed 40 programs in Python
   and Java, each with a one-line defect). `REPORT §n` references were checked against
   `/Users/prateekjannu/Documents/jev-research/REPORT.md`: §6 (noise up to sd 0.026 in the 0.55–0.80 band), §7
   (question independence), §10 (positional arithmetic weak, name priors in keys, escape options), §14
   (thresholds from your own plot) all say what the report attributes to them.

**Question design against REPORT rules.** Every Choice has an escape option and semantic snake_case keys with
object descriptions; state names targets by backticked path; nothing asks Jev to count or compute. Two
tensions remain and are inherent to the routes, not errors: the next-token question requires Jev to track the
cursor position (which the report itself identifies as the cause of 58/67 misses), and the edit-beam site keys
embed a position index (`_at_<i>`). In the beam and slot-filling code `none_of_these` is asked for but never
acted on (it is skipped when expanding), so the escape option is informational only in those routes.

**Not verifiable here:** the wall-time figures (depend on host load; the logs show 40–127 s outliers from
test-verification timeouts, so the p50 is the right summary); the claim that the estimated full pipeline is
"≈ 60 requests, ≈ $0.01, 10–15 s" is an extrapolation, not a measurement, and localisation was not run in this
probe. The 28/40 (or 27/40) portfolio figure is a union over single runs and has not been confirmed by a
second run of the combined pipeline.

**Verdict: corrected.** The measurements and tables are sound and reproduce; eight prose statements were
inaccurate or overreaching and have been fixed in place; the headline (84 % / 96 % teacher-forced; 20/40 for
W=3+grammar; portfolio 27–28/40 with tests as oracle) stands with the caveats above.
