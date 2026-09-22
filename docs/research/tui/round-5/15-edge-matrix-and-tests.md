# Round-5 cross-cutting edge matrix and test/gate plan

Scope: coordination, context meter, agent tree, import, provider/model picker — the five round-5 surfaces named in
the brief. Repo `<repo>`, worktree `r5-design`, branch `r5-design`; read-only,
nothing tracked touched. Every file:line below was grepped/read directly against this worktree on 2026-09-22, not
copied from `docs/research/tui/round-5/00-contract-digest.md` (**§0**, cited as **CD**) without independent
verification — three corrections to CD are logged in §1.6 and §6. Read order assumed: CD §0/§B/§C/§D, then
`docs/TUI-DESIGN-4.md` §0, §8, §9, §12 (**TD4**).

---

## 1. What the designs and code say (verified, file:line)

### 1.1 Coordination (CD A1)

`Ledger`/`Fold`/claims/records are substantially built (`src/coordination/**`); the TUI has **zero consumers** —
`grep -rn "coordination" src/tui/** src/cli/session.ts` finds none. Verified directly:
`lockReplaceVerdict` `src/coordination/records.ts:829`; `claimRefusal` `src/coordination/claims.ts:265`;
`ForkVerdict`/`ForkRole` `src/coordination/claims.ts:220,222`; `compareClaim` `src/coordination/claims.ts:85`
(epoch desc → deviceId asc → runId asc → at asc → pid asc); `Fold` 14-field shape `src/coordination/types.ts:327–366`
(`live, gone, leases, byPath, inbox, acks, devices, cloned, liveness, ignored, skipped, at, forks?, origins`);
`LedgerHandle extends Ledger` (27 members) `src/coordination/ledger.ts:189` vs. the 7-member base `Ledger`
`src/coordination/types.ts:466–485`. `jevcode sessions` (`src/cli/sessions.ts`, 137 lines) has only
`list|reindex|prune|unlock`; no `who/pause/resume/end/tell/headsup/request/inbox/label/pair/unpair/gc/sync`.
`/pause` exists in the registry (row below) but with no `[now]`/scope argument. **`/end` is closer to done than CD
states** — see §1.6 correction 1.

### 1.2 Context meter (CD A1)

`EngineStatus.context?: ContextUsage` is optional, confirmed present at `src/core/types.ts:1426–1456`.
`Engine.compact?(): void` at `src/core/types.ts:1779`. Both are additive and require no engine change for a
render-only TUI feature — `/context`/`/compact` are **not** in the 37-row registry (verified §1.4). This is the
lowest-risk round-5 slot: pure rendering against fields already on `main`.

### 1.3 Orchestration / agent tree (CD A2)

