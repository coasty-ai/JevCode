# JevCode bench 20260922-020658-7ab68d

Generated 2026-09-22T02:21:29.091Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.2500; spent generator $0.1240 + Jev $0.0000 = $0.1240. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 6 | 6 | 4 | 4/6 (n=6) 66.7% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 4/6 (n=6) 66.7% |
| steps-to-solve mean (n passed) | 16 (n=4) |
| steps-to-solve median | 13 |
| steps used mean (n runs) | 19 (n=6) |
| steps used median | 15 |
| read actions total / mean per run | 20 / 3.33 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 7 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 123 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 7675 (n=114) |
| mean Jev tokens/step (steps) | 0 (n=114) |
| mean tokens/step, generator+Jev (steps) | 7675 (n=114) |
| wall time mean | 4m8s |
| wall time median | 3m2s |
| cost generator / Jev / total | $0.1240 / $0.0000 / $0.1240 |
| $ per solved task | $0.0310 |
| pass rate Wilson 95% | [30.0%, 90.3%] |
| generator.jsonl calls / samples / valid | 123 / 0 / 98 |
| generator malformed / length / dropped (timeouts) | 9 / 0 / 16 (16) |
| generator latency p50 / p90 ms, valid p50 / p90 | 8073 / 30001, 7207 / 21050 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0147 / 5256 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
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
| 11 | 1/6 | 16.7% | ███ |
| 12 | 1/6 | 16.7% | ███ |
| 13 | 2/6 | 33.3% | ███████ |
| 14 | 2/6 | 33.3% | ███████ |
| 15 | 3/6 | 50.0% | ██████████ |
| 16 | 3/6 | 50.0% | ██████████ |
| 17 | 3/6 | 50.0% | ██████████ |
| 18 | 3/6 | 50.0% | ██████████ |
| 19 | 3/6 | 50.0% | ██████████ |
| 20 | 3/6 | 50.0% | ██████████ |
| 21 | 3/6 | 50.0% | ██████████ |
| 22 | 3/6 | 50.0% | ██████████ |
| 23 | 3/6 | 50.0% | ██████████ |
| 24 | 3/6 | 50.0% | ██████████ |
| 25 | 4/6 | 66.7% | █████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 5846 (n=6) | ███████████ |
| 2 | 6947 (n=6) | ██████████████ |
| 3 | 6061 (n=6) | ████████████ |
| 4 | 10072 (n=6) | ████████████████████ |
| 5 | 7795 (n=6) | ███████████████ |
| 6 | 6775 (n=6) | █████████████ |
| 7 | 8023 (n=6) | ████████████████ |
| 8 | 7134 (n=6) | ██████████████ |
| 9 | 7138 (n=6) | ██████████████ |
| 10 | 7272 (n=6) | ██████████████ |
| 11 | 8414 (n=6) | █████████████████ |
| 12 | 7951 (n=5) | ████████████████ |
| 13 | 9551 (n=5) | ███████████████████ |
| 14 | 7908 (n=4) | ████████████████ |
| 15 | 8022 (n=4) | ████████████████ |
| 16 | 7689 (n=3) | ███████████████ |
| 17 | 7604 (n=3) | ███████████████ |
| 18 | 7784 (n=3) | ███████████████ |
| 19 | 7709 (n=3) | ███████████████ |
| 20 | 7767 (n=3) | ███████████████ |
| 21 | 6966 (n=3) | ██████████████ |
| 22 | 7418 (n=3) | ███████████████ |
| 23 | 10197 (n=3) | ████████████████████ |
| 24 | 7633 (n=3) | ███████████████ |
| 25 | 7525 (n=3) | ███████████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=6) |  |
| 2 | 0 (n=6) |  |
| 3 | 0 (n=6) |  |
| 4 | 0 (n=6) |  |
| 5 | 0 (n=6) |  |
| 6 | 0 (n=6) |  |
| 7 | 0 (n=6) |  |
| 8 | 0 (n=6) |  |
| 9 | 0 (n=6) |  |
| 10 | 0 (n=6) |  |
| 11 | 0 (n=6) |  |
| 12 | 0 (n=5) |  |
| 13 | 0 (n=5) |  |
| 14 | 0 (n=4) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=3) |  |
| 17 | 0 (n=3) |  |
| 18 | 0 (n=3) |  |
| 19 | 0 (n=3) |  |
| 20 | 0 (n=3) |  |
| 21 | 0 (n=3) |  |
| 22 | 0 (n=3) |  |
| 23 | 0 (n=3) |  |
| 24 | 0 (n=3) |  |
| 25 | 0 (n=3) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 5846 (n=6) | ███████████ |
| 2 | 6947 (n=6) | ██████████████ |
| 3 | 6061 (n=6) | ████████████ |
| 4 | 10072 (n=6) | ████████████████████ |
| 5 | 7795 (n=6) | ███████████████ |
| 6 | 6775 (n=6) | █████████████ |
| 7 | 8023 (n=6) | ████████████████ |
| 8 | 7134 (n=6) | ██████████████ |
| 9 | 7138 (n=6) | ██████████████ |
| 10 | 7272 (n=6) | ██████████████ |
| 11 | 8414 (n=6) | █████████████████ |
| 12 | 7951 (n=5) | ████████████████ |
| 13 | 9551 (n=5) | ███████████████████ |
| 14 | 7908 (n=4) | ████████████████ |
| 15 | 8022 (n=4) | ████████████████ |
| 16 | 7689 (n=3) | ███████████████ |
| 17 | 7604 (n=3) | ███████████████ |
| 18 | 7784 (n=3) | ███████████████ |
| 19 | 7709 (n=3) | ███████████████ |
| 20 | 7767 (n=3) | ███████████████ |
| 21 | 6966 (n=3) | ██████████████ |
| 22 | 7418 (n=3) | ███████████████ |
| 23 | 10197 (n=3) | ████████████████████ |
| 24 | 7633 (n=3) | ███████████████ |
| 25 | 7525 (n=3) | ███████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| error | 1 | ███████ |
| generator_done | 2 | █████████████ |
| max_steps | 3 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 25 | 5 | 7m18s | $0.0238 |
| django__django-15315 | pass | 11 | 2 | 3m2s | $0.0096 |
| sympy__sympy-11618 | pass | 25 | 2 | 5m26s | $0.0298 |
| sympy__sympy-15345 | pass | 13 | 6 | 1m52s | $0.0133 |
| sympy__sympy-17139 | pass | 15 | 2 | 2m41s | $0.0177 |
| sympy__sympy-19954 | fail | 25 | 3 | 4m27s | $0.0297 |

