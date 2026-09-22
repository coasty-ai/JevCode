# JevCode bench 20260922-171604-56f0ab

Generated 2026-09-22T17:31:45.353Z. Generator model `z-ai/glm-5.3-flash`. 12 task records, suites: ladder.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 25 | 12m | $0.1000 | auto | 2m | 200 KB |

## Spend

Bench cap $1.2000, per-run cap $0.1000; spent generator $0.0404 + Jev $0.0228 = $0.0632. Bench cap fired: no. Pairs not run: 0.

## Ladder (hand-made multi-hunk tasks)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 12 | 12 | 11 | 11/12 (n=12) 91.7% | — | — | — | — |

### Pass rate by hunks (all evaluated records)

| hunks | tasks | llm-jev |
| --- | --- | --- |
| 1 | 6 | 6/6 100.0% |
| 2 | 3 | 3/3 100.0% |
| 3 | 3 | 2/3 66.7% |

### Pass rate by difficulty (all evaluated records)

| difficulty | tasks | llm-jev |
| --- | --- | --- |
| 1 | 2 | 2/2 100.0% |
| 2 | 5 | 5/5 100.0% |
| 3 | 3 | 2/3 66.7% |
| 4 | 2 | 2/2 100.0% |

### Paired comparison (n = 12 tasks evaluated in every condition)

