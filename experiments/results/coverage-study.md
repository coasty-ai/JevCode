# Coverage study: what fraction of real fixes can code *propose* without a generating model?

Date: 2026-09-20. Topic: candidate-source coverage for the Jev-only agent (`docs/JEV-ONLY.md`). **No Jev
calls were made**: this is a pure-code ceiling study. Cost $0.00, Jev latency n/a; no question wording or
state shape was used. Scripts: `experiments/coverage-study/coverage_study.py` (analysis),
`experiments/coverage-study/make_report.py` (tables), `experiments/coverage-study/clone_repos.sh` (checkouts). Raw
per-line results: `experiments/results/coverage-study.json`.

Reproduce:

```
<repo>/experiments/coverage-study/clone_repos.sh  # 30 blobless worktrees under /tmp/jevonly/repos/<instance_id>
cd <repo>/experiments/coverage-study
python3 coverage_study.py > <repo>/experiments/results/coverage-study.json   # ~10 min, QuixBugs at /tmp/quixbugs
python3 make_report.py <repo>/experiments/results/coverage-study.json > tables.md
```

## Question

Jev decides, code proposes, tests verify. Before measuring how well Jev *selects*, we need the ceiling of
what the proposers can *reach*: for each real fix, is the fixed code among the candidates that a mutation
library, donor search, or fix template could enumerate? A fix that no source can propose is unreachable no
matter how good the ranker is.

## Data and definitions

- **QuixBugs**: 40 Python programs (`node.py` excluded; it has no bug). Diff of `python_programs/<p>.py`
  against `correct_python_programs/<p>.py` after stripping the trailing docstring, comment-only lines and
  trailing comments. 36 are single-line modifications, 4 are pure insertions of one statement.
- **SWE-bench Verified**: the 30 checked-in instances; gold patches from `bench/data/swebench-verified-30.gold.json`;
  each repo checked out at `base_commit` (blobless clone, one worktree per instance). The gold patch is also
  applied to a scratch copy so that docstring/comment/blank lines can be told apart from code lines (9 of
  the 115 raw change groups are docstring/blank/comment only and are excluded from the code-hunk counts; a
  further 30 non-code added lines were stripped from 9 code hunks. *Corrected 2026-09-20: the original text
  said "32 of the 115 raw change groups"; the JSON has 9 such groups.*)
- **Hunk** = a contiguous run of changed code lines in the unified diff (one `@@` block can contain several).
  Kind: `single_line_modification` (1 removed, 1 added), `multi_line_modification`, `pure_insertion`,
  `deletion`, `new_function` (insertion beginning with `def`/`class`). A hunk is reachable by a source if
  **every** fixed code line of the hunk is reachable (deletions are trivially reachable: a delete-line
  operator). A fix is "fully reachable" if every code hunk is; the per-fix number is the honest one, since
  tests only pass when the whole patch is present.
- **Line pairing**: removed and added lines are aligned with `difflib` on identifier-blanked shapes;
  aligned pairs are *modified lines* (the mutation library gets a buggy line to mutate); the rest are
  *inserted lines* (only donors/templates can produce them). Equality is whitespace-insensitive token
  equality.
- **In-scope identifiers**: names used in the enclosing function (via `ast`) + module-level
  def/class/import/assignment names + capitalised names anywhere in the file (classes, constants). Median
  9 names on QuixBugs, 116 on SWE-bench.
- **(a) Mutation operators** (30 operators, token-level, `mutants()` in `coverage_study.py`): relational
  swap, arithmetic/bitwise/augmented-assignment swap, `and`/`or`, off-by-one (`x`→`x ± 1`, `n`→`n ± 1`,
  drop `± 1`), `atom ± <ident>`, index flips (`[0]`↔`[-1]`, `[1:]`↔`[:-1]`, swap or drop a subscript
  component, swap slice bounds), add slice (`x[1:]`, `x[k:]`, `x[i]`), argument/element swap, operand swap,
  add/remove `not`, `is`↔`==`, `in`↔`not in`, constant substitution (pool = literals in file + tests),
  constant→identifier, identifier→constant, identifier substitution (in-scope), attribute substitution
  (attribute names seen in the file), builtin swap table (`any`/`all`, `min`/`max`, `append`/`extend`, …),
  return-value tweaks, range bounds, unwrap single-argument call, drop an additive term, wrap RHS in
  `max`/`min`/`abs`/`list`/…, prepend/append `<ident> +`, add a guard conjunct/disjunct to a condition,
  `** 2`, expression→identifier, `a.update(b)`↔`a = b`, keyword swaps (`break`/`continue`, `if`/`elif`/`while`).
  **Post-hoc** operators added after reading the SWE-bench patches (flagged in every table): qualify a
  name with `self.`/`cls.`/`<scope name>.` or drop the qualifier, drop one comma-separated element, add
  `cls`/`self` as first parameter, comprehension filter (`for x in y` → `for x in y if x`). Depth 2 =
  composition of two operators, excluding substitution∘substitution, capped at 400k mutants per line.
  A **baseline** row reports the 20-regex library from `experiments/anchor-probe.mts`.
- **(b) Donor lines**: index of every code line of every `.py` file at `base_commit` (QuixBugs: the
  program / `python_programs/` / the QuixBugs checkout minus `correct_python_programs`). Levels: verbatim
  in same file / same directory / whole repo; **shape** (all identifiers → `_`, literals kept) present;
  **alpha-renamed** shape present; donor + ≤1 substitution and donor + ≤2 substitutions, where each
  substituted identifier must be an identifier that occurs anywhere in the file (not only the enclosing
  scope) or in the test patch (`scope | file_ids | test_ids` in `analyse_hunk`) and each substituted literal
  must be a literal of the file or the test patch. *Wording corrected 2026-09-20.* Shape-only is an upper bound (the identifiers still have to be
  chosen); 1-sub and 2-sub are concrete generators.
- **(c) Vocabulary**: every NAME token of the fixed line is an identifier of the file, a keyword, a
  builtin or a method of a builtin type; every NUMBER/STRING is a literal of the file (0/1/2/-1/"" always
  allowed). Second column adds identifiers and literals of the test patch (QuixBugs: the JSON test cases).
  Necessary, not sufficient: it says whether the *pieces* exist, not whether any source assembles them.
- **(d) Fix templates** (recognisers that are also generators when their slots can be filled from the
  vocabulary): guard insertion (`if C:` + `return`/`raise`/`continue`), guard condition extension, missing
  import, attribute change / call-target change / identifier change with the new name in scope, add
  parameter with default, add keyword argument, wrap in try/except (bodies must be the old lines or
  `pass`/`raise`/`return`), add `elif`/`else` branch whose body lines exist in the function or file,
  insert a statement that exists verbatim in the function/file, insert `x.append(y)` / `y = x` /
  `return x` with in-scope names, add `return`, wrap value in a call, add call argument. A template is
  counted only if all tokens of the added lines are in the file+tests vocabulary (otherwise it is listed
  as `template_slots_not_in_vocabulary`).
- **Union** = every line reachable by mutation (depth ≤ 2) or donor + ≤ 1 substitution, or the hunk is
  produced by a generative template. "Union (2-sub)" relaxes donors to ≤ 2 substitutions.

## Headline

| | QuixBugs (40 fixes, 40 hunks) | SWE-bench Verified (30 fixes, 106 code hunks) | SWE-bench without `sympy-12489` (29 fixes, 72 hunks) |
| --- | --- | --- | --- |
| Fixes fully reachable, union (mutation d≤2 + donor ≤1 sub + templates) | **40/40 (100%)** | **6/30 (20%)** | 6/29 (21%) |
| Fixes fully reachable, union with donor ≤2 subs | 40/40 | 9/30 (30%) | 9/29 (31%) |
| Hunks reachable, union / union 2-sub | 40/40 | 57/106 (54%) / 65/106 (61%) | 28/72 (39%) / 33/72 (46%) |
| Mutation alone, depth 1 / depth ≤ 2 (hunks) | 34/40 / 36/40 | 35/106 / 35/106 (14/106 without post-hoc ops) | 12/72 (9/72 without post-hoc) |
| Baseline 20-regex library of the anchor probe (modified lines) | 4/36 (11%) | 0/78 (0%) | 0/43 |
| Donor + ≤1 sub / ≤2 subs (hunks) | 9/40 / 13/40 | 32/106 / 51/106 | 20/72 / 28/72 |
| Templates (hunks) | 10/40 | 16/106 | 11/72 |
| Vocabulary ceiling, file / file+tests (fixes with every token available) | 40/40 / 40/40 | 13/30 / 15/30 | 12/29 / 14/29 |
| Depth-1 mutants per buggy line, median (share ≤ 255) | 225 (61%) | 1,641 (3%) | – |

The nine SWE-bench fixes fully reachable under the 2-sub union: `django-15315`, `django-15572`,
`django-16100`, `django-15916`, `pytest-10051`, `pylint-4970`, `pylint-6386`, `requests-1142`,
`requests-2931` (six of them without the 2-sub relaxation: not 16100, 15916, 6386). Reading them: a kept
first element of a hash tuple, two comprehension filters, a `with transaction.atomic(...)` wrapper that
already exists twice in the same file, copy-a-neighbour-with-two-substitutions edits, a guard
`if self.min_lines == 0: return`, a branch whose body is the line that was moved, an unwrapped call plus a
guard. None of them needs a token that is absent from the file and the tests.

