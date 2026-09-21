# JevCode bench 20260921-002827-57b7e1

Generated 2026-09-21T01:23:04.804Z. Generator model `none (jev-only)`. 30 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 25m | $0.4000 | auto | 2m | 200 KB |

## Spend

Bench cap $4.0000, per-run cap $0.4000; spent generator $0.0000 + Jev $1.1633 = $1.1633. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 30 | 30 | 1 | 1/30 (n=30) 3.3% | — | — | — | — |

### Paired comparison (n = 30 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-14787`, `django__django-15103`, `django__django-15128`, `django__django-15315`, `django__django-15375`, `django__django-15563`, `django__django-15572`, `django__django-15916`, `django__django-16100`, `psf__requests-1142`, `psf__requests-2931`, `pylint-dev__pylint-4604`, `pylint-dev__pylint-4970`, `pylint-dev__pylint-6386`, `pytest-dev__pytest-10051`, `pytest-dev__pytest-10081`, `pytest-dev__pytest-10356`, `pytest-dev__pytest-7205`, `pytest-dev__pytest-7324`, `sympy__sympy-11618`, `sympy__sympy-12096`, `sympy__sympy-12489`, `sympy__sympy-13798`, `sympy__sympy-15345`, `sympy__sympy-16792`, `sympy__sympy-17139`, `sympy__sympy-19954`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/30 (n=30) 3.3% |
| steps-to-solve mean (n passed) | 4 (n=1) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 14.97 (n=30) |
| steps used median | 20 |
| read actions total / mean per run | 152 / 5.07 |
| blocked / reviews / declined | 148 / 24 / 24 |
| loops / replans | 101 / 84 |
| Jev requests / questions | 2891 / 222901 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 221.04 / 632.73 (n=2891) |
| mean generator tokens/step (steps) | 0 (n=449) |
| mean Jev tokens/step (steps) | 74527 (n=449) |
| mean tokens/step, generator+Jev (steps) | 74527 (n=449) |
| wall time mean | 3m11s |
| cost generator / Jev / total | $0.0000 / $1.1633 / $1.1633 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/30 | 0.0% |  |
| 2 | 0/30 | 0.0% |  |
| 3 | 0/30 | 0.0% |  |
| 4 | 1/30 | 3.3% | █ |
| 5 | 1/30 | 3.3% | █ |
| 6 | 1/30 | 3.3% | █ |
| 7 | 1/30 | 3.3% | █ |
| 8 | 1/30 | 3.3% | █ |
| 9 | 1/30 | 3.3% | █ |
| 10 | 1/30 | 3.3% | █ |
| 11 | 1/30 | 3.3% | █ |
| 12 | 1/30 | 3.3% | █ |
| 13 | 1/30 | 3.3% | █ |
| 14 | 1/30 | 3.3% | █ |
| 15 | 1/30 | 3.3% | █ |
| 16 | 1/30 | 3.3% | █ |
| 17 | 1/30 | 3.3% | █ |
| 18 | 1/30 | 3.3% | █ |
| 19 | 1/30 | 3.3% | █ |
| 20 | 1/30 | 3.3% | █ |
| 21 | 1/30 | 3.3% | █ |
| 22 | 1/30 | 3.3% | █ |
| 23 | 1/30 | 3.3% | █ |
| 24 | 1/30 | 3.3% | █ |
| 25 | 1/30 | 3.3% | █ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=30) |  |
| 2 | 0 (n=30) |  |
| 3 | 0 (n=30) |  |
| 4 | 0 (n=30) |  |
| 5 | 0 (n=25) |  |
| 6 | 0 (n=21) |  |
| 7 | 0 (n=19) |  |
| 8 | 0 (n=19) |  |
| 9 | 0 (n=19) |  |
| 10 | 0 (n=18) |  |
| 11 | 0 (n=17) |  |
| 12 | 0 (n=17) |  |
| 13 | 0 (n=17) |  |
| 14 | 0 (n=17) |  |
| 15 | 0 (n=17) |  |
| 16 | 0 (n=16) |  |
| 17 | 0 (n=16) |  |
| 18 | 0 (n=16) |  |
| 19 | 0 (n=16) |  |
| 20 | 0 (n=16) |  |
| 21 | 0 (n=15) |  |
| 22 | 0 (n=10) |  |
| 23 | 0 (n=8) |  |
| 24 | 0 (n=6) |  |
| 25 | 0 (n=4) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 126130 (n=30) | ████████████████████ |
| 2 | 87522 (n=30) | ██████████████ |
| 3 | 90386 (n=30) | ██████████████ |
| 4 | 87137 (n=30) | ██████████████ |
| 5 | 82270 (n=25) | █████████████ |
| 6 | 88061 (n=21) | ██████████████ |
| 7 | 79569 (n=19) | █████████████ |
| 8 | 57704 (n=19) | █████████ |
| 9 | 78397 (n=19) | ████████████ |
| 10 | 84963 (n=18) | █████████████ |
| 11 | 51134 (n=17) | ████████ |
| 12 | 64711 (n=17) | ██████████ |
| 13 | 51383 (n=17) | ████████ |
| 14 | 55894 (n=17) | █████████ |
| 15 | 73226 (n=17) | ████████████ |
| 16 | 59539 (n=16) | █████████ |
| 17 | 65272 (n=16) | ██████████ |
| 18 | 69703 (n=16) | ███████████ |
| 19 | 51588 (n=16) | ████████ |
| 20 | 47666 (n=16) | ████████ |
| 21 | 59975 (n=15) | ██████████ |
| 22 | 51632 (n=10) | ████████ |
| 23 | 59493 (n=8) | █████████ |
| 24 | 63313 (n=6) | ██████████ |
| 25 | 46105 (n=4) | ███████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 126130 (n=30) | ████████████████████ |
| 2 | 87522 (n=30) | ██████████████ |
| 3 | 90386 (n=30) | ██████████████ |
| 4 | 87137 (n=30) | ██████████████ |
| 5 | 82270 (n=25) | █████████████ |
| 6 | 88061 (n=21) | ██████████████ |
| 7 | 79569 (n=19) | █████████████ |
| 8 | 57704 (n=19) | █████████ |
| 9 | 78397 (n=19) | ████████████ |
| 10 | 84963 (n=18) | █████████████ |
| 11 | 51134 (n=17) | ████████ |
| 12 | 64711 (n=17) | ██████████ |
| 13 | 51383 (n=17) | ████████ |
| 14 | 55894 (n=17) | █████████ |
| 15 | 73226 (n=17) | ████████████ |
| 16 | 59539 (n=16) | █████████ |
| 17 | 65272 (n=16) | ██████████ |
| 18 | 69703 (n=16) | ███████████ |
| 19 | 51588 (n=16) | ████████ |
| 20 | 47666 (n=16) | ████████ |
| 21 | 59975 (n=15) | ██████████ |
| 22 | 51632 (n=10) | ████████ |
| 23 | 59493 (n=8) | █████████ |
| 24 | 63313 (n=6) | ██████████ |
| 25 | 46105 (n=4) | ███████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | ██ |
| error | 9 | ███████████████ |
| max_replans | 12 | ████████████████████ |
| max_steps | 4 | ███████ |
| replan_stop | 4 | ███████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| django__django-14725 | fail | 21 | 8 | $0.0483 |
| django__django-14787 | fail | 24 | 10 | $0.0485 |
| django__django-15103 | fail | 5 | 1 | $0.0116 |
| django__django-15128 | pass | 4 | 0 | $0.0113 |
| django__django-15315 | fail | 21 | 0 | $0.0515 |
| django__django-15375 | fail | 5 | 1 | $0.0123 |
| django__django-15563 | fail | 10 | 1 | $0.0246 |
| django__django-15572 | fail | 4 | 0 | $0.0091 |
| django__django-15916 | fail | 25 | 15 | $0.0661 |
| django__django-16100 | fail | 25 | 9 | $0.0534 |
| psf__requests-1142 | fail | 25 | 10 | $0.0367 |
| psf__requests-2931 | fail | 24 | 12 | $0.0272 |
| pylint-dev__pylint-4604 | fail | 4 | 0 | $0.0193 |
| pylint-dev__pylint-4970 | fail | 4 | 0 | $0.0073 |
| pylint-dev__pylint-6386 | fail | 6 | 1 | $0.0105 |
| pytest-dev__pytest-10051 | fail | 21 | 0 | $0.0467 |
| pytest-dev__pytest-10081 | fail | 6 | 2 | $0.0220 |
| pytest-dev__pytest-10356 | fail | 5 | 1 | $0.0229 |
| pytest-dev__pytest-7205 | fail | 22 | 6 | $0.0507 |
| pytest-dev__pytest-7324 | fail | 22 | 10 | $0.0488 |
| sympy__sympy-11618 | fail | 5 | 1 | $0.0096 |
| sympy__sympy-12096 | fail | 23 | 11 | $0.0852 |
| sympy__sympy-12489 | fail | 25 | 15 | $0.0567 |
| sympy__sympy-13798 | fail | 9 | 0 | $0.0209 |
| sympy__sympy-15345 | fail | 20 | 7 | $0.0941 |
| sympy__sympy-16792 | fail | 15 | 2 | $0.0799 |
| sympy__sympy-17139 | fail | 21 | 10 | $0.0585 |
| sympy__sympy-19954 | fail | 21 | 8 | $0.0547 |
| sympy__sympy-20428 | fail | 4 | 0 | $0.0224 |
| sympy__sympy-22080 | fail | 23 | 11 | $0.0527 |

