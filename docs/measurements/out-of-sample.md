# Out of sample

The 28-task result on the [head-to-head page](head-to-head.md) is measured on the set the mode was built
against. This page is the first measurement on tasks it was not.

The short answer: inside the one-line-bug regime the mode transfers cleanly. Outside it, the extra decision
traffic buys one ladder task and no repository instance for about three times the money and three times the wall.

Report: [`experiments/results/llm-jev-headtohead-v2.oos.md`](../../experiments/results/llm-jev-headtohead-v2.oos.md).
Where the wall and the dollars went:
[`docs/research/llm-jev/oos-analysis-2026-09-22.md`](../research/llm-jev/oos-analysis-2026-09-22.md).
Dated entry: [`docs/LLM-JEV.md`](../LLM-JEV.md).

## The run

| | |
| --- | --- |
| build | `066816f` (both arms; the same build as the in-sample table) |
| generator | `z-ai/glm-5.3-flash` through OpenRouter |
| decision model | `jev-1.13.0` |
| control | `jev-off-tuned` — the generator-only arm with the tuned generation parameters, so the comparison is against the *strongest* generator-only arm, not the plain one |
| tasks | 22 paired: 10 QuixBugs programs, the whole 8-task ladder long tier, 4 SWE-bench Verified instances |
| repeats | one run per arm |
| warm verification plane | off (the default) |

## How the 22 tasks were chosen

The selection rules were fixed before the run and no task was picked by hand.

**QuixBugs — 10 programs.** Alphabetical order over the 30 programs not in the original 10, then drop:

