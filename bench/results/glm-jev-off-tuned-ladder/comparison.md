# JevCode bench 20260922-015814-0d4f1a

Generated 2026-09-22T02:06:58.027Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1000; spent generator $0.0863 + Jev $0.0000 = $0.0863. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 12 | 12 | 10 | 10/12 (n=12) 83.3% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-off-tuned |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 2/3 66.7% |
| 3 | 3 | 2/3 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-off-tuned |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 1/3 33.3% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 10/12 (n=12) 83.3% |
| steps-to-solve mean (n passed) | 14.10 (n=10) |
| steps-to-solve median | 13 |
| steps used mean (n runs) | 15.92 (n=12) |
| steps used median | 14 |
| read actions total / mean per run | 57 / 4.75 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 14 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 199 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 3104 (n=191) |
| mean Jev tokens/step (steps) | 0 (n=191) |
| mean tokens/step, generator+Jev (steps) | 3104 (n=191) |
| wall time mean | 2m6s |
| wall time median | 1m54s |
| cost generator / Jev / total | $0.0863 / $0.0000 / $0.0863 |
| $ per solved task | $0.0086 |
| pass rate Wilson 95% | [55.2%, 95.3%] |
| generator.jsonl calls / samples / valid | 199 / 0 / 168 |
| generator malformed / length / dropped (timeouts) | 10 / 0 / 21 (21) |
| generator latency p50 / p90 ms, valid p50 / p90 | 6941 / 20001, 6066 / 11468 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0091 / 6299 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 0/12 | 0.0% |  |
| 3 | 0/12 | 0.0% |  |
| 4 | 0/12 | 0.0% |  |
| 5 | 0/12 | 0.0% |  |
| 6 | 1/12 | 8.3% | ██ |
| 7 | 1/12 | 8.3% | ██ |
| 8 | 2/12 | 16.7% | ███ |
| 9 | 3/12 | 25.0% | █████ |
| 10 | 3/12 | 25.0% | █████ |
| 11 | 3/12 | 25.0% | █████ |
| 12 | 3/12 | 25.0% | █████ |
| 13 | 5/12 | 41.7% | ████████ |
| 14 | 6/12 | 50.0% | ██████████ |
| 15 | 6/12 | 50.0% | ██████████ |
| 16 | 7/12 | 58.3% | ████████████ |
| 17 | 8/12 | 66.7% | █████████████ |
| 18 | 8/12 | 66.7% | █████████████ |
| 19 | 8/12 | 66.7% | █████████████ |
| 20 | 8/12 | 66.7% | █████████████ |
| 21 | 9/12 | 75.0% | ███████████████ |
| 22 | 9/12 | 75.0% | ███████████████ |
| 23 | 9/12 | 75.0% | ███████████████ |
| 24 | 10/12 | 83.3% | █████████████████ |
| 25 | 10/12 | 83.3% | █████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1777 (n=12) | ███████ |
| 2 | 1979 (n=12) | ████████ |
| 3 | 2409 (n=12) | ██████████ |
| 4 | 2707 (n=12) | ███████████ |
| 5 | 2990 (n=12) | ████████████ |
| 6 | 2911 (n=12) | ████████████ |
| 7 | 2862 (n=11) | ███████████ |
| 8 | 2955 (n=11) | ████████████ |
| 9 | 3006 (n=10) | ████████████ |
| 10 | 3607 (n=9) | ██████████████ |
| 11 | 3560 (n=9) | ██████████████ |
| 12 | 3689 (n=9) | ███████████████ |
| 13 | 3373 (n=9) | █████████████ |
| 14 | 4012 (n=7) | ████████████████ |
| 15 | 3630 (n=6) | ██████████████ |
| 16 | 3439 (n=6) | ██████████████ |
| 17 | 3551 (n=5) | ██████████████ |
| 18 | 3715 (n=4) | ███████████████ |
| 19 | 3832 (n=4) | ███████████████ |
| 20 | 3891 (n=4) | ███████████████ |
| 21 | 3877 (n=4) | ███████████████ |
| 22 | 3787 (n=3) | ███████████████ |
| 23 | 5053 (n=3) | ████████████████████ |
| 24 | 3443 (n=3) | ██████████████ |
| 25 | 3564 (n=2) | ██████████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=12) |  |
| 2 | 0 (n=12) |  |
| 3 | 0 (n=12) |  |
| 4 | 0 (n=12) |  |
| 5 | 0 (n=12) |  |
| 6 | 0 (n=12) |  |
| 7 | 0 (n=11) |  |
| 8 | 0 (n=11) |  |
| 9 | 0 (n=10) |  |
| 10 | 0 (n=9) |  |
| 11 | 0 (n=9) |  |
| 12 | 0 (n=9) |  |
| 13 | 0 (n=9) |  |
| 14 | 0 (n=7) |  |
| 15 | 0 (n=6) |  |
| 16 | 0 (n=6) |  |
| 17 | 0 (n=5) |  |
| 18 | 0 (n=4) |  |
| 19 | 0 (n=4) |  |
| 20 | 0 (n=4) |  |
| 21 | 0 (n=4) |  |
| 22 | 0 (n=3) |  |
| 23 | 0 (n=3) |  |
| 24 | 0 (n=3) |  |
| 25 | 0 (n=2) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1777 (n=12) | ███████ |
| 2 | 1979 (n=12) | ████████ |
| 3 | 2409 (n=12) | ██████████ |
| 4 | 2707 (n=12) | ███████████ |
| 5 | 2990 (n=12) | ████████████ |
| 6 | 2911 (n=12) | ████████████ |
| 7 | 2862 (n=11) | ███████████ |
| 8 | 2955 (n=11) | ████████████ |
| 9 | 3006 (n=10) | ████████████ |
| 10 | 3607 (n=9) | ██████████████ |
| 11 | 3560 (n=9) | ██████████████ |
| 12 | 3689 (n=9) | ███████████████ |
| 13 | 3373 (n=9) | █████████████ |
| 14 | 4012 (n=7) | ████████████████ |
| 15 | 3630 (n=6) | ██████████████ |
| 16 | 3439 (n=6) | ██████████████ |
| 17 | 3551 (n=5) | ██████████████ |
| 18 | 3715 (n=4) | ███████████████ |
| 19 | 3832 (n=4) | ███████████████ |
| 20 | 3891 (n=4) | ███████████████ |
| 21 | 3877 (n=4) | ███████████████ |
| 22 | 3787 (n=3) | ███████████████ |
| 23 | 5053 (n=3) | ████████████████████ |
| 24 | 3443 (n=3) | ██████████████ |
| 25 | 3564 (n=2) | ██████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| generator_done | 10 | ████████████████████ |
| max_steps | 2 | ████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| account | fail | 25 | 7 | 2m42s | $0.0133 |
| calendar_utils | pass | 14 | 6 | 1m32s | $0.0066 |
| events | pass | 13 | 4 | 1m45s | $0.0052 |
| grades | pass | 16 | 5 | 2m26s | $0.0065 |
| inventory | pass | 21 | 5 | 2m22s | $0.0100 |
| profiles | pass | 13 | 4 | 1m54s | $0.0050 |
| shipping | pass | 8 | 3 | 55s | $0.0028 |
| stats | pass | 6 | 2 | 27s | $0.0016 |
| table | pass | 24 | 7 | 3m47s | $0.0128 |
| tagcloud | pass | 9 | 3 | 1m29s | $0.0032 |
| textstats | fail | 25 | 7 | 3m47s | $0.0110 |
| units | pass | 17 | 4 | 2m7s | $0.0083 |

