# Live round-3 TUI session (TUI-DESIGN-3; recorded 2026-09-21 with scripts/pty/drive.exp, the committed round-3 bundle 0.4.0)

One drive of the real product — `node bin/jevcode.js --workspace <ws> --spend-cap 0.30` with **no command word**, the repository's `./.env`
(`TYPESAFE_API_KEY` + `OPENROUTER_API_KEY`; `ANTHROPIC_API_KEY`, `JEV_API_KEY`, `JEVCODE_MODE`, `JEVCODE_CONFIG`, `JEV_PROVIDER` unset), a temp
`JEVCODE_HOME`, a fresh copy of the demo template (`examples/demo-py` + git + `.venv` with pytest). Under the round-3 default the session
opens in **jev+llm** (`jev-on`: Jev via TypeSafe native, the code model `z-ai/glm-5.3-flash` via OpenRouter); the steps file
`live-round3-default.steps` types `hi`, `what can you do?`, `/jev`, `/mode jev-only` (pends), `/mode jev-on` (back to the default: the badge
loses ` · next run`), the real task `Fix the failing tests in tests/test_core.py without changing the tests.`, then `/jev`, `/cost`, `/exit`.
Every pause is a draining `sleep` (research 20 §5). The machine was shared with a peer session's live bench (load 10–40), which stretches
wall times, not correctness.

Reproduce: `sh docs/live/tui/round-3/run-live.sh <name> <rows> <cols> <steps> [typesafe|openrouter]` from the repository root after
`npm run build` (the template recipe is in `../round-2/run-live.sh`'s header). `summarize.py` writes one JSON line per drive to
`results.jsonl` (its row counters are gutter-aware from this round on); `render-readme.py` prints the table.

## Artefacts

`default-24x80.cap` (raw pty bytes) · `.jsonl` (timing) · `.txt` (SGR-stripped) · `.driver.out` · `default-24x80-runs/<run-id>/` (redacted
`transcript.log`, `state.json`, `run.json`, `jevcode.log`; 40 KB). Every artefact was searched for every `.env` value: **0 hits**.

## Measurements

| run | provider (served) | geometry | driver exit · timeouts | clears · restores | first frame | splash settled | `hi` → `[jevcode]` | facts reply | task → `[run] start` | run (steps · stop · Jev $ · generator calls) | `[step N]` rows · stage rows | key bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `default-24x80` | `auto` → typesafe (`jev-1.13.0`) | 24x80 | 0 · 0 | 0 · 1 | 301 ms | 560 ms (46 wordmark frames, 0 after the brand row) | **322 ms** | 195 ms | 288 ms | 105.9 s: 7 steps · `complete` · $0.016 · 8 generator calls | 0 · 0 | none |

Intake wall times (Enter → the first `[jevcode]` / `[run] start` frame): `hi` [322], facts [195], task [288] ms — max 322 ms, p95 322 ms over 3 intakes; gate p95 < 1500 ms (TUI-DESIGN-2 §9).

The summariser's `[step N]` / mode-item counters were gutter-blind on this capture (the table's `0 · 0`); counted from the stripped text:
**7 distinct `[step N]` rows, 2 `[ui] mode …` items, 0 stage rows** (compact view — none expected).

What the drive shows, against the design:

- **Hero and splash (§3):** first frame 301 ms on the loaded machine (99–172 ms in round 2), the mark's caption `◆ 0.4.0` at 560 ms, the
  resting mark held above the console with the `jev+llm` badge in the top edge, zero clears, no row wider than 80 cells.
- **Conversation (§1, TD2 §3):** `hi` → `[jevcode] Hi. I'm ready when you are — …` in **322 ms**; `what can you do?` → two facts in 195 ms;
  `/jev` → `typesafe · api.typesafe.ai · jev-1.13.0 (pinned)` / `questions 0 · …` / `intake: 2 messages · p50 133 ms · $0.0004` /
  `last: question about this tool (1.00)` — the two-row form of TUI-DESIGN-3 §10.
- **`/mode` (§1.2):** `/mode jev-only` pends (`mode jev-only from the next run — no generating LLM; …`, badge `jev-only · next run`);
  `/mode jev-on` returns to the default (`mode jev+llm from the next run — the code model writes the code, Jev still decides every step
  (persist: jevcode config set mode jev-on)`) and the badge reads plain `jev+llm` because the next run's mode equals the current one.
- **The jev+llm run:** `[run] start … mode=jev-on` 288 ms after Enter; **7 steps, `complete`**, pytest **7 passed / 0 failed** at step 7 —
  the demo's bugs fixed; 2,216 Jev questions ($0.0157, TypeSafe, table-priced), **8 generator calls** (28,030 in / 8,571 out, $0.0079 GLM 5.3
  Flash at the re-fetched rates), 105.9 s wall on the loaded machine; session meter `sess $…/1.50` (5 × the $0.30 run cap).
- **Exit:** `/exit` left 0; `restores=1`; the pink prompt, the labels' two pinks and the accent caption are in the capture's SGR bytes
  (`38;5;211`, `38;5;169`).

## Cost

One run: $0.016 Jev + $0.008 generator; three intakes ≈ $0.0006. Total ≈ $0.025.
