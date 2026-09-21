# JevCode bench 20260921-024028-7c76d9

Generated 2026-09-21T03:14:12.543Z. Generator model `none (jev-only)`. 20 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 30 | 15m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.1500; spent generator $0.0000 + Jev $0.3199 = $0.3199. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 20 | 20 | 14 | 14/20 (n=20) 70.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-only |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 4 | 3/4 75.0% |
| 3 | 4 | 3/4 75.0% |
| 4 | 3 | 1/3 33.3% |
| 5 | 1 | 1/1 100.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-only |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 3/3 100.0% |
| 4 | 7 | 4/7 57.1% |
| 5 | 3 | 0/3 0.0% |

### Paired comparison (n = 20 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `crossfile`, `events`, `grades`, `import_and_guard`, `inventory`, `ledger5`, `long_chain`, `masked`, `profiles`, `regress_trap`, `shared_frame`, `shipping`, `six_hunks`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 14/20 (n=20) 70.0% |
| steps-to-solve mean (n passed) | 5.36 (n=14) |
| steps-to-solve median | 5 |
| steps used mean (n runs) | 8.35 (n=20) |
| steps used median | 5 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 36 / 0 / 0 |
| loops / replans | 22 / 16 |
| Jev requests / questions | 2151 / 27342 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 190.95 / 342.16 (n=2151) |
| mean generator tokens/step (steps) | 0 (n=167) |
| mean Jev tokens/step (steps) | 54334 (n=167) |
| mean tokens/step, generator+Jev (steps) | 54334 (n=167) |
| wall time mean | 3m11s |
| cost generator / Jev / total | $0.0000 / $0.3199 / $0.3199 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/20 | 0.0% |  |
| 2 | 0/20 | 0.0% |  |
| 3 | 5/20 | 25.0% | █████ |
| 4 | 6/20 | 30.0% | ██████ |
| 5 | 10/20 | 50.0% | ██████████ |
| 6 | 10/20 | 50.0% | ██████████ |
| 7 | 12/20 | 60.0% | ████████████ |
| 8 | 12/20 | 60.0% | ████████████ |
| 9 | 13/20 | 65.0% | █████████████ |
| 10 | 13/20 | 65.0% | █████████████ |
| 11 | 13/20 | 65.0% | █████████████ |
| 12 | 13/20 | 65.0% | █████████████ |
| 13 | 14/20 | 70.0% | ██████████████ |
| 14 | 14/20 | 70.0% | ██████████████ |
| 15 | 14/20 | 70.0% | ██████████████ |
| 16 | 14/20 | 70.0% | ██████████████ |
| 17 | 14/20 | 70.0% | ██████████████ |
| 18 | 14/20 | 70.0% | ██████████████ |
| 19 | 14/20 | 70.0% | ██████████████ |
| 20 | 14/20 | 70.0% | ██████████████ |
| 21 | 14/20 | 70.0% | ██████████████ |
| 22 | 14/20 | 70.0% | ██████████████ |
| 23 | 14/20 | 70.0% | ██████████████ |
| 24 | 14/20 | 70.0% | ██████████████ |
| 25 | 14/20 | 70.0% | ██████████████ |
| 26 | 14/20 | 70.0% | ██████████████ |
| 27 | 14/20 | 70.0% | ██████████████ |
| 28 | 14/20 | 70.0% | ██████████████ |
| 29 | 14/20 | 70.0% | ██████████████ |
| 30 | 14/20 | 70.0% | ██████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=20) |  |
| 2 | 0 (n=20) |  |
| 3 | 0 (n=20) |  |
| 4 | 0 (n=15) |  |
| 5 | 0 (n=14) |  |
| 6 | 0 (n=10) |  |
| 7 | 0 (n=10) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=7) |  |
| 10 | 0 (n=6) |  |
| 11 | 0 (n=6) |  |
| 12 | 0 (n=6) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=4) |  |
| 15 | 0 (n=3) |  |
| 16 | 0 (n=3) |  |
| 17 | 0 (n=3) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=2) |  |
| 20 | 0 (n=1) |  |
| 21 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8863 (n=20) | ██ |
| 2 | 91092 (n=20) | █████████████████ |
| 3 | 48456 (n=20) | █████████ |
| 4 | 50909 (n=15) | ██████████ |
| 5 | 18241 (n=14) | ███ |
| 6 | 79252 (n=10) | ███████████████ |
| 7 | 52707 (n=10) | ██████████ |
| 8 | 101821 (n=8) | ███████████████████ |
| 9 | 104785 (n=7) | ████████████████████ |
| 10 | 101651 (n=6) | ███████████████████ |
| 11 | 57421 (n=6) | ███████████ |
| 12 | 76297 (n=6) | ███████████████ |
| 13 | 13542 (n=5) | ███ |
| 14 | 19394 (n=4) | ████ |
| 15 | 87043 (n=3) | █████████████████ |
| 16 | 67121 (n=3) | █████████████ |
| 17 | 21828 (n=3) | ████ |
| 18 | 23673 (n=3) | █████ |
| 19 | 17784 (n=2) | ███ |
| 20 | 13691 (n=1) | ███ |
| 21 | 13145 (n=1) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8863 (n=20) | ██ |
| 2 | 91092 (n=20) | █████████████████ |
| 3 | 48456 (n=20) | █████████ |
| 4 | 50909 (n=15) | ██████████ |
| 5 | 18241 (n=14) | ███ |
| 6 | 79252 (n=10) | ███████████████ |
| 7 | 52707 (n=10) | ██████████ |
| 8 | 101821 (n=8) | ███████████████████ |
| 9 | 104785 (n=7) | ████████████████████ |
| 10 | 101651 (n=6) | ███████████████████ |
| 11 | 57421 (n=6) | ███████████ |
| 12 | 76297 (n=6) | ███████████████ |
| 13 | 13542 (n=5) | ███ |
| 14 | 19394 (n=4) | ████ |
| 15 | 87043 (n=3) | █████████████████ |
| 16 | 67121 (n=3) | █████████████ |
| 17 | 21828 (n=3) | ████ |
| 18 | 23673 (n=3) | █████ |
| 19 | 17784 (n=2) | ███ |
| 20 | 13691 (n=1) | ███ |
| 21 | 13145 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 14 | ████████████████████ |
| max_replans | 1 | █ |
| replan_stop | 5 | ███████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| account | pass | 5 | 0 | $0.0080 |
| calendar_utils | pass | 7 | 0 | $0.0071 |
| crossfile | fail | 21 | 0 | $0.0831 |
| events | pass | 3 | 0 | $0.0014 |
| grades | pass | 5 | 0 | $0.0029 |
| import_and_guard | pass | 9 | 0 | $0.0072 |
| inventory | pass | 5 | 0 | $0.0039 |
| ledger5 | pass | 13 | 0 | $0.0189 |
| long_chain | fail | 14 | 0 | $0.0301 |
| masked | fail | 12 | 0 | $0.0245 |
| profiles | pass | 3 | 0 | $0.0013 |
| regress_trap | fail | 18 | 0 | $0.0406 |
| shared_frame | fail | 8 | 0 | $0.0193 |
| shipping | pass | 3 | 0 | $0.0068 |
| six_hunks | fail | 19 | 0 | $0.0453 |
| stats | pass | 3 | 0 | $0.0015 |
| table | pass | 4 | 0 | $0.0091 |
| tagcloud | pass | 3 | 0 | $0.0015 |
| textstats | pass | 5 | 0 | $0.0030 |
| units | pass | 7 | 0 | $0.0043 |

