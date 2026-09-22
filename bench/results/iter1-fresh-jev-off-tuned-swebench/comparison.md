# JevCode bench 20260922-122011-715645

Generated 2026-09-22T12:27:01.256Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2500; spent generator $0.1082 + Jev $0.0000 = $0.1082. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 4 | 3 | 1 | 1/3 (n=3) 33.3% | `django__django-14787` | — | — | — |

### Paired comparison (n = 3 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-15375`, `django__django-16100`. Excluded for model drift: —. Incomplete pairs: `django__django-14787`.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 1/3 (n=3) 33.3% |
| steps-to-solve mean (n passed) | 12 (n=1) |
| steps-to-solve median | 12 |
| steps used mean (n runs) | 20.67 (n=3) |
| steps used median | 25 |
| read actions total / mean per run | 12 / 4 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 4 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 67 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 8019 (n=62) |
| mean Jev tokens/step (steps) | 0 (n=62) |
| mean tokens/step, generator+Jev (steps) | 8019 (n=62) |
| wall time mean | 3m2s |
| wall time median | 3m38s |
| cost generator / Jev / total | $0.0781 / $0.0000 / $0.0781 |
| $ per solved task | $0.0781 |
| pass rate Wilson 95% | [6.1%, 79.2%] |
| generator.jsonl calls / samples / valid | 66 / 0 / 57 |
| generator malformed / length / dropped (timeouts) | 4 / 0 / 5 (5) |
| generator latency p50 / p90 ms, valid p50 / p90 | 3476 / 22893, 3338 / 15902 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0063 / 12297 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
| --- | --- | --- | --- |
| 1 | 0/3 | 0.0% |  |
| 2 | 0/3 | 0.0% |  |
| 3 | 0/3 | 0.0% |  |
| 4 | 0/3 | 0.0% |  |
| 5 | 0/3 | 0.0% |  |
| 6 | 0/3 | 0.0% |  |
| 7 | 0/3 | 0.0% |  |
| 8 | 0/3 | 0.0% |  |
| 9 | 0/3 | 0.0% |  |
| 10 | 0/3 | 0.0% |  |
| 11 | 0/3 | 0.0% |  |
| 12 | 1/3 | 33.3% | ███████ |
| 13 | 1/3 | 33.3% | ███████ |
| 14 | 1/3 | 33.3% | ███████ |
| 15 | 1/3 | 33.3% | ███████ |
| 16 | 1/3 | 33.3% | ███████ |
| 17 | 1/3 | 33.3% | ███████ |
| 18 | 1/3 | 33.3% | ███████ |
| 19 | 1/3 | 33.3% | ███████ |
| 20 | 1/3 | 33.3% | ███████ |
| 21 | 1/3 | 33.3% | ███████ |
| 22 | 1/3 | 33.3% | ███████ |
| 23 | 1/3 | 33.3% | ███████ |
| 24 | 1/3 | 33.3% | ███████ |
| 25 | 1/3 | 33.3% | ███████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 5755 (n=3) | ████████ |
| 2 | 8409 (n=3) | ████████████ |
| 3 | 6310 (n=3) | █████████ |
| 4 | 8812 (n=3) | █████████████ |
| 5 | 6739 (n=3) | ██████████ |
| 6 | 6927 (n=3) | ██████████ |
| 7 | 7446 (n=3) | ███████████ |
| 8 | 7314 (n=3) | ███████████ |
| 9 | 7512 (n=3) | ███████████ |
| 10 | 7332 (n=3) | ███████████ |
| 11 | 7124 (n=3) | ██████████ |
| 12 | 7271 (n=3) | ███████████ |
| 13 | 7498 (n=2) | ███████████ |
| 14 | 7600 (n=2) | ███████████ |
| 15 | 7974 (n=2) | ████████████ |
| 16 | 7945 (n=2) | ████████████ |
| 17 | 13739 (n=2) | ████████████████████ |
| 18 | 8092 (n=2) | ████████████ |
| 19 | 8136 (n=2) | ████████████ |
| 20 | 13614 (n=2) | ████████████████████ |
| 21 | 7332 (n=2) | ███████████ |
| 22 | 7861 (n=2) | ███████████ |
| 23 | 7577 (n=2) | ███████████ |
| 24 | 12996 (n=2) | ███████████████████ |
| 25 | 7813 (n=2) | ███████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=3) |  |
| 2 | 0 (n=3) |  |
| 3 | 0 (n=3) |  |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=3) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=3) |  |
| 9 | 0 (n=3) |  |
| 10 | 0 (n=3) |  |
| 11 | 0 (n=3) |  |
| 12 | 0 (n=3) |  |
| 13 | 0 (n=2) |  |
| 14 | 0 (n=2) |  |
| 15 | 0 (n=2) |  |
| 16 | 0 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=2) |  |
| 19 | 0 (n=2) |  |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=2) |  |
| 22 | 0 (n=2) |  |
| 23 | 0 (n=2) |  |
| 24 | 0 (n=2) |  |
| 25 | 0 (n=2) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 5755 (n=3) | ████████ |
| 2 | 8409 (n=3) | ████████████ |
| 3 | 6310 (n=3) | █████████ |
| 4 | 8812 (n=3) | █████████████ |
| 5 | 6739 (n=3) | ██████████ |
| 6 | 6927 (n=3) | ██████████ |
| 7 | 7446 (n=3) | ███████████ |
| 8 | 7314 (n=3) | ███████████ |
| 9 | 7512 (n=3) | ███████████ |
| 10 | 7332 (n=3) | ███████████ |
| 11 | 7124 (n=3) | ██████████ |
| 12 | 7271 (n=3) | ███████████ |
| 13 | 7498 (n=2) | ███████████ |
| 14 | 7600 (n=2) | ███████████ |
| 15 | 7974 (n=2) | ████████████ |
| 16 | 7945 (n=2) | ████████████ |
| 17 | 13739 (n=2) | ████████████████████ |
| 18 | 8092 (n=2) | ████████████ |
| 19 | 8136 (n=2) | ████████████ |
| 20 | 13614 (n=2) | ████████████████████ |
| 21 | 7332 (n=2) | ███████████ |
| 22 | 7861 (n=2) | ███████████ |
| 23 | 7577 (n=2) | ███████████ |
| 24 | 12996 (n=2) | ███████████████████ |
| 25 | 7813 (n=2) | ███████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| generator_done | 1 | ███████ |
| max_steps | 3 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 25 | 7 | 4m32s | $0.0335 |
| django__django-15375 | fail | 25 | 2 | 3m38s | $0.0317 |
| django__django-16100 | pass | 12 | 3 | 57s | $0.0128 |

### Incomplete pairs

| task | condition | pass | evaluator | stop reason | reason |
| --- | --- | --- | --- | --- | --- |
| django__django-14787 | jev-off-tuned | null | invalid | max_steps | no test results and no sign the suite ran |

