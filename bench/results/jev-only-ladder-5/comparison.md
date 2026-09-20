# JevCode bench 20260920-222854-894c0f

Generated 2026-09-20T22:49:55.931Z. Generator model `none (jev-only)`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 12m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.1500; spent generator $0.0000 + Jev $0.1773 = $0.1773. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 12 | 12 | 11 | 11/12 (n=12) 91.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 2/3 66.7% |
| 3 | 3 | 3/3 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 4/5 80.0% |
| 3 | 3 | 3/3 100.0% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 11/12 (n=12) 91.7% |
| steps-to-solve mean (n passed) | 10.82 (n=11) |
| steps-to-solve median | 12 |
| steps used mean (n runs) | 11.58 (n=12) |
| steps used median | 12 |
| read actions total / mean per run | 37 / 3.08 |
| blocked / reviews / declined | 17 / 7 / 7 |
| loops / replans | 22 / 19 |
| Jev requests / questions | 1144 / 23758 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 196.98 / 371.08 (n=1144) |
| mean generator tokens/step (steps) | 0 (n=139) |
| mean Jev tokens/step (steps) | 34109 (n=139) |
| mean tokens/step, generator+Jev (steps) | 34109 (n=139) |
| wall time mean | 4m21s |
| cost generator / Jev / total | $0.0000 / $0.1773 / $0.1773 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 3/12 | 25.0% | █████ |
| 5 | 4/12 | 33.3% | ███████ |
| 6 | 4/12 | 33.3% | ███████ |
| 7 | 4/12 | 33.3% | ███████ |
| 8 | 5/12 | 41.7% | ████████ |
| 9 | 5/12 | 41.7% | ████████ |
| 10 | 5/12 | 41.7% | ████████ |
| 11 | 5/12 | 41.7% | ████████ |
| 12 | 7/12 | 58.3% | ████████████ |
| 13 | 7/12 | 58.3% | ████████████ |
| 14 | 7/12 | 58.3% | ████████████ |
| 15 | 8/12 | 66.7% | █████████████ |
| 16 | 9/12 | 75.0% | ███████████████ |
| 17 | 9/12 | 75.0% | ███████████████ |
| 18 | 9/12 | 75.0% | ███████████████ |
| 19 | 10/12 | 83.3% | █████████████████ |
| 20 | 11/12 | 91.7% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=9) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=8) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=7) |  |
| 10 | 0 (n=7) |  |
| 11 | 0 (n=7) |  |
| 12 | 0 (n=7) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=5) |  |
| 15 | 0 (n=5) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=3) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=3) |  |
| 20 | 0 (n=2) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8029 (n=12) | ██ |
| 2 | 9659 (n=12) | ██ |
| 3 | 41127 (n=12) | ██████████ |
| 4 | 43991 (n=12) | ██████████ |
| 5 | 65253 (n=9) | ███████████████ |
| 6 | 57252 (n=8) | █████████████ |
| 7 | 41026 (n=8) | ██████████ |
| 8 | 21407 (n=8) | █████ |
| 9 | 47771 (n=7) | ███████████ |
| 10 | 54244 (n=7) | █████████████ |
| 11 | 14534 (n=7) | ███ |
| 12 | 85233 (n=7) | ████████████████████ |
| 13 | 11502 (n=5) | ███ |
| 14 | 15355 (n=5) | ████ |
| 15 | 13625 (n=5) | ███ |
| 16 | 11182 (n=4) | ███ |
| 17 | 13109 (n=3) | ███ |
| 18 | 12993 (n=3) | ███ |
| 19 | 66809 (n=3) | ████████████████ |
| 20 | 12186 (n=2) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8029 (n=12) | ██ |
| 2 | 9659 (n=12) | ██ |
| 3 | 41127 (n=12) | ██████████ |
| 4 | 43991 (n=12) | ██████████ |
| 5 | 65253 (n=9) | ███████████████ |
| 6 | 57252 (n=8) | █████████████ |
| 7 | 41026 (n=8) | ██████████ |
| 8 | 21407 (n=8) | █████ |
| 9 | 47771 (n=7) | ███████████ |
| 10 | 54244 (n=7) | █████████████ |
| 11 | 14534 (n=7) | ███ |
| 12 | 85233 (n=7) | ████████████████████ |
| 13 | 11502 (n=5) | ███ |
| 14 | 15355 (n=5) | ████ |
| 15 | 13625 (n=5) | ███ |
| 16 | 11182 (n=4) | ███ |
| 17 | 13109 (n=3) | ███ |
| 18 | 12993 (n=3) | ███ |
| 19 | 66809 (n=3) | ████████████████ |
| 20 | 12186 (n=2) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 7 | ████████████████████ |
| max_replans | 1 | ███ |
| max_steps | 2 | ██████ |
| replan_stop | 2 | ██████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | pass | 15 | 3 | $0.0138 |
| calendar_utils | pass | 12 | 4 | $0.0085 |
| events | pass | 4 | 1 | $0.0019 |
| grades | pass | 16 | 4 | $0.0083 |
| inventory | fail | 20 | 7 | $0.0250 |
| profiles | pass | 4 | 1 | $0.0018 |
| shipping | pass | 19 | 4 | $0.0547 |
| stats | pass | 5 | 1 | $0.0035 |
| table | pass | 12 | 2 | $0.0254 |
| tagcloud | pass | 4 | 1 | $0.0021 |
| textstats | pass | 8 | 2 | $0.0098 |
| units | pass | 20 | 7 | $0.0226 |

