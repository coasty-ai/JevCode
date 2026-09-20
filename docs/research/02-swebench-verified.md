# SWE-bench Verified: dataset, harness, formats (research notes)

Fetched 2026-09-19 unless stated otherwise. Every claim carries its source URL. Items marked **UNVERIFIED** could not be confirmed from a primary source; what was tried is stated.

Context for JevCode: macOS arm64, no Docker, system Python 3.9.6. The official harness (`swebench` 5.x) requires Python >=3.10 and Docker (or Modal), so local official grading is not possible as-is; see section 6 for the realistic paths (sb-cli remote eval, Modal, or a hand-rolled pip-based runner for the light repos).

---

## 1. Dataset

| Item | Value | Source |
|---|---|---|
| Canonical HF id | `princeton-nlp/SWE-bench_Verified` (lastModified 2025-02-18T23:48:55Z, 281,069 downloads, 387 likes) | https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified (fetched 2026-09-19) |
| Mirror used by swebench v5 CLI | `SWE-bench/SWE-bench_Verified` (lastModified 2026-08-16T04:23:43Z); the `verified` alias resolves to this | https://huggingface.co/api/datasets/SWE-bench/SWE-bench_Verified ; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/cli/_datasets.py (fetched 2026-09-19) |
| Split / rows | single split `test`, `num_examples: 500`, `num_rows_total: 500` | https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test&offset=0&length=2 (fetched 2026-09-19) |
| Size | parquet 2,096,679 bytes; in-memory 7,779,763 bytes; one file `data/test-00000-of-00001.parquet` | https://datasets-server.huggingface.co/size?dataset=princeton-nlp/SWE-bench_Verified (fetched 2026-09-19) |
| Direct parquet URL | `https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet` (302 -> CDN, content-length 2096679) | HEAD request 2026-09-19 |
| License (dataset card) | **UNVERIFIED / not declared**: `cardData.license` is `null` and there is no `license:*` tag on either HF id; the dataset README has no license field. The SWE-bench code repo is MIT (`LICENSE`: "MIT License, Copyright (c) 2023 Carlos E Jimenez, John Yang, ..."). Treat the dataset as MIT-adjacent but undeclared. | https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified ; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/LICENSE (fetched 2026-09-19) |
| Origin | "[Aug. 13, 2024]: Introducing SWE-bench Verified! Part 2 of our collaboration with OpenAI Preparedness. A subset of 500 problems that real software engineers have confirmed are solvable." | https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/README.md (fetched 2026-09-19); OpenAI post https://openai.com/index/introducing-swe-bench-verified/ returned HTTP 403 to WebFetch on 2026-09-19 (UNVERIFIED direct quote) |

### 1.1 Fields (exact, from the datasets-server `features` array, in order)

Quoted from https://datasets-server.huggingface.co/first-rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test (fetched 2026-09-19): `['repo', 'instance_id', 'base_commit', 'patch', 'test_patch', 'problem_statement', 'hints_text', 'created_at', 'version', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'environment_setup_commit', 'difficulty']`. All 13 are `{"dtype": "string", "_type": "Value"}`.

| Field | Type | Meaning (dataset card) / observed example (row 0, `astropy__astropy-12907`) |
|---|---|---|
| `repo` | string | `"astropy/astropy"` |
| `instance_id` | string | `"astropy__astropy-12907"` ("usually as repo_owner__repo_name-PR-number") |
| `base_commit` | string | `"d16bfe05a744909de4b27f5875fe0d4ed41ce607"` (HEAD before the fix PR) |
| `patch` | string | gold patch, unified diff starting `diff --git a/astropy/modeling/separable.py ...` |
| `test_patch` | string | test-file diff from the PR |
| `problem_statement` | string | issue title + body (contains `\r\n`) |
| `hints_text` | string | issue comments before the PR's first commit; empty string for 162/500 rows |
| `created_at` | string | ISO-8601 `"2022-03-03T15:14:54Z"`; range across dataset 2013-01-25 .. 2023-08-07 |
| `version` | string | e.g. `"4.3"`; keys the install spec |
| `FAIL_TO_PASS` | string | **JSON-encoded list as a string**, e.g. `'["astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]", ...]'`. All 500 rows `json.loads` cleanly (0 failures). |
| `PASS_TO_PASS` | string | same encoding as FAIL_TO_PASS |
| `environment_setup_commit` | string | `"298ccb478e6bf092953bca67a3d29dc6c35f6752"` |
| `difficulty` | string | one of `"<15 min fix"` (194), `"15 min - 1 hour"` (261), `"1-4 hours"` (42), `">4 hours"` (3) |

Sources: field descriptions from https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/raw/main/README.md; values/counts computed from all 500 rows paged via the `/rows` endpoint (offset 0..400, length 100) on 2026-09-19.

