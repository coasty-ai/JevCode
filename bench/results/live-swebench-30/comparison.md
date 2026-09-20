# JevCode bench 20260920-060308-0aaf03

Generated 2026-09-20T07:30:13.064Z. Generator model `anthropic/claude-sonnet-5`. 60 task records, suites: swebench.

## Conditions

Both conditions run the same generator, system prompt, user-message layout, limits and sandbox. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | anthropic/claude-sonnet-5 | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |
| jev-off | anthropic/claude-sonnet-5 | — | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |

## Spend

Bench cap $60.0000, per-run cap $1.5000; spent generator $44.6966 + Jev $1.5521 = $46.2487. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | 30 | 30 | 9 | 9/30 (n=30) 30.0% | — | — | — | — |
| jev-off | 30 | 29 | 10 | 10/29 (n=29) 34.5% | `pytest-dev__pytest-10051` | — | — | — |

### Paired comparison (n = 29 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-14787`, `django__django-15103`, `django__django-15128`, `django__django-15315`, `django__django-15375`, `django__django-15563`, `django__django-15572`, `django__django-15916`, `django__django-16100`, `psf__requests-1142`, `psf__requests-2931`, `pylint-dev__pylint-4604`, `pylint-dev__pylint-4970`, `pylint-dev__pylint-6386`, `pytest-dev__pytest-10081`, `pytest-dev__pytest-10356`, `pytest-dev__pytest-7205`, `pytest-dev__pytest-7324`, `sympy__sympy-11618`, `sympy__sympy-12096`, `sympy__sympy-12489`, `sympy__sympy-13798`, `sympy__sympy-15345`, `sympy__sympy-16792`, `sympy__sympy-17139`, `sympy__sympy-19954`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: `pytest-dev__pytest-10051`.

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate (passed/evaluated) | 9/29 (n=29) 31.0% | 10/29 (n=29) 34.5% |
| steps-to-solve mean (n passed) | 23 (n=9) | 22 (n=10) |
| steps-to-solve median | 25 | 25 |
| steps used mean (n runs) | 24.17 (n=29) | 23.90 (n=29) |
| steps used median | 25 | 25 |
| read actions total / mean per run | 83 / 2.86 | 124 / 4.28 |
| blocked / reviews / declined | 208 / 170 / 170 | 0 / 0 / 0 |
| loops / replans | 46 / 40 | 28 / 0 |
| Jev requests / questions | 2631 / 212508 | 0 / 0 |
| Jev latency p50 / p95 ms (n) | 236.69 / 547.34 (n=2631) | null / null (n=0) |
| mean generator tokens/step (steps) | 5519 (n=701) | 6767 (n=693) |
| mean Jev tokens/step (steps) | 28351 (n=701) | 0 (n=693) |
| mean tokens/step, generator+Jev (steps) | 73038 (n=701) | 12815 (n=693) |
| wall time mean | 3m5s | 2m21s |
| cost generator / Jev / total | $22.7131 / $1.4944 / $24.2076 | $20.4434 / $0.0000 / $20.4434 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-on solved(k) | jev-on fraction | jev-on | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 2 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 3 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 4 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 5 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 6 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 7 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 8 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 9 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 10 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 11 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 12 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 13 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 14 | 0/29 | 0.0% |  | 0/29 | 0.0% |  |
| 15 | 0/29 | 0.0% |  | 1/29 | 3.4% | █ |
| 16 | 2/29 | 6.9% | █ | 1/29 | 3.4% | █ |
| 17 | 2/29 | 6.9% | █ | 2/29 | 6.9% | █ |
| 18 | 2/29 | 6.9% | █ | 3/29 | 10.3% | ██ |
| 19 | 2/29 | 6.9% | █ | 3/29 | 10.3% | ██ |
| 20 | 2/29 | 6.9% | █ | 4/29 | 13.8% | ███ |
| 21 | 2/29 | 6.9% | █ | 4/29 | 13.8% | ███ |
| 22 | 2/29 | 6.9% | █ | 4/29 | 13.8% | ███ |
| 23 | 2/29 | 6.9% | █ | 4/29 | 13.8% | ███ |
| 24 | 2/29 | 6.9% | █ | 4/29 | 13.8% | ███ |
| 25 | 9/29 | 31.0% | ██████ | 10/29 | 34.5% | ███████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |
| --- | --- | --- | --- | --- |
| 1 | 4711 (n=29) | ███████████ | 4839 (n=29) | ███████████ |
| 2 | 4282 (n=29) | ██████████ | 5007 (n=29) | ███████████ |
| 3 | 4508 (n=29) | ██████████ | 5192 (n=29) | ████████████ |
| 4 | 4533 (n=29) | ██████████ | 5425 (n=29) | ████████████ |
| 5 | 4810 (n=29) | ███████████ | 5671 (n=29) | █████████████ |
| 6 | 5512 (n=29) | ████████████ | 5830 (n=29) | █████████████ |
| 7 | 5155 (n=29) | ████████████ | 6324 (n=29) | ██████████████ |
| 8 | 5083 (n=29) | ███████████ | 6005 (n=29) | █████████████ |
| 9 | 5368 (n=29) | ████████████ | 6712 (n=29) | ███████████████ |
| 10 | 5128 (n=29) | ████████████ | 6165 (n=29) | ██████████████ |
| 11 | 5382 (n=29) | ████████████ | 6769 (n=29) | ███████████████ |
| 12 | 5882 (n=29) | █████████████ | 6339 (n=29) | ██████████████ |
| 13 | 6374 (n=29) | ██████████████ | 6437 (n=29) | ██████████████ |
| 14 | 5745 (n=29) | █████████████ | 6538 (n=29) | ███████████████ |
| 15 | 6091 (n=29) | ██████████████ | 6585 (n=29) | ███████████████ |
| 16 | 5989 (n=29) | █████████████ | 6934 (n=28) | ████████████████ |
| 17 | 5637 (n=27) | █████████████ | 8223 (n=28) | ██████████████████ |
| 18 | 5679 (n=27) | █████████████ | 7757 (n=27) | █████████████████ |
| 19 | 5717 (n=27) | █████████████ | 7647 (n=26) | █████████████████ |
| 20 | 6071 (n=27) | ██████████████ | 7693 (n=26) | █████████████████ |
| 21 | 5941 (n=27) | █████████████ | 8656 (n=25) | ███████████████████ |
| 22 | 6416 (n=27) | ██████████████ | 8779 (n=25) | ████████████████████ |
| 23 | 6353 (n=27) | ██████████████ | 8904 (n=25) | ████████████████████ |
| 24 | 6307 (n=24) | ██████████████ | 8476 (n=24) | ███████████████████ |
| 25 | 5694 (n=24) | █████████████ | 7913 (n=24) | ██████████████████ |

