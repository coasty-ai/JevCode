# JevCode bench 20260922-065758-778361

Generated 2026-09-22T07:03:12.369Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0600; spent generator $0.0260 + Jev $0.0000 = $0.0260. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 10 | 10 | 10 | 10/10 (n=10) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-off-tuned |
| --- | --- | --- |
| control_flow | 1 | 1/1 100.0% |
| missing_condition | 1 | 1/1 100.0% |
| off_by_one | 5 | 5/5 100.0% |
| other | 2 | 2/2 100.0% |
| wrong_variable | 1 | 1/1 100.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `breadth_first_search`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `knapsack`, `lcs_length`, `levenshtein`, `next_palindrome`, `pascal`, `powerset`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 10/10 (n=10) 100.0% |
| steps-to-solve mean (n passed) | 8.20 (n=10) |
| steps-to-solve median | 6 |
| steps used mean (n runs) | 8.20 (n=10) |
| steps used median | 6 |
| read actions total / mean per run | 20 / 2 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 6 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 82 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 2225 (n=82) |
| mean Jev tokens/step (steps) | 0 (n=82) |
| mean tokens/step, generator+Jev (steps) | 2225 (n=82) |
| wall time mean | 1m45s |
| wall time median | 1m18s |
| cost generator / Jev / total | $0.0260 / $0.0000 / $0.0260 |
| $ per solved task | $0.0026 |
| pass rate Wilson 95% | [72.2%, 100.0%] |
| generator.jsonl calls / samples / valid | 82 / 0 / 61 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 21 (21) |
| generator latency p50 / p90 ms, valid p50 / p90 | 14776 / 20002, 10742 / 18513 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0064 / 1579 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 0ms / null (n=0) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 0 / 0 / 0 / 0 / 0 / 0 |
| verify: candidates tested / passers / partials | 0 / 0 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | jev-off-tuned solved(k) | jev-off-tuned fraction | jev-off-tuned |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 0/10 | 0.0% |  |
| 3 | 0/10 | 0.0% |  |
| 4 | 1/10 | 10.0% | ██ |
| 5 | 4/10 | 40.0% | ████████ |
| 6 | 5/10 | 50.0% | ██████████ |
| 7 | 5/10 | 50.0% | ██████████ |
| 8 | 5/10 | 50.0% | ██████████ |
| 9 | 5/10 | 50.0% | ██████████ |
| 10 | 6/10 | 60.0% | ████████████ |
| 11 | 7/10 | 70.0% | ██████████████ |
| 12 | 10/10 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1741 (n=10) | ███████████ |
| 2 | 1883 (n=10) | ████████████ |
| 3 | 2014 (n=10) | █████████████ |
| 4 | 2127 (n=10) | █████████████ |
| 5 | 2131 (n=9) | █████████████ |
| 6 | 2144 (n=6) | █████████████ |
| 7 | 2420 (n=5) | ███████████████ |
| 8 | 2322 (n=5) | ██████████████ |
| 9 | 2622 (n=5) | ████████████████ |
| 10 | 2868 (n=5) | ██████████████████ |
| 11 | 2988 (n=4) | ███████████████████ |
| 12 | 3207 (n=3) | ████████████████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=10) |  |
| 2 | 0 (n=10) |  |
| 3 | 0 (n=10) |  |
| 4 | 0 (n=10) |  |
| 5 | 0 (n=9) |  |
| 6 | 0 (n=6) |  |
| 7 | 0 (n=5) |  |
| 8 | 0 (n=5) |  |
| 9 | 0 (n=5) |  |
| 10 | 0 (n=5) |  |
| 11 | 0 (n=4) |  |
| 12 | 0 (n=3) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1741 (n=10) | ███████████ |
| 2 | 1883 (n=10) | ████████████ |
| 3 | 2014 (n=10) | █████████████ |
| 4 | 2127 (n=10) | █████████████ |
| 5 | 2131 (n=9) | █████████████ |
| 6 | 2144 (n=6) | █████████████ |
| 7 | 2420 (n=5) | ███████████████ |
| 8 | 2322 (n=5) | ██████████████ |
| 9 | 2622 (n=5) | ████████████████ |
| 10 | 2868 (n=5) | ██████████████████ |
| 11 | 2988 (n=4) | ███████████████████ |
| 12 | 3207 (n=3) | ████████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| generator_done | 7 | ████████████████████ |
| max_steps | 3 | █████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| breadth_first_search | pass | 12 | 4 | 3m14s | $0.0038 |
| get_factors | pass | 11 | 2 | 2m37s | $0.0036 |
| hanoi | pass | 10 | 3 | 2m21s | $0.0029 |
| is_valid_parenthesization | pass | 5 | 1 | 1m14s | $0.0014 |
| knapsack | pass | 5 | 1 | 1m18s | $0.0015 |
| lcs_length | pass | 6 | 1 | 1m13s | $0.0015 |
| levenshtein | pass | 4 | 1 | 43s | $0.0008 |
| next_palindrome | pass | 12 | 4 | 1m48s | $0.0044 |
| pascal | pass | 12 | 2 | 1m57s | $0.0048 |
| powerset | pass | 5 | 1 | 1m | $0.0013 |