- every program named in the in-sample constant disclosure of [`docs/JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md) §7;
- the ten programs whose gold fixes are quoted verbatim in the wording of one question's options — that wording is
  sent to the decision model on every QuixBugs run, so those programs are in-sample by construction;
- the cases that motivated a fix round on this mode.

Eighteen programs remained eligible. The first ten alphabetically were taken:
`breadth_first_search, get_factors, hanoi, is_valid_parenthesization, knapsack, lcs_length, levenshtein,
next_palindrome, pascal, powerset`.

**Ladder long tier — 8 tasks.** The whole tier: `crossfile, import_and_guard, ledger5, long_chain, masked,
regress_trap, shared_frame, six_hunks`. Two qualifications are recorded rather than hidden: `masked` is named in
a fix brief and `ledger5` was scored in an earlier round, so those two are *inspected* even if not *fitted*. They
fall on opposite sides of the result, and dropping both leaves the candidate 2/6 against the control's 1/6.

**SWE-bench Verified — 4 instances.** The first four instances in file order that are neither among the nine
instances for which the issue oracle is valid, nor ever solved by any arm in any committed run:
`sympy__sympy-13798, sympy__sympy-16792, sympy__sympy-20428, sympy__sympy-22080`.

All four are sympy. That is an artefact of the rule, not a choice: positions 1–5 of the instance file are all
oracle-valid sympy instances, and the first eligible non-sympy instance is much further down. **This is a
single-repository slice and must not be read as an estimate of SWE-bench Verified.**

## Pooled result, 22 paired tasks

| metric | `llm-jev` | `jev-off-tuned` |
| --- | --- | --- |
| pass | **13/22** (Wilson [39 %, 77 %]) | 12/22 ([35 %, 73 %]) |
| correct by verdict | 13/22 | 12/22 |
| discordant pairs, pass | **b = 2, c = 1**; both solved 11, neither 8; exact sign p = **0.500** | — |
| discordant pairs, correctness | b = 2, c = 1 (the loss is `masked`) | — |
| median wall, all tasks | 190.7 s (**1.385× against**) | 137.7 s |
| median wall, the 11 both solved | **37.8 s** (0.349×) | 108.2 s |
| per-task wall ratio, both solved | min 0.175 · p25 0.232 · **median 0.349** · p75 1.003 · max 3.035; slower on 3 of 11 | — |
| total cost | **$0.791779** (2.68× the control) | $0.295901 |
| of which **not** provider-reported | $0.699742 = **88.4 %** | $0.013829 = 4.7 % |
| decision requests | **2,330** | 0 |
| solved **and** self-terminated | 13/22 | 8/22 |
| stopped at wall / step cap / replan cap / replan stop | 1 / 0 / 3 / 4 | 0 / **14** / 0 / 0 |

`b = 2, c = 1` with p = 0.500 means: on pass rate, this is a tie. One extra task is well inside noise for 22 paired
observations.

**Censoring runs the other way from the in-sample table.** The control is bounded by its *step* budget — 14 of 22
records end at the step cap and none at the wall cap — while the candidate is bounded by *replans and wall*, 7 of
22. Both wall figures are right-censored, in different units. The both-solved row is the only one free of it, and
it covers 11 tasks of which 10 are QuixBugs.

**The cost basis is not symmetric.** 88.4 % of the candidate's dollars are estimate or rate card; 4.7 % of the
control's are. The 2.68× ratio is between a mostly-estimated number and a mostly-reported one.

## Per suite

| suite | arm | pass | Wilson | correct | overfit | median steps to solve | median wall, all / both solved | cost | cost per task | decision requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QuixBugs, 10 new | `llm-jev` | 10/10 | [72 %, 100 %] | 10 (8 gold-identical + 2 equivalent) | **0** | 3 | 34.0 s / 34.0 s | $0.007805 | $0.0008 | 54 |
| QuixBugs, 10 new | `jev-off-tuned` | 10/10 | [72 %, 100 %] | 10 (9 gold-identical + 1 equivalent) | **0** | 6 | 78.7 s / 78.7 s | $0.025969 | $0.0026 | 0 |
| ladder long tier, 8 | `llm-jev` | **3/8** | [14 %, 69 %] | 3 (1 gold-identical + 2 equivalent) | 0 | 10 | 512.1 s / 449.3 s | $0.395461 | $0.0494 | 1,532 |
| ladder long tier, 8 | `jev-off-tuned` | 2/8 | [7 %, 59 %] | 2 (both gold-identical) | 0 | 23 | 137.7 s / 148.0 s | $0.137945 | $0.0172 | 0 |
| SWE-bench Verified, 4 new | `llm-jev` | **0/4** | [0 %, 49 %] | 0 | 0 | — | 322.7 s | $0.388513 | $0.0971 | 744 |
| SWE-bench Verified, 4 new | `jev-off-tuned` | **0/4** | [0 %, 49 %] | 0 | 0 | — | 221.9 s | $0.131987 | $0.0330 | 0 |

Per-suite discordance: QuixBugs b = 0 / c = 0 (both solve all ten); ladder b = 2 (`import_and_guard`, `ledger5`) /
c = 1 (`masked`) / both 1 (`shared_frame`) / neither 4; SWE-bench b = 0 / c = 0 / neither 4.

## The three suites tell three different stories

### QuixBugs: a clean win on efficiency, none on capability

Both arms solve all ten programs. Both are 10/10 correct. **Neither produces a single overfit** — the first time
the guard's thresholds have been exercised on programs they were not fitted against, and they hold.

The candidate gets there in a median 3 steps, 34 s and $0.0008 per task, against 6 steps, 79 s and $0.0026. It is
slower on 2 of 10.

This is the regime the mode was built for, and inside it the result generalises.

### Ladder long tier: one extra task for 2.9× the money and 3.7× the wall

The candidate solves `import_and_guard` (6 steps, 3 min 10 s) and `ledger5` (14 steps, 8 min 30 s), which the
control misses at its step cap. Both arms solve `shared_frame`. The control solves `masked`, which the candidate
misses after 12 steps and 8 min 32 s. Four tasks defeat both arms.

The candidate spent 1,532 decision requests and $0.3955 against $0.1379.

Its stop reasons on the five misses are replan-stop (3) and replan-cap (2). It is exhausting its **planning**
budget, not its wall, on tasks whose planted defects span two to six coupled edits.

For reference: the mode with no generating model at all scored 2/8 on this same tier, so the combination of
generator and decision model adds one task over search alone here. See [Jev-only](jev-only.md).

### SWE-bench: both arms score zero

The candidate ends at the replan cap, at completion, at the wall cap and at a replan stop across the four
instances, and produced an empty patch on 3 of 4. The control ran all four to its step cap and produced empty
patches on 2 of 4.

One instance, `sympy__sympy-16792`, consumed $0.2178 and 432 decision requests before hitting the 25-minute cap.

**This is the most important number on the page.** The in-sample SWE-bench figure was 6/6. Those six were drawn
from the nine instances for which the issue oracle is valid. Four of the six had already been solved by the search
engine during development, and two of them have a capability shipped in the templates directory that names them in
its own source comment. On four instances chosen to be free of that selection, with no oracle and no fitted
capability, the mode reaches nothing.

**The repository result does not generalise in its present form.**

## Where the wall and the dollars actually went

An offline analysis of all 44 runs corrected the intuition the head-to-head invites. The decision model is not the
cost:

- **The decision model is 2–8 % of the wall** on every suite.
- **53–60 % of the wall is the search's own in-process enumerate-and-test sweep** — 35,064 shadow test runs on the
  ladder, 2,228 on the repository suite.
- **48 % (ladder) and 60 % (repository) of generator sample-seconds are zero-token timeouts** at the roughly 10 s
  adaptive deadline, re-fired unchanged.
- Of the 2,330 decision requests, **707 ranked pools that contained no passing candidate at all** — 99–100 % of
  them fired in steps where the passing count was zero, and 13 of 65,076 answers came back at or above 0.5. Those
  707 requests are 68 % of the decision dollars.
- **454 requests (19.5 %) repeated a request hash already issued in the same run.**
- Three question families produced exactly one distinct answer each across 51, 51 and 39 questions.

The five ladder losses are **generation failures, not selection failures**: the guard dropped nothing on any step,
four of five never produced one passing candidate over 6,500–13,000 enumerated seeds, and every replan chose to
gather more context and re-ran the same test command.

On QuixBugs the generating model contributed **0 of 25 passers**. What transfers is a nine-to-eleven-site
one-line candidate pool that is cheap enough to test exhaustively inside one round, so the first passer arrives
before any ranking happens at all — three ranking requests across ten tasks.

That analysis is what [Iterations 1–4](iterations.md) were written against.

## What is still unmeasured

- **The attribution arm.** `llm-sieve` — the same search with the generating model but no decision model — still
  raises a configuration error rather than running. Without it, "how much of the gain is the search" is **not yet
  measured**.
- **Any repeat run** of either arm on this slice.
- **A per-question ablation.** No question family has been removed and re-measured on its own.
- **A ladder correctness oracle that is independent of the engine.** Today the ladder verdict script shares its
  perturbation harness with the engine's own guard probe.

## Related

- [llm-jev vs generator-only](head-to-head.md) — the in-sample comparison this page is the control for.
- [Iterations 1–4](iterations.md) — the four rounds of changes written against the analysis above.
- [Measurements index](README.md).
