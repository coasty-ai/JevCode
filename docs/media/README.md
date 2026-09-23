# docs/media

Pictures used by the README and the documentation pages, and the notes that say where each one
came from.

| File | What it is |
|---|---|
| `side-by-side.gif` | Two live runs of the same bug fix, one in each mode, replayed at one sixth of real speed |
| `side-by-side.png` | The final frame of that recording, as a still |
| `side-by-side.md` | How the recording was made, the exact commands, and the numbers behind it |

## Rules for anything added here

Every picture of the program is a recording of the program. No mock-ups, no retouched
terminals, no numbers typed in by hand. Each one gets a page next to it that names the task,
the model, the flags and the machine, and that page carries the numbers the run itself
recorded.

Recordings are made in a real pseudo-terminal from a fresh workspace and an empty home
directory, and the captured bytes are scanned for anything key-shaped before a single frame is
drawn. Raw captures are not committed: they contain a whole run directory, including its
transcript.

Keep committed images small. A GIF over about 10 MB stops rendering reliably on GitHub, so aim
well below that; reduce the frame rate, the width or the duration rather than the honesty of
the recording.

The tools live in `scripts/demo/side-by-side/`.
