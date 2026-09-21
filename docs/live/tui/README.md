# Live interactive-TUI session (recorded with scripts/pty/drive.exp)

Steps: `live-session.steps` (chat mode, real Jev `typesafe/jev-1.13-20260917` and the generator through
OpenRouter, workspace `/tmp/jevcode-demo` = `examples/demo-py` with a git history, an untracked
`notes.txt` and a `.venv` holding pytest). Reviews are answered by the driver (`PTY_AUTO_REVIEW=y`: a one-second look, then `y`, then it waits for the
engine's `confirm <id> approved` line). Artefacts: `tui-pty.log` (raw pty capture),
`timing.jsonl`, and the run directories' `transcript.log` / `state.json` / `jevcode.log` copied
beside them. Nothing here contains a key (checked with the redactor's patterns after the run).
