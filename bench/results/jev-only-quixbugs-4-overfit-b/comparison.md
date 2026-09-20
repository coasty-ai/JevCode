# JevCode bench 20260920-221404-968335

Generated 2026-09-20T22:15:14.605Z. Generator model `none (jev-only)`. 3 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $0.5000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0069 = $0.0069. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 3 | 3 | 3 | 3/3 (n=3) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| missing_condition | 1 | 1/1 100.0% |
| other | 2 | 2/2 100.0% |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `depth_first_search`, `detect_cycle`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 3/3 (n=3) 100.0% |
| steps-to-solve mean (n passed) | 5.33 (n=3) |
| steps-to-solve median | 5 |
| steps used mean (n runs) | 5.33 (n=3) |
| steps used median | 5 |
| read actions total / mean per run | 3 / 1 |
| blocked / reviews / declined | 3 / 1 / 1 |
| loops / replans | 1 / 0 |
| Jev requests / questions | 82 / 353 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 179.16 / 364.08 (n=82) |
| mean generator tokens/step (steps) | 0 (n=16) |
| mean Jev tokens/step (steps) | 10544 (n=16) |
| mean tokens/step, generator+Jev (steps) | 10544 (n=16) |
| wall time mean | 45s |
| cost generator / Jev / total | $0.0000 / $0.0069 / $0.0069 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  |
| 4 | 1/3 | 33.3% | ███████ |
| 5 | 2/3 | 66.7% | █████████████ |
| 6 | 2/3 | 66.7% | █████████████ |
| 7 | 3/3 | 100.0% | ████████████████████ |
| 8 | 3/3 | 100.0% | ████████████████████ |
| 9 | 3/3 | 100.0% | ████████████████████ |
| 10 | 3/3 | 100.0% | ████████████████████ |
| 11 | 3/3 | 100.0% | ████████████████████ |
| 12 | 3/3 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=3) |  |
| 2 | 0 (n=3) |  |
| 3 | 0 (n=3) |  |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=2) |  |
| 6 | 0 (n=1) |  |
| 7 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7773 (n=3) | ██████████ |
| 2 | 8568 (n=3) | ███████████ |
| 3 | 15112 (n=3) | ████████████████████ |
| 4 | 11772 (n=3) | ████████████████ |
| 5 | 12030 (n=2) | ████████████████ |
| 6 | 7455 (n=1) | ██████████ |
| 7 | 7524 (n=1) | ██████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7773 (n=3) | ██████████ |
| 2 | 8568 (n=3) | ███████████ |
| 3 | 15112 (n=3) | ████████████████████ |
| 4 | 11772 (n=3) | ████████████████ |
| 5 | 12030 (n=2) | ████████████████ |
| 6 | 7455 (n=1) | ██████████ |
| 7 | 7524 (n=1) | ██████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 2 | ████████████████████ |
| replan_stop | 1 | ██████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| depth_first_search | pass | 4 | 1 | $0.0018 |
| detect_cycle | pass | 5 | 1 | $0.0019 |
| wrap | pass | 7 | 1 | $0.0031 |

