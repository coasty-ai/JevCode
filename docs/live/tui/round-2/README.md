# Live round-2 TUI sessions (TUI-DESIGN-2 §8.3 S6; recorded 2026-09-21 with scripts/pty/drive.exp)

Four drives of the real product — `node bin/jevcode.js --workspace <ws>` with **no command word** — in a real pseudo-terminal
against live Jev, one per row below. Environment: the repository's `./.env` supplies `TYPESAFE_API_KEY` and
`OPENROUTER_API_KEY` (cwd = the repository root, so the dotenv layer of `resolveConfig` reads it); `ANTHROPIC_API_KEY`,
`JEV_API_KEY`, `JEVCODE_MODE`, `JEVCODE_CONFIG` unset in the child; `JEV_PROVIDER` unset (`auto`) or set per row; a fresh
temp `JEVCODE_HOME`; the workspace a fresh copy of the demo template (`examples/demo-py` + `git init` + an untracked
`notes.txt` + `.venv` with pytest, the README's recipe). Reviews would have been answered by the driver
(`PTY_AUTO_REVIEW=y`); none was asked. Bundle: `dist/jevcode.mjs` sha256 `e13a8087811dec33…` (the final integration bundle
`3c769e7d204bb002…` differs only in the `/why intake` forwarding and the failed-`/why` composer clear, which no step here touches).

Steps: `live-round2-typesafe.steps` (also the two `auto` rows — `auto` resolves to typesafe from `TYPESAFE_API_KEY`, §2.3
rule 2c) and `live-round2-openrouter.steps`. Each: first frame (`mark first-frame`, the `step 0/–` sentinel and raw mode),
the splash settling by itself into the brand row, `hi` (`mark hi-sent` → `expect \[jevcode\]` → `mark hi-reply`),
`what can you do?`, `/jev` (provider · host · model), `/mode jev-on`, `/mode jev-only`, the real task
`Fix the failing tests in tests/test_core.py without changing the tests.` (→ `[run] start`, `[step 1]`, `[run] end`),
`/jev` again (the served model), `/cost`, `/exit`. Every pause is a draining `sleep` (research 20 §5).

Reproduce: `sh docs/live/tui/round-2/run-live.sh <name> <rows> <cols> <steps> [typesafe|openrouter]` from the repository
root after building (`npm run build`) and creating the template (`/tmp/jevcode-r2-demo-template`, see `run-live.sh`'s header).
`summarize.py` writes one JSON line per drive to `results.jsonl`; `render-readme.py` prints the table below from it.

## Artefacts (per row: `<name>.cap` raw pty bytes · `<name>.jsonl` timing · `<name>.txt` SGR-stripped · `<name>.driver.out` · `<name>-runs/<run-id>/{transcript.log,state.json,run.json,jevcode.log}` + `index.jsonl`)

Every artefact was searched for every value of the repository `.env` after the run (`summarize.py`, counts only): **0 hits**
in all four rows. `decisions.jsonl` (2.3 MB per run) is not kept.

## Measurements

| run | provider (served) | geometry | driver exit · timeouts | clears · restores | first frame | splash settled | `hi` → `[jevcode]` | facts reply | task → `[run] start` | run (steps · stop · Jev $ · generator calls) | `[step N]` rows · stage rows | key bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `auto-24x80` | `auto` → typesafe (`jev-1.13.0`) | 24x80 | 0 · 0 | 0 · 1 | 146 ms | 703 ms (15 wordmark frames, 0 after the brand row) | **265 ms** | 127 ms | 180 ms | 14.7 s: 9 steps · `replan_stop` · $0.025 · 0 generator calls | 14 · 0 | none |
| `auto-40x120` | `auto` → typesafe (`jev-1.13.0`) | 40x120 | 0 · 0 | 0 · 1 | 105 ms | 706 ms (15 wordmark frames, 0 after the brand row) | **247 ms** | 156 ms | 216 ms | 9.9 s: 7 steps · `replan_stop` · $0.020 · 0 generator calls | 12 · 0 | none |
| `typesafe-24x80` | `typesafe` → typesafe (`jev-1.13.0`) | 24x80 | 0 · 0 | 0 · 1 | 99 ms | 706 ms (15 wordmark frames, 0 after the brand row) | **252 ms** | 139 ms | 198 ms | 10.5 s: 7 steps · `replan_stop` · $0.020 · 0 generator calls | 12 · 0 | none |
| `openrouter-24x80` | `openrouter` → openrouter (`typesafe/jev-1.13-20260917`) | 24x80 | 0 · 0 | 0 · 1 | 172 ms | 703 ms (15 wordmark frames, 0 after the brand row) | **255 ms** | 187 ms | 218 ms | 12.0 s: 7 steps · `replan_stop` · $0.020 · 0 generator calls | 12 · 0 | none |
| `final-typesafe-24x80` | `typesafe` → typesafe (`jev-1.13.0`) | 24x80 | 0 · 0 | 0 · 1 | 112 ms | 704 ms (15 wordmark frames, 0 after the brand row) | **240 ms** | 144 ms | 177 ms | 14.2 s: 9 steps · `replan_stop` · $0.025 · 0 generator calls | 14 · 0 | none |

Intake wall times (Enter → the first `[jevcode]` / `[run] start` frame): `hi` [240, 247, 252, 255, 265], facts [127, 139, 144, 156, 187], task [177, 180, 198, 216, 218] ms — max 265 ms, p95 265 ms over 15 intakes; gate p95 < 1500 ms (TUI-DESIGN-2 §9).

`final-typesafe-24x80` is the owner's drive of the **committed** bundle (1e264d5: after the D-F key-frame fix, the llm-jev surface
and the synthesizer-factory `mode` argument), run the same way from the same steps file; its run directory is 44 KB (redacted
`transcript.log`, `state.json`, `run.json`, `jevcode.log`).

Per-provider `/jev` (§2.6), before the run and after it:

- typesafe (three rows): `typesafe · api.typesafe.ai · jev-1.13.0 (pinned)` → after the run
  `typesafe · api.typesafe.ai · jev-1.13.0 (pinned) → resolved jev-1.13.0`; `questions 3266–4606 · latency p50 393–433 ms`;
  `intake: 2 messages · p50 118 / 148 / 133 ms · $0.0004 · last: question_about_this_tool 1.00`, then `3 messages … last: coding_task 1.00`.
- openrouter: `openrouter · openrouter.ai · typesafe/jev-1.13-20260917 (pinned)` → `… → resolved typesafe/jev-1.13-20260917`
  (the detail row wraps after `→ resolved ` at 80 columns; the id is on the continuation row); `questions 3266 · latency p50
  442 ms · p95 477 ms`; `intake: 2 messages · p50 178 ms`.

What the rows show, against the design:

- **Splash (§5):** the first frame is splash frame 0 with `step 0/–`, the console and the `jev-only` badge (first frame
  99–172 ms after spawn, composer + session meter by ~190 ms); no key was sent, and the wordmark settled into
  `─── ◆ jevcode 0.2.0 ───` at 703–706 ms after 15 wordmark frames, none at or after the brand row; at 40×120 the wordmark is
  centred at column 32 (⌊(120 − 56) / 2⌋). Zero clears after the first frame; the exit string once.
- **Intake (§3):** `hi` → one Jev request → `[jevcode] Hi. I'm ready when you are — describe a change you want in <dir>, or
  ask what I can do.` (catalogue `hello_first`), no run; Enter → bubble **247–265 ms** on both providers (gate 1.5 s).
  `what can you do?` → `question_about_this_tool` → two facts (`what_it_is`, `how_to_task`), 127–187 ms. The task →
  `coding_task` p 1.00 → `[run] start … mode=jev-only` 180–218 ms after Enter. Every intake was priced to the session meter
  (`chat $0.0005 for 3 messages` in `/cost`; `sess $0.02/1.25` on the status row).
- **`/mode jev-on` (§1.3):** with this `.env` a generator key resolves (`OPENROUTER_API_KEY` serves the default `openrouter`
  generator `z-ai/glm-5.3-flash`; `jevcode config` shows `generator.apiKey  <dotenv:…/.env>`), so **no wizard opened**: the
  item `mode jev+llm from the next run — Claude writes the code, Jev still decides every step (persist: jevcode config set mode
  jev-on)` and the console's top edge `╭─ jev+llm · next run ─…`; `/mode jev-only` then pended jev-only back (`╭─ jev-only`) so
  the run below is jev-only. The keyless branch (the wizard's generator step in place, Ctrl-C → `mode stays jev-only`) is the
  smoke's `mode-switch` scenario.
- **The jev-only run (§1.1, §4.5):** `state.json` `spend.generator = { calls: 0, costUsd: 0 }` in all four rows and
  `jevcode.log` records no generator request; 3266–4606 Jev questions, $0.020–0.025. The compact transcript shows `[run] start`,
  12–14 `[step N]` summary rows (`[step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok · tests …`,
  `[step 2] patch 9 line unified diff "apply best-guess fix …" · risk …`) and **0 stage rows**; `[run] end replan_stop steps=7–9`.
  The synthesizer did **not** repair the demo's bugs in any row: pytest ran once at step 1 (4 passed, 3 failed), the search
  parked every candidate ("every ranked candidate was already tried at 3 sites"), `done partial: fixed 0 of 1 failing tests`
  was blocked by `plan_mismatch` risk 0.94–1.00, the loop detector tripped and the run stopped `replan_stop` (exit 4 on the
  run; the session still exits 0). `src/synth/**` is read-only in this round (design §0), so this is recorded, not fixed.
- **Rows never wider than the terminal:** 0 rows wider than the geometry in all four captures (the Transcript width fix of
  this pass; the earlier tree wrapped `<Static>` bodies at the full width beside their labels).

## Cost

Four runs × $0.020–0.025 Jev = $0.086, plus 12 intakes at ≈ $0.00018 each = $0.002; generator $0.000.
