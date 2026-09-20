# JevCode bench 20260920-203524-792936

Generated 2026-09-20T20:35:30.888Z. Generator model `none (jev-only)`. 1 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 8m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.5000, per-run cap $0.2500; spent generator $0.0000 + Jev $0.0019 = $0.0019. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 1 | 1 | 1 | 1/1 (n=1) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 1 | 1/1 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 1 | 1/1 100.0% |

### Paired comparison (n = 1 tasks evaluated in every condition)

Paired tasks: `tagcloud`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/1 (n=1) 100.0% |
| steps-to-solve mean (n passed) | 4 (n=1) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 4 (n=1) |
| steps used median | 4 |
| read actions total / mean per run | 1 / 1 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 23 / 96 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 185.08 / 347.81 (n=23) |
| mean generator tokens/step (steps) | 0 (n=4) |
| mean Jev tokens/step (steps) | 11945 (n=4) |
| mean tokens/step, generator+Jev (steps) | 11945 (n=4) |
| wall time mean | 6s |
| cost generator / Jev / total | $0.0000 / $0.0019 / $0.0019 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/1 | 0.0% |  |
| 2 | 0/1 | 0.0% |  |
| 3 | 0/1 | 0.0% |  |
| 4 | 1/1 | 100.0% | ████████████████████ |
| 5 | 1/1 | 100.0% | ████████████████████ |
| 6 | 1/1 | 100.0% | ████████████████████ |
| 7 | 1/1 | 100.0% | ████████████████████ |
| 8 | 1/1 | 100.0% | ████████████████████ |
| 9 | 1/1 | 100.0% | ████████████████████ |
| 10 | 1/1 | 100.0% | ████████████████████ |
| 11 | 1/1 | 100.0% | ████████████████████ |
| 12 | 1/1 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=1) |  |
| 2 | 0 (n=1) |  |
| 3 | 0 (n=1) |  |
| 4 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8196 (n=1) | ██████████ |
| 2 | 9535 (n=1) | ███████████ |
| 3 | 17182 (n=1) | ████████████████████ |
| 4 | 12866 (n=1) | ███████████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8196 (n=1) | ██████████ |
| 2 | 9535 (n=1) | ███████████ |
| 3 | 17182 (n=1) | ████████████████████ |
| 4 | 12866 (n=1) | ███████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| tagcloud | pass | 4 | 1 | $0.0019 |

