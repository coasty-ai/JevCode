# JevCode bench 20260922-173145-925eca

Generated 2026-09-22T17:46:22.580Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2500; spent generator $0.0357 + Jev $0.0267 = $0.0624. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 4 (n=6) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 4 (n=6) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 3 / 2 |
| Jev requests / questions | 146 / 6377 |
| generator calls (jev-only asserts 0) | 41 |
| Jev latency p50 / p95 ms (n) | 149.79 / 410.23 (n=175) |
| mean generator tokens/step (steps) | 8261 (n=24) |
| mean Jev tokens/step (steps) | 32641 (n=24) |
| mean tokens/step, generator+Jev (steps) | 40902 (n=24) |
| wall time mean | 3m50s |
| wall time median | 2m56s |
| cost generator / Jev / total | $0.0357 / $0.0267 / $0.0624 |
| $ per solved task | $0.0104 |
| pass rate Wilson 95% | [61.0%, 100.0%] |
| generator.jsonl calls / samples / valid | 41 / 41 / 29 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 12 (8) |
| generator latency p50 / p90 ms, valid p50 / p90 | 16473 / 63329, 11098 / 24623 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0159 / 4037 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 18m43s / 46s (n=24) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 41 / 28 / 0 / 8 / 4 / 0 |
| verify: candidates tested / passers / partials | 558 / 11 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 3/6 | 50.0% | ██████████ |
| 3 | 3/6 | 50.0% | ██████████ |
| 4 | 4/6 | 66.7% | █████████████ |
| 5 | 4/6 | 66.7% | █████████████ |
| 6 | 5/6 | 83.3% | █████████████████ |
| 7 | 5/6 | 83.3% | █████████████████ |
| 8 | 6/6 | 100.0% | ████████████████████ |
| 9 | 6/6 | 100.0% | ████████████████████ |
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
| 1 | 19899 (n=6) | ████████████████████ |
| 2 | 3331 (n=6) | ███ |
| 3 | 8905 (n=3) | █████████ |
| 4 | 0 (n=3) |  |
| 5 | 16078 (n=2) | ████████████████ |
| 6 | 0 (n=2) |  |
| 7 | 0 (n=1) |  |
| 8 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 120464 (n=6) | ████████████████████ |
| 2 | 2856 (n=6) |  |
| 3 | 1239 (n=3) |  |
| 4 | 2704 (n=3) |  |
| 5 | 6673 (n=2) | █ |
| 6 | 5571 (n=2) | █ |
| 7 | 3580 (n=1) | █ |
| 8 | 3580 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 140363 (n=6) | ████████████████████ |
| 2 | 6187 (n=6) | █ |
| 3 | 10144 (n=3) | █ |
| 4 | 2704 (n=3) |  |
| 5 | 22751 (n=2) | ███ |
| 6 | 5571 (n=2) | █ |
| 7 | 3580 (n=1) | █ |
| 8 | 3580 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |
| replan_stop | 1 | ████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | pass | 6 | 0 | 5m27s | $0.0257 |
| django__django-15315 | pass | 8 | 0 | 36s | $0.0084 |
| sympy__sympy-11618 | pass | 4 | 0 | 3m | $0.0083 |
| sympy__sympy-15345 | pass | 2 | 0 | 51s | $0.0054 |
| sympy__sympy-17139 | pass | 2 | 0 | 10m9s | $0.0066 |
| sympy__sympy-19954 | pass | 2 | 0 | 2m56s | $0.0080 |

