# JevCode bench 20260922-175505-c68f89

Generated 2026-09-22T18:00:20.963Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.8000, per-run cap $0.0600; spent generator $0.0202 + Jev $0.0119 = $0.0322. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 10 | 10 | 9 | 9/10 (n=10) 90.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | llm-jev |
| --- | --- | --- |
| argument_swap | 1 | 1/1 100.0% |
| missing_condition | 2 | 2/2 100.0% |
| off_by_one | 2 | 2/2 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 2 | 2/2 100.0% |
| wrong_variable | 2 | 1/2 50.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `bitcount`, `bucketsort`, `detect_cycle`, `find_in_sorted`, `gcd`, `kth`, `lis`, `mergesort`, `shortest_path_length`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 9/10 (n=10) 90.0% |
| steps-to-solve mean (n passed) | 3.22 (n=9) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 4.10 (n=10) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 4 / 4 |
| Jev requests / questions | 210 / 552 |
| generator calls (jev-only asserts 0) | 65 |
| Jev latency p50 / p95 ms (n) | 94.12 / 260.49 (n=414) |
| mean generator tokens/step (steps) | 3432 (n=41) |
| mean Jev tokens/step (steps) | 7403 (n=41) |
| mean tokens/step, generator+Jev (steps) | 10836 (n=41) |
| wall time mean | 1m27s |
| wall time median | 39s |
| cost generator / Jev / total | $0.0202 / $0.0119 / $0.0322 |
| $ per solved task | $0.0036 |
| pass rate Wilson 95% | [59.6%, 98.2%] |
| generator.jsonl calls / samples / valid | 65 / 65 / 37 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 28 (12) |
| generator latency p50 / p90 ms, valid p50 / p90 | 9595 / 30001, 9476 / 15881 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0079 / 1863 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 14m23s / 21s (n=41) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 65 / 26 / 0 / 12 / 15 / 1 |
| verify: candidates tested / passers / partials | 14707 / 17 / 0 |
| grace wait total / localisation missed / generic steps | 7s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 3/10 | 30.0% | ██████ |
| 3 | 7/10 | 70.0% | ██████████████ |
| 4 | 8/10 | 80.0% | ████████████████ |
| 5 | 8/10 | 80.0% | ████████████████ |
| 6 | 8/10 | 80.0% | ████████████████ |
| 7 | 9/10 | 90.0% | ██████████████████ |
| 8 | 9/10 | 90.0% | ██████████████████ |
| 9 | 9/10 | 90.0% | ██████████████████ |
| 10 | 9/10 | 90.0% | ██████████████████ |
| 11 | 9/10 | 90.0% | ██████████████████ |
| 12 | 9/10 | 90.0% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 3931 (n=10) | █████ |
| 2 | 2038 (n=10) | ███ |
| 3 | 2826 (n=7) | ████ |
| 4 | 0 (n=3) |  |
| 5 | 0 (n=2) |  |
| 6 | 10695 (n=2) | ██████████████ |
| 7 | 8188 (n=2) | ███████████ |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |
| 11 | 15037 (n=1) | ████████████████████ |
| 12 | 8446 (n=1) | ███████████ |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 13361 (n=10) | ████████████ |
| 2 | 8510 (n=10) | ████████ |
| 3 | 2978 (n=7) | ███ |
| 4 | 1532 (n=3) | █ |
| 5 | 0 (n=2) |  |
| 6 | 6445 (n=2) | ██████ |
| 7 | 2931 (n=2) | ███ |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |
| 11 | 22159 (n=1) | ████████████████████ |
| 12 | 18483 (n=1) | █████████████████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 17292 (n=10) | █████████ |
| 2 | 10548 (n=10) | ██████ |
| 3 | 5804 (n=7) | ███ |
| 4 | 1532 (n=3) | █ |
| 5 | 0 (n=2) |  |
| 6 | 17140 (n=2) | █████████ |
| 7 | 11119 (n=2) | ██████ |
| 8 | 0 (n=1) |  |
| 9 | 0 (n=1) |  |
| 10 | 0 (n=1) |  |
| 11 | 37196 (n=1) | ████████████████████ |
| 12 | 26929 (n=1) | ██████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 9 | ████████████████████ |
| max_steps | 1 | ██ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| bitcount | pass | 3 | 0 | 1m8s | $0.0010 |
| bucketsort | pass | 3 | 0 | 39s | $0.0006 |
| detect_cycle | pass | 3 | 0 | 27s | $0.0006 |
| find_in_sorted | pass | 2 | 0 | 19s | $0.0006 |
| gcd | pass | 2 | 0 | 14s | $0.0005 |
| kth | pass | 3 | 0 | 22s | $0.0006 |
| lis | pass | 7 | 0 | 4m39s | $0.0061 |
| mergesort | pass | 4 | 0 | 2m42s | $0.0045 |
| shortest_path_length | fail | 12 | 0 | 2m58s | $0.0163 |
| wrap | pass | 2 | 0 | 59s | $0.0014 |

