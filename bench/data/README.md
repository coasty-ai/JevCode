# SWE-bench Verified 30-task local subset

Checked-in, self-contained data for JevCode's local (no-Docker) SWE-bench evaluator and for the mocked bench. Everything was fetched on **2026-09-19** with plain `fetch`/`curl` from the primary sources listed below; no third-party mirrors, no manual edits.

## Files

| File | Bytes | Contents |
|---|---|---|
| `swebench-verified-30.json` | 324,960 | JSON array of 30 task records (schema below). **Does not contain the gold patch.** |
| `swebench-verified-30.gold.json` | 50,405 | `{ "<instance_id>": "<gold patch>" }` for the same 30. Used only by the mocked bench; never show it to the agent under test. |

Total 375,365 bytes (~0.36 MB), far below the 8 MB budget, so `pass_to_pass` lists are complete and untruncated (1,689 P2P and 69 F2P test ids in total).

## Sources (fetched 2026-09-19)

| What | URL | Revision seen |
|---|---|---|
| Dataset rows (all 500, 5 pages) | `https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test&offset={0,100,200,300,400}&length=100` | HF repo `sha c104f840cc67f8b6eec6f759ebc8b2693d585d4a`, lastModified 2025-02-18T23:48:55Z (from `https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified`) |
| Install/test specs | https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/dockerfile_gen/constants.py (`MAP_REPO_VERSION_TO_SPECS`, `MAP_REPO_TO_PARSER_NAME`, `MAP_REPO_TO_REQS_PATHS`, `INSTANCE_OVERRIDES`) | `SWE-bench/swe-bench-tasks` main = `3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d` (`git ls-remote`) |
| Per-instance files | `https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/tasks/<instance_id>/{task.yaml,tests.json,eval.sh}` | same |
| Grading / log-parser code (referenced, not copied) | https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/grading.py , https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/log_parsers/python.py | `SWE-bench/SWE-bench` main = `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` |

Each record's `source_urls.dataset` is the exact single-row URL (`...&offset=<row index>&length=1`) it was taken from.

## Selection procedure (deterministic)

1. **Download.** All 500 rows of `princeton-nlp/SWE-bench_Verified` (`test` split) via the five paged `/rows` calls above. All 500 `instance_id`s are unique; `FAIL_TO_PASS`/`PASS_TO_PASS` (JSON-encoded strings) parse for every row.

2. **Overall Verified difficulty distribution (500 rows):** `<15 min fix` 194 (38.8%), `15 min - 1 hour` 261 (52.2%), `1-4 hours` 42 (8.4%), `>4 hours` 3 (0.6%). Scaled to 30 that is 11.64 / 15.66 / 2.52 / 0.18, rounded to **12 / 15 / 3 / 0**.

3. **Feasibility filter** (repos that run on stock Python 3.9 with `pip install -e .` and no native builds, per `docs/research/02-swebench-verified.md` section 4): `sympy/sympy` (all versions), `django/django` versions `4.1` and `4.2` only, `pytest-dev/pytest`, `pylint-dev/pylint`, `psf/requests` minus `psf__requests-2317` (needs live network per the swe-bench-tasks CHANGELOG). Result: **169 of 500** instances.

   Feasible pool before selection (rows = repo, columns = difficulty):

   | repo | <15 min fix | 15 min - 1 hour | 1-4 hours | >4 hours | total |
   |---|---|---|---|---|---|
   | sympy/sympy | 25 | 43 | 6 | 1 | 75 |
   | django/django (4.1, 4.2) | 25 | 27 | 6 | 0 | 58 |
   | pytest-dev/pytest | 8 | 8 | 3 | 0 | 19 |
   | pylint-dev/pylint | 3 | 5 | 2 | 0 | 10 |
   | psf/requests (minus 2317) | 5 | 2 | 0 | 0 | 7 |
   | **total** | **66** | **85** | **17** | **1** | **169** |

