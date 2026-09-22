# JevCode bench 20260922-184533-3a5340

Generated 2026-09-22T19:12:23.746Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.0675 + Jev $0.0469 = $0.1144. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 6.20 (n=5) |
| steps-to-solve median | 4 |
| steps used mean (n runs) | 8.33 (n=6) |
| steps used median | 4 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 10 / 9 |
| Jev requests / questions | 556 / 1576 |
| generator calls (jev-only asserts 0) | 141 |
| Jev latency p50 / p95 ms (n) | 137.72 / 275.01 (n=725) |
| mean generator tokens/step (steps) | 8826 (n=50) |
| mean Jev tokens/step (steps) | 26908 (n=50) |
| mean tokens/step, generator+Jev (steps) | 35734 (n=50) |
| wall time mean | 7m23s |
| wall time median | 4m34s |
| cost generator / Jev / total | $0.0675 / $0.0469 / $0.1144 |
| $ per solved task | $0.0229 |
| pass rate Wilson 95% | [43.6%, 97.0%] |
| generator.jsonl calls / samples / valid | 141 / 141 / 102 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 39 (12) |
| generator latency p50 / p90 ms, valid p50 / p90 | 10768 / 34510, 10557 / 28451 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0155 / 18482 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 44m3s / 52s (n=50) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 141 / 58 / 0 / 12 / 27 / 1 |
| verify: candidates tested / passers / partials | 36588 / 16 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 2/6 | 33.3% | ███████ |
| 4 | 3/6 | 50.0% | ██████████ |
| 5 | 3/6 | 50.0% | ██████████ |
| 6 | 3/6 | 50.0% | ██████████ |
| 7 | 4/6 | 66.7% | █████████████ |
| 8 | 4/6 | 66.7% | █████████████ |
| 9 | 4/6 | 66.7% | █████████████ |
| 10 | 4/6 | 66.7% | █████████████ |
| 11 | 4/6 | 66.7% | █████████████ |
| 12 | 4/6 | 66.7% | █████████████ |
| 13 | 4/6 | 66.7% | █████████████ |
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
| 1 | 9143 (n=6) | █████████ |
| 2 | 11614 (n=6) | ████████████ |
| 3 | 6233 (n=6) | ██████ |
| 4 | 6556 (n=4) | ███████ |
| 5 | 13434 (n=3) | ██████████████ |
| 6 | 13257 (n=3) | ██████████████ |
| 7 | 6733 (n=3) | ███████ |
| 8 | 3687 (n=2) | ████ |
| 9 | 7335 (n=2) | ███████ |
| 10 | 3736 (n=2) | ████ |
| 11 | 0 (n=2) |  |
| 12 | 10599 (n=2) | ███████████ |
| 13 | 12674 (n=2) | █████████████ |
| 14 | 9926 (n=2) | ██████████ |
| 15 | 18725 (n=1) | ███████████████████ |
| 16 | 0 (n=1) |  |
| 17 | 0 (n=1) |  |
| 18 | 19637 (n=1) | ████████████████████ |
| 19 | 18579 (n=1) | ███████████████████ |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 30995 (n=6) | ███████ |
| 2 | 16178 (n=6) | ████ |
| 3 | 6222 (n=6) | █ |
| 4 | 17657 (n=4) | ████ |
| 5 | 73920 (n=3) | █████████████████ |
| 6 | 8120 (n=3) | ██ |
| 7 | 76238 (n=3) | ██████████████████ |
| 8 | 20628 (n=2) | █████ |
| 9 | 14855 (n=2) | ████ |
| 10 | 13084 (n=2) | ███ |
| 11 | 0 (n=2) |  |
| 12 | 84694 (n=2) | ████████████████████ |
| 13 | 36605 (n=2) | █████████ |
| 14 | 12007 (n=2) | ███ |
| 15 | 67411 (n=1) | ████████████████ |
| 16 | 0 (n=1) |  |
| 17 | 0 (n=1) |  |
| 18 | 5280 (n=1) | █ |
| 19 | 43124 (n=1) | ██████████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 40139 (n=6) | ████████ |
| 2 | 27793 (n=6) | ██████ |
| 3 | 12455 (n=6) | ███ |
| 4 | 24212 (n=4) | █████ |
| 5 | 87354 (n=3) | ██████████████████ |
| 6 | 21377 (n=3) | ████ |
| 7 | 82971 (n=3) | █████████████████ |
| 8 | 24315 (n=2) | █████ |
| 9 | 22190 (n=2) | █████ |
| 10 | 16820 (n=2) | ████ |
| 11 | 0 (n=2) |  |
| 12 | 95293 (n=2) | ████████████████████ |
| 13 | 49279 (n=2) | ██████████ |
| 14 | 21933 (n=2) | █████ |
| 15 | 86136 (n=1) | ██████████████████ |
| 16 | 0 (n=1) |  |
| 17 | 0 (n=1) |  |
| 18 | 24917 (n=1) | █████ |
| 19 | 61703 (n=1) | █████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |
| max_replans | 1 | ████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | pass | 14 | 0 | 12m58s | $0.0226 |
| deadline_queue | pass | 3 | 0 | 3m13s | $0.0054 |
| dep_order | pass | 4 | 0 | 4m34s | $0.0064 |
| hunk_merge | pass | 7 | 0 | 7m1s | $0.0182 |
| route_match | fail | 19 | 0 | 13m49s | $0.0568 |
| token_bucket | pass | 3 | 0 | 2m42s | $0.0051 |

