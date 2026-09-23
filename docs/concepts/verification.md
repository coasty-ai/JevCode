# Verification and the oracle

Everything the harness believes about a patch comes from running something. This page says
exactly what gets run, where, and what the result is allowed to decide.

## In the default mode: your test command, run by the harness

In `agent` mode there are no candidates and no shadow lanes: the code model edits your
workspace through tools, with a pre-image of every file it may change, so `/undo` can restore
it. Verification is your own test command:

- The harness detects the test command from the workspace (`detectTestCommand()`); a model never
  chooses it. The model is told which command was detected and asked to run it after a change.
- If the model stops after changing files without running it, the harness runs it itself (a
  `verify` step, at most twice per run) and hands the result back for the model to act on.
- A run stops `complete` only when the last run of the **whole, unscoped** test command parsed,
  passed, and came after the last change. Anything else that finishes is `generator_done`, and
  the stop line says the change is not verified. A reply that never called a tool stops
  `answered`.

See [The agent loop](../architecture/agent-loop.md) for the stop rules in full.

## In the synthesizer's modes

The rest of this page describes the synthesizer, the engine of `jev-only` and the legacy
`llm-jev` mode ([The synthesizer](the-synthesizer.md)). Three rules hold throughout:

1. **Candidates never touch your workspace.** They run in shadow lanes.
2. **A screened result is never a verdict.** Anything fast is a filter; the answer comes from a
   cold run.
3. **Completion is a code fact, not a probability.**

## Shadow lanes

A lane is a disposable copy of the workspace under the run directory, inside the sandbox's
writable roots. Four modes, chosen by what the workspace is:

| Mode | When | How a candidate is isolated |
| --- | --- | --- |
| `candidate_file` | the per-program runner | no copy — the candidate file is written into the lane and handed to the runner |
| `worktree` | a git workspace | `git worktree add --detach` once per run; between candidates `git checkout -- . && git clean -fdq`, then the workspace's uncommitted changes are re-synced |
| `copy` | non-git, at most 50 MB | one `cp -R` per run; touched files restored between candidates |
| `inplace` | non-git, over 50 MB | one lane on the workspace itself, apply and revert, with the revert in a `finally` |

Shell work in a lane — `mkdir`, `git`, `cp`, `rm` — goes through the sandbox like any other
command. File contents are written directly rather than through a shell heredoc, because the
lane directory belongs to the run and a heredoc would only add quoting hazards.

Nothing in the lane machinery asks Jev anything.

## Parsing a test run

The harness reads test output itself rather than asking a model what happened. It recognises
several runners — pytest, unittest, the sympy runner, and a per-program JSON runner — and
turns each into the same summary: passed, failed, errors, and the ids.

Per-test timeouts adapt to the machine. The cap is three times the **tail** of the baseline's
finished-case times, clamped to between 0.5 s and 2 s; with 20 or fewer finished cases the tail
is their maximum, above that the 95th percentile. The tail rather than the mean, because
per-case times are badly skewed: one program's slowest case is about 40 times its own mean.

There is load awareness too. Once a batch has four measured runs whose median exceeds twice the
estimate, the rest of the batch's per-case timeout is scaled by the observed ratio. A benchmark
run on a loaded machine measured lane batch medians at four to nine times the idle run time,
which is exactly the factor a timeout fitted on an idle machine lacks.

Timed-out cases never vote on how long a case takes. They say only that the buggy program hangs
on that input.

## Screen hot, confirm cold

There is an optional **warm verification plane**: one warm interpreter per lane, so a candidate
can be screened without paying interpreter startup.

It is deliberately a screen and never an authority:

- it returns nothing at all unless the command is exactly a shape it reproduces, and the caller
  then runs the command cold, byte for byte;
- a warm result goes through the same parsers as a cold one, so the warm path adds no parsing
  of its own;
- **one** disagreement between a screen and its cold confirmation disables the plane for the
  whole run;
- disabling is **one-way**. Nothing re-enables it inside a run.

