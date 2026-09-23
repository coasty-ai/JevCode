# Measurements

Everything JevCode claims about itself was measured on a named build, against a named control, and is
recorded with its caveats. This page is the index. It leads with the two results that matter most and with
the sentence that has to travel beside each of them.

Read the caveats. They are not boilerplate: one of the two headline results does **not** generalise, and the
report that produced it says so in its own words.

## The two headline rows

### In sample — 28 tasks, same build

| arm | pass | correct by verdict | median wall, all tasks | median wall, the 21 both solved | total cost |
| --- | --- | --- | --- | --- | --- |
| `llm-jev` | **28/28** (Wilson [88 %, 100 %]) | 26/28 | **63.0 s** | **39.5 s** | **$0.1441** |
| `jev-off`, same build | 21/28 ([57 %, 87 %]) | 20/28 | 246.3 s | 175.3 s | $0.5875 |

Discordant pairs b = 7 / c = 0, exact sign p = 0.0078. Build `066816f`, generator `z-ai/glm-5.3-flash` through
OpenRouter, decision model `jev-1.13.0`. One run per arm.

**The caveat.** These 28 tasks are the set the guard thresholds and question wordings were tuned against. The
result is a measurement of this build on this set. It is not a capability claim. The same 28 tasks re-run on the
plain baseline moved by six tasks between two builds of the same arm, which puts run-to-run noise on the baseline
at roughly ±2 tasks.

Full page: [llm-jev vs generator-only](head-to-head.md).

### Out of sample — 22 tasks the mode was never tuned on

| arm | pass | median wall, all tasks | median wall, the 11 both solved | total cost | decision requests |
| --- | --- | --- | --- | --- | --- |
| `llm-jev` | **13/22** ([39 %, 77 %]) | 190.7 s (**1.385× against**) | 37.8 s (0.349×) | **$0.7918** (2.68×) | 2,330 |
| `jev-off-tuned` | 12/22 ([35 %, 73 %]) | 137.7 s | 108.2 s | $0.2959 | 0 |

Discordant pairs b = 2 / c = 1, exact sign p = 0.500. Same build and same models as above.

**The caveat.** Inside the one-line-bug regime the mode transfers: the same pass rate, about a third of the wall,
about a third of the dollars, zero overfits on either side. Outside it — multi-hunk tasks and repository instances
with no issue oracle — the extra decision traffic buys **one** extra ladder task and **no** repository instance for
about three times the money and three times the wall.

Full page: [Out of sample](out-of-sample.md).

## The cost-basis note that travels with every dollar figure

Dollars are not measured the same way on both sides of these tables.

| arm | share of dollars that is **not** provider-reported |
| --- | --- |
| `llm-jev`, in sample | 78.0 % (generator estimate $0.013914 = 30.5 % of its generator spend; decision spend $0.098573, all rate card) |
| `llm-jev`, out of sample | 88.4 % |
| `jev-off`, in sample | 0 % (383 of 383 rows provider-reported) |
| `jev-off-tuned`, out of sample | 4.7 % estimated |

A dollar comparison here is between a mostly-estimated number and a mostly-reported one. Every page that quotes a
dollar figure repeats this.

## What each page covers

| Page | What it holds |
| --- | --- |
| [llm-jev vs generator-only](head-to-head.md) | the same-build 28-task table, the Wilson intervals, the b/c discordance, the exact sign tests, the one-sided censoring and the cost basis |
| [Out of sample](out-of-sample.md) | the 22-task slice, the rules that selected it, the suite-by-suite split and the reading |
| [Iterations 1–4](iterations.md) | what each of the four iterations changed, what it measured, and the two that measured nothing and said so — including the fresh 18-task slice, 14/18 against a tuned baseline's 9/18, sign p = 0.0312 |
| [Jev-only](jev-only.md) | the ladder of rungs for the mode with no generating model at all, repaired and correct reported separately on every row |
| [The warm plane A/B](warm-plane.md) | a 23 % speedup that is switched **off** by default, and the failure that keeps it off |
| [Startup, render and harness overhead](performance.md) | the perf gates and the last recorded run, with the machine and the load |

## How to read any table on these pages

**"Repaired" and "correct" are different numbers.** A patch can pass every test the workspace exposes and still be
wrong. Two suites here — QuixBugs and the internal ladder — have no hidden test suite, so "repaired" means "passes
the reference cases" and correctness is a separate check performed by a verdict script. Both numbers appear on
every row that has them.

**Wall numbers are load-bound.** These runs shared a machine. Where the load was not matched between arms, the page
says so and the wall number is reported rather than compared. One iteration found that a 1.41× slowdown it had
reported was 1.16× once the two arms ran back to back in the same window.

**One run per arm, unless a row says otherwise.** Repeats are rare and are labelled.

**Repository results use an unofficial evaluator.** The official SWE-bench harness needs Docker, which was not
available. The local evaluator builds a virtual environment at the instance's setup commit, applies the patch and
the test patch, and grades with ported log parsers under the official rule. Every record names the evaluator that
produced its verdict.

**Mechanisms behind a default-off switch are marked as such.** Four of them ship off: the speculative routers
(off in every mode, and reachable only under mode `jev-on`), the warm verification plane (off), delegation
splitting (off), and the bounded fast path (`auto` only under mode `jev-on`). A number measured with one of
these on says so. The switches are listed in
[module ownership and import rules](../contributing/architecture-rules.md#default-off-switches).

## Where the raw material lives

- [`docs/LLM-JEV.md`](../LLM-JEV.md) — the dated measurement log for the `llm-jev` mode, eleven entries, one per
  measurement, each with run identifiers and the report it came from.
- [`docs/JEV-ONLY.md`](../JEV-ONLY.md) — the research brief and running log for the mode with no generating
  model, including the reasoning that led to it.
- [`experiments/results/`](../../experiments/results/) — the reports themselves, with the tool output beside each.
- [`docs/DECISIONS.md`](../DECISIONS.md) — the dated decision log. Every default a measurement moved has an entry
  there saying what moved it.

Nothing on these pages is projected. Where a mechanism exists and has not been measured, the page says **not yet
measured** and names what would measure it.
