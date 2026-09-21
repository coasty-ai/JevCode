# JevCode bench 20260920-232341-e24366

Generated 2026-09-21T00:13:01.736Z. Generator model `none (jev-only)`. 5 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 25m | $0.4000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.4000; spent generator $0.0000 + Jev $0.1984 = $0.1984. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 5 | 5 | 0 | 0/5 (n=5) 0.0% | — | — | — | — |

### Paired comparison (n = 5 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `django__django-15563`, `psf__requests-2931`, `sympy__sympy-12096`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 0/5 (n=5) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 13 (n=5) |
| steps used median | 9 |
| read actions total / mean per run | 17 / 3.40 |
| blocked / reviews / declined | 25 / 5 / 5 |
| loops / replans | 12 / 9 |
| Jev requests / questions | 603 / 36239 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 232.01 / 648.61 (n=603) |
| mean generator tokens/step (steps) | 0 (n=65) |
| mean Jev tokens/step (steps) | 81298 (n=65) |
| mean tokens/step, generator+Jev (steps) | 81298 (n=65) |
| wall time mean | 18m27s |
| cost generator / Jev / total | $0.0000 / $0.1984 / $0.1984 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/5 | 0.0% |  |
| 2 | 0/5 | 0.0% |  |
| 3 | 0/5 | 0.0% |  |
| 4 | 0/5 | 0.0% |  |
| 5 | 0/5 | 0.0% |  |
| 6 | 0/5 | 0.0% |  |
| 7 | 0/5 | 0.0% |  |
| 8 | 0/5 | 0.0% |  |
| 9 | 0/5 | 0.0% |  |
| 10 | 0/5 | 0.0% |  |
| 11 | 0/5 | 0.0% |  |
| 12 | 0/5 | 0.0% |  |
| 13 | 0/5 | 0.0% |  |
| 14 | 0/5 | 0.0% |  |
| 15 | 0/5 | 0.0% |  |
| 16 | 0/5 | 0.0% |  |
| 17 | 0/5 | 0.0% |  |
| 18 | 0/5 | 0.0% |  |
| 19 | 0/5 | 0.0% |  |
| 20 | 0/5 | 0.0% |  |
| 21 | 0/5 | 0.0% |  |
| 22 | 0/5 | 0.0% |  |
| 23 | 0/5 | 0.0% |  |
| 24 | 0/5 | 0.0% |  |
| 25 | 0/5 | 0.0% |  |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=5) |  |
| 2 | 0 (n=5) |  |
| 3 | 0 (n=5) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=3) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=3) |  |
| 9 | 0 (n=3) |  |
| 10 | 0 (n=2) |  |
| 11 | 0 (n=2) |  |
| 12 | 0 (n=2) |  |
| 13 | 0 (n=2) |  |
| 14 | 0 (n=2) |  |
| 15 | 0 (n=2) |  |
| 16 | 0 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=2) |  |
| 19 | 0 (n=2) |  |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=2) |  |
| 22 | 0 (n=2) |  |
| 23 | 0 (n=2) |  |
| 24 | 0 (n=2) |  |
| 25 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 137345 (n=5) | ██████████████ |
| 2 | 50957 (n=5) | █████ |
| 3 | 78298 (n=5) | ████████ |
| 4 | 181718 (n=4) | ███████████████████ |
| 5 | 78099 (n=3) | ████████ |
| 6 | 42970 (n=3) | █████ |
| 7 | 54307 (n=3) | ██████ |
| 8 | 43014 (n=3) | █████ |
| 9 | 104632 (n=3) | ███████████ |
| 10 | 41652 (n=2) | ████ |
| 11 | 41192 (n=2) | ████ |
| 12 | 41306 (n=2) | ████ |
| 13 | 133097 (n=2) | ██████████████ |
| 14 | 40972 (n=2) | ████ |
| 15 | 43133 (n=2) | █████ |
| 16 | 94320 (n=2) | ██████████ |
| 17 | 40925 (n=2) | ████ |
| 18 | 190411 (n=2) | ████████████████████ |
| 19 | 43200 (n=2) | █████ |
| 20 | 96425 (n=2) | ██████████ |
| 21 | 66964 (n=2) | ███████ |
| 22 | 94501 (n=2) | ██████████ |
| 23 | 39482 (n=2) | ████ |
| 24 | 94285 (n=2) | ██████████ |
| 25 | 51721 (n=1) | █████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 137345 (n=5) | ██████████████ |
| 2 | 50957 (n=5) | █████ |
| 3 | 78298 (n=5) | ████████ |
| 4 | 181718 (n=4) | ███████████████████ |
| 5 | 78099 (n=3) | ████████ |
| 6 | 42970 (n=3) | █████ |
| 7 | 54307 (n=3) | ██████ |
| 8 | 43014 (n=3) | █████ |
| 9 | 104632 (n=3) | ███████████ |
| 10 | 41652 (n=2) | ████ |
| 11 | 41192 (n=2) | ████ |
| 12 | 41306 (n=2) | ████ |
| 13 | 133097 (n=2) | ██████████████ |
| 14 | 40972 (n=2) | ████ |
| 15 | 43133 (n=2) | █████ |
| 16 | 94320 (n=2) | ██████████ |
| 17 | 40925 (n=2) | ████ |
| 18 | 190411 (n=2) | ████████████████████ |
| 19 | 43200 (n=2) | █████ |
| 20 | 96425 (n=2) | ██████████ |
| 21 | 66964 (n=2) | ███████ |
| 22 | 94501 (n=2) | ██████████ |
| 23 | 39482 (n=2) | ████ |
| 24 | 94285 (n=2) | ██████████ |
| 25 | 51721 (n=1) | █████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_replans | 1 | ██████████ |
| max_steps | 1 | ██████████ |
| replan_stop | 1 | ██████████ |
| wall_time | 2 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| django__django-15128 | fail | 9 | 0 | $0.0211 |
| django__django-15315 | fail | 25 | 5 | $0.0808 |
| django__django-15563 | fail | 3 | 1 | $0.0282 |
| psf__requests-2931 | fail | 24 | 10 | $0.0507 |
| sympy__sympy-12096 | fail | 4 | 1 | $0.0176 |

