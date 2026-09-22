# Round 5 — live captures (paid once, 2026-09-22)

Every artefact here was produced by the **built bundle** (`bin/jevcode.js` → `dist/jevcode.mjs`) against the real
Jev service, from the repository root's `./.env`, with `ANTHROPIC_API_KEY` and `JEV_API_KEY` unset in the child,
a fresh temp `JEVCODE_HOME` and a fresh copy of the demo template. `sh docs/live/tui/round-5/run-live.sh <name>
<rows> <cols> <steps>` is the driver; `summarize.py` writes the stripped text, the mark timings and one JSON row
into `results.jsonl`, and it **counts** key bytes rather than printing them.

| artefact | what it is |
| --- | --- |
| `live-round5-default.{cap,txt,jsonl,driver.out}` | the hero drive: `hi` → `/who` → `/context` → a real task → `/context` → `/jev` → `/exit`, 24×80, `--spend-cap 0.30`, the shipped `llm-jev` default |
| `live-round5-default-runs/` | the run's own `transcript.log`, `state.json`, `run.json`, `jevcode.log` and the session index, copied out of the temp home |
| `results.jsonl` | one JSON row per drive — timings, frame counts, spend, and `key_leaks` |
| `import-dry-run.txt` | `jevcode import --dry-run` against a **fixture** home (`~/.claude/CLAUDE.md`, `~/.claude/commands/review.md`, `~/.codex/config.json`) and a fixture workspace (`CLAUDE.md`, `.mcp.json`) — no network, no key |
| `models-search-glm.txt` | `jevcode models search glm --plain` — the bundled snapshot and the disk cache, **no network** |
| `live-round5-default.steps` · `run-live.sh` · `summarize.py` | the driver inputs, committed so the drive is repeatable |

## The hero drive — measured

| measurement | value |
| --- | --- |
| driver exit · timeouts | 124 · 1 — the **last** step (`/jev`'s `expect intake {2,}1 message`) did not match inside the window; every mark before it landed |
| marks reached | `first-frame` · `composer-ready` · `splash-settled` · `hi-sent` · `hi-reply` · **`who-idle`** · **`context-idle`** · `task-sent` · `run-started` · `run-ended` · **`context-after-run`** |
| first frame | **433 ms** (composer ready 805 ms, splash settled 570 ms) |
| `hi` → reply | **306 ms** — `[jevcode] Hi. I'm ready when you are — describe a change you want in …` |
| task → `[run] started` | **381 ms** |
| the run | **36.7 s**, 8 steps, `replan_stop`, pytest **12 passed / 3 failed** at step 2, decider `typesafe · api.typesafe.ai · jev-1.13.0 (pinned)` |
| **spend** | **$0.0062** — generator $0.00205 (7 calls, 8,812 in / 2,279 out) · jev $0.00414 (19 calls, 98,530 in / 38,216 out), **1,015 Jev questions** |
| clears after the first frame · `ESC[3J` | **0** · **0** |
| rows wider than the terminal | **0** |
| **key bytes in any artefact** | **0** (`"key_leaks": {}` — the capture, the timing file, the run directory and the session index are all scanned) |

## What the round-5 reads answered, live

```
[ui] who · unknown
     the session ledger is not open yet

[ui] context
     no run is live — /context reports the run's prompt budget
```

Both are the **honest empty state**, not a false zero and not a spinner: nothing constructs a
`SessionsCoordination` in production in this build (`docs/STATUS.md`, "Round 5"), and `/context` after a run has
*stopped* reports S54 because the run is no longer live. `/context` with a run **live** prints the whole block —
that is in the `--mock` drive under `.scratch/drive/` and quoted in `docs/STATUS.md`, because a live capture of
it would have cost a second paid run for a string the mock produces identically.

## The two CLI verbs

`jevcode models search glm --plain` → **16 rows** across OpenRouter, Fireworks and Google Gemini, the provenance
row `Anthropic bundled snapshot · OpenRouter bundled snapshot · +5 more`, exit 0, **no network**.

`jevcode import --dry-run` → `3 to import · 0 to review · 1 skipped · 565 B`, the five group rows with
`mcp  1  disabled on import`, and the pipe rule `not a terminal — dry run only; pass --yes to apply the
non-credential rows`, exit 0. The MCP server is discovered and recorded **disabled**, which is the rule.
