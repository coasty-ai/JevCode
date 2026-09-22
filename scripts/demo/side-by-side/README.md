# Side-by-side recorder

Two scripts. `record.sh` runs JevCode once in a real pseudo-terminal and keeps everything the
terminal received. `render.py` replays two of those captures next to each other and writes an
animated GIF and a still poster.

The result that ships with the project is `docs/media/side-by-side.gif`; the method and the
numbers are in [`docs/media/side-by-side.md`](../../../docs/media/side-by-side.md).

## Requirements

* A built CLI: `npm run build` (the scripts use `bin/jevcode.js`).
* Python 3.9 or newer with [Pillow](https://pypi.org/project/pillow/) for the renderer.
* A `.env` holding `OPENROUTER_API_KEY` (and `TYPESAFE_API_KEY` for the default mode). Nothing
  reads a key from the command line and no key reaches the recording.
* A Python environment with `pytest`, so the tests in the task workspace can run inside the
  sandbox. The benchmark runner builds one at `~/.jevcode/runs/ladder-venv`; point `VENV` at
  any other one.
* macOS or Linux. The recorder uses `sysctl -n vm.loadavg`, which is macOS; on Linux read
  `/proc/loadavg` instead.

## Recording

```sh
scripts/demo/side-by-side/record.sh left  /tmp/side-by-side/left
scripts/demo/side-by-side/record.sh right /tmp/side-by-side/right
```

`left` is the default mode. `right` adds `--mode jev-off`. Run them one after the other, never
at the same time: two live runs competing for the same machine measure the machine, not the
modes.

Each run gets a fresh copy of the task workspace and an empty `HOME`, so no cache, session
store or history crosses between them. Anything after the output directory is passed straight
through to `jevcode run`.

| Variable | Default | Meaning |
|---|---|---|
| `ENV_FILE` | `<repo>/.env` | the file `node --env-file` reads the keys from |
| `TASK` | `detect_cycle` | a QuixBugs program in `bench/data/quixbugs` with a test module |
| `VENV` | `~/.jevcode/runs/ladder-venv` | a Python environment with pytest, copied in as `<workspace>/.venv` |
| `PTY_ROWS` / `PTY_COLS` | `30` / `100` | terminal geometry |
| `MAX_STEPS` / `MAX_WALL` / `SPEND_CAP` | `12` / `8m` / `0.06` | the run limits, identical for both arms |
| `TIMEOUT_MS` | `660000` | how long the recorder waits for the run to end |

The output directory ends up with:

```
capture.bin          every byte the terminal received
timing.jsonl         when each byte arrived, and the marks
meta.json            run id, stop reason, steps, wall time, cost, request counts, load average
oracle.json          the task's own test verdict after the run
run/                 the run's records: run.json, decisions.jsonl, jev.jsonl, generator.jsonl
<task>/              the workspace the run worked in, with its git history
home/                the empty home the run was given
```

`record.sh` waits while `/tmp/jevcode-perf-window-open` exists, so a shared machine can ask for
quiet. It exits without rendering if the capture contains anything key-shaped.

## Rendering

```sh
python3 scripts/demo/side-by-side/render.py <left-dir> <right-dir> \
  --out docs/media/side-by-side.gif --poster docs/media/side-by-side.png \
  --factor 6 --fps 10
```

| Option | Default | Meaning |
|---|---|---|
| `--factor` | `6` | real seconds per displayed second; one constant for both panes |
| `--fps` | `10` | frames per second in the GIF |
| `--colors` | `64` | palette size |
| `--font-size`, `--cell-width`, `--cell-height` | `10`, `6`, `13` | the character cell |
| `--hold` | `2.0` | seconds of still frame before the loop restarts |
| `--left-name`, `--right-name`, `--left-sub`, `--right-sub`, `--caption` | see `--help` | the labels |

It prints a JSON summary: file size, frame count, and each arm's run id, stop reason, steps,
wall time and cost. Use it to check the file against the size you were aiming for.

To make the file smaller, in this order: raise `--factor`, lower `--fps`, lower `--colors`,
then shrink the cell. Do not trim the slower run short — the length of the slow pane is the
point of the picture.

## How it works

`record.sh` drives `perf/drivers/pty_type.py`, a small driver that opens a pseudo-terminal,
runs the command inside it, and reads the master continuously — so the program never blocks on
the terminal — recording the arrival time and byte offset of every chunk. It waits for the
run's last line, then lets the session exit.

`render.py` replays those bytes through a terminal emulator it carries with it (`Screen`):
cursor moves, line and screen erases, scrolling, insert and delete, and SGR colour including
the 256-colour and 24-bit forms. A capture is a byte stream, not a list of pictures, so the
only way to know what the terminal showed at a given moment is to replay it. The emulator is
sampled at the times the animation needs, plus one extra sample per pane at the moment its run
finished — the session tears the terminal down about fifty milliseconds later, and that is the
frame each pane holds.

Colours come from the capture. Menlo is used when it is present, with the built-in bitmap font
as the fallback.

## Recording something else

Any QuixBugs program with a test module works:

```sh
TASK=bitcount scripts/demo/side-by-side/record.sh left /tmp/bitcount/left
```

Programs whose cases are stored as JSON rather than as a pytest module are rejected with a
message; `bench/data/quixbugs/index.json` says which is which (`hasJsonTests`).

For a different benchmark, or your own repository, build the workspace yourself and run
`pty_type.py` directly — `record.sh` is short and the middle of it is one `node bin/jevcode.js
run` command.