#### Jev tokens per step

| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |
| --- | --- | --- | --- | --- |
| 1 | 24642 (n=29) | ████████████████ | 0 (n=29) |  |
| 2 | 25361 (n=29) | ████████████████ | 0 (n=29) |  |
| 3 | 25532 (n=29) | ████████████████ | 0 (n=29) |  |
| 4 | 25798 (n=29) | █████████████████ | 0 (n=29) |  |
| 5 | 27103 (n=29) | ██████████████████ | 0 (n=29) |  |
| 6 | 27710 (n=29) | ██████████████████ | 0 (n=29) |  |
| 7 | 28506 (n=29) | ██████████████████ | 0 (n=29) |  |
| 8 | 28404 (n=29) | ██████████████████ | 0 (n=29) |  |
| 9 | 29336 (n=29) | ███████████████████ | 0 (n=29) |  |
| 10 | 28928 (n=29) | ███████████████████ | 0 (n=29) |  |
| 11 | 29859 (n=29) | ███████████████████ | 0 (n=29) |  |
| 12 | 29551 (n=29) | ███████████████████ | 0 (n=29) |  |
| 13 | 30105 (n=29) | ███████████████████ | 0 (n=29) |  |
| 14 | 29849 (n=29) | ███████████████████ | 0 (n=29) |  |
| 15 | 29604 (n=29) | ███████████████████ | 0 (n=29) |  |
| 16 | 29675 (n=29) | ███████████████████ | 0 (n=28) |  |
| 17 | 28263 (n=27) | ██████████████████ | 0 (n=28) |  |
| 18 | 28012 (n=27) | ██████████████████ | 0 (n=27) |  |
| 19 | 28125 (n=27) | ██████████████████ | 0 (n=26) |  |
| 20 | 27691 (n=27) | ██████████████████ | 0 (n=26) |  |
| 21 | 28594 (n=27) | ██████████████████ | 0 (n=25) |  |
| 22 | 28979 (n=27) | ███████████████████ | 0 (n=25) |  |
| 23 | 28979 (n=27) | ███████████████████ | 0 (n=25) |  |
| 24 | 30960 (n=24) | ████████████████████ | 0 (n=24) |  |
| 25 | 29946 (n=24) | ███████████████████ | 0 (n=24) |  |

#### generator+Jev tokens per step

| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |
| --- | --- | --- | --- | --- |
| 1 | 61218 (n=29) | ███████████████ | 9646 (n=29) | ██ |
| 2 | 60925 (n=29) | ███████████████ | 9811 (n=29) | ██ |
| 3 | 62244 (n=29) | ███████████████ | 10181 (n=29) | ███ |
| 4 | 63401 (n=29) | ████████████████ | 10635 (n=29) | ███ |
| 5 | 66360 (n=29) | ████████████████ | 11507 (n=29) | ███ |
| 6 | 68583 (n=29) | █████████████████ | 11341 (n=29) | ███ |
| 7 | 70753 (n=29) | ██████████████████ | 11952 (n=29) | ███ |
| 8 | 70795 (n=29) | ██████████████████ | 12206 (n=29) | ███ |
| 9 | 73136 (n=29) | ██████████████████ | 12572 (n=29) | ███ |
| 10 | 72790 (n=29) | ██████████████████ | 12204 (n=29) | ███ |
| 11 | 74960 (n=29) | ███████████████████ | 13234 (n=29) | ███ |
| 12 | 74714 (n=29) | ███████████████████ | 13120 (n=29) | ███ |
| 13 | 77118 (n=29) | ███████████████████ | 12880 (n=29) | ███ |
| 14 | 76178 (n=29) | ███████████████████ | 13080 (n=29) | ███ |
| 15 | 76432 (n=29) | ███████████████████ | 13245 (n=29) | ███ |
| 16 | 75827 (n=29) | ███████████████████ | 13431 (n=28) | ███ |
| 17 | 78283 (n=27) | ███████████████████ | 14744 (n=28) | ████ |
| 18 | 76210 (n=27) | ███████████████████ | 14099 (n=27) | ███ |
| 19 | 76691 (n=27) | ███████████████████ | 13797 (n=26) | ███ |
| 20 | 77659 (n=27) | ███████████████████ | 13924 (n=26) | ███ |
| 21 | 77311 (n=27) | ███████████████████ | 14784 (n=25) | ████ |
| 22 | 79241 (n=27) | ████████████████████ | 14921 (n=25) | ████ |
| 23 | 80628 (n=27) | ████████████████████ | 15767 (n=25) | ████ |
| 24 | 79845 (n=24) | ████████████████████ | 14919 (n=24) | ████ |
| 25 | 79293 (n=24) | ████████████████████ | 14378 (n=24) | ████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-on |  | jev-off |  |
| --- | --- | --- | --- | --- |
| generator_done | 0 |  | 5 | ████ |
| max_steps | 25 | ████████████████████ | 25 | ████████████████████ |
| replan_stop | 4 | ███ | 0 |  |
| spend_cap | 1 | █ | 0 |  |

### Per task (paired)

| task | jev-on pass | jev-on steps | jev-on reads | jev-on cost | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 25 | 6 | $0.9498 | fail | 25 | 6 | $0.8615 |
| django__django-14787 | fail | 25 | 7 | $0.4961 | fail | 25 | 8 | $0.7612 |
| django__django-15103 | pass | 25 | 5 | $0.6227 | pass | 25 | 4 | $0.6979 |
| django__django-15128 | fail | 23 | 4 | $0.9590 | fail | 25 | 5 | $0.7022 |
| django__django-15315 | pass | 25 | 3 | $0.9217 | pass | 25 | 3 | $0.6506 |
| django__django-15375 | fail | 25 | 3 | $0.7835 | fail | 25 | 4 | $0.6952 |
| django__django-15563 | fail | 25 | 8 | $0.4272 | fail | 25 | 5 | $0.9543 |
| django__django-15572 | pass | 16 | 1 | $0.3986 | fail | 25 | 4 | $0.7090 |
| django__django-15916 | fail | 25 | 3 | $0.5390 | fail | 25 | 5 | $0.8314 |
| django__django-16100 | fail | 25 | 4 | $0.6267 | fail | 25 | 4 | $0.6681 |
| psf__requests-1142 | pass | 25 | 2 | $0.8998 | pass | 20 | 3 | $0.3881 |
| psf__requests-2931 | pass | 25 | 2 | $1.4093 | fail | 25 | 4 | $0.5786 |
| pylint-dev__pylint-4604 | fail | 23 | 1 | $1.2379 | fail | 25 | 4 | $0.7205 |
| pylint-dev__pylint-4970 | fail | 25 | 1 | $1.2083 | fail | 25 | 6 | $0.6751 |
| pylint-dev__pylint-6386 | fail | 25 | 4 | $0.9837 | fail | 25 | 6 | $0.7718 |
| pytest-dev__pytest-10081 | fail | 25 | 2 | $0.9681 | pass | 25 | 3 | $0.8422 |
| pytest-dev__pytest-10356 | fail | 25 | 5 | $1.0448 | fail | 23 | 4 | $0.7948 |
| pytest-dev__pytest-7205 | pass | 16 | 0 | $0.3590 | pass | 25 | 4 | $0.8043 |
| pytest-dev__pytest-7324 | fail | 25 | 1 | $0.6574 | pass | 25 | 5 | $0.7251 |
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
| pytest-dev__pytest-10051 | jev-on | false | local-venv | max_steps |  |
| pytest-dev__pytest-10051 | jev-off | null | invalid | max_steps | no test results and no sign the suite ran |

