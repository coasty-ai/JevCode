# The TUI

A bare `jevcode` opens an interactive session in the terminal. It is one Ink render: a
transcript that scrolls in your terminal's own scrollback, a rounded console holding the
composer, a status bar, and a collapsible panel showing the decider's answers.

This page is about how it is built. For what to type, read [`../TUI.md`](../TUI.md); for the key
table and the command table, read [`../KEYS.md`](../KEYS.md) and
[`../COMMANDS.md`](../COMMANDS.md).

## The first frame comes from the command line alone

The ordering rule is the tightest constraint in the whole interface, and everything else follows
from it: **the first frame is committed from the arguments, the environment, whether stdout is a
terminal, and the working directory — and from nothing else.**

Configuration resolution, the task file, standard input, the runs directory and git are all
touched only after the first frame has resolved. Mount-time options come from a launch resolver
that reads flags and the environment but never a file. Signal handlers are installed before the
first frame, so an interrupt during startup still restores the terminal and prints a one-line
epilogue.

Heavy modules — the providers, the decider client, Ink itself, the benchmark harness — are
loaded dynamically. `--help`, `--version` and shell completion answer before Ink is imported at
all.

The consequence you can see: the header, the rule, the first frame of the startup animation and
the console appear before any key is checked or any file is read.

<!-- src/cli/main.tsx:3-13 the ordering contract; :204-209 firstFrameTask -->

## One render, one input handler

There is exactly one `useInput` in the application, and one paste handler beside it. Keys are
not routed by which component registered a handler first; they go through a single resolver and
a single interrupt reducer. That is what makes the key table testable as a table, and what makes
a chord such as a double escape behave the same wherever you are.

Two consequences are worth stating:

- Nothing clears the screen after the first frame. The transcript *is* your terminal's
  scrollback. Redrawing is limited to a dynamic region, and clearing the screen with the usual
  chord erases lines and repaints rather than wiping scrollback.
- Every pane is wrapped in a boundary, and every pure line builder runs under a guard, so a
  throw degrades one pane rather than the frame.

<!-- src/tui/App.tsx:1-18 the docblock; :2104 the single useInput -->

## The pane budget

The dynamic region never exceeds the terminal height minus two rows. A pure allocator hands out
those rows; it does no input or output, reads no clock and knows nothing about Ink.

Vertical order, top to bottom: scrollback, rule, live rows, banner, pane, queue, overlay,
preview, then the console (top edge, secret gate, composer, divider, status, bottom edge). In
the flat tier the console collapses to composer and status.

Allocation order *is* the priority: status, rule, the composer's floor, console chrome,
overlay, composer growth, queue, preview, live, banner, pane. When the terminal is too short,
rows are given back in the reverse order — pane first, then banner, live, preview, queue,
composer growth, overlay, and finally the composer down to one row. Chrome, the rule and the
status row never yield.

Each slot has a maximum it may ever take:

| Slot | Cap (rows) |
| --- | --- |
| live | 2 |
| queue | 2 |
| pane | 12 |
| the open decider panel | 6 |
| review card | 9 |
| preview | 8 |
| palette | 8 |
| blocking prompt | 4 |
| composer | 6, or 8 when tall |
| console chrome | 3 |
| the wordmark splash | 5 |

Three thresholds change the shape of the frame: below 16 rows the boxed console and cards give
way to flat rows; below 40 columns or 8 rows the panes are hidden entirely and only the
transcript, composer and status line remain; the five-row wordmark needs 64 columns.

<!-- src/tui/layout.ts:1-52, :69-73 -->

## The status line

One row, three zones, drawn by a pure function that the Ink row, its fallback, the plain
renderer, the screen-reader output and the frame tests all call.

- **Left**: the mode badge and either the idle word or the mini indicator with the current
  status word, then badges for unacknowledged warnings, a weakened sandbox and a disabled
  network. The mini indicator is a small braille animation in the glyph slot — a donut while
  the model thinks, a globe while it reads, a cube while it edits or runs a command, a wave
  while the tests run — three cells wide when the row has room and one otherwise, stepped by the
  spinner's own tick, still over SSH and under reduced motion, and absent at idle. In agent mode
  the status words are `thinking`, `reading`, `editing`, `running` and `testing`.
- **Centre**: the session title, and only when at least 24 cells stay free. Never the run id.
- **Right**, right-aligned: step and wall time, the run meter, the session meter, tokens, the
  git zone, the decider latency sparkline (not drawn in agent mode), and a short help cell.

When the row is too narrow, things are dropped in a fixed order: short help, sparkline, git
zone, session meter, wall time, centre. Cell widths are measured with the same width function
the composer uses, so every rendering target draws the same picture. Colour goes to the left
word and the meter words only, never to the whole row, and every coloured element keeps a
textual marker so the row reads the same without colour.

<!-- src/tui/status/lines.ts:1-22 -->

## The streaming reply (agent mode)

