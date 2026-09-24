# Jev-only QuixBugs run 3: inspection of the non-gold passers and the LCS miss

Run: `bench/results/jev-only-quixbugs-3/tasks.jsonl` (bench `20260920-205918-3f1604`, 36/40 passed, decider `typesafe/jev-1.13-20260917`, no generator). Patched files read from each run's `workspace` (`~/.jevcode/runs/bench-work/20260920-205918-3f1604/<task>/jev-only/workspace/<task>.py`); reference `bench/data/quixbugs/correct/`, buggy `bench/data/quixbugs/programs/`, visible tests `bench/data/quixbugs/tests/`. Analysis only; no source edited.

## 1. Passers whose patch differs from the reference

Method: unified diffs buggy -> patched and buggy -> reference, reasoning about the semantics, then a differential harness (python3, in-process, 1 s alarm per call) comparing patched vs reference on 20-56 extra inputs per program (empty, singletons, duplicates, negatives, large n, cycles/unreachable goals for the graph programs; brute-force oracles for `lis` and `max_sublist_sum`, `sorted()` for `quicksort`). All 10 patched files pass their visible tests (re-run with `run_tests.py`).

Labels: `equivalent` = same result (or same exception) on every input tried and by reasoning on all valid inputs; `equivalent-with-caveat` = same on all valid inputs, a difference exists only outside the spec (object identity/stability) or the patch carries dead code; `overfit` = differs from the reference on valid inputs.

| program | classification | evidence | hidden-input failure |
| --- | --- | --- | --- |
| detect_cycle | **overfit** | Patch adds `if tortoise.successor is None: return False` after the advance instead of guarding `hare is None`. Cycles: never a false negative (no node in a cyclic list has `successor None`). Acyclic odd lengths and length 1-2 return False. Acyclic even length >= 4: `hare` becomes None with `tortoise` not at the tail, next iteration dereferences `None.successor`. 56 cases, 5 mismatches (all acyclic even lengths 4, 6, 8, 10, 12). Visible tests only use acyclic lengths 1, 2, 5. | 4-node acyclic list: reference `False`, patched `AttributeError: 'NoneType' object has no attribute 'successor'` |
| breadth_first_search | equivalent | `while True: if not queue: return False; ...` is `while queue:` spelled out; trailing `return False` dead in both. 26 cases (unreachable goals, self loops, cycles, disconnected, 3000-node chain/cycle, random), 0 mismatches. | none |
| max_sublist_sum | equivalent | `max(x, meh + x)` (best non-empty sum ending here) vs `max(0, meh + x)`; since `max_so_far` starts at 0, both return `max(0, best non-empty subarray)`; induction: `meh_ref(i) = max(0, meh_patch(i))`. 27 cases incl. all-negative, floats, n=100000, 0 mismatches; brute-force oracle agrees on 26. | none |
| lis | equivalent (dead code) | Patch sets `ends[length+1] = i` unconditionally before the `if`, so `val < arr[ends[length+1]]` is always False and the branch reduces to `length == longest`. When `length < longest`, `arr[ends[length+1]] >= val` by construction, so overwriting with index `i` either equals the reference's update (`>`) or replaces an index with an equal value (`==`, unobservable: only `arr[ends[j]]` is read). 32 cases incl. the bug trigger `[1,2,3,0,1]`, all-equal, n=2000, 0 mismatches vs reference and vs O(n^2) DP oracle. | none |
| next_permutation | equivalent | `perm[j] > perm[i]` vs `perm[i] < perm[j]`: identical for ints. 52 cases (all 4-permutations, duplicates, last permutation -> None in both, n=200), 0 mismatches. | none |
| possible_change | equivalent | `if not coins: return 0` after `total < 0` vs `total < 0 or not coins`: same decision order (total == 0 -> 1 first in both). 27 cases, 0 mismatches. | none |
| powerset | equivalent (gold-identical modulo comment) | The code line is the reference's; the only diff is the retained `#python3 just like car and cdr` comment. 20 cases, 0 mismatches. Whitespace/comment-insensitive comparison counts it as gold-identical. | none |
| quicksort | equivalent-with-caveat | Duplicates of the pivot go to `lesser` (`<=`) instead of `greater` (`>=`). Same multiset and same `==` result on every input (28 cases incl. all-equal n=200, n=20000, `sorted()` oracle agrees). Caveat: the reference is stable, the patch is not; observable only through identity among `==`-equal distinguishable objects: `[1, True, 1.0]` -> reference `[1, True, 1.0]`, patched `[1.0, True, 1]` (`==` still True). Recursion depth on all-equal input identical (n-1 on one side in both). | none on int lists |
| wrap | **overfit** | Patch nests a second copy of the loop and never appends the final remainder; after the inner loop it re-splits the remainder at the stale `end` of the previous line (`line, text = text[:end], text[end:]`), so the remainder is truncated to `end` chars and the tail is dropped; text of length <= cols returns `[]`. 38 cases, 10 mismatches (both versions hang identically on 9 inputs where `rfind` returns 0, e.g. `(' hello world', 5)` -- a pre-existing reference behaviour). Visible tests: 3 long paragraphs at cols 20/50/80 whose last split happens to satisfy `len(remainder) <= end`. | `wrap('hello', 10)`: reference `['hello']`, patched `[]`; `wrap('hello world', 6)`: reference `['hello', ' world']`, patched `['hello', ' worl']` |
| topological_ordering | equivalent (dead code) | The reference line is present; the extra `nextnode = node; if set(ordered_nodes).issuperset(nextnode.outgoing_nodes) and nextnode not in ordered_nodes:` can never fire because `node` is an element of `ordered_nodes` (Node has identity `==`). Rebinding the loop variable at the end of the body is reset by the `for`. Cost: one extra `set(ordered_nodes)` per edge (same complexity class). 25 cases (empty, isolated nodes, diamonds, fan-in/out, cycles, layered, random DAGs n<=30), 0 mismatches on the returned node order. | none |

