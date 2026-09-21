# Changelog

All notable changes to `jevcode`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project uses semantic versioning. `package.json` is the single source of truth for the version and is bumped
by the release procedure in `docs/RELEASE.md` — the entry below describes the tree at 2026-09-21 (`package.json` reads 0.2.0); nothing has been pushed to the npm
registry or the Homebrew tap.

## [0.2.0] — 2026-09-21 (not yet published)

The interactive TUI (`docs/TUI-DESIGN.md`, waves 0–4; commits `45efae5`, `a124445`, `814f9fb`, `cb33cca`,
`9002d37`, `9f96f70` and this documentation wave).

### Added

- **Interactive session.** A bare `jevcode` (or `jevcode chat`, or `jevcode run` with no task on a terminal) opens
  a session whose first frame is drawn from the command line alone; nothing runs until Enter. A readline-style
  multi-line composer (kill ring, 100-step undo, history in `~/.jevcode/history.jsonl`, Ctrl+R search, paste chips,
  `@` file mentions, external editor via Ctrl+G, keybindings file with chords), a command palette with 34 slash
  commands (`docs/COMMANDS.md`), a Jev pane with `[d]ecisions [p]lan [t]ime [s]ynth` tabs showing every answer's
  probability, derived-confidence and near-threshold markers and the code rule that consumed it, a three-zone
  status line with run and session meters, a git zone and a Jev latency sparkline, `/why` and `/calibration` blocks,
  and toasts. One modal slot above the composer holds at most one of: review box, key wizard, follow-up confirm,
  secret gate, blocking pane, palette, undo prompt, exit confirm. The dynamic region never exceeds `rows − 2` and
  the screen is never cleared after the first frame.
- **Keys.** One pure resolver over an enumerated state and a pure Ctrl-C / Esc / Ctrl-D reducer: Ctrl-C clears a
  draft or aborts a live run (twice while idle exits 0), Esc pauses at the step boundary and Esc Esc aborts,
  Ctrl-D twice exits (with a `[y] abort and exit  [n] stay` confirm while live). `docs/KEYS.md`.
- **Reviews.** `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline` with four risk
  gauges and `matches_intent`; the box appears after ~1 s of composer idleness and arms on the frame after it is
  drawn; the composer is inactive under it; the decline note reaches Jev and the generator
  (`Confirmer.confirmDetailed?`). Never offered: approve-always, an Enter default, a timeout approval,
  `--auto-decline`.
- **Sessions, follow-ups, steering, pause.** `sessionId` / `parentRunId` / `source` on `RunMeta`; a follow-up is a
  new run seeded from the parent's plan, window, created files and undo log (`src/session/seed.ts`); steering
  through `Engine.steer` / `unsteer` (≤ 8 directives, applied at the next step start as `human` harness problems
  and prompt hints, carried across pause and resume); `Engine.pause` → the `human_pause` stop reason (exit-4 family,
  resumable without `--force`); `~/.jevcode/sessions/index.jsonl` (`v:1`, append-only) with the picker, `-c` /
  `--continue`, `--resume <id|title>`, `--list-sessions`, `/new`, `/rename`, `/export`, and `jevcode sessions
  list|reindex|prune|unlock <id>`; `run.lock` against two processes resuming one run.
- **Money.** A session spend cap (`--session-spend-cap`, default 5 × the run cap) as the parent meter of every
  run (`SpendMeter.setCap`, `SpendSnapshot.parent`); 50 / 80 / 95 % `budget:warn` items and toasts; the follow-up
  confirm and refusal at the session cap; `/budget` and `/cost`; `budget:clamp` and `budget:override` events;
  unknown generator pricing fails closed unless `--allow-unpriced` runs under a token cap (`token_cap` stop reason,
  `--max-generator-tokens`).
- **Secrets at every entry point.** `detectSecrets` (six redacting formats, exact configured secrets, nine
  warn-only families) on every submission, steer, `/rename`, review note, command line and the argv / file / stdin
  task; the `Send anyway? y/N` gate; `addSecret` of every detected span before the engine sees the text and a
  count-only `secret-ack`; masked spans in the composer; `[REDACTED:draft]` in cleared drafts and `ui.json`; the
  `@` secret denylist with `--allow-secret-mention`; redacted `/copy`; key classes only in traces.
- **Onboarding and trust.** A ≤ 4-row masked key wizard writing `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`
  (0600), `jevcode login [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]`, `jevcode logout`,
  `jevcode config set` (secret settings refused), the shadowing notice, the workspace trust gate stored in
  `~/.jevcode/trust.json`, `AGENTS.md`/`CLAUDE.md` project instructions in the generator's system prompt only.
- **Git state, undo, rewind, diff.** Two unsandboxed probes at run start feed the seatbelt profile and the workspace
  (zero spawns afterwards); the `[run] git …` banner and a `HEAD`-following status zone; pre/post images per step
  (`pre/<step>/`, `post/<step>.json`, streamed hashing under a 16 MiB budget, `imagesMs` in the harness gate);
  `/undo [n]` with a verify-before-write decision table and `git restore --source=HEAD --worktree`; `/rewind [step]`
  with `StepRecord.planAfter`; `/diff`, `/diff <step>`, `/diff --full` in the pager.
- **Errors, retries, crash.** `retry` / `retry:settled` events with a 1 Hz row and `[r] retry now`
  (`Engine.retryNow`); blocking panes (rejected key → `/login`, provider spend limit, Jev unreachable with auto
  retry, checkpoint degraded, model drift, seatbelt unavailable) through `EngineOptions.blocker`; a `PaneBoundary`
  per pane; `fatalExit` with the terminal restored before anything is printed; the epilogue with `run` / `files` /
  `resume` / `report` rows; exit codes 130 / 143 / 129 for SIGINT / SIGTERM / SIGHUP; a per-run `jevcode.log` with
  levels and `--verbose`; `jevcode report <id>` support bundles.
