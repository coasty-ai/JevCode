# The demo recording

![JevCode in a terminal: it answers hi, then fixes the failing tests in a small Python project, live](demo.gif)

One live session in a real terminal, replayed at the speed it happened. At a shell prompt in a fresh copy
of [`examples/demo-py`](../../examples/demo-py/README.md), someone types `jevcode`, says `hi`, asks it to
`fix the failing tests`, and types `/exit`. Nothing is staged, retouched or sped up. Every frame is replayed
from the bytes the terminal received, and every number on this page comes from the run's own records.

## What happens

The clock counts seconds from the moment the shell started. The typist's own marks come from the driver's timing
file. The program's times come from when its output reached the terminal.

| At | What |
|---|---|
| 0.7 s | `jevcode` is typed at the prompt |
| 1.7 s | Enter. At 1.9 s the wordmark starts to draw in, as it does at every launch, and at 2.5 s it is complete, with the console open below it |
| 3.8 s | `hi` is sent |
| 5.0 s | the reply's first text is on screen, 1.26 s after Enter, and the rest streams in |
| 9.3 s | `fix the failing tests` is sent |
| 10.0 s | the first tool call, `python -m pytest -q 2>&1 \| tail -30`; its live output shows `FAILED tests/test_core.py::test_mean_simple` at 10.4 s |
| 11.1 s | `Read calc/core.py` |
| 12.0 s | `Edit calc/core.py (+4 −2)`, then a test run and a look at the test that still fails |
| 15.5 s | one line of prose streams in: *"The test also allows leading/trailing whitespace — I'll anchor the regex accordingly."* |
| 17.5 s | `Edit calc/core.py (+1 −1)` |
| 18.1 s | `Bash python -m pytest -q 2>&1 \| tail -2 · 7 passed` |
| 18.5 s | the summary streams in |
| 19.3 s | `finished · complete · 8 steps · 9s · $0.003`, 9.98 s after Enter |
| 22.5 s | `/exit` is typed and the command palette opens on it. Enter closes the session |
| 23.6 s | the session has put the terminal back. The picture ends here and holds its last frame for 3 s |

While the model thinks, the mini donut turns in the status row, in the cell where a spinner would be. While a command
or an edit runs, a small turning cube takes its place.

The wordmark scrolls away as the transcript grows. That is how the terminal behaved, and the picture keeps it.

## The numbers

These are the run records (`sessions/index.jsonl` and each run's directory under the recording's `JEVCODE_HOME`).
They are not read off the screen.

| | `hi` | `fix the failing tests` |
|---|---|---|
| Run id | `20260926-005204-yjhpdr3a` | `20260926-005210-l67r2wld` |
| Stop reason | `answered` | `complete` |
| Steps | 1 | 8 |
| Model turns (generator calls) | 1 | 8 |
| Jev requests | 0 | 0 |
| Wall time (run record) | 1.40 s | 9.93 s |
| Enter → on screen | first text of the reply: 1.26 s | the `finished` line: 9.98 s |
| Cost | $0.000401 | $0.002541 |

