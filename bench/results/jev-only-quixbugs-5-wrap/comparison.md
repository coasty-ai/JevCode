# JevCode bench 20260920-230341-fc844a

Generated 2026-09-20T23:05:22.617Z. Generator model `none (jev-only)`. 1 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 8m | $0.2000 | auto | 2m | 200 KB |

## Spend

Bench cap $0.2000, per-run cap $0.2000; spent generator $0.0000 + Jev $0.0048 = $0.0048. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 1 | 1 | 1 | 1/1 (n=1) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| other | 1 | 1/1 100.0% |

### Paired comparison (n = 1 tasks evaluated in every condition)

Paired tasks: `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 1/1 (n=1) 100.0% |
| steps-to-solve mean (n passed) | 12 (n=1) |
| steps-to-solve median | 12 |
| steps used mean (n runs) | 12 (n=1) |
| steps used median | 12 |
| read actions total / mean per run | 1 / 1 |
| blocked / reviews / declined | 8 / 1 / 1 |
| loops / replans | 3 / 2 |
| Jev requests / questions | 46 / 249 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 187.12 / 333.32 (n=46) |
| mean generator tokens/step (steps) | 0 (n=12) |
| mean Jev tokens/step (steps) | 9929 (n=12) |
| mean tokens/step, generator+Jev (steps) | 9929 (n=12) |
| wall time mean | 1m40s |
| cost generator / Jev / total | $0.0000 / $0.0048 / $0.0048 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/1 | 0.0% |  |
| 2 | 0/1 | 0.0% |  |
| 3 | 0/1 | 0.0% |  |
| 4 | 0/1 | 0.0% |  |
| 5 | 0/1 | 0.0% |  |
| 6 | 0/1 | 0.0% |  |
| 7 | 0/1 | 0.0% |  |
| 8 | 0/1 | 0.0% |  |
| 9 | 0/1 | 0.0% |  |
| 10 | 0/1 | 0.0% |  |
| 11 | 0/1 | 0.0% |  |
| 12 | 1/1 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=1) |  |
| 2 | 0 (n=1) |  |
| 3 | 0 (n=1) |  |
| 4 | 0 (n=1) |  |
| 5 | 0 (n=1) |  |
| 6 | 0 (n=1) |  |
| 7 | 0 (n=1) |  |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8205 (n=1) | ████████ |
| 2 | 8638 (n=1) | ████████ |
| 3 | 6976 (n=1) | ███████ |
| 4 | 21304 (n=1) | ████████████████████ |
| 5 | 12550 (n=1) | ████████████ |
| 6 | 7479 (n=1) | ███████ |
| 7 | 10837 (n=1) | ██████████ |
| 8 | 7953 (n=1) | ███████ |
| 9 | 8109 (n=1) | ████████ |
| 10 | 11361 (n=1) | ███████████ |
| 11 | 7863 (n=1) | ███████ |
| 12 | 7869 (n=1) | ███████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8205 (n=1) | ████████ |
| 2 | 8638 (n=1) | ████████ |
| 3 | 6976 (n=1) | ███████ |
| 4 | 21304 (n=1) | ████████████████████ |
| 5 | 12550 (n=1) | ████████████ |
| 6 | 7479 (n=1) | ███████ |
| 7 | 10837 (n=1) | ██████████ |
| 8 | 7953 (n=1) | ███████ |
| 9 | 8109 (n=1) | ████████ |
| 10 | 11361 (n=1) | ███████████ |
| 11 | 7863 (n=1) | ███████ |
| 12 | 7869 (n=1) | ███████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| max_steps | 1 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| wrap | pass | 12 | 1 | $0.0048 |

