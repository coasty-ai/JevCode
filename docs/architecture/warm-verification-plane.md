# The warm verification plane

**This mechanism ships OFF.** It is built, it is fast, and the default is `off` for a reason
stated below. Every speed number on this page says which side of that switch it was measured on.

## Why per-candidate process cost is the whole wall

The [synthesizer](synthesizer.md) works by running thousands of candidate edits through the
tests. Verification is not a part of the cost; it is nearly all of it.

Measured over 28 tasks: `synthMs` — the synthesizer's own wall — is **99 %** of run wall on the
per-file-runner suite, **99 %** on the module suite and **84 %** on the repository suite, over
**13,746**, **26,948** and **2,128** candidate runs respectively.
<!-- docs/HARNESS-NEXT-DESIGN.md §1.1 queue 1 -->

Every one of those runs is a fresh `sandbox-exec -f <profile> /bin/sh -c …` process. So the
question is what a single candidate run costs before it does any useful work.

### The measured table

| measurement | value |
|---|---|
| taken | 2026-09-21 |
| machine | one laptop, darwin 25.6, **idle** |
| samples | `n = 8–15` per row, median reported |
| source | [`docs/HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md) §1.1 |

| what | median | note |
|---|---:|---|
| bare `/bin/sh -c true` | 2.8 ms | the floor |
| `sandbox-exec -f <profile> /bin/sh -c true` | 6.8 ms | the seatbelt wrapper costs about 4 ms, not more |
| `python3 -c pass` | 13.4 ms | interpreter start |
| `python3 -c "import pytest"` | 67.3 ms | p95 98.2 ms — the real fixed cost |
| `python -m pytest -q` on one trivial test | 91.9 ms | about 92 ms fixed per invocation |
| the same through the sandbox | 108.3 ms | p95 129.4 ms |
| a real per-file-runner candidate run | 67.8 ms bare / **74.3 ms** sandboxed | |
| a real module-suite candidate run | **182.7 ms** | 10 tests, 3 failing |
| the same work as `pytest.main()` in an already-warm interpreter | 42–48 ms per call after the first | **3.9× cheaper** |
| 6 test cases as fresh `python3` subprocesses | 66.8 ms | today's shape: one subprocess per case |
| 6 test cases as `fork()` from a warm parent | 2.5 ms | **26× cheaper**, and `fork()` keeps address-space isolation *and* the per-case timeout |

**Per-candidate fixed process cost is 70–180 ms, and nearly all of it is removable without
weakening isolation.**

At 1,375 candidate runs per task over 8 lanes, the per-file-runner suite spends about **12.8 s
of lane wall per task** against a 34 s median. At 2,246 candidate runs per task, the module
suite spends **28–51 s** against a 47 s median.

One caveat travels with those figures and it cuts both ways. They were taken on an **idle**
machine; the benchmark runs at one-minute load averages of 22–37 with 8 lanes per run. The
*ratios* are what carry, because fixed overhead inflates with load at the same rate as the work
does — and that means the absolute saving under real load is larger than the idle arithmetic,
not smaller.

## The plane

The mechanism is one warm interpreter per lane, plus a hard rule about what a warm result is
allowed to mean.

- **`serve()` returns `null`** whenever the command is not exactly a shape the warm server
  reproduces, the plane is disabled, the lane has no worker, or the worker misbehaved. The
  caller then runs the command cold, byte for byte as it does today.
- **A warm result is an ordinary run result.** It goes through the same parsers as a cold one.
  The warm path adds no parsing of its own.
- **`mismatch()`** — one screen/confirm disagreement — disables the plane for the whole run.
- **`disable()` is one-way.** Nothing re-enables the plane inside a run.

<!-- src/jev-modes/synth/warm/plane.ts:1-25 -->

### Screen hot, confirm cold

This is the rule that makes the whole thing safe to reason about: **every plausible passer
produced on a warm worker is re-verified by a cold, fresh-spawn run before the guard sees it.**

The warm plane is a *screen*, never an authority. It can say "this candidate is not worth a cold
run". It can never say "this candidate is the fix". The repository path already had exactly this
shape — a same-lane confirmation re-run that caught one false pass in 64 — and the plane
generalises it.

The rule is enforced in the sieve runner, and three details make it hold rather than merely
describe:

- The confirmation is **never skipped**. When the step's run budget cannot hold it, the
  candidate is *deferred* — exactly as a missing full-suite run is — rather than accepted on the
  warm result.
- When the goal-subset run was the whole suite, the cold confirmation **replaces** it, so what
  reaches the guard is cold end to end rather than a warm screen carried alongside a cold
  verdict.
- One disagreement disables the plane for the whole run, disowns the warm pass so it does not
  consume a passer slot, re-queues everything that batch classified, and emits a named line
  saying so.

<!-- src/jev-modes/synth/sieve/runner.ts:1074-1107 -->

Nothing is asked of Jev anywhere in this. The tests are the oracle and the disagreement rule is
arithmetic.

### The worker

A worker is started **through the harness's own sandbox**, not with a second `spawn`. It
therefore inherits the seatbelt profile, the environment scrub, the output redaction, the
three-pass process-tree kill and the run-end kill for free, and `src/sandbox/run.ts` does not
have to grow a long-lived-stdin mode.

The cost of that choice is that stdin is not available, so the request channel is a FIFO pair
the *worker* creates with `os.mkfifo` inside one of the seatbelt's writable roots, announcing
itself with a ready line on stdout.

Liveness has four independent layers, because a leaked interpreter is the worst failure mode:

1. closing the request FIFO gives the worker end-of-file and it exits — which is what happens
   automatically when the harness process dies, since the descriptor goes with it;
2. the worker exits after an idle timeout and after a maximum lifetime;
3. the sandbox call that started it carries its own timeout;
4. the run-end kill takes it with everything else.

<!-- src/jev-modes/synth/warm/worker.ts:1-24 -->

The transport is deliberately hand-rolled, and the module explains why at length: Node's file
streams over a FIFO block inside the four-thread libuv file pool, and a socket over a FIFO
descriptor silently loses data on macOS because the kernel's read filter delivers only what was
in the pipe when the watcher was armed. Both were measured while fixing a real wedge.

### The watchdog

The failure that mattered in the field was not a wrong verdict. It was **no verdict at all**: an
eight-lane batch whose workers never attached left the harness at 0 % CPU with no child
processes for an hour, while the sieve reported "0 tested on 8 lanes (nothing ran)" and the
step's whole test wall drained into boot deadlines.

So every `serve()` races its own budget. A call that outlives it abandons the attempt and
disables the plane. A worker that times out — no ready line, no peer, no reply — disables the
plane on the **first** occurrence rather than after a restart budget, because a hang is a
property of the mechanism, and the wall it costs comes out of the step rather than out of the
plane.

Three further budgets bound the damage:

| bound | value |
|---|---:|
| restarts allowed per lane before the plane gives up for the run | 2 |
| worker failures allowed across all lanes before the plane gives up | 4 |
| worker boot timeout | 20 s |

<!-- WARM_MAX_RESTARTS_PER_LANE, WARM_MAX_FAILURES_PER_RUN: src/jev-modes/synth/warm/plane.ts:33-42;
     WARM_BOOT_TIMEOUT_MS: src/jev-modes/synth/warm/worker.ts:60 -->

The per-lane budget alone is not a budget: eight lanes could each pay three boots, and a boot
that ends at its deadline costs the *step's* test wall, not the plane's. The run that made the
run-wide cap necessary spent its whole 600-second test wall on 10 restarts and tested nothing.

Every transition is counted, so the sieve's own progress line — and through it the trace —
records how much of a step was screened, how often the plane fell back, and why.

## The switch

```ts
export function warmPlaneEnabled(env = process.env): boolean {
  return warmRequested(env);
}

export function warmRequested(env = process.env): boolean {
  const flag = (env['JEVCODE_WARM'] ?? '').trim().toLowerCase();
  return flag === 'on' || flag === '1' || flag === 'true';
}
```
<!-- src/jev-modes/synth/warm/plane.ts:135 and :148 -->

Absent, unset or unrecognised means **off**. There is no configuration file key and no
command-line flag; it is an environment variable read inside the synthesizer, which is the same
shape the routers' switch uses.

`warmModeFor` adds a second gate: even with the flag on, the plane only admits the two Python
lane shapes it has a server for. Any other runner falls back to cold, and the run records that
it did — because an earlier measurement reported an "18-task warm A/B" that was really 14, with
nothing in the output saying so.

## Why it is off

Two independent reasons, in the order they were found.

**One: it wedged.** At the first live measurement of the merged tree, a run with the plane on
never completed a synthesis step. The candidate batch reached the lanes, the sieve reported "0
tested on 8 lanes (nothing ran)", and the wall cap took step 1 — with runs sitting at 0 % CPU
for 59 minutes. The unit suite passed throughout, because its parity tests use fakes. That is
the failure the watchdog and the FIFO transport were written to answer, and they answered it.

**Two: with the transport fixed, it is faster and it still loses tasks.** In a later measurement
at build `d86c385` (version 0.5.0), over **93,460 offered screens across seven warm-on arms**:
zero fallbacks, zero restarts, zero screen/confirm mismatches, zero disables, zero wedges. At
matched load the plane is **23 % faster** — median per-task ratio **0.767**, faster on 7 of 7
tasks both arms solved, 207.8 s down to 154.6 s.

And warm-on lost tasks that cold solves: one program twice independently and another once, for
4 cold wins against 2 warm wins over 54 paired tasks.

The cause is named and it is a calibration defect rather than a transport one. The sieve learns
the per-run cost from **cold runs only**. With the plane on, the only candidates that reach the
cold path are the ones whose hot screen hit a deadline — so the sample is nothing but timeouts,
a median of 11,655 ms against 510 ms cold on the same batch. That figure is written into the run
plan, the remaining-run count collapses from 1,315 to 16, and every later batch reports "0
tested".

<!-- docs/LLM-JEV.md, 2026-09-22 iteration 2 §4; caveats from that entry: one run per arm,
     loadavg 2.9–175 across the slice, only the load-matched back-to-back window is quoted for
     timing, and the warm counters live only in the live transcript log, so every warm number in
     that entry was harvested by hand. -->

Two caveats travel with those numbers and must not be dropped when they are quoted: it is **one
run per arm**, and the machine's one-minute load average ranged from 2.9 to 175 across the
slice, so only the load-matched back-to-back window is quoted for timing at all.

The standing decision is that the default goes back to on only when a real-lane integration test
**and** the full replay gate both pass with the plane on — and, from the second measurement, only
after the cold-run calibration is fixed and the matched pair is re-run.

## What "off" buys the rest of the tree

The plane being off is not merely a missing feature; something else depends on it.

The [fast path](synthesizer.md#route-r9-the-bounded-sieve-fast-path) accepts a candidate on the
strength of one reduction: "cold-confirmed" reduces to "the regression run exists and passed".
That reduction is sound **only while every lane run is cold**, and nothing on a proposal's
evidence records whether the run behind it was warm-screened.

So the fast path's first stage refuses to arm at all when the plane is enabled, with the named
reason `warm_plane`, checked before any wall is spent. A false claim of cold confirmation is
thereby unreachable rather than merely unlikely.
<!-- src/jev-modes/stages/fastpath.ts:183; src/jev-modes/synth/search/fastpath.ts:112-123 -->

Which is also why every published speed number in this repository must say which side of
`JEVCODE_WARM` it was measured on. A speedup quietly measured with the plane on is not a number
about any run that happens today.
