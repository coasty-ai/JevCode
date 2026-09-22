# JevCode bench 20260922-120635-f27f08

Generated 2026-09-22T12:10:33.246Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2500; spent generator $0.0091 + Jev $0.0382 = $0.0473. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 4 | 4 | 0 | 0/4 (n=4) 0.0% | — | — | — | — |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `django__django-14725`, `django__django-14787`, `django__django-15375`, `django__django-16100`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 0/4 (n=4) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 5 (n=4) |
| steps used median | 5 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 4 / 0 |
| Jev requests / questions | 126 / 10506 |
| generator calls (jev-only asserts 0) | 28 |
| Jev latency p50 / p95 ms (n) | 207.27 / 461.84 (n=126) |
| mean generator tokens/step (steps) | 2099 (n=20) |
| mean Jev tokens/step (steps) | 56172 (n=20) |
| mean tokens/step, generator+Jev (steps) | 58271 (n=20) |
| wall time mean | 1m11s |
| wall time median | 1m1s |
| cost generator / Jev / total | $0.0091 / $0.0382 / $0.0473 |
| $ per solved task | null |
| pass rate Wilson 95% | [0.0%, 49.0%] |
| generator.jsonl calls / samples / valid | 28 / 28 / 0 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 28 (22) |
| generator latency p50 / p90 ms, valid p50 / p90 | 20003 / 30005, null / null |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0091 / 0 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 4m23s / 13s (n=20) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 28 / 0 / 0 / 22 / 0 / 0 |
| verify: candidates tested / passers / partials | 40 / 20 / 4 |
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
| 9 | 0/4 | 0.0% |  |
| 10 | 0/4 | 0.0% |  |
| 11 | 0/4 | 0.0% |  |
| 12 | 0/4 | 0.0% |  |
| 13 | 0/4 | 0.0% |  |
| 14 | 0/4 | 0.0% |  |
| 15 | 0/4 | 0.0% |  |
| 16 | 0/4 | 0.0% |  |
| 17 | 0/4 | 0.0% |  |
| 18 | 0/4 | 0.0% |  |
| 19 | 0/4 | 0.0% |  |
| 20 | 0/4 | 0.0% |  |
| 21 | 0/4 | 0.0% |  |
| 22 | 0/4 | 0.0% |  |
| 23 | 0/4 | 0.0% |  |
| 24 | 0/4 | 0.0% |  |
| 25 | 0/4 | 0.0% |  |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 10497 (n=4) | ████████████████████ |
| 2 | 0 (n=4) |  |
| 3 | 0 (n=4) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 274295 (n=4) | ████████████████████ |
| 2 | 0 (n=4) |  |
| 3 | 2088 (n=4) |  |
| 4 | 2208 (n=4) |  |
| 5 | 2269 (n=4) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 284792 (n=4) | ████████████████████ |
| 2 | 0 (n=4) |  |
| 3 | 2088 (n=4) |  |
| 4 | 2208 (n=4) |  |
| 5 | 2269 (n=4) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| replan_stop | 4 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 5 | 0 | 1m1s | $0.0129 |
| django__django-14787 | fail | 5 | 0 | 1m | $0.0097 |
| django__django-15375 | fail | 5 | 0 | 1m2s | $0.0137 |
| django__django-16100 | fail | 5 | 0 | 1m40s | $0.0110 |

