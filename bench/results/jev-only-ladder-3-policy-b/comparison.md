# JevCode bench 20260920-212507-a1d83a

Generated 2026-09-20T21:25:46.990Z. Generator model `none (jev-only)`. 1 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $0.1000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0096 = $0.0096. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 1 | 1 | 1 | 1/1 (n=1) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 1/1 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 1/1 100.0% |

### Paired comparison (n = 1 tasks evaluated in every condition)

Paired tasks: `grades`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/1 (n=1) 100.0% |
| steps-to-solve mean (n passed) | 20 (n=1) |
| steps-to-solve median | 20 |
| steps used mean (n runs) | 20 (n=1) |
| steps used median | 20 |
| read actions total / mean per run | 2 / 2 |
| blocked / reviews / declined | 13 / 2 / 2 |
| loops / replans | 4 / 3 |
| Jev requests / questions | 84 / 413 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 195.17 / 362.65 (n=84) |
| mean generator tokens/step (steps) | 0 (n=20) |
| mean Jev tokens/step (steps) | 11942 (n=20) |
| mean tokens/step, generator+Jev (steps) | 11942 (n=20) |
| wall time mean | 39s |
| cost generator / Jev / total | $0.0000 / $0.0096 / $0.0096 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/1 | 0.0% |  |
| 2 | 0/1 | 0.0% |  |
| 3 | 0/1 | 0.0% |  |
| 4 | 0/1 | 0.0% |  |
| 5 | 0/1 | 0.0% |  |
| 6 | 0/1 | 0.0% |  |
| 7 | 0/1 | 0.0% |  |
| 8 | 0/1 | 0.0% |  |
| 9 | 0/1 | 0.0% |  |
| 10 | 0/1 | 0.0% |  |
| 11 | 0/1 | 0.0% |  |
| 12 | 0/1 | 0.0% |  |
| 13 | 0/1 | 0.0% |  |
| 14 | 0/1 | 0.0% |  |
| 15 | 0/1 | 0.0% |  |
| 16 | 0/1 | 0.0% |  |
| 17 | 0/1 | 0.0% |  |
| 18 | 0/1 | 0.0% |  |
| 19 | 0/1 | 0.0% |  |
| 20 | 1/1 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=1) |  |
| 2 | 0 (n=1) |  |
| 3 | 0 (n=1) |  |
| 4 | 0 (n=1) |  |
| 5 | 0 (n=1) |  |
| 6 | 0 (n=1) |  |
| 7 | 0 (n=1) |  |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |
| 13 | 0 (n=1) |  |
| 14 | 0 (n=1) |  |
| 15 | 0 (n=1) |  |
| 16 | 0 (n=1) |  |
| 17 | 0 (n=1) |  |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7719 (n=1) | ███████ |
| 2 | 9670 (n=1) | █████████ |
| 3 | 11025 (n=1) | ██████████ |
| 4 | 19234 (n=1) | █████████████████ |
| 5 | 9856 (n=1) | █████████ |
| 6 | 14404 (n=1) | █████████████ |
| 7 | 22354 (n=1) | ████████████████████ |
| 8 | 14547 (n=1) | █████████████ |
| 9 | 10135 (n=1) | █████████ |
| 10 | 9934 (n=1) | █████████ |
| 11 | 9109 (n=1) | ████████ |
| 12 | 13337 (n=1) | ████████████ |
| 13 | 9862 (n=1) | █████████ |
| 14 | 9784 (n=1) | █████████ |
| 15 | 13927 (n=1) | ████████████ |
| 16 | 9944 (n=1) | █████████ |
| 17 | 9946 (n=1) | █████████ |
| 18 | 14132 (n=1) | █████████████ |
| 19 | 9964 (n=1) | █████████ |
| 20 | 9964 (n=1) | █████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7719 (n=1) | ███████ |
| 2 | 9670 (n=1) | █████████ |
| 3 | 11025 (n=1) | ██████████ |
| 4 | 19234 (n=1) | █████████████████ |
| 5 | 9856 (n=1) | █████████ |
| 6 | 14404 (n=1) | █████████████ |
| 7 | 22354 (n=1) | ████████████████████ |
| 8 | 14547 (n=1) | █████████████ |
| 9 | 10135 (n=1) | █████████ |
| 10 | 9934 (n=1) | █████████ |
| 11 | 9109 (n=1) | ████████ |
| 12 | 13337 (n=1) | ████████████ |
| 13 | 9862 (n=1) | █████████ |
| 14 | 9784 (n=1) | █████████ |
| 15 | 13927 (n=1) | ████████████ |
| 16 | 9944 (n=1) | █████████ |
| 17 | 9946 (n=1) | █████████ |
| 18 | 14132 (n=1) | █████████████ |
| 19 | 9964 (n=1) | █████████ |
| 20 | 9964 (n=1) | █████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_steps | 1 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| grades | pass | 20 | 2 | $0.0096 |

