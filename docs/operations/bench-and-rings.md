# Bench, rings and replay

The benchmark harness runs the engine in process over a set of tasks, under one or more
*conditions*, and writes a directory you can read without rerunning anything.

```sh
jevcode bench --suite quixbugs --tasks 10 --conditions llm-jev,jev-off --concurrency 3
jevcode bench --suite swebench --task-id sympy__sympy-15345 --live --spend-cap 0.50
jevcode bench --resume <bench-id>
```

<!-- src/cli/args.ts:741-745 the usage lines -->

## Conditions

A condition is an arm: a named engine configuration whose parameters are pinned in code, so the
same arm means the same thing in two runs a week apart. Eight exist, all of them the Jev-driven
modes and their controls. The default `agent` mode has no bench arm: by the owner's instruction it
was verified live rather than benchmarked ([The agent loop](../architecture/agent-loop.md)).

| Condition | What it is |
| --- | --- |
| `jev-on` | the full engine: the code model writes, the decider decides every step |
| `jev-off` | the generator-only engine — the same code path, minus every point where a decider answer is consumed |
| `jev-only` | the full engine with the synthesiser in the propose stage and a null provider in the generator slot; there is no generating model, and any generator usage invalidates the record |
| `llm-jev` | the full engine with both the synthesiser and a real code model; the model is one candidate source inside the search |
| `llm-sieve` | the `llm-jev` engine with a stub decider, so every question takes its code default and zero decider requests are made |
| `jev-off-tuned` | the `jev-off` engine behind a tuned provider: capped output tokens, low reasoning effort, a per-call deadline, a capped plan |
| `jev-on-next` | `jev-on` with the router table, the bounded fast path and the generation-path mechanisms armed |
| `jev-on-next-nofast` | the same, with the fast path off — the control that isolates one mechanism |

The last two are measured at concurrency 1 by force. They run test commands of their own inside
a step, so their wall time would otherwise be a function of how many other tasks shared the
machine. The control arm is held to the same concurrency, because a paired comparison whose two
arms ran at different concurrencies is not one.

Everything that must be identical across conditions, and everything pinned per condition —
generation parameters first of all — is built in one module and recorded verbatim in
`summary.json`. The runner refuses an arm whose synthesiser does not echo back the mode and the
generation parameters it was handed.

<!-- src/bench/conditions.ts:1-14, :25-58 -->

## Suites

| Suite | What it is |
| --- | --- |
| `quixbugs` | small single-function Python programs with one seeded bug each |
| `ladder` | a graded difficulty ladder built for the decider-only mode |
| `swebench` | a checked-in subset of SWE-bench Verified, graded by a **local-virtualenv replica** of the official `eval.sh` — no Docker, the official apply chain and the official log parsers ported, the evaluator named `local-venv` on every record. It is **not** the official harness, and every table that quotes it says so |
| `terminal-bench` | ten Terminal-Bench tasks, run through a local shim |

Terminal-Bench numbers carry a standing label in every table: **local shim, not comparable to
the published leaderboard**. No task in that suite is runnable locally without a shim — every
upstream verifier hardcodes container paths.

For SWE-bench the text handed to the engine is exactly the problem statement, normalised only in
its line endings. The hints, the failing and passing test lists, the test patch, the gold patch
and the difficulty label never enter a prompt, the decider's state or the workspace; the loader
exposes them to the evaluator, to the mocked provider and to the report, and nowhere else.

<!-- src/core/types.ts:2854 BenchSuite; src/bench/report.ts:16 TB_LABEL; docs/DESIGN.md §13 -->

## What the directory holds

| File | Shape | Contents |
| --- | --- | --- |
| `tasks.jsonl` | one JSON object per line | one record per task and condition. This is also the resume key: a rerun with `--resume` skips what is already in it. |
| `summary.json` | JSON object | the benchmark id, the timestamps, whether it was mocked, the suites, **the pinned configuration of every condition**, the generator model, the caps, what was spent split between generator and decider, whether a cap fired, what did not run, the paired task counts, and the per-suite metrics |
| `comparison.md` | Markdown | the arm-by-arm table |
| `predictions.<condition>.jsonl` | one JSON object per line | the SWE-bench prediction format, one file per condition |
| `runs/` | gzipped files | archived run directories, written only with `--archive-runs` |

A task record carries the pass verdict and which evaluator produced it, the step count, wall
time, tokens per step split by source, cost split between generator and decider, decider latency
with its median and 95th percentile, request and question counts, the per-stage timings, the
stop reason, and counts of blocks, reviews, declines, loops, replans and reads — plus, for a
patch-producing suite, whether the patch was empty, whether it applied, and how large it was.

`comparison.md` holds a conditions paragraph, per-suite pass rates, the paired comparison, solve
and token curves as tables with inline bars, stop-reason histograms and per-task rows. When a
generator-only baseline and a decider arm are both present, a head-to-head section is added per
suite with discordant pairs, confidence intervals and the pre-registered criteria.

<!-- src/bench/runner.ts:34-37; src/bench/types.ts:556-574; src/core/types.ts:2871-2901;
     src/bench/report.ts:1-9; src/bench/swebench/predictions.ts:69-70 -->

### Why archiving exists

