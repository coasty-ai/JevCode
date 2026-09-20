# JevCode bench 20260920-212633-65807a

Generated 2026-09-20T21:29:30.273Z. Generator model `none (jev-only)`. 4 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0135 = $0.0135. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 4 | 4 | 4 | 4/4 (n=4) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| other | 4 | 4/4 100.0% |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `depth_first_search`, `reverse_linked_list`, `shunting_yard`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 4/4 (n=4) 100.0% |
| steps-to-solve mean (n passed) | 5.75 (n=4) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 5.75 (n=4) |
| steps used median | 4 |
| read actions total / mean per run | 6 / 1.50 |
| blocked / reviews / declined | 5 / 5 / 5 |
| loops / replans | 1 / 1 |
| Jev requests / questions | 143 / 634 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 189.70 / 311.99 (n=143) |
| mean generator tokens/step (steps) | 0 (n=23) |
| mean Jev tokens/step (steps) | 15380 (n=23) |
| mean tokens/step, generator+Jev (steps) | 15380 (n=23) |
| wall time mean | 1m21s |
| cost generator / Jev / total | $0.0000 / $0.0135 / $0.0135 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/4 | 0.0% |  |
| 2 | 0/4 | 0.0% |  |
| 3 | 0/4 | 0.0% |  |
| 4 | 2/4 | 50.0% | ██████████ |
| 5 | 2/4 | 50.0% | ██████████ |
| 6 | 3/4 | 75.0% | ███████████████ |
| 7 | 3/4 | 75.0% | ███████████████ |
| 8 | 3/4 | 75.0% | ███████████████ |
| 9 | 4/4 | 100.0% | ████████████████████ |
| 10 | 4/4 | 100.0% | ████████████████████ |
| 11 | 4/4 | 100.0% | ████████████████████ |
| 12 | 4/4 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=4) |  |
| 2 | 0 (n=4) |  |
| 3 | 0 (n=4) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=2) |  |
| 6 | 0 (n=2) |  |
| 7 | 0 (n=1) |  |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8051 (n=4) | █████ |
| 2 | 8781 (n=4) | █████ |
| 3 | 14333 (n=4) | ████████ |
| 4 | 35320 (n=4) | ████████████████████ |
| 5 | 9924 (n=2) | ██████ |
| 6 | 11942 (n=2) | ███████ |
| 7 | 22148 (n=1) | █████████████ |
| 8 | 8752 (n=1) | █████ |
| 9 | 13170 (n=1) | ███████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8051 (n=4) | █████ |
| 2 | 8781 (n=4) | █████ |
| 3 | 14333 (n=4) | ████████ |
| 4 | 35320 (n=4) | ████████████████████ |
| 5 | 9924 (n=2) | ██████ |
| 6 | 11942 (n=2) | ███████ |
| 7 | 22148 (n=1) | █████████████ |
| 8 | 8752 (n=1) | █████ |
| 9 | 13170 (n=1) | ███████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 4 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| depth_first_search | pass | 4 | 1 | $0.0019 |
| reverse_linked_list | pass | 9 | 2 | $0.0069 |
| shunting_yard | pass | 4 | 1 | $0.0021 |
| wrap | pass | 6 | 2 | $0.0026 |

