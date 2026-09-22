# JevCode bench 20260922-040020-7660c5

Generated 2026-09-22T04:11:04.516Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | jev-off | z-ai/glm-5.3-flash | — | not sent | 4096 | not sent | none | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0600; spent generator $0.0656 + Jev $0.0000 = $0.0656. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off | 10 | 10 | 8 | 8/10 (n=10) 80.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-off |
| --- | --- | --- |
| argument_swap | 1 | 1/1 100.0% |
| missing_condition | 2 | 2/2 100.0% |
| off_by_one | 2 | 2/2 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 2 | 1/2 50.0% |
| wrong_variable | 2 | 1/2 50.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `bitcount`, `bucketsort`, `detect_cycle`, `find_in_sorted`, `gcd`, `kth`, `lis`, `mergesort`, `shortest_path_length`, `wrap`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off |
| --- | --- |
| pass rate (passed/evaluated) | 8/10 (n=10) 80.0% |
| steps-to-solve mean (n passed) | 5.13 (n=8) |
| steps-to-solve median | 5 |
| steps used mean (n runs) | 5.30 (n=10) |
| steps used median | 5 |
| read actions total / mean per run | 21 / 2.10 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 64 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 4505 (n=53) |
| mean Jev tokens/step (steps) | 0 (n=53) |
| mean tokens/step, generator+Jev (steps) | 4505 (n=53) |
| wall time mean | 3m26s |
| wall time median | 1m |
| cost generator / Jev / total | $0.0656 / $0.0000 / $0.0656 |
| $ per solved task | $0.0082 |
| pass rate Wilson 95% | [49.0%, 94.3%] |
| generator.jsonl calls / samples / valid | 64 / 0 / 51 |
| generator malformed / length / dropped (timeouts) | 13 / 8 / 0 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 13369 / 41831, 11486 / 22108 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0000 / 84761 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off solved(k) | jev-off fraction | jev-off |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 0/10 | 0.0% |  |
| 3 | 0/10 | 0.0% |  |
| 4 | 2/10 | 20.0% | ████ |
| 5 | 6/10 | 60.0% | ████████████ |
| 6 | 7/10 | 70.0% | ██████████████ |
| 7 | 8/10 | 80.0% | ████████████████ |
| 8 | 8/10 | 80.0% | ████████████████ |
| 9 | 8/10 | 80.0% | ████████████████ |
| 10 | 8/10 | 80.0% | ████████████████ |
| 11 | 8/10 | 80.0% | ████████████████ |
| 12 | 8/10 | 80.0% | ████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1800 (n=10) | ██████ |
| 2 | 4826 (n=10) | ████████████████ |
| 3 | 5615 (n=10) | ███████████████████ |
| 4 | 5958 (n=10) | ████████████████████ |
| 5 | 4931 (n=8) | █████████████████ |
| 6 | 3451 (n=4) | ████████████ |
| 7 | 3516 (n=1) | ████████████ |

#### Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 0 (n=10) |  |
| 2 | 0 (n=10) |  |
| 3 | 0 (n=10) |  |
| 4 | 0 (n=10) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=4) |  |
| 7 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off mean tokens (n) | jev-off |
| --- | --- | --- |
| 1 | 1800 (n=10) | ██████ |
| 2 | 4826 (n=10) | ████████████████ |
| 3 | 5615 (n=10) | ███████████████████ |
| 4 | 5958 (n=10) | ████████████████████ |
| 5 | 4931 (n=8) | █████████████████ |
| 6 | 3451 (n=4) | ████████████ |
| 7 | 3516 (n=1) | ████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off |  |
| --- | --- | --- |
| generator_done | 7 | ████████████████████ |
| wall_time | 3 | █████████ |

### Per task (paired)

| task | jev-off pass | jev-off steps | jev-off reads | jev-off wall | jev-off cost |
| --- | --- | --- | --- | --- | --- |
| bitcount | pass | 5 | 2 | 59s | $0.0023 |
| bucketsort | pass | 5 | 1 | 52s | $0.0023 |
| detect_cycle | pass | 6 | 2 | 2m42s | $0.0066 |
| find_in_sorted | pass | 4 | 0 | 52s | $0.0019 |
| gcd | pass | 5 | 1 | 58s | $0.0026 |
| kth | pass | 5 | 2 | 1m | $0.0019 |
| lis | pass | 4 | 2 | 8m | $0.0111 |
| mergesort | pass | 7 | 2 | 2m55s | $0.0118 |
| shortest_path_length | fail | 6 | 5 | 8m | $0.0040 |
| wrap | fail | 6 | 4 | 8m | $0.0211 |

