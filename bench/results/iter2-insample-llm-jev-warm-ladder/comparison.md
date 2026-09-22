# JevCode bench 20260922-180021-ba7a5f

Generated 2026-09-22T18:07:23.303Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1000; spent generator $0.0165 + Jev $0.0097 = $0.0263. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 3.08 (n=12) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 3.08 (n=12) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 1 / 1 |
| Jev requests / questions | 205 / 345 |
| generator calls (jev-only asserts 0) | 51 |
| Jev latency p50 / p95 ms (n) | 141.43 / 269.10 (n=272) |
| mean generator tokens/step (steps) | 3304 (n=37) |
| mean Jev tokens/step (steps) | 6785 (n=37) |
| mean tokens/step, generator+Jev (steps) | 10089 (n=37) |
| wall time mean | 1m31s |
| wall time median | 40s |
| cost generator / Jev / total | $0.0165 / $0.0097 / $0.0263 |
| $ per solved task | $0.0022 |
| pass rate Wilson 95% | [75.7%, 100.0%] |
| generator.jsonl calls / samples / valid | 51 / 51 / 43 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 8 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 7572 / 16456, 7102 / 14891 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0011 / 266 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 18m10s / 29s (n=37) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 51 / 28 / 0 / 0 / 5 / 0 |
| verify: candidates tested / passers / partials | 33337 / 24 / 1 |
| grace wait total / localisation missed / generic steps | 6s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 8/12 | 66.7% | █████████████ |
| 3 | 9/12 | 75.0% | ███████████████ |
| 4 | 10/12 | 83.3% | █████████████████ |
| 5 | 11/12 | 91.7% | ██████████████████ |
| 6 | 11/12 | 91.7% | ██████████████████ |
| 7 | 11/12 | 91.7% | ██████████████████ |
| 8 | 11/12 | 91.7% | ██████████████████ |
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
| 1 | 5514 (n=12) | ████████████████████ |
| 2 | 1257 (n=12) | █████ |
| 3 | 5086 (n=4) | ██████████████████ |
| 4 | 1605 (n=3) | ██████ |
| 5 | 3587 (n=2) | █████████████ |
| 6 | 3282 (n=1) | ████████████ |
| 7 | 0 (n=1) |  |
| 8 | 5400 (n=1) | ████████████████████ |
| 9 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 12471 (n=12) | █████████████████ |
| 2 | 3118 (n=12) | ████ |
| 3 | 7332 (n=4) | ██████████ |
| 4 | 2341 (n=3) | ███ |
| 5 | 1262 (n=2) | ██ |
| 6 | 14450 (n=1) | ████████████████████ |
| 7 | 0 (n=1) |  |
| 8 | 7598 (n=1) | ███████████ |
| 9 | 3054 (n=1) | ████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 17985 (n=12) | ████████████████████ |
| 2 | 4374 (n=12) | █████ |
| 3 | 12418 (n=4) | ██████████████ |
| 4 | 3946 (n=3) | ████ |
| 5 | 4848 (n=2) | █████ |
| 6 | 17732 (n=1) | ████████████████████ |
| 7 | 0 (n=1) |  |
| 8 | 12998 (n=1) | ██████████████ |
| 9 | 3054 (n=1) | ███ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 12 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| account | pass | 9 | 0 | 7m1s | $0.0063 |
| calendar_utils | pass | 5 | 0 | 2m21s | $0.0033 |
| events | pass | 2 | 0 | 40s | $0.0011 |
| grades | pass | 2 | 0 | 22s | $0.0011 |
| inventory | pass | 2 | 0 | 55s | $0.0010 |
| profiles | pass | 2 | 0 | 20s | $0.0010 |
| shipping | pass | 2 | 0 | 1m11s | $0.0013 |
| stats | pass | 2 | 0 | 17s | $0.0011 |
| table | pass | 4 | 0 | 3m1s | $0.0052 |
| tagcloud | pass | 2 | 0 | 10s | $0.0006 |
| textstats | pass | 2 | 0 | 21s | $0.0011 |
| units | pass | 3 | 0 | 1m36s | $0.0031 |

