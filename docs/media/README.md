# docs/media

Pictures used by the README and the documentation pages, and the notes that say where each one
came from.

| File | What it is |
|---|---|
| `demo.gif` | The README's demo: one live interactive session in `examples/demo-py`. `jevcode` is typed at a shell prompt, it answers `hi`, it is asked to `fix the failing tests` and does, and `/exit` ends it. Replayed at real time, on the default model |
| `demo.png` | The screen just before `/exit` in that recording, as a still |
| `demo.md` | How that recording was made: the task, model, flags, machine, which take it is, and the numbers the runs recorded |
| `side-by-side.gif` | Two live runs of the same bug fix, one in each mode, replayed at one sixth of real speed. History: it compares the `llm-jev` default of 2026-09-22 with `jev-off`, and left the README when the `agent` mode became the default on 2026-09-23 |
| `side-by-side.png` | The final frame of that recording, as a still |
| `side-by-side.md` | How the recording was made, the exact commands, and the numbers behind it |
| `wordmark-{dark,light}.svg` | The README's wordmark — **generated**, not drawn (see below) |
| `rule-{dark,light}.svg` | The README's section rule, in the same two pinks |
| `badge-*.svg` | The README's header badges |
| `swatch-*.svg` | The pills in the README's Colour table, one per hex the themes use |

## Rules for anything added here

Two kinds of file live here, and they are held to different rules.

**Generated brand assets** (`wordmark-*.svg`, `rule-*.svg`, `badge-*.svg`, `swatch-*.svg`) are not
pictures of the program running, so the recording rule below does not apply to them — but they may
not be drawn by hand either. They are emitted by `scripts/gen-brand.mjs`, which reads the five
wordmark rows, the `JEV`/`CODE` cell split, the caption grid and the tagline from
`src/tui/splash.ts`; every colour from `src/tui/theme.ts`; and the version, `engines.node`, licence
and dependency count from `package.json`. So a version bump or a palette change regenerates the
front page rather than rotting it, and nothing on that page needs a third-party image service to
render — it works in an editor preview, in a clone with no network, and on npmjs.com.

Two numbers in that script are rendering choices rather than readings, and they are named as such at
the top of it: the alpha standing in for a terminal's `dim` (reduced intensity has no hex), and the
badge geometry. Text colour on a filled pill is not a choice — it is whichever of the theme's near-black
or white scores higher WCAG contrast against that fill.

Regenerate with `npm run brand`; `npm run brand -- --check` exits 1 when a file is stale **or when a
generated file exists that the script no longer produces**, so a retired badge cannot linger.

**Recordings.** Every picture of the program is a recording of the program. No mock-ups, no retouched
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

The tools live in `scripts/demo/session/` (the demo) and `scripts/demo/side-by-side/`.