4. **Quotas per (repo, difficulty).** Repo totals follow the suggested split 10 sympy / 10 django / 5 pytest / 3 pylint / 2 requests; the difficulty split inside each repo was fixed up front so the columns sum to 12 / 15 / 3:

   | repo | <15 min fix | 15 min - 1 hour | 1-4 hours | total |
   |---|---|---|---|---|
   | sympy/sympy | 4 | 5 | 1 | 10 |
   | django/django | 4 | 5 | 1 | 10 |
   | pytest-dev/pytest | 2 | 2 | 1 | 5 |
   | pylint-dev/pylint | 1 | 2 | 0 | 3 |
   | psf/requests | 1 | 1 | 0 | 2 |
   | **total** | **12** | **15** | **3** | **30** |

   The single `>4 hours` feasible instance is not sampled (its scaled quota rounds to 0). pylint and requests get no `1-4 hours` slot because their pools are 2 and 0.

5. **Pick rule inside each bucket.** Sort the bucket's `instance_id`s ascending as plain strings (JavaScript default `Array.prototype.sort`, i.e. UTF-16 code-unit order, so digits compare character-by-character). With N ids and quota m, set **k = floor(N / m)** and take the ids at indices **0, k, 2k, ..., (m-1)k**. No other criteria were applied (nothing was read or filtered by problem text, test count, or repo area).

   | repo | difficulty | N | m | k | indices | picks |
   |---|---|---|---|---|---|---|
| sympy/sympy | <15 min fix | 25 | 4 | 6 | 0, 6, 12, 18 | sympy__sympy-12096<br>sympy__sympy-15345<br>sympy__sympy-17139<br>sympy__sympy-19954 |
| sympy/sympy | 15 min - 1 hour | 43 | 5 | 8 | 0, 8, 16, 24, 32 | sympy__sympy-11618<br>sympy__sympy-13798<br>sympy__sympy-16792<br>sympy__sympy-20428<br>sympy__sympy-22080 |
| sympy/sympy | 1-4 hours | 6 | 1 | 6 | 0 | sympy__sympy-12489 |
| django/django | <15 min fix | 25 | 4 | 6 | 0, 6, 12, 18 | django__django-14787<br>django__django-15315<br>django__django-15572<br>django__django-16100 |
| django/django | 15 min - 1 hour | 27 | 5 | 5 | 0, 5, 10, 15, 20 | django__django-14725<br>django__django-15103<br>django__django-15375<br>django__django-15563<br>django__django-15916 |
| django/django | 1-4 hours | 6 | 1 | 6 | 0 | django__django-15128 |
| pytest-dev/pytest | <15 min fix | 8 | 2 | 4 | 0, 4 | pytest-dev__pytest-10081<br>pytest-dev__pytest-7205 |
| pytest-dev/pytest | 15 min - 1 hour | 8 | 2 | 4 | 0, 4 | pytest-dev__pytest-10051<br>pytest-dev__pytest-7324 |
| pytest-dev/pytest | 1-4 hours | 3 | 1 | 3 | 0 | pytest-dev__pytest-10356 |
| pylint-dev/pylint | <15 min fix | 3 | 1 | 3 | 0 | pylint-dev__pylint-4970 |
| pylint-dev/pylint | 15 min - 1 hour | 5 | 2 | 2 | 0, 2 | pylint-dev__pylint-4604<br>pylint-dev__pylint-6386 |
| psf/requests | <15 min fix | 5 | 1 | 5 | 0 | psf__requests-1142 |
| psf/requests | 15 min - 1 hour | 2 | 1 | 2 | 0 | psf__requests-2931 |

6. **Result:** 30 instances; per repo sympy/sympy 10, django/django 10, pytest-dev/pytest 5, pylint-dev/pylint 3, psf/requests 2; per difficulty `<15 min fix` 12, `15 min - 1 hour` 15, `1-4 hours` 3. All 30 resolve to `python: "3.9"` in the spec map.

