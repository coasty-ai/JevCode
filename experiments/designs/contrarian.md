# Contrarian design: Sieve — enumerate everything, let the tests rank, ask Jev only what tests cannot answer

Author: architect (contrarian angle), 2026-09-20. Status: design backed by the measurement files under
`experiments/results/` plus one new code-only measurement (`experiments/contrarian/`, this file's §0).
Nothing under `src/` or `docs/` was changed. Model everywhere: `typesafe/jev-1.13-20260917`.

## The claim, in one paragraph

Every other candidate design spends most of its Jev calls asking "which of these 50–254 near-identical
lines is the fix". Jev is *mediocre* at exactly that question and *exact tests are cheap* at exactly that
question: Choice top-1 falls from 90 % at N = 10 to 65 % at N = 254 (`probe-selection.md` Summary, verified
intrinsic: 95 % → 72 % even without the escape option), batched Nouls hold 78–80 % at N = 254 but are
order-sensitive on near-misses (`lit-search-based-repair.md` verification: `kth` rank 2 → 6, `sqrt` 42 → 76 on a
reshuffle), and in the end the design still runs the tests on the top-3 (`probe-selection.md` design point 2).
Meanwhile one QuixBugs test run costs 90–400 ms (§0: run-duration p50 per program 87–395 ms on the
non-timeout programs) and the whole first-order candidate set of a line is 33–334 lines. The prototype that
reached 32/40 (`prototype-baseline.md`) spent 4 of its 5.3 Jev requests per program on ranking, hit the
40-test-run cap on every one of its 8 failures while using ≤ 14 of 30 Jev requests, and lost 3 programs to a
greedy "adopt the partial" commitment that only looked attractive because it was rationing test runs. Test
runs were the binding budget *by choice*, not by cost: the entire first-order candidate set of the true
line runs to completion in a median of **3.8 s** per program at 8-way parallelism (§0, Table 0.1).

So: **the ranker should be `python3`**, and Jev should be spent on the three decisions tests cannot make:
(1) *where* to look (localisation from text and from the actual failure: 70 % top-1 / 90 % top-3 on lines
with the actual output, `probe-localization.md` §1; 77 % top-1 file over a whole repository from the issue
text alone, `probe-swebench-understanding.md` Q6), (2) *which of several test-passing patches is the
genuine one* (the overfitting question tests cannot answer by construction; 53 % of plausible QuixBugs-Java
patches overfit in Ye et al., `lit-search-based-repair.md` §4; measured here in §0, Table 0.3), and (3) *which
failing test to attack next* when there are several (a real preference at 2× chance, `probe-progress-judgment.md`
Part 3). Jev ranking of candidates survives only as an *ordering* of the run queue when tests are expensive
(SWE-bench), never as a gate, and never as the thing that decides.

## 0. New measurement: what exhaustive verification actually costs, and how many patches "pass"

Scripts: `experiments/contrarian/exhaustive.mts` (code only, no Jev), `experiments/contrarian/arbitrate.mts`
(live Jev, cents), `experiments/contrarian/summarise.py` (tables). Raw rows:
`experiments/results/contrarian-exhaustive.truth.jsonl`, `contrarian-exhaustive.all.jsonl`,
`contrarian-arbitrate.truth.jsonl`. Candidate library, loaders and runner are the prototype's
(`experiments/prototype/mutations.mts`, `quixbugs.mts`, `verify.mts` over `bench/data/quixbugs/run_tests.py`,
per-test subprocess timeouts, upstream `slow` cases skipped). The unchanged line is never re-tested.

Reproduce:

```
node node_modules/.bin/tsx experiments/contrarian/exhaustive.mts --scope truth --timeout 2   --concurrency 8    # $0
node node_modules/.bin/tsx experiments/contrarian/exhaustive.mts --scope all   --timeout 0.5 --cap 200 --concurrency 12
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/contrarian/arbitrate.mts --scope truth   # $0.0008
env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/contrarian/arbitrate.mts --scope all     # $0.0015
python3 experiments/contrarian/summarise.py
```

Two questions: (a) if the buggy line is known, how long does it take to run *every* first-order mutant
through the full test suite, and how many mutants pass everything ("plausible")? (b) with no localisation at
all (every code line of the program except `def` lines, cap 200 per line), what does brute force cost and how
many *lines* admit a test-passing patch?

### Reading Table 0.1

- **Every enumerated gold fix passes when run (35/36 replacements; the 36th, `shortest_paths`, is not
  first-order).** Nothing is lost between "the fix is in the set" and "the tests accept it": the runner and
  the oracle agree, so exhaustive verification has no ranking loss at all.
- **Cost: 4,892 test runs, 260 s wall for all 40 programs at 8-way parallelism; median 3.8 s per program,
  run duration p50 220 ms.** Three programs are timeout-dominated (`bitcount` 6.1 s p50, `sqrt` 4.1 s,
  `find_first_in_sorted` 2.1 s): their mutants loop, and the 2 s per-test timeout, not the tests, sets the
  price (47.6 s for `sqrt`). Table 0.2 measures the same at 0.5 s.
- **On 25/36 replacement bugs the gold line is the ONLY candidate that passes.** No decision of any kind is
  left after the tests. On the other 10 there are 2–5 plausible candidates, all at the true line, and on
  inspection they are mostly equivalent rewrites (`while queue:` vs `while len(queue) > 0:`; `return depth == 0`
  vs `return not depth`; `perm[i] < perm[j]` vs `perm[j] > perm[i]`). The genuinely different ones are boundary
  variants the tests cannot separate (`while lo != hi:` for `while lo < hi:`; `max(x, …)` for `max(0, …)`).
- **158 "partial" candidates (pass strictly more tests than the buggy program without passing all)** are
  spread over 22 programs, 10–21 on `sqrt`, `gcd`, `lcs_length`, `next_permutation`, `sieve`,
  `minimum_spanning_tree`. This is the density of greedy traps a rationed loop walks into when it adopts the
  first partial it meets (`prototype-baseline.md`: `kth`, `sqrt`, `topological_ordering`); exhaustive
  verification sees all of them and the gold at once and never has to choose a base.

### Reading Table 0.3

- **Jev picks the gold line 8/10 by Choice and 8/10 by per-candidate Noul, for $0.0008 in total, 189 ms
  p50.** The two "misses" are `if perm[j] > perm[i]:` for `if perm[i] < perm[j]:` and `if not coins or total < 0:`
  for `if total < 0 or not coins:`: both semantically identical to the gold, so the arbitration is
  **10/10 correct-or-equivalent**. The code-only min-edit baseline manages 3/10 (6 ties).
- The Noul is the calibrated instrument: equivalent rewrites get 0.5–0.9 (`while len(queue) > 0:` 0.92,
  `return not depth` 0.93), boundary variants that only fit the tests get ≤ 0.31 (`while lo != hi:` 0.31,
  `if weight - 1 < j:` 0.49 is the exception), and on `quicksort` every candidate is low (gold 0.15) while the
  Choice still ranks the gold first at 0.60 with 0.38 on the escape. Behaviour clustering (§3.4) would have
  merged the two "miss" pairs into one cluster before Jev was asked, so `Q_arbitrate` is needed on ≈ 4–6 of
  40 programs and is right on the ones measured.


### Table 0.1 — exhaustive verification at the TRUE line (n = 40 programs, per-test timeout 2 s, 8 candidates in parallel, no cap)

| program | kind | lines tried | candidates | runs | plausible (lines) | gold | partial | timeouts | wall s | run ms p50 / mean / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | replace | 1 | 33 | 33 | 1 (1) | PASS | 6 | 0 | 24.7 | 6067 / 3772 / 6115 |
| breadth_first_search | replace | 1 | 137 | 137 | 4 (1) | PASS | 0 | 0 | 1.7 | 87 / 88 / 97 |
| bucketsort | replace | 1 | 96 | 96 | 1 (1) | PASS | 0 | 0 | 3.2 | 251 / 253 / 317 |
| depth_first_search | insert | 0 | 0 | 0 | 0 (0) | absent (insert) | 0 | 0 | 0.1 | 0 / 0 / 0 |
| detect_cycle | replace | 1 | 59 | 59 | 2 (1) | PASS | 0 | 0 | 0.9 | 100 / 98 / 105 |
| find_first_in_sorted | replace | 1 | 115 | 115 | 4 (1) | PASS | 2 | 0 | 22.5 | 2105 / 1366 / 2242 |
| find_in_sorted | replace | 1 | 150 | 150 | 1 (1) | PASS | 4 | 0 | 4.8 | 244 / 247 / 368 |
| flatten | replace | 1 | 108 | 108 | 1 (1) | PASS | 12 | 0 | 3.8 | 260 / 263 / 376 |
| gcd | replace | 1 | 92 | 92 | 1 (1) | PASS | 10 | 0 | 5.0 | 229 / 312 / 4080 |
| get_factors | replace | 1 | 78 | 78 | 1 (1) | PASS | 0 | 0 | 3.9 | 370 / 371 / 469 |
| hanoi | replace | 1 | 69 | 69 | 1 (1) | PASS | 4 | 0 | 2.5 | 263 / 261 / 294 |
| is_valid_parenthesization | replace | 1 | 62 | 62 | 2 (1) | PASS | 0 | 0 | 1.1 | 124 / 124 / 139 |
| kheapsort | replace | 1 | 44 | 44 | 1 (1) | PASS | 0 | 0 | 1.1 | 164 / 162 / 185 |
| knapsack | replace | 1 | 184 | 184 | 3 (1) | PASS | 2 | 0 | 7.2 | 300 / 299 / 386 |
| kth | replace | 1 | 189 | 189 | 1 (1) | PASS | 4 | 0 | 6.7 | 268 / 273 / 384 |
| lcs_length | replace | 1 | 245 | 245 | 1 (1) | PASS | 16 | 0 | 11.0 | 334 / 346 / 527 |
| levenshtein | replace | 1 | 149 | 149 | 4 (1) | PASS | 14 | 0 | 21.9 | 154 / 894 / 10071 |
| lis | replace | 1 | 140 | 140 | 1 (1) | PASS | 0 | 0 | 6.3 | 346 / 344 / 464 |
| longest_common_subsequence | replace | 1 | 176 | 176 | 1 (1) | PASS | 0 | 0 | 12.9 | 310 / 453 / 4707 |
| max_sublist_sum | replace | 1 | 86 | 86 | 2 (1) | PASS | 0 | 0 | 2.3 | 193 / 195 / 258 |
| mergesort | replace | 1 | 177 | 177 | 1 (1) | PASS | 2 | 0 | 9.2 | 395 / 400 / 565 |
| minimum_spanning_tree | replace | 1 | 145 | 145 | 1 (1) | PASS | 16 | 0 | 1.7 | 87 / 87 / 92 |
| next_palindrome | replace | 1 | 152 | 152 | 1 (1) | PASS | 0 | 0 | 3.6 | 177 / 178 / 225 |
| next_permutation | replace | 1 | 207 | 207 | 5 (1) | PASS | 16 | 0 | 7.3 | 273 / 273 / 400 |
| pascal | replace | 1 | 95 | 95 | 1 (1) | PASS | 3 | 0 | 2.3 | 180 / 180 / 220 |
| possible_change | replace | 1 | 95 | 95 | 2 (1) | PASS | 0 | 0 | 3.9 | 307 / 311 / 394 |
| powerset | replace | 1 | 155 | 155 | 1 (1) | PASS | 0 | 0 | 3.7 | 179 / 181 / 248 |
| quicksort | replace | 1 | 180 | 180 | 3 (1) | PASS | 0 | 0 | 9.3 | 394 / 400 / 599 |
| reverse_linked_list | insert | 0 | 0 | 0 | 0 (0) | absent (insert) | 0 | 0 | 0.1 | 0 / 0 / 0 |
| rpn_eval | replace | 1 | 83 | 83 | 1 (1) | PASS | 0 | 0 | 2.4 | 211 / 213 / 307 |
| shortest_path_length | replace | 1 | 334 | 334 | 1 (1) | PASS | 1 | 0 | 3.9 | 89 / 89 / 109 |
| shortest_path_lengths | replace | 1 | 244 | 244 | 1 (1) | PASS | 2 | 0 | 2.8 | 88 / 88 / 102 |
| shortest_paths | replace | 1 | 91 | 91 | 0 (0) | not enumerated | 0 | 0 | 1.2 | 90 / 89 / 102 |
| shunting_yard | insert | 0 | 0 | 0 | 0 (0) | absent (insert) | 0 | 0 | 0.1 | 0 / 0 / 0 |
| sieve | replace | 1 | 194 | 194 | 1 (1) | PASS | 15 | 0 | 4.9 | 195 / 196 / 288 |
| sqrt | replace | 1 | 126 | 126 | 1 (1) | PASS | 21 | 0 | 47.6 | 4079 / 2661 / 4133 |
| subsequences | replace | 1 | 117 | 117 | 1 (1) | PASS | 0 | 0 | 5.5 | 364 / 362 / 448 |
| to_base | replace | 1 | 122 | 122 | 1 (1) | PASS | 0 | 0 | 5.0 | 311 / 309 / 425 |
| topological_ordering | replace | 1 | 163 | 163 | 1 (1) | PASS | 8 | 0 | 1.9 | 85 / 85 / 96 |
| wrap | insert | 0 | 0 | 0 | 0 (0) | absent (insert) | 0 | 0 | 0.1 | 0 / 0 / 0 |

Totals (truth): candidates 4892, test runs 4892, wall 260 s (per program median 3.8 s, max 47.6 s), CPU-seconds (sum of run durations) 1808, concurrency 8, per-test timeout 2 s, cap 100000.
Replacement bugs: 36; gold enumerated 35/36; gold passes all tests 35/36.
Programs with >= 1 plausible: 35/40; exactly 1: 25; >= 2: 10; plausible per program median 1.0, max 5; distinct lines with a plausible candidate median 1.0, max 1.
Candidates per program median 119.5; run duration p50 over programs median 220.0 ms; programs whose run p50 > 1 s (timeout-dominated): 3; partial (more tests pass) candidates total 158.
Replacement bugs where the ONLY test-passing candidate is the gold line: 25/36 (no arbitration needed).

### Table 0.3 — Jev arbitration among the test-passing candidates of Table 0.1 (n = 10 programs with ≥ 2 plausible; one request each: Choice + one criteria Noul per candidate)

| program | plausible | Choice top = gold | P(gold) / P(top) / P(escape) | Noul top = gold | Noul(gold) / Noul(top) | min-edit baseline | cost | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| breadth_first_search | 4 | Y | 0.99 / 0.99 / 0.01 | Y | 0.96 / 0.96 | Y | $0.0001 | 415 |
| detect_cycle | 2 | Y | 0.75 / 0.75 / 0.08 | Y | 0.73 / 0.73 | n | $0.0001 | 288 |
| find_first_in_sorted | 4 | Y | 0.61 / 0.61 / 0.17 | Y | 0.40 / 0.40 | tie | $0.0001 | 164 |
| is_valid_parenthesization | 2 | Y | 0.89 / 0.89 / 0.05 | Y | 0.96 / 0.96 | n | $0.0001 | 213 |
| knapsack | 3 | Y | 0.98 / 0.98 / 0.01 | Y | 0.89 / 0.89 | Y | $0.0001 | 165 |
| levenshtein | 4 | Y | 0.98 / 0.98 / 0.01 | Y | 0.93 / 0.93 | tie | $0.0001 | 387 |
| max_sublist_sum | 2 | Y | 0.78 / 0.78 / 0.03 | Y | 0.72 / 0.72 | tie | $0.0001 | 157 |
| next_permutation | 5 | n | 0.05 / 0.87 / 0.03 | n | 0.45 / 0.71 | tie | $0.0001 | 129 |
| possible_change | 2 | n | 0.21 / 0.73 / 0.06 | n | 0.62 / 0.72 | tie | $0.0001 | 229 |
| quicksort | 3 | Y | 0.60 / 0.60 / 0.38 | Y | 0.15 / 0.15 | Y | $0.0001 | 159 |

Choice top-1 8/10, Noul top-1 8/10, min-edit 3/10; cost $0.0008; p50 189 ms

Candidates per program (gold marked *):

- `breadth_first_search`: *L11 `while queue:` (choice 0.99, noul 0.96); L11 `while len(queue) > 0:` (choice 0.00, noul 0.92); L11 `while True and queue:` (choice 0.00, noul 0.52); L11 `while queue and True:` (choice 0.00, noul 0.79)
- `detect_cycle`: *L5 `if hare is None or hare.successor is None:` (choice 0.75, noul 0.73); L5 `if not hare or hare.successor is None:` (choice 0.17, noul 0.70)
- `find_first_in_sorted`: *L5 `while lo < hi:` (choice 0.61, noul 0.40); L5 `while lo != hi:` (choice 0.02, noul 0.31); L5 `while lo + 1 <= hi:` (choice 0.13, noul 0.23); L5 `while lo <= hi - 1:` (choice 0.07, noul 0.30)
- `is_valid_parenthesization`: *L12 `return depth == 0` (choice 0.89, noul 0.96); L12 `return not depth` (choice 0.06, noul 0.93)
- `knapsack`: *L12 `if weight <= j:` (choice 0.98, noul 0.89); L12 `if weight - 1 < j:` (choice 0.00, noul 0.49); L12 `if weight < j + 1:` (choice 0.01, noul 0.75)
- `levenshtein`: L6 `return 1 * levenshtein(source[1:], target[1:])` (choice 0.00, noul 0.45); L6 `return 0 + levenshtein(source[1:], target[1:])` (choice 0.01, noul 0.83); L6 `return 1 + levenshtein(source[1:], target[1:]) - 1` (choice 0.00, noul 0.81); *L6 `return levenshtein(source[1:], target[1:])` (choice 0.98, noul 0.93)
- `max_sublist_sum`: *L7 `max_ending_here = max(0, max_ending_here + x)` (choice 0.78, noul 0.72); L7 `max_ending_here = max(x, max_ending_here + x)` (choice 0.19, noul 0.39)
- `next_permutation`: L6 `if perm[j] > perm[i]:` (choice 0.87, noul 0.71); L6 `if perm[j] >= perm[i]:` (choice 0.01, noul 0.19); L6 `if not perm[j] < perm[i]:` (choice 0.02, noul 0.51); *L6 `if perm[i] < perm[j]:` (choice 0.05, noul 0.45); L6 `if not (perm[j] < perm[i]):` (choice 0.02, noul 0.47)
- `possible_change`: *L5 `if total < 0 or not coins:` (choice 0.21, noul 0.62); L5 `if not coins or total < 0:` (choice 0.73, noul 0.72)
- `quicksort`: *L7 `greater = quicksort([x for x in arr[1:] if x >= pivot])` (choice 0.60, noul 0.15); L7 `greater = quicksort([x for x in arr[1:] if x + 1 > pivot])` (choice 0.01, noul 0.09); L7 `greater = quicksort([x for x in arr[1:] if x > pivot - 1])` (choice 0.01, noul 0.09)


### Reading Table 0.2 (no localisation at all)

- **Cost: 37,243 test runs over 380 lines, 1181 s wall for all 40 programs at 12-way
  parallelism; median 23.8 s per program, max 119.4 s (mergesort).** That is the price of
  skipping localisation entirely on a QuixBugs-sized file: roughly 4.5× the true-line cost of Table 0.1 for
  7.6× the runs (the shorter 0.5 s timeout pays for part of the difference: the timeout-dominated
  programs of Table 0.1 cost bitcount 24 s, find_first_in_sorted 54 s, sqrt 32 s here).
- **The 0.5 s per-test timeout rejected no gold fix: gold passes on 35/35 replacement bugs whose fix was enumerated**
  (cap 200 per line lost 0 gold lines vs Table 0.1's uncapped enumeration).
- **Overfitting exposure without localisation: 6/40 programs have test-passing candidates on ≥ 2 different lines**
  (`detect_cycle` 8 on 2 lines, `find_in_sorted` 3 on 2 lines, `get_factors` 16 on 2 lines, `minimum_spanning_tree` 2 on 2 lines, `quicksort` 6 on 2 lines, `rpn_eval` 2 on 2 lines); 1/4 insertion bugs acquire
  7 replacement "fixes" that only satisfy the tests (the prototype's `depth_first_search` overfit is one of them),
  and 0 replacement bugs pass only through a wrong line. Plausible candidates per program: median 1.0, max 16;
  21/40 programs still have the gold as their only passing candidate. Compared with Table 0.1, brute force adds
  35 plausible candidates in total, so localisation's job in this design is not to find the fix (tests do) but to
  keep the plausible set small enough that the arbitration in Table 0.4 stays easy.

### Reading Table 0.4

- Sets that contain the gold (14 programs, 2–16 plausible candidates each, now spread over 1–2 lines):
  **Choice top-1 = gold 10/14, Noul top-1 = gold 10/14, min-edit baseline 2/14**; $0.0015 for all 15
  requests, 219 ms p50. By inspection the four Choice misses are: `next_permutation` and `possible_change`
  (the same equivalent rewrites as in Table 0.3), `quicksort` (`lesser = … x <= pivot` at L6, the equally
  correct alternative fix the prototype also found, `prototype-baseline.md` "Alternative fixes"), and
  `detect_cycle`, the one genuine wrong-line pick: `while hare is not None:` at L4 (Choice 0.41) over the
  gold `if hare is None or hare.successor is None:` at L5 (0.37); that candidate makes the loop fall through
  and return `None` where the gold returns `False`, which the `assert not …` tests cannot distinguish. So
  **13/14 gold-or-equivalent, 1 wrong-line pick**, and on that one the per-candidate Nouls rank a
  gold-equivalent first (0.76, gold 0.69, the wrong-line candidates 0.31–0.61).
- The set with **no** gold (`depth_first_search`, an insertion bug whose 7 "fixes" all replace the
  `for … in node.successors` line by a truthy expression): the escape option takes 0.90 of the Choice and the
  maximum per-candidate Noul is 0.06. That is the measurement behind the rule in §3.4: a plausible set whose
  best Noul is below 0.3 is not proposed; the loop moves to gap sites (statement templates) instead, which is
  exactly where this bug's real fix (`nodesvisited.add(node)`) lives. The prototype accepted this overfit
  (`prototype-baseline.md`: its one wrong repair).
- Wrong-line plausible candidates are real but rare on these suites (6/40 programs, all with the gold still
  present and still ranked first by at least one of the two instruments except `detect_cycle`), and the
  16-candidate `get_factors` set (14 range-bound variants at L6 that happen to pass, plus the gold `return [n]`)
  was resolved at 0.76 / 0.83. The lesson for the design is that the `widened` phase must run the
  behaviour-clustering step before `Q_arbitrate` (the 14 `get_factors` variants collapse to one cluster on
  perturbed inputs; `while hare is not None:` vs the gold separate on an input where the function must return
  `False`), and that the min-edit heuristic is not a substitute for Jev here (2/14).

Total live Jev spend for this file: **$0.0038** (10 + 15 + 15 requests over the two arbitration runs; the
first all-scope arbitration run was superseded when `wrap` was added and is not reported), Jev p50 189–219 ms.
Everything else was `python3` time: 42,135 test runs, ≈ 24 CPU-minutes, ≈ 24 minutes wall.

### Table 0.2 — brute force over EVERY code line except `def` lines (n = 40, per-test timeout 0.5 s, cap 200 per line, 12 candidates in parallel)

| program | kind | lines tried | candidates | runs | plausible (lines) | gold | partial | timeouts | wall s | run ms p50 / mean / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | replace | 5 | 206 | 206 | 1 (1) | PASS | 6 | 0 | 24.2 | 1596 / 1276 / 1716 |
| breadth_first_search | replace | 13 | 1261 | 1261 | 4 (1) | PASS | 0 | 0 | 10.9 | 98 / 100 / 2110 |
| bucketsort | replace | 7 | 691 | 691 | 1 (1) | PASS | 2 | 0 | 19.5 | 329 / 332 / 1159 |
| depth_first_search | insert | 10 | 826 | 826 | 7 (1) | absent (insert) | 0 | 0 | 7.1 | 99 / 99 / 123 |
| detect_cycle | replace | 8 | 436 | 436 | 8 (2) | PASS | 0 | 0 | 5.7 | 97 / 135 / 2103 |
| find_first_in_sorted | replace | 11 | 1132 | 1132 | 4 (1) | PASS | 20 | 0 | 54.0 | 623 / 561 / 1248 |
| find_in_sorted | replace | 10 | 1244 | 1244 | 3 (2) | PASS | 15 | 0 | 35.0 | 328 / 333 / 538 |
| flatten | replace | 6 | 411 | 411 | 1 (1) | PASS | 12 | 0 | 12.3 | 341 / 351 / 743 |
| gcd | replace | 4 | 205 | 205 | 1 (1) | PASS | 24 | 0 | 5.6 | 300 / 312 / 1154 |
| get_factors | replace | 6 | 625 | 625 | 16 (2) | PASS | 11 | 0 | 27.6 | 513 / 522 / 773 |
| hanoi | replace | 7 | 701 | 701 | 1 (1) | PASS | 15 | 0 | 23.5 | 392 / 395 / 1183 |
| is_valid_parenthesization | replace | 9 | 414 | 414 | 2 (1) | PASS | 0 | 0 | 6.9 | 186 / 190 / 276 |
| kheapsort | replace | 7 | 500 | 500 | 1 (1) | PASS | 0 | 0 | 12.2 | 239 / 275 / 693 |
| knapsack | replace | 12 | 1784 | 1784 | 3 (1) | PASS | 4 | 0 | 69.3 | 449 / 461 / 1143 |
| kth | replace | 11 | 1648 | 1648 | 1 (1) | PASS | 13 | 0 | 49.4 | 348 / 355 / 1173 |
| lcs_length | replace | 7 | 981 | 981 | 1 (1) | PASS | 42 | 0 | 39.6 | 464 / 477 / 800 |
| levenshtein | replace | 10 | 711 | 711 | 4 (1) | PASS | 14 | 0 | 74.6 | 240 / 1153 / 10609 |
| lis | replace | 9 | 1262 | 1262 | 1 (1) | PASS | 15 | 0 | 59.1 | 547 / 556 / 971 |
| longest_common_subsequence | replace | 10 | 705 | 705 | 1 (1) | PASS | 0 | 0 | 31.9 | 492 / 530 / 1736 |
| max_sublist_sum | replace | 6 | 456 | 456 | 2 (1) | PASS | 6 | 0 | 11.6 | 292 / 296 / 462 |
| mergesort | replace | 19 | 2231 | 2231 | 1 (1) | PASS | 2 | 0 | 119.4 | 632 / 637 / 2440 |
| minimum_spanning_tree | replace | 10 | 1238 | 1238 | 2 (2) | PASS | 22 | 0 | 10.5 | 97 / 98 / 133 |
| next_palindrome | replace | 14 | 1138 | 1138 | 1 (1) | PASS | 0 | 0 | 24.0 | 245 / 248 / 350 |
| next_permutation | replace | 8 | 1285 | 1285 | 5 (1) | PASS | 16 | 0 | 43.1 | 386 / 398 / 647 |
| pascal | replace | 9 | 1035 | 1035 | 1 (1) | PASS | 6 | 0 | 21.5 | 242 / 245 / 372 |
| possible_change | replace | 6 | 586 | 586 | 2 (1) | PASS | 0 | 0 | 23.1 | 430 / 446 / 1773 |
| powerset | replace | 6 | 436 | 436 | 1 (1) | PASS | 0 | 0 | 9.2 | 238 / 243 / 730 |
| quicksort | replace | 6 | 751 | 751 | 6 (2) | PASS | 0 | 0 | 36.2 | 567 / 571 / 730 |
| reverse_linked_list | insert | 6 | 281 | 281 | 0 (0) | absent (insert) | 0 | 0 | 3.3 | 99 / 125 / 1118 |
| rpn_eval | replace | 17 | 1009 | 1009 | 2 (2) | PASS | 2 | 0 | 28.5 | 320 / 331 / 1161 |
| shortest_path_length | replace | 32 | 4027 | 4027 | 1 (1) | PASS | 0 | 0 | 35.9 | 101 / 103 / 1620 |
| shortest_path_lengths | replace | 12 | 1283 | 1283 | 1 (1) | PASS | 5 | 0 | 13.0 | 118 / 117 / 138 |
| shortest_paths | replace | 11 | 948 | 948 | 0 (0) | not enumerated | 0 | 0 | 10.3 | 125 / 124 / 138 |
| shunting_yard | insert | 17 | 1033 | 1033 | 0 (0) | absent (insert) | 0 | 0 | 38.5 | 431 / 437 / 1281 |
| sieve | replace | 5 | 518 | 518 | 1 (1) | PASS | 15 | 0 | 20.5 | 461 / 463 / 785 |
| sqrt | replace | 4 | 402 | 402 | 1 (1) | PASS | 28 | 0 | 31.9 | 1146 / 898 / 1380 |
| subsequences | replace | 8 | 824 | 824 | 1 (1) | PASS | 0 | 0 | 59.6 | 857 / 857 / 1464 |
| to_base | replace | 8 | 706 | 706 | 1 (1) | PASS | 0 | 0 | 46.7 | 723 / 780 / 1922 |
| topological_ordering | replace | 6 | 521 | 521 | 1 (1) | PASS | 8 | 0 | 7.0 | 150 / 151 / 1166 |
| wrap | insert | 8 | 792 | 792 | 0 (0) | absent (insert) | 0 | 0 | 18.3 | 254 / 270 / 1201 |

Totals (all): candidates 37243, test runs 37243, wall 1181 s (per program median 23.8 s, max 119.4 s), CPU-seconds (sum of run durations) 13783, concurrency 12, per-test timeout 0.5 s, cap 200.
Replacement bugs: 36; gold enumerated 35/36; gold passes all tests 35/36.
Programs with >= 1 plausible: 36/40; exactly 1: 21; >= 2: 15; plausible per program median 1.0, max 16; distinct lines with a plausible candidate median 1.0, max 2.
Candidates per program median 771.5; run duration p50 over programs median 328.5 ms; programs whose run p50 > 1 s (timeout-dominated): 2; partial (more tests pass) candidates total 303.

### Table 0.4 — Jev arbitration on the cross-line plausible sets of Table 0.2 (premise "at most one is genuine"; sets without the gold included) (n = 14)

| program | plausible | Choice top = gold | P(gold) / P(top) / P(escape) | Noul top = gold | Noul(gold) / Noul(top) | min-edit baseline | cost | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| breadth_first_search | 4 | Y | 0.99 / 0.99 / 0.01 | Y | 0.92 / 0.92 | Y | $0.0001 | 273 |
| detect_cycle | 8 | n | 0.37 / 0.41 / 0.05 | n | 0.69 / 0.76 | n | $0.0001 | 182 |
| find_first_in_sorted | 4 | Y | 0.65 / 0.65 / 0.20 | Y | 0.45 / 0.45 | tie | $0.0001 | 158 |
| find_in_sorted | 3 | Y | 0.81 / 0.81 / 0.06 | Y | 0.76 / 0.76 | tie | $0.0001 | 177 |
| get_factors | 16 | Y | 0.76 / 0.76 / 0.05 | Y | 0.83 / 0.83 | tie | $0.0003 | 329 |
| is_valid_parenthesization | 2 | Y | 0.91 / 0.91 / 0.04 | Y | 0.94 / 0.94 | n | $0.0001 | 135 |
| knapsack | 3 | Y | 0.97 / 0.97 / 0.02 | Y | 0.87 / 0.87 | Y | $0.0001 | 219 |
| levenshtein | 4 | Y | 0.96 / 0.96 / 0.03 | Y | 0.81 / 0.81 | tie | $0.0001 | 143 |
| max_sublist_sum | 2 | Y | 0.58 / 0.58 / 0.05 | Y | 0.63 / 0.63 | tie | $0.0001 | 411 |
| minimum_spanning_tree | 2 | Y | 0.65 / 0.65 / 0.27 | Y | 0.37 / 0.37 | n | $0.0001 | 163 |
| next_permutation | 5 | n | 0.10 / 0.79 / 0.06 | n | 0.45 / 0.65 | tie | $0.0001 | 354 |
| possible_change | 2 | n | 0.13 / 0.78 / 0.09 | n | 0.53 / 0.85 | tie | $0.0001 | 260 |
| quicksort | 6 | n | 0.02 / 0.79 / 0.17 | n | 0.18 / 0.49 | tie | $0.0001 | 342 |
| rpn_eval | 2 | Y | 0.81 / 0.81 / 0.07 | Y | 0.81 / 0.81 | tie | $0.0001 | 206 |

Choice top-1 10/14, Noul top-1 10/14, min-edit 2/14; cost $0.0014; p50 213 ms

Plausible sets with NO gold (every candidate overfits; insertion bugs or wrong lines), scope = all (n = 1): escape argmax 1/1, max Noul < 0.5 on 1/1

| program | plausible | P(escape) | P(top) | max Noul | escape is argmax |
| --- | --- | --- | --- | --- | --- |
| depth_first_search | 7 | 0.90 | 0.10 | 0.06 | Y |

Candidates per program (gold marked *):

- `breadth_first_search`: *L11 `while queue:` (choice 0.99, noul 0.92); L11 `while len(queue) > 0:` (choice 0.00, noul 0.88); L11 `while True and queue:` (choice 0.00, noul 0.40); L11 `while queue and True:` (choice 0.00, noul 0.67)
- `depth_first_search`: L11 `nextnode for nextnode in node.successors` (choice 0.10, noul 0.06); L11 `search_from(goalnode) for nextnode in node.successors` (choice 0.00, noul 0.03); L11 `node for nextnode in node.successors` (choice 0.00, noul 0.04); L11 `any for nextnode in node.successors` (choice 0.00, noul 0.04); L11 `goalnode for nextnode in node.successors` (choice 0.00, noul 0.04); L11 `depth_first_search for nextnode in node.successors` (choice 0.00, noul 0.03); L11 `startnode for nextnode in node.successors` (choice 0.00, noul 0.03)
- `detect_cycle`: L4 `while hare:` (choice 0.10, noul 0.54); L4 `while hare is not None:` (choice 0.41, noul 0.55); L4 `while True and hare is not None:` (choice 0.00, noul 0.31); L4 `while hare is not None and True:` (choice 0.00, noul 0.36); L4 `while True and hare:` (choice 0.00, noul 0.53); L4 `while hare and True:` (choice 0.00, noul 0.61); *L5 `if hare is None or hare.successor is None:` (choice 0.37, noul 0.69); L5 `if not hare or hare.successor is None:` (choice 0.07, noul 0.76)
- `find_first_in_sorted`: *L5 `while lo < hi:` (choice 0.65, noul 0.45); L5 `while lo != hi:` (choice 0.02, noul 0.35); L5 `while lo + 1 <= hi:` (choice 0.07, noul 0.33); L5 `while lo <= hi - 1:` (choice 0.06, noul 0.42)
- `find_in_sorted`: L3 `if start + 1 == end:` (choice 0.07, noul 0.33); L3 `if start == end - 1:` (choice 0.06, noul 0.30); *L9 `return binsearch(mid + 1, end)` (choice 0.81, noul 0.76)
- `get_factors`: L6 `for i in range(2, int(n + 0.5) + 1):` (choice 0.00, noul 0.15); L6 `for i in range(2, int(n / 0.5) + 1):` (choice 0.00, noul 0.15); L6 `for i in range(2, int(n // 0.5) + 1):` (choice 0.00, noul 0.20); L6 `for i in range(2, int(n + 1 ** 0.5) + 1):` (choice 0.00, noul 0.19); L6 `for i in range(2, int(n ** 2 ** 0.5) + 1):` (choice 0.02, noul 0.35); L6 `for i in range(2, int(n * 2 ** 0.5) + 1):` (choice 0.00, noul 0.16); L6 `for i in range(2, int(n ** 2) + 1):` (choice 0.00, noul 0.32); L6 `for i in range(2, int(n ** 1) + 1):` (choice 0.00, noul 0.26); L6 `for i in range(2, int(n ** 100) + 1):` (choice 0.00, noul 0.26); L6 `for i in range(2, int(n ** 5) + 1):` (choice 0.00, noul 0.23); L6 `for i in range(2, int(n ** 101) + 1):` (choice 0.00, noul 0.22); L6 `for i in range(2, int(n ** 104) + 1):` (choice 0.00, noul 0.12); L6 `for i in range(2, int(n ** 13) + 1):` (choice 0.00, noul 0.15); L6 `for i in range(2, int(n ** 3) + 1):` (choice 0.00, noul 0.18); L6 `for i in range(2, n + 1):` (choice 0.17, noul 0.59); *L10 `return [n]` (choice 0.76, noul 0.83)
- `is_valid_parenthesization`: *L12 `return depth == 0` (choice 0.91, noul 0.94); L12 `return not depth` (choice 0.05, noul 0.93)
- `knapsack`: *L12 `if weight <= j:` (choice 0.97, noul 0.87); L12 `if weight - 1 < j:` (choice 0.00, noul 0.51); L12 `if weight < j + 1:` (choice 0.01, noul 0.77)
- `levenshtein`: L6 `return 1 * levenshtein(source[1:], target[1:])` (choice 0.00, noul 0.21); L6 `return 0 + levenshtein(source[1:], target[1:])` (choice 0.01, noul 0.73); L6 `return 1 + levenshtein(source[1:], target[1:]) - 1` (choice 0.00, noul 0.45); *L6 `return levenshtein(source[1:], target[1:])` (choice 0.96, noul 0.81)
- `max_sublist_sum`: *L7 `max_ending_here = max(0, max_ending_here + x)` (choice 0.58, noul 0.63); L7 `max_ending_here = max(x, max_ending_here + x)` (choice 0.37, noul 0.58)
- `minimum_spanning_tree`: L11 `for node in group_by_node[u]:` (choice 0.08, noul 0.23); *L12 `group_by_node[node] = group_by_node[u]` (choice 0.65, noul 0.37)
- `next_permutation`: L6 `if perm[j] > perm[i]:` (choice 0.79, noul 0.65); L6 `if perm[j] >= perm[i]:` (choice 0.02, noul 0.22); L6 `if not perm[j] < perm[i]:` (choice 0.01, noul 0.36); *L6 `if perm[i] < perm[j]:` (choice 0.10, noul 0.45); L6 `if not (perm[j] < perm[i]):` (choice 0.02, noul 0.26)
- `possible_change`: *L5 `if total < 0 or not coins:` (choice 0.13, noul 0.53); L5 `if not coins or total < 0:` (choice 0.78, noul 0.85)
- `quicksort`: L6 `lesser = quicksort([x for x in arr[1:] if x <= pivot])` (choice 0.79, noul 0.49); L6 `lesser = quicksort([x for x in arr[1:] if x - 1 < pivot])` (choice 0.00, noul 0.08); L6 `lesser = quicksort([x for x in arr[1:] if x < pivot + 1])` (choice 0.01, noul 0.16); *L7 `greater = quicksort([x for x in arr[1:] if x >= pivot])` (choice 0.02, noul 0.18); L7 `greater = quicksort([x for x in arr[1:] if x + 1 > pivot])` (choice 0.00, noul 0.13); L7 `greater = quicksort([x for x in arr[1:] if x > pivot - 1])` (choice 0.00, noul 0.14)
- `rpn_eval`: L9 `}[symbol](b, a)` (choice 0.12, noul 0.64); *L20 `op(token, b, a)` (choice 0.81, noul 0.81)



## 1. The algorithm

One outer-loop step = one call of `synthesize(ctx)` = one `Proposal`. The synthesizer keeps a `SearchState`
per `runId` (in memory, mirrored as text in the `PlanDraft` it returns, §4). Pseudo-code; every Jev question
is named `Q_*`, its type, option construction and consumption are in Table 1.1.

```
synthesize(ctx):
  S = state(ctx.runId) ?? init(ctx)                      # §4: rebuilt from ctx.plan on --resume

  # ---------- Phase 0: baseline (code) ----------
  if S.baseline is null:
      S.baseline = runTests(F2P ∪ P2P)                    # code: TestRunSummary; F = failing ids, P = passing ids
      if F = ∅: return Proposal(done, "all tests pass at baseline")
      S.attack = |F| = 1 ? F[0] : Q_next_test(F)          # Jev, 1 request, only when |F| ≥ 2

  # ---------- Phase 1: localise (Jev + coverage) ----------
  if S.sites is empty:
      if workspace has > 1 candidate file:
          files  = Q_file(paths of every source file, ≤ 250 per request, concurrent)      → top-5 by p
          files  = Q_file_confirm(files, with symbol outlines)                             → re-ranked top-5
          fns    = ∪_file Q_function(file)                                                 → top-5 by p_file·p_fn
      else: fns = [the one file's functions] (no Jev)
      anchors = ∪_fn Q_line(fn, failing test + actual output)                              → top-3 lines per fn (p ≥ 0.05)
      sbfl    = Ochiai over per-test line coverage of the baseline run (code, sys.settrace) → top-3 lines
      S.sites = order(anchors ∪ sbfl, by p_jev + 0.5·ochiai)  plus gap sites before/after each anchor
      S.cursor = 0

  # ---------- Phase 2: enumerate (code) ----------
  K = sites per round (3 on single-file workspaces, 5 on repos)
  sites = S.sites[S.cursor .. S.cursor + K)
  cands = dedupe( ∪_site mutation(site) ∪ template(site) ∪ donor≤1sub(site) ∪ insert_statements(gap sites) )
  cands = compile_filter(cands) − S.tested                # never test a line twice in a run

  # ---------- Phase 3: sieve (tests; Jev only to ORDER when the queue exceeds the run budget) ----------
  t_run   = measured duration of the F2P-only run at baseline (code)
  budget  = floor(step_seconds × parallelism / t_run)     # §3: QuixBugs ≈ 400–1,500 runs, SWE-bench ≈ 30–60
  if |cands| > budget:
      order = Q_rank(cands, site)  (compact Nouls, ≤ 254 per request, concurrent)   # ordering only
      cands = cands sorted by order, then by source prior
  results = run_parallel(cands[:budget], tests = F2P only, timeout = adaptive(t_run))     # §3.2: per-test clamp(3·baseline, 0.5 s, 2 s) on QuixBugs
  S.tested ∪= cands[:budget]
  pass_f2p  = {c : all F2P pass}
  partial   = {c : strictly more F2P pass than baseline and no F2P regression}      # code, counts + ids
  plausible = {c ∈ pass_f2p : P2P pass}   (P2P run on pass_f2p in order, stop after 5 passes)

  # ---------- Phase 4: decide (code; Jev only among ≥ 2 plausible) ----------
  if |plausible| = 1: return Proposal(patch(plausible[0]), plan: verified-by-tests)
  if |plausible| ≥ 2:
      clusters = behaviour_cluster(plausible, perturbed inputs)            # code, §3.4; usually 1–3 clusters
      if |clusters| = 1: return Proposal(patch(min_edit(clusters[0])))
      best = Q_arbitrate(cluster representatives) with paired Q_general Nouls    # Jev, 1 request
      S.fallbacks = the other representatives (proposed on later steps if the judge rejects)
      return Proposal(patch(best))
  if plausible = ∅ and partial ≠ ∅:
      S.partials ∪= top-5 partial by tests-passed, no commitment to a new base   # §4: beam of bases, not greedy
      if two partials from different sites fix disjoint F2P subsets: test their pairs (≤ 10 runs) → plausible? → patch
  if S.cursor + K < |S.sites|: S.cursor += K; return synthesize(ctx)   # widen to the next K sites, same step
  if not S.widened:
      S.widened = true; S.sites = every code line of the located function(s) (brute force), S.cursor = 0
      return synthesize(ctx)                                             # §0 says this is seconds on QuixBugs
  if not S.deep:  S.deep = true; add second-order mutants + token beam at the top-3 anchors; return synthesize(ctx)
  return Proposal(done, summary: "no candidate passes F2P; best partial …", openProblems: [...])   # §4: honest stop
```

The recursion inside one step is bounded by the step's wall budget (`ctx.limits.commandTimeoutMs`); when the
budget is hit mid-phase the synthesizer returns the best `run`/`patch` it has (a `run` of the test command if
nothing else, which costs one outer step and refreshes the judge's evidence).

### Table 1.1 — every Jev question, its type, option set and how code consumes the answer

| Name | Type | State (what Jev sees) | Options (code-built) | Consumed as | Measured basis |
| --- | --- | --- | --- | --- | --- |
| `Q_next_test` | Choice | `{task, failing_tests: {failing_<id>: {call, expected, actual, status}}}`, ≤ 10 failing tests, values bounded | one key per failing test (description = call + expected vs actual) + `none_of_these` | argmax = the test whose failure text goes into `Q_line`'s state and whose F2P id is the "attacked" test; escape → smallest input (code tiebreak) | neutral wording top-1 = simplest 16/34 vs 8/34 random, MRR 0.67; picks the smallest *informative* case (`probe-progress-judgment.md` Part 3, design 5) |
| `Q_file` | Noul × ≤ 250 per request | `{issue: {repository, problem_statement}, criteria: {yes_when, no_when}, files: [paths]}` | one Noul per path, `contextNoul` ("Must the file `<path>` be modified to fix `issue`? Apply `criteria`.") | **by rank, never threshold**: top-5 files | gold #1 23/30, ≤ 5 28/30, ≤ 10 30/30 over 61–778 files, $0.0011/instance (`probe-swebench-understanding.md` Q6; verification: consume by rank) |
| `Q_file_confirm` | Noul × ≤ 10 | same plus `files[path].top_level_symbols` (≤ 40) | one Noul per beam file | re-rank the beam; top-5 kept | outlines lift gold-first 28/33 → 31/33 in the package setting (Q3) |
| `Q_function` | Choice | `{issue, file: {path, functions: {key: "method X.y, line N: def …"}, module_level_code_outside_any_function}}` | one key per def (nested classes flattened) + module-level + `none_of_these` | top-5 by p_file·p_fn across the file beam; escape mass ≥ 0.5 → module-level site added | top-1 51 %, top-5 95 % (Q2); escape absorbs mass on module-level truths |
| `Q_line` | Choice | `{task, program: {L<n>: text} (function listing), tests: [≤3 with input, expected], failing_test_run: {input, expected, actual}}` | `line_<n>` with the line text as description + `none_of_these` ("the fix needs a new line") | top-3 lines with p ≥ 0.05 become replace sites; escape ≥ 0.3 or top p < 0.3 → gap sites around the top-2 lines are added | variant D: top-1 28/40, top-3 36/40, MRR 0.805; union with SBFL/Noul top-3 covers 38/40 (`probe-localization.md` §1, §8.2); trust p ≥ 0.9 (92 %), distrust 0.7–0.9 (62 %) |
| `Q_gap` | Choice | `Q_line` state | `after_l<i>` for every line of the function + `before_l1` + `none_of_these` | top-3 gaps become insert sites (statement templates enumerated there) | 4/4 when the statement is known, 2/4 when not (`probe-donor-and-templates.md` §4): so gaps are a *site list*, never a single pick |
| `Q_rank` (ordering only, when \|cands\| > run budget) | Noul × ≤ 254 per request, compact | `{task, program, buggy_line, buggy_line_number, tests (failing first, with actual), correct_fix_criteria, candidates: {cand_xx: text}}` | one compact Noul per candidate; unchanged line excluded; duplicates folded | sort the run queue by p; **nothing is dropped**; the budget cut decides how many run this step, the rest carry to the next | compact Nouls top-1 32/40, top-3 36/40 at N = 254, $0.00077, 331 ms (`probe-selection.md`); never a gate because 20 % of the misses are confident (0.77 on a wrong line, `lit-search-based-repair.md` §7) |
| `Q_arbitrate` | Choice | `{task, program, tests, buggy_program_failure: {input, expected, actual}, candidates: {cand_xx: {line, replaces, with}}}` (only test-passing candidates, one representative per behaviour cluster, ≤ 20) | `cand_xx` with `L<n>: text` as description + `none_of_these` | argmax proposed as the patch; runner-up kept as fallback; escape argmax → propose min-edit and flag `openProblems: "tests may not pin the fix"` | §0 Table 0.3 (this file); REPORT §9: ranking AUROC ≈ 1.0 where 0.5 cuts are wrong |
| `Q_general_<cand>` (paired with `Q_arbitrate`) | Noul × ≤ 20, criteria def + examples | same request | one per arbitrated candidate ("correct for every valid input, not just `tests`") | if the argmax's Noul < 0.3 and another candidate's ≥ 0.7, override (Choice resolution as in DESIGN §6); otherwise informational | REPORT §10: Choice relative, Noul absolute; pairing rule DESIGN §5.4 rule 3 |

Nine question families (eight plus the paired Nouls); a QuixBugs step asks **one or two** of them (`Q_line`; `Q_arbitrate` on the programs with
≥ 2 plausible patches, §0). What is *not* asked, on purpose: progress Nouls (a pure function of code-computed
counts, `probe-progress-judgment.md` design 3), fix-kind classification (53–62 %, `probe-donor-and-templates.md`
§3, `probe-swebench-understanding.md` Q1), "is the fix in this set" (the tests answer it exactly), next-move
Choice (routed in code), and per-slot token Choices for whole-line synthesis except in the `deep` phase.

## 2. Candidate sources and their order

All sources are code, deterministic, compile-filtered, deduplicated across sites, with the unchanged line
removed. Order matters only when the run budget is smaller than the set (SWE-bench) or when several plausible
patches tie in the behaviour cluster (min-edit wins).

| # | Source | Where | What it reaches | Why this position |
| --- | --- | --- | --- | --- |
| 1 | First-order mutation of the site line (the prototype's 15 operator families ∪ `src/synth/mutate` table: relational/arithmetic/boolean swaps, off-by-one on literals and atoms, index and slice edits, argument/operand swap, constant ↔ identifier, identifier/attribute substitution from scope, `max`/`min`/`abs` wraps, guard conjunct/disjunct, return tweaks, call unwrap, `a.update(b)` ↔ `a = b`, `qualify_name`) | replace sites | 35/36 QuixBugs replacements at cap 200 (`prototype-baseline.md` Coverage); 38/40 with `probe-select/mutators.ts`; 33/78 modified SWE-bench lines at depth 1 (`coverage-study.md`, 19 of them by `qualify_name`) | Jaccard(fix, buggy) ≥ 0.5 for 33/36 QuixBugs fixes (`probe-donor-and-templates.md` §5): the buggy line is the best donor |
| 2 | Statement templates at gap sites: `x.append(y)`, `x.add(y)`, `x = y`, `return x`, `x += 1`, `if C: return/continue/raise`, over in-scope names and test literals | insert sites | 4/4 QuixBugs insertions (`probe-selection.md` operator library; `coverage-study.md` `insert_method_call_scope`, `insert_assign_scope`); guard insertion fires on 3 SWE-bench hunks | insertions are 10 % of QuixBugs and ~30 % of real patches (Sobreira, `lit-search-based-repair.md` §2); cheap (tens per gap) |
| 3 | Fix templates at replace sites (`src/synth/templates`: guard extension, add parameter with default, add keyword argument, missing import from a verbatim donor, call-target/attribute change, branch clone) | both | 10/40 QuixBugs hunks, 16/106 SWE-bench hunks (`coverage-study.md` templates table) | the SStuB/TBar patterns that mutation does not express |
| 4 | Donor lines with ≤ 1 identifier substitution (shape index over the workspace; same function → same file → repo) | both | 9/40 QuixBugs, 32/106 SWE-bench hunks; ≤ 2 subs 51/106 (`coverage-study.md`) | the plastic-surgery source is the main SWE-bench source; ≤ 1 sub keeps the set ≤ a few hundred |
| 5 | Pairs of partials (two candidates from different sites that each fix disjoint F2P subsets) | cross-site | the three genuine two-line QuixBugs repairs the prototype found in round 2 (`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`) | replaces the greedy "adopt the partial as the new base" that lost `kth`, `sqrt`, `topological_ordering` |
| 6 | `deep` phase only: second-order mutants at the top-3 anchors (cap 400 per site), donor ≤ 2 subs, and the grammar-filtered token beam W = 3 (`src/synth/beam`) | top-3 anchors | `mergesort` and `shortest_paths` (second order); 20/40 lines for the beam alone, 27–28/40 as a portfolio (`probe-token-synthesis.md`) | 31 requests and $0.0037 per line: worth it only after everything cheap has been *tested*, not merely ranked |

Vocabulary pre-check (code, $0): a candidate whose tokens are not in file ∪ tests ∪ issue-text vocabulary
is impossible for sources 1–5 (`coverage-study.md` design 6: 100 % of QuixBugs and 72 % of SWE-bench fixed
lines pass it); the pre-check decides when to enter `deep` without a Jev call.

## 3. Verification strategy

### 3.1 What one "test run" is

- **QuixBugs / single-file workspaces**: the candidate program is written to a scratch file under the
  workspace (`.jevcode-synth/c<i>/<name>.py`, inside the sandbox's writable root) and `run_tests.py <name>
  <path> --timeout T --jobs 2` is executed. F2P and P2P are the same JSON suite; one run is both.
- **pytest repos (SWE-bench)**: two-tier. *F2P tier*: apply the candidate to the source file, run
  `pytest -x -q <F2P node ids>` (1–3 tests in 27 of the 30 checked-in instances: `bench/data/swebench-verified-30.json`
  `fail_to_pass` lengths are 1 for 22, 2–3 for 5, 10 and 21 for two), revert. *P2P tier*: only for candidates
  that pass F2P, run the instance's `pass_to_pass` set (5–282 tests; the django ones need `runtests.py`
  with the module label), stop after the fifth survivor.

### 3.2 How many runs per step, parallelism, timeouts

| Setting | QuixBugs (measured §0) | SWE-bench (estimated from `bench/` evaluator and the F2P counts) |
| --- | --- | --- |
| run duration `t_run` | 87–395 ms p50 on non-looping lines; 2–6 s on lines whose mutants loop at a 2 s per-test timeout | 3–20 s for an F2P-only pytest invocation on an installed venv; 30–120 s for a django module; P2P 30 s–5 min |
| parallelism | 8 candidates × 2 runner jobs (15 cores here; the runner itself parallelises per test) | 4 worktree copies (`git worktree add` inside the workspace, one candidate each) or sequential apply/revert |
| per-test timeout | `clamp(3 × baseline per-test duration, 0.5 s, 2 s)`; §0 Table 0.2 shows the 0.5 s setting keeps the gold passing on every program while cutting the timeout-dominated programs' cost | `clamp(3 × baseline F2P duration, 10 s, 120 s)` |
| runs per step (budget) | all candidates of the K = 3 sites (median ≈ 400) in one step; the brute-force `widened` phase (every line) is a second step | 30–60 F2P runs per step (≈ 5–10 min), P2P on ≤ 5 |
| runs to verify before proposing | none beyond the sieve: the proposal *is* a test-passing patch | same; the outer loop's next step re-runs the test command so the judge sees it (§4) |

### 3.3 Why tests and not Jev at N ≤ budget

At QuixBugs scale, ranking cost ≈ verification cost: one `Q_rank` request over 137 candidates is 253–331 ms
and $0.0003–0.0008 (`probe-selection.md`), and then the design still needs test runs; running all 137 at
8-way parallelism is 120 × 0.22 s / 8 ≈ 3.3 s plus process overhead (§0: median 3.8 s per program). The ranked design saves ≈ 4 s and pays for
it with a 20–35 % top-1 miss rate that turns into extra rounds and, in the prototype, into the greedy trap.
On SWE-bench the arithmetic flips (1,641 mutants per line × 10 s ≫ any step), so there `Q_rank` orders the
queue; the cut is a *budget*, not a probability threshold, so a confident wrong rank costs a step, not the fix.

### 3.4 The overfitting guard (behaviour clustering + `Q_arbitrate`)

Plausible candidates are run on perturbed inputs generated in code from the existing tests (for JSON tests:
permute list elements, ±1 on integer arguments, empty and singleton lists, swap two arguments; for pytest:
none, cluster on the P2P outcome vector only). Candidates with identical outputs on every perturbed input
form one cluster (they are equivalent as far as the loop can tell; the min-edit member is proposed). Only when
≥ 2 clusters disagree is Jev asked `Q_arbitrate` with the disagreeing representatives in the state, plus the
buggy program's actual failure so it can judge *cause*, not just *effect*. §0 Tables 0.3 and 0.4 are the direct
measurement of that question on the plausible sets exhaustive verification produced (10/10 and 13/14
gold-or-equivalent; the one all-overfit set rejected by the escape at 0.90).

## 4. Plugging into the outer loop

- **One step** is one `synthesize(ctx)` call returning one `Proposal`. Kinds returned: `patch` (unified
  diff of the chosen candidate, the normal case), `run` (the workspace test command, so the outer judge gets
  a parsed test run and `workspace.testsCurrent` becomes true after a patch; proposed on the step after a
  `patch`, or when a step's budget ran out mid-sieve), `done` (baseline all-pass, or the honest give-up).
  `read`, `edit`, `write` are never proposed: the synthesizer reads through `ctx.workspace.read` and edits
  through `patch` only, so the risk stage sees whole diffs.
- **Plan and progress.** `PlanDraft.remaining` holds one line per failing test still failing (`fix failing
  test <id>`), `done` holds `test <id> passes after patch to <path>:<line>` claims only after a test run
  showed it (the judge's `done_<j>` Noul then verifies them against `executed.output`), and `openProblems`
  carries the synthesizer's serialised search state in a fixed grammar:
  `synth: sites=L5,L9,L12 tested=412 plausible=1 partial=3 phase=sieve cursor=3 widened=0 deep=0`.
  On `--resume` (no in-memory state) `init(ctx)` parses that line back; enumeration is deterministic, so the
  tested set is reconstructed by re-enumerating the recorded sites (no test is re-run: `S.tested` is rebuilt
  as the set of candidates of those sites). Progress is code: `Progress` deltas from
  `src/synth/verify/progress.ts`, never a Jev question.
- **Loops and stuck.** The synthesizer never proposes the same diff twice in a run (the tested set), so the
  outer `patch:<sha12>` signature cannot trip on it; the `done:` signature trips after three identical give-up
  summaries, which routes to the outer replan stage, and `ctx.directive` (`change_approach` /
  `gather_context` / `revert_changes` / `stop_and_report`) is consumed as: `change_approach` → enter `widened`
  or `deep`; `gather_context` → re-run localisation with the latest failure text and a wider file beam (top-10);
  `revert_changes` → propose a reverting `patch` of the last applied candidate (the outer loop's risk stage
  scores it); `stop_and_report` → `done` with the partial summary. Stuck inside a step is impossible by
  construction: every phase either consumes budget (test runs) or advances `cursor`/`widened`/`deep`.
- **Done** means: the outer loop's judge computed `tests.allPassed` in code from an executed `run` of the
  detected test command after the last patch (`DESIGN.md` §5.5 judge; `testsCurrent` true), and the
  completion Noul `task_complete` fires on that evidence. The synthesizer never returns `done` on its own
  test results alone except at baseline; it returns `run` so the evidence is the harness's own.
- **Risk stage.** Patches are the only writes; they touch the located file(s) inside the workspace
  (`destructive` level 1 at most, recoverable via git); the give-up `done` with `plan.remaining` non-empty is
  expected to be blocked at `plan_mismatch` level 3, which is the correct outcome (a blocked finish is not a
  finish).

## 5. Cost and latency budget per step (derived)

| Component | QuixBugs step | SWE-bench step | Source of the number |
| --- | --- | --- | --- |
| `Q_next_test` | 0–1 request, ~$0.00005, 190 ms | same | `probe-progress-judgment.md` Part 3 (34 programs, $0.0668 for 994 requests) |
| Localisation | 1 `Q_line` request, ~1,050–1,200 tokens, $0.00005, 176–227 ms | 3–4 `Q_file` batches + 1 confirm + ≤ 5 `Q_function` + ≤ 5 `Q_line` ≈ 6–11 requests, ≈ 47–53k tokens, ≈ $0.0025, ~2 s at 5-way concurrency | `probe-localization.md` §7; `probe-swebench-understanding.md` design 8 (verified range) |
| `Q_rank` (only if \|cands\| > budget) | not asked (budget ≥ set) | 1–7 compact-Noul requests of ≤ 254, $0.00077 each, 331 ms p50 | `probe-selection.md` compact row, N = 254 |
| Test runs | median 3.8 s wall for the whole true-line set at 8-way parallelism (§0 Table 0.1); ≈ 12 s for 3 sites; brute force over every line (the `widened` phase): median 24 s, max 119 s per program at 12-way with a 0.5 s per-test timeout (§0 Table 0.2) | 30–60 F2P runs × 3–20 s / 4 ≈ 1–5 min; P2P ≤ 5 × 0.5–5 min | §0; `bench/data/swebench-verified-30.json` F2P/P2P counts |
| `Q_arbitrate` + paired Nouls | 0–1 request, ~$0.0001, ~200 ms; needed on the §0 Table 0.1 "≥ 2 plausible" programs only | same | §0 Table 0.3 |
| **Total Jev per step** | **1–3 requests, ≈ $0.0001–0.0003, < 1 s** | **≈ 10–20 requests, ≈ $0.005–0.01, ≈ 3–5 s** | sums of the rows |
| **Total wall per step** | **≈ 5–20 s, tests dominate** | **≈ 2–10 min, tests dominate** | |
| Whole QuixBugs benchmark (40 programs) | ≈ 40 × 1–2 requests ≈ $0.005 Jev; ≈ 4.5 min wall for the true-line sets (§0 Table 0.1: 260 s) rising to ≈ 20 min if every program needed the `widened` phase (Table 0.2: 1,181 s) | | vs prototype $0.035 / 62 s at 3 programs in flight (`prototype-baseline.md`) |

The trade is explicit: the contrarian design spends **≈ 3× the prototype's test CPU** and **≈ 0.3× its Jev
spend** per QuixBugs program, and removes the two failure classes (`ranking_missed`, greedy trap) that the
prototype's rationing created. Jev is ≈ 240 ms per request whatever the design; the only latency lever that
matters is test parallelism.

## 6. Predictions, each with the measurement it rests on

### QuixBugs (40 programs, tests as the only oracle)

| Stage | Reach | Rests on |
| --- | --- | --- |
| Coverage of the candidate sources at the true site | 35/36 replacements first-order (cap 200) + 4/4 insertions by statement templates = 39/40; `shortest_paths` needs second order (`deep`) → 40/40 | `prototype-baseline.md` Coverage; `probe-selection.md` operator library 38/40 + second order 40/40; `coverage-study.md` union 40/40 |
| The gold candidate passes every test when run | §0 Table 0.1 `gold PASS` column: 35/36 replacements (the 36th needs second order); the gold is never rejected by the runner | §0 |
| Localisation puts the true site among the K = 3 first sites | 36/40 (D top-3) → 38/40 with the SBFL/Noul union; the remaining 2 (`lis`, `mergesort`: true line rank 4–6, p ≤ 0.03) are reached by the `widened` brute-force phase at the cost of one more step (§0 Table 0.2: every-line cost) | `probe-localization.md` §1, §8.2; `prototype-baseline.md` failure taxonomy |
| Programs with exactly one plausible candidate (no Jev decision at all after localisation) | 25/36 replacements; ≥ 2 plausible on 10, all at the true line, 2–5 each | §0 Table 0.1 |
| Programs needing `Q_arbitrate`, and its accuracy | at the true line: 10 programs, Choice 8/10 = gold, 10/10 gold-or-equivalent ($0.0008); after the brute-force `widened` phase: 14 programs, 10/14 gold, 13/14 gold-or-equivalent, 1 wrong-line pick; the one all-overfit set rejected by the escape (0.90) | §0 Tables 0.3 and 0.4 |
| **Predicted repaired (tests pass)** | **37–39/40** | coverage 39–40 × localisation-with-widening ≈ 40 × gold-passes ≈ 1.0, minus budget stops |
| **Predicted correct by inspection** | **35–38/40** | 21–25 programs never reach a Jev decision (gold is the only passing candidate, Tables 0.1–0.2); on the rest `Q_arbitrate` is 10/10 and 13/14 gold-or-equivalent (Tables 0.3–0.4) and the escape rejected the one all-overfit set; the residual is `detect_cycle`-style wrong-line ties (1/40 measured) and the `deep`-phase programs (`shortest_paths`, the 4 insertions) where coverage, not judgment, decides |

Against the field: prototype 32/40 (31 correct), Codex zero-shot 21–23, AlphaRepair 27, ChatGPT-with-hints 31
(`lit-search-based-repair.md` §5). The contrarian design's gain over the prototype comes from *not*
rationing test runs (the 2 `ranking_missed` and the greedy-trap programs) and from `widened` (the 2
`localisation_missed`), not from any better Jev question.

### SWE-bench Verified (the 30 checked-in instances)

| Stage | Reach | Rests on |
| --- | --- | --- |
| File beam contains a gold file | 28/30 top-5 | `probe-swebench-understanding.md` Q6 |
| Function beam and line window contain the fix | 21/30 chained (file #1, fn ≤ 5, line ≤ 5 within ±3) | Q2/Q4 chained view (oracle-chained upper bound) |
| Every gold hunk reachable by sources 1–4 | 6/30 strict, 9/30 with ≤ 2-sub donors; 15/30 vocabulary ceiling | `coverage-study.md` headline |
| F2P run affordable | 27/30 instances have 1–3 F2P tests | `bench/data/swebench-verified-30.json` |
| **Predicted F2P ∧ P2P passing with the local evaluator** | **2–4/30** (the single-hunk, in-vocabulary instances the chained localisation reaches: `django-15572`, `pylint-4970`, `requests-2931`, `requests-1142`, `pytest-10051`, `django-15315` are the candidates) | intersection of the rows above; a patch that passes F2P and P2P without reproducing every gold hunk counts (the coverage numbers are bounds on reproducing gold, `coverage-study.md` verification) |
| Honest failure classes | symptom-vs-cause file misses (3), multi-hunk (19 of 30 patches have ≥ 2 code hunks), new names not in vocabulary (15/30) | `probe-swebench-understanding.md` failure taxonomy; `coverage-study.md` design 5 |

Anything above ~30 % on this slice needs a generation source; this design does not claim it.

## 7. Modules for implementation (under `src/synth/`)

Existing modules are reused unchanged where they already implement the measured pieces; the sieve is new.

| Path | Status | Role |
| --- | --- | --- |
| `py/` (tokenize, structure, edits, similarity) | exists | Python-faithful tokenizer, scope, line edits, unified diff |
| `mutate/` | exists | source 1 (operator table, context, priors) |
| `templates/` | exists | sources 2–3 |
| `donor/` | exists | source 4 (shape index, ≤ 1–2 substitutions); its Jev hole questions are **not** used by this design (enumeration + tests replace them) |
| `beam/` | exists | source 6 (`deep` phase only) |
| `localize/` | exists | `Q_file`, `Q_file_confirm`, `Q_function`, `Q_line`, site windows; add `Q_gap` (gap Choice) in `localize/questions.ts` |
| `sbfl/` | exists | Ochiai from per-test coverage, unioned into the site order |
| `verify/` | exists | runner parsing (`quixbugs.ts`, `pytest.ts`), `progress()` and `route()` in code, `pickNextFailingTest` (`Q_next_test`) |
| `rank/` | exists | `Q_rank` compact Nouls; used only in ordering mode (the `fixProbablyAbsent` signal is ignored; tests decide absence) |
| `sieve/budget.ts` | new | measures `t_run`, computes the run budget from `ctx.limits`, adaptive per-test timeout |
| `sieve/queue.ts` | new | cross-site candidate queue: dedupe by normalised text, unchanged-line removal, vocabulary pre-check, source-prior ordering, optional `Q_rank` ordering, `tested` set |
| `sieve/parallel.ts` | new | batch runner: writes candidate files or worktrees under `.jevcode-synth/`, one sandbox command (`xargs -P`) per batch, per-candidate JSON results, kill on step deadline |
| `sieve/cluster.ts` | new | perturbed-input generation from the tests (code), behaviour clustering of plausible candidates, min-edit representative |
| `sieve/arbitrate.ts` | new | `Q_arbitrate` + paired `Q_general_*` and the Choice-resolution rule |
| `sieve/combine.ts` | new | pairing of partials across sites (disjoint F2P subsets), ≤ 10 pair runs |
| `sieve/state.ts` | new | `SearchState`, serialisation to/from the `openProblems` grammar, resume |
| `sieve/synthesizer.ts` | new | the `Synthesizer` (phases 0–4, step budget, proposal kinds, directive handling) |
| `index.ts` | replace placeholder | `createSynthesizer` returns the sieve synthesizer |
| `test/unit/synth/sieve/*` | new | offline tests with mocked `ask`/sandbox: budget arithmetic, queue dedupe, state round-trip, clustering, pairing; `test/live/synth-sieve.live.test.ts` on 3 QuixBugs programs |

## 8. The three biggest risks and the experiment that retires each

1. **Test cost on real repositories makes the sieve a ranked search after all.** On SWE-bench the queue is
   1,641 mutants per line (median, `coverage-study.md`) and an F2P run is seconds to minutes, so the design
   degrades to "Jev orders, run the top 30–60 per step", which is the design it criticises, plus a slower
   oracle. *Experiment*: for the 30 instances, at `base_commit` in the bench's local venv evaluator, time one
   F2P-only invocation and one P2P invocation (60 runs, $0); then, using the gold-reachable lines from
   `coverage-study.json` as the target, measure how often `Q_rank`'s compact-Noul order puts a *test-passing*
   candidate inside the first 30/60 of the queue at the true site (Jev ≈ $0.05). If the 60-cut hit rate is
   below the chained-localisation reach (21/30), the SWE-bench branch of this design has no advantage and
   should adopt the two-stage ranker as the primary instead of the ordering-only role.
2. **Exhaustive verification manufactures overfitting.** Long & Rinard: plausible-but-incorrect patches are
   orders of magnitude more abundant than correct ones; the sieve surfaces every one of them, and its guard
   (`cluster` + `Q_arbitrate`) is measured only in §0 Table 0.3 on QuixBugs-sized suites. *Experiment*: hold
   out half of each QuixBugs JSON suite (and the two `slow` cases) as hidden tests, run the sieve on the
   visible half, and count (a) plausible candidates on the visible half that fail the hidden half, (b) how
   often the behaviour-clustering + `Q_arbitrate` pick is the one that passes the hidden half; compare with the
   min-edit baseline and with "propose all, let the judge sort it out" (n = 31 JSON programs, ≈ $0.02 Jev).
   Retired if the guard's hidden-pass rate is ≥ the min-edit baseline + 10 points; otherwise the design
   needs generated tests (EvoSuite-style differential inputs) before proposing, not Jev.
3. **Multi-hunk repair via pairing of partials does not scale past two hunks.** Sources 1–5 fix one line (or
   two disjoint lines) per proposal; 19/30 SWE-bench patches have ≥ 2 code hunks and the pairing rule has
   never been run. *Experiment*: the ladder rung-2 tasks (`examples/demo-py` and hand-made two- and
   three-hunk QuixBugs variants: inject a second independent one-line bug into 10 programs) run end to end
   with the pairing rule on and off; measure solved, pair runs spent, and whether the prototype's greedy trap
   reappears in another form (a partial pair that passes strictly more tests but not all). If three-hunk tasks
   need more than ~50 pair runs, the outer loop must decompose per failing test *before* the sieve (one
   `Q_next_test` → one site set → one patch per step) rather than combine inside a step.

## 9. What this means for the design (summary)

- Ranking candidates is the wrong job for Jev at any N the tests can cover; on QuixBugs that is every N (§0).
- Jev's measurable, hard-to-replace value is localisation (text → file/function/line), arbitration among a
  handful of test-passing patches (§0 Table 0.3), and ordering the queue when tests are expensive.
- Budget test runs by *cost*, not by count: adaptive timeouts and parallelism make "run everything at the
  top-3 sites" a 10–20 s step; brute force over every line is a second step, and removes the localisation
  failure class outright on small files.
- Never commit to a partial; keep a beam of bases and pair partials across sites.
- Done is decided by the harness's own executed test run, never by the synthesizer's verdict.
