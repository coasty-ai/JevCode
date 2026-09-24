# Probe: repository-scale understanding with Jev only, on 30 SWE-bench Verified instances (2026-09-20)

Model `typesafe/jev-1.13-20260917` via OpenRouter, pinned. No generating LLM anywhere: every answer below is a
Jev Choice or Noul over options that code enumerated. 433 saved live requests (332 main + 101 repo-wide; **$0.0833 from
`usage.costUsd`**, plus a claimed ~8-request $0.0013 smoke test whose output was not saved, so "441 / $0.085" is
unverifiable and the verified figures are 433 / $0.083), Jev latency p50 205 ms (main run) / 266 ms (repo-wide run),
largest single request **16.2k input tokens** (measured on the 2026-09-20 verification re-run of Q6; the original run
saved only per-instance totals), **32k state cap never approached**.

Scripts (all under `experiments/probe-swebench-understand/`): `prepare.py` (parses the gold patches, the gold files at
`base_commit`, package outlines, failing-test sources → `prepared.json`), `labels.json` (my manual change-kind labels,
written before any Jev call), `run.mts` (Q1–Q4, 332 requests, `results.json`), `run-repo.mts` (Q5–Q6, 101 requests,
`results-repo.json`), `report.py` (every table below, `tables.md`). Reproduce with
`python3 prepare.py && env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-swebench-understand/run.mts`
(then `run-repo.mts`, then `python3 report.py`). Repos are bare-cloned once per project with `--filter=blob:none`
under `/tmp/jevonly/cache/` and checked out per instance as git worktrees under `/tmp/jevonly/repos/<instance_id>`.

## Headline

