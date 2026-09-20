# JevCode bench 20260920-232207-8b1f46

Generated 2026-09-20T23:26:42.648Z. Generator model `none (jev-only)`. 3 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.4000, per-run cap $0.1500; spent generator $0.0000 + Jev $0.0202 = $0.0202. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 3 | 3 | 3 | 3/3 (n=3) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 1 | 1/1 100.0% |
| 2 | 1 | 1/1 100.0% |
| 3 | 1 | 1/1 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 2 | 2 | 2/2 100.0% |
| 4 | 1 | 1/1 100.0% |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `grades`, `shipping`, `table`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 3/3 (n=3) 100.0% |
| steps-to-solve mean (n passed) | 6.33 (n=3) |
| steps-to-solve median | 7 |
| steps used mean (n runs) | 6.33 (n=3) |
| steps used median | 7 |
| read actions total / mean per run | 4 / 1.33 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 145 / 2349 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 205.39 / 382.82 (n=145) |
| mean generator tokens/step (steps) | 0 (n=19) |
| mean Jev tokens/step (steps) | 28747 (n=19) |
| mean tokens/step, generator+Jev (steps) | 28747 (n=19) |
| wall time mean | 2m53s |
| cost generator / Jev / total | $0.0000 / $0.0202 / $0.0202 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  |
| 4 | 0/3 | 0.0% |  |
| 5 | 1/3 | 33.3% | ███████ |
| 6 | 1/3 | 33.3% | ███████ |
| 7 | 3/3 | 100.0% | ████████████████████ |
| 8 | 3/3 | 100.0% | ████████████████████ |
| 9 | 3/3 | 100.0% | ████████████████████ |
| 10 | 3/3 | 100.0% | ████████████████████ |
| 11 | 3/3 | 100.0% | ████████████████████ |
| 12 | 3/3 | 100.0% | ████████████████████ |
| 13 | 3/3 | 100.0% | ████████████████████ |
| 14 | 3/3 | 100.0% | ████████████████████ |
| 15 | 3/3 | 100.0% | ████████████████████ |
| 16 | 3/3 | 100.0% | ████████████████████ |
| 17 | 3/3 | 100.0% | ████████████████████ |
| 18 | 3/3 | 100.0% | ████████████████████ |
| 19 | 3/3 | 100.0% | ████████████████████ |
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
| 6 | 0 (n=2) |  |
| 7 | 0 (n=2) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8217 (n=3) | ██ |
| 2 | 10271 (n=3) | ██ |
| 3 | 34137 (n=3) | ████████ |
| 4 | 90637 (n=3) | ████████████████████ |
| 5 | 17415 (n=3) | ████ |
| 6 | 18754 (n=2) | ████ |
| 7 | 13322 (n=2) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8217 (n=3) | ██ |
| 2 | 10271 (n=3) | ██ |
| 3 | 34137 (n=3) | ████████ |
| 4 | 90637 (n=3) | ████████████████████ |
| 5 | 17415 (n=3) | ████ |
| 6 | 18754 (n=2) | ████ |
| 7 | 13322 (n=2) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 3 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| grades | pass | 7 | 2 | $0.0040 |
| shipping | pass | 5 | 1 | $0.0038 |
| table | pass | 7 | 1 | $0.0124 |

