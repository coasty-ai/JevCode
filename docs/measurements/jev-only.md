# Jev-only: a coding agent with no generating LLM

`jevcode run "…" --mode jev-only` runs the whole loop with **no generating model at all**. The generator slot
holds a null provider that throws if anything calls it, and the bench marks a record invalid if any generator
call, token or dollar appears on it.

In place of "ask a model for a patch": **code proposes** candidate edits, **the decision model decides** where
to look and which candidate to prefer, and **tests verify**. A candidate is committed only when the goal's
failing tests pass and the regression suite shows nothing newly failing. The decision model never marks a fix
correct on its own.

Design: [`docs/JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md).
Dated log: [`docs/JEV-ONLY.md`](../JEV-ONLY.md).
Reports: [`experiments/results/jev-only-rungs-1-2.md`](../../experiments/results/jev-only-rungs-1-2.md) and
[`experiments/results/jev-only-audit.md`](../../experiments/results/jev-only-audit.md).

## Why this can work at all

Program repair was search before it was generation. Systems built on mutation operators, fix templates and
"donor" code copied from elsewhere in the same project fixed real bugs long before code models existed. Their
bottleneck was **ranking**: thousands of candidates, a handful correct, tests too slow to try them all.

A decision model is a fast, calibrated, general ranker that reads the failing test and the code. It does not
generate text. So the question this mode answers by experiment is which decomposition of "write a fix" into
proposals and decisions works, and how far it reaches.

## What proposes, and what decides

**Code proposes.** The wired candidate sources, in the order the search runs them:

| source | what it enumerates | directory |
| --- | --- | --- |
| mutation operators | operator swaps, off-by-one, index flips, argument swaps, negations, constants taken from literals in the test | `src/synth/mutate/` |
| fix templates | guards, missing return, missing import, wrong attribute, wrong call target, missing `else`, boundary conditions, plus callee substitution carrying its import and depth-2 wraps | `src/synth/templates/` |
| donor lines | lines and statements from elsewhere in the repository that reference the same identifiers, with identifiers re-bound | `src/synth/donor/` |
| composite pairs and units | depth-2 pairs of the top single edits, and multi-line units, over the same three seed sources — so pairs are pairs of what actually ran | `src/synth/search/composite.ts` |
| sketches, slot filling and a token beam | new lines built from grammar productions and in-scope identifiers, beam-searched | `src/synth/sketch/`, `fill/`, `beam/` |
| repository history | past commits that touched the same function or symbol, replayed as reversals at the site | `src/synth/history/` |

Two more directories are often mistaken for sources and are not. `src/synth/introspect/` supplies names
introspected from the failing call, which feed the template source rather than forming their own slot.
`src/synth/sbfl/` is spectrum-based fault localisation and `src/synth/py/` is Python structure analysis — both
are infrastructure the sources and the ranking read.

One more source, the generating model, exists in the code and is wired only under the `llm-jev` mode. Under
`jev-only` the factory returns the search with no model source at all.
<!-- src/synth/index.ts createSynthesizer: mode 'jev-only' returns LedgerSieveSynthesizer(searchDeps()) with no llm wiring. -->

**The decision model decides.** Which files and functions to look at; which failing behaviour to attack first;
which of several test-passing patches is the genuine fix; the kind of change the task calls for; and every
decision the ordinary loop already makes — intent, context, risk, judge, completion, replan.

**Tests verify.** Always. There is no path on which a probability commits a patch.

## The architecture in one paragraph

The design is "Ledger + Sieve". A **ledger** of goals, one per cluster of failing tests, is attacked one goal per
outer step. Partial progress is held as a second base and survives being parked; regressions are never kept. The
**sieve** runs every candidate at a site through the goal's tests when one run is cheap and asks the decision
model to rank only when it is not. The threshold is a measured constant: **2,000 ms**.
<!-- src/synth/search/budget.ts: SIEVE_MAX_T_RUN_MS = 2000; QUIXBUGS_CLASS_MAX_T_RUN_MS = 2000. -->

On a repository task with no failing test in the workspace, an **issue oracle** extracts reproduction blocks from
the issue text, the decision model judges which block reproduces the bug and which lines show expected and
observed behaviour, and code builds a runnable script with a code-computed pass criterion that must fail on the
base commit. Repository mode makes that script the goal, localises once from the traceback, scopes the regression
suite to at most six related test files, and detects the native test runner.

A **guard** clusters test-passing candidates by their behaviour on inputs perturbed from the visible tests, holds
a lone passer that carries a structural suspicion signal until its site's sources have run, and asks the decision
model to arbitrate between clusters.

## The difficulty ladder

The rungs were fixed in advance and each gates the next.

| rung | data | what it measures | threshold to proceed |
| --- | --- | --- | --- |
| 1a | QuixBugs Python, 40 one-line-bug programs, 3 repeats | repaired, correct, steps, requests, runs, cost, wall, failure class per miss | ≥ 36/40 repaired in every repeat, ≥ 34 correct, 0 regressions kept, ≤ $0.01 and ≤ 150 s per program |
| 1b | the four insertion programs plus one more, 3 repeats | gap-site enumeration, gold statement rank | ≥ 3/4 insertions repaired in ≥ 2 of 3 repeats |
| 2 | an internal 12-task multi-hunk ladder, 3 repeats | solved, steps, commits, reverts, parks, goals formed against edits needed | ≥ 8/12 in ≥ 2 of 3 repeats; the 5 multi-bug tasks ≥ 4/5; 0 regressions kept |
| 3a | the nine coverage-reachable repository instances, offline | the minimal subset of gold edits that passes | informs; no gate |
| 3b | 33 repository lines and 21 ladder edits, offline | where the gold candidate ranks among the real candidate set | gold in the top 5 on ≥ 6 of 9 |
| 3c | SWE-bench Verified, 30 instances, live | pass under the local evaluator, regressions, cost, wall, failure taxonomy, and zero generator calls | **any instance resolved is the result** |

## Results

Every number traces to the run directory named. **"Repaired" and "correct" are separate columns on every row.**
There is no hidden test suite for QuixBugs or the ladder: the evaluator runs the cases the workspace exposes, so
"repaired" means "passes the reference cases", and correctness is a separate check by a verdict script
(gold-identical, or equivalent to gold on the reference cases, on perturbed inputs, and — for the graph programs
— on 500 random structures per program).

The rows marked **final tree** ran from a frozen worktree at build `55404ba`, one run each.

### QuixBugs, 40 programs

| run | repaired | correct | overfits | cost | misses |
| --- | --- | --- | --- | --- | --- |
| run 3 | 36/40 | 34/40 (27 gold-identical + 7 equivalent) | 2 — `detect_cycle`, `wrap` | $0.165 | `depth_first_search`, `longest_common_subsequence`, `reverse_linked_list`, `shunting_yard` |
| repeat 1 | 38/40 | 35/40 (28 + 7) | 3 — `wrap`, `topological_ordering`, `detect_cycle` | $0.134 | `longest_common_subsequence`, `shortest_path_length` |
| repeat 2 | 38/40 | 36/40 (28 + 8) | 2 — `topological_ordering`, `detect_cycle` | $0.126 | `shortest_path_length`, `sqrt` |
| **final tree** | **39/40** | **37/40** (30 + 7) | **2** — `topological_ordering`, `detect_cycle` | $0.185 | `shortest_path_length` |

Four-run series: 36, 38, 38, 39 repaired; 34, 35, 36, 37 correct. The final tree is a single run.

### The internal ladder

| run | repaired | correct | overfits | cost |
| --- | --- | --- | --- | --- |
| short tier (12), round 4 | 11/12 | not scored | — | $0.137 |
| short tier (12), round 5 | 11/12 | 7/12 (5 gold-identical + 2 equivalent) | 4 — strong `grades`, `textstats`, `units`; weak-only `stats` | $0.177 |
| **short tier (12), final tree** | **12/12** | **8/12** (5 + 3) | **4** — strong `grades`, `textstats`; weak-only `stats`, `units` | $0.051 |
| long tier (8), runs 1, 1b, 2 | 2/8; then 1/4 of four re-authored tasks; then 2/8 | not scored | — | $0.246, $0.176, $0.266 |
| **long tier (8), final tree** | **2/8** — `import_and_guard` (9 steps), `ledger5` (13) | **1/8** (`import_and_guard`, equivalent on 295 inputs) | `ledger5` weak-only | $0.269 |

On the final-tree short tier every run completes in 3–7 steps, with zero blocked, declined, loop or read events.
Counting weak-only divergences as correct, the short tier is 10/12.

On the final-tree long tier, gold-identical edits by strict diff against the reference: `ledger5` 2/5,
`import_and_guard` 2/4, `long_chain` 3/6, `regress_trap` 3/4, `six_hunks` 1/6, `masked` 0/3, `crossfile` 0/4,
`shared_frame` 0/2.

### SWE-bench Verified, 30 instances

| run | result | cost | note |
| --- | --- | --- | --- |
| first attempt | **0** of 20 evaluated records; every patch empty | $0.60 | no failing test in the workspace; wrong runner for two repositories |
| issue oracle over the 30 | valid on **9/30** (7 strong, 2 weak) | $0.0096 | fails on the base commit, passes with the gold patch |
| the nine oracle instances | **1/9** — `sympy__sympy-19954` (8 steps) | $0.106, $0.198 | the first instance solved with no generating model |
| budget round | 1 pass of 8 records | $0.462 | the process died at an 8 GB heap after eight records |
| wired tree | **1/30** — `django__django-15128` (4 steps) | $1.16, 55 min | oracle found 10/30; nine instances hit a wiring defect, fixed and re-run below |
| **full 30, final tree** | **4/30** — `sympy__sympy-15345` (4 steps), `sympy__sympy-17139` (4), `sympy__sympy-19954` (6), `django__django-15128` (4) | $1.30, 68 min | **0 generator calls**; 348 steps, 228 blocked proposals, 88 loop trips; peak memory 4.5 GiB |

The series across the four full runs is 0/30 → 1/30 → 1/30 → 4/30, with the first two dying early.

The evaluator is **unofficial**: it replicates the official evaluation script without Docker, by building a
virtual environment at the instance's setup commit, checking out the base commit, applying the model patch and
the test patch, running the test command on the test files named in the test patch, and grading with ported log
parsers under the official rule. On each of the four solved instances the required-to-pass tests all pass and the
listed must-not-break tests all pass.

**None of the four has the upstream fix's shape.** They are accepted by the tests and were not shown equivalent
to the maintainers' patches.

## Cost and wall

A full QuixBugs run costs **$0.13–0.19** and 12–16 minutes of wall for the 40 programs, at a median of 3–4 steps
per program. On the final tree, 36 of 40 programs finish in exactly 3 steps.

Every record carries `generatorCalls: 0`.
<!-- Verified over bench/results/jev-only-quixbugs-7-final/tasks.jsonl: 40 records, generatorCalls === 0 on all 40, pass on 39. -->

## In-sample disclosure

**Every QuixBugs and ladder figure above is in-sample for the constants listed here.** Each of these was set or
moved after a live run on a named program, and no run without it has been repeated. None is keyed on a program
name, but each was tuned against the programs whose score is quoted.

| constant | module | program it was tuned against |
| --- | --- | --- |
| the suspicion-escape minimum, 0.9 → 0.8 | `src/synth/search/guard.ts` | `wrap` |
| the localisation-question fallback minimum, 0.2 | `src/synth/search/sites.ts` | `reverse_linked_list` |
| the lone-passer hold and vouch rules | `src/synth/search/guard.ts` | `detect_cycle` |
| the perturbed-input probe | `src/synth/search/perturb.ts` | `detect_cycle`, `wrap` |
| the skew-aware per-case timeout and its load scaling | `src/synth/search/budget.ts` | `longest_common_subsequence`, `sqrt`, `bitcount`, `shunting_yard` |
| the insertion-site anchors | `src/synth/search/sites.ts`, `src/synth/localize/sites.ts` | `shunting_yard`, `reverse_linked_list`, `depth_first_search`, `wrap` |
| the vocabulary pre-check's import-path exemption | `src/synth/sieve/queue.ts` | ladder `tagcloud` |

Separately, the wording of one question's options embeds **ten QuixBugs gold fixes verbatim** as examples, and
that wording is sent to the decision model on every QuixBugs run. Those ten programs are in-sample by
construction. Both lists are what the [out-of-sample slice](out-of-sample.md) was built to exclude.

The repository disclosure is different in kind: no constant names a repository instance, but the four solved
instances were among the nine reach-study targets whose missing capabilities were added before that run. **It is
a development-set number.**

## The two overfits on the final tree, named

Both pass every reference case the workspace exposes.

**`topological_ordering`.** The committed patch drops a superset check and adds a `break`. It is wrong on
**252 of 500** random directed acyclic graphs — for example, with edges E→B and E→C, node C is dropped.

**`detect_cycle`.** The committed patch differs from the reference on a single input, the empty list: it raises
an attribute error where the reference returns `False`. That is 1 of 500 random structures.

The miss on the final tree is `shortest_path_length`, where a literal `return 4` was committed as a
"possible overfit" release before the task's spend cap fired. That program was gold-identical in run 3 and missed
in all three later runs — a persistent regression, recorded as one.

## Was it really the decision model and nothing else?

An independent read-only audit tried to falsify the claim. Its verdicts:

| item | verdict |
| --- | --- |
| no other model is reachable on any path | **pass** — three model endpoints exist in the tree; in this mode only the decision endpoint is reachable, and the generator slot is a null provider on both the CLI and the bench paths, with the engine throwing before the provider on top of that |
| the bench asserts zero generator usage and the results carry it | **pass** — every finished record across 21 result sets has zero generator calls, zero tokens and zero generator dollars |
| hidden non-decision "intelligence" in the search | **partial** — no fix tables, no gold lookup, no program-name keys; but one question's option wording embeds ten gold fixes verbatim |
| design questions against implementation | **partial** — one designed question was never asked at all; several judgement-bearing thresholds are code constants, two of them retuned to named programs after live runs |
| secrets hygiene | **pass**, with one gap — the bench's per-task result file is written without a redaction pass and evaluator reason strings carry raw subprocess output |
| measurement honesty | **partial** — "solved" is the evaluator's verdict and never the agent's claim, but with no hidden suite it means "passes the visible suite", and one early "correct by inspection" count had no per-program list behind it |

The two partial verdicts are why the correctness column exists on every row above, and why the in-sample
disclosure is printed rather than summarised.

## What this establishes

A coding agent with no generating model at all repairs **39 of 40** classic one-line-bug programs for about
eighteen cents, is **correct** on 37 of them, solves **12 of 12** short multi-hunk tasks, and resolves **4 of 30**
real repository instances under an unofficial evaluator.

The QuixBugs and ladder numbers are in-sample for the constants listed above. The repository number is a
development-set number. Nothing here is a claim about a set nobody inspected.

## Related

- [llm-jev vs generator-only](head-to-head.md) — the same search with a generating model added as a candidate
  source.
- [Out of sample](out-of-sample.md) — where the ladder long tier gives 2/8 for this mode and 3/8 with a generator.
- [Measurements index](README.md).
