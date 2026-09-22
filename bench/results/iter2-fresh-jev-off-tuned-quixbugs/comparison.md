# JevCode bench 20260922-170654-368961

Generated 2026-09-22T17:07:46.765Z. Generator model `z-ai/glm-5.3-flash`. 8 task records, suites: quixbugs.

## Conditions

All conditions run the same limits and sandbox; jev-on and jev-off share the same generator, system prompt and user-message layout. They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step (the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`; **jev-only** has no generating LLM at all: the generator slot is a NullProvider that throws if called (a record with any generator usage is marked `invalid` and excluded from the evaluated set), a code Synthesizer proposes from search over candidate edits, Jev selects, tests verify, and intent, context, risk, judge and replan run as in jev-on. `read`-action counts are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only. **llm-jev** (docs/LLM-JEV-DESIGN.md) is the full engine with the Synthesizer AND the real generator: the LLM writes candidate patches inside the synthesizer (parallel samples with per-sample deadlines, seeds racing them), Jev localises and arbitrates, shadow lanes verify, risk on verified proposals and the judge are code facts; generator calls are recorded per sample and never asserted zero. Two attribution arms share its tasks and limits: **llm-sieve** is llm-jev with zero Jev requests — the decider slot holds a stub that answers every question deterministically (Noul 0.5, first option, harm level 0) and counts them (`stubbed`), while the synthesizer replaces every question by its code default (the runner refuses a synthesizer arm whose synthesizer does not acknowledge the mode and the pinned generation, so an arm never runs as another one); **jev-off-tuned** is jev-off behind a provider that applies the §4 generator hygiene (max_tokens 1,500 with one doubling after a `length` stop, reasoning effort low, a 20 s per-call deadline that drops the call — no retry, the step ends — and meters it from an estimate, plan capped at 200 chars). Generation parameters are PINNED per arm (the table below); jev-off runs exactly the checked-in baseline parameters, never the user config.

| condition | engine mode | generator | decider | temperature | maxTokens | reasoning | deadline | served rate | max steps | max wall | per-run cap | sandbox | command timeout | output cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | jev-off | z-ai/glm-5.3-flash | — | not sent | 1500 (×2 once on length) | effort low | 20s / 30s repo | $0.15/$0.5 per M | 12 | 8m | $0.0600 | auto | 2m | 200 KB |

## Spend

Bench cap $0.5000, per-run cap $0.0600; spent generator $0.0192 + Jev $0.0000 = $0.0192. Bench cap fired: no. Pairs not run: 0.

## QuixBugs Python (40 one-line bugs)


### Pass rate per condition (all records)

| condition | tasks | evaluated | passed | pass rate | unevaluated | unsupported | not run | model drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-off-tuned | 8 | 8 | 8 | 8/8 (n=8) 100.0% | — | — | — | — |

### Pass rate by bug kind (all evaluated records)

| kind | tasks | jev-off-tuned |
| --- | --- | --- |
| argument_swap | 3 | 3/3 100.0% |
| operator | 1 | 1/1 100.0% |
| other | 1 | 1/1 100.0% |
| wrong_call | 1 | 1/1 100.0% |
| wrong_variable | 2 | 2/2 100.0% |

### Paired comparison (n = 8 tasks evaluated in every condition)

Paired tasks: `quicksort`, `rpn_eval`, `shortest_path_lengths`, `shortest_paths`, `sieve`, `subsequences`, `to_base`, `topological_ordering`. Excluded for model drift: —. Incomplete pairs: —.

| metric | jev-off-tuned |
| --- | --- |
| pass rate (passed/evaluated) | 8/8 (n=8) 100.0% |
| steps-to-solve mean (n passed) | 6.25 (n=8) |
| steps-to-solve median | 5 |
| steps used mean (n runs) | 6.25 (n=8) |
| steps used median | 5 |
| read actions total / mean per run | 16 / 2 |
| blocked / reviews / declined | 0 / 0 / 0 |
| loops / replans | 1 / 0 |
| Jev requests / questions | 0 / 0 |
| generator calls (jev-only asserts 0) | 51 |
| Jev latency p50 / p95 ms (n) | null / null (n=0) |
| mean generator tokens/step (steps) | 2428 (n=50) |
| mean Jev tokens/step (steps) | 0 (n=50) |
| mean tokens/step, generator+Jev (steps) | 2428 (n=50) |
| wall time mean | 20s |
| wall time median | 12s |
| cost generator / Jev / total | $0.0192 / $0.0000 / $0.0192 |
| $ per solved task | $0.0024 |
| pass rate Wilson 95% | [67.6%, 100.0%] |
| generator.jsonl calls / samples / valid | 51 / 0 / 50 |
| generator malformed / length / dropped (timeouts) | 1 / 0 / 0 (0) |
| generator latency p50 / p90 ms, valid p50 / p90 | 1732 / 5766, 1627 / 5755 |
| generator estimated $ (dropped samples) / reasoning tokens | $0.0000 / 1554 |
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
| 4 | 3/8 | 37.5% | ████████ |
| 5 | 5/8 | 62.5% | █████████████ |
| 6 | 5/8 | 62.5% | █████████████ |
| 7 | 6/8 | 75.0% | ███████████████ |
| 8 | 6/8 | 75.0% | ███████████████ |
| 9 | 6/8 | 75.0% | ███████████████ |
| 10 | 7/8 | 87.5% | ██████████████████ |
| 11 | 8/8 | 100.0% | ████████████████████ |
| 12 | 8/8 | 100.0% | ████████████████████ |

### Tokens per step (paired; mean input+output tokens over runs that reached the step, per source and combined)

#### generator tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1784 (n=8) | ██████████ |
| 2 | 2082 (n=8) | ████████████ |
| 3 | 2525 (n=8) | ███████████████ |
| 4 | 2300 (n=8) | █████████████ |
| 5 | 2475 (n=5) | ██████████████ |
| 6 | 2576 (n=3) | ███████████████ |
| 7 | 2889 (n=3) | █████████████████ |
| 8 | 3159 (n=2) | ██████████████████ |
| 9 | 3257 (n=2) | ███████████████████ |
| 10 | 3396 (n=2) | ████████████████████ |
| 11 | 3480 (n=1) | ████████████████████ |

#### Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 0 (n=8) |  |
| 2 | 0 (n=8) |  |
| 3 | 0 (n=8) |  |
| 4 | 0 (n=8) |  |
| 5 | 0 (n=5) |  |
| 6 | 0 (n=3) |  |
| 7 | 0 (n=3) |  |
| 8 | 0 (n=2) |  |
| 9 | 0 (n=2) |  |
| 10 | 0 (n=2) |  |
| 11 | 0 (n=1) |  |

#### generator+Jev tokens per step

| step | jev-off-tuned mean tokens (n) | jev-off-tuned |
| --- | --- | --- |
| 1 | 1784 (n=8) | ██████████ |
| 2 | 2082 (n=8) | ████████████ |
| 3 | 2525 (n=8) | ███████████████ |
| 4 | 2300 (n=8) | █████████████ |
| 5 | 2475 (n=5) | ██████████████ |
| 6 | 2576 (n=3) | ███████████████ |
| 7 | 2889 (n=3) | █████████████████ |
| 8 | 3159 (n=2) | ██████████████████ |
| 9 | 3257 (n=2) | ███████████████████ |
| 10 | 3396 (n=2) | ████████████████████ |
| 11 | 3480 (n=1) | ████████████████████ |

Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.

### Stop reasons (all records)

| stop reason | jev-off-tuned |  |
| --- | --- | --- |
| generator_done | 8 | ████████████████████ |

### Per task (paired)

| task | jev-off-tuned pass | jev-off-tuned steps | jev-off-tuned reads | jev-off-tuned wall | jev-off-tuned cost |
| --- | --- | --- | --- | --- | --- |
| quicksort | pass | 4 | 1 | 10s | $0.0014 |
| rpn_eval | pass | 7 | 2 | 39s | $0.0027 |
| shortest_path_lengths | pass | 5 | 2 | 9s | $0.0018 |
| shortest_paths | pass | 5 | 2 | 12s | $0.0018 |
| sieve | pass | 4 | 1 | 9s | $0.0014 |
| subsequences | pass | 11 | 4 | 39s | $0.0052 |
| to_base | pass | 10 | 3 | 30s | $0.0038 |
| topological_ordering | pass | 4 | 1 | 13s | $0.0012 |

