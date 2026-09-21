# JevCode bench 20260921-011138-ee8a4e

Generated 2026-09-21T01:27:43.024Z. Generator model `none (jev-only)`. 4 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.1500; spent generator $0.0000 + Jev $0.1200 = $0.1200. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 4 | 4 | 0 | 0/4 (n=4) 0.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 0/1 0.0% |
| 3 | 1 | 0/1 0.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 4 | 2 | 0/2 0.0% |
| 5 | 2 | 0/2 0.0% |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `long_chain`, `masked`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 0/4 (n=4) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 12.75 (n=4) |
| steps used median | 12 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 24 / 0 / 0 |
| loops / replans | 10 / 6 |
| Jev requests / questions | 664 / 12154 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 199.37 / 389.54 (n=664) |
| mean generator tokens/step (steps) | 0 (n=51) |
| mean Jev tokens/step (steps) | 67633 (n=51) |
| mean tokens/step, generator+Jev (steps) | 67633 (n=51) |
| wall time mean | 4m |
| cost generator / Jev / total | $0.0000 / $0.1200 / $0.1200 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/4 | 0.0% |  |
| 2 | 0/4 | 0.0% |  |
| 3 | 0/4 | 0.0% |  |
| 4 | 0/4 | 0.0% |  |
| 5 | 0/4 | 0.0% |  |
| 6 | 0/4 | 0.0% |  |
| 7 | 0/4 | 0.0% |  |
| 8 | 0/4 | 0.0% |  |
| 9 | 0/4 | 0.0% |  |
| 10 | 0/4 | 0.0% |  |
| 11 | 0/4 | 0.0% |  |
| 12 | 0/4 | 0.0% |  |
| 13 | 0/4 | 0.0% |  |
| 14 | 0/4 | 0.0% |  |
| 15 | 0/4 | 0.0% |  |
| 16 | 0/4 | 0.0% |  |
| 17 | 0/4 | 0.0% |  |
| 18 | 0/4 | 0.0% |  |
| 19 | 0/4 | 0.0% |  |
| 20 | 0/4 | 0.0% |  |
| 21 | 0/4 | 0.0% |  |
| 22 | 0/4 | 0.0% |  |
| 23 | 0/4 | 0.0% |  |
| 24 | 0/4 | 0.0% |  |
| 25 | 0/4 | 0.0% |  |
| 26 | 0/4 | 0.0% |  |
| 27 | 0/4 | 0.0% |  |
| 28 | 0/4 | 0.0% |  |
| 29 | 0/4 | 0.0% |  |
| 30 | 0/4 | 0.0% |  |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=4) |  |
| 2 | 0 (n=4) |  |
| 3 | 0 (n=4) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=4) |  |
| 8 | 0 (n=4) |  |
| 9 | 0 (n=4) |  |
| 10 | 0 (n=4) |  |
| 11 | 0 (n=3) |  |
| 12 | 0 (n=3) |  |
| 13 | 0 (n=2) |  |
| 14 | 0 (n=1) |  |
| 15 | 0 (n=1) |  |
| 16 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9660 (n=4) | █ |
| 2 | 181262 (n=4) | ████████████████████ |
| 3 | 145973 (n=4) | ████████████████ |
| 4 | 75545 (n=4) | ████████ |
| 5 | 61485 (n=4) | ███████ |
| 6 | 84389 (n=4) | █████████ |
| 7 | 98477 (n=4) | ███████████ |
| 8 | 70277 (n=4) | ████████ |
| 9 | 11869 (n=4) | █ |
| 10 | 49765 (n=4) | █████ |
| 11 | 67567 (n=3) | ███████ |
| 12 | 10359 (n=3) | █ |
| 13 | 11009 (n=2) | █ |
| 14 | 15689 (n=1) | ██ |
| 15 | 11382 (n=1) | █ |
| 16 | 11595 (n=1) | █ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9660 (n=4) | █ |
| 2 | 181262 (n=4) | ████████████████████ |
| 3 | 145973 (n=4) | ████████████████ |
| 4 | 75545 (n=4) | ████████ |
| 5 | 61485 (n=4) | ███████ |
| 6 | 84389 (n=4) | █████████ |
| 7 | 98477 (n=4) | ███████████ |
| 8 | 70277 (n=4) | ████████ |
| 9 | 11869 (n=4) | █ |
| 10 | 49765 (n=4) | █████ |
| 11 | 67567 (n=3) | ███████ |
| 12 | 10359 (n=3) | █ |
| 13 | 11009 (n=2) | █ |
| 14 | 15689 (n=1) | ██ |
| 15 | 11382 (n=1) | █ |
| 16 | 11595 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| replan_stop | 4 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| long_chain | fail | 13 | 0 | $0.0282 |
| masked | fail | 12 | 0 | $0.0238 |
| shared_frame | fail | 10 | 0 | $0.0268 |
| six_hunks | fail | 16 | 0 | $0.0412 |

