# JevCode bench 20260922-014620-81f53b

Generated 2026-09-22T01:55:03.034Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2500; spent generator $0.0315 + Jev $0.0366 = $0.0681. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 6 | 6/6 (n=6) 100.0% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 6/6 (n=6) 100.0% |
| steps-to-solve mean (n passed) | 4.17 (n=6) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 4.17 (n=6) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 3 / 2 |
| Jev requests / questions | 174 / 7129 |
| generator calls (jev-only asserts 0) | 45 |
| Jev latency p50 / p95 ms (n) | 173.93 / 431.06 (n=174) |
| mean generator tokens/step (steps) | 8995 (n=25) |
| mean Jev tokens/step (steps) | 43086 (n=25) |
| mean tokens/step, generator+Jev (steps) | 52081 (n=25) |
| wall time mean | 2m1s |
| wall time median | 2m13s |
| cost generator / Jev / total | $0.0315 / $0.0366 / $0.0681 |
| $ per solved task | $0.0113 |
| pass rate Wilson 95% | [61.0%, 100.0%] |
| generator.jsonl calls / samples / valid | 45 / 45 / 31 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 14 (12) |
| generator latency p50 / p90 ms, valid p50 / p90 | 12315 / 30005, 9920 / 13711 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0098 / 5364 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 10m15s / 24s (n=25) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 45 / 27 / 0 / 12 / 2 / 0 |
| verify: candidates tested / passers / partials | 989 / 15 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 3/6 | 50.0% | ██████████ |
| 3 | 4/6 | 66.7% | █████████████ |
| 4 | 4/6 | 66.7% | █████████████ |
| 5 | 4/6 | 66.7% | █████████████ |
| 6 | 5/6 | 83.3% | █████████████████ |
| 7 | 5/6 | 83.3% | █████████████████ |
| 8 | 5/6 | 83.3% | █████████████████ |
| 9 | 5/6 | 83.3% | █████████████████ |
| 10 | 6/6 | 100.0% | ████████████████████ |
| 11 | 6/6 | 100.0% | ████████████████████ |
| 12 | 6/6 | 100.0% | ████████████████████ |
| 13 | 6/6 | 100.0% | ████████████████████ |
| 14 | 6/6 | 100.0% | ████████████████████ |
| 15 | 6/6 | 100.0% | ████████████████████ |
| 16 | 6/6 | 100.0% | ████████████████████ |
| 17 | 6/6 | 100.0% | ████████████████████ |
| 18 | 6/6 | 100.0% | ████████████████████ |
| 19 | 6/6 | 100.0% | ████████████████████ |
| 20 | 6/6 | 100.0% | ████████████████████ |
| 21 | 6/6 | 100.0% | ████████████████████ |
| 22 | 6/6 | 100.0% | ████████████████████ |
| 23 | 6/6 | 100.0% | ████████████████████ |
| 24 | 6/6 | 100.0% | ████████████████████ |
| 25 | 6/6 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 20575 (n=6) | █████████████████ |
| 2 | 4052 (n=6) | ███ |
| 3 | 9661 (n=3) | ████████ |
| 4 | 0 (n=2) |  |
| 5 | 24066 (n=2) | ████████████████████ |
| 6 | 0 (n=2) |  |
| 7 | 0 (n=1) |  |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 124342 (n=6) | ████████████████████ |
| 2 | 3962 (n=6) | █ |
| 3 | 26610 (n=3) | ████ |
| 4 | 6046 (n=2) | █ |
| 5 | 86241 (n=2) | ██████████████ |
| 6 | 5824 (n=2) | █ |
| 7 | 7235 (n=1) | █ |
| 8 | 10566 (n=1) | ██ |
| 9 | 6743 (n=1) | █ |
| 10 | 6743 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 144916 (n=6) | ████████████████████ |
| 2 | 8015 (n=6) | █ |
| 3 | 36271 (n=3) | █████ |
| 4 | 6046 (n=2) | █ |
| 5 | 110307 (n=2) | ███████████████ |
| 6 | 5824 (n=2) | █ |
| 7 | 7235 (n=1) | █ |
| 8 | 10566 (n=1) | █ |
| 9 | 6743 (n=1) | █ |
| 10 | 6743 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |
| replan_stop | 1 | ████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | pass | 6 | 0 | 1m56s | $0.0224 |
| django__django-15315 | pass | 2 | 0 | 23s | $0.0049 |
| sympy__sympy-11618 | pass | 10 | 0 | 2m13s | $0.0133 |
| sympy__sympy-15345 | pass | 3 | 0 | 3m2s | $0.0127 |
| sympy__sympy-17139 | pass | 2 | 0 | 2m15s | $0.0064 |
| sympy__sympy-19954 | pass | 2 | 0 | 2m17s | $0.0083 |

