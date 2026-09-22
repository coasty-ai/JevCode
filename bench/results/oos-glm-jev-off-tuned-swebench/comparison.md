# JevCode bench 20260922-071513-a0a12c

Generated 2026-09-22T07:25:56.729Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.2500; spent generator $0.1320 + Jev $0.0000 = $0.1320. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 4 | 4 | 0 | 0/4 (n=4) 0.0% | — | — | — | — |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `sympy__sympy-13798`, `sympy__sympy-16792`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 0/4 (n=4) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 25 (n=4) |
| steps used median | 25 |
| read actions total / mean per run | 20 / 5 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 7 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 108 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 8900 (n=100) |
| mean Jev tokens/step (steps) | 0 (n=100) |
| mean tokens/step, generator+Jev (steps) | 8900 (n=100) |
| wall time mean | 4m3s |
| wall time median | 3m41s |
| cost generator / Jev / total | $0.1320 / $0.0000 / $0.1320 |
| $ per solved task | null |
| pass rate Wilson 95% | [0.0%, 49.0%] |
| generator.jsonl calls / samples / valid | 106 / 0 / 97 |
| generator malformed / length / dropped (timeouts) | 6 / 0 / 3 (3) |
| generator latency p50 / p90 ms, valid p50 / p90 | 6634 / 19597, 6206 / 17111 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0038 / 15055 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
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

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 7985 (n=4) | ██████████ |
| 2 | 6667 (n=4) | █████████ |
| 3 | 6887 (n=4) | █████████ |
| 4 | 7058 (n=4) | █████████ |
| 5 | 7299 (n=4) | █████████ |
| 6 | 7707 (n=4) | ██████████ |
| 7 | 7812 (n=4) | ██████████ |
| 8 | 7751 (n=4) | ██████████ |
| 9 | 7805 (n=4) | ██████████ |
| 10 | 10033 (n=4) | █████████████ |
| 11 | 8352 (n=4) | ███████████ |
| 12 | 8425 (n=4) | ███████████ |
| 13 | 8521 (n=4) | ███████████ |
| 14 | 8723 (n=4) | ███████████ |
| 15 | 15594 (n=4) | ████████████████████ |
| 16 | 8728 (n=4) | ███████████ |
| 17 | 8858 (n=4) | ███████████ |
| 18 | 8702 (n=4) | ███████████ |
| 19 | 11193 (n=4) | ██████████████ |
| 20 | 11408 (n=4) | ███████████████ |
| 21 | 11761 (n=4) | ███████████████ |
| 22 | 8678 (n=4) | ███████████ |
| 23 | 8863 (n=4) | ███████████ |
| 24 | 8807 (n=4) | ███████████ |
| 25 | 8888 (n=4) | ███████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=4) |  |
| 2 | 0 (n=4) |  |
| 3 | 0 (n=4) |  |
| 4 | 0 (n=4) |  |
| 5 | 0 (n=4) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=4) |  |
| 8 | 0 (n=4) |  |
| 9 | 0 (n=4) |  |
| 10 | 0 (n=4) |  |
| 11 | 0 (n=4) |  |
| 12 | 0 (n=4) |  |
| 13 | 0 (n=4) |  |
| 14 | 0 (n=4) |  |
| 15 | 0 (n=4) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=4) |  |
| 19 | 0 (n=4) |  |
| 20 | 0 (n=4) |  |
| 21 | 0 (n=4) |  |
| 22 | 0 (n=4) |  |
| 23 | 0 (n=4) |  |
| 24 | 0 (n=4) |  |
| 25 | 0 (n=4) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 7985 (n=4) | ██████████ |
| 2 | 6667 (n=4) | █████████ |
| 3 | 6887 (n=4) | █████████ |
| 4 | 7058 (n=4) | █████████ |
| 5 | 7299 (n=4) | █████████ |
| 6 | 7707 (n=4) | ██████████ |
| 7 | 7812 (n=4) | ██████████ |
| 8 | 7751 (n=4) | ██████████ |
| 9 | 7805 (n=4) | ██████████ |
| 10 | 10033 (n=4) | █████████████ |
| 11 | 8352 (n=4) | ███████████ |
| 12 | 8425 (n=4) | ███████████ |
| 13 | 8521 (n=4) | ███████████ |
| 14 | 8723 (n=4) | ███████████ |
| 15 | 15594 (n=4) | ████████████████████ |
| 16 | 8728 (n=4) | ███████████ |
| 17 | 8858 (n=4) | ███████████ |
| 18 | 8702 (n=4) | ███████████ |
| 19 | 11193 (n=4) | ██████████████ |
| 20 | 11408 (n=4) | ███████████████ |
| 21 | 11761 (n=4) | ███████████████ |
| 22 | 8678 (n=4) | ███████████ |
| 23 | 8863 (n=4) | ███████████ |
| 24 | 8807 (n=4) | ███████████ |
| 25 | 8888 (n=4) | ███████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| max_steps | 4 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-13798 | fail | 25 | 3 | 4m18s | $0.0299 |
| sympy__sympy-16792 | fail | 25 | 6 | 3m41s | $0.0302 |
| sympy__sympy-20428 | fail | 25 | 5 | 3m5s | $0.0322 |
| sympy__sympy-22080 | fail | 25 | 6 | 5m10s | $0.0397 |