The whole session cost **$0.002942**. There was no Jev request, and the reason is in the design: on the default provider
the one question the agent loop could ask Jev (whether a first message is conversational) would change nothing, so
it is not asked ([Where Jev sits](../architecture/agent-loop.md#where-jev-sits)).

After the session the workspace's own tests were run once more, outside JevCode: `7 passed`. The change the run made:

```diff
-    return sum(items) / (len(items) + 1)
+    return sum(items) / len(items)
 
 
-_EXPR = re.compile(r"^(-?\d+(?:\.\d+)?)([+\-*/])(-?\d+(?:\.\d+)?)$")
+_EXPR = re.compile(
+    r"^\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$"
+)
```

## Which take this is

Three takes were recorded one after the other, never at the same time. Each started from nothing: a new copy of the
workspace, a new `JEVCODE_HOME`, and the same typist seed, so the keys went in identically every time. All three fixed
both bugs. The one shown is take 3, picked as the most typical rather than the best. Its fix took 9.9 s, the closest of
the three to the about 9 s recorded for this task in
[STATUS](../STATUS.md#live-checks-on-the-integrated-tree), and its first reply falls between the other two. Take 2 fixed
the tests faster (5.8 s) and take 1 answered `hi` sooner. Take 3 happens to be the cheapest.

| Take | Started (UTC) | `hi`: Enter → first text / run wall | fix: run wall · steps · model turns | Session cost | Tests after |
|---|---|---|---|---|---|
| 1 | 2026-09-26 00:49:01 | 0.65 s / 0.73 s | 8.92 s · 8 · 8 | $0.004133 | 7 passed |
| 2 | 2026-09-26 00:51:30 | 2.47 s / 2.44 s | 5.76 s · 7 · 5 | $0.003189 | 7 passed |
| **3 (shown)** | 2026-09-26 00:52:01 | 1.26 s / 1.40 s | 9.93 s · 8 · 8 | $0.002942 | 7 passed |

One probe session came before the takes. It used no shell and fixed sleeps, and its only job was to learn what the
screen prints at each stage. It is not in any picture. The three takes and the probe cost $0.0137 together.

## Method

| | |
|---|---|
| Build | jevcode 0.8.0 from this repository (`main` at `92a8b1b`), Node v22.23.2 |
| Machine | Apple M5 Pro, 15 cores, 24 GB, macOS 26.6.2 |
| Load average (take 3) | 2.56 2.42 2.31 before, 2.61 2.45 2.32 after |
| Terminal | a real pseudo-terminal, 28 rows × 100 columns, `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=en_US.UTF-8` |
| Shell | macOS's `/bin/bash --noprofile --norc -i`, prompt `\W $ ` |
| What `jevcode` runs | a two-line shim on `PATH` that execs this checkout's `bin/jevcode.js` under `node --env-file=.env` |
| Flags | none. Every setting is the default: mode `agent`, provider `openrouter`, model `z-ai/glm-5.3-flash`, autonomy `full`, agent verification `off`. The only variables set are the isolation ones below |
| Jev | configured (`TYPESAFE_API_KEY` present, `jev-1.13.0`); 0 requests, as above |
| Keys | read from `.env` by `node --env-file`, with `ANTHROPIC_API_KEY` unset in the environment. No key is on any command line. Before rendering, the capture was scanned for `sk-`, `sk_`, `Bearer ` and the key variables' names |
| Workspace | `examples/demo-py` copied fresh for each take, one git commit, a `.venv` with pytest, as its README says |
| Typing | one key at a time, 70–140 ms apart (a little longer after a space), from a seeded generator. Every wait for the program is a wait for its output, not a timer |

**Isolation, and one deviation.** The rules in [README.md](README.md) ask for an empty home directory. The environment
this was recorded from does not let a command replace `HOME`, so these takes ran with the machine user's `HOME` and
moved everything JevCode keeps there into the take instead:

- `JEVCODE_HOME` held the runs, sessions, trust store, coordination and model cache.
- `JEVCODE_CONFIG` pointed at an empty `{}`, so no saved login or setting was read.
- `JEVCODE_NO_IMPORT`, `JEVCODE_NO_MEMORY` and `JEVCODE_NO_HISTORY` meant no import offer, no user memory file and no
  composer history.

None of the takes' runs, sessions or settings ended up under the user's `~/.jevcode` or `~/.config/jevcode`. Two
things still read `HOME`. One is the keybindings file, which does not exist on this machine. The other is the sandbox,
which denies reads of secret files under `HOME` and looks up version-manager directories there. The tests ran from the
workspace's `.venv`.

## The picture

| | |
|---|---|
| Speed | **1×, real time.** The capture is sampled 25 times a second and each frame is shown for as long as the screen stood still, to the GIF's 10 ms. Nothing is sped up, including the idle stretches |
| Trimmed | before the first key: nothing (the picture opens on the shell's first prompt). After exit: everything after the session's teardown, which is the shell's next prompt and the `exit` that ends the recording |
| Hold | the last frame, after exit, is held 3 s before the loop restarts |
| Length | 23.6 s of terminal time, plus the 3 s hold |
| Size | 1656 × 1056: 100 × 28 cells of 16 × 34 px, drawn at twice the size it is meant to be shown at (about 830 px wide), so it stays sharp on high-density screens |
| Frames | 173 |
| File | 1.66 MB |
| Colours | 256, one palette for every frame, quantised from the colours the terminal received (24-bit, from the theme) |
| Font | Menlo, sized so its advance is exactly one cell |
| Background, foreground | `#1e1e1e`, the background the theme's contrasts are measured on; `#e5e5e5`, the theme's `code` colour. `dim` is drawn at 0.45 opacity, the value `scripts/gen-brand.mjs` uses |
| Drawn as shapes | braille (the mini donut), block elements (the wordmark) and light box drawing fill their cells, as most terminal emulators draw them. Menlo has no braille |
| Title bar | the model and provider from the run record, and "live recording, real time" |
| Poster | [`demo.png`](demo.png): the screen at 22.5 s, just before `/exit` is typed, at the same size |

The screen is sampled only between complete repaints: the session wraps every repaint in synchronized-output mode
(2026), and the renderer honours it the way a terminal does. Before it draws anything, the renderer checks every
state the screen passed through, not only the sampled ones. It looks for escape debris and replacement characters,
and checks that every row of the console box is intact. The 190 states of this take all pass. With `--ignore-sync`,
which samples mid-repaint as a terminal without the mode would, the same check finds 183 torn states and refuses to
render. Every frame of the GIF was also looked at by eye.

The picture stops at the teardown and does not show the shell's next prompt. In this build the session leaves the
terminal's cursor on the console's input row when it exits, so the shell prints its next prompt over that row.

## Reproducing it

From a checkout with a `.env` holding `OPENROUTER_API_KEY`:

```sh
npm run build
scripts/demo/session/record.sh /tmp/jevcode-demo/take1
python3 scripts/demo/session/render.py /tmp/jevcode-demo/take1 \
  --out docs/media/demo.gif --poster docs/media/demo.png --scale 2
```

The take directories are not committed. Each one holds a whole `JEVCODE_HOME`, the run transcripts and a Python
environment. What is committed is the GIF, the poster and this page. See
[`scripts/demo/session/README.md`](../../scripts/demo/session/README.md) for the options.
