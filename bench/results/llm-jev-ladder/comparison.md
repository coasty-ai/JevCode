# JevCode bench 20260921-231102-8cca85

Generated 2026-09-21T23:17:05.422Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1000; spent generator $0.0113 + Jev $0.0421 = $0.0534. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 3.17 (n=12) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 3.17 (n=12) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 230 / 5086 |
| generator calls (jev-only asserts 0) | 51 |
| Jev latency p50 / p95 ms (n) | 253.52 / 553.98 (n=230) |
| mean generator tokens/step (steps) | 1524 (n=38) |
| mean Jev tokens/step (steps) | 28971 (n=38) |
| mean tokens/step, generator+Jev (steps) | 30495 (n=38) |
| wall time mean | 1m16s |
| wall time median | 47s |
| cost generator / Jev / total | $0.0113 / $0.0421 / $0.0534 |
| $ per solved task | $0.0044 |
| pass rate Wilson 95% | [75.7%, 100.0%] |
| generator.jsonl calls / samples / valid | 30 / 30 / 13 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 17 (8) |
| generator latency p50 / p90 ms, valid p50 / p90 | 11313 / 20002, 8142 / 16812 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0028 / 0 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 15m8s / 23s (n=38) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 6/12 | 50.0% | ██████████ |
| 3 | 7/12 | 58.3% | ████████████ |
| 4 | 10/12 | 83.3% | █████████████████ |
| 5 | 11/12 | 91.7% | ██████████████████ |
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
| 1 | 4825 (n=12) | ████████████████████ |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=6) |  |
| 4 | 0 (n=5) |  |
| 5 | 0 (n=2) |  |
| 6 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 46947 (n=12) | ████████████████████ |
| 2 | 24402 (n=12) | ██████████ |
| 3 | 36304 (n=6) | ███████████████ |
| 4 | 3204 (n=5) | █ |
| 5 | 3867 (n=2) | ██ |
| 6 | 3137 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 51772 (n=12) | ████████████████████ |
| 2 | 24402 (n=12) | █████████ |
| 3 | 36304 (n=6) | ██████████████ |
| 4 | 3204 (n=5) | █ |
| 5 | 3867 (n=2) | █ |
| 6 | 3137 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 12 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| account | pass | 5 | 0 | 2m55s | $0.0171 |
| calendar_utils | pass | 6 | 0 | 2m43s | $0.0034 |
| events | pass | 2 | 0 | 47s | $0.0011 |
| grades | pass | 2 | 0 | 24s | $0.0011 |
| inventory | pass | 4 | 0 | 1m21s | $0.0019 |
| profiles | pass | 2 | 0 | 19s | $0.0007 |
| shipping | pass | 3 | 0 | 1m20s | $0.0016 |
| stats | pass | 2 | 0 | 20s | $0.0014 |
| table | pass | 4 | 0 | 3m6s | $0.0220 |
| tagcloud | pass | 2 | 0 | 11s | $0.0005 |
| textstats | pass | 4 | 0 | 1m29s | $0.0018 |
| units | pass | 2 | 0 | 21s | $0.0008 |