`grep -rln "orchestrat" src/tui` → **zero** matches; the harness side (`src/orchestrate/**`, 16 files) is far ahead.
`AgentSupervisor` (design's `src/cli/agent-supervisor.ts`, ~620 LOC) is **not found anywhere in `src/`**.
`StageName` (`src/core/types.ts:243`) is 8 members, no `'decompose'`/`'coordinate'`. `PausePointReason`
(`src/core/types.ts:1543`, verified exact) is `'step' | 'now' | 'now-after-execute' | 'pane' | 'worktree'` — 5
members, no `'delegate'`/`'review-needed'` yet, so nothing can render "delegated at step N" today. `PaneTab`/
`PANE_TABS` are round-3 shape (no `'a'` agents tab). `// contract 1.5` is absent from `src/core/types.ts`
(confirmed: `grep -n "^// contract" src/core/types.ts` → `1.1, 1.2, 1.2, 1.3, 1.4, 1.7`); `src/orchestrate/index.ts`
already exports `AgentRef, AgentRow, AgentSpec, Manifest, SplitKind, VerifyResult` etc. as a pre-merge workaround.

### 1.4 The shared registry today (verified independently of CD)

`src/tui/commands/registry.ts:102` `export const COMMANDS: readonly CommandSpec[] = [...]` has exactly **37** rows
(counted by `category:` field, not by `name:`, which also appears inside nested `args` — a naive count returns 62).
`CommandSpec.category` exists at `:62`, confirmed (CD's claim that it "already exists" is correct). No
`EXCLUSIVE_COMMANDS` array was found in `src/tui/commands/*.ts` by name — the digest's "`/land` must join
`EXCLUSIVE_COMMANDS`" (ORCHESTRATION-DESIGN §4.7) names a symbol not yet grep-confirmed on this branch; treat as
**unverified** until the orchestration slot lands its own commands (flagged in §6).

### 1.5 Import (CD A3)

`planImport` `src/import/index.ts:322`; `probe` `:584`; `summarisePlan` `:648` → `PlanSummary` with
`credentialsFound: number` (`src/import/index.ts:621`, incremented at `:653` `if (r.class === 'secret') credentialsFound++`);
`applicableRows` `:680`; `confineDestination` `src/import/apply.ts:165`, re-asserted at both call sites (`:516`, `:659`)
— the re-check-at-the-seam pattern the design calls [G1.2]. `WizardStep` (`src/tui/onboarding/reducer.ts:26`) has no
`'import'` member; `src/tui/import/**` does not exist; `Command` union (`src/cli/args.ts:19`) has no `'import'`
member — confirmed: `'chat'|'run'|'config'|'bench'|'perf'|'login'|'logout'|'sessions'|'report'|'why'|'calibration'|'completion'|'upgrade'`.

### 1.6 Model / provider picker (not covered by CD — no peer design doc exists for it yet)

No design doc under `docs/*.md` mentions "model picker" (`grep -ln "model picker" docs/*.md` → none). The harness
side is already built and is a genuinely strong foundation:
- `src/models/list.ts:96,98,120,205,268,284` (`ListSource = 'network'|'cache'|'static'`, `src/models/types.ts:96`) —
  **a four-tier fallback already exists**: `listModels` tries network, falls back to `fromCache(provider, cached, 'cache', error)`
  (any age) on failure, and falls back further to `fromStatic` (the bundled snapshot, `SNAPSHOT_AT`) when there is no
  cache at all (`list.ts:216–247`). `ListResult.stale = source !== 'network'` (`:172`).
- `instantCatalogue(providers)` (`src/models/list.ts:284`) is the **zero-I/O** catalogue — "what a picker paints on
  its first frame before any `listModels` promise settles" (doc comment, `:280–283`). This is exactly what the
  no-network-before-first-frame rule needs and it already exists.
- `loadCatalogue`/`loadCatalogueFromEnv` (`:268,276`) fetch every configured provider **in parallel**; "a provider
  that fails contributes its cache or snapshot rows and an `error` on its own `ListResult`, so one bad key never
  empties the list" (doc comment, `:262–264`) — the empty-catalogue and one-bad-key cases are already handled at
  the harness layer.
- `ModelsError.kind` (`src/models/types.ts:87`): `'no_key' | 'auth' | 'rate_limit' | 'http' | 'network' | 'invalid'`
  — six typed failure kinds, `toModelsError` (`list.ts:79`) classifies them and redacts the message.
- `PROVIDERS` (`src/provider/registry.ts:174`), `providerFor`/`requireProvider`/`keyEnvFor` (`:279,284,291`) are the
  provider registry; `src/config/credentials.ts:87` `credentialsPath` resolves where a key is read from, and
  `keyEnteredText`/`savedText`/`shadowingText` (`:36,45,51`) are the existing masked-display strings a picker's key
  entry step should reuse rather than inventing new ones.
- **Nothing calls any of this from `src/tui/**` or `src/cli/main.tsx` today** — `grep -n "models/\|provider/registry" src/cli/main.tsx` returns nothing. The whole picker is round-5-new work with a first-frame constraint to design against `instantCatalogue`, never `listModels`, on the argv path.

**Three corrections to CD, load-bearing for the test plan:**
1. `Engine.end?(opts?: EndOptions): void` **exists** at `src/core/types.ts:1771`, with `EndOptions` at `:1589`
   (`at?: 'step'|'now'`, `by?: 'human'|'remote'`) and `RunMeta.ended?: RunEnded | null` at `:1073`
   (`RunEnded { at: string; by: 'human'|'remote' }`, `:1597–1600`). CD's A1 row calls this "unverified, likely NOT
   YET" — it is built; what's missing is the **index kind** (no `session:end` in `INDEX_KINDS`, confirmed below)
   and the `/end` command row, not the engine method.
2. `INDEX_KINDS` (`src/session/index.ts:36`) is confirmed **exactly** as CD states: 8 entries, `readonly string[]`
   (not a literal union — so nothing type-checks a bad kind string; a test must do that job, see §3 row 27).
3. `src/workspace/gitstate.ts` and `src/workspace/patch.ts` have **no `index.lock`/`EAGAIN`/"already locked"
   handling** (`grep -n "index.lock\|EAGAIN\|busy" src/workspace/gitstate.ts src/workspace/patch.ts` → nothing) —
   concurrent git operations (§3 row 13) are an unhandled gap today, not a design oversight to relitigate.

`src/bench/runner.ts` already has a real `--resume` implementation worth reusing as the pattern for round 5's
session resume, not just bench: `resumeBenchId` (`cli.ts:84`), `BENCH_ID_RE` validation (`runner.ts:74`),
`PairMode = 'skip'|'fresh'|'resume'` (`:337`), and the graceful-fallback rule at `:506–509` — "if the resumed run's
workspace or run dir is gone, log a line and start fresh" — is the exact shape round 5's cross-device resume needs.

---

## 2. What the best tools do (cited)

**Crash/detach model (tmux).** tmux splits server (survives) from client (can vanish): "the server and all
sessions within it keep running" after a dropped connection; a stale-but-still-registered client is force-removed
by `tmux attach -t work -d`, which "detaches any existing client" before attaching the new one — the direct analogue
of a takeover claim. The tmux server itself does **not** survive a reboot; only `tmux-resurrect`/`tmux-continuum`
persist across that, and tmux's own docs treat "no sessions" post-reboot as expected, not a bug (oneuptime.com "How
to Recover Disconnected Sessions with tmux", ditig.com "tmux: How to attach and reattach sessions", both fetched
2026-09-22). JevCode's `RunLock`/`isPidAlive`/`lockIsLive` (`src/session/lock.ts:14,27,57`) is the process-liveness
half of this; the coordination `Ledger`'s claim epochs are the takeover half — round 5's job is exposing both as one
`/who`-style view, the way `tmux -CC` control mode exposes one server's session list to a client.

**Agent tree (Cursor 3, opencode).** Cursor 3's Agents Window is "a sidebar that shows every active agent session,
local or cloud, across all your repos, all at once … running agents in parallel across local workspaces, cloud
environments, git worktrees, and remote SSH … up to 8 agents … running, paused, waiting for review, or completed"
(agentpatterns.ai "Cursor 3 Agents Window: Parallel Agents and Worktree Isolation", learncursor.dev "Cursor Agents
Window", both fetched 2026-09-22) — a flat status enum per row plus per-agent worktree isolation, matching
ORCHESTRATION-DESIGN's 16 row-state / 4-card model (CD A2) more than it contradicts it. opencode's subagent sessions
are navigated as a tree with `up/left/right/<leader>down` and quick slots `<leader>1..9`
(`docs/research/tui/01-opencode.md:331`, sourced from `packages/opencode/src/cli/cmd/tui.ts`, fetched 2026-09-20) —
the precedent for round 5's `[k]/[e]/[n]` exit gate needing a **parent-relative** navigation model, not a flat list,
once an agent itself spawns.

**Context meter.** Claude Code's statusline JSON exposes `context_window.{total_input_tokens,total_output_tokens,
context_window_size,used_percentage,remaining_percentage}` plus per-call `current_usage.{input_tokens,output_tokens,
cache_creation_input_tokens,cache_read_input_tokens}` (`docs/research/tui/02-claude-code.md:571–580`, sourced from
`code.claude.com/docs/en/statusline.md`, fetched 2026-09-20) — the model for JevCode's `ctx N%` cell: percentage plus
the raw counts behind it, never just the percentage alone (a bare `%` cannot be sanity-checked by a user or a test).
Its `/context [all]` "Visualize current context usage as a colored grid" (`02-claude-code.md:403`) is the closest
prior art for JevCode's `/context` command (CD row, EngineStatus.context already on main). Codex CLI's `/status`
"show current session configuration and token usage" (`docs/research/tui/04-codex-cli.md:454`, `slash_command.rs`
L89–153, fetched 2026-09-20) is the minimal version: one command, no grid. Aider prints `usage_report` via
`format_tokens` (`<1000` raw, `<10000` → `f"{n/1000:.1f}k"`, else rounds to the nearest k) and splits cost into
"message, session" (`docs/research/tui/05-other-agent-tuis.md:113–114`, sourced from `aider/coders/base_coder.py` and
`aider/utils.py`, fetched 2026-09-20) — the compact-number-formatting precedent CD's own budget-lines work already
follows via `sessionRemainingUsd`.

**Model picker.** Codex's `/model` is "choose what model and reasoning effort to use" (`04-codex-cli.md:454`); Crush
and Pi bind `Ctrl+L` to a model picker directly (`docs/research/tui/05-other-agent-tuis.md:65`, sourced from
`crush/internal/ui/model/keys.go` and `crush/README.md`, fetched 2026-09-20) — round 5's existing rejection of that
binding in `05-other-agent-tuis.md:568` ("R13 … JevCode has no runtime model switch anyway") is now **stale**: round
5 is exactly the wave that adds one, so the `Ctrl+L` conflict-with-clear-screen question (aider, Qwen, Cline all use
`Ctrl+L` = clear) needs re-opening, not inheriting a round-3 answer written before this feature existed (flagged §6).
opencode's `--model|-m` flag and per-session model pin (`01-opencode.md:328`) is the CLI-flag precedent.

**Import.** Claude Code's own `/memory` ("Edit `CLAUDE.md` files, enable or disable auto memory, and view auto
memory entries", `02-claude-code.md:412`) is the nearest prior art for JevCode's `/memory` command (already named in
IMPORT-DESIGN §5.8.1 per CD A3) — the source tool the design imports *from*, reused as the destination-side
inspection command.

---

## 3. Edge cases — the cross-cutting matrix

Columns: **#** · **fault/situation** · **required behaviour** · **evidence (design or code)** · **test that proves it**.

| # | Fault / situation | Required behaviour | Evidence | Test |
|---|---|---|---|---|
| 1 | Crashed session (process died, lock stale) | `isPidAlive` false → lock is dead, not live; a new `/resume` may take it without a takeover prompt | `src/session/lock.ts:27,57` `isPidAlive`/`lockIsLive`; CD A1 `lockReplaceVerdict` `records.ts:829` | `records.test.ts` forged-dead-pid case; `engine-takeover.test.ts` |
| 2 | Clock skew between two devices | Claim rank never trusts wall-clock alone below epoch/deviceId/runId; `at`/`pid` are tie-breakers only | `compareClaim` `claims.ts:85` — epoch desc → deviceId asc → runId asc → **at asc** → pid asc (at is 4th, not 1st) | `claims.test.ts` property test: skewed `at` never flips a decision epoch/deviceId/runId already settled |
| 3 | Stale lease (heartbeat expired, process still running) | `isLive` checks arrival/env, not pid-alive alone, so a frozen-but-alive process is still flagged stale | `isLive(record, now, arrival, env, origin)` `records.ts:714` (5-param signature, CD-corrected) | `records.test.ts` frozen-heartbeat case |
| 4 | Same repo opened via two different filesystem paths (symlink, bind mount) | `Fold.cloned` distinguishes a second physical clone from a path alias of the same tree; TUI must key off `origins`, never re-derive `sameDevice` | `Fold` `types.ts:327–366` field `cloned`; CD row 27 "never re-derive `sameDevice` from a record field" | `fold.test.ts` two-path-one-inode case |
| 5 | Same repo via two git worktrees | Each worktree is a distinct `runDir`/lock; the picker must show both under one repo identity, not merge them | CD A1 activity-view row; Cursor 3's per-worktree agent isolation (§2) as external precedent | `sessions-target.test.ts` two-worktree fixture |
| 6 | Offline device (never synced) | `/who`/`/peers` shows it as absent, not "0 live" (absence ≠ liveness-false) | `Fold.gone`, `.ignored` fields `types.ts:327–366`; `/peers` empty state string `no other jevcode is working in this workspace` (TD4 §12) | `watch.test.ts` |
| 7 | Secrets must never cross sessions or land in a shared file | `createRedactor(secrets).redact` substitutes exact configured secrets before `patternRedact`'s 15-family scan; `confineDestination` re-checked at both apply call sites | `src/core/redact.ts:93` `createRedactor`; `apply.ts:165,516,659` `confineDestination` | `import/leak.test.ts`; `test/pty/round3.pty.test.ts:54` `assertNoKeyBytes` |
| 8 | Concurrent git ops (another process holds `.git/index.lock`) | A patch/diff attempt must surface a named, recoverable error, not hang or silently no-op | **Gap confirmed**: no `index.lock`/`EAGAIN` handling in `gitstate.ts` or `patch.ts` (§1.6 correction 3) | new: `workspace/patch.test.ts` case for `EAGAIN`/`index.lock`, currently missing |
| 9 | Pause mid-step | Step commits whole before stopping (`at: 'step'`, the default) | `PauseOptions.at` `types.ts:1582`; `PausePointReason 'step'` `:1543` | `pause.test.ts` step-boundary case |
| 10 | Pause mid-LLM-round ("now") | The stage in flight is discarded; proposal + arrived samples are cached for `--replay`, never silently dropped | `PausePointReason 'now'`/`'now-after-execute'` `types.ts:1544–1546`; `InterruptedDetail` `:1603` | `pause.test.ts` now-during-execute case |
| 11 | Resume across devices | `/resume` folds `Ledger.claim`/`fold` before `createEngine`; refuses with `--force-takeback` hint only on a qualified foreign claim | CD A1 `claimRefusal` `claims.ts:265`; `--force-takeback` string (CD row) | `engine-takeover.test.ts` |
| 12 | Resume after a local crash (no foreign claim) | Same `/resume` path, zero takeover prompt, zero epoch bump | `lockReplaceVerdict` dead-lock branch | `records.test.ts` |
| 13 | A bench resume | `--resume <bench-id>` re-reads `tasks.jsonl`; a resumed run whose workspace/run dir vanished falls back to fresh with a logged line, never a crash | `src/bench/runner.ts:337,393,506–509` (verified, §1.6) | existing `bench` unit tests + a fixture for the vanished-dir fallback (confirm coverage, not yet independently re-read line-by-line this pass) |
| 14 | Agent tree with a dead supervisor | Children are adopted by the next session within one poll, not orphaned | CD A2 `AgentSupervisor` design note "crashed supervisor (children adopted by next session within one poll)" | none written yet — **new test required**, no `AgentSupervisor` module exists to test (§1.3) |
| 15 | Import of a malformed source file | Classification (identity rules before atlas class, per the 2026-09-22 decision log) never throws; a parse failure is `skip:` + reason, not a crash | `docs/DECISIONS.md` "Import classification runs the identity rules before the atlas class" | `import/plan-scope.test.ts` (harness-owned; TUI wizard must render the `skip:` reason without a stack trace) |
| 16 | Import of a huge source (> size cap) | Oversize is decided **before** the secret rule reaches it only where the never-imported atlas classes apply; otherwise the secret basename rule still fires on an oversize credential store | same decision log entry, rule ordering | `import.test.ts` oversize + secret-basename combined fixture |
| 17 | Import of a secret-bearing source | `credentialsFound` counts every `class === 'secret'` row; `--yes` never applies a credential row (`applicableRows`) | `src/import/index.ts:621,653,680` | `import.test.ts` |
| 18 | Model catalogue offline (no network, no cache) | Falls to `instantCatalogue` (zero I/O, bundled snapshot) — never blocks or empties the picker | `src/models/list.ts:284` `instantCatalogue`; `:187` `fromStatic` | new: `models/list.test.ts` all-providers-offline-no-cache case |
| 19 | Model catalogue stale (cache present, network fails) | Falls to `fromCache(...)` with `stale: true` and the `error` attached, never silently presented as fresh | `list.ts:172,216–247` | `models/list.test.ts` (existing per doc comment; confirm the `stale` flag is asserted, not just the fallback) |
| 20 | Model catalogue empty (zero providers configured/keyed) | `loadCatalogue` over `providers: []` or all-unkeyed still returns a non-throwing `CatalogueLoad` with `models: []`, not `undefined` | `list.ts:268` `loadCatalogue` signature (`providers?`, `keys?`) | new: `models/list.test.ts` zero-provider case |
| 21 | Invalid API key | `ModelsError.kind === 'auth'`, message redacted through `toModelsError`, never the raw HTTP body | `src/models/types.ts:87`; `list.ts:79` `toModelsError` | `models/list.test.ts` auth-failure fixture (confirm existing coverage; add if missing) |
| 22 | `--plain` twin for every new coordination/context/agent/import/model row | Same content as the TUI row, through the one formatter, never a second hand-written string | `src/tui/plain.ts` (S5-owned, TD4 §9.1); TD4's own "line identity" gate | `plain.test.ts` + `round4-identity.test.ts` pattern, extended per new row |
| 23 | `--json` shape where a CLI verb exists | Every new `jevcode sessions <verb>`/`jevcode import`/`jevcode models` subcommand emits a stable `--json` shape | CD A1 row "Add … each a thin wrapper" — no `--json` shape named yet for the new verbs; **gap** | new: one `--json` snapshot test per new CLI verb |
| 24 | `--ascii` / `NO_COLOR` twin | Glyphs (`◆`, `⇄`, `✉`, `▲`) substitute per `glyphs.ts`; colour roles drop under `NO_COLOR` | TD4 §12 glossary rows carry the ascii substitute in parens for every new string; `glyphs.ts:116` vs `:168` (§3.7 R2 rule) | pty twin sweep (`round3.pty.test.ts` V21 pattern) extended to every round-5 string |
| 25 | Screen-reader twin | Every new card/row has an `SR` sentence form, never just a glyph row | TD4 §12 "the SR diff sentences", "SR `working…`/`reply ready`" as the existing pattern | `review.test.tsx`-style SR assertion, one per new surface |
| 26 | Reduced motion | No new animated component (spinner, cycling ghost) renders while a confirmation is pending, on any of the five new surfaces | TD4 D-U/D-X pattern ("never render an animated component while a confirmation is pending", `05-other-agent-tuis.md` A14) | `idle-frames` `live` case, extended |
| 27 | Widths 40 / 80 / 120 and resize mid-card or mid-picker | No static row from a new command/card exceeds `blockWidth(columns)`; a resize mid-picker/mid-card re-measures, never truncates silently | TD4 §11 "block width" gate (`24×20…40×120`); `fitRung` (`src/tui/fit.ts`, TD4 §9.2) | `commands-width.steps` extended to the five new surfaces; `round5.pty.test.ts` (new) |
| 28 | Key leaks (0 key bytes in any output) | No API key, device key, or claim HMAC secret ever appears in a frame, `transcript.log`, or an index line | `test/pty/round3.pty.test.ts:54` `assertNoKeyBytes`, called at `:320,337,348` | extend `assertNoKeyBytes` calls to every new pty scenario (coordination pairing, model-key entry, import credential rows) |
| 29 | `INDEX_KINDS` three-way collision | `session:end`/`relocate`/`handoff` (coordination) + `agent:start`/`agent:end`/`land` (orchestration) + `import` (import) land in **one** PR against the same 8-entry array | `src/session/index.ts:36` (confirmed 8 entries, `readonly string[]`, not a union — §1.6 correction 2) | new: `session/index.test.ts` asserts the merged array's exact membership and that no kind string collides |
| 30 | `registry.ts` six-way contention | `who/inbox/tell/headsup/request/end` (coordination) + widened `pause` args + `context/compact` (context) + `split/agents/agent/land/spawn` (orchestration) + `import/memory` (import) land as one PR at the end of the wave, per TD4 §9.2's own pattern | CD §C "Shared-file requests" table; TD4 §9.2 `registry.ts` row | new: `registry.test.ts` asserts final row count and no duplicate `name`/alias across all six requests |
| 31 | `args.ts` two-way contention | Orchestration's flags/`Command` member + import's flags/`Command += 'import'` land in one PR | CD §C; confirmed today: `Command` union has 13 members, no `'import'` (`src/cli/args.ts:19`) | `args.test.ts` |
| 32 | `config/{defaults,types,validate}.ts` three-way contention | 34 `orchestrate.*` rows + 6 `import.*`/`memory.*` rows + the still-missing `context.compaction` row land together | CD §C; `SettingName` `src/config/types.ts:6` (confirmed present, union not yet grepped exhaustively this pass) | `contract.test.ts`/`defaults.test.ts` per-key coverage |
| 33 | `/end` command vs. the engine method that already exists | The command row must call the **existing** `Engine.end?(opts?: EndOptions)` (`types.ts:1771`), not invent a second mechanism, and must write a `session:end` index line once row 29 lands | §1.6 correction 1 | new: `session.test.ts` `/end` → `Engine.end` call assertion |
| 34 | A device pairs, then is unpaired mid-session on another device | The unpaired device's key still validates locally until `pair --rotate`; TUI must show the exact warning string, never silently continue as if paired | CD A1 pinned string `unpaired mbp — it can no longer steer, stop, resume, end or import your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.` | `mailbox.test.ts` |
| 35 | A forged same-device message (shared-folder tamper) | Never auto-applied; must show the `unverifiedFork` notice/flag path, never an unprompted stop | `claims.ts:235,252` `unverifiedFork`; CD row 25 | `records.test.ts` forged-beat case |

---

## 4. Pinned strings and twins

Following TD4 §3.7's inventory convention: group by producer module, list the ascii/plain/SR twin beside the primary
string, and flag which are **new to round 5** vs. already pinned by TD4/CD.

| Group | Primary string(s) | ascii / plain / SR twin | Status |
|---|---|---|---|
| Coordination `/who` row | `● mbp  main@3f9a2c1  step 7/40 propose  jev+llm  ctx 41%  $0.12/2.00  editing src/loop/engine.ts (+1)  lanes 2 · samples 3  beat 2 s` (CD row 29) | ascii: `*` for `●`; `--plain` renders the same row as one line to `transcript.log`; SR: a sentence form not yet drafted — **gap** | new |
| Coordination status zone | `⇄ 2 live · 1 heads-up · ✉ 1` (CD row 29) | ascii `<>`; SR: "2 sessions live, 1 heads-up, 1 message unread" pattern (not yet drafted) | new |
| Takeover refusal | `taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it` (CD row) | plain identical (no glyph); SR identical | new |
| Fork stop (exit 2) | `error: run <id> is also live on <label> (claim 4 supersedes 3) — stopped to avoid a double writer` (CD row) | plain identical | new |
| Fork notice (unverified) | `run <id> also appears live on mbp (unverified) — [c] continue here  [q] stop` (CD row) | the `[c]/[q]` ladder needs the `fitRung` narrow forms per TD4 §2.6, not yet drafted for this card | new |
| Context meter | `ctx 41% · 6 files · 12 steps`; `/context` header `budget 70k of 128k window (55 %)` (CD row) | ascii: no glyph in either string, already twin-safe; SR: "context 41 percent, 6 files, 12 steps" | new |
| Compaction | `compaction: 41k → 12k chars (code)` (CD row) | ascii `->` for `→` (per `glyphs.ts` convention, TD4 §2.4) | new |
| `/pause` widened | `pausing · step 8 commits first (propose, 41 s, ~40 s p50 left)`; `paused now at step 8 (propose): proposal kept — /resume replays it` (CD row 30) | plain identical | new |
| `/end` | `end this session: [y] at step boundary  [Y] now  [n] stay`; `ended session "<title>" after step 7 — /resume <id> --force reopens` (CD row 31) | ladder needs a narrow `fitRung` form | new |
| Messaging | `[session] mbp: committed 3f9a2c1 on main — engine.ts, store.ts`; `mbp asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore` (CD row 32) | `UiLabel` needs `'[session]'` — **unverified whether it's on `main`**, flagged §6 | new |
| `/peers` (round-4 stub, round-5 wires it) | `peers · <n> here, <m> stale`; empty `no other jevcode is working in this workspace`; `the peer registry is not available in this build` (TD4 §12) | already twin-drafted in TD4 | round-4 owned, round-5 consumes |
| Agents tab rows/cards | 16 row states, 4 cards, full glyph/word/key table (CD A2 item 31/32, "§4.6") — **not transcribed here**; the design doc is the source of truth and none of it has an ascii/SR pass yet | none drafted | new, largest gap |
| `AgentSupervisor` adoption | `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked)` (CD A2 item 34) | no twin drafted | new |
| Import wizard step | full §5.1 3-row block, `WIZARD_IMPORT_*` constants (CD A3) — not transcribed; `Import your memory and workflows?  found claude-code (43 notes), codex (3 servers)` | resize 24×80→12×60→40×120 named as a required case (CD A3), no twin text confirmed | new |
| Import overlay | `Import — 41 to import · 9 to review · 137 skipped · 38 KiB` (CD A3, `summarisePlan`) | not transcribed | new |
| Import apply/undo | `[import] applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB`; `[import] undo imp_… · 41 files restored · 0 modified since` (CD A3) | plain identical (no glyphs) | new |
| Model picker (no design text exists yet) | none pinned — this is the biggest string gap in round 5; `source: 'network'|'cache'|'static'` and `stale: boolean` (`src/models/types.ts:96`) need a rendered form before any string can be pinned | none | **undesigned** |
| Key-never-logged invariant | n/a (a property, not a string) | `assertNoKeyBytes` (`test/pty/round3.pty.test.ts:54`) is the existing enforcement mechanism, extend rather than reinvent | existing tool, new call sites |

---

## 5. Recommended decisions

**D1. Type every round-5 coordination read against `LedgerHandle`, not the base `Ledger` interface.**
Options: (a) type against the 7-member `Ledger` contract and widen later; (b) type against `LedgerHandle` (27
members, `ledger.ts:189`) now, since that is what `openLedger()` actually returns. *Recommendation: (b).* Every
CD-cited call (`status()`, `forkVerdict()`, `setDeviceLabel()`) is a `LedgerHandle` member; typing against the
narrower `Ledger` would force an unsafe cast at every call site for no benefit, and CD's own open question 1 already
flags this as unresolved — round 5 should not wait for the peer's answer to start, because both answers converge on
the same practical type today.

**D2. Land `INDEX_KINDS` and `registry.ts`'s six-way request as the *last* two commits of the wave, gated on every other slot's PR being open (not merged).**
Options: (a) whichever slot finishes first lands its own rows and the rest rebase; (b) hold both files open as
"request" documents (per CD §C) until all six/three contributing slots have posted their exact row text, then one
owner lands one commit each. *Recommendation: (b), matching TD4 §9.2's own precedent exactly* (`registry.ts` landed
once at the end of TD4's wave, not per-slot) — DECISIONS.md's 2026-09-22 entry on harness-owned shared files already
names the cost of two sessions racing one file ("shipped a raw U+2028 … taking ~40 test files down"); a shared array
is the same hazard at smaller scale.

**D3. Build the model/provider picker's first frame against `instantCatalogue()` only; `listModels`/`loadCatalogue` run after `run:ready`, never on the argv path.**
Options: (a) call `loadCatalogueFromEnv` eagerly at startup behind a debounce; (b) paint `instantCatalogue()` synchronously, then replace rows in place as each provider's `listModels` promise settles, exactly mirroring opencode's "epilogue after unmount" and JevCode's own splash-bucket gate. *Recommendation: (b)* — it is the only option compatible with the "zero network before frame 1" rule the brief restates, and the harness already built the fallback chain (`fromCache`→`fromStatic`) specifically so a picker never blocks on it (doc comment, `list.ts:262–264`).

**D4. Do not reopen `Ctrl+L` for the model picker; use `/model` (Codex's name) or `/models` and let the palette's Enter-cycling (TD4 D-X) reach it.**
Options: (a) bind `Ctrl+L`, matching Crush/Pi; (b) rely on the `/` palette only, no dedicated chord. *Recommendation:
(b)* — `05-other-agent-tuis.md:568`'s round-3 rejection of `Ctrl+L` (conflicts with aider/Qwen/Cline's clear-screen
convention) is still the stronger argument now that JevCode *does* have a model switch: a chord collision is worse
than a missing shortcut, and TD4's whole D-X design exists so that every command — including a new `/model` — is one
`/` + Enter-cycle away without a dedicated binding.

**D5. Treat "concurrent git ops" (row 8) as a round-5-owned gap, not a round-4 carryover.**
Options: (a) leave `gitstate.ts`/`patch.ts` as-is and let a `.git/index.lock` collision surface as an unhandled
exception, matching today's behaviour; (b) add an explicit `EAGAIN`/`index.lock` classification, surfaced the same
way `checkpoint/store.ts`'s `classifyDiskError`/`DiskError` (`checkpoint/store.ts:183,103`) already classifies
filesystem faults. *Recommendation: (b)* — the pattern already exists one module over (`DiskCheckpointStore`), the
agent-tree feature makes concurrent git ops from sibling agents routine rather than rare, and a raw git stderr string
reaching a user violates the same "named, recoverable error" bar `checkpointDegradedSentence` (`:142`) already sets.

---

## 6. Open questions

1. **Does `UiLabel` (`src/core/types.ts:1378` per CD's own pointer) already have a `'[session]'` member?** Not
   independently re-verified this pass — CD's messaging row (§4 table, "Messaging") depends on it and neither
   digest confirms the grep. Blocks: the `[session] mbp: committed …` string's label plumbing.
2. **Is `EXCLUSIVE_COMMANDS` a real exported array in `src/tui/commands/*.ts` today?** Not found by name in this
   pass (§1.4); ORCHESTRATION-DESIGN §4.7 assumes it exists for `/land`. If it doesn't exist yet, row 30's six-way
   registry PR needs to add it, which changes the shape of that commit.
3. **Where does a model/provider picker's design text live?** No peer design doc names one (§1.6); is a fourth peer
   design forthcoming, or is this TUI-session-owned from scratch? If TUI-owned, §4's "undesigned" row (model picker
   strings) is the actual round-5 deliverable, not a gap to fill from someone else's spec.
4. **Does round 5 reopen `Ctrl+L`, or is D4's recommendation already the working assumption?** — worth confirming
   before any slot spends time on a binding.
5. **Is the `bench --resume` fallback at `runner.ts:506–509` covered by an existing test, or only by the doc comment
   at `:38`?** Not independently re-run this pass; row 13's test-plan entry assumes a gap that may already be closed.
6. **Does `SettingName`'s union (`src/config/types.ts:6`) need its own three-way-contention test today, or only once
   the 34+6+1 rows actually land?** — `contract.test.ts`'s per-key coverage pattern exists, but nothing currently
   asserts "no two slots claimed the same key name" ahead of the PRs landing; worth adding as a standing lint rather
   than a post-hoc catch.
