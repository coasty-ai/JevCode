# Changelog

All notable changes to `jevcode`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project uses semantic versioning. `package.json` is the single source of truth for the version and is bumped
by the release procedure in `docs/RELEASE.md` — the entries below describe the tree at 2026-09-22 (`package.json` reads 0.6.0); nothing has been pushed to the npm registry or the Homebrew tap.

## [0.6.0] — 2026-09-22 (not yet published)

Round 5 of the interactive TUI (`docs/TUI-DESIGN-5.md`, six concurrent slots and one integration pass; the record
of what landed, with every gate number and every honest gap, is `docs/STATUS.md`, "Round 5"). Five user
requirements: every session knows what the others are doing and never blocks one; the context is relaxed and its
usage is visible; work can be delegated and watched; your memory and workflows come over from the other agents;
every provider key is selectable with search.

### Changed — the conversation, the default autonomy and the first frame (2026-09-22, after the round-5 merge)

- **Chat is a conversation.** Every message you type gets a streamed reply from the code model in a warm, concise
  voice that knows what it is (JevCode, built by coasty-ai; Jev decides, the code model writes), what it can do,
  which workspace it is in (name, branch, dirty count) and which sessions came before. `hi` is answered by the
  model, not a catalogue string; `who made you?` is answered. Jev's `intake` reading still runs — concurrently,
  in the background — and only decides whether a run ALSO starts: a clear coding task ends the reply with
  `On it — starting the run.` and the run starts; an ambiguous message ends it with `Say \`do it\` and I'll
  make that a task.` and the next `do it` / `go ahead` / `yes` starts it. The intake card
  (`run this as a task? [y] run it [n] just chatting`) and the `(waiting for y/n)` composer state are gone;
  nothing ever blocks the composer. `jev-only` keeps Jev's own answers (catalogue · facts · lookup) plus the offer.
- **Autonomy `full` by default.** New setting `autonomy` (`--autonomy full|review`, `JEVCODE_AUTONOMY`,
  file key `autonomy`; default `full`). Under `full` a `review` risk verdict is approved at once and the
  session notes `[review] auto-approved (autonomy full): <action> — <reason>` — it shows what ran and never
  waits; `--autonomy review` keeps the y/n card; a `block` verdict still stops; `--no-input` is unchanged.
- **The session opens with the wordmark and the composer.** The interactive first frame no longer prints the
  `[run] jevcode session · … | step 0/– starting` header, the `[sandbox]` item, the `[ui] recent:` hint or the
  one-time `[setup] mode …` disclosure; all four stay in `--plain` and `--json`, the sandbox facts stay on
  `/status`, `/config` and `jevcode doctor`, and the most recent session becomes the composer placeholder
  (`Say hi · /resume continues "<title>"`).
- **Every provider validates.** `generator.provider` accepts `anthropic|openrouter|openai|gemini|xai|fireworks|meta`
  (it refused all but the first two); `jevcode login --provider gemini` persists.

### Added — coordination: `/who`, the messaging verbs, and the write half

- **`/who`** (`--all`) — one row per `jevcode` session on this repo: liveness, `branch@head`, `step/max` and
  stage, mode, context percentage, spend, the files being edited, sub-work and beat age. The row is built **once**
  (`whoRowText` in `src/session/peers.ts`), so the Ink row, the `--plain` row and the `transcript.log` row are the
  same string at every width — `test/unit/tui/r5-identity.test.ts` asserts the identity at 40, 80 and 120. Nine
  cells drop right to left as the terminal narrows; the 40-column form keeps
  `● mbp  step 7/40 propose  beat 2 s`. `jevcode sessions who [--all] [--json]` is the machine twin, and `--plain`
  with no TTY renders the 120-column form.
- **`/peers`** wired to the fold: `peers · 2 here, 1 stale`, the oldest start, whether one holds an exclusive
  lease, and a pointer at `/who`. Round 4's three superseded per-peer kv rows are gone (one of them was always
  the literal `.`).
- **`/tell <target> <text>`, `/headsup <text>`, `/request <target> pause|end|steer [<text>]`, `/inbox`** — the
  messaging verbs, with one target grammar (`resolveTarget`) shared by every verb: a session id, an id fragment
  of at least 8 characters, an exact or unique-prefix title, `device:<label[#id4]|id8>`, `@all`, or a bare device
  label. A body that looks like a key is held behind `that message looks like it contains a key — [y] send
  anyway  [n] edit  [Esc] cancel` **before** the write, because the composer's own gate never sees slash-command
  arguments.
- **`/pause [now] [<target>]` and `/end [now] [<target>]`** — both take a target, so they reach another session.
  Both are `availableDuringTask: 'any'` (a targeted verb touches no local engine) with their own per-form
  refusals; `/end` is destructive and takes the confirm row whose Enter is inert.
- **The status zone** `⇄ 2 live · 1 heads-up · ✉ 1` from 80 columns (the heads-up clause from 100), never written
  to `transcript.log`.
- **The write half** (`src/session/publish.ts`): after the first frame a run opens the ledger, mints its claim,
  starts the heartbeat writer and publishes its repo identity — all three after `renderer.firstFrame()`, so the
  first-frame gate is untouched. `stop()` during an in-flight mint closes without beating; the projection epoch
  and the beat epoch are one object; the repo key is probed once per workspace behind a dynamic import and
  cached in `coordination/repokeys/`.
