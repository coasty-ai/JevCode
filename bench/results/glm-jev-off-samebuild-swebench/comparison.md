# JevCode bench 20260922-043346-52a218

Generated 2026-09-22T05:44:13.790Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | not sent | none | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.2500; spent generator $0.3793 + Jev $0.0000 = $0.3793. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 6 | 6 | 2 | 2/6 (n=6) 33.3% | — | — | — | — |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `django__django-15128`, `django__django-15315`, `sympy__sympy-11618`, `sympy__sympy-15345`, `sympy__sympy-17139`, `sympy__sympy-19954`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 2/6 (n=6) 33.3% |
| steps-to-solve mean (n passed) | 19 (n=2) |
| steps-to-solve median | 19 |
| steps used mean (n runs) | 17.83 (n=6) |
| steps used median | 19 |
| read actions total / mean per run | 19 / 3.17 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 7 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 170 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 17635 (n=107) |
| mean Jev tokens/step (steps) | 0 (n=107) |
| mean tokens/step, generator+Jev (steps) | 17635 (n=107) |
| wall time mean | 21m13s |
| wall time median | 25m |
| cost generator / Jev / total | $0.3793 / $0.0000 / $0.3793 |
| $ per solved task | $0.1897 |
| pass rate Wilson 95% | [9.7%, 70.0%] |
| generator.jsonl calls / samples / valid | 170 / 0 / 86 |
| generator malformed / length / dropped (timeouts) | 84 / 6 / 0 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 45556 / 77984, 13091 / 65151 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0000 / 390580 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
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
| 19 | 2/6 | 33.3% | ███████ |
| 20 | 2/6 | 33.3% | ███████ |
| 21 | 2/6 | 33.3% | ███████ |
| 22 | 2/6 | 33.3% | ███████ |
| 23 | 2/6 | 33.3% | ███████ |
| 24 | 2/6 | 33.3% | ███████ |
| 25 | 2/6 | 33.3% | ███████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 11287 (n=6) | ████████ |
| 2 | 11768 (n=6) | ████████ |
| 3 | 9585 (n=6) | ███████ |
| 4 | 11275 (n=6) | ████████ |
| 5 | 13541 (n=6) | █████████ |
| 6 | 14802 (n=6) | ██████████ |
| 7 | 17429 (n=6) | ████████████ |
| 8 | 22523 (n=6) | ████████████████ |
| 9 | 15896 (n=6) | ███████████ |
| 10 | 14401 (n=6) | ██████████ |
| 11 | 20298 (n=6) | ██████████████ |
| 12 | 20945 (n=6) | ███████████████ |
| 13 | 24395 (n=6) | █████████████████ |
| 14 | 21443 (n=6) | ███████████████ |
| 15 | 24815 (n=5) | █████████████████ |
| 16 | 17000 (n=4) | ████████████ |
| 17 | 22006 (n=4) | ███████████████ |
| 18 | 21104 (n=4) | ███████████████ |
| 19 | 22599 (n=4) | ████████████████ |
| 20 | 28680 (n=1) | ████████████████████ |
| 21 | 25827 (n=1) | ██████████████████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
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
| 12 | 0 (n=6) |  |
| 13 | 0 (n=6) |  |
| 14 | 0 (n=6) |  |
| 15 | 0 (n=5) |  |
| 16 | 0 (n=4) |  |
| 17 | 0 (n=4) |  |
| 18 | 0 (n=4) |  |
| 19 | 0 (n=4) |  |
| 20 | 0 (n=1) |  |
| 21 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 11287 (n=6) | ████████ |
| 2 | 11768 (n=6) | ████████ |
| 3 | 9585 (n=6) | ███████ |
| 4 | 11275 (n=6) | ████████ |
| 5 | 13541 (n=6) | █████████ |
| 6 | 14802 (n=6) | ██████████ |
| 7 | 17429 (n=6) | ████████████ |
| 8 | 22523 (n=6) | ████████████████ |
| 9 | 15896 (n=6) | ███████████ |
| 10 | 14401 (n=6) | ██████████ |
| 11 | 20298 (n=6) | ██████████████ |
| 12 | 20945 (n=6) | ███████████████ |
| 13 | 24395 (n=6) | █████████████████ |
| 14 | 21443 (n=6) | ███████████████ |
| 15 | 24815 (n=5) | █████████████████ |
| 16 | 17000 (n=4) | ████████████ |
| 17 | 22006 (n=4) | ███████████████ |
| 18 | 21104 (n=4) | ███████████████ |
| 19 | 22599 (n=4) | ████████████████ |
| 20 | 28680 (n=1) | ████████████████████ |
| 21 | 25827 (n=1) | ██████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| error | 1 | █████ |
| generator_done | 1 | █████ |
| wall_time | 4 | ████████████████████ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off wall | jev-off cost |
| --- | --- | --- | --- | --- | --- |
| django__django-15128 | fail | 21 | 6 | 25m | $0.0836 |
| django__django-15315 | pass | 19 | 2 | 25m | $0.0618 |
| sympy__sympy-11618 | fail | 14 | 1 | 14m18s | $0.0459 |
| sympy__sympy-15345 | fail | 19 | 6 | 25m | $0.0710 |
| sympy__sympy-17139 | pass | 19 | 2 | 13m1s | $0.0460 |
| sympy__sympy-19954 | fail | 15 | 2 | 25m | $0.0711 |

