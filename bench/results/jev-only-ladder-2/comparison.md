# JevCode bench 20260920-203553-f3581a

Generated 2026-09-20T20:47:39.111Z. Generator model `none (jev-only)`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.2500; spent generator $0.0000 + Jev $0.1035 = $0.1035. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 12 | 12 | 10 | 10/12 (n=12) 83.3% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 2/3 66.7% |
| 3 | 3 | 2/3 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 4/5 80.0% |
| 3 | 3 | 2/3 66.7% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 10/12 (n=12) 83.3% |
| steps-to-solve mean (n passed) | 8.70 (n=10) |
| steps-to-solve median | 5 |
| steps used mean (n runs) | 10.50 (n=12) |
| steps used median | 6 |
| read actions total / mean per run | 37 / 3.08 |
| blocked / reviews / declined | 43 / 34 / 34 |
| loops / replans | 12 / 11 |
| Jev requests / questions | 789 / 10923 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 189.98 / 331.50 (n=789) |
| mean generator tokens/step (steps) | 0 (n=126) |
| mean Jev tokens/step (steps) | 21797 (n=126) |
| mean tokens/step, generator+Jev (steps) | 21797 (n=126) |
| wall time mean | 2m24s |
| cost generator / Jev / total | $0.0000 / $0.1035 / $0.1035 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 2/12 | 16.7% | ███ |
| 4 | 4/12 | 33.3% | ███████ |
| 5 | 5/12 | 41.7% | ████████ |
| 6 | 6/12 | 50.0% | ██████████ |
| 7 | 6/12 | 50.0% | ██████████ |
| 8 | 7/12 | 58.3% | ████████████ |
| 9 | 7/12 | 58.3% | ████████████ |
| 10 | 7/12 | 58.3% | ████████████ |
| 11 | 7/12 | 58.3% | ████████████ |
| 12 | 7/12 | 58.3% | ████████████ |
| 13 | 7/12 | 58.3% | ████████████ |
| 14 | 8/12 | 66.7% | █████████████ |
| 15 | 8/12 | 66.7% | █████████████ |
| 16 | 8/12 | 66.7% | █████████████ |
| 17 | 8/12 | 66.7% | █████████████ |
| 18 | 8/12 | 66.7% | █████████████ |
| 19 | 8/12 | 66.7% | █████████████ |
| 20 | 10/12 | 83.3% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=10) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=7) |  |
| 7 | 0 (n=6) |  |
| 8 | 0 (n=6) |  |
| 9 | 0 (n=5) |  |
| 10 | 0 (n=5) |  |
| 11 | 0 (n=5) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=5) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=4) |  |
| 19 | 0 (n=4) |  |
| 20 | 0 (n=3) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7825 (n=12) | ██ |
| 2 | 27090 (n=12) | ██████ |
| 3 | 20054 (n=12) | ████ |
| 4 | 28647 (n=10) | ██████ |
| 5 | 23913 (n=8) | █████ |
| 6 | 13006 (n=7) | ███ |
| 7 | 17300 (n=6) | ████ |
| 8 | 14555 (n=6) | ███ |
| 9 | 16712 (n=5) | ████ |
| 10 | 11637 (n=5) | ███ |
| 11 | 13747 (n=5) | ███ |
| 12 | 12970 (n=5) | ███ |
| 13 | 92674 (n=5) | ████████████████████ |
| 14 | 56089 (n=5) | ████████████ |
| 15 | 15889 (n=4) | ███ |
| 16 | 13066 (n=4) | ███ |
| 17 | 11943 (n=4) | ███ |
| 18 | 12798 (n=4) | ███ |
| 19 | 13395 (n=4) | ███ |
| 20 | 13120 (n=3) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7825 (n=12) | ██ |
| 2 | 27090 (n=12) | ██████ |
| 3 | 20054 (n=12) | ████ |
| 4 | 28647 (n=10) | ██████ |
| 5 | 23913 (n=8) | █████ |
| 6 | 13006 (n=7) | ███ |
| 7 | 17300 (n=6) | ████ |
| 8 | 14555 (n=6) | ███ |
| 9 | 16712 (n=5) | ████ |
| 10 | 11637 (n=5) | ███ |
| 11 | 13747 (n=5) | ███ |
| 12 | 12970 (n=5) | ███ |
| 13 | 92674 (n=5) | ████████████████████ |
| 14 | 56089 (n=5) | ████████████ |
| 15 | 15889 (n=4) | ███ |
| 16 | 13066 (n=4) | ███ |
| 17 | 11943 (n=4) | ███ |
| 18 | 12798 (n=4) | ███ |
| 19 | 13395 (n=4) | ███ |
| 20 | 13120 (n=3) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 9 | ████████████████████ |
| max_steps | 2 | ████ |
| replan_stop | 1 | ██ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | pass | 14 | 3 | $0.0107 |
| calendar_utils | fail | 19 | 4 | $0.0204 |
| events | pass | 4 | 1 | $0.0018 |
| grades | pass | 20 | 7 | $0.0104 |
| inventory | fail | 20 | 6 | $0.0263 |
| profiles | pass | 3 | 1 | $0.0013 |
| shipping | pass | 6 | 1 | $0.0040 |
| stats | pass | 3 | 1 | $0.0013 |
| table | pass | 5 | 1 | $0.0093 |
| tagcloud | pass | 4 | 1 | $0.0019 |
| textstats | pass | 8 | 1 | $0.0044 |
| units | pass | 20 | 10 | $0.0117 |

