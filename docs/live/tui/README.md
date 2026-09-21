# Live interactive-TUI session (recorded with scripts/pty/drive.exp)

Steps: `live-session.steps` (chat mode, real Jev `typesafe/jev-1.13-20260917` and the generator through
OpenRouter, workspace `/tmp/jevcode-demo` = `examples/demo-py` with a git history, an untracked
`notes.txt` and a `.venv` holding pytest). Reviews are answered by the driver (`PTY_AUTO_REVIEW=y`: a one-second look, then `y`, then it waits for the
engine's `confirm <id> approved` line). Artefacts: `tui-pty.log` (raw pty capture),
`timing.jsonl`, and the run directories' `transcript.log` / `state.json` / `jevcode.log` copied
beside them. Nothing here contains a key (checked with the redactor's patterns after the run).

## Result (attempt 4, 2026-09-21 10:35 UTC)

Driver exit 0, 41.5 s, $0.099 across three engine runs: run 1 `replan_stop` at step 4 after a queued steer was
applied at step 2; a follow-up seeded from it; Esc paused it after step 1 (its step-1 review approved on the first
`y`); `/cost`, `/plan`, `/diff`, `/decisions`; `/continue` resumed it to `complete` at step 3; `/exit`. The run
directories' redacted `transcript.log`, `state.json` and `run.json` are under `runs/`. Attempts 1–3 (subdirectories)
document the driver defects found on the way (see `docs/STATUS.md`, "Live session").
