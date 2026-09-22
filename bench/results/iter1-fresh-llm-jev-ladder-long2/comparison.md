# JevCode bench 20260922-114107-4a7c62

Generated 2026-09-22T12:06:35.173Z. Generator model `z-ai/glm-5.3-flash`. 6 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1800 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1800; spent generator $0.0900 + Jev $0.1095 = $0.1995. Bench cap fired: no. Pairs not run: 0.

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
| steps-to-solve mean (n passed) | 9.25 (n=4) |
| steps-to-solve median | 9 |
| steps used mean (n runs) | 13.67 (n=6) |
| steps used median | 12 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 17 / 15 |
| Jev requests / questions | 927 / 2935 |
| generator calls (jev-only asserts 0) | 250 |
| Jev latency p50 / p95 ms (n) | 141.02 / 286.38 (n=1240) |
| mean generator tokens/step (steps) | 6986 (n=82) |
| mean Jev tokens/step (steps) | 39773 (n=82) |
| mean tokens/step, generator+Jev (steps) | 46759 (n=82) |
| wall time mean | 7m34s |
| wall time median | 5m28s |
| cost generator / Jev / total | $0.0900 / $0.1095 / $0.1995 |
| $ per solved task | $0.0499 |
| pass rate Wilson 95% | [30.0%, 90.3%] |
| generator.jsonl calls / samples / valid | 250 / 250 / 73 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 177 (110) |
| generator latency p50 / p90 ms, valid p50 / p90 | 19496 / 30002, 6370 / 21901 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0514 / 8842 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 45m10s / 33s (n=82) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 250 / 36 / 0 / 110 / 31 / 1 |
| verify: candidates tested / passers / partials | 41188 / 22 / 0 |
| grace wait total / localisation missed / generic steps | 12s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/6 | 0.0% |  |
| 2 | 0/6 | 0.0% |  |
| 3 | 1/6 | 16.7% | ███ |
| 4 | 1/6 | 16.7% | ███ |
| 5 | 1/6 | 16.7% | ███ |
| 6 | 1/6 | 16.7% | ███ |
| 7 | 1/6 | 16.7% | ███ |
| 8 | 1/6 | 16.7% | ███ |
| 9 | 2/6 | 33.3% | ███████ |
| 10 | 2/6 | 33.3% | ███████ |
| 11 | 2/6 | 33.3% | ███████ |
| 12 | 3/6 | 50.0% | ██████████ |
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
| 1 | 5870 (n=6) | ████████ |
| 2 | 10162 (n=6) | ██████████████ |
| 3 | 8670 (n=6) | ████████████ |
| 4 | 9088 (n=5) | █████████████ |
| 5 | 5676 (n=5) | ████████ |
| 6 | 6717 (n=5) | █████████ |
| 7 | 4753 (n=5) | ███████ |
| 8 | 10090 (n=5) | ██████████████ |
| 9 | 1445 (n=5) | ██ |
| 10 | 3312 (n=4) | █████ |
| 11 | 14297 (n=4) | ████████████████████ |
| 12 | 9392 (n=4) | █████████████ |
| 13 | 10232 (n=3) | ██████████████ |
| 14 | 11119 (n=2) | ████████████████ |
| 15 | 2870 (n=2) | ████ |
| 16 | 3850 (n=2) | █████ |
| 17 | 6264 (n=2) | █████████ |
| 18 | 7905 (n=2) | ███████████ |
| 19 | 2376 (n=2) | ███ |
| 20 | 1608 (n=2) | ██ |
| 21 | 3566 (n=2) | █████ |
| 22 | 7282 (n=1) | ██████████ |
| 23 | 6799 (n=1) | ██████████ |
| 24 | 3885 (n=1) | █████ |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 27595 (n=6) | █████ |
| 2 | 18252 (n=6) | ████ |
| 3 | 65116 (n=6) | █████████████ |
| 4 | 73557 (n=5) | ███████████████ |
| 5 | 57236 (n=5) | ███████████ |
| 6 | 100645 (n=5) | ████████████████████ |
| 7 | 35037 (n=5) | ███████ |
| 8 | 72403 (n=5) | ██████████████ |
| 9 | 3529 (n=5) | █ |
| 10 | 23366 (n=4) | █████ |
| 11 | 86377 (n=4) | █████████████████ |
| 12 | 30497 (n=4) | ██████ |
| 13 | 3510 (n=3) | █ |
| 14 | 74014 (n=2) | ███████████████ |
| 15 | 8384 (n=2) | ██ |
| 16 | 8473 (n=2) | ██ |
| 17 | 3653 (n=2) | █ |
| 18 | 1830 (n=2) |  |
| 19 | 5071 (n=2) | █ |
| 20 | 3340 (n=2) | █ |
| 21 | 18139 (n=2) | ████ |
| 22 | 26568 (n=1) | █████ |
| 23 | 34649 (n=1) | ███████ |
| 24 | 5086 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 33465 (n=6) | ██████ |
| 2 | 28414 (n=6) | █████ |
| 3 | 73786 (n=6) | ██████████████ |
| 4 | 82645 (n=5) | ███████████████ |
| 5 | 62912 (n=5) | ████████████ |
| 6 | 107362 (n=5) | ████████████████████ |
| 7 | 39790 (n=5) | ███████ |
| 8 | 82493 (n=5) | ███████████████ |
| 9 | 4974 (n=5) | █ |
| 10 | 26679 (n=4) | █████ |
| 11 | 100673 (n=4) | ███████████████████ |
| 12 | 39889 (n=4) | ███████ |
| 13 | 13742 (n=3) | ███ |
| 14 | 85133 (n=2) | ████████████████ |
| 15 | 11254 (n=2) | ██ |
| 16 | 12323 (n=2) | ██ |
| 17 | 9917 (n=2) | ██ |
| 18 | 9735 (n=2) | ██ |
| 19 | 7447 (n=2) | █ |
| 20 | 4948 (n=2) | █ |
| 21 | 21705 (n=2) | ████ |
| 22 | 33850 (n=1) | ██████ |
| 23 | 41448 (n=1) | ████████ |
| 24 | 8971 (n=1) | ██ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 4 | ████████████████████ |
| max_replans | 1 | █████ |
| replan_stop | 1 | █████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| csv_schema | fail | 24 | 0 | 14m29s | $0.0499 |
| deadline_queue | pass | 9 | 0 | 4m45s | $0.0118 |
| dep_order | pass | 12 | 0 | 8m20s | $0.0376 |
| hunk_merge | pass | 13 | 0 | 5m28s | $0.0317 |
| route_match | fail | 21 | 0 | 10m57s | $0.0627 |
| token_bucket | pass | 3 | 0 | 1m29s | $0.0057 |

