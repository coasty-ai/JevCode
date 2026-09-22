# JevCode bench 20260922-155127-abb734

Generated 2026-09-22T16:17:19.066Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.0000, per-run cap $0.2500; spent generator $0.0660 + Jev $0.0241 = $0.0901. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 14 (n=2) |
| steps-to-solve median | 14 |
| steps used mean (n runs) | 16.50 (n=4) |
| steps used median | 14 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 19 / 15 |
| Jev requests / questions | 178 / 8953 |
| generator calls (jev-only asserts 0) | 73 |
| Jev latency p50 / p95 ms (n) | 135.48 / 387.93 (n=288) |
| mean generator tokens/step (steps) | 5366 (n=66) |
| mean Jev tokens/step (steps) | 10327 (n=66) |
| mean tokens/step, generator+Jev (steps) | 15693 (n=66) |
| wall time mean | 7m19s |
| wall time median | 4m41s |
| cost generator / Jev / total | $0.0660 / $0.0241 / $0.0901 |
| $ per solved task | $0.0450 |
| pass rate Wilson 95% | [15.0%, 85.0%] |
| generator.jsonl calls / samples / valid | 73 / 73 / 24 |
| generator malformed / length / dropped (timeouts) | 0 / 2 / 47 (35) |
| generator latency p50 / p90 ms, valid p50 / p90 | 38105 / 88170, 22965 / 76592 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0441 / 22030 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 27m16s / 24s (n=66) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 73 / 5 / 0 / 35 / 11 / 3 |
| verify: candidates tested / passers / partials | 1072 / 4 / 2 |
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
| 1 | 18721 (n=4) | ████████████████████ |
| 2 | 9742 (n=4) | ██████████ |
| 3 | 7194 (n=4) | ████████ |
| 4 | 8971 (n=4) | ██████████ |
| 5 | 8134 (n=4) | █████████ |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=4) |  |
| 8 | 4410 (n=4) | █████ |
| 9 | 12292 (n=4) | █████████████ |
| 10 | 9171 (n=4) | ██████████ |
| 11 | 0 (n=4) |  |
| 12 | 0 (n=4) |  |
| 13 | 0 (n=4) |  |
| 14 | 9906 (n=4) | ███████████ |
| 15 | 0 (n=2) |  |
| 16 | 0 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |
| 21 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 128312 (n=4) | ████████████████████ |
| 2 | 8404 (n=4) | █ |
| 3 | 3107 (n=4) |  |
| 4 | 3221 (n=4) | █ |
| 5 | 2788 (n=4) |  |
| 6 | 1858 (n=4) |  |
| 7 | 1039 (n=4) |  |
| 8 | 2208 (n=4) |  |
| 9 | 8799 (n=4) | █ |
| 10 | 1767 (n=4) |  |
| 11 | 964 (n=4) |  |
| 12 | 2490 (n=4) |  |
| 13 | 1756 (n=4) |  |
| 14 | 2269 (n=4) |  |
| 15 | 0 (n=2) |  |
| 16 | 1405 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=1) |  |
| 19 | 2852 (n=1) |  |
| 20 | 0 (n=1) |  |
| 21 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 147034 (n=4) | ████████████████████ |
| 2 | 18146 (n=4) | ██ |
| 3 | 10300 (n=4) | █ |
| 4 | 12191 (n=4) | ██ |
| 5 | 10922 (n=4) | █ |
| 6 | 1858 (n=4) |  |
| 7 | 1039 (n=4) |  |
| 8 | 6618 (n=4) | █ |
| 9 | 21091 (n=4) | ███ |
| 10 | 10938 (n=4) | █ |
| 11 | 964 (n=4) |  |
| 12 | 2490 (n=4) |  |
| 13 | 1756 (n=4) |  |
| 14 | 12175 (n=4) | ██ |
| 15 | 0 (n=2) |  |
| 16 | 1405 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=1) |  |
| 19 | 2852 (n=1) |  |
| 20 | 0 (n=1) |  |
| 21 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| max_replans | 1 | ███████ |
| replan_stop | 3 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| django__django-14725 | fail | 21 | 0 | 3m31s | $0.0102 |
| django__django-14787 | fail | 17 | 0 | 10m42s | $0.0400 |
| django__django-15375 | pass | 14 | 0 | 10m21s | $0.0309 |
| django__django-16100 | pass | 14 | 0 | 4m41s | $0.0089 |

