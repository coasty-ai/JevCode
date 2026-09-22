# JevCode bench 20260922-054441-2ba690

Generated 2026-09-22T05:46:52.173Z. Generator model `z-ai/glm-5.3-flash`. 10 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.6000, per-run cap $0.0600; spent generator $0.0027 + Jev $0.0051 = $0.0078. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 10 | 10 | 10 | 10/10 (n=10) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | llm-jev |
| --- | --- | --- |
| control_flow | 1 | 1/1 100.0% |
| missing_condition | 1 | 1/1 100.0% |
| off_by_one | 5 | 5/5 100.0% |
| other | 2 | 2/2 100.0% |
| wrong_variable | 1 | 1/1 100.0% |

### Paired comparison (n = 10 tasks evaluated in every condition)

Paired tasks: `breadth_first_search`, `get_factors`, `hanoi`, `is_valid_parenthesization`, `knapsack`, `lcs_length`, `levenshtein`, `next_palindrome`, `pascal`, `powerset`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 10/10 (n=10) 100.0% |
| steps-to-solve mean (n passed) | 2.70 (n=10) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 2.70 (n=10) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 54 / 257 |
| generator calls (jev-only asserts 0) | 14 |
| Jev latency p50 / p95 ms (n) | 184.73 / 333.78 (n=54) |
| mean generator tokens/step (steps) | 673 (n=27) |
| mean Jev tokens/step (steps) | 4695 (n=27) |
| mean tokens/step, generator+Jev (steps) | 5368 (n=27) |
| wall time mean | 44s |
| wall time median | 34s |
| cost generator / Jev / total | $0.0027 / $0.0051 / $0.0078 |
| $ per solved task | $0.0008 |
| pass rate Wilson 95% | [72.2%, 100.0%] |
| generator.jsonl calls / samples / valid | 14 / 14 / 8 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 6 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 4813 / 18597, 3962 / 19152 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0002 / 484 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 6m56s / 15s (n=27) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 14 / 4 / 0 / 0 / 2 / 0 |
| verify: candidates tested / passers / partials | 4390 / 21 / 0 |
| grace wait total / localisation missed / generic steps | 4s / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/10 | 0.0% |  |
| 2 | 4/10 | 40.0% | ████████ |
| 3 | 9/10 | 90.0% | ██████████████████ |
| 4 | 10/10 | 100.0% | ████████████████████ |
| 5 | 10/10 | 100.0% | ████████████████████ |
| 6 | 10/10 | 100.0% | ████████████████████ |
| 7 | 10/10 | 100.0% | ████████████████████ |
| 8 | 10/10 | 100.0% | ████████████████████ |
| 9 | 10/10 | 100.0% | ████████████████████ |
| 10 | 10/10 | 100.0% | ████████████████████ |
| 11 | 10/10 | 100.0% | ████████████████████ |
| 12 | 10/10 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 1818 (n=10) | ████████████████████ |
| 2 | 0 (n=10) |  |
| 3 | 0 (n=6) |  |
| 4 | 0 (n=1) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 8768 (n=10) | ████████████████████ |
| 2 | 2375 (n=10) | █████ |
| 3 | 2135 (n=6) | █████ |
| 4 | 2522 (n=1) | ██████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 10586 (n=10) | ████████████████████ |
| 2 | 2375 (n=10) | ████ |
| 3 | 2135 (n=6) | ████ |
| 4 | 2522 (n=1) | █████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 10 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| breadth_first_search | pass | 3 | 0 | 34s | $0.0005 |
| get_factors | pass | 2 | 0 | 31s | $0.0002 |
| hanoi | pass | 3 | 0 | 39s | $0.0003 |
| is_valid_parenthesization | pass | 2 | 0 | 19s | $0.0003 |
| knapsack | pass | 3 | 0 | 1m18s | $0.0009 |
| lcs_length | pass | 3 | 0 | 1m7s | $0.0010 |
| levenshtein | pass | 4 | 0 | 1m22s | $0.0026 |
| next_palindrome | pass | 2 | 0 | 37s | $0.0007 |
| pascal | pass | 3 | 0 | 27s | $0.0009 |
| powerset | pass | 2 | 0 | 30s | $0.0005 |

