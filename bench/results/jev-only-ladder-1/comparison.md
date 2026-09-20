# JevCode bench 20260920-194434-81e33c

Generated 2026-09-20T20:04:23.166Z. Generator model `none (jev-only)`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.2500; spent generator $0.0000 + Jev $0.2773 = $0.2773. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 12 | 12 | 4 | 4/12 (n=12) 33.3% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 6 | 3/6 50.0% |
| 2 | 3 | 0/3 0.0% |
| 3 | 3 | 1/3 33.3% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 2 | 1/2 50.0% |
| 2 | 5 | 2/5 40.0% |
| 3 | 3 | 0/3 0.0% |
| 4 | 2 | 1/2 50.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 4/12 (n=12) 33.3% |
| steps-to-solve mean (n passed) | 12.75 (n=4) |
| steps-to-solve median | 7 |
| steps used mean (n runs) | 17.58 (n=12) |
| steps used median | 20 |
| read actions total / mean per run | 54 / 4.50 |
| blocked / reviews / declined | 131 / 65 / 65 |
| loops / replans | 40 / 34 |
| Jev requests / questions | 1777 / 29271 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 195.96 / 398.93 (n=1777) |
| mean generator tokens/step (steps) | 0 (n=211) |
| mean Jev tokens/step (steps) | 37109 (n=211) |
| mean tokens/step, generator+Jev (steps) | 37109 (n=211) |
| wall time mean | 4m30s |
| cost generator / Jev / total | $0.0000 / $0.2773 / $0.2773 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 1/12 | 8.3% | ██ |
| 5 | 1/12 | 8.3% | ██ |
| 6 | 1/12 | 8.3% | ██ |
| 7 | 2/12 | 16.7% | ███ |
| 8 | 2/12 | 16.7% | ███ |
| 9 | 2/12 | 16.7% | ███ |
| 10 | 2/12 | 16.7% | ███ |
| 11 | 2/12 | 16.7% | ███ |
| 12 | 2/12 | 16.7% | ███ |
| 13 | 2/12 | 16.7% | ███ |
| 14 | 2/12 | 16.7% | ███ |
| 15 | 2/12 | 16.7% | ███ |
| 16 | 2/12 | 16.7% | ███ |
| 17 | 2/12 | 16.7% | ███ |
| 18 | 2/12 | 16.7% | ███ |
| 19 | 2/12 | 16.7% | ███ |
| 20 | 4/12 | 33.3% | ███████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=11) |  |
| 6 | 0 (n=11) |  |
| 7 | 0 (n=11) |  |
| 8 | 0 (n=10) |  |
| 9 | 0 (n=10) |  |
| 10 | 0 (n=10) |  |
| 11 | 0 (n=10) |  |
| 12 | 0 (n=10) |  |
| 13 | 0 (n=10) |  |
| 14 | 0 (n=10) |  |
| 15 | 0 (n=10) |  |
| 16 | 0 (n=10) |  |
| 17 | 0 (n=10) |  |
| 18 | 0 (n=10) |  |
| 19 | 0 (n=10) |  |
| 20 | 0 (n=10) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7853 (n=12) | ██ |
| 2 | 62537 (n=12) | █████████████████ |
| 3 | 29569 (n=12) | ████████ |
| 4 | 41470 (n=12) | ███████████ |
| 5 | 51562 (n=11) | ██████████████ |
| 6 | 31762 (n=11) | █████████ |
| 7 | 34090 (n=11) | █████████ |
| 8 | 16114 (n=10) | ████ |
| 9 | 23635 (n=10) | ██████ |
| 10 | 29970 (n=10) | ████████ |
| 11 | 10702 (n=10) | ███ |
| 12 | 35888 (n=10) | ██████████ |
| 13 | 73138 (n=10) | ████████████████████ |
| 14 | 58510 (n=10) | ████████████████ |
| 15 | 70463 (n=10) | ███████████████████ |
| 16 | 21513 (n=10) | ██████ |
| 17 | 54007 (n=10) | ███████████████ |
| 18 | 33010 (n=10) | █████████ |
| 19 | 10108 (n=10) | ███ |
| 20 | 47063 (n=10) | █████████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7853 (n=12) | ██ |
| 2 | 62537 (n=12) | █████████████████ |
| 3 | 29569 (n=12) | ████████ |
| 4 | 41470 (n=12) | ███████████ |
| 5 | 51562 (n=11) | ██████████████ |
| 6 | 31762 (n=11) | █████████ |
| 7 | 34090 (n=11) | █████████ |
| 8 | 16114 (n=10) | ████ |
| 9 | 23635 (n=10) | ██████ |
| 10 | 29970 (n=10) | ████████ |
| 11 | 10702 (n=10) | ███ |
| 12 | 35888 (n=10) | ██████████ |
| 13 | 73138 (n=10) | ████████████████████ |
| 14 | 58510 (n=10) | ████████████████ |
| 15 | 70463 (n=10) | ███████████████████ |
| 16 | 21513 (n=10) | ██████ |
| 17 | 54007 (n=10) | ███████████████ |
| 18 | 33010 (n=10) | █████████ |
| 19 | 10108 (n=10) | ███ |
| 20 | 47063 (n=10) | █████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 2 | ████ |
| max_steps | 10 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | fail | 20 | 4 | $0.0241 |
| calendar_utils | fail | 20 | 5 | $0.0117 |
| events | pass | 20 | 6 | $0.0080 |
| grades | fail | 20 | 5 | $0.0143 |
| inventory | fail | 20 | 7 | $0.0179 |
| profiles | pass | 4 | 1 | $0.0017 |
| shipping | fail | 20 | 4 | $0.0720 |
| stats | pass | 7 | 2 | $0.0029 |
| table | pass | 20 | 7 | $0.0284 |
| tagcloud | fail | 20 | 4 | $0.0560 |
| textstats | fail | 20 | 2 | $0.0282 |
| units | fail | 20 | 7 | $0.0121 |

