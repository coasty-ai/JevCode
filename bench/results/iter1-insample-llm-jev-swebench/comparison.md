# JevCode bench 20260922-124000-be188b

Generated 2026-09-22T12:47:07.133Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2500; spent generator $0.0201 + Jev $0.0231 = $0.0432. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 5 | 5/6 (n=6) 83.3% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 5/6 (n=6) 83.3% |
| steps-to-solve mean (n passed) | 2 (n=5) |
| steps-to-solve median | 2 |
| steps used mean (n runs) | 2.83 (n=6) |
| steps used median | 2 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 2 / 1 |
| Jev requests / questions | 119 / 5710 |
| generator calls (jev-only asserts 0) | 32 |
| Jev latency p50 / p95 ms (n) | 197.39 / 431.49 (n=133) |
| mean generator tokens/step (steps) | 8174 (n=17) |
| mean Jev tokens/step (steps) | 40998 (n=17) |
| mean tokens/step, generator+Jev (steps) | 49172 (n=17) |
| wall time mean | 1m48s |
| wall time median | 2m9s |
| cost generator / Jev / total | $0.0201 / $0.0231 / $0.0432 |
| $ per solved task | $0.0086 |
| pass rate Wilson 95% | [43.6%, 97.0%] |
| generator.jsonl calls / samples / valid | 32 / 32 / 23 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 9 (5) |
| generator latency p50 / p90 ms, valid p50 / p90 | 13795 / 30003, 9994 / 24464 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0042 / 2303 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 8m54s / 31s (n=17) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 32 / 15 / 0 / 5 / 0 / 1 |
| verify: candidates tested / passers / partials | 1919 / 12 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 5/6 | 83.3% | █████████████████ |
| 3 | 5/6 | 83.3% | █████████████████ |
| 4 | 5/6 | 83.3% | █████████████████ |
| 5 | 5/6 | 83.3% | █████████████████ |
| 6 | 5/6 | 83.3% | █████████████████ |
| 7 | 5/6 | 83.3% | █████████████████ |
| 8 | 5/6 | 83.3% | █████████████████ |
| 9 | 5/6 | 83.3% | █████████████████ |
| 10 | 5/6 | 83.3% | █████████████████ |
| 11 | 5/6 | 83.3% | █████████████████ |
| 12 | 5/6 | 83.3% | █████████████████ |
| 13 | 5/6 | 83.3% | █████████████████ |
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

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 18434 (n=6) | █████████████ |
| 2 | 0 (n=6) |  |
| 3 | 0 (n=1) |  |
| 4 | 0 (n=1) |  |
| 5 | 28345 (n=1) | ████████████████████ |
| 6 | 0 (n=1) |  |
| 7 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 103986 (n=6) | ████████████████████ |
| 2 | 4009 (n=6) | █ |
| 3 | 2840 (n=1) | █ |
| 4 | 2901 (n=1) | █ |
| 5 | 37778 (n=1) | ███████ |
| 6 | 2741 (n=1) | █ |
| 7 | 2741 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 122420 (n=6) | ████████████████████ |
| 2 | 4009 (n=6) | █ |
| 3 | 2840 (n=1) |  |
| 4 | 2901 (n=1) |  |
| 5 | 66123 (n=1) | ███████████ |
| 6 | 2741 (n=1) |  |
| 7 | 2741 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 5 | ████████████████████ |
| replan_stop | 1 | ████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 7 | 0 | 2m9s | $0.0107 |
| django__django-15315 | pass | 2 | 0 | 35s | $0.0061 |
| sympy__sympy-11618 | pass | 2 | 0 | 59s | $0.0046 |
| sympy__sympy-15345 | pass | 2 | 0 | 2m36s | $0.0074 |
| sympy__sympy-17139 | pass | 2 | 0 | 2m21s | $0.0068 |
| sympy__sympy-19954 | pass | 2 | 0 | 2m11s | $0.0077 |

