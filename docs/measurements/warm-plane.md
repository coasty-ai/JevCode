# The warm plane A/B

The warm verification plane keeps one warm Python interpreter per verification lane, so a candidate patch can
be screened without paying process start every time. It is measurably faster. **It ships switched off**, and
this page is why.

Switch: `JEVCODE_WARM=on`. Default: **off**, in every mode.
<!-- src/synth/warm/plane.ts warmRequested(): true only for 'on' | '1' | 'true'; warmModeFor() returns null otherwise. -->

Design: [`docs/HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md) §3 M6 and §9.2.
Measurement: the iteration-2 entry in [`docs/LLM-JEV.md`](../LLM-JEV.md) and
[`experiments/results/llm-jev-iter2.md`](../../experiments/results/llm-jev-iter2.md).
Standing decision: [`docs/DECISIONS.md`](../DECISIONS.md), "The warm verification plane is off by default …".

## What it is, and what it is not allowed to be

The plane is a **screen**, never an authority. Four rules make that structural:

- A warm attempt returns nothing whenever the command is not exactly a shape the warm server reproduces, the
  plane is disabled, the lane has no worker, or the worker misbehaved. The caller then runs the command cold,
  byte for byte as it would have anyway.
- **Screen hot, confirm cold.** Any candidate that passed with help from a warm worker is re-verified by a fresh
  cold process before the guard ever sees it.
- One disagreement between a warm screen and its cold confirmation disables the plane for the whole run and
  re-queues that entire batch cold.
- Disabling is one-way. Nothing re-enables the plane inside a run.

A watchdog sits over all of it, because the failure that mattered was not a wrong verdict but **no verdict at
all**. Every warm call races its own budget; a call that outlives it abandons the attempt and disables the plane;
a worker that never announces itself or never replies disables the plane on the **first** occurrence rather than
after a restart budget. A hang is a property of the mechanism, and the wall it costs comes out of the step.

It admits exactly two lane shapes, by test runner. Everything else runs cold.

## The failure that mattered

The first live measurement after the plane merged found it wedging every run in the `llm-jev` mode. The candidate
batch reached the lanes, the sieve reported "0 tested on 8 lanes (nothing ran)", the wall cap took the run in
step 1, and **three runs sat at 0 % CPU with no child processes for 59 minutes**.

A five-point, zero-dollar, offline A/B on one task at concurrency 1 pinned it on the plane and on nothing else:

| build and setting | steps | candidates tested |
| --- | --- | --- |
| the build before the plane | 6 | 2,896 |
| the merge build, plane on | 0 | 0 |
| the current build, plane on (from source) | 0 | 0 |
| the current build, plane on (bundled) | 0 | 0 |
| the current build, **plane off** | **6** | **2,180**, in 80.8 s |

**The unit suite stayed green the whole time**, because the plane's parity tests use fakes for the worker and the
worker tests drive one lane.

**Root cause.** The worker drove its lane pipes with ordinary Node file streams. A pipe's write end blocks in
`open` until a reader arrives, and each blocking `open` and `read` parks one thread of the runtime's
four-thread filesystem pool. With eight lanes and four threads the pool was gone, and every filesystem call in
the whole harness queued behind opens whose workers had already exited at their connect deadline. Hence 0 % CPU,
no children, nothing tested.

**Fix.** Raw non-blocking descriptors driven by synchronous reads and writes on a timer that runs only while a
request is in flight, plus the watchdog described above, plus a real-lane integration test that boots the actual
Python worker, runs six lanes at once with a concurrent file read proving the pool is free, and drives two
different hang shapes to "disabled" in under 1.2 seconds.

After the fix, a mock A/B on one task: **23.6 s with the plane on against 31.6 s off**, identical trajectory.

## The real-model A/B

The fix was then measured against real models on the 18-task slice, against a criterion written before the run.

**The transport is sound.** Over **93,460 offered screens** across seven arms with the plane on:

| counter | value |
| --- | --- |
| fallbacks to the cold path | **0** |
| worker restarts | **0** |
| screen/confirm disagreements | **0** |
| runs in which the plane disabled itself | **0** |
| wedges | **0** |

The earlier "nothing ran" signature never appears. The offline gate completes in 12.5 minutes with the plane on,
where the previous iteration had to be killed.

**It is faster.** At matched load the plane is **23 % faster**: median per-task ratio **0.767**, faster on
**7 of 7** tasks both arms solved, 207.8 s down to 154.6 s. The distribution of where the wall goes is unchanged.

**And it loses tasks.** That is the criterion it failed:

| task | outcome |
| --- | --- |
| QuixBugs `topological_ordering` | lost with the plane on, **twice independently** (at load 150 and at load 35) |
| QuixBugs `shortest_path_length` | lost with the plane on, once |
| overall, 54 paired tasks | **4 wins for cold, 2 wins for warm** |
| the two ladder pairs | at parity — 5/6 both ways, both missing the same task |

## Why it loses tasks: a calibration defect, not the transport

The sieve teaches its cost model — how long one candidate run takes — **from cold runs only**. That is the right
rule for an estimate that has to describe a fresh process.

But with the plane on, the only candidates that reach the cold path are the ones whose warm screen hit a deadline
and was therefore discarded. So the calibration sample is **nothing but timeouts**.

On one recorded 185-candidate batch the plane taught a run median of **11,655 ms** where the identical batch
measured **510 ms** cold. That estimate sizes the lane timeouts and the whole run plan. The remaining-runs budget
collapsed from 1,315 to 16, and every later batch reported "0 tested (nothing ran)" until the run died at its
step cap — on a task the cold path solves in 42 seconds.

A second, smaller defect compounded it: the screen was bounded by the lane's *run* cap rather than by its own
tighter deadline, so a screen that timed out cost the step both the screen and the cold re-run, roughly 14
seconds each per diverging candidate.

## What was fixed, and what is still owed

Fixed after the measurement:

- The calibration sample is rebuilt. A deadline re-run teaches **nothing** — a timeout is a bound, not a
  measurement of the candidate, on either path. A cold run that was nobody's re-run is the truth, as before. A
  warm screen is kept in its own sample as a **lower bound** on the cold run it stands for, which may hold or
  raise the estimate but never lower it. Replayed on the recorded batch, the estimate goes from 11,655 ms to
  **510 ms** — exactly what the cold arm measured on the identical 185 candidates.
- The screen gets its own tighter deadline instead of the lane run cap, and **any** timed-out screen is now
  re-run cold.
- The counters are persisted. They previously existed only as free text in a live log that the archiving flag
  does not copy, so **every warm number in the report above was harvested by hand** from the live run directory
  before the next arm overwrote it. They are now written onto the step record and summed onto the run.
- `JEVCODE_WARM=on` was a **silent no-op** on the repository suite, because that suite's oracle uses a runner the
  plane has no shape for. The advertised "18-task warm A/B" was really an A/B on 14 of them. The two cases — the
  switch is off, and the switch is on but this runner has no warm shape — are now recorded separately.

**Still owed: the re-run.** The load-matched pair has not been re-measured since those fixes. Until it is, the
speedup above stands as the measurement of a build that also lost tasks.

## The standing decision

> The default stays **off** until a real-lane integration test and the offline gate both pass with the plane on,
> and the load-matched pair is re-run with no task losses.

The real-lane test exists and passes. The gate completes with the plane on. The pass-parity criterion has not
been re-measured after the calibration fix, so the switch stays off.

**Consequences for every other page here:** no live number taken while the default was briefly on is trusted, and
every published speed figure states whether the plane was on. Everywhere else on this site, it was off.

## Related

- [Iterations 1–4](iterations.md) — iteration 1 found the wedge; iteration 2 ran the A/B.
- [Startup, render and harness overhead](performance.md) — the other place wall numbers are gated.
- [Measurements index](README.md).