What is *not* reachable on SWE-bench splits into three groups, visible in the per-hunk rows:

1. **New logic** (5–24 fixed code lines per instance, 2–18 of them insertions: `sympy-11618`,
   `sympy-13798` except bodies, `sympy-19954`, `django-15563`, `pytest-10356`, `sympy-16792`): 121 of the
   199 fixed code lines are insertions; 58% of them are a donor line with ≤2 substitutions, but a hunk needs
   *all* its lines, and multi-line-modification hunks are reachable 3/20 (union) and 6/20 (2-sub union);
   even the donor-shape upper bound reaches only 10/20. *Corrected 2026-09-20: the original text said
   "11–30 new lines" and "7/20 at best"; the JSON gives 6/20 for the 2-sub union.*
2. **New names**: the most frequent missing tokens are names the fix invents (`blocks_remove_mask`,
   `related_ids_index`, `exclude`, `coalesce`, `IDENT_PREFIX`, `mark_lists`, `edit_only`, `metavar`).
   Vocabulary from file+tests covers 15/30 fixes; the other 15 need at least one token from the issue text
   or from the wider API (`is_real`, `is_zero`, `saferepr`, `PRECEDENCE`, `__mro__`).
3. **Idiom changes on one line** that no local operator expresses (`f.ex != 0` → `not f.ex.is_zero`;
   `partial(...)` → `wraps(method)(partial(...))`; `*self.args` → `*[i.evalf(prec) for i in self.args]`).

## Tables (generated by `experiments/coverage-study/make_report.py`)

### QuixBugs (40 programs): hunk classification

| Kind | Hunks | Reachable by union (a+b1+d) | by union with 2-sub donors |
| --- | --- | --- | --- |
| single_line_modification | 36 | 36/36 (100%) | 36/36 (100%) |
| pure_insertion | 4 | 4/4 (100%) | 4/4 (100%) |
| total | 40 | 40/40 (100%) | 40/40 (100%) |

### QuixBugs (40 programs): coverage by source

Hunks = contiguous runs of changed code lines (non-code-only runs excluded); n_hunks = 40, n_fixes = 40.

| Source | Hunks reachable | Fixes fully reachable (every hunk) | Fixes with >= 1 hunk reachable |
| --- | --- | --- | --- |
| (a) mutation, depth 1 | 34/40 (85%) | 34/40 (85%) | 34/40 (85%) |
| (a) mutation, depth <= 2 | 36/40 (90%) | 36/40 (90%) | 36/40 (90%) |
| (a) mutation, depth <= 2, without post-hoc ops | 36/40 (90%) | 36/40 (90%) | 36/40 (90%) |
| (b) donor verbatim, whole repo | 1/40 (2%) | 1/40 (2%) | 1/40 (2%) |
| (b) donor + <= 1 substitution | 9/40 (22%) | 9/40 (22%) | 9/40 (22%) |
| (b) donor + <= 2 substitutions | 13/40 (32%) | 13/40 (32%) | 13/40 (32%) |
| (b) donor shape only (upper bound, identifiers still to fill) | 14/40 (35%) | 14/40 (35%) | 14/40 (35%) |
| (d) fix template (generative) | 10/40 (25%) | 10/40 (25%) | 10/40 (25%) |
| union (a) d<=2 + (b) <= 1 sub + (d) | 40/40 (100%) | 40/40 (100%) | 40/40 (100%) |
| union with (b) <= 2 subs | 40/40 (100%) | 40/40 (100%) | 40/40 (100%) |
| (c) vocabulary: file only (necessary condition) | 40/40 (100%) | 40/40 (100%) | 40/40 (100%) |
| (c) vocabulary: file + tests | 40/40 (100%) | 40/40 (100%) | 40/40 (100%) |

### QuixBugs (40 programs): line-level coverage (fixed code lines)

40 fixed code lines: 36 paired with a buggy line (modifications), 4 insertions (no buggy line to mutate).

| Source | Modified lines | Inserted lines | All lines |
| --- | --- | --- | --- |
| mutation depth 1 | 34/36 (94%) | 0/4 (0%) | 34/40 (85%) |
| mutation depth <= 2 | 36/36 (100%) | 0/4 (0%) | 36/40 (90%) |
| mutation depth <= 2, no post-hoc ops | 36/36 (100%) | 0/4 (0%) | 36/40 (90%) |
| baseline 20-regex library (anchor probe) | 4/36 (11%) | 0/4 (0%) | 4/40 (10%) |
| donor verbatim, same file | 0/36 (0%) | 0/4 (0%) | 0/40 (0%) |
| donor verbatim, same package | 1/36 (3%) | 0/4 (0%) | 1/40 (2%) |
| donor verbatim, whole repo | 1/36 (3%) | 0/4 (0%) | 1/40 (2%) |
| donor + <= 1 substitution (repo) | 6/36 (17%) | 3/4 (75%) | 9/40 (22%) |
| donor + <= 2 substitutions (repo) | 9/36 (25%) | 4/4 (100%) | 13/40 (32%) |
| donor shape (identifiers blanked), same file | 8/36 (22%) | 3/4 (75%) | 11/40 (28%) |
| donor shape, whole repo | 10/36 (28%) | 4/4 (100%) | 14/40 (35%) |
| alpha-renamed shape, whole repo | 9/36 (25%) | 4/4 (100%) | 13/40 (32%) |
| union: mutation d<=2 or donor <= 1 sub | 36/36 (100%) | 3/4 (75%) | 39/40 (98%) |
| union: mutation d<=2 or donor <= 2 subs | 36/36 (100%) | 4/4 (100%) | 40/40 (100%) |
| vocabulary: all tokens in file | 36/36 (100%) | 4/4 (100%) | 40/40 (100%) |
| vocabulary: all tokens in file + tests | 36/36 (100%) | 4/4 (100%) | 40/40 (100%) |

### QuixBugs (40 programs): candidate-set sizes

- depth-1 mutants per buggy line: median 225, p90 381, max 777; lines with <= 255 mutants: 22/36 (61%)
- depth-2 mutants explored (lines where depth 1 missed): median 4995, max 9761, n = 2
- in-scope identifiers per hunk (enclosing function + module-level names + capitalised file names): median 9, max 20

### QuixBugs (40 programs): operators ranked by marginal coverage (depth-1 hits, greedy set cover over 34 lines)

| Rank | Operator | Marginal lines | Total lines it produces | Lines only it produces | Post-hoc? |
| --- | --- | --- | --- | --- | --- |
| 1 | `off_by_one` | 4 | 4 | 3 |  |
| 2 | `arg_swap` | 3 | 3 | 2 |  |
| 3 | `rel_swap` | 3 | 3 | 3 |  |
| 4 | `add_guard_cond` | 2 | 2 | 2 |  |
| 5 | `add_slice` | 2 | 2 | 2 |  |
| 6 | `const_to_ident` | 2 | 2 | 2 |  |
| 7 | `expr_to_ident` | 2 | 2 | 1 |  |
| 8 | `ident_sub` | 2 | 2 | 2 |  |
| 9 | `operand_swap` | 2 | 2 | 2 |  |
| 10 | `return_tweak` | 2 | 2 | 1 |  |
| 11 | `wrap_minmax` | 2 | 2 | 2 |  |
| 12 | `arith_ident` | 1 | 1 | 1 |  |
| 13 | `attr_sub` | 1 | 1 | 1 |  |
| 14 | `augassign_swap` | 1 | 1 | 1 |  |
| 15 | `builtin_swap` | 1 | 1 | 1 |  |
| 16 | `call_to_assign` | 1 | 1 | 1 |  |
| 17 | `drop_term` | 1 | 1 | 1 |  |
| 18 | `exponent` | 1 | 1 | 1 |  |
| 19 | `prepend_term` | 1 | 1 | 1 |  |

Depth-2 compositions that hit: `rel_swap > off_by_one`; `drop_element index_flip > ident_sub`

### QuixBugs (40 programs): templates (recognisers) by hunks matched

| Template | Hunks matched | of which counted generative | Hunks only templates reach (not mutation/donor) |
| --- | --- | --- | --- |
| `operator_change` | 4 | 0 | 0 |
| `identifier_change` | 3 | 3 | 0 |
| `identifier_change_in_scope` | 3 | 3 | 0 |
| `insert_method_call_scope` | 3 | 3 | 0 |
| `guard_extend_condition` | 2 | 2 | 0 |
| `insert_assign_scope` | 1 | 1 | 1 |
| `call_target_change` | 1 | 0 | 0 |
| `attribute_change` | 1 | 1 | 0 |
| `attribute_change_in_scope` | 1 | 1 | 0 |

### SWE-bench Verified (30 instances): hunk classification

