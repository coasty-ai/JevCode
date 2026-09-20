# JevCode bench 20260920-055438-bacdc9

Generated 2026-09-20T06:01:46.121Z. Generator model `anthropic/claude-sonnet-5`. 6 task records, suites: swebench.

## Conditions

Both conditions run the same generator, system prompt, user-message layout, limits and sandbox. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | anthropic/claude-sonnet-5 | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |
| jev-off | anthropic/claude-sonnet-5 | — | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |

## Spend

Bench cap $8.0000, per-run cap $1.5000; spent generator $3.8041 + Jev $0.1323 = $3.9365. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | 3 | 3 | 3 | 3/3 (n=3) 100.0% | — | — | — | — |
| jev-off | 3 | 3 | 2 | 2/3 (n=3) 66.7% | — | — | — | — |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `sympy__sympy-12096`, `sympy__sympy-15345`, `sympy__sympy-17139`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate (passed/evaluated) | 3/3 (n=3) 100.0% | 2/3 (n=3) 66.7% |
| steps-to-solve mean (n passed) | 21.33 (n=3) | 25 (n=2) |
| steps-to-solve median | 21 | 25 |
| steps used mean (n runs) | 21.33 (n=3) | 25 (n=3) |
| steps used median | 21 | 25 |
| read actions total / mean per run | 7 / 2.33 | 13 / 4.33 |
| blocked / reviews / declined | 11 / 9 / 9 | 0 / 0 / 0 |
| loops / replans | 5 / 3 | 3 / 0 |
| Jev requests / questions | 243 / 19633 | 0 / 0 |
| Jev latency p50 / p95 ms (n) | 228.17 / 563.90 (n=243) | null / null (n=0) |
| mean tokens/step (steps) | 68312 (n=64) | 12813 (n=75) |
| wall time mean | 2m37s | 2m13s |
| cost generator / Jev / total | $1.6297 / $0.1323 / $1.7620 | $2.1745 / $0.0000 / $2.1745 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-on solved(k) | jev-on fraction | jev-on | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 4 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 5 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 6 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 7 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 8 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 9 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 10 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 11 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 12 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 13 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 14 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 15 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 16 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 17 | 0/3 | 0.0% |  | 0/3 | 0.0% |  |
| 18 | 1/3 | 33.3% | ███████ | 0/3 | 0.0% |  |
| 19 | 1/3 | 33.3% | ███████ | 0/3 | 0.0% |  |
| 20 | 1/3 | 33.3% | ███████ | 0/3 | 0.0% |  |
| 21 | 2/3 | 66.7% | █████████████ | 0/3 | 0.0% |  |
| 22 | 2/3 | 66.7% | █████████████ | 0/3 | 0.0% |  |
| 23 | 2/3 | 66.7% | █████████████ | 0/3 | 0.0% |  |
| 24 | 2/3 | 66.7% | █████████████ | 0/3 | 0.0% |  |
| 25 | 3/3 | 100.0% | ████████████████████ | 2/3 | 66.7% | █████████████ |

### Tokens per step (paired; mean generator+Jev tokens over runs that reached the step)

| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |
| --- | --- | --- | --- | --- |
| 1 | 65183 (n=3) | ████████████████ | 9569 (n=3) | ██ |
| 2 | 59656 (n=3) | ██████████████ | 9788 (n=3) | ██ |
| 3 | 62221 (n=3) | ███████████████ | 10249 (n=3) | ██ |
| 4 | 63208 (n=3) | ███████████████ | 10746 (n=3) | ███ |
| 5 | 65243 (n=3) | ████████████████ | 11249 (n=3) | ███ |
| 6 | 68308 (n=3) | █████████████████ | 11749 (n=3) | ███ |
| 7 | 66886 (n=3) | ████████████████ | 11980 (n=3) | ███ |
| 8 | 69291 (n=3) | █████████████████ | 12129 (n=3) | ███ |
| 9 | 68027 (n=3) | █████████████████ | 12430 (n=3) | ███ |
| 10 | 68405 (n=3) | █████████████████ | 12568 (n=3) | ███ |
| 11 | 68058 (n=3) | █████████████████ | 12966 (n=3) | ███ |
| 12 | 70679 (n=3) | █████████████████ | 12923 (n=3) | ███ |
| 13 | 70250 (n=3) | █████████████████ | 13195 (n=3) | ███ |
| 14 | 72004 (n=3) | █████████████████ | 13199 (n=3) | ███ |
| 15 | 79630 (n=3) | ███████████████████ | 13329 (n=3) | ███ |
| 16 | 28836 (n=3) | ███████ | 13491 (n=3) | ███ |
| 17 | 79981 (n=3) | ███████████████████ | 13561 (n=3) | ███ |
| 18 | 82300 (n=3) | ████████████████████ | 13956 (n=3) | ███ |
| 19 | 78642 (n=2) | ███████████████████ | 13716 (n=3) | ███ |
| 20 | 75231 (n=2) | ██████████████████ | 13742 (n=3) | ███ |
| 21 | 71544 (n=2) | █████████████████ | 18635 (n=3) | █████ |
| 22 | 75427 (n=1) | ██████████████████ | 13692 (n=3) | ███ |
| 23 | 74926 (n=1) | ██████████████████ | 13776 (n=3) | ███ |
| 24 | 76988 (n=1) | ███████████████████ | 13826 (n=3) | ███ |
| 25 | 69325 (n=1) | █████████████████ | 13866 (n=3) | ███ |

### Stop reasons (all records)

| stop reason | jev-on |  | jev-off |  |
| --- | --- | --- | --- | --- |
| max_steps | 1 | ███████ | 3 | ████████████████████ |
| replan_stop | 2 | █████████████ | 0 |  |

### Per task (paired)

| task | jev-on pass | jev-on steps | jev-on reads | jev-on cost | jev-off pass | jev-off steps | jev-off reads | jev-off cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12096 | pass | 21 | 2 | $0.6389 | pass | 25 | 4 | $0.6899 |
| sympy__sympy-15345 | pass | 25 | 4 | $0.4813 | pass | 25 | 5 | $0.7063 |
| sympy__sympy-17139 | pass | 18 | 1 | $0.6418 | fail | 25 | 4 | $0.7783 |

