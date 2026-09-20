# JevCode bench 20260920-231644-f07a4c

Generated 2026-09-20T23:18:51.323Z. Generator model `none (jev-only)`. 1 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 12m | $0.3000 | auto | 2m | 200 KB |

## Spend

Bench cap $0.4000, per-run cap $0.3000; spent generator $0.0000 + Jev $0.0167 = $0.0167. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 1 | 1 | 1 | 1/1 (n=1) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 3 | 1 | 1/1 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 3 | 1 | 1/1 100.0% |

### Paired comparison (n = 1 tasks evaluated in every condition)

Paired tasks: `account`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/1 (n=1) 100.0% |
| steps-to-solve mean (n passed) | 20 (n=1) |
| steps-to-solve median | 20 |
| steps used mean (n runs) | 20 (n=1) |
| steps used median | 20 |
| read actions total / mean per run | 1 / 1 |
| blocked / reviews / declined | 14 / 3 / 3 |
| loops / replans | 5 / 4 |
| Jev requests / questions | 125 / 2413 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 187.57 / 332.61 (n=125) |
| mean generator tokens/step (steps) | 0 (n=20) |
| mean Jev tokens/step (steps) | 22193 (n=20) |
| mean tokens/step, generator+Jev (steps) | 22193 (n=20) |
| wall time mean | 2m6s |
| cost generator / Jev / total | $0.0000 / $0.0167 / $0.0167 |

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
| 1 | 8021 (n=1) | █ |
| 2 | 9196 (n=1) | █ |
| 3 | 95387 (n=1) | ███████████ |
| 4 | 12391 (n=1) | █ |
| 5 | 8688 (n=1) | █ |
| 6 | 169460 (n=1) | ████████████████████ |
| 7 | 7632 (n=1) | █ |
| 8 | 14879 (n=1) | ██ |
| 9 | 7780 (n=1) | █ |
| 10 | 8431 (n=1) | █ |
| 11 | 8767 (n=1) | █ |
| 12 | 12829 (n=1) | ██ |
| 13 | 8956 (n=1) | █ |
| 14 | 9103 (n=1) | █ |
| 15 | 12929 (n=1) | ██ |
| 16 | 9101 (n=1) | █ |
| 17 | 9103 (n=1) | █ |
| 18 | 13006 (n=1) | ██ |
| 19 | 9103 (n=1) | █ |
| 20 | 9103 (n=1) | █ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8021 (n=1) | █ |
| 2 | 9196 (n=1) | █ |
| 3 | 95387 (n=1) | ███████████ |
| 4 | 12391 (n=1) | █ |
| 5 | 8688 (n=1) | █ |
| 6 | 169460 (n=1) | ████████████████████ |
| 7 | 7632 (n=1) | █ |
| 8 | 14879 (n=1) | ██ |
| 9 | 7780 (n=1) | █ |
| 10 | 8431 (n=1) | █ |
| 11 | 8767 (n=1) | █ |
| 12 | 12829 (n=1) | ██ |
| 13 | 8956 (n=1) | █ |
| 14 | 9103 (n=1) | █ |
| 15 | 12929 (n=1) | ██ |
| 16 | 9101 (n=1) | █ |
| 17 | 9103 (n=1) | █ |
| 18 | 13006 (n=1) | ██ |
| 19 | 9103 (n=1) | █ |
| 20 | 9103 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_steps | 1 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | pass | 20 | 1 | $0.0167 |

