# JevCode bench 20260922-162231-c7be1f

Generated 2026-09-22T16:47:43.321Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.0850 + Jev $0.0525 = $0.1374. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 4 | 4/6 (n=6) 66.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 3 | 6 | 4/6 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 5 | 6 | 4/6 66.7% |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `csv_schema`, `deadline_queue`, `dep_order`, `hunk_merge`, `route_match`, `token_bucket`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 4/6 (n=6) 66.7% |
| steps-to-solve mean (n passed) | 4.75 (n=4) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 9.67 (n=6) |
| steps used median | 4 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 13 / 11 |
| Jev requests / questions | 704 / 1440 |
| generator calls (jev-only asserts 0) | 198 |
| Jev latency p50 / p95 ms (n) | 154.50 / 289.83 (n=839) |
| mean generator tokens/step (steps) | 9508 (n=58) |
| mean Jev tokens/step (steps) | 25497 (n=58) |
| mean tokens/step, generator+Jev (steps) | 35005 (n=58) |
| wall time mean | 7m27s |
| wall time median | 4m40s |
| cost generator / Jev / total | $0.0850 / $0.0525 / $0.1374 |
| $ per solved task | $0.0344 |
| pass rate Wilson 95% | [30.0%, 90.3%] |
| generator.jsonl calls / samples / valid | 198 / 198 / 103 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 95 (11) |
| generator latency p50 / p90 ms, valid p50 / p90 | 7526 / 25653, 10281 / 26907 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0311 / 20043 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 44m6s / 45s (n=58) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 198 / 71 / 0 / 11 / 82 / 4 |
| verify: candidates tested / passers / partials | 27178 / 11 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 1/6 | 16.7% | ███ |
| 4 | 3/6 | 50.0% | ██████████ |
| 5 | 3/6 | 50.0% | ██████████ |
| 6 | 3/6 | 50.0% | ██████████ |
| 7 | 3/6 | 50.0% | ██████████ |
| 8 | 4/6 | 66.7% | █████████████ |
| 9 | 4/6 | 66.7% | █████████████ |
| 10 | 4/6 | 66.7% | █████████████ |
| 11 | 4/6 | 66.7% | █████████████ |
| 12 | 4/6 | 66.7% | █████████████ |
| 13 | 4/6 | 66.7% | █████████████ |
| 14 | 4/6 | 66.7% | █████████████ |
| 15 | 4/6 | 66.7% | █████████████ |
| 16 | 4/6 | 66.7% | █████████████ |
| 17 | 4/6 | 66.7% | █████████████ |
| 18 | 4/6 | 66.7% | █████████████ |
| 19 | 4/6 | 66.7% | █████████████ |
| 20 | 4/6 | 66.7% | █████████████ |
| 21 | 4/6 | 66.7% | █████████████ |
| 22 | 4/6 | 66.7% | █████████████ |
| 23 | 4/6 | 66.7% | █████████████ |
| 24 | 4/6 | 66.7% | █████████████ |
| 25 | 4/6 | 66.7% | █████████████ |
| 26 | 4/6 | 66.7% | █████████████ |
| 27 | 4/6 | 66.7% | █████████████ |
| 28 | 4/6 | 66.7% | █████████████ |
| 29 | 4/6 | 66.7% | █████████████ |
| 30 | 4/6 | 66.7% | █████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 7832 (n=6) | █████████ |
| 2 | 13406 (n=6) | ████████████████ |
| 3 | 10459 (n=6) | ████████████ |
| 4 | 6180 (n=5) | ███████ |
| 5 | 15756 (n=3) | ███████████████████ |
| 6 | 9921 (n=3) | ████████████ |
| 7 | 10805 (n=3) | █████████████ |
| 8 | 9439 (n=3) | ███████████ |
| 9 | 7130 (n=2) | ████████ |
| 10 | 8407 (n=2) | ██████████ |
| 11 | 6312 (n=2) | ███████ |
| 12 | 3478 (n=2) | ████ |
| 13 | 4767 (n=2) | ██████ |
| 14 | 3113 (n=2) | ████ |
| 15 | 10542 (n=2) | █████████████ |
| 16 | 10504 (n=2) | ████████████ |
| 17 | 14357 (n=2) | █████████████████ |
| 18 | 9475 (n=2) | ███████████ |
| 19 | 9437 (n=1) | ███████████ |
| 20 | 16847 (n=1) | ████████████████████ |
| 21 | 10145 (n=1) | ████████████ |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 27436 (n=6) | ██████ |
| 2 | 37109 (n=6) | █████████ |
| 3 | 20686 (n=6) | █████ |
| 4 | 4471 (n=5) | █ |
| 5 | 85185 (n=3) | ████████████████████ |
| 6 | 58235 (n=3) | ██████████████ |
| 7 | 25950 (n=3) | ██████ |
| 8 | 34105 (n=3) | ████████ |
| 9 | 3544 (n=2) | █ |
| 10 | 2395 (n=2) | █ |
| 11 | 35596 (n=2) | ████████ |
| 12 | 2870 (n=2) | █ |
| 13 | 3323 (n=2) | █ |
| 14 | 10378 (n=2) | ██ |
| 15 | 5956 (n=2) | █ |
| 16 | 2802 (n=2) | █ |
| 17 | 51508 (n=2) | ████████████ |
| 18 | 2302 (n=2) | █ |
| 19 | 17437 (n=1) | ████ |
| 20 | 69663 (n=1) | ████████████████ |
| 21 | 6225 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 35268 (n=6) | ███████ |
| 2 | 50515 (n=6) | ██████████ |
| 3 | 31145 (n=6) | ██████ |
| 4 | 10651 (n=5) | ██ |
| 5 | 100941 (n=3) | ████████████████████ |
| 6 | 68156 (n=3) | ██████████████ |
| 7 | 36756 (n=3) | ███████ |
| 8 | 43544 (n=3) | █████████ |
| 9 | 10674 (n=2) | ██ |
| 10 | 10802 (n=2) | ██ |
| 11 | 41908 (n=2) | ████████ |
| 12 | 6348 (n=2) | █ |
| 13 | 8090 (n=2) | ██ |
| 14 | 13491 (n=2) | ███ |
| 15 | 16497 (n=2) | ███ |
| 16 | 13306 (n=2) | ███ |
| 17 | 65865 (n=2) | █████████████ |
| 18 | 11777 (n=2) | ██ |
| 19 | 26874 (n=1) | █████ |
| 20 | 86510 (n=1) | █████████████████ |
| 21 | 16370 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 4 | ████████████████████ |
| max_replans | 2 | ██████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | fail | 18 | 0 | 10m24s | $0.0430 |
| deadline_queue | pass | 3 | 0 | 2m20s | $0.0074 |
| dep_order | pass | 4 | 0 | 3m38s | $0.0091 |
| hunk_merge | pass | 8 | 0 | 8m58s | $0.0251 |
| route_match | fail | 21 | 0 | 14m45s | $0.0424 |
| token_bucket | pass | 4 | 0 | 4m40s | $0.0104 |