In the default mode the model's prose streams in place above the console's rule as `[jevcode]`
rows from the first token: a line with no newline yet is drawn as text, and a completed line
moves into the scrollback without the frame jumping, because the live rows and the committed rows
are built by the same function. Below it, the live region shows the command running now with the
tail of its output, the reads in flight, or the tool call being written. Each step leaves one tool
row (`Read …`, `Edit … (+2 −2)`, `Bash … · 7 passed`). A reply that never called a tool keeps the
chat's look throughout: no run header, no step rows, no stop line. The as-built contract is
`docs/TUI-DESIGN.md` §7.8; the loop behind it is [The agent loop](agent-loop.md).

## The decider panel

Under the transcript sits a one-row strip that opens to at most six rows, or to twelve in its
full form. In agent mode the strip reads `▸ s<N> · plan d/t · <k> tool calls`, and a run that
asked Jev nothing says so on the decisions tab. In the Jev-driven modes it shows the decider's
answers rather than a log, across four tabs:

- **decisions** — one row per answer: step, stage, question id, label, a probability bar,
  the probability, the confidence, and the verdict. A marker distinguishes a derived confidence
  from a reported one, and another flags an answer within a hair of the threshold that consumed
  it.
- **plan** — the ledger of done, unverified, remaining and blocked items.
- **timeline** — per-step stage timings and a proportional strip, with the total and the
  harness overhead.
- **synth** — in the decider-only mode, the synthesiser's phase and detail line.

The open panel is the first thing to yield when the terminal is short.

<!-- docs/TUI.md "The transcript, the Jev panel…"; src/tui/layout.ts:24-25 the panel cap -->

## Two renderers, one component tree

`classic` is the default. The transcript is printed into the terminal's scrollback and the
dynamic region is repainted below it.

`fullscreen` is opt-in. It pins the header on the alternate screen and gives the transcript a
scrollable viewport of its own. Ink fixes the alternate-screen decision in its constructor, so
this cannot be toggled in place: it is a **launch** setting, resolved before the first render
from flag, then environment variable, then configuration file, then the default.

The selection is a pure function of geometry, the screen-reader setting and the terminal type,
returning one of two renderers and at most one refusal note. Non-interactive cases — no
terminal, continuous integration, plain output, machine-readable output — are refused silently,
because there is no interface to refuse in.

When the fullscreen renderer exits it writes the transcript to the primary screen by default, so
you do not lose it to the alternate screen buffer.

<!-- src/tui/fullscreen/select.ts:1-37; src/config/defaults.ts the ui.renderer and ui.fullscreenDump rows -->

## Four render targets, one line builder

The same run can be watched four ways, and the rule is that no second string exists anywhere.

| Target | How to get it | What it is |
| --- | --- | --- |
| Ink | the default in a terminal | the interactive session |
| plain | `--plain`, or no terminal | the same items, printed line by line |
| machine-readable | `--json` | one JSON object per line on standard output |
| screen reader | `--screen-reader`, or the matching environment variable | the same items with the decorative glyphs replaced and the animations off |

The plain renderer and the engine's transcript file share one item model, so the transcript
file, the plain output and the interactive transcript stay line-for-line identical for the whole
of a run. That module deliberately imports no Ink, so the engine can use the formatter without
pulling the interface layer in.

The machine-readable stream has its own contract. The first line is an envelope carrying a
version and a schema name; every later line is one redacted engine event plus the run and
session ids. Consumers must ignore unknown event types; the version increments only on an
incompatible change, and additive fields never bump it. The stream never contains keystrokes,
composer drafts, pasted payloads or key material.

<!-- src/tui/plain.ts:1-8; src/cli/json-stream.ts:1-21 -->

## Accessibility and terminal hygiene

Screen-reader mode is a launch setting, and it turns off the spinner animation by default,
switches the review flow to answering by typed line, and drops to the flat tier. An ASCII glyph
table is selected automatically for a dumb terminal, a Linux console or a non-UTF-8 locale, and
can be forced.

Colour is chosen from the terminal's own advertised capabilities and never by querying the
terminal. A terminal that announces a light background gets the light theme unless you say
otherwise. The standard no-colour environment variable is honoured. Frames per second default
to 30, or 15 over a remote shell, clamped between 5 and 30.

<!-- src/config/defaults.ts:23-28 the frame-rate constants and the ui.* rows -->

## Where the numbers on this page come from

The row caps, the thresholds and the frame-rate bounds are constants in the source, cited above.
The startup timings quoted in the repository's own status notes were measured with the built-in
performance probes; this page quotes none of them, because a frame time depends entirely on the
machine that drew it. Run `jevcode perf` to measure your own.

## Related pages

- [`../TUI.md`](../TUI.md) — the user guide.
- [`../KEYS.md`](../KEYS.md) and [`../COMMANDS.md`](../COMMANDS.md) — the generated tables.
- [Configuration](../operations/configuration.md) — launch settings and why a file cannot change one.
- [Every JEVCODE_* switch](../operations/environment.md) — the rendering variables.
- [`../TUI-DESIGN-5.md`](../TUI-DESIGN-5.md) §2 the coordination surface, §3 the context meter,
  §4 the agent tree.
