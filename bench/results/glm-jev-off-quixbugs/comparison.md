# JevCode bench 20260921-175447-e8d6f6

Generated 2026-09-21T18:06:56.381Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0600; spent generator $0.0930 + Jev $0.0000 = $0.0930. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 10 | 10 | 7 | 7/10 (n=10) 70.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-off |
| --- | --- | --- |
| argument_swap | 1 | 1/1 100.0% |
| missing_condition | 2 | 2/2 100.0% |
| off_by_one | 2 | 1/2 50.0% |
| operator | 1 | 1/1 100.0% |
| other | 2 | 1/2 50.0% |
| wrong_variable | 2 | 1/2 50.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `bitcount`, `bucketsort`, `detect_cycle`, `find_in_sorted`, `gcd`, `kth`, `lis`, `mergesort`, `shortest_path_length`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 7/10 (n=10) 70.0% |
| steps-to-solve mean (n passed) | 4.57 (n=7) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 5.40 (n=10) |
| steps used median | 4 |
| read actions total / mean per run | 20 / 2 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 74 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 5677 (n=54) |
| mean Jev tokens/step (steps) | 0 (n=54) |
| mean tokens/step, generator+Jev (steps) | 5677 (n=54) |
| wall time mean | 3m58s |
| cost generator / Jev / total | $0.0930 / $0.0000 / $0.0930 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 0/10 | 0.0% |  |
| 3 | 0/10 | 0.0% |  |
| 4 | 4/10 | 40.0% | ████████ |
| 5 | 6/10 | 60.0% | ████████████ |
| 6 | 7/10 | 70.0% | ██████████████ |
| 7 | 7/10 | 70.0% | ██████████████ |
| 8 | 7/10 | 70.0% | ██████████████ |
| 9 | 7/10 | 70.0% | ██████████████ |
| 10 | 7/10 | 70.0% | ██████████████ |
| 11 | 7/10 | 70.0% | ██████████████ |
| 12 | 7/10 | 70.0% | ██████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1793 (n=10) | ██ |
| 2 | 4507 (n=10) | ██████ |
| 3 | 7785 (n=10) | ███████████ |
| 4 | 5253 (n=10) | ███████ |
| 5 | 6066 (n=5) | ████████ |
| 6 | 9449 (n=3) | █████████████ |
| 7 | 14487 (n=2) | ████████████████████ |
| 8 | 9107 (n=2) | █████████████ |
| 9 | 3510 (n=1) | █████ |
| 10 | 3812 (n=1) | █████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 0 (n=10) |  |
| 2 | 0 (n=10) |  |
| 3 | 0 (n=10) |  |
| 4 | 0 (n=10) |  |
| 5 | 0 (n=5) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=2) |  |
| 8 | 0 (n=2) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1793 (n=10) | ██ |
| 2 | 4507 (n=10) | ██████ |
| 3 | 7785 (n=10) | ███████████ |
| 4 | 5253 (n=10) | ███████ |
| 5 | 6066 (n=5) | ████████ |
| 6 | 9449 (n=3) | █████████████ |
| 7 | 14487 (n=2) | ████████████████████ |
| 8 | 9107 (n=2) | █████████████ |
| 9 | 3510 (n=1) | █████ |
| 10 | 3812 (n=1) | █████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| generator_done | 6 | ████████████████████ |
| wall_time | 4 | █████████████ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- |
| bitcount | pass | 4 | 1 | $0.0049 |
| bucketsort | pass | 5 | 2 | $0.0019 |
| detect_cycle | pass | 4 | 3 | $0.0077 |
| find_in_sorted | pass | 4 | 0 | $0.0041 |
| gcd | pass | 4 | 1 | $0.0026 |
| kth | pass | 5 | 1 | $0.0023 |
| lis | pass | 6 | 2 | $0.0116 |
| mergesort | fail | 4 | 2 | $0.0070 |
| shortest_path_length | fail | 8 | 3 | $0.0279 |
| wrap | fail | 10 | 5 | $0.0230 |