- **The session index** gains seven kinds in one commit (`session:end`, `relocate`, `handoff`, `agent:start`,
  `agent:end`, `land`, `import`), `pause.by` and `run:start.parentSessionId` — both **optional**, with stated
  reader defaults, so every line already on disk still folds.
- **`jevcode sessions <verb>`** — the verb surface parses: seventeen verbs, the words after the verb reaching the
  command verbatim, plus `--all`, `--device <label>` and `--rotate`. **The thirteen new verbs answer
  `the session ledger is not available in this build` and exit 2** — see "Known gaps".
- **`jevcode sessions unlock`** now answers with all six reasons (`no-lock`, `dead-pid`, `other-boot`,
  `peer-live`, `boot-unknown`, `held`); the run lock records the boot it was taken in, so a live pid from another
  boot is replaceable rather than a stand-off.

### Added — the context meter and compaction

- **`/context`** — one block from three reads that already existed: the prompt budget against the model's window
  with the estimated cost per step, the recent-step split, prompt-build and file-refresh milliseconds, the rolling
  summary and its age, output pointers on disk and evicted, and the files in view **with why each is there**.
  Three distinct empty states, not one. No `--json` of its own (deliberate: there is no `jevcode context` verb,
  and `--json=verbose`'s `status` event already carries the object).
- **`/compact`** — `live`-only, and the opposite of Codex CLI's idle-only gate for a stated reason. It says
  nothing when the fold happened (the engine's own notice already reported it in all three sinks) and otherwise
  picks among `compaction is off for this run (context.compaction) — …`, `nothing to compact — only the newest
  step is in history`, and `the run is no longer live — /compact needs a live run`. The `off` branch is checked
  **first**, because `Engine.compact()` returns immediately with `compaction: 'off'` and the two-row answer would
  otherwise be a falsehood over forty foldable steps.
- **The `ctx` status cell**, two width rungs (`ctx 41%` from 80, `ctx 41% · 6 files · 12 steps` from 100), with
  the amber and red word replacing the percentage and `/compact now` named as the action. Below 80 columns the
  cell is absent — never a placeholder, never `ctx —%`.
- **`context.kept`** joins the `context.*` rows (printed, validated, persisted). The engine member it feeds does
  not exist yet and the row's own description says so.

### Added — the agent tree, import and the model picker

- **The `'a'` pane tab** and its eight keys (`Enter` attach · `p` pause · `t` steer · `+` budget · `d` diff ·
  `k` kick · `x x` drop · `l` land), a `KeyContext 'agents'` rung between Picker and Composer, `Alt+A` to focus
  (refused on a non-empty draft, with a reason), a viewport that scrolls above 12 rows and never filters, and a
  collapsed `agents 5 · 2 running` status strip. All of it is **invisible with nothing delegating**, which is the
  production state in this release.
- **`jevcode agents list [--json]`** reads a run's manifest and prints one `planned` row per agent — the same
  `agentRows` the tab draws.
- **`jevcode import [<source>] [--dry-run | --yes] [--scope user|project|both] [--resume <id>] [--undo <id>]`** —
  memory, rules, slash commands and MCP servers from eleven tools, planned, reported and applied only where you
  accept. An MCP server is always imported **disabled**; a credential row always needs a terminal and is never
  applied by `--yes`. `docs/IMPORT.md` is the guide.
- **`jevcode models [list | search <query> | refresh] [--provider <id>] [--json | --plain]`** — the catalogue.
  `list` and `search` read the disk cache and the bundled snapshot with zero network; `refresh` is the only verb
  that fetches. The `--plain` twin numbers 40 of N with a `more` token and a one-turn `pick 1-40, or type a
  query > ` prompt.
- **Seven providers everywhere** (`anthropic`, `openrouter`, `openai`, `gemini`, `xai`, `fireworks`, `meta`):
  `/provider`'s palette values, `jevcode login --provider`, the argv validator and `GeneratorConfig.provider` all
  read one table. `src/config/provider-tables.ts` is a new zero-import module, so widening the list never puts
  `provider/openrouter.js` on the argv path.

### Added — configuration

- **46 new settings rows**, every one printed by `jevcode config`, validated by `jevcode config set` and
  reachable from a config file: six `coordination.*` (`claims`, `remoteControl`, `sync`, `syncRuns`, `notify`,
  `maxChildren`), **34 `orchestrate.*`** in `docs/ORCHESTRATION-DESIGN.md` §6.4's own order, five
  `import.*`/`memory.*` and the hidden bookkeeping row `seen.import`. A new gate asserts that every key of OR's
  table has a `SETTINGS` row, that no two rows share a name, an env variable or a file key, and that every
  `orchestrate.*` env name is `JEVCODE_ORCHESTRATE_<SCREAMING_SNAKE>`.
- **New flags**: `--force-takeback`, `--parent-session`, `--device`, `--rotate`, `--all` on `sessions`;
  `--split`, `--max-agents`, `--yes-split`, `--no-wait`, `--parent`, `--agent`, `--manifest`, `--own`, `--base`;
  `--dry-run`, `--yes`, `--scope`, `--undo`, `--no-memory`, `--no-import`. `--force-takeback` is its **own** flag:
  an ordinary `--resume --force` no longer bumps the claim epoch.

### Changed

- The command registry is **56 rows** (was 47): every round-5 surface is registered from day one with its real
  grammar and answers out loud when its store does not exist (`<verb> is not available in this build`). One
  consequence, accepted and recorded: `/help` now sits at the last two rungs of its compaction ladder at every
  width, so the key table is one `… /help keys prints the key table` pointer and the four per-terminal notes are
  dropped. `/help keys` still prints the table.
- `Command` is 16 members: `import`, `models` and `agents` join, each with its own `src/cli/<verb>.ts` and its own
  `await import()` arm in `src/cli/main.tsx` — the static import list gains nothing.
- `UiLabel` gains `'[session]'`; `SessionRow` gains three optional members; `BlockingKind` carries
  `lease-conflict` and `land-preflight`; contract 1.8 records all of it, additively, with
  `CheckpointEnvelope.version` unchanged at 1.
- `jevcode import`'s source is a **positional**, not `--source <id>`: `--source` is already a hidden flag whose
  values are `cli|perf`, and one name cannot mean two things.

### Closed after the integration pass (the gap-closure and lean finishing passes, 2026-09-22)

- **The session ledger is live in production.** `openCoordination()` (one function, the shape of `openSessionLedger`) opens the
  ledger after the first frame, reads `ledger.fold` on mount and after every own write, and closes it on exit; the thirteen
  `jevcode sessions <verb>` verbs, `/who`, `/peers`, the `peers` status zone and the chat `peers` fact all read the same
  fold through one handle. A ledger that cannot open degrades to the `unknown` answers; it never takes the session down.
- **The model picker, the `/import` overlay and the resume card's sub-state are mounted** in the shell: `/model` opens the
  pane-slot picker (Enter sets the model for the next run only), `/import` opens the overlay (`y` applies exactly the
  applicable rows and never a secret row), and the card keys route only while the card is open. `--plain` sessions print the
  numbered one-shot rows for both.
- **`jevcode doctor [--json]`** — seventeen pass/warn/fail rows with a one-line fix each: Node ≥ 22.12, a key row per provider
  (fingerprint form only, never bytes), free reachability probes (openrouter.ai/api/v1/key, api.anthropic.com/v1/models, the
  TypeSafe health endpoint — no priced call), sandbox-exec availability, config file `0600` in a `0700` directory, runs dir
  writable, terminal capabilities, version. Exit 0 unless a row fails; a key-less machine is all warnings, each naming its variable.
- **`--extra-env-file <path>` / `JEVCODE_EXTRA_ENV_FILE` / `extraEnvFile`** — an additional `.env` file whose keys are read as a
  fallback. Replaces an internally named setting that never shipped publicly; the value is a file, and with the row unset no
  second dotenv is read.
- **`JEVCODE_JEV` is a bench/perf switch only.** Any product command started with it set refuses before any network with
  `JEVCODE_JEV is set ("…") — it is a bench/perf fault switch, not a product setting; unset it, or run the bench and perf suites
  through npm run bench / npm run perf, which set it themselves` (exit 2); `bench` and `perf` are exempt.
- **`context:warn` renders** — `ctx 87% amber · /compact now` (red past the second threshold), identical in the TUI, `--plain`
  and `transcript.log`; `context.kept` (`code` | `jev`) now reaches the engine; the `[sandbox]` startup item tells a chosen
  `--sandbox none` from a genuinely unavailable sandbox; `sessions reindex` prints how many run records were written by a newer
  JevCode; a missing generator key names the resolved provider's variable; `sessions inbox --json` serialises coordination's
  `publicMessage` projection (no host key, pid, checksum or HMAC) plus `unverified`.

### Known gap in this release

- **No `AgentSupervisor`**: `/split`, `/agents`, `/agent`, `/land` and `/spawn` answer `<verb> is not available in this
  build — no agent is running`, the agents tab never appears, and `jevcode agents list` reads a manifest and prints `planned`
  rows. This is the production state the design intends for this round; the engine's delegation stages are opt-in and off.

## [0.5.0] — 2026-09-22 (not yet published)

Round 4 of the interactive TUI (`docs/TUI-DESIGN-4.md`; the record
of what landed, with every gate number, is `docs/STATUS.md`, "Round 4"). The brand stays on screen, command output
gets one grammar, a resize never deletes scrollback, Enter walks the palette, the conversation is turns, file edits
get a real diff — and the product stops failing quietly.

- `/jev`'s `cost` row ends with `· N cache hits` when the run served any Jev request from its per-run request-hash cache (llm-jev iteration 1; read from the explicit per-step `jevCacheHits`, never from `usage.calls === 0`).
- Two bench arms for the LLM-loop work, `jev-on-next` and `jev-on-next-nofast` (contract 1.9, `docs/LLM-LOOP-DESIGN.md` §8): the `jev-on` engine with the router table, the S2 generation mechanisms and — on the first of the two — the bounded sieve fast path, with the mechanisms pinned per arm into `summary.json` and both refused at any concurrency but 1. `comparison.md` gains the fast-path, router and TTFB rows; `src/bench/step-records.ts` bridges them out of `steps.jsonl` (without it every one of those fields is written to the run directory and is invisible to every table); `experiments/llm-jev/headtohead.mts` prints the §8.3 blocking rows, the §8.4 predictions and the §8.5 accept rule. A bench run now also clears `JEVCODE_FASTPATH` and `JEVCODE_ROUTERS` from its own environment before the first engine is built and says so in the log, because the engine resolves both of those env-first: the pinned row is otherwise a description of an intention rather than of the run. No live run has been taken, and `--conditions jev-on-next` is still rejected by `src/cli/args.ts`'s own allow-list.

### Added — the renderer, the palette and the grammar

- **An opt-in full-screen renderer** (§1.3): `--fullscreen`, `--renderer fullscreen`, `JEVCODE_RENDERER=fullscreen`
  or `ui.renderer: fullscreen` in the config file (read at launch, so `/fullscreen`'s "set for the next launch" is
  true). The header is pinned at row 1, the transcript becomes a scrollable **viewport** (PgUp / PgDn / Shift+↑ /
  Shift+↓ / Ctrl+Home / Ctrl+End) with a `<n>/<m> · <pct> % · PgUp` rung on the rule row and a
  `▲ <n> earlier rows · PgUp` marker while scrolled, and the allocator's post-condition is `total === rows`
  **exactly**. It refuses, in the table's order, below 18 rows, below 40 columns, under a screen reader and with
  no usable `TERM` — with one `[ui]` note that names the reason. Entering the alternate screen is recorded, so
  every restore path — `restoreTerminal()`, `fatalExit`, SIGHUP — writes `ESC[?1049l` before `RESTORE` and a
  crash can never strand the user on a blank buffer.
- **`/scrollback` and the on-exit dump** (§1.3.4): under `fullscreen`, `/scrollback` suspends, prints the whole
  transcript to the **primary** screen (native copy and find) and waits for a key; on exit the same transcript is
  written out after `1049l`, so the session ends with the scrollback classic would have left. Both go through
  `transcriptDumpChunks`, i.e. the same `formatTranscriptItem` rows `createPlainRenderer` writes, in 64 KiB chunks
  so a slow link cannot push the exit past `UNMOUNT_TIMEOUT_MS`. Under `classic`, `/scrollback` answers that the
  terminal's own scrollback already has it.
- **`src/tui/scrollback-guard.ts`** (§1.4): a one-method write filter on the stream handed to `render()`. Ink's
  `clearTerminal` is `ESC[2J ESC[3J ESC[H`, and **`ESC[3J` erases the terminal's saved lines** — everything the
  user had scrolled through, including the shell history from before `jevcode` started. The guard rewrites it to
  `ESC[2J ESC[H` and elides the `fullStaticOutput` prefix it has itself observed, so N clearing frames no longer
  leave N+1 copies of the transcript. `ESC[3J` is now **0 in every capture the repository takes**, live included.
- **The palette's Enter-cycling model** (§4.2, D-X): *Tab goes deeper. Enter runs what is written. Enter with
  nothing written yet walks the list.* Nine states, seven keys, one pure table (`src/tui/commands/nav.ts`), and a
  safety theorem that holds structurally — from `/` the state is S-BROWSE, whose Enter is a marker move, so no
  sequence of Enter presses alone can run anything. The ghost follows the marker (§4.3 P-P2), the marker resets to
  the top on every query change (P-P3), and in S-ARG Enter walks the argument **values** as a ghost without
  touching the draft.
- **Four new commands** (37 → 41): `/fullscreen`, `/scrollback`, `/peers`, `/ui reset`.
- **One command-output grammar** (§3.1–§3.5, D-W): every §3 command answers with one `block(head, rows)` —
  key/value, table or note — sized by `blockWidth` at four width tiers, with the declared normaliser making the
  TUI's one labelled item and `--plain`'s one `[ui] <row>` per row provably the same rows.
- **A real diff for a file edit** (§6, D-Z): `editSummary(action)` names the files and counts of every edit action
  including `patch`, `diffRows` is the one place a diff becomes rows, and `ColorRole` gains `added` · `removed` ·
  `hunk` · `diffMeta` with the sign already in the text. The review card's title reads
  `edit src/a.py +1 −1 "fix the off-by-one"` and its body is a unified diff, not two unlabelled blobs.

### Changed — resize, the narrow ladder and the history text

- **A resize commits synchronously** (§2.2 P-R1) on any shrinking dimension **and on every width change**, so the
  stale, taller tree is never painted at the new viewport and no frame carries two widths. Measured over a
  four-geometry ladder plus a 20-event storm at 24×80, 40×120, 12×60 and 60×200: **zero torn frames**, zero clears
  on a grow, at most one per shrink segment, zero `ESC[3J`.
- **The narrow ladder** (§2.3–§2.6): `fitRung` picks the widest rung that fits, `gutterMode` gives the transcript
  three rungs (`gutter` → `stacked` → `flush`), and no row is ever wider than the terminal — including at **1 and
  2 columns**, where the segment-aware wrap used to commit a 3-cell `· c` row, and at 3 columns, where it used to
  glue the 2-cell `· ` lead to a 2-cell grapheme.
- **The wizard survives minimum size** (§2.5 P-R6, D4): below 40×8 the slot is notice(1) · wizard(1) and there is
  **no composer** — a first-run user is no longer invited to type a task into a composer whose Enter cannot start
  anything. The wizard is read-only there: every key answers `resize to at least 40×8 to continue setup` and
  changes no wizard state. P-R5 reorders the minsize allocation to notice → composer → status, so at budget 1 the
  one row is the explanation rather than a spinner-less status row.
- **Every engine item is a sentence** (§3.6, §3.7, D-V): `[run] start <id> mode=jev-on task: t` becomes
  `[run] started · jev+llm · t`, `[run] end complete steps=2` becomes `[run] finished · complete · 2 steps · …`,
  `run:ready` and the `stop:` line are deleted as items, `intent=edit p=0.82 c=0.71` becomes
  `intent · edit · 0.82 (confidence 0.71)`, and an `ok` risk verdict drops from eight terminal rows to one. The
  run id is in one place — the epilogue. Every pin moved with it: 17 `.steps` files, six `*.pty.test.ts`,
  `run-smoke.sh`, `src/perf/pty.ts`'s two constants and `polish-check.mjs`'s V13 / V17 anchors, all written
  glyph-agnostically so an `--ascii` capture measures the same window.
- **`TERM=dumb jevcode chat` says why** (§2.8 P-R10) instead of `missing task text`, with the three ways out; an
  **EPIPE** hang-up writes `jevcode: stdout closed; run checkpointed at <dir>` to stderr before exiting 129
  (P-R11), where it used to exit with an empty stderr.
- **Ctrl+Z works again.** §1.4's write proxy made `App.tsx`'s `stdout === process.stdout` guard false for the real
  terminal, so `suspendProcess` was never called and Ctrl+Z was a no-op; the guard now compares against the
  memoised proxy. (A round-4 regression, caught by the pty suite's Ctrl-Z leg.)
- **`GlyphSet` gains `triangleUp`** (`▲` → `^`), so TD §14.1's one-to-one twin table covers the viewport's marker.
- **`GLYPH_DOT_CLASS` is an alternation, not a bracket class.** `[·-]` compiled against a **byte** subject — which
  is what `perf/drivers/pty_type.py` does — is a one-byte class that can never match the two-byte `·`. Every perf
  scenario that waits for `[run] started` matched nothing on a unicode capture and everything on an `--ascii` one;
  `anchorSelfTest()` now compiles each anchor byte-wise as well, so the shape cannot drift again.

### Added — hardening, faults, perf, pty (S6)

- **`jevcode report` is the bundle a TUI bug needs** (§7.7). It now copies `state.json`, `jevcode.log.1` (the
  rotated half — a rotation used to lose the crash), `ui.json`, the last 200 `decisions.jsonl` rows and the
  effective `keybindings.json`. Every copied file is capped at 2 MiB head + 2 MiB tail with a
  `… <n> bytes elided (original <m> bytes) …` marker and is redacted **line by line**, so a hundreds-of-megabyte
  `transcript.log` is no longer read into one string. `versions.txt` gains `isTTY`, `LANG`, `LC_ALL`, `TZ`,
  `COLORTERM`, `NO_COLOR`, presence booleans (never values) for `SSH_TTY` / `TMUX` / `STY` and a `launch` block
  (tier, fps, `renderMode`, `renderer`, `ascii`, `screenReader`, `reducedMotion`, `plain`, `theme`).
  `README.txt` is written first with `(bundle incomplete)` and rewritten last without it; the command prints the
  total size and a `tar -czf <id>.tgz -C <parent> <id>` line.
- **A typed fault injector** (§7.11). One `parseFault()` (`src/tui/faults.ts`) with thirteen scenarios —
  `render:<pane>[:lines][:sticky]`, `persist:<CODE>[:after=n]`, `rundir:rm`, `submit:hang`, `jev:429|401|5xx`,
  `net:*`, `stdout:EPIPE`, `clock:jump`, `index:corrupt|huge`, `config:*`, `loop:hog`, `peer:<n>` — replacing
  three string comparisons; `PaneBoundary` matches through the typed `renderFaultMode()`, not by string, so
  `render:<pane>:lines[:sticky]` can no longer match a boundary it was never meant for. `readFaultEnv()` builds
  the loud rejection — the value plus the twelve-row grammar — but **the pre-mount call site is not wired in
  this release** (it belongs in `src/cli/main.tsx`): today an unknown `JEVCODE_FAULT` is a silent no-op at run
  time and the grammar is enforced by the unit test. `JEVCODE_ASSERT_HEIGHT=1` is parsed and likewise has no
  consumer yet; the frame-height gate is enforced by `npm run perf` and `run-smoke.sh` on every capture.
- **`explainFsError`** (§7.4): a file-system errno becomes a sentence that names the fix — `cannot create the
  runs directory <dir>: permission denied` + `set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>`,
  `the disk holding <dir> is full`, `the run directory <dir> disappeared during the run`, `cannot read <path>:
  permission denied`, `too many open files`.
- **A peer surface** (§7.10, stub-driven until the registry of `docs/COORDINATION-DESIGN.md` lands): the status
  segment `<n> here` / `<n> stale` (counts only, dropped first when short), the session-open item
  `another jevcode is working in this workspace (started 4m ago) — /peers lists them`, and a dismissible
  blocking pane `[w] wait for it   [r] read-only session   [q] quit` (`[c] continue` when only stale entries
  remain).
- **Perf gates** (§11): `no ESC[3J ever` and `no frame taller than the terminal` are **measured** per geometry
  by `src/perf/render-lag.ts` (both join `hygieneOk`) and by `test/pty/run-smoke.sh` on every capture, with
  `no3JSelfTest()` as the precondition rather than the gate; and glyph-agnostic **named anchors** for every
  measured window — matched against two glyph sets, including an errored run, with a zero match a hard failure
  rather than a silently whole-capture window.
- **Two perf rows of contract 1.7 item 11**: the `scroll-latency` probe (`src/perf/scroll-latency.ts`, fullscreen
  only under D-S — scroll key → frame p95 < 16 ms, ≤ 6 KB per scroll frame, a width-change rebuild < 50 ms; it
  **skips** with the renderer's own refusal text rather than failing where fullscreen is unavailable) and two
  composer series, `palette-cycle` (200 Enter presses over the full command list, gated) and `palette-arg` (200
  Enters in S-ARG over `/mode `, reported). Neither has been run on a real pty yet — see `docs/STATUS.md`,
  "Round 4", deviations.

### Changed

- **A failing checkpoint write degrades loudly** (§7.2). The store reports every write-path failure through a new
  `onDegrade` callback as well as throwing, once per `<file>:<code>`; `ENOENT` joins the degraded set, so a runs
  directory removed mid-run is no longer completely silent (it used to report `complete`, exit 0, and advertise a
  resume for a directory that did not exist). The notice is a sentence —
  `checkpoint degraded: EACCES on state.json — the run directory is not writable; this run cannot be resumed` —
  never a raw `open '<path>'` suffix, and the run exits **3** even when the stop reason is `complete`.
- **Launch-time file-system failures go through `fatalExit`** (§7.4): stderr, the epilogue, the fix block and
  exit **2** (3 for a vanished run directory, and for a disk that filled while writing inside one), instead of
  `[ui] error: <raw errno>` on stdout with exit 1. **Which** row an errno gets is derived from where its path
  is — the config file, the live run directory, the runs directory — and an errno that is none of those (a
  workspace file) stays unclassified and keeps exit 1 rather than being relabelled a runs-dir failure; the path
  in the sentence is `~`-abbreviated through `shortPath`. `EMFILE`/`ENFILE` carry no path and are classified on
  the code alone.
- **The degradation notice fits** (§7.12): `ui: <pane> failed (<Error.name>) — run continues; see <log>` at
  ≥ 64 columns, `ui: <pane> failed (<Error.name>)` below it with the log in the item's detail, and no `see …`
  clause when no log is open. `Error.name` is made terminal-safe and clipped to 32 characters.
- **The session index is bounded and honest** (§7.6): `readIndex` folds only the last 8 MiB, read from the end and
  starting at a line boundary — 200 000 lines now fold in under 100 ms (581 ms before). Unreadable lines are
  counted by reason (`not-json`, `bad-shape`, `over-length`, `unknown-kind`) and `jevcode sessions` says
  `<n> index lines were unreadable and skipped — run jevcode sessions reindex` instead of printing the
  fresh-install sentence; past 8 MiB it offers `jevcode sessions prune`.
- **A newer `run.json` is refused by name, not read as corrupt** (§7.9):
  `run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with jevcode upgrade`.
  Older and version-less files keep loading; `jevcode sessions reindex` counts newer runs separately; `jevcode
  report` still bundles them.
- **Two memory bounds** (§7.13): decisions are now capped **within** a step as well as across steps (a steer storm
  in one step grew without limit), and `appendItems`' comment no longer claims `UiState.items` keeps every item.
- **A submission watchdog** (§7.8): 45 s without a `run:start`, a `thinking` change or a stream byte appends
  `the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave`, measured on a monotonic
  clock. `nothing to abort` replaces the silent no-op.
- **Every run-frame anchor is glyph-agnostic and named** (§3.7 G1, the R2 guard). D-V renamed `[run] start <id>
  mode=… task: …` to `[run] started · <badge> · <task>` and `[run] end <reason> steps=<n>` to
  `[run] finished · <reason> · <n> steps · …`, so `src/perf/pty.ts`'s `END_PATTERN` / `RUN_STARTED_PATTERN`,
  `test/pty/helpers.ts`'s `RUN_STARTED_STEP`, the 17 `.steps` files carrying `expect end …`, six `*.pty.test.ts`
  files, `test/pty/run-smoke.sh` and `scripts/pty/polish-check.mjs`'s V17 anchor all move **in this commit**.
  They are written `[·-]`, never `·`: `glyphs.ts` renders `dot: '-'` under `--ascii`, and a hard-coded `·` would
  silently stop matching in every `--ascii` capture — which is exactly how a stale anchor turns the render-lag
  window into the whole capture and the gate into a lie.
- **V13 is un-deferred, V17 can no longer pass vacuously** (§11). `polish-check.mjs` gates V13 (no `k=v` pair and
  no ` | ` separator in a scrollback row outside the allowlist) now that D-V has landed; `--no-v13` replays a
  capture taken against an older build. V17's run-end anchor is the exported `RUN_END_RE` with a two-glyph-set
  self-test, and a capture in which a run demonstrably started **and** stopped while the anchor matched **zero**
  rows is now a hard failure, where round 3 reported success with `no run ended in this capture`.

### Fixed by the integration pass

- **V22 and V23** (§2.9 P-R13) join `scripts/pty/polish-check.mjs` beside V6: **V22** — within one frame every row
  that opens with a box glyph is exactly the width of that frame's rule row and none ends in the truncation
  ellipsis (the torn-frame predicate D1 needs; V6 catches neither half, because no row is *wider than the
  terminal*); **V23** — no scrollback continuation is indented past its rung's gutter, learning the value columns
  §3.1's blocks legitimately hang under. The smoke suite now reports `polish-check:pass(22)`.
- **`perf/drivers/pty_type.py` can match a unicode capture again.** Two defects in the §3.7 G1 anchor migration,
  both of which made a measurement silently vacuous: `RUN_STARTED_PATTERN` carried one SGR gap where the frame
  writes two (the label's span closes before the space, the text's opens after it), and `GLYPH_DOT_CLASS` was a
  bracket class over a two-byte glyph. Between them, `composer live`, `composer live-stress`, `composer review`,
  `scroll-latency` and five `states` scenarios reported `0/200 keys` and exit 124 after waiting 20 s for a row
  that had been on screen the whole time. `anchorSelfTest()` now compiles every anchor byte-wise as well.

### Removed

- **`createResizeDebounce` / `RESIZE_DEBOUNCE_MS` / `Debounced` leave `src/tui/index.ts`** (§2.2 P-R2) with their
  one consumer, `App.tsx`'s `wrapColumns`. The 50 ms trailing debounce kept the draft one width behind the box
  edges (≈ 130 ms at `--fps 15`): 4 of 24 frames carried a box row whose right border was the truncation ellipsis.
  A **public API change**.
- Nothing else. Every contract-1.7 member is optional and every default is unchanged.

## [0.4.0] — 2026-09-21 (not yet published; `package.json` bump is the integrator's)

Round 3 of the interactive TUI (`docs/TUI-DESIGN-3.md`; the record of what landed is `docs/STATUS.md`,
"Round 3"). One default, one key, one brand: `jev+llm` is the default mode, one OpenRouter key runs Jev and the code model, the
wordmark stays on screen and the palette is TypeSafe's pink.

### Changed

- **Default mode `jev-on` (badge `jev+llm`)** — `DEFAULT_MODE` in `src/config/defaults.ts` is the one constant every fallback
  reads (D-G); the badge words come from the one table `MODE_BADGE_WORD` (`jev-only` · `jev+llm` · `llm-only` · `llm+jev ·
  verified`; D-N) and no string outside `defaults.ts` names which mode is the default. The session follows `config.mode`
  (flag > `JEVCODE_MODE` > dotenv > file > default) through `applyConfig`, so a round-2 `mode: jev-only` row keeps its session.
  Caps by default: $2.00 per run, $10.00 per session; `/mode jev-only` and the wizard's `3 Jev only` keep the $0.25 / $1.25 path.
  A keyed start whose `mode` resolves from the default and whose file has no `mode` row prints the `[setup] mode jev+llm (default) —
  caps …` item once (D-Q, `seen.defaultMode`).
- **The wordmark stays** (D-I, §3): the 5-row mark is the pane slot's idle tenant at ≥ 21 rows and ≥ 64 columns — shown while idle
  and thinking, hidden while a run is live or a panel / picker / review owns the slot, back under the strip after `run:end` (at once
  at ≥ 24 rows, on the first key at 21–23). A key completes the reveal instead of killing it. The splash's 6-cell sweep loops at
  4 fps peak / 1.6 fps mean (16 frames per 4 s pass, 6 s of rest; one pass per 30 s after a minute without activity; static after
  ten minutes; never within 3 s of a key; a reply calms it). The caption `◆ <version>` replaces the brand row as the settle
  sentinel (≥ 73 columns); the tagline `Decisions, not strings` at ≥ 104 columns. `ui.wordmark: sweep | static | off` is the
  escape hatch (default `static` under SSH); `--no-animation`, `NO_COLOR` and the flat tier spend no idle frame.
- **TypeSafe pink** (D-H, §2): the `dark` theme keeps its id and becomes the typesafe.ai palette — primary `#f386a1` (cell 211) for
  what *is* JevCode or Jev (the brand row, the wordmark letters, the badge, the `[jevcode]` label, `[chosen]`, the idle `›`, the
  spinner), secondary `#d45bb6` (cell 169) for what is *being acted on* (the console edges while a run is live, the `[you]` label,
  the palette cursor); red / amber / green keep their hues; the `light` theme darkens the pinks and fixes its unreadable red and
  green; `COLORFGBG` with a white background (7 or 15) selects `light` by default (D-R). Bodies stay the terminal's default
  foreground — the label is the bubble (D-O); the prompt is pink at rest and amber while steering; the spinner is the shade pulse
  `░ ▒ ▓ █ ▓ ▒` in the accent (D-P), `◆` under reduced motion.
- **Transcript polish** (D-L, D-M, §5): a fixed 10-cell right-aligned label gutter (`[jevcode]` flush, `     [ui]` padded; bodies at
  column 10, wrapped rows hanging there); bodies wrap at ` · ` before spaces with the separator leading the continuation, and a
  final token narrower than 4 cells never sits alone (`… (gen $0.000, jev $0.025)` / `exit 4`); detail rows indent under the body
  column and the epilogue's `label     value` rows hang under the value; a blank row above a `[ui]` block; the status row colours
  the left word and the meter words only; the loop banner reads `loop · …` and clears at `run:end`; the run id never sits in the
  status centre. Engine item **text** is unchanged (D-M: `[run] start/end`, `replan`, `loop tripped` rewrites are round 4's); only
  local items moved — `/cost`'s head is `cost` and its per-question figure reads `~$0.000006 each` (no scientific notation), `/jev`'s
  last-intake row names the reading, the `[sandbox]` item reads `seatbelt · writes only in the workspace and run dirs · …` with the
  old sentence as its detail.
- **Commands** (D-K, §4): 21 shortcut aliases (`/s` status, `/p` panel, `/t` theme, `/l` login, `/m` mode, `/c` cost, `/d` diff,
  `/u` undo, `/b` budget, `/j` jev, `/w` why, `/r` resume, `/q` exit, `/nw` new, `/pl` plan, `/tr` transcript, `/cf` config, `/cp`
  copy, `/rw` rewind, `/dc` decisions, `/ml` model — no one-letter alias for `/abort`, `/exit`, `/new`); an exact alias pins its owner
  to the top palette row, the palette shows an alias column, a ` → /owner` ghost and Suggested → recent → Popular groups; Tab
  completes arguments and never wipes a typed one; an error the user cannot fix by editing clears the draft, a fixable one keeps it.
  The 23 findings of the command audit are fixed (`/panel` and `/transcript` in `--plain`, `/theme` forwarded to the host, `/copy
  diff` copies the diff, `/why` errors read alike in both renderers, one help formatter, `keybindings.json` reaches the App, `/new`
  before a session, `/rename` says when it cut, commands while thinking, `/model` / `/provider` show forms, `/logout` labels,
  `/trust` Esc closes, `/errors` acks `!n`).

### Added

- **One-key onboarding** (D-J, §1.4): a bare `jevcode` with no key anywhere opens on one masked OpenRouter field under the held mark
  (`setup · key`); Enter writes the four file keys from one paste; Esc on the empty field opens `options` (`1 OpenRouter · 2 TypeSafe ·
  3 Jev only · 4 Anthropic` — a digit highlights and shows its consequence, the same digit or Enter confirms; `3` at startup persists
  `mode: jev-only`); a resolving TypeSafe / Jev / Anthropic key gives the field a found-title and saves only what the found state calls
  for (a file `jevProvider` never displaces `TYPESAFE_API_KEY`). Verification on an explicit `y` sends one priced Jev decision
  (~$0.00002), one 1-token completion and `GET /api/v1/key`, with four outcomes (ok · rejected · credits · unreachable · model);
  `jevcode login --key-stdin` is the pipe form; the `[setup] spend caps` item after a wizard save; the jev-on fix block leads with
  `export OPENROUTER_API_KEY=…   # one key: Jev + the code model`.
- `ui.wordmark` setting (`sweep | static | off`; `JEVCODE_WORDMARK`); `LaunchSettings.themeHint` from `COLORFGBG`; `LaunchSettings.ssh`.
- Perf: the `idle-frames` probe (`chat --mock` at 24×80 and 40×120 left alone for 31 s: `dynamic` frames ≤ 4 in any second and ≤ 2/s
  mean, ≤ 12 KB/s peak / ≤ 5 KB/s mean, 0 clears, region ≤ rows − 2, child CPU reported); the composer `idle-loop` series (200 keys
  typed 200 ms into the first sweep pass); the render-lag `run-start` bucket (the rule sweep's frames in the run's first second).
- `scripts/pty/polish-check.mjs`: the hero-frame checklist V1–V21 of TUI-DESIGN-3 §9 over a `.cap` / `.txt` capture pair; the pty
  smoke's `polish` / `polish-wide` scenarios run it; unit tests on synthetic captures.
- pty scenarios: `wordmark-idle`, `wordmark-key-during-pass`, `wordmark-handoff`, `wordmark-21` / `-20` / `-22-postrun`,
  `wordmark-reduced` (replaces `splash-reduced`), `wordmark-nocolor`, `theme-pink` / `-light` / `-ansi`, `polish`, `r3-*` wizard edges,
  `ts-only-start` / `-restart`, `r3-env-jev-only`, `commands-{idle,live,thinking}`, `trust-esc`, `keybindings`.

### Contract

- contract 1.3 (`src/core/types.ts`, additive): `Renderer.setBindings?`, `WizardOutcome` `{ kind: 'mode' }`, `Prompter.wizard`
  `found` / `foundSource`, `UiConfig.wordmark?`, `SettingName 'ui.wordmark'`, `SessionHost.dispatchContext?`; `CheckpointEnvelope.version`
  stays 1.

## [0.3.0] — 2026-09-21 (not yet published)

Round 2 of the interactive TUI (`docs/TUI-DESIGN-2.md`; what landed and what was verified is
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
- **Probes, scenarios and docs for round 2**. `src/perf/intake-latency.ts` (Enter → `[you]` bubble frame
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

- **The persistent wordmark no longer taxes every keystroke** (`src/tui/App.tsx`): the five mark rows are memoised by value on the
  sweep's band tick and blank cells join the neighbouring coloured span, so a key frame re-renders the App but leaves the mark's
  React nodes untouched — palette keystroke → frame p95 34 → 5 ms, idle p95 7.4 → 4.1 ms (isolated probes; `docs/STATUS.md` "Round 3").
- **Frame 0 honours `--theme` / `JEVCODE_THEME`** (`src/config/launch.ts` `themeHint`): the splash and console never paint the dark
  palette before the resolved theme applies. **Wizard:** a key pasted with a trailing newline saves (the Enter read a stale closure);
  the `--plain` wizard's Ctrl-C prints the fix block and exits 2 instead of hanging. **`/rename`** clips once and says so.

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
