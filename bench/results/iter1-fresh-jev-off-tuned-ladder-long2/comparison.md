# JevCode bench 20260922-121150-a97b61

Generated 2026-09-22T12:20:11.614Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.1112 + Jev $0.0000 = $0.1112. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 6 | 6 | 0 | 0/6 (n=6) 0.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-off-tuned |
| --- | --- | --- |
| 3 | 6 | 0/6 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-off-tuned |
| --- | --- | --- |
| 5 | 6 | 0/6 0.0% |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `csv_schema`, `deadline_queue`, `dep_order`, `hunk_merge`, `route_match`, `token_bucket`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 0/6 (n=6) 0.0% |
| steps-to-solve mean (n passed) | null (n=0) |
| steps-to-solve median | null |
| steps used mean (n runs) | 30 (n=6) |
| steps used median | 30 |
| read actions total / mean per run | 79 / 13.17 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 10 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 182 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 3781 (n=180) |
| mean Jev tokens/step (steps) | 0 (n=180) |
| mean tokens/step, generator+Jev (steps) | 3781 (n=180) |
| wall time mean | 2m19s |
| wall time median | 2m7s |
| cost generator / Jev / total | $0.1112 / $0.0000 / $0.1112 |
| $ per solved task | null |
| pass rate Wilson 95% | [0.0%, 39.0%] |
| generator.jsonl calls / samples / valid | 182 / 0 / 171 |
| generator malformed / length / dropped (timeouts) | 2 / 0 / 9 (9) |
| generator latency p50 / p90 ms, valid p50 / p90 | 2680 / 12602, 2618 / 7146 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0054 / 12820 |
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
| 11 | 0/6 | 0.0% |  |
| 12 | 0/6 | 0.0% |  |
| 13 | 0/6 | 0.0% |  |
| 14 | 0/6 | 0.0% |  |
| 15 | 0/6 | 0.0% |  |
| 16 | 0/6 | 0.0% |  |
| 17 | 0/6 | 0.0% |  |
| 18 | 0/6 | 0.0% |  |
| 19 | 0/6 | 0.0% |  |
| 20 | 0/6 | 0.0% |  |
| 21 | 0/6 | 0.0% |  |
| 22 | 0/6 | 0.0% |  |
| 23 | 0/6 | 0.0% |  |
| 24 | 0/6 | 0.0% |  |
| 25 | 0/6 | 0.0% |  |
| 26 | 0/6 | 0.0% |  |
| 27 | 0/6 | 0.0% |  |
| 28 | 0/6 | 0.0% |  |
| 29 | 0/6 | 0.0% |  |
| 30 | 0/6 | 0.0% |  |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 2011 (n=6) | ████████ |
| 2 | 2285 (n=6) | ██████████ |
| 3 | 2545 (n=6) | ███████████ |
| 4 | 2755 (n=6) | ███████████ |
| 5 | 3074 (n=6) | █████████████ |
| 6 | 3115 (n=6) | █████████████ |
| 7 | 3216 (n=6) | █████████████ |
| 8 | 3351 (n=6) | ██████████████ |
| 9 | 3573 (n=6) | ███████████████ |
| 10 | 3635 (n=6) | ███████████████ |
| 11 | 4428 (n=6) | ██████████████████ |
| 12 | 3848 (n=6) | ████████████████ |
| 13 | 3764 (n=6) | ████████████████ |
| 14 | 3823 (n=6) | ████████████████ |
| 15 | 3902 (n=6) | ████████████████ |
| 16 | 3922 (n=6) | ████████████████ |
| 17 | 4062 (n=6) | █████████████████ |
| 18 | 4801 (n=6) | ████████████████████ |
| 19 | 4075 (n=6) | █████████████████ |
| 20 | 4176 (n=6) | █████████████████ |
| 21 | 4072 (n=6) | █████████████████ |
| 22 | 4185 (n=6) | █████████████████ |
| 23 | 4227 (n=6) | ██████████████████ |
| 24 | 4313 (n=6) | ██████████████████ |
| 25 | 4433 (n=6) | ██████████████████ |
| 26 | 4458 (n=6) | ███████████████████ |
| 27 | 4427 (n=6) | ██████████████████ |
| 28 | 4377 (n=6) | ██████████████████ |
| 29 | 4308 (n=6) | ██████████████████ |
| 30 | 4276 (n=6) | ██████████████████ |

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
| 12 | 0 (n=6) |  |
| 13 | 0 (n=6) |  |
| 14 | 0 (n=6) |  |
| 15 | 0 (n=6) |  |
| 16 | 0 (n=6) |  |
| 17 | 0 (n=6) |  |
| 18 | 0 (n=6) |  |
| 19 | 0 (n=6) |  |
| 20 | 0 (n=6) |  |
| 21 | 0 (n=6) |  |
| 22 | 0 (n=6) |  |
| 23 | 0 (n=6) |  |
| 24 | 0 (n=6) |  |
| 25 | 0 (n=6) |  |
| 26 | 0 (n=6) |  |
| 27 | 0 (n=6) |  |
| 28 | 0 (n=6) |  |
| 29 | 0 (n=6) |  |
| 30 | 0 (n=6) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 2011 (n=6) | ████████ |
| 2 | 2285 (n=6) | ██████████ |
| 3 | 2545 (n=6) | ███████████ |
| 4 | 2755 (n=6) | ███████████ |
| 5 | 3074 (n=6) | █████████████ |
| 6 | 3115 (n=6) | █████████████ |
| 7 | 3216 (n=6) | █████████████ |
| 8 | 3351 (n=6) | ██████████████ |
| 9 | 3573 (n=6) | ███████████████ |
| 10 | 3635 (n=6) | ███████████████ |
| 11 | 4428 (n=6) | ██████████████████ |
| 12 | 3848 (n=6) | ████████████████ |
| 13 | 3764 (n=6) | ████████████████ |
| 14 | 3823 (n=6) | ████████████████ |
| 15 | 3902 (n=6) | ████████████████ |
| 16 | 3922 (n=6) | ████████████████ |
| 17 | 4062 (n=6) | █████████████████ |
| 18 | 4801 (n=6) | ████████████████████ |
| 19 | 4075 (n=6) | █████████████████ |
| 20 | 4176 (n=6) | █████████████████ |
| 21 | 4072 (n=6) | █████████████████ |
| 22 | 4185 (n=6) | █████████████████ |
| 23 | 4227 (n=6) | ██████████████████ |
| 24 | 4313 (n=6) | ██████████████████ |
| 25 | 4433 (n=6) | ██████████████████ |
| 26 | 4458 (n=6) | ███████████████████ |
| 27 | 4427 (n=6) | ██████████████████ |
| 28 | 4377 (n=6) | ██████████████████ |
| 29 | 4308 (n=6) | ██████████████████ |
| 30 | 4276 (n=6) | ██████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| max_steps | 6 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | fail | 30 | 11 | 2m4s | $0.0195 |
| deadline_queue | fail | 30 | 13 | 2m53s | $0.0190 |
| dep_order | fail | 30 | 13 | 2m7s | $0.0185 |
| hunk_merge | fail | 30 | 14 | 2m25s | $0.0176 |
| route_match | fail | 30 | 11 | 1m24s | $0.0184 |
| token_bucket | fail | 30 | 17 | 3m | $0.0181 |

