# Startup, render and harness overhead

These numbers are about the program, not the models. How fast the first frame appears, how much wall the
harness itself adds to a step, whether drawing the screen ever blocks the loop, and whether the terminal is
left alone.

They are **machine-bound**. Every figure below was taken on one laptop under a stated load. Treat them as a
description of that run, not as a specification of your machine.

`npm run perf` measures all of it, writes the raw values to `perf/results/latest.json`, and **exits 1 when
any gate fails**. A complete run — the nine release probes, no `JEVCODE_PERF_ONLY` subset — also rewrites the
`## Performance` section of **this page** from that file, so that table cannot drift from the data; it does so
only inside a JevCode checkout, and the public README carries no table. The tables further down are transcribed
from `perf/results/latest.json` by hand and dated; no run rewrites them.
<!-- src/perf/main.ts PERFORMANCE_PAGE, rewriteReadmePerformance; src/perf/readme.ts updateReadmePerformance -->

## Performance

_This section is rewritten by `jevcode perf` after every complete run (all nine release probes; `PERFORMANCE_PAGE` in `src/perf/main.ts`), which states whether the machine was quiet enough for a release number; until the first such run on this tree it holds no table._

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
| reply to a typed greeting, p95, against a mock decider (the session's first message reported apart) | **≤ 40 ms** |
| the `[you]` bubble after Enter, p95 (the session's first message reported apart) | **< 16 ms** |

Sources: [`docs/DESIGN.md`](../DESIGN.md) §12, [`docs/TUI-DESIGN.md`](../TUI-DESIGN.md) §18,
[`docs/TUI-DESIGN-2.md`](../TUI-DESIGN-2.md) §9.

The streaming budgets belong to the opt-in `stream-latency` probe ([below](#streaming-the-opt-in-stream-latency-probe)).
They are recorded on every run of that probe and are red today by design: the probe measures the tree before the
streaming work lands, and it joins the release set once it is green.

| streaming budget | value |
| --- | --- |
| first streamed text on screen after the first token, p95 | **≤ 20 ms** |
| streamed deltas on screen before the reply commits | **100 %** |
| rows the user saw that change when a streamed reply commits · blank lines dropped | **0 · 0** |
| last streamed delta to commit, p95 | **≤ 50 ms** |
| terminal clears while text streams | **0** |
| animation frames per second while text streams | **≤ 31 (≤ 16 under SSH)** |
| keystroke to frame while a reply streams, p95 | **< 16 ms** |

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

**Since that run.** The chat rebuild stopped printing the `[run] started` line these probes waited for, so every
scenario that needs a live run timed out until the anchor moved to the status row (2026-09-23). A partial re-run of
the four affected probes that day (load 1.49 at the start, 1.60 at the end) had no anchor timeout: the composer
`live`, `live-stress` and `review` series located 200 of 200 keys, and the three state scenarios above still time
out, each on a row of its own (the review card at 12×60, the run's end after a pane fault, the live-pane failure
text). It also showed a red the dead anchor had hidden: the event-loop lag maximum while typing during a live run
read 72.8 ms at 40 rows and 74.8 ms under reduced motion, against the 50 ms gate (40.6 ms at 12 rows).

## Streaming (the opt-in `stream-latency` probe)

`JEVCODE_PERF_ONLY=stream-latency npm run perf` (or `node bin/jevcode.js perf --out <file>` after a build) times a
chat reply while it is generated, in a real pseudo-terminal, with no network.

- **The reply is known.** Under `--mock`, `JEVCODE_MOCK_CHAT_STREAM=mixed` streams a 421-character reply in 46
  deltas: a greeting line split across two deltas, two short lines, a 30-word paragraph wider than two 80-column rows,
  three bullets, a fenced code block and three blank lines (`long` is about 8 KB). `JEVCODE_MOCK_DELTA_MS` sets the gap;
  the mock paces the deltas against deadlines, so a late timer shortens the next wait instead of delaying the rest.
  Every text delta ends in a unique marker (`k01`, `p17`, …) that is looked for as a whole token on screen. The three
  knobs are read only by the mock provider; with them unset `--mock` answers exactly as before.
- **Emission meets paint on one clock.** The child logs each delta's `process.hrtime.bigint()` in memory and writes
  the log once at exit (`JEVCODE_PERF_STREAM_LOG`). The typist records one `CLOCK_MONOTONIC_RAW` reading next to its
  own clock; on macOS that clock shares Node's hrtime base, so every emission lands on the pty timeline and is paired
  with the first pty write that shows its marker.
- **The commit is found by Ink's own accounting**, not by a label: it is the first frame whose rows above the dynamic
  region carry the reply's last marker, and the dynamic region is what the next write erases. A future reply tail
  drawn above the rule therefore counts as live text, not scrollback.

Series, three messages each (`hi`, `hello`, `thanks`; the first is the session's cold one and is reported apart): the
`mixed` reply at 30 ms and 5 ms gaps at 24×80 and 40×120; at 30 ms under SSH (15 fps); at 2 ms with the mock decider
delayed 150 ms, so the stream ends before the reading and the commit shows whether it waits for Jev; `long` at 2 ms
with the event-loop lag probe (reported); and 10 keys per second typed while the 30 ms reply streams.

Per message the probe reports every delta's emission-to-paint time, the first feedback, the first text, the share of
deltas on screen before the commit (deltas emitted within one throttle period of the commit are left out), the frame
rate and spacing while text streams, bytes per streamed character, the last delta to commit, and the commit
comparison: how many rows of the last live frame do not reappear verbatim in the committed block, the row and column
shift, and the blank lines dropped. Per series it adds clears, `ESC[3J`, the tallest region, the child's resident
memory, keystroke latency and event-loop lag. `JEVCODE_PERF_KEEP=<dir>` keeps each capture, its timing file and its
emission log.

The baseline, measured 2026-09-23T17:57Z on the machine below (one-minute load 2.78 at the start, 1.49 at the end,
so not a release number), before any of the streaming work has landed:

| series | first text p95 (cold) | delta → paint p50 / p95, before commit | on screen before commit | the commit | blank lines dropped | last delta → commit p95 | dynamic fps | bytes per char |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat-30ms-24x80` | 95.3 ms (92.6) | 29.1 / 37.7 ms | 15/39 · 15/39 · 15/39 | 2 → 15 rows, +10 columns | 3 | 8.5 ms | 14 | 107.9 |
| `chat-5ms-24x80` | 4.8 ms (3.3) | 13.8 / 39.7 ms | 10/37 · 10/37 · 11/37 | 2 → 15 rows, +10 columns | 3 | 7.0 ms | 20 | 35.0 |
| `chat-30ms-40x120` | 100.0 ms (94.4) | 30.7 / 43.1 ms | 20/39 · 20/39 · 20/39 | 2 → 14 rows, +10 columns | 3 | 9.9 ms | 18 | 244.4 |
| `chat-5ms-40x120` | 6.3 ms (4.5) | 16.8 / 39.3 ms | 15/37 · 15/37 · 15/37 | 2 → 14 rows, +10 columns | 3 | 8.2 ms | 25 | 72.0 |
| `chat-ssh-30ms-24x80` (15 fps) | 128.0 ms (124.0) | 36.0 / 68.5 ms | 13/39 · 11/38 · 11/38 | 2 → 15 rows, +10 columns | 3 | 10.6 ms | 10 | 76.7 |
| `chat-mock150-2ms-24x80` | 3.6 ms (3.6) | 31.1 / 40.4 ms | 11/40 · 11/40 · 13/40 | 1 → 15 rows, +10 columns | 3 | **69.5 ms** | – | 31.1 |
| `long-2ms-24x80` (reported) | 41.6 ms (40.4) | 21.5 / 37.8 ms | 115/519 · 113/518 · 120/517 | 1 → 120 rows | 23 | 15.6 ms | 27 | 9.8 |
| `type-while-streaming-30ms-24x80` | 62.3 ms (62.3) | 17.8 / 46.1 ms | 17/39 · 17/39 · 17/39 | 2 → 15 rows, +10 columns | 3 | 10.3 ms | 11 | 164.8 |

Every series had 0 clears and 0 `ESC[3J`, the region stayed within rows − 2, and the typist's keys while text
streamed read 6.3 ms at p95. The first frame after the first token arrives in 3–6 ms in every series; what it shows
is the problem:

- **Text appears late and partly.** At a 30 ms gap the first readable text comes about 93 ms after the first token:
  until the first line break the live view shows only `streaming… N chars`, and after it only the last two rows, cut at
  the terminal width rather than wrapped. Fewer than half of the deltas are ever on screen before the reply commits.
  At 5 ms the first two deltas arrive together, the line break comes with them, and the first text is quick — the
  rest is still mostly hidden.
- **The commit jumps.** The two live rows become fifteen committed rows, every one of them moved ten columns right by
  the `[jevcode]` label and gutter, and the reply's three blank lines are dropped.
- **The commit waits for Jev.** With the decider delayed 150 ms and a stream that ends first, the last delta reaches
  the screen as a committed block about 70 ms after it was generated.
- **Every frame repaints the whole region**, the wordmark included: about 2.2 KB a frame at 24×80 and 4.4 KB at
  40×120, which is 108 and 244 bytes per streamed character at a 30 ms gap.
- Frames during a stream are sparse: the median spacing was 57.5 ms at a 30 ms gap and 40.6 ms at 5 ms (24×80),
  against the 34 ms the 30 fps limit allows.
<!-- src/perf/stream-latency.ts, src/perf/stream-fixture.ts, src/cli/mock-trajectory.ts mockChatReplyFromEnv, perf/drivers/pty_type.py clock record -->

## What the probes actually do

| probe | what it drives |
| --- | --- |
| first frame | spawns the real binary in a pseudo-terminal, ten times per geometry, cold and warm compile cache, and times the first flushed frame |
| step overhead | a mocked zero-latency run of 50 steps over a 5,000-file git fixture plus 5,000 ignored files, with 50 dirty files and 15 MiB copied at every step that takes an image |
| static append | mounts the real interface in-process and measures bytes per committed transcript line |
| render lag | a 10 keys-per-second typist during a live mocked run paced at about 5 steps per second, plus one zero-latency stress row that is reported and not gated |
| composer latency | nine keystroke series, including a burst at 33 keys per second |
| intake latency | twenty typed greetings and tool questions against a mock decider at 0 ms and at 150 ms; the first message of the session is reported apart, the gates read the rest, and the probe records whether the bubble is already in the first frame after Enter |
| idle frames | 30 seconds of an untouched idle screen |
| states | eighteen scripted scenarios across cards, pickers, faults, a manual repaint and three resize sequences |
| scroll latency | page-up and page-down over 20,000 transcript items in the full-screen renderer |
| stream latency (opt-in) | a streamed chat reply timed per delta from emission to paint, across eight series ([above](#streaming-the-opt-in-stream-latency-probe)) |

Every window a probe measures opens on a named anchor, and a pty test finds each one in a real capture, so a
change to the interface cannot quietly stop a probe from finding its window. That test exists because of the chat
rebuild: the probes that need a live run waited for a `[run] started` line that the interactive screen no longer
prints, and all of them timed out until the anchor moved to the status row's `step n/m`.
<!-- src/perf/pty.ts RUN_STARTED_PATTERN, NAMED_ANCHORS; test/pty/chat.pty.test.ts anchor liveness -->

Two flags help while iterating: keeping every capture and timing file for inspection, and running a subset of
probes. A subset run is still written to the output file, but it carries `partial: true`, it never counts as a
release number, and it never rewrites this page's Performance section. Naming an opt-in probe (`stream-latency`,
`lane-run`, `sandbox-spawn`) always makes the run partial.
<!-- src/perf/main.ts selectedProbes, OPT_IN_PROBES, measureAll (`partial`) -->

## Reading these against a release

A release number needs three things this run did not all have: every probe green, the machine quiet at both
ends, and a complete rather than partial run. See [Releasing](../contributing/releasing.md) for where the perf
gate sits in the checklist, and [`docs/STATUS.md`](../STATUS.md) for the per-round gate rows.

## Related

- [The warm plane A/B](warm-plane.md) — the other place a wall number is gated, and the other place load
  matters.
- [Measurements index](README.md).
