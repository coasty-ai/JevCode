# Probe: donor code and fix templates with Jev only (2026-09-20)

Scripts: `experiments/probe-donor/` (`build_dataset.py` builds `quixbugs.json` from `/tmp/quixbugs`;
`probe.mts <donor|donor2|ident|kind|insert>` runs the live probes and writes `out/<mode>.json`;
`swebench_donor_coverage.py` and `quixbugs_donor_coverage.py` are code-only; `report_tables.py`
renders the per-item tables below from `out/`). Model `typesafe/jev-1.13-20260917` via OpenRouter,
pinned. No generating LLM anywhere; every candidate set is computed in code; Jev only chooses.

Corpus: all 40 QuixBugs Python programs (36 one-line replacements, 4 one-line insertions),
code-only (trailing docstring, blank and comment lines stripped), 4 JSON test cases in the state
(or the pytest source for the 9 graph programs without JSON cases). Kind labels were hand-derived
from the buggy-vs-correct diff (`build_dataset.py` `KINDS`), with a strict primary label and an
"acceptable" set where the catalogue is genuinely ambiguous (e.g. `<=`→`<` is both `operator_swap`
and `off_by_one`).

## Headline table

| # | Question (Choice) | n | top-1 | MRR | cost | Jev p50 |
| --- | --- | --- | --- | --- | --- | --- |
| 1a | donor line at the hole, pool = own program lines + fix line (6–35 options) | 36 | **35/36** | 0.986 | $0.0041 (1a+1b) | 191 ms |
| 1b | same, pool = own + 3 other programs (25–76 options) | 36 | **33/36** | 0.954 | | 191 ms |
| 1c | same, pool filled to **254** with lines from all 40 programs | 36 | **32/36** | 0.940 | $0.0115 (1c+1d) | 196 ms |
| 1d | same as 1b with the fix line **removed** (truth = `none_of_these`) | 36 | escape top 9/36; escape-or-buggy-line top **35/36** | | | 196 ms |
| 2a | identifier filling `__HOLE__` in the fix line, buggy line visible, identifier **changed** vs buggy line | 13 | **13/13** | 1.000 | $0.0071 (all of 2) | 195 ms |
| 2a' | same, identifier unchanged (copyable from the buggy line) | 107 | 103/107 | 0.980 | | |
| 2b | same, buggy line replaced by a hole marker, changed identifiers | 13 | 12/13 (13/13 leak-free re-run, see §2) | 0.949 | | |
| 2b' | same, unchanged identifiers | 107 | 92/107 | 0.927 | | |
| 3a | fix kind over the 9-entry catalogue, program + tests only | 40 | 25/40 strict, 30/40 lenient | truth in top-3 33/40 | $0.0025 | 175 ms |
| 3b | 3a with `missing_statement` added to the catalogue | 40 | 24/40 strict, 29/40 lenient | top-3 37/40 | $0.0025 | |
| 3c | 3a with the faulty line named in the state | 40 | **30/40 strict, 34/40 lenient** | top-3 38/40 | $0.0026 | |
| 4a | insertion point given the statement to insert | 4 | **4/4** | 1.000 | $0.0009 (all of 4) | 160 ms |
| 4a' | insertion point, statement unknown | 4 | 2/4 | 0.69 | | |
| 4b | which line gains the given condition | 4 | **4/4** | 1.000 | | |
| 4b' | which line has the wrong condition, condition unknown | 4 | 2/4 | 0.71 | | |
| 5 | SWE-bench gold added lines with a donor at base_commit (code only) | 29 lines / 10 instances | exact 10/29, normalised 17/29, Jaccard≥0.7 16/29; other-file only: 3 / 14 / 8 | | $0 | |

Total live spend: 350 requests, **$0.0312**, overall Jev latency p50 ≈ 190 ms, p90 ≈ 280 ms.

## (1) Donor line selection

State shape (per program; `program.L<k>` replaced by a marker, the buggy line removed):

