# JevCode bench 20260920-211942-c70988

Generated 2026-09-20T21:23:49.931Z. Generator model `none (jev-only)`. 3 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2500; spent generator $0.0000 + Jev $0.0386 = $0.0386. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 3 | 3 | 3 | 3/3 (n=3) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 2 | 2/2 100.0% |
| 3 | 1 | 1/1 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 2 | 2 | 2/2 100.0% |
| 3 | 1 | 1/1 100.0% |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `calendar_utils`, `grades`, `inventory`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 3/3 (n=3) 100.0% |
| steps-to-solve mean (n passed) | 20 (n=3) |
| steps-to-solve median | 20 |
| steps used mean (n runs) | 20 (n=3) |
| steps used median | 20 |
| read actions total / mean per run | 18 / 6 |
| blocked / reviews / declined | 26 / 26 / 26 |
| loops / replans | 6 / 4 |
| Jev requests / questions | 325 / 1908 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 191.54 / 322.98 (n=325) |
| mean generator tokens/step (steps) | 0 (n=60) |
| mean Jev tokens/step (steps) | 16780 (n=60) |
| mean tokens/step, generator+Jev (steps) | 16780 (n=60) |
| wall time mean | 2m28s |
| cost generator / Jev / total | $0.0000 / $0.0386 / $0.0386 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  |
| 4 | 0/3 | 0.0% |  |
| 5 | 0/3 | 0.0% |  |
| 6 | 0/3 | 0.0% |  |
| 7 | 0/3 | 0.0% |  |
| 8 | 0/3 | 0.0% |  |
| 9 | 0/3 | 0.0% |  |
| 10 | 0/3 | 0.0% |  |
| 11 | 0/3 | 0.0% |  |
| 12 | 0/3 | 0.0% |  |
| 13 | 0/3 | 0.0% |  |
| 14 | 0/3 | 0.0% |  |
| 15 | 0/3 | 0.0% |  |
| 16 | 0/3 | 0.0% |  |
| 17 | 0/3 | 0.0% |  |
| 18 | 0/3 | 0.0% |  |
| 19 | 0/3 | 0.0% |  |
| 20 | 3/3 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=3) |  |
| 2 | 0 (n=3) |  |
| 3 | 0 (n=3) |  |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=3) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=3) |  |
| 9 | 0 (n=3) |  |
| 10 | 0 (n=3) |  |
| 11 | 0 (n=3) |  |
| 12 | 0 (n=3) |  |
| 13 | 0 (n=3) |  |
| 14 | 0 (n=3) |  |
| 15 | 0 (n=3) |  |
| 16 | 0 (n=3) |  |
| 17 | 0 (n=3) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=3) |  |
| 20 | 0 (n=3) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7852 (n=3) | ██ |
| 2 | 9708 (n=3) | ███ |
| 3 | 11065 (n=3) | ███ |
| 4 | 22768 (n=3) | ██████ |
| 5 | 11496 (n=3) | ███ |
| 6 | 14039 (n=3) | ████ |
| 7 | 28592 (n=3) | ███████ |
| 8 | 12519 (n=3) | ███ |
| 9 | 15046 (n=3) | ████ |
| 10 | 11081 (n=3) | ███ |
| 11 | 12098 (n=3) | ███ |
| 12 | 14849 (n=3) | ████ |
| 13 | 76669 (n=3) | ████████████████████ |
| 14 | 11145 (n=3) | ███ |
| 15 | 12219 (n=3) | ███ |
| 16 | 12491 (n=3) | ███ |
| 17 | 13962 (n=3) | ████ |
| 18 | 12841 (n=3) | ███ |
| 19 | 13404 (n=3) | ███ |
| 20 | 11753 (n=3) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7852 (n=3) | ██ |
| 2 | 9708 (n=3) | ███ |
| 3 | 11065 (n=3) | ███ |
| 4 | 22768 (n=3) | ██████ |
| 5 | 11496 (n=3) | ███ |
| 6 | 14039 (n=3) | ████ |
| 7 | 28592 (n=3) | ███████ |
| 8 | 12519 (n=3) | ███ |
| 9 | 15046 (n=3) | ████ |
| 10 | 11081 (n=3) | ███ |
| 11 | 12098 (n=3) | ███ |
| 12 | 14849 (n=3) | ████ |
| 13 | 76669 (n=3) | ████████████████████ |
| 14 | 11145 (n=3) | ███ |
| 15 | 12219 (n=3) | ███ |
| 16 | 12491 (n=3) | ███ |
| 17 | 13962 (n=3) | ████ |
| 18 | 12841 (n=3) | ███ |
| 19 | 13404 (n=3) | ███ |
| 20 | 11753 (n=3) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_steps | 3 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| calendar_utils | pass | 20 | 4 | $0.0182 |
| grades | pass | 20 | 7 | $0.0100 |
| inventory | pass | 20 | 7 | $0.0105 |

