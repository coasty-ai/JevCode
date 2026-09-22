# Startup, render and harness overhead

These numbers are about the program, not the models. How fast the first frame appears, how much wall the
harness itself adds to a step, whether drawing the screen ever blocks the loop, and whether the terminal is
left alone.

They are **machine-bound**. Every figure below was taken on one laptop under a stated load. Treat them as a
description of that run, not as a specification of your machine.

`npm run perf` measures all of it, writes the raw values to `perf/results/latest.json`, and **exits 1 when
any gate fails**. It also offers to rewrite a `## Performance` section of `README.md` from that file so the
table cannot drift from the data; this README has no such section, so the probe prints
`README.md has no "## Performance" section; nothing rewritten` and the numbers below are transcribed from
`perf/results/latest.json` by hand.
<!-- src/perf/main.ts:315-318, src/perf/readme.ts:410-421 updateReadmePerformance -->

## Performance

_This section is rewritten by `jevcode perf` after every complete, release-quality run (`PERFORMANCE_PAGE` in `src/perf/main.ts`); until the first such run on this tree it holds no table._

## The budgets

| budget | value |
| --- | --- |
| first frame, both entry points, every terminal geometry, with zero network at launch | **< 300 ms** |
| harness overhead per step, with pre-images and post-images | **< 50 ms** |
| event-loop lag while typing during a live run, p95 net of the probe's own idle floor | **< 5 ms** |
| event-loop lag, maximum, raw | **< 50 ms** |
| keystroke to frame in the composer, p95 | **< 16 ms** |
| terminal clears outside a shrink segment | **0** |
| animation frames per second under the throttle | **≤ the configured maximum + 1** |
| reply to a typed greeting, p95, against a mock decider | **≤ 40 ms** |

Sources: [`docs/DESIGN.md`](../DESIGN.md) §12, [`docs/TUI-DESIGN.md`](../TUI-DESIGN.md) §18,
[`docs/TUI-DESIGN-2.md`](../TUI-DESIGN-2.md) §9.

## The machine and the load

| | |
| --- | --- |
| measured at | 2026-09-22T14:55:07Z |
| machine | Apple M5 Pro, 15 CPUs, 24 GiB, darwin 25.6.0 |
| Node | v22.23.2 |
| one-minute load average at start / at end | 5.26 / 2.16 |
| load gate for a release number | ≤ 2 at both ends — **not met** on this run |
| partial run | no; all nine probes ran |

The load gate matters. The harness-overhead figure passes by a few milliseconds and flips under modest load, so
a run taken above the quiet threshold is a working number and not a release number. This one was.

## What passed

| measurement | result | gate |
| --- | --- | --- |
| first frame, `run` at 40×120, cold compile cache: p95 / median over 10 runs (warm median) | 132.1 / 126.9 ms (100.8) | < 300 ms |
| first frame, `run` at 24×80 | 132.8 / 125.9 ms (99.8) | < 300 ms |
| first frame, `run` at 8×40 | 126.1 / 121.9 ms (95.8) | < 300 ms |
| first frame, `chat` at 40×120 | 128.2 / 126.4 ms (101.2) | < 300 ms |
| first frame, `chat` at 24×80 | 139.0 / 125.7 ms (99.8) | < 300 ms |
| first frame, `chat` at 8×40 | 124.1 / 122.3 ms (95.4) | < 300 ms |
| harness overhead per step, p95 / p50 | **42.6 / 15.0 ms** | < 50 ms |
| prompt build, warm, p95 / p50 | 0.7 / 0.2 ms | p95 < 5 ms |
| prompt build, cold — the first prompt after a resume | 0.7 ms | < 25 ms |
| event-loop lag while typing during a live run, p95 net of the idle floor (40 rows / 12 rows / reduced motion) | 4.15 / 1.43 / 3.97 ms | < 5 ms net |
| event-loop lag, maximum, raw | 27.37 / 22.28 / 28.54 ms | < 50 ms |
| **terminal clears after the first frame during a live run** | **0 / 0 / 0 / 0** | 0 |
| scrollback-erase sequences anywhere in the capture | **0 / 0 / 0 / 0** | 0, every geometry |
| frames taller than the terminal | 0 / 0 / 0 / 0 | 0 |
| composer keystroke to frame, idle, p50 / p95 / max | 5.1 / 7.1 / 7.7 ms | p95 < 16 ms |
| composer keystroke to frame, during a live run | 3.3 / 6.2 / 14.4 ms | p95 < 16 ms |
| reply to a typed greeting, mock decider at 0 ms, p95 | 15.2 ms | ≤ 40 ms |
| reply to a typed greeting, mock decider delayed 150 ms, p95 net of the delay | 17.9 ms | ≤ 40 ms net |
| idle animation, frames per second, busiest second / mean | 4 / 1.6 | ≤ 4 peak, ≤ 2/s mean |
| idle animation bytes, busiest second / mean per second | 8,948 / 3,511 B | ≤ 12,288 / ≤ 5,120 B |