```json
{ "task": "The function `gcd` has a single-line bug. Line `L4` of `program` has been removed and replaced by the marker `<<< MISSING LINE >>>`. Exactly one candidate line, once its identifiers are adapted to this function, belongs at that position so that every case in `tests` passes. Candidate lines are shown without indentation.",
  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", "L3": "        return a", "L4": "<<< MISSING LINE >>>", "L5": "..." },
  "missing_line": "L4",
  "tests": [ { "input": [17, 0], "expected": 17 }, ... ] }
```

Question (one Choice, option descriptions are the candidate lines, whitespace-stripped, order shuffled
with a fixed seed, plus the builder's `none_of_these` escape):

> Which candidate line, adapted to the identifiers of `program`, belongs at `program.L4` (the `<<< MISSING LINE >>>` marker) so that all `tests` pass?

Pools: **own** = every distinct line of the buggy program (so the removed buggy line is itself a
candidate, the strongest distractor) plus the true fix line; **own+3** adds every line of the next 3
programs alphabetically; **all-254** fills to 254 options with lines from all 40 programs;
**truth absent** = own+3 without the fix line, task text changed to "At most one candidate line …;
if no candidate fits, the answer is `none_of_these`".

Findings:

- The true fix line is top-1 in 35/36, 33/36 and 32/36 as the pool grows from ~10 to 254 options;
  it is never outside the top 3. P(true) p50 is 0.98 / 0.94 / 0.93. Scale barely hurts Jev; the
  REPORT §10 result (200 informative options, 100 % correct at mean confidence 0.997) holds for code lines
  [corrected 2026-09-20: the original text said "255 options"; REPORT §10 tested 50 and 200].
- Every miss but one is Jev picking the **buggy line back** (`pascal` in own+3, `sqrt` in own+3 and
  all-254, `possible_change` in own, `rpn_eval` and `subsequences` in all-254): the original line is
  a locally coherent filler for the hole, and the subtle differences (`r` vs `r + 1`, `approx` vs
  `approx ** 2`, `a, b` vs `b, a`) need the tests to be read. `next_palindrome` (own+3, all-254) is
  the one miss to a third line (`return digit_list`).
- When the fix line is absent, the escape option wins only 9/36 (p(escape) p50 0.20), but the
  buggy line wins another 26/36. So `top ∈ {none_of_these, buggy line}` is a **"no donor here"
  detector with 35/36 recall** and a false-alarm rate of 1/36, 2/36 and 3/36 on the three pools
  where the truth was present. That is the signal a search loop needs to move to the next candidate
  source instead of applying a wrong donor.

## (2) Identifier adaptation

For every identifier occurrence (`ast.Name`-like token, not attributes, not keywords) in the fix
line, one hole template. All holes of one program go in one request (independent questions, REPORT
§7). State shape:

```json
{ "task": "The function `bucketsort` has a single-line bug at `program.L5`. Each entry of `replacement_templates` is the proposed replacement for that line with one identifier removed and written as `__HOLE__`. The filled line must make every case in `tests` pass.",
  "program": { "L1": "...", "L5": "    for i, count in enumerate(arr):", ... },
  "faulty_line": "L5",
  "tests": [...],
  "replacement_templates": { "hole_1": "for __HOLE__, count in enumerate(counts):", "hole_4": "for i, count in enumerate(__HOLE__):" } }
```

Question per hole (options = the program's in-scope identifiers from the buggy source ∪ 22 common
builtins, keys `ident_<name>` because single-letter keys carry a name prior, descriptions = the
identifier; 26–45 options + escape):

> Which identifier, in scope in `program`, fills `__HOLE__` in `replacement_templates.hole_4` so that the completed line at `program.L5` makes all `tests` pass?

Variant **hole only** shows `<<< MISSING LINE >>>` at `L5` instead of the buggy line (nothing to copy).

Findings:

- The decisive case, the identifier that actually changes (`arr`→`counts`, `True`→`queue`,
  `helper`→`end`, `any`→`all`, `get(...)`→`distance`, `k`→`k - num_lessoreq`): **13/13 top-1** with
  the buggy line visible (P p50 0.93), 12/13 without it (the miss is `max` in
  `longest = __HOLE__(longest, length + 1)` at rank 3).
- Unchanged identifiers are easier with the buggy line (103/107) than without (92/107). The 20 misses
  are all one of two shapes: (i) a **call target** hole (`__HOLE__(counts)` → picks `counts`,
  `__HOLE__(mid + 1, end)` → `mid`, `__HOLE__(digit_list)` → `digit_list`, `__HOLE__(x - approx ** 2)`
  → `x`): Jev fills a function slot with the argument name; (ii) a **same-family pair** where either
  is plausible without the tests being computed (`a`/`b` in `gcd`, `i`/`j` in `next_permutation`,
  `k`/`j` in `shortest_path_lengths`, `b`/`a` in `op(token, b, a)`, `x`/`pivot`). No miss had
  P(true) below 0.06 and most sat at 0.2–0.4: hedged, not confidently wrong (REPORT §9 pattern).
- Coverage: every true identifier was in the in-scope set (0 uncovered), i.e. QuixBugs fixes never
  need a name that is not already used in the function or a builtin.
- **Leak (found in verification, 2026-09-20).** All hole templates of a program share one `state`, so
  sibling templates reveal each other's identifier (`hole_1 = "__HOLE__ &= n - 1"`, `hole_2 = "n &= __HOLE__ - 1"`);
  for programs with ≥ 2 holes the whole fix line is reconstructible from `replacement_templates`, and
  10 of the 13 "changed" holes sit in such programs. Questions are independent (REPORT §7) but the
  state is not. A leak-free re-run (`verify_ident_leakfree.mts`, one template per request) gave
  **13/13 top-1 in both variants** (P(true) p50 0.98 / 0.98; the `lis` `max` miss became rank 1 at 1.00),
  so the changed-identifier claim stands and slightly improves. The unchanged-identifier rows
  (103/107, 92/107) were not re-run and should be read as **upper bounds**: in the hole-only variant
  the "nothing to copy" premise is false whenever the program has another hole.

## (3) Fix-kind classification

State: `task`, `program` (full buggy program), `tests`; variant 3c adds `faulty_line: "L<k>"` and
`faulty_line_text`. Question:

> Which kind of fix does `program` need so that all `tests` pass? [3c: The faulty line is `program.L<k>`.]

Options (each described as definition + two examples, e.g. `operator_swap`: "One operator is wrong and
must be replaced by another of the same family: a comparison (`<` vs `<=`, `==` vs `!=`), arithmetic
(`+` vs `-`, `^` vs `&`), or boolean (`and` vs `or`) operator. Example: `while lo <= hi` should be
`while lo < hi`."; full text in `probe.mts` `CATALOGUE`): `operator_swap`, `off_by_one`,
`argument_order`, `missing_condition_or_guard`, `wrong_variable`, `wrong_function_call`,
`control_flow_change`, `wrong_constant`, `none_of_these` (+ `missing_statement` in 3b).

Findings:

- Without location, 25/40 strict (chance 1/9 ≈ 4.4), 30/40 lenient; P(top) p50 only 0.53. Naming
  the faulty line lifts it to 30/40 strict, 34/40 lenient, P(top) p50 0.83, and the truth is in the
  top 3 for 38/40. `control_flow_change` was never picked (and never the truth): the catalogue entry
  is dead weight on this corpus.
- The confusion is structural, not random: `argument_order` → `operator_swap` for `perm[j] < perm[i]`
  (P 0.97–1.00: a swapped comparison *is* also an operator flip), `wrong_function_call` →
  `wrong_variable`/`none_of_these` for `.update(...)`→`=` and `max(0, …)`, `off_by_one` →
  `wrong_constant` for removing `1 +`. Adding `missing_statement` did not help (2/4 inserted-line bugs
  found it; it also attracted `hanoi`, `to_base`, `powerset`, `max_sublist_sum`).
- The four inserted-statement bugs are the catalogue's blind spot: as `none_of_these` they score
  3/4 in 3a, but with `missing_statement` offered only 2/4 pick it.

## (4) Where to insert / which line gains the condition

Insert (4 programs): options `before_l1`, `after_l<i>` for every line, description
"insert directly after L<i>: <line text>" (8–19 options + escape). State adds
`missing_statement: "<fix line>"` in the given-line variant. Question:

> Where in `program` must `missing_statement` be inserted so that all `tests` pass?  /  Where in `program` must the missing statement be inserted so that all `tests` pass?

Condition (4 programs: `breadth_first_search`, `detect_cycle`, `possible_change`,
`is_valid_parenthesization`): options = every line; state adds `condition_to_add` (`queue`,
`hare is None or`, `not coins`, `depth == 0`). Question:

> Which line of `program` must be changed to incorporate `condition_to_add` so that all `tests` pass?  /  Which line of `program` has the incomplete or wrong condition that must be changed so that all `tests` pass?

Findings: with the statement or condition given, **8/8 top-1** (P 0.37–0.96; the low ones are
`possible_change` 0.37 and `reverse_linked_list` 0.43 where two adjacent positions are both
defensible). Without it, 4/8, and the escape fires once (`reverse_linked_list`, 0.09 on truth).
Placement is easy once the content is known; the content must come from a candidate source first.

## (5) SWE-bench gold patches: do the added lines have a donor?

Code only. 10 instances (3 sympy, 3 django, 2 pytest, 1 pylint, 1 requests; all 10 are labelled "<15 min fix"
[corrected 2026-09-20: the original text said 8 + 2 "15 min–1 hour"; `out/swebench_donor.json` and the per-instance table below show all 10 as "<15 min fix"] — the ones whose gold patch is smallest), repos at `base_commit` under
`/tmp/jevonly/repos/`. Added `.py` lines of the gold patch, whitespace-stripped, minus blanks, comments
and bare brackets/keywords: 29 lines. Three matchers over every non-blank line of every `.py` file at
`base_commit`: exact; identifier-normalised (every non-keyword `NAME` → `ID`, numbers → `NUM`, strings
→ `STR`; `self`/`cls` kept); token-set Jaccard ≥ 0.7 (Python `tokenize` NAME/NUMBER/STRING/OP
tokens). Parenthesised numbers exclude the patched file, because a deleted-then-re-added line in the
same hunk trivially matches itself.

Findings:

- 10/29 exact, 17/29 normalised, 16/29 Jaccard≥0.7 — but django-16100 alone contributes 10 lines,
  8 of them literally copied from the `changeform_view` method of the same file (`options.py`). Without
  it: 2/19 exact, 7/19 normalised, 7/19 Jaccard; other-file only 1/19, 6/19, 4/19.
- The normalised hits that are not copies are short idioms (`return hash(self.creation_counter)`,
  `blocks_remove_mask[i] = True`, `if self.min_lines == 0:`, `_print_MinMaxBase = _print_Function`):
  the *shape* exists in the repo, the identifiers do not. Jaccard≥0.7 on a 5-token line is a weak
  bar (`return Float(...)` matched `piecewise.py` at exactly 0.70 on shared punctuation).
- Lines with no donor of any kind are the semantic core of each fix: **9/29** when any file at
  `base_commit` may donate, **13/29** when the patched file is excluded [corrected 2026-09-20: the
  original text said 12/29, which matches neither criterion; recomputed from `out/swebench_donor.json`].
  The 9 are the `"Max"`/`"Min"` entries (sympy-15345), the `blocks = [b for i, b in enumerate(blocks) if not
  blocks_remove_mask[i]]` triplet (sympy-19954), `assert isinstance(self.parent, UnitTestCase)` and
  `skipped = _is_skipped(self.obj) or _is_skipped(self.parent.obj)` (pytest-10081), the `tw.write(...)`
  line (pytest-7205) and `elif self.method not in ('GET', 'HEAD'):` (requests-1142). `bound_method =
  wraps(method)(partial(method.__get__(self, type(self))))` has a Jaccard-0.92 donor only in the patched
  file itself (`django/utils/decorators.py`), so it counts as no-donor only under the other-file criterion.

QuixBugs, same matchers (table at the end): only 4/40 fix lines have a normalised donor in the same
program and 8/40 in the other 39; but **the buggy line itself is the best donor**: Jaccard(fix,
buggy) ≥ 0.7 for 22/36 replacement bugs, ≥ 0.5 for 33/36, and 7/36 fixes are pure identifier
substitutions of the buggy line. All 4 inserted statements have a normalised donor in another program
(`prevnode = node`, `opstack.append(token)`, `lines.append(text)`, `nodesvisited.add(node)`).

## What this means for the design

1. **Ranking is solved for this scale; coverage is the problem.** Given the correct line among up
   to 254 code lines, Jev finds it 89–97 % top-1 and never below top-3, in one ~190 ms, ~$0.0002
   request. The anchor probe (localisation 13/14) plus this means localise → rank is not where a
   Jev-only repair loop will fail. It fails when the candidate set does not contain the fix, and
   the code-only coverage numbers say a donor-line source alone reaches ~10–40 % of QuixBugs fixes (4/40 normalised same-program to 16/40 by any matcher, either source)
   and ~30–50 % of SWE-bench added lines (most of those being repo idioms, not the semantic core).
2. **The primary candidate source for one-line bugs must be the buggy line itself, mutated.**
   Jaccard(fix, buggy) ≥ 0.5 for 33/36 QuixBugs replacements, and the mutation set is
   operator swap ∪ ±1 ∪ identifier substitution ∪ operand/argument swap ∪ wrap-in-call
   (`max(...)`, `abs(...)`, `all(...)`) ∪ literal edit. Identifier substitution should draw from the
   in-scope set (0 uncovered here), and Jev fills a substituted slot 13/13 when the buggy line is
   visible. Donor lines from elsewhere are the *secondary* source, needed mainly for inserted
   statements (4/4 had a donor) and multi-line SWE-bench additions.
3. **Do not gate on fix-kind classification.** 62 % (75 % with location) over 9 kinds is far below
   the 97 % Jev reaches when picking among concrete lines, and the confusions are between kinds whose
   mutation sets overlap anyway. Enumerate candidates from *all* templates (a few hundred concrete
   lines fit in one Choice) and let Jev pick among lines, not among kinds. If a kind prior is wanted
   to order beam expansion, use the top-3 (38/40 with location) as a soft filter, never top-1.
   Drop `control_flow_change` from the catalogue (never picked, never true); add a
   `missing_statement` source rather than a kind.
4. **Keep the removed buggy line in the pool as the "nothing better" sentinel.** The escape option
   alone detects an absent fix only 25 % of the time (p(escape) p50 0.20, so thresholding it is
   hopeless, REPORT §14), but `top ∈ {none_of_these, buggy line}` detects it 35/36 with 3–8 % false
   alarms. A loop should treat "Jev put the original line back" as "this candidate source is
   exhausted at this site; widen the pool or move to the next source", not as a failure.
5. **Pipeline order that the numbers support:** localise line (anchor probe) → enumerate mutations
   of that line + donor statements with normalised shape from the repo → one Choice over ≤ 254
   concrete lines with the buggy line and escape included → if the pick is the buggy line or escape,
   escalate the source (insert a donor statement: placement is 4/4 once the statement is known) →
   for a donor with foreign identifiers, one request with a hole per identifier (13/13 on changed
   slots; expect ~10 % misses on call-target holes and `a`/`b`-style pairs, so keep the top-2
   fillings in the beam) → tests as the oracle. Expected Jev cost per program: 3–6 requests, under
   $0.002, under 2 s.
6. **Hole-filling weaknesses to engineer around:** function-slot holes (`__HOLE__(args)`) should
   restrict options to callables in scope (functions defined in the file + builtins), and
   same-family pairs (`i`/`j`, `a`/`b`) should be resolved by trying both in the test oracle rather
   than by asking again, since the misses are hedged (P 0.2–0.4), not confident.
7. **For SWE-bench, the donor source needs to be repo-wide and shape-indexed.** Normalised-shape
   matches in other files exist for 48 % of added lines (32 % without the copy-heavy instance), and
   Jev's identifier filling can adapt them; but 9/29 added lines (13/29 excluding the patched file) have no donor by any matcher, so a
   grammar-guided synthesis source (Choice over expression shapes, then identifiers) is required for
   the semantic core of real fixes. That is the next probe.

## Caveats

- QuixBugs fix lines were *placed* in the pool for (1); the code-only coverage study says a real donor
  pool would contain the fix for only a minority of programs. (1) measures ranking, not reach.
- Hand labels for (3) are one person's reading of the diff; the lenient column exists because
  several bugs genuinely fit two catalogue entries. Confusion counts should be read with that in mind.
- (3c) for the 4 inserted-line programs had no faulty line to name, so those 4 rows are identical
  in kind to 3a.
- (5) uses 10 of the 30 instances, biased to small gold patches; the 12 no-donor lines would grow as
  a share on larger patches. Jaccard ≥ 0.7 over-counts on short lines.
- (2) sent all hole templates of a program in one state, which leaks the answer across holes; see the
  leak note in §2. Changed-identifier results were re-verified leak-free (13/13, 13/13); unchanged-identifier
  results were not.
- (1c) pools were 253 candidates for a few programs (the fix line was already among the filler), not
  always 254.
- Single run per cell; REPORT §6 puts Jev's repeat noise at ±0.02 in the mid band, so ranks of items
  at P 0.4–0.6 (e.g. `next_palindrome`, `lcs_length`) can flip between runs.

## Per-item tables

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

## Verification (2026-09-20)

Adversarial check of this file against `experiments/probe-donor/` scripts and `out/*.json`. Verdict: **corrected**
(the live-probe numbers reproduce; three code-only/SWE-bench numbers and one citation were wrong; one methodological
leak in experiment (2) was found and re-tested).

**Scripts vs claims.** `probe.mts` does what each section describes: every Choice goes through the `choice`
builder (escape `none_of_these` always present, ≤ 255 options enforced, name-prior keys rejected); pools, holes and
catalogues are computed in code; no generating model is called. Question wording in the file matches the script
verbatim. Keys: `cand_<xx>` (opaque, deliberate: the line text is the description; REPORT §10 measured opaque keys +
descriptions at 0.96 vs 0.98 for semantic keys), `ident_<name>`, and semantic kind names with definition + examples.
No question asks Jev to count or compute; "so that all `tests` pass" asks for a judgment, not a number. Minor: the
`control_flow_change` catalogue entry is the only one without an example, which may contribute to it never being picked.

**Recomputed from raw output** (all match the file unless marked):

| claim | recomputed | status |
|---|---|---|
| 350 requests, $0.0312 | 72 + 72 + 70 + 120 + 16 = 350; $0.00409 + 0.01146 + 0.00713 + 0.00765 + 0.00088 = $0.0312 | ok |
| Jev p50 ≈ 190 ms, p90 ≈ 280 ms | per-mode p50 191 / 196 / 195 / 175 / 160; p90 270 / 284 / 264 / 277 / 262 | ok (≈) |
| 1a/1b/1c top-1 35, 33, 32 of 36; MRR 0.986 / 0.954 / 0.940; never below rank 3; P(true) p50 0.98 / 0.94 / 0.93 | identical; max rank 2 / 3 / 3 | ok |
| 1d escape top 9/36, buggy line 26/36, either 35/36, other 1 (`levenshtein`), p(escape) p50 0.20 | identical; escape rank ≤ 3 in 36/36 | ok |
| false alarms (buggy line top with truth present) 1 / 2 / 3 of 36; escape never top with truth present | identical | ok |
| 2a 13/13 (P p50 0.93), 2a' 103/107, 2b 12/13, 2b' 92/107, 0 uncovered, 20 misses all P ≥ 0.06 | identical; min P(true) among misses 0.06 | ok, but see leak |
| 3a 25/30 strict/lenient, top-3 33; 3b 24/29, 37; 3c 30/34, 38; P(top) p50 0.53 → 0.83; `control_flow_change` never picked or true | identical | ok |
| 4: 4/4, 2/4 (MRR 0.69), 4/4, 2/4 (MRR 0.71); escape fires once | identical (0.688, 0.708) | ok |
| 5: 10 (3) / 17 (14) / 16 (8) of 29; excl. django-16100 2 (1) / 7 (6) / 7 (4) of 19 | identical | ok |
| 5: "8 <15 min, 2 15 min–1 hour" | all 10 are "<15 min fix" | **corrected** |
| 5: "12/29 lines have no donor by any matcher" | 9/29 (any file), 13/29 (excluding patched file) | **corrected** (§5, design 7) |
| QuixBugs coverage 0/1, 4/8, 8/5, any 16/40, same-shape 7/36, Jaccard ≥ 0.7 22/36, ≥ 0.5 33/36, inserts 3/4 and 4/4 | identical (below-0.5: `flatten` 0.40, `is_valid_parenthesization` 0.20, `max_sublist_sum` 0.44) | ok |
| design 1: donors reach "~10–35 %" of QuixBugs fixes | 4/40 = 10 % to 16/40 = 40 % | **corrected** |
| REPORT §10 "255 informative options at confidence ~1.0" | REPORT §10 tested 50 and 200 options (100 %, mean confidence 0.997) | **corrected** |
| REPORT §6 ±0.02 mid-band noise; §7 independence; §9 hedged-not-confident; §14 no 0.5 threshold; anchor probe 13/14 | present in the cited sections / file | ok |

**Live re-run** (`experiments/probe-donor/verify_ident_leakfree.mts`, `out/verify_ident_leakfree.json`; 29 requests,
**$0.0014**, p50 185 ms, p90 290 ms):

- Leak in (2): `probe.mts` puts every hole template of a program into one `replacement_templates` object, so each
  sibling template shows the identifier another hole hides; 10/13 changed holes were in programs with ≥ 2 holes.
  Re-asked one template per request: with buggy line **13/13** top-1 (P p50 0.98), hole-only **13/13** (P p50 0.98);
  the one original miss (`lis`, `__HOLE__(longest, length + 1)` → `max`, rank 3 at 0.21) is rank 1 at 1.00 leak-free.
  Largest P shifts: `hanoi` hole-only 0.47 → 0.97, `shortest_path_length` with buggy line 0.89 → 0.66. The headline
  claim survives; the unchanged-identifier rows are now marked as upper bounds.
- Donor `own` reproduction on `bitcount`, `possible_change`, `sqrt`: ranks 1 / 2 / 1 as saved; P(true) 0.99 / 0.33 / 0.99
  vs saved 0.99 / 0.42 / 0.99 (the `possible_change` hedge moved 0.09, consistent with REPORT §6 mid-band noise).

**Literature.** The file cites no external literature with URLs; its only citations are to the internal
`<research-notes>/REPORT.md` (sections checked above) and `anchor-probe.md`. The one external
concept used, the "plastic surgery hypothesis" invoked in the `swebench_donor_coverage.py` docstring, was uncited; it is
Barr, Brun, Devanbu, Harman, Sarro, "The Plastic Surgery Hypothesis", FSE 2014, DOI 10.1145/2635868.2635898 (ACM page
returned HTTP 403 on 2026-09-20; the author's copy https://earlbarr.com/publications/psh.pdf was fetched, 877 KB PDF).
QuixBugs (https://github.com/jkoppel/QuixBugs, fetched 2026-09-20): README confirms 40 programs, one-line defects, MIT.

**Conclusions.** Design points 1, 2, 4, 5 and 6 are supported by the recomputed numbers. Point 3 ("do not gate on
fix-kind") is supported, with the note that lenient top-3 is 36 / 39 / 38 of 40, so a kind prior is usable as a soft
filter as the text says. Point 7's "12/29" is now 9/29 (13/29 other-file), which weakens the wording slightly but not
the conclusion that a synthesis source is needed. Unverifiable here: the hand kind labels (single annotator, already
caveated) and the claim in §1 that misses "need the tests to be read", which is an interpretation, not a measurement.
