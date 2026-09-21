# JevCode bench 20260920-224502-44d7b0

Generated 2026-09-20T23:13:03.436Z. Generator model `none (jev-only)`. 8 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.2000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2000; spent generator $0.0000 + Jev $0.2461 = $0.2461. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 8 | 8 | 2 | 2/8 (n=8) 25.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 2 | 1 | 0/1 0.0% |
| 3 | 1 | 0/1 0.0% |
| 4 | 3 | 2/3 66.7% |
| 5 | 1 | 0/1 0.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 4 | 5 | 2/5 40.0% |
| 5 | 3 | 0/3 0.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `crossfile`, `import_and_guard`, `ledger5`, `long_chain`, `masked`, `regress_trap`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 2/8 (n=8) 25.0% |
| steps-to-solve mean (n passed) | 19.50 (n=2) |
| steps-to-solve median | 13 |
| steps used mean (n runs) | 21 (n=8) |
| steps used median | 20 |
| read actions total / mean per run | 26 / 3.25 |
| blocked / reviews / declined | 57 / 50 / 50 |
| loops / replans | 38 / 32 |
| Jev requests / questions | 1608 / 22525 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 194.95 / 360.11 (n=1608) |
| mean generator tokens/step (steps) | 0 (n=168) |
| mean Jev tokens/step (steps) | 40577 (n=168) |
| mean tokens/step, generator+Jev (steps) | 40577 (n=168) |
| wall time mean | 6m21s |
| cost generator / Jev / total | $0.0000 / $0.2461 / $0.2461 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 0/8 | 0.0% |  |
| 3 | 0/8 | 0.0% |  |
| 4 | 0/8 | 0.0% |  |
| 5 | 0/8 | 0.0% |  |
| 6 | 0/8 | 0.0% |  |
| 7 | 0/8 | 0.0% |  |
| 8 | 0/8 | 0.0% |  |
| 9 | 0/8 | 0.0% |  |
| 10 | 0/8 | 0.0% |  |
| 11 | 0/8 | 0.0% |  |
| 12 | 0/8 | 0.0% |  |
| 13 | 1/8 | 12.5% | ███ |
| 14 | 1/8 | 12.5% | ███ |
| 15 | 1/8 | 12.5% | ███ |
| 16 | 1/8 | 12.5% | ███ |
| 17 | 1/8 | 12.5% | ███ |
| 18 | 1/8 | 12.5% | ███ |
| 19 | 1/8 | 12.5% | ███ |
| 20 | 1/8 | 12.5% | ███ |
| 21 | 1/8 | 12.5% | ███ |
| 22 | 1/8 | 12.5% | ███ |
| 23 | 1/8 | 12.5% | ███ |
| 24 | 1/8 | 12.5% | ███ |
| 25 | 1/8 | 12.5% | ███ |
| 26 | 2/8 | 25.0% | █████ |
| 27 | 2/8 | 25.0% | █████ |
| 28 | 2/8 | 25.0% | █████ |
| 29 | 2/8 | 25.0% | █████ |
| 30 | 2/8 | 25.0% | █████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=8) |  |
| 2 | 0 (n=8) |  |
| 3 | 0 (n=8) |  |
| 4 | 0 (n=8) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=8) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=8) |  |
| 10 | 0 (n=8) |  |
| 11 | 0 (n=8) |  |
| 12 | 0 (n=8) |  |
| 13 | 0 (n=8) |  |
| 14 | 0 (n=7) |  |
| 15 | 0 (n=7) |  |
| 16 | 0 (n=7) |  |
| 17 | 0 (n=7) |  |
| 18 | 0 (n=6) |  |
| 19 | 0 (n=5) |  |
| 20 | 0 (n=5) |  |
| 21 | 0 (n=3) |  |
| 22 | 0 (n=3) |  |
| 23 | 0 (n=3) |  |
| 24 | 0 (n=3) |  |
| 25 | 0 (n=2) |  |
| 26 | 0 (n=2) |  |
| 27 | 0 (n=1) |  |
| 28 | 0 (n=1) |  |
| 29 | 0 (n=1) |  |
| 30 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9535 (n=8) | ██ |
| 2 | 11365 (n=8) | ██ |
| 3 | 36812 (n=8) | ███████ |
| 4 | 54334 (n=8) | ██████████ |
| 5 | 43252 (n=8) | ████████ |
| 6 | 53920 (n=8) | ██████████ |
| 7 | 69752 (n=8) | █████████████ |
| 8 | 17644 (n=8) | ███ |
| 9 | 29748 (n=8) | ██████ |
| 10 | 78493 (n=8) | ███████████████ |
| 11 | 36006 (n=8) | ███████ |
| 12 | 21557 (n=8) | ████ |
| 13 | 62474 (n=8) | ████████████ |
| 14 | 32509 (n=7) | ██████ |
| 15 | 12412 (n=7) | ██ |
| 16 | 89520 (n=7) | █████████████████ |
| 17 | 70165 (n=7) | █████████████ |
| 18 | 13847 (n=6) | ███ |
| 19 | 104336 (n=5) | ████████████████████ |
| 20 | 18192 (n=5) | ███ |
| 21 | 13600 (n=3) | ███ |
| 22 | 67688 (n=3) | █████████████ |
| 23 | 13904 (n=3) | ███ |
| 24 | 12328 (n=3) | ██ |
| 25 | 16155 (n=2) | ███ |
| 26 | 31243 (n=2) | ██████ |
| 27 | 18269 (n=1) | ████ |
| 28 | 19554 (n=1) | ████ |
| 29 | 20145 (n=1) | ████ |
| 30 | 14430 (n=1) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 9535 (n=8) | ██ |
| 2 | 11365 (n=8) | ██ |
| 3 | 36812 (n=8) | ███████ |
| 4 | 54334 (n=8) | ██████████ |
| 5 | 43252 (n=8) | ████████ |
| 6 | 53920 (n=8) | ██████████ |
| 7 | 69752 (n=8) | █████████████ |
| 8 | 17644 (n=8) | ███ |
| 9 | 29748 (n=8) | ██████ |
| 10 | 78493 (n=8) | ███████████████ |
| 11 | 36006 (n=8) | ███████ |
| 12 | 21557 (n=8) | ████ |
| 13 | 62474 (n=8) | ████████████ |
| 14 | 32509 (n=7) | ██████ |
| 15 | 12412 (n=7) | ██ |
| 16 | 89520 (n=7) | █████████████████ |
| 17 | 70165 (n=7) | █████████████ |
| 18 | 13847 (n=6) | ███ |
| 19 | 104336 (n=5) | ████████████████████ |
| 20 | 18192 (n=5) | ███ |
| 21 | 13600 (n=3) | ███ |
| 22 | 67688 (n=3) | █████████████ |
| 23 | 13904 (n=3) | ███ |
| 24 | 12328 (n=3) | ██ |
| 25 | 16155 (n=2) | ███ |
| 26 | 31243 (n=2) | ██████ |
| 27 | 18269 (n=1) | ████ |
| 28 | 19554 (n=1) | ████ |
| 29 | 20145 (n=1) | ████ |
| 30 | 14430 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 1 | █████ |
| max_replans | 4 | ████████████████████ |
| max_steps | 1 | █████ |
| replan_stop | 2 | ██████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| crossfile | fail | 20 | 3 | $0.0550 |
| import_and_guard | pass | 13 | 4 | $0.0097 |
| ledger5 | fail | 30 | 2 | $0.0410 |
| long_chain | fail | 18 | 0 | $0.0117 |
| masked | fail | 20 | 3 | $0.0290 |
| regress_trap | pass | 26 | 7 | $0.0318 |
| shared_frame | fail | 17 | 2 | $0.0326 |
| six_hunks | fail | 24 | 5 | $0.0354 |

