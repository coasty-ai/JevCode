# Changelog

All notable changes to `jevcode`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project uses semantic versioning. `package.json` is the single source of truth for the version and is bumped
by the release procedure in `docs/RELEASE.md` — the entries below describe the tree at 2026-09-21 (`package.json` reads 0.2.0; the
0.3.0 entry is the round-2 tree awaiting its bump); nothing has been pushed to the npm registry or the Homebrew tap.

## [0.3.0] — 2026-09-21 (not yet published)

Round 2 of the interactive TUI (`docs/TUI-DESIGN-2.md`, six concurrent slots; what landed and what was verified is
recorded in `docs/STATUS.md`, "Round 2"). Three faults, one rule: a bare `jevcode` asked for two keys, every Enter was
a paid run, and the screen was crowded — now the default mode needs one key, Jev classifies every submission before any
run starts, and the interactive surface is one rounded console, one line per step and a collapsed Jev panel.

### Added

- **Conversational intake** (`src/chat/**`, `src/cli/session.ts`; design §3). Every non-command submission passes one
  Jev request — an intake Choice over five readings (`greeting_or_smalltalk`, `question_about_this_tool`,
  `question_about_the_code`, `coding_task`, `ambiguous`) with paired Nouls, a reply Choice over a 14-row catalogue and
  14 harness-fact Nouls folded into the same request — and only `coding_task` at Jev's own p ≥ 0.6 (paired ≥ 0.5)
  starts a run. A greeting gets a catalogue reply (`[jevcode] Hi. I'm ready when you are — describe a change you want
  in <dir>, or ask what I can do.`), a question about the tool gets one `[jevcode]` item per selected fact (mode, keys,
  cost, last run, last tests, sandbox, undo, commands, provider, …), a question about the code gets a Jev-selected
  lookup of likely places in jev-only (or one generator turn in jev+llm, streamed into the live region), and a weak
  or ambiguous reading asks `run this as a task?` (`[y] run it   [n] just chatting   (Esc keeps the text; Enter does
  nothing)`) — never a silent run. The submission is a `[you] <text>` bubble first; both labels are transcript items
  (one per line) in the TUI, `--plain` and `--json` (`chat` lines with `intake`, `probability`, `route`, `provider`,
  `costUsd`, `latencyMs`, `requestHash`). Intake spend is charged to the session meter from the first message; the
  intake's Noul answers appear in the Jev panel as `s0` rows (`/panel` after a greeting: `s0 intent  about_<fact>
  noul …`; the design's pinned `s0 intake  intake  <kind>` Choice row and `/why intake` are not wired yet — `/why intake`
  answers `no decision intake in the last 3 steps`, `docs/STATUS.md` "Round 2", deviation 16). Ctrl-C ×1 while
  `⠹ thinking` aborts the request (toast `stopped thinking`, no bubble; the first frame after Enter — the bubble commit
  — still reads `starting`, deviation 4); a failure to reach Jev is a bubble, never a crash. No keyword classifier exists
  outside the mock decider (`JEVCODE_MOCK_INTAKE=<kind>` forces its answer, `JEVCODE_MOCK_JEV_MS=<ms>` delays it).
- **Two Jev providers** (`src/jev/providers.ts`, `src/config/**`; design §2). TypeSafe native
  (`https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0` — the only pinned id it serves besides `jev-latest`;
  ≈ 110 ms per request, no `usage.cost` on the wire, priced from the published $0.042/M input, output free, `costBasis:
  'table'`; `x-typesafe-request-id`) and OpenRouter (`typesafe/jev-1.13-20260917`, `usage.cost`). `--jev-provider
  auto|typesafe|openrouter`, `JEV_PROVIDER`, the config key `jevProvider`; `auto` is typesafe when `TYPESAFE_API_KEY`
  is set (a configured `JEV_API_KEY` keeps openrouter), else openrouter. Per-provider defaults for base URL and model,
  offline refusal of the other provider's model id or host, key order by provider source, `TYPESAFE_API_KEY` swept by
  the redactor whatever the provider, cross-provider `--resume` through the equivalent-id table. `jevcode config` gains
  `decider.provider` and `mode` rows; `/jev` prints the provider, host, model and the intake statistics; `jevcode
  login --jev-provider typesafe|openrouter` writes the provider next to the key. Both providers in `test:live`.
- **Mode as a setting and the badge** (design §1). `mode` resolves flag > `JEVCODE_MODE` > dotenv > file > default
  `jev-only`; `jevcode config set mode jev-on` persists it. `/mode [jev-only|jev-on|jev-off]` shows or sets the mode
  for the next run; `/llm on|off` is its alias; `/mode jev-on` without a generator key opens the wizard's provider and
  generator-key steps inside the console (`jev+llm needs a generator. Pick the provider:`) and Ctrl-C there keeps
  jev-only instead of exiting. The badge `jev-only` · `jev+llm` · `llm-only` (` · next run` while a switch is
  pending) is in every frame from the first — in the console's top edge (boxed tier) or leading the status left zone
  (flat tier).
- **The visual redesign** (`src/tui/**`; design §4). A boxed tier at ≥ 16 rows × ≥ 40 columns: the composer and the
  three-zone status bar share one rounded console (`╭─ jev-only ──── <dir> ─╮` · `│ › …│` · `├──┤` · status ·
  `╰──╯`; `+-|` under `--ascii`), every modal is a rounded card (review with the four gauges and preview, follow-up,
  undo, exit confirm, palette, blocking pane, the intake card), the wizard renders inside the console under
  `setup · <step>`. The flat tier (rows 8–15 or a screen reader) keeps round 1's rows. The prompt is `› `; the
  placeholders read `Say hi, ask a question, or describe a task…` before the first turn and `Follow-up, question, or
  /command…` after one (a command alone is not a turn). The transcript is a conversation: `[you]` / `[jevcode]`
  bubbles with a dim label and a hanging indent, one `[step N] <action> · risk <r> <verdict> · <outcome> · tests
  <p>p/<f>f/<e>e · judge <p> · <wall> · <cost>` line per step in the default `compact` view (`/transcript full` shows
  every stage line for new items; `--plain` and `transcript.log` are always the full form). The Jev panel is a
  one-row strip by default (`─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 ── [d] [p] [t] [s] ──`);
  `/panel [d|p|t|s|off|full]`, `Alt+J` / `Alt+Shift+J` / `Alt+D` `Alt+P` `Alt+T` `Alt+S` open it to 6 or 12 rows.
  Truecolor / 256-colour twins of every role with the ANSI-16 fallback and the textual markers kept.
- **Startup splash** (design §5). A ≤ 700 ms wordmark (seven 5-row block letters, `JEV` in the accent colour) whose
  frame 0 *is* the first frame — the `J` column, the sweep head and the complete console with `step 0/–` land
  together — ticking through Ink's `useAnimation` at 50 ms (≤ 15 frames), cancelled by the first key, a run start or
  any overlay, settling into the brand rule row `─── ◆ jevcode 0.2.0 ───`. `--no-animation` / `JEVCODE_REDUCED_MOTION`
  and a screen reader mount settled; `--plain` has no splash; below 64 columns only the brand row.
- **Probes, scenarios and docs for round 2** (this slot). `src/perf/intake-latency.ts` (Enter → `[you]` bubble frame
  and Enter → `[jevcode]` reply frame against the mock decider at 0 ms and delayed 150 ms; gates < 16 ms and ≤ 40 ms
  p95), a splash frame-count bucket per render-lag geometry (≤ `maxFps` + 1 frames in the first 700 ms) and a
  "splash frame 0 is the first frame" row in the first-frame probe (`JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` set for
  the launcher to honour); `test/pty/run-smoke.sh` grows from 19 to 34 scenarios (`chat-hi` with the Enter → reply wall
  time from the timing file, `chat-facts`, `chat-task` with the compact-transcript check, `chat-ambiguous(-y)`,
  `mode-switch(-keyed)`, `splash`, `splash-wide`, `splash-reduced`, `panel`, `chrome-tiers`, `zero-arg-chat`,
  `zero-arg-run`, `zero-arg-wizard`; the fix pass adds `chat-ambiguous-flat` at 12×60 and `splash-settle`, 36 in
  all, plus the `--hermetic` self-check) and runs every child from its workspace under an isolated `HOME`,
  `XDG_CONFIG_HOME` and `JEVCODE_HOME` with `JEVCODE_CONFIG` and every key variable unset (a developer's saved login
  in the legacy `~/.config/jevcode/config.json` can never reach a scenario — the same rule in `test/pty/helpers.ts`
  `childEnv` and `src/perf/pty.ts` `baseEnv`, proven by `test/unit/perf/hermetic.test.ts`); `test/pty/round2.pty.test.ts`
  adds 33 pty tests (4 of them `it.fails` records of defects against the design — the startup wizard's fix block and
  idle fall-through, `Alt+D`, `/why intake` — that flip when the owning slot fixes them; 63 pty tests in all with the 30
  round-1 ones); the first-frame probe gates "splash frame 0 is the first frame" and the splash bucket counts `dynamic`
  frames only (gate ⌈(maxFps + 1) × 0.7⌉ = 22) with the typist waiting 800 ms so the splash settles by itself;
  `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` is passed by the first-frame probe and a run printing `config before first
  frame` fails — inert until `bin/jevcode.js` implements the hook (a request to its owner, `docs/STATUS.md` "Round 2");
  `docs/TUI.md`, `README.md`, `docs/DESIGN.md` §10/§12, `docs/STATUS.md` ("Round 2") and `docs/DECISIONS.md` follow.

- **`llm-jev` mode surface** (peer design `docs/LLM-JEV-DESIGN.md`: the generator writes candidate patches inside the
  Jev-only Ledger+Sieve search, Jev localises, ranks and arbitrates, tests verify). This tree adds the additive contract
  (`EngineMode` member; optional `sample`/`samples` on the `generator:*` events) and the surface: `--mode llm-jev` /
  `JEVCODE_MODE` / the `mode` setting and `/mode llm-jev`, the `llm-jev` badge, both keys required (wizard, `jevcode
  login`, `missingSecrets`), the jev-on spend-cap default ($2.00), the session controller wiring both the real generator
  provider and the synthesizer into the engine, and a `sample k/N` counter on the live generator row when a step
  generates several candidates. The engine, loop and synthesizer behaviour behind the mode lands in the peer's tree.

### Changed

- The default engine mode is **`jev-only`** (was `jev-on`): a bare `jevcode` needs one key (the Jev key; the wizard asks
  for the Jev provider only when nothing infers it), the default run cap is $0.25 and the session cap $1.25; `--mode
  jev-on` (or `/mode jev-on`, or `jevcode config set mode jev-on`) restores Jev + LLM with the $2.00 / $10.00 caps.
  `--mode`'s help reorders the enum to `jev-only|jev-on|jev-off`. The scripted `--mock` trajectory is a generator
  trajectory, so every mocked run of the smoke, the pty suite and the perf probes now says `--mode jev-on` explicitly.
- Contract 1.2 (`src/core/types.ts`, additive, `CheckpointEnvelope.version` stays 1): `UiLabel` gains `[you]` /
  `[jevcode]`; `DeciderConfig` gains the required `provider`, `pricing`, `providerSource`; `Decider` gains the required
  `provider`; `JevUsage.cost` is optional; `AskResult.costBasis`; `EngineOptions.deciderModel.provider` (optional);
  `ResolvedConfig.mode`; `SessionHost.submit` returns `SubmitOutcome` and takes `kind: 'task'` for the one-shot path;
  `Renderer.restoreDraft?` / `live?`; `HistoryStore.append` accepts `'chat'`; `SessionRef.intake?`; `LaunchSettings`
  gains `modeHint` and `reducedMotion`; `step:end` carries `costUsd?`.
- Transcript identity is **narrowed by declaration** (design §9, §10.1): `--plain` and `transcript.log` stay byte-identical;
  the TUI's default `compact` view is a declared `TranscriptKind` subsequence of `transcript.log` (stage kinds and
  `run:ready` hidden), and its `full` view equals `formatTranscriptItem(item)` per item word-wrapped with a hanging
  indent, code fences drawn as `╶──── <lang>` rules. `test/pty/twins.pty.test.ts` asserts the subsequence rule instead
  of the round-1 line-for-line equality.
- The status left zone gains `⠹ thinking` · `⠹ looking` · `⠹ replying` · `asking` (`• thinking` under reduced motion);
  `⠹ thinking` and the `(thinking…)` placeholder show from the second frame after Enter (the bubble frame reads
  `starting`, `docs/STATUS.md` "Round 2", deviation 4); the git zone and the Jev sparkline appear from 104 terminal
  columns in the boxed tier (the status row runs at the console's inner width).
- Round-1 pty sentinels moved to the round-2 strings: `expect Describe the task` → `expect Say hi`, `expect Follow-up
  or /command` → `expect Follow-up, question`, the composer echo is matched glyph-agnostically (`› ` or `> `), and a run
  is live at its `[run] start` item (`[run] ready` is hidden by the compact transcript). `test/pty/run-smoke.sh` runs
  the child from the workspace (the repository's `./.env` is no longer visible to a smoke) with every key variable
  unset; the scenarios that need a key set a fake one under `JEVCODE_ASSERT_NO_NETWORK=1`.
- `src/perf/pty.ts` `composerRow` unwraps the boxed console row (`│ › … │`) so the keystroke → frame pairing works in
  both tiers; the perf `states` probe gains an `intake` card scenario at both geometries and expects the review, palette
  and setup cards in the boxed tier; the render-lag `resize-live` sentinel is the panel strip (`jev s<N> · <n>
  decisions`) instead of the pane header.

### Fixed

- **A keystroke's frame no longer waits for Ink's render throttle** (`src/tui/{useEngine.tsx,Transcript.tsx,App.tsx}`;
  TUI-DESIGN-2 decision D-F). Ink 7.1.1 renders a commit at most every 34 ms (`maxFps` 30, leading + trailing edge); a key
  typed inside the window opened by a spinner frame (8 fps while a run is live) or the 1 Hz clock frame was drawn at the
  trailing edge — every 5th key during a run, every 10th while idle or in the palette, p95 36–44 ms against the 16 ms
  gate. Round 1 never showed it because `<Transcript>` re-rendered `<Static>` on every commit, which took Ink's immediate
  path by accident; round 2's memoisation exposed the throttle. The App now counts key actions (`UiState.keySeq`) and the
  memoised `<Transcript>` hands `<Static>` a fresh `style` object per key, Ink's own escape hatch (`isStaticDirty →
  onImmediateRender`): key frames are written synchronously, spinner and clock commits stay throttled. Asserted against
  the real renderer in `test/unit/tui/key-immediate-render.test.tsx`; the measured composer series are in
  `docs/STATUS.md` ("Round 2", second integration pass).

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