The step-overhead figure deserves its breakdown. The steps that copy a pre-image carry the p95 almost by
themselves: those steps are 43.9 ms at p95 and 34.2 ms at p50, every other kind of step is 21.4 ms at p95. The
margin against the 50 ms gate is **6.1 ms**, which is the whole reason the load gate exists.

The image copy itself is 32.4 ms at p95 across steps that take images, and 35.1 ms at p95 on the steps that copy
a 15 MiB dirty set. That is above the 15 ms figure the design aimed at. It is reported, not gated, because it
sits inside the harness figure that **is** gated.

A first-frame breakdown on the child's own clock, at 24×80: a bare `node -e ''` returns at 23.4 ms, the render
call returns at 116.0 ms, the frame is flushed at 126.3 ms. Most of the first frame is loading and evaluating
the bundle.

## What failed on this run

The overall result of the last recorded run is **fail**. Three of the nine probes are red.

**The scroll probe.** The full-screen renderer's scrolling is over budget on every one of its rows:

| measurement | result | gate |
| --- | --- | --- |
| scroll key to frame, p50 / p95 / max (40×120, 20,000 items) | 21.9 / 44.2 / 55.3 ms | p95 < 16 ms, max < 50 ms |
| bytes in the widest scroll frame | 3,070 B | ≤ 6,144 B |
| rebuild after a width change | 80.5 ms | < 50 ms |
| frames not exactly as tall as the terminal | **368** | 0 |
| clears after the first frame during scrolling | **3** | 0 |

**The state-sweep probe.** Three of eighteen scripted terminal scenarios time out rather than finishing: a review
card at 12×60, and two fault scenarios at 24×80. Because those three never complete, the sweep's overall clear
count cannot be read as a pass either.

**One composer series.** A palette scenario that types an argument locates only 70 of 200 keystrokes and reports
a p95 of 13.6 seconds. Latency on that series is reported rather than gated — a key that arrives inside the
renderer's throttle window waits for the trailing edge by design — but the located-key count is the honest
signal that the scenario itself is not driving the surface it means to.

These are the interactive surface's own rows. They do not touch the step loop, the search, or any measurement on
the other pages here.

## What the probes actually do

| probe | what it drives |
| --- | --- |
| first frame | spawns the real binary in a pseudo-terminal, ten times per geometry, cold and warm compile cache, and times the first flushed frame |
| step overhead | a mocked zero-latency run of 50 steps over a 5,000-file git fixture plus 5,000 ignored files, with 50 dirty files and 15 MiB copied at every step that takes an image |
| static append | mounts the real interface in-process and measures bytes per committed transcript line |
| render lag | a 10 keys-per-second typist during a live mocked run paced at about 5 steps per second, plus one zero-latency stress row that is reported and not gated |
| composer latency | nine keystroke series, including a burst at 33 keys per second |
| intake latency | twenty typed greetings and tool questions against a mock decider at 0 ms and at 150 ms |
| idle frames | 30 seconds of an untouched idle screen |
| states | eighteen scripted scenarios across cards, pickers, faults, a manual repaint and three resize sequences |
| scroll latency | page-up and page-down over 20,000 transcript items in the full-screen renderer |

Two flags help while iterating: keeping every capture and timing file for inspection, and running a subset of
probes. A subset run is still written to the output file, but it carries `partial: true`, it never counts as a
release number, and it never rewrites a README section.
<!-- src/perf/main.ts:193 (`partial`), :314-318 -->

## Reading these against a release

A release number needs three things this run did not all have: every probe green, the machine quiet at both
ends, and a complete rather than partial run. See [Releasing](../contributing/releasing.md) for where the perf
gate sits in the checklist, and [`docs/STATUS.md`](../STATUS.md) for the per-round gate rows.

## Related

- [The warm plane A/B](warm-plane.md) — the other place a wall number is gated, and the other place load
  matters.
- [Measurements index](README.md).