Paired tasks: `account`, `calendar_utils`, `events`, `grades`, `inventory`, `profiles`, `shipping`, `stats`, `table`, `tagcloud`, `textstats`, `units`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 11/12 (n=12) 91.7% |
| steps-to-solve mean (n passed) | 3.91 (n=11) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 5.25 (n=12) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 8 / 7 |
| Jev requests / questions | 505 / 741 |
| generator calls (jev-only asserts 0) | 114 |
| Jev latency p50 / p95 ms (n) | 131.30 / 255.69 (n=626) |
| mean generator tokens/step (steps) | 4913 (n=63) |
| mean Jev tokens/step (steps) | 9267 (n=63) |
| mean tokens/step, generator+Jev (steps) | 14180 (n=63) |
| wall time mean | 3m39s |
| wall time median | 1m49s |
| cost generator / Jev / total | $0.0404 / $0.0228 / $0.0632 |
| $ per solved task | $0.0057 |
| pass rate Wilson 95% | [64.6%, 98.5%] |
| generator.jsonl calls / samples / valid | 114 / 114 / 90 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 24 (1) |
| generator latency p50 / p90 ms, valid p50 / p90 | 6373 / 12293, 6416 / 12198 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0062 / 906 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 43m12s / 41s (n=63) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 114 / 46 / 0 / 1 / 23 / 0 |
| verify: candidates tested / passers / partials | 23937 / 24 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/12 | 0.0% |  |
| 2 | 4/12 | 33.3% | ███████ |
| 3 | 6/12 | 50.0% | ██████████ |
| 4 | 7/12 | 58.3% | ████████████ |
| 5 | 8/12 | 66.7% | █████████████ |
| 6 | 9/12 | 75.0% | ███████████████ |
| 7 | 11/12 | 91.7% | ██████████████████ |
| 8 | 11/12 | 91.7% | ██████████████████ |
| 9 | 11/12 | 91.7% | ██████████████████ |
| 10 | 11/12 | 91.7% | ██████████████████ |
| 11 | 11/12 | 91.7% | ██████████████████ |
| 12 | 11/12 | 91.7% | ██████████████████ |
| 13 | 11/12 | 91.7% | ██████████████████ |
| 14 | 11/12 | 91.7% | ██████████████████ |
| 15 | 11/12 | 91.7% | ██████████████████ |
| 16 | 11/12 | 91.7% | ██████████████████ |
| 17 | 11/12 | 91.7% | ██████████████████ |
| 18 | 11/12 | 91.7% | ██████████████████ |
| 19 | 11/12 | 91.7% | ██████████████████ |
| 20 | 11/12 | 91.7% | ██████████████████ |
| 21 | 11/12 | 91.7% | ██████████████████ |
| 22 | 11/12 | 91.7% | ██████████████████ |
| 23 | 11/12 | 91.7% | ██████████████████ |
| 24 | 11/12 | 91.7% | ██████████████████ |
| 25 | 11/12 | 91.7% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 5213 (n=12) | ███████████ |
| 2 | 4428 (n=12) | █████████ |
| 3 | 4414 (n=8) | █████████ |
| 4 | 5713 (n=6) | ████████████ |
| 5 | 5059 (n=5) | ██████████ |
| 6 | 7213 (n=4) | ███████████████ |
| 7 | 3536 (n=3) | ███████ |
| 8 | 4665 (n=1) | ██████████ |
| 9 | 8999 (n=1) | ███████████████████ |
| 10 | 0 (n=1) |  |
| 11 | 0 (n=1) |  |
| 12 | 9696 (n=1) | ████████████████████ |
| 13 | 9480 (n=1) | ████████████████████ |
| 14 | 5615 (n=1) | ████████████ |
| 15 | 6757 (n=1) | ██████████████ |
| 16 | 6909 (n=1) | ██████████████ |
| 17 | 7375 (n=1) | ███████████████ |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 10819 (n=12) | ███████ |
| 2 | 11726 (n=12) | ███████ |
| 3 | 6195 (n=8) | ████ |
| 4 | 9504 (n=6) | ██████ |
| 5 | 10327 (n=5) | ██████ |
| 6 | 8995 (n=4) | █████ |
| 7 | 9222 (n=3) | ██████ |
| 8 | 0 (n=1) |  |
| 9 | 13638 (n=1) | ████████ |
| 10 | 0 (n=1) |  |
| 11 | 0 (n=1) |  |
| 12 | 5244 (n=1) | ███ |
| 13 | 0 (n=1) |  |
| 14 | 33264 (n=1) | ████████████████████ |
| 15 | 0 (n=1) |  |
| 16 | 12450 (n=1) | ███████ |
| 17 | 26816 (n=1) | ████████████████ |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 16032 (n=12) | ████████ |
| 2 | 16154 (n=12) | ████████ |
| 3 | 10609 (n=8) | █████ |
| 4 | 15217 (n=6) | ████████ |
| 5 | 15386 (n=5) | ████████ |
| 6 | 16208 (n=4) | ████████ |
| 7 | 12758 (n=3) | ███████ |
| 8 | 4665 (n=1) | ██ |
| 9 | 22637 (n=1) | ████████████ |
| 10 | 0 (n=1) |  |
| 11 | 0 (n=1) |  |
| 12 | 14940 (n=1) | ████████ |
| 13 | 9480 (n=1) | █████ |
| 14 | 38879 (n=1) | ████████████████████ |
| 15 | 6757 (n=1) | ███ |
| 16 | 19359 (n=1) | ██████████ |
| 17 | 34191 (n=1) | ██████████████████ |
| 18 | 0 (n=1) |  |
| 19 | 0 (n=1) |  |
| 20 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 11 | ████████████████████ |
| max_replans | 1 | ██ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| account | fail | 20 | 0 | 11m54s | $0.0214 |
| calendar_utils | pass | 7 | 0 | 5m46s | $0.0075 |
| events | pass | 3 | 0 | 1m49s | $0.0020 |
| grades | pass | 2 | 0 | 1m6s | $0.0014 |
| inventory | pass | 4 | 0 | 2m48s | $0.0037 |
| profiles | pass | 2 | 0 | 46s | $0.0010 |
| shipping | pass | 5 | 0 | 5m56s | $0.0052 |
| stats | pass | 2 | 0 | 33s | $0.0011 |
| table | pass | 7 | 0 | 8m30s | $0.0116 |
| tagcloud | pass | 2 | 0 | 13s | $0.0010 |
| textstats | pass | 3 | 0 | 1m20s | $0.0021 |
| units | pass | 6 | 0 | 3m7s | $0.0053 |

