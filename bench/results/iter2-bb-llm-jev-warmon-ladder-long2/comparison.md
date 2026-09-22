# JevCode bench 20260922-191224-2e3e26

Generated 2026-09-22T19:39:36.550Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.0898 + Jev $0.0729 = $0.1627. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 5 | 5/6 (n=6) 83.3% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 3 | 6 | 5/6 83.3% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 5 | 6 | 5/6 83.3% |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `csv_schema`, `deadline_queue`, `dep_order`, `hunk_merge`, `route_match`, `token_bucket`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 5/6 (n=6) 83.3% |
| steps-to-solve mean (n passed) | 6.60 (n=5) |
| steps-to-solve median | 7 |
| steps used mean (n runs) | 9.50 (n=6) |
| steps used median | 7 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 10 / 9 |
| Jev requests / questions | 571 / 2029 |
| generator calls (jev-only asserts 0) | 180 |
| Jev latency p50 / p95 ms (n) | 144.55 / 280.02 (n=754) |
| mean generator tokens/step (steps) | 10435 (n=57) |
| mean Jev tokens/step (steps) | 38672 (n=57) |
| mean tokens/step, generator+Jev (steps) | 49107 (n=57) |
| wall time mean | 8m29s |
| wall time median | 8m18s |
| cost generator / Jev / total | $0.0898 / $0.0729 / $0.1627 |
| $ per solved task | $0.0325 |
| pass rate Wilson 95% | [43.6%, 97.0%] |
| generator.jsonl calls / samples / valid | 180 / 180 / 148 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 32 (16) |
| generator latency p50 / p90 ms, valid p50 / p90 | 8887 / 20001, 8873 / 18345 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0118 / 25352 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 50m20s / 52s (n=57) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 180 / 80 / 0 / 16 / 16 / 1 |
| verify: candidates tested / passers / partials | 32092 / 20 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 1/6 | 16.7% | ███ |
| 4 | 1/6 | 16.7% | ███ |
| 5 | 1/6 | 16.7% | ███ |
| 6 | 2/6 | 33.3% | ███████ |
| 7 | 3/6 | 50.0% | ██████████ |
| 8 | 4/6 | 66.7% | █████████████ |
| 9 | 5/6 | 83.3% | █████████████████ |
| 10 | 5/6 | 83.3% | █████████████████ |
| 11 | 5/6 | 83.3% | █████████████████ |
| 12 | 5/6 | 83.3% | █████████████████ |
| 13 | 5/6 | 83.3% | █████████████████ |
| 14 | 5/6 | 83.3% | █████████████████ |
| 15 | 5/6 | 83.3% | █████████████████ |
| 16 | 5/6 | 83.3% | █████████████████ |
| 17 | 5/6 | 83.3% | █████████████████ |
| 18 | 5/6 | 83.3% | █████████████████ |
| 19 | 5/6 | 83.3% | █████████████████ |
| 20 | 5/6 | 83.3% | █████████████████ |
| 21 | 5/6 | 83.3% | █████████████████ |
| 22 | 5/6 | 83.3% | █████████████████ |
| 23 | 5/6 | 83.3% | █████████████████ |
| 24 | 5/6 | 83.3% | █████████████████ |
| 25 | 5/6 | 83.3% | █████████████████ |
| 26 | 5/6 | 83.3% | █████████████████ |
| 27 | 5/6 | 83.3% | █████████████████ |
| 28 | 5/6 | 83.3% | █████████████████ |
| 29 | 5/6 | 83.3% | █████████████████ |
| 30 | 5/6 | 83.3% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 8100 (n=6) | ███████ |
| 2 | 10512 (n=6) | █████████ |
| 3 | 10309 (n=6) | █████████ |
| 4 | 10073 (n=5) | █████████ |
| 5 | 12302 (n=5) | ██████████ |
| 6 | 12500 (n=5) | ███████████ |
| 7 | 9741 (n=4) | ████████ |
| 8 | 9294 (n=3) | ████████ |
| 9 | 11585 (n=2) | ██████████ |
| 10 | 18549 (n=1) | ████████████████ |
| 11 | 7694 (n=1) | ███████ |
| 12 | 0 (n=1) |  |
| 13 | 0 (n=1) |  |
| 14 | 22848 (n=1) | ███████████████████ |
| 15 | 23456 (n=1) | ████████████████████ |
| 16 | 19979 (n=1) | █████████████████ |
| 17 | 9815 (n=1) | ████████ |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 22757 (n=1) | ███████████████████ |
| 21 | 22159 (n=1) | ███████████████████ |
| 22 | 9618 (n=1) | ████████ |
| 23 | 0 (n=1) |  |
| 24 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 26404 (n=6) | ███ |
| 2 | 15245 (n=6) | ██ |
| 3 | 62385 (n=6) | ███████ |
| 4 | 56032 (n=5) | ██████ |
| 5 | 57474 (n=5) | ██████ |
| 6 | 34145 (n=5) | ████ |
| 7 | 41671 (n=4) | █████ |
| 8 | 28320 (n=3) | ███ |
| 9 | 29885 (n=2) | ███ |
| 10 | 180093 (n=1) | ████████████████████ |
| 11 | 7683 (n=1) | █ |
| 12 | 0 (n=1) |  |
| 13 | 0 (n=1) |  |
| 14 | 107019 (n=1) | ████████████ |
| 15 | 94243 (n=1) | ██████████ |
| 16 | 134419 (n=1) | ███████████████ |
| 17 | 0 (n=1) |  |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 3362 (n=1) |  |
| 21 | 0 (n=1) |  |
| 22 | 3621 (n=1) |  |
| 23 | 0 (n=1) |  |
| 24 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 34503 (n=6) | ███ |
| 2 | 25757 (n=6) | ███ |
| 3 | 72694 (n=6) | ███████ |
| 4 | 66105 (n=5) | ███████ |
| 5 | 69776 (n=5) | ███████ |
| 6 | 46645 (n=5) | █████ |
| 7 | 51412 (n=4) | █████ |
| 8 | 37614 (n=3) | ████ |
| 9 | 41469 (n=2) | ████ |
| 10 | 198642 (n=1) | ████████████████████ |
| 11 | 15377 (n=1) | ██ |
| 12 | 0 (n=1) |  |
| 13 | 0 (n=1) |  |
| 14 | 129867 (n=1) | █████████████ |
| 15 | 117699 (n=1) | ████████████ |
| 16 | 154398 (n=1) | ████████████████ |
| 17 | 9815 (n=1) | █ |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 26119 (n=1) | ███ |
| 21 | 22159 (n=1) | ██ |
| 22 | 13239 (n=1) | █ |
| 23 | 0 (n=1) |  |
| 24 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |
| max_replans | 1 | ████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | pass | 7 | 0 | 8m46s | $0.0289 |
| deadline_queue | pass | 3 | 0 | 3m1s | $0.0045 |
| dep_order | pass | 9 | 0 | 10m35s | $0.0330 |
| hunk_merge | pass | 8 | 0 | 8m18s | $0.0154 |
| route_match | fail | 24 | 0 | 13m31s | $0.0659 |
| token_bucket | pass | 6 | 0 | 6m40s | $0.0150 |

