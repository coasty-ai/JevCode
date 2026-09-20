# JevCode bench 20260920-054223-c28b36

Generated 2026-09-20T05:48:35.049Z. Generator model `anthropic/claude-sonnet-5`. 6 task records, suites: swebench.

## Conditions

Both conditions run the same generator, system prompt, user-message layout, limits and sandbox. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | anthropic/claude-sonnet-5 | typesafe/jev-1.13-20260917 | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |
| jev-off | anthropic/claude-sonnet-5 | — | not sent | 4096 | 25 | 20m | $1.5000 | auto | 2m | 200 KB |

## Spend

Bench cap $8.0000, per-run cap $1.5000; spent generator $3.7924 + Jev $0.1569 = $3.9493. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-on | 3 | 2 | 0 | 0/2 (n=2) 0.0% | `sympy__sympy-12096` | — | — | — |
| jev-off | 3 | 0 | 0 | 0/0 (n=0) null | `sympy__sympy-15345`, `sympy__sympy-12096`, `sympy__sympy-17139` | — | — | — |

### Paired comparison (n = 0 tasks evaluated in every condition)

Paired tasks: —. Excluded for model drift: —. Incomplete pairs: `sympy__sympy-12096`, `sympy__sympy-15345`, `sympy__sympy-17139`.

| metric | jev-on | jev-off |
| --- | --- | --- |
| pass rate (passed/evaluated) | 0/0 (n=0) null | 0/0 (n=0) null |
| steps-to-solve mean (n passed) | null (n=0) | null (n=0) |
| steps-to-solve median | null | null |
| steps used mean (n runs) | null (n=0) | null (n=0) |
| steps used median | null | null |
| read actions total / mean per run | 0 / null | 0 / null |
| blocked / reviews / declined | 0 / 0 / 0 | 0 / 0 / 0 |
| loops / replans | 0 / 0 | 0 / 0 |
| Jev requests / questions | 0 / 0 | 0 / 0 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) | null / null (n=0) |
| mean tokens/step (steps) | null (n=0) | null (n=0) |
| wall time mean | null | null |
| cost generator / Jev / total | $0.0000 / $0.0000 / $0.0000 | $0.0000 / $0.0000 / $0.0000 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-on solved(k) | jev-on fraction | jev-on | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/0 | null |  | 0/0 | null |  |
| 2 | 0/0 | null |  | 0/0 | null |  |
| 3 | 0/0 | null |  | 0/0 | null |  |
| 4 | 0/0 | null |  | 0/0 | null |  |
| 5 | 0/0 | null |  | 0/0 | null |  |
| 6 | 0/0 | null |  | 0/0 | null |  |
| 7 | 0/0 | null |  | 0/0 | null |  |
| 8 | 0/0 | null |  | 0/0 | null |  |
| 9 | 0/0 | null |  | 0/0 | null |  |
| 10 | 0/0 | null |  | 0/0 | null |  |
| 11 | 0/0 | null |  | 0/0 | null |  |
| 12 | 0/0 | null |  | 0/0 | null |  |
| 13 | 0/0 | null |  | 0/0 | null |  |
| 14 | 0/0 | null |  | 0/0 | null |  |
| 15 | 0/0 | null |  | 0/0 | null |  |
| 16 | 0/0 | null |  | 0/0 | null |  |
| 17 | 0/0 | null |  | 0/0 | null |  |
| 18 | 0/0 | null |  | 0/0 | null |  |
| 19 | 0/0 | null |  | 0/0 | null |  |
| 20 | 0/0 | null |  | 0/0 | null |  |
| 21 | 0/0 | null |  | 0/0 | null |  |
| 22 | 0/0 | null |  | 0/0 | null |  |
| 23 | 0/0 | null |  | 0/0 | null |  |
| 24 | 0/0 | null |  | 0/0 | null |  |
| 25 | 0/0 | null |  | 0/0 | null |  |

### Tokens per step (paired; mean generator+Jev tokens over runs that reached the step)

_no executed steps_

### Stop reasons (all records)

| stop reason | jev-on |  | jev-off |  |
| --- | --- | --- | --- | --- |
| generator_done | 0 |  | 2 | █████████████ |
| max_steps | 3 | ████████████████████ | 1 | ███████ |

### Per task (paired)

_no paired tasks_

### Incomplete pairs

| task | condition | pass | evaluator | stop reason | reason |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-15345 | jev-on | false | local-venv | max_steps | empty model_patch |
| sympy__sympy-12096 | jev-on | null | none | max_steps | environment build failed: clone/checkout 50b81f9f6be151014501ffac44e5dc6b2416938f failed: /Users/prateekjannu/.jevcode/runs/20260920-054229-b6nf3f3e/eval/sympy__sympy-12096/.git/hooks/: Operation not permitted |
| sympy__sympy-17139 | jev-on | false | local-venv | max_steps | empty model_patch |
| sympy__sympy-15345 | jev-off | null | none | max_steps | environment build failed: clone/checkout 73b3f90093754c5ed1561bd885242330e3583004 failed: /Users/prateekjannu/.jevcode/runs/20260920-054456-6l3ysav5/eval/sympy__sympy-15345/.git/hooks/: Operation not permitted |
| sympy__sympy-12096 | jev-off | null | none | generator_done | environment build failed: clone/checkout 50b81f9f6be151014501ffac44e5dc6b2416938f failed: /Users/prateekjannu/.jevcode/runs/20260920-054536-z7pfwi76/eval/sympy__sympy-12096/.git/hooks/: Operation not permitted |
| sympy__sympy-17139 | jev-off | null | none | generator_done | environment build failed: clone/checkout 70381f282f2d9d039da860e391fe51649df2779d failed: /Users/prateekjannu/.jevcode/runs/20260920-054544-gc7zq67x/eval/sympy__sympy-17139/.git/hooks/: Operation not permitted |

