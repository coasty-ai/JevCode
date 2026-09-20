# JevCode bench 20260920-060308-0aaf03

Generated 2026-09-20T06:40:35.948Z. Generator model `anthropic/claude-sonnet-5`. 60 task records, suites: swebench.

## Conditions

Both conditions run the same generator, system prompt, user-message layout, limits and sandbox. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | anthropic/claude-sonnet-5 | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |
| jev-off | anthropic/claude-sonnet-5 | — | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |

## Spend

Bench cap $45.0000, per-run cap $1.5000; spent generator $23.4182 + Jev $0.7813 = $24.1994. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | 30 | 15 | 5 | 5/15 (n=15) 33.3% | `django__django-14787`, `django__django-15315`, `django__django-15572`, `django__django-16100`, `django__django-14725`, `django__django-15103`, `django__django-15375`, `django__django-15563`, `django__django-15916`, `django__django-15128`, `pytest-dev__pytest-10081`, `pytest-dev__pytest-7205`, `pyt… | — | — | — |
| jev-off | 30 | 15 | 5 | 5/15 (n=15) 33.3% | `django__django-14787`, `django__django-15315`, `django__django-15572`, `django__django-16100`, `django__django-14725`, `django__django-15103`, `django__django-15375`, `django__django-15563`, `django__django-15916`, `pytest-dev__pytest-10081`, `django__django-15128`, `pytest-dev__pytest-7205`, `pyt… | — | — | — |

### Paired comparison (n = 15 tasks evaluated in every condition)

Paired tasks: `psf__requests-1142`, `psf__requests-2931`, `pylint-dev__pylint-4604`, `pylint-dev__pylint-4970`, `pylint-dev__pylint-6386`, `sympy__sympy-11618`, `sympy__sympy-12096`, `sympy__sympy-12489`, `sympy__sympy-13798`, `sympy__sympy-15345`, `sympy__sympy-16792`, `sympy__sympy-17139`, `sympy__sympy-19954`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: `django__django-14725`, `django__django-14787`, `django__django-15103`, `django__django-15128`, `django__django-15315`, `django__django-15375`, `django__django-15563`, `django__django-15572`, `django__django-15916`, `django__django-16100`, `pytest-dev__pytest-10051`, `pytest-dev__pytest-10081`, `pytest-dev__pytest-10356`, `pytest-dev__pytest-7205`, `pytest-dev__pytest-7324`.

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate (passed/evaluated) | 5/15 (n=15) 33.3% | 5/15 (n=15) 33.3% |
| steps-to-solve mean (n passed) | 25 (n=5) | 19 (n=5) |
| steps-to-solve median | 25 | 18 |
| steps used mean (n runs) | 24.73 (n=15) | 23 (n=15) |
| steps used median | 25 | 25 |
| read actions total / mean per run | 31 / 2.07 | 60 / 4 |
| blocked / reviews / declined | 97 / 76 / 76 | 0 / 0 / 0 |
| loops / replans | 19 / 17 | 13 / 0 |
| Jev requests / questions | 1396 / 108357 | 0 / 0 |
| Jev latency p50 / p95 ms (n) | 232.42 / 545.16 (n=1396) | null / null (n=0) |
| mean tokens/step (steps) | 74007 (n=371) | 12148 (n=345) |
| wall time mean | 3m24s | 2m18s |
| cost generator / Jev / total | $13.6725 / $0.7813 / $14.4538 | $9.7457 / $0.0000 / $9.7457 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-on solved(k) | jev-on fraction | jev-on | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 2 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 3 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 4 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 5 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 6 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 7 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 8 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 9 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 10 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 11 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 12 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 13 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 14 | 0/15 | 0.0% |  | 0/15 | 0.0% |  |
| 15 | 0/15 | 0.0% |  | 1/15 | 6.7% | █ |
| 16 | 0/15 | 0.0% |  | 1/15 | 6.7% | █ |
| 17 | 0/15 | 0.0% |  | 2/15 | 13.3% | ███ |
| 18 | 0/15 | 0.0% |  | 3/15 | 20.0% | ████ |
| 19 | 0/15 | 0.0% |  | 3/15 | 20.0% | ████ |
| 20 | 0/15 | 0.0% |  | 4/15 | 26.7% | █████ |
| 21 | 0/15 | 0.0% |  | 4/15 | 26.7% | █████ |
| 22 | 0/15 | 0.0% |  | 4/15 | 26.7% | █████ |
| 23 | 0/15 | 0.0% |  | 4/15 | 26.7% | █████ |
| 24 | 0/15 | 0.0% |  | 4/15 | 26.7% | █████ |
| 25 | 5/15 | 33.3% | ███████ | 5/15 | 33.3% | ███████ |

### Tokens per step (paired; mean generator+Jev tokens over runs that reached the step)

| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |
| --- | --- | --- | --- | --- |
| 1 | 61607 (n=15) | ███████████████ | 9294 (n=15) | ██ |
| 2 | 60477 (n=15) | ███████████████ | 9287 (n=15) | ██ |
| 3 | 62261 (n=15) | ███████████████ | 9646 (n=15) | ██ |
| 4 | 63934 (n=15) | ████████████████ | 10073 (n=15) | ██ |
| 5 | 66597 (n=15) | ████████████████ | 11283 (n=15) | ███ |
| 6 | 68364 (n=15) | █████████████████ | 10655 (n=15) | ███ |
| 7 | 71709 (n=15) | ██████████████████ | 10879 (n=15) | ███ |
| 8 | 72128 (n=15) | ██████████████████ | 11987 (n=15) | ███ |
| 9 | 74303 (n=15) | ██████████████████ | 11329 (n=15) | ███ |
| 10 | 74885 (n=15) | ██████████████████ | 11677 (n=15) | ███ |
| 11 | 76791 (n=15) | ███████████████████ | 12497 (n=15) | ███ |
| 12 | 75943 (n=15) | ███████████████████ | 13108 (n=15) | ███ |
| 13 | 78567 (n=15) | ███████████████████ | 12457 (n=15) | ███ |
| 14 | 78461 (n=15) | ███████████████████ | 12647 (n=15) | ███ |
| 15 | 78759 (n=15) | ███████████████████ | 12876 (n=15) | ███ |
| 16 | 77648 (n=15) | ███████████████████ | 12994 (n=14) | ███ |
| 17 | 79888 (n=15) | ████████████████████ | 13041 (n=14) | ███ |
| 18 | 76535 (n=15) | ███████████████████ | 13173 (n=13) | ███ |
| 19 | 77128 (n=15) | ███████████████████ | 13325 (n=12) | ███ |
| 20 | 79015 (n=15) | ███████████████████ | 13499 (n=12) | ███ |
| 21 | 76998 (n=15) | ███████████████████ | 13926 (n=11) | ███ |
| 22 | 78922 (n=15) | ███████████████████ | 13959 (n=11) | ███ |
| 23 | 81534 (n=15) | ████████████████████ | 15598 (n=11) | ████ |
| 24 | 78607 (n=13) | ███████████████████ | 14056 (n=11) | ███ |
| 25 | 80591 (n=13) | ████████████████████ | 14104 (n=11) | ███ |

### Stop reasons (all records)

| stop reason | jev-on |  | jev-off |  |
| --- | --- | --- | --- | --- |
| error | 15 | ████████████████████ | 15 | ████████████████████ |
| generator_done | 0 |  | 4 | █████ |
| max_steps | 13 | █████████████████ | 11 | ███████████████ |
| replan_stop | 1 | █ | 0 |  |
| spend_cap | 1 | █ | 0 |  |

### Per task (paired)

| task | jev-on pass | jev-on steps | jev-on reads | jev-on cost | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| psf__requests-1142 | pass | 25 | 2 | $0.8998 | pass | 20 | 3 | $0.3881 |
| psf__requests-2931 | pass | 25 | 2 | $1.4093 | fail | 25 | 4 | $0.5786 |
| pylint-dev__pylint-4604 | fail | 23 | 1 | $1.2379 | fail | 25 | 4 | $0.7205 |
| pylint-dev__pylint-4970 | fail | 25 | 1 | $1.2083 | fail | 25 | 6 | $0.6751 |
| pylint-dev__pylint-6386 | fail | 25 | 4 | $0.9837 | fail | 25 | 6 | $0.7718 |
| sympy__sympy-11618 | pass | 25 | 1 | $0.6498 | pass | 17 | 2 | $0.4501 |
| sympy__sympy-12096 | pass | 25 | 2 | $0.7873 | pass | 15 | 1 | $0.3952 |
| sympy__sympy-12489 | fail | 25 | 4 | $0.7510 | fail | 25 | 4 | $0.8471 |
| sympy__sympy-13798 | fail | 25 | 0 | $0.8298 | fail | 25 | 4 | $0.7255 |
| sympy__sympy-15345 | fail | 25 | 4 | $0.4198 | pass | 25 | 6 | $0.6352 |
| sympy__sympy-16792 | fail | 25 | 2 | $1.0861 | fail | 25 | 5 | $0.7155 |
| sympy__sympy-17139 | pass | 25 | 3 | $1.0021 | pass | 18 | 3 | $0.4656 |
| sympy__sympy-19954 | fail | 25 | 1 | $0.8245 | fail | 25 | 3 | $0.7063 |
| sympy__sympy-20428 | fail | 23 | 2 | $1.5318 | fail | 25 | 5 | $0.8516 |
| sympy__sympy-22080 | fail | 25 | 2 | $0.8324 | fail | 25 | 4 | $0.8194 |

### Incomplete pairs

| task | condition | pass | evaluator | stop reason | reason |
| --- | --- | --- | --- | --- | --- |
| django__django-14787 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-14787 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15315 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15315 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15572 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15572 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-16100 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-16100 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-14725 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-14725 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15103 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15375 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15103 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15375 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15563 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15916 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| django__django-15563 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15916 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| django__django-15128 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …';f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, _… |
| pytest-dev__pytest-10081 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …= getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fil… |
| pytest-dev__pytest-10081 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): … getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __file… |
| pytest-dev__pytest-7205 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): … = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fi… |
| django__django-15128 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …;f = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __… |
| pytest-dev__pytest-10051 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …= getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fil… |
| pytest-dev__pytest-7205 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …= getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fil… |
| pytest-dev__pytest-7324 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): … = getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fi… |
| pytest-dev__pytest-10051 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): … getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __file… |
| pytest-dev__pytest-10356 | jev-on | null | none | error | setup_failed: install step failed (python -m pip install -e .): …= getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fil… |
| pytest-dev__pytest-7324 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): …= getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __fil… |
| pytest-dev__pytest-10356 | jev-off | null | none | error | setup_failed: install step failed (python -m pip install -e .): … getattr(tokenize, '"'"'open'"'"', open)(__file__) if os.path.exists(__file__) else io.StringIO('"'"'from setuptools import setup; setup()'"'"');code = f.read().replace('"'"'\r\n'"'"', '"'"'\n'"'"');f.close();exec(compile(code, __file… |

