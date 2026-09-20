# JevCode status (2026-09-19, living document; finalised at the end of the build)

## Built

- One package, strict TypeScript (7.0.2), ESM, Node 22.23.2, no `any`; runtime deps `ink` and
  `react` only. 55+ unit-test files, 728 offline tests, live suites for Jev and both
  generator providers.
- The full loop: intent Choice with paired Nouls → context Nouls over path-keyed candidates →
  one tool-call proposal → four risk Scores (max, expected-level or tail-mass bound) →
  sandboxed execution → judge Nouls with code-computed test counts → completion Noul;
  persistent plan with evidence, bounded window, loop detection (command+result, patch hash,
  failure, unresolved intent) → replan Choice; atomic checkpoints and `--resume`.
- Sandbox: detached process groups, three-pass tree kill, drain-to-tail output cap, scrubbed
  env, seatbelt profile on macOS (writes confined, harness secrets and other runs' checkpoints
  unreadable), `git apply` with escape checks, harness git with hooks/fsmonitor disabled.
- Ink TUI (transcript `<Static>`, live region, decisions pane with review/block highlighting,
  status line with cost split, inline confirmation) and a plain renderer that prints the same
  lines; `transcript.log` matches both line for line.
- Bench: 30-task SWE-bench Verified subset and 10 Terminal-Bench 4.0 tasks, Jev on vs off,
  mocked end to end, live behind `--live --spend-cap`, JSONL + summary + markdown comparison
  + official predictions files; local-venv SWE-bench evaluator and path-shim Terminal-Bench
  runner; Harbor installed-agent adapter (untested here).

## Verified live

- `test:live`: Jev (dated id served, formulas within 0.02, cost exact), OpenRouter Sonnet 5 tool
  call, Anthropic-direct tool call (using a session key, see DECISIONS.md).
- Demo runs in the TUI (`docs/live/`): complete fix with two approved reviews and a loop trip
  → replan (9 steps, $0.115); a blocked `rm -rf tests` (risk 0.92); a declined review and
  `replan_stop`; `--no-network` denial with a live command timeout.
- Perf: first frame cold p95 89.9 ms; harness overhead p95 31.2 ms; event-loop lag p95 3.2 ms;
  zero terminal clears.

## In progress / pending

- Live demos 3–5 (review on untracked file, loop scenario, Ctrl-C + resume).
- Live 3-task SWE-bench slice, then the full 30.
