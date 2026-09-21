# JevCode bench 20260921-230708-2bc559

Generated 2026-09-21T23:11:02.326Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.8000, per-run cap $0.0600; spent generator $0.0068 + Jev $0.0199 = $0.0267. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 10 | 10 | 10 | 10/10 (n=10) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | llm-jev |
| --- | --- | --- |
| argument_swap | 1 | 1/1 100.0% |
| missing_condition | 2 | 2/2 100.0% |
| off_by_one | 2 | 2/2 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 2 | 2/2 100.0% |
| wrong_variable | 2 | 2/2 100.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `bitcount`, `bucketsort`, `detect_cycle`, `find_in_sorted`, `gcd`, `kth`, `lis`, `mergesort`, `shortest_path_length`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 10/10 (n=10) 100.0% |
| steps-to-solve mean (n passed) | 2.70 (n=10) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 2.70 (n=10) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 106 / 2445 |
| generator calls (jev-only asserts 0) | 29 |
| Jev latency p50 / p95 ms (n) | 230.09 / 545.06 (n=106) |
| mean generator tokens/step (steps) | 1608 (n=27) |
| mean Jev tokens/step (steps) | 19303 (n=27) |
| mean tokens/step, generator+Jev (steps) | 20911 (n=27) |
| wall time mean | 1m13s |
| wall time median | 33s |
| cost generator / Jev / total | $0.0068 / $0.0199 / $0.0267 |
| $ per solved task | $0.0027 |
| pass rate Wilson 95% | [72.2%, 100.0%] |
| generator.jsonl calls / samples / valid | 22 / 22 / 16 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 6 (6) |
| generator latency p50 / p90 ms, valid p50 / p90 | 11567 / 20002, 9508 / 13060 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0006 / 1252 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 12m8s / 26s (n=27) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 3/10 | 30.0% | ██████ |
| 3 | 10/10 | 100.0% | ████████████████████ |
| 4 | 10/10 | 100.0% | ████████████████████ |
| 5 | 10/10 | 100.0% | ████████████████████ |
| 6 | 10/10 | 100.0% | ████████████████████ |
| 7 | 10/10 | 100.0% | ████████████████████ |
| 8 | 10/10 | 100.0% | ████████████████████ |
| 9 | 10/10 | 100.0% | ████████████████████ |
| 10 | 10/10 | 100.0% | ████████████████████ |
| 11 | 10/10 | 100.0% | ████████████████████ |
| 12 | 10/10 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 4342 (n=10) | ████████████████████ |
| 2 | 0 (n=10) |  |
| 3 | 0 (n=7) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 36728 (n=10) | ████████████████████ |
| 2 | 13674 (n=10) | ███████ |
| 3 | 2452 (n=7) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 41070 (n=10) | ████████████████████ |
| 2 | 13674 (n=10) | ███████ |
| 3 | 2452 (n=7) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 10 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| bitcount | pass | 3 | 0 | 1m31s | $0.0011 |
| bucketsort | pass | 2 | 0 | 30s | $0.0004 |
| detect_cycle | pass | 3 | 0 | 33s | $0.0005 |
| find_in_sorted | pass | 2 | 0 | 26s | $0.0004 |
| gcd | pass | 3 | 0 | 15s | $0.0005 |
| kth | pass | 3 | 0 | 32s | $0.0007 |
| lis | pass | 3 | 0 | 1m33s | $0.0023 |
| mergesort | pass | 3 | 0 | 2m58s | $0.0140 |
| shortest_path_length | pass | 3 | 0 | 2m49s | $0.0055 |
| wrap | pass | 2 | 0 | 1m3s | $0.0014 |