| Kind | Hunks | Reachable by union (a+b1+d) | by union with 2-sub donors |
| --- | --- | --- | --- |
| single_line_modification | 52 | 37/52 (71%) | 39/52 (75%) |
| multi_line_modification | 20 | 3/20 (15%) | 6/20 (30%) |
| pure_insertion | 27 | 11/27 (41%) | 14/27 (52%) |
| deletion | 5 | 5/5 (100%) | 5/5 (100%) |
| new_function | 2 | 1/2 (50%) | 1/2 (50%) |
| non_code_only | 9 | 9/9 (100%) | 9/9 (100%) |
| total | 115 | 66/115 (57%) | 74/115 (64%) |

### SWE-bench Verified (30 instances): coverage by source

Hunks = contiguous runs of changed code lines (non-code-only runs excluded); n_hunks = 106, n_fixes = 30.

| Source | Hunks reachable | Fixes fully reachable (every hunk) | Fixes with >= 1 hunk reachable |
| --- | --- | --- | --- |
| (a) mutation, depth 1 | 35/106 (33%) | 1/30 (3%) | 10/30 (33%) |
| (a) mutation, depth <= 2 | 35/106 (33%) | 1/30 (3%) | 10/30 (33%) |
| (a) mutation, depth <= 2, without post-hoc ops | 14/106 (13%) | 0/30 (0%) | 10/30 (33%) |
| (b) donor verbatim, whole repo | 12/106 (11%) | 0/30 (0%) | 10/30 (33%) |
| (b) donor + <= 1 substitution | 32/106 (30%) | 2/30 (7%) | 13/30 (43%) |
| (b) donor + <= 2 substitutions | 51/106 (48%) | 5/30 (17%) | 17/30 (57%) |
| (b) donor shape only (upper bound, identifiers still to fill) | 64/106 (60%) | 6/30 (20%) | 20/30 (67%) |
| (d) fix template (generative) | 16/106 (15%) | 1/30 (3%) | 9/30 (30%) |
| union (a) d<=2 + (b) <= 1 sub + (d) | 57/106 (54%) | 6/30 (20%) | 16/30 (53%) |
| union with (b) <= 2 subs | 65/106 (61%) | 9/30 (30%) | 18/30 (60%) |
| (c) vocabulary: file only (necessary condition) | 69/106 (65%) | 13/30 (43%) | 19/30 (63%) |
| (c) vocabulary: file + tests | 76/106 (72%) | 15/30 (50%) | 21/30 (70%) |

### SWE-bench Verified (30 instances): line-level coverage (fixed code lines)

199 fixed code lines: 78 paired with a buggy line (modifications), 121 insertions (no buggy line to mutate).

| Source | Modified lines | Inserted lines | All lines |
| --- | --- | --- | --- |
| mutation depth 1 | 33/78 (42%) | 0/121 (0%) | 33/199 (17%) |
| mutation depth <= 2 | 33/78 (42%) | 0/121 (0%) | 33/199 (17%) |
| mutation depth <= 2, no post-hoc ops | 10/78 (13%) | 0/121 (0%) | 10/199 (5%) |
| baseline 20-regex library (anchor probe) | 0/78 (0%) | 0/121 (0%) | 0/199 (0%) |
| donor verbatim, same file | 4/78 (5%) | 31/121 (26%) | 35/199 (18%) |
| donor verbatim, same package | 5/78 (6%) | 35/121 (29%) | 40/199 (20%) |
| donor verbatim, whole repo | 5/78 (6%) | 38/121 (31%) | 43/199 (22%) |
| donor + <= 1 substitution (repo) | 24/78 (31%) | 58/121 (48%) | 82/199 (41%) |
| donor + <= 2 substitutions (repo) | 39/78 (50%) | 70/121 (58%) | 109/199 (55%) |
| donor shape (identifiers blanked), same file | 37/78 (47%) | 62/121 (51%) | 99/199 (50%) |
| donor shape, whole repo | 58/78 (74%) | 81/121 (67%) | 139/199 (70%) |
| alpha-renamed shape, whole repo | 55/78 (71%) | 81/121 (67%) | 136/199 (68%) |
| union: mutation d<=2 or donor <= 1 sub | 46/78 (59%) | 58/121 (48%) | 104/199 (52%) |
| union: mutation d<=2 or donor <= 2 subs | 52/78 (67%) | 70/121 (58%) | 122/199 (61%) |
| vocabulary: all tokens in file | 61/78 (78%) | 74/121 (61%) | 135/199 (68%) |
| vocabulary: all tokens in file + tests | 62/78 (79%) | 82/121 (68%) | 144/199 (72%) |

### SWE-bench Verified (30 instances): candidate-set sizes

- depth-1 mutants per buggy line: median 1641, p90 2919, max 8083; lines with <= 255 mutants: 2/78 (3%)
- depth-2 mutants explored (lines where depth 1 missed): median 399056, max 400001, n = 45
- in-scope identifiers per hunk (enclosing function + module-level names + capitalised file names): median 116, max 321

### SWE-bench Verified (30 instances): operators ranked by marginal coverage (depth-1 hits, greedy set cover over 33 lines)

| Rank | Operator | Marginal lines | Total lines it produces | Lines only it produces | Post-hoc? |
| --- | --- | --- | --- | --- | --- |
| 1 | `qualify_name` | 19 | 19 | 19 | yes |
| 2 | `ident_sub` | 5 | 5 | 5 |  |
| 3 | `add_first_param` | 2 | 2 | 2 | yes |
| 4 | `return_tweak` | 2 | 2 | 0 |  |
| 5 | `add_guard_cond` | 1 | 1 | 1 |  |
| 6 | `attr_sub` | 1 | 1 | 1 |  |
| 7 | `comp_filter` | 1 | 1 | 1 | yes |
| 8 | `const_sub` | 1 | 1 | 1 |  |
| 9 | `drop_element` | 1 | 1 | 1 | yes |

### SWE-bench Verified (30 instances): templates (recognisers) by hunks matched

| Template | Hunks matched | of which counted generative | Hunks only templates reach (not mutation/donor) |
| --- | --- | --- | --- |
| `identifier_change` | 11 | 4 | 0 |
| `template_slots_not_in_vocabulary` | 5 | 0 | 0 |
| `delete_lines` | 5 | 0 | 0 |
| `signature_change` | 5 | 0 | 0 |
| `identifier_change_in_scope` | 4 | 4 | 0 |
| `guard_insertion` | 3 | 2 | 2 |
| `call_target_change` | 3 | 3 | 0 |
| `call_target_change_in_scope` | 3 | 3 | 0 |
| `add_parameter_default` | 3 | 2 | 2 |
| `new_function` | 2 | 0 | 0 |
| `missing_import` | 2 | 0 | 0 |
| `insert_copy_from_function` | 2 | 2 | 0 |
| `wrap_try_except_new_body` | 1 | 0 | 0 |
| `import_change` | 1 | 0 | 0 |
| `prefix_value` | 1 | 0 | 0 |
| `guard_extend_condition` | 1 | 1 | 0 |
| `insert_copy_from_file` | 1 | 1 | 0 |
| `literal_change` | 1 | 0 | 0 |
| `add_branch_copy` | 1 | 1 | 1 |

### QuixBugs: per-program rows