- **Plain and JSON twins.** `--plain` on a terminal gets a `node:readline` composer over the same commands (Ctrl-C
  as SIGINT following the same matrix); `--json[=verbose]` is an NDJSON stream with a `stream:start` envelope
  (`jevcode.events/1`), controller lines (`session:start`, `session:end`, `session:budget`, `session:refused`, `ui`)
  and a documented redaction guarantee; `--screen-reader`, `--ascii`, `--no-animation`, `--theme`, `--fps`,
  `--render-mode`, `--notify`, `--osc52`, `--no-input`, `--trust-workspace`, `--exit-code`, `--keybindings`,
  `--log`, `--log-level`.
- **Packaging.** Zero runtime dependencies (`ink` and `react` inlined by esbuild with `minify` + `keepNames`),
  `"private"` removed, MIT `LICENSE`, a `files` allowlist, `THIRD_PARTY_LICENSES.txt`, `man/jevcode.1` and static
  `completions/jevcode.{bash,zsh,fish}` generated from the registries, `jevcode completion`, `jevcode upgrade
  [--check]`, an opt-in post-run update notifier, `--version --json`, a Homebrew tap formula, a trusted-publishing
  release workflow (`.github/workflows/release.yml`, Node 24 publish job), `npm run pack:check`.
- **Tests and tooling.** `scripts/pty/drive.exp` (a generic `expect(1)` pseudo-terminal driver with step files,
  timing JSONL, resize and signal steps, `PTY_AUTO_REVIEW`), `test/pty/run-smoke.sh` (19 scenarios over the built
  bundle, exit string counted), the `pty` vitest project (`npm run test:pty`: first frame, typing, steering, paste
  chips, the secret gate, NO_COLOR, tiny terminals, a resize storm, Ctrl-Z, the Ctrl-C/Esc/Ctrl-D matrix, reviews,
  `--plain`, `--json`, the three-way transcript identity), the perf probes `src/perf/{composer-latency,states,pty}.ts`,
  `scripts/gen-docs.mjs` (KEYS.md, COMMANDS.md, man page, completions, with a `--check` sync test), unit suites for
  every new module (264 files / 4,712 tests + 1 skipped at 08:36Z on 2026-09-21; the pty project's run results are in
  `docs/STATUS.md`).

### Changed

- `Engine` gains the required methods `steer`, `unsteer`, `pause`, `retryNow` and `annotate`, and `abort(reason,
  opts?)` widens to `'human_abort' | 'signal' | 'error'`; every other contract change is an optional field
  (`docs/TUI-DESIGN.md` §15; `CheckpointEnvelope.version` stays 1).
- Renderer-originated lines during a live run (`/plan`, `/why`, `/diff`, `/cost`, help, undo output, `/budget`
  changes) go through `Engine.annotate()` into `transcript.log`, so `transcript.log`, `--plain` and the TUI stay
  line-identical; `TranscriptItem.label` (`[ui]`, `[setup]`, `[config]`, `[sandbox]`) replaces the step label on them.
- Exit codes: a first-call 401/403 or Jev model drift is 2 (was 5); a run whose checkpoint degraded exits 3 even
  when `complete` (was 0); `/exit`, Ctrl-D ×2 and Ctrl-C ×2 while idle exit 0 (`--exit-code last-run` opt-in).
- `--resume` accepts a session title (exact, or a unique case-insensitive prefix) as well as a run id; `--resume`
  seeding folds the session index excluding the resumed run before adding its own spend.
- `jevcode config` gains `ui.*`, `log.*` and `session.*` rows with a source column, `derived` rows that print their
  derivation, and `ignored:launch` for a config-file value of a launch setting; `--config` defaults to
  `./jevcode.json`, else the XDG path, with the legacy `~/.config/jevcode/config.json` still read.
- The default run spend cap under `--mode jev-only` is $0.25 (session cap $1.25).
- `engines.node` is `>=22.12.0` (the `<27` upper bound is gone so the Homebrew `node` dependency can move).
- `README.md`, `docs/TUI.md`, `docs/DESIGN.md` §4/§9/§10/§11/§12, `docs/STATUS.md` and `docs/DECISIONS.md` describe
  the interactive TUI; `docs/research/tui/terminal-matrix.md` consolidates the terminal capability matrix.

### Fixed

- The terminal exit string (`RESTORE`, incl. `CSI 0 SP q`) was written twice on most exit paths; the fatal wiring and
  the controller now share the one process-wide `restoreTerminal()` and the 19 pty scenarios show it exactly once.
- Ctrl-C before Ink's raw mode was a default SIGINT death with no epilogue under load (research 20 §2): the
  SIGINT/SIGTERM handlers are installed before the first frame and exit 130/143 through the terminal restore and
  the one-line epilogue.
- `docs/DESIGN.md` carried a duplicated, stale copy of §1–§9 since commit `84a9612` (a `$\`` in the run-id regex
  expanded inside a `String.replace`); the stale copy is removed and the regex sentence restored.

### Removed

- `src/tui/Decisions.tsx` and `src/tui/Confirm.tsx` (replaced by `Pane.tsx` and `Overlay.tsx`); the private exit-code
  copy in `cli/main.tsx` (one `exitCodeFor` in `loop/stop.ts`).

## [0.1.0] — 2026-09-20

The first tree: the Jev-decides step loop, the generator providers, the sandbox, checkpoints and resume, the
run-mode monitor TUI, the bench (SWE-bench Verified 30, Terminal-Bench 10, QuixBugs 40, the ladder) and Jev-only
mode. Recorded in `docs/STATUS.md` and `docs/DECISIONS.md`; never published.
