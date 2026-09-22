# JevCode bench 20260922-070313-f8f64f

Generated 2026-09-22T07:15:12.573Z. Generator model `z-ai/glm-5.3-flash`. 8 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 30 | 15m | $0.1500 | auto | 2m | 200 KB |

## Spend

Bench cap $1.5000, per-run cap $0.1500; spent generator $0.1379 + Jev $0.0000 = $0.1379. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 8 | 8 | 2 | 2/8 (n=8) 25.0% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | jev-off-tuned |
| --- | --- | --- |
| 2 | 1 | 1/1 100.0% |
| 3 | 1 | 1/1 100.0% |
| 4 | 3 | 0/3 0.0% |
| 5 | 1 | 0/1 0.0% |
| 6 | 2 | 0/2 0.0% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | jev-off-tuned |
| --- | --- | --- |
| 4 | 5 | 2/5 40.0% |
| 5 | 3 | 0/3 0.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `crossfile`, `import_and_guard`, `ledger5`, `long_chain`, `masked`, `regress_trap`, `shared_frame`, `six_hunks`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 2/8 (n=8) 25.0% |
| steps-to-solve mean (n passed) | 26.50 (n=2) |
| steps-to-solve median | 23 |
| steps used mean (n runs) | 29.13 (n=8) |
| steps used median | 30 |
| read actions total / mean per run | 102 / 12.75 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 13 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 233 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 3799 (n=233) |
| mean Jev tokens/step (steps) | 0 (n=233) |
| mean tokens/step, generator+Jev (steps) | 3799 (n=233) |
| wall time mean | 2m39s |
| wall time median | 2m17s |
| cost generator / Jev / total | $0.1379 / $0.0000 / $0.1379 |
| $ per solved task | $0.0690 |
| pass rate Wilson 95% | [7.1%, 59.1%] |
| generator.jsonl calls / samples / valid | 233 / 0 / 227 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 6 (6) |
| generator latency p50 / p90 ms, valid p50 / p90 | 3008 / 12499, 2938 / 11898 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0037 / 15093 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 0/8 | 0.0% |  |
| 3 | 0/8 | 0.0% |  |
| 4 | 0/8 | 0.0% |  |
| 5 | 0/8 | 0.0% |  |
| 6 | 0/8 | 0.0% |  |
| 7 | 0/8 | 0.0% |  |
| 8 | 0/8 | 0.0% |  |
| 9 | 0/8 | 0.0% |  |
| 10 | 0/8 | 0.0% |  |
| 11 | 0/8 | 0.0% |  |
| 12 | 0/8 | 0.0% |  |
| 13 | 0/8 | 0.0% |  |
| 14 | 0/8 | 0.0% |  |
| 15 | 0/8 | 0.0% |  |
| 16 | 0/8 | 0.0% |  |
| 17 | 0/8 | 0.0% |  |
| 18 | 0/8 | 0.0% |  |
| 19 | 0/8 | 0.0% |  |
| 20 | 0/8 | 0.0% |  |
| 21 | 0/8 | 0.0% |  |
| 22 | 0/8 | 0.0% |  |
| 23 | 1/8 | 12.5% | ███ |
| 24 | 1/8 | 12.5% | ███ |
| 25 | 1/8 | 12.5% | ███ |
| 26 | 1/8 | 12.5% | ███ |
| 27 | 1/8 | 12.5% | ███ |
| 28 | 1/8 | 12.5% | ███ |
| 29 | 1/8 | 12.5% | ███ |
| 30 | 2/8 | 25.0% | █████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1929 (n=8) | █████████ |
| 2 | 2214 (n=8) | ██████████ |
| 3 | 2537 (n=8) | ████████████ |
| 4 | 2805 (n=8) | █████████████ |
| 5 | 3105 (n=8) | ██████████████ |
| 6 | 3252 (n=8) | ███████████████ |
| 7 | 3327 (n=8) | ███████████████ |
| 8 | 3510 (n=8) | ████████████████ |
| 9 | 3608 (n=8) | ████████████████ |
| 10 | 3776 (n=8) | █████████████████ |
| 11 | 3903 (n=8) | ██████████████████ |
| 12 | 3963 (n=8) | ██████████████████ |
| 13 | 4036 (n=8) | ██████████████████ |
| 14 | 4153 (n=8) | ███████████████████ |
| 15 | 4163 (n=8) | ███████████████████ |
| 16 | 4227 (n=8) | ███████████████████ |
| 17 | 4347 (n=8) | ████████████████████ |
| 18 | 4241 (n=8) | ███████████████████ |
| 19 | 4255 (n=8) | ███████████████████ |
| 20 | 4210 (n=8) | ███████████████████ |
| 21 | 4240 (n=8) | ███████████████████ |
| 22 | 4282 (n=8) | ████████████████████ |
| 23 | 4388 (n=8) | ████████████████████ |
| 24 | 4314 (n=7) | ████████████████████ |
| 25 | 4251 (n=7) | ███████████████████ |
| 26 | 4231 (n=7) | ███████████████████ |
| 27 | 4250 (n=7) | ███████████████████ |
| 28 | 4311 (n=7) | ████████████████████ |
| 29 | 4333 (n=7) | ████████████████████ |
| 30 | 4236 (n=7) | ███████████████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=8) |  |
| 2 | 0 (n=8) |  |
| 3 | 0 (n=8) |  |
| 4 | 0 (n=8) |  |
| 5 | 0 (n=8) |  |
| 6 | 0 (n=8) |  |
| 7 | 0 (n=8) |  |
| 8 | 0 (n=8) |  |
| 9 | 0 (n=8) |  |
| 10 | 0 (n=8) |  |
| 11 | 0 (n=8) |  |
| 12 | 0 (n=8) |  |
| 13 | 0 (n=8) |  |
| 14 | 0 (n=8) |  |
| 15 | 0 (n=8) |  |
| 16 | 0 (n=8) |  |
| 17 | 0 (n=8) |  |
| 18 | 0 (n=8) |  |
| 19 | 0 (n=8) |  |
| 20 | 0 (n=8) |  |
| 21 | 0 (n=8) |  |
| 22 | 0 (n=8) |  |
| 23 | 0 (n=8) |  |
| 24 | 0 (n=7) |  |
| 25 | 0 (n=7) |  |
| 26 | 0 (n=7) |  |
| 27 | 0 (n=7) |  |
| 28 | 0 (n=7) |  |
| 29 | 0 (n=7) |  |
| 30 | 0 (n=7) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1929 (n=8) | █████████ |
| 2 | 2214 (n=8) | ██████████ |
| 3 | 2537 (n=8) | ████████████ |
| 4 | 2805 (n=8) | █████████████ |
| 5 | 3105 (n=8) | ██████████████ |
| 6 | 3252 (n=8) | ███████████████ |
| 7 | 3327 (n=8) | ███████████████ |
| 8 | 3510 (n=8) | ████████████████ |
| 9 | 3608 (n=8) | ████████████████ |
| 10 | 3776 (n=8) | █████████████████ |
| 11 | 3903 (n=8) | ██████████████████ |
| 12 | 3963 (n=8) | ██████████████████ |
| 13 | 4036 (n=8) | ██████████████████ |
| 14 | 4153 (n=8) | ███████████████████ |
| 15 | 4163 (n=8) | ███████████████████ |
| 16 | 4227 (n=8) | ███████████████████ |
| 17 | 4347 (n=8) | ████████████████████ |
| 18 | 4241 (n=8) | ███████████████████ |
| 19 | 4255 (n=8) | ███████████████████ |
| 20 | 4210 (n=8) | ███████████████████ |
| 21 | 4240 (n=8) | ███████████████████ |
| 22 | 4282 (n=8) | ████████████████████ |
| 23 | 4388 (n=8) | ████████████████████ |
| 24 | 4314 (n=7) | ████████████████████ |
| 25 | 4251 (n=7) | ███████████████████ |
| 26 | 4231 (n=7) | ███████████████████ |
| 27 | 4250 (n=7) | ███████████████████ |
| 28 | 4311 (n=7) | ████████████████████ |
| 29 | 4333 (n=7) | ████████████████████ |
| 30 | 4236 (n=7) | ███████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| generator_done | 1 | ███ |
| max_steps | 7 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| crossfile | fail | 30 | 12 | 2m17s | $0.0196 |
| import_and_guard | fail | 30 | 15 | 2m17s | $0.0182 |
| ledger5 | fail | 30 | 13 | 2m16s | $0.0188 |
| long_chain | fail | 30 | 13 | 1m40s | $0.0182 |
| masked | pass | 30 | 11 | 2m54s | $0.0167 |
| regress_trap | fail | 30 | 16 | 3m28s | $0.0168 |
| shared_frame | pass | 23 | 9 | 2m28s | $0.0123 |
| six_hunks | fail | 30 | 13 | 3m54s | $0.0173 |

