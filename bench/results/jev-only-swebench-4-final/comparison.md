# JevCode bench 20260921-022451-aa869f

Generated 2026-09-21T03:33:07.611Z. Generator model `none (jev-only)`. 30 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 25m | $0.4000 | auto | 2m | 200 KB |

## Spend

Bench cap $4.0000, per-run cap $0.4000; spent generator $0.0000 + Jev $1.2956 = $1.2956. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 30 | 30 | 4 | 4/30 (n=30) 13.3% | — | — | — | — |

### Paired comparison (n = 30 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-14787`, `django__django-15103`, `django__django-15128`, `django__django-15315`, `django__django-15375`, `django__django-15563`, `django__django-15572`, `django__django-15916`, `django__django-16100`, `psf__requests-1142`, `psf__requests-2931`, `pylint-dev__pylint-4604`, `pylint-dev__pylint-4970`, `pylint-dev__pylint-6386`, `pytest-dev__pytest-10051`, `pytest-dev__pytest-10081`, `pytest-dev__pytest-10356`, `pytest-dev__pytest-7205`, `pytest-dev__pytest-7324`, `sympy__sympy-11618`, `sympy__sympy-12096`, `sympy__sympy-12489`, `sympy__sympy-13798`, `sympy__sympy-15345`, `sympy__sympy-16792`, `sympy__sympy-17139`, `sympy__sympy-19954`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 4/30 (n=30) 13.3% |
| steps-to-solve mean (n passed) | 4.50 (n=4) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 11.60 (n=30) |
| steps used median | 9 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 228 / 10 / 10 |
| loops / replans | 88 / 61 |
| Jev requests / questions | 3222 / 266356 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 226.76 / 540.62 (n=3222) |
| mean generator tokens/step (steps) | 0 (n=348) |
| mean Jev tokens/step (steps) | 106416 (n=348) |
| mean tokens/step, generator+Jev (steps) | 106416 (n=348) |
| wall time mean | 3m56s |
| cost generator / Jev / total | $0.0000 / $1.2956 / $1.2956 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/30 | 0.0% |  |
| 2 | 0/30 | 0.0% |  |
| 3 | 0/30 | 0.0% |  |
| 4 | 3/30 | 10.0% | ██ |
| 5 | 3/30 | 10.0% | ██ |
| 6 | 4/30 | 13.3% | ███ |
| 7 | 4/30 | 13.3% | ███ |
| 8 | 4/30 | 13.3% | ███ |
| 9 | 4/30 | 13.3% | ███ |
| 10 | 4/30 | 13.3% | ███ |
| 11 | 4/30 | 13.3% | ███ |
| 12 | 4/30 | 13.3% | ███ |
| 13 | 4/30 | 13.3% | ███ |
| 14 | 4/30 | 13.3% | ███ |
| 15 | 4/30 | 13.3% | ███ |
| 16 | 4/30 | 13.3% | ███ |
| 17 | 4/30 | 13.3% | ███ |
| 18 | 4/30 | 13.3% | ███ |
| 19 | 4/30 | 13.3% | ███ |
| 20 | 4/30 | 13.3% | ███ |
| 21 | 4/30 | 13.3% | ███ |
| 22 | 4/30 | 13.3% | ███ |
| 23 | 4/30 | 13.3% | ███ |
| 24 | 4/30 | 13.3% | ███ |
| 25 | 4/30 | 13.3% | ███ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=30) |  |
| 2 | 0 (n=30) |  |
| 3 | 0 (n=30) |  |
| 4 | 0 (n=30) |  |
| 5 | 0 (n=27) |  |
| 6 | 0 (n=27) |  |
| 7 | 0 (n=25) |  |
| 8 | 0 (n=24) |  |
| 9 | 0 (n=24) |  |
| 10 | 0 (n=13) |  |
| 11 | 0 (n=11) |  |
| 12 | 0 (n=10) |  |
| 13 | 0 (n=9) |  |
| 14 | 0 (n=9) |  |
| 15 | 0 (n=8) |  |
| 16 | 0 (n=8) |  |
| 17 | 0 (n=8) |  |
| 18 | 0 (n=7) |  |
| 19 | 0 (n=6) |  |
| 20 | 0 (n=6) |  |
| 21 | 0 (n=6) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 130107 (n=30) | ██████████████ |
| 2 | 185420 (n=30) | ████████████████████ |
| 3 | 91890 (n=30) | ██████████ |
| 4 | 91874 (n=30) | ██████████ |
| 5 | 102802 (n=27) | ███████████ |
| 6 | 78696 (n=27) | ████████ |
| 7 | 97491 (n=25) | ██████████ |
| 8 | 62442 (n=24) | ███████ |
| 9 | 77992 (n=24) | ████████ |
| 10 | 124372 (n=13) | █████████████ |
| 11 | 182635 (n=11) | ███████████████████ |
| 12 | 168856 (n=10) | ██████████████████ |
| 13 | 189718 (n=9) | ████████████████████ |
| 14 | 94223 (n=9) | ██████████ |
| 15 | 52635 (n=8) | ██████ |
| 16 | 55148 (n=8) | ██████ |
| 17 | 66973 (n=8) | ███████ |
| 18 | 158349 (n=7) | █████████████████ |
| 19 | 56271 (n=6) | ██████ |
| 20 | 52641 (n=6) | ██████ |
| 21 | 52675 (n=6) | ██████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 130107 (n=30) | ██████████████ |
| 2 | 185420 (n=30) | ████████████████████ |
| 3 | 91890 (n=30) | ██████████ |
| 4 | 91874 (n=30) | ██████████ |
| 5 | 102802 (n=27) | ███████████ |
| 6 | 78696 (n=27) | ████████ |
| 7 | 97491 (n=25) | ██████████ |
| 8 | 62442 (n=24) | ███████ |
| 9 | 77992 (n=24) | ████████ |
| 10 | 124372 (n=13) | █████████████ |
| 11 | 182635 (n=11) | ███████████████████ |
| 12 | 168856 (n=10) | ██████████████████ |
| 13 | 189718 (n=9) | ████████████████████ |
| 14 | 94223 (n=9) | ██████████ |
| 15 | 52635 (n=8) | ██████ |
| 16 | 55148 (n=8) | ██████ |
| 17 | 66973 (n=8) | ███████ |
| 18 | 158349 (n=7) | █████████████████ |
| 19 | 56271 (n=6) | ██████ |
| 20 | 52641 (n=6) | ██████ |
| 21 | 52675 (n=6) | ██████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 3 | ███ |
| max_replans | 7 | ███████ |
| replan_stop | 20 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| django__django-14725 | fail | 9 | 0 | $0.0258 |
| django__django-14787 | fail | 9 | 0 | $0.0230 |
| django__django-15103 | fail | 12 | 0 | $0.0320 |
| django__django-15128 | pass | 4 | 0 | $0.0111 |
| django__django-15315 | fail | 9 | 0 | $0.0196 |
| django__django-15375 | fail | 21 | 0 | $0.0485 |
| django__django-15563 | fail | 9 | 0 | $0.0224 |
| django__django-15572 | fail | 9 | 0 | $0.0223 |
| django__django-15916 | fail | 9 | 0 | $0.0255 |
| django__django-16100 | fail | 9 | 0 | $0.0251 |
| psf__requests-1142 | fail | 10 | 0 | $0.0169 |
| psf__requests-2931 | fail | 11 | 0 | $0.0183 |
| pylint-dev__pylint-4604 | fail | 9 | 0 | $0.0234 |
| pylint-dev__pylint-4970 | fail | 6 | 0 | $0.0178 |
| pylint-dev__pylint-6386 | fail | 7 | 0 | $0.0171 |
| pytest-dev__pytest-10051 | fail | 21 | 0 | $0.0471 |
| pytest-dev__pytest-10081 | fail | 21 | 0 | $0.0470 |
| pytest-dev__pytest-10356 | fail | 9 | 0 | $0.0257 |
| pytest-dev__pytest-7205 | fail | 21 | 0 | $0.0484 |
| pytest-dev__pytest-7324 | fail | 21 | 0 | $0.0442 |
| sympy__sympy-11618 | fail | 17 | 0 | $0.1345 |
| sympy__sympy-12096 | fail | 21 | 0 | $0.1629 |
| sympy__sympy-12489 | fail | 10 | 0 | $0.0243 |
| sympy__sympy-13798 | fail | 9 | 0 | $0.0209 |
| sympy__sympy-15345 | pass | 4 | 0 | $0.0168 |
| sympy__sympy-16792 | fail | 18 | 0 | $0.2247 |
| sympy__sympy-17139 | pass | 4 | 0 | $0.0158 |
| sympy__sympy-19954 | pass | 6 | 0 | $0.0194 |
| sympy__sympy-20428 | fail | 14 | 0 | $0.0910 |
| sympy__sympy-22080 | fail | 9 | 0 | $0.0240 |