7. **Per-instance fetch and cross-check.** For each pick, `task.yaml`, `tests.json` and `eval.sh` were fetched from swe-bench-tasks and the spec looked up in `constants.py` by `(repo, version)`. Checks that passed for all 30/30: `task.yaml` `base_commit`, `environment_setup_commit`, `version`, `repo`, `difficulty`, `created_at` equal the dataset row; `tests.json` FAIL_TO_PASS/PASS_TO_PASS equal the decoded dataset lists as sets; `eval.sh` contains the base commit and the test patch; the file list on `eval.sh`'s `git checkout <base_commit> ...` line equals `test_files` derived from the `test_patch` headers; both `>>>>> Start Test Output` / `>>>>> End Test Output` markers present; every `eval_type` is `pass_and_fail`. `INSTANCE_OVERRIDES` in `constants.py` lists only two astropy instances, so no pick needs an eval repair.

## Record schema (`swebench-verified-30.json`)

Keys, in order, on every record:

| key | type | note |
|---|---|---|
| `instance_id`, `repo`, `base_commit`, `environment_setup_commit`, `version`, `created_at`, `difficulty`, `problem_statement`, `hints_text` | string | verbatim from the dataset row (`problem_statement` keeps its `\r\n`; `hints_text` may be `""`) |
| `fail_to_pass`, `pass_to_pass` | string[] | dataset `FAIL_TO_PASS`/`PASS_TO_PASS` decoded with `JSON.parse`. `fail_to_pass` is non-empty for all 30; `pass_to_pass` is `[]` for `pylint-dev__pylint-4604` (as upstream). Django ids are test names or docstring first lines (e.g. `"@method_decorator preserves wrapper assignments."`), sympy ids are bare function names (`"test_issue_12092"`), pytest-style repos use `path::Class::test[param]` ids. |
| `test_patch` | string | verbatim dataset test diff |
| `test_files` | string[] | the `b/<path>` of every `diff --git a/<p> b/<p>` header in `test_patch` (1-3 files per record) |
| `spec` | object | `{ python, install, pre_install: string[], pip_packages: string[], packages: string \| null, test_cmd }` from `MAP_REPO_VERSION_TO_SPECS[repo][version]`; missing `pre_install`/`pip_packages` become `[]`, missing `packages` becomes `null`. Docker-only keys (`nano_cpus` on pylint 2.14/2.15, `eval_commands`) are dropped. |
| `log_parser` | string | from `task.yaml`: `parse_log_sympy`, `parse_log_django`, `parse_log_pytest`, `parse_log_pylint`, `parse_log_requests` |
| `eval_script` | string | `eval.sh` verbatim. It is written for the official Docker image (`source /opt/miniconda3/bin/activate`, `conda activate testbed`, `cd /testbed`); a local runner should reproduce its tail: `git checkout <base_commit> <test_files>`, `git apply -v` the test patch, `: '>>>>> Start Test Output'`, `<test_cmd> <test targets>`, `: '>>>>> End Test Output'`, then `git checkout <base_commit> <test_files>`. |
| `source_urls` | object | `{ dataset, task_yaml, eval_sh, constants }` |

## Notes for the local evaluator

