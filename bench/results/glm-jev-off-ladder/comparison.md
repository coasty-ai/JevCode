# JevCode bench 20260921-180729-566772

Generated 2026-09-21T18:32:17.638Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.1000; spent generator $0.1392 + Jev $0.0000 = $0.1392. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 12 | 12 | 9 | 9/12 (n=12) 75.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-off |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 3/3 100.0% |
| 3 | 3 | 0/3 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-off |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 1/3 33.3% |
| 4 | 2 | 1/2 50.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 9/12 (n=12) 75.0% |
| steps-to-solve mean (n passed) | 11.22 (n=9) |
| steps-to-solve median | 9 |
| steps used mean (n runs) | 13 (n=12) |
| steps used median | 10 |
| read actions total / mean per run | 44 / 3.67 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 6 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 176 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 4607 (n=156) |
| mean Jev tokens/step (steps) | 0 (n=156) |
| mean tokens/step, generator+Jev (steps) | 4607 (n=156) |
| wall time mean | 5m42s |
| cost generator / Jev / total | $0.1392 / $0.0000 / $0.1392 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 0/12 | 0.0% |  |
| 5 | 0/12 | 0.0% |  |
| 6 | 2/12 | 16.7% | ███ |
| 7 | 2/12 | 16.7% | ███ |
| 8 | 3/12 | 25.0% | █████ |
| 9 | 5/12 | 41.7% | ████████ |
| 10 | 6/12 | 50.0% | ██████████ |
| 11 | 6/12 | 50.0% | ██████████ |
| 12 | 6/12 | 50.0% | ██████████ |
| 13 | 6/12 | 50.0% | ██████████ |
| 14 | 7/12 | 58.3% | ████████████ |
| 15 | 7/12 | 58.3% | ████████████ |
| 16 | 7/12 | 58.3% | ████████████ |
| 17 | 8/12 | 66.7% | █████████████ |
| 18 | 8/12 | 66.7% | █████████████ |
| 19 | 8/12 | 66.7% | █████████████ |
| 20 | 8/12 | 66.7% | █████████████ |
| 21 | 8/12 | 66.7% | █████████████ |
| 22 | 9/12 | 75.0% | ███████████████ |
| 23 | 9/12 | 75.0% | ███████████████ |
| 24 | 9/12 | 75.0% | ███████████████ |
| 25 | 9/12 | 75.0% | ███████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1766 (n=12) | ████ |
| 2 | 2139 (n=12) | █████ |
| 3 | 2648 (n=12) | ██████ |
| 4 | 3574 (n=12) | ████████ |
| 5 | 3797 (n=12) | ████████ |
| 6 | 5014 (n=12) | ███████████ |
| 7 | 7461 (n=10) | ████████████████ |
| 8 | 4559 (n=10) | ██████████ |
| 9 | 4761 (n=9) | ██████████ |
| 10 | 4850 (n=7) | ██████████ |
| 11 | 4658 (n=5) | ██████████ |
| 12 | 9378 (n=5) | ████████████████████ |
| 13 | 8688 (n=5) | ██████████████████ |
| 14 | 7525 (n=5) | ████████████████ |
| 15 | 4306 (n=4) | █████████ |
| 16 | 4900 (n=4) | ██████████ |
| 17 | 4519 (n=4) | ██████████ |
| 18 | 4689 (n=3) | ██████████ |
| 19 | 9410 (n=3) | ████████████████████ |
| 20 | 4554 (n=3) | ██████████ |
| 21 | 5464 (n=2) | ████████████ |
| 22 | 4101 (n=2) | █████████ |
| 23 | 4397 (n=1) | █████████ |
| 24 | 4549 (n=1) | ██████████ |
| 25 | 4205 (n=1) | █████████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=12) |  |
| 6 | 0 (n=12) |  |
| 7 | 0 (n=10) |  |
| 8 | 0 (n=10) |  |
| 9 | 0 (n=9) |  |
| 10 | 0 (n=7) |  |
| 11 | 0 (n=5) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=5) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=3) |  |
| 20 | 0 (n=3) |  |
| 21 | 0 (n=2) |  |
| 22 | 0 (n=2) |  |
| 23 | 0 (n=1) |  |
| 24 | 0 (n=1) |  |
| 25 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1766 (n=12) | ████ |
| 2 | 2139 (n=12) | █████ |
| 3 | 2648 (n=12) | ██████ |
| 4 | 3574 (n=12) | ████████ |
| 5 | 3797 (n=12) | ████████ |
| 6 | 5014 (n=12) | ███████████ |
| 7 | 7461 (n=10) | ████████████████ |
| 8 | 4559 (n=10) | ██████████ |
| 9 | 4761 (n=9) | ██████████ |
| 10 | 4850 (n=7) | ██████████ |
| 11 | 4658 (n=5) | ██████████ |
| 12 | 9378 (n=5) | ████████████████████ |
| 13 | 8688 (n=5) | ██████████████████ |
| 14 | 7525 (n=5) | ████████████████ |
| 15 | 4306 (n=4) | █████████ |
| 16 | 4900 (n=4) | ██████████ |
| 17 | 4519 (n=4) | ██████████ |
| 18 | 4689 (n=3) | ██████████ |
| 19 | 9410 (n=3) | ████████████████████ |
| 20 | 4554 (n=3) | ██████████ |
| 21 | 5464 (n=2) | ████████████ |
| 22 | 4101 (n=2) | █████████ |
| 23 | 4397 (n=1) | █████████ |
| 24 | 4549 (n=1) | ██████████ |
| 25 | 4205 (n=1) | █████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| generator_done | 9 | ████████████████████ |
| max_steps | 1 | ██ |
| wall_time | 2 | ████ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- |
| account | fail | 25 | 5 | $0.0285 |
| calendar_utils | fail | 20 | 6 | $0.0194 |
| events | pass | 8 | 2 | $0.0050 |
| grades | pass | 17 | 4 | $0.0181 |
| inventory | pass | 22 | 5 | $0.0285 |
| profiles | pass | 10 | 3 | $0.0063 |
| shipping | pass | 9 | 3 | $0.0038 |
| stats | pass | 6 | 2 | $0.0024 |
| table | fail | 10 | 5 | $0.0085 |
| tagcloud | pass | 6 | 2 | $0.0020 |
| textstats | pass | 14 | 4 | $0.0088 |
| units | pass | 9 | 3 | $0.0081 |