### Diffs (buggy -> patched, then buggy -> reference)

```
detect_cycle   patched: + if tortoise.successor is None: return False   (after hare = hare.successor.successor)
               reference: - if hare.successor is None:  + if hare is None or hare.successor is None:
breadth_first_search  patched: + if not queue: return False   (top of while True)      reference: while True -> while queue
max_sublist_sum       patched: max(x, max_ending_here + x)                              reference: max(0, max_ending_here + x)
lis                   patched: + ends[length + 1] = i  (before the if; keeps longest = length + 1)
                      reference: longest = length + 1 -> longest = max(longest, length + 1)
next_permutation      patched: perm[j] > perm[i]                                          reference: perm[i] < perm[j]
possible_change       patched: + if not coins: return 0  (after total < 0)               reference: if total < 0 or not coins:
powerset              patched: rest_subsets + [[first] + subset ...]  (comment kept)      reference: same line, comment removed
quicksort             patched: lesser = quicksort([x for x in arr[1:] if x <= pivot])    reference: greater = ... if x >= pivot
wrap                  patched: + while len(text) > cols: (nested copy of the loop, appends `wrap`) ; final remainder never appended
                      reference: + lines.append(text)  (after the loop)
topological_ordering  patched: + if set(ordered_nodes).issuperset(nextnode.incoming_nodes) and nextnode not in ordered_nodes: append
                               + nextnode = node   (the old outgoing_nodes check then guards a node already in the list)
                      reference: outgoing_nodes -> incoming_nodes on the existing line
```

