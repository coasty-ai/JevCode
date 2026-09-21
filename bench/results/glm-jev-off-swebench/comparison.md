# JevCode bench 20260921-183246-5e025c

Generated 2026-09-21T19:33:06.227Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.2500; spent generator $0.2740 + Jev $0.0000 = $0.2740. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 6 | 6 | 3 | 3/6 (n=6) 50.0% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 3/6 (n=6) 50.0% |
| steps-to-solve mean (n passed) | 17 (n=3) |
| steps-to-solve median | 14 |
| steps used mean (n runs) | 15.50 (n=6) |
| steps used median | 13 |
| read actions total / mean per run | 22 / 3.67 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 7 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 133 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 13659 (n=93) |
| mean Jev tokens/step (steps) | 0 (n=93) |
| mean tokens/step, generator+Jev (steps) | 13659 (n=93) |
| wall time mean | 19m18s |
| cost generator / Jev / total | $0.2740 / $0.0000 / $0.2740 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 0/6 | 0.0% |  |
| 4 | 0/6 | 0.0% |  |
| 5 | 0/6 | 0.0% |  |
| 6 | 0/6 | 0.0% |  |
| 7 | 0/6 | 0.0% |  |
| 8 | 0/6 | 0.0% |  |
| 9 | 0/6 | 0.0% |  |
| 10 | 0/6 | 0.0% |  |
| 11 | 0/6 | 0.0% |  |
| 12 | 0/6 | 0.0% |  |
| 13 | 1/6 | 16.7% | ███ |
| 14 | 2/6 | 33.3% | ███████ |
| 15 | 2/6 | 33.3% | ███████ |
| 16 | 2/6 | 33.3% | ███████ |
| 17 | 2/6 | 33.3% | ███████ |
| 18 | 2/6 | 33.3% | ███████ |
| 19 | 2/6 | 33.3% | ███████ |
| 20 | 2/6 | 33.3% | ███████ |
| 21 | 2/6 | 33.3% | ███████ |
| 22 | 2/6 | 33.3% | ███████ |
| 23 | 2/6 | 33.3% | ███████ |
| 24 | 3/6 | 50.0% | ██████████ |
| 25 | 3/6 | 50.0% | ██████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 5860 (n=6) | █████ |
| 2 | 7289 (n=6) | ██████ |
| 3 | 12879 (n=6) | ███████████ |
| 4 | 12950 (n=6) | ███████████ |
| 5 | 14391 (n=6) | ████████████ |
| 6 | 16660 (n=6) | ██████████████ |
| 7 | 13635 (n=5) | ███████████ |
| 8 | 14303 (n=5) | ████████████ |
| 9 | 10585 (n=5) | █████████ |
| 10 | 16992 (n=5) | ██████████████ |
| 11 | 12130 (n=5) | ██████████ |
| 12 | 19063 (n=5) | ████████████████ |
| 13 | 15473 (n=5) | █████████████ |
| 14 | 14400 (n=3) | ████████████ |
| 15 | 13780 (n=2) | ███████████ |
| 16 | 14368 (n=2) | ████████████ |
| 17 | 23737 (n=2) | ████████████████████ |
| 18 | 22493 (n=2) | ███████████████████ |
| 19 | 13578 (n=2) | ███████████ |
| 20 | 13384 (n=2) | ███████████ |
| 21 | 16946 (n=2) | ██████████████ |
| 22 | 9510 (n=2) | ████████ |
| 23 | 8127 (n=2) | ███████ |
| 24 | 24161 (n=1) | ████████████████████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 0 (n=6) |  |
| 2 | 0 (n=6) |  |
| 3 | 0 (n=6) |  |
| 4 | 0 (n=6) |  |
| 5 | 0 (n=6) |  |
| 6 | 0 (n=6) |  |
| 7 | 0 (n=5) |  |
| 8 | 0 (n=5) |  |
| 9 | 0 (n=5) |  |
| 10 | 0 (n=5) |  |
| 11 | 0 (n=5) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=3) |  |
| 15 | 0 (n=2) |  |
| 16 | 0 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=2) |  |
| 19 | 0 (n=2) |  |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=2) |  |
| 22 | 0 (n=2) |  |
| 23 | 0 (n=2) |  |
| 24 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 5860 (n=6) | █████ |
| 2 | 7289 (n=6) | ██████ |
| 3 | 12879 (n=6) | ███████████ |
| 4 | 12950 (n=6) | ███████████ |
| 5 | 14391 (n=6) | ████████████ |
| 6 | 16660 (n=6) | ██████████████ |
| 7 | 13635 (n=5) | ███████████ |
| 8 | 14303 (n=5) | ████████████ |
| 9 | 10585 (n=5) | █████████ |
| 10 | 16992 (n=5) | ██████████████ |
| 11 | 12130 (n=5) | ██████████ |
| 12 | 19063 (n=5) | ████████████████ |
| 13 | 15473 (n=5) | █████████████ |
| 14 | 14400 (n=3) | ████████████ |
| 15 | 13780 (n=2) | ███████████ |
| 16 | 14368 (n=2) | ████████████ |
| 17 | 23737 (n=2) | ████████████████████ |
| 18 | 22493 (n=2) | ███████████████████ |
| 19 | 13578 (n=2) | ███████████ |
| 20 | 13384 (n=2) | ███████████ |
| 21 | 16946 (n=2) | ██████████████ |
| 22 | 9510 (n=2) | ████████ |
| 23 | 8127 (n=2) | ███████ |
| 24 | 24161 (n=1) | ████████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| error | 1 | █████ |
| generator_done | 1 | █████ |
| wall_time | 4 | ████████████████████ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- |
| django__django-15128 | fail | 23 | 8 | $0.0663 |
| django__django-15315 | pass | 24 | 4 | $0.0783 |
| sympy__sympy-11618 | pass | 14 | 1 | $0.0283 |
| sympy__sympy-15345 | fail | 6 | 3 | $0.0225 |
| sympy__sympy-17139 | pass | 13 | 2 | $0.0419 |
| sympy__sympy-19954 | fail | 13 | 4 | $0.0366 |

