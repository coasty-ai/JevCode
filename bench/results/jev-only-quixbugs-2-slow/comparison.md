# JevCode bench 20260920-203814-7144ed

Generated 2026-09-20T20:42:02.610Z. Generator model `none (jev-only)`. 5 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0423 = $0.0423. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 5 | 5 | 3 | 3/5 (n=5) 60.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| off_by_one | 2 | 2/2 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 2 | 0/2 0.0% |

### Paired comparison (n = 5 tasks evaluated in every condition)

Paired tasks: `bitcount`, `find_first_in_sorted`, `mergesort`, `shunting_yard`, `sqrt`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 3/5 (n=5) 60.0% |
| steps-to-solve mean (n passed) | 5.67 (n=3) |
| steps-to-solve median | 6 |
| steps used mean (n runs) | 8.20 (n=5) |
| steps used median | 8 |
| read actions total / mean per run | 11 / 2.20 |
| blocked / reviews / declined | 20 / 11 / 11 |
| loops / replans | 6 / 6 |
| Jev requests / questions | 288 / 5385 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 185.82 / 317.14 (n=288) |
| mean generator tokens/step (steps) | 0 (n=41) |
| mean Jev tokens/step (steps) | 27380 (n=41) |
| mean tokens/step, generator+Jev (steps) | 27380 (n=41) |
| wall time mean | 2m22s |
| cost generator / Jev / total | $0.0000 / $0.0423 / $0.0423 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/5 | 0.0% |  |
| 2 | 0/5 | 0.0% |  |
| 3 | 1/5 | 20.0% | ████ |
| 4 | 1/5 | 20.0% | ████ |
| 5 | 1/5 | 20.0% | ████ |
| 6 | 2/5 | 40.0% | ████████ |
| 7 | 2/5 | 40.0% | ████████ |
| 8 | 3/5 | 60.0% | ████████████ |
| 9 | 3/5 | 60.0% | ████████████ |
| 10 | 3/5 | 60.0% | ████████████ |
| 11 | 3/5 | 60.0% | ████████████ |
| 12 | 3/5 | 60.0% | ████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=5) |  |
| 2 | 0 (n=5) |  |
| 3 | 0 (n=5) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=3) |  |
| 9 | 0 (n=2) |  |
| 10 | 0 (n=2) |  |
| 11 | 0 (n=2) |  |
| 12 | 0 (n=2) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6898 (n=5) | █ |
| 2 | 12291 (n=5) | ███ |
| 3 | 71208 (n=5) | ███████████████ |
| 4 | 15075 (n=4) | ███ |
| 5 | 28470 (n=4) | ██████ |
| 6 | 46740 (n=4) | ██████████ |
| 7 | 9316 (n=3) | ██ |
| 8 | 11032 (n=3) | ██ |
| 9 | 9241 (n=2) | ██ |
| 10 | 7983 (n=2) | ██ |
| 11 | 9693 (n=2) | ██ |
| 12 | 97284 (n=2) | ████████████████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6898 (n=5) | █ |
| 2 | 12291 (n=5) | ███ |
| 3 | 71208 (n=5) | ███████████████ |
| 4 | 15075 (n=4) | ███ |
| 5 | 28470 (n=4) | ██████ |
| 6 | 46740 (n=4) | ██████████ |
| 7 | 9316 (n=3) | ██ |
| 8 | 11032 (n=3) | ██ |
| 9 | 9241 (n=2) | ██ |
| 10 | 7983 (n=2) | ██ |
| 11 | 9693 (n=2) | ██ |
| 12 | 97284 (n=2) | ████████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 3 | ████████████████████ |
| max_steps | 2 | █████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| bitcount | pass | 6 | 2 | $0.0041 |
| find_first_in_sorted | pass | 3 | 1 | $0.0018 |
| mergesort | pass | 8 | 2 | $0.0089 |
| shunting_yard | fail | 12 | 2 | $0.0197 |
| sqrt | fail | 12 | 4 | $0.0078 |

