# JevCode bench 20260922-041104-6afd5e

Generated 2026-09-22T04:33:44.030Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | not sent | none | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.1000; spent generator $0.1426 + Jev $0.0000 = $0.1426. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 12 | 12 | 11 | 11/12 (n=12) 91.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-off |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 2/3 66.7% |
| 3 | 3 | 3/3 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-off |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 4/5 80.0% |
| 3 | 3 | 3/3 100.0% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 11/12 (n=12) 91.7% |
| steps-to-solve mean (n passed) | 10.36 (n=11) |
| steps-to-solve median | 9 |
| steps used mean (n runs) | 10.42 (n=12) |
| steps used median | 9 |
| read actions total / mean per run | 40 / 3.33 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 1 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 137 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 5010 (n=125) |
| mean Jev tokens/step (steps) | 0 (n=125) |
| mean tokens/step, generator+Jev (steps) | 5010 (n=125) |
| wall time mean | 5m23s |
| wall time median | 3m20s |
| cost generator / Jev / total | $0.1426 / $0.0000 / $0.1426 |
| $ per solved task | $0.0130 |
| pass rate Wilson 95% | [64.6%, 98.5%] |
| generator.jsonl calls / samples / valid | 137 / 0 / 125 |
| generator malformed / length / dropped (timeouts) | 12 / 1 / 0 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 14308 / 59730, 12374 / 53945 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0000 / 138453 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 0/12 | 0.0% |  |
| 5 | 0/12 | 0.0% |  |
| 6 | 1/12 | 8.3% | ██ |
| 7 | 4/12 | 33.3% | ███████ |
| 8 | 5/12 | 41.7% | ████████ |
| 9 | 6/12 | 50.0% | ██████████ |
| 10 | 6/12 | 50.0% | ██████████ |
| 11 | 6/12 | 50.0% | ██████████ |
| 12 | 6/12 | 50.0% | ██████████ |
| 13 | 8/12 | 66.7% | █████████████ |
| 14 | 9/12 | 75.0% | ███████████████ |
| 15 | 11/12 | 91.7% | ██████████████████ |
| 16 | 11/12 | 91.7% | ██████████████████ |
| 17 | 11/12 | 91.7% | ██████████████████ |
| 18 | 11/12 | 91.7% | ██████████████████ |
| 19 | 11/12 | 91.7% | ██████████████████ |
| 20 | 11/12 | 91.7% | ██████████████████ |
| 21 | 11/12 | 91.7% | ██████████████████ |
| 22 | 11/12 | 91.7% | ██████████████████ |
| 23 | 11/12 | 91.7% | ██████████████████ |
| 24 | 11/12 | 91.7% | ██████████████████ |
| 25 | 11/12 | 91.7% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1800 (n=12) | ████ |
| 2 | 2362 (n=12) | █████ |
| 3 | 2750 (n=12) | ██████ |
| 4 | 5105 (n=12) | ███████████ |
| 5 | 4775 (n=12) | ███████████ |
| 6 | 7182 (n=12) | ████████████████ |
| 7 | 5893 (n=11) | █████████████ |
| 8 | 5126 (n=8) | ███████████ |
| 9 | 8925 (n=7) | ████████████████████ |
| 10 | 6005 (n=6) | █████████████ |
| 11 | 6954 (n=6) | ████████████████ |
| 12 | 5347 (n=5) | ████████████ |
| 13 | 7668 (n=5) | █████████████████ |
| 14 | 5593 (n=3) | █████████████ |
| 15 | 5347 (n=2) | ████████████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=12) |  |
| 6 | 0 (n=12) |  |
| 7 | 0 (n=11) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=7) |  |
| 10 | 0 (n=6) |  |
| 11 | 0 (n=6) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=3) |  |
| 15 | 0 (n=2) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1800 (n=12) | ████ |
| 2 | 2362 (n=12) | █████ |
| 3 | 2750 (n=12) | ██████ |
| 4 | 5105 (n=12) | ███████████ |
| 5 | 4775 (n=12) | ███████████ |
| 6 | 7182 (n=12) | ████████████████ |
| 7 | 5893 (n=11) | █████████████ |
| 8 | 5126 (n=8) | ███████████ |
| 9 | 8925 (n=7) | ████████████████████ |
| 10 | 6005 (n=6) | █████████████ |
| 11 | 6954 (n=6) | ████████████████ |
| 12 | 5347 (n=5) | ████████████ |
| 13 | 7668 (n=5) | █████████████████ |
| 14 | 5593 (n=3) | █████████████ |
| 15 | 5347 (n=2) | ████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| generator_done | 11 | ████████████████████ |
| wall_time | 1 | ██ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off wall | jev-off cost |
| --- | --- | --- | --- | --- | --- |
| account | pass | 15 | 3 | 7m36s | $0.0195 |
| calendar_utils | pass | 8 | 3 | 2m57s | $0.0079 |
| events | pass | 14 | 4 | 8m58s | $0.0124 |
| grades | fail | 11 | 5 | 12m | $0.0186 |
| inventory | pass | 15 | 4 | 11m39s | $0.0276 |
| profiles | pass | 9 | 4 | 2m38s | $0.0059 |
| shipping | pass | 7 | 3 | 2m5s | $0.0048 |
| stats | pass | 7 | 2 | 2m48s | $0.0029 |
| table | pass | 13 | 3 | 5m34s | $0.0129 |
| tagcloud | pass | 6 | 2 | 56s | $0.0037 |
| textstats | pass | 13 | 4 | 4m6s | $0.0149 |
| units | pass | 7 | 3 | 3m20s | $0.0116 |

