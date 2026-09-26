# Session recorder

This directory records the demo at the top of the README: one live, interactive JevCode session in a real
pseudo-terminal, replayed as a GIF at the speed it happened. The result is `docs/media/demo.gif`, with its still
`docs/media/demo.png`. How that take was made, and the numbers behind it, are in
[`docs/media/demo.md`](../../../docs/media/demo.md).

| File | What it does |
|---|---|
| `record.sh` | builds a fresh workspace and runs one take in a pseudo-terminal |
| `steps.py` | the keystroke plan: what is typed, at what pace, and what output each wait is for |
| `meta.py` | summarises a take from its own records into `meta.json` |
| `render.py` | replays a take's bytes into the GIF and the still |

## Requirements

* A built CLI: `npm run build`. The recorder runs `bin/jevcode.js`.
* A `.env` holding `OPENROUTER_API_KEY`. `TYPESAFE_API_KEY` is optional. Keys are read by `node --env-file` and
  never appear on a command line.
* Python 3.9 or newer, with [Pillow](https://pypi.org/project/pillow/) for the renderer. The workspace's `.venv` is
  built with `pip install pytest`, so the first take needs the network.
* macOS or Linux. On macOS the renderer uses Menlo. Elsewhere it uses DejaVu Sans Mono.

## Recording

```sh
scripts/demo/session/record.sh /tmp/jevcode-demo/take1
```

The output directory must not exist yet, or must be empty. Record takes one after the other, never at the same time.
Two live sessions competing for one machine measure the machine.

The scene is typed into `/bin/bash --noprofile --norc -i` at a `demo-py $ ` prompt:

1. `jevcode`
2. `hi`, then a wait for the reply
3. `fix the failing tests`, then a wait for the run's `finished` line
4. a pause long enough to read the result
5. `/exit`
6. `exit` to leave the shell

`jevcode` resolves to a two-line shim on `PATH` that runs this checkout's `bin/jevcode.js`. The workspace is
`examples/demo-py`, copied fresh, with one git commit and a `.venv` holding pytest.

Keys go in one at a time, 70–140 ms apart and a little longer after a space, from a generator seeded with `SEED`, so
takes with the same seed type identically. Each wait for the program is an `expect` on what the program printed, never
a timer. A slow reply is recorded as slow.

| Variable | Default | Meaning |
|---|---|---|
| `ENV_FILE` | `<repo>/.env` | the file `node --env-file` reads the keys from |
| `PTY_ROWS` / `PTY_COLS` | `28` / `100` | terminal geometry |
| `SEED` | `7` | the typist's seed |

`HOME` is not replaced. Everything JevCode keeps under it goes into the take instead: `JEVCODE_HOME`, an empty
`JEVCODE_CONFIG`, and `JEVCODE_NO_IMPORT`, `JEVCODE_NO_MEMORY` and `JEVCODE_NO_HISTORY`. bash keeps its history in the
take too.

A take directory ends up with:

```
capture.bin      every byte the terminal received
timing.jsonl     when each byte arrived, the keys sent, and the typist's marks
meta.json        each run's id, stop reason, steps, model turns, Jev requests, wall time and cost; the reply and
                 finish latencies; the load average; the workspace's test result after the session
oracle.txt       the tail of the workspace's own pytest run after the session
fix.diff         what the run changed
demo-py/         the workspace, with its git history
.jevcode/        the take's JEVCODE_HOME: the run directories and the session index
```

After a take, `record.sh` scans the capture for anything key-shaped. If it finds any, it exits 3 before a frame can be
drawn.

## Rendering

```sh
python3 scripts/demo/session/render.py /tmp/jevcode-demo/take1 \
  --out docs/media/demo.gif --poster docs/media/demo.png --scale 2
```

| Option | Default | Meaning |
|---|---|---|
| `--fps` | `25` | how often the capture is sampled. A frame lasts as long as the screen stood still |
| `--scale` | `1` | pixels per point in the GIF. `2` draws it at twice its display size, for high-density screens |
| `--poster-scale` | `2` | the same for the still |
| `--cell-width`, `--cell-height` | `8`, `17` | the character cell in points. The font is sized so its advance is exactly one cell |
| `--lead-in` | `0.8` | seconds kept before the first key |
| `--hold` | `3.0` | seconds the last frame is held before the loop restarts |
| `--colors` | `256` | palette size |
| `--title` | from `meta.json` | the title bar text |
| `--allow-problems` | off | render even when the check below finds a problem |
| `--ignore-sync` | off | sample mid-repaint, as a terminal without mode 2026 would; use it to see what the check catches |

Before it draws anything, the renderer checks every state the screen passed through in the shown span, not only the
sampled ones. It looks for escape debris, replacement characters, a console box with a missing or broken edge, and a
cursor off the screen. If any state fails, it prints the first ones and exits without rendering.

It prints a JSON summary: the file size, the frame count, the screen states checked, the time shown and the hold.

The GIF plays at real time and nothing in it is sped up. The only cuts are the dead time before the typist's first key
(everything but the lead-in) and everything after the session puts the terminal back on `/exit`. The still is the
screen just before `/exit` is typed.

To make the file smaller, in this order: `--scale 1`, a lower `--fps`, then fewer `--colors`. Do not trim the session
and do not speed it up. The length is part of what the picture shows.

## How it works

`record.sh` drives [`perf/drivers/pty_type.py`](../../../perf/drivers/pty_type.py). The driver reads the terminal
continuously, so the program never blocks on it, and records the arrival time of every chunk.

`render.py` replays those bytes through the terminal emulator in
[`scripts/demo/side-by-side/render.py`](../side-by-side/render.py). It adds three things an interactive session
needs:

* **The cursor.** The renderer tracks whether the cursor is shown, and its shape: a bar in the console, a block at the
  shell prompt.
* **Synchronized output (mode 2026).** A frame is only sampled between two complete repaints, as a terminal that
  supports the mode shows it. Ignoring it produces torn frames: half-erased consoles and doubled box edges.
* **Glyphs drawn cell by cell.** Text sits exactly on the grid. Braille (the mini donut), block elements (the wordmark)
  and light box drawing are drawn as shapes that fill the cell, as most terminal emulators draw them. Menlo has no
  braille, and a font's box glyphs leave gaps once the line is taller than the font.

Colours come from the capture. The background is `#1e1e1e`, the one the theme's contrasts are measured on. The
foreground is the theme's `code` colour. `dim` is drawn at the `DIM_OPACITY` read out of `scripts/gen-brand.mjs`, so
the picture and the README's generated wordmark agree.
