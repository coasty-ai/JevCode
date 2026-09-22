# llm-jev vs generator-only

The `llm-jev` mode runs a search. Code enumerates candidate edits, a generating model contributes candidates
inside that search, the decision model localises and arbitrates, and the tests decide. The control arm,
`jev-off`, is the same harness with the generating model writing patches directly and no decision model at all.

This page holds the comparison on 28 tasks, both arms built from the same source tree.

Design of the mode: [`docs/LLM-JEV-DESIGN.md`](../LLM-JEV-DESIGN.md).
Dated log with the run identifiers: [`docs/LLM-JEV.md`](../LLM-JEV.md).
Reports: [`experiments/results/llm-jev-headtohead-v2.md`](../../experiments/results/llm-jev-headtohead-v2.md) and
[`experiments/results/llm-jev-headtohead-v2.oos.md`](../../experiments/results/llm-jev-headtohead-v2.oos.md),
with tool output in `llm-jev-headtohead-v2.samebuild.tool.md`.

## The run

| | |
| --- | --- |
| build | `066816f` (both arms) |
| generator | `z-ai/glm-5.3-flash` through OpenRouter |
| decision model | `typesafe/jev-1.13-20260917`, wire id `jev-1.13.0` |
| tasks | 28 paired: 10 QuixBugs programs, 12 short-tier ladder tasks, 6 SWE-bench Verified instances |
| repeats | one run per arm |
| warm verification plane | off (the default) |
| speculative routers | off (the default) |

