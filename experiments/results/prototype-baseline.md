# Prototype baseline: Jev-only repair loop on QuixBugs Python (2026-09-20)

Scripts: `experiments/prototype/` (README there has the rerun commands). Model
`typesafe/jev-1.13-20260917` via OpenRouter, pinned. Data: the checked-in QuixBugs copy in
`bench/data/quixbugs/` (40 Python programs, 31 with JSON tests, 9 graph programs with assert-based
test modules). **No generating LLM anywhere**: candidates come from code, Jev only chooses, tests
decide. Every number below is from one run of `loop.mts` with the default budgets.

## Method (what one program goes through)

1. **Baseline test run** of the buggy program (`run_tests.py`, 2 s per test, upstream `slow`
   cases skipped as in QuixBugs' own pytest suite). Its first failure becomes `actual_output`.
2. **Localise**: one Choice over all non-blank, non-comment lines ("which single line contains
   the bug"), state = task + numbered program + 3 tests (failing one included) + actual output.
   Take the top-3 lines by probability (later top-5).
3. **Enumerate**: for each line, `mutations.mts` produces ≤ 200 single-operator edits of that
   line (relational/arithmetic/boolean/bitwise swaps, off-by-one on literals and on every
   nested operand, index flips, argument/operand/index-part swaps, constant substitution from
   program and test literals, identifier and attribute substitution from the enclosing function,
   identifier swaps, `return <other>` / `return <id> == 0` templates, `max/min` clamps, guard
   clauses `C or x is None` / `C or not x`, `while True:` → `while x:`, iterable slices, call
   stripping, method-call → assignment, boundary `== 0` → `<= 1`), deduplicated and filtered
   through Python's `compile()`.
4. **Rank**: one Choice per line over its candidates plus `none_of_these` (three requests in
   parallel). Candidates from all ranked lines are merged into one queue by probability.
5. **Verify**: the top k = 5 are run against all tests; then lines 4–5 are ranked, merged, and
   verification continues by probability until a budget runs out. A candidate that passes every
   test = repaired. A candidate that passes *strictly more* tests than the current base (computed in
   code, never asked of Jev) becomes the new base and the loop restarts at step 2 (max 3 rounds).
6. **Budgets** per program: 40 test runs, 30 Jev requests, 180 s wall.

**Coverage** (measurement only, Jev never sees the correct program): is the reference fix line
in the candidate set enumerated for the true line? Four bugs (`depth_first_search`,
`reverse_linked_list`, `shunting_yard`, `wrap`) are fixed upstream by *inserting* a statement;
no line replacement can reach them, so they are structurally unreachable for this loop and are
reported as `fix_not_in_candidates`.

**Failure categories** (assigned in code from the ground truth): `fix_not_in_candidates`
(reference fix not enumerable at the true line, incl. the 4 insertions), `localisation_missed`
(fix enumerable but the true line was never among the ranked lines), `ranking_missed` (true line
ranked and fix in its set, but the budget ran out before the fix was verified), `runner_issue`
(the reference fix was verified and did not pass, or the harness broke).

<!-- generated:start -->
### Per-program results

| program | tests | repaired | round | win rank (global / in line) | true line loc rank (p) | fix in cands (enum pos) | fix Jev rank in line (p) | cands ranked | test runs | Jev req | cost | wall | failure / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | json 9 | **Y** | 1 | 1 / 1 | 1 (0.47) | Y (1/33) | 1 (0.96) | 72 | 2 | 4 | $0.0002 | 7 s |  |
| breadth_first_search | pytest 5 | **Y** | 1 | 1 / 1 | 1 (0.68) | Y (15/137) | 1 (0.97) | 321 | 2 | 4 | $0.0006 | 1 s |  |
| bucketsort | json 7 | **Y** | 1 | 1 / 1 | 1 (0.90) | Y (79/96) | 1 (0.36) | 308 | 2 | 4 | $0.0006 | 1 s |  |
| depth_first_search | pytest 5 | **Y** | 1 | 3 / 1 (alt fix) | 10 (0.00) | n/a (insert) | - | 206 | 4 | 3 | $0.0005 | 1 s |  |
| detect_cycle | pytest 6 | **Y** | 1 | 1 / 1 | 2 (0.07) | Y (26/59) | 1 (0.66) | 162 | 2 | 4 | $0.0004 | 1 s |  |
| find_first_in_sorted | json 7 | **Y** | 2 | 1 / 1 (alt fix) | 1 (0.87) | Y (1/115) | 1 (0.76) | 611 | 3 | 8 | $0.0016 | 5 s | r1: progress 4->5 via L3 "hi = len(arr) - 1" |
| find_in_sorted | json 7 | **Y** | 1 | 1 / 1 | 1 (0.58) | Y (9/150) | 1 (0.91) | 408 | 2 | 4 | $0.0007 | 1 s |  |
| flatten | json 7 | **Y** | 1 | 1 / 1 | 1 (1.00) | Y (1/108) | 1 (0.99) | 153 | 2 | 4 | $0.0003 | 1 s |  |
| gcd | json 6 | **Y** | 1 | 1 / 1 | 1 (0.82) | Y (8/92) | 1 (0.86) | 205 | 2 | 4 | $0.0004 | 1 s |  |
| get_factors | json 11 | **Y** | 1 | 1 / 1 | 1 (0.54) | Y (75/78) | 1 (0.69) | 303 | 2 | 4 | $0.0005 | 1 s |  |
| hanoi | json 8 | **Y** | 1 | 1 / 1 | 1 (0.90) | Y (42/69) | 1 (0.88) | 331 | 2 | 4 | $0.0007 | 1 s |  |
| is_valid_parenthesization | json 3 | **Y** | 1 | 1 / 1 | 1 (0.86) | Y (27/62) | 1 (0.89) | 105 | 2 | 4 | $0.0003 | 1 s |  |
| kheapsort | json 4 | **Y** | 1 | 1 / 1 | 1 (0.43) | Y (10/44) | 1 (0.79) | 259 | 2 | 4 | $0.0005 | 1 s |  |
| knapsack | json 9 | **Y** | 1 | 1 / 1 | 1 (0.92) | Y (1/184) | 1 (0.99) | 534 | 2 | 4 | $0.0009 | 1 s |  |
| kth | json 7 | n | - | - | 1 (0.52) | Y (178/189) | 182 (0.00) | 986 | 40 | 10 | $0.0022 | 6 s | ranking_missed; stop=test_runs; r1: progress 3->5 via L12 "return kth(above, k - 1)" |
| lcs_length | json 9 | **Y** | 1 | 1 / 1 | 1 (0.64) | Y (34/200) | 1 (0.22) | 328 | 2 | 4 | $0.0006 | 1 s |  |
| levenshtein | json 6 | **Y** | 1 | 1 / 1 | 1 (0.76) | Y (34/149) | 1 (0.84) | 379 | 2 | 4 | $0.0007 | 3 s |  |
| lis | json 12 | n | - | - | 6 (0.02) | Y (39/140) | - | 1072 | 40 | 12 | $0.0029 | 8 s | localisation_missed; stop=test_runs; r1: progress 8->10 via L12 "if length == longest or val > arr[ends[length + 1]]:" |
| longest_common_subsequence | json 10 | **Y** | 1 | 2 / 1 | 3 (0.12) | Y (18/176) | 1 (0.32) | 271 | 3 | 4 | $0.0005 | 1 s |  |
| max_sublist_sum | json 6 | **Y** | 1 | 1 / 1 | 1 (0.38) | Y (16/86) | 1 (0.46) | 222 | 2 | 4 | $0.0004 | 1 s |  |
| mergesort | json 14 | n | - | - | 6 (0.03) | Y (12/177) | - | 582 | 40 | 6 | $0.0011 | 8 s | localisation_missed; stop=test_runs |
| minimum_spanning_tree | pytest 3 | **Y** | 2 | 1 / 1 (alt fix) | 2 (0.34) | Y (21/145) | 1 (0.13) | 742 | 3 | 8 | $0.0019 | 1 s | r1: progress 0->1 via L10 "group_by_node[v].update(group_by_node[u])" |
| next_palindrome | json 5 | **Y** | 1 | 1 / 1 | 1 (0.68) | Y (35/152) | 1 (0.22) | 355 | 2 | 4 | $0.0007 | 1 s |  |
| next_permutation | json 8 | **Y** | 1 | 1 / 1 (alt fix) | 1 (0.99) | Y (7/200) | 10 (0.00) | 335 | 2 | 4 | $0.0007 | 1 s |  |
| pascal | json 5 | **Y** | 1 | 1 / 1 | 1 (0.52) | Y (10/95) | 1 (0.85) | 390 | 2 | 4 | $0.0007 | 1 s |  |
| possible_change | json 10 | **Y** | 1 | 7 / 2 (alt fix) | 4 (0.01) | Y (35/95) | 3 (0.07) | 412 | 8 | 6 | $0.0008 | 2 s |  |
| powerset | json 5 | **Y** | 1 | 2 / 2 | 1 (0.70) | Y (35/155) | 2 (0.32) | 322 | 3 | 4 | $0.0006 | 1 s |  |
| quicksort | json 13 | **Y** | 1 | 1 / 1 (alt fix) | 1 (0.62) | Y (3/180) | 1 (0.77) | 510 | 2 | 4 | $0.0010 | 1 s |  |
| reverse_linked_list | pytest 3 | n | - | - | 4 (0.04) | n/a (insert) | - | 188 | 40 | 6 | $0.0005 | 12 s | fix_not_in_candidates; stop=test_runs |
| rpn_eval | json 6 | **Y** | 1 | 1 / 1 | 3 (0.23) | Y (3/83) | 1 (0.87) | 221 | 2 | 4 | $0.0004 | 1 s |  |
| shortest_path_length | pytest 4 | **Y** | 1 | 10 / 2 | 4 (0.11) | Y (179/200) | 2 (0.03) | 856 | 11 | 6 | $0.0017 | 2 s |  |
| shortest_path_lengths | pytest 4 | **Y** | 1 | 1 / 1 | 1 (0.96) | Y (9/200) | 1 (0.83) | 395 | 2 | 4 | $0.0009 | 1 s |  |
| shortest_paths | pytest 3 | n | - | - | 1 (0.75) | n (0/91) | not in set | 487 | 40 | 6 | $0.0011 | 4 s | fix_not_in_candidates; stop=test_runs |
| shunting_yard | json 6 | n | - | - | 16 (0.00) | n/a (insert) | - | 365 | 40 | 5 | $0.0008 | 5 s | fix_not_in_candidates; stop=test_runs |
| sieve | json 6 | **Y** | 2 | 1 / 1 (alt fix) | 1 (0.92) | Y (7/194) | 2 (0.19) | 513 | 3 | 8 | $0.0010 | 1 s | r1: progress 1->2 via L4 "if not any(n % p > 0 for p in primes):" |
| sqrt | json 7 | n | - | - | 1 (0.61) | Y (26/126) | 3 (0.15) | 663 | 40 | 14 | $0.0019 | 36 s | ranking_missed; stop=test_runs; r1: progress 1->2 via L4 "while abs(x - approx) < epsilon:"; r2: progress 2->3 via L4 "while abs(x - 1 - approx) < epsilon:" |
| subsequences | json 12 | **Y** | 1 | 6 / 1 | 4 (0.09) | Y (88/117) | 1 (0.51) | 634 | 7 | 6 | $0.0012 | 2 s |  |
| to_base | json 10 | **Y** | 1 | 1 / 1 | 1 (0.52) | Y (7/122) | 1 (0.96) | 226 | 2 | 4 | $0.0004 | 1 s |  |
| topological_ordering | pytest 3 | **Y** | 1 | 2 / 2 | 1 (0.80) | Y (31/163) | 2 (0.11) | 337 | 3 | 4 | $0.0009 | 1 s |  |
| wrap | json 5 | n | - | - | 3 (0.12) | n/a (insert) | - | 566 | 40 | 6 | $0.0015 | 5 s | fix_not_in_candidates; stop=test_runs |

### Totals

| Measurement | Result |
| --- | --- |
| Programs | 40 (31 JSON-tested, 9 pytest graph programs) |
| Repaired end to end (tests as the only oracle) | **32/40 = 80 %** |
| Repaired, by round | round 1: 29, round 2: 3 |
| Repaired with a line other than the reference fix (tests pass anyway) | 7 |
| Coverage: reference fix line in the candidate set of the true line (cap 200) | 35/36 replaceable = 97 %; 35/40 of all (4 need a line insertion) |
| Candidates at the true line, median (min–max) | 137 (33–200) |
| Localisation of the true line (Choice over lines, round 1): top-1 / top-3 / top-5 | 27 / 32 / 36 of 40 |
| Selection when the true line was ranked and the fix was in its set: fix at Jev rank 1 / ≤ 3 / ≤ 5 | 25 / 31 / 31 of 33 |
| Winning candidate global rank (repaired), median (max) | 1 (10) |
| Test runs per program, mean (max) | 10.3 (40) |
| Jev requests per program, mean (max) | 5.3 (14); total 210 |
| Cost per program, mean (max); total | $0.00088 ($0.00292); $0.0351 |
| Wall time per program, mean / median (max) | 3.2 s / 1.0 s (36 s) |
| Jev latency p50 (per-program medians, median) | 240 ms |
| Budget stops | test_runs: 8 |

### Failure taxonomy (not repaired)

| Category | Count | Programs |
| --- | --- | --- |
| fix_not_in_candidates | 4 | reverse_linked_list, shortest_paths, shunting_yard, wrap |
| ranking_missed | 2 | kth, sqrt |
| localisation_missed | 2 | lis, mergesort |

<!-- generated:end -->

## Reading the data

**Headline.** 32/40 programs (80 %) are repaired end to end with tests as the only oracle and Jev
as the only model, at a mean of **$0.0009 and 3.2 s per program** (median 1.0 s; the whole
benchmark took 62 s wall with three programs in flight and $0.035 of Jev). The `JEV-ONLY.md`
success criterion (≥ 60 % under $0.05 and 2 minutes per program) is met with a wide margin.
Search-based systems without a learned ranker are usually quoted at 25–40 % on this benchmark.

**Where the work happens.** For the 32 repaired programs the loop needed a mean of 2.9 test runs
and 4.5 Jev requests: one localisation Choice, three ranking Choices, one baseline run and, in
22 of 32 cases, exactly one verification. The winning candidate had global rank 1 in 25 programs
and rank ≤ 2 in 28; the maximum was 10 (`shortest_path_length`, whose true line was localised
4th and only entered the queue after widening). Jev's per-request latency was 240 ms p50, so the
loop is bounded by the test runner, not by the model.

**The two Jev decisions, separately.** Localisation put the true line at rank 1 in 27/40,
within the top-3 in 32/40 and within the top-5 in 36/40 (the four misses include two insertion
bugs, where the "true line" is only the insertion point). Selection is the stronger stage: when
the true line was ranked and the reference fix was among its 33–200 candidates, Jev put the fix
at rank 1 in 25/33 and within the top-3 in 31/33. The two selection misses with a low fix rank
(`kth`: rank 182/189, `next_permutation`: rank 12/200) are both cases where a *different*
candidate on the same line is also a correct fix (`next_permutation` was repaired by that
candidate; `kth`'s preferred candidate `k - 1` was a false lead).

**Candidate coverage.** The 15 operator families enumerate a median of 137 compiling candidates
per line and contain the reference fix for 35 of the 36 replaceable bugs (97 %); the 200-cap
never removed a fix. The one uncovered replacement (`shortest_paths`, `weight_by_edge[u, v]` →
`weight_by_node[v]`) needs two simultaneous edits. The four insertion bugs are unreachable by
construction, so the structural ceiling of a single-line-replacement loop on QuixBugs is
35/40 = 87.5 %; the loop reached 32 of those 35, plus one insertion bug through a test-passing
but wrong alternative (below).

**Progress rounds.** Six programs adopted a "strictly more tests pass" candidate as a new base.
Three of them were then repaired in round 2 (`find_first_in_sorted`, `minimum_spanning_tree`,
`sieve`; all by a second one-line edit that together with the first is a correct program). The
other three (`kth`, `sqrt`, and `lis`) are the greedy-progress trap: a wrong candidate raised the
pass count (`kth`: `k - 1`, 3 → 5 of 7; `sqrt`: flipping `>` to `<` exits the loop at once and
passes 2 of 7), the loop committed to it, the reference fix is no longer a single-operator edit
of the new base, and the remaining budget was spent in the wrong basin. `topological_ordering`
failed the same way in run 1.

**Alternative fixes and test overfitting.** 7 of the 32 repairs differ from the reference line.
By inspection five are semantically equivalent or equally correct (`next_permutation`
`perm[j] > perm[i]`; `quicksort` `lesser … x <= pivot`; `possible_change` `not coins or total < 0`;
`sieve` `not any(n % p == 0 …)`; `find_first_in_sorted` and `minimum_spanning_tree` as two-line
variants), but `depth_first_search`'s "repair" (`any(nextnode for nextnode in node.successors)`,
i.e. "the start node has a successor") merely satisfies the 5 tests. Counting by inspection, the
correct-repair rate is **31/40**; the QuixBugs suites are small (3–14 tests), and tests-as-oracle
overfits at least once in 40. A Jev Noul over the repaired program ("does `candidate` fix the
bug for the reason `actual_output` shows, or does it just make the tests pass?") is a cheap
guard to measure next.

**Run-to-run stability.** The same code was run twice with the same budgets (run 1:
`prototype-baseline-run1.jsonl`; run 3, reported above: `prototype-baseline.jsonl`; an
intermediate run made with a different test verifier is not reported). Both runs repaired 32/40
and localised the true line at rank 1 in 27/40, with identical localisation ranks in 36/40
programs, but the failing sets differ: run 1 failed `possible_change` and `topological_ordering`
where run 3 failed `mergesort` and `sqrt`. 30 programs were repaired in both runs and 34 in at
least one. The flips all sit in Jev's noisy 0.03–0.30 band (a line at p 0.03–0.05 ranked 3rd vs
6th; a candidate at p 0.15 tied with a wrong one). Cost was $0.034 vs $0.035.

**Budgets.** Every one of the 8 failures stopped on the 40-test-run cap; none came near the Jev
cap (max 14 of 30 requests) or the wall cap (max 36 of 180 s). Test runs, not Jev, are the
binding resource, which is the opposite of the usual APR profile and argues for spending more
Jev decisions per test run.

## Failure taxonomy (discussion)

| Category | Programs (run 3) | What actually happened |
| --- | --- | --- |
| `fix_not_in_candidates` (4) | `reverse_linked_list`, `shunting_yard`, `wrap`, `shortest_paths` | three insertions (a missing `prevnode = node`, `opstack.append(token)`, `lines.append(text)`) and one two-edit replacement; no line replacement can produce them. `depth_first_search` is the fourth insertion bug but was "repaired" by an overfitting alternative. |
| `localisation_missed` (2) | `lis` (true line rank 6, p 0.02), `mergesort` (rank 6, p 0.03) | Jev put 0.67–0.70 on a line that *reads* the buggy state or looks idiomatic-but-odd (`result.extend(left[i:] or right[j:])`) instead of the base case / update two lines away. In run 1 `mergesort` was localised 3rd and repaired; `possible_change` (rank 7) took its place. |
| `ranking_missed` (2) | `kth`, `sqrt` | greedy-progress trap (above); the reference fix was in the round-1 set (`sqrt` at Jev rank 3, p 0.15, tied with the false lead). |
| `runner_issue` (0) | – | the verifier self-test passes 40/40 (correct programs pass, buggy fail) and no true fix was ever rejected. |

The 4 insertion bugs (10 % of the benchmark) are structurally unreachable by line replacement
and should be read as the fixed cost of this loop's design, not as ranking or localisation error.

## Three highest-leverage improvements

1. **Make progress a beam, not a commitment (worth ≈ 2–3 programs, 5–7 pts).** Three of the
   eight failures across the two runs (`kth`, `sqrt`, `topological_ordering`) were caused by
   adopting a pass-count improvement as the new base. Keep the improved program as a *second*
   base but finish the round-1 queue first, cap the beam at two bases, and ask Jev one Noul per
   adopted base ("given `before`/`after` outputs, is `candidate` a fix for the failing cause or an
   accident that changes the pass count?"). The three genuine two-step repairs
   (`find_first_in_sorted`, `minimum_spanning_tree`, `sieve`) stay reachable.
2. **Insertion and donor candidates (worth up to 4–5 programs, 10–12 pts).** All four insertion
   fixes are statements built from identifiers already in the function: `x.append(<id>)` where
   `x.append(...)` occurs elsewhere (`wrap`, `shunting_yard`), `<set>.add(<param>)`
   (`depth_first_search`), `<id> = <id>` (`reverse_linked_list`). Enumerate "existing statement
   with one identifier substituted" and "assignment between two in-scope names" at every
   insertion point of the top-3 lines (before/after), and add a Choice over insertion points
   whenever localisation's `none_of_these` (the "needs a new line" escape) carries mass. The
   remaining coverage gap (`shortest_paths`) needs two-edit candidates: pair the top-10
   single edits of one line (≤ 45 pairs) only when the single edits all fail.
3. **Spend Jev instead of tests, and add spectrum-based localisation (worth ≈ 2 programs plus
   a large budget headroom).** Every failure hit the 40-test-run cap while using ≤ 14 of 30 Jev
   requests; each verification costs ~0.2 s and one Jev request ~0.25 s and $0.0002. Before
   verifying anything with p < 0.10, rerank the top-20 candidates across lines with paired Nouls
   or pairwise Choices in one request, and skip candidates whose probability is below the line's
   `none_of_these` mass. For localisation, the two misses (`lis`, `mergesort`) put the true line
   at p ≤ 0.03: combine Jev's line probabilities with Ochiai scores from per-test line coverage
   (cheap for these programs via `sys.settrace`), and when the top-5 queue is exhausted widen to
   *all* lines ranked by the combined score rather than stopping.

Two smaller items the data also suggests: never mutate `def` lines (they consumed a request in
10 programs at p ≤ 0.03); and put the winning-candidate probabilities of the 29 first-shot
repairs (median 0.79) next to the 0.03–0.51 of the four repairs that needed more than two
verifications (`depth_first_search` 0.05, `shortest_path_length` 0.03, `possible_change` 0.18,
`subsequences` 0.51) to set a "verify now vs rerank first" threshold.
