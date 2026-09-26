# The demo recording

![JevCode in a terminal: it answers hi, then fixes the failing tests in a small Python project, live](demo.gif)

One live session in a real terminal, replayed at the speed it happened. At a shell prompt in a fresh copy
of [`examples/demo-py`](../../examples/demo-py/README.md), someone types `jevcode`, says `hi`, asks it to
`fix the failing tests`, and types `/exit`, and the shell's prompt comes back under the session. Nothing is
staged, retouched or sped up. Every frame is replayed from the bytes the terminal received, and every number
on this page comes from the run's own records.

A caption that says only what the records show, for wherever the picture is used:

> A live session at real speed on the default model: the reply to `hi` starts 0.7 s after Enter, and
> `fix the failing tests` takes 8 steps, 6.7 s and $0.0014, after which all 7 tests pass.

Neither run asked Jev anything (see [the numbers](#the-numbers)), so a caption for this picture does not credit
Jev with the fast reply.

## What happens

The clock counts seconds from the moment the shell started. The typist's own marks come from the driver's timing
file. The program's times come from when its output reached the terminal.

| At | What |
|---|---|
| 0.7 s | `jevcode` is typed at the prompt |
| 1.7 s | Enter. At 1.9 s the wordmark starts to draw in, as it does at every launch, and at 2.5 s it is complete, with the console open below it |
| 3.8 s | `hi` is sent |
| 4.5 s | the reply's first text is on screen, 0.69 s after Enter, and the rest has streamed in by 4.7 s |
| 8.8 s | `fix the failing tests` is sent |
| 9.3 s | one line of prose streams in: *"I'll run the test suite to see what's failing."* |
| 9.5 s | the first tool call, `python -m pytest -q`; its live output shows `FAILED tests/test_core.py::test_parse_expression_with_spaces` at 9.8 s, and at 9.9 s the row reads `4 passed, 3 failed` |
| 10.3 s | `Read calc/core.py` |
| 10.8 s | *"Two clear bugs: mean divides by len+1, and the regex doesn't allow whitespace. Fixing both."* |
| 11.4 s | `Edit calc/core.py (+1 −1)`, and a second one at 12.4 s |
| 13.0 s | `Bash python -m pytest -q · 6 passed, 1 failed` |
| 13.6 s | *"The test also passes a string with leading/trailing spaces — I'll allow that too."* |
| 13.9 s | `Edit calc/core.py (+1 −1)` |
| 14.6 s | `Bash python -m pytest -q · 7 passed` |
| 15.0 s | the summary streams in |
| 15.5 s | `finished · complete · 8 steps · 6s · $0.001`, 6.69 s after Enter |
| 18.7 s | `/exit` is typed and the command palette opens on it. Enter, at 19.8 s, closes the session |
| 19.8 s | the session puts the terminal back, with the cursor on the row under the console box |
| 19.9 s | the shell prints its prompt there: `demo-py $ `. The picture ends here and holds this frame for 3 s |

While the model thinks, the mini donut turns in the status row, in the cell where a spinner would be. While a command
or an edit runs, a small turning cube takes its place.

The wordmark scrolls away as the transcript grows. That is how the terminal behaved, and the picture keeps it.

## The numbers

These are the run records (`sessions/index.jsonl` and each run's directory under the recording's `JEVCODE_HOME`).
They are not read off the screen.

| | `hi` | `fix the failing tests` |
|---|---|---|
| Run id | `20260926-014431-bhmpavgs` | `20260926-014436-mmbc6knw` |
| Stop reason | `answered` | `complete` |
| Steps | 1 | 8 |
| Model turns (generator calls) | 1 | 8 |
| Jev requests | 0 | 0 |
| Wall time (run record) | 0.91 s | 6.65 s |
| Enter → on screen | first text of the reply: 0.69 s | the `finished` line: 6.69 s |
| Cost | $0.000415 | $0.001353 |

The whole session cost **$0.001768**. There was no Jev request, and the reason is in the design: on the default provider
the one question the agent loop could ask Jev (whether a first message is conversational) would change nothing, so
it is not asked ([Where Jev sits](../architecture/agent-loop.md#where-jev-sits)). The fast first reply is the provider's.

After the session the workspace's own tests were run once more, outside JevCode: `7 passed`. The change the run made:

```diff
-    return sum(items) / (len(items) + 1)
+    return sum(items) / len(items)
 
 
-_EXPR = re.compile(r"^(-?\d+(?:\.\d+)?)([+\-*/])(-?\d+(?:\.\d+)?)$")
+_EXPR = re.compile(r"^(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)$")
 
 
 def parse_expression(text: str) -> tuple[float, str, float]:
-    m = _EXPR.match(text)
+    m = _EXPR.match(text.strip())
```

## Which take this is

Eight takes were recorded, one after the other, never two at the same time. Each started from nothing: a new copy of
the workspace, a new `JEVCODE_HOME`, and the same typist seed, so the keys went in identically every time. All eight
fixed both bugs.

Takes 1–3 were made first, on `main`. Watching them showed a bug in the exit: the session left the terminal's cursor on
the console's input row, so the shell printed its next prompt inside the box, over that row
(`│ › demo-py $  question, or /command…`). That is fixed in this change: the session's last frame no longer places the
cursor, so the cursor goes back under the box before the terminal is handed back
(`test/pty/exit-cursor.pty.test.ts`, `test/unit/tui/exit-cursor.test.tsx`). Takes 4–8 were made on the fixed build,
with the committed scripts.

Takes 5 and 6 each lost the connection to the provider during the fix and showed the retry row
(`generator: retrying 1/3 … offline: cannot reach the host`). Both recovered and fixed the tests, but a dropped
connection is not how a session usually goes, so they were set aside. Of takes 4, 7 and 8, the one shown is take 8,
the closest to their median on both the `hi` reply's first text and the fix's wall time. It was picked by that rule,
not as the fastest: take 7 fixed the tests sooner and answered `hi` sooner.

| Take | Build | Started (UTC) | `hi`: Enter → first text / run wall | fix: run wall · steps · model turns | Session cost | Tests after |
|---|---|---|---|---|---|---|
| 1 | before the exit fix | 2026-09-26 00:49:01 | 0.65 s / 0.73 s | 8.92 s · 8 · 8 | $0.004133 | 7 passed |
| 2 | before the exit fix | 2026-09-26 00:51:30 | 2.47 s / 2.44 s | 5.76 s · 7 · 5 | $0.003189 | 7 passed |
| 3 | before the exit fix | 2026-09-26 00:52:01 | 1.26 s / 1.40 s | 9.93 s · 8 · 8 | $0.002942 | 7 passed |
| 4 | fixed | 2026-09-26 01:36:37 | 3.62 s / 4.12 s | 6.42 s · 8 · 7 | $0.003142 | 7 passed |
| 5 | fixed | 2026-09-26 01:37:48 | 1.16 s / 1.17 s | 9.32 s · 11 · 9, one provider retry | $0.002125 | 7 passed |
| 6 | fixed | 2026-09-26 01:38:14 | 0.52 s / 0.82 s | 22.06 s · 10 · 9, provider retries | $0.004199 | 7 passed |
| 7 | fixed | 2026-09-26 01:44:04 | 0.64 s / 0.81 s | 6.28 s · 10 · 9 | $0.002066 | 7 passed |
| **8 (shown)** | fixed | 2026-09-26 01:44:27 | 0.69 s / 0.91 s | 6.65 s · 8 · 8 | $0.001768 | 7 passed |

One probe session came before the takes. It used no shell and fixed sleeps, and its only job was to learn what the
screen prints at each stage. It is not in any picture. The eight takes and the probe cost about $0.027 together.

## Method

| | |
|---|---|
| Build | jevcode 0.8.0 from this repository: `main` at `92a8b1b` plus the exit fix of `365b851` (`src/tui/App.tsx`), Node v22.23.2 |
| Machine | Apple M5 Pro, 15 cores, 24 GB, macOS 26.6.2 |
| Load average (take 8) | 4.45 3.53 3.47 before, 4.26 3.54 3.47 after. The machine was shared with other work |
| Terminal | a real pseudo-terminal, 28 rows × 100 columns, `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=en_US.UTF-8` |
| Shell | macOS's `/bin/bash --noprofile --norc -i`, prompt `\W $ ` |
| What `jevcode` runs | a two-line shim on `PATH` that execs this checkout's `bin/jevcode.js` under `node --env-file=.env` |
| Flags | none. Every setting is the default: mode `agent`, provider `openrouter`, model `z-ai/glm-5.3-flash`, autonomy `full`, agent verification `off`. The only variables set are the isolation ones below |
| Jev | configured (`TYPESAFE_API_KEY` present, `jev-1.13.0`); 0 requests, as above |
| Keys | read from `.env` by `node --env-file`, with `ANTHROPIC_API_KEY` unset in the environment. No key is on any command line. Before rendering, the capture was scanned for `sk-`, `sk_`, `Bearer ` and the key variables' names |
| Workspace | `examples/demo-py` copied fresh for each take, one git commit, a `.venv` with pytest, as its README says |
| Typing | one key at a time, 70–140 ms apart (a little longer after a space), from a seeded generator. Every wait for the program is a wait for its output, not a timer |

**Isolation.** Take 8 ran with `HOME` set to an empty directory inside the take, as [the rules](README.md) ask, so
nothing of the machine's user was read. On top of that the take kept its own `JEVCODE_HOME` (runs, sessions, trust
store, coordination, model cache), pointed `JEVCODE_CONFIG` at an empty `{}`, and set `JEVCODE_NO_IMPORT`,
`JEVCODE_NO_MEMORY` and `JEVCODE_NO_HISTORY`. bash kept its history in the take (`HISTFILE`). The tests ran from the
workspace's `.venv`.

Takes 1–3 were recorded before `record.sh` set `HOME` and `HISTFILE`. That is the only difference between the script
that made them and the committed one. They ran with the machine user's `HOME`, with the `JEVCODE_*` variables above
keeping JevCode's own files out of it, and bash appended the `jevcode` and `exit` typed in each of them to that user's
`~/.bash_history` (six lines).

## The picture

| | |
|---|---|
| Speed | **1×, real time.** The capture is sampled 25 times a second and each frame is shown for as long as the screen stood still, to the GIF's 10 ms. Nothing is sped up, including the idle stretches |
| Trimmed | before the first key: nothing (the picture opens on the shell's first prompt). After exit: only the `exit` typed at the shell's next prompt to end the recording. The prompt itself is shown |
| Hold | the last frame, the shell's prompt under the console box, is held 3 s before the loop restarts |
| Length | 19.85 s of terminal time, plus the 3 s hold |
| Size | 1656 × 1056: 100 × 28 cells of 16 × 34 px, drawn at twice the size it is meant to be shown at (about 830 px wide), so it stays sharp on high-density screens |
| Frames | 156 |
| File | 1.81 MB |
| Colours | 256, one palette for every frame, chosen by maximum coverage from the colours the terminal received (24-bit, from the theme), each entry set to the most common colour it stands for. 90.2% of all pixels are exactly the colour drawn, and none is off by more than 11 levels in any channel |
| Font | Menlo, sized so its advance is exactly one cell. The one emoji in the session (👋, in the reply to `hi`) is drawn from Apple Color Emoji into its two cells, as the terminal draws it |
| Background, foreground | `#1e1e1e`, the background the theme's contrasts are measured on; `#e5e5e5`, the theme's `code` colour. `dim` is drawn at 0.45 opacity, the value `scripts/gen-brand.mjs` uses |
| Drawn as shapes | braille (the mini donut), block elements (the wordmark) and light box drawing fill their cells, as most terminal emulators draw them. Menlo has no braille |
| Title bar | the model and provider from the run record, and "live recording, real time" |
| Poster | [`demo.png`](demo.png): the screen at 18.7 s, just before `/exit` is typed, at the same size, with every colour it was drawn with |

The screen is sampled only between complete repaints: the session wraps every repaint in synchronized-output mode
(2026), and the renderer honours it the way a terminal does. Before it draws anything, the renderer checks every
state the screen reached: the screen after each chunk the terminal received, and after each complete repaint when one
chunk held more than one. That is 183 distinct states from 458 chunks in this take. It looks for escape debris and
replacement characters, checks that every row of the console box is intact, and checks that the last state has the
shell's prompt below the box, at column 0. All 183 pass. With `--ignore-sync`, which samples mid-repaint as a terminal
without the mode would, the same check finds 175 torn states out of 385 and refuses to render. Run on take 3, the check
refuses too, on its last state: the prompt inside the box. Every frame of the GIF was also looked at by eye.

The version in the wordmark's caption is the build's. The demo is recorded again for each minor release, so the
picture shows the program as it is.

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
