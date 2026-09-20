# JevCode decisions log

Each entry: date, decision, why, what it affects. Newest at the bottom. Deviations from
the build prompt or from `~/Documents/jev-research/REPORT.md` are also listed in
`docs/DESIGN.md` under "Deviations".

## 2026-09-19 Repository lives at `vscode/JevCode` as its own git repo

The parent folder `vscode/` already had an empty `.git` with no commits. JevCode is
initialised as its own repository so the package has an independent history and can be
published or moved without the sibling checkouts (Open Assist, CoArena, ...). Nothing is
imported from Open Assist; the only relationship is the optional `<OPEN_ASSIST_PATH>/.env`
fallback in config precedence.

## 2026-09-19 Live generator runs go through OpenRouter, default stays Anthropic

`ANTHROPIC_API_KEY` is empty in both `JevCode/.env` and `open-assist/.env`;
`OPENROUTER_API_KEY` is set. The default config remains provider `anthropic`, model
`claude-sonnet-5` as the prompt requires. Every live run in this build passes
`--provider openrouter` (or `JEVCODE_PROVIDER=openrouter`) with an OpenRouter Claude
Sonnet model id, verified against `GET https://openrouter.ai/api/v1/models` during
research. The Anthropic provider is exercised offline with recorded SSE fixtures and is
skipped, with an explicit skip reason, in `test:live` when no key is present.

## 2026-09-19 No Docker on the dev machine: bench evaluation strategy

`docker` is not installed and cannot be installed without the user (no Homebrew, Docker
Desktop needs an interactive installer). Python is the system 3.9.6 with pip 21 and
`venv`; clang and git are present. Consequences:

- SWE-bench Verified: the official harness (Docker images per instance) cannot run here.
  The bench records predictions in the official `predictions.jsonl` shape so they can be
  evaluated with `swebench` / `sb-cli` elsewhere, and additionally runs a local evaluator
  that clones the repo at `base_commit`, builds a `venv` with the instance's install
  command, applies `test_patch`, and runs `FAIL_TO_PASS` plus `PASS_TO_PASS`. Each task
  record states which evaluator produced `pass` (`local-venv`, `docker`, or `none`).
- The 30-task subset is chosen from repos that install under Python 3.9 without native
  builds, with mixed `difficulty` labels and several repos. This is a selection
  constraint, not an agent heuristic; the agent loop has no benchmark-specific code.
- Terminal-Bench: tasks are Docker-first. JevCode ships a Harbor-compatible installed
  agent adapter for the official harness, and a local runner that executes a task's
  instruction in a sandboxed temp workspace and runs its `tests/` locally when the task
  needs only tools present on the machine. Records state `evaluator: local` and list
  tasks skipped as `unsupported-locally`.

## 2026-09-19 Paid runs are capped

Live bench and live tests run under an explicit `--spend-cap`. The 3-task slice runs
first; the full 30-task run only proceeds if the slice's numbers are sane, with its own
cap recorded in the summary JSON.
