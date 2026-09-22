# Live captures — TUI round 4 (`docs/TUI-DESIGN-4.md` §9.3 W5, §13)

Paid, once. Nothing in `test/unit/**` or `test/pty/**` makes a network call: every hermetic scenario runs `--mock`
under `JEVCODE_ASSERT_NO_NETWORK=1`, and this directory is the only place a real request is recorded.

## The run

| | |
| --- | --- |
| taken | 2026-09-22, integration pass |
| command | `sh docs/live/tui/round-4/run-live.sh live-round4-default 24 80 docs/live/tui/round-4/live-round4-default.steps` |
| product | `node bin/jevcode.js --workspace <fresh demo-py copy> --spend-cap 0.30` — **no command word**, so the shipped default mode decides |
| decider | TypeSafe native (`JEV_PROVIDER=auto` → `typesafe` from `TYPESAFE_API_KEY`), model `jev-1.13.0` (pinned) |
| generator | OpenRouter (`OPENROUTER_API_KEY`); `ANTHROPIC_API_KEY`, `JEV_API_KEY`, `JEVCODE_MODE` and `JEVCODE_CONFIG` unset in the child |
| home | a fresh temp `JEVCODE_HOME`; the workspace a fresh copy of the demo template (git init, `.venv` with pytest) |
| reviews | answered by the driver (`PTY_AUTO_REVIEW=y`) |

## What it measured

| row | value | note |
| --- | --- | --- |
| driver exit · timeouts | **0 · 0** | every step matched |
| first frame | **110 ms** | splash frame 0 |
| composer ready | **199 ms** | raw mode, placeholder, session meter |
| splash settled | **554 ms** | 37 wordmark frames, the `◆ <version>` caption after 27 |
| `hi` → `[jevcode]` reply | **333 ms** | the §9 live gate is p95 < 1.5 s |
| task → `[run] started` | **244 ms** | |
| run | **33.7 s**, stop `replan_stop` at step 8 | 15 `[step N]` rows, 0 stage rows (the compact transcript) |
| mode | **`llm-jev`** | the shipped default; the badge draws `llm+jev · verified` |
| cost | generator **$0.0028** (9 460 in / 2 789 out, 7 calls) · jev **$0.0056** (133 970 in / 38 615 out, 31 calls) | 1 035 Jev questions; `--spend-cap 0.30` never approached |
| tests in the workspace | 12 passed / 3 failed / 0 errors at step 2 | the demo template's own suite |
| **clears after the first frame** | **0** | live, on a real terminal |
| **`ESC[3J`** | **0** | §1.4: the user's scrollback is untouched |
| **rows wider than 80 cells** | **0** of 1 465 | §11's frame rule, live |
| **key bytes in any artefact** | **0** | `key_leaks: {}` — the capture, the timing, `transcript.log`, `state.json`, `run.json`, `jevcode.log` and the session index are all checked for the two key values |
| restores | **1** | the exit string written once |

## Round-4 rows this capture pins, live

| § | row | as captured |
| --- | --- | --- |
| §3.6 G1 (D-V) | the run frame | `[run] started · llm+jev verified` / `[run] finished · replan_stop · 8 steps · 33s · $0.008 (generator $0.003 …)` |
| §3.1 (D-W) | `/jev` as a kv block | `[ui] jev` → `decider    typesafe · api.typesafe.ai · jev-1.13.0 (pinned)` · `latency    p50 — · p95 —` · `intake     1 message · p50 323 ms · $0.0002 · last greeting or …` |
| §3.1 (D-W) | `/cost` as a kv block | `[ui] cost` → `chat       $0.0004 · 2 messages · p50 201 ms` |
| §3.1 (D-W) | `/status` as a kv block | `[ui] status` |
| §1.2 P-H1 | the brand on the strip | `─── ◆ jevcode ─ ▸ jev s0 · 42 decisions ───────── [d] [p] [t] [s] ──` |
| §1.5 | the badge | `╭─ llm+jev · verified ──────── r4-impl ─╮` |

No review card appeared: the model's actions in this run were never scored into the 0.3–0.7 band, so
`auto_review.seen` is 0. The `--mock` drive (`docs/STATUS.md`, "Round 4", leg (E)) carries the §6 card with an
`edit` action instead.

## Files

| file | what it is |
| --- | --- |
| `live-round4-default.cap` | the raw pty capture (272 859 B) |
| `live-round4-default.txt` | the same with ANSI stripped, for `grep` |
| `live-round4-default.jsonl` | the driver's step timing |
| `live-round4-default.driver.out` | the driver's own stdout/stderr |
| `live-round4-default-runs/<run-id>/` | `transcript.log`, `state.json`, `run.json`, `jevcode.log` (`decisions.jsonl` is megabytes per run and is not kept) |
| `results.jsonl` | one JSON line per drive, appended by `summarize.py` |
| `run-live.sh` · `live-round4-default.steps` · `summarize.py` | how to take it again |

## How to take them again

```sh
npm run build
sh docs/live/tui/round-4/run-live.sh live-round4-default 24 80 docs/live/tui/round-4/live-round4-default.steps
```

The keys are read from the repository root's `./.env` into the child's **environment**; no secret file is ever
written next to the source. `JEVCODE_LIVE_ENV=<path>` points the script at a different one.
