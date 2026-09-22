# JevCode bench 20260922-161809-0b2694

Generated 2026-09-22T16:22:30.710Z. Generator model `z-ai/glm-5.3-flash`. 8 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.5000, per-run cap $0.0600; spent generator $0.0107 + Jev $0.0067 = $0.0174. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 8 | 8 | 7 | 7/8 (n=8) 87.5% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | llm-jev |
| --- | --- | --- |
| argument_swap | 3 | 3/3 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 1 | 1/1 100.0% |
| wrong_call | 1 | 1/1 100.0% |
| wrong_variable | 2 | 1/2 50.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `quicksort`, `rpn_eval`, `shortest_path_lengths`, `shortest_paths`, `sieve`, `subsequences`, `to_base`, `topological_ordering`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 7/8 (n=8) 87.5% |
| steps-to-solve mean (n passed) | 2.86 (n=7) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 4 (n=8) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 3 / 3 |
| Jev requests / questions | 125 / 394 |
| generator calls (jev-only asserts 0) | 42 |
| Jev latency p50 / p95 ms (n) | 144.29 / 272.39 (n=152) |
| mean generator tokens/step (steps) | 2322 (n=32) |
| mean Jev tokens/step (steps) | 5378 (n=32) |
| mean tokens/step, generator+Jev (steps) | 7701 (n=32) |
| wall time mean | 1m9s |
| wall time median | 49s |
| cost generator / Jev / total | $0.0107 / $0.0067 / $0.0174 |
| $ per solved task | $0.0025 |
| pass rate Wilson 95% | [52.9%, 97.8%] |
| generator.jsonl calls / samples / valid | 42 / 42 / 17 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 25 (3) |
| generator latency p50 / p90 ms, valid p50 / p90 | 3557 / 17282, 6059 / 12006 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0056 / 399 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 8m59s / 16s (n=32) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 42 / 8 / 0 / 3 / 20 / 0 |
| verify: candidates tested / passers / partials | 4385 / 9 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 1/8 | 12.5% | ███ |
| 3 | 7/8 | 87.5% | ██████████████████ |
| 4 | 7/8 | 87.5% | ██████████████████ |
| 5 | 7/8 | 87.5% | ██████████████████ |
| 6 | 7/8 | 87.5% | ██████████████████ |
| 7 | 7/8 | 87.5% | ██████████████████ |
| 8 | 7/8 | 87.5% | ██████████████████ |
| 9 | 7/8 | 87.5% | ██████████████████ |
| 10 | 7/8 | 87.5% | ██████████████████ |
| 11 | 7/8 | 87.5% | ██████████████████ |
| 12 | 7/8 | 87.5% | ██████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 1571 (n=8) | ███ |
| 2 | 647 (n=8) | █ |
| 3 | 757 (n=7) | █ |
| 4 | 3318 (n=1) | ██████ |
| 5 | 5360 (n=1) | ██████████ |
| 6 | 7035 (n=1) | █████████████ |
| 7 | 7116 (n=1) | ██████████████ |
| 8 | 7575 (n=1) | ██████████████ |
| 9 | 10385 (n=1) | ████████████████████ |
| 10 | 10488 (n=1) | ████████████████████ |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 7672 (n=8) | ████████ |
| 2 | 1777 (n=8) | ██ |
| 3 | 3186 (n=7) | ███ |
| 4 | 19518 (n=1) | ████████████████████ |
| 5 | 8796 (n=1) | █████████ |
| 6 | 7144 (n=1) | ███████ |
| 7 | 13988 (n=1) | ██████████████ |
| 8 | 17840 (n=1) | ██████████████████ |
| 9 | 2893 (n=1) | ███ |
| 10 | 4024 (n=1) | ████ |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 9243 (n=8) | ███████ |
| 2 | 2425 (n=8) | ██ |
| 3 | 3942 (n=7) | ███ |
| 4 | 22836 (n=1) | ██████████████████ |
| 5 | 14156 (n=1) | ███████████ |
| 6 | 14179 (n=1) | ███████████ |
| 7 | 21104 (n=1) | █████████████████ |
| 8 | 25415 (n=1) | ████████████████████ |
| 9 | 13278 (n=1) | ██████████ |
| 10 | 14512 (n=1) | ███████████ |
| 11 | 0 (n=1) |  |
| 12 | 0 (n=1) |  |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 7 | ████████████████████ |
| max_steps | 1 | ███ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| quicksort | pass | 3 | 0 | 49s | $0.0005 |
| rpn_eval | pass | 2 | 0 | 46s | $0.0008 |
| shortest_path_lengths | pass | 3 | 0 | 52s | $0.0005 |
| shortest_paths | pass | 3 | 0 | 1m | $0.0005 |
| sieve | pass | 3 | 0 | 42s | $0.0005 |
| subsequences | pass | 3 | 0 | 44s | $0.0003 |
| to_base | pass | 3 | 0 | 1m | $0.0005 |
| topological_ordering | fail | 12 | 0 | 3m18s | $0.0140 |