The 28 tasks are the development set. The guard thresholds, the question wordings and several search constants
were tuned against named programs in this set. The in-sample disclosure that lists them is
[`docs/JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md) §7.

## Pooled result, 28 paired tasks

| metric | `llm-jev` | `jev-off`, same build | `jev-off` at an older build `214bf55` | `jev-off-tuned`, same build |
| --- | --- | --- | --- | --- |
| pass | **28/28** (Wilson [88 %, 100 %]) | **21/28** ([57 %, 87 %]) | 19/28 ([49 %, 82 %]) | 22/28 |
| correct by verdict | **26/28** ([77 %, 98 %]) | 20/28 ([53 %, 85 %]) | 19/28 | 20/28 |
| discordant pairs, pass | — | **b = 7, c = 0**; exact sign p = **0.0078** | b = 9, c = 0 | b = 6, c = 0 |
| discordant pairs, correctness | — | b = 8, c = 2; p = 0.0547 | b = 9, c = 2 | b = 6, c = 2 |
| median wall, all tasks | 63.0 s | 246.3 s (0.256×) | 390.8 s | 111.4 s |
| median wall, the 21 both solved | 39.5 s | 175.3 s (0.225×) | 111.8 s (n = 19) | — |
| per-task wall ratio, both solved | min 0.016 · p25 0.104 · **median 0.291** · p75 0.494 · max 1.745; slower on 1 of 21 | — | median 0.317, slower on 3 of 19 | — |
| total cost | **$0.144138** | $0.587483 | $0.506224 | $0.242607 |
| of which **not** provider-reported | $0.112487 = **78.0 %** | **$0** = 0 % | $0 = 0 % | $0.027478 estimated |
| decision requests | 482 | 0 | 0 | 0 |
| solved **and** self-terminated | 27/28 | 19/28 | — | — |
| stopped at the wall cap / at the step cap / error | 0 / 0 / 0 | **8** / 0 / 1 | 10 / 0 / 0 | 0 / 7 / 0 |

`b` is the count of tasks the candidate solved and the control did not; `c` is the reverse. The p-value is the
exact two-sided sign test on the b and c counts, which is the right test for paired pass/fail data and does not
assume anything about the tasks being equally hard.

The Wilson intervals are 95 % intervals on a binomial proportion at n = 28. At that sample size they are wide:
28/28 and 21/28 have intervals that do not overlap, but 22/28 and 21/28 are indistinguishable.

## Per suite

| suite | arm | pass | Wilson | correct | overfit | median steps to solve | median wall, all / both solved | cost | cost per solved | decision requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QuixBugs, 10 | `llm-jev` | **10/10** | [72 %, 100 %] | 9 | 1 | 3 | 36.7 s / 35.1 s | $0.026289 | $0.0026 | 105 |
| QuixBugs, 10 | `jev-off` | 8/10 | [49 %, 94 %] | 8 | 0 | 5 | 60.7 s / 59.9 s | $0.065571 | $0.0082 | 0 |
| ladder short tier, 12 | `llm-jev` | **12/12** | [76 %, 100 %] | 11 | 1 | 2 | 39.5 s / 58.4 s | $0.049762 | $0.0041 | 203 |
| ladder short tier, 12 | `jev-off` | 11/12 | [65 %, 99 %] | 10 | 1 | 9 | 200.5 s / 200.5 s | $0.142591 | $0.0130 | 0 |
| SWE-bench Verified, 6 | `llm-jev` | **6/6** | [61 %, 100 %] | 6 (= pass) | 0 | 2 | 133.7 s / 23.8 s | $0.068087 | $0.0113 | 174 |
| SWE-bench Verified, 6 | `jev-off` | 2/6 | [10 %, 70 %] | 2 (= pass) | 0 | 19 | 1500.0 s / 781.1 s | $0.379321 | $0.1897 | 0 |

Paired discordance per suite: QuixBugs b = 2 / c = 0 (p = 0.250); ladder b = 1 / c = 0; SWE-bench b = 4 / c = 0
(p = 0.063). Only the repository suite clears the bar that was registered for it in advance. QuixBugs and the
ladder fail their pre-registered criterion 1 against this stronger same-build baseline, and QuixBugs also fails
its wall criterion (median 0.604× against a bar of ≤ 0.5×) because the same-build baseline is so much faster than
the older one.

For repository instances, "correct" is defined as "the evaluator passed it". Nobody checked whether the patch has
the upstream fix's shape. It generally does not.

## Censoring is one-sided here

Eight of the control's 28 runs ended at the wall cap. None of the candidate's did. Nineteen of the control's runs
solved the task and stopped by themselves, against 27 of the candidate's.

This matters for the wall figures. A run that was cut off at its cap contributes a wall number that is a property
of the cap, not of the arm. The **both-solved** row — 39.5 s against 175.3 s over the 21 tasks both arms solved —
is the only wall comparison here that is free of it, and it is the one to quote.

The out-of-sample comparison has the mirror-image problem, in a different unit. See
[Out of sample](out-of-sample.md).

## The cost basis is not symmetric, and the difference is large

| arm | total | not provider-reported | what makes up the estimate |
| --- | --- | --- | --- |
| `llm-jev` | $0.144138 | **$0.112487 = 78.0 %** | generator estimate $0.013914, which is 30.5 % of its generator spend; decision spend $0.098573, every row rate-card (`costBasis: "table"`) |
| `jev-off` | $0.587483 | **$0 = 0 %** | 383 of 383 rows are provider-reported |

The decision endpoint does not return a per-request price, so every decision dollar in these tables is computed
from a published rate card against the token counts the harness measured. The generator's dollars are provider
reported where the response carried a usage block and estimated where it did not.

So the honest form of "four times cheaper" is: a mostly-estimated $0.1441 against a fully-reported $0.5875. The
direction is not in doubt at that size of gap. The precision is.

## What the baseline's own noise looks like

Before this run there was no same-build control. The plain `jev-off` arm had been measured at an older build,
`214bf55`, where it scored 19/28. Re-running the identical arm on the identical 28 tasks at `066816f` gives 21/28,
and the change is not a clean improvement — six of 28 tasks flip, four of them to pass:

| task | at `214bf55` | at `066816f` |
| --- | --- | --- |
| QuixBugs `mergesort` | fail at the wall cap, 480 s | **pass**, 175 s |
| ladder `account` | fail at the step cap, 600 s | **pass**, 457 s |
| ladder `calendar_utils` | fail at the wall cap, 720 s | **pass**, 178 s |
| ladder `table` | fail at the wall cap, 720 s | **pass**, 334 s |
| ladder `grades` | pass, 319 s | **fail** at the wall cap, 720 s |
| SWE-bench `sympy__sympy-11618` | pass, 393 s | **fail**, error, 858 s |

Six flips of 28 on a re-run of the same arm is a direct estimate of this baseline's run-to-run noise: about ±2
tasks. That is the same order as the discordance the out-of-sample comparison turns on. It is also why the bare
comparison "28/28 against 19/28" overstates the mode's own contribution by about two tasks, and why the row above
carries 19/28 only as a historical figure.

## The two correctness losses

The candidate solves every task and is still wrong twice, in both cases where the control is gold-identical:

- **`detect_cycle`** — the committed patch returns `None` on even-length acyclic chains.
- **`stats`** — the committed patch calls `values.remove(mid)`, which mutates the caller's list and breaks
  `median([2, 2])`.

The same-build baseline contributes one overfit of its own, ladder `calendar_utils`, which the candidate gets
gold-identical. That is why the correctness discordance is b = 8 / c = 2 rather than 9 / 2.

One more honesty note carried by the verification of this report: the ladder task `units` is labelled *equivalent*
by an oracle that is the search engine's own perturbation probe, and that oracle is blind to decimal and
scientific-notation string inputs. Every ladder correctness count here carries that upward bias, for **both** arms.

## The pre-registered criteria, and why some of them cannot pass

The bars this arm was judged against were written before any of it ran, and they were written as **absolute
counts** for a much larger set: 40 QuixBugs programs, 20 ladder tasks, 30 repository instances. The run above
used 10, 12 and 6. The bars were applied verbatim anyway.

That has a consequence worth stating plainly: **some criteria are unreachable by construction at this sample
size.** A bar of "at least eight more tasks solved than the control" cannot be met on a suite of ten where the
control already solves eight. Reporting it as "failed" is correct and also uninformative.

Against the same-build controls:

Two criteria were re-evaluated against the same-build baseline, and both moved:

| criterion | result against the same-build baseline |
| --- | --- |
| criterion 1, more tasks solved by a stated margin | **the repository suite is the only one that clears it.** QuixBugs and the ladder both fail it against this stronger control; at n = 10 and n = 12 the margin bar is unreachable by construction |
| criterion 3, median wall at most half the control's | **QuixBugs now fails it** at 0.604×, precisely because the same-build baseline is so much faster than the older one the bar was set against |

Against the earlier, weaker baseline the same run passed everything reachable — the ladder's four criteria, the
wall and cost criteria on all three suites, the stability criteria, and a decision-model share of wall of 3–9 %
against a ceiling of 15 %. Criterion 5, attribution, was **not evaluable** then and is not evaluable now: one
of its two control arms has never run.

The honest summary is the one the report gives: the mode wins clearly on wall and cost, wins on pass against
both same-build controls, fails its correctness ceiling on two named tasks, and cannot yet answer the
attribution question at all.

## What this comparison does not settle

- **Attribution.** An `llm-sieve` arm — the same search with the generating model as a candidate source but no
  decision model — was never run. It raises a configuration error rather than starting. So the question "how much
  of the gain is the search and how much is the decision model" is **not yet measured**.
- **Repeats.** One run per arm. No repeat run of either arm on these 28 tasks exists.
- **Generalisation.** These 28 tasks are the development set. The out-of-sample slice is a different page and a
  different answer.

## Related

- [Out of sample](out-of-sample.md) — the same mode on 22 tasks it was never tuned on.
- [Iterations 1–4](iterations.md) — what changed after this measurement, and what each change was worth.
- [Measurements index](README.md).
