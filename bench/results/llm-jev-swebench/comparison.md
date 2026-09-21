# JevCode bench 20260921-231705-17879b

Generated 2026-09-21T23:33:43.791Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2500; spent generator $0.0514 + Jev $0.1389 = $0.1903. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 0 | 0/6 (n=6) 0.0% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 0/6 (n=6) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 6 (n=6) |
| steps used median | 5 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 7 / 5 |
| Jev requests / questions | 405 / 23396 |
| generator calls (jev-only asserts 0) | 81 |
| Jev latency p50 / p95 ms (n) | 288.38 / 833.19 (n=405) |
| mean generator tokens/step (steps) | 2088 (n=36) |
| mean Jev tokens/step (steps) | 106219 (n=36) |
| mean tokens/step, generator+Jev (steps) | 108307 (n=36) |
| wall time mean | 5m13s |
| wall time median | 2m37s |
| cost generator / Jev / total | $0.0514 / $0.1389 / $0.1903 |
| $ per solved task | null |
| pass rate Wilson 95% | [0.0%, 39.0%] |
| generator.jsonl calls / samples / valid | 18 / 18 / 13 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 5 (5) |
| generator latency p50 / p90 ms, valid p50 / p90 | 21361 / 31746, 20173 / 22875 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0035 / 3349 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 26m25s / 44s (n=36) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 0/6 | 0.0% |  |
| 4 | 0/6 | 0.0% |  |
| 5 | 0/6 | 0.0% |  |
| 6 | 0/6 | 0.0% |  |
| 7 | 0/6 | 0.0% |  |
| 8 | 0/6 | 0.0% |  |
| 9 | 0/6 | 0.0% |  |
| 10 | 0/6 | 0.0% |  |
| 11 | 0/6 | 0.0% |  |
| 12 | 0/6 | 0.0% |  |
| 13 | 0/6 | 0.0% |  |
| 14 | 0/6 | 0.0% |  |
| 15 | 0/6 | 0.0% |  |
| 16 | 0/6 | 0.0% |  |
| 17 | 0/6 | 0.0% |  |
| 18 | 0/6 | 0.0% |  |
| 19 | 0/6 | 0.0% |  |
| 20 | 0/6 | 0.0% |  |
| 21 | 0/6 | 0.0% |  |
| 22 | 0/6 | 0.0% |  |
| 23 | 0/6 | 0.0% |  |
| 24 | 0/6 | 0.0% |  |
| 25 | 0/6 | 0.0% |  |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 12525 (n=6) | ████████████████████ |
| 2 | 0 (n=6) |  |
| 3 | 0 (n=5) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=2) |  |
| 9 | 0 (n=2) |  |
| 10 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 212016 (n=6) | ████████████████████ |
| 2 | 212649 (n=6) | ████████████████████ |
| 3 | 12531 (n=5) | █ |
| 4 | 5575 (n=4) | █ |
| 5 | 160330 (n=4) | ███████████████ |
| 6 | 92718 (n=3) | █████████ |
| 7 | 34540 (n=3) | ███ |
| 8 | 80012 (n=2) | ████████ |
| 9 | 3912 (n=2) |  |
| 10 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 224541 (n=6) | ████████████████████ |
| 2 | 212649 (n=6) | ███████████████████ |
| 3 | 12531 (n=5) | █ |
| 4 | 5575 (n=4) |  |
| 5 | 160330 (n=4) | ██████████████ |
| 6 | 92718 (n=3) | ████████ |
| 7 | 34540 (n=3) | ███ |
| 8 | 80012 (n=2) | ███████ |
| 9 | 3912 (n=2) |  |
| 10 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 1 | ███████ |
| error | 3 | ████████████████████ |
| replan_stop | 2 | █████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 10 | 0 | 3m46s | $0.0312 |
| django__django-15315 | fail | 3 | 0 | 16s | $0.0000 |
| sympy__sympy-11618 | fail | 9 | 0 | 6m31s | $0.0837 |
| sympy__sympy-15345 | fail | 2 | 0 | 2m37s | $0.0041 |
| sympy__sympy-17139 | fail | 5 | 0 | 16m19s | $0.0576 |
| sympy__sympy-19954 | fail | 7 | 0 | 1m53s | $0.0137 |