| Program | Kind | Buggy -> fixed line | Mutation (depth, ops) | n mutants d1 | Baseline 20-regex | Donor (file/pkg/repo verbatim; 1-sub; shape) | Vocab in file | Templates | Union |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | single_line_modification | `n ^= n - 1` -> `n &= n - 1` | d1 augassign_swap | 101 | n | n/n/n; n; n | Y | operator_change | Y |
| breadth_first_search | single_line_modification | `while True:` -> `while queue:` | d1 const_to_ident | 41 | n | n/n/n; Y; Y | Y | identifier_change, identifier_change_in_scope | Y |
| bucketsort | single_line_modification | `for i, count in enumerate(arr):` -> `for i, count in enumerate(counts):` | d1 ident_sub | 273 | n | n/n/n; Y; Y | Y | identifier_change, identifier_change_in_scope | Y |
| depth_first_search | pure_insertion | `(insertion)` -> `nodesvisited.add(node)` | - | 0 | n | n/n/n; Y; Y | Y | insert_method_call_scope | Y |
| detect_cycle | single_line_modification | `if hare.successor is None:` -> `if hare is None or hare.successor is None:` | d1 add_guard_cond | 62 | n | n/n/n; n; n | Y | guard_extend_condition | Y |
| find_first_in_sorted | single_line_modification | `while lo <= hi:` -> `while lo < hi:` | d1 rel_swap | 154 | Y | n/n/n; n; n | Y | operator_change | Y |
| find_in_sorted | single_line_modification | `return binsearch(mid, end)` -> `return binsearch(mid + 1, end)` | d1 off_by_one | 205 | n | n/n/n; n; n | Y | - | Y |
| flatten | single_line_modification | `yield flatten(x)` -> `yield x` | d1 expr_to_ident unwrap_call | 105 | n | n/n/n; Y; Y | Y | - | Y |
| gcd | single_line_modification | `return gcd(a % b, b)` -> `return gcd(b, a % b)` | d1 arg_swap | 157 | Y | n/n/n; n; n | Y | - | Y |
| get_factors | single_line_modification | `return []` -> `return [n]` | d1 const_to_ident | 57 | n | n/n/n; n; n | Y | - | Y |
| hanoi | single_line_modification | `steps.append((start, helper))` -> `steps.append((start, end))` | d1 ident_sub | 180 | n | n/n/n; Y; Y | Y | identifier_change, identifier_change_in_scope | Y |
| is_valid_parenthesization | single_line_modification | `return True` -> `return depth == 0` | d1 return_tweak | 53 | n | n/n/n; n; n | Y | - | Y |
| kheapsort | single_line_modification | `for x in arr:` -> `for x in arr[k:]:` | d1 add_slice | 142 | n | n/n/n; n; n | Y | - | Y |
| knapsack | single_line_modification | `if weight < j:` -> `if weight <= j:` | d1 rel_swap | 239 | Y | n/n/n; n; n | Y | operator_change | Y |
| kth | single_line_modification | `return kth(above, k)` -> `return kth(above, k - num_lessoreq)` | d1 arith_ident | 268 | n | n/n/n; n; n | Y | - | Y |
| lcs_length | single_line_modification | `dp[i, j] = dp[i - 1, j] + 1` -> `dp[i, j] = dp[i - 1, j - 1] + 1` | d1 off_by_one | 606 | n | n/n/n; n; n | Y | - | Y |
| levenshtein | single_line_modification | `return 1 + levenshtein(source[1:], target[1:])` -> `return levenshtein(source[1:], target[1:])` | d1 drop_term | 247 | n | n/n/n; n; n | Y | - | Y |
| lis | single_line_modification | `longest = length + 1` -> `longest = max(longest, length + 1)` | d1 wrap_minmax | 206 | n | n/n/n; n; n | Y | - | Y |
| longest_common_subsequence | single_line_modification | `return a[0] + longest_common_subsequence(a[1:], b)` -> `return a[0] + longest_common_subsequence(a[1:], b[1:])` | d1 add_slice | 307 | n | n/n/n; n; n | Y | - | Y |
| max_sublist_sum | single_line_modification | `max_ending_here = max_ending_here + x` -> `max_ending_here = max(0, max_ending_here + x)` | d1 wrap_minmax | 148 | n | n/n/n; n; n | Y | - | Y |
| mergesort | single_line_modification | `if len(arr) == 0:` -> `if len(arr) <= 1:` | d2 rel_swap > off_by_one | 226 | n | n/n/n; n; n | Y | - | Y |
| minimum_spanning_tree | single_line_modification | `group_by_node[node].update(group_by_node[u])` -> `group_by_node[node] = group_by_node[u]` | d1 call_to_assign | 388 | n | n/n/n; n; n | Y | - | Y |
| next_palindrome | single_line_modification | `return [1] + (len(digit_list)) * [0] + [1]` -> `return [1] + (len(digit_list) - 1) * [0] + [1]` | d1 off_by_one | 207 | n | n/n/n; n; n | Y | - | Y |
| next_permutation | single_line_modification | `if perm[j] < perm[i]:` -> `if perm[i] < perm[j]:` | d1 operand_swap | 275 | n | n/n/n; n; Y | Y | - | Y |
| pascal | single_line_modification | `for c in range(0, r):` -> `for c in range(0, r + 1):` | d1 off_by_one range_bounds | 225 | n | n/n/n; n; n | Y | - | Y |
| possible_change | single_line_modification | `if total < 0:` -> `if total < 0 or not coins:` | d1 add_guard_cond | 106 | n | n/n/n; n; n | Y | guard_extend_condition | Y |
| powerset | single_line_modification | `return [[first] + subset for subset in rest_subsets]` -> `return rest_subsets + [[first] + subset for subset in rest_subsets]` | d1 prepend_term | 277 | n | n/n/n; n; n | Y | - | Y |
| quicksort | single_line_modification | `greater = quicksort([x for x in arr[1:] if x > pivot])` -> `greater = quicksort([x for x in arr[1:] if x >= pivot])` | d1 rel_swap | 355 | Y | n/n/n; n; n | Y | operator_change | Y |
| reverse_linked_list | pure_insertion | `(insertion)` -> `prevnode = node` | - | 0 | n | n/n/n; n; Y | Y | insert_assign_scope | Y |
| rpn_eval | single_line_modification | `op(token, a, b)` -> `op(token, b, a)` | d1 arg_swap | 328 | n | n/n/n; n; Y | Y | - | Y |
| shortest_path_length | single_line_modification | `get(unvisited_nodes, nextnode) + length_by_edge[node, nextnode]` -> `distance + length_by_edge[node, nextnode]` | d1 expr_to_ident | 777 | n | n/n/n; n; n | Y | - | Y |
| shortest_path_lengths | single_line_modification | `length_by_path[i, k] + length_by_path[j, k]` -> `length_by_path[i, k] + length_by_path[k, j]` | d1 arg_swap index_flip | 515 | n | n/n/n; n; Y | Y | - | Y |
| shortest_paths | single_line_modification | `weight_by_edge[u, v] = min(` -> `weight_by_node[v] = min(` | d2 drop_element index_flip > ident_sub | 359 | n | n/n/n; n; n | Y | - | Y |
| shunting_yard | pure_insertion | `(insertion)` -> `opstack.append(token)` | - | 0 | n | n/n/n; Y; Y | Y | insert_method_call_scope | Y |
| sieve | single_line_modification | `if any(n % p > 0 for p in primes):` -> `if all(n % p > 0 for p in primes):` | d1 builtin_swap | 381 | n | n/n/n; n; Y | Y | call_target_change | Y |
| sqrt | single_line_modification | `while abs(x - approx) > epsilon:` -> `while abs(x - approx ** 2) > epsilon:` | d1 exponent | 202 | n | n/n/n; n; n | Y | - | Y |
| subsequences | single_line_modification | `return []` -> `return [[]]` | d1 const_sub return_tweak | 81 | n | n/Y/Y; Y; Y | Y | - | Y |
| to_base | single_line_modification | `result = result + alphabet[i]` -> `result = alphabet[i] + result` | d1 operand_swap | 247 | n | n/n/n; n; n | Y | - | Y |
| topological_ordering | single_line_modification | `if set(ordered_nodes).issuperset(nextnode.outgoing_nodes) and nextnode not in ordered_nodes:` -> `if set(ordered_nodes).issuperset(nextnode.incoming_nodes) and nextnode not in ordered_nodes:` | d1 attr_sub | 370 | n | n/n/n; Y; Y | Y | attribute_change, attribute_change_in_scope | Y |
| wrap | pure_insertion | `(insertion)` -> `lines.append(text)` | - | 0 | n | n/n/n; Y; Y | Y | insert_method_call_scope | Y |

### SWE-bench: per-instance rows

