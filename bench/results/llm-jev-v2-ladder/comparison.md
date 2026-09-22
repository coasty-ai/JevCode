# JevCode bench 20260922-014054-a36b9b

Generated 2026-09-22T01:46:20.582Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1000; spent generator $0.0089 + Jev $0.0409 = $0.0498. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 12 | 12 | 12 | 12/12 (n=12) 100.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 3/3 100.0% |
| 3 | 3 | 3/3 100.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 3/3 100.0% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 12/12 (n=12) 100.0% |
| steps-to-solve mean (n passed) | 2.83 (n=12) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 2.83 (n=12) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 203 / 5030 |
| generator calls (jev-only asserts 0) | 32 |
| Jev latency p50 / p95 ms (n) | 181.48 / 368.48 (n=203) |
| mean generator tokens/step (steps) | 2128 (n=34) |
| mean Jev tokens/step (steps) | 31448 (n=34) |
| mean tokens/step, generator+Jev (steps) | 33576 (n=34) |
| wall time mean | 1m2s |
| wall time median | 39s |
| cost generator / Jev / total | $0.0089 / $0.0409 / $0.0498 |
| $ per solved task | $0.0041 |
| pass rate Wilson 95% | [75.7%, 100.0%] |
| generator.jsonl calls / samples / valid | 32 / 32 / 22 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 10 (5) |
| generator latency p50 / p90 ms, valid p50 / p90 | 9711 / 18303, 6914 / 12472 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0018 / 151 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 12m23s / 21s (n=34) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 32 / 13 / 0 / 5 / 4 / 0 |
| verify: candidates tested / passers / partials | 23833 / 22 / 0 |
| grace wait total / localisation missed / generic steps | 8s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 6/12 | 50.0% | ██████████ |
| 3 | 9/12 | 75.0% | ███████████████ |
| 4 | 11/12 | 91.7% | ██████████████████ |
| 5 | 12/12 | 100.0% | ████████████████████ |
| 6 | 12/12 | 100.0% | ████████████████████ |
| 7 | 12/12 | 100.0% | ████████████████████ |
| 8 | 12/12 | 100.0% | ████████████████████ |
| 9 | 12/12 | 100.0% | ████████████████████ |
| 10 | 12/12 | 100.0% | ████████████████████ |
| 11 | 12/12 | 100.0% | ████████████████████ |
| 12 | 12/12 | 100.0% | ████████████████████ |
| 13 | 12/12 | 100.0% | ████████████████████ |
| 14 | 12/12 | 100.0% | ████████████████████ |
| 15 | 12/12 | 100.0% | ████████████████████ |
| 16 | 12/12 | 100.0% | ████████████████████ |
| 17 | 12/12 | 100.0% | ████████████████████ |
| 18 | 12/12 | 100.0% | ████████████████████ |
| 19 | 12/12 | 100.0% | ████████████████████ |
| 20 | 12/12 | 100.0% | ████████████████████ |
| 21 | 12/12 | 100.0% | ████████████████████ |
| 22 | 12/12 | 100.0% | ████████████████████ |
| 23 | 12/12 | 100.0% | ████████████████████ |
| 24 | 12/12 | 100.0% | ████████████████████ |
| 25 | 12/12 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 4235 (n=12) | ████████████████████ |
| 2 | 815 (n=12) | ████ |
| 3 | 1961 (n=6) | █████████ |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 46302 (n=12) | ████████████████████ |
| 2 | 24490 (n=12) | ███████████ |
| 3 | 34837 (n=6) | ███████████████ |
| 4 | 2761 (n=3) | █ |
| 5 | 2421 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 50536 (n=12) | ████████████████████ |
| 2 | 25305 (n=12) | ██████████ |
| 3 | 36797 (n=6) | ███████████████ |
| 4 | 2761 (n=3) | █ |
| 5 | 2421 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 12 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| account | pass | 5 | 0 | 3m | $0.0172 |
| calendar_utils | pass | 3 | 0 | 1m17s | $0.0009 |
| events | pass | 2 | 0 | 39s | $0.0008 |
| grades | pass | 2 | 0 | 31s | $0.0011 |
| inventory | pass | 3 | 0 | 1m4s | $0.0010 |
| profiles | pass | 2 | 0 | 14s | $0.0011 |
| shipping | pass | 3 | 0 | 1m29s | $0.0023 |
| stats | pass | 4 | 0 | 58s | $0.0007 |
| table | pass | 4 | 0 | 2m24s | $0.0224 |
| tagcloud | pass | 2 | 0 | 5s | $0.0006 |
| textstats | pass | 2 | 0 | 25s | $0.0010 |
| units | pass | 2 | 0 | 21s | $0.0008 |