A results directory holds only the four files above. Everything an after-the-fact analysis
actually reads — the step records, the decisions, the decider and generator logs, the run
metadata, the state file, the produced patch — lives in the run directory, outside the results
directory, keyed only by the run id in `tasks.jsonl`. `--archive-runs` writes one gzip per file
under `runs/<run-id>/`, so a results directory carries its own records and a single file can be
read back without unpacking an archive. It never fails the benchmark: a missing run directory,
a file that was never written and an input error are all counted and logged.

<!-- src/bench/archive.ts:1-16 -->

## The statistics

Four things are computed, and they travel with every published pass rate:

- a **Wilson interval** on each pass rate;
- **discordant pairs** — how many tasks one arm solved and the other did not, in each direction —
  with a one-sided exact sign test;
- a one-sided **exact signed-rank test** on paired wall times, computed exactly rather than by a
  normal approximation, because the sample sizes are 20 to 40;
- **cost ratios**.

A pass rate without its interval, or a difference without its discordance counts, is not a
result. This page quotes none of the repository's measured figures; they live in
[`../LLM-JEV.md`](../LLM-JEV.md) and in `experiments/results/`, each with the build it was taken
at and the caveats it carries.

<!-- src/bench/stats.ts:1-6 -->

Three caveats appear in the recorded results and must travel with any number taken from them:
one run per arm; some tuning done on the same tasks the number is reported over; and a cost
basis that is not symmetric — a large share of the decider arm's dollars are estimated or read
from a rate card, while the baseline's are provider-reported.

## The three rings

Running a full suite to find out whether a change helped is slow and expensive. The rule is
**no benchmark until a cheap probe says the change is real**, and the probes are arranged in
three rings, each strictly cheaper than the one above it.

### Ring 0 — micro-probes: no network, no API, seconds, $0

`jevcode perf` runs a set of probes in a real pseudo-terminal and prints a table. The release
set is nine probes: first frame, step overhead, static append, render lag, composer latency,
intake latency, idle frames, states, scroll latency.

Two further probes exist and are deliberately **not** in the release set, because they spawn
real interpreters and are measurement instruments rather than gates: a lane-run probe and a
sandbox-spawn probe. Select one with `JEVCODE_PERF_ONLY=<name>`.

The standing gates are a first frame under 300 ms and per-step harness overhead under 50 ms at
the 95th percentile.

<!-- src/perf/main.ts:52-65 ProbeName, ALL_PROBES, RING0_PROBES -->

### Ring 1 — replay: seconds, $0

The plan is to rebuild a finished run from its recorded provider and decider responses, so every
engine-side change — dispatch order, scheduling, window and limits, loop signatures, rendering —
can be iterated at no dollars and no latency, with the acceptance test being identical committed
patches across the corpus of archived runs.

**This is not built yet.** There is no replay module and no replay subcommand in this tree.
Until there is, the free half of Ring 1 that *does* exist is the decider-off gate: with
`JEVCODE_JEV=off` the decider slot is replaced by a deterministic double and every fallback path
must still complete the task, only slower. That costs nothing and can run on every iteration.

<!-- verified: src/loop/replay.ts does not exist; src/cli/args.ts:20 has no `inspect` command.
     The decider-off double is src/jev/off.ts:91-132 -->

### Ring 2 — tiny live tasks: about two minutes, about $0.01

A handful of small tasks the tree already passes, run live at a tight spend cap:

```sh
jevcode bench --quick --live --conditions llm-jev --concurrency 3 --spend-cap 0.05
```

A regression on a task that passes today is unambiguous, which is the whole point of choosing
them that way.

### The loop

1. Write the probe first.
2. Run Ring 0.
3. Run Ring 1 — today, that means the decider-off gate.
4. Run Ring 2 **twice**, because a wall-clock change can be produced by sampling timing alone.
5. Accept only if the median wall time improves by at least ten per cent on most of the live
   tasks, **no verdict changed**, the overfit count did not increase, the screening and cold
   confirmation agree exactly, the harness overhead is unchanged, and the decider request count
   did not rise.
6. Record the row, then move to the next mechanism.

<!-- docs/HARNESS-NEXT-DESIGN.md §5 -->

## A note on reading benchmark numbers

Three habits keep these tables honest, and they are worth adopting if you run your own:

**Say which mechanisms were on.** The routers, the warm lane pool and the hedge are all off by
default, and the fast path is armed only in one mode. A wall-clock figure without that list is
not reproducible. The pinned mechanisms per arm are in `summary.json` for exactly this reason.

**Separate censoring from failure.** An arm that hits the wall cap and an arm that stops by
itself having failed are not the same thing, and a median over a mixture of the two is not a
median of anything. The recorded head-to-heads report the censoring split explicitly.

**Do not compare a provider-reported cost with an estimated one without saying so.** The two
are both dollars and they are not the same measurement.

## Related pages

- [What a run writes](records.md) — the run directory a benchmark record points at.
- [Every JEVCODE_* switch](environment.md) — the mechanism switches an arm pins.
- [`../LLM-JEV.md`](../LLM-JEV.md) — the measured results, each with its build and its caveats.
- [`../DESIGN.md`](../DESIGN.md) §13 the benchmark; [`../HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md) §5 the rings.