Note: in the v5 task repo the same data is split into `task.yaml` (short fields), `tests.json` (`{"FAIL_TO_PASS": [...], "PASS_TO_PASS": [...]}` as real JSON arrays), `problem_statement.md`, `gold.patch`, `test.patch`, `eval.sh`, `Dockerfile`, `environment.yml` (https://github.com/SWE-bench/swe-bench-tasks/tree/main/tasks/django__django-11099, fetched 2026-09-19).

### 1.2 Instances per repo (computed from all 500 rows, 2026-09-19)

| repo | n | `version` values present in Verified |
|---|---|---|
| django/django | 231 | 1.11(1), 2.2(1), 3.0(36), 3.1(32), 3.2(43), 4.0(36), 4.1(34), 4.2(24), 5.0(24) |
| sympy/sympy | 75 | 1.0(5), 1.1(16), 1.2(2), 1.4(6), 1.5(10), 1.6(5), 1.7(7), 1.8(4), 1.9(5), 1.10(4), 1.11(3), 1.12(8) |
| sphinx-doc/sphinx | 44 | 3.0..5.2, 7.1, 7.2 |
| matplotlib/matplotlib | 34 | 3.0(1), 3.1(1), 3.4(5), 3.5(7), 3.6(9), 3.7(11) |
| scikit-learn/scikit-learn | 32 | 0.20(5), 0.21(8), 0.22(12), 1.3(7) |
| astropy/astropy | 22 | 1.3(4), 3.1(2), 4.3(2), 5.0(4), 5.1(8), 5.2(2) |
| pydata/xarray | 22 | 0.12(13), 2022.03(2), 2022.06(4), 2022.09(3) |
| pytest-dev/pytest | 19 | 4.5, 4.6, 5.0, 5.1, 5.2, 5.4, 6.0, 6.2, 6.3, 7.2 |
| pylint-dev/pylint | 10 | 2.9(2), 2.10(2), 2.14(2), 2.15(3), 3.0(1) |
| psf/requests | 8 | 1.1, 2.0(2), 2.3, 2.4, 2.9, 2.26, 2.27 |
| mwaskom/seaborn | 2 | 0.12 |
| pallets/flask | 1 | 2.3 |

---

## 2. Official harness

| Item | Value | Source |
|---|---|---|
| PyPI `swebench` | **5.0.2**, uploaded 2026-08-18T19:30:37, `requires_python: >=3.10`; hard deps include `docker`, `datasets`, `modal`, `typer`, `rich`, `unidiff`, `GitPython`, `ghapi<2` | https://pypi.org/pypi/swebench/json (fetched 2026-09-19) |
| Recent versions | 4.0.4, 4.0.5, 4.1.0, 5.0.0, 5.0.1, 5.0.2 | same |
| Git tags | `v5.0.1`, `v5.0.0`, `v4.1.0`, ... (no `v5.0.2` tag; `swebench/__init__.py` on main says `__version__ = "5.0.2"`). GitHub Releases page is empty ("There aren't any releases here"). | https://api.github.com/repos/SWE-bench/SWE-bench/tags ; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/__init__.py ; https://github.com/SWE-bench/SWE-bench/releases (fetched 2026-09-19) |
| CHANGELOG 5.0.0 (8/17/2026) | "Task repos hold one directory per instance under `tasks/`... `task.yaml` for the short fields, `tests.json` for FAIL_TO_PASS and PASS_TO_PASS"; "Dataset aliases are now `full`, `verified`, `multilingual` and `multimodal`"; "Image building moved to `swebench.image_builder`, with an `ImageSpec` that supports amd64 and arm64"; "Committed dataset parquets removed. HuggingFace is the source of truth." Grading fixes: "A patch can no longer pass by printing its own `PASSED` lines... (#620)". | https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/CHANGELOG.md (fetched 2026-09-19) |
| CHANGELOG [Unreleased] | results file moves to `logs/evaluation/<run_id>/results.json`; eval logs to `logs/evaluation/<run_id>`; adds `swebench infer` (mini-SWE-agent) and `swebench submit package|publish|register|verify`. | same |
| PyPI `sb-cli` | **0.1.5**, uploaded 2025-05-14T00:58:57, `requires_python >=3.10`, deps `click<8.2.0, requests, rich, typer>=0.9.0` | https://pypi.org/pypi/sb-cli/json (fetched 2026-09-19) |
| PyPI `mini-swe-agent` | **2.4.6**, uploaded 2026-07-23, `requires_python >=3.10` | https://pypi.org/pypi/mini-swe-agent/json (fetched 2026-09-19) |
| Docker requirement | "SWE-bench uses Docker for reproducible evaluations." Recommended: x86_64, 120GB free disk, 16GB RAM, 8 cores; "Support for `arm64` machines is experimental." | https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/README.md (fetched 2026-09-19) |
| Apple Silicon note | "The current v5 CLI builds images from a task repo. On an M-series Mac or another ARM-based system, use `--task-repo` so the images are built locally with Docker Buildx." `ImageSpec.arch in ["amd64","arm64"]`; arm64 -> `platform linux/arm64/v8`; amd64 images keep the `x86_64` name. | README above; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/image_builder/image_spec.py (fetched 2026-09-19) |

### 2.1 Prediction file format

Loader: `swebench/harness/utils.py::get_predictions_from_file` accepts `"gold"`, a `.json` file (`json.load`), or otherwise JSONL (https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/utils.py, fetched 2026-09-19). CLI help: `-p/--predictions "Path to a predictions .json/.jsonl"` (https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/cli/evaluate.py).

Required keys per record (docs/guides/evaluation.md, fetched 2026-09-19):

```json
{"instance_id": "sympy__sympy-20590", "model_name_or_path": "gpt-4", "model_patch": "diff --git a/sympy/core/sympify.py ...\n"}
```

`model_name_or_path` is used as a log directory name (`/` replaced by `__`), so keep it filesystem-safe. Empty/`null` `model_patch` is counted as `empty_patch_instances` and never run (reporting.py). sb-cli additionally accepts a dict keyed by instance_id: `{"instance_id_1": {"model_patch": "...", "model_name_or_path": "..."}}` (https://raw.githubusercontent.com/swe-bench/sb-cli/main/README.md, fetched 2026-09-19).

### 2.2 Evaluation command lines (verbatim from README / docs, fetched 2026-09-19)

```bash
pip install swebench                                    # needs Python >=3.10 + Docker
swebench eval verified -p <path_to_predictions> --run-id <run_id> -j <num_workers>
swebench eval verified --gold -i sympy__sympy-20590 --run-id validate-gold --task-repo ./swe-bench-tasks
swebench report <run_id> -d verified                    # re-grade saved logs, no containers
# legacy form, still supported ("takes the same arguments as before"):
python -m swebench.harness.run_evaluation \
    --dataset_name princeton-nlp/SWE-bench_Verified \
    --predictions_path <path_to_predictions> \
    --max_workers 8 --run_id my_evaluation_run
# specific instances (space separated; example from docs/guides/evaluation.md, not the README):
python -m swebench.harness.run_evaluation --predictions_path preds.jsonl --instance_ids astropy__astropy-14539 sympy__sympy-20590 --max_workers 2 --run_id x
```

`swebench eval` options: `--gold`, `-p/--predictions`, `-r/--run-id` (default `run`), `-i/--instance` (repeatable), `-s/--split` (default `test`), `-j/--workers` (default 4), `-t/--timeout` (default 1800 s per instance), `--task-repo`, `--modal`, `--open-file-limit` (https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/cli/evaluate.py, fetched 2026-09-19). Results are cached by `(run_id, instance_id)` -- reuse of a run_id with a different patch is NOT re-evaluated (README).

### 2.3 Where the per-instance specs live now

- **v5 (current):** `swebench/harness/constants/` on `main` contains only `__init__.py` (enums/markers) and `fixtures/` (Rust Cargo.lock files). The Python install specs moved to the task-data repo: https://github.com/SWE-bench/swe-bench-tasks -- `dockerfile_gen/constants.py` (1107 lines; `MAP_REPO_VERSION_TO_SPECS`, 20 repos; keys `python`, `packages`, `pip_packages`, `install`, `pre_install`, `test_cmd`) at https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/dockerfile_gen/constants.py, plus one generated dir per instance `tasks/<instance_id>/{task.yaml,tests.json,eval.sh,Dockerfile,environment.yml,gold.patch,test.patch,problem_statement.md}` (**2,519 task dirs** = the full SWE-bench test (2,294) + dev (225) sets; all 500 Verified ids are present -- counted from a `git clone --filter=tree:0` of https://github.com/SWE-bench/swe-bench-tasks on 2026-09-19. `sweb.yaml` lists datasets `SWE-bench/SWE-bench`, `SWE-bench_Lite`, `SWE-bench_Verified` and splits `dev`, `test`). Fetched 2026-09-19.
- **v4.1.0 (last monolithic):** https://github.com/SWE-bench/SWE-bench/blob/v4.1.0/swebench/harness/constants/python.py (1452 lines; `SPECS_DJANGO`, `SPECS_SYMPY`, ..., `MAP_REPO_VERSION_TO_SPECS_PY`, `TEST_DJANGO`, `TEST_PYTEST`, `TEST_SYMPY`). Fetched 2026-09-19. Python versions agree exactly with the v5 task-repo file for all Verified repo/version pairs (checked programmatically).
- `task.yaml` fields (django__django-11099): `base_commit, created_at, datasets, difficulty, environment_setup_commit, eval_type: pass_and_fail, image: swebench/sweb.eval.x86_64.django_1776_django-11099:latest, instance_id, log_parser: parse_log_django, repo, split, version` (https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/tasks/django__django-11099/task.yaml, fetched 2026-09-19).

### 2.4 Docker images

- Naming: `docker.io/swebench/sweb.eval.x86_64.<instance_id with "__" -> "_1776_">:latest` (mini-swe-agent `get_swebench_docker_image_name`, https://raw.githubusercontent.com/SWE-agent/mini-swe-agent/main/src/minisweagent/run/benchmarks/swebench.py, fetched 2026-09-19).
- Docker Hub `swebench` org has 4,503 repositories. `sweb.eval.x86_64.django_1776_django-11099` tags: `latest` (2026-08-16, amd64 1.15 GB plus an `unknown/unknown` attestation manifest), `v2` (2025-09-10, amd64), `v1` (2025-01-04, amd64) -- **amd64 only, no arm64 image** (https://hub.docker.com/v2/repositories/swebench/sweb.eval.x86_64.django_1776_django-11099/tags, fetched 2026-09-19).
- arm64: 281 repos match `arm64` (e.g. `swebench/sweb.eval.arm64.django_1776_django-15037:latest`, arch `arm64`, built 2025-04-20). First 100 enumerated: sympy 59, django 38, pytest-dev 3; all 100 are Verified instance ids. Anonymous API refused deeper pagination ("pagination offset too large for anonymous requests") so full coverage is **UNVERIFIED** (upper bound 281/500). https://hub.docker.com/v2/repositories/swebench/?page_size=100&name=arm64 (fetched 2026-09-19).
- Task-repo Dockerfiles are pinned `FROM --platform=linux/amd64 ubuntu:jammy` + Miniconda py311 x86_64; env is a conda env `testbed` (e.g. `python=3.6.13` for django 3.0) (https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/tasks/django__django-11099/Dockerfile, fetched 2026-09-19).

---

## 3. Pass/fail semantics, log parsers, results JSON

Source: https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/grading.py (fetched 2026-09-19).

- `get_resolution_status`: "If fail-to-pass (Resolution) = 1 and pass-to-pass (Maintenance) = 1 -> FULL; If (f2p < 1 and > 0) and p2p = 1 -> PARTIAL; Otherwise -> NO". Only `RESOLVED_FULL` sets `"resolved": true`.
- `test_passed`: status in `{PASSED, XFAIL}`. `test_failed`: missing from the status map OR status in `{FAILED, ERROR, SKIPPED}` ("a skipped F2P test is not a resolution"). For P2P, `test_maintained` additionally accepts `SKIPPED`.
- `_resolve_case` prefix-matches truncated parametrized ids ("676 expected ids in SWE-bench_Verified are truncated mid-parameter (issue #290)").
- The run is invalid (`{}, False`) if the log contains any of `>>>>> Patch Apply Failed`, `>>>>> Reset Failed`, `>>>>> Tests Errored`, `>>>>> Tests Timed Out`, lacks both `>>>>> Start Test Output` / `>>>>> End Test Output`, or the recorded `>>>>> Test Exit Code: N` is non-zero while the parsed log shows no FAILED/ERROR (anti-spoofing, #620). Markers are defined in https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/constants/__init__.py.
- Patch application tries, in order: `git apply --verbose`, `git apply --verbose --3way`, `git apply --verbose --reject`, `patch --batch --forward --fuzz=5 -p1 -i` (`GIT_APPLY_CMDS`, https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/run_evaluation.py lines 54-59, fetched 2026-09-19).
- Log parsers: `swebench/harness/log_parsers/python.py` with `PARSER_REGISTRY` in `log_parsers/__init__.py`; per-repo map `MAP_REPO_TO_PARSER_PY` = astropy->`parse_log_astropy`, django->`parse_log_django`, matplotlib->`parse_log_matplotlib`, seaborn->`parse_log_seaborn`, flask->`parse_log_flask`, requests->`parse_log_requests`, xarray->`parse_log_xarray`, pylint->`parse_log_pylint`, pytest->`parse_log_pytest`, scikit-learn->`parse_log_scikit`, sphinx->`parse_log_sphinx`, sympy->`parse_log_sympy` (fetched 2026-09-19). Pytest-style parsers key on lines starting with `PASSED`/`FAILED`/`ERROR`/`SKIPPED`/`XFAIL` (hence `pytest -rA`).
- Per-instance `report.json` (grading.py `get_eval_report`): `{"<instance_id>": {"patch_is_None": bool, "patch_exists": bool, "patch_successfully_applied": bool, "resolved": bool, "infra_failure": bool, ["infra_failure_reason": str], ["tests_status": {"FAIL_TO_PASS": {"success": [...], "failure": [...]}, "PASS_TO_PASS": {...}, "FAIL_TO_FAIL": {...}, "PASS_TO_FAIL": {...}}]}}`.
- Run summary `logs/evaluation/<run_id>/results.json` (reporting.py, fetched 2026-09-19), keys: `total_instances, submitted_instances, completed_instances, resolved_instances, unresolved_instances, infra_failure_instances, ambiguous_failure_instances, empty_patch_instances, error_instances, completed_ids, incomplete_ids, empty_patch_ids, submitted_ids, resolved_ids, unresolved_ids, infra_failure_ids, ambiguous_failure_ids, failure_reasons, error_ids, schema_version: 2` (+ `unstopped_instances, unstopped_containers, unremoved_images` when a Docker client is present).
- Per-instance log dir: `logs/evaluation/<run_id>/<model_name_or_path>/<instance_id>/{report.json,test_output.txt,run_instance.log,eval.sh,patch.diff}` (docs/guides/evaluation.md, fetched 2026-09-19).

---

## 4. Lightest repos to run without Docker (pip-installable, pure Python)

Python version per Verified repo/version from `MAP_REPO_VERSION_TO_SPECS` (https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/dockerfile_gen/constants.py, fetched 2026-09-19; identical in v4.1.0 `constants/python.py`):

| repo | n | Python per version | install | test_cmd | Local feasibility (no Docker) |
|---|---|---|---|---|---|
| django/django | 231 | 1.11,2.2->3.5; 3.0,3.1,3.2->3.6; 4.0->3.8; 4.1,4.2->3.9; 5.0->3.11 | `python -m pip install -e .` (`packages: requirements.txt`) | `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1` | Best target: pure Python, sqlite; 82 instances on 3.9/3.11 (4.1/4.2/5.0) run on stock interpreters. 3.x needs py3.6 via pyenv. |
| sympy/sympy | 75 | all -> 3.9 | `python -m pip install -e .`; pip `mpmath==1.3.0`, `flake8-comprehensions` | `PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose` | Excellent: pure Python, py3.9 matches system 3.9.6. Custom parser `parse_log_sympy`. |
| psf/requests | 8 | all -> 3.9 | `python -m pip install .` (`packages: pytest`) | `pytest -rA` | Easy, but `psf__requests-2317` needs network (`httpbin.org`) per task-repo CHANGELOG "Known issues". |
| pytest-dev/pytest | 19 | all -> 3.9 | `python -m pip install -e .`; pins `attrs==23.1.0, iniconfig==2.0.0, packaging==23.1, pluggy==0.13.1, py==1.11.0, tomli==2.0.1` (7.2) | `pytest -rA` | Easy, pure Python. |
| pylint-dev/pylint | 10 | all -> 3.9 | `python -m pip install -e .`; 3.0 pins `astroid==3.0.0a6` | `pytest -rA` | Easy. |
| pallets/flask | 1 | 2.3 -> 3.11 | `python -m pip install -e .`; pins Werkzeug 2.3.7 etc. | `pytest -rA` | Easy, needs py3.11. |
| sphinx-doc/sphinx | 44 | all -> 3.9 | `python -m pip install -e .[test]`; pre_install `sed -i 's/pytest/pytest -rA/' tox.ini`, `apt-get install -y graphviz`; pins `tox==4.16.0`, `tox-current-env==0.0.11`, `Jinja2==3.0.3` | `tox --current-env -epy39 -v --` | Medium: tox wrapper + graphviz (brew). |
| pydata/xarray | 22 | all -> 3.10 | `python -m pip install -e .`; pins `numpy==1.23.0, pandas==1.5.3, pytest==7.4.0` ... | `pytest -rA` | Medium: numpy/pandas wheels exist for arm64 py3.10, but old pins may not. |
| astropy/astropy | 22 | 1.3 -> 3.6; others -> 3.9 | `python -m pip install -e .[test] --verbose`; pins numpy 1.25.2 etc. | `pytest -rA -vv -o console_output_style=classic --tb=no` | Hard: C extensions compiled from source. |
| matplotlib/matplotlib | 34 | 3.0->3.7; 3.1,3.4->3.8; 3.5..3.7->3.11 | `python -m pip install -e .` + apt pre_install (freetype, ghostscript...) | `pytest -rA` | Hard: C/C++ build, system libs, tzdata pin issue (task-repo CHANGELOG 2026-08-13). |
| scikit-learn/scikit-learn | 32 | 0.20-0.22 -> 3.6; 1.3 -> 3.9 | `python -m pip install -v --no-use-pep517 --no-build-isolation -e .` (cython, numpy, scipy) | `pytest -rA` | Hard: Cython build, py3.6 for 25/32. |
| mwaskom/seaborn | 2 | 0.12 -> 3.9 | `python -m pip install -e .[dev]` | `pytest --no-header -rA` | Medium (matplotlib dep). |

Practical 30-task subset for a no-Docker Mac: draw from sympy (75, py3.9), django 4.1/4.2 (58, py3.9), pytest (19), pylint (10), requests (7 excluding -2317); these are 169 instances all runnable on Python 3.9 with `pip install -e .`. Note the official eval also applies `test_patch` before running and checks out the test files at `base_commit` first (see `eval.sh` pattern: `git checkout <base_commit> <test files>; git apply -v - <<EOF ... EOF; : '>>>>> Start Test Output'; <test_cmd> <test files>; : '>>>>> End Test Output'`, https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/main/tasks/django__django-11099/eval.sh, fetched 2026-09-19).

---

## 5. Leaderboard (swebench.com) and Verified rules

Data source: the leaderboard JSON is inlined in https://www.swebench.com/ (2.3 MB script; boards `Multilingual` 13, `Test` 24, `Verified` 180, `Lite` 84, `Multimodal` 22 entries; fetched 2026-09-19). Entry fields: `agent, agent_org, checked, cost, date, folder, instance_calls, instance_cost, logo, logs, mini-swe-agent_version, model_display, model_org, model_release_date, name, os_model, os_system, per_instance_details, reasoning_effort, resolved, site, tags, trajs, trajs_docent, warning`.

**Newest Verified entry on the official board is dated 2026-02-26**; there are no official entries from March-September 2026 (the experiments repo has 182 folders under `evaluation/verified`, of which one -- `20260901_mini-v2.4.2_gemini-3-5-flash` -- is newer than the board and not yet on the site: https://github.com/swe-bench/experiments/tree/main/evaluation/verified, listed via `git ls-tree` on a treeless clone, 2026-09-19; note the GitHub HTML tree view truncates this directory and does not show the 2026 folders). Top official entries by `resolved` (% of 500), complete down to 75.6% (re-parsed from the inline JSON on 2026-09-19):

| % | date | entry | checked | open scaffold |
|---|---|---|---|---|
| 79.2 | 2025-12-05 | Sonar Foundation Agent + Claude 4.5 Opus | false | no |
| 79.2 | 2025-12-15 | live-SWE-agent + Claude 4.5 Opus medium | false | yes |
| 78.8 | 2025-09-28 | TRAE + Doubao-Seed-Code | false | yes |
| 77.4 | 2025-11-20 | live-SWE-agent + Gemini 3 Pro Preview | false | yes |
| 76.8 | 2025-08-04 | EPAM AI/Run Developer Agent + Claude 4 Sonnet | false | no |
| 76.8 | 2025-09-02 | Atlassian Rovo Dev | false | no |
| 76.8 | 2026-02-17 | mini-SWE-agent v2.0.0 + Claude 4.5 Opus (high), cost $377 | null (mini run) | yes |
| 76.4 | 2025-08-19 | ACoder (model: Multiple) | false | no |
| 75.8 | 2026-02-17 | mini-SWE-agent v2.0.0 + Gemini 3 Flash (high), $178 | null | yes |
| 75.8 | 2026-02-17 | mini-SWE-agent v2.0.0 + MiniMax M2.5 (high), $37 | null | yes |
| 75.6 | 2025-09-01 | Warp (model: Multiple) | false | no |
| 75.6 | 2026-02-17 | mini-SWE-agent v2.0.0 + Claude 4.6 Opus, $276 | null | yes |
| 74.4 | 2025-11-24 | mini-SWE-agent v1.16.0 + Claude 4.5 Opus (medium), $361 | **true** | yes |

Reference point for JevCode's generator model family: mini-SWE-agent v2.0.0 + Claude 4.5 Sonnet (high) = 71.4% (2026-02-17); + GPT 5.2 (high) = 72.8%. `checked` values across the 180 Verified entries: `true` **60**, `false` 97, `null` 17 (all mini-SWE-agent v2.0.0 runs), and 6 entries carry the string `"false (See README.md for info on how to get your results verified)"` (e.g. live-SWE-agent + Gemini 3 Pro Preview). So only **60/180** are checked (the earlier figure 66 was wrong; re-parsed from the inline JSON, 2026-09-19). 47 of the 180 entries have `agent == "mini-SWE-agent"`.

Rules (primary sources, fetched 2026-09-19):
- "Checked" badge = `title="The agent run was performed by or directly checked by the SWE-bench team"`; other badges: "Open-weights model" (`os_model`), "Open scaffold" (`os_system`) -- https://www.swebench.com/js/mainResults.js, https://www.swebench.com/js/leaderboardFilters.js.
- Verified board description: "Verified is a human-filtered subset of 500 instances ... Defaults to bash-only setting (run with mini-SWE-agent)." The old "Bash Only" board is now a filter on Verified (leaderboardFilters.js; experiments README).
- To get the checkmark: "1. Create an issue 2. ... provide us instructions on how to run your model on SWE-bench. 3. We will run your model on a random subset of SWE-bench and verify the results." (https://raw.githubusercontent.com/swe-bench/experiments/main/README.md).
- Submission policy since 11/18/2025: "SWE-bench Verified and Multilingual now only accepts submissions from academic teams and research institutions with open source methods and peer-reviewed publications" (arXiv/tech report + academic or established-lab affiliation). Reasoning traces (`trajs/`) required since 7/29/2024; entries tagged `System: Attempts - 1` vs `Attempts - 2+`. Submission is via `swebench submit package|publish|register`, artifacts (`all_preds.jsonl`, `logs/<id>/{patch.diff,report.json,test_output.txt.gz}`, `trajs/`) live in the submitter's public repo; `swebench submit verify ... -s verified` re-grades from logs "No Docker, no re-execution." (same README).

Third-party trackers report much higher, vendor-self-reported numbers not on the official board -- e.g. BenchLM (page dated 2026-09-18): Claude Opus 5 96%, Claude Mythos 5 95.5%, Claude Fable 5 95%, Claude Sonnet 5 85.2%, GPT-5.3 Codex 85% (https://benchlm.ai/benchmarks/swe-bench-verified, fetched 2026-09-19). **UNVERIFIED** against any primary artifact; the page does not state its sources. Do not cite these as leaderboard results.

---

## 6. Running without local Docker (our situation)

1. **sb-cli remote evaluation (recommended for official numbers).** `pip install sb-cli` (py>=3.10); `sb-cli gen-api-key you@example.com`; `export SWEBENCH_API_KEY=...`; `sb-cli verify-api-key CODE`; then `sb-cli submit swe-bench_verified test --predictions_path preds.json --run_id my_run` and `sb-cli get-report swe-bench_verified test my_run -o ./reports`. Subsets enum: `swe-bench-m`, `swe-bench_lite`, `swe-bench_verified`; splits `dev`, `test` ("test ... currently only available for swe-bench_lite and swe-bench_verified"). API base `https://api.swebench.com` (`SWEBENCH_API_URL` env override); the client polls `/poll-jobs` every 8 s while waiting for evaluation (`submit.py` line 212) and every 15 s in the second wait loop (line 251). Report fields printed: `resolved_instances, total_instances, submitted_instances, error_instances, pending_instances, completed_instances, failed_instances`. Quotas exist: the quota command is **`sb-cli get-quotas`** (`sb_cli/get_quotas.py`, registered as `get-quotas` in `sb_cli/__init__.py`; the README's `sb-cli quota swe-bench-m test` does not exist in 0.1.5). https://www.swebench.com/sb-cli/submit-to-leaderboard/ says "Quotas are reloaded every 30 days"; `docs/user-guide/get-quotas.md` says "Quotas are refreshed periodically according to your subscription level" and its *example* output shows `swe-bench_verified | test | 1` remaining run (and ~1000 `dev` runs for the other subsets). Actual per-key quota numbers **UNVERIFIED** (only the example table; no policy statement). Note the sb-cli README (line 49) says `test` is "currently only available for `swe-bench_lite` and `swe-bench_verified`" while `docs/user-guide/index.md` still says only `swe-bench_lite`. Sources: https://raw.githubusercontent.com/swe-bench/sb-cli/main/README.md, .../sb_cli/config.py, .../sb_cli/submit.py, .../sb_cli/get_report.py, https://www.swebench.com/sb-cli/submit-to-leaderboard/ (fetched 2026-09-19).
2. **Modal cloud eval.** `pip install modal swebench[modal]`, `modal setup`, then `swebench eval verified -p preds.jsonl --run-id x --modal` (or `python -m swebench.harness.run_evaluation ... --modal true`). Images are built remotely from `modal.Image.from_registry("ubuntu:22.04", add_python="3.11")` + Miniconda x86_64, so no local Docker is needed; `--modal` cannot be combined with `--task-repo`. Sources: docs/guides/evaluation.md; https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/modal_eval/run_evaluation_modal.py; run_evaluation.py `main()` (fetched 2026-09-19). Requires Python >=3.10 locally for the `swebench` package.
3. **mini-swe-agent as a reference runner.** `mini-extra swebench --subset verified --split test --workers 4 -m <model>`; `mini-extra swebench-single --subset verified --split test -m <model> -i sympy__sympy-15599`. Default `environment_class: docker`; alternatives `singularity`, `local`, `swerex_docker`, `swerex_modal`, `bubblewrap`, `contree` (`_ENVIRONMENT_MAPPING`). Only docker/swerex_modal/singularity/contree get the SWE-bench image injected; `local` runs commands on the host (`LocalEnvironment`, `cwd`, `timeout: 30`), so a local checkout at `base_commit` would be needed. Writes `preds.json` as `{instance_id: {"model_name_or_path": ..., "model_patch": ...}}` plus `<id>/<id>.traj.json`. `subset` mapping: `"verified": "princeton-nlp/SWE-Bench_Verified"`. Sources: https://mini-swe-agent.com/latest/usage/swebench/; https://raw.githubusercontent.com/SWE-agent/mini-swe-agent/main/src/minisweagent/run/benchmarks/swebench.py; .../environments/__init__.py; .../environments/local.py (fetched 2026-09-19). The v5 harness also wraps it: `swebench infer verified -m gpt-5 -o preds -w 8` (README).
4. **`swebench.inference`** (`run_api.py`, `run_llama.py`, `run_live.py`) is the old non-agentic, retrieval-prompt inference path (`python -m swebench.inference.run_api --dataset_name_or_path princeton-nlp/SWE-bench_oracle --model_name_or_path claude-2 --output_dir ./outputs`); not a harness alternative for agents (https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/docs/reference/inference.md, fetched 2026-09-19).
5. **Hand-rolled local grading** (development only): for the py3.9 repos in section 4, replicate `eval.sh`: clone repo, `git checkout <base_commit>`, create venv with the spec's Python, run spec `install` + `pip_packages`, `git apply` model patch, `git checkout <base_commit> -- <test files>`, `git apply` `test_patch`, run `test_cmd` + test files, parse with the same `parse_log_*` rules, and apply the FULL rule (all F2P pass, all P2P pass-or-skipped). Report these numbers as "local, unofficial"; confirm with sb-cli before publishing.

Open questions / UNVERIFIED: dataset license (undeclared); full arm64 image coverage (281 repos found, 100 enumerated); sb-cli quota sizes (only an example table showing 1 `swe-bench_verified test` run); OpenAI Verified post text (403 on 2026-09-19, twice); whether `swebench` 5.0.2 has a matching git tag (none found via `git ls-remote --tags`, 2026-09-19).

---

## Verification log (2026-09-19)

Adversarial re-check of every version, date, count, field, URL and command against primary sources (curl of PyPI JSON, HF API, datasets-server, raw.githubusercontent.com, Docker Hub v2 API, swebench.com inline JSON; `git ls-remote`/blobless clones where api.github.com was rate-limited). Dataset statistics recomputed locally with pyarrow from the 2,096,679-byte parquet.

Corrections made:
1. Section 2.3: swe-bench-tasks has **2,519** `tasks/` dirs (full SWE-bench test+dev), not "1000 = Verified+Lite union". All 500 Verified ids present. Source: treeless clone of https://github.com/SWE-bench/swe-bench-tasks.
2. Section 2.2: the `--instance_ids` space-separated example is from `docs/guides/evaluation.md`; the README has no `#459` reference. Removed the "#459" citation.
3. Section 3: patch-apply command list is `GIT_APPLY_CMDS` at run_evaluation.py lines 54-59 (was "lines 55-58").
4. Section 2.4: `latest` tag carries an amd64 image plus an `unknown/unknown` attestation manifest; `v1`/`v2` are amd64 (https://hub.docker.com/v2/repositories/swebench/sweb.eval.x86_64.django_1776_django-11099/tags).
5. Section 5: `checked: true` count is **60/180**, not 66 (97 `false`, 17 `null`, 6 string-valued). Re-parsed from https://www.swebench.com/ inline JSON.
6. Section 5: top table was missing ACoder 76.4% (2025-08-19) and Warp 75.6% (2025-09-01); added so the table is complete down to 75.6%.
7. Section 5: experiments repo `evaluation/verified` has 182 folders; GitHub's HTML tree view truncates and hides the 2026 entries (git ls-tree used instead).
8. Section 6: sb-cli quota command is `sb-cli get-quotas` (source: `sb_cli/__init__.py`, `sb_cli/get_quotas.py`), not `sb-cli quota <subset> <split>`; added the docs example quota table and the README-vs-docs inconsistency about `test` split availability; polling is 8 s (submit wait) / 15 s (second loop).

Confirmed unchanged (primary source re-fetched 2026-09-19): 500 rows / 13 string fields in stated order; difficulty 194/261/42/3; per-repo counts and per-version counts (all 12 repos); 162 empty `hints_text`; created_at range 2013-01-25..2023-08-07; 0 `json.loads` failures; 676 truncated test ids; parquet 2,096,679 bytes / 7,779,763 in memory; HF lastModified 2025-02-18T23:48:55Z (princeton-nlp) and 2026-08-16T04:23:43Z (SWE-bench), 281,069 downloads, 387 likes, no license; swebench 5.0.2 uploaded 2026-08-18T19:30:37, requires_python >=3.10, deps list, release list; git tags end at v5.0.1 (`git ls-remote`), `__version__ = "5.0.2"`, GitHub Releases empty; CHANGELOG 5.0.0/5.0.1 dated 8/17/2026 and quoted text; sb-cli 0.1.5 (2025-05-14T00:58:57, >=3.10, `click<8.2.0, requests, rich, typer>=0.9.0`); mini-swe-agent 2.4.6 (2026-07-23, >=3.10); README quotes (Docker, 120GB/16GB/8 cores, arm64 experimental, M-series/Buildx, result caching, `swebench eval/report/infer` lines, legacy `run_evaluation` "same arguments"); `swebench eval` options and defaults; `get_predictions_from_file` (gold/.json/JSONL); prediction record keys; sb-cli dict-keyed format; `DATASET_ALIASES` (`verified` -> `SWE-bench/SWE-bench_Verified`); constants dir = `__init__.py` + `fixtures/` (Cargo.lock files); `dockerfile_gen/constants.py` 1107 lines, 20 repos, spec keys; v4.1.0 `python.py` 1452 lines and identical Python versions for all Verified repo/version pairs; every Python-version/install/test_cmd cell in the section 4 table (incl. sphinx graphviz pre_install, requests `pip install .`, sklearn `--no-use-pep517`); task.yaml/Dockerfile/eval.sh/tests.json/sweb.yaml/pyproject (`swe-bench-original-tasks` 0.1.0) contents; swe-bench-tasks CHANGELOG (2026-08-13 entries, `psf__requests-2317` httpbin known issue); grading.py rules, markers, `_resolve_case`/676/#290, report.json keys; reporting.py keys and `schema_version: 2`; log-parser map and `PARSER_REGISTRY`; Docker Hub: 4,503 repos, 281 `arm64` matches, first-100 split sympy 59/django 38/pytest 3, arm64 built 2025-04-20, anonymous pagination refused; mini-swe-agent image naming `_1776_`, `_ENVIRONMENT_MAPPING`, default `docker`, `preds.json`/`.traj.json`, `--subset verified --split test --workers 4` (docs page); Modal `from_registry("ubuntu:22.04", add_python="3.11")`, Miniconda x86_64, `--modal` + `--task-repo` rejected; inference.md command; MIT LICENSE holders; leaderboard board sizes (13/24/180/84/22), entry field union, newest date 2026-02-26, all listed top entries and percentages/costs/dates, mini Sonnet 4.5 high 71.4%, GPT 5.2 high 72.8%, v1.16.0 Claude 4.5 Opus medium 74.4% checked; "Checked" badge title, Verified description text, Bash Only = filter, submission policy 11/18/2025, reasoning traces 7/29/2024, `swebench submit` commands; BenchLM page (dated September 18, 2026) figures and lack of sources; OpenAI post still HTTP 403.
