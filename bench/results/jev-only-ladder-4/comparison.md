# JevCode bench 20260920-213752-508a51

Generated 2026-09-20T21:51:52.844Z. Generator model `none (jev-only)`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 20 | 10m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.2500; spent generator $0.0000 + Jev $0.1370 = $0.1370. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 12 | 12 | 11 | 11/12 (n=12) 91.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 3/3 100.0% |
| 3 | 3 | 2/3 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 2/3 66.7% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 11/12 (n=12) 91.7% |
| steps-to-solve mean (n passed) | 10.64 (n=11) |
| steps-to-solve median | 9 |
| steps used mean (n runs) | 11.42 (n=12) |
| steps used median | 9 |
| read actions total / mean per run | 30 / 2.50 |
| blocked / reviews / declined | 58 / 30 / 30 |
| loops / replans | 16 / 13 |
| Jev requests / questions | 964 / 17731 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 204.11 / 365.41 (n=964) |
| mean generator tokens/step (steps) | 0 (n=137) |
| mean Jev tokens/step (steps) | 26957 (n=137) |
| mean tokens/step, generator+Jev (steps) | 26957 (n=137) |
| wall time mean | 3m16s |
| cost generator / Jev / total | $0.0000 / $0.1370 / $0.1370 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 4/12 | 33.3% | ███████ |
| 5 | 4/12 | 33.3% | ███████ |
| 6 | 4/12 | 33.3% | ███████ |
| 7 | 4/12 | 33.3% | ███████ |
| 8 | 4/12 | 33.3% | ███████ |
| 9 | 6/12 | 50.0% | ██████████ |
| 10 | 7/12 | 58.3% | ████████████ |
| 11 | 7/12 | 58.3% | ████████████ |
| 12 | 7/12 | 58.3% | ████████████ |
| 13 | 8/12 | 66.7% | █████████████ |
| 14 | 8/12 | 66.7% | █████████████ |
| 15 | 8/12 | 66.7% | █████████████ |
| 16 | 8/12 | 66.7% | █████████████ |
| 17 | 8/12 | 66.7% | █████████████ |
| 18 | 8/12 | 66.7% | █████████████ |
| 19 | 8/12 | 66.7% | █████████████ |
| 20 | 11/12 | 91.7% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=8) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=8) |  |
| 10 | 0 (n=6) |  |
| 11 | 0 (n=5) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=4) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=4) |  |
| 19 | 0 (n=4) |  |
| 20 | 0 (n=4) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7964 (n=12) | ██ |
| 2 | 9597 (n=12) | ██ |
| 3 | 40794 (n=12) | ██████████ |
| 4 | 83543 (n=12) | ████████████████████ |
| 5 | 25170 (n=8) | ██████ |
| 6 | 13097 (n=8) | ███ |
| 7 | 39839 (n=8) | ██████████ |
| 8 | 13401 (n=8) | ███ |
| 9 | 11331 (n=8) | ███ |
| 10 | 13719 (n=6) | ███ |
| 11 | 45255 (n=5) | ███████████ |
| 12 | 51474 (n=5) | ████████████ |
| 13 | 11407 (n=5) | ███ |
| 14 | 12016 (n=4) | ███ |
| 15 | 30722 (n=4) | ███████ |
| 16 | 10267 (n=4) | ██ |
| 17 | 9396 (n=4) | ██ |
| 18 | 51593 (n=4) | ████████████ |
| 19 | 11269 (n=4) | ███ |
| 20 | 10912 (n=4) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 7964 (n=12) | ██ |
| 2 | 9597 (n=12) | ██ |
| 3 | 40794 (n=12) | ██████████ |
| 4 | 83543 (n=12) | ████████████████████ |
| 5 | 25170 (n=8) | ██████ |
| 6 | 13097 (n=8) | ███ |
| 7 | 39839 (n=8) | ██████████ |
| 8 | 13401 (n=8) | ███ |
| 9 | 11331 (n=8) | ███ |
| 10 | 13719 (n=6) | ███ |
| 11 | 45255 (n=5) | ███████████ |
| 12 | 51474 (n=5) | ████████████ |
| 13 | 11407 (n=5) | ███ |
| 14 | 12016 (n=4) | ███ |
| 15 | 30722 (n=4) | ███████ |
| 16 | 10267 (n=4) | ██ |
| 17 | 9396 (n=4) | ██ |
| 18 | 51593 (n=4) | ████████████ |
| 19 | 11269 (n=4) | ███ |
| 20 | 10912 (n=4) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 6 | ████████████████████ |
| max_steps | 4 | █████████████ |
| replan_stop | 2 | ███████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | fail | 20 | 4 | $0.0213 |
| calendar_utils | pass | 20 | 3 | $0.0211 |
| events | pass | 4 | 1 | $0.0019 |
| grades | pass | 9 | 3 | $0.0048 |
| inventory | pass | 20 | 8 | $0.0259 |
| profiles | pass | 4 | 1 | $0.0018 |
| shipping | pass | 10 | 1 | $0.0156 |
| stats | pass | 4 | 1 | $0.0018 |
| table | pass | 9 | 1 | $0.0178 |
| tagcloud | pass | 4 | 1 | $0.0020 |
| textstats | pass | 13 | 3 | $0.0122 |
| units | pass | 20 | 3 | $0.0109 |

