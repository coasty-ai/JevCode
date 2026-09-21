# JevCode bench 20260921-012803-e1c737

Generated 2026-09-21T01:41:39.966Z. Generator model `none (jev-only)`. 4 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.1500; spent generator $0.0000 + Jev $0.1021 = $0.1021. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 4 | 4 | 1 | 1/4 (n=4) 25.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 0/1 0.0% |
| 3 | 1 | 1/1 100.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 4 | 2 | 1/2 50.0% |
| 5 | 2 | 0/2 0.0% |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `long_chain`, `masked`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/4 (n=4) 25.0% |
| steps-to-solve mean (n passed) | 7 (n=1) |
| steps-to-solve median | 7 |
| steps used mean (n runs) | 10.75 (n=4) |
| steps used median | 8 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 18 / 0 / 0 |
| loops / replans | 8 / 5 |
| Jev requests / questions | 617 / 10923 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 185.24 / 355.01 (n=617) |
| mean generator tokens/step (steps) | 0 (n=43) |
| mean Jev tokens/step (steps) | 67757 (n=43) |
| mean tokens/step, generator+Jev (steps) | 67757 (n=43) |
| wall time mean | 3m23s |
| cost generator / Jev / total | $0.0000 / $0.1021 / $0.1021 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/4 | 0.0% |  |
| 2 | 0/4 | 0.0% |  |
| 3 | 0/4 | 0.0% |  |
| 4 | 0/4 | 0.0% |  |
| 5 | 0/4 | 0.0% |  |
| 6 | 0/4 | 0.0% |  |
| 7 | 1/4 | 25.0% | █████ |
| 8 | 1/4 | 25.0% | █████ |
| 9 | 1/4 | 25.0% | █████ |
| 10 | 1/4 | 25.0% | █████ |
| 11 | 1/4 | 25.0% | █████ |
| 12 | 1/4 | 25.0% | █████ |
| 13 | 1/4 | 25.0% | █████ |
| 14 | 1/4 | 25.0% | █████ |
| 15 | 1/4 | 25.0% | █████ |
| 16 | 1/4 | 25.0% | █████ |
| 17 | 1/4 | 25.0% | █████ |
| 18 | 1/4 | 25.0% | █████ |
| 19 | 1/4 | 25.0% | █████ |
| 20 | 1/4 | 25.0% | █████ |
| 21 | 1/4 | 25.0% | █████ |
| 22 | 1/4 | 25.0% | █████ |
| 23 | 1/4 | 25.0% | █████ |
| 24 | 1/4 | 25.0% | █████ |
| 25 | 1/4 | 25.0% | █████ |
| 26 | 1/4 | 25.0% | █████ |
| 27 | 1/4 | 25.0% | █████ |
| 28 | 1/4 | 25.0% | █████ |
| 29 | 1/4 | 25.0% | █████ |
| 30 | 1/4 | 25.0% | █████ |

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
| 8 | 0 (n=3) |  |
| 9 | 0 (n=2) |  |
| 10 | 0 (n=2) |  |
| 11 | 0 (n=2) |  |
| 12 | 0 (n=2) |  |
| 13 | 0 (n=1) |  |
| 14 | 0 (n=1) |  |
| 15 | 0 (n=1) |  |
| 16 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9663 (n=4) | █ |
| 2 | 187031 (n=4) | ████████████████████ |
| 3 | 144758 (n=4) | ███████████████ |
| 4 | 76789 (n=4) | ████████ |
| 5 | 14555 (n=4) | ██ |
| 6 | 76511 (n=4) | ████████ |
| 7 | 62570 (n=4) | ███████ |
| 8 | 60897 (n=3) | ███████ |
| 9 | 127997 (n=2) | ██████████████ |
| 10 | 17867 (n=2) | ██ |
| 11 | 11130 (n=2) | █ |
| 12 | 25652 (n=2) | ███ |
| 13 | 41486 (n=1) | ████ |
| 14 | 12191 (n=1) | █ |
| 15 | 12188 (n=1) | █ |
| 16 | 12191 (n=1) | █ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9663 (n=4) | █ |
| 2 | 187031 (n=4) | ████████████████████ |
| 3 | 144758 (n=4) | ███████████████ |
| 4 | 76789 (n=4) | ████████ |
| 5 | 14555 (n=4) | ██ |
| 6 | 76511 (n=4) | ████████ |
| 7 | 62570 (n=4) | ███████ |
| 8 | 60897 (n=3) | ███████ |
| 9 | 127997 (n=2) | ██████████████ |
| 10 | 17867 (n=2) | ██ |
| 11 | 11130 (n=2) | █ |
| 12 | 25652 (n=2) | ███ |
| 13 | 41486 (n=1) | ████ |
| 14 | 12191 (n=1) | █ |
| 15 | 12188 (n=1) | █ |
| 16 | 12191 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | ███████ |
| replan_stop | 3 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| long_chain | fail | 12 | 0 | $0.0250 |
| masked | pass | 7 | 0 | $0.0135 |
| shared_frame | fail | 8 | 0 | $0.0195 |
| six_hunks | fail | 16 | 0 | $0.0441 |