Note on the pass count: whitespace/comment-insensitive comparison of all 36 passers against the reference gives **27 gold-identical** (the bench's "26 gold-identical" counts `powerset` as different because of its comment) and 9 that differ in code.

## 2. `longest_common_subsequence`: why run 3 missed (6/10, `max_steps`)

Run 3: `~/.jevcode/runs/20260920-210202-ypl5tdpw/` (3m8s, $0.018, 887 Jev questions, 12 steps, `model_patch.diff` empty, workspace file unchanged). Run 1 (passed, 4 steps, 42 s): `~/.jevcode/runs/20260920-193404-ne5mslys/`. True line: `index.json` bugLine 6, `a[1:], b)` -> `a[1:], b[1:])`, kind `wrong_variable`.

**Timeline (run 3).** Steps 1-2 read the file (Jev intent `investigate`). Step 3: the synthesizer searched g1 (4 failing tests): SEEDS batches ran whole (20, 28, 9, 20, 34, 8, 20, 4, 9, 20, 9, 20, 40, 9, 102, 26, 13 candidates = 391 runs), then the test wall hit 0 s, four empty batches, SKETCH phase with 30 Jev requests; trace `phase SKETCH, RANK, sites 8, enumerated 785, ranked 385, tested 391, plausible 0, outcome budget`; the step became a subset `run` (6p/4f). Step 4: attempt 2, `phase WIDENED, RANK, sites 15, 25 requests, 328 runs, plausible 0`, again `budget`; the goal was parked ("2 consecutive budget-hit steps"); Jev blocked the `run` at risk 0.86. Steps 5-6: `done partial` proposals blocked (risk 0.97, 1.00). Step 7: read; loop detector tripped. Step 8: replan `change_approach` (p 0.57) reopened g1 with a rotated source order and site beam 6 -> 10; 22 runs, all sources exhausted at 7 sites, parked again. Steps 9-12: reads declined/executed, `run` blocked; `max_steps`.

**Localisation.** Jev's `buggy_line` Choice put line 6 first in both runs (run 1: line_6 0.37, none_of_these 0.30, line_5 0.11, line_10 0.10; run 3 step 3: line_6 0.36, none_of_these 0.34, line_10 0.14, line_5 0.06; step 8: line_6 0.51). Per-line Nouls: line_6 0.20 (run 1) vs 0.16 (run 3), line_10 0.19 in both. Sites list starts `longest_common_subsequence.py:6` in both runs. Localisation did not miss.

**Was the gold enumerated?** Yes, twice. (a) The SEEDS mutation source produced it (run 1 committed it as `mutation/slice_tweak` at line 6; its diff hash `b7b7f2d2dc3e` is in run 3's persisted `tried` set at position 277 of 741, inside the 102-candidate batch, exactly where run 1's batch reported "100 regressed, 1 unchanged, 1 plausible"). Run 1's 337 tried hashes are all among run 3's 741: the same enumeration ran. (b) In run 3's SKETCH phase Jev was shown the gold as `candidate_ar` in a 52-option `fix` Choice and gave it the highest candidate probability (0.05) under `none_of_these` 0.90 -- but it was already `tried`, so the filter (`subgoal.ts:342 wasTried`) never re-ran it.

**What happened to it.** The 102-batch in run 3 read "100 regressed, 2 timeout". Every batch that was "unchanged" in run 1 was "timeout" in run 3 (20 -> 20 timeout; 34: 30 unchanged -> 30 timeout; 40: 32 -> 32; 9: 2 -> 2; 102: 1 unchanged + 1 plausible -> 2 timeout). Mechanism, from the code that landed one minute before run 3 (commit `455395b`, 20:58:22 UTC; run 3 started 20:59:18 UTC; run 1 ran at 19:34 UTC on the previous rule, a fixed 2 s per case):

- `budget.ts perTestTimeout`: per-case limit = clamp(3 x mean time of the baseline's finished cases, 500 ms, 2000 ms), passed to the generated pytest module as `JEVCODE_CASE_TIMEOUT_MS`, with `JEVCODE_MAX_CASE_TIMEOUTS=1` (one case timeout ends the run, the remaining cases are "not run").
- LCS is extremely skewed: idle, case 3 (`"thisisatest"`, `"testing123testing"`) takes 184 ms buggy / 94 ms gold, the other nine cases <= 14 ms (whole suite 205 ms buggy, 105 ms gold). The mean of finished cases is ~20-35 ms idle, so 3 x mean is far below the slow case and the 500 ms floor was the limit (at most ~600 ms if the loaded 2250 ms baseline's pytest session ran near 2 s).
- `runner.ts classifyOutcome`: a run whose every failure is a case timeout or a not-run is `timeout`; every completed run's diff hash enters `mem.tried` regardless of verdict (`runner.ts:440`), the queue filters on it (`subgoal.ts:342`), and only wall-cut `aborted` runs are deferred and re-run.
- Load: run 3's baseline took 2250 ms (run 1: 700 ms); lane batch medians were 821-1919 ms (a gold or regressed run is ~190-220 ms idle under this module), i.e. 4-9x slower; 14 other bench tasks overlapped the LCS window (21:02:02-21:05:10 UTC), each with up to 8 lanes. At >= 2.7x the buggy-behaviour case crosses 500 ms (all "unchanged" candidates -> `timeout`, as observed); at >= 5.3x the gold's case 3 does too. A synthetic check (45 busy loops on 15 cores, ~2.5-3x slowdown) kept the gold at 10 passed in 0.30 s, so the false timeout needs the heavier contention the run's own medians show; it is inferred from the batch-by-batch correspondence with run 1 and the `tried` membership, not reproduced.
- Cost side: each timing-out run costs the full 500 ms cap plus stop-rule overhead, so 391 runs consumed the entire 90 s test wall (run 1: 337 runs in 34 s), which is why the step ended in `budget` and the mode label flipped to RANK (runs left 0).

**Secondary observations.** No partial base was committed (`committedDiffHashes: []`, workspace unchanged), so this is not a partial trap. In SKETCH, Jev's `edit_class` said `insert_new_line` 0.97-0.99 (the fix is a one-token fragment insert), so the 30+25 RANK requests searched the wrong edit class; irrelevant to the miss since the gold was already excluded. Steps 4-12 then burned 8 steps on blocked `run`/`done` proposals and repeated reads.

**Classification: `infra`** (verifier false-negative: the adaptive per-case timeout with the one-alarm stop rule scored the gold `timeout` under bench CPU contention, and the `tried` memory made that verdict permanent), with `budget` as the proximate stop (test wall exhausted at steps 3 and 4, then `max_steps`). Not `fix_not_in_candidates` (enumerated and run), not `localisation_missed` (line 6 ranked #1), not `ranking_missed` (Jev ranked the gold top among candidates when asked; in run 1 no ranking was needed), not `partial_trap`.

| | run 1 (pass) | run 3 (miss) |
| --- | --- | --- |
| code | before `455395b` (fixed 2 s per case) | `455395b` + `c39e047` (clamp(3 x mean, 0.5 s, 2 s), stop after 1 timeout) |
| baseline | 6/10 in 700 ms | 6/10 in 2250 ms |
| overlapping bench tasks | 5 | 14 |
| step 3 mode / phase | SIEVE / SEEDS, 337 runs, 3 Jev requests, 34 s wall | SIEVE batches then RANK / SKETCH, 391 runs, 30 requests, 90 s wall (0 left) |
| gold candidate | in batch 15 (102): `plausible` -> commit, 10/10 at step 4 | in batch 15 (102): `timeout` -> `tried`, never re-run |
| Jev `buggy_line` line_6 | 0.37 (#1) | 0.36 (#1), 0.51 at step 8 |
| Jev on the gold text | not asked (tests decided) | `fix` Choice: gold 0.05 = top candidate, none_of_these 0.90 |
| result | complete, 4 steps, $0.002 | max_steps, 12 steps, $0.018, patch empty |

Two facts worth carrying forward: the per-case rule uses the mean of finished cases (skew-blind: LCS's slowest case is ~40x its mean), and a `timeout` verdict is final even when the same candidate was cheap idle.

## 3. Corrected count for run 3

- Reported: 36/40 pass (evaluator = visible tests).
- Gold-identical (whitespace/comment-insensitive): 27 (bench said 26; `powerset` differs only by a comment).
- Differs but equivalent: 7 (`breadth_first_search`, `max_sublist_sum`, `lis`, `next_permutation`, `possible_change`, `topological_ordering`; `quicksort` with the stability caveat).
- Overfit: 2 (`detect_cycle`: crashes on acyclic even-length lists >= 4; `wrap`: drops or truncates the final line, returns `[]` for text that fits).
- **Correct by inspection: 34/40 (85.0%)**, vs 36/40 (90.0%) by visible tests.
- Misses unchanged at 4 (`depth_first_search`, `longest_common_subsequence`, `reverse_linked_list`, `shunting_yard`); only LCS was diagnosed here.