- **Spec `packages` semantics** (as in the SWE-bench Dockerfile generator): `"requirements.txt"` means "install the repo's requirements file(s)" from `MAP_REPO_TO_REQS_PATHS` in `constants.py`: django -> `tests/requirements/py3.txt`, pylint -> `requirements_test.txt`. A space-separated name list (sympy: `"mpmath flake8"`, requests: `"pytest"`) means "pip install these". `null` (pytest) means only `pip_packages` are installed. Install commands: sympy/django/pytest/pylint `python -m pip install -e .`; requests `python -m pip install .`. `pip_packages` pins: all 10 sympy records pin `mpmath==1.3.0` and `flake8-comprehensions`; the three pytest 7.2 records (`-10051`, `-10081`, `-10356`) pin `attrs==23.1.0 iniconfig==2.0.0 packaging==23.1 pluggy==0.13.1 py==1.11.0 tomli==2.0.1` and the two pytest 5.4 records (`-7205`, `-7324`) pin `py==1.11.0 packaging==23.1 attrs==23.1.0 more-itertools==10.1.0 pluggy==0.13.1`; the django, pylint and requests picks have no `pip_packages`. None of the 30 has a `pre_install` step (every `spec.pre_install` is `[]`).
- **Test invocation.** Django: `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 <dotted test labels>` (eval.sh converts `tests/decorators/tests.py` to `decorators.tests`). Sympy: `PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose <files>`. pytest/pylint/requests: `pytest -rA <files>`. Use the exact targets from `eval_script` rather than re-deriving them.
- **Grading rule** (SWE-bench `grading.py`): resolved iff every `fail_to_pass` id is PASSED/XFAIL and every `pass_to_pass` id is PASSED/XFAIL/SKIPPED; a missing id counts as failed; parametrized ids may be truncated and are prefix-matched.
- **Network.** Neither requests instance needs a live server: no graded test in `psf__requests-1142` (v1.1, file defaults to `http://httpbin.org/`) or `psf__requests-2931` (v2.9, `pytest-httpbin` fixture) takes the `httpbin` fixture or performs a request; the two `test_connection_error_*` P2P tests expect a `ConnectionError` on an unresolvable host and pass offline. (Verified by parsing `test_requests.py` at both base commits on 2026-09-19.)

## License

- The dataset card for `princeton-nlp/SWE-bench_Verified` declares **no license** (`cardData.license` is null and there is no `license:*` tag on the HF API as of 2026-09-19); treat the problem statements, patches and test ids as upstream-owned data of undeclared license. The underlying issue text and code belong to the respective projects (sympy, Django, pytest, pylint, requests) under their own licenses.
- The SWE-bench harness code (grading, log parsers, spec tables copied here) is **MIT** (Copyright (c) 2023 Carlos E Jimenez, John Yang, et al.; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/LICENSE). The `SWE-bench/swe-bench-tasks` repo, from which `eval.sh`/`task.yaml`/`tests.json`/`constants.py` were taken, has no LICENSE file at its root (HTTP 404 on 2026-09-19).

## The 30 instances