There is also a watchdog, because the failure that mattered in practice was not a wrong verdict
but no verdict at all: an eight-lane batch whose workers never attached left the harness at 0 %
CPU with no child processes for an hour while the step's whole test budget drained into boot
deadlines. So every attempt races its own budget, a call that outlives it abandons the attempt
and disables the plane, and a worker that hangs disables it on the **first** occurrence rather
than after a restart budget. A hang is a property of the mechanism, and the time it costs comes
out of the step.

**The warm plane ships off.** `warmPlaneEnabled()` reads `JEVCODE_WARM` and returns true only
for `on`, `1` or `true`. Every published speed number in this repository is a warm-plane-off
number, and the fast path refuses to arm at all when the plane is on — before any time is
spent — because its acceptance rule reduces to "the regression run exists and passed", which is
only sound while every lane run is cold.

If you turn it on, state that you did next to any number you report.

## The issue oracle

Some repositories have no failing test at all. The bug is described in an issue, and there is
nothing to run.

The issue oracle builds something to run. Code extracts candidate reproduction snippets from
the task text — fenced blocks, REPL transcripts, tracebacks. **One** Jev request judges which
block actually reproduces the bug, which lines show the expected output and which show the
observed one, and what kind of failure it is. Then code turns that pick into a runnable script
with a **code-computed** pass criterion.

The script has to earn its place: it must **fail on the base commit**. A reproduction that
already passes proves nothing, and is rejected.

Once verified, the script becomes a failing test with a synthetic id, and the search treats it
like any other goal. For the regression check, code picks at most six of the repository's test
files — those that import or name the localised module.

Where no oracle can be built, the search may commit at most **one** best guess per run, and it
is labelled unverified.

The measured yield, on 30 SWE-bench Verified instances: valid on 9 of 30 — 7 strong, 2 weak —
at $0.0096 of decision spend, where "valid" means the script fails on the base commit and
passes with the reference patch. Recorded in
[`../JEV-ONLY.md`](../JEV-ONLY.md) and the results file it names.

## Completion is a code fact

The most tempting thing to ask a model is "are we done?". The harness does not let the answer
matter.

In `llm-jev`, the stop rule is `isCompleteByFact()`, and every clause of it is something
code checked:

- the claiming step ran the workspace's **own** test command and it executed;
- the parser read `passed > 0` and **no failure beyond the baseline's known ones**;
- the run is **current** — nothing was written to the workspace at or after it;
- the synthesizer's own completion evidence holds in full: every ledger goal fixed, no
  committed candidate touched a test file, every multi-passer batch arbitrated;
- on a repository-class task, the reproduction passes under a code oracle — so a run whose goal
  is among the pre-existing failures cannot complete on them.

A `done` proposal executes nothing, so it completes only when the harness's own passing,
current run verifies it. A partial `done` never does.

Where the parser read nothing at all, a `tests_pass_unparsed` Noul stands in — the one place a
probability enters, and only because there was no text to parse.

The completion question is still asked and still written to `decisions.jsonl` in that mode. It
is **recorded, never consulted**. That is deliberate: it keeps the calibration data flowing
without letting it decide anything. Analysis of one slice found the question asked on every
step of every run — 127 questions, 87.7 % of them below 0.5 — while the actual stop was the
code fact every time. It is now asked only when a step closed a goal or the plan has nothing
left.

In `jev-on` and `jev-only` the stop rule is still the completion probability against a
threshold, which defaults to **0.85**.

## What the risk stage does with evidence

When a proposal carries code-computed evidence, the risk stage shows it in the state with a
code-computed `verified` flag, and the level descriptions for the two alignment dimensions say
what that evidence means. A paired Noul asks whether the evidence is consistent with the recent
history — and its answer reaches only the reason text, **never** the risk number.

A verified patch with no regressions whose content differs from every earlier applied patch is
gated by the harm dimensions alone. Jev's alignment answers are still recorded; they just do
not gate.

## Depth

- [`../LLM-JEV-DESIGN.md`](../LLM-JEV-DESIGN.md) §6 — the completion fact, normative
- [`../JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md) §4 — lanes, budgets and the oracle model
- [`../HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md) §3 — the warm plane

## Next

- [The synthesizer](the-synthesizer.md)
- [Jev routes, never gates](jev-routes-never-gates.md)
- [Status and roadmap](../status/README.md)
