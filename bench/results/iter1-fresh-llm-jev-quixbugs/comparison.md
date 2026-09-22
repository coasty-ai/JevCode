# JevCode bench 20260922-113945-5ec834

Generated 2026-09-22T11:41:07.895Z. Generator model `z-ai/glm-5.3-flash`. 8 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | llm-jev | z-ai/glm-5.3-flash | jev-1.13.0 | per sample 0 / 0.8 | 3000 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.5000, per-run cap $0.0600; spent generator $0.0026 + Jev $0.0023 = $0.0049. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-jev | 8 | 8 | 8 | 8/8 (n=8) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | llm-jev |
| --- | --- | --- |
| argument_swap | 3 | 3/3 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 1 | 1/1 100.0% |
| wrong_call | 1 | 1/1 100.0% |
| wrong_variable | 2 | 2/2 100.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `quicksort`, `rpn_eval`, `shortest_path_lengths`, `shortest_paths`, `sieve`, `subsequences`, `to_base`, `topological_ordering`. Excluded for model drift: —. Incomplete pairs: —.

| metric | llm-jev |
| --- | --- |
| pass rate (passed/evaluated) | 8/8 (n=8) 100.0% |
| steps-to-solve mean (n passed) | 2.63 (n=8) |
| steps-to-solve median | 3 |
| steps used mean (n runs) | 2.63 (n=8) |
| steps used median | 3 |
| read actions total / mean per run | 0 / 0 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 0 / 0 |
| Jev requests / questions | 33 / 100 |
| generator calls (jev-only asserts 0) | 12 |
| Jev latency p50 / p95 ms (n) | 218.16 / 333.19 (n=33) |
| mean generator tokens/step (steps) | 915 (n=21) |
| mean Jev tokens/step (steps) | 2792 (n=21) |
| mean tokens/step, generator+Jev (steps) | 3706 (n=21) |
| wall time mean | 30s |
| wall time median | 24s |
| cost generator / Jev / total | $0.0026 / $0.0023 / $0.0049 |
| $ per solved task | $0.0006 |
| pass rate Wilson 95% | [67.6%, 100.0%] |
| generator.jsonl calls / samples / valid | 12 / 12 / 7 |
| generator malformed / length / dropped (timeouts) | 0 / 0 / 5 (3) |
| generator latency p50 / p90 ms, valid p50 / p90 | 13531 / 20001, 11235 / 17060 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0008 / 98 |
| stubbed Jev requests (llm-sieve) | 0 |
| synth wall total / per synth step (steps) | 3m55s / 11s (n=21) |
| verify: samples / distinct / malformed / timeouts / cancelled / misanchored | 12 / 4 / 0 / 3 / 2 / 0 |
| verify: candidates tested / passers / partials | 5756 / 12 / 0 |
| grace wait total / localisation missed / generic steps | 0ms / 0 / 0 |

### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)

| k | llm-jev solved(k) | llm-jev fraction | llm-jev |
| --- | --- | --- | --- |
| 1 | 0/8 | 0.0% |  |
| 2 | 3/8 | 37.5% | ████████ |
| 3 | 8/8 | 100.0% | ████████████████████ |
| 4 | 8/8 | 100.0% | ████████████████████ |
| 5 | 8/8 | 100.0% | ████████████████████ |
| 6 | 8/8 | 100.0% | ████████████████████ |
| 7 | 8/8 | 100.0% | ████████████████████ |
| 8 | 8/8 | 100.0% | ████████████████████ |
| 9 | 8/8 | 100.0% | ████████████████████ |
| 10 | 8/8 | 100.0% | ████████████████████ |
| 11 | 8/8 | 100.0% | ████████████████████ |
| 12 | 8/8 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 2401 (n=8) | ████████████████████ |
| 2 | 0 (n=8) |  |
| 3 | 0 (n=5) |  |

#### Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 4964 (n=8) | ████████████████████ |
| 2 | 1094 (n=8) | ████ |
| 3 | 2034 (n=5) | ████████ |

#### generator+Jev tokens per step

| step | llm-jev mean tokens (n) | llm-jev |
| --- | --- | --- |
| 1 | 7364 (n=8) | ████████████████████ |
| 2 | 1094 (n=8) | ███ |
| 3 | 2034 (n=5) | ██████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | llm-jev |  |
| --- | --- | --- |
| complete | 8 | ████████████████████ |

### Per task (paired)

| task | llm-jev pass | llm-jev steps | llm-jev reads | llm-jev wall | llm-jev cost |
| --- | --- | --- | --- | --- | --- |
| quicksort | pass | 3 | 0 | 53s | $0.0009 |
| rpn_eval | pass | 2 | 0 | 22s | $0.0007 |
| shortest_path_lengths | pass | 2 | 0 | 24s | $0.0006 |
| shortest_paths | pass | 3 | 0 | 31s | $0.0005 |
| sieve | pass | 3 | 0 | 23s | $0.0004 |
| subsequences | pass | 3 | 0 | 22s | $0.0004 |
| to_base | pass | 3 | 0 | 27s | $0.0004 |
| topological_ordering | pass | 2 | 0 | 35s | $0.0009 |

