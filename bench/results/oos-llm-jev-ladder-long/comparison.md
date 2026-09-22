# JevCode bench 20260922-054652-3cff40

Generated 2026-09-22T06:31:48.068Z. Generator model `z-ai/glm-5.3-flash`. 8 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.1500; spent generator $0.0849 + Jev $0.3106 = $0.3955. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 8 | 8 | 3 | 3/8 (n=8) 37.5% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 2 | 1 | 1/1 100.0% |
| 3 | 1 | 0/1 0.0% |
| 4 | 3 | 1/3 33.3% |
| 5 | 1 | 1/1 100.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 4 | 5 | 3/5 60.0% |
| 5 | 3 | 0/3 0.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `crossfile`, `import_and_guard`, `ledger5`, `long_chain`, `masked`, `regress_trap`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 3/8 (n=8) 37.5% |
| steps-to-solve mean (n passed) | 10 (n=3) |
| steps-to-solve median | 10 |
| steps used mean (n runs) | 13.88 (n=8) |
| steps used median | 12 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 28 / 23 |
| Jev requests / questions | 1532 / 25770 |
| generator calls (jev-only asserts 0) | 244 |
| Jev latency p50 / p95 ms (n) | 192.22 / 366.79 (n=1532) |
| mean generator tokens/step (steps) | 5512 (n=111) |
| mean Jev tokens/step (steps) | 75803 (n=111) |
| mean tokens/step, generator+Jev (steps) | 81315 (n=111) |
| wall time mean | 9m46s |
| wall time median | 8m32s |
| cost generator / Jev / total | $0.0849 / $0.3106 / $0.3955 |
| $ per solved task | $0.1318 |
| pass rate Wilson 95% | [13.7%, 69.4%] |
| generator.jsonl calls / samples / valid | 244 / 244 / 115 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 129 (82) |
| generator latency p50 / p90 ms, valid p50 / p90 | 10004 / 19961, 8048 / 14802 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0342 / 17710 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 1h17m / 41s (n=111) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 244 / 64 / 0 / 82 / 44 / 0 |
| verify: candidates tested / passers / partials | 47951 / 31 / 5 |
| grace wait total / localisation missed / generic steps | 12s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 0/8 | 0.0% |  |
| 3 | 0/8 | 0.0% |  |
| 4 | 0/8 | 0.0% |  |
| 5 | 0/8 | 0.0% |  |
| 6 | 1/8 | 12.5% | ███ |
| 7 | 1/8 | 12.5% | ███ |
| 8 | 1/8 | 12.5% | ███ |
| 9 | 1/8 | 12.5% | ███ |
| 10 | 2/8 | 25.0% | █████ |
| 11 | 2/8 | 25.0% | █████ |
| 12 | 2/8 | 25.0% | █████ |
| 13 | 2/8 | 25.0% | █████ |
| 14 | 3/8 | 37.5% | ████████ |
| 15 | 3/8 | 37.5% | ████████ |
| 16 | 3/8 | 37.5% | ████████ |
| 17 | 3/8 | 37.5% | ████████ |
| 18 | 3/8 | 37.5% | ████████ |
| 19 | 3/8 | 37.5% | ████████ |
| 20 | 3/8 | 37.5% | ████████ |
| 21 | 3/8 | 37.5% | ████████ |
| 22 | 3/8 | 37.5% | ████████ |
| 23 | 3/8 | 37.5% | ████████ |
| 24 | 3/8 | 37.5% | ████████ |
| 25 | 3/8 | 37.5% | ████████ |
| 26 | 3/8 | 37.5% | ████████ |
| 27 | 3/8 | 37.5% | ████████ |
| 28 | 3/8 | 37.5% | ████████ |
| 29 | 3/8 | 37.5% | ████████ |
| 30 | 3/8 | 37.5% | ████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 4617 (n=8) | ███████████ |
| 2 | 5588 (n=8) | █████████████ |
| 3 | 3364 (n=8) | ████████ |
| 4 | 6527 (n=8) | ███████████████ |
| 5 | 8191 (n=8) | ███████████████████ |
| 6 | 8421 (n=8) | ████████████████████ |
| 7 | 4414 (n=7) | ██████████ |
| 8 | 7585 (n=7) | ██████████████████ |
| 9 | 8454 (n=7) | ████████████████████ |
| 10 | 2567 (n=7) | ██████ |
| 11 | 6392 (n=6) | ███████████████ |
| 12 | 6838 (n=6) | ████████████████ |
| 13 | 2641 (n=4) | ██████ |
| 14 | 4338 (n=4) | ██████████ |
| 15 | 6551 (n=2) | ███████████████ |
| 16 | 4923 (n=2) | ████████████ |
| 17 | 4237 (n=2) | ██████████ |
| 18 | 6007 (n=2) | ██████████████ |
| 19 | 0 (n=2) |  |
| 20 | 0 (n=2) |  |
| 21 | 6290 (n=1) | ███████████████ |
| 22 | 0 (n=1) |  |
| 23 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 135004 (n=8) | ████████████████████ |
| 2 | 100333 (n=8) | ███████████████ |
| 3 | 71065 (n=8) | ███████████ |
| 4 | 69936 (n=8) | ██████████ |
| 5 | 125538 (n=8) | ███████████████████ |
| 6 | 78845 (n=8) | ████████████ |
| 7 | 55645 (n=7) | ████████ |
| 8 | 90974 (n=7) | █████████████ |
| 9 | 68728 (n=7) | ██████████ |
| 10 | 26072 (n=7) | ████ |
| 11 | 90228 (n=6) | █████████████ |
| 12 | 105527 (n=6) | ████████████████ |
| 13 | 15999 (n=4) | ██ |
| 14 | 55276 (n=4) | ████████ |
| 15 | 33499 (n=2) | █████ |
| 16 | 71836 (n=2) | ███████████ |
| 17 | 118092 (n=2) | █████████████████ |
| 18 | 56313 (n=2) | ████████ |
| 19 | 7210 (n=2) | █ |
| 20 | 6948 (n=2) | █ |
| 21 | 19289 (n=1) | ███ |
| 22 | 5868 (n=1) | █ |
| 23 | 5866 (n=1) | █ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 139621 (n=8) | ████████████████████ |
| 2 | 105921 (n=8) | ███████████████ |
| 3 | 74429 (n=8) | ███████████ |
| 4 | 76463 (n=8) | ███████████ |
| 5 | 133730 (n=8) | ███████████████████ |
| 6 | 87266 (n=8) | █████████████ |
| 7 | 60059 (n=7) | █████████ |
| 8 | 98559 (n=7) | ██████████████ |
| 9 | 77181 (n=7) | ███████████ |
| 10 | 28639 (n=7) | ████ |
| 11 | 96620 (n=6) | ██████████████ |
| 12 | 112365 (n=6) | ████████████████ |
| 13 | 18640 (n=4) | ███ |
| 14 | 59614 (n=4) | █████████ |
| 15 | 40050 (n=2) | ██████ |
| 16 | 76758 (n=2) | ███████████ |
| 17 | 122329 (n=2) | ██████████████████ |
| 18 | 62320 (n=2) | █████████ |
| 19 | 7210 (n=2) | █ |
| 20 | 6948 (n=2) | █ |
| 21 | 25579 (n=1) | ████ |
| 22 | 5868 (n=1) | █ |
| 23 | 5866 (n=1) | █ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 3 | ████████████████████ |
| max_replans | 2 | █████████████ |
| replan_stop | 3 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| crossfile | fail | 20 | 0 | 14m52s | $0.1117 |
| import_and_guard | pass | 6 | 0 | 3m10s | $0.0035 |
| ledger5 | pass | 14 | 0 | 8m30s | $0.0246 |
| long_chain | fail | 23 | 0 | 14m10s | $0.0904 |
| masked | fail | 12 | 0 | 8m32s | $0.0322 |
| regress_trap | fail | 14 | 0 | 9m5s | $0.0377 |
| shared_frame | pass | 10 | 0 | 7m29s | $0.0363 |
| six_hunks | fail | 12 | 0 | 12m21s | $0.0591 |

