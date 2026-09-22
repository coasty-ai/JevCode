# The side-by-side recording

![Two terminals fixing the same bug, one in each mode](side-by-side.gif)

Two terminals, one bug, the same model in both. On the left JevCode runs in its default mode.
On the right the same binary runs with `--mode jev-off`, where the model drives every step on
its own and nothing arbitrates. Both panes start at zero. Both replay at the same speed. The
left one stops after 40 seconds; the right one keeps going for another two minutes.

Nothing in the picture is staged. It is two live runs, one after the other, rendered from the
bytes the terminal actually received.

## The task

QuixBugs `detect_cycle`: a cycle detector with one missing condition. The prompt is one
sentence, the same for both runs:

> The function `detect_cycle` in `detect_cycle.py` has a bug that makes some tests in tests/
> fail. Fix it without changing the tests.

The workspace holds the buggy program, its six tests, a pytest layout and a single git commit.
Both runs got a fresh copy of it. Both arrived at the same one-line fix — the fast pointer can
reach the end of the list before its successor does, so it has to be checked too:

```diff
     while True:
-        if hare.successor is None:
+        if hare is None or hare.successor is None:
             return False
```

## What the two modes are

`--mode llm-jev` is the default. The model proposes candidate patches, the workspace's own
tests run against them, and a small decision model called Jev arbitrates: which candidate to
keep, whether the step succeeded, whether the task is done.

`--mode jev-off` turns all of that off. The model writes an action each step, the action runs,
and the model decides when it is finished. That is the ordinary shape of a coding loop, and it
is what the right-hand pane shows. Both arms ran on shipped defaults; neither was tuned for
this recording.

## Method

| | |
|---|---|
| Model | `z-ai/glm-5.3-flash` through OpenRouter — the default, not a flag |
| Decision model (left pane only) | `jev-1.13.0` |
| Limits, both arms | `--max-steps 12 --max-wall 8m --spend-cap 0.06` |
| Max output tokens | 4096, the default, both arms |
| Sandbox | `auto` — seatbelt on macOS, writes confined to the workspace and the run directory |
| Terminal | a real pseudo-terminal, 30 rows by 100 columns |
| Isolation | each run gets its own empty `HOME` and its own copy of the workspace |
| Keys | read from a `.env` file by `node --env-file`; never on a command line, never in the recording |
| Order | sequential, never concurrent |
| Build | jevcode 0.5.0 on Node v22.23.2 |

The machine was shared, so the load average is part of the record:

| Arm | Started (UTC) | Load average before | Load average after |
|---|---|---|---|
| left, default mode | 2026-09-22 22:00:28 | 6.92 6.18 6.40 | 8.24 6.63 6.55 |
| right, `--mode jev-off` | 2026-09-22 22:01:31 | 6.65 6.38 6.46 | 4.35 5.54 6.11 |

## The numbers

Both runs ended with all six of the task's tests passing, checked afterwards by the benchmark's
own test runner rather than by the run's own opinion of itself.

| | left: default mode | right: `--mode jev-off` |
|---|---|---|
| Run id | `20260922-220028-kdvdsppg` | `20260922-220131-iwcpq4rt` |
| Wall time | **40.2 s** | **168.9 s** |
| Steps | 2 | 4 |
| Generator calls | 1 | 4 |
| Generator tokens (in / out) | 1 689 / 316 | 11 092 / 3 246 |
| Jev requests (questions) | 9 (11) | 0 |
| Cost, generator | $0.000411 | $0.002285 |
| Cost, Jev | $0.000314 | $0 |
| **Cost, total** | **$0.000726** | **$0.002285** |
| Stop reason | `complete` | `generator_done` |
| Tests after the run | 6 of 6 pass | 6 of 6 pass |

Four times faster and roughly three times cheaper, on this task, in this pair of runs.

## Where the time went

The left arm spent 9.8 seconds inside its one model call and 1.9 seconds across its nine Jev
requests. The other half-minute went on work that costs nothing per token. First it ran the
suite to find out what was broken: 5 of 6 tests passed. Then it produced 170 candidate patches
around the failing one and ran 137 of them against the suite on eight parallel lanes. It kept
the candidate that turned 5 of 6 into 6 of 6 with nothing else regressing, and its second step
re-ran the suite to confirm.

The right arm spent 168.4 of its 168.9 seconds inside four model calls: 2.1 s, 5.9 s, **155.2
s** and 5.2 s. One slow call is most of the gap. That is worth saying out loud, because it is
also the honest reason a single pair of runs cannot carry a claim: a loop that waits on one
long model call is exposed to exactly that kind of tail, and a loop that asks a small model
many short questions is not. How often the tail lands is what the repeated measurements are
for.

## This is one run each

One run per arm is an illustration, not a measurement. Model latency varies, the machine was
busy, and a single pair proves nothing on its own. The measured head-to-head tables — many
tasks, both arms, pass rates and cost per solved task — live in `docs/measurements/`. Read
those for the claim; read this page for the shape of it.

The same pairing on the recorded benchmark slice put `detect_cycle` at 33.6 s in the default
mode against 163.0 s with `--mode jev-off`, so the live pair here is in the ordinary range for
this task rather than a lucky draw.

## The picture

Both panes replay at one sixth of real speed — a constant, the same for both, stated in the
caption burned into the image. The clock under each pane counts seconds from launch, so the
two clocks stay in step until the left one stops. A pane freezes on its own last frame and
gains a green badge with its wall time and its cost; the other keeps running.

| | |
|---|---|
| Size | 1246 × 513 |
| Frame rate | 10 fps |
| Compression | 6× (30.3 s of animation for 169 s of terminal) |
| Colours | 64, quantised from the colours the terminal received |
| File | 318 KB |

Colour, bold and dim are reproduced from the escape sequences in the capture; nothing was
re-coloured by hand. A poster of the final frame is next to the GIF as `side-by-side.png`.

## Reproducing it

From a checkout with a `.env` holding `OPENROUTER_API_KEY`:

```sh
npm run build
scripts/demo/side-by-side/record.sh left  /tmp/side-by-side/left
scripts/demo/side-by-side/record.sh right /tmp/side-by-side/right
python3 scripts/demo/side-by-side/render.py \
  /tmp/side-by-side/left /tmp/side-by-side/right \
  --out docs/media/side-by-side.gif --poster docs/media/side-by-side.png \
  --factor 6 --fps 10
```

`record.sh` builds the workspace, takes the load average, and runs one command inside a
pseudo-terminal. For the left arm that command is:

```sh
env -u ANTHROPIC_API_KEY HOME=/tmp/side-by-side/left/home \
  node --env-file=.env bin/jevcode.js run \
  'The function `detect_cycle` in `detect_cycle.py` has a bug that makes some tests in tests/ fail. Fix it without changing the tests.' \
  --mode llm-jev \
  --workspace /tmp/side-by-side/left/detect_cycle \
  --trust-workspace \
  --max-steps 12 --max-wall 8m --spend-cap 0.06
```

The right arm is the same command with `--mode jev-off`.

The recording directories are not committed: each one contains the run's whole home directory,
its transcript and a copy of a Python environment. What is committed is the GIF, the poster and
this page. The recorder refuses to hand a capture to the renderer if anything key-shaped appears
in it, and the renderer checks again before it draws.

See [`scripts/demo/side-by-side/README.md`](../../scripts/demo/side-by-side/README.md) for the options.
