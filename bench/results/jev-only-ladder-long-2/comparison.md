# JevCode bench 20260920-234614-e59ca3

Generated 2026-09-21T00:15:43.046Z. Generator model `none (jev-only)`. 8 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.2000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2000; spent generator $0.0000 + Jev $0.2660 = $0.2660. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 8 | 8 | 2 | 2/8 (n=8) 25.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 0/1 0.0% |
| 3 | 1 | 0/1 0.0% |
| 4 | 3 | 1/3 33.3% |
| 5 | 1 | 1/1 100.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 4 | 5 | 2/5 40.0% |
| 5 | 3 | 0/3 0.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `crossfile`, `import_and_guard`, `ledger5`, `long_chain`, `masked`, `regress_trap`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 2/8 (n=8) 25.0% |
| steps-to-solve mean (n passed) | 23.50 (n=2) |
| steps-to-solve median | 19 |
| steps used mean (n runs) | 22.88 (n=8) |
| steps used median | 23 |
| read actions total / mean per run | 54 / 6.75 |
| blocked / reviews / declined | 54 / 36 / 36 |
| loops / replans | 42 / 35 |
| Jev requests / questions | 1715 / 26266 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 194.09 / 362.72 (n=1715) |
| mean generator tokens/step (steps) | 0 (n=183) |
| mean Jev tokens/step (steps) | 39987 (n=183) |
| mean tokens/step, generator+Jev (steps) | 39987 (n=183) |
| wall time mean | 7m15s |
| cost generator / Jev / total | $0.0000 / $0.2660 / $0.2660 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 0/8 | 0.0% |  |
| 3 | 0/8 | 0.0% |  |
| 4 | 0/8 | 0.0% |  |
| 5 | 0/8 | 0.0% |  |
| 6 | 0/8 | 0.0% |  |
| 7 | 0/8 | 0.0% |  |
| 8 | 0/8 | 0.0% |  |
| 9 | 0/8 | 0.0% |  |
| 10 | 0/8 | 0.0% |  |
| 11 | 0/8 | 0.0% |  |
| 12 | 0/8 | 0.0% |  |
| 13 | 0/8 | 0.0% |  |
| 14 | 0/8 | 0.0% |  |
| 15 | 0/8 | 0.0% |  |
| 16 | 0/8 | 0.0% |  |
| 17 | 0/8 | 0.0% |  |
| 18 | 0/8 | 0.0% |  |
| 19 | 1/8 | 12.5% | ███ |
| 20 | 1/8 | 12.5% | ███ |
| 21 | 1/8 | 12.5% | ███ |
| 22 | 1/8 | 12.5% | ███ |
| 23 | 1/8 | 12.5% | ███ |
| 24 | 1/8 | 12.5% | ███ |
| 25 | 1/8 | 12.5% | ███ |
| 26 | 1/8 | 12.5% | ███ |
| 27 | 1/8 | 12.5% | ███ |
| 28 | 2/8 | 25.0% | █████ |
| 29 | 2/8 | 25.0% | █████ |
| 30 | 2/8 | 25.0% | █████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=8) |  |
| 2 | 0 (n=8) |  |
| 3 | 0 (n=8) |  |
| 4 | 0 (n=8) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=8) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=8) |  |
| 10 | 0 (n=8) |  |
| 11 | 0 (n=8) |  |
| 12 | 0 (n=8) |  |
| 13 | 0 (n=8) |  |
| 14 | 0 (n=8) |  |
| 15 | 0 (n=8) |  |
| 16 | 0 (n=8) |  |
| 17 | 0 (n=7) |  |
| 18 | 0 (n=7) |  |
| 19 | 0 (n=7) |  |
| 20 | 0 (n=6) |  |
| 21 | 0 (n=5) |  |
| 22 | 0 (n=5) |  |
| 23 | 0 (n=5) |  |
| 24 | 0 (n=4) |  |
| 25 | 0 (n=4) |  |
| 26 | 0 (n=2) |  |
| 27 | 0 (n=2) |  |
| 28 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9566 (n=8) | ██ |
| 2 | 11263 (n=8) | ██ |
| 3 | 47451 (n=8) | █████████ |
| 4 | 100459 (n=8) | ████████████████████ |
| 5 | 65659 (n=8) | █████████████ |
| 6 | 38937 (n=8) | ████████ |
| 7 | 61297 (n=8) | ████████████ |
| 8 | 48722 (n=8) | ██████████ |
| 9 | 26124 (n=8) | █████ |
| 10 | 44185 (n=8) | █████████ |
| 11 | 27942 (n=8) | ██████ |
| 12 | 40673 (n=8) | ████████ |
| 13 | 35761 (n=8) | ███████ |
| 14 | 16513 (n=8) | ███ |
| 15 | 14863 (n=8) | ███ |
| 16 | 34756 (n=8) | ███████ |
| 17 | 34297 (n=7) | ███████ |
| 18 | 78779 (n=7) | ████████████████ |
| 19 | 47369 (n=7) | █████████ |
| 20 | 14402 (n=6) | ███ |
| 21 | 59649 (n=5) | ████████████ |
| 22 | 45671 (n=5) | █████████ |
| 23 | 14785 (n=5) | ███ |
| 24 | 52492 (n=4) | ██████████ |
| 25 | 56781 (n=4) | ███████████ |
| 26 | 16976 (n=2) | ███ |
| 27 | 13342 (n=2) | ███ |
| 28 | 16502 (n=1) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9566 (n=8) | ██ |
| 2 | 11263 (n=8) | ██ |
| 3 | 47451 (n=8) | █████████ |
| 4 | 100459 (n=8) | ████████████████████ |
| 5 | 65659 (n=8) | █████████████ |
| 6 | 38937 (n=8) | ████████ |
| 7 | 61297 (n=8) | ████████████ |
| 8 | 48722 (n=8) | ██████████ |
| 9 | 26124 (n=8) | █████ |
| 10 | 44185 (n=8) | █████████ |
| 11 | 27942 (n=8) | ██████ |
| 12 | 40673 (n=8) | ████████ |
| 13 | 35761 (n=8) | ███████ |
| 14 | 16513 (n=8) | ███ |
| 15 | 14863 (n=8) | ███ |
| 16 | 34756 (n=8) | ███████ |
| 17 | 34297 (n=7) | ███████ |
| 18 | 78779 (n=7) | ████████████████ |
| 19 | 47369 (n=7) | █████████ |
| 20 | 14402 (n=6) | ███ |
| 21 | 59649 (n=5) | ████████████ |
| 22 | 45671 (n=5) | █████████ |
| 23 | 14785 (n=5) | ███ |
| 24 | 52492 (n=4) | ██████████ |
| 25 | 56781 (n=4) | ███████████ |
| 26 | 16976 (n=2) | ███ |
| 27 | 13342 (n=2) | ███ |
| 28 | 16502 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | ███ |
| max_replans | 6 | ████████████████████ |
| replan_stop | 1 | ███ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| crossfile | fail | 23 | 5 | $0.0471 |
| import_and_guard | pass | 19 | 6 | $0.0131 |
| ledger5 | pass | 28 | 7 | $0.0338 |
| long_chain | fail | 20 | 6 | $0.0278 |
| masked | fail | 25 | 10 | $0.0380 |
| regress_trap | fail | 25 | 7 | $0.0312 |
| shared_frame | fail | 16 | 7 | $0.0326 |
| six_hunks | fail | 27 | 6 | $0.0424 |

