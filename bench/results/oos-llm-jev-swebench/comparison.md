# JevCode bench 20260922-063148-d70556

Generated 2026-09-22T06:57:28.028Z. Generator model `z-ai/glm-5.3-flash`. 4 task records, suites: swebench.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 25m | $0.2500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.2500; spent generator $0.0808 + Jev $0.3077 = $0.3885. Bench cap fired: no. Pairs not run: 0.

## SWE-bench Verified (local subset)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 4 | 4 | 0 | 0/4 (n=4) 0.0% | — | — | — | — |

### Paired comparison (n = 4 tasks evaluated in every condition)

Paired tasks: `sympy__sympy-13798`, `sympy__sympy-16792`, `sympy__sympy-20428`, `sympy__sympy-22080`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 0/4 (n=4) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 12.75 (n=4) |
| steps used median | 10 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 14 / 12 |
| Jev requests / questions | 744 / 51290 |
| generator calls (jev-only asserts 0) | 130 |
| Jev latency p50 / p95 ms (n) | 253.65 / 541.91 (n=744) |
| mean generator tokens/step (steps) | 11360 (n=51) |
| mean Jev tokens/step (steps) | 164274 (n=51) |
| mean tokens/step, generator+Jev (steps) | 175634 (n=51) |
| wall time mean | 12m22s |
| wall time median | 5m22s |
| cost generator / Jev / total | $0.0808 / $0.3077 / $0.3885 |
| $ per solved task | null |
| pass rate Wilson 95% | [0.0%, 49.0%] |
| generator.jsonl calls / samples / valid | 130 / 130 / 58 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 72 (51) |
| generator latency p50 / p90 ms, valid p50 / p90 | 17346 / 30006, 10531 / 18244 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0420 / 20787 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 44m36s / 52s (n=51) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 124 / 16 / 0 / 51 / 1 / 0 |
| verify: candidates tested / passers / partials | 2228 / 1 / 0 |
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
| 1 | 31805 (n=4) | █████████████████ |
| 2 | 27742 (n=4) | ███████████████ |
| 3 | 13983 (n=4) | ████████ |
| 4 | 7888 (n=4) | ████ |
| 5 | 17748 (n=3) | ██████████ |
| 6 | 11161 (n=3) | ██████ |
| 7 | 0 (n=3) |  |
| 8 | 9062 (n=3) | █████ |
| 9 | 0 (n=3) |  |
| 10 | 12900 (n=3) | ███████ |
| 11 | 14676 (n=2) | ████████ |
| 12 | 14901 (n=2) | ████████ |
| 13 | 2328 (n=2) | █ |
| 14 | 0 (n=2) |  |
| 15 | 0 (n=2) |  |
| 16 | 0 (n=2) |  |
| 17 | 0 (n=2) |  |
| 18 | 0 (n=2) |  |
| 19 | 37283 (n=1) | ████████████████████ |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 212881 (n=4) | █████████ |
| 2 | 465103 (n=4) | ████████████████████ |
| 3 | 92787 (n=4) | ████ |
| 4 | 329363 (n=4) | ██████████████ |
| 5 | 235185 (n=3) | ██████████ |
| 6 | 64321 (n=3) | ███ |
| 7 | 9033 (n=3) |  |
| 8 | 145190 (n=3) | ██████ |
| 9 | 6928 (n=3) |  |
| 10 | 164857 (n=3) | ███████ |
| 11 | 157852 (n=2) | ███████ |
| 12 | 365369 (n=2) | ████████████████ |
| 13 | 182343 (n=2) | ████████ |
| 14 | 7271 (n=2) |  |
| 15 | 6975 (n=2) |  |
| 16 | 205325 (n=2) | █████████ |
| 17 | 6538 (n=2) |  |
| 18 | 6538 (n=2) |  |
| 19 | 224480 (n=1) | ██████████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 244686 (n=4) | ██████████ |
| 2 | 492845 (n=4) | ████████████████████ |
| 3 | 106770 (n=4) | ████ |
| 4 | 337250 (n=4) | ██████████████ |
| 5 | 252933 (n=3) | ██████████ |
| 6 | 75483 (n=3) | ███ |
| 7 | 9033 (n=3) |  |
| 8 | 154253 (n=3) | ██████ |
| 9 | 6928 (n=3) |  |
| 10 | 177756 (n=3) | ███████ |
| 11 | 172528 (n=2) | ███████ |
| 12 | 380270 (n=2) | ███████████████ |
| 13 | 184671 (n=2) | ███████ |
| 14 | 7271 (n=2) |  |
| 15 | 6975 (n=2) |  |
| 16 | 205325 (n=2) | ████████ |
| 17 | 6538 (n=2) |  |
| 18 | 6538 (n=2) |  |
| 19 | 261763 (n=1) | ███████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 1 | ████████████████████ |
| max_replans | 1 | ████████████████████ |
| replan_stop | 1 | ████████████████████ |
| wall_time | 1 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-13798 | fail | 18 | 0 | 5m22s | $0.0238 |
| sympy__sympy-16792 | fail | 19 | 0 | 25m | $0.2178 |
| sympy__sympy-20428 | fail | 4 | 0 | 4m33s | $0.0215 |
| sympy__sympy-22080 | fail | 10 | 0 | 14m32s | $0.1254 |