| Stage (input → Jev question) | n | Result | Cost |
| --- | --- | --- | --- |
| Q6 problem statement → Nouls "must this file change" over **every** source file of the repo (61–778 files, median 644: 544–778 for the 20 sympy/django instances, 61–163 for the 10 pytest/pylint/requests instances; paths only, ≤4 batched requests) | 30 | gold file ranked **#1 on 23/30, ≤5 on 28/30, ≤10 on 30/30**; MRR 0.85; median 1 file ≥0.5 | $0.0011 / instance |
| Q5 problem statement → Choice over every source directory (7–100) | 30 | top-1 23/30 (77 %), top-5 29/30 | $0.0002 |
| Q3 problem statement → Nouls over the gold file's package (3–45 files, with symbol outlines) | 33 pkgs | gold ranked first 31/33; P 0.93 / R 0.76 at 0.5, P 0.96 / R 0.65 at 0.7 | $0.0002 |
| Q2 problem statement + gold file → Choice over all its functions/methods (2–230 options) | 37 files | top-1 19/37 (51 %), **top-5 35/37 (95 %)**, MRR 0.70; with hints 25/37 top-1, MRR 0.80 | $0.0001 |
| Q4 problem statement + failing test names + gold function → Choice over its lines ("where does the fix go") | 66 fns / 29 primary | top-1 within ±3: 61 % (primary fn: 76 %); **top-5 within ±3: 94 % (97 %)**; exact top-1 38 % | $0.0001 |
| Q1 problem statement → Choice over 10 kinds of change | 30 | 16/30 (53 %) match my primary label, 22/30 (73 %) an accepted label; paired Nouls flag 2.2 kinds on average | $0.0001 |
| Chained (Q6 file #1 ∧ Q2 fn ≤5 ∧ Q4 line ≤5 within ±3) | 30 | **21/30**; every stage top-1: 12/30 | ~$0.0015 |

Reading: localisation is a strength (file, function and line each land in the top-5 on ≥ 93 % of items, the
repo-wide file pick is top-1 on 77 % with nothing but the issue text and file paths); classifying *what kind of
edit* is needed is weak (53 %), and its errors are within-family confusions. Everything ran under a dollar's worth
of Jev by an order of magnitude ($0.083 saved spend, 12× under the $1 cap).

## Setup and truth derivation

- Instances: `bench/data/swebench-verified-30.json` (10 sympy, 10 django, 5 pytest, 3 pylint, 2 requests; 5 are
  multi-file fixes, 7 include module-level hunks). Gold patches: `swebench-verified-30.gold.json`.
- Gold files parsed with Python `ast` at `base_commit`; "functions" = every `def` at module level or inside a class
  (classes nested in classes included; functions nested in functions are folded into their enclosing def).
- Touched functions = owners of the old-file line numbers the gold hunk deletes, plus the anchor line before each
  pure insertion. An insertion whose anchor is outside every function (a new method appended after another) also
  credits the function ending within 3 lines above it (`adjacent_functions`), e.g. `LogCaptureHandler.reset` for
  the new `clear()` in pytest-10051.
- Line truth (Q4) = deleted lines ∪ insertion anchors of that function; a hit is a Jev line within ±3 of any of them.
- Change-kind truth (Q1) = `labels.json`: one primary label per instance plus `also_ok` alternates, with a one-line
  rationale; single annotator (me), written before running Jev. The Agent tool was not available in this session, so
  no second annotator; the `also_ok` set is my estimate of label ambiguity.
- Package (Q3) = the directory of the gold file, `.py` files only, non-recursive (3–45 files, never near the 100 cap).
  Repo (Q5/Q6) = every `.py` file under the checkout excluding `tests|test|testing|migrations|locale|doc|docs|examples|
  benchmarks|bin|release|conf|scripts|extras|changelog|build|dist|bench|extra` and dotted dirs.
- Every Choice carries the `none_of_these` escape from `src/jev/questions.ts`; option keys are snake_case names
  derived from the qualified name (`point__distance` → `point_distance`), never `option_a`-style (REPORT §10).

## Exact question wording and state shapes

**Q1 change kind.** State `{ issue: { repository, problem_statement[, discussion_hints ≤ 6000 chars] } }`.
Choice: "Read `issue.problem_statement`. Which single kind of code change is most likely needed in the library
source code (not in tests) to fix the issue? Judge the fix that would be written, not the report. Answer carefully
and literally." Options (key: description, definition + a generic example not drawn from these 30 instances):
`fix_wrong_value`, `add_guard_or_check`, `add_branch_or_case`, `change_call_or_arguments`,
`add_new_function_or_method`, `change_signature`, `change_message_or_formatting`, `config_or_metadata`,
`refactor_without_behaviour_change`, `none_of_these` ("… for example wrapping code in a context manager or
restructuring a loop"). Plus nine paired Nouls `needs_<kind>` ("Would fixing `issue` require this kind of change in
the library source: <kind>? Definition: …") with true/false definition + examples criteria. Full text in `run.mts`.

**Q2 function localisation.** State `{ issue, file: { path, functions: { <key>: "method Point.distance, line 266:
def distance(self, p):" … , module_level_code_outside_any_function: "code at module level: imports, constants,
tables, class attributes; not inside any function or method" } } }`. Choice over the keys (descriptions live in the
state, as in the anchor probe): "`file` is the source file that must be edited to fix `issue`. Which entry of
`file.functions` must be modified (its body changed, or new code inserted directly into it) to fix the issue? If the
fix is code outside every function, pick `module_level_code_outside_any_function`."

**Q3 package files.** State `{ issue, package_directory, files: { "<path>": { top_level_symbols: ["class X",
"f()", …≤40] } } }` (variant `paths`: empty objects). One Noul per file: "Must the file `files["<path>"]` be modified
to fix `issue`? Answer yes only if the code change that fixes the issue lands in this file." Criteria true: "the fix
edits code in this file" (examples: defines the function whose wrong behaviour the report describes / holds the
table or constant the fix must extend); false: "the fix does not touch this file" (merely imports or calls the fixed
code / unrelated to the symptoms).

**Q4 line localisation.** State `{ issue, failing_tests: [FAIL_TO_PASS names ≤20], file, function: { name, lines:
{ "L507": "<code>", … non-blank lines only } }[, failing_test_code: [lines added by test_patch ≤160]] }`. Choice over
`line_<n>` keys: "`function.lines` is the function that must be edited to fix `issue`; `failing_tests` are the tests
that must pass afterwards. Which line of `function.lines` does the fix go to: the line that must be changed, or the
existing line directly before or after which new code must be inserted? Pick one line."

**Q5 directory.** State `{ issue, directories: { <key>: { path, python_files: [≤15 names, "... N more"] } } }`.
Choice: "`directories` lists every source directory of the repository with its Python files. In which directory does
the code that must be changed to fix `issue` live? Pick the single most likely directory."

**Q6 repo-wide files.** State `{ issue, criteria: { yes_when: "the code change that fixes the issue lands in this
file: it defines the function, class, table or constant whose behaviour the report describes as wrong or missing",
no_when: "the file merely imports, calls or tests the code that is fixed elsewhere, or is unrelated to the
symptoms" }, files: [≤250 paths] }`. One context-style Noul per file (criteria once in the state, DESIGN §5.5):
"Must the file `<path>` (listed in `files`) be modified to fix `issue`? Apply `criteria`." Files are batched 250 per
request; probabilities are merged across batches (question independence, REPORT §7).

## Run summary

| Requests | Cost (USD) | Jev latency p50 / p90 (ms) | Max input tokens in one request | Errors |
| --- | --- | --- | --- | --- |
| 332 | 0.0432 | 205 / 296 | 13,389 | 0 |

Per question: requests, tokens per request (p50 / max), cost, latency p50.

| Question | Variant | n | input tokens p50 | input tokens max | cost (USD) | latency p50 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | ps | 30 | 2,745 | 4,081 | 0.0037 | 205 |
| Q1 | ps_hints | 30 | 2,985 | 5,491 | 0.0040 | 204 |
| Q2 | ps | 37 | 2,508 | 12,562 | 0.0051 | 191 |
| Q2 | ps_hints | 37 | 2,549 | 12,607 | 0.0055 | 193 |
| Q3 | outline | 33 | 4,534 | 13,389 | 0.0077 | 216 |
| Q3 | paths | 33 | 3,504 | 8,758 | 0.0058 | 227 |
| Q4 | names | 66 | 1,594 | 5,450 | 0.0052 | 194 |
| Q4 | names_testcode | 66 | 2,097 | 6,120 | 0.0062 | 209 |

## Q1 change kind

| Variant `ps` | n | Choice top-1 = primary label | Choice top-1 in {primary, also_ok} | primary in Choice top-2 | MRR (primary) | Noul(primary) > 0.5 | any Noul > 0.5 is an accepted label | mean kinds with Noul > 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 30 | 16/30 (53%) | 22/30 (73%) | 21/30 (70%) | 0.70 | 20/30 (67%) | 25/30 (83%) | 2.2 |

| Variant `ps_hints` | n | Choice top-1 = primary label | Choice top-1 in {primary, also_ok} | primary in Choice top-2 | MRR (primary) | Noul(primary) > 0.5 | any Noul > 0.5 is an accepted label | mean kinds with Noul > 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 30 | 17/30 (57%) | 21/30 (70%) | 20/30 (67%) | 0.70 | 17/30 (57%) | 25/30 (83%) | 2.1 |

Confusion (rows: my primary label, columns: Jev top-1, variant `ps`):

| label \ jev | fwv | agoc | aboc | ccoa | anfo | cs | cmof | com | rwbc | not |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fix_wrong_value | 2 | 2 | 2 | 2 |  |  |  | 1 |  |  |
| add_guard_or_check |  | 5 |  |  |  |  |  |  |  |  |
| add_branch_or_case | 1 | 1 | 3 | 1 |  |  |  |  |  |  |
| change_call_or_arguments |  |  | 1 | 3 |  | 1 |  |  |  |  |
| add_new_function_or_method |  |  |  | 1 |  |  |  |  |  |  |
| change_signature |  |  |  | 1 |  | 2 |  |  |  |  |
| none_of_these |  |  |  |  |  |  |  |  |  | 1 |

Abbreviations: fwv = fix_wrong_value, agoc = add_guard_or_check, aboc = add_branch_or_case, ccoa = change_call_or_arguments, anfo = add_new_function_or_method, cs = change_signature, cmof = change_message_or_formatting, com = config_or_metadata, rwbc = refactor_without_behaviour_change, not = none_of_these.

Per instance (variant `ps`; `+h` column is the top-1 with hints):

| Instance | My label (also ok) | Jev top-1 (p) | p(label) | Noul(label) | Nouls > 0.5 | top-1 +h |
| --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | change_call_or_arguments (fix_wrong_value) | change_call_or_arguments (0.96) | 0.96 | 0.87 | change_call_or_arguments | change_call_or_arguments |
| sympy-15345 | add_branch_or_case (config_or_metadata, add_new_function_or_method) | change_call_or_arguments (0.36) x | 0.17 | 0.51 | fix_wrong_value, add_branch_or_case, change_call_or_arguments, change_message_or_formatting | add_branch_or_case |
| sympy-17139 | add_guard_or_check (-) | add_guard_or_check (0.86) | 0.86 | 0.82 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| sympy-19954 | fix_wrong_value (none_of_these, refactor_without_behaviour_change) | add_guard_or_check (0.49) x | 0.29 | 0.31 | add_guard_or_check | add_guard_or_check x |
| sympy-11618 | add_branch_or_case (add_guard_or_check) | fix_wrong_value (0.40) x | 0.16 | 0.24 | - | fix_wrong_value x |
| sympy-13798 | add_branch_or_case (add_guard_or_check) | add_branch_or_case (0.56) | 0.56 | 0.57 | add_branch_or_case | add_branch_or_case |
| sympy-16792 | change_call_or_arguments (add_branch_or_case) | change_signature (0.39) x | 0.07 | 0.41 | add_branch_or_case, change_signature | change_signature x |
| sympy-20428 | fix_wrong_value (change_call_or_arguments) | change_call_or_arguments (0.36) ~ | 0.20 | 0.44 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | change_call_or_arguments ~ |
| sympy-22080 | add_branch_or_case (config_or_metadata, fix_wrong_value) | add_guard_or_check (0.36) x | 0.31 | 0.62 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check x |
| sympy-12489 | change_call_or_arguments (fix_wrong_value, refactor_without_behaviour_change, change_signature) | change_call_or_arguments (0.85) | 0.85 | 0.84 | change_call_or_arguments | change_call_or_arguments |
| django-14787 | change_call_or_arguments (fix_wrong_value) | add_branch_or_case (0.42) x | 0.34 | 0.31 | add_branch_or_case | add_branch_or_case x |
| django-15315 | fix_wrong_value (refactor_without_behaviour_change) | fix_wrong_value (0.91) | 0.91 | 0.66 | fix_wrong_value | fix_wrong_value |
| django-15572 | add_guard_or_check (-) | add_guard_or_check (0.94) | 0.94 | 0.88 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check |
| django-16100 | none_of_these (add_guard_or_check) | none_of_these (1.00) | 1.00 | nan | - | none_of_these |
| django-14725 | change_signature (add_branch_or_case) | change_signature (0.74) | 0.74 | 0.74 | add_guard_or_check, add_branch_or_case, add_new_function_or_method, change_signature | change_signature |
| django-15103 | change_signature (add_branch_or_case) | change_signature (1.00) | 1.00 | 0.95 | add_guard_or_check, add_branch_or_case, change_call_or_arguments, change_signature | change_signature |
| django-15375 | fix_wrong_value (change_call_or_arguments, none_of_these) | add_branch_or_case (0.43) x | 0.11 | 0.24 | add_branch_or_case, change_call_or_arguments | fix_wrong_value |
| django-15563 | fix_wrong_value (add_branch_or_case) | fix_wrong_value (0.60) | 0.60 | 0.53 | fix_wrong_value, add_branch_or_case, change_call_or_arguments | change_signature x |
| django-15916 | fix_wrong_value (refactor_without_behaviour_change, change_call_or_arguments) | change_call_or_arguments (0.45) ~ | 0.22 | 0.51 | fix_wrong_value, add_guard_or_check, add_branch_or_case, change_call_or_arguments | change_call_or_arguments ~ |
| django-15128 | change_signature (change_call_or_arguments, add_guard_or_check) | change_call_or_arguments (0.40) ~ | 0.28 | 0.57 | add_branch_or_case, change_call_or_arguments, change_signature | change_call_or_arguments ~ |
| pytest-10081 | add_guard_or_check (fix_wrong_value) | add_guard_or_check (0.81) | 0.81 | 0.79 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check |
| pytest-7205 | change_call_or_arguments (change_message_or_formatting) | change_call_or_arguments (0.94) | 0.94 | 0.92 | change_call_or_arguments, change_message_or_formatting | change_call_or_arguments |
| pytest-10051 | add_new_function_or_method (change_call_or_arguments) | change_call_or_arguments (0.48) ~ | 0.00 | 0.11 | - | fix_wrong_value x |
| pytest-7324 | fix_wrong_value (none_of_these, add_guard_or_check) | add_guard_or_check (0.45) ~ | 0.17 | 0.35 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_new_function_or_method x |
| pytest-10356 | add_branch_or_case (change_signature) | add_branch_or_case (0.48) | 0.48 | 0.54 | add_branch_or_case, change_call_or_arguments, add_new_function_or_method | add_branch_or_case |
| pylint-4970 | add_guard_or_check (-) | add_guard_or_check (0.92) | 0.92 | 0.88 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| pylint-4604 | add_branch_or_case (add_guard_or_check) | add_branch_or_case (0.53) | 0.53 | 0.71 | add_guard_or_check, add_branch_or_case | add_branch_or_case |
| pylint-6386 | fix_wrong_value (config_or_metadata, add_branch_or_case) | config_or_metadata (0.95) ~ | 0.01 | 0.58 | fix_wrong_value, change_call_or_arguments, config_or_metadata | config_or_metadata ~ |
| requests-1142 | add_guard_or_check (add_branch_or_case) | add_guard_or_check (0.67) | 0.67 | 0.76 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| requests-2931 | fix_wrong_value (add_guard_or_check) | add_branch_or_case (0.46) x | 0.04 | 0.49 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_branch_or_case x |

## Q2 function-level localisation in the gold file

| Variant `ps` | n (gold files) | top-1 (any touched fn) | top-5 | MRR | top-1 = primary touched fn | median options | escape mass max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 37 | 19/37 (51%) | 35/37 (95%) | 0.70 | 12/37 (32%) | 41 | 0.69 |

| Variant `ps_hints` | n (gold files) | top-1 (any touched fn) | top-5 | MRR | top-1 = primary touched fn | median options | escape mass max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 37 | 25/37 (68%) | 35/37 (95%) | 0.80 | 18/37 (49%) | 41 | 0.71 |

Per gold file (variant `ps`):

| Instance | File | options | touched (truth) | Jev top-1 (p) | rank | p(primary) | rank +h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | sympy/core/function.py | 93 | function_eval_evalf | function_eval_evalf (1.00) | 1 | 1.00 | 1 |
| sympy-15345 | sympy/printing/mathematica.py | 14 | module_level_code_outside_any_function, mcodeprinter_print_function | mcodeprinter_print_function (0.80) | 1 | 0.03 | 1 |
| sympy-17139 | sympy/simplify/fu.py | 37 | tr56 | tr56 (0.72) | 1 | 0.72 | 1 |
| sympy-19954 | sympy/combinatorics/perm_groups.py | 107 | permutationgroup_minimal_blocks | permutationgroup_minimal_blocks (0.96) | 1 | 0.96 | 1 |
| sympy-11618 | sympy/geometry/point.py | 52 | point_distance | point_distance (0.98) | 1 | 0.98 | 1 |
| sympy-13798 | sympy/printing/latex.py | 221 | latexprinter_init | latexprinter_print_mul (0.58) | 2 | 0.33 | 1 |
| sympy-16792 | sympy/utilities/codegen.py | 92 | codegen_routine | ccodegen_declare_arguments (0.51) | 2 | 0.19 | 2 |
| sympy-20428 | sympy/polys/domains/expressiondomain.py | 50 | expressiondomain_expression_bool | none_of_these (0.57) | 2 | 0.15 | 2 |
| sympy-22080 | sympy/printing/codeprinter.py | 46 | module_level_code_outside_any_function, codeprinter_print_mul | codeprinter_print_mul (0.52) | 1 | 0.01 | 1 |
| sympy-22080 | sympy/printing/precedence.py | 11 | module_level_code_outside_any_function | none_of_these (0.62) | 4 | 0.06 | 1 |
| sympy-12489 | sympy/combinatorics/permutations.py | 83 | module_level_code_outside_any_function, permutation_new, permutation_af_new (+24) | permutation_af_new (0.77) | 1 | 0.22 | 1 |
| django-14787 | django/utils/decorators.py | 12 | multi_decorate | method_decorator (0.59) | 3 | 0.01 | 3 |
| django-15315 | django/db/models/fields/__init__.py | 230 | field_hash | field_hash (1.00) | 1 | 1.00 | 1 |
| django-15572 | django/template/autoreload.py | 6 | get_template_directories | template_changed (0.60) | 2 | 0.37 | 2 |
| django-16100 | django/contrib/admin/options.py | 111 | modeladmin_changelist_view | modeladmin_changelist_view (1.00) | 1 | 1.00 | 1 |
| django-14725 | django/forms/models.py | 75 | basemodelformset_save, modelformset_factory, inlineformset_factory | basemodelformset_init (0.30) | 2 | 0.30 | 1 |
| django-15103 | django/template/defaultfilters.py | 61 | json_script | json_script (1.00) | 1 | 1.00 | 1 |
| django-15103 | django/utils/html.py | 26 | json_script | json_script (1.00) | 1 | 1.00 | 1 |
| django-15375 | django/db/models/aggregates.py | 16 | aggregate_resolve_expression | aggregate_as_sql (0.65) | 2 | 0.20 | 1 |
| django-15563 | django/db/models/sql/compiler.py | 47 | sqlupdatecompiler_pre_sql_setup | sqlupdatecompiler_as_sql (0.56) | 2 | 0.38 | 1 |
| django-15563 | django/db/models/sql/subqueries.py | 15 | updatequery_get_related_updates | updatequery_setup_query (0.55) | 4 | 0.10 | 1 |
| django-15916 | django/forms/models.py | 75 | modelformoptions_init, modelformmetaclass_new, modelform_factory | modelform_factory (0.90) | 1 | 0.04 | 1 |
| django-15128 | django/db/models/sql/query.py | 112 | query_combine, query_change_aliases, query_bump_prefix | query_combine (0.29) | 1 | 0.01 | 1 |
| pytest-10081 | src/_pytest/unittest.py | 24 | testcasefunction_runtest | testcasefunction_teardown (0.18) | 7 | 0.06 | 6 |
| pytest-7205 | src/_pytest/setuponly.py | 7 | module_level_code_outside_any_function, show_fixture_action | show_fixture_action (1.00) | 1 | 0.00 | 1 |
| pytest-10051 | src/_pytest/logging.py | 57 | module_level_code_outside_any_function, logcapturefixture_clear, logcapturehandler_reset | logcapturefixture_clear (0.83) | 1 | 0.00 | 1 |
| pytest-7324 | src/_pytest/mark/expression.py | 19 | module_level_code_outside_any_function, not_expr, matcheradapter_getitem (+1) | expression_compile (0.49) | 3 | 0.11 | 2 |
| pytest-10356 | src/_pytest/mark/structures.py | 35 | get_unpacked_marks, store_mark | get_unpacked_marks (0.88) | 1 | 0.88 | 1 |
| pylint-4970 | pylint/checkers/similar.py | 51 | similar_run | similarchecker_set_option (0.52) | 3 | 0.11 | 4 |
| pylint-4604 | pylint/checkers/variables.py | 78 | variableschecker_store_type_annotation_node | variableschecker_store_type_annotation_names (0.43) | 3 | 0.08 | 3 |
| pylint-4604 | pylint/constants.py | 2 | module_level_code_outside_any_function | none_of_these (0.69) | 2 | 0.31 | 2 |
| pylint-6386 | pylint/config/argument.py | 18 | callableargument_init | storetrueargument_init (0.39) | 18 | 0.00 | 18 |
| pylint-6386 | pylint/config/arguments_manager.py | 31 | argumentsmanager_add_parser_option | argumentsmanager_add_parser_option (0.33) | 1 | 0.33 | 1 |
| pylint-6386 | pylint/config/utils.py | 11 | convert_option_to_argument, module_level_code_outside_any_function, preprocess_options | set_verbose_mode (0.42) | 2 | 0.08 | 2 |
| pylint-6386 | pylint/lint/base_options.py | 4 | make_run_options | make_run_options (0.83) | 1 | 0.83 | 1 |
| requests-1142 | requests/models.py | 34 | preparedrequest_prepare_content_length | preparedrequest_prepare_content_length (0.75) | 1 | 0.75 | 1 |
| requests-2931 | requests/models.py | 41 | requestencodingmixin_encode_params, preparedrequest_prepare_url | preparedrequest_prepare_body (0.86) | 2 | 0.11 | 2 |

## Q3 file-level Nouls over the package

| Variant `outline` | n (packages) | files p50 | micro P/R at 0.5 | micro P/R at 0.7 | gold ranked first | exact set at 0.5 | MRR (first gold) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 33 | 16 | P 28/30 = 0.93, R 28/37 = 0.76 | P 24/25 = 0.96, R 24/37 = 0.65 | 31/33 (94%) | 26/33 (79%) | 0.96 |

| Variant `paths` | n (packages) | files p50 | micro P/R at 0.5 | micro P/R at 0.7 | gold ranked first | exact set at 0.5 | MRR (first gold) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 33 | 16 | P 27/32 = 0.84, R 27/37 = 0.73 | P 23/25 = 0.92, R 23/37 = 0.62 | 28/33 (85%) | 25/33 (76%) | 0.90 |

Per package (variant `outline`; `paths` gives the same measures without symbol outlines):

| Instance | Package | files | gold files: p | selected at 0.5 (tp) | at 0.7 (tp) | rank of first gold | max p non-gold | paths: rank / sel at 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | sympy/core | 31 | function.py 0.90 | 1 (1) | 1 (1) | 1 | 0.10 | 1 / 1 |
| sympy-15345 | sympy/printing | 30 | mathematica.py 0.84 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| sympy-17139 | sympy/simplify | 16 | fu.py 0.89 | 1 (1) | 1 (1) | 1 | 0.11 | 1 / 1 |
| sympy-19954 | sympy/combinatorics | 22 | perm_groups.py 0.91 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| sympy-11618 | sympy/geometry | 12 | point.py 0.83 | 1 (1) | 1 (1) | 1 | 0.16 | 1 / 1 |
| sympy-13798 | sympy/printing | 30 | latex.py 0.90 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| sympy-16792 | sympy/utilities | 20 | codegen.py 0.79 | 1 (1) | 1 (1) | 1 | 0.22 | 1 / 1 |
| sympy-20428 | sympy/polys/domains | 31 | expressiondomain.py 0.16 | 0 (0) | 0 (0) | 1 | 0.08 | 1 / 0 |
| sympy-22080 | sympy/printing | 37 | codeprinter.py 0.24, precedence.py 0.11 | 0 (0) | 0 (0) | 4 | 0.42 | 2 / 0 |
| sympy-12489 | sympy/combinatorics | 16 | permutations.py 0.91 | 1 (1) | 1 (1) | 1 | 0.04 | 1 / 1 |
| django-14787 | django/utils | 43 | decorators.py 0.90 | 1 (1) | 1 (1) | 1 | 0.05 | 1 / 1 |
| django-15315 | django/db/models/fields | 9 | __init__.py 0.94 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| django-15572 | django/template | 15 | autoreload.py 0.85 | 1 (1) | 1 (1) | 1 | 0.12 | 1 / 1 |
| django-16100 | django/contrib/admin | 15 | options.py 0.64 | 1 (1) | 0 (0) | 1 | 0.26 | 1 / 1 |
| django-14725 | django/forms | 9 | models.py 0.74 | 2 (1) | 2 (1) | 1 | 0.71 | 2 / 2 |
| django-15103 | django/template | 15 | defaultfilters.py 0.90 | 1 (1) | 1 (1) | 1 | 0.06 | 6 / 1 |
| django-15103 | django/utils | 43 | html.py 0.92 | 1 (1) | 1 (1) | 1 | 0.04 | 1 / 1 |
| django-15375 | django/db/models | 16 | aggregates.py 0.73 | 1 (1) | 1 (1) | 1 | 0.25 | 1 / 1 |
| django-15563 | django/db/models/sql | 7 | compiler.py 0.45, subqueries.py 0.52 | 1 (1) | 0 (0) | 1 | 0.43 | 2 / 1 |
| django-15916 | django/forms | 9 | models.py 0.93 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| django-15128 | django/db/models/sql | 7 | query.py 0.90 | 1 (1) | 1 (1) | 1 | 0.07 | 1 / 1 |
| pytest-10081 | src/_pytest | 45 | unittest.py 0.68 | 1 (1) | 0 (0) | 1 | 0.35 | 1 / 1 |
| pytest-7205 | src/_pytest | 39 | setuponly.py 0.91 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| pytest-10051 | src/_pytest | 45 | logging.py 0.95 | 1 (1) | 1 (1) | 1 | 0.03 | 1 / 1 |
| pytest-7324 | src/_pytest/mark | 4 | expression.py 0.76 | 1 (1) | 1 (1) | 1 | 0.18 | 1 / 1 |
| pytest-10356 | src/_pytest/mark | 3 | structures.py 0.67 | 1 (1) | 0 (0) | 1 | 0.17 | 1 / 1 |
| pylint-4970 | pylint/checkers | 22 | similar.py 0.82 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| pylint-4604 | pylint | 8 | constants.py 0.07 | 0 (0) | 0 (0) | 1 | 0.05 | 1 / 0 |
| pylint-4604 | pylint/checkers | 23 | variables.py 0.75 | 1 (1) | 1 (1) | 1 | 0.40 | 1 / 2 |
| pylint-6386 | pylint/config | 18 | argument.py 0.29, arguments_manager.py 0.09, utils.py 0.32 | 0 (0) | 0 (0) | 1 | 0.27 | 6 / 1 |
| pylint-6386 | pylint/lint | 8 | base_options.py 0.81 | 1 (1) | 1 (1) | 1 | 0.13 | 1 / 1 |
| requests-1142 | requests | 14 | models.py 0.71 | 1 (1) | 1 (1) | 1 | 0.15 | 1 / 1 |
| requests-2931 | requests | 14 | models.py 0.38 | 1 (0) | 0 (0) | 2 | 0.66 | 1 / 1 |

## Q4 line-level localisation inside the gold function

| Variant `names` | n (functions) | top-1 within +-3 | top-5 within +-3 | top-1 exact | MRR (+-3) | median lines | n (instances, primary fn) | top-1 +-3 | top-5 +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 66 | 40/66 (61%) | 62/66 (94%) | 25/66 (38%) | 0.76 | 25 | 29 | 22/29 (76%) | 28/29 (97%) |

| Variant `names_testcode` | n (functions) | top-1 within +-3 | top-5 within +-3 | top-1 exact | MRR (+-3) | median lines | n (instances, primary fn) | top-1 +-3 | top-5 +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 66 | 42/66 (64%) | 62/66 (94%) | 27/66 (41%) | 0.78 | 25 | 29 | 24/29 (83%) | 28/29 (97%) |

Note (verification): the rank columns below are computed over line options only; the escape option's mass is dropped
before ranking (`p_escape` is stored per row). Rows with escape > 0.5 (9/66, all sympy-12489) are therefore counted as
hits at p(top line) ≤ 0.28; see Caveats. Excluding sympy-12489 entirely: top-1 ±3 29/43 (67 %), top-5 39/43 (91 %).

Per touched function (variant `names`; last column: rank within +-3 when the added test code is in the state):

| Instance | Function | lines | truth lines | Jev top-1 (p) | rank +-3 | rank exact | +testcode rank +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | Function._eval_evalf | 45 | 510 | 510 (0.93) | 1 | 1 | 1 |
| sympy-17139 | _TR56 | 49 | 502 | 504 (0.96) | 1 | 30 | 1 |
| sympy-19954 | PermutationGroup.minimal_blocks | 76 | 2197, 2201, 2202, 2208 | 2201 (0.60) | 1 | 1 | 1 |
| sympy-11618 | Point.distance | 24 | 268 | 269 (0.83) | 1 | 24 | 1 |
| sympy-13798 | LatexPrinter.__init__ | 22 | 158, 159, 160, 161 ... | 160 (0.65) | 1 | 1 | 1 |
| sympy-16792 | CodeGen.routine | 143 | 697, 706, 708, 709 ... | 643 (0.41) | 2 | 11 | 2 |
| sympy-20428 | ExpressionDomain.Expression.__bool__ | 2 | 123 | 123 (0.66) | 1 | 1 | 1 |
| sympy-22080 | CodePrinter._print_Mul | 40 | 490 | 486 (0.24) | 19 | 33 | 20 |
| sympy-12489 | Permutation.__iter__ | 10 | 1526 | 1524 (0.11) | 1 | >all | 1 |
| sympy-12489 | Permutation.__mul__ | 48 | 1245, 1246 | 1303 (0.85) | 2 | 3 | 3 |
| sympy-12489 | Permutation.__new__ | 107 | 860, 862, 865, 868 ... | 860 (0.41) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__pow__ | 18 | 1344 | 1344 (0.72) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__rmul__ | 3 | 1242 | 1242 (0.58) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__rxor__ | 14 | 1348 | 1358 (0.28) | 2 | >all | 2 |
| sympy-12489 | Permutation.__sub__ | 7 | 1166 | 1174 (0.17) | 2 | 2 | 2 |
| sympy-12489 | Permutation._af_new | 20 | 928, 929, 931, 932 | 947 (0.74) | 2 | 2 | 2 |
| sympy-12489 | Permutation.commutes_with | 17 | 1307 | 1305 (0.05) | 1 | 5 | 1 |
| sympy-12489 | Permutation.from_inversion_vector | 22 | 2714, 2717 | 2737 (0.87) | 2 | 3 | 2 |
| sympy-12489 | Permutation.get_precedence_matrix | 28 | 2484 | 2482 (0.09) | 1 | 6 | 1 |
| sympy-12489 | Permutation.josephus | 39 | 2668 | 2710 (0.58) | 3 | 10 | 3 |
| sympy-12489 | Permutation.mul_inv | 7 | 1233 | 1238 (0.60) | 2 | 4 | 2 |
| sympy-12489 | Permutation.next_trotterjohnson | 49 | 2430 | 2480 (0.80) | 3 | 5 | 3 |
| sympy-12489 | Permutation.random | 13 | 2741, 2744 | 2756 (0.77) | 2 | 3 | 2 |
| sympy-12489 | Permutation.rank | 32 | 1731 | 1729 (0.06) | 1 | 5 | 1 |
| sympy-12489 | Permutation.rank_nonlex | 29 | 1668 | 1666 (0.05) | 1 | 6 | 1 |
| sympy-12489 | Permutation.rmul_with_af | 8 | 1226, 1227 | 1229 (0.58) | 1 | 6 | 1 |
| sympy-12489 | Permutation.signature | 25 | 2132 | 2130 (0.10) | 1 | 4 | 1 |
| sympy-12489 | Permutation.transpositions | 31 | 1443 | 1441 (0.05) | 1 | 5 | 1 |
| sympy-12489 | Permutation.unrank_lex | 28 | 2760, 2763 | 2790 (0.67) | 2 | 3 | 2 |
| sympy-12489 | Permutation.unrank_nonlex | 25 | 1636 | 1664 (0.80) | 2 | 4 | 2 |
| sympy-12489 | Permutation.unrank_trotterjohnson | 30 | 2397 | 2426 (0.75) | 4 | 6 | 5 |
| django-14787 | _multi_decorate | 27 | 40 | 49 (0.30) | 2 | 2 | 1 |
| django-15315 | Field.__hash__ | 6 | 545, 546, 547, 548 ... | 545 (0.40) | 1 | 1 | 1 |
| django-15572 | get_template_directories | 19 | 20, 28 | 20 (0.61) | 1 | 1 | 1 |
| django-16100 | ModelAdmin.changelist_view | 161 | 2014, 2015, 2016, 2017 ... | 2002 (0.26) | 3 | 7 | 3 |
| django-14725 | BaseModelFormSet.save | 12 | 679 | 679 (0.80) | 1 | 1 | 1 |
| django-14725 | inlineformset_factory | 43 | 1079, 1111 | 1074 (0.55) | 3 | 3 | 2 |
| django-14725 | modelformset_factory | 27 | 878, 898 | 873 (0.48) | 2 | 2 | 1 |
| django-15103 | json_script | 6 | 86, 89 | 86 (0.93) | 1 | 1 | 1 |
| django-15103 | json_script | 12 | 64, 72, 73, 74 ... | 64 (0.85) | 1 | 1 | 1 |
| django-15375 | Aggregate.resolve_expression | 19 | 68 | 54 (0.27) | 3 | 3 | 3 |
| django-15563 | SQLUpdateCompiler.pre_sql_setup | 40 | 1839, 1853, 1855, 1857 | 1839 (0.68) | 1 | 1 | 1 |
| django-15563 | UpdateQuery.get_related_updates | 16 | 137 | 137 (0.60) | 1 | 1 | 1 |
| django-15916 | ModelFormMetaclass.__new__ | 67 | 260, 261, 262, 263 ... | 266 (0.35) | 1 | 1 | 1 |
| django-15916 | ModelFormOptions.__init__ | 10 | 255 | 255 (0.70) | 1 | 1 | 1 |
| django-15916 | modelform_factory | 72 | 639 | 633 (0.38) | 2 | 2 | 2 |
| django-15128 | Query.bump_prefix | 45 | 882, 885, 887, 907 ... | 917 (0.28) | 2 | 3 | 2 |
| django-15128 | Query.change_aliases | 35 | 848 | 849 (0.45) | 1 | 5 | 1 |
| django-15128 | Query.combine | 96 | 574, 592, 593, 594 | 607 (0.55) | 3 | 40 | 2 |
| pytest-10081 | TestCaseFunction.runtest | 25 | 319 | 319 (0.84) | 1 | 1 | 1 |
| pytest-7205 | _show_fixture_action | 24 | 69 | 69 (0.95) | 1 | 1 | 1 |
| pytest-10051 | LogCaptureFixture.clear | 3 | 443 | 443 (0.81) | 1 | 1 | 1 |
| pytest-7324 | MatcherAdapter.__getitem__ | 2 | 175 | 175 (0.60) | 1 | 1 | 1 |
| pytest-7324 | not_expr | 11 | 164 | 164 (0.49) | 1 | 1 | 1 |
| pytest-10356 | get_unpacked_marks | 6 | 358, 359, 360, 361 ... | 360 (0.85) | 1 | 1 | 1 |
| pytest-10356 | store_mark | 8 | 391 | 391 (0.81) | 1 | 1 | 1 |
| pylint-4970 | Similar.run | 3 | 392 | 393 (0.49) | 1 | 3 | 1 |
| pylint-4604 | VariablesChecker._store_type_annotation_node | 18 | 1828 | 1829 (0.27) | 1 | >all | 1 |
| pylint-6386 | _ArgumentsManager._add_parser_option | 76 | 220 | 208 (0.22) | 59 | 62 | 11 |
| pylint-6386 | _CallableArgument.__init__ | 17 | 459, 469 | 462 (0.28) | 1 | 15 | 1 |
| pylint-6386 | _convert_option_to_argument | 112 | 73 | 57 (0.33) | 11 | 48 | 9 |
| pylint-6386 | _make_run_options | 175 | 546, 556 | 543 (0.30) | 1 | 158 | 1 |
| pylint-6386 | _preprocess_options | 29 | 221 | 238 (0.40) | 2 | 2 | 2 |
| requests-1142 | PreparedRequest.prepare_content_length | 8 | 389, 395 | 389 (0.71) | 1 | 1 | 1 |
| requests-2931 | PreparedRequest.prepare_url | 62 | 387 | 351 (0.42) | 6 | >all | 6 |
| requests-2931 | RequestEncodingMixin._encode_params | 23 | 84 | 84 (0.58) | 1 | 1 | 1 |

### Q4 per instance, primary touched function (most changed lines)

| Instance | Primary function | lines | truth lines | names: top-1 (p) | rank +-3 | rank exact | +testcode: rank +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | Function._eval_evalf | 45 | 510 | 510 (0.93) | 1 | 1 | 1 |
| sympy-15345 | (module-level change only) | | | | | | |
| sympy-17139 | _TR56 | 49 | 502 | 504 (0.96) | 1 | 30 | 1 |
| sympy-19954 | PermutationGroup.minimal_blocks | 76 | 2197, 2201, 2202, 2208 | 2201 (0.60) | 1 | 1 | 1 |
| sympy-11618 | Point.distance | 24 | 268 | 269 (0.83) | 1 | 24 | 1 |
| sympy-13798 | LatexPrinter.__init__ | 22 | 158, 159, 160, 161 ... | 160 (0.65) | 1 | 1 | 1 |
| sympy-16792 | CodeGen.routine | 143 | 697, 706, 708, 709 ... | 643 (0.41) | 2 | 11 | 2 |
| sympy-20428 | ExpressionDomain.Expression.__bool__ | 2 | 123 | 123 (0.66) | 1 | 1 | 1 |
| sympy-22080 | CodePrinter._print_Mul | 40 | 490 | 486 (0.24) | 19 | 33 | 20 |
| sympy-12489 | Permutation.__new__ | 107 | 860, 862, 865, 868 ... | 860 (0.41) | 1 | 1 | 1 |
| django-14787 | _multi_decorate | 27 | 40 | 49 (0.30) | 2 | 2 | 1 |
| django-15315 | Field.__hash__ | 6 | 545, 546, 547, 548 ... | 545 (0.40) | 1 | 1 | 1 |
| django-15572 | get_template_directories | 19 | 20, 28 | 20 (0.61) | 1 | 1 | 1 |
| django-16100 | ModelAdmin.changelist_view | 161 | 2014, 2015, 2016, 2017 ... | 2002 (0.26) | 3 | 7 | 3 |
| django-14725 | modelformset_factory | 27 | 878, 898 | 873 (0.48) | 2 | 2 | 1 |
| django-15103 | json_script | 12 | 64, 72, 73, 74 ... | 64 (0.85) | 1 | 1 | 1 |
| django-15375 | Aggregate.resolve_expression | 19 | 68 | 54 (0.27) | 3 | 3 | 3 |
| django-15563 | SQLUpdateCompiler.pre_sql_setup | 40 | 1839, 1853, 1855, 1857 | 1839 (0.68) | 1 | 1 | 1 |
| django-15916 | ModelFormMetaclass.__new__ | 67 | 260, 261, 262, 263 ... | 266 (0.35) | 1 | 1 | 1 |
| django-15128 | Query.bump_prefix | 45 | 882, 885, 887, 907 ... | 917 (0.28) | 2 | 3 | 2 |
| pytest-10081 | TestCaseFunction.runtest | 25 | 319 | 319 (0.84) | 1 | 1 | 1 |
| pytest-7205 | _show_fixture_action | 24 | 69 | 69 (0.95) | 1 | 1 | 1 |
| pytest-10051 | LogCaptureFixture.clear | 3 | 443 | 443 (0.81) | 1 | 1 | 1 |
| pytest-7324 | MatcherAdapter.__getitem__ | 2 | 175 | 175 (0.60) | 1 | 1 | 1 |
| pytest-10356 | get_unpacked_marks | 6 | 358, 359, 360, 361 ... | 360 (0.85) | 1 | 1 | 1 |
| pylint-4970 | Similar.run | 3 | 392 | 393 (0.49) | 1 | 3 | 1 |
| pylint-4604 | VariablesChecker._store_type_annotation_node | 18 | 1828 | 1829 (0.27) | 1 | >all | 1 |
| pylint-6386 | _CallableArgument.__init__ | 17 | 459, 469 | 462 (0.28) | 1 | 15 | 1 |
| requests-1142 | PreparedRequest.prepare_content_length | 8 | 389, 395 | 389 (0.71) | 1 | 1 | 1 |
| requests-2931 | RequestEncodingMixin._encode_params | 23 | 84 | 84 (0.58) | 1 | 1 | 1 |

## Q5 directory-level Choice over the whole repository

| n | dirs p50 (min-max) | top-1 | top-5 | MRR | escape mass max | input tokens p50 / max | cost (USD) | latency p50 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 75 (7-100) | 23/30 (77%) | 29/30 (97%) | 0.87 | 0.15 | 7,774 / 9,397 | 0.0073 | 225 |

| Instance | dirs | gold dir: p | Jev top-1 (p) | rank |
| --- | --- | --- | --- | --- |
| sympy-12096 | 60 | sympy_core 1.00 | sympy_core (1.00) | 1 |
| sympy-15345 | 75 | sympy_printing 0.72 | sympy_printing (0.72) | 1 |
| sympy-17139 | 75 | sympy_simplify 1.00 | sympy_simplify (1.00) | 1 |
| sympy-19954 | 81 | sympy_combinatorics 1.00 | sympy_combinatorics (1.00) | 1 |
| sympy-11618 | 60 | sympy_geometry 0.99 | sympy_geometry (0.99) | 1 |
| sympy-13798 | 64 | sympy_printing 0.99 | sympy_printing (0.99) | 1 |
| sympy-16792 | 75 | sympy_utilities 0.21 | sympy_codegen (0.75) | 2 |
| sympy-20428 | 81 | sympy_polys_domains 0.01 | sympy_polys (0.99) | 2 |
| sympy-22080 | 85 | sympy_printing 0.01 | sympy_utilities (0.81) | 6 |
| sympy-12489 | 60 | sympy_combinatorics 0.99 | sympy_combinatorics (0.99) | 1 |
| django-14787 | 100 | django_utils 0.36 | django_utils (0.36) | 1 |
| django-15315 | 100 | django_db_models_fields 0.75 | django_db_models_fields (0.75) | 1 |
| django-15572 | 100 | django_template 0.97 | django_template (0.97) | 1 |
| django-16100 | 100 | django_contrib_admin 0.21 | django_contrib_admin_views (0.77) | 2 |
| django-14725 | 100 | django_forms 1.00 | django_forms (1.00) | 1 |
| django-15103 | 100 | django_template 0.22, django_utils 0.03 | django_templatetags (0.31) | 2 |
| django-15375 | 100 | django_db_models 0.68 | django_db_models (0.68) | 1 |
| django-15563 | 100 | django_db_models_sql 0.24 | django_db_models (0.75) | 2 |
| django-15916 | 100 | django_forms 0.99 | django_forms (0.99) | 1 |
| django-15128 | 100 | django_db_models_sql 0.91 | django_db_models_sql (0.91) | 1 |
| pytest-10081 | 7 | src_pytest 0.98 | src_pytest (0.98) | 1 |
| pytest-7205 | 7 | src_pytest 0.99 | src_pytest (0.99) | 1 |
| pytest-10051 | 7 | src_pytest 1.00 | src_pytest (1.00) | 1 |
| pytest-7324 | 7 | src_pytest_mark 0.80 | src_pytest_mark (0.80) | 1 |
| pytest-10356 | 7 | src_pytest_mark 0.81 | src_pytest_mark (0.81) | 1 |
| pylint-4970 | 13 | pylint_checkers 0.08 | pylint_checkers_refactoring (0.81) | 2 |
| pylint-4604 | 13 | pylint_checkers 0.99, pylint 0.01 | pylint_checkers (0.99) | 1 |
| pylint-6386 | 17 | pylint_config 0.80, pylint_lint 0.12 | pylint_config (0.80) | 1 |
| requests-1142 | 7 | requests 0.62 | requests (0.62) | 1 |
| requests-2931 | 8 | requests 0.96 | requests (0.96) | 1 |

## Q6 repo-wide file Nouls (every source .py file, paths only)

| n | files p50 (min-max) | requests per instance | gold ranked 1 | <= 5 | <= 10 | MRR | micro P/R at 0.5 | at 0.7 | at 0.9 | files selected at 0.5 p50 / max | tokens per instance p50 | cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 644 (61-778) | 1-4 | 23/30 (77%) | 28/30 (93%) | 30/30 (100%) | 0.85 | P 26/48 = 0.54, R 26/37 = 0.70 | P 23/29 = 0.79, R 23/37 = 0.62 | P 12/13 = 0.92, R 12/37 = 0.32 | 1 / 3 | 34,776 | 0.0328 |

| Instance | files | gold file: p (rank among all files) | selected at 0.5 (tp) | at 0.7 (tp) | strongest non-gold file (p) |
| --- | --- | --- | --- | --- | --- |
| sympy-12096 | 545 | function.py 0.92 (#1) | 1 (1) | 1 (1) | sympy/core/evalf.py 0.26 |
| sympy-15345 | 663 | mathematica.py 0.90 (#1) | 1 (1) | 1 (1) | sympy/core/backend.py 0.47 |
| sympy-17139 | 672 | fu.py 0.94 (#1) | 1 (1) | 1 (1) | sympy/core/function.py 0.20 |
| sympy-19954 | 726 | perm_groups.py 0.96 (#1) | 1 (1) | 1 (1) | sympy/combinatorics/util.py 0.09 |
| sympy-11618 | 544 | point.py 0.89 (#1) | 3 (1) | 1 (1) | sympy/vector/point.py 0.64 |
| sympy-13798 | 592 | latex.py 0.93 (#1) | 1 (1) | 1 (1) | sympy/printing/printer.py 0.25 |
| sympy-16792 | 668 | codegen.py 0.79 (#1) | 3 (1) | 1 (1) | sympy/printing/ccode.py 0.60 |
| sympy-20428 | 732 | expressiondomain.py 0.27 (#9) | 2 (0) | 0 (0) | sympy/polys/polyclasses.py 0.62 |
| sympy-22080 | 778 | codeprinter.py 0.31 (#10), precedence.py 0.10 (#44) | 1 (0) | 1 (0) | sympy/utilities/lambdify.py 0.85 |
| sympy-12489 | 550 | permutations.py 0.95 (#1) | 1 (1) | 1 (1) | sympy/core/basic.py 0.13 |
| django-14787 | 644 | decorators.py 0.82 (#1) | 1 (1) | 1 (1) | django/views/decorators/__init__.py 0.43 |
| django-15315 | 645 | __init__.py 0.92 (#1) | 1 (1) | 1 (1) | django/db/models/fields/mixins.py 0.15 |
| django-15572 | 646 | autoreload.py 0.90 (#1) | 1 (1) | 1 (1) | django/utils/autoreload.py 0.23 |
| django-16100 | 646 | options.py 0.44 (#2) | 1 (0) | 1 (0) | django/contrib/admin/views/main.py 0.87 |
| django-14725 | 645 | models.py 0.61 (#2) | 2 (1) | 1 (0) | django/forms/formsets.py 0.82 |
| django-15103 | 644 | defaultfilters.py 0.44 (#3), html.py 0.39 (#5) | 2 (0) | 0 (0) | django/template/defaulttags.py 0.66 |
| django-15375 | 645 | aggregates.py 0.83 (#1) | 2 (1) | 1 (1) | django/db/models/functions/math.py 0.61 |
| django-15563 | 646 | compiler.py 0.55 (#3), subqueries.py 0.22 (#6) | 3 (1) | 2 (0) | django/db/models/query.py 0.85 |
| django-15916 | 646 | models.py 0.94 (#1) | 1 (1) | 1 (1) | django/forms/forms.py 0.16 |
| django-15128 | 644 | query.py 0.95 (#2) | 2 (1) | 2 (1) | django/db/models/query.py 0.95 |
| pytest-10081 | 66 | unittest.py 0.78 (#1) | 1 (1) | 1 (1) | src/_pytest/skipping.py 0.42 |
| pytest-7205 | 61 | setuponly.py 0.94 (#1) | 1 (1) | 1 (1) | src/_pytest/_io/saferepr.py 0.21 |
| pytest-10051 | 66 | logging.py 0.97 (#1) | 1 (1) | 1 (1) | src/_pytest/fixtures.py 0.03 |
| pytest-7324 | 62 | expression.py 0.76 (#1) | 3 (1) | 1 (1) | src/_pytest/mark/evaluate.py 0.59 |
| pytest-10356 | 66 | structures.py 0.76 (#1) | 3 (1) | 1 (1) | src/_pytest/python.py 0.55 |
| pylint-4970 | 118 | similar.py 0.88 (#1) | 1 (1) | 1 (1) | pylint/checkers/refactoring/refactoring_checker.py 0.37 |
| pylint-4604 | 112 | variables.py 0.72 (#1), constants.py 0.08 (#15) | 2 (1) | 1 (1) | pylint/checkers/imports.py 0.64 |
| pylint-6386 | 163 | argument.py 0.31 (#5), arguments_manager.py 0.31 (#6), utils.py 0.12 (#17), base_options.py 0.70 (#1) | 2 (1) | 1 (1) | pylint/config/option.py 0.55 |
| requests-1142 | 66 | models.py 0.71 (#1) | 1 (1) | 1 (1) | requests/packages/urllib3/request.py 0.41 |
| requests-2931 | 80 | models.py 0.57 (#1) | 2 (1) | 0 (0) | requests/compat.py 0.54 |

## Chained view per instance (each stage given the previous stage's gold input)

Q6 file = gold file (primary) ranked first among all repo files; Q2 fn = a touched function in top-5 of the gold file (`ps`); Q4 line = a target line within +-3 in top-5 of the primary function (`names`). "all top-1" tightens every stage to top-1.

| Instance | Q5 dir top-1 | Q6 file rank | Q2 fn rank | Q4 line rank (+-3) | file#1 & fn<=5 & line<=5 | all top-1 |
| --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | yes | 1 | 1 | 1 | yes | yes |
| sympy-15345 | yes | 1 | 1 | n/a (module-level) | yes | yes |
| sympy-17139 | yes | 1 | 1 | 1 | yes | yes |
| sympy-19954 | yes | 1 | 1 | 1 | yes | yes |
| sympy-11618 | yes | 1 | 1 | 1 | yes | yes |
| sympy-13798 | yes | 1 | 2 | 1 | yes | no |
| sympy-16792 | no (#2) | 1 | 2 | 2 | yes | no |
| sympy-20428 | no (#2) | 9 | 2 | 1 | no | no |
| sympy-22080 | no (#6) | 10 | 1 | 19 | no | no |
| sympy-12489 | yes | 1 | 1 | 1 | yes | yes |
| django-14787 | yes | 1 | 3 | 2 | yes | no |
| django-15315 | yes | 1 | 1 | 1 | yes | yes |
| django-15572 | yes | 1 | 2 | 1 | yes | no |
| django-16100 | no (#2) | 2 | 1 | 3 | no | no |
| django-14725 | yes | 2 | 2 | 2 | no | no |
| django-15103 | no (#2) | 5 | 1 | 1 | no | no |
| django-15375 | yes | 1 | 2 | 3 | yes | no |
| django-15563 | no (#2) | 3 | 2 | 1 | no | no |
| django-15916 | yes | 1 | 1 | 1 | yes | yes |
| django-15128 | yes | 2 | 1 | 2 | no | no |
| pytest-10081 | yes | 1 | 7 | 1 | no | no |
| pytest-7205 | yes | 1 | 1 | 1 | yes | yes |
| pytest-10051 | yes | 1 | 1 | 1 | yes | yes |
| pytest-7324 | yes | 1 | 3 | 1 | yes | no |
| pytest-10356 | yes | 1 | 1 | 1 | yes | yes |
| pylint-4970 | no (#2) | 1 | 3 | 1 | yes | no |
| pylint-4604 | yes | 1 | 3 | 1 | yes | no |
| pylint-6386 | yes | 17 | 2 | 11 | no | no |
| requests-1142 | yes | 1 | 1 | 1 | yes | yes |
| requests-2931 | yes | 1 | 2 | 1 | yes | no |

Chained: 21/30 instances pass file top-1, function top-5 and line top-5; 12/30 pass every stage at top-1.

## State sizes and the 32k cap

| Request type | input tokens p50 | max | Note |
| --- | --- | --- | --- |
| Q1 (issue only / + hints) | 2,745 / 2,985 | 4,081 / 5,491 | 10 options with definitions + 9 criteria'd Nouls |
| Q2 (functions of one file) | 2,508 | 12,562 | max = `django/db/models/fields/__init__.py`, 230 options |
| Q3 (package files + outlines / paths) | 4,534 / 3,504 | 13,389 / 8,758 | max = `sympy/printing`, 37 files with outlines; 45 criteria'd Nouls |
| Q4 (one function's lines) | 1,594 / 2,097 | 5,450 / 6,120 | max = `_make_run_options`, 175 lines; lines appear once in the state |
| Q5 (all repo directories) | 7,774 | 9,397 | 100 django directories with 15 file names each |
| Q6 (≤250 repo paths per batch) | ≈11,600 per batch (per-instance total ÷ requests) | 16,218 measured on the verification re-run (sympy-20428, batch 2 of 3; the original run logged only the per-instance total 45,526 over 3 batches, ≈15,200 average). sympy-22080 (778 files) was 4 requests, 44,672 tokens, ≈11,200 per batch | whole repo of 778 files = 4 requests |

No measured request exceeded 16.2k of the 32,768-token cap (per-batch token counts were not saved by `run-repo.mts`; the 16,218 figure is from `verify-q6-batches.mts`, four instances re-run). Truncating to the function level (Q4 sends only the located
function, Q2 only signatures) keeps the largest gold file (5,263 lines, `perm_groups.py`) irrelevant to the budget;
the longest touched function was 178 lines, so no function needed windowing (the runner throws if a function has
more than 254 non-blank lines, which did not happen).

## Failure taxonomy

- **Symptom file vs cause file (Q6/Q5, 3 instances).** sympy-22080 (issue reports a `lambdify` bug; Jev puts
  `utilities/lambdify.py` at 0.85, the fix is in `printing/codeprinter.py` at 0.31, #10), sympy-20428 (`Poly`
  printing symptoms → `polys/polyclasses.py` 0.62; fix in `polys/domains/expressiondomain.py` 0.27, #9),
  django-16100 (changelist symptom → `admin/views/main.py` 0.87; fix in `admin/options.py` 0.44, #2). Jev reads the
  issue literally: it finds where the symptom lives. Only execution (a stack trace, coverage) can walk to the cause.
- **Sibling/near-duplicate names.** django-15128 `db/models/query.py` 0.95 vs gold `db/models/sql/query.py` 0.95
  (tie broken against gold); django-14725 `forms/formsets.py` 0.82 vs gold `forms/models.py` 0.61; sympy-11618
  `vector/point.py` 0.64 selected alongside gold `geometry/point.py` 0.89. Paths alone cannot separate these; the
  outline variant (Q3) fixed 3 such packages.
- **Multi-file fixes** (5/30): the second file is usually a consequence of the first edit (a new import, a table
  entry, a signature change propagating). Q6 ranks the secondary files at #5–#44. One-shot localisation should not be
  expected to find them; a second localisation pass after the first edit, with the diff in the state, is the design.
- **Noise in gold** — pylint-4604 `constants.py` (unrelated `IS_PYPY` constant) at 0.07/0.08 is Jev being right.
- **Function level (Q2) misses** are neighbours: `_print_Mul` over `__init__` (13798), `as_sql` over
  `pre_sql_setup` (15375, 15563), `method_decorator` over `_multi_decorate` (14787), `tearDown` over `runtest`
  (10081, rank 7, the only top-5 miss besides pylint-6386 `argument.py` rank 18). Nine of the 18 misses have the
  truth at rank 2. When the truth is module-level code the escape absorbs mass (precedence.py 0.62, constants.py
  0.69) even with an explicit `module_level…` option, i.e. Jev is not convinced a table entry "is the fix".
- **Line level (Q4)**: exact top-1 only 38 % but ±3 top-1 61 % / top-5 94 %: Jev points at the right statement
  region (the `try:`, the `if`, the `return`) rather than the exact line the diff touches, which is what the edit
  enumerator needs anyway. The two hard misses are long functions where the fix is a one-token change deep in the
  body (`_add_parser_option` rank 59, `_print_Mul` rank 19).
- **Change kind (Q1)**: `fix_wrong_value` is the fuzzy class (2/9 recalled; spread over guard/branch/call). Jev's
  picks are defensible in most "misses" (sympy-16792 `change_signature`: the fix does add `**metadata` to a call;
  django-14787 `add_branch_or_case`). Hints did not help (+1 strict, −1 lenient). The escape worked exactly where
  the taxonomy had a hole (django-16100 `none_of_these` 1.00 for wrap-in-`transaction.atomic`).

## What this means for a Jev-only localiser at repo scale

1. **Localise files over the whole repository with plain Nouls, from the issue text alone.** 61–778 paths in ≤4
   requests, ~$0.001 and ~1 s per instance, gold file #1 on 23/30 and in the top-10 on 30/30. This replaces the
   300-file lexical pre-filter as the first stage: no BM25, no embeddings, no file reads. Consume it **by rank, not
   by threshold**: at 0.5 precision is 0.54, at 0.7 0.79, at 0.9 0.92 but recall drops to 0.32; the top-5 by
   probability (28/30) is the right beam.
2. **Confirm the beam with outlines.** Re-asking the Noul with `top_level_symbols` in the state (Q3) lifted
   gold-first from 28/33 to 31/33 in the package setting and separated sibling-name files. Stage 1 paths-only over
   the repo, stage 2 outlines over the top-5 to top-10 files, is two requests.
3. **Directory Choice (Q5) is redundant** as a stage (77 % top-1 versus the file Nouls' 77 %, and hierarchical
   chaining would multiply errors), but it is a free consistency check in the same request budget.
4. **Function stage: keep a beam of 5.** Choice over every function with only its signature line gets top-5 95 %
   but top-1 51 %; the candidate-edit enumerator should run over the 5 functions (median 41 options, so 5 is 12 %
   of the file). Hints text is worth +17 points top-1 when present (16/30 instances have it); a jev-only agent has no
   hints, but a rerun of Q2 after a failed edit with the test output in the state is the analogue to test next.
   Enumerate nested classes fully (the `ExpressionDomain.Expression.__bool__` case) and keep the
   `module_level…` option, accepting that module-level fixes will mostly surface at rank 2 behind the escape.
5. **Line stage: 5 anchors × ±3 lines is the search window.** Top-5 within ±3 covers 94 % of functions (97 % of
   primary functions), so the mutation/template/donor enumerators should generate candidates only in ~5 windows of
   7 lines instead of over the whole function: a 178-line function shrinks to ≤35 candidate lines. Test *names*
   alone are almost as good as test source (+3 points), which matters because in the real setting the failing test
   is unknown until reproduction.
6. **Do not gate candidate sources on the change-kind Choice.** At 53 % strict it would prune the right source on
   half the instances. Use the paired Nouls as a soft multi-label prior (83 % of instances have an accepted kind
   among the Nouls > 0.5; mean 2.2 kinds flagged) to *order* the sources (guards/branches/call-arguments first for
   these repos) and to pick the `none_of_these` cases for a "wrap/restructure" template family that the taxonomy
   lacks. Merge `fix_wrong_value` and `change_call_or_arguments` for routing purposes; Jev does not separate them.
7. **Expected pipeline reach.** Given only the issue text, 21/30 instances end with the gold file ranked first, a
   touched function in the top-5 and a fix line in the top-5 (±3) at about $0.0015 and ~2 s of Jev time; 12/30
   are top-1 at every stage. The 9 chained failures are 7 file-level misses (symptom-vs-cause and sibling names,
   above) plus two deep one-token line misses. The repair stage therefore inherits a search space of ≈5 functions
   × 5 windows × 7 lines on two thirds of these SWE-bench Verified instances (difficulty labels: 12 "<15 min fix", 15 "15 min – 1 hour", 3 "1–4 hours"); the other third needs
   execution signal (reproduction, traceback, coverage) before Jev can help.
8. **Budget.** The entire understanding + localisation pass is ≈8 requests and ≈60k input tokens per instance
   (≈$0.0025) with no request above 16k tokens. There is room for ×2 states (full outlines everywhere, both hint
   variants) before the 32k cap matters.

## Caveats

- n = 30 from five projects (20 of them sympy + django); intervals are wider than ±9 points: the 95 % Wilson interval on
  23/30 is 59–88 % (±15 points), on 28/30 it is 79–98 %, on 21/30 (chained) 52–83 %, on 12/30 25–58 %, on 35/37 82–99 %,
  on 40/66 49–71 %. Rates below about 20/30 and above 27/30 are the only ones distinguishable from 50 % / 100 % respectively.
- Q2, Q3 and Q4 are **oracle-chained**: each gets the gold file (Q2/Q3) or gold function (Q4) as input, so the
  per-stage rates are upper bounds on what the chained system sees; the "Chained view" table reports the honest
  conjunction on the same items. Q4 also uses `FAIL_TO_PASS` names, which a real agent only has after reproduction,
  and the `names_testcode` variant uses hidden test code (reported as an oracle ceiling only).
- Truth for touched functions and line anchors is derived mechanically from hunks; multi-hunk refactors
  (sympy-12489, 24 touched functions) inflate Q4's n and are reported both included and excluded (excluding it:
  top-1 ±3 29/43 = 67 %, top-5 39/43 = 91 %, exact 22/43 = 51 %).
- Q1 labels are a single annotator's; the confusion matrix shows the disagreement is concentrated in the
  `fix_wrong_value`/`change_call_or_arguments`/`add_branch_or_case` family, which is also where my `also_ok`
  alternates live.
- Single run; Jev noise is ±0.02 in the 0.55–0.80 band for Nouls and peaked Choices (REPORT §6) but larger on flat
  Choices: the verification re-run of 16 Q1/Q2 rows moved a flat Q1 Choice from 0.36 to 0.45 and 0.49 to 0.42 (no top-1
  flips), and Q6 sympy-22080 moved from rank 10 to rank 9. Ties such as django-14725 Q2 (0.30 vs 0.30) or django-15128
  Q6 (0.95 vs 0.95) can flip between runs. No request was retried or failed (0 errors in the 433 saved requests).
- Cost figures are `usage.costUsd` from the responses: $0.0432 main run + $0.0401 repo run = $0.0833 (both recomputed
  from the saved rows); the $0.0013 smoke test is the author's claim with no saved output.
- **Q4 ranks exclude the escape option.** `run.mts` drops `none_of_these` before ranking lines, so a row counts as a
  top-1 hit even when Jev put most of the mass on the escape. In 9/66 `names` rows (all sympy-12489 refactor methods)
  the escape had 0.62–0.92 while the top line had ≤0.28; 7 of those 9 are counted as top-1 (±3) hits and all 9 as
  top-5. Treating escape-dominated rows as misses gives top-1 ±3 33/66 (50 %) and top-5 53/66 (80 %) instead of
  61 % / 94 %. The per-instance primary-function figures (22/29, 28/29) are unaffected: no primary function had escape
  > 0.5. Q2, by contrast, ranks the escape with the functions (it is top-1 on 3/37 files, all module-level truths).

## Verification (2026-09-20)

Adversarial check by a second agent. Spend for verification: $0.0077 (20 live Jev requests, `usage.costUsd`), recorded in
`experiments/probe-swebench-understand/results-verify-q6.json` and `results-Q1Q2.json`. Verdict: **corrected** — every
table number reproduces from the saved raw output; the headline prose overstated four things (request count, file-count
range, largest request, statistical precision) and one methodological choice (Q4 escape handling) was undisclosed.

**Recomputed from raw output.** `python3 report.py` regenerates `tables.md` byte-for-byte, and every table in this file
matches it. Independently recomputed from `results.json` / `results-repo.json`: 332 + 101 = 433 requests, cost
0.043237 + 0.040095 = $0.0833, main-run latency p50 204.9 ms / p90 295.9 ms, max main-run request 13,389 tokens; Q6
rank #1 23/30, ≤5 28/30, ≤10 30/30, MRR 0.846, P/R at 0.5 = 26/48 / 26/37, at 0.7 = 23/29 / 23/37, at 0.9 = 12/13 /
12/37, files 61–778 (median 644), 71 Q6 requests + 30 Q5 = 101; Q5 top-1 23/30, top-5 29/30, MRR 0.872; Q2 `ps` 19/37,
35/37, MRR 0.704, `ps_hints` 25/37, 35/37, MRR 0.801; Q4 `names` 40/66, 62/66, exact 25/66; excluding sympy-12489
29/43, 39/43, 22/43; Q1 strict 16/30, lenient 22/30, mean Nouls > 0.5 = 2.2. All as reported.

**Live re-run (same scripts, same model pin).** `run.mts --only Q1,Q2 --limit 4` (16 requests, $0.0022, p50 266 ms):
16/16 rows reproduce the saved top-1 and rank; probabilities moved by ≤0.03 on peaked answers and up to 0.09 on flat Q1
Choices. `verify-q6-batches.mts` on sympy-20428, sympy-22080, django-15128, pytest-10051 (11 requests, $0.0055): gold
ranks 9→9, 10→9, 2→2, 1→1; gold probabilities within 0.02; per-batch input tokens 2,006–16,218.

**Corrections made in the text above.**

| Claim as written | Verified | Fix |
| --- | --- | --- |
| "441 live requests", "0 errors in 441" | 433 saved requests; the extra 8 (smoke test) have no saved output | Restated as 433 saved + unverifiable smoke test |
| "$0.085 total" | $0.0833 from saved rows; $0.0013 smoke test unverifiable | Both figures shown |
| "largest single request 15.2k" / "No request exceeded 15.2k" | Never measured: `run-repo.mts` saves only per-instance totals; 15.2k was 45,526 ÷ 3 for sympy-20428 (the table attributed it to sympy-22080, which had 4 requests / 44,672 tokens). Measured max on re-run: 16,218 | Corrected instance and figure; cap still not approached |
| Q6 over "545–778 files" (headline table, design point 1) | 61–778, median 644; 10 of 30 repos have 61–163 source files | Range corrected |
| "under a dollar … by two orders of magnitude" | $0.083 vs $1.00 is 12× | "an order of magnitude" |
| "±9-point 95 % interval at best" | Wilson interval on 23/30 is 59–88 % (±15) | Intervals listed |
| "Jev noise is ±0.02" | Flat Q1 Choice moved 0.09 on re-run; Q6 rank 10→9 | Qualified |
| "easy/medium" instances | Dataset labels are 12 "<15 min", 15 "15 min–1 hour", 3 "1–4 hours" | Labels quoted |
| Q4 top-1 ±3 61 % / top-5 94 % | Correct as computed, but ranks drop the escape; 9/66 rows have escape 0.62–0.92 and are still counted as hits | Disclosed; alternative 50 % / 80 % given; primary-function figures unaffected |

**Question well-formedness (REPORT §7, §10, §11, §14).** Every Choice gets `none_of_these` via `choice()` (confirmed in
the saved `probabilities`); option keys are snake_case names derived from qualified names or paths, never `option_a`-style
(the builder rejects them); criteria are definition + examples on Q1/Q3 Nouls; Q6 uses `contextNoul` with the criteria
once in the state and referenced by backticked path, which REPORT §11 rates equivalent to putting them in
`instructions`. Nothing asks Jev to count or compute. Two design weaknesses, not errors: (a) Q4's option keys are
`line_<n>` while the state keys are `L<n>`, so Jev must hop `line_507 → L507` with null option descriptions (REPORT
§10: "semantic keys with null descriptions 0.91 with 0.08 leaking to a lookalike"); aligning the keys is a free
improvement to test. (b) Q6's Noul question ids are file paths; REPORT §7 says ids are not sent to the model, so the
path in the backticked instruction is what carries the reference — fine, but the id gives no extra signal.

**Truth derivation spot-checked** against the gold patches for sympy-11618 (anchor line 268 = the docstring close before
the inserted block; Jev's 269 is within ±3) and pytest-10051 (`LogCaptureFixture.clear` line 443, `LogCaptureHandler.reset`
via the ±3 adjacency rule, plus a `<module>` entry that is only a deleted blank line at 43 — harmless truth noise).
`labels.json` has 30 instance entries plus a `_note`, each with `primary`, `also_ok` and a one-line `why`.

**Definitions that differ between tables (no numbers change, but read carefully).** "Primary function" in the Q2 table
is the touched function with the most deleted lines; in the Q4 per-instance table it is the function with the most
targets (deleted lines + insertion anchors) across all gold files; in the chained view the primary *file* is chosen
first (most deleted lines) and then the function with the most targets inside it. Hence pylint-6386 shows
`_CallableArgument.__init__` (rank 1) in the Q4 per-instance table but line rank 11 (`_convert_option_to_argument`,
`utils.py`) in the chained view.

**Literature.** The file cites no external literature (no URLs); all references are to the internal
`jev-research/REPORT.md` (§6 noise, §7 independence, §10 escape/name prior, §11 techniques) and `docs/DESIGN.md`
§5.5, which were checked and say what is attributed to them. Nothing to re-fetch.

**Conclusions.** The localisation claims (file/function/line top-5 rates, chained 21/30) are supported by the numbers
with the oracle-chaining caveat already stated. The Q4 line-stage strength is the one place the prose overreaches: with
escape-dominated rows counted as misses the per-function top-5 falls to 80 %, though the per-instance primary-function
figure (97 %) stands. Design implications 1–8 follow from the tables; implication 8's "≈8 requests, ≈60k tokens" is a
rough estimate (3–4 Q6 + 1 Q5 + 1 Q2 + 1–5 Q4 ≈ 6–11 requests, ≈47–53k tokens) and should be read as such.