| Instance | Hunks (code) | Kinds | Fixed code lines (mod / ins) | Reach: mut d<=2 | donor <=1 sub | donor <=2 sub | template | union | union (2-sub) | vocab file / +tests | What the fix is |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | 1 | 1 single line | 1 / 0 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 / 1/1 | replace `*self.args` by `*[i.evalf(prec) for i in self.args]`: needs a new comprehension |
| sympy__sympy-15345 | 2 | 2 pure insertion | 0 / 3 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 / 0/2 | two dict entries copying a neighbour with new keys `Max`/`Min` (names in the issue), plus alias `_print_MinMaxBase = _print_Function` |
| sympy__sympy-17139 | 1 | 1 pure insertion | 0 / 2 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 / 0/1 | guard `if not rv.exp.is_real: return rv` copying the `return rv` two lines above |
| sympy__sympy-19954 | 3 | 1 single line, 2 multi line | 3 / 2 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 / 0/3 | rewrite of a filter loop with a new mask variable; three list comprehensions |
| sympy__sympy-11618 | 1 | 1 pure insertion | 0 / 11 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 / 1/1 | 14 new lines: dimension-padding branch with new arithmetic |
| sympy__sympy-13798 | 1 | 1 multi line | 0 / 13 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 / 0/1 | wrap two assignments in try/except KeyError with new fallback bodies (7 new lines) |
| sympy__sympy-16792 | 4 | 1 new function, 1 deletion, 2 multi line | 2 / 6 | 1/4 | 1/4 | 1/4 | 0/4 | 1/4 | 1/4 | 4/4 / 4/4 | extract helper `dimensions()`, inline it twice, new isinstance branch (refactor) |
| sympy__sympy-20428 | 1 | 1 single line | 1 / 0 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 / 0/1 | `return f.ex != 0` -> `return not f.ex.is_zero` (idiom change: comparison -> property) |
| sympy__sympy-22080 | 3 | 1 single line, 1 multi line, 1 pure insertion | 1 / 4 | 0/3 | 1/3 | 1/3 | 0/3 | 1/3 | 1/3 | 0/3 / 0/3 | extend an import, new if/else branch with a new expression, one dict entry copying a neighbour (`"Mod"` from the issue) |
| sympy__sympy-12489 | 34 | 30 single line, 1 deletion, 3 multi line | 35 / 2 | 23/34 | 12/34 | 23/34 | 5/34 | 29/34 | 32/34 | 34/34 / 34/34 | 42-line staticmethod->classmethod refactor: 30+ near-identical `_af_new(` -> `self._af_new(`/`cls._af_new(` edits, `Perm` -> `cls`, decorator swaps |
| django__django-14787 | 1 | 1 single line | 1 / 0 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 / 1/1 | wrap value: `partial(...)` -> `wraps(method)(partial(...))` (`wraps` already imported) |
| django__django-15315 | 1 | 1 multi line | 1 / 0 | 0/1 | 1/1 | 1/1 | 0/1 | 1/1 | 1/1 | 1/1 / 1/1 | replace a 5-line tuple hash by `return hash(self.creation_counter)` (keep first element) |
| django__django-15572 | 2 | 2 single line | 2 / 0 | 2/2 | 0/2 | 0/2 | 1/2 | 2/2 | 2/2 | 2/2 / 2/2 | add a truthiness filter to two comprehensions (`if dir`, `directory and ...`) |
| django__django-16100 | 1 | 1 multi line | 1 / 3 | 0/1 | 0/1 | 1/1 | 0/1 | 0/1 | 1/1 | 1/1 / 1/1 | wrap an 8-line loop in `with transaction.atomic(using=router.db_for_write(self.model)):` (line exists twice in the file) + black re-wrap of one call |
| django__django-14725 | 5 | 3 multi line, 2 pure insertion | 2 / 7 | 0/5 | 0/5 | 1/5 | 0/5 | 0/5 | 1/5 | 0/5 / 4/5 | feature: thread a new `edit_only=False` parameter through two factories, a class attribute, a kwargs dict, and an if/else around the return |
| django__django-15103 | 3 | 2 single line, 1 multi line | 6 / 3 | 0/3 | 0/3 | 2/3 | 2/3 | 2/3 | 2/3 | 2/3 / 2/3 | `element_id=None` default in two signatures + if/else choosing between two template strings (one new literal) |
| django__django-15375 | 1 | 1 multi line | 1 / 2 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 / 0/1 | extract call to a variable, set `coalesce.is_summary = c.is_summary`, return it (3 lines) |
| django__django-15563 | 5 | 1 multi line, 2 pure insertion, 2 single line | 3 / 14 | 1/5 | 1/5 | 1/5 | 1/5 | 1/5 | 1/5 | 2/5 / 2/5 | 20 new lines of MTI logic in compiler.py; one-line `self.related_ids` -> `self.related_ids[model]` in subqueries.py |
| django__django-15916 | 4 | 1 pure insertion, 1 deletion, 2 single line | 2 / 1 | 3/4 | 2/4 | 3/4 | 0/4 | 3/4 | 4/4 | 4/4 / 4/4 | delete a 7-line lookup, add `self.formfield_callback = getattr(options, "formfield_callback", None)` (copy of the line above with two substitutions), qualify `formfield_callback` with `opts.`, drop a dict entry |
| django__django-15128 | 6 | 2 pure insertion, 1 deletion, 2 single line, 1 multi line | 3 / 5 | 1/6 | 1/6 | 1/6 | 0/6 | 1/6 | 1/6 | 1/6 / 1/6 | two new statements, rename a parameter and add `exclude=None`, `if exclude is None: exclude = {}` guard, comprehension filter, docstring edits |
| pytest-dev__pytest-10081 | 1 | 1 multi line | 1 / 2 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 / 1/1 | assert + new local `skipped = _is_skipped(self.obj) or _is_skipped(self.parent.obj)` + use it in the condition |
| pytest-dev__pytest-7205 | 2 | 1 pure insertion, 1 single line | 1 / 1 | 0/2 | 1/2 | 1/2 | 0/2 | 1/2 | 1/2 | 0/2 / 0/2 | missing import (line exists verbatim in two other files) + wrap an argument in `saferepr(x, maxsize=42)` |
| pytest-dev__pytest-10051 | 2 | 1 new function, 1 single line | 1 / 3 | 1/2 | 2/2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 / 2/2 | new 3-line method `clear()` (bodies copy neighbours) + call-target change `reset` -> `clear`; one blank line removed |
| pytest-dev__pytest-7324 | 3 | 1 pure insertion, 2 single line | 2 / 1 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 / 0/3 | new module constant `IDENT_PREFIX = "$"`, prefix an expression with it, slice by `len(IDENT_PREFIX):` |
| pytest-dev__pytest-10356 | 2 | 1 multi line, 1 single line | 6 / 18 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 / 1/2 | 30-line rewrite of `get_unpacked_marks` with a new keyword-only parameter; one call site gains `consider_mro=False` |
| pylint-dev__pylint-4970 | 1 | 1 pure insertion | 0 / 2 | 0/1 | 0/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 / 1/1 | guard insertion `if self.min_lines == 0: return` |
| pylint-dev__pylint-4604 | 3 | 3 pure insertion | 0 / 5 | 0/3 | 1/3 | 2/3 | 0/3 | 1/3 | 2/3 | 1/3 / 1/3 | 3-line isinstance branch copying the structure of the branch above (Attribute instead of Name) + unrelated `import platform` / `IS_PYPY` constant |
| pylint-dev__pylint-6386 | 8 | 7 pure insertion, 1 single line | 1 / 7 | 1/8 | 7/8 | 8/8 | 3/8 | 7/8 | 8/8 | 7/8 / 8/8 | thread a new `metavar` parameter through 4 files: each added line copies a neighbouring line with 1-2 substitutions; one literal change `"--"` -> `"-"` |
| psf__requests-1142 | 2 | 1 deletion, 1 pure insertion | 0 / 2 | 1/2 | 1/2 | 1/2 | 1/2 | 2/2 | 2/2 | 1/2 / 2/2 | move `self.headers['Content-Length'] = '0'` from the top of the function into a new `elif self.method not in ('GET', 'HEAD'):` branch |
| psf__requests-2931 | 2 | 1 single line, 1 pure insertion | 1 / 2 | 1/2 | 1/2 | 1/2 | 1/2 | 2/2 | 2/2 | 2/2 / 2/2 | `return to_native_string(data)` -> `return data` (unwrap call) + 2-line guard converting `params` with the same call |

### SWE-bench: per-hunk rows