| # | instance_id | repo | version | python | difficulty | F2P | P2P | test files |
|---|---|---|---|---|---|---|---|---|
| 1 | sympy__sympy-12096 | sympy/sympy | 1.0 | 3.9 | <15 min fix | 1 | 43 | sympy/utilities/tests/test_lambdify.py |
| 2 | sympy__sympy-15345 | sympy/sympy | 1.4 | 3.9 | <15 min fix | 1 | 8 | sympy/printing/tests/test_mathematica.py |
| 3 | sympy__sympy-17139 | sympy/sympy | 1.5 | 3.9 | <15 min fix | 2 | 67 | sympy/simplify/tests/test_fu.py<br>sympy/simplify/tests/test_simplify.py |
| 4 | sympy__sympy-19954 | sympy/sympy | 1.7 | 3.9 | <15 min fix | 1 | 56 | sympy/combinatorics/tests/test_perm_groups.py |
| 5 | sympy__sympy-11618 | sympy/sympy | 1.0 | 3.9 | 15 min - 1 hour | 1 | 4 | sympy/geometry/tests/test_point.py |
| 6 | sympy__sympy-13798 | sympy/sympy | 1.1 | 3.9 | 15 min - 1 hour | 1 | 102 | sympy/printing/tests/test_latex.py |
| 7 | sympy__sympy-16792 | sympy/sympy | 1.5 | 3.9 | 15 min - 1 hour | 1 | 54 | sympy/utilities/tests/test_codegen.py |
| 8 | sympy__sympy-20428 | sympy/sympy | 1.8 | 3.9 | 15 min - 1 hour | 1 | 154 | sympy/polys/tests/test_polytools.py |
| 9 | sympy__sympy-22080 | sympy/sympy | 1.10 | 3.9 | 15 min - 1 hour | 3 | 91 | sympy/codegen/tests/test_rewriting.py<br>sympy/printing/tests/test_pycode.py<br>sympy/utilities/tests/test_lambdify.py |
| 10 | sympy__sympy-12489 | sympy/sympy | 1.0 | 3.9 | 1-4 hours | 1 | 8 | sympy/combinatorics/tests/test_permutations.py |
| 11 | django__django-14787 | django/django | 4.1 | 3.9 | <15 min fix | 1 | 20 | tests/decorators/tests.py |
| 12 | django__django-15315 | django/django | 4.1 | 3.9 | <15 min fix | 1 | 33 | tests/model_fields/tests.py |
| 13 | django__django-15572 | django/django | 4.1 | 3.9 | <15 min fix | 1 | 10 | tests/template_tests/test_autoreloader.py |
| 14 | django__django-16100 | django/django | 4.2 | 3.9 | <15 min fix | 1 | 59 | tests/admin_changelist/tests.py |
| 15 | django__django-14725 | django/django | 4.1 | 3.9 | 15 min - 1 hour | 3 | 64 | tests/model_formsets/tests.py |
| 16 | django__django-15103 | django/django | 4.1 | 3.9 | 15 min - 1 hour | 2 | 17 | tests/template_tests/filter_tests/test_json_script.py<br>tests/utils_tests/test_html.py |
| 17 | django__django-15375 | django/django | 4.1 | 3.9 | 15 min - 1 hour | 1 | 95 | tests/aggregation/tests.py |
| 18 | django__django-15563 | django/django | 4.1 | 3.9 | 15 min - 1 hour | 2 | 29 | tests/model_inheritance_regress/tests.py |
| 19 | django__django-15916 | django/django | 4.2 | 3.9 | 15 min - 1 hour | 2 | 149 | tests/model_forms/tests.py |
| 20 | django__django-15128 | django/django | 4.1 | 3.9 | 1-4 hours | 1 | 282 | tests/queries/models.py<br>tests/queries/tests.py |
| 21 | pytest-dev__pytest-10081 | pytest-dev/pytest | 7.2 | 3.9 | <15 min fix | 1 | 63 | testing/test_unittest.py |
| 22 | pytest-dev__pytest-7205 | pytest-dev/pytest | 5.4 | 3.9 | <15 min fix | 10 | 16 | testing/test_setuponly.py |
| 23 | pytest-dev__pytest-10051 | pytest-dev/pytest | 7.2 | 3.9 | 15 min - 1 hour | 1 | 15 | testing/logging/test_fixture.py |
| 24 | pytest-dev__pytest-7324 | pytest-dev/pytest | 5.4 | 3.9 | 15 min - 1 hour | 3 | 58 | testing/test_mark_expression.py |
| 25 | pytest-dev__pytest-10356 | pytest-dev/pytest | 7.2 | 3.9 | 1-4 hours | 1 | 79 | testing/test_mark.py |
| 26 | pylint-dev__pylint-4970 | pylint-dev/pylint | 2.10 | 3.9 | <15 min fix | 1 | 17 | tests/checkers/unittest_similar.py |
| 27 | pylint-dev__pylint-4604 | pylint-dev/pylint | 2.9 | 3.9 | 15 min - 1 hour | 21 | 0 | tests/checkers/unittest_variables.py |
| 28 | pylint-dev__pylint-6386 | pylint-dev/pylint | 2.14 | 3.9 | 15 min - 1 hour | 1 | 7 | tests/config/test_config.py |
| 29 | psf__requests-1142 | psf/requests | 1.1 | 3.9 | <15 min fix | 1 | 5 | test_requests.py |
| 30 | psf__requests-2931 | psf/requests | 2.9 | 3.9 | 15 min - 1 hour | 1 | 84 | test_requests.py |
