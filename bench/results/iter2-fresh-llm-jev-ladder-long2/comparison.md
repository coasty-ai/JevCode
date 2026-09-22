# JevCode bench 20260922-152601-754532

Generated 2026-09-22T15:51:26.784Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.0765 + Jev $0.0768 = $0.1534. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 6 | 6 | 4 | 4/6 (n=6) 66.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 3 | 6 | 4/6 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 5 | 6 | 4/6 66.7% |

### Paired comparison (n = 6 tasks evaluated in every condition)

Paired tasks: `csv_schema`, `deadline_queue`, `dep_order`, `hunk_merge`, `route_match`, `token_bucket`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 4/6 (n=6) 66.7% |
| steps-to-solve mean (n passed) | 4.75 (n=4) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 10 (n=6) |
| steps used median | 5 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 12 / 10 |
| Jev requests / questions | 664 / 2099 |
| generator calls (jev-only asserts 0) | 171 |
| Jev latency p50 / p95 ms (n) | 147.90 / 281.99 (n=844) |
| mean generator tokens/step (steps) | 8222 (n=60) |
| mean Jev tokens/step (steps) | 38229 (n=60) |
| mean tokens/step, generator+Jev (steps) | 46451 (n=60) |
| wall time mean | 7m40s |
| wall time median | 6m8s |
| cost generator / Jev / total | $0.0765 / $0.0768 / $0.1534 |
| $ per solved task | $0.0383 |
| pass rate Wilson 95% | [30.0%, 90.3%] |
| generator.jsonl calls / samples / valid | 171 / 171 / 94 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 77 (32) |
| generator latency p50 / p90 ms, valid p50 / p90 | 17297 / 45000, 13275 / 30267 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0246 / 16326 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 45m45s / 45s (n=60) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 171 / 53 / 0 / 32 / 29 / 2 |
| verify: candidates tested / passers / partials | 39064 / 26 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 2/6 | 33.3% | ███████ |
| 4 | 2/6 | 33.3% | ███████ |
| 5 | 3/6 | 50.0% | ██████████ |
| 6 | 3/6 | 50.0% | ██████████ |
| 7 | 3/6 | 50.0% | ██████████ |
| 8 | 4/6 | 66.7% | █████████████ |
| 9 | 4/6 | 66.7% | █████████████ |
| 10 | 4/6 | 66.7% | █████████████ |
| 11 | 4/6 | 66.7% | █████████████ |
| 12 | 4/6 | 66.7% | █████████████ |
| 13 | 4/6 | 66.7% | █████████████ |
| 14 | 4/6 | 66.7% | █████████████ |
| 15 | 4/6 | 66.7% | █████████████ |
| 16 | 4/6 | 66.7% | █████████████ |
| 17 | 4/6 | 66.7% | █████████████ |
| 18 | 4/6 | 66.7% | █████████████ |
| 19 | 4/6 | 66.7% | █████████████ |
| 20 | 4/6 | 66.7% | █████████████ |
| 21 | 4/6 | 66.7% | █████████████ |
| 22 | 4/6 | 66.7% | █████████████ |
| 23 | 4/6 | 66.7% | █████████████ |
| 24 | 4/6 | 66.7% | █████████████ |
| 25 | 4/6 | 66.7% | █████████████ |
| 26 | 4/6 | 66.7% | █████████████ |
| 27 | 4/6 | 66.7% | █████████████ |
| 28 | 4/6 | 66.7% | █████████████ |
| 29 | 4/6 | 66.7% | █████████████ |
| 30 | 4/6 | 66.7% | █████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 7898 (n=6) | ███████ |
| 2 | 12424 (n=6) | ███████████ |
| 3 | 10222 (n=6) | █████████ |
| 4 | 15591 (n=4) | █████████████ |
| 5 | 3095 (n=4) | ███ |
| 6 | 3754 (n=3) | ███ |
| 7 | 6652 (n=3) | ██████ |
| 8 | 1746 (n=3) | █ |
| 9 | 8807 (n=2) | ████████ |
| 10 | 7462 (n=2) | ██████ |
| 11 | 5373 (n=2) | █████ |
| 12 | 5690 (n=2) | █████ |
| 13 | 19871 (n=2) | █████████████████ |
| 14 | 23468 (n=2) | ████████████████████ |
| 15 | 6017 (n=2) | █████ |
| 16 | 3855 (n=2) | ███ |
| 17 | 3680 (n=2) | ███ |
| 18 | 11321 (n=2) | ██████████ |
| 19 | 3890 (n=2) | ███ |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 27993 (n=6) | ████ |
| 2 | 68388 (n=6) | ██████████ |
| 3 | 112168 (n=6) | █████████████████ |
| 4 | 64652 (n=4) | ██████████ |
| 5 | 8160 (n=4) | █ |
| 6 | 16336 (n=3) | ██ |
| 7 | 27372 (n=3) | ████ |
| 8 | 4124 (n=3) | █ |
| 9 | 8808 (n=2) | █ |
| 10 | 72461 (n=2) | ███████████ |
| 11 | 1913 (n=2) |  |
| 12 | 11510 (n=2) | ██ |
| 13 | 36133 (n=2) | █████ |
| 14 | 133577 (n=2) | ████████████████████ |
| 15 | 2336 (n=2) |  |
| 16 | 14443 (n=2) | ██ |
| 17 | 19376 (n=2) | ███ |
| 18 | 1647 (n=2) |  |
| 19 | 1652 (n=2) |  |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 35891 (n=6) | █████ |
| 2 | 80812 (n=6) | ██████████ |
| 3 | 122390 (n=6) | ████████████████ |
| 4 | 80244 (n=4) | ██████████ |
| 5 | 11255 (n=4) | █ |
| 6 | 20091 (n=3) | ███ |
| 7 | 34023 (n=3) | ████ |
| 8 | 5870 (n=3) | █ |
| 9 | 17614 (n=2) | ██ |
| 10 | 79923 (n=2) | ██████████ |
| 11 | 7286 (n=2) | █ |
| 12 | 17200 (n=2) | ██ |
| 13 | 56004 (n=2) | ███████ |
| 14 | 157045 (n=2) | ████████████████████ |
| 15 | 8353 (n=2) | █ |
| 16 | 18297 (n=2) | ██ |
| 17 | 23056 (n=2) | ███ |
| 18 | 12968 (n=2) | ██ |
| 19 | 5542 (n=2) | █ |
| 20 | 0 (n=2) |  |
| 21 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 4 | ████████████████████ |
| max_replans | 2 | ██████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | pass | 8 | 0 | 7m12s | $0.0219 |
| deadline_queue | pass | 3 | 0 | 2m19s | $0.0107 |
| dep_order | pass | 3 | 0 | 2m16s | $0.0043 |
| hunk_merge | fail | 20 | 0 | 14m38s | $0.0630 |
| route_match | fail | 21 | 0 | 13m27s | $0.0427 |
| token_bucket | pass | 5 | 0 | 6m8s | $0.0108 |