| Instance | File:line | Kind | -/+ code lines | Mutation | Donor min subs (per line) | Templates | Union | Sample fixed line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | function.py:510 | single_line_modification | 1/1 | - | - | - | n | `return Float(self._imp_(*[i.evalf(prec) for i in self.args]), prec)` |
| sympy__sympy-15345 | mathematica.py:34 | pure_insertion | 0/2 | -,- | -,- | - | n | `"Max": [(lambda *x: True, "Max")],` |
| sympy__sympy-15345 | mathematica.py:104 | pure_insertion | 0/1 | - | - | - | n | `_print_MinMaxBase = _print_Function` |
| sympy__sympy-17139 | fu.py:503 | pure_insertion | 0/2 | -,- | -,0 | guard_insertion, template_slots_not_in_vocabulary | n | `if not rv.exp.is_real:` |
| sympy__sympy-19954 | perm_groups.py:2197 | single_line_modification | 1/1 | - | - | - | n | `blocks_remove_mask = [False] * len(blocks)` |
| sympy__sympy-19954 | perm_groups.py:2201 | multi_line_modification | 2/1 | - | - | - | n | `blocks_remove_mask[i] = True` |
| sympy__sympy-19954 | perm_groups.py:2208 | multi_line_modification | 1/3 | -,-,- | -,-,- | - | n | `blocks = [b for i, b in enumerate(blocks) if not blocks_remove_mask[i]` |
| sympy__sympy-11618 | point.py:269 | pure_insertion | 0/11 | -,-,-,-,-,-,-,-,-,-,- | 2,2,0,0,0,-,-,-,-,0,- | - | n | `if type(p) is not type(self):` |
| sympy__sympy-13798 | latex.py:158 | multi_line_modification | 4/17 | -,-,-,-,-,-,-,-,-,-,-,-,- | 0,0,0,3,0,0,-,-,0,2,0,0,3 | wrap_try_except_new_body | n | `try:` |
| sympy__sympy-16792 | codegen.py:698 | new_function | 0/2 | -,- | 1,- | new_function | n | `def dimensions(s):` |
| sympy__sympy-16792 | codegen.py:706 | deletion | 1/0 | - | - | delete_lines | Y | `` |
| sympy__sympy-16792 | codegen.py:708 | multi_line_modification | 3/1 | - | 4 | - | n | `metadata = {'dimensions': dimensions(array)}` |
| sympy__sympy-16792 | codegen.py:742 | multi_line_modification | 1/5 | -,-,-,-,- | 3,4,0,0,1 | - | n | `if isinstance(symbol, (IndexedBase, MatrixSymbol)):` |
| sympy__sympy-20428 | expressiondomain.py:123 | single_line_modification | 1/1 | - | - | - | n | `return not f.ex.is_zero` |
| sympy__sympy-22080 | codeprinter.py:12 | single_line_modification | 1/1 | - | 0 | import_change, template_slots_not_in_vocabulary | Y | `from sympy.printing.precedence import precedence, PRECEDENCE` |
| sympy__sympy-22080 | codeprinter.py:490 | multi_line_modification | 1/4 | -,-,- | 3,-,0 | - | n | `if len(a) == 1 and sign == "-":` |
| sympy__sympy-22080 | precedence.py:43 | pure_insertion | 0/1 | - | - | - | n | `"Mod": PRECEDENCE["Mul"],` |
| sympy__sympy-12489 | permutations.py:860 | single_line_modification | 1/1 | d1 | - | - | Y | `return cls._af_new(list(range(size or 0)))` |
| sympy__sympy-12489 | permutations.py:862 | single_line_modification | 1/1 | d1 | - | - | Y | `return cls._af_new(Cycle(*args).list(size))` |
| sympy__sympy-12489 | permutations.py:865 | single_line_modification | 1/1 | d1 | 1 | identifier_change, identifier_change_in_scope | Y | `if isinstance(a, cls):  # g` |
| sympy__sympy-12489 | permutations.py:868 | single_line_modification | 1/1 | d1 | 1 | call_target_change, call_target_change_in_scope | Y | `return cls(a.array_form, size=size)` |
| sympy__sympy-12489 | permutations.py:870 | single_line_modification | 1/1 | d1 | 5 | - | Y | `return cls._af_new(a.list(size))` |
| sympy__sympy-12489 | permutations.py:872 | single_line_modification | 1/1 | d1 | - | - | Y | `return cls._af_new(list(range(a + 1)))` |
| sympy__sympy-12489 | permutations.py:921 | deletion | 5/0 | - | - | delete_lines | Y | `` |
| sympy__sympy-12489 | permutations.py:927 | multi_line_modification | 2/3 | -,-,d1 | 2,0,2 | - | 2sub | `return cls._af_new(aform)` |
| sympy__sympy-12489 | permutations.py:947 | single_line_modification | 1/1 | - | 1 | identifier_change | Y | `p = Basic.__new__(cls, perm)` |
| sympy__sympy-12489 | permutations.py:1162 | single_line_modification | 1/1 | d1 | 1 | identifier_change, identifier_change_in_scope | Y | `rv = self.unrank_lex(self.size, rank)` |
| sympy__sympy-12489 | permutations.py:1222 | multi_line_modification | 2/2 | -,d1 | 0,1 | - | Y | `@classmethod` |
| sympy__sympy-12489 | permutations.py:1229 | single_line_modification | 1/1 | d1 | - | prefix_value | Y | `rv = cls._af_new(_af_rmuln(*a))` |
| sympy__sympy-12489 | permutations.py:1238 | single_line_modification | 1/1 | d1 | 3 | - | Y | `return self._af_new(_af_rmul(a, b))` |
| sympy__sympy-12489 | permutations.py:1241 | multi_line_modification | 1/2 | -,- | 1,1 | - | Y | `cls = type(self)` |
| sympy__sympy-12489 | permutations.py:1303 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return self._af_new(perm)` |
| sympy__sympy-12489 | permutations.py:1340 | single_line_modification | 1/1 | - | 1 | - | Y | `if isinstance(n, Permutation):` |
| sympy__sympy-12489 | permutations.py:1344 | single_line_modification | 1/1 | d1 | 4 | - | Y | `return self._af_new(_af_pow(self.array_form, n))` |
| sympy__sympy-12489 | permutations.py:1439 | single_line_modification | 1/1 | d1 | 1 | - | Y | `return self._af_new(a)` |
| sympy__sympy-12489 | permutations.py:1522 | single_line_modification | 1/1 | d1 | 4 | - | Y | `return self._af_new(_af_invert(self._array_form))` |
| sympy__sympy-12489 | permutations.py:1632 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return self._af_new(perm)` |
| sympy__sympy-12489 | permutations.py:1664 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return self._af_new(id_perm)` |
| sympy__sympy-12489 | permutations.py:1727 | single_line_modification | 1/1 | d1 | 1 | identifier_change, identifier_change_in_scope | Y | `return self.unrank_nonlex(self.size, r + 1)` |
| sympy__sympy-12489 | permutations.py:2128 | single_line_modification | 1/1 | d1 | - | - | Y | `return self._af_new([a[b[inva[i]]] for i in invb])` |
| sympy__sympy-12489 | permutations.py:2393 | single_line_modification | 1/1 | - | 3 | identifier_change, signature_change | n | `def unrank_trotterjohnson(cls, size, rank):` |
| sympy__sympy-12489 | permutations.py:2426 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return cls._af_new(perm)` |
| sympy__sympy-12489 | permutations.py:2480 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return self._af_new(pi)` |
| sympy__sympy-12489 | permutations.py:2664 | single_line_modification | 1/1 | - | 1 | identifier_change, signature_change | Y | `def josephus(cls, m, n, s=1):` |
| sympy__sympy-12489 | permutations.py:2710 | single_line_modification | 1/1 | - | 1 | call_target_change, call_target_change_in_scope | Y | `return cls(perm)` |
| sympy__sympy-12489 | permutations.py:2713 | single_line_modification | 1/1 | - | 2 | identifier_change, signature_change | 2sub | `def from_inversion_vector(cls, inversion):` |
| sympy__sympy-12489 | permutations.py:2737 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return cls._af_new(perm)` |
| sympy__sympy-12489 | permutations.py:2740 | single_line_modification | 1/1 | - | 2 | identifier_change, signature_change | 2sub | `def random(cls, n):` |
| sympy__sympy-12489 | permutations.py:2756 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return cls._af_new(perm_array)` |
| sympy__sympy-12489 | permutations.py:2759 | single_line_modification | 1/1 | - | 3 | identifier_change, signature_change | n | `def unrank_lex(cls, size, rank):` |
| sympy__sympy-12489 | permutations.py:2790 | single_line_modification | 1/1 | d1 | 2 | - | Y | `return cls._af_new(perm_array)` |
| django__django-14787 | decorators.py:40 | single_line_modification | 1/1 | - | - | - | n | `bound_method = wraps(method)(partial(method.__get__(self, type(self)))` |
| django__django-15315 | __init__.py:545 | multi_line_modification | 5/1 | - | 1 | - | Y | `return hash(self.creation_counter)` |
| django__django-15572 | autoreload.py:20 | single_line_modification | 1/1 | d1 | - | - | Y | `items.update(cwd / to_path(dir) for dir in backend.engine.dirs if dir)` |
| django__django-15572 | autoreload.py:28 | single_line_modification | 1/1 | d1 | - | guard_extend_condition | Y | `if directory and not is_django_path(directory)` |
| django__django-16100 | options.py:2014 | multi_line_modification | 8/11 | -,-,-,- | 0,2,2,0 | - | 2sub | `with transaction.atomic(using=router.db_for_write(self.model)):` |
| django__django-14725 | models.py:679 | multi_line_modification | 1/4 | -,-,- | 1,2,0 | - | 2sub | `if self.edit_only:` |
| django__django-14725 | models.py:878 | multi_line_modification | 1/2 | -,- | 3,1 | - | n | `absolute_max=None, can_delete_extra=True, renderer=None,` |
| django__django-14725 | models.py:899 | pure_insertion | 0/1 | - | 3 | - | n | `FormSet.edit_only = edit_only` |
| django__django-14725 | models.py:1079 | multi_line_modification | 1/2 | -,- | 3,1 | - | n | `absolute_max=None, can_delete_extra=True, renderer=None,` |
| django__django-14725 | models.py:1112 | pure_insertion | 0/1 | - | - | - | n | `'edit_only': edit_only,` |
| django__django-15103 | defaultfilters.py:86 | single_line_modification | 1/1 | - | 2 | add_parameter_default | Y | `def json_script(value, element_id=None):` |
| django__django-15103 | html.py:64 | single_line_modification | 1/1 | - | 2 | add_parameter_default | Y | `def json_script(value, element_id=None):` |
| django__django-15103 | html.py:72 | multi_line_modification | 4/7 | -,-,-,-,-,-,- | 1,1,4,0,1,2,- | - | n | `if element_id:` |
| django__django-15375 | aggregates.py:68 | multi_line_modification | 1/3 | -,-,- | -,-,- | - | n | `coalesce = Coalesce(c, default, output_field=c._output_field_or_none)` |
| django__django-15563 | compiler.py:1839 | multi_line_modification | 1/12 | -,-,-,-,-,-,-,-,-,-,-,- | 2,-,-,-,0,-,0,-,0,-,-,3 | - | n | `meta = query.get_meta()` |
| django__django-15563 | compiler.py:1854 | pure_insertion | 0/1 | - | - | - | n | `related_ids = collections.defaultdict(list)` |
| django__django-15563 | compiler.py:1856 | pure_insertion | 0/2 | -,- | -,- | - | n | `for parent, index in related_ids_index:` |
| django__django-15563 | compiler.py:1857 | single_line_modification | 1/1 | d1 | 1 | identifier_change, identifier_change_in_scope | Y | `self.query.related_ids = related_ids` |
| django__django-15563 | subqueries.py:137 | single_line_modification | 1/1 | - | 5 | - | n | `query.add_filter("pk__in", self.related_ids[model])` |
| django__django-15916 | models.py:256 | pure_insertion | 0/1 | - | 2 | - | 2sub | `self.formfield_callback = getattr(options, "formfield_callback", None)` |
| django__django-15916 | models.py:260 | deletion | 6/0 | - | - | delete_lines | Y | `` |
| django__django-15916 | models.py:311 | single_line_modification | 1/1 | d1 | 1 | - | Y | `opts.formfield_callback,` |
| django__django-15916 | models.py:639 | single_line_modification | 1/1 | d1 | 3 | - | Y | `form_class_attrs = {"Meta": Meta}` |
| django__django-15128 | query.py:575 | pure_insertion | 0/2 | -,- | -,- | - | n | `initial_alias = self.get_initial_alias()` |
| django__django-15128 | query.py:592 | deletion | 1/0 | - | - | delete_lines | Y | `` |
| django__django-15128 | query.py:882 | single_line_modification | 1/1 | - | - | add_parameter_default, template_slots_not_in_vocabulary | n | `def bump_prefix(self, other_query, exclude=None):` |
| django__django-15128 | query.py:907 | single_line_modification | 1/1 | - | - | identifier_change | n | `if self.alias_prefix != other_query.alias_prefix:` |
| django__django-15128 | query.py:925 | multi_line_modification | 1/3 | -,-,- | -,0,- | - | n | `other_query.subq_aliases = other_query.subq_aliases.union(self.subq_al` |
| django__django-15128 | query.py:929 | pure_insertion | 0/1 | - | - | - | n | `if alias not in exclude` |
| pytest-dev__pytest-10081 | unittest.py:319 | multi_line_modification | 1/3 | -,-,- | 3,-,- | - | n | `assert isinstance(self.parent, UnitTestCase)` |
| pytest-dev__pytest-7205 | setuponly.py:2 | pure_insertion | 0/1 | - | 0 | missing_import, template_slots_not_in_vocabulary | Y | `from _pytest._io.saferepr import saferepr` |
| pytest-dev__pytest-7205 | setuponly.py:69 | single_line_modification | 1/1 | - | - | - | n | `tw.write("[{}]".format(saferepr(fixturedef.cached_param, maxsize=42)))` |
| pytest-dev__pytest-10051 | logging.py:348 | new_function | 0/3 | -,-,- | 0,1,0 | new_function | Y | `def clear(self) -> None:` |
| pytest-dev__pytest-10051 | logging.py:443 | single_line_modification | 1/1 | d1 | 1 | call_target_change, call_target_change_in_scope | Y | `self.handler.clear()` |
| pytest-dev__pytest-7324 | expression.py:130 | pure_insertion | 0/1 | - | - | - | n | `IDENT_PREFIX = "$"` |
| pytest-dev__pytest-7324 | expression.py:164 | single_line_modification | 1/1 | - | - | - | n | `return ast.Name(IDENT_PREFIX + ident.value, ast.Load())` |
| pytest-dev__pytest-7324 | expression.py:175 | single_line_modification | 1/1 | - | - | - | n | `return self.matcher(key[len(IDENT_PREFIX) :])` |
| pytest-dev__pytest-10356 | structures.py:358 | multi_line_modification | 5/23 | -,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,d1 | 1,2,0,1,1,1,1,-,0,-,1,-,1,-,0,1,0,-,-,-,0,-,3 | - | n | `def get_unpacked_marks(` |
| pytest-dev__pytest-10356 | structures.py:391 | single_line_modification | 1/1 | - | - | - | n | `obj.pytestmark = [*get_unpacked_marks(obj, consider_mro=False), mark]` |
| pylint-dev__pylint-4970 | similar.py:393 | pure_insertion | 0/2 | -,- | 2,0 | guard_insertion | Y | `if self.min_lines == 0:` |
| pylint-dev__pylint-4604 | variables.py:1829 | pure_insertion | 0/3 | -,-,- | 1,2,0 | - | 2sub | `if isinstance(type_annotation, astroid.Attribute):` |
| pylint-dev__pylint-4604 | constants.py:4 | pure_insertion | 0/1 | - | 0 | missing_import, template_slots_not_in_vocabulary | Y | `import platform` |
| pylint-dev__pylint-4604 | constants.py:14 | pure_insertion | 0/1 | - | - | - | n | `IS_PYPY = platform.python_implementation() == "PyPy"` |
| pylint-dev__pylint-6386 | argument.py:460 | pure_insertion | 0/1 | - | 0 | insert_copy_from_file | Y | `metavar: str,` |
| pylint-dev__pylint-6386 | argument.py:470 | pure_insertion | 0/1 | - | 0 | insert_copy_from_function | Y | `self.metavar = metavar` |
| pylint-dev__pylint-6386 | arguments_manager.py:221 | pure_insertion | 0/1 | - | 0 | insert_copy_from_function | Y | `metavar=argument.metavar,` |
| pylint-dev__pylint-6386 | utils.py:74 | pure_insertion | 0/1 | - | 2 | - | 2sub | `metavar=optdict.get("metavar", None),` |
| pylint-dev__pylint-6386 | utils.py:210 | pure_insertion | 0/1 | - | 1 | - | Y | `"-v": (False, _set_verbose_mode),` |
| pylint-dev__pylint-6386 | utils.py:221 | single_line_modification | 1/1 | d1 | 1 | literal_change | Y | `if not argument.startswith("-"):` |
| pylint-dev__pylint-6386 | base_options.py:547 | pure_insertion | 0/1 | - | 1 | - | Y | `"metavar": "",` |
| pylint-dev__pylint-6386 | base_options.py:557 | pure_insertion | 0/1 | - | 1 | - | Y | `"metavar": "",` |
| psf__requests-1142 | models.py:389 | deletion | 1/0 | - | - | delete_lines | Y | `` |
| psf__requests-1142 | models.py:396 | pure_insertion | 0/2 | -,- | -,0 | add_branch_copy | Y | `elif self.method not in ('GET', 'HEAD'):` |
| psf__requests-2931 | models.py:84 | single_line_modification | 1/1 | d1 | 0 | - | Y | `return data` |
| psf__requests-2931 | models.py:388 | pure_insertion | 0/2 | -,- | 1,3 | guard_insertion | Y | `if isinstance(params, (str, bytes)):` |


## What this means for the design

1. **QuixBugs is a mutation-library problem, and it is solved at the proposal level.** 36/36 modified
   lines are depth-≤2 mutants of the buggy line (34 at depth 1); the 4 insertions are `x.f(y)` / `y = x`
   statements over in-scope names; 3 of the 4 are also donor+1-sub lines and all 4 are donor+2-sub lines
   (`reverse_linked_list`'s `prevnode = node` needs two substitutions or the `insert_assign_scope`
   template). *Corrected 2026-09-20: the original text said all 4 were donor+1-sub lines; the line table
   says 3/4.* Combined with the anchor probe (Jev
   localises the line top-1 13/14 and picks the fix 14/14 among tiny candidate sets), the ladder rung 1
   target (≥60% repaired) is bounded above by ranking quality, not by coverage. The 20-regex library of
   the anchor probe reached only 4/36; the operators that matter are in the ranked table below
   (`off_by_one`, `arg_swap`, `rel_swap`, `add_guard_cond`, `add_slice`, `const_to_ident`, `ident_sub`,
   `operand_swap`, `wrap_minmax`, `return_tweak`, `expr_to_ident`), each producing 1–4 lines and 19 of
   them needed to cover 34. The library is in-sample here (designed with the QuixBugs fixes in view), so
   the 100% is a ceiling statement, not a prediction; the SWE-bench numbers are the out-of-sample check.
2. **Candidate sets are too big for one Choice.** The median buggy line has 225 mutants on QuixBugs
   (61% ≤ 255) and 1,641 on SWE-bench (3% ≤ 255); identifier substitution over 100+ in-scope names is
   the bulk. Two-stage selection is needed: a Choice over operator *kinds* (30 options, each with an
   example mutant) and then a Choice over the ≤255 mutants of the chosen kind; or Nouls in batches of
   ≤1,000 per request ("could this line be the fix?") to prune before a Choice. Both are cheap (≤3
   requests per line). Restricting identifier substitution to the enclosing function's names first (median
   9–20) and widening only on miss is the other lever.
3. **On real repositories the plastic-surgery hypothesis carries more than mutation does.** Excluding the
   refactor instance, mutation reaches 12/72 hunks; donor+≤2-sub reaches 28/72 and donor *shape* 35/72
   (4 of the 72 are deletion hunks, counted reachable for every source; on the 68 non-deletion hunks the
   figures are mutation 8/68, donor ≤2-sub 24/68, shape 31/68; for all 30 instances, mutation 30/101
   non-deletion hunks instead of 35/106. *Added 2026-09-20.*)
   Half of all inserted lines are a repo line with ≤1 substitution, 58% with ≤2. A donor engine is the
   priority source for SWE-bench: index the repo's lines by skeleton, retrieve donors for the located
   site (same function, then same file, then repo), and let Jev fill 1–2 slots with Choices over in-scope
   names and literals from the tests. The two post-hoc operators worth keeping are `qualify_name`
   (`f(x)` → `self.f(x)`, 19 lines) and `comp_filter`; the rest of the post-hoc set added 3 lines.
4. **Templates need a name source.** Guard insertion, add-parameter-with-default and missing-import are
   the templates that fire on SWE-bench, but 5 of 21 template matches fail only because a slot name is
   absent from file+tests (`exclude`, `is_real`, `saferepr`'s module). Missing imports are rescued by
   verbatim donors (the import line exists elsewhere in the repo 2/2 times). Parameter/attribute names come
   from the issue text; the design should feed candidate names extracted from `problem_statement` and
   `hints_text` into the vocabulary (a Choice over "which of these words names the new parameter").
5. **The ceiling for a Jev-only agent on this SWE-bench slice is roughly 20–30% of instances** (6/30 with
   strict sources, 9/30 with 2-sub donors) *before* any ranking loss, and 50% is the vocabulary ceiling
   even with perfect assembly. Multi-hunk fixes dominate the loss: 19 of 30 gold patches have 2+ code
   hunks, and a fix is only reachable if every hunk is. The outer loop therefore has to decompose per
   failing test and per site, and accept partial patches when tests pass without every gold hunk (the
   study cannot see that; `pylint-4604`'s `import platform` hunk, for instance, is unrelated to the
   failing test). Anything above 30% on this slice would require a generation source (grammar-guided
   synthesis for new logic and new names), which is the ladder rung this study says is worth measuring
   next.
6. **Vocabulary is a cheap pre-check.** 100% of QuixBugs and 72% of SWE-bench fixed lines pass the
   file+tests vocabulary test; a line that fails it cannot come from mutation or donors as defined here.
   Use it to decide when to switch source (donor → template → give up) without spending Jev calls.

## Caveats

- **In-sample operator design.** The 30 operators were written after reading the 40 QuixBugs diffs; six
  more were added after reading the SWE-bench patches and are flagged post-hoc in every table. The
  anchor-probe 20-regex library is the only pre-registered library (4/36 and 0/78). Expect the
  out-of-sample coverage of *this* library on new one-line bugs to be well below 100%; the SWE-bench
  column without post-hoc operators (14/106 hunks, 0/30 fixes) is the honest lower bound.
- **Line-level accounting.** Reformatting counts as change (django-16100's black re-wrap), a deletion is
  always reachable, and a hunk is reachable only if every line is; the per-fix numbers are therefore
  conservative for tests (some gold hunks are not needed to pass the failing test) and optimistic for
  mutation (a line-level match ignores which of 1,600 mutants Jev would pick).
- **Donor substitution pool.** Substituted identifiers may come from anywhere in the file (every identifier
  token of the file, not only the enclosing scope) or from the test patch; literals from file or test patch. "Whole repo" includes test directories and the gold-fixed file's other
  lines at base_commit, never the gold patch itself. Shape-only matches are upper bounds.
- **n = 30 SWE-bench instances**, one of which (`sympy-12489`, a 42-line staticmethod→classmethod
  refactor) contributes 34 of the 106 code hunks; numbers are given with and without it.
- Depth-2 search was capped at 400k mutants per line (hit on 22 SWE-bench lines; no QuixBugs line was
  capped), so depth-2 SWE-bench misses are "not found within the cap".
- No tests were run and no Jev question was asked; reachability says a candidate *would be in the set*,
  not that it would be selected or that it passes the tests.
- **Deletion hunks inflate the "Fixes with >= 1 hunk reachable" column** (added 2026-09-20). The 5 deletion
  hunks count as reachable for every source, so mutation's 10/30 "fixes with >= 1 hunk reachable" is 7/30
  once instances whose only reachable hunk is a deletion are removed, and donor-verbatim's 10/30 is 5/30.
  The "fully reachable" and hunk columns are unaffected in ranking but include those 5 hunks in the
  numerator and denominator.
- **Two definitions of "without post-hoc ops"** (added 2026-09-20). `coverage_study.py` writes
  `mutation_no_posthoc` as "no producing operator is post-hoc"; `make_report.py` overwrites it as "not
  every producing operator is post-hoc" (a line that both `qualify_name` and a pre-registered operator
  produce still counts). The tables use the second, more generous definition; on this data the two agree
  (14/106 hunks, 10/78 lines) because the 23 post-hoc depth-1 lines are produced only by post-hoc operators.
- **The proposed Jev questions in "What this means for the design" have not been asked** and, as written,
  the Choice over operator kinds and the Choice over ≤255 mutants have no escape option; REPORT §11 shows
  a Choice without one puts 0.76 on a wrong option. Add `none_of_these` to both before measuring.

## References (added 2026-09-20 by the verifier; the original file had no citations)

- Barr, Brun, Devanbu, Harman, Sarro, "The Plastic Surgery Hypothesis", FSE '14, Hong Kong, 16–22 Nov 2014,
  doi:10.1145/2635868.2635898. Fetched 2026-09-20 from https://earlbarr.com/publications/psh.pdf (the ACM
  page returned 403): 15,723 commits, "changes are 43% graftable from the exact version of the software
  being changed". This study's donor-shape figure (139/199 fixed lines, 70%) is a line-level shape match, not
  the paper's whole-commit exact-snippet graftability, so the two numbers are not comparable.
- QuixBugs: https://github.com/jkoppel/QuixBugs (fetched 2026-09-20: "40 programs from the Quixey
  Challenge translated into both Python and Java", "a one-line defect", 14 defect classes; paper "QuixBugs:
  A Multi-Lingual Program Repair Benchmark Set Based on the Quixey Challenge", SPLASH Companion 2017).
- SWE-bench Verified: https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified (fetched 2026-09-20:
  "a subset of 500 samples from the SWE-bench test set, which have been human-validated for quality"). The
  30 instances used here are the repo's checked-in slice, not a random sample of the 500.

## Verification (2026-09-20)

Adversarial check by a second agent; scripts and raw output re-read, tables regenerated, a sample re-run.
Verdict: **corrected** (numbers sound, five prose errors fixed, citations added).

| Check | Result |
| --- | --- |
| Tables regenerate from `coverage-study.json` | `make_report.py` output is byte-identical to the "Tables" section (diff: one trailing blank line) |
| Headline numbers recomputed independently from the JSON | All match: 40/40, 6/30, 9/30, 57/106, 65/106, 35/106, 14/106 (no post-hoc), 4/36 and 0/78 baseline, 199 = 78 + 121 lines, 33/78 mutation, 82/199 and 109/199 donors, 139/199 shape, 144/199 and 15/30 vocabulary, median 1,641 (2/78 ≤ 255), 22 capped lines, 19 fixes with 2+ code hunks, 116 median scope; without `sympy-12489`: 72 hunks, 28/72, 33/72, 12/72, 9/72, 6/29, 9/29, 12/29, 14/29, 0/43 |
| Re-run of the script (`experiments/coverage-study/verify_rerun.py`) | QuixBugs 40/40 hunks and 4 SWE-bench instances (`django-15572`, `requests-2931`, `pylint-4970`, `pytest-7205`, 7 hunks) recomputed from the worktrees: 0 mismatches in kind, reach flags, per-line mutation depth/count, donor min-subs, templates; 8 s |
| Hunk parsing spot check | `django-15916` (4 raw change runs → 4 code hunks) and `requests-1142` (2 → 2) counted by hand from the gold patches agree with the JSON |
| Cost | $0.00 confirmed: no Jev, OpenRouter or HTTP call in any script under `experiments/coverage-study/` |
| Jev question wording | Not applicable (no question asked); the questions proposed in the design section lack escape options (noted in caveats) |
| Literature | The original had no citations; three added above and fetched today. The ACM DOI page and dblp were not reachable (403 / anti-bot page); the paper PDF from the first author's site was used |

Corrections made in the text (each marked in place): 9, not 32, non-code change groups; 3/4, not 4/4,
QuixBugs insertions are donor+1-sub lines; multi-line hunks 6/20 (2-sub union), not 7/20; the "new logic"
instances have 5–24 fixed lines, not 11–30 new lines; the donor substitution pool is every identifier of the
file, not only in-scope names. Added caveats: deletion hunks inflate the ">= 1 hunk" column, two
"post-hoc" definitions (agree on this data), proposed Choices need an escape option.

Claims that remain unverifiable here: (i) that the operator library is representative of anything
beyond the 40 + 30 fixes it was tuned on (in-sample, as the author states); (ii) the hand-written "What the
fix is" column (spot-checked for `django-15916`, `requests-1142`, `django-15572`, `requests-2931`,
`pylint-4970`, `pytest-7205` against the gold patches, all accurate); (iii) the "20–30% ceiling" and "50%
vocabulary ceiling" design conclusions, which follow from the numbers only under the study's own
definitions (a hunk needs every gold line; partial patches that pass tests are not modelled), so they are
bounds on *reproducing the gold patch*, not on solving the instance.
