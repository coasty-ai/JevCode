# JevCode bench 20260920-232221-96b4bf

Generated 2026-09-20T23:45:01.631Z. Generator model `none (jev-only)`. 4 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.2000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2000; spent generator $0.0000 + Jev $0.1759 = $0.1759. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 4 | 4 | 1 | 1/4 (n=4) 25.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 3 | 1 | 0/1 0.0% |
| 4 | 1 | 0/1 0.0% |
| 5 | 1 | 1/1 100.0% |
| 6 | 1 | 0/1 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 4 | 2 | 1/2 50.0% |
| 5 | 2 | 0/2 0.0% |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `crossfile`, `ledger5`, `long_chain`, `masked`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/4 (n=4) 25.0% |
| steps-to-solve mean (n passed) | 27 (n=1) |
| steps-to-solve median | 27 |
| steps used mean (n runs) | 23.25 (n=4) |
| steps used median | 19 |
| read actions total / mean per run | 28 / 7 |
| blocked / reviews / declined | 21 / 15 / 15 |
| loops / replans | 20 / 18 |
| Jev requests / questions | 1048 / 22264 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 200.25 / 405.79 (n=1048) |
| mean generator tokens/step (steps) | 0 (n=93) |
| mean Jev tokens/step (steps) | 52250 (n=93) |
| mean tokens/step, generator+Jev (steps) | 52250 (n=93) |
| wall time mean | 9m50s |
| cost generator / Jev / total | $0.0000 / $0.1759 / $0.1759 |

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
| 8 | 0 (n=4) |  |
| 9 | 0 (n=4) |  |
| 10 | 0 (n=4) |  |
| 11 | 0 (n=4) |  |
| 12 | 0 (n=4) |  |
| 13 | 0 (n=4) |  |
| 14 | 0 (n=4) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=3) |  |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=2) |  |
| 22 | 0 (n=2) |  |
| 23 | 0 (n=2) |  |
| 24 | 0 (n=2) |  |
| 25 | 0 (n=2) |  |
| 26 | 0 (n=2) |  |
| 27 | 0 (n=2) |  |
| 28 | 0 (n=1) |  |
| 29 | 0 (n=1) |  |
| 30 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9788 (n=4) | █ |
| 2 | 11197 (n=4) | █ |
| 3 | 94432 (n=4) | █████████ |
| 4 | 121396 (n=4) | ███████████ |
| 5 | 74387 (n=4) | ███████ |
| 6 | 158930 (n=4) | ███████████████ |
| 7 | 15257 (n=4) | █ |
| 8 | 59457 (n=4) | ██████ |
| 9 | 16806 (n=4) | ██ |
| 10 | 18479 (n=4) | ██ |
| 11 | 57495 (n=4) | █████ |
| 12 | 24014 (n=4) | ██ |
| 13 | 17312 (n=4) | ██ |
| 14 | 55571 (n=4) | █████ |
| 15 | 13941 (n=4) | █ |
| 16 | 21188 (n=4) | ██ |
| 17 | 95823 (n=4) | █████████ |
| 18 | 69217 (n=3) | ██████ |
| 19 | 58049 (n=3) | █████ |
| 20 | 214241 (n=2) | ████████████████████ |
| 21 | 20876 (n=2) | ██ |
| 22 | 21418 (n=2) | ██ |
| 23 | 65432 (n=2) | ██████ |
| 24 | 30971 (n=2) | ███ |
| 25 | 14361 (n=2) | █ |
| 26 | 16904 (n=2) | ██ |
| 27 | 16284 (n=2) | ██ |
| 28 | 24298 (n=1) | ██ |
| 29 | 18530 (n=1) | ██ |
| 30 | 171786 (n=1) | ████████████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9788 (n=4) | █ |
| 2 | 11197 (n=4) | █ |
| 3 | 94432 (n=4) | █████████ |
| 4 | 121396 (n=4) | ███████████ |
| 5 | 74387 (n=4) | ███████ |
| 6 | 158930 (n=4) | ███████████████ |
| 7 | 15257 (n=4) | █ |
| 8 | 59457 (n=4) | ██████ |
| 9 | 16806 (n=4) | ██ |
| 10 | 18479 (n=4) | ██ |
| 11 | 57495 (n=4) | █████ |
| 12 | 24014 (n=4) | ██ |
| 13 | 17312 (n=4) | ██ |
| 14 | 55571 (n=4) | █████ |
| 15 | 13941 (n=4) | █ |
| 16 | 21188 (n=4) | ██ |
| 17 | 95823 (n=4) | █████████ |
| 18 | 69217 (n=3) | ██████ |
| 19 | 58049 (n=3) | █████ |
| 20 | 214241 (n=2) | ████████████████████ |
| 21 | 20876 (n=2) | ██ |
| 22 | 21418 (n=2) | ██ |
| 23 | 65432 (n=2) | ██████ |
| 24 | 30971 (n=2) | ███ |
| 25 | 14361 (n=2) | █ |
| 26 | 16904 (n=2) | ██ |
| 27 | 16284 (n=2) | ██ |
| 28 | 24298 (n=1) | ██ |
| 29 | 18530 (n=1) | ██ |
| 30 | 171786 (n=1) | ████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | ██████████ |
| max_replans | 2 | ████████████████████ |
| max_steps | 1 | ██████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| crossfile | fail | 30 | 8 | $0.0802 |
| ledger5 | pass | 27 | 8 | $0.0366 |
| long_chain | fail | 19 | 9 | $0.0286 |
| masked | fail | 17 | 3 | $0.0305 |

