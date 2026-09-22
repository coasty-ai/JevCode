# JevCode bench 20260922-164743-1e32c0

Generated 2026-09-22T17:06:04.361Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2500; spent generator $0.0453 + Jev $0.0252 = $0.0705. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 4 | 4 | 2 | 2/4 (n=4) 50.0% | — | — | — | — |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-14787`, `django__django-15375`, `django__django-16100`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 2/4 (n=4) 50.0% |
| steps-to-solve mean (n passed) | 11.50 (n=2) |
| steps-to-solve median | 9 |
| steps used mean (n runs) | 12.75 (n=4) |
| steps used median | 9 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 14 / 10 |
| Jev requests / questions | 190 / 6324 |
| generator calls (jev-only asserts 0) | 56 |
| Jev latency p50 / p95 ms (n) | 157.72 / 364.86 (n=238) |
| mean generator tokens/step (steps) | 4980 (n=51) |
| mean Jev tokens/step (steps) | 13828 (n=51) |
| mean tokens/step, generator+Jev (steps) | 18808 (n=51) |
| wall time mean | 6m14s |
| wall time median | 4m55s |
| cost generator / Jev / total | $0.0453 / $0.0252 / $0.0705 |
| $ per solved task | $0.0353 |
| pass rate Wilson 95% | [15.0%, 85.0%] |
| generator.jsonl calls / samples / valid | 56 / 56 / 34 |
| generator malformed / length / dropped (timeouts) | 0 / 2 / 20 (16) |
| generator latency p50 / p90 ms, valid p50 / p90 | 22710 / 47078, 16915 / 35994 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0177 / 23601 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 22m44s / 26s (n=51) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 56 / 9 / 0 / 16 / 4 / 3 |
| verify: candidates tested / passers / partials | 553 / 6 / 1 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/4 | 0.0% |  |
| 2 | 0/4 | 0.0% |  |
| 3 | 0/4 | 0.0% |  |
| 4 | 0/4 | 0.0% |  |
| 5 | 0/4 | 0.0% |  |
| 6 | 0/4 | 0.0% |  |
| 7 | 0/4 | 0.0% |  |
| 8 | 0/4 | 0.0% |  |
| 9 | 1/4 | 25.0% | █████ |
| 10 | 1/4 | 25.0% | █████ |
| 11 | 1/4 | 25.0% | █████ |
| 12 | 1/4 | 25.0% | █████ |
| 13 | 1/4 | 25.0% | █████ |
| 14 | 2/4 | 50.0% | ██████████ |
| 15 | 2/4 | 50.0% | ██████████ |
| 16 | 2/4 | 50.0% | ██████████ |
| 17 | 2/4 | 50.0% | ██████████ |
| 18 | 2/4 | 50.0% | ██████████ |
| 19 | 2/4 | 50.0% | ██████████ |
| 20 | 2/4 | 50.0% | ██████████ |
| 21 | 2/4 | 50.0% | ██████████ |
| 22 | 2/4 | 50.0% | ██████████ |
| 23 | 2/4 | 50.0% | ██████████ |
| 24 | 2/4 | 50.0% | ██████████ |
| 25 | 2/4 | 50.0% | ██████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 21125 (n=4) | ████████████████████ |
| 2 | 12515 (n=4) | ████████████ |
| 3 | 9437 (n=4) | █████████ |
| 4 | 6959 (n=4) | ███████ |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=4) |  |
| 8 | 3946 (n=4) | ████ |
| 9 | 6169 (n=3) | ██████ |
| 10 | 9771 (n=2) | █████████ |
| 11 | 0 (n=2) |  |
| 12 | 0 (n=2) |  |
| 13 | 0 (n=2) |  |
| 14 | 0 (n=2) |  |
| 15 | 0 (n=1) |  |
| 16 | 0 (n=1) |  |
| 17 | 0 (n=1) |  |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 120147 (n=4) | ████████████████████ |
| 2 | 3238 (n=4) | █ |
| 3 | 12836 (n=4) | ██ |
| 4 | 9501 (n=4) | ██ |
| 5 | 1954 (n=4) |  |
| 6 | 3374 (n=4) | █ |
| 7 | 2688 (n=4) |  |
| 8 | 7607 (n=4) | █ |
| 9 | 2225 (n=3) |  |
| 10 | 3159 (n=2) | █ |
| 11 | 2339 (n=2) |  |
| 12 | 3484 (n=2) | █ |
| 13 | 1918 (n=2) |  |
| 14 | 1930 (n=2) |  |
| 15 | 6733 (n=1) | █ |
| 16 | 3549 (n=1) | █ |
| 17 | 3549 (n=1) | █ |
| 18 | 6504 (n=1) | █ |
| 19 | 3593 (n=1) | █ |
| 20 | 3593 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 141272 (n=4) | ████████████████████ |
| 2 | 15753 (n=4) | ██ |
| 3 | 22273 (n=4) | ███ |
| 4 | 16459 (n=4) | ██ |
| 5 | 1954 (n=4) |  |
| 6 | 3374 (n=4) |  |
| 7 | 2688 (n=4) |  |
| 8 | 11552 (n=4) | ██ |
| 9 | 8394 (n=3) | █ |
| 10 | 12930 (n=2) | ██ |
| 11 | 2339 (n=2) |  |
| 12 | 3484 (n=2) |  |
| 13 | 1918 (n=2) |  |
| 14 | 1930 (n=2) |  |
| 15 | 6733 (n=1) | █ |
| 16 | 3549 (n=1) | █ |
| 17 | 3549 (n=1) | █ |
| 18 | 6504 (n=1) | █ |
| 19 | 3593 (n=1) | █ |
| 20 | 3593 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| max_replans | 1 | ███████ |
| replan_stop | 3 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 8 | 0 | 1m16s | $0.0084 |
| django__django-14787 | fail | 20 | 0 | 12m27s | $0.0370 |
| django__django-15375 | pass | 9 | 0 | 4m55s | $0.0170 |
| django__django-16100 | pass | 14 | 0 | 6m20s | $0.0081 |

