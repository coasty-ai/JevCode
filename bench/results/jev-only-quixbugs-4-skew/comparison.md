# JevCode bench 20260920-215703-786e98

Generated 2026-09-20T21:57:56.322Z. Generator model `none (jev-only)`. 5 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.

| condition | generator | decider | temperature | maxTokens | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | none (jev-only) | typesafe/jev-1.13-20260917 | not sent | 4096 | 12 | 6m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.1000; spent generator $0.0000 + Jev $0.0139 = $0.0139. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only | 5 | 5 | 5 | 5/5 (n=5) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-only |
| --- | --- | --- |
| off_by_one | 3 | 3/3 100.0% |
| other | 1 | 1/1 100.0% |
| wrong_variable | 1 | 1/1 100.0% |

### Paired comparison (n = 5 tasks evaluated in every condition)

Paired tasks: `knapsack`, `kth`, `lcs_length`, `levenshtein`, `longest_common_subsequence`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-only |
| --- | --- |
| pass rate (passed/evaluated) | 5/5 (n=5) 100.0% |
| steps-to-solve mean (n passed) | 4.20 (n=5) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 4.20 (n=5) |
| steps used median | 4 |
| read actions total / mean per run | 5 / 1 |
| blocked / reviews / declined | 1 / 1 / 1 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 144 / 707 |
| generator calls (jev-only asserts 0) | 0 |
| Jev latency p50 / p95 ms (n) | 187.42 / 299.64 (n=144) |
| mean generator tokens/step (steps) | 0 (n=21) |
| mean Jev tokens/step (steps) | 16495 (n=21) |
| mean tokens/step, generator+Jev (steps) | 16495 (n=21) |
| wall time mean | 28s |
| cost generator / Jev / total | $0.0000 / $0.0139 / $0.0139 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-only solved(k) | jev-only fraction | jev-only |
| --- | --- | --- | --- |
| 1 | 0/5 | 0.0% |  |
| 2 | 0/5 | 0.0% |  |
| 3 | 0/5 | 0.0% |  |
| 4 | 4/5 | 80.0% | ████████████████ |
| 5 | 5/5 | 100.0% | ████████████████████ |
| 6 | 5/5 | 100.0% | ████████████████████ |
| 7 | 5/5 | 100.0% | ████████████████████ |
| 8 | 5/5 | 100.0% | ████████████████████ |
| 9 | 5/5 | 100.0% | ████████████████████ |
| 10 | 5/5 | 100.0% | ████████████████████ |
| 11 | 5/5 | 100.0% | ████████████████████ |
| 12 | 5/5 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 0 (n=5) |  |
| 2 | 0 (n=5) |  |
| 3 | 0 (n=5) |  |
| 4 | 0 (n=5) |  |
| 5 | 0 (n=1) |  |

#### Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8757 (n=5) | ██████ |
| 2 | 9094 (n=5) | ██████ |
| 3 | 28468 (n=5) | ████████████████████ |
| 4 | 20335 (n=5) | ██████████████ |
| 5 | 13135 (n=1) | █████████ |

#### generator+Jev tokens per step

| step | jev-only mean tokens (n) | jev-only |
| --- | --- | --- |
| 1 | 8757 (n=5) | ██████ |
| 2 | 9094 (n=5) | ██████ |
| 3 | 28468 (n=5) | ████████████████████ |
| 4 | 20335 (n=5) | ██████████████ |
| 5 | 13135 (n=1) | █████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-only |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |

### Per task (paired)

| task | jev-only pass | jev-only steps | jev-only reads | jev-only cost |
| --- | --- | --- | --- | --- |
| knapsack | pass | 4 | 1 | $0.0022 |
| kth | pass | 4 | 1 | $0.0019 |
| lcs_length | pass | 4 | 1 | $0.0018 |
| levenshtein | pass | 4 | 1 | $0.0020 |
| longest_common_subsequence | pass | 5 | 1 | $0.0060 |

