# JevCode bench 20260920-204758-cd1a05

Generated 2026-09-20T20:51:06.196Z. Generator model `none (jev-only)`. 3 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $3.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0165 = $0.0165. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 3 | 3 | 2 | 2/3 (n=3) 66.7% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| missing_condition | 1 | 1/1 100.0% |
| other | 1 | 0/1 0.0% |
| wrong_variable | 1 | 1/1 100.0% |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `detect_cycle`, `reverse_linked_list`, `topological_ordering`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 2/3 (n=3) 66.7% |
| steps-to-solve mean (n passed) | 7 (n=2) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 8.67 (n=3) |
| steps used median | 10 |
| read actions total / mean per run | 8 / 2.67 |
| blocked / reviews / declined | 10 / 8 / 8 |
| loops / replans | 3 / 3 |
| Jev requests / questions | 166 / 1385 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 203.18 / 402.91 (n=166) |
| mean generator tokens/step (steps) | 0 (n=26) |
| mean Jev tokens/step (steps) | 16922 (n=26) |
| mean tokens/step, generator+Jev (steps) | 16922 (n=26) |
| wall time mean | 1m47s |
| cost generator / Jev / total | $0.0000 / $0.0165 / $0.0165 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  |
| 4 | 1/3 | 33.3% | ███████ |
| 5 | 1/3 | 33.3% | ███████ |
| 6 | 1/3 | 33.3% | ███████ |
| 7 | 1/3 | 33.3% | ███████ |
| 8 | 1/3 | 33.3% | ███████ |
| 9 | 1/3 | 33.3% | ███████ |
| 10 | 2/3 | 66.7% | █████████████ |
| 11 | 2/3 | 66.7% | █████████████ |
| 12 | 2/3 | 66.7% | █████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=3) |  |
| 2 | 0 (n=3) |  |
| 3 | 0 (n=3) |  |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=2) |  |
| 6 | 0 (n=2) |  |
| 7 | 0 (n=2) |  |
| 8 | 0 (n=2) |  |
| 9 | 0 (n=2) |  |
| 10 | 0 (n=2) |  |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6828 (n=3) | ███ |
| 2 | 8096 (n=3) | ███ |
| 3 | 44675 (n=3) | ██████████████████ |
| 4 | 9673 (n=3) | ████ |
| 5 | 50687 (n=2) | ████████████████████ |
| 6 | 11123 (n=2) | ████ |
| 7 | 10730 (n=2) | ████ |
| 8 | 13877 (n=2) | █████ |
| 9 | 8723 (n=2) | ███ |
| 10 | 12786 (n=2) | █████ |
| 11 | 8638 (n=1) | ███ |
| 12 | 7659 (n=1) | ███ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 6828 (n=3) | ███ |
| 2 | 8096 (n=3) | ███ |
| 3 | 44675 (n=3) | ██████████████████ |
| 4 | 9673 (n=3) | ████ |
| 5 | 50687 (n=2) | ████████████████████ |
| 6 | 11123 (n=2) | ████ |
| 7 | 10730 (n=2) | ████ |
| 8 | 13877 (n=2) | █████ |
| 9 | 8723 (n=2) | ███ |
| 10 | 12786 (n=2) | █████ |
| 11 | 8638 (n=1) | ███ |
| 12 | 7659 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 2 | ████████████████████ |
| max_steps | 1 | ██████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| detect_cycle | pass | 4 | 2 | $0.0016 |
| reverse_linked_list | fail | 12 | 2 | $0.0098 |
| topological_ordering | pass | 10 | 4 | $0.0051 |

